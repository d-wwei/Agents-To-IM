/**
 * LLM Provider using @anthropic-ai/claude-agent-sdk query() function.
 *
 * Converts SDK stream events into the SSE format expected by
 * the agent-to-im bridge conversation engine.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execSync, execFileSync } from 'node:child_process';
import { query, unstable_v2_resumeSession } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage, SDKSession, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { LLMProvider, StreamChatParams, FileAttachment } from 'agent-to-im-core/src/lib/bridge/host.js';
import type { PendingPermissions } from './permission-gateway.js';

import { sseEvent } from './sse-utils.js';
import { normalizeMsysPath } from './config.js';

const nodeRequire = createRequire(import.meta.url);
// ── Environment isolation ──

/** Env vars always passed through to the CLI subprocess. */
const ENV_WHITELIST = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL',
  'LANG', 'LC_ALL', 'LC_CTYPE',
  'TMPDIR', 'TEMP', 'TMP',
  'TERM', 'COLORTERM',
  'NODE_PATH', 'NODE_EXTRA_CA_CERTS',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
  'SSH_AUTH_SOCK',
  'GOOGLE_API_KEY', 'GEMINI_API_KEY',
]);

/** Prefixes that are always stripped (even in inherit mode). */
const ENV_ALWAYS_STRIP = ['CLAUDECODE'];

// ── Auth/credential-error detection ──

/** Patterns indicating the local CLI is not logged in (fixable via `claude auth login`). */
const CLI_AUTH_PATTERNS = [
  /not logged in/i,
  /please run \/login/i,
  /loggedIn['":\s]*false/i,
];

/**
 * Patterns indicating an API-level credential failure (wrong key, expired token, org restriction).
 * Must be specific to API/auth context — avoid matching local file permissions, tool denials,
 * or generic HTTP 403s that may have non-auth causes.
 */
const API_AUTH_PATTERNS = [
  /unauthorized/i,
  /invalid.*api.?key/i,
  /authentication.*failed/i,
  /does not have access/i,
  /401\b/,
];

export type AuthErrorKind = 'cli' | 'api' | false;

/**
 * Classify an error message as a CLI login issue, an API credential issue, or neither.
 * Returns 'cli' for local auth problems, 'api' for remote credential problems, false otherwise.
 */
export function classifyAuthError(text: string): AuthErrorKind {
  if (CLI_AUTH_PATTERNS.some(re => re.test(text))) return 'cli';
  if (API_AUTH_PATTERNS.some(re => re.test(text))) return 'api';
  return false;
}

/** Backwards-compatible: returns true for any auth/credential error. */
export function isAuthError(text: string): boolean {
  return classifyAuthError(text) !== false;
}

const CLI_AUTH_USER_MESSAGE =
  'Claude CLI is not logged in. Run `claude auth login`, then restart the bridge.';

const API_AUTH_USER_MESSAGE =
  'API credential error. Check your ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN in config.env, ' +
  'or verify your organization has access to the requested model.';

// ── Cross-runtime model guard ──

const NON_CLAUDE_MODEL_RE = /^(gpt-|o[1-9][-_]|codex[-_]|davinci|text-|openai\/)/i;

/** Return true if a model name clearly belongs to a non-Claude provider. */
export function isNonClaudeModel(model?: string): boolean {
  return !!model && NON_CLAUDE_MODEL_RE.test(model);
}

/**
 * Build a clean env for the CLI subprocess.
 *
 * CTI_ENV_ISOLATION (default "inherit"):
 *   "inherit" — full parent env minus CLAUDECODE/GEMINI (recommended; daemon
 *               already runs in a clean launchd/setsid environment)
 *   "strict"  — only whitelist + CTI_* + provider auth vars from config.env
 */
export function buildSubprocessEnv(): Record<string, string> {
  const mode = process.env.CTI_ENV_ISOLATION || 'inherit';
  const out: Record<string, string> = {};

  if (mode === 'inherit') {
    // Pass everything except always-stripped vars
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined) continue;
      if (ENV_ALWAYS_STRIP.some(s => k.startsWith(s))) continue;
      out[k] = v;
    }
  } else {
    // Strict: whitelist only
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined) continue;
      if (ENV_WHITELIST.has(k)) { out[k] = v; continue; }
      // Pass through CTI_* so skill config is available
      if (k.startsWith('CTI_')) { out[k] = v; continue; }
    }
    // ANTHROPIC_* / GOOGLE_* should come from config.env, not parent process.
    // Only pass them if the corresponding passthrough flag is explicitly set.
    if (process.env.CTI_ANTHROPIC_PASSTHROUGH === 'true') {
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined && k.startsWith('ANTHROPIC_')) out[k] = v;
      }
    }
    if (process.env.CTI_GOOGLE_PASSTHROUGH === 'true') {
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined && k.startsWith('GOOGLE_')) out[k] = v;
      }
    }
    if (process.env.CTI_GEMINI_API_KEY) out.GEMINI_API_KEY = process.env.CTI_GEMINI_API_KEY;
    if (process.env.CTI_GOOGLE_API_KEY) out.GOOGLE_API_KEY = process.env.CTI_GOOGLE_API_KEY;

    // In codex/gemini/auto mode, pass through relevant env vars
    const runtime = process.env.CTI_RUNTIME || 'claude';
    if (runtime === 'codex' || runtime === 'gemini' || runtime === 'auto') {
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined && (k.startsWith('OPENAI_') || k.startsWith('CODEX_') || k.startsWith('GOOGLE_') || k.startsWith('GEMINI_'))) out[k] = v;
      }
    }
  }

  return out;
}

// ── Claude CLI preflight check ──
// ── Claude CLI preflight check ──

/** Minimum major version of Claude CLI required by the SDK. */
const MIN_CLI_MAJOR = 2;

/**
 * Parse a version string like "2.3.1" or "claude 2.3.1" into a major number.
 * Returns undefined if parsing fails.
 */
export function parseCliMajorVersion(versionOutput: string): number | undefined {
  const m = versionOutput.match(/(\d+)\.\d+/);
  return m ? parseInt(m[1], 10) : undefined;
}

/**
 * Run `claude --version` at a given path and return the version string.
 * Returns undefined on failure.
 */
function getCliVersion(cliPath: string, env?: Record<string, string>): string | undefined {
  try {
    // On Windows, .js/.mjs files can't be executed directly via shell — prepend node.
    const cmd = (process.platform === 'win32' && /\.(js|mjs)$/i.test(cliPath))
      ? `"${process.execPath}" "${cliPath}" --version`
      : `"${cliPath}" --version`;
    return execSync(cmd, {
      encoding: 'utf-8',
      timeout: 10_000,
      env: env || buildSubprocessEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return undefined;
  }
}

/**
 * Flags that the SDK passes to the CLI subprocess.
 * If `claude --help` doesn't mention these, the CLI build is incompatible.
 */
const REQUIRED_CLI_FLAGS = ['output-format', 'input-format', 'permission-mode', 'setting-sources'];

/**
 * Check `claude --help` for required flags.
 * Returns the list of missing flags (empty = all present).
 */
function checkRequiredFlags(cliPath: string, env?: Record<string, string>): string[] {
  let helpText: string;
  try {
    const cmd = (process.platform === 'win32' && /\.(js|mjs)$/i.test(cliPath))
      ? `"${process.execPath}" "${cliPath}" --help`
      : `"${cliPath}" --help`;
    helpText = execSync(cmd, {
      encoding: 'utf-8',
      timeout: 10_000,
      env: env || buildSubprocessEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    // Can't run --help; don't block on this — version check is primary
    return [];
  }
  return REQUIRED_CLI_FLAGS.filter(flag => !helpText.includes(flag));
}

/**
 * Check if a CLI path points to a compatible (>= 2.x) Claude CLI
 * with the required flags for SDK integration.
 * Returns { compatible, version, ... } or undefined if the CLI cannot run at all.
 */
export function checkCliCompatibility(cliPath: string, env?: Record<string, string>): {
  compatible: boolean;
  version: string;
  major: number | undefined;
  missingFlags?: string[];
} | undefined {
  const version = getCliVersion(cliPath, env);
  if (!version) return undefined;
  const major = parseCliMajorVersion(version);
  if (major === undefined || major < MIN_CLI_MAJOR) {
    return { compatible: false, version, major };
  }
  // Version OK — verify required flags exist
  const missing = checkRequiredFlags(cliPath, env);
  return {
    compatible: missing.length === 0,
    version,
    major,
    missingFlags: missing.length > 0 ? missing : undefined,
  };
}

/**
 * Run a lightweight preflight check to verify the claude CLI can start
 * and supports the flags required by the SDK.
 * Returns { ok, version?, error? }.
 */
export function preflightCheck(cliPath: string): { ok: boolean; version?: string; error?: string } {
  const cleanEnv = buildSubprocessEnv();
  const compat = checkCliCompatibility(cliPath, cleanEnv);
  if (!compat) {
    return { ok: false, error: `claude CLI at "${cliPath}" failed to execute` };
  }
  if (compat.major !== undefined && compat.major < MIN_CLI_MAJOR) {
    return {
      ok: false,
      version: compat.version,
      error: `claude CLI version ${compat.version} is too old (need >= ${MIN_CLI_MAJOR}.x). ` +
        `This is likely an npm-installed 1.x CLI. Install the native CLI: https://docs.anthropic.com/en/docs/claude-code`,
    };
  }
  if (compat.missingFlags) {
    return {
      ok: false,
      version: compat.version,
      error: `claude CLI ${compat.version} is missing required flags: ${compat.missingFlags.join(', ')}. ` +
        `Update the CLI: npm update -g @anthropic-ai/claude-code`,
    };
  }
  return { ok: true, version: compat.version };
}

// ── CLI path resolution ──

function isExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    // On Windows, .cmd/.bat/.js shims may not have X_OK. Fall back to existence check
    // for common Windows script extensions used by npm global installs.
    if (process.platform === 'win32' && /\.(cmd|bat|ps1|js|mjs)$/i.test(p)) {
      try { fs.accessSync(p, fs.constants.R_OK); return true; } catch { return false; }
    }
    return false;
  }
}

/**
 * Resolve all `claude` executables found in PATH (Unix only).
 * Returns an array of absolute paths.
 */
function findAllInPath(): string[] {
  if (process.platform === 'win32') {
    try {
      return execSync('where claude', { encoding: 'utf-8', timeout: 3000 })
        .trim().split('\n').map(s => s.trim()).filter(Boolean);
    } catch { return []; }
  }
  try {
    // `which -a` lists all matches, not just the first
    return execSync('which -a claude', { encoding: 'utf-8', timeout: 3000 })
      .trim().split('\n').map(s => s.trim()).filter(Boolean);
  } catch { return []; }
}

/**
 * Return the path to the SDK's bundled cli.js, which can always be run via `node`.
 * Used as a fallback when the native binary cannot be spawned.
 */
function sdkCliFallback(): string | undefined {
  try {
    const sdkMain = nodeRequire.resolve('@anthropic-ai/claude-agent-sdk');
    const candidate = path.join(path.dirname(sdkMain), 'cli.js');
    if (isExecutable(candidate)) return candidate;
  } catch {
    // SDK not resolvable
  }
  return undefined;
}

/**
 * Verify that a native binary can actually be spawned in the current process context.
 * X_OK alone is insufficient in some launchd-style environments.
 */
function canSpawn(binaryPath: string): boolean {
  try {
    if (process.platform === 'win32' && /\.(js|mjs)$/i.test(binaryPath)) {
      // .js/.mjs files need node to execute them
      execFileSync(process.execPath, [binaryPath, '--version'], { timeout: 3000, stdio: 'ignore' });
    } else if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(binaryPath)) {
      // .cmd/.bat files cannot be spawned directly by execFileSync;
      // they require a shell. Use execSync with quoted path instead.
      execSync(`"${binaryPath}" --version`, { timeout: 3000, stdio: 'ignore' });
    } else {
      execFileSync(binaryPath, ['--version'], { timeout: 3000, stdio: 'ignore' });
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the path to the `claude` CLI executable.
 *
 * Priority:
 *   1. CTI_CLAUDE_CODE_EXECUTABLE env var (explicit override)
 *   2. All `claude` executables in PATH — pick first compatible (>= 2.x)
 *   3. Common install locations — pick first compatible (>= 2.x)
 *
 * This multi-candidate approach handles the common scenario where
 * nvm/npm puts an old 1.x claude in PATH before the native 2.x CLI.
 * For auto-detected native binaries, validates that spawn actually works and falls
 * back to the SDK's bundled cli.js if needed.
 */
export function resolveClaudeCliPath(): string | undefined {
  // 1. Explicit env var — trust it without spawn-testing.
  const fromEnv = process.env.CTI_CLAUDE_CODE_EXECUTABLE;
  if (fromEnv && isExecutable(fromEnv)) return fromEnv;

  // 2. Gather all candidates
  const isWindows = process.platform === 'win32';
  const pathCandidates = findAllInPath();
  const wellKnown = isWindows
    ? [
        process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Programs\\claude\\claude.exe` : '',
        'C:\\Program Files\\claude\\claude.exe',
      ].filter(Boolean)
    : [
        `${process.env.HOME}/.claude/local/claude`,
        `${process.env.HOME}/.local/bin/claude`,
        '/usr/local/bin/claude',
        '/opt/homebrew/bin/claude',
        `${process.env.HOME}/.npm-global/bin/claude`,
        `${process.env.HOME}/.local/bin/claude`,
        `${process.env.HOME}/.claude/local/claude`,
      ];

  // Deduplicate while preserving order
  const seen = new Set<string>();
  const allCandidates: string[] = [];
  for (const p of [...pathCandidates, ...wellKnown]) {
    if (p && !seen.has(p)) {
      seen.add(p);
      allCandidates.push(p);
    }
  }

  // 3. Pick the first compatible candidate
  let spawnFallback: string | undefined;
  let firstUnverifiable: string | undefined;
  for (const p of allCandidates) {
    if (!isExecutable(p)) continue;

    const compat = checkCliCompatibility(p);
    if (compat?.compatible) {
      if (!canSpawn(p)) {
        console.warn(`[llm-provider] '${p}' is compatible but cannot be spawned`);
        spawnFallback ||= sdkCliFallback();
        continue;
      }
      if (p !== pathCandidates[0] && pathCandidates.length > 0) {
        console.log(`[llm-provider] Skipping incompatible CLI at "${pathCandidates[0]}", using "${p}" (${compat.version})`);
      }
      return p;
    }
    if (compat) {
      // Version detected but too old — skip it entirely, do NOT fall back
      console.warn(`[llm-provider] CLI at "${p}" is version ${compat.version} (need >= ${MIN_CLI_MAJOR}.x), skipping`);
    } else if (!firstUnverifiable) {
      // Executable exists but --version failed (timeout, crash, etc.)
      // Keep as last-resort fallback only if NO candidate had a parseable version
      firstUnverifiable = p;
    }
  }

  // Only fall back to an unverifiable executable — never to a known-old one.
  // This avoids silently using a 1.x CLI that will crash on first message.
  return spawnFallback ?? firstUnverifiable;
}

/**
 * Resolve the path to the `gemini` CLI executable.
 */
export function resolveGeminiCliPath(): string | undefined {
  // 1. Explicit env var
  const fromEnv = process.env.CTI_GEMINI_EXECUTABLE;
  if (fromEnv && isExecutable(fromEnv)) return fromEnv;

  // 2. Platform-specific command
  const isWindows = process.platform === 'win32';
  const cmd = isWindows ? 'where gemini' : 'which gemini';
  try {
    const resolved = execSync(cmd, { encoding: 'utf-8', timeout: 3000 }).trim().split('\n')[0];
    if (resolved && isExecutable(resolved)) return resolved;
  } catch {
    // not found in PATH
  }

  return undefined;
}

// ── Conversation history injection ──

/**
 * Maximum number of messages to inject as history context.
 * Older messages beyond this limit are silently dropped.
 */
const HISTORY_INJECT_LIMIT = 20;

/**
 * Try to extract readable text from a stored message content string.
 * Messages that contain tool_use blocks are stored as JSON; for those we
 * extract only the text blocks so the history stays human-readable.
 * Returns null if the message has no useful text content.
 */
function extractTextContent(content: string): string | null {
  // Plain text message
  if (!content.trimStart().startsWith('[{')) return content.trim() || null;

  // JSON-encoded content blocks (assistant messages with tool calls)
  try {
    const blocks = JSON.parse(content) as Array<{ type: string; text?: string }>;
    const text = blocks
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('\n\n')
      .trim();
    return text || null;
  } catch {
    return content.trim() || null;
  }
}

/**
 * Build a history prefix to prepend to the prompt when starting a fresh
 * session (no sdkSessionId). Injects the last N user/assistant exchanges
 * so Claude has context about the ongoing conversation.
 */
function buildHistoryPrefix(
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
): string {
  const tail = history.slice(-HISTORY_INJECT_LIMIT);
  if (tail.length === 0) return '';

  const lines: string[] = [
    '<previous_conversation>',
    `(Last ${tail.length} message${tail.length === 1 ? '' : 's'} — for context only, do not re-execute any actions)`,
    '',
  ];

  for (const msg of tail) {
    const text = extractTextContent(msg.content);
    if (!text) continue;
    const label = msg.role === 'user' ? 'User' : 'Assistant';
    lines.push(`${label}: ${text}`);
    lines.push('');
  }

  lines.push('</previous_conversation>', '');
  return lines.join('\n');
}

// ── Multi-modal prompt builder ──

type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

const SUPPORTED_IMAGE_TYPES = new Set<string>([
  'image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp',
]);

/**
 * Detect actual image MIME type from base64 data by inspecting magic bytes.
 * Falls back to the declared type if detection fails.
 */
function detectImageMime(base64Data: string, declaredType: string): ImageMediaType {
  const header = Buffer.from(base64Data.slice(0, 24), 'base64');
  if (header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4E && header[3] === 0x47) return 'image/png';
  if (header[0] === 0xFF && header[1] === 0xD8 && header[2] === 0xFF) return 'image/jpeg';
  if (header[0] === 0x47 && header[1] === 0x49 && header[2] === 0x46) return 'image/gif';
  if (header[0] === 0x52 && header[1] === 0x49 && header[2] === 0x46 && header[3] === 0x46 &&
      header[8] === 0x57 && header[9] === 0x45 && header[10] === 0x42 && header[11] === 0x50) return 'image/webp';
  const normalized = declaredType === 'image/jpg' ? 'image/jpeg' : declaredType;
  return (SUPPORTED_IMAGE_TYPES.has(normalized) ? normalized : 'image/png') as ImageMediaType;
}

const MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'text/plain': '.txt',
  'text/markdown': '.md',
  'text/csv': '.csv',
  'application/json': '.json',
  'application/pdf': '.pdf',
};

function sanitizeAttachmentBaseName(name?: string): string {
  const raw = (name || 'attachment').replace(/[^a-zA-Z0-9._-]/g, '_');
  return raw || 'attachment';
}

function getAttachmentExtension(file: FileAttachment): string {
  const fromMime = MIME_EXT[file.type];
  if (fromMime) return fromMime;
  const fromName = path.extname(file.name || '');
  if (fromName) return fromName;
  return '.bin';
}

function buildPromptWithAttachmentPaths(text: string, attachmentPaths: string[]): string {
  if (attachmentPaths.length === 0) return text;

  const sections = [text.trim(), 'Attached local files:'];
  for (const filePath of attachmentPaths) {
    sections.push(`@${filePath}`);
  }

  return sections.filter(Boolean).join('\n\n');
}

function writeAttachmentTempFiles(files: FileAttachment[] | undefined): { paths: string[]; cleanup: () => void } {
  if (!files || files.length === 0) {
    return { paths: [], cleanup: () => {} };
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-to-im-'));
  const paths: string[] = [];

  for (const file of files) {
    const safeBase = sanitizeAttachmentBaseName(file.name);
    const realMime = SUPPORTED_IMAGE_TYPES.has(file.type) ? detectImageMime(file.data, file.type) : file.type;
    const ext = MIME_EXT[realMime] || getAttachmentExtension(file);
    const filePath = path.join(tmpDir, `${safeBase}${safeBase.endsWith(ext) ? '' : ext}`);
    fs.writeFileSync(filePath, Buffer.from(file.data, 'base64'));
    paths.push(filePath);
  }

  return {
    paths,
    cleanup: () => {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore temp cleanup failures
      }
    },
  };
}

/**
 * Build a prompt for query(). When files are present, returns an async
 * iterable that yields a single SDKUserMessage with multi-modal content
 * (image blocks + text). Otherwise returns the plain text string.
 */
function buildPrompt(
  text: string,
  files?: FileAttachment[],
): {
  prompt: string | AsyncIterable<{ type: 'user'; message: { role: 'user'; content: unknown[] }; parent_tool_use_id: null; session_id: string }>;
  textPrompt: string;
  cleanup: () => void;
} {
  const { paths: attachmentPaths, cleanup } = writeAttachmentTempFiles(files);
  const promptText = buildPromptWithAttachmentPaths(text, attachmentPaths);
  const imageFiles = files?.filter(f => SUPPORTED_IMAGE_TYPES.has(f.type));
  if (!imageFiles || imageFiles.length === 0) {
    return { prompt: promptText, textPrompt: promptText, cleanup };
  }

  const contentBlocks: unknown[] = [];

  for (const file of imageFiles) {
    const detectedMime = detectImageMime(file.data, file.type);
    contentBlocks.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: detectedMime,
        data: file.data,
      },
    });
  }

  if (promptText.trim()) {
    contentBlocks.push({ type: 'text', text: promptText });
  }

  const msg = {
    type: 'user' as const,
    message: { role: 'user' as const, content: contentBlocks },
    parent_tool_use_id: null,
    session_id: '',
  };

  return {
    prompt: (async function* () { yield msg; })(),
    textPrompt: promptText,
    cleanup,
  };
}

/**
 * Mutable state shared between the streaming loop and catch block.
 *
 * Key distinction:
 *   hasReceivedResult — set when the SDK delivers a `result` message
 *     (success OR structured error). This means the CLI completed its
 *     business logic; any subsequent "process exited with code 1" is
 *     just the transport tearing down and should be suppressed.
 *
 *   hasStreamedText — set when at least one text_delta was emitted.
 *     Used to distinguish "partial output + crash" (real failure, must
 *     emit error) from "business error only in assistant block" (use
 *     lastAssistantText instead of generic error).
 */
export interface StreamState {
  /** True once a `result` message (success or error subtype) has been processed. */
  hasReceivedResult: boolean;
  /** True once any text_delta has been emitted via stream_event. */
  hasStreamedText: boolean;
  /** True once a text delta has been observed from stream_event. */
  sawTextDelta: boolean;
  /** Tracks tool IDs already emitted from partial streaming to avoid duplicates. */
  seenToolUseIds: Set<string>;
  /**
   * Full text captured from the final `assistant` message.
   * NOT emitted during normal flow (stream_event deltas handle that).
   * Used by the catch block to surface business errors that arrived
   * as assistant text but were followed by a CLI crash.
   */
  lastAssistantText: string;
}

// ── V2 Session Pool ──

const SESSION_IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1000;  // 24h since last user interaction
const SESSION_MAX_LIFETIME_MS = 72 * 60 * 60 * 1000;  // 72h absolute max — force refresh
const SESSION_POOL_MAX = 10;
const CLEANUP_INTERVAL_MS = 60 * 1000; // 60 seconds

interface ManagedSession {
  session: SDKSession;
  workingDirectory: string | undefined;
  createdAt: number;
  lastUsedAt: number;
  busy: boolean;
  closed: boolean;
}

export class SDKLLMProvider implements LLMProvider {
  private cliPath: string | undefined;
  private autoApprove: boolean;

  // V2 session pool
  private sessionPool = new Map<string, ManagedSession>();
  private deferredSessions = new Map<string, { workingDirectory?: string }>();
  private activeControllers = new Map<string, ReadableStreamDefaultController<string>>();
  private cleanupTimer: NodeJS.Timeout | null = null;
  private poolDisabled = false;

  constructor(private pendingPerms: PendingPermissions, cliPath?: string, autoApprove = false) {
    this.cliPath = cliPath;
    this.autoApprove = autoApprove;
  }

  /** Disable V2 session pooling entirely (force V1-only). */
  disablePool(): void {
    this.poolDisabled = true;
  }

  // ── V2 Session Pool Management ──

  private getPooledSession(sdkSessionId: string): ManagedSession | undefined {
    const managed = this.sessionPool.get(sdkSessionId);
    if (managed && !managed.closed && !managed.busy) return managed;
    return undefined;
  }

  private createPooledSession(sdkSessionId: string, workingDirectory?: string): ManagedSession {
    const cleanEnv = buildSubprocessEnv();
    const pendingPerms = this.pendingPerms;
    const activeControllers = this.activeControllers;
    const autoApprove = this.autoApprove;

    const sessionOptions: Record<string, unknown> = {
      model: 'claude-sonnet-4-20250514',
      includePartialMessages: true,
      env: cleanEnv,
      canUseTool: async (
        toolName: string,
        input: Record<string, unknown>,
        opts: { toolUseID: string; suggestions?: string[] },
      ): Promise<PermissionResult> => {
        if (autoApprove) {
          return { behavior: 'allow' as const, updatedInput: input };
        }
        const ctrl = activeControllers.get(sdkSessionId);
        if (ctrl) {
          ctrl.enqueue(
            sseEvent('permission_request', {
              permissionRequestId: opts.toolUseID,
              toolName,
              toolInput: input,
              suggestions: opts.suggestions || [],
            }),
          );
        }
        const result = await pendingPerms.waitFor(opts.toolUseID);
        if (result.behavior === 'allow') {
          return { behavior: 'allow' as const, updatedInput: input };
        }
        return { behavior: 'deny' as const, message: result.message || 'Denied by user' };
      },
    };
    if (this.cliPath) {
      sessionOptions.pathToClaudeCodeExecutable = this.cliPath;
    }

    // SDK V2 SDKSessionOptions doesn't expose `cwd`, but the internal
    // process spawner reads it from its options and passes it to
    // child_process.spawn().  The V2 wrapper doesn't forward it, so the
    // spawned CLI inherits process.cwd().  We temporarily chdir so the
    // subprocess starts in the correct project directory — spawn() is
    // synchronous inside the constructor so this is safe.
    const savedCwd = process.cwd();
    if (workingDirectory) {
      try { process.chdir(normalizeMsysPath(workingDirectory)); } catch { /* ignore invalid dir */ }
    }

    let session: SDKSession;
    try {
      session = unstable_v2_resumeSession(
        sdkSessionId,
        sessionOptions as Parameters<typeof unstable_v2_resumeSession>[1],
      );
    } finally {
      if (workingDirectory) {
        try { process.chdir(savedCwd); } catch { /* ignore */ }
      }
    }

    const managed: ManagedSession = {
      session,
      workingDirectory,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      busy: false,
      closed: false,
    };

    // Evict oldest idle session if pool is full
    if (this.sessionPool.size >= SESSION_POOL_MAX) {
      let oldestId: string | null = null;
      let oldestTime = Infinity;
      for (const [id, ms] of this.sessionPool) {
        if (!ms.busy && ms.lastUsedAt < oldestTime) {
          oldestTime = ms.lastUsedAt;
          oldestId = id;
        }
      }
      if (oldestId) this.destroySession(oldestId);
    }

    this.sessionPool.set(sdkSessionId, managed);
    console.log(`[llm-provider] V2 session pooled: ${sdkSessionId} (pool size: ${this.sessionPool.size})`);
    return managed;
  }

  private destroySession(sdkSessionId: string): void {
    const managed = this.sessionPool.get(sdkSessionId);
    if (!managed) return;
    managed.closed = true;
    this.sessionPool.delete(sdkSessionId);
    this.activeControllers.delete(sdkSessionId);
    try { managed.session.close(); } catch { /* ignore close errors */ }
    console.log(`[llm-provider] V2 session destroyed: ${sdkSessionId} (pool size: ${this.sessionPool.size})`);
  }

  startCleanupLoop(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [id, managed] of this.sessionPool) {
        if (managed.busy) continue;
        const idleExpired = (now - managed.lastUsedAt) > SESSION_IDLE_TIMEOUT_MS;
        const lifetimeExpired = (now - managed.createdAt) > SESSION_MAX_LIFETIME_MS;
        if (idleExpired || lifetimeExpired) {
          const reason = lifetimeExpired ? 'max lifetime (72h)' : 'idle (24h)';
          console.log(`[llm-provider] Recycling V2 session ${id}: ${reason}`);
          const workDir = managed.workingDirectory;
          this.destroySession(id);
          // Auto-recreate: immediately spawn a fresh session so next message has zero cold start
          try {
            this.createPooledSession(id, workDir);
            console.log(`[llm-provider] Auto-recreated V2 session: ${id}`);
          } catch (err) {
            console.warn(`[llm-provider] Auto-recreate failed for ${id}:`, err instanceof Error ? err.message : err);
            // Fall back to deferred — will be created lazily on next message
            this.deferredSessions.set(id, { workingDirectory: workDir });
          }
        }
      }
    }, CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref();
  }

  /**
   * Eagerly spawn a V2 session so the first message has zero cold start.
   * Called at bridge startup for existing bindings.
   * Safe to call fire-and-forget; never throws.
   */
  prewarmSession(sdkSessionId: string, workingDirectory: string): void {
    if (this.poolDisabled) return;
    if (this.sessionPool.has(sdkSessionId)) return;
    if (this.deferredSessions.has(sdkSessionId)) return;
    try {
      this.createPooledSession(sdkSessionId, workingDirectory);
      console.log(`[llm-provider] Eagerly spawned V2 session: ${sdkSessionId}`);
    } catch (err) {
      console.warn(`[llm-provider] Eager spawn failed for ${sdkSessionId}:`, err instanceof Error ? err.message : err);
      // Fallback to deferred — will be created lazily on first message
      this.deferredSessions.set(sdkSessionId, { workingDirectory });
    }
  }

  closeAll(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    for (const [id] of this.sessionPool) {
      this.destroySession(id);
    }
    console.log('[llm-provider] All V2 sessions closed');
  }

  // ── Routing: streamChat dispatches to V1 or V2 ──

  streamChat(params: StreamChatParams): ReadableStream<string> {
    const sdkSessionId = params.sdkSessionId;
    if (sdkSessionId) {
      const managed = this.getPooledSession(sdkSessionId);
      if (managed) {
        console.log(`[llm-provider] V2 fast path for session: ${sdkSessionId}`);
        return this.streamChatV2(params, managed, sdkSessionId);
      }
      const deferred = this.deferredSessions.get(sdkSessionId);
      if (deferred) {
        this.deferredSessions.delete(sdkSessionId);
        try {
          const newManaged = this.createPooledSession(sdkSessionId, deferred.workingDirectory);
          console.log(`[llm-provider] V2 lazy-created for session: ${sdkSessionId}`);
          return this.streamChatV2(params, newManaged, sdkSessionId);
        } catch (e) {
          console.warn('[llm-provider] V2 lazy creation failed, falling back to V1:', e instanceof Error ? e.message : e);
        }
      }
    }
    console.log(`[llm-provider] V1 path${sdkSessionId ? ` (no pooled session for ${sdkSessionId})` : ' (new session)'}`);
    return this.streamChatV1(params);
  }

  // ── V1 Path: query() — original logic + deferred V2 session ──

  private streamChatV1(params: StreamChatParams): ReadableStream<string> {
    const pendingPerms = this.pendingPerms;
    const cliPath = this.cliPath;
    const autoApprove = this.autoApprove;
    const self = this;

    return new ReadableStream({
      start(controller) {
        (async () => {
          // Ring-buffer for recent stderr output (max 4 KB)
          const MAX_STDERR = 4096;
          let stderrBuf = '';
          let cleanupPromptFiles = () => {};
          const state: StreamState = {
            hasReceivedResult: false,
            hasStreamedText: false,
            sawTextDelta: false,
            seenToolUseIds: new Set<string>(),
            lastAssistantText: '',
          };
          try {
            const cleanEnv = buildSubprocessEnv();

            // Cross-runtime migration safety: drop non-Claude model names
            // that may linger in session data from a previous Codex runtime.
            let model = params.model;
            if (isNonClaudeModel(model)) {
              console.warn(`[llm-provider] Ignoring non-Claude model "${model}", using CLI default`);
              model = undefined;
            }

            // Only pass model to CLI if explicitly configured via CTI_DEFAULT_MODEL.
            // Letting the CLI choose its own default avoids exit-code-1 failures
            // when a stored model is inaccessible on the current machine/plan.
            const passModel = !!process.env.CTI_DEFAULT_MODEL;
            if (model && !passModel) {
              console.log(`[llm-provider] Skipping model "${model}", using CLI default (set CTI_DEFAULT_MODEL to override)`);
              model = undefined;
            }

            const queryOptions: Record<string, unknown> = {
              cwd: params.workingDirectory,
              model,
              resume: params.sdkSessionId || undefined,
              abortController: params.abortController,
              permissionMode: (params.permissionMode as 'default' | 'acceptEdits' | 'plan') || undefined,
              systemPrompt: params.systemPrompt || undefined,
              settingSources: ['user', 'project'],
              includePartialMessages: true,
              env: cleanEnv,
              stderr: (data: string) => {
                stderrBuf += data;
                if (stderrBuf.length > MAX_STDERR) {
                  stderrBuf = stderrBuf.slice(-MAX_STDERR);
                }
              },
              canUseTool: async (
                  toolName: string,
                  input: Record<string, unknown>,
                  opts: { toolUseID: string; suggestions?: string[] },
                ): Promise<PermissionResult> => {
                  // Auto-approve if configured (useful for channels without
                  // interactive permission UI, e.g. Feishu WebSocket mode)
                  if (autoApprove) {
                    return { behavior: 'allow' as const, updatedInput: input };
                  }

                  // Emit permission_request SSE event for the bridge
                  controller.enqueue(
                    sseEvent('permission_request', {
                      permissionRequestId: opts.toolUseID,
                      toolName,
                      toolInput: input,
                      suggestions: opts.suggestions || [],
                    }),
                  );

                  // Block until IM user responds
                  const result = await pendingPerms.waitFor(opts.toolUseID);

                  if (result.behavior === 'allow') {
                    return { behavior: 'allow' as const, updatedInput: input };
                  }
                  return {
                    behavior: 'deny' as const,
                    message: result.message || 'Denied by user',
                  };
                },
            };
            if (cliPath) {
              queryOptions.pathToClaudeCodeExecutable = cliPath;
            }

            // When starting a fresh session (no sdkSessionId), prepend
            // conversation history so Claude has prior context.
            const effectivePrompt =
              !params.sdkSessionId && params.conversationHistory && params.conversationHistory.length > 0
                ? buildHistoryPrefix(params.conversationHistory) + params.prompt
                : params.prompt;

            const promptInput = buildPrompt(effectivePrompt, params.files);
            cleanupPromptFiles = promptInput.cleanup;
            const q = query({
              prompt: promptInput.prompt as Parameters<typeof query>[0]['prompt'],
              options: queryOptions as Parameters<typeof query>[0]['options'],
            });
            for await (const msg of q) {
              handleMessage(msg, controller, state);

              // Defer V2 session creation — don't spawn now, create lazily on next message
              if (
                !self.poolDisabled &&
                msg.type === 'result' &&
                msg.subtype === 'success' &&
                msg.session_id &&
                !self.sessionPool.has(msg.session_id) &&
                !self.deferredSessions.has(msg.session_id)
              ) {
                self.deferredSessions.set(msg.session_id, { workingDirectory: params.workingDirectory });
                console.log(`[llm-provider] V2 session deferred: ${msg.session_id}`);
              }
            }

            controller.close();
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error('[llm-provider] SDK query error:', err instanceof Error ? err.stack || err.message : err);
            if (stderrBuf) {
              console.error('[llm-provider] stderr from CLI:', stderrBuf.trim());
            }

            const isTransportExit = message.includes('process exited with code');

            // ── Case 1: Result already received ──
            // The SDK delivered a proper result (success or structured error).
            // A trailing "process exited with code 1" is transport teardown noise.
            if (state.hasReceivedResult && isTransportExit) {
              console.log('[llm-provider] Suppressing transport error — result already received');
              controller.close();
              return;
            }

            // ── Case 2: Recognised business error in assistant text ──
            // The CLI returned an assistant message with text that matches
            // a known auth/access error pattern (e.g. "Your organization
            // does not have access to Claude"). Forward it as-is — it's
            // more informative than the generic transport error.
            // Only activate when the text is a recognised error; otherwise
            // a normal response that crashed before result would be silently
            // presented as if it succeeded.
            if (state.lastAssistantText && classifyAuthError(state.lastAssistantText)) {
              controller.enqueue(sseEvent('text', state.lastAssistantText));
              controller.close();
              return;
            }

            // ── Case 3: Partial output + crash ──
            // Text was streamed but no result arrived — the response was
            // truncated by a real crash. Always emit an error so the user
            // knows the output is incomplete.

            // ── Build user-facing error message ──
            const authKind = classifyAuthError(message) || classifyAuthError(stderrBuf);
            let userMessage: string;
            if (authKind === 'cli') {
              userMessage = CLI_AUTH_USER_MESSAGE;
            } else if (authKind === 'api') {
              userMessage = API_AUTH_USER_MESSAGE;
            } else if (isTransportExit) {
              const stderrSummary = stderrBuf.trim();
              const lines = [message];
              if (stderrSummary) {
                lines.push('', 'CLI stderr:', stderrSummary.slice(-1024));
              }
              lines.push(
                '',
                'Possible causes:',
                '• Claude CLI not authenticated — run: claude auth login',
                '• Claude CLI version too old (need >= 2.x) — run: claude --version',
                '• Missing ANTHROPIC_* env vars in daemon — check config.env',
                '',
                'Run `/agent-to-im doctor` to diagnose.',
              );
              userMessage = lines.join('\n');
            } else {
              userMessage = message;
            }

            controller.enqueue(sseEvent('error', userMessage));
            controller.close();
          } finally {
            cleanupPromptFiles();
          }
        })();
      },
    });
  }

  // ── V2 Path: persistent session, fast send() ──

  private streamChatV2(params: StreamChatParams, managed: ManagedSession, sdkSessionId: string): ReadableStream<string> {
    const self = this;

    return new ReadableStream({
      start(controller) {
        (async () => {
          let cleanupPromptFiles = () => {};
          managed.busy = true;
          managed.lastUsedAt = Date.now();
          self.activeControllers.set(sdkSessionId, controller);

          const onAbort = () => {
            console.log(`[llm-provider] V2 session aborted: ${sdkSessionId}`);
            self.destroySession(sdkSessionId);
          };
          params.abortController?.signal.addEventListener('abort', onAbort, { once: true });

          try {
            const promptInput = buildPrompt(params.prompt, params.files);
            cleanupPromptFiles = promptInput.cleanup;

            const promptText = typeof promptInput.prompt === 'string'
              ? promptInput.prompt
              : promptInput.textPrompt;

            await managed.session.send(promptText);

            const streamGen = managed.session.stream();
            const state: StreamState = {
              hasReceivedResult: false,
              hasStreamedText: false,
              sawTextDelta: false,
              seenToolUseIds: new Set<string>(),
              lastAssistantText: '',
            };

            for await (const msg of streamGen) {
              if (managed.closed) break;
              handleMessage(msg, controller, state);
            }

            controller.close();
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`[llm-provider] V2 error for ${sdkSessionId}:`, err instanceof Error ? err.stack || err.message : err);

            self.destroySession(sdkSessionId);

            // Fallback to V1 transparently
            console.log(`[llm-provider] Falling back to V1 for current message`);
            try {
              const v1Stream = self.streamChatV1(params);
              const reader = v1Stream.getReader();
              while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                controller.enqueue(value);
              }
              controller.close();
            } catch (v1Err) {
              const v1Message = v1Err instanceof Error ? v1Err.message : String(v1Err);
              console.error('[llm-provider] V1 fallback also failed:', v1Message);
              controller.enqueue(sseEvent('error', v1Message));
              controller.close();
            }
          } finally {
            managed.busy = false;
            self.activeControllers.delete(sdkSessionId);
            params.abortController?.signal.removeEventListener('abort', onAbort);
            cleanupPromptFiles();
          }
        })();
      },
    });
  }
}

/** @internal Exported for testing. */
export function handleMessage(
  msg: SDKMessage,
  controller: ReadableStreamDefaultController<string>,
  state: StreamState,
): void {
  switch (msg.type) {
    case 'stream_event': {
      const event = msg.event;
      if (
        event.type === 'content_block_delta' &&
        event.delta.type === 'text_delta'
      ) {
        // Emit delta text — the bridge accumulates on its side
        state.sawTextDelta = true;
        state.hasStreamedText = true;
        controller.enqueue(sseEvent('text', event.delta.text));
      }
      if (
        event.type === 'content_block_start' &&
        event.content_block.type === 'tool_use'
      ) {
        state.seenToolUseIds.add(event.content_block.id);
        controller.enqueue(
          sseEvent('tool_use', {
            id: event.content_block.id,
            name: event.content_block.name,
            input: {},
          }),
        );
      }
      break;
    }

    case 'assistant': {
      // Full assistant message — capture text but do NOT emit it.
      // Text deltas are already streamed via stream_event above; emitting
      // the full text block here would duplicate the entire response.
      //
      // The captured text is used by the catch block to surface business
      // errors (e.g. "Your organization does not have access") that the
      // CLI returned as assistant text without prior streaming deltas.
      if (msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === 'text' && block.text) {
            state.lastAssistantText += (state.lastAssistantText ? '\n' : '') + block.text;
            if (!state.sawTextDelta && !classifyAuthError(block.text)) {
              state.hasStreamedText = true;
              controller.enqueue(sseEvent('text', block.text));
            }
            continue;
          }
          if (block.type === 'tool_use') {
            if (state.seenToolUseIds.has(block.id)) continue;
            state.seenToolUseIds.add(block.id);
            controller.enqueue(
              sseEvent('tool_use', {
                id: block.id,
                name: block.name,
                input: block.input,
              }),
            );
          }
        }
      }
      break;
    }

    case 'user': {
      // User messages contain tool_result blocks from completed tool calls
      const content = msg.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (typeof block === 'object' && block !== null && 'type' in block && block.type === 'tool_result') {
            const rb = block as { tool_use_id: string; content?: unknown; is_error?: boolean };
            const text = typeof rb.content === 'string'
              ? rb.content
              : JSON.stringify(rb.content ?? '');
            controller.enqueue(
              sseEvent('tool_result', {
                tool_use_id: rb.tool_use_id,
                content: text,
                is_error: rb.is_error || false,
              }),
            );
          }
        }
      }
      break;
    }

    case 'result': {
      state.hasReceivedResult = true;
      if (msg.subtype === 'success') {
        controller.enqueue(
          sseEvent('result', {
            session_id: msg.session_id,
            is_error: msg.is_error,
            usage: {
              input_tokens: msg.usage.input_tokens,
              output_tokens: msg.usage.output_tokens,
              cache_read_input_tokens: msg.usage.cache_read_input_tokens ?? 0,
              cache_creation_input_tokens: msg.usage.cache_creation_input_tokens ?? 0,
              cost_usd: msg.total_cost_usd,
            },
          }),
        );
      } else {
        // Error result from SDK (distinct from transport errors in catch)
        const errors =
          'errors' in msg && Array.isArray(msg.errors)
            ? msg.errors.join('; ')
            : 'Unknown error';
        controller.enqueue(sseEvent('error', errors));
      }
      break;
    }

    case 'system': {
      if (msg.subtype === 'init') {
        controller.enqueue(
          sseEvent('status', {
            session_id: msg.session_id,
            model: msg.model,
          }),
        );
      }
      break;
    }

    default:
      // Ignore other message types (auth_status, task_notification, etc.)
      break;
  }
}

export const __testOnly = {
  buildPrompt,
  handleMessage,
};
