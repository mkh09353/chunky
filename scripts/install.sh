#!/usr/bin/env bash
# Install Chunky as a standalone `chunky` command, independent of this dev tree.
# Snapshots the app to ~/.chunky/app, installs deps there, seeds runtime state
# (db/auth/settings) from your current config, and drops a launcher on your PATH.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Both installers deliberately keep this bootstrap self-contained (get.sh is piped to bash).
CHUNKY="${CHUNKY_DIR:-$HOME/.chunky}"
NAME="${CHUNKY_COMMAND:-}"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dir|--name)
      [ "$#" -ge 2 ] && [ -n "$2" ] || { echo "error: $1 requires a value" >&2; exit 1; }
      case "$1" in --dir) CHUNKY="$2" ;; --name) NAME="$2" ;; esac
      shift 2 ;;
    --help|-h)
      echo 'Usage: bash install.sh [--name COMMAND] [--dir DIRECTORY]'
      echo 'Defaults: chunky, ~/.chunky. Also accepts CHUNKY_COMMAND, CHUNKY_DIR, CHUNKY_BIN_DIR.'
      exit 0 ;;
    *) echo "error: unknown option: $1" >&2; exit 1 ;;
  esac
done
# Resolve paths once; launchers must work from any working directory.
case "$CHUNKY" in '~') CHUNKY="$HOME" ;; '~/'*) CHUNKY="$HOME/${CHUNKY#\~/}" ;; esac
[ -n "$NAME" ] || { [ ! -f "$CHUNKY/command-name" ] || NAME="$(cat "$CHUNKY/command-name")"; }
NAME="${NAME:-chunky}"
[[ "$NAME" =~ ^[a-zA-Z0-9][a-zA-Z0-9_-]*$ ]] || { echo "error: invalid command name: $NAME" >&2; exit 1; }
mkdir -p "$CHUNKY"
CHUNKY="$(cd "$CHUNKY" && pwd -P)"
[ "$CHUNKY" != / ] && [ "$CHUNKY" != "$(cd "$HOME" && pwd -P)" ] || { echo 'error: use a dedicated installation directory' >&2; exit 1; }
APP="$CHUNKY/app"; STATE="$CHUNKY/state"; BIN="${CHUNKY_BIN_DIR:-$HOME/.local/bin}"
mkdir -p "$BIN"
BIN="$(cd "$BIN" && pwd -P)"
case "$CHUNKY/" in "$SRC/"*) echo 'error: install outside the source tree' >&2; exit 1 ;; esac

command -v bun >/dev/null 2>&1 || { echo "error: 'bun' is required on your PATH (Chunky runs on Bun)." >&2; exit 1; }

echo "→ snapshotting app to $APP"
mkdir -p "$APP" "$STATE" "$BIN"
rsync -a --delete \
  --exclude '.git' --exclude 'node_modules' --exclude '.claude' --exclude 'scratchpad' \
  --exclude '*.db' --exclude '*.db-wal' --exclude '*.db-shm' --exclude '*.log' \
  --exclude '.env' --exclude 'auth.json' --exclude 'settings.json' \
  "$SRC/" "$APP/"

echo "→ installing dependencies (this can take a minute)"
# --ignore-scripts skips the better-sqlite3 native build, which we don't use (bun:sqlite).
( cd "$APP" && bun install --ignore-scripts )

# Verify the claude-agent-sdk native binary for this platform actually landed.
# A stale node_modules can make bun report "no changes" while the optional
# platform package (which contains the `claude` binary) is missing.
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) SDK_PLAT="darwin-arm64" ;;
  Darwin-x86_64) SDK_PLAT="darwin-x64" ;;
  Linux-aarch64|Linux-arm64) SDK_PLAT="linux-arm64" ;;
  Linux-x86_64) SDK_PLAT="linux-x64" ;;
  *) SDK_PLAT="" ;;
esac
if [ -n "$SDK_PLAT" ]; then
  find_sdk_bin() { find "$APP/node_modules" -type f -name claude -path "*claude-agent-sdk-$SDK_PLAT*" 2>/dev/null | head -n1; }
  BINPATH="$(find_sdk_bin)"
  if [ -z "$BINPATH" ]; then
    echo "→ native claude-agent-sdk binary missing; forcing a clean reinstall"
    ( cd "$APP" && rm -rf node_modules packages/*/node_modules && bun install --ignore-scripts )
    BINPATH="$(find_sdk_bin)"
  fi
  if [ -z "$BINPATH" ]; then
    echo "error: @anthropic-ai/claude-agent-sdk-$SDK_PLAT did not install (native 'claude' binary not found)." >&2
    echo "       Check that optional deps aren't disabled (bunfig.toml/.npmrc 'optional = false') and retry." >&2
    exit 1
  fi
  chmod +x "$BINPATH" 2>/dev/null || true
fi

echo "→ seeding runtime state in $STATE (kept out of your projects)"
for f in .env auth.json settings.json; do
  if [ -f "$SRC/$f" ] && [ ! -f "$STATE/$f" ]; then
    cp "$SRC/$f" "$STATE/$f"
    echo "   copied $f from the dev tree"
  fi
done

# The launcher owns the port + all state paths, so scrub any CHUNKY_* from the
# seeded .env (a dev CHUNKY_PORT=4599 would otherwise pin the port and clash).
if [ -f "$STATE/.env" ] && grep -qE '^\s*CHUNKY_' "$STATE/.env"; then
  grep -vE '^\s*CHUNKY_' "$STATE/.env" > "$STATE/.env.tmp" && mv "$STATE/.env.tmp" "$STATE/.env"
  echo "   scrubbed CHUNKY_* from state/.env (launcher manages the port)"
fi

echo "→ installing launcher at $BIN/$NAME"
# Persist the identity outside app/, which updates replace wholesale.
printf '%s\n' "$NAME" > "$CHUNKY/command-name"
# Bash %q safely quotes paths containing spaces, quotes, dollar signs, or backticks.
{
  echo '#!/usr/bin/env bash'
  printf 'export CHUNKY_DIR=%q\n' "$CHUNKY"
  printf 'export CHUNKY_HOME=%q\n' "$STATE"
  printf 'export CHUNKY_COMMAND=%q\n' "$NAME"
  echo 'BUN="$(command -v bun || true)"'
  printf '[ -n "$BUN" ] || BUN=%q\n' "$CHUNKY/bun/bin/bun"
  echo 'export PATH="$(dirname "$BUN"):$PATH"'
  printf 'exec "$BUN" run %q "$@"\n' "$APP/chunky.ts"
} > "$BIN/$NAME"
chmod +x "$BIN/$NAME"

echo
echo "✓ Installed."
case ":$PATH:" in
  *":$BIN:"*) echo "  Run it from any project directory:  $NAME" ;;
  *) echo "  Add $BIN to your PATH, then run:  $NAME"
     echo "  e.g.  echo 'export PATH=\"$BIN:\$PATH\"' >> ~/.zshrc && source ~/.zshrc" ;;
esac
echo "  State + logs live in $STATE  (server.log for troubleshooting)."
echo "  Update later by re-running this script."
