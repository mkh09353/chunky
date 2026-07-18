import { expect, test } from "bun:test"
import type { RewindPoint } from "@chunky/protocol"
import { moveSelection, rewindRowLabel, selectableIndexes, truncateText, REWIND_TEXT_WIDTH } from "./RewindPicker.js"

const point = (turn: number, over: Partial<RewindPoint> = {}): RewindPoint => ({
  turn,
  createdAt: 0,
  userText: `turn ${turn}`,
  complete: true,
  ...over,
})

test("row text collapses whitespace and ellipsizes at the column width", () => {
  expect(truncateText("  add   a\nfeature ")).toBe("add a feature")
  const long = "x".repeat(200)
  const cut = truncateText(long)
  expect(cut).toHaveLength(REWIND_TEXT_WIDTH)
  expect(cut.endsWith("…")).toBe(true)
})

test("row label is #turn, relative time, then the truncated user text", () => {
  const now = 1_000_000_000_000
  expect(rewindRowLabel(point(7, { createdAt: now - 5 * 60_000, userText: "fix the bug" }), now)).toBe(
    "#7  5m ago  fix the bug",
  )
})

test("incomplete points are not selectable", () => {
  const points = [point(3), point(2, { complete: false }), point(1)]
  expect(selectableIndexes(points)).toEqual([0, 2])
})

test("navigation skips incomplete points and wraps at both ends", () => {
  const points = [point(3), point(2, { complete: false }), point(1)]
  expect(moveSelection(points, 0, 1)).toBe(2) // hops over the incomplete row
  expect(moveSelection(points, 2, 1)).toBe(0) // wraps to the top
  expect(moveSelection(points, 0, -1)).toBe(2) // wraps to the bottom
})

test("navigation is a no-op when nothing is selectable", () => {
  const points = [point(2, { complete: false }), point(1, { complete: false })]
  expect(moveSelection(points, 0, 1)).toBe(0)
})
