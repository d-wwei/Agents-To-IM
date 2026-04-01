/**
 * Bridge Extensions — optional hook registry for skill-layer features.
 *
 * The core bridge package is independently buildable and has no dependency
 * on the parent skill's source. Features that live in the skill layer
 * (session management commands, voice reply, diagnostics) register their
 * implementations here at startup time. The bridge-manager calls these
 * hooks via optional chaining — if a hook is not registered, the feature
 * is simply unavailable.
 */

import type { ChannelAddress } from './types.js';

// ── Voice reply types ────────────────────────────────────────────

export interface GeneratedVoiceReply {
  fileName: string;
  mimeType: string;
  data: Buffer;
}

export type VoiceReplyResult =
  | { status: 'skipped' }
  | { status: 'needs_config'; noteText: string }
  | { status: 'ready'; attachment: GeneratedVoiceReply }
  | { status: 'error'; noteText: string };

// ── Diagnostic snapshot types ────────────────────────────────────

export interface TaskDiagnosticSnapshotInput {
  reason: string;
  sessionId: string;
  channelType: string;
  chatId: string;
  messageId: string;
  textPreview: string;
  binding: {
    id?: string;
    sdkSessionId?: string;
    workingDirectory?: string;
    model?: string;
    mode?: string;
  };
  session?: {
    providerId?: string;
    workingDirectory?: string;
    model?: string;
  } | null;
  sessionMeta?: unknown;
  recentMessages?: unknown[];
  extra?: Record<string, unknown>;
}

// ── Extension hooks interface ────────────────────────────────────

export interface BridgeExtensions {
  /**
   * Handle session management commands (/sessions, /lsessions, /switchto, etc.).
   * Returns a response string if handled, or null to fall through to default handling.
   */
  tryHandleSessionManagementCommand?(input: {
    command: string;
    args: string;
    address: ChannelAddress;
  }): Promise<string | null>;

  /** Check if the user's message requests a voice reply. */
  wantsVoiceReply?(text: string): boolean;

  /** Generate a voice reply for the given response text. */
  prepareVoiceReply?(text: string): Promise<VoiceReplyResult>;

  /** Write a diagnostic snapshot for debugging. Returns the file path or null. */
  writeTaskDiagnosticSnapshot?(input: TaskDiagnosticSnapshotInput): string | null;
}

// ── Registry (singleton via globalThis) ──────────────────────────

const EXTENSIONS_KEY = '__bridge_extensions__';

/**
 * Register skill-layer extension hooks. Call this once at startup before
 * the bridge manager processes any messages.
 */
export function registerBridgeExtensions(ext: BridgeExtensions): void {
  (globalThis as Record<string, unknown>)[EXTENSIONS_KEY] = ext;
}

/**
 * Retrieve the registered extension hooks (or an empty object if none registered).
 */
export function getBridgeExtensions(): BridgeExtensions {
  return ((globalThis as Record<string, unknown>)[EXTENSIONS_KEY] as BridgeExtensions) || {};
}
