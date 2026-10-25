// Independent clean run of the working-tree snapshot (§7.4, §7.5, §9.1 steps 10-11, §9.1.1):
// temp worktrees in the OS temp dir, frozen install, the full suite per affected project with
// retries off, report parsing, counts vs the base, the red-green proof (§9.4) and the
// new-errors-only type check. Also exports the runner plumbing probes.mjs builds on.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  EXIT, AdcError, usageError, defineCommand, readJson, readText, writeFileAtomic, writeJsonAtomic,
  ensureDir, sha256, nonce, nowIso, toPosix, relPosix, quoteArg, tmpRoot, which, IS_WINDOWS,
  redactLiterals, run, truncate, stamp,
} from './core.mjs';
import { worktreeAdd, worktreeRemove, diffNameStatus, emptyTree, showFile, gitTry } from './git.mjs';
import { prepareTarget } from './state.mjs';
import { parseReport, parseSummaryText, normalizeFormat, detectReportFormat, rootVariants } from './reports.mjs';

const FM_CLEANRUN = ['FM-02', 'FM-13'];
const FM_REDGREEN = ['FM-03'];
const FM_TYPES = ['FM-04'];
const DEFAULT_TIMEOUT_S = 1800;
const LOG_HEAD = 2 * 1024 * 1024;
const LOG_TAIL = 8 * 1024 * 1024;
const MEM_CAP = 8 * 1024 * 1024;
const MAX_CACHED_IDS = 50_000;

// ---------------------------------------------------------------------------
// Runner knowledge used when detect is absent or a runner entry lacks a field.
// Placeholders: <f> report file, <d> report dir, <c> coverage file, <cdir> coverage dir.

export const RUNNER_DEFAULTS = Object.freeze({
  'node-test': {
    cmd: 'node --test',
    report: { flag: '--test-reporter=junit --test-reporter-destination=<f> --test-reporter=spec --test-reporter-destination=stdout', format: 'junit' },
    retries_off: { mechanism: 'node:test has no retries', coverage: 'full' },
    select: 'files', names: (n) => [`--test-name-pattern=${n}`],
    shuffle: (seed) => ['--test-randomize', `--test-random-seed=${seed}`],
    coverage: { flag: '--experimental-test-coverage --test-reporter=lcov --test-reporter-destination=<c>', format: 'lcov', file: 'lcov.info' },
  },
  jest: {
    cmd: 'npx jest --ci',
    report: { flag: '--json --outputFile=<f>', format: 'jest-json' },
    retries_off: { mechanism: 'jest.retryTimes() lives in code; retried tests are reported as flaky', coverage: 'partial' },
    select: 'files', names: (n) => ['-t', n],
    shuffle: (seed) => ['--randomize', `--seed=${seed}`],
    coverage: { flag: '--coverage --coverageReporters=json --coverageDirectory=<cdir>', format: 'istanbul', file: 'coverage-final.json' },
  },
  vitest: {
    cmd: 'npx vitest run',
    report: { flag: '--reporter=junit --outputFile=<f>', format: 'junit' },
    retries_off: { mechanism: '--retry=0', coverage: 'full' },
    select: 'files', names: (n) => ['-t', n],
    shuffle: (seed) => ['--sequence.shuffle', `--sequence.seed=${seed}`],
    coverage: { flag: '--coverage.enabled --coverage.reporter=json --coverage.reportsDirectory=<cdir> --coverage.reportOnFailure', format: 'istanbul', file: 'coverage-final.json', requires: ['@vitest/coverage-v8', '@vitest/coverage-istanbul'] },
  },
  playwright: {
    cmd: 'npx playwright test',
    report: { flag: '--reporter=junit', env: { PLAYWRIGHT_JUNIT_OUTPUT_NAME: '<f>' }, format: 'junit' },
    retries_off: { mechanism: '--retries=0', coverage: 'full' },
    select: 'files', names: (n) => ['-g', n], e2e: true,
  },
  cypress: {
    cmd: 'npx cypress run',
    report: { flag: '--reporter junit --reporter-options mochaFile=<f>', format: 'junit' },
    retries_off: { mechanism: '--config retries=0', coverage: 'full' },
    select: 'none', e2e: true,
  },
  mocha: {
    cmd: 'npx mocha',
    report: { flag: '--reporter xunit --reporter-option output=<f>', format: 'junit' },
    retries_off: { mechanism: '--retries 0', coverage: 'full' },
    select: 'files', names: (n) => ['-g', n],
  },
  pytest: {
    cmd: 'python -m pytest',
    report: { flag: '--junit-xml=<f>', format: 'junit' },
    retries_off: { mechanism: '-p no:rerunfailures', coverage: 'full' },
    select: 'pytest',
    shuffle: (seed) => [`--randomly-seed=${seed}`], shuffleRequires: ['pytest-randomly', 'pytest_randomly'],
    coverage: { flag: '--cov --cov-report=xml:<c>', format: 'cobertura', file: 'coverage.xml', requires: ['pytest-cov', 'pytest_cov'] },
  },
  // unittest prints summary lines only: counts, no test ids (red-green and per-id rules need a report).
  unittest: {
    cmd: 'python -m unittest discover',
    report: { format: 'summary-text', stdout: true },
    retries_off: { mechanism: 'unittest has no retries', coverage: 'full' },
    select: 'none',
  },
  go: {
    cmd: 'go test ./...',
    report: { flag: '-json', format: 'go-test-json', stdout: true },
    retries_off: { mechanism: '-count=1', coverage: 'full' },
    select: 'go', shuffle: (seed) => [`-shuffle=${seed}`],
    coverage: { flag: '-coverprofile=<c>', format: 'go-cover', file: 'cover.out' },
  },
  cargo: {
    cmd: 'cargo test --no-fail-fast',
    report: { format: 'cargo-text', stdout: true },
    retries_off: { mechanism: 'libtest has no retries; flaky tests cannot be distinguished', coverage: 'unknown' },
    select: 'cargo',
    coverage: { cmd: 'cargo llvm-cov --no-fail-fast --lcov --output-path <c>', format: 'lcov', file: 'lcov.info', tool: 'cargo-llvm-cov' },
  },
  nextest: {
    cmd: 'cargo nextest run --no-fail-fast',
    report: { flag: '--tool-config-file adc:<d>/nextest-adc.toml --profile adc-ci', path: '<target>/nextest/adc-ci/junit.xml', format: 'junit', nextestConfig: true },
    retries_off: { mechanism: '--retries 0', coverage: 'full' },
    select: 'cargo',
  },
  dotnet: {
    cmd: 'dotnet test',
    report: { flag: '--logger trx --results-directory <d>', dir: '<d>', glob: '*.trx', format: 'trx' },
    retries_off: { mechanism: 'VSTest has no retries; the MTP retry extension only runs when configured', coverage: 'unknown' },
    select: 'dotnet',
    coverage: { flag: '--collect:"XPlat Code Coverage;Format=cobertura" --results-directory <cdir>', format: 'cobertura', file: 'coverage.cobertura.xml', search: true },
  },
  maven: {
    cmd: 'mvn -B test',
    report: { dir: 'target/surefire-reports', glob: 'TEST-*.xml', format: 'junit' },
    retries_off: { mechanism: '-Dsurefire.rerunFailingTestsCount=0', coverage: 'full' },
    select: 'maven',
  },
  gradle: {
    cmd: IS_WINDOWS ? 'gradlew.bat test' : './gradlew test',
    report: { dir: 'build/test-results/test', glob: 'TEST-*.xml', format: 'junit' },
    retries_off: { mechanism: 'the test-retry plugin lives in the build script', coverage: 'unknown' },
    select: 'gradle',
  },
  rspec: {
    cmd: 'bundle exec rspec',
    report: { flag: '--format json --out <f> --format progress', format: 'rspec-json' },
    retries_off: { mechanism: 'rspec-retry lives in code', coverage: 'unknown' },
    select: 'files', names: (n) => ['-e', n], shuffle: (seed) => ['--order', `rand:${seed}`],
  },
});

const RUNNER_ALIASES = { 'node:test': 'node-test', node: 'node-test', 'cargo-test': 'cargo', 'cargo-nextest': 'nextest', 'go-test': 'go', 'dotnet-test': 'dotnet', surefire: 'maven' };

// Environment that narrows or redirects a test run, or carries credentials: never inherited.
const SCRUB_ENV = ['NODE_TEST_CONTEXT', 'PYTEST_ADDOPTS', 'GOFLAGS', 'VITEST', 'VITEST_MODE', 'VITEST_POOL_ID', 'VITEST_WORKER_ID', 'JEST_WORKER_ID', 'NEXTEST_RETRIES', 'NEXTEST_PROFILE', 'CARGO_TARGET_DIR'];

const CODE_EXT = /\.(?:[cm]?[jt]sx?|py|go|rs|cs|fs|vb|java|kt|kts|scala|groovy|rb|php|swift|m|mm|c|cc|cpp|cxx|h|hpp|vue|svelte|ex|exs|dart|lua|sh|ps1)$/i;
export const isCodeFile = (f) => CODE_EXT.test(String(f || ''));

// ---------------------------------------------------------------------------
// Small helpers

const log = (msg) => { if (process.env.ADC_QUIET !== '1') process.stderr.write(`adc: ${msg}\n`); };

/** Filesystem-safe project slug: '.' → 'root', 'packages/a' → 'packages-a'. */
export const projectSlug = (root) => (!root || root === '.' ? 'root' : toPosix(root).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'root');

/** Posix path for an artifact: repo-relative when inside the repo, absolute otherwise. */
export function artifactPath(repoRoot, file) {
  const rel = relPosix(repoRoot, file);
  return rel && rel !== '.' ? rel : toPosix(path.resolve(file));
}

let markersMod;
let secretRes = [];
/** Load markers.mjs once (dynamic: another work package) so redaction can run synchronously. */
export async function loadMarkers() {
  if (markersMod !== undefined) return markersMod;
  try { markersMod = await import('./markers.mjs'); } catch { markersMod = null; }
  const patterns = markersMod && Array.isArray(markersMod.SECRET_PATTERNS) ? markersMod.SECRET_PATTERNS : [];
  secretRes = patterns.filter((p) => p && p.re instanceof RegExp).map((p) => ({ id: p.id || 'secret', re: p.re.global ? p.re : new RegExp(p.re.source, p.re.flags + 'g') }));
  return markersMod;
}

/** Redact secret shapes (markers.SECRET_PATTERNS once loaded) and live-credential literals. */
export function redactSync(text) {
  if (text == null) return text;
  let out = String(text);
  const secrets = Object.entries(process.env).filter(([k, v]) => /^ADC_LIVE_TOKEN$|^ADC_LIVE_.*(?:TOKEN|SECRET|KEY|PASSWORD)/.test(k) && v).map(([name, value]) => ({ name, value }));
  out = redactLiterals(out, secrets);
  out = out.replace(/ADC_LIVE_TOKEN\s*=\s*\S+/g, 'ADC_LIVE_TOKEN=[REDACTED]');
  for (const p of secretRes) {
    try { out = out.replace(p.re, `[REDACTED:${p.id}]`); } catch {}
  }
  return out;
}

/** redactSync over every string in a JSON-like value (command results print project command lines). */
export function redactDeep(value, depth = 0) {
  if (typeof value === 'string') return redactSync(value);
  if (!value || typeof value !== 'object' || depth > 12) return value;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v, depth + 1);
  return out;
}

/** Async form of redactSync that makes sure the secret catalog is loaded first. */
export async function redactText(text) {
  await loadMarkers();
  return redactSync(String(text ?? ''));
}

/** Substitute placeholders; a value inside a double-quoted segment is inserted raw, else shell-quoted. */
export function substitute(template, values) {
  let out = '';
  let quotes = 0;
  for (let i = 0; i < template.length;) {
    const m = /^<(f|d|c|cdir|target)>/.exec(template.slice(i));
    if (m && values[m[1]] != null) {
      const v = toPosixIfNeeded(values[m[1]]);
      out += quotes % 2 ? v : quoteArg(v);
      i += m[0].length;
      continue;
    }
    if (template[i] === '"') quotes++;
    out += template[i++];
  }
  return out;
}
const toPosixIfNeeded = (p) => (IS_WINDOWS ? String(p) : toPosix(p));

/** Append arguments to a project command line (npm scripts need `--` before runner flags). */
export function appendArgs(cmd, args) {
  const extra = args.filter((a) => a != null && a !== '').join(' ');
  if (!extra) return cmd;
  // npm treats flags after a script name as its own config unless they follow `--`.
  if (/^\s*npm(?:\.cmd)?\s+(?:(?:run|run-script|rum|urn)\s+\S+|test|tst|t)(?:\s|$)/.test(cmd) && !/\s--(?:\s|$)/.test(cmd)) return `${cmd} -- ${extra}`;
  if (/^\s*cargo\s+(?:test|nextest\s+run)\b/.test(cmd) && /\s--(?:\s|$)/.test(cmd)) {
    const i = cmd.search(/\s--(?:\s|$)/);
    return `${cmd.slice(0, i)} ${extra}${cmd.slice(i)}`;
  }
  return `${cmd} ${extra}`;
}

// ---------------------------------------------------------------------------
// Process runner: own process group so a timeout kills grandchildren too; output streamed to a log.

/**
 * Run a project command line through the platform shell. Never throws.
 * Returns { exit, signal, ms, timedOut, error, stdout, stderr } (stdout/stderr capped in memory).
 */
export function runStep(commandLine, { cwd, env, timeoutMs = DEFAULT_TIMEOUT_S * 1000, logFile = null, captureFile = null } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const logFd = logFile ? fs.openSync(logFile, 'a') : null;
    const outFd = captureFile ? fs.openSync(captureFile, 'w') : null;
    const bufs = { stdout: [], stderr: [] };
    const sizes = { stdout: 0, stderr: 0 };
    let child = null;
    let timer = null;
    let settled = false;
    let timedOut = false;
    const finish = (exit, signal, error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (child) ACTIVE.delete(child);
      for (const fd of [logFd, outFd]) if (fd != null) { try { fs.closeSync(fd); } catch {} }
      resolve({
        exit: typeof exit === 'number' ? exit : null, signal: signal || null, ms: Date.now() - started, timedOut,
        error: error || null, stdout: Buffer.concat(bufs.stdout).toString('utf8'), stderr: Buffer.concat(bufs.stderr).toString('utf8'),
      });
    };
    const keep = (name, chunk) => {
      bufs[name].push(chunk);
      sizes[name] += chunk.length;
      while (sizes[name] > MEM_CAP && bufs[name].length > 1) sizes[name] -= bufs[name].shift().length;
    };
    try {
      child = spawn(commandLine, { cwd, env: env || process.env, shell: true, windowsHide: true, detached: !IS_WINDOWS, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      finish(null, null, err.code || err.message);
      return;
    }
    ACTIVE.add(child);
    watchSignals();
    if (timeoutMs > 0) timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    // The capture file holds both streams in arrival order (cargo prints `Running` lines on stderr).
    const write = (c) => { if (logFd != null) fs.writeSync(logFd, c); if (outFd != null) fs.writeSync(outFd, c); };
    child.stdout.on('data', (c) => { keep('stdout', c); write(c); });
    child.stderr.on('data', (c) => { keep('stderr', c); write(c); });
    child.on('error', (err) => finish(null, null, err.code || err.message));
    child.on('close', (code, signal) => finish(code, signal, null));
  });
}

const ACTIVE = new Set();
let signalsWatched = false;

/** On Ctrl-C or SIGTERM: kill running project commands (own process groups) and remove worktrees. */
function watchSignals() {
  if (signalsWatched) return;
  signalsWatched = true;
  for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    process.once(sig, () => {
      for (const c of ACTIVE) killTree(c);
      releaseWorktrees();
      process.exit(code);
    });
  }
}

function killTree(child) {
  if (!child || child.exitCode != null) return;
  try {
    if (IS_WINDOWS) run('taskkill', ['/pid', String(child.pid), '/T', '/F']);
    else process.kill(-child.pid, 'SIGKILL');
  } catch {
    try { child.kill('SIGKILL'); } catch {}
  }
}

/** Environment for project commands: CI semantics, no colors, no narrowing variables, no live credentials. */
export function runEnv(extra = {}) {
  const env = { ...process.env };
  const removed = new Set();
  for (const k of Object.keys(env)) {
    const live = /^ADC_LIVE_/.test(k) || k === 'ADC_TEST_RUN_ID' || k === 'ADC_PROBE_RESULT' || k === 'ADC_PROBE_ID';
    if (SCRUB_ENV.includes(k) || live) { delete env[k]; removed.add(live ? 'ADC_LIVE_*' : k); }
  }
  // An inherited NODE_OPTIONS=--test-shard=2/2 silently narrows node --test in base and snapshot
  // alike; its other options (CA certificates, memory limits) are kept.
  if (env.NODE_OPTIONS && /(?:^|\s)--test-/.test(env.NODE_OPTIONS)) {
    const tokens = env.NODE_OPTIONS.trim().split(/\s+/);
    const kept = [];
    for (let i = 0; i < tokens.length; i++) {
      if (!/^--test-/.test(tokens[i])) { kept.push(tokens[i]); continue; }
      if (!tokens[i].includes('=') && NODE_VALUE_OPTS.has(tokens[i]) && tokens[i + 1] && !tokens[i + 1].startsWith('-')) i++;
    }
    if (kept.length) env.NODE_OPTIONS = kept.join(' ');
    else delete env.NODE_OPTIONS;
    removed.add('NODE_OPTIONS --test-*');
  }
  // npm_config_yes=false: with CI set, `npx <tool>` would otherwise download an unpinned tool when
  // the project does not have it installed, and the clean run would test with the wrong version.
  const set = {
    CI: 'true', ADC_CLEAN_RUN: '1', NO_COLOR: '1', FORCE_COLOR: '0', PYTHONDONTWRITEBYTECODE: '1',
    npm_config_yes: 'false', npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false', ...extra,
  };
  return { env: { ...env, ...set }, removed: [...removed], set: Object.keys(set) };
}

// Output of a shell, npx, a Python launcher or a .NET host that could not find the program to run.
const RUNNER_MISSING_RE = /^(?:[\w./-]+(?: \d+)?: )+(?:command )?not found\s*$|^\w+: command not found: \S+\s*$|is not recognized as an internal or external command|npx canceled due to missing packages|npm (?:ERR!|error) could not determine executable to run|No module named (?:pytest|mypy|pyright)\b|^error: no such command: `|Could not execute because the specified command or file was not found|Could not find or load main class org\.apache\.maven/m;

/** True when a run's output says the runner itself is missing (not that tests failed). */
export const runnerMissing = (text) => RUNNER_MISSING_RE.test(String(text || ''));

// ---------------------------------------------------------------------------
// Worktree pool: one worktree per (commit, purpose) per process, removed at exit unless kept.

const POOL = new Map();
let exitHook = false;

/** Check out `commit` into a temp worktree for `label` ('head', 'base', 'typecheck', 'mutation', ...). */
export function acquireWorktree(root, commit, label, { keep = false, fresh = false } = {}) {
  const key = `${root}\0${commit}\0${label}`;
  const cur = POOL.get(key);
  if (cur && !cur.dirty && !fresh && fs.existsSync(cur.dir)) { if (keep) cur.keep = true; return cur; }
  if (cur) releaseEntry(key, cur);
  const dir = path.join(tmpRoot(root), `${label}-${String(commit).slice(0, 12)}-${nonce().slice(0, 6)}`);
  worktreeAdd(root, commit, dir);
  const entry = { key, root, commit, label, dir, keep, dirty: false, installed: new Map(), links: [] };
  POOL.set(key, entry);
  if (!exitHook) {
    exitHook = true;
    process.once('exit', () => releaseWorktrees());
  }
  return entry;
}

function releaseEntry(key, entry) {
  POOL.delete(key);
  if (entry.keep) return;
  // Remove dependency links first, so no recursive delete can ever reach the user's node_modules.
  for (const link of entry.links || []) {
    try { fs.unlinkSync(link); } catch { try { fs.rmdirSync(link); } catch {} }
  }
  try { worktreeRemove(entry.root, entry.dir); } catch {}
}

/** Remove every pooled worktree that was not kept (also runs at process exit). */
export function releaseWorktrees({ root = null } = {}) {
  for (const [key, entry] of [...POOL]) if (!root || entry.root === root) releaseEntry(key, entry);
}

// ---------------------------------------------------------------------------
// Detection: detect.mjs when present, a minimal built-in fallback otherwise.

/** DetectResult for `root` (detect.mjs, falling back to a built-in single-project detection). */
export async function loadDetect(root, stateInfo = null, { refresh = false } = {}) {
  try {
    const mod = await import('./detect.mjs');
    if (typeof mod.detect === 'function') {
      const res = await mod.detect({ root, stateInfo, refresh });
      if (res && Array.isArray(res.projects)) return { ...res, detect_source: res.detect_source || 'detect' };
    }
  } catch (err) {
    if (err instanceof AdcError && err.exit === EXIT.ENV) throw err;
    if (!(err && err.code === 'ERR_MODULE_NOT_FOUND')) log(`detect failed (${err && err.message}); using the built-in fallback detection`);
  }
  return fallbackDetect(root);
}

const exists = (dir, f) => fs.existsSync(path.join(dir, f));

/** Root-only detection for the stacks the clean run knows (used when detect.mjs is unavailable). */
export function fallbackDetect(root) {
  const project = { root: '.', languages: [], managers: [], runners: [], typecheck: [], test_globs: [] };
  const pkg = readJson(path.join(root, 'package.json'), null);
  const runner = (name, extra = {}) => ({ name, ...RUNNER_DEFAULTS[name], source: 'fallback-detect', ...extra });
  if (pkg) {
    project.languages.push(exists(root, 'tsconfig.json') ? 'typescript' : 'javascript');
    const lock = ['pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', 'package-lock.json', 'npm-shrinkwrap.json'].find((f) => exists(root, f));
    const install = { 'pnpm-lock.yaml': 'pnpm install --frozen-lockfile', 'yarn.lock': exists(root, '.yarnrc.yml') ? 'yarn install --immutable' : 'yarn install --frozen-lockfile', 'bun.lock': 'bun install --frozen-lockfile', 'bun.lockb': 'bun install --frozen-lockfile', 'package-lock.json': 'npm ci', 'npm-shrinkwrap.json': 'npm ci' }[lock];
    if (lock) project.managers.push({ name: lock.startsWith('pnpm') ? 'pnpm' : lock.startsWith('yarn') ? 'yarn' : lock.startsWith('bun') ? 'bun' : 'npm', lockfile: lock, install });
    const script = String((pkg.scripts || {}).test || '');
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    if (/\bnode\s+(?:[^|&;]*\s)?--test\b/.test(script)) project.runners.push(runner('node-test', { cmd: script.replace(/\s+--test-reporter(?:-destination)?(?:=\S+|\s+(?!-)\S+)/g, '').trim() }));
    else if (/\bvitest\b/.test(script) || deps.vitest) project.runners.push(runner('vitest'));
    else if (/\bjest\b/.test(script) || deps.jest) project.runners.push(runner('jest'));
    else if (/\bmocha\b/.test(script) || deps.mocha) project.runners.push(runner('mocha'));
    if (deps['@playwright/test'] || /playwright test/.test(script)) project.runners.push(runner('playwright'));
    if (exists(root, 'tsconfig.json')) project.typecheck.push({ name: 'tsc', cmd: 'npx tsc --noEmit --pretty false' });
    project.test_script = script || null;
  }
  if (exists(root, 'go.mod')) {
    project.languages.push('go');
    project.managers.push({ name: 'go', lockfile: exists(root, 'go.sum') ? 'go.sum' : null, install: 'go mod download' });
    project.runners.push(runner('go'));
    project.typecheck.push({ name: 'go-vet', cmd: 'go vet ./...' });
  }
  if (exists(root, 'Cargo.toml')) {
    project.languages.push('rust');
    if (exists(root, 'Cargo.lock')) project.managers.push({ name: 'cargo', lockfile: 'Cargo.lock', install: 'cargo fetch --locked' });
    project.runners.push(which('cargo-nextest') ? runner('nextest') : runner('cargo'));
    project.typecheck.push({ name: 'cargo-check', cmd: 'cargo check --all-targets --message-format=short' });
  }
  const py = ['pyproject.toml', 'pytest.ini', 'setup.cfg', 'tox.ini', 'setup.py', 'requirements.txt'].some((f) => exists(root, f));
  if (py || fs.existsSync(path.join(root, 'tests'))) {
    const hasPyTests = (() => { try { return walkSome(root, (f) => /(?:^|\/)(?:test_[^/]*|[^/]*_test)\.py$/.test(f)); } catch { return false; } })();
    if (py || hasPyTests) {
      project.languages.push('python');
      const uv = exists(root, 'uv.lock');
      if (uv) project.managers.push({ name: 'uv', lockfile: 'uv.lock', install: 'uv sync --locked' });
      project.runners.push(runner('pytest', { cmd: uv ? 'uv run pytest' : defaultPytestCmd() }));
      if (exists(root, 'mypy.ini') || /\[tool\.mypy\]/.test(readText(path.join(root, 'pyproject.toml'), ''))) project.typecheck.push({ name: 'mypy', cmd: 'mypy .' });
    }
  }
  if (exists(root, 'Gemfile') && fs.existsSync(path.join(root, 'spec'))) {
    project.languages.push('ruby');
    project.managers.push({ name: 'bundler', lockfile: 'Gemfile.lock', install: 'bundle install' });
    project.runners.push(runner('rspec'));
  }
  if (fs.readdirSync(root).some((f) => /\.(?:sln|slnx|csproj|fsproj)$/.test(f))) {
    project.languages.push('csharp');
    project.runners.push(runner('dotnet'));
    project.typecheck.push({ name: 'dotnet-build', cmd: 'dotnet build --nologo' });
  }
  if (exists(root, 'pom.xml')) { project.languages.push('java'); project.runners.push(runner('maven')); }
  else if (['build.gradle', 'build.gradle.kts'].some((f) => exists(root, f))) { project.languages.push('java'); project.runners.push(runner('gradle')); }
  return {
    detect_source: 'fallback-detect',
    summary: project.runners.map((r) => r.name).join(', ') || 'no runner detected',
    projects: project.languages.length || project.runners.length ? [project] : [],
    typecheck: [],
  };
}

/** `pytest` when it is on PATH, else `python -m pytest` (`python3` where `python` is absent). */
export const defaultPytestCmd = () => (which('pytest') ? 'pytest' : `${!IS_WINDOWS && !which('python') && which('python3') ? 'python3' : 'python'} -m pytest`);

function walkSome(root, pred, depth = 0) {
  if (depth > 4) return false;
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (['node_modules', '.git', '.venv', 'venv', '.adc', 'target', 'dist', 'build'].includes(e.name)) continue;
    const full = path.join(root, e.name);
    if (e.isDirectory()) { if (walkSome(full, (f) => pred(`${e.name}/${f}`), depth + 1)) return true; }
    else if (pred(e.name)) return true;
  }
  return false;
}

// A `--runner` command line that plainly invokes a known runner gets that runner's report and
// retries-off flags (appended at the end). Lines with shell operators stay opaque: appended
// flags would reach the last command, not the runner.
const INFER_RUNNER = [
  ['node-test', /^node(?:\.exe)?\s(?:.*\s)?--test(?:\s|$)/], ['playwright', /\bplaywright\s+test\b/], ['vitest', /\bvitest\b/],
  ['jest', /\bjest\b/], ['mocha', /\bmocha\b/], ['pytest', /(?:^|[\s/\\])(?:py\.test|pytest)(?:\.exe)?(?:\s|$)/],
  ['nextest', /\bcargo\s+nextest\s+run\b/], ['cargo', /\bcargo\s+test\b/], ['go', /\bgo\s+test\b/],
  ['dotnet', /\bdotnet\s+test\b/], ['rspec', /\brspec\b/], ['maven', /(?:^|[\s/\\])mvnw?(?:\.cmd)?\s(?:.*\s)?test(?:\s|$)/],
  ['gradle', /(?:^|[\s/\\])gradlew?(?:\.bat)?\s(?:.*\s)?test(?:\s|$)/],
];

/** Runner name for a command line such as `uv run pytest` or `go test ./pkg/...`, or null. */
export function inferRunner(line) {
  const s = String(line || '').trim();
  if (!s || /&&|\|\||[;|<>`]|\$\(/.test(s)) return null;
  const hit = INFER_RUNNER.find(([, re]) => re.test(s));
  return hit ? hit[0] : null;
}

/** Normalized runner: detect's entry completed with RUNNER_DEFAULTS; `--runner` may name a runner or give a command. */
export function resolveRunner(project, runnerOpt = null) {
  const detected = Array.isArray(project && project.runners) ? project.runners : [];
  const canon = (n) => RUNNER_ALIASES[String(n || '').toLowerCase()] || String(n || '').toLowerCase();
  const complete = (r) => {
    const name = canon(r.name);
    const def = RUNNER_DEFAULTS[name] || {};
    const rep = r.report || {};
    const hasTarget = (rep.flag && /<f>|<d>/.test(rep.flag)) || (rep.env && Object.values(rep.env).some((v) => /<f>/.test(v))) || rep.path || rep.dir || rep.stdout;
    const report = hasTarget && rep.format ? { ...rep } : (def.report ? { ...def.report } : (rep.format ? { ...rep } : null));
    if (report && ['go-test-json', 'cargo-text'].includes(normalizeFormat(report.format))) report.stdout = true;
    const cmd = r.cmd || (name === 'pytest' ? defaultPytestCmd() : def.cmd);
    return { ...def, ...r, name, cmd, report, retries_off: r.retries_off || def.retries_off || { mechanism: 'unknown', coverage: 'unknown' } };
  };
  if (runnerOpt) {
    const line = String(runnerOpt).trim();
    if (/\s/.test(line)) {
      const same = detected.find((r) => r.cmd && String(r.cmd).trim() === line);
      if (same) return { ...complete(same), source: same.source || 'detect' };
      const kind = inferRunner(line);
      if (kind) return { ...complete({ name: kind, cmd: line }), source: '--runner', inferred: true };
      return { name: 'custom', cmd: line, report: null, retries_off: { mechanism: 'custom command (not modified)', coverage: 'unknown' }, select: 'none', source: '--runner' };
    }
    const want = canon(runnerOpt);
    const hit = detected.find((r) => canon(r.name) === want);
    if (hit) return { ...complete(hit), source: hit.source || 'detect' };
    if (RUNNER_DEFAULTS[want]) return { ...complete({ name: want }), source: '--runner' };
    throw usageError(`--runner "${runnerOpt}" is neither a detected runner (${detected.map((r) => r.name).join(', ') || 'none'}), a known runner (${Object.keys(RUNNER_DEFAULTS).join(', ')}) nor a command line`);
  }
  if (!detected.length) return null;
  const script = String(project.test_script || '');
  const byScript = detected.find((r) => script && new RegExp(`\\b${canon(r.name).replace('node-test', 'node')}\\b`).test(script));
  const nonE2e = detected.find((r) => !(RUNNER_DEFAULTS[canon(r.name)] || {}).e2e && r.kind !== 'e2e');
  const chosen = byScript || nonE2e || detected[0];
  return complete(chosen);
}

/** The project owning a repo-relative file (longest matching root). */
export function projectOf(file, projects) {
  let best = null;
  for (const p of projects) {
    const r = toPosix(p.root || '.');
    if (r === '.' || file === r || file.startsWith(r + '/')) {
      if (!best || (r === '.' ? 0 : r.length) > (best.root === '.' ? 0 : toPosix(best.root).length)) best = p;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Install and run inside a worktree

const projectDir = (wt, project) => (project.root && project.root !== '.' ? path.join(wt.dir, project.root) : wt.dir);

const NODE_LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'];

/** Dependency manifest identity of a Node project at a commit vs the working tree (lockfile, else package.json deps). */
function sameNodeDeps(root, commit, rel) {
  const p = (f) => (rel ? `${rel}/${f}` : f);
  for (const lock of NODE_LOCKFILES) {
    const work = readText(path.join(root, rel, lock));
    const at = showFile(root, commit, p(lock));
    if (work != null || at != null) return work != null && at != null && work.replace(/\r\n/g, '\n') === at.replace(/\r\n/g, '\n');
  }
  const deps = (text) => {
    try { const j = JSON.parse(text); return JSON.stringify([j.dependencies || {}, j.devDependencies || {}, j.optionalDependencies || {}]); } catch { return null; }
  };
  const a = deps(readText(path.join(root, rel, 'package.json'), ''));
  return a != null && a === deps(showFile(root, commit, p('package.json')) || '');
}

/**
 * --no-install: link the working tree's node_modules into the worktree (junction on Windows) so
 * a Node project can run offline. Snapshot worktrees always match the working tree; a base
 * worktree is linked only when its dependency manifests are identical and the project has no
 * workspace links (those resolve to the working tree's packages, i.e. the snapshot's code).
 */
function linkDependencies(wt, project) {
  const rel = project.root && project.root !== '.' ? project.root : '';
  const out = { linked: [], not_linked: [] };
  const src = path.join(wt.root, rel, 'node_modules');
  const dest = path.join(wt.dir, rel, 'node_modules');
  if (!fs.existsSync(path.join(wt.dir, rel, 'package.json')) || !fs.existsSync(src) || fs.existsSync(dest)) return out;
  const relPath = toPosix(path.join(rel, 'node_modules'));
  if (wt.label === 'base') {
    const ws = (dir) => Boolean((readJson(path.join(dir, 'package.json'), {}) || {}).workspaces) || fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'));
    const workspaces = ws(path.join(wt.root, rel)) || (rel && ws(wt.root));
    if (workspaces) { out.not_linked.push({ path: relPath, reason: 'workspace links would resolve to the working tree' }); return out; }
    if (!sameNodeDeps(wt.root, wt.commit, rel)) { out.not_linked.push({ path: relPath, reason: 'dependencies differ between the base and the working tree' }); return out; }
  }
  try {
    fs.symlinkSync(src, dest, IS_WINDOWS ? 'junction' : 'dir');
    wt.links.push(dest);
    out.linked.push(relPath);
  } catch (err) {
    out.not_linked.push({ path: relPath, reason: err.code || err.message });
  }
  return out;
}

/** The install record without timings noise, or null when nothing happened. */
const installSummary = (i) => (i && (i.cmd || i.linked || i.not_linked)
  ? { cmd: i.cmd || null, exit: i.exit ?? null, ...(i.linked ? { linked: i.linked } : {}), ...(i.not_linked ? { not_linked: i.not_linked } : {}) } : null);

/** Frozen install for `project` in worktree `wt` (once per directory per worktree). */
export async function installProject(wt, project, { noInstall = false, timeoutMs, logFile } = {}) {
  if (noInstall) {
    const key = `no-install:${projectDir(wt, project)}`;
    if (wt.installed.has(key)) return wt.installed.get(key);
    const links = wt.links ? linkDependencies(wt, project) : { linked: [], not_linked: [] };
    const out = { cmd: null, exit: null, ms: 0, skipped: 'no-install', ...(links.linked.length ? { linked: links.linked } : {}), ...(links.not_linked.length ? { not_linked: links.not_linked } : {}) };
    wt.installed.set(key, out);
    return out;
  }
  const managers = Array.isArray(project.managers) ? project.managers : [];
  const m = managers.find((x) => x && x.install) || null;
  if (!m) return { cmd: null, exit: null, ms: 0, skipped: 'no frozen install command detected' };
  let dir = projectDir(wt, project);
  if (m.cwd) dir = path.join(wt.dir, m.cwd);
  else if (m.lockfile && !fs.existsSync(path.join(dir, m.lockfile))) {
    // Workspace installs run where the lockfile is (pnpm/yarn/npm workspaces, cargo workspaces).
    for (let d = path.dirname(dir); d.startsWith(wt.dir); d = path.dirname(d)) {
      if (fs.existsSync(path.join(d, m.lockfile))) { dir = d; break; }
      if (d === wt.dir) break;
    }
  }
  if (wt.installed.has(dir)) return { ...wt.installed.get(dir), reused: true };
  log(`install: ${m.install} (in ${toPosix(dir)})`);
  if (logFile) fs.appendFileSync(logFile, `$ ${m.install}\n`);
  const res = await runStep(m.install, { cwd: dir, env: runEnv().env, timeoutMs, logFile });
  const out = { cmd: m.install, exit: res.exit, ms: res.ms, timedOut: res.timedOut, ...(res.error ? { error: res.error } : {}) };
  wt.installed.set(dir, out);
  return out;
}

function cargoTargetDir(dir) {
  const res = run('cargo', ['metadata', '--format-version', '1', '--no-deps'], { cwd: dir, timeoutMs: 120_000 });
  try { return JSON.parse(res.stdout).target_directory || path.join(dir, 'target'); } catch { return path.join(dir, 'target'); }
}

/**
 * Build the command for `runner` in `dir`. `select` = { files, names } restricts the run;
 * `seed` adds the runner's shuffle flags; `coverage` adds its coverage flags.
 * Returns { cmd, env, report: { path|dir|stdout, format }, applied: { retries, select, shuffle, coverage } }.
 */
export function buildRunCommand(runner, { dir, outDir, select = null, seed = null, coverage = false, plan = false } = {}) {
  // `plan`: compute the command only (dry runs write nothing and run no cargo metadata).
  if (!plan) ensureDir(outDir);
  const fmt = runner.report ? normalizeFormat(runner.report.format) || runner.report.format : null;
  const ext = { junit: 'xml', trx: 'trx', 'jest-json': 'json', 'rspec-json': 'json', 'go-test-json': 'jsonl', 'cargo-text': 'txt' }[fmt] || 'out';
  const values = { f: path.join(outDir, `report.${ext}`), d: path.join(outDir, 'reports'), c: null, cdir: path.join(outDir, 'coverage'), target: null };
  if (!plan) ensureDir(values.d);
  const applied = { retries: null, select: null, shuffle: null, coverage: null };
  let cmd = runner.cmd;
  const env = {};
  if (coverage && runner.coverage && runner.coverage.cmd) cmd = runner.coverage.cmd;
  // node --test: every added flag goes before the file patterns, which are re-appended last.
  let nodePaths = [];
  if (runner.name === 'node-test') ({ head: cmd, paths: nodePaths } = splitNodeTestCmd(cmd, runner.paths));
  if (runner.name === 'cargo' && /^\s*cargo\s+test\b/.test(cmd) && !/--no-fail-fast/.test(cmd)) cmd = appendArgs(cmd, ['--no-fail-fast']);
  if (runner.name === 'nextest' && !/--no-fail-fast/.test(cmd)) cmd = appendArgs(cmd, ['--no-fail-fast']);
  const extra = [];
  const rep = runner.report;
  if (rep && rep.nextestConfig) {
    if (!plan) writeFileAtomic(path.join(values.d, 'nextest-adc.toml'), '[profile.adc-ci]\nfail-fast = false\nretries = 0\n\n[profile.adc-ci.junit]\npath = "junit.xml"\n');
    values.target = plan ? '<target>' : toPosix(cargoTargetDir(dir));
  }
  if (rep && rep.flag && !(coverage && runner.coverage && runner.coverage.cmd)) extra.push(substitute(rep.flag, values));
  if (rep && rep.env) for (const [k, v] of Object.entries(rep.env)) env[k] = String(v).replace(/<f>/g, values.f).replace(/<d>/g, values.d);
  // Retries off goes last: for these CLIs the last occurrence of an option wins.
  const mech = runner.retries_off && String(runner.retries_off.mechanism || '').trim();
  if (mech && /^-/.test(mech)) { if (!cmd.endsWith(mech)) extra.push(mech); applied.retries = mech; }
  if (runner.retries_off && runner.retries_off.env) Object.assign(env, runner.retries_off.env);
  if (seed != null && typeof runner.shuffle === 'function') { const s = runner.shuffle(seed); extra.push(...s.map(quoteArg)); applied.shuffle = s.join(' '); }
  if (coverage && runner.coverage) {
    const cv = runner.coverage;
    values.c = /<cdir>/.test(cv.flag || cv.cmd || '') ? path.join(values.cdir, cv.file || 'coverage.out') : path.join(outDir, cv.file || 'coverage.out');
    ensureDir(values.cdir);
    if (runner.coverage.cmd) cmd = substitute(cmd, values);
    else extra.push(substitute(runner.coverage.flag, values));
    applied.coverage = runner.coverage.cmd ? cmd : runner.coverage.flag;
  }
  if (select && (select.files.length || select.names.length)) {
    const sel = selectionArgs(runner, select, dir);
    if (sel && runner.name === 'node-test' && select.files.length) { cmd = dropNodeTestPaths(cmd); nodePaths = []; }
    if (sel) {
      if (sel.replacePackages) cmd = cmd.replace(/(\s)\.\/\.\.\.(?=\s|$)/, `$1${sel.replacePackages.map(quoteArg).join(' ')}`);
      if (sel.replacePackages && !/\s\.\/\S/.test(cmd)) extra.push(...sel.replacePackages.map(quoteArg));
      extra.push(...sel.args);
      applied.select = sel.describe;
    }
  }
  extra.push(...nodePaths);
  cmd = appendArgs(cmd, extra);
  const fillPath = (t) => String(t).replace(/<(f|d|c|cdir|target)>/g, (m, k) => (values[k] != null ? values[k] : m));
  const report = !rep ? null
    : rep.stdout ? { stdout: values.f, format: fmt }
      : rep.path ? { path: path.resolve(dir, fillPath(rep.path)), format: fmt }
        : rep.dir ? { dir: path.resolve(dir, fillPath(rep.dir)), glob: rep.glob || '*', format: fmt }
          : { path: values.f, format: fmt };
  return { cmd, env, report, applied, coverageFile: values.c, coverageDir: values.cdir };
}

// node options that take their value as the next argument (`--import tsx`, `--test-concurrency 1`).
const NODE_VALUE_OPTS = new Set(['--import', '--require', '-r', '--loader', '--experimental-loader', '--conditions', '-C',
  '--env-file', '--env-file-if-exists', '--input-type', '--title', '--disable-warning', '--watch-path', '--experimental-config-file',
  '--test-concurrency', '--test-name-pattern', '--test-skip-pattern', '--test-reporter', '--test-reporter-destination',
  '--test-timeout', '--test-shard', '--test-isolation', '--test-global-setup', '--test-coverage-include', '--test-coverage-exclude',
  '--test-coverage-branches', '--test-coverage-functions', '--test-coverage-lines', '--test-random-seed']);

/**
 * Split a `node --test` command line into the part before its file patterns and the patterns.
 * node treats everything after the first pattern as arguments, so added flags must go before
 * them (`node --test test/ --test-reporter=junit` runs nothing as intended). Uses detect's
 * `paths` when they are the command's tail; otherwise tokenizes. Unclear lines stay whole.
 */
export function splitNodeTestCmd(cmd, paths = null) {
  const s = String(cmd || '').replace(/\s+$/, '');
  if (Array.isArray(paths) && paths.length) {
    const tail = ` ${paths.join(' ')}`;
    if (s.endsWith(tail)) return { head: s.slice(0, -tail.length), paths: [...paths] };
  }
  const at = /(?:^|\s)--test(?=\s|$)/.exec(s);
  if (!at) return { head: s, paths: [] };
  const end = at.index + at[0].length;
  const rest = s.slice(end);
  const tokens = [...rest.matchAll(/\s+("[^"]*"|'[^']*'|\S+)/g)].map((m) => ({ text: m[1], start: m.index }));
  let cut = -1;
  for (let i = 0, value = false; i < tokens.length; i++) {
    const t = tokens[i].text;
    if (value) { value = false; continue; }
    if (t.startsWith('-')) { value = !t.includes('=') && NODE_VALUE_OPTS.has(t); continue; }
    cut = i;
    break;
  }
  if (cut === -1) return { head: s, paths: [] };
  const tail = tokens.slice(cut).map((t) => t.text);
  // Options after a pattern, or shell operators: not a plain pattern list, leave the line alone.
  if (tail.some((t) => /^-/.test(t) || /^[&|;<>()]/.test(t) || /[&|;<>]$/.test(t))) return { head: s, paths: [] };
  return { head: s.slice(0, end) + rest.slice(0, tokens[cut].start), paths: tail };
}

/**
 * `node --test test/` restricted to files must not keep its own path arguments (they would run
 * the whole directory again). Only trailing arguments that look like paths or globs are dropped.
 */
export function dropNodeTestPaths(cmd) {
  const m = /^(\s*node(?:\.exe)?\b.*?\s--test\b(?:\s+--[\w-]+(?:=\S+)?)*)((?:\s+(?!-)\S+)+)\s*$/.exec(cmd);
  if (!m) return cmd;
  const args = m[2].trim().split(/\s+/);
  return args.every((a) => /[/\\*]|\.[cm]?[jt]sx?$/.test(a)) ? m[1] : cmd;
}

/** Runner arguments that restrict a run to `files` (repo-relative to the project) and test `names`. */
export function selectionArgs(runner, { files = [], names = [] }, dir) {
  const kind = runner.select || 'none';
  const q = (a) => quoteArg(a);
  const named = names.length && typeof runner.names === 'function' ? runner.names(names.map(escapeRe).join('|')).map(q) : [];
  switch (kind) {
    case 'files': return { args: [...files.map(q), ...named], describe: `files: ${files.join(', ')}${names.length ? `; names: ${names.join(', ')}` : ''}` };
    case 'pytest': return { args: files.flatMap((f) => (names.length ? names.map((n) => q(`${f}::${n}`)) : [q(f)])), describe: `files: ${files.join(', ')}` };
    case 'go': {
      const dirs = [...new Set(files.map((f) => { const d = toPosix(path.posix.dirname(f)); return d === '.' ? '.' : `./${d}`; }))];
      const tests = names.length ? names : files.flatMap((f) => goTestNames(path.join(dir, f)));
      return { args: tests.length ? [q(`-run=^(?:${tests.map(escapeRe).join('|')})$`)] : [], replacePackages: dirs, describe: `packages: ${dirs.join(', ')}; tests: ${tests.join(', ') || 'all'}` };
    }
    case 'cargo': {
      const bins = files.filter((f) => /^tests\/[^/]+\.rs$/.test(toPosix(f))).map((f) => path.posix.basename(toPosix(f), '.rs'));
      const src = files.filter((f) => /^src\//.test(toPosix(f)));
      // Unit tests in src/main.rs or src/bin/* belong to binary targets (`--lib` fails on a bin-only crate).
      const binSrc = src.filter((f) => /^src\/(?:main\.rs$|bin\/)/.test(toPosix(f)));
      const hasLib = fs.existsSync(path.join(dir, 'src', 'lib.rs'));
      const mods = src.filter((f) => !binSrc.includes(f)).map((f) => toPosix(f).replace(/^src\//, '').replace(/(?:\/mod)?\.rs$/, '').replace(/\//g, '::')).filter((m) => m && m !== 'lib');
      const args = [...bins.flatMap((b) => ['--test', q(b)])];
      const filters = [...names, ...(binSrc.length ? [] : mods.map((m) => `${m}::`))];
      if (!bins.length && src.length) {
        if (hasLib && src.length > binSrc.length) args.push('--lib');
        if (binSrc.length || !hasLib) args.push('--bins');
      }
      if (filters.length) args.push('--', ...filters.map(q));
      return { args, describe: `targets: ${bins.join(', ') || 'lib'}; filters: ${filters.join(', ') || 'none'}` };
    }
    case 'dotnet': {
      const classes = names.length ? names : files.flatMap((f) => classNames(path.join(dir, f)));
      return classes.length ? { args: ['--filter', q(classes.map((c) => `FullyQualifiedName~${c}`).join('|'))], describe: `classes: ${classes.join(', ')}` } : null;
    }
    case 'maven': {
      const classes = names.length ? names : files.flatMap((f) => classNames(path.join(dir, f)));
      return classes.length ? { args: [q(`-Dtest=${classes.join(',')}`), '-Dsurefire.failIfNoSpecifiedTests=false'], describe: `classes: ${classes.join(', ')}` } : null;
    }
    case 'gradle': {
      const classes = names.length ? names : files.flatMap((f) => classNames(path.join(dir, f)));
      return classes.length ? { args: classes.flatMap((c) => ['--tests', q(c)]), describe: `classes: ${classes.join(', ')}` } : null;
    }
    default: return null;
  }
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const goTestNames = (file) => [...readText(file, '').matchAll(/^func (Test\w*)\(\w+ \*testing\.T\)/gm)].map((m) => m[1]);
const classNames = (file) => [...readText(file, '').matchAll(/\bclass\s+([A-Z]\w*)/g)].map((m) => m[1]);

/** A reused worktree may hold reports of an earlier run (fixed paths, report dirs): never parse those. */
function clearStaleReport(report, roots) {
  if (!report) return;
  const inside = (p) => roots.some((r) => { const rel = path.relative(r, p); return rel && !rel.startsWith('..') && !path.isAbsolute(rel); });
  try {
    if (report.path && inside(report.path)) fs.rmSync(report.path, { force: true });
    if (report.dir && inside(report.dir) && fs.existsSync(report.dir)) {
      const re = new RegExp(`^${report.glob.split('*').map(escapeRe).join('.*')}$`);
      for (const f of fs.readdirSync(report.dir)) if (re.test(f)) fs.rmSync(path.join(report.dir, f), { force: true });
    }
  } catch {}
}

function collectReportText(report, stdoutText) {
  if (!report) return null;
  if (report.stdout) return fs.existsSync(report.stdout) ? readText(report.stdout, '') : stdoutText;
  if (report.path) return fs.existsSync(report.path) ? readText(report.path, null) : null;
  if (report.dir) {
    if (!fs.existsSync(report.dir)) return null;
    const re = new RegExp(`^${report.glob.split('*').map(escapeRe).join('.*')}$`);
    const files = fs.readdirSync(report.dir).filter((f) => re.test(f)).sort();
    return files.length ? { multi: files.map((f) => ({ file: path.join(report.dir, f), text: readText(path.join(report.dir, f), '') })) } : null;
  }
  return null;
}

/** Parse what a run produced: the report (merged when the runner writes one file per class), else summary lines. */
export function parseRunOutput(report, stdoutText, stderrText, roots) {
  const raw = collectReportText(report, stdoutText);
  const opts = { root: roots };
  const parseOne = (text) => {
    const fmt = (report && report.format) || detectReportFormat(text);
    return parseReport(fmt || 'auto', text, opts);
  };
  // Runners without a report (unittest, minitest, make/just/npm wrappers) have summary lines only.
  const summaryOnly = Boolean(report && report.format === 'summary-text');
  try {
    if (summaryOnly) { /* nothing to parse as a report */ } else if (raw && raw.multi) {
      const parts = raw.multi.map((m) => parseOne(m.text));
      const tests = parts.flatMap((p) => p.tests);
      const sum = (k) => parts.reduce((a, p) => a + (p[k] || 0), 0);
      return { counts: { executed: sum('executed'), passed: sum('passed'), failed: sum('failed'), errors: sum('errors'), skipped: sum('skipped'), flaky: sum('flaky') }, tests, source: 'report', format: parts[0] ? parts[0].format : null, reportText: raw.multi.map((m) => m.text).join('\n') };
    } else if (raw != null && String(raw).trim()) {
      const p = parseOne(raw);
      const { tests, format, ...counts } = p;
      return { counts: pickCounts(counts), tests, source: 'report', format, reportText: raw, seeds: p.seeds || [] };
    }
  } catch (err) {
    log(`report could not be parsed (${err.message}); falling back to summary lines`);
  }
  const s = parseSummaryText(`${stdoutText}\n${stderrText}`);
  if (s && s.passed != null && s.failed != null) {
    const errors = s.errors || 0;
    const flaky = s.flaky || 0;
    return { counts: { executed: s.passed + s.failed + errors + flaky, passed: s.passed, failed: s.failed, errors, skipped: s.skipped || 0, flaky }, tests: [], source: 'summary-text', format: `summary:${s.runner}`, reportText: null };
  }
  return { counts: null, tests: [], source: 'none', format: null, reportText: raw && !raw.multi ? raw : null, summary: s };
}

const pickCounts = (c) => ({ executed: c.executed, passed: c.passed, failed: c.failed, errors: c.errors, skipped: c.skipped, flaky: c.flaky });

/**
 * Install (unless done) and run `runner` for `project` in worktree `wt`. Writes `run.log` and the
 * report under `outDir`. Returns the run record including parsed counts and tests.
 */
export async function runProject(wt, project, runner, { outDir, noInstall = false, timeoutMs = DEFAULT_TIMEOUT_S * 1000, select = null, seed = null, coverage = false, logName = 'run.log' } = {}) {
  ensureDir(outDir);
  const logFile = path.join(outDir, logName);
  fs.writeFileSync(logFile, '');
  const dir = projectDir(wt, project);
  const install = await installProject(wt, project, { noInstall, timeoutMs, logFile });
  let built = buildRunCommand(runner, { dir, outDir, select, seed, coverage });
  const base = { cmd: built.cmd, install, applied: built.applied, report_path: null, log_path: logFile, dir, coverageFile: built.coverageFile, coverageDir: built.coverageDir, retries_off: runner.retries_off || null };
  if (install.cmd && install.exit !== 0) {
    return { ...base, exit: null, ms: 0, counts: null, tests: [], source: 'none', status: 'unverified', reason: install.timedOut ? 'INSTALL_TIMEOUT' : 'INSTALL_FAILED' };
  }
  const exec = async () => {
    clearStaleReport(built.report, [wt.dir, outDir]);
    log(`run: ${built.cmd} (in ${toPosix(dir)})`);
    fs.appendFileSync(logFile, `$ ${built.cmd}\n`);
    return runStep(built.cmd, { cwd: dir, env: runEnv(built.env).env, timeoutMs, logFile, captureFile: built.report && built.report.stdout ? built.report.stdout : null });
  };
  const { removed, set } = runEnv(built.env);
  let res = await exec();
  const fallback = pytestRerunsFallback(runner, built, res);
  if (fallback) {
    runner = fallback;
    built = buildRunCommand(runner, { dir, outDir, select, seed, coverage });
    Object.assign(base, { cmd: built.cmd, applied: built.applied, retries_off: runner.retries_off });
    res = await exec();
  }
  const parsed = parseRunOutput(built.report, res.stdout, res.stderr, [dir, wt.dir]);
  const reportPath = built.report ? (built.report.stdout || built.report.path || built.report.dir || null) : null;
  const missing = !parsed.counts && res.exit !== 0 && runnerMissing(`${res.stderr}\n${res.stdout}`.slice(-20_000));
  return {
    ...base, exit: res.exit, signal: res.signal, ms: res.ms, timedOut: res.timedOut, error: res.error, ...(missing ? { runnerMissing: true } : {}),
    counts: parsed.counts, tests: parsed.tests, source: parsed.source, format: parsed.format, seeds: parsed.seeds || [],
    report_path: reportPath && fs.existsSync(reportPath) ? reportPath : null, reportText: parsed.reportText,
    env: { set, removed }, stdoutTail: truncateTail(res.stdout, 4000), stderrTail: truncateTail(res.stderr, 4000),
  };
}

/**
 * pytest with pytest-rerunfailures configured in addopts (`--reruns 2`) or `flaky` markers under
 * --strict-markers rejects `-p no:rerunfailures` with a usage error. Retries are then turned off
 * with `--reruns 0`, which wins over addopts; `@pytest.mark.flaky(reruns=n)` still applies, so the
 * coverage is partial (reruns stay visible in the report as flaky).
 */
function pytestRerunsFallback(runner, built, res) {
  if (runner.name !== 'pytest' || built.applied.retries !== '-p no:rerunfailures' || res.exit === 0) return null;
  const out = `${res.stderr}\n${res.stdout}`.slice(-50_000);
  if (!/unrecognized arguments:.*--(?:reruns|only-rerun|rerun-except|force-reruns)\b|'flaky' not found in `markers` configuration option/.test(out)) return null;
  return { ...runner, retries_off: { mechanism: '--reruns 0', coverage: 'partial', note: 'pytest-rerunfailures is configured, so it cannot be disabled; @pytest.mark.flaky(reruns=n) still reruns' } };
}

const truncateTail = (s, n) => (s && s.length > n ? '...' + s.slice(-n) : s || '');

// ---------------------------------------------------------------------------
// Artifacts: redacted copies under .adc/cache/runs/<tree12>/<slug>/<run-id>/

// One folder per target (one CLI invocation; verify shares its target across steps): a ledger
// hashes its artifacts when a check is added, so a later run of the same tree (audit-tests after
// verify, a repeated clean-run) must never overwrite them.
export const runIdOf = (target) => target.adcRunId || (target.adcRunId = `${stamp()}-${nonce().slice(0, 6)}`);
const RUN_DIR_RE = /^\d{8}T\d{6}Z-[0-9a-f]{6}$/;
const KEEP_RUNS = 20;
const KEEP_TREES = 50;
const pruned = new Set();

/** Keep the newest run folders per tree/project and the newest tree folders (old trees are stale anyway). */
function pruneRuns(runsDir, treeDir, slugDir, runId) {
  if (pruned.has(`${slugDir}\0${runId}`)) return;
  pruned.add(`${slugDir}\0${runId}`);
  const newest = (dir, keep, filter) => {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && filter(e.name))
        .map((e) => ({ full: path.join(dir, e.name), t: fs.statSync(path.join(dir, e.name)).mtimeMs })).sort((a, b) => b.t - a.t);
      return entries.slice(keep).map((e) => e.full);
    } catch { return []; }
  };
  const old = [...newest(slugDir, KEEP_RUNS, (n) => RUN_DIR_RE.test(n) && n !== runId),
    ...newest(runsDir, KEEP_TREES, (n) => path.join(runsDir, n) !== treeDir)];
  for (const d of old) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
}

/** Copy a run's report and log into the state dir (redacted); returns posix artifact paths and the log hash. */
export async function storeArtifacts(target, tree, slug, runRec, { prefix = '' } = {}) {
  const runsDir = path.join(target.state.paths.cache, 'runs');
  const treeDir = path.join(runsDir, String(tree).slice(0, 12));
  const runId = runIdOf(target);
  const dir = path.join(treeDir, slug, runId);
  ensureDir(dir);
  pruneRuns(runsDir, treeDir, path.join(treeDir, slug), runId);
  const artifacts = [];
  let logHash = null;
  let logStored = null;
  let reportStored = null;
  if (runRec.log_path && fs.existsSync(runRec.log_path)) {
    const raw = readCapped(runRec.log_path);
    const text = await redactText(raw);
    logStored = path.join(dir, `${prefix}run.log`);
    writeFileAtomic(logStored, text);
    logHash = sha256(text);
    artifacts.push(artifactPath(target.root, logStored));
  }
  if (runRec.report_path && fs.existsSync(runRec.report_path)) {
    const st = fs.statSync(runRec.report_path);
    if (st.isDirectory()) {
      const sub = path.join(dir, `${prefix}reports`);
      ensureDir(sub);
      for (const f of fs.readdirSync(runRec.report_path)) {
        const src = path.join(runRec.report_path, f);
        if (fs.statSync(src).isFile()) writeFileAtomic(path.join(sub, f), await redactText(readText(src, '')));
      }
      reportStored = sub;
    } else {
      reportStored = path.join(dir, `${prefix}${path.basename(runRec.report_path)}`);
      writeFileAtomic(reportStored, await redactText(readCapped(runRec.report_path)));
    }
    artifacts.push(artifactPath(target.root, reportStored));
  }
  return { artifacts, output_sha256: logHash, log_path: logStored ? artifactPath(target.root, logStored) : null, report_path: reportStored ? artifactPath(target.root, reportStored) : null };
}

function readCapped(file) {
  const size = fs.statSync(file).size;
  if (size <= LOG_HEAD + LOG_TAIL) return readText(file, '');
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(LOG_HEAD);
    const tail = Buffer.alloc(LOG_TAIL);
    fs.readSync(fd, head, 0, LOG_HEAD, 0);
    fs.readSync(fd, tail, 0, LOG_TAIL, size - LOG_TAIL);
    return `${head.toString('utf8')}\n[... ${size - LOG_HEAD - LOG_TAIL} bytes omitted by agentic-developer-companion ...]\n${tail.toString('utf8')}`;
  } finally {
    fs.closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// Base counts: --base-counts file > .adc/cache/counts/<base-sha>-<slug>.json > a base-worktree run

const countsFile = (state, sha, slug) => path.join(state.paths.countsCache, `${sha}-${slug}.json`);

function readCountsCache(state, sha, slug, runnerName) {
  const c = readJson(countsFile(state, sha, slug), null);
  if (!c || c.schema !== 'adc-counts/1' || (runnerName && c.runner && c.runner !== runnerName)) return null;
  return c;
}

function writeCountsCache(state, sha, slug, rec) {
  try {
    writeJsonAtomic(countsFile(state, sha, slug), { schema: 'adc-counts/1', base_sha: sha, project: rec.project, runner: rec.runner, cmd: redactSync(rec.cmd), ...pickCounts(rec.counts), tests: (rec.tests || []).slice(0, MAX_CACHED_IDS).map((t) => ({ id: t.id, status: t.status, ...(t.file ? { file: t.file } : {}) })), created_at: nowIso() });
  } catch (err) {
    log(`could not write the counts cache: ${err.message}`);
  }
}

/** Counts for `projectRoot` from a --base-counts file: a clean-run result, a counts object, or a map by project. */
export function importBaseCounts(file, projectRoot) {
  const json = readJson(file, null);
  if (!json) throw usageError(`--base-counts: cannot read JSON from ${toPosix(file)}`);
  const norm = (c) => (c && Number.isFinite(c.executed) ? { ...pickCounts({ passed: 0, failed: 0, errors: 0, skipped: 0, flaky: 0, ...c }), ...(c.tests ? { tests: c.tests } : {}) } : null);
  if (Array.isArray(json.projects)) {
    const p = json.projects.find((x) => toPosix(x.root || '.') === toPosix(projectRoot || '.'));
    return p ? norm(p.run || p.counts || p) : null;
  }
  if (json.projects && typeof json.projects === 'object') return norm(json.projects[projectRoot] || json.projects[toPosix(projectRoot)]);
  return norm(json.run || json);
}

// ---------------------------------------------------------------------------
// Outcomes (§9.1.1)

/** Does a parsed test belong to `file` (repo- or project-relative)? Uses file attributes, ids, modules, packages. */
export function testMatchesFile(t, file, { goModule = null, projectRoot = '.' } = {}) {
  const f = toPosix(file);
  const rel = projectRoot && projectRoot !== '.' && f.startsWith(projectRoot + '/') ? f.slice(projectRoot.length + 1) : f;
  const variants = new Set([f, rel]);
  if (t.file) {
    const tf = toPosix(t.file);
    for (const v of variants) if (tf === v || tf.endsWith('/' + v) || v.endsWith('/' + tf)) return true;
  }
  const id = String(t.id || '');
  for (const v of variants) {
    if (id.startsWith(v + '::') || id.includes(`/${v}::`)) return true;
    const noExt = v.replace(/\.[^./]+$/, '');
    const dotted = noExt.replace(/\//g, '.');
    if (dotted && (id.startsWith(dotted + '::') || id.startsWith(dotted + '.') || id === dotted)) return true;
  }
  if (t.package && /\.go$/.test(f)) {
    const dir = path.posix.dirname(rel);
    if (goModule && (t.package === (dir === '.' ? goModule : `${goModule}/${dir}`))) return true;
    if (!goModule && (dir === '.' ? !t.package.includes('/') : t.package.endsWith('/' + dir))) return true;
  }
  return false;
}

/**
 * Status for one project run (§9.1.1). `explained`: base tests gone from the run whose deletion
 * was waived (CK-TEST-DEL); `nowSkipped`: base tests that still exist but are skipped now (by id;
 * estimated from the skipped counts when null). Skipped tests fall under the skip rule, not the
 * shortfall rule; only tests that vanished from the run are a shortfall.
 */
export function evaluateRun(run, base, { explained = 0, skipFired = false, nowSkipped = null } = {}) {
  if (run.status === 'unverified') return { status: 'unverified', reason: run.reason };
  if (run.timedOut) return { status: 'unverified', reason: 'TIMEOUT' };
  if (run.error === 'ENOENT' || run.exit === 127 || (IS_WINDOWS && run.exit === 9009)) return { status: 'unverified', reason: 'RUNNER_NOT_FOUND' };
  const c = run.counts;
  if (!c) return { status: 'unverified', reason: run.runnerMissing ? 'RUNNER_NOT_FOUND' : run.source === 'none' && run.exit === 0 ? 'COUNTS_UNKNOWN' : 'NO_REPORT' };
  if (c.executed === 0) return { status: 'unverified', reason: 'NO_TESTS_EXECUTED' };
  if (c.failed > 0 || c.errors > 0) return { status: 'fail', reason: 'TESTS_FAILED' };
  let waived = null;
  if (base && c.executed < base.executed) {
    const drop = base.executed - c.executed;
    const skipShift = Math.min(drop, nowSkipped != null ? nowSkipped : Math.max(0, c.skipped - (base.skipped || 0)));
    const shortfall = drop - skipShift;
    if (shortfall > explained) return { status: 'fail', reason: 'COUNT_SHORTFALL', shortfall };
    if (shortfall > 0) waived = { status: 'finding', reason: 'SHORTFALL_WAIVED', shortfall };
  }
  if (run.exit !== 0) return { status: 'fail', reason: 'EXIT_NONZERO' };
  if (base && c.skipped > (base.skipped || 0)) return { status: skipFired ? 'fail' : 'finding', reason: 'SKIP_INCREASE' };
  if (waived) return waived;
  if (c.flaky > 0) return { status: 'finding', reason: 'FLAKY' };
  return { status: 'pass', reason: null };
}

const RANK = { fail: 5, unverified: 4, finding: 3, 'pass-with-baseline': 2, pass: 1, skipped: 0 };
export const worstStatus = (list) => list.reduce((a, s) => ((RANK[s] ?? 0) > (RANK[a] ?? 0) ? s : a), 'skipped');
const ENV_REASONS = new Set(['RUNNER_NOT_FOUND', 'CHECKER_NOT_FOUND']);

/**
 * Command exit code: 1 for fail/finding, 4 for unverified, 3 when every unverified check is
 * unverified only because the runner or checker executable is missing (environment, §7.2).
 */
export function exitFor(status, checks = null) {
  if (status === 'fail' || status === 'finding') return EXIT.FINDINGS;
  if (status !== 'unverified') return EXIT.OK;
  const open = (checks || []).filter((c) => c && c.status === 'unverified');
  return open.length && open.every((c) => ENV_REASONS.has(c.reason)) ? EXIT.ENV : EXIT.UNVERIFIABLE;
}

const fmtCounts = (c) => (c ? `${c.executed} executed, ${c.passed} passed, ${c.failed} failed, ${c.errors} errors, ${c.skipped} skipped, ${c.flaky} flaky` : 'no counts');

/** Newest ledger in the state dir for this tree digest (waivers and fired checks for §9.1.1). */
function ledgerContext(state, tree) {
  const dir = state.paths.evidence;
  let best = null;
  try {
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      const j = readJson(path.join(dir, f), null);
      if (!j || j.tree_digest !== tree) continue;
      const t = Date.parse(j.finalized_at || j.created_at || '') || fs.statSync(path.join(dir, f)).mtimeMs;
      if (!best || t > best.t) best = { t, j };
    }
  } catch {}
  if (!best) return { waivers: [], fired: [] };
  return {
    waivers: (best.j.waivers || []).filter((w) => w && w.check === 'CK-TEST-DEL'),
    fired: (best.j.checks || []).filter((c) => c && (c.status === 'fail' || c.status === 'finding')).map((c) => c.id),
  };
}

// ---------------------------------------------------------------------------
// clean-run

function changedPaths(target) {
  const from = target.base.sha || emptyTree(target.root);
  return diffNameStatus(target.root, from, target.snapshot.commit).flatMap((f) => [f.path, f.oldPath].filter(Boolean));
}

function goModuleOf(dir) {
  const m = /^module\s+(\S+)/m.exec(readText(path.join(dir, 'go.mod'), '') || '');
  return m ? m[1] : null;
}

/**
 * Clean run of the snapshot (§9.1 step 11). Returns
 * `{ tree_digest, base, projects[], status, red_green?, checks[] }` with one CK-CLEANRUN check per project.
 */
export async function cleanRun({ target, detectResult = null, noInstall = false, runner = null, allProjects = false, baseCountsFile = null, noBase = false, keep = false, redGreen = null, waivers, firedChecks, timeoutS = DEFAULT_TIMEOUT_S, dryRun = false, detectFn = null } = {}) {
  const root = target.root;
  const tree = target.snapshot.tree;
  await loadMarkers();
  const det = detectResult || await loadDetect(root, target.state);
  let projects = Array.isArray(det.projects) ? det.projects : [];
  // An unknown stack with a user-given command line runs that command at the repository root.
  if (!projects.length && runner && /\s/.test(String(runner).trim())) projects = [{ root: '.', languages: [], managers: [], runners: [] }];
  const changed = changedPaths(target);
  const affected = allProjects ? projects : projects.filter((p) => changed.some((f) => projectOf(f, projects) === p));
  const timeoutMs = Math.max(1, Number(timeoutS) || DEFAULT_TIMEOUT_S) * 1000;
  const ctxLedger = ledgerContext(target.state, tree);
  const waived = waivers !== undefined ? (waivers || []).filter((w) => !w.check || w.check === 'CK-TEST-DEL') : ctxLedger.waivers;
  const fired = firedChecks !== undefined ? firedChecks || [] : ctxLedger.fired;
  const out = { tree_digest: tree, base: { ref: target.base.ref, sha: target.base.sha, source: target.base.source }, detect_source: det.detect_source || 'detect', changed_files: changed.length, projects: [], status: 'skipped', checks: [] };

  if (!projects.length || (!affected.length && !runner)) {
    const reason = projects.length ? 'NO_AFFECTED_PROJECT' : 'NO_RUNNER';
    const summary = projects.length ? `no detected project owns a changed file (${changed.length} changed); nothing to run (use --all-projects)` : 'no test runner detected; ask the user for the test command and pass --runner "<command>"';
    const status = projects.length ? 'skipped' : 'unverified';
    out.status = status;
    out.checks.push(makeCheck({ id: 'CK-CLEANRUN', fm: FM_CLEANRUN, project: '.', status, reason, summary }));
    if (redGreen && redGreen.length) out.red_green = { status: 'unverified', reason, pairs: [] };
    return out;
  }
  const targets = affected.length ? affected : projects.slice(0, 1);
  for (const project of targets) {
    out.projects.push(await cleanRunProject({ target, project, runnerOpt: runner, noInstall, baseCountsFile, noBase, keep, timeoutMs, waived, fired, dryRun, detectFn }));
  }
  out.status = worstStatus(out.projects.map((p) => p.status));
  out.checks = out.projects.map((p) => p.check);
  for (const p of out.projects) delete p.check;
  if (redGreen && redGreen.length) {
    out.red_green = await redGreenProof({ target, projects, files: redGreen, runnerOpt: runner, noInstall, keep, timeoutMs, dryRun });
    out.checks.push(out.red_green.check);
    delete out.red_green.check;
    out.status = worstStatus([out.status, out.red_green.status]);
  }
  if (!keep) releaseWorktrees({ root });
  return out;
}

async function cleanRunProject({ target, project, runnerOpt, noInstall, baseCountsFile, noBase, keep, timeoutMs, waived, fired, dryRun, detectFn }) {
  const root = target.root;
  const tree = target.snapshot.tree;
  const slug = projectSlug(project.root);
  const prow = { root: toPosix(project.root || '.'), worktree: null, kept: Boolean(keep), install: null, run: null, base_counts: null, delta: null, report_path: null, log_path: null, status: 'unverified', reason: null };
  const runner = resolveRunner(project, runnerOpt);
  if (!runner) {
    prow.reason = 'NO_RUNNER';
    prow.check = makeCheck({ id: 'CK-CLEANRUN', fm: FM_CLEANRUN, project: prow.root, status: 'unverified', reason: 'NO_RUNNER', summary: `no test runner detected for ${prow.root}; pass --runner "<command>"` });
    return prow;
  }
  const others = (project.runners || []).map((r) => r.name).filter((n) => n && n !== runner.name && RUNNER_ALIASES[n] !== runner.name);
  if (dryRun) {
    const built = buildRunCommand(runner, { dir: path.join(tmpRoot(root), 'dry-run'), outDir: path.join(tmpRoot(root), 'dry-run-out'), plan: true });
    prow.status = 'skipped';
    prow.reason = 'DRY_RUN';
    prow.run = { cmd: built.cmd, runner: runner.name };
    prow.install = { cmd: noInstall ? null : ((project.managers || []).find((m) => m.install) || {}).install || null };
    prow.check = makeCheck({ id: 'CK-CLEANRUN', fm: FM_CLEANRUN, project: prow.root, status: 'skipped', reason: 'DRY_RUN', command: built.cmd, summary: `dry run: would run \`${built.cmd}\` in a temp worktree of ${tree.slice(0, 12)}` });
    return prow;
  }
  const outRoot = path.join(tmpRoot(root), `out-${tree.slice(0, 12)}-${nonce().slice(0, 6)}`);
  const head = acquireWorktree(root, target.snapshot.commit, 'head', { keep });
  prow.worktree = toPosix(head.dir);
  const runRec = await runProject(head, project, runner, { outDir: path.join(outRoot, slug, 'head'), noInstall, timeoutMs });
  const stored = await storeArtifacts(target, tree, slug, runRec);
  prow.install = runRec.install;
  prow.report_path = stored.report_path;
  prow.log_path = stored.log_path;
  prow.run = {
    runner: runner.name, cmd: runRec.cmd, exit: runRec.exit, ms: runRec.ms, ...(runRec.counts || { executed: null, passed: null, failed: null, errors: null, skipped: null, flaky: null }),
    retries_disabled: (runRec.retries_off || runner.retries_off).coverage || 'unknown', mechanism: (runRec.retries_off || runner.retries_off).mechanism || null, count_source: runRec.source, report_format: runRec.format || null,
    env: runRec.env, ...(runRec.timedOut ? { timed_out: true } : {}),
  };
  if (others.length) prow.other_runners = others;

  // Base counts.
  let base = null;
  if (!noBase) base = await baseCounts({ target, project, runner, slug, baseCountsFile, noInstall, timeoutMs, outRoot, keep, detectFn });
  prow.base_counts = base ? { ...(Number.isFinite(base.executed) ? pickCounts(base) : {}), source: base.source, ...(base.cmd ? { cmd: base.cmd } : {}), ...(base.status ? { status: base.status } : {}), ...(base.reason ? { reason: base.reason } : {}), ...(base.install ? { install: base.install } : {}) } : (noBase ? { source: 'none', reason: '--no-base' } : null);
  const baseOk = base && Number.isFinite(base.executed) ? base : null;
  if (baseOk && runRec.counts) {
    prow.delta = { executed: runRec.counts.executed - baseOk.executed, passed: runRec.counts.passed - baseOk.passed, failed: runRec.counts.failed - baseOk.failed, skipped: runRec.counts.skipped - baseOk.skipped, flaky: runRec.counts.flaky - (baseOk.flaky || 0) };
  }
  // Cache the head counts under HEAD when the snapshot equals HEAD (a future base).
  const headTree = target.snapshot.head ? gitTry(root, ['rev-parse', `${target.snapshot.head}^{tree}`]) : null;
  if (runRec.counts && headTree === tree && target.snapshot.head) writeCountsCache(target.state, target.snapshot.head, slug, { project: prow.root, runner: runner.name, cmd: runRec.cmd, counts: runRec.counts, tests: runRec.tests });

  // A shortfall explained by waived test deletions (CK-TEST-DEL) is a finding, not a failure;
  // base tests that are merely skipped now are counted by id when both runs have ids.
  let explained = 0;
  let nowSkipped = null;
  if (baseOk && runRec.counts && runRec.counts.executed < baseOk.executed && Array.isArray(baseOk.tests) && baseOk.tests.length && (runRec.tests || []).length) {
    const headById = new Map(runRec.tests.map((t) => [t.id, t]));
    const ranInBase = baseOk.tests.filter((t) => t.status !== 'skipped');
    nowSkipped = ranInBase.filter((t) => headById.has(t.id) && headById.get(t.id).status === 'skipped').length;
    const gone = ranInBase.filter((t) => !headById.has(t.id));
    if (waived.length) explained = gone.filter((t) => waived.some((w) => w.file && testMatchesFile(t, w.file, { projectRoot: prow.root }))).length;
  }
  const verdict = evaluateRun(runRec, baseOk, { explained, skipFired: fired.includes('CK-SKIP'), nowSkipped });
  prow.status = verdict.status;
  prow.reason = verdict.reason;
  const findings = [];
  for (const t of (runRec.tests || []).filter((x) => x.status === 'failed' || x.status === 'error').slice(0, 50)) {
    findings.push({ id: 'CK-CLEANRUN', severity: 'fail', file: t.file || null, line: null, message: `${t.status}: ${t.id}`, evidence: truncate(t.message || '', 200) });
  }
  for (const t of (runRec.tests || []).filter((x) => x.status === 'flaky').slice(0, 50)) {
    findings.push({ id: 'CK-CLEANRUN', severity: 'finding', file: t.file || null, line: null, message: `flaky (passed after a retry): ${t.id}`, evidence: truncate(t.message || '', 200) });
  }
  const parts = [fmtCounts(runRec.counts)];
  if (baseOk) parts.push(`(base: ${baseOk.executed}/${baseOk.passed}/${baseOk.failed}/${baseOk.skipped})`);
  else if (prow.base_counts && prow.base_counts.source === 'none') parts.push('(no base counts)');
  else if (prow.base_counts && prow.base_counts.status === 'unverified') parts.push(`(the base run gave no counts: ${prow.base_counts.reason}; shortfall not checked)`);
  parts.push(`retries_disabled: ${prow.run.retries_disabled}`);
  if (prow.run.retries_disabled !== 'full') parts.push(`(${prow.run.mechanism})`);
  if (baseOk && (baseOk.failed || baseOk.errors) && verdict.reason === 'TESTS_FAILED') parts.push(`(the base fails too: ${baseOk.failed} failed, ${baseOk.errors} errors)`);
  if (verdict.reason && verdict.status !== 'pass') parts.push(`- ${verdict.reason}${verdict.shortfall ? ` (${verdict.shortfall} fewer tests than the base)` : ''}`);
  if (runRec.source === 'summary-text') parts.push('[counts from summary lines, no report]');
  if (runRec.install && runRec.install.linked) parts.push('[--no-install: node_modules linked from the working tree]');
  if (/^INSTALL_/.test(verdict.reason || '')) parts.push(`(\`${runRec.install.cmd}\` exited ${runRec.install.exit ?? 'on timeout'}; without network access re-run with --no-install to use the installed dependencies)`);
  if (others.length) parts.push(`[not run: ${others.join(', ')}]`);
  prow.summary = parts.join(' ');
  if (!keep) fs.rmSync(outRoot, { recursive: true, force: true });
  prow.check = makeCheck({
    id: 'CK-CLEANRUN', fm: FM_CLEANRUN, project: prow.root, status: verdict.status, reason: verdict.reason,
    command: [runRec.install && runRec.install.cmd, runRec.cmd].filter(Boolean).join(' && '), cwd: toPosix(runRec.dir), exit_code: runRec.exit,
    duration_ms: (runRec.install && runRec.install.ms || 0) + (runRec.ms || 0), summary: prow.summary, output_sha256: stored.output_sha256,
    // The base run's report and log back the base counts the outcome depends on.
    artifacts: [...stored.artifacts, ...((base && base.source === 'run' && base.artifacts) || [])], findings,
    data: { runner: runner.name, run: prow.run, install: prow.install, base_counts: prow.base_counts, delta: prow.delta, worktree: keep ? prow.worktree : null, kept: Boolean(keep), shortfall_explained: explained },
  });
  return prow;
}

async function baseCounts({ target, project, runner, slug, baseCountsFile, noInstall, timeoutMs, outRoot, keep, detectFn }) {
  const root = target.root;
  const sha = target.base.sha;
  if (baseCountsFile) {
    const c = importBaseCounts(path.resolve(root, baseCountsFile), toPosix(project.root || '.'));
    if (c) return { ...c, source: 'file' };
  }
  if (!sha) return { source: 'none', reason: 'NO_BASE' };
  const cached = readCountsCache(target.state, sha, slug, runner.name);
  if (cached) return { ...cached, source: 'cache' };
  const baseWt = acquireWorktree(root, sha, 'base', { keep });
  const pdir = projectDir(baseWt, project);
  if (!fs.existsSync(pdir)) return { executed: 0, passed: 0, failed: 0, errors: 0, skipped: 0, flaky: 0, tests: [], source: 'absent-in-base' };
  // The base runs its own command (a narrowed test script in the snapshot must not narrow the base).
  let baseRunner = runner;
  try {
    const bdet = detectFn ? await detectFn(baseWt.dir) : await loadDetect(baseWt.dir, null);
    const bp = (bdet.projects || []).find((p) => toPosix(p.root || '.') === toPosix(project.root || '.'));
    const br = bp ? resolveRunner(bp, runner.source === '--runner' && (runner.name === 'custom' || runner.inferred) ? runner.cmd : runner.name) : null;
    if (br) baseRunner = br;
  } catch {}
  const rec = await runProject(baseWt, project, baseRunner, { outDir: path.join(outRoot, slug, 'base'), noInstall, timeoutMs });
  const stored = await storeArtifacts(target, target.snapshot.tree, slug, rec, { prefix: 'base-' });
  const install = installSummary(rec.install);
  if (!rec.counts) return { source: 'run', status: 'unverified', reason: rec.reason || (rec.runnerMissing ? 'RUNNER_NOT_FOUND' : 'NO_REPORT'), cmd: rec.cmd, artifacts: stored.artifacts, ...(install ? { install } : {}) };
  writeCountsCache(target.state, sha, slug, { project: toPosix(project.root || '.'), runner: runner.name, cmd: rec.cmd, counts: rec.counts, tests: rec.tests });
  return { ...rec.counts, tests: rec.tests, source: 'run', cmd: rec.cmd, status: rec.counts.failed || rec.counts.errors ? 'base-failing' : 'ok', artifacts: stored.artifacts, ...(install ? { install } : {}) };
}

/** A ledger check entry (plan §9.2); command, summary and finding texts are redacted. */
export function makeCheck({ id, fm, project = '.', status, reason = null, cost = 0, command = null, cwd = null, exit_code = null, duration_ms = 0, summary = '', output_sha256 = null, artifacts = [], findings = [], data = {} }) {
  const red = (f) => ({ ...f, message: redactSync(f.message), evidence: f.evidence == null ? f.evidence : redactSync(f.evidence) });
  return { id, fm, project, status, ...(reason ? { reason } : {}), cost, command: command == null ? null : redactSync(command), cwd, exit_code, duration_ms, summary: redactSync(summary), output_sha256, artifacts, findings: findings.map(red), data };
}

// ---------------------------------------------------------------------------
// Red-green proof (§9.4, §10.1 step 4): base + only the new test files must fail by assertion; the snapshot must pass.

/** Parse `--red-green` values: comma-separated `path` or `path::test-name` entries. */
export function parseRedGreenSpec(values) {
  // Commas separate entries (repeat the flag for more); spaces may be part of a path.
  const list = (Array.isArray(values) ? values : [values]).flatMap((v) => String(v || '').split(',')).map((v) => v.trim()).filter(Boolean);
  return list.map((v) => {
    const i = v.indexOf('::');
    return i === -1 ? { file: toPosix(v), name: null } : { file: toPosix(v.slice(0, i)), name: v.slice(i + 2) };
  });
}

async function redGreenProof({ target, projects, files, runnerOpt, noInstall, keep, timeoutMs, dryRun }) {
  const root = target.root;
  const tree = target.snapshot.tree;
  const specs = parseRedGreenSpec(files).map((s) => ({ ...s, file: relPosix(root, path.resolve(root, s.file)) || s.file }));
  const res = { status: 'unverified', reason: null, files: specs.map((s) => s.file + (s.name ? `::${s.name}` : '')), pairs: [], base_report: null, head_report: null };
  const fail = (status, reason, summary, extra = {}) => {
    Object.assign(res, { status, reason, summary, ...extra });
    res.check = makeCheck({ id: 'CK-REDGREEN', fm: FM_REDGREEN, project: extra.project || '.', status, reason, summary, command: extra.command || null, cwd: extra.cwd || null, exit_code: extra.exit_code ?? null, duration_ms: extra.duration_ms || 0, output_sha256: extra.output_sha256 || null, artifacts: extra.artifacts || [], findings: extra.findings || [], data: { files: res.files, pairs: res.pairs, base_report: res.base_report, head_report: res.head_report, base_counts: extra.base_counts || null, head_counts: extra.head_counts || null } });
    return res;
  };
  const missing = specs.filter((s) => showFile(root, target.snapshot.commit, s.file) == null);
  if (missing.length) return fail('unverified', 'TEST_FILE_NOT_IN_SNAPSHOT', `not in the snapshot: ${missing.map((s) => s.file).join(', ')}`);
  if (!target.base.sha) return fail('unverified', 'NO_BASE', 'no base commit (unborn repository); the red half cannot run');
  const owners = [...new Set(specs.map((s) => projectOf(s.file, projects)).filter(Boolean))];
  if (owners.length !== 1) return fail('unverified', owners.length ? 'MULTIPLE_PROJECTS' : 'NO_RUNNER', owners.length ? 'red-green files span several projects; run once per project' : 'no detected project owns the red-green files');
  const project = owners[0];
  const prel = toPosix(project.root || '.');
  const runner = resolveRunner(project, runnerOpt);
  if (!runner) return fail('unverified', 'NO_RUNNER', `no test runner detected for ${prel}`, { project: prel });
  const relToProject = (f) => (prel === '.' ? f : f.slice(prel.length + 1));
  const select = { files: specs.map((s) => relToProject(s.file)), names: specs.map((s) => s.name).filter(Boolean) };
  if (dryRun) return fail('skipped', 'DRY_RUN', `dry run: would copy ${res.files.join(', ')} into a base worktree and run them there and in the snapshot`, { project: prel });
  const slug = projectSlug(prel);
  const outRoot = path.join(tmpRoot(root), `rg-${tree.slice(0, 12)}-${nonce().slice(0, 6)}`);

  // Red: the base with only the new test files copied in (a separate worktree: it becomes dirty).
  const baseWt = acquireWorktree(root, target.base.sha, 'base', { keep });
  baseWt.dirty = true;
  for (const s of specs) {
    const content = showFile(root, target.snapshot.commit, s.file);
    const dest = path.join(baseWt.dir, s.file);
    ensureDir(path.dirname(dest));
    fs.writeFileSync(dest, content);
  }
  const red = await runProject(baseWt, project, runner, { outDir: path.join(outRoot, 'red'), noInstall, timeoutMs, select });
  const redStored = await storeArtifacts(target, tree, slug, red, { prefix: 'redgreen-base-' });
  // Green: the same selection in a clean snapshot worktree.
  const headWt = acquireWorktree(root, target.snapshot.commit, 'head', { keep });
  const green = await runProject(headWt, project, runner, { outDir: path.join(outRoot, 'green'), noInstall, timeoutMs, select });
  const greenStored = await storeArtifacts(target, tree, slug, green, { prefix: 'redgreen-head-' });
  if (!keep) fs.rmSync(outRoot, { recursive: true, force: true });
  res.base_report = redStored.report_path;
  res.head_report = greenStored.report_path;
  const common = {
    project: prel, command: red.cmd, cwd: toPosix(red.dir), exit_code: red.exit, duration_ms: (red.ms || 0) + (green.ms || 0),
    output_sha256: redStored.output_sha256, artifacts: [...redStored.artifacts, ...greenStored.artifacts], base_counts: red.counts, head_counts: green.counts,
  };
  if (!red.counts || !green.counts || red.status === 'unverified' || green.status === 'unverified') {
    return fail('unverified', red.status === 'unverified' ? red.reason : green.status === 'unverified' ? green.reason : 'NO_REPORT', `the ${!red.counts ? 'base' : 'snapshot'} run produced no parseable result`, common);
  }
  if (!red.tests.length || !green.tests.length) {
    return fail('unverified', 'NO_TEST_IDS', 'the runner output has no per-test results (summary lines only); red-green needs a report with test ids', common);
  }
  const goModule = goModuleOf(projectDir(headWt, project));
  // Tests of the named files; when ids carry no file (cargo, TRX), the run was restricted to them anyway.
  const scoped = Boolean(red.applied && red.applied.select);
  const mine = (tests) => {
    const hit = tests.filter((t) => specs.some((s) => testMatchesFile(t, s.file, { goModule, projectRoot: prel }) && (!s.name || String(t.id).includes(s.name))));
    return hit.length || !scoped ? hit : tests.filter((t) => specs.every((s) => !s.name) || specs.some((s) => s.name && String(t.id).includes(s.name)));
  };
  const redTests = mine(red.tests);
  const greenTests = mine(green.tests);
  const greenById = new Map(greenTests.map((t) => [t.id, t]));
  for (const t of redTests) {
    const g = greenById.get(t.id);
    res.pairs.push({ id: t.id, base: { status: t.status, failure_kind: t.failure_kind || null, message: t.message || null }, head: g ? { status: g.status, failure_kind: g.failure_kind || null, message: g.message || null } : { status: 'missing' } });
  }
  for (const g of greenTests) if (!redTests.some((t) => t.id === g.id)) res.pairs.push({ id: g.id, base: { status: 'missing' }, head: { status: g.status } });
  const redExecuted = redTests.filter((t) => t.status !== 'skipped');
  if (!redExecuted.length) {
    const loadErr = red.tests.find((t) => t.failure_kind === 'error');
    return fail('fail', loadErr ? 'NOT_EXECUTED_LOAD_ERROR' : 'NOT_EXECUTED', loadErr ? `the new test did not execute on the base: ${loadErr.message || loadErr.id}` : 'the named test is not in the base report (executed 0)', { ...common, findings: loadErr ? [{ id: 'CK-REDGREEN', severity: 'fail', file: specs[0].file, line: null, message: 'collection, import or compile error instead of an assertion failure', evidence: truncate(loadErr.message || loadErr.id, 200) }] : [] });
  }
  const proven = res.pairs.filter((p) => p.base.status === 'failed' && p.base.failure_kind === 'assertion' && (p.head.status === 'passed'));
  const wrongKind = res.pairs.filter((p) => (p.base.status === 'failed' || p.base.status === 'error') && p.base.failure_kind !== 'assertion');
  // Not green: anything failing in the snapshot, and every assertion red that does not pass there.
  // A file-level load error on the base has no counterpart id in the snapshot; that is a wrong
  // failure kind (below), not a missing green.
  const isRed = (p) => p.base.status === 'failed' && p.base.failure_kind === 'assertion';
  const notGreen = res.pairs.filter((p) => ['failed', 'error', 'flaky'].includes(p.head.status) || (isRed(p) && p.head.status !== 'passed'));
  const findings = [
    ...wrongKind.map((p) => ({ id: 'CK-REDGREEN', severity: 'fail', file: specs[0].file, line: null, message: `fails on the base with an error, not an assertion: ${p.id}`, evidence: truncate(p.base.message || '', 200) })),
    ...notGreen.map((p) => ({ id: 'CK-REDGREEN', severity: 'fail', file: specs[0].file, line: null, message: `does not pass in the snapshot: ${p.id} (${p.head.status})`, evidence: truncate(p.head.message || '', 200) })),
  ];
  const namedMissing = specs.filter((s) => s.name && !res.pairs.some((p) => String(p.id).includes(s.name)));
  if (namedMissing.length) return fail('fail', 'NOT_EXECUTED', `named test not found in the base report: ${namedMissing.map((s) => s.name).join(', ')}`, { ...common, findings });
  if (notGreen.length) return fail('fail', 'NOT_GREEN', `${notGreen.length} test(s) do not pass in the snapshot`, { ...common, findings });
  if (!proven.length) {
    if (wrongKind.length) return fail('fail', 'WRONG_FAILURE_KIND', `the base run fails with an error (${wrongKind[0].base.message || 'error'}), not an assertion failure`, { ...common, findings });
    return fail('fail', 'NOT_RED', 'the new test passes on the base: it does not reproduce the bug', { ...common, findings });
  }
  return fail('pass', null, `red-green proven for ${proven.length} test(s): assertion failure on the base ${target.base.sha.slice(0, 12)} with only the test file(s) copied in, pass in the snapshot ${tree.slice(0, 12)}`, { ...common, findings });
}

// ---------------------------------------------------------------------------
// typecheck: new errors vs the base (by file + code + message, ignoring line numbers)

const TYPE_ERROR_PATTERNS = [
  // tsc: src/a.ts(12,5): error TS2322: ...   and pretty: src/a.ts:12:5 - error TS2322: ...
  { re: /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.+)$/, map: (m) => ({ file: m[1], line: +m[2], code: m[4], message: m[5] }) },
  { re: /^(.+?):(\d+):(\d+) - error (TS\d+): (.+)$/, map: (m) => ({ file: m[1], line: +m[2], code: m[4], message: m[5] }) },
  { re: /^error (TS\d+): (.+)$/, map: (m) => ({ file: null, line: null, code: m[1], message: m[2] }) },
  // dotnet build / msbuild: path(12,5): error CS0103: ... [proj]
  { re: /^(.+?)\((\d+),(\d+)\): error ([A-Z]+\d+): (.+?)(?: \[[^\]]+\])?$/, map: (m) => ({ file: m[1], line: +m[2], code: m[4], message: m[5] }) },
  // pyright: /abs/a.py:12:5 - error: message (rule)
  { re: /^\s*(.+?\.pyi?):(\d+):(\d+) - error: (.+?)(?: \((report\w+)\))?$/, map: (m) => ({ file: m[1], line: +m[2], code: m[5] || null, message: m[4] }) },
  // mypy: a.py:12: error: message  [code]   (optionally with a column)
  { re: /^(.+?\.pyi?):(\d+):(?:(\d+):)? error: (.+?)(?:\s+\[([\w-]+)\])?$/, map: (m) => ({ file: m[1], line: +m[2], code: m[5] || null, message: m[4] }) },
  // cargo --message-format=short: src/a.rs:3:5: error[E0425]: message
  { re: /^(.+?\.rs):(\d+):(\d+): error(?:\[(E\d+)\])?: (.+)$/, map: (m) => ({ file: m[1], line: +m[2], code: m[4] || null, message: m[5] }) },
  // javac via maven / gradle
  { re: /^\[ERROR\] (.+?\.(?:java|kt)):\[(\d+),(\d+)\] (.+)$/, map: (m) => ({ file: m[1], line: +m[2], code: null, message: m[4] }) },
  { re: /^(.+?\.(?:java|kt)):(\d+): error: (.+)$/, map: (m) => ({ file: m[1], line: +m[2], code: null, message: m[3] }) },
  // go vet / go build (vet: prefix optional)
  { re: /^(?:vet: )?(\.{0,2}\/?[^\s:]+\.go):(\d+):(?:(\d+):)? (.+)$/, map: (m) => ({ file: m[1], line: +m[2], code: null, message: m[4] }) },
];

/** Errors from a type checker's output: `[{ file, line, code, message }]` (paths relative to `roots`). */
export function parseTypeErrors(output, { roots = [] } = {}) {
  const errors = [];
  const seen = new Set();
  const variants = rootVariants(roots);
  const rel = (f) => {
    if (!f) return null;
    let s = toPosix(f.trim());
    for (const r of variants) if (s.startsWith(r + '/')) { s = s.slice(r.length + 1); break; }
    return s.replace(/^\.\//, '');
  };
  for (const raw of String(output || '').replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line || /\bwarning\b[:[]/.test(line.split(':').slice(0, 4).join(':')) && !/\berror\b/.test(line)) continue;
    for (const p of TYPE_ERROR_PATTERNS) {
      const m = p.re.exec(line);
      if (!m) continue;
      const e = p.map(m);
      if (/^(?:warning|note|info)\b/i.test(e.message)) break;
      e.file = rel(e.file);
      e.message = e.message.trim();
      const k = `${e.file}\0${e.line}\0${e.code}\0${e.message}`;
      if (!seen.has(k)) { seen.add(k); errors.push(e); }
      break;
    }
  }
  return errors;
}

const errorKey = (e) => `${e.file || ''}\0${e.code || ''}\0${String(e.message).replace(/\s+/g, ' ').replace(/\(\d+,\d+\)|:\d+:\d+/g, '')}`;

/** Head errors that are not in the base (multiset by file + code + message, line numbers ignored). */
export function newErrors(baseErrors, headErrors) {
  const counts = new Map();
  for (const e of baseErrors) counts.set(errorKey(e), (counts.get(errorKey(e)) || 0) + 1);
  const out = [];
  for (const e of headErrors) {
    const k = errorKey(e);
    const n = counts.get(k) || 0;
    if (n > 0) counts.set(k, n - 1);
    else out.push(e);
  }
  return out;
}

function checkersFor(det, runnerOpt, checkerCmd) {
  const list = [];
  for (const p of det.projects || []) for (const t of p.typecheck || []) if (t && t.cmd) list.push({ ...t, project: p });
  for (const t of det.typecheck || []) {
    if (!t || !t.cmd) continue;
    const proot = toPosix(t.root || t.project || '.');
    const p = (det.projects || []).find((x) => toPosix(x.root || '.') === proot) || { root: proot, managers: [] };
    if (!list.some((x) => x.cmd === t.cmd && toPosix(x.project.root || '.') === proot)) list.push({ ...t, project: p });
  }
  if (checkerCmd) return [{ name: 'custom', cmd: checkerCmd.trim(), project: (det.projects || [])[0] || { root: '.', managers: [] } }];
  // `runner` selects a checker by name; anything else (e.g. a test runner name verify passes along) is ignored.
  if (runnerOpt) {
    const hit = list.filter((c) => c.name === runnerOpt);
    if (hit.length) return hit;
  }
  return list;
}

function checkerCommand(c) {
  let cmd = c.cmd;
  if (/\btsc\b/.test(cmd) && !/--pretty/.test(cmd)) cmd += ' --pretty false';
  if (/^\s*cargo\s+(?:check|build|clippy)\b/.test(cmd) && !/--message-format/.test(cmd)) cmd += ' --message-format=short';
  return cmd;
}

/**
 * Type check in base and snapshot worktrees (§9.1 step 10). Returns
 * `{ cmd, base: { exit, errors }, head: { exit, errors }, new_errors[], status, checks[] }`.
 */
export async function typecheck({ target, detectResult = null, strict = false, runner = null, checkerCmd = null, noInstall = false, keep = false, timeoutS = DEFAULT_TIMEOUT_S, dryRun = false } = {}) {
  const root = target.root;
  const tree = target.snapshot.tree;
  await loadMarkers();
  const det = detectResult || await loadDetect(root, target.state);
  const checkers = checkersFor(det, runner, checkerCmd);
  const timeoutMs = Math.max(1, Number(timeoutS) || DEFAULT_TIMEOUT_S) * 1000;
  const out = { cmd: null, base: null, head: null, new_errors: [], status: 'skipped', checkers: [], checks: [] };
  if (!checkers.length) {
    out.checks.push(makeCheck({ id: 'CK-TYPES', fm: FM_TYPES, status: 'skipped', reason: 'NO_CHECKER', summary: 'no compile or type checker detected' }));
    return out;
  }
  for (const c of checkers) {
    const prel = toPosix(c.project.root || '.');
    const slug = projectSlug(prel);
    const cmd = checkerCommand(c);
    if (dryRun) {
      out.checkers.push({ name: c.name, project: prel, cmd, status: 'skipped' });
      out.checks.push(makeCheck({ id: 'CK-TYPES', fm: FM_TYPES, project: prel, status: 'skipped', reason: 'DRY_RUN', command: cmd, summary: `dry run: would run \`${cmd}\` in base and snapshot worktrees` }));
      continue;
    }
    const outRoot = path.join(tmpRoot(root), `tc-${tree.slice(0, 12)}-${nonce().slice(0, 6)}`);
    const runIn = async (wt, label) => {
      const dir = projectDir(wt, c.project);
      ensureDir(path.join(outRoot, label));
      const logFile = path.join(outRoot, label, 'run.log');
      fs.writeFileSync(logFile, '');
      if (!fs.existsSync(dir)) return { exit: null, ms: 0, errors: [], absent: true, log_path: logFile };
      const install = await installProject(wt, c.project, { noInstall, timeoutMs, logFile });
      if (install.cmd && install.exit !== 0) return { exit: null, ms: install.ms, errors: [], install, failed: 'INSTALL_FAILED', log_path: logFile };
      fs.appendFileSync(logFile, `$ ${cmd}\n`);
      const res = await runStep(cmd, { cwd: dir, env: runEnv().env, timeoutMs, logFile });
      let errors = parseTypeErrors(`${res.stdout}\n${res.stderr}`, { roots: [dir, wt.dir] });
      const missing = res.exit !== 0 && !errors.length && runnerMissing(`${res.stderr}\n${res.stdout}`.slice(-20_000));
      if (res.exit !== 0 && !errors.length && !res.timedOut && !missing) {
        const first = `${res.stderr}\n${res.stdout}`.split(/\r?\n/).map((l) => l.trim()).find(Boolean) || `exit ${res.exit}`;
        errors = [{ file: null, line: null, code: `exit-${res.exit}`, message: truncate(first, 300) }];
      }
      return { exit: res.exit, ms: res.ms, errors, install, timedOut: res.timedOut, error: res.error, missing, log_path: logFile };
    };
    const head = await runIn(acquireWorktree(root, target.snapshot.commit, 'typecheck', { keep }), 'head');
    const base = target.base.sha ? await runIn(acquireWorktree(root, target.base.sha, 'base', { keep }), 'base') : { exit: null, errors: [], absent: true };
    const storedHead = await storeArtifacts(target, tree, slug, { log_path: head.log_path }, { prefix: `typecheck-${c.name}-` });
    const storedBase = base.log_path ? await storeArtifacts(target, tree, slug, { log_path: base.log_path }, { prefix: `typecheck-${c.name}-base-` }) : { artifacts: [] };
    if (!keep) fs.rmSync(outRoot, { recursive: true, force: true });
    const fresh = newErrors(base.errors || [], head.errors);
    // A base check that could not run (failed install, missing checker, timeout, or an unparseable
    // crash the snapshot does not repeat) is no baseline: comparing against it would report every
    // pre-existing error as new.
    const synthetic = (e) => /^exit-/.test(String(e.code || ''));
    const baseProblem = base.absent ? null
      : base.failed || (base.timedOut && 'TIMEOUT') || ((base.missing || base.error === 'ENOENT' || base.exit === 127 || (IS_WINDOWS && base.exit === 9009)) && 'CHECKER_NOT_FOUND')
        || (base.error && 'SPAWN_FAILED')
        || (base.errors.length && base.errors.every(synthetic) && fresh.length && 'UNPARSEABLE_FAILURE') || null;
    let status;
    let reason = null;
    if (head.timedOut) { status = 'unverified'; reason = 'TIMEOUT'; }
    else if (head.failed) { status = 'unverified'; reason = head.failed; }
    else if (head.missing || head.error === 'ENOENT' || head.exit === 127 || (IS_WINDOWS && head.exit === 9009)) { status = 'unverified'; reason = 'CHECKER_NOT_FOUND'; }
    else if (strict && head.errors.length) { status = 'fail'; reason = 'STRICT_ERRORS'; }
    else if (!head.errors.length) status = 'pass';
    else if (baseProblem) { status = 'unverified'; reason = 'BASE_UNAVAILABLE'; }
    else if (fresh.length) { status = 'fail'; reason = 'NEW_ERRORS'; }
    else { status = 'pass-with-baseline'; reason = 'PRE_EXISTING_ERRORS'; }
    const notLinked = base.install && Array.isArray(base.install.not_linked) && base.install.not_linked[0];
    const hint = baseProblem === 'INSTALL_FAILED' ? '; without network access re-run with --no-install'
      : notLinked ? `; --no-install could not link ${notLinked.path} into the base: ${notLinked.reason}` : '';
    const baseText = base.absent ? 'no base' : baseProblem ? `the base check did not run (${baseProblem}${hint})` : `${base.errors.length} in the base`;
    const summary = `${c.name}: ${head.errors.length} error(s) in the snapshot, ${baseText}, ${reason === 'BASE_UNAVAILABLE' ? 'new errors unknown' : `${fresh.length} new`}${strict ? ' (strict)' : ''}`;
    const known = reason === 'BASE_UNAVAILABLE' ? [] : fresh;
    const rec = { name: c.name, project: prel, cmd, base: { exit: base.exit ?? null, errors: (base.errors || []).length, ...(baseProblem ? { problem: baseProblem } : {}) }, head: { exit: head.exit, errors: head.errors.length }, new_errors: known, status, reason };
    out.checkers.push(rec);
    out.checks.push(makeCheck({
      id: 'CK-TYPES', fm: FM_TYPES, project: prel, status, reason, command: cmd, cwd: null, exit_code: head.exit, duration_ms: (head.ms || 0) + (base.ms || 0), summary,
      output_sha256: storedHead.output_sha256, artifacts: [...storedHead.artifacts, ...storedBase.artifacts],
      findings: (strict ? head.errors : known).slice(0, 100).map((e) => ({ id: 'CK-TYPES', severity: 'fail', file: e.file ? (prel === '.' ? e.file : `${prel}/${e.file}`) : null, line: e.line, message: `${e.code ? `${e.code}: ` : ''}${e.message}`, evidence: truncate(e.message, 200) })),
      data: { checker: c.name, base: rec.base, head: rec.head, new_errors: reason === 'BASE_UNAVAILABLE' ? null : fresh.length, strict: Boolean(strict) },
    }));
  }
  const primary = out.checkers[0] || {};
  out.cmd = primary.cmd || null;
  out.base = primary.base || null;
  out.head = primary.head || null;
  out.new_errors = out.checkers.flatMap((c) => c.new_errors || []);
  out.status = worstStatus(out.checks.map((c) => c.status));
  if (!keep) releaseWorktrees({ root });
  return out;
}

// ---------------------------------------------------------------------------
// Commands

const COMMON = {
  base: { type: 'string' }, runner: { type: 'string' }, 'no-install': { type: 'boolean' }, keep: { type: 'boolean' },
  timeout: { type: 'string' }, refresh: { type: 'boolean' },
};

/**
 * `--red-green` / `--tests` entries (`path` or `path::name`, comma-separated) as repo-relative paths:
 * a path that exists relative to `--cwd` is taken from there, anything else is repo-relative.
 */
export function repoRelativeEntries(values, cwd, root) {
  if (!values) return null;
  return (Array.isArray(values) ? values : [values]).flatMap((v) => String(v || '').split(',')).map((v) => v.trim()).filter(Boolean).map((v) => {
    const i = v.indexOf('::');
    const file = i === -1 ? v : v.slice(0, i);
    const fromCwd = path.resolve(cwd, file);
    const rel = cwd !== root && fs.existsSync(fromCwd) ? relPosix(root, fromCwd) : null;
    return rel && rel !== '.' ? rel + (i === -1 ? '' : v.slice(i)) : toPosix(v);
  });
}

/** A positive number option (`--timeout 600`), the default when absent; a usage error (exit 2) otherwise. */
export function numberOption(values, name, def, { integer = false } = {}) {
  const raw = values[name];
  if (raw == null || raw === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || (integer && !Number.isInteger(n))) throw usageError(`--${name} must be a positive ${integer ? 'integer' : 'number'} (got "${raw}")`);
  return n;
}

export const cleanRunCommand = defineCommand({
  name: 'clean-run',
  usage: [
    'clean-run [--base <ref>] [--no-install] [--runner <name|"command">] [--all-projects]',
    '          [--base-counts <file>] [--no-base] [--keep] [--red-green <test files>] [--timeout <s>] [--json]',
    'Runs the full suite of every project that owns a changed file on the working-tree snapshot,',
    'in a temp worktree, frozen install, retries off; compares counts with the base (CK-CLEANRUN).',
    '--red-green f1,f2[::name]: the new tests must fail by assertion on the base and pass in the snapshot (CK-REDGREEN).',
  ].join('\n'),
  options: { ...COMMON, 'all-projects': { type: 'boolean' }, 'base-counts': { type: 'string' }, 'no-base': { type: 'boolean' }, 'red-green': { type: 'string', multiple: true } },
  async run(ctx, values) {
    const timeoutS = numberOption(values, 'timeout', DEFAULT_TIMEOUT_S);
    const target = await prepareTarget(ctx, { base: values.base || null, createState: !ctx.dryRun });
    const detectResult = await loadDetect(target.root, ctx.dryRun ? null : target.state, { refresh: Boolean(values.refresh) });
    const res = await cleanRun({
      target, detectResult, noInstall: Boolean(values['no-install']), runner: values.runner || null, allProjects: Boolean(values['all-projects']),
      baseCountsFile: values['base-counts'] ? path.resolve(ctx.cwd, values['base-counts']) : null, noBase: Boolean(values['no-base']), keep: Boolean(values.keep),
      redGreen: repoRelativeEntries(values['red-green'], ctx.cwd, target.root), timeoutS, dryRun: ctx.dryRun,
    });
    const summary = res.projects.length
      ? res.projects.map((p) => `${p.root}: ${p.status}${p.reason ? ` (${p.reason})` : ''}`).join('; ') + (res.red_green ? `; red-green: ${res.red_green.status}` : '')
      : (res.checks[0] && res.checks[0].summary) || res.status;
    return { result: redactDeep(res), exit: exitFor(res.status, res.checks), summary: redactSync(`${res.status.toUpperCase()} - ${summary}`) };
  },
});

export const typecheckCommand = defineCommand({
  name: 'typecheck',
  usage: [
    'typecheck [--base <ref>] [--strict] [--runner <checker|"command">] [--no-install] [--keep] [--timeout <s>] [--json]',
    'Runs the detected compile/type check in base and snapshot worktrees and reports new errors only (CK-TYPES).',
  ].join('\n'),
  options: { ...COMMON, strict: { type: 'boolean' } },
  async run(ctx, values) {
    const timeoutS = numberOption(values, 'timeout', DEFAULT_TIMEOUT_S);
    const target = await prepareTarget(ctx, { base: values.base || null, createState: !ctx.dryRun });
    const detectResult = await loadDetect(target.root, ctx.dryRun ? null : target.state, { refresh: Boolean(values.refresh) });
    const opt = values.runner ? String(values.runner).trim() : null;
    const isCmd = Boolean(opt && /\s/.test(opt));
    if (opt && !isCmd) {
      const names = checkersFor(detectResult, null, null).map((c) => c.name);
      if (!names.includes(opt)) throw usageError(`--runner "${opt}" is not a detected type checker (${names.join(', ') || 'none'}); pass a command line instead`);
    }
    const res = await typecheck({ target, detectResult, strict: Boolean(values.strict), runner: isCmd ? null : opt, checkerCmd: isCmd ? opt : null, noInstall: Boolean(values['no-install']), keep: Boolean(values.keep), timeoutS, dryRun: ctx.dryRun });
    const summary = res.checks.map((c) => c.summary).join('; ');
    return { result: redactDeep(res), exit: exitFor(res.status === 'pass-with-baseline' ? 'pass' : res.status, res.checks), summary: redactSync(`${res.status.toUpperCase()} - ${summary}`) };
  },
});
