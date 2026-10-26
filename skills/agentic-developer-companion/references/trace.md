# trace: spec to diff traceability

Check a change against its spec in both directions: every requirement has implementing code
and a test ("missing functionality" otherwise), and every diff hunk belongs to a requirement
("extra functionality" otherwise). The script extracts candidates and validates citations; you
judge each requirement. The result is check CK-TRACE (FM-14, FM-11).

## Contents

1. [Run it](#1-run-it)
2. [What counts as a requirement](#2-what-counts-as-a-requirement)
3. [Complete the matrix](#3-complete-the-matrix)
4. [How CK-TRACE is derived](#4-how-ck-trace-is-derived)
5. [Output to produce](#5-output-to-produce)
6. [Manual fallback (no Node)](#6-manual-fallback-no-node)

## 1. Run it

Inside `verify` (preferred): `node "$ADC" verify --json --spec SPEC.md`. The skeleton is stored
with the ledger; `trace_matrix` in the output is the copy you fill in, and CK-TRACE stays
`unverified` until you record it.

Standalone, without a ledger:

```bash
M="${TMPDIR:-/tmp}/matrix.json"
node "$ADC" trace --json --spec SPEC.md --out "$M"
node "$ADC" trace --json --matrix "$M"
```

```powershell
$M = Join-Path ([IO.Path]::GetTempPath()) 'matrix.json'
node "$ADC" trace --json --spec SPEC.md --out $M
node "$ADC" trace --json --matrix $M
```

`--spec` takes a file, `-` (stdin: paste issue or PR text) or a GitHub issue/PR URL (read
through `gh` when it is installed and signed in; otherwise save the text to a file). `--base`
picks the diff origin as in [verify](verify.md). Without `--json`, `--md` prints the Markdown matrix.
`trace --matrix` exits `0` for pass, `1` for missing or extra functionality, `4` when
requirements are not judged.

## 2. What counts as a requirement

The extractor reads Markdown and plain text (CRLF and BOM tolerated; code fences and HTML
comments ignored):

| Source | Strength |
|---|---|
| Checkboxes `- [ ]` / `- [x]` outside skipped sections | strong |
| List items and table rows under headings such as Acceptance criteria, Requirements, Definition of done, Tasks, Expected behavior, Scope, Goals | strong |
| Sentences or items with must / shall / required | strong |
| Gherkin `Scenario:` blocks (with their Given/When/Then steps) | strong |
| should / needs to / has to outside a requirement section; numbered items in neutral sections | weak |

Sections named Steps to reproduce, Environment, Logs, Background, Context, Notes, References,
Alternatives, Out of scope or Non-goals are skipped. A leading id such as `AC-1:` or `REQ-12`
is kept as `source_id`. Requirements get ids `R1..Rn` in document order.

## 3. Complete the matrix

Open the matrix JSON and, for each entry of `requirements[]`:

- `status`: `implemented`, `partial`, `missing` or `unknown`; `dismissed` only for **weak**
  candidates that are not requirements (add a `note`).
- `evidence`: the implementing code as `"path:line"` or `"path:start-end"` (repository-relative,
  forward slashes; `path#L12-L20` also works).
- `tests`: the tests that exercise it, in the same form.

For each entry of `extras[]` (one per diff hunk, keyed `path:start-end`, `path:-N` for a pure
deletion, `path:binary`), set `"requirement": "R2"` when the hunk serves a requirement, or
leave it `null`. Hunks your citations already touch are mapped automatically; `hint` lists
requirements that share words with the hunk and is only a suggestion. You may append
requirements the extractor missed (any new `id`); they count as strong.

```json
{ "requirements": [
    { "id": "R1", "text": "Requests over the limit get 429", "status": "implemented",
      "evidence": ["src/limiter.ts:40-57"], "tests": ["tests/limiter.test.ts:12"] },
    { "id": "R2", "text": "Limits are configurable", "status": "missing", "note": "hard-coded at src/limiter.ts:3" } ],
  "extras": [ { "key": "src/billing.ts:10-14", "requirement": null } ] }
```

Record it: `node "$ADC" evidence add "<trace_matrix>" --ledger "<ledger>"` (or pipe it with `-`).
Keep the file under `.adc/evidence/<ledger>/` or outside the repository; a file in the working
tree changes the snapshot and makes the ledger stale. Fill `trace-matrix.json`, never `trace.json`:
the script reads requirement strengths from `trace.json` and refuses an edited copy
(`LEDGER_TAMPERED`).

## 4. How CK-TRACE is derived

The script never trusts a status on its own word:

- Every citation must name a file in the snapshot and a line within it; invalid ones are
  listed (`BAD_CITATION`, `FILE_NOT_IN_SNAPSHOT`, `LINE_OUT_OF_RANGE`) and ignored.
- `implemented` or `partial` without one valid citation becomes `missing`.
- A strong requirement cannot be dismissed (it stays `unknown`); a requirement dropped from the
  skeleton is `unknown`.
- Unmapped, non-trivial hunks are extra functionality (blank, brace-only and import-only hunks
  are trivial).

| Result | CK-TRACE |
|---|---|
| any requirement `missing` | `fail` (verdict `FAIL`) |
| any requirement `unknown`, or no requirements at all | `unverified` (verdict `UNVERIFIED`) |
| any `partial`, or unmapped hunks | `finding` (verdict at best `PASS-WITH-FINDINGS`) |
| otherwise | `pass` |

Requirements without a cited test are reported as `info` findings. If the spec explicitly
defers a requirement or allows a change, waive it with a quote:
`evidence waive CK-TRACE --file R3 --reason "spec: '<exact quote>'"` (see [verify](verify.md)).

## 5. Output to produce

The completed matrix is stored as `trace-completed.json` and `trace-completed.md` in the
ledger folder; post the Markdown matrix with the verify summary: one row per requirement
(id, text, status, implementation, tests), then "Missing functionality" and "Extra
functionality" lists. State plainly which requirements you could not judge.

## 6. Manual fallback (no Node)

1. List the requirements from the spec by the rules of §2, numbered `R1..Rn`.
2. Get the hunks: `git diff -U0 $BASE $SNAP` (snapshot recipe in [verify](verify.md), §7.1);
   each `@@ -a,b +c,d @@` header is one hunk at lines `c..c+d-1` of the new file.
3. Fill a table `Req | Text | Status | Implementation (path:line) | Tests (path:line)`, open
   each cited line to confirm it exists, then list unmapped hunks as extra functionality.
4. Apply §4 and write the result into the guidance-only ledger as CK-TRACE.
