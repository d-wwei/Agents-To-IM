export interface HostProfile {
    host: string;
    displayName: string;
    skillCommand: string;
    runtimeHomeName: string;
    runtimeHomePath: string;
    launchdLabel: string;
    serviceName: string;
    logPrefix: string;
}
export declare function inferHostFromSkillCommand(value?: string): string | undefined;
export declare function inferHostFromPath(value?: string): string | undefined;
export declare function resolveHostName(moduleUrl: string): string;
export declare function buildHostProfile(hostInput: string): HostProfile;
export declare function getHostProfile(moduleUrl: string): HostProfile;
//# sourceMappingURL=host-profile.d.ts.map