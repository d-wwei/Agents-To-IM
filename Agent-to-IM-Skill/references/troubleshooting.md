# Troubleshooting

## Bridge won't start

**Symptoms**: `/claude-to-im start` fails or daemon exits immediately.

**Steps**:

1. Run `/claude-to-im doctor` to identify the issue
2. Check that Node.js >= 20 is installed: `node --version`
3. Check that the CLI required by your selected runtime is available
4. Verify config exists: `ls -la ~/.claude-to-im/config.env`
5. Check logs for startup errors: `/claude-to-im logs`

**Common causes**:
- Missing or invalid config.env -- run `/claude-to-im setup`
- Node.js not found or wrong version -- install Node.js >= 20
- Port or resource conflict -- check if another instance is running with `/claude-to-im status`

## Messages not received

**Symptoms**: Bot is online but doesn't respond to messages.

**Steps**:

1. Verify the bot token is valid: `/claude-to-im doctor`
2. Check allowed user IDs in config -- if set, only listed users can interact
3. For Telegram: ensure you've sent `/start` to the bot first
4. For Discord: verify the bot has been invited to the server with message read permissions
5. For Feishu: confirm the app has been approved and event subscriptions are configured
6. Check logs for incoming message events: `/claude-to-im logs 200`

## Permission timeout

**Symptoms**: A host-agent session starts but times out waiting for tool approval.

**Steps**:

1. The bridge runs the selected host agent in non-interactive mode; ensure that host configuration allows the necessary tools
2. Consider using `--allowedTools` in your configuration to pre-approve common tools
3. Check network connectivity if the timeout occurs during API calls

## High memory usage

**Symptoms**: The daemon process consumes increasing memory over time.

**Steps**:

1. Check current memory usage: `/claude-to-im status`
2. Restart the daemon to reset memory:
   ```
   /claude-to-im stop
   /claude-to-im start
   ```
3. If the issue persists, check how many concurrent sessions are active -- each host-agent session consumes memory
4. Review logs for error loops that may cause memory leaks

## CLI output was not valid JSON

**Symptom:** Error in logs:
```
SDK query error: Error: CLI output was not valid JSON. This may indicate an error during startup. Output: init done
```

**Cause:** Some custom Claude CLI builds (e.g., enterprise proxy wrappers) print non-JSON text to stdout during initialization. The Claude Agent SDK expects pure JSON on stdout, so any extra output corrupts the communication.

**Auto-fix:** Since v0.1.x, the bridge automatically detects stdout pollution during preflight and generates a wrapper script that suppresses it. Check the logs for:
```
CLI stdout pollution detected ("init done"), using wrapper: ~/.claude-to-im/cli-wrapper.sh
```

**Manual fix:** If auto-detection doesn't work, set `CTI_CLI_SUPPRESS_STDOUT` in your `config.env`:
```
CTI_CLI_SUPPRESS_STDOUT=init done
```
Multiple patterns can be comma-separated.

**Alternative:** Create a manual wrapper script. See the generated `~/.claude-to-im/cli-wrapper.sh` for an example.

## Stale PID file

**Symptoms**: Status shows "running" but the process doesn't exist, or start refuses because it thinks a daemon is already running.

The daemon management script (`daemon.sh`) handles stale PID files automatically. If you still encounter issues:

1. Run `/claude-to-im stop` -- it will clean up the stale PID file
2. If stop also fails, manually remove the PID file:
   ```bash
   rm ~/.claude-to-im/runtime/bridge.pid
   ```
3. Run `/claude-to-im start` to launch a fresh instance
