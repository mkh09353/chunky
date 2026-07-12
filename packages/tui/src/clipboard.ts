// Write text to the system clipboard — robust, dependency-free, never throws.
//
// A terminal app can't lean on ⌘C: OpenTUI keeps mouse tracking ON, so a drag
// builds OUR selection instead of a NATIVE terminal one, leaving nothing for the
// emulator's ⌘C to copy. So we copy the app's own selection ourselves, firing
// TWO mechanisms for maximum coverage (mirrors opencode's clipboard):
//   1. OSC 52 — an escape sequence asking the terminal emulator to set the system
//      clipboard. Works over SSH / inside tmux (wrapped) where no local clipboard
//      binary is reachable. Skipped when stdout isn't a TTY.
//   2. A native clipboard command (pbcopy / wl-copy / xclip / xsel / clip.exe) for
//      terminals that don't honour OSC 52. Linux tools are tried in order.

/** OSC 52: `ESC ] 52 ; c ; <base64> BEL`, wrapped for tmux/screen so it passes
 *  through a multiplexer to the outer terminal. */
function writeOsc52(text: string): void {
  if (!process.stdout.isTTY) return
  const seq = `\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`
  const wrapped = process.env.TMUX
    ? `\x1bPtmux;\x1b${seq}\x1b\\`
    : process.env.STY
      ? `\x1bP${seq}\x1b\\`
      : seq
  process.stdout.write(wrapped)
}

/** Candidate native clipboard-write commands for this platform, in priority
 *  order (Linux may have xsel but not xclip, or vice-versa). */
function nativeCopyCommands(): string[][] {
  if (process.platform === "darwin") return [["pbcopy"]]
  if (process.platform === "win32") return [["clip.exe"]]
  const cmds: string[][] = []
  if (process.env.WAYLAND_DISPLAY) cmds.push(["wl-copy"])
  cmds.push(["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"])
  return cmds
}

/** Pipe `text` into `cmd`; resolves true iff it ran and exited cleanly. */
async function tryPipe(cmd: string[], text: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(cmd, { stdin: "pipe", stdout: "ignore", stderr: "ignore" })
    proc.stdin.write(text)
    proc.stdin.end()
    return (await proc.exited) === 0
  } catch {
    // Command not installed (ENOENT) etc. — fall through to the next candidate.
    return false
  }
}

/** Copy `text` to the system clipboard. Best-effort; safe to call fire-and-forget. */
export async function writeClipboard(text: string): Promise<void> {
  writeOsc52(text)
  for (const cmd of nativeCopyCommands()) {
    if (await tryPipe(cmd, text)) return
  }
  // No native tool succeeded — the OSC 52 write above is the fallback.
}
