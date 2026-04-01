#!/usr/bin/env bash
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/host-profile.sh
source "$SKILL_DIR/scripts/host-profile.sh"
init_host_profile "$SKILL_DIR"

CTI_HOME="${CTI_HOME:-$CTI_HOME_DEFAULT}"
CONFIG_FILE="$CTI_HOME/config.env"

usage() {
  cat <<EOF
Usage: permissions.sh {show|safe|full}

  show  Show current Codex permission profile
  safe  Set Codex bridge sessions to workspace-write + on-request
  full  Set Codex bridge sessions to danger-full-access + never
EOF
}

require_config() {
  if [ ! -f "$CONFIG_FILE" ]; then
    echo "No config found at $CONFIG_FILE"
    exit 1
  fi
}

read_value() {
  local key="$1"
  grep "^${key}=" "$CONFIG_FILE" 2>/dev/null | tail -1 | cut -d= -f2-
}

upsert_key() {
  local file="$1"
  local key="$2"
  local value="$3"
  if grep -q "^${key}=" "$file" 2>/dev/null; then
    awk -v key="$key" -v value="$value" '
      BEGIN { updated = 0 }
      $0 ~ ("^" key "=") {
        if (!updated) {
          print key "=" value
          updated = 1
        }
        next
      }
      { print }
      END {
        if (!updated) print key "=" value
      }
    ' "$file" > "${file}.tmp"
  else
    cp "$file" "${file}.tmp"
    printf '%s=%s\n' "$key" "$value" >> "${file}.tmp"
  fi
  mv "${file}.tmp" "$file"
}

show_profile() {
  local sandbox approval executable profile
  sandbox="$(read_value "CTI_CODEX_SANDBOX_MODE")"
  approval="$(read_value "CTI_CODEX_APPROVAL_POLICY")"
  executable="$(read_value "CTI_CODEX_EXECUTABLE")"

  if [ "$sandbox" = "danger-full-access" ] && [ "$approval" = "never" ]; then
    profile="full"
  else
    profile="safe"
  fi

  echo "Current profile: $profile"
  echo "CTI_CODEX_SANDBOX_MODE=${sandbox:-<unset>}"
  echo "CTI_CODEX_APPROVAL_POLICY=${approval:-<unset>}"
  echo "CTI_CODEX_EXECUTABLE=${executable:-<unset>}"
}

set_profile() {
  local sandbox="$1"
  local approval="$2"
  upsert_key "$CONFIG_FILE" "CTI_CODEX_SANDBOX_MODE" "$sandbox"
  upsert_key "$CONFIG_FILE" "CTI_CODEX_APPROVAL_POLICY" "$approval"
  chmod 600 "$CONFIG_FILE" 2>/dev/null || true
  show_profile
  echo ""
  echo "Restart the bridge to apply changes:"
  echo "  bash \"$SKILL_DIR/scripts/daemon.sh\" stop"
  echo "  bash \"$SKILL_DIR/scripts/daemon.sh\" start"
}

cmd="${1:-show}"
require_config

case "$cmd" in
  show)
    show_profile
    ;;
  safe)
    set_profile "workspace-write" "on-request"
    ;;
  full)
    set_profile "danger-full-access" "never"
    ;;
  *)
    usage
    exit 1
    ;;
esac
