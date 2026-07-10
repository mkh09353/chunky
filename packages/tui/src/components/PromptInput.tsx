import React, { useRef, useState } from "react"
import { Box, Text, useInput, useStdin, useStdout } from "ink"
import { ACCENT, BORDER } from "../theme.js"
import { COMMANDS, SlashMenu, type Command } from "./SlashMenu.js"

interface Props {
  disabled?: boolean
  onSubmit: (text: string) => void
  onCommand: (name: string) => void
  /** Right-aligned status (model/effort/advisor) drawn INTO the bottom rule. */
  status?: string
  /** Ctrl+V: grab an image off the clipboard and attach it (async, in App). */
  onPasteImage?: () => void
  /** How many images are attached to the next message (shown above the input). */
  attachmentCount?: number
}

/**
 * The signature Claude Code input: a full-width band delimited by a horizontal
 * rule above and below, a terracotta `>` marker, and an inline block cursor.
 * When the line starts with `/`, a slash-command popup floats above the band.
 */
export function PromptInput({ disabled, onSubmit, onCommand, status, onPasteImage, attachmentCount = 0 }: Props) {
  // isRawModeSupported is stdin.isTTY, `undefined` (not false) in a non-TTY.
  // Ink's useInput only bails on a strict === false, so coerce to a real bool.
  const rawSupported = Boolean(useStdin().isRawModeSupported)
  // value + cursor live in ONE state so the key handler edits them with a
  // functional updater (which always receives the CURRENT state). Ink
  // re-subscribes useInput a frame after each render, so a plain closure drops the
  // first keystroke after a re-render — e.g. backspace right after typing "/" saw
  // cursor=0 and no-op'd. bufRef mirrors it for reads that can't use an updater.
  const [buf, setBuf] = useState<{ value: string; cursor: number }>({ value: "", cursor: 0 })
  const bufRef = useRef(buf)
  bufRef.current = buf
  const { value, cursor } = buf
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
          setBuf({ value: name, cursor: name.length })
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
        const text = bufRef.current.value.trim()
        // Allow an image-only message: submit when there's text OR attachments.
        if (!text && attachmentCount === 0) return
        reset()
        onSubmit(text)
        return
      }
      // Ctrl+V — pull an image off the clipboard (Cmd+V is owned by the terminal).
      if (key.ctrl && (input === "v" || input === "V")) {
        onPasteImage?.()
        return
      }
      if (key.leftArrow) return setBuf((b) => ({ ...b, cursor: Math.max(0, b.cursor - 1) }))
      if (key.rightArrow) return setBuf((b) => ({ ...b, cursor: Math.min(b.value.length, b.cursor + 1) }))
      if (key.backspace || key.delete) {
        setBuf((b) =>
          b.cursor > 0
            ? { value: b.value.slice(0, b.cursor - 1) + b.value.slice(b.cursor), cursor: b.cursor - 1 }
            : b,
        )
        setSelected(0)
        return
      }
      if (key.ctrl || key.meta || key.escape) return
      if (input) {
        setBuf((b) => ({
          value: b.value.slice(0, b.cursor) + input + b.value.slice(b.cursor),
          cursor: b.cursor + input.length,
        }))
        setSelected(0)
      }
    },
    { isActive: rawSupported && !disabled },
  )

  function reset() {
    setBuf({ value: "", cursor: 0 })
    setSelected(0)
  }

  return (
    <Box flexDirection="column" width="100%">
      {attachmentCount > 0 && (
        <Text dimColor>
          {"  "}📎 {attachmentCount} image{attachmentCount === 1 ? "" : "s"} attached — enter to send
        </Text>
      )}
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
