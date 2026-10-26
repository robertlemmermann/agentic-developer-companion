// `tooling lint`: checks instructions, skills, agents, prompt files, hooks, plugins, marketplaces and MCP
// configs against each host's documented rules (plan §11.2). The rule catalog (ids, hosts with a severity
// each, sources, and the title that is a finding's default message) and the source citations live in
// references/tooling-lint.md and are parsed at load, so the reference the model reads and the linter cannot
// drift apart. The hosts' own validators are merged when installed (none runs a model turn). Read-only.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  defineCommand, usageError, envError, EXIT, readText, toPosix, globToRegExp, which, runTool, toolVersion,
  versionGte, truncate, isObj, lineOf, statOrNull, findUp, hostHomes, samePath, listFiles, firstLine, SKILL_DIR,
} from './core.mjs';
import { repoRoot } from './git.mjs';
import { resolveStateDir, assertStateUntracked } from './state.mjs';
import { parseJson, parseToml } from './formats.mjs';
import { scanSecrets, redactSecrets } from './markers.mjs';
import {
  parseFrontmatter, parseYamlDocument, INSTALL_METADATA_KEY, markdownLines, markdownLinks, isExternalLink, linkPath,
} from './frontmatter.mjs';

export const HOSTS = Object.freeze(['spec', 'copilot', 'claude', 'codex']);
const LABEL = { spec: 'Agent Skills spec', copilot: 'Copilot', claude: 'Claude Code', codex: 'Codex' };
const W = (s) => s.trim().split(/\s+/);
const S = (s) => new Set(W(s));

// ---------------------------------------------------------------------------
// Catalog: the reference's `| \`ID\` | spec E, copilot W; strict: spec E | checks | \`source\` ... |` rows
// and its `- Group: \`key\` citation; \`key\` citation.` source bullets.

const REF = String(readText(path.join(SKILL_DIR, 'references', 'tooling-lint.md'), '')).replace(/\r\n/g, '\n');
const SEV = { E: 'error', W: 'warning', N: 'note' };
const KINDS = { 'CX-YAML': 'codex-skill-meta', CX: 'codex-config', SK: 'skill', CM: 'command', PR: 'prompt',
  MD: 'markdown', IN: 'instructions', AG: 'agent', HK: 'hooks', PL: 'plugin', MK: 'marketplace', MC: 'mcp',
  SEC: 'security', EXT: 'external' };
const sevMap = (s) => Object.freeze(Object.fromEntries(s.split(', ').map((x) => x.trim().split(' '))
  .map(([h, l]) => [h, SEV[l]])));
const ROW = /^\| `([A-Z]+(?:-[A-Z0-9]+)+)` \| ([^|\n]+) \| (.+) \| ((?:`[\w-]+` ?)+) \|$/gm;

/** Every rule: { id, kind, hosts{host: severity}, strict?{host: severity}, title, sources[] }; security: severity. */
export const RULES = Object.freeze([...REF.matchAll(ROW)].map(([, id, hostCol, title, src]) => {
  const kind = KINDS[id.split('-').slice(0, 2).join('-')] || KINDS[id.split('-')[0]];
  const [base, strict] = hostCol.trim().split('; strict: ');
  const r = { id, kind, title: title.replace(/\\\|/g, '|').replace(/`/g, ''), sources: src.match(/[\w-]+/g) };
  return Object.freeze(kind === 'security' ? { ...r, group: 'security', hosts: {}, severity: SEV[base.split(' ')[1]] }
    : { ...r, hosts: sevMap(base), ...(strict && { strict: sevMap(strict) }) });
}));
const RULE_INDEX = new Map(RULES.map((r) => [r.id, r]));
const title = (id) => RULE_INDEX.get(id)?.title;

/** Source key → citation (the research digests, checked 2026-10-24/25). */
export const SOURCES = Object.freeze(Object.fromEntries((REF.split(/^## Sources$/m)[1] || '').split('\n')
  .map((l) => /^- ([^:`]+): (.*)$/.exec(l)).filter(Boolean)
  .flatMap(([, group, rest]) => rest.split(/; (?=`)/).map((p) => /^`([\w-]+)` (.+?)\.?$/.exec(p)).filter(Boolean)
    .map(([, key, text]) => [key, `${group}: ${text}`]))));

// ---------------------------------------------------------------------------
// Host facts used by the rules

const SPEC_FIELDS = 'name description license compatibility metadata allowed-tools';
const SKILL_FIELDS = {
  copilot: S(`${SPEC_FIELDS} argument-hint user-invocable disable-model-invocation context`),
  claude: S(`${SPEC_FIELDS} when_to_use argument-hint arguments disable-model-invocation user-invocable
    disallowed-tools model effort context agent background hooks paths shell`),
  codex: S(SPEC_FIELDS),
};
const AGENT_FIELDS = {
  copilot: S(`name description target tools model disable-model-invocation user-invocable infer mcp-servers metadata
    include-custom-instructions models modelPolicy reasoningEffort skills hooks argument-hint agents reasoning-effort
    handoffs`),
  claude: S(`name description tools disallowedTools model permissionMode maxTurns autoCompactWindow skills mcpServers
    hooks memory background omitClaudeMd effort isolation color initialPrompt experimental`),
};
const AGENT_ENUMS = {
  copilot: { target: W('vscode github-copilot'), modelPolicy: W('preferred required') },
  claude: { permissionMode: W('default acceptEdits auto dontAsk bypassPermissions plan manual'),
    memory: W('user project local'), isolation: ['worktree'], effort: W('low medium high xhigh max') },
};
const CP_TOOL_ALIASES = S(`execute shell Bash bash powershell read Read NotebookRead edit Edit MultiEdit Write
  NotebookEdit search Grep Glob agent custom-agent Task web WebSearch WebFetch todo TodoWrite *`);

const CP_EVENTS = W(`sessionStart sessionEnd userPromptSubmitted userPromptTransformed preToolUse postToolUse
  postToolUseFailure agentStop subagentStart subagentStop errorOccurred preCompact permissionRequest notification`);
const CP_EVENTS_PASCAL = W(`SessionStart SessionEnd UserPromptSubmit PreToolUse PostToolUse PostToolUseFailure Stop
  SubagentStop ErrorOccurred PreCompact PermissionRequest`);
const CP_EVENTS_UNDOC = W('SubagentStart Notification UserPromptTransformed');
const CP_OUTPUT_IGNORED = S(`errorOccurred sessionEnd preCompact userPromptSubmitted ErrorOccurred SessionEnd
  PreCompact UserPromptSubmit`);
const CP_ENTRY_FIELDS = S(`type bash powershell command exec args cwd env timeoutSec timeout matcher url headers
  allowedEnvVars prompt hooks comment description`);
const CL_EVENTS = W(`SessionStart Setup SessionEnd UserPromptSubmit UserPromptExpansion Stop StopFailure PreToolUse
  PermissionRequest PermissionDenied PostToolUse PostToolUseFailure PostToolBatch SubagentStart SubagentStop
  TaskCreated TaskCompleted TeammateIdle PreCompact PostCompact PreModelSwitch PostModelSwitch Elicitation
  ElicitationResult Notification MessageDisplay InstructionsLoaded ConfigChange CwdChanged DirectoryAdded FileChanged
  WorktreeCreate WorktreeRemove`);
const CL_NO_MATCHER = S(`UserPromptSubmit PostToolBatch Stop TeammateIdle TaskCreated TaskCompleted CwdChanged
  WorktreeCreate WorktreeRemove MessageDisplay`);
const CL_IF_EVENTS = S('PreToolUse PostToolUse PostToolUseFailure PermissionRequest PermissionDenied');
const CL_ALL_TYPES = S(`PermissionDenied PostToolBatch PostToolUse PostToolUseFailure PreToolUse Stop SubagentStop
  TaskCompleted TaskCreated TeammateIdle UserPromptExpansion UserPromptSubmit`);
const CL_HANDLER_FIELDS = S(`type if timeout statusMessage once command args shell async asyncRewake onFailure url
  headers allowedEnvVars server tool input prompt model continueOnBlock`);
const claudeTypes = (e) => W(CL_ALL_TYPES.has(e) ? 'command http mcp_tool prompt agent'
  : e === 'PermissionRequest' ? 'command http mcp_tool prompt'
    : e === 'SessionStart' || e === 'Setup' ? 'command mcp_tool' : 'command http mcp_tool');
const CX_EVENTS = W(`PreModelRequest PostModelRequest PreToolUse PermissionRequest PostToolUse PreCompact PostCompact
  SessionStart SessionEnd UserPromptSubmit SubagentStart SubagentStop Stop Interrupt`);
const CX_NO_MATCHER = S('UserPromptSubmit Stop Interrupt PreModelRequest PostModelRequest');
const CX_HANDLER_FIELDS = {
  command: S('type command commandWindows command_windows timeout async statusMessage additionalContextLimit'),
  mcp_tool: S('type server tool input timeout statusMessage'),
};

const AP_SCHEMA = (kind) => ['1.0.0', '1.1.0'].map((v) => `https://agent-plugins.org/schemas/${v}/${kind}.schema.json`);
const CL_PATH_FIELDS = 'skills commands agents hooks mcpServers lspServers outputStyles workflows';
const PLUGIN_FIELDS = {
  'agent-plugins': S('$schema name version description author homepage repository license keywords extensions'),
  copilot: S(`name description version author homepage repository license keywords category tags agents skills
    commands hooks mcpServers lspServers extensions $schema`),
  claude: S(`$schema name displayName version description author homepage repository license keywords metadata
    defaultEnabled dependencies settings userConfig types channels experimental icon documentationUrl supportUrl
    privacyPolicyUrl termsOfServiceUrl ${CL_PATH_FIELDS}`),
  codex: S(`name version description keywords skills mcpServers apps hooks interface extensions author homepage
    repository license`),
};
const CX_SNAKE = { mcp_servers: 'mcpServers', default_prompt: 'defaultPrompt', display_name: 'displayName' };
const CL_RESERVED_MKT = S(`claude-plugins-official claude-code-plugins anthropic-marketplace npm pip uv cargo github gh
  inline builtin skills-dir synced claude-plugin-test`);
const MKT_FIELDS = {
  claude: S(`$schema name owner plugins description version metadata forceRemoveDeletedPlugins
    allowCrossMarketplaceDependenciesOn renames`),
  copilot: S('$schema name owner plugins metadata description version'),
};
const NPM_SHIMS = S('npm npx pnpm pnpx yarn eslint prettier tsc jest vitest ts-node tsx playwright');
const LOOPBACK = S('localhost 127.0.0.1 [::1] ::1');
const WIN_ABS = /^[a-zA-Z]:[\\/]/;

// ---------------------------------------------------------------------------
// Small helpers

const readNorm = (p) => readText(p)?.replace(/\r\n/g, '\n') ?? null;
const keyLine = (text, key) => { const i = text.indexOf(`"${key}"`); return i < 0 ? null : lineOf(text, i); };
const badRegex = (re) => { try { new RegExp(re); return null; } catch (err) { return err; } };
const strs = (...xs) => xs.flat().filter((x) => typeof x === 'string');
const own = (o, k) => isObj(o) && Object.hasOwn(o, k);
const subdirs = (d) => {
  try { return fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()); } catch { return []; }
};
const guess = (list, name, pre = ' (did you mean ', post = '?)') => {
  const g = list.find((e) => e.toLowerCase() === String(name).toLowerCase());
  return g ? `${pre}${g}${post}` : '';
};

const XS = [[/&&|\|\|/, '&& / || (invalid in Windows PowerShell 5.1)'], [/\bcommand\s+-v\b/, '`command -v` (POSIX)'],
  [/\$env:/i, '$env: (PowerShell only)'], [/\/dev\/null/, '/dev/null (no such path on Windows)'],
  [/(?:^|[;\s])export\s+[A-Za-z_]\w*=/, '`export VAR=` (POSIX)'], [/^\s*[A-Za-z_]\w*=\S*\s+\S/, 'VAR=value (POSIX)'],
  [/\bif\s+\[|;\s*then\b|\bfi\b|\bdone\b|\besac\b/, 'POSIX shell control syntax'],
  [/\|\s*(?:grep|sed|awk|xargs)\b/, 'a pipe into a POSIX tool'], [/(?:^|\s)~\//, '~/ (not expanded by PowerShell)']];
const PLUGIN_VAR = /^\$\{(?:CLAUDE_|COPILOT_)?PLUGIN_(?:ROOT|DATA)\}$|^\$(?:HOME|true|false|null)$/i;

/** Reasons a Copilot `command` string would not run the same in bash and PowerShell (it is copied to both). */
function crossShellProblems(s) {
  const out = new Set(XS.filter(([re]) => re.test(s)).map(([, why]) => why));
  const v = s.match(/\$\{[^}]*\}|\$[A-Za-z_]\w*/g)?.find((t) => !PLUGIN_VAR.test(t));
  if (v) out.add(`${v} (a variable in both shells)`);
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q === "'") { if (ch === "'") q = null; continue; }
    if (q === '"' && ch === '\\' && /["\\$`]/.test(s[i + 1] || '')) out.add('a backslash escape inside double quotes');
    if (!q && ch === '\\') out.add('a backslash outside quotes (escape in bash, path separator in PowerShell)');
    if (ch === '`') out.add('a backtick (substitution in bash, escape in PowerShell)');
    if (q === '"' && ch === '"') q = null;
    else if (!q && (ch === "'" || ch === '"')) q = ch;
  }
  return [...out];
}

const UNPINNED = [[/\bnpx\s+(?:--yes\s+|-y\s+)(?:--?[\w-]+\s+)*(@?[\w./-]+?)(?=\s|$)/, (p) => /@\d/.test(p.slice(1))],
  [/\bnpx\s+[^\n]*@latest\b/], [/\buvx\s+(?!--from)([\w.-]+)(?=\s|$)/, (p) => /==|@\d/.test(p)],
  [/\bdocker\s+run\b[^\n]*\s([\w./-]+:latest)\b/]];
/** The package a command runs without a pinned version (npx -y pkg, @latest, uvx pkg, image:latest), or null. */
const unpinned = (s) => UNPINNED.map(([re, ok]) => [re.exec(s), ok]).filter(([m, ok]) => m && !ok?.(m[1] || m[0]))
  .map(([m]) => m[1] || m[0])[0] || null;

// ---------------------------------------------------------------------------
// Discovery and classification

const under = (abs, dir) => abs === dir || abs.startsWith(dir.endsWith('/') ? dir : `${dir}/`);
const homes = (env, home) => Object.fromEntries(Object.entries(hostHomes({ env, home }))
  .map(([k, v]) => [k, toPosix(v)]));
const INSTRUCTION_FILES = { 'copilot-instructions.md': 'copilot-instructions copilot',
  'AGENTS.md': 'agents-md copilot claude codex', 'AGENTS.override.md': 'agents-override codex',
  'CLAUDE.md': 'claude-md claude copilot', 'CLAUDE.local.md': 'claude-local claude', 'GEMINI.md': 'gemini-md copilot' };
const SKILL_READERS = { claude: 'spec claude copilot', github: 'spec copilot', agents: 'spec copilot codex',
  codex: 'spec codex' };

/**
 * `{ kind, sub, scope, reads[], plugin? }` for a tooling file, or null. `reads` are the hosts that load it from
 * where it lies (plan §3.1): a skill in .claude/skills is read by Claude Code and Copilot, .github/skills by
 * Copilot, .agents/skills by Copilot and Codex; one anywhere else (a source tree, a plugin) by every host.
 * `sniff` classifies an explicitly named file outside the conventional locations by its content.
 */
function classify(absPath, { root = null, env = process.env, home, sniff = false } = {}) {
  const abs = toPosix(path.resolve(absPath));
  const b = path.posix.basename(abs);
  const parent = path.posix.basename(path.posix.dirname(abs));
  const H = homes(env, home);
  const user = under(abs, H.home) && [H.copilot, H.claude, H.codex, `${H.home}/.agents`].some((d) => under(abs, d));
  const res = (kind, sub, reads, extra) => ({ kind, sub, scope: user ? 'user' : 'project', reads: W(reads), ...extra });
  const has = (re) => re.test(abs);
  const up = (marker) => findUp(path.dirname(absPath), marker, { stopAt: root, maxDepth: 12 });
  const clPlugin = () => up(path.join('.claude-plugin', 'plugin.json'));
  const near = (n) => fs.existsSync(path.join(path.dirname(absPath), n));
  if (b.toLowerCase() === 'skill.md') {
    const d = path.posix.dirname(path.posix.dirname(abs));
    const at = { [`${H.claude}/skills`]: 'claude', [`${H.copilot}/skills`]: 'github', [`${H.codex}/skills`]: 'codex' }[d]
      || /(?:^|\/)\.(claude|github|agents|codex)\/skills$/.exec(d)?.[1];
    return res('skill', 'skill', SKILL_READERS[at] || 'spec copilot claude codex');
  }
  if (b === 'openai.yaml' && parent === 'agents' && fs.existsSync(path.join(absPath, '..', '..', 'SKILL.md'))) {
    return res('codex-skill-meta', 'openai-yaml', 'codex');
  }
  if (b.endsWith('.agent.md') || has(/(?:^|\/)(?:\.github|com\.github\.copilot)\/agents\/.+\.md$/)
    || under(abs, `${H.copilot}/agents`)) return res('agent', 'copilot', 'copilot codex');
  if (has(/(?:^|\/)\.claude\/agents\/.+\.md$/)) return res('agent', 'claude', 'claude copilot codex');
  if (b.endsWith('.md') && parent === 'agents' && clPlugin()) {
    return res('agent', 'claude', 'claude codex', { plugin: toPosix(clPlugin()) });
  }
  if (b.endsWith('.instructions.md')) return res('instructions', 'path-specific', 'copilot');
  if (INSTRUCTION_FILES[b]) return res('instructions', ...INSTRUCTION_FILES[b].split(/ (.*)/));
  if (has(/(?:^|\/)\.claude\/rules\/.+\.md$/)) return res('instructions', 'claude-rules', 'claude copilot');
  if (b.endsWith('.prompt.md')) return res('prompt', 'prompt', 'copilot');
  if (has(/(?:^|\/)\.claude\/commands\/.+\.md$/)) return res('command', 'claude-command', 'claude copilot');
  if (has(/(?:^|\/)\.github\/hooks\/[^/]+\.json$/)) return res('hooks', 'copilot', 'copilot');
  if (under(abs, `${H.copilot}/hooks`) && b.endsWith('.json')) {
    return res('hooks', 'copilot', 'copilot', { scope: 'user' });
  }
  if (has(/(?:^|\/)com\.github\.copilot\/hooks\/hooks\.json$/)) {
    return res('hooks', 'copilot', 'copilot', { plugin: toPosix(path.resolve(absPath, '..', '..', '..')) });
  }
  if (has(/(?:^|\/)\.codex\/hooks\.json$/) || abs === `${H.codex}/hooks.json`) return res('hooks', 'codex', 'codex');
  if (has(/(?:^|\/)\.claude\/settings(?:\.local)?\.json$/) || abs === `${H.claude}/settings.json`) {
    const u = abs === `${H.claude}/settings.json` || abs === `${H.claude}/settings.local.json`;
    return res('settings', 'claude', u ? 'claude' : 'claude copilot', { scope: u ? 'user' : 'project' });
  }
  if (has(/(?:^|\/)\.github\/copilot\/settings(?:\.local)?\.json$/) || abs === `${H.copilot}/settings.json`) {
    return res('settings', 'copilot', 'copilot');
  }
  if (b === 'hooks.json' && parent === 'hooks' && clPlugin()) {
    return res('hooks', 'claude-plugin', 'claude', { plugin: toPosix(clPlugin()) });
  }
  if (b === 'hooks.json' && up('plugin.json')) {
    return res('hooks', 'copilot', 'copilot', { plugin: toPosix(up('plugin.json')) });
  }
  if (has(/(?:^|\/)\.claude-plugin\/plugin\.json$/)) return res('plugin', 'claude', 'claude copilot');
  if (has(/(?:^|\/)\.codex-plugin\/plugin\.json$/)) return res('plugin', 'codex', 'codex');
  if (b === 'plugin.json' && /agent-plugins\.org/.test(String(parseJson(readNorm(absPath) || '').value?.$schema))) {
    return res('plugin', 'agent-plugins', 'copilot codex');
  }
  if (b === 'plugin.json' && (parent === '.plugin' || has(/(?:^|\/)\.github\/plugin\/plugin\.json$/) || sniff
    || near('skills'))) return res('plugin', 'copilot', 'copilot');
  if (has(/(?:^|\/)\.claude-plugin\/marketplace\.json$/)) return res('marketplace', 'claude', 'claude copilot codex');
  if (has(/(?:^|\/)\.agents\/plugins\/(?:api_)?marketplace\.json$/)) return res('marketplace', 'codex', 'codex');
  if (b === 'marketplace.json' && (parent === '.plugin' || has(/(?:^|\/)\.github\/plugin\/marketplace\.json$/)
    || sniff)) return res('marketplace', 'copilot', 'copilot');
  if (has(/(?:^|\/)\.vscode\/mcp\.json$/)) return res('mcp', 'vscode', 'copilot');
  if (b === '.mcp.json') return res('mcp', 'portable', 'copilot claude');
  if (has(/(?:^|\/)\.github\/mcp\.json$/) || b === 'mcp-config.json') return res('mcp', 'copilot', 'copilot');
  if (b === 'mcp.json' && near('plugin.json')) return res('mcp', 'agent-plugins', 'copilot codex');
  if (has(/(?:^|\/)\.codex\/config\.toml$/) || abs === `${H.codex}/config.toml`) {
    return res('codex-config', 'config', 'codex');
  }
  const text = sniff ? readNorm(absPath) : null;
  if (text == null) return null;
  const v = b.endsWith('.json') ? parseJson(text, { jsonc: true }).value : null;
  if (isObj(v?.hooks) && (own(v, 'version') || Object.keys(v.hooks).some((e) => CP_EVENTS.includes(e)))) {
    return res('hooks', 'copilot', 'copilot');
  }
  if (isObj(v?.hooks)) {
    return /"commandWindows"/.test(text) ? res('hooks', 'codex', 'codex') : res('hooks', 'claude-plugin', 'claude');
  }
  if (isObj(v?.servers)) return res('mcp', 'vscode', 'copilot');
  if (isObj(v?.mcpServers)) return res('mcp', 'portable', 'copilot claude');
  if (b.endsWith('.toml')) return res('codex-config', 'config', 'codex');
  return b.endsWith('.md') ? res('instructions', 'generic', 'copilot claude codex') : null;
}

const WALK_IGNORE = S(`.git node_modules .adc .venv venv __pycache__ target dist build obj .next .turbo .tox vendor
  coverage .cache`);

/** Tooling files under `dir`; linked folders are followed (a Claude Code skill folder may be a symlink). */
const discover = (dir, ctx) => listFiles(dir, { ignore: WALK_IGNORE, followSymlinks: true })
  .map((rel) => path.join(dir, ...rel.split('/'))).map((abs) => ({ abs, cls: classify(abs, ctx) }))
  .filter((x) => x.cls).map(({ abs, cls }) => ({ abs, ...cls }));

// ---------------------------------------------------------------------------
// Findings

const clip = (s) => truncate(redactSecrets(String(s)), 160);

class FileLint {
  constructor(run, abs, cls) {
    Object.assign(this, { run, abs, cls, path: run.display(abs), seen: new Set() });
    this.results = new Map(cls.reads.filter((h) => run.selected.includes(h))
      .map((h) => [h, { host: h, errors: [], warnings: [], notes: [] }]));
  }

  get text() { return (this.cached ??= readNorm(this.abs) || ''); }

  /** A finding for each selected host of the rule (`only` narrows them); the message defaults to the title. */
  emit(id, line, message, { field, evidence, only, severity, strictSeverity } = {}) {
    const rule = RULE_INDEX.get(id);
    if (!rule) throw new Error(`unknown lint rule ${id}`);
    const msg = redactSecrets(message ?? rule.title);
    const pick = (x, host) => (isObj(x) ? x[host] : x);
    for (const [host, def] of Object.entries(rule.hosts)) {
      const r = this.results.get(host);
      const key = `${host}|${id}|${line}|${msg}`;
      if (!r || (only && !only.includes(host)) || this.seen.has(key)) continue;
      this.seen.add(key);
      const sev = (this.run.strict && (pick(strictSeverity, host) || rule.strict?.[host])) || pick(severity, host) || def;
      r[{ error: 'errors', warning: 'warnings' }[sev] || 'notes'].push({ rule: id, line: line ?? null, message: msg,
        ...(field && { field }), ...(evidence && { evidence: clip(evidence) }) });
    }
  }

  sec(id, line, message, evidence) {
    const msg = redactSecrets(message ?? title(id));
    const key = `${id}|${this.path}|${line}|${msg}`;
    if (this.run.secSeen.has(key)) return;
    this.run.secSeen.add(key);
    this.run.security.push({ rule: id, severity: RULE_INDEX.get(id).severity, file: this.path, line: line ?? null,
      message: msg, ...(evidence && { evidence: clip(evidence) }) });
  }

  secrets(text, offset = 0, where = '') {
    for (const s of scanSecrets(text)) {
      this.sec('SEC-SECRET', s.line + offset, `secret-shaped value (${s.id})${where}; remove and rotate it`, s.redacted);
    }
  }

  unpinned(list, line, label) {
    const s = list.find((x) => unpinned(x));
    if (s) this.sec('SEC-UNPINNED', line, `${label}runs ${unpinned(s)} without a pinned version`, s);
  }

  /** `id` for each key of `obj` outside `known`; `L(key)` gives the line. */
  unknown(obj, known, id, L, what, { only, prefix = '' } = {}) {
    for (const k of Object.keys(obj).filter((x) => !known.has(x))) {
      this.emit(id, L(k), `${prefix}unknown ${what} "${k}"`, { field: k, only });
    }
  }

  toJSON() {
    const { kind, sub, scope, reads } = this.cls;
    return { path: this.path, kind, sub, scope, reads, host_results: [...this.results.values()] };
  }
}

// ---------------------------------------------------------------------------
// Markdown kinds: security text, skills, Codex sidecar, instructions, agents, commands, prompt files

const PIPE_SHELL = [/\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b/i, /\b(?:ba)?sh\s+<\(\s*(?:curl|wget)\b/i,
  /\b(?:iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^\n|]*\|\s*(?:iex|Invoke-Expression)\b/i,
  /\b(?:iex|Invoke-Expression)\s*\(?\s*\(?\s*(?:iwr|irm|Invoke-WebRequest|Invoke-RestMethod|New-Object\s+Net\.WebClient)/i];
const DISABLE_GUARDS = [/--dangerously-skip-permissions\b/, /--dangerously-bypass-approvals-and-sandbox\b/,
  /--(?:dangerously-)?bypass-hook-trust\b/, /(?:^|\s)--yolo\b/, /--allow-all-tools\b/, /(?:^|\s)--allow-all\b/,
  /\bCOPILOT_ALLOW_ALL\s*=\s*["']?true/i, /"?disableAllHooks"?\s*[:=]\s*true/, /\bbypassPermissions\b/,
  /\bdanger-full-access\b/, /approval_policy\s*=\s*["']?never/, /\bgit\s+commit\b[^\n]*--no-verify\b/];

function securityText(fl, text, offset = 0) {
  text.split('\n').forEach((l, i) => {
    const [line, g] = [i + 1 + offset, DISABLE_GUARDS.find((re) => re.test(l))];
    if (PIPE_SHELL.some((re) => re.test(l))) fl.sec('SEC-PIPE-SHELL', line, null, l.trim());
    if (/[A-Za-z0-9+/]{200,}={0,2}/.test(l)) fl.sec('SEC-BASE64', line);
    if (g) fl.sec('SEC-DISABLE-GUARDS', line, `turns off a safety control (${g.exec(l)[0].trim()})`, l.trim());
  });
  fl.secrets(text, offset);
}

/** `{ fm, data, L, body, offset }` of a Markdown file whose frontmatter is optional (YAML errors: MD-FM-YAML). */
function parts(fl) {
  const fm = fl.text.startsWith('---') ? parseFrontmatter(fl.text) : null;
  for (const e of fm?.errors || []) fl.emit('MD-FM-YAML', e.line, `frontmatter YAML: ${e.message}`);
  const has = Boolean(fm?.hasFrontmatter);
  return { fm, data: fm?.data || {}, L: (k) => fm?.keyLines?.[k] || null, body: has ? fm.body : fl.text,
    offset: has ? fm.bodyStartLine - 1 : 0 };
}

const XML_TAG = /<\/?[A-Za-z][\w:-]*(?:\s[^<>]*)?\/?>/;
const NOT_THIRD = new RegExp(`^\\s*(?:${['i', "i'm", 'i am', 'i can', 'i will', "i'll", 'we', "we'll", 'we can',
  'we will', 'my', 'our', 'let me', 'you can', 'you should', 'you will', 'you may', 'your'].join('|')})\\b`, 'i');
const SHELL_TOOL = /^(?:shell|bash|powershell|execute|\*)$|^(?:shell|bash|powershell)\(\s*(?:\*|\*:\*|:\*)?\s*\)$/i;
const STRICT_WHAT = { flow: 'a flow-style collection', anchor: 'the anchor', alias: 'the alias', tag: 'the tag' };
const SUBST = [[/\$ARGUMENTS\b/, () => '$ARGUMENTS works only in Claude Code; say "the text after the skill name"'],
  [/\$\{CLAUDE_(?:SKILL_DIR|PROJECT_DIR|SESSION_ID|EFFORT|PLUGIN_ROOT|PLUGIN_DATA)\}/, (m) => `${m[0]} works only in Claude`],
  [/(?:^|\s)!`[^`]+`|^\s*(?:`{3,}|~{3,})!/, () => 'dynamic context (!`cmd`) runs only in Claude Code']];

function lintSkill(fl) {
  const raw = fs.readFileSync(fl.abs, 'utf8').replace(/\r\n/g, '\n');
  const [dir, base] = [path.dirname(fl.abs), path.basename(fl.abs)];
  const dirName = path.basename(dir);
  const fm = parseFrontmatter(raw);
  const E = (id, line, msg, o) => fl.emit(id, line, msg, o);
  if (base !== 'SKILL.md') E('SK-FILENAME', null, `the file is named ${base}; hosts look for SKILL.md`);
  if (fm.bom) E('SK-FM-BOM', 1);
  if (!fm.hasFrontmatter) {
    E('SK-FM-LINE1', fm.lateOpenLine || 1, fm.lateOpenLine && `frontmatter starts on line ${fm.lateOpenLine}, not 1`);
  }
  for (const e of fm.errors) E('SK-FM-YAML', e.line, `frontmatter YAML: ${e.message}`);
  for (const w of fm.warnings) {
    if (w.code === 'UNQUOTED_COLON') E('SK-FM-COLON', w.line, w.message);
    else E('SK-FM-YAML', w.line, `frontmatter YAML: ${w.message}`, { severity: w.code !== 'RESERVED_INDICATOR' && 'warning' });
  }
  for (const c of fm.errors.length ? [] : fm.constructs) {
    const fix = c.kind === 'flow' ? 'write one "key: value" or "- item" per line' : 'write the value out in block style';
    E('SK-FM-STRICTYAML', c.line, `${STRICT_WHAT[c.kind]} ${c.text}${c.path ? ` in \`${c.path}\`` : ''}: skills-ref `
      + `(strictyaml) rejects it; ${fix}`, { field: c.path || undefined });
  }
  if (fm.hasFrontmatter && !fm.errors.length) skillFields(fl, fm.data, (k) => fm.keyLines[k] || null, dirName);
  if (/^(?:synced|anthropic-skills(?::.*)?)$/.test(dirName)) E('SK-NAME-CLAUDE-DIR', null, `"${dirName}" is reserved`);
  const body = fm.hasFrontmatter ? fm.body : raw;
  const offset = fm.hasFrontmatter ? fm.bodyStartLine - 1 : 0;
  const count = body.trim() ? body.replace(/\n+$/, '').split('\n').length : 0;
  const tokens = Math.ceil(body.length / 4);
  if (!count) E('SK-BODY-EMPTY', null);
  if (count > 500) E('SK-BODY-LINES', null, `the body has ${count} lines (keep it under 500; move detail to references/)`);
  if (tokens > 5000) E('SK-BODY-TOKENS', null, `the body is about ${tokens} tokens (keep it under 5,000)`);
  body.split('\n').forEach((l, i) => {
    for (const [re, msg] of SUBST) { const m = re.exec(l); if (m) E('SK-SUBST', i + 1 + offset, msg(m)); }
    // $N outside currency-like text ($1,845.00, $1k, $12.3M).
    const pos = /(?<![\\\w$])\$[0-9](?![0-9]|[.,]\d|[kKmMbB]\b)/.exec(l);
    if (pos) E('SK-SUBST-POSITIONAL', i + 1 + offset, `${pos[0]} becomes an argument in Claude Code; write \\${pos[0]}`);
  });
  skillStructure(fl, dir, body, offset);
  securityText(fl, body, offset);
  if (fm.raw) fl.secrets(fm.raw, 1, ' in the frontmatter');
}

function skillFields(fl, data, L, dirName) {
  const E = (id, key, msg, o) => fl.emit(id, L(key), msg, o);
  const { name, description: d, metadata: m, compatibility: c } = data;
  const n = String(name);
  const why = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(n) ? null : /[A-Z]/.test(n) ? 'uppercase letters' : /^-|-$/.test(n)
    ? 'a leading or trailing hyphen' : /--/.test(n) ? 'a double hyphen' : 'characters other than a-z, 0-9 and -';
  if (name === undefined || name === null || name === '') fl.emit('SK-NAME-REQUIRED', 1);
  else {
    if (typeof name !== 'string') E('SK-NAME-FORMAT', 'name', '`name` must be a string');
    if (n.length > 64) E('SK-NAME-LENGTH', 'name', `\`name\` has ${n.length} characters (max 64)`);
    if (why) E('SK-NAME-FORMAT', 'name', `\`name\` "${n}" has ${why}`);
    if (n.normalize('NFKC') !== dirName.normalize('NFKC')) E('SK-NAME-DIR', 'name', `"${n}" is not the folder "${dirName}"`);
    if (/claude|anthropic/i.test(n)) E('SK-NAME-RESERVED', 'name', `\`name\` "${n}" contains a reserved word`);
  }
  if (d === undefined || d === null || (typeof d === 'string' && !d.trim())) fl.emit('SK-DESC-REQUIRED', L('description') || 1);
  else if (typeof d !== 'string') E('SK-DESC-TYPE', 'description');
  else {
    const listing = d.length + (typeof data.when_to_use === 'string' ? data.when_to_use.length : 0);
    if (d.length > 1024) E('SK-DESC-LENGTH', 'description', `\`description\` has ${d.length} characters (max 1,024)`);
    if (listing > 1536) E('SK-DESC-LISTING', 'description', `description + when_to_use is ${listing} characters`);
    if (XML_TAG.test(d)) E('SK-DESC-XML', 'description', `\`description\` contains the tag ${XML_TAG.exec(d)[0]}`);
    if (NOT_THIRD.test(d)) E('SK-DESC-PERSON', 'description');
  }
  for (const key of Object.keys(data)) {
    if (!W(SPEC_FIELDS).includes(key)) E('SK-FIELD-NONSPEC', key, `"${key}" is not one of the six spec fields`, { field: key });
    for (const host of ['copilot', 'claude', 'codex'].filter((h) => !SKILL_FIELDS[h].has(key))) {
      E('SK-FIELD-IGNORED', key, `${LABEL[host]} does not read "${key}"`, { only: [host], field: key });
    }
  }
  if (m !== undefined && m !== null && !isObj(m)) E('SK-METADATA-MAP', 'metadata');
  for (const [k, v] of Object.entries(isObj(m) ? m : {})) {
    // Install provenance (gh skill install) is not authored data and is stripped on publish.
    if (INSTALL_METADATA_KEY.test(k) || typeof v === 'string') continue;
    const type = v === null ? 'null' : Array.isArray(v) ? 'list' : typeof v;
    E('SK-METADATA-STRING', `metadata.${k}`, `\`metadata.${k}\` is a ${type}; quote it`, { field: `metadata.${k}` });
  }
  const sd = String(m?.['short-description'] ?? '');
  if (own(m, 'short-description') && (sd.length < 25 || sd.length > 64)) {
    E('SK-SHORTDESC', 'metadata.short-description', `\`metadata.short-description\` has ${sd.length} characters (25-64)`);
  }
  if (own(data, 'compatibility') && (typeof c !== 'string' || c.length < 1 || c.length > 500)) {
    E('SK-COMPAT-LENGTH', 'compatibility', typeof c === 'string' ? `\`compatibility\` has ${c.length} characters` : null);
  }
  if (!own(data, 'allowed-tools')) return;
  const at = data['allowed-tools'];
  const tokens = (Array.isArray(at) ? at.map(String) : String(at ?? '').split(/[\s,]+/)).map((t) => t.trim())
    .filter(Boolean);
  const wide = tokens.filter((t) => SHELL_TOOL.test(t));
  if (Array.isArray(at)) E('SK-ALLOWED-TOOLS-TYPE', 'allowed-tools');
  if (wide.length) {
    fl.sec('SEC-ALLOWED-TOOLS', L('allowed-tools'), `allowed-tools pre-approves ${wide.join(', ')} for every user of this `
      + 'skill; keep it only for trusted, first-party skills', tokens.join(' '));
  }
}

/** Links, references and footprint (as Copilot lists it: node_modules, bin, obj and dist are hidden). */
function skillStructure(fl, dir, body, offset) {
  const linked = new Set();
  const rel = (p) => toPosix(path.relative(dir, p));
  // A plain or backticked mention of the path also tells the model to read the file.
  for (const m of body.matchAll(/(?:^|[\s`'"(/{}])(references\/[\w./-]+\.\w+)/g)) linked.add(path.resolve(dir, m[1]));
  for (const { line: n, target } of markdownLinks(body)) {
    const [line, t] = [n + offset, linkPath(target)];
    const [abs, r] = [path.resolve(dir, t), rel(path.resolve(dir, t))];
    const bad = target.includes('\\') ? ['SK-LINK-BACKSLASH', 'uses backslashes; use forward slashes']
      : /^[/~]/.test(t) || WIN_ABS.test(t) || /^file:/i.test(target) ? ['SK-LINK-ABSOLUTE', 'is an absolute local path']
        : r.startsWith('..') ? ['SK-LINK-ABSOLUTE', 'leaves the skill folder (not installed with it)'] : null;
    if (isExternalLink(target) || !t) continue;
    if (bad) { fl.emit(bad[0], line, `link "${target}" ${bad[1]}`); continue; }
    if (!fs.existsSync(abs)) fl.emit('SK-LINK-MISSING', line, `link target ${r} does not exist`);
    else linked.add(abs);
    if (/^references\/.+\//.test(r)) fl.emit('SK-REF-DEPTH', line, `${r} is nested below references/`);
  }
  const refDir = path.join(dir, 'references');
  const others = statOrNull(refDir)?.isDirectory() ? fs.readdirSync(refDir).map((n) => path.join(refDir, n)) : [];
  const mentions = (o, name) => ((t) => t.includes(`references/${name}`)
    || new RegExp(`(?:^|[\\s(\\[\`'"/])${RegExp.escape(name)}\\b`).test(t))(readNorm(o) || '');
  const walkRefs = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      const via = !e.isDirectory() && !linked.has(full)
        && others.find((o) => o !== full && statOrNull(o)?.isFile() && mentions(o, e.name));
      if (e.isDirectory()) fl.emit('SK-REF-DEPTH', null, `${rel(full)}/ nests references more than one level deep`);
      if (e.isDirectory()) walkRefs(full);
      else if (!linked.has(full)) {
        fl.emit('SK-REF-UNLINKED', null, via ? `${rel(full)} is linked only from ${rel(via)}; link it from SKILL.md `
          + '(hosts follow references one level deep)' : `${rel(full)} is not linked from SKILL.md`);
      }
    }
  };
  if (others.length) walkRefs(refDir);
  let files = 0;
  const HIDDEN = S('.git node_modules bin obj dist');
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }).filter((e) => !HIDDEN.has(e.name)); } catch { return; }
    if (entries.length > 50) fl.emit('SK-FOOTPRINT-FOLDER', null, `${rel(d) || '.'}/ has ${entries.length} entries`);
    for (const e of entries) {
      const full = path.join(d, e.name);
      const size = e.isFile() ? statOrNull(full)?.size || 0 : 0;
      if (e.isDirectory()) walk(full);
      if (e.isFile()) files++;
      if (size > 5 * 1024 * 1024) fl.emit('SK-ASSET-SIZE', null, `${rel(full)} is ${(size / 1048576).toFixed(1)} MB`);
    }
  };
  walk(dir);
  if (files > 100) fl.emit('SK-FOOTPRINT-FILES', null, `the skill folder has ${files} files`);
}

function lintOpenaiYaml(fl) {
  const doc = parseYamlDocument(fl.text);
  const v = doc.value;
  const L = (k) => doc.keyLines[k] || null;
  const E = (id, key, msg) => fl.emit(id, L(key), msg);
  for (const e of doc.errors) fl.emit('CX-YAML-PARSE', e.line, `agents/openai.yaml: ${e.message}`);
  if (doc.errors.length) return;
  if (!isObj(v)) return fl.emit('CX-YAML-PARSE', 1, 'agents/openai.yaml must be a mapping');
  fl.unknown(v, S('interface dependencies policy'), 'CX-YAML-FIELD', L, 'key');
  const skillDir = path.dirname(path.dirname(fl.abs));
  const fmName = parseFrontmatter(readNorm(path.join(skillDir, 'SKILL.md')) || '').data?.name;
  const name = typeof fmName === 'string' ? fmName : path.basename(skillDir);
  const { interface: ui, policy, dependencies } = v;
  const sd = ui?.short_description === undefined ? null : String(ui.short_description);
  const tools = isObj(dependencies) ? dependencies.tools : undefined;
  const allow = isObj(policy) ? policy.allow_implicit_invocation : undefined;
  if (ui !== undefined && !isObj(ui)) E('CX-YAML-FIELD', 'interface', '`interface` must be a mapping');
  if (isObj(ui)) {
    const known = S('display_name short_description icon_small icon_large brand_color default_prompt');
    fl.unknown(ui, known, 'CX-YAML-FIELD', (k) => L(`interface.${k}`), 'key', { prefix: 'interface: ' });
    if (sd !== null && (sd.length < 25 || sd.length > 64)) {
      E('CX-YAML-SHORTDESC', 'interface.short_description', `short_description has ${sd.length} characters (25-64)`);
    }
    if (ui.default_prompt !== undefined && !String(ui.default_prompt).includes(`$${name}`)) {
      E('CX-YAML-PROMPT', 'interface.default_prompt', `default_prompt should mention $${name}`);
    }
    if (ui.brand_color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(String(ui.brand_color))) {
      E('CX-YAML-FIELD', 'interface.brand_color', 'brand_color is a #RRGGBB color');
    }
  }
  if (allow !== undefined && typeof allow !== 'boolean') E('CX-YAML-POLICY', 'policy.allow_implicit_invocation');
  if (isObj(policy) && policy.products !== undefined && !Array.isArray(policy.products)) {
    E('CX-YAML-FIELD', 'policy.products', '`policy.products` must be a list');
  }
  if (tools !== undefined && !Array.isArray(tools)) E('CX-YAML-DEPS', 'dependencies.tools', 'tools must be a list');
  for (const [i, t] of (Array.isArray(tools) ? tools : []).entries()) {
    if (isObj(t) && t.type === 'mcp' && t.value) continue;
    fl.emit('CX-YAML-DEPS', L(`dependencies.tools[${i}].type`) || L('dependencies.tools'), `dependencies.tools[${i}]`
      + ' needs type: mcp and a value');
  }
}

function globProblem(g) {
  if (typeof g !== 'string' || !g.trim()) return 'an empty pattern';
  if (g.includes('\\')) return 'a backslash (use forward slashes)';
  if (/^[/~]/.test(g) || WIN_ABS.test(g)) return 'an absolute path (globs are relative to the repository root)';
  let [brace, bracket] = [0, 0];
  for (const ch of g) {
    brace += { '{': 1, '}': -1 }[ch] || 0;
    bracket += { '[': 1, ']': -1 }[ch] || 0;
    if (brace < 0 || bracket < 0) return 'unbalanced braces or brackets';
  }
  if (brace || bracket) return 'unbalanced braces or brackets';
  try { globToRegExp(g); } catch { return 'a pattern that does not compile'; }
  return null;
}

const NOT_USER = `(?!(?:<|\\{|\\$|%|${W('USER user username you your YOUR me name runner runneradmin example')
  .join('\\b|')}\\b|\\.\\.\\.))`;
const USER_PATH = [new RegExp(`(?:^|[\\s"'(=:])(\\/(?:Users|home)\\/${NOT_USER}[A-Za-z0-9._-]+)`),
  new RegExp(`(?:^|[\\s"'(=])([A-Za-z]:\\\\(?:Users|Documents and Settings)\\\\${NOT_USER}[A-Za-z0-9._ -]+)`, 'i')];
const INTERNAL_HOST = new RegExp('(?:^|[\\s"\'(@/=])((?:[a-z0-9-]+\\.)+(?:internal|corp|intranet|intra|lan|local|private'
  + '|home\\.arpa))(?![\\w.-])', 'i');
const PRIVATE_IP = /(?:^|[^\d.])((?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3})(?![\d.])/;
const IMPORT_RE = /(?:^|\s)@((?:\.{1,2}\/|~\/|\/)?[\w.-]+(?:\/[\w.-]+)*\.(?:md|mdc|txt|json|ya?ml|toml))(?=$|[\s,;:)\]])/g;
const POSIX_ONLY = new RegExp(`(?:^|[\\s;|&(])(?:${['export\\s+\\w+=', 'rm\\s+-[a-z]*r[a-z]*f', 'chmod\\s', 'chown\\s',
  'ln\\s+-s', 'source\\s', 'sudo\\s', 'grep\\s', 'sed\\s', 'awk\\s', 'xargs\\s', 'cp\\s+-[a-zA-Z]*R', 'ls\\s+-l',
  'cat\\s+<<', '\\$\\(', '\\/dev\\/null', 'mkdir\\s+-p\\s'].join('|')})`);
const SHELL_LANGS = S('bash sh shell zsh console shellsession terminal');
const WIN_LANGS = S('powershell pwsh ps1 ps cmd bat batch dos');
// The hosts that expand @imports per file kind (Codex AGENTS.md has none).
const EXPANDS = { 'agents-md': ['copilot', 'claude'], 'claude-md': ['copilot', 'claude'], 'claude-local': ['claude'],
  'copilot-instructions': ['copilot'], 'claude-rules': ['claude'] };
// Frontmatter of path-specific files: [host, glob keys, known keys].
const FM_KEYS = { 'path-specific': ['copilot', 'applyTo', S('applyTo excludeAgent name description')],
  'claude-rules': ['claude', 'paths applyTo', S('paths applyTo description name')] };

function lintInstructions(fl) {
  const sub = fl.cls.sub;
  if (!fl.text.trim()) return fl.emit('IN-EMPTY', null);
  const { data, L, body, offset } = parts(fl);
  const [host, globKeys, known] = FM_KEYS[sub] || [];
  for (const key of host ? W(globKeys).filter((k) => own(data, k)) : []) {
    const v = data[key];
    for (const g of Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [v]) {
      const p = globProblem(typeof g === 'string' ? g.trim() : g);
      if (p) fl.emit('IN-APPLYTO-GLOB', L(key), `${key} pattern "${g}" has ${p}`, { only: host === 'copilot' && [host] });
    }
  }
  if (host) fl.unknown(data, known, 'IN-FIELD', L, 'frontmatter key', { only: [host] });
  if (sub === 'path-specific' && !own(data, 'applyTo')) fl.emit('IN-APPLYTO-MISSING', 1);
  for (const v of sub === 'path-specific' && own(data, 'excludeAgent') ? [data.excludeAgent].flat() : []) {
    if (!['code-review', 'cloud-agent'].includes(v)) fl.emit('IN-EXCLUDEAGENT', L('excludeAgent'), `excludeAgent "${v}"`);
  }
  const lines = body.replace(/\n+$/, '').split('\n').length;
  if (lines > 1000) fl.emit('IN-LENGTH', null, `${lines} lines; Copilot guidance is under about 1,000`);
  if (sub === 'claude-md' && lines > 200) fl.emit('IN-CLAUDE-LENGTH', null, `CLAUDE.md has ${lines} lines`);
  const ml = markdownLines(body);
  let [posix, windows] = [null, false];
  for (const l of ml) {
    const line = l.n + offset;
    const p = USER_PATH.map((re) => re.exec(l.raw)).find(Boolean);
    const [h, ip] = [INTERNAL_HOST.exec(l.raw), PRIVATE_IP.exec(l.raw)];
    if (p) fl.emit('IN-ABS-PATH', line, `user-specific path ${p[1]}; use a relative path or a placeholder`, { evidence: p[1] });
    if (h && !/\.(?:md|mdc|json|ya?ml)$/i.test(h[1])) fl.emit('IN-HOSTNAME', line, `internal hostname ${h[1]}`, { evidence: h[1] });
    if (ip) fl.emit('IN-HOSTNAME', line, `private IP address ${ip[1]}`, { evidence: ip[1] });
    windows ||= Boolean(l.fenceStart && WIN_LANGS.has(l.lang.toLowerCase()));
    const shell = l.code && !l.fenceStart && !l.fenceEnd && SHELL_LANGS.has(l.lang.toLowerCase());
    if (!posix && shell && POSIX_ONLY.test(l.raw)) posix = { line, raw: l.raw };
    for (const m of l.code ? [] : l.prose.matchAll(IMPORT_RE)) importCheck(fl, m[1], line);
  }
  if (posix && !windows) fl.emit('IN-BASH-ONLY', posix.line, null, { evidence: posix.raw.trim() });
  securityText(fl, body, offset);
  if (['agents-md', 'claude-md', 'copilot-instructions', 'gemini-md'].includes(sub)
    || (sub === 'path-specific' && ['**', '**/*', '*'].includes(String(data.applyTo ?? '').trim()))) {
    fl.run.directives.push({ fl, items: directives(ml, offset), dir: path.dirname(fl.abs) });
  }
  siblingChecks(fl);
}

function importCheck(fl, target, line) {
  const sub = fl.cls.sub;
  const home = target.startsWith('~/');
  const resolved = home ? path.join(fl.run.home, target.slice(2)) : path.resolve(path.dirname(fl.abs), target);
  const file = { 'gemini-md': 'GEMINI.md', 'path-specific': '*.instructions.md' }[sub];
  if (file) fl.emit('IN-IMPORT-UNSUPPORTED', line, `@${target}: Copilot does not expand imports in ${file}`, { only: ['copilot'] });
  if (sub === 'agents-md' || sub === 'agents-override') {
    fl.emit('IN-IMPORT-UNSUPPORTED', line, `@${target}: Codex has no @import; the model sees the text`, { only: ['codex'] });
  }
  if (/^~?\//.test(target)) fl.emit('IN-IMPORT-ABSOLUTE', line, `@${target} is absolute or home-relative`);
  if (EXPANDS[sub] && !fs.existsSync(resolved)) fl.emit('IN-IMPORT-MISSING', line, `@${target} does not exist`, { only: EXPANDS[sub] });
}

/** Normalized directive sentences of a Markdown body (for the duplicate and contradiction checks). */
function directives(ml, offset) {
  const out = [];
  for (const l of ml) {
    const t = l.raw.trim();
    if (l.code || !t || /^#{1,6}\s/.test(t) || t.startsWith('|') || t.startsWith('<!--') || /^@\S+$/.test(t)) continue;
    const plain = t.replace(/^(?:>\s*)?(?:[-*+]|\d+[.)])\s+/, '').replace(/^\[[ xX]\]\s+/, '')
      .replace(/`([^`]*)`/g, '$1').replace(/\*\*|__/g, '').replace(/(^|\s)[*_]([^*_]+)[*_](?=\s|$|[.,;:])/g, '$1$2');
    for (const sentence of plain.split(/(?<=[.!?])\s+(?=[A-Z])/)) {
      const norm = sentence.toLowerCase().replace(/\s+/g, ' ').replace(/[.;:!]+$/, '').trim();
      if (norm.split(' ').length >= 3) out.push({ line: l.n + offset, norm, raw: sentence.trim() });
    }
  }
  return out;
}

const words = (s) => `(?:${W(s).join('|')})`;
const NEG_RE = /^(?:do not|don't|dont|never|avoid|must not|should not|shouldn't|no need to)\s+(.+)$/;
const POS_RE = /^(?:always|must|you must|please)\s+(.+)$/;
const VERB_RE = new RegExp(`^${words(`use run prefer write add keep commit call install put place name format indent
  import return throw log test create edit update include mention enable disable set wrap push merge rebase`)}\\b`);
const LANG_WORD = new RegExp(`\\b${words(`typescript javascript python golang go rust java c# csharp yaml json markdown
  css scss html ts js py tsx jsx ruby php shell bash powershell sql xml kotlin swift scala terraform makefile dockerfile
  tests?`)}\\b`);
const INDENT_RE = new RegExp('\\b(\\d+)[- ]spaces?\\b[^.]*\\bindent|\\bindent(?:ation|ed)?\\b[^.]*?\\b(\\d+)\\s*spaces?'
  + '\\b|\\bindent(?:ation)?\\s+(?:with|using)\\s+(tabs)\\b|\\b(tabs)\\s+for\\s+indentation\\b');
const PM_RE = /\b(?:use|prefer|always use|run|install with)\s+(npm|pnpm|yarn|bun)\b/;

function facets(norm) {
  const neg = NEG_RE.exec(norm)?.[1];
  const ind = !LANG_WORD.test(norm) && INDENT_RE.exec(norm);
  return { neg, pos: neg ? null : POS_RE.exec(norm)?.[1] || (VERB_RE.test(norm) ? norm : null),
    indent: ind && (ind[1] || ind[2] || 'tabs'), pm: !neg && PM_RE.exec(norm)?.[1] };
}

const conflict = (f, d, p, at) => ((f.neg && f.neg === p.f.pos) || (f.pos && f.pos === p.f.neg)
  ? `"${d.raw}" contradicts "${p.d.raw}"` : f.indent && p.f.indent && f.indent !== p.f.indent
    ? `indentation ${f.indent} here, ${p.f.indent} at ${at}` : f.pm && p.f.pm && f.pm !== p.f.pm
      ? `package manager ${f.pm} here, ${p.f.pm} at ${at}` : null);

/** Duplicates and contradictions across always-on instruction files that load together. */
function crossInstructionChecks(run) {
  // Nested AGENTS.md files refine their parent on purpose: compare the files that load together at the root.
  const groups = Map.groupBy(run.directives, (e) => (toPosix(path.relative(run.root, e.dir)).split('/')[0] === '.github'
    || path.resolve(e.dir) === run.root ? 'root' : e.dir));
  for (const entries of groups.values()) {
    const [seen, prior] = [new Map(), []];
    for (const { fl, items } of entries) {
      const both = (other) => fl.cls.reads.filter((h) => other.cls.reads.includes(h));
      for (const d of items) {
        const f = facets(d.norm);
        const long = d.norm.split(' ').length >= 5;
        const prev = long && seen.get(d.norm);
        const hit = prior.map((p) => [p, `${p.fl.path}:${p.d.line}`]).find(([p, at]) => conflict(f, d, p, at));
        if (prev && prev.fl !== fl) {
          fl.emit('IN-DUPLICATE', d.line, `same directive as ${prev.fl.path}:${prev.line}`, { only: both(prev.fl), evidence: d.raw });
        } else if (long && !prev) seen.set(d.norm, { fl, line: d.line });
        if (hit) fl.emit('IN-CONFLICT', d.line, `${conflict(f, d, ...hit)} (${hit[1]})`, { only: both(hit[0].fl) });
        prior.push({ fl, d, f });
      }
    }
  }
}

function siblingChecks(fl) {
  const [dir, sub] = [path.dirname(fl.abs), fl.cls.sub];
  const exists = (n) => fs.existsSync(path.join(dir, n));
  if (sub === 'claude-local' && exists('AGENTS.md') && !exists('CLAUDE.md')) fl.emit('IN-CLAUDE-LOCAL', null);
  if (sub === 'claude-md' && exists('AGENTS.md') && !/(?:^|\s)@(?:\.\/)?AGENTS\.md\b/.test(fl.text)) {
    fl.emit('IN-CLAUDE-AGENTS', null);
  }
  if (sub !== 'agents-md' && sub !== 'agents-override') return;
  // Codex concatenates one file per directory from the project root down to this one.
  const rel = path.relative(fl.run.root, dir);
  const dirs = !rel || rel.startsWith('..') || path.isAbsolute(rel) ? [dir]
    : rel.split(path.sep).reduce((a, seg) => [...a, path.join(a.at(-1), seg)], [fl.run.root]);
  const files = dirs.map((d) => ['AGENTS.override.md', 'AGENTS.md'].map((n) => path.join(d, n))
    .find((p) => statOrNull(p)?.size > 0)).filter(Boolean).map((f) => [f, statOrNull(f).size]);
  const total = files.reduce((n, [, size]) => n + size, 0);
  if (total > 32 * 1024) {
    fl.emit('IN-AGENTS-BUDGET', null, `Codex loads ${total} bytes of AGENTS files here (budget 32,768): `
      + files.map(([f, size]) => `${toPosix(path.relative(fl.run.root, f))} ${size} B`).join(', '));
  }
}

// Copilot agent fields some surfaces ignore ('' = a note: VS Code and IDE agents ignore it).
const SURFACE = { handoffs: 'VS Code-only; the cloud agent ignores it', 'argument-hint': 'VS Code-only; the cloud '
  + 'agent ignores it', infer: 'retired; use disable-model-invocation', 'mcp-servers': '', metadata: '' };

function lintAgent(fl) {
  const { fm, data, L, body, offset } = parts(fl);
  const [host, base, name] = [fl.cls.sub, path.basename(fl.abs), data.name];
  const E = (id, key, msg, o) => fl.emit(id, L(key), msg, { field: key, ...o });
  if (!fm?.hasFrontmatter) fl.emit('AG-FM-MISSING', 1);
  fl.emit('AG-CODEX', null);
  if (fm?.hasFrontmatter && !fm.errors.length) {
    if (String(data.description ?? '').trim() === '') fl.emit('AG-DESC-REQUIRED', 1);
    fl.unknown(data, AGENT_FIELDS[host], 'AG-FIELD', L, 'agent field', { only: [host] });
    for (const [k, vals] of Object.entries(AGENT_ENUMS[host])) {
      if (own(data, k) && !vals.includes(data[k])) E('AG-ENUM', k, `${k} "${data[k]}" is not one of ${vals.join(', ')}`, { only: [host] });
    }
    if (host === 'copilot') copilotAgent(fl, data, L, body, base);
    else if (name === undefined || name === null || name === '') fl.emit('AG-NAME-REQUIRED', 1);
    else if (String(name).length > 256 || String(name).includes(':')) E('AG-NAME-FORMAT', 'name');
    for (const k of host === 'claude' && fl.cls.plugin ? W('hooks mcpServers permissionMode initialPrompt') : []) {
      if (own(data, k)) E('AG-PLUGIN-FIELDS', k, `plugin subagents ignore "${k}"`);
    }
  }
  securityText(fl, body, offset);
}

function copilotAgent(fl, data, L, body, base) {
  if (!/^[.\-_a-zA-Z0-9]+$/.test(base)) fl.emit('AG-FILENAME', null, `file name "${base}" has other characters`);
  if (body.length > 30000) fl.emit('AG-BODY-LENGTH', null, `the agent prompt has ${body.length} characters (max 30,000)`);
  for (const k of Object.keys(data).filter((x) => x in SURFACE)) {
    fl.emit('AG-FIELD-SURFACE', L(k), `"${k}" is ${SURFACE[k] || 'read by Copilot CLI and the cloud agent; VS Code and '
      + 'IDE agents ignore it'}`, { field: k, severity: !SURFACE[k] && 'note' });
  }
  const tools = data.tools == null ? [] : Array.isArray(data.tools) ? data.tools : String(data.tools).split(',');
  for (const t of tools.map((x) => String(x).trim())) {
    if (t && !CP_TOOL_ALIASES.has(t) && !/^[\w.-]+\/(?:\*|[\w.-]+)$/.test(t)) fl.emit('AG-TOOLS', L('tools'), `tool "${t}"`);
  }
}

function lintCommandOrPrompt(fl) {
  const { data, L, body, offset } = parts(fl);
  if (fl.cls.kind === 'command') {
    fl.emit('CM-LEGACY', null);
    for (const k of Object.keys(data).filter((x) => x === 'name' || x === 'paths')) {
      fl.emit('CM-FIELD', L(k), `command files do not accept "${k}" (the file name is the command)`, { field: k });
    }
    fl.unknown(data, new Set([...SKILL_FIELDS.claude, 'name', 'paths']), 'CM-FIELD', L, 'command field');
  } else {
    fl.emit('PR-HARNESS', null);
    fl.unknown(data, S('description name argument-hint agent model tools mode'), 'PR-FIELD', L, 'prompt-file field');
  }
  securityText(fl, body, offset);
}

// ---------------------------------------------------------------------------
// Hooks (Copilot, Claude Code, Codex)

const EXT = '\\.(?:mjs|cjs|js|ts|py|sh|ps1|rb|pl)\\b';
const ROOT_VAR = '(?:PLUGIN_ROOT|COPILOT_PLUGIN_ROOT|CLAUDE_PLUGIN_ROOT)';
const SCRIPT = new RegExp(`(?:\\$\\{?(?:${ROOT_VAR.slice(3, -1)}|CLAUDE_PROJECT_DIR)\\}?[\\\\/])?[\\w.@~\${}\\\\/-]*[\\w-]${EXT}`, 'g');
const CP_SCRIPT = new RegExp(`(\\$\\{?${ROOT_VAR}\\}?|\\$env:${ROOT_VAR}|\\$\\{?PLUGIN_DATA\\}?)?`
  + `([\\\\/]?[\\w.@~-][\\w.@~\\\\/-]*${EXT})`, 'g');
const WRITES = '(?:>>?|\\btee\\s+(?:-a\\s+)?)\\s*["\']?';
const WRITE_CALL = '(?:writeFile|appendFile|createWriteStream|mkdir)\\w*\\([^\\n]*';
const CP_WRITES_ROOT = new RegExp(`(?:${WRITES}|\\b(?:Out-File|Set-Content)\\b[^\\n]*\\s*["']?)(?:\\$\\{?|\\$env:)`
  + `${ROOT_VAR}|${WRITE_CALL}${ROOT_VAR}`);
const CL_WRITES_ROOT = new RegExp(`${WRITES}\\$\\{?CLAUDE_PLUGIN_ROOT|${WRITE_CALL}CLAUDE_PLUGIN_ROOT`
  + '|open\\([^\\n]*CLAUDE_PLUGIN_ROOT[^\\n]*["\'][wa]');
const ASK = /permissionDecision["']?\s*[:=]\s*["']ask["']/;
const EXIT2 = new RegExp(['process\\.exit\\(\\s*2\\s*\\)', 'process\\.exitCode\\s*=\\s*2\\b', '(?:^|[\\s;&|])exit\\s+2\\b',
  'sys\\.exit\\(\\s*2\\s*\\)', '\\[Environment\\]::Exit\\(\\s*2\\s*\\)'].join('|'));
const ROOTED = new RegExp(`^\\$\\{?${ROOT_VAR}\\}?`);
const tail = (p) => p.replace(/^\$\{?[A-Z_]+\}?[\\/]/, '');

/** Local script files a hook command refers to, read for output-shape and exit-code checks: [{ file, text }]. */
function scriptsOf(fl, list, baseDir, pluginRoot = null) {
  return list.flatMap((s) => [...s.matchAll(SCRIPT)].map((m) => m[0].replace(/^["']|["']$/g, '')))
    .map((p) => (ROOTED.test(p) ? pluginRoot && path.join(pluginRoot, tail(p)) : /^\$\{?CLAUDE_PROJECT_DIR\}?/.test(p)
      ? path.join(fl.run.root, tail(p)) : /[<$]/.test(p) ? null : path.resolve(baseDir, p)))
    .filter((p) => p && statOrNull(p)?.isFile() && statOrNull(p).size < 512 * 1024)
    .map((file) => ({ file, text: readNorm(file) || '' }));
}
const anyText = (list, scripts, re) => list.some((s) => re.test(s)) || scripts.some((s) => re.test(s.text));

function httpSecurity(fl, line, url) {
  let u = null;
  try { u = new URL(String(url)); } catch {}
  if (u && !fl.run.allowHosts.has(u.hostname)) {
    fl.sec('SEC-HTTP-HOOK', line, `HTTP hook sends payloads to ${u.hostname}, which is not on the allowlist (--allow-host)`,
      u.origin);
  }
}

function lintCopilotHooks(fl, v, text, inline = false) {
  if (!isObj(v)) return fl.emit('HK-CP-SHAPE', 1, 'the hooks file must be a JSON object');
  const L = (k) => keyLine(text, k);
  if (!inline && !own(v, 'version')) fl.emit('HK-CP-VERSION-MISSING', 1);
  else if (!inline && v.version !== 1) fl.emit('HK-CP-VERSION', L('version'), `"version" is ${JSON.stringify(v.version)}`);
  if (!inline) fl.unknown(v, S('version disableAllHooks hooks description $schema'), 'HK-CP-FIELD', L, 'top-level key');
  if (!inline && v.disableAllHooks === true) fl.emit('HK-CP-DISABLED', L('disableAllHooks'));
  if (!isObj(v.hooks)) return fl.emit('HK-CP-SHAPE', L('hooks') || 1, '"hooks" must map event names to arrays');
  const cloud = /(?:^|\/)\.github\/hooks\//.test(toPosix(fl.abs));
  const cases = { camel: [], pascal: [] };
  for (const [event, entries] of Object.entries(v.hooks)) {
    const line = L(event);
    const E = (id, msg) => fl.emit(id, line, msg);
    const kind = CP_EVENTS.includes(event) ? 'camel' : [...CP_EVENTS_PASCAL, ...CP_EVENTS_UNDOC].includes(event) && 'pascal';
    if (!kind) { E('HK-CP-EVENT', `"${event}" is not a Copilot event${guess([...CP_EVENTS, ...CP_EVENTS_PASCAL], event)}`); continue; }
    cases[kind].push(event);
    if (CP_EVENTS_UNDOC.includes(event)) E('HK-CP-EVENT-UNDOC', `"${event}": use ${event[0].toLowerCase()}${event.slice(1)}`);
    if (!Array.isArray(entries)) { E('HK-CP-SHAPE', `"${event}" must be an array of hook entries`); continue; }
    if (cloud && /^(?:notification|[pP]ermissionRequest)$/.test(event)) E('HK-CP-CLOUD-EVENT', `${event}: ${title('HK-CP-CLOUD-EVENT')}`);
    if (CP_OUTPUT_IGNORED.has(event)) E('HK-CP-OUTPUT-IGNORED', `Copilot ignores the output of ${event} command hooks`);
    for (const entry of entries) {
      if (!isObj(entry)) E('HK-CP-SHAPE', `${event}: every entry must be an object`);
      else if (!Array.isArray(entry.hooks)) copilotEntry(fl, event, entry, line, cloud, false);
      else {
        copilotMatcher(fl, entry.matcher, line);
        for (const h of entry.hooks) copilotEntry(fl, event, h, line, cloud, true);
      }
    }
  }
  if (cases.camel.length && cases.pascal.length) {
    fl.emit('HK-CP-MIXED-CASE', null, `camelCase (${cases.camel.join(', ')}) and PascalCase (${cases.pascal.join(', ')})`);
  }
}

function copilotMatcher(fl, matcher, line) {
  const err = matcher === undefined ? null : badRegex(`^(?:${matcher})$`);
  if (err) fl.emit('HK-CP-MATCHER', line, `matcher "${matcher}" does not compile (${err.message.split(':').pop().trim()})`);
}

function copilotEntry(fl, event, e, line, cloud, nested) {
  const E = (id, msg, o) => fl.emit(id, line, `${event}: ${msg ?? title(id)}`, o);
  if (!isObj(e)) return E('HK-CP-SHAPE', 'every hook must be an object');
  const type = e.type ?? 'command';
  if (!['command', 'http', 'prompt'].includes(type)) return E('HK-CP-TYPE', `type "${type}"`);
  for (const k of Object.keys(e).filter((x) => !CP_ENTRY_FIELDS.has(x) || (nested && x === 'hooks'))) {
    const local = ['windows', 'linux', 'osx', 'hookSpecificOutput'].includes(k);
    E(local && cloud ? 'HK-CP-LOCAL-KEYS' : 'HK-CP-FIELD', local ? `"${k}" is a VS Code Local-harness key; Copilot ignores it`
      : `unknown key "${k}"`, { field: k });
  }
  copilotMatcher(fl, e.matcher, line);
  if (type === 'prompt') return /^[sS]essionStart$/.test(event) ? undefined : E('HK-CP-PROMPT');
  const eff = [e.timeoutSec, e.timeout].find((x) => typeof x === 'number');
  const [hasSec, hasTimeout] = [e.timeoutSec !== undefined, e.timeout !== undefined];
  if (hasSec && !(typeof e.timeoutSec === 'number' && e.timeoutSec > 0)) E('HK-CP-TIMEOUT-TYPE');
  if (!hasSec && !hasTimeout) E('HK-CP-TIMEOUT', 'no timeoutSec (Copilot waits up to 30 s)', { severity: 'note', strictSeverity: 'warning' });
  if (hasSec && hasTimeout) E('HK-CP-TIMEOUT', 'both timeoutSec and timeout (VS Code reads timeout first)');
  if (eff > 30) E('HK-CP-TIMEOUT', `timeout ${eff} s is above 30 s`);
  if (type === 'http') return copilotHttp(fl, E, event, e.url, line);
  const [bash, ps, cmd] = ['bash', 'powershell', 'command'].map((k) => typeof e[k] === 'string');
  const exec = e.exec !== undefined;
  const xs = cmd && !(bash && ps) ? crossShellProblems(e.command) : [];
  if (exec && (bash || ps || cmd)) E('HK-CP-EXEC-MIX');
  else if (exec) E('HK-CP-EXEC');
  if (!bash && !ps && !cmd && !exec) E('HK-CP-COMMAND');
  if (bash && !ps && !cmd) E('HK-CP-NO-WINDOWS', 'bash only; add a powershell entry for Windows');
  if (ps && !bash && !cmd) E('HK-CP-PS-ONLY', 'powershell only; the cloud agent (Linux) ignores it');
  if (xs.length) E('HK-XS-COMMAND', `"command" runs in bash and PowerShell but uses ${xs.join('; ')}`, { evidence: e.command });
  if (ps && /&&|\|\|/.test(e.powershell)) E('HK-CP-PS-COMPAT', 'the powershell string uses && or ||');
  const list = strs(e.bash, e.powershell, e.command, e.exec, Array.isArray(e.args) ? e.args : []);
  const plugin = fl.cls.plugin || null;
  const cwd = typeof e.cwd === 'string' && !e.cwd.includes('$') ? path.resolve(fl.run.root, e.cwd) : fl.run.root;
  const scripts = scriptsOf(fl, list, cwd, plugin);
  const rootCwd = typeof e.cwd === 'string' && ROOTED.test(e.cwd);
  const [m, s] = (plugin && !rootCwd && list.flatMap((x) => [...x.matchAll(CP_SCRIPT)].map((y) => [y, x]))
    .find(([y]) => !y[1] && !/^[/\\~]/.test(y[2]) && !WIN_ABS.test(y[2]))) || [];
  if (anyText(list, scripts, ASK)) E('HK-CP-ASK', 'the hook can answer permissionDecision "ask" (deny in the cloud agent)');
  if (plugin && /^[pP]reToolUse$/.test(event) && e.cwd !== '${PLUGIN_ROOT}') E('HK-CP-PLUGIN-CWD');
  if (m) E('HK-CP-PLUGIN-PATHS', `"${m[2]}" resolves against the project; write "\${PLUGIN_ROOT}/${m[2].replace(/^\.[\\/]/, '')}"`, { evidence: s });
  if (plugin && anyText(list, scripts, CP_WRITES_ROOT)) E('HK-CP-PLUGIN-PATHS', 'writes under ${PLUGIN_ROOT}; use ${PLUGIN_DATA}');
  fl.unpinned(list, line, `${event}: `);
}

function copilotHttp(fl, E, event, url, line) {
  let u = null;
  try { u = new URL(String(url)); } catch {}
  if (typeof url !== 'string') return E('HK-CP-HTTP', 'http hooks need a url');
  if (!u) return E('HK-CP-HTTP', `invalid URL "${url}"`);
  if (u.protocol === 'http:' && !LOOPBACK.has(u.hostname)) E('HK-CP-HTTP', `${u.origin} must use https`);
  else if (u.protocol === 'http:' && /^(?:[pP]reToolUse|[pP]ermissionRequest)$/.test(event)) E('HK-CP-HTTP', 'https even on localhost');
  else if (u.protocol === 'http:') E('HK-CP-HTTP', 'localhost needs COPILOT_HOOK_ALLOW_LOCALHOST=1', { severity: 'warning' });
  else if (u.protocol !== 'https:') E('HK-CP-HTTP', `unsupported URL scheme ${u.protocol}`);
  httpSecurity(fl, line, url);
}

/** Claude Code and Codex hook maps: `{ Event: [{ matcher?, hooks: [handler] }] }`. */
function lintGroups(fl, hooks, text, dialect, handler, fromToml = false) {
  const [EVENTS, NO_MATCHER, plain] = dialect === 'CL' ? [CL_EVENTS, CL_NO_MATCHER, /^[A-Za-z0-9_ ,|-]*$/]
    : [CX_EVENTS, CX_NO_MATCHER, /^[A-Za-z0-9_|]+$/];
  for (const [event, groups] of Object.entries(hooks).filter(([e]) => !fromToml || e !== 'state')) {
    const at = fromToml ? text.indexOf(`hooks.${event}`) : -1;
    const line = fromToml ? (at < 0 ? null : lineOf(text, at)) : keyLine(text, event);
    const E = (id, msg) => fl.emit(`HK-${dialect}-${id}`, line, msg);
    if (!EVENTS.includes(event)) {
      E('EVENT', `"${event}" is not a ${dialect === 'CL' ? 'Claude Code' : 'Codex'} hook event`
        + (dialect === 'CL' ? guess(EVENTS, event) : guess(EVENTS, event, ' (Codex uses PascalCase: ', ')')));
    }
    if (!Array.isArray(groups)) { E('SHAPE', `"${event}" must be an array of matcher groups`); continue; }
    for (const g of groups) {
      const shape = !isObj(g) || (dialect === 'CX' && !Array.isArray(g.hooks));
      if (shape) { E('SHAPE', `${event}: every matcher group must be an object with "hooks"`); continue; }
      if (dialect === 'CL' && Array.isArray(g.matcher)) E('SHAPE', `${event}: a matcher array invalidates the file; use "A|B"`);
      else if (g.matcher !== undefined && g.matcher !== '' && g.matcher !== '*') {
        if (NO_MATCHER.has(event)) E('MATCHER-IGNORED', `${event} ignores matchers; "${g.matcher}" is dropped`);
        else if (typeof g.matcher === 'string' && !plain.test(g.matcher) && badRegex(g.matcher)) {
          E('MATCHER', `matcher "${g.matcher}" does not compile`);
        }
      }
      fl.unknown(g, S('matcher hooks'), `HK-${dialect}-FIELD`, () => line, 'matcher-group key', { prefix: `${event}: ` });
      if (!Array.isArray(g.hooks)) { E('SHAPE', `${event}: every matcher group needs a "hooks" array`); continue; }
      for (const h of g.hooks) handler(event, h, line);
    }
  }
}

function unquotedVar(cmd) {
  let q = null;
  for (let i = 0; i < cmd.length; i++) {
    if (q) { if (cmd[i] === q) q = null; continue; }
    if (cmd[i] === '"' || cmd[i] === "'") q = cmd[i];
    const m = cmd[i] === '$' && /^\$\{?(?:CLAUDE_PROJECT_DIR|CLAUDE_PLUGIN_ROOT|CLAUDE_PLUGIN_DATA)\}?/.exec(cmd.slice(i));
    if (m) return m[0];
  }
  return null;
}

function claudeHandler(fl, event, h, line, { project, plugin }) {
  const E = (id, msg, o) => fl.emit(id, line, `${event}: ${msg ?? title(id)}`, o);
  if (!isObj(h)) return E('HK-CL-SHAPE', 'every hook handler must be an object');
  const { type, onFailure } = h;
  const types = claudeTypes(event);
  if (!W('command http mcp_tool prompt agent').includes(type)) return E('HK-CL-TYPE', `type ${JSON.stringify(type)}`);
  if (CL_EVENTS.includes(event) && !types.includes(type)) E('HK-CL-TYPE', `${type} hooks are not supported (only ${types.join(', ')})`);
  fl.unknown(h, CL_HANDLER_FIELDS, 'HK-CL-FIELD', () => line, 'handler field', { prefix: `${event}: ` });
  if (h.if !== undefined && !CL_IF_EVENTS.has(event)) E('HK-CL-IF');
  if (h.once !== undefined) E('HK-CL-ONCE');
  if (h.shell !== undefined && !['bash', 'powershell'].includes(h.shell)) E('HK-CL-SHELL', `shell "${h.shell}"`);
  if (onFailure !== undefined && !['continue', 'block'].includes(onFailure)) E('HK-CL-ONFAILURE', `onFailure "${onFailure}"`);
  else if (onFailure !== undefined && (S('Stop SubagentStop TaskCompleted TeammateIdle').has(event) || h.async)) {
    E('HK-CL-ONFAILURE', `onFailure has no effect on ${h.async ? 'async hooks' : event}`, { severity: 'warning' });
  } else if (onFailure !== undefined) E('HK-CL-ONFAILURE', 'onFailure needs Claude Code 2.1.295+', { severity: 'note' });
  if (type === 'http') return typeof h.url === 'string' ? httpSecurity(fl, line, h.url) : E('HK-CL-SHAPE', 'no url');
  if (type !== 'command') return;
  if (typeof h.command !== 'string' || !h.command.trim()) return E('HK-CL-SHAPE', 'a command hook needs "command"');
  const exec = Array.isArray(h.args);
  const shim = path.basename(h.command.replace(/\\/g, '/')).toLowerCase();
  const [unquoted, xs] = exec ? [null, []] : [unquotedVar(h.command), project ? crossShellProblems(h.command) : []];
  const list = strs(h.command, exec ? h.args : []);
  if (exec && (/\.(?:cmd|bat)$/.test(shim) || NPM_SHIMS.has(shim))) E('HK-CL-EXEC-SHIM', `exec form cannot start "${h.command}"`);
  if (exec && project) E('HK-CL-REPO-EXEC');
  if (unquoted) E('HK-CL-UNQUOTED-VAR', `${unquoted} is not double-quoted`, { evidence: h.command });
  if (xs.length) E('HK-XS-COMMAND', `Copilot runs it in bash and PowerShell, but it uses ${xs.join('; ')}`, { only: ['copilot'], evidence: h.command });
  for (const s of plugin ? list : []) {
    const tok = [...s.matchAll(SCRIPT)].map((m) => m[0])
      .find((t) => !ROOTED.test(t) && !/^\$\{?CLAUDE_PROJECT_DIR/.test(t) && !/^(?:https?:|<)/.test(t));
    if (tok) E('HK-CL-PLUGIN-ROOT', `"${tok}" resolves against the project; write "\${CLAUDE_PLUGIN_ROOT}/${tok.replace(/^\.\//, '')}"`);
  }
  if (plugin && anyText(list, scriptsOf(fl, list, plugin, plugin), CL_WRITES_ROOT)) E('HK-CL-PLUGIN-DATA');
  fl.unpinned(list, line, `${event}: `);
}

/** Why a Codex `command` fails under cmd.exe /C on Windows (checked when no commandWindows is given). */
const CMD_EXE = [[/(?:^|\s)\.{1,2}\/[^\s]*|\.sh\b/, 'a ./script or .sh path'], [/\$\{?[A-Za-z_]/, '$VAR (cmd uses %VAR%)'],
  [/'/, 'single quotes (not quotes in cmd.exe)'], [/(?:^|\s)~\//, '~/'], [/\/dev\/null/, '/dev/null'],
  [/\bcommand\s+-v\b|\bexport\s|;\s*then\b/, 'POSIX shell syntax']];
const COPILOT_OUTPUT = /\b(?:modifiedArgs|modifiedResult|textResultForLlm)\b/;

function codexHandler(fl, event, h, line) {
  const E = (id, msg, o) => fl.emit(id, line, `${event}: ${msg ?? title(id)}`, o);
  if (!isObj(h)) return E('HK-CX-SHAPE', 'every handler must be an object');
  if (!W('command mcp_tool prompt agent').includes(h.type)) return E('HK-CX-TYPE', `handler type ${JSON.stringify(h.type)}`);
  if (h.type === 'prompt' || h.type === 'agent') return E('HK-CX-TYPE', `${h.type} handlers never run`, { severity: 'warning' });
  for (const k of Object.keys(h).filter((x) => !CX_HANDLER_FIELDS[h.type].has(x))) {
    E('HK-CX-FIELD', `"${k}" is not a ${h.type} handler field${/^(?:args|cwd|env)$/.test(k) ? ' (no args, cwd or env)' : ''}`, { field: k });
  }
  if (h.type !== 'command') return codexSessionEnd(E, event, h);
  if (typeof h.command !== 'string' || !h.command.trim()) return E('HK-CX-SHAPE', 'a command handler needs "command"');
  const list = strs(h.command, h.commandWindows, h.command_windows);
  const scripts = scriptsOf(fl, list, fl.run.root);
  const win = h.commandWindows !== undefined || h.command_windows !== undefined ? []
    : CMD_EXE.filter(([re]) => re.test(h.command)).map(([, w]) => w);
  if (win.length) E('HK-CX-WINDOWS', `no commandWindows; under cmd.exe "command" uses ${win.join(', ')}`);
  if (anyText(list, scripts, EXIT2)) E('HK-CX-EXIT2', 'exits 2 to block; print a JSON decision on exit 0 instead');
  if (scripts.some((s) => COPILOT_OUTPUT.test(s.text) && !/hookSpecificOutput/.test(s.text))) E('HK-CX-OUTPUT');
  fl.unpinned(list, line, `${event}: `);
  codexSessionEnd(E, event, h);
}

function codexSessionEnd(E, event, h) {
  if (/^(?:SessionEnd|Interrupt)$/.test(event) && typeof h.timeout === 'number' && h.timeout > 3) {
    E('HK-CX-SESSIONEND', `timeout ${h.timeout} s is capped at 3 s`);
  }
  if (event === 'SessionEnd' && h.async === true) E('HK-CX-SESSIONEND', 'async is ignored');
}

function lintCodexHooks(fl, v, text, fromToml = false) {
  if (!isObj(v?.hooks)) return fl.emit('HK-CX-SHAPE', 1, 'expected {"hooks": {Event: [{"matcher"?, "hooks": [...]}]}}');
  if (!fromToml) fl.unknown(v, S('description hooks'), 'HK-CX-FIELD', (k) => keyLine(text, k), 'top-level key');
  lintGroups(fl, v.hooks, text, 'CX', (event, h, line) => codexHandler(fl, event, h, line), fromToml);
  if (/(?:^|\/)\.codex\//.test(toPosix(fl.abs)) && fl.cls.scope === 'project') fl.emit('HK-CX-TRUST', null);
}

function lintHooksOrSettings(fl) {
  const [{ kind, sub }, text] = [fl.cls, fl.text];
  const dialect = { copilot: 'CP', codex: 'CX' }[sub] || 'CL';
  const parsed = parseJson(text, { jsonc: kind === 'settings' && sub === 'copilot' });
  const v = parsed.value;
  const claude = (hooks, opts) => (isObj(hooks)
    ? lintGroups(fl, hooks, text, 'CL', (event, h, line) => claudeHandler(fl, event, h, line, opts))
    : fl.emit('HK-CL-SHAPE', keyLine(text, 'hooks') || 1, '"hooks" must map event names to arrays of matcher groups'));
  if (parsed.error) {
    fl.emit(`HK-${dialect}-JSON`, parsed.line, `invalid JSON: ${parsed.error}`);
    if (kind === 'settings' && sub === 'claude') fl.emit('HK-CP-JSON', parsed.line, `invalid JSON: ${parsed.error}`);
    return;
  }
  if (kind === 'settings' && !isObj(v)) return fl.emit(`HK-${dialect}-SHAPE`, 1, 'a settings file must be a JSON object');
  if (kind === 'settings' && own(v, 'hooks') && sub === 'claude') claude(v.hooks, { project: fl.cls.scope === 'project' });
  if (kind === 'settings' && own(v, 'hooks') && sub === 'copilot') lintCopilotHooks(fl, { hooks: v.hooks }, text, true);
  if (kind === 'settings' && sub === 'copilot' && v.disableAllHooks === true) {
    fl.emit('HK-CP-DISABLED', keyLine(text, 'disableAllHooks'), '"disableAllHooks": true turns off every non-policy hook');
  }
  if (kind === 'hooks' && sub === 'copilot') lintCopilotHooks(fl, v, text);
  if (kind === 'hooks' && sub === 'claude-plugin' && !own(v, 'hooks')) {
    fl.emit('HK-CL-SHAPE', 1, 'plugin hooks files keep the {"hooks": {...}} wrapper; a file without it fails to load');
  } else if (kind === 'hooks' && sub === 'claude-plugin') {
    claude(v.hooks, { plugin: fl.cls.plugin || path.dirname(path.dirname(fl.abs)) });
  }
  if (kind === 'hooks' && sub === 'codex') lintCodexHooks(fl, v, text);
  const toml = kind === 'hooks' && sub === 'codex' && readNorm(path.join(path.dirname(fl.abs), 'config.toml'));
  if (toml && /^\s*\[\[?hooks[.\]]/m.test(toml)) fl.emit('HK-CX-BOTH', null, 'hooks in both hooks.json and config.toml');
  fl.secrets(text);
}

// ---------------------------------------------------------------------------
// Plugins, marketplaces, MCP configs, Codex config.toml

function pluginRootOf(abs) {
  const d = path.dirname(abs);
  const b = path.basename(d);
  if (['.claude-plugin', '.codex-plugin', '.plugin'].includes(b)) return path.dirname(d);
  return b === 'plugin' && path.basename(path.dirname(d)) === '.github' ? path.dirname(path.dirname(d)) : d;
}

const AP_NAME = /^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/;
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const hasSkill = (...p) => fs.existsSync(path.join(...p, 'SKILL.md'));

function pluginSkillCollisions(fl, pluginRoot) {
  const project = new Map();
  for (const rel of ['.github/skills', '.agents/skills', '.claude/skills']) {
    for (const e of subdirs(path.join(fl.run.root, rel))) {
      if (!project.has(e.name) && hasSkill(fl.run.root, rel, e.name)) project.set(e.name, `${rel}/${e.name}`);
    }
  }
  const skillsDir = path.join(pluginRoot, 'skills');
  for (const e of project.size ? subdirs(skillsDir) : []) {
    const fmName = parseFrontmatter(readNorm(path.join(skillsDir, e.name, 'SKILL.md')) || '').data?.name;
    const n = typeof fmName === 'string' ? fmName : e.name;
    if (project.has(n) && path.resolve(fl.run.root, project.get(n)) !== path.resolve(skillsDir, e.name)) {
      fl.emit('PL-SKILL-COLLISION', null, `plugin skill "${n}" is shadowed by the project skill ${project.get(n)}`);
    }
  }
}

function lintPlugin(fl) {
  const parsed = parseJson(fl.text);
  const [v, root, { sub }] = [parsed.value, pluginRootOf(fl.abs), fl.cls];
  const L = (k) => keyLine(fl.text, k);
  if (parsed.error) return fl.emit('PL-JSON', parsed.line, `invalid JSON: ${parsed.error}`);
  if (!isObj(v)) return fl.emit('PL-JSON', 1, 'the manifest must be a JSON object');
  const [name, skillsDir] = [v.name, path.join(root, 'skills')];
  if (sub === 'agent-plugins') {
    if (!AP_SCHEMA('plugin').includes(v.$schema)) fl.emit('PL-AP-SCHEMA', L('$schema'), `$schema ${JSON.stringify(v.$schema)}`);
    for (const k of Object.keys(v).filter((x) => !PLUGIN_FIELDS[sub].has(x))) {
      fl.emit('PL-AP-FIELD', L(k), `"${k}" is outside the Agent Plugins field set (use "extensions")`, { field: k });
    }
    if (typeof name !== 'string' || !AP_NAME.test(name) || /--|\.\./.test(name)) fl.emit('PL-AP-NAME', L('name'), `name ${JSON.stringify(name)}`);
    if (hasSkill(root) && !fs.existsSync(skillsDir)) fl.emit('PL-AP-SKILLS', null, 'a root SKILL.md is not loaded');
    for (const e of subdirs(skillsDir).filter((x) => !hasSkill(skillsDir, x.name))) {
      if (subdirs(path.join(skillsDir, e.name)).some((y) => hasSkill(skillsDir, e.name, y.name))) {
        fl.emit('PL-AP-SKILLS', null, `skills/${e.name}/ nests skills one level too deep`);
      }
    }
    if (v.extensions !== undefined && !isObj(v.extensions)) fl.emit('PL-AP-FIELD', L('extensions'), '"extensions" is not an object');
  } else if (sub === 'copilot') {
    if (typeof name !== 'string' || !KEBAB.test(name) || name.length > 64) fl.emit('PL-CP-MANIFEST', L('name'), `name ${JSON.stringify(name)}`);
    if (typeof v.description === 'string' && v.description.length > 1024) {
      fl.emit('PL-CP-MANIFEST', L('description'), `description has ${v.description.length} characters (max 1,024)`);
    }
    fl.unknown(v, PLUGIN_FIELDS[sub], 'PL-CP-FIELD', L, 'plugin field');
    for (const f of W('agents skills commands hooks mcpServers lspServers')) {
      for (const p of strs(v[f]).filter((x) => !fs.existsSync(path.resolve(root, x)))) {
        fl.emit('PL-CP-MANIFEST', L(f), `"${f}" path "${p}" does not exist`, { field: f });
      }
    }
  } else if (sub === 'claude') claudePlugin(fl, v, root, L);
  else if (sub === 'codex') {
    for (const [obj, pre] of [[v, ''], [isObj(v.interface) ? v.interface : {}, 'interface.']]) {
      for (const k of Object.keys(obj).filter((x) => CX_SNAKE[x])) {
        fl.emit('PL-CX-FIELD', L(k), `"${pre}${k}" is snake_case; use "${CX_SNAKE[k]}"`, { field: pre + k, severity: 'error' });
      }
    }
    fl.unknown(Object.fromEntries(Object.entries(v).filter(([k]) => !CX_SNAKE[k])), PLUGIN_FIELDS.codex, 'PL-CX-FIELD', L,
      'plugin field');
  }
  pluginSkillCollisions(fl, root);
  fl.secrets(fl.text);
}

function claudePlugin(fl, v, root, L) {
  const name = v.name;
  const missing = ['version', 'description', 'author'].filter((k) => v[k] === undefined);
  const reserved = typeof name === 'string' && (S('claude anthropic anthropics claude-code claude-mods').has(name)
    || /^(?:claude|anthropics?|cc-plugin)-/.test(name));
  if (typeof name !== 'string' || !name) fl.emit('PL-CL-NAME', L('name') || 1, '"name" is required');
  else if (!KEBAB.test(name)) fl.emit('PL-CL-NAME', L('name'), `plugin name "${name}" is not kebab-case`);
  if (reserved) fl.emit('PL-CL-NAME', L('name'), `plugin name "${name}" is reserved`);
  else if (/(?:^|-)(?:claude|anthropic)(?:-|$)/.test(name)) fl.emit('PL-CL-NAME-WORD', L('name'), `plugin name "${name}"`);
  fl.unknown(v, PLUGIN_FIELDS.claude, 'PL-CL-FIELD', L, 'plugin field');
  if (missing.length) fl.emit('PL-CL-META', null, `no ${missing.join(', ')} (claude plugin validate warns)`);
  if (v.author !== undefined && typeof v.author?.name !== 'string') fl.emit('PL-CL-FIELD', L('author'), '"author" needs a "name"');
  for (const f of W(CL_PATH_FIELDS).filter((x) => v[x] !== undefined && !isObj(v[x]))) {
    for (const p of strs(v[f])) {
      const [abs, rel] = [path.resolve(root, p), path.relative(root, path.resolve(root, p))];
      const why = !(p.startsWith('./') || (f === 'skills' && (p === '.' || p === './'))) ? 'must start with ./'
        : p.includes('\\') ? 'uses backslashes' : rel.startsWith('..') || path.isAbsolute(rel) ? 'leaves the plugin root'
          : !fs.existsSync(abs) ? 'does not exist' : null;
      if (why) fl.emit('PL-CL-PATH', null, `"${f}" path "${p}" ${why}`, { field: f });
    }
  }
  if (fs.existsSync(path.join(root, 'CLAUDE.md'))) fl.emit('PL-CL-CLAUDEMD', null);
}

function sourcePinned(src) {
  if (!isObj(src)) return true;
  if (['github', 'url', 'git-subdir', 'git'].includes(src.source)) return /^[0-9a-f]{40}$/i.test(String(src.sha ?? ''));
  if (src.source === 'npm') return typeof src.version === 'string' && /\d/.test(src.version) && src.version !== 'latest';
  return src.source !== 'archive' || /^[0-9a-f]{64}$/i.test(String(src.sha256 ?? ''));
}

function lintMarketplace(fl) {
  const parsed = parseJson(fl.text);
  const [v, { sub }] = [parsed.value, fl.cls];
  const L = (k) => keyLine(fl.text, k);
  if (parsed.error) return fl.emit('MK-JSON', parsed.line, `invalid JSON: ${parsed.error}`);
  if (!isObj(v)) return fl.emit('MK-SHAPE', 1, 'the marketplace must be a JSON object');
  if (typeof v.name !== 'string' || !v.name) fl.emit('MK-SHAPE', L('name') || 1, '"name" is required');
  else if (sub === 'claude' && (CL_RESERVED_MKT.has(v.name.toLowerCase()) || /^claudeai-/i.test(v.name))) {
    fl.emit('MK-NAME-RESERVED', L('name'), `marketplace name "${v.name}" is reserved`);
  }
  if (sub !== 'codex' && typeof v.owner?.name !== 'string') fl.emit('MK-SHAPE', L('owner') || 1, '"owner.name" is required');
  if (!Array.isArray(v.plugins)) return fl.emit('MK-SHAPE', L('plugins') || 1, '"plugins" must be an array');
  if (sub !== 'codex') fl.unknown(v, MKT_FIELDS[sub], 'MK-FIELD', L, 'top-level key', { only: [sub] });
  v.plugins.forEach((entry, i) => {
    const line = (isObj(entry) && entry.name && keyLine(fl.text, entry.name)) || L('plugins');
    const src = entry?.source;
    const E = (id, msg, o) => fl.emit(id, line, `${entry.name}: ${msg}`, o);
    if (!isObj(entry) || typeof entry.name !== 'string' || src === undefined) {
      return fl.emit('MK-ENTRY', line, `plugins[${i}] needs "name" and "source"`);
    }
    const pin = { npm: 'version', archive: 'sha256' }[src?.source] || '40-character sha';
    const relSrc = typeof src === 'string' ? src : src?.source === 'local' ? String(src.path ?? '') : '';
    if (typeof src === 'string' && sub === 'claude' && !(src === '.' || src.startsWith('./'))) {
      E('MK-ENTRY', `relative source "${src}" must start with ./`, { only: ['claude'] });
    }
    if (relSrc.split('/').includes('..')) E('MK-ENTRY', `source "${relSrc}" must not use ..`);
    if (!sourcePinned(src)) E('MK-UNPINNED', `${src.source} source without a pinned ${pin}`);
    if (typeof src !== 'string' && !isObj(src)) E('MK-ENTRY', '"source" must be a path string or an object');
    if (sub === 'claude' && entry.hooks !== undefined && !isObj(entry.hooks)) E('MK-HOOKS-PATH', 'hooks must be an object');
  });
}

const SECRET_KEY = /(?:token|secret|password|passwd|api[_-]?key|apikey|auth|credential|bearer|cookie|private[_-]?key)/i;
const literalCredential = (key, v) => typeof v === 'string' && v.length >= 8
  && !/\$\{|\$[A-Z_]|\{\{|^\$|^<[^>]+>$|^[A-Z][A-Z0-9_]+$/.test(v) && (/^(?:Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{12,}$/i
    .test(v) || (SECRET_KEY.test(key) && /^[A-Za-z0-9._~+/=:-]{16,}$/.test(v) && /\d/.test(v) && /[A-Za-z]/.test(v)));
const credentialKeys = (bag) => Object.entries(isObj(bag) ? bag : {}).filter(([k, v]) => literalCredential(k, v));

const MCP_TYPES = { vscode: { copilot: W('stdio http sse') },
  'agent-plugins': { copilot: W('stdio streamable-http sse'), codex: W('stdio streamable-http sse') },
  other: { copilot: W('local stdio http sse'), claude: W('stdio http sse') } };

function mcpServer(fl, name, s, sub) {
  const line = keyLine(fl.text, name);
  const E = (id, msg, o) => fl.emit(id, line, `server "${name}": ${msg}`, o);
  if (!isObj(s)) return E('MC-SERVER', 'must be an object');
  for (const [host, types] of Object.entries(MCP_TYPES[sub] || MCP_TYPES.other)) {
    if (s.type === undefined || types.includes(s.type)) continue;
    E('MC-SERVER', `type "${s.type}" is not one of ${types.join(', ')} for ${LABEL[host]}`,
      { only: [host], severity: host === 'claude' && s.type === 'local' && 'warning' });
  }
  if (typeof s.command !== 'string' && typeof s.url !== 'string') E('MC-SERVER', 'needs a "command" or a "url"');
  let u = null;
  try { u = typeof s.url === 'string' ? new URL(s.url) : null; } catch { E('MC-SERVER', `invalid url "${s.url}"`); }
  if (u?.protocol === 'http:' && !LOOPBACK.has(u.hostname)) E('MC-HTTP', `uses plain http to ${u.hostname}`);
  if (JSON.stringify(s).includes('${input:')) {
    E('MC-INPUT', sub === 'vscode' ? 'uses ${input:...}, which VS Code does not forward to the Copilot harness'
      : 'uses ${input:...}, which only VS Code resolves', { severity: sub === 'vscode' && 'note' });
  }
  const missing = /^(?:vscode|agent-plugins)$/.test(sub) ? [] : ['type', 'tools'].filter((k) => s[k] === undefined);
  if (missing.length) E('MC-CLOUD', `no ${missing.map((k) => `"${k}"`).join(' or ')}`);
  for (const bag of ['env', 'headers']) {
    for (const [k] of credentialKeys(s[bag])) {
      fl.sec('SEC-MCP-SECRET', keyLine(fl.text, k) || line, `server "${name}" ${bag}.${k} holds a literal credential; use \${VAR}`);
    }
  }
  fl.unpinned([strs(s.command, Array.isArray(s.args) ? s.args : []).join(' ')], line, `server "${name}" `);
}

function lintMcp(fl) {
  const { sub } = fl.cls;
  const parsed = parseJson(fl.text, { jsonc: sub === 'vscode' });
  const [v, other] = [parsed.value, !/^(?:vscode|agent-plugins)$/.test(sub)];
  const L = (k) => keyLine(fl.text, k);
  if (parsed.error) return fl.emit('MC-JSON', parsed.line, `invalid JSON: ${parsed.error}`);
  if (!isObj(v)) return fl.emit('MC-JSON', 1, 'the MCP config must be a JSON object');
  let servers = sub === 'vscode' ? v.servers ?? v.mcpServers : v.mcpServers;
  if (sub === 'vscode') fl.emit('MC-VSCODE-CLI', null);
  if (sub === 'vscode' && own(v, 'mcpServers') && !own(v, 'servers')) fl.emit('MC-TOPKEY', L('mcpServers'), 'VS Code reads "servers"');
  if (sub === 'agent-plugins') agentPluginsMcp(fl, v, L);
  if (other && own(v, 'servers') && !own(v, 'mcpServers')) fl.emit('MC-TOPKEY', L('servers'), '"servers" is the VS Code format');
  if (other && servers === undefined && !own(v, 'servers') && Object.values(v).some((x) => isObj(x) && (x.command || x.url))) {
    servers = v;
    fl.emit('MC-TOPKEY', 1, 'Claude Code expects servers under "mcpServers"', { only: ['claude'] });
  }
  if (servers !== undefined && !isObj(servers)) return fl.emit('MC-SERVER', 1, 'the server map must be an object');
  for (const [name, s] of Object.entries(servers || {})) mcpServer(fl, name, s, sub);
  fl.secrets(fl.text);
}

function agentPluginsMcp(fl, v, L) {
  const VAR = /\$\{PLUGIN_(?:ROOT|DATA)\}/;
  if (!AP_SCHEMA('mcp').includes(v.$schema)) fl.emit('PL-AP-MCP', L('$schema') || 1, `"$schema" must be ${AP_SCHEMA('mcp')[0]}`);
  for (const k of Object.keys(v).filter((x) => x !== '$schema' && x !== 'mcpServers')) {
    fl.emit('PL-AP-MCP', L(k), `mcp.json may contain only $schema and mcpServers ("${k}")`);
  }
  for (const [name, s] of Object.entries(isObj(v.mcpServers) ? v.mcpServers : {}).filter(([, x]) => isObj(x))) {
    const E = (msg) => fl.emit('PL-AP-MCP', L(name), `server "${name}": ${msg}`);
    const cmd = typeof s.command === 'string' ? s.command : null;
    if (cmd && (/\s/.test(cmd.trim()) || path.isAbsolute(cmd) || WIN_ABS.test(cmd))) E('command must be one token');
    if (cmd && VAR.test(cmd)) E('${PLUGIN_ROOT} expands only in args, env and cwd');
    if (s.cwd !== undefined && !/^(?:\.\/|\$\{PLUGIN_(?:ROOT|DATA)\})/.test(String(s.cwd))) E('cwd must start with ./ or ${PLUGIN_ROOT}');
    if (VAR.test(JSON.stringify([s.url ?? '', s.headers ?? {}]))) E('url and headers are not expanded');
  }
}

function lintCodexConfig(fl) {
  const t = parseToml(fl.text);
  const [v, K] = [t.value, (k) => t.keyLines[k] || null];
  if (t.error) return fl.emit('CX-TOML', t.error.line, `invalid TOML: ${t.error.message}`);
  const sc = isObj(v.skills) ? v.skills.config : undefined;
  if (isObj(v.hooks)) lintCodexHooks(fl, { hooks: v.hooks }, fl.text, true);
  if (isObj(v.hooks) && fs.existsSync(path.join(path.dirname(fl.abs), 'hooks.json'))) {
    fl.emit('HK-CX-BOTH', null, 'hooks in both config.toml and hooks.json');
  }
  if (sc !== undefined && !Array.isArray(sc)) fl.emit('CX-SKILLS-CONFIG', K('skills.config'), 'skills.config is not an array');
  for (const [i, e] of (Array.isArray(sc) ? sc : []).entries()) {
    const ok = ['path', 'name'].filter((k) => isObj(e) && e[k] !== undefined).length === 1 && typeof e.enabled === 'boolean';
    if (!ok) fl.emit('CX-SKILLS-CONFIG', K('skills.config'), `[[skills.config]] #${i + 1}`);
  }
  if (own(v, 'mcpServers')) fl.emit('CX-MCP', null, 'Codex reads [mcp_servers.<name>], not mcpServers');
  for (const [name, s] of Object.entries(isObj(v.mcp_servers) ? v.mcp_servers : {})) {
    const at = `[mcp_servers.${name}]`;
    if (!isObj(s) || (typeof s.command !== 'string' && typeof s.url !== 'string')) fl.emit('CX-MCP', K(`mcp_servers.${name}`), at);
    for (const [k] of credentialKeys(s?.env)) {
      fl.sec('SEC-MCP-SECRET', K(`mcp_servers.${name}.env.${k}`) || K(`mcp_servers.${name}.env`), `${at} env.${k} holds a credential`);
    }
    fl.unpinned([strs(s?.command, Array.isArray(s?.args) ? s.args : []).join(' ')], null, `${at} `);
  }
  fl.secrets(fl.text);
}

// ---------------------------------------------------------------------------
// External validators (run when installed; results merged into the per-host findings)

/** Spawn a validator CLI (Windows `.cmd` shims go through the shell; 90 s default timeout); the default `exec`. */
export const execTool = (exe, args, opts = {}) => runTool(exe, args, { timeoutMs: 90_000, ...opts });

/** Skill folders a host lists when started at `root` (only skills there can be checked with the host CLI). */
function hostSkillRoots(host, root, env, home) {
  const H = homes(env, home);
  // Codex reads .agents/skills from the project root down to the cwd (the root here) and ~/.agents/skills.
  if (host === 'codex') return [path.join(root, '.agents', 'skills'), `${H.home}/.agents/skills`];
  return [...['.github', '.agents', '.claude'].map((d) => path.join(root, d, 'skills')), `${H.copilot}/skills`,
    `${H.home}/.agents/skills`, ...String(env.COPILOT_SKILLS_DIRS || '').split(',').map((d) => d.trim()).filter(Boolean)];
}
const listedFrom = (s, roots) => roots.some((r) => samePath(path.dirname(s.dir), r));
// gh skill publish discovers skills/<name>, skills/<scope>/<name>, <name> at the root and plugins/<scope>/skills/<name>.
const GH_DISCOVERS = /^(?:skills\/[^/]+(?:\/[^/]+)?|[^/.][^/]*|plugins\/[^/]+\/skills\/[^/]+)$/;
// Instruction files `copilot instruction list` reports for the repository root (nested AGENTS.md files load per cwd).
const CP_LISTED = new RegExp('^(?:(?:AGENTS|CLAUDE|GEMINI)\\.md|\\.github\\/copilot-instructions\\.md'
  + '|\\.github\\/instructions\\/.+\\.instructions\\.md|\\.claude\\/rules\\/.+\\.md)$');

/** skills-ref prints "Validation failed for <dir>:" and one "- <problem>" item per problem (items may wrap). */
function skillsRefProblems(text) {
  const lines = String(text || '').split(/\r?\n/);
  const items = [];
  for (const l of lines) {
    if (/^\s*- /.test(l)) items.push(l.replace(/^\s*- /, '').trim());
    else if (items.length && l.trim()) items[items.length - 1] += ` ${l.trim()}`;
  }
  const out = items.length ? items : lines.map((l) => l.trim()).filter((l) => l && !/^Validation failed for\b/.test(l));
  return out.slice(0, items.length || 8).map((m) => truncate(m.replace(/\s+/g, ' '), 300));
}

/** Skills named in Codex's <skills_instructions> block: [{ name, file }], or null when the block is absent. */
export function codexListedSkills(stdout) {
  const texts = [];
  const collect = (v) => (typeof v === 'string' ? v.includes('<skills_instructions>') && texts.push(v)
    : v && typeof v === 'object' && Object.values(v).forEach(collect));
  try { collect(JSON.parse(stdout)); } catch {}
  if (!texts.length && String(stdout).includes('<skills_instructions>')) {
    texts.push(String(stdout).replace(/\\n/g, '\n').replace(/\\"/g, '"'));
  }
  if (!texts.length) return null;
  return texts.flatMap((t) => {
    const end = t.indexOf('</skills_instructions>');
    const block = t.slice(t.indexOf('<skills_instructions>'), end < 0 ? undefined : end);
    const roots = Object.fromEntries([...block.matchAll(/^- `(r\d+)` = `([^`]+)`\s*$/gm)].map((m) => [m[1], m[2]]));
    return [...block.matchAll(/^- ([^:`\n][^:\n]*): .*\(file: ([^)]+)\)\s*$/gm)].map(([, name, file]) => {
      const alias = /^(r\d+)\/(.*)$/.exec(file.trim());
      const abs = alias && roots[alias[1]] ? path.join(roots[alias[1]], ...alias[2].split('/')) : file.trim();
      return { name: name.trim(), file: abs };
    });
  });
}

/** `claude plugin validate --json` report → { status, summary, findings }, or null when nothing was validated. */
function claudeReport(report, dir) {
  const contents = Array.isArray(report.contents) ? report.contents : [];
  const mErrors = Array.isArray(report.manifest?.errors) ? report.manifest.errors : [];
  // Measured on 2.1.310: a bare skills directory yields success with manifest null and contents []: nothing validated.
  const bare = !fs.existsSync(path.join(dir, '.claude-plugin')) && !contents.length;
  if (bare && (!report.manifest || mErrors.every((e) => e.path === 'directory'))) return null;
  const findings = [];
  const F = (abs, severity, message) => findings.push({ abs, host: 'claude', rule: 'EXT-CLAUDE-VALIDATE', severity, message });
  for (const entry of [report.manifest, ...contents].filter((e) => isObj(e) && e.file)) {
    const abs = path.resolve(dir, entry.file);
    for (const [list, sev] of statOrNull(abs)?.isDirectory() ? [] : [[entry.errors, 'error'], [entry.warnings, 'warning']]) {
      for (const e of list || []) F(abs, sev, `claude plugin validate: ${e.path ? `${e.path}: ` : ''}${e.message}`);
    }
  }
  // Plugin-directory listing findings (README, LICENSE, icon) concern publishing, not loading.
  const manifest = ['plugin.json', 'marketplace.json'].map((f) => path.join(dir, '.claude-plugin', f)).find((f) => fs.existsSync(f));
  for (const d of manifest && Array.isArray(report.directory?.findings) ? report.directory.findings : []) {
    F(manifest, 'note', `claude plugin validate (plugin listing): ${d.title || d.code}${d.message ? `: ${truncate(d.message, 160)}` : ''}`);
  }
  const dirErrors = statOrNull(path.resolve(dir, report.manifest?.file || '.'))?.isDirectory() ? mErrors : [];
  const failed = report.success === false || findings.some((f) => f.severity === 'error');
  const n = findings.filter((f) => f.severity !== 'note').length || dirErrors.length;
  return { status: failed ? 'fail' : 'pass', findings,
    summary: failed ? `${n} issue(s)${dirErrors.length ? `: ${dirErrors[0].message}` : ''}` : 'validation passed' };
}

/** Findings for skills a host CLI lists (`listed`: [{ name, path|file, enabled? }]). */
function listingFindings(skills, listed, { host, rule, tool, here, other, missing }) {
  return skills.flatMap((s) => {
    const name = s.name || path.basename(s.dir);
    const at = listed.find((x) => here(x, s));
    const elsewhere = listed.find((x) => x.name === name);
    const [severity, message] = at?.enabled === false ? ['warning', `${tool} shows "${name}" as disabled`] : at ? []
      : elsewhere ? ['note', other(name, elsewhere)] : ['warning', `${tool} does not show "${name}"${missing}`];
    return severity ? [{ abs: s.file, host, rule, severity, message }] : [];
  });
}

/**
 * Run the hosts' own validators that are installed. `targets`: { root, skills: [{dir, file, name}], plugins: [dir],
 * instructions: [abs], codexConfigs: [abs], hosts, env, home }. Returns [{ tool, target, status: 'pass'|'fail'|'error'|
 * 'skipped'|'not-applicable', exit, command, summary, findings: [{ abs, host, rule, severity, message }] }]; only `pass`
 * is a pass. `exec`, `which` and `version` are injectable.
 */
export function runExternalValidators(targets, { exec = execTool, which: whichFn = which, version = toolVersion } = {}) {
  const out = [];
  const { root, skills = [], plugins = [], instructions = [], codexConfigs = [], hosts = HOSTS, env = process.env } = targets;
  const want = (h) => hosts.includes(h);
  // Paths inside the root are shown relative to it, others (user-scope files) in full.
  const rel = (p) => {
    const r = path.relative(root, String(p));
    return !r ? '.' : r.startsWith('..') || path.isAbsolute(r) ? toPosix(p) : toPosix(r);
  };
  const statusOf = (r) => (r.exit === 0 ? 'pass' : r.exit === null || r.error ? 'error' : 'fail');
  const push = (tool, target, status, command, summary, findings = [], exit = null) =>
    out.push({ tool, target, status, exit, command, summary: redactSecrets(summary), findings });
  const ctx = { exec, whichFn, version, push, rel, root, env, home: targets.home || os.homedir(),
    first: (r) => firstLine(r.stderr || r.stdout), failOf: (f) => (f.some((x) => x.severity !== 'note') ? 'fail' : 'pass') };
  const refExe = want('spec') && skills.length ? whichFn('skills-ref') : null;
  for (const s of want('spec') ? skills : []) {
    const command = `skills-ref validate ${rel(s.dir)}`;
    const r = refExe && exec(refExe, ['validate', s.dir], { cwd: root });
    const status = r ? statusOf(r) : 'skipped';
    const problems = status !== 'fail' ? [] : skillsRefProblems(`${r.stdout}\n${r.stderr}`);
    if (status === 'fail' && !problems.length) problems.push('validation failed');
    push('skills-ref', rel(s.dir), status, command, !r ? 'skills-ref is not on PATH (uv tool install '
      + '"git+https://github.com/agentskills/agentskills#subdirectory=skills-ref")' : status === 'fail'
      ? `${problems.length} problem(s): ${problems[0]}` : firstLine(`${r.stdout}\n${r.stderr}`) || status,
    problems.map((m) => ({ abs: s.file, host: 'spec', rule: 'EXT-SKILLS-REF', severity: 'error', message: `skills-ref: ${m}` })),
    r ? r.exit : null);
  }
  const skillParents = skills.map((s) => path.dirname(s.dir)).filter((d) => path.basename(d) === 'skills');
  if (want('claude')) claudeValidate([...new Set([...plugins, ...skillParents])], ctx);
  if (want('spec') && skills.length) ghSkillPublish(skills, ctx);
  if (want('copilot') && (skills.length || instructions.length)) copilotLists(skills, instructions, ctx);
  if (want('codex') && skills.length) codexSkills(skills, ctx);
  if (want('codex') && codexConfigs.length) codexDoctor(codexConfigs, ctx);
  const wazaExe = want('copilot') && skills.length ? whichFn('waza') : null;
  for (const s of want('copilot') ? skills : []) {
    const name = s.name || path.basename(s.dir);
    const evalFile = [path.join(root, 'evals', name, 'eval.yaml'), path.join(s.dir, 'evals', 'eval.yaml')].find((f) => fs.existsSync(f));
    const command = `waza spec verify ${rel(s.dir)} ${evalFile ? rel(evalFile) : `evals/${name}/eval.yaml`} --fail`;
    if (!wazaExe || !evalFile) {
      push('waza', rel(s.dir), 'skipped', command, !wazaExe ? 'waza is not on PATH' : 'no eval.yaml for this skill');
      continue;
    }
    const r = exec(wazaExe, ['spec', 'verify', s.dir, evalFile, '--fail'], { cwd: root });
    const [status, line] = [statusOf(r), firstLine(`${r.stdout}\n${r.stderr}`)];
    push('waza', rel(s.dir), status, command, line || status, status !== 'fail' ? []
      : [{ abs: s.file, host: 'copilot', rule: 'EXT-WAZA', severity: 'warning', message: `waza spec verify: ${line || 'failed'}` }], r.exit);
  }
  return out;
}

function claudeValidate(dirs, { exec, whichFn, version, push, rel, first, root }) {
  const exe = dirs.length ? whichFn('claude') : null;
  const v = exe ? version('claude') : null;
  for (const dir of dirs) {
    const [tool, command] = ['claude plugin validate', `claude plugin validate ${rel(dir)} --strict --json`];
    const skip = !exe ? 'claude is not on PATH' : !v?.version || !versionGte(v.version, '2.1.259')
      ? `Claude Code ${v?.version || '?'} is older than 2.1.259 (no --json)` : null;
    if (skip) { push(tool, rel(dir), 'skipped', command, skip); continue; }
    const r = exec(exe, ['plugin', 'validate', dir, '--strict', '--json'], { cwd: root });
    let report = null;
    try { report = JSON.parse(r.stdout); } catch {}
    const res = isObj(report) && r.exit !== 2 && r.exit !== null ? claudeReport(report, dir) : undefined;
    if (res === undefined) push(tool, rel(dir), 'error', command, first(r) || 'no JSON report', [], r.exit);
    else if (res === null) push(tool, rel(dir), 'not-applicable', command, 'a bare skills directory is not validated', [], r.exit);
    else push(tool, rel(dir), res.status, command, res.summary, res.findings, r.exit);
  }
}

function ghSkillPublish(skills, { exec, whichFn, version, push, rel, first, root }) {
  const [tool, command] = ['gh skill publish', `gh skill publish --dry-run ${rel(root)}`];
  const ghSkills = skills.filter((s) => GH_DISCOVERS.test(toPosix(path.relative(root, s.dir))));
  const exe = ghSkills.length ? whichFn('gh') : null;
  const v = exe ? version('gh') : null;
  if (!ghSkills.length) return push(tool, '.', 'not-applicable', command, 'no linted skill is where gh skill publish looks');
  if (!exe) return push(tool, '.', 'skipped', command, 'gh is not on PATH');
  if (!v?.version || !versionGte(v.version, '2.90.0')) return push(tool, '.', 'skipped', command, `gh ${v?.version || '?'} < 2.90.0`);
  const r = exec(exe, ['skill', 'publish', '--dry-run', root], { cwd: root });
  // Output lines are "<error|warning>\t<skill>\t<message>"; repository-level lines have no skill.
  const lines = [...`${r.stdout}\n${r.stderr}`.matchAll(/^(error|warning)\t([^\t\n]*)\t(.+)$/gm)].map(([, sev, name, msg]) =>
    ({ sev, name, msg: msg.trim(), s: name ? ghSkills.find((x) => x.name === name || path.basename(x.dir) === name) : null }));
  const findings = lines.filter((l) => l.s).map((l) => ({ abs: l.s.file, host: 'spec', rule: 'EXT-GH-SKILL',
    severity: l.sev === 'error' ? 'error' : 'note', message: `gh skill publish --dry-run: ${l.msg}` }));
  const errors = findings.filter((f) => f.severity === 'error').length;
  const status = r.exit === 0 ? 'pass' : errors ? 'fail' : 'error';
  const head = status === 'pass' ? 'dry run passed' : errors ? `${errors} validation error(s)` : first(r) || 'gh failed';
  push(tool, '.', status, command, [head, ...lines.filter((l) => !l.name).map((l) => `${l.sev}: ${l.msg}`)].join('; '),
    findings, r.exit);
}

function copilotLists(skills, instructions, { exec, whichFn, push, rel, root, env, home, failOf }) {
  const cpSkills = skills.filter((s) => listedFrom(s, hostSkillRoots('copilot', root, env, home)));
  const cpInstructions = instructions.filter((f) => CP_LISTED.test(toPosix(path.relative(root, f))));
  const exe = cpSkills.length || cpInstructions.length ? whichFn('copilot') : null;
  const both = 'copilot skill list --json; copilot instruction list --json';
  if (!cpSkills.length && !cpInstructions.length) return push('copilot', '.', 'not-applicable', both, 'no file in a listed location');
  if (!exe) return push('copilot', '.', 'skipped', both, 'copilot is not on PATH');
  for (const [kind, list] of [['skill', cpSkills], ['instruction', cpInstructions]].filter(([, l]) => l.length)) {
    const r = exec(exe, [kind, 'list', '--json'], { cwd: root, timeoutMs: 60_000 });
    let rows = null;
    try { const j = JSON.parse(r.stdout); rows = [j, j?.skills, j?.instructions].find(Array.isArray) || null; } catch {}
    const listed = (rows || []).filter((x) => x.sourcePath).map((x) => path.resolve(root, String(x.sourcePath)));
    const findings = !rows ? [] : kind === 'skill' ? listingFindings(list, rows, { host: 'copilot', rule: 'EXT-COPILOT-SKILL',
      tool: 'copilot skill list', here: (x, s) => x.path && samePath(String(x.path), s.dir), missing: ' in its skill folder',
      other: (n, o) => `Copilot loads "${n}" from ${o.path ? rel(o.path) : o.source || '?'} (first found wins); not this copy` })
      : list.filter((f) => !listed.some((l) => samePath(l, f))).map((f) => ({ abs: f, host: 'copilot',
        rule: 'EXT-COPILOT-INSTRUCTION', severity: 'warning', message: 'copilot instruction list does not show this file' }));
    const summary = rows ? `${rows.length} listed` : firstLine(r.stderr) || 'no JSON output';
    push(`copilot ${kind} list`, '.', rows ? failOf(findings) : 'error', `copilot ${kind} list --json`, summary, findings, r.exit);
  }
}

function codexSkills(skills, { exec, whichFn, push, rel, first, root, env, home, failOf }) {
  const command = 'codex debug prompt-input "x"';
  const cxSkills = skills.filter((s) => listedFrom(s, hostSkillRoots('codex', root, env, home)));
  const exe = cxSkills.length ? whichFn('codex') : null;
  if (!cxSkills.length) return push('codex', '.', 'not-applicable', command, 'no linted skill in a Codex-listed .agents/skills');
  if (!exe) return push('codex', '.', 'skipped', command, 'codex is not on PATH');
  // Renders the model input locally (no model call, no sign-in needed) and lists the discovered skills.
  const r = exec(exe, ['debug', 'prompt-input', 'x'], { cwd: root, timeoutMs: 60_000 });
  const listed = r.exit === 0 ? codexListedSkills(r.stdout) : null;
  const findings = listed ? listingFindings(cxSkills, listed, { host: 'codex', rule: 'EXT-CODEX-SKILL',
    tool: 'codex debug prompt-input', here: (x, s) => samePath(x.file, s.file), missing: ' (disabled, invalid or not found)',
    other: (n, o) => `Codex lists "${n}" from ${rel(o.file)}; this copy is not the one it uses` }) : [];
  push('codex', '.', listed ? failOf(findings) : 'error', command, listed ? `${listed.length} skill(s) listed`
    : first(r) || 'no <skills_instructions> block in the output', findings, r.exit);
}

/** `codex exec --strict-config` would bill a model turn; `codex doctor --json` lists ignored settings for free. */
function codexDoctor(configs, { exec, whichFn, push, rel, first, root }) {
  const [tool, command, exe] = ['codex doctor', 'codex doctor --json', whichFn('codex')];
  if (!exe) return configs.forEach((f) => push(tool, rel(f), 'skipped', command, 'codex is not on PATH'));
  const r = exec(exe, ['doctor', '--json'], { cwd: root, timeoutMs: 60_000 });
  let report = null;
  try { report = JSON.parse(r.stdout); } catch {}
  const load = isObj(report?.checks?.['config.load']) ? report.checks['config.load'] : null;
  const details = isObj(load?.details) ? load.details : {};
  const ignored = [...String(details['startup warning'] || '').matchAll(/^[ \t]*(\S+) \((.+)\): `([^`]+)` is ignored/gm)]
    .map(([, layer, file, key]) => ({ layer, file, key }));
  const loaded = strs(details['config.toml'], ignored.map((x) => x.file));
  for (const f of configs) {
    const findings = ignored.filter((x) => samePath(x.file, f)).map((x) => ({ abs: f, host: 'codex', rule: 'EXT-CODEX-CONFIG',
      severity: 'warning', message: `codex doctor: Codex ignores \`${x.key}\` (unrecognized ${x.layer} setting)` }));
    if (!load) push(tool, rel(f), 'error', command, first(r) || 'no config.load check in the report', [], r.exit);
    else if (findings.length) push(tool, rel(f), 'fail', command, `${findings.length} unrecognized setting(s)`, findings, r.exit);
    else if (loaded.some((x) => samePath(x, f))) push(tool, rel(f), 'pass', command, 'no unrecognized settings', [], r.exit);
    else push(tool, rel(f), 'not-applicable', command, 'not loaded by Codex here (a project layer needs trust)', [], r.exit);
  }
}

// ---------------------------------------------------------------------------
// Public API

const LINTERS = { 'skill': lintSkill, 'codex-skill-meta': lintOpenaiYaml, 'instructions': lintInstructions,
  'agent': lintAgent, 'command': lintCommandOrPrompt, 'prompt': lintCommandOrPrompt, 'hooks': lintHooksOrSettings,
  'settings': lintHooksOrSettings, 'plugin': lintPlugin, 'marketplace': lintMarketplace, 'mcp': lintMcp,
  'codex-config': lintCodexConfig };

function summarize(run, files, external) {
  const results = files.flatMap((f) => f.host_results);
  const count = (st) => external.filter((e) => e.status === st).length;
  const [errors, warnings, notes] = ['errors', 'warnings', 'notes'].map((k) => results.reduce((n, r) => n + r[k].length, 0));
  const security = run.security.length;
  const securityErrors = run.security.filter((x) => x.severity === 'error').length;
  return { files: files.length, errors, warnings, notes, security, security_errors: securityErrors, hosts: run.selected,
    strict: run.strict, external: { ran: count('pass') + count('fail') + count('error'), passed: count('pass'),
      failed: count('fail'), errors: count('error'), skipped: count('skipped'), not_applicable: count('not-applicable') },
    clean: errors === 0 && securityErrors === 0 && (!run.strict || (warnings === 0 && security === 0)) };
}

/**
 * Lint tooling files and directories (async). Options: host ('all' | 'spec' | 'copilot' | 'claude' | 'codex'),
 * strict (spec-only frontmatter; warnings fail), root (the repository root for relative paths and project context),
 * external (run the installed validators), allowHosts (HTTP hook allowlist), env, home. Returns { root, files[{path,
 * kind, sub, scope, reads[], host_results[{host, errors[], warnings[], notes[]}]}], security[], external[], summary }.
 */
export async function lintPaths(paths = [], opts = {}) {
  const { host = 'all', strict = false, env = process.env, home = os.homedir(), allowHosts = [], external = false } = opts;
  if (!['all', ...HOSTS].includes(host)) throw usageError(`--host must be all, copilot, claude or codex (got "${host}")`);
  if (!RULES.length) throw envError('LINT_CATALOG', 'references/tooling-lint.md has no rule table; reinstall the skill');
  const list = [paths].flat().filter(Boolean);
  const first = list[0] ? path.resolve(list[0]) : process.cwd();
  const root = path.resolve(opts.root || repoRoot(statOrNull(first)?.isDirectory() ? first : path.dirname(first))
    || process.cwd());
  const display = (abs) => {
    const r = path.relative(root, abs);
    return !r ? '.' : r.startsWith('..') || path.isAbsolute(r) ? toPosix(abs) : toPosix(r);
  };
  const run = { selected: host === 'all' ? [...HOSTS] : strict && host !== 'spec' ? [host, 'spec'] : [host], root, home,
    strict: Boolean(strict), allowHosts: new Set([...LOOPBACK, ...allowHosts.map((h) => String(h).toLowerCase())]),
    files: [], security: [], secSeen: new Set(), directives: [], display };
  const targets = new Map();
  for (const p of list.length ? list : [root]) {
    const abs = path.resolve(root, p);
    const st = statOrNull(abs);
    if (!st) throw usageError(`path not found: ${toPosix(p)}`);
    const unknown = { kind: 'unknown', sub: null, scope: 'project', reads: [] };
    const found = st.isDirectory() ? discover(abs, { root, env, home })
      : [{ abs, ...(classify(abs, { root, env, home, sniff: true }) || unknown) }];
    for (const f of found) if (!targets.has(path.resolve(f.abs))) targets.set(path.resolve(f.abs), f);
  }
  const internal = [];
  for (const t of targets.values()) {
    const fl = new FileLint(run, t.abs, t);
    run.files.push(fl);
    try { LINTERS[t.kind]?.(fl); } catch (err) { internal.push({ file: fl.path, message: String(err?.message || err) }); }
  }
  crossInstructionChecks(run);
  const ext = external ? mergeExternal(run, opts) : [];
  const files = run.files.map((f) => f.toJSON());
  return { root: toPosix(root), files, security: run.security, external: ext, summary: summarize(run, files, ext),
    ...(internal.length && { internal_errors: internal }) };
}

function mergeExternal(run, opts) {
  const of = (pred) => run.files.filter((f) => pred(f.cls));
  const ext = runExternalValidators({ root: run.root, hosts: run.selected, env: opts.env || process.env, home: run.home,
    skills: of((c) => c.kind === 'skill').map((f) => ({ dir: path.dirname(f.abs), file: f.abs,
      name: parseFrontmatter(f.text).data?.name })),
    plugins: [...new Set(of((c) => /^(?:plugin|marketplace)$/.test(c.kind) && c.sub === 'claude')
      .map((f) => pluginRootOf(f.abs)))],
    instructions: of((c) => c.kind === 'instructions' && c.reads.includes('copilot')).map((f) => f.abs),
    codexConfigs: of((c) => c.kind === 'codex-config').map((f) => f.abs) }, opts);
  const byAbs = new Map(run.files.map((f) => [path.resolve(f.abs), f]));
  for (const e of ext) {
    for (const f of e.findings) {
      byAbs.get(path.resolve(f.abs))?.emit(f.rule, null, f.message, { only: [f.host], severity: f.severity });
    }
    e.findings = e.findings.map(({ abs, ...f }) => ({ ...f, message: redactSecrets(f.message), file: run.display(abs) }));
  }
  return ext;
}

/** Lint one skill directory (SKILL.md, agents/openai.yaml) for every host; async. Paths are repository-relative. */
export async function lintSkillDir(dir, { strict = false, host = 'all', external = false, ...rest } = {}) {
  const abs = path.resolve(dir);
  const name = fs.existsSync(path.join(abs, 'SKILL.md')) ? 'SKILL.md'
    : statOrNull(abs)?.isDirectory() && fs.readdirSync(abs).find((n) => n.toLowerCase() === 'skill.md');
  if (!name) throw usageError(`no SKILL.md in ${toPosix(abs)}`);
  const targets = [path.join(abs, name), path.join(abs, 'agents', 'openai.yaml')].filter((f) => fs.existsSync(f));
  return lintPaths(targets, { strict, host, external, root: repoRoot(abs) || abs, ...rest });
}

const summaryLine = (s) => `${s.files} file(s), ${s.errors} error(s), ${s.warnings} warning(s), ${s.notes} note(s), `
  + `${s.security} security finding(s) for ${s.hosts.join(', ')}${s.strict ? ' (strict)' : ''}`;

function renderHuman(res) {
  const item = (sev, host, x) => `  ${sev.padEnd(7)} ${host.padEnd(7)} ${x.rule}${x.line ? ` (line ${x.line})` : ''}: ${x.message}`;
  const lines = res.files.flatMap((f) => {
    const items = f.host_results.flatMap((r) => [['error', r.errors], ['warning', r.warnings], ['note', r.notes]]
      .flatMap(([sev, list]) => list.map((x) => item(sev, r.host, x))));
    return items.length ? [`${f.path} [${f.kind}]`, ...items] : [];
  });
  if (res.security.length) lines.push('security:');
  for (const s of res.security) lines.push(`  ${s.severity.padEnd(7)} ${s.rule} ${s.file}${s.line ? `:${s.line}` : ''}: ${s.message}`);
  for (const e of res.external) lines.push(`external ${e.tool} ${e.target}: ${e.status}${e.summary ? ` - ${e.summary}` : ''}`);
  return [...lines, summaryLine(res.summary)].join('\n');
}

export const lintCommand = defineCommand({
  name: 'tooling lint',
  usage: ['usage: adc.mjs tooling lint [paths...] [--host all|copilot|claude|codex] [--strict] [--no-external]',
    '                             [--allow-host <host>]',
    '  Lints instructions, skills, agents, prompt files, hooks, plugins and MCP configs against each host\'s rules.',
    '  No paths: the whole repository. --strict: only the six spec fields and block-style YAML; warnings fail.',
    '  --no-external (or ADC_LINT_NO_EXTERNAL=1): skip skills-ref, claude plugin validate, gh skill publish,',
    '  copilot skill/instruction list, codex debug prompt-input and doctor, waza (none runs a model turn).',
    '  --allow-host <host> (repeatable): HTTP hooks to this host are not a security finding.',
    '  Exit: 0 clean, 1 findings, 2 usage, 3 tracked .adc/ or missing rule catalog.'].join('\n'),
  options: { host: { type: 'string' }, strict: { type: 'boolean' }, 'no-external': { type: 'boolean' },
    'allow-host': { type: 'string', multiple: true } },
  async run(ctx, values, positionals) {
    const host = values.host || 'all';
    if (!['all', 'copilot', 'claude', 'codex'].includes(host)) {
      throw usageError(`--host must be all, copilot, claude or codex (got "${host}")`);
    }
    const gitRoot = repoRoot(ctx.cwd);
    if (gitRoot) assertStateUntracked(resolveStateDir({ cwd: ctx.cwd, stateDirOption: ctx.stateDirOption }));
    const external = !values['no-external'] && !/^(?:1|true|yes)$/i.test(process.env.ADC_LINT_NO_EXTERNAL || '');
    const res = await lintPaths(positionals.map((p) => path.resolve(ctx.cwd, p)),
      { host, strict: Boolean(values.strict), root: gitRoot || ctx.cwd, external, allowHosts: values['allow-host'] || [] });
    const exit = res.summary.clean ? EXIT.OK : EXIT.FINDINGS;
    return { result: res, exit, human: renderHuman(res), summary: summaryLine(res.summary) };
  },
});
