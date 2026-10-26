# Tooling lint

`tooling lint` checks instructions, skills, agents, prompt files, hooks, plugins, marketplaces and
MCP configs against each host's documented rules: `spec` (the Agent Skills specification and its
`skills-ref` validator), `copilot` (Copilot CLI, VS Code Copilot harness, cloud agent), `claude`
(Claude Code) and `codex`. Each finding names a catalog rule, host, severity and line; read-only.

## Contents

- [Run it](#run-it)
- [Read the result](#read-the-result)
- [Fix, re-run, report](#fix-re-run-report)
- [Manual fallback (guidance-only mode)](#manual-fallback-guidance-only-mode)
- [Rule catalog](#rule-catalog)
- [Sources](#sources)

## Run it

Lint what the user named; with no path, the whole repository:
`node "$ADC" tooling lint [paths...] --json [--host all|copilot|claude|codex] [--strict]`

| Option | Effect |
|---|---|
| `paths...` | Files or folders. Folders are searched for known tooling locations (dependency and build folders are skipped; linked folders are followed); a file named explicitly outside them is classified by its content. |
| `--host` | Report only that host. With `--strict` the `spec` results stay included. |
| `--strict` | For anything shipped or shared: only the six spec fields and block-style YAML in `SKILL.md`, pinned marketplace sources, `timeoutSec` on Copilot hooks, and **every warning and security finding fails**. |
| `--no-external` | Skip the hosts' own validators (same as `ADC_LINT_NO_EXTERNAL=1`). |
| `--allow-host <h>` | Repeatable. HTTP hooks to `h` are not reported as `SEC-HTTP-HOOK`. |

Exit `0` clean, `1` findings (errors; with `--strict` also warnings and security findings), `2` usage, `3` tracked `.adc/` or a damaged rule catalog (reinstall the skill), `4` a file could not be checked (listed in `internal_errors[]`; never call it clean).

External validators run when installed and are merged as `EXT-*` findings:

| Validator | Runs for | Notes |
|---|---|---|
| `skills-ref validate <skill>` | every skill | Install: `uv tool install "git+https://github.com/agentskills/agentskills#subdirectory=skills-ref"`. Parses with strictyaml. Only a "Validation failed" report is `fail`; a usage error or crash is `error`. |
| `claude plugin validate <dir> --strict --json` | Claude plugins and marketplaces, `skills/` folders | Claude Code 2.1.259+. A bare skills folder returns `contents: []`: reported `not-applicable`, never a pass. Plugin-directory listing findings (README, LICENSE, icon) become notes. |
| `gh skill publish --dry-run <root>` | skills under `skills/*/`, `skills/<scope>/*/`, `<dir>/` at the root, `plugins/<scope>/skills/*/` | gh 2.90.0+. Its errors are errors, its warnings notes; repository lines (tag protection, remote) go to the summary. |
| `copilot skill list --json`, `copilot instruction list --json` | skills in a Copilot skill folder; root-level instruction files | No sign-in needed. A same-named copy that Copilot loads from elsewhere is a note (first found wins). |
| `codex debug prompt-input "x"` | skills in `<root>/.agents/skills`, `~/.agents/skills` | Renders the prompt locally; no model call, no sign-in. The skill must appear in `<skills_instructions>`. |
| `waza spec verify <skill> <eval.yaml> --fail` | skills with `evals/<name>/eval.yaml` | Copilot skill evals. In VS Code the Chat Customizations Evaluations extension (wraps waza) shows the same diagnostics. |
| `codex doctor --json` | Codex `config.toml` files Codex loads from the root | Reports settings Codex ignores (unknown keys) per layer; no model call, but it probes OpenAI reachability. `codex exec --strict-config` would bill a model turn and is never run. |

## Read the result

`{ root, files[{ path, kind, sub, scope, reads[], host_results[{ host, errors[], warnings[], notes[] }] }], security[], external[], summary, internal_errors[]? }`; `summary.clean` is true only when nothing fails and `summary.unchecked` is 0.
A finding is `{ rule, line, message, field?, evidence? }`. `reads` lists the hosts that load the file
from where it lies, and only those get results: a skill in `.claude/skills` is checked for Claude
Code and Copilot, `.github/skills` for Copilot, `.agents/skills` for Copilot and Codex, a source
tree such as `skills/<name>/` for every host (lint the source to check portability). **error** =
the host rejects or ignores the file or entry; **warning** = it loads but behaves differently or is
not portable; **note** = information, never fails. `security[]` holds the `SEC-*` group (evidence
masked). External statuses: `pass`, `fail`, `error` (crashed or no parsable report), `skipped`
(absent, too old), `not-applicable` (cannot validate this target); only `pass` is a pass.

Lint ignores the `metadata.github-*` and `metadata.local-path` provenance that `gh skill install`
adds while rewriting the frontmatter ([host notes](host-notes.md) §8).

## Fix, re-run, report

1. Fix errors for the hosts the user targets, then warnings; explain each fix with the rule's source.
2. Never make lint pass by moving or renaming a file out of a discovered location, dropping
   `--strict` or external validators the user asked for, or deleting a field the user needs.
   A host extra kept on purpose (for example Claude-only `context: fork`) is a portability
   trade-off: keep it, name the hosts that ignore it, and do not lint that file with `--strict`.
3. Typical fixes: quote a scalar that contains `": "` (`SK-FM-COLON`); write YAML in block
   style (`SK-FM-STRICTYAML`); rename the folder or the `name` (`SK-NAME-DIR`); split a Copilot
   `command` into `bash` and `powershell` (`HK-XS-COMMAND`, `HK-CP-NO-WINDOWS`); print a JSON
   decision on exit 0 instead of exit 2 (`HK-CX-EXIT2`); add `commandWindows` (`HK-CX-WINDOWS`);
   pin `sha`, versions and packages (`MK-UNPINNED`, `SEC-UNPINNED`); link or delete orphaned
   references (`SK-REF-UNLINKED`). Port between formats with [tooling-port](tooling-port.md).
4. Re-run the same command until it exits 0; run `--strict` before shipping a skill or plugin.
5. Report a table per file (`host | rule | line | message | fix`), the security list, each
   external validator with its status, and the exact command. Write "not verified by <tool>"
   for every validator that was skipped, errored or not applicable.

## Manual fallback (guidance-only mode)

Without Node 24, check by hand, write "guidance-only mode" in the report, and walk the catalog per file kind.

1. Tooling files: `git ls-files | grep -E '(SKILL\.md|AGENTS\.md|CLAUDE\.md|GEMINI\.md|instructions\.md|\.prompt\.md|\.agent\.md|agents/.*\.md|hooks.*\.json|settings(\.local)?\.json|plugin\.json|marketplace\.json|mcp.*\.json|config\.toml|openai\.yaml)$'`
   (PowerShell: the same pattern with `git ls-files | Select-String -Pattern '<pattern>'`).
2. SKILL.md: `head -n 1 SKILL.md` prints exactly `---` (PowerShell `Get-Content SKILL.md -TotalCount 1`);
   `name:` equals the folder name; the body stays under 500 lines (`wc -l SKILL.md` is an upper
   bound; `(Get-Content SKILL.md).Count`); `git ls-files <skill-dir> | wc -l` is at most 100
   (`(git ls-files <skill-dir>).Count`); every file in `references/` is named in SKILL.md:
   `for f in references/*; do grep -qF "$f" SKILL.md || echo "unlinked: $f"; done`
   (`Get-ChildItem references | Where-Object { -not (Select-String -Path SKILL.md -SimpleMatch "references/$($_.Name)" -Quiet) }`).
3. JSON parses: `python3 -m json.tool <file> > /dev/null` (`Get-Content <file> -Raw | ConvertFrom-Json | Out-Null`).
4. Run whichever validators of the table above are installed.

## Rule catalog

| Rule | Hosts (E error, W warning, N note; strict: with `--strict`) | Checks | Sources |
|---|---|---|---|
| **Skills (`SKILL.md`, `agents/openai.yaml`)** | | | |
| `SK-FILENAME` | spec E, copilot E, claude E, codex E | The skill file is named exactly SKILL.md (Codex matches it case-sensitively) | `cx-skills` `cp-skills` |
| `SK-FM-LINE1` | spec E, copilot E, claude E, codex E | Frontmatter opens with "---" on line 1 | `skills-ref` `cx-skills` `cl-skills` |
| `SK-FM-BOM` | spec W, codex W | No UTF-8 byte-order mark before the opening "---" | `skills-ref` `cx-skills` |
| `SK-FM-YAML` | spec E, copilot E, claude E, codex E | Frontmatter is valid YAML (Claude Code loads a malformed block with no fields) | `cl-skills` `skills-ref` `cx-skills` |
| `SK-FM-COLON` | spec E, copilot E, claude E, codex W | No unquoted ": " inside a scalar (only Codex auto-repairs it) | `cx-skills` `cl-skills` |
| `SK-FM-STRICTYAML` | spec W; strict: spec E | Block-style YAML only: skills-ref parses with strictyaml, which rejects flow collections, anchors, aliases and tags | `skills-ref` `measured` |
| `SK-NAME-REQUIRED` | spec E, copilot E | `name` is present (Claude Code and Codex default to the directory name) | `spec` `cp-skills` |
| `SK-NAME-LENGTH` | spec E, copilot E, claude W, codex E | `name` is 1-64 characters | `spec` `skills-ref` `cx-skills` |
| `SK-NAME-FORMAT` | spec E, copilot E, claude W, codex W | `name` uses lowercase letters, digits and single inner hyphens (VS Code silently skips other names) | `spec` `vsc-skills` `cl-bp` |
| `SK-NAME-DIR` | spec E, copilot E, claude W | `name` equals the skill directory name | `skills-ref` `vsc-skills` |
| `SK-NAME-RESERVED` | claude W | `name` does not contain "claude" or "anthropic" (claude.ai and the Skills API reject it) | `cl-skills` `cl-bp` |
| `SK-NAME-CLAUDE-DIR` | claude E | The skill folder is not named "synced" or "anthropic-skills*" (reserved by Claude Code) | `cl-skills` |
| `SK-DESC-REQUIRED` | spec E, copilot E, claude W, codex E | `description` is present and non-empty (Codex does not load a skill without one) | `spec` `cx-skills` `cl-skills` |
| `SK-DESC-TYPE` | spec E, copilot E, claude E, codex E | `description` is a string | `spec` `cx-skills` |
| `SK-DESC-LENGTH` | spec E, copilot E | `description` is at most 1,024 characters | `spec` `cp-cli` `vsc-skills` |
| `SK-DESC-LISTING` | claude W | `description` plus `when_to_use` stays under the 1,536-character listing cap | `cl-skills` |
| `SK-DESC-XML` | spec W, claude W | `description` contains no XML/HTML tags | `cl-bp` |
| `SK-DESC-PERSON` | claude W | `description` is written in the third person (not "I ..." or "You can ...") | `cl-bp` |
| `SK-FIELD-NONSPEC` | spec W; strict: spec E | Only the six spec fields are portable (skills-ref, gh skill publish and claude.ai uploads reject others) | `skills-ref` `cl-skills` |
| `SK-FIELD-IGNORED` | copilot W, claude W, codex N | A frontmatter field the host does not read | `cp-cli` `vsc-skills` `cl-skills` `cx-skills` |
| `SK-METADATA-MAP` | spec E, codex W | `metadata` is a mapping | `spec` `cx-skills` |
| `SK-METADATA-STRING` | spec W | `metadata` values are strings (quote versions such as "1.0") | `spec` |
| `SK-SHORTDESC` | codex N; strict: codex W | `metadata.short-description` is 25-64 characters (skill-creator guidance; Codex's own skills deviate) | `cx-yaml` `measured` |
| `SK-COMPAT-LENGTH` | spec E, claude W | `compatibility` is 1-500 characters | `spec` `cl-skills` |
| `SK-ALLOWED-TOOLS-TYPE` | spec W | `allowed-tools` is a space-separated string in the spec | `spec` |
| `SK-BODY-LINES` | spec W, claude W | The body stays under 500 lines | `spec` `cl-skills` |
| `SK-BODY-TOKENS` | spec W, claude W | The body stays under about 5,000 tokens (Claude keeps the first 5,000 after compaction) | `spec` `cl-skills` |
| `SK-BODY-EMPTY` | copilot W, claude W, codex W | The body contains instructions | `spec` |
| `SK-SUBST` | spec W, copilot W, codex W | No Claude-only substitutions (the dollar-ARGUMENTS placeholder, dollar-brace CLAUDE_* variables, bang-backtick dynamic context) in a skill meant for every host | `cp-skills` `cx-skills` `cl-skills` |
| `SK-SUBST-POSITIONAL` | claude W | Dollar-digit placeholders (dollar 0 to 9) in the body are replaced with arguments by Claude Code; escape the dollar with a backslash | `cl-skills` |
| `SK-LINK-MISSING` | copilot E, claude E, codex E | Every relative link in SKILL.md resolves to a file in the skill | `vsc-skills` `cl-skills` |
| `SK-LINK-BACKSLASH` | copilot E, claude E, codex E | Links use forward slashes | `vsc-skills` `cl-bp` |
| `SK-LINK-ABSOLUTE` | copilot W, claude W, codex W | Links are relative and stay inside the skill folder (no absolute local paths) | `cl-bp` |
| `SK-REF-UNLINKED` | copilot W, claude W | Every file under references/ is linked from SKILL.md (VS Code loads only referenced files) | `vsc-skills` `cl-skills` |
| `SK-REF-DEPTH` | spec W, claude W | Reference files are one level deep (`references/<file>`) | `spec` `cl-bp` |
| `SK-FOOTPRINT-FILES` | copilot W | The skill folder holds at most 100 files (Copilot lists no more) | `cp-listing` |
| `SK-FOOTPRINT-FOLDER` | copilot W | No folder in the skill has more than 50 entries (Copilot summarizes it) | `cp-listing` |
| `SK-ASSET-SIZE` | copilot W | No file in the skill is larger than 5 MB | `ac-contrib` |
| `CX-YAML-PARSE` | codex E | agents/openai.yaml is valid YAML | `cx-yaml` |
| `CX-YAML-FIELD` | codex W | agents/openai.yaml uses only interface, dependencies and policy keys | `cx-yaml` |
| `CX-YAML-SHORTDESC` | codex N; strict: codex W | `interface.short_description` is 25-64 characters (guidance) | `cx-yaml` `measured` |
| `CX-YAML-PROMPT` | codex N; strict: codex W | `interface.default_prompt` mentions the skill as `$<skill-name>` | `cx-yaml` `measured` |
| `CX-YAML-POLICY` | codex E | `policy.allow_implicit_invocation` is a boolean | `cx-yaml` |
| `CX-YAML-DEPS` | codex W | `dependencies.tools[].type` is "mcp" and names a server | `cx-yaml` |
| **Instructions, agents, commands, prompt files** | | | |
| `CM-FIELD` | claude W, copilot W | Command files accept skill fields except `name` and `paths` | `cl-skills` `cp-cli` |
| `CM-LEGACY` | claude N | .claude/commands is the legacy format; new work belongs in skills | `cl-skills` |
| `PR-HARNESS` | copilot N | Prompt files run only in the VS Code Local harness and Visual Studio (not Copilot CLI, cloud agent or the Copilot harness) | `cp-prompts` |
| `PR-FIELD` | copilot W | Prompt-file frontmatter uses description, name, argument-hint, agent, model, tools | `cp-prompts` |
| `MD-FM-YAML` | copilot E, claude E, codex E | Frontmatter of instruction, agent, command and prompt files is valid YAML | `cl-agents` `cp-agents` `cp-instr` |
| `IN-APPLYTO-MISSING` | copilot W | A .instructions.md file declares `applyTo` | `cp-instr` `ac-contrib` |
| `IN-APPLYTO-GLOB` | copilot E, claude E | `applyTo` / `paths` globs are valid, relative and use forward slashes | `cp-instr` `cl-memory` |
| `IN-EXCLUDEAGENT` | copilot E | `excludeAgent` is "code-review" or "cloud-agent" | `cp-instr` |
| `IN-FIELD` | copilot W, claude W | Instruction frontmatter uses only documented keys | `cp-instr` `cl-memory` |
| `IN-LENGTH` | copilot W | An instruction file stays under about 1,000 lines | `cp-cr` |
| `IN-CLAUDE-LENGTH` | claude W | CLAUDE.md stays under 200 lines | `cl-memory` |
| `IN-AGENTS-BUDGET` | codex W | AGENTS.md files from the root to a directory total at most 32 KiB (Codex truncates) | `cx-agentsmd` |
| `IN-DUPLICATE` | copilot W, claude W, codex W | The same directive is not repeated across always-on instruction files | `vsc-instr` `cl-memory` |
| `IN-CONFLICT` | copilot W, claude W, codex W | Always-on instruction files do not contradict each other | `vsc-instr` `cl-memory` |
| `IN-ABS-PATH` | copilot W, claude W, codex W | No user-specific or absolute local paths | `anti-patterns` |
| `IN-HOSTNAME` | copilot W, claude W, codex W | No internal hostnames or private IP addresses | `anti-patterns` |
| `IN-BASH-ONLY` | copilot W, claude W, codex W | Shell commands have a Windows equivalent | `cp-hooks-howto` `anti-patterns` |
| `IN-CLAUDE-LOCAL` | claude W | No CLAUDE.local.md next to AGENTS.md (it stops AGENTS.md from loading) | `cl-memory` |
| `IN-CLAUDE-AGENTS` | claude W | A CLAUDE.md next to AGENTS.md imports it with @AGENTS.md (Claude ignores AGENTS.md otherwise) | `cl-memory` |
| `IN-IMPORT-MISSING` | copilot E, claude E | Every @import target exists | `cl-memory` `cp-dist` |
| `IN-IMPORT-UNSUPPORTED` | copilot W, codex W | @imports only in files that expand them (not GEMINI.md, *.instructions.md, or Codex AGENTS.md) | `cp-dist` `cx-agentsmd` |
| `IN-IMPORT-ABSOLUTE` | copilot N | Absolute or ~/ @imports: the Copilot docs disagree on support; prefer relative paths | `cp-dist` `cp-cli` |
| `IN-EMPTY` | copilot N, claude N, codex N | The instruction file has content | `cp-instr` |
| `AG-FM-MISSING` | copilot E, claude E | An agent file starts with YAML frontmatter | `cp-agents` `cl-agents` |
| `AG-DESC-REQUIRED` | copilot E, claude E | `description` is present | `cp-agents` `cl-agents` |
| `AG-NAME-REQUIRED` | claude E | `name` is present (Claude Code skips the agent otherwise) | `cl-agents` |
| `AG-NAME-FORMAT` | claude E | `name` is at most 256 characters with no colon | `cl-agents` |
| `AG-FILENAME` | copilot E | Agent file names use only . - _ a-z A-Z 0-9 | `cp-agents` |
| `AG-BODY-LENGTH` | copilot E | The agent prompt is at most 30,000 characters | `cp-agents` |
| `AG-FIELD` | copilot W, claude W | Agent frontmatter uses only documented fields | `cp-agents` `vsc-agents` `cl-agents` |
| `AG-FIELD-SURFACE` | copilot W | Fields that some Copilot surfaces ignore (handoffs, argument-hint in the cloud agent; retired infer; mcp-servers, metadata in VS Code as a note) | `cp-agents` |
| `AG-TOOLS` | copilot W | `tools` entries are known aliases, server/tool, server/* or "*" | `cp-agents` |
| `AG-ENUM` | copilot E, claude E | Enumerated agent fields use documented values | `cp-agents` `cl-agents` |
| `AG-PLUGIN-FIELDS` | claude W | Plugin subagents cannot use hooks, mcpServers, permissionMode or initialPrompt | `cl-plugins` |
| `AG-CODEX` | codex N | Codex has no Markdown agents; port to a skill with a default prompt | `cx-skills` |
| **Hooks (Copilot, Claude Code, Codex) and Codex `config.toml`** | | | |
| `HK-CP-JSON` | copilot E | The hooks file is valid JSON (an invalid file is rejected) | `cp-hooks` |
| `HK-CP-VERSION-MISSING` | copilot W | `version: 1` is present (files without it load since CLI 1.0.5) | `cp-hooks` |
| `HK-CP-VERSION` | copilot E | `version` is 1 (any other value rejects the file) | `cp-hooks` |
| `HK-CP-SHAPE` | copilot E | `hooks` maps event names to arrays of entries | `cp-hooks` |
| `HK-CP-EVENT` | copilot E | Event names are documented Copilot events in one casing | `cp-hooks` |
| `HK-CP-EVENT-UNDOC` | copilot W | PascalCase names without a documented Copilot alias | `cp-hooks` |
| `HK-CP-MIXED-CASE` | copilot W | One file does not mix camelCase and PascalCase events (payload dialects differ) | `cp-hooks` |
| `HK-CP-TYPE` | copilot E | `type` is command, http or prompt | `cp-hooks` |
| `HK-CP-COMMAND` | copilot E | A command entry has bash and/or powershell, command, or exec | `cp-hooks` |
| `HK-CP-NO-WINDOWS` | copilot W | A bash entry also has powershell (or a cross-shell command) for Windows | `cp-hooks-howto` |
| `HK-CP-PS-ONLY` | copilot W | PowerShell-only entries are ignored by the cloud agent | `cp-hooks` |
| `HK-CP-PS-COMPAT` | copilot W | The powershell string also runs under Windows PowerShell 5.1 (no && or \|\|) | `cp-hooks-howto` |
| `HK-CP-EXEC-MIX` | copilot E | `exec` is not combined with bash, powershell or command | `cp-hooks` |
| `HK-CP-EXEC` | copilot W | `exec`/`args` run only in Copilot CLI (not the cloud agent or VS Code) | `cp-hooks` |
| `HK-CP-TIMEOUT` | copilot W | `timeoutSec` at most 30 and not combined with `timeout`; a missing one is a note (warning with --strict) | `cp-hooks` |
| `HK-CP-TIMEOUT-TYPE` | copilot E | `timeoutSec` is a positive number | `cp-hooks` |
| `HK-CP-MATCHER` | copilot E | `matcher` compiles as a regular expression (an invalid one skips the hook) | `cp-hooks` |
| `HK-CP-ASK` | copilot W | No permissionDecision "ask" (it becomes deny in the cloud agent and autopilot) | `cp-hooks` |
| `HK-CP-HTTP` | copilot E | HTTP hooks use https (localhost only with COPILOT_HOOK_ALLOW_LOCALHOST=1, never for preToolUse) | `cp-hooks` |
| `HK-CP-PROMPT` | copilot E | Prompt hooks only on sessionStart | `cp-hooks` |
| `HK-CP-LOCAL-KEYS` | copilot W | No VS Code Local-harness keys (windows, linux, osx, hookSpecificOutput) in .github/hooks | `vsc-hooks` |
| `HK-CP-FIELD` | copilot W | Entries and the file use only documented keys | `cp-hooks` |
| `HK-CP-CLOUD-EVENT` | copilot W | notification and permissionRequest do not work in the cloud agent (.github/hooks is read there) | `cp-hooks` |
| `HK-CP-OUTPUT-IGNORED` | copilot N | Output of errorOccurred, sessionEnd, preCompact and userPromptSubmitted command hooks is not processed | `cp-hooks` |
| `HK-CP-DISABLED` | copilot W | `disableAllHooks: true` turns the file off | `cp-hooks` |
| `HK-CP-PLUGIN-CWD` | copilot W | Plugin preToolUse entries set "cwd": "${PLUGIN_ROOT}" | `cp-2540` |
| `HK-CP-PLUGIN-PATHS` | copilot W | Plugin hooks reach their scripts through ${PLUGIN_ROOT} (relative paths resolve against the project) and keep state in ${PLUGIN_DATA} | `cp-2540` `cp-plugins` |
| `HK-XS-COMMAND` | copilot E | A Copilot `command` string parses in both bash and PowerShell (it is copied to both) | `cp-hooks` |
| `HK-CL-JSON` | claude E | The settings or hooks file is valid JSON | `cl-hooks` |
| `HK-CL-SHAPE` | claude E | Events map to arrays of matcher groups with a `hooks` array; plugin files keep the "hooks" wrapper | `cl-hooks` `cl-plugins` |
| `HK-CL-EVENT` | claude W | Event names are among the 33 Claude Code events (others are ignored at runtime) | `cl-hooks` `cl-validate` |
| `HK-CL-MATCHER-IGNORED` | claude W | No matcher on events that ignore it | `cl-hooks` |
| `HK-CL-MATCHER` | claude E | A regex matcher compiles | `cl-hooks` |
| `HK-CL-TYPE` | claude E | The handler type exists and is supported on its event | `cl-hooks` |
| `HK-CL-FIELD` | claude W | Handlers use only documented fields | `cl-hooks` |
| `HK-CL-IF` | claude E | `if` only on tool events (elsewhere the hook never runs) | `cl-hooks` |
| `HK-CL-EXEC-SHIM` | claude W | Exec form does not start a .cmd/.bat shim (Windows cannot spawn it); use node + script | `cl-hooks` |
| `HK-CL-UNQUOTED-VAR` | claude W | ${CLAUDE_PROJECT_DIR} and ${CLAUDE_PLUGIN_ROOT} are double-quoted in shell form | `cl-hooks` `cl-validate` |
| `HK-CL-ONFAILURE` | claude E | `onFailure` is continue or block (needs Claude Code 2.1.295+; no effect on Stop-type or async hooks) | `cl-hooks` |
| `HK-CL-SHELL` | claude E | `shell` is bash or powershell | `cl-hooks` |
| `HK-CL-ONCE` | claude W | `once` is honored only in skill frontmatter | `cl-hooks` |
| `HK-CL-REPO-EXEC` | claude W, copilot W | Exec-form entries in a repository .claude/settings*.json are also run by Copilot CLI and VS Code; prefer a shell string | `cp-hooks` |
| `HK-CL-PLUGIN-ROOT` | claude W | Plugin hooks reference their files through ${CLAUDE_PLUGIN_ROOT} | `cl-plugins` |
| `HK-CL-PLUGIN-DATA` | claude W | Plugin hooks keep state in ${CLAUDE_PLUGIN_DATA}, not under the plugin root | `cl-plugins` |
| `HK-CX-JSON` | codex E | hooks.json is valid JSON | `cx-hooks` |
| `HK-CX-SHAPE` | codex E | {"hooks": {Event: [{"matcher"?, "hooks": [handler]}]}} | `cx-hooks` |
| `HK-CX-EVENT` | codex E | Event names are the 14 PascalCase Codex events | `cx-hooks` |
| `HK-CX-MATCHER-IGNORED` | codex W | No matcher on UserPromptSubmit, Stop, Interrupt, Pre/PostModelRequest | `cx-hooks` |
| `HK-CX-MATCHER` | codex E | A regex matcher compiles | `cx-hooks` |
| `HK-CX-TYPE` | codex E | Handler type is command or mcp_tool (prompt and agent are parsed but not run) | `cx-hooks` |
| `HK-CX-FIELD` | codex W | Handlers use only command, commandWindows, timeout, async, statusMessage, additionalContextLimit (no args, cwd, env) | `cx-hooks` |
| `HK-CX-WINDOWS` | codex W | `commandWindows` is set when `command` is not valid under cmd.exe | `cx-hooks` |
| `HK-CX-EXIT2` | codex W | Decisions are JSON on exit 0 (exit 2 becomes 1 under PowerShell on Windows) | `cx-54072` |
| `HK-CX-OUTPUT` | codex W | The handler prints no Copilot-only output fields (Codex rejects unknown fields) | `cx-hooks` |
| `HK-CX-SESSIONEND` | codex W | SessionEnd/Interrupt timeouts are capped at 3 s and async is not honored there | `cx-hooks` |
| `HK-CX-BOTH` | codex W | One config layer does not define hooks in both hooks.json and config.toml | `cx-hooks` |
| `HK-CX-TRUST` | codex N | Project .codex hooks need a trusted project and a one-time review in /hooks | `cx-hooks` |
| `CX-TOML` | codex E | config.toml is valid TOML | `cx-config` |
| `CX-SKILLS-CONFIG` | codex E | [[skills.config]] entries have exactly one of path or name, plus enabled | `cx-config` |
| `CX-MCP` | codex W | `[mcp_servers.<name>]` entries have a command or a url | `cx-config` |
| **Plugins, marketplaces, MCP configs** | | | |
| `PL-JSON` | copilot E, claude E, codex E | The plugin manifest is valid JSON | `cp-plugins` `cl-plugins` `cx-plugins` |
| `PL-AP-SCHEMA` | copilot E, codex E | The Agent Plugins `$schema` is 1.0.0 or 1.1.0 (other versions are rejected) | `cp-plugins` `ap-spec` |
| `PL-AP-FIELD` | copilot W, codex W | Only the closed Agent Plugins field set (others are reported and ignored) | `ap-spec` `cp-plugins` |
| `PL-AP-NAME` | copilot E, codex E | Plugin name: 1-64 of a-z 0-9 - ., alphanumeric at both ends, no -- or .. | `ap-spec` |
| `PL-AP-SKILLS` | copilot W, codex W | Skills are immediate subdirectories of skills/ (no root SKILL.md fallback) | `ap-spec` `cp-plugins` |
| `PL-AP-MCP` | copilot E, codex E | mcp.json declares the Agent Plugins schema, only mcpServers, single-token commands and valid cwd | `ap-spec` |
| `PL-CP-MANIFEST` | copilot E | Copilot plugin.json: kebab-case name up to 64, description up to 1,024, existing component paths | `cp-plugins` |
| `PL-CP-FIELD` | copilot W | Copilot plugin.json uses only documented fields | `cp-plugins` |
| `PL-CL-NAME` | claude E | Claude plugin name: kebab-case, not reserved (claude-*, anthropic-*, anthropics-*, cc-plugin-*, claude, anthropic, claude-code, claude-mods) | `cl-plugins` |
| `PL-CL-NAME-WORD` | claude W | Plugin name does not contain "claude" or "anthropic" as a word | `cl-plugins` |
| `PL-CL-PATH` | claude E | Component paths start with ./, exist and stay inside the plugin root | `cl-plugins` |
| `PL-CL-FIELD` | claude W | Claude plugin.json uses only documented fields | `cl-plugins` |
| `PL-CL-META` | claude N | version, description and author are set (claude plugin validate warns without them) | `cl-validate` |
| `PL-CL-CLAUDEMD` | claude W | A CLAUDE.md at the plugin root is not loaded; put instructions in a skill | `cl-plugins` |
| `PL-CX-FIELD` | codex W | .codex-plugin/plugin.json uses the documented camelCase fields | `cx-plugins` |
| `PL-SKILL-COLLISION` | copilot W, claude W | A plugin skill is not shadowed by a same-named project skill | `cp-plugins` `cl-skills` |
| `MK-JSON` | copilot E, claude E, codex E | The marketplace manifest is valid JSON | `cl-mkt` `cp-plugins` `cx-plugins` |
| `MK-SHAPE` | copilot E, claude E, codex E | A marketplace has name, owner.name (Copilot, Claude) and plugins[] | `cl-mkt` `cp-plugins` `cx-plugins` |
| `MK-NAME-RESERVED` | claude E | The marketplace name is not reserved | `cl-mkt` |
| `MK-ENTRY` | copilot E, claude E, codex E | Entries have name and source; relative sources never use .. (and start with ./ for Claude) | `cl-mkt` `cp-plugins` `cx-plugins` |
| `MK-UNPINNED` | copilot N, claude N, codex N; strict: copilot W, claude W, codex W | Remote sources are pinned (40-character sha, npm version or archive sha256); a warning with --strict | `cp-plugins` `cl-mkt` `anti-patterns` |
| `MK-HOOKS-PATH` | claude E | Marketplace entries inline hooks as an object (paths are not supported) | `cl-mkt` |
| `MK-FIELD` | claude W, copilot W | Marketplaces use only documented top-level keys | `cl-mkt` `cp-plugins` |
| `MC-JSON` | copilot E, claude E, codex E | The MCP config is valid JSON (JSONC only in .vscode/mcp.json) | `cp-mcp` `vsc-mcp` |
| `MC-TOPKEY` | copilot E, claude E | The top-level key matches the host: mcpServers (.mcp.json, Copilot CLI, Claude) or servers (.vscode/mcp.json) | `cp-mcp` `vsc-mcp` |
| `MC-SERVER` | copilot E, claude E, codex E | A local server has a command, a remote one a url, and the type is valid for the host | `cp-mcp` `vsc-mcp` `ap-spec` |
| `MC-INPUT` | copilot W, claude W | ${input:...} is literal outside .vscode/mcp.json (a note there: not forwarded to the Copilot harness) | `vsc-mcp` |
| `MC-VSCODE-CLI` | copilot N | Copilot CLI does not read .vscode/mcp.json (use .mcp.json) | `cp-mcp` |
| `MC-HTTP` | copilot W, claude W | Remote servers use https unless they are on loopback | `cl-validate` |
| `MC-CLOUD` | copilot N | Cloud-agent MCP JSON needs `type` and `tools` on every server | `cp-mcp` |
| **Security group (reported in `security[]`) and external validators** | | | |
| `SEC-ALLOWED-TOOLS` | security W | `allowed-tools` pre-approves shell or every tool for whoever installs the skill | `cp-skills` `cp-cli` |
| `SEC-HTTP-HOOK` | security W | An HTTP hook posts to a host that is not on the allowlist | `cp-hooks` `ac-hooks` |
| `SEC-PIPE-SHELL` | security W | Download-and-execute (curl \| sh, iwr \| iex) in a skill, instruction, agent or prompt | `anti-patterns` |
| `SEC-BASE64` | security W | A long base64 blob in a skill, instruction, agent or prompt | `anti-patterns` |
| `SEC-DISABLE-GUARDS` | security W | Text that turns off hooks, permissions or sandboxes | `anti-patterns` `ac-hooks` |
| `SEC-MCP-SECRET` | security E | An MCP server carries a literal credential in env or headers | `cl-validate` `cp-mcp` |
| `SEC-SECRET` | security E | A secret-shaped literal in a tooling file | `anti-patterns` |
| `SEC-UNPINNED` | security W | An MCP server or hook runs an unpinned remote package (npx -y pkg, @latest, :latest) | `anti-patterns` |
| `EXT-SKILLS-REF` | spec E | `skills-ref validate` passes | `skills-ref` |
| `EXT-CLAUDE-VALIDATE` | claude E | `claude plugin validate --strict --json` reports no errors (warnings merged as warnings; a bare skills directory is not applicable) | `cl-validate` `measured` |
| `EXT-GH-SKILL` | spec E | `gh skill publish --dry-run` validation passes (its warnings are merged as notes) | `cp-skills` `measured` |
| `EXT-COPILOT-SKILL` | copilot W | `copilot skill list --json` lists the skill from its location as enabled (a same-named copy elsewhere is a note) | `cp-cli` `measured` |
| `EXT-COPILOT-INSTRUCTION` | copilot W | `copilot instruction list --json` lists the instruction file | `cp-cli` `measured` |
| `EXT-CODEX-SKILL` | codex W | `codex debug prompt-input` lists the skill in `<skills_instructions>` (no model call) | `cx-skills` `measured` |
| `EXT-CODEX-CONFIG` | codex W | `codex doctor --json` reports no unrecognized config.toml settings (no model call) | `cx-config` `measured` |
| `EXT-WAZA` | copilot W | `waza spec verify` passes for the skill eval | `cp-skills` |

## Sources

Research digests checked 2026-10-24/25; each key is cited in the catalog.

- Agent Skills: `spec` specification.mdx (agentskills.io/specification); `skills-ref` validator.py and parser.py; `measured` runs in the build container on 2026-10-25 (skills-ref @69ef37e, gh 2.99.0, Claude Code 2.1.310, Copilot CLI 1.0.103, Codex 0.164.0).
- GitHub Copilot docs: `cp-skills` agent skills; `cp-cli` CLI command reference; `cp-listing` SDK skills (100-file listing, folders over 50 summarized); `cp-instr` custom instructions; `cp-cr` code review tutorial (about 1,000 lines); `cp-dist` CLI instructions and @imports; `cp-agents` custom agents; `cp-prompts` prompt files; `cp-hooks` hooks reference; `cp-hooks-howto` CLI hooks how-to; `cp-plugins` CLI plugin reference; `cp-mcp` MCP for the CLI and the cloud agent; `cp-2540` copilot-cli issue 2540 (plugin `preToolUse` `cwd`).
- VS Code docs: `vsc-skills` agent skills; `vsc-instr` custom instructions; `vsc-agents` custom agent file reference; `vsc-hooks` hooks (Copilot vs Local harness); `vsc-mcp` MCP configuration and migration.
- Claude Code docs: `cl-skills` skills; `cl-bp` skill authoring best practices; `cl-memory` CLAUDE.md, AGENTS.md, @imports, rules; `cl-agents` subagents; `cl-hooks` hooks reference; `cl-plugins` plugin manifest and components; `cl-mkt` marketplaces; `cl-validate` `claude plugin validate`.
- Codex source (openai/codex @970111f): `cx-skills` skill parser and loader; `cx-yaml` `agents/openai.yaml`; `cx-config` `config.toml` schema; `cx-agentsmd` AGENTS.md loading (32 KiB); `cx-hooks` hook discovery, matcher and runner; `cx-plugins` plugin manifest and marketplace; `cx-54072` issue 54072 (PowerShell collapses exit 2).
- Other: `ap-spec` Agent Plugins 1.0 specification; `ac-contrib` awesome-copilot contribution rules (assets under 5 MB); `ac-hooks` awesome-copilot hook guidance; `anti-patterns` the tooling anti-pattern catalog (research digest `tooling-authoring.md`).
