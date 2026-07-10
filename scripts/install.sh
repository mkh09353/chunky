#!/usr/bin/env bash
# Install Chunky as a standalone `chunky` command, independent of this dev tree.
# Snapshots the app to ~/.chunky/app, installs deps there, seeds runtime state
# (db/auth/settings) from your current config, and drops a launcher on your PATH.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$HOME/.chunky/app"
STATE="$HOME/.chunky/state"
BIN="${CHUNKY_BIN_DIR:-$HOME/.local/bin}"

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

echo "→ installing launcher at $BIN/chunky"
cat > "$BIN/chunky" <<SH
#!/bin/sh
# Chunky launcher — runs the pinned app in ~/.chunky/app against your current dir.
exec bun run "$APP/chunky.ts" "\$@"
SH
chmod +x "$BIN/chunky"

echo
echo "✓ Installed."
case ":$PATH:" in
  *":$BIN:"*) echo "  Run it from any project directory:  chunky" ;;
  *) echo "  Add $BIN to your PATH, then run:  chunky"
     echo "  e.g.  echo 'export PATH=\"$BIN:\$PATH\"' >> ~/.zshrc && source ~/.zshrc" ;;
esac
echo "  State + logs live in $STATE  (server.log for troubleshooting)."
echo "  Update later by re-running this script."
