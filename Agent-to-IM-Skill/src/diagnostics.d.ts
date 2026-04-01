import type { SessionMeta } from './store.js';
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
    recentMessages?: Array<{
        role: string;
        content: string;
    }>;
    extra?: Record<string, unknown>;
}
export declare function writeTaskDiagnosticSnapshot(input: TaskDiagnosticSnapshotInput): string | null;
//# sourceMappingURL=diagnostics.d.ts.map