import type { BridgeStore, BridgeSession } from 'agent-to-im-core/dist/lib/bridge/host.js';
import type { ChannelAddress, ChannelBinding } from 'agent-to-im-core/dist/lib/bridge/types.js';
import { router, getBridgeContext, escapeHtml } from './bridge-runtime.js';
import type { SessionMeta, SessionRecord } from './store.js';

interface ExtendedStore extends BridgeStore {
  listSessionRecords(): SessionRecord[];
  setSessionName(sessionId: string, name: string): void;
  archiveSession(sessionId: string, summary: string): void;
  unarchiveSession(sessionId: string): void;
  touchSession(sessionId: string, updates?: { channelType?: string; chatId?: string }): void;
}

interface SessionCandidate {
  record: SessionRecord;
  reason: 'id' | 'id_prefix' | 'name_exact' | 'name_contains';
}

function asExtendedStore(store: BridgeStore): ExtendedStore | null {
  const candidate = store as Partial<ExtendedStore>;
  if (
    typeof candidate.listSessionRecords === 'function'
    && typeof candidate.setSessionName === 'function'
    && typeof candidate.archiveSession === 'function'
    && typeof candidate.unarchiveSession === 'function'
    && typeof candidate.touchSession === 'function'
  ) {
    return candidate as ExtendedStore;
  }
  return null;
}

function channelLabel(value?: string): string {
  switch ((value || '').toLowerCase()) {
    case 'discord':
      return 'Discord';
    case 'feishu':
      return 'Feishu';
    case 'telegram':
      return 'Telegram';
    default:
      return value || 'Unknown';
  }
}

function displayName(record: SessionRecord): string {
  const name = record.meta.name?.trim();
  return name || '未命名';
}

function shortSessionId(sessionId: string): string {
  return sessionId.slice(0, 8);
}

function formatTimestamp(value?: string): string {
  if (!value) return 'unknown';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString().replace('T', ' ').slice(0, 16);
}

function compactText(value: string, maxLength = 96): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxLength) return collapsed;
  return `${collapsed.slice(0, maxLength - 3)}...`;
}

function summaryFromMessages(messages: Array<{ role: string; content: string }>): string {
  const meaningful = messages
    .map((message) => message.content.trim())
    .filter((content) => content && !content.startsWith('/'));
  if (meaningful.length === 0) {
    return '信息不足，建议打开会话查看详情。';
  }
  const goal = meaningful.find((content) => content.length > 3) || meaningful[0];
  const latest = meaningful[meaningful.length - 1];
  if (goal === latest) {
    return `目标/近况: ${compactText(goal)}`;
  }
  return `目标: ${compactText(goal)}\n近况: ${compactText(latest)}`;
}

function sessionSummary(store: BridgeStore, record: SessionRecord): string {
  if (record.meta.archive_summary?.trim()) {
    return record.meta.archive_summary.trim();
  }
  const { messages } = store.getMessages(record.session.id, { limit: 20 });
  return summaryFromMessages(messages);
}

function statusLabel(record: SessionRecord): string {
  if (record.meta.archived) return '已归档';
  switch ((record.meta.runtime_status || '').toLowerCase()) {
    case 'running':
      return '运行中';
    case 'timed_out':
      return '超时中断';
    case 'stopping':
      return '停止中';
    case 'error':
      return '异常';
    case 'idle':
      return '空闲';
    default:
      return '活跃';
  }
}

function sessionChannel(record: SessionRecord): string {
  const binding = record.bindings[0];
  return channelLabel(record.meta.last_channel_type || binding?.channelType);
}

function listCandidates(records: SessionRecord[], query: string): SessionCandidate[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];

  const exactId = records.find((record) => record.session.id.toLowerCase() === needle);
  if (exactId) return [{ record: exactId, reason: 'id' }];

  const idPrefixMatches = records.filter((record) => record.session.id.toLowerCase().startsWith(needle));
  if (idPrefixMatches.length > 0) {
    return idPrefixMatches.map((record) => ({ record, reason: 'id_prefix' as const }));
  }

  const exactNameMatches = records.filter(
    (record) => (record.meta.name || '').trim().toLowerCase() === needle,
  );
  if (exactNameMatches.length > 0) {
    return exactNameMatches.map((record) => ({ record, reason: 'name_exact' as const }));
  }

  const containsMatches = records.filter(
    (record) => (record.meta.name || '').trim().toLowerCase().includes(needle),
  );
  return containsMatches.map((record) => ({ record, reason: 'name_contains' as const }));
}

function formatSessionLine(record: SessionRecord, summary: string, currentSessionId?: string): string {
  const current = record.session.id === currentSessionId ? ' <b>[current]</b>' : '';
  return [
    `<b>${escapeHtml(displayName(record))}</b>${current} | <code>${escapeHtml(shortSessionId(record.session.id))}</code> | ${escapeHtml(sessionChannel(record))} | ${escapeHtml(statusLabel(record))} | ${escapeHtml(formatTimestamp(record.meta.last_active_at || record.meta.created_at))}`,
    `${escapeHtml(compactText(summary, 140))}`,
  ].join('\n');
}

function buildArchiveSummary(store: BridgeStore, record: SessionRecord): string {
  const { messages } = store.getMessages(record.session.id, { limit: 30 });
  return summaryFromMessages(messages);
}

function currentBinding(address: ChannelAddress): ChannelBinding {
  return router.resolve(address);
}

function getCurrentRecord(store: ExtendedStore, address: ChannelAddress): SessionRecord | null {
  const binding = currentBinding(address);
  return store.listSessionRecords().find((record) => record.session.id === binding.codepilotSessionId) ?? null;
}

function sortRecords(records: SessionRecord[]): SessionRecord[] {
  return [...records].sort((left, right) => {
    const leftTime = left.meta.last_active_at || left.meta.created_at || '';
    const rightTime = right.meta.last_active_at || right.meta.created_at || '';
    return rightTime.localeCompare(leftTime);
  });
}

function resolveSessionOrCandidates(
  store: ExtendedStore,
  query: string,
): { record?: SessionRecord; candidates?: SessionCandidate[] } {
  const candidates = listCandidates(store.listSessionRecords(), query);
  if (candidates.length === 1) {
    return { record: candidates[0].record };
  }
  if (candidates.length > 1) {
    return { candidates };
  }
  return {};
}

function formatCandidateList(store: BridgeStore, candidates: SessionCandidate[]): string {
  const lines = ['找到多个候选，请改用更完整的 session id 或名称：', ''];
  for (const candidate of candidates.slice(0, 8)) {
    lines.push(formatSessionLine(candidate.record, sessionSummary(store, candidate.record)));
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

function bindingSessionSdkId(session: BridgeSession): string {
  const value = (session as unknown as Record<string, unknown>).sdk_session_id;
  return typeof value === 'string' ? value : '';
}

export async function tryHandleSessionManagementCommand(input: {
  command: string;
  args: string;
  address: ChannelAddress;
}): Promise<string | null> {
  const { store } = getBridgeContext();
  const extendedStore = asExtendedStore(store);
  if (!extendedStore) return null;

  const command = input.command.toLowerCase();
  const args = input.args.trim();

  if (!['/lsessions', '/switchto', '/rename', '/archive', '/unarchive'].includes(command)) {
    return null;
  }

  if (command === '/lsessions') {
    const showAll = args.includes('--all');
    const current = currentBinding(input.address);
    const records = sortRecords(extendedStore.listSessionRecords())
      .filter((record) => showAll || !record.meta.archived);
    if (records.length === 0) {
      return showAll ? '没有可显示的会话。' : '没有活跃会话。';
    }
    const lines = ['<b>Bridge Sessions</b>', ''];
    for (const record of records.slice(0, 20)) {
      lines.push(formatSessionLine(record, sessionSummary(store, record), current.codepilotSessionId));
      lines.push('');
    }
    return lines.join('\n').trimEnd();
  }

  if (command === '/rename') {
    if (!args) {
      return 'Usage: /rename &lt;new_name&gt;';
    }
    const record = getCurrentRecord(extendedStore, input.address);
    if (!record) {
      return '当前会话不存在。';
    }
    const previous = displayName(record);
    extendedStore.setSessionName(record.session.id, args);
    extendedStore.touchSession(record.session.id, {
      channelType: input.address.channelType,
      chatId: input.address.chatId,
    });
    const duplicates = extendedStore.listSessionRecords().filter(
      (candidate) => candidate.session.id !== record.session.id
        && (candidate.meta.name || '').trim().toLowerCase() === args.toLowerCase(),
    );
    const duplicateHint = duplicates.length > 0
      ? '\n注意：已存在同名 session，后续 /switchto 可能需要你确认。'
      : '';
    return `已重命名会话 <code>${escapeHtml(shortSessionId(record.session.id))}</code>\n旧名称：${escapeHtml(previous)}\n新名称：${escapeHtml(args)}${duplicateHint}`;
  }

  if (command === '/switchto') {
    if (!args) {
      return 'Usage: /switchto &lt;session_id|name&gt;';
    }
    const resolved = resolveSessionOrCandidates(extendedStore, args);
    if (resolved.candidates) {
      return formatCandidateList(store, resolved.candidates);
    }
    if (!resolved.record) {
      return '未找到匹配的 session。';
    }
    const current = currentBinding(input.address);
    const target = resolved.record;
    store.updateChannelBinding(current.id, {
      codepilotSessionId: target.session.id,
      sdkSessionId: bindingSessionSdkId(target.session),
      workingDirectory: target.session.working_directory,
      model: target.session.model,
      active: true,
    });
    extendedStore.touchSession(target.session.id, {
      channelType: input.address.channelType,
      chatId: input.address.chatId,
    });
    return [
      `已切换到 <b>${escapeHtml(displayName(target))}</b>`,
      `Session: <code>${escapeHtml(shortSessionId(target.session.id))}</code>`,
      `状态: ${escapeHtml(statusLabel(target))}`,
      `CWD: <code>${escapeHtml(target.session.working_directory || '~')}</code>`,
      `摘要: ${escapeHtml(compactText(sessionSummary(store, target), 180))}`,
    ].join('\n');
  }

  if (command === '/archive') {
    const target = args
      ? resolveSessionOrCandidates(extendedStore, args)
      : { record: getCurrentRecord(extendedStore, input.address) || undefined };
    if (target.candidates) {
      return formatCandidateList(store, target.candidates);
    }
    if (!target.record) {
      return args ? '未找到匹配的 session。' : '当前会话不存在。';
    }
    const current = currentBinding(input.address);
    const wasCurrent = current.codepilotSessionId === target.record.session.id;
    const summary = buildArchiveSummary(store, target.record);
    extendedStore.archiveSession(target.record.session.id, summary);
    extendedStore.touchSession(target.record.session.id, {
      channelType: input.address.channelType,
      chatId: input.address.chatId,
    });

    let tail = '';
    if (wasCurrent) {
      const replacement = router.createBinding(input.address);
      tail = `\n已为当前聊天切换到新会话 <code>${escapeHtml(shortSessionId(replacement.codepilotSessionId))}</code>。`;
    }

    return [
      `已归档 <b>${escapeHtml(displayName(target.record))}</b>`,
      `Session: <code>${escapeHtml(shortSessionId(target.record.session.id))}</code>`,
      `摘要: ${escapeHtml(summary)}`,
    ].join('\n') + tail;
  }

  if (command === '/unarchive') {
    if (!args) {
      return 'Usage: /unarchive &lt;session_id|name&gt;';
    }
    const resolved = resolveSessionOrCandidates(extendedStore, args);
    if (resolved.candidates) {
      return formatCandidateList(store, resolved.candidates);
    }
    if (!resolved.record) {
      return '未找到匹配的 session。';
    }
    extendedStore.unarchiveSession(resolved.record.session.id);
    extendedStore.touchSession(resolved.record.session.id, {
      channelType: input.address.channelType,
      chatId: input.address.chatId,
    });
    return [
      `已恢复 <b>${escapeHtml(displayName(resolved.record))}</b>`,
      `Session: <code>${escapeHtml(shortSessionId(resolved.record.session.id))}</code>`,
      `摘要: ${escapeHtml(compactText(sessionSummary(store, resolved.record), 180))}`,
    ].join('\n');
  }

  return null;
}
