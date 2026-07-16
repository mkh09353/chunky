import { describe, expect, test } from "bun:test"
import { savedModeForCommand, type Command } from "./SlashMenu.js"

// Saved modes double as slash commands. The bug this guards: a saved mode
// selected from the popup reaches App.onCommand (not submit()), and onCommand's
// switch only knew the built-ins — so a menu-selected saved mode silently did
// nothing. Both entry points now resolve through savedModeForCommand.
const slashModes: Command[] = [
  { name: "/fire", description: "Apply mode: Grok 4.5" },
  { name: "/Deep", description: "Apply mode: Claude Opus 4" },
]

describe("savedModeForCommand", () => {
  test("resolves a saved mode to the bare name the /mode apply flow expects", () => {
    // This is exactly what onCommand passes to doMode when the popup fires
    // `/fire`: without the fix the menu path returned nothing.
    expect(savedModeForCommand("/fire", slashModes)).toBe("fire")
  })

  test("matching is case-insensitive and yields the mode's canonical name", () => {
    expect(savedModeForCommand("/FIRE", slashModes)).toBe("fire")
    expect(savedModeForCommand("/deep", slashModes)).toBe("Deep")
  })

  test("never shadows a built-in command", () => {
    expect(savedModeForCommand("/mode", slashModes)).toBeNull()
    expect(savedModeForCommand("/model", slashModes)).toBeNull()
    expect(savedModeForCommand("/help", slashModes)).toBeNull()
  })

  test("unknown commands resolve to null (no accidental dispatch)", () => {
    expect(savedModeForCommand("/nope", slashModes)).toBeNull()
    expect(savedModeForCommand("/fire", [])).toBeNull()
  })
})
