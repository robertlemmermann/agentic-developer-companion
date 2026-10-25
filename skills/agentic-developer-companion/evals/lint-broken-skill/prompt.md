---
name: lint-broken-skill
description: The skill reviews a broken SKILL.md against the real host rules and names each defect.
tags:
  - outcome
  - tooling-lint
runs: 3
max_turns: 10
timeout_seconds: 300
allowed_tools:
  - Read
  - Glob
  - Grep
  - Skill
expected_outcome: The answer says the file is not portable and names the invalid name, the unquoted colon, the non-spec fields and the Claude-only substitutions.
---

I wrote this skill for my team. It lives at `.github/skills/release-notes/SKILL.md` and has
to load in Copilot CLI, Claude Code and Codex. Is it valid everywhere? List every problem
with the host rule it breaks and the fix. Do not rewrite the body.

```markdown
---
name: Release_Notes
description: Use when: drafting release notes from merged pull requests
argument-hint: "[version]"
allowed-tools: [Bash]
---

Run !`git log --oneline -20` and summarize the changes for version $ARGUMENTS.
```
