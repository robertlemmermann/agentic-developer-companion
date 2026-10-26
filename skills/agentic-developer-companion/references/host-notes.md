# Host notes: what Copilot, Claude Code and Codex actually do

The per-host facts every mode depends on, with the date they were last checked. "Documented"
means read from the vendor's docs or source on 2026-10-24; **measured** means observed on
2026-10-25 in a Linux container with Node 24.22.1, Git 2.43.0, gh 2.99.0, Copilot CLI 1.0.103,
Codex CLI 0.164.0, Claude Code 2.1.310 and pwsh 7.5.4. Hosts change within weeks: re-check
with §10 before relying on a row that is older than a quarter, and update the date.

## Contents

1. [Per-host quick reference](#1-per-host-quick-reference)
2. [Script commands](#2-script-commands)
3. [Skill discovery](#3-skill-discovery)
4. [Invocation and arguments](#4-invocation-and-arguments)
5. [SKILL.md frontmatter honored](#5-skillmd-frontmatter-honored)
6. [Hooks](#6-hooks)
7. [Instructions, headless runs, validators, evals](#7-instructions-headless-runs-validators-evals)
8. [Measured on 2026-10-25](#8-measured-on-2026-10-25)
9. [Open items](#9-open-items)
10. [Re-checking these notes](#10-re-checking-these-notes)

## 1. Per-host quick reference

| Host | Arguments come from | Hooks register in | What cannot work, and what to do |
|---|---|---|---|
| Copilot CLI | text after `/agentic-developer-companion` (`-i "/agentic-developer-companion verify"` at startup) | `~/.copilot/hooks/*.json` (`$COPILOT_HOME`), `.github/hooks/*.json` in a trusted folder | restart the CLI after registering hooks; `-p` loads project skills and repo hooks only with `--trust-folder` (or `COPILOT_ALLOW_ALL=true`); in `-p` name the skill in prose; `ask` decisions are denials in `-p` and autopilot |
| VS Code (Session Target = Copilot) | text after `/agentic-developer-companion` ("extra context") | same files as the CLI (shared harness) | `allowed-tools` is ignored; hooks are Preview; the legacy Local-harness hook format is never generated |
| GitHub Copilot app | repository and CLI skills appear automatically | repository hooks | custom-skill slash invocation is not documented; mention the skill by name |
| Copilot cloud agent | the issue or PR text (no slash command); mention the skill and the mode | only `.github/hooks/*.json` on the default branch, `bash` strings only | no interactive prompts (`ask` becomes deny); outbound network is firewalled, so vendor the skill or clone it in `copilot-setup-steps.yml`; personal skills are not available |
| Copilot code review | automatic, by description | none | reads only `.github/skills/`; install a copy there (`gh skill install … --dir .github/skills`) |
| Visual Studio 18.5+, JetBrains (preview) | automatic, by description | not documented | no explicit invocation; name the skill in the request |
| Claude Code | text after `/agentic-developer-companion` | `~/.claude/settings.json` (exec form), `.claude/settings.local.json` (shell strings) | `-p` needs `--allowedTools`; settings-file hooks wait for workspace trust; pass `--yes` to scripts when nobody can answer; `/hooks` shows what is registered |
| Codex | text after `$agentic-developer-companion` (no slash command; save it in a `/presets` slot) | `~/.codex/hooks.json` (`$CODEX_HOME`), `.codex/hooks.json` in a trusted project; approve each new hook once in `/hooks` | default sandbox is `read-only` without network: `verify`, `clean-run` and `typecheck` need `workspace-write` or an approved escalation; `deps-check` runs `--offline`; hooks on native Windows: confirm in `/hooks` |

Explicit non-interactive switch for scripts on every host: `--yes` (also implied by `CI`,
`GITHUB_ACTIONS`, the cloud-agent variables and a non-TTY stdin).

## 2. Script commands

Every command is `node "<skill>/scripts/adc.mjs" <command> [options] --json`; locate `<skill>`
as SKILL.md describes or read it from `doctor`. Output is one ASCII-only JSON document on
stdout and a one-line summary on stderr. Global options: `--json`, `--cwd <dir>`,
`--base <ref>`, `--state-dir <dir>`, `--dry-run`, `--yes`, `--help`. Exit codes: `0` ok, `1` findings, `2`
usage, `3` environment missing (Git, Node 24, runner, tool, tracked `.adc/`), `4` could not verify.

| Command | Purpose | Key options | JSON output |
|---|---|---|---|
| `verify` | every scripted verify step on one snapshot, into one ledger | `--base` `--spec` `--claims` `--quick\|--deep` `--finalize` `--allow` `--offline` `--runner` `--no-install` | `{ ledger, markdown, verdict, checks[], claims[], next_steps[], trace_matrix, worktree_unchanged }` |
| `detect` | projects, managers, runners with report and retries-off flags, test globs, CI, default branch | `--refresh` | `{ cache_key, summary, projects[{root, languages[], managers[], runners[], test_globs[]}], ci, lint[], typecheck[], default_branch, base_source }` |
| `diff-scope` | CK-SCOPE, TEST-DEL, SKIP, ASSERT, TEST-CFG, SUPPRESS, CI, SWALLOW, SECRETS, LOCK (static), RETRY | `--base` `--spec` `--allow <glob>` | `{ base, tree_digest, files[], findings[], counts, checks[] }` |
| `deps-check` | new dependencies exist, look-alikes, lockfile consistency (CK-DEPS, CK-LOCK) | `--offline\|--online` `--static-only` | `{ new_deps[{name, ecosystem, exists, source, lookalike_of}], lock_status, findings[], checks[] }` |
| `typecheck` | new compile/type errors vs the base (CK-TYPES) | `--strict` `--runner` | `{ cmd, base, head, new_errors[], status, checks[] }` |
| `clean-run` | full suite of the snapshot in a temp worktree, retries off, counts vs base (CK-CLEANRUN); red-green proof (CK-REDGREEN) | `--no-install` `--runner` `--all-projects` `--base-counts` `--no-base` `--keep` `--red-green <files[::name]>` | `{ tree_digest, projects[], status, red_green, checks[] }` |
| `coverage-delta` | changed-line coverage (CK-COVERAGE, soft) | `--fail-under <pct>` `--report <file>` | `{ tool, changed_lines, covered, pct, uncovered[], untested_branches[], precision, checks[] }` |
| `mutation-scope` | mutation testing on changed files (CK-MUTATION, soft) | `--budget <min>` | `{ tool, mutants, killed, survived, score, survivors[], checks[] }` |
| `flake-probe` | repeat and shuffle new or changed tests (CK-FLAKE) | `--times <n>` `--tests <file[::name]>` | `{ runs, shuffle, seeds[], failures[], suspect_tests[], checks[] }` |
| `evidence init\|add\|claims\|waive\|finalize\|render\|status\|score` | the ledger; claim status derived; waivers quote the spec; `score` aggregates yes/no/unknown answers | `--ledger` `--check` `--run` `--repro` `--reason` `--file` `--md` `--short` `--out` `--add` | ledger summary per subcommand ([verify](verify.md) §6) |
| `trace` | requirement candidates and unmapped hunks (CK-TRACE) | `--spec` `--matrix <completed.json>` `--md` | `{ requirements[], extras[], hunks_total, checks[] }` |
| `scaffold <kind>` | `e2e-web e2e-api e2e-cli live regress ci-gate flake` and the tooling kinds | `--lang` `--for` `--out` `--write` `--force` `--checklist` | `{ written[], next_steps[] }` |
| `live run` | live probes under the budget ledger (CK-LIVE) | `--manifest` `--probes` `--session` `--credits` `--credits-override` (terminal only) `--no-ledger` | `{ session_id, identity_source, probes[{id, status, cost, duration_ms}], spent, remaining, stopped_reason }` |
| `budget show\|reset\|prune` | inspect or maintain `.adc/budget.json` | `--session` | `{ unit, max_per_session, max_per_day, today, sessions[] }` |
| `tooling lint` | host-rule validation incl. the security group | `--host` `--strict` `--no-external` `--allow-host` | `{ files[{path, kind, host_results[]}], security[], summary }` |
| `tooling cost` | context cost per file and host | `--host` `--context-tokens` `--max-tokens` `--top` | `{ files[{path, chars, est_tokens, always_on}], totals, biggest_always_on[] }` |
| `tooling port` | translate tooling between hosts | `--from` `--to` `--out` `--force` | `{ written[], dropped_fields[], manual_steps[] }` |
| `tooling trigger-set` | trigger-eval set; runs only with `--run` (paid) | `--init` `--set` `--host` `--run` `--runs` `--threshold` `--max-cost-usd` | `{ queries[], results[], per_query_pass_rate, suite_score }` |
| `tooling modify` | baseline, compare, accept or reject; migrations | `baseline\|compare\|restore <path>` `--accept` `--migrate <kind>` | `{ before, after, deltas, verdict, changelog_entry }` |
| `tooling plugin` | plugins for the user's own projects | `init\|check\|test\|release` `--for` | `{ files[], validators[], local_test_commands[], release_steps[] }` |
| `tooling scaffold <kind>` | instructions, skill, agent, prompt, hooks, mcp, plugin | `--for` `--name` `--write` | `{ written[], next_steps[] }` |
| `hooks render` (alias `setup hooks`) | render, merge (`--write`) or remove (`--remove`) the hook config | `--host` `--scope` `--level` `--node-path` | `{ host, target_file, config, warnings[], next_steps[], permission_rules }` |
| `hooks list` | registered hooks of this skill | — | `{ hooks[{host, scope, file, events[], level}] }` |
| `hook-run <event>` | the hook handler: stdin payload in, one decision object out, always exit 0 | `--dialect` `--level` | host-specific decision (`{}` for none) |
| `doctor` | host, OS, Node, Git, host CLI versions, prerequisites, installed copies, hooks, launcher probes, state dir | `--init` `--verify-vendored [--against] [--ref]` `--no-probes` | `{ host_guess, os, node, git, hosts[], install_paths[], hooks[], probes[], state, warnings[] }` |
| `version` · `help` | the skill version · the command list | — | plain text |

**Manual fallback** (guidance-only mode, no Node): each playbook lists the Git and runner
commands per step; start from [verify](verify.md) §7.

## 3. Skill discovery

Documented 2026-10-24 unless marked; first found wins by name everywhere.

| Host | Project scope | User scope | Other |
|---|---|---|---|
| Copilot CLI | `.github/skills/` > `.agents/skills/` > `.claude/skills/` > parent `.github/skills/` (**measured**: all three listed by `copilot skill list` even in an untrusted folder) | `~/.copilot/skills/`, `~/.agents/skills/` (not `~/.claude/` since 1.0.36) | `COPILOT_SKILLS_DIRS`, `skillDirectories` (user settings; repository `.github/copilot/settings.json` **measured**: honored only in a trusted folder), `--add-dir`, `copilot skill add` |
| VS Code, Visual Studio 18.5+ | `.github/skills/`, `.claude/skills/`, `.agents/skills/` | `~/.copilot/skills/`, `~/.claude/skills/`, `~/.agents/skills/` | `chat.agentSkillsLocations` (not recommended) |
| Copilot cloud agent | `.github/skills/`, `.claude/skills/`, `.agents/skills/`; code review: `.github/skills/` only | none | default branch assumed (open item C2) |
| Claude Code | `.claude/skills/` (walks up to the repository root) | `~/.claude/skills/` | `--add-dir`, plugins, managed dir; never `.agents/` or `.github/skills/` |
| Codex | `.agents/skills/` from the project root to cwd; `.codex/skills/` (**measured**: both read in an untrusted Git repository) | `~/.agents/skills/`, `$CODEX_HOME/skills/` (deprecated, still read) | `/etc/codex/skills`; `$skill-installer` writes `~/.codex/skills/<name>` |

Consequence: `.agents/skills/` serves Copilot (CLI, VS Code, VS, cloud agent) and Codex;
Claude Code needs `.claude/skills/`; Copilot code review needs `.github/skills/`.

## 4. Invocation and arguments

| Host | Explicit form | Trailing text | Automatic selection |
|---|---|---|---|
| Copilot CLI | `/agentic-developer-companion` (0.0.389+), several skills per message | allowed; how it is passed is undocumented (C1) | by description; embeddings-based retrieval may drop descriptions over a token limit, the skill stays invocable by name |
| VS Code | `/agentic-developer-companion …` | documented as extra context | yes |
| Cloud agent, code review | none (`/name` in an issue is text) | n/a | by description only |
| Claude Code | `/agentic-developer-companion …` | the dollar-ARGUMENTS placeholder exists, but this skill never relies on it | yes (listing truncates description at 1,536 chars) |
| Codex | `$agentic-developer-companion …`, `/skills` picker, `/presets` (0.164.0+) | free text after the mention | yes (catalog budget 2% of context, capped at 10,000 tokens) |

The shared SKILL.md therefore uses none of Claude Code's substitutions (the dollar-ARGUMENTS
and dollar-digit placeholders, dollar-brace `CLAUDE_*` variables, bang-backtick dynamic
context): Copilot has none of them and Codex passes them through as text.

## 5. SKILL.md frontmatter honored

| Field | Spec (`skills-ref`) | Copilot CLI | VS Code | Claude Code | Codex |
|---|---|---|---|---|---|
| `name` (≤64, lowercase, hyphens, equals the directory) | required | required | required; invalid names fail silently | optional | optional (≤64) |
| `description` (≤1,024) | required | required | required | recommended | required |
| `license`, `compatibility`, `metadata` | optional | ignored | ignored | not acted on | only `metadata.short-description` |
| `allowed-tools` | experimental, space-separated | honored | not supported | honored | ignored |
| `argument-hint`, `user-invocable`, `disable-model-invocation` | rejected | honored | honored | honored | ignored |
| `context`, `hooks`, `paths`, `shell`, `model`, `effort` | rejected | ignored | `context: fork` experimental | honored | ignored |

**Measured**: `skills-ref validate` (strictyaml) passes this skill and rejects flow-style YAML
such as `[Bash]`; Codex re-quotes unquoted `: ` in scalars (documented); `gh skill install`
rewrites the frontmatter on install (§8), so never compare an installed SKILL.md byte for byte.

## 6. Hooks

| Aspect | Copilot CLI / VS Code | Copilot cloud agent | Claude Code | Codex |
|---|---|---|---|---|
| Config | `.github/hooks/*.json`, `~/.copilot/hooks/*.json`, inline `hooks` in settings; also `.claude/settings*.json` of the repository | `.github/hooks/*.json` on the default branch only | `~/.claude/settings.json`, `.claude/settings.json`, `.claude/settings.local.json`, plugins | `~/.codex/hooks.json`, `<repo>/.codex/hooks.json` (trusted), plugins |
| Shape | `{"version":1,"hooks":{"sessionStart":[{"type":"command","bash":"…","powershell":"…","timeoutSec":10}]}}` | same, `bash` only | `{"hooks":{"PostToolUse":[{"matcher":"Edit\|Write","hooks":[{"type":"command","command":"node","args":["…"]}]}]}}` | Claude shape with `command` + `commandWindows`; no `args`/`cwd`/`env` |
| Events used | `sessionStart`, `postToolUse`, `agentStop`, `preToolUse` (guard), `sessionEnd` | same | `SessionStart`, `PostToolUse`, `Stop`, `PreToolUse`, `SessionEnd` | same as Claude |
| Decisions | top-level `additionalContext`, `permissionDecision`, `decision:"block"` (8-block cap) | same; `ask` = deny | `hookSpecificOutput{…}`, `decision:"block"` | Claude shape; **unknown fields rejected** |
| Exit codes | 0 parse JSON; `preToolUse` is fail-closed on errors; timeouts fail open | same | 2 blocks; other codes non-blocking | 2 blocks only with stderr; PowerShell `-Command` collapses 2 to 1 on Windows (issue #54072) |
| Windows launcher | PowerShell (`pwsh`, then `powershell.exe`); flags unverified (C5) | Linux only | Git Bash if installed, else PowerShell; exec form needs a real `.exe` | session shell or `cmd.exe /C` (C4) |

Every decision of this skill is ASCII-only JSON on exit 0. Payloads measured per host (tool
names, `toolArgs` shapes, where context arrives): [install](install.md) §6.

## 7. Instructions, headless runs, validators, evals

| Topic | Copilot | Claude Code | Codex |
|---|---|---|---|
| Instruction files | `.github/copilot-instructions.md`, `.github/instructions/**/*.instructions.md`, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.claude/rules/` (CLI); code review adds `REVIEW.md` | `CLAUDE.md` (+ `@imports`), `.claude/rules/`; `AGENTS.md` only without a `CLAUDE.md` | `AGENTS.override.md` / `AGENTS.md` root to cwd, 32 KiB total; `CLAUDE.md` not read |
| Prompt files | VS Code Local harness and Visual Studio only | legacy `.claude/commands/` | removed (0.117.0); use skills |
| Headless | `copilot -p "…" --trust-folder --no-ask-user --allow-tool 'shell(node:*)' --output-format json` | `claude -p "…" --allowedTools "Bash,Read,Glob,Grep" --output-format json` (`--bare` skips skills) | `codex exec --json -o last.json "…"` |
| Validators | `gh skill publish --dry-run`, `copilot skill list --json`, `/skills info`, `/env` | `claude plugin validate --strict --json` (plugins only, §8), `/doctor prompt-audit`, `claude --debug` | `codex debug prompt-input "x"`, `codex exec --strict-config` |
| Evals | none built in (`copilot -p` in CI; Waza) | `claude plugin eval` (2.1.269+): graders `regex`, `tool_used`, `tool_order`, `file_exists`, `llm`, `baseline` | `codex exec --json` in CI |

## 8. Measured on 2026-10-25

- **`gh skill install`** (gh 2.99.0) discovers `skills/agentic-developer-companion/` in a
  repository whose root holds only `LICENSE` and the README. Destinations: default agent
  (`github-copilot`) `.agents/skills/` (project) and `~/.copilot/skills/` (user);
  `--agent claude-code` `.claude/skills/` and `~/.claude/skills/`; `--agent codex`
  `.agents/skills/` and `~/.agents/skills/`; `--dir .github/skills` →
  `.github/skills/agentic-developer-companion/`. `--pin` takes a tag or SHA as its value.
- **`gh skill install` rewrites SKILL.md frontmatter**: keys sorted, folded `>-` scalars
  turned into single-quoted or plain strings, `metadata.version` unquoted, 4-space
  indentation, the blank line after `---` dropped, provenance added inside `metadata`
  (`local-path` for `--from-local`, `github-*` keys for remote installs). `doctor
  --verify-vendored` therefore compares SKILL.md semantically and other files byte for byte.
- **`gh skill publish --dry-run`** passes on this repository; the only warning is the missing
  tag-protection ruleset. Validation strips `metadata.github-*`.
- **`copilot skill list --json`** works without authentication; fields `name`, `description`,
  `source`, `path`, `enabled`. **`copilot skill add <dir>`** registers the directory in
  `skillDirectories` without copying; both `<clone>/skills` and the skill folder itself work
  (C7). The CLI sets `COPILOT_CLI=1`, `COPILOT_PROJECT_DIR` and `CLAUDE_PROJECT_DIR` for hooks
  and starts exec-form handlers from a repository `.claude/settings*.json` without their
  `args` (C17), which is why project-scope Claude hooks are shell strings.
- **`codex debug prompt-input "x"`** works without authentication and shows the skill in
  `<skills_instructions>` with its description and SKILL.md path (C21 for Codex). Codex
  delivers `apply_patch` as `tool_input.command` with relative paths (C24).
- **`claude plugin validate <dir> --strict --json`** returns `success: true, contents: []`
  for a bare skills directory even when a SKILL.md in it is broken, and "No manifest found"
  for a skill folder: for standalone skills it is **not a validator**. `tooling lint` treats
  `contents: []` as not applicable, never as a pass.
- **`claude plugin eval`**: a skill folder or a skills directory given as the target
  resolves as a plugin, and the ablation defaults to `with-without` (C8). It refuses an
  `--eval-dir` outside the target, so this repository keeps its cases in the root `evals/`
  and runs `claude plugin eval <repo> --eval-dir evals`. `claude plugin eval init --bare
  <case>` writes `evals/<case>/prompt.md` and `evals/<case>/graders/criteria.md`. Results go
  to `<target>/<eval-dir>/results/` unless `--output-dir` and `--report` point elsewhere. In
  the default two-arm mode a `tool_used: Skill` grader only counts with `arm: both` (or under
  `--ablation none`).
- **`skills-ref validate`** (`uvx --from 'git+https://github.com/agentskills/agentskills#subdirectory=skills-ref' skills-ref validate <skill>`) passes.
- **`npx skills add … -a github-copilot -a claude-code -a codex --copy`** (skills 1.7.4)
  writes byte-identical real folders to `.agents/skills/` (Copilot and Codex) and
  `.claude/skills/`, no symlinks, plus a `skills-lock.json` in the project root.
- Claude Code: `MultiEdit` is no longer a tool (C23; kept in matchers, harmless).

## 9. Open items

Not yet verified; each needs a host session, an entitlement or an OS this container lacks.
Status as of 2026-10-25 (C numbers refer to the build plan's Appendix C).

| # | Question | Status |
|---|---|---|
| C1 | How Copilot CLI passes text after `/agentic-developer-companion`; whether `-p` parses a leading `/skill` | open; headless prompts name the skill in prose |
| C2 | Cloud agent and code review reading `.agents/skills/` and `.claude/skills/`; default-branch rule for skills | open |
| C3 | `gh skill` on GHEC/EMU hosts; remote provenance keys | partly measured (§8); GHEC/EMU open |
| C4 | Codex hooks on native Windows; `commandWindows` launcher; exit-code collapse | open: verify with `/hooks` |
| C5 | Copilot hook launcher on Windows: executable, flags, stdin, console encoding | open; output is ASCII JSON either way |
| C6 | `copilot -p --output-format json` skill-load events; granular `--allow-tool` sufficiency; CI token (`COPILOT_GITHUB_TOKEN` reported) | open |
| C9 | VS Code behavior with non-spec frontmatter keys | open (this skill uses none) |
| C11 | Codex project-root markers for the upward walk; a TOML agent format | partly measured: `.codex/skills/` is read without trust |
| C12 | `npx skills add --copy` on Windows without symlink privileges | partly measured: `--copy` writes real folders (Linux, §8); Windows open |
| C13 | Copilot's related-files listing for a skill with `tests/` and `evals/` | open; moot for this skill since 2026-10-26 (it ships runtime files only, ≤100) |
| C14 | Codex `config.toml` `[mcp_servers.<name>]` table for the `mcp` scaffold | open |
| C15 | Waza `copilot-sdk` executor authentication in a Business tenant | open |
| C16 | Cloud-agent tool names for edits and reads | CLI measured ([install](install.md) §6); cloud agent open |
| C18 | `COPILOT_CLI=1` in the VS Code harness and the cloud agent | CLI measured; others open (payload-shape fallback covers it) |
| C19 | `agentStop` transcript format; PascalCase and camelCase entries in one file | partly measured: JSONL with `assistant.message` events |
| C20 | Hook events the VS Code Copilot harness fires in-editor | open |
| C21 | How Claude Code exposes the skill directory to the model | Codex measured; Claude open (the "locate the companion" search is the fallback) |
| C22 | Writes under `.git/` in the Codex `workspace-write` and Copilot sandboxes (`info/exclude`) | open; fallback `.gitignore` entry or `ADC_HOME` |

Resolved since the plan: C7, C8, C10, C17, C23, C24 (§8).

## 10. Re-checking these notes

Free checks (no model turn, no account needed), run in a scratch Git repository with the
skill installed; record the tool version and date here when a result changes:

```bash
gh --version && copilot --version && claude --version && codex --version
gh skill install robertlemmermann/agentic-developer-companion agentic-developer-companion --dir .github/skills
copilot skill list --json
codex debug prompt-input "hello" | grep -n agentic-developer-companion
claude plugin validate .claude/skills --strict --json
node .github/skills/agentic-developer-companion/scripts/adc.mjs doctor --json
```

```powershell
gh --version; copilot --version; claude --version; codex --version
copilot skill list --json
codex debug prompt-input "hello" | Select-String agentic-developer-companion
node .github/skills/agentic-developer-companion/scripts/adc.mjs doctor --json
```

Hook payloads are re-measured by `tests/unit/hooks.test.mjs` when the host CLIs are
installed; the manual OS × host matrix lives in `tests/manual-matrix.md`. Paid checks
(trigger sets, `claude plugin eval`) are listed in [release](release.md) §4.
