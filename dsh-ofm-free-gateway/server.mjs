#!/usr/bin/env node
/**
 * ofm-free-gateway — 剥离版极简 OpenAI 兼容网关
 *
 * 从 dsh-our-free-model 独立出「13 个免费渠道」的接入能力：
 *   - channels/ 原样复用（business.mjs 打包了 CodeArts/CodeBuddy/WorkBuddy/
 *     LobsterAI/Qoder/QoderCN/TRAE/Cline/Loomy/Raccoon/MiniMax/ZCode/Gemini）
 *   - 不依赖 dsh / Cordis / @deepseek-ai 任何包
 *   - 只暴露 OpenAI 兼容 HTTP API（/v1/models、/v1/chat/completions、/v1/responses）
 *   - 只绑定 loopback，必须带 Bearer API key
 *
 * 启动：
 *   node server.mjs --port 18900 --data-dir <dir> [--key <api-key>] [--no-refresh]
 */

import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createChannelRuntime } from './channels/runtime.mjs'
import { toOpenAiUsage } from './channels/fold.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PRODUCT = 'ofm-free-gateway'
const VERSION = '0.1.0'

// ---------------------------------------------------------------------------
// CLI 参数
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const options = { port: 18900, dataDir: '', key: '', refresh: true, checkin: true, checkinAt: '09:00' }
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '--help') { console.log(usage()); process.exit(0) }
    if (flag === '--no-refresh') { options.refresh = false; continue }
    if (flag === '--no-checkin') { options.checkin = false; continue }
    if (flag === '--probe') { options.probe = true; continue }
    if (!['--port', '--data-dir', '--key', '--checkin-at'].includes(flag) || !argv[i + 1] || argv[i + 1].startsWith('--')) {
      throw new Error(`未知选项或缺少参数：${flag}`)
    }
    const value = argv[++i]
    if (flag === '--port') {
      if (!/^\d+$/.test(value) || Number(value) > 65535) throw new Error('端口必须是 0 到 65535 的数字')
      options.port = Number(value)
    } else if (flag === '--data-dir') options.dataDir = path.resolve(value)
    else if (flag === '--key') options.key = value
    else if (flag === '--checkin-at') {
      const minutes = parseCheckinAt(value)
      if (minutes === undefined) throw new Error('--checkin-at 需要 HH:MM 形式，例如 --checkin-at 09:00')
      options.checkinAt = value
    }
  }
  return options
}

function usage() {
  return `ofm-free-gateway — 13 个免费渠道的 OpenAI 兼容网关
用法：node server.mjs [选项]

  --port <端口>       监听端口，默认 18900（冲突时自动选择可用端口）
  --data-dir <目录>   数据目录（渠道凭证、缓存），默认 ~/.ofm-free-gateway
  --key <API Key>     访问密钥；缺省自动生成并打印
  --no-refresh        跳过启动与周期刷新；仍可手动刷新和推理
  --checkin-at <HH:MM> 每天几点之后补一轮签到，默认 09:00
                       （渠道包启动 30 秒后自己会跑一轮；这项负责之后每一天）
  --no-checkin        关闭每日签到的定时检查（不影响启动那一轮）
  --help              显示帮助

签到相关接口：
  GET  /checkin/balance  积分详情:逐账号余额与套餐明细;?provider=trae 只查一个
  GET  /checkin          查看签到状态与逐渠道结果
  POST /checkin/run      立刻签到（整轮）；带 {"provider":"trae"} 只领该渠道
  POST /rpc              原始渠道 RPC（credits.claimAll / usage.autoCheckin 等）
`
}

// ---------------------------------------------------------------------------
// 数据目录与凭证
// ---------------------------------------------------------------------------
function resolveDataDir(configured) {
  if (configured) return path.resolve(configured)
  const home = process.env.OFM_HOME?.trim() || path.join(os.homedir(), '.ofm-free-gateway')
  return path.resolve(home)
}

function loadOrCreateSettings(dataDir, providedKey) {
  fs.mkdirSync(dataDir, { recursive: true })
  const file = path.join(dataDir, 'settings.json')
  let settings = {}
  if (fs.existsSync(file)) {
    try { settings = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { settings = {} }
  }
  const key = providedKey || settings.forwardKey || `ofm-${crypto.randomBytes(24).toString('hex')}`
  const next = { ...settings, forwardKey: key }
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
  fs.writeFileSync(temp, JSON.stringify(next, null, 2), { mode: 0o600, flag: 'wx' })
  fs.renameSync(temp, file)
  return { key, file }
}

// ---------------------------------------------------------------------------
// 极简工具围栏：只放行客户端声明过的工具；指纹工具名一律丢弃
// ---------------------------------------------------------------------------
const FINGERPRINT_TOOLS = ['bash', 'glob', 'grep', 'read']

export function createToolWire(body) {
  // 客户端自己声明的工具名。若某次工具调用的名字属于指纹四件套却不在这份名单里，
  // 那是模型拨了它不该拨的诱饵，直接在上游丢掉，而不是交给客户端一个跑不了的工具。
  const declared = new Set()
  for (const tool of Array.isArray(body?.tools) ? body.tools : []) {
    const name = tool?.function?.name ?? tool?.name
    if (typeof name === 'string' && name !== '') declared.add(name)
  }
  const slots = new Map()
  let nextIndex = 0
  // 一个 block 在报出名字的那一刻才被定性。在此之前它的参数片段先扣住：
  // 「先流参数、后流名字」的供应商少见，但乐观转发会把诱饵片段漏给跑不了的客户端。
  const classified = new Map()
  const held = new Map()
  return {
    /** 这个（还原后的）工具名，客户端是否真能执行？ */
    executable: name => !(FINGERPRINT_TOOLS.includes(name) && !declared.has(name)),
    /** 该 block 在本次请求中的顺序索引，OpenAI 客户端期望从 0 递增。 */
    indexOf(blockIndex) {
      let assigned = slots.get(blockIndex)
      if (assigned === undefined) { assigned = nextIndex++; slots.set(blockIndex, assigned) }
      return assigned
    },
    /**
     * 路由一个工具调用 delta。
     * @returns {{kind:'drop'} | {kind:'forward', openAiIndex:number, first:boolean, id?:string, name?:string, args:string}}
     */
    admit(chunk) {
      const blockIndex = chunk.index
      const verdict = classified.get(blockIndex)
      if (verdict === false) return { kind: 'drop' }
      const name = typeof chunk.name === 'string' && chunk.name !== '' ? chunk.name : undefined
      if (verdict === true) {
        return { kind: 'forward', openAiIndex: this.indexOf(blockIndex), first: false, args: chunk.argumentsDelta ?? '' }
      }
      if (name !== undefined) {
        const keep = this.executable(name)
        classified.set(blockIndex, keep)
        if (!keep) return { kind: 'drop' }
        const parked = held.get(blockIndex)
        held.delete(blockIndex)
        return {
          kind: 'forward', openAiIndex: this.indexOf(blockIndex), first: true,
          id: chunk.id ?? parked?.id, name,
          args: [...parked?.args ?? [], chunk.argumentsDelta ?? ''].join(''),
        }
      }
      const parked = held.get(blockIndex) ?? { args: [] }
      if (chunk.id !== undefined && chunk.id !== '') parked.id = chunk.id
      if (chunk.argumentsDelta) parked.args.push(chunk.argumentsDelta)
      held.set(blockIndex, parked)
      return { kind: 'drop' }
    },
  }
}

/** outcome 里客户端真正可执行的工具调用（诱饵已在上游丢弃）。 */
function executableCalls(outcome, tools) {
  return (outcome.toolCalls ?? []).filter(call => tools.executable(call.name))
}

/**
 * 把一个内部 chunk 译成 0..n 个 OpenAI `chat.completion.chunk` 事件。
 *
 * 抽成纯函数是为了能脱网单测：渠道鉴权依赖真实登录，跑不通真实推理时，
 * 仍然可以证明「工具调用帧拼接」「usage 换算」「诱饵丢弃」这三处正确。
 *
 * @param {object} chunk 渠道流出的内部 chunk
 * @param {{id:string, created:number, model:string, tools:ReturnType<typeof createToolWire>}} ctx
 * @returns {object[]} 待写入的 SSE 事件
 */
export function sseEventsForChunk(chunk, ctx) {
  const { id, created, model, tools } = ctx
  if (chunk.type === 'text-delta') {
    return [{ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: chunk.text }, finish_reason: null }] }]
  }
  if (chunk.type === 'reasoning-delta') {
    return [{ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { reasoning: chunk.text }, finish_reason: null }] }]
  }
  if (chunk.type === 'tool-call-delta') {
    const action = tools.admit(chunk)
    if (action.kind === 'drop') return []
    const events = [{
      id, object: 'chat.completion.chunk', created, model,
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: action.openAiIndex,
            ...(action.first ? { id: action.id, function: { name: action.name ?? '', arguments: '' } } : {}),
          }],
        },
        finish_reason: null,
      }],
    }]
    if (action.args) {
      events.push({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { tool_calls: [{ index: action.openAiIndex, function: { arguments: action.args } }] }, finish_reason: null }] })
    }
    return events
  }
  if (chunk.type === 'usage') {
    return [{ id, object: 'chat.completion.chunk', created, model, choices: [], usage: toOpenAiUsage(chunk.usage) }]
  }
  return []
}

// ---------------------------------------------------------------------------
// HTTP 辅助
// ---------------------------------------------------------------------------
function json(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type, x-api-key',
  })
  res.end(body)
}

function openAiError(res, status, type, message) {
  json(res, status, { error: { message: String(message), type, code: status } })
}

/**
 * 读取并解析 JSON 请求体。
 *
 * 非法 JSON 属于调用方的错误（400），不是服务端故障，所以这里带上 statusCode，
 * 由外层的统一 catch 原样返回。
 */
async function readJsonBody(req, { limitBytes = 8 * 1024 * 1024 } = {}) {
  const hardCap = limitBytes * 4
  const chunks = []
  let size = 0
  let total = 0
  let over = false
  for await (const chunk of req) {
    total += chunk.length
    if (!over) {
      size += chunk.length
      if (size > limitBytes) {
        // 超限后**继续排空**请求体，而不是立刻中断连接。
        // 在客户端还在上传时关连接，它收到的是 ECONNRESET / fetch failed，
        // 而不是我们要给它的 413 —— 那会让「请求体过大」变成一个无法识别的错误。
        over = true
        chunks.length = 0
      } else {
        chunks.push(chunk)
      }
    }
    if (total > hardCap) break  // 恶意/失控上传：停止排空，此时连接重置可接受
  }
  if (over) throw Object.assign(new Error(`请求体超过 ${limitBytes} 字节上限`), { statusCode: 413 })
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  try {
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('顶层必须是 JSON 对象')
    }
    return parsed
  } catch (error) {
    throw Object.assign(new Error(`请求体不是合法 JSON：${error.message}`), { statusCode: 400 })
  }
}

function sendSse(res, event) {
  res.write(`data: ${JSON.stringify(event)}\n\n`)
}

function startHeartbeat(res, intervalMs = 15000) {
  const timer = setInterval(() => {
    if (res.writableEnded === true || res.destroyed === true) return
    res.write(': ping\n\n')
  }, intervalMs)
  timer.unref?.()
  const stop = () => clearInterval(timer)
  res.once('close', stop)
  return stop
}

function openStreamHeaders(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    'access-control-allow-origin': '*',
  })
  startHeartbeat(res)
}

// ---------------------------------------------------------------------------
// 模型目录
//
// 登录前 runtime 的可路由模型列表是空的（渠道按账号鉴权），但 channel-pack 的
// `model.list` 能返回每个渠道的完整静态目录。这里把两者合并：目录保证「看得见
// 有什么模型」，登录后 runtime 的权威行（带 context_window / max_tokens）覆盖同
// id 的行。每个模型带 `x-provider-ready` 标明该渠道是否已有可用账号。
// ---------------------------------------------------------------------------
function createCatalog(runtime) {
  const TTL_MS = 30_000
  let at = 0
  let rows = []
  let readyByProvider = new Map()
  let accounts = new Map()

  // runtime 的权威模型行（publicModelRows）由启动时的 refresh() 填充，**晚于**
  // runtime 对象创建。首次构建不等它落地，就会把「还没刷新」当成「没有任何模型
  // 可路由」并缓存 30 秒 —— 表现为所有模型都标记为不可用。
  const settled = Promise.resolve(runtime.ready).then(() => {}, () => {})
  let loading

  async function readProviders() {
    const providers = runtime.providers ?? []
    const statuses = {}
    if (typeof runtime.rpc !== 'function') return { providers, statuses }
    try {
      const status = await runtime.rpc({ method: 'provider.status', payload: { providers } })
      if (status?.ok) Object.assign(statuses, status.value?.statuses ?? {})
    } catch { /* 状态读不到不影响目录 */ }
    return { providers, statuses }
  }

  async function build() {
    await settled
    const { providers, statuses } = await readProviders()
    const collected = []
    const accountsByProvider = new Map()
    await Promise.all(providers.map(async provider => {
      const enabled = statuses[provider]?.accounts?.enabled ?? 0
      accountsByProvider.set(provider, enabled)
      if (typeof runtime.rpc !== 'function') return
      let listed
      try {
        listed = await runtime.rpc({ method: 'model.list', payload: { provider } })
      } catch { return }
      if (!listed?.ok) return
      for (const model of listed.value?.models ?? []) {
        if (model.disabled === true) continue
        collected.push({
          id: `${provider}/${model.id}`,
          object: 'model',
          created: 0,
          owned_by: provider,
          channel: provider,
          name: model.name ?? model.id,
          // 先给假值，build() 末尾按权威目录重算：有账号 ≠ 该模型真能路由。
          'x-provider-ready': false,
        })
      }
    }))

    // runtime 的权威行 = 适配器当前真正可路由的集合（门控与它同源）。
    //
    // `x-provider-ready` 必须按**逐模型**判定，不能按「渠道有账号」判定：
    // 实测出现过账号已登录、`model.list` 有 16 个模型，但适配器 `listModels()`
    // 因凭据不可解析而返回空 —— 那时 16 个模型全部 404，而渠道级标记仍显示就绪。
    const authoritative = new Map((runtime.publicModelRows() ?? []).map(row => [row.id, row]))
    const merged = collected.map(row => ({
      ...(authoritative.get(row.id) ?? row),
      'x-provider-ready': authoritative.has(row.id),
    }))
    const known = new Set(merged.map(row => row.id))
    for (const [id, row] of authoritative) {
      if (!known.has(id)) merged.push({ ...row, 'x-provider-ready': true })
    }
    // 渠道级就绪 = 该渠道至少有一个可路由模型；供登录提示判断用哪种措辞。
    const routing = new Map()
    for (const id of authoritative.keys()) {
      const slash = id.indexOf('/')
      if (slash > 0) routing.set(id.slice(0, slash), true)
    }
    rows = merged.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    readyByProvider = routing
    accounts = accountsByProvider
    at = Date.now()
    return rows
  }

  async function load(force = false) {
    if (!force && rows.length > 0 && Date.now() - at < TTL_MS) return rows
    if (loading !== undefined) return loading
    loading = build().finally(() => { loading = undefined })
    return loading
  }

  return {
    load,
    invalidate() { at = 0 },
    /**
     * 模型确实在目录里、但当前不可路由时，返回一条可直接照做的提示。
     *
     * 分两种措辞，因为处置办法完全不同（实测两者都出现过）：
     * - 没登录 → 给 account.create 命令；
     * - 已登录但零可路由模型（账号无权益 / 凭据失效 / 额度耗尽）→ 让用户
     *   先看诊断，而不是去重复登录一个已经存在的账号。
     */
    async notReadyHint(modelId) {
      const slash = modelId.indexOf('/')
      if (slash <= 0) return null
      const provider = modelId.slice(0, slash)
      const present = (await load()).some(row => row.id === modelId)
      if (!present) return null
      if (readyByProvider.get(provider) === true) return null
      const rpc = `curl -X POST http://127.0.0.1:<端口>/rpc -H "Authorization: Bearer <key>" -H "Content-Type: application/json"`
      if ((accounts.get(provider) ?? 0) > 0) {
        return `渠道 ${provider} 已有登录账号，但当前没有任何可用模型`
          + `（常见原因：账号无该模型权益、凭据失效需重登、或额度已耗尽）。可先诊断：`
          + `${rpc} -d '{"method":"account.list","payload":{"provider":"${provider}"}}'`
          + ` 查看账号状态，必要时用 account.retest 复测。`
      }
      return `渠道 ${provider} 尚未登录。先执行：`
        + `${rpc} -d '{"method":"account.create","payload":{"provider":"${provider}"}}'`
        + `，用返回的 loginUrl 完成浏览器登录后重试。`
    },
  }
}

/**
 * 推理失败时的收尾：若模型确实在目录里、只是所属渠道还没登录，就把「怎么登录」
 * 直接写进错误里（409），否则原样透传上游状态码。
 *
 * 之所以放在失败之后而不是请求之前：部分渠道的免费模型可能无需账号即可调用，
 * 预先拦截会把这些模型一起误伤。
 */
async function failWithHint(res, model, error, catalog) {
  let hint = null
  try { hint = await catalog.notReadyHint(model) } catch { /* 提示拿不到就退回原始错误 */ }
  if (hint !== null) {
    openAiError(res, 409, 'provider_not_ready', `${error.message}。${hint}`)
    return
  }
  openAiError(res, error.statusCode ?? 502, 'server_error', error.message)
}

// ---------------------------------------------------------------------------
// /v1/models
// ---------------------------------------------------------------------------
async function handleModels(res, runtime, catalog) {
  const rows = await catalog.load()
  json(res, 200, { object: 'list', data: rows })
}

// ---------------------------------------------------------------------------
// /v1/chat/completions
// ---------------------------------------------------------------------------
async function handleChat(res, body, runtime, catalog) {
  const id = `chatcmpl-${crypto.randomBytes(12).toString('hex')}`
  const created = Math.floor(Date.now() / 1000)
  const model = typeof body.model === 'string' ? body.model : ''
  const stream = body.stream === true

  if (typeof body.model !== 'string' || !body.model.includes('/')) {
    openAiError(res, 400, 'invalid_request_error', 'model 必须使用 provider/model 格式')
    return
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    openAiError(res, 400, 'invalid_request_error', 'messages 必须是非空数组')
    return
  }
  // 注意：这里**不**预检渠道登录状态。有些渠道的部分模型（如 cline 的 cline-free/*）
  // 可能无需账号就能用，预检会把它们误伤。改为先照常请求，失败后再补登录提示。

  const tools = createToolWire(body)

  if (!stream) {
    let outcome
    try {
      outcome = await runtime.complete({ model, openAi: body })
    } catch (error) {
      await failWithHint(res, model, error, catalog)
      return
    }
    if (outcome.error !== undefined) {
      openAiError(res, 502, 'server_error', outcome.error)
      return
    }
    const calls = executableCalls(outcome, tools)
    if (calls.length === 0 && (outcome.toolCalls ?? []).length > 0) {
      // 只活下来诱饵调用：报 stop 就是「拒答却回了 200 空内容」的另一种走法。
      openAiError(res, 502, 'server_error', '模型返回的工具调用均不在本次声明的工具列表中，已按安全策略丢弃')
      return
    }
    json(res, 200, {
      id, object: 'chat.completion', created, model,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: outcome.text === '' || outcome.text === undefined ? null : outcome.text,
          ...(calls.length ? { tool_calls: calls.map((call, i) => ({ id: call.id || `call_${i}`, type: 'function', function: { name: call.name, arguments: call.arguments } })) } : {}),
        },
        finish_reason: calls.length ? 'tool_calls' : outcome.truncated ? 'length' : 'stop',
      }],
      usage: outcome.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    })
    return
  }

  // 流式：状态行延迟到第一个事件才发。这样「开流前就失败」仍能回一个真正的
  // HTTP 状态码（例如未登录的 409），而不是把错误塞进已经花掉的 200 里。
  let headersSent = false
  const ensureHeaders = () => {
    if (headersSent) return
    headersSent = true
    openStreamHeaders(res)
    sendSse(res, { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })
  }
  let outcome
  try {
    outcome = await runtime.complete({ model, openAi: body }, (chunk) => {
      if (res.destroyed) return
      const events = sseEventsForChunk(chunk, { id, created, model, tools })
      if (events.length > 0) ensureHeaders()
      for (const event of events) sendSse(res, event)
    })
  } catch (error) {
    if (!headersSent) {
      await failWithHint(res, model, error, catalog)
      return
    }
    sendSse(res, { error: { message: String(error.message), type: 'server_error' } })
    res.write('data: [DONE]\n\n')
    res.end()
    return
  }
  ensureHeaders()
  if (outcome.error !== undefined) {
    sendSse(res, { error: { message: String(outcome.error), type: 'server_error' } })
    res.write('data: [DONE]\n\n')
    res.end()
    return
  }
  const calls = executableCalls(outcome, tools)
  if (calls.length === 0 && (outcome.toolCalls ?? []).length > 0) {
    // 状态行已随首个 SSE 帧发出，200 已经花掉了——但被拒的一轮仍要说出来。
    sendSse(res, { error: { message: '模型返回的工具调用均不在本次声明的工具列表中，已按安全策略丢弃', type: 'server_error' } })
    res.write('data: [DONE]\n\n')
    res.end()
    return
  }
  sendSse(res, {
    id, object: 'chat.completion.chunk', created, model,
    choices: [{ index: 0, delta: {}, finish_reason: calls.length ? 'tool_calls' : outcome.truncated ? 'length' : 'stop' }],
  })
  res.write('data: [DONE]\n\n')
  res.end()
}

// ---------------------------------------------------------------------------
// /v1/responses（简化：流式与非流式都走同一链路，非流式返回 message 文本）
// ---------------------------------------------------------------------------
async function handleResponses(res, body, runtime, catalog) {
  const id = `resp-${crypto.randomBytes(12).toString('hex')}`
  const created = Math.floor(Date.now() / 1000)
  const model = typeof body.model === 'string' ? body.model : ''
  const stream = body.stream === true

  if (typeof body.model !== 'string' || !body.model.includes('/')) {
    openAiError(res, 400, 'invalid_request_error', 'model 必须使用 provider/model 格式')
    return
  }
  if (!Array.isArray(body.input) || body.input.length === 0) {
    openAiError(res, 400, 'invalid_request_error', 'input 必须是非空数组')
    return
  }
  // 同 /v1/chat/completions：不预检登录状态，失败后再补提示。

  // 转成内部期望的 responsesBody；worker 用 responsesReasoningEffort 等读取
  const responsesBody = { ...body, model }

  if (!stream) {
    let outcome
    try {
      outcome = await runtime.complete({ model, responses: true, responsesBody })
    } catch (error) {
      await failWithHint(res, model, error, catalog)
      return
    }
    if (outcome.error !== undefined) {
      openAiError(res, 502, 'server_error', outcome.error)
      return
    }
    json(res, 200, {
      id, object: 'response', created_at: created, model,
      output: [{ type: 'message', id: `msg_${crypto.randomBytes(8).toString('hex')}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: outcome.text }] }],
      usage: outcome.usage,
    })
    return
  }

  // 同样延迟状态行：开流前失败时回真正的 HTTP 状态码。
  let headersSent = false
  const ensureHeaders = () => {
    if (headersSent) return
    headersSent = true
    openStreamHeaders(res)
  }
  let outcome
  try {
    outcome = await runtime.complete({ model, responses: true, responsesBody }, (chunk) => {
      if (res.destroyed) return
      if (chunk.type === 'text-delta') {
        ensureHeaders()
        sendSse(res, { type: 'response.output_text.delta', item_id: id, output_index: 0, content_index: 0, delta: chunk.text })
        return
      }
      if (chunk.type === 'reasoning-delta') {
        ensureHeaders()
        sendSse(res, { type: 'response.reasoning_summary_text.delta', item_id: id, output_index: 0, content_index: 0, delta: chunk.text })
        return
      }
    })
  } catch (error) {
    if (!headersSent) {
      await failWithHint(res, model, error, catalog)
      return
    }
    sendSse(res, { type: 'error', error: { message: String(error.message), type: 'server_error' } })
    res.write('data: [DONE]\n\n')
    res.end()
    return
  }
  ensureHeaders()
  if (outcome.error !== undefined) {
    sendSse(res, { type: 'error', error: { message: String(outcome.error), type: 'server_error' } })
  }
  sendSse(res, { type: 'response.completed', response: { id, object: 'response', created_at: created, model, status: 'completed', output: [{ type: 'message', id: `msg_${crypto.randomBytes(8).toString('hex')}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: outcome.text }] }], usage: outcome.usage } })
  res.write('data: [DONE]\n\n')
  res.end()
}

// ---------------------------------------------------------------------------
// 认证
// ---------------------------------------------------------------------------
function isLoopbackAddress(host) {
  if (host === '127.0.0.1' || host === '::1' || host === 'localhost') return true
  return false
}

// ---------------------------------------------------------------------------
// 服务主体
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 每日签到（自动签到 / 一键领取）
// ---------------------------------------------------------------------------
/**
 * 渠道包自带「每日自动签到」，但它的调度是**一次性**的：进程启动 30 秒后跑一轮
 * （`auto-checkin.ts` 的 `start()` 只挂一个 `setTimeout`），跑完把当天日期写进
 * `auto-checkin.json` 的 `lastDate`，此后**不再有任何定时器**。原版是 DSH 插件，
 * 依赖「用户每天都会打开 DSH」这个前提，所以这个设计在那边是够用的。
 *
 * 网关可能连续运行数周 —— 第二天起就不会再签到了。补上每日循环就是这段代码的
 * 全部理由。
 *
 * 触发方式刻意复用渠道包自己的开关接口 `usage.autoCheckin {enabled:true}`：它内部
 * 会调 `runIfDue()`（今天没跑过才跑），于是**不必复制任何签到逻辑、也不必重启
 * Worker**，而且 `lastResult` / `channels[]` 这些结果文字的格式化与插件界面同源。
 */

/** 本地日期键 `YYYY-MM-DD`，与 `auto-checkin.ts` 的 `today()` 同口径。 */
export function localDateKey(date = new Date()) {
  const pad = value => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 解析 `HH:MM` 为「当天第几分钟」（0-1439）；非法返回 undefined。 */
export function parseCheckinAt(text) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(text ?? '').trim())
  if (match === null) return undefined
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return undefined
  return hour * 60 + minute
}

/** 分钟数 → `HH:MM`（回显用）。 */
function formatCheckinAt(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}

/**
 * 纯判定：现在要不要触发一轮签到。抽成纯函数是为了可测 —— 定时器本身没法在测试里等。
 *
 * `lastTriggeredDate` 是**本进程**已经触发过的日期。它保证「一天最多触发一次」：
 * 渠道包在跑不出结果时（凭据没续上、网络不通）故意不写 `lastDate` 以便重试，
 * 若这里不设上限，就会每 60 秒重打一轮上游，把免费额度耗在失败重试上。
 */
export function shouldCheckinNow({ state, now, atMinutes, lastTriggeredDate }) {
  if (state?.enabled !== true) return { run: false, reason: '自动签到已关闭' }
  const today = localDateKey(now)
  if (state.lastDate === today) return { run: false, reason: '今天已完成' }
  if (lastTriggeredDate === today) return { run: false, reason: '今天已触发过一轮' }
  const minutes = now.getHours() * 60 + now.getMinutes()
  if (minutes < atMinutes) return { run: false, reason: `未到触发时间（${formatCheckinAt(atMinutes)}）` }
  return { run: true, reason: '今天还没签到' }
}

/**
 * 解包渠道包的 RPC 结果。
 *
 * `runtime.rpc()` 返回的是**信封** `{ok:true,value}` / `{ok:false,error}`（这是原项目
 * 的客户端契约，`/rpc` 端点原样转发）。内部调用要点必须解包一次再取字段 ——
 * 否则 `envelope.autoCheckin` 永远是 undefined，而 `JSON.stringify` 会把 undefined
 * 字段整个丢掉，表现成「接口正常但没有数据」，很难看出来。
 */
function unwrapRpc(result) {
  if (result !== null && typeof result === 'object' && 'ok' in result) {
    if (result.ok === false) {
      throw Object.assign(new Error(result.error?.message ?? '渠道 RPC 返回失败'), { statusCode: 502 })
    }
    return result.value
  }
  return result
}

/** 读渠道包的签到状态文档。 */
/**
 * 把渠道包的逐渠道结果文字归类。
 *
 * 渠道包只把逐渠道结果表达成一句中文(`auto-checkin.json` 的 `channels[].text`,
 * 由 `auto-checkin.ts` 的 summary 拼装处产生),没有结构化字段可读,所以这里按它
 * 固定的措辞归类 —— 措辞将来变了只会退化成 `unknown`,界面仍显示原文,不会崩。
 *
 * 刻意**不**把「失败」「未开启」「无签到接口」「需手动签到」算作已领:
 *   渠道包明确区分「领到了但 +0 分」与「今天已领」(写成「已领」会误导),
 *   并且明确保留 zcode 那类「需手动签到」的手动领取路径(见 auto-checkin.ts)。
 */
export function classifyCheckinText(text) {
  const value = String(text ?? '')
  const flags = []
  if (/需手动签到/.test(value)) flags.push('manual')
  if (/无签到接口/.test(value)) flags.push('unsupported')
  if (/未开启/.test(value)) flags.push('inactive')
  if (/失败/.test(value)) flags.push('failed')
  if (/(今天已领|已领)/.test(value)) flags.push('claimed')
  if (/\+[\d.]+\s*积分/.test(value)) flags.push('claimed-now')
  return {
    text: value,
    flags,
    // 「今天已经领到过」:更早领过(今天已领)与本轮刚领到(+N 积分)都算。
    claimed: flags.includes('claimed') || flags.includes('claimed-now'),
  }
}

/** 给 /checkin 的逐渠道行补上上面那份归类。 */
function withChannelStatus(state) {
  if (state === null || state === undefined) return null
  const channels = Array.isArray(state.channels) ? state.channels : []
  return { ...state, channels: channels.map(row => ({ ...row, ...classifyCheckinText(row.text) })) }
}

async function readAutoCheckin(runtime) {
  return unwrapRpc(await runtime.rpc({ method: 'usage.autoCheckin', payload: {} }))?.autoCheckin
}

/**
 * 每日签到调度器。
 *
 * 返回的对象带 `tick()`，供测试直接驱动一轮判定，不必等定时器。
 */
export function startCheckinScheduler(options) {
  const { runtime, logger = console, intervalMs = 60_000, now = () => new Date() } = options
  const atMinutes = parseCheckinAt(options.at ?? '09:00')
  if (atMinutes === undefined) throw new Error(`--checkin-at 需要 HH:MM 形式，收到：${options.at}`)

  let lastTriggeredDate = ''
  let pendingDate = ''
  let stopped = false
  const status = { at: formatCheckinAt(atMinutes), lastTriggeredDate: '', lastResult: '' }

  async function tick() {
    if (stopped) return { run: false, reason: '已停止' }
    let state
    try {
      state = await readAutoCheckin(runtime)
    } catch (error) {
      logger.warn?.(`每日签到：读取状态失败（${error.message}）`)
      return { run: false, reason: '读取状态失败' }
    }
    const today = localDateKey(now())

    // 上一次触发的签到跑完了（渠道包会写 lastDate / lastResult）—— 把结果补一行日志。
    if (pendingDate !== '' && state?.running !== true && state?.lastDate === pendingDate) {
      pendingDate = ''
      status.lastResult = state.lastResult ?? ''
      logger.info(`每日签到完成：${status.lastResult}`)
      return { run: false, reason: '已记录上一轮结果' }
    }

    const decision = shouldCheckinNow({ state, now: now(), atMinutes, lastTriggeredDate })
    if (!decision.run) return decision

    lastTriggeredDate = today
    status.lastTriggeredDate = today
    logger.info(`每日签到：触发一轮（${decision.reason}）`)
    try {
      const after = unwrapRpc(await runtime.rpc({ method: 'usage.autoCheckin', payload: { enabled: true } }))?.autoCheckin
      if (after?.lastDate === today && after?.running !== true) {
        // 渠道包同步跑完了 —— 直接记结果，不必等下一轮 tick。
        status.lastResult = after.lastResult ?? ''
        logger.info(`每日签到完成：${status.lastResult}`)
      } else {
        pendingDate = today
      }
    } catch (error) {
      logger.warn?.(`每日签到：触发失败（${error.message}）`)
    }
    return decision
  }

  const timer = setInterval(() => { void tick() }, intervalMs)
  timer.unref?.()

  return {
    at: status.at,
    tick,
    status: () => ({ ...status, pendingDate }),
    stop() {
      stopped = true
      clearInterval(timer)
    },
  }
}

/**
 * 常驻网关是否在运行（读数据目录里的 gw.pid 并探测进程存活）。
 *
 * 用来避免「常驻网关 + 定时一次性签到」同时跑：两边各起一个渠道 Worker、写同一份
 * `channel-pack/*.json`，会互相踩。探测失败（无文件、进程已死、PID 不是数字）都
 * 视为没在跑。
 */
export function gatewayPidAlive(dataDir, isAlive) {
  const file = path.join(dataDir, 'gw.pid')
  if (!fs.existsSync(file)) return false
  const pid = Number(fs.readFileSync(file, 'utf8').trim())
  if (!Number.isInteger(pid) || pid <= 0) return false
  const probe = isAlive ?? (value => {
    try { process.kill(value, 0); return true } catch { return false }
  })
  return probe(pid) === true
}

/**
 * 一次性签到：跑完就返回，供定时任务使用（不需要常驻网关）。
 *
 * 与常驻网关里的每日调度器同源 —— 都是触发渠道包自己的 `usage.autoCheckin
 * {enabled:true}`，不重写任何渠道逻辑。
 */
export async function runCheckinOnce(options) {
  const { runtime, logger = console, now = () => new Date(), waitMs = 240_000, pollMs = 3000 } = options
  const today = localDateKey(now())

  const before = await readAutoCheckin(runtime)
  if (before?.enabled === false) return { outcome: 'disabled', state: before }
  if (before?.lastDate === today) return { outcome: 'already-done', state: before }

  const previousLastAt = before?.lastAt
  await unwrapRpc(await runtime.rpc({ method: 'usage.autoCheckin', payload: { enabled: true } }))

  const deadline = Date.now() + waitMs
  let state = await readAutoCheckin(runtime)
  while (state?.running === true && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, pollMs))
    state = await readAutoCheckin(runtime)
  }
  if (state?.lastDate === today || state?.lastAt !== previousLastAt) {
    logger.info?.(`每日签到完成：${state?.lastResult ?? ''}`)
    return { outcome: 'ran', state }
  }
  // 渠道包在跑不出结果时故意不写 lastDate（下次重试）——如实报告，不当作成功。
  return { outcome: 'inconclusive', state }
}

export async function startGateway(options) {
  const dataDir = resolveDataDir(options.dataDir)
  const { key } = loadOrCreateSettings(dataDir, options.key)
  const logger = options.logger ?? console

  // 上一实例若是被强杀(Task Scheduler 的 Stop-Process -Force 就是),它来不及
  // 删掉 gw.pid —— 那个陈旧 PID 会让一次性签到脚本误判「网关还在跑」而跳过签到。
  // 这里先清掉:进程确实还活着的话,说明真有另一个网关在跑,那更不能动它的 pid 文件。
  try {
    const stale = path.join(dataDir, 'gw.pid')
    if (fs.existsSync(stale)) {
      const pid = Number(fs.readFileSync(stale, 'utf8').trim())
      if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) fs.unlinkSync(stale)
      else {
        let alive = true
        try { process.kill(pid, 0) } catch { alive = false }
        if (!alive) fs.unlinkSync(stale)
      }
    }
  } catch { /* 清不掉就继续跑 */ }

  // options.runtime 仅用于测试注入；正常启动时由渠道 Worker 提供。
  const runtime = options.runtime ?? await createChannelRuntime({ dataDir, logger })
  logger.info(`${PRODUCT} ${VERSION} 已加载渠道：${(runtime.providers ?? []).join(', ') || '(无)'}`)
  if (options.refresh !== false) {
    runtime.refresh().catch(error => logger.warn?.(`渠道清单刷新失败：${error.message}`))
  }

  const catalog = createCatalog(runtime)
  // 渠道目录预热:并发拉取 provider.status 与每渠道 model.list,失败不影响启动。
  catalog.load()
    .then(rows => logger.info(`模型目录已就绪:${rows.length} 个模型`))
    .catch(error => logger.warn?.(`模型目录读取失败:${error.message}`))

  // 每日签到：渠道包自己在启动 30 秒后跑一轮；这里只负责**后续每天**的那一轮。
  let checkin
  if (options.checkin !== false) {
    try {
      checkin = startCheckinScheduler({ runtime, logger, at: options.checkinAt, now: options.now })
      logger.info(`每日自动签到：已排定，每天 ${checkin.at} 后检查一次（渠道包启动那轮仍照常）`)
    } catch (error) {
      logger.warn?.(`每日自动签到未启用：${error.message}`)
    }
  } else {
    logger.info('每日自动签到：已按 --no-checkin 关闭（渠道包启动那轮仍会跑）')
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'authorization, content-type, x-api-key',
      })
      res.end()
      return
    }
    // 认证：Bearer key 或 x-api-key
    const headerKey = req.headers.authorization?.replace(/^Bearer\s+/i, '') ?? req.headers['x-api-key']
    if (typeof headerKey !== 'string' || headerKey !== key) {
      json(res, 401, { error: { message: '无效的 API Key', type: 'authentication_error', code: 401 } })
      return
    }

    try {
      if (req.method === 'GET' && url.pathname === '/v1/models') { await handleModels(res, runtime, catalog); return }
      if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
        await handleChat(res, await readJsonBody(req), runtime, catalog)
        return
      }
      if (req.method === 'POST' && url.pathname === '/v1/responses') {
        await handleResponses(res, await readJsonBody(req), runtime, catalog)
        return
      }
      // 渠道管理 RPC：登录、账号列表、签到等（复用原项目 channel-pack 接口）
      if (req.method === 'POST' && url.pathname === '/rpc') {
        const body = await readJsonBody(req)
        if (typeof body?.method !== 'string' || !Object.hasOwn(body, 'payload')) {
          json(res, 400, { error: { message: '缺少 method 或 payload', type: 'invalid_request_error', code: 400 } })
          return
        }
        const value = await runtime.rpc({ method: body.method, payload: body.payload }, new AbortController().signal)
        // 账号/模型/渠道开关会改变可用模型集合,目录缓存随之失效。
        if (/^(account|model|provider|gateway|credits)\./.test(body.method)) catalog.invalidate()
        json(res, 200, value)
        return
      }
      // 每日签到：状态查询与手动触发（等价于原插件界面上的开关与「一键领取」）
      if (req.method === 'GET' && url.pathname === '/checkin') {
        json(res, 200, { autoCheckin: withChannelStatus(await readAutoCheckin(runtime)), scheduler: checkin?.status() ?? null })
        return
      }
      // 积分详情:逐账号余额与套餐明细(credits.balances)。要打上游,所以按需调用。
      if (req.method === 'GET' && url.pathname === '/checkin/balance') {
        const only = url.searchParams.get('provider')
        const providers = Array.isArray(runtime.providers) ? runtime.providers : []
        let targets = providers
        if (typeof only === 'string' && only !== '') {
          targets = [only]
        } else {
          // 只查**有账号**的渠道:没登录的渠道查余额必然失败,白白等一轮超时。
          try {
            const status = unwrapRpc(await runtime.rpc({ method: 'provider.status', payload: { providers } }))
            const withAccounts = providers.filter(provider => (status?.statuses?.[provider]?.accounts?.enabled ?? 0) > 0)
            if (withAccounts.length > 0) targets = withAccounts
          } catch { /* 读不到状态就退回全部,让每个渠道各自报错 */ }
        }
        const balances = await Promise.all(targets.map(async provider => {
          try {
            const value = unwrapRpc(await runtime.rpc({ method: 'credits.balances', payload: { provider } }))
            return { provider, accounts: value?.accounts ?? [] }
          } catch (error) {
            return { provider, accounts: [], error: error.message }
          }
        }))
        json(res, 200, { balances, generatedAt: Date.now() })
        return
      }
      if (req.method === 'POST' && url.pathname === '/checkin/run') {
        const body = await readJsonBody(req)
        // 指定 provider ⇒ 只领这一个渠道（对应卡片上的「一键领取」）；
        // 否则走渠道包自己的整轮签到（含按渠道分类的结果文字）。
        if (typeof body?.provider === 'string' && body.provider !== '') {
          const value = unwrapRpc(await runtime.rpc({ method: 'credits.claimAll', payload: { provider: body.provider } }))
          json(res, 200, value)
          return
        }
        const value = unwrapRpc(await runtime.rpc({ method: 'usage.autoCheckin', payload: { enabled: true } }))
        json(res, 200, value)
        return
      }
      json(res, 404, { error: { message: 'Not Found', type: 'invalid_request_error', code: 404 } })
    } catch (error) {
      if (!res.headersSent) openAiError(res, error.statusCode ?? 500, error.statusCode ? 'invalid_request_error' : 'server_error', error.message)
      else { try { res.end() } catch {} }
    }
  })

  // 只绑定 loopback（IPv4/IPv6 都监听）
  const host = process.env.OFM_HOST?.trim() || '127.0.0.1'
  const address = await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, host, () => resolve(server.address()))
  })
  const port = typeof address === 'object' && address ? address.port : options.port
  logger.info(`管理 API 密钥保存在：${path.join(dataDir, 'settings.json')}`)
  logger.info(`API：http://${host}:${port}/v1`)
  logger.info(`API Key：${key}`)
  logger.info('仅绑定本机回环地址；外部访问请自行转发并保持密钥保密。')

  let closing = false
  const pidFile = path.join(dataDir, 'gw.pid')
  const writePidFile = () => {
    // 一次性签到脚本靠这个文件判断「常驻网关是否在跑」——两者同时写同一份
    // channel-pack/*.json 会互相踩。没有它，checkin-once.mjs 每次都会误以为
    // 网关没在跑，重复起一个渠道 Worker。
    try { fs.writeFileSync(pidFile, String(process.pid)) } catch { /* 写不了就算了，不影响网关本身 */ }
  }
  const removePidFile = () => {
    try { if (fs.existsSync(pidFile) && Number(fs.readFileSync(pidFile, 'utf8').trim()) === process.pid) fs.unlinkSync(pidFile) } catch {}
  }
  writePidFile()
  const close = async () => {
    if (closing) return
    closing = true
    // 注销信号监听：否则反复 start/close（测试、嵌入调用方）会累积监听器。
    process.removeListener('SIGINT', onSignal)
    process.removeListener('SIGTERM', onSignal)
    checkin?.stop()
    try { await runtime.close() } catch {}
    await new Promise(resolve => server.close(resolve))
    removePidFile()
  }
  const onSignal = () => { void close().then(() => process.exit(0)) }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)

  return { product: PRODUCT, version: VERSION, dataDir, url: `http://${host}:${port}/v1`, key, port, runtime, catalog, close }
}

// 直接运行（node server.mjs）
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let options
  try { options = parseArgs(process.argv) } catch (error) { console.error(error.message); console.error(usage()); process.exit(1) }
  startGateway(options).catch(error => {
    console.error(`启动失败：${error.message}`)
    process.exitCode = 1
  })
}
