/**
 * JSON file-backed BridgeStore implementation.
 *
 * Uses in-memory Maps as cache with write-through persistence
 * to JSON files in ~/.codex-to-im/data/.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CTI_HOME } from './config.js';
const DATA_DIR = path.join(CTI_HOME, 'data');
const MESSAGES_DIR = path.join(DATA_DIR, 'messages');
const SESSION_META_FILE = path.join(DATA_DIR, 'session-meta.json');
const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');
// ── Helpers ──
function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}
function atomicWrite(filePath, data) {
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, data, 'utf-8');
    fs.renameSync(tmp, filePath);
}
function readJson(filePath, fallback) {
    try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        return JSON.parse(raw);
    }
    catch {
        return fallback;
    }
}
function writeJson(filePath, data) {
    atomicWrite(filePath, JSON.stringify(data, null, 2));
}
function uuid() {
    return crypto.randomUUID();
}
function now() {
    return new Date().toISOString();
}
// ── Store ──
export class JsonFileStore {
    settings;
    sessions = new Map();
    sessionMeta = new Map();
    bindings = new Map();
    messages = new Map();
    permissionLinks = new Map();
    offsets = new Map();
    dedupKeys = new Map();
    locks = new Map();
    auditLog = [];
    tasks = new Map();
    constructor(settingsMap) {
        this.settings = settingsMap;
        ensureDir(DATA_DIR);
        ensureDir(MESSAGES_DIR);
        this.loadAll();
    }
    // ── Persistence ──
    loadAll() {
        // Sessions
        const sessions = readJson(path.join(DATA_DIR, 'sessions.json'), {});
        for (const [id, s] of Object.entries(sessions)) {
            this.sessions.set(id, s);
        }
        const sessionMeta = readJson(SESSION_META_FILE, {});
        for (const [id, meta] of Object.entries(sessionMeta)) {
            this.sessionMeta.set(id, meta);
        }
        // Bindings
        const bindings = readJson(path.join(DATA_DIR, 'bindings.json'), {});
        for (const [key, b] of Object.entries(bindings)) {
            this.bindings.set(key, b);
        }
        // Permission links
        const perms = readJson(path.join(DATA_DIR, 'permissions.json'), {});
        for (const [id, p] of Object.entries(perms)) {
            this.permissionLinks.set(id, p);
        }
        // Offsets
        const offsets = readJson(path.join(DATA_DIR, 'offsets.json'), {});
        for (const [k, v] of Object.entries(offsets)) {
            this.offsets.set(k, v);
        }
        // Dedup
        const dedup = readJson(path.join(DATA_DIR, 'dedup.json'), {});
        for (const [k, v] of Object.entries(dedup)) {
            this.dedupKeys.set(k, v);
        }
        // Audit
        this.auditLog = readJson(path.join(DATA_DIR, 'audit.json'), []);
        const tasks = readJson(TASKS_FILE, {});
        for (const [id, task] of Object.entries(tasks)) {
            this.tasks.set(id, task);
        }
    }
    persistSessions() {
        writeJson(path.join(DATA_DIR, 'sessions.json'), Object.fromEntries(this.sessions));
    }
    persistSessionMeta() {
        writeJson(SESSION_META_FILE, Object.fromEntries(this.sessionMeta));
    }
    persistBindings() {
        writeJson(path.join(DATA_DIR, 'bindings.json'), Object.fromEntries(this.bindings));
    }
    persistPermissions() {
        writeJson(path.join(DATA_DIR, 'permissions.json'), Object.fromEntries(this.permissionLinks));
    }
    persistOffsets() {
        writeJson(path.join(DATA_DIR, 'offsets.json'), Object.fromEntries(this.offsets));
    }
    persistDedup() {
        writeJson(path.join(DATA_DIR, 'dedup.json'), Object.fromEntries(this.dedupKeys));
    }
    persistAudit() {
        writeJson(path.join(DATA_DIR, 'audit.json'), this.auditLog);
    }
    persistTasks() {
        writeJson(TASKS_FILE, Object.fromEntries(this.tasks));
    }
    persistMessages(sessionId) {
        const msgs = this.messages.get(sessionId) || [];
        writeJson(path.join(MESSAGES_DIR, `${sessionId}.json`), msgs);
    }
    loadMessages(sessionId) {
        if (this.messages.has(sessionId)) {
            return this.messages.get(sessionId);
        }
        const msgs = readJson(path.join(MESSAGES_DIR, `${sessionId}.json`), []);
        this.messages.set(sessionId, msgs);
        return msgs;
    }
    // ── Settings ──
    getSetting(key) {
        return this.settings.get(key) ?? null;
    }
    // ── Channel Bindings ──
    getChannelBinding(channelType, chatId) {
        return this.bindings.get(`${channelType}:${chatId}`) ?? null;
    }
    upsertChannelBinding(data) {
        const key = `${data.channelType}:${data.chatId}`;
        const existing = this.bindings.get(key);
        if (existing) {
            const sessionChanged = existing.codepilotSessionId !== data.codepilotSessionId;
            const updated = {
                ...existing,
                codepilotSessionId: data.codepilotSessionId,
                // A fresh bridge session must not inherit a stale Claude SDK session.
                sdkSessionId: sessionChanged ? '' : existing.sdkSessionId,
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
        const binding = {
            id: uuid(),
            channelType: data.channelType,
            chatId: data.chatId,
            codepilotSessionId: data.codepilotSessionId,
            sdkSessionId: '',
            workingDirectory: data.workingDirectory,
            model: data.model,
            mode: this.settings.get('bridge_default_mode') || 'code',
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
    updateChannelBinding(id, updates) {
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
    listChannelBindings(channelType) {
        const all = Array.from(this.bindings.values());
        if (!channelType)
            return all;
        return all.filter((b) => b.channelType === channelType);
    }
    // ── Sessions ──
    getSession(id) {
        return this.sessions.get(id) ?? null;
    }
    listSessions() {
        return Array.from(this.sessions.values());
    }
    listSessionRecords() {
        const bindings = Array.from(this.bindings.values());
        return Array.from(this.sessions.values()).map((session) => ({
            session,
            meta: this.getSessionMeta(session.id) ?? {},
            bindings: bindings.filter((binding) => binding.codepilotSessionId === session.id),
        }));
    }
    getSessionMeta(sessionId) {
        return this.sessionMeta.get(sessionId) ?? null;
    }
    upsertSessionMeta(sessionId, updates) {
        const existing = this.sessionMeta.get(sessionId) ?? {};
        const merged = { ...existing, ...updates };
        this.sessionMeta.set(sessionId, merged);
        this.persistSessionMeta();
        return merged;
    }
    setSessionName(sessionId, name) {
        this.upsertSessionMeta(sessionId, { name, last_active_at: now() });
    }
    archiveSession(sessionId, summary) {
        this.upsertSessionMeta(sessionId, {
            archived: true,
            archived_at: now(),
            archive_summary: summary,
            last_active_at: now(),
        });
    }
    unarchiveSession(sessionId) {
        const existing = this.sessionMeta.get(sessionId) ?? {};
        this.sessionMeta.set(sessionId, {
            ...existing,
            archived: false,
            archived_at: undefined,
            last_active_at: now(),
        });
        this.persistSessionMeta();
    }
    touchSession(sessionId, updates) {
        this.upsertSessionMeta(sessionId, {
            last_active_at: now(),
            ...(updates?.channelType ? { last_channel_type: updates.channelType } : {}),
            ...(updates?.chatId ? { last_chat_id: updates.chatId } : {}),
        });
    }
    createSession(_name, model, systemPrompt, cwd, _mode) {
        const session = {
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
    updateSessionProviderId(sessionId, providerId) {
        const s = this.sessions.get(sessionId);
        if (s) {
            s.provider_id = providerId;
            this.persistSessions();
        }
    }
    // ── Messages ──
    addMessage(sessionId, role, content, _usage) {
        const msgs = this.loadMessages(sessionId);
        msgs.push({ role, content });
        this.persistMessages(sessionId);
        this.touchSession(sessionId);
    }
    getMessages(sessionId, opts) {
        const msgs = this.loadMessages(sessionId);
        if (opts?.limit && opts.limit > 0) {
            return { messages: msgs.slice(-opts.limit) };
        }
        return { messages: [...msgs] };
    }
    // ── Session Locking ──
    acquireSessionLock(sessionId, lockId, owner, ttlSecs) {
        const existing = this.locks.get(sessionId);
        if (existing && existing.expiresAt > Date.now()) {
            // Lock held by someone else
            if (existing.lockId !== lockId)
                return false;
        }
        this.locks.set(sessionId, {
            lockId,
            owner,
            expiresAt: Date.now() + ttlSecs * 1000,
        });
        return true;
    }
    renewSessionLock(sessionId, lockId, ttlSecs) {
        const lock = this.locks.get(sessionId);
        if (lock && lock.lockId === lockId) {
            lock.expiresAt = Date.now() + ttlSecs * 1000;
        }
    }
    releaseSessionLock(sessionId, lockId) {
        const lock = this.locks.get(sessionId);
        if (lock && lock.lockId === lockId) {
            this.locks.delete(sessionId);
        }
    }
    setSessionRuntimeStatus(_sessionId, _status) {
        this.upsertSessionMeta(_sessionId, {
            runtime_status: _status,
            runtime_updated_at: now(),
        });
    }
    // ── SDK Session ──
    updateSdkSessionId(sessionId, sdkSessionId) {
        const s = this.sessions.get(sessionId);
        if (s) {
            // Store sdkSessionId on the session object
            s['sdk_session_id'] = sdkSessionId;
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
    updateSessionModel(sessionId, model) {
        const s = this.sessions.get(sessionId);
        if (s) {
            s.model = model;
            this.persistSessions();
        }
    }
    syncSdkTasks(_sessionId, _todos) {
        // no-op
    }
    // ── Provider ──
    getProvider(_id) {
        return undefined;
    }
    getDefaultProviderId() {
        return null;
    }
    // ── Audit & Dedup ──
    insertAuditLog(entry) {
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
    checkDedup(key) {
        const ts = this.dedupKeys.get(key);
        if (ts === undefined)
            return false;
        // 5 minute window
        if (Date.now() - ts > 5 * 60 * 1000) {
            this.dedupKeys.delete(key);
            return false;
        }
        return true;
    }
    insertDedup(key) {
        this.dedupKeys.set(key, Date.now());
        this.persistDedup();
    }
    cleanupExpiredDedup() {
        const cutoff = Date.now() - 5 * 60 * 1000;
        let changed = false;
        for (const [key, ts] of this.dedupKeys) {
            if (ts < cutoff) {
                this.dedupKeys.delete(key);
                changed = true;
            }
        }
        if (changed)
            this.persistDedup();
    }
    insertOutboundRef(_ref) {
        // no-op for file-based store
    }
    // ── Tasks ──
    createTask(input) {
        const timestamp = now();
        const task = {
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
    updateTask(taskId, updates) {
        const existing = this.tasks.get(taskId);
        if (!existing)
            return null;
        const updated = {
            ...existing,
            ...updates,
            updated_at: now(),
        };
        this.tasks.set(taskId, updated);
        this.persistTasks();
        return updated;
    }
    getTask(taskId) {
        return this.tasks.get(taskId) ?? null;
    }
    listTasks(filter) {
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
    getLatestResumableTask(channelType, chatId) {
        return this.listTasks({
            channelType,
            chatId,
            statuses: ['interrupted', 'timed_out', 'failed', 'aborted'],
            limit: 1,
        })[0] ?? null;
    }
    // ── Permission Links ──
    insertPermissionLink(link) {
        const record = {
            permissionRequestId: link.permissionRequestId,
            chatId: link.chatId,
            messageId: link.messageId,
            resolved: false,
            suggestions: link.suggestions,
        };
        this.permissionLinks.set(link.permissionRequestId, record);
        this.persistPermissions();
    }
    getPermissionLink(permissionRequestId) {
        return this.permissionLinks.get(permissionRequestId) ?? null;
    }
    markPermissionLinkResolved(permissionRequestId) {
        const link = this.permissionLinks.get(permissionRequestId);
        if (!link || link.resolved)
            return false;
        link.resolved = true;
        this.persistPermissions();
        return true;
    }
    listPendingPermissionLinksByChat(chatId) {
        const result = [];
        for (const link of this.permissionLinks.values()) {
            if (link.chatId === chatId && !link.resolved) {
                result.push(link);
            }
        }
        return result;
    }
    // ── Channel Offsets ──
    getChannelOffset(key) {
        return this.offsets.get(key) ?? '0';
    }
    setChannelOffset(key, offset) {
        this.offsets.set(key, offset);
        this.persistOffsets();
    }
}
//# sourceMappingURL=store.js.map