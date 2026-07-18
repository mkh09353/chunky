import { expect, test } from "bun:test"
import { parseForkArgs } from "./ForkPicker.js"

test("bare /fork leaves both fields unset, which opens the picker", () => {
  expect(parseForkArgs("")).toEqual({})
  expect(parseForkArgs("   ")).toEqual({})
})

test("a directive with no flag still opens the picker, directive preserved", () => {
  expect(parseForkArgs("try the redis cache")).toEqual({ directive: "try the redis cache" })
})

test("--worktree / --no-worktree are recognized and stripped from the directive", () => {
  expect(parseForkArgs("--worktree")).toEqual({ worktree: true })
  expect(parseForkArgs("--no-worktree")).toEqual({ worktree: false })
  expect(parseForkArgs("--worktree try redis")).toEqual({ worktree: true, directive: "try redis" })
})

test("flags are honored ANYWHERE in the args, not just leading", () => {
  expect(parseForkArgs("try redis --worktree")).toEqual({ worktree: true, directive: "try redis" })
  expect(parseForkArgs("try --no-worktree redis now")).toEqual({ worktree: false, directive: "try redis now" })
})

test("the last flag wins and matching is case-insensitive", () => {
  expect(parseForkArgs("--worktree --no-worktree go")).toEqual({ worktree: false, directive: "go" })
  expect(parseForkArgs("--WorkTree go")).toEqual({ worktree: true, directive: "go" })
})
