import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getHostProfile } from "./host-profile.js";

export interface Config {
  runtime: 'claude' | 'codex' | 'gemini' | 'auto';
  enabledChannels: string[];
  defaultWorkDir: string;
  defaultModel?: string;
  defaultMode: string;
  codexSkipGitRepoCheck?: boolean;
  codexExecutable?: string;
  codexSandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access';
  codexApprovalPolicy?: 'never' | 'on-request' | 'on-failure' | 'untrusted';
  geminiApiKey?: string;
  googleApiKey?: string;
  openaiApiKey?: string;
  // Telegram
  tgBotToken?: string;
  tgChatId?: string;
  tgAllowedUsers?: string[];
  // Feishu
  feishuAppId?: string;
  feishuAppSecret?: string;
  feishuDomain?: string;
  feishuAllowedUsers?: string[];
  feishuAudioTranscribe?: boolean;
  audioTranscoder?: string;
  elevenLabsApiKey?: string;
  elevenLabsVoiceId?: string;
  elevenLabsModelId?: string;
  // Discord
  discordBotToken?: string;
  discordAllowedUsers?: string[];
  discordAllowedChannels?: string[];
  discordAllowedGuilds?: string[];
  // QQ
  qqAppId?: string;
  qqAppSecret?: string;
  qqAllowedUsers?: string[];
  qqImageEnabled?: boolean;
  qqMaxImageSize?: number;
  // WeChat
  weixinBaseUrl?: string;
  weixinCdnBaseUrl?: string;
  weixinMediaEnabled?: boolean;
  // Auto-approve all tool permission requests without user confirmation
  autoApprove?: boolean;
  // Disable V2 session pooling (force V1-only mode).
  // Defaults to true on Windows where cross-process session resume is unreliable.
  disableSessionPool?: boolean;
}

export const HOST_PROFILE = getHostProfile(import.meta.url);
export const CTI_HOME = process.env.CTI_HOME || HOST_PROFILE.runtimeHomePath;
export const CONFIG_PATH = path.join(CTI_HOME, "config.env");
const LOCAL_SECRETS_INCLUDE_COMMENT =
  "# Load locally rotated secrets from a separate file so they do not need to live\n"
  + "# in the main bridge config.\n";
const LOCAL_SECRETS_INCLUDE_LINE =
  '[ -f "$HOME/.codex-to-im/openai.local.env" ] && source "$HOME/.codex-to-im/openai.local.env"';

function parseQuotedPath(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed.split(/\s+/, 1)[0];
}

function extractIncludedEnvPath(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return undefined;

  const guardMatch = trimmed.match(/^\[\s+-f\s+(.+?)\s*\]\s*&&\s*(?:source|\.)\s+(.+)$/);
  if (guardMatch) {
    const guardPath = parseQuotedPath(guardMatch[1]);
    const sourcePath = parseQuotedPath(guardMatch[2]);
    return sourcePath || guardPath;
  }

  const sourceMatch = trimmed.match(/^(?:source|\.)\s+(.+)$/);
  if (!sourceMatch) return undefined;
  return parseQuotedPath(sourceMatch[1]);
}

function loadEnvFile(filePath: string, seen = new Set<string>()): Map<string, string> {
  const entries = new Map<string, string>();
  const resolvedPath = path.resolve(expandShellVars(filePath));
  if (seen.has(resolvedPath)) return entries;
  seen.add(resolvedPath);

  let content: string;
  try {
    content = fs.readFileSync(resolvedPath, "utf-8");
  } catch {
    return entries;
  }

  const baseDir = path.dirname(resolvedPath);
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const includePath = extractIncludedEnvPath(trimmed);
    if (includePath) {
      const resolvedInclude = path.isAbsolute(includePath)
        ? expandShellVars(includePath)
        : path.resolve(baseDir, expandShellVars(includePath));
      const includedEntries = loadEnvFile(resolvedInclude, seen);
      for (const [key, value] of includedEntries) {
        entries.set(key, value);
      }
      continue;
    }
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    entries.set(key, value);
  }
  return entries;
}

/**
 * Convert MSYS/Git-Bash/Cygwin-style paths to native Windows paths.
 * /c/Users/foo  ->  C:\Users\foo
 * On non-Windows or non-matching input, returns the path unchanged.
 */
export function normalizeMsysPath(p: string): string {
  if (process.platform !== 'win32') return p;
  const m = p.match(/^\/([a-zA-Z])\/(.*)/);
  if (m) return m[1].toUpperCase() + ':' + path.sep + m[2].split('/').join(path.sep);
  return p;
}

/**
 * Expand the only supported shell-style placeholders used in config.env:
 * $HOME and $CWD (including ${HOME} / ${CWD} forms).
 */
export function expandShellVars(value: string): string {
  return value
    .replace(/\$\{HOME\}/g, os.homedir())
    .replace(/\$HOME/g, os.homedir())
    .replace(/\$\{CWD\}/g, normalizeMsysPath(process.cwd()))
    .replace(/\$CWD/g, normalizeMsysPath(process.cwd()));
}

function splitCsv(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function loadConfig(): Config {
  const env = loadEnvFile(CONFIG_PATH);

  const hostDefaultRuntime =
    HOST_PROFILE.host === "codex" ? "codex"
      : HOST_PROFILE.host === "gemini" ? "gemini"
        : "claude";
  const rawRuntime = env.get("CTI_RUNTIME") || hostDefaultRuntime;
  const runtime = (["claude", "codex", "gemini", "auto"].includes(rawRuntime) ? rawRuntime : hostDefaultRuntime) as Config["runtime"];

  return {
    runtime,
    enabledChannels: splitCsv(env.get("CTI_ENABLED_CHANNELS")) ?? [],
    defaultWorkDir: normalizeMsysPath(expandShellVars(env.get("CTI_DEFAULT_WORKDIR") || process.cwd())),
    defaultModel: env.get("CTI_DEFAULT_MODEL") || undefined,
    defaultMode: env.get("CTI_DEFAULT_MODE") || "code",
    codexSkipGitRepoCheck: env.get("CTI_CODEX_SKIP_GIT_REPO_CHECK") !== "false",
    codexExecutable: env.get("CTI_CODEX_EXECUTABLE") || undefined,
    codexSandboxMode: env.get("CTI_CODEX_SANDBOX_MODE") as Config["codexSandboxMode"] || undefined,
    codexApprovalPolicy: env.get("CTI_CODEX_APPROVAL_POLICY") as Config["codexApprovalPolicy"] || undefined,
    geminiApiKey: env.get("CTI_GEMINI_API_KEY") || undefined,
    googleApiKey: env.get("CTI_GOOGLE_API_KEY") || undefined,
    openaiApiKey: env.get("CTI_OPENAI_API_KEY") || undefined,
    tgBotToken: env.get("CTI_TG_BOT_TOKEN") || undefined,
    tgChatId: env.get("CTI_TG_CHAT_ID") || undefined,
    tgAllowedUsers: splitCsv(env.get("CTI_TG_ALLOWED_USERS")),
    feishuAppId: env.get("CTI_FEISHU_APP_ID") || undefined,
    feishuAppSecret: env.get("CTI_FEISHU_APP_SECRET") || undefined,
    feishuDomain: env.get("CTI_FEISHU_DOMAIN") || undefined,
    feishuAllowedUsers: splitCsv(env.get("CTI_FEISHU_ALLOWED_USERS")),
    feishuAudioTranscribe: env.get("CTI_FEISHU_AUDIO_TRANSCRIBE") !== "false",
    audioTranscoder: env.get("CTI_AUDIO_TRANSCODER") || undefined,
    elevenLabsApiKey: env.get("CTI_ELEVENLABS_API_KEY") || undefined,
    elevenLabsVoiceId: env.get("CTI_ELEVENLABS_VOICE_ID") || undefined,
    elevenLabsModelId: env.get("CTI_ELEVENLABS_MODEL_ID") || undefined,
    discordBotToken: env.get("CTI_DISCORD_BOT_TOKEN") || undefined,
    discordAllowedUsers: splitCsv(env.get("CTI_DISCORD_ALLOWED_USERS")),
    discordAllowedChannels: splitCsv(
      env.get("CTI_DISCORD_ALLOWED_CHANNELS")
    ),
    discordAllowedGuilds: splitCsv(env.get("CTI_DISCORD_ALLOWED_GUILDS")),
    qqAppId: env.get("CTI_QQ_APP_ID") || undefined,
    qqAppSecret: env.get("CTI_QQ_APP_SECRET") || undefined,
    qqAllowedUsers: splitCsv(env.get("CTI_QQ_ALLOWED_USERS")),
    qqImageEnabled: env.has("CTI_QQ_IMAGE_ENABLED")
      ? env.get("CTI_QQ_IMAGE_ENABLED") === "true"
      : undefined,
    qqMaxImageSize: env.get("CTI_QQ_MAX_IMAGE_SIZE")
      ? Number(env.get("CTI_QQ_MAX_IMAGE_SIZE"))
      : undefined,
    weixinBaseUrl: env.get("CTI_WEIXIN_BASE_URL") || undefined,
    weixinCdnBaseUrl: env.get("CTI_WEIXIN_CDN_BASE_URL") || undefined,
    weixinMediaEnabled: env.has("CTI_WEIXIN_MEDIA_ENABLED")
      ? env.get("CTI_WEIXIN_MEDIA_ENABLED") === "true"
      : undefined,
    autoApprove: env.get("CTI_AUTO_APPROVE") === "true",
    disableSessionPool: env.has("CTI_DISABLE_SESSION_POOL")
      ? env.get("CTI_DISABLE_SESSION_POOL") === "true"
      : process.platform === 'win32',  // default: disabled on Windows
  };
}

function formatEnvLine(key: string, value: string | undefined): string {
  if (value === undefined || value === "") return "";
  return `${key}=${value}\n`;
}

export function saveConfig(config: Config): void {
  let out = "";
  out += formatEnvLine("CTI_RUNTIME", config.runtime);
  out += formatEnvLine(
    "CTI_ENABLED_CHANNELS",
    config.enabledChannels.join(",")
  );
  out += formatEnvLine("CTI_DEFAULT_WORKDIR", config.defaultWorkDir);
  if (config.defaultModel) out += formatEnvLine("CTI_DEFAULT_MODEL", config.defaultModel);
  out += formatEnvLine("CTI_DEFAULT_MODE", config.defaultMode);
  out += formatEnvLine(
    "CTI_CODEX_SKIP_GIT_REPO_CHECK",
    config.codexSkipGitRepoCheck === false ? "false" : "true"
  );
  out += formatEnvLine("CTI_CODEX_EXECUTABLE", config.codexExecutable);
  out += formatEnvLine("CTI_CODEX_SANDBOX_MODE", config.codexSandboxMode);
  out += formatEnvLine("CTI_CODEX_APPROVAL_POLICY", config.codexApprovalPolicy);
  out += formatEnvLine("CTI_GEMINI_API_KEY", config.geminiApiKey);
  out += formatEnvLine("CTI_GOOGLE_API_KEY", config.googleApiKey);
  out += formatEnvLine("CTI_OPENAI_API_KEY", config.openaiApiKey);
  out += formatEnvLine("CTI_TG_BOT_TOKEN", config.tgBotToken);
  out += formatEnvLine("CTI_TG_CHAT_ID", config.tgChatId);
  out += formatEnvLine(
    "CTI_TG_ALLOWED_USERS",
    config.tgAllowedUsers?.join(",")
  );
  out += formatEnvLine("CTI_FEISHU_APP_ID", config.feishuAppId);
  out += formatEnvLine("CTI_FEISHU_APP_SECRET", config.feishuAppSecret);
  out += formatEnvLine("CTI_FEISHU_DOMAIN", config.feishuDomain);
  out += formatEnvLine(
    "CTI_FEISHU_ALLOWED_USERS",
    config.feishuAllowedUsers?.join(",")
  );
  out += formatEnvLine(
    "CTI_FEISHU_AUDIO_TRANSCRIBE",
    config.feishuAudioTranscribe === false ? "false" : "true"
  );
  out += formatEnvLine("CTI_AUDIO_TRANSCODER", config.audioTranscoder);
  out += formatEnvLine("CTI_ELEVENLABS_API_KEY", config.elevenLabsApiKey);
  out += formatEnvLine("CTI_ELEVENLABS_VOICE_ID", config.elevenLabsVoiceId);
  out += formatEnvLine("CTI_ELEVENLABS_MODEL_ID", config.elevenLabsModelId);
  out += formatEnvLine("CTI_DISCORD_BOT_TOKEN", config.discordBotToken);
  out += formatEnvLine(
    "CTI_DISCORD_ALLOWED_USERS",
    config.discordAllowedUsers?.join(",")
  );
  out += formatEnvLine(
    "CTI_DISCORD_ALLOWED_CHANNELS",
    config.discordAllowedChannels?.join(",")
  );
  out += formatEnvLine(
    "CTI_DISCORD_ALLOWED_GUILDS",
    config.discordAllowedGuilds?.join(",")
  );
  out += formatEnvLine("CTI_QQ_APP_ID", config.qqAppId);
  out += formatEnvLine("CTI_QQ_APP_SECRET", config.qqAppSecret);
  out += formatEnvLine(
    "CTI_QQ_ALLOWED_USERS",
    config.qqAllowedUsers?.join(",")
  );
  if (config.qqImageEnabled !== undefined)
    out += formatEnvLine("CTI_QQ_IMAGE_ENABLED", String(config.qqImageEnabled));
  if (config.qqMaxImageSize !== undefined)
    out += formatEnvLine("CTI_QQ_MAX_IMAGE_SIZE", String(config.qqMaxImageSize));
  out += formatEnvLine("CTI_WEIXIN_BASE_URL", config.weixinBaseUrl);
  out += formatEnvLine("CTI_WEIXIN_CDN_BASE_URL", config.weixinCdnBaseUrl);
  if (config.weixinMediaEnabled !== undefined)
    out += formatEnvLine("CTI_WEIXIN_MEDIA_ENABLED", String(config.weixinMediaEnabled));
  out += "\n";
  out += LOCAL_SECRETS_INCLUDE_COMMENT;
  out += `${LOCAL_SECRETS_INCLUDE_LINE}\n`;

  fs.mkdirSync(CTI_HOME, { recursive: true });
  const tmpPath = CONFIG_PATH + ".tmp";
  fs.writeFileSync(tmpPath, out, { mode: 0o600 });
  fs.renameSync(tmpPath, CONFIG_PATH);
}

export function maskSecret(value: string): string {
  if (value.length <= 4) return "****";
  return "*".repeat(value.length - 4) + value.slice(-4);
}

export function configToSettings(config: Config): Map<string, string> {
  const m = new Map<string, string>();
  m.set("remote_bridge_enabled", "true");

  // ── Telegram ──
  // Upstream keys: telegram_bot_token, bridge_telegram_enabled,
  //   telegram_bridge_allowed_users, telegram_chat_id
  m.set(
    "bridge_telegram_enabled",
    config.enabledChannels.includes("telegram") ? "true" : "false"
  );
  if (config.tgBotToken) m.set("telegram_bot_token", config.tgBotToken);
  if (config.tgAllowedUsers)
    m.set("telegram_bridge_allowed_users", config.tgAllowedUsers.join(","));
  if (config.tgChatId) m.set("telegram_chat_id", config.tgChatId);

  // ── Discord ──
  // Upstream keys: bridge_discord_bot_token, bridge_discord_enabled,
  //   bridge_discord_allowed_users, bridge_discord_allowed_channels,
  //   bridge_discord_allowed_guilds
  m.set(
    "bridge_discord_enabled",
    config.enabledChannels.includes("discord") ? "true" : "false"
  );
  if (config.discordBotToken)
    m.set("bridge_discord_bot_token", config.discordBotToken);
  if (config.discordAllowedUsers)
    m.set("bridge_discord_allowed_users", config.discordAllowedUsers.join(","));
  if (config.discordAllowedChannels)
    m.set(
      "bridge_discord_allowed_channels",
      config.discordAllowedChannels.join(",")
    );
  if (config.discordAllowedGuilds)
    m.set(
      "bridge_discord_allowed_guilds",
      config.discordAllowedGuilds.join(",")
    );

  // ── Feishu ──
  // Upstream keys: bridge_feishu_app_id, bridge_feishu_app_secret,
  //   bridge_feishu_domain, bridge_feishu_enabled, bridge_feishu_allowed_users
  m.set(
    "bridge_feishu_enabled",
    config.enabledChannels.includes("feishu") ? "true" : "false"
  );
  if (config.feishuAppId) m.set("bridge_feishu_app_id", config.feishuAppId);
  if (config.feishuAppSecret)
    m.set("bridge_feishu_app_secret", config.feishuAppSecret);
  if (config.feishuDomain) m.set("bridge_feishu_domain", config.feishuDomain);
  if (config.feishuAllowedUsers)
    m.set("bridge_feishu_allowed_users", config.feishuAllowedUsers.join(","));
  m.set(
    "bridge_feishu_audio_transcribe",
    config.feishuAudioTranscribe === false ? "false" : "true"
  );
  if (config.audioTranscoder) {
    m.set("bridge_audio_transcoder", config.audioTranscoder);
  }
  if (config.elevenLabsApiKey) {
    m.set("bridge_elevenlabs_api_key", config.elevenLabsApiKey);
  }
  if (config.elevenLabsVoiceId) {
    m.set("bridge_elevenlabs_voice_id", config.elevenLabsVoiceId);
  }
  if (config.elevenLabsModelId) {
    m.set("bridge_elevenlabs_model_id", config.elevenLabsModelId);
  }
  if (config.openaiApiKey) {
    m.set("bridge_openai_api_key", config.openaiApiKey);
  }

  // ── QQ ──
  // Upstream keys: bridge_qq_enabled, bridge_qq_app_id, bridge_qq_app_secret,
  //   bridge_qq_allowed_users, bridge_qq_image_enabled, bridge_qq_max_image_size
  m.set(
    "bridge_qq_enabled",
    config.enabledChannels.includes("qq") ? "true" : "false"
  );
  if (config.qqAppId) m.set("bridge_qq_app_id", config.qqAppId);
  if (config.qqAppSecret) m.set("bridge_qq_app_secret", config.qqAppSecret);
  if (config.qqAllowedUsers)
    m.set("bridge_qq_allowed_users", config.qqAllowedUsers.join(","));
  if (config.qqImageEnabled !== undefined)
    m.set("bridge_qq_image_enabled", String(config.qqImageEnabled));
  if (config.qqMaxImageSize !== undefined)
    m.set("bridge_qq_max_image_size", String(config.qqMaxImageSize));

  // ── WeChat ──
  // Upstream keys: bridge_weixin_enabled, bridge_weixin_media_enabled,
  //   bridge_weixin_base_url, bridge_weixin_cdn_base_url
  m.set(
    "bridge_weixin_enabled",
    config.enabledChannels.includes("weixin") ? "true" : "false"
  );
  if (config.weixinMediaEnabled !== undefined)
    m.set("bridge_weixin_media_enabled", String(config.weixinMediaEnabled));
  if (config.weixinBaseUrl)
    m.set("bridge_weixin_base_url", config.weixinBaseUrl);
  if (config.weixinCdnBaseUrl)
    m.set("bridge_weixin_cdn_base_url", config.weixinCdnBaseUrl);

  // ── Defaults ──
  // Upstream keys: bridge_default_work_dir, bridge_default_model, default_model
  m.set("bridge_default_work_dir", config.defaultWorkDir);
  if (config.defaultModel) {
    m.set("bridge_default_model", config.defaultModel);
    m.set("default_model", config.defaultModel);
  }
  m.set("bridge_default_mode", config.defaultMode);

  return m;
}
