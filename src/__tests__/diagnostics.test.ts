import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { writeTaskDiagnosticSnapshot } from '../diagnostics.js';
import { CTI_HOME } from '../config.js';

const DIAGNOSTICS_DIR = path.join(CTI_HOME, 'runtime', 'diagnostics');

describe('diagnostics', { concurrency: false }, () => {
  beforeEach(() => {
    fs.rmSync(DIAGNOSTICS_DIR, { recursive: true, force: true });
  });

  it('writes a task diagnostic snapshot to runtime/diagnostics', () => {
    const snapshotPath = writeTaskDiagnosticSnapshot({
      reason: 'watchdog_timeout',
      sessionId: 'session-12345678',
      channelType: 'discord',
      chatId: 'chat-1',
      messageId: 'msg-1',
      textPreview: 'please inspect this task timeout',
      binding: {
        id: 'binding-1',
        sdkSessionId: 'sdk-1',
        workingDirectory: '/tmp/demo',
        model: 'gpt-5',
        mode: 'code',
      },
      session: {
        providerId: 'env',
        workingDirectory: '/tmp/demo',
        model: 'gpt-5',
      },
      sessionMeta: {
        runtime_status: 'timed_out',
      },
      recentMessages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'second' },
      ],
      extra: {
        watchdogMs: 1000,
      },
    });

    assert.ok(snapshotPath);
    assert.ok(fs.existsSync(snapshotPath!));

    const parsed = JSON.parse(fs.readFileSync(snapshotPath!, 'utf-8')) as {
      reason: string;
      sessionId: string;
      channelType: string;
      recentMessages: Array<{ role: string; content: string }>;
      extra: { watchdogMs: number };
    };

    assert.equal(parsed.reason, 'watchdog_timeout');
    assert.equal(parsed.sessionId, 'session-12345678');
    assert.equal(parsed.channelType, 'discord');
    assert.equal(parsed.recentMessages.length, 2);
    assert.equal(parsed.extra.watchdogMs, 1000);
  });
});
