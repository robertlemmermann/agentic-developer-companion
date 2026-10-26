# e2e: scaffold or harden an end-to-end project

Give the repository a real end-to-end layer for its web UI, HTTP API or CLI, or harden the one it
has. The scaffold renders known-good templates with detected values; you then adapt them to the
repository's conventions. Nothing is written until the user has seen the file list.

## Contents

1. [Pick the target and ask only what detection cannot know](#1-pick-the-target-and-ask-only-what-detection-cannot-know)
2. [Scaffold: dry run, then write](#2-scaffold-dry-run-then-write)
3. [Web UI (Playwright)](#3-web-ui-playwright)
4. [HTTP API](#4-http-api)
5. [CLI](#5-cli)
6. [Harden an existing suite](#6-harden-an-existing-suite)
7. [Desktop and mobile (notes only)](#7-desktop-and-mobile-notes-only)
8. [Evidence and the summary to post](#8-evidence-and-the-summary-to-post)
9. [Guidance-only mode (no Node)](#9-guidance-only-mode-no-node)

Find `adc.mjs` as described in SKILL.md; commands below use `$ADC` and run from the repository root.

## 1. Pick the target and ask only what detection cannot know

1. Run `node "$ADC" detect --json` and read `projects[]` (languages, managers, runners).
2. Choose the kind from the user's words: a browser UI → `e2e-web`; a service with endpoints →
   `e2e-api`; a command-line tool → `e2e-cli`. Ask when the request is ambiguous.
3. Ask only for what detection cannot know:
   - web: the base URL of a running app (when there is no `start`/`preview`/`dev` script), whether a
     login is needed, and **the first three user journeys** in the user's words;
   - api: the base URL, the health path, which endpoints need credentials, a second service (Pact);
   - cli: the command that starts the CLI when there is no `bin` / `[project.scripts]` / main package.
4. Never put credentials into options or files. Logins and tokens come from environment variables
   (`E2E_USERNAME`/`E2E_PASSWORD`, `E2E_API_TOKEN`) or the CI secret store.

## 2. Scaffold: dry run, then write

```bash
node "$ADC" scaffold e2e-web --journeys "sign up,search,checkout" --json     # dry run: lists the files
node "$ADC" scaffold e2e-web --journeys "sign up,search,checkout" --write --json
```

Without `--write` nothing is written; `written[]` shows `would-create`/`would-merge` per file. Show the
user the list, then re-run with `--write`. An existing file is never replaced: it is listed in
`skipped[]` and you merge by hand, or the user agrees to `--force` (the old file is backed up to
`.adc/backups/scaffold/<stamp>/`). `.gitignore` lines are merged in, never replaced.

| Option | Kinds | Effect |
|---|---|---|
| `--lang ts\|python` | e2e-web | Default: the detected language (TypeScript otherwise) |
| `--lang ts\|js\|python\|java\|dotnet` | e2e-api | Java = JUnit 5 + REST-assured; .NET = xUnit + HttpClient |
| `--lang ts\|js\|python\|go\|rust` | e2e-cli | A language without a template is a usage error (exit 2) |
| `--base-url <http(s) url>` | web, api | Default URL baked into the config; URLs with credentials are refused |
| `--journeys "a,b,c"` | web | The first three become `test.fixme` journey specs (skipped until implemented) |
| `--for copilot\|claude\|codex\|all` | web | Adds next steps for Playwright test agents and Playwright MCP |
| `--audit` | web | Hardening report for an existing suite (§6); writes nothing |
| `--health-path /health` | api | Endpoint for the smoke and contract tests |
| `--pact <provider>` | api (ts, js) | Pact consumer test skeleton for a second service |
| `--bin "<command>"` | cli | Entry point; a `.js/.mjs/.cjs/.ts` script runs with the current Node |
| `--out <dir>` | all | Output folder inside the repository (not `.git`, not the state dir) |
| `--write`, `--force`, `--dry-run` | all | Write; replace existing files (with backup); force a dry run |

Exit codes: `0` ok, `1` audit found P1/P2 items, `2` usage, `3` tracked `.adc/` or environment.
The result carries `next_steps[]`; follow them in order.

## 3. Web UI (Playwright)

TypeScript writes `e2e/web/` (own `package.json` with `@playwright/test`), Python writes
`tests/e2e/web/` (pytest-playwright), and both write `.github/workflows/e2e-web.yml`.

| File | What it holds |
|---|---|
| `playwright.config.ts` | `baseURL` from `E2E_BASE_URL`, `fullyParallel`, `forbidOnly` and `retries: 2` in CI only with `failOnFlakyTests`, `trace: 'retain-on-failure'`, screenshot and video on failure, `list`/`html`/`junit` reporters plus `blob` in CI, chromium/firefox/webkit projects behind a `setup` project, `webServer` with `reuseExistingServer` when a start script exists |
| `fixtures.ts` | `test`/`expect` with a page-object fixture, third-party calls stubbed with `page.route`, one login per worker (`storageState`; `{worker}` in `E2E_USERNAME` gives each worker its own account) |
| `pages/home.page.ts` | Page object: role, label and `data-testid` locators only |
| `tests/global.setup.ts` | Fails fast when the app is unreachable |
| `tests/smoke.spec.ts` | `@smoke`: renders, no uncaught errors, fixed clock (`page.clock`) |
| `tests/<journey>.spec.ts` | `@regression` journey skeletons (`test.fixme`) |
| `e2e-web.yml` | 4 shards, browsers installed (not cached), blob reports merged into HTML + JUnit |

Then:

1. `cd e2e/web && npm install && npx playwright install --with-deps`; commit `package-lock.json`.
2. Run `npx playwright test --project=chromium` (Python: `python -m pytest tests/e2e/web --browser chromium`).
3. Implement each journey and remove `test.fixme`; until then `verify` reports them under CK-SKIP.
4. Deterministic data: `page.clock` for time, `page.route` / `page.routeFromHAR` for third parties,
   per-worker accounts for anything that writes. Waits are web-first assertions, never sleeps.
5. Tag fast checks `@smoke` and run them with `--grep @smoke`; keep retries in CI only.

With `--for <host>` the next steps add the Playwright test agents (planner, generator, healer:
`npx playwright init-agents --loop=copilot|claude|codex`; regenerate after every Playwright upgrade;
on Windows the generated MCP entry runs `cmd /c npx ...`) and the Playwright MCP server
(`claude mcp add playwright -- npx @playwright/mcp@latest --caps=testing`,
`codex mcp add playwright -- npx @playwright/mcp@latest --caps=testing`, or a `mcpServers.playwright`
entry in `~/.copilot/mcp-config.json`; the Copilot cloud agent ships the server already).

## 4. HTTP API

| Language | Files (default folder) | Runner |
|---|---|---|
| ts / js | `client`, `contract`, `api.e2e.test` (`e2e/api/`); Jest + JavaScript becomes CommonJS (`.cjs`) | the detected one: node:test, Vitest, Jest, Mocha, Bun |
| python | `conftest.py` (httpx clients), `contract.py`, `test_api_e2e.py`, `requirements-e2e.txt` (`tests/e2e/api/`) | pytest |
| java | `ApiE2ETest.java` (`src/test/java/e2e/`) | JUnit 5 + REST-assured |
| dotnet | `ApiE2ETests.cs`, `E2E.Api.csproj` (`tests/E2E.Api/`) | xUnit + HttpClient |

- The client reads `E2E_API_BASE_URL`, sends `Authorization: Bearer $E2E_API_TOKEN` when set and tags
  every request with `X-Test-Run: $E2E_TEST_RUN_ID`. The client is `fetch`-based (no dependency);
  for an in-process Node app, supertest is a drop-in alternative.
- Tests: health is 2xx/3xx, the health response keeps its **contract** (the JSON shape, types not
  values, in `contracts/get-health.json`), an unknown route is 4xx, and each path in
  `E2E_API_PROTECTED_PATHS=/a,/b` answers 401/403 without credentials (negative cases).
- Contracts are written on the first local run and never in CI (`CI=true` fails on a missing one);
  `UPDATE_CONTRACTS=1` accepts a reviewed change. Java uses JSON schemas
  (`matchesJsonSchemaInClasspath`); .NET uses Verify (`*.verified.json` committed).
- An OpenAPI document (`openapi|swagger.{yaml,yml,json}` at the root or in `docs/`, `api/`, `spec/`,
  `specs/`, `openapi/`, `schema/`) adds `.github/workflows/api-fuzz.yml`: Schemathesis, started by
  hand against dev/staging only, because it creates and deletes data.
- `--pact <provider>` adds a consumer test (`@pact-foundation/pact`) that writes `pacts/`; verify it
  on the provider (`Verifier.verifyProvider()`) and gate deploys with
  `pact-broker can-i-deploy --pacticipant <consumer> --version <sha> --to-environment production`.

## 5. CLI

| Language | Files | Entry point detection |
|---|---|---|
| ts / js | `e2e/cli/harness`, `e2e/cli/cli.e2e.test` | `package.json` `bin` (or `--bin`) |
| python | `tests/e2e/cli/harness.py`, `test_cli_e2e.py` | `[project.scripts]` in `pyproject.toml` |
| go | `e2e/cli/harness_test.go`, `cli_e2e_test.go` | `package main` at the module root or in `cmd/*` |
| rust | `tests/cli_e2e.rs` (std only, `CARGO_BIN_EXE_<bin>`) | `[[bin]]` or `src/main.rs` |

The harness spawns the real CLI without a shell (except Windows command shims), with `NO_COLOR=1`,
and `normalize()` makes output golden-ready: LF line ends, no ANSI colors, project root, temp and
home directories masked with POSIX separators, timestamps and durations masked. The tests check
`--help` (exit 0, usage on stdout), the golden file `golden/help.golden`, an invalid invocation
(non-zero exit, message on stderr) and a run from another working directory. Golden files are
written on the first local run and never in CI; `UPDATE_GOLDEN=1` (Go: `-update`) accepts a
reviewed change. Adapt `INVALID_ARGS` and add one golden test per command.

## 6. Harden an existing suite

```bash
node "$ADC" scaffold e2e-web --audit --json
```

It reads every `playwright.config.*` and spec (`*.spec|test|cy.*`, pytest-playwright `test_*.py`)
and returns `audit.items[]` (`priority`, `rule`, `file`, `line`, `evidence`, `fix`) sorted P1 first.
Exit `1` when any P1 or P2 item exists. Fix P1 first, re-run, then fill gaps with `--write`.

| Priority | Rule | Finding |
|---|---|---|
| P1 | `fixed-sleep` | `waitForTimeout`, `time.sleep`, `setTimeout` waits, `cy.wait(n)` |
| P1 | `focused-test` | `.only` left in a spec |
| P1 | `retries-hide-flakes` / `unbounded-retries` | retries without `failOnFlakyTests`; more than 2 retries |
| P1 | `no-suite` | no Playwright configuration at all |
| P2 | `retries-outside-ci`, `no-forbid-only`, `no-trace`, `trace-off` | retries locally, `.only` allowed, no traces of failures |
| P2 | `serial-mode`, `hardcoded-url`, `no-base-url` | shared state between tests; environment leakage |
| P3 | `brittle-selector`, `force-click`, `no-tags`, `no-junit` | CSS/XPath locators, `force: true`, no `@smoke`, no JUnit for CI |

Manual fallback: search the same patterns, e.g.
`git grep -nE "waitForTimeout|\.only\(|force: *true|xpath=" -- "*.spec.*" "*.test.*"` and read each
`playwright.config.*` for `retries`, `failOnFlakyTests`, `forbidOnly`, `trace`, `baseURL`, `junit`.

## 7. Desktop and mobile (notes only)

Not scaffolded. Electron: Playwright `_electron.launch()` (experimental, JavaScript only).
Mobile: Maestro YAML flows (Java 17+, Windows through WSL, no physical iOS devices) or Appium with
`appium driver install uiautomator2|xcuitest`. Apply the same rules: condition waits, tags, traces
on failure, retries only with a flaky report.

## 8. Evidence and the summary to post

1. Run the new suite once and record it:
   `node "$ADC" evidence add --check CK-CLEANRUN --run "npx playwright test --project=chromium" --project e2e/web --json`
   (use the run command from `next_steps[]` for API and CLI suites).
2. Post: the files written, the run command and its result (passed/failed/skipped counts), the
   journeys still marked `fixme`, the CI workflow added, and anything the user must configure
   (repository variables `E2E_BASE_URL`, `E2E_USERNAME`, secret `E2E_PASSWORD`).

## 9. Guidance-only mode (no Node)

Without Node the scaffold cannot run. Write the files by hand from the same layout and rules:

1. Inspect the stack: `git ls-files | grep -E "package.json|pyproject.toml|go.mod|Cargo.toml|\.csproj|pom.xml"`.
2. Web: `npm init playwright@latest` in `e2e/web` (or `pip install pytest-playwright`), then set the
   config values from §3 (`forbidOnly`, CI-only retries with `failOnFlakyTests`, `retain-on-failure`
   traces, `junit` reporter, `baseURL` from `E2E_BASE_URL`), and add `test-results/`,
   `playwright-report/`, `blob-report/` to `.gitignore`.
3. API and CLI: one client or harness module, the smoke/contract/negative tests of §4 and the
   `--help`/golden/invalid-invocation tests of §5; golden and contract files never written in CI.
4. Run the suite with the project's runner and write "guidance-only mode" in the ledger you keep by hand.
