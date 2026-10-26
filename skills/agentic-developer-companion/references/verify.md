# verify: QA of an agent-made change

Verify the working tree an agent produced (uncommitted and untracked files included), record
every check in the evidence ledger, and report one verdict: `PASS`, `PASS-WITH-FINDINGS`,
`FAIL` or `UNVERIFIED`.

## Contents

1. [Run it](#1-run-it)
2. [Steps and manual fallbacks](#2-steps-and-manual-fallbacks)
3. [Verdict rules](#3-verdict-rules)
4. [Your part: traceability, review, claims, waivers](#4-your-part-traceability-review-claims-waivers)
5. [Finalize and post the summary](#5-finalize-and-post-the-summary)
6. [Ledger format](#6-ledger-format)
7. [Guidance-only mode (no Node)](#7-guidance-only-mode-no-node)

## 1. Run it

```bash
node "$ADC" verify --json --spec SPEC.md --claims - < implementer-summary.txt
```

```powershell
Get-Content implementer-summary.txt | node "$ADC" verify --json --spec SPEC.md --claims -
```

| Option | Effect |
|---|---|
| `--base <ref>` | Diff origin; default chain `origin/HEAD` > `main` > `master` > `init.defaultBranch` > `HEAD` |
| `--spec <file\|-\|issue-url>` | Spec or issue text (an issue URL needs `gh`); enables CK-TRACE and spec-quoted waivers |
| `--claims <file\|->` | The implementer's summary or last message; each claim is mapped to checks |
| `--quick` / `--deep` | `--quick` also skips coverage; `--deep` adds mutation testing and the flake probe |
| `--finalize` | Seal the ledger now (headless runs: CI, cloud agent, `-p`/`exec`) |
| `--allow <glob>` | Paths CK-SCOPE accepts outside the spec (repeatable) |
| `--no-install`, `--keep` | Every worktree step (typecheck, clean-run, coverage, mutation, flake) |
| `--runner "<cmd>"` | The test command for typecheck, clean-run, coverage-delta and flake-probe |
| `--all-projects`, `--no-base`, `--base-counts <f>` | Passed to clean-run |
| `--offline` | No registry lookups in deps-check (default inside the Codex sandbox or with `ADC_OFFLINE=1`) |
| `--fail-under <pct>`, `--budget <min>`, `--times <n>` | Coverage gate, mutation budget, flake repetitions |
| `--session <id>`, `--tool <host>` | Override the session (letters, digits, `._:-`) and host recorded in the ledger |
| `--refresh` | Ignore the cached `detect` result (`.adc/detect.json`) |
| `--dry-run` | List the steps and which modules are available; run and write nothing |

Output: `{ ledger, markdown, verdict, finalized, needs_human_triage, tree_digest, base, tool, session_id,
session_source, checks[], claims[], reasons[], next_steps[], trace_matrix, steps[], worktree_unchanged,
duration_ms, finalize_error?, summary_markdown }`. Exit `0` for `PASS` and `PASS-WITH-FINDINGS`,
`1` for `FAIL`, `4` for `UNVERIFIED`, `3` when Git or Node is missing or `.adc/` is tracked.

Rules while a ledger is open:

- Do not edit the working tree between `verify` and `evidence finalize`. Every `evidence`
  command recomputes the snapshot and refuses a stale ledger (`LEDGER_STALE`, exit 4): re-run
  `verify` after any change.
- Put scratch files (review answers, the trace matrix) under the ledger's folder
  `.adc/evidence/<ledger>/` or pipe them with `-`; a file inside the working tree changes the
  snapshot.
- Follow `next_steps[]` in order. A step that cannot run is `UNVERIFIED`, never assumed to pass
  (Codex: worktree steps need `workspace-write`, [host notes](host-notes.md) §1).

## 2. Steps and manual fallbacks

One snapshot (`tree_digest`) is created and passed to every step. A step whose module is
missing, or that throws, is recorded `unverified` (`MODULE_UNAVAILABLE`, `STEP_ERROR` or the
error code) and the run continues. Each fallback below is what to run by hand in
guidance-only mode (§7); `$BASE` and `$SNAP` come from §7.1; "FM N" is step N of
[failure modes](failure-modes.md) §4.

| # | Step (script) | Checks | Effect on the verdict | Manual fallback |
|---|---|---|---|---|
| 1 | `detect` | none | if it fails, each later step detects on its own (`unverified` when it cannot) | read `package.json` scripts, `pyproject.toml`, `go.mod`, `Cargo.toml`, `*.csproj`, CI files for the real test command |
| 2 | `diff-scope` | CK-SCOPE | finding | `git diff --name-status -M $BASE $SNAP`; compare with the paths the spec names |
| 3 | `diff-scope` | CK-TEST-DEL, CK-SKIP, CK-ASSERT | **FAIL** unless waived | FM 2-4 |
| 4 | `diff-scope` | CK-TEST-CFG | **FAIL** unless waived | FM 5 |
| 5 | `diff-scope` | CK-SUPPRESS | finding; **FAIL** for a rule turned off repo-wide | FM 6 |
| 6 | `diff-scope` | CK-CI | **FAIL** | FM 7 |
| 7 | `diff-scope` | CK-SWALLOW | finding | FM 8 |
| 8 | `diff-scope` | CK-SECRETS | **FAIL** | FM 9 |
| 9 | `deps-check` | CK-DEPS, CK-LOCK | **FAIL** for a nonexistent package or lock mismatch | FM 10 |
| 10 | `typecheck` | CK-TYPES | **FAIL** on new errors; pre-existing ones are `pass-with-baseline` | run `npx tsc --noEmit`, `mypy .`, `go vet ./...`, `cargo check` or `dotnet build` in a base and a snapshot worktree; compare errors by file and message |
| 11 | `clean-run` | CK-CLEANRUN | §2.1 | §7.2 |
| 12 | `coverage-delta` | CK-COVERAGE | soft | `diff-cover coverage.xml --compare-branch=$BASE` |
| 13 | `mutation-scope` (`--deep`) | CK-MUTATION | soft | `npx stryker run --incremental --mutate <files>`, `dotnet stryker --since:<base>`, `cargo mutants --in-diff <diff>` |
| 14 | `flake-probe` (`--deep`) | CK-FLAKE | finding | `go test ./... -count=5 -shuffle=on`, `pytest -p randomly --count 5`, `npx jest --randomize` |
| 15 | `trace` + you | CK-TRACE | missing requirement **FAIL**; incomplete matrix `UNVERIFIED` | [trace](trace.md) |
| 16 | you | CK-REVIEW | §4.2 | §4.2 |
| 17 | `evidence finalize` | CK-CLAIMS | any unsupported claim prevents `PASS` | §4.3 |

### 2.1 CK-CLEANRUN outcomes (per project)

- `executed == 0` is `UNVERIFIED`; `failed > 0` or `errors > 0` is `FAIL`.
- Fewer tests executed than on the base is `FAIL`, unless every CK-TEST-DEL finding is waived
  and nothing failed (the shortfall is then explained).
- More skipped tests than on the base is a finding, and `FAIL` when CK-SKIP also fired.
- `flaky > 0` (Surefire `flakyFailure`, Playwright `flaky`, pytest `rerun`) is a finding, and a
  "tests pass" claim is supported only when `flaky == 0`.
- `retries_disabled: partial|unknown` is stated in the summary; say it in your post too.

## 3. Verdict rules

1. Per check and project, the **worst** recorded status wins
   (`fail` > `unverified` > `finding` > `pass-with-baseline` > `pass` > `skipped`). Adding a
   passing entry never upgrades a failure or an `UNVERIFIED`.
2. `FAIL` if any check is effectively `fail`; else `UNVERIFIED` if any required check is
   `unverified` or no CK-CLEANRUN is recorded; else `PASS-WITH-FINDINGS` for findings, waivers
   or an unconfirmed critical review item; else `PASS`.
3. Soft checks (CK-SCOPE, CK-SWALLOW, CK-COVERAGE, CK-MUTATION, CK-FLAKE, CK-MOCK, CK-RETRY)
   report findings and never fail on their own. Optional probes (coverage, mutation, flake)
   that cannot run are reported as `skipped`, not `UNVERIFIED`.
4. `pass-with-baseline` (only pre-existing type errors) counts as passing; list the baseline.
5. `UNVERIFIED` is resolved by running the step. Never argue it into a pass.

## 4. Your part: traceability, review, claims, waivers

`verify` leaves placeholders for what only a model can do; `next_steps[]` names the exact
commands with the ledger path.

### 4.1 Traceability (with `--spec`)

Fill `trace_matrix` (a copy of the skeleton under the ledger folder), then
`node "$ADC" evidence add "<trace_matrix>" --ledger "<ledger>"`. The script validates every
`path:line` against the snapshot and derives CK-TRACE. Details: [trace](trace.md).

### 4.2 Adversarial review (CK-REVIEW)

Run a read-only review in a **fresh context** that sees only the diff, the spec and the ledger.
Packet, host table, reviewer prompt and scoring rules: [review](review.md) §2-§6. Record the
answers, then confirm each critical item with a command the script runs:

```bash
node "$ADC" evidence score .adc/evidence/<ledger>/review-answers.json --ledger "<ledger>" --add
node "$ADC" evidence add --check CK-REVIEW --repro "<command that fails because of the bug>" --ledger "<ledger>"
```

Only a reproduced critical item fails the verdict; unconfirmed criticals give
`PASS-WITH-FINDINGS` with `needs_human_triage: true`. Recorded commands (`--run`, `--repro`) run
without the `ADC_LIVE_*` variables and are stopped, with their child processes, after
`--timeout <s>` (default 600); a timeout is `unverified`.

### 4.3 Claims

`node "$ADC" evidence claims - --ledger "<ledger>"` with the implementer's summary on stdin
(claims are mapped to checks by keywords), or JSON
`[{ "text": "All tests pass", "evidence": ["CK-CLEANRUN"] }]` to name the evidence. A claim is
`supported` only if every referenced check passed, `contradicted` if one failed, otherwise
`unsupported`. Statuses in the input are ignored. Observed runs (hooks) never support a claim.

### 4.4 Waivers

Only when the spec explicitly asks for what a check flags (for example "remove the legacy
endpoint and its tests"):

```bash
node "$ADC" evidence waive CK-TEST-DEL --file tests/legacy.test.ts --reason "spec section 3: 'remove the legacy endpoint and its tests'" --ledger "<ledger>"
```

- The quoted text must occur in the spec the ledger captured; without a spec, only a person at
  a terminal can waive. Never waive on the implementer's word.
- Waivers cap the verdict at `PASS-WITH-FINDINGS`. `--file` takes a path or a requirement id
  (`R3`); omit it to waive every finding of the check.
- Never waivable: CK-SECRETS, CK-CLEANRUN, CK-TYPES, CK-DEPS, CK-LOCK, CK-REDGREEN, CK-LIVE,
  CK-REVIEW, CK-CLAIMS, and anything `unverified`.

## 5. Finalize and post the summary

1. `node "$ADC" evidence finalize --ledger "<ledger>"` recomputes every entry, chain and
   artifact hash (`LEDGER_TAMPERED`, exit 4, on a mismatch), compares the ledger with a fresh
   snapshot (`LEDGER_STALE`, exit 4), records CK-CLAIMS, derives the verdict and seals the
   ledger. Exit `1` on `FAIL`, `4` on `UNVERIFIED`.
2. `node "$ADC" evidence render --short --ledger "<ledger>"` prints the summary to post;
   `--out <file>` writes the full Markdown. The script never posts; you or CI do.
3. Post, in this order: the rendered summary unchanged; one line per `fail`, `unverified` or
   waiver in your own words; what the review concluded and whether `needs_human_triage` is set;
   the reproduce command. Never restate a verdict more favourably than the ledger.

## 6. Ledger format

`.adc/evidence/<UTC stamp>-<tree12>.json` (schema `adc-evidence/1`), its generated `.md`, and
an artifacts folder of the same name (`spec.txt`, `trace.json`, `trace-matrix.json`,
`trace-completed.*`, `run-*.log`).

```json
{ "schema": "adc-evidence/1", "tool": "claude-code", "mode": "verify",
  "session_id": "...", "session_source": "session-file", "session_nonce": "<32 hex>",
  "repo": "...", "base": "<sha>", "base_ref": "main", "base_source": "origin/HEAD",
  "tree_digest": "<snapshot tree>", "snapshot_commit": "<sha>", "spec": "SPEC.md",
  "effective_test_globs": ["**/*.{test,spec}.*"], "budget": { "spent": 0, "remaining": 2500 }, "steps": [],
  "checks": [ { "id": "CK-CLEANRUN", "fm": ["FM-02", "FM-13"], "project": ".", "status": "pass",
      "reason": null, "command": "npm ci && npx vitest run --retry=0", "exit_code": 0,
      "summary": "...", "output_sha256": "...", "artifacts": [], "findings": [], "data": {},
      "tree_digest": "...", "source": "verify", "seq": 1, "prev": null, "entry_sha256": "..." } ],
  "observed_runs": [], "waivers": [], "claims": [],
  "verdict": "PASS", "verdict_reasons": [], "needs_human_triage": false,
  "created_at": "...", "finalized_at": null, "generated_by": "agentic-developer-companion 0.1.0",
  "integrity": { "count": 1, "head": "...", "header_sha256": "...", "ledger_sha256": null } }
```

- Each entry hash is `sha256(session_nonce + "\n" + canonical JSON)` and includes the previous
  entry's hash (`prev`), so an edited, removed or reordered entry is detected; artifact files
  are hashed too; `finalize` seals the whole ledger.
- `source` is `verify` (scripted step), `input` (`evidence add` of a file), `run` (a command the
  script ran) or `derived` (CK-CLAIMS). Input entries are shown as `(input)` in the Markdown.
- `budget` starts from `.adc/budget.json` and follows the newest `live run` recorded in the ledger.
- `evidence status --json` reports the verdict, `stale`, `integrity.problems[]` and pending steps.

## 7. Guidance-only mode (no Node)

Do the steps of §2 by hand and write the ledger yourself as
`.adc/evidence/<UTC stamp>-manual.md` with the line `mode: guidance-only` at the top, a table
`Check | Status | Command | Exit | Summary`, and for each command the first and last 20 lines
of its output plus the output's SHA-256 (`sha256sum log.txt` / `Get-FileHash log.txt`).
Apply §3 to reach the verdict.

### 7.1 Snapshot and base

```bash
BASE=$(git merge-base "$(git symbolic-ref -q --short refs/remotes/origin/HEAD || echo main)" HEAD)
export GIT_INDEX_FILE="$(mktemp -d)/index"; git read-tree HEAD
git add -A -- . && git rm -r -q --cached --ignore-unmatch -- .adc
SNAP=$(git -c user.name=adc -c user.email=adc@localhost commit-tree "$(git write-tree)" -p HEAD -m snapshot)
rm -f "$GIT_INDEX_FILE"; unset GIT_INDEX_FILE
```

```powershell
$origin = git symbolic-ref -q --short refs/remotes/origin/HEAD; if (-not $origin) { $origin = 'main' }
$BASE = git merge-base $origin HEAD
$env:GIT_INDEX_FILE = Join-Path ([IO.Path]::GetTempPath()) ("adc-index-" + [guid]::NewGuid()); git read-tree HEAD
git add -A -- .; git rm -r -q --cached --ignore-unmatch -- .adc
$SNAP = git -c user.name=adc -c user.email=adc@localhost commit-tree (git write-tree) -p HEAD -m snapshot
Remove-Item $env:GIT_INDEX_FILE; Remove-Item Env:GIT_INDEX_FILE
```

Without `origin/HEAD`, use `main`, else `master`, else `git config init.defaultBranch` (§1).
The user's index, stash and working tree stay untouched; untracked files are included. The
temporary index starts from `HEAD`, so every file is hashed and no same-second edit is missed.

### 7.2 Clean run

```bash
WT="$(mktemp -d)/snap"; git -c core.hooksPath=/dev/null worktree add --detach "$WT" "$SNAP"
cd "$WT" && npm ci && npx vitest run --retry=0 --reporter=junit --outputFile junit.xml; echo "exit $?"
cd - && git worktree remove --force "$WT"
```

```powershell
$WT = Join-Path ([IO.Path]::GetTempPath()) ("adc-snap-" + [guid]::NewGuid()); git -c core.hooksPath="$WT-nohooks" worktree add --detach $WT $SNAP
Push-Location $WT; npm ci; npx vitest run --retry=0 --reporter=junit --outputFile junit.xml; "exit $LASTEXITCODE"; Pop-Location
git worktree remove --force $WT
```

Use the project's frozen install and full-suite command with retries off (pytest
`-p no:rerunfailures --junit-xml f`, `go test ./... -json -count=1`, `cargo nextest run --retries 0`,
`dotnet test --logger "trx;LogFileName=f"`); run the same in a base worktree for the counts.

