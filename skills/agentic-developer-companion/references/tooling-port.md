# Tooling port

`tooling port` translates one tooling artifact between GitHub Copilot, Claude Code and OpenAI
Codex: instructions, scoped rules, agents, prompt files, Claude commands, chat modes, skills,
hooks and MCP configs. Every field a target cannot represent is listed in `dropped_fields[]`,
and everything a human must still do is in `manual_steps[]`; nothing is lost silently.

## Contents

- [Run it](#run-it)
- [Translation map](#translation-map)
- [Hooks in detail](#hooks-in-detail)
- [Agents in detail](#agents-in-detail)
- [MCP in detail](#mcp-in-detail)
- [Writing rules](#writing-rules)
- [Report](#report)
- [Manual fallback (guidance-only mode)](#manual-fallback-guidance-only-mode)

## Run it

1. Resolve `ADC` as described in [SKILL.md](../SKILL.md).
2. Dry run and show the plan: `node "$ADC" tooling port <path> --to copilot|claude|codex|all --dry-run --json`
   (`<path>` is a file at its host location, or a skill folder; `--to` takes a comma list,
   default `all` = every host except the source's own).
3. After the user confirms, run it without `--dry-run`. `--out <dir>` writes the targets under
   another folder (to review a round trip); `--from <host>` asserts the source host.
4. Lint the results for the target hosts: `node "$ADC" tooling lint <written paths> --json`.

Output: `{ source{path, kind, host}, targets[], out, dry_run, written[{path, action}], skipped[],
backups[], dropped_fields[{file, field, value?, reason}], manual_steps[], notes[] }`. Actions:
`create`, `merge`, `overwrite`, `unchanged`, `would-*` in a dry run. Exit `0`, `2` usage (unknown
file kind, bad host), `3` tracked `.adc/`.

The format is recognized by location: `.github/copilot-instructions.md`,
`.github/instructions/*.instructions.md`, `AGENTS.md` (root or nested), `CLAUDE.md`,
`.claude/rules/*.md`, `.github/agents/*.agent.md`, `.claude/agents/*.md`,
`.github/prompts/*.prompt.md`, `.github/chatmodes/*.chatmode.md`, `.claude/commands/**/*.md`,
`<skills-dir>/<name>/`, `.github/hooks/*.json`, `.claude/settings.json`, `.codex/hooks.json`,
`.mcp.json`, `.github/mcp.json`, `.vscode/mcp.json`, `.codex/config.toml`.

## Translation map

| From | To | Mapping | Lost or manual |
|---|---|---|---|
| `.github/copilot-instructions.md`, `CLAUDE.md`, `AGENTS.md` | each other | Claude Code gets an `@<source>` import in `CLAUDE.md` (inside a marked section, never twice); Codex gets one `AGENTS.md` with the imports inlined; Copilot reads `AGENTS.md` and `CLAUDE.md` natively, other sources become `.github/copilot-instructions.md` | Codex has no `@import` (re-run the port after editing an imported file); an `AGENTS.md` generated from a Copilot or Claude file makes Copilot load the rules twice: prefer `AGENTS.md` as the source; Copilot code review reads only `copilot-instructions.md` and path-specific files |
| `.github/instructions/<t>.instructions.md` (`applyTo`) | `.claude/rules/<t>.md` (`paths`), nested `AGENTS.md` | glob list kept; Codex gets a marked section in `<dir>/AGENTS.md` per static directory prefix | `excludeAgent` (Claude, Codex); Codex scopes by directory only, so `src/api/**/*.ts` applies to all of `src/api/` |
| `.claude/rules/<t>.md` | Copilot, Codex | `paths` to `applyTo`; no `paths` = `applyTo: "**"` | as above |
| `.github/agents/<n>.agent.md` | `.claude/agents/<n>.md` | `tools` aliases to Claude tool names; `model`; `user-invocable` and `disable-model-invocation` (kept for round trips; Claude Code does not document them for subagents); `skills`; `include-custom-instructions` is the inverse of `omitClaudeMd` (a Copilot agent without it gets `omitClaudeMd: true`) | `handoffs`, `mcp-servers`, `target`, `metadata`, `argument-hint`, `models`, `hooks`; check the model name |
| `.claude/agents/<n>.md` | `.github/agents/<n>.agent.md` | as above, reversed; `effort` to `reasoningEffort` (low, medium, high) | `permissionMode`, `memory`, `hooks`, `mcpServers`, `disallowedTools`, `maxTurns`, `isolation`, `color`, ...; tools without an alias (for example `AskUserQuestion`) |
| any agent | Codex | a skill in `.codex/skills/<n>/` with `agents/openai.yaml` (`default_prompt`, `allow_implicit_invocation`) | `tools` (state limits in the body), `model`, all other fields; the `.codex/agents/<n>.toml` role format is unverified and not generated |
| `.github/prompts/<n>.prompt.md` | a skill per host | `name`, `description`, `argument-hint` kept, body kept, `disable-model-invocation: true` added (Codex: `allow_implicit_invocation: false`) | `agent`, `model`, `tools` (as VS Code's own migration); `${input:...}`, `${selection}`, `#file:` variables must be rewritten by hand |
| `.claude/commands/<a>/<b>.md` | a skill `<a>-<b>` per host | `description`, `argument-hint`, `allowed-tools`, `disable-model-invocation`, `model` (Claude only) | `$ARGUMENTS`, `$1`, bang-backtick blocks are Claude-only; delete the command once the skill works |
| `.github/chatmodes/<n>.chatmode.md` | `.github/agents/<n>.agent.md` | `name`, `description`, `tools`, `model`, body | chat-mode tool sets are not agent aliases: check `tools` |
| a skill folder | another host's skill folder | every file copied; Codex: `disable-model-invocation: true` becomes `agents/openai.yaml` with `allow_implicit_invocation: false` | fields the target ignores are listed; Claude-only placeholders are flagged; keep the copies in sync with `--force` re-runs |
| hooks | hooks | see below | Copilot `exec`; Claude `if`, `async`, `onFailure`, `once`; Codex has no `cwd` or `env`; non-command handlers (`http`, `prompt`, `agent`, `mcp_tool`) |
| MCP | MCP | see below | `${input:...}` (VS Code only), cloud-agent `tools`, host-only fields |

Plugin manifests are not ported: use [tooling-plugin](tooling-plugin.md).

## Hooks in detail

Events (Copilot camelCase to Claude Code and Codex PascalCase): `sessionStart` SessionStart,
`sessionEnd` SessionEnd, `userPromptSubmitted` UserPromptSubmit, `preToolUse` PreToolUse,
`postToolUse` PostToolUse, `postToolUseFailure` PostToolUseFailure (Claude only), `agentStop`
Stop, `subagentStart` SubagentStart, `subagentStop` SubagentStop, `preCompact` PreCompact,
`permissionRequest` PermissionRequest, `notification` Notification (Claude only). Copilot-only
`errorOccurred` and `userPromptTransformed`, and any event the target lacks, are dropped.

Matchers are translated as tool-name lists: Copilot `bash`/`powershell` = `Bash`, `view` =
`Read`, `create` = `Write`, `edit`/`str_replace` = `Edit`, `grep`, `glob`, `task` = `Agent`;
Codex sees only `Bash`, `apply_patch` (as `Edit`/`Write`) and `Agent`, so other names are
dropped there. Regex matchers are copied unchanged. Events that ignore matchers lose them.

Commands:

- A plain program call (`node scripts/check.mjs --x`, no pipes or chaining) becomes one argv
  and is rendered natively: Copilot `bash` + `powershell`; Codex `command` (sh) +
  `commandWindows` (cmd); Claude Code one shell string. Shell strings that are not plain calls
  are copied per shell, and a missing shell variant is a manual step.
- Repository `.claude/settings.json` hooks keep repository-relative script paths: Copilot CLI
  and VS Code run them too, in bash and PowerShell, where `${CLAUDE_PROJECT_DIR}` does not
  expand. Start the hosts from the repository root. `${CLAUDE_PROJECT_DIR}/x` becomes `x` for
  the other hosts.
- `timeoutSec` and `timeout` map to each other (Copilot default 30; more than 30 is flagged).
- Output shapes differ (Copilot top-level `additionalContext` / `permissionDecision`, Claude
  Code and Codex `hookSpecificOutput`, Codex rejects unknown fields): when the source host
  differs, the handler must be told which dialect to print (a `--dialect` argument).
- Copilot targets go to `.github/hooks/<stem>.json`; Claude Code merges into
  `.claude/settings.json`; Codex merges into `.codex/hooks.json`. A `.github/hooks` file and the
  same hook in `.claude/settings.json` both run in Copilot CLI: keep one.

## Agents in detail

Copilot aliases to Claude Code tools: `execute`/`shell` = `Bash`, `read` = `Read`, `edit` =
`Edit` + `Write`, `search` = `Grep` + `Glob`, `agent` = `Agent`, `web` = `WebFetch` +
`WebSearch`, `todo` = `TodoWrite`, `server/*` = `mcp__server__*`, `server/tool` =
`mcp__server__tool`, `*` = all tools (no `tools` field). The reverse mapping collapses back to
the aliases. Claude Code agent names cannot contain `:`. Copilot CLI also reads `.claude/agents/`
directly; an agent in both places is deduplicated by name (the `.github/agents` copy wins).

## MCP in detail

| Target | File | Shape |
|---|---|---|
| Claude Code | `.mcp.json` | `mcpServers.<n>`: `type` `stdio` or `http`/`sse`, `command`, `args`, `env`, `url`, `headers` |
| Copilot CLI | `.github/mcp.json` (also reads `.mcp.json`) | same, `type: local` for stdio, `tools: ["*"]`; the cloud agent needs the same JSON pasted into repository settings, secrets as `COPILOT_MCP_*` |
| Codex | `.codex/config.toml` (trusted projects) or `~/.codex/config.toml` | `[mcp_servers.<n>]` `command`, `args`, `env` (literals), `env_vars` (forwarded names), `url`, `bearer_token_env_var`, `http_headers`, `env_http_headers`, `enabled_tools` |

VS Code `${input:<id>}` prompts become `${<ID>}` environment references, with a manual step
per variable (password inputs are never written); `envFile` and other VS Code-only fields are
dropped. A literal value that looks like a credential is flagged.

## Writing rules

- A new file is created; an existing one is left alone (`skipped[]`) unless `--force`, which
  merges JSON hooks and MCP configs, TOML tables and marked Markdown sections
  (`<!-- adc:port begin <source> -->` ... `end`), and overwrites anything else, always with a
  backup under `.adc/tooling/backups/<timestamp>/`.
- Generated instruction files start with `<!-- generated by agentic-developer-companion port
  from <source>; edit the source and re-run tooling port -->`. Edit the source, then re-run:
  an identical result is `unchanged`.
- Run it again after every edit of the source; two hand-edited copies drift.

## Report

List the written files with their action, then `dropped_fields[]` as `field | value | reason`,
then `manual_steps[]` as a checklist, then the lint result of the written files per host.

## Manual fallback (guidance-only mode)

Without Node 24, translate by hand with the map above and write "guidance-only mode" in the
report. For each source field: keep it if the target documents it, otherwise list it as
dropped with the reason.

- Instructions: create `CLAUDE.md` with the single line `@AGENTS.md` (plus Claude-only
  notes); for Codex concatenate the imported files into `AGENTS.md`.
- Scoped rules: copy the body; `applyTo: "a,b"` becomes `paths:` with one list item per glob;
  for Codex put the body under a heading in `<dir>/AGENTS.md`.
- Agents: rewrite `tools` with the alias table; move the body unchanged.
- Hooks: rename events with the table; split each command into `bash` and `powershell`
  (Copilot) or `command` and `commandWindows` (Codex); check JSON with `python3 -m json.tool
  <file>` (PowerShell `Get-Content <file> -Raw | ConvertFrom-Json`).
- Compare a round trip with `git diff --no-index <original> <round-tripped>`.
