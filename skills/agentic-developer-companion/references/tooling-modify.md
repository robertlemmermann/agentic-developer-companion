# Tooling modify

Changing a live instruction file, skill, agent, prompt, hook or MCP config is where tooling
quality is lost: a wording tweak changes triggering, grows the context cost or breaks a host.
`tooling modify` turns every change into a measured experiment: **baseline, change,
compare, accept or reject, record**. The built-in migrations run the same loop.

## Contents

- [1. Baseline](#1-baseline)
- [2. Change](#2-change)
- [3. Compare](#3-compare)
- [4. Accept, reject, restore](#4-accept-reject-restore)
- [5. Migrations](#5-migrations)
- [6. Report](#6-report)
- [Manual fallback (guidance-only mode)](#manual-fallback-guidance-only-mode)

## 1. Baseline

1. Resolve `ADC` as described in [SKILL.md](../SKILL.md).
2. `node "$ADC" tooling modify baseline <path> --json [--external] [--strict] [--outcome-results <file>]`
   where `<path>` is a file or a skill folder inside the repository.
3. It measures and stores under `.adc/tooling/<artifact>/baselines/<timestamp>/`:
   - `lint`: errors and warnings per host from [tooling-lint](tooling-lint.md) (`--strict` for
     spec-only frontmatter);
   - `cost`: always-on and on-demand tokens per host ([tooling-optimize](tooling-optimize.md));
   - `trigger` (skills): the latest trigger-set score measured on the same name and
     description, if any; `--host <h> --run` measures it now (paid, ask first; `--cli`,
     `--model`, `--max-cost-usd` as in [tooling-eval](tooling-eval.md));
   - `outcome`: `aggregates.overallScore` of a `claude plugin eval --json` result file;
   - `hosts`: the hosts that load the artifact from its location without lint errors;
   - `context.txt`: the rendered context (the skill listing entry and body; instructions with
     imports inlined per host; hooks and MCP servers normalized);
   - with `--external`: what the hosts render themselves, free and without sign-in
     (`copilot instruction list --json` or `copilot skill list --json`, the skills and
     `AGENTS.md` parts of `codex debug prompt-input`, `skills-ref to-prompt`), machine paths
     replaced by `<repo>` and `~`;
   - `files/`: a copy of every file of the artifact (for restore).
4. If a skill has no trigger score yet, say so: a change to its description cannot be
   accepted later without one (see step 3).

## 2. Change

Edit the artifact (or let the model edit it) with one intent per change, following the
per-kind rules in [tooling-scaffold](tooling-scaffold.md) and the checklist in
[tooling-practices](tooling-practices.md): no host-specific syntax in shared files, no
secrets or hostnames, Windows-safe commands, and never rename a published skill or plugin.

## 3. Compare

`node "$ADC" tooling modify compare <path> --json [--note "why"] [--external] [--host <h> --run]
[--outcome-results <file>]`

The same measurements are taken again and compared with the latest baseline:

| Delta | Rule for `accept` |
|---|---|
| `lint` | no new errors (errors are matched by host, rule and message, ignoring line numbers) |
| `tokens` | always-on tokens per host not higher, unless `--note` explains the increase |
| `trigger` | not below the baseline by more than the measured spread (`sd` of the runs) |
| `outcome` | not below the baseline by more than its standard error |
| `hosts` | no host lost |
| `context`, `external` | informational: added and removed lines of the rendered context |

Verdicts: `accept`; `reject` with `failing[]`; `unverified` with `unverified[]` when a score
measured in the baseline was not measured again (re-run `tooling trigger-set ... --run` or
pass new `--outcome-results`). A trigger score is reused automatically when the name and
description did not change, an outcome score when no file changed. Exit `0` accept, `1`
reject, `4` unverified, `2` usage (no baseline: run `baseline` first).

Output: `{ artifact, baseline_dir, unchanged, before, after, deltas{lint, tokens, trigger,
outcome, hosts, context, external?}, verdict, failing[], unverified[], changelog_entry,
recorded, restored }`. Each compare is saved next to the baselines and appended to
`.adc/metrics.jsonl`.

## 4. Accept, reject, restore

- `compare ... --accept [--bump patch|minor|major|none] --note "why"`: only when the verdict
  is `accept`, it inserts `changelog_entry` under `## [Unreleased]` / `### Changed` in the
  repository's `CHANGELOG.md` (created if missing), bumps `metadata.version` in a SKILL.md or
  `version` in a plugin manifest (default `patch`), and stores a new baseline as the regression
  reference for the next change. Otherwise `recorded.refused` explains why and the exit is 1.
- `compare ... --restore`: on `reject`, copies the baseline files back.
- `node "$ADC" tooling modify restore <path>`: restores the latest baseline at any time; files
  added after the baseline are listed in `not_in_baseline[]` and left in place.
- `--dry-run` measures and compares but writes nothing, not even under `.adc/`, and never
  starts a paid trigger run; a dry-run migration writes and measures nothing.

## 5. Migrations

`node "$ADC" tooling modify <path> --migrate <kind> [--to copilot|claude|codex] [--force] --json`

| `--migrate` | Source | Result | Equivalence proven by |
|---|---|---|---|
| `prompt-to-skill` | `.github/prompts/<n>.prompt.md` | `.github/skills/<n>/SKILL.md` with `disable-model-invocation: true`; `agent`, `model`, `tools` dropped | identical Markdown body |
| `chatmode-to-agent` | `.github/chatmodes/<n>.chatmode.md` | `.github/agents/<n>.agent.md` | identical body |
| `claude-commands-to-skills` | `.claude/commands/` (folder) or one command | `.claude/skills/<a>-<b>/SKILL.md` per command | identical body |
| `vscode-mcp-to-mcp-json` | `.vscode/mcp.json` (`servers`, `${input:}`) | `.mcp.json` (`mcpServers`, `${VAR}`) | same servers: name, transport, command, args, URL, env and header names |
| `copilot-hooks-to-camel` | a legacy or PascalCase `.github/hooks/*.json` | the same file as `version: 1` with camelCase events, `bash` + `powershell`, `timeoutSec` | same events, matchers, commands and timeouts after normalization |

Each migration stores a baseline of every source first, migrates through `tooling port`, then
measures every result: `accept` needs zero lint errors, the equivalence check, and trigger or
outcome scores that do not fall. The result is `{ migration, sources[], baselines[], written[],
skipped[], dropped_fields[], manual_steps[], results[{artifact, lint, equivalence, deltas,
verdict}], verdict }` (exit as for compare). Targets that exist are skipped unless `--force`;
`copilot-hooks-to-camel` rewrites its file in place (with a backup). camelCase events send
camelCase payloads (`toolName`, `toolArgs` as a JSON string): update the handler. After a
`claude-commands-to-skills` migration, delete the commands once the skills work.

## 6. Report

Post the before/after table (`delta | before | after | rule | ok`), the verdict with
`failing[]` or `unverified[]`, the changelog entry and version bump when accepted, the
restored files when rejected, and the exact commands.

## Manual fallback (guidance-only mode)

Without Node 24, write "guidance-only mode" in the report and do the loop by hand:

1. Baseline: `mkdir -p .adc/tooling/<name>/<date>` and copy the artifact there (PowerShell:
   `New-Item -ItemType Directory .adc/tooling/<name>/<date>; Copy-Item <file> .adc/tooling/<name>/<date>/`);
   record the character count (`wc -c <file>`), the validators' results ([tooling-lint](tooling-lint.md),
   manual fallback) and, for skills, the trigger results of a few queries per host
   ([tooling-eval](tooling-eval.md), manual fallback).
2. Change the artifact.
3. Compare: `git diff --no-index .adc/tooling/<name>/<date>/<file> <file>`, recount, re-run
   the same validators and queries.
4. Accept only with no new validator errors, no lower trigger results, and no unexplained
   growth; then add the `CHANGELOG.md` entry and bump `metadata.version` by hand. Otherwise
   copy the baseline back.
