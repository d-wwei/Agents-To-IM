import { CONFIG_PATH } from "./config.js";
import { getBridgeContext } from "./bridge-runtime.js";

const ELEVENLABS_BASE_URL = "https://api.elevenlabs.io";
const ELEVENLABS_DEFAULT_MODEL = "eleven_multilingual_v2";
const ELEVENLABS_TIMEOUT_MS = 60_000;
const ELEVENLABS_MAX_TEXT_CHARS = 3500;

export interface GeneratedVoiceReply {
  fileName: string;
  mimeType: string;
  data: Buffer;
}

type VoiceReplyPreparationResult =
  | { status: "skipped" }
  | { status: "needs_config"; noteText: string }
  | { status: "ready"; attachment: GeneratedVoiceReply }
  | { status: "error"; noteText: string };

export function wantsVoiceReply(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;

  const patterns = [
    /语音回复/,
    /语音回答/,
    /用语音/,
    /用声音/,
    /朗读(一下|给我|回复|回答)?/,
    /\bvoice reply\b/i,
    /\baudio reply\b/i,
    /\breply in voice\b/i,
    /\brespond with audio\b/i,
    /\brespond in voice\b/i,
    /\bread this out loud\b/i,
  ];
  return patterns.some((pattern) => pattern.test(text));
}

export function buildVoiceReplySetupGuide(): string {
  return [
    "你这次明确要求了语音回复，但 ElevenLabs 还没配置完整。",
    "",
    "请在本机桥接配置里填写这些字段：",
    `- \`CTI_ELEVENLABS_API_KEY\``,
    `- \`CTI_ELEVENLABS_VOICE_ID\``,
    "- 可选：`CTI_ELEVENLABS_MODEL_ID`，默认 `eleven_multilingual_v2`",
    "",
    `配置文件位置：\`${CONFIG_PATH}\``,
    "",
    "隐私与安全建议：",
    "- 不要把 API key 直接发到聊天里",
    "- 只在本机 `config.env` 中保存，bridge 已按 600 权限写入该文件",
    "- 建议同时开启 FileVault，避免设备丢失时泄露密钥",
    "- 如果怀疑密钥泄露，立刻去 ElevenLabs 后台轮换",
  ].join("\n");
}

export async function prepareVoiceReply(responseText: string): Promise<VoiceReplyPreparationResult> {
  const store = getBridgeContext().store;
  const apiKey = (store.getSetting("bridge_elevenlabs_api_key") || "").trim();
  const voiceId = (store.getSetting("bridge_elevenlabs_voice_id") || "").trim();
  const modelId = (store.getSetting("bridge_elevenlabs_model_id") || "").trim() || ELEVENLABS_DEFAULT_MODEL;

  if (!apiKey || !voiceId) {
    return {
      status: "needs_config",
      noteText: buildVoiceReplySetupGuide(),
    };
  }

  const text = responseText.trim();
  if (!text) {
    return { status: "skipped" };
  }

  const clippedText = text.length > ELEVENLABS_MAX_TEXT_CHARS
    ? `${text.slice(0, ELEVENLABS_MAX_TEXT_CHARS)}...`
    : text;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ELEVENLABS_TIMEOUT_MS);
    try {
      const response = await fetch(`${ELEVENLABS_BASE_URL}/v1/text-to-speech/${encodeURIComponent(voiceId)}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
          "xi-api-key": apiKey,
        },
        body: JSON.stringify({
          text: clippedText,
          model_id: modelId,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        return {
          status: "error",
          noteText: buildVoiceReplyErrorMessage(response.status, detail),
        };
      }

      const audio = Buffer.from(await response.arrayBuffer());
      if (audio.length === 0) {
        return {
          status: "error",
          noteText: "语音回复生成失败：ElevenLabs 返回了空音频数据。",
        };
      }

      return {
        status: "ready",
        attachment: {
          fileName: "voice-reply.mp3",
          mimeType: "audio/mpeg",
          data: audio,
        },
      };
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: "error",
      noteText: `语音回复生成失败：${message}`,
    };
  }
}

function buildVoiceReplyErrorMessage(status: number, detail: string): string {
  const lower = detail.toLowerCase();
  if (status === 401 || status === 403) {
    return [
      "语音回复生成失败：ElevenLabs API key 无效或没有权限。",
      "",
      "请检查本机配置：",
      `- \`CTI_ELEVENLABS_API_KEY\``,
      `- \`CTI_ELEVENLABS_VOICE_ID\``,
      "",
      "不要把密钥直接发到聊天里；只在本机 config.env 中更新。",
    ].join("\n");
  }
  if (status === 429 || lower.includes("rate limit")) {
    return "语音回复生成失败：ElevenLabs 当前限频，请稍后再试。";
  }
  return `语音回复生成失败：ElevenLabs 接口返回 ${status}。`;
}
