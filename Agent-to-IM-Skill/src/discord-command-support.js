function trimmedString(value) {
    return typeof value === 'string' ? value.trim() : '';
}
export const DISCORD_SLASH_COMMANDS = [
    {
        name: 'start',
        description: 'Show bridge help and available commands',
        toText: () => '/start',
    },
    {
        name: 'new',
        description: 'Start a new bridge session',
        options: [
            { name: 'path', description: 'Optional working directory', type: 'string' },
        ],
        toText: (options) => {
            const path = trimmedString(options.path);
            return path ? `/new ${path}` : '/new';
        },
    },
    {
        name: 'bind',
        description: 'Bind this chat to an existing session',
        options: [
            { name: 'session_id', description: 'Existing session ID', type: 'string', required: true },
        ],
        toText: (options) => `/bind ${trimmedString(options.session_id)}`,
    },
    {
        name: 'cwd',
        description: 'Change working directory for the current binding',
        options: [
            { name: 'path', description: 'Absolute working directory path', type: 'string', required: true },
        ],
        toText: (options) => `/cwd ${trimmedString(options.path)}`,
    },
    {
        name: 'mode',
        description: 'Change the current bridge mode',
        options: [
            { name: 'value', description: 'One of: plan, code, ask', type: 'string', required: true },
        ],
        toText: (options) => `/mode ${trimmedString(options.value)}`,
    },
    {
        name: 'status',
        description: 'Show the current binding status',
        toText: () => '/status',
    },
    {
        name: 'tasks',
        description: 'List recent bridge tasks',
        toText: () => '/tasks',
    },
    {
        name: 'resume_last',
        description: 'Resume the latest interrupted task',
        toText: () => '/resume_last',
    },
    {
        name: 'sessions',
        description: 'List recent runtime sessions',
        toText: () => '/sessions',
    },
    {
        name: 'lsessions',
        description: 'List bridge sessions across chats',
        options: [
            { name: 'all', description: 'Include archived sessions', type: 'boolean' },
        ],
        toText: (options) => options.all === true ? '/lsessions --all' : '/lsessions',
    },
    {
        name: 'switchto',
        description: 'Switch this chat to a session by ID or name',
        options: [
            { name: 'target', description: 'Session ID or name', type: 'string', required: true },
        ],
        toText: (options) => `/switchto ${trimmedString(options.target)}`,
    },
    {
        name: 'rename',
        description: 'Rename the current session',
        options: [
            { name: 'new_name', description: 'New session name', type: 'string', required: true },
        ],
        toText: (options) => `/rename ${trimmedString(options.new_name)}`,
    },
    {
        name: 'archive',
        description: 'Archive a session and keep its summary',
        options: [
            { name: 'target', description: 'Optional session ID or name', type: 'string' },
        ],
        toText: (options) => {
            const target = trimmedString(options.target);
            return target ? `/archive ${target}` : '/archive';
        },
    },
    {
        name: 'unarchive',
        description: 'Restore an archived session',
        options: [
            { name: 'target', description: 'Session ID or name', type: 'string', required: true },
        ],
        toText: (options) => `/unarchive ${trimmedString(options.target)}`,
    },
    {
        name: 'stop',
        description: 'Stop the current session',
        toText: () => '/stop',
    },
    {
        name: 'perm',
        description: 'Respond to a pending permission request',
        options: [
            { name: 'action', description: 'allow, allow_session, or deny', type: 'string', required: true },
            { name: 'permission_id', description: 'Permission request ID', type: 'string', required: true },
        ],
        toText: (options) => `/perm ${trimmedString(options.action)} ${trimmedString(options.permission_id)}`,
    },
    {
        name: 'help',
        description: 'Show bridge command help',
        toText: () => '/help',
    },
];
export function buildDiscordSlashCommandText(commandName, options = {}) {
    const definition = DISCORD_SLASH_COMMANDS.find((item) => item.name === commandName);
    if (!definition)
        return null;
    return definition.toText(options).trim();
}
//# sourceMappingURL=discord-command-support.js.map