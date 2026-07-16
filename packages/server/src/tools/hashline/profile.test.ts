import { afterEach, expect, test } from "bun:test"
import { anthropicFileTools } from "../../anthropic-runner.ts"
import { executorToolsFor, sidekickFileToolsFor } from "../../agent.ts"
import { editTool } from "../edit.ts"
import { read } from "../read.ts"
import { hashlineEdit, hashlineRead } from "./index.ts"
import { hashlineEditInputShape } from "./types.ts"
import { editInputShape } from "../edit.ts"

const previousProfile = process.env.CHUNKY_FILE_TOOL_PROFILE

afterEach(() => {
  if (previousProfile === undefined) delete process.env.CHUNKY_FILE_TOOL_PROFILE
  else process.env.CHUNKY_FILE_TOOL_PROFILE = previousProfile
})

test("CHUNKY_FILE_TOOL_PROFILE flips the executor file tool set", () => {
  const selection = { provider: "zen", model: "glm-5.2" }

  process.env.CHUNKY_FILE_TOOL_PROFILE = "standard"
  const standard = executorToolsFor(selection).tools
  expect(standard).toContain(read)
  expect(standard.some((tool) => tool.description === editTool.description)).toBe(true)
  expect(standard).not.toContain(hashlineRead)

  process.env.CHUNKY_FILE_TOOL_PROFILE = "hashline"
  const hashline = executorToolsFor(selection).tools
  expect(hashline).toContain(hashlineRead)
  expect(hashline.some((tool) => tool.description === hashlineEdit.description)).toBe(true)
  expect(hashline).not.toContain(read)
})

test("Anthropic file tools honor the selected profile", () => {
  expect(anthropicFileTools("standard")).toEqual({ read, edit: editTool, editInputShape })
  expect(anthropicFileTools("hashline")).toEqual({ read: hashlineRead, edit: hashlineEdit, editInputShape: hashlineEditInputShape })
})

test("hashline sidekicks keep the GPT/Codex apply_patch exception", () => {
  process.env.CHUNKY_FILE_TOOL_PROFILE = "hashline"
  expect(sidekickFileToolsFor("gpt-5.2", "openai").map((tool) => tool.name)).toEqual(["read", "apply_patch"])
  expect(sidekickFileToolsFor("claude-sonnet", "codex").map((tool) => tool.name)).toEqual(["read", "apply_patch"])
  expect(sidekickFileToolsFor("claude-sonnet", "anthropic").map((tool) => tool.name)).toEqual(["read", "edit"])
})
