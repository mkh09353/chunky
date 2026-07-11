import { describe, expect, test } from "bun:test"
import { activeMention } from "./MentionMenu.tsx"

describe("activeMention", () => {
  test("detects bare @ at start", () => {
    expect(activeMention("@", 1)).toEqual({ start: 0, query: "" })
  })

  test("detects @query at start", () => {
    expect(activeMention("@Prompt", 7)).toEqual({ start: 0, query: "Prompt" })
  })

  test("detects mid-line mention after space", () => {
    expect(activeMention("see @PromptIn", 13)).toEqual({ start: 4, query: "PromptIn" })
  })

  test("cursor mid-query returns partial", () => {
    // "see @PromptInput" cursor after "Prom"
    const v = "see @PromptInput"
    expect(activeMention(v, 9)).toEqual({ start: 4, query: "Prom" })
  })

  test("no mention without @", () => {
    expect(activeMention("hello", 5)).toBeNull()
  })

  test("email-like token is not a mention", () => {
    expect(activeMention("a@b.com", 7)).toBeNull()
  })

  test("closed mention (space after) is inactive", () => {
    expect(activeMention("@foo bar", 8)).toBeNull()
  })

  test("cursor before @ is inactive", () => {
    expect(activeMention("@foo", 0)).toBeNull()
  })
})
