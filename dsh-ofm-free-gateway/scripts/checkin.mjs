/**
 * 签到命令行：查看状态 / 立刻签一轮 / 开关自动签到 / 看余额。
 *
 * 这是原插件界面里「每日自动签到」开关 + 「一键领取」按钮 + 渠道卡片状态行的
 * 命令行等价物 —— 目的是让这些功能不再依赖 DSH 插件还能用。
 *
 * 用法：
 *   node scripts/checkin.mjs                     # 看状态（今日结果 + 逐渠道明细 + 余额）
 *   node scripts/checkin.mjs --run               # 立刻签一轮（全部有账号的渠道）
 *   node scripts/checkin.mjs --run --provider trae   # 只签 trae
 *   node scripts/checkin.mjs --enable            # 打开每日自动签到
 *   node scripts/checkin.mjs --disable           # 关闭
 *   node scripts/checkin.mjs --json              # 输出原始 JSON（给脚本用）
 *
 * 选项：
 *   --url <地址>        网关地址，默认 http://127.0.0.1:18900
 *   --data-dir <目录>   数据目录（用来读 settings.json 里的密钥），默认 ~/.ofm-free-gateway
 *   --key <密钥>        直接给密钥（缺省从数据目录读）
 *   --wait <秒>         等待一轮签到跑完的上限，默认 180
 *   --balance           额外查各渠道余额（默认已包含在状态里，失败会跳过）
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const has = name => args.includes(name)
function value(name, fallback) {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] && !args[index + 1].startsWith('--') ? args[index + 1] : fallback
}

const baseURL = value('--url', 'http://127.0.0.1:18900').replace(/\/+$/, '')
const dataDir = path.resolve(value('--data-dir', path.join(os.homedir(), '.ofm-free-gateway')))
const wantJson = has('--json')
const waitSeconds = Number(value('--wait', '180'))
const provider = value('--provider', '')
const doRun = has('--run')
const doEnable = has('--enable')
const doDisable = has('--disable')
const doBalance = has('--balance')

function resolveKey() {
  const explicit = value('--key', '')
  if (explicit !== '') return explicit
  const file = path.join(dataDir, 'settings.json')
  if (fs.existsSync(file)) {
    try {
      const key = JSON.parse(fs.readFileSync(file, 'utf8'))?.forwardKey
      if (typeof key === 'string' && key !== '') return key
    } catch { /* 落到下面的报错 */ }
  }
  console.error(`读不到网关密钥：${file} 不存在或没有 forwardKey。`)
  console.error('请用 --key <密钥> 指定，或 --data-dir 指向正确的数据目录。')
  process.exit(2)
}

const key = resolveKey()

/** 本地日期键，与渠道包的 today() 同口径。 */
function todayKey(date = new Date()) {
  const pad = value => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

async function call(method, payload, httpPath) {
  const url = httpPath === undefined ? `${baseURL}/rpc` : `${baseURL}${httpPath}`
  const body = httpPath === undefined ? JSON.stringify({ method, payload }) : undefined
  let response
  try {
    response = await fetch(url, {
      method: httpPath === undefined ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body,
    })
  } catch (error) {
    console.error(`连不上网关 ${baseURL}：${error.message}`)
    console.error('网关必须先在运行（node server.mjs --port 18900）。')
    process.exit(3)
  }
  if (response.status === 401) {
    console.error('网关拒绝了密钥（401）。确认 --key 与网关 settings.json 里的一致。')
    process.exit(3)
  }
  const text = await response.text()
  let parsed
  try { parsed = JSON.parse(text) } catch { parsed = undefined }
  if (!response.ok) {
    console.error(`网关返回 ${response.status}：${text.slice(0, 400)}`)
    process.exit(3)
  }
  // /rpc 把结果包在 {ok, value} 或 {ok:false, error} 里
  if (parsed !== undefined && typeof parsed === 'object' && 'ok' in parsed) {
    if (parsed.ok === false) {
      console.error(`渠道返回错误：${parsed.error?.code ?? ''} ${parsed.error?.message ?? ''}`)
      process.exit(4)
    }
    return parsed.value
  }
  return parsed
}

async function readStatus() {
  return call(undefined, undefined, '/checkin')
}

/**
 * 逐渠道余额。
 *
 * ⚠️ `usage.badge` **必须带 provider**（空 payload 会被渠道层以 `provider 不能为空`
 * 拒绝），所以这里逐个渠道打 —— 每个都要真打上游，慢，因此只在 `--balance` 时才做。
 */
async function readBalances(providers) {
  const rows = []
  for (const item of providers) {
    try {
      const response = await fetch(`${baseURL}/rpc`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'usage.badge', payload: { provider: item } }),
      })
      if (!response.ok) continue
      const parsed = await response.json()
      if (parsed?.ok === false) continue
      rows.push({ provider: item, value: parsed?.value })
    } catch {
      // 查不到就跳过：很多渠道没有余额接口，不该让状态视图失败
    }
  }
  return rows
}

/** 有账号的渠道列表（从模型目录的 owned_by 推导，不需要额外接口）。 */
async function listProviders() {
  const models = await call(undefined, undefined, '/v1/models')
  const set = new Set((models?.data ?? []).map(row => row.owned_by).filter(Boolean))
  return [...set].sort()
}

function printBalances(rows) {
  console.log('余额：')
  if (rows.length === 0) {
    console.log('  （没有可查的渠道）')
    return
  }
  for (const { provider: name, value } of rows) {
    const accounts = value?.accounts ?? []
    if (accounts.length === 0) {
      console.log(`  ${String(name).padEnd(12)} （未登录）`)
      continue
    }
    for (const account of accounts) {
      const who = account.nickname ?? account.accountId ?? ''
      if (account.error) {
        console.log(`  ${String(name).padEnd(12)} ${who} 查询失败：${account.error}`)
        continue
      }
      const total = account.balance?.total
      const packages = (account.balance?.packages ?? [])
        .map(item => `${item.name} ${item.remaining}/${item.total}${item.unit ? ` ${item.unit}` : ''}`)
        .join('，')
      console.log(`  ${String(name).padEnd(12)} ${who} 共 ${total ?? '?'}${packages ? `（${packages}）` : ''}`)
    }
  }
}

function printStatus(state) {
  const auto = state?.autoCheckin ?? {}
  const scheduler = state?.scheduler ?? null
  console.log(`每日自动签到：${auto.enabled === true ? '已开启' : '已关闭'}`)
  if (auto.lastDate) {
    const time = auto.lastAt ? new Date(auto.lastAt).toLocaleString() : ''
    console.log(`上次完成：${auto.lastDate}${time ? `（${time}）` : ''}`)
  } else {
    console.log('上次完成：从未（本机还没跑过）')
  }
  if (auto.running === true) console.log('当前状态：进行中…')
  if (auto.lastResult) console.log(`结果：${auto.lastResult}`)
  if (Array.isArray(auto.channels) && auto.channels.length > 0) {
    console.log('逐渠道：')
    for (const row of auto.channels) {
      console.log(`  ${String(row.provider).padEnd(12)} ${row.text ?? ''}`)
    }
  }
  if (scheduler) {
    console.log(`调度：每天 ${scheduler.at} 之后检查一次`
      + `${scheduler.lastTriggeredDate ? `；本进程今天已触发（${scheduler.lastTriggeredDate}）` : '；本进程今天还没触发'}`)
  }
}

/** 需要时再查余额（默认不查：每个渠道都要真打上游，慢）。 */
async function balancesIfWanted() {
  if (!doBalance) return undefined
  const providers = provider !== '' ? [provider] : await listProviders()
  return readBalances(providers)
}

async function waitForRun(previousLastAt) {
  const deadline = Date.now() + (Number.isFinite(waitSeconds) && waitSeconds > 0 ? waitSeconds * 1000 : 180000)
  let last
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 3000))
    last = await readStatus()
    const auto = last?.autoCheckin ?? {}
    if (auto.running !== true && auto.lastAt !== undefined && auto.lastAt !== previousLastAt) return last
    if (auto.running !== true && auto.lastDate !== '') {
      // 有些路径（今天已领）不会更新 lastAt，只要不在跑就认为结束
      return last
    }
    process.stdout.write('.')
  }
  console.log('')
  console.log(`等待超过 ${waitSeconds} 秒，仍未见结果；渠道可能在上游卡住。当前状态：`)
  return last ?? await readStatus()
}

// ---------------------------------------------------------------------------
const before = await readStatus()
const previousLastAt = before?.autoCheckin?.lastAt

/** 打印状态，并在需要时（--balance）补上余额段。 */
async function show(state) {
  printStatus(state)
  const balances = await balancesIfWanted()
  if (balances !== undefined) printBalances(balances)
}

if (doEnable || doDisable) {
  const result = await call('usage.autoCheckin', { enabled: doEnable })
  console.log(`每日自动签到已${doEnable ? '开启' : '关闭'}。`)
  if (doEnable) console.log('（打开时会立刻尝试一轮；今天已跑过则内部会拦住）')
  if (!doRun) {
    if (wantJson) console.log(JSON.stringify(result, null, 2))
    else await show({ autoCheckin: result?.autoCheckin, scheduler: before?.scheduler })
    process.exit(0)
  }
}

if (doRun) {
  if (provider !== '') {
    // 单渠道：直接走 credits.claimAll，返回的是该渠道自己的领取结果。
    console.log(`正在签到：${provider} …`)
    const outcome = await call('credits.claimAll', { provider })
    if (wantJson) { console.log(JSON.stringify(outcome, null, 2)); process.exit(0) }
    console.log(`渠道 ${provider} 领取结果：`)
    console.log(JSON.stringify(outcome, null, 2))
    process.exit(0)
  }
  // 整轮：复用渠道包自己的签到执行体（含按渠道分类的结果文字）。
  if (before?.autoCheckin?.lastDate === todayKey()) {
    // 上游每天只能领一次，重复触发只会返回「今天已领」；渠道包内部也会直接拦住。
    console.log('今天已经签过了 —— 多数渠道每天只能领一次，重复调用只会得到「今天已领」。')
    console.log('下面是今天的结果：')
    console.log('')
    await show(before)
    process.exit(0)
  }
  console.log('正在签到：全部有账号的渠道（可能要几十秒）…')
  await call('usage.autoCheckin', { enabled: true })
  const final = await waitForRun(previousLastAt)
  if (wantJson) { console.log(JSON.stringify(final, null, 2)); process.exit(0) }
  console.log('')
  await show(final)
  process.exit(0)
}

if (wantJson) {
  console.log(JSON.stringify(before, null, 2))
  process.exit(0)
}
await show(before)
