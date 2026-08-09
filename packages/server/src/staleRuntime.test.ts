import { describe, expect, test } from "bun:test"
import { checkInstalledVersion, isStaleRuntimeError, onStaleRuntime, reportStaleRuntime } from "./staleRuntime.ts"

describe("stale runtime error classification", () => {
  test("matches the Agent SDK native binary failure", () => {
    expect(isStaleRuntimeError(new Error("Native CLI binary for darwin-arm64 not found"))).toBe(true)
  })

  test("matches wrapped messages and cause chains", () => {
    expect(isStaleRuntimeError(new Error(
      "Anthropic Agent SDK run produced no output: Native CLI binary for linux-x64 not found",
    ))).toBe(true)
    expect(isStaleRuntimeError(new Error("run failed", {
      cause: new Error("Native CLI binary for darwin-arm64 not found"),
    }))).toBe(true)
  })

  test("rejects generic ENOENT and unrelated failures", () => {
    expect(isStaleRuntimeError(Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }))).toBe(false)
    expect(isStaleRuntimeError(new Error("Anthropic request failed: rate limited"))).toBe(false)
    expect(isStaleRuntimeError(null)).toBe(false)
  })

  test("reports a matching failure at most once without leaking callback errors", () => {
    let calls = 0
    onStaleRuntime(() => {
      calls++
      throw new Error("retirement callback failed")
    })
    expect(() => reportStaleRuntime(new Error("Native CLI binary for darwin-arm64 not found"))).not.toThrow()
    expect(() => reportStaleRuntime(new Error("Native CLI binary for linux-x64 not found"))).not.toThrow()
    expect(calls).toBe(1)
  })
})

describe("installed version staleness", () => {
  test("retires with a differing successfully-read version", () => {
    const retired: string[] = []
    checkInstalledVersion("1.2.3", () => "1.2.4", (version) => retired.push(version))
    expect(retired).toEqual(["1.2.4"])
  })

  test("does not retire for equal versions or failed reads", () => {
    let retirements = 0
    const retire = () => { retirements++ }
    checkInstalledVersion("1.2.3", () => "1.2.3", retire)
    checkInstalledVersion("1.2.3", () => null, retire)
    checkInstalledVersion("1.2.3", () => { throw new Error("unreadable") }, retire)
    expect(retirements).toBe(0)
  })
})
