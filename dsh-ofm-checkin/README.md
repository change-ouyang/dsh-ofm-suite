# dsh-ofm-checkin — DSH 里的「每日签到」

给 DSH 界面加一个设置分区(**设置 → 每日签到**):上面是签到状态与自动签到开关,
下面是原版那 13 个渠道的卡片 —— 渠道名 / 机构 / 说明、账号 N/M、模型 (M−停用)/M、
剩余积分,以及**添加账号、续期、刷新余额、一键领取**;展开还有逐账号(测试 / 续期 / 停用 /
删除)和逐模型(启用 / 停用)的操作。已经领过的渠道,按钮直接写「已领取」。

它**不自己签到**：真正的执行由本机 [ofm-free-gateway](../dsh-ofm-free-gateway) 完成，
本插件只是同源代理 + 一层界面。

> **改完这个目录下的文件,一定要重启 DSH。** 插件是宿主进程启动时加载的,改文件不会
> 热更新。页面顶部会在 `/health` 的 `revision` 对不上时直接告诉你这件事
> (「插件代码没生效」),别当成 bug 去查。

## 目录

- [网关没跑时页面还能用](#网关没跑时页面还能用) —— 离线横幅 + 启动网关按钮
- [按钮什么时候能点](#按钮什么时候能点)
- [「续期」是什么](#续期是什么以及结果怎么说)
- [模型批量开关](#模型批量开关)
- [把模型接进 DSH](#把模型接进-dsh) —— 含**模型列表自动同步**(改完启停会自己重写配置)
- [为什么是代理](#为什么是代理)
- [结构](#结构) / [安装](#安装已装好) / [验证](#验证) / [故障排查](#故障排查)

## 网关没跑时页面还能用

这一条是后来的重点修正。原先的处理是「一次请求失败 ⇒ 整页换成红框 + 所有按钮
禁用」,而网关没跑恰恰是最常见的状态 —— 结果是**一进这一页就什么也做不了**,连
「刷新」都点不动,用户唯一能做的只有去手工找 start.bat。

现在的分工:

| 状态 | 页面表现 |
| --- | --- |
| 网关在跑 | 正常:状态、13 张卡片、余额、各项操作全可用 |
| 网关没跑 | **横幅说明 + 一个「启动网关」按钮**(宿主真的去拉起 start.bat 并等它应答);13 张卡片照常渲染,渠道身份仍可读;各操作按钮置灰 |
| 会话中途网关挂了 | 失败被归类成「离线」,横幅自动出现,恢复动作仍是那两个按钮 |

几个刻意的选择:

- **离线是一份独立状态,不是一条错误文案**。宿主给 `/api/ofm-checkin/health`,
  它**永远返回 200** —— 「网关没跑」对界面而言是正常情报,不是请求失败。只有
  连接层失败(ECONNREFUSED / 连接被重置)才算离线;网关自己回的 401/400/502
  仍按业务错误如实显现,不会被误判成「需要启动」。
- **启动是幂等的**。`/start` 先探活,网关已经在跑就直接回 `already:true`,**绝不
  再 spawn 一个** —— 两个网关会各起一个渠道 Worker 写同一份 `channel-pack/*.json`,
  互相把对方的刷新令牌用掉(就是 `STS5.1806` 那类报错的成因之一)。
- **spawn 失败不能崩宿主**。`spawn` 的错误是**异步**的:可执行文件或 cwd 不存在
  时,Node 对没有 `error` 监听的子进程直接抛未捕获异常 —— 那会**把整个 DSH 带走**。
  所以 `launchGateway` 等一个 spawn/error 的赛跑,并把不存在的 cwd 提前挡掉
  (否则报出来的是误导性的 `spawn <exe> ENOENT`,看起来像「找不到 cmd.exe」)。
- **离线时 `loading` 也要收掉**,否则「刷新」按钮永远禁用,连手动重试的路都没有。


## 按钮什么时候能点

界面上的「能不能点」来自**网关已经归好的类**(`/checkin` 每行的 `flags`),不是前端猜的:

| 渠道状态 | `flags` | 领取按钮 |
| --- | --- | --- |
| 已领过 | `claimed` | 写「已领取」,**仍可点**(多账号复查;渠道包有 `already-claimed` 预检,不会重复发放) |
| 本轮有失败 | `failed` | 写「一键领取」,**可点**(失败重试的唯一出口) |
| 活动未开启 | `inactive` | 写「活动未开启」,**置灰** —— 渠道包不发请求,点了是白等 |
| 无签到接口 | `unsupported` | 不渲染按钮(能力表里没有 `claim`) |
| 需手动签到 | `manual` | 写「需手动签到」,**置灰** |

`failed` 优先于 `claimed`:一个渠道多个账号时可能部分领到、部分失败,这时必须还能点,
否则失败的那几个账号再没有入口。

`status` 还没加载时(`accountsTotal` 是 0)不算「没有账号」—— 否则首帧所有按钮会集体
置灰再亮起来,像闪了一下坏掉。只有**已知**为 0 才拦。

### 「整轮」按钮为什么不能重跑

渠道包的 `runIfDue` 有按天闸(`auto-checkin.ts`):

```js
if (doc.lastDate !== '' && doc.lastDate === today()) return Promise.resolve()
```

所以**今天跑过之后整轮不会再跑** —— 实测点击 0 秒返回、`lastAt` 一微秒都不变。
原先按钮在这种情况下仍写「再签一次」且可点,名不副实。现在:

- 今天已签 → 按钮写「今天已签」并置灰,`title` 说明原因
- 本轮有失败 → 额外出现「重试失败的渠道(N)」,逐个调 `credits.claimAll`
  (实测这条**会**真的请求上游,0.2s 有往返),这是失败后唯一有用的路径

渠道包没有 force 入口,所以「整轮强制重签」做不到,界面就不假装能做到。

## 「续期」是什么,以及结果怎么说

**续期 ≠ 续费。** 它拿账号里存的 `refresh_token` 去上游换一套新的 `access_token`,
再把新的过期时间写回账号池 —— 不花钱、不涉及订阅、不影响积分。

两个层级:卡片上的「续期」刷该渠道**全部**账号;展开「› 账号」后的「续期」只刷那一个。

**平时不需要点。** 网关自己会续,两条机制都在跑:

```js
const REFRESH_INTERVAL_MS = 30 * 60 * 1e3   // 每 30 分钟扫一遍全部渠道
// 外加每个渠道的 RefreshScheduler:过期前 1 小时自动续
```

所以这个按钮是**手动兜底**:自动续期失败、刚重新登录想立刻生效、或已过期要自救时才用。
反过来说,**不要为了"保险"去点它** —— 刷新令牌是一次性的,多刷只是增加轮换次数。

### 结果必须说清楚(已修)

原先不管成败,点完都 `setNotice(T.refreshWarning)`,于是:

- 成功时看到的是「续期会真的去换新凭据…」这句**警示语**,判断不出到底成没成
- 多账号部分失败时,`error` 与这句警告同时挂着,互相打架

现在按真实结果分开说:

| 情况 | 显示 |
| --- | --- |
| 全部成功 | 「已续期 N 个账号。」 |
| 部分失败 | 「A 个成功,B 个失败:账号名: 原因;…」 |
| 全部失败 | 走 error 通道:「续期失败:…」,不假装成功 |
| 单账号 | 「已续期 账号名(新到期时间 …)」 |

⚠️ **`account.refresh` 只回 `{success:true}`,不带新的到期时间。**
想显示"续到什么时候",必须刷新后再读一次 `account.list` —— 实测确认
(workbuddy 续期后 `expiresAt` 从 `21:35:59` 变成 `21:36:04`,只靠 refresh 的返回值拿不到)。

`refreshWarning` 现在只作为按钮的 `title`(悬停提示),不再当结果文案用。

## 模型批量开关

展开「› 模型」后,列表顶部有两个按钮:

```
「全部停用(8)」  「全部启用(1)」
```

括号里是**点下去会改动几个**。全部已停用时「全部停用」置灰,反之亦然 —— 免得点了才发现没变化。
点完会说「已停用 8 个模型」,不是静默重载。

⚠️ 这两个按钮原先写的是 `停用×` / `启用×`(那个 `×` 想表达"全部"),没人看得懂,
用户直接问"没有全选停用吗"。现在写全并带上计数。

**注意:停用的模型不会出现在网关的 `/v1/models` 里**([server.mjs](../dsh-ofm-free-gateway/server.mjs)
的 `handleModels` 里有 `if (model.disabled === true) continue`)。所以这里就是
"DSH 里能选到哪些模型"的开关 —— 改完之后宿主会自动同步配置,但**仍然要重启 DSH**
才刷新选择器(见下)。

### 模型全停用后,徽章为什么不跟着变

渠道包的 `closed` 字段算法是:

```js
closed: total > 0 && disabled === total      // channel-pack-rpc.ts
```

也就是说 **`closed` 只表示"所有模型都停用了"**,全项目里没有"渠道本身关闭"这个概念
(`provider.setEnabled(false)` 也只是把模型全部停用)。

点「全部停用」后,这个字段会变 true,但**徽章不回显它** —— 徽章只表达「渠道连没连上」
(有账号就「已开启」,没账号就「未登录」)。理由:模型行旁边就是「全部停用/启用」按钮,
启停状态已经摆在那了,徽章再叠一个「模型全停用」只会让人以为渠道或账号出了问题。
这个位置的历史沿革:最早写「已关闭」(像账号断了),后来改「模型全停用」照实说,最后
按用户反馈定为**不掺模型状态、保持「已开启」**。

⚠️ 另外:**「添加账号」不能因为 `closed` 就置灰。** 加账号跟模型启停毫无关系
(原版 `channel-browser.tsx` 也只拿 `closed` 做徽章和"已接入"计数,不拦按钮)。
早先这里写了 `|| closed`,导致模型全停用后连加账号都点不动。

## 把模型接进 DSH

网关自带一个注册脚本,把 `/v1/models` 的当前快照写进 profile 的 `cordis.patch.yml`:

```powershell
cd <网关仓库目录>\dsh-ofm-free-gateway
node scripts/make-dsh-provider.mjs --key <网关密钥>            # 只写"当前可路由"的
node scripts/make-dsh-provider.mjs --key <密钥> --dry-run      # 只看不写
node scripts/make-dsh-provider.mjs --remove                    # 撤销本脚本写入的段
```

写入后在 DSH 里会多一个 `OFM 免费渠道网关` 路由,模型 id 形如 `buddy/deepseek-v4-flash`。

### 快照式是 DSH 的机制,绕不过去 —— 但「手动重跑」已经自动化了

⚠️ **它是快照式的**:跑的那一刻把模型列表写死成 YAML。DSH 在运行时**不会**去问网关
「你现在有哪些模型」—— llm-pi-ai 的源码把这件事写得很直白:

```
cordis.patch.yml remains the only thing that decides what a route serves.
```

所以在插件里改了模型启停之后,**必须重启 DSH** 才看得到新的条目。这是 DSH 加载配置的
方式,绕不过去,本插件也没打算绕(得改宿主)。

但另一半是可以补的:**「得手动重跑脚本」现在不用了**。原先的流程是
改启停 → 自己去敲 `make-dsh-provider.mjs` → 重启 DSH,漏掉中间那步就会看到旧列表,
而且看不出来漏了。现在宿主会代劳:

| 事件 | 宿主做什么 |
| --- | --- |
| 任何**会改变可路由模型集合**的 RPC 成功后 | 防抖 1.2 秒,后台重跑注册脚本 |
| 点界面上的「立即同步」 | 不等防抖,立刻跑一次,结果直接回显 |

会触发同步的方法(`MODEL_MUTATIONS`):`model.setDisabled` / `setDisabledMany` /
`setAllDisabled` / `clearDead`、`gateway.setEnabled` / `provider.setEnabled`、
`account.create` / `account.delete` / `account.update`。账号增删**和启停**都算,因为
「渠道有可用的账号」才谈得上可路由 —— 停用最后一个账号和删掉它,对 `/v1/models`
的 `x-provider-ready` 是一回事,没账号的渠道写进配置只会得到一个必然失败的条目。

另外两个按**返回值**判定的触发点(不在 `MODEL_MUTATIONS` 方法表里):

- **登录完成**(`login.poll` 返回 `done:true`)—— 这才是凭据落地、新账号的模型从
  「不可路由」变「可路由」的时刻(`account.create` 那下还只是占位账号,早于真正登录)。
- **只看业务成功**:网关对 RPC 失败也回 HTTP 200 + 信封 `{ok:false}`,若只看状态码,
  失败也会被当成成功触发同步(白跑一遍还误报「已同步」)。所以判据是 `ok === true`。

`credits.claimAll` / `account.refresh` **不**触发:它们不改变模型集合,同步纯属白跑。

所以现在的完整流程是:**插件里改启停 → 页面提示「已同步 N 个模型」→ 重启 DSH**。
中间那条命令不用手敲了,但**重启这步仍然是必须的** —— 同步只保证「重启后看到的一定是对的」。

⚠️ 界面上那个提示**只保证脚本跑过**。真正的结果要看重启后的选择器 —— 如果重启后
列表还是旧的,那就是同步本身失败了;卡片会写明失败原因(而不是谎报成功),见下面的
「同步卡片」。

### 同步卡片

页面中部有一张卡片专门说这件事,它是整个设计里**最容易被误当成 bug 的那个现象**的
说明书 —— 只启用了一个模型,选择器里却还列着一堆:

| 卡片显示 | 含义 |
| --- | --- |
| 「模型列表尚未同步过。」 | 还没跑过。改完启停点「立即同步」 |
| 「同步中...」 | 正在跑(防抖窗口内) |
| 「已同步 N 个模型 —— 重启 DSH 后模型选择器里才会变。」 | 成功。**现在去重启** |
| 「同步失败:<脚本的真实输出>」 | 失败。`make-dsh-provider.mjs` 的 stderr/stdout 原文,不是「未知错误」 |

「立即同步」不等那 1.2 秒防抖,用户刚改完想马上对齐时用它。`POST /route-sync`
成功回 200、失败回 **502** —— 失败**不**用 200 假装成功。

### 三个刻意的选择

- **防抖 1.2 秒 + 单飞**。批量启停会在一个请求里改几十个模型,紧接着界面还会再拉一次
  列表;每次改完都跑一遍脚本既慢又会在 profile 目录里堆一堆备份。防抖把这串触发合并
  成一次,`syncing` 守卫保证同一时刻只有一个脚本在跑。
- **同步失败绝不影响用户刚做的那次操作**。它只是个提示来源 —— 脚本挂了,模型启停照样
  成功生效(只是下次重启 DSH 时列表可能不对)。同理同步跑在 RPC **响应之外**,不会拖慢
  界面。
- **`spawn` 用 `process.execPath` 而不是 `node`**。DSH 自带运行时,`node` 不一定在 PATH
  上。脚本路径不存在时是**异步**报错,所以必须有 `error` 监听器 —— 没有它会变成未捕获
  异常,**把整个 DSH 带走**(与「启动网关」是同一个坑,见上面)。

关掉自动同步:`cordis.patch.yml` 的 config 里写 `syncRouteModels: false`;
换脚本位置:`config.syncScript` 指向真实路径(默认按
`<网关仓库目录>\dsh-ofm-free-gateway\scripts\make-dsh-provider.mjs`、
`~/ofm-free-gateway/...`、`~/.ofm-free-gateway/...` 依次探测)。
`/health` 会回显 `revision` / `routeSync` / `routeSync`(是否开启)/ `routeScript`。

## 页面上有什么

| 位置 | 内容 |
| --- | --- |
| 顶部 | 离线横幅(仅网关没跑时)+ 自动签到开关、上次时间、上次结果、调度时间、立即签到、刷新 |
| 同步卡片 | 模型列表与 DSH 配置的对齐状态 + 「立即同步」按钮(见上面的**同步卡片**) |
| 渠道卡片 | 13 张:状态(已开启 / 未登录)、账号 N/M、模型 (M−停用)/M、剩余积分 |
| 卡片按钮 | 添加账号、续期、刷新余额、一键领取(已领过就写「已领取」)、› 账号、› 模型 |
| 账号行 | 测试、续期、停用 / 启用、删除(两段确认,不用 window.confirm) |
| 模型行 | 免费 / 失效标记、启用 / 停用,以及整渠道批量开关 |
| 积分详情 | 卡片上是该渠道合计;展开账号行是逐账号总额 + 套餐明细(哪个包还剩多少) |

几个刻意的选择:

- **添加账号**照渠道包的两段式:先 `account.create` 拿到登录链接并**立刻**开新窗口
  (晚开的弹窗会被浏览器拦掉),然后每 3 秒 `login.poll` 一次、最多等 10 分钟。
- **一键领取**点完会顺手刷新该渠道余额,并把「N 个账号、共 X 积分」与失败原因一起说出来
  —— 一个渠道可能有多个账号,只报成功会骗人。
- **续期是真的去换新凭据**,而 CodeArts 一类的刷新令牌一次性有效(`the refresh token has been
  used` 就是这么来的)。所以续期按钮上有提示:同一账号只能有一个进程在用 —— 本插件这边
  只有网关持有凭据,才敢开这个按钮。
- 余额按渠道逐个打上游,所以是**后台慢慢填**:卡片先画出来,积分后到,不挡着界面。
- 渠道身份(名字 / 机构 / 品牌色 / 说明)写死在 `client.js` 里,与状态无关:身份是产品事实,
  不是读数,所以第一帧就有 13 张卡片,状态再慢慢从渠道包取。

## 为什么是代理

OAuth 刷新令牌是一次性的。原插件与网关同时运行、各自持有同一账号时，会互相把对方的
令牌用掉，实测报错：

```
CodeArts token request failed: 400
{"error_code":"STS5.1806","error_msg":"invalid refresh token: 'the refresh token has been used'"}
```

所以**凭证只由网关独占**：本插件的宿主半身从不加载渠道、不读 `.credentials.yaml`，
只把网关的两个接口转发到 `/api/ofm-checkin/*`。

顺带三个好处：密钥不出服务端（浏览器里看不到它）、不需要 CORS、网关没跑时页面能明确
告诉你「网关没有运行」而不是白屏。

## 结构

```
index.js           宿主半身:同源代理到网关(GET /health、POST /start、GET /checkin、GET /balance、POST /checkin/run、POST /checkin/enabled、POST /route-sync、POST /rpc)
client.js          浏览器半身：手写 ModuleLoader 包，无构建步骤，只 require('react')
cordis.patch.yml   一行 insert 把宿主挂进配置树（浏览器半身由 package.json 的 dsh.client 声明）
locale/            插件管理器显示用的标题与描述（中英各一份）
icon.svg           插件列表图标
test/host.test.mjs 宿主半身单测 + run-all.mjs 聚合器
```

模型列表自动同步的代码全在 `index.js` 里:`syncScriptCandidates()` / `defaultSyncScript()`
(脚本探测)、`MODEL_MUTATIONS`(哪些方法值得触发)、`runRouteSync()`(单飞执行 +
从 stdout 抓模型数)、`scheduleRouteSync()`(1.2 秒防抖)。见上面
[快照式是 DSH 的机制](#快照式是-dsh-的机制绕不过去--但手动重跑已经自动化了)。

数据流：

```
设置页  ──同源 fetch──▶  宿主 /api/ofm-checkin/*  ──Bearer key──▶  网关 127.0.0.1:18900
```

密钥取自 `~/.ofm-free-gateway/settings.json` 的 `forwardKey`，读不到就用空串（网关会回 401）。
也可以在 `cordis.patch.yml` 的 `config` 里写 `gatewayUrl` / `apiKey` / `dataDir` 覆盖。

## 安装

本插件与 [ofm-free-gateway](../dsh-ofm-free-gateway) 是**一对**：插件是 DSH 界面，
网关负责真正干活（登录、签到、领取积分）。两者放在**同一个仓库的兄弟目录**里，
插件会自动找到旁边的网关 —— 这样装完即用，不用改任何配置。

### 第 1 步：克隆本仓库

```powershell
git clone https://github.com/change-ouyang/dsh-ofm-suite.git
cd dsh-ofm-suite
```

克隆后目录长这样（插件和网关是兄弟）：

```
dsh-ofm-suite/
├── dsh-ofm-checkin/        ← 本插件
└── dsh-ofm-free-gateway/   ← 网关
```

### 第 2 步：启动网关，先完成一次渠道登录

```powershell
cd dsh-ofm-free-gateway
start.bat            # Windows：后台静默启动，不弹黑窗口
```

首次启动会生成 API 密钥（写在数据目录 `~/.ofm-free-gateway/settings.json`），
并加载 13 个渠道。**各渠道要各登录一次**，用浏览器完成 OAuth / 扫码 /
设备码，详见 [`../dsh-ofm-free-gateway/LOGIN.md`](../dsh-ofm-free-gateway/LOGIN.md)。

> 登录不完成也能用界面 —— 页面会显示渠道身份、只是操作按钮置灰。

### 第 3 步：把插件装进 DSH

桌面端 profile 由 Electron 应用独占管理，`dsh plugin --profile desktop` 会报
`profile "desktop" is managed exclusively by the Electron application`，
所以桌面端需要手工注册两处：

1. 把本目录链入 `~/.dsh/profiles/desktop/node_modules/dsh-ofm-checkin`（Junction 或软链）
2. 在 `~/.dsh/profiles/desktop/package.json` 的 `dependencies` 与
   `dsh.profile.bundles` 中分别加上 `dsh-ofm-checkin`

Web（`dsh web`）则一条命令即可：

```powershell
dsh plugin --profile web add link:<克隆目录>/dsh-ofm-suite/dsh-ofm-checkin
```

**然后必须重启 DSH** 才会加载（重启会中断正在跑的会话）。重启后在
**设置 → 每日签到** 找到它。

### 网关不在旁边怎么办

插件按这个顺序找网关，取第一个存在的：

1. 环境变量 `OFM_GATEWAY_DIR`
2. 插件目录的**兄弟目录**（本仓库的默认布局）
3. 用户主目录下的 `dsh-ofm-free-gateway/` 或 `ofm-free-gateway/`

都不在就在 `cordis.patch.yml` 的 `config` 里显式写：

```yaml
- insert:
    - id: ofm-checkin
      name: 'dsh-ofm-checkin'
      config:
        startScript: 'D:\path\to\dsh-ofm-free-gateway\start.bat'
```

### 打开 DSH 时自动拉起网关

宿主默认在 DSH 启动约 3 秒后**自动拉起网关**(配置键 `autoStart`,默认 `true`)。
启动是幂等的 —— 先探活,已经在跑就绝不 spawn 第二个(两个网关会各自起一个渠道
Worker、写同一份 `channel-pack/*.json`,互相把对方的刷新令牌用掉)。

所以「打开 DSH 就能用 ofm 模型」,不必每次想起来去点「启动网关」。

不想要自动拉起就关掉:

```yaml
- insert:
    - id: ofm-checkin
      name: 'dsh-ofm-checkin'
      config:
        autoStart: false
```

关掉后只保留「启动网关」按钮的手动启动。`startCommand` / `startTimeoutMs` /
`syncRouteModels` 的说明见 `cordis.patch.yml` 顶部的注释。

### 卸载 / 回滚

```powershell
$p = "$env:USERPROFILE\.dsh\profiles\desktop"
Remove-Item "$p\node_modules\dsh-ofm-checkin" -Force      # 删 Junction（只删链接，不动本目录）
```

再手工删掉 `dependencies` 与 `dsh.profile.bundles` 里的 `dsh-ofm-checkin` 两行即可。

## 验证

```bash
npm test                    # 等价于 node test/run-all.mjs
```

测试**全部自足**：不依赖 DSH，也不依赖网关在跑（`fetch` 被桩掉、路径被隔离），
所以在任何机器上都能跑出同样的结果。

`test/host.test.mjs` 直接驱动 `index.js` 的路由（自造 req/res + 桩掉 fetch），重点钉住：

- **RPC 方法白名单** —— 白名单外的方法必须被拒（400）且**不打到网关**，
  白名单内的放行且确实转到了网关的 `/rpc`。这是界面上的每个按钮对应的通道，
  漏掉一条就等于让界面的一次笔误能调用渠道包的任意方法。
- **请求体上限** —— 超限返回 413，而不是把宿主拖垮。
- **「网关没跑」的归类** —— `/health` **永远返回 200**（对界面是正常情报，不是
  请求失败），并把 `up` 标成 false、给出可读的离线原因；网关正常时 `up` 为 true。
- **路径发现** —— 找不到网关时返回**空串**，而不是一个会误导用户去改的假路径。
- **未知接口** —— 返回 404。

被测对象默认是本目录的源码；用 `OFM_PLUGIN_DIR` 可改指已安装的 profile 副本：

```bash
OFM_PLUGIN_DIR="$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-ofm-checkin" node test/run-all.mjs
```

## 与官方规范的一处偏差

DSH 自带的 `cordis-plugin-development` skill 要求「可见文案走 Client locale 服务」。
本插件**有意不接**：它只有中文一种语言，而 locale 查不到 key 时 shell 会把原始 key
直接显示出来（看起来像坏了）。文案集中在 `client.js` 的 `T` 表里，将来要接 locale
只需把 `T` 换成 `ctx.locale.bind(NS)`。其余规范（主题 token、slot 注册、
不 require Harness Client 包、不在组件外写 DOM）都已遵守并被测试钉住。

## 故障排查

| 现象 | 原因与处理 |
|---|---|
| 设置里没有「每日签到」 | 没重启 DSH；或 `bundles` / Junction 没生效。检查 `profiles\desktop\package.json` 的两处，以及 `node_modules\dsh-ofm-checkin` 是否为 Junction |
| 页面显示「网关没有运行」 | 点横幅里的**「启动网关」**即可(宿主会拉起 start.bat 并等它应答);网关刚起来时也可以用「重试连接」刷一下 |
| 「启动网关」说找不到脚本 | 宿主按已知位置探测过但没找到。在 `cordis.patch.yml` 的 config 里显式写 `startScript`(或 `startCommand`)指向真实路径 |
| 「启动网关」超时(没应答) | 首次启动要加载 13 个渠道,机器慢就调大 `startTimeoutMs`;同时看网关自己的日志:数据目录里的 `gw.err` |
| 点「立即签到」后一直转 | 整轮是触发即返回,界面每 2.5 秒轮询一次状态;渠道在刷新凭据时可能要一两分钟 |
| 某渠道总是失败 | 单个渠道签不动时点它右边的「领取」单独重试;codearts 的 `STS5.1806` 说明令牌已被另一边用掉,需在该渠道重新登录 |
| 端口 18900 被两个 node 占着 | 不应该发生:`/start` 是幂等的(已在跑就不再 spawn)。若手工起过,只留一个 —— 两个网关会互相消耗一次性刷新令牌 |
| 模型改完,DSH 选择器里还是旧的 | **要重启 DSH** —— 配置是启动时读的快照,运行时不会自动刷新。重启前看一眼同步卡片有没有报错 |
| 同步卡片显示「同步失败」 | 卡片上写的是 `make-dsh-provider.mjs` 的真实输出。`连不上网关…` ⇒ 网关没跑(先启动);`找不到脚本` ⇒ 在 `cordis.patch.yml` 的 config 里写 `syncScript` |
| 页面顶部报「插件代码没生效」 | 宿主半身是旧版本(`/health` 的 `revision` 对不上 `client.js` 的 `EXPECTED_REVISION`)。插件在宿主进程启动时就加载了,**改完文件必须重启 DSH** |
| 想关掉自动同步 | `cordis.patch.yml` 的 config 里写 `syncRouteModels: false`,「立即同步」按钮也会一起失效并给出说明 |
