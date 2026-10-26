# Tooling eval

Evaluate the user's skills and other tooling the way software is tested: a labeled **trigger
set** for whether a skill is picked up, **outcome evals** for whether the result is right, and a
**regression suite** for every later change. Runs against a model are paid; this playbook
always shows the command and the cost cap first and runs only after the user agrees.

## Contents

- [1. Trigger sets](#1-trigger-sets)
- [2. Scoring](#2-scoring)
- [3. Run it headless (paid)](#3-run-it-headless-paid)
- [4. Outcome evals](#4-outcome-evals)
- [5. Regression suites for tooling changes](#5-regression-suites-for-tooling-changes)
- [6. Report](#6-report)
- [Manual fallback (guidance-only mode)](#manual-fallback-guidance-only-mode)

## 1. Trigger sets

1. Create the set next to the skill (free): `node "$ADC" tooling trigger-set <skill-dir> --init --json`
   writes `<skill-dir>/evals/trigger-set.json` from `assets/evals/trigger-set.template.json`
   (`--set <file>` for another location, `--force` to replace an existing one).
2. Replace every `TODO` query; the runner refuses a set that still contains one. About 20
   queries: 8-10 `should_trigger: true` with varied phrasing (direct and indirect asks, the
   user's own words, realistic detail such as paths, tool names and error text) and 8-10
   **near misses** `should_trigger: false` (same keywords or files, another task or skill).
   One-step requests that need no skill make poor positives: agents rarely load a skill for them.
3. Check it (free): `node "$ADC" tooling trigger-set <skill-dir> --json` prints the queries,
   their split, `ready`, `todo[]`, `warnings[]` and the exact paid commands per host.

Format `adc-trigger-set/1`: `{ "schema", "skill", "runs": 3, "query_threshold": 0.5,
"suite_threshold": 0.8, "queries": [{ "id", "should_trigger", "query" }] }`. skill-creator's
plain array `[{ "query", "should_trigger" }]` loads too (ids are generated).

## 2. Scoring

- Each query runs `runs` times (default 3). A run that errors or times out counts as not
  behaving as labeled.
- A query **passes** when more than `query_threshold` (0.5) of its runs behave as labeled, so
  2 of 3.
- The **suite score** is the share of passing queries; the acceptance figure is 0.8
  (`--threshold`, or the set's `suite_threshold`).
- `train_score` and `validation_score`: a fixed, label-stratified 60/40 split derived from a
  hash of each query, so it never changes between runs. Tune the description on train failures
  only, judge on validation, stop after 5 revisions (`iteration` counts the runs per host and
  warns after 5), then add 5-10 fresh queries.
- `run_scores[]` is the share of queries that behaved in run 1, run 2, ...; `sd` is their spread.
  `tooling modify` uses `sd` as the tolerance when it compares two scores.

Exit codes: `0` the suite passed (or nothing was run), `1` below the threshold, `4` more than
half of the runs errored (not a measurement), `2` usage (TODO queries, bad options), `3` the host
CLI is missing.

## 3. Run it headless (paid)

`node "$ADC" tooling trigger-set <skill-dir> --host claude|copilot|codex --run --json
[--runs 3] [--split all|train|validation] [--model <pinned>] [--max-cost-usd 10]
[--timeout-s 180] [--concurrency 1] [--cli <path>]`

With `--dry-run` nothing is run. Every run starts in a fresh temporary workspace that holds
only a copy of the skill (its `evals/` excluded), so repository instructions, other skills and
earlier sessions cannot leak in.

| Host | Command per query | Counts as triggered | Confidence |
|---|---|---|---|
| Claude Code | `claude -p "<query>" --output-format stream-json --verbose --tools Skill,Read,Glob,Grep --permission-mode dontAsk --no-session-persistence --max-budget-usd <left>` (skill in `.claude/skills/<name>/`, `CLAUDECODE` unset) | a `Skill` tool call naming the skill (also `plugin:skill`), or a `Read` of its SKILL.md | high |
| Copilot CLI | `copilot -p "<query>" --output-format json --no-ask-user --trust-folder --share <tmp>.md` (skill in `.github/skills/<name>/`, `COPILOT_AUTO_UPDATE=false`) | a JSONL event about a skill that names it, any string naming `skills/<name>/SKILL.md`, or a `--share` transcript line that mentions a skill and the name (the quoted prompt does not count) | unconfirmed: Copilot documents no skill-load event yet |
| Codex | `codex exec --json --ephemeral --skip-git-repo-check "<query>"` (skill in `.agents/skills/<name>/`, workspace is a git repo) | any event naming `skills/<name>/SKILL.md` or a script under `skills/<name>/scripts/` (Codex treats reading the skill as invoking it) | medium |

Cost control:

- A run stops as soon as the skill triggers, which saves the rest of the turn.
- `--max-cost-usd` (default 10 for Claude Code) caps the whole set: Claude reports each run's
  cost; a run stopped early has no cost line and is priced at the mean of the priced runs
  (`cost: { measured_usd, measured_runs, estimated_usd, estimated_runs }`). When the cap is
  reached the remaining runs are skipped (`partial: true`) and count as errors.
- Copilot and Codex report no per-run cost (`cost_usd: null`): cap spend with `--runs`, the
  query count and `--split train` while iterating.
- A personal skill with the same name (`~/.claude/skills/<name>`) wins over the copy under
  test; the result warns about it.

Results go to `.adc/tooling/<artifact>/trigger-<host>-<timestamp>.json` (with the description
hash, so `tooling modify` reuses a score only for the same description) and one line in
`.adc/metrics.jsonl`. Re-score saved results for free with `--results <file>`; it warns when
they were measured on a different description.

Copilot alternatives when its method stays unconfirmed: `microsoft/waza` (`waza new eval
<skill>` scaffolds positive and negative trigger tasks; `waza run eval.yaml` with the
`copilot-sdk` executor), or the VS Code Chat Customizations Evaluations extension. promptfoo
covers Claude Code and Codex through its SDK providers (`skill-used` assertions).

## 4. Outcome evals

`tooling scaffold skill` writes one case of each format next to the skill:

- **`claude plugin eval`** (Claude Code 2.1.269+): `evals/<case>/prompt.md` (frontmatter such
  as `max_turns`, `runs`, `timeout_seconds`, `allowed_tools`, `model`, `tags`; unknown keys fail
  to load) and `evals/<case>/graders/*.md` (`type: regex | tool_used | tool_order | file_exists |
  llm | baseline`, `weight`). A standalone skill folder is a valid target: `claude plugin eval
  .claude/skills/<name>` resolves it as a plugin named after the skill (checked 2026-10-25).
- **skill-creator** `evals/evals.json` (`skill_name`, `evals[{id, prompt, expected_output,
  files, expectations}]`), run with the skill-creator skill. The formats are not interchangeable.

Free load check (parses every case, runs none): `claude plugin eval <target> --case
__no_such_case__ --trust-plugin --no-publish`; it prints `N case file(s) failed to load` with
the offending key when a case is broken. `tooling plugin check` runs it for plugins.

Paid run, with a pinned model and a cap:
`claude plugin eval <target> --trust-plugin --json results.json --threshold 0.8 --model <id>
--judge-model <id> --max-cost-usd 10 --no-publish [--runs 3] [-j 2]`

- The default is two arms (with and without the plugin, the delta reported); `tool_used: Skill`
  graders then only indicate that the skill fired and do not score. Use `--ablation none` to
  score them.
- The cost ceiling is checked before each run starts, so at least one run (one per
  `--concurrency` slot) is always paid for.
- Exit `0` passed, `1` below threshold or load error, `2` partial (cost ceiling).
- Granting Bash needs the OS sandbox: on Windows run such suites under WSL2.
- Pass the results to `tooling modify ... --outcome-results results.json`.

Copilot has no built-in eval runner (`copilot -p` in CI, or waza); Codex uses `codex exec
--json` with `--output-schema` for checkable answers.

## 5. Regression suites for tooling changes

- Every change to a measured artifact goes through the [tooling-modify](tooling-modify.md)
  loop; its `--external` rendered-context snapshots are the golden files.
- A/B two instruction variants on the same prompt set ([tooling-optimize](tooling-optimize.md) §4, move 1).
- LLM-judge rubrics: per-dimension yes/no questions, "unknown" allowed, position-swapped
  pairs, a judge model other than the one under test, a periodic human check of a sample.
  Pin every model (`--model`, `--judge-model`) so a model rollout is not mistaken for a
  tooling regression.

## 6. Report

Per host: suite score (threshold), train and validation scores, `sd`, runs, errors, cost
(measured and estimated), the method and its confidence, then the failing queries with their
pass rates and labels, and the exact command. Never round a failing score up or report a host
that was not run.

## Manual fallback (guidance-only mode)

Without Node 24, write "guidance-only mode" in the report and run a small set by hand.

1. In a temporary folder, copy only the skill: `.claude/skills/<name>/` (Claude Code),
   `.github/skills/<name>/` (Copilot), `.agents/skills/<name>/` (Codex; `git init` first).
2. Per query, 3 runs each (paid):
   - `claude -p "<query>" --output-format stream-json --verbose --max-budget-usd 0.5 | grep -c '"name":"Skill"'`
   - `copilot -p "<query>" --output-format json --no-ask-user --trust-folder --share t.md`, then look for the skill in `t.md`
   - `codex exec --json --ephemeral "<query>" | grep -c "skills/<name>/SKILL.md"`
   (PowerShell: pipe to `Select-String -Pattern '<pattern>' | Measure-Object`.)
3. A query passes with 2 of 3 runs as labeled; the suite score is the share of passing queries.
4. Record queries, labels, per-run results, scores and the CLI versions in the report.
