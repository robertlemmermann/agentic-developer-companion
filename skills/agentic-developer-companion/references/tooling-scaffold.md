# Tooling scaffold

`tooling scaffold <kind> --for copilot|claude|codex|all` writes known-good starting points for
the user's own instructions, skills, agents, prompt files, hooks, MCP configs and plugins, in
each host's real location and shape. Templates come from `assets/templates/tooling.tmpl` and
`assets/templates/evals/`; frontmatter, hook, MCP and plugin files are rendered in code from the same
model `tooling port` uses, so a scaffold and a port always agree.

## Contents

- [Run it](#run-it)
- [What each kind writes](#what-each-kind-writes)
- [Options per kind](#options-per-kind)
- [Guidance baked into the templates](#guidance-baked-into-the-templates)
- [After scaffolding](#after-scaffolding)
- [Manual fallback (guidance-only mode)](#manual-fallback-guidance-only-mode)

## Run it

1. Ask only what detection cannot know: the kind, the hosts the team uses (default `all`), a
   name and a one-sentence description (what + when + boundary) for skills, agents and prompts.
2. Dry run and show the file list: `node "$ADC" tooling scaffold <kind> --for <hosts> [options] --json`
3. After the user confirms, the same command with `--write`. Existing files are never changed
   (`skipped[]`); `--force` merges JSON and TOML configs (or overwrites Markdown) and keeps a
   backup under `.adc/tooling/backups/<timestamp>/`.
4. Follow `next_steps[]` and pass `manual_steps[]` on to the user verbatim.

`--out <dir>` writes the tree elsewhere (to inspect it first); scaffolding into the companion's
own skill folder is refused. `node "$ADC" scaffold <kind>` is the same command.

Output: `{ kind, hosts[], out, dry_run, written[{path, action, host, kind}], skipped[{path, reason}],
backups[], next_steps[], manual_steps[] }`. Exit `0`, `2` usage (bad kind, host, name or
option), `3` tracked `.adc/`.

## What each kind writes

| Kind | Copilot | Claude Code | Codex |
|---|---|---|---|
| `instructions` | `AGENTS.md`, `.github/copilot-instructions.md` (Copilot-only notes), `.github/instructions/<topic>.instructions.md` (`applyTo`, optional `excludeAgent`) | `AGENTS.md`, `CLAUDE.md` = `@AGENTS.md` + Claude-only notes, `.claude/rules/<topic>.md` (`paths`) | `AGENTS.md` |
| `skill` | `.github/skills/<name>/` (Copilot only) or `.agents/skills/<name>/` (with Codex) | `.claude/skills/<name>/` | `.agents/skills/<name>/` + `agents/openai.yaml` |
| `agent` | `.github/agents/<name>.agent.md` (`tools: [read, search]`) | `.claude/agents/<name>.md` (`tools: Read, Grep, Glob`) | `.codex/skills/<name>/` skill + `agents/openai.yaml` with `default_prompt` |
| `prompt` | `.github/prompts/<name>.prompt.md` **and** the equivalent skill with `disable-model-invocation: true` | the skill (`.claude/skills/<name>/`, user-invoked only) | the skill with `policy.allow_implicit_invocation: false` |
| `hooks` | `.github/hooks/<name>.json`: `version: 1`, `bash` + `powershell`, `timeoutSec: 10`; `preToolUse` wrapped in a missing-Node guard | `hooks` block merged into `.claude/settings.json` | `.codex/hooks.json`: `command` + `commandWindows` |
| `mcp` | `.github/mcp.json` (Copilot only) or `.mcp.json`; the cloud-agent JSON for repository settings in `next_steps` | `.mcp.json` (`mcpServers`) | `[mcp_servers.<name>]` appended to `.codex/config.toml` |
| `plugin` | see [tooling-plugin](tooling-plugin.md) (`tooling plugin init`) | | |

Every `hooks` scaffold also writes the handler `scripts/hooks/<name>.mjs` (one Node file for
all hosts, `--dialect` selects the output shape), `scripts/hooks/<name>.test.mjs` and
`scripts/hooks/fixtures/<name>.json` (seven payload cases across the Copilot, Claude Code and
Codex dialects, including malformed and empty input and `stop_hook_active`).

Every `skill` scaffold adds, in the Claude Code copy (or the only copy):
`evals/trigger-set.json` (20 labeled TODO queries, [tooling-eval](tooling-eval.md)),
`evals/<name>-basic/prompt.md` + `graders/skill-used.md` + `graders/outcome.md` (a
`claude plugin eval` case) and `evals/evals.json` (skill-creator's format; see
[tooling-eval](tooling-eval.md) §4).

Placement follows [host notes](host-notes.md) §3. A Codex agent goes to `.codex/skills/`: Codex
reads it there, Copilot does not, so it never shows next to the real Copilot agent. Claude Code
reads only `.claude/skills/`, so `--for all` writes two copies of a skill; after editing one,
sync with `node "$ADC" tooling port .agents/skills/<name> --to claude --force`.

## Options per kind

| Kind | Options |
|---|---|
| `instructions` | `--topic <t>` (default `testing`), `--apply-to "glob,glob"` (default test-file globs), `--exclude-agent code-review\|cloud-agent` |
| `skill`, `prompt` | `--name` (1-64, lowercase, digits, single hyphens, no `claude`/`anthropic`), `--description` (at most 1,024 characters, no XML tags), `--license`, `--skill-root <dir>` (one copy in that folder instead) |
| `agent` | `--name`, `--description`, `--skills a,b` (skills to preload: shared conventions belong there, not in the agent body) |
| `hooks` | `--name`, `--events PostToolUse,PreToolUse,SessionStart,SessionEnd,Stop,UserPromptSubmit` (default `PostToolUse`), `--hooks-dir` (default `scripts/hooks`) |
| `mcp` | `--server <name>`, then `--command <exe> [--args a,b]` (stdio) or `--url https://...` (http; plain http only for localhost), `--env VAR,VAR` (passed as `${VAR}` references, never values) |

The install, test, lint and type-check commands in `AGENTS.md` come from the project's own
scripts first (`npm test`, not the runner behind it), then from `detect`; anything not found
is a placeholder line to fill in or delete.

## Guidance baked into the templates

Budgets, one source for shared rules, prompt files to skills: [tooling-optimize](tooling-optimize.md)
§2 and §4; monorepo placement: [tooling-practices](tooling-practices.md) §7.

- **Instructions**: `AGENTS.md` is the canonical source, host files hold host-only notes; one
  verifiable rule per line, commands over prose, valid in bash, PowerShell and cmd.
- **Skills**: the six spec fields only (`name`, `description`, `license`, `compatibility`,
  `metadata`, `allowed-tools`), `name` equal to the folder, `metadata.version`, body under 500
  lines with a `## Gotchas` section, details in `references/` (one level deep, linked from
  SKILL.md), deterministic steps in `scripts/`, forward slashes, evals before the body.
- **Agents**: least-privilege tools, an explicit output contract (verdict, `file:line`
  findings, commands and exit codes), "unknown" instead of guessing.
- **Hooks**: read stdin, print one ASCII-only JSON object, exit 0, fail open on any error and
  after 5 seconds (the configs allow 10), never block a stop twice (`stop_hook_active`), no
  network or repository scans. Copilot `preToolUse` is fail-closed when the command crashes,
  hence the guard that prints `{}` when Node is missing. Script paths:
  [tooling-port](tooling-port.md#hooks-in-detail); trust: [host notes](host-notes.md) §1.
- **MCP**: one server definition rendered per host; secrets only as environment references;
  packages pinned to an exact version (`example-mcp-server@1.0.0`, never `@latest`).

## After scaffolding

1. Fill every `TODO` and `(placeholder)` line; for skills write the trigger set first.
2. Lint for the targeted hosts: `node "$ADC" tooling lint <paths> --json` (see
   [tooling-lint](tooling-lint.md)); `--strict` before shipping. The prompt-equivalent skill
   keeps `disable-model-invocation` on purpose, so `--strict` reports it.
3. Measure: `node "$ADC" tooling cost --json` ([tooling-optimize](tooling-optimize.md)) and,
   for skills, `node "$ADC" tooling trigger-set <skill-dir>` ([tooling-eval](tooling-eval.md)).
4. Hooks: `node --test scripts/hooks/<name>.test.mjs`, then edit `decide()`.
5. Before the first real change, record a baseline: `node "$ADC" tooling modify baseline <path>`
   ([tooling-modify](tooling-modify.md)).

Report the file list (created, skipped, merged), the manual steps and the measurements.

## Manual fallback (guidance-only mode)

Without Node 24, write "guidance-only mode" in the report, create the files at the locations
in the table above, and check each against [tooling-lint](tooling-lint.md).

Skill (`<dir>/<name>/SKILL.md`; `<dir>` is `.agents/skills`, `.github/skills` or `.claude/skills`):

```markdown
---
name: release-notes
description: >-
  Formats release notes from merged pull requests. Use when the user asks for release notes
  or a changelog summary. Not for writing code.
metadata:
  version: "0.1.0"
---

# release-notes

## Steps
1. (What to read or run, with the exact command.)

## Gotchas
- (What an agent gets wrong without this skill.)
```

Codex invocation policy (`<skill>/agents/openai.yaml`, optional):

```yaml
interface:
  display_name: release-notes
  default_prompt: "Use $release-notes: format release notes from merged pull requests."
policy:
  allow_implicit_invocation: true
```

Copilot agent (`.github/agents/reviewer.agent.md`): frontmatter `name`, `description`,
`tools: ['read', 'search']`, then the role, inputs, output contract and rules. Claude Code agent
(`.claude/agents/reviewer.md`): the same with `tools: Read, Grep, Glob`.

Copilot hook (`.github/hooks/<name>.json`):

```json
{ "version": 1, "hooks": { "postToolUse": [ { "type": "command",
  "bash": "node scripts/hooks/check.mjs --dialect copilot --event postToolUse",
  "powershell": "node scripts/hooks/check.mjs --dialect copilot --event postToolUse",
  "timeoutSec": 10 } ] } }
```

Claude Code (`.claude/settings.json`) and Codex (`.codex/hooks.json`) use
`{"hooks": {"PostToolUse": [{"matcher": "Edit|Write", "hooks": [{"type": "command", "command":
"node scripts/hooks/check.mjs --dialect claude --event PostToolUse", "timeout": 10}]}]}}`; Codex
adds `"commandWindows"` with the same command and `--dialect codex`.

MCP (`.mcp.json`): `{"mcpServers": {"docs": {"type": "stdio", "command": "npx", "args": ["-y",
"docs-mcp@1.2.3"], "env": {"DOCS_TOKEN": "${DOCS_TOKEN}"}}}}`; Copilot's `.github/mcp.json`
uses `"type": "local"` and `"tools": ["*"]`; Codex: `[mcp_servers.docs]` with `command`,
`args` and `env_vars = ["DOCS_TOKEN"]` in `.codex/config.toml`.

Check JSON with `python3 -m json.tool <file>` (PowerShell: `Get-Content <file> -Raw | ConvertFrom-Json`)
and that each skill's `name` equals its folder.
