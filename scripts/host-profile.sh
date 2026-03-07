#!/usr/bin/env bash

host_title_case() {
  local input="$1"
  local IFS='-_'
  local out=""
  read -ra parts <<< "$input"
  for part in "${parts[@]}"; do
    [ -z "$part" ] && continue
    out+="$(printf '%s' "$part" | awk '{ print toupper(substr($0, 1, 1)) substr($0, 2) }')"
  done
  printf '%s' "$out"
}

default_runtime_for_host() {
  local host="${1:-}"
  case "$host" in
    codex) printf '%s' "codex" ;;
    gemini) printf '%s' "gemini" ;;
    *) printf '%s' "claude" ;;
  esac
}

infer_host_from_skill_command() {
  local value="${1:-}"
  case "$value" in
    *-to-im) printf '%s' "${value%-to-im}" ;;
    *) return 1 ;;
  esac
}

init_host_profile() {
  local skill_dir="$1"
  local derived=""

  if [ -n "${CTI_HOST:-}" ]; then
    derived="${CTI_HOST}"
  elif [ -n "${CTI_SKILL_COMMAND:-}" ]; then
    derived="$(infer_host_from_skill_command "${CTI_SKILL_COMMAND}" 2>/dev/null || true)"
  elif [ -n "${CTI_HOME:-}" ]; then
    derived="$(infer_host_from_skill_command "$(basename "${CTI_HOME}")" 2>/dev/null || true)"
  fi

  if [ -z "$derived" ]; then
    derived="$(infer_host_from_skill_command "$(basename "$skill_dir")" 2>/dev/null || true)"
  fi

  HOST_NAME="${derived:-claude}"
  HOST_DISPLAY_NAME="$(host_title_case "$HOST_NAME")"
  SKILL_COMMAND="${CTI_SKILL_COMMAND:-${HOST_NAME}-to-im}"
  DEFAULT_RUNTIME="$(default_runtime_for_host "$HOST_NAME")"
  CTI_HOME_DEFAULT="$HOME/.${SKILL_COMMAND}"
  LAUNCHD_LABEL_DEFAULT="com.${SKILL_COMMAND}.bridge"
  SERVICE_NAME_DEFAULT="$(host_title_case "$HOST_NAME")ToIMBridge"
  LOG_PREFIX_DEFAULT="$SKILL_COMMAND"
}
