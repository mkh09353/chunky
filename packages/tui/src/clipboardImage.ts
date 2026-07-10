// Read an image off the macOS clipboard, dependency-free, via osascript — the
// same approach as kimi/Claude Code. `the clipboard as «class PNGf»` fails (non-
// zero) when there's no image; otherwise we write the PNG to a temp file and
// base64 it. macOS only; returns null (never throws) everywhere else / on error.
import { readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

export interface ClipboardImage {
  base64: string
  mediaType: string
}

// ~7MB of base64. Bigger images are skipped rather than resized (no image lib);
// a real screenshot is well under this.
const MAX_BASE64_LENGTH = 7_000_000

/** Grab a PNG from the macOS clipboard, or null if there isn't one. */
export async function grabClipboardImage(): Promise<ClipboardImage | null> {
  if (process.platform !== "darwin") return null
  const tmp = join(tmpdir(), `chunky-clip-${Date.now()}.png`)
  try {
    // 1. Does the clipboard hold an image?
    const check = Bun.spawn(["osascript", "-e", "the clipboard as «class PNGf»"], {
      stdout: "ignore",
      stderr: "ignore",
    })
    if ((await check.exited) !== 0) return null

    // 2. Write the clipboard PNG to a temp file.
    const save = Bun.spawn(
      [
        "osascript",
        "-e",
        "set png_data to (the clipboard as «class PNGf»)",
        "-e",
        `set fp to open for access POSIX file "${tmp}" with write permission`,
        "-e",
        "write png_data to fp",
        "-e",
        "close access fp",
      ],
      { stdout: "ignore", stderr: "ignore" },
    )
    if ((await save.exited) !== 0) return null

    // 3. Read + base64.
    const buf = readFileSync(tmp)
    if (buf.length === 0) return null
    const base64 = buf.toString("base64")
    if (base64.length > MAX_BASE64_LENGTH) return null
    return { base64, mediaType: "image/png" }
  } catch {
    return null
  } finally {
    try {
      rmSync(tmp, { force: true })
    } catch {
      // temp file may not exist; ignore
    }
  }
}
