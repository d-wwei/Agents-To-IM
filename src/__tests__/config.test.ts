import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expandShellVars, maskSecret, configToSettings, type Config } from '../config.js';
import { buildHostProfile, inferHostFromPath, inferHostFromSkillCommand } from '../host-profile.js';

// ── maskSecret ──

describe('maskSecret', () => {
  it('masks short values entirely', () => {
    assert.equal(maskSecret('abc'), '****');
    assert.equal(maskSecret('abcd'), '****');
    assert.equal(maskSecret(''), '****');
  });

  it('preserves last 4 chars for longer values', () => {
    assert.equal(maskSecret('12345678'), '****5678');
    assert.equal(maskSecret('secret-token-abcd'), '*************abcd');
  });

  it('handles exactly 5 chars', () => {
    assert.equal(maskSecret('12345'), '*2345');
  });
});

// ── configToSettings ──

describe('configToSettings', () => {
  const base: Config = {
    runtime: 'claude',
    enabledChannels: [],
    defaultWorkDir: '/tmp/test',
    defaultMode: 'code',
  };

  it('always sets remote_bridge_enabled to true', () => {
    const m = configToSettings(base);
    assert.equal(m.get('remote_bridge_enabled'), 'true');
  });

  it('sets channel enabled flags based on enabledChannels', () => {
    const m = configToSettings({ ...base, enabledChannels: ['telegram', 'discord'] });
    assert.equal(m.get('bridge_telegram_enabled'), 'true');
    assert.equal(m.get('bridge_discord_enabled'), 'true');
    assert.equal(m.get('bridge_feishu_enabled'), 'false');
  });

  it('maps telegram config', () => {
    const m = configToSettings({
      ...base,
      enabledChannels: ['telegram'],
      tgBotToken: 'bot123:abc',
      tgAllowedUsers: ['user1', 'user2'],
      tgChatId: '99999',
    });
    assert.equal(m.get('telegram_bot_token'), 'bot123:abc');
    assert.equal(m.get('telegram_bridge_allowed_users'), 'user1,user2');
    assert.equal(m.get('telegram_chat_id'), '99999');
  });

  it('maps discord config', () => {
    const m = configToSettings({
      ...base,
      enabledChannels: ['discord'],
      discordBotToken: 'discord-token',
      discordAllowedUsers: ['u1'],
      discordAllowedChannels: ['c1', 'c2'],
      discordAllowedGuilds: ['g1'],
    });
    assert.equal(m.get('bridge_discord_bot_token'), 'discord-token');
    assert.equal(m.get('bridge_discord_allowed_users'), 'u1');
    assert.equal(m.get('bridge_discord_allowed_channels'), 'c1,c2');
    assert.equal(m.get('bridge_discord_allowed_guilds'), 'g1');
  });

  it('maps feishu config', () => {
    const m = configToSettings({
      ...base,
      enabledChannels: ['feishu'],
      openaiApiKey: 'openai-key',
      feishuAppId: 'app-id',
      feishuAppSecret: 'app-secret',
      feishuDomain: 'example.com',
      feishuAllowedUsers: ['fu1'],
      feishuAudioTranscribe: false,
      audioTranscoder: '/usr/local/bin/ffmpeg',
      elevenLabsApiKey: 'elevenlabs-key',
      elevenLabsVoiceId: 'voice-id',
      elevenLabsModelId: 'eleven-multilingual-v2',
    });
    assert.equal(m.get('bridge_feishu_app_id'), 'app-id');
    assert.equal(m.get('bridge_feishu_app_secret'), 'app-secret');
    assert.equal(m.get('bridge_feishu_domain'), 'example.com');
    assert.equal(m.get('bridge_feishu_allowed_users'), 'fu1');
    assert.equal(m.get('bridge_feishu_audio_transcribe'), 'false');
    assert.equal(m.get('bridge_audio_transcoder'), '/usr/local/bin/ffmpeg');
    assert.equal(m.get('bridge_elevenlabs_api_key'), 'elevenlabs-key');
    assert.equal(m.get('bridge_elevenlabs_voice_id'), 'voice-id');
    assert.equal(m.get('bridge_elevenlabs_model_id'), 'eleven-multilingual-v2');
    assert.equal(m.get('bridge_openai_api_key'), 'openai-key');
  });

  it('sets bridge_qq_enabled based on enabledChannels', () => {
    const m = configToSettings({ ...base, enabledChannels: ['qq'] });
    assert.equal(m.get('bridge_qq_enabled'), 'true');
    assert.equal(m.get('bridge_telegram_enabled'), 'false');
  });

  it('defaults bridge_qq_enabled to false', () => {
    const m = configToSettings(base);
    assert.equal(m.get('bridge_qq_enabled'), 'false');
  });

  it('maps qq config fields', () => {
    const m = configToSettings({
      ...base,
      enabledChannels: ['qq'],
      qqAppId: 'qq-app-id',
      qqAppSecret: 'qq-secret',
      qqAllowedUsers: ['openid1', 'openid2'],
    });
    assert.equal(m.get('bridge_qq_app_id'), 'qq-app-id');
    assert.equal(m.get('bridge_qq_app_secret'), 'qq-secret');
    assert.equal(m.get('bridge_qq_allowed_users'), 'openid1,openid2');
  });

  it('maps qq image settings', () => {
    const m = configToSettings({
      ...base,
      enabledChannels: ['qq'],
      qqAppId: 'id',
      qqAppSecret: 'secret',
      qqImageEnabled: false,
      qqMaxImageSize: 10,
    });
    assert.equal(m.get('bridge_qq_image_enabled'), 'false');
    assert.equal(m.get('bridge_qq_max_image_size'), '10');
  });

  it('omits qq image settings when not set', () => {
    const m = configToSettings({
      ...base,
      enabledChannels: ['qq'],
      qqAppId: 'id',
      qqAppSecret: 'secret',
    });
    assert.equal(m.has('bridge_qq_image_enabled'), false);
    assert.equal(m.has('bridge_qq_max_image_size'), false);
  });

  it('maps workdir and mode, omits model when not set', () => {
    const m = configToSettings(base);
    assert.equal(m.get('bridge_default_work_dir'), '/tmp/test');
    assert.equal(m.has('bridge_default_model'), false);
    assert.equal(m.has('default_model'), false);
    assert.equal(m.get('bridge_default_mode'), 'code');
  });

  it('maps model when explicitly set', () => {
    const m = configToSettings({ ...base, defaultModel: 'gpt-4o' });
    assert.equal(m.get('bridge_default_model'), 'gpt-4o');
    assert.equal(m.get('default_model'), 'gpt-4o');
  });

  it('maps non-default mode', () => {
    const m = configToSettings({ ...base, defaultMode: 'plan' });
    assert.equal(m.get('bridge_default_mode'), 'plan');
  });

  it('omits optional fields when not set', () => {
    const m = configToSettings(base);
    assert.equal(m.has('telegram_bot_token'), false);
    assert.equal(m.has('bridge_discord_bot_token'), false);
    assert.equal(m.has('bridge_feishu_app_id'), false);
    assert.equal(m.get('bridge_feishu_audio_transcribe'), 'true');
    assert.equal(m.has('bridge_audio_transcoder'), false);
    assert.equal(m.has('bridge_elevenlabs_api_key'), false);
    assert.equal(m.has('bridge_elevenlabs_voice_id'), false);
    assert.equal(m.has('bridge_elevenlabs_model_id'), false);
    assert.equal(m.has('bridge_openai_api_key'), false);
  });
});

// ── Config file parsing (loadConfig/saveConfig round-trip) ──

describe('loadConfig/saveConfig round-trip', () => {
  let tmpDir: string;
  let origHome: string;
  let origCtiHome: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-config-test-'));
    origHome = process.env.HOME || '';
    origCtiHome = process.env.CTI_HOME;
    // We can't easily override CTI_HOME since it's a const,
    // so we test the parsing logic indirectly through configToSettings
  });

  afterEach(() => {
    process.env.HOME = origHome;
    if (origCtiHome === undefined) {
      delete process.env.CTI_HOME;
    } else {
      process.env.CTI_HOME = origCtiHome;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('configToSettings returns correct defaults', () => {
    const m = configToSettings({
      runtime: 'claude',
      enabledChannels: [],
      defaultWorkDir: process.cwd(),
      defaultMode: 'code',
    });
    assert.equal(m.get('bridge_telegram_enabled'), 'false');
    assert.equal(m.get('bridge_discord_enabled'), 'false');
    assert.equal(m.get('bridge_feishu_enabled'), 'false');
    assert.equal(m.get('bridge_qq_enabled'), 'false');
  });

  it('preserves codex execution overrides when saving and loading config', async () => {
    process.env.CTI_HOME = tmpDir;
    const mod = await import(`../config.js?roundtrip=${Date.now()}`);

    mod.saveConfig({
      runtime: 'codex',
      enabledChannels: ['discord'],
      defaultWorkDir: '/tmp/project',
      defaultMode: 'code',
      codexSkipGitRepoCheck: true,
      codexExecutable: '/Users/test/.local/bin/codex-full',
      codexSandboxMode: 'danger-full-access',
      codexApprovalPolicy: 'never',
    });

    const loaded = mod.loadConfig();
    assert.equal(loaded.codexExecutable, '/Users/test/.local/bin/codex-full');
    assert.equal(loaded.codexSandboxMode, 'danger-full-access');
    assert.equal(loaded.codexApprovalPolicy, 'never');
  });
});

describe('expandShellVars', () => {
  it('expands the supported $HOME and $CWD placeholders', () => {
    const expanded = expandShellVars('$HOME/project:${CWD}:${HOME}:${PWD}');
    assert.ok(expanded.startsWith(`${os.homedir()}/project:`));
    assert.ok(expanded.includes(`:${process.cwd()}:`));
    assert.ok(expanded.includes(`:${os.homedir()}:`));
    assert.ok(expanded.endsWith(':${PWD}'));
  });
});

describe('host profile', () => {
  it('infers host from skill command', () => {
    assert.equal(inferHostFromSkillCommand('codex-to-im'), 'codex');
    assert.equal(inferHostFromSkillCommand('gemini-to-im'), 'gemini');
    assert.equal(inferHostFromSkillCommand('not-a-skill'), undefined);
  });

  it('infers host from runtime path basename', () => {
    assert.equal(inferHostFromPath('/tmp/.claude-to-im'), 'claude');
    assert.equal(inferHostFromPath('/tmp/.gemini-to-im'), 'gemini');
  });

  it('builds host-specific defaults', () => {
    const profile = buildHostProfile('gemini');
    assert.equal(profile.skillCommand, 'gemini-to-im');
    assert.equal(profile.runtimeHomeName, '.gemini-to-im');
    assert.equal(profile.launchdLabel, 'com.gemini-to-im.bridge');
    assert.equal(profile.serviceName, 'GeminiToIMBridge');
  });
});
