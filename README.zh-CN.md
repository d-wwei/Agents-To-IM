# Agents-to-IM

**5 大 IM 平台 · 4 种 AI 运行时 · 一座桥**

中文 | [English](README.md)

> 官方 Agent 正在纷纷上线自带的 IM 桥接功能。但如果你用的是第三方 API Key、TUI Agent、或者本地模型——这些功能跟你无关。Agents-to-IM 解决的就是这个问题：让**任何** AI 编程 Agent 都能桥接到 Telegram、Discord、飞书、QQ 或微信，不管背后是谁的 Key。

---

## 这个项目解决什么问题

越来越多的 AI 编程 Agent——Claude Code、Codex、Gemini CLI——在加自己的 IM 集成。但这些功能只在官方 API + 官方账号下才能用。

现实中很多开发者的处境：

- 你的 Agent 走的是**第三方 API 中转**（relay、代理、自建端点）
- 你在用**TUI 类 Agent**（aider、cursor-cli、自定义 wrapper），压根没有 IM 能力
- 你用的**是官方 Agent，但配了第三方 Key**——IM 功能不会激活

这些用户被挡在门外了。没有官方桥接，没有好的替代方案。在终端和 IM 之间来回复制粘贴就是"解决方案"。

**Agents-to-IM 就是为这个场景造的。** 它不关心你用谁的 API Key，也不关心 Agent 怎么和 LLM 通信。它在 SDK/CLI 层接入，把完整会话——流式输出、权限审批、工具调用——桥接到你的 IM 里。

## 工作原理

```
你 (Telegram / Discord / 飞书 / QQ / 微信)
  ↕ Bot API
后台守护进程 (Node.js)
  ↕ Host SDK / CLI 桥接
你的编程 Agent → 读写你的代码库
```

一个轻量守护进程跑在你的开发机上，把 IM 机器人和你安装的编程 Agent 连起来——官方 Key、第三方 Key、本地模型都行。Agent 看到的是正常对话，你的 IM 看到的是功能完整的机器人。

## 飞书深度集成——这个项目的王牌

我们支持 5 个 IM 平台，但**飞书/Lark 是我们做得最深的地方**。飞书的每个 API 能力都被充分利用，打造的是原生级体验，不是简单套壳。

### 零延迟连接

Telegram 用的是 HTTP 长轮询——每条消息都有一次往返开销：客户端问"有新消息吗？"，服务端挂起 30 秒，返回更新，客户端再问一次。即使是长轮询，每个周期都有固有的延迟。

飞书适配器走的是完全不同的路：**WSClient 持久 WebSocket**。一条 TCP 连接始终保持。服务端在事件发生的瞬间推送——没有轮询间隔，没有往返开销。

但 WebSocket 只是传输层。真正的工程巧思在消息到达之后：

**基于 Waiter 的异步队列。** 当桥接循环空闲等待下一条消息时，它把一个 Promise resolver 停在等待者列表里。WebSocket 事件一触发，适配器调用 `enqueue()`——如果有等待者，立即 resolve，完全跳过队列。零缓冲延迟。消息从 WebSocket 帧到处理函数只需一个 microtask。

**即发即忘的会话分发。** 事件循环不阻塞在消息处理上。每条普通消息通过 `processWithSessionLock()` 分发到对应的会话锁——然后循环立即回去消费下一个事件。不同会话并发处理；同会话消息通过 Promise 链串行化（不是互斥锁），所以跨会话之间零锁竞争。

**统一事件通道。** 聊天消息（`im.message.receive_v1`）和卡片按钮回调（`card.action.trigger`）走**同一条 WebSocket 连接**，通过共享的 EventDispatcher 路由。用户点击权限卡片上的"允许"按钮时，回调不走单独的 Webhook 端点——它落在同一条连接上，路由到权限代理，解除阻塞中的 LLM 流。不需要额外的 HTTP 监听器，不需要 NAT 穿透，不增加任何延迟。

**自动重连。** SDK 透明处理连接断开。适配器不需要心跳定时器或重连逻辑——WSClient 自动恢复连接并继续事件投递。

最终效果：从你在飞书按下发送到桥接开始处理消息，延迟只取决于网络 RTT——不取决于任何轮询间隔、队列延迟或序列化开销。

### 流式输出：卡片实时刷新

Agent 的响应不是想完了再一坨丢给你，而是**实时流入**。

适配器在收到第一个 token 时创建一张**交互式卡片**，然后随着内容生成**原地 patch**。你能看到响应逐字形成，底部带 `⏳ 正在生成...` 提示，完成后自动消失。如果 patch 失败（限流、API 抖动），流式模式优雅降级——不崩溃、不重复发消息。

底层参数：800ms 节流间隔，30 字符最小增量，3500 字符卡片上限。全部可配置。

### 卡片式权限审批

Agent 要用工具（编辑文件、执行命令）时，飞书用户不会看到一行纯文本提示。而是一张**交互式卡片**，带真正的按钮：

```
┌──────────────────────────────────┐
│ 🔐 需要权限                       │
│                                  │
│ 工具: Edit src/main.ts           │
│ 操作: 替换第 42-58 行             │
│                                  │
│ ┌──────┐ ┌──────────────┐       │
│ │ 允许  │ │ 本会话允许    │       │
│ └──────┘ └──────────────┘       │
│ ┌──────┐                        │
│ │ 拒绝  │                        │
│ └──────┘                        │
│                                  │
│ 备用: /perm allow <id>           │
└──────────────────────────────────┘
```

点按钮 → 卡片原地更新显示决策结果 → Agent 继续或停止。没有消息来回。如果按钮失效，文字版 `/perm` 命令就在同一张卡片上。

卡片头部还会变色：蓝色表示已处理，灰色表示已过期。

### 语音消息转写

在飞书发语音 → 机器人自动转成文字 → 喂给 Agent。

双引擎转写：
1. **主引擎**：飞书自带 STT API——零额外成本，支持中英文
2. **备用引擎**：OpenAI Whisper——飞书 STT 失败或限流时自动接管

音频管线处理格式检测（magic bytes）、WAV PCM 提取、ffmpeg/afconvert 转码。OGG、MP3、WAV、FLAC、M4A 全部支持。

### 合并转发消息解析

别人转发一组聊天记录给机器人？适配器通过飞书 API 拉取所有子消息，从通讯录解析发送者姓名（LRU 缓存，最大 500 条），拼成可读的上下文：

```
--- 以下是一组合并转发的聊天记录 ---
张三: 线上数据库连接超时了
李四: 看了下监控，连接池满了
张三: [图片]
--- 合并转发结束 ---
```

嵌套转发、图片、文件、音频——全部解析成结构化上下文交给 Agent。

### 富文本智能渲染

响应自动检测内容复杂度，选最合适的飞书格式：

- **代码块或表格** → 交互式卡片（Schema 2.0），完整 Markdown 渲染
- **纯文字** → Post 消息，带 Markdown 标签
- **工具执行进度** → 实时图标（`🔄 运行中` / `✅ 完成` / `❌ 出错`）嵌入卡片
- **最终响应** → 卡片带状态栏，显示耗时

### 两阶段上下文表情回复

不是随便贴个表情。机器人读懂你的消息内容，然后有针对性地回应。

**第一阶段——即时确认。** 消息到达的瞬间，根据你说的内容贴表情：

| 你发的内容 | 机器人表情 |
|-----------|-----------|
| "你好" / "hello" | 👋 挥手 |
| "帮我" / "请" | 🫡 收到 |
| "debug" / "分析" | 🧠 聪明 |
| "urgent" / "马上" | 🔥 着火 |
| "谢谢" / "thanks" | ❤️ 爱心 |
| "为什么" / "怎么" | 🤔 思考中 |

**第二阶段——总结回应。** 响应生成完毕后，根据回答内容替换表情：

| 响应包含 | 表情 |
|---------|------|
| 大段代码块（>50 字符） | ✅ 搞定 |
| "fix" / "完成" / "解决" | ☑️ 勾选 |
| 警告 / 注意事项 | 🚨 警报 |
| 有序列表 / 步骤 | 👏 鼓掌 |
| 表格 | 🧠 聪明 |

第一阶段告诉你"我在处理了"。第二阶段告诉你"结果如何"。两者都不侵入——它们是贴在你原消息上的 reaction，不是额外的机器人消息。

## 对比

| 能力 | 官方 Agent IM | 普通聊天机器人 | Agents-to-IM |
|------|:-:|:-:|:-:|
| 支持第三方 API Key | 🔴 | 🟡 部分 | 🟢 |
| 支持 TUI Agent | 🔴 | 🔴 | 🟢 |
| IM 内工具权限审批 | 🟡 有限 | 🔴 | 🟢 按钮 + 文字 |
| 流式预览 | 🟡 看平台 | 🔴 | 🟢 平台级优化 |
| 飞书交互式卡片 | 🔴 | 🔴 | 🟢 Schema 2.0 |
| 上下文表情回复 | 🔴 | 🔴 | 🟢 两阶段 |
| IM 内语音转写 | 🔴 | 🔴 | 🟢 双引擎 |
| 会话持久化 | 🟡 看平台 | 🔴 | 🟢 跨重启 |
| 多平台同时运行 | 🔴 单平台 | 🔴 | 🟢 最多 5 个 |

## 支持的平台

| 平台 | 连接方式 | 特色能力 |
|------|---------|---------|
| **飞书/Lark** | WSClient (WebSocket) | 交互式卡片、流式预览、表情回复、语音转写、卡片权限审批、合并转发解析、群聊策略 |
| **Telegram** | 长轮询 | 内联按钮、流式预览、媒体附件、HTML 渲染 |
| **Discord** | WebSocket Gateway | 原生 Markdown、内联按钮、流式预览 |
| **QQ** | C2C 私聊 | 文字命令、图片接收 |
| **微信** | 扫码登录 | 文字权限、单账号模式 |

## 快速上手

### Claude Code

```bash
# 安装
npx skills add d-wwei/Agents-To-IM

# 设置（在 Claude Code 里）
/claude-to-im setup

# 启动
/claude-to-im start
```

### Codex

```bash
# 克隆并安装
git clone https://github.com/d-wwei/Agents-To-IM.git ~/code/Agents-to-IM
bash ~/code/Agents-to-IM/scripts/install-codex.sh

# 设置（在 Codex 里）
claude-to-im setup

# 启动
start bridge
```

### Gemini CLI

```bash
bash ~/code/Agents-to-IM/scripts/install-host.sh --host gemini
# 然后在 Gemini 里: gemini-to-im setup → start bridge
```

设置向导全程引导：平台选择、Token 获取（附分步说明）、权限配置、实时 API 验证。

## IM 内命令（完整参考）

桥接运行后，以下命令可直接在 IM 聊天中使用：

### 会话管理

| 命令 | 说明 |
|------|------|
| `/new [路径]` | 新建会话。可选：指定工作目录路径 |
| `/bind <session_id>` | 将当前聊天绑定到已有会话 |
| `/lsessions` | 列出所有聊天中的桥接会话 |
| `/lsessions --all` | 包含已归档的会话 |
| `/switchto <id\|名称>` | 切换当前聊天到另一个会话（按 ID 或名称） |
| `/rename <新名称>` | 重命名当前会话 |
| `/archive [id\|名称]` | 归档会话并保留摘要。省略参数则归档当前会话 |
| `/unarchive <id\|名称>` | 恢复已归档的会话 |
| `/sessions` | 列出当前频道的近期运行时会话 |

### 配置

| 命令 | 说明 |
|------|------|
| `/cwd <路径>` | 修改当前绑定的工作目录 |
| `/mode <plan\|code\|ask>` | 切换桥接模式 |

### 状态与任务

| 命令 | 说明 |
|------|------|
| `/status` | 查看当前绑定状态（会话、目录、模式、模型） |
| `/tasks` | 列出最近的桥接任务（最多 5 条） |
| `/resume_last` | 恢复最近一次中断的任务；如无任务记录，回退到会话历史中最后一条用户请求 |

### 控制

| 命令 | 说明 |
|------|------|
| `/stop` | 中止当前正在运行的任务 |
| `/start` | 显示桥接帮助和可用命令 |
| `/help` | 显示命令帮助 |

### 权限

| 命令 | 说明 |
|------|------|
| `/perm allow <id>` | 允许待处理的工具权限请求 |
| `/perm allow_session <id>` | 允许该工具在整个会话中使用 |
| `/perm deny <id>` | 拒绝待处理的工具权限请求 |

在 Telegram 和 Discord 上，权限请求同时以**内联按钮**展示。在飞书上以**交互式卡片按钮**展示。在 QQ 和微信上，使用上述文字命令或快捷回复（`1`/`2`/`3`）。

## 双层设计：库 + 技能

| 层 | 面向 | 用途 |
|----|-----|------|
| **Agent-to-IM-core**（库） | 要在自己应用里嵌入 IM 的开发者 | Host 无关桥接，4 个 DI 接口，零框架耦合 |
| **Agent-to-IM-Skill**（技能） | 3 分钟内要用上的用户 | 后台守护进程，交互式向导，零代码 |

### 库集成

```typescript
import { initBridgeContext } from 'agent-to-im-core/context';
import * as bridgeManager from 'agent-to-im-core/bridge-manager';

initBridgeContext({ store, llm, permissions, lifecycle });
await bridgeManager.start();
```

完整指南：[`Agent-to-IM-core/docs/development.md`](Agent-to-IM-core/docs/development.md)

## 架构

```
┌─────────────────────────────────────────────────────┐
│                    IM 平台                            │
│  Telegram  │  Discord  │  飞书  │  QQ  │  微信       │
└─────┬──────┴─────┬─────┴───┬────┴───┬──┴────┬───────┘
      ▼            ▼         ▼        ▼       ▼
┌─────────────────────────────────────────────────────┐
│              Bridge Manager（编排器）                  │
│  消息路由 → 会话引擎 → 投递层                          │
│  权限代理 → 限流器 → Markdown IR                      │
└────────────────────────┬────────────────────────────┘
                         │  DI 接口
                         ▼
┌─────────────────────────────────────────────────────┐
│              宿主应用层                               │
│  BridgeStore │ LLMProvider │ PermissionGW │ Hooks    │
└────────────────────────┬────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────┐
│              AI 运行时（任何 Key，任何提供商）           │
│  Claude Code SDK  │  Codex SDK  │  Gemini CLI        │
└─────────────────────────────────────────────────────┘
```

## 宿主命令

| 命令 | 说明 |
|------|------|
| `setup` | 交互式设置向导 |
| `start` | 启动桥接守护进程 |
| `stop` | 停止守护进程 |
| `status` | 检查状态 |
| `logs [N]` | 查看最近 N 行日志 |
| `doctor` | 运行完整诊断 |

## 安全

- 凭据 `chmod 600` 存储，不会提交到 Git
- 模式匹配密钥遮蔽，覆盖所有日志
- 用户/频道/群组白名单限制访问
- 令牌桶限流（每聊天 20 条/分钟）
- 输入校验：防路径穿越、注入攻击
- 纯本地守护进程——无入站监听，无云端中转
- 完整威胁模型：[SECURITY.md](Agent-to-IM-Skill/SECURITY.md)

## 项目结构

```
Agents-to-IM/
├── Agent-to-IM-core/                # 桥接库（npm 包）
│   ├── src/lib/bridge/
│   │   ├── bridge-manager.ts        # 编排器
│   │   ├── adapters/                # 平台适配器（Telegram, Discord, 飞书, QQ）
│   │   ├── markdown/                # 平台级 IR 渲染
│   │   └── security/                # 校验与限流
│   └── docs/                        # 集成指南
│
├── Agent-to-IM-Skill/               # 技能应用（即装即用）
│   ├── src/                         # 守护进程、Provider、配置
│   ├── scripts/                     # 安装、进程管理、诊断
│   └── references/                  # 设置指南、故障排查
```

## 集成的 Kit

| Kit | 角色 | 版本 |
|-----|------|------|
| **udd-kit** | 守护进程启动时自动检查更新 | Latest |
| **update-kit** | 自动更新应用与版本管理 | Latest |

## 环境要求

| | 版本 |
|---|------|
| Node.js | >= 20 |
| AI Agent | Claude Code / Codex / Gemini CLI（任何 API Key） |

## 相关链接

- [库 README](Agent-to-IM-core/README.md) — 开发者集成指南
- [技能 README](Agent-to-IM-Skill/README.md) — 完整命令参考
- [架构文档](Agent-to-IM-core/src/lib/bridge/ARCHITECTURE.md) — 设计决策
- [开发指南](Agent-to-IM-core/docs/development.md) — Host 接口与 SSE 格式
- [故障排查](Agent-to-IM-Skill/references/troubleshooting.md) — 常见问题

## License

[MIT](LICENSE)
