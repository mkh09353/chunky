import { expect, test } from "bun:test"
import { decodePaste } from "./useInput.js"

// OpenTUI delivers pastes on a separate channel as a PasteEvent whose payload is
// a Uint8Array; decodePaste is what turns that back into the text we insert.

test("decodes UTF-8 bytes from a PasteEvent", () => {
  const bytes = new TextEncoder().encode("hello\r\nworld — café 🐴")
  expect(decodePaste({ bytes })).toBe("hello\r\nworld — café 🐴")
})

test("prefers a string `text` field when present (forward-compat)", () => {
  const bytes = new TextEncoder().encode("from-bytes")
  expect(decodePaste({ text: "from-text", bytes })).toBe("from-text")
})

test("empty paste decodes to empty string", () => {
  expect(decodePaste({ bytes: new Uint8Array() })).toBe("")
})
