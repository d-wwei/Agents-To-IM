/**
 * Bridge Manager — singleton orchestrator for the multi-IM bridge system.
 *
 * Manages adapter lifecycles, routes inbound messages through the
 * conversation engine, and coordinates permission handling.
 *
 * Uses globalThis to survive Next.js HMR in development.
 */

import type { BridgeStatus, InboundMessage, OutboundMessage, StreamingPreviewState } from './types';
import { createAdapter, getRegisteredTypes } from './channel-adapter';
import type { BaseChannelAdapter } from './channel-adapter';
// Side-effect import: triggers self-registration of all adapter factories
import './adapters';
import * as router from './channel-router';
import * as engine from './conversation-engine';
import * as broker from './permission-broker';
import { deliver, deliverRendered } from './delivery-layer';
import { markdownToTelegramChunks } from './markdown/telegram';
import { markdownToDiscordChunks } from './markdown/discord';
import { getBridgeContext } from './context';
import { escapeHtml } from './adapters/telegram-utils';
import { tryHandleSessionManagementCommand } from '../../../../../src/session-command-support.js';
import { prepareVoiceReply, wantsVoiceReply, type GeneratedVoiceReply } from '../../../../../src/voice-reply.js';
import { writeTaskDiagnosticSnapshot } from '../../../../../src/diagnostics.js';
import {
  validateWorkingDirectory,
  validateSessionId,
  isDangerousInput,
  sanitizeInput,
  validateMode,
} from './security/validators';

const GLOBAL_KEY = '__bridge_manager__';

// ── Streaming preview helpers ──────────────────────────────────

/** Generate a non-zero random 31-bit integer for use as draft_id. */
function generateDraftId(): number {
  return (Math.floor(Math.random() * 0x7FFFFFFE) + 1); // 1 .. 2^31-1
}

interface StreamConfig {
  intervalMs: number;
  minDeltaChars: number;
  maxChars: number;
}

/** Default stream config per channel type. */
const STREAM_DEFAULTS: Record<string, StreamConfig> = {
  telegram: { intervalMs: 700, minDeltaChars: 20, maxChars: 3900 },
  discord: { intervalMs: 1500, minDeltaChars: 40, maxChars: 1900 },
};

const DEFAULT_TASK_WATCHDOG_MS = 12 * 60 * 1000;

function getTaskWatchdogMs(): number {
  const fromEnv = Number.parseInt(process.env.CTI_TASK_WATCHDOG_MS || '', 10);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return DEFAULT_TASK_WATCHDOG_MS;
}

function getStreamConfig(channelType = 'telegram'): StreamConfig {
  const { store } = getBridgeContext();
  const defaults = STREAM_DEFAULTS[channelType] || STREAM_DEFAULTS.telegram;
  const prefix = `bridge_${channelType}_stream_`;
  const intervalMs = parseInt(store.getSetting(`${prefix}interval_ms`) || '', 10) || defaults.intervalMs;
  const minDeltaChars = parseInt(store.getSetting(`${prefix}min_delta_chars`) || '', 10) || defaults.minDeltaChars;
  const maxChars = parseInt(store.getSetting(`${prefix}max_chars`) || '', 10) || defaults.maxChars;
  return { intervalMs, minDeltaChars, maxChars };
}

/** Fire-and-forget: send a preview draft. Only degrades on permanent failure. */
function flushPreview(
  adapter: BaseChannelAdapter,
  state: StreamingPreviewState,
  config: StreamConfig,
): void {
  if (state.degraded || !adapter.sendPreview) return;

  const text = state.pendingText.length > config.maxChars
    ? state.pendingText.slice(0, config.maxChars) + '...'
    : state.pendingText;

  state.lastSentText = text;
  state.lastSentAt = Date.now();

  adapter.sendPreview(state.chatId, text, state.draftId).then(result => {
    if (result === 'degrade') state.degraded = true;
    // 'skip' — transient failure, next flush will retry naturally
  }).catch(() => {
    // Network error — transient, don't degrade
  });
}

// ── Channel-aware rendering dispatch ──────────────────────────

import type { ChannelAddress, SendResult } from './types';

/**
 * Render response text and deliver via the appropriate channel format.
 * Telegram: Markdown → HTML chunks via deliverRendered.
 * Other channels: plain text via deliver (no HTML).
 */
async function deliverResponse(
  adapter: BaseChannelAdapter,
  address: ChannelAddress,
  responseText: string,
  sessionId: string,
): Promise<SendResult> {
  if (adapter.channelType === 'telegram') {
    const chunks = markdownToTelegramChunks(responseText, 4096);
    if (chunks.length > 0) {
      return deliverRendered(adapter, address, chunks, { sessionId });
    }
    return { ok: true };
  }
  if (adapter.channelType === 'discord') {
    // Discord: native markdown, chunk at 2000 chars with fence repair
    const chunks = markdownToDiscordChunks(responseText, 2000);
    for (let i = 0; i < chunks.length; i++) {
      const result = await deliver(adapter, {
        address,
        text: chunks[i].text,
        parseMode: 'Markdown',
      }, { sessionId });
      if (!result.ok) return result;
    }
    return { ok: true };
  }
  if (adapter.channelType === 'feishu') {
    // Feishu: pass markdown through for adapter to format as post/card
    return deliver(adapter, {
      address,
      text: responseText,
      parseMode: 'Markdown',
    }, { sessionId });
  }
  // Generic fallback: deliver as plain text (deliver() handles chunking internally)
  return deliver(adapter, {
    address,
    text: responseText,
    parseMode: 'plain',
  }, { sessionId });
}

interface VoiceReplyCapableAdapter extends BaseChannelAdapter {
  sendFileAttachment?: (chatId: string, attachment: GeneratedVoiceReply) => Promise<SendResult>;
}

interface AdapterMeta {
  lastMessageAt: string | null;
  lastError: string | null;
}

interface BridgeManagerState {
  adapters: Map<string, BaseChannelAdapter>;
  adapterMeta: Map<string, AdapterMeta>;
  running: boolean;
  startedAt: string | null;
  loopAborts: Map<string, AbortController>;
  activeTasks: Map<string, AbortController>;
  /** Per-session processing chains for concurrency control */
  sessionLocks: Map<string, Promise<void>>;
  autoStartChecked: boolean;
}

type TaskStatus =
  | 'queued'
  | 'running'
  | 'waiting_permission'
  | 'interrupted'
  | 'timed_out'
  | 'failed'
  | 'completed'
  | 'aborted'
  | 'resumed';

interface TaskRecord {
  id: string;
  session_id: string;
  channel_type: string;
  chat_id: string;
  message_id: string;
  prompt_text: string;
  status: TaskStatus;
  created_at: string;
  updated_at: string;
  last_partial_text?: string;
  final_response_preview?: string;
  last_error?: string;
  diagnostic_path?: string;
  permission_request_id?: string;
  permission_tool_name?: string;
  resumed_from_task_id?: string;
}

interface TaskStore {
  createTask(input: {
    sessionId: string;
    channelType: string;
    chatId: string;
    messageId: string;
    promptText: string;
    sdkSessionIdAtStart?: string;
    resumedFromTaskId?: string;
  }): TaskRecord;
  updateTask(taskId: string, updates: Partial<TaskRecord>): TaskRecord | null;
  listTasks(filter?: {
    sessionId?: string;
    channelType?: string;
    chatId?: string;
    statuses?: TaskStatus[];
    limit?: number;
  }): TaskRecord[];
  getLatestResumableTask(channelType: string, chatId: string): TaskRecord | null;
  getSessionMeta?(sessionId: string): { [key: string]: unknown } | null;
}

function getState(): BridgeManagerState {
  const g = globalThis as unknown as Record<string, BridgeManagerState>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      adapters: new Map(),
      adapterMeta: new Map(),
      running: false,
      startedAt: null,
      loopAborts: new Map(),
      activeTasks: new Map(),
      sessionLocks: new Map(),
      autoStartChecked: false,
    };
  }
  // Backfill sessionLocks for states created before this field existed
  if (!g[GLOBAL_KEY].sessionLocks) {
    g[GLOBAL_KEY].sessionLocks = new Map();
  }
  return g[GLOBAL_KEY];
}

/**
 * Process a function with per-session serialization.
 * Different sessions run concurrently; same-session requests are serialized.
 */
function processWithSessionLock(sessionId: string, fn: () => Promise<void>): Promise<void> {
  const state = getState();
  const prev = state.sessionLocks.get(sessionId) || Promise.resolve();
  const current = prev.then(fn, fn);
  state.sessionLocks.set(sessionId, current);
  // Cleanup when the chain completes
  current.finally(() => {
    if (state.sessionLocks.get(sessionId) === current) {
      state.sessionLocks.delete(sessionId);
    }
  });
  return current;
}

function asTaskStore(store: unknown): TaskStore | null {
  const candidate = store as Partial<TaskStore>;
  if (
    typeof candidate.createTask === 'function'
    && typeof candidate.updateTask === 'function'
    && typeof candidate.listTasks === 'function'
    && typeof candidate.getLatestResumableTask === 'function'
  ) {
    return candidate as TaskStore;
  }
  return null;
}

function compactTaskText(value: string, maxLength = 180): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxLength) return collapsed;
  return `${collapsed.slice(0, maxLength - 3)}...`;
}

function formatTaskStatus(status: string): string {
  switch (status) {
    case 'running': return '运行中';
    case 'waiting_permission': return '等待权限';
    case 'interrupted': return '已中断';
    case 'timed_out': return '超时';
    case 'failed': return '失败';
    case 'completed': return '已完成';
    case 'aborted': return '已停止';
    case 'resumed': return '已恢复';
    default: return status || '未知';
  }
}

function buildResumePrompt(task: TaskRecord): string {
  const lines = [
    'Continue the previously interrupted bridge task.',
    'Treat this as a recovery run for the same user request.',
    'Avoid repeating work that is already clearly complete unless verification is necessary.',
    '',
    `Original user request: ${task.prompt_text}`,
  ];
  if (task.last_partial_text) {
    lines.push(`Last partial response: ${compactTaskText(task.last_partial_text, 600)}`);
  }
  if (task.last_error) {
    lines.push(`Interruption reason: ${task.last_error}`);
  }
  lines.push('If prior work may have partially succeeded, inspect the workspace before redoing actions.');
  return lines.join('\n');
}

function formatTaskList(tasks: TaskRecord[]): string {
  if (tasks.length === 0) {
    return 'No recent bridge tasks found.';
  }

  const lines = ['<b>Recent Tasks</b>', ''];
  for (const task of tasks) {
    lines.push(
      `• <code>${escapeHtml(task.id.slice(0, 8))}...</code> ${escapeHtml(formatTaskStatus(task.status))} ${escapeHtml(task.updated_at)}`,
    );
    lines.push(`  ${escapeHtml(compactTaskText(task.prompt_text, 120))}`);
  }
  return lines.join('\n');
}

function getLatestUserPromptFromMessages(messages: Array<{ role?: string; content?: string }>): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'user') continue;
    const content = typeof message.content === 'string' ? message.content.trim() : '';
    if (content) return content;
  }
  return null;
}

/**
 * Start the bridge system.
 * Checks feature flags, registers enabled adapters, starts polling loops.
 */
export async function start(): Promise<void> {
  const state = getState();
  if (state.running) return;

  const { store, lifecycle } = getBridgeContext();

  const bridgeEnabled = store.getSetting('remote_bridge_enabled') === 'true';
  if (!bridgeEnabled) {
    console.log('[bridge-manager] Bridge not enabled (remote_bridge_enabled != true)');
    return;
  }

  // Iterate all registered adapter types and create those that are enabled
  for (const channelType of getRegisteredTypes()) {
    const settingKey = `bridge_${channelType}_enabled`;
    if (store.getSetting(settingKey) !== 'true') continue;

    const adapter = createAdapter(channelType);
    if (!adapter) continue;

    const configError = adapter.validateConfig();
    if (!configError) {
      registerAdapter(adapter);
    } else {
      console.warn(`[bridge-manager] ${channelType} adapter not valid:`, configError);
    }
  }

  // Start all registered adapters, track how many succeeded
  let startedCount = 0;
  for (const [type, adapter] of state.adapters) {
    try {
      await adapter.start();
      console.log(`[bridge-manager] Started adapter: ${type}`);
      startedCount++;
    } catch (err) {
      console.error(`[bridge-manager] Failed to start adapter ${type}:`, err);
    }
  }

  // Only mark as running if at least one adapter started successfully
  if (startedCount === 0) {
    console.warn('[bridge-manager] No adapters started successfully, bridge not activated');
    state.adapters.clear();
    state.adapterMeta.clear();
    return;
  }

  // Mark running BEFORE starting consumer loops — runAdapterLoop checks
  // state.running in its while-condition, so it must be true first.
  state.running = true;
  state.startedAt = new Date().toISOString();

  // Notify host that bridge is starting (e.g., suppress competing polling)
  lifecycle.onBridgeStart?.();

  // Now start the consumer loops (state.running is already true)
  for (const [, adapter] of state.adapters) {
    if (adapter.isRunning()) {
      runAdapterLoop(adapter);
    }
  }

  console.log(`[bridge-manager] Bridge started with ${startedCount} adapter(s)`);
}

/**
 * Stop the bridge system gracefully.
 */
export async function stop(): Promise<void> {
  const state = getState();
  if (!state.running) return;

  const { lifecycle } = getBridgeContext();

  state.running = false;

  // Abort all event loops
  for (const [, abort] of state.loopAborts) {
    abort.abort();
  }
  state.loopAborts.clear();

  // Stop all adapters
  for (const [type, adapter] of state.adapters) {
    try {
      await adapter.stop();
      console.log(`[bridge-manager] Stopped adapter: ${type}`);
    } catch (err) {
      console.error(`[bridge-manager] Error stopping adapter ${type}:`, err);
    }
  }

  state.adapters.clear();
  state.adapterMeta.clear();
  state.startedAt = null;

  // Notify host that bridge stopped
  lifecycle.onBridgeStop?.();

  console.log('[bridge-manager] Bridge stopped');
}

/**
 * Lazy auto-start: checks bridge_auto_start setting once and starts if enabled.
 * Called from POST /api/bridge with action 'auto-start' (triggered by Electron on startup).
 */
export function tryAutoStart(): void {
  const state = getState();
  if (state.autoStartChecked) return;
  state.autoStartChecked = true;

  if (state.running) return;

  const { store } = getBridgeContext();
  const autoStart = store.getSetting('bridge_auto_start');
  if (autoStart !== 'true') return;

  start().catch(err => {
    console.error('[bridge-manager] Auto-start failed:', err);
  });
}

/**
 * Get the current bridge status.
 */
export function getStatus(): BridgeStatus {
  const state = getState();
  return {
    running: state.running,
    startedAt: state.startedAt,
    adapters: Array.from(state.adapters.entries()).map(([type, adapter]) => {
      const meta = state.adapterMeta.get(type);
      return {
        channelType: adapter.channelType,
        running: adapter.isRunning(),
        connectedAt: state.startedAt,
        lastMessageAt: meta?.lastMessageAt ?? null,
        error: meta?.lastError ?? null,
      };
    }),
  };
}

/**
 * Register a channel adapter.
 */
export function registerAdapter(adapter: BaseChannelAdapter): void {
  const state = getState();
  state.adapters.set(adapter.channelType, adapter);
}

/**
 * Run the event loop for a single adapter.
 * Messages for different sessions are dispatched concurrently;
 * messages for the same session are serialized via session locks.
 */
function runAdapterLoop(adapter: BaseChannelAdapter): void {
  const state = getState();
  const abort = new AbortController();
  state.loopAborts.set(adapter.channelType, abort);

  (async () => {
    while (state.running && adapter.isRunning()) {
      try {
        const msg = await adapter.consumeOne();
        if (!msg) continue; // Adapter stopped

        // Callback queries and commands are lightweight — process inline.
        // Regular messages use per-session locking for concurrency.
        if (msg.callbackData || msg.text.trim().startsWith('/')) {
          await handleMessage(adapter, msg);
        } else {
          const binding = router.resolve(msg.address);
          // Fire-and-forget into session lock — loop continues to accept
          // messages for other sessions immediately.
          processWithSessionLock(binding.codepilotSessionId, () =>
            handleMessage(adapter, msg),
          ).catch(err => {
            console.error(`[bridge-manager] Session ${binding.codepilotSessionId.slice(0, 8)} error:`, err);
          });
        }
      } catch (err) {
        if (abort.signal.aborted) break;
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[bridge-manager] Error in ${adapter.channelType} loop:`, err);
        // Track last error per adapter
        const meta = state.adapterMeta.get(adapter.channelType) || { lastMessageAt: null, lastError: null };
        meta.lastError = errMsg;
        state.adapterMeta.set(adapter.channelType, meta);
        // Brief delay to prevent tight error loops
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  })().catch(err => {
    if (!abort.signal.aborted) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[bridge-manager] ${adapter.channelType} loop crashed:`, err);
      const meta = state.adapterMeta.get(adapter.channelType) || { lastMessageAt: null, lastError: null };
      meta.lastError = errMsg;
      state.adapterMeta.set(adapter.channelType, meta);
    }
  });
}

async function executeBoundTask(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
  binding: ReturnType<typeof router.resolve>,
  input: {
    rawText: string;
    promptText: string;
    taskPromptText: string;
    resumedFromTaskId?: string;
  },
): Promise<void> {
  const { store } = getBridgeContext();
  const taskStore = asTaskStore(store);

  // Notify adapter that message processing is starting (e.g., typing indicator)
  adapter.onMessageStart?.(msg.address.chatId);

  // Create an AbortController so /stop can cancel this task externally
  const taskAbort = new AbortController();
  const state = getState();
  state.activeTasks.set(binding.codepilotSessionId, taskAbort);

  const task = taskStore?.createTask({
    sessionId: binding.codepilotSessionId,
    channelType: adapter.channelType,
    chatId: msg.address.chatId,
    messageId: msg.messageId,
    promptText: input.taskPromptText,
    sdkSessionIdAtStart: binding.sdkSessionId,
    resumedFromTaskId: input.resumedFromTaskId,
  }) || null;
  if (task) {
    taskStore?.updateTask(task.id, { status: 'running' });
  }

  // ── Streaming preview setup ──────────────────────────────────
  let previewState: StreamingPreviewState | null = null;
  const caps = adapter.getPreviewCapabilities?.(msg.address.chatId) ?? null;
  if (caps?.supported) {
    previewState = {
      draftId: generateDraftId(),
      chatId: msg.address.chatId,
      lastSentText: '',
      lastSentAt: 0,
      degraded: false,
      throttleTimer: null,
      pendingText: '',
    };
  }

  const streamCfg = previewState ? getStreamConfig(adapter.channelType) : null;

  const onPartialText = (previewState && streamCfg) ? (fullText: string) => {
    const ps = previewState!;
    const cfg = streamCfg!;
    if (ps.degraded) return;
    taskStore?.updateTask(task?.id || '', { last_partial_text: fullText });

    ps.pendingText = fullText.length > cfg.maxChars
      ? fullText.slice(0, cfg.maxChars) + '...'
      : fullText;

    const delta = ps.pendingText.length - ps.lastSentText.length;
    const elapsed = Date.now() - ps.lastSentAt;

    if (delta < cfg.minDeltaChars && ps.lastSentAt > 0) {
      if (!ps.throttleTimer) {
        ps.throttleTimer = setTimeout(() => {
          ps.throttleTimer = null;
          if (!ps.degraded) flushPreview(adapter, ps, cfg);
        }, cfg.intervalMs);
      }
      return;
    }

    if (elapsed < cfg.intervalMs && ps.lastSentAt > 0) {
      if (!ps.throttleTimer) {
        ps.throttleTimer = setTimeout(() => {
          ps.throttleTimer = null;
          if (!ps.degraded) flushPreview(adapter, ps, cfg);
        }, cfg.intervalMs - elapsed);
      }
      return;
    }

    if (ps.throttleTimer) {
      clearTimeout(ps.throttleTimer);
      ps.throttleTimer = null;
    }
    flushPreview(adapter, ps, cfg);
  } : undefined;

  const createDiagnosticSnapshot = (reason: string, extra?: Record<string, unknown>) => {
    const session = store.getSession(binding.codepilotSessionId);
    const sessionMeta = taskStore?.getSessionMeta?.(binding.codepilotSessionId) || null;
    const { messages } = store.getMessages(binding.codepilotSessionId, { limit: 6 });
    const filePath = writeTaskDiagnosticSnapshot({
      reason,
      sessionId: binding.codepilotSessionId,
      channelType: adapter.channelType,
      chatId: msg.address.chatId,
      messageId: msg.messageId,
      textPreview: input.rawText,
      binding: {
        id: binding.id,
        sdkSessionId: binding.sdkSessionId,
        workingDirectory: binding.workingDirectory,
        model: binding.model,
        mode: binding.mode,
      },
      session: session ? {
        providerId: session.provider_id,
        workingDirectory: session.working_directory,
        model: session.model,
      } : null,
      sessionMeta: sessionMeta as never,
      recentMessages: messages,
      extra,
    });
    if (filePath) {
      console.error(`[bridge-manager] Diagnostic snapshot written: ${filePath}`);
      taskStore?.updateTask(task?.id || '', { diagnostic_path: filePath });
    }
    return filePath;
  };

  let uiEnded = false;
  const endInFlightUi = () => {
    if (uiEnded) return;
    uiEnded = true;
    if (previewState) {
      if (previewState.throttleTimer) {
        clearTimeout(previewState.throttleTimer);
        previewState.throttleTimer = null;
      }
      adapter.endPreview?.(msg.address.chatId, previewState.draftId);
    }
    adapter.onMessageEnd?.(msg.address.chatId);
  };

  let watchdogTriggered = false;
  const watchdogMs = getTaskWatchdogMs();
  const watchdogTimer = setTimeout(() => {
    watchdogTriggered = true;
    const snapshotPath = createDiagnosticSnapshot('watchdog_timeout', {
      watchdogMs,
      previewActive: !!previewState,
      activeTaskKnown: state.activeTasks.has(binding.codepilotSessionId),
      taskId: task?.id,
    });
    console.error(
      `[bridge-manager] Task watchdog fired for session ${binding.codepilotSessionId.slice(0, 8)} after ${Math.round(watchdogMs / 1000)}s`,
    );
    store.insertAuditLog({
      channelType: adapter.channelType,
      chatId: msg.address.chatId,
      direction: 'inbound',
      messageId: msg.messageId,
      summary: `[WATCHDOG] Task aborted after ${Math.round(watchdogMs / 1000)}s${snapshotPath ? ` (${snapshotPath})` : ''}`,
    });
    store.setSessionRuntimeStatus(binding.codepilotSessionId, 'timed_out');
    taskStore?.updateTask(task?.id || '', {
      status: 'timed_out',
      last_error: `Task watchdog fired after ${Math.round(watchdogMs / 1000)}s`,
      diagnostic_path: snapshotPath || undefined,
    });
    state.activeTasks.delete(binding.codepilotSessionId);
    taskAbort.abort();
    endInFlightUi();
  }, watchdogMs);
  watchdogTimer.unref?.();

  try {
    const result = await engine.processMessage(binding, input.promptText, async (perm) => {
      taskStore?.updateTask(task?.id || '', {
        status: 'waiting_permission',
        permission_request_id: perm.permissionRequestId,
        permission_tool_name: perm.toolName,
      });
      await broker.forwardPermissionRequest(
        adapter,
        msg.address,
        perm.permissionRequestId,
        perm.toolName,
        perm.toolInput,
        binding.codepilotSessionId,
        perm.suggestions,
      );
    }, taskAbort.signal, msg.attachments && msg.attachments.length > 0 ? msg.attachments : undefined, onPartialText);

    if (result.responseText) {
      await deliverResponse(adapter, msg.address, result.responseText, binding.codepilotSessionId);
      if (wantsVoiceReply(input.rawText)) {
        const voiceReply = await prepareVoiceReply(result.responseText);
        console.log('[bridge-manager] Voice reply preparation status:', voiceReply.status);
        if (voiceReply.status === 'needs_config' || voiceReply.status === 'error') {
          await deliver(adapter, {
            address: msg.address,
            text: voiceReply.noteText,
            parseMode: 'plain',
          }, { sessionId: binding.codepilotSessionId });
        } else if (voiceReply.status === 'ready') {
          const voiceAdapter = adapter as VoiceReplyCapableAdapter;
          if (voiceAdapter.sendFileAttachment) {
            const audioSend = await voiceAdapter.sendFileAttachment(msg.address.chatId, voiceReply.attachment);
            console.log('[bridge-manager] Voice reply attachment send result:', audioSend.ok ? 'ok' : (audioSend.error || 'error'));
            if (!audioSend.ok && audioSend.error) {
              await deliver(adapter, {
                address: msg.address,
                text: `语音回复生成成功，但发送失败：${audioSend.error}`,
                parseMode: 'plain',
              }, { sessionId: binding.codepilotSessionId });
            }
          } else {
            await deliver(adapter, {
              address: msg.address,
              text: '当前频道暂不支持桥接层语音附件回传。请继续使用文字回复，或改在支持附件发送的频道中使用。',
              parseMode: 'plain',
            }, { sessionId: binding.codepilotSessionId });
          }
        }
      }
    } else if (result.hasError) {
      const errorResponse: OutboundMessage = {
        address: msg.address,
        text: `<b>Error:</b> ${escapeHtml(result.errorMessage)}`,
        parseMode: 'HTML',
      };
      await deliver(adapter, errorResponse);
    }

    if (binding.id) {
      try {
        if (result.sdkSessionId) {
          store.updateChannelBinding(binding.id, { sdkSessionId: result.sdkSessionId });
        } else if (result.hasError && binding.sdkSessionId) {
          store.updateChannelBinding(binding.id, { sdkSessionId: '' });
        }
      } catch { /* best effort */ }
    }

    if (result.hasError) {
      taskStore?.updateTask(task?.id || '', {
        status: 'failed',
        last_error: result.errorMessage,
        sdk_session_id_at_end: result.sdkSessionId || binding.sdkSessionId,
        final_response_preview: result.responseText ? compactTaskText(result.responseText, 500) : undefined,
      });
    } else {
      taskStore?.updateTask(task?.id || '', {
        status: 'completed',
        completed_at: new Date().toISOString(),
        sdk_session_id_at_end: result.sdkSessionId || binding.sdkSessionId,
        final_response_preview: result.responseText ? compactTaskText(result.responseText, 500) : undefined,
      });
      if (input.resumedFromTaskId) {
        taskStore?.updateTask(input.resumedFromTaskId, { status: 'resumed' });
      }
    }
  } catch (err) {
    const snapshotPath = createDiagnosticSnapshot('task_exception', {
      error: err instanceof Error ? err.message : String(err),
      watchdogTriggered,
      aborted: taskAbort.signal.aborted,
      taskId: task?.id,
    });
    const status: TaskStatus = watchdogTriggered
      ? 'timed_out'
      : taskAbort.signal.aborted
        ? 'aborted'
        : 'interrupted';
    taskStore?.updateTask(task?.id || '', {
      status,
      last_error: err instanceof Error ? err.message : String(err),
      diagnostic_path: snapshotPath || undefined,
    });
    store.insertAuditLog({
      channelType: adapter.channelType,
      chatId: msg.address.chatId,
      direction: 'inbound',
      messageId: msg.messageId,
      summary: `[TASK_ERROR] ${err instanceof Error ? err.message : String(err)}${snapshotPath ? ` (${snapshotPath})` : ''}`,
    });
    throw err;
  } finally {
    clearTimeout(watchdogTimer);
    state.activeTasks.delete(binding.codepilotSessionId);
    if (!watchdogTriggered) {
      endInFlightUi();
    }
  }
}

/**
 * Handle a single inbound message.
 */
async function handleMessage(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
): Promise<void> {
  const { store } = getBridgeContext();

  // Update lastMessageAt for this adapter
  const adapterState = getState();
  const meta = adapterState.adapterMeta.get(adapter.channelType) || { lastMessageAt: null, lastError: null };
  meta.lastMessageAt = new Date().toISOString();
  adapterState.adapterMeta.set(adapter.channelType, meta);

  // Acknowledge the update offset after processing completes (or fails).
  // This ensures the adapter only advances its committed offset once the
  // message has been fully handled, preventing message loss on crash.
  const ack = () => {
    if (msg.updateId != null && adapter.acknowledgeUpdate) {
      adapter.acknowledgeUpdate(msg.updateId);
    }
  };

  // Handle callback queries (permission buttons)
  if (msg.callbackData) {
    const handled = broker.handlePermissionCallback(msg.callbackData, msg.address.chatId, msg.callbackMessageId);
    if (handled) {
      // Send confirmation
      const confirmMsg: OutboundMessage = {
        address: msg.address,
        text: 'Permission response recorded.',
        parseMode: 'plain',
      };
      await deliver(adapter, confirmMsg);
    }
    ack();
    return;
  }

  const rawText = msg.text.trim();
  const hasAttachments = msg.attachments && msg.attachments.length > 0;
  const voiceReplyRequested = wantsVoiceReply(rawText);
  if (voiceReplyRequested) {
    console.log('[bridge-manager] Voice reply requested for chat:', msg.address.chatId);
  }
  if (!rawText && !hasAttachments) { ack(); return; }

  // Check for IM commands (before sanitization — commands are validated individually)
  if (rawText.startsWith('/')) {
    await handleCommand(adapter, msg, rawText);
    ack();
    return;
  }

  // Sanitize general message text before routing to conversation engine
  const { text, truncated } = sanitizeInput(rawText);
  if (truncated) {
    console.warn(`[bridge-manager] Input truncated from ${rawText.length} to ${text.length} chars for chat ${msg.address.chatId}`);
    store.insertAuditLog({
      channelType: adapter.channelType,
      chatId: msg.address.chatId,
      direction: 'inbound',
      messageId: msg.messageId,
      summary: `[TRUNCATED] Input truncated from ${rawText.length} chars`,
    });
  }

  if (!text && !hasAttachments) { ack(); return; }

  // Regular message — route to conversation engine
  const binding = router.resolve(msg.address);
  const senderTag = msg.address.userId ? `[sender: ${msg.address.userId}]` : '';
  const baseText = text || (hasAttachments ? 'Describe this image.' : '');
  const promptText = senderTag ? `${senderTag}\n${baseText}` : baseText;

  try {
    await executeBoundTask(adapter, msg, binding, {
      rawText,
      promptText,
      taskPromptText: text || rawText,
    });
  } finally {
    ack();
  }
}

/**
 * Handle IM slash commands.
 */
async function handleCommand(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
  text: string,
): Promise<void> {
  const { store } = getBridgeContext();

  // Extract command and args (handle /command@botname format)
  const parts = text.split(/\s+/);
  const command = parts[0].split('@')[0].toLowerCase();
  const args = parts.slice(1).join(' ').trim();

  // Run dangerous-input detection on the full command text
  const dangerCheck = isDangerousInput(text);
  if (dangerCheck.dangerous) {
    store.insertAuditLog({
      channelType: adapter.channelType,
      chatId: msg.address.chatId,
      direction: 'inbound',
      messageId: msg.messageId,
      summary: `[BLOCKED] Dangerous input detected: ${dangerCheck.reason}`,
    });
    console.warn(`[bridge-manager] Blocked dangerous command input from chat ${msg.address.chatId}: ${dangerCheck.reason}`);
    await deliver(adapter, {
      address: msg.address,
      text: `Command rejected: invalid input detected.`,
      parseMode: 'plain',
    });
    return;
  }

  let response = '';

  const customCommandResponse = await tryHandleSessionManagementCommand({
    command,
    args,
    address: msg.address,
  });
  if (customCommandResponse !== null) {
    response = customCommandResponse;
  }

  switch (command) {
    case '/start':
      if (!response) response = [
        '<b>CodePilot Bridge</b>',
        '',
        'Send any message to interact with Claude.',
        '',
        '<b>Commands:</b>',
        '/new [path] - Start new session',
        '/bind &lt;session_id&gt; - Bind to existing session',
        '/cwd /path - Change working directory',
        '/mode plan|code|ask - Change mode',
        '/status - Show current status',
        '/tasks - List recent bridge tasks',
        '/resume_last - Resume the latest interrupted task',
        '/sessions - List recent sessions',
        '/lsessions [--all] - List bridge sessions',
        '/switchto &lt;session_id|name&gt; - Switch current chat to a session',
        '/rename &lt;new_name&gt; - Rename current session',
        '/archive [session_id|name] - Archive a session with summary',
        '/unarchive &lt;session_id|name&gt; - Restore archived session',
        '/stop - Stop current session',
        '/perm allow|allow_session|deny &lt;id&gt; - Respond to permission',
        '/help - Show this help',
      ].join('\n');
      break;

    case '/new': {
      let workDir: string | undefined;
      if (args) {
        const validated = validateWorkingDirectory(args);
        if (!validated) {
          response = 'Invalid path. Must be an absolute path without traversal sequences.';
          break;
        }
        workDir = validated;
      }
      const binding = router.createBinding(msg.address, workDir);
      response = `New session created.\nSession: <code>${binding.codepilotSessionId.slice(0, 8)}...</code>\nCWD: <code>${escapeHtml(binding.workingDirectory || '~')}</code>`;
      break;
    }

    case '/bind': {
      if (!args) {
        response = 'Usage: /bind &lt;session_id&gt;';
        break;
      }
      if (!validateSessionId(args)) {
        response = 'Invalid session ID format. Expected a 32-64 character hex/UUID string.';
        break;
      }
      const binding = router.bindToSession(msg.address, args);
      if (binding) {
        response = `Bound to session <code>${args.slice(0, 8)}...</code>`;
      } else {
        response = 'Session not found.';
      }
      break;
    }

    case '/cwd': {
      if (!args) {
        response = 'Usage: /cwd /path/to/directory';
        break;
      }
      const validatedPath = validateWorkingDirectory(args);
      if (!validatedPath) {
        response = 'Invalid path. Must be an absolute path without traversal sequences or special characters.';
        break;
      }
      const binding = router.resolve(msg.address);
      router.updateBinding(binding.id, { workingDirectory: validatedPath });
      response = `Working directory set to <code>${escapeHtml(validatedPath)}</code>`;
      break;
    }

    case '/mode': {
      if (!validateMode(args)) {
        response = 'Usage: /mode plan|code|ask';
        break;
      }
      const binding = router.resolve(msg.address);
      router.updateBinding(binding.id, { mode: args });
      response = `Mode set to <b>${args}</b>`;
      break;
    }

    case '/status': {
      const binding = router.resolve(msg.address);
      const currentRecord = 'listSessionRecords' in store
        ? (store as { listSessionRecords: () => Array<{ session: { id: string }; meta: { runtime_status?: string } }> })
          .listSessionRecords()
          .find((record) => record.session.id === binding.codepilotSessionId)
        : null;
      response = [
        '<b>Bridge Status</b>',
        '',
        `Session: <code>${binding.codepilotSessionId.slice(0, 8)}...</code>`,
        `CWD: <code>${escapeHtml(binding.workingDirectory || '~')}</code>`,
        `Mode: <b>${binding.mode}</b>`,
        `Model: <code>${binding.model || 'default'}</code>`,
        `Runtime: <b>${escapeHtml(currentRecord?.meta.runtime_status || 'idle')}</b>`,
      ].join('\n');
      break;
    }

    case '/tasks': {
      const taskStore = asTaskStore(store);
      if (!taskStore) {
        response = 'Task persistence is not available in the current store.';
        break;
      }
      response = formatTaskList(taskStore.listTasks({
        channelType: adapter.channelType,
        chatId: msg.address.chatId,
        limit: 5,
      }));
      break;
    }

    case '/resume_last': {
      const taskStore = asTaskStore(store);
      const binding = router.resolve(msg.address);
      const task = taskStore?.getLatestResumableTask(adapter.channelType, msg.address.chatId) ?? null;

      if (task) {
        const syntheticMessage: InboundMessage = {
          ...msg,
          messageId: `resume:${task.id}:${Date.now()}`,
          text: task.prompt_text,
          timestamp: Date.now(),
          callbackData: undefined,
          callbackMessageId: undefined,
        };

        await deliver(adapter, {
          address: msg.address,
          text: `Resuming task <code>${escapeHtml(task.id.slice(0, 8))}...</code>.`,
          parseMode: 'HTML',
        });

        await executeBoundTask(adapter, syntheticMessage, binding, {
          rawText: task.prompt_text,
          promptText: buildResumePrompt(task),
          taskPromptText: task.prompt_text,
          resumedFromTaskId: task.id,
        });
        return;
      }

      const sessionMessages = store.getMessages(binding.codepilotSessionId, { limit: 20 }).messages as Array<{ role?: string; content?: string }>;
      const fallbackPrompt = getLatestUserPromptFromMessages(sessionMessages);
      if (!fallbackPrompt) {
        response = 'No interrupted task is available to resume.';
        break;
      }

      const syntheticMessage: InboundMessage = {
        ...msg,
        messageId: `resume-history:${binding.codepilotSessionId}:${Date.now()}`,
        text: fallbackPrompt,
        timestamp: Date.now(),
        callbackData: undefined,
        callbackMessageId: undefined,
      };

      await deliver(adapter, {
        address: msg.address,
        text: 'No persisted interrupted task was found. Resuming from the latest user request in this session history.',
        parseMode: 'plain',
      });

      await executeBoundTask(adapter, syntheticMessage, binding, {
        rawText: fallbackPrompt,
        promptText: [
          'Continue the latest user request from this session history.',
          'Treat this as a recovery run after the previous attempt did not complete.',
          `Original user request: ${fallbackPrompt}`,
          'Inspect the workspace and prior conversation state before repeating any actions.',
        ].join('\n'),
        taskPromptText: fallbackPrompt,
      });
      return;
    }

    case '/sessions': {
      const bindings = router.listBindings(adapter.channelType);
      if (bindings.length === 0) {
        response = 'No sessions found.';
      } else {
        const lines = ['<b>Sessions:</b>', ''];
        for (const b of bindings.slice(0, 10)) {
          const active = b.active ? 'active' : 'inactive';
          lines.push(`<code>${b.codepilotSessionId.slice(0, 8)}...</code> [${active}] ${escapeHtml(b.workingDirectory || '~')}`);
        }
        response = lines.join('\n');
      }
      break;
    }

    case '/stop': {
      const binding = router.resolve(msg.address);
      const st = getState();
      const taskAbort = st.activeTasks.get(binding.codepilotSessionId);
      if (taskAbort) {
        store.setSessionRuntimeStatus(binding.codepilotSessionId, 'stopping');
        taskAbort.abort();
        st.activeTasks.delete(binding.codepilotSessionId);
        response = 'Stopping current task...';
      } else {
        response = 'No task is currently running.';
      }
      break;
    }

    case '/perm': {
      // Text-based permission approval fallback (for channels without inline buttons)
      // Usage: /perm allow <id> | /perm allow_session <id> | /perm deny <id>
      const permParts = args.split(/\s+/);
      const permAction = permParts[0];
      const permId = permParts.slice(1).join(' ');
      if (!permAction || !permId || !['allow', 'allow_session', 'deny'].includes(permAction)) {
        response = 'Usage: /perm allow|allow_session|deny &lt;permission_id&gt;';
        break;
      }
      const callbackData = `perm:${permAction}:${permId}`;
      const handled = broker.handlePermissionCallback(callbackData, msg.address.chatId);
      if (handled) {
        response = `Permission ${permAction}: recorded.`;
      } else {
        response = `Permission not found or already resolved.`;
      }
      break;
    }

    case '/help':
      if (!response) response = [
        '<b>CodePilot Bridge Commands</b>',
        '',
        '/new [path] - Start new session',
        '/bind &lt;session_id&gt; - Bind to existing session',
        '/cwd /path - Change working directory',
        '/mode plan|code|ask - Change mode',
        '/status - Show current status',
        '/tasks - List recent bridge tasks',
        '/resume_last - Resume the latest interrupted task',
        '/sessions - List recent sessions',
        '/lsessions [--all] - List bridge sessions',
        '/switchto &lt;session_id|name&gt; - Switch current chat to a session',
        '/rename &lt;new_name&gt; - Rename current session',
        '/archive [session_id|name] - Archive a session with summary',
        '/unarchive &lt;session_id|name&gt; - Restore archived session',
        '/stop - Stop current session',
        '/perm allow|allow_session|deny &lt;id&gt; - Respond to permission request',
        '/help - Show this help',
      ].join('\n');
      break;

    default:
      if (!response) {
        response = `Unknown command: ${escapeHtml(command)}\nType /help for available commands.`;
      }
  }

  if (response) {
    await deliver(adapter, {
      address: msg.address,
      text: response,
      parseMode: 'HTML',
    });
  }
}
