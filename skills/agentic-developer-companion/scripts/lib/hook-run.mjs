// `adc.mjs hook-run <event>`: the hook handler (§8). Reads one JSON payload from stdin and
// returns one decision object; adc.mjs prints it exactly once and exits 0 (2 s watchdog).
// Performance contract: no git (except one `git ls-files` for the tracked-state check in
// session-start and before `git commit`/`git push` in the guard), no filesystem scans, no
// network; it reads `.adc/detect.json`, the newest ledger and the session file only, and
// imports only core, state, hook-dialects, markers and reports.

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  SKILL_DIR, globToRegExp, hostFromEnv, isAbsolutePath, nowIso, readJson, realPath, redactLiveToken, relPosix, sha256,
  splitShell, tmpRoot, toPosix, truncate, writeJsonAtomic,
} from './core.mjs';
import {
  STATE_DIR_NAME, createStateDir, ensureExcluded, hookLog, listLedgers, locateRepo, readSession, resolveStateDir,
  statePaths, trackedStateFiles, updateSession,
} from './state.mjs';
import * as M from './markers.mjs';
import { parseSummaryText } from './reports.mjs';
import {
  HOOK_EVENTS, LEVELS, detectDialect, extractContent, extractPaths, extractPatterns, formatOutput, normalizePayload,
  parsePatch, shellCommand,
} from './hook-dialects.mjs';

const STDIN_TIMEOUT_MS = 1200;
const STDIN_MAX_BYTES = 16 * 1024 * 1024;
const BRIEF_LIMIT = 1500;
const MAX_CONSECUTIVE_BLOCKS = 7; // hosts end the turn at 8 consecutive stop blocks
const KEEP = 50;
const TRACKED_TTL_MS = 12 * 60 * 60 * 1000;
const ADC_CMD = `node "${toPosix(SKILL_DIR)}/scripts/adc.mjs"`;
const debugOn = (env) => env.ADC_DEBUG === '1' || env.ADC_DEBUG === 'true';

// ---------------------------------------------------------------------------
// stdin

/** Read stdin to the end (or until the timeout); a TTY counts as empty, overflow is null. Never throws. */
export function readStdin({ timeoutMs = STDIN_TIMEOUT_MS, maxBytes = STDIN_MAX_BYTES, stream = process.stdin } = {}) {
  return new Promise((resolve) => {
    if (!stream || stream.isTTY) { resolve(Buffer.alloc(0)); return; }
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (overflow = false) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { stream.removeAllListeners('data'); stream.pause(); stream.destroy(); } catch {}
      resolve(overflow ? null : Buffer.concat(chunks));
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    try {
      stream.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) finish(true); else chunks.push(c);
      });
      stream.on('end', () => finish(false));
      stream.on('error', () => finish(false));
      stream.resume();
    } catch { finish(false); }
  });
}

/** Decode stdin bytes: UTF-8 (BOM stripped) or UTF-16 with a BOM (some PowerShell pipelines). */
export function decodeStdin(buf) {
  if (!buf || !buf.length) return '';
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf[0] === 0xfe && buf[1] === 0xff) return Buffer.from(buf.subarray(2)).swap16().toString('utf16le');
  const text = buf.toString('utf8');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

const PAYLOAD_KEYS = ['sessionId', 'session_id', 'hook_event_name', 'toolName', 'tool_name', 'cwd', 'timestamp',
  'transcriptPath', 'transcript_path', 'source', 'reason', 'stop_hook_active'];

/** The payload object, or null for empty, malformed, non-object or unrecognizable input (`{}`). */
export function parsePayload(text) {
  const t = String(text || '').trim();
  if (!t || t[0] !== '{') return null;
  try {
    const v = JSON.parse(t);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    return PAYLOAD_KEYS.some((k) => Object.hasOwn(v, k)) ? v : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// State, without git

/** State dir for a hook (--state-dir > ADC_HOME > <root>/.adc) with its symlink-resolved form and paths. */
export function hookStateInfo(repo, { stateDir = null, env = process.env } = {}) {
  const info = resolveStateDir({ root: repo.root, stateDirOption: stateDir, env });
  return { ...info, canonicalDir: realPath(info.dir), paths: statePaths(info.dir), ready: null };
}

/**
 * Make the state dir usable: the exclude entry first (git-free: <common git dir>/info/exclude,
 * the file `git rev-parse --git-path info/exclude` names), then the owner-only directory. False
 * when either cannot be written, in which case the hook records nothing.
 */
export function ensureHookState(info, repo) {
  if (info.ready == null) {
    try {
      const excludeFile = path.join(repo.commonDir, 'info', 'exclude');
      info.ready = ensureExcluded(info, { excludeFile }).ok && createStateDir(info);
    } catch {
      info.ready = false;
    }
  }
  return info.ready;
}

const trackedCacheFile = (repo) => path.join(tmpRoot(repo.root), 'state-tracked.json');

/**
 * Files under the state dir that git tracks (one `git ls-files`); null when git cannot tell.
 * The answer is cached outside the repository (OS temp dir) so the other hooks can honor it
 * without running git: while the state dir is tracked they print `{}` and write nothing.
 */
function trackedState(info, repo) {
  const files = trackedStateFiles(info, { timeoutMs: 1500, strict: true });
  if (files && info.insideRepo) {
    const record = { root: toPosix(repo.root), rel: info.rel, tracked: files.length, ts: nowIso() };
    try { writeJsonAtomic(trackedCacheFile(repo), record); } catch {}
  }
  return files;
}

/** The cached tracked-state answer from the last session-start or guard check (no git). */
function trackedCached(repo) {
  const c = readJson(trackedCacheFile(repo), null);
  if (!c || typeof c.tracked !== 'number' || Date.now() - (Date.parse(c.ts) || 0) > TRACKED_TTL_MS) return false;
  return c.tracked > 0;
}

/** The newest evidence ledger among the 5 most recently written: `{file, verdict, ts, finalized}` or null. */
export function newestLedger(evidenceDir) {
  const r = listLedgers(null, { evidenceDir, max: 5 })[0];
  return r ? { file: r.name, verdict: r.verdict, ts: r.created_at, finalized: r.finalized } : null;
}

// ---------------------------------------------------------------------------
// Classification and scanning (markers.mjs)

/** Path classes; `test` also from the cached detect.json test globs (markers.isTestFile). */
function classify(rel, detect) {
  const c = M.classifyPath(rel);
  return { ...c, test: c.test || M.isTestFile(rel, detect, { heuristic: false }) };
}

const CLASS_LABEL = { test: 'test file', runnerConfig: 'runner config', ci: 'CI', lockfile: 'lockfile',
  lintConfig: 'lint/type config', manifest: 'manifest', generated: 'generated' };
const classNames = (c) => Object.keys(CLASS_LABEL).filter((k) => c[k]);

/** Line `n` (1-based) of the scanned text in the edited file; null where a patch hunk gives no number. */
const mapLine = (lineMap, n) => (lineMap ? lineMap[n - 1] ?? null : n);

/**
 * Catalog hits in edited text. markers.scanText honors each entry's `langs` (by the file name),
 * masks comments for `code` entries and checks `next` for multi-line constructs, so a
 * commented-out `it.only`, a Python `# noqa` regex on a JS file or a catch block with a body
 * produce no note. `lineMap` maps scanned lines to file lines (patch hunks).
 */
export function scanEdit(text, catalog, file, lineMap = null) {
  if (!text) return [];
  return M.scanText(text, catalog, { file: file || undefined })
    .map((h) => ({ id: h.id, line: mapLine(lineMap, h.line), text: truncate(h.text, 80) }));
}

const secretsIn = (text, lineMap) => (text
  ? M.scanSecrets(text).map((r) => ({ id: r.id, line: mapLine(lineMap, r.line) })) : []);

const at = (x) => (x.line != null ? `at line ${x.line}` : 'in an added line');

// A manifest or runner-config line that is about running tests (scripts.test, addopts, test tasks).
const TEST_COMMAND_LINE = new RegExp('(?:^|[^\\w-])(?:tests?|spec|jest|vitest|mocha|ava|karma|playwright|cypress|pytest'
  + '|addopts|tox|nox|rspec|phpunit|nextest|ctest|check)(?:[^\\w-]|$)', 'i');

// ---------------------------------------------------------------------------
// Paths and the state dir

/** Absolute, symlink-resolved form of a tool path (relative paths resolve against the payload cwd). */
const absPath = (h, p) => realPath(isAbsolutePath(p) ? p : path.resolve(h.norm.cwd || h.root, p));

/** Is `abs` the state dir or inside it? (`path.relative` is case-insensitive on Windows.) */
function inStateDir(abs, st) {
  const r = path.relative(st.canonicalDir, abs);
  return r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
}

function underState(rel, abs, st) {
  if (rel && [STATE_DIR_NAME, st.rel].some((n) => n && (rel === n || rel.startsWith(`${n}/`)))) return true;
  return Boolean(abs) && inStateDir(abs, st);
}

/**
 * The part of a shell token after a state dir component (`''` for the dir itself), or null when it
 * names none. Case-insensitive: `.ADC/.env.live` is the same file on Windows and macOS volumes.
 */
function stateRemainder(token, st) {
  st.nameRes ??= [STATE_DIR_NAME, st.rel].filter(Boolean)
    .map((n) => new RegExp(`(?:^|[/=:'"])${RegExp.escape(n)}(/.*)?$`, 'i'));
  const t = toPosix(token);
  for (const re of st.nameRes) {
    const m = re.exec(t);
    if (m) return m[1] || '';
  }
  return null;
}

const mentionsState = (token, st) => stateRemainder(token, st) != null;

/** Does a shell token reach `.env.live`: the name itself, or a glob under the state dir that matches it? */
function tokenReachesEnvLive(token, st) {
  if (/\.env\.live\b/i.test(token)) return true;
  const rest = stateRemainder(token, st);
  return rest != null && /[*?[]/.test(rest) && globToRegExp(rest.replace(/^\/+/, '') || '*').test('.env.live');
}

// ---------------------------------------------------------------------------
// Shell parsing (guard and post-shell)

// Backslashes are path separators in PowerShell and cmd commands (and in the Windows paths agents
// pass to bash), so they become `/` before POSIX word splitting; escapes of whitespace, quotes,
// `$`, backticks and backslashes keep their meaning. Redirections stay visible (`> .adc/x`).
const shellSegments = (cmd) => splitShell(String(cmd).replace(/\\(?=[^\s"'$`\\])/g, '/'), { redirects: 'keep' })
  .map((s) => s.tokens);

const WRAPPERS = new Set(['sudo', 'command', 'exec', 'env', 'time', 'nohup', 'builtin', 'noglob', 'call']);
const REDIRECT = /^(?:\d*|&)[<>]/;
const exeName = (t) => toPosix(t).split('/').pop().toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '');

/** Drop env assignments, wrappers and leading redirections; the tokens starting at the executable. */
function commandTokens(tokens) {
  let i = 0;
  for (; i < tokens.length; i++) {
    const t = tokens[i];
    // `2>&1` duplicates a descriptor; every other redirection operator is followed by its target.
    if (REDIRECT.test(t)) { if (!/[<>]&[\d-]+$/.test(t)) i++; continue; }
    if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(t) && !WRAPPERS.has(t)) break;
  }
  return tokens.slice(i);
}

// The flag that introduces an inline script: sh -c / -lc / -ec, pwsh -c / -Command, cmd /c.
const SCRIPT_FLAG = {
  sh: /^-[a-z]*c[a-z]*$/, bash: /^-[a-z]*c[a-z]*$/, zsh: /^-[a-z]*c[a-z]*$/, dash: /^-[a-z]*c[a-z]*$/,
  pwsh: /^-(?:c|command)$/i, powershell: /^-(?:c|command)$/i, cmd: /^\/[ck]$/i,
};

/** Every simple command, with nested `sh -c "..."` / `pwsh -Command "..."` bodies expanded. */
function simpleCommands(cmd, depth = 0) {
  const out = [];
  for (const seg of shellSegments(cmd)) {
    const toks = commandTokens(seg);
    if (!toks.length) continue;
    out.push(toks);
    const flag = depth < 2 ? SCRIPT_FLAG[exeName(toks[0])] : null;
    const k = flag ? toks.findIndex((t, i) => i > 0 && flag.test(t)) : -1;
    if (k > 0 && toks[k + 1]) out.push(...simpleCommands(toks.slice(k + 1).join(' '), depth + 1));
  }
  return out;
}

const GIT_VALUE_OPTS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix',
  '--config-env']);

function gitParts(toks) {
  if (exeName(toks[0]) !== 'git') return null;
  let i = 1;
  const dirs = [];
  while (i < toks.length && toks[i].startsWith('-')) {
    if (toks[i] === '-C' && toks[i + 1] != null) dirs.push(toks[i + 1]);
    i += GIT_VALUE_OPTS.has(toks[i]) ? 2 : 1;
  }
  return i < toks.length ? { sub: toks[i], args: toks.slice(i + 1), dirs } : null;
}

/**
 * Would `git add --force <args>` pick up the state dir? True for `-A`/`--all` without a pathspec,
 * a glob pathspec, and a pathspec naming the state dir or a directory that contains it.
 */
function forceAddCoversState(h, g) {
  if (!h.st.insideRepo || !fs.existsSync(h.st.dir)) return false;
  const afterDd = g.args.indexOf('--');
  const specs = g.args.filter((a, i) => (afterDd >= 0 && i > afterDd) || (!a.startsWith('-') && a !== '--'));
  const all = g.args.some((a, i) => (afterDd < 0 || i < afterDd)
    && (a === '--all' || a === '--no-ignore-removal' || /^-[A-Za-z]*A[A-Za-z]*$/.test(a)));
  if (!specs.length) return all;
  const base = g.dirs.reduce((d, c) => path.resolve(d, c), h.norm.cwd || h.root);
  return specs.some((s) => {
    if (/[*?[]/.test(s)) return true;
    const top = /^:(?:\/|\(top\))/.exec(s);
    const target = top ? path.resolve(h.root, s.slice(top[0].length) || '.') : path.resolve(base, s);
    const r = path.relative(realPath(target), h.st.canonicalDir);
    return r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
  });
}

// Commands that read or copy a whole directory tree (a state dir argument exposes `.env.live`).
const TREE_READERS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'tar', 'zip', '7z', '7za', 'cp', 'rsync',
  'scp', 'select-string', 'sls', 'copy-item', 'cpi', 'copy', 'compress-archive', 'robocopy', 'xcopy', 'strings']);
const readsTree = (exe, toks) => TREE_READERS.has(exe)
  || (exe === 'find' && toks.some((t) => /^-(?:exec|execdir|ok|okdir)$/.test(t)));
const DELETERS = new Set(['rm', 'del', 'erase', 'unlink', 'rmdir', 'rd', 'remove-item', 'ri']);

// Command classes for observed runs (post-shell), tested on a normalized simple command.
const RUN_CLASSES = [
  ['companion', /\badc\.mjs\s+(?:verify|clean-run|typecheck|flake-probe|coverage-delta|mutation-scope|live)\b/],
  ['test', /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|t)(?::\S*)?(?:\s|$)/],
  ['test', new RegExp('^(?:npx|pnpx|bunx|yarn\\s+dlx|pnpm\\s+(?:dlx|exec)|yarn\\s+exec)\\s+'
    + '(?:jest|vitest|mocha|ava|tap|karma|playwright\\s+test|cypress\\s+run)\\b')],
  ['test', /^(?:jest|vitest|mocha|ava|karma|playwright\s+test|cypress\s+run|phpunit)\b/],
  ['test', new RegExp('^(?:(?:uv|poetry|pdm|hatch|pipenv)\\s+run\\s+)?(?:python[0-9.]*\\s+-m\\s+)?'
    + '(?:pytest|py\\.test|unittest|nose2|tox|nox)\\b')],
  ['test', /^(?:go\s+test|cargo\s+(?:test|nextest)|dotnet\s+test|deno\s+test|bun\s+test|swift\s+test|mix\s+test)\b/],
  ['test', /^(?:mvnw?|gradlew?)\b.*\b(?:test|verify|check)\b/],
  ['test', /^(?:bundle\s+exec\s+)?(?:rspec|rake\s+(?:test|spec)|rails\s+test)\b/],
  ['test', /^node\s+(?:.*\s)?--test\b/],
  ['test', /^(?:make|just)\s+\S*test\S*/],
  ['typecheck', /^(?:npx\s+)?(?:tsc|vue-tsc)\b/],
  ['typecheck', /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:typecheck|type-check|tsc)\b/],
  ['typecheck', /^(?:(?:uv|poetry)\s+run\s+)?(?:mypy|pyright|basedpyright)\b/],
  ['typecheck', /^(?:cargo\s+check|go\s+vet)\b/],
  ['lint', /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?lint\b/],
  ['lint', /^(?:npx\s+)?(?:eslint|biome|oxlint|stylelint|prettier\s+--check)\b/],
  ['lint', /^(?:(?:uv|poetry)\s+run\s+)?(?:ruff|flake8|pylint|black\s+--check|isort\s+--check)\b/],
  ['lint', /^(?:golangci-lint|rubocop|cargo\s+clippy|cargo\s+fmt\s+--check|dotnet\s+format|(?:make|just)\s+lint)\b/],
  ['build', /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build\b/],
  ['build', /^(?:go\s+build|cargo\s+build|dotnet\s+build|(?:vite|webpack|next|tsup|rollup)\s+build)\b/],
  ['build', /^(?:mvnw?|gradlew?)\b.*\b(?:package|compile|build|assemble|install)\b/],
  ['build', /^(?:make|just)(?:\s|$)/],
];

const NARROWING = new RegExp('(?:\\s-t\\s|\\s--testNamePattern\\b|\\s--testPathPattern\\b|\\s-k\\s|\\s--grep\\b'
  + '|\\s-run\\s|\\s--filter\\b|\\s--only\\b|\\s--spec\\b|\\s--lf\\b|\\s--last-failed\\b|\\s--onlyChanged\\b'
  + '|\\s--changed\\b|::'
  + '|\\s\\S+\\.(?:test|spec)\\.[A-Za-z0-9]+(?:\\s|$)|\\stest_\\w+\\.py\\b|\\s\\S+_test\\.go\\b)');
// Values of credential-named flags (`--token=x`, `--password x`) never reach the stored head.
const SENSITIVE_FLAG = /^--?[\w-]*(?:token|secret|passw|apikey|api-key|auth|credential)[\w-]*$/i;

/** `{class, head, narrowed}` for a shell command line, or null when it is not a run we track. */
export function classifyRun(cmd, secretCheck = null) {
  for (const toks of simpleCommands(cmd)) {
    const norm = [exeName(toks[0]), ...toks.slice(1)].join(' ');
    const companion = /\badc\.mjs\b/.test(toks.join(' '))
      && RUN_CLASSES[0][1].test(toks.map((t) => toPosix(t).split('/').pop()).join(' '));
    for (const [cls, re] of RUN_CLASSES) {
      if (cls === 'companion' ? !companion : !re.test(norm)) continue;
      // A normalized head, never the full line: secret-shaped tokens and credential flag values are dropped.
      const head = toks.slice(0, 5).map((t, i, arr) => {
        if (/ADC_LIVE_TOKEN/i.test(t) || (secretCheck && secretCheck(t))) return '[REDACTED]';
        const eq = t.indexOf('=');
        if (eq > 0 && SENSITIVE_FLAG.test(t.slice(0, eq))) return `${t.slice(0, eq)}=[REDACTED]`;
        if (i > 0 && SENSITIVE_FLAG.test(arr[i - 1])) return '[REDACTED]';
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) return `${t.split('=')[0]}=...`;
        return truncate(toPosix(t), 40);
      }).join(' ');
      const narrowed = cls === 'test' && NARROWING.test(` ${toks.slice(1).join(' ')} `);
      return { class: cls, head: truncate(head, 80), narrowed };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Session

/**
 * The last assistant message from the tail of a host transcript (bounded read, no scan). Copilot's
 * camelCase `agentStop` payload carries only `transcriptPath`, a JSONL of events whose
 * `assistant.message` entries hold `data.content` (measured, CLI 1.0.103); Claude-style
 * `{type:'assistant', message:{content:[{type:'text'}]}}` lines are read too.
 */
export function lastAssistantMessage(file, { maxBytes = 256 * 1024 } = {}) {
  if (typeof file !== 'string' || !file) return null;
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, maxBytes);
    if (!len) return null;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    if (size > len) lines.shift();
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i].trim();
      if (!l.startsWith('{') || !l.includes('assistant')) continue;
      let e;
      try { e = JSON.parse(l); } catch { continue; }
      if (e?.type === 'assistant.message' && typeof e.data?.content === 'string' && e.data.content.trim()) {
        return e.data.content;
      }
      const content = e?.type === 'assistant' ? e.message?.content : null;
      if (Array.isArray(content)) {
        const text = content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text)
          .join('\n');
        if (text.trim()) return text;
      }
    }
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
  return null;
}

function hostTool(dialect, env) {
  if (dialect !== 'copilot') return dialect === 'claude' ? 'claude-code' : 'codex';
  return hostFromEnv(env).candidates.find((c) => c.startsWith('copilot') || c === 'vscode') || 'unknown';
}

function baseSession(cur, h) {
  const s = cur || {};
  const obj = (v) => v && typeof v === 'object';
  s.schema = s.schema || 'adc-session/1';
  s.host = s.host || h.dialect;
  s.dialect = h.dialect;
  s.tool = s.tool && s.tool !== 'unknown' ? s.tool : hostTool(h.dialect, h.env);
  if (h.norm.permission_mode) s.permission_mode = h.norm.permission_mode;
  s.root = toPosix(h.root);
  s.events = obj(s.events) ? s.events : {};
  s.events[h.event] = (s.events[h.event] || 0) + 1;
  s.edits = obj(s.edits) ? s.edits
    : { count: 0, first: null, last: null, classes: {}, files: [], times: [], findings: 0, state_dir_edits: 0 };
  s.observed_runs = Array.isArray(s.observed_runs) ? s.observed_runs : [];
  s.gate = obj(s.gate) ? s.gate
    : { notices: 0, last_notice_epoch: null, blocks: 0, last_block_epoch: null, consecutive: 0 };
  s.guard = obj(s.guard) ? s.guard : { denials: 0, asks: 0, last: null };
  if (s.ended === undefined) s.ended = false;
  // A resumed session (Claude and Codex keep the id on resume) is open again.
  if (s.ended && h.event !== 'session-end') { s.resumed = nowIso(); s.ended = false; }
  return s;
}

/**
 * Record into the session file. The state dir is created (with its exclude entry) only by events
 * that have something to remember (`create`), so read-only sessions leave no `.adc/` behind.
 */
async function record(h, mutate, { create = true } = {}) {
  if (h.noWrite) return null;
  if (!create && !fs.existsSync(h.st.dir)) return null;
  if (!ensureHookState(h.st, h.repo)) return null;
  try {
    return await updateSession(h.st.dir, h.norm.session_id, (cur) => {
      const s = baseSession(cur, h);
      mutate(s);
      return s;
    });
  } catch (err) {
    log(h, { error: err.code || 'SESSION_WRITE', message: truncate(err.message, 200) });
    return null;
  }
}

function log(h, entry, verbose = false) {
  if (verbose && !debugOn(h.env)) return;
  if (!h.st.ready || h.noWrite) {
    if (debugOn(h.env)) process.stderr.write(`adc hook-run: ${JSON.stringify(entry)}\n`);
    return;
  }
  hookLog(h.st.dir, { event: h.event, dialect: h.dialect, ...entry });
}

// ---------------------------------------------------------------------------
// Handlers

async function sessionStart(h) {
  const lines = ['agentic-developer-companion is installed (QA of agent-made changes, agentic tooling). Scripts:'
    + ` ${ADC_CMD} <command> --json; modes: verify, audit-tests, review, trace, regress, e2e, live, flake, ci-gate,`
    + ' tooling, doctor.'];
  const detect = readJson(h.st.paths.detect, null);
  const summary = detect && (typeof detect.summary === 'string' ? detect.summary : detect.result?.summary);
  if (typeof summary === 'string' && summary.trim()) {
    lines.push(`Detected stack (cached): ${truncate(summary.trim(), 200)}.`);
  }
  const led = newestLedger(h.st.paths.evidence);
  const evidenceDir = h.st.rel ? `${h.st.rel}/evidence` : toPosix(h.st.paths.evidence);
  lines.push(led
    ? `Newest verification ledger: ${evidenceDir}/${led.file}, verdict ${led.verdict || 'none yet'}, ${led.ts}.`
    : 'No verification ledger exists in this repository yet.');
  if (h.level !== 'advise') {
    lines.push(h.level === 'guard'
      ? 'Hook level guard: completion is gated on a current ledger; force-push, history rewrites and access to .adc/'
        + ' are denied.'
      : 'Hook level gate: completion is gated once per edit epoch on a ledger newer than the last edit.');
  }
  lines.push('Operating rules: a claim counts as verified only with a ledger entry (command, exit code, output hash);'
    + ' tests, assertions, CI steps and lint settings are never weakened to get green; .adc/.env.live is never'
    + ' opened.');
  const tracked = trackedState(h.st, h.repo);
  if (tracked?.length) {
    lines.push(`The companion state dir ${h.st.rel}/ is tracked by git (${tracked.length} file(s)); scripts refuse to`
      + ` run and hooks stay silent until it is untracked: ${ADC_CMD} doctor.`);
    // A diagnostic, never a different exit code (Copilot denies tool calls on non-zero preToolUse exits).
    process.stderr.write(`adc hook-run: ${h.st.rel}/ is tracked by git (${tracked.length} file(s)); hooks stay silent`
      + ' until it is untracked\n');
    h.noWrite = true;
  }
  await record(h, (s) => {
    s.source = h.norm.source || s.source || null;
    s.state_tracked = tracked == null ? null : tracked.length > 0;
    s.level = h.level;
  }, { create: false });
  return { context: truncate(lines.join('\n'), BRIEF_LIMIT) };
}

/** Notes for one edited file in the repository (marker scan by class) and the number of findings. */
function editNotes(rel, c, content, op) {
  const names = classNames(c);
  const text = content ? content.text : '';
  const lineMap = content?.lines ?? (content?.fragment ? [] : null);
  const hits = [];
  // Notebook cells are scanned as Python; the code catalogs never run on prose, data or config
  // files (a README that quotes `eslint-disable` is not a suppression), the same rule diff-scope uses.
  const scanName = /\.ipynb$/i.test(rel) ? rel.replace(/\.ipynb$/i, '.py') : rel;
  const code = M.isCodeFile(scanName);
  const scan = (catalog) => scanEdit(text, catalog, scanName, lineMap);
  if (c.test && code) {
    for (const x of scan(M.SKIP_MARKERS)) hits.push(`adds a skip/focus marker (${x.id}) ${at(x)}: ${x.text}`);
    for (const x of scan(M.IN_SOURCE_RETRIES)) hits.push(`adds an in-source retry (${x.id}) ${at(x)}`);
  }
  if (c.ci) for (const x of scan(M.CI_WEAKENING)) hits.push(`weakens a CI step (${x.id}) ${at(x)}: ${x.text}`);
  else if (c.manifest || c.runnerConfig) {
    // A manifest test script or runner config that turns a failing run green
    // (`"test": "jest --passWithNoTests"`, `|| true`).
    for (const x of scan(M.CI_WEAKENING)) {
      if (/pass-?with-?no-?tests|no-tests/i.test(x.id) || TEST_COMMAND_LINE.test(x.text)) {
        hits.push(`weakens a test command (${x.id}) ${at(x)}: ${x.text}`);
      }
    }
  }
  if (!c.generated && code) {
    for (const x of scan(M.SUPPRESSIONS)) hits.push(`adds a lint/type suppression (${x.id}) ${at(x)}`);
    for (const x of scan(M.SWALLOW_PATTERNS)) hits.push(`adds an exception-swallowing pattern (${x.id}) ${at(x)}`);
  }
  for (const x of secretsIn(text, lineMap)) hits.push(`adds a value shaped like a secret (${x.id}) ${at(x)}`);
  const label = names.length ? ` (${names.map((n) => CLASS_LABEL[n]).join(', ')})` : '';
  const notes = [];
  if (op === 'delete' && c.test) {
    notes.push(`- ${rel}${label}: deleted; test deletions are a CK-TEST-DEL check in verify.`);
  }
  else if (op === 'delete' && (c.ci || c.runnerConfig)) notes.push(`- ${rel}${label}: deleted.`);
  if (hits.length) notes.push(`- ${rel}${label}: ${hits.slice(0, 6).join('; ')}.`);
  else if (op !== 'delete') {
    const why = c.runnerConfig ? 'test discovery and runner settings are compared with the base by verify (CK-TEST-CFG)'
      : c.ci ? 'CI test steps are compared with the base by verify (CK-CI)'
        : c.lockfile ? 'lockfile consistency with the manifest is a CK-LOCK check'
          : c.lintConfig ? 'rules turned off here count as suppressions (CK-SUPPRESS)'
            : c.manifest ? 'test scripts and new dependencies are checked by verify (CK-TEST-CFG, CK-DEPS)' : null;
    if (why) notes.push(`- ${rel}${label}: ${why}.`);
  }
  return { notes, findings: hits.length };
}

async function postEdit(h) {
  const { norm } = h;
  if (norm.tool_kind !== 'edit') return {};
  const detect = readJson(h.st.paths.detect, null);
  const contents = extractContent(norm);
  const paths = extractPaths(norm);
  // Patch files carry their op (add, update, delete; the last one counts); other edits have one content entry.
  const ops = new Map(contents.map((x) => [x.path, x.op]));
  const single = contents.length === 1 && (!contents[0].path || paths.length === 1) ? contents[0] : null;
  const notes = [];
  const classes = {};
  const files = [];
  let findings = 0;
  let stateEdits = 0;
  let outside = 0;
  for (const p of paths) {
    const abs = absPath(h, p);
    const inRepo = relPosix(h.root, abs);
    const rel = inRepo || toPosix(p);
    if (underState(rel, abs, h.st)) {
      stateEdits++;
      notes.push(`- ${rel}: companion state under ${h.st.rel || STATE_DIR_NAME}/ (evidence, budget, credentials);`
        + ' evidence finalize re-checks ledger entry hashes.');
      continue;
    }
    // Files outside the repository (the host's plan and memory files, scratch files in the temp dir)
    // are not part of the change verify checks: no notes, and they do not arm the stop gate.
    if (inRepo == null || inRepo === '.') { outside++; continue; }
    const c = classify(rel, detect);
    for (const n of classNames(c)) classes[n] = (classes[n] || 0) + 1;
    files.push(rel);
    const r = editNotes(rel, c, contents.find((x) => x.path === p) || single, ops.get(p));
    notes.push(...r.notes);
    findings += r.findings;
  }
  if (files.length || stateEdits) {
    // The local clock, not the payload timestamp: the stop hook compares it with ledger times.
    const now = nowIso();
    await record(h, (s) => {
      const e = s.edits;
      if (files.length) {
        e.count += 1;
        e.first = e.first || now;
        e.last = now;
        e.times = [...(e.times || []), now].slice(-KEEP);
        e.files = [...(e.files || []).filter((f) => !files.includes(f)), ...files].slice(-KEEP);
        for (const [k, v] of Object.entries(classes)) e.classes[k] = (e.classes[k] || 0) + v;
        e.findings = (e.findings || 0) + findings;
      }
      e.state_dir_edits = (e.state_dir_edits || 0) + stateEdits;
    });
  }
  log(h, { tool: norm.tool_name, files: paths.length, outside, classes, findings, keys: norm.keys, bytes: h.bytes,
    ms: Date.now() - h.t0 }, true);
  if (!notes.length) return {};
  return { context: truncate(`agentic-developer-companion notes on this edit (notes, not verdicts; verify records`
    + ` evidence):\n${notes.join('\n')}`, 2000) };
}

async function postShell(h) {
  const { norm } = h;
  if (norm.tool_kind !== 'shell') return {};
  const cmd = shellCommand(norm.tool_input);
  const text = norm.tool_result_text || '';
  const decision = {};
  const notes = [];
  // Copilot can rewrite the tool result the model sees (§10.3.1); Claude and Codex cannot.
  if (h.dialect === 'copilot' && text) {
    const redacted = redactLiveToken(text, h.env);
    if (redacted !== text) {
      decision.modifiedResult = { text: redacted, resultType: norm.tool_result_type || 'success' };
      notes.push('The tool output contained the ADC_LIVE_TOKEN credential; it was redacted from the result.');
      log(h, { condition: 'TOKEN_IN_OUTPUT', redacted: true });
    }
  }
  if (/\.env\.live\b/.test(cmd)) {
    notes.push('This command referenced .adc/.env.live; that file holds the live-test credential and only'
      + ' `adc.mjs live run` reads it.');
  }
  const runInfo = cmd ? classifyRun(cmd, (t) => M.scanSecrets(t).length > 0) : null;
  if (runInfo) {
    const counts = text ? parseSummaryText(text) : null;
    const obs = {
      ts: norm.timestamp || nowIso(),
      cmd_head: runInfo.head,
      class: runInfo.class,
      exit: norm.exit_code,
      exit_source: norm.exit_source,
      counts: counts
        ? { passed: counts.passed, failed: counts.failed, skipped: counts.skipped, runner: counts.runner } : null,
      parse_source: counts ? 'summary-line' : 'none',
      source: 'hook:post-shell',
      narrowed: runInfo.narrowed,
    };
    await record(h, (s) => { s.observed_runs = [...s.observed_runs, obs].slice(-KEEP); });
    if (runInfo.narrowed) {
      notes.push(`Observed a narrowed test run (${runInfo.head}). Observed runs are not evidence for a "tests pass"`
        + ' claim; verify re-runs the whole suite of each affected project with retries off (CK-CLEANRUN).');
    }
    log(h, { tool: norm.tool_name, class: runInfo.class, counts: Boolean(counts), keys: norm.keys, bytes: h.bytes,
      ms: Date.now() - h.t0 }, true);
  }
  if (notes.length) decision.context = notes.join('\n');
  return decision;
}

const CLAIM_RE = [
  /\b(?:all|the)\s+(?:\w+\s+)?tests?\s+(?:now\s+)?(?:pass(?:es|ed|ing)?|are\s+passing|succeed(?:ed)?|are\s+green)\b/i,
  /\btests?\s+(?:are\s+)?(?:all\s+)?(?:green|passing)\b/i,
  /\b(?:everything|it)\s+(?:works|is\s+working)\b/i,
  /\bbuild\s+(?:passes|succeeds|is\s+green)\b/i,
  /\b(?:fully\s+)?verified\b/i,
];

async function stop(h) {
  const { norm } = h;
  if (norm.stop_hook_active) return {};
  const session = readSession(h.st.dir, norm.session_id);
  const edits = Number(session?.edits?.count) > 0 ? session.edits : null;
  if (!edits) return {};
  const led = newestLedger(h.st.paths.evidence);
  const lastEdit = Date.parse(edits.last || '') || 0;
  const ledTs = led ? Date.parse(led.ts) || 0 : 0;
  const stale = !led || !led.verdict || led.verdict === 'UNVERIFIED' || ledTs < lastEdit;
  const gate = session.gate || {};
  if (!stale) {
    if (gate.consecutive) await record(h, (s) => { s.gate.consecutive = 0; });
    return {};
  }
  const epoch = Number(edits.count);
  if (h.level === 'advise' ? gate.last_notice_epoch === epoch : gate.last_block_epoch === epoch) return {};
  if (h.level !== 'advise' && (gate.consecutive || 0) >= MAX_CONSECUTIVE_BLOCKS) {
    log(h, { condition: 'BLOCK_CAP', consecutive: gate.consecutive });
    return {};
  }
  const ledText = led ? `newest ledger ${led.file} (verdict ${led.verdict || 'none'}, ${led.ts})` : 'no ledger yet';
  // Copilot payloads carry no last message; its transcript tail is read only when a notice is due.
  const lastMessage = norm.last_message || lastAssistantMessage(norm.transcript_path);
  const m = lastMessage ? CLAIM_RE.map((re) => re.exec(lastMessage)).find(Boolean) : null;
  const claim = m ? ` The final message states "${truncate(m[0], 60)}"; observed test runs do not support that claim,`
    + ' only CK-CLEANRUN in a ledger does.' : '';
  const reasonCore = `${epoch} edit event(s) in this session are newer than the verification evidence (${ledText}).`;
  if (h.level === 'advise') {
    await record(h, (s) => { s.gate.notices = (s.gate.notices || 0) + 1; s.gate.last_notice_epoch = epoch; });
    return { context: `agentic-developer-companion: ${reasonCore} ${ADC_CMD} verify --json records a ledger and`
      + ` verdict.${claim}` };
  }
  await record(h, (s) => {
    s.gate.blocks = (s.gate.blocks || 0) + 1;
    s.gate.last_block_epoch = epoch;
    s.gate.consecutive = (s.gate.consecutive || 0) + 1;
  });
  log(h, { decision: 'block', epoch });
  return { block: `agentic-developer-companion completion gate: ${reasonCore} Run ${ADC_CMD} verify --json (it writes`
    + ` the ledger), then finish; the gate blocks once per edit epoch.${claim}` };
}

const GUARD_PREFIX = 'agentic-developer-companion guard:';
const INDEX_ONLY = new Set(['check-ignore', 'ls-files', 'status']);
const askDeleteTests = (victims) => ({
  ask: `${GUARD_PREFIX} this deletes test file(s) (${truncate(victims.join(', '), 120)}); verify flags test deletions`
    + ' (CK-TEST-DEL) unless the spec asks for them. Confirm the deletion is intended.',
  rule: 'delete-test',
});
const testVictims = (h, args) => args.filter((a) => !a.startsWith('-')).map((a) => toPosix(a).replace(/^\.\//, ''))
  .filter((a) => classify(a, h.detect).test);

/** The guard's verdict on a git command, or null. */
function guardGit(h, g) {
  const { sub, args } = g;
  const flags = args.filter((a) => a.startsWith('-'));
  const shortHas = (ch) => flags.some((a) => /^-[A-Za-z]+$/.test(a) && a.includes(ch));
  if (sub === 'push' && (flags.some((a) => /^--force(?:-with-lease(?:=.*)?|-if-includes)?$/.test(a) || a === '--mirror')
      || shortHas('f') || args.some((a) => !a.startsWith('-') && a.startsWith('+')))) {
    return { deny: `${GUARD_PREFIX} \`git push --force\` rewrites published history. The guard level denies force-push`
      + ' and history rewrites (rebase, reset --hard, commit --amend, filter-branch); run it outside the agent if it is'
      + ' intended.', rule: 'force-push' };
  }
  if (sub === 'rebase' && !args.some((a) => ['--abort', '--quit', '--show-current-patch'].includes(a))) {
    return { deny: `${GUARD_PREFIX} \`git rebase\` rewrites history; the guard level denies it (\`git rebase --abort\``
      + ' stays allowed).', rule: 'rebase' };
  }
  if (sub === 'reset' && args.includes('--hard')) {
    return { deny: `${GUARD_PREFIX} \`git reset --hard\` discards commits and working-tree changes; the guard level`
      + ' denies it.', rule: 'reset-hard' };
  }
  if (sub === 'commit' && args.includes('--amend')) {
    return { deny: `${GUARD_PREFIX} \`git commit --amend\` rewrites the last commit; the guard level denies it (make a`
      + ' new commit instead).', rule: 'amend' };
  }
  if (sub === 'filter-branch' || sub === 'filter-repo') {
    return { deny: `${GUARD_PREFIX} \`git ${sub}\` rewrites history; the guard level denies it.`,
      rule: 'filter-branch' };
  }
  if (sub === 'add' && (flags.includes('--force') || shortHas('f'))
      && (args.some((a) => mentionsState(a, h.st)) || forceAddCoversState(h, g))) {
    return { deny: `${GUARD_PREFIX} \`git add -f\` of ${h.st.rel || STATE_DIR_NAME}/ would commit companion state`
      + ' (credentials, budget, evidence); it stays git-ignored. Force-add the intended paths by name instead.',
    rule: 'force-add-state' };
  }
  if (sub === 'commit' || sub === 'push') {
    const tracked = trackedState(h.st, h.repo);
    if (tracked?.length) {
      h.noWrite = true;
      return { deny: `${GUARD_PREFIX} ${h.st.rel}/ is tracked by git (${tracked.length} file(s)), so this ${sub} could`
        + ` publish companion state (credentials, budget, evidence). Untrack it first: git rm -r --cached ${h.st.rel}`,
      rule: 'state-tracked' };
    }
  }
  if (sub === 'rm') {
    const victims = testVictims(h, args);
    if (victims.length) return askDeleteTests(victims);
  }
  return null;
}

function guardShell(h, cmd) {
  for (const toks of simpleCommands(cmd)) {
    const g = gitParts(toks);
    if (g) {
      const verdict = guardGit(h, g);
      if (verdict) return verdict;
      if (INDEX_ONLY.has(g.sub)) continue;
    }
    const exe = exeName(toks[0]);
    const args = toks.slice(1);
    const envLive = args.some((t) => tokenReachesEnvLive(t, h.st))
      || (readsTree(exe, toks) && args.some((t) => ['', '/'].includes(stateRemainder(t, h.st))));
    // Untracking (`git rm --cached`, the remedy for a tracked state dir) only touches the index.
    if (envLive && !(g?.sub === 'rm' && g.args.includes('--cached'))) {
      return { deny: `${GUARD_PREFIX} .adc/.env.live holds the live-test credential; only \`adc.mjs live run\``
        + ' reads it, and host tools are denied access under the guard level.', rule: 'env-live' };
    }
    if (DELETERS.has(exe)) {
      const victims = testVictims(h, args);
      if (victims.length) return askDeleteTests(victims);
    }
  }
  return null;
}

/** The guard's verdict on an edit or read tool call, or null. */
function guardFiles(h) {
  const { norm } = h;
  const paths = extractPaths(norm);
  const patterns = norm.tool_kind === 'read' ? extractPatterns(norm) : [];
  if (!paths.length && !patterns.length) return null;
  const where = h.st.rel || STATE_DIR_NAME;
  const resolved = paths.map((p) => { const abs = absPath(h, p); return { p, abs, rel: relPosix(h.root, abs) }; });
  if (resolved.some((r) => underState(r.rel, r.abs, h.st))) {
    return norm.tool_kind === 'read'
      ? { deny: `${GUARD_PREFIX} ${where}/ holds the live-test credential, the budget ledger and the evidence ledger;`
        + ' the guard level denies reading or searching it with host tools.', rule: 'state-read' }
      : { deny: `${GUARD_PREFIX} files under ${where}/ (evidence ledger, budget, credentials) are written only by the`
        + ' companion\'s scripts; the guard level denies editing them.', rule: 'state-edit' };
  }
  if (patterns.some((pt) => mentionsState(pt, h.st) || /\.env\.live\b/.test(pt))) {
    return { deny: `${GUARD_PREFIX} ${where}/ holds the live-test credential and evidence; the guard level denies`
      + ' searching it with host tools.', rule: 'state-read' };
  }
  if (norm.tool_kind !== 'edit') return null;
  const ops = new Map(parsePatch(norm.tool_input).map((f) => [f.path, f.op]));
  for (const { p, rel: inRepo } of resolved) {
    const rel = inRepo || toPosix(p);
    const c = classify(rel, h.detect);
    if (ops.get(p) === 'delete' && c.test) {
      return { ask: `${GUARD_PREFIX} this deletes a test file (${rel}); verify flags test deletions (CK-TEST-DEL)`
        + ' unless the spec asks for them. Confirm the deletion is intended.', rule: 'delete-test' };
    }
    if (c.ci) {
      return { ask: `${GUARD_PREFIX} this edits CI configuration (${rel}); CI edits that weaken test steps fail verify`
        + ' (CK-CI). Confirm the change is intended.', rule: 'ci-edit' };
    }
  }
  return null;
}

async function preGuard(h) {
  const { norm } = h;
  h.detect = readJson(h.st.paths.detect, null);
  let verdict = null;
  if (norm.tool_kind === 'shell') {
    const cmd = shellCommand(norm.tool_input);
    if (cmd) verdict = guardShell(h, cmd);
  } else if (norm.tool_kind === 'edit' || norm.tool_kind === 'read') {
    verdict = guardFiles(h);
  }
  if (!verdict) return {};
  const decision = verdict.deny ? 'deny' : 'ask';
  await record(h, (s) => {
    // Claude starts one handler per matching `if` rule (`cat .adc/.env.live` matches two); count the call once.
    if (norm.tool_use_id && s.guard.last?.tool_use_id === norm.tool_use_id) return;
    if (verdict.deny) s.guard.denials = (s.guard.denials || 0) + 1;
    else s.guard.asks = (s.guard.asks || 0) + 1;
    s.guard.last = { ts: nowIso(), rule: verdict.rule, decision,
      ...(norm.tool_use_id ? { tool_use_id: norm.tool_use_id } : {}) };
  });
  log(h, { decision, rule: verdict.rule, tool: norm.tool_name });
  return verdict.deny ? { deny: verdict.deny } : { ask: verdict.ask };
}

async function sessionEnd(h) {
  if (!readSession(h.st.dir, h.norm.session_id)) return {};
  await record(h, (s) => {
    s.ended = { ts: nowIso(), reason: h.norm.reason || null };
    s.summary = {
      edits: s.edits.count || 0,
      edited_files: (s.edits.files || []).length,
      observed_runs: s.observed_runs.length,
      gate_blocks: s.gate.blocks || 0,
      guard_denials: s.guard.denials || 0,
    };
  });
  return {};
}

const HANDLERS = {
  'session-start': sessionStart,
  'post-edit': postEdit,
  'post-shell': postShell,
  'stop': stop,
  'pre-guard': preGuard,
  'session-end': sessionEnd,
};

// ---------------------------------------------------------------------------
// Entry point

const HOOK_OPTIONS = {
  dialect: { type: 'string' }, level: { type: 'string' }, 'state-dir': { type: 'string' }, cwd: { type: 'string' },
  json: { type: 'boolean' }, yes: { type: 'boolean' }, 'dry-run': { type: 'boolean' },
};

/** Handle one hook invocation. Returns the decision object (`{}` for no decision); never throws. */
export async function hookRunCommand(argv = [], { stdin = process.stdin, env = process.env } = {}) {
  const t0 = Date.now();
  let h = null;
  const debug = (msg) => { if (debugOn(env)) process.stderr.write(`adc hook-run: ${msg}\n`); };
  try {
    const { values, positionals } = parseArgs({ args: argv, options: HOOK_OPTIONS, allowPositionals: true,
      strict: false });
    const event = positionals[0];
    const buf = await readStdin({ stream: stdin });
    if (!HOOK_EVENTS.includes(event)) { debug(`unknown event "${event}"`); return {}; }
    const payload = parsePayload(decodeStdin(buf));
    if (!payload) { debug(`${event}: empty or malformed payload (${buf ? buf.length : 'overflow'} bytes)`); return {}; }
    const str = (k) => (typeof values[k] === 'string' ? values[k] : null);
    const dialect = detectDialect(payload, { explicit: str('dialect') || 'auto', env });
    const norm = normalizePayload(payload, dialect, event);
    const repo = locateRepo(norm.cwd) || locateRepo(env.CLAUDE_PROJECT_DIR)
      || locateRepo(str('cwd')) || locateRepo(process.cwd());
    if (!repo) { debug(`${event}: no git work tree for cwd ${norm.cwd || process.cwd()}`); return {}; }
    const level = LEVELS.includes(values.level) ? values.level : 'advise';
    const st = hookStateInfo(repo, { stateDir: str('state-dir'), env });
    // An existing state dir is usable for logging right away; a missing one is created lazily.
    if (fs.existsSync(st.dir)) ensureHookState(st, repo);
    h = { event, dialect, norm, repo, root: repo.root, level, st, env, t0, bytes: buf ? buf.length : 0,
      noWrite: false };
    // A tracked state dir (cached by the last session-start or guard check): stay silent and write
    // nothing; session-start re-checks and says so, the guard still denies commit and push.
    if (event !== 'session-start' && trackedCached(repo)) {
      h.noWrite = true;
      if (event !== 'pre-guard') return {};
    }
    const decision = await HANDLERS[event](h);
    const out = formatOutput(dialect, event, decision, { hostEvent: norm.host_event });
    log(h, { kind: Object.keys(decision || {}).join(',') || 'none', ms: Date.now() - t0,
      session: sha256(norm.session_id).slice(0, 8) }, true);
    return out;
  } catch (err) {
    try { if (h) log(h, { error: err?.code || 'HANDLER', message: truncate(err?.message, 200) }); } catch {}
    debug(err?.stack || err);
    return {};
  }
}
