# NOTICE — 第三方代码的来源与许可

本仓库包含从上游项目复制或派生的代码。逐项说明如下，许可证均为 **MIT**
（正文见 [`LICENSE`](LICENSE)）。

---

## 一、上游来源

### 1. dsh-our-free-model

- 上游仓库：<https://github.com/Ebony-Vinyl/dsh-our-free-model>
- 许可证：MIT，`Copyright (c) 2026 Ebony-Vinyl`
- 本仓库是什么：从它的 **standalone 分支**剥离出的「无 DSH 依赖」版本 ——
  一个可以独立运行的 13 渠道 OpenAI 兼容网关。

### 2. channel-pack（免费渠道包）

- 上游仓库：<https://gitee.com/iJetLi/deepseek-harness-codearts>
- 吸收的提交：`345f0a07b22713c0ae189ca7d8b97ec4f64626c6`（2026-10-06）
- 许可证：MIT，`Copyright (c) 2026 Jet`
- 说明：dsh-our-free-model 的 `vendor/channel-pack/` 是上述仓库的完整拷贝；
  本仓库沿用了该拷贝中的渠道实现。

---

## 二、本仓库各文件与上游的关系

| 文件 | 关系 |
| --- | --- |
| `channels/business.mjs` | 上游渠道包构建产物 `pack.js`（SHA256 `4083cea5178cb394e7c281126580fedc755c79dbb78bcd4b9a085acd7ba5d21f`）的副本；本仓库版本 SHA256 `c393738f6d77f62a64eb443210d120f92385cafe2c19ef8b78dd363839b0c5bc`。相对上游的差异只有两类：(1) WASM 定位路径改为同目录（`./qoder-auth-wasm.wasm`）+ 3 行注释；(2) **移除内置的 Google OAuth client id/secret**（见第五节）及其取值函数、登录前置校验。除此之外逐字节相同。 |
| `channels/qoder-auth-wasm.wasm` | 上游文件**逐字节副本**（SHA256 `6419471effa631519def7797d76d7ede38b9fcfa9a83c2148c8ef5d43355b43d`，298 606 字节）。Qoder 系（qoder / qodercn）加密推理所需。 |
| `channels/fold.mjs` | 内联自 dsh-our-free-model 的 `src/core/completion.js`（`foldForwardOutcome`）与 `src/forward.js`（`toOpenAiUsage`）。 |
| `channels/contracts.mjs`、`channels/credentials.mjs`、`channels/images.mjs`、`channels/runtime.mjs`、`channels/worker.mjs` | 本项目新写的文件，未复制自上游。 |
| `server.mjs`、`scripts/`、`test/`、`start*.bat`、`*.cmd`、`run-hidden.vbs` | 本项目新写。 |
| `dsh-ofm-checkin/`（整个目录） | 本项目新写的 DSH 插件，只通过 loopback HTTP 与网关通信，**不含**任何上游代码。 |

---

## 三、已知的第三方痕迹

`channels/qoder-auth-wasm.wasm` 是二进制产物，其内部字符串表包含编译该
WASM 的第三方开发者的本机 Rust 构建路径（如 `/Users/<name>/.cargo/...`）。
这些路径**无法在不破坏二进制的前提下修改**，它们不是本仓库作者的路径，
也不构成任何凭证或隐私信息。WASM 的使用受其所在目录的 MIT 许可覆盖。

### 关于 GitHub 的密钥扫描告警（预期内，属误报）

本仓库推送后，GitHub 的密钥扫描会在 `channels/business.mjs` 报出一条
**Tencent WeChat API App ID**（`wx18d60be432287cf8`）告警。这是误报：

- 它是微信开放平台「网站应用」的 **AppID**，不是密钥 —— AppID 本身会出现在授权 URL
  的查询串里（`?appid=...`），按设计就是公开的；
- 它来自 Loomy 客户端 `.env.prod` 的 `LOOMY_WECHAT_APP_ID`，上游
  `vendor/channel-pack/src/loomy-wechat.ts:33` 同样是明文；
- 配对的 **AppSecret 不存在于本仓库的任何文件里**（已全量搜索确认）。

保留它是为了让 Loomy 渠道的微信扫码登录保持可用。仓库管理员可在
<https://github.com/change-ouyang/dsh-ofm-suite/security/secret-scanning>
把该告警以 "False positive" 关闭。

---

## 四、商标与第三方素材

各服务商标（如华为云、腾讯、字节跳动、阿里、Google、智谱等）归各自权利人所有。
本仓库仅用于调用这些服务提供的公开接口，与这些公司无隶属或背书关系。

---

## 五、移除内置的 Google OAuth 凭据

上游 `vendor/channel-pack/src/gemini-oauth.ts:36-38` 内置了一对 Google OAuth
「installed app（桌面应用）」凭据（client id + client secret）。这对值是第三方应用的
默认凭据，属于公开信息（随桌面客户端一起分发，不保护任何用户数据），但它有两个实际代价：

- 让 GitHub 的密钥扫描在本仓库**每次推送**时拦下包含该文件的提交；
- 让本仓库的所有使用者共用同一个 Google Cloud 项目配额，且该配额随时可能被上游撤销。

因此本仓库**已把它从源码中移除**：

- 常量 `GEMINI_DEFAULT_CLIENT_ID` / `GEMINI_DEFAULT_CLIENT_SECRET` 不再存在；
- `geminiClientId()` / `geminiClientSecret()` 只读环境变量
  `CMDC_PAK_GOOGLE_CLIENT_ID` / `CMDC_PAK_GOOGLE_CLIENT_SECRET`；
- 未配置时，`startGeminiOAuthFlow()` 会在启动本地回调服务器**之前**抛出明确错误
  （避免留下两个没人关的监听 socket）。

只影响 **Gemini 一个渠道**（13 个中的 1 个，177 个模型中的 1 个）。
其余 12 个渠道的行为与上游完全一致。自备 OAuth 客户端的步骤见
[`dsh-ofm-free-gateway/LOGIN.md`](dsh-ofm-free-gateway/LOGIN.md)。
