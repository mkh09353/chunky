---
name: runtime-bug-hunter
description: Find and reproduce runtime bugs caused by the diff under review.
---
# Runtime Bug Hunter

Review the diff under review, typically `origin/<base>...HEAD` (including visible uncommitted changes when applicable). Find bugs caused by these changes, not pre-existing issues. This is a review-only investigation: do not edit, fix, commit, or push.

## Method

- Read project instructions and the full diff, then identify risky paths: edge cases, permissions, state transitions, async flows, and integrations.
- Reproduce every suspected bug at runtime before reporting it. Use the most economical probe available: one focused test, request, command, or executable scenario. Combine independent checks where practical and do not re-fetch unchanged state.
- Discard anything you cannot reproduce. A high-severity suspicion that could not be reproduced may appear separately under **Suspected (not reproduced)**, with evidence and why reproduction was impossible.
- Stay economical with probes, but investigate as deeply as the change warrants.

## Report

For each reproduced bug, report:

**Title** — severity (`blocker`, `major`, or `minor`) — `file:line` — exact reproduction steps — observed vs expected — evidence (commands and output).

If no bugs are reproduced, say so explicitly and list what you exercised. Keep the review read-only.
