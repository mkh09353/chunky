import { useEffect, useRef, useState } from "react"
import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/react"
import { ROUTES, type FileSearchItem, type FileSearchResponse } from "@chunky/protocol"
import { ACCENT, BORDER } from "../theme.js"
import { rawModeSupported, useInput, usePasteText } from "../useInput.js"
import { COMMANDS, SlashMenu, type Command } from "./SlashMenu.js"
import { MentionMenu, activeMention } from "./MentionMenu.js"
import { expandPastes, normalizePaste, pasteLabel, shouldCollapsePaste } from "../pastes.js"

const { DIM, INVERSE } = TextAttributes

interface Props {
  disabled?: boolean
  /** `text` is the full message (pastes expanded) sent to the model; `display`
   *  is the shortened echo (paste placeholders kept) shown in the transcript. */
  onSubmit: (text: string, display?: string) => void
  onCommand: (name: string) => void
  /** Right-aligned status (model/effort/advisor) drawn INTO the bottom rule. */
  status?: string
  /** Ctrl+V: grab an image off the clipboard and attach it (async, in App). */
  onPasteImage?: () => void
  /** How many images are attached to the next message (shown above the input). */
  attachmentCount?: number
  /** Server base URL for FFF file search (live mode). Absent → no @ autocomplete. */
  baseUrl?: string
  /** When the nonce changes, replace the buffer with `text` — used to hand a
   *  message back after a canceled cache-guard confirm so nothing is lost. */
  prefill?: { text: string; nonce: number } | null
}

/**
 * The signature Claude Code input: a full-width band delimited by a horizontal
 * rule above and below, a violet `>` marker, and an inline block cursor.
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
  prefill,
}: Props) {
  const rawSupported = rawModeSupported
  // value + cursor live in ONE state so the key handler edits them with a
  // functional updater (which always receives the CURRENT state). bufRef
  // mirrors it for reads that can't use an updater.
  const [buf, setBuf] = useState<{ value: string; cursor: number }>({ value: "", cursor: 0 })
  const bufRef = useRef(buf)
  bufRef.current = buf
  const { value, cursor } = buf
  const [selected, setSelected] = useState(0)

  // Collapsed pastes for the message being composed: placeholder chip → full text.
  // The buffer only ever holds the chips, so multi-line pastes can't garble the
  // band; the full text is spliced back in `expandPastes` at submit time.
  const pastesRef = useRef<Map<string, string>>(new Map())
  const pasteSeqRef = useRef(0)

  // Restore a handed-back message (canceled cache-guard confirm). Keyed on the
  // nonce so the same text can be handed back more than once. The handed-back
  // text is already fully expanded, so drop any stale paste chips.
  useEffect(() => {
    if (prefill) {
      pastesRef.current = new Map()
      pasteSeqRef.current = 0
      setBuf({ value: prefill.text, cursor: prefill.text.length })
    }
  }, [prefill?.nonce])

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

  // Splice text in at the cursor. A big/multi-line chunk (only ever a paste)
  // collapses to a chip so the single-line band can't be flooded or garbled by
  // embedded newlines; the full body is stashed and restored at submit. Used by
  // both typed keystrokes and the paste channel below.
  const insertChunk = (raw: string) => {
    const chunk = normalizePaste(raw)
    let insert = chunk
    if (shouldCollapsePaste(chunk)) {
      insert = pasteLabel(++pasteSeqRef.current, chunk)
      pastesRef.current.set(insert, chunk)
    }
    setBuf((b) => ({
      value: b.value.slice(0, b.cursor) + insert + b.value.slice(b.cursor),
      cursor: b.cursor + insert.length,
    }))
    setSelected(0)
  }

  // Bracketed paste arrives on OpenTUI's separate paste channel (not useInput).
  usePasteText(insertChunk, { isActive: rawSupported && !disabled })

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
        const display = bufRef.current.value.trim()
        const text = expandPastes(display, pastesRef.current).trim()
        // Allow an image-only message: submit when there's text OR attachments.
        if (!text && attachmentCount === 0) return
        reset()
        onSubmit(text, display)
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
      if (input) insertChunk(input)
    },
    { isActive: rawSupported && !disabled },
  )

  function reset() {
    setBuf({ value: "", cursor: 0 })
    setSelected(0)
    setFileHits([])
    pastesRef.current = new Map()
    pasteSeqRef.current = 0
  }

  return (
    <box flexDirection="column" width="100%">
      {attachmentCount > 0 && (
        <text attributes={DIM}>
          {"  "}📎 {attachmentCount} image{attachmentCount === 1 ? "" : "s"} attached — enter to send
        </text>
      )}
      {matches.length > 0 && <SlashMenu commands={matches} selected={clampSel(selected, matches.length)} />}
      {mentionActive && (mentionItems.length > 0 || fileLoading || (mention?.query ?? "").length > 0) && (
        <MentionMenu
          items={mentionItems}
          selected={clampSel(selected, mentionItems.length)}
          query={mention?.query ?? ""}
        />
      )}
      <box
        width="100%"
        flexDirection="row"
        border={["top"]}
        borderStyle="single"
        borderColor={BORDER}
        flexShrink={0}
      >
        <text fg={ACCENT}>{"❯ "}</text>
        <CursorText value={value} cursor={cursor} showCursor={rawSupported && !disabled} />
      </box>
      <BottomRule status={status} />
    </box>
  )
}

/**
 * The input's bottom rule with the model/advisor status drawn into its right
 * end — a run of `─` fills the left, then the status sits flush right, so the
 * label appears to cut through the border line (grok-code style). Falls back to
 * a plain full-width rule when there's no status yet.
 */
function BottomRule({ status }: { status?: string }) {
  const { width: cols } = useTerminalDimensions()
  const label = (status ?? "").trim()
  // The dashes use the SAME border color as the top rule so both lines match.
  // The status is embedded near the right with the rule continuing past it to
  // the edge (grok-code style), a space on each side.
  if (!label) {
    return <text fg={BORDER}>{"─".repeat(Math.max(0, cols - 1))}</text>
  }
  const rightDashes = 3
  const left = Math.max(0, cols - label.length - rightDashes - 3) // 2 spaces + 1 margin
  return (
    <text wrapMode="none">
      <span fg={BORDER}>{"─".repeat(left)}</span>
      <span attributes={DIM}> {label} </span>
      <span fg={BORDER}>{"─".repeat(rightDashes)}</span>
    </text>
  )
}

/** Render the line with an inverse-block cursor, like Claude Code's input. */
function CursorText({ value, cursor, showCursor }: { value: string; cursor: number; showCursor: boolean }) {
  if (value.length === 0) {
    return <text attributes={DIM}>Try &quot;fix lint errors&quot; or @file</text>
  }
  const before = value.slice(0, cursor)
  const at = value.slice(cursor, cursor + 1) || " "
  const after = value.slice(cursor + 1)
  return (
    <text>
      {before}
      {showCursor ? <span attributes={INVERSE}>{at}</span> : at === " " ? "" : at}
      {after}
    </text>
  )
}
