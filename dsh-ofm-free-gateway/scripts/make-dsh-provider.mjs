/**
 * 把 ofm-free-gateway 注册成 DSH 的一个 provider（路由），写进 profile 的
 * cordis.patch.yml。
 *
 * ## 为什么用静态 Authorization 头，而不是 apiKeyEnv
 *
 * pi-ai 的 openai-completions 传输层这样取 key（`getClientApiKey`）：
 *
 *     if (apiKey) return apiKey
 *     if (hasHeader(headers, 'authorization')) return 'unused'   // ← 我们走这条
 *     throw new Error(`No API key for provider: ${provider}`)
 *
 * 也就是说，路由配置里带了 `headers.Authorization` 时，pi-ai **根本不需要**
 * apiKey。于是不必把网关密钥写进 DSH 凭据库、不必设环境变量、不必在设置界面
 * 里填表 —— 网关只监听回环地址，密钥就放在这个本地配置里。
 *
 * ## 写入方式
 *
 * 在 `- id: llm-pi-ai` 条目的 `config.providers:` 下插入一段带标记注释的映射，
 * 重复运行只替换标记之间的内容（幂等），不会动你原有的 provider。
 *
 * 用法：
 *   node scripts/make-dsh-provider.mjs --key <网关密钥>          # 写「当前可路由」的模型
 *   node scripts/make-dsh-provider.mjs --key <密钥> --limit 8    # 只要前 8 个
 *   node scripts/make-dsh-provider.mjs --key <密钥> --only buddy/deepseek-v4-flash,trae/...
 *   node scripts/make-dsh-provider.mjs --channels buddy,trae     # 只要这些渠道
 *   node scripts/make-dsh-provider.mjs --key <密钥> --all        # 全量目录
 *   node scripts/make-dsh-provider.mjs --remove                  # 撤销本脚本写入的段
 *   node scripts/make-dsh-provider.mjs --key <密钥> --dry-run    # 只看不写
 *
 * 提示：生成的段是普通 YAML，你也可以写进去之后手工增删条目；下次再跑本脚本会
 * 覆盖这一段（所以要么手改要么用参数，别指望两者同时保留）。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const BEGIN = '      # >>> ofm-free-gateway（本段由 scripts/make-dsh-provider.mjs 生成，勿手改）>>>'
const END = '      # <<< ofm-free-gateway <<<'
const ROUTE = 'ofmfree'

const args = process.argv.slice(2)
const has = name => args.includes(name)
function value(name, fallback) {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] !== undefined && !args[index + 1].startsWith('--') ? args[index + 1] : fallback
}

const dryRun = has('--dry-run')
const includeAll = has('--all')
const verify = !has('--no-verify')
const removeOriginal = has('--remove-original')
const baseURL = value('--url', 'http://127.0.0.1:18900/v1').replace(/\/+$/, '')
const gatewayKey = value('--key', '')
const channelFilter = value('--channels', '') === ''
  ? undefined
  : new Set(value('--channels', '').split(',').map(item => item.trim()).filter(Boolean))

const dshHome = path.resolve(value('--dsh-home', process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh')))
const profileDir = path.resolve(value('--profile-dir', process.env.DSH_PROFILE_DIR?.trim() || path.join(dshHome, 'profiles', 'desktop')))
const patchFile = path.resolve(value('--patch', path.join(profileDir, 'cordis.patch.yml')))

const log = (...parts) => console.log(...parts)

/** 标记之间的整段（含标记与尾随换行）。 */
function markerPattern() {
  const escapedBegin = BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const escapedEnd = END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`${escapedBegin}[\\s\\S]*?${escapedEnd}\\n?`, 'm')
}

// ---------------------------------------------------------------------------
// --remove：把本脚本写入的段整段撤掉（不需要网关在运行、不需要 --key）
// ---------------------------------------------------------------------------
// 只想用网关做签到/接口、不想让这些模型出现在 DSH 模型选择器里时就用这个。
if (has('--remove')) {
  if (!fs.existsSync(patchFile)) {
    log(`找不到 ${patchFile}`)
    process.exit(1)
  }
  const original = fs.readFileSync(patchFile, 'utf8')
  const pattern = markerPattern()
  if (!pattern.test(original)) {
    log(`${patchFile} 里没有本脚本写入的段（providers.${ROUTE}），无需移除。`)
    process.exit(0)
  }
  const next = original.replace(pattern, '')
  if (dryRun) {
    log(`（--dry-run）将从 ${patchFile} 移除 providers.${ROUTE} 段（${original.length - next.length} 字节）`)
    process.exit(0)
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  fs.copyFileSync(patchFile, `${patchFile}.bak-${stamp}`)
  fs.writeFileSync(patchFile, next)
  log(`已移除 providers.${ROUTE} 段（备份：${path.basename(patchFile)}.bak-${stamp}）`)
  log('你原有的其它 provider 未改动。重启 DSH 后模型选择器里就不再出现这些模型。')
  log(`网关本身不受影响：签到用 node scripts/checkin.mjs，接口仍在 ${baseURL}。`)
  process.exit(0)
}

if (gatewayKey === '') {
  log('缺少网关密钥。用法示例：')
  log('  node scripts/make-dsh-provider.mjs --key <你在网关启动时看到的 API Key>')
  process.exit(2)
}

// ---------------------------------------------------------------------------
// 取模型列表
// ---------------------------------------------------------------------------
async function fetchModels() {
  const url = `${baseURL}/models`
  let response
  try {
    response = await fetch(url, { headers: { Authorization: `Bearer ${gatewayKey}` } })
  } catch (error) {
    throw new Error(`连不上网关 ${url}（先启动 server.mjs）：${error.message}`)
  }
  if (response.status === 401) throw new Error(`网关拒绝了密钥（401）。确认 --key 与启动网关时一致。`)
  if (!response.ok) throw new Error(`网关返回 ${response.status}：${await response.text().catch(() => '')}`)
  const body = await response.json()
  const rows = Array.isArray(body?.data) ? body.data : []
  if (rows.length === 0) throw new Error('网关没有返回任何模型。若渠道都没登录，先登录至少一个渠道。')
  return rows
}

const rows = await fetchModels()
const routable = rows.filter(row => row['x-provider-ready'] === true)
const onlyList = value('--only', '') === ''
  ? undefined
  : new Set(value('--only', '').split(',').map(item => item.trim()).filter(Boolean))
const limitRaw = value('--limit', '')
const limit = limitRaw === '' ? undefined : Number(limitRaw)
if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
  log(`--limit 需要正整数，收到：${limitRaw}`)
  process.exit(2)
}
let selected = (includeAll ? rows : routable).filter(row => {
  if (channelFilter !== undefined && !channelFilter.has(row.owned_by ?? row.id.split('/')[0])) return false
  if (onlyList !== undefined && !onlyList.has(row.id)) return false
  return true
})
if (limit !== undefined) selected = selected.slice(0, limit)
if (onlyList !== undefined) {
  const found = new Set(selected.map(row => row.id))
  const missing = [...onlyList].filter(id => !found.has(id))
  if (missing.length > 0) log(`⚠️  --only 里有 ${missing.length} 个 id 不在当前候选集里（可能未登录/不可路由，或拼错）：${missing.join(', ')}`)
}

log(`网关：${baseURL}`)
log(`模型：目录 ${rows.length} 个，其中当前可路由 ${routable.length} 个`)
if (channelFilter !== undefined) log(`渠道筛选：${[...channelFilter].join(', ')}`)
log(`本次写入：${selected.length} 个模型`
  + `（${includeAll ? '--all 全量目录' : '仅可路由'}`
  + `${limit !== undefined ? `，--limit ${limit}` : ''}`
  + `${onlyList !== undefined ? '，--only 指定列表' : ''}）`)

if (selected.length === 0) {
  log('')
  log('没有任何模型可写。可能原因：网关的模型目录还没刷新完，或渠道都没登录。')
  log(`先自己看一眼：curl -H "Authorization: Bearer <key>" ${baseURL}/models`)
  process.exit(1)
}
if (routable.length === 0 && includeAll) {
  log('⚠️  可路由集合为空（渠道目录可能没刷新好）。当前用 --all 写全量目录，')
  log('    这些模型可能都还不可用 —— 建议等渠道登录并刷新后重跑本脚本。')
}

const byChannel = {}
for (const row of selected) {
  const channel = row.owned_by ?? row.id.split('/')[0]
  byChannel[channel] = (byChannel[channel] ?? 0) + 1
}
log(`渠道分布：${Object.entries(byChannel).sort().map(([c, n]) => `${c}=${n}`).join(' ')}`)

// ---------------------------------------------------------------------------
// 生成 YAML 段
// ---------------------------------------------------------------------------
/** YAML 单引号标量：内部单引号翻倍。 */
const yamlString = text => `'${String(text).replace(/'/g, "''")}'`

const lines = [
  BEGIN,
  `      ${ROUTE}:`,
  `        displayName: ${yamlString('OFM 免费渠道网关')}`,
  `        api: openai-completions`,
  `        baseURL: ${yamlString(baseURL)}`,
  '        # 静态鉴权头：pi-ai 见 Authorization 头即用 "unused" 占位，故无需 apiKeyEnv。',
  '        headers:',
  `          Authorization: ${yamlString(`Bearer ${gatewayKey}`)}`,
  '        # 目录未描述容量时的回退值（网关的模型不带这两项）。',
  '        defaultContextWindow: 262144',
  '        defaultMaxTokens: 32768',
  '        models:',
]
const seen = new Set()
for (const row of selected) {
  const id = String(row.id)
  if (seen.has(id)) continue  // 目录与权威行合并后理论上不会重复，仍防一手
  seen.add(id)
  const raw = String(row.name ?? id)
  // 渠道目录的展示名带额度倍率（如 "GLM-5.2 · x0.79"）。选择器里是噪声，去掉。
  const label = raw.replace(/\s*·\s*x[\d.]+\s*$/u, '').trim() || id
  const channel = row.owned_by ?? id.split('/')[0]
  lines.push(`          - id: ${yamlString(id)}`)
  lines.push(`            name: ${yamlString(`${label} · ${channel}`)}`)
}
lines.push(END)
const block = `${lines.join('\n')}\n`

// ---------------------------------------------------------------------------
// 合并进 cordis.patch.yml
// ---------------------------------------------------------------------------
function mergeIntoPatch(text) {
  if (markerPattern().test(text)) {
    return { text: text.replace(markerPattern(), block), mode: '替换已有段' }
  }
  // 找到 llm-pi-ai 条目下的 providers: 行，把我们的映射插在它后面。
  const anchor = /^(- id: llm-pi-ai[ \t]*\r?\n(?:.*\r?\n)*?    providers:[ \t]*\r?\n)/m
  const match = anchor.exec(text)
  if (match === null) {
    throw new Error(`在 ${patchFile} 里找不到 "- id: llm-pi-ai" 条目下的 "    providers:" 行。\n`
      + '请确认该文件里已经有 llm-pi-ai 的 providers 配置（DSH 的模型设置里加过任意 provider 即可）。')
  }
  const insertAt = match.index + match[1].length
  return { text: `${text.slice(0, insertAt)}${block}${text.slice(insertAt)}`, mode: '新增段' }
}

if (!fs.existsSync(patchFile)) {
  log(`找不到 ${patchFile}`)
  process.exit(1)
}
const original = fs.readFileSync(patchFile, 'utf8')
const { text: next, mode } = mergeIntoPatch(original)

log('')
log(`目标：${patchFile}`)
log(`操作：${mode}，${selected.length} 个模型`)

if (dryRun) {
  log('（--dry-run：只打印，不写文件）')
  log('')
  log(block)
} else if (next === original) {
  // 插件会在每次模型启停后自动重跑本脚本；内容没变时再写一遍只会在 profile
  // 目录里堆一堆一模一样的 .bak-* 备份。跳过写入，结果完全一样。
  log('内容无变化，跳过写入（不产生备份）')
} else {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  fs.copyFileSync(patchFile, `${patchFile}.bak-${stamp}`)
  fs.writeFileSync(patchFile, next)
  log(`已写入（备份：${path.basename(patchFile)}.bak-${stamp}）`)
}

// ---------------------------------------------------------------------------
// 停用原插件（可选）
// ---------------------------------------------------------------------------
const profilePackage = path.join(profileDir, 'package.json')
if (removeOriginal) {
  log('')
  if (!fs.existsSync(profilePackage)) {
    log(`找不到 ${profilePackage}，跳过停用原插件。`)
  } else {
    const pkg = JSON.parse(fs.readFileSync(profilePackage, 'utf8'))
    const bundles = pkg?.dsh?.profile?.bundles
    if (!Array.isArray(bundles)) {
      log(`${profilePackage} 里没有 dsh.profile.bundles，跳过停用原插件。`)
    } else if (!bundles.includes('dsh-our-free-model')) {
      log('原插件 dsh-our-free-model 已不在 bundles 里，无需改动。')
    } else {
      pkg.dsh.profile.bundles = bundles.filter(name => name !== 'dsh-our-free-model')
      if (!dryRun) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        fs.copyFileSync(profilePackage, `${profilePackage}.bak-${stamp}`)
        fs.writeFileSync(profilePackage, `${JSON.stringify(pkg, null, 2)}\n`)
        log(`已从 bundles 移除 dsh-our-free-model（备份：package.json.bak-${stamp}）`)
      } else {
        log('（--dry-run）将从 dsh.profile.bundles 移除 dsh-our-free-model')
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 自检：确认写进去的内容真的是合法 YAML 且结构符合预期
// ---------------------------------------------------------------------------
if (verify && !dryRun) {
  const finalText = fs.readFileSync(patchFile, 'utf8')
  let yaml
  try {
    // 用 profile 自己的 package.json 做解析基准，这样 node_modules 里的 js-yaml
    // 能被正常解析（直接拼 index.js 路径会因包的入口字段不同而失败）。
    const { createRequire } = await import('node:module')
    yaml = createRequire(path.join(profileDir, 'package.json'))('js-yaml')
  } catch { /* 没有 js-yaml 就跳过自检 */ }
  if (yaml === undefined) {
    log('')
    log('（未找到 js-yaml，跳过 YAML 自检）')
  } else {
    try {
      const parsed = yaml.load(finalText)
      const entry = Array.isArray(parsed) ? parsed.find(item => item?.id === 'llm-pi-ai') : undefined
      const route = entry?.config?.providers?.[ROUTE]
      if (route === undefined) throw new Error(`解析成功但找不到 providers.${ROUTE}`)
      const count = Array.isArray(route.models) ? route.models.length : 0
      const auth = route.headers?.Authorization ?? ''
      if (count !== selected.length) throw new Error(`模型数不符：写入 ${selected.length}，解析出 ${count}`)
      if (!auth.startsWith('Bearer ')) throw new Error('headers.Authorization 不是 Bearer 形式')
      log('')
      log(`YAML 自检通过：providers.${ROUTE} 有 ${count} 个模型，baseURL=${route.baseURL}，鉴权头已就位`)
    } catch (error) {
      log('')
      log(`⚠️  YAML 自检失败：${error.message}`)
      log('   已写入的文件可能格式有误，可用同目录的 .bak-* 备份回滚。')
      process.exit(1)
    }
  }
}

log('')
log('下一步：让 DSH 重新加载 profile（重启 DSH，或在插件管理里重载宿主）。')
log(`重载后模型选择器里会出现 ${selected.length} 个模型（路由名 ${ROUTE}）。`)
