import type { ChannelAddress } from 'agent-to-im-core/dist/lib/bridge/types.js';
export declare function tryHandleSessionManagementCommand(input: {
    command: string;
    args: string;
    address: ChannelAddress;
}): Promise<string | null>;
//# sourceMappingURL=session-command-support.d.ts.map