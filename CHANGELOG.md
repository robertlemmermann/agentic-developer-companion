# Changelog

All notable changes to the `agentic-developer-companion` skill. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). The top entry always equals
`metadata.version` in [SKILL.md](SKILL.md) and the Git tag `v<version>`
([release checklist](references/release.md)).

## [0.1.0] - 2026-10-25

First public release: both jobs of the skill (QA of agent-made changes, development of
agentic tooling) for GitHub Copilot, Claude Code and OpenAI Codex on Windows, macOS and
Linux, with a zero-dependency Node 24 runtime.

### Added

**Skill and repository**

- `skills/agentic-developer-companion/` with the six-field Agent Skills frontmatter (`name`,
  `description`, `license: Apache-2.0`, `compatibility`, `metadata.version`,
  `metadata.short-description`), a mode router that reads "the text after the skill name"
  (no host substitutions), the "locate the companion" search for `scripts/adc.mjs` in bash
  and PowerShell, operating principles, host notes and safety rules.
- `PREREQUISITES.md` and its machine-readable twin `assets/prerequisites.json`: required
  and optional prerequisites, each optional item with its fallback, host minimums, Windows
  notes, explicit non-prerequisites.
- Root `README.md` (install matrix with bash, PowerShell and cmd variants, invocation cheat
  sheet, hooks, the `.adc/` directory, the evidence ledger, use at work, security policy) and
  the Apache-2.0 `LICENSE`; `.gitattributes` enforcing LF inside the skill.
- `scripts/adc.mjs`, the single CLI entry point: Node version guard (exit 3, or `{}` for
  hooks), one ASCII-only JSON document per command, exit codes 0/1/2/3/4, global options
  `--json --cwd --state-dir --dry-run --yes`.

**QA of agent-made changes**

- Working-tree snapshot through a temporary index (uncommitted and untracked files
  included, the user's index, stash and working tree untouched); `.adc/` always excluded.
- `detect`: monorepo-aware projects, package managers with frozen installs, test runners
  (Node test runner, Jest, Vitest, Mocha, Playwright, Cypress, Bun, pytest, unittest, Go,
  cargo, nextest, .NET, Maven, Gradle, RSpec, Minitest, Make and just targets, package
  scripts, CI-learned commands) with report and retries-off flags, test globs, type
  checkers, linters, CI system and default branch; cached in `.adc/detect.json`.
- `diff-scope`: CK-SCOPE, CK-TEST-DEL (deleted or renamed test files and deleted test cases
  inside a file), CK-SKIP, CK-ASSERT, CK-TEST-CFG, CK-SUPPRESS (with a ratchet against the
  base), CK-CI, CK-SWALLOW, CK-SECRETS (gitleaks or trufflehog when installed, built-in
  patterns otherwise), CK-LOCK (static) and CK-RETRY.
- `deps-check` (CK-DEPS, CK-LOCK): new dependencies verified offline-first against
  lockfiles, local caches and registries, look-alike names, lockfile consistency;
  `--offline` by default in the Codex sandbox.
- `typecheck` (CK-TYPES): new compile and type errors against a base worktree only.
- `clean-run` (CK-CLEANRUN): the full suite of every affected project in a temp worktree
  with a frozen install and retries off, report parsing (JUnit, Jest JSON, `go test -json`,
  cargo text, TRX, RSpec JSON), counts compared with cached base counts; `--red-green`
  proof for new regression tests (CK-REDGREEN).
- `coverage-delta` (CK-COVERAGE: LCOV, Cobertura, Istanbul, Go cover profiles, or
  diff-cover), `mutation-scope` (CK-MUTATION: StrykerJS, Stryker.NET, cargo-mutants,
  mutmut on POSIX) and `flake-probe` (CK-FLAKE: repeats with shuffling and recorded seeds).
- `trace` (CK-TRACE): requirement candidates from a spec or issue and the diff hunks no
  requirement maps to; completed matrices validated against the snapshot.
- `evidence` (`init add claims waive finalize render status score`): the tamper-evident
  ledger `adc-evidence/1` with chained entry hashes and a per-session nonce, derived claim
  status, spec-quoted waivers capped at `PASS-WITH-FINDINGS`, recorded command runs and
  review reproductions, Markdown rendering, answer scoring with `file:line` citations for
  `audit-tests` (CK-MOCK) and `review` (CK-REVIEW).
- `verify`: every scripted step on one snapshot into one ledger with the verdict `PASS`,
  `PASS-WITH-FINDINGS`, `FAIL` or `UNVERIFIED`, `--quick` and `--deep`, next steps for the
  model's part (traceability, fresh-context review, claims); `git status` unchanged.
- Local metrics in `.adc/metrics.jsonl`; no remote reporting.

**Test engineering**

- `scaffold` kinds `e2e-web`, `e2e-api`, `e2e-cli`, `live`, `regress`, `ci-gate` and `flake`
  from template bundles, dry run by default, `--write` to write, never overwriting without
  `--force`.
- `live run` and `budget`: live probes from `tests/live/probes.json` under the budget ledger
  `.adc/budget.json` (2,500 credits per session and per day by default, lowerable per run,
  raisable only from a terminal or within a bounded CI variable), credentials only from
  `ADC_LIVE_TOKEN` or `.adc/.env.live`, never echoed; synthetic probes refused until the
  live safety checklist is answered (CK-LIVE).

**Hooks**

- `hooks render` / `setup hooks` for `copilot`, `copilot-cloud`, `claude` and `codex` at user
  or project scope and levels `advise` (default), `gate` and `guard`; merged writes with a
  backup, `--remove` of exactly what was added, `hooks list`, a refusal to write in CI and
  the cloud agent.
- `hook-run` handlers `session-start`, `post-edit`, `post-shell`, `stop`, `pre-guard` and
  `session-end` with three output dialects, one ASCII-only JSON object on exit 0, a 2-second
  watchdog, Node-missing guards in the Copilot strings, and no network.

**Agentic tooling development**

- `tooling scaffold` for instructions, skills, agents, prompt files, hooks, MCP configs and
  plugins per host; `tooling lint` with a cited rule catalog per host, a security rule group,
  plugin-lifecycle rules and external validators merged when installed; `tooling cost`;
  `tooling port` with dropped-field reports; `tooling trigger-set` (paid runs only with
  `--run`); `tooling modify` baseline/compare/accept/restore with the migrations
  `prompt-to-skill`, `chatmode-to-agent`, `claude-commands-to-skills`,
  `vscode-mcp-to-mcp-json` and `copilot-hooks-to-camel`; `tooling plugin`
  `init`/`check`/`test`/`release`.
- The skill's own evals: a 20-query trigger set and two `claude plugin eval` cases in
  `evals/`.

**Diagnostics and self-test**

- `doctor`: host guess, OS, Node, Git, host CLIs against their floors, every prerequisite
  with the fallback in effect, installed copies, registered hooks, launcher probes, the
  state directory, credential status (never the value), remaining budget; `--init` and
  `--verify-vendored`.
- `selftest` with areas for hooks, frontmatter, scripts, diffs, footprint, `.adc/`, README,
  prerequisites, release consistency and evals; `node --test` unit suites; the manual
  OS × host matrix.

**Playbooks** (`references/`): verify, audit-tests, review, trace, regress, e2e, live,
flake, ci-gate, tooling-scaffold, tooling-lint, tooling-optimize, tooling-eval,
tooling-port, tooling-modify, tooling-plugin, tooling-practices, failure-modes, release,
host-notes and install, each with manual fallbacks for guidance-only mode.

### Security

- `.adc/` is excluded through `.git/info/exclude` before anything is written, every command
  exits 3 while it is tracked, and nothing in it reaches a snapshot, diff, ledger or PR.
- No telemetry, no runtime dependencies, no `allowed-tools` grant, no secret-shaped literals
  in the tree; secrets are redacted in findings, ledgers and logs.

### Known limitations

- Exercised on Linux only (selftest plus Copilot CLI 1.0.103, Claude Code 2.1.310, Codex
  0.164.0, gh 2.99.0); the Windows and macOS rows of `tests/manual-matrix.md` are open.
- Open host questions (Copilot's Windows hook launcher, Codex hooks on native Windows, the
  cloud agent's skill directories and tool names) are tracked in
  [host notes](references/host-notes.md) §9.
- The trigger-set and `claude plugin eval` gates of 0.8 have not been run for this release
  (paid); they are required before 1.0.0.

[0.1.0]: https://github.com/robertlemmermann/agentic-developer-companion/releases/tag/v0.1.0
