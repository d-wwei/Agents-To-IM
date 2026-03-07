# Claude/Codex/Gemini-to-IM

Bridge AI coding hosts to IM platforms (Telegram, Discord, Feishu/Lark, QQ), with isolated installs for Claude, Codex, Gemini, and future hosts.

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

## Codex Permission Profiles

Codex variants support configurable runtime permission profiles through `~/.codex-to-im/config.env`.

Default example profile:

```bash
CTI_CODEX_SANDBOX_MODE=danger-full-access
CTI_CODEX_APPROVAL_POLICY=never
```

Optional wrapper command:

```bash
CTI_CODEX_EXECUTABLE=/Users/you/.local/bin/codex-full
```

Profiles:

- `full` -> `danger-full-access` + `never`
- `safe` -> `workspace-write` + `on-request`

This is intended for trusted environments only.

If you want a simple switch instead of hand-editing config, use the installed host variant's `scripts/permissions.sh` helper:

```bash
bash ~/.codex/skills/codex-to-im/scripts/permissions.sh show
bash ~/.codex/skills/codex-to-im/scripts/permissions.sh safe
bash ~/.codex/skills/codex-to-im/scripts/permissions.sh full
```

## Attachment Support

- Feishu/Lark inbound messages can carry images and regular file attachments into the bridge.
- Gemini already persists attachments to local temp files and passes those paths into the CLI prompt.
- Codex and Claude Code now persist all inbound attachments to local temp files and reference those absolute paths in the prompt as a universal fallback.
- Image attachments still use native multi-modal input where the target runtime supports it, so runtimes that understand images get both the native image input and the local-path fallback.
- This matters most for Claude-compatible runtimes behind custom gateways or enterprise model adapters: even if native image blocks are ignored, the agent can still open the saved local file path.

## Voice and Audio

- Feishu inbound audio messages are handled at the bridge layer, not delegated to the runtime as opaque files.
- The bridge downloads the audio, transcodes Ogg/Opus input to 16 kHz PCM when needed, and calls Feishu STT before the message reaches Codex, Claude, or Gemini.
- If Feishu STT is rate-limited or unavailable, the bridge can optionally fall back to OpenAI Whisper transcription when `CTI_OPENAI_API_KEY` is configured.
- When the user explicitly asks for a voice reply, the bridge can optionally generate an ElevenLabs TTS audio reply and send it back as a Feishu file attachment.

## Dependencies and Provider Keys

Required or recommended dependencies:

- `ffmpeg`
  Used for Feishu voice-message transcoding, especially Ogg/Opus to 16 kHz PCM.
- Feishu app permission `speech_to_text:speech`
  Required if you want bridge-side Feishu audio transcription.

Optional provider API keys:

- `CTI_OPENAI_API_KEY`
  Enables OpenAI Whisper fallback for inbound audio transcription when Feishu STT fails or is rate-limited.
- `CTI_ELEVENLABS_API_KEY`
  Enables ElevenLabs voice replies when the user explicitly asks for audio output.
- `CTI_ELEVENLABS_VOICE_ID`
  Required together with the ElevenLabs API key.
- `CTI_ELEVENLABS_MODEL_ID`
  Optional. Defaults to `eleven_multilingual_v2`.

Relevant config fields in `~/.<host>-to-im/config.env`:

```bash
CTI_FEISHU_AUDIO_TRANSCRIBE=true
CTI_AUDIO_TRANSCODER=/opt/homebrew/bin/ffmpeg
CTI_OPENAI_API_KEY=...
CTI_ELEVENLABS_API_KEY=...
CTI_ELEVENLABS_VOICE_ID=...
CTI_ELEVENLABS_MODEL_ID=eleven_multilingual_v2
```

Privacy and security guidance:

- Do not send provider API keys through IM chats. Store them only in the local `config.env`.
- The bridge writes `config.env` with mode `0600`; treat that as baseline protection, not full secret management.
- If you enable `CTI_OPENAI_API_KEY`, fallback transcription sends audio to OpenAI for processing. Only enable it if that matches your privacy requirements.
- If you enable ElevenLabs replies, outbound reply text is sent to ElevenLabs when a user explicitly requests voice output.
- For stronger local protection, prefer disk encryption such as FileVault and rotate leaked provider keys immediately.

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
