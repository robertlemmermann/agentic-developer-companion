---
name: agentic-developer-companion
description: >-
  QA companion for agent-made code and for the agentic tooling itself. Use when
  verifying, testing, validating or reviewing changes written by Copilot, Claude
  Code or Codex (false "tests pass" claims, deleted or skipped tests, weakened
  assertions, hallucinated packages, scope creep, CI edits), when producing a
  claim-to-evidence ledger before declaring work done, when creating or hardening
  e2e, live/synthetic, regression or flake-resistant test suites and CI gates in
  any repository, and when authoring, linting, optimizing, evaluating or porting
  custom instructions, skills, agents, prompt files, hooks, plugins or MCP configs
  across Copilot, Claude Code and Codex. Not for general feature implementation
  or refactors unrelated to testing or tooling quality.
license: Apache-2.0
compatibility: >-
  Node.js 24+ and Git on PATH for scripts and hooks (guidance-only mode works
  without Node). Windows: PowerShell 7 for Copilot CLI and Codex hooks; Git for
  Windows recommended for Claude Code. Host minimums in README.
metadata:
  version: "0.1.0"
  short-description: QA for agent-made changes and agentic tooling
  author: robertlemmermann
  homepage: https://github.com/robertlemmermann/agentic-developer-companion
---

# agentic-developer-companion

This skill does two jobs:

1. **QA of agent-made changes**: verify, test and review work done by GitHub Copilot,
   Claude Code or OpenAI Codex and record a claim-to-evidence ledger instead of trusting
   "all tests pass"; build reliable e2e, live, regression and flake-resistant test suites.
2. **Agentic tooling development**: scaffold, lint, measure, evaluate, port and safely
   change instructions, skills, agents, prompt files, hooks, plugins and MCP configs.

| Host | How the user invokes it |
|---|---|
| Copilot CLI, VS Code, Claude Code | `/agentic-developer-companion <mode> ...` |
| Codex | `$agentic-developer-companion <mode> ...` |
| Copilot cloud agent and code review | automatic; the issue or PR names the skill and the mode |

## Operating principles (apply in every mode)

- **Claims need evidence.** A claim is unverified until a command, its exit code and its
  output are in the evidence ledger. "The agent reports success" is never evidence, and
  neither is a test run you only observed.
- **Never make a check pass by changing the check.** Do not edit, skip, delete or weaken
  tests, assertions, CI steps, lint or type settings to get green. Report the problem.
- **Re-run independently.** Run the project's *whole* relevant suite on the working-tree
  snapshot in a clean temp worktree with retries off, not the narrowed command the
  implementer used.
- **Detect, never assume.** Use the project's own tools, commands and conventions as found
  by `detect`; ask for what detection cannot know.
- **Scripts are accelerators.** If `node` (24+) is missing, do the same steps by hand from
  the referenced playbook and write "guidance-only mode" in the ledger you write yourself.
- **Hooks are advisory and fail open.** The ledger is the source of truth.
- **`UNVERIFIED` is honest.** Never argue a step into passing; run it or say it did not run.

## Mode router

The user's request is the text after the skill name (for Codex, after the
`$agentic-developer-companion` mention). If a host passed nothing, read the latest user
message. The first word selects the mode; the remaining words are its arguments (base
ref, paths, spec file, host). With no mode: in an interactive session ask which mode; in a
headless run (CI, cloud agent, `-p`/`exec`) default to `verify`. Natural-language
requests map to the closest mode ("check what Copilot just did" → `verify`).

## Modes

| Mode | Purpose | Playbook |
|---|---|---|
| `verify [base] [--spec file] [--quick\|--deep]` | Full QA of an agent-made change → evidence ledger + verdict | [verify](references/verify.md) |
| `audit-tests [paths]` | Test quality: tampering, skips, weak or mocked assertions, red-green, mutation, flake | [audit-tests](references/audit-tests.md) |
| `review [base]` | Adversarial fresh-context second review with a traceability table | [review](references/review.md) |
| `trace --spec file [base]` | Spec → diff traceability (missing and extra functionality) | [trace](references/trace.md) |
| `regress <bug or issue>` | Bug → reproduced → red → green regression test | [regress](references/regress.md) |
| `e2e [web\|api\|cli]` | Scaffold or harden an e2e project for the detected stack | [e2e](references/e2e.md) |
| `live [url\|env]` | Safe live and synthetic checks with credentials and a spend cap | [live](references/live.md) |
| `flake [test id]` | Detect, classify, fix and quarantine flaky tests | [flake](references/flake.md) |
| `ci-gate` | CI gating for the target repo (full suite, changed-line coverage, ratchets) | [ci-gate](references/ci-gate.md) |
| `tooling scaffold <kind> [--for host]` | Create instructions, skills, agents, prompt files, hooks, plugins, MCP configs | [tooling-scaffold](references/tooling-scaffold.md) |
| `tooling lint [path]` | Validate tooling against each host's real rules | [tooling-lint](references/tooling-lint.md) |
| `tooling optimize [path]` | Context cost, triggering, conflicts, portability, measured before/after | [tooling-optimize](references/tooling-optimize.md) |
| `tooling eval [path]` | Trigger sets, outcome evals and tooling regression suites | [tooling-eval](references/tooling-eval.md) |
| `tooling port <path> --to host` | Translate tooling between Copilot, Claude Code and Codex | [tooling-port](references/tooling-port.md) |
| `tooling modify <path> [--migrate kind]` | Change tooling safely: baseline, change, compare, accept or reject | [tooling-modify](references/tooling-modify.md) |
| `tooling plugin [--for host]` | Build, test and release plugins for the user's own projects | [tooling-plugin](references/tooling-plugin.md) |
| `setup hooks [--host ...] [--scope user\|project] [--level ...]` | Render and register this skill's hooks | [install](references/install.md) |
| `doctor` | Environment and installation diagnostics | [install](references/install.md) |
| `help` | Print this mode table and the resolved script path | — |

Read the playbook for the selected mode before acting; it lists the exact steps, the
manual fallback for each script and the output to produce. Cross-cutting references:
[failure modes](references/failure-modes.md), [host notes](references/host-notes.md),
[tooling practices](references/tooling-practices.md), [release](references/release.md).

**verify** (the flagship): resolve the base, snapshot the working tree (uncommitted and
untracked files included), run diff-scoped tamper checks, dependency and type checks, an
independent clean run with retries off, coverage of changed lines, optionally mutation and
flake probes, then traceability against the spec, an adversarial review in a fresh
context, and the claims → evidence mapping. Verdict: `PASS`, `PASS-WITH-FINDINGS`, `FAIL`
or `UNVERIFIED`. Post a short summary: table of checks, verdict, commands to reproduce.

**audit-tests / review / trace**: question-by-question answers with `file:line` citations;
scores are computed by the scripts from those answers, never estimated.

**regress / e2e / live / flake / ci-gate**: start with `detect`, ask only for what detection
cannot know, show the file list first (`--dry-run`), write after confirmation (`--write`).
`live` refuses write-capable probes until the live safety checklist is answered.

**tooling ...**: treat instructions, skills, agents, hooks, plugins and MCP configs as
software: known-good templates, host-rule linting, measured context cost and triggering,
headless evals, and a baseline/compare loop for every change.

**help**: print the mode table above and the resolved `adc.mjs` path (see below).

## Scripts

Every script is `node "<skill-dir>/scripts/adc.mjs" <command> [options] --json`. Output is
one JSON document on stdout, a one-line summary on stderr. Exit codes: `0` ok, `1` findings,
`2` usage, `3` environment missing (Git, Node 24, runner, tracked `.adc/`), `4` could not
verify.

**Locate the companion.** If the host told you where this skill lives (a "base directory"
line, or the path of this `SKILL.md`), use `<that dir>/scripts/adc.mjs`. Otherwise search, in
order, `.github/skills`, `.agents/skills`, `.claude/skills` under the repository root, then
`COPILOT_SKILLS_DIRS`, `~/.copilot/skills` (`COPILOT_HOME`), `~/.claude/skills`
(`CLAUDE_CONFIG_DIR`), `~/.agents/skills`, `~/.codex/skills` (`CODEX_HOME`) for
`agentic-developer-companion/scripts/adc.mjs`:

```bash
R=$(git rev-parse --show-toplevel 2>/dev/null); for d in "$R/.github/skills" "$R/.agents/skills" "$R/.claude/skills" $(printf '%s' "${COPILOT_SKILLS_DIRS:-}" | tr ',' ' ') "${COPILOT_HOME:-$HOME/.copilot}/skills" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills" "$HOME/.agents/skills" "${CODEX_HOME:-$HOME/.codex}/skills"; do [ -f "$d/agentic-developer-companion/scripts/adc.mjs" ] && { ADC="$d/agentic-developer-companion/scripts/adc.mjs"; break; }; done; echo "$ADC"
```

```powershell
$r = git rev-parse --show-toplevel 2>$null; $h = $HOME; $ADC = @("$r/.github/skills", "$r/.agents/skills", "$r/.claude/skills") + @(($env:COPILOT_SKILLS_DIRS -split ',') | Where-Object { $_ }) + @("$(if ($env:COPILOT_HOME) { $env:COPILOT_HOME } else { "$h/.copilot" })/skills", "$(if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { "$h/.claude" })/skills", "$h/.agents/skills", "$(if ($env:CODEX_HOME) { $env:CODEX_HOME } else { "$h/.codex" })/skills") | ForEach-Object { "$_/agentic-developer-companion/scripts/adc.mjs" } | Where-Object { Test-Path $_ } | Select-Object -First 1; $ADC
```

`node "$ADC" doctor` prints the resolved path, versions and every installed copy.

| Command | Purpose | Output (JSON) |
|---|---|---|
| `verify [--base r] [--spec f] [--claims f] [--quick\|--deep]` | Runs every scripted verify step and writes the ledger | `{ ledger, verdict, checks[], next_steps[] }` |
| `detect [--refresh]` | Projects, managers, runners, report flags, CI, default branch | `{ projects[], ci, lint[], typecheck[], default_branch, base_source }` |
| `diff-scope [--base r] [--spec f] [--allow glob]` | CK-SCOPE, TEST-DEL, SKIP, ASSERT, TEST-CFG, SUPPRESS, CI, SWALLOW, SECRETS, LOCK | `{ base, tree_digest, files[], findings[], counts }` |
| `deps-check [--offline]` | New dependencies exist; look-alikes; lockfile consistency | `{ new_deps[], lock_status }` |
| `typecheck` | New compile/type errors vs the base | `{ cmd, base, head, new_errors[], status }` |
| `clean-run [--no-install] [--runner r] [--red-green files]` | Full suite of the snapshot in a temp worktree, retries off, counts vs base | `{ tree_digest, projects[], status }` |
| `coverage-delta` · `mutation-scope` · `flake-probe` | Changed-line coverage · mutation on changed files · repeat/shuffle runs | `{ pct, uncovered[] }` · `{ score, survivors[] }` · `{ failures[], suspect_tests[] }` |
| `evidence init\|add\|claims\|waive\|finalize\|render\|status` | The ledger; claim status is derived, never accepted | ledger (`references/verify.md`) |
| `trace --spec f` | Requirement candidates and unmapped hunks | `{ requirements[], extras[] }` |
| `scaffold <kind> [--write]` | Test-engineering and tooling scaffolds from templates | `{ written[], next_steps[] }` |
| `live run` · `budget show` | Live probes under the 2,500-credit budget ledger | `{ probes[], spent, remaining, stopped_reason }` |
| `tooling lint\|cost\|port\|trigger-set\|modify\|plugin` | Tooling development | per command (`references/tooling-*.md`) |
| `hooks render --host h [--write]` · `hook-run <event>` | Render or run hooks | `{ target_file, config, next_steps[] }` |
| `doctor [--init]` · `selftest` | Diagnostics · the skill's own tests | `{ node, git, hosts[], hooks[], warnings[] }` |

## Host notes

| Host | Arguments | Hooks | Limits |
|---|---|---|---|
| Copilot CLI / VS Code | text after `/agentic-developer-companion` | `~/.copilot/hooks/` or `.github/hooks/` (VS Code: Session Target = Copilot) | VS Code ignores `allowed-tools`; restart the CLI after registering hooks |
| Copilot cloud agent / code review | the issue or PR text | `.github/hooks/*.json` on the default branch only | no interactive prompts; `ask` becomes deny; code review reads `.github/skills/` only; network is firewalled |
| Claude Code | text after `/agentic-developer-companion` | `~/.claude/settings.json` (`/hooks` shows them) | headless `-p` needs `--allowedTools`; pass `--yes` to scripts when no one can answer |
| Codex | text after `$agentic-developer-companion` | `~/.codex/hooks.json`; approve once in `/hooks` | default sandbox is read-only without network: `verify` needs `workspace-write` or an approved escalation; `deps-check` runs `--offline` |

Details per host, versions and known gaps: [host-notes](references/host-notes.md).

## Safety

- Write only inside the target repository and its `.adc/` state directory (the OS temp dir
  holds worktrees). Ask before registering hooks, editing CI or writing scaffolds.
- Hooks never call the network. Nothing leaves the machine; there is no telemetry.
- Redact secrets in evidence and summaries. Never dump the environment (`env`, `printenv`,
  `Get-ChildItem Env:`) in a session that may hold credentials.
- **Never open, print, copy or search `.adc/.env.live`.** Only `adc.mjs live run` reads it,
  and it passes the token to the probe process without echoing it.
- `.adc/` is git-ignored through `.git/info/exclude` and must never be committed; scripts
  refuse to run (exit 3) while anything under it is tracked.
- The ledger is tamper-evident, not tamper-proof: an agent with shell access can forge
  files. Treat a ledger you did not see produced with suspicion and re-run `verify`.
