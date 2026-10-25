---
type: llm
weight: 1
---

Judge only the final answer. Pass when all of these hold:

1. It says the file is not valid or not portable as written (it does not call it valid).
2. It flags the name `Release_Notes`: lowercase letters, digits and hyphens only, and the
   name must equal the directory name `release-notes`.
3. It flags the unquoted `: ` inside the description (YAML parse error or auto-repair;
   the fix is quoting the value or removing the colon).
4. It flags `argument-hint` or `allowed-tools` (or both) as fields outside the six-field
   Agent Skills spec that some hosts ignore or the spec validator rejects.
5. It flags `` !`git log ...` `` or `$ARGUMENTS` (or both) as Claude Code-only substitutions
   that Copilot and Codex pass through as literal text.

Fail when the answer calls the file valid, invents a rule that does not exist, or misses
two or more of items 2 to 5. Answer "unknown" only when the transcript has no final answer.
