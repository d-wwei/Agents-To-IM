#!/usr/bin/env bash
set -euo pipefail
SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/host-profile.sh
source "$SKILL_DIR/scripts/host-profile.sh"
init_host_profile "$SKILL_DIR"
export CTI_HOST="${CTI_HOST:-$HOST_NAME}"
export CTI_SKILL_COMMAND="${CTI_SKILL_COMMAND:-$SKILL_COMMAND}"
CTI_HOME="${CTI_HOME:-$CTI_HOME_DEFAULT}"
CONFIG_FILE="$CTI_HOME/config.env"
PID_FILE="$CTI_HOME/runtime/bridge.pid"
LOG_FILE="$CTI_HOME/logs/bridge.log"

PASS=0
FAIL=0

check() {
  local label="$1"
  local result="$2"
  if [ "$result" = "0" ]; then
    echo "[OK]   $label"
    PASS=$((PASS + 1))
  else
    echo "[FAIL] $label"
    FAIL=$((FAIL + 1))
  fi
}

# --- Node.js version ---
if command -v node &>/dev/null; then
  NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
  if [ "$NODE_VER" -ge 20 ] 2>/dev/null; then
    check "Node.js >= 20 (found v$(node -v | sed 's/v//'))" 0
  else
    check "Node.js >= 20 (found v$(node -v | sed 's/v//'), need >= 20)" 1
  fi
else
  check "Node.js installed" 1
fi

# --- Read runtime setting ---
CTI_RUNTIME=$(grep "^CTI_RUNTIME=" "$CONFIG_FILE" 2>/dev/null | head -1 | cut -d= -f2- | tr -d "'" | tr -d '"')
CTI_RUNTIME="${CTI_RUNTIME:-claude}"
echo "Runtime: $CTI_RUNTIME"
echo ""

# --- Claude CLI available (claude/auto modes) ---
if [ "$CTI_RUNTIME" = "claude" ] || [ "$CTI_RUNTIME" = "auto" ]; then
  if command -v claude &>/dev/null; then
    CLAUDE_VER=$(claude --version 2>/dev/null || echo "unknown")
    check "Claude CLI available (${CLAUDE_VER})" 0
  else
    if [ "$CTI_RUNTIME" = "claude" ]; then
      check "Claude CLI available (not found in PATH)" 1
    else
      check "Claude CLI available (not found — will use Codex fallback)" 0
    fi
  fi

  # --- SDK cli.js resolvable ---
  SDK_CLI="$SKILL_DIR/node_modules/@anthropic-ai/claude-agent-sdk/cli.js"
  if [ -f "$SDK_CLI" ]; then
    check "Claude SDK cli.js exists ($SDK_CLI)" 0
  else
    if [ "$CTI_RUNTIME" = "claude" ]; then
      check "Claude SDK cli.js exists (not found — run 'npm install' in $SKILL_DIR)" 1
    else
      check "Claude SDK cli.js exists (not found — OK for auto/codex mode)" 0
    fi
  fi
fi

# --- Gemini checks ---
if [ "$CTI_RUNTIME" = "gemini" ]; then
  if command -v gemini &>/dev/null; then
    GEMINI_VER=$(gemini --version 2>/dev/null || echo "unknown")
    check "Gemini CLI available (${GEMINI_VER})" 0
  else
    check "Gemini CLI available (not found in PATH)" 1
  fi

  GEMINI_CFG_KEY=$(grep "^CTI_GEMINI_API_KEY=" "$CONFIG_FILE" 2>/dev/null | head -1 | cut -d= -f2- | tr -d "'" | tr -d '"')
  GOOGLE_CFG_KEY=$(grep "^CTI_GOOGLE_API_KEY=" "$CONFIG_FILE" 2>/dev/null | head -1 | cut -d= -f2- | tr -d "'" | tr -d '"')
  if [ -n "${GEMINI_CFG_KEY:-}" ] || [ -n "${GOOGLE_CFG_KEY:-}" ] || [ -n "${GEMINI_API_KEY:-}" ] || [ -n "${GOOGLE_API_KEY:-}" ]; then
    check "Gemini auth available for headless mode (API key present)" 0
  elif [ -f "$HOME/.gemini/oauth_creds.json" ]; then
    check "Gemini auth available for headless mode (cached OAuth credentials present)" 0
  else
    check "Gemini auth available for headless mode (set CTI_GEMINI_API_KEY / CTI_GOOGLE_API_KEY or login via Gemini CLI)" 1
  fi
fi

# --- Codex checks (codex/auto modes) ---
if [ "$CTI_RUNTIME" = "codex" ] || [ "$CTI_RUNTIME" = "auto" ]; then
  if command -v codex &>/dev/null; then
    CODEX_VER=$(codex --version 2>/dev/null || echo "unknown")
    check "Codex CLI available (${CODEX_VER})" 0
  else
    if [ "$CTI_RUNTIME" = "codex" ]; then
      check "Codex CLI available (not found in PATH)" 1
    else
      check "Codex CLI available (not found — will use Claude)" 0
    fi
  fi

  # Check @openai/codex-sdk
  CODEX_SDK="$SKILL_DIR/node_modules/@openai/codex-sdk"
  if [ -d "$CODEX_SDK" ]; then
    check "@openai/codex-sdk installed" 0
  else
    if [ "$CTI_RUNTIME" = "codex" ]; then
      check "@openai/codex-sdk installed (not found — run 'npm install' in $SKILL_DIR)" 1
    else
      check "@openai/codex-sdk installed (not found — OK for auto/claude mode)" 0
    fi
  fi

  # Check Codex auth: any of CTI_CODEX_API_KEY / CODEX_API_KEY / OPENAI_API_KEY,
  # or `codex login status` showing logged-in (interactive login).
  CODEX_AUTH=1
  if [ -n "${CTI_CODEX_API_KEY:-}" ] || [ -n "${CODEX_API_KEY:-}" ] || [ -n "${OPENAI_API_KEY:-}" ]; then
    CODEX_AUTH=0
  elif command -v codex &>/dev/null; then
    CODEX_AUTH_OUT=$(codex login status 2>&1 || true)
    if echo "$CODEX_AUTH_OUT" | grep -qiE 'logged in|authenticated'; then
      CODEX_AUTH=0
    fi
  fi
  if [ "$CODEX_AUTH" = "0" ]; then
    check "Codex auth available (API key or login)" 0
  else
    if [ "$CTI_RUNTIME" = "codex" ]; then
      check "Codex auth available (set OPENAI_API_KEY or run 'codex auth login')" 1
    else
      check "Codex auth available (not found — needed only for Codex fallback)" 0
    fi
  fi
fi

# --- dist/daemon.mjs freshness ---
DAEMON_MJS="$SKILL_DIR/dist/daemon.mjs"
if [ -f "$DAEMON_MJS" ]; then
  STALE_SRC=$(find "$SKILL_DIR/src" -name '*.ts' -newer "$DAEMON_MJS" 2>/dev/null | head -1)
  if [ -z "$STALE_SRC" ]; then
    check "dist/daemon.mjs is up to date" 0
  else
    check "dist/daemon.mjs is stale (src changed, run 'npm run build')" 1
  fi
else
  check "dist/daemon.mjs exists (not built — run 'npm run build')" 1
fi

# --- config.env exists ---
if [ -f "$CONFIG_FILE" ]; then
  check "config.env exists" 0
else
  check "config.env exists ($CONFIG_FILE not found)" 1
fi

# --- config.env permissions ---
if [ -f "$CONFIG_FILE" ]; then
  PERMS=$(stat -f "%Lp" "$CONFIG_FILE" 2>/dev/null || stat -c "%a" "$CONFIG_FILE" 2>/dev/null || echo "unknown")
  if [ "$PERMS" = "600" ]; then
    check "config.env permissions are 600" 0
  else
    check "config.env permissions are 600 (currently $PERMS)" 1
  fi
fi

# --- Load config for channel checks ---
get_config() { grep "^$1=" "$CONFIG_FILE" 2>/dev/null | head -1 | cut -d= -f2- | sed 's/^["'"'"']//;s/["'"'"']$//'; }

if [ -f "$CONFIG_FILE" ]; then
  CTI_CHANNELS=$(get_config CTI_ENABLED_CHANNELS)

  # --- Telegram ---
  if echo "$CTI_CHANNELS" | grep -q telegram; then
    TG_TOKEN=$(get_config CTI_TG_BOT_TOKEN)
    if [ -n "$TG_TOKEN" ]; then
      TG_RESULT=$(curl -s --max-time 5 "https://api.telegram.org/bot${TG_TOKEN}/getMe" 2>/dev/null || echo '{"ok":false}')
      if echo "$TG_RESULT" | grep -q '"ok":true'; then
        check "Telegram bot token is valid" 0
      else
        check "Telegram bot token is valid (getMe failed)" 1
      fi
    else
      check "Telegram bot token configured" 1
    fi
  fi

  # --- Feishu ---
  if echo "$CTI_CHANNELS" | grep -q feishu; then
    FS_APP_ID=$(get_config CTI_FEISHU_APP_ID)
    FS_SECRET=$(get_config CTI_FEISHU_APP_SECRET)
    FS_DOMAIN=$(get_config CTI_FEISHU_DOMAIN)
    FS_DOMAIN="${FS_DOMAIN:-https://open.feishu.cn}"
    if [ -n "$FS_APP_ID" ] && [ -n "$FS_SECRET" ]; then
      FEISHU_RESULT=$(curl -s --max-time 5 -X POST "${FS_DOMAIN}/open-apis/auth/v3/tenant_access_token/internal" \
        -H "Content-Type: application/json" \
        -d "{\"app_id\":\"${FS_APP_ID}\",\"app_secret\":\"${FS_SECRET}\"}" 2>/dev/null || echo '{"code":1}')
      if echo "$FEISHU_RESULT" | grep -q '"code"[[:space:]]*:[[:space:]]*0'; then
        check "Feishu app credentials are valid" 0
      else
        check "Feishu app credentials are valid (token request failed)" 1
      fi
    else
      check "Feishu app credentials configured" 1
    fi
  fi

  # --- Discord ---
  if echo "$CTI_CHANNELS" | grep -q discord; then
    DC_TOKEN=$(get_config CTI_DISCORD_BOT_TOKEN)
    if [ -n "$DC_TOKEN" ]; then
      if echo "${DC_TOKEN}" | grep -qE '^[A-Za-z0-9_-]{20,}\.'; then
        check "Discord bot token format" 0
      else
        check "Discord bot token format (does not match expected pattern)" 1
      fi
    else
      check "Discord bot token configured" 1
    fi
  fi
fi

# --- Log directory writable ---
LOG_DIR="$CTI_HOME/logs"
if [ -d "$LOG_DIR" ] && [ -w "$LOG_DIR" ]; then
  check "Log directory is writable" 0
else
  check "Log directory is writable ($LOG_DIR)" 1
fi

# --- PID file consistency ---
if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE")
  if [ "$(uname -s)" = "Darwin" ] && launchctl print "gui/$(id -u)/$LAUNCHD_LABEL_DEFAULT" >/dev/null 2>&1; then
    LC_PID=$(launchctl print "gui/$(id -u)/$LAUNCHD_LABEL_DEFAULT" 2>/dev/null | grep -m1 'pid = ' | sed 's/.*pid = //' | tr -d ' ')
    if [ -n "$LC_PID" ] && [ "$LC_PID" != "0" ] && [ "$LC_PID" != "-" ]; then
      check "PID file consistent (launchd reports process $LC_PID is running)" 0
    else
      check "PID file consistent (launchd service has no live pid)" 1
    fi
  elif kill -0 "$PID" 2>/dev/null; then
    check "PID file consistent (process $PID is running)" 0
  else
    check "PID file consistent (stale PID $PID, process not running)" 1
  fi
else
  check "PID file consistency (no PID file, OK)" 0
fi

# --- Recent errors in log ---
if [ -f "$LOG_FILE" ]; then
  RECENT_LOG=$(awk '
    /\[claude-to-im\] Starting bridge \(run_id:/ { buffer = "" }
    /\[[a-z0-9-]+-to-im\] Starting bridge \(run_id:/ { buffer = "" }
    { buffer = buffer $0 "\n" }
    END { printf "%s", buffer }
  ' "$LOG_FILE")
  ERROR_COUNT=$(printf "%s" "$RECENT_LOG" | grep -iE 'ERROR|Fatal' | grep -vic 'DeprecationWarning' || true)
  if [ "$ERROR_COUNT" -eq 0 ]; then
    check "No recent errors in log (since last bridge start)" 0
  else
    check "No recent errors in log (found $ERROR_COUNT ERROR/Fatal lines)" 1
  fi
else
  check "Log file exists (not yet created)" 0
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"

if [ "$FAIL" -gt 0 ]; then
  echo ""
  echo "Common fixes:"
  echo "  SDK cli.js missing    → cd $SKILL_DIR && npm install"
  echo "  dist/daemon.mjs stale → cd $SKILL_DIR && npm run build"
  echo "  config.env missing    → run setup wizard"
  echo "  Gemini auth missing   → login in Gemini CLI once outside the sandbox or set CTI_GEMINI_API_KEY / CTI_GOOGLE_API_KEY"
  echo "  Stale PID file        → run stop, then start"
fi

[ "$FAIL" -eq 0 ] && exit 0 || exit 1
