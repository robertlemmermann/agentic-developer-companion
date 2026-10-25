// `adc.mjs hook-run <event>`: the hook handler (§8). Reads one JSON payload from stdin and
// returns one decision object; adc.mjs prints it exactly once and exits 0 (2 s watchdog).
// Performance contract: no git (except one `git ls-files` for the tracked-state check in
// session-start and before `git commit`/`git push` in the guard), no filesystem scans, no
// network; it reads `.adc/detect.json`, the newest ledger and the session file only.

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  SKILL_DIR, ensureDir, matchAny, nowIso, readJson, readText, relPosix, run, sha256, tmpRoot, toPosix, truncate,
  writeJsonAtomic,
} from './core.mjs';
import { STATE_DIR_NAME, hookLog, readSession, setOwnerOnly, statePaths, updateSession } from './state.mjs';
import {
  HOOK_EVENTS, detectDialect, extractContent, extractPaths, extractPatterns, formatOutput, normalizePayload,
  parsePatch, shellCommand,
} from './hook-dialects.mjs';

export const LEVELS = Object.freeze(['advise', 'gate', 'guard']);
const STDIN_TIMEOUT_MS = 1200;
const STDIN_MAX_BYTES = 16 * 1024 * 1024;
const BRIEF_LIMIT = 1500;
const MAX_CONSECUTIVE_BLOCKS = 7; // hosts end the turn at 8 consecutive stop blocks
const KEEP = 50;
const TRACKED_TTL_MS = 12 * 60 * 60 * 1000;
const SCRIPT = `${toPosix(SKILL_DIR)}/scripts/adc.mjs`;
const ADC_CMD = `node "${SCRIPT}"`;
const debugOn = (env) => env.ADC_DEBUG === '1' || env.ADC_DEBUG === 'true';

// ---------------------------------------------------------------------------
// stdin

/** Read stdin to the end (or until the timeout); a TTY counts as empty. Never throws. */
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
        if (size > maxBytes) { finish(true); return; }
        chunks.push(c);
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
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
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
    return PAYLOAD_KEYS.some((k) => Object.prototype.hasOwnProperty.call(v, k)) ? v : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Repository and state, without git

/** Walk up from `start` to the first directory holding `.git` (dir or worktree/submodule file). */
export function findRepo(start) {
  if (!start || typeof start !== 'string') return null;
  let dir;
  try { dir = path.resolve(start); } catch { return null; }
  try { if (!fs.statSync(dir).isDirectory()) dir = path.dirname(dir); } catch { return null; }
  for (let i = 0; i < 64; i++) {
    const dotgit = path.join(dir, '.git');
    let st = null;
    try { st = fs.statSync(dotgit); } catch {}
    if (st) {
      let gitDir = dotgit;
      if (st.isFile()) {
        const m = /^gitdir:\s*(.+?)\s*$/m.exec(readText(dotgit, '') || '');
        if (!m) return null;
        gitDir = path.resolve(dir, m[1]);
      }
      let commonDir = gitDir;
      const common = readText(path.join(gitDir, 'commondir'));
      if (common && common.trim()) commonDir = path.resolve(gitDir, common.trim());
      return { root: canonical(dir), gitDir, commonDir };
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/** State dir for a hook: --state-dir > ADC_HOME > <root>/.adc (same order as state.resolveStateDir). */
export function hookStateInfo(repo, { stateDir = null, env = process.env } = {}) {
  let dir;
  if (stateDir) dir = path.resolve(repo.root, stateDir);
  else if (env.ADC_HOME) dir = path.resolve(env.ADC_HOME);
  else dir = path.join(repo.root, STATE_DIR_NAME);
  const rel = relPosix(repo.root, dir);
  const insideRepo = Boolean(rel && rel !== '.');
  return { dir, canonicalDir: canonical(dir), rel: insideRepo ? rel : null, insideRepo, paths: statePaths(dir), ready: null };
}

/**
 * Make the state dir usable: the exclude entry first (git-free: <common git dir>/info/exclude,
 * the file `git rev-parse --git-path info/exclude` names), then the directory. False when either
 * cannot be written, in which case the hook records nothing.
 */
export function ensureHookState(info, repo) {
  if (info.ready != null) return info.ready;
  info.ready = false;
  try {
    if (info.insideRepo) {
      const exclude = path.join(repo.commonDir, 'info', 'exclude');
      const current = readText(exclude, '') || '';
      const lines = current.split(/\r?\n/).map((l) => l.trim());
      const entry = `/${info.rel}/`;
      if (!lines.includes(entry) && !lines.includes(`/${info.rel}`) && !lines.includes(`${info.rel}/`)) {
        ensureDir(path.dirname(exclude));
        const sep = current && !current.endsWith('\n') ? '\n' : '';
        fs.appendFileSync(exclude, `${sep}# agentic-developer-companion state (never commit)\n${entry}\n`);
      }
    }
    if (!fs.existsSync(info.dir)) {
      ensureDir(info.dir, 0o700);
      setOwnerOnly(info.dir, { dir: true });
    }
    info.ready = fs.statSync(info.dir).isDirectory();
  } catch {
    info.ready = false;
  }
  return info.ready;
}

/**
 * Files under the state dir that git tracks (one `git ls-files`); null when git cannot tell.
 * The answer is cached outside the repository (OS temp dir) so the other hooks can honor it
 * without running git: while the state dir is tracked they print `{}` and write nothing.
 */
export function trackedState(info, repo) {
  if (!info.insideRepo) return [];
  const res = run('git', ['ls-files', '-z', '--', `:(top)${info.rel}`], { cwd: repo.root, timeoutMs: 1500 });
  if (res.exit !== 0) return null;
  const files = res.stdout.split('\0').filter(Boolean);
  try { writeJsonAtomic(trackedCacheFile(repo), { root: toPosix(repo.root), rel: info.rel, tracked: files.length, ts: nowIso() }); } catch {}
  return files;
}

const trackedCacheFile = (repo) => path.join(tmpRoot(repo.root), 'state-tracked.json');

/** The cached tracked-state answer from the last session-start or guard check (no git). */
export function trackedCached(repo) {
  const c = readJson(trackedCacheFile(repo), null);
  if (!c || typeof c.tracked !== 'number' || Date.now() - (Date.parse(c.ts) || 0) > TRACKED_TTL_MS) return false;
  return c.tracked > 0;
}

// ---------------------------------------------------------------------------
// Optional modules from other work packages (markers.mjs, reports.mjs), with fallbacks

const FALLBACK = {
  SKIP_MARKERS: [
    { id: 'focus-or-skip-call', re: /\b(?:it|test|describe|context|suite|specify)\.(?:only|skip|todo)\s*\(/ },
    { id: 'x-or-f-prefixed-test', re: /(?:^|[^\w.$])(?:xit|xdescribe|xtest|xcontext|fit|fdescribe|fcontext)\s*\(/ },
    { id: 'pytest-skip', re: /@pytest\.mark\.(?:skip|skipif|xfail)\b|\bpytest\.(?:skip|xfail)\s*\(/ },
    { id: 'unittest-skip', re: /@unittest\.(?:skip|skipIf|skipUnless|expectedFailure)\b/ },
    { id: 'go-skip', re: /\bt\.Skip(?:Now|f)?\s*\(/ },
    { id: 'rust-ignore', re: /#\[ignore(?:\s*=\s*"[^"]*")?\]/ },
    { id: 'junit-disabled', re: /@(?:Disabled|Ignore)\b/ },
    { id: 'dotnet-skip', re: /\[(?:Fact|Theory)\s*\([^)]*\bSkip\s*=|\[Ignore\b/ },
    { id: 'rspec-skip', re: /^\s*(?:xit|xdescribe|xcontext|skip|pending)\b/m },
  ],
  SUPPRESSIONS: [
    { id: 'eslint-disable', re: /eslint-disable(?:-next-line|-line)?\b/ },
    { id: 'ts-ignore', re: /@ts-(?:ignore|nocheck|expect-error)\b/ },
    { id: 'noqa', re: /#\s*noqa\b/i },
    { id: 'type-ignore', re: /#\s*type:\s*ignore\b/ },
    { id: 'pylint-disable', re: /#\s*pylint:\s*disable\b/ },
    { id: 'nolint', re: /\/\/\s*nolint\b/ },
    { id: 'rust-allow', re: /#!?\[allow\(/ },
    { id: 'suppress-warnings', re: /@SuppressWarnings\b|#pragma\s+warning\s+disable\b/ },
    { id: 'rubocop-disable', re: /rubocop:disable\b/ },
    { id: 'coverage-ignore', re: /\b(?:istanbul|c8|v8)\s+ignore\b|\bpragma:\s*no\s+cover\b/ },
    { id: 'nosonar', re: /\bNOSONAR\b/ },
    { id: 'biome-ignore', re: /\bbiome-ignore\b/ },
  ],
  SWALLOW_PATTERNS: [
    { id: 'empty-catch', re: /catch\s*(?:\([^)]*\))?\s*\{\s*\}/ },
    { id: 'except-pass', re: /except(?:\s+[^:\n]+)?:\s*(?:\r?\n\s*)?pass\b/ },
    { id: 'promise-catch-noop', re: /\.catch\(\s*\(?\s*\w*\s*\)?\s*=>\s*(?:\{\s*\}|null|undefined)\s*\)/ },
    { id: 'go-empty-err', re: /if\s+err\s*!=\s*nil\s*\{\s*\}/ },
  ],
  CI_WEAKENING: [
    { id: 'continue-on-error', re: /continue-on-error:\s*true\b/ },
    { id: 'or-true', re: /\|\|\s*(?:true|exit\s+0|:)\s*$/m },
    { id: 'pass-with-no-tests', re: /--passWithNoTests\b/ },
    { id: 'allow-failure', re: /allow_failure:\s*true\b/ },
  ],
  IN_SOURCE_RETRIES: [
    { id: 'jest-retry-times', re: /\bjest\.retryTimes\s*\(/ },
    { id: 'pytest-flaky', re: /@pytest\.mark\.flaky\b|@flaky\b/ },
    { id: 'retries-config', re: /\bretries\s*[:=]\s*[1-9]/ },
    { id: 'mocha-retries', re: /\bthis\.retries\s*\(\s*[1-9]/ },
    { id: 'junit-retry', re: /@(?:RepeatedTest|RetryingTest|Retry)\b|rerunFailingTestsCount/ },
  ],
};

const FALLBACK_SECRETS = [
  { id: 'aws-access-key-id', re: new RegExp('\\b(?:' + ['AK', 'AS'].map((p) => p + 'IA').join('|') + ')[0-9A-Z]{16}\\b') },
  { id: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { id: 'private-key', re: new RegExp(['-----BEGIN', '[A-Z ]*PRIVATE', 'KEY-----'].join(' ')) },
  { id: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { id: 'assigned-secret', re: /(?:api[_-]?key|secret|token|passw(?:or)?d)["']?\s*[:=]\s*["'][^"'\s]{16,}["']/i },
];

function fallbackClassify(file) {
  const f = toPosix(file).replace(/^\.\//, '');
  const lower = f.toLowerCase();
  const base = lower.split('/').pop();
  return {
    test: /(^|\/)(__tests__|tests?|spec|specs|e2e)\//.test(lower) || /\.(test|spec|e2e)\.[a-z0-9]+$/.test(base) ||
      /^test_.*\.py$/.test(base) || /_test\.(py|go|rb|exs)$/.test(base) || /_spec\.rb$/.test(base) ||
      /tests?\.(cs|java|kt|swift)$/.test(base) || base === 'conftest.py',
    runnerConfig: /^(jest|vitest|playwright|cypress|karma|ava|wdio|mocha)\.config\.[a-z0-9.]+$/.test(base) ||
      /^\.mocharc(\.[a-z]+)?$/.test(base) || ['pytest.ini', 'tox.ini', 'setup.cfg', 'conftest.py', 'noxfile.py', '.nycrc', '.c8rc'].includes(base) ||
      /\.runsettings$/.test(base) || base === 'phpunit.xml',
    ci: /^\.github\/workflows\/[^/]+\.ya?ml$/.test(lower) || /(^|\/)\.gitlab-ci\.ya?ml$/.test(lower) ||
      /(^|\/)azure-pipelines\.ya?ml$/.test(lower) || /^\.circleci\//.test(lower) || base === 'jenkinsfile' || /^\.buildkite\//.test(lower),
    lockfile: ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', 'poetry.lock',
      'uv.lock', 'pipfile.lock', 'pdm.lock', 'cargo.lock', 'go.sum', 'gemfile.lock', 'composer.lock', 'packages.lock.json', 'gradle.lockfile'].includes(base),
    lintConfig: /^\.eslintrc(\.[a-z]+)?$/.test(base) || /^eslint\.config\.[a-z]+$/.test(base) || /^\.prettierrc/.test(base) ||
      /^tsconfig.*\.json$/.test(base) || ['ruff.toml', '.ruff.toml', '.flake8', 'mypy.ini', '.pylintrc', '.golangci.yml', '.golangci.yaml',
        'clippy.toml', '.rubocop.yml', 'biome.json', '.stylelintrc', '.editorconfig'].includes(base),
    manifest: ['package.json', 'pyproject.toml', 'cargo.toml', 'go.mod', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'gemfile',
      'setup.py', 'makefile', 'justfile', 'pipfile'].includes(base) || /\.csproj$/.test(base) || /^requirements.*\.txt$/.test(base),
    generated: /(^|\/)(dist|build|out|coverage|node_modules|vendor)\//.test(lower) || /\.min\.(js|css)$/.test(base) ||
      /\.generated\./.test(base) || /_pb2\.py$/.test(base) || /\.pb\.go$/.test(base),
  };
}

let markersCache;
async function loadMarkers() {
  if (markersCache !== undefined) return markersCache;
  const m = { classifyPath: fallbackClassify, scanSecrets: null, source: 'fallback', ...FALLBACK };
  try {
    const mod = await import('./markers.mjs');
    if (typeof mod.classifyPath === 'function') m.classifyPath = mod.classifyPath;
    if (typeof mod.scanSecrets === 'function') m.scanSecrets = mod.scanSecrets;
    for (const k of Object.keys(FALLBACK)) if (Array.isArray(mod[k]) && mod[k].length) m[k] = mod[k];
    m.source = 'markers.mjs';
  } catch {}
  markersCache = m;
  return m;
}

let summaryCache;
async function loadSummaryParser() {
  if (summaryCache !== undefined) return summaryCache;
  summaryCache = { parse: fallbackSummary, source: 'fallback' };
  try {
    const mod = await import('./reports.mjs');
    if (typeof mod.parseSummaryText === 'function') summaryCache = { parse: mod.parseSummaryText, source: 'reports.mjs' };
  } catch {}
  return summaryCache;
}

/** Runner summary lines in tool output → `{runner, passed, failed, skipped}` or null (fallback parser). */
export function fallbackSummary(text) {
  const s = String(text || '').replace(/\x1b\[[0-9;]*m/g, '');
  if (!s) return null;
  const lines = s.split(/\r?\n/);
  const num = (re, line) => { const m = re.exec(line); return m ? Number(m[1]) : 0; };
  let found = null;
  const set = (runner, passed, failed, skipped) => { found = { runner, passed, failed, skipped }; };
  for (const line of lines) {
    const l = line.trim();
    if (/^Tests:\s+.*\d+ total/.test(l)) set('jest', num(/(\d+) passed/, l), num(/(\d+) failed/, l), num(/(\d+) (?:skipped|todo)/, l));
    else if (/^Tests\s+.*\(\d+\)/.test(l)) set('vitest', num(/(\d+) passed/, l), num(/(\d+) failed/, l), num(/(\d+) (?:skipped|todo)/, l));
    else if (/^=+ .*\b(passed|failed|error|errors|skipped|no tests ran)\b.* in [\d.]+s/.test(l)) {
      set('pytest', num(/(\d+) passed/, l), num(/(\d+) failed/, l) + num(/(\d+) errors?/, l), num(/(\d+) skipped/, l));
    } else if (/^test result: (ok|FAILED)\./.test(l)) {
      const prev = found && found.runner === 'cargo' ? found : { passed: 0, failed: 0, skipped: 0 };
      set('cargo', prev.passed + num(/(\d+) passed/, l), prev.failed + num(/(\d+) failed/, l), prev.skipped + num(/(\d+) ignored/, l));
    } else if (/^(?:Passed|Failed)!\s+-\s+Failed:/.test(l)) set('dotnet', num(/Passed:\s*(\d+)/, l), num(/Failed:\s*(\d+)/, l), num(/Skipped:\s*(\d+)/, l));
    else if (/^\d+ examples?, \d+ failures?/.test(l)) {
      const total = num(/^(\d+) examples?/, l); const failed = num(/(\d+) failures?/, l); const pending = num(/(\d+) pending/, l);
      set('rspec', Math.max(0, total - failed - pending), failed, pending);
    } else if (/^Tests run: \d+, Failures: \d+, Errors: \d+, Skipped: \d+$/.test(l)) {
      const total = num(/Tests run: (\d+)/, l); const failed = num(/Failures: (\d+)/, l) + num(/Errors: (\d+)/, l); const skipped = num(/Skipped: (\d+)/, l);
      set('surefire', Math.max(0, total - failed - skipped), failed, skipped);
    } else if (/^(?:#|ℹ) (pass|fail|skipped) \d+$/.test(l)) {
      const prev = found && found.runner === 'node-test' ? found : { passed: 0, failed: 0, skipped: 0 };
      const n = num(/(\d+)$/, l);
      if (/ pass /.test(l)) set('node-test', n, prev.failed, prev.skipped);
      else if (/ fail /.test(l)) set('node-test', prev.passed, n, prev.skipped);
      else set('node-test', prev.passed, prev.failed, n);
    } else if (/^\d+ passing\b/.test(l)) set('mocha', num(/^(\d+) passing/, l), 0, 0);
    else if (/^\d+ failing\b/.test(l) && found && found.runner === 'mocha') found.failed = num(/^(\d+) failing/, l);
    else if (/^\d+ pending\b/.test(l) && found && found.runner === 'mocha') found.skipped = num(/^(\d+) pending/, l);
    else if (/^\d+ (passed|failed|flaky|skipped)\b/.test(l) && /\(\d/.test(l)) {
      const prev = found && found.runner === 'playwright' ? found : { passed: 0, failed: 0, skipped: 0 };
      set('playwright', /passed/.test(l) ? num(/^(\d+)/, l) : prev.passed, /failed/.test(l) ? num(/^(\d+)/, l) : prev.failed, /skipped/.test(l) ? num(/^(\d+)/, l) : prev.skipped);
    } else if (/^(ok|FAIL)\s+\S+\s+(?:[\d.]+s|\(cached\))/.test(l) || /^--- (PASS|FAIL|SKIP):/.test(l)) {
      const prev = found && found.runner === 'go' ? found : { passed: 0, failed: 0, skipped: 0 };
      if (/^--- PASS/.test(l) || /^ok\s/.test(l)) set('go', prev.passed + 1, prev.failed, prev.skipped);
      else if (/^--- SKIP/.test(l)) set('go', prev.passed, prev.failed, prev.skipped + 1);
      else set('go', prev.passed, prev.failed + 1, prev.skipped);
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Scanning helpers

/** Run `{id, re}` catalog entries over text; returns `[{id, line, text}]` (line numbers 1-based). */
export function scanCatalog(text, catalog, lineMap = null) {
  const hits = [];
  if (!text || !Array.isArray(catalog)) return hits;
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  const lineAt = (idx) => {
    let lo = 0; let hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= idx) lo = mid; else hi = mid - 1; }
    return lo;
  };
  for (const entry of catalog) {
    if (!entry) continue;
    let re = entry.re;
    if (typeof re === 'string') { try { re = new RegExp(re); } catch { continue; } }
    if (!(re instanceof RegExp)) continue;
    const flags = new Set(re.flags.split(''));
    flags.add('g'); flags.add('m');
    let g;
    try { g = new RegExp(re.source, [...flags].join('')); } catch { continue; }
    let m;
    let guard = 0;
    while ((m = g.exec(text)) && guard++ < 50) {
      const idx = lineAt(m.index);
      const lineText = text.slice(starts[idx], idx + 1 < starts.length ? starts[idx + 1] - 1 : text.length);
      hits.push({ id: entry.id || 'marker', line: lineMap ? (lineMap[idx] ?? idx + 1) : idx + 1, text: truncate(lineText.trim(), 80) });
      if (m[0] === '') g.lastIndex++;
    }
  }
  const seen = new Set();
  return hits.filter((h) => { const k = `${h.id}:${h.line}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

function scanSecretsIn(markers, text, lineMap) {
  if (!text) return [];
  if (markers.scanSecrets) {
    try {
      const res = markers.scanSecrets(text);
      if (Array.isArray(res)) return res.map((r) => ({ id: r.id || 'secret', line: lineMap ? (lineMap[(r.line || 1) - 1] ?? r.line) : r.line, text: '' }));
    } catch {}
  }
  return scanCatalog(text, FALLBACK_SECRETS, lineMap).map((h) => ({ ...h, text: '' }));
}

/** Classification merged with the cached detect.json test globs. */
function classify(markers, rel, detectCache) {
  let c;
  try { c = markers.classifyPath(rel) || {}; } catch { c = fallbackClassify(rel); }
  const out = { ...fallbackClassify(rel), ...c };
  if (!out.test && detectCache) {
    for (const p of detectCache.projects || []) {
      const root = p && typeof p.root === 'string' ? p.root.replace(/^\.\/?/, '') : '';
      if (root && !rel.startsWith(`${root}/`)) continue;
      const sub = root ? rel.slice(root.length + 1) : rel;
      if (Array.isArray(p.test_globs) && matchAny(sub, p.test_globs.filter((g) => typeof g === 'string'))) { out.test = true; break; }
    }
  }
  return out;
}

const CLASS_LABEL = { test: 'test file', runnerConfig: 'runner config', ci: 'CI', lockfile: 'lockfile', lintConfig: 'lint/type config', manifest: 'manifest', generated: 'generated' };
const classNames = (c) => Object.keys(CLASS_LABEL).filter((k) => c[k]);

const isAbs = (p) => path.isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p);

/** Resolve symlinks of the longest existing prefix (macOS /var -> /private/var), keep the rest. */
function canonical(p) {
  let cur = p;
  const rest = [];
  for (let i = 0; i < 64; i++) {
    try { return path.join(fs.realpathSync.native(cur), ...rest.reverse()); } catch {}
    const parent = path.dirname(cur);
    if (parent === cur) return p;
    rest.push(path.basename(cur));
    cur = parent;
  }
  return p;
}

/** Absolute, symlink-resolved form of a tool path (relative paths resolve against the payload cwd). */
function absPath(h, p) {
  return canonical(isAbs(p) ? p : path.resolve(h.norm.cwd || h.root, p));
}

/** Path relative to the repo root (POSIX), or null when it is outside. */
function repoRel(h, p) {
  if (!p) return null;
  return relPosix(h.root, absPath(h, p));
}

function underState(rel, abs, st) {
  if (!rel && !abs) return false;
  const names = [STATE_DIR_NAME, st.rel].filter(Boolean);
  if (rel && names.some((n) => rel === n || rel.startsWith(`${n}/`))) return true;
  if (abs) {
    const r = path.relative(st.canonicalDir || st.dir, abs);
    if (r === '' || (!r.startsWith('..') && !path.isAbsolute(r))) return true;
  }
  return false;
}

const mentionsState = (token, st) => {
  const t = toPosix(token);
  return [STATE_DIR_NAME, st.rel].filter(Boolean).some((n) => new RegExp(`(^|[/=:'"])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(/|$)`).test(t));
};

// ---------------------------------------------------------------------------
// Shell parsing (guard and post-shell)

/** Split a command line into simple commands (arrays of tokens) on `&& || ; | &` and newlines. */
export function splitShell(cmd) {
  const segs = [];
  let tokens = [];
  let cur = '';
  let has = false;
  let q = null;
  const flushTok = () => { if (has) tokens.push(cur); cur = ''; has = false; };
  const flushSeg = () => { flushTok(); if (tokens.length) segs.push(tokens); tokens = []; };
  const s = String(cmd || '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q === "'") { if (c === "'") q = null; else cur += c; continue; }
    if (q === '"') {
      if (c === '\\' && (s[i + 1] === '"' || s[i + 1] === '\\')) { cur += s[++i]; continue; }
      if (c === '"') q = null; else cur += c;
      continue;
    }
    if (c === "'" || c === '"') { q = c; has = true; continue; }
    if (c === '\n' || c === '\r') { flushSeg(); continue; }
    if (c === ' ' || c === '\t') { flushTok(); continue; }
    if (c === ';' || c === '|' || c === '&') {
      if (c === '&' && /\d>$/.test(cur)) { cur += c; continue; } // 2>&1
      flushSeg();
      if (s[i + 1] === c) i++;
      continue;
    }
    cur += c; has = true;
  }
  flushSeg();
  return segs;
}

const WRAPPERS = new Set(['sudo', 'command', 'exec', 'env', 'time', 'nohup', 'builtin', 'noglob', 'call']);
const exeName = (t) => toPosix(t).split('/').pop().toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '');

/** Drop env assignments and wrappers; returns the tokens starting at the executable. */
function commandTokens(tokens) {
  let i = 0;
  while (i < tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]) || WRAPPERS.has(tokens[i]) || tokens[i] === '&')) i++;
  return tokens.slice(i);
}

/** Every simple command, with nested `sh -c "..."` / `pwsh -Command "..."` bodies expanded. */
function simpleCommands(cmd, depth = 0) {
  const out = [];
  for (const seg of splitShell(cmd)) {
    const toks = commandTokens(seg);
    if (!toks.length) continue;
    out.push(toks);
    const exe = exeName(toks[0]);
    if (depth < 2 && ['sh', 'bash', 'zsh', 'dash', 'pwsh', 'powershell', 'cmd'].includes(exe)) {
      const k = toks.findIndex((t, i) => i > 0 && ['-c', '-lc', '-ic', '-Command', '-command', '-c', '/c', '/C'].includes(t));
      if (k > 0 && toks[k + 1]) out.push(...simpleCommands(toks.slice(k + 1).join(' '), depth + 1));
    }
  }
  return out;
}

function gitParts(toks) {
  if (exeName(toks[0]) !== 'git') return null;
  let i = 1;
  while (i < toks.length && toks[i].startsWith('-')) {
    i += ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix', '--config-env'].includes(toks[i]) ? 2 : 1;
  }
  return i < toks.length ? { sub: toks[i], args: toks.slice(i + 1) } : null;
}

// Command classes for observed runs (post-shell), tested on a normalized simple command.
const RUN_CLASSES = [
  ['companion', /\badc\.mjs\s+(?:verify|clean-run|typecheck|flake-probe|coverage-delta|mutation-scope|live)\b/],
  ['test', /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|t)(?::\S*)?(?:\s|$)/],
  ['test', /^(?:npx|pnpx|bunx|yarn\s+dlx|pnpm\s+(?:dlx|exec)|yarn\s+exec)\s+(?:jest|vitest|mocha|ava|tap|karma|playwright\s+test|cypress\s+run)\b/],
  ['test', /^(?:jest|vitest|mocha|ava|karma|playwright\s+test|cypress\s+run|phpunit)\b/],
  ['test', /^(?:(?:uv|poetry|pdm|hatch|pipenv)\s+run\s+)?(?:python[0-9.]*\s+-m\s+)?(?:pytest|py\.test|unittest|nose2|tox|nox)\b/],
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

const NARROWING = /(?:\s-t\s|\s--testNamePattern\b|\s--testPathPattern\b|\s-k\s|\s--grep\b|\s-run\s|\s--filter\b|\s--only\b|\s--spec\b|\s--lf\b|\s--last-failed\b|\s--onlyChanged\b|\s--changed\b|::|\s\S+\.(?:test|spec)\.[A-Za-z0-9]+(?:\s|$)|\stest_\w+\.py\b|\s\S+_test\.go\b)/;

/** `{class, head, narrowed}` for a shell command line, or null when it is not a run we track. */
export function classifyRun(cmd, secretCheck = null) {
  for (const toks of simpleCommands(cmd)) {
    const norm = [exeName(toks[0]), ...toks.slice(1)].join(' ');
    const companion = /\badc\.mjs\b/.test(toks.join(' ')) && RUN_CLASSES[0][1].test(toks.map((t) => toPosix(t).split('/').pop()).join(' '));
    for (const [cls, re] of RUN_CLASSES) {
      if (cls === 'companion' ? !companion : !re.test(norm)) continue;
      // A normalized head, never the full line: secret-shaped tokens and values of credential-named
      // flags (`--token=x`, `--password x`) are dropped before anything is stored.
      const sensitiveFlag = /^--?[\w-]*(?:token|secret|passw|apikey|api-key|auth|credential)[\w-]*$/i;
      const head = toks.slice(0, 5).map((t, i, arr) => {
        if (/ADC_LIVE_TOKEN/i.test(t) || (secretCheck && secretCheck(t))) return '[REDACTED]';
        const eq = t.indexOf('=');
        if (eq > 0 && sensitiveFlag.test(t.slice(0, eq))) return `${t.slice(0, eq)}=[REDACTED]`;
        if (i > 0 && sensitiveFlag.test(arr[i - 1])) return '[REDACTED]';
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) return t.split('=')[0] + '=...';
        const p = t.replace(/\\/g, '/');
        return p.length > 40 ? truncate(p, 40) : p;
      }).join(' ');
      return { class: cls, head: truncate(head, 80), narrowed: cls === 'test' && NARROWING.test(` ${toks.slice(1).join(' ')} `) };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Session and ledger

/** The newest evidence ledger: `{file, verdict, ts}` or null (reads one or a few files). */
export function newestLedger(evidenceDir) {
  let names;
  try { names = fs.readdirSync(evidenceDir).filter((n) => n.endsWith('.json')); } catch { return null; }
  const stats = [];
  for (const n of names) {
    try {
      const st = fs.statSync(path.join(evidenceDir, n));
      if (st.isFile()) stats.push({ name: n, mtimeMs: st.mtimeMs });
    } catch {}
  }
  stats.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.name < b.name ? 1 : -1));
  for (const s of stats.slice(0, 5)) {
    const led = readJson(path.join(evidenceDir, s.name), null);
    if (!led || typeof led !== 'object' || Array.isArray(led)) continue;
    if (led.schema && !String(led.schema).startsWith('adc-evidence')) continue;
    const ts = [led.finalized_at, led.updated_at, led.created_at].find((t) => typeof t === 'string' && !Number.isNaN(Date.parse(t)))
      || new Date(s.mtimeMs).toISOString();
    return { file: s.name, verdict: typeof led.verdict === 'string' ? led.verdict : null, ts, finalized: Boolean(led.finalized_at) };
  }
  return null;
}

function hostTool(dialect, env) {
  if (dialect === 'copilot') {
    if (env.COPILOT_AGENT_PROMPT || env.GITHUB_COPILOT_API_TOKEN) return 'copilot-cloud';
    if (env.COPILOT_CLI) return 'copilot-cli';
    if (env.VSCODE_PID || env.TERM_PROGRAM === 'vscode') return 'vscode';
    return 'unknown';
  }
  return dialect === 'claude' ? 'claude-code' : 'codex';
}

function baseSession(cur, h) {
  const s = cur || {};
  s.schema = s.schema || 'adc-session/1';
  s.host = s.host || h.dialect;
  s.dialect = h.dialect;
  s.tool = s.tool && s.tool !== 'unknown' ? s.tool : hostTool(h.dialect, h.env);
  if (h.norm.permission_mode) s.permission_mode = h.norm.permission_mode;
  s.root = toPosix(h.root);
  s.events = s.events && typeof s.events === 'object' ? s.events : {};
  s.events[h.event] = (s.events[h.event] || 0) + 1;
  s.edits = s.edits && typeof s.edits === 'object' ? s.edits : { count: 0, first: null, last: null, classes: {}, files: [], times: [], findings: 0, state_dir_edits: 0 };
  s.observed_runs = Array.isArray(s.observed_runs) ? s.observed_runs : [];
  s.gate = s.gate && typeof s.gate === 'object' ? s.gate : { notices: 0, last_notice_epoch: null, blocks: 0, last_block_epoch: null, consecutive: 0 };
  s.guard = s.guard && typeof s.guard === 'object' ? s.guard : { denials: 0, asks: 0, last: null };
  if (s.ended === undefined) s.ended = false;
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
  if (!h.st || !h.st.ready || h.noWrite) {
    if (debugOn(h.env)) process.stderr.write(`adc hook-run: ${JSON.stringify(entry)}\n`);
    return;
  }
  hookLog(h.st.dir, { event: h.event, dialect: h.dialect, ...entry });
}

// ---------------------------------------------------------------------------
// Handlers

async function sessionStart(h) {
  const lines = [];
  lines.push(`agentic-developer-companion is installed (QA of agent-made changes, agentic tooling). Scripts: ${ADC_CMD} <command> --json; modes: verify, audit-tests, review, trace, regress, e2e, live, flake, ci-gate, tooling, doctor.`);
  const detect = readJson(h.st.paths.detect, null);
  const summary = detect && (typeof detect.summary === 'string' ? detect.summary : (detect.result && detect.result.summary));
  if (typeof summary === 'string' && summary.trim()) lines.push(`Detected stack (cached): ${truncate(summary.trim(), 200)}.`);
  const led = newestLedger(h.st.paths.evidence);
  lines.push(led
    ? `Newest verification ledger: .adc/evidence/${led.file}, verdict ${led.verdict || 'none yet'}, ${led.ts}.`
    : 'No verification ledger exists in this repository yet.');
  if (h.level !== 'advise') lines.push(h.level === 'guard'
    ? 'Hook level guard: completion is gated on a current ledger; force-push, history rewrites and access to .adc/ are denied.'
    : 'Hook level gate: completion is gated once per edit epoch on a ledger newer than the last edit.');
  lines.push('Operating rules: a claim counts as verified only with a ledger entry (command, exit code, output hash); tests, assertions, CI steps and lint settings are never weakened to get green; .adc/.env.live is never opened.');
  const tracked = trackedState(h.st, h.repo);
  if (tracked && tracked.length) {
    lines.push(`The companion state dir ${h.st.rel}/ is tracked by git (${tracked.length} file(s)); scripts refuse to run and hooks stay silent until it is untracked: ${ADC_CMD} doctor.`);
    if (debugOn(h.env)) process.stderr.write(`adc hook-run: session-start: STATE_TRACKED (${tracked.length} file(s))\n`);
    h.noWrite = true;
  }
  await record(h, (s) => {
    s.source = h.norm.source || s.source || null;
    s.state_tracked = tracked == null ? null : tracked.length > 0;
    s.level = h.level;
  }, { create: false });
  return { context: truncate(lines.join('\n'), BRIEF_LIMIT) };
}

async function postEdit(h) {
  const { norm } = h;
  if (norm.tool_kind !== 'edit') return {};
  const markers = await loadMarkers();
  const detect = readJson(h.st.paths.detect, null);
  const contents = extractContent(norm);
  const patch = parsePatch(norm.tool_input);
  const paths = extractPaths(norm);
  const ops = new Map(patch.map((f) => [f.path, f.op]));
  const notes = [];
  const classes = {};
  const files = [];
  let findings = 0;
  let stateEdits = 0;
  let codeEdits = 0;
  for (const p of paths) {
    const abs = absPath(h, p);
    const rel = relPosix(h.root, abs) || toPosix(p);
    if (underState(rel, abs, h.st)) {
      stateEdits++;
      notes.push(`- ${rel}: companion state under ${h.st.rel || STATE_DIR_NAME}/ (evidence, budget, credentials); evidence finalize re-checks ledger entry hashes.`);
      continue;
    }
    codeEdits++;
    const c = classify(markers, rel, detect);
    const names = classNames(c);
    for (const n of names) classes[n] = (classes[n] || 0) + 1;
    files.push(rel);
    const content = contents.find((x) => x.path === p) || (contents.length === 1 && !contents[0].path ? contents[0] : null) ||
      (paths.length === 1 ? contents[0] : null);
    const text = content ? content.text : '';
    const lineMap = content && content.lines ? content.lines : null;
    const hits = [];
    if (c.test) {
      for (const x of scanCatalog(text, markers.SKIP_MARKERS, lineMap)) hits.push(`adds a skip/focus marker (${x.id}) at line ${x.line}: ${x.text}`);
      for (const x of scanCatalog(text, markers.IN_SOURCE_RETRIES, lineMap)) hits.push(`adds an in-source retry (${x.id}) at line ${x.line}`);
    }
    if (c.ci) for (const x of scanCatalog(text, markers.CI_WEAKENING, lineMap)) hits.push(`weakens a CI step (${x.id}) at line ${x.line}: ${x.text}`);
    if (!c.generated) {
      for (const x of scanCatalog(text, markers.SUPPRESSIONS, lineMap)) hits.push(`adds a lint/type suppression (${x.id}) at line ${x.line}`);
      for (const x of scanCatalog(text, markers.SWALLOW_PATTERNS, lineMap)) hits.push(`adds an exception-swallowing pattern (${x.id}) at line ${x.line}`);
    }
    for (const x of scanSecretsIn(markers, text, lineMap)) hits.push(`adds a value shaped like a secret (${x.id}) at line ${x.line}`);
    findings += hits.length;
    const label = names.length ? ` (${names.map((n) => CLASS_LABEL[n]).join(', ')})` : '';
    const op = ops.get(p);
    if (op === 'delete' && c.test) notes.push(`- ${rel}${label}: deleted; test deletions are a CK-TEST-DEL check in verify.`);
    else if (op === 'delete' && (c.ci || c.runnerConfig)) notes.push(`- ${rel}${label}: deleted.`);
    if (hits.length) notes.push(`- ${rel}${label}: ${hits.slice(0, 6).join('; ')}.`);
    else if (op !== 'delete') {
      if (c.runnerConfig) notes.push(`- ${rel}${label}: test discovery and runner settings are compared with the base by verify (CK-TEST-CFG).`);
      else if (c.ci) notes.push(`- ${rel}${label}: CI test steps are compared with the base by verify (CK-CI).`);
      else if (c.lockfile) notes.push(`- ${rel}${label}: lockfile consistency with the manifest is a CK-LOCK check.`);
      else if (c.lintConfig) notes.push(`- ${rel}${label}: rules turned off here count as suppressions (CK-SUPPRESS).`);
      else if (c.manifest) notes.push(`- ${rel}${label}: test scripts and new dependencies are checked by verify (CK-TEST-CFG, CK-DEPS).`);
    }
  }
  if (codeEdits || stateEdits) {
    // The local clock, not the payload timestamp: the stop hook compares it with ledger times.
    const now = nowIso();
    await record(h, (s) => {
      const e = s.edits;
      if (codeEdits) {
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
  log(h, { tool: norm.tool_name, files: paths.length, classes, findings, keys: norm.keys, bytes: h.bytes, ms: Date.now() - h.t0, markers: markers.source }, true);
  if (!notes.length) return {};
  return { context: truncate(`agentic-developer-companion notes on this edit (notes, not verdicts; verify records evidence):\n${notes.join('\n')}`, 2000) };
}

async function postShell(h) {
  const { norm } = h;
  if (norm.tool_kind !== 'shell') return {};
  const cmd = shellCommand(norm.tool_input);
  const text = norm.tool_result_text || '';
  const decision = {};
  const notes = [];
  // Copilot can rewrite the tool result the model sees (§10.3.1); Claude and Codex cannot.
  const tokenShape = /ADC_LIVE_TOKEN\s*=\s*\S+/g;
  if (h.dialect === 'copilot' && text && tokenShape.test(text)) {
    decision.modifiedResult = { text: text.replace(/ADC_LIVE_TOKEN\s*=\s*\S+/g, 'ADC_LIVE_TOKEN=[REDACTED]'), resultType: norm.tool_result_type || 'success' };
    notes.push('The tool output contained an ADC_LIVE_TOKEN assignment; it was redacted from the result.');
    log(h, { condition: 'TOKEN_IN_OUTPUT', redacted: true });
  }
  if (/\.env\.live\b/.test(cmd)) notes.push('This command referenced .adc/.env.live; that file holds the live-test credential and only `adc.mjs live run` reads it.');
  const markers = await loadMarkers();
  const secretCheck = (t) => scanSecretsIn(markers, t, null).length > 0;
  const runInfo = cmd ? classifyRun(cmd, secretCheck) : null;
  if (runInfo) {
    const parser = await loadSummaryParser();
    let counts = null;
    try { counts = text ? parser.parse(text) : null; } catch { counts = null; }
    const obs = {
      ts: norm.timestamp || nowIso(),
      cmd_head: runInfo.head,
      class: runInfo.class,
      exit: norm.exit_code,
      counts: counts ? { passed: counts.passed ?? null, failed: counts.failed ?? null, skipped: counts.skipped ?? null, runner: counts.runner ?? null } : null,
      parse_source: counts ? 'summary-line' : 'none',
      source: 'hook:post-shell',
      narrowed: runInfo.narrowed,
    };
    await record(h, (s) => { s.observed_runs = [...s.observed_runs, obs].slice(-KEEP); });
    if (runInfo.narrowed) {
      notes.push(`Observed a narrowed test run (${runInfo.head}). Observed runs are not evidence for a "tests pass" claim; verify re-runs the whole suite of each affected project with retries off (CK-CLEANRUN).`);
    }
    log(h, { tool: norm.tool_name, class: runInfo.class, counts: Boolean(counts), keys: norm.keys, bytes: h.bytes, ms: Date.now() - h.t0 }, true);
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
  const edits = session && session.edits && Number(session.edits.count) > 0 ? session.edits : null;
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
  const ledText = led ? `newest ledger ${led.file} (verdict ${led.verdict || 'none'}, ${led.ts})` : 'no ledger yet';
  let claim = '';
  if (norm.last_message) {
    for (const re of CLAIM_RE) {
      const m = re.exec(norm.last_message);
      if (m) { claim = ` The final message states "${truncate(m[0], 60)}"; observed test runs do not support that claim, only CK-CLEANRUN in a ledger does.`; break; }
    }
  }
  const reasonCore = `${epoch} edit event(s) in this session are newer than the verification evidence (${ledText}).`;
  if (h.level === 'advise') {
    if (gate.last_notice_epoch === epoch) return {};
    await record(h, (s) => { s.gate.notices = (s.gate.notices || 0) + 1; s.gate.last_notice_epoch = epoch; });
    return { context: `agentic-developer-companion: ${reasonCore} ${ADC_CMD} verify --json records a ledger and verdict.${claim}` };
  }
  if (gate.last_block_epoch === epoch) return {};
  if ((gate.consecutive || 0) >= MAX_CONSECUTIVE_BLOCKS) {
    log(h, { condition: 'BLOCK_CAP', consecutive: gate.consecutive });
    return {};
  }
  await record(h, (s) => {
    s.gate.blocks = (s.gate.blocks || 0) + 1;
    s.gate.last_block_epoch = epoch;
    s.gate.consecutive = (s.gate.consecutive || 0) + 1;
  });
  log(h, { decision: 'block', epoch });
  return { block: `agentic-developer-companion completion gate: ${reasonCore} Run ${ADC_CMD} verify --json (it writes the ledger), then finish; the gate blocks once per edit epoch.${claim}` };
}

const GUARD_PREFIX = 'agentic-developer-companion guard:';

function guardShell(h, cmd) {
  const markers = h.markers;
  for (const toks of simpleCommands(cmd)) {
    const g = gitParts(toks);
    if (g) {
      const { sub, args } = g;
      const flags = args.filter((a) => a.startsWith('-'));
      const shortHas = (ch) => flags.some((a) => /^-[A-Za-z]+$/.test(a) && a.includes(ch));
      if (sub === 'push' && (flags.some((a) => /^--force(?:-with-lease(?:=.*)?|-if-includes)?$/.test(a) || a === '--mirror') || shortHas('f') ||
          args.some((a) => !a.startsWith('-') && a.startsWith('+')))) {
        return { deny: `${GUARD_PREFIX} \`git push --force\` rewrites published history. The guard level denies force-push and history rewrites (rebase, reset --hard, commit --amend, filter-branch); run it outside the agent if it is intended.`, rule: 'force-push' };
      }
      if (sub === 'rebase' && !args.some((a) => ['--abort', '--quit', '--show-current-patch'].includes(a))) {
        return { deny: `${GUARD_PREFIX} \`git rebase\` rewrites history; the guard level denies it (\`git rebase --abort\` stays allowed).`, rule: 'rebase' };
      }
      if (sub === 'reset' && args.includes('--hard')) return { deny: `${GUARD_PREFIX} \`git reset --hard\` discards commits and working-tree changes; the guard level denies it.`, rule: 'reset-hard' };
      if (sub === 'commit' && args.includes('--amend')) return { deny: `${GUARD_PREFIX} \`git commit --amend\` rewrites the last commit; the guard level denies it (make a new commit instead).`, rule: 'amend' };
      if (sub === 'filter-branch' || sub === 'filter-repo') return { deny: `${GUARD_PREFIX} \`git ${sub}\` rewrites history; the guard level denies it.`, rule: 'filter-branch' };
      if (sub === 'add' && (flags.includes('--force') || shortHas('f')) && args.some((a) => mentionsState(a, h.st))) {
        return { deny: `${GUARD_PREFIX} \`git add -f\` of ${h.st.rel || STATE_DIR_NAME}/ would commit companion state (credentials, budget, evidence); it stays git-ignored.`, rule: 'force-add-state' };
      }
      if (sub === 'commit' || sub === 'push') {
        const tracked = trackedState(h.st, h.repo);
        if (tracked && tracked.length) {
          h.noWrite = true;
          return { deny: `${GUARD_PREFIX} ${h.st.rel}/ is tracked by git (${tracked.length} file(s)), so this ${sub} could publish companion state (credentials, budget, evidence). Untrack it first: git rm -r --cached ${h.st.rel}`, rule: 'state-tracked' };
        }
      }
      if (sub === 'rm') {
        const victims = args.filter((a) => !a.startsWith('-')).map(toPosix).filter((a) => classify(markers, a.replace(/^\.\//, ''), h.detect).test);
        if (victims.length) return { ask: `${GUARD_PREFIX} this deletes test file(s) (${truncate(victims.join(', '), 120)}); verify flags test deletions (CK-TEST-DEL) unless the spec asks for them. Confirm the deletion is intended.`, rule: 'delete-test' };
      }
      if (['check-ignore', 'ls-files', 'status'].includes(sub)) continue;
    }
    const exe = exeName(toks[0]);
    const envLive = toks.slice(1).some((t) => /\.env\.live\b/.test(t) || /(^|[/\\'"=])\.adc[/\\]+(?:\.env|\.?\*)/.test(t));
    if (envLive && !(g && ['check-ignore', 'ls-files', 'status'].includes(g.sub))) {
      return { deny: `${GUARD_PREFIX} .adc/.env.live holds the live-test credential; only \`adc.mjs live run\` reads it, and host tools are denied access under the guard level.`, rule: 'env-live' };
    }
    if (['rm', 'del', 'erase', 'unlink', 'rmdir', 'rd', 'remove-item', 'ri'].includes(exe)) {
      const victims = toks.slice(1).filter((a) => !a.startsWith('-')).map(toPosix).filter((a) => classify(markers, a.replace(/^\.\//, ''), h.detect).test);
      if (victims.length) return { ask: `${GUARD_PREFIX} this deletes test file(s) (${truncate(victims.join(', '), 120)}); verify flags test deletions (CK-TEST-DEL) unless the spec asks for them. Confirm the deletion is intended.`, rule: 'delete-test' };
    }
  }
  return null;
}

async function preGuard(h) {
  const { norm } = h;
  h.markers = await loadMarkers();
  h.detect = readJson(h.st.paths.detect, null);
  let verdict = null;
  if (norm.tool_kind === 'shell') {
    const cmd = shellCommand(norm.tool_input);
    if (!cmd) return {};
    verdict = guardShell(h, cmd);
  } else if (norm.tool_kind === 'edit' || norm.tool_kind === 'read') {
    const paths = extractPaths(norm);
    const patterns = norm.tool_kind === 'read' ? extractPatterns(norm) : [];
    if (!paths.length && !patterns.length) return {};
    const ops = new Map(parsePatch(norm.tool_input).map((f) => [f.path, f.op]));
    for (const p of paths) {
      const abs = absPath(h, p);
      const rel = relPosix(h.root, abs);
      if (underState(rel, abs, h.st)) {
        verdict = norm.tool_kind === 'read'
          ? { deny: `${GUARD_PREFIX} ${h.st.rel || STATE_DIR_NAME}/ holds the live-test credential, the budget ledger and the evidence ledger; the guard level denies reading or searching it with host tools.`, rule: 'state-read' }
          : { deny: `${GUARD_PREFIX} files under ${h.st.rel || STATE_DIR_NAME}/ (evidence ledger, budget, credentials) are written only by the companion's scripts; the guard level denies editing them.`, rule: 'state-edit' };
        break;
      }
    }
    if (!verdict && patterns.some((pt) => mentionsState(pt, h.st) || /\.env\.live\b/.test(pt))) {
      verdict = { deny: `${GUARD_PREFIX} ${h.st.rel || STATE_DIR_NAME}/ holds the live-test credential and evidence; the guard level denies searching it with host tools.`, rule: 'state-read' };
    }
    if (!verdict && norm.tool_kind === 'edit') {
      for (const p of paths) {
        const rel = repoRel(h, p) || toPosix(p);
        const c = classify(h.markers, rel, h.detect);
        if (ops.get(p) === 'delete' && c.test) {
          verdict = { ask: `${GUARD_PREFIX} this deletes a test file (${rel}); verify flags test deletions (CK-TEST-DEL) unless the spec asks for them. Confirm the deletion is intended.`, rule: 'delete-test' };
          break;
        }
        if (c.ci) {
          verdict = { ask: `${GUARD_PREFIX} this edits CI configuration (${rel}); CI edits that weaken test steps fail verify (CK-CI). Confirm the change is intended.`, rule: 'ci-edit' };
          break;
        }
      }
    }
  }
  if (!verdict) return {};
  await record(h, (s) => {
    if (verdict.deny) s.guard.denials = (s.guard.denials || 0) + 1;
    else s.guard.asks = (s.guard.asks || 0) + 1;
    s.guard.last = { ts: nowIso(), rule: verdict.rule, decision: verdict.deny ? 'deny' : 'ask' };
  });
  log(h, { decision: verdict.deny ? 'deny' : 'ask', rule: verdict.rule, tool: norm.tool_name });
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

/** Handle one hook invocation. Returns the decision object (`{}` for no decision); never throws. */
export async function hookRunCommand(argv = [], { stdin = process.stdin, env = process.env } = {}) {
  const t0 = Date.now();
  let h = null;
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      options: {
        dialect: { type: 'string' }, level: { type: 'string' }, 'state-dir': { type: 'string' }, cwd: { type: 'string' },
        json: { type: 'boolean' }, yes: { type: 'boolean' }, 'dry-run': { type: 'boolean' },
      },
      allowPositionals: true,
      strict: false,
    });
    const event = positionals[0];
    const buf = await readStdin({ stream: stdin });
    if (!HOOK_EVENTS.includes(event)) {
      if (debugOn(env)) process.stderr.write(`adc hook-run: unknown event "${event}"\n`);
      return {};
    }
    const text = decodeStdin(buf);
    const payload = parsePayload(text);
    if (!payload) {
      if (debugOn(env)) process.stderr.write(`adc hook-run: ${event}: empty or malformed payload (${buf ? buf.length : 'overflow'} bytes)\n`);
      return {};
    }
    const explicit = typeof values.dialect === 'string' ? values.dialect : 'auto';
    const dialect = detectDialect(payload, { explicit, env });
    const norm = normalizePayload(payload, dialect, event);
    const repo = findRepo(norm.cwd) || findRepo(env.CLAUDE_PROJECT_DIR) || findRepo(typeof values.cwd === 'string' ? values.cwd : null) || findRepo(process.cwd());
    if (!repo) {
      if (debugOn(env)) process.stderr.write(`adc hook-run: ${event}: no git work tree for cwd ${norm.cwd || process.cwd()}\n`);
      return {};
    }
    const level = LEVELS.includes(values.level) ? values.level : 'advise';
    const st = hookStateInfo(repo, { stateDir: typeof values['state-dir'] === 'string' ? values['state-dir'] : null, env });
    // An existing state dir is usable for logging right away; a missing one is created lazily.
    if (fs.existsSync(st.dir)) ensureHookState(st, repo);
    h = { event, dialect, norm, repo, root: repo.root, level, st, env, t0, bytes: buf ? buf.length : 0, noWrite: false };
    // A tracked state dir (cached by the last session-start or guard check): stay silent and write
    // nothing; session-start re-checks and says so, the guard still denies commit and push.
    if (event !== 'session-start' && trackedCached(repo)) {
      h.noWrite = true;
      if (event !== 'pre-guard') return {};
    }
    const decision = await HANDLERS[event](h);
    const out = formatOutput(dialect, event, decision, { hostEvent: norm.host_event });
    log(h, { kind: Object.keys(decision || {}).join(',') || 'none', ms: Date.now() - t0, session: sha256(norm.session_id).slice(0, 8) }, true);
    return out;
  } catch (err) {
    try { if (h) log(h, { error: err && err.code ? err.code : 'HANDLER', message: truncate(err && err.message, 200) }); } catch {}
    if (debugOn(env)) process.stderr.write(`adc hook-run: ${err && err.stack ? err.stack : err}\n`);
    return {};
  }
}
