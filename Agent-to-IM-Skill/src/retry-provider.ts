/**
 * RetryingLLMProvider — wraps any LLMProvider and auto-retries when the
 * Anthropic API rejects a resumed session due to expired thinking-block
 * signatures (400 "Invalid signature in thinking block").
 *
 * On detection:
 *  1. Clear the stored sdk_session_id for the session.
 *  2. Retry the same request without the sdkSessionId (starts a fresh session).
 *  3. Suppress the error event so the user sees the response, not an error.
 */

import type { LLMProvider, StreamChatParams } from 'agent-to-im-core/src/lib/bridge/host.js';
import type { JsonFileStore } from './store.js';

const THINKING_SIG_ERROR = 'Invalid signature in thinking block';

function containsThinkingBlockError(chunk: string): boolean {
  const lines = chunk.split('\n');
  for (const line of lines) {
    if (!line.startsWith('data: ')) continue;
    try {
      const event = JSON.parse(line.slice(6)) as { type: string; data: string };
      if (event.type === 'error' && typeof event.data === 'string' && event.data.includes(THINKING_SIG_ERROR)) {
        return true;
      }
    } catch {
      // ignore malformed lines
    }
  }
  return false;
}

export class RetryingLLMProvider implements LLMProvider {
  constructor(
    private readonly underlying: LLMProvider,
    private readonly store: JsonFileStore,
  ) {}

  streamChat(params: StreamChatParams): ReadableStream<string> {
    const { underlying, store } = this;
    return new ReadableStream<string>({
      start(controller) {
        run(false);

        async function run(isRetry: boolean): Promise<void> {
          const effectiveParams = isRetry ? { ...params, sdkSessionId: undefined } : params;
          const inner = underlying.streamChat(effectiveParams);
          const reader = inner.getReader();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;

              // Only attempt one retry and only when we had a session to resume
              if (!isRetry && params.sdkSessionId && containsThinkingBlockError(value)) {
                console.warn(
                  '[retry-provider] Detected expired thinking-block signature for session',
                  params.sessionId,
                  '— clearing sdk_session_id and retrying without resume',
                );
                store.updateSdkSessionId(params.sessionId, '');
                // Drain remaining inner stream (fire-and-forget)
                reader.cancel().catch(() => {});
                run(true);
                return;
              }

              controller.enqueue(value);
            }
            controller.close();
          } catch (err) {
            if (!controller.desiredSize && controller.desiredSize !== 0) return; // already closed
            controller.error(err);
          }
        }
      },
    });
  }
}
