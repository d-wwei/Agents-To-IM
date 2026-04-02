# Usage Guide

This skill works with both slash-command hosts and natural-language hosts. Examples below use the current skill command; hosts without slash commands can use equivalent natural-language triggers such as "start bridge", "配置", or "诊断".

## setup

Interactive wizard that configures the bridge.

```
/codex-to-im setup
```

The wizard will prompt you for:

1. **Channels to enable** -- Enter comma-separated values: `telegram`, `discord`, `feishu`
2. **Platform credentials** -- Bot tokens, app IDs, and secrets for each enabled channel
3. **Allowed users** (optional) -- Restrict which users can interact with the bot
4. **Working directory** -- Default project directory for host-agent sessions
5. **Model and mode** -- Claude model and interaction mode (code/plan/ask)

After collecting input, the wizard validates tokens by calling each platform's API and reports results.

Example interaction:

```
> /codex-to-im setup
Which channels to enable? telegram,discord
Enter Telegram bot token: <your-token>
Enter Discord bot token: <your-token>
Default working directory [/current/dir]: /Users/me/projects
Model [claude-sonnet-4-20250514]:
Mode [code]:

Validating tokens...
  Telegram: OK (bot @MyBotName)
  Discord: OK (format valid)

Config written to ~/.codex-to-im/config.env
```

## start

Starts the bridge daemon in the background.

```
/codex-to-im start
```

The daemon process ID is stored in `~/.codex-to-im/runtime/bridge.pid`. If the daemon is already running, the command reports the existing process.

If startup fails, run `/codex-to-im doctor` to diagnose issues.

Approval behavior depends on runtime:
- Claude runtime: tool-level approval requests can be forwarded to IM.
- Codex runtime: when `CTI_CODEX_APPROVAL_POLICY=on-request`, the bridge sends a pre-turn approval request before the Codex turn starts.

## stop

Stops the running bridge daemon.

```
/codex-to-im stop
```

Sends SIGTERM to the daemon process and cleans up the PID file.

## status

Shows whether the daemon is running and basic health information.

```
/codex-to-im status
```

Output includes:
- Running/stopped state
- PID (if running)
- Uptime
- Connected channels

## logs

Shows recent log output from the daemon.

```
/codex-to-im logs        # Last 50 lines (default)
/codex-to-im logs 200    # Last 200 lines
```

Logs are stored in `~/.codex-to-im/logs/` and are automatically redacted to mask secrets.

## reconfigure

Interactively update the current configuration.

```
/codex-to-im reconfigure
```

Displays current settings with secrets masked, then prompts for changes. After updating, you must restart the daemon for changes to take effect:

```
/codex-to-im stop
/codex-to-im start
```

## doctor

Runs diagnostic checks and reports issues.

```
/codex-to-im doctor
```

Checks performed:
- Node.js version (>= 20 required)
- Required host CLI availability for the selected runtime
- Config file exists and has correct permissions
- Required tokens are set for enabled channels
- Token validity (API calls)
- Daemon process health
- Log directory writability

## QQ notes

QQ currently supports **C2C private chat only**:
- No inline approval buttons — permissions use text `/perm ...` commands
- No streaming preview
- Image inbound only (no image replies)
- No group/channel support yet
- Required config: `CTI_QQ_APP_ID`, `CTI_QQ_APP_SECRET` (obtain from https://q.qq.com/qqbot/openclaw)
- `CTI_QQ_ALLOWED_USERS` takes `user_openid` values, not QQ numbers
- Set `CTI_QQ_IMAGE_ENABLED=false` if the provider doesn't support image input

## IM session commands

Inside IM chats, the bridge also supports built-in session-management commands:

```
/lsessions
/lsessions --all
/switchto <session_id|name>
/rename <new_name>
/archive [session_id|name]
/unarchive <session_id|name>
```

Behavior summary:
- `/lsessions` lists active sessions; `--all` includes archived sessions
- `/switchto` rebinds the current IM chat to a previous session by ID or assigned name
- `/rename` assigns a friendly name to the current session
- `/archive` stores a short summary and hides the session from the default list
- `/unarchive` restores an archived session

These commands are handled at the bridge layer, so they work consistently across Claude, Codex, and Gemini host variants.
