# Tooling optimize

`tooling optimize` makes instructions, skills and agents cheaper and sharper without losing
behavior: measure what each host loads, remove bloat and conflicts, move detail to where it
loads on demand, tune descriptions, and accept a change only when the measurements prove it.
There is no separate script: the mode combines `tooling cost`, `tooling trigger-set`,
`tooling lint` and the `tooling modify` loop.

## Contents

- [1. Measure the baseline](#1-measure-the-baseline)
- [2. Read the cost report](#2-read-the-cost-report)
- [3. Find bloat and conflicts](#3-find-bloat-and-conflicts)
- [4. Optimization moves](#4-optimization-moves)
- [5. Accept only measured improvements](#5-accept-only-measured-improvements)
- [6. Report](#6-report)
- [Manual fallback (guidance-only mode)](#manual-fallback-guidance-only-mode)

## 1. Measure the baseline

1. Resolve `ADC` as described in [SKILL.md](../SKILL.md).
2. Context cost of everything (or the paths the user named):
   `node "$ADC" tooling cost [paths...] --json [--host all|copilot|claude|codex] [--context-tokens 200000]`
3. For each artifact the user wants to optimize, record the baseline triple before touching it:
   `node "$ADC" tooling modify baseline <path> --json` (lint, always-on tokens per host,
   rendered context, hosts it loads in; for skills also the latest trigger score measured on the
   same description). Skills without a trigger score: build the set first
   ([tooling-eval](tooling-eval.md)); measuring it is paid and needs the user's consent.
4. Outcome evals, when the repository has them (`claude plugin eval ... --json results.json`),
   go into the baseline with `--outcome-results results.json`.

## 2. Read the cost report

`{ files[{path, kind, hosts[], chars, lines, est_tokens, load, always_on_tokens{host},
on_demand_tokens}], totals{<host>: {always_on_tokens, instruction_tokens, listing_tokens,
path_scoped_tokens, on_demand_tokens, budgets[]}}, biggest_always_on[], findings[], notes[] }`.
Tokens are estimated as `ceil(chars / 4)` (English text, about plus or minus 25 percent); use the
numbers to compare versions of the same file, not as exact host figures.

`load` says when a host pays for the file:

| `load` | Meaning | Examples |
|---|---|---|
| `always` | every session, every turn | `AGENTS.md`, `CLAUDE.md` (HTML comments stripped for Claude Code), `.github/copilot-instructions.md`, rules without `paths`, `applyTo: "**"`, files pulled in by `@imports` |
| `listing` | the name and description in every session; the body on use | skills, agents, Claude commands (`description` + `when_to_use` for Claude Code) |
| `path-scoped` | only when matching files are in play | `.github/instructions/*.instructions.md` with globs, `.claude/rules/*.md` with `paths` |
| `on-demand` | only when read | skill bodies, `references/` files |

Which host reads a file follows the hosts' rules: Claude Code reads `AGENTS.md` only when no
`CLAUDE.md` exists or through an `@AGENTS.md` import; `AGENTS.override.md` replaces
`AGENTS.md` for Codex; a Codex skill with `allow_implicit_invocation: false` costs no listing
tokens. MCP tool definitions and hooks also cost context but are not estimated (use `/context`
in Copilot CLI or Claude Code, `claude plugin details <plugin>` for installed plugins).

Budgets checked per host (`totals.<host>.budgets[]`, an `OVER_BUDGET` finding when exceeded):

| Budget | Limit | Source |
|---|---|---|
| Claude Code skill listing | 1% of the context window (`--context-tokens`) | Claude Code skills docs |
| `CLAUDE.md` | 200 lines | Claude Code memory guidance |
| skill `description` + `when_to_use` | 1,536 characters (truncated beyond) | Claude Code skills docs |
| Codex skills catalog | 2% of the context window, at most 10,000 tokens | Codex `[skills] max_context_tokens` |
| Codex `AGENTS.md` chain | 32 KiB from the root down to the working directory | Codex `project_doc_max_bytes` |
| Copilot instruction file | about 1,000 lines | Copilot code review guidance |
| skill `description` | 1,024 characters | Agent Skills spec |
| Copilot agent body | 30,000 characters | Copilot custom agents reference |

`--max-tokens <n>` exits 1 when any host's always-on total exceeds `n` (a CI gate).

## 3. Find bloat and conflicts

`tooling cost` reports, with `file:line`:

- `DUPLICATE_RULE`: the same rule loaded twice for one host (for example in `AGENTS.md` and
  `.github/copilot-instructions.md`, both read by Copilot).
- `STALE_COMMAND`: a command that names a package-manager script, Makefile target or justfile
  recipe that does not exist, or a package manager other than the lockfile's.
- `STALE_PATH`: an inline-code path that does not exist in the repository.

Then read the loaded files yourself for what a script cannot judge, citing `file:line`:
contradictions (same subject, different instruction, for example "use tabs" and "2-space
indentation"), rules the model follows anyway (generic advice, language defaults), task-specific
or time-sensitive lines, style requests that cost tokens on every turn, and rules that belong to
one directory or file type. `tooling lint` adds the host-rule problems (imports that do not
resolve, `CLAUDE.local.md` next to `AGENTS.md`, bash-only commands, secrets).

## 4. Optimization moves

Make one move per change, so each can be measured and reverted on its own.

1. **Delete** duplicates, stale commands and paths, and rules the model already follows.
   For "already follows", A/B it: run the same 5-10 representative prompts with and without the
   rule (two arms of `claude plugin eval`, or the same `claude -p` / `copilot -p` / `codex exec`
   prompts on both versions) and delete only if the outcome does not change.
2. **Progressive disclosure**: move detail from always-on instructions into a skill (listing
   cost only) and from SKILL.md into `references/` (on demand). Keep in the always-on file what
   every turn needs: commands, boundaries, the few rules that are always relevant.
3. **Scope** what applies to some files only: `.github/instructions/<topic>.instructions.md`
   with `applyTo` and `.claude/rules/<topic>.md` with `paths` (Copilot CLI reads both), nested
   `AGENTS.md` for Codex (directory scoping only). `tooling port` translates between them.
4. **Convert prompt files to skills** (`tooling modify <prompt> --migrate prompt-to-skill`):
   prompt files reach only the VS Code Local harness and Visual Studio.
5. **One source for shared rules**: `AGENTS.md`, with `CLAUDE.md` = `@AGENTS.md` plus
   Claude-only notes, and `.github/copilot-instructions.md` holding Copilot-only notes. A
   generated copy is better than two hand-maintained ones, and a symlink breaks on Windows
   checkouts.
6. **Description tuning** for skills: what + when + boundary, third person, the user's own
   words and keywords first, near-miss exclusions ("Not for ..."), at most 1,024 characters.
   Tune against the trigger set's train split only ([tooling-eval](tooling-eval.md)); a shorter
   description that keeps the trigger score is the target.
7. **Portability**: replace host-only syntax in shared files (`$ARGUMENTS`, `${CLAUDE_SKILL_DIR}`,
   bang-backtick commands, Claude-only frontmatter) with plain instructions, and keep host
   extras in host files.

## 5. Accept only measured improvements

After each move: `node "$ADC" tooling modify compare <path> --note "<why>" --json`.

- The output is the before/after triple per artifact: always-on tokens per host, trigger score
  (re-measure with `tooling trigger-set <skill> --host <h> --run` after a description change; it
  is paid, ask first), outcome-eval score (`--outcome-results`).
- `accept`: no new lint errors, trigger and outcome not below the baseline beyond the measured
  spread, tokens not up without a `--note`, no host lost. `reject` lists the failing deltas;
  `unverified` means a score measured in the baseline was not re-measured.
- Record an accepted change with `--accept` (changelog entry, version bump, new baseline);
  undo a rejected one with `--restore`. Details: [tooling-modify](tooling-modify.md).
- Every compare and trigger run is appended to `.adc/metrics.jsonl`.

Never accept a token cut that lowers a measured trigger or outcome score, and never claim an
improvement that was not measured: write `not measured` instead.

## 6. Report

Post a table per artifact: `artifact | host | always-on tokens before -> after | trigger before
-> after | outcome before -> after | lint errors | verdict`, then the moves made (one line each,
with `file:line`), the findings left open, and the exact commands to reproduce.

## Manual fallback (guidance-only mode)

Without Node 24, measure by hand and write "guidance-only mode" in the report.

1. Characters per file (divide by 4 for tokens): `wc -c AGENTS.md CLAUDE.md .github/copilot-instructions.md`
   (PowerShell: `Get-ChildItem AGENTS.md, CLAUDE.md | Select-Object Name, Length`);
   lines: `wc -l <file>` (`(Get-Content <file>).Count`).
2. Classify each file with the `load` table above; sum the always-on files per host.
3. Duplicates across always-on files: `cat AGENTS.md .github/copilot-instructions.md | sort | uniq -d`
   (PowerShell: `Get-Content AGENTS.md, .github/copilot-instructions.md | Group-Object | Where-Object Count -gt 1`).
4. Stale commands: compare each command in the files with `package.json` scripts, Makefile
   targets and the lockfile in the repository.
5. Before editing, copy the file to `.adc/tooling/<name>/<date>/`; after editing,
   `git diff --no-index .adc/tooling/<name>/<date>/<file> <file>`, recount, and re-run the same
   handful of prompts in each host (see [tooling-eval](tooling-eval.md), manual fallback).
