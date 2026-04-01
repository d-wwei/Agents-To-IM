export interface GeneratedVoiceReply {
    fileName: string;
    mimeType: string;
    data: Buffer;
}
type VoiceReplyPreparationResult = {
    status: "skipped";
} | {
    status: "needs_config";
    noteText: string;
} | {
    status: "ready";
    attachment: GeneratedVoiceReply;
} | {
    status: "error";
    noteText: string;
};
export declare function wantsVoiceReply(text: string): boolean;
export declare function buildVoiceReplySetupGuide(): string;
export declare function prepareVoiceReply(responseText: string): Promise<VoiceReplyPreparationResult>;
export {};
//# sourceMappingURL=voice-reply.d.ts.map