import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { CTI_HOME } from './config.js';
import type { SessionMeta } from './store.js';

const RUNTIME_DIR = path.join(CTI_HOME, 'runtime');
const DIAGNOSTICS_DIR = path.join(RUNTIME_DIR, 'diagnostics');

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
  sessionMeta?: SessionMeta | null;
  recentMessages?: Array<{ role: string; content: string }>;
  extra?: Record<string, unknown>;
}

function compactText(value: string, maxLength = 240): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxLength) return collapsed;
  return `${collapsed.slice(0, maxLength - 3)}...`;
}

function getProcessSnapshot(): string[] {
  try {
    const output = execFileSync(
      'ps',
      ['-axo', 'pid,ppid,etime,%cpu,%mem,stat,command'],
      { encoding: 'utf-8' },
    );
    return output
      .split('\n')
      .filter((line) => /daemon\.mjs|codex|discord|feishu/i.test(line))
      .slice(0, 40);
  } catch {
    return [];
  }
}

export function writeTaskDiagnosticSnapshot(input: TaskDiagnosticSnapshotInput): string | null {
  try {
    fs.mkdirSync(DIAGNOSTICS_DIR, { recursive: true });
    const timestamp = new Date().toISOString();
    const safeReason = input.reason.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40) || 'unknown';
    const fileName = `${timestamp.replace(/[:.]/g, '-')}-${safeReason}-${input.sessionId.slice(0, 8)}.json`;
    const filePath = path.join(DIAGNOSTICS_DIR, fileName);

    const payload = {
      timestamp,
      pid: process.pid,
      reason: input.reason,
      sessionId: input.sessionId,
      channelType: input.channelType,
      chatId: input.chatId,
      messageId: input.messageId,
      textPreview: compactText(input.textPreview),
      binding: input.binding,
      session: input.session || null,
      sessionMeta: input.sessionMeta || null,
      recentMessages: (input.recentMessages || []).slice(-6).map((message) => ({
        role: message.role,
        content: compactText(message.content, 400),
      })),
      processSnapshot: getProcessSnapshot(),
      extra: input.extra || {},
    };

    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf-8');
    return filePath;
  } catch (err) {
    console.error(
      '[diagnostics] Failed to write task snapshot:',
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}
