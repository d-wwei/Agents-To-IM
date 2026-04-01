# Agents-to-IM

**5 IM Platforms. 4 AI Runtimes. One Bridge.**

[中文](README.zh-CN.md) | English

> Official agents are shipping their own IM bridges. Great — if you're on the official API. If you're running a TUI-based agent with a third-party key, or a local model through a CLI wrapper, you're out of luck. Agents-to-IM fills that gap: bridge **any** coding agent to Telegram, Discord, Feishu, QQ, or WeChat — regardless of whose API key is behind it.

---

## The Problem

More and more AI coding agents — Claude Code, Codex, Gemini CLI — are adding built-in IM integrations. But those features only work on official APIs with official accounts.

The reality for many developers:

- You're running a coding agent through a **third-party API provider** (relay, proxy, self-hosted endpoint)
- You're using a **TUI-based agent** (aider, cursor-cli, custom wrappers) that has zero IM awareness
- You're on an **official agent but with a third-party key** — the IM feature doesn't activate

These users are locked out. No official bridge, no easy workaround. Copy-pasting between terminal and IM is the "solution."

**Agents-to-IM is built for exactly this scenario.** It doesn't care whose API key you're using or how the agent talks to the LLM. It hooks into the agent at the SDK/CLI level and bridges the full session — streaming, permissions, tool calls, everything — to your IM.

## How It Works

```
You (Telegram / Discord / Feishu / QQ / WeChat)
  ↕ Bot API
Background Daemon (Node.js)
  ↕ Host SDK / CLI bridge
Your coding agent → reads & writes your codebase
```

A lightweight daemon runs on your dev machine. It connects your IM bot to whatever coding agent you have installed — official key, third-party key, local model, doesn't matter. Messages flow both ways. The agent sees a normal conversation; your IM sees a full-featured bot.

## Deep Feishu Integration — The Crown Jewel

While we support 5 IM platforms, **Feishu/Lark is where this project goes deepest.** Every Feishu-specific API capability has been exploited to build an experience that feels native, not bolted-on.

### Zero-Latency Connection

Telegram uses HTTP long polling — every message costs a round trip: client asks "anything new?", server holds 30 seconds, returns updates, client asks again. Even with long polling, there's inherent overhead per cycle.

The Feishu adapter takes a fundamentally different path: **WSClient persistent WebSocket**. A single TCP connection stays open permanently. The server pushes events the instant they happen — no polling interval, no round-trip tax.

But the WebSocket is just the transport layer. The real engineering is in what happens after the message arrives:

**Waiter-based async queue.** When the bridge loop is idle and waiting for the next message, it parks a Promise resolver in a waiter list. The moment a WebSocket event fires, the adapter calls `enqueue()` — if a waiter is parked, it resolves immediately, skipping the queue entirely. Zero buffering delay. The message goes from WebSocket frame to handler in a single microtask.

**Fire-and-forget session dispatch.** The event loop doesn't block on message processing. Each regular message gets dispatched into a per-session lock via `processWithSessionLock()` — and the loop immediately goes back to consuming the next event. Different sessions process concurrently; same-session messages serialize via Promise chaining (not mutex), so there's no lock contention across sessions.

**Unified event channel.** Chat messages (`im.message.receive_v1`) and card button callbacks (`card.action.trigger`) arrive on the **same WebSocket connection** through a shared EventDispatcher. When a user clicks "Allow" on a permission card, the callback doesn't go through a separate webhook endpoint — it lands on the same socket, gets routed to the permission broker, and unblocks the waiting LLM stream. No extra HTTP listener, no NAT traversal, no additional latency.

**Auto-reconnect.** The SDK handles connection drops transparently. The adapter doesn't need heartbeat timers or reconnect logic — WSClient re-establishes the connection and resumes event delivery automatically.

The result: from the moment you tap "send" in Feishu to the moment the bridge starts processing your message, the latency is bounded only by network RTT — not by any polling interval, queue delay, or serialization overhead.

### Streaming Output via Card Patching

Responses aren't dumped as a wall of text after the agent finishes thinking. They stream in real time.

The adapter creates an **interactive card** on the first token, then **patches it in place** as more content arrives. You see the response forming word by word, with a `⏳ Generating...` footer that disappears on completion. If the card patch fails (rate limit, API hiccup), streaming degrades gracefully — no crash, no duplicate messages.

Under the hood: 800ms throttle interval, 30-char minimum delta, max 3500-char card body. All configurable.

### Card-Based Permission Approval

When the agent wants to run a tool (edit a file, execute a command), Feishu users don't get a plain text prompt. They get an **interactive card** with real buttons:

```
┌──────────────────────────────────┐
│ 🔐 Permission Required           │
│                                  │
│ Tool: Edit src/main.ts           │
│ Action: Replace lines 42-58     │
│                                  │
│ ┌─────────┐ ┌─────────────────┐ │
│ │ Allow   │ │ Allow (session) │ │
│ └─────────┘ └─────────────────┘ │
│ ┌─────────┐                     │
│ │  Deny   │                     │
│ └─────────┘                     │
│                                  │
│ Fallback: /perm allow <id>      │
└──────────────────────────────────┘
```

Click a button → card updates in place to show your decision → agent continues or stops. No message ping-pong. If buttons fail (network, API issue), the text-based `/perm` fallback is right there on the same card.

The card header changes color after resolution: blue for handled, grey for expired.

### Voice Message Transcription

Send a voice message in Feishu → the bot transcribes it and feeds it to the agent as text.

Dual transcription engine:
1. **Primary**: Feishu's own STT API (`speech_to_text/v1`) — no extra cost, handles Chinese and English
2. **Fallback**: OpenAI Whisper — kicks in if Feishu STT fails or rate-limits

Audio pipeline handles format detection (magic bytes), WAV PCM extraction, and ffmpeg/afconvert transcoding for non-PCM formats. OGG, MP3, WAV, FLAC, M4A — all handled.

### Merge-Forward Message Parsing

Someone forwards a conversation thread to the bot? The adapter fetches all child messages via Feishu API, resolves sender names from the contact directory (with LRU cache, max 500), and assembles a readable summary:

```
--- 以下是一组合并转发的聊天记录 ---
张三: 线上数据库连接超时了
李四: 看了下监控，连接池满了
张三: [Image]
--- 合并转发结束 ---
```

Nested merge-forwards, images, files, audio — all parsed into structured context for the agent.

### Rich Text Rendering

Responses auto-detect content complexity and pick the right Feishu format:

- **Code blocks or tables** → Interactive Card (Schema 2.0) with full markdown rendering
- **Simple text** → Post message with markdown tags
- **Tool progress** → Live icons (`🔄 running` / `✅ complete` / `❌ error`) embedded in the card body
- **Final response** → Card with status footer showing elapsed time

### Two-Phase Contextual Emoji Reactions

Not random decorations. The bot reads your message and reacts with purpose.

**Phase 1 — Instant acknowledgment.** The moment your message arrives, the bot reacts based on what you said:

| You Send | Bot Reacts |
|----------|-----------|
| "你好" / "hello" | 👋 WAVE |
| "帮我" / "create" | 🫡 OnIt |
| "debug" / "分析" | 🧠 SMART |
| "urgent" / "马上" | 🔥 Fire |
| "谢谢" / "thanks" | ❤️ HEART |
| "怎么" / "why" | 🤔 THINKING |

**Phase 2 — Summary reaction.** After the response is generated, the bot swaps the reaction based on what it answered:

| Response Contains | Reaction |
|------------------|----------|
| Large code block (>50 chars) | ✅ DONE |
| "fix" / "完成" / "解决" | ☑️ CheckMark |
| Warning / caution | 🚨 Alarm |
| Structured list / numbered steps | 👏 APPLAUSE |
| Table | 🧠 SMART |

Phase 1 tells you "I'm on it." Phase 2 tells you "here's what happened." Both are non-intrusive — they're reactions on your original message, not extra bot messages cluttering the chat.

## Comparison

| Capability | Official Agent IM | Generic Chatbot Wrapper | Agents-to-IM |
|------------|:-:|:-:|:-:|
| Works with third-party API keys | 🔴 | 🟡 Sometimes | 🟢 Always |
| Works with TUI agents | 🔴 | 🔴 | 🟢 |
| Tool permission approval in IM | 🟡 Limited | 🔴 | 🟢 Full (buttons + text) |
| Streaming preview | 🟡 Varies | 🔴 | 🟢 Per-platform optimized |
| Feishu interactive cards | 🔴 | 🔴 | 🟢 Schema 2.0 |
| Contextual emoji reactions | 🔴 | 🔴 | 🟢 Two-phase |
| Voice transcription in IM | 🔴 | 🔴 | 🟢 Dual-engine |
| Session persistence | 🟡 Varies | 🔴 | 🟢 Survives restarts |
| Multi-platform simultaneous | 🔴 Single | 🔴 | 🟢 Up to 5 |

## All Supported Platforms

| Platform | Connection | Highlights |
|----------|-----------|------------|
| **Feishu/Lark** | WSClient (WebSocket) | Interactive cards, streaming preview, emoji reactions, voice transcription, card-based permissions, merge-forward parsing, group policy |
| **Telegram** | Long polling | Inline buttons, streaming preview, media attachments, HTML rendering |
| **Discord** | WebSocket Gateway | Native markdown, inline buttons, streaming preview |
| **QQ** | C2C private chat | Text commands, image inbound |
| **WeChat** | QR login | Text permissions, single-account mode |

## Quick Start

### Claude Code

```bash
# Install
npx skills add d-wwei/Agents-To-IM

# Setup (in Claude Code)
/claude-to-im setup

# Start
/claude-to-im start
```

### Codex

```bash
# Clone and install
git clone https://github.com/d-wwei/Agents-To-IM.git ~/code/Agents-to-IM
bash ~/code/Agents-to-IM/scripts/install-codex.sh

# Setup (in Codex)
claude-to-im setup

# Start
start bridge
```

### Gemini CLI

```bash
bash ~/code/Agents-to-IM/scripts/install-host.sh --host gemini
# Then in Gemini: gemini-to-im setup → start bridge
```

The setup wizard handles everything: platform selection, token collection (with step-by-step instructions), permission configuration, and live API validation.

## In-Chat Commands (Full Reference)

Once the bridge is running, these commands are available directly inside your IM chat:

### Session Management

| Command | Description |
|---------|-------------|
| `/new [path]` | Start a new session. Optional: specify a working directory path |
| `/bind <session_id>` | Bind the current chat to an existing session by ID |
| `/lsessions` | List all bridge sessions across all chats |
| `/lsessions --all` | Include archived sessions in the list |
| `/switchto <id\|name>` | Switch the current chat to a different session by ID or name |
| `/rename <new_name>` | Rename the current session |
| `/archive [id\|name]` | Archive a session and keep its summary. If omitted, archives the current session |
| `/unarchive <id\|name>` | Restore an archived session |
| `/sessions` | List recent runtime sessions for the current channel |

### Configuration

| Command | Description |
|---------|-------------|
| `/cwd <path>` | Change working directory for the current binding |
| `/mode <plan\|code\|ask>` | Change the current bridge mode |

### Status & Tasks

| Command | Description |
|---------|-------------|
| `/status` | Show the current binding status (session, cwd, mode, model) |
| `/tasks` | List recent bridge tasks (last 5) |
| `/resume_last` | Resume the latest interrupted task; falls back to the last user request in session history |

### Control

| Command | Description |
|---------|-------------|
| `/stop` | Abort the currently running task |
| `/start` | Show bridge help and available commands |
| `/help` | Show bridge command help |

### Permissions

| Command | Description |
|---------|-------------|
| `/perm allow <id>` | Allow a pending tool permission request |
| `/perm allow_session <id>` | Allow a tool for the entire session |
| `/perm deny <id>` | Deny a pending tool permission request |

On Telegram and Discord, permission requests also appear as **inline buttons**. On Feishu, they appear as **interactive card buttons**. On QQ and WeChat, use the text commands above or quick replies (`1`/`2`/`3`).

## Two Layers: Library + Skill

| Layer | For | What It Does |
|-------|-----|-------------|
| **Agent-to-IM-core** (library) | Developers embedding IM into their app | Host-agnostic bridge, 4 DI interfaces, zero framework lock-in |
| **Agent-to-IM-Skill** (skill) | Users who want it working in 3 minutes | Background daemon, interactive wizard, zero code required |

### Library Integration

```typescript
import { initBridgeContext } from 'agent-to-im-core/context';
import * as bridgeManager from 'agent-to-im-core/bridge-manager';

initBridgeContext({ store, llm, permissions, lifecycle });
await bridgeManager.start();
```

Full guide: [`Agent-to-IM-core/docs/development.md`](Agent-to-IM-core/docs/development.md)

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                    IM Platforms                       │
│  Telegram  │  Discord  │  Feishu  │  QQ  │  WeChat  │
└─────┬──────┴─────┬─────┴────┬─────┴───┬──┴────┬─────┘
      ▼            ▼          ▼         ▼       ▼
┌─────────────────────────────────────────────────────┐
│              Bridge Manager (orchestrator)            │
│  Channel Router → Conversation Engine → Delivery     │
│  Permission Broker → Rate Limiter → Markdown IR      │
└────────────────────────┬────────────────────────────┘
                         │  DI Interfaces
                         ▼
┌─────────────────────────────────────────────────────┐
│              Host Application Layer                   │
│  BridgeStore │ LLMProvider │ PermissionGW │ Hooks    │
└────────────────────────┬────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────┐
│              AI Runtime (any key, any provider)       │
│  Claude Code SDK  │  Codex SDK  │  Gemini CLI        │
└─────────────────────────────────────────────────────┘
```

## Host Commands

| Command | Description |
|---------|-------------|
| `setup` | Interactive setup wizard |
| `start` | Start bridge daemon |
| `stop` | Stop daemon |
| `status` | Check health |
| `logs [N]` | Show last N log lines |
| `doctor` | Run diagnostics |

## Security

- Credentials: `chmod 600`, never committed to git
- Logs: pattern-based secret masking on all output
- Access: user/channel/guild whitelists
- Rate limiting: 20 msg/min per chat (token bucket)
- Input: validation against path traversal and injection
- Network: local daemon only, no inbound listeners, no cloud relay
- Full threat model: [SECURITY.md](Agent-to-IM-Skill/SECURITY.md)

## Project Structure

```
Agents-to-IM/
├── Agent-to-IM-core/                # Bridge library (npm package)
│   ├── src/lib/bridge/
│   │   ├── bridge-manager.ts        # Orchestrator
│   │   ├── adapters/                # Platform adapters (Telegram, Discord, Feishu, QQ)
│   │   ├── markdown/                # IR-based rendering per platform
│   │   └── security/                # Validation & rate limiting
│   └── docs/                        # Integration guide
│
├── Agent-to-IM-Skill/               # Skill application (plug-and-play)
│   ├── src/                         # Daemon, providers, config
│   ├── scripts/                     # Install, daemon management, doctor
│   └── references/                  # Setup guides, troubleshooting
```

## Integrated Kits

| Kit | Role | Version |
|-----|------|---------|
| **udd-kit** | Auto-update check on daemon start | Latest |
| **update-kit** | Auto-update apply & version management | Latest |

## Requirements

| | Version |
|---|---------|
| Node.js | >= 20 |
| AI Agent | Claude Code / Codex / Gemini CLI (any API key) |

## Links

- [Library README](Agent-to-IM-core/README.md) — Developer integration guide
- [Skill README](Agent-to-IM-Skill/README.md) — Full command reference
- [Architecture](Agent-to-IM-core/src/lib/bridge/ARCHITECTURE.md) — Design decisions
- [Development Guide](Agent-to-IM-core/docs/development.md) — Host interfaces & SSE format
- [Troubleshooting](Agent-to-IM-Skill/references/troubleshooting.md) — Common fixes

## License

[MIT](LICENSE)
