// `tooling lint`: validate instructions, skills, agents, prompt files, hooks, plugins and MCP
// configs against each host's documented rules (plan §11.2). Every rule has an id, the hosts
// it applies to with a severity per host, and a source citation; the catalog is `RULES`.
// External validators (skills-ref, claude plugin validate, gh skill, copilot, waza) are merged
// when installed. Read-only: nothing is written.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  defineCommand, usageError, EXIT, readText, toPosix, globToRegExp, which, run, runShell, quoteArg, toolVersion,
  versionGte, truncate, IS_WINDOWS,
} from './core.mjs';
import { repoRoot } from './git.mjs';
import { resolveStateDir, assertStateUntracked } from './state.mjs';
import { parseFrontmatter, parseYamlDocument } from './frontmatter.mjs';

export const HOSTS = Object.freeze(['spec', 'copilot', 'claude', 'codex']);
const HOST_LABEL = { spec: 'Agent Skills spec', copilot: 'Copilot', claude: 'Claude Code', codex: 'Codex' };
const SEVERITIES = new Set(['error', 'warning', 'note']);

// ---------------------------------------------------------------------------
// Sources cited by the rules (research digests, checked 2026-10-24/25)

export const SOURCES = Object.freeze({
  'spec': 'Agent Skills specification - agentskills/agentskills docs/specification.mdx (https://agentskills.io/specification)',
  'skills-ref': 'skills-ref validator - agentskills/agentskills skills-ref/src/skills_ref/validator.py and parser.py',
  'cp-skills': 'GitHub Docs: agent skills - data/reusables/copilot/creating-adding-skills.md, concepts/customizations/agent-skills.md',
  'cp-cli': 'GitHub Docs: Copilot CLI command reference - reference/copilot-cli-reference/cli-command-reference.md',
  'cp-listing': 'GitHub Docs: Copilot SDK skills (related-files listing: 100 files, folders >50 summarized) - how-tos/copilot-sdk/features/skills.md',
  'vsc-skills': 'VS Code: agent skills - microsoft/vscode-docs docs/agent-customization/agent-skills.md (2026-10-21)',
  'cl-skills': 'Claude Code: skills - https://code.claude.com/docs/en/skills',
  'cl-bp': 'Claude platform: skill authoring best practices - https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices',
  'cx-skills': 'Codex skill parser and loader - openai/codex codex-rs/skills/src/parser.rs, ext/skills/src/loader/mod.rs @970111f',
  'cx-yaml': 'Codex agents/openai.yaml - openai/codex skills/src/metadata.rs and skill-creator/references/openai_yaml.md @970111f',
  'cx-config': 'Codex config.toml - openai/codex codex-rs/config/src/skills_config.rs, config.schema.json @970111f',
  'ac-contrib': 'github/awesome-copilot CONTRIBUTING.md and eng/validate-skills.mjs (assets under 5 MB)',
  'cp-instr': 'GitHub Docs: custom instructions - reference/custom-instructions-support.md, how-tos/.../add-custom-instructions.md',
  'cp-cr': 'GitHub Docs: Copilot code review customization tutorial (instruction files up to about 1,000 lines)',
  'cp-dist': 'GitHub Docs: Copilot CLI custom instructions and @imports - how-tos/copilot-cli/customize-copilot/add-custom-instructions.md',
  'vsc-instr': 'VS Code: custom instructions - docs/agent-customization/custom-instructions.md (sources are additive)',
  'cl-memory': 'Claude Code: memory (CLAUDE.md, AGENTS.md, @imports, rules) - https://code.claude.com/docs/en/memory',
  'cx-agentsmd': 'Codex AGENTS.md loading - openai/codex codex-rs/core/src/agents_md.rs, config/src/config_toml.rs (32 KiB) @970111f',
  'cp-agents': 'GitHub Docs: custom agents configuration - reference/custom-agents-configuration.md',
  'vsc-agents': 'VS Code: custom agent file reference - docs/agents/reference/custom-agent-file-reference.md',
  'cl-agents': 'Claude Code: subagents - https://code.claude.com/docs/en/sub-agents',
  'cp-prompts': 'VS Code: prompt files (Local harness only) - docs/agent-customization/prompt-files.md; GitHub customization cheat sheet',
  'cp-hooks': 'GitHub Docs: hooks reference - reference/hooks-reference.md (2026-10-20)',
  'cp-hooks-howto': 'GitHub Docs: Copilot CLI hooks how-to - how-tos/copilot-cli/customize-copilot/use-hooks.md',
  'vsc-hooks': 'VS Code: hooks (Copilot harness vs Local harness) - docs/agent-customization/hooks.md',
  'cl-hooks': 'Claude Code: hooks reference and guide - https://code.claude.com/docs/en/hooks',
  'cx-hooks': 'Codex hooks - openai/codex codex-rs/hooks/src/engine/{discovery,matcher,command_runner}.rs, protocol/src/hooks.rs @970111f',
  'cx-54072': 'openai/codex issue #54072 (PowerShell -Command collapses exit code 2 to 1 on Windows)',
  'cp-2540': 'github/copilot-cli issue #2540 (plugin preToolUse hooks need "cwd": "${PLUGIN_ROOT}")',
  'cp-plugins': 'GitHub Docs: Copilot CLI plugin reference - reference/copilot-cli-reference/cli-plugin-reference.md',
  'ap-spec': 'Agent Plugins 1.0 specification - agentplugins/agent-plugins-spec spec/1.0.0.md',
  'cl-plugins': 'Claude Code: plugin manifest reference and components - https://code.claude.com/docs/en/plugins-reference',
  'cl-mkt': 'Claude Code: plugin marketplaces - https://code.claude.com/docs/en/plugin-marketplaces',
  'cl-validate': 'claude plugin validate - https://code.claude.com/docs/en/plugins/cli-reference',
  'cx-plugins': 'Codex plugins - openai/codex codex-rs/core-plugins/src/{manifest,marketplace}.rs @970111f',
  'cp-mcp': 'GitHub Docs: MCP for Copilot CLI and cloud agent - how-tos/copilot-cli/customize-copilot/add-mcp-servers.md, configure-mcp-servers.md',
  'vsc-mcp': 'VS Code: MCP configuration and migration - docs/agents/reference/mcp-configuration.md, migrate-customizations.md',
  'ac-hooks': 'github/awesome-copilot instructions/hooks.instructions.md (hook anti-patterns)',
  'anti-patterns': 'Tooling anti-pattern catalog (research digest tooling-authoring.md section f: secrets, hostnames, paths, Windows, pinning)',
});

// ---------------------------------------------------------------------------
// Rule catalog

const R = (id, kind, hosts, title, sources, extra = {}) => {
  const h = {};
  for (const pair of hosts.split(/\s+/).filter(Boolean)) {
    const [host, sev] = pair.split('=');
    h[host] = sev;
  }
  return Object.freeze({ id, kind, hosts: Object.freeze(h), title, sources: sources.split(/\s+/), ...extra });
};
const ALL4 = (sev) => `spec=${sev} copilot=${sev} claude=${sev} codex=${sev}`;
const SEC = (id, title, sources, severity = 'warning') =>
  Object.freeze({ id, kind: 'security', group: 'security', hosts: Object.freeze({}), severity, title, sources: sources.split(/\s+/) });

/** Every rule: { id, kind, hosts: {host: 'error'|'warning'|'note'}, title, sources[], strict? }. */
export const RULES = Object.freeze([
  // SKILL.md
  R('SK-FILENAME', 'skill', ALL4('error'), 'The skill file is named exactly SKILL.md (Codex matches it case-sensitively)', 'cx-skills cp-skills'),
  R('SK-FM-LINE1', 'skill', ALL4('error'), 'Frontmatter opens with "---" on line 1', 'skills-ref cx-skills cl-skills'),
  R('SK-FM-BOM', 'skill', 'spec=warning codex=warning', 'No UTF-8 byte-order mark before the opening "---"', 'skills-ref cx-skills'),
  R('SK-FM-YAML', 'skill', ALL4('error'), 'Frontmatter is valid YAML (Claude Code loads a malformed block with no fields)', 'cl-skills skills-ref cx-skills'),
  R('SK-FM-COLON', 'skill', 'spec=error copilot=error claude=error codex=warning', 'No unquoted ": " inside a scalar (only Codex auto-repairs it)', 'cx-skills cl-skills'),
  R('SK-NAME-REQUIRED', 'skill', 'spec=error copilot=error', '`name` is present (Claude Code and Codex default to the directory name)', 'spec cp-skills'),
  R('SK-NAME-LENGTH', 'skill', 'spec=error copilot=error claude=warning codex=error', '`name` is 1-64 characters', 'spec skills-ref cx-skills'),
  R('SK-NAME-FORMAT', 'skill', 'spec=error copilot=error claude=warning codex=warning', '`name` uses lowercase letters, digits and single inner hyphens (VS Code silently skips other names)', 'spec vsc-skills cl-bp'),
  R('SK-NAME-DIR', 'skill', 'spec=error copilot=error claude=warning', '`name` equals the skill directory name', 'skills-ref vsc-skills'),
  R('SK-NAME-RESERVED', 'skill', 'claude=warning', '`name` does not contain "claude" or "anthropic" (claude.ai and the Skills API reject it)', 'cl-skills cl-bp'),
  R('SK-NAME-CLAUDE-DIR', 'skill', 'claude=error', 'The skill folder is not named "synced" or "anthropic-skills*" (reserved by Claude Code)', 'cl-skills'),
  R('SK-DESC-REQUIRED', 'skill', 'spec=error copilot=error claude=warning codex=error', '`description` is present and non-empty (Codex does not load a skill without one)', 'spec cx-skills cl-skills'),
  R('SK-DESC-TYPE', 'skill', ALL4('error'), '`description` is a string', 'spec cx-skills'),
  R('SK-DESC-LENGTH', 'skill', 'spec=error copilot=error', '`description` is at most 1,024 characters', 'spec cp-cli vsc-skills'),
  R('SK-DESC-LISTING', 'skill', 'claude=warning', '`description` plus `when_to_use` stays under the 1,536-character listing cap', 'cl-skills'),
  R('SK-DESC-XML', 'skill', 'spec=warning claude=warning', '`description` contains no XML/HTML tags', 'cl-bp'),
  R('SK-DESC-PERSON', 'skill', 'claude=warning', '`description` is written in the third person (not "I ..." or "You can ...")', 'cl-bp'),
  R('SK-FIELD-NONSPEC', 'skill', 'spec=warning', 'Only the six spec fields are portable (skills-ref, gh skill publish and claude.ai uploads reject others)', 'skills-ref cl-skills', { strict: Object.freeze({ spec: 'error' }) }),
  R('SK-FIELD-IGNORED', 'skill', 'copilot=warning claude=warning codex=note', 'A frontmatter field the host does not read', 'cp-cli vsc-skills cl-skills cx-skills'),
  R('SK-METADATA-MAP', 'skill', 'spec=error codex=warning', '`metadata` is a mapping', 'spec cx-skills'),
  R('SK-METADATA-STRING', 'skill', 'spec=warning', '`metadata` values are strings (quote versions such as "1.0")', 'spec'),
  R('SK-SHORTDESC', 'skill', 'codex=warning', '`metadata.short-description` is 25-64 characters', 'cx-yaml'),
  R('SK-COMPAT-LENGTH', 'skill', 'spec=error claude=warning', '`compatibility` is 1-500 characters', 'spec cl-skills'),
  R('SK-ALLOWED-TOOLS-TYPE', 'skill', 'spec=warning', '`allowed-tools` is a space-separated string in the spec', 'spec'),
  R('SK-BODY-LINES', 'skill', 'spec=warning claude=warning', 'The body stays under 500 lines', 'spec cl-skills'),
  R('SK-BODY-TOKENS', 'skill', 'spec=warning claude=warning', 'The body stays under about 5,000 tokens (Claude keeps the first 5,000 after compaction)', 'spec cl-skills'),
  R('SK-BODY-EMPTY', 'skill', 'copilot=warning claude=warning codex=warning', 'The body contains instructions', 'spec'),
  R('SK-SUBST', 'skill', 'spec=warning copilot=warning codex=warning', 'No $ARGUMENTS, ${CLAUDE_*} or !`cmd` substitutions in a skill meant for every host', 'cp-skills cx-skills cl-skills'),
  R('SK-SUBST-POSITIONAL', 'skill', 'claude=warning', '$0-$9 in the body are replaced with arguments by Claude Code (write \\$1 for a literal)', 'cl-skills'),
  R('SK-LINK-MISSING', 'skill', 'copilot=error claude=error codex=error', 'Every relative link in SKILL.md resolves to a file in the skill', 'vsc-skills cl-skills'),
  R('SK-LINK-BACKSLASH', 'skill', 'copilot=error claude=error codex=error', 'Links use forward slashes', 'vsc-skills cl-bp'),
  R('SK-LINK-ABSOLUTE', 'skill', 'copilot=warning claude=warning codex=warning', 'Links are relative and stay inside the skill folder (no absolute local paths)', 'cl-bp'),
  R('SK-REF-UNLINKED', 'skill', 'copilot=warning claude=warning', 'Every file under references/ is linked from SKILL.md (VS Code loads only referenced files)', 'vsc-skills cl-skills'),
  R('SK-REF-DEPTH', 'skill', 'spec=warning claude=warning', 'Reference files are one level deep (references/<file>)', 'spec cl-bp'),
  R('SK-FOOTPRINT-FILES', 'skill', 'copilot=warning', 'The skill folder holds at most 100 files (Copilot lists no more)', 'cp-listing'),
  R('SK-FOOTPRINT-FOLDER', 'skill', 'copilot=warning', 'No folder in the skill has more than 50 entries (Copilot summarizes it)', 'cp-listing'),
  R('SK-ASSET-SIZE', 'skill', 'copilot=warning', 'No file in the skill is larger than 5 MB', 'ac-contrib'),
  // agents/openai.yaml (Codex sidecar)
  R('CX-YAML-PARSE', 'codex-skill-meta', 'codex=error', 'agents/openai.yaml is valid YAML', 'cx-yaml'),
  R('CX-YAML-FIELD', 'codex-skill-meta', 'codex=warning', 'agents/openai.yaml uses only interface, dependencies and policy keys', 'cx-yaml'),
  R('CX-YAML-SHORTDESC', 'codex-skill-meta', 'codex=warning', '`interface.short_description` is 25-64 characters', 'cx-yaml'),
  R('CX-YAML-PROMPT', 'codex-skill-meta', 'codex=warning', '`interface.default_prompt` mentions the skill as $<skill-name>', 'cx-yaml'),
  R('CX-YAML-POLICY', 'codex-skill-meta', 'codex=error', '`policy.allow_implicit_invocation` is a boolean', 'cx-yaml'),
  R('CX-YAML-DEPS', 'codex-skill-meta', 'codex=warning', '`dependencies.tools[].type` is "mcp" and names a server', 'cx-yaml'),
  // Legacy Claude commands and prompt files
  R('CM-FIELD', 'command', 'claude=warning copilot=warning', 'Command files accept skill fields except `name` and `paths`', 'cl-skills cp-cli'),
  R('CM-LEGACY', 'command', 'claude=note', '.claude/commands is the legacy format; new work belongs in skills', 'cl-skills'),
  R('PR-HARNESS', 'prompt', 'copilot=note', 'Prompt files run only in the VS Code Local harness and Visual Studio (not Copilot CLI, cloud agent or the Copilot harness)', 'cp-prompts'),
  R('PR-FIELD', 'prompt', 'copilot=warning', 'Prompt-file frontmatter uses description, name, argument-hint, agent, model, tools', 'cp-prompts'),
  R('MD-FM-YAML', 'markdown', 'copilot=error claude=error codex=error', 'Frontmatter of instruction, agent, command and prompt files is valid YAML', 'cl-agents cp-agents cp-instr'),
  // Instructions
  R('IN-APPLYTO-MISSING', 'instructions', 'copilot=warning', 'A .instructions.md file declares `applyTo`', 'cp-instr ac-contrib'),
  R('IN-APPLYTO-GLOB', 'instructions', 'copilot=error claude=error', '`applyTo` / `paths` globs are valid, relative and use forward slashes', 'cp-instr cl-memory'),
  R('IN-EXCLUDEAGENT', 'instructions', 'copilot=error', '`excludeAgent` is "code-review" or "cloud-agent"', 'cp-instr'),
  R('IN-FIELD', 'instructions', 'copilot=warning claude=warning', 'Instruction frontmatter uses only documented keys', 'cp-instr cl-memory'),
  R('IN-LENGTH', 'instructions', 'copilot=warning', 'An instruction file stays under about 1,000 lines', 'cp-cr'),
  R('IN-CLAUDE-LENGTH', 'instructions', 'claude=warning', 'CLAUDE.md stays under 200 lines', 'cl-memory'),
  R('IN-AGENTS-BUDGET', 'instructions', 'codex=warning', 'AGENTS.md files from the root to a directory total at most 32 KiB (Codex truncates)', 'cx-agentsmd'),
  R('IN-DUPLICATE', 'instructions', 'copilot=warning claude=warning codex=warning', 'The same directive is not repeated across always-on instruction files', 'vsc-instr cl-memory'),
  R('IN-CONFLICT', 'instructions', 'copilot=warning claude=warning codex=warning', 'Always-on instruction files do not contradict each other', 'vsc-instr cl-memory'),
  R('IN-ABS-PATH', 'instructions', 'copilot=warning claude=warning codex=warning', 'No user-specific or absolute local paths', 'anti-patterns'),
  R('IN-HOSTNAME', 'instructions', 'copilot=warning claude=warning codex=warning', 'No internal hostnames or private IP addresses', 'anti-patterns'),
  R('IN-BASH-ONLY', 'instructions', 'copilot=warning claude=warning codex=warning', 'Shell commands have a Windows equivalent', 'cp-hooks-howto anti-patterns'),
  R('IN-CLAUDE-LOCAL', 'instructions', 'claude=warning', 'No CLAUDE.local.md next to AGENTS.md (it stops AGENTS.md from loading)', 'cl-memory'),
  R('IN-CLAUDE-AGENTS', 'instructions', 'claude=warning', 'A CLAUDE.md next to AGENTS.md imports it with @AGENTS.md (Claude ignores AGENTS.md otherwise)', 'cl-memory'),
  R('IN-IMPORT-MISSING', 'instructions', 'copilot=error claude=error', 'Every @import target exists', 'cl-memory cp-dist'),
  R('IN-IMPORT-UNSUPPORTED', 'instructions', 'copilot=warning codex=warning', '@imports only in files that expand them (not GEMINI.md, *.instructions.md, or Codex AGENTS.md)', 'cp-dist cx-agentsmd'),
  R('IN-IMPORT-ABSOLUTE', 'instructions', 'copilot=note', 'Absolute or ~/ @imports: the Copilot docs disagree on support; prefer relative paths', 'cp-dist cp-cli'),
  R('IN-EMPTY', 'instructions', 'copilot=note claude=note codex=note', 'The instruction file has content', 'cp-instr'),
  // Agents
  R('AG-FM-MISSING', 'agent', 'copilot=error claude=error', 'An agent file starts with YAML frontmatter', 'cp-agents cl-agents'),
  R('AG-DESC-REQUIRED', 'agent', 'copilot=error claude=error', '`description` is present', 'cp-agents cl-agents'),
  R('AG-NAME-REQUIRED', 'agent', 'claude=error', '`name` is present (Claude Code skips the agent otherwise)', 'cl-agents'),
  R('AG-NAME-FORMAT', 'agent', 'claude=error', '`name` is at most 256 characters with no colon', 'cl-agents'),
  R('AG-FILENAME', 'agent', 'copilot=error', 'Agent file names use only . - _ a-z A-Z 0-9', 'cp-agents'),
  R('AG-BODY-LENGTH', 'agent', 'copilot=error', 'The agent prompt is at most 30,000 characters', 'cp-agents'),
  R('AG-FIELD', 'agent', 'copilot=warning claude=warning', 'Agent frontmatter uses only documented fields', 'cp-agents vsc-agents cl-agents'),
  R('AG-FIELD-SURFACE', 'agent', 'copilot=warning', 'Fields that some Copilot surfaces ignore (handoffs, argument-hint in the cloud agent; retired infer)', 'cp-agents'),
  R('AG-TOOLS', 'agent', 'copilot=warning', '`tools` entries are known aliases, server/tool, server/* or "*"', 'cp-agents'),
  R('AG-ENUM', 'agent', 'copilot=error claude=error', 'Enumerated agent fields use documented values', 'cp-agents cl-agents'),
  R('AG-PLUGIN-FIELDS', 'agent', 'claude=warning', 'Plugin subagents cannot use hooks, mcpServers, permissionMode or initialPrompt', 'cl-plugins'),
  R('AG-CODEX', 'agent', 'codex=note', 'Codex has no Markdown agents; port to a skill with a default prompt', 'cx-skills'),
  // Copilot hooks
  R('HK-CP-JSON', 'hooks', 'copilot=error', 'The hooks file is valid JSON (an invalid file is rejected)', 'cp-hooks'),
  R('HK-CP-VERSION-MISSING', 'hooks', 'copilot=warning', '`version: 1` is present (files without it load since CLI 1.0.5)', 'cp-hooks'),
  R('HK-CP-VERSION', 'hooks', 'copilot=error', '`version` is 1 (any other value rejects the file)', 'cp-hooks'),
  R('HK-CP-SHAPE', 'hooks', 'copilot=error', '`hooks` maps event names to arrays of entries', 'cp-hooks'),
  R('HK-CP-EVENT', 'hooks', 'copilot=error', 'Event names are documented Copilot events in one casing', 'cp-hooks'),
  R('HK-CP-EVENT-UNDOC', 'hooks', 'copilot=warning', 'PascalCase names without a documented Copilot alias', 'cp-hooks'),
  R('HK-CP-MIXED-CASE', 'hooks', 'copilot=warning', 'One file does not mix camelCase and PascalCase events (payload dialects differ)', 'cp-hooks'),
  R('HK-CP-TYPE', 'hooks', 'copilot=error', '`type` is command, http or prompt', 'cp-hooks'),
  R('HK-CP-COMMAND', 'hooks', 'copilot=error', 'A command entry has bash and/or powershell, command, or exec', 'cp-hooks'),
  R('HK-CP-NO-WINDOWS', 'hooks', 'copilot=warning', 'A bash entry also has powershell (or a cross-shell command) for Windows', 'cp-hooks-howto'),
  R('HK-CP-PS-ONLY', 'hooks', 'copilot=warning', 'PowerShell-only entries are ignored by the cloud agent', 'cp-hooks'),
  R('HK-CP-PS-COMPAT', 'hooks', 'copilot=warning', 'The powershell string also runs under Windows PowerShell 5.1 (no && or ||)', 'cp-hooks-howto'),
  R('HK-CP-EXEC-MIX', 'hooks', 'copilot=error', '`exec` is not combined with bash, powershell or command', 'cp-hooks'),
  R('HK-CP-EXEC', 'hooks', 'copilot=warning', '`exec`/`args` run only in Copilot CLI (not the cloud agent or VS Code)', 'cp-hooks'),
  R('HK-CP-TIMEOUT', 'hooks', 'copilot=warning', '`timeoutSec` at most 30 and not combined with `timeout`; a missing one is a note (warning with --strict)', 'cp-hooks'),
  R('HK-CP-TIMEOUT-TYPE', 'hooks', 'copilot=error', '`timeoutSec` is a positive number', 'cp-hooks'),
  R('HK-CP-MATCHER', 'hooks', 'copilot=error', '`matcher` compiles as a regular expression (an invalid one skips the hook)', 'cp-hooks'),
  R('HK-CP-ASK', 'hooks', 'copilot=warning', 'No permissionDecision "ask" (it becomes deny in the cloud agent and autopilot)', 'cp-hooks'),
  R('HK-CP-HTTP', 'hooks', 'copilot=error', 'HTTP hooks use https (localhost only with COPILOT_HOOK_ALLOW_LOCALHOST=1, never for preToolUse)', 'cp-hooks'),
  R('HK-CP-PROMPT', 'hooks', 'copilot=error', 'Prompt hooks only on sessionStart', 'cp-hooks'),
  R('HK-CP-LOCAL-KEYS', 'hooks', 'copilot=warning', 'No VS Code Local-harness keys (windows, linux, osx, hookSpecificOutput) in .github/hooks', 'vsc-hooks'),
  R('HK-CP-FIELD', 'hooks', 'copilot=warning', 'Entries and the file use only documented keys', 'cp-hooks'),
  R('HK-CP-CLOUD-EVENT', 'hooks', 'copilot=warning', 'notification and permissionRequest do not work in the cloud agent (.github/hooks is read there)', 'cp-hooks'),
  R('HK-CP-OUTPUT-IGNORED', 'hooks', 'copilot=note', 'Output of errorOccurred, sessionEnd, preCompact and userPromptSubmitted command hooks is not processed', 'cp-hooks'),
  R('HK-CP-DISABLED', 'hooks', 'copilot=warning', '`disableAllHooks: true` turns the file off', 'cp-hooks'),
  R('HK-CP-PLUGIN-CWD', 'hooks', 'copilot=warning', 'Plugin preToolUse entries set "cwd": "${PLUGIN_ROOT}"', 'cp-2540'),
  R('HK-XS-COMMAND', 'hooks', 'copilot=error', 'A Copilot `command` string parses in both bash and PowerShell (it is copied to both)', 'cp-hooks'),
  // Claude hooks
  R('HK-CL-JSON', 'hooks', 'claude=error', 'The settings or hooks file is valid JSON', 'cl-hooks'),
  R('HK-CL-SHAPE', 'hooks', 'claude=error', 'Events map to arrays of matcher groups with a `hooks` array; plugin files keep the "hooks" wrapper', 'cl-hooks cl-plugins'),
  R('HK-CL-EVENT', 'hooks', 'claude=warning', 'Event names are among the 33 Claude Code events (others are ignored at runtime)', 'cl-hooks cl-validate'),
  R('HK-CL-MATCHER-IGNORED', 'hooks', 'claude=warning', 'No matcher on events that ignore it', 'cl-hooks'),
  R('HK-CL-MATCHER', 'hooks', 'claude=error', 'A regex matcher compiles', 'cl-hooks'),
  R('HK-CL-TYPE', 'hooks', 'claude=error', 'The handler type exists and is supported on its event', 'cl-hooks'),
  R('HK-CL-FIELD', 'hooks', 'claude=warning', 'Handlers use only documented fields', 'cl-hooks'),
  R('HK-CL-IF', 'hooks', 'claude=error', '`if` only on tool events (elsewhere the hook never runs)', 'cl-hooks'),
  R('HK-CL-EXEC-SHIM', 'hooks', 'claude=warning', 'Exec form does not start a .cmd/.bat shim (Windows cannot spawn it); use node + script', 'cl-hooks'),
  R('HK-CL-UNQUOTED-VAR', 'hooks', 'claude=warning', '${CLAUDE_PROJECT_DIR} and ${CLAUDE_PLUGIN_ROOT} are double-quoted in shell form', 'cl-hooks cl-validate'),
  R('HK-CL-ONFAILURE', 'hooks', 'claude=error', '`onFailure` is continue or block (needs Claude Code 2.1.295+; no effect on Stop-type or async hooks)', 'cl-hooks'),
  R('HK-CL-SHELL', 'hooks', 'claude=error', '`shell` is bash or powershell', 'cl-hooks'),
  R('HK-CL-ONCE', 'hooks', 'claude=warning', '`once` is honored only in skill frontmatter', 'cl-hooks'),
  R('HK-CL-REPO-EXEC', 'hooks', 'claude=warning copilot=warning', 'Exec-form entries in a repository .claude/settings*.json are also run by Copilot CLI and VS Code; prefer a shell string', 'cp-hooks'),
  R('HK-CL-PLUGIN-ROOT', 'hooks', 'claude=warning', 'Plugin hooks reference their files through ${CLAUDE_PLUGIN_ROOT}', 'cl-plugins'),
  R('HK-CL-PLUGIN-DATA', 'hooks', 'claude=warning', 'Plugin hooks keep state in ${CLAUDE_PLUGIN_DATA}, not under the plugin root', 'cl-plugins'),
  // Codex hooks and config.toml
  R('HK-CX-JSON', 'hooks', 'codex=error', 'hooks.json is valid JSON', 'cx-hooks'),
  R('HK-CX-SHAPE', 'hooks', 'codex=error', '{"hooks": {Event: [{"matcher"?, "hooks": [handler]}]}}', 'cx-hooks'),
  R('HK-CX-EVENT', 'hooks', 'codex=error', 'Event names are the 14 PascalCase Codex events', 'cx-hooks'),
  R('HK-CX-MATCHER-IGNORED', 'hooks', 'codex=warning', 'No matcher on UserPromptSubmit, Stop, Interrupt, Pre/PostModelRequest', 'cx-hooks'),
  R('HK-CX-MATCHER', 'hooks', 'codex=error', 'A regex matcher compiles', 'cx-hooks'),
  R('HK-CX-TYPE', 'hooks', 'codex=error', 'Handler type is command or mcp_tool (prompt and agent are parsed but not run)', 'cx-hooks'),
  R('HK-CX-FIELD', 'hooks', 'codex=warning', 'Handlers use only command, commandWindows, timeout, async, statusMessage, additionalContextLimit (no args, cwd, env)', 'cx-hooks'),
  R('HK-CX-WINDOWS', 'hooks', 'codex=warning', '`commandWindows` is set when `command` is not valid under cmd.exe', 'cx-hooks'),
  R('HK-CX-EXIT2', 'hooks', 'codex=warning', 'Decisions are JSON on exit 0 (exit 2 becomes 1 under PowerShell on Windows)', 'cx-54072'),
  R('HK-CX-OUTPUT', 'hooks', 'codex=warning', 'The handler prints no Copilot-only output fields (Codex rejects unknown fields)', 'cx-hooks'),
  R('HK-CX-SESSIONEND', 'hooks', 'codex=warning', 'SessionEnd/Interrupt timeouts are capped at 3 s and async is not honored there', 'cx-hooks'),
  R('HK-CX-BOTH', 'hooks', 'codex=warning', 'One config layer does not define hooks in both hooks.json and config.toml', 'cx-hooks'),
  R('HK-CX-TRUST', 'hooks', 'codex=note', 'Project .codex hooks need a trusted project and a one-time review in /hooks', 'cx-hooks'),
  R('CX-TOML', 'codex-config', 'codex=error', 'config.toml is valid TOML', 'cx-config'),
  R('CX-SKILLS-CONFIG', 'codex-config', 'codex=error', '[[skills.config]] entries have exactly one of path or name, plus enabled', 'cx-config'),
  R('CX-MCP', 'codex-config', 'codex=warning', '[mcp_servers.<name>] entries have a command or a url', 'cx-config'),
  // Plugins and marketplaces
  R('PL-JSON', 'plugin', 'copilot=error claude=error codex=error', 'The plugin manifest is valid JSON', 'cp-plugins cl-plugins cx-plugins'),
  R('PL-AP-SCHEMA', 'plugin', 'copilot=error codex=error', 'The Agent Plugins $schema is 1.0.0 or 1.1.0 (other versions are rejected)', 'cp-plugins ap-spec'),
  R('PL-AP-FIELD', 'plugin', 'copilot=warning codex=warning', 'Only the closed Agent Plugins field set (others are reported and ignored)', 'ap-spec cp-plugins'),
  R('PL-AP-NAME', 'plugin', 'copilot=error codex=error', 'Plugin name: 1-64 of a-z 0-9 - ., alphanumeric at both ends, no -- or ..', 'ap-spec'),
  R('PL-AP-SKILLS', 'plugin', 'copilot=warning codex=warning', 'Skills are immediate subdirectories of skills/ (no root SKILL.md fallback)', 'ap-spec cp-plugins'),
  R('PL-AP-MCP', 'plugin', 'copilot=error codex=error', 'mcp.json declares the Agent Plugins schema, only mcpServers, single-token commands and valid cwd', 'ap-spec'),
  R('PL-CP-MANIFEST', 'plugin', 'copilot=error', 'Copilot plugin.json: kebab-case name up to 64, description up to 1,024, existing component paths', 'cp-plugins'),
  R('PL-CP-FIELD', 'plugin', 'copilot=warning', 'Copilot plugin.json uses only documented fields', 'cp-plugins'),
  R('PL-CL-NAME', 'plugin', 'claude=error', 'Claude plugin name: kebab-case, not reserved (claude-*, anthropic-*, anthropics-*, cc-plugin-*, claude, anthropic, claude-code, claude-mods)', 'cl-plugins'),
  R('PL-CL-NAME-WORD', 'plugin', 'claude=warning', 'Plugin name does not contain "claude" or "anthropic" as a word', 'cl-plugins'),
  R('PL-CL-PATH', 'plugin', 'claude=error', 'Component paths start with ./, exist and stay inside the plugin root', 'cl-plugins'),
  R('PL-CL-FIELD', 'plugin', 'claude=warning', 'Claude plugin.json uses only documented fields', 'cl-plugins'),
  R('PL-CL-META', 'plugin', 'claude=note', 'version, description and author are set (claude plugin validate warns without them)', 'cl-validate'),
  R('PL-CL-CLAUDEMD', 'plugin', 'claude=warning', 'A CLAUDE.md at the plugin root is not loaded; put instructions in a skill', 'cl-plugins'),
  R('PL-CX-FIELD', 'plugin', 'codex=warning', '.codex-plugin/plugin.json uses the documented camelCase fields', 'cx-plugins'),
  R('PL-SKILL-COLLISION', 'plugin', 'copilot=warning claude=warning', 'A plugin skill is not shadowed by a same-named project skill', 'cp-plugins cl-skills'),
  R('MK-JSON', 'marketplace', 'copilot=error claude=error codex=error', 'The marketplace manifest is valid JSON', 'cl-mkt cp-plugins cx-plugins'),
  R('MK-SHAPE', 'marketplace', 'copilot=error claude=error codex=error', 'A marketplace has name, owner.name (Copilot, Claude) and plugins[]', 'cl-mkt cp-plugins cx-plugins'),
  R('MK-NAME-RESERVED', 'marketplace', 'claude=error', 'The marketplace name is not reserved', 'cl-mkt'),
  R('MK-ENTRY', 'marketplace', 'copilot=error claude=error codex=error', 'Entries have name and source; relative sources never use .. (and start with ./ for Claude)', 'cl-mkt cp-plugins cx-plugins'),
  R('MK-UNPINNED', 'marketplace', 'copilot=note claude=note codex=note', 'Remote sources are pinned (40-character sha, npm version or archive sha256); a warning with --strict', 'cp-plugins cl-mkt anti-patterns', { strict: Object.freeze({ copilot: 'warning', claude: 'warning', codex: 'warning' }) }),
  R('MK-HOOKS-PATH', 'marketplace', 'claude=error', 'Marketplace entries inline hooks as an object (paths are not supported)', 'cl-mkt'),
  R('MK-FIELD', 'marketplace', 'claude=warning copilot=warning', 'Marketplaces use only documented top-level keys', 'cl-mkt cp-plugins'),
  // MCP
  R('MC-JSON', 'mcp', 'copilot=error claude=error codex=error', 'The MCP config is valid JSON (JSONC only in .vscode/mcp.json)', 'cp-mcp vsc-mcp'),
  R('MC-TOPKEY', 'mcp', 'copilot=error claude=error', 'The top-level key matches the host: mcpServers (.mcp.json, Copilot CLI, Claude) or servers (.vscode/mcp.json)', 'cp-mcp vsc-mcp'),
  R('MC-SERVER', 'mcp', 'copilot=error claude=error codex=error', 'A local server has a command, a remote one a url, and the type is valid for the host', 'cp-mcp vsc-mcp ap-spec'),
  R('MC-INPUT', 'mcp', 'copilot=warning claude=warning', '${input:...} is literal outside .vscode/mcp.json (a note there: not forwarded to the Copilot harness)', 'vsc-mcp'),
  R('MC-VSCODE-CLI', 'mcp', 'copilot=note', 'Copilot CLI does not read .vscode/mcp.json (use .mcp.json)', 'cp-mcp'),
  R('MC-HTTP', 'mcp', 'copilot=warning claude=warning', 'Remote servers use https unless they are on loopback', 'cl-validate'),
  R('MC-CLOUD', 'mcp', 'copilot=note', 'Cloud-agent MCP JSON needs `type` and `tools` on every server', 'cp-mcp'),
  // Security group (reported separately in `security[]`)
  SEC('SEC-ALLOWED-TOOLS', '`allowed-tools` pre-approves shell or every tool for whoever installs the skill', 'cp-skills cp-cli'),
  SEC('SEC-HTTP-HOOK', 'An HTTP hook posts to a host that is not on the allowlist', 'cp-hooks ac-hooks'),
  SEC('SEC-PIPE-SHELL', 'Download-and-execute (curl | sh, iwr | iex) in a skill, instruction, agent or prompt', 'anti-patterns'),
  SEC('SEC-BASE64', 'A long base64 blob in a skill, instruction, agent or prompt', 'anti-patterns'),
  SEC('SEC-DISABLE-GUARDS', 'Text that turns off hooks, permissions or sandboxes', 'anti-patterns ac-hooks'),
  SEC('SEC-MCP-SECRET', 'An MCP server carries a literal credential in env or headers', 'cl-validate cp-mcp', 'error'),
  SEC('SEC-SECRET', 'A secret-shaped literal in a tooling file', 'anti-patterns', 'error'),
  SEC('SEC-UNPINNED', 'An MCP server or hook runs an unpinned remote package (npx -y pkg, @latest, :latest)', 'anti-patterns'),
  // External validators (merged when installed)
  R('EXT-SKILLS-REF', 'external', 'spec=error', '`skills-ref validate` passes', 'skills-ref'),
  R('EXT-CLAUDE-VALIDATE', 'external', 'claude=error', '`claude plugin validate --strict --json` reports no errors (warnings are merged as warnings)', 'cl-validate'),
  R('EXT-GH-SKILL', 'external', 'spec=warning', '`gh skill publish --dry-run` passes', 'cp-skills'),
  R('EXT-COPILOT-SKILL', 'external', 'copilot=warning', '`copilot skill list --json` lists the skill as enabled', 'cp-cli'),
  R('EXT-COPILOT-INSTRUCTION', 'external', 'copilot=warning', '`copilot instruction list --json` lists the instruction file', 'cp-cli'),
  R('EXT-WAZA', 'external', 'copilot=warning', '`waza spec verify` passes for the skill eval', 'cp-skills'),
]);

const RULE_INDEX = new Map(RULES.map((r) => [r.id, r]));

// ---------------------------------------------------------------------------
// Host facts used by the rules

const SPEC_FIELDS = ['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools'];
const SKILL_FIELDS = {
  copilot: new Set([...SPEC_FIELDS, 'argument-hint', 'user-invocable', 'disable-model-invocation', 'context']),
  claude: new Set([...SPEC_FIELDS, 'when_to_use', 'argument-hint', 'arguments', 'disable-model-invocation', 'user-invocable',
    'disallowed-tools', 'model', 'effort', 'context', 'agent', 'background', 'hooks', 'paths', 'shell']),
  codex: new Set(['name', 'description', 'metadata']),
};
const COMMAND_FIELDS = new Set([...SKILL_FIELDS.claude].filter((f) => f !== 'name' && f !== 'paths'));
const PROMPT_FIELDS = new Set(['description', 'name', 'argument-hint', 'agent', 'model', 'tools', 'mode']);
const INSTRUCTION_FIELDS = new Set(['applyTo', 'excludeAgent', 'name', 'description']);
const RULES_FILE_FIELDS = new Set(['paths', 'applyTo', 'description', 'name']);

const COPILOT_AGENT_FIELDS = new Set(['name', 'description', 'target', 'tools', 'model', 'disable-model-invocation',
  'user-invocable', 'infer', 'mcp-servers', 'metadata', 'include-custom-instructions', 'models', 'modelPolicy',
  'reasoningEffort', 'skills', 'hooks', 'argument-hint', 'agents', 'reasoning-effort', 'handoffs']);
const COPILOT_TOOL_ALIASES = new Set(['execute', 'shell', 'Bash', 'bash', 'powershell', 'read', 'Read', 'NotebookRead', 'edit', 'Edit',
  'MultiEdit', 'Write', 'NotebookEdit', 'search', 'Grep', 'Glob', 'agent', 'custom-agent', 'Task', 'web', 'WebSearch', 'WebFetch',
  'todo', 'TodoWrite', '*']);
const CLAUDE_AGENT_FIELDS = new Set(['name', 'description', 'tools', 'disallowedTools', 'model', 'permissionMode', 'maxTurns',
  'autoCompactWindow', 'skills', 'mcpServers', 'hooks', 'memory', 'background', 'omitClaudeMd', 'effort', 'isolation', 'color',
  'initialPrompt', 'experimental']);
const CLAUDE_AGENT_ENUMS = {
  permissionMode: ['default', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions', 'plan', 'manual'],
  memory: ['user', 'project', 'local'],
  isolation: ['worktree'],
  effort: ['low', 'medium', 'high', 'xhigh', 'max'],
};

const CP_EVENTS_CAMEL = ['sessionStart', 'sessionEnd', 'userPromptSubmitted', 'userPromptTransformed', 'preToolUse', 'postToolUse',
  'postToolUseFailure', 'agentStop', 'subagentStart', 'subagentStop', 'errorOccurred', 'preCompact', 'permissionRequest', 'notification'];
const CP_EVENTS_PASCAL = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop',
  'SubagentStop', 'ErrorOccurred', 'PreCompact', 'PermissionRequest'];
const CP_EVENTS_PASCAL_UNDOC = ['SubagentStart', 'Notification', 'UserPromptTransformed'];
const CP_ENTRY_FIELDS = new Set(['type', 'bash', 'powershell', 'command', 'exec', 'args', 'cwd', 'env', 'timeoutSec', 'timeout',
  'matcher', 'url', 'headers', 'allowedEnvVars', 'prompt', 'hooks', 'comment', 'description']);
const CP_FILE_FIELDS = new Set(['version', 'disableAllHooks', 'hooks', 'description', '$schema']);

const CL_EVENTS = ['SessionStart', 'Setup', 'SessionEnd', 'UserPromptSubmit', 'UserPromptExpansion', 'Stop', 'StopFailure',
  'PreToolUse', 'PermissionRequest', 'PermissionDenied', 'PostToolUse', 'PostToolUseFailure', 'PostToolBatch', 'SubagentStart',
  'SubagentStop', 'TaskCreated', 'TaskCompleted', 'TeammateIdle', 'PreCompact', 'PostCompact', 'PreModelSwitch', 'PostModelSwitch',
  'Elicitation', 'ElicitationResult', 'Notification', 'MessageDisplay', 'InstructionsLoaded', 'ConfigChange', 'CwdChanged',
  'DirectoryAdded', 'FileChanged', 'WorktreeCreate', 'WorktreeRemove'];
const CL_NO_MATCHER = new Set(['UserPromptSubmit', 'PostToolBatch', 'Stop', 'TeammateIdle', 'TaskCreated', 'TaskCompleted',
  'CwdChanged', 'WorktreeCreate', 'WorktreeRemove', 'MessageDisplay']);
const CL_IF_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied']);
const CL_ALL_TYPES = new Set(['PermissionDenied', 'PostToolBatch', 'PostToolUse', 'PostToolUseFailure', 'PreToolUse', 'Stop',
  'SubagentStop', 'TaskCompleted', 'TaskCreated', 'TeammateIdle', 'UserPromptExpansion', 'UserPromptSubmit']);
const CL_ONFAILURE_NOEFFECT = new Set(['Stop', 'SubagentStop', 'TaskCompleted', 'TeammateIdle']);
const CL_HANDLER_FIELDS = new Set(['type', 'if', 'timeout', 'statusMessage', 'once', 'command', 'args', 'shell', 'async', 'asyncRewake',
  'onFailure', 'url', 'headers', 'allowedEnvVars', 'server', 'tool', 'input', 'prompt', 'model', 'continueOnBlock']);
const claudeTypesFor = (event) => {
  if (CL_ALL_TYPES.has(event)) return ['command', 'http', 'mcp_tool', 'prompt', 'agent'];
  if (event === 'PermissionRequest') return ['command', 'http', 'mcp_tool', 'prompt'];
  if (event === 'SessionStart' || event === 'Setup') return ['command', 'mcp_tool'];
  return ['command', 'http', 'mcp_tool'];
};

const CX_EVENTS = ['PreModelRequest', 'PostModelRequest', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PreCompact',
  'PostCompact', 'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'SubagentStart', 'SubagentStop', 'Stop', 'Interrupt'];
const CX_NO_MATCHER = new Set(['UserPromptSubmit', 'Stop', 'Interrupt', 'PreModelRequest', 'PostModelRequest']);
const CX_HANDLER_FIELDS = {
  command: new Set(['type', 'command', 'commandWindows', 'command_windows', 'timeout', 'async', 'statusMessage', 'additionalContextLimit']),
  mcp_tool: new Set(['type', 'server', 'tool', 'input', 'timeout', 'statusMessage']),
};

const AP_SCHEMAS = ['https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', 'https://agent-plugins.org/schemas/1.1.0/plugin.schema.json'];
const AP_MCP_SCHEMAS = ['https://agent-plugins.org/schemas/1.0.0/mcp.schema.json', 'https://agent-plugins.org/schemas/1.1.0/mcp.schema.json'];
const AP_FIELDS = new Set(['$schema', 'name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords', 'extensions']);
const CP_PLUGIN_FIELDS = new Set(['name', 'description', 'version', 'author', 'homepage', 'repository', 'license', 'keywords', 'category',
  'tags', 'agents', 'skills', 'commands', 'hooks', 'mcpServers', 'lspServers', 'extensions', '$schema']);
const CL_PLUGIN_FIELDS = new Set(['$schema', 'name', 'displayName', 'version', 'description', 'author', 'homepage', 'repository',
  'license', 'keywords', 'metadata', 'defaultEnabled', 'dependencies', 'settings', 'userConfig', 'types', 'channels', 'skills',
  'commands', 'agents', 'hooks', 'mcpServers', 'lspServers', 'outputStyles', 'workflows', 'experimental', 'icon', 'documentationUrl',
  'supportUrl', 'privacyPolicyUrl', 'termsOfServiceUrl']);
const CL_PLUGIN_PATH_FIELDS = ['skills', 'commands', 'agents', 'hooks', 'mcpServers', 'lspServers', 'outputStyles', 'workflows'];
const CX_PLUGIN_FIELDS = new Set(['name', 'version', 'description', 'keywords', 'skills', 'mcpServers', 'apps', 'hooks', 'interface',
  'extensions', 'author', 'homepage', 'repository', 'license']);
const CX_PLUGIN_SNAKE = { mcp_servers: 'mcpServers', default_prompt: 'defaultPrompt', display_name: 'displayName' };
const CL_RESERVED_PLUGIN_NAMES = new Set(['claude', 'anthropic', 'anthropics', 'claude-code', 'claude-mods']);
const CL_RESERVED_PLUGIN_PREFIXES = ['claude-', 'anthropic-', 'anthropics-', 'cc-plugin-'];
const CL_RESERVED_MARKETPLACES = new Set(['claude-plugins-official', 'claude-code-plugins', 'anthropic-marketplace', 'npm', 'pip', 'uv',
  'cargo', 'github', 'gh', 'inline', 'builtin', 'skills-dir', 'synced', 'claude-plugin-test']);
const CL_MKT_FIELDS = new Set(['$schema', 'name', 'owner', 'plugins', 'description', 'version', 'metadata', 'forceRemoveDeletedPlugins',
  'allowCrossMarketplaceDependenciesOn', 'renames']);
const CP_MKT_FIELDS = new Set(['$schema', 'name', 'owner', 'plugins', 'metadata', 'description', 'version']);
const CX_MKT_FIELDS = new Set(['name', 'interface', 'plugins']);

const NPM_SHIMS = new Set(['npm', 'npx', 'pnpm', 'pnpx', 'yarn', 'eslint', 'prettier', 'tsc', 'jest', 'vitest', 'ts-node', 'tsx', 'playwright']);
const SHA40 = /^[0-9a-f]{40}$/i;

// ---------------------------------------------------------------------------
// Small helpers

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const lineOf = (text, index) => (index <= 0 ? 1 : text.slice(0, index).split('\n').length);

function statSafe(p) {
  try { return fs.statSync(p); } catch { return null; }
}

function readTextNormalized(abs) {
  const t = readText(abs);
  return t == null ? null : t.replace(/\r\n/g, '\n');
}

/** JSON.parse with the line of the failure; `jsonc` strips comments and trailing commas first. */
function parseJson(text, { jsonc = false } = {}) {
  const attempt = (src) => {
    try { return { value: JSON.parse(src) }; } catch (err) { return { error: err.message }; }
  };
  const strict = attempt(text);
  if (!strict.error) return { value: strict.value, jsonc: false };
  const loose = attempt(stripJsonc(text));
  const m = /line (\d+)/.exec(strict.error) || null;
  const pos = /position (\d+)/.exec(strict.error);
  const line = m ? Number(m[1]) : pos ? lineOf(text, Number(pos[1])) : 1;
  if (!loose.error) return jsonc ? { value: loose.value, jsonc: true } : { error: 'comments or trailing commas are not valid JSON here', line, looseValue: loose.value };
  return { error: strict.error.replace(/^Unexpected token/, 'unexpected token'), line };
}

function stripJsonc(text) {
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      out += ch;
      if (ch === '\\') { out += text[i + 1] ?? ''; i++; } else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; out += ch; continue; }
    if (ch === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue; }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const chunk = text.slice(i, end < 0 ? text.length : end + 2);
      out += chunk.replace(/[^\n]/g, ' ');
      i = end < 0 ? text.length : end + 1;
      continue;
    }
    out += ch;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

/** Line number of the first `"key"` occurrence in JSON text (best effort for findings). */
function jsonKeyLine(text, key, from = 0) {
  if (!text) return null;
  const idx = text.indexOf(`"${key}"`, from);
  return idx < 0 ? null : lineOf(text, idx);
}

/** Markdown lines with code-fence state; inline code spans are blanked in `prose`. */
function markdownLines(text) {
  const out = [];
  let fence = null;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const m = /^\s*(`{3,}|~{3,})(.*)$/.exec(raw);
    if (fence) {
      if (m && m[1][0] === fence.ch && m[1].length >= fence.len && m[2].trim() === '') {
        out.push({ n: i + 1, raw, code: true, fenceEnd: true, lang: fence.lang });
        fence = null;
      } else out.push({ n: i + 1, raw, code: true, lang: fence.lang });
      continue;
    }
    if (m) {
      fence = { ch: m[1][0], len: m[1].length, lang: m[2].trim().split(/\s+/)[0] || '' };
      out.push({ n: i + 1, raw, code: true, fenceStart: true, lang: fence.lang });
      continue;
    }
    out.push({ n: i + 1, raw, code: false, prose: raw.replace(/(`+)[^`]*?\1/g, (s) => ' '.repeat(s.length)) });
  }
  return out;
}

/** Relative and absolute Markdown link targets outside code: [{line, target}]. */
function markdownLinks(text) {
  const links = [];
  for (const l of markdownLines(text)) {
    if (l.code) continue;
    const re = /!?\[(?:[^\]\\]|\\.)*\]\(\s*(<[^>]*>|[^()\s]+(?:\([^()\s]*\)[^()\s]*)*)(?:\s+["'(][^)]*)?\)/g;
    let m;
    while ((m = re.exec(l.prose))) links.push({ line: l.n, target: m[1].replace(/^<|>$/g, '') });
    const ref = /^\s{0,3}\[[^\]]+\]:\s*(\S+)/.exec(l.prose);
    if (ref) links.push({ line: l.n, target: ref[1].replace(/^<|>$/g, '') });
  }
  return links;
}

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const WIN_ABS_RE = /^[a-zA-Z]:[\\/]/;

function isExternalTarget(t) {
  return (SCHEME_RE.test(t) && !WIN_ABS_RE.test(t) && !/^file:/i.test(t)) || t.startsWith('#') || t.startsWith('//');
}

function linkPathOf(target) {
  let t = target.split('#')[0].split('?')[0];
  try { t = decodeURIComponent(t); } catch {}
  return t;
}

/** Shell-like quote context scan: returns tokens outside quotes and flags for the cross-shell rules. */
function scanShell(cmd) {
  const issues = [];
  let quote = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote === "'") { if (ch === "'") quote = null; continue; }
    if (quote === '"') {
      if (ch === '\\' && /["\\$`]/.test(cmd[i + 1] || '')) issues.push('a backslash escape inside double quotes (PowerShell escapes with a backtick)');
      if (ch === '"') quote = null;
      if (ch === '`') issues.push('a backtick (command substitution in bash, escape character in PowerShell)');
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === '\\') issues.push('a backslash outside quotes (an escape in bash, a path separator in PowerShell)');
    if (ch === '`') issues.push('a backtick (command substitution in bash, escape character in PowerShell)');
  }
  return [...new Set(issues)];
}

const BRACED_ALLOWED = /^\$\{(?:PLUGIN_ROOT|PLUGIN_DATA|CLAUDE_PLUGIN_ROOT|CLAUDE_PLUGIN_DATA|COPILOT_PLUGIN_ROOT|COPILOT_PLUGIN_DATA)\}$/;

/** Reasons a Copilot `command` string would not run the same in bash and PowerShell. */
export function crossShellProblems(cmd) {
  const s = String(cmd);
  const out = [];
  if (/&&|\|\|/.test(s)) out.push('&& / || (not valid in Windows PowerShell 5.1)');
  if (/\bcommand\s+-v\b/.test(s)) out.push('`command -v` (a POSIX shell builtin)');
  if (/\$env:/i.test(s)) out.push('$env: (PowerShell-only syntax)');
  if (/\/dev\/null/.test(s)) out.push('/dev/null (no such path on Windows)');
  if (/(?:^|[;\s])export\s+[A-Za-z_]\w*=/.test(s)) out.push('`export VAR=` (POSIX shell only)');
  if (/^\s*[A-Za-z_]\w*=\S*\s+\S/.test(s)) out.push('a leading VAR=value prefix (POSIX shell only)');
  if (/\bif\s+\[|;\s*then\b|\bfi\b|\bdone\b|\besac\b/.test(s)) out.push('POSIX shell control syntax');
  if (/\|\s*(?:grep|sed|awk|xargs)\b/.test(s)) out.push('a pipe into a POSIX tool');
  if (/(?:^|\s)~\//.test(s)) out.push('~/ (not expanded for native commands in PowerShell)');
  for (const m of s.matchAll(/\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*/g)) {
    const tok = m[0];
    if (BRACED_ALLOWED.test(tok) || /^\$(?:HOME|true|false|null)$/i.test(tok)) continue;
    out.push(`${tok} (a shell variable in bash, a PowerShell variable in PowerShell)`);
    break;
  }
  out.push(...scanShell(s));
  return [...new Set(out)];
}

const POSIX_ONLY_CMD = /(?:^|[\s;|&(])(?:export\s+\w+=|rm\s+-[a-z]*r[a-z]*f|chmod\s|chown\s|ln\s+-s|source\s|sudo\s|grep\s|sed\s|awk\s|xargs\s|cp\s+-[a-zA-Z]*R|ls\s+-l|cat\s+<<|\$\(|\/dev\/null|mkdir\s+-p\s)/;
const SHELL_LANGS = new Set(['bash', 'sh', 'shell', 'zsh', 'console', 'shellsession', 'terminal']);
const WIN_LANGS = new Set(['powershell', 'pwsh', 'ps1', 'ps', 'cmd', 'bat', 'batch', 'bat', 'dos']);

/** Secret scanning: markers.mjs (shared with diff-scope and selftest) when present, else a built-in set. */
let secretScanner;
async function getSecretScanner() {
  if (secretScanner) return secretScanner;
  try {
    const m = await import('./markers.mjs');
    if (typeof m.scanSecrets === 'function') {
      secretScanner = (text) => m.scanSecrets(text).map((f) => ({ id: f.id, line: f.line, redacted: f.redacted }));
      return secretScanner;
    }
  } catch {}
  const patterns = [
    ['aws-access-key-id', new RegExp('\\b(?:AKIA|ASIA)[0-9A-Z]{16}\\b')],
    ['github-token', new RegExp('\\bgh[pousr]_[A-Za-z0-9]{36,}\\b')],
    ['github-fine-grained-pat', new RegExp('\\bgithub_pat_[A-Za-z0-9_]{60,}\\b')],
    ['slack-token', new RegExp('\\bxox[abposr]-[A-Za-z0-9-]{10,}')],
    ['private-key', new RegExp(['-----BEGIN', '(?:[A-Z]+ )?PRIVATE', 'KEY-----'].join(' '))],
    ['google-api-key', new RegExp('\\bAIza[0-9A-Za-z_-]{35}\\b')],
    ['stripe-live-key', new RegExp('\\b[sr]k_live_[0-9A-Za-z]{24,}\\b')],
    ['llm-api-key', new RegExp('\\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}\\b')],
    ['jwt', new RegExp('\\beyJ[A-Za-z0-9_-]{10,}\\.eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}')],
  ];
  secretScanner = (text) => {
    const found = [];
    text.split('\n').forEach((line, i) => {
      for (const [id, re] of patterns) {
        const m = re.exec(line);
        if (m) found.push({ id, line: i + 1, redacted: `${m[0].slice(0, 4)}...[REDACTED]` });
      }
    });
    return found;
  };
  return secretScanner;
}

// ---------------------------------------------------------------------------
// TOML (the subset Codex config.toml uses: tables, arrays of tables, dotted keys, strings,
// numbers, booleans, dates, arrays, inline tables)

class TomlParser {
  constructor(s) {
    this.s = s.replace(/\r\n/g, '\n');
    this.p = 0;
    this.root = {};
    this.cur = this.root;
    this.keyLines = {};
    this.prefix = '';
  }

  fail(msg) {
    const e = new Error(msg);
    e.line = lineOf(this.s, this.p);
    throw e;
  }

  ws() { while (this.s[this.p] === ' ' || this.s[this.p] === '\t') this.p++; }

  skipTrivia() {
    for (;;) {
      this.ws();
      if (this.s[this.p] === '#') while (this.p < this.s.length && this.s[this.p] !== '\n') this.p++;
      if (this.s[this.p] === '\n') { this.p++; continue; }
      return;
    }
  }

  endLine() {
    this.ws();
    if (this.s[this.p] === '#') while (this.p < this.s.length && this.s[this.p] !== '\n') this.p++;
    if (this.p < this.s.length && this.s[this.p] !== '\n') this.fail(`unexpected text: ${this.s.slice(this.p, this.p + 20)}`);
  }

  parse() {
    for (;;) {
      this.skipTrivia();
      if (this.p >= this.s.length) return this.root;
      if (this.s[this.p] === '[') {
        const isArray = this.s[this.p + 1] === '[';
        this.p += isArray ? 2 : 1;
        this.ws();
        const keys = this.keyPath();
        this.ws();
        if (isArray ? this.s.slice(this.p, this.p + 2) !== ']]' : this.s[this.p] !== ']') this.fail('unterminated table header');
        this.p += isArray ? 2 : 1;
        this.endLine();
        this.prefix = keys.join('.');
        this.keyLines[this.prefix] ??= lineOf(this.s, this.p);
        if (isArray) {
          const parent = this.walk(this.root, keys.slice(0, -1));
          const k = keys[keys.length - 1];
          if (parent[k] === undefined) parent[k] = [];
          if (!Array.isArray(parent[k])) this.fail(`${keys.join('.')} is already a table`);
          const t = {};
          parent[k].push(t);
          this.cur = t;
        } else this.cur = this.walk(this.root, keys);
        continue;
      }
      const keys = this.keyPath();
      this.ws();
      if (this.s[this.p] !== '=') this.fail('expected "=" after a key');
      this.p++;
      this.ws();
      const line = lineOf(this.s, this.p);
      const value = this.value();
      this.endLine();
      const parent = this.walk(this.cur, keys.slice(0, -1));
      const k = keys[keys.length - 1];
      if (own(parent, k)) this.fail(`duplicate key "${k}"`);
      parent[k] = value;
      this.keyLines[[this.prefix, ...keys].filter(Boolean).join('.')] = line;
    }
  }

  walk(base, keys) {
    let t = base;
    for (const k of keys) {
      if (t[k] === undefined) t[k] = {};
      t = Array.isArray(t[k]) ? t[k][t[k].length - 1] : t[k];
      if (!isObj(t)) this.fail(`"${k}" is not a table`);
    }
    return t;
  }

  keyPath() {
    const keys = [];
    for (;;) {
      this.ws();
      const ch = this.s[this.p];
      if (ch === '"') keys.push(this.basicString());
      else if (ch === "'") keys.push(this.literalString());
      else {
        const m = /^[A-Za-z0-9_-]+/.exec(this.s.slice(this.p));
        if (!m) this.fail('expected a key');
        keys.push(m[0]);
        this.p += m[0].length;
      }
      this.ws();
      if (this.s[this.p] !== '.') return keys;
      this.p++;
    }
  }

  basicString() {
    const multi = this.s.startsWith('"""', this.p);
    this.p += multi ? 3 : 1;
    if (multi && this.s[this.p] === '\n') this.p++;
    let out = '';
    for (;;) {
      if (this.p >= this.s.length) this.fail('unterminated string');
      const ch = this.s[this.p];
      if (multi ? this.s.startsWith('"""', this.p) : ch === '"') { this.p += multi ? 3 : 1; return out; }
      if (!multi && ch === '\n') this.fail('newline in a basic string');
      if (ch === '\\') {
        const e = this.s[this.p + 1];
        const map = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\', e: '\x1b' };
        if (e in map) { out += map[e]; this.p += 2; continue; }
        if (e === 'u' || e === 'U') {
          const n = e === 'u' ? 4 : 8;
          const hex = this.s.slice(this.p + 2, this.p + 2 + n);
          if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== n) this.fail('invalid unicode escape');
          out += String.fromCodePoint(parseInt(hex, 16));
          this.p += 2 + n;
          continue;
        }
        if (multi && /[ \t\n]/.test(e)) {
          this.p++;
          while (/[ \t\n]/.test(this.s[this.p] || '')) this.p++;
          continue;
        }
        this.fail(`invalid escape \\${e}`);
      }
      out += ch;
      this.p++;
    }
  }

  literalString() {
    const multi = this.s.startsWith("'''", this.p);
    this.p += multi ? 3 : 1;
    if (multi && this.s[this.p] === '\n') this.p++;
    const end = this.s.indexOf(multi ? "'''" : "'", this.p);
    if (end < 0) this.fail('unterminated string');
    const out = this.s.slice(this.p, end);
    if (!multi && out.includes('\n')) this.fail('newline in a literal string');
    this.p = end + (multi ? 3 : 1);
    return out;
  }

  value() {
    const ch = this.s[this.p];
    if (ch === '"') return this.basicString();
    if (ch === "'") return this.literalString();
    if (ch === '[') {
      this.p++;
      const arr = [];
      for (;;) {
        this.skipTrivia();
        if (this.s[this.p] === ']') { this.p++; return arr; }
        arr.push(this.value());
        this.skipTrivia();
        if (this.s[this.p] === ',') { this.p++; continue; }
        if (this.s[this.p] !== ']') this.fail('expected "," or "]" in an array');
      }
    }
    if (ch === '{') {
      this.p++;
      const t = {};
      this.ws();
      if (this.s[this.p] === '}') { this.p++; return t; }
      for (;;) {
        const keys = this.keyPath();
        this.ws();
        if (this.s[this.p] !== '=') this.fail('expected "=" in an inline table');
        this.p++;
        this.ws();
        const parent = this.walk(t, keys.slice(0, -1));
        parent[keys[keys.length - 1]] = this.value();
        this.ws();
        if (this.s[this.p] === ',') { this.p++; this.ws(); continue; }
        if (this.s[this.p] === '}') { this.p++; return t; }
        this.fail('expected "," or "}" in an inline table');
      }
    }
    const rest = this.s.slice(this.p);
    let m = /^(?:true|false)(?![A-Za-z0-9_-])/.exec(rest);
    if (m) { this.p += m[0].length; return m[0] === 'true'; }
    m = /^\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:\d{2})?)?|^\d{2}:\d{2}:\d{2}(?:\.\d+)?/.exec(rest);
    if (m) { this.p += m[0].length; return m[0]; }
    m = /^[+-]?(?:0x[0-9a-fA-F_]+|0o[0-7_]+|0b[01_]+|inf|nan|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d[\d_]*)?)(?![A-Za-z0-9_.:-])/.exec(rest);
    if (m) {
      this.p += m[0].length;
      const t = m[0].replace(/_/g, '');
      if (/inf$/.test(t)) return t.startsWith('-') ? -Infinity : Infinity;
      if (/nan$/.test(t)) return NaN;
      if (/^[+-]?0[xob]/.test(t)) return Number(t.replace(/^\+/, ''));
      return Number(t);
    }
    this.fail(`invalid value: ${rest.slice(0, 20)}`);
    return null;
  }
}

/** Parse TOML text. Returns { value, error: null | { line, message }, keyLines }. */
export function parseToml(text) {
  const p = new TomlParser(String(text ?? ''));
  try {
    return { value: p.parse(), error: null, keyLines: p.keyLines };
  } catch (err) {
    return { value: null, error: { line: err.line || 1, message: err.message }, keyLines: p.keyLines };
  }
}

// ---------------------------------------------------------------------------
// Discovery and classification

function homeDirs(env = process.env, home = os.homedir()) {
  const h = toPosix(home);
  return {
    home: h,
    copilot: toPosix(env.COPILOT_HOME || `${h}/.copilot`),
    claude: toPosix(env.CLAUDE_CONFIG_DIR || `${h}/.claude`),
    codex: toPosix(env.CODEX_HOME || `${h}/.codex`),
  };
}

const under = (abs, dir) => abs === dir || abs.startsWith(dir.endsWith('/') ? dir : `${dir}/`);

function findUp(startDir, rel, stopAt) {
  let d = startDir;
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(d, rel))) return d;
    if (stopAt && path.resolve(d) === path.resolve(stopAt)) return null;
    const parent = path.dirname(d);
    if (parent === d) return null;
    d = parent;
  }
  return null;
}

/**
 * Kind of a tooling file from its path: { kind, sub, scope, reads[] } or null when the path is
 * not a known tooling location. `sniff` also looks at content for explicitly named files.
 */
export function classifyToolingPath(absPath, { root = null, env = process.env, home, sniff = false } = {}) {
  const abs = toPosix(path.resolve(absPath));
  const b = path.posix.basename(abs);
  const dir = path.posix.dirname(abs);
  const parent = path.posix.basename(dir);
  const H = homeDirs(env, home);
  const userScope = under(abs, H.home) && (under(abs, H.copilot) || under(abs, H.claude) || under(abs, H.codex) ||
    under(abs, `${H.home}/.agents`));
  const scope = userScope ? 'user' : 'project';
  const has = (re) => re.test(abs);
  const pluginRoot = (marker) => findUp(path.dirname(absPath), marker, root);
  const res = (kind, sub, reads, extra = {}) => ({ kind, sub, scope, reads, ...extra });

  if (b === 'SKILL.md' || b.toLowerCase() === 'skill.md') return res('skill', 'skill', ['spec', 'copilot', 'claude', 'codex']);
  if (b === 'openai.yaml' && parent === 'agents' && fs.existsSync(path.join(path.dirname(path.dirname(absPath)), 'SKILL.md'))) {
    return res('codex-skill-meta', 'openai-yaml', ['codex']);
  }
  if (b.endsWith('.agent.md') || has(/(?:^|\/)\.github\/agents\/.+\.md$/) || under(abs, `${H.copilot}/agents`) ||
      has(/(?:^|\/)com\.github\.copilot\/agents\/.+\.md$/)) {
    return res('agent', 'copilot', ['copilot', 'codex']);
  }
  if (has(/(?:^|\/)\.claude\/agents\/.+\.md$/)) return res('agent', 'claude', ['claude', 'copilot', 'codex']);
  if (b.endsWith('.md') && parent === 'agents') {
    const pr = pluginRoot(path.join('.claude-plugin', 'plugin.json'));
    if (pr) return res('agent', 'claude', ['claude', 'codex'], { plugin: toPosix(pr) });
  }
  if (b.endsWith('.instructions.md')) return res('instructions', 'path-specific', ['copilot']);
  if (b === 'copilot-instructions.md') return res('instructions', 'copilot-instructions', ['copilot']);
  if (b === 'AGENTS.md') return res('instructions', 'agents-md', ['copilot', 'claude', 'codex']);
  if (b === 'AGENTS.override.md') return res('instructions', 'agents-override', ['codex']);
  if (b === 'CLAUDE.md') return res('instructions', 'claude-md', ['claude', 'copilot']);
  if (b === 'CLAUDE.local.md') return res('instructions', 'claude-local', ['claude']);
  if (b === 'GEMINI.md') return res('instructions', 'gemini-md', ['copilot']);
  if (has(/(?:^|\/)\.claude\/rules\/.+\.md$/)) return res('instructions', 'claude-rules', ['claude', 'copilot']);
  if (b.endsWith('.prompt.md')) return res('prompt', 'prompt', ['copilot']);
  if (has(/(?:^|\/)\.claude\/commands\/.+\.md$/)) return res('command', 'claude-command', ['claude', 'copilot']);

  if (has(/(?:^|\/)\.github\/hooks\/[^/]+\.json$/)) return res('hooks', 'copilot', ['copilot']);
  if (under(abs, `${H.copilot}/hooks`) && b.endsWith('.json')) return res('hooks', 'copilot', ['copilot'], { scope: 'user' });
  if (has(/(?:^|\/)com\.github\.copilot\/hooks\/hooks\.json$/)) return res('hooks', 'copilot', ['copilot'], { plugin: toPosix(path.dirname(path.dirname(path.dirname(absPath)))) });
  if (has(/(?:^|\/)\.codex\/hooks\.json$/) || abs === `${H.codex}/hooks.json`) return res('hooks', 'codex', ['codex']);
  if (has(/(?:^|\/)\.claude\/settings(?:\.local)?\.json$/) || abs === `${H.claude}/settings.json`) {
    const isUser = abs === `${H.claude}/settings.json` || abs === `${H.claude}/settings.local.json`;
    return res('settings', 'claude', isUser ? ['claude'] : ['claude', 'copilot'], { scope: isUser ? 'user' : 'project' });
  }
  if (has(/(?:^|\/)\.github\/copilot\/settings(?:\.local)?\.json$/) || abs === `${H.copilot}/settings.json`) return res('settings', 'copilot', ['copilot']);
  if (b === 'hooks.json') {
    const pr = pluginRoot(path.join('.claude-plugin', 'plugin.json'));
    if (parent === 'hooks' && pr) return res('hooks', 'claude-plugin', ['claude'], { plugin: toPosix(pr) });
    const cp = pluginRoot('plugin.json');
    if (cp) return res('hooks', 'copilot', ['copilot'], { plugin: toPosix(cp) });
  }
  if (has(/(?:^|\/)\.claude-plugin\/plugin\.json$/)) return res('plugin', 'claude', ['claude', 'copilot']);
  if (has(/(?:^|\/)\.codex-plugin\/plugin\.json$/)) return res('plugin', 'codex', ['codex']);
  if (b === 'plugin.json') {
    const data = parseJson(readTextNormalized(absPath) || '').value;
    if (isObj(data) && typeof data.$schema === 'string' && /agent-plugins\.org/.test(data.$schema)) return res('plugin', 'agent-plugins', ['copilot', 'codex']);
    if (parent === '.plugin' || has(/(?:^|\/)\.github\/plugin\/plugin\.json$/) || sniff || fs.existsSync(path.join(path.dirname(absPath), 'skills'))) {
      return res('plugin', 'copilot', ['copilot']);
    }
  }
  if (has(/(?:^|\/)\.claude-plugin\/marketplace\.json$/)) return res('marketplace', 'claude', ['claude', 'copilot', 'codex']);
  if (has(/(?:^|\/)\.agents\/plugins\/(?:api_)?marketplace\.json$/)) return res('marketplace', 'codex', ['codex']);
  if (b === 'marketplace.json' && (parent === '.plugin' || has(/(?:^|\/)\.github\/plugin\/marketplace\.json$/) || sniff)) {
    return res('marketplace', 'copilot', ['copilot']);
  }
  if (has(/(?:^|\/)\.vscode\/mcp\.json$/)) return res('mcp', 'vscode', ['copilot']);
  if (b === '.mcp.json') return res('mcp', 'portable', ['copilot', 'claude']);
  if (has(/(?:^|\/)\.github\/mcp\.json$/) || b === 'mcp-config.json') return res('mcp', 'copilot', ['copilot']);
  if (b === 'mcp.json' && fs.existsSync(path.join(path.dirname(absPath), 'plugin.json'))) return res('mcp', 'agent-plugins', ['copilot', 'codex']);
  if (has(/(?:^|\/)\.codex\/config\.toml$/) || abs === `${H.codex}/config.toml`) return res('codex-config', 'config', ['codex']);

  if (!sniff) return null;
  // Explicitly named files outside the conventional locations: decide by content.
  const text = readTextNormalized(absPath);
  if (text == null) return null;
  if (b.endsWith('.json')) {
    const v = parseJson(text, { jsonc: true }).value;
    if (isObj(v) && isObj(v.hooks)) {
      const events = Object.keys(v.hooks);
      if (own(v, 'version') || events.some((e) => CP_EVENTS_CAMEL.includes(e))) return res('hooks', 'copilot', ['copilot']);
      if (/"commandWindows"/.test(text)) return res('hooks', 'codex', ['codex']);
      return res('hooks', 'claude-plugin', ['claude'], { plugin: null });
    }
    if (isObj(v) && (isObj(v.mcpServers) || isObj(v.servers))) return res('mcp', isObj(v.servers) ? 'vscode' : 'portable', isObj(v.servers) ? ['copilot'] : ['copilot', 'claude']);
  }
  if (b.endsWith('.toml')) return res('codex-config', 'config', ['codex']);
  if (b.endsWith('.md')) return res('instructions', 'generic', ['copilot', 'claude', 'codex']);
  return null;
}

/** Tooling files under `dir` (skipping dependency and build folders). */
function discover(dir, ctx) {
  const IGNORE = new Set(['.git', 'node_modules', '.adc', '.venv', 'venv', '__pycache__', 'target', 'dist', 'build', 'obj', '.next',
    '.turbo', '.tox', 'vendor', 'coverage', '.cache']);
  const out = [];
  const walk = (d, depth) => {
    if (depth > 12 || out.length > 5000) return;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (IGNORE.has(e.name)) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.isFile()) {
        const c = classifyToolingPath(full, ctx);
        if (c) out.push({ abs: full, ...c });
      }
    }
  };
  walk(dir, 0);
  return out;
}

// ---------------------------------------------------------------------------
// Lint run and per-file findings

class LintRun {
  constructor({ host = 'all', strict = false, root, env = process.env, home = os.homedir(), allowHosts = [] }) {
    this.host = host;
    this.selected = host === 'all' ? [...HOSTS] : strict && host !== 'spec' ? [host, 'spec'] : [host];
    this.strict = Boolean(strict);
    this.root = path.resolve(root);
    this.env = env;
    this.home = home;
    this.allowHosts = new Set(['localhost', '127.0.0.1', '[::1]', '::1', ...allowHosts.map((h) => String(h).toLowerCase())]);
    this.files = [];
    this.security = [];
    this.secSeen = new Set();
    this.directives = [];
  }

  display(abs) {
    const rel = path.relative(this.root, abs);
    return !rel ? '.' : rel.startsWith('..') || path.isAbsolute(rel) ? toPosix(abs) : toPosix(rel);
  }
}

class FileLint {
  constructor(run, abs, cls) {
    this.run = run;
    this.abs = abs;
    this.cls = cls;
    this.path = run.display(abs);
    this.hosts = cls.reads.filter((h) => run.selected.includes(h));
    this.results = new Map(this.hosts.map((h) => [h, { host: h, errors: [], warnings: [], notes: [] }]));
    this.seen = new Set();
  }

  /** Record a finding for every selected host the rule applies to (`only` narrows the hosts). */
  emit(id, { line = null, message, field, evidence, only, severity, strictSeverity } = {}) {
    const rule = RULE_INDEX.get(id);
    if (!rule) throw new Error(`unknown lint rule ${id}`);
    for (const [host, defSev] of Object.entries(rule.hosts)) {
      if (only && !only.includes(host)) continue;
      const r = this.results.get(host);
      if (!r) continue;
      let sev = severity && typeof severity === 'object' ? (severity[host] || defSev) : (severity || defSev);
      if (this.run.strict && rule.strict && rule.strict[host]) sev = rule.strict[host];
      if (this.run.strict && strictSeverity) sev = typeof strictSeverity === 'object' ? (strictSeverity[host] || sev) : strictSeverity;
      const msg = typeof message === 'function' ? message(host) : (message || rule.title);
      const key = `${host}|${id}|${line}|${msg}`;
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      const f = { rule: id, line: line ?? null, message: msg };
      if (field) f.field = field;
      if (evidence) f.evidence = truncate(String(evidence), 160);
      r[sev === 'error' ? 'errors' : sev === 'warning' ? 'warnings' : 'notes'].push(f);
    }
  }

  sec(id, { line = null, message, evidence, severity } = {}) {
    const rule = RULE_INDEX.get(id);
    const key = `${id}|${this.path}|${line}|${message}`;
    if (this.run.secSeen.has(key)) return;
    this.run.secSeen.add(key);
    this.run.security.push({ rule: id, severity: severity || rule.severity, file: this.path, line, message: message || rule.title,
      ...(evidence ? { evidence: truncate(String(evidence), 160) } : {}) });
  }

  toJSON() {
    return { path: this.path, kind: this.cls.kind, sub: this.cls.sub, scope: this.cls.scope, reads: this.cls.reads,
      host_results: [...this.results.values()] };
  }
}

// ---------------------------------------------------------------------------
// Text checks shared by every Markdown kind

const PIPE_SHELL = [
  /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b/i,
  /\b(?:iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^\n|]*\|\s*(?:iex|Invoke-Expression)\b/i,
  /\b(?:iex|Invoke-Expression)\s*\(?\s*\(?\s*(?:iwr|irm|Invoke-WebRequest|Invoke-RestMethod|New-Object\s+Net\.WebClient)/i,
  /\b(?:ba)?sh\s+<\(\s*(?:curl|wget)\b/i,
];
const DISABLE_GUARDS = [
  /--dangerously-skip-permissions\b/, /--dangerously-bypass-approvals-and-sandbox\b/, /--dangerously-bypass-hook-trust\b/,
  /--bypass-hook-trust\b/, /(?:^|\s)--yolo\b/, /--allow-all-tools\b/, /(?:^|\s)--allow-all\b/, /\bCOPILOT_ALLOW_ALL\s*=\s*["']?true/i,
  /"?disableAllHooks"?\s*[:=]\s*true/, /\bbypassPermissions\b/, /\bdanger-full-access\b/, /approval_policy\s*=\s*["']?never/,
  /\bgit\s+commit\b[^\n]*--no-verify\b/,
];
const BASE64_BLOB = /[A-Za-z0-9+/]{200,}={0,2}/;

async function securityText(fl, text, { lineOffset = 0, markdown = true } = {}) {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const n = i + 1 + lineOffset;
    if (markdown) {
      if (PIPE_SHELL.some((re) => re.test(l))) fl.sec('SEC-PIPE-SHELL', { line: n, message: 'downloads and executes a script; pin and verify it instead', evidence: l.trim() });
      if (BASE64_BLOB.test(l)) fl.sec('SEC-BASE64', { line: n, message: 'a base64 blob of 200+ characters hides content from review' });
      const g = DISABLE_GUARDS.find((re) => re.test(l));
      if (g) fl.sec('SEC-DISABLE-GUARDS', { line: n, message: `turns off a safety control (${g.exec(l)[0].trim()})`, evidence: l.trim() });
    }
  }
  const scan = await getSecretScanner();
  for (const s of scan(text)) {
    fl.sec('SEC-SECRET', { line: s.line + lineOffset, message: `secret-shaped value (${s.id}); remove it and rotate the credential`, evidence: s.redacted });
  }
}

const XML_TAG = /<\/?[A-Za-z][\w:-]*(?:\s[^<>]*)?\/?>/;
const FIRST_PERSON = /^\s*(?:i|i'm|i am|i can|i will|i'll|we|we'll|we can|we will|my|our|let me)\b/i;
const SECOND_PERSON = /^\s*(?:you can|you should|you will|you may|your)\b/i;
const SHELL_TOOLS = /^(?:shell|bash|Bash|powershell|PowerShell|execute|\*)$|^(?:shell|bash|Bash|powershell|PowerShell)\(\s*(?:\*|\*:\*|:\*)?\s*\)$/;

function frontmatterOf(text) {
  return text.startsWith('---') || text.charCodeAt(0) === 0xfeff ? parseFrontmatter(text) : null;
}

/** Links, references, footprint and body rules for a skill directory. */
function skillStructure(fl, dir, body, offset) {
  const linked = new Set();
  // A plain or backticked mention of the path also tells the model to read the file.
  for (const m of body.matchAll(/(?:^|[\s`'"(\/{}])(references\/[\w./-]+\.\w+)/g)) linked.add(path.resolve(dir, m[1]));
  for (const { line, target } of markdownLinks(body)) {
    const n = line + offset;
    if (isExternalTarget(target)) continue;
    const t = linkPathOf(target);
    if (!t) continue;
    if (target.includes('\\')) { fl.emit('SK-LINK-BACKSLASH', { line: n, message: `link "${target}" uses backslashes; use forward slashes` }); continue; }
    if (t.startsWith('/') || WIN_ABS_RE.test(t) || /^file:/i.test(target) || t.startsWith('~')) {
      fl.emit('SK-LINK-ABSOLUTE', { line: n, message: `link "${target}" is an absolute local path` });
      continue;
    }
    const resolved = path.resolve(dir, t);
    const rel = toPosix(path.relative(dir, resolved));
    if (rel.startsWith('..')) { fl.emit('SK-LINK-ABSOLUTE', { line: n, message: `link "${target}" points outside the skill folder; it is not installed with the skill` }); continue; }
    if (!fs.existsSync(resolved)) fl.emit('SK-LINK-MISSING', { line: n, message: `link target ${rel} does not exist` });
    else linked.add(resolved);
    if (rel.startsWith('references/') && rel.split('/').length > 2) fl.emit('SK-REF-DEPTH', { line: n, message: `${rel} is nested below references/` });
  }
  const refDir = path.join(dir, 'references');
  if (statSafe(refDir)?.isDirectory()) {
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        const rel = toPosix(path.relative(dir, full));
        if (e.isDirectory()) { fl.emit('SK-REF-DEPTH', { message: `${rel}/ nests reference files more than one level deep` }); walk(full); continue; }
        if (!linked.has(full)) fl.emit('SK-REF-UNLINKED', { message: `${rel} is not linked from SKILL.md, so hosts may never load it` });
      }
    };
    walk(refDir);
  }
  // Footprint as Copilot lists it (node_modules, bin, obj and dist are hidden from the listing).
  let files = 0;
  const HIDDEN = new Set(['.git', 'node_modules', 'bin', 'obj', 'dist']);
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    const visible = entries.filter((e) => !HIDDEN.has(e.name));
    if (visible.length > 50) fl.emit('SK-FOOTPRINT-FOLDER', { message: `${toPosix(path.relative(dir, d)) || '.'}/ has ${visible.length} entries (Copilot summarizes folders over 50)` });
    for (const e of visible) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) {
        files++;
        const st = statSafe(full);
        if (st && st.size > 5 * 1024 * 1024) fl.emit('SK-ASSET-SIZE', { message: `${toPosix(path.relative(dir, full))} is ${(st.size / 1048576).toFixed(1)} MB (limit 5 MB)` });
      }
    }
  };
  walk(dir);
  if (files > 100) fl.emit('SK-FOOTPRINT-FILES', { message: `the skill folder has ${files} files (Copilot lists at most 100)` });
}

async function lintSkillFile(fl) {
  const raw = fs.readFileSync(fl.abs, 'utf8').replace(/\r\n/g, '\n');
  const dir = path.dirname(fl.abs);
  const dirName = path.basename(dir);
  const base = path.basename(fl.abs);
  if (base !== 'SKILL.md') fl.emit('SK-FILENAME', { message: `the file is named ${base}; hosts look for SKILL.md` });
  const fm = parseFrontmatter(raw);
  if (fm.bom) fl.emit('SK-FM-BOM', { line: 1, message: 'the file starts with a UTF-8 byte-order mark; save it as UTF-8 without BOM' });
  if (!fm.hasFrontmatter) {
    fl.emit('SK-FM-LINE1', { line: fm.lateOpenLine || 1, message: fm.lateOpenLine
      ? `frontmatter starts on line ${fm.lateOpenLine}; hosts read it only when "---" is line 1` : 'no YAML frontmatter ("---" on line 1)' });
  }
  for (const e of fm.errors) fl.emit('SK-FM-YAML', { line: e.line, message: `frontmatter YAML: ${e.message}` });
  for (const w of fm.warnings) {
    if (w.code === 'UNQUOTED_COLON') fl.emit('SK-FM-COLON', { line: w.line, message: w.message });
    else if (w.code === 'RESERVED_INDICATOR') fl.emit('SK-FM-YAML', { line: w.line, message: `frontmatter YAML: ${w.message}` });
    else fl.emit('SK-FM-YAML', { line: w.line, message: `frontmatter YAML: ${w.message}`, severity: 'warning' });
  }
  const data = fm.data || {};
  const L = (k) => fm.keyLines[k] || null;
  if (fm.hasFrontmatter && !fm.errors.length) {
    const name = data.name;
    if (name === undefined || name === null || name === '') fl.emit('SK-NAME-REQUIRED', { line: 1, message: '`name` is missing' });
    else {
      const n = String(name);
      if (typeof name !== 'string') fl.emit('SK-NAME-FORMAT', { line: L('name'), message: '`name` must be a string' });
      if (n.length > 64) fl.emit('SK-NAME-LENGTH', { line: L('name'), message: `\`name\` has ${n.length} characters (max 64)` });
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(n)) {
        const why = /[A-Z]/.test(n) ? 'uppercase letters' : /^-|-$/.test(n) ? 'a leading or trailing hyphen' : /--/.test(n) ? 'a double hyphen'
          : 'characters other than a-z, 0-9 and -';
        fl.emit('SK-NAME-FORMAT', { line: L('name'), message: `\`name\` "${n}" has ${why}` });
      }
      if (n.normalize('NFKC') !== dirName.normalize('NFKC')) fl.emit('SK-NAME-DIR', { line: L('name'), message: `\`name\` "${n}" differs from the directory name "${dirName}"` });
      if (/claude|anthropic/i.test(n)) fl.emit('SK-NAME-RESERVED', { line: L('name'), message: `\`name\` "${n}" contains a reserved word` });
    }
    const d = data.description;
    if (d === undefined || d === null || (typeof d === 'string' && !d.trim())) fl.emit('SK-DESC-REQUIRED', { line: L('description') || 1, message: '`description` is missing or empty' });
    else if (typeof d !== 'string') fl.emit('SK-DESC-TYPE', { line: L('description'), message: '`description` must be a string' });
    else {
      if (d.length > 1024) fl.emit('SK-DESC-LENGTH', { line: L('description'), message: `\`description\` has ${d.length} characters (max 1,024)` });
      const listing = d.length + (typeof data.when_to_use === 'string' ? data.when_to_use.length : 0);
      if (listing > 1536) fl.emit('SK-DESC-LISTING', { line: L('description'), message: `description + when_to_use is ${listing} characters; Claude Code truncates the listing at 1,536` });
      const tag = XML_TAG.exec(d);
      if (tag) fl.emit('SK-DESC-XML', { line: L('description'), message: `\`description\` contains the tag ${tag[0]}` });
      if (FIRST_PERSON.test(d) || SECOND_PERSON.test(d)) fl.emit('SK-DESC-PERSON', { line: L('description'), message: 'write the description in the third person ("Processes ...", "Use when ...")' });
    }
    for (const key of Object.keys(data)) {
      const line = L(key);
      if (!SPEC_FIELDS.includes(key)) {
        fl.emit('SK-FIELD-NONSPEC', { line, field: key, message: `"${key}" is not one of the six Agent Skills fields (name, description, license, compatibility, metadata, allowed-tools)` });
      }
      for (const host of ['copilot', 'claude', 'codex']) {
        if (SKILL_FIELDS[host].has(key) || (host === 'codex' && SPEC_FIELDS.includes(key))) continue;
        fl.emit('SK-FIELD-IGNORED', { only: [host], line, field: key, message: `${HOST_LABEL[host]} does not read "${key}"` });
      }
    }
    if (own(data, 'metadata') && data.metadata !== null) {
      const m = data.metadata;
      if (!isObj(m)) fl.emit('SK-METADATA-MAP', { line: L('metadata'), message: '`metadata` must be a mapping of string keys to string values' });
      else {
        for (const [k, v] of Object.entries(m)) {
          if (typeof v !== 'string') fl.emit('SK-METADATA-STRING', { line: L(`metadata.${k}`), field: `metadata.${k}`, message: `\`metadata.${k}\` is a ${v === null ? 'null' : Array.isArray(v) ? 'list' : typeof v}; quote it as a string` });
        }
        if (own(m, 'short-description')) {
          const s = String(m['short-description'] ?? '');
          if (s.length < 25 || s.length > 64) fl.emit('SK-SHORTDESC', { line: L('metadata.short-description'), message: `\`metadata.short-description\` has ${s.length} characters (25-64)` });
        }
      }
    }
    if (own(data, 'compatibility')) {
      const c = data.compatibility;
      if (typeof c !== 'string' || c.length < 1 || c.length > 500) fl.emit('SK-COMPAT-LENGTH', { line: L('compatibility'), message: `\`compatibility\` must be a 1-500 character string${typeof c === 'string' ? ` (has ${c.length})` : ''}` });
    }
    if (own(data, 'allowed-tools')) {
      const at = data['allowed-tools'];
      if (Array.isArray(at)) fl.emit('SK-ALLOWED-TOOLS-TYPE', { line: L('allowed-tools'), message: '`allowed-tools` is a list; the spec defines a space-separated string' });
      const tokens = (Array.isArray(at) ? at.map(String) : String(at ?? '').split(/[\s,]+/)).map((t) => t.trim()).filter(Boolean);
      const wide = tokens.filter((t) => SHELL_TOOLS.test(t));
      if (wide.length) fl.sec('SEC-ALLOWED-TOOLS', { line: L('allowed-tools'), message: `allowed-tools pre-approves ${wide.join(', ')} for every user of this skill; keep it only for trusted, first-party skills`, evidence: tokens.join(' ') });
    }
  }
  if (/^(?:synced|anthropic-skills(?::.*)?)$/.test(dirName)) fl.emit('SK-NAME-CLAUDE-DIR', { message: `the folder name "${dirName}" is reserved by Claude Code` });

  const body = fm.hasFrontmatter ? fm.body : raw;
  const offset = fm.hasFrontmatter ? fm.bodyStartLine - 1 : 0;
  const trimmed = body.replace(/\n+$/, '');
  const count = trimmed.trim() ? trimmed.split('\n').length : 0;
  if (!body.trim()) fl.emit('SK-BODY-EMPTY', { message: 'the skill has no instructions after the frontmatter' });
  if (count > 500) fl.emit('SK-BODY-LINES', { message: `the body has ${count} lines (keep it under 500; move detail to references/)` });
  const tokens = Math.ceil(body.length / 4);
  if (tokens > 5000) fl.emit('SK-BODY-TOKENS', { message: `the body is about ${tokens} tokens (keep it under 5,000)` });
  body.split('\n').forEach((line, i) => {
    const n = i + 1 + offset;
    if (/\$ARGUMENTS\b/.test(line)) fl.emit('SK-SUBST', { line: n, message: '$ARGUMENTS is substituted only by Claude Code; refer to "the text after the skill name"' });
    const cv = /\$\{CLAUDE_(?:SKILL_DIR|PROJECT_DIR|SESSION_ID|EFFORT|PLUGIN_ROOT|PLUGIN_DATA)\}/.exec(line);
    if (cv) fl.emit('SK-SUBST', { line: n, message: `${cv[0]} is substituted only by Claude Code` });
    if (/(?:^|\s)!`[^`]+`/.test(line) || /^\s*(?:`{3,}|~{3,})!/.test(line)) fl.emit('SK-SUBST', { line: n, message: 'dynamic context (!`cmd`) runs only in Claude Code' });
    // $N outside currency-like text ($1,845.00, $1k, $12.3M).
    const pos = /(?<![\\\w$])\$[0-9](?![0-9]|[.,]\d|[kKmMbB]\b)/.exec(line);
    if (pos) fl.emit('SK-SUBST-POSITIONAL', { line: n, message: `${pos[0]} is replaced with an argument by Claude Code; escape it as \\${pos[0]}` });
  });
  skillStructure(fl, dir, body, offset);
  await securityText(fl, body, { lineOffset: offset });
  const fmText = fm.raw || '';
  if (fmText) {
    const scan = await getSecretScanner();
    for (const s of scan(fmText)) fl.sec('SEC-SECRET', { line: s.line + 1, message: `secret-shaped value (${s.id}) in the frontmatter`, evidence: s.redacted });
  }
  return { data, fm };
}

function lintOpenaiYaml(fl) {
  const text = readTextNormalized(fl.abs) || '';
  const doc = parseYamlDocument(text);
  for (const e of doc.errors) fl.emit('CX-YAML-PARSE', { line: e.line, message: `agents/openai.yaml: ${e.message}` });
  const v = doc.value;
  if (doc.errors.length) return;
  if (!isObj(v)) { fl.emit('CX-YAML-PARSE', { line: 1, message: 'agents/openai.yaml must be a mapping' }); return; }
  const L = (k) => doc.keyLines[k] || null;
  for (const k of Object.keys(v)) {
    if (!['interface', 'dependencies', 'policy'].includes(k)) fl.emit('CX-YAML-FIELD', { line: L(k), field: k, message: `unknown key "${k}"` });
  }
  const skillDir = path.dirname(path.dirname(fl.abs));
  const skillFm = parseFrontmatter(readTextNormalized(path.join(skillDir, 'SKILL.md')) || '');
  const skillName = typeof skillFm.data?.name === 'string' ? skillFm.data.name : path.basename(skillDir);
  if (isObj(v.interface)) {
    const known = ['display_name', 'short_description', 'icon_small', 'icon_large', 'brand_color', 'default_prompt'];
    for (const k of Object.keys(v.interface)) {
      if (!known.includes(k)) fl.emit('CX-YAML-FIELD', { line: L(`interface.${k}`), field: `interface.${k}`, message: `unknown key "interface.${k}"` });
    }
    const sd = v.interface.short_description;
    if (sd !== undefined && (String(sd).length < 25 || String(sd).length > 64)) {
      fl.emit('CX-YAML-SHORTDESC', { line: L('interface.short_description'), message: `\`interface.short_description\` has ${String(sd).length} characters (25-64)` });
    }
    const dp = v.interface.default_prompt;
    if (dp !== undefined && !String(dp).includes(`$${skillName}`)) {
      fl.emit('CX-YAML-PROMPT', { line: L('interface.default_prompt'), message: `\`interface.default_prompt\` should mention $${skillName}` });
    }
    if (v.interface.brand_color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(String(v.interface.brand_color))) {
      fl.emit('CX-YAML-FIELD', { line: L('interface.brand_color'), message: '`interface.brand_color` is a #RRGGBB color' });
    }
  } else if (v.interface !== undefined) fl.emit('CX-YAML-FIELD', { line: L('interface'), message: '`interface` must be a mapping' });
  if (isObj(v.policy)) {
    const a = v.policy.allow_implicit_invocation;
    if (a !== undefined && typeof a !== 'boolean') fl.emit('CX-YAML-POLICY', { line: L('policy.allow_implicit_invocation'), message: '`policy.allow_implicit_invocation` must be true or false' });
    if (v.policy.products !== undefined && !Array.isArray(v.policy.products)) fl.emit('CX-YAML-FIELD', { line: L('policy.products'), message: '`policy.products` must be a list' });
  }
  const tools = isObj(v.dependencies) ? v.dependencies.tools : undefined;
  if (tools !== undefined) {
    if (!Array.isArray(tools)) fl.emit('CX-YAML-DEPS', { line: L('dependencies.tools'), message: '`dependencies.tools` must be a list' });
    else tools.forEach((t, i) => {
      if (!isObj(t) || t.type !== 'mcp' || !t.value) fl.emit('CX-YAML-DEPS', { line: L(`dependencies.tools[${i}].type`) || L('dependencies.tools'), message: `dependencies.tools[${i}] needs type: mcp and a value` });
    });
  }
}

// ---------------------------------------------------------------------------
// Instructions, agents, commands, prompt files

function globProblem(g) {
  if (typeof g !== 'string' || !g.trim()) return 'an empty pattern';
  if (g.includes('\\')) return 'a backslash (use forward slashes)';
  if (g.startsWith('/') || WIN_ABS_RE.test(g) || g.startsWith('~')) return 'an absolute path (globs are relative to the repository root)';
  let brace = 0;
  let bracket = 0;
  for (const ch of g) {
    if (ch === '{') brace++;
    if (ch === '}') brace--;
    if (ch === '[') bracket++;
    if (ch === ']') bracket--;
    if (brace < 0 || bracket < 0) return 'unbalanced braces or brackets';
  }
  if (brace || bracket) return 'unbalanced braces or brackets';
  try { globToRegExp(g); } catch { return 'a pattern that does not compile'; }
  return null;
}

const USER_PATH = [
  /(?:^|[\s"'(=:])(\/(?:Users|home)\/(?!(?:<|\{|\$|%|USER\b|user\b|username\b|you\b|your|me\b|name\b|runner\b|example\b|\.\.\.))[A-Za-z0-9._-]+)/,
  /(?:^|[\s"'(=])([A-Za-z]:\\(?:Users|Documents and Settings)\\(?!(?:<|\{|\$|%|USER\b|user\b|username\b|YOUR|you\b|name\b|runneradmin\b|\.\.\.))[A-Za-z0-9._ -]+)/i,
];
const INTERNAL_HOST = /(?:^|[\s"'(@/=])((?:[a-z0-9-]+\.)+(?:internal|corp|intranet|intra|lan|local|private|home\.arpa))(?![\w.-])/i;
const PRIVATE_IP = /(?:^|[^\d.])((?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3})(?![\d.])/;
const IMPORT_RE = /(?:^|\s)@((?:\.{1,2}\/|~\/|\/)?[\w.-]+(?:\/[\w.-]+)*\.(?:md|mdc|txt|json|ya?ml|toml))(?=$|[\s,;:)\]])/g;

function textLineChecks(fl, body, offset) {
  const ml = markdownLines(body);
  let firstPosix = null;
  let hasWindowsFence = false;
  for (const l of ml) {
    const n = l.n + offset;
    for (const re of USER_PATH) {
      const m = re.exec(l.raw);
      if (m) { fl.emit('IN-ABS-PATH', { line: n, message: `user-specific path ${m[1]}; use a repository-relative path or a placeholder`, evidence: m[1] }); break; }
    }
    const h = INTERNAL_HOST.exec(l.raw);
    if (h && !/\.(?:md|mdc|json|ya?ml)$/i.test(h[1])) fl.emit('IN-HOSTNAME', { line: n, message: `internal hostname ${h[1]}`, evidence: h[1] });
    const ip = PRIVATE_IP.exec(l.raw);
    if (ip) fl.emit('IN-HOSTNAME', { line: n, message: `private IP address ${ip[1]}`, evidence: ip[1] });
    if (l.fenceStart && WIN_LANGS.has(l.lang.toLowerCase())) hasWindowsFence = true;
    if (l.code && !l.fenceStart && !l.fenceEnd && SHELL_LANGS.has(l.lang.toLowerCase()) && !firstPosix && POSIX_ONLY_CMD.test(l.raw)) firstPosix = { n, raw: l.raw };
  }
  if (firstPosix && !hasWindowsFence) {
    fl.emit('IN-BASH-ONLY', { line: firstPosix.n, message: 'POSIX-only shell commands without a PowerShell or cmd equivalent in this file', evidence: firstPosix.raw.trim() });
  }
  return ml;
}

/** Normalized directive sentences (for duplicate and contradiction checks). */
function extractDirectives(ml, offset) {
  const out = [];
  for (const l of ml) {
    if (l.code) continue;
    let t = l.raw.trim();
    if (!t || /^#{1,6}\s/.test(t) || t.startsWith('|') || t.startsWith('<!--') || /^@\S+$/.test(t)) continue;
    t = t.replace(/^(?:>\s*)?(?:[-*+]|\d+[.)])\s+/, '').replace(/^\[[ xX]\]\s+/, '');
    t = t.replace(/`([^`]*)`/g, '$1').replace(/\*\*|__/g, '').replace(/(^|\s)[*_]([^*_]+)[*_](?=\s|$|[.,;:])/g, '$1$2');
    for (const sentence of t.split(/(?<=[.!?])\s+(?=[A-Z])/)) {
      const norm = sentence.toLowerCase().replace(/\s+/g, ' ').replace(/[.;:!]+$/, '').trim();
      if (norm.split(' ').length >= 3) out.push({ line: l.n + offset, norm, raw: sentence.trim() });
    }
  }
  return out;
}

async function lintInstructions(fl) {
  const text = readTextNormalized(fl.abs) || '';
  const sub = fl.cls.sub;
  if (!text.trim()) { fl.emit('IN-EMPTY', { message: 'the file is empty' }); return; }
  const fm = frontmatterOf(text);
  if (fm) for (const e of fm.errors) fl.emit('MD-FM-YAML', { line: e.line, message: `frontmatter YAML: ${e.message}` });
  const data = fm?.data || {};
  const L = (k) => fm?.keyLines?.[k] || null;
  if (sub === 'path-specific') {
    if (!own(data, 'applyTo')) fl.emit('IN-APPLYTO-MISSING', { line: 1, message: 'no `applyTo`: the file is not applied automatically' });
    else {
      const globs = Array.isArray(data.applyTo) ? data.applyTo : String(data.applyTo ?? '').split(',');
      for (const g of globs) {
        const p = globProblem(typeof g === 'string' ? g.trim() : g);
        if (p) fl.emit('IN-APPLYTO-GLOB', { only: ['copilot'], line: L('applyTo'), message: `applyTo pattern "${g}" has ${p}` });
      }
    }
    if (own(data, 'excludeAgent')) {
      const vals = Array.isArray(data.excludeAgent) ? data.excludeAgent : [data.excludeAgent];
      for (const v of vals) if (!['code-review', 'cloud-agent'].includes(v)) fl.emit('IN-EXCLUDEAGENT', { line: L('excludeAgent'), message: `excludeAgent "${v}" is not code-review or cloud-agent` });
    }
    for (const k of Object.keys(data)) if (!INSTRUCTION_FIELDS.has(k)) fl.emit('IN-FIELD', { only: ['copilot'], line: L(k), field: k, message: `unknown frontmatter key "${k}"` });
  }
  if (sub === 'claude-rules') {
    for (const key of ['paths', 'applyTo']) {
      if (!own(data, key)) continue;
      const v = data[key];
      const globs = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [v];
      for (const g of globs) {
        const p = globProblem(typeof g === 'string' ? g.trim() : g);
        if (p) fl.emit('IN-APPLYTO-GLOB', { line: L(key), message: `${key} pattern "${g}" has ${p}` });
      }
    }
    for (const k of Object.keys(data)) if (!RULES_FILE_FIELDS.has(k)) fl.emit('IN-FIELD', { only: ['claude'], line: L(k), field: k, message: `unknown frontmatter key "${k}"` });
  }
  const body = fm && fm.hasFrontmatter ? fm.body : text;
  const offset = fm && fm.hasFrontmatter ? fm.bodyStartLine - 1 : 0;
  const lines = body.replace(/\n+$/, '').split('\n').length;
  if (lines > 1000) fl.emit('IN-LENGTH', { message: `${lines} lines; Copilot guidance keeps instruction files under about 1,000` });
  if (sub === 'claude-md' && lines > 200) fl.emit('IN-CLAUDE-LENGTH', { message: `CLAUDE.md has ${lines} lines (Claude Code guidance: under 200)` });
  const ml = textLineChecks(fl, body, offset);
  // @imports
  const dir = path.dirname(fl.abs);
  const expands = {
    'agents-md': ['copilot', 'claude'], 'claude-md': ['copilot', 'claude'], 'claude-local': ['claude'],
    'copilot-instructions': ['copilot'], 'claude-rules': ['claude'], 'agents-override': [],
  }[sub] || [];
  for (const l of ml) {
    if (l.code) continue;
    for (const m of l.prose.matchAll(IMPORT_RE)) {
      const target = m[1];
      const n = l.n + offset;
      if (sub === 'gemini-md' || sub === 'path-specific') fl.emit('IN-IMPORT-UNSUPPORTED', { only: ['copilot'], line: n, message: `@${target}: Copilot does not expand imports in ${sub === 'gemini-md' ? 'GEMINI.md' : '*.instructions.md'}` });
      if (sub === 'agents-md' || sub === 'agents-override') fl.emit('IN-IMPORT-UNSUPPORTED', { only: ['codex'], line: n, message: `@${target}: Codex has no @import; the line reaches the model as text` });
      if (target.startsWith('/') || target.startsWith('~/')) fl.emit('IN-IMPORT-ABSOLUTE', { line: n, message: `@${target} is absolute or home-relative` });
      const resolved = target.startsWith('~/') ? path.join(fl.run.home, target.slice(2)) : path.resolve(dir, target);
      if (expands.length && !fs.existsSync(resolved)) fl.emit('IN-IMPORT-MISSING', { only: expands, line: n, message: `@${target} does not exist` });
    }
  }
  await securityText(fl, body, { lineOffset: offset });
  const always = ['agents-md', 'claude-md', 'copilot-instructions', 'gemini-md'].includes(sub) ||
    (sub === 'path-specific' && ['**', '**/*', '*'].includes(String(data.applyTo ?? '').trim()));
  if (always) fl.run.directives.push({ fl, items: extractDirectives(ml, offset), dir });
  siblingInstructionChecks(fl);
}

const NEG_RE = /^(?:do not|don't|dont|never|avoid|must not|should not|shouldn't|no need to)\s+(.+)$/;
const POS_RE = /^(?:always|must|you must|please)\s+(.+)$/;
const VERB_RE = /^(?:use|run|prefer|write|add|keep|commit|call|install|put|place|name|format|indent|import|return|throw|log|test|create|edit|update|include|mention|enable|disable|set|wrap|push|merge|rebase)\b/;
const LANG_WORD = /\b(?:typescript|javascript|python|golang|go|rust|java|c#|csharp|yaml|json|markdown|css|scss|html|ts|js|py|tsx|jsx|ruby|php|shell|bash|powershell|sql|xml|kotlin|swift|scala|terraform|makefile|dockerfile|tests?)\b/;

function directiveFacets(d) {
  const f = {};
  const neg = NEG_RE.exec(d.norm);
  if (neg) f.neg = neg[1];
  else {
    const pos = POS_RE.exec(d.norm);
    if (pos) f.pos = pos[1];
    else if (VERB_RE.test(d.norm)) f.pos = d.norm;
  }
  if (!LANG_WORD.test(d.norm)) {
    const ind = /\b(\d+)[- ]space(?:s)?\b[^.]*\bindent|\bindent(?:ation|ed)?\b[^.]*?\b(\d+)\s*spaces?\b|\bindent(?:ation)?\s+(?:with|using)\s+(tabs)\b|\b(tabs)\s+for\s+indentation\b/.exec(d.norm);
    if (ind) f.indent = ind[1] || ind[2] || 'tabs';
  }
  if (!neg) {
    const pm = /\b(?:use|prefer|always use|run|install with)\s+(npm|pnpm|yarn|bun)\b/.exec(d.norm);
    if (pm) f.pm = pm[1];
  }
  return f;
}

/** Duplicates and contradictions across always-on instruction files at one directory level. */
function crossInstructionChecks(run) {
  const groups = new Map();
  for (const entry of run.directives) {
    // Nested AGENTS.md files intentionally refine their parent; compare files that apply together at the root.
    const key = toPosix(path.relative(run.root, entry.dir)).split('/')[0] === '.github' || path.resolve(entry.dir) === run.root ? 'root' : entry.dir;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  for (const entries of groups.values()) {
    const seen = new Map();
    const facets = [];
    for (const { fl, items } of entries) {
      for (const d of items) {
        const f = directiveFacets(d);
        if (d.norm.split(' ').length >= 5) {
          const prev = seen.get(d.norm);
          if (prev && prev.fl !== fl) {
            const both = fl.cls.reads.filter((h) => prev.fl.cls.reads.includes(h));
            fl.emit('IN-DUPLICATE', { only: both, line: d.line, message: `same directive as ${prev.fl.path}:${prev.line}`, evidence: d.raw });
          } else if (!prev) seen.set(d.norm, { fl, line: d.line });
        }
        for (const p of facets) {
          let why = null;
          if (f.neg && p.f.pos && f.neg === p.f.pos) why = `"${d.raw}" contradicts "${p.d.raw}"`;
          else if (f.pos && p.f.neg && f.pos === p.f.neg) why = `"${d.raw}" contradicts "${p.d.raw}"`;
          else if (f.indent && p.f.indent && f.indent !== p.f.indent) why = `indentation ${f.indent} here, ${p.f.indent} at ${p.fl.path}:${p.d.line}`;
          else if (f.pm && p.f.pm && f.pm !== p.f.pm) why = `package manager ${f.pm} here, ${p.f.pm} at ${p.fl.path}:${p.d.line}`;
          if (why) {
            const both = fl.cls.reads.filter((h) => p.fl.cls.reads.includes(h));
            fl.emit('IN-CONFLICT', { only: both, line: d.line, message: `${why} (${p.fl.path}:${p.d.line})` });
            break;
          }
        }
        facets.push({ fl, d, f });
      }
    }
  }
}

function siblingInstructionChecks(fl) {
  const dir = path.dirname(fl.abs);
  const sub = fl.cls.sub;
  const exists = (n) => fs.existsSync(path.join(dir, n));
  if (sub === 'claude-local' && exists('AGENTS.md') && !exists('CLAUDE.md')) {
    fl.emit('IN-CLAUDE-LOCAL', { message: 'CLAUDE.local.md stops Claude Code from loading AGENTS.md in this directory (unless Project instructions is claude-md-and-agents-md)' });
  }
  if (sub === 'claude-md' && exists('AGENTS.md')) {
    const t = readTextNormalized(fl.abs) || '';
    if (!/(?:^|\s)@(?:\.\/)?AGENTS\.md\b/.test(t)) fl.emit('IN-CLAUDE-AGENTS', { message: 'Claude Code ignores AGENTS.md when CLAUDE.md exists; add a line "@AGENTS.md"' });
  }
  if (sub === 'agents-md' || sub === 'agents-override') {
    // Codex concatenates one file per directory from the project root down to this one.
    let total = 0;
    const parts = [];
    const rel = path.relative(fl.run.root, dir);
    const dirs = [fl.run.root];
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      let d = fl.run.root;
      for (const seg of rel.split(path.sep)) { d = path.join(d, seg); dirs.push(d); }
    } else dirs.splice(0, 1, dir);
    for (const d of dirs) {
      for (const n of ['AGENTS.override.md', 'AGENTS.md']) {
        const st = statSafe(path.join(d, n));
        if (st && st.size > 0) { total += st.size; parts.push(`${toPosix(path.relative(fl.run.root, path.join(d, n))) || n} ${st.size} B`); break; }
      }
    }
    if (total > 32 * 1024) fl.emit('IN-AGENTS-BUDGET', { message: `Codex loads ${total} bytes of AGENTS files for this directory (budget 32,768): ${parts.join(', ')}` });
  }
}

const COPILOT_AGENT_ENUMS = { target: ['vscode', 'github-copilot'], modelPolicy: ['preferred', 'required'] };

async function lintAgent(fl) {
  const text = readTextNormalized(fl.abs) || '';
  const fm = frontmatterOf(text);
  const sub = fl.cls.sub;
  if (!fm || !fm.hasFrontmatter) fl.emit('AG-FM-MISSING', { line: 1, message: 'no YAML frontmatter with name and description' });
  if (fm) for (const e of fm.errors) fl.emit('MD-FM-YAML', { line: e.line, message: `frontmatter YAML: ${e.message}` });
  const data = fm?.data || {};
  const L = (k) => fm?.keyLines?.[k] || null;
  const body = fm?.hasFrontmatter ? fm.body : text;
  fl.emit('AG-CODEX', { message: 'Codex reads no Markdown agent files' });
  if (fm?.hasFrontmatter && !fm.errors.length) {
    if (data.description === undefined || data.description === null || String(data.description).trim() === '') fl.emit('AG-DESC-REQUIRED', { line: 1, message: '`description` is required' });
    if (sub === 'copilot') {
      const base = path.basename(fl.abs);
      if (!/^[.\-_a-zA-Z0-9]+$/.test(base)) fl.emit('AG-FILENAME', { message: `file name "${base}" has characters outside . - _ a-z A-Z 0-9` });
      if (body.length > 30000) fl.emit('AG-BODY-LENGTH', { message: `the agent prompt has ${body.length} characters (max 30,000)` });
      for (const k of Object.keys(data)) {
        if (!COPILOT_AGENT_FIELDS.has(k)) fl.emit('AG-FIELD', { only: ['copilot'], line: L(k), field: k, message: `unknown agent field "${k}" (ignored)` });
        else if (k === 'handoffs' || k === 'argument-hint') fl.emit('AG-FIELD-SURFACE', { line: L(k), field: k, message: `"${k}" is VS Code-only; the cloud agent ignores it` });
        else if (k === 'infer') fl.emit('AG-FIELD-SURFACE', { line: L(k), field: k, message: '"infer" is retired; use disable-model-invocation' });
      }
      for (const [k, vals] of Object.entries(COPILOT_AGENT_ENUMS)) {
        if (own(data, k) && !vals.includes(data[k])) fl.emit('AG-ENUM', { only: ['copilot'], line: L(k), field: k, message: `${k} "${data[k]}" is not one of ${vals.join(', ')}` });
      }
      if (own(data, 'tools') && data.tools !== null) {
        const tools = Array.isArray(data.tools) ? data.tools : String(data.tools).split(',');
        for (const t0 of tools) {
          const t = String(t0).trim();
          if (!t || COPILOT_TOOL_ALIASES.has(t) || /^[\w.-]+\/(?:\*|[\w.-]+)$/.test(t)) continue;
          fl.emit('AG-TOOLS', { line: L('tools'), message: `tool "${t}" is not a known alias or server/tool (Copilot ignores it)` });
        }
      }
    } else {
      const name = data.name;
      if (name === undefined || name === null || name === '') fl.emit('AG-NAME-REQUIRED', { line: 1, message: '`name` is required' });
      else if (String(name).length > 256 || String(name).includes(':')) fl.emit('AG-NAME-FORMAT', { line: L('name'), message: '`name` must be at most 256 characters without ":"' });
      for (const k of Object.keys(data)) if (!CLAUDE_AGENT_FIELDS.has(k)) fl.emit('AG-FIELD', { only: ['claude'], line: L(k), field: k, message: `unknown agent field "${k}" (ignored)` });
      for (const [k, vals] of Object.entries(CLAUDE_AGENT_ENUMS)) {
        if (own(data, k) && !vals.includes(data[k])) fl.emit('AG-ENUM', { only: ['claude'], line: L(k), field: k, message: `${k} "${data[k]}" is not one of ${vals.join(', ')}` });
      }
      if (fl.cls.plugin) {
        for (const k of ['hooks', 'mcpServers', 'permissionMode', 'initialPrompt']) {
          if (own(data, k)) fl.emit('AG-PLUGIN-FIELDS', { line: L(k), field: k, message: `plugin subagents ignore "${k}"` });
        }
      }
    }
  }
  await securityText(fl, body, { lineOffset: fm?.hasFrontmatter ? fm.bodyStartLine - 1 : 0 });
}

async function lintCommandOrPrompt(fl) {
  const text = readTextNormalized(fl.abs) || '';
  const fm = frontmatterOf(text);
  if (fm) for (const e of fm.errors) fl.emit('MD-FM-YAML', { line: e.line, message: `frontmatter YAML: ${e.message}` });
  const data = fm?.data || {};
  const L = (k) => fm?.keyLines?.[k] || null;
  if (fl.cls.kind === 'command') {
    fl.emit('CM-LEGACY', { message: 'legacy .claude/commands file; new work belongs in .claude/skills/<name>/SKILL.md' });
    for (const k of Object.keys(data)) {
      if (k === 'name' || k === 'paths') fl.emit('CM-FIELD', { line: L(k), field: k, message: `command files do not accept "${k}" (the file name is the command)` });
      else if (!COMMAND_FIELDS.has(k)) fl.emit('CM-FIELD', { line: L(k), field: k, message: `unknown command field "${k}"` });
    }
  } else {
    fl.emit('PR-HARNESS', { message: 'prompt files load only in the VS Code Local harness and Visual Studio; convert it to a skill for Copilot CLI and the cloud agent' });
    for (const k of Object.keys(data)) if (!PROMPT_FIELDS.has(k)) fl.emit('PR-FIELD', { line: L(k), field: k, message: `unknown prompt-file field "${k}"` });
  }
  await securityText(fl, fm?.hasFrontmatter ? fm.body : text, { lineOffset: fm?.hasFrontmatter ? fm.bodyStartLine - 1 : 0 });
}

// ---------------------------------------------------------------------------
// Hooks (Copilot, Claude Code, Codex)

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const SCRIPT_TOKEN = /(?:\$\{?(?:CLAUDE_PLUGIN_ROOT|PLUGIN_ROOT|COPILOT_PLUGIN_ROOT|CLAUDE_PROJECT_DIR)\}?[\\/])?[\w.@~${}\\/-]*[\w-]\.(?:mjs|cjs|js|ts|py|sh|ps1|rb|pl)\b/g;
const UNPINNED = [
  /\bnpx\s+(?:--yes\s+|-y\s+)(?:--?[\w-]+\s+)*(@?[\w./-]+?)(?=\s|$)/,
  /\bnpx\s+[^\n]*@latest\b/,
  /\buvx\s+(?!--from)([\w.-]+)(?=\s|$)/,
  /\bdocker\s+run\b[^\n]*\s([\w./-]+:latest)\b/,
];

function unpinnedPackage(cmdLine) {
  const s = String(cmdLine);
  for (const re of UNPINNED) {
    const m = re.exec(s);
    if (!m) continue;
    const pkg = m[1] || m[0];
    if (re === UNPINNED[0] && /@\d/.test(pkg.replace(/^@/, ''))) continue;
    if (re === UNPINNED[2] && /==|@\d/.test(pkg)) continue;
    return pkg;
  }
  return null;
}

/** Local script files a hook command refers to (read for output-shape and exit-code checks). */
function referencedScripts(fl, strings, { baseDir, pluginRoot = null }) {
  const out = [];
  for (const s of strings) {
    if (typeof s !== 'string') continue;
    for (const m of s.matchAll(SCRIPT_TOKEN)) {
      let p = m[0].replace(/^["']|["']$/g, '');
      if (/^\$\{?(?:CLAUDE_PLUGIN_ROOT|PLUGIN_ROOT|COPILOT_PLUGIN_ROOT)\}?/.test(p)) {
        if (!pluginRoot) continue;
        p = path.join(pluginRoot, p.replace(/^\$\{?[A-Z_]+\}?[\\/]/, ''));
      } else if (/^\$\{?CLAUDE_PROJECT_DIR\}?/.test(p)) p = path.join(fl.run.root, p.replace(/^\$\{?[A-Z_]+\}?[\\/]/, ''));
      else if (p.includes('<') || p.includes('$')) continue;
      else p = path.resolve(baseDir, p);
      const st = statSafe(p);
      if (st && st.isFile() && st.size < 512 * 1024) out.push({ file: p, text: readTextNormalized(p) || '' });
    }
  }
  return out;
}

function httpHookChecks(fl, ruleId, event, url, line, { strictEvents = [] } = {}) {
  let u;
  try { u = new URL(String(url)); } catch { fl.emit(ruleId, { line, message: `invalid URL "${url}"` }); return; }
  const host = u.hostname.toLowerCase();
  if (u.protocol === 'http:') {
    if (LOOPBACK.has(host)) {
      if (strictEvents.includes(event)) fl.emit(ruleId, { line, message: `${event} HTTP hooks must use https, even on localhost` });
      else if (ruleId === 'HK-CP-HTTP') fl.emit(ruleId, { line, severity: 'warning', message: 'http://localhost hooks run only with COPILOT_HOOK_ALLOW_LOCALHOST=1' });
    } else fl.emit(ruleId, { line, message: `HTTP hook URL ${u.origin} must use https` });
  } else if (u.protocol !== 'https:') fl.emit(ruleId, { line, message: `unsupported URL scheme ${u.protocol}` });
  if (!fl.run.allowHosts.has(host)) fl.sec('SEC-HTTP-HOOK', { line, message: `HTTP hook sends payloads to ${host}, which is not on the allowlist (--allow-host)`, evidence: u.origin });
}

const ASK_RE = /permissionDecision["']?\s*[:=]\s*["']ask["']/;

function lintCopilotHooks(fl, v, text, { inline = false } = {}) {
  if (!isObj(v)) { fl.emit('HK-CP-SHAPE', { line: 1, message: 'the hooks file must be a JSON object' }); return; }
  if (!inline) {
    if (!own(v, 'version')) fl.emit('HK-CP-VERSION-MISSING', { line: 1, message: 'no "version": 1' });
    else if (v.version !== 1) fl.emit('HK-CP-VERSION', { line: jsonKeyLine(text, 'version'), message: `"version" is ${JSON.stringify(v.version)}; only 1 is valid` });
    for (const k of Object.keys(v)) if (!CP_FILE_FIELDS.has(k)) fl.emit('HK-CP-FIELD', { line: jsonKeyLine(text, k), field: k, message: `unknown top-level key "${k}"` });
    if (v.disableAllHooks === true) fl.emit('HK-CP-DISABLED', { line: jsonKeyLine(text, 'disableAllHooks'), message: '"disableAllHooks": true skips every hook in this file' });
  }
  const hooks = v.hooks;
  if (!isObj(hooks)) { fl.emit('HK-CP-SHAPE', { line: jsonKeyLine(text, 'hooks') || 1, message: '"hooks" must be an object mapping event names to arrays' }); return; }
  const cloudVisible = /(?:^|\/)\.github\/hooks\//.test(toPosix(fl.abs));
  const camel = [];
  const pascal = [];
  for (const [event, entries] of Object.entries(hooks)) {
    const line = jsonKeyLine(text, event);
    if (CP_EVENTS_CAMEL.includes(event)) camel.push(event);
    else if (CP_EVENTS_PASCAL.includes(event)) pascal.push(event);
    else if (CP_EVENTS_PASCAL_UNDOC.includes(event)) {
      pascal.push(event);
      fl.emit('HK-CP-EVENT-UNDOC', { line, message: `"${event}" is not a documented PascalCase alias; use ${event[0].toLowerCase()}${event.slice(1)}` });
    } else {
      const guess = [...CP_EVENTS_CAMEL, ...CP_EVENTS_PASCAL].find((e) => e.toLowerCase() === event.toLowerCase());
      fl.emit('HK-CP-EVENT', { line, message: `"${event}" is not a Copilot hook event${guess ? ` (did you mean ${guess}?)` : ''}` });
      continue;
    }
    if (!Array.isArray(entries)) { fl.emit('HK-CP-SHAPE', { line, message: `"${event}" must be an array of hook entries` }); continue; }
    if (cloudVisible && ['notification', 'permissionRequest', 'PermissionRequest'].includes(event)) {
      fl.emit('HK-CP-CLOUD-EVENT', { line, message: `${event} hooks do not take effect in the Copilot cloud agent` });
    }
    if (['errorOccurred', 'sessionEnd', 'preCompact', 'userPromptSubmitted', 'ErrorOccurred', 'SessionEnd', 'PreCompact', 'UserPromptSubmit'].includes(event)) {
      fl.emit('HK-CP-OUTPUT-IGNORED', { line, message: `Copilot does not process the output of ${event} command hooks` });
    }
    for (const entry of entries) {
      if (!isObj(entry)) { fl.emit('HK-CP-SHAPE', { line, message: `${event}: every entry must be an object` }); continue; }
      if (Array.isArray(entry.hooks)) {
        if (entry.matcher !== undefined) copilotMatcher(fl, entry.matcher, line);
        for (const h of entry.hooks) lintCopilotEntry(fl, event, h, line, cloudVisible, true);
      } else lintCopilotEntry(fl, event, entry, line, cloudVisible, false);
    }
  }
  if (camel.length && pascal.length) fl.emit('HK-CP-MIXED-CASE', { message: `camelCase (${camel.join(', ')}) and PascalCase (${pascal.join(', ')}) events in one file receive different payload shapes` });
}

function copilotMatcher(fl, matcher, line) {
  try { new RegExp(`^(?:${matcher})$`); } catch (err) { fl.emit('HK-CP-MATCHER', { line, message: `matcher "${matcher}" is not a valid regular expression (${err.message.split(':').pop().trim()})` }); }
}

function lintCopilotEntry(fl, event, e, line, cloudVisible, nested) {
  if (!isObj(e)) { fl.emit('HK-CP-SHAPE', { line, message: `${event}: every hook must be an object` }); return; }
  const type = e.type ?? 'command';
  if (!['command', 'http', 'prompt'].includes(type)) { fl.emit('HK-CP-TYPE', { line, message: `${event}: type "${type}" is not command, http or prompt` }); return; }
  for (const k of Object.keys(e)) {
    if (CP_ENTRY_FIELDS.has(k) && !(nested && k === 'hooks')) continue;
    if (['windows', 'linux', 'osx', 'hookSpecificOutput'].includes(k)) {
      fl.emit(cloudVisible ? 'HK-CP-LOCAL-KEYS' : 'HK-CP-FIELD', { line, field: k, message: `"${k}" is a VS Code Local-harness key; Copilot ignores it` });
    } else fl.emit('HK-CP-FIELD', { line, field: k, message: `${event}: unknown key "${k}"` });
  }
  if (e.matcher !== undefined) copilotMatcher(fl, e.matcher, line);
  if (type === 'prompt') {
    if (!['sessionStart', 'SessionStart'].includes(event)) fl.emit('HK-CP-PROMPT', { line, message: `prompt hooks run only on sessionStart, not ${event}` });
    return;
  }
  if (e.timeoutSec !== undefined && !(typeof e.timeoutSec === 'number' && e.timeoutSec > 0)) {
    fl.emit('HK-CP-TIMEOUT-TYPE', { line, message: `${event}: timeoutSec must be a positive number` });
  }
  if (e.timeoutSec === undefined && e.timeout === undefined) fl.emit('HK-CP-TIMEOUT', { line, severity: 'note', strictSeverity: 'warning', message: `${event}: no timeoutSec (Copilot waits up to 30 s; set it explicitly)` });
  if (e.timeoutSec !== undefined && e.timeout !== undefined) fl.emit('HK-CP-TIMEOUT', { line, message: `${event}: both timeoutSec and timeout (VS Code Local reads them in the opposite order)` });
  const eff = typeof e.timeoutSec === 'number' ? e.timeoutSec : typeof e.timeout === 'number' ? e.timeout : null;
  if (eff !== null && eff > 30) fl.emit('HK-CP-TIMEOUT', { line, message: `${event}: timeout ${eff} s is above 30 s` });
  if (type === 'http') {
    if (typeof e.url !== 'string') fl.emit('HK-CP-HTTP', { line, message: `${event}: http hooks need a url` });
    else httpHookChecks(fl, 'HK-CP-HTTP', event, e.url, line, { strictEvents: ['preToolUse', 'PreToolUse', 'permissionRequest', 'PermissionRequest'] });
    return;
  }
  const hasBash = typeof e.bash === 'string';
  const hasPs = typeof e.powershell === 'string';
  const hasCmd = typeof e.command === 'string';
  const hasExec = e.exec !== undefined;
  if (hasExec && (hasBash || hasPs || hasCmd)) fl.emit('HK-CP-EXEC-MIX', { line, message: `${event}: exec cannot be combined with bash, powershell or command` });
  else if (hasExec) fl.emit('HK-CP-EXEC', { line, message: `${event}: exec/args entries run only in Copilot CLI` });
  if (!hasBash && !hasPs && !hasCmd && !hasExec) fl.emit('HK-CP-COMMAND', { line, message: `${event}: a command hook needs bash and powershell, command, or exec` });
  if (hasBash && !hasPs && !hasCmd) fl.emit('HK-CP-NO-WINDOWS', { line, message: `${event}: bash only; add a powershell entry for Windows` });
  if (hasPs && !hasBash && !hasCmd) fl.emit('HK-CP-PS-ONLY', { line, message: `${event}: powershell only; the cloud agent (Linux) ignores it` });
  if (hasCmd && !(hasBash && hasPs)) {
    const problems = crossShellProblems(e.command);
    if (problems.length) fl.emit('HK-XS-COMMAND', { line, message: `${event}: "command" is copied to both bash and PowerShell but uses ${problems.join('; ')}; write separate bash and powershell entries`, evidence: e.command });
  }
  if (hasPs && /&&|\|\|/.test(e.powershell)) fl.emit('HK-CP-PS-COMPAT', { line, message: `${event}: the powershell string uses && or ||, which Windows PowerShell 5.1 (the fallback launcher) rejects` });
  const strings = [e.bash, e.powershell, e.command, e.exec, ...(Array.isArray(e.args) ? e.args : [])].filter((x) => typeof x === 'string');
  const pluginRoot = fl.cls.plugin || null;
  const scripts = referencedScripts(fl, strings, { baseDir: typeof e.cwd === 'string' && !e.cwd.includes('$') ? path.resolve(fl.run.root, e.cwd) : fl.run.root, pluginRoot });
  if (strings.some((s) => ASK_RE.test(s)) || scripts.some((s) => ASK_RE.test(s.text))) {
    fl.emit('HK-CP-ASK', { line, message: `${event}: the hook can answer permissionDecision "ask", which the cloud agent and autopilot treat as deny` });
  }
  if (pluginRoot && ['preToolUse', 'PreToolUse'].includes(event) && e.cwd !== '${PLUGIN_ROOT}') {
    fl.emit('HK-CP-PLUGIN-CWD', { line, message: 'plugin preToolUse hook without "cwd": "${PLUGIN_ROOT}" may not fire (copilot-cli#2540)' });
  }
  for (const s of strings) {
    const pkg = unpinnedPackage(s);
    if (pkg) { fl.sec('SEC-UNPINNED', { line, message: `${event}: runs ${pkg} without a pinned version`, evidence: s }); break; }
  }
}

function unquotedVars(cmd) {
  const out = [];
  let quote = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '$') {
      const m = /^\$\{?(CLAUDE_PROJECT_DIR|CLAUDE_PLUGIN_ROOT|CLAUDE_PLUGIN_DATA)\}?/.exec(cmd.slice(i));
      if (m) out.push(m[0]);
    }
  }
  return out;
}

function lintClaudeHooks(fl, hooks, text, { project = false, plugin = null } = {}) {
  if (!isObj(hooks)) { fl.emit('HK-CL-SHAPE', { line: jsonKeyLine(text, 'hooks') || 1, message: '"hooks" must map event names to arrays of matcher groups' }); return; }
  for (const [event, groups] of Object.entries(hooks)) {
    const line = jsonKeyLine(text, event);
    if (!CL_EVENTS.includes(event)) {
      const guess = CL_EVENTS.find((e) => e.toLowerCase() === event.toLowerCase());
      fl.emit('HK-CL-EVENT', { line, message: `"${event}" is not a Claude Code hook event; the entry is ignored${guess ? ` (did you mean ${guess}?)` : ''}` });
    }
    if (!Array.isArray(groups)) { fl.emit('HK-CL-SHAPE', { line, message: `"${event}" must be an array of matcher groups` }); continue; }
    for (const g of groups) {
      if (!isObj(g)) { fl.emit('HK-CL-SHAPE', { line, message: `${event}: every matcher group must be an object` }); continue; }
      if (Array.isArray(g.matcher)) fl.emit('HK-CL-SHAPE', { line, message: `${event}: a matcher given as an array invalidates every hook in this file; use "A|B"` });
      else if (g.matcher !== undefined && g.matcher !== '' && g.matcher !== '*') {
        if (CL_NO_MATCHER.has(event)) fl.emit('HK-CL-MATCHER-IGNORED', { line, message: `${event} ignores matchers; "${g.matcher}" is dropped` });
        else if (typeof g.matcher === 'string' && !/^[A-Za-z0-9_ ,|-]*$/.test(g.matcher)) {
          try { new RegExp(g.matcher); } catch (err) { fl.emit('HK-CL-MATCHER', { line, message: `matcher "${g.matcher}" is not a valid regular expression` }); }
        }
      }
      for (const k of Object.keys(g)) if (!['matcher', 'hooks'].includes(k)) fl.emit('HK-CL-FIELD', { line, field: k, message: `${event}: unknown matcher-group key "${k}"` });
      if (!Array.isArray(g.hooks)) { fl.emit('HK-CL-SHAPE', { line, message: `${event}: every matcher group needs a "hooks" array` }); continue; }
      for (const h of g.hooks) lintClaudeHandler(fl, event, h, line, { project, plugin });
    }
  }
}

function lintClaudeHandler(fl, event, h, line, { project, plugin }) {
  if (!isObj(h)) { fl.emit('HK-CL-SHAPE', { line, message: `${event}: every hook handler must be an object` }); return; }
  const type = h.type;
  if (!['command', 'http', 'mcp_tool', 'prompt', 'agent'].includes(type)) { fl.emit('HK-CL-TYPE', { line, message: `${event}: handler type ${JSON.stringify(type)} is not command, http, mcp_tool, prompt or agent` }); return; }
  if (CL_EVENTS.includes(event) && !claudeTypesFor(event).includes(type)) fl.emit('HK-CL-TYPE', { line, message: `${event} does not support ${type} hooks (only ${claudeTypesFor(event).join(', ')})` });
  for (const k of Object.keys(h)) if (!CL_HANDLER_FIELDS.has(k)) fl.emit('HK-CL-FIELD', { line, field: k, message: `${event}: unknown handler field "${k}"` });
  if (h.if !== undefined && !CL_IF_EVENTS.has(event)) fl.emit('HK-CL-IF', { line, message: `${event}: "if" is evaluated only on tool events; this hook never runs` });
  if (h.once !== undefined) fl.emit('HK-CL-ONCE', { line, message: `${event}: "once" is ignored outside skill frontmatter` });
  if (h.shell !== undefined && !['bash', 'powershell'].includes(h.shell)) fl.emit('HK-CL-SHELL', { line, message: `${event}: shell "${h.shell}" is not bash or powershell` });
  if (h.onFailure !== undefined) {
    if (!['continue', 'block'].includes(h.onFailure)) fl.emit('HK-CL-ONFAILURE', { line, message: `${event}: onFailure "${h.onFailure}" is not continue or block` });
    else if (CL_ONFAILURE_NOEFFECT.has(event) || h.async) fl.emit('HK-CL-ONFAILURE', { line, severity: 'warning', message: `${event}: onFailure has no effect on ${h.async ? 'async hooks' : event}` });
    else fl.emit('HK-CL-ONFAILURE', { line, severity: 'note', message: `${event}: onFailure requires Claude Code 2.1.295 or later` });
  }
  if (type === 'http') {
    if (typeof h.url !== 'string') fl.emit('HK-CL-SHAPE', { line, message: `${event}: http hooks need a url` });
    else {
      let u = null;
      try { u = new URL(h.url); } catch {}
      if (u && !fl.run.allowHosts.has(u.hostname.toLowerCase())) fl.sec('SEC-HTTP-HOOK', { line, message: `HTTP hook sends payloads to ${u.hostname}, which is not on the allowlist (--allow-host)`, evidence: u.origin });
    }
    return;
  }
  if (type !== 'command') return;
  if (typeof h.command !== 'string' || !h.command.trim()) { fl.emit('HK-CL-SHAPE', { line, message: `${event}: a command hook needs a "command" string` }); return; }
  const exec = Array.isArray(h.args);
  if (exec) {
    const b = path.basename(h.command.replace(/\\/g, '/')).toLowerCase();
    if (/\.(?:cmd|bat)$/.test(b) || NPM_SHIMS.has(b)) fl.emit('HK-CL-EXEC-SHIM', { line, message: `${event}: exec form cannot start "${h.command}" on Windows (a .cmd shim); use "command": "node" with the script in args` });
    if (project) fl.emit('HK-CL-REPO-EXEC', { line, message: `${event}: Copilot CLI and VS Code also run this repository hook, and their handling of command+args is undocumented; use a single shell-string command` });
  } else {
    const uv = unquotedVars(h.command);
    if (uv.length) fl.emit('HK-CL-UNQUOTED-VAR', { line, message: `${event}: ${uv[0]} is not double-quoted; a path with spaces splits the command`, evidence: h.command });
    if (project) {
      const problems = crossShellProblems(h.command);
      if (problems.length) fl.emit('HK-XS-COMMAND', { only: ['copilot'], line, message: `${event}: Copilot also runs this repository hook in both bash and PowerShell, but it uses ${problems.join('; ')}`, evidence: h.command });
    }
  }
  const strings = [h.command, ...(exec ? h.args : [])].filter((x) => typeof x === 'string');
  if (plugin) {
    for (const s of strings) {
      for (const m of s.matchAll(SCRIPT_TOKEN)) {
        const tok = m[0];
        if (/^\$\{?(?:CLAUDE_PLUGIN_ROOT|PLUGIN_ROOT|CLAUDE_PROJECT_DIR)\}?/.test(tok) || /^(?:https?:|<)/.test(tok)) continue;
        fl.emit('HK-CL-PLUGIN-ROOT', { line, message: `${event}: "${tok}" should be "\${CLAUDE_PLUGIN_ROOT}/${tok.replace(/^\.\//, '')}" (relative paths resolve against the project, not the plugin)` });
        break;
      }
    }
    const scripts = referencedScripts(fl, strings, { baseDir: plugin, pluginRoot: plugin });
    const writesRoot = (t) => /(?:>>?|\btee\s+(?:-a\s+)?)\s*["']?\$\{?CLAUDE_PLUGIN_ROOT/.test(t) ||
      /(?:writeFile|appendFile|createWriteStream|mkdir)\w*\([^\n]*CLAUDE_PLUGIN_ROOT/.test(t) || /open\([^\n]*CLAUDE_PLUGIN_ROOT[^\n]*["'][wa]/.test(t);
    if (strings.some(writesRoot) || scripts.some((s) => writesRoot(s.text))) {
      fl.emit('HK-CL-PLUGIN-DATA', { line, message: `${event}: writes under \${CLAUDE_PLUGIN_ROOT}, which is replaced on every plugin update; use \${CLAUDE_PLUGIN_DATA}` });
    }
  }
  for (const s of strings) {
    const pkg = unpinnedPackage(s);
    if (pkg) { fl.sec('SEC-UNPINNED', { line, message: `${event}: runs ${pkg} without a pinned version`, evidence: s }); break; }
  }
}

/** Why a Codex `command` would fail under cmd.exe /C on Windows (when no commandWindows is given). */
function cmdExeProblems(cmd) {
  const out = [];
  if (/(?:^|\s)\.{1,2}\/[^\s]*/.test(cmd) || /\.sh\b/.test(cmd)) out.push('a ./script or .sh path');
  if (/\$\{?[A-Za-z_]/.test(cmd)) out.push('$VAR expansion (cmd.exe uses %VAR%)');
  if (/'/.test(cmd)) out.push("single quotes (cmd.exe does not treat them as quotes)");
  if (/(?:^|\s)~\//.test(cmd)) out.push('~/');
  if (/\/dev\/null/.test(cmd)) out.push('/dev/null');
  if (/\bcommand\s+-v\b|\bexport\s|;\s*then\b/.test(cmd)) out.push('POSIX shell syntax');
  return out;
}

const EXIT2_RE = /process\.exit\(\s*2\s*\)|process\.exitCode\s*=\s*2\b|(?:^|[\s;&|])exit\s+2\b|sys\.exit\(\s*2\s*\)|\[Environment\]::Exit\(\s*2\s*\)/;
const COPILOT_OUTPUT_RE = /\b(?:modifiedArgs|modifiedResult|textResultForLlm)\b/;

function lintCodexHooks(fl, v, text, { fromToml = false } = {}) {
  if (!isObj(v) || !isObj(v.hooks)) { fl.emit('HK-CX-SHAPE', { line: 1, message: 'expected {"hooks": {Event: [{"matcher"?, "hooks": [...]}]}}' }); return; }
  if (!fromToml) for (const k of Object.keys(v)) if (!['description', 'hooks'].includes(k)) fl.emit('HK-CX-FIELD', { line: jsonKeyLine(text, k), field: k, message: `unknown top-level key "${k}"` });
  const findLine = (needle) => { const i = text.indexOf(needle); return i < 0 ? null : lineOf(text, i); };
  for (const [event, groups] of Object.entries(v.hooks)) {
    if (fromToml && event === 'state') continue;
    const line = fromToml ? findLine(`hooks.${event}`) : jsonKeyLine(text, event);
    if (!CX_EVENTS.includes(event)) {
      const guess = CX_EVENTS.find((e) => e.toLowerCase() === event.toLowerCase());
      fl.emit('HK-CX-EVENT', { line, message: `"${event}" is not a Codex hook event${guess ? ` (Codex uses PascalCase: ${guess})` : ''}` });
    }
    if (!Array.isArray(groups)) { fl.emit('HK-CX-SHAPE', { line, message: `"${event}" must be an array of matcher groups` }); continue; }
    for (const g of groups) {
      if (!isObj(g) || !Array.isArray(g.hooks)) { fl.emit('HK-CX-SHAPE', { line, message: `${event}: every matcher group needs a "hooks" array` }); continue; }
      for (const k of Object.keys(g)) if (!['matcher', 'hooks'].includes(k)) fl.emit('HK-CX-FIELD', { line, field: k, message: `${event}: unknown matcher-group key "${k}"` });
      if (g.matcher !== undefined && g.matcher !== '' && g.matcher !== '*') {
        if (CX_NO_MATCHER.has(event)) fl.emit('HK-CX-MATCHER-IGNORED', { line, message: `${event} ignores matchers` });
        else if (typeof g.matcher === 'string' && !/^[A-Za-z0-9_|]+$/.test(g.matcher)) {
          try { new RegExp(g.matcher); } catch { fl.emit('HK-CX-MATCHER', { line, message: `matcher "${g.matcher}" is not a valid regular expression` }); }
        }
      }
      for (const h of g.hooks) {
        if (!isObj(h)) { fl.emit('HK-CX-SHAPE', { line, message: `${event}: every handler must be an object` }); continue; }
        if (!['command', 'mcp_tool', 'prompt', 'agent'].includes(h.type)) { fl.emit('HK-CX-TYPE', { line, message: `${event}: handler type ${JSON.stringify(h.type)} is not command or mcp_tool` }); continue; }
        if (h.type === 'prompt' || h.type === 'agent') { fl.emit('HK-CX-TYPE', { line, severity: 'warning', message: `${event}: ${h.type} handlers are parsed but Codex does not run them` }); continue; }
        for (const k of Object.keys(h)) {
          if (!CX_HANDLER_FIELDS[h.type].has(k)) fl.emit('HK-CX-FIELD', { line, field: k, message: `${event}: "${k}" is not a Codex ${h.type} handler field${['args', 'cwd', 'env'].includes(k) ? ' (Codex has no args, cwd or env)' : ''}` });
        }
        if (h.type === 'command') {
          if (typeof h.command !== 'string' || !h.command.trim()) { fl.emit('HK-CX-SHAPE', { line, message: `${event}: a command handler needs "command"` }); continue; }
          if (h.commandWindows === undefined && h.command_windows === undefined) {
            const p = cmdExeProblems(h.command);
            if (p.length) fl.emit('HK-CX-WINDOWS', { line, message: `${event}: no commandWindows, and on Windows Codex runs "command" under cmd.exe, where it uses ${p.join(', ')}` });
          }
          const strings = [h.command, h.commandWindows, h.command_windows].filter((x) => typeof x === 'string');
          const scripts = referencedScripts(fl, strings, { baseDir: fl.run.root });
          if (strings.some((s) => EXIT2_RE.test(s)) || scripts.some((s) => EXIT2_RE.test(s.text))) {
            fl.emit('HK-CX-EXIT2', { line, message: `${event}: the handler exits 2 to block; PowerShell collapses it to 1 on Windows, so print a JSON decision on exit 0` });
          }
          if (scripts.some((s) => COPILOT_OUTPUT_RE.test(s.text) && !/hookSpecificOutput/.test(s.text))) {
            fl.emit('HK-CX-OUTPUT', { line, message: `${event}: the handler prints Copilot-only fields (modifiedArgs/modifiedResult); Codex rejects unknown output fields` });
          }
          for (const s of strings) {
            const pkg = unpinnedPackage(s);
            if (pkg) { fl.sec('SEC-UNPINNED', { line, message: `${event}: runs ${pkg} without a pinned version`, evidence: s }); break; }
          }
        }
        if (['SessionEnd', 'Interrupt'].includes(event)) {
          if (typeof h.timeout === 'number' && h.timeout > 3) fl.emit('HK-CX-SESSIONEND', { line, message: `${event}: timeout ${h.timeout} s is capped at 3 s` });
          if (event === 'SessionEnd' && h.async === true) fl.emit('HK-CX-SESSIONEND', { line, message: 'SessionEnd ignores async' });
        }
      }
    }
  }
  if (/(?:^|\/)\.codex\//.test(toPosix(fl.abs)) && fl.cls.scope === 'project') {
    fl.emit('HK-CX-TRUST', { message: 'project hooks load only in a trusted project and after a one-time review in /hooks' });
  }
}

async function lintHooksOrSettings(fl) {
  const text = readTextNormalized(fl.abs) || '';
  const { kind, sub } = fl.cls;
  const dialect = sub === 'copilot' ? 'CP' : sub === 'codex' ? 'CX' : 'CL';
  const parsed = parseJson(text, { jsonc: kind === 'settings' && sub === 'copilot' });
  if (parsed.error) {
    fl.emit(`HK-${dialect}-JSON`, { line: parsed.line, message: `invalid JSON: ${parsed.error}` });
    if (kind === 'settings' && sub === 'claude' && fl.hosts.includes('copilot')) fl.emit('HK-CP-JSON', { line: parsed.line, message: `invalid JSON: ${parsed.error}` });
    return;
  }
  const v = parsed.value;
  if (kind === 'settings') {
    if (!isObj(v)) { fl.emit(`HK-${dialect}-SHAPE`, { line: 1, message: 'a settings file must be a JSON object' }); return; }
    if (own(v, 'hooks')) {
      if (sub === 'claude') lintClaudeHooks(fl, v.hooks, text, { project: fl.cls.scope === 'project' });
      else lintCopilotHooks(fl, { hooks: v.hooks }, text, { inline: true });
    }
    if (sub === 'copilot' && v.disableAllHooks === true) fl.emit('HK-CP-DISABLED', { line: jsonKeyLine(text, 'disableAllHooks'), message: '"disableAllHooks": true turns off every non-policy hook' });
  } else if (sub === 'copilot') lintCopilotHooks(fl, v, text);
  else if (sub === 'claude-plugin') {
    if (!isObj(v) || !own(v, 'hooks')) fl.emit('HK-CL-SHAPE', { line: 1, message: 'plugin hooks files keep the {"hooks": {...}} wrapper; a file without it fails to load' });
    else lintClaudeHooks(fl, v.hooks, text, { plugin: fl.cls.plugin || path.dirname(path.dirname(fl.abs)) });
  } else if (sub === 'codex') {
    lintCodexHooks(fl, v, text);
    const toml = path.join(path.dirname(fl.abs), 'config.toml');
    if (fs.existsSync(toml) && /^\s*\[\[?hooks[.\]]/m.test(readTextNormalized(toml) || '')) {
      fl.emit('HK-CX-BOTH', { message: 'this layer defines hooks in both hooks.json and config.toml; Codex loads both and warns' });
    }
  }
  const scan = await getSecretScanner();
  for (const s of scan(text)) fl.sec('SEC-SECRET', { line: s.line, message: `secret-shaped value (${s.id})`, evidence: s.redacted });
}

// ---------------------------------------------------------------------------
// Plugins, marketplaces, MCP configs, Codex config.toml

function pluginRootOf(fl) {
  const d = path.dirname(fl.abs);
  const b = path.basename(d);
  if (['.claude-plugin', '.codex-plugin', '.plugin'].includes(b)) return path.dirname(d);
  if (b === 'plugin' && path.basename(path.dirname(d)) === '.github') return path.dirname(path.dirname(d));
  return d;
}

const AP_NAME = /^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/;
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function projectSkillNames(root) {
  const names = new Map();
  for (const rel of ['.github/skills', '.agents/skills', '.claude/skills']) {
    const d = path.join(root, rel);
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) if (e.isDirectory() && fs.existsSync(path.join(d, e.name, 'SKILL.md'))) names.set(e.name, `${rel}/${e.name}`);
  }
  return names;
}

function pluginSkillCollisions(fl, pluginRoot) {
  const project = projectSkillNames(fl.run.root);
  if (!project.size) return;
  const skillsDir = path.join(pluginRoot, 'skills');
  let entries = [];
  try { entries = fs.readdirSync(skillsDir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const fm = parseFrontmatter(readTextNormalized(path.join(skillsDir, e.name, 'SKILL.md')) || '');
    const name = typeof fm.data?.name === 'string' ? fm.data.name : e.name;
    if (project.has(name) && path.resolve(path.join(fl.run.root, project.get(name))) !== path.resolve(path.join(skillsDir, e.name))) {
      fl.emit('PL-SKILL-COLLISION', { message: `plugin skill "${name}" is shadowed by the project skill ${project.get(name)}` });
    }
  }
}

function checkComponentPath(fl, ruleId, field, value, root, { skills = false } = {}) {
  const values = Array.isArray(value) ? value : [value];
  for (const p of values) {
    if (typeof p !== 'string') continue;
    if (!(p.startsWith('./') || (skills && (p === '.' || p === './')))) { fl.emit(ruleId, { field, message: `"${field}" path "${p}" must start with ./` }); continue; }
    if (p.includes('\\')) { fl.emit(ruleId, { field, message: `"${field}" path "${p}" uses backslashes` }); continue; }
    const abs = path.resolve(root, p);
    const rel = path.relative(root, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) fl.emit(ruleId, { field, message: `"${field}" path "${p}" leaves the plugin root` });
    else if (!fs.existsSync(abs)) fl.emit(ruleId, { field, message: `"${field}" path "${p}" does not exist` });
  }
}

async function lintPlugin(fl) {
  const text = readTextNormalized(fl.abs) || '';
  const parsed = parseJson(text);
  if (parsed.error) { fl.emit('PL-JSON', { line: parsed.line, message: `invalid JSON: ${parsed.error}` }); return; }
  const v = parsed.value;
  const root = pluginRootOf(fl);
  const L = (k) => jsonKeyLine(text, k);
  if (!isObj(v)) { fl.emit('PL-JSON', { line: 1, message: 'the manifest must be a JSON object' }); return; }
  const sub = fl.cls.sub;
  if (sub === 'agent-plugins') {
    if (!AP_SCHEMAS.includes(v.$schema)) fl.emit('PL-AP-SCHEMA', { line: L('$schema'), message: `$schema ${JSON.stringify(v.$schema)} is not a supported Agent Plugins version (1.0.0 or 1.1.0); Copilot rejects the plugin` });
    for (const k of Object.keys(v)) if (!AP_FIELDS.has(k)) fl.emit('PL-AP-FIELD', { line: L(k), field: k, message: `"${k}" is outside the Agent Plugins field set (put client data under "extensions")` });
    if (typeof v.name !== 'string' || !AP_NAME.test(v.name) || /--|\.\./.test(v.name)) fl.emit('PL-AP-NAME', { line: L('name'), message: `plugin name ${JSON.stringify(v.name)} is not 1-64 of a-z 0-9 - . with alphanumeric ends` });
    if (fs.existsSync(path.join(root, 'SKILL.md')) && !fs.existsSync(path.join(root, 'skills'))) fl.emit('PL-AP-SKILLS', { message: 'a root SKILL.md is not loaded by Agent Plugins; move it to skills/<name>/SKILL.md' });
    const skillsDir = path.join(root, 'skills');
    for (const e of (statSafe(skillsDir)?.isDirectory() ? fs.readdirSync(skillsDir, { withFileTypes: true }) : [])) {
      if (e.isDirectory() && !fs.existsSync(path.join(skillsDir, e.name, 'SKILL.md'))) {
        const nested = fs.readdirSync(path.join(skillsDir, e.name), { withFileTypes: true }).some((x) => x.isDirectory() && fs.existsSync(path.join(skillsDir, e.name, x.name, 'SKILL.md')));
        if (nested) fl.emit('PL-AP-SKILLS', { message: `skills/${e.name}/ nests skills one level too deep; only immediate subdirectories of skills/ load` });
      }
    }
    if (v.extensions !== undefined && !isObj(v.extensions)) fl.emit('PL-AP-FIELD', { line: L('extensions'), message: '"extensions" must be an object keyed by reverse-domain names' });
  } else if (sub === 'copilot') {
    if (typeof v.name !== 'string' || !KEBAB.test(v.name) || v.name.length > 64) fl.emit('PL-CP-MANIFEST', { line: L('name'), message: `plugin name ${JSON.stringify(v.name)} must be kebab-case, at most 64 characters` });
    if (typeof v.description === 'string' && v.description.length > 1024) fl.emit('PL-CP-MANIFEST', { line: L('description'), message: `description has ${v.description.length} characters (max 1,024)` });
    for (const k of Object.keys(v)) if (!CP_PLUGIN_FIELDS.has(k)) fl.emit('PL-CP-FIELD', { line: L(k), field: k, message: `unknown plugin field "${k}"` });
    for (const f of ['agents', 'skills', 'commands', 'hooks', 'mcpServers', 'lspServers']) {
      const val = v[f];
      for (const p of (Array.isArray(val) ? val : [val])) {
        if (typeof p === 'string' && !fs.existsSync(path.resolve(root, p))) fl.emit('PL-CP-MANIFEST', { line: L(f), field: f, message: `"${f}" path "${p}" does not exist` });
      }
    }
  } else if (sub === 'claude') {
    const name = v.name;
    if (typeof name !== 'string' || !name) fl.emit('PL-CL-NAME', { line: L('name') || 1, message: '"name" is required' });
    else {
      if (!KEBAB.test(name)) fl.emit('PL-CL-NAME', { line: L('name'), message: `plugin name "${name}" is not kebab-case` });
      if (CL_RESERVED_PLUGIN_NAMES.has(name) || CL_RESERVED_PLUGIN_PREFIXES.some((p) => name.startsWith(p))) fl.emit('PL-CL-NAME', { line: L('name'), message: `plugin name "${name}" is reserved` });
      else if (/(?:^|-)(?:claude|anthropic)(?:-|$)/.test(name)) fl.emit('PL-CL-NAME-WORD', { line: L('name'), message: `plugin name "${name}" contains a reserved word` });
    }
    for (const k of Object.keys(v)) if (!CL_PLUGIN_FIELDS.has(k)) fl.emit('PL-CL-FIELD', { line: L(k), field: k, message: `unknown plugin field "${k}"` });
    const missing = ['version', 'description', 'author'].filter((k) => v[k] === undefined);
    if (missing.length) fl.emit('PL-CL-META', { message: `no ${missing.join(', ')} (claude plugin validate warns)` });
    if (v.author !== undefined && !(isObj(v.author) && typeof v.author.name === 'string')) fl.emit('PL-CL-FIELD', { line: L('author'), field: 'author', message: '"author" needs a "name"' });
    for (const f of CL_PLUGIN_PATH_FIELDS) {
      if (v[f] === undefined || isObj(v[f])) continue;
      if (Array.isArray(v[f])) checkComponentPath(fl, 'PL-CL-PATH', f, v[f].filter((x) => typeof x === 'string'), root, { skills: f === 'skills' });
      else checkComponentPath(fl, 'PL-CL-PATH', f, v[f], root, { skills: f === 'skills' });
    }
    if (fs.existsSync(path.join(root, 'CLAUDE.md'))) fl.emit('PL-CL-CLAUDEMD', { message: 'CLAUDE.md at the plugin root is not loaded as context' });
  } else if (sub === 'codex') {
    for (const k of Object.keys(v)) {
      if (CX_PLUGIN_SNAKE[k]) fl.emit('PL-CX-FIELD', { line: L(k), field: k, severity: 'error', message: `"${k}" is snake_case; .codex-plugin/plugin.json uses "${CX_PLUGIN_SNAKE[k]}"` });
      else if (!CX_PLUGIN_FIELDS.has(k)) fl.emit('PL-CX-FIELD', { line: L(k), field: k, message: `unknown plugin field "${k}"` });
    }
    if (isObj(v.interface)) for (const k of Object.keys(v.interface)) if (CX_PLUGIN_SNAKE[k]) fl.emit('PL-CX-FIELD', { line: L(k), field: `interface.${k}`, severity: 'error', message: `"interface.${k}" is snake_case; use "${CX_PLUGIN_SNAKE[k]}"` });
  }
  pluginSkillCollisions(fl, root);
  const scan = await getSecretScanner();
  for (const s of scan(text)) fl.sec('SEC-SECRET', { line: s.line, message: `secret-shaped value (${s.id})`, evidence: s.redacted });
}

function sourcePinned(src) {
  if (typeof src === 'string') return true;
  if (!isObj(src)) return true;
  const kind = src.source;
  if (['github', 'url', 'git-subdir', 'git'].includes(kind)) return typeof src.sha === 'string' && SHA40.test(src.sha);
  if (kind === 'npm') return typeof src.version === 'string' && /\d/.test(src.version) && src.version !== 'latest';
  if (kind === 'archive') return typeof src.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(src.sha256);
  return true;
}

async function lintMarketplace(fl) {
  const text = readTextNormalized(fl.abs) || '';
  const parsed = parseJson(text);
  if (parsed.error) { fl.emit('MK-JSON', { line: parsed.line, message: `invalid JSON: ${parsed.error}` }); return; }
  const v = parsed.value;
  const L = (k) => jsonKeyLine(text, k);
  const sub = fl.cls.sub;
  if (!isObj(v)) { fl.emit('MK-SHAPE', { line: 1, message: 'the marketplace must be a JSON object' }); return; }
  if (typeof v.name !== 'string' || !v.name) fl.emit('MK-SHAPE', { line: L('name') || 1, message: '"name" is required' });
  else if (sub === 'claude' && (CL_RESERVED_MARKETPLACES.has(v.name.toLowerCase()) || /^claudeai-/i.test(v.name))) fl.emit('MK-NAME-RESERVED', { line: L('name'), message: `marketplace name "${v.name}" is reserved` });
  if (sub !== 'codex' && !(isObj(v.owner) && typeof v.owner.name === 'string')) fl.emit('MK-SHAPE', { line: L('owner') || 1, message: '"owner" with a "name" is required' });
  if (!Array.isArray(v.plugins)) { fl.emit('MK-SHAPE', { line: L('plugins') || 1, message: '"plugins" must be an array' }); return; }
  const known = sub === 'claude' ? CL_MKT_FIELDS : sub === 'codex' ? CX_MKT_FIELDS : CP_MKT_FIELDS;
  if (sub !== 'codex') for (const k of Object.keys(v)) if (!known.has(k)) fl.emit('MK-FIELD', { only: [sub === 'claude' ? 'claude' : 'copilot'], line: L(k), field: k, message: `unknown top-level key "${k}"` });
  v.plugins.forEach((entry, i) => {
    const line = isObj(entry) && entry.name ? jsonKeyLine(text, entry.name) || L('plugins') : L('plugins');
    if (!isObj(entry) || typeof entry.name !== 'string' || entry.source === undefined) { fl.emit('MK-ENTRY', { line, message: `plugins[${i}] needs "name" and "source"` }); return; }
    const src = entry.source;
    if (typeof src === 'string') {
      if (sub === 'claude' && !(src === '.' || src === './' || src.startsWith('./'))) fl.emit('MK-ENTRY', { only: ['claude'], line, message: `${entry.name}: relative source "${src}" must start with ./` });
      if (src.split('/').includes('..')) fl.emit('MK-ENTRY', { line, message: `${entry.name}: source "${src}" must not use ..` });
    } else if (isObj(src)) {
      if (src.source === 'local' && typeof src.path === 'string' && src.path.split('/').includes('..')) fl.emit('MK-ENTRY', { line, message: `${entry.name}: source path must not use ..` });
      if (!sourcePinned(src)) fl.emit('MK-UNPINNED', { line, message: `${entry.name}: ${src.source} source without a pinned ${src.source === 'npm' ? 'version' : src.source === 'archive' ? 'sha256' : '40-character sha'}` });
    } else fl.emit('MK-ENTRY', { line, message: `${entry.name}: "source" must be a path string or an object` });
    if (sub === 'claude' && entry.hooks !== undefined && !isObj(entry.hooks)) fl.emit('MK-HOOKS-PATH', { line, message: `${entry.name}: marketplace entries support hooks only as an inline object` });
  });
}

const SECRET_KEY = /(?:token|secret|password|passwd|api[_-]?key|apikey|auth|credential|bearer|cookie|private[_-]?key)/i;

function literalCredential(key, value) {
  if (typeof value !== 'string' || value.length < 8) return false;
  if (/\$\{|\$[A-Z_]|\{\{|^\$/.test(value) || /^<[^>]+>$/.test(value) || /^[A-Z][A-Z0-9_]+$/.test(value)) return false;
  if (/^(?:Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{12,}$/i.test(value)) return true;
  return SECRET_KEY.test(key) && /^[A-Za-z0-9._~+/=:-]{16,}$/.test(value) && /\d/.test(value) && /[A-Za-z]/.test(value);
}

async function mcpServerChecks(fl, name, s, text, { sub, hostTypes }) {
  const line = jsonKeyLine(text, name);
  if (!isObj(s)) { fl.emit('MC-SERVER', { line, message: `server "${name}" must be an object` }); return; }
  const type = s.type;
  for (const [host, types] of Object.entries(hostTypes)) {
    if (type !== undefined && !types.includes(type)) fl.emit('MC-SERVER', { only: [host], line, severity: host === 'claude' && type === 'local' ? 'warning' : undefined, message: `server "${name}": type "${type}" is not one of ${types.join(', ')} for ${HOST_LABEL[host]}` });
  }
  if (typeof s.command !== 'string' && typeof s.url !== 'string') fl.emit('MC-SERVER', { line, message: `server "${name}" needs a "command" (local) or a "url" (remote)` });
  if (typeof s.url === 'string') {
    try {
      const u = new URL(s.url);
      if (u.protocol === 'http:' && !LOOPBACK.has(u.hostname)) fl.emit('MC-HTTP', { line, message: `server "${name}" uses plain http to ${u.hostname}` });
    } catch { fl.emit('MC-SERVER', { line, message: `server "${name}": invalid url "${s.url}"` }); }
  }
  if (JSON.stringify(s).includes('${input:')) {
    fl.emit('MC-INPUT', { line, severity: sub === 'vscode' ? 'note' : undefined, message: sub === 'vscode' ? `server "${name}" uses \${input:...}; VS Code does not forward it to the Copilot harness` : `server "${name}" uses \${input:...}, which only VS Code resolves` });
  }
  if (sub !== 'vscode' && sub !== 'agent-plugins' && s.tools === undefined) fl.emit('MC-CLOUD', { line, message: `server "${name}" has no "tools" list (required when this JSON is used for the cloud agent)` });
  for (const bag of ['env', 'headers']) {
    if (!isObj(s[bag])) continue;
    for (const [k, val] of Object.entries(s[bag])) {
      if (literalCredential(k, val)) fl.sec('SEC-MCP-SECRET', { line: jsonKeyLine(text, k) || line, message: `server "${name}" ${bag}.${k} holds a literal credential; reference an environment variable (\${VAR})` });
    }
  }
  const cmdLine = [s.command, ...(Array.isArray(s.args) ? s.args : [])].filter((x) => typeof x === 'string').join(' ');
  const pkg = unpinnedPackage(cmdLine);
  if (pkg) fl.sec('SEC-UNPINNED', { line, message: `server "${name}" runs ${pkg} without a pinned version`, evidence: cmdLine });
}

async function lintMcp(fl) {
  const text = readTextNormalized(fl.abs) || '';
  const sub = fl.cls.sub;
  const parsed = parseJson(text, { jsonc: sub === 'vscode' });
  if (parsed.error) { fl.emit('MC-JSON', { line: parsed.line, message: `invalid JSON: ${parsed.error}` }); return; }
  const v = parsed.value;
  if (!isObj(v)) { fl.emit('MC-JSON', { line: 1, message: 'the MCP config must be a JSON object' }); return; }
  let servers;
  if (sub === 'vscode') {
    fl.emit('MC-VSCODE-CLI', { message: 'Copilot CLI does not read .vscode/mcp.json; keep shared servers in .mcp.json' });
    if (own(v, 'mcpServers') && !own(v, 'servers')) fl.emit('MC-TOPKEY', { line: jsonKeyLine(text, 'mcpServers'), message: 'VS Code reads "servers" in .vscode/mcp.json, not "mcpServers"' });
    servers = v.servers ?? v.mcpServers;
  } else if (sub === 'agent-plugins') {
    if (!AP_MCP_SCHEMAS.includes(v.$schema)) fl.emit('PL-AP-MCP', { line: jsonKeyLine(text, '$schema') || 1, message: 'mcp.json must declare "$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json"' });
    for (const k of Object.keys(v)) if (!['$schema', 'mcpServers'].includes(k)) fl.emit('PL-AP-MCP', { line: jsonKeyLine(text, k), message: `mcp.json may contain only $schema and mcpServers ("${k}")` });
    servers = v.mcpServers;
    for (const [name, s] of Object.entries(isObj(servers) ? servers : {})) {
      if (!isObj(s)) continue;
      const line = jsonKeyLine(text, name);
      if (typeof s.command === 'string') {
        if (/\s/.test(s.command.trim()) || path.isAbsolute(s.command) || WIN_ABS_RE.test(s.command)) fl.emit('PL-AP-MCP', { line, message: `server "${name}": command must be one token (a bare executable or ./relative path)` });
        if (/\$\{PLUGIN_(?:ROOT|DATA)\}/.test(s.command)) fl.emit('PL-AP-MCP', { line, message: `server "${name}": \${PLUGIN_ROOT} expands only in args, env and cwd` });
      }
      if (s.cwd !== undefined && !/^(?:\.\/|\$\{PLUGIN_ROOT\}|\$\{PLUGIN_DATA\})/.test(String(s.cwd))) fl.emit('PL-AP-MCP', { line, message: `server "${name}": cwd must start with ./, \${PLUGIN_ROOT} or \${PLUGIN_DATA}` });
      if (/\$\{PLUGIN_(?:ROOT|DATA)\}/.test(JSON.stringify([s.url ?? '', s.headers ?? {}]))) fl.emit('PL-AP-MCP', { line, message: `server "${name}": url and headers are not expanded` });
    }
  } else {
    if (own(v, 'servers') && !own(v, 'mcpServers')) fl.emit('MC-TOPKEY', { line: jsonKeyLine(text, 'servers'), message: '"servers" is the VS Code format; Copilot CLI and Claude Code read "mcpServers"' });
    servers = v.mcpServers;
    if (servers === undefined && !own(v, 'servers') && Object.values(v).some((x) => isObj(x) && (x.command || x.url))) {
      servers = v;
      fl.emit('MC-TOPKEY', { only: ['claude'], line: 1, message: 'Claude Code expects servers under "mcpServers"' });
    }
  }
  if (servers !== undefined && !isObj(servers)) { fl.emit('MC-SERVER', { line: 1, message: 'the server map must be an object' }); return; }
  const hostTypes = sub === 'vscode' ? { copilot: ['stdio', 'http', 'sse'] }
    : sub === 'agent-plugins' ? { copilot: ['stdio', 'streamable-http', 'sse'], codex: ['stdio', 'streamable-http', 'sse'] }
      : { copilot: ['local', 'stdio', 'http', 'sse'], claude: ['stdio', 'http', 'sse'] };
  for (const [name, s] of Object.entries(servers || {})) await mcpServerChecks(fl, name, s, text, { sub, hostTypes });
  const scan = await getSecretScanner();
  for (const s of scan(text)) fl.sec('SEC-SECRET', { line: s.line, message: `secret-shaped value (${s.id})`, evidence: s.redacted });
}

async function lintCodexConfig(fl) {
  const text = readTextNormalized(fl.abs) || '';
  const t = parseToml(text);
  if (t.error) { fl.emit('CX-TOML', { line: t.error.line, message: `invalid TOML: ${t.error.message}` }); return; }
  const v = t.value;
  if (isObj(v.hooks)) {
    lintCodexHooks(fl, { hooks: v.hooks }, text, { fromToml: true });
    if (fs.existsSync(path.join(path.dirname(fl.abs), 'hooks.json'))) fl.emit('HK-CX-BOTH', { message: 'this layer defines hooks in both config.toml and hooks.json; Codex loads both and warns' });
  }
  const sc = isObj(v.skills) ? v.skills.config : undefined;
  if (sc !== undefined) {
    if (!Array.isArray(sc)) fl.emit('CX-SKILLS-CONFIG', { line: t.keyLines['skills.config'] || null, message: 'skills.config must be an array of tables ([[skills.config]])' });
    else sc.forEach((e, i) => {
      const sel = ['path', 'name'].filter((k) => isObj(e) && e[k] !== undefined);
      if (sel.length !== 1 || typeof e.enabled !== 'boolean') fl.emit('CX-SKILLS-CONFIG', { line: t.keyLines['skills.config'] || null, message: `[[skills.config]] #${i + 1} needs exactly one of path or name, and enabled = true|false` });
    });
  }
  if (own(v, 'mcpServers')) fl.emit('CX-MCP', { message: 'Codex reads [mcp_servers.<name>], not mcpServers' });
  if (isObj(v.mcp_servers)) {
    for (const [name, s] of Object.entries(v.mcp_servers)) {
      if (!isObj(s) || (typeof s.command !== 'string' && typeof s.url !== 'string')) fl.emit('CX-MCP', { line: t.keyLines[`mcp_servers.${name}`] || null, message: `[mcp_servers.${name}] needs a command or a url` });
      if (isObj(s?.env)) for (const [k, val] of Object.entries(s.env)) if (literalCredential(k, val)) fl.sec('SEC-MCP-SECRET', { line: t.keyLines[`mcp_servers.${name}.env.${k}`] || t.keyLines[`mcp_servers.${name}.env`] || null, message: `[mcp_servers.${name}] env.${k} holds a literal credential` });
      const cmdLine = [s?.command, ...(Array.isArray(s?.args) ? s.args : [])].filter((x) => typeof x === 'string').join(' ');
      const pkg = unpinnedPackage(cmdLine);
      if (pkg) fl.sec('SEC-UNPINNED', { message: `[mcp_servers.${name}] runs ${pkg} without a pinned version`, evidence: cmdLine });
    }
  }
  const scan = await getSecretScanner();
  for (const s of scan(text)) fl.sec('SEC-SECRET', { line: s.line, message: `secret-shaped value (${s.id})`, evidence: s.redacted });
}

// ---------------------------------------------------------------------------
// External validators (run when installed; results merged into the per-host findings)

function execTool(exe, args, { cwd, timeoutMs = 90_000 } = {}) {
  // npm-installed CLIs are .cmd shims on Windows, which only start through the shell.
  if (IS_WINDOWS && /\.(?:cmd|bat)$/i.test(exe)) return runShell([quoteArg(exe), ...args.map(quoteArg)].join(' '), { cwd, timeoutMs });
  return run(exe, args, { cwd, timeoutMs });
}

const firstLines = (text, n = 8) => String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, n);

/**
 * Run the hosts' own validators that are installed. `targets`: { root, skills: [{dir, file}],
 * plugins: [dir], instructions: [abs], hosts: [...] }. Returns [{ tool, target, status:
 * 'pass'|'fail'|'error'|'skipped', exit, command, summary, findings: [{ abs, host, rule, severity, message }] }].
 */
export function runExternalValidators(targets, { exec = execTool, which: whichFn = which, version = toolVersion } = {}) {
  const out = [];
  const { root, skills = [], plugins = [], instructions = [], hosts = HOSTS } = targets;
  const want = (h) => hosts.includes(h);
  const rel = (p) => toPosix(path.relative(root, p)) || '.';

  if (want('spec') && skills.length) {
    const exe = whichFn('skills-ref') || whichFn('agentskills');
    for (const s of skills) {
      if (!exe) { out.push({ tool: 'skills-ref', target: rel(s.dir), status: 'skipped', exit: null, command: `skills-ref validate ${rel(s.dir)}`, summary: 'skills-ref is not installed (pip install skills-ref)', findings: [] }); continue; }
      const r = exec(exe, ['validate', s.dir], { cwd: root });
      const lines = firstLines(r.stdout + '\n' + r.stderr);
      const status = r.exit === 0 ? 'pass' : r.exit === null ? 'error' : 'fail';
      out.push({ tool: 'skills-ref', target: rel(s.dir), status, exit: r.exit, command: `skills-ref validate ${rel(s.dir)}`, summary: lines[0] || status,
        findings: status === 'fail' ? (lines.length ? lines : ['validation failed']).map((m) => ({ abs: s.file, host: 'spec', rule: 'EXT-SKILLS-REF', severity: 'error', message: `skills-ref: ${m}` })) : [] });
    }
  }

  const claudeDirs = [...new Set([...plugins, ...skills.map((s) => path.dirname(s.dir)).filter((d) => path.basename(d) === 'skills')])];
  if (want('claude') && claudeDirs.length) {
    const exe = whichFn('claude');
    const v = exe ? version('claude') : null;
    for (const dir of claudeDirs) {
      const command = `claude plugin validate ${rel(dir)} --strict --json`;
      if (!exe) { out.push({ tool: 'claude plugin validate', target: rel(dir), status: 'skipped', exit: null, command, summary: 'claude is not installed', findings: [] }); continue; }
      if (!v || !v.version || !versionGte(v.version, '2.1.259')) { out.push({ tool: 'claude plugin validate', target: rel(dir), status: 'skipped', exit: null, command, summary: `Claude Code ${v?.version || '?'} is older than 2.1.259 (--json)`, findings: [] }); continue; }
      const r = exec(exe, ['plugin', 'validate', dir, '--strict', '--json'], { cwd: root });
      let report = null;
      try { report = JSON.parse(r.stdout); } catch {}
      if (!report || r.exit === 2 || r.exit === null) {
        out.push({ tool: 'claude plugin validate', target: rel(dir), status: 'error', exit: r.exit, command, summary: firstLines(r.stderr || r.stdout)[0] || 'no JSON report', findings: [] });
        continue;
      }
      const findings = [];
      const take = (entry) => {
        if (!entry || !entry.file) return;
        const abs = path.resolve(entry.file);
        if (statSafe(abs)?.isDirectory()) return;
        for (const e of entry.errors || []) findings.push({ abs, host: 'claude', rule: 'EXT-CLAUDE-VALIDATE', severity: 'error', message: `claude plugin validate: ${e.path ? `${e.path}: ` : ''}${e.message}` });
        for (const w of entry.warnings || []) findings.push({ abs, host: 'claude', rule: 'EXT-CLAUDE-VALIDATE', severity: 'warning', message: `claude plugin validate: ${w.path ? `${w.path}: ` : ''}${w.message}` });
      };
      take(report.manifest);
      for (const c of report.contents || []) take(c);
      const dirErrors = (report.manifest?.errors || []).filter(() => statSafe(path.resolve(report.manifest.file || '.'))?.isDirectory());
      out.push({ tool: 'claude plugin validate', target: rel(dir), status: report.success ? 'pass' : 'fail', exit: r.exit, command,
        summary: report.success ? 'validation passed' : `${findings.length || dirErrors.length} issue(s)${dirErrors.length ? `: ${dirErrors[0].message}` : ''}`, findings });
    }
  }

  if (want('spec') && skills.length) {
    const exe = whichFn('gh');
    const v = exe ? version('gh') : null;
    const command = 'gh skill publish --dry-run';
    if (!exe) out.push({ tool: 'gh skill publish', target: '.', status: 'skipped', exit: null, command, summary: 'gh is not installed', findings: [] });
    else if (!v?.version || !versionGte(v.version, '2.90.0')) out.push({ tool: 'gh skill publish', target: '.', status: 'skipped', exit: null, command, summary: `gh ${v?.version || '?'} has no "gh skill" (needs 2.90.0+)`, findings: [] });
    else {
      const r = exec(exe, ['skill', 'publish', '--dry-run'], { cwd: root });
      const lines = firstLines(r.stdout + '\n' + r.stderr);
      const status = r.exit === 0 ? 'pass' : r.exit === null ? 'error' : 'fail';
      out.push({ tool: 'gh skill publish', target: '.', status, exit: r.exit, command, summary: lines[0] || status,
        findings: status === 'fail' ? skills.map((s) => ({ abs: s.file, host: 'spec', rule: 'EXT-GH-SKILL', severity: 'warning', message: `gh skill publish --dry-run: ${lines[0] || 'failed'}` })) : [] });
    }
  }

  if (want('copilot') && (skills.length || instructions.length)) {
    const exe = whichFn('copilot');
    if (!exe) out.push({ tool: 'copilot', target: '.', status: 'skipped', exit: null, command: 'copilot skill list --json; copilot instruction list --json', summary: 'copilot is not installed', findings: [] });
    else {
      const listing = (args) => {
        const r = exec(exe, args, { cwd: root, timeoutMs: 60_000 });
        let rows = null;
        try { const j = JSON.parse(r.stdout); rows = Array.isArray(j) ? j : Array.isArray(j?.skills) ? j.skills : Array.isArray(j?.instructions) ? j.instructions : null; } catch {}
        return { r, rows };
      };
      if (skills.length) {
        const { r, rows } = listing(['skill', 'list', '--json']);
        const findings = [];
        if (rows) {
          for (const s of skills) {
            const name = s.name || path.basename(s.dir);
            const row = rows.find((x) => (x.path && path.resolve(String(x.path)).startsWith(path.resolve(s.dir))) || x.name === name);
            if (!row) findings.push({ abs: s.file, host: 'copilot', rule: 'EXT-COPILOT-SKILL', severity: 'warning', message: `copilot skill list does not show "${name}" from this location` });
            else if (row.enabled === false) findings.push({ abs: s.file, host: 'copilot', rule: 'EXT-COPILOT-SKILL', severity: 'warning', message: `copilot skill list shows "${name}" as disabled` });
          }
        }
        out.push({ tool: 'copilot skill list', target: '.', status: rows ? (findings.length ? 'fail' : 'pass') : 'error', exit: r.exit, command: 'copilot skill list --json', summary: rows ? `${rows.length} skill(s) listed` : firstLines(r.stderr)[0] || 'no JSON output', findings });
      }
      if (instructions.length) {
        const { r, rows } = listing(['instruction', 'list', '--json']);
        const findings = [];
        if (rows) {
          const listed = new Set(rows.map((x) => (x.sourcePath ? path.resolve(root, String(x.sourcePath)) : null)).filter(Boolean));
          for (const f of instructions) if (!listed.has(path.resolve(f))) findings.push({ abs: f, host: 'copilot', rule: 'EXT-COPILOT-INSTRUCTION', severity: 'warning', message: 'copilot instruction list does not show this file' });
        }
        out.push({ tool: 'copilot instruction list', target: '.', status: rows ? (findings.length ? 'fail' : 'pass') : 'error', exit: r.exit, command: 'copilot instruction list --json', summary: rows ? `${rows.length} instruction source(s) listed` : firstLines(r.stderr)[0] || 'no JSON output', findings });
      }
    }
  }

  if (want('codex') && whichFn('codex')) {
    out.push({ tool: 'codex', target: '.', status: 'skipped', exit: null, command: 'codex exec --strict-config --ephemeral "reply OK"',
      summary: 'codex exec --strict-config runs a model turn (billed); run it by hand to check config.toml keys', findings: [] });
  }

  if (want('copilot') && skills.length) {
    const exe = whichFn('waza');
    for (const s of skills) {
      const name = s.name || path.basename(s.dir);
      const evalFile = [path.join(root, 'evals', name, 'eval.yaml'), path.join(s.dir, 'evals', 'eval.yaml')].find((f) => fs.existsSync(f));
      const command = `waza spec verify ${rel(s.dir)} ${evalFile ? rel(evalFile) : `evals/${name}/eval.yaml`} --fail`;
      if (!exe || !evalFile) { out.push({ tool: 'waza', target: rel(s.dir), status: 'skipped', exit: null, command, summary: !exe ? 'waza is not installed' : 'no eval.yaml for this skill', findings: [] }); continue; }
      const r = exec(exe, ['spec', 'verify', s.dir, evalFile, '--fail'], { cwd: root });
      const status = r.exit === 0 ? 'pass' : r.exit === null ? 'error' : 'fail';
      out.push({ tool: 'waza', target: rel(s.dir), status, exit: r.exit, command, summary: firstLines(r.stdout + '\n' + r.stderr)[0] || status,
        findings: status === 'fail' ? [{ abs: s.file, host: 'copilot', rule: 'EXT-WAZA', severity: 'warning', message: `waza spec verify: ${firstLines(r.stdout + '\n' + r.stderr)[0] || 'failed'}` }] : [] });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public API

const LINTERS = {
  'skill': lintSkillFile,
  'codex-skill-meta': lintOpenaiYaml,
  'instructions': lintInstructions,
  'agent': lintAgent,
  'command': lintCommandOrPrompt,
  'prompt': lintCommandOrPrompt,
  'hooks': lintHooksOrSettings,
  'settings': lintHooksOrSettings,
  'plugin': lintPlugin,
  'marketplace': lintMarketplace,
  'mcp': lintMcp,
  'codex-config': lintCodexConfig,
};

function repoRootSafe(dir) {
  try { return repoRoot(dir); } catch { return null; }
}

function summarize(run, files, external) {
  const s = { files: files.length, errors: 0, warnings: 0, notes: 0, security: run.security.length,
    security_errors: run.security.filter((x) => x.severity === 'error').length, hosts: run.selected, strict: run.strict, by_rule: {} };
  for (const f of files) {
    for (const r of f.host_results) {
      s.errors += r.errors.length;
      s.warnings += r.warnings.length;
      s.notes += r.notes.length;
      for (const x of [...r.errors, ...r.warnings, ...r.notes]) s.by_rule[x.rule] = (s.by_rule[x.rule] || 0) + 1;
    }
  }
  for (const x of run.security) s.by_rule[x.rule] = (s.by_rule[x.rule] || 0) + 1;
  s.external = { ran: external.filter((e) => e.status !== 'skipped').length, failed: external.filter((e) => e.status === 'fail').length,
    skipped: external.filter((e) => e.status === 'skipped').length };
  s.clean = s.errors === 0 && s.security_errors === 0 && (!run.strict || (s.warnings === 0 && s.security === 0));
  return s;
}

/**
 * Lint tooling files and directories (async). Options: host ('all' | 'copilot' | 'claude' |
 * 'codex'), strict (spec-only frontmatter; warnings fail), root (repository root for relative
 * paths and project context), external (run installed validators), allowHosts (HTTP hook
 * allowlist). Returns { files[{path, kind, sub, scope, reads[], host_results[{host, errors[],
 * warnings[], notes[]}]}], security[], external[], summary }.
 */
export async function lintPaths(paths = [], opts = {}) {
  const { host = 'all', strict = false, env = process.env, home = os.homedir(), allowHosts = [], external = false } = opts;
  if (!['all', ...HOSTS].includes(host)) throw usageError(`--host must be all, copilot, claude or codex (got "${host}")`);
  const list = (Array.isArray(paths) ? paths : [paths]).filter(Boolean);
  const first = list[0] ? path.resolve(list[0]) : process.cwd();
  const root = path.resolve(opts.root || repoRootSafe(statSafe(first)?.isDirectory() ? first : path.dirname(first)) || process.cwd());
  const run = new LintRun({ host, strict, root, env, home, allowHosts });
  const targets = [];
  const seen = new Set();
  for (const p of list.length ? list : [root]) {
    const abs = path.resolve(root, p);
    const st = statSafe(abs);
    if (!st) throw usageError(`path not found: ${toPosix(p)}`);
    const found = st.isDirectory() ? discover(abs, { root, env, home })
      : [{ abs, ...(classifyToolingPath(abs, { root, env, home, sniff: true }) || { kind: 'unknown', sub: null, scope: 'project', reads: [] }) }];
    for (const f of found) {
      const key = path.resolve(f.abs);
      if (!seen.has(key)) { seen.add(key); targets.push(f); }
    }
  }
  const internal = [];
  for (const t of targets) {
    const fl = new FileLint(run, t.abs, t);
    run.files.push(fl);
    const linter = LINTERS[t.kind];
    if (!linter) continue;
    try { await linter(fl); } catch (err) { internal.push({ file: fl.path, message: String(err && err.message || err) }); }
  }
  crossInstructionChecks(run);
  let ext = [];
  if (external) {
    const skills = run.files.filter((f) => f.cls.kind === 'skill').map((f) => ({ dir: path.dirname(f.abs), file: f.abs,
      name: parseFrontmatter(readTextNormalized(f.abs) || '').data?.name }));
    const plugins = [...new Set(run.files.filter((f) => (f.cls.kind === 'plugin' && f.cls.sub === 'claude') || (f.cls.kind === 'marketplace' && f.cls.sub === 'claude'))
      .map((f) => pluginRootOf(f)))];
    const instructions = run.files.filter((f) => f.cls.kind === 'instructions' && f.cls.reads.includes('copilot')).map((f) => f.abs);
    ext = runExternalValidators({ root, skills, plugins, instructions, hosts: run.selected }, opts);
    const byAbs = new Map(run.files.map((f) => [path.resolve(f.abs), f]));
    for (const e of ext) {
      for (const f of e.findings) {
        const fl = byAbs.get(path.resolve(f.abs));
        if (fl) fl.emit(f.rule, { only: [f.host], severity: f.severity, message: f.message });
      }
      e.findings = e.findings.map((f) => ({ ...f, abs: undefined, file: run.display(f.abs) }));
    }
  }
  const files = run.files.map((f) => f.toJSON());
  const out = { root: toPosix(root), files, security: run.security, external: ext, summary: summarize(run, files, ext) };
  if (internal.length) out.internal_errors = internal;
  return out;
}

/** Lint one skill directory (SKILL.md, agents/openai.yaml) against every host; async. */
export async function lintSkillDir(dir, { strict = false, host = 'all', external = false, ...rest } = {}) {
  const abs = path.resolve(dir);
  const targets = [path.join(abs, 'SKILL.md')];
  if (!fs.existsSync(targets[0])) {
    const alt = fs.existsSync(abs) ? fs.readdirSync(abs).find((n) => n.toLowerCase() === 'skill.md') : null;
    if (!alt) throw usageError(`no SKILL.md in ${toPosix(abs)}`);
    targets[0] = path.join(abs, alt);
  }
  const meta = path.join(abs, 'agents', 'openai.yaml');
  if (fs.existsSync(meta)) targets.push(meta);
  return lintPaths(targets, { strict, host, external, root: abs, ...rest });
}

/** Exit code for a lint result: 1 on errors (or, with strict, any warning or security finding). */
export function lintExit(result) {
  return result.summary.clean ? EXIT.OK : EXIT.FINDINGS;
}

function renderHuman(res) {
  const lines = [];
  for (const f of res.files) {
    const items = [];
    for (const r of f.host_results) {
      for (const [sev, list] of [['error', r.errors], ['warning', r.warnings], ['note', r.notes]]) {
        for (const x of list) items.push(`  ${sev.padEnd(7)} ${r.host.padEnd(7)} ${x.rule}${x.line ? ` (line ${x.line})` : ''}: ${x.message}`);
      }
    }
    if (items.length) lines.push(`${f.path} [${f.kind}]`, ...items);
  }
  if (res.security.length) {
    lines.push('security:');
    for (const s of res.security) lines.push(`  ${s.severity.padEnd(7)} ${s.rule} ${s.file}${s.line ? `:${s.line}` : ''}: ${s.message}`);
  }
  for (const e of res.external) lines.push(`external ${e.tool} ${e.target}: ${e.status}${e.summary ? ` - ${e.summary}` : ''}`);
  const s = res.summary;
  lines.push(`${s.files} file(s): ${s.errors} error(s), ${s.warnings} warning(s), ${s.notes} note(s), ${s.security} security finding(s); hosts ${s.hosts.join(', ')}${s.strict ? ' (strict)' : ''}`);
  return lines.join('\n');
}

export const lintCommand = defineCommand({
  name: 'tooling lint',
  usage: [
    'usage: adc.mjs tooling lint [paths...] [--host all|copilot|claude|codex] [--strict] [--no-external] [--allow-host <host>]',
    '  Lints instructions, skills, agents, prompt files, hooks, plugins and MCP configs against each host\'s rules.',
    '  No paths: the whole repository. --strict: only the six spec fields are allowed and warnings fail.',
    '  --no-external (or ADC_LINT_NO_EXTERNAL=1): skip skills-ref, claude plugin validate, gh skill, copilot, waza.',
    '  Exit: 0 clean, 1 findings, 2 usage.',
  ].join('\n'),
  options: {
    host: { type: 'string' },
    strict: { type: 'boolean' },
    'no-external': { type: 'boolean' },
    'allow-host': { type: 'string', multiple: true },
  },
  async run(ctx, values, positionals) {
    const host = values.host || 'all';
    if (!['all', 'copilot', 'claude', 'codex'].includes(host)) throw usageError(`--host must be all, copilot, claude or codex (got "${host}")`);
    const gitRoot = repoRootSafe(ctx.cwd);
    if (gitRoot) assertStateUntracked(resolveStateDir({ cwd: ctx.cwd, stateDirOption: ctx.stateDirOption }));
    const external = !values['no-external'] && !/^(?:1|true|yes)$/i.test(process.env.ADC_LINT_NO_EXTERNAL || '');
    const res = await lintPaths(positionals.map((p) => path.resolve(ctx.cwd, p)), {
      host, strict: Boolean(values.strict), root: gitRoot || ctx.cwd, external, allowHosts: values['allow-host'] || [],
    });
    const s = res.summary;
    return {
      result: res,
      exit: lintExit(res),
      human: renderHuman(res),
      summary: `${s.files} file(s), ${s.errors} error(s), ${s.warnings} warning(s), ${s.security} security finding(s) for ${s.hosts.join(', ')}${s.strict ? ' (strict)' : ''}`,
    };
  },
});
