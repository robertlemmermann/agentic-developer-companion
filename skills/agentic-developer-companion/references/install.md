# Install, verify, update and register hooks

Long-form companion to the README install section. Every step names the script command and
its **manual fallback** (what to run by hand in guidance-only mode, when Node is missing).
The skill folder is `skills/agentic-developer-companion` in the public repository
`robertlemmermann/agentic-developer-companion`; below, `<skill>` is wherever it ends up.

## Contents

1. [Before you install](#1-before-you-install)
2. [Install matrix](#2-install-matrix)
3. [Verify the install](#3-verify-the-install)
4. [Update, pin, uninstall](#4-update-pin-uninstall)
5. [Register hooks (`setup hooks`)](#5-register-hooks-setup-hooks)
6. [Hook registration per host](#6-hook-registration-per-host)
7. [What the hooks write](#7-what-the-hooks-write)
8. [Overview diagrams (ASCII)](#8-overview-diagrams-ascii)
9. [Windows notes](#9-windows-notes)
10. [Troubleshooting](#10-troubleshooting)

## 1. Before you install

Git 2.31+, a supported host, and Node.js 24 for scripts and hooks; everything else is optional with a fallback, listed
in [PREREQUISITES.md](../PREREQUISITES.md). Without Node the skill still works in guidance-only mode (the playbooks
list the manual commands) and no hook can run.

## 2. Install matrix

| Host | Scope | Command | Lands in |
|---|---|---|---|
| Copilot, all surfaces incl. code review | project | `gh skill install robertlemmermann/agentic-developer-companion agentic-developer-companion --dir .github/skills` | `.github/skills/agentic-developer-companion/` |
| Copilot + Codex sharing one copy | project | `gh skill install robertlemmermann/agentic-developer-companion agentic-developer-companion` (plus the `--dir .github/skills` command for code review) | `.agents/skills/agentic-developer-companion/` |
| Copilot (CLI, VS Code, VS) | user | `gh skill install robertlemmermann/agentic-developer-companion agentic-developer-companion --scope user` | `~/.copilot/skills/agentic-developer-companion/` |
| Claude Code | project / user | `gh skill install robertlemmermann/agentic-developer-companion agentic-developer-companion --agent claude-code [--scope user]` | `.claude/skills/…` / `~/.claude/skills/…` |
| Codex | project / user | `gh skill install robertlemmermann/agentic-developer-companion agentic-developer-companion --agent codex [--scope user]` | `.agents/skills/…` / `~/.agents/skills/…` |
| Codex (inside Codex) | user | `$skill-installer install https://github.com/robertlemmermann/agentic-developer-companion/tree/main/skills/agentic-developer-companion` (needs a network escalation) | `~/.codex/skills/agentic-developer-companion/` |
| Any host, no `gh` | project or `-g` | `npx skills add robertlemmermann/agentic-developer-companion -a github-copilot -a claude-code -a codex --copy` | each host's directory |

Duplicates are harmless (first found wins by name). Copilot code review reads only
`.github/skills/`, so a Copilot repository should always have that copy.

**Copilot CLI without an installer** (registers a clone as a skill source, no copy):

```bash
git clone --depth 1 https://github.com/robertlemmermann/agentic-developer-companion "$HOME/.copilot/adc" && copilot skill add "$HOME/.copilot/adc/skills"
```

```powershell
git clone --depth 1 https://github.com/robertlemmermann/agentic-developer-companion "$env:USERPROFILE\.copilot\adc"; copilot skill add "$env:USERPROFILE\.copilot\adc\skills"
```

**Any host, plain clone plus copy** (replace the target with the host's user skill directory,
for example `~/.claude/skills`):

```bash
git clone --depth 1 https://github.com/robertlemmermann/agentic-developer-companion /tmp/adc && cp -R /tmp/adc/skills/agentic-developer-companion "$HOME/.claude/skills/"
```

```powershell
git clone --depth 1 https://github.com/robertlemmermann/agentic-developer-companion "$env:TEMP\adc"; Copy-Item -Recurse "$env:TEMP\adc\skills\agentic-developer-companion" "$env:USERPROFILE\.claude\skills\"
```

```bat
git clone --depth 1 https://github.com/robertlemmermann/agentic-developer-companion "%TEMP%\adc" && robocopy "%TEMP%\adc\skills\agentic-developer-companion" "%USERPROFILE%\.claude\skills\agentic-developer-companion" /E
```

A junction instead of a copy needs no admin rights and no Developer Mode:
PowerShell `New-Item -ItemType Junction -Path "$env:USERPROFILE\.claude\skills\agentic-developer-companion" -Target "<clone>\skills\agentic-developer-companion"`,
cmd `mklink /J "%USERPROFILE%\.claude\skills\agentic-developer-companion" "<clone>\skills\agentic-developer-companion"`.
Do not use symlinks: they need privileges on Windows and become text files in Git.

## 3. Verify the install

| Host | Check |
|---|---|
| Copilot CLI | `copilot skill list --json` lists `agentic-developer-companion` (works without signing in); `/skills info agentic-developer-companion` |
| VS Code | type `/` in chat and look for the skill; the Agent Debug panel lists loaded skills |
| Claude Code | `/agentic-developer-companion help`; frontmatter: `node <skill>/scripts/adc.mjs tooling lint <skill> --strict` (`claude plugin validate` does not check a bare skills folder: it reports `contents: []`) |
| Codex | the `/skills` picker shows it; `$agentic-developer-companion help`; `codex debug prompt-input "x"` prints the skill list without signing in |
| Everywhere | `node <skill>/scripts/adc.mjs doctor` |

`doctor` prints host, OS, Node and Git versions, every installed copy, the registered hooks
and launcher probes. **Manual fallback:** `node --version` (24+), `git --version` (2.31+),
then list the skill directories you use, for example
`ls -d .github/skills/* .agents/skills/* .claude/skills/* ~/.copilot/skills/* ~/.claude/skills/* ~/.agents/skills/* 2>/dev/null`
(PowerShell: `Get-ChildItem .github\skills, .agents\skills, $HOME\.copilot\skills -ErrorAction SilentlyContinue`).

`doctor` options (`node <skill>/scripts/adc.mjs doctor [options] --json`):

| Option | Effect |
|---|---|
| `--init` | creates `.adc/` owner-only, adds `/.adc/` to the repository's exclude file and writes `budget.json` and the `.env.live` template; refuses while `.adc/` is tracked; with `--dry-run` it lists what it would do |
| `--verify-vendored` | compares every copy in a project skill folder (`.github/skills/`, `.agents/skills/`, `.claude/skills/`) with its release, SKILL.md semantically (installers rewrite its frontmatter) |
| `--against <dir \| clone \| URL>` | the reference for `--verify-vendored`: a folder holding the skill, a Git clone or a repository URL (default: the upstream in the copy's install provenance, else its local source, else the copy running `doctor`) |
| `--ref <tag \| sha>` | the release to compare with; needs a clone or URL in `--against`, or provenance that names the upstream |
| `--no-probes` | skips the launcher probes (no host shell is started; faster) |
| `--session <id>` | reports the budget caps for that session instead of the newest open one |

Exit codes: 0 ok, 3 when `.adc/` is tracked by git (the report is still printed), and with
`--verify-vendored` 1 on drift and 4 when no vendored copy exists or none could be compared.
**Manual fallback** for `--init`:
`mkdir -p .adc && chmod 700 .adc && echo '/.adc/' >> "$(git rev-parse --git-path info/exclude)"`,
then copy `assets/templates/adc/budget.json` to `.adc/budget.json` and
`assets/templates/adc/env.live.example` to `.adc/.env.live` (`chmod 600`; on Windows
`icacls .adc\.env.live /inheritance:r /grant:r "%USERNAME%:(R,W)"`). For `--verify-vendored`:
`git diff --no-index --stat <release clone>/skills/agentic-developer-companion .github/skills/agentic-developer-companion`
(SKILL.md differs only in frontmatter after `gh skill install`).

## 4. Update, pin, uninstall

- **Pin**: `gh skill install … @v1.2.0`, `@<40-char sha>` or `--pin`. At work pin by tag **and** SHA.
- **Update**: `gh skill update --all`, `npx skills update`, `git pull` in a registered clone, or re-run the install.
- **Uninstall**: remove the hooks first (`node <skill>/scripts/adc.mjs setup hooks --remove`), then delete
  the skill directory under each host path that `doctor` lists; `npx skills remove agentic-developer-companion`
  where installed that way. Codex `$skill-installer` aborts when the target exists, so delete
  `~/.codex/skills/agentic-developer-companion` before reinstalling.
- The skill `name` never changes; renames would break installs.

## 5. Register hooks (`setup hooks`)

Hooks are optional, advisory by default, offline, and fail open: every handler prints one JSON object and exits 0, and
a missing Node yields `{}`. No host registers hooks from a skill, so registration is an explicit, confirmed step.

| Level | What it adds | When |
|---|---|---|
| `advise` (default) | session brief, post-edit notes, observed test runs, a notice when edits are newer than the last ledger (in Claude Code it reaches the agent, which continues once per edit epoch; Copilot drops `agentStop` context and Codex shows it to you only) | everyone |
| `gate` | blocks completion **once per edit epoch** until a ledger newer than the last edit exists; edits count from the host's edit tools and from file-writing shell commands (`sed -i`, redirects, `git apply`, package installs, formatters) | teams that require `verify` |
| `guard` | `gate` plus a pre-tool policy: denies force-push and history rewrites, `git add -f` of `.adc/` (by name, `.`, `-A` or a glob), commit/push while `.adc/` is tracked, host read/search/edit tools under `.adc/`, shell commands naming `.env.live` (or a glob under `.adc/` that matches it, or a recursive read or copy of `.adc/`); asks on CI edits and test deletions | high-trust repositories |

1. Render and show the config (prints only; default scope `user`, level `advise`):
   `node <skill>/scripts/adc.mjs setup hooks --host copilot|copilot-cloud|claude|codex [--scope user|project] [--level advise|gate|guard] --json`
   The output has `config`, `target_file`, `warnings`, `next_steps` and, for `guard`,
   `permission_rules` to add where the host supports them.
2. Ask the user. After a yes, add `--write`: the config is merged into `target_file`
   (other entries and keys are kept, a `<file>.adc-backup-<timestamp>` copy is made, and the
   registration is recorded in `.adc/hooks-installed.json`). `--dry-run --write` shows the
   merged file without writing. In CI or the Copilot cloud agent `--write` refuses and prints
   the config ("headless hosts: print only").
3. Follow `next_steps` (restart Copilot, `/hooks` in Claude or Codex).
4. Confirm: `node <skill>/scripts/adc.mjs hooks list --json` (or `doctor`). `matches_current: false`
   means the registered entries differ from what this copy would render now; re-run step 2.
5. Remove exactly what was added: `node <skill>/scripts/adc.mjs setup hooks --remove [--host h] [--scope s]`.
   Without a record it scans the host files for entries that run `adc.mjs hook-run`.
   **Manual fallback:** in the target file, delete every entry (Copilot) or handler (Claude,
   Codex) whose `bash`, `powershell`, `command`, `commandWindows` or `args` contain
   `adc.mjs` and `hook-run`; delete `~/.copilot/hooks/agentic-developer-companion.json` outright.

Options: `--node-path` renders the absolute path of the Node running the command (for Node from nvm, fnm, Volta or
asdf that the hook launcher's PATH does not see); `--node <path>` names one; `--skill-dir <dir>` renders for another
copy (for example a vendored one).

**Manual fallback** (no Node, or you prefer to edit by hand): copy the template from `assets/hooks/`
([copilot](../assets/hooks/copilot.hooks.json), [copilot cloud](../assets/hooks/copilot.cloud.hooks.json),
[claude](../assets/hooks/claude.settings.hooks.json), [codex](../assets/hooks/codex.hooks.json)), replace every
`<SKILL>` with the absolute skill path written with forward slashes
(`C:/Users/me/.copilot/skills/agentic-developer-companion` on Windows), delete the `preToolUse` / `PreToolUse` entries
unless you want `guard`, change `--level advise` on the stop entry to `gate` (or to `guard` when you keep the pre-tool
entries), and merge the `hooks` block into the target file below. Without Node the guarded Copilot strings print `{}`,
so nothing breaks, but nothing runs either.

## 6. Hook registration per host

| Host | `--scope user` target | `--scope project` target | Then |
|---|---|---|---|
| Copilot CLI / VS Code | `~/.copilot/hooks/agentic-developer-companion.json` (`$COPILOT_HOME/hooks/`) | `.github/hooks/agentic-developer-companion.json` | restart the CLI; VS Code: Session Target = Copilot; `/env` lists loaded hooks |
| Copilot cloud agent (`--host copilot-cloud`) | — | `.github/hooks/agentic-developer-companion.json`, repo-relative paths | commit it with the vendored skill to the default branch |
| Claude Code | `~/.claude/settings.json` (`$CLAUDE_CONFIG_DIR`), exec form | `.claude/settings.local.json`, shell strings, `--dialect auto` | `/hooks` shows them; settings-file hooks wait for workspace trust |
| Codex | `~/.codex/hooks.json` (`$CODEX_HOME`) | `.codex/hooks.json` (project must be trusted) | approve each new hook once in `/hooks` |

**Copilot (CLI, VS Code, Copilot app).** Each entry has a `bash` and a `powershell` string, never `command` (it would
be copied to both shells). The strings check for Node and print `{}` otherwise, because a failing `preToolUse` hook
denies the tool call. Repository hooks (`.github/hooks/`, `.claude/settings*.json`) load only in a trusted folder; in
`copilot -p` that means `--trust-folder`, `COPILOT_ALLOW_ALL=true` or `GITHUB_COPILOT_PROMPT_MODE_REPO_HOOKS=true`
(`--allow-all` alone does not trust the folder). User hooks in `~/.copilot/hooks/` need no trust. A project file that
names a skill outside the repository carries your machine's path: do not commit it (the render warns). `ask` decisions
are denials in `-p` ("unable to ask user for confirmation"), in autopilot and in the cloud agent.

**Copilot cloud agent.** Only `.github/hooks/*.json` on the default branch is read, only the `bash` strings run
(Linux), and `ask` is treated as deny. Vendor the skill first (`.github/skills/agentic-developer-companion/` or
`.agents/skills/…`) and protect `.github/hooks/**` and the vendored folder with CODEOWNERS and branch protection:
those files run on every colleague's machine that opens the repository with Copilot.

**Claude Code.** User scope uses the exec form (`"command": "node", "args": ["<SKILL>/scripts/adc.mjs", "hook-run", …]`),
which needs no shell and no Git Bash on Windows. Project scope is written to
`.claude/settings.local.json` (git-excluded) as single shell strings with `--dialect auto`,
because Copilot also reads that file in a trusted folder and starts exec-form handlers
without their `args` (measured: the handler fails, and a failing `preToolUse` would deny every
tool call). Copilot does not read `~/.claude/settings.json`. At user scope the guard's Bash
handlers use `"if": "Bash(git *)"` (it also matches `cd x && git push -f`), `"if": "Bash(*.adc*)"`
(`cat .adc/.env.live`), `"if": "Bash(*.env.live*)"` (`cat .env.live` after `cd .adc`; Claude's
Bash keeps its working directory) and `"if": "Bash(rm *)"` (test deletions), so other shell
commands never start it. Copilot ignores `if` (measured), so at project scope these become one
handler that runs for every Bash call. Claude's Windows `PowerShell` tool (used when Git Bash is
absent) has its own entry; `Read`, `Grep`, `Glob` and the edit tools are covered by a further
matcher. Under `claude -p` an `ask` cannot be answered: the call does not run. Add the printed
`permissions.deny` rules (`Read(./.adc/**)`, `Edit(./.adc/**)`) for a second layer.

**Codex.** `command` and `commandWindows` are the same bare `node "<SKILL>/scripts/adc.mjs" hook-run …` string, valid
under cmd.exe, Windows PowerShell and pwsh. Codex rejects unknown output fields, so the handler sends only documented
keys (the stop notice is a `systemMessage`). The edit matcher is `apply_patch|Write|Edit`; Codex reads files through
`Bash`, which is why the guard inspects shell arguments. New hooks run only after review in `/hooks` (or for one run
with `codex exec --dangerously-bypass-hook-trust`, meant for automation that vets its hooks). Under `codex exec` with
approvals off an `ask` lets the call run; only `deny` stops it.

**Measured payloads** (2026-10-25: Copilot CLI 1.0.103, Claude Code 2.1.310, Codex 0.164.0,
each driven offline by a scripted model endpoint; the source repository's `tests/unit/hooks.test.mjs`
repeats this when the CLIs are installed):

| Host | What the hooks receive and how output arrives |
|---|---|
| Copilot CLI | `toolArgs` is an object (`create` `{path, file_text}`, `edit` `{path, old_str, new_str}`, `bash` `{command}`, `view` `{path}`, `grep`/`rg`/`glob` `{pattern, paths}` with `paths` a string or an array) and the raw patch string for `apply_patch` (GPT-5 tool set), with absolute paths; shell results end with `<shellId: N completed with exit code X>`; `agentStop` has `transcriptPath` (JSONL `assistant.message` events) but no last message; hooks get `COPILOT_CLI=1`, `COPILOT_PROJECT_DIR`, `CLAUDE_PROJECT_DIR`; PascalCase entries get snake_case payloads that keep Copilot's argument names; context is appended to the tool result, `modifiedResult` replaces it, a stop block becomes a user message |
| Claude Code | `tool_input.file_path`/`content`/`new_string`, `tool_response` objects (`Bash`: `stdout`, `stderr`, `interrupted`); `MultiEdit` is not a tool any more (kept in the matcher, harmless); context arrives as system messages, denials as `PreToolUse:<Tool> hook error: <reason>`, a stop block as `Stop hook feedback` |
| Codex | `apply_patch` has `tool_input.command` (patch text, relative paths); shell calls arrive as `Bash` with `tool_input.command`; `tool_response` is a string; `permission_mode` is `bypassPermissions` under `codex exec`; context arrives as developer messages, a stop block as a `<hook_prompt>` user message; SessionEnd timeouts above 3 s are clamped |

## 7. What the hooks write

Hooks read `.adc/detect.json`, the newest ledger in `.adc/evidence/` and their session file, and write
`.adc/sessions/<id>.json` (edit counts and classes, observed runs as a command head plus counts, gate and guard
bookkeeping, the ended flag). The state directory is created the first time there is something to record, after
`/.adc/` is added to `.git/info/exclude`. `hooks.log` holds metadata only (event, tool, key names, sizes, timings;
with `ADC_DEBUG=1` for every call), never payload bodies. On Copilot the post-shell hook rewrites a shell result that
shows the live-test token (`ADC_LIVE_TOKEN=…`, its JSON/YAML form, a `Get-ChildItem Env:` row, or the literal value of
`ADC_LIVE_TOKEN` or another `ADC_LIVE_*` credential exported into the session) before the model sees it; Claude Code
and Codex rely on the guard denials. While `.adc/` is tracked by git the session brief says so and every other hook
prints `{}` and writes nothing; the guard still denies commit and push. `ADC_HOME` or `--state-dir` relocate the
directory.

## 8. Overview diagrams (ASCII)

Fallback for the two Mermaid diagrams in the README.

```
  request  -->  mode router  -->  scripts (adc.mjs)  -->  evidence ledger  -->  verdict
  /agentic-developer-companion verify    detect, diff-scope,    .adc/evidence/        PASS
  $agentic-developer-companion verify    deps-check, typecheck, <ts>-<digest>.json    PASS-WITH-FINDINGS
  cloud agent: chosen by description     clean-run, coverage,   (+ .md rendering)     FAIL
                                         mutation, flake, trace                       UNVERIFIED
      ^                                                                  |
      +------ hooks (optional): session brief, post-edit notes, stop gate +
```

```
                      one skill: skills/agentic-developer-companion/
        +-----------------------------+---------------------------+--------------------------+
        |                             |                           |
  GitHub Copilot                 Claude Code                 OpenAI Codex
  skills: .github/skills/        skills: .claude/skills/     skills: .agents/skills/
          (all surfaces, review)         ~/.claude/skills/           ~/.agents/skills/
          .agents/skills/                                            ~/.codex/skills/
          (CLI, VS Code, cloud)                                      ($skill-installer)
          ~/.copilot/skills/
  hooks:  ~/.copilot/hooks/      hooks: ~/.claude/settings.json  hooks: ~/.codex/hooks.json
          .github/hooks/ (cloud)        .claude/settings.local.json     .codex/hooks.json
```

## 9. Windows notes

- Copilot CLI runs the `powershell` strings under PowerShell: install PowerShell 7
  (`winget install Microsoft.PowerShell`); Windows PowerShell 5.1 works as a fallback.
  Codex runs `commandWindows` through `%COMSPEC% /C` per its source (a PowerShell session shell
  is also reported); the bare `node "<SKILL>/…"` form is valid in both, so keep Node on the
  plain PATH.
- Hook output is ASCII-only JSON, so console code pages cannot damage it; the handler always
  exits 0 (PowerShell `-Command` collapses other exit codes, Codex issue #54072).
- `node.exe` must be a real executable on the launcher's PATH. Version managers that expose
  `node` as a `.cmd` shim or only through a shell profile need `setup hooks --node-path`.
  A Node path with spaces (`C:\Program Files\nodejs\node.exe`) is rendered for Codex and for
  Claude project scope as its 8.3 short path (`C:\PROGRA~1\nodejs\node.exe`), which runs bare
  under cmd.exe, PowerShell and Git Bash; on a volume without short names Codex gets
  `& "<node>" …` (PowerShell only) and the render warns.
- Claude Code exec-form hooks need no Git Bash; set `CLAUDE_CODE_GIT_BASH_PATH` only for
  Claude's own Bash tool.
- Codex hooks on native Windows were disabled in 0.117 and their re-enablement is
  undocumented: confirm with `/hooks` that they fire.
- Paths are rendered with forward slashes, which Node, PowerShell and cmd.exe all accept.
- Junctions, not symlinks: no Developer Mode needed.
- `.adc/.env.live` is restricted to your SID with `icacls`; `doctor` checks it.

## 10. Troubleshooting

| Symptom | Check | Fix |
|---|---|---|
| A hook never fires | `doctor` launcher probes; Copilot `/env`; Claude and Codex `/hooks` | restart the host; approve in `/hooks`; `--node-path` when Node is only on a profile PATH |
| Hook output ignored | run the rendered string by hand with a payload (below) | profile output before the JSON (guard `echo` lines in `~/.bashrc` with `[[ $- == *i* ]]`) |
| The gate keeps blocking | `.adc/sessions/<id>.json` → `edits.last`; newest ledger time | run `verify`; the gate blocks once per edit epoch and never when `stop_hook_active` is set |
| Guard denied something intended | the reason names the rule | do it outside the agent, or register `--level gate` |
| `matches_current: false` | `hooks list --json` | re-run `setup hooks … --write` from the copy you use |

Test a rendered entry by hand (bash, then PowerShell):

```bash
printf '%s' '{"sessionId":"t","cwd":"'"$PWD"'","source":"startup"}' | node "<skill>/scripts/adc.mjs" hook-run session-start --dialect copilot
```

```powershell
'{"sessionId":"t","source":"startup"}' | node "<skill>/scripts/adc.mjs" hook-run session-start --dialect copilot; "exit $LASTEXITCODE"
```

Expect exactly one line of JSON and exit 0. `ADC_DEBUG=1` adds diagnostics on stderr and in
`.adc/hooks.log`.
