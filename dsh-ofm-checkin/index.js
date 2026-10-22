/**
 * DSH 每日签到 — 宿主半身。
 *
 * 只做一件事：把本机 ofm-free-gateway 的签到能力，以**同源** `/api/ofm-checkin/*`
 * 暴露给浏览器半身。
 *
 * 为什么是代理而不是自己签到：
 *   OAuth 刷新令牌是一次性的，两个进程各自持有同一账号时会互相消耗（实测华为 CodeArts
 *   报 `STS5.1806 invalid refresh token: 'the refresh token has been used'`）。
 *   所以**凭证只由网关独占**，本插件从不加载渠道、不读 `.credentials.yaml`。
 *   顺带好处：浏览器里不出现网关密钥，也不需要 CORS。
 *
 * 依赖：只有 `node:` 内置模块与全局 `fetch`，不 import 任何 `@deepseek-ai/*`。
 *
 * @module index.js
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const name = 'ofm-checkin'

/** 没有硬依赖：拿不到 webServer 时只是没有界面，不影响 DSH 其余部分。 */
export const inject = []

const PREFIX = '/api/ofm-checkin'
const DEFAULT_GATEWAY = 'http://127.0.0.1:18900'
const BODY_LIMIT = 64 * 1024

/**
 * 宿主半身的版本戳,由 `/health` 回显。
 *
 * 用处很具体:插件是**宿主进程启动时**加载的,直接改文件未必生效 —— 页面上
 * 看到的 revision 比源码里的小,就说明该重启 DSH 了。省掉"我明明改了怎么没用"
 * 的那一轮排查。
 */
export const REVISION = 7

/**
 * 网关启动脚本的候选路径。
 *
 * 刻意**不**只从 import.meta.url 往上推:插件在 profile 里是 Junction(或 file: 依赖),
 * 模块 URL 指向的是 ...\node_modules\dsh-ofm-checkin\index.js,而网关**不在**那旁边 ——
 * 推出来会是 ...\node_modules\ofm-free-gateway\start.bat,一个不存在的路径。
 *
 * 所以按「几种已知的真实位置」列一份清单,取第一个存在的:
 *   1. 环境变量 OFM_GATEWAY_DIR —— 显式指定,优先级最高;
 *   2. 插件目录的**兄弟目录**(同一份插件合集里克隆时最常见);
 *   3. 用户主目录下的常见位置。
 *
 * 要覆盖就在 cordis.patch.yml 的 config 里写 startScript / syncScript,优先级最高。
 */
const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url))

/** 网关目录的候选位置,按优先级排列。 */
function gatewayDirCandidates() {
  const candidates = []
  const fromEnv = typeof process.env.OFM_GATEWAY_DIR === 'string' ? process.env.OFM_GATEWAY_DIR.trim() : ''
  if (fromEnv !== '') candidates.push(fromEnv)
  // 插件目录的兄弟目录:与本插件同一份合集里时,网关就在隔壁。
  candidates.push(path.resolve(PLUGIN_DIR, '..', 'dsh-ofm-free-gateway'))
  candidates.push(path.resolve(PLUGIN_DIR, '..', 'ofm-free-gateway'))
  candidates.push(path.join(os.homedir(), 'dsh-ofm-free-gateway'))
  candidates.push(path.join(os.homedir(), 'ofm-free-gateway'))
  return candidates
}

/** 网关启动脚本的候选路径。 */
function startScriptCandidates() {
  return gatewayDirCandidates().map(dir => path.join(dir, 'start.bat'))
}

/** 依次找存在的那个;都没有就返回空串(界面据此提示「找不到启动脚本」)。 */
export function defaultStartScript() {
  for (const candidate of startScriptCandidates()) {
    try { if (fs.existsSync(candidate)) return candidate } catch { /* 盘符不存在等情况直接跳过 */ }
  }
  return ''
}

/**
 * DSH 的模型列表是**快照**,不是动态查询。
 *
 * llm-pi-ai 的源码把这件事写得很直白:
 *
 *     cordis.patch.yml remains the only thing that decides what a route serves.
 *
 * 也就是说,模型选择器里出现哪些条目,只取决于 `cordis.patch.yml` 里静态写了
 * 什么;DSH 在运行时**不会**去问网关「你现在有哪些模型」。那个 `GET /v1/models`
 * 探测(设置页的「获取模型」按钮)只是给用户往配置里挑条目用的,不是刷新机制。
 *
 * 于是「在插件里点了启用/停用」与「DSH 里的条目」之间天然会脱节 —— 脱节的
 * 表现就是:只启用了一个模型,列表里却还留着上一次快照的全部条目。
 *
 * 这段自动同步就是补这条缝:每次会改变「可路由模型集合」的 RPC 成功后,后台
 * 重跑注册脚本,让 ofmfree 段始终等于「当前真正可路由的模型」。
 *
 * 仍有一个绕不过去的前提:DSH 只在**启动时**读这份配置,所以同步完还是要重启
 * DSH 才会生效。同步只保证「重启后看到的一定是对的」。
 */
/** 模型同步脚本的候选路径(与网关目录同源)。 */
function syncScriptCandidates() {
  return gatewayDirCandidates().map(dir => path.join(dir, 'scripts', 'make-dsh-provider.mjs'))
}

/** 依次找存在的那个;都没有就返回空串。 */
export function defaultSyncScript() {
  for (const candidate of syncScriptCandidates()) {
    try { if (fs.existsSync(candidate)) return candidate } catch { /* 盘符不存在等情况直接跳过 */ }
  }
  return ''
}

/**
 * 会改变「可路由模型集合」的方法 —— 只有这些才值得重写配置。
 *
 * 模型级启停(`model.*`)、渠道级启停(`*.setEnabled`)当然算;账号的增删(`account.create`
 * / `account.delete`)与**启停**(`account.update` 的 enabled 补丁)也算,因为「渠道有
 * 可用的账号」才谈得上可路由 —— 停用最后一个账号和删掉它,对 `/v1/models` 的
 * `x-provider-ready` 是一回事。而 `credits.claimAll` / `account.refresh` 不改变集合,
 * 同步它没意义。
 *
 * 注意 `login.poll` **不**在这里 —— 它的 `done:true` 才是「凭据落地、新账号的模型
 * 从不可路由变可路由」的时刻(`account.create` 那一下还只是占位账号),所以单独在
 * /rpc 处理里按返回值判断,见下。
 */
const MODEL_MUTATIONS = new Set([
  'model.setDisabled', 'model.setDisabledMany', 'model.setAllDisabled', 'model.clearDead',
  'gateway.setEnabled', 'provider.setEnabled',
  'account.create', 'account.delete', 'account.update',
])

/**
 * 允许浏览器半身调用的渠道 RPC —— **白名单**。
 *
 * 界面上的每个按钮都对应渠道包自己的一个方法(添加账号 / 续期 / 启停模型 / 领积分),
 * 所以必须有一条通用通道;但不能变成「转发任意方法」,否则界面上的一个笔误就能调用
 * 包里任何东西。这里的清单就是界面真正会用到的那些。
 */
const RPC_METHODS = new Set([
  'provider.status', 'provider.setEnabled', 'provider.setOrder',
  'account.list', 'account.create', 'account.delete', 'account.refresh', 'account.update',
  'account.test', 'account.retest', 'account.reset',
  'login.poll', 'login.sendSms', 'login.submitSms',
  'model.list', 'model.setDisabled', 'model.setDisabledMany', 'model.setAllDisabled', 'model.clearDead',
  'credits.balances', 'credits.claimAll', 'credits.status',
  'gateway.getEnabled', 'gateway.setEnabled',
  'usage.autoCheckin', 'usage.badge',
])

/**
 * 网关的 API 密钥默认从网关自己的 settings.json 里读（`forwardKey`）。
 *
 * 这样密钥只存在于网关的数据目录里，不需要在 profile 的 cordis.patch.yml 里再写一份。
 * 读不到就返回空串，让网关用 401 明确回答，而不是在这里抛错。
 */
export function readGatewayKey(dataDir = path.join(os.homedir(), '.ofm-free-gateway')) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'))
    return typeof parsed?.forwardKey === 'string' ? parsed.forwardKey : ''
  } catch {
    return ''
  }
}

function send(res, status, payload) {
  const body = JSON.stringify(payload ?? null)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

/** 读请求体，带大小上限；空体返回 undefined 而不是抛错。 */
function readJson(req, limitBytes = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > limitBytes) {
        const error = new Error(`请求体超过 ${limitBytes} 字节`)
        error.statusCode = 413
        req.destroy()
        reject(error)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') return resolve(undefined)
      try {
        resolve(JSON.parse(text))
      } catch {
        const error = new Error('请求体不是合法 JSON')
        error.statusCode = 400
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

/** 把底层网络错误翻译成界面上能看懂的一句话 —— 「网关没跑」是最常见的状态。 */
function explain(error) {
  if (error?.name === 'AbortError') return '网关响应超时'
  const code = error?.cause?.code ?? error?.code
  if (code === 'ECONNREFUSED') return '网关没有运行'
  if (code === 'ECONNRESET') return '与网关的连接被重置'
  return error?.message ?? String(error)
}

/**
 * 把错误值统一成**一句字符串**。
 *
 * 网关的业务错误可能是对象(`{message,type,code}`,OpenAI 风格),绝不能原样
 * 透传给界面 —— 浏览器半身把它当 React 子节点渲染时会直接抛
 * "Objects are not valid as a React child",整个设置分区崩溃成空白
 * (2026-10-22 实测:网关换了密钥回 401,页面就成了白板)。
 */
export function errorMessage(value, fallback = '') {
  if (typeof value === 'string') return value === '' ? fallback : value
  const message = value?.message
  if (typeof message === 'string' && message !== '') return message
  if (value === null || value === undefined) return fallback
  const text = String(value)
  return text === '' || text === '[object Object]' ? fallback : text
}

/**
 * 「网关没跑」的判据 —— 界面靠这个把「先启动网关」与「网关在跑但出错了」分开。
 *
 * 只有连接层失败（`callGateway` 把网络异常统一成 503 + `error`）才算没跑；
 * 网关自己回的业务错误必须原样呈现，不能被误判成需要启动。
 */
export function isGatewayDown(body) {
  const message = errorMessage(body?.error)
  return /网关没有运行|与网关的连接被重置|无法连接|ECONNREFUSED|ECONNRESET|fetch failed/i.test(message)
}

/**
 * 启动网关。
 *
 * 刻意**分离启动**(detached + unref + 忽略 stdio),因为网关是**常驻**进程,
 * 生命周期必须比发起它的这次 HTTP 请求长:否则请求一结束,子进程会跟着被回收。
 *
 * 两处必须小心的地方,都是实测踩出来的:
 *
 *   1. **必须监听 error**。spawn 的失败是**异步**的:找不到可执行文件、cwd 不存在
 *      等等,都会在 spawn 之后才 emit error。Node 对没有 error 监听的 ChildProcess
 *      直接抛未捕获异常 —— 那会**把整个 DSH 进程带走**。
 *      所以这里等一个 spawn/error 的赛跑,把失败变成一句可显示的文案。
 *
 *   2. **cwd 必须存在**。cwd 不存在时报的错是 `spawn <exe> ENOENT`,看起来像
 *      "找不到 cmd.exe",极难排查。所以先验证 cwd,不合法就交给 Node 用默认工作目录。
 *
 *   3. **dataDir 必须跟着走**(2026-10-22 实测踩坑)。start.bat 在没有参数与
 *      OFM_HOME 时,默认用「网关目录旁的 .ofm-free-gateway」当数据目录 —— 而插件
 *      读密钥按的是 config.dataDir。两边一旦不一致,网关在错误目录里生成一份新
 *      密钥,插件拿旧密钥全部 401,界面整页报错。所以配置了 dataDir 时,把它作为
 *      `--data-dir` 参数传给 start.bat(start.bat 原生解析),并同时设 OFM_HOME,
 *      让 server.mjs 与所有脚本都落在同一份目录上。
 *
 * 返回 {ok, pid, via, error};ok:false 时 error 可直接显示给用户。
 */
export function launchGateway({ script, command, cwd, dataDir }) {
  // cwd 不存在会导致上面第 2 条那种误导性的 ENOENT,先挡掉。
  let workdir = cwd
  try {
    if (typeof workdir !== 'string' || workdir === '' || !fs.existsSync(workdir)) workdir = undefined
  } catch { workdir = undefined }

  const useCommand = typeof command === 'string' && command !== ''
  if (!useCommand && !fs.existsSync(script)) {
    return Promise.resolve({ ok: false, error: `找不到网关启动脚本:${script}` })
  }

  const home = typeof dataDir === 'string' && dataDir !== '' ? dataDir : undefined

  // .bat/.cmd 必须经 cmd.exe;直接 spawn 会 EINVAL。
  const isBatch = !useCommand && /\.(bat|cmd)$/i.test(script)
  const file = useCommand ? command : (isBatch ? (process.env.ComSpec || 'cmd.exe') : script)
  // --data-dir 只对「脚本」这一路追加:start.bat 与 server.mjs 都原生解析它。
  // startCommand 是用户拼好的整条命令,不往里塞参数(env 里的 OFM_HOME 仍会生效)。
  const args = useCommand
    ? []
    : isBatch
      ? (home !== undefined ? ['/c', script, '--data-dir', home] : ['/c', script])
      : (home !== undefined ? ['--data-dir', home] : [])

  return new Promise(resolve => {
    let child
    try {
      child = spawn(file, args, {
        cwd: workdir,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        ...(home !== undefined ? { env: { ...process.env, OFM_HOME: home } } : {}),
        ...(useCommand ? { shell: true } : {}),
      })
    } catch (error) {
      resolve({ ok: false, error: `启动网关失败:${error?.message ?? String(error)}` })
      return
    }

    let settled = false
    const settle = payload => { if (!settled) { settled = true; resolve(payload) } }

    // 第 1 条:没有这个监听,spawn 失败会掀掉整个进程。
    child.once('error', error => {
      const hint = error?.code === 'ENOENT' ? `找不到可执行文件(${file})` : (error?.message ?? String(error))
      settle({ ok: false, error: `启动网关失败:${hint}` })
    })
    child.once('spawn', () => {
      child.unref()
      settle({ ok: true, pid: child.pid ?? null, via: useCommand ? command : script })
    })
  })
}

/** 轮询网关直到它应答(或超时),这样界面点完「启动」不必自己算时间。 */
async function waitForGateway(probe, timeoutMs = 25_000, intervalMs = 700) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const result = await probe()
    if (result.status === 200) return true
    if (!isGatewayDown(result.body) && result.status !== 503) return true
    if (Date.now() >= deadline) return false
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
}

export function apply(ctx, config) {
  const gatewayUrl = String(config?.gatewayUrl ?? DEFAULT_GATEWAY).replace(/\/+$/, '')
  const configuredKey = typeof config?.apiKey === 'string' ? config.apiKey : ''
  const dataDir = typeof config?.dataDir === 'string' && config.dataDir !== '' ? config.dataDir : undefined
  const apiKey = () => configuredKey || readGatewayKey(dataDir)

  const startScript = typeof config?.startScript === 'string' && config.startScript !== ''
    ? config.startScript
    : defaultStartScript()
  const startCommand = typeof config?.startCommand === 'string' ? config.startCommand : ''
  // 找不到启动脚本时 startScript 为空串,path.dirname('') 会得到 '.' —— 那种情况下别把 cwd 设成 '.'。
  const startCwd = startScript !== '' ? path.dirname(startScript) : undefined
  // 等网关应答的上限。首次启动要加载 13 个渠道,默认 25 秒;测试里可以调小。
  const startTimeoutMs = Number.isFinite(config?.startTimeoutMs) && config.startTimeoutMs > 0
    ? Number(config.startTimeoutMs)
    : 25_000

  /** 同一时刻只允许一次启动尝试,避免连点开出一堆网关进程抢同一份渠道状态。 */
  let starting = null

  /**
   * 启动网关并等它应答 —— **幂等**:先探活,已经在跑就绝不 spawn 第二个
   * (两个网关会各自起一个渠道 Worker、写同一份 `channel-pack/*.json`,
   * 互相把对方的刷新令牌用掉)。
   *
   * 「点按钮」与「DSH 启动时自动拉起」共用这一份逻辑,所以两条路不会打架:
   * 同一时刻只有一个 in-flight,后来的调用直接复用它的结果。
   */
  function startGatewayOnce() {
    if (starting !== null) return starting
    const run = (async () => {
      const already = await callGateway('/checkin', undefined, 6_000)
      if (already.status === 200) return { ok: true, already: true, via: null }
      const launched = await launchGateway({ script: startScript, command: startCommand, cwd: startCwd, dataDir })
      if (launched.ok !== true) return { ok: false, error: launched.error }
      const up = await waitForGateway(() => callGateway('/checkin', undefined, 6_000), startTimeoutMs)
      return up
        ? { ok: true, pid: launched.pid, via: launched.via }
        : { ok: false, error: `启动命令已执行,但网关在 ${Math.round(startTimeoutMs / 1000)} 秒内没有应答 —— 看网关自己的日志(数据目录里的 gw.err)。`, via: launched.via }
    })()
    // 单飞守卫的复位必须放在赋值**之后**(同 runRouteSync 那段):run 在构造器里
    // 就已结算时,若在内部复位会被下面这行盖回去,守卫会卡在一个旧 Promise 上。
    starting = run
    const release = () => { if (starting === run) starting = null }
    run.then(release, release)
    return run
  }

  // -------------------------------------------------------------------------
  // 模型列表自动同步(见 syncScriptCandidates 上面那段说明)
  // -------------------------------------------------------------------------
  const syncScript = typeof config?.syncScript === 'string' && config.syncScript !== ''
    ? config.syncScript
    : defaultSyncScript()
  const syncRouteModels = config?.syncRouteModels !== false

  /** 最近一次同步的结果,由 `/health` 回显给界面 —— 界面据此提示「重启 DSH 生效」。 */
  let routeSync = { at: null, ok: null, models: null, error: '', pending: false }
  let syncTimer = null
  let syncing = null

  /**
   * 跑一次同步脚本。同一时刻只跑一个:批量启停会连着触发很多次,合并成一次即可。
   *
   * 用 `process.execPath` 而不是 `node`:DSH 自带运行时,不一定在 PATH 上。
   */
  function runRouteSync() {
    if (syncing !== null) return syncing
    // 找不到同步脚本(网关没克隆在旁边)时不要硬跑 —— 直接记一次失败,界面据此提示。
    if (syncScript === '') {
      routeSync = {
        at: new Date().toISOString(),
        ok: false,
        models: null,
        error: '找不到模型同步脚本:请把网关克隆到插件的兄弟目录,或设置环境变量 OFM_GATEWAY_DIR',
        pending: false,
      }
      return Promise.resolve(routeSync)
    }
    const run = new Promise(resolve => {
      let settled = false
      const finish = result => {
        if (settled) return
        settled = true
        routeSync = result
        resolve(routeSync)
      }
      const at = () => new Date().toISOString()
      let child
      try {
        child = spawn(process.execPath, [syncScript, '--key', apiKey()], {
          cwd: path.dirname(syncScript),
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        })
      } catch (error) {
        return finish({ at: at(), ok: false, models: null, error: `无法运行同步脚本:${error.message}`, pending: false })
      }
      let out = ''
      let err = ''
      child.stdout?.on('data', chunk => { out += chunk.toString() })
      child.stderr?.on('data', chunk => { err += chunk.toString() })
      // spawn 失败是**异步**的:没有 error 监听器会变成未捕获异常,直接带走 DSH。
      child.on('error', error => finish({ at: at(), ok: false, models: null, error: `无法运行同步脚本:${error.message}`, pending: false }))
      child.on('close', code => {
        if (code !== 0) {
          const detail = (err.trim() || out.trim()).slice(-400)
          return finish({ at: at(), ok: false, models: null, error: detail || `同步脚本退出码 ${code}`, pending: false })
        }
        const match = /providers\.\w+ 有 (\d+) 个模型/.exec(out)
        finish({ at: at(), ok: true, models: match === null ? null : Number(match[1]), error: '', pending: false })
      })
    })
    // 单飞守卫的复位必须放在赋值**之后**,而不是 finish 内部:spawn 同步抛错时
    // finish 会在构造器里就 resolve —— 若在那里直接 `syncing = null`,会被下面这行
    // `syncing = run` 盖回去,守卫就此卡在一个已结算的旧 Promise 上,后续调用
    // 永远拿到旧结果、不再真正重跑。
    syncing = run
    const release = () => { if (syncing === run) syncing = null }
    run.then(release, release)
    return syncing
  }

  /**
   * 安排一次同步 —— 防抖 1.2 秒。
   *
   * 批量按钮(全部启用/全部停用)会在一个请求里改几十个模型,紧接着界面还会再
   * 拉一次列表;每次改完都跑一遍脚本既慢又会在 profile 目录里堆一堆备份。
   */
  function scheduleRouteSync() {
    if (!syncRouteModels) return
    routeSync = { ...routeSync, pending: true }
    if (syncTimer !== null) clearTimeout(syncTimer)
    syncTimer = setTimeout(() => {
      syncTimer = null
      runRouteSync().catch(() => { /* 同步失败只影响提示,绝不影响用户刚做的操作 */ })
    }, 1_200)
    // 别让这个定时器把进程拴住。
    if (typeof syncTimer.unref === 'function') syncTimer.unref()
  }

  /** 调网关。网络层失败也返回一个结构化的 503，而不是把异常抛给界面。 */
  async function callGateway(pathname, init, timeoutMs = 120_000) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(gatewayUrl + pathname, {
        ...init,
        headers: {
          'content-type': 'application/json',
          ...(init?.headers ?? {}),
          authorization: `Bearer ${apiKey()}`,
        },
        signal: controller.signal,
      })
      const text = await response.text()
      let body
      try {
        body = text === '' ? null : JSON.parse(text)
      } catch {
        body = { error: text.slice(0, 400) }
      }
      return { status: response.status, body }
    } catch (error) {
      return { status: 503, body: { error: explain(error), gatewayUrl } }
    } finally {
      clearTimeout(timer)
    }
  }

  async function route(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const method = String(req.method ?? 'GET').toUpperCase()
    const sub = url.pathname.slice(PREFIX.length).replace(/\/+$/, '') || '/'

    try {
      /**
       * 网关健康检查 —— **永远返回 200**。
       *
       * 这是整页可用性的关键:界面任何一次请求失败后都会问一次这里,从而把
       * 「网关没跑」(可以修) 与「网关在跑但某个渠道出错」(只能看) 分开。
       * 用 200 而非 503,是因为「网关没跑」对界面而言是一份正常的情报,不是请求失败。
       */
      if (method === 'GET' && sub === '/health') {
        const probe = await callGateway('/checkin', undefined, 6_000)
        return send(res, 200, {
          up: probe.status === 200,
          gatewayUrl,
          status: probe.status,
          // error 必须是字符串或 null:网关回的业务错误(如 401 的 {message,...})
          // 经 errorMessage 归一;界面把任何对象当子节点渲染都会掀桌。
          error: probe.status === 200 ? null : errorMessage(probe.body?.error, `HTTP ${probe.status}`),
          startable: startCommand !== '' || fs.existsSync(startScript),
          startScript: startCommand !== '' ? startCommand : startScript,
          // 版本戳:插件是宿主进程启动时加载的,改了文件不一定立刻生效。
          // 界面上看到 revision 还是旧值时,就说明**需要重启 DSH** 才会加载新代码。
          revision: REVISION,
          // DSH 模型列表是快照(见 syncScriptCandidates 上面那段说明),这里回显
          // 最近一次同步结果,界面用它提示「已同步 N 个模型,重启 DSH 后生效」。
          route: routeSync,
          routeSync: syncRouteModels,
          routeScript: syncScript,
        })
      }

      /**
       * 立刻同步一次模型列表(不防抖),把结果原样返回。
       *
       * 界面上「立即同步」按钮用它 —— 用户刚改完模型启停,想马上把配置对齐,
       * 又不想等那 1.2 秒的防抖。
       */
      if (method === 'POST' && sub === '/route-sync') {
        if (!syncRouteModels) {
          return send(res, 200, { ok: false, disabled: true, error: '配置里 syncRouteModels: false 关掉了自动同步', route: routeSync })
        }
        if (syncTimer !== null) { clearTimeout(syncTimer); syncTimer = null }
        const result = await runRouteSync()
        return send(res, result.ok === true ? 200 : 502, { ...result, route: result })
      }

      /**
       * 启动网关并等它应答。连点会被合并成同一次尝试。
       *
       * **先探活再启动**:网关已经在跑时绝不能再去 spawn 一个 —— 两个网关会各自
       * 起一个渠道 Worker,同时写同一份 `channel-pack/*.json`,互相把对方的令牌
       * 用掉(`scripts/checkin-once.mjs` 里那段警告说的就是这件事)。所以这里
       * 幂等:已经在跑就直接回成功,只报告它已经在。
       */
      if (method === 'POST' && sub === '/start') {
        const result = await startGatewayOnce()
        return send(res, result.ok === true ? 200 : 502, result)
      }

      // 状态：透传网关的 GET /checkin（已经是解过包的结构）。
      if (method === 'GET' && (sub === '/' || sub === '/status')) {
        const result = await callGateway('/checkin')
        return send(res, result.status, result.body)
      }

      // 立刻签到：整轮（无 provider）或单个渠道（带 provider）。
      // 网关是「触发即返回」，真正的进度由界面轮询 /status 得到，所以这里不需要长超时。
      // 积分详情:逐账号余额与套餐明细(网关 /checkin/balance)。
      // 这只是读,但每一行都要打上游,所以是界面上的显式动作,不做自动轮询。
      // 通用渠道 RPC(白名单)。**刻意不解包** `{ok,value}` 信封:
      // 有些方法(如 login.poll)用 `ok:false` + code 表达「还没好」,属于流程的一部分,
      // 解包成 HTTP 502 会让界面分不清「等一等」和「真失败」。
      if (method === 'POST' && sub === '/rpc') {
        const body = await readJson(req)
        if (typeof body?.method !== 'string' || !RPC_METHODS.has(body.method)) {
          return send(res, 400, { error: `不允许的 RPC 方法:${String(body?.method ?? '')}` })
        }
        const result = await callGateway('/rpc', {
          method: 'POST',
          body: JSON.stringify({ method: body.method, payload: body.payload ?? {} }),
        }, 300_000)
        // 模型/渠道/账号一变,「可路由模型集合」就可能变了 —— 而 DSH 的模型列表
        // 是配置里的快照,不会自己跟着变。所以在这里顺手把配置对齐(防抖、后台、
        // 不阻塞这次响应)。
        //
        // 判据必须是**业务成功**:网关对 RPC 失败也回 HTTP 200 + 信封 `{ok:false}`,
        // 只看 status 会把失败也当成成功触发同步。另有 login.poll 一个特例:它每次
        // 轮询都是 200 + ok:true,只有 `value.done===true` 才是凭据落地、该渠道模型
        // 真正变可路由的那一刻(account.create 那次触发还早,那时只是占位账号)。
        const routableChanged = result.status === 200 && result.body?.ok === true && (
          MODEL_MUTATIONS.has(body.method)
          || (body.method === 'login.poll' && result.body?.value?.done === true && result.body?.value?.success !== false)
        )
        if (routableChanged) scheduleRouteSync()
        return send(res, result.status, result.body)
      }

      if (method === 'GET' && sub === '/balance') {
        const provider = url.searchParams.get('provider')
        const query = typeof provider === 'string' && provider !== '' ? `?provider=${encodeURIComponent(provider)}` : ''
        const result = await callGateway(`/checkin/balance${query}`, undefined, 300_000)
        return send(res, result.status, result.body)
      }

      if (method === 'POST' && sub === '/run') {
        const body = await readJson(req)
        const payload = typeof body?.provider === 'string' && body.provider !== '' ? { provider: body.provider } : {}
        const result = await callGateway('/checkin/run', { method: 'POST', body: JSON.stringify(payload) }, 300_000)
        return send(res, result.status, result.body)
      }

      // 开关。走网关的通用 RPC 通道（usage.autoCheckin），返回值是 {ok,value} 信封，这里解开。
      if (method === 'POST' && sub === '/enabled') {
        const body = await readJson(req)
        if (typeof body?.enabled !== 'boolean') return send(res, 400, { error: 'enabled 必须是 true 或 false' })
        const result = await callGateway('/rpc', {
          method: 'POST',
          body: JSON.stringify({ method: 'usage.autoCheckin', payload: { enabled: body.enabled } }),
        }, 300_000)
        if (result.status === 200 && result.body?.ok === true) {
          return send(res, 200, { autoCheckin: result.body.value?.autoCheckin ?? null })
        }
        const reason = errorMessage(result.body?.error, '网关拒绝了这次开关')
        return send(res, result.status === 200 ? 502 : result.status, { error: reason })
      }

      return send(res, 404, { error: `未知接口 ${method} ${sub}` })
    } catch (error) {
      return send(res, error?.statusCode ?? 500, { error: error?.message ?? String(error) })
    }
  }

  // webServer 是可选设施：`ctx.inject` 会在它出现（或稍后才提供）时再回调。
  ctx.inject(['webServer'], scoped => {
    const server = scoped.webServer
    scoped.effect(() => server.register({ kind: 'prefix', path: PREFIX, handler: route }), 'ofm-checkin: api routes')
  })

  // ---------------------------------------------------------------------------
  // DSH 启动时自动拉起网关
  // ---------------------------------------------------------------------------
  /**
   * 为什么默认开:网关不是 Windows 服务,计划任务/启动项/启动文件夹里都没有它,
   * 所以「打开 DSH」并不会带起网关 —— 不自动拉起的话,每次开 DSH 之后 ofm 模型
   * 都是「连接被拒」,要等用户自己想起来去点「启动网关」。
   *
   * 启动是幂等的(先探活),所以自动拉起与按钮点击、与手动 start.bat 都不会开出
   * 第二个网关。
   *
   * 三条约束:
   *   1. **不等待结果**。首次启动要加载 13 个渠道(实测数秒),不该拖住宿主加载。
   *   2. **出错绝不能掀掉宿主**。launchGateway 只回结构化的 ok:false,
   *      waitForGateway 有上限,这里再兜一层 catch。
   *   3. 延后几秒,避开宿主启动那一堆初始化。
   *
   * 不想要就写 `autoStart: false`。
   */
  if (config?.autoStart !== false) {
    const autoStartTimer = setTimeout(() => {
      startGatewayOnce()
        .then(result => {
          if (result.ok === true) {
            if (result.already !== true) ctx.logger?.info?.(`[ofm-checkin] 已随 DSH 启动自动拉起网关(pid ${result.pid})`)
          } else {
            ctx.logger?.warn?.(`[ofm-checkin] 随 DSH 启动自动拉起网关失败:${result.error}`)
          }
        })
        .catch(error => {
          ctx.logger?.warn?.(`[ofm-checkin] 随 DSH 启动自动拉起网关异常:${error?.message ?? String(error)}`)
        })
    }, 3_000)
    // 别让这个定时器把进程拴住。
    if (typeof autoStartTimer.unref === 'function') autoStartTimer.unref()
  }
}
