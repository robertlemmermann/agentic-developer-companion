# Manual test matrix

Filled once per release tag. The automated suite (`node tests/selftest.mjs`, run from the
repository root of a checkout of the tag) covers the scripts and hook handlers on the machine it
runs on; this matrix covers what only a real host on a real OS can show: installation, discovery,
the model following the playbooks, and hooks fired by the host itself. Rows are OS and launch
path x host x step; columns are the version, the result and the date.

The repository holds two kinds of material. The skill folder `skills/agentic-developer-companion/`
is what gets installed (`SKILL.md`, `PREREQUISITES.md`, `references/`, `scripts/`, `assets/`);
the development material stays at the repository root and is never installed: `tests/` (this
file, `selftest.mjs`, `unit/`, `fixtures/`, `snapshots/`), `evals/`, `README.md`, `CHANGELOG.md`,
`THIRD_PARTY_NOTICES.md`. The host steps (S1 to S5) use an installed copy; the selftest rows use
the checkout.

## Contents

1. [How to fill it in](#how-to-fill-it-in)
2. [The steps](#the-steps)
3. [Sample repository](#sample-repository)
4. [selftest per OS and launch path](#selftest-per-os-and-launch-path)
5. [Windows 11, PowerShell 7 (pwsh)](#windows-11-powershell-7-pwsh)
6. [Windows 11, Windows PowerShell 5.1](#windows-11-windows-powershell-51)
7. [Windows 11, Git Bash](#windows-11-git-bash)
8. [Windows 11, cmd](#windows-11-cmd)
9. [macOS](#macos)
10. [Ubuntu](#ubuntu)
11. [Cloud surfaces](#cloud-surfaces)
12. [Linux container (automated)](#linux-container-automated)

## How to fill it in

- **Machines**: one Windows 11 VM (PowerShell 7, Windows PowerShell 5.1, Git for Windows),
  one macOS machine, one Ubuntu VM or container. Start from a clean user profile, or remove
  every earlier copy that `doctor` lists before S1.
- **Version**: the host version (`copilot --version`, `code --version`, `claude --version`,
  `codex --version`) and the skill tag or short SHA, e.g. `1.0.103 / v0.1.0`.
- **Result**: `pass`, `fail` (link the issue in Notes), `n/a` (the combination does not exist),
  `manual` (observed by hand because an entitlement or an automation hook is missing; say what
  was observed), or `not run`. Leave `not run` rather than guessing.
- **Date**: the day the row was run, `YYYY-MM-DD`.
- A tag is releasable when every row is `pass`, `n/a` or an accepted `manual`, and the
  selftest table has `failed 0` on each OS
  ([release](../skills/agentic-developer-companion/references/release.md)).

## The steps

Replace `<adc>` with the `adc.mjs` of the copy you installed, for example
`.agents/skills/agentic-developer-companion/scripts/adc.mjs` (project scope) or
`~/.claude/skills/agentic-developer-companion/scripts/adc.mjs` (user scope).

| Step | Do | Pass when |
|---|---|---|
| S1 install | Install with the README command for the host (`gh skill install ...`; for VS Code the Copilot project command `--dir .github/skills`), then run `node <adc> doctor`. | The host lists the skill (`copilot skill list --json`, `/skills` in VS Code, `/agentic-developer-companion` completes in Claude Code, `codex debug prompt-input "hello"` names it) and `doctor` shows the copy under `install_paths`. |
| S2 `help` prints the resolved skill path | In the host: `/agentic-developer-companion help` (Codex: `$agentic-developer-companion help`). | The answer shows the mode table and an absolute `adc.mjs` path that exists on this machine. |
| S3 `verify` on the sample repo | Create the [sample repository](#sample-repository) with its planted change, open the host there and ask `/agentic-developer-companion verify` (Codex: `$agentic-developer-companion verify`; grant `workspace-write`). Then restore the test (`git checkout -- test/sum.test.js`) and verify again. | First run: verdict `FAIL` with CK-SKIP (`test.only`) and CK-ASSERT (assertion removed) in `.adc/evidence/`. Second run: `PASS` or `PASS-WITH-FINDINGS`. `git status --porcelain` shows only the planted files both times. |
| S4 `setup hooks` + one edit + one stop | In the sample repo ask `/agentic-developer-companion setup hooks --scope user`, accept the write, restart the host (Codex: approve the hooks in `/hooks`). Ask the agent to add `it.only` to a test, then let the turn end. | The session brief appears at start, a post-edit warning names the focus marker, the stop notice appears once; no tool call is blocked; `node <adc> doctor` lists the registered hooks. Remove them afterwards with `node <adc> setup hooks --remove`. |
| S5 `.adc/.env.live` ACL check (Windows) | `node <adc> doctor --init`, then `node <adc> doctor --json` and `icacls .adc\.env.live`. | `doctor` reports the credential file as owner-only (no warning) and `icacls` shows exactly one entry: your own account, no inherited `(I)` entries. |

VS Code needs Chat Session Target = Copilot for skills and hooks (hooks are Preview). Codex
runs `verify` only with `workspace-write` or an approved escalation; `deps-check` runs offline there.

## Sample repository

A tiny Node project (`node --test`, no dependencies) with a planted change that is left
uncommitted: a focused test whose assertion was removed, plus a source edit.

```bash
R="$(mktemp -d)/adc-sample" && mkdir -p "$R/src" "$R/test" && cd "$R" && git init -q -b main
printf '%s\n' '{"name":"adc-sample","private":true,"type":"module","scripts":{"test":"node --test"}}' > package.json
printf '%s\n' 'export const sum = (a, b) => a + b;' > src/sum.js
printf '%s\n' "import test from 'node:test';" "import assert from 'node:assert/strict';" "import { sum } from '../src/sum.js';" "test('adds', () => { assert.equal(sum(1, 2), 3); });" > test/sum.test.js
git add -A && git -c user.name=tester -c user.email=tester@example.invalid commit -qm init
printf '%s\n' 'export const sum = (a, b) => a + b + 0;' > src/sum.js
printf '%s\n' "import test from 'node:test';" "import { sum } from '../src/sum.js';" "test.only('adds', () => { sum(1, 2); });" > test/sum.test.js
```

```powershell
$R = Join-Path ([IO.Path]::GetTempPath()) "adc-sample-$(Get-Random)"; New-Item -ItemType Directory -Force "$R/src", "$R/test" | Out-Null; Set-Location $R; git init -q -b main
Set-Content -Encoding ascii package.json '{"name":"adc-sample","private":true,"type":"module","scripts":{"test":"node --test"}}'
Set-Content -Encoding ascii src/sum.js 'export const sum = (a, b) => a + b;'
Set-Content -Encoding ascii test/sum.test.js "import test from 'node:test';", "import assert from 'node:assert/strict';", "import { sum } from '../src/sum.js';", "test('adds', () => { assert.equal(sum(1, 2), 3); });"
git add -A; git -c user.name=tester -c user.email=tester@example.invalid commit -qm init
Set-Content -Encoding ascii src/sum.js 'export const sum = (a, b) => a + b + 0;'
Set-Content -Encoding ascii test/sum.test.js "import test from 'node:test';", "import { sum } from '../src/sum.js';", "test.only('adds', () => { sum(1, 2); });"
```

From cmd, create the repository with the PowerShell block (`powershell -NoProfile`), then
run the steps from cmd.

## selftest per OS and launch path

Check out the tag, `cd` to the repository root and run `node tests/selftest.mjs --json` from the
launch path named in the row (for example
`pwsh -NoProfile -Command "node tests/selftest.mjs --json"`; from cmd,
`node tests\selftest.mjs --json`). The skill has no `selftest` command: selftest and the unit
files are not installed with it. Add `--jobs 3` to run the unit files in parallel (the latency
check stays meaningful only on an otherwise idle machine). Pass when it exits 0 with
`failed: 0`; note every `skipped` case and why in Notes. The paid evals are printed by the
`evals` area and never run by selftest; run them by hand from the repository root
(`claude plugin eval . --eval-dir evals ...`, see release).

| OS and launch path | Step | Version | Result | Date | Notes |
|---|---|---|---|---|---|
| Windows 11, PowerShell 7 (`pwsh`) | `selftest` | — | not run | — | |
| Windows 11, Windows PowerShell 5.1 | `selftest` | — | not run | — | |
| Windows 11, Git Bash | `selftest` | — | not run | — | |
| Windows 11, cmd | `selftest` | — | not run | — | |
| macOS | `selftest` | — | not run | — | |
| Ubuntu | `selftest` | — | not run | — | |

## Windows 11, PowerShell 7 (`pwsh`)

Start each host from a `pwsh` 7 window. Copilot CLI and Codex launch hooks through PowerShell; use `pwsh` 7 on PATH.

| Host | Step | Version | Result | Date | Notes |
|---|---|---|---|---|---|
| Copilot CLI | S1 install | — | not run | — | |
| Copilot CLI | S2 `help` prints the resolved skill path | — | not run | — | |
| Copilot CLI | S3 `verify` on the sample repo | — | not run | — | |
| Copilot CLI | S4 `setup hooks` + one edit + one stop | — | not run | — | |
| VS Code (Session Target = Copilot) | S1 install | — | not run | — | |
| VS Code (Session Target = Copilot) | S2 `help` prints the resolved skill path | — | not run | — | |
| VS Code (Session Target = Copilot) | S3 `verify` on the sample repo | — | not run | — | |
| VS Code (Session Target = Copilot) | S4 `setup hooks` + one edit + one stop | — | not run | — | |
| Claude Code | S1 install | — | not run | — | |
| Claude Code | S2 `help` prints the resolved skill path | — | not run | — | |
| Claude Code | S3 `verify` on the sample repo | — | not run | — | |
| Claude Code | S4 `setup hooks` + one edit + one stop | — | not run | — | |
| Codex | S1 install | — | not run | — | |
| Codex | S2 `help` prints the resolved skill path | — | not run | — | |
| Codex | S3 `verify` on the sample repo | — | not run | — | |
| Codex | S4 `setup hooks` + one edit + one stop | — | not run | — | |
| any (run once per launch path) | S5 `.adc/.env.live` ACL check (`doctor`) | — | not run | — | |

## Windows 11, Windows PowerShell 5.1

Start each host from `powershell.exe` with no `pwsh` on PATH (rename or remove it from PATH for this pass). Hook output must still be one ASCII JSON object; exit codes collapse to 0/1 and that is harmless.

| Host | Step | Version | Result | Date | Notes |
|---|---|---|---|---|---|
| Copilot CLI | S1 install | — | not run | — | |
| Copilot CLI | S2 `help` prints the resolved skill path | — | not run | — | |
| Copilot CLI | S3 `verify` on the sample repo | — | not run | — | |
| Copilot CLI | S4 `setup hooks` + one edit + one stop | — | not run | — | |
| VS Code (Session Target = Copilot) | S1 install | — | not run | — | |
| VS Code (Session Target = Copilot) | S2 `help` prints the resolved skill path | — | not run | — | |
| VS Code (Session Target = Copilot) | S3 `verify` on the sample repo | — | not run | — | |
| VS Code (Session Target = Copilot) | S4 `setup hooks` + one edit + one stop | — | not run | — | |
| Claude Code | S1 install | — | not run | — | |
| Claude Code | S2 `help` prints the resolved skill path | — | not run | — | |
| Claude Code | S3 `verify` on the sample repo | — | not run | — | |
| Claude Code | S4 `setup hooks` + one edit + one stop | — | not run | — | |
| Codex | S1 install | — | not run | — | |
| Codex | S2 `help` prints the resolved skill path | — | not run | — | |
| Codex | S3 `verify` on the sample repo | — | not run | — | |
| Codex | S4 `setup hooks` + one edit + one stop | — | not run | — | |
| any (run once per launch path) | S5 `.adc/.env.live` ACL check (`doctor`) | — | not run | — | |

## Windows 11, Git Bash

Start each host from Git Bash (`C:\Program Files\Git\bin\bash.exe`). Claude Code's Bash tool uses Git Bash; set `CLAUDE_CODE_GIT_BASH_PATH` if it is not detected.

| Host | Step | Version | Result | Date | Notes |
|---|---|---|---|---|---|
| Copilot CLI | S1 install | — | not run | — | |
| Copilot CLI | S2 `help` prints the resolved skill path | — | not run | — | |
| Copilot CLI | S3 `verify` on the sample repo | — | not run | — | |
| Copilot CLI | S4 `setup hooks` + one edit + one stop | — | not run | — | |
| VS Code (Session Target = Copilot) | S1 install | — | not run | — | |
| VS Code (Session Target = Copilot) | S2 `help` prints the resolved skill path | — | not run | — | |
| VS Code (Session Target = Copilot) | S3 `verify` on the sample repo | — | not run | — | |
| VS Code (Session Target = Copilot) | S4 `setup hooks` + one edit + one stop | — | not run | — | |
| Claude Code | S1 install | — | not run | — | |
| Claude Code | S2 `help` prints the resolved skill path | — | not run | — | |
| Claude Code | S3 `verify` on the sample repo | — | not run | — | |
| Claude Code | S4 `setup hooks` + one edit + one stop | — | not run | — | |
| Codex | S1 install | — | not run | — | |
| Codex | S2 `help` prints the resolved skill path | — | not run | — | |
| Codex | S3 `verify` on the sample repo | — | not run | — | |
| Codex | S4 `setup hooks` + one edit + one stop | — | not run | — | |
| any (run once per launch path) | S5 `.adc/.env.live` ACL check (`doctor`) | — | not run | — | |

## Windows 11, cmd

Start each host from `cmd.exe`. Run the CLI steps with backslash paths (`node .agents\skills\agentic-developer-companion\scripts\adc.mjs ...`).

| Host | Step | Version | Result | Date | Notes |
|---|---|---|---|---|---|
| Copilot CLI | S1 install | — | not run | — | |
| Copilot CLI | S2 `help` prints the resolved skill path | — | not run | — | |
| Copilot CLI | S3 `verify` on the sample repo | — | not run | — | |
| Copilot CLI | S4 `setup hooks` + one edit + one stop | — | not run | — | |
| VS Code (Session Target = Copilot) | S1 install | — | not run | — | |
| VS Code (Session Target = Copilot) | S2 `help` prints the resolved skill path | — | not run | — | |
| VS Code (Session Target = Copilot) | S3 `verify` on the sample repo | — | not run | — | |
| VS Code (Session Target = Copilot) | S4 `setup hooks` + one edit + one stop | — | not run | — | |
| Claude Code | S1 install | — | not run | — | |
| Claude Code | S2 `help` prints the resolved skill path | — | not run | — | |
| Claude Code | S3 `verify` on the sample repo | — | not run | — | |
| Claude Code | S4 `setup hooks` + one edit + one stop | — | not run | — | |
| Codex | S1 install | — | not run | — | |
| Codex | S2 `help` prints the resolved skill path | — | not run | — | |
| Codex | S3 `verify` on the sample repo | — | not run | — | |
| Codex | S4 `setup hooks` + one edit + one stop | — | not run | — | |
| any (run once per launch path) | S5 `.adc/.env.live` ACL check (`doctor`) | — | not run | — | |

## macOS

Start each host from Terminal (zsh). Record the macOS version and the CPU (arm64 or x64) in the version column.

| Host | Step | Version | Result | Date | Notes |
|---|---|---|---|---|---|
| Copilot CLI | S1 install | — | not run | — | |
| Copilot CLI | S2 `help` prints the resolved skill path | — | not run | — | |
| Copilot CLI | S3 `verify` on the sample repo | — | not run | — | |
| Copilot CLI | S4 `setup hooks` + one edit + one stop | — | not run | — | |
| VS Code (Session Target = Copilot) | S1 install | — | not run | — | |
| VS Code (Session Target = Copilot) | S2 `help` prints the resolved skill path | — | not run | — | |
| VS Code (Session Target = Copilot) | S3 `verify` on the sample repo | — | not run | — | |
| VS Code (Session Target = Copilot) | S4 `setup hooks` + one edit + one stop | — | not run | — | |
| Claude Code | S1 install | — | not run | — | |
| Claude Code | S2 `help` prints the resolved skill path | — | not run | — | |
| Claude Code | S3 `verify` on the sample repo | — | not run | — | |
| Claude Code | S4 `setup hooks` + one edit + one stop | — | not run | — | |
| Codex | S1 install | — | not run | — | |
| Codex | S2 `help` prints the resolved skill path | — | not run | — | |
| Codex | S3 `verify` on the sample repo | — | not run | — | |
| Codex | S4 `setup hooks` + one edit + one stop | — | not run | — | |

## Ubuntu

An Ubuntu VM or container with a desktop session for VS Code. Record the release (e.g. 24.04) in the version column.

| Host | Step | Version | Result | Date | Notes |
|---|---|---|---|---|---|
| Copilot CLI | S1 install | — | not run | — | |
| Copilot CLI | S2 `help` prints the resolved skill path | — | not run | — | |
| Copilot CLI | S3 `verify` on the sample repo | — | not run | — | |
| Copilot CLI | S4 `setup hooks` + one edit + one stop | — | not run | — | |
| VS Code (Session Target = Copilot) | S1 install | — | not run | — | |
| VS Code (Session Target = Copilot) | S2 `help` prints the resolved skill path | — | not run | — | |
| VS Code (Session Target = Copilot) | S3 `verify` on the sample repo | — | not run | — | |
| VS Code (Session Target = Copilot) | S4 `setup hooks` + one edit + one stop | — | not run | — | |
| Claude Code | S1 install | — | not run | — | |
| Claude Code | S2 `help` prints the resolved skill path | — | not run | — | |
| Claude Code | S3 `verify` on the sample repo | — | not run | — | |
| Claude Code | S4 `setup hooks` + one edit + one stop | — | not run | — | |
| Codex | S1 install | — | not run | — | |
| Codex | S2 `help` prints the resolved skill path | — | not run | — | |
| Codex | S3 `verify` on the sample repo | — | not run | — | |
| Codex | S4 `setup hooks` + one edit + one stop | — | not run | — | |

## Cloud surfaces

No OS dimension: these run on GitHub. They need a test repository with Copilot cloud agent
and code review enabled; without the entitlement record `manual` or `n/a (no entitlement)`.

| Surface | Step | Version | Result | Date | Notes |
|---|---|---|---|---|---|
| Copilot cloud agent | an issue naming `verify` selects the skill by description | — | not run | — | |
| Copilot cloud agent | the agent's pull request contains no `.adc/` or companion files | — | not run | — | |
| Copilot cloud agent | `.github/hooks/` hooks from the default branch fire and never block | — | not run | — | |
| Copilot code review | a review on a pull request with a planted `it.only` uses the `.github/skills` copy | — | not run | — | |

## Linux container (automated)

What the integration run executes in the build container, without a person at a host. It
complements the Ubuntu rows above; it does not replace them, because no VS Code, no Windows
PowerShell 5.1 and no signed-in Copilot or Codex session exists there.

**Environment**: Linux container (x64), Node 24.22.1, Git 2.43.0, PowerShell 7.5.4 (`pwsh`),
gh 2.99.0 at `/opt/ghnew/bin/gh` (side by side with gh 2.89.0 on PATH; selftest uses the first
`gh` at 2.90 or newer from `ADC_GH`, PATH and the known side-by-side locations), GitHub Copilot CLI 1.0.103 and Codex CLI 0.164.0 (both installed, neither signed in), Claude
Code 2.1.310 (signed in), `skills-ref` (via `uv`). Not installed: gitleaks, waza, dotnet, VS Code.

Every command runs from the repository root of the checkout; `<adc>` is
`skills/agentic-developer-companion/scripts/adc.mjs` for the scripted rows and the installed
copy's `adc.mjs` for the host rows. Throwaway projects and host homes live under the OS temp dir
(`HOME`, `CLAUDE_CONFIG_DIR`, `COPILOT_HOME` and `CODEX_HOME` pointed there), so the run leaves
nothing in the real profile. Rows marked paid spend a few cents of the signed-in Claude account.

| Item | What runs | Version | Result | Date | Notes |
|---|---|---|---|---|---|
| selftest, all 16 areas | `node tests/selftest.mjs --jobs 3 --json` | Node 24.22.1, Git 2.43.0 | pass | 2026-10-26 | 66 direct checks pass, 0 fail; 1,032 unit tests pass, 2 skipped; skipped: gitleaks and waza (not installed), `claude plugin validate` (not applicable), Copilot/Codex listing (not applicable from the repo root), paid evals |
| Hook launch strings under sh and pwsh | part of selftest (`tests/unit/hooks.test.mjs`): the rendered Copilot `bash`/`powershell` strings, the Codex `command`/`commandWindows` and the Claude shell form, each fed the dialect fixtures; old, missing and crashing `node` fail open; a non-ASCII payload through `pwsh -NoProfile -Command` gives byte-identical stdout | pwsh 7.5.4 | pass | 2026-10-26 | covered by `tests/unit/hooks.test.mjs` (183 tests); Windows PowerShell 5.1 and cmd stay manual (Windows rows) |
| Frontmatter validators | part of selftest (`frontmatter` area): `skills-ref validate`, `gh skill publish --dry-run`, `claude plugin validate --strict --json` | skills-ref (uvx), gh 2.99.0, Claude Code 2.1.310 | pass | 2026-10-26 | `skills-ref validate`: valid; `gh skill publish --dry-run`: passes (only warning: no tag protection ruleset); `claude plugin validate`: not applicable to a bare skills folder (recorded as skipped) |
| `.adc/` handling and the leak matrix | part of selftest (`adc` area): tracked `.adc/` makes every state command exit 3 and every hook print `{}`; linked worktree, submodule and `.gitignore` negation cases; tokens from `.adc/.env.live` and the environment absent from diff-scope, doctor, hooks.log and verify output; `git status --porcelain` byte-identical around `verify` | Git 2.43.0 | pass | 2026-10-26 | selftest `adc` area: 16 commands exit 3 on a tracked `.adc/`, hooks print `{}`; no token in any output |
| S1 install, Claude Code | `gh skill install --from-local . agentic-developer-companion --agent claude-code` in a throwaway project, then `node <adc> doctor --json` | gh 2.99.0, Claude Code 2.1.310 | pass | 2026-10-26 | `gh skill install --from-local` into `.claude/skills/`; `doctor --json` lists the copy; frontmatter rewritten by gh (sorted keys, `metadata.local-path`) |
| S1 install, Codex | `gh skill install --from-local . agentic-developer-companion --agent codex`, then `codex debug prompt-input "hello"` (lists discovered skills without sign-in) | gh 2.99.0, Codex 0.164.0 | pass | 2026-10-26 | `codex debug prompt-input "hello"` lists the skill from `.agents/skills/` with its SKILL.md path |
| S1 install, Copilot CLI | `gh skill install --from-local . agentic-developer-companion --dir .github/skills`, then `copilot skill list --json` (works without sign-in) | gh 2.99.0, Copilot CLI 1.0.103 | pass | 2026-10-26 | `copilot skill list --json` lists the `.github/skills/` copy (source `project`) |
| S2 `help`, Claude Code (paid) | `claude -p "/agentic-developer-companion help"` in the throwaway project | Claude Code 2.1.310 | pass | 2026-10-26 | mode table plus the resolved absolute `adc.mjs` path; $0.07 |
| S3 `verify`, scripted | the [sample repository](#sample-repository), then `node <adc> verify --json`; restore `test/sum.test.js` and run it again | Node 24.22.1 | pass | 2026-10-26 | planted sample (deleted test, `test.skip`, weakened assertions, CI edits, AWS-shaped key, look-alike dependency, empty catch): `FAIL` naming each; clean sample: `PASS`; `git status --porcelain` unchanged |
| S3 `verify`, Claude Code (paid) | `claude -p "/agentic-developer-companion verify"` in the sample repository | Claude Code 2.1.310 | pass | 2026-10-26 | `claude -p "/agentic-developer-companion verify"`: planted `FAIL` with every planted finding ($0.18), clean `PASS` ($0.14); ledgers finalized under `.adc/evidence/` |
| S4 hooks, scripted | `node <adc> setup hooks --host claude --scope project`, `--host copilot` and `--host codex` (print only), then the printed commands fed one payload per event through `sh -c` and `pwsh -NoProfile -Command` | pwsh 7.5.4 | pass | 2026-10-26 | covered by `tests/unit/hooks.test.mjs` and selftest `hooks` |
| S4 hooks, Claude Code (paid) | project-scope hooks written to `.claude/settings.json` of the sample repository, then `claude -p` (with `ADC_DEBUG=1`) asked to add `it.only` to a test | Claude Code 2.1.310 | pass | 2026-10-26 | project-scope hooks at `--level gate`: session brief injected; post-shell recorded the observed `npm test` run; the agent edited through `sed -i`/`cat >>` and the stop gate blocked once naming the `verify` command (shell-edit detection added after the first run missed it) |
| S5 credential file permissions (Linux) | `node <adc> doctor --init`, then `stat -c %a .adc/.env.live` and `node <adc> doctor --json` | Node 24.22.1 | pass | 2026-10-26 | `.adc/` 700, `.adc/.env.live` 600, no doctor warning |
| Paid evals (manual) | `node tests/run-evals.mjs` and `node <adc> tooling trigger-set skills/agentic-developer-companion --set evals/trigger-set.json --host claude --run --runs 3 --max-cost-usd 10` | Claude Code 2.1.310 | pass | 2026-10-26 | trigger set (20 queries × 3 runs): 0.85 before description tuning, 1.0 after (train 1.0, validation 1.0, $1.87); 8 fresh held-out queries × 2 runs: 0.875, no false triggers ($0.61). `node tests/run-evals.mjs`: both `claude plugin eval` cases 3/3, overall 1.0 ($0.86) |
