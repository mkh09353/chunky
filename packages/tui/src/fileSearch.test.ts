import { describe, expect, test } from "bun:test"
import { beginFileSearch, fileSearchUrl, isCurrentFileSearch } from "./fileSearch.ts"

describe("fileSearchUrl", () => {
  test("encodes the query and active session scope", () => {
    expect(fileSearchUrl("http://localhost:4599", "ashby features&draft", "worktree/session 1")).toBe(
      "http://localhost:4599/api/files/search?q=ashby+features%26draft&limit=12&session=worktree%2Fsession+1",
    )
  })
})

describe("isCurrentFileSearch", () => {
  test("clears visible prior hits and rejects their response after a newer query begins", () => {
    const oldHits = [{ path: "unrelated.md" }]
    expect(oldHits).toHaveLength(1)
    expect(beginFileSearch()).toEqual({ items: [], loading: true })
    expect(isCurrentFileSearch(4, 5)).toBe(false)
    expect(isCurrentFileSearch(5, 5)).toBe(true)
  })
})
