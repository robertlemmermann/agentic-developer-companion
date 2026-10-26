# Manual test matrix

Filled once per release tag. The automated suite (`node <skill>/scripts/adc.mjs selftest`) covers
the scripts and hook handlers on the machine it runs on; this matrix covers what only a real
host on a real OS can show: installation, discovery, the model following the playbooks, and
hooks fired by the host itself. Rows are OS and launch path x host x step; columns are the
version, the result and the date.

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
  selftest table has `failed 0` on each OS ([release](../references/release.md)).

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

Run `node <skill>/scripts/adc.mjs selftest --json` from the launch path named in the row
(for example `pwsh -NoProfile -Command "node <skill>/scripts/adc.mjs selftest --json"`). Pass
when it exits 0 with `failed: 0`; note every `skipped` area and why in Notes.

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

<!-- Filled by the integrator from the automated container run: the tool versions, the
selftest summary (passed, failed, skipped per area) and which host steps were exercised
headless. -->

| Item | Version | Result | Date | Notes |
|---|---|---|---|---|
| `selftest` (all areas) | — | not run | — | |
| Host CLIs exercised headless | — | not run | — | |
