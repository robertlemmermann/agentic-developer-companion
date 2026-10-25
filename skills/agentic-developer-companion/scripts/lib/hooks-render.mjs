// `hooks render` / `setup hooks` (§8.4, §8.5): render the hook templates in assets/hooks/ for one
// host with the installed skill path, merge them into the host's config file (never overwrite,
// always back up), record what was added in `.adc/hooks-installed.json`, remove exactly that
// again, and list what is registered on this machine for `doctor`.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ASSETS_DIR, EXIT, SKILL_DIR, AdcError, defineCommand, defineGroup, envError, nowIso, readJson, readText, relPosix,
  run, stamp, toPosix, usageError, writeFileAtomic, writeJsonAtomic, IS_WINDOWS,
} from './core.mjs';
import { repoRoot } from './git.mjs';
import { prepareStateDir, resolveStateDir, statePaths } from './state.mjs';

export const HOSTS = Object.freeze(['copilot', 'copilot-cloud', 'claude', 'codex']);
export const SCOPES = Object.freeze(['user', 'project']);
export const LEVELS = Object.freeze(['advise', 'gate', 'guard']);
export const HOOK_FILE_NAME = 'agentic-developer-companion.json';
const SKILL_NAME = 'agentic-developer-companion';
const TEMPLATE = {
  copilot: 'copilot.hooks.json',
  'copilot-cloud': 'copilot.cloud.hooks.json',
  claude: 'claude.settings.hooks.json',
  codex: 'codex.hooks.json',
};
const HOOK_RUN_RE = /hook-run\s+([a-z-]+)\s+--dialect\s+([a-z]+)(?:\s+--level\s+([a-z]+))?/;
const OURS_RE = /adc\.mjs["']?\s+hook-run\b/;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => JSON.parse(JSON.stringify(v));

// ---------------------------------------------------------------------------
// Locations

/** Per-host config homes, honoring COPILOT_HOME, CLAUDE_CONFIG_DIR and CODEX_HOME. */
export function hostHomes({ env = process.env, home = null } = {}) {
  // Windows hosts use the profile directory; HOME there may be an MSYS path from Git Bash.
  const h = home || (IS_WINDOWS ? env.USERPROFILE : env.HOME) || os.homedir();
  return {
    copilot: env.COPILOT_HOME ? path.resolve(env.COPILOT_HOME) : path.join(h, '.copilot'),
    claude: env.CLAUDE_CONFIG_DIR ? path.resolve(env.CLAUDE_CONFIG_DIR) : path.join(h, '.claude'),
    codex: env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(h, '.codex'),
  };
}

/** The config file `--write` targets for a host and scope. */
export function targetFile(host, scope, { root = null, env = process.env, home = null } = {}) {
  const homes = hostHomes({ env, home });
  if (host === 'copilot-cloud' || (host === 'copilot' && scope === 'project')) {
    return root ? path.join(root, '.github', 'hooks', HOOK_FILE_NAME) : null;
  }
  if (host === 'copilot') return path.join(homes.copilot, 'hooks', HOOK_FILE_NAME);
  if (host === 'claude') return scope === 'project' ? (root ? path.join(root, '.claude', 'settings.local.json') : null) : path.join(homes.claude, 'settings.json');
  if (host === 'codex') return scope === 'project' ? (root ? path.join(root, '.codex', 'hooks.json') : null) : path.join(homes.codex, 'hooks.json');
  return null;
}

/** Host guess from the environment of the calling session (§8.4 step 1), or null. */
export function guessHost(env = process.env) {
  if (env.COPILOT_AGENT_PROMPT || env.GITHUB_COPILOT_API_TOKEN) return 'copilot-cloud';
  if (env.COPILOT_CLI) return 'copilot';
  if (env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT) return 'claude';
  if (Object.keys(env).some((k) => k.startsWith('CODEX_'))) return 'codex';
  return null;
}

// ---------------------------------------------------------------------------
// Quoting

const bashQuote = (s) => `"${String(s).replace(/(["\\$`])/g, '\\$1')}"`;
const psQuote = (s) => `"${String(s).replace(/([`"$])/g, '`$1')}"`;
const plainQuote = (s) => `"${s}"`;
const portableUnsafe = (s) => /["$`%!]/.test(s);
const needsQuote = (s) => /[^A-Za-z0-9_\-+=.,/:@\\]/.test(s);

function loadTemplate(host) {
  const file = path.join(ASSETS_DIR, 'hooks', TEMPLATE[host]);
  const text = readText(file);
  if (text == null) throw envError('TEMPLATE_MISSING', `hook template not found: ${toPosix(file)}`);
  try { return JSON.parse(text); } catch (err) { throw envError('TEMPLATE_INVALID', `hook template is not valid JSON: ${toPosix(file)}: ${err.message}`); }
}

const winAbs = (p) => /^[A-Za-z]:[\\/]/.test(String(p));

/** The skill path written into commands: absolute POSIX, or repo-relative for vendored copies. */
function skillPathFor(host, scope, skillDir, root, warnings) {
  // A Windows path rendered on another OS (snapshot tests, a config prepared for a colleague) is kept as given.
  const foreign = winAbs(skillDir) && !IS_WINDOWS;
  const abs = foreign ? toPosix(skillDir) : toPosix(path.resolve(skillDir));
  const inRepo = root && !foreign ? relPosix(root, skillDir) : null;
  if (host === 'copilot-cloud') {
    if (inRepo && inRepo !== '.') return { value: inRepo, relative: true };
    for (const d of ['.github/skills', '.agents/skills', '.claude/skills']) {
      if (root && fs.existsSync(path.join(root, d, SKILL_NAME, 'scripts', 'adc.mjs'))) return { value: `${d}/${SKILL_NAME}`, relative: true };
    }
    warnings.push(`the skill is not vendored in this repository; the cloud agent can only run hooks from a committed copy: copy the skill to .github/skills/${SKILL_NAME}/ and commit it (the rendered commands already point there)`);
    return { value: `.github/skills/${SKILL_NAME}`, relative: true };
  }
  if (host === 'copilot' && scope === 'project') {
    if (inRepo && inRepo !== '.') return { value: inRepo, relative: true };
    warnings.push(`the skill lives outside this repository (${abs}); this project hooks file references your machine's path, so do not commit it (vendor the skill or use --host copilot-cloud for a committable file)`);
  }
  if (host === 'codex' && scope === 'project') {
    warnings.push(`.codex/hooks.json names this machine's skill path (${abs}); keep it uncommitted, since colleagues' copies live elsewhere`);
  }
  return { value: abs, relative: false };
}

/**
 * The 8.3 short form of an existing Windows file (`C:\PROGRA~1\nodejs\node.exe`), or null when the
 * volume keeps no short names or the lookup fails. A short path needs no quotes, so one bare
 * command runs under cmd.exe, Windows PowerShell, pwsh and Git Bash alike.
 */
export function windowsShortPath(file, runner = run) {
  const res = runner('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `(New-Object -ComObject Scripting.FileSystemObject).GetFile('${String(file).replace(/'/g, "''")}').ShortPath`], { timeoutMs: 15_000 });
  const out = String(res.stdout || '').trim().split(/\r?\n/).pop() || '';
  return res.exit === 0 && /^[A-Za-z]:\\[^\s"'`$%!&|<>^]+$/.test(out) ? out : null;
}

/** Node invocations per field kind for the bare `node` or an absolute path. */
function nodeForms(nodePath, warnings, host, scope, shortPath = null) {
  if (!nodePath) {
    return {
      bashTest: 'command -v node >/dev/null 2>&1', bash: 'node',
      psTest: 'Get-Command node -ErrorAction SilentlyContinue', ps: '& node',
      exec: 'node', portable: 'node', windows: 'node', label: 'node',
    };
  }
  const posix = toPosix(nodePath);
  const win = winAbs(posix) ? posix.replace(/\//g, '\\') : posix;
  const quoted = needsQuote(posix);
  const shellForm = host === 'codex' || (host === 'claude' && scope === 'project');
  // Shell-form hosts on Windows: a short path avoids quoting that only one of the shells accepts.
  const short = quoted && shellForm && winAbs(posix) && shortPath ? shortPath(win) : null;
  if (short) {
    return {
      bashTest: `command -v ${bashQuote(posix)} >/dev/null 2>&1`, bash: bashQuote(posix),
      psTest: `Get-Command ${psQuote(posix)} -ErrorAction SilentlyContinue`, ps: `& ${psQuote(posix)}`,
      exec: posix, portable: toPosix(short), windows: short, label: posix,
    };
  }
  if (quoted && host === 'codex') warnings.push(`the Node path needs quoting (${posix}); Codex commandWindows is rendered for a PowerShell launcher (\`& "<node>"\`), which cmd.exe cannot run`);
  if (quoted && host === 'claude' && scope === 'project') warnings.push(`the Node path needs quoting (${posix}); this shell-form command works in sh and Git Bash but not in PowerShell; prefer user scope (exec form) or a Node path without spaces`);
  if (shellForm && portableUnsafe(posix)) warnings.push('the Node path contains $, `, %, ! or a quote; shell-form commands cannot quote it for every shell');
  return {
    bashTest: `command -v ${bashQuote(posix)} >/dev/null 2>&1`, bash: bashQuote(posix),
    psTest: `Get-Command ${psQuote(posix)} -ErrorAction SilentlyContinue`, ps: `& ${psQuote(posix)}`,
    exec: posix, portable: quoted ? bashQuote(posix) : posix, windows: quoted ? `& ${psQuote(win)}` : win, label: posix,
  };
}

function hookArgs(event, dialect, level) {
  const args = ['hook-run', event, '--dialect', dialect];
  if (event === 'stop' || event === 'pre-guard') args.push('--level', event === 'pre-guard' ? 'guard' : level);
  // The session brief names a non-default level so the agent is not surprised by a block.
  else if (event === 'session-start' && level !== 'advise') args.push('--level', level);
  return args;
}

/** The hook-run spec of a template entry or handler: `{event, dialect, level}` or null. */
function specOf(obj) {
  const strings = [];
  for (const k of ['bash', 'powershell', 'command', 'commandWindows']) if (typeof obj[k] === 'string') strings.push(obj[k]);
  if (Array.isArray(obj.args)) strings.push(obj.args.join(' '));
  for (const s of strings) {
    const m = HOOK_RUN_RE.exec(s);
    if (m) return { event: m[1], dialect: m[2], level: m[3] || null };
  }
  return null;
}

/** True for a config entry or handler that runs this skill's hook handler. */
export function isOurs(obj) {
  if (!isObj(obj)) return false;
  const strings = [];
  for (const k of ['bash', 'powershell', 'command', 'commandWindows', 'exec']) if (typeof obj[k] === 'string') strings.push(obj[k]);
  if (Array.isArray(obj.args)) strings.push(obj.args.map(String).join(' '));
  if (Array.isArray(obj.hooks)) return obj.hooks.some(isOurs);
  return strings.some((s) => OURS_RE.test(s) || (/adc\.mjs/.test(s) && /\bhook-run\b/.test(s)));
}

// ---------------------------------------------------------------------------
// Rendering

/**
 * Render the hook config for one host. Returns
 * `{host, scope, level, target_file, config, events, skill_path, node, next_steps, warnings, permission_rules}`.
 */
export function renderHooks({ host, scope = null, level = 'advise', nodePath = null, skillDir = SKILL_DIR, root = null, env = process.env, home = null,
  shortPath = IS_WINDOWS ? windowsShortPath : null } = {}) {
  if (!HOSTS.includes(host)) throw usageError(`--host must be one of ${HOSTS.join(', ')}`);
  if (!LEVELS.includes(level)) throw usageError(`--level must be one of ${LEVELS.join(', ')}`);
  const sc = scope || (host === 'copilot-cloud' ? 'project' : 'user');
  if (!SCOPES.includes(sc)) throw usageError(`--scope must be one of ${SCOPES.join(', ')}`);
  if (host === 'copilot-cloud' && sc !== 'project') throw usageError('--host copilot-cloud renders a repository file; use --scope project (the default for it)');
  if (sc === 'project' && !root) throw envError('NOT_A_REPO', 'project scope needs a Git repository (run inside it or pass --cwd)');
  const warnings = [];
  const skill = skillPathFor(host, sc, skillDir, root, warnings);
  let np = nodePath;
  if (np && host === 'copilot-cloud') {
    warnings.push('--node-path is ignored for copilot-cloud: a committed file must not name one machine\'s Node; the cloud agent and colleagues use the node on PATH');
    np = null;
  }
  const node = nodeForms(np, warnings, host, sc, shortPath);
  const script = `${skill.value}/scripts/adc.mjs`;
  if (/["$`%!]/.test(script) && (host === 'codex' || (host === 'claude' && sc === 'project'))) {
    warnings.push('the skill path contains $, `, %, ! or a quote; shell-form commands for this host cannot quote it for every shell');
  }
  const tpl = loadTemplate(host);
  const config = clone(tpl);
  const events = [];
  const keep = (spec) => spec && (spec.event !== 'pre-guard' || level === 'guard');

  if (host === 'copilot' || host === 'copilot-cloud') {
    for (const [ev, list] of Object.entries(config.hooks || {})) {
      const out = [];
      for (const entry of Array.isArray(list) ? list : []) {
        const spec = specOf(entry);
        if (!keep(spec)) continue;
        const args = hookArgs(spec.event, 'copilot', level).join(' ');
        const e = { ...entry };
        delete e.command;
        delete e.exec;
        delete e.args;
        e.bash = `${node.bashTest} && ${node.bash} ${bashQuote(script)} ${args} || echo {}`;
        e.powershell = `if (${node.psTest}) { $o = ${node.ps} ${psQuote(script)} ${args} 2>$null; if ($LASTEXITCODE -eq 0 -and $o) { $o } else { '{}' } } else { '{}' }; exit 0`;
        out.push(e);
        events.push({ host_event: ev, event: spec.event, matcher: entry.matcher || null });
      }
      if (out.length) config.hooks[ev] = out; else delete config.hooks[ev];
    }
  } else {
    const shellForm = host === 'claude' && sc === 'project';
    const dialect = host === 'claude' ? (shellForm ? 'auto' : 'claude') : 'codex';
    for (const [ev, groups] of Object.entries(config.hooks || {})) {
      const outGroups = [];
      for (const group of Array.isArray(groups) ? groups : []) {
        const handlers = [];
        for (const handler of Array.isArray(group.hooks) ? group.hooks : []) {
          const spec = specOf(handler);
          if (!keep(spec)) continue;
          const args = hookArgs(spec.event, dialect, level);
          const hd = { ...handler };
          if (host === 'claude' && !shellForm) {
            hd.command = node.exec;
            hd.args = [script, ...args];
          } else if (host === 'claude') {
            delete hd.args;
            hd.command = `${node.portable} ${plainQuote(script)} ${args.join(' ')}`;
          } else {
            hd.command = `${node.portable} ${plainQuote(script)} ${args.join(' ')}`;
            hd.commandWindows = `${node.windows} ${plainQuote(script)} ${args.join(' ')}`;
          }
          handlers.push(hd);
          events.push({ host_event: ev, event: spec.event, matcher: group.matcher || null });
        }
        if (handlers.length) outGroups.push({ ...group, hooks: handlers });
      }
      if (outGroups.length) config.hooks[ev] = outGroups; else delete config.hooks[ev];
    }
  }

  const target = targetFile(host, sc, { root, env, home });
  const permissionRules = level === 'guard' ? {
    claude: { file: toPosix(path.join(hostHomes({ env, home }).claude, 'settings.json')), permissions: { deny: ['Read(./.adc/**)', 'Edit(./.adc/**)'] } },
    copilot: { file: '~/.copilot/settings.json or .github/copilot/settings.json', permissions: { deny: ['Read(.adc/**)', 'Edit(.adc/**)'] }, note: 'path selectors in Copilot permission rules are unverified; keep the guard hook as the primary control' },
  } : null;
  return {
    host,
    scope: sc,
    level,
    target_file: target ? toPosix(target) : null,
    config,
    events,
    skill_path: skill.value,
    skill_path_relative: skill.relative,
    node: node.label,
    next_steps: nextSteps(host, sc, level, target, skill),
    warnings,
    permission_rules: permissionRules,
  };
}

function nextSteps(host, scope, level, target, skill) {
  const t = target ? toPosix(target) : '<target>';
  const steps = [];
  if (host === 'copilot') {
    steps.push(`Write it with --write (merged into ${t}, with a backup), or copy the config there yourself.`);
    steps.push('Copilot loads hook files at startup: restart Copilot CLI; in VS Code reload the window and use Session Target = Copilot. `/env` lists loaded hooks.');
    if (scope === 'project') steps.push('Repository hooks run only in a trusted folder (and in `copilot -p` only with --trust-folder or GITHUB_COPILOT_PROMPT_MODE_REPO_HOOKS=true).');
  } else if (host === 'copilot-cloud') {
    steps.push(`Commit ${t} and the vendored skill (${skill.value}/) to the default branch; the cloud agent reads hooks only from .github/hooks/*.json there.`);
    steps.push('Protect .github/hooks/** and the vendored skill with CODEOWNERS and branch protection: these files run on every colleague\'s machine that opens the repository with Copilot.');
    steps.push('The cloud agent honors the bash entries; Windows developers who open the repository use the powershell entries.');
  } else if (host === 'claude') {
    steps.push(`Write it with --write (merged into ${t}, with a backup), or merge the "hooks" block yourself.`);
    steps.push('Run /hooks in Claude Code to see them; settings-file hooks wait until workspace trust is accepted.');
    if (scope === 'project') steps.push('Copilot CLI and VS Code also read .claude/settings.local.json, so these entries are shell strings with --dialect auto; prefer user scope for the guard level (Copilot denies tool calls when a preToolUse hook fails to start).');
  } else if (host === 'codex') {
    steps.push(`Write it with --write (merged into ${t}, with a backup), or merge the "hooks" block yourself.`);
    steps.push('Open Codex and approve each new hook once in /hooks (new hooks need review before they run).');
    if (scope === 'project') steps.push('Project hooks load only when the project is trusted in your Codex config.');
    if (IS_WINDOWS) steps.push('Codex hooks on native Windows: confirm they fire with /hooks (support was disabled in 0.117 and re-enablement is undocumented).');
  }
  // Measured 2026-10-25: Copilot CLI 1.0.103 drops agentStop context and Codex 0.164 shows a Stop
  // systemMessage to the user only; Claude Code feeds Stop context back to the agent.
  if (level === 'advise' && host !== 'claude') steps.push(`Level advise: the end-of-turn notice ("edits are newer than the last ledger") ${host === 'codex' ? 'is shown to you, not to the agent' : 'is dropped by Copilot at agentStop'}; register --level gate if the agent itself should be stopped once per edit epoch.`);
  if (level === 'gate') steps.push('Level gate: the stop hook blocks completion once per edit epoch until a ledger newer than the last edit exists (`verify`).');
  if (level === 'guard') steps.push('Level guard: also denies force-push, history rewrites and host read/search/edit tools under .adc/; add the printed permission_rules where your host supports them. `ask` decisions become denials in the Copilot cloud agent and CLI autopilot.');
  steps.push('`node <skill>/scripts/adc.mjs doctor` (or `hooks list`) confirms the registration; remove it again with `setup hooks --remove`.');
  return steps;
}

// ---------------------------------------------------------------------------
// Merge, write, remove

function readConfigFile(file) {
  const text = readText(file);
  if (text == null) return { exists: false, data: null };
  if (!text.trim()) return { exists: true, data: {} };
  try {
    const data = JSON.parse(text);
    if (!isObj(data)) throw new Error('top level is not an object');
    return { exists: true, data, text };
  } catch (err) {
    throw envError('CONFIG_UNPARSABLE', `${toPosix(file)} is not valid JSON (${err.message}); fix or move it, nothing was changed`);
  }
}

/** Copy of `data` without this skill's entries; `removed` counts what was taken out. */
export function stripOurs(data, host) {
  const out = clone(data || {});
  let removed = 0;
  if (!isObj(out.hooks)) return { data: out, removed };
  const copilotShape = host === 'copilot' || host === 'copilot-cloud';
  for (const [ev, list] of Object.entries(out.hooks)) {
    if (!Array.isArray(list)) continue;
    let next;
    if (copilotShape) {
      next = list.filter((e) => { const ours = isOurs(e); if (ours) removed++; return !ours; });
    } else {
      next = [];
      for (const group of list) {
        if (!isObj(group) || !Array.isArray(group.hooks)) { next.push(group); continue; }
        const handlers = group.hooks.filter((hd) => { const ours = isOurs(hd); if (ours) removed++; return !ours; });
        if (handlers.length) next.push({ ...group, hooks: handlers });
      }
    }
    if (next.length) out.hooks[ev] = next; else delete out.hooks[ev];
  }
  return { data: out, removed };
}

/** Merge a rendered config into existing file data: our old entries are replaced, others kept. */
export function mergeConfig(existing, rendered) {
  const { data } = stripOurs(existing || {}, rendered.host);
  const out = data;
  if (rendered.host === 'copilot' || rendered.host === 'copilot-cloud') {
    if (out.version == null) out.version = rendered.config.version ?? 1;
  } else if (rendered.host === 'codex' && out.description == null && !existing) {
    out.description = rendered.config.description;
  }
  if (!isObj(out.hooks)) out.hooks = {};
  for (const [ev, list] of Object.entries(rendered.config.hooks || {})) {
    out.hooks[ev] = [...(Array.isArray(out.hooks[ev]) ? out.hooks[ev] : []), ...clone(list)];
  }
  return out;
}

const serialize = (data) => `${JSON.stringify(data, null, 2)}\n`;

function backupFile(file) {
  const dest = `${file}.adc-backup-${stamp()}`;
  fs.copyFileSync(file, dest);
  return dest;
}

/** Keep `.claude/settings.local.json` out of git via the repository's exclude file (not a committed change). */
function excludeLocalSettings(root, file) {
  const rel = relPosix(root, file);
  if (!rel) return null;
  const ignored = run('git', ['check-ignore', '-q', '--', rel], { cwd: root, timeoutMs: 5000 });
  if (ignored.exit === 0) return null;
  const res = run('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd: root, timeoutMs: 5000 });
  if (res.exit !== 0) return null;
  const exclude = path.resolve(root, res.stdout.trim());
  const current = readText(exclude, '') || '';
  if (current.split(/\r?\n/).includes(`/${rel}`)) return null;
  fs.mkdirSync(path.dirname(exclude), { recursive: true });
  fs.appendFileSync(exclude, `${current && !current.endsWith('\n') ? '\n' : ''}# agentic-developer-companion: local hook settings\n/${rel}\n`);
  return toPosix(exclude);
}

function recordFile(root, stateDirOption = null) {
  if (!root) return null;
  const info = resolveStateDir({ cwd: root, stateDirOption });
  return statePaths(info.dir).hooksInstalled;
}

function readRecords(root, stateDirOption = null) {
  const file = recordFile(root, stateDirOption);
  const data = file ? readJson(file, null) : null;
  return { file, entries: data && Array.isArray(data.entries) ? data.entries : [] };
}

function writeRecords(ctx, root, mutate) {
  if (!root) return null;
  const state = prepareStateDir({ ...(ctx || {}), cwd: root }, { create: true });
  const file = state.paths.hooksInstalled;
  const data = readJson(file, null) || {};
  const entries = mutate(Array.isArray(data.entries) ? data.entries : []);
  writeJsonAtomic(file, { schema: 'adc-hooks-installed/1', updated: nowIso(), entries });
  return toPosix(file);
}

/**
 * Merge `rendered` into its target file. Returns
 * `{target_file, written, created, backup_file, content, record_file, excluded}`; `dryRun` writes nothing.
 */
export function writeHooks(rendered, { root = null, backup = true, dryRun = false, ctx = null } = {}) {
  const file = rendered.target_file;
  if (!file) throw envError('NO_TARGET', 'no target file for this host and scope');
  const { exists, data } = readConfigFile(file);
  const merged = mergeConfig(exists ? data : null, rendered);
  const content = serialize(merged);
  const result = { target_file: toPosix(file), written: false, created: !exists, backup_file: null, content: merged, record_file: null, excluded: null };
  if (dryRun) return result;
  if (exists && backup) result.backup_file = toPosix(backupFile(file));
  writeFileAtomic(file, content);
  result.written = true;
  if (root && rendered.host === 'claude' && rendered.scope === 'project') result.excluded = excludeLocalSettings(root, file);
  try {
    result.record_file = writeRecords(ctx, root, (entries) => {
      const rest = entries.filter((e) => !(e.host === rendered.host && e.scope === rendered.scope && e.file === toPosix(file)));
      return [...rest, {
        host: rendered.host, scope: rendered.scope, level: rendered.level, file: toPosix(file),
        events: [...new Set(rendered.events.map((e) => e.host_event))],
        skill_path: rendered.skill_path, node: rendered.node, written_at: nowIso(),
        backup: result.backup_file, created_file: result.created,
      }];
    });
  } catch (err) {
    // A tracked or unwritable state dir must not undo a successful registration.
    result.record_error = err instanceof AdcError ? err.message : String(err.message || err);
  }
  return result;
}

/** Candidate config files per host and scope that may hold this skill's entries. */
export function knownConfigFiles({ root = null, env = process.env, home = null } = {}) {
  const homes = hostHomes({ env, home });
  const out = [];
  const listJson = (dir) => { try { return fs.readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) => path.join(dir, n)); } catch { return []; } };
  for (const f of listJson(path.join(homes.copilot, 'hooks'))) out.push({ host: 'copilot', scope: 'user', file: f, shape: 'copilot' });
  out.push({ host: 'copilot', scope: 'user', file: path.join(homes.copilot, 'settings.json'), shape: 'copilot' });
  out.push({ host: 'claude', scope: 'user', file: path.join(homes.claude, 'settings.json'), shape: 'nested' });
  out.push({ host: 'codex', scope: 'user', file: path.join(homes.codex, 'hooks.json'), shape: 'nested' });
  if (root) {
    for (const f of listJson(path.join(root, '.github', 'hooks'))) out.push({ host: 'copilot', scope: 'project', file: f, shape: 'copilot' });
    for (const n of ['settings.json', 'settings.local.json']) out.push({ host: 'copilot', scope: 'project', file: path.join(root, '.github', 'copilot', n), shape: 'copilot' });
    for (const n of ['settings.json', 'settings.local.json']) out.push({ host: 'claude', scope: 'project', file: path.join(root, '.claude', n), shape: 'nested' });
    out.push({ host: 'codex', scope: 'project', file: path.join(root, '.codex', 'hooks.json'), shape: 'nested' });
  }
  return out;
}

function ourEntriesIn(data, shape) {
  const found = [];
  if (!isObj(data) || !isObj(data.hooks)) return found;
  for (const [ev, list] of Object.entries(data.hooks)) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (shape === 'copilot') { if (isOurs(item)) found.push({ host_event: ev, entry: item, spec: specOf(item) }); continue; }
      if (!isObj(item) || !Array.isArray(item.hooks)) continue;
      for (const hd of item.hooks) if (isOurs(hd)) found.push({ host_event: ev, entry: { ...item, hooks: [hd] }, spec: specOf(hd) });
    }
  }
  return found;
}

const handlerOf = (entry) => (Array.isArray(entry.hooks) ? entry.hooks[0] || {} : entry);
const unescapeBash = (s) => s.replace(/\\(["$`\\])/g, '$1');

/** The skill directory a registered entry points at (as written: absolute or repo-relative). */
function skillPathOf(entry) {
  const h = handlerOf(entry);
  if (Array.isArray(h.args)) {
    for (const a of h.args) { const m = /^(.*)\/scripts\/adc\.mjs$/.exec(String(a)); if (m) return m[1]; }
  }
  for (const k of ['bash', 'command']) {
    if (typeof h[k] !== 'string') continue;
    const s = h[k];
    const q = /"((?:[^"\\]|\\.)*?)\/scripts\/adc\.mjs"/.exec(s);
    if (q) return unescapeBash(q[1]);
    const u = /(\S+?)\/scripts\/adc\.mjs\b/.exec(s);
    if (u) return u[1];
  }
  return null;
}

/** The Node executable a registered entry uses, or null for the bare `node`. */
function nodeOf(entry) {
  const h = handlerOf(entry);
  if (typeof h.command === 'string' && Array.isArray(h.args)) return h.command === 'node' ? null : h.command;
  const s = typeof h.bash === 'string' ? h.bash.replace(/^command -v /, '') : (typeof h.command === 'string' ? h.command : '');
  const m = /^(?:"((?:[^"\\]|\\.)*)"|(\S+))/.exec(s);
  if (!m) return null;
  const v = m[1] != null ? unescapeBash(m[1]) : m[2];
  return v === 'node' ? null : v;
}

/**
 * Every registration of this skill's hooks visible from `root` (user files plus the project's),
 * with the recorded entries of `.adc/hooks-installed.json` merged in:
 * `[{host, scope, file, events[], level, skill_paths[], recorded, present, matches_current}]`.
 */
export function listRegisteredHooks({ root = null, env = process.env, home = null, skillDir = SKILL_DIR } = {}) {
  const records = root ? readRecords(root).entries : [];
  const out = [];
  for (const cand of knownConfigFiles({ root, env, home })) {
    let parsed;
    try { parsed = readConfigFile(cand.file); } catch { out.push({ host: cand.host, scope: cand.scope, file: toPosix(cand.file), events: [], level: null, error: 'unparsable' }); continue; }
    if (!parsed.exists) continue;
    const found = ourEntriesIn(parsed.data, cand.shape);
    if (!found.length) continue;
    const skillPaths = [...new Set(found.map((f) => skillPathOf(f.entry)).filter(Boolean))];
    let host = cand.host;
    if (host === 'copilot' && cand.scope === 'project' && skillPaths.length && skillPaths.every((p) => !p.startsWith('/') && !/^[A-Za-z]:/.test(p))) host = 'copilot-cloud';
    const handlerEvents = found.map((f) => f.spec && f.spec.event).filter(Boolean);
    const stopSpec = found.find((f) => f.spec && f.spec.event === 'stop');
    const level = handlerEvents.includes('pre-guard') ? 'guard' : (stopSpec && stopSpec.spec.level) || 'advise';
    let matches = null;
    const resolveSkill = (p) => (path.isAbsolute(p) || winAbs(p) || !root ? p : path.join(root, p));
    try {
      // Compare with a fresh render for the same copy, level and Node: drift means the template
      // or the entries changed since registration.
      const nodeGuess = nodeOf(found[0].entry);
      const scope = host === 'copilot-cloud' ? 'project' : cand.scope;
      const fresh = renderHooks({ host, scope, level, nodePath: nodeGuess, skillDir: skillPaths[0] ? resolveSkill(skillPaths[0]) : skillDir, root, env, home });
      const want = ourEntriesIn(fresh.config, cand.shape).map((f) => JSON.stringify([f.host_event, f.entry])).sort();
      const have = found.map((f) => JSON.stringify([f.host_event, f.entry])).sort();
      matches = want.length === have.length && want.every((w, i) => w === have[i]);
    } catch { matches = null; }
    const recorded = records.some((r) => r.file === toPosix(cand.file));
    const here = toPosix(path.resolve(skillDir));
    out.push({
      host, scope: cand.scope, file: toPosix(cand.file),
      events: [...new Set(found.map((f) => f.host_event))],
      handlers: [...new Set(handlerEvents)],
      level, skill_paths: skillPaths, recorded, present: true, matches_current: matches,
      this_copy: skillPaths.length > 0 && skillPaths.every((p) => toPosix(path.resolve(resolveSkill(p))) === here),
    });
  }
  for (const r of records) {
    if (!out.some((o) => o.file === r.file)) out.push({ host: r.host, scope: r.scope, file: r.file, events: r.events || [], handlers: [], level: r.level || null, skill_paths: r.skill_path ? [r.skill_path] : [], recorded: true, present: false, matches_current: false });
  }
  return out;
}

/**
 * Remove this skill's entries. Uses `.adc/hooks-installed.json` first; when it lists nothing for
 * the selection, scans the known config files for entries that reference `adc.mjs hook-run`.
 * Returns `{removed: [{host, scope, file, entries, deleted_file, backup_file}], source}`.
 */
export function removeHooks({ host = null, scope = null, root = null, env = process.env, home = null, dryRun = false, ctx = null, backup = true } = {}) {
  if (host && !HOSTS.includes(host)) throw usageError(`--host must be one of ${HOSTS.join(', ')}`);
  if (scope && !SCOPES.includes(scope)) throw usageError(`--scope must be one of ${SCOPES.join(', ')}`);
  const records = root ? readRecords(root, ctx && ctx.stateDirOption).entries : [];
  const sel = (r) => (!host || r.host === host) && (!scope || r.scope === scope);
  let targets = records.filter(sel).map((r) => ({ host: r.host, scope: r.scope, file: r.file, created: r.created_file }));
  let source = 'record';
  if (!targets.length) {
    source = 'scan';
    targets = knownConfigFiles({ root, env, home }).filter((c) => (!host || c.host === host || (host === 'copilot-cloud' && c.host === 'copilot' && c.scope === 'project')) && (!scope || c.scope === scope))
      .map((c) => ({ host: c.host, scope: c.scope, file: toPosix(c.file), created: false }));
  }
  const removed = [];
  for (const t of targets) {
    const file = t.file;
    let parsed;
    try { parsed = readConfigFile(file); } catch (err) { removed.push({ ...t, entries: 0, error: err.message }); continue; }
    if (!parsed.exists) continue;
    const { data, removed: n } = stripOurs(parsed.data, t.host);
    if (!n) continue;
    const emptyHooks = !isObj(data.hooks) || Object.keys(data.hooks).length === 0;
    const ownFile = path.basename(file) === HOOK_FILE_NAME || t.created;
    const otherKeys = Object.keys(data).filter((k) => !['hooks', 'version', 'description'].includes(k) || (k === 'description' && data.description !== `${SKILL_NAME} hooks`));
    const deleteFile = emptyHooks && ownFile && otherKeys.length === 0;
    const item = { host: t.host, scope: t.scope, file, entries: n, deleted_file: deleteFile, backup_file: null };
    if (!dryRun) {
      // A file that held only this skill's entries needs no backup when it is deleted.
      if (backup && !deleteFile) item.backup_file = toPosix(backupFile(file));
      if (deleteFile) fs.rmSync(file, { force: true });
      else {
        if (emptyHooks && isObj(data.hooks)) delete data.hooks;
        writeFileAtomic(file, serialize(data));
      }
    }
    removed.push(item);
  }
  if (!dryRun && root && records.length) {
    try {
      writeRecords(ctx, root, (entries) => entries.filter((e) => !removed.some((r) => r.file === e.file && !r.error) && !(sel(e) && source === 'record')));
    } catch {}
  }
  return { removed, source };
}

// ---------------------------------------------------------------------------
// Commands

const RENDER_USAGE = [
  'hooks render --host copilot|copilot-cloud|claude|codex [--scope user|project] [--level advise|gate|guard]',
  '             [--node-path | --node <path>] [--skill-dir <dir>] [--write] [--remove] [--dry-run] [--json]',
  'Prints the hook config for the host and the file it belongs in. --write merges it there (with a',
  'backup; refused in CI and cloud-agent runs: headless hosts print only). --remove deletes exactly',
  'the entries this skill added. Defaults: --scope user, --level advise.',
].join('\n');

function humanRender(res) {
  const lines = [];
  if (res.removed) {
    lines.push(res.removed.length ? 'Removed:' : 'Nothing to remove.');
    for (const r of res.removed) lines.push(`  ${r.host} (${r.scope}) ${r.file}: ${r.entries} entr${r.entries === 1 ? 'y' : 'ies'}${r.deleted_file ? ', file deleted' : ''}${r.backup_file ? `, backup ${r.backup_file}` : ''}`);
    return lines.join('\n');
  }
  lines.push(`# ${res.host} hooks (${res.scope} scope, level ${res.level}) -> ${res.target_file}`);
  lines.push(JSON.stringify(res.config, null, 2));
  if (res.warnings.length) { lines.push('', 'Warnings:'); for (const w of res.warnings) lines.push(`  - ${w}`); }
  if (res.written) lines.push('', `Written: ${res.target_file}${res.backup_file ? ` (backup ${res.backup_file})` : ''}`);
  if (res.refused) lines.push('', `Not written: ${res.refused}`);
  lines.push('', 'Next steps:');
  for (const s of res.next_steps) lines.push(`  - ${s}`);
  if (res.permission_rules) lines.push('', 'Permission deny rules for the guard level:', JSON.stringify(res.permission_rules, null, 2));
  return lines.join('\n');
}

async function runRender(ctx, values) {
  const root = repoRoot(ctx.cwd);
  const env = process.env;
  if (values.remove) {
    if (ctx.automation && !ctx.dryRun) {
      const preview = removeHooks({ host: values.host || null, scope: values.scope || null, root, env, dryRun: true });
      return { result: { ...preview, refused: 'headless hosts: print only (rerun from an interactive session to remove)' }, exit: EXIT.OK, human: humanRender(preview), summary: 'remove refused in a headless run (printed only)' };
    }
    const res = removeHooks({ host: values.host || null, scope: values.scope || null, root, env, dryRun: ctx.dryRun, ctx });
    const n = res.removed.reduce((a, r) => a + (r.entries || 0), 0);
    return { result: { ...res, dry_run: ctx.dryRun }, exit: EXIT.OK, human: humanRender(res), summary: `${ctx.dryRun ? 'would remove' : 'removed'} ${n} hook entr${n === 1 ? 'y' : 'ies'} from ${res.removed.length} file(s)` };
  }
  const host = values.host || guessHost(env);
  if (!host) throw usageError('pass --host copilot|copilot-cloud|claude|codex (the host could not be guessed from the environment)');
  const nodePath = values.node || (values['node-path'] ? process.execPath : null);
  const skillDir = values['skill-dir'] ? path.resolve(ctx.cwd, values['skill-dir']) : SKILL_DIR;
  if (!fs.existsSync(path.join(skillDir, 'scripts', 'adc.mjs')) && host !== 'copilot-cloud') {
    throw usageError(`--skill-dir has no scripts/adc.mjs: ${toPosix(skillDir)}`);
  }
  const rendered = renderHooks({ host, scope: values.scope || null, level: values.level || 'advise', nodePath, skillDir, root, env });
  const res = { ...rendered, guessed_host: values.host ? undefined : host, written: false };
  if (values.write) {
    if (ctx.automation) {
      res.refused = 'headless hosts: print only (CI or cloud agent detected; registration needs a person to confirm)';
    } else {
      const w = writeHooks(rendered, { root, dryRun: ctx.dryRun, ctx });
      Object.assign(res, { written: w.written, created: w.created, backup_file: w.backup_file, record_file: w.record_file, excluded: w.excluded, ...(w.record_error ? { record_error: w.record_error } : {}) });
      if (ctx.dryRun) res.would_write = w.content;
    }
  }
  const what = res.written ? `written to ${res.target_file}` : res.refused ? 'not written (headless: print only)' : ctx.dryRun && values.write ? `would write ${res.target_file}` : `rendered for ${res.target_file}`;
  return { result: res, exit: EXIT.OK, human: humanRender(res), summary: `${host} hooks (${rendered.scope}, ${rendered.level}) ${what}` };
}

const RENDER_OPTIONS = {
  host: { type: 'string' }, scope: { type: 'string' }, level: { type: 'string' },
  'node-path': { type: 'boolean' }, node: { type: 'string' }, 'skill-dir': { type: 'string' },
  write: { type: 'boolean' }, remove: { type: 'boolean' },
};

export const renderCommand = defineCommand({ name: 'hooks render', usage: RENDER_USAGE, options: RENDER_OPTIONS, positionals: false, run: runRender });

export const listCommand = defineCommand({
  name: 'hooks list',
  usage: 'hooks list [--json]  (registered hooks of this skill: user config files plus the current repository)',
  positionals: false,
  run: async (ctx) => {
    const root = repoRoot(ctx.cwd);
    const hooks = listRegisteredHooks({ root });
    const human = hooks.length ? hooks.map((h) => `${h.host} (${h.scope}, ${h.level || '?'}) ${h.file}: ${h.events.join(', ')}${h.present === false ? ' [recorded, missing]' : ''}${h.matches_current === false ? ' [differs from current render]' : ''}`).join('\n') : 'No hooks of this skill are registered.';
    return { result: { hooks }, exit: EXIT.OK, human, summary: `${hooks.length} registration(s)` };
  },
});

export const hooksCommand = defineGroup({
  name: 'hooks',
  usage: 'hooks <render|list>\n\n' + RENDER_USAGE,
  subcommands: { render: renderCommand, list: listCommand },
});

/** `setup hooks ...` is the same command as `hooks render ...` (the name SKILL.md uses). */
export const setupCommand = defineGroup({
  name: 'setup',
  usage: 'setup hooks [--host ...] [--scope user|project] [--level advise|gate|guard] [--write] [--remove]',
  subcommands: { hooks: renderCommand },
});
