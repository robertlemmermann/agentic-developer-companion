# flake: detect, classify, fix and quarantine flaky tests

A flaky test passes and fails on the same code. It is a bug in the test or the product, and a
retry that turns it green hides that bug. Prove the flake with repeated runs, find the class,
fix it, and quarantine only as a dated, owned stopgap.

## Contents

1. [Detect: repeat with seeds](#1-detect-repeat-with-seeds)
2. [Classify and fix](#2-classify-and-fix)
3. [Quarantine policy and registry](#3-quarantine-policy-and-registry)
4. [Retries](#4-retries)
5. [Evidence and the summary to post](#5-evidence-and-the-summary-to-post)
6. [Guidance-only mode (no Node)](#6-guidance-only-mode-no-node)

## 1. Detect: repeat with seeds

```bash
node "$ADC" flake-probe --tests "test/sum.test.mjs::handles floats" --times 20 --json
```

`--tests` takes comma-separated `file` or `file::test name` entries (default: the new and changed
tests of the working tree); `--times` the repetitions (default 5). It shuffles and records seeds
where the runner can (Go 1.17+, jest-circus, pytest-randomly + pytest-repeat), else runs in order
with `shuffle: false`. Output: `{ runs, shuffle, seeds[], failures[], suspect_tests[] }` and a
`CK-FLAKE` check. A test that fails in any run is a suspect; keep the failing seeds, they
reproduce the order.

Manual fallback, one runner at a time (retries off, same seed recorded):

| Runner | Repeat command |
|---|---|
| pytest | `python -m pytest tests/test_x.py -p no:rerunfailures --count 20` (pytest-repeat; pytest-randomly shuffles, `--randomly-seed=<n>` reproduces) |
| Go | `go test ./pkg -run 'TestX' -count=20 -shuffle=on` (prints `-test.shuffle <seed>`) |
| Jest / Vitest | `npx jest t.test.js --randomize --seed=<n>`; `npx vitest run --sequence.shuffle --sequence.seed=<n>` in a loop |
| node:test | `for i in $(seq 20); do node --test --test-name-pattern="handles floats" test/sum.test.mjs \|\| echo "run $i failed"; done` |
| Cargo | `cargo nextest run --retries 0 x` in a loop; plain `cargo test x` otherwise |
| Playwright | `npx playwright test x.spec.ts --repeat-each=20 --retries=0 --workers=4` |
| .NET / RSpec | a loop of `dotnet test --filter "FullyQualifiedName~X"`; `bundle exec rspec --seed <n>` (`--bisect` finds order dependence) |

PowerShell loop: `1..20 | ForEach-Object { node --test test/sum.test.mjs; if ($LASTEXITCODE) { "run $_ failed" } }`.

## 2. Classify and fix

Assign exactly one class per incident, with the evidence that points to it:

| Class | Signal | Fix |
|---|---|---|
| Order dependence | fails only with some seeds or orders; passes alone | state per test, reset globals; fixed seeds for random data; stable sort before comparing |
| Time and timezone | fails near midnight, at DST changes, in another TZ, on slow machines | fake timers (`vi.useFakeTimers`, `jest.useFakeTimers`, Playwright `page.clock`, freezegun, time-machine); pin `TZ` |
| Network | timeouts, DNS errors, third-party 5xx | mock at the boundary (MSW with unhandled requests as errors, nock `disableNetConnect`, respx, VCR.py or pytest-recording `--block-network`, WireMock, Playwright `page.route`) |
| Concurrency | races between workers or async steps; shared ports, files, accounts | wait on conditions (web-first assertions, `expect.poll`, polling with a deadline), never on sleeps; one port, temp dir and account per worker |
| Resource leaks | later tests fail; open handles; growing memory | explicit cleanup in `finally` or fixture teardown |
| Test-data collisions | unique-constraint errors; shared fixtures mutated | unique data per test (`<run id>-<counter>`), factories instead of shared fixtures |
| Environment | Windows paths, line endings, locale, CPU speed, missing tools | `path.join`, normalize EOL before comparing, no timing thresholds in assertions |

Verify the fix with the same probe and **zero failures** in the same number of runs.

## 3. Quarantine policy and registry

Quarantine only when the fix cannot land now. Scaffold the policy once per repository:

```bash
node "$ADC" scaffold flake --json                                   # dry run
node "$ADC" scaffold flake --test "test/sum.test.mjs::handles floats" --max-flaky 0 --write --json
```

| Option | Effect |
|---|---|
| `--test <file[::name]>` | Also writes a diagnosis report `.adc/repro/flake/<slug>/diagnosis.md` (evidence runs, class, fix, verification) |
| `--max-flaky <n>` | Flaky tests tolerated by the gate (recorded in the registry and the policy) |
| `--out <dir>` | Folder for the policy and registry (default `tests/`) |
| `--write`, `--force` | Write after the user saw the list; replace changed files (backup kept). An existing registry is never replaced |

It writes `tests/flaky-test-policy.md` (detect, classify, fix, quarantine, retries, evidence),
`tests/quarantine.json`, `.github/workflows/quarantine.yml` (weekly, and on PRs that touch the
registry: registry check, then the quarantined tests with retries off) and `.github/adc/gate.mjs`.

To quarantine a test:

1. Tag it `@quarantine` in its name or tags. Selection per runner: node:test
   `--test-name-pattern=@quarantine` / `--test-skip-pattern=@quarantine`; Vitest and Jest
   `-t '@quarantine'` / `-t '^(?!.*@quarantine)'`; Playwright `--grep @quarantine` /
   `--grep-invert @quarantine`; pytest marker `quarantine` (`-m quarantine` / `-m "not quarantine"`;
   register the marker); Go a `Quarantine` name part (`-run` / `-skip`); RSpec `--tag quarantine`;
   .NET `[Trait("Category", "quarantine")]`; Maven `@Tag("quarantine")` (`-Dgroups` /
   `-DexcludedGroups`); Rust `#[ignore]` (`-- --ignored` runs them).
2. Add an entry to `tests/quarantine.json` (`adc-quarantine/1`):
   `{ "id": "...", "owner": "@team", "issue": "#12", "added": "2026-10-26", "expires": "2026-11-20", "reason": "..." }`.
   `owner`, `issue` and `expires` are required; at most `max_days` (30) between `added` and `expires`.
3. Re-run `scaffold ci-gate --write --force` (or add the exclusion by hand): the merge gate then
   skips quarantined tests and its `quarantine` job fails on an expired or incomplete entry.
4. Weekly review: fix and remove the tag and the entry, extend once with a written reason, or
   delete the test with the reason in the PR.

## 4. Retries

- Allowed only for e2e tests and only with a flaky report, so a retried pass is visible and fails
  the run: Playwright `failOnFlakyTests` / `--fail-on-flaky-tests`, Surefire `Flakes:` with
  `rerunFailingTestsCount`, Vitest `retry` with the flaky outcome in JUnit. Never for unit tests.
- In-source retries (Jest retry counts, the pytest flaky marker, Playwright describe-level retries)
  are reported by `verify` (CK-RETRY): retries belong in the CI configuration.
- CI fails when more than `--max-flaky` flaky tests are reported (`gate.mjs counts --max-flaky`).
- `gh run rerun --failed` hides flakes: a green re-run is not evidence.

## 5. Evidence and the summary to post

1. With a ledger open (`node "$ADC" evidence init --json` or `verify`), add the probe before and
   after the fix: `node "$ADC" flake-probe --tests "<file::name>" --times 20 --json | node "$ADC" evidence add -`.
2. Fill the diagnosis report: runs, failures, seeds, the class and why, the fix, the verification run.
3. Post: the test, the evidence (runs, failures, seeds), the class, the fix, the verification
   (0 failures in N runs) or the quarantine entry (owner, issue, expiry), and the commands to reproduce.

## 6. Guidance-only mode (no Node)

Run the manual repeat commands of §1, record runs, failures and seeds in the ledger you keep by
hand (marked "guidance-only mode"), write the quarantine entry by hand with the fields of §3, and
keep the flake `UNVERIFIED` until a repeat run with zero failures has been seen.
