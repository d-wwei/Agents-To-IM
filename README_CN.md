# Claude/Codex/Gemini-to-IM

把 AI 编程宿主桥接到 IM 平台，并为 Claude、Codex、Gemini 以及后续宿主提供彼此隔离的安装方式。

[English](README.md)

> **如果你更想要桌面 GUI：** 可以看看 [CodePilot](https://github.com/op7418/CodePilot)。它提供可视化聊天、会话管理、文件树预览、权限控制等完整桌面体验。这个仓库则是其 IM bridge 的轻量 CLI / Skill 版本。

---

## 这个仓库提供什么

- 一套共享代码库，用来生成 `claude-to-im`、`codex-to-im`、`gemini-to-im` 等宿主变体
- 每个宿主独立的运行时目录，命名规则为 `~/.<host>-to-im`
- Telegram、Discord、飞书 / Lark、QQ 四个平台桥接能力
- 后台 daemon 管理、权限审批、流式回复、会话持久化等能力
- 在 runtime 不原生支持普通文件输入时，仍能通过本地路径注入的方式保持一致的附件处理能力

## 宿主变体

| 宿主 | Skill 命令 | 默认 skill 目录 | 运行时目录 |
|---|---|---|---|
| Claude | `claude-to-im` | `~/.claude/skills/claude-to-im` | `~/.claude-to-im` |
| Codex | `codex-to-im` | `~/.codex/skills/codex-to-im` | `~/.codex-to-im` |
| Gemini | `gemini-to-im` | `~/.gemini/skills/gemini-to-im` | `~/.gemini-to-im` |

这样你就可以在同一台机器上同时安装多个宿主版本，而不会共享运行时配置、日志或 daemon 状态。

## 安装

先把仓库克隆到本地，作为开发或安装源：

```bash
git clone https://github.com/op7418/Claude-to-IM-skill.git ~/code/Claude-to-IM-skill
cd ~/code/Claude-to-IM-skill
```

然后按需要安装对应宿主版本：

```bash
bash scripts/install-host.sh --host claude
bash scripts/install-host.sh --host codex
bash scripts/install-host.sh --host gemini
```

每次安装都会把宿主专属命令、文档和运行时目录渲染到对应的 skill 目录里。

## 文档入口

- Claude 使用说明：安装后的 `claude-to-im` 文档
- Codex 使用说明：安装后的 `codex-to-im` 文档
- Gemini 使用说明：安装后的 `gemini-to-im` 文档
- 发布说明：[RELEASE_NOTES_CN.md](RELEASE_NOTES_CN.md)
- 故障排查参考：[references/troubleshooting.md](references/troubleshooting.md)
- 安全说明：[SECURITY.md](SECURITY.md)

## 附件支持

- 飞书 / Lark 的入站消息可以把图片和普通文件附件带进桥接层。
- Gemini 原本就会把附件写入本地临时目录，并把路径传给 CLI prompt。
- Codex 和 Claude Code 现在也采用相同的普通文件回退方案：把附件落地到本地临时文件，再把绝对路径注入 prompt。
- 图片附件在目标 runtime 支持的情况下仍然继续走原生多模态输入。

## 内建会话管理命令

桥接现在在桥接层内建了一组会话管理命令。因为这些命令会在消息转发给底层代理之前先被处理，所以 Claude、Codex、Gemini 三个宿主变体的行为是一致的。

| 命令 | 效果 |
|---|---|
| `/lsessions` | 列出活跃 bridge 会话，显示名称、短 ID、渠道、状态、最近活跃时间和摘要 |
| `/lsessions --all` | 列出全部会话，包括已归档会话 |
| `/switchto <session_id\|name>` | 让当前 IM 对话切换到一个已有会话，支持按 ID 或已命名名称切换 |
| `/rename <new_name>` | 重命名当前会话 |
| `/archive [session_id\|name]` | 归档当前会话或指定会话，并保留简短摘要 |
| `/unarchive <session_id\|name>` | 恢复一个已归档会话到活跃列表 |

实现说明：
- 会话名称、归档状态、摘要和最近活跃时间会持久化到 `~/.<host>-to-im/data/session-meta.json`
- 如果归档的是当前会话，桥接会自动为当前聊天创建一个新会话，避免后续消息继续写入归档任务
- 现有的 `/new`、`/bind`、`/status`、`/cwd`、`/mode`、`/stop`、`/help` 等命令仍然可用

## 开发

```bash
npm install
npm test
npm run build
```

如果你修改了仓库首页模板，可用下面的命令重新渲染根 README：

```bash
node scripts/render-host-templates.mjs --repo-home --target .
```

## 许可证

[MIT](LICENSE)
