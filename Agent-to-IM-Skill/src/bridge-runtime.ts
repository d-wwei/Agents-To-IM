// Re-export bridge modules for use by session-command-support and voice-reply.
// These are imported directly from source since the agent-to-im package
// is bundled by esbuild at build time.
export { getBridgeContext, initBridgeContext } from 'agent-to-im-core/src/lib/bridge/context.js';
export * as router from 'agent-to-im-core/src/lib/bridge/channel-router.js';
export { escapeHtml } from 'agent-to-im-core/src/lib/bridge/adapters/telegram-utils.js';
