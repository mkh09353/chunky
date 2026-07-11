// Unit tests for FFF query builders + live search against this repo.
import { describe, expect, test, afterAll } from "bun:test"
import { buildFffQuery, destroyFinder, getFinder } from "../fff.ts"
import { fffind, ffgrep } from "./fff.ts"

afterAll(() => destroyFinder())

describe("buildFffQuery", () => {
  test("joins path + pattern", () => {
    expect(buildFffQuery("PromptInput", "src")).toBe("src/ PromptInput")
  })
  test("bare dir gets trailing slash", () => {
    expect(buildFffQuery("x", "packages/tui")).toBe("packages/tui/ x")
  })
  test("excludes become !tokens", () => {
    expect(buildFffQuery("foo", undefined, "test/,*.min.js")).toContain("!test/")
    expect(buildFffQuery("foo", undefined, "test/,*.min.js")).toContain("!*.min.js")
  })
  test("empty pattern with path still works", () => {
    expect(buildFffQuery("", "src/")).toBe("src/")
  })
})

describe("fffind / ffgrep live", () => {
  test("getFinder indexes workspace", async () => {
    const f = await getFinder()
    const r = f.fileSearch("fff.ts", { pageSize: 5 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.totalMatched).toBeGreaterThan(0)
  })

  test("fffind finds this package's tools", async () => {
    const out = await fffind.invoke({ pattern: "fff", path: "packages/server" })
    expect(typeof out).toBe("string")
    expect(out).toMatch(/fff\.ts/)
  })

  test("ffgrep finds a known symbol", async () => {
    const out = await ffgrep.invoke({
      pattern: "buildFffQuery",
      path: "packages/server",
      limit: 10,
    })
    expect(typeof out).toBe("string")
    expect(out).toMatch(/buildFffQuery/)
  })
})
