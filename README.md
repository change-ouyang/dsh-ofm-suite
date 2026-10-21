# dsh-ofm-suite

把 [dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model) 的 13 个免费渠道
能力拆成两个能单独用、也能配起来用���部分：

| 目录 | 是什么 | 需要 DSH 吗 |
| --- | --- | --- |
| [`dsh-ofm-free-gateway/`](dsh-ofm-free-gateway/) | **网关** —— 一个零依赖的 Node 服务，把 13 个渠道包装成 OpenAI 兼容 API，并做每日自动签到 | 否 |
| [`dsh-ofm-checkin/`](dsh-ofm-checkin/) | **DSH 插件** —— 在 DSH 设置里做一个「每日签到」页：逐渠道状态、一键领取、单渠道领取、开关 | 是 |

两者是**一对**：插件是界面，网关干活。凭据只由网关独占（插件从不碰 `.credentials.yaml`），
所以两边不会互相消耗一次性刷新令牌。

克隆后它们是**兄弟目录**，插件会自动找到旁边的网关 —— 装完即用，不用改配置。

---

## 快速开始

```powershell
git clone https://github.com/change-ouyang/dsh-ofm-suite.git
cd dsh-ofm-suite

# 1) 起网关（Windows：后台静默，不弹黑窗口）
cd dsh-ofm-free-gateway
start.bat

# 2) 各渠道登录一次（浏览器 OAuth / 扫码 / 设备码）
#    详见 dsh-ofm-free-gateway/LOGIN.md
```

网关起来后：

```bash
curl http://127.0.0.1:18900/v1/models -H "Authorization: Bearer <你的API Key>"
```

首次启动会生成 API Key 并打印，同时写进数据目录 `~/.ofm-free-gateway/settings.json`。

> **不用 DSH 也能用**：网关本身就是一个 OpenAI 兼容的 API 服务，任何客户端
> （Cherry Studio、NextChat、自己的脚本……）都能指过来。
> DSH 插件只是把它做得更顺手。

---

## 把插件装进 DSH

插件与网关是兄弟目录时，**不需要任何额外配置**。

### Web（`dsh web`）

```powershell
dsh plugin --profile web add link:<克隆目录>/dsh-ofm-suite/dsh-ofm-checkin
```

### 桌面端

桌面端 profile 由 Electron 应用独占管理，`dsh plugin --profile desktop` 会报
`profile "desktop" is managed exclusively by the Electron application`，
所以需要手工注册两处：

1. 把 `dsh-ofm-checkin/` 链入 `~/.dsh/profiles/desktop/node_modules/dsh-ofm-checkin`
2. 在 `~/.dsh/profiles/desktop/package.json` 的 `dependencies` 与
   `dsh.profile.bundles` 中分别加上 `dsh-ofm-checkin`

**装完必须重启 DSH**。重启后在 **设置 → 每日签到** 找到它。

### 网关不在旁边？

插件按这个顺序找网关，取第一个存在的：

1. 环境变量 `OFM_GATEWAY_DIR`
2. 插件目录的**兄弟目录**
3. 用户主目录下的 `dsh-ofm-free-gateway/` 或 `ofm-free-gateway/`

都不在就在 `dsh-ofm-checkin/cordis.patch.yml` 的 `config` 里显式写 `startScript` /
`syncScript`。

---

## 13 个渠道

| 渠道 | provider | 登录方式 |
| --- | --- | --- |
| 华为 CodeArts | `codearts` | 华为云 OAuth |
| 腾讯 CodeBuddy | `buddy` | 腾讯 Copilot 账号 |
| 字节 WorkBuddy | `workbuddy` | 同 CodeBuddy 体系 |
| LobsterAI | `lobsterai` | 品牌账号 |
| 阿里 Qoder | `qoder` | 设备码 |
| Qoder 中文版 | `qodercn` | 同上（中文站） |
| TRAE | `trae` | 字节账号 |
| Cline | `cline` | Cline 账号 |
| Loomy | `loomy` | 微信扫码（本地托管登录页） |
| Raccoon | `raccoon` | 品牌账号 |
| MiniMax Code | `minimax` | MiniMax 账号 |
| ZCode | `zcode` | 智谱 bigmodel OAuth |
| Gemini | `gemini` | Google OAuth(**需自备 OAuth 客户端**,见 LOGIN.md) |

每个渠道都要**用你自己的账号做一次浏览器登录**。未登录也能列出全部模型目录，
但推理会被渠道层拒绝。

---

## 测试

两个子目录各自自足，**不依赖 DSH、也不依赖网关在跑、也不联网**：

```bash
cd dsh-ofm-free-gateway && npm test    # 64 项
cd dsh-ofm-checkin    && npm test    # 10 项
```

---

## 安全须知

- 网关**只绑定 loopback（127.0.0.1）**，且必须带 Bearer API key。
- 凭据写在数据目录 `~/.ofm-free-gateway/channel-credentials.json`（权限 0600），
  **不在仓库里**，也不进版本库。
- 各渠道的免费额度、可用性随时可能变化，属「尽力而为」，**不适合承载敏感数据**。

---

## License

MIT。渠道实现部分保留原项目的 MIT 许可 —— 逐文件的来源、哈希与署名见
[`NOTICE.md`](NOTICE.md)。
