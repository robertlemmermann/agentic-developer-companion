# review: adversarial second pass in a fresh context

A reviewer that did not write the change checks the diff against the spec and reports **only
correctness and spec gaps** (a reviewer told to find problems always finds some).

## Contents

1. [When to run it](#1-when-to-run-it)
2. [Prepare the review packet](#2-prepare-the-review-packet)
3. [Get a fresh context](#3-get-a-fresh-context)
4. [Reviewer prompt (paste as is)](#4-reviewer-prompt-paste-as-is)
5. [Record and score](#5-record-and-score)
6. [Confirm critical items](#6-confirm-critical-items)
7. [Output to produce](#7-output-to-produce)
8. [Manual fallbacks (guidance-only mode)](#8-manual-fallbacks-guidance-only-mode)
9. [Judge mitigations and limits](#9-judge-mitigations-and-limits)

## 1. When to run it

- **Step 16 of `verify`** (CK-REVIEW): `verify` leaves the check pending and names the
  ledger in `next_steps[]`.
- **Standalone** (`review [base]`): run `verify` first when possible, so the reviewer sees
  the ledger; otherwise create one with `evidence init --json`.
- Never review your own change in the same context, and never hand the reviewer the
  implementer's summary as evidence: it gets the diff, the spec and the ledger only.

## 2. Prepare the review packet

Write the packet into the ledger's folder, which is outside the snapshot ([verify](verify.md) §1).

```bash
L=$(node "$ADC" evidence status --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.parse(s).ledger))")
D="${L%.json}"; mkdir -p "$D"
BASE=$(node -p "require('./$L').base"); SNAP=$(node -p "require('./$L').snapshot_commit")
git diff --stat "$BASE" "$SNAP" > "$D/review.stat"; git diff -U5 "$BASE" "$SNAP" > "$D/review.diff"
node "$ADC" evidence render --ledger "$L" --out "$D/ledger.md"
```

```powershell
$L = (node $ADC evidence status --json | ConvertFrom-Json).ledger; $D = $L -replace '\.json$', ''
New-Item -ItemType Directory -Force $D | Out-Null; $j = Get-Content -Raw $L | ConvertFrom-Json
git diff --stat $j.base $j.snapshot_commit | Out-File -Encoding utf8 "$D/review.stat"
git diff -U5 $j.base $j.snapshot_commit | Out-File -Encoding utf8 "$D/review.diff"
node $ADC evidence render --ledger $L --out "$D/ledger.md"
```

The diff covers uncommitted and untracked files (it is taken from the ledger's snapshot).
The spec, when `verify --spec` captured one, is `$D/spec.txt`; otherwise copy the issue or
acceptance criteria there. The packet is: `review.stat`, `review.diff`, `spec.txt`,
`ledger.md`, and read-only access to the repository.

## 3. Get a fresh context

| Host | How |
|---|---|
| Claude Code | dispatch a subagent with read-only tools (a `.claude/agents/` reviewer with `tools: Read, Grep, Glob`, or the general-purpose agent told to stay read-only; `isolation: worktree` when available) and the §4 prompt; the built-in `/code-review` only as a second opinion |
| Copilot CLI | `/review` with the §4 prompt as its instructions, or a custom read-only agent (`.github/agents/reviewer.agent.md` with `tools: ["read", "search"]` and `include-custom-instructions: true`); `/rubber-duck` adds a second model's critique |
| VS Code | a new chat with a read-only custom agent, ideally a different model than the implementer, and the §4 prompt |
| Copilot cloud agent, code review | Copilot code review on the pull request; a review-focused skill in `.github/skills/` can carry the §4 checklist |
| Codex | `codex review --uncommitted - < "$D/review-prompt.md"` for the working tree, `--base <branch>` for a branch (PowerShell: `Get-Content -Raw "$D/review-prompt.md" \| codex review --uncommitted -`) |
| Anything else | a new conversation with the §4 prompt and the packet files pasted |

Save the §4 prompt as `$D/review-prompt.md` when a host reads instructions from a file.

## 4. Reviewer prompt (paste as is)

```text
You are reviewing a code change you did not write. Inputs: review.diff and review.stat
(the change, against its base), spec.txt (what was asked), ledger.md (checks already run).
You may read any file of the repository; do not edit, run builds, or call the network.

Mandate: report only correctness problems and gaps against the spec. Ignore style, naming
and refactoring wishes. Assume one hidden bug exists and look for it: special-cased inputs,
hard-coded outputs, lookup tables that match the tests, error paths that are swallowed,
boundaries (empty, one, many, maximum), concurrency and time. Do not trust the
implementer's summary or test names; read the code. "unknown" is a valid answer.

Answer each question yes, no or unknown, each yes/no with a path:line citation:
RV-SPEC     Is every requirement of the spec implemented?
RV-EDGE     Are the edge cases the spec lists handled and tested?
RV-BUG      Did you find a correctness bug you can reproduce?
RV-HIDDEN   Is there special-casing of inputs, hard-coded output or a lookup table?
RV-ERRORS   Are errors handled without being swallowed or downgraded?
RV-TESTS    Do the tests exercise the changed behavior?
RV-SCOPE    Does the diff contain changes unrelated to the spec?
RV-SECURITY Did you find a security problem (injection, secrets, authorization)?

Then list findings by severity. Critical: wrong behavior a user would hit, each with a
citation and ONE command that fails because of it (a test invocation or a script).
Important: likely bugs or spec gaps without a reproduction. Minor: everything else that is
still about correctness. Add a requirement table (requirement, implemented at path:line,
tested at path:line, status), a "Declined to judge" list for what you could not assess,
and a final line "Ready to merge? Yes | No | With fixes".

Return the table in Markdown, then this JSON:
{ "kind": "review", "ready_to_merge": "...", "declined_to_judge": [],
  "answers": [ { "id": "RV-SPEC", "answer": "yes", "citation": "src/x.ts:42", "note": "" } ],
  "critical": [ { "title": "", "citation": "src/x.ts:57", "repro": "npx vitest run tests/x.test.ts -t boundary" } ],
  "important": [ { "title": "", "citation": "" } ], "minor": [] }
```

## 5. Record and score

Save the reviewer's JSON as `$D/review-answers.json`, then:

```bash
node "$ADC" evidence score "$D/review-answers.json" --ledger "$L" --add --json
```

- The script validates every citation against the ledger's snapshot; a `yes`/`no` without a
  valid `file:line` is rejected (counts as unknown) and listed with its reason. Answers are
  `yes`, `no` or `unknown`; a custom question needs `"pass_if": "yes"|"no"`.
- A critical item without a valid citation **and** a reproduction step is downgraded to
  important. Remaining criticals mark CK-REVIEW `fail` and set `needs_human_triage`.
- Failed answers, important items and rejections make CK-REVIEW a `finding`; a clean review
  is `pass`. Exit 1 when the score has a failure.
- CK-REVIEW is never waivable and is never resolved by arguing with the reviewer: fix the
  code, or confirm or refute the item with a command (§6).

## 6. Confirm critical items

A critical item flips the verdict to `FAIL` only when a command the script runs reproduces
it. Run the reviewer's reproduction exactly (it must exit non-zero because of the bug and
be valid in both `sh` and `cmd.exe`):

```bash
node "$ADC" evidence add --check CK-REVIEW --repro "npx vitest run tests/limiter.test.ts -t boundary" --ledger "$L"
```

- Non-zero exit: `reproduced`, recorded as `fail` with the log hashed into the ledger.
- Exit 0: `not reproduced`, recorded as `pass`; the item stays as triage for a human.
- A missing command is `unverified` (`COMMAND_NOT_FOUND`), never a pass.
- When the reproduction needs a new test file, write it, then re-run `verify`: the failing
  test becomes part of the snapshot and fails CK-CLEANRUN on its own.

## 7. Output to produce

1. The requirement table with citations (from the reviewer, unedited).
2. Critical / Important / Minor lists; for each critical, its reproduction command and
   whether `evidence add --repro` confirmed it.
3. "Declined to judge" and "Ready to merge?" as the reviewer wrote them.
4. The CK-REVIEW line of `evidence render --short --ledger "$L"` and the verdict. Never
   restate the verdict more favorably than the ledger.

## 8. Manual fallbacks (guidance-only mode)

Without Node: take `BASE` and `SNAP` from [verify](verify.md) §7.1, write the packet with
`git diff --stat $BASE $SNAP > review.stat` and `git diff -U5 $BASE $SNAP > review.diff`
outside the repository (or under `.adc/`), give the reviewer other revisions through a
temporary worktree (`git worktree add --detach "$(mktemp -d)/rev" <sha>`, removed afterwards
with `git worktree remove --force`), and run each critical reproduction yourself, recording
the command, its exit code and the SHA-256 of its output (`sha256sum log.txt`,
`Get-FileHash log.txt`) in your hand-written ledger (`mode: guidance-only`). Compute no
score; list the answers as given.

## 9. Judge mitigations and limits

- When comparing two alternatives, ask twice with the order swapped and keep only
  agreements.
- A different model than the implementer where the host allows it; calibrate against a
  human review now and then.
- The review is a heuristic. It is strongest together with mutation testing (FM-16 sabotage
  and special-casing) and weakest on performance and security; for security-critical code
  also run the host's security reviewer (`/security-review`, Copilot code review) and a
  human review.
