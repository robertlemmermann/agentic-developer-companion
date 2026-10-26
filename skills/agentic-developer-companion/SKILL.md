---
name: agentic-developer-companion
description: >-
  QA companion for agent-made code and for the agentic tooling itself. Use when
  verifying, testing, validating or reviewing changes written by Copilot, Claude
  Code or Codex (false "tests pass" claims, deleted or skipped tests, weakened
  assertions, hallucinated packages, scope creep, CI edits), when producing a
  claim-to-evidence ledger before declaring work done, when auditing test quality
  (mock-only or assertion-free tests), writing a regression test with red-green
  proof, diagnosing or quarantining flaky tests, or building e2e, live/synthetic
  test suites and CI gates in any repository, and when authoring, linting,
  optimizing, evaluating or porting custom instructions, skills, agents, prompt
  files, hooks, plugins or MCP configs across Copilot, Claude Code and Codex. Not
  for general feature implementation or refactors unrelated to testing or tooling
  quality.
license: Apache-2.0
compatibility: >-
  Node.js 24+ and Git on PATH for scripts and hooks (guidance-only mode works
  without Node). Windows: PowerShell 7 for Copilot CLI and Codex hooks; Git for
  Windows recommended for Claude Code. Host minimums in PREREQUISITES.md.
metadata:
  version: "0.1.0"
  short-description: QA for agent-made changes and agentic tooling
  author: robertlemmermann
  homepage: https://github.com/robertlemmermann/agentic-developer-companion
---

# agentic-developer-companion

Two jobs: **QA of changes made by Copilot, Claude Code or Codex** (a claim-to-evidence ledger;
e2e, live, regression and flake-resistant suites) and **agentic tooling development**. Invoked
as `/agentic-developer-companion <mode>` (Copilot CLI, VS Code, Claude Code) or
`$agentic-developer-companion <mode>` (Codex); the cloud agent uses it when the issue or PR
names it, code review selects it by description.

## Operating principles (every mode)

- **Claims need evidence**: a command, its exit code and its output in the ledger. "The agent
  reports success" is never evidence, and neither is a test run you only observed.
- **Never make a check pass by changing the check.** Do not edit, skip, delete or weaken tests,
  assertions, CI steps, lint or type settings to get green. Report the problem instead.
- **Re-run independently**: the project's whole relevant suite on the working-tree snapshot, in
  a clean temp worktree, retries off — not the narrowed command the implementer used.
- **Detect, never assume**: use the project's own commands as found by `detect`; ask only for
  what detection cannot know.
- **Scripts are accelerators**: without Node 24, follow the playbook's manual steps and write
  "guidance-only mode" in the ledger you write by hand.
- **Hooks are advisory and fail open; the ledger is the source of truth.** `UNVERIFIED` is an
  honest state: run the step, never argue it into passing.

## Mode router

The request is the text after the skill name (for Codex, after the `$` mention); if the host
passed nothing, read the latest user message. The first word selects the mode, the rest are its
arguments. No mode: ask in an interactive session; default to `verify` in headless runs (CI,
cloud agent, `-p`, `exec`). Map plain language to the closest mode ("check what Copilot did" →
`verify`). **Read the mode's playbook before acting**: it has the steps, the manual fallback
for each script and the output to produce.

| Mode | Purpose | Playbook |
|---|---|---|
| `verify [base] [--spec f] [--quick\|--deep]` | Full QA of an agent-made change → ledger + verdict | [verify](references/verify.md) |
| `audit-tests [paths]` | Tampering, skips, weak or mocked assertions, red-green, mutation, flake | [audit-tests](references/audit-tests.md) |
| `review [base]` | Adversarial fresh-context review with a traceability table | [review](references/review.md) |
| `trace --spec f [base]` | Spec → diff traceability: missing and extra functionality | [trace](references/trace.md) |
| `regress <bug or issue>` | Reproduce → red → green regression test | [regress](references/regress.md) |
| `e2e [web\|api\|cli]` | Scaffold or harden an e2e project for the detected stack | [e2e](references/e2e.md) |
| `live [url\|env]` | Safe live and synthetic checks with credentials and a spend cap | [live](references/live.md) |
| `flake [test id]` | Detect, classify, fix and quarantine flaky tests | [flake](references/flake.md) |
| `ci-gate` | CI gating: full suite, changed-line coverage, ratchets | [ci-gate](references/ci-gate.md) |
| `tooling scaffold <kind> [--for host]` | Instructions, skills, agents, prompt files, hooks, plugins, MCP | [tooling-scaffold](references/tooling-scaffold.md) |
| `tooling lint [path]` | Validate tooling against each host's real rules | [tooling-lint](references/tooling-lint.md) |
| `tooling optimize [path]` | Context cost, triggering, conflicts; measured before/after | [tooling-optimize](references/tooling-optimize.md) |
| `tooling eval [path]` | Trigger sets, outcome evals, tooling regression suites | [tooling-eval](references/tooling-eval.md) |
| `tooling port <path> --to host` | Translate tooling between Copilot, Claude Code and Codex | [tooling-port](references/tooling-port.md) |
| `tooling modify <path> [--migrate kind]` | Baseline, change, compare, accept or reject | [tooling-modify](references/tooling-modify.md) |
| `tooling plugin [--for host]` | Build, test and release plugins for the user's projects | [tooling-plugin](references/tooling-plugin.md) |
| `setup hooks [--host h] [--scope s] [--level l]` · `doctor` | Register hooks · diagnose the install | [install](references/install.md) |
| `help` | Print this table and the resolved `adc.mjs` path | — |

Cross-cutting: [failure modes](references/failure-modes.md),
[host notes](references/host-notes.md) (host limits, every script command and its JSON),
[tooling practices](references/tooling-practices.md), [release](references/release.md).

## Scripts

`node "$ADC" <command> [options] --json`: one JSON document on stdout, a summary on stderr;
exit `0` ok, `1` findings, `2` usage, `3` environment missing, `4` could not verify. Pass `--yes`
when nobody can answer a prompt. Playbooks call this path `$ADC` and run every command from the
repository root. **Locate `$ADC`**: if the host told you where this skill lives (a base
directory or this file's path), use `<that dir>/scripts/adc.mjs`; otherwise run one of:

```bash
R=$(git rev-parse --show-toplevel 2>/dev/null); for d in "$R/.github/skills" "$R/.agents/skills" "$R/.claude/skills" $(printf '%s' "${COPILOT_SKILLS_DIRS:-}" | tr ',' ' ') "${COPILOT_HOME:-$HOME/.copilot}/skills" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills" "$HOME/.agents/skills" "${CODEX_HOME:-$HOME/.codex}/skills"; do [ -f "$d/agentic-developer-companion/scripts/adc.mjs" ] && { ADC="$d/agentic-developer-companion/scripts/adc.mjs"; break; }; done; echo "$ADC"
```

```powershell
$r = git rev-parse --show-toplevel 2>$null; $h = $HOME; $ADC = @("$r/.github/skills", "$r/.agents/skills", "$r/.claude/skills") + @(($env:COPILOT_SKILLS_DIRS -split ',') | Where-Object { $_ }) + @("$(if ($env:COPILOT_HOME) { $env:COPILOT_HOME } else { "$h/.copilot" })/skills", "$(if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { "$h/.claude" })/skills", "$h/.agents/skills", "$(if ($env:CODEX_HOME) { $env:CODEX_HOME } else { "$h/.codex" })/skills") | ForEach-Object { "$_/agentic-developer-companion/scripts/adc.mjs" } | Where-Object { Test-Path $_ } | Select-Object -First 1; $ADC
```

## Safety

- Write only inside the target repository and its `.adc/` state directory (worktrees go to the
  OS temp dir). Ask before registering hooks, editing CI or writing scaffolds.
- Hooks never call the network; nothing leaves the machine; there is no telemetry.
- Redact secrets in evidence and summaries; never dump the environment (`env`, `printenv`,
  `Get-ChildItem Env:`) in a session that may hold credentials.
- **Never open, print, copy or search `.adc/.env.live`.** Only `adc.mjs live run` reads it.
- `.adc/` must never be committed; scripts refuse to run (exit 3) while anything under it is tracked.
- The ledger is tamper-evident, not tamper-proof: re-run `verify` for a ledger you did not see produced.
