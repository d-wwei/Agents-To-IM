export interface Config {
    runtime: 'claude' | 'codex' | 'gemini' | 'auto';
    enabledChannels: string[];
    defaultWorkDir: string;
    defaultModel?: string;
    defaultMode: string;
    codexSkipGitRepoCheck?: boolean;
    codexExecutable?: string;
    codexSandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access';
    codexApprovalPolicy?: 'never' | 'on-request' | 'on-failure' | 'untrusted';
    geminiApiKey?: string;
    googleApiKey?: string;
    openaiApiKey?: string;
    tgBotToken?: string;
    tgChatId?: string;
    tgAllowedUsers?: string[];
    feishuAppId?: string;
    feishuAppSecret?: string;
    feishuDomain?: string;
    feishuAllowedUsers?: string[];
    feishuAudioTranscribe?: boolean;
    audioTranscoder?: string;
    elevenLabsApiKey?: string;
    elevenLabsVoiceId?: string;
    elevenLabsModelId?: string;
    discordBotToken?: string;
    discordAllowedUsers?: string[];
    discordAllowedChannels?: string[];
    discordAllowedGuilds?: string[];
    qqAppId?: string;
    qqAppSecret?: string;
    qqAllowedUsers?: string[];
    qqImageEnabled?: boolean;
    qqMaxImageSize?: number;
    weixinBaseUrl?: string;
    weixinCdnBaseUrl?: string;
    weixinMediaEnabled?: boolean;
    autoApprove?: boolean;
    disableSessionPool?: boolean;
}
export declare const HOST_PROFILE: import("./host-profile.js").HostProfile;
export declare const CTI_HOME: string;
export declare const CONFIG_PATH: string;
/**
 * Convert MSYS/Git-Bash/Cygwin-style paths to native Windows paths.
 * /c/Users/foo  ->  C:\Users\foo
 * On non-Windows or non-matching input, returns the path unchanged.
 */
export declare function normalizeMsysPath(p: string): string;
/**
 * Expand the only supported shell-style placeholders used in config.env:
 * $HOME and $CWD (including ${HOME} / ${CWD} forms).
 */
export declare function expandShellVars(value: string): string;
export declare function loadConfig(): Config;
export declare function saveConfig(config: Config): void;
export declare function maskSecret(value: string): string;
export declare function configToSettings(config: Config): Map<string, string>;
//# sourceMappingURL=config.d.ts.map