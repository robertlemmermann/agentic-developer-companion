# Prerequisites

What the skill needs, what it uses when present, and the fallback when something is missing.
`node <skill-dir>/scripts/adc.mjs doctor` prints every item as present, missing or old with
the fallback in effect; its source is [`assets/prerequisites.json`](assets/prerequisites.json).

## 1. Required

| Prerequisite | Minimum | Needed for | Without it |
|---|---|---|---|
| Git on PATH | 2.31 | working-tree snapshots, temp worktrees, base resolution, every diff-scoped check, hook identity | `adc.mjs` exits 3; QA modes cannot run; hooks emit `{}` |
| Node.js on PATH | 24 | every script, every hook, the evidence ledger, `doctor` | guidance-only mode: the model follows the manual steps in `references/*.md` and says so in the ledger it writes by hand; hooks print `{}` (Copilot) or fail non-blocking (Claude, Codex) |
| A supported host with the skill installed in a directory it scans | see Host minimums | invocation, discovery, hooks | nothing loads; pasting `SKILL.md` into the conversation (guidance-only) is the last resort |
| Permission to run `node` and `git` through the host's shell tool | — | every script invocation (no `allowed-tools` is shipped) | a denied call leaves the step `UNVERIFIED`; headless runs need explicit grants |
| A writable, git-excluded state directory (`.adc/`) | — | state, evidence, hook records, live credentials and the budget ledger | CLI commands exit 3 while `.adc/` is tracked by git; hooks keep emitting `{}`; relocate with `ADC_HOME` or `--state-dir` |
| A writable OS temp directory | — | clean-run and typecheck worktrees | clean runs cannot start (`UNVERIFIED`) |
| For QA modes: a Git repository with a resolvable base and enough history | — | `verify`, `audit-tests`, `trace`, `clean-run` | base chain `--base` > `origin/HEAD` > `main`/`master`/`init.defaultBranch` > `HEAD`; shallow clones get "run `git fetch --unshallow`" (exit 4) |

## 2. Optional, with the fallback the skill applies

### Runtime and hooks

| Prerequisite | Minimum | Used for | Fallback |
|---|---|---|---|
| Node reachable by the host's hook launcher | — | hooks firing at all | `setup hooks --node-path` renders the absolute Node path; `doctor` probes every launcher and reports a dead hook instead of hiding it |
| Hooks registered via `setup hooks` | — | session brief, post-edit warnings, observed runs, completion notice or gate | every mode works without hooks; the ledger is the source of truth |

### Live tests

| Prerequisite | Minimum | Used for | Fallback |
|---|---|---|---|
| `ADC_LIVE_TOKEN` in `.adc/.env.live` or the environment | — | the `live` mode's probes | live probes refuse to run (`UNVERIFIED: ADC_LIVE_TOKEN unset`); every other mode is unaffected |
| `.adc/budget.json` (budget ledger) | — | spend cap for live probes (2,500 credits per session and per day by default) | materialized from the shipped template on first use; without registered hooks every run is its own session, so only the daily cap spans runs |
| `ADC_DEBUG=1` | — | verbose `hooks.log` (metadata only, never payload bodies) | terse logging |

### Installation

| Prerequisite | Minimum | Used for | Fallback |
|---|---|---|---|
| GitHub CLI (`gh skill`, public preview) | 2.90.0 | primary install, pinning, updates | `npx skills add ... --copy`; `copilot skill add <clone>/skills`; Codex `$skill-installer`; `git clone --depth 1` plus copy or junction |
| Vercel `skills` CLI (`npx skills`, Node 22.20+) | — | multi-host install without `gh` | any other install path |
| Codex `$skill-installer` | — | install from inside Codex (runs a Python script; needs a network escalation in the sandbox) | `gh skill install ... --agent codex`; clone and copy into `~/.agents/skills/` |
| Copilot `copilot skill add <dir>` or `skillDirectories` | — | registering a raw clone | copy the folder into `~/.copilot/skills/` |
| Network access to github.com at install and update time | — | all remote install paths | vendor the skill into the work repo (pinned to tag + SHA) or copy it by hand; the cloud agent clones it in `copilot-setup-steps.yml` |

### QA checks

| Prerequisite | Minimum | Used for | Fallback |
|---|---|---|---|
| gitleaks or trufflehog | — | CK-SECRETS, `ci-gate` secret step | built-in secret regexes on the snapshot including untracked files (findings still FAIL; more false positives) |
| diff-cover (Python) | — | CK-COVERAGE, `ci-gate` changed-line gate | built-in diff mapping for coverage XML/LCOV, Jest/Vitest JSON, go cover, coverlet; file-level results labeled approximate; coverage stays a soft check |
| StrykerJS, Stryker.NET, cargo-mutants, mutmut (POSIX only) | — | CK-MUTATION (`--deep`) | skipped and recorded in the ledger; verdict unaffected |
| pytest-randomly + pytest-repeat, jest-circus (`--randomize`), Go 1.17+ (`-shuffle`), cargo-nextest | — | shuffled flake probes, retries off | N sequential runs with `shuffle: false`; plain `cargo test` parser; `retries_disabled: unknown` recorded |
| Lint-side detectors (eslint-plugin-jest, Vitest `allowOnly`, pytest `-rs`, ESLint unused-directive reports, ruff `RUF100`, mypy `warn_unused_ignores`) | — | extra CK-SKIP / CK-SUPPRESS / CK-SWALLOW signals | built-in anchored regexes on added lines with the base-tree ratchet |
| Package-registry access (`npm view`, `pip index versions`, `cargo info`, `go list -m`) | — | CK-DEPS existence of new packages | offline-first: lockfile, then cached registry metadata; `--offline` is the default under Codex |
| A host fresh-context reviewer (Claude subagent, Copilot `/review` or a custom agent, `codex review`) | — | CK-REVIEW | the model opens a new conversation with `references/review.md`; unconfirmed criticals never fail the verdict |
| Host security reviewers (`/security-review`, `claude-security`, Copilot code review) | — | FM-10 insecure code | none: FM-10 stays uncovered and the ledger says so |

### Test engineering

| Prerequisite | Minimum | Used for | Fallback |
|---|---|---|---|
| Playwright (with browsers), Playwright MCP, `npx playwright init-agents` | — | `e2e web` scaffold and hardening | templates rendered without the agents or MCP; browsers installed by the scaffold's documented step |
| Schemathesis, Pact | — | `e2e api` extras | omitted when there is no OpenAPI document or no second service |
| Snapshot and approval libraries, HTTP mocks and fake timers | — | `regress` characterization, `flake` fixes | runner-native snapshots or golden files; fix patterns are recommended, not installed |
| GitHub Actions (`dorny/paths-filter`, a JUnit reporter action, `actions/setup-node` pinned to 24) | — | `ci-gate` and `live` templates | GitHub Actions first; notes only for GitLab CI and Azure Pipelines |
| Dependency audit tools (`npm audit`, `pip-audit`, `cargo audit`, `dotnet list package --vulnerable`) | — | `ci-gate` audit step | non-blocking by default; omitted for stacks without a tool |

### Tooling development

| Prerequisite | Minimum | Used for | Fallback |
|---|---|---|---|
| External validators (`skills-ref validate`, `claude plugin validate`, `gh skill publish --dry-run`, `copilot skill list --json`, `codex exec --strict-config`, `waza`) | — | merged into `tooling lint` | the built-in Node validator always runs; external results are merged only when the tool is installed |
| `claude plugin eval`, promptfoo, Waza, a headless host CLI on PATH | — | `tooling eval`, `tooling trigger-set`, the skill's own evals | the trigger set is generated without a runner; evals are marked manual and paid |
| Claude `/skill-doctor`, `/doctor prompt-audit`, `claude --debug`; Copilot `/env`, `/skills info` | — | diagnostics referenced by `tooling optimize` and host notes | `doctor` and `tooling cost` are the skill's own equivalents |

### At work

| Prerequisite | Minimum | Used for | Fallback |
|---|---|---|---|
| `.github/workflows/copilot-setup-steps.yml` | — | cloning the skill for the cloud agent outside the Bash-tool firewall | vendor the skill into the repo |
| CODEOWNERS and branch protection on `.github/hooks/**` and vendored skill directories | — | containment for vendored installs | none; a recommendation, not a mechanism |

## 3. Host minimums

| Host | Minimum | Unlocks | Fallback |
|---|---|---|---|
| Copilot CLI | 1.0.88 | skills, hooks, `copilot skill list --json` (namespaced skills, `copilot skill add`; `exec` hooks documented 1.0.97) | another host, or guidance-only mode |
| VS Code | 1.109 | skills (GA in 1.109), hooks (Preview; Session Target = Copilot) | another host, or guidance-only mode |
| Claude Code | 2.1.269 | `claude plugin eval` (2.1.269+); hook `onFailure` (2.1.295+); direct `AGENTS.md` reading (2.1.277+) | older versions run the skill and hooks; evals are marked manual |
| Codex | 0.124.0 | hooks (stable in 0.124.0), skills; `/presets` from 0.164.0 | older versions run the skill without hooks |

- Trust and permission conditions per host: [host notes](references/host-notes.md) §1;
  hook registration under folder or project trust: [install](references/install.md) §6.
- Enterprise plugin-only policies (VS Code `ChatStrictPluginOnlyCustomization`, Claude
  `strictPluginOnlyCustomization`) block standalone skills, and this skill ships no plugin
  wrapper: ask for an admin exception or use guidance-only mode.
- Open host questions: [host notes](references/host-notes.md) §9.

## 4. Windows

| Prerequisite | Minimum | Used for | Fallback |
|---|---|---|---|
| PowerShell 7 (`pwsh`) | 7.0 | Copilot CLI and Codex hooks on Windows | Windows PowerShell 5.1 (collapses exit codes and re-encodes stdout; harmless because decisions are ASCII JSON on exit 0) |
| Git for Windows (Git Bash) for Claude Code | — | Claude Code's Bash tool on Windows | Claude's PowerShell tool; `CLAUDE_CODE_GIT_BASH_PATH` when Git Bash is not auto-detected; exec-form hooks need no Git Bash |
| `core.longpaths` for deep temp worktrees | — | clean-run worktrees with long paths | a clear `UNVERIFIED` reason instead of a path-length failure |
| WSL2 | — | Claude shell-granting evals and mutmut | run those on macOS or Linux; everything else is native |

`node.exe` must be on the launcher's PATH (else `setup hooks --node-path`); junctions replace
symlinks (no Developer Mode); confirm Codex hooks on native Windows in `/hooks`; `doctor`
checks the `icacls` ACL on `.adc/.env.live`. Details: [install](references/install.md) §9.

## 5. Your project's toolchain (detected, never installed by the skill)

`detect` finds the runtime, the package manager with its committed lockfile, the test runner,
type checker, coverage producer and linters.

- Missing test runner → the skill asks for the test command (headless: `UNVERIFIED`).
- No detectable type checker → CK-TYPES is `skipped`; the verdict is unaffected.
- No coverage producer → CK-COVERAGE is `skipped`.
- A lockfile mismatch is a `FAIL`, not a fallback.

## 6. Explicit non-prerequisites

No npm or pip dependencies, no network calls from hooks, no telemetry or accounts, no
Developer Mode, no `allowed-tools` grant, no `agents/openai.yaml`, no plugin manifests, no
`jq`, no shellcheck or PSScriptAnalyzer at run time.
