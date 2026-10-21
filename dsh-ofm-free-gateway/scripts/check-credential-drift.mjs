/**
 * 检查「DSH 原插件的凭证」与「本网关的凭证」是否漂移。
 *
 * ## 为什么需要这个
 *
 * 两个进程各自持有同一批渠道账号的副本，各自都会刷新令牌。OAuth 刷新令牌可能
 * 轮换（rotate）：一方刷新后，另一方的旧刷新令牌就可能失效。于是会出现
 * 「在 DSH 里能用，在网关里 404」或反过来的现象 —— 现场很难判断到底是谁旧了。
 *
 * 本脚本只做只读对比，不改任何文件：
 *   - 逐条比较两边的值是否完全一致；
 *   - 打印各自的 expires_at / expire_time（如果凭据里有）；
 *   - 顺带对比账号池（state.json）里的账号集合。
 *
 * 用法：
 *   node scripts/check-credential-drift.mjs
 *   node scripts/check-credential-drift.mjs --dsh-home C:\Users\me\.dsh --data-dir D:\ofm-data
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'

const args = process.argv.slice(2)
function value(name, fallback) {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}

const dshHome = path.resolve(value('--dsh-home', process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh')))
const profileDir = path.resolve(value('--profile-dir', process.env.DSH_PROFILE_DIR?.trim() || path.join(dshHome, 'profiles', 'desktop')))
const dataDir = path.resolve(value('--data-dir', path.join(os.homedir(), '.ofm-free-gateway')))

const log = (...parts) => console.log(...parts)
const shortHash = text => crypto.createHash('sha256').update(text).digest('hex').slice(0, 12)

/** 取凭据里的过期/签发时刻，原样展示（不同渠道字段名与单位都不一样）。 */
function stampOf(text) {
  let parsed
  try { parsed = JSON.parse(text) } catch { return '-' }
  for (const field of ['expires_at', 'expiresAt', 'expire_time', 'expireTime', 'expiry', 'expires']) {
    if (parsed?.[field] !== undefined) return `${field}=${parsed[field]}`
  }
  return '-'
}

// --------------------------------------------------------------------------
// 读 DSH 侧凭证：必须用真正的 YAML 解析器。
// 长凭据在文件里是折行的多行标量，手写解析器一旦只读第一行就会把 JSON 截断，
// 那正是「渠道看起来已登录、模型却全 404」的成因（见 migrate-from-dsh.mjs）。
// --------------------------------------------------------------------------
const dshCredentials = path.join(dshHome, '.credentials.yaml')
let dshRefs = {}
if (!fs.existsSync(dshCredentials)) {
  log(`找不到 ${dshCredentials}`)
} else {
  try {
    const yaml = createRequire(path.join(profileDir, 'package.json'))('js-yaml')
    const parsed = yaml.load(fs.readFileSync(dshCredentials, 'utf8'))
    dshRefs = parsed?.refs ?? {}
  } catch (error) {
    log(`解析 ${dshCredentials} 失败：${error.message}`)
    log('（该文件需要 js-yaml；它随 DSH profile 一起安装，请确认 --profile-dir 指向正确）')
    process.exit(1)
  }
}

const localFile = path.join(dataDir, 'channel-credentials.json')
if (!fs.existsSync(localFile)) {
  log(`找不到 ${localFile}（本网关还没迁移过凭证？先跑 migrate-from-dsh.mjs）`)
  process.exit(1)
}
const local = JSON.parse(fs.readFileSync(localFile, 'utf8'))

const keys = [...new Set([...Object.keys(dshRefs), ...Object.keys(local)])]
  .filter(key => /_ACCOUNT_|_ANON/i.test(key))
  .sort()

log(`DSH 侧：${dshCredentials}`)
log(`网关侧：${localFile}`)
log('')
log(`${'凭证引用'.padEnd(30)} ${'DSH 侧'.padEnd(34)} ${'网关侧'.padEnd(34)} 一致`)

let same = 0
const onlyDsh = []
const onlyLocal = []
const differ = []
for (const key of keys) {
  const a = dshRefs[key]
  const b = local[key]
  if (a === undefined) { onlyLocal.push(key); continue }
  if (b === undefined) { onlyDsh.push(key); continue }
  const equal = a === b
  if (equal) same++
  else differ.push(key)
  const left = `${shortHash(a)} ${stampOf(a)}`
  const right = `${shortHash(b)} ${stampOf(b)}`
  log(`${key.padEnd(30)} ${left.padEnd(34)} ${right.padEnd(34)} ${equal ? '是' : '否'}`)
}

log('')
log(`一致 ${same} 条`)
if (onlyDsh.length > 0) log(`只在 DSH 侧有 ${onlyDsh.length} 条（网关还没迁移）：${onlyDsh.join(', ')}`)
if (onlyLocal.length > 0) log(`只在网关侧有 ${onlyLocal.length} 条（在网关里登录的）：${onlyLocal.join(', ')}`)
if (differ.length > 0) {
  log(`两边不一致 ${differ.length} 条：${differ.join(', ')}`)
  log('')
  log('建议：跑 node scripts/migrate-from-dsh.mjs 做一次「谁新用谁」同步，然后重启网关')
  log('（网关在启动时把凭据读进内存，同步后必须重启才会生效）。')
} else {
  log('两边完全一致，无需同步。')
}

// --------------------------------------------------------------------------
// 账号池对比
// --------------------------------------------------------------------------
const dshState = path.join(dshHome, 'channel-pack', 'state.json')
const localState = path.join(dataDir, 'channel-pack', 'state.json')
function accountsOf(file) {
  if (!fs.existsSync(file)) return undefined
  try { return JSON.parse(fs.readFileSync(file, 'utf8'))?.accounts ?? [] } catch { return undefined }
}
const a = accountsOf(dshState)
const b = accountsOf(localState)
log('')
if (a === undefined || b === undefined) {
  log('账号池：有一侧读不到，跳过对比。')
} else {
  const idsA = new Set(a.map(item => item.id))
  const idsB = new Set(b.map(item => item.id))
  const missing = [...idsA].filter(id => !idsB.has(id))
  const extra = [...idsB].filter(id => !idsA.has(id))
  log(`账号池：DSH ${a.length} 个、网关 ${b.length} 个`)
  if (missing.length === 0 && extra.length === 0) log('  账号集合一致。')
  if (missing.length > 0) log(`  网关缺少 ${missing.length} 个：${missing.join(', ')}`)
  if (extra.length > 0) log(`  网关多出 ${extra.length} 个：${extra.join(', ')}`)
}
