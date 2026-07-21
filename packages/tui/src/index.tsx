#!/usr/bin/env bun
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { DEFAULT_PORT } from "@chunky/protocol"
import { App } from "./App.js"
import { Flag } from "./flags.js"
import { getServerToken } from "../../server/src/settings.ts"

const argv = process.argv.slice(2)
const wantMock = argv.includes("--mock")
const wantLive = argv.includes("--live")
// --threads drives the nested-thread mock demo (implies --mock).
const wantThreads = argv.includes("--threads")

const port = Flag.port ?? String(DEFAULT_PORT)
const baseUrl = `http://localhost:${port}`
const nativeFetch = globalThis.fetch
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const headers = new Headers(init?.headers)
  headers.set("Authorization", `Bearer ${getServerToken()}`)
  return nativeFetch(input, { ...init, headers })
}) as typeof fetch

async function serverIsUp(): Promise<boolean> {
  try {
    const res = await fetch(baseUrl + "/", { method: "GET", signal: AbortSignal.timeout(400) })
    return res.ok || res.status < 500
  } catch {
    return false
  }
}

// --mock forces mock; --live forces live; otherwise auto-detect (mock if no server).
let mode: "mock" | "live"
if (wantThreads || wantMock) mode = "mock"
else if (wantLive) mode = "live"
else mode = (await serverIsUp()) ? "live" : "mock"

// Mouse tracking is ON by default so OpenTUI's own selection layer works
// (drag-to-copy, clickable UI). Copy happens the moment a drag finishes — see
// copySelection in App.tsx. CHUNKY_DISABLE_MOUSE hands selection back to the
// terminal emulator (native ⌥-drag select + its own ⌘C).
//
// useKittyKeyboard {} enables the Kitty keyboard protocol's disambiguation +
// alternate-key reporting, so modifier chords (shift+enter, ctrl+i vs tab) are
// unambiguous. `{}` leaves release-event reporting OFF (the default), and
// exitOnCtrlC still fires — OpenTUI matches ctrl+c against the parsed key event,
// not the raw byte, so quitting is unaffected.
const renderer = await createCliRenderer({
  exitOnCtrlC: true,
  useMouse: !Flag.disableMouse,
  useKittyKeyboard: {},
})
// CHUNKY_NO_DEMO skips the mock auto-run turn so the input starts idle (handy for
// manually exercising the prompt, e.g. paste, without racing the demo).
const autoDemo = !Flag.noDemo
createRoot(renderer).render(
  <App mode={mode} baseUrl={baseUrl} cwd={process.cwd()} autoDemo={autoDemo} demo={wantThreads ? "threads" : "basic"} />,
)
