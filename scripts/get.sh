#!/usr/bin/env bash
set -euo pipefail
REPO="mkh09353/chunky"
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
json=$(curl -fsSL -H 'Accept: application/vnd.github+json' "$api") || {
  echo "error: GitHub release lookup failed ($api)." >&2
  echo "       This is often unauthenticated API rate limiting (60 req/hr per IP); wait a bit and retry." >&2
  exit 1
}
url=$(printf '%s' "$json" | "$BUN" -e 'let s=""; for await(const x of Bun.stdin.stream())s+=new TextDecoder().decode(x); let j=JSON.parse(s); let a=j.assets?.find(x=>/\.tar\.gz$|\.tgz$/.test(x.name)); if(!a) throw Error("release tarball missing"); console.log(a.browser_download_url)')
version=$(printf '%s' "$json" | "$BUN" -e 'let s=""; for await(const x of Bun.stdin.stream())s+=new TextDecoder().decode(x); console.log((JSON.parse(s).tag_name||"").replace(/^v/,""))')
prev=$("$BUN" -e 'try{console.log(JSON.parse(await Bun.file(process.argv[1]).text()).version||"")}catch{console.log("")}' "$APP/package.json" 2>/dev/null || true)
echo "→ latest release: v$version${prev:+ (installed: v$prev)}"
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
installed=$("$BUN" -e 'console.log(JSON.parse(await Bun.file(process.argv[1]).text()).version)' "$APP/package.json")
if [ "$installed" != "$version" ]; then
  echo "error: expected v$version but $APP has v$installed after install." >&2
  exit 1
fi
echo "Installed Chunky v$installed to $APP. Run: $NAME"
if [ -n "$prev" ] && [ "$prev" = "$installed" ]; then
  echo "note: v$installed was already the latest release — nothing newer to install."
fi
echo "note: if a chunky server/TUI is already running, restart it to pick up the new version."
