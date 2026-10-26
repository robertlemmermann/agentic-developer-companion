// Shared runtime for every adc.mjs command: options, output, errors, files, processes,
// globs, templates. Zero dependencies; Node 24+.

import { spawn, spawnSync } from 'node:child_process';
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

/**
 * A numeric option (`--timeout 600`): `def` when absent, else a positive number (`allowZero`:
 * non-negative; `integer`: whole numbers only). Anything else is a usage error (exit 2).
 */
export function numberOption(values, name, def = null, { integer = false, allowZero = false } = {}) {
  const raw = values ? values[name] : null;
  if (raw == null || String(raw).trim() === '') return def;
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n) || (allowZero ? n < 0 : n <= 0) || (integer && !Number.isInteger(n))) {
    const kind = `${allowZero ? 'non-negative' : 'positive'} ${integer ? 'integer' : 'number'}`;
    throw usageError(`--${name} must be a ${kind} (got "${raw}")`);
  }
  return n;
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

const HOOKS_HOST = {
  'copilot-cloud': 'copilot-cloud', 'copilot-cli': 'copilot', vscode: 'copilot',
  'claude-code': 'claude', codex: 'codex',
};

/**
 * The agent host running this process, from environment markers (§8.4), most specific first.
 * Returns `{ tool, hooks, markers[], candidates[] }`: `tool` is 'copilot-cloud' | 'copilot-cli' |
 * 'claude-code' | 'codex' | 'vscode' | 'unknown'; `hooks` is the hooks host ('copilot-cloud' |
 * 'copilot' | 'claude' | 'codex') or null; `candidates` lists every host with a marker.
 */
export function hostFromEnv(env = process.env) {
  const on = (k) => env[k] != null && env[k] !== '' && env[k] !== '0' && env[k] !== 'false';
  const keys = Object.keys(env).filter(on);
  const found = [];
  const add = (host, markers) => { if (markers.length) found.push({ host, markers }); };
  add('copilot-cloud', keys.filter((k) => k === 'COPILOT_AGENT_PROMPT' || k === 'GITHUB_COPILOT_API_TOKEN'));
  add('copilot-cli', keys.filter((k) => k === 'COPILOT_CLI'));
  // CLAUDE_CONFIG_DIR and CODEX_HOME are configuration that shell profiles set, not session markers.
  add('claude-code', keys.filter((k) => k === 'CLAUDECODE' || (k.startsWith('CLAUDE_') && k !== 'CLAUDE_CONFIG_DIR')));
  add('codex', keys.filter((k) => k.startsWith('CODEX_') && k !== 'CODEX_HOME'));
  add('vscode', keys.filter((k) => (k === 'TERM_PROGRAM' && env[k] === 'vscode') || k === 'VSCODE_IPC_HOOK_CLI'));
  const first = found[0] || null;
  return {
    tool: first ? first.host : 'unknown', hooks: first ? HOOKS_HOST[first.host] : null,
    markers: first ? first.markers : [], candidates: found.map((f) => f.host),
  };
}

/** Per-host config homes (absolute, native separators), honoring COPILOT_HOME, CLAUDE_CONFIG_DIR, CODEX_HOME. */
export function hostHomes({ env = process.env, home = null } = {}) {
  // Windows hosts use the profile directory; HOME there may be an MSYS path from Git Bash.
  const h = home || (IS_WINDOWS ? env.USERPROFILE : env.HOME) || os.homedir();
  return {
    home: h,
    copilot: env.COPILOT_HOME ? path.resolve(env.COPILOT_HOME) : path.join(h, '.copilot'),
    claude: env.CLAUDE_CONFIG_DIR ? path.resolve(env.CLAUDE_CONFIG_DIR) : path.join(h, '.claude'),
    codex: env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(h, '.codex'),
  };
}

export function makeContext(values = {}) {
  const given = path.resolve(values.cwd || process.cwd());
  if (!fs.existsSync(given)) throw usageError(`--cwd does not exist: ${given}`);
  // Resolved, so it compares equal to the repository root git reports (macOS /var -> /private/var).
  const cwd = realPath(given);
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
    const asksHelp = ['help', '--help', '-h'].includes(argv[0]);
    const sub = asksHelp ? 'help' : argv[0] && !argv[0].startsWith('-') ? argv[0] : defaultSub;
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

/** A plain object: not null, not an array. */
export const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** `v` as an array: arrays unchanged, null / undefined / '' as [], anything else wrapped. */
export const toArray = (v) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]);
/** Distinct values in first-seen order, without null, undefined and ''. */
export const uniq = (list) => [...new Set(list.filter((x) => x != null && x !== ''))];
/** First non-empty line of a text, trimmed ('' when there is none). */
export const firstLine = (text) => String(text ?? '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';
/** Last non-empty line of a text, trimmed (tool errors end with the line that matters). */
export const lastLine = (text) => String(text ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() || '';
/** 1-based line number of a character offset. */
export const lineOf = (text, index) => (index <= 0 ? 1 : String(text).slice(0, index).split('\n').length);
/** A value for a Markdown table cell: one line, pipes escaped, truncated. */
export const mdCell = (value, max = 160) =>
  truncate(String(value ?? '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|'), max);

/** Progress note on stderr (silenced by ADC_QUIET=1); stdout is reserved for the JSON result. */
export function log(msg) {
  if (process.env.ADC_QUIET !== '1') process.stderr.write(`adc: ${msg}\n`);
}

/** JSON Lines records (objects only); blank, non-JSON and non-object lines are skipped. */
export function parseJsonl(text) {
  const out = [];
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('{')) continue;
    try {
      const v = JSON.parse(line);
      if (isObj(v)) out.push(v);
    } catch {}
  }
  return out;
}

/**
 * JSON with recursively sorted keys: the hashed form of ledger records. `undefined` becomes
 * null in arrays and is dropped in objects; non-finite numbers become null (as JSON.stringify).
 */
export function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map((x) => canonicalJson(x === undefined ? null : x)).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
  }
  if (typeof v === 'number' && !Number.isFinite(v)) return 'null';
  return JSON.stringify(v === undefined ? null : v);
}

/** A Check (plan §9.2, the evidence ledger entry every QA step returns) with defaults for unset fields. */
export function makeCheck(fields) {
  return {
    id: null, fm: [], project: '.', status: 'unverified', reason: null, cost: 0, command: null, cwd: null,
    exit_code: null, duration_ms: null, summary: '', output_sha256: null, artifacts: [], findings: [], data: {},
    ...fields,
  };
}

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');
/** sha256 of a file's bytes, or null when it cannot be read. */
export function sha256File(file) {
  try { return sha256(fs.readFileSync(file)); } catch { return null; }
}
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
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return rel === '' ? '.' : null;
  return toPosix(rel);
}

/** Absolute on either platform: POSIX `/x`, a drive path `C:\x` or `C:/x` (also when parsed on Linux). */
export const isAbsolutePath = (p) => path.isAbsolute(String(p)) || /^[A-Za-z]:[\\/]/.test(String(p));

/** Symlinks resolved along the longest existing prefix (macOS /var → /private/var); the rest kept. */
export function realPath(p) {
  const abs = path.resolve(String(p));
  let cur = abs;
  const rest = [];
  for (let i = 0; i < 64; i++) {
    try { return path.join(fs.realpathSync.native(cur), ...rest.reverse()); } catch {}
    const parent = path.dirname(cur);
    if (parent === cur) return abs;
    rest.push(path.basename(cur));
    cur = parent;
  }
  return abs;
}

/** Same file system location (symlinks resolved; case-insensitive on Windows). */
export function samePath(a, b) {
  const x = toPosix(realPath(a));
  const y = toPosix(realPath(b));
  return IS_WINDOWS ? x.toLowerCase() === y.toLowerCase() : x === y;
}

export function statOrNull(p) {
  try { return fs.statSync(p); } catch { return null; }
}
export const isDir = (p) => Boolean(statOrNull(p)?.isDirectory());

/** The nearest directory from `start` upwards that contains `rel`, or null (`stopAt` is the last one tried). */
export function findUp(start, rel, { stopAt = null, maxDepth = 64 } = {}) {
  let d = path.resolve(start);
  for (let i = 0; i < maxDepth; i++) {
    if (fs.existsSync(path.join(d, rel))) return d;
    if (stopAt && path.resolve(d) === path.resolve(stopAt)) return null;
    const parent = path.dirname(d);
    if (parent === d) return null;
    d = parent;
  }
  return null;
}

/** A fresh `adc-<label>-XXXXXX` directory under the OS temp dir. */
export const makeTempDir = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `adc-${label}-`));

/** Text of a file argument relative to `cwd` (`-` reads stdin); a missing file is a usage error. */
export function readInput(arg, cwd = process.cwd(), { what = 'file' } = {}) {
  if (arg === '-') {
    try { return stripBom(fs.readFileSync(0, 'utf8')); } catch { return ''; }
  }
  const file = path.resolve(cwd, String(arg));
  const text = readText(file);
  if (text == null) throw usageError(`${what} not found: ${toPosix(file)}`);
  return text;
}

/** readInput parsed as JSON; invalid JSON is a usage error. */
export function readJsonInput(arg, cwd = process.cwd(), { what = 'file' } = {}) {
  const text = readInput(arg, cwd, { what });
  try { return JSON.parse(text); } catch { throw usageError(`${arg === '-' ? 'stdin' : arg} is not valid JSON`); }
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

/**
 * Recursive file list (POSIX paths relative to root, sorted per directory), skipping `ignore`d
 * names (heavy or generated folders by default). `followSymlinks` lists linked files and folders.
 */
export function listFiles(root, {
  ignore = DEFAULT_WALK_IGNORE, maxFiles = 50_000, maxDepth = 12, followSymlinks = false,
} = {}) {
  const out = [];
  const walk = (dir, depth) => {
    if (out.length >= maxFiles || depth > maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (ignore.has(e.name)) continue;
      const full = path.join(dir, e.name);
      const st = followSymlinks && e.isSymbolicLink() ? statOrNull(full) : e;
      if (!st) continue;
      if (st.isDirectory()) walk(full, depth + 1);
      else if (st.isFile()) out.push(toPosix(path.relative(root, full)));
      if (out.length >= maxFiles) return;
    }
  };
  walk(root, 0);
  return out;
}

// ---------------------------------------------------------------------------
// Globs (minimal: **, *, ?, {a,b}, [abc]); matched against POSIX paths

const globCache = new Map();
/** RegExp for a glob. `anchored`: a glob without a slash matches at the root only (no basename match). */
export function globToRegExp(glob, { anchored = false } = {}) {
  const key = anchored ? `\0${glob}` : glob;
  if (globCache.has(key)) return globCache.get(key);
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
  const rx = new RegExp(g.includes('/') || anchored ? `^${re}$` : `^(?:.*/)?${re}$`);
  globCache.set(key, rx);
  return rx;
}

export const matchGlob = (file, glob, opts) => globToRegExp(glob, opts).test(toPosix(file));
export const matchAny = (file, globs = [], opts) => globs.some((g) => matchGlob(file, g, opts));

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

/**
 * Windows: npm installs CLIs as `.cmd` shims (next to an extensionless sh script) and Node
 * cannot spawn those without a shell, so they become one quoted shell line. Elsewhere a no-op.
 */
function shimmed(cmd, args, shell) {
  if (!IS_WINDOWS || shell) return { cmd, args, shell };
  let file = String(cmd);
  if (!path.extname(file) && /[\\/]/.test(file)) {
    file = ['.exe', '.cmd', '.bat'].map((e) => file + e).find((f) => fs.existsSync(f)) || file;
  }
  if (!/\.(?:cmd|bat)$/i.test(file)) return { cmd: file, args, shell };
  return { cmd: [quoteArg(file), ...args.map(quoteArg)].join(' '), args: [], shell: true };
}

/** `run` for installed CLIs: Windows `.cmd`/`.bat` shims go through the shell. Never throws. */
export function runTool(exe, args = [], opts = {}) {
  const s = shimmed(exe, args, false);
  return s.shell ? runShell(s.cmd, opts) : run(s.cmd, s.args, opts);
}

/** `{ path, version, raw }` for a tool on PATH, or null when absent. `.cmd` shims run via the shell. */
export function toolVersion(name, args = ['--version'], { timeoutMs = 10_000 } = {}) {
  const exe = which(name);
  if (!exe) return null;
  const res = runTool(exe, args, { timeoutMs });
  const raw = (res.stdout || res.stderr || '').trim();
  const v = parseVersion(raw);
  return { path: toPosix(exe), version: v ? v.join('.') : null, raw: truncate(raw.split(/\r?\n/)[0] || '', 200) };
}

// Async processes: own process group (POSIX) so a timeout or Ctrl-C also ends grandchildren.

const ACTIVE = new Set();
const CLEANUPS = new Set();
let trapped = false;

/**
 * Kill a spawned child with its process group (POSIX: SIGTERM, then SIGKILL after `graceMs`;
 * 0 kills at once) or its tree (Windows: taskkill /T /F). The group is signalled even when the
 * leader already exited, because grandchildren holding the pipes would keep the run open.
 */
export function killTree(child, { graceMs = 2000 } = {}) {
  if (!child || child.pid == null) return;
  if (IS_WINDOWS) {
    const opts = { windowsHide: true, stdio: 'ignore' };
    if (child.exitCode === null) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], opts);
    return;
  }
  const signal = (sig) => { try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch {} } };
  if (graceMs <= 0) { signal('SIGKILL'); return; }
  signal('SIGTERM');
  setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, graceMs).unref();
}

/**
 * On SIGINT / SIGTERM: kill every running spawnCapture child, run the registered cleanups
 * (worktree removal, temp dirs), exit 130 / 143. Returns a function that unregisters `cleanup`.
 */
export function onInterrupt(cleanup = null) {
  if (cleanup) CLEANUPS.add(cleanup);
  if (!trapped) {
    trapped = true;
    for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
      process.on(sig, () => {
        for (const c of ACTIVE) killTree(c, { graceMs: 0 });
        for (const fn of CLEANUPS) { try { fn(); } catch {} }
        process.exit(code);
      });
    }
  }
  return () => { if (cleanup) CLEANUPS.delete(cleanup); };
}

/** Keeps the last `max` bytes; a cut drops the partial first line, so no half secret escapes redaction. */
function tailBuffer(max) {
  const chunks = [];
  let size = 0;
  let dropped = 0;
  return {
    push(buf) {
      chunks.push(buf);
      size += buf.length;
      while (size > max && chunks.length > 1) { const c = chunks.shift(); size -= c.length; dropped += c.length; }
    },
    text() {
      let buf = Buffer.concat(chunks);
      if (buf.length > max) { dropped += buf.length - max; buf = buf.subarray(buf.length - max); }
      let s = buf.toString('utf8');
      if (dropped) { const nl = s.indexOf('\n'); s = nl >= 0 ? s.slice(nl + 1) : ''; }
      return { text: s, dropped };
    },
  };
}

/**
 * Spawn without blocking: `command` with `args`, or a command line when `shell` is true
 * (Windows `.cmd` shims are wrapped automatically). Options: `cwd, env, input, timeoutMs`,
 * `maxBytes` (kept per stream, tail), `logFile` (append) / `captureFile` (truncate) receive both
 * streams in arrival order, `onLine(line)` sees stdout lines and may return 'stop' to end the
 * run early, `killGraceMs` (see killTree), `windowsVerbatimArguments`.
 * Resolves `{ exit, signal, stdout, stderr, ms, timedOut, stopped, truncated, error }`; never rejects.
 */
export function spawnCapture(command, args = [], {
  cwd, env, input = null, timeoutMs = 0, shell = false, maxBytes = 8 * 1024 * 1024, logFile = null, captureFile = null,
  onLine = null, killGraceMs = 2000, windowsVerbatimArguments = false,
} = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const s = shimmed(command, args, shell);
    const fds = [];
    let child;
    let timer = null;
    let timedOut = false;
    let stopped = false;
    let error = null;
    let done = false;
    const out = tailBuffer(maxBytes);
    const err = tailBuffer(maxBytes);
    let partial = '';
    const finish = (code, signal) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      ACTIVE.delete(child);
      for (const fd of fds) { try { fs.closeSync(fd); } catch {} }
      if (partial && onLine && !stopped) onLine(partial.replace(/\r$/, ''));
      const o = out.text();
      const e = err.text();
      resolve({
        exit: typeof code === 'number' ? code : null, signal: signal || null, stdout: o.text, stderr: e.text,
        ms: Date.now() - started, timedOut, stopped, truncated: Boolean(o.dropped || e.dropped), error,
      });
    };
    try {
      if (logFile) fds.push(fs.openSync(logFile, 'a'));
      if (captureFile) fds.push(fs.openSync(captureFile, 'w'));
      child = spawn(s.cmd, s.args, {
        cwd, env: env || process.env, shell: s.shell, windowsHide: true, detached: !IS_WINDOWS,
        windowsVerbatimArguments,
        stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      error = e.code || e.message;
      finish(null, null);
      return;
    }
    ACTIVE.add(child);
    onInterrupt();
    const tee = (buf) => { for (const fd of fds) { try { fs.writeSync(fd, buf); } catch {} } };
    child.stdout.on('data', (buf) => {
      out.push(buf);
      tee(buf);
      if (!onLine || stopped) return;
      partial += buf.toString('utf8');
      let nl;
      while (!stopped && (nl = partial.indexOf('\n')) >= 0) {
        const line = partial.slice(0, nl).replace(/\r$/, '');
        partial = partial.slice(nl + 1);
        if (onLine(line) === 'stop') { stopped = true; killTree(child, { graceMs: killGraceMs }); }
      }
    });
    child.stderr.on('data', (buf) => { err.push(buf); tee(buf); });
    if (input != null) { child.stdin.on('error', () => {}); child.stdin.end(input); }
    const expire = () => { timedOut = true; killTree(child, { graceMs: killGraceMs }); };
    if (timeoutMs > 0) timer = setTimeout(expire, timeoutMs);
    child.on('error', (e) => { error = e.code || e.message; finish(null, null); });
    child.on('close', finish);
  });
}

// ---------------------------------------------------------------------------
// Shell words: quoting and splitting

const SAFE_ARG = /^[A-Za-z0-9_\-+=.,/:@%]+$/;

/**
 * Quote one argument for a shell: 'sh' (single quotes), 'sh-double' (double quotes with
 * `"\$` + "`" escaped), 'pwsh' (single quotes, '' doubling), 'pwsh-double' (double quotes, backtick
 * escapes), 'cmd' (double quotes, "" doubling). Safe tokens stay bare unless `always`.
 */
export function quoteFor(shell, arg, { always = false } = {}) {
  const s = String(arg);
  if (!always && s && SAFE_ARG.test(s)) return s;
  if (shell === 'sh') return "'" + s.replace(/'/g, "'\\''") + "'";
  if (shell === 'sh-double') return `"${s.replace(/(["\\$`])/g, '\\$1')}"`;
  if (shell === 'pwsh') return `'${s.replace(/'/g, "''")}'`;
  if (shell === 'pwsh-double') return `"${s.replace(/([`"$])/g, '`$1')}"`;
  if (shell === 'cmd') return '"' + s.replace(/"/g, '""') + '"';
  throw new Error(`quoteFor: unknown shell "${shell}"`);
}

/** Quote one argument for the platform shell used by runShell. */
export const quoteArg = (arg) => quoteFor(IS_WINDOWS ? 'cmd' : 'sh', arg);

/**
 * POSIX-sh word splitting. `plain` mode knows only quotes (no escapes, operators or comments).
 * Returns `{ segments: [{ tokens, op }], unterminated }`.
 */
function scanShell(line, { redirects = 'drop', plain = false } = {}) {
  const segments = [];
  let seg = [];
  let tok = null;
  let dropNext = false;
  let unterminated = false;
  const push = () => {
    if (tok === null) return;
    if (dropNext) dropNext = false; else seg.push(tok);
    tok = null;
  };
  const end = (op) => { push(); dropNext = false; if (seg.length) segments.push({ tokens: seg, op }); seg = []; };
  const s = String(line ?? '').replace(/\r\n?/g, '\n');
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (c === "'" || (plain && c === '"')) {
      const e = s.indexOf(c, k + 1);
      if (e === -1) unterminated = true;
      tok = (tok ?? '') + (e === -1 ? s.slice(k + 1) : s.slice(k + 1, e));
      k = e === -1 ? s.length : e;
      continue;
    }
    if (plain) {
      if (/\s/.test(c)) push(); else tok = (tok ?? '') + c;
      continue;
    }
    if (c === '\\' && s[k + 1] === '\n') { k++; continue; }
    if (c === '"') {
      let j = k + 1;
      let part = '';
      while (j < s.length && s[j] !== '"') {
        if (s[j] === '\\' && j + 1 < s.length && '"\\$`\n'.includes(s[j + 1])) {
          part += s[j + 1] === '\n' ? '' : s[j + 1];
          j += 2;
        } else part += s[j++];
      }
      if (j >= s.length) unterminated = true;
      tok = (tok ?? '') + part;
      k = j;
      continue;
    }
    if (c === '\\') { tok = (tok ?? '') + (s[k + 1] ?? ''); k++; continue; }
    if (c === ' ' || c === '\t') { push(); continue; }
    if (c === '#' && tok === null) { while (k < s.length && s[k] !== '\n') k++; k--; continue; }
    if (c === '\n' || c === ';') { end(c === '\n' ? 'nl' : ';'); continue; }
    if (c === '(' && tok === null) { end('('); continue; }
    if (c === ')') { end(')'); continue; }
    if (c === '&' && s[k + 1] === '&') { end('&&'); k++; continue; }
    if (c === '|' && s[k + 1] === '|') { end('||'); k++; continue; }
    if (c === '|') { end('|'); continue; }
    if (c === '>' || c === '<' || (c === '&' && s[k + 1] === '>')) {
      // A redirection: `[n]>`, `>>`, `&>`, `<`, `n>&m`. Its target is the next word.
      let op = '';
      if (tok !== null && /^\d+$/.test(tok)) { op = tok; tok = null; } else push();
      op += c;
      while (s[k + 1] === '>' || (s[k + 1] === '&' && s[k + 2] !== '&')) op += s[++k];
      if (op.endsWith('&') && /[\d-]/.test(s[k + 1] ?? '')) { while (/[\d-]/.test(s[k + 1] ?? '')) op += s[++k]; }
      else dropNext = redirects === 'drop';
      if (redirects === 'keep') seg.push(op);
      continue;
    }
    if (c === '&') { end('&'); continue; }
    tok = (tok ?? '') + c;
  }
  end(null);
  return { segments, unterminated };
}

/**
 * Split a command line into simple commands: `[{ tokens, op }]` where `op` ends the segment
 * ('&&' '||' ';' '|' '&' 'nl' '(' ')' or null). Quotes and backslashes follow POSIX sh, comments
 * are dropped; redirections are dropped (`redirects: 'drop'`) or kept as an operator token
 * followed by its target (`'keep'`, for guards that must see `> .adc/x`).
 */
export const splitShell = (line, opts) => scanShell(line, opts).segments;

/** Words of an argv-style line (`--bin "node cli.js"`): quotes only, no shell features; null on an open quote. */
export function shellWords(line) {
  const r = scanShell(String(line ?? '').trim(), { plain: true });
  return r.unterminated ? null : r.segments.flatMap((x) => x.tokens);
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

const LIVE_SECRET_NAME = /^ADC_LIVE_TOKEN$|^ADC_LIVE_\w*(?:TOKEN|SECRET|KEY|PASSWORD)/;
// Built from parts so the skill tree carries no `NAME=value`-shaped token literal.
const TOKEN_REDACTED = ['ADC_LIVE_TOKEN', '[REDACTED]'].join('=');

/** Live-test credentials in `env` (ADC_LIVE_TOKEN, ADC_LIVE_*TOKEN|SECRET|KEY|PASSWORD) as redactLiterals input. */
/** The environment without live-test credentials, for every project or tool process we start. */
export function toolEnv(env = process.env) {
  const live = new Set(liveSecrets(env, { min: 1 }).map((s) => s.name));
  return live.size ? Object.fromEntries(Object.entries(env).filter(([k]) => !live.has(k))) : env;
}

export function liveSecrets(env = process.env, { min = 4 } = {}) {
  return Object.entries(env || {})
    .filter(([k, v]) => LIVE_SECRET_NAME.test(k) && typeof v === 'string' && v.trim().length >= min)
    .map(([name, value]) => ({ name, value: value.trim() }));
}

/**
 * The live-test token removed from tool output: the `ADC_LIVE_TOKEN=<value>` shape (§10.3.1),
 * its JSON/YAML form, the `Get-ChildItem Env:` table row, and the literal values of the
 * live credentials in `env` (8+ characters: shorter ones would mangle ordinary words).
 * Status text such as `ADC_LIVE_TOKEN: set (source: ...)` stays readable.
 */
export function redactLiveToken(text, env = {}) {
  if (text == null) return text;
  const out = String(text)
    .replace(/ADC_LIVE_TOKEN\s*=\s*\S+/g, TOKEN_REDACTED)
    .replace(/(["']?ADC_LIVE_TOKEN["']?\s*:\s*)(["'])[^"'\r\n]*\2/g, '$1$2[REDACTED]$2')
    .replace(/(["']?ADC_LIVE_TOKEN["']?\s*:[ \t]*)(?!["'\s[]|(?:set|unset)\b)[^\s,}]+/g, '$1[REDACTED]')
    .replace(/^(\s*ADC_LIVE_TOKEN[ \t]{2,})\S.*$/gm, '$1[REDACTED]');
  return redactLiterals(out, liveSecrets(env, { min: 8 }));
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

/**
 * Sections whose attributes agree with `filter` (`a|b` values list alternatives). Default: an
 * attribute absent from the section or the filter matches anything. `strict`: every section
 * attribute must be matched by the filter, except the `loose` (descriptive) ones. With a
 * `features` set, `when=` / `unless=` attributes test it.
 */
export function selectSections(sections, filter = {}, { strict = false, features = null, loose = [] } = {}) {
  return sections.filter((s) => Object.entries(s.attrs).every(([k, v]) => {
    const alts = String(v).split('|');
    if (features && k === 'when') return alts.some((a) => features.has(a));
    if (features && k === 'unless') return !alts.some((a) => features.has(a));
    if (loose.includes(k)) return true;
    if (filter[k] == null) return !strict;
    return alts.includes(String(filter[k]));
  }));
}

/**
 * Replace `{{var}}` placeholders; a missing value is an error. `actions: true` leaves GitHub
 * Actions expressions (`${{ github.ref }}`) untouched for workflow templates.
 */
export function renderString(template, vars = {}, { actions = false } = {}) {
  const kept = [];
  const keep = (m) => `\u0000${kept.push(m) - 1}\u0000`;
  const src = actions ? String(template).replace(/\$\{\{[\s\S]*?\}\}/g, keep) : String(template);
  const out = src.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (_, key) => {
    if (!(key in vars) || vars[key] == null) throw envError('TEMPLATE_VAR', `template variable "${key}" has no value`);
    return String(vars[key]);
  });
  return actions ? out.replace(/\u0000(\d+)\u0000/g, (_, i) => kept[Number(i)]) : out;
}
