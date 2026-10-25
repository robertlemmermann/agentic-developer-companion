// Shared runtime for every adc.mjs command: options, output, errors, files, processes,
// globs, templates. Zero dependencies; Node 24+.

import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const SKILL_NAME = 'agentic-developer-companion';
export const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SCRIPTS_DIR = path.join(SKILL_DIR, 'scripts');
export const ADC_SCRIPT = path.join(SCRIPTS_DIR, 'adc.mjs');
export const ASSETS_DIR = path.join(SKILL_DIR, 'assets');
export const TEMPLATES_DIR = path.join(ASSETS_DIR, 'templates');
export const IS_WINDOWS = process.platform === 'win32';

export const EXIT = Object.freeze({ OK: 0, FINDINGS: 1, USAGE: 2, ENV: 3, UNVERIFIABLE: 4 });

// ---------------------------------------------------------------------------
// Errors

export class AdcError extends Error {
  constructor(exit, code, message, details) {
    super(message);
    this.exit = exit;
    this.code = code;
    this.details = details;
  }
}
export const usageError = (message, details) => new AdcError(EXIT.USAGE, 'USAGE', message, details);
export const envError = (code, message, details) => new AdcError(EXIT.ENV, code, message, details);
export const unverifiable = (code, message, details) => new AdcError(EXIT.UNVERIFIABLE, code, message, details);

// ---------------------------------------------------------------------------
// Version

let cachedVersion;
export function skillVersion() {
  if (cachedVersion) return cachedVersion;
  try {
    const text = fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8');
    const m = /^\s+version:\s*["']?([0-9][^"'\s]*)["']?\s*$/m.exec(text.split(/^---\s*$/m)[1] || '');
    cachedVersion = m ? m[1] : '0.0.0';
  } catch {
    cachedVersion = '0.0.0';
  }
  return cachedVersion;
}
export const generatedBy = () => `${SKILL_NAME} ${skillVersion()}`;

// ---------------------------------------------------------------------------
// Options, context, dispatch

export const GLOBAL_OPTIONS = Object.freeze({
  json: { type: 'boolean' },
  cwd: { type: 'string' },
  'state-dir': { type: 'string' },
  'dry-run': { type: 'boolean' },
  yes: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
});

/** Parse argv with the global options merged in. Throws a usage error (exit 2) on bad input. */
export function parseOpts(argv, options = {}, { positionals = true } = {}) {
  try {
    const { values, positionals: pos } = parseArgs({
      args: argv,
      options: { ...GLOBAL_OPTIONS, ...options },
      allowPositionals: positionals,
      strict: true,
    });
    return { values, positionals: pos };
  } catch (err) {
    throw usageError(err.message);
  }
}

/** Environment markers from plan §7.6 that make a command run non-interactively. */
export function headlessMarkers(values = {}, env = process.env) {
  const markers = [];
  if (values.yes) markers.push('--yes');
  for (const k of ['COPILOT_AGENT_PROMPT', 'GITHUB_COPILOT_API_TOKEN', 'CI', 'GITHUB_ACTIONS']) {
    if (env[k] && env[k] !== 'false' && env[k] !== '0') markers.push(k);
  }
  if (!process.stdin.isTTY) markers.push('no-tty');
  return markers;
}

/** Cloud agent or CI: no human can confirm anything, so writes that need consent refuse. */
export function isAutomation(env = process.env) {
  return ['COPILOT_AGENT_PROMPT', 'GITHUB_COPILOT_API_TOKEN', 'CI', 'GITHUB_ACTIONS']
    .some((k) => env[k] && env[k] !== 'false' && env[k] !== '0');
}

/** Agent sessions that run our scripts through their shell tool. */
export function agentMarkers(env = process.env) {
  const keys = ['COPILOT_AGENT_PROMPT', 'GITHUB_COPILOT_API_TOKEN', 'COPILOT_CLI', 'CLAUDECODE',
    'CLAUDE_CODE_ENTRYPOINT', 'CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED', 'CODEX_THREAD_ID'];
  return keys.filter((k) => env[k]);
}

/** A real controlling terminal: both TTYs, no --yes, no headless or agent markers (§10.3.2). */
export function isInteractiveTty(values = {}, env = process.env) {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY && !values.yes &&
    !isAutomation(env) && agentMarkers(env).length === 0);
}

/** Run class for the live budget (§10.3.1): 'interactive' | 'ci' | 'agent'. */
export function runClass(values = {}, env = process.env) {
  if (values.yes || agentMarkers(env).length) return 'agent';
  if (isInteractiveTty(values, env)) return 'interactive';
  if (env.GITHUB_ACTIONS || env.CI) return 'ci';
  return 'agent';
}

export function makeContext(values = {}) {
  const cwd = path.resolve(values.cwd || process.cwd());
  if (!fs.existsSync(cwd)) throw usageError(`--cwd does not exist: ${cwd}`);
  const markers = headlessMarkers(values);
  return {
    cwd,
    json: Boolean(values.json) || !process.stdout.isTTY,
    yes: Boolean(values.yes),
    dryRun: Boolean(values['dry-run']),
    stateDirOption: values['state-dir'] || null,
    headless: markers.length > 0,
    headlessMarkers: markers,
    automation: isAutomation(),
    interactiveTty: isInteractiveTty(values),
    runClass: runClass(values),
    values,
  };
}

/**
 * Define a command. `run(ctx, values, positionals)` returns
 * `{ result, exit = 0, summary = '', human? }` or throws an AdcError.
 */
export function defineCommand({ name, usage = '', options = {}, positionals = true, run }) {
  const handler = async (argv) => {
    const { values, positionals: pos } = parseOpts(argv, options, { positionals });
    if (values.help) return { result: { usage: usage || name }, exit: EXIT.OK, human: usage || name, summary: '' };
    const ctx = makeContext(values);
    return run(ctx, values, pos);
  };
  handler.commandName = name;
  handler.usage = usage;
  return handler;
}

/** A command whose first positional selects a subcommand defined with defineCommand. */
export function defineGroup({ name, usage = '', subcommands, defaultSub = null }) {
  const handler = async (argv) => {
    const sub = argv[0] && !argv[0].startsWith('-') ? argv[0] : defaultSub;
    const rest = argv[0] === sub ? argv.slice(1) : argv;
    if (!sub || sub === 'help') {
      const text = usage || `${name} <${Object.keys(subcommands).join('|')}>`;
      return { result: { usage: text, subcommands: Object.keys(subcommands) }, exit: sub ? EXIT.OK : EXIT.USAGE, human: text, summary: '' };
    }
    const fn = subcommands[sub];
    if (!fn) throw usageError(`unknown ${name} subcommand "${sub}" (expected ${Object.keys(subcommands).join(', ')})`);
    return fn(rest);
  };
  handler.commandName = name;
  handler.usage = usage;
  return handler;
}

/** Called by adc.mjs for every non-hook command. Returns the process exit code. */
export async function dispatch(command, argv, loader, exportName) {
  const wantsJson = argv.includes('--json') || !process.stdout.isTTY;
  try {
    const mod = await loader();
    const handler = mod[exportName];
    if (typeof handler !== 'function') throw envError('NOT_IMPLEMENTED', `command "${command}" is not available in this build`);
    const res = (await handler(argv)) || {};
    const exit = typeof res.exit === 'number' ? res.exit : EXIT.OK;
    if (wantsJson) process.stdout.write(asciiJson(res.result ?? {}) + '\n');
    else process.stdout.write((typeof res.human === 'string' ? res.human : asciiJson(res.result ?? {})) + '\n');
    if (res.summary) process.stderr.write(`${command}: ${res.summary}\n`);
    return exit;
  } catch (err) {
    if (!(err instanceof AdcError)) throw err;
    const payload = { error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } };
    if (wantsJson) process.stdout.write(asciiJson(payload) + '\n');
    process.stderr.write(`${command}: ${err.message}\n`);
    return err.exit;
  }
}

// ---------------------------------------------------------------------------
// JSON and text

/** JSON with every non-ASCII character escaped as \uXXXX (Windows console safety). */
export function asciiJson(value, indent = 2) {
  return JSON.stringify(value, null, indent).replace(/[\u007f-￿]/g,
    (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

export function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function readText(file, fallback = null) {
  try { return stripBom(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

export function readJson(file, fallback = null) {
  const text = readText(file);
  if (text == null) return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}

export function truncate(text, max) {
  if (text == null) return text;
  const s = String(text);
  return s.length <= max ? s : s.slice(0, Math.max(0, max - 3)) + '...';
}

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');
export const nonce = () => randomBytes(16).toString('hex');
export const nowIso = () => new Date().toISOString();
/** Filesystem-safe UTC timestamp, e.g. 20261025T171243Z. */
export const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
export const today = (d = new Date()) => d.toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Paths and files

export const toPosix = (p) => String(p).replace(/\\/g, '/');

/** Repo-relative POSIX path, or null when `file` is outside `root`. */
export function relPosix(root, file) {
  const rel = path.relative(root, path.resolve(root, file));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return rel === '' ? '.' : null;
  return toPosix(rel);
}

export function ensureDir(dir, mode) {
  fs.mkdirSync(dir, { recursive: true, ...(mode ? { mode } : {}) });
  return dir;
}

/** Write via a temp file and rename, so readers never see a partial file. */
export function writeFileAtomic(file, data, { mode } = {}) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, data, mode ? { mode } : undefined);
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return file;
    } catch (err) {
      // Windows: the target can be briefly locked by a scanner or another reader.
      if (attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes(err.code)) {
        try { fs.rmSync(tmp, { force: true }); } catch {}
        throw err;
      }
      sleepSync(20 * (attempt + 1));
    }
  }
}

export const writeJsonAtomic = (file, value, opts) => writeFileAtomic(file, asciiJson(value) + '\n', opts);

export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Exclusive lock via openSync(..., 'wx'); a lock older than staleMs is broken.
 * `fn` runs while the lock is held; its result is returned.
 */
export async function withLock(lockFile, fn, { staleMs = 30_000, waitMs = 10_000 } = {}) {
  ensureDir(path.dirname(lockFile));
  const deadline = Date.now() + waitMs;
  let fd;
  for (;;) {
    try {
      fd = fs.openSync(lockFile, 'wx');
      fs.writeSync(fd, `${process.pid} ${nowIso()}\n`);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        const age = Date.now() - fs.statSync(lockFile).mtimeMs;
        if (age > staleMs) { fs.rmSync(lockFile, { force: true }); continue; }
      } catch { continue; }
      if (Date.now() > deadline) throw envError('LOCK_TIMEOUT', `could not acquire ${lockFile}`);
      sleepSync(50);
    }
  }
  try {
    return await fn();
  } finally {
    try { fs.closeSync(fd); } catch {}
    try { fs.rmSync(lockFile, { force: true }); } catch {}
  }
}

const DEFAULT_WALK_IGNORE = new Set(['.git', 'node_modules', '.adc', '.venv', 'venv', '__pycache__',
  'target', 'dist', 'build', 'bin', 'obj', '.next', '.turbo', '.tox', 'vendor', 'coverage']);

/** Recursive file list (POSIX paths relative to root), skipping heavy or generated folders. */
export function listFiles(root, { ignore = DEFAULT_WALK_IGNORE, maxFiles = 50_000, maxDepth = 12 } = {}) {
  const out = [];
  const walk = (dir, depth) => {
    if (out.length >= maxFiles || depth > maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (ignore.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.isFile()) out.push(toPosix(path.relative(root, full)));
      if (out.length >= maxFiles) return;
    }
  };
  walk(root, 0);
  return out;
}

// ---------------------------------------------------------------------------
// Globs (minimal: **, *, ?, {a,b}, [abc]); matched against POSIX paths

const globCache = new Map();
export function globToRegExp(glob) {
  if (globCache.has(glob)) return globCache.get(glob);
  let g = toPosix(glob.trim());
  if (g.startsWith('./')) g = g.slice(2);
  let re = '';
  let inGroup = 0;
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        const slashAfter = g[i + 2] === '/';
        re += slashAfter ? '(?:.*/)?' : '.*';
        i += slashAfter ? 2 : 1;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') { re += '(?:'; inGroup++; }
    else if (c === '}' && inGroup) { re += ')'; inGroup--; }
    else if (c === ',' && inGroup) re += '|';
    else if (c === '[') {
      const end = g.indexOf(']', i + 1);
      if (end === -1) re += '\\[';
      else { re += '[' + g.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\') + ']'; i = end; }
    } else re += c.replace(/[.+^$()|\\]/g, '\\$&');
  }
  // A glob without a slash matches at any depth (gitignore-style basename match).
  const anchored = g.includes('/') ? `^${re}$` : `^(?:.*/)?${re}$`;
  const rx = new RegExp(anchored);
  globCache.set(glob, rx);
  return rx;
}

export const matchGlob = (file, glob) => globToRegExp(glob).test(toPosix(file));
export const matchAny = (file, globs = []) => globs.some((g) => matchGlob(file, g));

// ---------------------------------------------------------------------------
// Processes

const MAX_BUFFER = 512 * 1024 * 1024;

function finish(res, started) {
  return {
    exit: typeof res.status === 'number' ? res.status : null,
    signal: res.signal || null,
    stdout: res.stdout == null ? '' : String(res.stdout),
    stderr: res.stderr == null ? '' : String(res.stderr),
    ms: Date.now() - started,
    error: res.error ? (res.error.code || res.error.message) : null,
    timedOut: Boolean(res.error && res.error.code === 'ETIMEDOUT'),
  };
}

/** Run an executable without a shell. Never throws; inspect `.exit` / `.error`. */
export function run(cmd, args = [], { cwd, env, input, timeoutMs = 0, maxBuffer = MAX_BUFFER } = {}) {
  const started = Date.now();
  const res = spawnSync(cmd, args, {
    cwd, env: env || process.env, input, encoding: 'utf8', windowsHide: true,
    timeout: timeoutMs || undefined, maxBuffer,
  });
  return finish(res, started);
}

/**
 * Run a command line through the platform shell (cmd.exe on Windows, /bin/sh elsewhere).
 * Used for project commands such as `npm ci && npx vitest run`, where `.cmd` shims must work.
 */
export function runShell(commandLine, { cwd, env, input, timeoutMs = 0, maxBuffer = MAX_BUFFER } = {}) {
  const started = Date.now();
  const res = spawnSync(commandLine, {
    cwd, env: env || process.env, input, encoding: 'utf8', windowsHide: true, shell: true,
    timeout: timeoutMs || undefined, maxBuffer,
  });
  return finish(res, started);
}

/** Absolute path of an executable on PATH (honors PATHEXT on Windows), or null. */
export function which(name, env = process.env) {
  if (!name) return null;
  if (name.includes('/') || name.includes('\\')) return fs.existsSync(name) ? name : null;
  const dirs = String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  const exts = IS_WINDOWS ? ['', ...String(env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').map((e) => e.toLowerCase())] : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        const st = fs.statSync(candidate);
        if (st.isFile()) return candidate;
      } catch {}
    }
  }
  return null;
}

export function parseVersion(text) {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(text || ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] || 0)] : null;
}

export function versionGte(actual, minimum) {
  const a = Array.isArray(actual) ? actual : parseVersion(actual);
  const b = Array.isArray(minimum) ? minimum : parseVersion(minimum);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return true;
}

/** `{ path, version, raw }` for a tool on PATH, or null when absent. `.cmd` shims run via the shell. */
export function toolVersion(name, args = ['--version'], { timeoutMs = 10_000 } = {}) {
  const exe = which(name);
  if (!exe) return null;
  const needsShell = IS_WINDOWS && /\.(cmd|bat)$/i.test(exe);
  const res = needsShell
    ? runShell([quoteArg(exe), ...args.map(quoteArg)].join(' '), { timeoutMs })
    : run(exe, args, { timeoutMs });
  const raw = (res.stdout || res.stderr || '').trim();
  const v = parseVersion(raw);
  return { path: toPosix(exe), version: v ? v.join('.') : null, raw: truncate(raw.split(/\r?\n/)[0] || '', 200) };
}

/** Quote one argument for the platform shell used by runShell. */
export function quoteArg(arg) {
  const s = String(arg);
  if (s && /^[A-Za-z0-9_\-+=.,/:@%]+$/.test(s)) return s;
  if (IS_WINDOWS) return '"' + s.replace(/"/g, '""') + '"';
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/** Per-repository directory under the OS temp dir (worktrees never live inside the repo). */
export function tmpRoot(key) {
  return path.join(os.tmpdir(), `adc-${sha256(String(key)).slice(0, 8)}`);
}

// ---------------------------------------------------------------------------
// Secrets: literal-value redaction (used for loaded credentials; shape regexes live in markers.mjs)

/** Replace every raw, URL-encoded and base64 occurrence of each secret value. */
export function redactLiterals(text, secrets = []) {
  if (text == null) return text;
  let out = String(text);
  for (const { name, value } of secrets) {
    if (!value || String(value).length < 4) continue;
    const v = String(value);
    const forms = new Set([v, encodeURIComponent(v), Buffer.from(v).toString('base64'),
      Buffer.from(v).toString('base64').replace(/=+$/, ''), Buffer.from(v).toString('base64url')]);
    for (const form of forms) {
      if (form.length >= 4) out = out.split(form).join(`[REDACTED:${name}]`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Template bundles (assets/templates/<name>.tmpl)
//
// Format: optional leading "#" comment lines, then sections that each start with
//   @@@ file: <relative/path> [key=value ...] @@@
// Content runs until the next header. `{{var}}` placeholders are replaced by renderString;
// a placeholder without a value is an error, so templates and callers cannot drift.

const SECTION_RE = /^@@@ file: (\S+)((?: [A-Za-z0-9_-]+=[^\s@]+)*) @@@$/;

export function parseBundle(text) {
  const lines = stripBom(text).split(/\r?\n/);
  const sections = [];
  let cur = null;
  for (const line of lines) {
    const m = SECTION_RE.exec(line);
    if (m) {
      if (cur) sections.push(cur);
      const attrs = {};
      for (const pair of m[2].trim().split(/\s+/).filter(Boolean)) {
        const [k, v] = pair.split('=');
        attrs[k] = v;
      }
      cur = { path: m[1], attrs, lines: [] };
    } else if (cur) cur.lines.push(line);
  }
  if (cur) sections.push(cur);
  return sections.map((s) => {
    while (s.lines.length && s.lines[s.lines.length - 1] === '') s.lines.pop();
    return { path: s.path, attrs: s.attrs, content: s.lines.join('\n') + '\n' };
  });
}

export function loadBundle(name) {
  const file = path.join(TEMPLATES_DIR, `${name}.tmpl`);
  const text = readText(file);
  if (text == null) throw envError('TEMPLATE_MISSING', `template bundle not found: ${toPosix(file)}`);
  return parseBundle(text);
}

/** Sections whose attributes all agree with `filter` (attributes absent from a section match anything). */
export function selectSections(sections, filter = {}) {
  return sections.filter((s) => Object.entries(filter).every(([k, v]) => {
    if (!(k in s.attrs)) return true;
    return String(s.attrs[k]).split('|').includes(String(v));
  }));
}

export function renderString(template, vars = {}) {
  return template.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (_, key) => {
    if (!(key in vars) || vars[key] == null) throw envError('TEMPLATE_VAR', `template variable "${key}" has no value`);
    return String(vars[key]);
  });
}
