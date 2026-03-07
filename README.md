# Claude/Codex/Gemini-to-IM

Bridge AI coding hosts to IM platforms, with isolated installs for Claude, Codex, Gemini, and future hosts.

[中文文档](README_CN.md)

> **Want a desktop GUI instead?** Check out [CodePilot](https://github.com/op7418/CodePilot) — a desktop app with visual chat, session management, file tree preview, permission controls, and more. This repository contains the lightweight CLI/skill version of the IM bridge.

---

## What This Repository Provides

- A shared codebase for host-specific skill variants such as `claude-to-im`, `codex-to-im`, and `gemini-to-im`
- Separate runtime homes for each host, following the pattern `~/.<host>-to-im`
- Telegram, Discord, Feishu/Lark, and QQ bridge support
- Background daemon management, permission approval flow, streaming replies, and persisted sessions
- Consistent attachment handling across runtimes, including non-image files forwarded as local paths when native file input is unavailable

## Host Variants

| Host | Skill command | Default skill directory | Runtime home |
|---|---|---|---|
| Claude | `claude-to-im` | `~/.claude/skills/claude-to-im` | `~/.claude-to-im` |
| Codex | `codex-to-im` | `~/.codex/skills/codex-to-im` | `~/.codex-to-im` |
| Gemini | `gemini-to-im` | `~/.gemini/skills/gemini-to-im` | `~/.gemini-to-im` |

This layout lets you install multiple host variants on the same machine without sharing runtime config, logs, or daemon state.

## Installation

Clone the repository once for development:

```bash
git clone https://github.com/op7418/Claude-to-IM-skill.git ~/code/Claude-to-IM-skill
cd ~/code/Claude-to-IM-skill
```

Then install the host variant you want:

```bash
bash scripts/install-host.sh --host claude
bash scripts/install-host.sh --host codex
bash scripts/install-host.sh --host gemini
```

Each install renders host-specific docs and commands into its own skill directory.

## Documentation

- For Claude-oriented usage, see the installed `claude-to-im` skill docs
- For Codex-oriented usage, see the installed `codex-to-im` skill docs
- For Gemini-oriented usage, see the installed `gemini-to-im` skill docs
- Release notes: [RELEASE_NOTES.md](RELEASE_NOTES.md)
- Troubleshooting reference: [references/troubleshooting.md](references/troubleshooting.md)
- Security model: [SECURITY.md](SECURITY.md)

## Attachment Support

- Feishu/Lark inbound messages can carry images and regular file attachments into the bridge.
- Gemini already persists attachments to local temp files and passes those paths into the CLI prompt.
- Codex and Claude Code now follow the same fallback for non-image files: attachments are written to local temp files and referenced by absolute path in the prompt.
- Images still use native multi-modal input where the target runtime supports it.

## Built-in Session Management Commands

The bridge now includes cross-host session management commands at the bridge layer. They work the same way for Claude, Codex, and Gemini variants because they are handled before a message is forwarded to the underlying agent.

| Command | Effect |
|---|---|
| `/lsessions` | List active bridge sessions with name, short ID, channel, status, last activity, and summary |
| `/lsessions --all` | Include archived sessions in the list |
| `/switchto <session_id\|name>` | Switch the current IM chat to an existing session by ID or assigned name |
| `/rename <new_name>` | Rename the current session |
| `/archive [session_id\|name]` | Archive the current or specified session and keep a short summary |
| `/unarchive <session_id\|name>` | Restore an archived session to the active list |

Implementation notes:
- Session names, archive state, summaries, and last activity are persisted in `~/.<host>-to-im/data/session-meta.json`
- Archiving the current session automatically creates a fresh session for the current chat, so new messages do not continue writing into the archived task
- Existing bridge commands such as `/new`, `/bind`, `/status`, `/cwd`, `/mode`, `/stop`, and `/help` remain available

## Development

```bash
npm install
npm test
npm run build
```

To refresh the repository homepage after editing these repo-level templates:

```bash
node scripts/render-host-templates.mjs --repo-home --target .
```

## License

[MIT](LICENSE)
