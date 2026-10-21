import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { foldForwardOutcome } from './fold.mjs'

/** 一实例一 Worker，避免原渠道业务的模块单例串目录、串账号。 */
export async function createChannelRuntime({ dataDir, logger = console, stats }) {
  const worker = new Worker(new URL('./worker.mjs', import.meta.url), {
    workerData: { dataDir },
    execArgv: process.execArgv.filter(arg => !arg.startsWith('--input-type')),
    env: { ...process.env, OFM_CODEARTS_CACHE_DIR: path.join(dataDir, 'channel-pack', 'codearts-cache') },
  })
  const pending = new Map()
  let sequence = 0
  let closed = false
  let closing
  let rows = []
  let providers = []
  let refreshing
  let refreshTimer
  let finishClose
  let failed
  let readyResolve, readyReject
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject })
  const rejectAll = error => {
    failed = error
    readyReject(error)
    for (const entry of pending.values()) entry.reject(error)
    pending.clear()
  }
  worker.on('error', rejectAll)
  worker.on('exit', code => {
    if (!closed) rejectAll(new Error(`渠道进程已退出（${code}）`))
    finishClose?.()
  })
  worker.on('message', message => {
    if (message.type === 'ready') { providers = message.providers; readyResolve(); return }
    if (message.type === 'log') { logger[message.level]?.(message.message); return }
    if (message.type === 'closed') { finishClose?.(); return }
    if (message.type === 'changed') {
      if (closed) return
      clearTimeout(refreshTimer)
      refreshTimer = setTimeout(() => { void refresh().catch(error => logger.warn?.(`渠道目录刷新失败：${error.message}`)) }, 200)
      refreshTimer.unref?.()
      return
    }
    const entry = pending.get(message.id)
    if (!entry) return
    if (message.type === 'chunk') {
      try { entry.onChunk?.(message.chunk) } catch (error) { entry.reject(error); worker.postMessage({ type: 'cancel', id: message.id }) }
    } else if (message.type === 'error') entry.reject(Object.assign(new Error(message.message), { statusCode: message.statusCode }))
    else entry.resolve(message.value)
  })
  function call(type, payload = {}, signal, onChunk, timeoutMs = 120000) {
    if (closed || failed) return Promise.reject(failed ?? new Error('渠道已停止'))
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('请求已取消'))
    const id = ++sequence
    return new Promise((resolve, reject) => {
      const finish = fn => value => { clearTimeout(timer); signal?.removeEventListener('abort', abort); pending.delete(id); fn(value) }
      const abort = () => {
        worker.postMessage({ type: 'cancel', id })
        entry.reject(signal?.reason ?? new Error('渠道请求超时或已取消'))
      }
      const timer = setTimeout(abort, timeoutMs)
      timer.unref?.()
      const entry = { resolve: finish(resolve), reject: finish(reject), onChunk }
      pending.set(id, entry)
      signal?.addEventListener('abort', abort, { once: true })
      worker.postMessage({ type, id, ...payload })
    })
  }
  function refresh() {
    if (refreshing) return refreshing
    refreshing = call('models').then(value => { rows = value; return rows }).finally(() => { refreshing = undefined })
    return refreshing
  }
  const runtime = {
    get providers() { return providers },
    state() { return { state: failed ? 'failed' : 'ready', error: failed ? failed.message : '' } },
    publicModelRows: () => rows,
    refresh,
    handles: model => providers.some(provider => model.startsWith(`${provider}/`)),
    async rpc(body, signal) {
      if (typeof body?.method !== 'string' || !Object.hasOwn(body, 'payload')) throw Object.assign(new Error('渠道请求缺少 method 或 payload'), { statusCode: 400 })
      return call('rpc', { call: { method: body.method, payload: body.payload } }, signal, undefined, 10 * 60000)
    },
    async complete(request, onChunk) {
      const outcome = { text: '', toolCalls: [], usage: undefined, truncated: false, error: undefined }
      const started = Date.now()
      let first = 0
      let ok = false
      try {
        const { signal, ...wire } = request
        await call('complete', { request: wire }, signal, chunk => {
          if (!first) first = Date.now()
          foldForwardOutcome(outcome, chunk)
          onChunk?.(chunk)
        }, 30 * 60000)
        ok = outcome.error === undefined
        return outcome
      } finally {
        // 剥离版不采集用量统计（原版在 stats 存在时写入 recordUsage/recordTurn）。
      }
    },
    close() {
      if (closing) return closing
      closed = true
      clearTimeout(refreshTimer)
      rejectAll(new Error('渠道正在停止'))
      closing = (async () => {
        let timer
        await new Promise(resolve => {
          finishClose = resolve
          worker.postMessage({ type: 'close' })
          timer = setTimeout(resolve, 1500)
        })
        clearTimeout(timer)
        await worker.terminate()
      })()
      return closing
    },
  }
  try {
    const timeout = setTimeout(() => readyReject(new Error('渠道初始化超时')), 30000)
    try { await ready } finally { clearTimeout(timeout) }
    runtime.ready = refresh().catch(error => { if (!closed) logger.warn?.(`渠道启动清单刷新失败：${error.message}`) })
    return runtime
  } catch (error) { await runtime.close(); throw error }
}
