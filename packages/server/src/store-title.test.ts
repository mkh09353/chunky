import { expect, test } from "bun:test"
import { Store } from "./store.ts"

function id(prefix: string): string {
  const value = `${prefix}-${crypto.randomUUID()}`
  Store.createSession(value)
  return value
}

test("setTitleIfDefault only applies to the default title", () => {
  const first = id("default")
  Store.setTitleIfDefault(first, "First message")
  expect(Store.titleOf(first)).toBe("First message")
  Store.setTitleIfDefault(first, "Second message")
  expect(Store.titleOf(first)).toBe("First message")
})

test("manual titles are custom while auto titles are not", () => {
  const manual = id("manual")
  Store.setTitle(manual, "Manual title")
  expect(Store.canAutoTitle(manual)).toBe(false)

  const automatic = id("automatic")
  expect(Store.setAutoTitle(automatic, "Generated title")).toBe(true)
  expect(Store.titleOf(automatic)).toBe("Generated title")
  expect(Store.canAutoTitle(automatic)).toBe(true)
})
