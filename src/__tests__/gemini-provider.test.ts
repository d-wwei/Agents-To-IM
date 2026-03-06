import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseUsage, renderConversationPrompt, toApprovalMode } from '../gemini-provider.js';

describe('GeminiProvider helpers', () => {
  it('maps bridge permission modes to Gemini approval modes', () => {
    assert.equal(toApprovalMode('acceptEdits', false), 'auto_edit');
    assert.equal(toApprovalMode('plan', false), 'plan');
    assert.equal(toApprovalMode('default', false), 'default');
    assert.equal(toApprovalMode('default', true), 'yolo');
  });

  it('builds a prompt with system prompt, history, and attachments', () => {
    const prompt = renderConversationPrompt({
      prompt: 'What changed?',
      sessionId: 's1',
      systemPrompt: 'Be concise.',
      conversationHistory: [
        { role: 'user', content: 'Inspect the repo.' },
        { role: 'assistant', content: 'I found two changed files.' },
      ],
    }, ['/tmp/a.txt', '/tmp/b.png']);

    assert.match(prompt, /System instructions:/);
    assert.match(prompt, /Conversation history:/);
    assert.match(prompt, /User:\n\nInspect the repo\./);
    assert.match(prompt, /Assistant:\n\nI found two changed files\./);
    assert.match(prompt, /@\/tmp\/a.txt/);
    assert.match(prompt, /Latest user message:\n\nWhat changed\?/);
  });

  it('normalizes Gemini stream usage payloads', () => {
    assert.deepEqual(parseUsage({
      inputTokenCount: 10,
      outputTokenCount: 4,
      cachedContentTokenCount: 2,
    }), {
      input_tokens: 10,
      output_tokens: 4,
      cache_read_input_tokens: 2,
    });
  });
});
