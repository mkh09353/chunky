#!/usr/bin/env bash
set -euo pipefail
REPO="mkh09353/chunky"
CHUNKY="$HOME/.chunky"
APP="$CHUNKY/app"; STATE="$CHUNKY/state"; BIN="${CHUNKY_BIN_DIR:-$HOME/.local/bin}"
command -v curl >/dev/null || { echo "curl is required" >&2; exit 1; }

# Resolve bun: PATH first, then our private install; bootstrap it if missing.
BUN="$(command -v bun || true)"
[ -z "$BUN" ] && [ -x "$CHUNKY/bun/bin/bun" ] && BUN="$CHUNKY/bun/bin/bun"
if [ -z "$BUN" ]; then
  echo "→ bun not found; installing it privately to $CHUNKY/bun (won't touch your shell config)"
  if [ -n "${CHUNKY_BUN_VERSION:-}" ]; then
    curl -fsSL https://bun.sh/install | BUN_INSTALL="$CHUNKY/bun" bash -s -- "bun-v$CHUNKY_BUN_VERSION" >/dev/null
  else
    curl -fsSL https://bun.sh/install | BUN_INSTALL="$CHUNKY/bun" bash >/dev/null
  fi
  BUN="$CHUNKY/bun/bin/bun"
  [ -x "$BUN" ] || { echo "bun bootstrap failed; install it manually: https://bun.sh" >&2; exit 1; }
fi

mkdir -p "$APP" "$STATE" "$BIN"
api="https://api.github.com/repos/$REPO/releases/latest"
json=$(curl -fsSL -H 'Accept: application/vnd.github+json' "$api")
url=$(printf '%s' "$json" | "$BUN" -e 'let s=""; for await(const x of Bun.stdin.stream())s+=new TextDecoder().decode(x); let j=JSON.parse(s); let a=j.assets?.find(x=>/\.tar\.gz$|\.tgz$/.test(x.name)); if(!a) throw Error("release tarball missing"); console.log(a.browser_download_url)')
tmp="$CHUNKY/app.new"; rm -rf "$tmp"; mkdir -p "$tmp"
curl -fsSL "$url" -o "$CHUNKY/update.tar.gz"
tar -xzf "$CHUNKY/update.tar.gz" --strip-components=1 -C "$tmp"
(cd "$tmp" && "$BUN" install --ignore-scripts)

# Verify the claude-agent-sdk native binary for this platform actually landed;
# without it the server dies with "Native CLI binary for <plat> not found".
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) SDK_PLAT="darwin-arm64" ;;
  Darwin-x86_64) SDK_PLAT="darwin-x64" ;;
  Linux-aarch64|Linux-arm64) SDK_PLAT="linux-arm64" ;;
  Linux-x86_64) SDK_PLAT="linux-x64" ;;
  *) SDK_PLAT="" ;;
esac
if [ -n "$SDK_PLAT" ]; then
  find_sdk_bin() { find "$tmp/node_modules" -type f -name claude -path "*claude-agent-sdk-$SDK_PLAT*" 2>/dev/null | head -n1; }
  BINPATH="$(find_sdk_bin)"
  if [ -z "$BINPATH" ]; then
    echo "→ native claude-agent-sdk binary missing; forcing a clean reinstall"
    (cd "$tmp" && rm -rf node_modules packages/*/node_modules && "$BUN" install --ignore-scripts)
    BINPATH="$(find_sdk_bin)"
  fi
  if [ -z "$BINPATH" ]; then
    echo "error: @anthropic-ai/claude-agent-sdk-$SDK_PLAT did not install (native 'claude' binary not found)." >&2
    echo "       Check that optional deps aren't disabled (bunfig.toml/.npmrc 'optional = false') and retry." >&2
    exit 1
  fi
  chmod +x "$BINPATH" 2>/dev/null || true
fi
rm -rf "$APP.old"; [ -d "$APP" ] && mv "$APP" "$APP.old"; mv "$tmp" "$APP"; rm -f "$CHUNKY/update.tar.gz"
cat > "$BIN/chunky" <<SH
#!/bin/sh
# Chunky launcher — prefers PATH bun, falls back to the private bootstrap copy.
BUN="\$(command -v bun || true)"
[ -z "\$BUN" ] && BUN="\$HOME/.chunky/bun/bin/bun"
exec "\$BUN" run "$APP/chunky.ts" "\$@"
SH
chmod +x "$BIN/chunky"
echo "Installed Chunky to $APP. Run: chunky"
