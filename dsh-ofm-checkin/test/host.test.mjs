/**
 * dsh-ofm-checkin 宿主半身单测 —— 自足:不依赖 DSH,也不依赖网关在跑。
 *
 * 覆盖的是**最容易错**的几处:
 *   1. RPC 方法白名单 —— 白名单外的必须被拒(否则界面上一次笔误就能调用渠道包的任意方法)
 *   2. 请求体大小上限 —— 超限返回 413 而不是把宿主拖垮
 *   3. 「网关没跑」必须被归类成**离线**而不是业务错误(界面据此显示横幅与启动按钮)
 *   4. 路径发现 —— 找不到网关时必须返回空串,而不是一个会误导用户的假路径
 *
 * 运行:node test/host.test.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let passed = 0
const failures = []
const pending = []

/**
 * 跑一个用例。支持 async body —— 断言失败会**在用例内**被捕获并记账,
 * 而不是变成一个游离的未捕获 Promise rejection(那样测试进程会以
 * 「看起来通过了」的状态退出,是最容易骗过人的一种失败)。
 *
 * 用例**串行**执行:它们都要替换 globalThis.fetch,并发跑会互相覆盖,
 * 让「这个请求到底打到了网关没有」这种断言变成随机的。
 */
function test(name, body) {
  const run = async () => {
    try { await body(); passed++; console.log(`  ok  ${name}`) }
    catch (error) { failures.push({ name, error }); console.log(`FAIL  ${name}\n      ${error.message}`) }
  }
  pending.push(pending.length === 0 ? run() : pending[pending.length - 1].then(run))
}

console.log('模块加载')

const mod = await import('../index.js')

test('导出 name / inject / REVISION', () => {
  assert.equal(mod.name, 'ofm-checkin')
  assert.ok(Array.isArray(mod.inject))
  assert.equal(typeof mod.REVISION, 'number')
})

test('readGatewayKey 读不到时返回空串而不是抛错', () => {
  const key = mod.readGatewayKey(path.join(os.tmpdir(), 'ofm-test-no-such-dir-xyz'))
  assert.equal(key, '')
})

test('readGatewayKey 读到 forwardKey 时原样返回', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-test-'))
  try {
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ forwardKey: 'test-key-123' }))
    assert.equal(mod.readGatewayKey(dir), 'test-key-123')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

console.log('网关路径发现')

test('找不到网关时返回空串(而不是一个不存在的假路径)', () => {
  const saved = process.env.OFM_GATEWAY_DIR
  process.env.OFM_GATEWAY_DIR = path.join(os.tmpdir(), 'ofm-test-no-such-dir-xyz')
  try {
    const start = mod.defaultStartScript()
    const sync = mod.defaultSyncScript()
    assert.equal(typeof start, 'string')
    assert.equal(typeof sync, 'string')
    assert.ok(!start.includes('ofm-test-no-such-dir-xyz'), 'start 不应命中不存在的目录')
    assert.ok(!sync.includes('ofm-test-no-such-dir-xyz'), 'sync 不应命中不存在的目录')
  } finally {
    if (saved === undefined) delete process.env.OFM_GATEWAY_DIR
    else process.env.OFM_GATEWAY_DIR = saved
  }
})

console.log('宿主路由')

/** 自造 req/res,驱动 index.js 注册的路由处理器。 */
function makeReqRes(method, url, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  const req = {
    method,
    url,
    headers: { 'content-type': 'application/json' },
    on(event, handler) {
      if (event === 'data') for (const c of chunks) handler(c)
      if (event === 'end') handler()
      return req
    },
    destroy() {},
  }
  let resolveDone
  const done = new Promise(resolve => { resolveDone = resolve })
  const res = {
    statusCode: null,
    body: null,
    writeHead(status) { this.statusCode = status; return this },
    end(payload) { this.body = payload === undefined ? null : JSON.parse(payload); resolveDone(this) },
  }
  return { req, res, done }
}

/**
 * 起一个最小的 ctx,让 index.js 的 apply() 注册路由。
 * fetch 被替换成可编排的桩,避免真的去连网关。
 */
/**
 * 起一个最小的 ctx,让 index.js 的 apply() 注册路由。
 *
 * fetch 被替换成可编排的桩,避免真的去连网关。桩**必须活到请求结束** ——
 * 路由处理是异步的。所以这里返回一个带 withFetch() 的上下文:
 * 用它把桩套在某个作用域里跑完再还原,避免多个用例之间互相污染
 * (本机可能真的有网关在跑,原生 fetch 会连上它,让「离线」用例假通过)。
 */
async function makeCtx() {
  const registered = []
  const server = {
    register(spec) { registered.push(spec); return () => {} },
  }
  const ctx = {
    inject(names, callback) {
      // 模拟 DSH 的注入:同步回调一次,拿到带 webServer 的作用域。
      // effect 必须**执行**回调 —— index.js 是靠 scoped.effect(...) 里的
      // server.register(...) 真正注册路由的。
      const scoped = Object.assign(Object.create(ctx), {
        webServer: server,
        effect(fn) { const disposer = fn(); return typeof disposer === 'function' ? disposer : () => {} },
      })
      callback(scoped)
    },
    effect(fn) { const disposer = fn(); return typeof disposer === 'function' ? disposer : () => {} },
  }
  mod.apply(ctx, { gatewayUrl: 'http://127.0.0.1:18900', apiKey: 'test-key' })
  const spec = registered.find(r => r?.kind === 'prefix')
  assert.ok(spec, '应注册一个 prefix 路由')

  /** 在桩生效的范围内执行 fn,结束后必定还原 globalThis.fetch。 */
  return async function withFetch(fetchImpl, fn) {
    const originalFetch = globalThis.fetch
    globalThis.fetch = fetchImpl
    try {
      return await fn(spec.handler)
    } finally {
      globalThis.fetch = originalFetch
    }
  }
}

test('注册的是 prefix 路由,路径为 /api/ofm-checkin', async () => {
  const registered = []
  const ctx = {
    inject(names, callback) {
      callback(Object.assign(Object.create(ctx), {
        webServer: { register(spec) { registered.push(spec); return () => {} } },
        effect(fn) { const disposer = fn(); return typeof disposer === 'function' ? disposer : () => {} },
      }))
    },
    effect(fn) { const disposer = fn(); return typeof disposer === 'function' ? disposer : () => {} },
  }
  mod.apply(ctx, { gatewayUrl: 'http://127.0.0.1:18900', apiKey: 'k' })
  const spec = registered.find(r => r?.kind === 'prefix')
  assert.ok(spec, '应注册 prefix 路由')
  assert.equal(spec.path, '/api/ofm-checkin')
  assert.equal(typeof spec.handler, 'function')
})

test('RPC 白名单外的方法被拒(400),白名单内的放行', async () => {
  let forwarded = null
  const withFetch = await makeCtx()
  await withFetch(async (url, init) => {
    forwarded = { url: String(url), body: init?.body }
    return new Response(JSON.stringify({ ok: true, value: {} }), { status: 200 })
  }, async (handler) => {
    // 白名单外
    const bad = makeReqRes('POST', '/api/ofm-checkin/rpc', { method: 'account.purgeEverything' })
    handler(bad.req, bad.res)
    const badRes = await bad.done
    assert.equal(badRes.statusCode, 400, '白名单外的方法必须被拒')
    assert.ok(badRes.body?.error, '应带错误说明')
    assert.equal(forwarded, null, '被拒的请求不应打到网关')

    // 白名单内
    const good = makeReqRes('POST', '/api/ofm-checkin/rpc', { method: 'provider.status', payload: { providers: ['codearts'] } })
    handler(good.req, good.res)
    const goodRes = await good.done
    assert.equal(goodRes.statusCode, 200, '白名单内的方法应放行')
    assert.ok(forwarded !== null, '放行的请求应打到网关')
    assert.ok(String(forwarded.url).endsWith('/rpc'), `应转到网关的 /rpc,实际: ${forwarded.url}`)
  })
})

test('请求体超过上限返回 413', async () => {
  const withFetch = await makeCtx()
  await withFetch(async () => new Response('{}', { status: 200 }), async (handler) => {
    const huge = { method: 'provider.status', payload: { padding: 'x'.repeat(70 * 1024) } }
    const req = makeReqRes('POST', '/api/ofm-checkin/rpc', huge)
    handler(req.req, req.res)
    const res = await req.done
    assert.equal(res.statusCode, 413, '超限请求体应返回 413')
  })
})

test('网关连不上时 /health 仍返回 200 并标记离线', async () => {
  const withFetch = await makeCtx()
  await withFetch(async () => { throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) }, async (handler) => {
    const req = makeReqRes('GET', '/api/ofm-checkin/health')
    handler(req.req, req.res)
    const res = await req.done
    assert.equal(res.statusCode, 200, '「网关没跑」对界面是正常情报,不是请求失败')
    assert.equal(res.body?.up, false, '应标记为离线')
    assert.ok(res.body?.error, '应说明离线原因')
    assert.equal(typeof res.body?.revision, 'number', '应回显版本戳')
  })
})

test('健康时 /health 标记 up', async () => {
  const withFetch = await makeCtx()
  await withFetch(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }), async (handler) => {
    const req = makeReqRes('GET', '/api/ofm-checkin/health')
    handler(req.req, req.res)
    const res = await req.done
    assert.equal(res.statusCode, 200)
    assert.equal(res.body?.up, true)
  })
})

test('未知接口返回 404', async () => {
  const withFetch = await makeCtx()
  await withFetch(async () => new Response('{}', { status: 200 }), async (handler) => {
    const req = makeReqRes('GET', '/api/ofm-checkin/nope')
    handler(req.req, req.res)
    const res = await req.done
    assert.equal(res.statusCode, 404)
  })
})

// 等所有用例跑完再汇总 —— 用例是 async 的,提前汇总会漏掉还没跑的断言。
await Promise.all(pending)

console.log(`\n${passed} 项通过，${failures.length} 项失败`)
if (failures.length > 0) {
  for (const f of failures) console.error(`\n${f.name}\n${f.error.stack}`)
  process.exitCode = 1
}
