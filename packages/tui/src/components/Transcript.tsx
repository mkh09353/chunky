import React from "react"
import { Box, Text } from "ink"
import type { Item } from "../transcript.js"
import { ACCENT, DOT, ERROR, SUCCESS } from "../theme.js"

export function Transcript({ items }: { items: Item[] }) {
  return (
    <Box flexDirection="column">
      {items.map((it, i) => (
        <ItemView key={i} item={it} />
      ))}
    </Box>
  )
}

function ItemView({ item }: { item: Item }) {
  switch (item.kind) {
    case "user":
      return (
        <Box marginTop={1}>
          <Text color={ACCENT}>{"> "}</Text>
          <Text>{item.text}</Text>
        </Box>
      )

    case "assistant":
      return (
        <Box marginTop={1} flexDirection="row">
          <Text color={ACCENT}>{DOT} </Text>
          <Box flexDirection="column">
            <Markdown text={item.text} />
          </Box>
        </Box>
      )

    case "tool":
      return (
        <Box marginTop={1} flexDirection="column">
          <Box>
            <Text color={ACCENT}>{DOT} </Text>
            <Text bold>{item.name}</Text>
            <Text dimColor>({summarizeInput(item.input)})</Text>
          </Box>
          {item.done && (
            <Box marginLeft={2}>
              <Text dimColor>
                {"  ⎿  "}
                <Text color={item.ok ? SUCCESS : ERROR}>{item.ok ? "" : "error: "}</Text>
                {summarizeOutput(item.output ?? "")}
              </Text>
            </Box>
          )}
        </Box>
      )

    case "error":
      return (
        <Box marginTop={1}>
          <Text color={ERROR}>✗ {item.text}</Text>
        </Box>
      )
  }
}

/** Light markdown: bold headers, list bullets, and inline **bold** segments. */
function Markdown({ text }: { text: string }) {
  const lines = text.split("\n")
  return (
    <>
      {lines.map((line, i) => {
        const header = /^(#{1,6})\s+(.*)$/.exec(line)
        if (header) {
          return (
            <Text key={i} bold color={ACCENT}>
              {header[2]}
            </Text>
          )
        }
        const bullet = /^(\s*)([-*])\s+(.*)$/.exec(line)
        if (bullet) {
          return (
            <Text key={i}>
              {bullet[1]}
              <Text color={ACCENT}>• </Text>
              <Inline text={bullet[3]!} />
            </Text>
          )
        }
        const numbered = /^(\s*)(\d+)\.\s+(.*)$/.exec(line)
        if (numbered) {
          return (
            <Text key={i}>
              {numbered[1]}
              <Text color={ACCENT}>{numbered[2]}. </Text>
              <Inline text={numbered[3]!} />
            </Text>
          )
        }
        return (
          <Text key={i}>
            <Inline text={line} />
          </Text>
        )
      })}
    </>
  )
}

/** Render **bold** spans inline; everything else default fg. */
function Inline({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g)
  return (
    <>
      {parts.map((p, i) =>
        /^\*\*[^*]+\*\*$/.test(p) ? (
          <Text key={i} bold>
            {p.slice(2, -2)}
          </Text>
        ) : (
          <Text key={i}>{p}</Text>
        ),
      )}
    </>
  )
}

function summarizeInput(input: unknown): string {
  if (input == null) return ""
  if (typeof input === "string") return truncate(input, 60)
  try {
    const entries = Object.entries(input as Record<string, unknown>)
    return truncate(entries.map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(", "), 60)
  } catch {
    return ""
  }
}

function summarizeOutput(output: string): string {
  const firstLine = output.split("\n")[0] ?? ""
  const extra = output.includes("\n") ? ` (+${output.split("\n").length - 1} lines)` : ""
  return truncate(firstLine, 70) + extra
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s
}
