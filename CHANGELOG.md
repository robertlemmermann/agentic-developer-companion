# Changelog

All notable changes to the `agentic-developer-companion` skill. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). The top entry always equals
`metadata.version` in [SKILL.md](skills/agentic-developer-companion/SKILL.md) and the Git tag
`v<version>` ([release checklist](skills/agentic-developer-companion/references/release.md)).

## [0.1.0] - 2026-10-25

First public release: both jobs of the skill (QA of agent-made changes, development of
agentic tooling) for GitHub Copilot, Claude Code and OpenAI Codex on Windows, macOS and
Linux, with a zero-dependency Node 24 runtime.

### Added

**Skill and repository**

- `skills/agentic-developer-companion/` with the six-field Agent Skills frontmatter, a mode
  router over "the text after the skill name" (no host substitutions), the `$ADC` search for
  `scripts/adc.mjs` in bash and PowerShell, operating principles and safety rules.
- `PREREQUISITES.md` and its machine-readable twin `assets/prerequisites.json`: every
  prerequisite with its fallback, host minimums, Windows notes, explicit non-prerequisites.
- Root `README.md`, the Apache-2.0 `LICENSE` and `.gitattributes` enforcing LF line endings.
  The skill folder ships only runtime files; tests, evals, this changelog and the third-party
  notices stay at the repository root and are never installed.
- `scripts/adc.mjs`, the single CLI entry point: Node version guard (exit 3, or `{}` for
  hooks), one ASCII-only JSON document per command, exit codes 0/1/2/3/4, global options
  `--json --cwd --base --state-dir --dry-run --yes`.

**QA of agent-made changes**

- Working-tree snapshot through a temporary index (untracked files included; the user's
  index, stash and working tree untouched; `.adc/` always excluded).
- `detect`: monorepo-aware projects, package managers with frozen installs, test runners with
  report and retries-off flags, type checkers, linters, CI system and default branch.
- `diff-scope`: CK-SCOPE, CK-TEST-DEL, CK-SKIP, CK-ASSERT, CK-TEST-CFG, CK-SUPPRESS (ratcheted
  against the base), CK-CI, CK-SWALLOW, CK-SECRETS, CK-LOCK and CK-RETRY.
- `deps-check` (CK-DEPS, CK-LOCK), `typecheck` (CK-TYPES), `clean-run` (CK-CLEANRUN, with
  `--red-green` for CK-REDGREEN), `coverage-delta` (CK-COVERAGE), `mutation-scope`
  (CK-MUTATION), `flake-probe` (CK-FLAKE) and `trace` (CK-TRACE).
- `evidence` (`init add claims waive finalize render status score`): the tamper-evident ledger
  `adc-evidence/1` with chained entry hashes, derived claim status, spec-quoted waivers and
  answer scoring for `audit-tests` (CK-MOCK) and `review` (CK-REVIEW).
- `verify`: every scripted step on one snapshot into one ledger with the verdict `PASS`,
  `PASS-WITH-FINDINGS`, `FAIL` or `UNVERIFIED`; local metrics in `.adc/metrics.jsonl`.

**Test engineering**

- `scaffold` kinds `e2e-web`, `e2e-api`, `e2e-cli`, `live`, `regress`, `ci-gate` and `flake`:
  dry run by default, `--write` to write, never overwriting without `--force`.
- `live run` and `budget`: live probes under the budget ledger `.adc/budget.json` (2,500
  credits per session and per day by default), credentials from `ADC_LIVE_TOKEN` or
  `.adc/.env.live` and never echoed, synthetic probes refused until the live safety
  checklist is answered (CK-LIVE).

**Hooks**

- `hooks render` / `setup hooks` for `copilot`, `copilot-cloud`, `claude` and `codex` at user or
  project scope and levels `advise`, `gate` and `guard`; merged writes with a backup,
  `--remove`, `hooks list`.
- `hook-run` handlers `session-start`, `post-edit`, `post-shell`, `stop`, `pre-guard` and
  `session-end` in three output dialects: one ASCII-only JSON object on exit 0, a 2-second
  watchdog, no network.

**Agentic tooling development**

- `tooling scaffold`, `lint` (cited rule catalog per host, security rules, external validators
  when installed), `cost`, `port`, `trigger-set`, `modify` (with five migrations) and `plugin`
  (`init`/`check`/`test`/`release`).
- The skill's own evals in `evals/`: a 20-query trigger set and two `claude plugin eval` cases.

**Diagnostics and self-test**

- `doctor`: host, OS, Node, Git, host CLIs, every prerequisite with the fallback in effect,
  installed copies, hooks, launcher probes, state, credential status and budget; `--init` and
  `--verify-vendored`.
- `tests/selftest.mjs` (repository only), `node --test` unit suites and the manual OS × host
  matrix.

**Playbooks**: 21 in `references/`, each with manual fallbacks for guidance-only mode.

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
  [host notes](skills/agentic-developer-companion/references/host-notes.md) §9.
- The paid eval gates (0.8) were run in Claude Code only (trigger set 1.0, both
  `claude plugin eval` cases 1.0); the Copilot trigger run is required before 1.0.0.

[0.1.0]: https://github.com/robertlemmermann/agentic-developer-companion/releases/tag/v0.1.0
