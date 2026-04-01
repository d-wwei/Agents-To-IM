# 发布说明

## 2026-03-11

### 本地配置 include

- `config.env` 现在真正支持本地 env include 写法，例如 `[ -f "$HOME/.codex-to-im/openai.local.env" ] && source "$HOME/.codex-to-im/openai.local.env"`。
- bridge 的配置加载器现在会递归解析被 include 的 env 文件，而不再只读取主配置中的 `KEY=VALUE` 行。
- 保存配置时也会保留本地 secrets include 片段，避免后续重新配置时悄悄破坏 OpenAI Whisper fallback 或 ElevenLabs 语音回复配置。

### 对用户的影响

- 现在可以把 OpenAI Whisper fallback 和 ElevenLabs 语音回复的密钥继续放在本地 secrets 文件里，而不用再把 API key 拷回主 `config.env`。
- 之前依赖文档里 include 写法的现有配置，在重启 bridge 后会按文档预期正常工作。

## 2026-03-08

### 文件附件处理

- 飞书 / Lark 的文件消息现在可以在所有已支持 runtime 中继续保留下去，不会再停在桥接层。
- Codex 现在会把非图片附件落地为本地临时文件，并把绝对路径注入到 prompt。
- Claude Code 现在也采用同样的回退方案：图片继续走多模态输入，非图片附件则以本地文件路径形式注入 prompt。
- Gemini 原本就会把附件写到本地临时目录；现在和 Codex、Claude 在普通文件上的行为保持一致。

### 对用户的影响

- 现在从 IM 发送 `.txt`、`.md`、`.json`、源码文件及其它普通文档给 Codex 或 Claude Code，应该都能正常使用。
- 图片附件仍会在对应 runtime 支持的情况下继续使用原生图片输入。
