# Release Notes

## 2026-03-08

### File Attachment Handling

- Feishu/Lark file messages are now preserved across all supported runtimes instead of stopping at the bridge layer.
- Codex now saves non-image attachments to local temp files and injects their absolute paths into the prompt.
- Claude Code now uses the same fallback: images stay multi-modal, while non-image attachments are exposed as local file paths in the prompt.
- Gemini already used local temp files for attachments; behavior is now consistent with Codex and Claude for normal files.

### User Impact

- Sending `.txt`, `.md`, `.json`, source files, and other regular documents from IM should now work with both Codex and Claude Code.
- Image attachments continue to use native image input where the runtime supports it.
