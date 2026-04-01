import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildDiscordSlashCommandText } from '../discord-command-support.js';

describe('discord-command-support', () => {
  it('builds boolean flag commands', () => {
    assert.equal(buildDiscordSlashCommandText('lsessions', {}), '/lsessions');
    assert.equal(buildDiscordSlashCommandText('lsessions', { all: true }), '/lsessions --all');
  });

  it('builds positional session-management commands', () => {
    assert.equal(
      buildDiscordSlashCommandText('switchto', { target: '周报整理' }),
      '/switchto 周报整理',
    );
    assert.equal(
      buildDiscordSlashCommandText('archive', { target: 'abcd1234' }),
      '/archive abcd1234',
    );
    assert.equal(buildDiscordSlashCommandText('archive', {}), '/archive');
  });

  it('returns null for unsupported commands', () => {
    assert.equal(buildDiscordSlashCommandText('missing'), null);
  });
});
