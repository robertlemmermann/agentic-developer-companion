# live: safe live and synthetic checks

Probe a running service (health, read-only journeys, gated writes) with a real credential and
a hard spend cap. The probes are a plain test project; the skill's trusted runner
(`adc.mjs live run`) loads the token, checks the budget before every probe, redacts the token
from everything it keeps, and records each probe as a `CK-LIVE` check in the evidence ledger.

## Contents

1. [Safety checklist (before any write-capable probe)](#1-safety-checklist-before-any-write-capable-probe)
2. [Scaffold the live project](#2-scaffold-the-live-project)
3. [Credentials: `.adc/.env.live`](#3-credentials-adcenvlive)
4. [The probe manifest and the probe contract](#4-the-probe-manifest-and-the-probe-contract)
5. [Run the probes](#5-run-the-probes)
6. [The budget ledger](#6-the-budget-ledger)
7. [Evidence and the summary to post](#7-evidence-and-the-summary-to-post)
8. [CI, cloud agents and sandboxes](#8-ci-cloud-agents-and-sandboxes)
9. [Guidance-only mode (no Node)](#9-guidance-only-mode-no-node)

## 1. Safety checklist (before any write-capable probe)

Read-only probes (health, readiness, key GET journeys, auth smoke) may be scaffolded at once.
**Do not write or enable a `synthetic` (write-capable) probe until the user has answered every
item below in the conversation.** Record the answers in `tests/live/live-checklist.md`; the
runner skips synthetic probes while that file is missing or any line contains `TODO`.

| Topic | Ask |
|---|---|
| Environment | Dedicated test tenant or account? Production or staging? Who owns it? |
| Writes | Idempotency keys, a unique test marker on every record, guaranteed cleanup, data retention rules |
| Limits | Rate limits and backoff; feature flags that isolate the test traffic |
| Kill switch | `LIVE_TESTS_ENABLED` (CI: a repository or environment *variable*), checked before every run |
| Blast radius | One sentence: the worst thing a broken probe can do |
| Secrets | Token from `.adc/.env.live` or a CI secret only; least privilege; expiry; rotation schedule |
| Observability | Requests tagged `X-Test-Run: $ADC_TEST_RUN_ID`; JUnit kept; traces/HAR choice (below) |
| Cadence | Schedule, alert threshold, owner; overlapping runs prevented (`concurrency`) |

Traces, HAR files and reports record request headers: for authenticated probes keep Playwright
`trace: 'off'` (or `retain-on-failure` with `outputDir` under `.adc/repro/`) and never record HAR.
`tests/live/test-results/`, `playwright-report/`, `blob-report/` and `*.har` must be git-ignored
(`git check-ignore -q tests/live/test-results/x` exits 0; `--write` checks this).

## 2. Scaffold the live project

```bash
node "$ADC" scaffold live --dry-run --json                                   # list the files first
node "$ADC" scaffold live --write --checklist tests/live/live-checklist.md --json
```

It writes `tests/live/` (`probes/readonly/*`, gated `probes/synthetic/*`, `probes.json`,
`runbook.md`, `live-checklist.md`), a scheduled workflow that calls `adc.mjs live run`, the
`.gitignore` entries above, and `.adc/` (exclude entry, `budget.json`, an empty `.env.live`).
Show the user the file list and write only after they confirm. Without a scaffold, create
`.adc/` with `node "$ADC" doctor --init --json`.

| Option | Effect |
|---|---|
| `--lang ts\|js\|python` | Probe runner: Playwright, `node --test` or pytest (default: detected, else `ts`) |
| `--checklist <file>` | The answered checklist; without `TODO` lines it enables the synthetic probe and job |
| `--synthetic-cost <n>` | Credits per synthetic run; required once the checklist is complete, unless it has a line `Estimated credits per synthetic run: <n>` |
| `--cost-header <h>`, `--cost-header-kind per_request\|cumulative` | Usage header written into every probe (§4) |
| `--base-url <url>`, `--health-path <p>` | Defaults `https://staging.example.invalid` and `/health`; never put the token in the URL |
| `--schedule "<cron>"` | 5-field UTC cron of the workflow (default `17 */6 * * *`) |
| `--skill-path <dir>` | Vendored skill the workflow runs; default: found in `.github/skills`, `.agents/skills`, `.claude/skills`, else fetched at tag `v<version>` |
| `--out <dir>`, `--write`, `--force` | Folder (default `tests/live`); write; replace existing files (backup kept) |

## 3. Credentials: `.adc/.env.live`

- **Never open, print, copy or search `.adc/.env.live`.** Ask the user to paste the token into
  the file in their own editor: `ADC_LIVE_TOKEN=<value>` (optional `ADC_LIVE_BASE_URL=`, `ADC_LIVE_TENANT=`).
- Check it without reading it: `node "$ADC" doctor --no-probes --json` shows
  `state.credential` as `set` or `unset` and its source, plus `state.env_live.perms`
  (owner-only: mode `0600`; Windows: an `icacls` ACL with only the user's SID).
- Precedence: the environment variable wins over the file. On developer machines prefer the
  file (an exported variable is inherited by every tool call and hook; `doctor` warns).
  CI and cloud-agent runs read the environment only, never the file.
- The runner refuses a base URL with credentials in it (`https://user:pass@host`, exit 2),
  refuses to read a `.env.live` that git would not ignore, and never runs unauthenticated.
  It replaces every token value it loaded (raw, trimmed, URL-encoded and base64) in the probe
  output, logs, `budget.json`, `metrics.jsonl` and the ledger with `[REDACTED:ADC_LIVE_TOKEN]`.

## 4. The probe manifest and the probe contract

`tests/live/probes.json`:

```json
{ "schema": "adc-probes/1",
  "probes": [
    { "id": "readonly/health", "kind": "readonly", "cmd": "npx playwright test probes/readonly/health.spec.ts --reporter=junit",
      "cwd": "tests/live", "cost": 1, "timeout_s": 120, "cost_header": "x-usage-credits", "cost_header_kind": "per_request" } ] }
```

| Field | Rule |
|---|---|
| `id` | Unique; letters, digits, `. _ / -` |
| `kind` | `readonly` (default) or `synthetic` (gated by the checklist) |
| `cmd` | One command line, valid in both `sh` and `cmd.exe` (no `&&` chains, no bash-only syntax) |
| `cwd` | Relative to the repository root; default: the folder of `probes.json` |
| `cost` | Estimated credits; default 1 for `readonly`; **required** for `synthetic` |
| `timeout_s` | Default 120, max 3600; on timeout the whole process tree is killed |
| `cost_header`, `cost_header_kind` | Usage header that replaces the estimate: `per_request` (the value is the cost) or `cumulative` (the cost is the increase since the last value seen) |

The runner starts `cmd` with piped stdio and these variables: `ADC_LIVE_TOKEN` (and
`ADC_LIVE_BASE_URL`, `ADC_LIVE_TENANT` when set), `ADC_TEST_RUN_ID`, `ADC_PROBE_ID`,
`ADC_SESSION_ID` and `ADC_PROBE_RESULT`. A probe may write JSON to the `ADC_PROBE_RESULT` file:
`{"headers": {...}}` (response headers, for `cost_header`), `{"cost": n}` (a reported cost) and
`{"status": 401}` or `{"http_status": 401}` (the HTTP status, recorded in the ledger). Header
values are only used for cost; nothing else from that file is stored. The project itself holds
no credential or budget logic.

## 5. Run the probes

```bash
node "$ADC" live run --dry-run --json      # what would run, the caps, gating; writes nothing
node "$ADC" live run --json
```

| Option | Effect |
|---|---|
| `--manifest <file>` | Another manifest (default `tests/live/probes.json`) |
| `--probes <glob,...>` | Only matching probe ids, e.g. `readonly/*` |
| `--session <id>` | Budget session to charge (default: the newest open hook session, else a new run id) |
| `--credits <n>` | Spend at most `n` in this run (lowers, never raises) |
| `--credits-override <n>` | Raise this session's cap; accepted **only from a real terminal** (else exit 2 "run this from a terminal"). Never pass it yourself; tell the user to run it |
| `--ledger <file>` / `--no-ledger` | Append to that evidence ledger / record nothing (default: the newest unfinalized ledger for the same snapshot, else a new one) |

Output: `{ session_id, identity_source, run_id, run_class, dry_run, credential, checklist,
probes[{id, kind, status, reason, cost, cost_source, estimate, duration_ms, exit_code,
http_status, log, tail}], spent, run_spent, spent_today, remaining, stopped_reason,
stopped_detail, budget, checks[], warnings[], ledger }`. Probe status is `pass`, `fail`,
`unverified`, `skipped` (gated), `not-run` (stopped) or `would-run` (dry run). Probe logs
(redacted) are in `.adc/cache/live/<run_id>/`; the newest 20 runs are kept. Progress notices
(`warn_at` crossed, a recreated `budget.json`, caps ignored for agents) go to stderr and
`warnings[]`. Exit `0` all ran and passed (or nothing ran by policy), `1` a probe failed,
`4` not verified.

| Status / reason | Meaning | What to do |
|---|---|---|
| `TOKEN_UNSET` | No token (or an unignored `.env.live`, or CI without the secret) | Ask the user to fill `.adc/.env.live`; never invent one |
| `BUDGET_EXHAUSTED` | `spent + estimate` would pass the session, daily or `--credits` cap | Stop. Report the spend; only the user may raise a cap |
| `BUDGET_UNVERIFIED` | `budget.json` missing or broken while spend is already recorded today (headless) | Ask the user to restore it, or to re-run from a terminal |
| `KILL_SWITCH` | `LIVE_TESTS_ENABLED` is set to something other than `true` | Nothing ran by policy |
| `SYNTHETIC_GATED` | Checklist missing or has `TODO` lines | Finish section 1 with the user |
| `TIMEOUT`, `PROBE_FAILED`, `AUTH_REJECTED` | The probe failed (401/403: token expired or rejected) | Read `tail`/`log`; fix the service or the probe, never the check |
| `RUNNER_MISSING` | The probe command was not found (exit 127/9009) | Install the project's runner (`npm ci` in `tests/live`) |
| `SPAWN_FAILED` | The shell could not start (for example the probe's `cwd` is missing) | Fix `cwd` in `probes.json`; see the log |

## 6. The budget ledger

`.adc/budget.json` caps live spend: **2,500 credits per session and 2,500 per UTC day** by
default (`warn_at` 2,000). Each probe's estimate is reserved under `budget.json.lock` before it
starts and replaced by the reported cost afterwards, so concurrent runs cannot both pass. The
file keeps the newest 50 sessions; every probe and run is also appended to `.adc/metrics.jsonl`.

- **Session identity**: `--session` > the newest open `.adc/sessions/*.json` written by the
  hooks > a run id generated per invocation. Without registered hooks every run is its own
  session, so only the daily cap spans runs.
- **Run classes**: `interactive` (a real terminal) may raise a session cap with
  `--credits-override`, which is persisted on the session as `override: {max, ts, by: "tty"}`;
  `ci` (GitHub Actions without agent markers) may set the session cap with the variable
  `ADC_LIVE_BUDGET` (ceiling 10,000); `agent` (any host session, `--yes`, cloud agent) keeps the
  shipped caps hard, ignores overrides and `ADC_LIVE_BUDGET`, and ignores a `budget.json`
  edited above the defaults.
- Inspect: `node "$ADC" budget show --json` (`--session <id>` for one session's probes). It
  prints the file's caps and, under `effective`, the caps your run class gets; `today.remaining`
  uses the effective daily cap.
- Maintain: `node "$ADC" budget prune [--dry-run] --json` keeps the newest 50 sessions (plus the
  open hook session) and 90 days of totals. `budget reset --session <id>` zeroes a session's
  spend (the daily total stays) and works only from a terminal. Both write under the lock.
- By hand (no Node): read `.adc/budget.json`; the spend of today is `days.<YYYY-MM-DD>.spent`,
  a session's is `sessions.<id>.spent`; never lower either.

## 7. Evidence and the summary to post

Every run adds `CK-LIVE` checks to the evidence ledger: one per probe (`project` = probe id,
with `cost`, exit code, duration, log path and output hash) and one run summary (`project`
`.`) whose `data.budget` carries session id, identity source, caps, spend and remainder. A
"live tests pass" claim is supported only by those checks. Post:

```text
Live probes (session <id>, <identity_source>): <n> pass, <n> fail, <n> not run
| probe | status | cost |   (one row per probe)
Spent <run_spent> credits (session <spent>/<max_per_session>, today <spent_today>/<max_per_day>); stopped: <reason or none>
Reproduce: node <skill>/scripts/adc.mjs live run --probes '<ids>' --json
```

## 8. CI, cloud agents and sandboxes

- The scheduled workflow runs `node <skill>/scripts/adc.mjs live run --json`, never the test
  runner directly, so CI needs a vendored or installed copy of the skill.
- `ADC_LIVE_TOKEN` is an environment-scoped secret on a protected `environment` with required
  reviewers; `if: vars.LIVE_TESTS_ENABLED == 'true'` is the kill switch; `ADC_LIVE_BUDGET`
  comes from `vars`; use `concurrency` so runs never overlap; upload JUnit only (or set
  `retention-days: 1` and document the exposure). `on.schedule` runs on the default branch only.
- The Copilot cloud agent's firewall and Codex's no-network sandbox block live probes unless
  an admin allow-lists the host or an escalation is approved. Run live probes from CI or a
  developer machine, not from inside an agent session.

## 9. Guidance-only mode (no Node)

Without Node the runner, its redaction and its budget checks are unavailable. Do **not** read
the token or run the probes with it yourself. Instead:

1. Prepare the command per probe from `tests/live/probes.json` and show it to the user.
2. Ask the user to run it in their own terminal, with the token loaded there and the output
   kept out of the conversation:
   - bash: `set -a; . .adc/.env.live; set +a; export ADC_TEST_RUN_ID="manual-$(date +%s)" ADC_PROBE_ID=readonly/health; (cd tests/live && npx playwright test probes/readonly/health.spec.ts --reporter=junit) > live.log 2>&1; echo "exit $?"`
   - PowerShell: `Get-Content .adc/.env.live | Where-Object { $_ -match '^\s*(?:export\s+)?(\w+)\s*=\s*(.*)$' } | ForEach-Object { Set-Item "env:$($Matches[1])" $Matches[2].Trim('"') }; $env:ADC_TEST_RUN_ID = "manual-$(Get-Date -UFormat %s)"; Push-Location tests/live; npx playwright test probes/readonly/health.spec.ts --reporter=junit *> ../../live.log; "exit $LASTEXITCODE"; Pop-Location`
3. Ask only for the exit code and the pass/fail counts, never for the log.
4. Keep the budget by hand: before each probe check that the session and today's spend plus
   the probe's `cost` stay within the caps in `.adc/budget.json`; ask the user to add each
   probe's cost to `days.<YYYY-MM-DD>.spent` afterwards; stop when a cap would be passed.
5. In the ledger you write by hand, record each probe as `CK-LIVE` with its cost and exit
   code, mark it "guidance-only mode", and keep it `unverified` unless the user ran it.

