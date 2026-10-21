/**
 * 一次性签到：跑完打印结果就退出。
 *
 * 给「任务计划程序」每天跑一次用 —— **不需要常驻网关，也不需要 DSH 插件**。
 * 这是「移除原插件后签到不能丢」的最省事形态：不占端口、常驻进程崩溃也不影响。
 *
 * 用法：
 *   node scripts/checkin-once.mjs                 # 签一次
 *   node scripts/checkin-once.mjs --json          # 输出 JSON（给脚本/日志用）
 *   node scripts/checkin-once.mjs --force         # 即使常驻网关在跑也照签
 *   node scripts/checkin-once.mjs --data-dir D:\ofm-data
 *
 * ⚠️ 默认会先看常驻网关是否在跑（数据目录里的 gw.pid）。在跑就跳过：两边各起一个
 * 渠道 Worker 会同时写同一份 `channel-pack/*.json`，互相踩。真要让两边并跑用 --force。
 *
 * 注册每天 09:05 的任务（管理员不必需，当前用户即可）：
 *   schtasks /Create /TN "ofm-checkin" /SC DAILY /ST 09:05 /F ^
 *     /TR "\"<node.exe 全路径>\" \"<本文件全路径>\""
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createChannelRuntime } from '../channels/runtime.mjs'
import { gatewayPidAlive, runCheckinOnce } from '../server.mjs'

const args = process.argv.slice(2)
function value(name, fallback) {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] && !args[index + 1].startsWith('--') ? args[index + 1] : fallback
}

const dataDir = path.resolve(value('--data-dir', process.env.OFM_HOME?.trim() || path.join(os.homedir(), '.ofm-free-gateway')))
const wantJson = args.includes('--json')
const force = args.includes('--force')
const quiet = args.includes('--quiet')
const waitMs = Number(value('--wait', '240')) * 1000

const log = (...parts) => { if (!quiet) console.log(...parts) }

if (!fs.existsSync(path.join(dataDir, 'channel-credentials.json'))) {
  console.error(`数据目录里没有渠道凭证：${dataDir}`)
  console.error('先跑 node scripts/migrate-from-dsh.mjs 迁移，或在网关里登录至少一个渠道。')
  process.exit(2)
}

if (!force && gatewayPidAlive(dataDir)) {
  log('常驻网关正在运行 —— 它内部已经有每日签到，这次跳过（避免两个进程写同一份渠道状态）。')
  log('确实要并跑请加 --force。')
  process.exit(0)
}

const logger = {
  info: message => log(`[渠道] ${message}`),
  warn: message => console.error(`[渠道] ${message}`),
  error: message => console.error(`[渠道] ${message}`),
}

const runtime = await createChannelRuntime({ dataDir, logger })
let exitCode = 0
try {
  const result = await runCheckinOnce({ runtime, logger, waitMs })

  if (wantJson) {
    console.log(JSON.stringify(result, null, 2))
  } else if (result.outcome === 'disabled') {
    log('每日自动签到是关闭状态，本次没有动作。要打开：node scripts/checkin.mjs --enable')
  } else if (result.outcome === 'already-done') {
    log(`今天已经签过了（${result.state?.lastDate}）。`)
    log(`结果：${result.state?.lastResult ?? ''}`)
  } else if (result.outcome === 'ran') {
    log(`签到完成：${result.state?.lastResult ?? ''}`)
  } else {
    log('本次没有得到确定结果（渠道可能还在刷新凭据或网络不通）——渠道包会在下次运行时重试。')
    log(`当前状态：${result.state?.lastResult ?? '(无)'}`)
    exitCode = 1
  }

  if (!wantJson && Array.isArray(result.state?.channels) && result.state.channels.length > 0) {
    log('逐渠道：')
    for (const row of result.state.channels) log(`  ${String(row.provider).padEnd(12)} ${row.text ?? ''}`)
  }
} catch (error) {
  console.error(`签到失败：${error.message}`)
  exitCode = 1
} finally {
  await runtime.close()
}
process.exit(exitCode)
