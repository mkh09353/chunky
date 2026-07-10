// Run: bun run packages/tui/src/markdown.test.ts
import { parseBlocks, parseInline } from "./markdown.ts"

let passed = 0
let failed = 0

function assert(cond: unknown, msg: string) {
  if (cond) {
    passed++
  } else {
    failed++
    console.error("FAIL:", msg)
  }
}

function eq(actual: unknown, expected: unknown, msg: string) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    passed++
  } else {
    failed++
    console.error("FAIL:", msg)
    console.error("  expected:", e)
    console.error("  actual:  ", a)
  }
}

// --- blocks ---

eq(parseBlocks("# Title"), [{ kind: "heading", level: 1, text: "Title" }], "h1")
eq(parseBlocks("## Sub"), [{ kind: "heading", level: 2, text: "Sub" }], "h2")
eq(
  parseBlocks("- one\n- two"),
  [
    { kind: "bullet", indent: 0, text: "one" },
    { kind: "bullet", indent: 0, text: "two" },
  ],
  "bullets",
)
eq(
  parseBlocks("1. first\n2. second"),
  [
    { kind: "numbered", indent: 0, n: "1", text: "first" },
    { kind: "numbered", indent: 0, n: "2", text: "second" },
  ],
  "numbered",
)

eq(
  parseBlocks("```ts\nconst x = 1\n```"),
  [{ kind: "code", lang: "ts", lines: ["const x = 1"] }],
  "fenced code with lang",
)

eq(
  parseBlocks("```\nplain\n```"),
  [{ kind: "code", lang: "", lines: ["plain"] }],
  "fenced code no lang",
)

eq(
  parseBlocks("before\n```bash\nCHUNKY_RECURSION_LIMIT=80 chunky\n```\nafter"),
  [
    { kind: "paragraph", text: "before" },
    { kind: "code", lang: "bash", lines: ["CHUNKY_RECURSION_LIMIT=80 chunky"] },
    { kind: "paragraph", text: "after" },
  ],
  "fence between paragraphs (screenshot case)",
)

// Unclosed fence (streaming): remainder is code, not raw ``` left on screen.
eq(
  parseBlocks("```js\nconsole.log(1)"),
  [{ kind: "code", lang: "js", lines: ["console.log(1)"] }],
  "unclosed fence",
)

eq(parseBlocks("---"), [{ kind: "hr" }], "hr dashes")
eq(parseBlocks("***"), [{ kind: "hr" }], "hr stars")

// Leading/trailing blanks stripped; internal blank kept once.
eq(
  parseBlocks("\n\nhello\n\n\nworld\n\n"),
  [
    { kind: "paragraph", text: "hello" },
    { kind: "blank" },
    { kind: "paragraph", text: "world" },
  ],
  "blank collapse + trim",
)

// --- inline ---

eq(parseInline("plain"), [{ kind: "text", text: "plain" }], "plain text")
eq(
  parseInline("use `recursionLimit` here"),
  [
    { kind: "text", text: "use " },
    { kind: "code", text: "recursionLimit" },
    { kind: "text", text: " here" },
  ],
  "inline code",
)
eq(
  parseInline("**What it means**"),
  [{ kind: "bold", text: "What it means" }],
  "bold",
)
eq(
  parseInline("set the `recursionLimit` config key"),
  [
    { kind: "text", text: "set the " },
    { kind: "code", text: "recursionLimit" },
    { kind: "text", text: " config key" },
  ],
  "inline code mid-sentence",
)
eq(
  parseInline("a **bold** and `code` mix"),
  [
    { kind: "text", text: "a " },
    { kind: "bold", text: "bold" },
    { kind: "text", text: " and " },
    { kind: "code", text: "code" },
    { kind: "text", text: " mix" },
  ],
  "bold + code",
)
eq(
  parseInline("*emphasis* here"),
  [
    { kind: "italic", text: "emphasis" },
    { kind: "text", text: " here" },
  ],
  "italic",
)
// snake_case must not become italic.
eq(
  parseInline("use recursion_limit please"),
  [{ kind: "text", text: "use recursion_limit please" }],
  "no underscore italic on snake_case",
)
// Unclosed markers stay literal.
eq(
  parseInline("still **open"),
  [{ kind: "text", text: "still **open" }],
  "unclosed bold is literal",
)
eq(
  parseInline("still `open"),
  [{ kind: "text", text: "still `open" }],
  "unclosed code is literal",
)
// Code wins over bold markers inside it.
eq(
  parseInline("x `a **b** c` y"),
  [
    { kind: "text", text: "x " },
    { kind: "code", text: "a **b** c" },
    { kind: "text", text: " y" },
  ],
  "code shields bold",
)

// Full sample shaped like the screenshot (fences + bold headers + lists).
const sample = `This is a **LangGraph safety cap**, not a crash.

**What it means**
LangGraph agents run a loop:
\`\`\`
model → tool(s) → model → tool(s) → … → model stops
\`\`\`

Each hop is a "step." LangGraph defaults \`recursionLimit\` to **25**.

**What to do**
1. **Restart** so the server picks up the new limit
2. For heavy turns, raise it:
\`\`\`bash
CHUNKY_RECURSION_LIMIT=80 chunky
\`\`\`
3. If it still dies, the model is likely looping`

const kinds = parseBlocks(sample).map((b) => b.kind)
assert(kinds.includes("code"), "sample has code blocks")
assert(kinds.includes("numbered"), "sample has numbered list")
assert(kinds.includes("heading") || kinds.includes("paragraph"), "sample has prose")
const codes = parseBlocks(sample).filter((b) => b.kind === "code")
eq(codes.length, 2, "sample: two fenced blocks")
eq(
  codes[1],
  { kind: "code", lang: "bash", lines: ["CHUNKY_RECURSION_LIMIT=80 chunky"] },
  "sample: bash fence parsed cleanly",
)

// No raw fence markers left as paragraph text.
const leaked = parseBlocks(sample).some(
  (b) => b.kind === "paragraph" && (b.text.includes("```") || b.text.startsWith("```")),
)
assert(!leaked, "no raw ``` fences leak into paragraphs")

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
