# Tooling plugin

`tooling plugin` builds, checks, tests and prepares releases of plugins that package the
**user's own** skills, agents, hooks and MCP servers for GitHub Copilot (Agent Plugins 1.0),
Claude Code and OpenAI Codex. Decision D10 keeps plugin packaging out of this companion's own
repository: the command refuses to write into the companion skill.

## Contents

- [1. init](#1-init)
- [2. Layout per host](#2-layout-per-host)
- [3. check](#3-check)
- [4. test](#4-test)
- [5. release](#5-release)
- [6. Enterprise distribution](#6-enterprise-distribution)
- [7. Known limits](#7-known-limits)
- [Manual fallback (guidance-only mode)](#manual-fallback-guidance-only-mode)

## 1. init

1. Resolve `ADC` as described in [SKILL.md](../SKILL.md).
2. Dry run, show the file list: `node "$ADC" tooling plugin init --for copilot|claude|codex|all --json
   [--name n] [--out dir] [--skills a,b] [--agents a,b] [--include-hooks] [--include-mcp]
   [--marketplace m] [--owner o] [--version 0.1.0] [--license l] [--description d]`
3. After the user confirms, the same command with `--write` (`--force` merges an existing
   marketplace file and overwrites other existing files, with backups in `.adc/tooling/backups/`).

Defaults: name from `package.json` or the folder (kebab-case, 1-64 characters, not reserved
by Claude Code: no `claude-`, `anthropic-`, `anthropics-`, `cc-plugin-` prefix, not `claude`,
`anthropic`, `claude-code`, `claude-mods`), output `plugins/<name>/`, owner from
`git config user.name`. What is packaged:

- **Skills**: every project skill in `.agents/skills/`, `.github/skills/` and
  `.claude/skills/` (or `--skills`), copied to `skills/<name>/`. A skill's own `evals/` stays in
  the repository; its `claude plugin eval` cases move to the plugin's `evals/`. Codex-only
  skills from `.codex/skills/` (translated agents) are packaged only for `--for codex` or when
  named with `--skills`. Without project skills a starter skill is written.
- **Agents** (`--agents` or all): `.github/agents/*.agent.md` and `.claude/agents/*.md`, ported
  to `agents/<n>.md` (Claude Code) and `com.github.copilot/agents/<n>.agent.md`; Codex plugins
  have no agents (port the agent to a skill first and pass it with `--skills`).
- **Hooks** (`--include-hooks`): command hooks from `.github/hooks/*.json`,
  `.claude/settings.json` and `.codex/hooks.json`; the program and script arguments
  (`.mjs .cjs .js .ts .py .sh .ps1 .rb .pl`) inside the repository are copied to
  `hooks/scripts/` and addressed through `${PLUGIN_ROOT}` (Copilot, Codex) or
  `${CLAUDE_PLUGIN_ROOT}` (Claude Code exec form), because the install folder changes with every
  version. Other file arguments (an env file, a key) are never copied; a manual step names them.
  Copilot `preToolUse` entries get `"cwd": "${PLUGIN_ROOT}"` (github/copilot-cli#2540).
  Shell-string hooks are a manual step.
- **MCP servers** (`--include-mcp`): from `.mcp.json`, `.github/mcp.json`, `.vscode/mcp.json`.
  Agent Plugins `mcp.json` expands only `${PLUGIN_ROOT}` and `${PLUGIN_DATA}`, so environment
  references in `env` and headers are dropped there (listed in `dropped_fields[]`; users set
  them); the Claude Code `.mcp.json` keeps `${VAR}`.

Output: `{ name, hosts[], plugin_dir, marketplace, marketplaces[], dry_run, files[], written[],
skipped[], validators[], local_test_commands[], release_steps[], dropped_fields[],
manual_steps[], next_steps[] }`. Exit `0`, `2` usage (reserved or invalid name, `--out` inside
the companion or outside the repository).

## 2. Layout per host

| Part | Copilot (Agent Plugins 1.0) | Claude Code | Codex |
|---|---|---|---|
| Manifest | root `plugin.json`: `$schema` `https://agent-plugins.org/schemas/1.0.0/plugin.schema.json`, closed fields (`name`, `version`, `description`, `author`, `homepage`, `repository`, `license`, `keywords`, `extensions`) | `.claude-plugin/plugin.json` (`name`, `version`, `description`, `author`) | the root `plugin.json` when Copilot is targeted too (Codex extras under `extensions["com.openai"]`); otherwise `.codex-plugin/plugin.json` (camelCase `skills`, `mcpServers`, `hooks`, `interface`) |
| Skills | `skills/<name>/SKILL.md` (immediate subfolders only; no root SKILL.md) | `skills/<name>/` | `skills/<name>/` |
| Agents | `com.github.copilot/agents/` | `agents/` (no `hooks`, `mcpServers`, `permissionMode`) | none |
| Hooks | `com.github.copilot/hooks/hooks.json` (`version: 1`, `bash` + `powershell`) | `hooks/hooks.json` (`{"description", "hooks": {...}}`) | `hooks/codex.hooks.json` (`command` + `commandWindows`); trusted by the user in `/hooks` before they run |
| MCP | `mcp.json` with `https://agent-plugins.org/schemas/1.0.0/mcp.schema.json` | `.mcp.json` | `mcp.json` (with the root manifest) or `.mcp.json` (with `.codex-plugin`) |
| Evals | | `evals/<case>/prompt.md` + `graders/` | |
| Marketplace | `.github/plugin/marketplace.json` (Copilot only) | `.claude-plugin/marketplace.json` (also read by Copilot and Codex, so used whenever Claude Code or both others are targeted) | `.agents/plugins/marketplace.json` (Codex only) |

Plus `README.md` (contents, install commands per host) and `CHANGELOG.md` in the plugin
folder. The marketplace entry is `{ "name", "source": "./plugins/<name>", "description",
"version" }`, so the repository is its own marketplace.

## 3. check

`node "$ADC" tooling plugin check [dir] --json` (default `.`). Exit `1` when there are errors.

- **Manifests**: Agent Plugins `$schema` version, closed field set, `author` and `keywords`
  shapes, name rules (Agent Plugins: `a-z 0-9 - .`, no `--` or `..`; Claude Code: kebab-case and
  reserved names, `claude`/`anthropic` as whole words warn), Claude component paths start with
  `./`, Codex fields are camelCase and the `hooks` file exists; all manifests agree on name and
  version (`NAME_MISMATCH`, `VERSION_MISMATCH`).
- **Components**: skills only as immediate `skills/<name>/` folders, frontmatter on line 1,
  `name` equal to the folder and valid, a `description`; plugin agents need `name` and
  `description` and lose `hooks`, `mcpServers`, `permissionMode`; plugin `mcp.json` variants
  (`stdio` with a one-token `command`, `streamable-http`/`sse` with an https URL) and `cwd`
  prefixes; hook files wrapped in `"hooks"`, scripts addressed through the plugin-root
  variable, no writes under the plugin root (state goes to `${PLUGIN_DATA}` /
  `${CLAUDE_PLUGIN_DATA}`), Copilot `bash` + `powershell` rather than `command`, `cwd` on
  `preToolUse`; eval cases without `TODO`.
- **Collisions**: a project skill with the same name as a plugin skill silently wins in
  Copilot and Claude Code (`PL-SKILL-COLLISION` from the lint run below).
- **[tooling lint](tooling-lint.md)** on the whole plugin folder.
- **Host validators**, each free and without sign-in; statuses `pass`, `fail`, `error`,
  `unknown`, `skipped`, `not-applicable` (only `pass` is a pass):

| Validator | What it proves |
|---|---|
| `claude plugin validate --strict --json` on the plugin folder and the marketplace root | Claude Code accepts the manifests and components (warnings fail `--strict`) |
| `claude plugin eval <dir> --case __adc_load_check__` | every eval case parses (no case runs, nothing is billed) |
| `copilot --plugin-dir <dir> skill list --json` in a throwaway `COPILOT_HOME` | Copilot CLI loads the plugin and lists each of its skills with source `plugin` |
| `codex plugin marketplace add`, `codex plugin add <name>@<marketplace>`, `codex debug prompt-input` in a throwaway `CODEX_HOME` | Codex installs the plugin from the repository marketplace and shows each skill as `<plugin>:<skill>` |

The throwaway homes are deleted afterwards, so the user's Copilot and Codex configuration is
never touched. `ADC_CLAUDE_CLI`, `ADC_COPILOT_CLI`, `ADC_CODEX_CLI` point at a CLI that is not
on `PATH`. Hook loading cannot be observed without a session: check `/env` (Copilot) and
`/hooks` (Codex) by hand.

## 4. test

`node "$ADC" tooling plugin test [dir] --json [--run]` lists `local_test_commands[]`, each with
`host`, `purpose`, `cost` (`free` or `paid`), `side_effects`, and the `bash`, `powershell` and
`cmd` spelling. `--run` executes the free, side-effect-free checks above and reports them in
`ran[]` (exit 1 if one fails). Paid commands are never run by the script:

- Claude Code: `claude --plugin-dir <dir> -p "..." --output-format json`; outcome evals
  `claude plugin eval <dir> --trust-plugin --json --threshold 0.8 --max-cost-usd 10 --model <id>
  --no-publish` ([tooling-eval](tooling-eval.md)); `claude plugin details <name>` for the
  always-on cost after installing.
- Copilot CLI: `COPILOT_PLUGIN_DIR_ONLY=true copilot --plugin-dir <dir> -p "..." --output-format
  json --no-ask-user`; installing goes through the marketplace (`copilot plugin marketplace add
  .` then `copilot plugin install <name>@<marketplace>`): Copilot CLI 1.0.103 warns that direct
  path installs are deprecated, and a plugin from a local marketplace folder loads live.
- Codex: `codex plugin marketplace add .` then `codex plugin add <name>@<marketplace>`; `/plugins`.

## 5. release

`node "$ADC" tooling plugin release [dir] --version X.Y.Z --json [--write]`

- Sets `version` in every manifest and in the marketplace entries that carry one (dry run
  without `--write`), and reports mismatches, a dirty plugin folder and tags that already exist.
- Writes `SHA256SUMS` of the plugin files to `.adc/tooling/releases/<name>-<version>/` (attach
  it to the GitHub release; `.adc/` is never committed).
- Returns the tags (`vX.Y.Z` for Copilot and Codex; `<name>--v<version>` from
  `claude plugin tag <dir> --push` for Claude Code) and a `pin` object for consumers:
  `{ "source": "github", "repo": "OWNER/REPO", "ref": "vX.Y.Z", "sha": "<40-character commit>",
  "path": "plugins/<name>" }`.
- `release_steps[]`: changelog entry, commit, tag, push, pin, publish `SHA256SUMS`, and the
  update rules: Copilot ignores a repository-level `autoUpdate` (users run `copilot plugin
  update <name>` or enable it in user or managed settings); Claude Code does not update a
  pinned manifest version until it changes (bump it every release, or omit it so commits drive
  updates) and needs a marketplace `renames` entry after a rename; Codex users run
  `codex plugin marketplace upgrade`.

## 6. Enterprise distribution

| Host | Allow and enable |
|---|---|
| Copilot | `extraKnownMarketplaces` + `enabledPlugins` in `.github/copilot/settings.json` (also read by the cloud agent) or managed settings; `strictKnownMarketplaces` allow-lists |
| Claude Code | managed `extraKnownMarketplaces` / `enabledPlugins`; `strictKnownMarketplaces` must include the marketplace |
| Codex | `requirements.toml` `marketplaces.allowed_sources` and `plugins` |

## 7. Known limits

- Agent Plugins 1.0 defines no portable hooks, agents, commands or rules: they are
  client-specific (`com.github.copilot/` for Copilot).
- VS Code currently drops the `hooks` field of plugin-provided agents.
- Copilot `preToolUse` `ask` becomes deny in the cloud agent and autopilot.
- A plugin cannot override a same-named project or personal skill.
- Codex reading hooks from `extensions["com.openai"].hooks` in a root Agent Plugins manifest is
  unverified (it loads the skills; hooks need a session to observe).
- Codex and Claude Code export the plugin root to hooks as environment variables; for Copilot
  this is not documented, so the `powershell` entries' `$env:PLUGIN_ROOT` is unverified (the
  `bash` entries work either way).

## Manual fallback (guidance-only mode)

Without Node 24, write "guidance-only mode" in the report and build the tree by hand from the
layout table: copy each skill folder to `plugins/<name>/skills/<skill>/`, write the manifests
(minimal Claude Code manifest: `{"name": "<name>", "version": "0.1.0", "description": "..."}`;
Agent Plugins: the same plus `"$schema"`), and the marketplace entry. Then run the validators
that exist: `claude plugin validate --strict --json plugins/<name>`,
`COPILOT_PLUGIN_DIR_ONLY=true copilot --plugin-dir plugins/<name> skill list --json`
(PowerShell: `$env:COPILOT_PLUGIN_DIR_ONLY='true'; copilot --plugin-dir plugins/<name> skill list --json`),
and in a test account `codex plugin marketplace add .` + `codex plugin add <name>@<marketplace>`.
Checksums: `find plugins/<name> -type f -exec sha256sum {} +` (PowerShell:
`Get-ChildItem plugins/<name> -Recurse -File | Get-FileHash -Algorithm SHA256`).
