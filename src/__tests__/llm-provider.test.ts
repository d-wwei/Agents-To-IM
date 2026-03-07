import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { __testOnly } from '../llm-provider.js';

function createController() {
  const chunks: string[] = [];
  return {
    chunks,
    controller: {
      enqueue(value: string) {
        chunks.push(value);
      },
    } as unknown as ReadableStreamDefaultController<string>,
  };
}

describe('llm-provider stream dedupe', () => {
  it('does not emit final assistant text again after text deltas', () => {
    const { chunks, controller } = createController();
    const state = { sawTextDelta: false, seenToolUseIds: new Set<string>() };

    __testOnly.handleMessage({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'hello' },
      },
    } as never, controller, state);

    __testOnly.handleMessage({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'hello' }],
      },
    } as never, controller, state);

    assert.equal(chunks.length, 1);
    assert.match(chunks[0], /"type":"text"/);
    assert.match(chunks[0], /hello/);
  });

  it('does not emit duplicate tool_use blocks from final assistant payload', () => {
    const { chunks, controller } = createController();
    const state = { sawTextDelta: false, seenToolUseIds: new Set<string>() };

    __testOnly.handleMessage({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        content_block: {
          type: 'tool_use',
          id: 'tool-1',
          name: 'Bash',
        },
      },
    } as never, controller, state);

    __testOnly.handleMessage({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: {} }],
      },
    } as never, controller, state);

    assert.equal(chunks.length, 1);
    assert.match(chunks[0], /"type":"tool_use"/);
    assert.match(chunks[0], /tool-1/);
  });

  it('still emits assistant text when no deltas were streamed', () => {
    const { chunks, controller } = createController();
    const state = { sawTextDelta: false, seenToolUseIds: new Set<string>() };

    __testOnly.handleMessage({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'final-only' }],
      },
    } as never, controller, state);

    assert.equal(chunks.length, 1);
    assert.match(chunks[0], /final-only/);
  });
});
