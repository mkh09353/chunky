#!/usr/bin/env bun
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { DEFAULT_PORT } from "@chunky/protocol"
import { App } from "./App.js"

const argv = process.argv.slice(2)
const wantMock = argv.includes("--mock")
const wantLive = argv.includes("--live")
// --threads drives the nested-thread mock demo (implies --mock).
const wantThreads = argv.includes("--threads")

const port = process.env.CHUNKY_PORT ?? String(DEFAULT_PORT)
const baseUrl = `http://localhost:${port}`

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

const renderer = await createCliRenderer({ exitOnCtrlC: true })
// CHUNKY_NO_DEMO skips the mock auto-run turn so the input starts idle (handy for
// manually exercising the prompt, e.g. paste, without racing the demo).
const autoDemo = !process.env.CHUNKY_NO_DEMO
createRoot(renderer).render(
  <App mode={mode} baseUrl={baseUrl} cwd={process.cwd()} autoDemo={autoDemo} demo={wantThreads ? "threads" : "basic"} />,
)
