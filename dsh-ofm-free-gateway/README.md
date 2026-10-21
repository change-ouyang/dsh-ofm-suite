# ofm-free-gateway

从 [dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model) 剥离出的最小版本 —— **只保留 13 个免费渠道的模型接入能力**，其余（EAC 车道、管理页面、更新器、用量统计、web UI）全部去掉。

- ✅ 不依赖 dsh / Cordis / 任何 `@deepseek-ai/*` 包
- ✅ 纯 Node 内置模块，零 npm 依赖
- ✅ **每日自动签到**（含每日循环、开关、一键领取、余额视图；不依赖 DSH 插件）
- ✅ 一次性签到脚本 + 计划任务，签到不依赖任何常驻进程
- ✅ OpenAI 兼容 API：`/v1/models`、`/v1/chat/completions`、`/v1/responses`
- ✅ 未登录也能列出全部模型目录（13 渠道，150～175 个）
- ✅ 附 `/rpc` 渠道管理接口（登录、账号、额度、模型开关）
- ✅ 只绑定 loopback（127.0.0.1），必须带 Bearer API key
- ✅ 自带 64 项测试（`npm test`），不需要登录即可跑
- ✅ 附 DSH 接入/迁移/漂移检查脚本（见下文）

## 包含的 13 个渠道

| 渠道 | provider | 模型数（实测） |
|------|----------|--------|
| 华为 CodeArts | `codearts` | 9 |
| 腾讯 CodeBuddy | `buddy` | 16 |
| 字节 WorkBuddy | `workbuddy` | 23 |
| LobsterAI | `lobsterai` | 19 |
| 阿里 Qoder | `qoder` | 17 |
| Qoder 中文版 | `qodercn` | 14 |
| TRAE | `trae` | 28 |
| Cline | `cline` | 3（远端目录未就绪）/ 28（就绪后） |
| Loomy | `loomy` | 8 |
| Raccoon | `raccoon` | 6 |
| MiniMax Code | `minimax` | 4 |
| ZCode | `zcode` | 2 |
| Gemini | `gemini` | 1(**需自备 OAuth 客户端**) |

Cline 的模型目录来自远端，启动后需要一点时间才拉全，所以 `/v1/models` 的总数会在
150（Cline 3 个）与 175（Cline 28 个）之间变化，属正常。

> 这些渠道需要**逐个用你自己的账号做一次浏览器登录**才能推理（渠道按账号鉴权；
> 实测未登录时连 `cline-free/*` 这类免费模型也会被渠道层拒绝）。
> 各渠道的登录入口见 [LOGIN.md](LOGIN.md)。真正“无需登录”的匿名车道（OpenCode Zen）与原版 EAC 车道不在本剥离版内。

## 快速开始

```bash
# 需要 Node.js >= 22.19
cd dsh-ofm-free-gateway
node server.mjs --port 18900 --data-dir D:\ofm-data
```

首次启动会生成一个 API Key 并打印，同时保存在 `数据目录/settings.json`。

Windows 也可以直接运行 `start.bat`：

```bat
start.bat --port 18900 --data-dir D:\ofm-data
```

`start.bat` **在后台静默运行，不弹任何窗口**，输出写到日志文件：

| 文件 | 内容 |
|------|------|
| `<数据目录>\gw.out.log` | 网关的标准输出（启动横幅、模型目录就绪、签到结果） |
| `<数据目录>\gw.err.log` | 网关的标准错误（渠道网络失败等告警） |

每次启动会覆盖这两个文件。要实时看输出、或排查启动失败，用 `start-console.bat`
（保留前台窗口，仅供手动排查时使用）：

```bat
start-console.bat --port 18900 --data-dir D:\ofm-data
```

### 数据目录在哪

渠道凭证、API Key、签到状态都存在**数据目录**里。解析优先级(三处代码一致):

1. `--data-dir <目录>` 命令行参数(最高)
2. `OFM_HOME` 环境变量
3. 各自的默认值 ↓

| 入口 | 没给参数时的默认值 |
|------|-------------------|
| `start.bat` / `start-console.bat` / `checkin-task.cmd` | **`<本目录>\..\.ofm-free-gateway`**,即网关目录旁的 `.ofm-free-gateway` |
| 直接 `node server.mjs`(不经启动脚本) | `~/.ofm-free-gateway`(Windows:`C:\Users\<你>\.ofm-free-gateway`) |

启动脚本用**相对自身目录**的写法,所以整个仓库文件夹搬走,数据也跟着走。
启动脚本解析完后会把结果导出为 `OFM_HOME` 传给子进程,`server.mjs` 与
`scripts/*.mjs` 都读这个变量,因此三者永远指向同一处 —— 不会出现「日志在 A、
凭证在 B」的错配。

> 直接 `node server.mjs` 时没人替你设 `OFM_HOME`,所以它会退回 `~/.ofm-free-gateway`。
> 想让它也用同一处,就显式传 `--data-dir`,或先 `set OFM_HOME=<目录>`。

DSH 插件(`dsh-ofm-checkin`)的密钥读取**不认** `OFM_HOME`,只在 profile 的
`cordis.patch.yml` 里读 `config.dataDir`,所以那边要单独写一份、指向同一个目录。

> **为什么以前会弹一个「node server.mjs」黑窗？**
> DSH 是 Electron（GUI）程序，自身没有控制台。它用 `DETACHED_PROCESS` 拉起
> `start.bat` 时，`cmd.exe` 手里一个控制台都没有；脚本里再跑 `node server.mjs`，
> node 就只好**自己新分配一个可见控制台** —— 那个黑窗就是它。
> 更麻烦的是：点掉那个 X（WM_CLOSE）会把 node 和 cmd **一起杀掉**，网关直接没了。
>
> 现在改成 `start.bat` → `run-hidden.vbs` → `wscript.exe`（`WSH.Shell.Run` 的窗口样式
> 设为 `0`，即 `CREATE_NO_WINDOW`）→ `run-inner.cmd` → `node server.mjs`。
> 这条路径下 cmd 拿到的是一个**没有窗口的控制台**，node 继承它而不再自己分配，
> 实测可见窗口数为 0。

## 使用

```bash
# 列出模型（登录前也能列出 150 个，未登录渠道带 "x-provider-ready": false）
curl http://127.0.0.1:18900/v1/models -H "Authorization: Bearer <key>"

# 非流式对话
curl http://127.0.0.1:18900/v1/chat/completions \
  -H "Authorization: Bearer <key>" -H "Content-Type: application/json" \
  -d '{"model":"codearts/GLM-5.2","messages":[{"role":"user","content":"你好"}]}'

# 流式对话
curl -N http://127.0.0.1:18900/v1/chat/completions \
  -H "Authorization: Bearer <key>" -H "Content-Type: application/json" \
  -d '{"model":"buddy/deepseek-v4-flash","messages":[{"role":"user","content":"你好"}],"stream":true}'
```

模型 ID 是 `渠道名/模型名` 格式，例如 `codearts/GLM-5.2`、`buddy/deepseek-v4-flash`、
`trae/DeepSeek-V4-Pro`、`minimax/MiniMax-M3`。以 `/v1/models` 的实际返回为准
（Cline 的 ID 含多级斜杠，如 `cline/cline-free/mimo-v2.6-flash`，网关按第一个斜杠切分渠道）。

未登录就发起推理时返回 **409**，并在消息里直接给出该渠道的登录命令。

### 支持的请求参数

`messages`、`stream`、`tools`/`tool_choice`（仅 `auto`/`none`）、`max_tokens`/`max_completion_tokens`、
`temperature`、`stop`、`reasoning_effort`、图片输入（`image_url`）。参数校验由渠道层
（`channels/business.mjs`）执行，非法值会以 `unsupported_parameter` 之类的错误返回。

## 每日自动签到（不依赖 DSH 插件）

原插件界面上的「每日自动签到」开关、「一键领取」按钮、渠道卡片的余额与状态行，
在本剥离版里都有等价物，**且不需要 DSH 在原插件里运行**。

```bash
node scripts/checkin.mjs                              # 看状态（今日结果 + 逐渠道明细）
node scripts/checkin.mjs --run                        # 立刻签一轮（全部有账号的渠道）
node scripts/checkin.mjs --run --provider qodercn      # 只签某个渠道
node scripts/checkin.mjs --balance                    # 连各渠道余额一起看（慢，逐个打上游）
node scripts/checkin.mjs --enable / --disable         # 开关每日自动签到
```

输出形如：

```
每日自动签到：已开启
上次完成：2026-10-17（2026/10/17 11:00:34）
结果：5 个渠道：1 个账号领取成功（+100积分），1 个今天已领，2 个失败，3 个渠道不支持签到
逐渠道：
  codearts     1 个今天已领
  qodercn      1 个 +100积分
  ...
调度：每天 09:00 之后检查一次；本进程今天还没触发
```

### 为什么需要一个「每日检查」

渠道包自带自动签到，但它的调度是**一次性**的：进程启动 30 秒后跑一轮，跑完把当天
日期写进 `auto-checkin.json` 的 `lastDate`，**此后再没有任何定时器**
（`auto-checkin.ts` 的 `start()` 只挂一个 `setTimeout`）。原版是 DSH 插件，依赖
「用户每天都会打开 DSH」这个前提，所以在那边够用。

网关可能连续运行数周 —— 第二天起就不会再签到了。所以网关补了一个每日检查：
每天 `--checkin-at`（默认 `09:00`）之后，若今天还没签到就触发一轮。它**复用渠道包
自己的签到执行体**（`usage.autoCheckin {enabled:true}` → 内部 `runIfDue()`），
因此结果文字与插件界面完全同源，也不需要在网关里重写任何渠道逻辑。

两条防滥用规则（都有测试锁定）：当天已签则不触发；**本进程当天最多触发一次** ——
渠道包在「凭据没续上/网络不通」时故意不写 `lastDate` 以便重试，若不加这条上限，
就会每小时重打一轮上游，把免费额度耗在失败重试上。

### HTTP 接口

```bash
# 状态（含调度器信息）
curl http://127.0.0.1:18900/checkin -H "Authorization: Bearer <key>"

# 立刻签到；带 provider 则只领该渠道
curl -X POST http://127.0.0.1:18900/checkin/run -H "Authorization: Bearer <key>"
curl -X POST http://127.0.0.1:18900/checkin/run -H "Authorization: Bearer <key>" \
  -H "Content-Type: application/json" -d '{"provider":"trae"}'
```

需要更细的渠道 RPC（登录、账号、余额、模型开关）时用 `POST /rpc`，方法名见
[LOGIN.md](LOGIN.md)；余额用 `usage.badge`（**必须带 `provider`**）。

### 不想让网关常驻？用一次性签到 + 定时任务

上面的每日检查需要网关一直在跑。如果只想保证**每天签到不断**，更省事的形态是让
系统定时跑一次「签完就退出」的脚本 —— 不占端口、常驻进程崩了也不影响：

```bash
node scripts/checkin-once.mjs          # 签一次就退出（今天已签则直接退出，不打扰上游）
node scripts/checkin-once.mjs --json   # 输出 JSON，便于写日志
```

它会**先检查常驻网关是否在跑**（读数据目录里的 `gw.pid` 并探测进程）：在跑就跳过，
因为两边各起一个渠道 Worker 会同时写同一份 `channel-pack/*.json`。确实要并跑加
`--force`。

注册每天 09:05 的任务。**用一层 .cmd 包装器**，不要把嵌套引号塞进 `schtasks`；
node 路径先自己查一下（可能装在 nvm 下，不是 `C:\Program Files\nodejs`）：

```powershell
(Get-Command node).Source        # 例如 C:\Program Files\nodejs\node.exe
```

仓库里已经带了 `checkin-task.cmd`，它会自己在 `PATH` 里找 node，
找不到就看你有没有设 `OFM_NODE_PATH`：

```bat
@echo off
rem Daily one-shot check-in for ofm-free-gateway.
set "OFM_NODE=node"
where node >nul 2>&1
if errorlevel 1 if defined OFM_NODE_PATH if exist "%OFM_NODE_PATH%" set "OFM_NODE=%OFM_NODE_PATH%"
"%OFM_NODE%" "%~dp0scripts\checkin-once.mjs" >> "%OFM_HOME%\checkin.log" 2>&1
```

> node 不在 `PATH` 里（比如只装了 nvm 但没配环境变量）时，先
> `setx OFM_NODE_PATH "C:\path\to\node.exe"` 再注册任务。

```bat
schtasks /Create /TN "ofm-checkin-daily" /SC DAILY /ST 09:05 /F ^
  /TR "<网关仓库目录>\dsh-ofm-free-gateway\checkin-task.cmd"
schtasks /Run    /TN "ofm-checkin-daily"     :: 立刻试跑一次
schtasks /Query  /TN "ofm-checkin-daily" /FO LIST
schtasks /Delete /TN "ofm-checkin-daily" /F  :: 不想要了就删
```

（`/SC ONLOGON` 的「开机补签到」在部分机器上需要管理员权限，被拒就先只用每日任务。）

> **常驻网关与定时任务可以共存**，不必二选一：`gw.pid` 守卫让两边同一时刻只有一边动手
> —— 网关在跑时定时任务自动让位，网关没跑时定时任务兜底。于是「网关崩溃/被关掉后
> 签到就断了」这个风险也被盖住了。

## 接入 DSH（可选：把模型加进 DSH 的模型列表）

> 只想用签到功能的话**不用做这一步**，也就不用让这些模型占用你的模型选择器。
> 命令与网关是否接入 DSH 无关。

DSH 用的是 `@deepseek-ai/dsh-llm-pi-ai` 插件，它在 profile 的 `cordis.patch.yml` 里
按 `providers:` 声明模型路由。本网关就是一条 OpenAI 兼容路由，所以**不需要写 DSH 插件**，
加一段配置即可。

### 三步

```bash
# 1) 把原插件（dsh-our-free-model）里已登录的渠道凭证迁移过来，省掉重新登录
node scripts/migrate-from-dsh.mjs

# 2) 启动网关（密钥会写进数据目录的 settings.json，之后重启不必再带 --key）
node server.mjs --port 18900

# 3) 生成并写入 DSH 配置（默认只写「当前真的可路由」的模型）
node scripts/make-dsh-provider.mjs --key <上一步打印的 API Key>
```

然后**重启 DSH**（或在插件管理里重载宿主），模型选择器里就会出现这些模型。

### 为什么不需要填 API Key

pi-ai 的 openai-completions 传输层这样取 key：

```js
if (apiKey) return apiKey
if (hasHeader(headers, 'authorization')) return 'unused'   // ← 生成的配置走这条
throw new Error(`No API key for provider: ${provider}`)
```

所以脚本在路由里写了一个静态 `headers.Authorization: Bearer <key>`，**不需要**
`apiKeyEnv`、不需要把密钥写进 DSH 凭据库、也不需要设环境变量。

### 脚本说明

| 脚本 | 作用 |
|------|------|
| `scripts/checkin.mjs` | 签到命令行：看状态、立刻签、开关自动签到、查余额。 |
| `scripts/migrate-from-dsh.mjs` | 从 `$DSH_HOME/.credentials.yaml` + `$DSH_HOME/channel-pack/state.json` 迁移渠道凭证与账号池到本网关的数据目录。**写前自检每条凭据是否合法 JSON**，不合法就中止（坏凭据会让渠道「看起来已登录但模型全 404」）。幂等，改动前自动备份。 |
| `scripts/make-dsh-provider.mjs` | 从 `/v1/models` 生成 `providers.ofmfree` 段并幂等写进 `cordis.patch.yml`，用标记注释圈定范围，不动你原有的 provider；写完用 js-yaml 解析自检。**`--remove` 可整段撤销**。 |
| `scripts/check-credential-drift.mjs` | **只读**对比 DSH 侧与本网关侧的渠道凭证（含逐条哈希与到期时刻）和账号池，用来判断「到底哪边旧了」。 |

常用参数：

```bash
node scripts/make-dsh-provider.mjs --key <key> --dry-run          # 只打印不写
node scripts/make-dsh-provider.mjs --key <key> --all              # 写全量目录（含未登录渠道）
node scripts/make-dsh-provider.mjs --key <key> --channels buddy,codearts,trae
node scripts/make-dsh-provider.mjs --key <key> --remove-original  # 同时从 profile bundles 移除原插件
node scripts/migrate-from-dsh.mjs --dry-run                       # 迁移预演
```

### 说明与注意

- 网关必须**先于** DSH 使用而运行；它是独立进程，DSH 重启不会带着它。
- 若你把网关密钥改掉（`settings.json` 或 `--key`），要重跑第 3 步更新配置。
- 迁移过来的登录态与原插件**互不影响**：网关把账号池写在自己的数据目录
  （`--data-dir`），不会碰 `$DSH_HOME/channel-pack/`，所以两个可以并存。
- ⚠️ **两个进程共用同一批账号时会互相废掉令牌**。原插件在 DSH 里运行时也会刷新令牌，
  而刷新令牌是**一次性**的：一方用掉后另一方再用就会失败。实测原文（华为 CodeArts）：

  ```
  CodeArts token request failed: 400
  {"error_code":"STS5.1806","error_msg":"invalid refresh token: 'the refresh token has been used'"}
  ```

  这不是「过期」，是**被另一边用掉了**。表现为某渠道在一个进程里能用、在另一个里全 404，
  或突然两边都不通。排查与处理：

  ```bash
  node scripts/check-credential-drift.mjs      # 只读对比，看哪边旧了
  node scripts/migrate-from-dsh.mjs            # 按「谁新用谁」同步
  ```

  同步后**必须重启网关**（凭据在启动时读进内存）。根治办法是**只让一边持有账号**：
  要么用本网关（原插件移除），要么只用原插件。已经撞坏的渠道（如上面的 CodeArts）
  需要在该渠道重新登录一次 —— 两边持有的那份都已经作废。
- 签到结果逐轮会变（同一渠道在「失败 / 今天已领 / +100积分」之间跳）：
  上游偶发失败与「今天已经领过」都记为不同文字，比较时别把一次失败当成永久不可用。
  实测同一账号 `trae` 先报「1 个未开启」、下一轮报「1 个 +100积分」。
- `--remove-original` 会同时失去原插件提供的**渠道登录界面**；之后给新渠道登录要用
  本网关的 `/rpc` 接口（见 [LOGIN.md](LOGIN.md)）。

## 测试

```bash
npm test              # 全部 64 项
npm run test:unit     # 29 项：帧拼接 / usage 换算 / 诱饵过滤 / chunk 折叠 / 签到判定与调度 / 一次性签到
npm run test:http     # 35 项：认证、路由、非流式装配、SSE 帧序、错误码、请求体校验、签到端点
```

HTTP 测试用**桩运行时**注入合成 chunk，因此不需要登录、不联网也能验证网关自身行为。
（真实渠道需要逐个浏览器登录，端到端推理无法自动化；测试覆盖的是网关这一侧的契约。）

## 目录结构

```
dsh-ofm-free-gateway/
├── server.mjs          # OpenAI 兼容网关（本剥离版自写）
├── package.json
├── start.bat           # Windows 启动脚本（后台静默，不弹窗）
├── start-console.bat   # Windows 前台启动脚本（保留窗口，供排查时用）
├── run-hidden.vbs      # 以 CREATE_NO_WINDOW 方式拉起网关（start.bat 内部用）
├── run-inner.cmd       # 真正执行 node server.mjs 的那一层（run-hidden.vbs 调用）
├── README.md
├── LOGIN.md            # 13 个渠道的登录方式与 RPC 方法
├── scripts/
│   ├── checkin.mjs            # 签到命令行（状态 / 立刻签 / 开关 / 余额）
│   ├── checkin-once.mjs       # 一次性签到，签完退出（给任务计划程序用）
│   ├── migrate-from-dsh.mjs   # 从原插件迁移已登录渠道的凭证与账号池
│   ├── make-dsh-provider.mjs  # 生成/更新（或 --remove 撤销）DSH 的 providers.ofmfree
│   └── check-credential-drift.mjs  # 只读对比两边凭证是否漂移
├── test/
│   ├── run-all.mjs     # 测试入口
│   ├── unit.test.mjs   # 纯函数单测
│   └── http.test.mjs   # HTTP 端到端（桩运行时）
└── channels/           # 原样复用原项目的渠道实现（自包含）
    ├── business.mjs    # 13 个渠道的打包实现（2.88MB，原项目构建产物）
    ├── qoder-auth-wasm.wasm  # Qoder 系（qoder/qodercn）加密推理所需（原项目资源）
    ├── worker.mjs      # Worker 线程：加载渠道、处理 complete/models/rpc
    ├── runtime.mjs     # Worker 封装（已改为依赖本地 fold.mjs）
    ├── fold.mjs        # 自包含的 chunk 折叠 + 用量换算（本剥离版新增）
    ├── contracts.mjs   # LLM 适配器契约
    ├── credentials.mjs # 渠道登录凭证存储
    └── images.mjs      # 图片附件处理
```

## 与剥离相关的说明

- `channels/runtime.mjs` 原版 import 了 `../../../src/core/completion.js` 和 `../../../src/store.js`（原项目 `src/` 目录）。剥离版删掉了 store 依赖（不采集用量统计），并把 `foldForwardOutcome`/`toOpenAiUsage` 内联为 `channels/fold.mjs`。
- `business.mjs` 是原项目的构建产物（内部打包了 undici/jose 等），因此本目录没有 npm 依赖也能运行。**唯一一处修改**：Qoder 系的 WASM 路径。原值是 `new URL("../../../vendor/channel-pack/qoder-auth-wasm.wasm", import.meta.url)`，它假定 `business.mjs` 位于 `<repo>/packages/standalone/channels/`；剥离版把 wasm 放在同目录并改成 `./qoder-auth-wasm.wasm`（文件内用 `OFM-PATCH` 注释标出）。不改这一处的话，`qoder` / `qodercn` 推理会报 `ENOENT: ... qoder-auth-wasm.wasm`。
- `/v1/models` 合并两个来源：`model.list` 的全量静态目录（登录前也有），与 runtime 的权威行（适配器 `listModels()` 的实时结果）。`x-provider-ready` 按**逐模型**判定 —— 取自权威行是否包含该模型，因为「渠道有账号」不等于「该模型能路由」（实测出现过账号在、目录 16 个模型，但凭据不可解析导致全部 404）。构建首次会等 `runtime.ready` 落地，避免把「还没刷新」缓存成「全都不可路由」。
- 指纹工具围栏（bash/glob/grep/read 防注入）照搬原版 `src/forward.js` 的 `admit` 语义：未声明的指纹工具被丢弃；「先流参数后流名字」时参数先扣住，定性后才释放。
- 未实现：`--probe`；Anthropic 的 `/v1/messages` 端点（如需 Claude Code 直连，见文末）。

## 安全提示

- 仅监听回环地址。需要局域网/远程访问时请自行用反代并保持 API key 保密。
- 所有提示词会经各渠道上游厂商处理，不要发送敏感信息。
- 免费渠道额度、可用性随时可能变化，属“尽力而为”，不适合生产依赖。

## License

MIT。渠道实现部分保留原项目的 MIT 许可 —— 逐文件的来源、哈希与署名见仓库根目录的
[`NOTICE.md`](../NOTICE.md) 与 [`LICENSE`](../LICENSE)。