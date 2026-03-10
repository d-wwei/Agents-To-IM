/**
 * JSON file-backed BridgeStore implementation.
 *
 * Uses in-memory Maps as cache with write-through persistence
 * to JSON files in ~/.codex-to-im/data/.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type {
  BridgeStore,
  BridgeSession,
  BridgeMessage,
  BridgeApiProvider,
  AuditLogInput,
  PermissionLinkInput,
  PermissionLinkRecord,
  OutboundRefInput,
  UpsertChannelBindingInput,
} from 'claude-to-im/src/lib/bridge/host.js';
import type { ChannelBinding, ChannelType } from 'claude-to-im/src/lib/bridge/types.js';
import { CTI_HOME } from './config.js';

const DATA_DIR = path.join(CTI_HOME, 'data');
const MESSAGES_DIR = path.join(DATA_DIR, 'messages');
const SESSION_META_FILE = path.join(DATA_DIR, 'session-meta.json');
const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');

// ── Helpers ──

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function atomicWrite(filePath: string, data: string): void {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, data, 'utf-8');
  fs.renameSync(tmp, filePath);
}

function readJson<T>(filePath: string, fallback: T): T {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson(filePath: string, data: unknown): void {
  atomicWrite(filePath, JSON.stringify(data, null, 2));
}

function uuid(): string {
  return crypto.randomUUID();
}

function now(): string {
  return new Date().toISOString();
}

// ── Lock entry ──

interface LockEntry {
  lockId: string;
  owner: string;
  expiresAt: number;
}

export interface SessionMeta {
  name?: string;
  created_at?: string;
  last_active_at?: string;
  archived?: boolean;
  archived_at?: string;
  archive_summary?: string;
  last_channel_type?: string;
  last_chat_id?: string;
  runtime_status?: string;
  runtime_updated_at?: string;
}

export interface SessionRecord {
  session: BridgeSession;
  meta: SessionMeta;
  bindings: ChannelBinding[];
}

export type BridgeTaskStatus =
  | 'queued'
  | 'running'
  | 'waiting_permission'
  | 'interrupted'
  | 'timed_out'
  | 'failed'
  | 'completed'
  | 'aborted'
  | 'resumed';

export interface BridgeTaskRecord {
  id: string;
  session_id: string;
  channel_type: string;
  chat_id: string;
  message_id: string;
  prompt_text: string;
  status: BridgeTaskStatus;
  created_at: string;
  updated_at: string;
  started_at?: string;
  completed_at?: string;
  sdk_session_id_at_start?: string;
  sdk_session_id_at_end?: string;
  last_partial_text?: string;
  final_response_preview?: string;
  last_error?: string;
  diagnostic_path?: string;
  permission_request_id?: string;
  permission_tool_name?: string;
  resume_count?: number;
  resumed_from_task_id?: string;
}

// ── Store ──

export class JsonFileStore implements BridgeStore {
  private settings: Map<string, string>;
  private sessions = new Map<string, BridgeSession>();
  private sessionMeta = new Map<string, SessionMeta>();
  private bindings = new Map<string, ChannelBinding>();
  private messages = new Map<string, BridgeMessage[]>();
  private permissionLinks = new Map<string, PermissionLinkRecord>();
  private offsets = new Map<string, string>();
  private dedupKeys = new Map<string, number>();
  private locks = new Map<string, LockEntry>();
  private auditLog: Array<AuditLogInput & { id: string; createdAt: string }> = [];
  private tasks = new Map<string, BridgeTaskRecord>();

  constructor(settingsMap: Map<string, string>) {
    this.settings = settingsMap;
    ensureDir(DATA_DIR);
    ensureDir(MESSAGES_DIR);
    this.loadAll();
  }

  // ── Persistence ──

  private loadAll(): void {
    // Sessions
    const sessions = readJson<Record<string, BridgeSession>>(
      path.join(DATA_DIR, 'sessions.json'),
      {},
    );
    for (const [id, s] of Object.entries(sessions)) {
      this.sessions.set(id, s);
    }

    const sessionMeta = readJson<Record<string, SessionMeta>>(SESSION_META_FILE, {});
    for (const [id, meta] of Object.entries(sessionMeta)) {
      this.sessionMeta.set(id, meta);
    }

    // Bindings
    const bindings = readJson<Record<string, ChannelBinding>>(
      path.join(DATA_DIR, 'bindings.json'),
      {},
    );
    for (const [key, b] of Object.entries(bindings)) {
      this.bindings.set(key, b);
    }

    // Permission links
    const perms = readJson<Record<string, PermissionLinkRecord>>(
      path.join(DATA_DIR, 'permissions.json'),
      {},
    );
    for (const [id, p] of Object.entries(perms)) {
      this.permissionLinks.set(id, p);
    }

    // Offsets
    const offsets = readJson<Record<string, string>>(
      path.join(DATA_DIR, 'offsets.json'),
      {},
    );
    for (const [k, v] of Object.entries(offsets)) {
      this.offsets.set(k, v);
    }

    // Dedup
    const dedup = readJson<Record<string, number>>(
      path.join(DATA_DIR, 'dedup.json'),
      {},
    );
    for (const [k, v] of Object.entries(dedup)) {
      this.dedupKeys.set(k, v);
    }

    // Audit
    this.auditLog = readJson(path.join(DATA_DIR, 'audit.json'), []);

    const tasks = readJson<Record<string, BridgeTaskRecord>>(TASKS_FILE, {});
    for (const [id, task] of Object.entries(tasks)) {
      this.tasks.set(id, task);
    }
  }

  private persistSessions(): void {
    writeJson(
      path.join(DATA_DIR, 'sessions.json'),
      Object.fromEntries(this.sessions),
    );
  }

  private persistSessionMeta(): void {
    writeJson(SESSION_META_FILE, Object.fromEntries(this.sessionMeta));
  }

  private persistBindings(): void {
    writeJson(
      path.join(DATA_DIR, 'bindings.json'),
      Object.fromEntries(this.bindings),
    );
  }

  private persistPermissions(): void {
    writeJson(
      path.join(DATA_DIR, 'permissions.json'),
      Object.fromEntries(this.permissionLinks),
    );
  }

  private persistOffsets(): void {
    writeJson(
      path.join(DATA_DIR, 'offsets.json'),
      Object.fromEntries(this.offsets),
    );
  }

  private persistDedup(): void {
    writeJson(
      path.join(DATA_DIR, 'dedup.json'),
      Object.fromEntries(this.dedupKeys),
    );
  }

  private persistAudit(): void {
    writeJson(path.join(DATA_DIR, 'audit.json'), this.auditLog);
  }

  private persistTasks(): void {
    writeJson(TASKS_FILE, Object.fromEntries(this.tasks));
  }

  private persistMessages(sessionId: string): void {
    const msgs = this.messages.get(sessionId) || [];
    writeJson(path.join(MESSAGES_DIR, `${sessionId}.json`), msgs);
  }

  private loadMessages(sessionId: string): BridgeMessage[] {
    if (this.messages.has(sessionId)) {
      return this.messages.get(sessionId)!;
    }
    const msgs = readJson<BridgeMessage[]>(
      path.join(MESSAGES_DIR, `${sessionId}.json`),
      [],
    );
    this.messages.set(sessionId, msgs);
    return msgs;
  }

  // ── Settings ──

  getSetting(key: string): string | null {
    return this.settings.get(key) ?? null;
  }

  // ── Channel Bindings ──

  getChannelBinding(channelType: string, chatId: string): ChannelBinding | null {
    return this.bindings.get(`${channelType}:${chatId}`) ?? null;
  }

  upsertChannelBinding(data: UpsertChannelBindingInput): ChannelBinding {
    const key = `${data.channelType}:${data.chatId}`;
    const existing = this.bindings.get(key);
    if (existing) {
      const updated: ChannelBinding = {
        ...existing,
        codepilotSessionId: data.codepilotSessionId,
        workingDirectory: data.workingDirectory,
        model: data.model,
        updatedAt: now(),
      };
      this.bindings.set(key, updated);
      this.persistBindings();
      this.touchSession(updated.codepilotSessionId, {
        channelType: updated.channelType,
        chatId: updated.chatId,
      });
      return updated;
    }
    const binding: ChannelBinding = {
      id: uuid(),
      channelType: data.channelType,
      chatId: data.chatId,
      codepilotSessionId: data.codepilotSessionId,
      sdkSessionId: '',
      workingDirectory: data.workingDirectory,
      model: data.model,
      mode: (this.settings.get('bridge_default_mode') as 'code' | 'plan' | 'ask') || 'code',
      active: true,
      createdAt: now(),
      updatedAt: now(),
    };
    this.bindings.set(key, binding);
    this.persistBindings();
    this.touchSession(binding.codepilotSessionId, {
      channelType: binding.channelType,
      chatId: binding.chatId,
    });
    return binding;
  }

  updateChannelBinding(id: string, updates: Partial<ChannelBinding>): void {
    for (const [key, b] of this.bindings) {
      if (b.id === id) {
        const updated = { ...b, ...updates, updatedAt: now() };
        this.bindings.set(key, updated);
        this.persistBindings();
        this.touchSession(updated.codepilotSessionId, {
          channelType: updated.channelType,
          chatId: updated.chatId,
        });
        break;
      }
    }
  }

  listChannelBindings(channelType?: ChannelType): ChannelBinding[] {
    const all = Array.from(this.bindings.values());
    if (!channelType) return all;
    return all.filter((b) => b.channelType === channelType);
  }

  // ── Sessions ──

  getSession(id: string): BridgeSession | null {
    return this.sessions.get(id) ?? null;
  }

  listSessions(): BridgeSession[] {
    return Array.from(this.sessions.values());
  }

  listSessionRecords(): SessionRecord[] {
    const bindings = Array.from(this.bindings.values());
    return Array.from(this.sessions.values()).map((session) => ({
      session,
      meta: this.getSessionMeta(session.id) ?? {},
      bindings: bindings.filter((binding) => binding.codepilotSessionId === session.id),
    }));
  }

  getSessionMeta(sessionId: string): SessionMeta | null {
    return this.sessionMeta.get(sessionId) ?? null;
  }

  private upsertSessionMeta(sessionId: string, updates: Partial<SessionMeta>): SessionMeta {
    const existing = this.sessionMeta.get(sessionId) ?? {};
    const merged: SessionMeta = { ...existing, ...updates };
    this.sessionMeta.set(sessionId, merged);
    this.persistSessionMeta();
    return merged;
  }

  setSessionName(sessionId: string, name: string): void {
    this.upsertSessionMeta(sessionId, { name, last_active_at: now() });
  }

  archiveSession(sessionId: string, summary: string): void {
    this.upsertSessionMeta(sessionId, {
      archived: true,
      archived_at: now(),
      archive_summary: summary,
      last_active_at: now(),
    });
  }

  unarchiveSession(sessionId: string): void {
    const existing = this.sessionMeta.get(sessionId) ?? {};
    this.sessionMeta.set(sessionId, {
      ...existing,
      archived: false,
      archived_at: undefined,
      last_active_at: now(),
    });
    this.persistSessionMeta();
  }

  touchSession(
    sessionId: string,
    updates?: { channelType?: string; chatId?: string },
  ): void {
    this.upsertSessionMeta(sessionId, {
      last_active_at: now(),
      ...(updates?.channelType ? { last_channel_type: updates.channelType } : {}),
      ...(updates?.chatId ? { last_chat_id: updates.chatId } : {}),
    });
  }

  createSession(
    _name: string,
    model: string,
    systemPrompt?: string,
    cwd?: string,
    _mode?: string,
  ): BridgeSession {
    const session: BridgeSession = {
      id: uuid(),
      working_directory: cwd || this.settings.get('bridge_default_work_dir') || process.cwd(),
      model,
      system_prompt: systemPrompt,
    };
    this.sessions.set(session.id, session);
    this.persistSessions();
    this.upsertSessionMeta(session.id, {
      name: _name || undefined,
      created_at: now(),
      last_active_at: now(),
    });
    return session;
  }

  updateSessionProviderId(sessionId: string, providerId: string): void {
    const s = this.sessions.get(sessionId);
    if (s) {
      s.provider_id = providerId;
      this.persistSessions();
    }
  }

  // ── Messages ──

  addMessage(sessionId: string, role: string, content: string, _usage?: string | null): void {
    const msgs = this.loadMessages(sessionId);
    msgs.push({ role, content });
    this.persistMessages(sessionId);
    this.touchSession(sessionId);
  }

  getMessages(sessionId: string, opts?: { limit?: number }): { messages: BridgeMessage[] } {
    const msgs = this.loadMessages(sessionId);
    if (opts?.limit && opts.limit > 0) {
      return { messages: msgs.slice(-opts.limit) };
    }
    return { messages: [...msgs] };
  }

  // ── Session Locking ──

  acquireSessionLock(sessionId: string, lockId: string, owner: string, ttlSecs: number): boolean {
    const existing = this.locks.get(sessionId);
    if (existing && existing.expiresAt > Date.now()) {
      // Lock held by someone else
      if (existing.lockId !== lockId) return false;
    }
    this.locks.set(sessionId, {
      lockId,
      owner,
      expiresAt: Date.now() + ttlSecs * 1000,
    });
    return true;
  }

  renewSessionLock(sessionId: string, lockId: string, ttlSecs: number): void {
    const lock = this.locks.get(sessionId);
    if (lock && lock.lockId === lockId) {
      lock.expiresAt = Date.now() + ttlSecs * 1000;
    }
  }

  releaseSessionLock(sessionId: string, lockId: string): void {
    const lock = this.locks.get(sessionId);
    if (lock && lock.lockId === lockId) {
      this.locks.delete(sessionId);
    }
  }

  setSessionRuntimeStatus(_sessionId: string, _status: string): void {
    this.upsertSessionMeta(_sessionId, {
      runtime_status: _status,
      runtime_updated_at: now(),
    });
  }

  // ── SDK Session ──

  updateSdkSessionId(sessionId: string, sdkSessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (s) {
      // Store sdkSessionId on the session object
      (s as unknown as Record<string, unknown>)['sdk_session_id'] = sdkSessionId;
      this.persistSessions();
    }
    // Also update any bindings that reference this session
    for (const [key, b] of this.bindings) {
      if (b.codepilotSessionId === sessionId) {
        this.bindings.set(key, { ...b, sdkSessionId, updatedAt: now() });
      }
    }
    this.persistBindings();
  }

  updateSessionModel(sessionId: string, model: string): void {
    const s = this.sessions.get(sessionId);
    if (s) {
      s.model = model;
      this.persistSessions();
    }
  }

  syncSdkTasks(_sessionId: string, _todos: unknown): void {
    // no-op
  }

  // ── Provider ──

  getProvider(_id: string): BridgeApiProvider | undefined {
    return undefined;
  }

  getDefaultProviderId(): string | null {
    return null;
  }

  // ── Audit & Dedup ──

  insertAuditLog(entry: AuditLogInput): void {
    this.auditLog.push({
      ...entry,
      id: uuid(),
      createdAt: now(),
    });
    // Ring buffer: keep last 1000
    if (this.auditLog.length > 1000) {
      this.auditLog = this.auditLog.slice(-1000);
    }
    this.persistAudit();
  }

  checkDedup(key: string): boolean {
    const ts = this.dedupKeys.get(key);
    if (ts === undefined) return false;
    // 5 minute window
    if (Date.now() - ts > 5 * 60 * 1000) {
      this.dedupKeys.delete(key);
      return false;
    }
    return true;
  }

  insertDedup(key: string): void {
    this.dedupKeys.set(key, Date.now());
    this.persistDedup();
  }

  cleanupExpiredDedup(): void {
    const cutoff = Date.now() - 5 * 60 * 1000;
    let changed = false;
    for (const [key, ts] of this.dedupKeys) {
      if (ts < cutoff) {
        this.dedupKeys.delete(key);
        changed = true;
      }
    }
    if (changed) this.persistDedup();
  }

  insertOutboundRef(_ref: OutboundRefInput): void {
    // no-op for file-based store
  }

  // ── Tasks ──

  createTask(input: {
    sessionId: string;
    channelType: string;
    chatId: string;
    messageId: string;
    promptText: string;
    sdkSessionIdAtStart?: string;
    resumedFromTaskId?: string;
  }): BridgeTaskRecord {
    const timestamp = now();
    const task: BridgeTaskRecord = {
      id: uuid(),
      session_id: input.sessionId,
      channel_type: input.channelType,
      chat_id: input.chatId,
      message_id: input.messageId,
      prompt_text: input.promptText,
      status: 'queued',
      created_at: timestamp,
      updated_at: timestamp,
      started_at: timestamp,
      sdk_session_id_at_start: input.sdkSessionIdAtStart,
      resumed_from_task_id: input.resumedFromTaskId,
      resume_count: input.resumedFromTaskId ? 1 : 0,
    };
    this.tasks.set(task.id, task);
    this.persistTasks();
    return task;
  }

  updateTask(taskId: string, updates: Partial<BridgeTaskRecord>): BridgeTaskRecord | null {
    const existing = this.tasks.get(taskId);
    if (!existing) return null;
    const updated: BridgeTaskRecord = {
      ...existing,
      ...updates,
      updated_at: now(),
    };
    this.tasks.set(taskId, updated);
    this.persistTasks();
    return updated;
  }

  getTask(taskId: string): BridgeTaskRecord | null {
    return this.tasks.get(taskId) ?? null;
  }

  listTasks(filter?: {
    sessionId?: string;
    channelType?: string;
    chatId?: string;
    statuses?: BridgeTaskStatus[];
    limit?: number;
  }): BridgeTaskRecord[] {
    let items = Array.from(this.tasks.values());
    if (filter?.sessionId) {
      items = items.filter((task) => task.session_id === filter.sessionId);
    }
    if (filter?.channelType) {
      items = items.filter((task) => task.channel_type === filter.channelType);
    }
    if (filter?.chatId) {
      items = items.filter((task) => task.chat_id === filter.chatId);
    }
    if (filter?.statuses && filter.statuses.length > 0) {
      const allowed = new Set(filter.statuses);
      items = items.filter((task) => allowed.has(task.status));
    }
    items.sort((left, right) => right.updated_at.localeCompare(left.updated_at));
    if (filter?.limit && filter.limit > 0) {
      return items.slice(0, filter.limit);
    }
    return items;
  }

  getLatestResumableTask(channelType: string, chatId: string): BridgeTaskRecord | null {
    return this.listTasks({
      channelType,
      chatId,
      statuses: ['interrupted', 'timed_out', 'failed', 'aborted'],
      limit: 1,
    })[0] ?? null;
  }

  // ── Permission Links ──

  insertPermissionLink(link: PermissionLinkInput): void {
    const record: PermissionLinkRecord = {
      permissionRequestId: link.permissionRequestId,
      chatId: link.chatId,
      messageId: link.messageId,
      resolved: false,
      suggestions: link.suggestions,
    };
    this.permissionLinks.set(link.permissionRequestId, record);
    this.persistPermissions();
  }

  getPermissionLink(permissionRequestId: string): PermissionLinkRecord | null {
    return this.permissionLinks.get(permissionRequestId) ?? null;
  }

  markPermissionLinkResolved(permissionRequestId: string): boolean {
    const link = this.permissionLinks.get(permissionRequestId);
    if (!link || link.resolved) return false;
    link.resolved = true;
    this.persistPermissions();
    return true;
  }

  listPendingPermissionLinksByChat(chatId: string): PermissionLinkRecord[] {
    const result: PermissionLinkRecord[] = [];
    for (const link of this.permissionLinks.values()) {
      if (link.chatId === chatId && !link.resolved) {
        result.push(link);
      }
    }
    return result;
  }

  // ── Channel Offsets ──

  getChannelOffset(key: string): string {
    return this.offsets.get(key) ?? '0';
  }

  setChannelOffset(key: string, offset: string): void {
    this.offsets.set(key, offset);
    this.persistOffsets();
  }
}
