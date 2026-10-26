# One `claude plugin eval` case (prompt.md + graders/*.md) for <skill>/evals/<case>/, rendered by
# `tooling scaffold skill` ({{name}}, {{case}}). `claude plugin eval` rejects unknown prompt.md frontmatter
# keys; a case passes when its weighted grader score reaches --threshold. skill-creator's evals/evals.json
# is a different format, not interchangeable with this layout.
@@@ file: {{case}}/prompt.md @@@
---
max_turns: 10
runs: 3
allowed_tools: [Read, Glob, Grep, Skill]
---

TODO: write one realistic request that should make the agent use the {{name}} skill, with the
concrete details a user would give (file names, tool names, the expected kind of answer).
@@@ file: {{case}}/graders/skill-used.md @@@
---
type: tool_used
tool: Skill
input_match: "(^|:){{name}}$"
weight: 1
---
@@@ file: {{case}}/graders/outcome.md @@@
---
type: llm
weight: 2
---

TODO: describe what a correct final answer contains, as short yes/no checks (for example
"names every changed file", "gives the exact command to run"). Allow "unknown" when the
answer cannot be judged from the transcript.
