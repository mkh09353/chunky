#!/usr/bin/env bash
set -euo pipefail
REPO="mkh09353/chunky"
APP="$HOME/.chunky/app"; STATE="$HOME/.chunky/state"; BIN="${CHUNKY_BIN_DIR:-$HOME/.local/bin}"
command -v bun >/dev/null || { echo "Chunky requires Bun. Install it: https://bun.sh/docs/installation" >&2; exit 1; }
command -v curl >/dev/null || { echo "curl is required" >&2; exit 1; }
mkdir -p "$APP" "$STATE" "$BIN"
api="https://api.github.com/repos/$REPO/releases/latest"
json=$(curl -fsSL -H 'Accept: application/vnd.github+json' "$api")
url=$(printf '%s' "$json" | bun -e 'let s=""; for await(const x of Bun.stdin.stream())s+=new TextDecoder().decode(x); let j=JSON.parse(s); let a=j.assets?.find(x=>/\.tar\.gz$|\.tgz$/.test(x.name)); if(!a) throw Error("release tarball missing"); console.log(a.browser_download_url)')
tmp="$HOME/.chunky/app.new"; rm -rf "$tmp"; mkdir -p "$tmp"
curl -fsSL "$url" -o "$HOME/.chunky/update.tar.gz"
tar -xzf "$HOME/.chunky/update.tar.gz" --strip-components=1 -C "$tmp"
(cd "$tmp" && bun install --ignore-scripts)
rm -rf "$APP.old"; [ -d "$APP" ] && mv "$APP" "$APP.old"; mv "$tmp" "$APP"; rm -f "$HOME/.chunky/update.tar.gz"
cat > "$BIN/chunky" <<SH
#!/bin/sh
exec bun run "$APP/chunky.ts" "\$@"
SH
chmod +x "$BIN/chunky"
echo "Installed Chunky to $APP. Run: chunky"
