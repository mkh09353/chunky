import { expect, test } from "bun:test"
import { buildSystemPrompt, sidekickSystemPrompt } from "./prompt.ts"

test("lead prompt carries persistent-notes guidance", () => {
  const prompt = buildSystemPrompt("edit", false, "/tmp/workspace")
  expect(prompt).toContain("- Persistent notes:")
  expect(prompt).toContain("<context_window_reminder>")
  expect(prompt).toContain("compact_context")
  expect(prompt).toContain("window=-2")
  expect(prompt).not.toContain("recall (discover via tool search)")
})

test("lead prompt with deferred tool search points recall at tool search", () => {
  const prompt = buildSystemPrompt("edit", false, "/tmp/workspace", { portableToolSearch: true })
  expect(prompt).toContain("- Persistent notes:")
  expect(prompt).toContain("recall (discover via tool search)")
})

test("sidekick prompt carries persistent-notes guidance", () => {
  const prompt = sidekickSystemPrompt(null)
  expect(prompt).toContain("Persistent notes:")
  expect(prompt).toContain("<context_window_reminder>")
  expect(prompt).toContain("get_context_remaining")
})
