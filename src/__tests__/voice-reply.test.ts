import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const CONTEXT_KEY = '__bridge_context__';

describe('voice reply helpers', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    (globalThis as Record<string, unknown>)[CONTEXT_KEY] = {
      store: {
        getSetting(key: string) {
          const map: Record<string, string> = {
            bridge_elevenlabs_api_key: 'test-key',
            bridge_elevenlabs_voice_id: 'voice-id',
            bridge_elevenlabs_model_id: 'eleven_multilingual_v2',
          };
          return map[key] || '';
        },
      },
    };
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete (globalThis as Record<string, unknown>)[CONTEXT_KEY];
  });

  it('detects explicit voice reply requests', async () => {
    const { wantsVoiceReply } = await import('../voice-reply.js');
    assert.equal(wantsVoiceReply('请用语音回复我'), true);
    assert.equal(wantsVoiceReply('Can you reply in voice?'), true);
    assert.equal(wantsVoiceReply('普通文字回答就行'), false);
  });

  it('returns setup guidance when ElevenLabs config is missing', async () => {
    (globalThis as Record<string, unknown>)[CONTEXT_KEY] = {
      store: {
        getSetting() {
          return '';
        },
      },
    };

    const { prepareVoiceReply } = await import('../voice-reply.js');
    const result = await prepareVoiceReply('hello');
    assert.equal(result.status, 'needs_config');
    if (result.status === 'needs_config') {
      assert.match(result.noteText, /CTI_ELEVENLABS_API_KEY/);
      assert.match(result.noteText, /不要把 API key 直接发到聊天里/);
    }
  });

  it('calls ElevenLabs and returns an audio attachment when configured', async () => {
    global.fetch = (async () => new Response(Buffer.from('mp3-bytes'), {
      status: 200,
      headers: { 'Content-Type': 'audio/mpeg' },
    })) as typeof fetch;

    const { prepareVoiceReply } = await import('../voice-reply.js');
    const result = await prepareVoiceReply('请朗读这一段');
    assert.equal(result.status, 'ready');
    if (result.status === 'ready') {
      assert.equal(result.attachment.fileName, 'voice-reply.mp3');
      assert.equal(result.attachment.mimeType, 'audio/mpeg');
      assert.equal(result.attachment.data.toString(), 'mp3-bytes');
    }
  });
});
