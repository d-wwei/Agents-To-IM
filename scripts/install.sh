#!/usr/bin/env bash
# install.sh — One-line installer for claude-to-im
# Usage: curl -fsSL https://raw.githubusercontent.com/d-wwei/Agents-To-IM/main/scripts/install.sh | bash

set -euo pipefail

REPO_URL="https://github.com/d-wwei/Agents-To-IM.git"
INSTALL_DIR="${HOME}/.claude/skills/claude-to-im"
MIN_NODE_MAJOR=20

# ── Color output ────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
RESET='\033[0m'

info()    { printf "${GREEN}[INFO]${RESET}  %s\n" "$*"; }
warn()    { printf "${YELLOW}[WARN]${RESET}  %s\n" "$*"; }
error()   { printf "${RED}[ERROR]${RESET} %s\n" "$*" >&2; }
fatal()   { error "$*"; exit 1; }
step()    { printf "\n${BOLD}==> %s${RESET}\n" "$*"; }

# ── OS check ────────────────────────────────────────────────────────────────
OS="$(uname -s)"
case "$OS" in
  Darwin|Linux) ;;
  *) fatal "Unsupported OS: $OS. This installer supports macOS and Linux only." ;;
esac

# ── Node.js check ───────────────────────────────────────────────────────────
step "Checking prerequisites"

if ! command -v node &>/dev/null; then
  fatal "Node.js is not installed. Please install Node.js >= ${MIN_NODE_MAJOR} first.
  macOS:  brew install node
  Linux:  https://nodejs.org/en/download/package-manager"
fi

NODE_MAJOR=$(node -e "process.stdout.write(String(process.versions.node.split('.')[0]))")
if [ "$NODE_MAJOR" -lt "$MIN_NODE_MAJOR" ]; then
  fatal "Node.js >= ${MIN_NODE_MAJOR} is required. Found: $(node -v). Please upgrade."
fi
info "Node.js $(node -v) — OK"

if ! command -v git &>/dev/null; then
  fatal "Git is not installed. Please install git first."
fi
info "Git $(git --version | awk '{print $3}') — OK"

if ! command -v npm &>/dev/null; then
  fatal "npm is not found. It should come with Node.js — please reinstall Node.js."
fi
info "npm $(npm -v) — OK"

# ── Clone or update ─────────────────────────────────────────────────────────
step "Installing claude-to-im"

PARENT_DIR="$(dirname "$INSTALL_DIR")"
mkdir -p "$PARENT_DIR"

if [ -d "$INSTALL_DIR/.git" ]; then
  info "Found existing install at ${INSTALL_DIR}"
  info "Pulling latest changes..."
  git -C "$INSTALL_DIR" pull --rebase --autostash
else
  if [ -e "$INSTALL_DIR" ]; then
    warn "Directory ${INSTALL_DIR} exists but is not a git repo. Removing and re-cloning..."
    rm -rf "$INSTALL_DIR"
  fi
  info "Cloning to ${INSTALL_DIR}..."
  git clone --depth=1 "$REPO_URL" "$INSTALL_DIR"
fi

# ── Install dependencies ─────────────────────────────────────────────────────
step "Installing dependencies"
(cd "$INSTALL_DIR" && npm install --prefer-offline 2>&1)
info "Dependencies installed"

# ── Build ────────────────────────────────────────────────────────────────────
step "Building daemon bundle"
(cd "$INSTALL_DIR" && npm run build 2>&1)
info "Build complete"

# ── Prune dev dependencies ───────────────────────────────────────────────────
(cd "$INSTALL_DIR" && npm prune --production 2>&1 || true)

# ── Render host templates ─────────────────────────────────────────────────────
info "Rendering host templates..."
node "$INSTALL_DIR/scripts/render-host-templates.mjs" --host claude --target "$INSTALL_DIR" 2>&1 || true

# ── Done ─────────────────────────────────────────────────────────────────────
printf "\n"
printf "${GREEN}${BOLD}Installation complete!${RESET}\n"
printf "\n"
printf "Installed at: ${BOLD}%s${RESET}\n" "$INSTALL_DIR"
printf "\n"
printf "Next step — run the setup wizard in Claude Code:\n"
printf "\n"
printf "  ${BOLD}/claude-to-im setup${RESET}\n"
printf "\n"
printf "The setup wizard will guide you through:\n"
printf "  - Choosing your IM platform (Discord / Feishu / Telegram / QQ)\n"
printf "  - Entering your bot credentials\n"
printf "  - Selecting the AI runtime (claude / gemini / codex / auto)\n"
printf "  - Setting your default working directory\n"
printf "\n"
printf "After setup, start the bridge:\n"
printf "\n"
printf "  ${BOLD}/claude-to-im start${RESET}\n"
printf "\n"
printf "For help or troubleshooting:\n"
printf "  ${BOLD}/claude-to-im doctor${RESET}\n"
printf "  %s/references/troubleshooting.md\n" "$INSTALL_DIR"
printf "\n"
