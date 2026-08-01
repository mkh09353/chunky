import { expect, test } from "bun:test"
import { z } from "zod"
import { rateDelegateInputShape } from "./rate-delegate.ts"

test("rate_delegate schema accepts an optional diagnosis", () => {
  const schema = z.object(rateDelegateInputShape)
  expect(schema.safeParse({
    delegation: "last",
    compliance: 1,
    correctness: 1,
    report: 1,
    rework: true,
    reason: "The implementation needed a follow-up.",
    diagnosis: "It ignored the error-path constraint; put that requirement and its test in the brief.",
  }).success).toBe(true)
})
