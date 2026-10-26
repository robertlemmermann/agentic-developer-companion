// Translation between GitHub Copilot, Claude Code and OpenAI Codex tooling formats (§11.5):
// instructions, scoped rules, agents, prompt files, commands, chat modes, skills, hooks and
// MCP configs, plus the built-in migrations behind `tooling modify --migrate` (§11.6).
// Every field a target host cannot represent is reported, never dropped silently.

import fs from 'node:fs';
import path from 'node:path';
import { defineCommand, usageError, readText, stripBom, toPosix, relPosix, listFiles, EXIT } from './core.mjs';
import { repoRoot } from './git.mjs';
import { prepareStateDir, writeOutputs, backupDirFactory } from './state.mjs';
import { parseFrontmatter, stringifyFrontmatter, stringifyYaml, markdownLines } from './frontmatter.mjs';
import { parseToml } from './formats.mjs';

export const HOSTS = Object.freeze(['copilot', 'claude', 'codex']);
/** Never copied with a skill or plugin (VCS data, dependencies, eval results). */
export const COPY_IGNORE = new Set(['.git', 'node_modules', '.DS_Store', 'results']);
const HOST_NAME = { copilot: 'Copilot', claude: 'Claude Code', codex: 'Codex' };

const asText = (v) => (v == null ? null : Array.isArray(v) ? v.join(', ') : String(v));
const asList = (v) => (v == null ? [] : Array.isArray(v) ? v.map(String)
  : String(v).split(',').map((s) => s.trim()).filter(Boolean));
const asBool = (v) => (v === true || /^(true|yes|on|1)$/i.test(String(v ?? '')) ? true
  : v === false || /^(false|no|off|0)$/i.test(String(v ?? '')) ? false : null);
const uniq = (list) => [...new Set(list)];
const json = (v) => JSON.stringify(v, null, 2) + '\n';
const some = (o) => Object.keys(o || {}).length > 0;
/** A row of `dropped_fields[]`. */
const dropRow = (file, field, reason, value) => ({ file, field, ...(value !== undefined ? { value } : {}), reason });

// ---------------------------------------------------------------------------
// Names and classification

/** Agent Skills name rules: 1-64, lowercase letters, digits, single hyphens. */
export function skillNameProblems(name) {
  const n = String(name ?? '');
  return [
    (!n || n.length > 64) && 'must be 1-64 characters',
    !/^[a-z0-9-]*$/.test(n) && 'only lowercase letters, digits and hyphens',
    /^-|-$/.test(n) && 'must not start or end with a hyphen',
    n.includes('--') && 'must not contain consecutive hyphens',
    /(^|-)(claude|anthropic)(-|$)/.test(n) && 'must not contain the reserved words claude or anthropic',
  ].filter(Boolean);
}

/** Best-effort conversion of any label into a valid skill name. */
export const toSkillName = (label) => String(label ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-')
  .replace(/^-|-$/g, '').slice(0, 64).replace(/-$/, '') || 'skill';

/** Copilot agent file names allow `. - _ a-z A-Z 0-9`. */
const agentFileName = (name) => String(name).replace(/[^.\-_a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'agent';

export const SKILL_DIRS = Object.freeze({
  copilot: '.github/skills', claude: '.claude/skills', codex: '.agents/skills',
});
/**
 * Codex-only skills (agents translated to skills): Copilot also loads `.agents/skills`, where such
 * a skill would duplicate the Copilot agent. Codex reads `.codex/skills` in a repository (checked
 * with codex-cli 0.164.0, `codex debug prompt-input`, 2026-10-25); Copilot and Claude Code do not.
 */
export const CODEX_ONLY_SKILLS_DIR = '.codex/skills';

const CP = ['copilot'];
const CL = ['claude', 'copilot'];
const CX = ['codex'];
const SKILL_LOC = { '.github/skills': ['copilot', CP], '.agents/skills': ['codex', ['copilot', 'codex']],
  '.claude/skills': ['claude', CL], '.codex/skills': ['codex', CX], skills: ['portable', HOSTS] };
// [path test, kind, host, hosts that load it from there, extra fields]; the first match wins.
const LOCATIONS = [
  [/(^|\/)\.github\/copilot-instructions\.md$/, 'instructions', 'copilot', CP],
  [/(^|\/)\.github\/instructions\/.+\.instructions\.md$/, 'scoped', 'copilot', CP],
  [/(^|\/)\.claude\/rules\/.+\.md$/, 'scoped', 'claude', CL],
  [/(^|\/)\.github\/agents\/.+\.md$/, 'agent', 'copilot', CP],
  [/(^|\/)\.claude\/agents\/.+\.md$/, 'agent', 'claude', CL],
  [/(^|\/)\.codex\/agents\/.+\.toml$/, 'agent-toml', 'codex', CX],
  [/(^|\/)\.github\/prompts\/.+\.prompt\.md$/, 'prompt', 'copilot', CP],
  [/(^|\/)\.github\/chatmodes\/.+\.chatmode\.md$/, 'chatmode', 'copilot', CP],
  [/(^|\/)\.claude\/commands\/.+\.md$/, 'command', 'claude', CL],
  [/(^|\/)\.(github|copilot)\/hooks\/[^/]+\.json$/, 'hooks', 'copilot', CP],
  [/(^|\/)(\.github\/copilot\/settings(\.local)?|\.copilot\/settings)\.json$/, 'hooks', 'copilot', CP,
    { settings: true }],
  [/(^|\/)\.claude\/settings(\.local)?\.json$/, 'hooks', 'claude', CL, { settings: true }],
  [/(^|\/)\.codex\/hooks\.json$/, 'hooks', 'codex', CX],
  [/(^|\/)\.vscode\/mcp\.json$/, 'mcp', 'vscode', CP, { dialect: 'vscode' }],
  [/(^|\/)(\.github\/mcp|mcp-config)\.json$/, 'mcp', 'copilot', CP, { dialect: 'mcpServers' }],
  [/(^|\/)\.mcp\.json$/, 'mcp', 'claude', CL, { dialect: 'mcpServers' }],
  [/(^|\/)\.codex\/config\.toml$|^config\.toml$/, 'mcp', 'codex', CX, { dialect: 'toml' }],
  [/(^|\/)mcp\.json$/, 'mcp', 'portable', HOSTS, { dialect: 'agent-plugins' }],
  [/(^|\/)\.claude-plugin\/plugin\.json$/, 'plugin', 'claude', CL],
  [/(^|\/)\.codex-plugin\/plugin\.json$/, 'plugin', 'codex', CX],
  [/(^|\/)plugin\.json$/, 'plugin', 'portable', HOSTS],
  [/(^|\/)marketplace\.json$/, 'marketplace', 'portable', HOSTS],
  [/(^|\/)GEMINI\.md$/, 'instructions', 'copilot', CP],
];

/**
 * Classify a tooling file by its repository-relative path:
 * `{ kind, host, hosts[], name?, dir? }` or null. `hosts` are the hosts that load it from there.
 */
export function classifyArtifact(relPath) {
  const p = toPosix(relPath).replace(/^\.\//, '');
  const base = path.posix.basename(p);
  const dir = path.posix.dirname(p);
  const m = /^(?:(.*)\/)?((?:\.github|\.agents|\.claude|\.codex)\/skills)\/([^/]+)\/(.+)$/.exec(p)
    || /^(?:(.*)\/)?(skills)\/([^/]+)\/(.+)$/.exec(p);
  if (m && !LOCATIONS.slice(0, 9).some(([re]) => re.test(p))) {
    const [host, hosts] = SKILL_LOC[m[2]];
    const kind = m[4] === 'SKILL.md' ? 'skill' : /\.md$/i.test(m[4]) ? 'skill-file' : null;
    return kind && { kind, host, hosts: [...hosts], name: m[3], dir: [m[1], m[2], m[3]].filter(Boolean).join('/') };
  }
  const hit = LOCATIONS.find(([re]) => re.test(p));
  if (hit) return { kind: hit[1], host: hit[2], hosts: [...hit[3]], ...hit[4] };
  const top = dir === '.';
  const scoped = top ? {} : { scopeDir: dir };
  const kind = top ? 'instructions' : 'scoped';
  if (base === 'AGENTS.override.md') return { kind, host: 'codex', hosts: [...CX] };
  const everywhere = ['copilot', 'codex', 'claude'];
  if (base === 'AGENTS.md') return { kind, host: top ? 'portable' : 'codex', hosts: everywhere, ...scoped };
  if (base !== 'CLAUDE.md' && base !== 'CLAUDE.local.md') return null;
  const claudeTop = top || dir === '.claude';
  const hosts = base === 'CLAUDE.md' ? [...CL] : ['claude'];
  return { kind: claudeTop ? 'instructions' : 'scoped', host: 'claude', hosts, ...(claudeTop ? {} : scoped) };
}

// ---------------------------------------------------------------------------
// Command lines: split simple commands into argv; render argv per shell.

const VAR_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;
const VAR_SPLIT = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/;

/**
 * argv for a command line that needs no shell (no pipes, redirects, globs, chaining), or
 * null. `$VAR` and `${VAR}` placeholders are kept as `${VAR}` in the tokens.
 */
export function splitSimpleCommand(line) {
  const s = String(line ?? '').trim();
  if (!s || /[\r\n]/.test(s)) return null;
  const out = [];
  let cur = '';
  let quote = null;
  let started = false;
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (quote === "'") { if (c === "'") quote = null; else cur += c; continue; }
    if (c === '$') {
      VAR_RE.lastIndex = k;
      const m = VAR_RE.exec(s);
      if (!m || m.index !== k) return null;
      cur += `\${${m[1] || m[2]}}`;
      k += m[0].length - 1;
      started = true;
    } else if (quote === '"') {
      if (c === '`' || c === '\\') return null;
      if (c === '"') quote = null; else cur += c;
    } else if (c === "'" || c === '"') [quote, started] = [c, true];
    else if (c === ' ' || c === '\t') { if (started) out.push(cur); [cur, started] = ['', false]; }
    else if (/[|&;<>()`\\*?[\]{}~!#%^]/.test(c)) return null;
    else [cur, started] = [cur + c, true];
  }
  if (started) out.push(cur);
  return quote || !out.length || /^[A-Za-z_][A-Za-z0-9_]*=/.test(out[0]) ? null : out;
}

const SAFE_TOKEN = /^[A-Za-z0-9_\-+=.,/:@]+$/;

/** argv → POSIX sh command line (`${VAR}` placeholders stay expandable). */
export const joinPosix = (argv) => argv.map((a) => {
  const s = String(a);
  if (s && SAFE_TOKEN.test(s)) return s;
  if (!VAR_SPLIT.test(s)) return "'" + s.replace(/'/g, "'\\''") + "'";
  const parts = s.split(/(\$\{[A-Za-z_][A-Za-z0-9_]*\})/);
  return '"' + parts.map((p, i) => (i % 2 ? p : p.replace(/["\\$`]/g, '\\$&'))).join('') + '"';
}).join(' ');

/** argv → PowerShell command line (`${VAR}` → `$env:VAR`, braced when a name character follows). */
export function joinPowerShell(argv) {
  const toks = argv.map((a, k) => {
    const s = String(a);
    if (s && SAFE_TOKEN.test(s) && !s.startsWith('@') && !(k === 0 && s.startsWith('-'))) return { text: s };
    if (!VAR_SPLIT.test(s)) return { text: "'" + s.replace(/'/g, "''") + "'", quoted: true };
    const parts = s.split(VAR_SPLIT);
    const text = parts.map((p, i) => (!(i % 2) ? p.replace(/[`"$]/g, '`$&')
      : /^[\w:]/.test(parts[i + 1] || '') ? `\${env:${p}}` : `$env:${p}`)).join('');
    return { text: `"${text}"`, quoted: true };
  });
  return (toks[0].quoted ? '& ' : '') + toks.map((t) => t.text).join(' ');
}

/** argv → cmd.exe command line (`${VAR}` → `%VAR%`). */
export const joinCmd = (argv) => argv.map((a) => {
  const s = String(a).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, '%$1%');
  return s && /^[A-Za-z0-9_\-+=.,/:@%\\]+$/.test(s) ? s : '"' + s.replace(/"/g, '""') + '"';
}).join(' ');

// ---------------------------------------------------------------------------
// Tool names (agents) and hook events / matchers

const COPILOT_ALIAS_TO_CANON = {
  execute: ['Bash'], shell: ['Bash'], bash: ['Bash'], powershell: ['Bash'], read: ['Read'], edit: ['Edit', 'Write'],
  write: ['Write'], search: ['Grep', 'Glob'], agent: ['Agent'], 'custom-agent': ['Agent'], task: ['Agent'],
  web: ['WebFetch', 'WebSearch'], todo: ['TodoWrite'],
};
const CLAUDE_TOOLS = ['Bash', 'Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'NotebookRead', 'Grep', 'Glob',
  'Agent', 'Task', 'WebFetch', 'WebSearch', 'TodoWrite', 'Skill', 'AskUserQuestion', 'BashOutput', 'KillShell',
  'Monitor', 'PowerShell'];
const CANON_TO_COPILOT_ALIAS = {
  Bash: 'execute', PowerShell: 'execute', Read: 'read', NotebookRead: 'read', Edit: 'edit', Write: 'edit',
  MultiEdit: 'edit', NotebookEdit: 'edit', Grep: 'search', Glob: 'search', Agent: 'agent', Task: 'agent',
  WebFetch: 'web', WebSearch: 'web', TodoWrite: 'todo',
};

/** Copilot agent `tools` → Claude tool names. `null` = all tools. */
export function toolsCopilotToCanonical(list) {
  const out = [];
  const unknown = [];
  for (const t of list.map((x) => String(x).trim()).filter(Boolean)) {
    if (t === '*') return { tools: null, unknown };
    if (COPILOT_ALIAS_TO_CANON[t.toLowerCase()]) out.push(...COPILOT_ALIAS_TO_CANON[t.toLowerCase()]);
    else if (CLAUDE_TOOLS.includes(t)) out.push(t === 'Task' ? 'Agent' : t);
    else if (/^[^/\s]+\/\*$/.test(t)) out.push(`mcp__${t.slice(0, -2)}__*`);
    else if (/^[^/\s]+\/[^/\s]+$/.test(t)) out.push(`mcp__${t.replace('/', '__')}`);
    else { out.push(t); unknown.push(t); }
  }
  return { tools: uniq(out), unknown };
}

/** Claude tool names → Copilot aliases; names without a Copilot alias are reported. */
export function toolsCanonicalToCopilot(list) {
  const alias = (t) => CANON_TO_COPILOT_ALIAS[t] || /^mcp__(.+?)__(.+)$/.exec(t)?.slice(1).join('/');
  return { tools: uniq(list.map(alias).filter(Boolean)), unmapped: list.filter((t) => !alias(t)) };
}

const COPILOT_EVENT_TO_PASCAL = {
  sessionStart: 'SessionStart', sessionEnd: 'SessionEnd', userPromptSubmitted: 'UserPromptSubmit',
  preToolUse: 'PreToolUse', postToolUse: 'PostToolUse', postToolUseFailure: 'PostToolUseFailure', agentStop: 'Stop',
  subagentStart: 'SubagentStart', subagentStop: 'SubagentStop', preCompact: 'PreCompact',
  permissionRequest: 'PermissionRequest', notification: 'Notification',
};
const PASCAL_TO_COPILOT_EVENT = Object.fromEntries(Object.entries(COPILOT_EVENT_TO_PASCAL).map(([a, b]) => [b, a]));
const COPILOT_ONLY_EVENTS = ['errorOccurred', 'userPromptTransformed'];
const EVENTS = {
  claude: ['SessionStart', 'Setup', 'SessionEnd', 'UserPromptSubmit', 'UserPromptExpansion', 'Stop', 'StopFailure',
    'PreToolUse', 'PermissionRequest', 'PermissionDenied', 'PostToolUse', 'PostToolUseFailure', 'PostToolBatch',
    'SubagentStart', 'SubagentStop', 'TaskCreated', 'TaskCompleted', 'TeammateIdle', 'PreCompact', 'PostCompact',
    'PreModelSwitch', 'PostModelSwitch', 'Elicitation', 'ElicitationResult', 'Notification', 'MessageDisplay',
    'InstructionsLoaded', 'ConfigChange', 'CwdChanged', 'DirectoryAdded', 'FileChanged', 'WorktreeCreate',
    'WorktreeRemove'],
  codex: ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'Stop',
    'SubagentStart', 'SubagentStop', 'PreCompact', 'PostCompact', 'PreModelRequest', 'PostModelRequest', 'Interrupt'],
};
// Events that take a matcher: in Claude Code all but these, in Codex only these.
const CLAUDE_NO_MATCHER = ['UserPromptSubmit', 'PostToolBatch', 'Stop', 'TeammateIdle', 'TaskCreated', 'TaskCompleted',
  'CwdChanged', 'WorktreeCreate', 'WorktreeRemove', 'MessageDisplay'];
const CODEX_MATCHER_EVENTS = ['PreToolUse', 'PermissionRequest', 'PostToolUse', 'PreCompact', 'PostCompact',
  'SessionStart', 'SessionEnd', 'SubagentStart', 'SubagentStop'];
const TOOL_EVENTS = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied'];
// Handler fields each host supports beyond command and timeout (kept when porting between them).
const HOOK_EXTRAS = { copilot: [], claude: ['async', 'asyncRewake', 'onFailure', 'if', 'statusMessage', 'once'],
  codex: ['async', 'statusMessage', 'additionalContextLimit'] };

const CANON_IDENTITY = Object.fromEntries(CLAUDE_TOOLS.map((t) => [t, t]));
const COPILOT_TOOL_TO_CANON = { ...CANON_IDENTITY, bash: 'Bash', powershell: 'Bash', view: 'Read', create: 'Write',
  edit: 'Edit', str_replace: 'Edit', str_replace_editor: 'Edit', grep: 'Grep', glob: 'Glob', task: 'Agent' };
const CODEX_TOOL_TO_CANON = { ...CANON_IDENTITY, apply_patch: 'Edit', spawn_agent: 'Agent' };
const CANON_TO_COPILOT_TOOL = { Bash: 'bash', Read: 'view', Write: 'create', Edit: 'edit', MultiEdit: 'edit',
  Grep: 'grep', Glob: 'glob', Agent: 'task', Task: 'task' };
const CANON_TO_CODEX_TOOL = { Bash: 'Bash', Write: 'Write', Edit: 'Edit', MultiEdit: 'Edit', Agent: 'Agent',
  Task: 'Agent' };

/** Translate a matcher that is a plain name list; regex matchers are returned unchanged with `regex: true`. */
function translateMatcher(matcher, table, { keepUnknown = true } = {}) {
  const m = matcher == null ? '' : String(matcher);
  if (m === '' || m === '*') return { matcher: matcher ?? null, unknown: [], regex: false };
  if (!/^[A-Za-z0-9_|, -]+$/.test(m)) return { matcher: m, unknown: [], regex: true };
  const names = m.split(/[|,]/).map((s) => s.trim()).filter(Boolean);
  const out = names.filter((n) => table[n] || keepUnknown).map((n) => table[n] || n);
  return { matcher: uniq(out).join('|') || null, unknown: names.filter((n) => !table[n]), regex: false };
}

// ---------------------------------------------------------------------------
// Hooks: one intermediate form (IR), parsed from and rendered to each host's file.

function parseJsonText(text, file) {
  try { return JSON.parse(stripBom(String(text))); } catch (err) {
    throw usageError(`${file}: not valid JSON (${err.message})`);
  }
}

/** One handler as IR: `exec {program, args}` or shell strings (`posix`, `windows` + `windowsShell`). */
function hookEntry(h, host, event, matcher, file, notes) {
  const e = { event, matcher, exec: null, posix: null, windows: null, windowsShell: null, timeout: h.timeout ?? null,
    cwd: null, env: null, extra: {}, source: host };
  const argv = (prog, args) => ({ program: String(prog ?? ''), args: Array.isArray(args) ? args.map(String) : [] });
  if (host === 'copilot') {
    const shared = h.command && !h.exec ? h.command : null;
    if (h.exec) e.exec = argv(h.exec, h.args);
    Object.assign(e, { posix: h.bash ?? shared, windows: h.powershell ?? shared, timeout: h.timeoutSec ?? e.timeout,
      cwd: h.cwd ?? null, env: h.env && typeof h.env === 'object' ? h.env : null });
    if (!e.exec && !e.posix && h.command && Array.isArray(h.args)) e.exec = argv(h.command, h.args);
    if (e.windows) e.windowsShell = 'powershell';
    if (h.command && (h.bash || h.powershell)) notes.push(`${file}: "command" next to bash/powershell is ignored`);
  } else if (host === 'claude') {
    if (Array.isArray(h.args)) e.exec = argv(h.command, h.args);
    else if (h.shell === 'powershell') Object.assign(e, { windows: h.command ?? null, windowsShell: 'powershell' });
    else e.posix = h.command ?? null;
  } else {
    Object.assign(e, { posix: h.command ?? null, windows: h.commandWindows ?? h.command_windows ?? null });
    if (e.windows) e.windowsShell = 'cmd';
  }
  for (const k of HOOK_EXTRAS[host]) if (k in h) e.extra[k] = h[k];
  // A plain program call in every shell becomes `exec`, which renders natively everywhere.
  const p = !e.exec && e.posix ? splitSimpleCommand(e.posix) : null;
  const w = e.windows ? splitSimpleCommand(e.windows) : null;
  if (p && (!e.windows || w?.join('\0') === p.join('\0'))) {
    Object.assign(e, { exec: { program: p[0], args: p.slice(1) }, posix: null, windows: null, windowsShell: null });
  }
  return e;
}

/**
 * Parse a hooks file into `{ entries[], dropped[], notes[] }`. Entries carry a canonical
 * PascalCase event (or a Copilot-only camel event) and a matcher in Claude tool names.
 */
export function parseHookConfig(text, host, file = 'hooks.json') {
  const dropped = [];
  const notes = [];
  const entries = [];
  const drop = (field, reason, value) => dropped.push(dropRow(file, field, reason, value));
  const hooks = parseJsonText(text, file)?.hooks;
  if (!hooks || typeof hooks !== 'object') return { entries, dropped, notes: [`${file} has no "hooks" object`] };
  for (const [evKey, list] of Object.entries(hooks)) {
    const camel = host === 'copilot' && (evKey in COPILOT_EVENT_TO_PASCAL || COPILOT_ONLY_EVENTS.includes(evKey));
    const event = camel ? COPILOT_EVENT_TO_PASCAL[evKey] || evKey
      : EVENTS.claude.includes(evKey) || EVENTS.codex.includes(evKey) ? evKey : null;
    if (!event || !Array.isArray(list)) {
      drop(`hooks.${evKey}`, event ? 'event value is not an array' : `unknown ${host} hook event`);
      continue;
    }
    const table = camel ? COPILOT_TOOL_TO_CANON : host === 'codex' ? CODEX_TOOL_TO_CANON : CANON_IDENTITY;
    for (const item of list.filter((x) => x && typeof x === 'object')) {
      for (const h of (Array.isArray(item.hooks) ? item.hooks : [item]).filter((x) => x && typeof x === 'object')) {
        const type = h.type || 'command';
        if (type !== 'command') {
          drop(`hooks.${evKey}[].type`, `"${type}" handlers are not ported (only command hooks)`, type);
          continue;
        }
        for (const k of host === 'copilot' ? ['windows', 'linux', 'osx', 'hookSpecificOutput'] : []) {
          if (k in h) drop(`hooks.${evKey}[].${k}`, 'VS Code Local-harness key; Copilot CLI and cloud agent ignore it');
        }
        const tm = translateMatcher(h.matcher ?? item.matcher ?? null, table);
        const e = hookEntry(h, host, event, tm.matcher, file, notes);
        if (!e.exec && !e.posix && !e.windows) { drop(`hooks.${evKey}[]`, 'entry has no command'); continue; }
        if (tm.regex) e.matcherRegex = true;
        entries.push(e);
      }
    }
  }
  return { entries, dropped, notes };
}

const SCRIPT_EXT = /\.(mjs|cjs|js|ts|py|sh|ps1|rb|pl)$/i;
const relativeArg = (a) => !/^[-$/~\\]|^[A-Za-z]:|^[a-z]+:\/\//i.test(a) && (a.includes('/') || SCRIPT_EXT.test(a));

/** Copilot preToolUse fails closed when the command crashes: print {} when the runtime is missing (§7.7). */
function copilotGuard(prog, bash, ps) {
  if (!/^[A-Za-z0-9_.-]+$/.test(prog || '')) return { bash, ps };
  const call = ps.startsWith('& ') ? ps : `& ${ps}`;
  return { bash: `command -v ${prog} >/dev/null 2>&1 && ${bash} || echo {}`,
    ps: `if (Get-Command ${prog} -ErrorAction SilentlyContinue) { $o = ${call} 2>$null; `
      + 'if ($LASTEXITCODE -eq 0 -and $o) { $o } else { \'{}\' } } else { \'{}\' }; exit 0' };
}

/** The Copilot entry (`bash` + `powershell`, `timeoutSec`) for one IR entry. */
function copilotHook(e, ev, argv, { guard, pluginRoot }, manual, notes) {
  const out = { type: 'command' };
  if (argv) {
    const g = { bash: joinPosix(argv), ps: joinPowerShell(argv) };
    const { bash, ps } = guard && ev === 'preToolUse' ? copilotGuard(argv[0], g.bash, g.ps) : g;
    Object.assign(out, { bash, powershell: ps });
  } else {
    if (e.posix) out.bash = e.posix;
    if (e.windows) out.powershell = e.windowsShell === 'cmd' ? `cmd /c ${e.windows}` : e.windows;
    if (e.windowsShell === 'cmd') manual.add(`Check the PowerShell command of the ${ev} hook (it wraps "cmd /c").`);
    if (!out.bash) manual.add(`Write a bash command for the ${ev} hook; the cloud agent runs only bash/command.`);
    if (!out.powershell) manual.add(`Write a PowerShell command for the ${ev} hook; Copilot on Windows runs it.`);
  }
  if (e.cwd || (pluginRoot && ev === 'preToolUse')) out.cwd = e.cwd || '${PLUGIN_ROOT}';
  if (e.env) out.env = e.env;
  out.timeoutSec = e.timeout ?? 30;
  if (Number(out.timeoutSec) > 30) notes.add(`The ${ev} hook keeps its ${out.timeoutSec} s timeout (Copilot: <= 30).`);
  if (e.matcher && TOOL_EVENTS.includes(e.event)) {
    const tm = e.matcherRegex ? { matcher: e.matcher, unknown: [] }
      : translateMatcher(e.matcher, CANON_TO_COPILOT_TOOL);
    out.matcher = tm.matcher;
    if (tm.unknown.length) manual.add(`Matcher names with no Copilot equivalent were kept: ${tm.unknown.join(', ')}.`);
  }
  return out;
}

/** The Claude Code or Codex handler for one IR entry. */
function pascalHook(e, argv, target, pluginRoot, drop, manual) {
  const h = { type: 'command' };
  const win = e.windowsShell === 'cmd' ? 'cmd.exe' : 'PowerShell';
  if (target === 'claude' && argv && pluginRoot) [h.command, ...h.args] = argv; // exec form with ${CLAUDE_PLUGIN_ROOT}
  else if (target === 'claude' && argv) {
    // Repository settings: Copilot CLI and VS Code run these hooks too (in bash and PowerShell; exec
    // form undocumented), so one shell string; ${CLAUDE_PROJECT_DIR} would not expand there.
    h.command = joinPosix(argv);
    if (argv.slice(1).some(relativeArg)) {
      manual.add('Hook script paths in .claude/settings.json are repository-relative (Copilot runs them too): '
        + 'start the hosts at the repository root.');
    }
  } else if (target === 'claude') {
    h.command = e.posix || e.windows;
    if (e.posix && e.windows && e.windows !== e.posix) {
      drop('powershell/commandWindows', 'Claude Code runs one command per hook (Git Bash on Windows, else PowerShell)',
        e.windows);
    }
    if (!e.posix) {
      h.shell = 'powershell';
      manual.add(`The ${e.event} hook only had a ${win} command; it now runs with shell: powershell.`);
    }
  } else if (argv) Object.assign(h, { command: joinPosix(argv), commandWindows: joinCmd(argv) });
  else {
    const simple = e.windows && e.windowsShell !== 'cmd' ? splitSimpleCommand(e.windows) : null;
    if (e.posix) h.command = e.posix;
    if (e.windowsShell === 'cmd' || simple) h.commandWindows = simple ? joinCmd(simple) : e.windows;
    else if (e.windows) {
      h.commandWindows = `pwsh -NoProfile -Command ${JSON.stringify(e.windows)}`;
      manual.add(`Check the Windows command of the ${e.event} hook: it runs in cmd.exe, wrapped in pwsh -Command.`);
    }
    if (!h.command) {
      h.command = h.commandWindows;
      manual.add(`Write a POSIX command for the ${e.event} hook (it had only a ${win} one).`);
    }
    if (!h.commandWindows) manual.add(`Add commandWindows to the ${e.event} hook if Windows users run Codex.`);
  }
  if (e.timeout != null) h.timeout = Number(e.timeout);
  for (const [k, v] of Object.entries(e.extra)) if (HOOK_EXTRAS[target].includes(k)) h[k] = v;
  if (e.cwd) drop('cwd', `${HOST_NAME[target]} hooks have no cwd`, e.cwd);
  if (e.env) drop('env', `${HOST_NAME[target]} hooks have no env`, Object.keys(e.env).join(','));
  return h;
}

/** The matcher a Claude Code or Codex event takes, `undefined` to skip the entry. */
function pascalMatcher(e, target, drop, notes) {
  const takes = target === 'claude' ? !CLAUDE_NO_MATCHER.includes(e.event) : CODEX_MATCHER_EVENTS.includes(e.event);
  if (e.matcher && !takes) notes.add(`${e.event} ignores matchers in ${target}; the matcher was omitted.`);
  if (!e.matcher || !takes) return null;
  if (target !== 'codex' || !TOOL_EVENTS.includes(e.event) || e.matcherRegex) return e.matcher;
  const tm = translateMatcher(e.matcher, CANON_TO_CODEX_TOOL, { keepUnknown: false });
  const only = 'Codex hooks see Bash, apply_patch (Edit/Write) and Agent only';
  if (tm.unknown.length) drop('matcher', only, tm.unknown.join('|'));
  if (!tm.matcher) drop(`hooks.${e.event}`, 'no matcher tool name exists in Codex; entry skipped');
  return tm.matcher || undefined;
}

/**
 * Render IR entries for a host. Returns `{ doc, dropped[], manual[], notes[] }`; `doc` is the JSON
 * of `.github/hooks/*.json` (copilot), the `{hooks}` block of `.claude/settings.json` (claude) or
 * `.codex/hooks.json` (codex). `guard` adds the missing-runtime guard to Copilot preToolUse entries;
 * `pluginRoot` renders plugin hook files (script paths through the plugin-root variable).
 */
export function renderHookConfig(entries, target, { file = 'hooks', guard = false, pluginRoot = false } = {}) {
  const dropped = [];
  const manual = new Set();
  const notes = new Set();
  const hooks = {};
  const drop = (field, reason, value) => dropped.push(dropRow(file, field, reason, value));
  const PROJECT = /^\$\{CLAUDE_PROJECT_DIR\}\//;
  const rootVar = (a) => (!pluginRoot ? a
    : target !== 'claude' ? a.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, '${PLUGIN_ROOT}')
      : a.replace(PROJECT, '${CLAUDE_PLUGIN_ROOT}/').replace(/\$\{PLUGIN_ROOT\}/g, '${CLAUDE_PLUGIN_ROOT}'));
  const rebase = (a) => {
    if ((pluginRoot && target === 'claude') || !PROJECT.test(a)) return a;
    notes.add('Paths under ${CLAUDE_PROJECT_DIR} became repository-relative; run the hook from the repository root.');
    return a.replace(PROJECT, '');
  };
  for (const e of entries) {
    const argv = e.exec ? [e.exec.program, ...e.exec.args.map(rebase)].map(rootVar) : null;
    const event = target !== 'copilot' ? EVENTS[target].includes(e.event) && e.event
      : PASCAL_TO_COPILOT_EVENT[e.event] || (COPILOT_ONLY_EVENTS.includes(e.event) && e.event);
    if (!event) { drop(`hooks.${e.event}`, `${HOST_NAME[target]} has no ${e.event} event`); continue; }
    for (const [k, v] of Object.entries(e.extra)) {
      if (!HOOK_EXTRAS[target].includes(k)) drop(k, `${HOST_NAME[target]} hooks have no "${k}"`, v);
    }
    if (target === 'copilot') {
      (hooks[event] ||= []).push(copilotHook(e, event, argv, { guard, pluginRoot }, manual, notes));
      continue;
    }
    const matcher = pascalMatcher(e, target, drop, notes);
    if (matcher === undefined) continue;
    const groups = (hooks[event] ||= []);
    let g = groups.find((x) => (x.matcher ?? null) === matcher);
    if (!g) groups.push((g = matcher ? { matcher, hooks: [] } : { hooks: [] }));
    g.hooks.push(pascalHook(e, argv, target, pluginRoot, drop, manual));
  }
  if (entries.some((e) => e.source !== target)) {
    manual.add(target === 'copilot'
      ? "Hook handlers must print Copilot's output shape: top-level additionalContext / permissionDecision / decision."
      : `Hook handlers must print ${HOST_NAME[target]}'s output shape (hookSpecificOutput / decision)`
        + (target === 'codex' ? '; Codex rejects unknown output fields.' : ", not Copilot's top-level fields."));
  }
  const doc = target === 'copilot' ? { version: 1, hooks } : { hooks };
  return { doc, dropped, manual: [...manual], notes: [...notes] };
}

function jsonObject(text) {
  const cur = text.trim() ? JSON.parse(stripBom(text)) : {};
  if (!cur || typeof cur !== 'object' || Array.isArray(cur)) throw new Error('existing file is not a JSON object');
  return cur;
}

/** Merge rendered hooks into an existing hooks or settings file (other keys and entries kept). */
export function mergeHooks(existingText, doc) {
  const cur = jsonObject(existingText);
  if (doc.version != null) cur.version ??= doc.version;
  cur.hooks = cur.hooks && typeof cur.hooks === 'object' ? cur.hooks : {};
  for (const [ev, list] of Object.entries(doc.hooks)) {
    const have = (cur.hooks[ev] ||= []);
    const seen = new Set(have.map((x) => JSON.stringify(x)));
    have.push(...list.filter((item) => !seen.has(JSON.stringify(item))));
  }
  return json(cur);
}

// ---------------------------------------------------------------------------
// MCP servers: `mcpServers` JSON (Claude, Copilot), VS Code `servers`, Agent Plugins mcp.json, Codex TOML.

const tomlKey = (k) => (/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k));
const tomlPairs = (v) => Object.entries(v).map(([k, x]) => `${tomlKey(k)} = ${tomlValue(x)}`).join(', ');
const tomlValue = (v) => (Array.isArray(v) ? `[${v.map(tomlValue).join(', ')}]`
  : v && typeof v === 'object' ? `{ ${tomlPairs(v)} }`
    : typeof v === 'boolean' || typeof v === 'number' ? String(v) : JSON.stringify(String(v)));

const ENV_REF = /^\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}$/;
const INPUT_RE = /\$\{input:([A-Za-z0-9_.-]+)(?::[^}]*)?\}/g;
const LOOPBACK = /^http:\/\/(localhost|127\.|\[::1\])/i;
const MCP_KEYS = ['type', 'command', 'args', 'env', 'cwd', 'url', 'headers', 'tools'];
const CODEX_MCP_KEYS = ['command', 'args', 'env', 'env_vars', 'cwd', 'url', 'http_headers', 'env_http_headers',
  'bearer_token_env_var', 'enabled_tools', 'enabled'];
const inputEnvName = (id) => id.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'INPUT';
const isAllTools = (tools) => !tools || (tools.length === 1 && tools[0] === '*');

function parseCodexServer(name, s) {
  const env = { ...s.env };
  for (const v of s.env_vars || []) { const n = typeof v === 'string' ? v : v?.name; if (n) env[n] = `\${${n}}`; }
  const headers = { ...s.http_headers };
  for (const [h, envName] of Object.entries(s.env_http_headers || {})) headers[h] = `\${${envName}}`;
  if (s.bearer_token_env_var) headers.Authorization = `Bearer \${${s.bearer_token_env_var}}`;
  return { name, transport: s.url ? 'http' : 'stdio', command: s.command ?? null, args: (s.args || []).map(String), env,
    cwd: s.cwd ?? null, url: s.url ?? null, headers, tools: Array.isArray(s.enabled_tools) ? s.enabled_tools : null,
    enabled: s.enabled ?? null };
}

/**
 * Parse an MCP config into `{ servers[{name, transport, command, args, env, cwd, url, headers, tools}], dropped[],
 * manual[] }`. `dialect`: 'mcpServers' (.mcp.json, .github/mcp.json), 'vscode' (`servers`, `${input:}`),
 * 'agent-plugins' or 'toml' (Codex config.toml).
 */
export function parseMcpConfig(text, dialect, file = 'mcp config') {
  const dropped = [];
  const manual = [];
  const servers = [];
  if (dialect === 'toml') {
    for (const [name, s] of Object.entries(parseToml(String(text ?? ''), { lenient: true }).value?.mcp_servers || {})) {
      if (!s || typeof s !== 'object') continue;
      for (const k of Object.keys(s).filter((x) => !CODEX_MCP_KEYS.includes(x))) {
        dropped.push(dropRow(file, `mcp_servers.${name}.${k}`, 'Codex-only MCP setting'));
      }
      servers.push(parseCodexServer(name, s));
    }
    return { servers, dropped, manual };
  }
  const doc = parseJsonText(text, file);
  const inputs = new Map((Array.isArray(doc?.inputs) ? doc.inputs : []).map((x) => [String(x.id), x]));
  const bare = doc && !doc.servers && !doc.$schema ? doc : {};
  const map = (dialect === 'vscode' ? doc?.servers : doc?.mcpServers || bare) || {};
  // VS Code ${input:id} prompts become ${ID} environment references (password inputs are never written).
  const fix = (s) => String(s).replace(INPUT_RE, (_, id) => {
    const secret = inputs.get(id)?.password ? '; password inputs are never written to files' : '';
    manual.push(`Set the environment variable ${inputEnvName(id)} before starting the host (it replaces the VS Code `
      + `input "${id}"${secret}).`);
    return `\${${inputEnvName(id)}}`;
  });
  const fixMap = (o) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k, fix(v)]));
  for (const [name, s] of Object.entries(map)) {
    if (!s || typeof s !== 'object') continue;
    const t = String(s.type || (s.url ? 'http' : 'stdio')).toLowerCase();
    const transport = t === 'sse' ? 'sse' : /^(http|streamable-?http)$/.test(t) ? 'http' : 'stdio';
    servers.push({ name, transport, command: s.command ?? null, args: (s.args || []).map(fix), env: fixMap(s.env),
      cwd: s.cwd ?? null, url: s.url ? fix(s.url) : null, headers: fixMap(s.headers),
      tools: Array.isArray(s.tools) ? s.tools : null });
    for (const k of Object.keys(s).filter((x) => !MCP_KEYS.includes(x))) {
      const why = k === 'envFile' ? 'VS Code-only; load the env file yourself' : 'host-specific MCP field';
      dropped.push(dropRow(file, `${dialect === 'vscode' ? 'servers' : 'mcpServers'}.${name}.${k}`, why,
        typeof s[k] === 'string' ? s[k] : undefined));
    }
  }
  const used = new Set([...JSON.stringify(map).matchAll(INPUT_RE)].map((m) => m[1]));
  for (const id of inputs.keys()) if (!used.has(id)) dropped.push(dropRow(file, `inputs.${id}`, 'unused input'));
  return { servers, dropped, manual };
}

function codexServerToml(s, file, dropped, manual) {
  const lines = [`[mcp_servers.${tomlKey(s.name)}]`];
  const kv = (k, v) => lines.push(`${k} = ${tomlValue(v)}`);
  const literal = {};
  const fromEnv = {};
  if (s.transport === 'sse') {
    dropped.push(dropRow(file, `${s.name}.type`, 'Codex speaks stdio and streamable HTTP; check the endpoint', 'sse'));
  }
  if (s.transport === 'stdio') {
    kv('command', s.command || '');
    if (s.args.length) kv('args', s.args);
    for (const [k, v] of Object.entries(s.env || {})) {
      if (ENV_REF.exec(v)?.[1] === k) fromEnv[k] = k;
      else if (/\$\{/.test(v)) manual.push(`Codex does not expand "${v}" in env: set ${k} for ${s.name} yourself.`);
      else literal[k] = v;
    }
    if (some(literal)) kv('env', literal);
    if (some(fromEnv)) kv('env_vars', Object.keys(fromEnv));
    if (s.cwd) kv('cwd', s.cwd);
  } else {
    kv('url', s.url || '');
    for (const [h, v] of Object.entries(s.headers || {})) {
      const bearer = /^Bearer \$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(v);
      if (/^authorization$/i.test(h) && bearer) kv('bearer_token_env_var', bearer[1]);
      else if (ENV_REF.test(v)) fromEnv[h] = ENV_REF.exec(v)[1];
      else if (/\$\{/.test(v)) manual.push(`Header ${h} of ${s.name} mixes text and a variable (Codex: whole values).`);
      else literal[h] = v;
    }
    if (some(literal)) kv('http_headers', literal);
    if (some(fromEnv)) kv('env_http_headers', fromEnv);
  }
  if (!isAllTools(s.tools)) kv('enabled_tools', s.tools);
  if (s.enabled === false) kv('enabled', false);
  return { name: s.name, text: lines.join('\n') + '\n' };
}

/** One server in the Agent Plugins mcp.json shape (only ${PLUGIN_ROOT} and ${PLUGIN_DATA} expand there). */
function agentPluginsServer(s, file, dropped) {
  const e = { type: s.transport === 'http' ? 'streamable-http' : s.transport };
  const drop = (field, reason, value) => dropped.push(dropRow(file, `${s.name}.${field}`, reason, value));
  const keep = (map, test, field, reason) => {
    const out = {};
    for (const [k, v] of Object.entries(map || {})) {
      if (test(v)) out[k] = v;
      else drop(`${field}.${k}`, reason, field === 'env' ? v : undefined);
    }
    return out;
  };
  if (s.transport === 'stdio') {
    const parts = /\s/.test(s.command || '') ? splitSimpleCommand(s.command) : null;
    e.command = parts ? parts[0] : s.command || '';
    const args = [...(parts ? parts.slice(1) : []), ...s.args];
    if (args.length) e.args = args;
    const env = keep(s.env, (v) => !/\$\{(?!PLUGIN_ROOT\}|PLUGIN_DATA\})/.test(v), 'env',
      'Agent Plugins expands only ${PLUGIN_ROOT} and ${PLUGIN_DATA}; users must set this variable themselves');
    if (some(env)) e.env = env;
    if (/^(\.\/|\$\{PLUGIN_ROOT\}|\$\{PLUGIN_DATA\})/.test(s.cwd || '')) e.cwd = s.cwd;
    else if (s.cwd) drop('cwd', 'Agent Plugins cwd must start with ./, ${PLUGIN_ROOT} or ${PLUGIN_DATA}', s.cwd);
  } else {
    e.url = s.url;
    const headers = keep(s.headers, (v) => !/\$\{/.test(v), 'headers',
      'Agent Plugins never expands variables in headers and forbids secrets there; the host must handle authorization');
    if (some(headers)) e.headers = headers;
  }
  if (s.tools) drop('tools', 'Agent Plugins mcp.json has no tools allow-list');
  return e;
}

/**
 * Render servers for a target: 'claude' (.mcp.json), 'copilot' (.github/mcp.json), 'codex' (config.toml text)
 * or 'agent-plugins' (plugin mcp.json). Returns `{ doc | text, blocks?, dropped[], manual[] }`.
 */
export function renderMcpConfig(servers, target, { file = 'mcp' } = {}) {
  const dropped = [];
  const manual = [];
  if (target === 'codex') {
    const blocks = servers.map((s) => codexServerToml(s, file, dropped, manual));
    return { text: blocks.map((b) => b.text).join('\n'), blocks, dropped, manual };
  }
  const out = {};
  for (const s of servers) {
    if (target === 'agent-plugins') { out[s.name] = agentPluginsServer(s, file, dropped); continue; }
    const e = { type: target === 'copilot' && s.transport === 'stdio' ? 'local' : s.transport };
    if (s.transport !== 'stdio') Object.assign(e, { url: s.url }, some(s.headers) ? { headers: s.headers } : {});
    else {
      Object.assign(e, { command: s.command || '' }, s.args.length ? { args: s.args } : {});
      if (some(s.env)) e.env = s.env;
    }
    if (s.cwd) dropped.push(dropRow(file, `${s.name}.cwd`, `${HOST_NAME[target]} servers have no cwd`, s.cwd));
    if (target === 'copilot') e.tools = s.tools?.length ? s.tools : ['*'];
    else if (!isAllTools(s.tools)) {
      const why = 'Claude Code .mcp.json has no tools allow-list; use permissions instead';
      dropped.push(dropRow(file, `${s.name}.tools`, why, s.tools.join(',')));
    }
    if (/^http:\/\//i.test(e.url || '') && !LOOPBACK.test(e.url)) manual.push(`${s.name}: use https (remote URL).`);
    out[s.name] = e;
  }
  const doc = target === 'agent-plugins' ? { $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json' } : {};
  return { doc: { ...doc, mcpServers: out }, dropped, manual };
}

/**
 * The manual step with the JSON to paste into the Copilot cloud agent's MCP settings. Every env value
 * and variable becomes a `${COPILOT_MCP_*}` Agents-secret reference, so no literal value of the source
 * (a token in `env`, for example) is ever printed.
 */
export function cloudAgentMcp(servers) {
  const secret = (n) => `\${${n.startsWith('COPILOT_MCP_') ? n : `COPILOT_MCP_${n}`}}`;
  const refs = (v) => String(v).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/g, (_, n) => secret(n));
  const header = (h, v) => (/\$\{/.test(v) || !/auth|token|key|secret|cookie/i.test(h) ? refs(v)
    : secret(h.toUpperCase().replace(/[^A-Z0-9]+/g, '_')));
  const map = (o, fn) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k, fn(k, v)]));
  const cloud = servers.map((s) => ({ ...s, env: map(s.env, (k, v) => secret(ENV_REF.exec(v)?.[1] || k.toUpperCase())),
    headers: map(s.headers, header) }));
  const names = uniq(JSON.stringify(cloud.map((s) => [s.env, s.headers])).match(/COPILOT_MCP_[A-Z0-9_]+/g) || []);
  const secrets = names.length ? ` and add the Agents secrets ${names.join(', ')}.` : '';
  return 'Copilot cloud agent reads MCP servers only from repository Settings > Copilot > MCP servers; paste: '
    + JSON.stringify(renderMcpConfig(cloud, 'copilot').doc) + secrets;
}

/** Add the rendered servers to an existing `mcpServers` file (servers already present are kept). */
export function mergeMcp(existingText, doc) {
  const cur = jsonObject(existingText);
  cur.mcpServers = cur.mcpServers && typeof cur.mcpServers === 'object' ? cur.mcpServers : {};
  for (const [name, s] of Object.entries(doc.mcpServers)) cur.mcpServers[name] ??= s;
  return json(cur);
}

/** Append `[mcp_servers.<name>]` blocks to a config.toml unless the server is already configured. */
export function mergeToml(existingText, blocks) {
  const have = parseToml(existingText, { lenient: true }).value?.mcp_servers || {};
  let text = existingText;
  for (const b of blocks.filter((x) => !(x.name in have))) {
    text += (text && !text.endsWith('\n') ? '\n' : '') + (text.trim() ? '\n' : '') + b.text;
  }
  return text;
}

// ---------------------------------------------------------------------------
// Markdown artifacts: instructions, scoped rules, agents, prompts, commands, chat modes, skills

const MARKER = 'generated by agentic-developer-companion port from';
const markerLine = (src) => `<!-- ${MARKER} ${src}; edit the source and re-run tooling port -->`;
const stripMarker = (text) => String(text).replace(new RegExp(`^<!-- ${MARKER} [^\\n]*-->\\r?\\n`), '');
const IMPORT_RE = /(^|[\s(])@((?:\.{1,2}\/|[A-Za-z0-9_])[A-Za-z0-9_./-]*\.[A-Za-z0-9]+)(?=[\s),.;:]|$)/g;
const trimBody = (s) => String(s).replace(/^\n+/, '');

/** `@path` imports (Claude Code, Copilot CLI) outside code blocks and inline code. */
const findImports = (text) => markdownLines(text).flatMap((l) => (l.code ? []
  : [...l.prose.matchAll(IMPORT_RE)].map((m) => m[2])));

/** Inline `@imports` recursively (depth 4, cycles skipped). Returns `{ text, missing[], files[] }`. */
export function inlineImports(text, absFile, depth = 0, seen = new Set()) {
  const missing = [];
  const files = [];
  seen.add(path.resolve(absFile));
  const lines = markdownLines(text).map((l) => {
    if (l.code) return l.raw;
    let out = '';
    let last = 0;
    for (const m of l.prose.matchAll(IMPORT_RE)) {
      const at = m.index + m[1].length;
      const target = path.resolve(path.dirname(absFile), m[2]);
      const content = readText(target);
      out += l.raw.slice(last, at);
      last = at + m[2].length + 1;
      if (content == null) missing.push(m[2]);
      if (content == null || seen.has(target) || depth >= 4) { out += `@${m[2]}`; continue; }
      const inner = inlineImports(stripMarker(content), target, depth + 1, seen);
      files.push(target, ...inner.files);
      missing.push(...inner.missing);
      out += inner.text.replace(/\n+$/, '');
    }
    return out + l.raw.slice(last);
  });
  return { text: lines.join('\n'), missing, files };
}

/** A merge function that replaces (or appends) the port-managed section for `id`; `strip` removes it. */
function portSection(id, block = '') {
  const [begin, end] = [`<!-- adc:port begin ${id} -->`, `<!-- adc:port end ${id} -->`];
  const full = `${begin}\n${block.replace(/\n+$/, '')}\n${end}\n`;
  const find = (cur) => [cur.indexOf(begin), cur.indexOf(end)];
  const merge = (cur = '') => {
    const [a, b] = find(cur);
    if (a >= 0 && b > a) return cur.slice(0, a) + full + cur.slice(b + end.length).replace(/^\r?\n/, '');
    return cur + (cur && !cur.endsWith('\n') ? '\n' : '') + (cur.trim() ? '\n' : '') + full;
  };
  merge.strip = (cur) => {
    const [a, b] = find(cur);
    return a >= 0 && b > a ? cur.slice(0, a) + cur.slice(b + end.length) : cur;
  };
  return merge;
}

function convertInstructions(src, cls, targets, acc) {
  const raw = stripMarker(src.text);
  const inlined = inlineImports(raw, src.abs);
  for (const ref of inlined.missing) acc.step(`Import @${ref} in ${src.rel} does not resolve; fix it first.`);
  const base = path.posix.basename(src.rel);
  const native = (h) => acc.note(`${h}: reads ${src.rel} natively`);
  for (const host of targets) {
    if (host === 'codex') {
      if (['AGENTS.md', 'AGENTS.override.md'].includes(base)) { native(host); continue; }
      if (base === 'CLAUDE.md' && findImports(raw).some((r) => path.posix.basename(r) === 'AGENTS.md')) {
        acc.note('codex: AGENTS.md is the shared source; the Claude-only notes in CLAUDE.md are not ported');
        continue;
      }
      const content = `${markerLine(src.rel)}\n${trimBody(inlined.text)}`;
      const bytes = Buffer.byteLength(content);
      if (inlined.files.length) acc.step('Codex has no @import: imports were inlined; re-run the port after edits.');
      if (bytes > 32768) acc.step(`AGENTS.md would be ${bytes} bytes; Codex loads at most 32 KiB of AGENTS.md.`);
      acc.outputs.push({ path: 'AGENTS.md', content, host, kind: 'instructions' });
      acc.step(base === 'CLAUDE.local.md' ? 'CLAUDE.local.md is personal; keep it out of the shared AGENTS.md.'
        : `Copilot reads AGENTS.md as well as ${base}, so these rules now load twice in Copilot: keep the shared rules `
          + `in AGENTS.md, host-only notes in ${base}, and give Claude Code an @AGENTS.md import.`);
    } else if (host === 'claude') {
      if (['CLAUDE.md', 'CLAUDE.local.md'].includes(base)) { native(host); continue; }
      const merge = portSection(src.rel, `@${src.rel}\n`);
      // A CLAUDE.md that already imports the source (hand-written or ported) stays as it is.
      const imports = (cur) => findImports(merge.strip(cur)).some((r) => toPosix(r).replace(/^\.\//, '') === src.rel);
      const content = merge(`${markerLine(src.rel)}\n`);
      const keep = (cur) => (imports(cur) ? cur : merge(cur));
      acc.outputs.push({ path: 'CLAUDE.md', content, merge: keep, host, kind: 'instructions' });
      if (base === 'AGENTS.md') acc.note('claude: reads AGENTS.md only without CLAUDE.md; the import keeps one source');
      else acc.step(`Copilot CLI also reads CLAUDE.md: check it loads ${src.rel} once (copilot instruction list).`);
    } else if (base === 'AGENTS.md' || src.rel === '.github/copilot-instructions.md') {
      native(host);
      if (base === 'AGENTS.md') acc.step('Copilot code review reads only copilot-instructions.md and scoped files.');
    } else {
      if (base === 'AGENTS.override.md') acc.step('AGENTS.override.md is a local Codex override; now it is shared.');
      acc.outputs.push({ path: '.github/copilot-instructions.md', content: inlined.text, host, kind: 'instructions' });
      if (['CLAUDE.md', 'GEMINI.md'].includes(base)) acc.step(`Copilot also reads ${base}: keep one of the two short.`);
    }
  }
}

/** Static directory prefix of a glob (`src/api/**\/*.ts` → `src/api`). */
function globDirPrefix(glob) {
  const segs = toPosix(glob).replace(/^\.\//, '').split('/');
  const k = segs.slice(0, -1).findIndex((s) => /[*?[\]{}]/.test(s));
  return segs.slice(0, k < 0 ? segs.length - 1 : k).join('/');
}

function convertScoped(src, cls, targets, acc) {
  const base = path.posix.basename(src.rel);
  const d = src.fm.data;
  const dir = cls.scopeDir || path.posix.dirname(src.rel);
  const [topic, globs] = /\.instructions\.md$/.test(base) ? [base.replace(/\.instructions\.md$/, ''), asList(d.applyTo)]
    : /(^|\/)\.claude\/rules\//.test(src.rel) ? [base.replace(/\.md$/, ''), asList(d.paths)]
      : [toSkillName(dir), [`${dir}/**`]];
  const body = trimBody(src.fm.hasFrontmatter ? src.fm.body : stripMarker(src.fm.body));
  const always = !globs.length || globs.some((g) => g === '**' || g === '**/*');
  const desc = d.description ? { description: asText(d.description) } : {};
  for (const host of targets) {
    if (host === cls.host) { acc.note(`${host}: native`); continue; }
    if (d.excludeAgent && host !== 'copilot') {
      acc.dropped.push(dropRow(src.rel, 'excludeAgent', `${host} has no excludeAgent`, asText(d.excludeAgent)));
    }
    if (host === 'copilot') {
      const content = stringifyFrontmatter({ applyTo: always ? '**' : globs.join(','), ...desc }, `\n${body}`);
      acc.outputs.push({ path: `.github/instructions/${topic}.instructions.md`, content, host, kind: 'scoped' });
    } else if (host === 'claude') {
      const data = { ...(always ? {} : { paths: globs }), ...desc };
      const content = some(data) ? stringifyFrontmatter(data, `\n${body}`) : body;
      acc.outputs.push({ path: `.claude/rules/${topic}.md`, content, host, kind: 'scoped' });
      if (always) acc.note('claude: a rule without paths loads in every session');
    } else {
      const byDir = new Map();
      for (const g of always ? ['**'] : globs) {
        const pre = globDirPrefix(g);
        byDir.set(pre, [...(byDir.get(pre) || []), g]);
        if (g === `${pre}/**` || (pre === '' && (g === '**' || g === '**/*'))) continue;
        const why = `Codex scopes AGENTS.md by directory only; the rules apply to all of ${pre || 'the repository'}/`;
        acc.dropped.push(dropRow(src.rel, 'applyTo', why, g));
      }
      for (const [pre, gl] of byDir) {
        const title = desc.description || asText(d.name) || topic;
        const applies = gl.map((g) => `\`${g}\``).join(', ');
        const merge = portSection(src.rel, `## ${title}\n\nApplies to: ${applies}\n\n${body.replace(/\n+$/, '')}\n`);
        acc.outputs.push({ path: `${pre ? `${pre}/` : ''}AGENTS.md`, content: merge(''), merge, host, kind: 'scoped' });
      }
    }
  }
}

// Fields mapped explicitly between the hosts; every other field travels in `extra` (kept or reported).
const AGENT_MAPPED = ['name', 'description', 'tools', 'model', 'user-invocable', 'disable-model-invocation', 'skills'];
const AGENT_MAPPED_BY_HOST = { copilot: ['include-custom-instructions', 'reasoningEffort'],
  claude: ['omitClaudeMd', 'effort'] };

/** Agent file → IR `{ name, description, tools (Claude names | null = all), model, ..., body, extra, errors[] }`. */
export function parseAgent(text, host, rel) {
  const fm = parseFrontmatter(text);
  const d = fm.data;
  const ir = { name: asText(d.name) || path.posix.basename(rel).replace(/\.(agent|chatmode)\.md$|\.md$/, ''),
    description: asText(d.description), tools: null, toolsUnknown: [], model: asText(d.model),
    userInvocable: asBool(d['user-invocable']), disableModelInvocation: asBool(d['disable-model-invocation']),
    skills: d.skills != null ? asList(d.skills) : null, body: trimBody(fm.body), extra: {}, source: host,
    errors: fm.errors.map((e) => e.message) };
  if (host === 'copilot') {
    if (d.tools != null) ({ tools: ir.tools, unknown: ir.toolsUnknown } = toolsCopilotToCanonical(asList(d.tools)));
    // Copilot subagents get no repository instructions unless this is true (default false).
    ir.includeInstructions = asBool(d['include-custom-instructions']) === true;
    ir.effort = asText(d.reasoningEffort);
    if (ir.disableModelInvocation == null && asBool(d.infer) === false) ir.disableModelInvocation = true;
  } else {
    const list = asList(d.tools);
    if (d.tools != null) ir.tools = list.includes('*') ? null : uniq(list.map((t) => (t === 'Task' ? 'Agent' : t)));
    Object.assign(ir, { includeInstructions: asBool(d.omitClaudeMd) !== true, effort: asText(d.effort) });
  }
  const mapped = [...AGENT_MAPPED, ...(AGENT_MAPPED_BY_HOST[host] || [])];
  for (const [k, v] of Object.entries(d)) if (!mapped.includes(k) && v != null) ir.extra[k] = v;
  return ir;
}

/** Render an agent IR for copilot or claude. Returns `{ path, content, dropped[], manual[] }`. */
export function renderAgent(ir, host, { file = ir.name, pluginScoped = false } = {}) {
  const dropped = [];
  const manual = [];
  const drop = (field, reason, value = typeof ir.extra[field] === 'string' ? ir.extra[field] : undefined) => {
    dropped.push(dropRow(file, field, reason, value));
  };
  const opt = (cond, obj) => (cond ? obj : {});
  const flags = { ...opt(ir.userInvocable != null, { 'user-invocable': ir.userInvocable }),
    ...opt(ir.disableModelInvocation != null, { 'disable-model-invocation': ir.disableModelInvocation }) };
  const base = { ...opt(ir.model, { model: ir.model }), ...opt(ir.skills, { skills: ir.skills }) };
  if (ir.model && ir.source !== host) manual.push(`${ir.name}: check "${ir.model}" is a ${HOST_NAME[host]} model.`);
  if (host === 'copilot') {
    const t = ir.tools ? toolsCanonicalToCopilot(ir.tools) : null;
    if (t?.unmapped.length) drop('tools', 'no Copilot tool alias', t.unmapped.join(', '));
    const effort = /^(low|medium|high)$/.test(ir.effort || '');
    if (ir.effort && !effort) drop('effort', 'no matching Copilot reasoningEffort value', ir.effort);
    const data = { name: ir.name, description: ir.description ?? '', ...opt(t, { tools: t?.tools }), ...base, ...flags,
      ...opt(ir.includeInstructions, { 'include-custom-instructions': true }),
      ...opt(effort, { reasoningEffort: ir.effort }) };
    for (const k of Object.keys(ir.extra)) {
      if (ir.source === 'copilot') data[k] = ir.extra[k];
      else drop(k, k === 'disallowedTools' ? 'no deny list in Copilot; narrow tools' : `Copilot agents have no "${k}"`);
    }
    if (ir.body.length > 30000) manual.push(`${ir.name}: the body has ${ir.body.length} characters (Copilot: 30,000).`);
    const content = stringifyFrontmatter(data, `\n${ir.body}`, { flowKeys: ['tools', 'skills'] });
    return { path: `.github/agents/${agentFileName(ir.name)}.agent.md`, content, dropped, manual };
  }
  const name = String(ir.name).replace(/:/g, '-');
  if (name !== ir.name) manual.push(`Claude Code agent names cannot contain ":"; renamed ${ir.name} to ${name}.`);
  if (!ir.description) manual.push(`${ir.name}: Claude Code requires a description for subagents.`);
  const data = { name, description: ir.description ?? '', ...opt(ir.tools, { tools: ir.tools?.join(', ') }), ...base,
    ...opt(ir.effort, { effort: ir.effort }), ...opt(!ir.includeInstructions, { omitClaudeMd: true }), ...flags };
  if (!ir.includeInstructions && ir.source === 'copilot') {
    manual.push(`${ir.name}: the Copilot agent gets no repository instructions (no include-custom-instructions), `
      + 'so the Claude Code agent sets omitClaudeMd: true; remove it to give the agent CLAUDE.md.');
  }
  if (ir.toolsUnknown.length) manual.push(`${ir.name}: check the tools ${ir.toolsUnknown.join(', ')} (no alias).`);
  for (const k of Object.keys(ir.extra)) {
    if (ir.source !== 'claude') drop(k, `Claude Code subagents have no "${k}"`);
    else if (pluginScoped && ['hooks', 'mcpServers', 'permissionMode'].includes(k)) drop(k, 'plugin agents ignore it');
    else data[k] = ir.extra[k];
  }
  if (ir.source !== 'claude' && some(flags)) manual.push(`${ir.name}: invocation flags are kept for round trips.`);
  const content = stringifyFrontmatter(data, `\n${ir.body}`, { flowKeys: ['skills'] });
  return { path: `.claude/agents/${name}.md`, content, dropped, manual };
}

/** The first sentence of a description (at most 200 characters). */
export function firstSentence(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return (/^(.{10,}?[.!?])(\s|$)/.exec(s)?.[1] || s).slice(0, 200);
}

/** 25-64 characters for Codex's metadata.short-description, or null. */
export function shortDescription(text) {
  let s = firstSentence(text).replace(/[.!?]$/, '');
  const cut = s.slice(0, 64);
  if (s.length > 64) s = cut.lastIndexOf(' ') > 25 ? cut.slice(0, cut.lastIndexOf(' ')) : cut;
  return s.length >= 25 ? s : null;
}

/** `agents/openai.yaml` for a Codex skill (D9: generated only for the user's own skills). */
export function renderOpenAiYaml({ name, description, implicit = true }) {
  const sd = shortDescription(description);
  const prompt = `Use $${name}: ${firstSentence(description) || 'help with this task.'}`;
  const iface = { display_name: name, ...(sd ? { short_description: sd } : {}), default_prompt: prompt };
  return stringifyYaml({ interface: iface, policy: { allow_implicit_invocation: Boolean(implicit) } });
}

function skillFile({ name, description, extra = {}, host, body }) {
  const sd = host === 'codex' ? shortDescription(description) : null;
  const data = { name, description: description || `Runs the ${name} workflow.`,
    ...Object.fromEntries(Object.entries(extra).filter(([, v]) => v != null)),
    ...(sd ? { metadata: { 'short-description': sd } } : {}) };
  return stringifyFrontmatter(data, `\n${body}`);
}

const PROMPT_VARS = new RegExp('\\$\\{(input:[^}]+|selection|selectedText|file|fileBasename|fileDirname'
  + '|fileBasenameNoExtension|workspaceFolder|workspaceFolderBasename)\\}|#(file|tool):[^\\s,;)]*[^\\s,;).]', 'g');
const CLAUDE_PLACEHOLDERS = /\$ARGUMENTS(\[\d+\])?|\$\d\b|\$\{CLAUDE_[A-Z_]+\}|(^|\s)!`[^`]+`/m;
const PROMPT_FIELDS = ['name', 'description', 'argument-hint', 'agent', 'model', 'tools', 'allowed-tools',
  'disable-model-invocation'];
const placeholderStep = (dir, host) => `${dir}/SKILL.md has Claude-only placeholders or !\`cmd\` (not in ${host}).`;

function convertPromptLike(src, cls, targets, acc) {
  const d = src.fm.data;
  const base = path.posix.basename(src.rel);
  const command = /\.claude\/commands\/(.+)\.md$/.exec(src.rel)?.[1].split('/').join('-');
  const label = cls.kind === 'command' ? command || base.replace(/\.md$/, '')
    : asText(d.name) || base.replace(/\.prompt\.md$/, '');
  const name = toSkillName(label);
  if (name !== label) acc.note(`skill name "${name}" derived from "${label}"`);
  const body = trimBody(src.fm.body);
  let description = asText(d.description);
  if (!description) {
    description = firstSentence(body.replace(/^#.*$/m, '')) || `Runs the ${name} prompt.`;
    acc.step(`${src.rel} has no description; "${description}" was derived: rewrite it (what + when + boundary).`);
  }
  const drop = (field, reason, value) => acc.dropped.push(dropRow(src.rel, field, reason, value));
  for (const k of Object.keys(d)) if (!PROMPT_FIELDS.includes(k)) drop(k, 'not a skill field');
  for (const k of cls.kind === 'prompt' ? ['agent', 'model', 'tools'] : []) {
    if (d[k] != null) drop(k, 'prompt-file field with no skill equivalent (VS Code drops it too)', asText(d[k]));
  }
  const vars = uniq([...`${description}\n${body}`.matchAll(PROMPT_VARS)].map((m) => m[0]));
  for (const host of targets) {
    const dir = `${SKILL_DIRS[host]}/${name}`;
    const extra = host === 'codex' ? {} : { 'argument-hint': asText(d['argument-hint']) };
    if (host === 'codex' && d['argument-hint'] != null) drop('argument-hint', 'Codex ignores argument-hint');
    if (cls.kind === 'prompt') {
      if (host !== 'codex') extra['disable-model-invocation'] = true;
      if (vars.length) acc.step(`Rewrite the prompt-file variables ${vars.join(', ')} in ${dir}/SKILL.md.`);
    } else {
      if (d['allowed-tools'] != null) extra['allowed-tools'] = asText(d['allowed-tools']).replace(/,\s*/g, ' ');
      if (host !== 'codex') extra['disable-model-invocation'] = asBool(d['disable-model-invocation']);
      if (d.model != null && host === 'claude') extra.model = asText(d.model);
      else if (d.model != null) drop('model', `${host} skills have no model field`, asText(d.model));
      if (host !== 'claude' && CLAUDE_PLACEHOLDERS.test(body)) acc.step(placeholderStep(dir, host));
      if (host === 'claude') acc.step(`Delete ${src.rel} once the skill works (it wins; two copies drift).`);
    }
    const out = (p, content) => acc.outputs.push({ path: `${dir}/${p}`, content, host, kind: 'skill' });
    out('SKILL.md', skillFile({ name, description, extra, host, body }));
    const implicit = cls.kind !== 'prompt' && asBool(d['disable-model-invocation']) !== true;
    if (host === 'codex') out('agents/openai.yaml', renderOpenAiYaml({ name, description, implicit }));
  }
}

function convertChatmode(src, cls, targets, acc) {
  const ir = parseAgent(src.text, 'copilot', src.rel);
  const tools = src.fm.data.tools != null ? asList(src.fm.data.tools) : null;
  if (!ir.description) acc.step(`${src.rel} has no description; Copilot agents require one.`);
  if (tools) acc.step(`Check the tools of ${ir.name}: chat-mode tool sets (${tools.join(', ')}) are not aliases.`);
  for (const k of Object.keys(src.fm.data).filter((x) => !['name', 'description', 'tools', 'model'].includes(x))) {
    acc.dropped.push(dropRow(src.rel, k, 'not a custom-agent field'));
  }
  const data = { name: ir.name, description: ir.description || `${ir.name} agent`, ...(tools ? { tools } : {}),
    ...(ir.model ? { model: ir.model } : {}) };
  const content = stringifyFrontmatter(data, `\n${ir.body}`, { flowKeys: ['tools'] });
  const file = `.github/agents/${agentFileName(ir.name)}.agent.md`;
  acc.outputs.push({ path: file, content, host: 'copilot', kind: 'agent' });
}

const SKILL_HOST_FIELDS = {
  copilot: ['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools', 'argument-hint',
    'user-invocable', 'disable-model-invocation', 'context'],
  codex: ['name', 'description', 'metadata'],
};

function convertSkill(src, cls, targets, acc) {
  const absDir = path.dirname(src.abs);
  const d = src.fm.data;
  const name = asText(d.name) || path.basename(absDir);
  if (name !== path.basename(absDir)) acc.step(`Skill name "${name}" differs from its directory; VS Code skips it.`);
  const files = listFiles(absDir, { ignore: COPY_IGNORE });
  for (const host of targets) {
    if (cls.hosts.includes(host)) { acc.note(`${host}: already loads ${cls.dir}`); continue; }
    const dir = `${SKILL_DIRS[host]}/${name}`;
    for (const f of files) {
      acc.outputs.push({ path: `${dir}/${f}`, content: fs.readFileSync(path.join(absDir, f)), host, kind: 'skill' });
    }
    for (const k of Object.keys(d).filter((x) => SKILL_HOST_FIELDS[host]?.includes(x) === false)) {
      acc.dropped.push(dropRow(src.rel, k, `${host} ignores this SKILL.md field (copied unchanged)`));
    }
    if (host !== 'claude' && CLAUDE_PLACEHOLDERS.test(src.fm.body)) acc.step(placeholderStep(dir, host));
    if (host === 'codex' && asBool(d['disable-model-invocation']) === true && !files.includes('agents/openai.yaml')) {
      const content = renderOpenAiYaml({ name, description: asText(d.description), implicit: false });
      acc.outputs.push({ path: `${dir}/agents/openai.yaml`, content, host, kind: 'skill' });
      acc.note('codex: disable-model-invocation became allow_implicit_invocation: false in agents/openai.yaml');
    }
    acc.step(`Keep ${dir} in sync: re-run \`tooling port ${cls.dir} --to ${host} --force\` after edits.`);
  }
}

function convertAgent(src, cls, targets, acc) {
  const ir = parseAgent(src.text, cls.host, src.rel);
  for (const host of targets) {
    if (host === cls.host) { acc.note(`${host}: native`); continue; }
    if (host !== 'codex') {
      if (host === 'copilot' && cls.host === 'claude') acc.note('copilot: Copilot CLI also reads .claude/agents');
      const r = renderAgent(ir, host, { file: src.rel });
      acc.outputs.push({ path: r.path, content: r.content, host, kind: 'agent' });
      acc.dropped.push(...r.dropped);
      acc.step(...r.manual);
      continue;
    }
    const name = toSkillName(ir.name);
    const dir = `${CODEX_ONLY_SKILLS_DIR}/${name}`;
    const yaml = renderOpenAiYaml({ name, description: ir.description, implicit: ir.disableModelInvocation !== true });
    const skill = skillFile({ name, description: ir.description, host, body: ir.body });
    acc.outputs.push({ path: `${dir}/SKILL.md`, content: skill, host, kind: 'skill' },
      { path: `${dir}/agents/openai.yaml`, content: yaml, host, kind: 'skill' });
    const why = 'Codex skills have no tool restriction; state limits in the body';
    if (ir.tools) acc.dropped.push(dropRow(src.rel, 'tools', why, ir.tools.join(', ')));
    if (ir.model) acc.dropped.push(dropRow(src.rel, 'model', 'Codex skills have no model field', ir.model));
    for (const k of Object.keys(ir.extra)) acc.dropped.push(dropRow(src.rel, k, 'no Codex equivalent'));
    acc.step(`Codex has no custom agent files: ${ir.name} became the skill ${dir} (invoke it as $${name}). `
      + 'The .codex/agents/<name>.toml role format is unverified and was not generated.');
  }
}

function convertHooks(src, cls, targets, acc, { inPlace = false } = {}) {
  const parsed = parseHookConfig(src.text, cls.host, src.rel);
  acc.dropped.push(...parsed.dropped);
  acc.note(...parsed.notes);
  for (const host of targets) {
    if (host === cls.host && !inPlace) { acc.note(`${host}: native`); continue; }
    const r = renderHookConfig(parsed.entries, host, { file: src.rel });
    acc.dropped.push(...r.dropped);
    acc.step(...r.manual);
    acc.note(...r.notes);
    const stem = { claude: 'claude-settings', codex: 'codex-hooks' }[cls.host] || path.posix.basename(src.rel, '.json');
    const target = inPlace ? src.rel
      : { copilot: `.github/hooks/${stem}.json`, claude: '.claude/settings.json', codex: '.codex/hooks.json' }[host];
    const how = inPlace ? { replace: true } : { merge: (cur) => mergeHooks(cur, r.doc) };
    acc.outputs.push({ path: target, content: json(r.doc), host, kind: 'hooks', ...how });
    if (host === 'claude' && cls.host === 'copilot') {
      acc.step('Copilot CLI and VS Code also run .claude/settings.json hooks: remove the .github/hooks original '
        + 'for local sessions, or the hook runs twice (the cloud agent reads only .github/hooks).');
    }
    if (host === 'codex') acc.step('Codex runs repository hooks only in trusted projects, after a review in /hooks.');
  }
}

function convertMcp(src, cls, targets, acc) {
  const parsed = parseMcpConfig(src.text, cls.dialect, src.rel);
  acc.dropped.push(...parsed.dropped);
  acc.step(...parsed.manual);
  for (const host of targets) {
    const native = host === 'claude' ? cls.dialect === 'mcpServers' && src.rel.endsWith('.mcp.json')
      : host === 'copilot' ? ['.mcp.json', '.github/mcp.json'].includes(src.rel) : cls.dialect === 'toml';
    if (native) { acc.note(`${host}: reads ${src.rel} natively`); continue; }
    const r = renderMcpConfig(parsed.servers, host, { file: src.rel });
    acc.dropped.push(...r.dropped);
    acc.step(...r.manual);
    if (host === 'codex') {
      const merge = (cur) => mergeToml(cur, r.blocks);
      acc.outputs.push({ path: '.codex/config.toml', content: r.text, merge, host, kind: 'mcp' });
      acc.step('Codex reads a repository .codex/config.toml only in trusted projects (or use ~/.codex/config.toml).');
    } else {
      const target = host === 'claude' ? '.mcp.json' : '.github/mcp.json';
      acc.outputs.push({ path: target, content: json(r.doc), merge: (cur) => mergeMcp(cur, r.doc), host, kind: 'mcp' });
    }
    if (host === 'copilot') acc.step(cloudAgentMcp(parsed.servers));
  }
  const literal = (v) => v && !/\$\{/.test(v) && /(token|secret|key|password)/i.test(v);
  if (parsed.servers.some((s) => Object.values(s.env || {}).some(literal))) {
    acc.step('An env value looks like a literal credential; reference an environment variable instead.');
  }
}

// ---------------------------------------------------------------------------
// port() and the CLI command

const CONVERTERS = { instructions: convertInstructions, scoped: convertScoped, agent: convertAgent,
  prompt: convertPromptLike, command: convertPromptLike, chatmode: convertChatmode, skill: convertSkill,
  hooks: convertHooks, mcp: convertMcp };
const WITH_FRONTMATTER = ['scoped', 'agent', 'prompt', 'command', 'chatmode', 'skill'];

/**
 * Translate one tooling artifact. `path` is relative to `cwd` (default: root); targets are written under
 * `out` (default: the repository root) at each host's canonical location. Returns `{ source, targets, out,
 * dry_run, written[], skipped[], backups[], dropped_fields[], manual_steps[], notes[] }`.
 */
export function port({ path: srcPath, from = null, to = 'all', out = null, root = null, cwd = null, dryRun = false,
  force = false, inPlace = false, backupDir = null } = {}) {
  if (!srcPath) throw usageError('tooling port needs a path (e.g. .github/agents/reviewer.agent.md)');
  const base = cwd || root || process.cwd();
  const rootDir = root || repoRoot(base) || base;
  let abs = path.resolve(base, srcPath);
  if (!fs.existsSync(abs)) throw usageError(`not found: ${toPosix(srcPath)}`);
  if (fs.statSync(abs).isDirectory()) {
    if (!fs.existsSync(path.join(abs, 'SKILL.md'))) throw usageError(`${toPosix(srcPath)} has no SKILL.md`);
    abs = path.join(abs, 'SKILL.md');
  }
  const src = { abs, rel: relPosix(rootDir, abs) ?? toPosix(abs), text: readText(abs, '') };
  const cls = classifyArtifact(src.rel);
  if (!cls) throw usageError(`cannot tell which tooling format ${src.rel} is; pass a file at its host location`);
  if (from && !HOSTS.includes(from)) throw usageError(`--from must be copilot, claude or codex (got "${from}")`);
  if (from && from !== cls.host && !['portable', 'vscode'].includes(cls.host)) {
    throw usageError(`${src.rel} is a ${cls.host} file, not ${from}`);
  }
  if (!CONVERTERS[cls.kind]) throw usageError(`${cls.kind} files cannot be ported (see tooling plugin for manifests)`);
  if (WITH_FRONTMATTER.includes(cls.kind)) {
    // A frontmatter that does not parse would port as an empty or wrong body: refuse instead.
    src.fm = parseFrontmatter(src.text);
    const err = src.fm.errors[0];
    if (err) throw usageError(`${src.rel}: ${err.message}; fix the frontmatter first (see tooling lint)`);
  }
  const fromHost = cls.host === 'portable' && from ? from : cls.host;
  const targets = inPlace ? [cls.host] : !to || to === 'all' ? HOSTS.filter((h) => h !== fromHost)
    : uniq(String(to).split(',').map((s) => s.trim()).filter(Boolean));
  const bad = targets.find((h) => !HOSTS.includes(h));
  if (bad) throw usageError(`--to must be copilot, claude, codex or all (got "${bad}")`);
  const acc = { outputs: [], dropped: [], manual: [], notes: [] };
  Object.assign(acc, { step: (...m) => acc.manual.push(...m), note: (...m) => acc.notes.push(...m) });
  CONVERTERS[cls.kind](src, cls, targets, acc, { inPlace });
  const outRoot = out ? path.resolve(base, out) : rootDir;
  const applied = writeOutputs(acc.outputs, { root: outRoot, dryRun, force, mergeNeedsForce: true, backupDir });
  return { source: { path: src.rel, kind: cls.kind, host: fromHost }, targets, out: toPosix(path.relative(rootDir, outRoot) || '.'),
    dry_run: Boolean(dryRun), ...applied, dropped_fields: acc.dropped, manual_steps: uniq(acc.manual), notes: uniq(acc.notes) };
}

/** Built-in migrations (§11.6); each maps to a port with a fixed source kind and target. */
export const MIGRATIONS = Object.freeze({
  'prompt-to-skill': { kinds: ['prompt'], host: 'copilot',
    describe: '.github/prompts/*.prompt.md -> skill with disable-model-invocation: true' },
  'chatmode-to-agent': { kinds: ['chatmode'], host: 'copilot',
    describe: '.github/chatmodes/*.chatmode.md -> .github/agents/*.agent.md' },
  'claude-commands-to-skills': { kinds: ['command'], host: 'claude',
    describe: '.claude/commands/**/*.md -> .claude/skills/<name>/SKILL.md' },
  'vscode-mcp-to-mcp-json': { kinds: ['mcp'], host: 'claude', dialect: 'vscode',
    describe: '.vscode/mcp.json (servers, ${input:}) -> .mcp.json (mcpServers, ${VAR})' },
  'copilot-hooks-to-camel': { kinds: ['hooks'], host: 'copilot', inPlace: true,
    describe: 'legacy or PascalCase .github/hooks/*.json -> version 1 camelCase with bash + powershell' },
});

/** Expand a migration source (a file or, for commands, a directory) into the files to migrate. */
export function migrationSources(kind, root, cwd, p) {
  const spec = MIGRATIONS[kind];
  if (!spec) throw usageError(`unknown migration "${kind}" (expected ${Object.keys(MIGRATIONS).join(', ')})`);
  const abs = path.resolve(cwd, p);
  if (!fs.existsSync(abs)) throw usageError(`not found: ${toPosix(p)}`);
  const ok = (rel) => {
    const c = classifyArtifact(rel);
    return c && spec.kinds.includes(c.kind) && (!spec.dialect || c.dialect === spec.dialect);
  };
  const dir = fs.statSync(abs).isDirectory();
  const files = dir ? listFiles(abs, { ignore: COPY_IGNORE }).map((f) => path.join(abs, f)) : [abs];
  const out = files.map((f) => relPosix(root, f) ?? toPosix(f)).filter((rel) => !dir || ok(rel));
  const bad = out.find((rel) => !ok(rel));
  if (bad) throw usageError(`${bad} is not a source for ${kind} (${spec.describe})`);
  if (!out.length) throw usageError(`no ${spec.describe.split(' ->')[0]} files under ${toPosix(p)}`);
  return out;
}

/** Run a migration; returns the merged port results plus `{ migration, describe, sources[] }`. */
export function migrate(kind, { path: p, root, cwd = null, host = null, dryRun = false, force = false, backupDir }) {
  const spec = MIGRATIONS[kind];
  const sources = migrationSources(kind, root, cwd || root, p);
  const keys = ['written', 'skipped', 'backups', 'dropped_fields', 'manual_steps', 'notes'];
  const merged = { migration: kind, describe: spec.describe, sources, ...Object.fromEntries(keys.map((k) => [k, []])) };
  for (const rel of sources) {
    const r = port({ path: rel, root, cwd: root, to: host || spec.host, dryRun, force: force || Boolean(spec.inPlace),
      inPlace: Boolean(spec.inPlace), backupDir });
    for (const k of keys) merged[k].push(...r[k]);
  }
  if (kind === 'copilot-hooks-to-camel') {
    merged.manual_steps.push('camelCase events send camelCase payloads (toolName, toolArgs as a JSON string) '
      + 'instead of the snake_case ones PascalCase events got; update the handler.');
  }
  return { ...merged, manual_steps: uniq(merged.manual_steps), notes: uniq(merged.notes) };
}

export const portCommand = defineCommand({
  name: 'tooling port',
  usage: 'tooling port <path> [--to copilot|claude|codex|all] [--from host] [--out dir] [--force] [--dry-run]',
  options: { from: { type: 'string' }, to: { type: 'string' }, out: { type: 'string' }, force: { type: 'boolean' } },
  async run(ctx, values, positionals) {
    if (positionals.length !== 1) throw usageError('tooling port takes one path');
    const root = repoRoot(ctx.cwd) || ctx.cwd;
    prepareStateDir({ ...ctx, cwd: root }, { create: false });
    const backupDir = backupDirFactory(ctx, root, 'tooling', 'backups');
    const res = port({ path: positionals[0], from: values.from || null, to: values.to || 'all', out: values.out || null,
      root, cwd: ctx.cwd, dryRun: ctx.dryRun, force: Boolean(values.force), backupDir });
    const n = res.written.filter((w) => w.action !== 'unchanged').length;
    const what = `${n} file(s) ${ctx.dryRun ? 'planned' : 'written'}, ${res.skipped.length} skipped`;
    const counts = `${res.dropped_fields.length} dropped field(s), ${res.manual_steps.length} manual step(s)`;
    const summary = `${res.source.kind} ${res.source.path} -> ${res.targets.join(', ')}: ${what}, ${counts}`;
    return { result: res, exit: EXIT.OK, summary };
  },
});
