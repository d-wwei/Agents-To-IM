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

function makeFile(type: string, data: string, name = 'test-file') {
  return { id: `file-${Date.now()}`, name, type, size: data.length, data };
}

describe('llm-provider prompt building', () => {
  it('appends local file paths for non-image attachments', () => {
    const built = __testOnly.buildPrompt('Inspect these files', [
      makeFile('text/plain', 'aGVsbG8=', 'notes.txt'),
      makeFile('application/json', 'e30=', 'payload.json'),
    ]);

    assert.equal(typeof built.prompt, 'string');
    const text = built.prompt as string;
    assert.match(text, /^Inspect these files/);
    assert.match(text, /Attached local files:/);
    assert.match(text, /@.*notes\.txt/);
    assert.match(text, /@.*payload\.json/);

    built.cleanup();
  });

  it('keeps images as multimodal blocks and injects non-image file paths into text', async () => {
    const built = __testOnly.buildPrompt('Review the inputs', [
      makeFile('image/png', 'cG5n', 'diagram.png'),
      makeFile('text/plain', 'dGV4dA==', 'readme.md'),
    ]);

    assert.notEqual(typeof built.prompt, 'string');

    const messages: unknown[] = [];
    for await (const msg of built.prompt as AsyncIterable<unknown>) {
      messages.push(msg);
    }

    assert.equal(messages.length, 1);
    const first = messages[0] as { message: { content: Array<Record<string, unknown>> } };
    const blocks = first.message.content;
    assert.equal(blocks[0].type, 'image');
    assert.equal(blocks[1].type, 'text');
    assert.match(String(blocks[1].text), /^Review the inputs/);
    assert.match(String(blocks[1].text), /Attached local files:/);
    assert.match(String(blocks[1].text), /@.*readme\.md/);

    built.cleanup();
  });
});
