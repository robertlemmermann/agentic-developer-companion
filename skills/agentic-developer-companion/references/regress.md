# regress: from bug to regression test

Turn a bug report into one regression test that fails for the right reason before the fix and
passes after it, with the proof in the evidence ledger. No reproduction, no test: a speculative
test that has never been red proves nothing.

## Contents

1. [Reproduce first](#1-reproduce-first)
2. [Choose the level](#2-choose-the-level)
3. [Scaffold the failing test](#3-scaffold-the-failing-test)
4. [Make it real](#4-make-it-real)
5. [Red-green proof](#5-red-green-proof)
6. [Legacy code: characterization tests](#6-legacy-code-characterization-tests)
7. [Hygiene: when a test may go](#7-hygiene-when-a-test-may-go)
8. [Evidence and the summary to post](#8-evidence-and-the-summary-to-post)
9. [Guidance-only mode (no Node)](#9-guidance-only-mode-no-node)

## 1. Reproduce first

1. Read the issue: expected behavior, actual behavior, input, environment.
2. Reproduce it with one command (valid in sh and cmd.exe) or a minimal script. The scaffold
   creates `.adc/repro/<issue>-<behavior>/repro.md` and a `repro.mjs` / `repro.py` that exits 1
   while the bug is present; the folder is git-excluded, never committed.
3. Record the command, the trimmed output and the exit code in `repro.md`.
4. **If the bug does not reproduce, stop.** Tell the user what you tried and ask for the missing
   detail (version, data, platform). Do not write a test.

## 2. Choose the level

Use the lowest level that reproduces the bug: **unit** when the behavior is isolatable, else
**integration** (real collaborators: database, file system, HTTP in-process), else **e2e** (see
[e2e](e2e.md)). Never mock the unit under test; mock only at the boundary the bug does not
involve. Write the reason into `repro.md` ("Why this level").

## 3. Scaffold the failing test

```bash
node "$ADC" scaffold regress --issue https://github.com/o/r/issues/7 --behavior "sum of an empty list is 0" --json
node "$ADC" scaffold regress --issue 7 --behavior "sum of an empty list is 0" --level unit --write --json
```

| Option | Effect |
|---|---|
| `--issue <id\|#id\|URL>` | Required. Names the test and links it; a URL's trailing number becomes the id |
| `--behavior "<text>"` | Required. What must hold; names the test `test_<issue>_<behavior>` |
| `--level unit\|integration\|e2e` | Recorded in the test header and `repro.md` (default `unit`) |
| `--characterize` | Adds a golden-master test (§6); TypeScript, JavaScript and Python only |
| `--lang ts\|js\|python\|go\|rust\|java\|dotnet\|ruby` | Default: detected; another stack without a template is a usage error |
| `--out <dir>`, `--write`, `--force` | Folder; write after the user saw the list; replace existing files (backup kept) |

| Language | Test file (default folder) | Tag and name |
|---|---|---|
| ts / js | `test/regression/<issue>-<behavior>.test.ts\|mjs` (Jest + JS: `.cjs`) | `describe('@regression #7')`, `it('test_7_...')` |
| python | `tests/regression/test_<issue>_<behavior>.py` + `conftest.py` | `pytestmark = pytest.mark.regression` (marker registered) |
| go | `regression_<issue>_test.go` in the project's package | `func Test_<issue>_<behavior>` |
| rust | `tests/regression_<issue>.rs` | `#[test] fn test_<issue>_<behavior>` |
| java | `src/test/java/regression/Issue<Id><Behavior>Test.java` | `@Tag("regression")` (JUnit 5) |
| dotnet | `tests/Regression/Issue<Id>RegressionTests.cs` | `[Trait("Category", "regression")]` |
| ruby | `spec/regression/issue_<issue>_spec.rb` | `RSpec.describe "regression ...", :regression` |

The result gives `test_file`, `test_name`, `level`, `repro` and `next_steps[]`. Every skeleton
fails by construction (`assert.fail("not reproduced yet: ...")` or the language's equivalent), so an
unedited skeleton can never pass.

## 4. Make it real

1. Replace the placeholder with the real call and the assertion the issue expects. Keep the issue
   link comment (`Issue: ...`; for a numeric id add `Fixes #7` to the PR description).
2. Use the smallest input from `repro.md`; for input families use the runner's parameterization
   (`it.each`, `@pytest.mark.parametrize`, table tests in Go, `#[test_case]`, `@ParameterizedTest`,
   `[Theory]`). Build data with factories, not shared mutable fixtures.
3. Run it once **before** the fix: it must fail with an assertion that names the bug, not with a
   collection, import or compile error. Then fix the code.

## 5. Red-green proof

```bash
node "$ADC" clean-run --red-green test/regression/7-sum-of-an-empty-list-is-0.test.mjs --json
```

The listed test files must **fail by assertion** in a base worktree and **pass** in the snapshot;
the result is a `CK-REDGREEN` check with both report paths, and the working tree is left as it was.
Several files: `--red-green a,b`; one test: `--red-green file::name`. Only `pass` is acceptable;
`reason` values and what to do: [audit-tests](audit-tests.md) §4.

Manual fallback (no scripts; `$BASE` from [verify](verify.md) §7.1), bash:

```bash
tmp=$(mktemp -d)
git worktree add --detach "$tmp/red" "$BASE"
mkdir -p "$tmp/red/test/regression" && cp test/regression/7-*.test.mjs "$tmp/red/test/regression/"
(cd "$tmp/red" && npm ci && node --test test/regression/7-*.test.mjs); echo "base exit $?"   # must fail by assertion
node --test test/regression/7-*.test.mjs; echo "fixed exit $?"                                 # must pass
git worktree remove --force "$tmp/red"
```

PowerShell: `$tmp = Join-Path $env:TEMP "adc-red"; git worktree add --detach $tmp $BASE`,
copy the test with `Copy-Item`, run the same commands with `Push-Location $tmp` / `Pop-Location`,
check `$LASTEXITCODE`, then `git worktree remove --force $tmp`. Paste both outputs (trimmed) into
`repro.md` section 3.

## 6. Legacy code: characterization tests

Before changing code nobody fully understands, pin what it does **today**:

```bash
node "$ADC" scaffold regress --issue 9 --behavior "rounding stays stable" --characterize --write --json
```

This adds `<issue>-<behavior>.characterization.test.*` (Python: `test_<...>_characterization.py`):
fill `INPUTS` with the bug's input, edge cases and normal cases, and `subject()` with the call;
the first local run writes `__golden__/<name>.json`, CI never does, `UPDATE_GOLDEN=1` accepts a
reviewed change. The golden file records current behavior, bugs included: review it before
committing. Library alternatives: Jest/Vitest `toMatchSnapshot` (`--ci` never writes new
snapshots), syrupy (Python), Verify (.NET; ApprovalTests.Net is unmaintained), insta (Rust),
goldie (Go, `go test -update`).

## 7. Hygiene: when a test may go

Delete or replace a test only when its behavior was removed, its coverage is duplicated at a
lower level, or a new test is strictly stronger. Write the reason into the PR description; the
companion's `verify` reports every deleted test or test case (CK-TEST-DEL) and expects that reason.
Never delete or weaken a test to make the suite green.

## 8. Evidence and the summary to post

1. Open a ledger (`node "$ADC" evidence init --json`, or run `verify`) and add the proof:
   `node "$ADC" clean-run --red-green <test file> --json | node "$ADC" evidence add -`.
2. Add the full suite the same way: `node "$ADC" clean-run --json | node "$ADC" evidence add -` (CK-CLEANRUN).
3. Post: the issue, the test name and file, the level and why, the red result on the base (the
   assertion message) and the green result after the fix, and the commands to reproduce both.

## 9. Guidance-only mode (no Node)

Write `repro.md` and the test by hand with the naming and tags of §3, run the red-green steps of
§5 manually, and record both outputs in the ledger you keep by hand, marked "guidance-only mode".
A test whose red run you did not see stays `UNVERIFIED`.
