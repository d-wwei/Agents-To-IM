import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { initBridgeContext } from '../bridge-runtime.js';
import { CTI_HOME } from '../config.js';
import { JsonFileStore } from '../store.js';
import { tryHandleSessionManagementCommand } from '../session-command-support.js';

const DATA_DIR = path.join(CTI_HOME, 'data');

function makeSettings(): Map<string, string> {
  return new Map([
    ['remote_bridge_enabled', 'true'],
    ['bridge_default_work_dir', '/tmp/test-cwd'],
    ['bridge_default_model', 'test-model'],
    ['bridge_default_mode', 'code'],
  ]);
}

function initTestContext() {
  const store = new JsonFileStore(makeSettings());
  initBridgeContext({
    store,
    llm: { streamChat: () => new ReadableStream() },
    permissions: { resolvePendingPermission: () => false },
    lifecycle: {},
  });
  return store;
}

const address = {
  channelType: 'feishu' as const,
  chatId: 'oc_test_chat',
  userId: 'ou_test_user',
  displayName: 'Eli',
};

describe('session-command-support', { concurrency: false }, () => {
  beforeEach(() => {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    delete (globalThis as Record<string, unknown>).__bridge_context__;
  });

  it('lists bridge sessions with /lsessions', async () => {
    const store = initTestContext();
    const session = store.createSession('Bridge: Eli', 'test-model', undefined, '/tmp/test-cwd');
    store.setSessionName(session.id, '周报整理');
    store.upsertChannelBinding({
      channelType: 'feishu',
      chatId: address.chatId,
      codepilotSessionId: session.id,
      workingDirectory: '/tmp/test-cwd',
      model: 'test-model',
    });
    store.addMessage(session.id, 'user', '整理周报');

    const response = await tryHandleSessionManagementCommand({
      command: '/lsessions',
      args: '',
      address,
    });

    assert.match(response || '', /周报整理/);
    assert.match(response || '', /Bridge Sessions/);
  });

  it('renames and switches sessions by name', async () => {
    const store = initTestContext();
    const current = store.createSession('Bridge: Eli', 'test-model', undefined, '/tmp/current');
    store.upsertChannelBinding({
      channelType: 'feishu',
      chatId: address.chatId,
      codepilotSessionId: current.id,
      workingDirectory: '/tmp/current',
      model: 'test-model',
    });

    const oldTask = store.createSession('Old Task', 'test-model', undefined, '/tmp/old');
    store.setSessionName(oldTask.id, '周报整理');
    store.addMessage(oldTask.id, 'user', '本周周报整理');

    const renameResponse = await tryHandleSessionManagementCommand({
      command: '/rename',
      args: '当前任务',
      address,
    });
    assert.match(renameResponse || '', /当前任务/);

    const switchResponse = await tryHandleSessionManagementCommand({
      command: '/switchto',
      args: '周报整理',
      address,
    });
    assert.match(switchResponse || '', /已切换到/);

    const binding = store.getChannelBinding('feishu', address.chatId);
    assert.equal(binding?.codepilotSessionId, oldTask.id);
  });

  it('archives current session and creates a replacement binding', async () => {
    const store = initTestContext();
    const current = store.createSession('Bridge: Eli', 'test-model', undefined, '/tmp/current');
    store.setSessionName(current.id, '周报整理');
    store.upsertChannelBinding({
      channelType: 'feishu',
      chatId: address.chatId,
      codepilotSessionId: current.id,
      workingDirectory: '/tmp/current',
      model: 'test-model',
    });
    store.addMessage(current.id, 'user', '整理周报');
    store.addMessage(current.id, 'assistant', '已整理出周报初稿');

    const archiveResponse = await tryHandleSessionManagementCommand({
      command: '/archive',
      args: '',
      address,
    });

    assert.match(archiveResponse || '', /已归档/);
    assert.equal(store.getSessionMeta(current.id)?.archived, true);

    const binding = store.getChannelBinding('feishu', address.chatId);
    assert.ok(binding);
    assert.notEqual(binding?.codepilotSessionId, current.id);
  });
});
