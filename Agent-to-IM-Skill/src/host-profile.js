import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const KNOWN_HOSTS = new Set(['claude', 'codex', 'gemini']);
function toTitleCase(value) {
    return value
        .split(/[-_]/g)
        .filter(Boolean)
        .map(part => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
}
function toPascalCase(value) {
    return value
        .split(/[-_]/g)
        .filter(Boolean)
        .map(part => part.charAt(0).toUpperCase() + part.slice(1))
        .join('');
}
export function inferHostFromSkillCommand(value) {
    if (!value)
        return undefined;
    const match = value.trim().match(/^([a-z0-9][a-z0-9-_]*)-to-im$/i);
    if (!match)
        return undefined;
    return match[1].toLowerCase();
}
export function inferHostFromPath(value) {
    if (!value)
        return undefined;
    const base = path.basename(value).replace(/^\./, '');
    return inferHostFromSkillCommand(base);
}
export function resolveHostName(moduleUrl) {
    const fromEnv = process.env.CTI_HOST?.trim().toLowerCase()
        || inferHostFromSkillCommand(process.env.CTI_SKILL_COMMAND)
        || inferHostFromPath(process.env.CTI_HOME);
    if (fromEnv)
        return fromEnv;
    const modulePath = fileURLToPath(moduleUrl);
    const skillDir = path.dirname(path.dirname(modulePath));
    return inferHostFromPath(skillDir) || 'claude';
}
export function buildHostProfile(hostInput) {
    const host = hostInput.trim().toLowerCase() || 'claude';
    const displayName = host === 'claude' ? 'Claude'
        : host === 'codex' ? 'Codex'
            : host === 'gemini' ? 'Gemini'
                : toTitleCase(host);
    const skillCommand = `${host}-to-im`;
    const runtimeHomeName = `.${skillCommand}`;
    return {
        host,
        displayName,
        skillCommand,
        runtimeHomeName,
        runtimeHomePath: path.join(os.homedir(), runtimeHomeName),
        launchdLabel: `com.${skillCommand}.bridge`,
        serviceName: `${toPascalCase(host)}ToIMBridge`,
        logPrefix: skillCommand,
    };
}
export function getHostProfile(moduleUrl) {
    const host = resolveHostName(moduleUrl);
    return buildHostProfile(KNOWN_HOSTS.has(host) ? host : host);
}
//# sourceMappingURL=host-profile.js.map