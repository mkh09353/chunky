import React, { useState } from "react"
import { Box, Text, useInput, useStdin, useStdout } from "ink"
import { ACCENT, BORDER } from "../theme.js"
import { COMMANDS, SlashMenu, type Command } from "./SlashMenu.js"

interface Props {
  disabled?: boolean
  onSubmit: (text: string) => void
  onCommand: (name: string) => void
  /** Right-aligned status (model/effort/advisor) drawn INTO the bottom rule. */
  status?: string
}

/**
 * The signature Claude Code input: a full-width band delimited by a horizontal
 * rule above and below, a terracotta `>` marker, and an inline block cursor.
 * When the line starts with `/`, a slash-command popup floats above the band.
 */
export function PromptInput({ disabled, onSubmit, onCommand, status }: Props) {
  // isRawModeSupported is stdin.isTTY, `undefined` (not false) in a non-TTY.
  // Ink's useInput only bails on a strict === false, so coerce to a real bool.
  const rawSupported = Boolean(useStdin().isRawModeSupported)
  const [value, setValue] = useState("")
  const [cursor, setCursor] = useState(0)
  const [selected, setSelected] = useState(0)

  const slashActive = value.startsWith("/") && !value.includes(" ")
  const matches: Command[] = slashActive
    ? COMMANDS.filter((c) => c.name.startsWith(value.toLowerCase()))
    : []

  const clampSel = (n: number) => (matches.length ? ((n % matches.length) + matches.length) % matches.length : 0)

  useInput(
    (input, key) => {
      if (disabled) return

      if (slashActive && matches.length > 0) {
        if (key.upArrow) return setSelected((s) => clampSel(s - 1))
        if (key.downArrow) return setSelected((s) => clampSel(s + 1))
        if (key.tab) {
          const name = matches[clampSel(selected)]!.name
          setValue(name)
          setCursor(name.length)
          setSelected(0)
          return
        }
        if (key.return) {
          const name = matches[clampSel(selected)]!.name
          reset()
          onCommand(name)
          return
        }
      }

      if (key.return) {
        const text = value.trim()
        if (!text) return
        reset()
        onSubmit(text)
        return
      }
      if (key.leftArrow) return setCursor((c) => Math.max(0, c - 1))
      if (key.rightArrow) return setCursor((c) => Math.min(value.length, c + 1))
      if (key.backspace || key.delete) {
        if (cursor > 0) {
          setValue((v) => v.slice(0, cursor - 1) + v.slice(cursor))
          setCursor((c) => Math.max(0, c - 1))
          setSelected(0)
        }
        return
      }
      if (key.ctrl || key.meta || key.escape) return
      if (input) {
        setValue((v) => v.slice(0, cursor) + input + v.slice(cursor))
        setCursor((c) => c + input.length)
        setSelected(0)
      }
    },
    { isActive: rawSupported && !disabled },
  )

  function reset() {
    setValue("")
    setCursor(0)
    setSelected(0)
  }

  return (
    <Box flexDirection="column" width="100%">
      {matches.length > 0 && <SlashMenu commands={matches} selected={clampSel(selected)} />}
      <Box
        width="100%"
        borderStyle="single"
        borderColor={BORDER}
        borderTop
        borderBottom={false}
        borderLeft={false}
        borderRight={false}
        flexShrink={0}
      >
        <Text color={ACCENT}>{"❯ "}</Text>
        <CursorText value={value} cursor={cursor} showCursor={rawSupported && !disabled} />
      </Box>
      <BottomRule status={status} />
    </Box>
  )
}

/**
 * The input's bottom rule with the model/advisor status drawn into its right
 * end — a run of `─` fills the left, then the status sits flush right, so the
 * label appears to cut through the border line (grok-code style). Falls back to
 * a plain full-width rule when there's no status yet.
 */
function BottomRule({ status }: { status?: string }) {
  const { stdout } = useStdout()
  const cols = stdout?.columns ?? 80
  const label = (status ?? "").trim()
  // The dashes use the SAME border color as the top rule (Ink draws borderTop in
  // BORDER) so both lines match. The status is embedded near the right with the
  // rule continuing past it to the edge (grok-code style), a space on each side.
  if (!label) {
    return <Text color={BORDER}>{"─".repeat(Math.max(0, cols - 1))}</Text>
  }
  const rightDashes = 3
  const left = Math.max(0, cols - label.length - rightDashes - 3) // 2 spaces + 1 margin
  return (
    <Text>
      <Text color={BORDER}>{"─".repeat(left)}</Text>
      <Text dimColor> {label} </Text>
      <Text color={BORDER}>{"─".repeat(rightDashes)}</Text>
    </Text>
  )
}

/** Render the line with an inverse-block cursor, like Claude Code's input. */
function CursorText({ value, cursor, showCursor }: { value: string; cursor: number; showCursor: boolean }) {
  if (value.length === 0) {
    return <Text dimColor>Try &quot;fix lint errors&quot;</Text>
  }
  const before = value.slice(0, cursor)
  const at = value.slice(cursor, cursor + 1) || " "
  const after = value.slice(cursor + 1)
  return (
    <Text>
      {before}
      {showCursor ? <Text inverse>{at}</Text> : at === " " ? "" : at}
      {after}
    </Text>
  )
}
