import { describe, expect, test } from "bun:test"
import { buildAuthorizeUrl } from "./grok.ts"

describe("Grok OAuth", () => {
  test("uses the OpenCode referrer required by subscription OAuth", () => {
    const url = new URL(
      buildAuthorizeUrl(
        { verifier: "verifier", challenge: "challenge" },
        "state",
        "nonce",
      ),
    )

    expect(url.searchParams.get("referrer")).toBe("opencode")
    expect(url.searchParams.get("plan")).toBe("generic")
  })
})
