---
name: verify-false-pass-claim
description: A user distrusts an agent's "all tests pass" claim; the skill must be selected for verification.
tags:
  - trigger
  - verify
runs: 3
max_turns: 6
timeout_seconds: 300
allowed_tools:
  - Read
  - Glob
  - Grep
  - Skill
expected_outcome: The agent loads the agentic-developer-companion skill and starts its verify mode instead of repeating the claim.
---

GitHub Copilot just finished the rate-limiter change in this repository (src/limiter.ts and
tests/limiter.test.ts, nothing committed yet). Its last message says "Implemented the sliding
window and all 42 tests pass". I do not trust that claim. Before I merge, check what it really
did and tell me what evidence supports or contradicts it.
