import { describe, expect, test } from "bun:test"
import {
  classifyCommand,
  collapseBlankLines,
  compressBashOutput,
  isImportantLine,
  lightCleanup,
  signalTruncate,
  stripAnsi,
  stripProgress,
  tokenize,
  SMALL_OUTPUT_BYTES,
} from "./compress.ts"
import { tryReduce } from "./compress-reducers.ts"

// ---------------------------------------------------------------------------
// tokenize / classify
// ---------------------------------------------------------------------------

describe("tokenize", () => {
  test("splits on whitespace", () => {
    expect(tokenize("git status -sb")).toEqual(["git", "status", "-sb"])
  })
  test("respects double quotes", () => {
    expect(tokenize(`gh pr view "my pr"`)).toEqual(["gh", "pr", "view", "my pr"])
  })
  test("respects single quotes", () => {
    expect(tokenize("echo 'a b'")).toEqual(["echo", "a b"])
  })
})

describe("classifyCommand", () => {
  test("simple git", () => {
    expect(classifyCommand("git status")).toEqual({
      executable: "git",
      args: ["status"],
      subcommand: "status",
    })
  })
  test("path executable uses basename", () => {
    expect(classifyCommand("/usr/bin/git diff HEAD")).toMatchObject({
      executable: "git",
      subcommand: "diff",
    })
  })
  test("skips env assignments", () => {
    expect(classifyCommand("FOO=bar git status")).toMatchObject({
      executable: "git",
      subcommand: "status",
    })
  })
  test("rejects pipes and compounds", () => {
    expect(classifyCommand("git status | cat")).toBeNull()
    expect(classifyCommand("git status && ls")).toBeNull()
    expect(classifyCommand("echo hi > out.txt")).toBeNull()
  })
  test("rejects interactive-looking tools", () => {
    expect(classifyCommand("vim file.ts")).toBeNull()
    expect(classifyCommand("ssh host")).toBeNull()
  })
  test("gh pr view", () => {
    expect(classifyCommand("gh pr view 12")).toMatchObject({
      executable: "gh",
      subcommand: "pr",
    })
  })
})

// ---------------------------------------------------------------------------
// cleanup stages
// ---------------------------------------------------------------------------

describe("lightCleanup", () => {
  test("strips ANSI colors", () => {
    const raw = "\u001b[31merror\u001b[0m here"
    expect(stripAnsi(raw)).toBe("error here")
    expect(lightCleanup(raw)).toBe("error here")
  })
  test("keeps final CR progress frame", () => {
    const raw = "downloading 10%\rdownloading 50%\rdownloading 100%\ndone"
    expect(stripProgress(raw)).toBe("downloading 100%\ndone")
  })
  test("collapses blank runs", () => {
    expect(collapseBlankLines("a\n\n\n\nb\n")).toBe("a\n\nb")
  })
})

describe("isImportantLine", () => {
  test("flags errors and diagnostics", () => {
    expect(isImportantLine("error TS2304: Cannot find name 'x'")).toBe(true)
    expect(isImportantLine("FAIL src/foo.test.ts")).toBe(true)
    expect(isImportantLine("    at Object.<anonymous> (foo.ts:10:5)")).toBe(true)
    expect(isImportantLine("everything is fine")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// signal truncate
// ---------------------------------------------------------------------------

describe("signalTruncate", () => {
  test("passthrough when small", () => {
    const text = "hello\nworld"
    const r = signalTruncate(text, { maxLines: 100, maxBytes: 10_000 })
    expect(r.truncated).toBe(false)
    expect(r.content).toBe(text)
  })

  test("keeps head, tail, and error lines in the middle", () => {
    const lines: string[] = []
    for (let i = 0; i < 20; i++) lines.push(`head-${i}`)
    for (let i = 0; i < 50; i++) lines.push(`noise-${i}`)
    lines.push("ERROR: boom in the middle")
    for (let i = 0; i < 50; i++) lines.push(`noise2-${i}`)
    for (let i = 0; i < 20; i++) lines.push(`tail-${i}`)
    const text = lines.join("\n")

    const r = signalTruncate(text, {
      maxLines: 60,
      maxBytes: 50_000,
      head: 10,
      tail: 10,
      importantCap: 20,
    })
    expect(r.truncated).toBe(true)
    expect(r.content).toContain("head-0")
    expect(r.content).toContain("tail-19")
    expect(r.content).toContain("ERROR: boom in the middle")
    expect(r.content).toContain("lines omitted")
    // most middle noise gone
    expect(r.content).not.toContain("noise-25")
  })
})

// ---------------------------------------------------------------------------
// reducers
// ---------------------------------------------------------------------------

describe("git reducers", () => {
  test("git status drops hint spam", () => {
    const status = [
      "On branch main",
      "Your branch is up to date with 'origin/main'.",
      "",
      "Changes not staged for commit:",
      '  (use "git add <file>..." to update what will be committed)',
      '  (use "git restore <file>..." to discard changes in working directory)',
      "\tmodified:   packages/server/src/tools/bash.ts",
      "",
      "Untracked files:",
      '  (use "git add <file>..." to include in what will be committed)',
      "\tpackages/server/src/tools/compress.ts",
      "",
      'no changes added to commit (use "git add" and/or "git commit -a")',
      // pad so we beat the 90% similarity gate after filtering use-hints only
      ...Array.from({ length: 40 }, (_, i) => `  (use "git something ${i}...")`),
    ].join("\n")

    const cmd = classifyCommand("git status")!
    // Force a clear win: inject lots of droppable noise lines
    const noisy =
      status +
      "\n" +
      Array.from({ length: 80 }, (_, i) => `hint: noise line ${i} you can ignore`).join("\n")

    const hit = tryReduce(cmd, noisy)
    // status reducer only keeps known patterns — hint noise drops
    expect(hit?.id).toBe("git-status")
    expect(hit!.text).toContain("On branch main")
    expect(hit!.text).toContain("modified:   packages/server/src/tools/bash.ts")
    expect(hit!.text).not.toContain("hint: noise line 10")
  })

  test("git diff drops context on large diffs", () => {
    const lines: string[] = ["diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", "@@ -1,5 +1,5 @@"]
    for (let i = 0; i < 80; i++) {
      lines.push(` context ${i}`)
      lines.push(`-old ${i}`)
      lines.push(`+new ${i}`)
    }
    const text = lines.join("\n")
    const cmd = classifyCommand("git diff")!
    const hit = tryReduce(cmd, text)
    expect(hit?.id).toBe("git-diff")
    expect(hit!.text).toContain("-old 0")
    expect(hit!.text).toContain("+new 0")
    expect(hit!.text).not.toContain(" context 10")
  })

  test("git diff --stat is passthrough", () => {
    const text = " bash.ts | 10 +++++-----\n 1 file changed"
    const cmd = classifyCommand("git diff --stat")!
    expect(tryReduce(cmd, text)).toBeNull()
  })
})

describe("gh reducers", () => {
  test("drops tips and keeps title/state/url", () => {
    const lines = [
      "title:\tFix bash compression",
      "state:\tOPEN",
      "author:\tmax",
      "url:\thttps://github.com/x/y/pull/1",
      "Tip: you can use gh pr checkout",
      "A new release of gh is available: 2.0 -> 2.1",
      ...Array.from({ length: 80 }, (_, i) => `body line ${i} lorem ipsum dolor sit amet`),
    ]
    const text = lines.join("\n")
    const cmd = classifyCommand("gh pr view 1")!
    const hit = tryReduce(cmd, text)
    expect(hit?.id).toBe("gh-pr")
    expect(hit!.text).toContain("title:")
    expect(hit!.text).toContain("https://github.com/x/y/pull/1")
    expect(hit!.text).not.toContain("Tip:")
    expect(hit!.text).not.toContain("A new release of gh")
  })

  test("skips --json", () => {
    const cmd = classifyCommand("gh pr view 1 --json title,state")!
    expect(tryReduce(cmd, '{"title":"x"}')).toBeNull()
  })
})

describe("package manager reducers", () => {
  test("npm install keeps errors and summary, drops progress", () => {
    const lines = [
      ...Array.from({ length: 40 }, (_, i) => `http fetch GET https://registry.npmjs.org/pkg-${i}`),
      "npm warn deprecated old@1.0.0: use new",
      "npm error code ERESOLVE",
      "npm error ERESOLVE could not resolve",
      "added 12 packages in 3s",
    ]
    const text = lines.join("\n")
    const cmd = classifyCommand("npm install")!
    const hit = tryReduce(cmd, text)
    expect(hit?.id).toBe("npm-install")
    expect(hit!.text).toContain("ERESOLVE")
    expect(hit!.text).toContain("added 12 packages")
    expect(hit!.text).not.toContain("http fetch GET")
  })

  test("bun install summary", () => {
    const lines = [
      ...Array.from({ length: 50 }, (_, i) => `Resolving dependencies ${i}`),
      "12 packages installed [2.3s]",
    ]
    const text = lines.join("\n")
    const cmd = classifyCommand("bun install")!
    const hit = tryReduce(cmd, text)
    expect(hit?.id).toBe("bun-install")
    expect(hit!.text).toContain("12 packages installed")
  })
})

describe("tsc reducer", () => {
  test("keeps diagnostics and summary", () => {
    const lines = [
      "bootstrapping...",
      ...Array.from({ length: 30 }, (_, i) => `note: checking file ${i}`),
      "src/a.ts(10,5): error TS2304: Cannot find name 'foo'.",
      "src/b.ts(2,1): error TS2322: Type 'string' is not assignable to type 'number'.",
      "Found 2 errors in 2 files.",
    ]
    const text = lines.join("\n")
    const cmd = classifyCommand("tsc -p .")!
    const hit = tryReduce(cmd, text)
    expect(hit?.id).toBe("tsc")
    expect(hit!.text).toContain("error TS2304")
    expect(hit!.text).toContain("Found 2 errors")
    expect(hit!.text).not.toContain("bootstrapping")
  })
})

describe("test runner reducer", () => {
  test("bun test keeps failures and summary", () => {
    const lines = [
      ...Array.from({ length: 40 }, (_, i) => `✓ passes/ok-${i}.test.ts > works`),
      "✗ compress.test.ts > blows up",
      "error: expect(true).toBe(false)",
      "      at /tmp/x.test.ts:10:5",
      " 10 | expect(true).toBe(false)",
      "",
      "1 pass",
      "1 fail",
      " 2 expect() calls",
      "Ran 2 tests across 2 files. [40.00ms]",
    ]
    const text = lines.join("\n")
    const cmd = classifyCommand("bun test")!
    const hit = tryReduce(cmd, text)
    expect(hit?.id).toBe("bun-test")
    expect(hit!.text).toContain("blows up")
    expect(hit!.text).toContain("1 fail")
    // should not keep all 40 passes
    const passLines = hit!.text.split("\n").filter((l) => l.includes("passes/ok-"))
    expect(passLines.length).toBeLessThan(15)
  })
})

// ---------------------------------------------------------------------------
// end-to-end compressBashOutput
// ---------------------------------------------------------------------------

describe("compressBashOutput", () => {
  test("empty", () => {
    const r = compressBashOutput("true", "")
    expect(r.content).toBe("")
    expect(r.truncated).toBe(false)
  })

  test("small output only cleans ANSI", () => {
    const r = compressBashOutput("echo hi", "\u001b[32mhi\u001b[0m")
    expect(r.content).toBe("hi")
    expect(r.reducer).toBeNull()
  })

  test("applies git status reducer + spill signal", () => {
    const noisy =
      [
        "On branch main",
        "Changes not staged for commit:",
        "\tmodified:   a.ts",
      ].join("\n") +
      "\n" +
      Array.from({ length: 200 }, (_, i) => `hint: ignore me ${i} with padding to exceed small-output threshold`).join(
        "\n",
      )

    // pad past SMALL_OUTPUT_BYTES so reducers run
    expect(Buffer.byteLength(noisy, "utf-8")).toBeGreaterThan(SMALL_OUTPUT_BYTES)

    const r = compressBashOutput("git status", noisy)
    expect(r.reducer).toBe("git-status")
    expect(r.content).toContain("On branch main")
    expect(r.content).toContain("modified:   a.ts")
    expect(r.content).not.toContain("hint: ignore me 50")
    expect(r.truncated).toBe(true)
  })

  test("compound commands skip reducers but still signal-truncate", () => {
    const lines = Array.from({ length: 2000 }, (_, i) =>
      i === 1000 ? "ERROR: buried" : `line-${i}`,
    )
    const text = lines.join("\n")
    const r = compressBashOutput("git status && echo done", text)
    expect(r.reducer).toBeNull()
    expect(r.truncated).toBe(true)
    expect(r.content).toContain("ERROR: buried")
    expect(r.content).toContain("line-0")
  })

  test("preserves important lines under generic path", () => {
    const lines: string[] = []
    for (let i = 0; i < 100; i++) lines.push(`start-${i}`)
    lines.push("FATAL panic: disk full")
    for (let i = 0; i < 2000; i++) lines.push(`mid-${i}`)
    for (let i = 0; i < 100; i++) lines.push(`end-${i}`)
    const r = compressBashOutput("some-custom-tool --verbose", lines.join("\n"))
    expect(r.reducer).toBeNull()
    expect(r.content).toContain("FATAL panic: disk full")
    expect(r.content).toContain("start-0")
    expect(r.content).toContain("end-99")
  })
})
