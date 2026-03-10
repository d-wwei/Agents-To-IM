/**
 * Daemon entry point for claude-to-im-skill.
 *
 * Assembles all DI implementations and starts the bridge.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { initBridgeContext } from 'claude-to-im/src/lib/bridge/context.js';
import * as bridgeManager from 'claude-to-im/src/lib/bridge/bridge-manager.js';
// Side-effect import to trigger adapter self-registration
import 'claude-to-im/src/lib/bridge/adapters/index.js';

import type { LLMProvider } from 'claude-to-im/src/lib/bridge/host.js';
import { loadConfig, configToSettings, CTI_HOME, HOST_PROFILE } from './config.js';
import type { Config } from './config.js';
import { JsonFileStore } from './store.js';
import { SDKLLMProvider, resolveClaudeCliPath, resolveGeminiCliPath, preflightCheck } from './llm-provider.js';
import { GeminiProvider } from './gemini-provider.js';
import { PendingPermissions } from './permission-gateway.js';
import { RetryingLLMProvider } from './retry-provider.js';
import { setupLogger } from './logger.js';

const RUNTIME_DIR = path.join(CTI_HOME, 'runtime');
const STATUS_FILE = path.join(RUNTIME_DIR, 'status.json');
const PID_FILE = path.join(RUNTIME_DIR, 'bridge.pid');
const LOG_PREFIX = HOST_PROFILE.logPrefix;

/**
 * Resolve the LLM provider based on the runtime setting.
 * - 'claude': uses Claude Code SDK via SDKLLMProvider
 * - 'gemini': uses Gemini CLI via GeminiProvider
 * - 'codex': uses @openai/codex-sdk via CodexProvider
 * - 'auto': tries Gemini, then Claude, falls back to Codex
 */
async function resolveProvider(config: Config, pendingPerms: PendingPermissions): Promise<LLMProvider> {
  const runtime = config.runtime;

  if (runtime === 'gemini') {
    const cliPath = resolveGeminiCliPath();
    if (!cliPath) {
      console.error(
        `[${LOG_PREFIX}] FATAL: Cannot find the \`gemini\` CLI executable.\n` +
        '  Fix: Install Gemini CLI or set CTI_GEMINI_EXECUTABLE=/path/to/gemini',
      );
      process.exit(1);
    }
    console.log(`[${LOG_PREFIX}] Using Gemini CLI: ${cliPath}`);
    return new GeminiProvider(cliPath, config.autoApprove);
  }

  if (runtime === 'codex') {
    const { CodexProvider } = await import('./codex-provider.js');
    return new CodexProvider(pendingPerms, config.codexSkipGitRepoCheck !== false);
  }

  if (runtime === 'auto') {
    const geminiPath = resolveGeminiCliPath();
    if (geminiPath) {
      console.log(`[${LOG_PREFIX}] Auto: using Gemini CLI at ${geminiPath}`);
      process.env.CTI_RUNTIME = 'gemini';
      return new GeminiProvider(geminiPath, config.autoApprove);
    }
    const claudePath = resolveClaudeCliPath();
    if (claudePath) {
      // Auto mode: preflight the resolved CLI before committing to it.
      const check = preflightCheck(claudePath);
      if (check.ok) {
        console.log(`[${LOG_PREFIX}] Auto: using Claude CLI at ${claudePath} (${check.version})`);
        return new SDKLLMProvider(pendingPerms, claudePath, config.autoApprove);
      }
      // Preflight failed — fall through to Codex instead of silently using a broken CLI
      console.warn(
        `[${LOG_PREFIX}] Auto: Claude CLI at ${claudePath} failed preflight: ${check.error}\n` +
        `  Falling back to Codex.`,
      );
    } else {
      console.log(`[${LOG_PREFIX}] Auto: neither Gemini nor Claude CLI found, falling back to Codex`);
    }
    const { CodexProvider } = await import('./codex-provider.js');
    return new CodexProvider(pendingPerms, config.codexSkipGitRepoCheck !== false);
  }

  // Default: claude
  const cliPath = resolveClaudeCliPath();

  if (!cliPath) {
    console.error(
      `[${LOG_PREFIX}] FATAL: Cannot find the \`claude\` CLI executable.\n` +
      '  Tried: CTI_CLAUDE_CODE_EXECUTABLE env, /usr/local/bin/claude, /opt/homebrew/bin/claude, ~/.npm-global/bin/claude, ~/.local/bin/claude\n' +
      '  Fix: Install Claude Code CLI (https://docs.anthropic.com/en/docs/claude-code) or set CTI_CLAUDE_CODE_EXECUTABLE=/path/to/claude\n' +
      '  Or: Set CTI_RUNTIME=codex to use Codex instead',
    );
    process.exit(1);
  }
  // Preflight: verify the CLI can actually run in the daemon environment.
  // In claude runtime this is fatal — starting with a broken CLI would just
  // defer the error to the first user message, which is harder to diagnose.
  const check = preflightCheck(cliPath);
  if (check.ok) {
    console.log(`[${LOG_PREFIX}] CLI preflight OK: ${cliPath} (${check.version})`);
  } else {
    console.error(
      `[${LOG_PREFIX}] FATAL: Claude CLI preflight check failed.\n` +
      `  Path: ${cliPath}\n` +
      `  Error: ${check.error}\n` +
      `  Fix:\n` +
      `    1. Install Claude Code CLI >= 2.x: https://docs.anthropic.com/en/docs/claude-code\n` +
      `    2. Or set CTI_CLAUDE_CODE_EXECUTABLE=/path/to/correct/claude\n` +
      `    3. Or set CTI_RUNTIME=auto to fall back to Codex`,
    );
    process.exit(1);
  }
  return new SDKLLMProvider(pendingPerms, cliPath, config.autoApprove);
}

interface StatusInfo {
  running: boolean;
  pid?: number;
  runId?: string;
  startedAt?: string;
  channels?: string[];
  lastExitReason?: string;
}

function writeStatus(info: StatusInfo): void {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  // Merge with existing status to preserve fields like lastExitReason
  let existing: Record<string, unknown> = {};
  try { existing = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf-8')); } catch { /* first write */ }
  const merged = { ...existing, ...info };
  const tmp = STATUS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), 'utf-8');
  fs.renameSync(tmp, STATUS_FILE);
}

async function main(): Promise<void> {
  const config = loadConfig();
  setupLogger();

  const runId = crypto.randomUUID();
  console.log(`[${LOG_PREFIX}] Starting bridge (run_id: ${runId})`);

  const settings = configToSettings(config);
  const store = new JsonFileStore(settings);
  const pendingPerms = new PendingPermissions();
  const rawProvider = await resolveProvider(config, pendingPerms);
  const llm = new RetryingLLMProvider(rawProvider, store);
  console.log(`[${LOG_PREFIX}] Runtime: ${config.runtime}`);

  // Start V2 session pool cleanup loop if using Claude SDK
  if (rawProvider instanceof SDKLLMProvider) {
    rawProvider.startCleanupLoop();
    console.log(`[${LOG_PREFIX}] V2 session pool cleanup loop started`);
  }

  const gateway = {
    resolvePendingPermission: (id: string, resolution: { behavior: 'allow' | 'deny'; message?: string }) =>
      pendingPerms.resolve(id, resolution),
  };

  initBridgeContext({
    store,
    llm,
    permissions: gateway,
    lifecycle: {
      onBridgeStart: () => {
        // Write authoritative PID from the actual process (not shell $!)
        fs.mkdirSync(RUNTIME_DIR, { recursive: true });
        fs.writeFileSync(PID_FILE, String(process.pid), 'utf-8');
        writeStatus({
          running: true,
          pid: process.pid,
          runId,
          startedAt: new Date().toISOString(),
          channels: config.enabledChannels,
        });
        console.log(`[${LOG_PREFIX}] Bridge started (PID: ${process.pid}, channels: ${config.enabledChannels.join(', ')})`);
      },
      onBridgeStop: () => {
        writeStatus({ running: false });
        console.log(`[${LOG_PREFIX}] Bridge stopped`);
      },
    },
  });

  await bridgeManager.start();

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async (signal?: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const reason = signal ? `signal: ${signal}` : 'shutdown requested';
    console.log(`[${LOG_PREFIX}] Shutting down (${reason})...`);
    if (rawProvider instanceof SDKLLMProvider) {
      rawProvider.closeAll();
    }
    pendingPerms.denyAll();
    await bridgeManager.stop();
    writeStatus({ running: false, lastExitReason: reason });
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGHUP', () => shutdown('SIGHUP'));

  // ── Exit diagnostics ──
  process.on('unhandledRejection', (reason) => {
    console.error(`[${LOG_PREFIX}] unhandledRejection:`, reason instanceof Error ? reason.stack || reason.message : reason);
    writeStatus({ running: false, lastExitReason: `unhandledRejection: ${reason instanceof Error ? reason.message : String(reason)}` });
  });
  process.on('uncaughtException', (err) => {
    console.error(`[${LOG_PREFIX}] uncaughtException:`, err.stack || err.message);
    writeStatus({ running: false, lastExitReason: `uncaughtException: ${err.message}` });
    process.exit(1);
  });
  process.on('beforeExit', (code) => {
    console.log(`[${LOG_PREFIX}] beforeExit (code: ${code})`);
  });
  process.on('exit', (code) => {
    console.log(`[${LOG_PREFIX}] exit (code: ${code})`);
  });

  // ── Heartbeat to keep event loop alive ──
  // setInterval is ref'd by default, preventing Node from exiting
  // when the event loop would otherwise be empty.
  setInterval(() => { /* keepalive */ }, 45_000);
}

main().catch((err) => {
  console.error(`[${LOG_PREFIX}] Fatal error:`, err instanceof Error ? err.stack || err.message : err);
  try { writeStatus({ running: false, lastExitReason: `fatal: ${err instanceof Error ? err.message : String(err)}` }); } catch { /* ignore */ }
  process.exit(1);
});
