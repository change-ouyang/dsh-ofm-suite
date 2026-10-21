/**
 * DSH 每日签到 — 浏览器半身。
 *
 * 一个设置分区(`settings.section` id `ofm-checkin`),上面是每日签到的状态与开关,
 * 下面是原版那 13 个渠道的卡片:账号数 / 模型数 / 剩余积分,以及
 * 添加账号、续期、刷新余额、一键领取,和逐账号、逐模型的操作。
 *
 * 数据走**同源** `/api/ofm-checkin/*`(宿主半身代理到本机网关),所以浏览器里
 * 不出现网关密钥,也不需要 CORS。
 *
 * 手写 ModuleLoader 包:**无构建步骤**,除 shell 自带的 `react` 外无任何依赖
 *(不 require 任何 Harness Client 包 —— 那些包会变,而抛错会整块空白)。
 *
 * 样式是挂在组件树里的 `<style>`,只用 `--dsw-alias-*` 主题 token:浅色/深色
 * 自动成立,卸载时随组件一起移除,不往 `document.body` 或别处写 DOM。
 */

window.__ModuleLoader__.load({
  id: 'dsh-ofm-checkin',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { createElement: h, Fragment, useState, useEffect, useCallback } = React

    const inject = ['slots']

    /**
     * 渠道身份表:照抄原版。
     *
     * 身份是**产品事实**(渠道叫什么、属于谁、走哪种登录),不是读数,所以写死在这里,
     * 页面第一帧就能把 13 张卡片画出来,状态再慢慢从渠道包取。`accent` 只用在品牌色条上,
     * 属于图形用色,不走主题 token。
     */
    const CHANNELS = [
      { id: 'codearts', name: 'CodeArts', org: '华为云', accent: '#C7000B', note: 'DeepSeek · GLM · openPangu,每日免费额度', login: 'browser' },
      { id: 'buddy', name: 'WorkBuddy 国内版', org: '腾讯 · copilot.tencent.com', accent: '#0A7AFF', note: 'CodeBuddy 同一端点:DeepSeek · Kimi · GLM 免费线,每日积分', login: 'browser' },
      { id: 'workbuddy', name: 'WorkBuddy 国际版', org: '腾讯 · workbuddy.ai', accent: '#0B63CE', note: '国际版端点:独立账号与积分体系', login: 'browser' },
      { id: 'lobsterai', name: 'LobsterAI', org: '有道', accent: '#FF6A00', note: '龙虾 · 每日签到积分', login: 'browser' },
      { id: 'qoder', name: 'Qoder', org: '阿里系', accent: '#615CED', note: '每日 100 Credits,加密推理端点', login: 'browser' },
      { id: 'qodercn', name: 'Qoder 中国版', org: '阿里系', accent: '#7A6CF0', note: '中国版端点与模型池', login: 'browser' },
      { id: 'trae', name: 'TRAE', org: '字节', accent: '#00BFA6', note: '手机号登录', login: 'browser' },
      { id: 'cline', name: 'Cline', org: 'Cline', accent: '#5B5BD6', note: 'Cline 账号免费额度', login: 'browser' },
      { id: 'loomy', name: 'Loomy', org: '讯飞', accent: '#2F6BFF', note: '微信扫码,或短信验证码备用', login: 'browser+sms' },
      { id: 'raccoon', name: 'Raccoon', org: '商汤', accent: '#00A6A6', note: '手机号登录', login: 'browser' },
      { id: 'minimax', name: 'MiniMax Code', org: 'MiniMax', accent: '#E4007F', note: '设备码 + PKCE,每日签到', login: 'browser' },
      { id: 'zcode', name: 'ZCode', org: '智谱', accent: '#3B6EF6', note: '浏览器登录(需本机可开浏览器)', login: 'browser' },
      { id: 'gemini', name: 'Gemini', org: 'Google Code Assist', accent: '#4285F4', note: '本地回调 OAuth 免费线', login: 'browser' },
    ]

    /** 每个渠道的积分能力:能不能领(claim)、有没有独立的领取状态、余额单位是什么。 */
    const CREDITS = {
      codearts: { claim: true },
      buddy: { claim: true, status: true },
      workbuddy: {},
      lobsterai: { claim: true },
      qoder: { claim: true },
      qodercn: { claim: true },
      trae: { claim: true },
      cline: { unit: 'dollars' },
      loomy: { claim: true },
      raccoon: {},
      minimax: { claim: true, status: true },
      zcode: { claim: true, unit: 'tokens' },
      gemini: { unit: 'quota', quota: true },
    }

    const PROVIDER_IDS = CHANNELS.map(channel => channel.id)

    /**
     * 界面文案集中在这里。
     *
     * 有意**不走** Client locale 服务:本插件只有中文一种语言,而 locale 查不到 key
     * 时 shell 会把原始 key 显示出来(看起来像坏了)。集中成一张表,将来要接 locale
     * 也只是把 T 换成 ctx.locale.bind(NS)。
     */
    const T = {
      nav: '每日签到',
      on: '自动签到已开启',
      off: '自动签到已关闭',
      enableHint: '打开后会立即尝试签到一次',
      disableHint: '关闭后不再自动签到',
      run: '立即签到',
      rerun: '再签一次',
      /**
       * 今天已签过时,整轮按钮**不再说「再签一次」**。
       *
       * 原因是实测出来的:渠道包的 `runIfDue` 有一道按天的闸
       * (`lastDate === today()` 就直接返回),所以"再签一次"点了等于 0 秒空转 ——
       * 按钮名和行为对不上,用户还以为自己签过了。渠道包没有 force 入口,
       * 整轮**真的**重跑不了,所以这里如实说明,并把可用的路指出来。
       */
      rerunBlocked: '今天已签',
      rerunBlockedWhy: '渠道包按天去重:今天跑过之后整轮不再重复(实测点击 0 秒返回、状态不变)。想再试请用渠道卡片上的「一键领取」—— 它走的是另一条路,会真的请求上游。',
      retryFailed: '重试失败的渠道',
      retryFailedWhy: '整轮今天已跑过、不会重复;这个按钮逐渠道重新领取,只针对本轮失败的渠道。',
      retryFailedDone: '重试完成:{summary}',
      retryNone: '本轮没有失败的渠道,不需要重试。',
      /**
       * 按钮上的"领不了"文案。
       *
       * 刻意避开「开启」二字:卡片右上角的徽章已经在用「已开启/未登录」表示
       * **渠道连接状态**,而这里说的是**签到活动状态**。两件事用同一个词,
       * 就是截图里「已开启」和「1 个未开启」并排出现的由来。
       */
      stateInactiveShort: '活动未开启',
      stateUnsupportedShort: '不支持签到',
      stateManualShort: '需手动签到',
      claimWhyInactive: '这个渠道的签到活动没有开启(不是账号没连上)—— 到渠道自己的页面开启活动后再来领。',
      claimWhyUnsupported: '这个渠道的后端没有签到接口,领取请求不会发出去,点了也不会有结果。',
      claimWhyManual: '这个渠道需要在它自己的页面里手动签到,接口领不了。',
      claimWhyNoAccounts: '这个渠道还没有账号 —— 先点「添加账号」。',
      claimRetryHint: '这个渠道本轮有账号失败,点它会真的重新请求一次上游。',
      running: '签到中...',
      refresh: '刷新',
      inFlight: '渠道正在跑',
      signedToday: '今天已签',
      last: '上次',
      result: '结果',
      schedule: '调度',
      none: '(还没有记录)',
      noSchedule: '(网关未上报调度)',
      waiting: '签到请求已发出,正在等结果...',
      finished: '本轮已结束。',
      slow: '等了两分钟还没结束 —— 渠道可能还在刷新凭据,稍后点「刷新」看看。',
      why: '网关的每日循环补上了渠道包缺的那一环:渠道包只在进程启动 30 秒后签一次,没有每日定时器。',
      gwTitle: '网关没有运行',
      gwWhy: '签到和渠道数据都由本机的 ofm-free-gateway 执行;它没跑时这一页只能看结构、不能操作。',
      gwStart: '启动网关',
      gwStarting: '正在启动...',
      gwStarted: '网关已启动。',
      gwStartFailed: '启动失败:{reason}',
      gwManual: '也可以手动跑:',
      gwRetry: '重试连接',
      gwChecking: '检查中...',
      gwStillDown: '还是连不上 —— 网关可能在启动中(首次加载渠道要十几秒),稍等再点「重试连接」。',
      gwOfflineHint: '离线',
      gwStale: '宿主半身是旧版本(revision {revision},当前应为 {expected})—— 需要重启 DSH 才会加载新代码。',
      gwStaleTitle: '插件代码没生效',
      // 模型列表同步(DSH 的模型列表是配置里的快照,不会自己跟着网关变)
      routeSynced: 'DSH 模型列表已同步为 {count} 个模型 —— 重启 DSH 后模型选择器里才会变。',
      routeSyncedTitle: '模型列表已更新',
      routePending: '正在把模型列表同步到 DSH 配置...',
      routeFailed: '模型列表同步失败:{reason}',
      routeFailedTitle: '模型列表没同步',
      routeSyncNow: '立即同步',
      routeSyncing: '同步中...',
      routeNever: '模型列表尚未同步过。改了模型启停后点「立即同步」,再重启 DSH。',
      loadingStatus: '正在读取渠道状态...',
      // 渠道卡片
      channels: '渠道',
      channelsHint: '账号与模型都在这里管;卡片上的状态来自渠道包',
      refreshBalance: '刷新余额',
      balanceLoading: '查询中...',
      total: '合计',
      addAccount: '添加账号',
      adding: '准备中...',
      refreshAccounts: '续期',
      refreshing: '续期中...',
      claimAll: '一键领取',
      claiming: '领取中...',
      claimed: '已领取',
      claimedHint: '今天已经领过了;再点会向上游确认一次,不会重复发放。',
      foldAccounts: '账号',
      foldModels: '模型',
      accountCount: '账号',
      modelCount: '模型',
      creditsLeft: '剩余积分',
      creditsTokens: '剩余额度',
      creditsDollars: '剩余金额',
      creditsQuota: '额度',
      stateIdle: '未登录',
      stateOn: '已开启',
      noAccounts: '还没有账号 —— 点「添加账号」走一遍渠道自己的登录。',
      noModels: '这个渠道没有模型目录。',
      expires: '到期',
      test: '测试',
      testing: '测试中...',
      accountOn: '启用',
      accountOff: '停用',
      delete: '删除',
      deleteConfirm: '确认删除',
      cancel: '取消',
      modelOn: '启用',
      modelOff: '停用',
      /**
       * 整渠道批量开关。
       *
       * 原先这两个按钮写的是 `${T.modelOff}×` / `${T.modelOn}×` → 「停用×」「启用×」,
       * 那个 `×` 想表达"全部",但实际没人看得懂 —— 用户直接问"没有全选停用吗"。
       * 现在写全,并带上**会改动几个**,点之前就知道影响范围。
       */
      modelDisableAll: '全部停用',
      modelEnableAll: '全部启用',
      modelsAllDone: '已{action} {count} 个模型。',
      modelsAllNone: '已经全部{state},不用再点。',
      modelFree: '免费',
      modelDead: '失效',
      refreshWarning: '续期会真的去换新凭据;CodeArts 一类的刷新令牌是一次性的,同一账号只能有一个进程在用。',
      /**
       * 续期结果文案。
       *
       * 原先不管成败,成功之后弹的都是那句 `refreshWarning` —— 用户点了分不清
       * 到底成没成;多账号时若部分失败,error 与这句警告还会同时出现、互相打架。
       * 现在按真实结果分开说:成功报数量与新的到期时间,失败单独列出来。
       */
      refreshOk: '已续期 {count} 个账号。',
      refreshOkOne: '已续期 {name}。',
      refreshExpires: '新到期时间 {at}',
      refreshPartial: '{ok} 个成功,{failed} 个失败:{reasons}',
      refreshAllFailed: '续期失败:{reasons}',
      refreshNotRefreshable: '这个账号不可续期(没有刷新令牌)—— 只能重新登录。',
      // 添加账号
      loginTitle: '添加账号',
      loginStep1: '① 打开下面这个链接,在渠道自己的页面里完成登录',
      loginStep2: '② 登录完成后这个窗口会自动关掉,账号出现在列表里',
      loginOpen: '打开登录页',
      loginWaiting: '正在等待渠道回传凭据...这一步可能要几十秒。',
      loginDone: '登录完成,账号已加入。',
      loginFailed: '登录失败:{reason}',
      loginExpired: '等待超时(10 分钟),这个登录链接已经作废,请重新点「添加账号」。',
      loginNoUrl: '渠道没有返回登录链接 —— 请看渠道自己的提示(可能需要短信验证码)。',
      close: '关闭',
      // 领取结果
      claimResult: '已领取 {count} 个账号,共 {credit} 积分。',
      claimNone: '今天没有可领取的积分。',
      claimFailed: '领取失败:{reason}',
      // 杂项
      notReady: '渠道包还没就绪,稍后自动重试。',
      loadFailed: '读取失败:{reason}',
      balanceFailed: '查询失败',
      noAccountRow: '(没有账号)',
    }

    /** 整轮签到是触发即返回,进度靠轮询;单个渠道的领取要打上游,给它宽一点。 */
    const POLL_MS = 2500
    const POLL_TRIES = 100
    const LOGIN_POLL_MS = 3000
    const LOGIN_WINDOW_MS = 10 * 60_000

    /**
     * 期望的宿主半身版本 —— 必须与 `index.js` 的 `REVISION` 一致。
     *
     * 改宿主代码时**两边一起加**:不一致时界面会明确提示「需要重启 DSH」,
     * 而不是让人对着旧行为怀疑自己改错了。宿主没上报 revision(旧版本)时按 null 处理,
     * 也就不提示 —— 那种情况本来就没有这个字段可用。
     */
    const EXPECTED_REVISION = 4

    /**
     * 一次 API 调用。
     *
     * 宿主对「网关没跑」回的是 503 + 一句话,和别的失败混在一起 —— 这里给错误对象
     * 打上 `offline` 标记,页面据此把「先启动网关」和「某个操作真的失败了」分开。
     * 判据与宿主半身的 `isGatewayDown` 保持一致。
     */
    async function api(pathname, init) {
      const response = await fetch(`/api/ofm-checkin${pathname}`, {
        ...init,
        headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
      })
      const body = await response.json().catch(() => null)
      if (!response.ok) {
        const error = new Error(body?.error ?? `HTTP ${response.status}`)
        error.status = response.status
        // 只有连接层失败才算离线:网关自己回的业务错误(401/400/502)必须原样报出来。
        error.offline = response.status === 503 && isOfflineMessage(body?.error)
        throw error
      }
      return body
    }

    /** 与宿主 `isGatewayDown` 同一套措辞 —— 两处一起改,否则判定会漂移。 */
    function isOfflineMessage(message) {
      return /网关没有运行|与网关的连接被重置|无法连接|ECONNREFUSED|ECONNRESET|fetch failed/i.test(String(message ?? ''))
    }

    /** 通用渠道 RPC。宿主刻意不解包信封,所以这里按 `ok` 判定,并把 code 带出来。 */
    async function rpc(method, payload) {
      const envelope = await api('/rpc', { method: 'POST', body: JSON.stringify({ method, payload: payload ?? {} }) })
      if (envelope?.ok === false) {
        const error = new Error(envelope.error?.message ?? '渠道 RPC 失败')
        error.code = envelope.error?.code
        throw error
      }
      return envelope?.value
    }

    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

    /** 本机日期的 YYYY-MM-DD。用本地时区,与网关的 localDateKey 一致。 */
    function todayKey() {
      const now = new Date()
      const pad = value => String(value).padStart(2, '0')
      return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
    }

    function formatAt(value) {
      const at = Number(value)
      if (!Number.isFinite(at) || at <= 0) return ''
      const date = new Date(at)
      const pad = number => String(number).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    /** 数字显示:去掉多余的 0(4599.85 保留,4000 不写成 4000.00),拿不到就摆破折号。 */
    function formatNumber(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      return String(Math.round(value * 100) / 100)
    }

    /** 一个账号一行:昵称 + 总额 + 套餐明细(哪个包还剩多少一目了然)。 */
    function describeAccount(account) {
      const head = `${account?.nickname ?? account?.accountId ?? '账号'} ${formatNumber(account?.balance?.total)}`
      const packages = (account?.balance?.packages ?? [])
        .map(pkg => `${pkg?.name ?? '额度'} ${formatNumber(pkg?.remaining)}/${formatNumber(pkg?.total)}`)
      return packages.length === 0 ? head : `${head}(${packages.join(' · ')})`
    }

    /**
     * 汇总:所有渠道、所有账号的余额之和,以及出现过的单位。
     *
     * 单位可能是 credits / tokens / 美元,各渠道口径并不统一 —— 所以把出现过的单位
     * 一起返回,让界面照原样标注,而不是假装它们一定能相加。
     */
    function summarizeCredits(rows) {
      let total = 0
      let accounts = 0
      const units = new Set()
      for (const row of Array.isArray(rows) ? rows : []) {
        for (const account of row?.accounts ?? []) {
          accounts += 1
          const value = account?.balance?.total
          if (typeof value === 'number' && Number.isFinite(value)) total += value
          for (const pkg of account?.balance?.packages ?? []) {
            if (typeof pkg?.unit === 'string' && pkg.unit !== '') units.add(pkg.unit)
          }
        }
      }
      return { total: Math.round(total * 100) / 100, accounts, units: [...units] }
    }

    /** 按渠道能力挑余额标签:有的渠道余额是额度/美元,不都是「积分」。 */
    function creditsLabel(channelId) {
      const capability = CREDITS[channelId] ?? {}
      if (capability.unit === 'tokens') return T.creditsTokens
      if (capability.unit === 'dollars') return T.creditsDollars
      if (capability.quota) return T.creditsQuota
      return T.creditsLeft
    }

    /**
     * 单渠道领取的返回:`{summary:{claimed,totalCredit}, results:[{outcome:{kind,message}}]}`。
     * 成功与失败要能同时说出来 —— 一个渠道可能有多个账号,只报成功会骗人。
     */
    function describeClaim(value) {
      const summary = value?.summary ?? value
      const claimed = Number(summary?.claimed ?? 0)
      const credit = Number(summary?.totalCredit ?? 0)
      const failed = (value?.results ?? []).filter(row => row?.outcome?.kind === 'failed')
      const success = T.claimResult.replace('{count}', String(claimed)).replace('{credit}', String(credit))
      if (failed.length === 0) return claimed > 0 ? success : T.claimNone
      const reason = failed.map(row => row.outcome.message).join(';')
      const failure = T.claimFailed.replace('{reason}', reason)
      return claimed > 0 ? `${success};${failure}` : failure
    }

    /**
     * 只引用 `--dsw-alias-*` 主题 token:改名只会让外观退化,不会让渲染崩掉。
     * 类名统一 `ofmc-` 前缀,避免和宿主或别的插件撞车。
     */
    const CSS = `
.ofmc-root { display: flex; flex-direction: column; gap: 14px; font-size: 13px; color: var(--dsw-alias-label-primary); }
.ofmc-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.ofmc-title { font-size: 15px; font-weight: 600; margin: 0; }
.ofmc-card-title { font-weight: 600; }
.ofmc-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.ofmc-card { background: var(--dsw-alias-settings-card-fill); border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; }
.ofmc-label { color: var(--dsw-alias-label-primary-dimmed); min-width: 52px; display: inline-block; }
.ofmc-muted { color: var(--dsw-alias-label-primary-dimmed); font-size: 12px; }
.ofmc-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.ofmc-total { font-weight: 600; }
.ofmc-btn { background: var(--dsw-alias-button-elevated-fill); border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-primary); border-radius: 6px; padding: 5px 12px; font-size: 13px; cursor: pointer; }
.ofmc-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.ofmc-btn:disabled { opacity: 0.5; cursor: default; }
.ofmc-btn-primary { background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); border-color: transparent; font-weight: 600; }
.ofmc-btn-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
.ofmc-btn-small { padding: 2px 9px; font-size: 12px; }
.ofmc-btn-done { color: var(--dsw-alias-label-primary-dimmed); }
.ofmc-pill { border: 1px solid var(--dsw-alias-border-l2); border-radius: 999px; padding: 1px 8px; font-size: 12px; color: var(--dsw-alias-label-primary-dimmed); }
.ofmc-pill-off { color: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-state-warn-primary); }
.ofmc-switch { position: relative; width: 36px; height: 20px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-3); cursor: pointer; padding: 0; flex: none; }
.ofmc-switch[aria-checked="true"] { background: var(--dsw-alias-brand-primary); border-color: transparent; }
.ofmc-switch:disabled { opacity: 0.5; cursor: default; }
.ofmc-switch-thumb { position: absolute; top: 1px; left: 1px; width: 16px; height: 16px; border-radius: 50%; background: var(--dsw-alias-switch-thumb); transition: transform 0.15s ease; }
.ofmc-switch[aria-checked="true"] .ofmc-switch-thumb { transform: translateX(16px); }
.ofmc-list { display: flex; flex-direction: column; }
.ofmc-item { display: flex; align-items: center; gap: 10px; padding: 7px 2px; border-top: 1px solid var(--dsw-alias-border-l1); }
.ofmc-provider { min-width: 96px; font-weight: 600; }
.ofmc-text { flex: 1; color: var(--dsw-alias-label-primary-dimmed); }
.ofmc-error { border: 1px solid var(--dsw-alias-state-error-primary); border-radius: 8px; padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; }
.ofmc-error-title { font-weight: 600; color: var(--dsw-alias-state-error-primary); }
.ofmc-error-text { color: var(--dsw-alias-state-error-primary); }
.ofmc-ok { color: var(--dsw-alias-label-primary-dimmed); font-size: 12px; }
.ofmc-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 12px; }
.ofmc-chan { position: relative; overflow: hidden; }
.ofmc-stripe { position: absolute; inset: 0 auto 0 0; width: 3px; }
.ofmc-chan-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
.ofmc-chan-name { font-weight: 600; font-size: 14px; }
.ofmc-chan-org { color: var(--dsw-alias-label-primary-dimmed); font-size: 12px; }
.ofmc-chan-note { color: var(--dsw-alias-label-primary-dimmed); font-size: 12px; }
.ofmc-state { border-radius: 999px; padding: 1px 8px; font-size: 12px; border: 1px solid var(--dsw-alias-border-l2); white-space: nowrap; }
.ofmc-state-on { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
.ofmc-state-off { color: var(--dsw-alias-label-primary-dimmed); }
.ofmc-state-idle { color: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-state-warn-primary); }
.ofmc-stats { display: flex; gap: 14px; flex-wrap: wrap; align-items: baseline; }
.ofmc-stat { color: var(--dsw-alias-label-primary-dimmed); font-size: 12px; }
.ofmc-stat-num { font-weight: 600; color: var(--dsw-alias-label-primary); }
.ofmc-acts { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.ofmc-fold { background: none; border: none; color: var(--dsw-alias-label-primary); cursor: pointer; font-size: 12px; padding: 2px 4px; }
.ofmc-fold[data-open="true"] { color: var(--dsw-alias-brand-primary); }
.ofmc-acctacts { display: flex; gap: 5px; flex-wrap: wrap; }
.ofmc-minibtn { background: var(--dsw-alias-button-elevated-fill); border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-primary); border-radius: 5px; padding: 1px 7px; font-size: 12px; cursor: pointer; }
.ofmc-minibtn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.ofmc-minibtn:disabled { opacity: 0.5; cursor: default; }
.ofmc-minibtn-danger { color: var(--dsw-alias-state-error-primary); }
.ofmc-tagpill { border-radius: 4px; padding: 0 5px; font-size: 11px; border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-primary-dimmed); }
.ofmc-tagpill-free { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
.ofmc-tagpill-dead { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
.ofmc-scrim { position: fixed; inset: 0; background: var(--dsw-alias-bg-mask-1); display: flex; align-items: center; justify-content: center; z-index: 40; }
.ofmc-dialog { background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; padding: 16px; width: min(560px, 92vw); display: flex; flex-direction: column; gap: 10px; }
.ofmc-dialog-head { font-weight: 600; font-size: 14px; }
.ofmc-dialog-body { display: flex; flex-direction: column; gap: 8px; }
.ofmc-step { display: flex; gap: 8px; align-items: flex-start; }
.ofmc-code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; word-break: break-all; background: var(--dsw-alias-bg-layer-2); border-radius: 6px; padding: 8px; }
`

    /**
     * 一个渠道一张卡片 —— 与原版一致:身份写死,状态来自渠道包,详情按需拉。
     *
     * 所有按钮都通过 `withBusy` 串行化 —— 这是一把**全局**锁:`busy` 是 Page 级
     * 单一状态,任何渠道的动作在跑都会暂时置灰全部按钮(不是逐渠道独立的)。
     * 这是刻意的保守选择:避免同时打进网关把自己和上游搞乱。key 里的
     * `<channel.id>:` 前缀只用来决定哪个按钮显示「领取中…」这类文案。
     */
    function ChannelCard({ channel, status, balance, claimed, checkinText, flags, busy, withBusy, onChanged, reloadBalance, offline }) {
      const [accounts, setAccounts] = useState(null)
      const [models, setModels] = useState(null)
      const [open, setOpen] = useState('')
      const [notice, setNotice] = useState('')
      const [error, setError] = useState('')
      const [login, setLogin] = useState(null)
      const [confirming, setConfirming] = useState('')

      const capability = CREDITS[channel.id] ?? {}
      const accountsTotal = status?.accounts?.total ?? 0
      const accountsEnabled = status?.accounts?.enabled ?? 0
      const modelsTotal = status?.models?.total ?? 0
      const modelsOff = status?.models?.disabled ?? 0
      const hasAccount = accountsEnabled > 0
      /**
       * 徽章只表达「渠道连没连上」,不掺模型启停。
       *
       * 上游的 `closed`(`disabled === total`,见 channel-pack-rpc.ts)说的是「模型全停用」,
       * 不是"渠道关闭";而模型行旁边就是「全部停用/启用」按钮,启停状态已经摆在那了,
       * 徽章再回显一遍反而只会让人以为渠道/账号出了问题。所以只要账号还连着,就说「已开启」。
       */
      const stateClass = hasAccount ? 'ofmc-state ofmc-state-on' : 'ofmc-state ofmc-state-idle'
      const stateText = hasAccount ? T.stateOn : T.stateIdle

      /**
       * 逐渠道签到的真实结局。网关的 `classifyCheckinText` 已经归好类,
       * 这里只是把它翻成"按钮该不该点"。
       *
       * 为什么要这么做:之前只有 `claimed` 被用上,于是「签到活动未开启」的渠道
       * (Qoder 那两张,实测 flags=['inactive'])按钮照样可点,点下去必然拿不到积分 ——
       * 白等一轮,而且按钮还写着「一键领取」,看不出问题在哪。
       *
       * ⚠️ `failed` 排在 `claimed` **之前**:一个渠道可能有多个账号,部分领到、
       * 部分失败时,两个 flag 会同时出现。这时候必须还能点 —— 失败重试是唯一出口,
       * 若被 `claimed` 盖住,失败的那几个账号就再也没有入口了。
       */
      const flagSet = new Set(Array.isArray(flags) ? flags : [])
      const hasAccounts = accountsTotal > 0
      /**
       * `provider.status` 还没回来时,`accountsTotal` 是 0 —— 那**不代表**没有账号,
       * 只代表还不知道。若把"未知"当成"没有账号",页面首帧所有领取按钮会集体置灰,
       * 等状态到了又亮起来,看着像闪了一下坏掉。所以只有**已知**为 0 才拦。
       */
      const statusKnown = status !== null && status !== undefined
      const signupState = (statusKnown && !hasAccounts)
        ? 'no-accounts'
        : flagSet.has('unsupported') ? 'unsupported'
          : flagSet.has('inactive') ? 'inactive'
            : flagSet.has('manual') ? 'manual'
              : flagSet.has('failed') ? 'failed'
                : claimed ? 'claimed'
                  : 'open'

      /**
       * 「一键领取」能不能点。
       *
       * 不能点 = 渠道包**根本不会发上游请求**的那几种(无签到接口 / 活动未开启 /
       * 需手动签到),点了纯粹是白等。
       *
       * 能点 = 未领过、失败重试、以及**已领取**。
       * 已领取仍然可点是原作者的刻意选择:一个渠道可能有多个账号,复查一遍
       * 有意义,渠道包也有 `already-claimed` 预检兜底,不会重复发放。
       */
      const claimBlocked = signupState === 'no-accounts'
        || signupState === 'unsupported'
        || signupState === 'inactive'
        || signupState === 'manual'
      const claimable = capability.claim === true && !claimBlocked
      const claimBlockedWhy = signupState === 'inactive' ? T.claimWhyInactive
        : signupState === 'unsupported' ? T.claimWhyUnsupported
          : signupState === 'manual' ? T.claimWhyManual
            : signupState === 'no-accounts' ? T.claimWhyNoAccounts
                : ''
      const claimLabel = signupState === 'claimed' ? T.claimed
        : signupState === 'inactive' ? T.stateInactiveShort
          : signupState === 'unsupported' ? T.stateUnsupportedShort
            : signupState === 'manual' ? T.stateManualShort
              : T.claimAll
      // 已领取仍可点,但要说清楚"点了只是复查,不会重复发"。
      const claimHint = claimBlockedWhy !== '' ? claimBlockedWhy
        : signupState === 'claimed' ? T.claimedHint
          : signupState === 'failed' ? T.claimRetryHint
            : ''

      /**
       * 读账号列表。**同时返回数据** —— 续期后要立刻从里面取新的 `expiresAt`,
       * 而 `account.refresh` 本身不回这个字段。只 setState 不返回的话,
       * 调用方只能等下一次渲染,拿不到"刚续到什么时候"。
       */
      const loadAccounts = useCallback(async () => {
        try {
          const value = await rpc('account.list', { provider: channel.id })
          const rows = value?.accounts ?? []
          setAccounts(rows)
          setError('')
          return rows
        } catch (caught) {
          setError(T.loadFailed.replace('{reason}', caught.message ?? String(caught)))
          return []
        }
      }, [channel.id])

      /** 读模型列表。同样返回数据 —— 批量开关后要用它报"改了几个"。 */
      const loadModels = useCallback(async () => {
        try {
          const value = await rpc('model.list', { provider: channel.id })
          const rows = value?.models ?? []
          setModels(rows)
          setError('')
          return rows
        } catch (caught) {
          setError(T.loadFailed.replace('{reason}', caught.message ?? String(caught)))
          return []
        }
      }, [channel.id])

      const toggle = async panel => {
        const next = open === panel ? '' : panel
        setOpen(next)
        setNotice('')
        if (next === 'accounts') await loadAccounts()
        if (next === 'models') await loadModels()
      }

      /**
       * 添加账号。渠道包是两段式:`account.create` 立刻返回登录链接
       *(晚开的弹窗会被浏览器拦掉),后台登完再由 `login.poll` 看到凭据落地。
       */
      const startLogin = () => withBusy(`${channel.id}:add`, async () => {
        setNotice('')
        try {
          const value = await rpc('account.create', { provider: channel.id })
          const accountId = value?.accountId
          if (typeof accountId !== 'string' || accountId === '') throw new Error('渠道没有返回账号标识')
          const url = typeof value?.loginUrl === 'string' ? value.loginUrl : ''
          if (url !== '') { try { window.open(url, '_blank', 'noopener') } catch { /* 弹窗被拦时,对话框里还有链接 */ } }
          setLogin({ accountId, url, startedAt: Date.now() })
          setOpen('accounts')
        } catch (caught) { setError(caught.message ?? String(caught)) }
      })

      /** 轮询占位账号,直到凭据落地或超时(渠道包给登录链接留了 10 分钟)。 */
      useEffect(() => {
        if (login === null) return undefined
        let alive = true
        const timer = setInterval(async () => {
          if (Date.now() - login.startedAt > LOGIN_WINDOW_MS) {
            if (alive) { setLogin(null); setNotice(T.loginExpired) }
            return
          }
          const poll = await rpc('login.poll', { accountId: login.accountId, provider: channel.id })
            .catch(caught => ({ __failed: true, code: caught.code, message: caught.message ?? String(caught) }))
          if (!alive) return
          if (poll?.__failed === true) {
            // `pending` 这类 code 表示「还在进行中」,是流程的一部分;其余错误也继续等
            // —— 链接可能仍会完成,失败最终会以 done+success:false 回来。
            return
          }
          if (poll?.done === true) {
            setLogin(null)
            if (poll.success === false) setNotice(T.loginFailed.replace('{reason}', poll.error ?? '未知原因'))
            else {
              setNotice(T.loginDone)
              onChanged()
              await loadAccounts()
              reloadBalance()
            }
          } else if (typeof poll?.error === 'string' && poll.error !== '') {
            setLogin(null)
            setNotice(T.loginFailed.replace('{reason}', poll.error))
          }
        }, LOGIN_POLL_MS)
        return () => { alive = false; clearInterval(timer) }
      }, [login, channel.id, loadAccounts, onChanged, reloadBalance])

      /**
       * 续期:对每个账号各调一次 account.refresh(真的去换新凭据)。
       *
       * 两个要点,都是踩过才知道的:
       *
       * 1. **`account.refresh` 只回 `{success:true}`,不带新的到期时间。**
       *    想告诉用户"续到什么时候",只能刷新后再读一次 `account.list`。
       * 2. **成功不该弹警告。** 原先不管成败都 `setNotice(T.refreshWarning)`,
       *    于是点完看到的是"续期会真的去换新凭据…"这句警示语,根本判断不出结果;
       *    多账号部分失败时,error 与它还会同时挂着。现在按真实结果分开说。
       */
      const refreshAll = () => withBusy(`${channel.id}:refresh`, async () => {
        setNotice('')
        setError('')
        try {
          const rows = accounts ?? (await rpc('account.list', { provider: channel.id }))?.accounts ?? []
          if (rows.length === 0) { setNotice(T.noAccountRow); return }
          const ok = []
          const failed = []
          for (const row of rows) {
            const name = row.nickname ?? row.id
            try {
              await rpc('account.refresh', { accountId: row.id })
              ok.push(name)
            } catch (caught) {
              failed.push(`${name}: ${caught.message ?? String(caught)}`)
            }
          }
          // 先刷列表(拿到新的 expiresAt),再拼文案 —— 否则报的是旧时间。
          await loadAccounts()
          onChanged()
          reloadBalance()

          if (failed.length === 0) {
            setNotice(T.refreshOk.replace('{count}', String(ok.length)))
          } else if (ok.length === 0) {
            setError(T.refreshAllFailed.replace('{reasons}', failed.join(';')))
          } else {
            setNotice(T.refreshPartial
              .replace('{ok}', String(ok.length))
              .replace('{failed}', String(failed.length))
              .replace('{reasons}', failed.join(';')))
          }
        } catch (caught) { setError(caught.message ?? String(caught)) }
      })

      /** 一键领取。这是这个插件存在的理由:原版每日领积分的动作。 */
      const claim = () => withBusy(`${channel.id}:claim`, async () => {
        setNotice('')
        try {
          const value = await rpc('credits.claimAll', { provider: channel.id })
          setNotice(describeClaim(value))
          onChanged()
          reloadBalance()
        } catch (caught) { setError(caught.message ?? String(caught)) }
      })

      const testAccount = accountId => withBusy(`${channel.id}:test:${accountId}`, async () => {
        setNotice('')
        try {
          const value = await rpc('account.test', { accountId })
          setNotice(value?.ok === false ? T.claimFailed.replace('{reason}', value?.error ?? '') : `可用(${formatNumber(value?.ms ?? value?.latencyMs)} ms)`)
        } catch (caught) { setError(caught.message ?? String(caught)) }
      })

      /**
       * 单个账号续期。与 `refreshAll` 同样的两条:成功不弹警告、
       * 到期时间要从刷新后的账号列表里读(`account.refresh` 不回这个字段)。
       */
      const refreshOne = accountId => withBusy(`${channel.id}:refresh:${accountId}`, async () => {
        setNotice('')
        setError('')
        try {
          const target = (accounts ?? []).find(row => row.id === accountId)
          const name = target?.nickname ?? accountId
          await rpc('account.refresh', { accountId })
          const next = await loadAccounts()
          onChanged()
          reloadBalance()
          const updated = (Array.isArray(next) ? next : []).find(row => row.id === accountId)
          const at = updated?.expiresAt === undefined ? '' : formatAt(updated.expiresAt)
          setNotice(`${T.refreshOkOne.replace('{name}', name)}${at === '' ? '' : `(${T.refreshExpires.replace('{at}', at)})`}`)
        } catch (caught) { setError(caught.message ?? String(caught)) }
      })

      const toggleAccount = (accountId, enabled) => withBusy(`${channel.id}:acct:${accountId}`, async () => {
        setNotice('')
        try {
          await rpc('account.update', { accountId, patch: { enabled } })
          onChanged()
          await loadAccounts()
        } catch (caught) { setError(caught.message ?? String(caught)) }
      })

      const removeAccount = accountId => withBusy(`${channel.id}:del:${accountId}`, async () => {
        setNotice('')
        setConfirming('')
        try {
          await rpc('account.delete', { accountId })
          onChanged()
          await loadAccounts()
          reloadBalance()
        } catch (caught) { setError(caught.message ?? String(caught)) }
      })

      const toggleModel = (modelId, disabled) => withBusy(`${channel.id}:model:${modelId}`, async () => {
        setNotice('')
        try {
          await rpc('model.setDisabled', { provider: channel.id, modelId, disabled })
          await loadModels()
          onChanged()
        } catch (caught) { setError(caught.message ?? String(caught)) }
      })

      /**
       * 整渠道批量开关。
       *
       * `disabled:true` = 全部停用,`false` = 全部启用。
       * 成功后要**说清改了几个** —— 原先只是静默重载,行内按钮虽然会翻,
       * 但用户不确定到底生效没有(尤其模型多、要滚动才能看全的时候)。
       */
      const setAllModels = (disabled, affected) => withBusy(`${channel.id}:models`, async () => {
        setNotice('')
        setError('')
        try {
          await rpc('model.setAllDisabled', { provider: channel.id, disabled })
          const rows = await loadModels()
          onChanged()
          const count = Number.isFinite(affected) ? affected : (Array.isArray(rows) ? rows.length : 0)
          setNotice(T.modelsAllDone
            .replace('{action}', disabled ? T.modelOff : T.modelOn)
            .replace('{count}', String(count)))
        } catch (caught) { setError(caught.message ?? String(caught)) }
      })

      const balanceText = balance?.error !== undefined
        ? `${T.balanceFailed}:${balance.error}`
        : balance?.accounts === undefined ? T.balanceLoading : formatNumber(summarizeCredits([balance]).total)

      /**
       * 模型批量开关的"影响面":点下去会改几个。
       *
       * 有了它,按钮本身就能表达状态 —— 全部停用时「全部启用」才有数、
       * 「全部停用」置灰;反过来也一样。避免用户点了个什么都不做的按钮。
       */
      const modelRows = Array.isArray(models) ? models : []
      const modelDisabledCount = modelRows.filter(row => row?.disabled === true).length
      const modelEnabledCount = modelRows.length - modelDisabledCount
      const modelsKnown = models !== null

      const modal = login === null ? null : h('div', { className: 'ofmc-scrim' },
        h('div', { className: 'ofmc-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': `${T.loginTitle} ${channel.name}` },
          h('div', { className: 'ofmc-dialog-head' }, `${T.loginTitle} · ${channel.name}`),
          h('div', { className: 'ofmc-dialog-body' },
            h('div', { className: 'ofmc-step' }, h('span', null, T.loginStep1)),
            login.url === '' ? h('div', { className: 'ofmc-muted' }, T.loginNoUrl) : h('code', { className: 'ofmc-code' }, login.url),
            h('div', { className: 'ofmc-step' }, h('span', null, T.loginStep2)),
            h('div', { className: 'ofmc-muted' }, T.loginWaiting),
          ),
          h('div', { className: 'ofmc-acts' },
            login.url === '' ? null : h('button', { type: 'button', className: 'ofmc-btn', onClick: () => { try { window.open(login.url, '_blank', 'noopener') } catch { /* 链接就在上面 */ } } }, T.loginOpen),
            h('button', { type: 'button', className: 'ofmc-btn', onClick: () => setLogin(null) }, T.close),
          ),
        ),
      )

      return h('div', { className: 'ofmc-card ofmc-chan', 'data-provider': channel.id },
        h('span', { className: 'ofmc-stripe', style: { background: channel.accent } }),
        h('div', { className: 'ofmc-chan-head' },
          h('div', null,
            h('div', { className: 'ofmc-chan-name' }, channel.name),
            h('div', { className: 'ofmc-chan-org' }, channel.org),
          ),
          h('span', { className: stateClass }, stateText),
        ),
        h('div', { className: 'ofmc-chan-note' }, channel.note),
        h('div', { className: 'ofmc-stats' },
          h('span', { className: 'ofmc-stat' }, `${T.accountCount} `,
            h('span', { className: 'ofmc-stat-num' }, `${accountsEnabled}/${accountsTotal}`)),
          h('span', { className: 'ofmc-stat' }, `${T.modelCount} `,
            h('span', { className: 'ofmc-stat-num' }, `${modelsTotal - modelsOff}/${modelsTotal}`)),
          h('span', { className: 'ofmc-stat' }, `${creditsLabel(channel.id)} `,
            h('span', { className: 'ofmc-stat-num' }, balanceText)),
        ),
        checkinText === '' ? null : h('div', { className: 'ofmc-muted' }, checkinText),
        h('div', { className: 'ofmc-acts' },
          h('button', {
            type: 'button', className: 'ofmc-btn ofmc-btn-small',
            /**
             * ⚠️ **不能**因为 `closed` 就禁用「添加账号」。
             *
             * `closed` 只是"模型全停用了",跟能不能加账号毫无关系 —— 原版
             * (`channel-browser.tsx`)也只拿它做徽章和"已接入"计数,不拦按钮。
             * 早先这里写了 `|| closed`,于是用户把模型全停用之后,连加账号都点不动了。
             */
            disabled: busy !== '' || offline,
            onClick: startLogin,
          }, busy === `${channel.id}:add` ? T.adding : T.addAccount),
          accountsTotal > 0 ? h('button', {
            type: 'button', className: 'ofmc-btn ofmc-btn-small',
            disabled: busy !== '' || offline, title: T.refreshWarning,
            onClick: refreshAll,
          }, busy === `${channel.id}:refresh` ? T.refreshing : T.refreshAccounts) : null,
          h('button', {
            type: 'button', className: 'ofmc-btn ofmc-btn-small',
            disabled: (busy !== '' && busy !== `${channel.id}:balance`) || offline,
            onClick: () => reloadBalance(),
          }, T.refreshBalance),
          capability.claim === true ? h('button', {
            type: 'button',
            /**
             * 领不了的时候**置灰并说明原因**,而不是让用户白等一轮。
             *
             * 三种置灰各有不同理由(活动未开启 / 无签到接口 / 需手动签到),文案分开写,
             * 否则用户只知道点不动、不知道去哪解决。已领过与失败仍可点:
             * 前者是多账号场景下的复查,后者是失败重试的唯一入口。
             */
            className: claimable ? 'ofmc-btn ofmc-btn-small' : 'ofmc-btn ofmc-btn-small ofmc-btn-done',
            disabled: busy !== '' || offline || !claimable,
            title: claimHint,
            onClick: claim,
          }, busy === `${channel.id}:claim` ? T.claiming : claimLabel) : null,
          h('button', { type: 'button', className: 'ofmc-fold', 'data-open': open === 'accounts' ? 'true' : 'false', onClick: () => void toggle('accounts') },
            h('span', null, `› ${T.foldAccounts}`), accounts === null ? null : ` (${accounts.length})`),
          h('button', { type: 'button', className: 'ofmc-fold', 'data-open': open === 'models' ? 'true' : 'false', onClick: () => void toggle('models') },
            h('span', null, `› ${T.foldModels}`), models === null ? null : ` (${models.length})`),
        ),
        notice === '' ? null : h('div', { className: 'ofmc-ok' }, notice),
        error === '' ? null : h('div', { className: 'ofmc-error-text' }, error),

        open === 'accounts' ? h('div', { className: 'ofmc-list' },
          (accounts ?? []).length === 0 ? h('div', { className: 'ofmc-muted' }, T.noAccounts) : null,
          (accounts ?? []).map(account => h('div', { key: account.id, className: 'ofmc-item' },
            h('span', { className: 'ofmc-provider' }, account.nickname ?? account.id),
            h('span', { className: 'ofmc-text' },
              balance?.accounts?.find(row => row.accountId === account.id) === undefined
                ? (account.enabled === false ? T.accountOff : '')
                : describeAccount(balance.accounts.find(row => row.accountId === account.id))),
            account.expiresAt === undefined ? null : h('span', { className: 'ofmc-muted' }, `${T.expires} ${formatAt(account.expiresAt)}`),
            h('span', { className: 'ofmc-acctacts' },
              h('button', { type: 'button', className: 'ofmc-minibtn', disabled: busy !== '' || offline, onClick: () => testAccount(account.id) },
                busy === `${channel.id}:test:${account.id}` ? T.testing : T.test),
              h('button', { type: 'button', className: 'ofmc-minibtn', disabled: busy !== '' || offline, title: T.refreshWarning, onClick: () => refreshOne(account.id) },
                T.refreshAccounts),
              h('button', { type: 'button', className: 'ofmc-minibtn', disabled: busy !== '' || offline, onClick: () => toggleAccount(account.id, account.enabled === false) },
                account.enabled === false ? T.accountOn : T.accountOff),
              h('button', {
                type: 'button',
                className: confirming === account.id ? 'ofmc-minibtn ofmc-minibtn-danger' : 'ofmc-minibtn ofmc-minibtn-danger',
                disabled: busy !== '' || offline,
                onClick: () => confirming === account.id ? removeAccount(account.id) : setConfirming(account.id),
              }, confirming === account.id ? T.deleteConfirm : T.delete),
              confirming === account.id ? h('button', { type: 'button', className: 'ofmc-minibtn', disabled: busy !== '' || offline, onClick: () => setConfirming('') }, T.cancel) : null,
            ),
          )),
        ) : null,

        open === 'models' ? h('div', { className: 'ofmc-list' },
          h('div', { className: 'ofmc-acts' },
            /**
             * 整渠道批量开关。名字写全(不再是看不懂的「停用×」),并带上会改动几个。
             *
             * 没事可做时置灰:全部已停用时「全部停用」不亮,反之亦然 ——
             * 免得用户点了才发现没变化。
             */
            h('button', {
              type: 'button', className: 'ofmc-minibtn',
              disabled: busy !== '' || offline || !modelsKnown || modelEnabledCount === 0,
              title: T.modelDisableAll,
              onClick: () => setAllModels(true, modelEnabledCount),
            }, `${T.modelDisableAll}(${modelEnabledCount})`),
            h('button', {
              type: 'button', className: 'ofmc-minibtn',
              disabled: busy !== '' || offline || !modelsKnown || modelDisabledCount === 0,
              title: T.modelEnableAll,
              onClick: () => setAllModels(false, modelDisabledCount),
            }, `${T.modelEnableAll}(${modelDisabledCount})`),
          ),
          (models ?? []).length === 0 ? h('div', { className: 'ofmc-muted' }, T.noModels) : null,
          (models ?? []).map(model => h('div', { key: model.id, className: 'ofmc-item' },
            h('span', { className: 'ofmc-text', title: model.id }, model.name ?? model.id),
            model.isFree === true ? h('span', { className: 'ofmc-tagpill ofmc-tagpill-free' }, T.modelFree) : null,
            model.dead === true ? h('span', { className: 'ofmc-tagpill ofmc-tagpill-dead' }, T.modelDead) : null,
            h('button', {
              type: 'button', className: 'ofmc-minibtn', disabled: busy !== '' || offline,
              onClick: () => toggleModel(model.id, model.disabled !== true),
            }, model.disabled === true ? T.modelOn : T.modelOff),
          )),
        ) : null,

        modal,
      )
    }

    function Page() {
      const [data, setData] = useState(null)
      const [statuses, setStatuses] = useState(null)
      const [balances, setBalances] = useState({})
      const [error, setError] = useState('')
      const [loading, setLoading] = useState(true)
      const [busy, setBusy] = useState('')
      const [notice, setNotice] = useState('')
      /**
       * 网关离线是一份**独立**的状态,不是一条 error 文案。
       *
       * 原实现把两者混在一起:一次 `/status` 失败就 `error !== ''`,而屏幕上每个
       * 按钮都写着 `disabled: error !== ''` —— 于是「网关没跑」会把整页锁死,
       * 连「刷新」都点不动。这正是这一页之前完全没法用的原因。
       * 分开之后:offline 只让**操作**失效,页面结构、诊断信息、恢复按钮照常可用。
       */
      const [gateway, setGateway] = useState({ up: null, startable: false, startScript: '', error: '', revision: null, route: null })

      /** 问一次网关健康状态。宿主这条永远走 200,所以失败只意味着 HTTP 层坏了。 */
      const checkGateway = useCallback(async () => {
        try {
          const health = await api('/health')
          setGateway({
            up: health?.up === true,
            startable: health?.startable === true,
            startScript: health?.startScript ?? '',
            error: health?.up === true ? '' : (health?.error ?? ''),
            revision: typeof health?.revision === 'number' ? health.revision : null,
            // 最近一次「模型列表同步到 DSH 配置」的结果,由宿主回显。
            route: health?.route ?? null,
          })
          return health?.up === true
        } catch (caught) {
          setGateway({ up: false, startable: false, startScript: '', error: caught.message ?? String(caught), revision: null, route: null })
          return false
        }
      }, [])

      const refresh = useCallback(async () => {
        try {
          setData(await api('/status'))
          setError('')
          setGateway(current => ({ ...current, up: true, error: '' }))
        } catch (caught) {
          // 离线时不把它当「错误」显示 —— 横幅已经说清楚了,重复两遍只会吵。
          if (caught.offline === true) setGateway(current => ({ ...current, up: false, error: caught.message ?? String(caught) }))
          else setError(caught.message ?? String(caught))
        } finally {
          setLoading(false)
        }
      }, [])

      const loadStatuses = useCallback(async () => {
        try {
          const value = await rpc('provider.status', { providers: PROVIDER_IDS })
          setStatuses(value?.statuses ?? {})
        } catch (caught) {
          if (caught.offline !== true) setError(caught.message ?? String(caught))
        }
      }, [])

      /** 余额要逐个渠道打上游,所以放到后台慢慢填,不挡着卡片先画出来。 */
      const loadBalances = useCallback(async () => {
        try {
          const value = await api('/balance')
          const next = {}
          for (const row of value?.balances ?? []) next[row.provider] = row
          setBalances(next)
        } catch { /* 单渠道失败会以 row.error 的形式回来;整体失败就留给按钮重试 */ }
      }, [])

      const reloadBalance = useCallback(async provider => {
        try {
          const value = await api(`/balance?provider=${encodeURIComponent(provider)}`)
          const row = (value?.balances ?? [])[0]
          if (row !== undefined) setBalances(current => ({ ...current, [row.provider]: row }))
        } catch (caught) {
          setBalances(current => ({ ...current, [provider]: { provider, accounts: [], error: caught.message ?? String(caught) } }))
        }
      }, [])

      /**
       * 首次进来:先问一次网关,再决定要不要拉数据。
       *
       * 网关没跑时**不再白等**那两串必然失败的请求(余额那一串每个渠道都要超时),
       * 只把结构画出来;但仍要把 `loading` 收掉 —— 否则「刷新」按钮会永远禁用,
       * 连手动重试的路都没有。
       */
      useEffect(() => {
        void (async () => {
          const up = await checkGateway()
          if (!up) { setLoading(false); return }
          await refresh()
          void loadStatuses()
          void loadBalances()
        })()
      }, [checkGateway, refresh, loadStatuses, loadBalances])

      const onChanged = useCallback(() => { void loadStatuses(); void refresh() }, [loadStatuses, refresh])

      const withBusy = useCallback(async (key, fn) => {
        setBusy(key)
        try { return await fn() } finally { setBusy('') }
      }, [])

      /**
       * 网关恢复后把三份数据一次补齐。
       *
       * 三份都要:`/status` 给「上次 / 结果 / 逐渠道文字」,`provider.status` 给卡片
       * 上的账号与模型数,`/balance` 给剩余积分。只补前两者的话,页面看着活了,
       * 但「结果」一直是「(还没有记录)」—— 实测踩过这个坑。
       */
      const loadEverything = useCallback(async () => {
        await refresh()
        void loadStatuses()
        void loadBalances()
      }, [refresh, loadStatuses, loadBalances])

      /** 启动网关:宿主会拉起 start.bat 并轮询到它应答,所以拿到 ok 就是真的起来了。 */
      const startGateway = () => withBusy('gateway-start', async () => {
        setNotice('')
        try {
          const started = await api('/start', { method: 'POST', body: JSON.stringify({}) })
          setNotice(T.gwStarted)
          setGateway(current => ({ ...current, up: true, error: '' }))
          // 已经在跑时宿主只回报 already,不会有别的副作用;数据照拉不误。
          void started
          await loadEverything()
        } catch (caught) {
          setNotice(T.gwStartFailed.replace('{reason}', caught.message ?? String(caught)))
        }
      })

      /** 重试:重新问健康状态;通了就把三份数据补齐。 */
      const retryGateway = () => withBusy('gateway-retry', async () => {
        setNotice('')
        const up = await checkGateway()
        if (!up) { setNotice(T.gwStillDown); return }
        setNotice(T.gwStarted)
        await loadEverything()
      })

      /**
       * 立刻把「当前可路由的模型」同步进 DSH 的配置(不等宿主那 1.2 秒防抖)。
       *
       * 用户改完模型启停后,DSH 的模型选择器**不会**自己变 —— 那里面是
       * cordis.patch.yml 里的静态快照。点这个按钮能把配置对齐,但要让选择器
       * 真的变,还是得重启 DSH。
       */
      const syncRouteNow = () => withBusy('route-sync', async () => {
        setNotice('')
        try {
          const result = await api('/route-sync', { method: 'POST', body: JSON.stringify({}) })
          setGateway(current => ({ ...current, route: result?.route ?? result ?? null }))
          if (result?.ok === true) {
            setNotice(T.routeSynced.replace('{count}', String(result?.models ?? '?')))
          } else {
            setNotice(T.routeFailed.replace('{reason}', result?.error ?? '未知原因'))
          }
        } catch (caught) {
          setNotice(T.routeFailed.replace('{reason}', caught.message ?? String(caught)))
        }
      })

      /**
       * 一次失败的归类:离线失败归到网关状态(触发横幅 + 恢复按钮),
       * 其余才是「操作失败」。会话中途网关被关掉时就走这条。
       */
      const reportFailure = useCallback(caught => {
        if (caught?.offline === true) {
          setGateway(current => ({ ...current, up: false, error: caught.message ?? String(caught) }))
          return
        }
        setError(caught?.message ?? String(caught))
      }, [])

      const state = data?.autoCheckin ?? null
      /**
       * 重试本轮失败的渠道。
       *
       * 这是「整轮重跑」的**真实替代品**:整轮那条路被渠道包的按天闸挡住
       * (`runIfDue` 今天跑过就直接返回,实测 0 秒空转、状态不变),而单渠道的
       * `credits.claimAll` 是另一条路 —— 它会真的请求上游(实测 0.2s 有往返),
       * 已领的返回 `already-claimed`,失败的会真的重试一次。
       *
       * 所以失败之后想再试,只有这里有用。
       */
      const retryFailed = () => withBusy('retry-failed', async () => {
        setNotice('')
        const failedProviders = (Array.isArray(state?.channels) ? state.channels : [])
          .filter(row => Array.isArray(row?.flags) && row.flags.includes('failed'))
          .map(row => row.provider)
        if (failedProviders.length === 0) { setNotice(T.retryNone); return }
        const parts = []
        for (const provider of failedProviders) {
          try {
            const value = await rpc('credits.claimAll', { provider })
            const summary = value?.summary ?? value
            const got = Number(summary?.claimed ?? 0)
            const credit = Number(summary?.totalCredit ?? 0)
            const failedRow = (value?.results ?? []).find(row => row?.outcome?.kind === 'failed')
            parts.push(failedRow
              ? `${provider}: ${failedRow.outcome.message}`
              : `${provider}: ${got > 0 ? `+${credit}` : '已领'}`)
          } catch (caught) {
            parts.push(`${provider}: ${caught.message ?? String(caught)}`)
          }
        }
        setNotice(T.retryFailedDone.replace('{summary}', parts.join(';')))
        await loadEverything()
      })

      const scheduler = data?.scheduler ?? null
      const enabled = state?.enabled === true
      const running = state?.running === true
      const signedToday = typeof state?.lastDate === 'string' && state.lastDate === todayKey()
      /** 本轮失败的渠道数 —— 决定要不要露出「重试失败的渠道」。 */
      const failedCount = (Array.isArray(state?.channels) ? state.channels : [])
        .filter(row => Array.isArray(row?.flags) && row.flags.includes('failed')).length
      const channelRows = Array.isArray(state?.channels) ? state.channels : []
      const byProvider = new Map(channelRows.map(row => [row.provider, row]))
      const summary = summarizeCredits(Object.values(balances))

      const refreshAllBalances = () => withBusy('balances', loadBalances)

      async function runAll() {
        setBusy('all')
        setNotice('')
        const before = state?.lastAt ?? 0
        try {
          await api('/run', { method: 'POST', body: JSON.stringify({}) })
          setNotice(T.waiting)
          // 网关是触发即返回:轮询到本轮真正落定为止(渠道包失败时故意不写 lastDate,
          // 所以除了日期,也认 lastAt 的变化)。
          for (let attempt = 0; attempt < POLL_TRIES; attempt += 1) {
            await sleep(POLL_MS)
            const next = await api('/status')
            setData(next)
            const current = next?.autoCheckin
            if (current && current.running !== true && (current.lastAt !== before || current.lastDate === todayKey())) {
              setNotice(T.finished)
              return
            }
          }
          setNotice(T.slow)
        } catch (caught) {
          reportFailure(caught)
        } finally {
          setBusy('')
          await refresh()
          await loadBalances()
        }
      }

      async function toggle() {
        setBusy('toggle')
        setNotice('')
        try {
          const result = await api('/enabled', { method: 'POST', body: JSON.stringify({ enabled: !enabled }) })
          setData(current => ({ ...(current ?? {}), autoCheckin: result.autoCheckin ?? current?.autoCheckin ?? null }))
          setNotice(enabled ? T.disableHint : T.enableHint)
        } catch (caught) {
          reportFailure(caught)
        } finally {
          setBusy('')
          await refresh()
        }
      }

      const offline = gateway.up === false
      const blocked = offline || error !== ''
      // 宿主半身版本对不上 = 直接改文件没生效,得重启 DSH。趁早说出来,
      // 免得用户以为"改的代码没用"。
      const staleHost = gateway.revision !== null && gateway.revision !== EXPECTED_REVISION

      // 模型列表同步状态(见下面那张卡片的说明)。`ok === null` = 还没同步过。
      const route = gateway.route ?? null
      const routePending = route?.pending === true
      const routeOk = route?.ok === true
      const routeBad = route?.ok === false
      const routeModels = route?.models ?? '?'
      const routeError = String(route?.error ?? '未知原因')

      return h(Fragment, null,
        h('style', null, CSS),
        h('div', { className: 'ofmc-root' },
          h('div', { className: 'ofmc-head' },
            h('h3', { className: 'ofmc-title' }, T.nav),
            h('div', { className: 'ofmc-row' },
              offline
                ? h('span', { className: 'ofmc-pill ofmc-pill-off' }, T.gwOfflineHint)
                : h('span', { className: 'ofmc-muted' }, enabled ? T.on : T.off),
              h('button', {
                type: 'button',
                className: 'ofmc-switch',
                role: 'switch',
                'aria-checked': enabled,
                'aria-label': T.nav,
                title: enabled ? T.disableHint : T.enableHint,
                // 离线时开关也要禁用 —— 它最终要写网关,点了只会失败。
                // 「能操作的东西」留给下面横幅里的启动 / 重试两个按钮。
                disabled: busy !== '' || loading || offline,
                onClick: toggle,
              }, h('span', { className: 'ofmc-switch-thumb' })),
            ),
          ),

          /**
           * 网关离线横幅 —— 只提示,不挡路。
           *
           * 关键差别:这里给的是**恢复动作**(启动 / 重试),而页面下面照常渲染,
           * 按钮各自按 `blocked` 变灰。原实现是整页替换成一块红框 + 全体 disabled,
           * 于是「网关没跑」= 什么也做不了。
           */
          offline && h('div', { className: 'ofmc-error' },
            h('div', { className: 'ofmc-error-title' }, T.gwTitle),
            gateway.error !== '' ? h('div', { className: 'ofmc-error-text' }, gateway.error) : null,
            h('div', { className: 'ofmc-muted' }, T.gwWhy),
            h('div', { className: 'ofmc-row' },
              gateway.startable
                ? h('button', {
                  type: 'button', className: 'ofmc-btn ofmc-btn-primary',
                  disabled: busy !== '',
                  onClick: startGateway,
                }, busy === 'gateway-start' ? T.gwStarting : T.gwStart)
                : null,
              h('button', {
                type: 'button', className: 'ofmc-btn',
                disabled: busy !== '',
                onClick: retryGateway,
              }, busy === 'gateway-retry' ? T.gwChecking : T.gwRetry),
            ),
            gateway.startScript !== '' && h('div', { className: 'ofmc-row' },
              h('span', { className: 'ofmc-muted' }, T.gwManual),
              h('code', { className: 'ofmc-code', style: { flex: 1, minWidth: 220 } }, gateway.startScript),
            ),
          ),

          /** 非离线的错误(网关在跑,但某个操作真的失败)—— 单独一条,不影响整体。 */
          !offline && error !== '' && h('div', { className: 'ofmc-error' },
            h('div', { className: 'ofmc-error-title' }, T.loadFailed.replace('{reason}', '')),
            h('div', { className: 'ofmc-error-text' }, error),
          ),

          /**
           * 宿主半身版本对不上。与网关在不在跑无关,所以单独一条:
           * 它解释的是"为什么页面上没有新功能",处理办法只有重启 DSH。
           */
          staleHost && h('div', { className: 'ofmc-error' },
            h('div', { className: 'ofmc-error-title' }, T.gwStaleTitle),
            h('div', { className: 'ofmc-error-text' },
              T.gwStale.replace('{revision}', String(gateway.revision)).replace('{expected}', String(EXPECTED_REVISION))),
          ),

          /**
           * 模型列表与 DSH 配置的对齐状态。
           *
           * 这一行解释的是一个很容易被误当成 bug 的现象:在插件里只启用了一个
           * 模型,DSH 的模型选择器里却还列着一堆。原因是 DSH 的模型列表来自
           * cordis.patch.yml 里的**静态快照**,运行时不会去问网关。
           *
           * 所以这里把「上次同步成几个模型」明明白白写出来,并给一个立即同步的
           * 按钮 —— 同步之后重启 DSH,选择器里就只剩真正可用的那些。
           */
          !offline && h('div', { className: 'ofmc-card' },
            h('div', { className: 'ofmc-row' },
              h('span', { className: 'ofmc-muted' },
                routePending
                  ? T.routePending
                  : routeOk
                    ? T.routeSynced.replace('{count}', String(routeModels))
                    : routeBad
                      ? T.routeFailed.replace('{reason}', routeError)
                      : T.routeNever),
              h('button', {
                type: 'button',
                className: 'ofmc-btn',
                disabled: busy !== '',
                title: T.routeNever,
                onClick: syncRouteNow,
              }, busy === 'route-sync' ? T.routeSyncing : T.routeSyncNow),
            ),
          ),

          h('div', { className: 'ofmc-card' },
            h('div', { className: 'ofmc-row' },
              h('button', {
                type: 'button',
                className: 'ofmc-btn ofmc-btn-primary',
                /**
                 * 今天已签过就**置灰**。
                 *
                 * 原先这里写「再签一次」并且可点,但渠道包 `runIfDue` 按天去重,
                 * 点下去 0 秒返回、什么都不做(实测 lastAt 不变)。按钮名骗人,
                 * 比报错更糟 —— 用户会以为重新签过了。现在如实置灰并给出原因。
                 */
                disabled: busy !== '' || loading || blocked || signedToday,
                title: signedToday ? T.rerunBlockedWhy : '',
                onClick: runAll,
              }, busy === 'all' ? T.running : (signedToday ? T.rerunBlocked : T.run)),
              /**
               * 失败重试 —— 整轮被按天闸挡住之后,这是**唯一**真能再试的入口。
               * 只在本轮确实有 failed 渠道时出现,平时不占地方。
               */
              failedCount > 0 ? h('button', {
                type: 'button', className: 'ofmc-btn',
                disabled: busy !== '' || offline,
                title: T.retryFailedWhy,
                onClick: retryFailed,
              }, busy === 'retry-failed' ? T.claiming : `${T.retryFailed}(${failedCount})`) : null,
              h('button', { type: 'button', className: 'ofmc-btn', disabled: loading, onClick: refresh }, T.refresh),
              running && h('span', { className: 'ofmc-pill' }, T.inFlight),
              signedToday && h('span', { className: 'ofmc-pill' }, T.signedToday),
            ),
            h('div', null,
              h('span', { className: 'ofmc-label' }, T.last),
              state?.lastDate
                ? `${state.lastDate}${formatAt(state.lastAt) !== '' ? `(${formatAt(state.lastAt)})` : ''}`
                : T.none,
            ),
            h('div', null, h('span', { className: 'ofmc-label' }, T.result), state?.lastResult || T.none),
            h('div', null,
              h('span', { className: 'ofmc-label' }, T.schedule),
              scheduler?.at ? `每天 ${scheduler.at} 之后检查一次` : T.noSchedule,
            ),
            notice !== '' && h('div', { className: 'ofmc-ok' }, notice),
            h('div', { className: 'ofmc-muted' }, T.why),
          ),

          h('div', { className: 'ofmc-card' },
            h('div', { className: 'ofmc-head' },
              h('div', { className: 'ofmc-row' },
                h('span', { className: 'ofmc-card-title' }, `${T.channels}(${CHANNELS.length})`),
                summary.accounts > 0 && h('span', { className: 'ofmc-stat' }, `${T.total} `,
                  h('span', { className: 'ofmc-total' }, `${formatNumber(summary.total)} ${summary.units.join('/') || 'credits'}`)),
              ),
              h('div', { className: 'ofmc-row' },
                h('span', { className: 'ofmc-muted' }, T.channelsHint),
                h('button', {
                  type: 'button', className: 'ofmc-btn ofmc-btn-small',
                  disabled: busy !== '' || offline,
                  onClick: refreshAllBalances,
                }, busy === 'balances' ? T.balanceLoading : T.refreshBalance),
              ),
            ),
            statuses === null
              ? h('div', { className: 'ofmc-muted' }, offline ? T.gwWhy : (gateway.up === null ? T.loadingStatus : T.notReady))
              : null,
            h('div', { className: 'ofmc-grid' },
              CHANNELS.map(channel => h(ChannelCard, {
                key: channel.id,
                channel,
                status: statuses?.[channel.id] ?? null,
                balance: balances[channel.id],
                claimed: byProvider.get(channel.id)?.claimed === true,
                checkinText: byProvider.get(channel.id)?.text ?? '',
                // 网关已经把逐渠道结果归好类了(claimed / inactive / failed /
                // unsupported / manual),界面之前只用了 claimed,别的都丢掉了。
                flags: byProvider.get(channel.id)?.flags ?? [],
                busy,
                withBusy,
                onChanged,
                reloadBalance: () => void reloadBalance(channel.id),
                // 离线时卡片只看不点:结构保留(能看到有哪些渠道、各自什么身份),
                // 但每个操作按钮都不该假装能成功。
                offline,
              })),
            ),
          ),
        ),
      )
    }

    function apply(ctx) {
      // ctx.slots.inject 会在该槽出现(或稍后才可用)时再登记,所以不需要
      // dsh.client.inject 预声明 —— 槽不在时本插件只是不显示,不会报错。
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'ofm-checkin',
        order: 36,
        label: () => T.nav,
      }, () => h(Page)))
    }

    exports.name = 'ofm-checkin'
    exports.inject = inject
    exports.apply = apply
    exports.__test = {
      Page, ChannelCard, CHANNELS, CREDITS, CSS, T, EXPECTED_REVISION,
      todayKey, formatAt, formatNumber, describeAccount, summarizeCredits, describeClaim, creditsLabel,
    }
    return module.exports
  },
})
