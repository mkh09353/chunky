import { TextAttributes } from "@opentui/core"
import { ChunkyLogo } from "./ChunkyLogo.js"
import { ACCENT } from "../theme.js"

/** Shorten a path to Claude Code's `/…/parent/dir` form. */
function shortCwd(cwd: string): string {
  const parts = cwd.split("/").filter(Boolean)
  if (parts.length <= 2) return "/" + parts.join("/")
  return "/…/" + parts.slice(-2).join("/")
}

/**
 * Start-of-session welcome: a full-width rounded box with a single centered
 * column — the greeting, the Chunky mascot, the active model + cwd, and the
 * (only) mode we run in.
 */
export function WelcomeBanner({
  mode,
  cwd,
  model,
}: {
  mode: "mock" | "live"
  cwd: string
  /** The active model label (real selection, not hardcoded). */
  model: string
}) {
  return (
    <box
      width="100%"
      marginBottom={1}
      border
      borderStyle="rounded"
      borderColor="gray"
      flexDirection="column"
      alignItems="center"
      paddingY={1}
      paddingX={1}
    >
      <text attributes={TextAttributes.BOLD}>Welcome to Chunky</text>
      <box marginY={1}>
        <ChunkyLogo />
      </box>
      <text attributes={TextAttributes.DIM}>{model}</text>
      <text attributes={TextAttributes.DIM}>{shortCwd(cwd)}</text>
      <text attributes={TextAttributes.DIM}>
        mode: <span fg={ACCENT}>all yolo, all the time</span>
      </text>
    </box>
  )
}
