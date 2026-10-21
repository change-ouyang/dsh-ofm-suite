/**
 * 网关纯函数单测 —— 不依赖网络、渠道登录或 HTTP 服务。
 *
 * 覆盖流式转换里最容易错的三处：
 *   1. 工具调用帧拼接（id/name 只发一次，参数增量续发，index 从 0 递增）
 *   2. usage 换算成 OpenAI 字段
 *   3. 指纹诱饵工具被丢弃，且「先参数后名字」时不泄漏片段
 *
 * 运行：node test/unit.test.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createToolWire, sseEventsForChunk, localDateKey, parseCheckinAt, shouldCheckinNow, startCheckinScheduler, gatewayPidAlive, runCheckinOnce, classifyCheckinText } from '../server.mjs'
import { foldForwardOutcome, toOpenAiUsage } from '../channels/fold.mjs'

let passed = 0
const failures = []

function test(name, body) {
  try { body(); passed++; console.log(`  ok  ${name}`) }
  catch (error) { failures.push({ name, error }); console.log(`FAIL  ${name}\n      ${error.message}`) }
}

const ctx = (body, extra = {}) => ({
  id: 'chatcmpl-test', created: 1700000000, model: 'buddy/deepseek-v4-flash',
  tools: createToolWire(body), ...extra,
})

console.log('tool wire')

test('正常工具调用：首帧带 id/name，后续只发参数增量', () => {
  const c = ctx({ tools: [{ type: 'function', function: { name: 'get_weather' } }] })
  const first = sseEventsForChunk({ type: 'tool-call-delta', index: 0, id: 'call_1', name: 'get_weather', argumentsDelta: '{"city"' }, c)
  assert.equal(first.length, 2, '首帧应产出「元信息帧 + 参数帧」')
  const [meta, args] = first
  assert.equal(meta.choices[0].delta.tool_calls[0].id, 'call_1')
  assert.equal(meta.choices[0].delta.tool_calls[0].function.name, 'get_weather')
  assert.equal(meta.choices[0].delta.tool_calls[0].function.arguments, '')
  assert.equal(meta.choices[0].delta.tool_calls[0].index, 0)
  assert.equal(args.choices[0].delta.tool_calls[0].function.arguments, '{"city"')
  assert.equal(args.choices[0].delta.tool_calls[0].id, undefined, '续帧不得重复 id')
  assert.equal(args.choices[0].delta.tool_calls[0].function.name, undefined, '续帧不得重复 name')

  // 第二段增量：与上游 forward.js 一致，续帧发「位置标记帧 + 参数帧」两帧，
  // 但两帧都不得重复 id / name（id/name 只在首帧出现一次）。
  const more = sseEventsForChunk({ type: 'tool-call-delta', index: 0, argumentsDelta: ':"SF"}' }, c)
  assert.equal(more.length, 2, '续帧应为「位置标记 + 参数」两帧')
  for (const frame of more) {
    const call = frame.choices[0].delta.tool_calls[0]
    assert.equal(call.index, 0)
    assert.equal(call.id, undefined, '续帧不得重复 id')
    assert.equal(call.function?.name, undefined, '续帧不得重复 name')
  }
  const argsOnly = more.filter(frame => frame.choices[0].delta.tool_calls[0].function?.arguments)
  assert.equal(argsOnly.length, 1, '参数增量只应出现在一帧里')
  assert.equal(argsOnly[0].choices[0].delta.tool_calls[0].function.arguments, ':"SF"}')
  // 不允许出现空 name 覆盖（那会把已拼好的函数名抹掉）
  assert.equal(more.some(frame => frame.choices[0].delta.tool_calls[0].function?.name === ''), false)
})

test('多工具：index 从 0 顺序分配', () => {
  const c = ctx({ tools: [{ function: { name: 'a' } }, { function: { name: 'b' } }] })
  const a = sseEventsForChunk({ type: 'tool-call-delta', index: 7, id: 'call_a', name: 'a', argumentsDelta: '{}' }, c)
  const b = sseEventsForChunk({ type: 'tool-call-delta', index: 9, id: 'call_b', name: 'b', argumentsDelta: '{}' }, c)
  assert.equal(a[0].choices[0].delta.tool_calls[0].index, 0)
  assert.equal(b[0].choices[0].delta.tool_calls[0].index, 1)
})

test('未声明的指纹工具被丢弃，不发任何帧', () => {
  const c = ctx({ tools: [{ function: { name: 'get_weather' } }] })
  const events = sseEventsForChunk({ type: 'tool-call-delta', index: 0, id: 'call_x', name: 'bash', argumentsDelta: '{"command":"rm -rf /"}' }, c)
  assert.deepEqual(events, [])
})

test('客户端自己声明了 bash 时，bash 是正常工具', () => {
  const c = ctx({ tools: [{ function: { name: 'bash' } }] })
  const events = sseEventsForChunk({ type: 'tool-call-delta', index: 0, id: 'call_b', name: 'bash', argumentsDelta: '{"command":"ls"}' }, c)
  assert.equal(events[0].choices[0].delta.tool_calls[0].function.name, 'bash')
})

test('先流参数、后流名字：片段被扣住，定性后才一次性释放', () => {
  const c = ctx({ tools: [{ function: { name: 'get_weather' } }] })
  const held = sseEventsForChunk({ type: 'tool-call-delta', index: 0, argumentsDelta: '{"city"' }, c)
  assert.deepEqual(held, [], '定性前不得转发参数片段')
  const released = sseEventsForChunk({ type: 'tool-call-delta', index: 1 - 1, id: 'call_1', name: 'get_weather', argumentsDelta: ':"SF"}' }, c)
  assert.equal(released.length, 2)
  assert.equal(released[1].choices[0].delta.tool_calls[0].function.arguments, '{"city":"SF"}', '扣住的片段要合并释放')
})

test('先流参数的诱饵：片段被扣住后整块丢弃，不泄漏', () => {
  const c = ctx({ tools: [{ function: { name: 'get_weather' } }] })
  sseEventsForChunk({ type: 'tool-call-delta', index: 0, argumentsDelta: '{"secret"' }, c)
  const dropped = sseEventsForChunk({ type: 'tool-call-delta', index: 0, id: 'call_x', name: 'grep', argumentsDelta: '}' }, c)
  assert.deepEqual(dropped, [])
})

console.log('usage')

test('usage chunk 换算成 OpenAI 字段', () => {
  const c = ctx({})
  const [event] = sseEventsForChunk({ type: 'usage', usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 2, reasoningTokens: 3 } }, c)
  assert.deepEqual(event.usage, {
    prompt_tokens: 12,
    completion_tokens: 4,
    total_tokens: 16,
    prompt_tokens_details: { cached_tokens: 2 },
    completion_tokens_details: { reasoning_tokens: 3 },
  })
  assert.deepEqual(event.choices, [])
})

test('toOpenAiUsage 对 undefined 返回 undefined', () => {
  assert.equal(toOpenAiUsage(undefined), undefined)
})

console.log('text / reasoning')

test('text-delta 与 reasoning-delta 各自成帧', () => {
  const c = ctx({})
  assert.equal(sseEventsForChunk({ type: 'text-delta', text: '你好' }, c)[0].choices[0].delta.content, '你好')
  assert.equal(sseEventsForChunk({ type: 'reasoning-delta', text: '想' }, c)[0].choices[0].delta.reasoning, '想')
})

test('未知 chunk 类型不产出帧', () => {
  assert.deepEqual(sseEventsForChunk({ type: 'block-end', index: 0, block: {} }, ctx({})), [])
})

console.log('fold')

test('foldForwardOutcome 折叠文本与用量', () => {
  const outcome = { text: '', toolCalls: [], usage: undefined, truncated: false, error: undefined }
  foldForwardOutcome(outcome, { type: 'text-delta', text: 'ab' })
  foldForwardOutcome(outcome, { type: 'text-delta', text: 'c' })
  foldForwardOutcome(outcome, { type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } })
  assert.equal(outcome.text, 'abc')
  assert.equal(outcome.usage.total_tokens, 3)
})

test('foldForwardOutcome 识别截断与错误', () => {
  const outcome = { text: '', toolCalls: [], usage: undefined, truncated: false, error: undefined }
  foldForwardOutcome(outcome, { type: 'finish', reason: { kind: 'max-tokens' } })
  assert.equal(outcome.truncated, true)
  foldForwardOutcome(outcome, { type: 'finish', reason: { kind: 'error', failure: { message: '上游拒绝' } } })
  assert.equal(outcome.error, '上游拒绝')
})

// ---------------------------------------------------------------------------
// 每日签到
// ---------------------------------------------------------------------------
// 渠道包自带的自动签到只在**进程启动后 30 秒**跑一轮，且跑完就写 lastDate、
// 此后再无定时器（原版依赖「用户每天都会打开 DSH」）。网关可能连续跑数周，
// 所以补了每日检查。这里的用例锁定三件事：触发时刻、开关、以及
// **一天最多触发一次**（否则凭据失效时每 60 秒重打一轮上游，把免费额度耗在重试上）。

console.log('每日签到')
const at9 = 9 * 60
const day = (text) => new Date(`2026-10-17T${text}:00`)
const autoState = extra => ({ enabled: true, lastDate: '', running: false, ...extra })

test('日期键与渠道包同口径（本地时区，带前导零）', () => {
  assert.equal(localDateKey(new Date(2026, 9, 7)), '2026-10-07')
  assert.equal(localDateKey(new Date(2026, 11, 31)), '2026-12-31')
})

test('HH:MM 解析：合法值通过，越界与垃圾值返回 undefined', () => {
  assert.equal(parseCheckinAt('09:00'), 540)
  assert.equal(parseCheckinAt('9:05'), 545)
  assert.equal(parseCheckinAt(' 23:59 '), 1439)
  assert.equal(parseCheckinAt('24:00'), undefined)
  assert.equal(parseCheckinAt('09:60'), undefined)
  assert.equal(parseCheckinAt('abc'), undefined)
  assert.equal(parseCheckinAt(''), undefined)
})

test('到点且今天未签 → 触发', () => {
  const decision = shouldCheckinNow({ state: autoState({}), now: day('10:00'), atMinutes: at9, lastTriggeredDate: '' })
  assert.equal(decision.run, true)
})

test('没到点不触发（避免启动就抢跑渠道刷新）', () => {
  const decision = shouldCheckinNow({ state: autoState({}), now: day('08:00'), atMinutes: at9, lastTriggeredDate: '' })
  assert.equal(decision.run, false)
  assert.match(decision.reason, /未到触发时间/)
})

test('今天已完成则不触发', () => {
  const decision = shouldCheckinNow({ state: autoState({ lastDate: '2026-10-17' }), now: day('10:00'), atMinutes: at9, lastTriggeredDate: '' })
  assert.equal(decision.run, false)
})

test('开关关闭则不触发', () => {
  const decision = shouldCheckinNow({ state: autoState({ enabled: false }), now: day('10:00'), atMinutes: at9, lastTriggeredDate: '' })
  assert.equal(decision.run, false)
})

test('本进程今天已触发过 → 不重复触发（失败重试不会每小时打上游）', () => {
  const decision = shouldCheckinNow({ state: autoState({}), now: day('18:00'), atMinutes: at9, lastTriggeredDate: '2026-10-17' })
  assert.equal(decision.run, false)
  assert.match(decision.reason, /已触发过/)
})

test('调度器：到点触发一次，同日再 tick 不重复', async () => {
  const calls = []
  let enabled = true
  const runtime = {
    async rpc(body) {
      calls.push(body)
      if (body.method === 'usage.autoCheckin' && typeof body.payload?.enabled === 'boolean') {
        enabled = body.payload.enabled
        // 模拟渠道包：立刻跑完并写 lastDate
        return { ok: true, value: { autoCheckin: { enabled, lastDate: '2026-10-17', running: false, lastResult: 'qodercn 1 个 +100积分' } } }
      }
      return { ok: true, value: { autoCheckin: { enabled, lastDate: '', running: false } } }
    },
  }
  const scheduler = startCheckinScheduler({
    runtime,
    logger: { info() {}, warn() {} },
    at: '09:00',
    intervalMs: 60 * 60 * 1000,
    now: () => day('10:00'),
  })
  try {
    assert.equal(scheduler.at, '09:00')
    const first = await scheduler.tick()
    assert.equal(first.run, true, '到点且未签应触发')
    assert.equal(calls.length, 2, '一次 tick = 读状态 + 触发')
    assert.equal(calls[1].payload.enabled, true)
    assert.equal(scheduler.status().lastResult, 'qodercn 1 个 +100积分')

    const second = await scheduler.tick()
    assert.equal(second.run, false, '同一天不得再次触发')
    assert.equal(calls.length, 3, '第二次 tick 只读状态')
  } finally {
    scheduler.stop()
  }
})

test('调度器：开关关闭时一次上游都不打', async () => {
  const calls = []
  const runtime = {
    async rpc(body) {
      calls.push(body)
      return { ok: true, value: { autoCheckin: { enabled: false, lastDate: '', running: false } } }
    },
  }
  const scheduler = startCheckinScheduler({ runtime, logger: { info() {}, warn() {} }, at: '09:00', now: () => day('10:00') })
  try {
    const decision = await scheduler.tick()
    assert.equal(decision.run, false)
    assert.equal(calls.length, 1, '只读状态，不触发签到')
  } finally {
    scheduler.stop()
  }
})

test('一次性签到：常驻网关在跑时应当跳过（避免两个进程写同一份状态）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-pid-'))
  try {
    assert.equal(gatewayPidAlive(dir), false, '没有 gw.pid 视为没在跑')
    fs.writeFileSync(path.join(dir, 'gw.pid'), String(process.pid))
    assert.equal(gatewayPidAlive(dir), true, '当前进程的 PID 应当算存活')
    // 已死的进程：探测函数说不在就不在
    assert.equal(gatewayPidAlive(dir, () => false), false)
    fs.writeFileSync(path.join(dir, 'gw.pid'), 'not-a-pid')
    assert.equal(gatewayPidAlive(dir), false, 'pid 文件内容是垃圾时视为没在跑')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('一次性签到：今天已完成则不打扰上游', async () => {
  const calls = []
  const runtime = {
    async rpc(body) {
      calls.push(body.method)
      return { ok: true, value: { autoCheckin: { enabled: true, lastDate: '2026-10-17', running: false, lastResult: '今天已签' } } }
    },
  }
  const result = await runCheckinOnce({ runtime, logger: { info() {} }, now: () => day('10:00') })
  assert.equal(result.outcome, 'already-done')
  assert.deepEqual(calls, ['usage.autoCheckin'], '只读一次状态，不触发签到')
})

test('一次性签到：未完成时触发一轮并带上结果', async () => {
  const calls = []
  let triggered = false
  const runtime = {
    async rpc(body) {
      calls.push(body.method)
      if (body.payload?.enabled === true) triggered = true
      return {
        ok: true,
        value: {
          autoCheckin: triggered
            ? { enabled: true, lastDate: '2026-10-17', running: false, lastAt: 222, lastResult: 'qodercn 1 个 +100积分' }
            : { enabled: true, lastDate: '', running: false, lastAt: 111 },
        },
      }
    },
  }
  const result = await runCheckinOnce({ runtime, logger: { info() {} }, now: () => day('10:00') })
  assert.equal(result.outcome, 'ran')
  assert.match(result.state.lastResult, /\+100积分/)
  assert.equal(calls.filter(name => name === 'usage.autoCheckin').length, 3, '读一次 + 触发一次 + 读一次结果')
})

test('一次性签到：渠道包给不出确定结果时如实报 inconclusive', async () => {
  const runtime = {
    async rpc(body) {
      // 触发后 lastDate 仍为空、lastAt 未变 —— 渠道包在「没证明今天领过」时的形态
      if (body.payload?.enabled === true) return { ok: true, value: { autoCheckin: { enabled: true, running: false } } }
      return { ok: true, value: { autoCheckin: { enabled: true, lastDate: '', running: false, lastAt: 5 } } }
    },
  }
  const result = await runCheckinOnce({ runtime, logger: { info() {} }, now: () => day('10:00'), waitMs: 0 })
  assert.equal(result.outcome, 'inconclusive')
})

// ---------------------------------------------------------------------------
// 逐渠道结果归类(界面上的「已领取」判定)
//
// 渠道包只给一句中文,所以只能按措辞归类。这里把**真实见过**的六种措辞钉死,
// 并锁住两条容易做过头的行为:失败/未开启/无接口不算已领,zcode 手动签到保留可点。
// ---------------------------------------------------------------------------
test('归类:真实措辞各归各位', () => {
  assert.deepEqual(classifyCheckinText('1 个今天已领').flags, ['claimed'])
  assert.deepEqual(classifyCheckinText('1 个 +100 积分').flags, ['claimed-now'])
  assert.deepEqual(classifyCheckinText('1 个失败').flags, ['failed'])
  assert.deepEqual(classifyCheckinText('1 个未开启').flags, ['inactive'])
  assert.deepEqual(classifyCheckinText('无签到接口').flags, ['unsupported'])
  assert.deepEqual(classifyCheckinText('需手动签到').flags, ['manual'])
})

test('归类:只有真领到过才算 claimed', () => {
  assert.equal(classifyCheckinText('1 个今天已领').claimed, true)
  assert.equal(classifyCheckinText('1 个 +100 积分').claimed, true)
  for (const text of ['1 个失败', '1 个未开启', '无签到接口', '需手动签到', '']) {
    assert.equal(classifyCheckinText(text).claimed, false, `「${text}」不该算已领`)
  }
})

test('归类:多渠道混在一句里时两种「领到」都认', () => {
  const flags = classifyCheckinText('2 个 +100 积分,3 个今天已领').flags
  assert.deepEqual(flags, ['claimed', 'claimed-now'])
  assert.equal(classifyCheckinText('2 个 +100 积分,3 个今天已领').claimed, true)
})

test('归类:措辞改了只退化成 unknown,原文仍原样带回', () => {
  const result = classifyCheckinText('渠道换了个说法')
  assert.deepEqual(result.flags, [])
  assert.equal(result.claimed, false)
  assert.equal(result.text, '渠道换了个说法', '界面显示的是原文,归类失败不能吃掉它')
  assert.equal(classifyCheckinText(undefined).text, '')
})

console.log('')
if (failures.length > 0) {
  console.log(`${failures.length} 项失败，${passed} 项通过`)
  process.exitCode = 1
} else {
  console.log(`全部通过：${passed} 项`)
}
