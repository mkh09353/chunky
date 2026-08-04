---
name: chunky-code-review
description: Perform Chunky's independent high-conviction full review of a pull-request diff.
---
# Chunky Code Review

Perform an independent, full review of the diff under review (typically `origin/<base>...HEAD`). This is strictly review-only: do not edit files, apply fixes, commit, or push.

Review for correctness, API and protocol contracts, error handling, concurrency and race conditions, security, regressions, and test coverage. Follow data and control flow into surrounding code where needed. Prefer high-conviction, actionable findings supported by concrete evidence; do not report style nits unless they conceal a bug.

Report findings ordered by severity. Every finding must include a severity, precise `file:line`, what breaks, concrete evidence, impact, and a suggested fix (description only). State what was covered and any limitations. End with an explicit verdict: **APPROVE**, **DO NOT APPROVE**, or **APPROVE WITH NITS**, and list any presumptive blockers. If there are no actionable findings, say so clearly. Preserve review-only behavior throughout.
