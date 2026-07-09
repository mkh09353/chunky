#!/usr/bin/env bun
import React from "react"
import { render } from "ink"
import { DEFAULT_PORT } from "@mc/protocol"
import { App } from "./App.js"

const argv = process.argv.slice(2)
const wantMock = argv.includes("--mock")
const wantLive = argv.includes("--live")

const port = process.env.MC_PORT ?? String(DEFAULT_PORT)
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
if (wantMock) mode = "mock"
else if (wantLive) mode = "live"
else mode = (await serverIsUp()) ? "live" : "mock"

render(<App mode={mode} baseUrl={baseUrl} cwd={process.cwd()} />)
