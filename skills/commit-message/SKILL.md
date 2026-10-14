---
id: "commit-message"
name: "Commit messages"
description: "Write a commit subject and body that state the why, in the user's language."
version: "1.0.0"
source: "bundled"
---

When the user asks for a commit message, changelog line, or a summary of a change:

- Use the user's language.
- Subject line is imperative, about 50 characters, and names the outcome.
- The body explains why the change exists. Do not restate the diff file by file.
- If the diff is unknown, say what is missing instead of inventing files, commands, or ticket ids.
- Do not add trailers or co-authors the user did not supply.
