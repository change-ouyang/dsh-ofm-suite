/**
 * 网关 HTTP 端到端测试 —— 用「桩运行时」注入合成 chunk，不联网、不登录。
 *
 * 真实渠道需要逐个浏览器登录，所以这里替换掉渠道 Worker，只验证网关自身的职责：
 * 认证、路由、OpenAI 非流式装配、SSE 流式帧、错误码。渠道业务本身由
 * business.mjs（原项目构建产物）负责，不在本测试范围。
 *
 * 运行：node test/http.test.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startGateway } from '../server.mjs'

let passed = 0
const failures = []

async function test(name, body) {
  try { await body(); passed++; console.log(`  ok  ${name}`) }
  catch (error) { failures.push({ name, error }); console.log(`FAIL  ${name}\n      ${error.stack ?? error.message}`) }
}

const KEY = 'test-key'

/** 桩运行时：按 script 回放 chunk，并折叠出 outcome（与真实 runtime 同契约）。 */
function stubRuntime({ script = [], rows = [{ id: 'fake/model-a', object: 'model', owned_by: 'fake' }], fail, accountsEnabled = 1, autoCheckin, checkinError, calls, providers = ['fake'], balances, balancesError } = {}) {
  const checkin = { enabled: true, lastDate: '', running: false, lastResult: '', channels: [], ...(autoCheckin ?? {}) }
  // accountsEnabled 可以是数字(所有渠道一样)或按渠道给的表。
  const enabledFor = provider => (typeof accountsEnabled === 'object' && accountsEnabled !== null ? (accountsEnabled[provider] ?? 0) : accountsEnabled)
  return {
    providers,
    publicModelRows: () => rows,
    async refresh() { return rows },
    handles: () => true,
    async rpc(body) {
      calls?.push(body)
      if (body.method === 'provider.status') {
        const statuses = {}
        for (const provider of providers) statuses[provider] = { accounts: { enabled: enabledFor(provider) } }
        return { ok: true, value: { statuses } }
      }
      if (body.method === 'model.list') return { ok: true, value: { models: [{ id: 'model-a', name: 'Model A' }] } }
      if (body.method === 'credits.balances') {
        const provider = body.payload?.provider
        if (balancesError?.[provider] !== undefined) return { ok: false, error: { code: 'upstream', message: balancesError[provider] } }
        return {
          ok: true,
          value: {
            accounts: balances?.[provider] ?? [{
              accountId: `${provider}-1`,
              nickname: '测试账号',
              balance: { total: 500, packages: [{ name: '套餐额度', unit: 'credits', remaining: 300, total: 300 }] },
            }],
          },
        }
      }
      if (body.method === 'usage.autoCheckin') {
        if (checkinError !== undefined) return { ok: false, error: { code: 'upstream', message: checkinError } }
        if (typeof body.payload?.enabled === 'boolean') checkin.enabled = body.payload.enabled
        return { ok: true, value: { autoCheckin: { ...checkin } } }
      }
      if (body.method === 'credits.claimAll') {
        return { ok: true, value: { provider: body.payload?.provider, results: [{ accountId: 'fake-1', ok: true }] } }
      }
      return { ok: false, error: { code: 'bad-request', message: 'unknown method' } }
    },
    async complete(request, onChunk) {
      if (fail) throw Object.assign(new Error(fail.message), { statusCode: fail.statusCode })
      const outcome = { text: '', toolCalls: [], usage: undefined, truncated: false, error: undefined }
      const { foldForwardOutcome } = await import('../channels/fold.mjs')
      for (const chunk of script) {
        foldForwardOutcome(outcome, chunk)
        onChunk?.(chunk)
      }
      return outcome
    },
    async close() {},
  }
}

const silent = { info() {}, warn() {}, error() {} }

async function withGateway(runtime, body) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-http-test-'))
  const gateway = await startGateway({ port: 0, dataDir, key: KEY, refresh: false, runtime, logger: silent })
  try { await body(gateway) } finally {
    await gateway.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
}

const auth = { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' }
const url = (gateway, path) => `http://127.0.0.1:${gateway.port}${path}`

console.log('auth')

await test('无 key 返回 401', async () => {
  await withGateway(stubRuntime(), async gateway => {
    const res = await fetch(url(gateway, '/v1/models'))
    assert.equal(res.status, 401)
    assert.equal((await res.json()).error.type, 'authentication_error')
  })
})

await test('错误 key 返回 401', async () => {
  await withGateway(stubRuntime(), async gateway => {
    const res = await fetch(url(gateway, '/v1/models'), { headers: { authorization: 'Bearer nope' } })
    assert.equal(res.status, 401)
  })
})

await test('x-api-key 头同样可用', async () => {
  await withGateway(stubRuntime(), async gateway => {
    const res = await fetch(url(gateway, '/v1/models'), { headers: { 'x-api-key': KEY } })
    assert.equal(res.status, 200)
  })
})

console.log('models')

await test('/v1/models 合并目录与运行时行', async () => {
  await withGateway(stubRuntime(), async gateway => {
    const res = await fetch(url(gateway, '/v1/models'), { headers: auth })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.object, 'list')
    const ids = body.data.map(row => row.id)
    assert.ok(ids.includes('fake/model-a'), '目录行存在')
    assert.equal(body.data.find(row => row.id === 'fake/model-a')['x-provider-ready'], true, '已登录渠道标记为 ready')
  })
})

console.log('chat completions（非流式）')

await test('纯文本回答装配成 chat.completion', async () => {
  const runtime = stubRuntime({
    script: [
      { type: 'text-delta', text: '你' },
      { type: 'text-delta', text: '好' },
      { type: 'usage', usage: { inputTokens: 3, outputTokens: 2 } },
    ],
  })
  await withGateway(runtime, async gateway => {
    const res = await fetch(url(gateway, '/v1/chat/completions'), {
      method: 'POST', headers: auth,
      body: JSON.stringify({ model: 'fake/model-a', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.object, 'chat.completion')
    assert.equal(body.choices[0].message.role, 'assistant')
    assert.equal(body.choices[0].message.content, '你好')
    assert.equal(body.choices[0].finish_reason, 'stop')
    assert.equal(body.usage.total_tokens, 5)
  })
})

await test('工具调用装配成 tool_calls 且 finish_reason=tool_calls', async () => {
  const runtime = stubRuntime({
    script: [
      { type: 'tool-call-delta', index: 0, id: 'call_1', name: 'get_weather', argumentsDelta: '{"city":"SF"}' },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ],
  })
  await withGateway(runtime, async gateway => {
    const res = await fetch(url(gateway, '/v1/chat/completions'), {
      method: 'POST', headers: auth,
      body: JSON.stringify({
        model: 'fake/model-a',
        messages: [{ role: 'user', content: 'weather?' }],
        tools: [{ type: 'function', function: { name: 'get_weather' } }],
      }),
    })
    const body = await res.json()
    assert.equal(body.choices[0].finish_reason, 'tool_calls')
    const call = body.choices[0].message.tool_calls[0]
    assert.equal(call.id, 'call_1')
    assert.equal(call.type, 'function')
    assert.equal(call.function.name, 'get_weather')
    assert.equal(call.function.arguments, '{"city":"SF"}')
  })
})

await test('截断（max-tokens）报 finish_reason=length', async () => {
  const runtime = stubRuntime({
    script: [
      { type: 'text-delta', text: '半句' },
      { type: 'finish', reason: { kind: 'max-tokens' } },
    ],
  })
  await withGateway(runtime, async gateway => {
    const res = await fetch(url(gateway, '/v1/chat/completions'), {
      method: 'POST', headers: auth,
      body: JSON.stringify({ model: 'fake/model-a', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal((await res.json()).choices[0].finish_reason, 'length')
  })
})

await test('上游错误导致 outcome.error 时返回 502', async () => {
  const runtime = stubRuntime({
    script: [{ type: 'finish', reason: { kind: 'error', failure: { message: '上游拒绝' } } }],
  })
  await withGateway(runtime, async gateway => {
    const res = await fetch(url(gateway, '/v1/chat/completions'), {
      method: 'POST', headers: auth,
      body: JSON.stringify({ model: 'fake/model-a', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(res.status, 502)
    assert.match((await res.json()).error.message, /上游拒绝/)
  })
})

await test('只活下来诱饵工具时返回 502，而不是空的 stop', async () => {
  const runtime = stubRuntime({
    script: [{ type: 'tool-call-delta', index: 0, id: 'call_x', name: 'bash', argumentsDelta: '{"command":"rm -rf /"}' }],
  })
  await withGateway(runtime, async gateway => {
    const res = await fetch(url(gateway, '/v1/chat/completions'), {
      method: 'POST', headers: auth,
      body: JSON.stringify({
        model: 'fake/model-a',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ type: 'function', function: { name: 'get_weather' } }],
      }),
    })
    assert.equal(res.status, 502)
  })
})

await test('运行时抛 404 时透传状态码', async () => {
  const runtime = stubRuntime({ fail: { message: '模型不存在或已停用', statusCode: 404 } })
  await withGateway(runtime, async gateway => {
    const res = await fetch(url(gateway, '/v1/chat/completions'), {
      method: 'POST', headers: auth,
      body: JSON.stringify({ model: 'fake/unknown', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(res.status, 404)
  })
})

await test('渠道未登录 + 推理失败时，404 被升级成带登录指引的 409', async () => {
  // 未登录 ⇒ 适配器播报的可路由集合为空（publicModelRows 为空），模型只在静态目录里。
  const runtime = stubRuntime({ accountsEnabled: 0, rows: [], fail: { message: '模型不存在或已停用', statusCode: 404 } })
  await withGateway(runtime, async gateway => {
    const res = await fetch(url(gateway, '/v1/chat/completions'), {
      method: 'POST', headers: auth,
      body: JSON.stringify({ model: 'fake/model-a', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(res.status, 409)
    const body = await res.json()
    assert.equal(body.error.type, 'provider_not_ready')
    assert.match(body.error.message, /account\.create/, '提示里要有可照做的命令')
    assert.match(body.error.message, /fake/, '提示里要指明是哪个渠道')
  })
})

await test('已登录但没有可路由模型时，提示走诊断而不是叫用户重复登录', async () => {
  // 真实案例：qoder 账号在，但账号无该模型权益 ⇒ listModels() 为空 ⇒ 全部 404。
  const runtime = stubRuntime({ accountsEnabled: 1, rows: [], fail: { message: '模型不存在或已停用', statusCode: 404 } })
  await withGateway(runtime, async gateway => {
    const res = await fetch(url(gateway, '/v1/chat/completions'), {
      method: 'POST', headers: auth,
      body: JSON.stringify({ model: 'fake/model-a', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(res.status, 409)
    const body = await res.json()
    assert.equal(body.error.type, 'provider_not_ready')
    assert.match(body.error.message, /已有登录账号/, '要说清账号是有的')
    assert.doesNotMatch(body.error.message, /account\.create/, '不该叫用户再登录一次')
    assert.match(body.error.message, /account\.list/, '要给出诊断命令')
  })
})

await test('流式请求在开流前失败时，返回真正的 HTTP 409 而不是 200 错误帧', async () => {
  const runtime = stubRuntime({ accountsEnabled: 0, rows: [], fail: { message: '模型不存在或已停用', statusCode: 404 } })
  await withGateway(runtime, async gateway => {
    const res = await fetch(url(gateway, '/v1/chat/completions'), {
      method: 'POST', headers: auth,
      body: JSON.stringify({ model: 'fake/model-a', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    })
    assert.equal(res.status, 409, '不应是 200')
    assert.match(res.headers.get('content-type'), /application\/json/)
    assert.equal((await res.json()).error.type, 'provider_not_ready')
  })
})

await test('渠道未登录但模型本来就能用：不预检、照常返回 200（不误伤免费模型）', async () => {
  // cline 的 cline-free/* 这类模型可能无需账号即可调用；网关不得在请求前拦截。
  const runtime = stubRuntime({
    accountsEnabled: 0,
    script: [{ type: 'text-delta', text: '免登录也能答' }, { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }],
  })
  await withGateway(runtime, async gateway => {
    const res = await fetch(url(gateway, '/v1/chat/completions'), {
      method: 'POST', headers: auth,
      body: JSON.stringify({ model: 'fake/model-a', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(res.status, 200, '不允许因为没登录就预先拦掉可用模型')
    assert.equal((await res.json()).choices[0].message.content, '免登录也能答')
  })
})

await test('缺少 messages 返回 400', async () => {
  await withGateway(stubRuntime(), async gateway => {
    const res = await fetch(url(gateway, '/v1/chat/completions'), {
      method: 'POST', headers: auth, body: JSON.stringify({ model: 'fake/model-a' }),
    })
    assert.equal(res.status, 400)
  })
})

await test('model 不是 provider/model 格式返回 400', async () => {
  await withGateway(stubRuntime(), async gateway => {
    const res = await fetch(url(gateway, '/v1/chat/completions'), {
      method: 'POST', headers: auth,
      body: JSON.stringify({ model: 'bare-name', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(res.status, 400)
  })
})

console.log('chat completions（流式）')

await test('SSE 帧顺序：role → 正文 → usage → finish_reason → [DONE]', async () => {
  const runtime = stubRuntime({
    script: [
      { type: 'text-delta', text: 'AB' },
      { type: 'usage', usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, reasoningTokens: 0 } },
    ],
  })
  await withGateway(runtime, async gateway => {
    const res = await fetch(url(gateway, '/v1/chat/completions'), {
      method: 'POST', headers: auth,
      body: JSON.stringify({ model: 'fake/model-a', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    })
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type'), /text\/event-stream/)
    const text = await res.text()
    const frames = text.split('\n\n').filter(Boolean).map(line => line.replace(/^data: /, ''))
    assert.equal(frames.at(-1), '[DONE]')

    const events = frames.slice(0, -1).map(json => JSON.parse(json))
    assert.equal(events[0].choices[0].delta.role, 'assistant', '首帧应声明 role')
    const textDeltas = events.filter(e => e.choices?.[0]?.delta?.content)
    assert.deepEqual(textDeltas.map(e => e.choices[0].delta.content), ['AB'])
    const usageEvent = events.find(e => e.usage)
    assert.equal(usageEvent.usage.prompt_tokens, 1, 'usage 必须是 OpenAI 字段')
    assert.equal(usageEvent.usage.total_tokens, 3)
    assert.deepEqual(usageEvent.choices, [])
    const finish = events.at(-1)
    assert.equal(finish.choices[0].finish_reason, 'stop')
    assert.equal(events.at(-1).object, 'chat.completion.chunk')
  })
})

await test('流式工具调用：首帧带 name，续帧只带参数，index 正确', async () => {
  const runtime = stubRuntime({
    script: [
      { type: 'tool-call-delta', index: 0, id: 'call_1', name: 'get_weather', argumentsDelta: '{"city"' },
      { type: 'tool-call-delta', index: 0, argumentsDelta: ':"SF"}' },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ],
  })
  await withGateway(runtime, async gateway => {
    const res = await fetch(url(gateway, '/v1/chat/completions'), {
      method: 'POST', headers: auth,
      body: JSON.stringify({
        model: 'fake/model-a',
        messages: [{ role: 'user', content: 'weather?' }],
        tools: [{ type: 'function', function: { name: 'get_weather' } }],
        stream: true,
      }),
    })
    const text = await res.text()
    const events = text.split('\n\n').filter(Boolean).map(line => line.replace(/^data: /, ''))
      .filter(f => f !== '[DONE]').map(json => JSON.parse(json))
    const allCalls = events.flatMap(e => e.choices?.[0]?.delta?.tool_calls ?? [])
    assert.equal(allCalls.every(call => call.index === 0), true, 'index 应恒为 0')
    const withName = allCalls.filter(call => call.function?.name)
    assert.equal(withName.length, 1, 'name 只应出现一次')
    assert.equal(withName[0].function.name, 'get_weather')
    assert.equal(withName[0].id, 'call_1')
    const args = allCalls.map(call => call.function?.arguments ?? '').join('')
    assert.equal(args, '{"city":"SF"}', '参数增量应能拼回完整 JSON')
    assert.equal(events.at(-1).choices[0].finish_reason, 'tool_calls')
  })
})

await test('流式诱饵工具不落到客户端', async () => {
  const runtime = stubRuntime({
    script: [{ type: 'tool-call-delta', index: 0, id: 'call_x', name: 'bash', argumentsDelta: '{"command":"rm -rf /"}' }],
  })
  await withGateway(runtime, async gateway => {
    const res = await fetch(url(gateway, '/v1/chat/completions'), {
      method: 'POST', headers: auth,
      body: JSON.stringify({
        model: 'fake/model-a',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ type: 'function', function: { name: 'get_weather' } }],
        stream: true,
      }),
    })
    const text = await res.text()
    assert.equal(text.includes('rm -rf'), false, '诱饵参数不得出现在响应里')
    assert.match(text, /工具调用均不在本次声明/)
  })
})

console.log('rpc / responses / 其他')

await test('/rpc 转发并返回原结构', async () => {
  await withGateway(stubRuntime(), async gateway => {
    const res = await fetch(url(gateway, '/rpc'), {
      method: 'POST', headers: auth,
      body: JSON.stringify({ method: 'provider.status', payload: { providers: ['fake'] } }),
    })
    assert.equal(res.status, 200)
    assert.equal((await res.json()).ok, true)
  })
})

await test('/rpc 缺 payload 返回 400', async () => {
  await withGateway(stubRuntime(), async gateway => {
    const res = await fetch(url(gateway, '/rpc'), {
      method: 'POST', headers: auth, body: JSON.stringify({ method: 'x' }),
    })
    assert.equal(res.status, 400)
  })
})

await test('/v1/responses 非流式返回 response 对象', async () => {
  const runtime = stubRuntime({ script: [{ type: 'text-delta', text: '好的' }] })
  await withGateway(runtime, async gateway => {
    const res = await fetch(url(gateway, '/v1/responses'), {
      method: 'POST', headers: auth,
      body: JSON.stringify({ model: 'fake/model-a', input: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.object, 'response')
    assert.equal(body.output[0].content[0].text, '好的')
  })
})

await test('非法 JSON 请求体返回 400（不是 500）', async () => {
  await withGateway(stubRuntime(), async gateway => {
    const res = await fetch(url(gateway, '/v1/chat/completions'), {
      method: 'POST', headers: auth, body: '{"model": broken',
    })
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.equal(body.error.type, 'invalid_request_error')
    assert.match(body.error.message, /合法 JSON/)
  })
})

await test('顶层是数组的请求体返回 400', async () => {
  await withGateway(stubRuntime(), async gateway => {
    const res = await fetch(url(gateway, '/v1/chat/completions'), {
      method: 'POST', headers: auth, body: '[1,2,3]',
    })
    assert.equal(res.status, 400)
  })
})

await test('超过 8MB 的请求体返回 413', async () => {
  await withGateway(stubRuntime(), async gateway => {
    const res = await fetch(url(gateway, '/v1/chat/completions'), {
      method: 'POST', headers: auth, body: JSON.stringify({ model: 'fake/model-a', messages: [{ role: 'user', content: 'x'.repeat(8 * 1024 * 1024 + 100) }] }),
    })
    assert.equal(res.status, 413)
  })
})

await test('未知路径返回 404', async () => {
  await withGateway(stubRuntime(), async gateway => {
    assert.equal((await fetch(url(gateway, '/nope'), { headers: auth })).status, 404)
  })
})

await test('OPTIONS 预检不需要 key', async () => {
  await withGateway(stubRuntime(), async gateway => {
    const res = await fetch(url(gateway, '/v1/models'), { method: 'OPTIONS' })
    assert.equal(res.status, 204)
    assert.equal(res.headers.get('access-control-allow-origin'), '*')
  })
})

// ---------------------------------------------------------------------------
// 每日签到
// ---------------------------------------------------------------------------
// ⚠️ 这里锁一个真实踩过的坑：`runtime.rpc()` 返回的是**信封** `{ok,value}`。
// 内部调用忘了解包时，`envelope.autoCheckin` 是 undefined，而 JSON.stringify 会把
// undefined 字段整个丢掉 —— 接口 200、结构合法、就是没有数据，非常难看出来。
console.log('每日签到')

await test('GET /checkin 解包 RPC 信封并给出签到状态', async () => {
  const stub = stubRuntime({ autoCheckin: { enabled: true, lastDate: '2026-10-17', lastResult: '1 个渠道：1 个账号领取成功（+100积分）' } })
  await withGateway(stub, async gateway => {
    const res = await fetch(url(gateway, '/checkin'), { headers: { authorization: `Bearer ${KEY}` } })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.ok(body.autoCheckin !== undefined && body.autoCheckin !== null, 'autoCheckin 必须出现在响应里（解包回归）')
    assert.equal(body.autoCheckin.enabled, true)
    assert.equal(body.autoCheckin.lastDate, '2026-10-17')
    assert.match(body.autoCheckin.lastResult, /领取成功/)
    assert.equal(body.scheduler.at, '09:00')
  })
})

await test('POST /checkin/run 触发整轮（走 usage.autoCheckin enabled:true）', async () => {
  const calls = []
  await withGateway(stubRuntime({ calls }), async gateway => {
    const res = await fetch(url(gateway, '/checkin/run'), { method: 'POST', headers: auth, body: '{}' })
    assert.equal(res.status, 200)
    const triggered = calls.filter(item => item.method === 'usage.autoCheckin' && item.payload?.enabled === true)
    assert.equal(triggered.length, 1, '应恰好触发一轮')
    assert.equal((await res.json()).autoCheckin.enabled, true)
  })
})

await test('POST /checkin/run 带 provider 只领该渠道（走 credits.claimAll）', async () => {
  const calls = []
  await withGateway(stubRuntime({ calls }), async gateway => {
    const res = await fetch(url(gateway, '/checkin/run'), {
      method: 'POST', headers: auth, body: JSON.stringify({ provider: 'trae' }),
    })
    assert.equal(res.status, 200)
    const claim = calls.find(item => item.method === 'credits.claimAll')
    assert.ok(claim !== undefined, '应调用 credits.claimAll')
    assert.equal(claim.payload.provider, 'trae')
    assert.equal((await res.json()).provider, 'trae')
  })
})

await test('签到 RPC 失败时 /checkin 返回 502（而不是空壳 200）', async () => {
  await withGateway(stubRuntime({ checkinError: '渠道侧读取签到状态失败' }), async gateway => {
    const res = await fetch(url(gateway, '/checkin'), { headers: { authorization: `Bearer ${KEY}` } })
    assert.equal(res.status, 502)
    assert.match((await res.json()).error.message, /读取签到状态失败/)
  })
})

await test('GET /checkin 给逐渠道行补上「已领取」判定(文字归类)', async () => {
  const stub = stubRuntime({
    autoCheckin: {
      channels: [
        { provider: 'trae', text: '1 个 +100 积分' },
        { provider: 'buddy', text: '1 个今天已领' },
        { provider: 'codearts', text: '1 个失败' },
        { provider: 'zcode', text: '需手动签到' },
        { provider: 'gemini', text: '无签到接口' },
        { provider: 'qoder', text: '1 个未开启' },
      ],
    },
  })
  await withGateway(stub, async gateway => {
    const res = await fetch(url(gateway, '/checkin'), { headers: { authorization: `Bearer ${KEY}` } })
    assert.equal(res.status, 200)
    const rows = (await res.json()).autoCheckin.channels
    const byProvider = Object.fromEntries(rows.map(row => [row.provider, row]))
    assert.equal(byProvider.trae.claimed, true, '本轮刚领到(+100 积分)要显示已领取')
    assert.deepEqual(byProvider.trae.flags, ['claimed-now'])
    assert.equal(byProvider.buddy.claimed, true)
    assert.deepEqual(byProvider.buddy.flags, ['claimed'])
    assert.equal(byProvider.codearts.claimed, false)
    assert.deepEqual(byProvider.codearts.flags, ['failed'])
    assert.deepEqual(byProvider.zcode.flags, ['manual'], '手动签到必须保留可点,不算已领')
    assert.deepEqual(byProvider.gemini.flags, ['unsupported'])
    assert.deepEqual(byProvider.qoder.flags, ['inactive'])
    assert.equal(byProvider.buddy.text, '1 个今天已领', '渠道包的原文必须原样保留')
  })
})

await test('GET /checkin/balance 只查有账号的渠道,并逐渠道给出余额', async () => {
  const stub = stubRuntime({ providers: ['trae', 'qodercn', 'gemini'], accountsEnabled: { trae: 1, qodercn: 1, gemini: 0 } })
  await withGateway(stub, async gateway => {
    const res = await fetch(url(gateway, '/checkin/balance'), { headers: { authorization: `Bearer ${KEY}` } })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.deepEqual(body.balances.map(row => row.provider), ['trae', 'qodercn'], '没登录的渠道不该去问上游')
    assert.equal(body.balances[0].accounts[0].balance.total, 500)
    assert.equal(typeof body.generatedAt, 'number')
  })
})

await test('GET /checkin/balance 单个渠道失败不影响其它渠道(逐条报错)', async () => {
  const stub = stubRuntime({ providers: ['trae', 'qodercn'], balancesError: { qodercn: '账号凭据已过期' } })
  await withGateway(stub, async gateway => {
    const body = await (await fetch(url(gateway, '/checkin/balance'), { headers: { authorization: `Bearer ${KEY}` } })).json()
    const trae = body.balances.find(row => row.provider === 'trae')
    const qodercn = body.balances.find(row => row.provider === 'qodercn')
    assert.equal(trae.error, undefined)
    assert.equal(trae.accounts.length, 1)
    assert.match(qodercn.error, /凭据已过期/)
    assert.deepEqual(qodercn.accounts, [])
  })
})

await test('GET /checkin/balance?provider=x 只查一个渠道', async () => {
  const calls = []
  await withGateway(stubRuntime({ providers: ['trae', 'qodercn'], calls }), async gateway => {
    const body = await (await fetch(url(gateway, '/checkin/balance?provider=trae'), { headers: { authorization: `Bearer ${KEY}` } })).json()
    assert.deepEqual(body.balances.map(row => row.provider), ['trae'])
    const queried = calls.filter(item => item.method === 'credits.balances')
    assert.deepEqual(queried.map(item => item.payload.provider), ['trae'])
  })
})

console.log('')
if (failures.length > 0) {
  console.log(`${failures.length} 项失败，${passed} 项通过`)
  process.exitCode = 1
} else {
  console.log(`全部通过：${passed} 项`)
}