---
id: "review-notes"
name: "Review notes"
description: "Review code as a short list of findings ordered by severity."
version: "1.0.0"
source: "bundled"
---

When the user asks for a code review, an audit, or what is wrong with a change:

- Lead with findings, highest severity first. Each finding is one short paragraph: what is wrong, where, and what to change.
- Severity is only "blocker", "should fix", or "note".
- If nothing important is wrong, say so in one sentence and mention residual risk.
- Do not praise the change, restate the diff, or propose a rewrite that the findings do not require.
