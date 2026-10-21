/**
 * 从 DSH 的 dsh-our-free-model 插件数据迁移 13 渠道凭证到 ofm-free-gateway。
 *
 * 迁移两样东西：
 *   C:\Users\<你>\.dsh\.credentials.yaml  →  <dataDir>/channel-credentials.json
 *       只搬 <PROVIDER>_ACCOUNT_* / <PROVIDER>_ANON* 这类渠道凭证，不碰 API key。
 *   C:\Users\<你>\.dsh\channel-pack\state.json  →  <dataDir>/channel-pack/state.json
 *       账号池（哪个账号属于哪个渠道、启用状态）。
 *
 * 幂等：重复运行以源侧为准覆盖；已有文件会先备份成 .bak-<时间戳>。
 *
 * 用法：
 *   node scripts/migrate-from-dsh.mjs [--dsh-home C:\Users\<你>\.dsh] [--data-dir <目录>] [--dry-run]
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
function flag(name, fallback) {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}
const dryRun = args.includes('--dry-run')
const dshHome = path.resolve(flag('--dsh-home', path.join(os.homedir(), '.dsh')))
const dataDir = path.resolve(flag('--data-dir', path.join(os.homedir(), '.ofm-free-gateway')))

const CHANNEL_PROVIDERS = [
  'CODEARTS', 'BUDDY', 'WORKBUDDY', 'LOBSTERAI', 'QODER', 'QODERCN',
  'TRAE', 'CLINE', 'LOOMY', 'RACCOON', 'MINIMAX', 'ZCODE', 'GEMINI',
]

const log = (...parts) => console.log(...parts)

// ---------------------------------------------------------------------------
// 极简 YAML：只支持 .credentials.yaml 实际用到的结构
//   refs:\n  KEY: <标量>          （标量可能折行，见下）
//   records: ...                （我们不读 records）
//
// ⚠️ 长凭据在文件里是**折行的多行标量**：键行缩进 2，续行缩进 4。
// 曾经只取键行那一行，结果把 2688 字节的凭据截成半截 JSON —— 那种坏值
// 会让渠道「看起来已登录（account.list 有 source: local）但目录为空」，
// 因为门控 hasLoggedInAccount() 要求凭据能被**解析**。必须先累积续行。
//
// YAML 折叠规则：行尾换行折叠成**一个空格**，续行首尾空白剥掉。js-yaml 只在
// 空格处断行，因此「用空格把续行拼回去」是无损的。下面用 JSON.parse 自检兜底。
// ---------------------------------------------------------------------------
/** 去掉标量外层引号并处理转义。单引号只有 '' → '；双引号才有反斜杠转义。 */
function unquoteScalar(raw) {
  const value = raw.trim()
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'")
  }
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\(["\\/bfnrt]|u[0-9a-fA-F]{4})/g, (match, esc) => {
      switch (esc[0]) {
        case 'n': return '\n'
        case 't': return '\t'
        case 'r': return '\r'
        case 'b': return '\b'
        case 'f': return '\f'
        case '"': return '"'
        case '\\': return '\\'
        case '/': return '/'
        default: return String.fromCharCode(Number.parseInt(esc.slice(1), 16))
      }
    })
  }
  return value
}

function parseRefs(yamlText) {
  const lines = yamlText.split(/\r?\n/)
  const refs = {}
  let index = 0
  while (index < lines.length && !/^refs:\s*$/.test(lines[index])) index++
  if (index === lines.length) return refs
  for (index += 1; index < lines.length; index++) {
    const line = lines[index]
    if (line.trim() === '') continue
    if (!/^\s/.test(line)) break  // 回到顶格 → refs 段结束
    const match = /^ {2}([A-Za-z0-9_.\-]+):[ ]?(.*)$/.exec(line)
    if (match === null) continue
    const [, key, head] = match
    // 累积折行续行：缩进 >= 4 的非空行
    let raw = head
    let cursor = index + 1
    while (cursor < lines.length) {
      const next = lines[cursor]
      if (next.trim() === '') { cursor += 1; continue }
      if (!/^ {4,}/.test(next)) break
      raw += ` ${next.trim()}`
      cursor += 1
    }
    index = cursor - 1
    refs[key] = unquoteScalar(raw)
  }
  return refs
}

/**
 * 从渠道凭据 JSON 里取「过期时刻」（毫秒）；取不到返回 undefined。
 *
 * 各渠道字段名不统一（trae 用 expires_at、qodercn 用 expire_time、zcode 没有），
 * 秒/毫秒也混用，所以逐个字段试 + 按量级猜单位。
 */
function expiryOf(value) {
  let parsed
  try { parsed = JSON.parse(value) } catch { return undefined }
  if (parsed === null || typeof parsed !== 'object') return undefined
  const fields = ['expires_at', 'expiresAt', 'expire_time', 'expireTime', 'expiry', 'expires', 'exp']
  for (const field of fields) {
    const raw = parsed[field]
    if (raw === undefined || raw === null || raw === '') continue
    // ISO 字符串（codearts / gemini 用这种）：2026-10-17T03:48:31.06Z
    if (typeof raw === 'string' && /\d{4}-\d{2}-\d{2}T/.test(raw)) {
      const parsedDate = Date.parse(raw)
      if (Number.isFinite(parsedDate)) return parsedDate
      continue
    }
    const num = typeof raw === 'number'
      ? raw
      : (typeof raw === 'string' ? Number(raw) : Number.NaN)
    if (!Number.isFinite(num) || num <= 0) continue
    return num > 1e12 ? num : num * 1000  // > 1e12 视为毫秒，否则视为秒
  }
  return undefined
}

function backupThenWrite(file, content) {
  if (dryRun) { log(`  [dry-run] 将写入 ${file}（${content.length} 字节）`); return }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  if (fs.existsSync(file)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backup = `${file}.bak-${stamp}`
    fs.copyFileSync(file, backup)
    log(`  已备份原文件 → ${backup}`)
  }
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, content, { mode: 0o600 })
  fs.renameSync(temp, file)
}

// ---------------------------------------------------------------------------
log(`源 DSH_HOME ：${dshHome}`)
log(`目标 dataDir：${dataDir}`)
if (dryRun) log('（dry-run 模式，不写任何文件）')
log('')

// 1) 凭证 -------------------------------------------------------------------
const credFile = path.join(dshHome, '.credentials.yaml')
if (!fs.existsSync(credFile)) {
  log(`找不到 ${credFile}`)
  log('如果你没在原插件里登录过任何渠道，可以跳过迁移，直接启动网关后重新登录。')
  process.exit(1)
}
const refs = parseRefs(fs.readFileSync(credFile, 'utf8'))
const migrated = {}
for (const [key, value] of Object.entries(refs)) {
  const provider = CHANNEL_PROVIDERS.find(name => key.startsWith(`${name}_`))
  if (provider === undefined) continue
  migrated[key] = value
}
const migratedProviders = [...new Set(Object.keys(migrated).map(key => key.split('_')[0]))].sort()

// 迁移自检：渠道凭据必须是可解析的 JSON。
// 门控 hasLoggedInAccount() 要求凭据能被解析；写坏值不会报错，只会让
// 「已登录」的渠道目录变空、推理返回 404「模型不存在或已停用」，极难排查。
const broken = []
for (const [key, value] of Object.entries(migrated)) {
  try { JSON.parse(value) } catch (error) { broken.push(`${key}：${error.message}`) }
}
if (broken.length > 0) {
  log('迁移自检失败——以下凭据不是合法 JSON，已中止，不会写入坏数据：')
  for (const item of broken) log(`  ${item}`)
  process.exit(1)
}
log(`迁移自检：${Object.keys(migrated).length} 条渠道凭据均为合法 JSON`)

log(`凭证：发现 ${Object.keys(migrated).length} 条，覆盖 ${migratedProviders.length} 个渠道`)
if (migratedProviders.length > 0) log(`  ${migratedProviders.join(', ')}`)
const skipped = Object.keys(refs).filter(key => !(key in migrated))
if (skipped.length > 0) log(`  跳过非渠道凭证 ${skipped.length} 条（API key 等）：${skipped.join(', ')}`)

if (Object.keys(migrated).length > 0) {
  const target = path.join(dataDir, 'channel-credentials.json')
  let existing = {}
  if (fs.existsSync(target)) {
    try { existing = JSON.parse(fs.readFileSync(target, 'utf8')) } catch { existing = {} }
  }

  // ---- 谁新用谁 ------------------------------------------------------------
  // DSH 与原插件在运行时会自行刷新令牌，两边因此会漂移；直接「源覆盖目标」会把
  // 本网关刚刷新出来的新令牌换成旧的。反过来又会丢掉 DSH 侧的新令牌。
  // 所以按凭据里的过期时刻取新的那一份（缺失/无法解析时才退回源侧）。
  const merged = { ...existing }
  const taken = { source: [], local: [], unknown: [] }
  for (const [key, value] of Object.entries(migrated)) {
    const local = existing[key]
    if (typeof local !== 'string') { merged[key] = value; taken.source.push(key); continue }
    const a = expiryOf(local)
    const b = expiryOf(value)
    if (a === undefined && b === undefined) { merged[key] = value; taken.unknown.push(key); continue }
    if ((b ?? 0) >= (a ?? 0)) { merged[key] = value; taken.source.push(key) } else { taken.local.push(key) }
  }
  const added = Object.keys(merged).length - Object.keys(existing).length
  log(`  合并后共 ${Object.keys(merged).length} 条（新增 ${added} 条）`)
  log(`  取新：DSH 侧 ${taken.source.length} 条`
    + `${taken.local.length > 0 ? `，保留本网关 ${taken.local.length} 条（${taken.local.map(k => k.split('_')[0]).join(', ')}）` : ''}`
    + `${taken.unknown.length > 0 ? `，${taken.unknown.length} 条无过期字段按源侧处理` : ''}`)
  backupThenWrite(target, `${JSON.stringify(merged, null, 2)}\n`)
} else {
  log('  没有可迁移的渠道凭证。')
}

// 2) 账号池 -----------------------------------------------------------------
log('')
const stateFile = path.join(dshHome, 'channel-pack', 'state.json')
if (!fs.existsSync(stateFile)) {
  log(`找不到 ${stateFile}，跳过账号池迁移。`)
  log('（账号池记录渠道登录态；缺失时网关会把已登录渠道视为未登录。）')
} else {
  let state
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')) } catch (error) {
    log(`账号池解析失败：${error.message}`)
    process.exit(1)
  }
  const accounts = Array.isArray(state.accounts) ? state.accounts : []
  const byProvider = {}
  for (const account of accounts) {
    byProvider[account.provider] = (byProvider[account.provider] ?? 0) + 1
  }
  log(`账号池：${accounts.length} 个账号，覆盖 ${Object.keys(byProvider).length} 个渠道`)
  for (const [provider, count] of Object.entries(byProvider).sort()) log(`  ${provider}: ${count}`)

  // 只搬账号池；其余字段（偏好设置等）保留本网关自己的
  const target = path.join(dataDir, 'channel-pack', 'state.json')
  let existing = {}
  if (fs.existsSync(target)) {
    try { existing = JSON.parse(fs.readFileSync(target, 'utf8')) } catch { existing = {} }
  }
  const next = { ...existing, accounts }
  backupThenWrite(target, `${JSON.stringify(next, null, 2)}\n`)
}

log('')
log(dryRun ? 'dry-run 结束，未写入。' : '迁移完成。')
if (!dryRun) {
  log('')
  log('下一步：')
  log(`  cd <ofm-free-gateway 目录>`)
  log(`  node server.mjs --port 18900 --data-dir "${dataDir}"`)
  log('  然后用 /v1/models 确认已登录渠道的模型带 "x-provider-ready": true')
}
