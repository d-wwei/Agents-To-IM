# Codex-to-IM Skill

将当前安装的 AI 编程宿主桥接到 IM 平台 —— 在 Telegram、Discord、飞书、QQ 或微信中与 AI 编程代理对话。

[English](README.md)

> **想要桌面图形界面？** 试试 [CodePilot](https://github.com/op7418/CodePilot) —— 一个功能完整的桌面应用，提供可视化聊天界面、会话管理、文件树预览、权限控制等。本 Skill 从 CodePilot 的 IM 桥接模块中提取而来，适合偏好轻量级纯 CLI 方案的用户。

---

## 工作原理

本 Skill 运行一个后台守护进程，将你的 IM 机器人连接到当前安装的宿主代理。来自 IM 的消息被转发给 AI 编程代理，响应（包括工具调用、权限请求、流式预览）会发回到聊天中。

```
你 (Telegram/Discord/飞书/QQ/微信)
  ↕ Bot API
后台守护进程 (Node.js)
  ↕ 宿主 SDK / CLI 桥接层（通过 CTI_RUNTIME 配置）
当前安装的宿主代理 → 读写你的代码库
```

## 功能特点

- **五大 IM 平台** — Telegram、Discord、飞书、QQ、微信，可任意组合启用
- **交互式配置** — 引导式向导逐步收集 token，附带详细获取说明
- **权限控制** — Claude 支持逐工具内联审批（Telegram/Discord）或文本 `/perm` 命令 / 快捷 `1/2/3` 回复（飞书/QQ/微信）；Codex 在 `approval_policy=on-request` 时支持 IM 中的单轮前置审批
- **流式预览** — 实时查看 Claude 的输出（Telegram 和 Discord 支持）
- **会话持久化** — 对话在守护进程重启后保留
- **密钥保护** — token 以 `chmod 600` 存储，日志中自动脱敏
- **多宿主隔离安装** — 可按 `<host>-to-im` 模式安装隔离变体，并使用对应运行时目录
- **无需编写代码** — 安装 Skill 后运行当前宿主对应的 setup 命令即可

## 前置要求

- **Node.js >= 20**
- **Codex CLI** — 已安装并完成认证（`codex` 命令可用；可通过 `codex login` 登录）
- **可选的 Claude CLI**（仅当你计划使用 `CTI_RUNTIME=claude` 或 `auto` 时）

## 安装

请先按你实际使用的 AI Agent 产品选择对应安装方式。

### Claude Code

#### 推荐：`npx skills`

```bash
npx skills add op7418/Claude-to-IM-skill
```

安装完成后，直接对 Claude Code 说：

```text
/claude-to-im setup
```

如果你主要想接微信，也可以直接说：

```text
帮我接微信
```

#### 备选：直接克隆到 Claude Code Skills 目录

```bash
git clone https://github.com/op7418/Claude-to-IM-skill.git ~/.codex/skills/codex-to-im
```

将仓库直接克隆到所选宿主的 Skills 目录，Claude Code 会自动发现。

#### 备选：符号链接方式（适合开发）

```bash
git clone https://github.com/op7418/Claude-to-IM-skill.git ~/code/Claude-to-IM-skill
mkdir -p ~/.codex/skills
ln -s ~/code/Claude-to-IM-skill ~/.codex/skills/codex-to-im
```

### Codex

#### 推荐：使用 Codex 安装脚本

```bash
git clone https://github.com/op7418/Claude-to-IM-skill.git ~/code/Claude-to-IM-skill
bash ~/code/Claude-to-IM-skill/scripts/install-codex.sh
```

如果你想保留可开发的本地仓库：

```bash
bash ~/code/Claude-to-IM-skill/scripts/install-codex.sh --link
```

安装脚本会把 Skill 放到 `~/.codex/skills/claude-to-im`，并自动安装依赖、构建 daemon。

安装完成后，直接对 Codex 说：

```text
claude-to-im setup
```

如果你主要想接微信，也可以直接说：

```text
帮我接微信桥接
```

#### 备选：直接克隆到 Codex skills 目录

```bash
git clone https://github.com/op7418/Claude-to-IM-skill.git ~/.codex/skills/codex-to-im
cd ~/.codex/skills/codex-to-im
npm install
npm run build
```

### 多宿主安装

如果你希望在同一台机器上同时给多个宿主工具安装隔离版本，可以使用通用安装脚本：

```bash
bash ~/code/Claude-to-IM-skill/scripts/install-host.sh --host claude
bash ~/code/Claude-to-IM-skill/scripts/install-host.sh --host codex
bash ~/code/Claude-to-IM-skill/scripts/install-host.sh --host gemini
```

这样会生成彼此隔离的命令和运行时目录，命名模式为：

```text
<host>-to-im  -> ~/.<host>-to-im
```

### 验证安装

**Claude Code：** 启动新会话，输入 `/` 应能看到 `claude-to-im`。也可以直接问 Claude：”What skills are available?”

**Codex：** 启动新会话，说 `codex-to-im setup`、`start bridge` 或 `帮我接微信桥接`。Codex 会识别 Skill 并使用 `~/.codex-to-im` 作为运行时目录。

## 更新 Skill

请按你的 AI Agent 产品和安装方式选择对应的更新方式。

### Claude Code

如果你是通过 `npx skills` 安装的，直接重新执行：

```bash
npx skills add op7418/Claude-to-IM-skill
```

如果你是通过 `git clone` 或符号链接安装的：

```bash
cd ~/.claude/skills/claude-to-im
git pull
npm install
npm run build
```

更新完成后，对 Claude Code 说：

```text
/claude-to-im doctor
/claude-to-im start
```

### Codex

如果你是用 `install-codex.sh` 的复制模式安装的：

```bash
rm -rf ~/.codex/skills/claude-to-im
bash ~/code/Claude-to-IM-skill/scripts/install-codex.sh
```

如果你是用 `--link` 模式，或者直接克隆到 Codex skills 目录：

```bash
cd ~/.codex/skills/claude-to-im
git pull
npm install
npm run build
```

更新完成后，对 Codex 说：

```text
claude-to-im doctor
start bridge
```

## 快速开始

### 1. 配置

**Claude Code**

```text
/claude-to-im setup
```

**Codex**

```text
claude-to-im setup
```

向导会引导你完成以下步骤：

1. **选择渠道** — 选择 Telegram、Discord、飞书、QQ、微信，或任意组合
2. **输入凭据** — 向导会详细说明如何获取每个 token、需要开启哪些设置、授予哪些权限
3. **设置默认值** — 工作目录、模型、模式
4. **验证** — 立即通过平台 API 验证 token 有效性

### 2. 启动

**Claude Code**

```text
/claude-to-im start
```

**Codex**

```text
start bridge
```

守护进程在后台启动。关闭终端后仍会继续运行。

### 3. 开始聊天

打开 IM 应用，给你的机器人发消息，当前安装的宿主代理会通过桥接回复。

权限行为取决于 runtime：

- **Claude runtime** — 工具调用可在聊天中逐条审批：内联按钮 **允许** / **拒绝**（Telegram/Discord），或文本 `/perm` 命令 / 快捷 `1/2/3` 回复（飞书/QQ/微信）
- **Codex runtime** — 当 `approval_policy=on-request` 时，bridge 会在启动这一轮 Codex 执行前先在聊天里发起审批

## 命令列表

所有命令都在当前安装的宿主里执行：

| 支持斜杠命令的宿主 | 支持自然语言的宿主 | 说明 |
|---|---|---|
| `/codex-to-im setup` | "codex-to-im setup" / "配置" | 交互式配置向导 |
| `/codex-to-im start` | "start bridge" / "启动桥接" | 启动桥接守护进程 |
| `/codex-to-im stop` | "stop bridge" / "停止桥接" | 停止守护进程 |
| `/codex-to-im status` | "bridge status" / "状态" | 查看运行状态 |
| `/codex-to-im logs` | "查看日志" | 查看最近 50 行日志 |
| `/codex-to-im logs 200` | "logs 200" | 查看最近 200 行日志 |
| `/codex-to-im reconfigure` | "reconfigure" / "修改配置" | 交互式修改配置 |
| `/codex-to-im doctor` | "doctor" / "诊断" | 诊断问题 |

Bridge 还内建了一组可在 IM 聊天中直接使用的会话管理命令：

| IM 命令 | 说明 |
|---|---|
| `/lsessions` | 列出活跃 bridge 会话，显示名称、短 ID、渠道、状态、最近活跃时间和摘要 |
| `/lsessions --all` | 同时显示已归档会话 |
| `/switchto &lt;session_id\|name&gt;` | 让当前聊天切换到一个已有会话，支持按 ID 或名称切换 |
| `/rename &lt;new_name&gt;` | 重命名当前会话 |
| `/archive [session_id\|name]` | 归档当前会话或指定会话，并保留简短摘要 |
| `/unarchive &lt;session_id\|name&gt;` | 恢复一个已归档会话 |

## 平台配置指南

`setup` 向导会在每一步提供内联指引，以下是概要：

### Telegram

1. 在 Telegram 中搜索 `@BotFather` → 发送 `/newbot` → 按提示操作
2. 复制 bot token（格式：`123456789:AABbCc...`）
3. 建议：`/setprivacy` → Disable（用于群组）
4. 获取 User ID：给 `@userinfobot` 发消息

### Discord

1. 前往 [Discord 开发者门户](https://discord.com/developers/applications) → 新建应用
2. Bot 标签页 → Reset Token → 复制 token
3. 在 Privileged Gateway Intents 下开启 **Message Content Intent**
4. OAuth2 → URL Generator → scope 选 `bot` → 权限选 Send Messages、Read Message History、View Channels → 复制邀请链接

### 飞书 / Lark

1. 前往[飞书开放平台](https://open.feishu.cn/app)（或 [Lark](https://open.larksuite.com/app)）
2. 创建自建应用 → 获取 App ID 和 App Secret
3. **批量添加权限**：进入"权限管理" → 使用批量配置添加所有必需权限（`setup` 向导提供完整 JSON）
4. 在"添加应用能力"中启用机器人
5. **事件与回调**：选择**长连接**作为事件订阅方式 → 添加 `im.message.receive_v1` 事件
6. **发布**：进入"版本管理与发布" → 创建版本 → 提交审核 → 在管理后台审核通过
7. **注意**：版本审核通过并发布后机器人才能使用

### QQ

> QQ 目前仅支持 **C2C 私聊**（沙箱接入）。不支持群聊/频道、内联权限按钮、流式预览。权限确认使用文本 `/perm ...` 命令。仅支持图片入站（不支持图片回复）。

1. 前往 [QQ 机器人 OpenClaw](https://q.qq.com/qqbot/openclaw)
2. 创建或选择已有 QQ 机器人 → 获取 **App ID** 和 **App Secret**（仅需这两个必填项）
3. 配置沙箱接入，用 QQ 扫码添加机器人
4. `CTI_QQ_ALLOWED_USERS` 填写 `user_openid`（不是 QQ 号）— 可先留空
5. 如果底层 provider 不支持图片输入，设置 `CTI_QQ_IMAGE_ENABLED=false`

### 微信 / Weixin

> 微信当前采用扫码登录、单账号模式、文本权限确认，不支持流式预览。

1. 在已安装的 Skill 目录里运行本地扫码工具：
   - Claude Code 默认安装：`cd ~/.claude/skills/claude-to-im && npm run weixin:login`
   - Codex 默认安装：`cd ~/.codex/skills/claude-to-im && npm run weixin:login`
2. 工具会生成 `~/.claude-to-im/runtime/weixin-login.html`，并尽量自动用浏览器打开
3. 用微信扫码并在手机上确认
4. 成功后，账号会保存到 `~/.claude-to-im/data/weixin-accounts.json`
5. 再次运行扫码工具，会替换当前已绑定的微信账号

补充说明：

- `CTI_WEIXIN_MEDIA_ENABLED` 只控制图片 / 文件 / 视频的入站下载
- 语音消息只使用微信自带的语音转文字结果
- 如果微信没有提供 `voice_item.text`，桥会直接报错，不会自行下载或转写原始语音
- 权限确认使用文本 `/perm ...` 命令或快捷 `1/2/3` 回复


## 架构

```
~/.<host>-to-im/
├── config.env             ← 凭据与配置 (chmod 600)
├── openai.local.env       ← 可选的本地 include secrets 文件 (chmod 600)
├── data/                  ← 持久化 JSON 存储
│   ├── sessions.json
│   ├── bindings.json
│   ├── permissions.json
│   └── messages/          ← 按会话分文件的消息历史
├── logs/
│   └── bridge.log         ← 自动轮转，密钥脱敏
└── runtime/
    ├── bridge.pid          ← 守护进程 PID 文件
    └── status.json         ← 当前状态
```

### 核心组件

| 组件 | 职责 |
|---|---|
| `src/main.ts` | 守护进程入口，组装依赖注入，启动 bridge |
| `src/config.ts` | 加载/保存 `config.env`，映射为 bridge 设置 |
| `src/store.ts` | JSON 文件 BridgeStore（30 个方法，写穿缓存） |
| `src/llm-provider.ts` | Claude Agent SDK `query()` → SSE 流 |
| `src/codex-provider.ts` | Codex SDK `runStreamed()` → SSE 流 |
| `src/sse-utils.ts` | 共享的 SSE 格式化辅助函数 |
| `src/permission-gateway.ts` | 异步桥接权限解析与 IM 审批交接 |
| `src/logger.ts` | 密钥脱敏的文件日志，支持轮转 |
| `scripts/daemon.sh` | 进程管理（start/stop/status/logs） |
| `scripts/doctor.sh` | 诊断检查 |
| `SKILL.md` | 宿主 Skill 定义文件 |

### 权限流程

Claude runtime：

```
1. 代理想使用工具（如编辑文件）
2. SDK 调用 canUseTool() → LLMProvider 发射 permission_request SSE 事件
3. Bridge 在 IM 聊天中发送内联按钮：[允许] [拒绝]
4. canUseTool() 阻塞等待用户响应（5 分钟超时）
5. 用户点击允许 → Bridge 解除权限等待
6. SDK 继续执行工具 → 结果流式发回 IM
```

Codex runtime：

```
1. Bridge 为当前这一轮解析 Codex 的 approval policy
2. 如果 `approval_policy=on-request`，CodexProvider 会在执行前发出一个 synthetic permission_request
3. Bridge 在 IM 中发送审批控件或 `/perm allow|deny <id>` 提示
4. 用户批准 → 这一轮 Codex 执行才开始
5. 用户拒绝或超时 → 这一轮不会开始执行
```

## 故障排查

运行诊断：

```
/codex-to-im doctor
```

检查项目：Node.js 版本、配置文件是否存在及权限、token 有效性（实时 API 调用）、日志目录、PID 文件一致性、最近的错误。

| 问题 | 解决方案 |
|---|---|
| `Bridge 无法启动` | 运行 `doctor`，检查 Node 版本和日志 |
| `收不到消息` | 用 `doctor` 验证 token，检查允许用户配置 |
| `权限超时` | 用户 5 分钟内未响应，工具调用自动拒绝 |
| `PID 文件残留` | 运行 `stop` 再 `start`，脚本会自动清理 |

详见 [references/troubleshooting.md](references/troubleshooting.md)。

## 安全

- 所有凭据存储在 `~/.codex-to-im/config.env`，权限 `chmod 600`
- `config.env` 也可以按 include 方式引用本地 secrets 文件，例如 `~/.codex-to-im/openai.local.env`；现在加载配置时会真正解析这层 include
- 日志输出中 token 自动脱敏（基于正则匹配）
- 允许用户/频道/服务器列表限制谁可以与机器人交互
- 守护进程是本地进程，没有入站网络监听
- 详见 [SECURITY.md](SECURITY.md) 了解威胁模型和应急响应

## 开发

```bash
npm install        # 安装依赖
npm run dev        # 开发模式运行
npm run typecheck  # 类型检查
npm test           # 运行测试
npm run build      # 构建打包
```

## 许可

[MIT](LICENSE)
