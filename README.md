# Codex-to-IM Skill

Bridge your AI coding host (Claude Code, Codex, Gemini CLI) to IM platforms — chat with coding agents from Telegram, Discord, Feishu/Lark, QQ, or WeChat.

[中文文档](README_CN.md)

> **Want a desktop GUI instead?** Check out [CodePilot](https://github.com/op7418/CodePilot) — a full-featured desktop app with visual chat interface, session management, file tree preview, permission controls, and more. This skill was extracted from CodePilot's IM bridge module for users who prefer a lightweight, CLI-only setup.

---

## How It Works

This skill runs a background daemon that connects your IM bots to the currently installed host agent. Messages from IM are forwarded to the coding agent, and responses (including tool use, permission requests, streaming previews) are sent back to your chat.

```
You (Telegram/Discord/Feishu/QQ/WeChat)
  ↕ Bot API
Background Daemon (Node.js)
  ↕ Host SDK or CLI bridge (configurable via CTI_RUNTIME)
Installed host agent → reads/writes your codebase
```

## Features

- **Five IM platforms** — Telegram, Discord, Feishu/Lark, QQ, WeChat — enable any combination
- **Interactive setup** — guided wizard collects tokens with step-by-step instructions
- **Permission control** — Claude supports tool-level inline approvals via inline buttons (Telegram/Discord) or text `/perm` commands / quick `1/2/3` replies (Feishu/QQ/WeChat); Codex supports pre-turn approval in IM when `approval_policy=on-request`
- **Streaming preview** — see Claude's response as it types (Telegram & Discord)
- **Session persistence** — conversations survive daemon restarts
- **Secret protection** — tokens stored with `chmod 600`, auto-redacted in all logs
- **Multi-host installs** — install isolated variants following the pattern `<host>-to-im` with matching runtime homes
- **Zero code required** — install the skill and run the setup command for your host variant, that's it

## Prerequisites

- **Node.js >= 20**
- **Codex CLI** — installed and authenticated (`codex` command available; login via `codex login`)
- **Optional Claude CLI** (only if you plan to use `CTI_RUNTIME=claude` or `auto`)

## Installation

Choose the section that matches the AI agent product you actually use.

### Claude Code

#### Recommended: `npx skills`

```bash
npx skills add d-wwei/Claude-Codex-Gemini-to-IM
```

After installation, tell Claude Code:

```text
/claude-to-im setup
```

If you want WeChat specifically, you can also say:

```text
帮我接微信
```

#### Alternative: clone directly into Claude Code skills

```bash
git clone https://github.com/d-wwei/Claude-Codex-Gemini-to-IM.git ~/.codex/skills/codex-to-im
```

Clones the repo directly into the selected host skills directory. Claude Code discovers it automatically.

#### Alternative: symlink for development

```bash
git clone https://github.com/d-wwei/Claude-Codex-Gemini-to-IM.git ~/code/Claude-to-IM-skill
mkdir -p ~/.codex/skills
ln -s ~/code/Claude-to-IM-skill ~/.codex/skills/codex-to-im
```

### Codex

#### Recommended: use the Codex install script

```bash
git clone https://github.com/d-wwei/Claude-Codex-Gemini-to-IM.git ~/code/Claude-to-IM-skill
bash ~/code/Claude-to-IM-skill/scripts/install-codex.sh
```

For local development with a live checkout:

```bash
bash ~/code/Claude-to-IM-skill/scripts/install-codex.sh --link
```

The install script places the skill under `~/.codex/skills/claude-to-im`, installs dependencies, and builds the daemon.

After installation, tell Codex:

```text
claude-to-im setup
```

If you want WeChat specifically, you can also say:

```text
帮我接微信桥接
```

#### Alternative: clone directly into Codex skills

```bash
git clone https://github.com/d-wwei/Claude-Codex-Gemini-to-IM.git ~/.codex/skills/codex-to-im
cd ~/.codex/skills/codex-to-im
npm install
npm run build
```

### Multi-host install

Use the generic installer when you want separate installs for multiple hosts on the same machine:

```bash
bash ~/code/Claude-to-IM-skill/scripts/install-host.sh --host claude
bash ~/code/Claude-to-IM-skill/scripts/install-host.sh --host codex
bash ~/code/Claude-to-IM-skill/scripts/install-host.sh --host gemini
```

This creates isolated skill commands and runtime homes, following the pattern:

```text
<host>-to-im  -> ~/.<host>-to-im
```

### Verify installation

**Claude Code:** Start a new session and type `/` — you should see `claude-to-im` in the skill list. Or ask Claude: "What skills are available?"

**Codex:** Start a new session and say `codex-to-im setup`, `start bridge`, or `帮我接微信桥接` — Codex will recognize the skill and use `~/.codex-to-im` for its runtime data.

## Updating the Skill

Choose the update flow that matches both your AI agent product and your installation method.

### Claude Code

If you installed with `npx skills`, re-run:

```bash
npx skills add d-wwei/Claude-Codex-Gemini-to-IM
```

If you installed via `git clone` or symlink:

```bash
cd ~/.claude/skills/claude-to-im
git pull
npm install
npm run build
```

Then tell Claude Code:

```text
/claude-to-im doctor
/claude-to-im start
```

### Codex

If you installed with the Codex install script in copy mode:

```bash
rm -rf ~/.codex/skills/claude-to-im
bash ~/code/Claude-to-IM-skill/scripts/install-codex.sh
```

If you installed with `--link` or cloned directly into the Codex skills directory:

```bash
cd ~/.codex/skills/claude-to-im
git pull
npm install
npm run build
```

Then tell Codex:

```text
claude-to-im doctor
start bridge
```

## Quick Start

### 1. Setup

**Claude Code**

```text
/claude-to-im setup
```

**Codex**

```text
claude-to-im setup
```

The wizard will guide you through:

1. **Choose channels** — pick Telegram, Discord, Feishu, QQ, WeChat, or any combination
2. **Enter credentials** — the wizard explains exactly where to get each token, which settings to enable, and what permissions to grant
3. **Set defaults** — working directory, model, and mode
4. **Validate** — tokens are verified against platform APIs immediately

### 2. Start

**Claude Code**

```text
/claude-to-im start
```

**Codex**

```text
start bridge
```

The daemon starts in the background. You can close the terminal — it keeps running.

### 3. Chat

Open your IM app and send a message to your bot. Your installed host agent (Claude Code, Codex, or Gemini CLI) will respond through the bridge.

Permission behavior depends on runtime:

- **Claude runtime** — tool calls trigger a permission prompt with **Allow** / **Deny** buttons in chat (Telegram/Discord), or text `/perm` commands / quick `1/2/3` replies (Feishu/QQ/WeChat)
- **Codex runtime** — when `approval_policy=on-request`, the bridge asks for a pre-turn approval in chat before starting the Codex turn

## Commands

All commands are run inside your installed host:

| Slash-command hosts | Natural-language hosts | Description |
|---|---|---|
| `/codex-to-im setup` | "codex-to-im setup" / "配置" | Interactive setup wizard |
| `/codex-to-im start` | "start bridge" / "启动桥接" | Start the bridge daemon |
| `/codex-to-im stop` | "stop bridge" / "停止桥接" | Stop the bridge daemon |
| `/codex-to-im status` | "bridge status" / "状态" | Show daemon status |
| `/codex-to-im logs` | "查看日志" | Show last 50 log lines |
| `/codex-to-im logs 200` | "logs 200" | Show last 200 log lines |
| `/codex-to-im reconfigure` | "reconfigure" / "修改配置" | Update config interactively |
| `/codex-to-im doctor` | "doctor" / "诊断" | Diagnose issues |

The bridge also supports built-in session management commands inside IM chats:

| IM command | Description |
|---|---|
| `/lsessions` | List active bridge sessions with name, short ID, channel, status, last activity, and summary |
| `/lsessions --all` | Include archived sessions in the list |
| `/switchto &lt;session_id\|name&gt;` | Switch the current chat to an existing session by ID or assigned name |
| `/rename &lt;new_name&gt;` | Rename the current session |
| `/archive [session_id\|name]` | Archive the current or specified session and keep a short summary |
| `/unarchive &lt;session_id\|name&gt;` | Restore an archived session |

## Platform Setup Guides

The `setup` wizard provides inline guidance for every step. Here's a summary:

### Telegram

1. Message `@BotFather` on Telegram → `/newbot` → follow prompts
2. Copy the bot token (format: `123456789:AABbCc...`)
3. Recommended: `/setprivacy` → Disable (for group use)
4. Find your User ID: message `@userinfobot`

### Discord

1. Go to [Discord Developer Portal](https://discord.com/developers/applications) → New Application
2. Bot tab → Reset Token → copy it
3. Enable **Message Content Intent** under Privileged Gateway Intents
4. OAuth2 → URL Generator → scope `bot` → permissions: Send Messages, Read Message History, View Channels → copy invite URL

### Feishu / Lark

1. Go to [Feishu Open Platform](https://open.feishu.cn/app) (or [Lark](https://open.larksuite.com/app))
2. Create Custom App → get App ID and App Secret
3. **Batch-add permissions**: go to "Permissions & Scopes" → use batch configuration to add all required scopes (the `setup` wizard provides the exact JSON)
4. Enable Bot feature under "Add Features"
5. **Events & Callbacks**: select **"Long Connection"** as event dispatch method → add `im.message.receive_v1` event
6. **Publish**: go to "Version Management & Release" → create version → submit for review → approve in Admin Console
7. **Important**: The bot will NOT work until the version is approved and published

### QQ

> QQ currently supports **C2C private chat only**. No group/channel support, no inline permission buttons, no streaming preview. Permissions use text `/perm ...` commands. Image inbound only (no image replies).

1. Go to [QQ Bot OpenClaw](https://q.qq.com/qqbot/openclaw)
2. Create a QQ Bot or select an existing one → get **App ID** and **App Secret** (only two required fields)
3. Configure sandbox access and scan QR code with QQ to add the bot
4. `CTI_QQ_ALLOWED_USERS` takes `user_openid` values (not QQ numbers) — can be left empty initially
5. Set `CTI_QQ_IMAGE_ENABLED=false` if the underlying provider doesn't support image input

### WeChat / Weixin

> WeChat currently uses QR login, single-account mode, text-based permissions, and no streaming preview.

1. Run the local QR helper from your installed skill directory:
   - Claude Code default install: `cd ~/.claude/skills/claude-to-im && npm run weixin:login`
   - Codex default install: `cd ~/.codex/skills/claude-to-im && npm run weixin:login`
2. The helper writes `~/.claude-to-im/runtime/weixin-login.html` and tries to open it in your browser automatically
3. Scan the QR code with WeChat and confirm on your phone
4. On success, the linked account is stored in `~/.claude-to-im/data/weixin-accounts.json`
5. Running the helper again replaces the previously linked WeChat account

Additional notes:

- `CTI_WEIXIN_MEDIA_ENABLED` controls inbound image/file/video downloads only
- Voice messages only use WeChat's own built-in speech-to-text text
- If WeChat does not provide `voice_item.text`, the bridge replies with an error instead of downloading/transcribing raw voice audio
- Permission approvals use text `/perm ...` commands or quick `1/2/3` replies


## Architecture

```
~/.<host>-to-im/
├── config.env             ← Credentials & settings (chmod 600)
├── openai.local.env       ← Optional locally included secrets (chmod 600)
├── data/                  ← Persistent JSON storage
│   ├── sessions.json
│   ├── bindings.json
│   ├── permissions.json
│   └── messages/          ← Per-session message history
├── logs/
│   └── bridge.log         ← Auto-rotated, secrets redacted
└── runtime/
    ├── bridge.pid          ← Daemon PID file
    └── status.json         ← Current status
```

### Key components

| Component | Role |
|---|---|
| `src/main.ts` | Daemon entry — assembles DI, starts bridge |
| `src/config.ts` | Load/save `config.env`, map to bridge settings |
| `src/store.ts` | JSON file BridgeStore (30 methods, write-through cache) |
| `src/llm-provider.ts` | Claude Agent SDK `query()` → SSE stream |
| `src/codex-provider.ts` | Codex SDK `runStreamed()` → SSE stream |
| `src/sse-utils.ts` | Shared SSE formatting helper |
| `src/permission-gateway.ts` | Async bridge permission resolution and IM approval handoff |
| `src/logger.ts` | Secret-redacted file logging with rotation |
| `scripts/daemon.sh` | Process management (start/stop/status/logs) |
| `scripts/doctor.sh` | Health checks |
| `SKILL.md` | Host skill definition |

### Permission flow

Claude runtime:

```
1. The agent wants to use a tool (e.g., Edit file)
2. SDK calls canUseTool() → LLMProvider emits permission_request SSE
3. Bridge sends inline buttons to IM chat: [Allow] [Deny]
4. canUseTool() blocks, waiting for user response (5 min timeout)
5. User taps Allow → bridge resolves the pending permission
6. SDK continues tool execution → result streamed back to IM
```

Codex runtime:

```
1. Bridge resolves Codex approval policy for the current turn
2. If `approval_policy=on-request`, CodexProvider emits a synthetic permission_request before execution
3. Bridge sends IM approval controls or `/perm allow|deny <id>` instructions
4. User approves → Codex turn starts
5. User denies or times out → Codex turn does not start
```

## Troubleshooting

Run diagnostics:

```
/codex-to-im doctor
```

This checks: Node.js version, config file existence and permissions, token validity (live API calls), log directory, PID file consistency, and recent errors.

| Issue | Solution |
|---|---|
| `Bridge won't start` | Run `doctor`. Check if Node >= 20. Check logs. |
| `Messages not received` | Verify token with `doctor`. Check allowed users config. |
| `Permission timeout` | User didn't respond within 5 min. Tool call auto-denied. |
| `Stale PID file` | Run `stop` then `start`. daemon.sh auto-cleans stale PIDs. |

See [references/troubleshooting.md](references/troubleshooting.md) for more details.

## Security

- All credentials stored in `~/.codex-to-im/config.env` with `chmod 600`
- `config.env` can optionally include a local secrets file such as `~/.codex-to-im/openai.local.env`; the loader now resolves that include when reading config
- Tokens are automatically redacted in all log output (pattern-based masking)
- Allowed user/channel/guild lists restrict who can interact with the bot
- The daemon is a local process with no inbound network listeners
- See [SECURITY.md](SECURITY.md) for threat model and incident response

## Development

```bash
npm install        # Install dependencies
npm run dev        # Run in dev mode
npm run typecheck  # Type check
npm test           # Run tests
npm run build      # Build bundle
```

## License

[MIT](LICENSE)
