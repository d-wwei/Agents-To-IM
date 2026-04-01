/**
 * JSON file-backed BridgeStore implementation.
 *
 * Uses in-memory Maps as cache with write-through persistence
 * to JSON files in ~/.codex-to-im/data/.
 */
import type { BridgeStore, BridgeSession, BridgeMessage, BridgeApiProvider, AuditLogInput, PermissionLinkInput, PermissionLinkRecord, OutboundRefInput, UpsertChannelBindingInput } from 'agent-to-im-core/src/lib/bridge/host.js';
import type { ChannelBinding, ChannelType } from 'agent-to-im-core/src/lib/bridge/types.js';
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
export type BridgeTaskStatus = 'queued' | 'running' | 'waiting_permission' | 'interrupted' | 'timed_out' | 'failed' | 'completed' | 'aborted' | 'resumed';
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
export declare class JsonFileStore implements BridgeStore {
    private settings;
    private sessions;
    private sessionMeta;
    private bindings;
    private messages;
    private permissionLinks;
    private offsets;
    private dedupKeys;
    private locks;
    private auditLog;
    private tasks;
    constructor(settingsMap: Map<string, string>);
    private loadAll;
    private persistSessions;
    private persistSessionMeta;
    private persistBindings;
    private persistPermissions;
    private persistOffsets;
    private persistDedup;
    private persistAudit;
    private persistTasks;
    private persistMessages;
    private loadMessages;
    getSetting(key: string): string | null;
    getChannelBinding(channelType: string, chatId: string): ChannelBinding | null;
    upsertChannelBinding(data: UpsertChannelBindingInput): ChannelBinding;
    updateChannelBinding(id: string, updates: Partial<ChannelBinding>): void;
    listChannelBindings(channelType?: ChannelType): ChannelBinding[];
    getSession(id: string): BridgeSession | null;
    listSessions(): BridgeSession[];
    listSessionRecords(): SessionRecord[];
    getSessionMeta(sessionId: string): SessionMeta | null;
    private upsertSessionMeta;
    setSessionName(sessionId: string, name: string): void;
    archiveSession(sessionId: string, summary: string): void;
    unarchiveSession(sessionId: string): void;
    touchSession(sessionId: string, updates?: {
        channelType?: string;
        chatId?: string;
    }): void;
    createSession(_name: string, model: string, systemPrompt?: string, cwd?: string, _mode?: string): BridgeSession;
    updateSessionProviderId(sessionId: string, providerId: string): void;
    addMessage(sessionId: string, role: string, content: string, _usage?: string | null): void;
    getMessages(sessionId: string, opts?: {
        limit?: number;
    }): {
        messages: BridgeMessage[];
    };
    acquireSessionLock(sessionId: string, lockId: string, owner: string, ttlSecs: number): boolean;
    renewSessionLock(sessionId: string, lockId: string, ttlSecs: number): void;
    releaseSessionLock(sessionId: string, lockId: string): void;
    setSessionRuntimeStatus(_sessionId: string, _status: string): void;
    updateSdkSessionId(sessionId: string, sdkSessionId: string): void;
    updateSessionModel(sessionId: string, model: string): void;
    syncSdkTasks(_sessionId: string, _todos: unknown): void;
    getProvider(_id: string): BridgeApiProvider | undefined;
    getDefaultProviderId(): string | null;
    insertAuditLog(entry: AuditLogInput): void;
    checkDedup(key: string): boolean;
    insertDedup(key: string): void;
    cleanupExpiredDedup(): void;
    insertOutboundRef(_ref: OutboundRefInput): void;
    createTask(input: {
        sessionId: string;
        channelType: string;
        chatId: string;
        messageId: string;
        promptText: string;
        sdkSessionIdAtStart?: string;
        resumedFromTaskId?: string;
    }): BridgeTaskRecord;
    updateTask(taskId: string, updates: Partial<BridgeTaskRecord>): BridgeTaskRecord | null;
    getTask(taskId: string): BridgeTaskRecord | null;
    listTasks(filter?: {
        sessionId?: string;
        channelType?: string;
        chatId?: string;
        statuses?: BridgeTaskStatus[];
        limit?: number;
    }): BridgeTaskRecord[];
    getLatestResumableTask(channelType: string, chatId: string): BridgeTaskRecord | null;
    insertPermissionLink(link: PermissionLinkInput): void;
    getPermissionLink(permissionRequestId: string): PermissionLinkRecord | null;
    markPermissionLinkResolved(permissionRequestId: string): boolean;
    listPendingPermissionLinksByChat(chatId: string): PermissionLinkRecord[];
    getChannelOffset(key: string): string;
    setChannelOffset(key: string, offset: string): void;
}
//# sourceMappingURL=store.d.ts.map