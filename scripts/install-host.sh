#!/usr/bin/env bash
set -euo pipefail

SOURCE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HOST=""
LINK_MODE="false"

while [ $# -gt 0 ]; do
  case "$1" in
    --host)
      HOST="${2:-}"
      shift 2
      ;;
    --link)
      LINK_MODE="true"
      shift
      ;;
    *)
      echo "Unknown argument: $1"
      echo "Usage: bash scripts/install-host.sh --host <claude|codex|gemini> [--link]"
      exit 1
      ;;
  esac
done

if [ -z "$HOST" ]; then
  echo "Missing --host"
  echo "Usage: bash scripts/install-host.sh --host <claude|codex|gemini> [--link]"
  exit 1
fi

case "$HOST" in
  claude) SKILLS_DIR="$HOME/.claude/skills" ;;
  codex) SKILLS_DIR="$HOME/.codex/skills" ;;
  gemini) SKILLS_DIR="$HOME/.gemini/skills" ;;
  *)
    echo "Unsupported host: $HOST"
    exit 1
    ;;
esac

SKILL_NAME="${HOST}-to-im"
TARGET_DIR="$SKILLS_DIR/$SKILL_NAME"

echo "Installing $SKILL_NAME for $HOST..."

mkdir -p "$SKILLS_DIR"

if [ -e "$TARGET_DIR" ]; then
  echo "Already installed at $TARGET_DIR"
  echo "To reinstall, remove it first."
  exit 0
fi

if [ "$LINK_MODE" = "true" ]; then
  mkdir -p "$TARGET_DIR" "$TARGET_DIR/references"
  for entry in "$SOURCE_DIR"/* "$SOURCE_DIR"/.[!.]*; do
    [ -e "$entry" ] || continue
    base="$(basename "$entry")"
    case "$base" in
      .git|SKILL.md|README.md|README_CN.md|SECURITY.md|config.env.example|references) continue ;;
    esac
    ln -s "$entry" "$TARGET_DIR/$base"
  done
  for ref in "$SOURCE_DIR/references"/*; do
    [ -e "$ref" ] || continue
    base="$(basename "$ref")"
    case "$base" in
      usage.md|troubleshooting.md) continue ;;
      *) ln -s "$ref" "$TARGET_DIR/references/$base" ;;
    esac
  done
  cp "$SOURCE_DIR/SKILL.md" "$TARGET_DIR/SKILL.md"
  cp "$SOURCE_DIR/README.md" "$TARGET_DIR/README.md"
  cp "$SOURCE_DIR/README_CN.md" "$TARGET_DIR/README_CN.md"
  cp "$SOURCE_DIR/SECURITY.md" "$TARGET_DIR/SECURITY.md"
  cp "$SOURCE_DIR/config.env.example" "$TARGET_DIR/config.env.example"
  cp "$SOURCE_DIR/references/usage.md" "$TARGET_DIR/references/usage.md"
  cp "$SOURCE_DIR/references/troubleshooting.md" "$TARGET_DIR/references/troubleshooting.md"
else
  cp -R "$SOURCE_DIR" "$TARGET_DIR"
fi

node "$TARGET_DIR/scripts/render-host-templates.mjs" --host "$HOST" --target "$TARGET_DIR"

if [ ! -d "$TARGET_DIR/node_modules" ] || [ ! -d "$TARGET_DIR/node_modules/@openai/codex-sdk" ]; then
  echo "Installing dependencies..."
  (cd "$TARGET_DIR" && npm install)
fi

if [ ! -f "$TARGET_DIR/dist/daemon.mjs" ]; then
  echo "Building daemon bundle..."
  (cd "$TARGET_DIR" && npm run build)
fi

echo "Pruning dev dependencies..."
(cd "$TARGET_DIR" && npm prune --production)

echo ""
echo "Done. Command:"
echo "  $SKILL_NAME setup"
echo "Runtime home:"
echo "  ~/.${SKILL_NAME}"
