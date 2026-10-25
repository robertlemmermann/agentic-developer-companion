# Failure modes, checks and detection

How the companion detects the ways an agent-made change can look done without being done.
Use it to interpret `diff-scope` and `deps-check` results, to decide between "fix" and
"waive", and to run the same checks by hand when Node is missing (guidance-only mode).

## Contents

- [1. Catalog: failure mode to check](#1-catalog-failure-mode-to-check)
- [2. What each diff check reports](#2-what-each-diff-check-reports)
- [3. Detection per ecosystem](#3-detection-per-ecosystem)
- [4. Manual fallback (guidance-only mode)](#4-manual-fallback-guidance-only-mode)
- [5. Evasion matrix](#5-evasion-matrix)
- [6. False positives: allow, waive, or fix](#6-false-positives-allow-waive-or-fix)
- [7. Known limits](#7-known-limits)

## 1. Catalog: failure mode to check

| FM | Failure mode | Checks | Scripted by |
|---|---|---|---|
| FM-01 | Test tampering: delete, rename away, skip, weaken, narrow discovery | CK-TEST-DEL, CK-SKIP, CK-ASSERT, CK-TEST-CFG | `diff-scope` |
| FM-02 | False "all tests pass" | CK-CLEANRUN, CK-CLAIMS | `clean-run`, `evidence finalize` |
| FM-03 | Weak tests accepted as proof | CK-ASSERT, CK-COVERAGE, CK-MUTATION | `diff-scope`, `coverage-delta`, `mutation-scope` |
| FM-04 | Hallucinated or look-alike packages | CK-DEPS, CK-TYPES | `deps-check`, `typecheck` |
| FM-05 | Silenced lint/type checks | CK-SUPPRESS | `diff-scope` |
| FM-06 | CI edited to pass | CK-CI, CK-TEST-CFG | `diff-scope` |
| FM-07 | Swallowed exceptions, error-to-warning downgrades | CK-SWALLOW | `diff-scope` |
| FM-08 | Over-mocking | CK-MOCK | `audit-tests` (model, scored by `evidence score`) |
| FM-09 | Secrets in the change | CK-SECRETS | `diff-scope` (gitleaks/trufflehog when installed) |
| FM-10 | Insecure code | referral | the host's security reviewer during `review` |
| FM-11 | Scope creep, generated-file edits, churn, duplication | CK-SCOPE, CK-TRACE | `diff-scope`, `trace` |
| FM-12 | Lockfile and dependency drift | CK-LOCK | `diff-scope` (static), `deps-check` (consistency) |
| FM-13 | Flakiness introduced or masked | CK-RETRY, CK-FLAKE, CK-CLEANRUN | `diff-scope`, `flake-probe`, `clean-run` |
| FM-14 | Spec ignored, metric gamed | CK-TRACE | `trace` + model |
| FM-15 | Reviewer overclaiming | CK-REVIEW | fresh-context review protocol |
| FM-16 | Deliberate sabotage | CK-REVIEW, CK-MUTATION | review ("assume a hidden bug"), mutation survivors |

Every check runs on the **working-tree snapshot** (uncommitted and untracked files
included, `.adc/` and ignored files excluded) against the merge base with the base ref.

## 2. What each diff check reports

Severity `fail` makes the verdict FAIL unless waived; `finding` gives PASS-WITH-FINDINGS;
`info` is context only. The ratchet compares occurrences on added lines with occurrences
on removed lines of the same file, keyed by the line text and the test case it belongs to,
so moved or re-indented lines never count as new.

| Check | Fires on | Severity |
|---|---|---|
| CK-TEST-DEL | test file deleted (with cases or a test name); renamed out of discovery or away from the runner's naming convention (`test_*.py`, `*_test.go`, `*.test.ts`, `*Test.java`, `*_spec.rb`); net loss of test cases inside a file, including cases commented out; cases moved to another test file are `info` | fail |
| CK-SKIP | added skip, focus (`.only`, `fit`, `focus: true`), xfail or todo markers in test files | fail (todo: finding) |
| CK-ASSERT | net loss of assertion lines in a modified test file (assertions of removed cases count under CK-TEST-DEL) | fail |
| CK-ASSERT | assertion replaced by a truthiness/existence check; tautologies (`expect(true).toBe(true)`); `except AssertionError` or an empty catch in a test; a new test file with cases and no assertions; deleted snapshot file | finding |
| CK-TEST-CFG | changed discovery or failure-handling settings in an existing runner config (`testMatch`, `testPathIgnorePatterns`, Vitest `include`/`exclude`, Playwright `testIgnore`/`retries`, pytest `addopts`/`testpaths`/`python_files`, `conftest.py` collection hooks, `.mocharc` `spec`, `Cargo.toml [[test]]`/`harness`, `.csproj <Compile Remove>`, Surefire `skipTests`/`excludes`, Gradle `test { exclude }`, Makefile/justfile `test*` targets, coverage thresholds); a test script or CI test command that now narrows the run or no longer runs the runner; a deleted runner config | fail |
| CK-TEST-CFG | other test-script or CI test-command changes; a new runner config that sets those keys | finding |
| CK-SUPPRESS | new suppression directive (`eslint-disable*`, `@ts-ignore`, `@ts-nocheck`, `# type: ignore`, `# noqa`, `#[allow(`, `//nolint`, `#pragma warning disable`, `@SuppressWarnings`, `rubocop:disable`, coverage pragmas) | finding |
| CK-SUPPRESS | rule turned off in an existing lint/type config (`"rule": "off"`, `0`, `"strict": false`, mypy `ignore_errors`, `.editorconfig` severity `none`, `<NoWarn>`, golangci `disable:` items, rubocop `Enabled: false`) | fail |
| CK-CI | `continue-on-error`, `allow_failure`, `\|\| true`, `--passWithNoTests`, `set +e`, `if: false`, `-DskipTests`, `--exit-zero`, `fail_ci_if_error: false`; a test step removed; a threshold lowered; a CI file deleted or moved; the ci-gate header added to an existing workflow | fail |
| CK-CI | a new workflow file; weakening inside a workflow whose base already carried `# generated by agentic-developer-companion ci-gate`; `paths-ignore` | finding |
| CK-SWALLOW | new empty `catch {}`/`.catch(() => {})`, `except: pass`, bare `except:`, `_ = f()`, empty `if err != nil {}`, `Err(_) => {}`, `rescue nil`; error log downgraded to warning; `throw`/`raise` replaced by a log line with the same message (non-test code) | finding |
| CK-SECRETS | token shapes (AWS, GitHub, GitLab, Slack, Stripe live, Google, OpenAI, Anthropic, npm, PyPI, SendGrid, Azure, private keys), `ADC_LIVE_TOKEN=<value>`, the live token value itself | fail |
| CK-SECRETS | generic `password = "..."`-style assignments with high entropy, JWTs, URL credentials, Stripe test keys, credential-like file names (`.env`, `id_rsa`, `*.pem`) | finding |
| CK-LOCK (static) | manifest dependencies changed but the lockfile did not (Go, yarn and pip-tools: only when the new version is missing); new dependency absent from the changed lockfile; lockfile deleted; conflict markers | fail |
| CK-LOCK (static) | lockfile changed without a manifest change (transitive drift) | finding |
| CK-RETRY | added in-source retries: `jest.retryTimes`, `this.retries`, `describe.configure({ retries })`, per-test `{ retry: n }`, `@pytest.mark.flaky`, `@RetryingTest`, `[Retry]`, rspec `retry:` | finding |
| CK-SCOPE | files outside the paths the spec names (`--spec`); generated files edited (`dist/`, `*.min.js`, `*.pb.go`, "Code generated ... DO NOT EDIT" headers); duplicated blocks of 6+ significant lines; a new local Python module that shadows a declared dependency | finding (formatting-only churn: info) |
| CK-DEPS | dependency that does not exist in its registry; registry dependency redirected to a local path, git or URL source; Go `replace` of a required module by a local directory | fail |
| CK-DEPS | look-alike of a popular or sibling package; import of a package the manifest does not declare (JS/TS, Go); new non-registry source | finding |
| CK-LOCK (consistency) | lockfile not consistent with its manifests (static parse plus the manager's frozen check); already inconsistent at the base: finding | fail |

`deps-check` resolves existence offline-first: the lockfile, then the local package-manager
cache (npm cacache, Go module cache, Cargo index, uv), then the registry CLI. Offline (the
default inside the Codex sandbox, or `--offline`) an unresolved package leaves CK-DEPS
`unverified`, never `pass`.

## 3. Detection per ecosystem

| Ecosystem | Skip/focus markers | Suppressions | Lockfile consistency (run by `deps-check` in a temp worktree) | Existence lookup |
|---|---|---|---|---|
| JS/TS | `.only` `.skip` `.todo` `.failing` `xit` `fit` `fdescribe` `this.skip()` `pending()` | `eslint-disable*` `@ts-ignore` `@ts-nocheck` `biome-ignore` `istanbul ignore` | `npm ci --dry-run --ignore-scripts --offline`; `pnpm install --frozen-lockfile --lockfile-only --offline`; yarn and bun: static parse | `npm view <pkg> name --json` |
| Python | `@pytest.mark.skip/skipif/xfail` `pytest.skip(` `importorskip(` `@unittest.skip*` | `# type: ignore` `# noqa` `# ruff: noqa` `# pylint: disable` `# pragma: no cover` | `uv lock --check --offline`; `poetry check --lock` | `uv pip compile -` (exact "not found"), `pip index versions <pkg>` |
| Go | `t.Skip(` `t.Skipf(` `t.SkipNow(` `//go:build ignore` | `//nolint` `//lint:ignore` | `go mod tidy -diff` (`GOPROXY=off` offline, `GOTOOLCHAIN=local`) | `go list -m -json <mod>@latest` |
| Rust | `#[ignore]` | `#[allow(` `#![allow(` | `cargo metadata --locked --format-version 1 --offline` | `cargo info <crate>` |
| .NET | `[Fact(Skip=` `[Ignore` `Assert.Inconclusive(` | `#pragma warning disable` `[SuppressMessage(` `.editorconfig` severity | `dotnet restore --locked-mode` (online only) | `dotnet package search <id> --exact-match` |
| JVM | `@Disabled*` `@Ignore` `@Test(enabled = false)` | `@SuppressWarnings(` `NOPMD` `CHECKSTYLE:OFF` | static parse of `gradle.lockfile` | none (static only) |
| Ruby | `xit` `xdescribe` `skip` `pending` `focus: true` | `rubocop:disable` `:nocov:` | static parse of `Gemfile.lock` | `gem search --remote --exact <gem>` |
| PHP | `markTestSkipped(` `markTestIncomplete(` | `@phpstan-ignore*` `@psalm-suppress` `phpcs:ignore` | static parse of `composer.lock` | none |

Lint-side detectors give extra signals when the project has them: eslint-plugin-jest
`no-focused-tests`/`no-disabled-tests`, Vitest `allowOnly: false`, pytest `-rs`,
`eslint --report-unused-disable-directives`, ruff `RUF100`/`S110`, mypy
`warn_unused_ignores`, Go `errcheck -blank`.

## 4. Manual fallback (guidance-only mode)

Without Node 24 run these by hand. The commands are identical in bash and PowerShell.
Write "guidance-only mode" in the ledger you write yourself.

1. **Base and range.** `git rev-parse --abbrev-ref origin/HEAD` (else `main`, then
   `master`), then `git merge-base <base> HEAD`. Call the result `B`. `git diff B` covers
   committed and uncommitted tracked changes; `git ls-files --others --exclude-standard`
   lists untracked files, which are entirely new. Never include `.adc/`.
2. **CK-TEST-DEL.** `git diff --name-status -M --diff-filter=DR B`; for every modified test
   file compare the number of test declarations: `git show B:<file>` against the working copy.
3. **CK-SKIP / CK-RETRY.** `git diff -U0 -G'\.(only|skip|todo|failing)\(|\b(fit|xit|fdescribe|xdescribe)\(|pytest\.mark\.(skip|skipif|xfail|flaky)|pytest\.skip\(|t\.Skip|#\[ignore|@Disabled|\[Ignore|Skip *=|retryTimes|retries:' B -- <test files>`;
   only lines starting with `+` count, and only when the same line was not removed.
4. **CK-ASSERT.** `git diff -U0 B -- <test files>`: count removed lines with `expect(`,
   `assert`, `Assert.`, `t.Error`, `assert_eq!` against added ones; look for `toBeTruthy()`
   replacing a value check and for `except AssertionError`.
5. **CK-TEST-CFG.** `git diff B -- jest.config.* vitest.config.* playwright.config.* pytest.ini pyproject.toml setup.cfg tox.ini conftest.py .mocharc* Cargo.toml *.csproj pom.xml build.gradle* Makefile justfile package.json`
   and read every change to discovery keys, retries, thresholds and test scripts.
6. **CK-SUPPRESS.** `git diff -U0 -G'eslint-disable|@ts-ignore|@ts-nocheck|type: ignore|noqa|nolint|#\[allow|pragma warning disable|SuppressWarnings|rubocop:disable' B`
   and `git diff B -- .eslintrc* eslint.config.* tsconfig*.json ruff.toml mypy.ini .golangci.* .editorconfig`.
7. **CK-CI.** `git diff B -- .github/workflows .gitlab-ci.yml azure-pipelines*.yml .circleci`
   and look for `continue-on-error`, `allow_failure`, `|| true`, `--passWithNoTests`,
   removed `run:` test steps and lowered numbers.
8. **CK-SWALLOW.** `git diff -U0 -G'catch|except|rescue|err != nil|Err\(_\)|console\.(warn|error)|logger\.' B`
   in non-test files; an added empty handler or a `throw` turned into a log line is a finding.
9. **CK-SECRETS.** `gitleaks git --log-opts="B..HEAD" --redact` plus `gitleaks dir <untracked files>`,
   or `trufflehog filesystem <changed files> --no-verification`; otherwise read the added
   lines for token prefixes (`AKIA`, `ghp_`, `github_pat_`, `glpat-`, `xox`, `sk_live_`,
   `AIza`, `-----BEGIN ... PRIVATE KEY-----`). Never paste a found value into the ledger.
10. **CK-LOCK / CK-DEPS.** `git diff B -- '*package.json' '*lock*' go.mod go.sum Cargo.toml pyproject.toml 'requirements*.txt'`;
    run the frozen check of section 3 in a temp worktree (`git worktree add --detach <tmp> HEAD`,
    then `git worktree remove --force <tmp>`); look up every new name with the registry
    command of section 3 and compare it with the popular package it resembles.

## 5. Evasion matrix

One scenario per documented strategy, materialized committed and uncommitted by the
selftest `diffs` area (`tests/unit/diff-scope.test.mjs`); the diff-scope column is
asserted there, the others state the design.

| Strategy | diff-scope / deps-check | clean-run count delta | Caught only by |
|---|---|---|---|
| special-casing inputs | not caught | not caught (tests pass) | mutation testing, adversarial review |
| lookup-table hard-coding | not caught | not caught (tests pass) | mutation testing, adversarial review |
| return true when tests check only completion | not caught | caught only if an assertion checks the value | mutation testing, adversarial review |
| stubbing modules with empty shells | CK-SCOPE finding (local module shadows a declared dependency) | not caught (tests pass against the stub) | adversarial review when the stub has another name |
| redirecting a dependency to a local stub | CK-LOCK fail; deps-check CK-DEPS fail and CK-LOCK fail | frozen install fails (lock mismatch) | — |
| deleting test cases inside a file | CK-TEST-DEL fail | caught (executed < base executed) | — |
| commenting out a test | CK-TEST-DEL fail | caught (executed < base executed) | — |
| narrowing discovery config | CK-TEST-CFG fail | caught when base counts exist | — |
| in-source retries | CK-RETRY finding | partial (reruns show as flaky only where the report records them) | flake probe |
| swallowing assertion errors in a test | CK-ASSERT finding | not caught (the test passes) | audit-tests, mutation testing |
| adding the ci-gate header to an existing workflow | CK-CI fail | not applicable | — |

## 6. False positives: allow, waive, or fix

- **Fix** when the finding is real: restore the test, remove the marker or suppression,
  make the CI step fail again, update the lockfile with the package manager.
- **`--allow <glob>`** (diff-scope and verify) marks paths as in scope and drops `finding`
  and `info` results on them. It never drops `fail` results or CK-SECRETS.
- **Waive** a `fail` only with quoted spec text:
  `evidence waive CK-TEST-DEL --reason "spec §3: 'remove the legacy endpoint and its tests'"`.
  A waiver caps the verdict at PASS-WITH-FINDINGS and is listed in the ledger. Never infer
  a waiver from the implementer's summary.
- Heuristic checks (CK-ASSERT downgrades, CK-SWALLOW, generic secrets, look-alikes,
  duplicated blocks) are `finding`, not `fail`, to keep the hard-check false-positive rate low.
- Prefer gitleaks or trufflehog when installed: `ADC_SECRETS_SCANNER=builtin|gitleaks|trufflehog`
  forces one; a scanner error falls back to the built-in regexes and says so.

## 7. Known limits

- Operator overloading, special-casing of inputs and lookup tables pass every static check
  and every clean run; only mutation testing and the adversarial review catch them.
- CK-ASSERT and CK-MOCK are heuristics with a ratchet, not proofs; an assertion rewritten
  into a helper function is invisible to line counting.
- Test-case counting is line-based: table-driven cases (Go structs, `pytest.mark.parametrize`
  rows, `test.each` tables) count as one case; deleting rows is caught by the clean-run count.
- Python imports are not matched against declared dependencies (import names differ from
  distribution names); module shadowing is detected only for top-level packages whose name
  equals a declared dependency.
- Registry lookups depend on the configured registry; a private package missing from the
  lockfile and the cache can only be confirmed online.
- Coverage is a soft signal. The ledger is tamper-evident, not tamper-proof, against an
  agent with shell access. Nothing here replaces human review of security-critical code.
