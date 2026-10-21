# 渠道登录指南

ofm-free-gateway 的 13 个渠道**都需要用你自己的账号做一次浏览器登录**（与 dsh-our-free-model 原版一致）。
登录凭证保存在数据目录 `channel-credentials.json`（权限 0600），完成后模型列表会自动刷新。

## 登录方式：一次 RPC 调用拿登录地址

```bash
curl -X POST http://127.0.0.1:18900/rpc \
  -H "Authorization: Bearer <你的API Key>" \
  -H "Content-Type: application/json" \
  -d '{"method":"account.create","payload":{"provider":"codearts"}}'
```

返回的 `loginUrl` 用浏览器打开完成登录即可：

```json
{ "ok": true, "value": { "accountId": "codearts-xxxxxxxx", "loginUrl": "https://..." } }
```

> 有些渠道的 `loginUrl` 指向**本地**地址（如 Loomy 的微信扫码页 `http://127.0.0.1:9573/wechat/qr`）——
> 那是网关内部起的登录页，用本机浏览器直接打开即可，不要复制到别的机器上。

## 13 个渠道的登录方式（已实测）

| 渠道 | provider | 实测登录方式 |
|------|----------|--------------|
| 华为 CodeArts | `codearts` | 华为云 OAuth（浏览器 + 本地回调） |
| 腾讯 CodeBuddy | `buddy` | 腾讯 Copilot 账号登录 |
| 字节 WorkBuddy | `workbuddy` | 同 CodeBuddy 体系 |
| LobsterAI | `lobsterai` | 品牌账号登录 |
| 阿里 Qoder | `qoder` | 设备码登录（`qoder.com/device/selectAccounts`） |
| Qoder 中文版 | `qodercn` | 同上，中文站 |
| TRAE | `trae` | 字节账号登录 |
| Cline | `cline` | Cline 账号登录 |
| Loomy | `loomy` | **微信扫码**（本地托管登录页） |
| Raccoon | `raccoon` | 品牌账号登录 |
| MiniMax Code | `minimax` | MiniMax 账号登录 |
| ZCode | `zcode` | **智谱 bigmodel OAuth**（`bigmodel.cn/login`） |
| Gemini | `gemini` | **Google OAuth**（本地回调，需要能访问 Google；还需自备 OAuth 客户端，见下） |

补充说明：

- **Loomy** 除微信扫码外，还支持手机验证码：`login.sendSms`（`{provider:'loomy', accountId, phone}`）→
  `login.submitSms`（`{provider:'loomy', accountId, code}`）→ `login.poll` 查询结果。仅 loomy 支持短信。
- **ZCode** 另有一套验证码载体页：`captcha.carrierUrl` 会返回一个**本地**地址
  （形如 `http://127.0.0.1:19263/carrier`，端口每次启动不同），该页由网关内部托管，
  用完后通过 `captcha.contribute` 回填参数。走 OAuth 登录时不需要这一步。
- **Gemini** 必须有能访问 Google 的网络（可在启动前设 `HTTPS_PROXY`/`HTTP_PROXY`）。

### Gemini 需要自备 Google OAuth 客户端

本仓库**不内置** Google OAuth client id / secret —— 那对值属于第三方，内置会让
GitHub 的密钥扫描持续拦下推送，也会让所有人共用同一个 Google Cloud 项目配额
（随时可能被上游撤销）。

要用 Gemini 渠道，自建一个即可（免费，约 2 分钟）：

1. 打开 <https://console.cloud.google.com/apis/credentials>
2. **创建凭据 → OAuth 客户端 ID → 应用类型选「桌面应用」**
3. 把拿到的 Client ID 与 Client Secret 设成环境变量：

```powershell
# Windows PowerShell —— 必须在启动网关之前设好
$env:CMDC_PAK_GOOGLE_CLIENT_ID     = '<你的 client id>'
$env:CMDC_PAK_GOOGLE_CLIENT_SECRET = '<你的 client secret>'
.\start.bat
```

```bash
# macOS / Linux
export CMDC_PAK_GOOGLE_CLIENT_ID='<你的 client id>'
export CMDC_PAK_GOOGLE_CLIENT_SECRET='<你的 client secret>'
node server.mjs
```

未设置这两个变量时，**只有 Gemini 渠道**会在发起登录时报错并说明原因，
其余 12 个渠道完全不受影响。


## 登录状态与验证

```bash
# 看每个渠道的模型数与已登录账号数
curl -X POST http://127.0.0.1:18900/rpc -H "Authorization: Bearer <key>" \
  -H "Content-Type: application/json" \
  -d '{"method":"provider.status","payload":{"providers":["codearts","buddy","qoder"]}}'

# 列出模型；已登录渠道的模型会带 "x-provider-ready": true
curl http://127.0.0.1:18900/v1/models -H "Authorization: Bearer <key>"

# 对话
curl http://127.0.0.1:18900/v1/chat/completions \
  -H "Authorization: Bearer <key>" -H "Content-Type: application/json" \
  -d '{"model":"codearts/GLM-5.2","messages":[{"role":"user","content":"你好"}]}'
```

未登录就调用对话时，网关会返回 **409** 并直接告诉你该执行哪条登录命令，
不会再给一个看不出原因的 404。

## 常用 RPC 方法

| 方法 | payload | 说明 |
|------|---------|------|
| `account.create` | `{provider}` | 触发登录，返回 `accountId` + `loginUrl` |
| `account.list` | `{provider}` | 列出该渠道已登录账号 |
| `account.delete` | `{accountId}` | 删除账号（注意字段名是 `accountId`，不是 `id`） |
| `account.test` | `{provider, accountId}` | 测试账号可用性 |
| `account.refresh` | `{provider}` | 刷新凭证/额度 |
| `account.reorder` | `{provider, orderedIds}` | 调整自动选号顺序 |
| `model.list` | `{provider}` | 该渠道全量模型目录（**不需要登录**） |
| `provider.status` | `{providers:[...]}` | 模型数 / 账号数 / 是否关闭 |
| `model.setDisabled` | `{provider, model, disabled}` | 停用某个模型（也会影响统一 API） |
| `credits.balances` | `{provider}` | 查询额度余额 |
| `credits.claimAll` | `{provider}` | 领取签到/每日额度 |
| `gateway.getEnabled` / `setEnabled` | `{}` | 渠道包总开关 |
| `backup.export` / `backup.import` | `{}` | 备份/恢复渠道数据 |

完整方法集由 `channels/business.mjs` 提供，与原项目 channel-pack 完全一致
（`opencode.*` 系列在本剥离版中被显式禁用）。

## 注意事项

- 凭证文件 `channel-credentials.json` 权限为 0600，仅当前用户可读；不要提交到版本库。
- 免费额度、渠道可用性随时可能变化，属“尽力而为”，不要承载敏感数据。