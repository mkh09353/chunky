// Command-aware output reducers for high-frequency agent tools.
// Each reducer is pure: (classified, cleanedText) → { id, text } | null.
// Return null to fall through to the generic signal-preserving path.
//
// Design rules:
// - Prefer dropping noise over inventing structure.
// - If a reducer would keep almost everything, return null (generic handles size).
// - On empty keep-set, return null so we never swallow real output.
// - Deterministic. No LLM. No I/O.

import type { ClassifiedCommand } from "./compress.ts"

export interface ReduceHit {
  id: string
  text: string
}

type Reducer = (cmd: ClassifiedCommand, text: string) => ReduceHit | null

const REDUCERS: Reducer[] = [reduceGit, reduceGh, reducePackageManager, reduceTsc, reduceTestRunner]

/** Try reducers in order; first hit wins. */
export function tryReduce(cmd: ClassifiedCommand, text: string): ReduceHit | null {
  for (const r of REDUCERS) {
    const hit = r(cmd, text)
    if (hit) return hit
  }
  return null
}

function lineCount(text: string): number {
  if (!text) return 0
  return text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length
}

function tooSimilar(compact: string, original: string, ratio = 0.9): boolean {
  return compact.length >= original.length * ratio
}

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

function reduceGit(cmd: ClassifiedCommand, text: string): ReduceHit | null {
  if (cmd.executable !== "git") return null
  const sub = cmd.subcommand
  if (sub === "status") return reduceGitStatus(text)
  if (sub === "diff") return reduceGitDiff(cmd, text)
  if (sub === "log") return reduceGitLog(text)
  return null
}

function reduceGitStatus(text: string): ReduceHit | null {
  const lines = text.split("\n")
  // Porcelain (-sb / --porcelain) is already compact — pass through.
  const nonEmpty = lines.filter((l) => l.length > 0)
  if (
    nonEmpty.length > 0 &&
    nonEmpty.every((l) => /^[ ?MADRCU!]{1,2}\s/.test(l) || l.startsWith("## "))
  ) {
    return null
  }

  const kept = lines.filter((line) => {
    if (line.trim() === "") return true
    if (/^On branch |^HEAD detached |^Your branch /.test(line)) return true
    if (/^All conflicts fixed|^Unmerged paths:/.test(line)) return true
    if (/^Changes to be committed:|^Changes not staged for commit:|^Untracked files:/.test(line))
      return true
    if (/^nothing to commit/.test(line)) return true
    if (/^\s+\(use "/.test(line)) return true
    if (line.startsWith("\t") || /^\s{2}\S/.test(line)) return true
    if (/^(modified|new file|deleted|renamed|both modified|both added):/i.test(line.trim()))
      return true
    // "Changes not staged..." style short status without tabs
    if (/^\s*(modified|deleted|new file|renamed):/.test(line)) return true
    return false
  })

  const compact = kept.join("\n").trimEnd()
  if (!compact || tooSimilar(compact, text)) return null
  return { id: "git-status", text: compact }
}

function reduceGitDiff(cmd: ClassifiedCommand, text: string): ReduceHit | null {
  // --stat / --shortstat / --name-only already compact
  if (
    cmd.args.some(
      (a) => a === "--stat" || a === "--shortstat" || a === "--name-only" || a === "--name-status",
    )
  ) {
    return null
  }
  const lines = text.split("\n")
  if (lines.length <= 120) return null // small diffs: keep context

  const kept: string[] = []
  for (const line of lines) {
    if (
      line.startsWith("diff --git") ||
      line.startsWith("index ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ") ||
      line.startsWith("@@") ||
      line.startsWith("new file") ||
      line.startsWith("deleted file") ||
      line.startsWith("rename ") ||
      line.startsWith("similarity ") ||
      line.startsWith("Binary files") ||
      line.startsWith("+") ||
      line.startsWith("-")
    ) {
      kept.push(line)
    }
  }
  const compact = kept.join("\n").trimEnd()
  if (!compact || tooSimilar(compact, text, 0.95)) return null
  return {
    id: "git-diff",
    text:
      compact +
      "\n\n[git-diff: context lines omitted for size; use git diff --stat or read the file]",
  }
}

function reduceGitLog(text: string): ReduceHit | null {
  const lines = text.split("\n")
  if (lines.length <= 40) return null
  const kept: string[] = []
  let afterHeaderBlank = false
  let subjectTaken = false
  for (const line of lines) {
    if (/^commit [0-9a-f]{7,}/i.test(line)) {
      kept.push(line)
      afterHeaderBlank = false
      subjectTaken = false
      continue
    }
    if (/^Author:|^Date:|^Merge:/.test(line)) {
      kept.push(line)
      continue
    }
    if (line.trim() === "") {
      afterHeaderBlank = true
      continue
    }
    if (afterHeaderBlank && !subjectTaken) {
      kept.push(line)
      subjectTaken = true
    }
  }
  const compact = kept.join("\n").trimEnd()
  if (!compact || tooSimilar(compact, text)) return null
  return { id: "git-log", text: compact }
}

// ---------------------------------------------------------------------------
// gh (GitHub CLI)
// ---------------------------------------------------------------------------

function reduceGh(cmd: ClassifiedCommand, text: string): ReduceHit | null {
  if (cmd.executable !== "gh") return null
  const sub = cmd.subcommand
  // JSON / jq output is already structured — don't mangle.
  if (
    cmd.args.includes("--json") ||
    cmd.args.includes("-q") ||
    cmd.args.some((a) => a.startsWith("--jq"))
  ) {
    return null
  }
  const id = sub === "pr" || sub === "issue" || sub === "run" || sub === "api" ? `gh-${sub}` : "gh"
  return reduceGhGeneric(text, id)
}

function isGhChrome(line: string): boolean {
  const t = line.trim()
  if (/^(✓|✔|●|•)\s*Waiting\b/i.test(t)) return true
  if (/^Refreshing\b/i.test(t)) return true
  if (/^Tip:/i.test(t)) return true
  if (/^A new release of gh is available/i.test(t)) return true
  return false
}

function reduceGhGeneric(text: string, id: string): ReduceHit | null {
  const lines = text.split("\n")
  if (lines.length <= 60 && text.length < 8_000) return null

  const meta: string[] = []
  const body: string[] = []
  for (const line of lines) {
    const t = line.trim()
    if (!t) continue
    if (isGhChrome(line)) continue
    if (
      /^(title|state|author|url|number|status|conclusion|name|event|branch|labels|assignees|reviewers|checks?):/i.test(
        t,
      ) ||
      /^https?:\/\//i.test(t) ||
      /\b(pass|fail|success|failure|cancelled|error|pending)\b/i.test(t) ||
      /^#\d+/.test(t) ||
      /^[-*]\s/.test(t) ||
      /error|failed|fatal/i.test(t)
    ) {
      meta.push(line)
      continue
    }
    // prose / table body — keep a short head only
    if (body.length < 30) body.push(line)
  }

  const kept = meta.length > 0 ? [...meta, ...body] : body
  if (kept.length === 0) return null

  let compact = kept.join("\n").trimEnd()
  if (body.length >= 30 || lines.length > kept.length + 2) {
    compact += "\n\n[gh: body truncated; re-run with --json for structured fields]"
  }
  if (tooSimilar(compact, text)) return null
  return { id, text: compact }
}

// ---------------------------------------------------------------------------
// package managers: bun / npm / pnpm / yarn
// ---------------------------------------------------------------------------

function reducePackageManager(cmd: ClassifiedCommand, text: string): ReduceHit | null {
  const exe = cmd.executable
  if (exe !== "npm" && exe !== "pnpm" && exe !== "yarn" && exe !== "bun") return null

  // test subcommands belong to the test-runner reducer
  if (cmd.subcommand === "test" || cmd.args[0] === "test") return null
  // bun run / npm run scripts — only compress if they look like install-ish noise later via content; skip here
  if (cmd.subcommand === "run" || cmd.subcommand === "x" || cmd.subcommand === "exec") return null

  const sub = cmd.subcommand
  const isInstall =
    sub === "install" ||
    sub === "i" ||
    sub === "add" ||
    sub === "remove" ||
    sub === "ci" ||
    sub === "update" ||
    sub === "upgrade" ||
    (exe === "bun" && (sub === null || sub === "install"))

  // bare `bun` with a script name is not install
  if (exe === "bun" && sub !== null && sub !== "install" && !isInstall) {
    // bun <script> — leave alone
    if (!["install", "i", "add", "remove", "update", "pm"].includes(sub)) return null
  }

  if (!isInstall && exe !== "npm" && exe !== "pnpm" && exe !== "yarn") return null
  // For npm/pnpm/yarn non-install, still try noise filter if large
  if (!isInstall && lineCount(text) <= 40) return null

  const lines = text.split("\n")
  if (lines.length <= 30 && text.length < 4_000) return null

  const keepRe =
    /\b(error|err!|ERR!|warn(?:ing)?|ELIFECYCLE|peer|conflict|unmet|incompatible|added|removed|updated|installed|packages?|dependencies|done in|audited|vulnerabilit|deprecated|failed|EACCES|ENOENT|resolved)\b/i

  const kept = lines.filter((line) => {
    const t = line.trim()
    if (!t) return false
    if (/^(progress|download|resolving|fetching|http fetch)\b/i.test(t)) return false
    if (keepRe.test(t)) return true
    if (/\d+\s+packages?\s+(installed|added|removed)/i.test(t)) return true
    return false
  })

  if (kept.length === 0) {
    if (!isInstall) return null
    const tail = lines.filter((l) => l.trim()).slice(-15)
    const compact = tail.join("\n").trimEnd()
    if (!compact) return null
    return { id: `${exe}-install`, text: compact }
  }

  const compact = kept.join("\n").trimEnd()
  if (!compact || tooSimilar(compact, text, 0.85)) return null
  return { id: `${exe}-${isInstall ? "install" : "pm"}`, text: compact }
}

// ---------------------------------------------------------------------------
// tsc / typescript
// ---------------------------------------------------------------------------

function reduceTsc(cmd: ClassifiedCommand, text: string): ReduceHit | null {
  const isTsc =
    cmd.executable === "tsc" ||
    (cmd.executable === "npx" && cmd.args[0] === "tsc") ||
    (cmd.executable === "bunx" && cmd.args[0] === "tsc")

  // Content-based: only when clearly tsc diagnostics dominate
  const hasTscDiag = /error TS\d+/i.test(text) || /\(\d+,\d+\):\s+(error|warning)\s+TS\d+/i.test(text)
  if (!isTsc && !hasTscDiag) return null
  // For content-only match, require summary-ish signal so random "error TS" in logs doesn't trigger
  if (!isTsc && !/Found \d+ error/i.test(text) && lineCount(text) < 20) return null

  const lines = text.split("\n")
  if (lines.length <= 40 && isTsc) {
    // small tsc output — still drop non-diagnostic noise if any
  } else if (lines.length <= 40) {
    return null
  }

  const kept: string[] = []
  let prevDiag = false
  for (const line of lines) {
    if (/\(\d+,\d+\):\s+(error|warning)\s+TS\d+/i.test(line) || /error TS\d+/i.test(line)) {
      kept.push(line)
      prevDiag = true
      continue
    }
    if (/^Found \d+ error/i.test(line)) {
      kept.push(line)
      prevDiag = false
      continue
    }
    // continuation / code frame
    if (prevDiag && (/^\s{2,}/.test(line) || /^\s*[~^]+/.test(line) || /^\s*\d+\s*\|/.test(line))) {
      kept.push(line)
      continue
    }
    prevDiag = false
  }

  const compact = kept.join("\n").trimEnd()
  if (!compact || tooSimilar(compact, text)) return null
  return { id: "tsc", text: compact }
}

// ---------------------------------------------------------------------------
// test runners: bun test, npm/pnpm/yarn test, vitest, jest, pytest
// ---------------------------------------------------------------------------

function isTestCommand(cmd: ClassifiedCommand): boolean {
  const exe = cmd.executable
  const sub = cmd.subcommand
  if (exe === "vitest" || exe === "jest" || exe === "pytest") return true
  if (exe === "bun" && sub === "test") return true
  if ((exe === "npm" || exe === "pnpm" || exe === "yarn") && (sub === "test" || cmd.args[0] === "test"))
    return true
  if ((exe === "python" || exe === "python3") && cmd.args.includes("pytest")) return true
  // npx vitest / bunx jest
  if ((exe === "npx" || exe === "bunx") && (cmd.args[0] === "vitest" || cmd.args[0] === "jest"))
    return true
  return false
}

function reduceTestRunner(cmd: ClassifiedCommand, text: string): ReduceHit | null {
  if (!isTestCommand(cmd)) return null

  const lines = text.split("\n")
  // Always try when there are many pass lines to drop, even if total is moderate
  const passHeavy = lines.filter((l) => /^\s*(✓|✔)/.test(l) || /\bPASS\b/.test(l)).length >= 15
  if (lines.length <= 50 && text.length < 6_000 && !passHeavy) return null

  const keepRe =
    /\b(fail|failed|error|error:|assert|expected|received|PASS|FAIL|✗|×|✖|✓|✔|tests?\s|Test Files|Snapshots|Time:|Ran \d+|passed|passing|failing|skipped|todo|⎯|FAIL\s|PASS\s|Error:|Expected|Received|pytest|FAILED|ERROR)\b/i

  const kept: string[] = []
  let inFailure = false
  let passSampled = 0
  for (const line of lines) {
    const t = line.trim()
    if (!t) {
      if (inFailure) kept.push(line)
      continue
    }
    // sample a few pass lines only
    if ((/^\s*(✓|✔)/.test(line) || /^\s*PASS\b/.test(line)) && !/\b(fail|✗|×|✖)\b/i.test(line)) {
      if (passSampled < 8) {
        kept.push(line)
        passSampled++
      }
      inFailure = false
      continue
    }
    if (keepRe.test(line) || /^\s+at\s+/.test(line) || /^\s+\d+\s+\|/.test(line)) {
      kept.push(line)
      inFailure = /\b(fail|error|✗|×|✖|FAIL|FAILED|Error:|Expected|Received)\b/i.test(line)
      continue
    }
    if (inFailure && (/^\s+/.test(line) || line.startsWith("+") || line.startsWith("-"))) {
      kept.push(line)
      continue
    }
    inFailure = false
  }

  // Always keep the summary tail (skip pure pass lines — already sampled above)
  const tail = lines.filter((l) => l.trim()).slice(-20)
  for (const line of tail) {
    if (kept.includes(line)) continue
    if ((/^\s*(✓|✔)/.test(line) || /^\s*PASS\b/.test(line)) && !/\b(fail|✗|×|✖)\b/i.test(line))
      continue
    kept.push(line)
  }

  const compact = kept.join("\n").trimEnd()
  if (!compact || tooSimilar(compact, text)) return null
  return { id: `${cmd.executable}-test`, text: compact }
}
