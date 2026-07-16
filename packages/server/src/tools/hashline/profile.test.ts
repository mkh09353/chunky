import { afterEach, expect, test } from "bun:test"
import { anthropicFileTools } from "../../anthropic-runner.ts"
import { executorToolsFor } from "../../agent.ts"
import { editTool } from "../edit.ts"
import { read } from "../read.ts"
import { hashlineEdit, hashlineRead } from "./index.ts"

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
  expect(anthropicFileTools("standard")).toEqual({ read, edit: editTool })
  expect(anthropicFileTools("hashline")).toEqual({ read: hashlineRead, edit: hashlineEdit })
})
