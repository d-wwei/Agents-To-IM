# Release Notes

## 2026-03-11

### Local Config Includes

- `config.env` now supports local env includes such as `[ -f "$HOME/.codex-to-im/openai.local.env" ] && source "$HOME/.codex-to-im/openai.local.env"`.
- The bridge loader now resolves included env files recursively instead of only reading plain `KEY=VALUE` lines from the main config.
- Saving config now preserves the local secrets include stanza, so later reconfiguration does not silently break OpenAI Whisper fallback or ElevenLabs voice reply setup.

### User Impact

- OpenAI Whisper fallback and ElevenLabs voice reply can now be stored in a local secrets file without copying API keys back into the main `config.env`.
- Existing setups that relied on the documented include pattern will now behave as documented after restarting the bridge.

## 2026-03-08

### File Attachment Handling

- Feishu/Lark file messages are now preserved across all supported runtimes instead of stopping at the bridge layer.
- Codex now saves non-image attachments to local temp files and injects their absolute paths into the prompt.
- Claude Code now uses the same fallback: images stay multi-modal, while non-image attachments are exposed as local file paths in the prompt.
- Gemini already used local temp files for attachments; behavior is now consistent with Codex and Claude for normal files.

### User Impact

- Sending `.txt`, `.md`, `.json`, source files, and other regular documents from IM should now work with both Codex and Claude Code.
- Image attachments continue to use native image input where the runtime supports it.
