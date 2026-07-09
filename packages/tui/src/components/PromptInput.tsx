import React, { useState } from "react"
import { Box, Text, useInput, useStdin } from "ink"
import { ACCENT, BORDER } from "../theme.js"
import { COMMANDS, SlashMenu, type Command } from "./SlashMenu.js"

interface Props {
  disabled?: boolean
  onSubmit: (text: string) => void
  onCommand: (name: string) => void
}

/**
 * The signature Claude Code element: a single rounded-border box with a dim
 * gray border, a terracotta `>` marker, an inline cursor, and — when the line
 * starts with `/` — a CustomSelect-style slash-command popup floating above it.
 */
export function PromptInput({ disabled, onSubmit, onCommand }: Props) {
  // isRawModeSupported is stdin.isTTY, which is `undefined` (not false) in a
  // non-TTY. Ink's useInput only bails on a strict === false, so coerce it to a
  // real boolean — otherwise it would try (and fail) to enable raw mode in CI.
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

      // Slash-menu navigation
      if (slashActive && matches.length > 0) {
        if (key.upArrow) {
          setSelected((s) => clampSel(s - 1))
          return
        }
        if (key.downArrow) {
          setSelected((s) => clampSel(s + 1))
          return
        }
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

      if (key.leftArrow) {
        setCursor((c) => Math.max(0, c - 1))
        return
      }
      if (key.rightArrow) {
        setCursor((c) => Math.min(value.length, c + 1))
        return
      }
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
    <Box flexDirection="column">
      {matches.length > 0 && <SlashMenu commands={matches} selected={clampSel(selected)} />}
      <Box borderStyle="round" borderColor={BORDER} paddingX={1}>
        <Text color={ACCENT}>{"> "}</Text>
        <CursorText value={value} cursor={cursor} showCursor={rawSupported && !disabled} />
      </Box>
    </Box>
  )
}

/** Render the line with an inverse-block cursor, like Claude Code's input. */
function CursorText({ value, cursor, showCursor }: { value: string; cursor: number; showCursor: boolean }) {
  if (value.length === 0) {
    return showCursor ? <Text inverse> </Text> : <Text dimColor>Type your message…</Text>
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
