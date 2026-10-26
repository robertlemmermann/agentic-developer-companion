# Manual test matrix

Filled once per release tag. `node tests/selftest.mjs` covers the scripts and hook handlers on
the machine it runs on; this matrix covers what only a real host on a real OS shows:
installation, discovery, the model following the playbooks, and hooks fired by the host. Rows
are OS and launch path × host × step; columns are version, result and date. Steps S1-S5 use an
installed copy of the skill; `selftest` uses the checkout of the tag.

Contents: [How to fill it in](#how-to-fill-it-in) · [The steps](#the-steps) ·
[Sample repository](#sample-repository) · [Launch paths](#launch-paths) ·
[Results per launch path](#results-per-launch-path) · [Cloud surfaces](#cloud-surfaces) ·
[Linux container (automated)](#linux-container-automated)

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
- A tag is releasable when every row is `pass`, `n/a` or an accepted `manual`, including
  `failed: 0` in every `selftest` row
  ([release](../skills/agentic-developer-companion/references/release.md)).

## The steps

Replace `<adc>` with the `adc.mjs` of the copy you installed, for example
`.agents/skills/agentic-developer-companion/scripts/adc.mjs` (project scope) or
`~/.claude/skills/agentic-developer-companion/scripts/adc.mjs` (user scope).

| Step | Do | Pass when |
|---|---|---|
| S1 install | Install with the README command for the host (`gh skill install ...`; for VS Code the Copilot project command `--dir .github/skills`), then run `node <adc> doctor`. | The host lists the skill (`copilot skill list --json`, `/skills` in VS Code, `/agentic-developer-companion` completes in Claude Code, `codex debug prompt-input "hello"` names it) and `doctor` shows the copy under `install_paths`. |
| S2 help | In the host: `/agentic-developer-companion help` (Codex: `$agentic-developer-companion help`). | The answer shows the mode table and an absolute `adc.mjs` path that exists on this machine. |
| S3 verify | Create the [sample repository](#sample-repository) with its planted change, open the host there and ask `/agentic-developer-companion verify` (Codex: `$agentic-developer-companion verify`; grant `workspace-write`). Then restore the test (`git checkout -- test/sum.test.js`) and verify again. | First run: verdict `FAIL` with CK-SKIP (`test.only`) and CK-ASSERT (assertion removed) in `.adc/evidence/`. Second run: `PASS` or `PASS-WITH-FINDINGS`. `git status --porcelain` shows only the planted files both times. |
| S4 hooks | In the sample repo ask `/agentic-developer-companion setup hooks --scope user`, accept the write, restart the host (Codex: approve the hooks in `/hooks`). Ask the agent to add `it.only` to a test, then let the turn end. | The session brief appears at start, a post-edit warning names the focus marker, the stop notice appears once; no tool call is blocked; `node <adc> doctor` lists the registered hooks. Remove them afterwards with `node <adc> setup hooks --remove`. |
| S5 ACL (Windows) | `node <adc> doctor --init`, then `node <adc> doctor --json` and `icacls .adc\.env.live`. | `doctor` reports the credential file as owner-only (no warning) and `icacls` shows exactly one entry: your own account, no inherited `(I)` entries. |
| `selftest` | From the repository root of the tag's checkout, in the row's launch path: `node tests/selftest.mjs --json` (e.g. `pwsh -NoProfile -Command "node tests/selftest.mjs --json"`; cmd: `node tests\selftest.mjs --json`). `--jobs 3` runs the unit files in parallel; the latency check is meaningful only on an idle machine. | Exit 0 with `failed: 0`; every `skipped` case and its reason in Notes. Paid evals are printed, never run: run them by hand (`node tests/run-evals.mjs`, release §4). |

VS Code needs Chat Session Target = Copilot; Codex needs `workspace-write` for `verify`
([host notes](../skills/agentic-developer-companion/references/host-notes.md) §1).

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

## Launch paths

| Launch path | Setup |
|---|---|
| Win pwsh 7 | Windows 11: start each host from a `pwsh` 7 window; Copilot CLI and Codex launch hooks through PowerShell, so `pwsh` 7 must be on PATH. |
| Win PS 5.1 | Windows 11: start each host from `powershell.exe` with no `pwsh` on PATH (rename or remove it for this pass). Hook output must still be one ASCII JSON object; exit codes collapse to 0/1, harmlessly. |
| Win Git Bash | Windows 11: start each host from Git Bash (`C:\Program Files\Git\bin\bash.exe`); Claude Code's Bash tool uses it (set `CLAUDE_CODE_GIT_BASH_PATH` if it is not detected). |
| Win cmd | Windows 11: start each host from `cmd.exe`; run CLI steps with backslash paths (`node .agents\skills\agentic-developer-companion\scripts\adc.mjs ...`); create the sample repository with the PowerShell block (`powershell -NoProfile`). |
| macOS | Terminal (zsh); record the macOS version and the CPU (arm64 or x64) in Version. |
| Ubuntu | A VM or container with a desktop session for VS Code; record the release (e.g. 24.04) in Version. |

## Results per launch path

| Launch path | Host | Step | Version | Result | Date | Notes |
|---|---|---|---|---|---|---|
| Win pwsh 7 | — | selftest | — | not run | — | |
| Win pwsh 7 | Copilot CLI | S1 install | — | not run | — | |
| Win pwsh 7 | Copilot CLI | S2 help | — | not run | — | |
| Win pwsh 7 | Copilot CLI | S3 verify | — | not run | — | |
| Win pwsh 7 | Copilot CLI | S4 hooks | — | not run | — | |
| Win pwsh 7 | VS Code | S1 install | — | not run | — | |
| Win pwsh 7 | VS Code | S2 help | — | not run | — | |
| Win pwsh 7 | VS Code | S3 verify | — | not run | — | |
| Win pwsh 7 | VS Code | S4 hooks | — | not run | — | |
| Win pwsh 7 | Claude Code | S1 install | — | not run | — | |
| Win pwsh 7 | Claude Code | S2 help | — | not run | — | |
| Win pwsh 7 | Claude Code | S3 verify | — | not run | — | |
| Win pwsh 7 | Claude Code | S4 hooks | — | not run | — | |
| Win pwsh 7 | Codex | S1 install | — | not run | — | |
| Win pwsh 7 | Codex | S2 help | — | not run | — | |
| Win pwsh 7 | Codex | S3 verify | — | not run | — | |
| Win pwsh 7 | Codex | S4 hooks | — | not run | — | |
| Win pwsh 7 | any | S5 ACL | — | not run | — | |
| Win PS 5.1 | — | selftest | — | not run | — | |
| Win PS 5.1 | Copilot CLI | S1 install | — | not run | — | |
| Win PS 5.1 | Copilot CLI | S2 help | — | not run | — | |
| Win PS 5.1 | Copilot CLI | S3 verify | — | not run | — | |
| Win PS 5.1 | Copilot CLI | S4 hooks | — | not run | — | |
| Win PS 5.1 | VS Code | S1 install | — | not run | — | |
| Win PS 5.1 | VS Code | S2 help | — | not run | — | |
| Win PS 5.1 | VS Code | S3 verify | — | not run | — | |
| Win PS 5.1 | VS Code | S4 hooks | — | not run | — | |
| Win PS 5.1 | Claude Code | S1 install | — | not run | — | |
| Win PS 5.1 | Claude Code | S2 help | — | not run | — | |
| Win PS 5.1 | Claude Code | S3 verify | — | not run | — | |
| Win PS 5.1 | Claude Code | S4 hooks | — | not run | — | |
| Win PS 5.1 | Codex | S1 install | — | not run | — | |
| Win PS 5.1 | Codex | S2 help | — | not run | — | |
| Win PS 5.1 | Codex | S3 verify | — | not run | — | |
| Win PS 5.1 | Codex | S4 hooks | — | not run | — | |
| Win PS 5.1 | any | S5 ACL | — | not run | — | |
| Win Git Bash | — | selftest | — | not run | — | |
| Win Git Bash | Copilot CLI | S1 install | — | not run | — | |
| Win Git Bash | Copilot CLI | S2 help | — | not run | — | |
| Win Git Bash | Copilot CLI | S3 verify | — | not run | — | |
| Win Git Bash | Copilot CLI | S4 hooks | — | not run | — | |
| Win Git Bash | VS Code | S1 install | — | not run | — | |
| Win Git Bash | VS Code | S2 help | — | not run | — | |
| Win Git Bash | VS Code | S3 verify | — | not run | — | |
| Win Git Bash | VS Code | S4 hooks | — | not run | — | |
| Win Git Bash | Claude Code | S1 install | — | not run | — | |
| Win Git Bash | Claude Code | S2 help | — | not run | — | |
| Win Git Bash | Claude Code | S3 verify | — | not run | — | |
| Win Git Bash | Claude Code | S4 hooks | — | not run | — | |
| Win Git Bash | Codex | S1 install | — | not run | — | |
| Win Git Bash | Codex | S2 help | — | not run | — | |
| Win Git Bash | Codex | S3 verify | — | not run | — | |
| Win Git Bash | Codex | S4 hooks | — | not run | — | |
| Win Git Bash | any | S5 ACL | — | not run | — | |
| Win cmd | — | selftest | — | not run | — | |
| Win cmd | Copilot CLI | S1 install | — | not run | — | |
| Win cmd | Copilot CLI | S2 help | — | not run | — | |
| Win cmd | Copilot CLI | S3 verify | — | not run | — | |
| Win cmd | Copilot CLI | S4 hooks | — | not run | — | |
| Win cmd | VS Code | S1 install | — | not run | — | |
| Win cmd | VS Code | S2 help | — | not run | — | |
| Win cmd | VS Code | S3 verify | — | not run | — | |
| Win cmd | VS Code | S4 hooks | — | not run | — | |
| Win cmd | Claude Code | S1 install | — | not run | — | |
| Win cmd | Claude Code | S2 help | — | not run | — | |
| Win cmd | Claude Code | S3 verify | — | not run | — | |
| Win cmd | Claude Code | S4 hooks | — | not run | — | |
| Win cmd | Codex | S1 install | — | not run | — | |
| Win cmd | Codex | S2 help | — | not run | — | |
| Win cmd | Codex | S3 verify | — | not run | — | |
| Win cmd | Codex | S4 hooks | — | not run | — | |
| Win cmd | any | S5 ACL | — | not run | — | |
| macOS | — | selftest | — | not run | — | |
| macOS | Copilot CLI | S1 install | — | not run | — | |
| macOS | Copilot CLI | S2 help | — | not run | — | |
| macOS | Copilot CLI | S3 verify | — | not run | — | |
| macOS | Copilot CLI | S4 hooks | — | not run | — | |
| macOS | VS Code | S1 install | — | not run | — | |
| macOS | VS Code | S2 help | — | not run | — | |
| macOS | VS Code | S3 verify | — | not run | — | |
| macOS | VS Code | S4 hooks | — | not run | — | |
| macOS | Claude Code | S1 install | — | not run | — | |
| macOS | Claude Code | S2 help | — | not run | — | |
| macOS | Claude Code | S3 verify | — | not run | — | |
| macOS | Claude Code | S4 hooks | — | not run | — | |
| macOS | Codex | S1 install | — | not run | — | |
| macOS | Codex | S2 help | — | not run | — | |
| macOS | Codex | S3 verify | — | not run | — | |
| macOS | Codex | S4 hooks | — | not run | — | |
| Ubuntu | — | selftest | — | not run | — | |
| Ubuntu | Copilot CLI | S1 install | — | not run | — | |
| Ubuntu | Copilot CLI | S2 help | — | not run | — | |
| Ubuntu | Copilot CLI | S3 verify | — | not run | — | |
| Ubuntu | Copilot CLI | S4 hooks | — | not run | — | |
| Ubuntu | VS Code | S1 install | — | not run | — | |
| Ubuntu | VS Code | S2 help | — | not run | — | |
| Ubuntu | VS Code | S3 verify | — | not run | — | |
| Ubuntu | VS Code | S4 hooks | — | not run | — | |
| Ubuntu | Claude Code | S1 install | — | not run | — | |
| Ubuntu | Claude Code | S2 help | — | not run | — | |
| Ubuntu | Claude Code | S3 verify | — | not run | — | |
| Ubuntu | Claude Code | S4 hooks | — | not run | — | |
| Ubuntu | Codex | S1 install | — | not run | — | |
| Ubuntu | Codex | S2 help | — | not run | — | |
| Ubuntu | Codex | S3 verify | — | not run | — | |
| Ubuntu | Codex | S4 hooks | — | not run | — | |

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

Run in the build container without a person at a host. It does not replace the Ubuntu rows: no
VS Code and no signed-in Copilot or Codex session exist there.

**Environment**: Linux container (x64), Node 24.22.1, Git 2.43.0, PowerShell 7.5.4 (`pwsh`),
gh 2.99.0 at `/opt/ghnew/bin/gh` (side by side with gh 2.89.0 on PATH; selftest uses the first
`gh` at 2.90 or newer from `ADC_GH`, PATH and the known side-by-side locations), GitHub Copilot
CLI 1.0.103 and Codex CLI 0.164.0 (installed, not signed in), Claude Code 2.1.310 (signed in),
`skills-ref` (via `uv`). Not installed: gitleaks, waza, dotnet, VS Code.

Every command runs from the repository root of the checkout; `<adc>` is
`skills/agentic-developer-companion/scripts/adc.mjs` for the scripted rows and the installed
copy's `adc.mjs` for the host rows. Throwaway projects and host homes live under the OS temp dir
(`HOME`, `CLAUDE_CONFIG_DIR`, `COPILOT_HOME` and `CODEX_HOME` pointed there), so the run leaves
nothing in the real profile. Rows marked paid spend a few cents of the signed-in Claude account.

| Item | What runs | Version | Result | Date | Notes |
|---|---|---|---|---|---|
| selftest, all 16 areas | `node tests/selftest.mjs --jobs 3 --json` | Node 24.22.1, Git 2.43.0 | pass | 2026-10-26 | 66 direct checks pass, 0 fail; 1,032 unit tests pass, 2 skipped; skipped: gitleaks and waza (not installed), `claude plugin validate` (not applicable), Copilot/Codex listing (not applicable from the repo root), paid evals |
| Hook launch strings under sh and pwsh | part of selftest (`tests/unit/hooks.test.mjs`): the rendered Copilot `bash`/`powershell` strings, the Codex `command`/`commandWindows` and the Claude shell form, each fed the dialect fixtures; old, missing and crashing `node` fail open; a non-ASCII payload through `pwsh -NoProfile -Command` gives byte-identical stdout | pwsh 7.5.4 | pass | 2026-10-26 | 183 tests; Windows PowerShell 5.1 and cmd stay manual (Windows rows) |
| Frontmatter validators | part of selftest (`frontmatter` area): `skills-ref validate`, `gh skill publish --dry-run`, `claude plugin validate --strict --json` | skills-ref (uvx), gh 2.99.0, Claude Code 2.1.310 | pass | 2026-10-26 | `skills-ref validate`: valid; `gh skill publish --dry-run`: passes (only warning: no tag protection ruleset); `claude plugin validate`: not applicable to a bare skills folder (recorded as skipped) |
| `.adc/` handling and the leak matrix | part of selftest (`adc` area): tracked `.adc/` makes every state command exit 3 and every hook print `{}`; linked worktree, submodule and `.gitignore` negation cases; tokens from `.adc/.env.live` and the environment absent from diff-scope, doctor, hooks.log and verify output; `git status --porcelain` byte-identical around `verify` | Git 2.43.0 | pass | 2026-10-26 | selftest `adc` area: 16 commands exit 3 on a tracked `.adc/`, hooks print `{}`; no token in any output |
| S1 install, Claude Code | `gh skill install --from-local . agentic-developer-companion --agent claude-code` in a throwaway project, then `node <adc> doctor --json` | gh 2.99.0, Claude Code 2.1.310 | pass | 2026-10-26 | `doctor --json` lists the `.claude/skills/` copy; frontmatter rewritten by gh (sorted keys, `metadata.local-path`) |
| S1 install, Codex | `gh skill install --from-local . agentic-developer-companion --agent codex`, then `codex debug prompt-input "hello"` (lists discovered skills without sign-in) | gh 2.99.0, Codex 0.164.0 | pass | 2026-10-26 | lists the skill from `.agents/skills/` with its SKILL.md path |
| S1 install, Copilot CLI | `gh skill install --from-local . agentic-developer-companion --dir .github/skills`, then `copilot skill list --json` (works without sign-in) | gh 2.99.0, Copilot CLI 1.0.103 | pass | 2026-10-26 | lists the `.github/skills/` copy (source `project`) |
| S2 `help`, Claude Code (paid) | `claude -p "/agentic-developer-companion help"` in the throwaway project | Claude Code 2.1.310 | pass | 2026-10-26 | mode table plus the resolved absolute `adc.mjs` path; $0.07 |
| S3 `verify`, scripted | the [sample repository](#sample-repository), then `node <adc> verify --json`; restore `test/sum.test.js` and run it again | Node 24.22.1 | pass | 2026-10-26 | planted sample (deleted test, `test.skip`, weakened assertions, CI edits, AWS-shaped key, look-alike dependency, empty catch): `FAIL` naming each; clean sample: `PASS`; `git status --porcelain` unchanged |
| S3 `verify`, Claude Code (paid) | `claude -p "/agentic-developer-companion verify"` in the sample repository | Claude Code 2.1.310 | pass | 2026-10-26 | planted `FAIL` with every planted finding ($0.18), clean `PASS` ($0.14); ledgers finalized under `.adc/evidence/` |
| S4 hooks, scripted | `node <adc> setup hooks --host claude --scope project`, `--host copilot` and `--host codex` (print only), then the printed commands fed one payload per event through `sh -c` and `pwsh -NoProfile -Command` | pwsh 7.5.4 | pass | 2026-10-26 | covered by `tests/unit/hooks.test.mjs` and selftest `hooks` |
| S4 hooks, Claude Code (paid) | project-scope hooks written to `.claude/settings.json` of the sample repository, then `claude -p` (with `ADC_DEBUG=1`) asked to add `it.only` to a test | Claude Code 2.1.310 | pass | 2026-10-26 | project-scope hooks at `--level gate`: session brief injected; post-shell recorded the observed `npm test` run; the agent edited through `sed -i`/`cat >>` and the stop gate blocked once naming the `verify` command (shell-edit detection added after the first run missed it) |
| S5 credential file permissions (Linux) | `node <adc> doctor --init`, then `stat -c %a .adc/.env.live` and `node <adc> doctor --json` | Node 24.22.1 | pass | 2026-10-26 | `.adc/` 700, `.adc/.env.live` 600, no doctor warning |
| Paid evals (manual) | `node tests/run-evals.mjs` and `node <adc> tooling trigger-set skills/agentic-developer-companion --set evals/trigger-set.json --host claude --run --runs 3 --max-cost-usd 10` | Claude Code 2.1.310 | pass | 2026-10-26 | trigger set (20 queries × 3 runs): 0.85 before description tuning, 1.0 after (train 1.0, validation 1.0, $1.87); 8 fresh held-out queries × 2 runs: 0.875, no false triggers ($0.61). `node tests/run-evals.mjs`: both `claude plugin eval` cases 3/3, overall 1.0 ($0.86) |
