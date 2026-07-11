import React, { useEffect, useRef, useState } from "react"
import { Box, Text, useInput, useStdin, useStdout } from "ink"
import { ROUTES, type FileSearchItem, type FileSearchResponse } from "@chunky/protocol"
import { ACCENT, BORDER } from "../theme.js"
import { COMMANDS, SlashMenu, type Command } from "./SlashMenu.js"
import { MentionMenu, activeMention } from "./MentionMenu.js"

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
  /** Server base URL for FFF file search (live mode). Absent → no @ autocomplete. */
  baseUrl?: string
}

/**
 * The signature Claude Code input: a full-width band delimited by a horizontal
 * rule above and below, a terracotta `>` marker, and an inline block cursor.
 * When the line starts with `/`, a slash-command popup floats above the band.
 * When the cursor is inside an `@path` token, a file-search popup floats above.
 */
export function PromptInput({
  disabled,
  onSubmit,
  onCommand,
  status,
  onPasteImage,
  attachmentCount = 0,
  baseUrl,
}: Props) {
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

  // ---- Slash commands ----
  const slashActive = value.startsWith("/") && !value.includes(" ")
  const matches: Command[] = slashActive
    ? COMMANDS.filter((c) => c.name.startsWith(value.toLowerCase()))
    : []

  // ---- @-mention file search ----
  const mention = !slashActive ? activeMention(value, cursor) : null
  const [fileHits, setFileHits] = useState<FileSearchItem[]>([])
  const [fileLoading, setFileLoading] = useState(false)
  const searchGen = useRef(0)

  useEffect(() => {
    if (!mention || !baseUrl) {
      setFileHits([])
      setFileLoading(false)
      return
    }
    const gen = ++searchGen.current
    setFileLoading(true)
    const q = mention.query
    const timer = setTimeout(() => {
      const url = `${baseUrl}${ROUTES.fileSearch}?q=${encodeURIComponent(q)}&limit=12`
      void fetch(url)
        .then(async (res) => {
          if (!res.ok) throw new Error(`search ${res.status}`)
          return (await res.json()) as FileSearchResponse
        })
        .then((body) => {
          if (searchGen.current !== gen) return
          setFileHits(body.items ?? [])
          setSelected(0)
          setFileLoading(false)
        })
        .catch(() => {
          if (searchGen.current !== gen) return
          setFileHits([])
          setFileLoading(false)
        })
    }, 60) // light debounce so each keystroke doesn't hammer FFF
    return () => clearTimeout(timer)
  }, [mention?.query, mention?.start, baseUrl])

  const mentionActive = mention != null && !!baseUrl
  const mentionItems = mentionActive ? fileHits : []

  const clampSel = (n: number, len: number) =>
    len ? ((n % len) + len) % len : 0

  function insertMention(item: FileSearchItem) {
    if (!mention) return
    const insert = item.path + (item.kind === "directory" ? "/" : "")
    // Replace from `@` through cursor with `@path` (keep the @ so the model
    // sees an explicit mention token) plus a trailing space.
    const before = value.slice(0, mention.start)
    const after = value.slice(cursor)
    const next = `${before}@${insert} ${after}`
    const nextCursor = before.length + 1 + insert.length + 1
    setBuf({ value: next, cursor: nextCursor })
    setSelected(0)
    setFileHits([])
  }

  useInput(
    (input, key) => {
      if (disabled) return

      // Slash menu navigation
      if (slashActive && matches.length > 0) {
        if (key.upArrow) return setSelected((s) => clampSel(s - 1, matches.length))
        if (key.downArrow) return setSelected((s) => clampSel(s + 1, matches.length))
        if (key.tab) {
          const name = matches[clampSel(selected, matches.length)]!.name
          setBuf({ value: name, cursor: name.length })
          setSelected(0)
          return
        }
        if (key.return) {
          const name = matches[clampSel(selected, matches.length)]!.name
          reset()
          onCommand(name)
          return
        }
      }

      // @-mention navigation / accept
      if (mentionActive && mentionItems.length > 0) {
        if (key.upArrow) return setSelected((s) => clampSel(s - 1, mentionItems.length))
        if (key.downArrow) return setSelected((s) => clampSel(s + 1, mentionItems.length))
        if (key.tab || key.return) {
          const item = mentionItems[clampSel(selected, mentionItems.length)]
          if (item) {
            insertMention(item)
            return
          }
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
    setFileHits([])
  }

  return (
    <Box flexDirection="column" width="100%">
      {attachmentCount > 0 && (
        <Text dimColor>
          {"  "}📎 {attachmentCount} image{attachmentCount === 1 ? "" : "s"} attached — enter to send
        </Text>
      )}
      {matches.length > 0 && <SlashMenu commands={matches} selected={clampSel(selected, matches.length)} />}
      {mentionActive && (mentionItems.length > 0 || fileLoading || (mention?.query ?? "").length > 0) && (
        <MentionMenu
          items={mentionItems}
          selected={clampSel(selected, mentionItems.length)}
          query={mention?.query ?? ""}
        />
      )}
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
    return <Text dimColor>Try &quot;fix lint errors&quot; or @file</Text>
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
