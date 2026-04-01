export interface DiscordSlashCommandOptionDefinition {
    name: string;
    description: string;
    type: 'string' | 'boolean';
    required?: boolean;
}
export interface DiscordSlashCommandDefinition {
    name: string;
    description: string;
    options?: DiscordSlashCommandOptionDefinition[];
    toText: (options: Record<string, string | boolean>) => string;
}
export declare const DISCORD_SLASH_COMMANDS: DiscordSlashCommandDefinition[];
export declare function buildDiscordSlashCommandText(commandName: string, options?: Record<string, string | boolean>): string | null;
//# sourceMappingURL=discord-command-support.d.ts.map