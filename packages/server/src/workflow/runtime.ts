// The workflow sandbox. A dynamic-workflow script is JavaScript authored by our
// OWN model (never an untrusted third party), so this is NOT a hard security
// boundary — it's the same trust level as the `bash` tool, which already runs
// arbitrary commands. What this DOES enforce is:
//   1. Scope — only the workflow primitives (agent/parallel/pipeline/phase/log/
//      args/budget) are in scope; common host escapes (require/process/fetch/…)
//      are shadowed to `undefined` so a script can't reach the host by accident.
//   2. Determinism — Date.now()/argless new Date()/Math.random() throw, so a run
//      is reproducible (the prerequisite for journaled resume, a later increment).
//
// The script runs as the body of an AsyncFunction: top-level `await` and a
// top-level `return <final value>` both work, matching the Claude Code / Pi
// workflow contract. (A real isolate — QuickJS — can be swapped in behind
// runScript() later without touching the primitives; see engine.ts.)

// The AsyncFunction constructor (not exposed as a global by name).
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as {
  new (...args: string[]): (...args: unknown[]) => Promise<unknown>
}

/** A Math whose `.random()` throws — every other member is the real Math. */
const guardedMath: Math = new Proxy(Math, {
  get(target, prop, receiver) {
    if (prop === "random") {
      return () => {
        throw new Error(
          "Math.random() is disabled in workflows (runs must be deterministic) — vary work by array index instead.",
        )
      }
    }
    return Reflect.get(target, prop, receiver)
  },
})

/** A Date whose `.now()` and argless `new Date()` throw; `new Date(ts)` is fine. */
function makeGuardedDate(): DateConstructor {
  const nondeterministic = () => {
    throw new Error(
      "Date.now() and argless new Date() are disabled in workflows (runs must be deterministic) — pass timestamps in via `args` and stamp results after the workflow returns.",
    )
  }
  // Built as `any` so attaching now/parse/UTC/prototype isn't type-checked against
  // DateConstructor (whose `prototype` is read-only); cast back at the return.
  const G: any = function (this: unknown, ...args: unknown[]) {
    if (args.length === 0) nondeterministic()
    return new (Date as unknown as new (...a: unknown[]) => Date)(...args)
  }
  G.now = nondeterministic
  G.parse = Date.parse
  G.UTC = Date.UTC
  G.prototype = Date.prototype
  return G as DateConstructor
}

// Host globals shadowed to `undefined` inside every script. `import` is a keyword
// (can't be a parameter name) so dynamic `import()` is not blocked here — that's
// the accepted trade-off of a non-isolate sandbox; the tool description tells the
// model not to reach outside the provided primitives.
const SHADOWED = [
  "require",
  "process",
  "module",
  "exports",
  "global",
  "globalThis",
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "Bun",
  "__dirname",
  "__filename",
] as const

/**
 * Strip module-level `export` keywords so a Claude-Code-style script that opens
 * with `export const meta = {…}` parses as a plain AsyncFunction body. We only
 * touch `export` immediately preceding a declaration keyword, so it can't corrupt
 * an `export` occurring inside a string.
 */
function stripExports(script: string): string {
  return script.replace(/\bexport\s+(?=(?:default\s+)?(?:const|let|var|function|class|async\s+function)\b)/g, "")
}

/**
 * Run a workflow `script` with `scope` bound as in-scope identifiers. Returns the
 * script's top-level `return` value (or undefined). Throws whatever the script
 * throws (surfaced to the model as the tool error).
 */
export async function runScript(script: string, scope: Record<string, unknown>): Promise<unknown> {
  const scopeNames = Object.keys(scope)
  const scopeValues = Object.values(scope)

  const guardNames = ["Math", "Date", ...SHADOWED]
  const guardValues: unknown[] = [guardedMath, makeGuardedDate(), ...SHADOWED.map(() => undefined)]

  const body = `"use strict";\n${stripExports(script)}`
  const fn = new AsyncFunction(...scopeNames, ...guardNames, body)
  return fn(...scopeValues, ...guardValues)
}
