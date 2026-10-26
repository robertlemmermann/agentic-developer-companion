// Independent clean run of the working-tree snapshot (§7.4, §7.5, §9.1 steps 10-11, §9.1.1): temp
// worktrees in the OS temp dir, frozen install, the full suite of every affected project (one runner
// per ecosystem) with retries off, report parsing, counts vs the base, the red-green proof (§9.4) and
// the new-errors-only type check. probes.mjs reuses the runner plumbing.

import fs from 'node:fs';
import path from 'node:path';
import {
  EXIT, usageError, defineCommand, readJson, readText, writeFileAtomic, writeJsonAtomic, ensureDir, sha256,
  nonce, nowIso, toPosix, relPosix, quoteArg, tmpRoot, which, IS_WINDOWS, run, truncate, stamp, log,
  numberOption, spawnCapture, onInterrupt, firstLine, toArray, uniq, makeCheck as checkWithDefaults,
} from './core.mjs';
import { worktreeAdd, worktreeRemove, diffNameStatus, emptyTree, showFile, gitTry } from './git.mjs';
import { prepareTarget } from './state.mjs';
import { parseReport, parseSummaryText, normalizeFormat, rootVariants } from './reports.mjs';
import { detect, RUNNERS } from './detect.mjs';
import * as M from './markers.mjs';

const FM = { 'CK-CLEANRUN': ['FM-02', 'FM-13'], 'CK-REDGREEN': ['FM-03'], 'CK-TYPES': ['FM-04'] };
export const DEFAULT_TIMEOUT_S = 1800;
const [LOG_HEAD, LOG_TAIL] = [2 * 1024 * 1024, 8 * 1024 * 1024];
const MAX_CACHED_IDS = 50_000;
const COUNT_KEYS = ['executed', 'passed', 'failed', 'errors', 'skipped', 'flaky'];

// ---------------------------------------------------------------------------
// Runners: detect's catalog (command, report, retries off) plus what the clean run adds: file and
// test-name selection, seeded shuffle and coverage. Placeholders: <f> report file, <d> report dir,
// <c> coverage file, <cdir> coverage dir, <target> cargo target dir.

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const rx = (names) => names.map(esc).join('|');
const by = (flag) => (names) => [flag, rx(names)];
const cov = (flag, format, file, more) => ({ flag, format, file, ...more });

const EXTRAS = {
  'node-test': {
    select: 'files', names: (l) => [`--test-name-pattern=${rx(l)}`],
    shuffle: (s) => ['--test-randomize', `--test-random-seed=${s}`],
    consoleFlag: '--test-reporter=spec --test-reporter-destination=stdout',
    coverage: cov('--experimental-test-coverage --test-reporter=lcov --test-reporter-destination=<c>', 'lcov', 'lcov.info'),
  },
  jest: {
    select: 'files', names: by('-t'), shuffle: (s) => ['--randomize', `--seed=${s}`],
    coverage: cov('--coverage --coverageReporters=json --coverageDirectory=<cdir>', 'istanbul', 'coverage-final.json'),
  },
  vitest: {
    select: 'files', names: by('-t'), shuffle: (s) => ['--sequence.shuffle', `--sequence.seed=${s}`],
    coverage: cov('--coverage.enabled --coverage.reporter=json --coverage.reportsDirectory=<cdir> --coverage.reportOnFailure',
      'istanbul', 'coverage-final.json', { requires: ['@vitest/coverage-v8', '@vitest/coverage-istanbul'] }),
  },
  playwright: { select: 'files', names: by('-g') },
  mocha: { select: 'files', names: by('-g') },
  bun: { select: 'files', names: by('-t') },
  pytest: {
    select: 'pytest', shuffle: (s) => [`--randomly-seed=${s}`], shuffleRequires: ['pytest-randomly', 'pytest_randomly'],
    coverage: cov('--cov --cov-report=xml:<c>', 'cobertura', 'coverage.xml', { requires: ['pytest-cov', 'pytest_cov'] }),
  },
  go: { select: 'go', shuffle: (s) => [`-shuffle=${s}`], coverage: cov('-coverprofile=<c>', 'go-cover', 'cover.out') },
  cargo: {
    select: 'cargo', ensure: '--no-fail-fast',
    coverage: { cmd: 'cargo llvm-cov --no-fail-fast --lcov --output-path <c>', format: 'lcov', file: 'lcov.info',
      tool: 'cargo-llvm-cov' },
  },
  nextest: { select: 'cargo', ensure: '--no-fail-fast' },
  dotnet: {
    select: 'classes', classArgs: (c) => ['--filter', c.map((x) => `FullyQualifiedName~${x}`).join('|')],
    coverage: cov('--collect:"XPlat Code Coverage;Format=cobertura" --results-directory <cdir>', 'cobertura',
      'coverage.cobertura.xml', { search: true }),
  },
  maven: { select: 'classes', classArgs: (c) => [`-Dtest=${c.join(',')}`, '-Dsurefire.failIfNoSpecifiedTests=false'] },
  gradle: { select: 'classes', classArgs: (c) => c.flatMap((x) => ['--tests', x]) },
  rspec: { select: 'files', names: (l) => l.flatMap((x) => ['-e', x]), shuffle: (s) => ['--order', `rand:${s}`] },
};

const RUNNER_ALIASES = { 'node:test': 'node-test', node: 'node-test', 'cargo-test': 'cargo', 'cargo-nextest': 'nextest',
  'go-test': 'go', 'dotnet-test': 'dotnet', surefire: 'maven' };
const canon = (n) => RUNNER_ALIASES[String(n || '').toLowerCase()] || String(n || '').toLowerCase();
const catalog = (n) => RUNNERS[canon(n)] || {};
const LANG_ECOSYSTEM = { js: 'node', py: 'python', go: 'go', rs: 'rust', cs: 'dotnet', jvm: 'jvm', rb: 'ruby' };

/** Ecosystem of a file by its language ('node', 'python', ...), or null. */
export const fileEcosystem = (file) => LANG_ECOSYSTEM[M.langOf(file)] || null;

/** `pytest` when it is on PATH, else `python -m pytest` (`python3` where `python` is absent). */
const defaultPytest = () => (which('pytest') ? 'pytest'
  : `${!IS_WINDOWS && !which('python') && which('python3') ? 'python3' : 'python'} -m pytest`);

/** A runner completed from the catalog; the detected fields win, except a report without a target. */
function complete(r) {
  const name = canon(r.name);
  const def = { ...RUNNERS[name], ...EXTRAS[name] };
  const rep = r.report || {};
  const target = /<[fd]>/.test(rep.flag || '') || Object.values(rep.env || {}).some((v) => /<f>/.test(v))
    || rep.path || rep.dir || rep.stdout;
  const report = target && rep.format ? { ...rep } : def.report ? { ...def.report } : rep.format ? { ...rep } : null;
  if (report && ['go-test-json', 'cargo-text'].includes(normalizeFormat(report.format))) report.stdout = true;
  const cmd = r.cmd || (name === 'pytest' ? defaultPytest() : def.cmd);
  const retries = r.retries_off || def.retries_off || { mechanism: 'unknown', coverage: 'unknown' };
  return { ...def, ...r, name, cmd, report, retries_off: retries };
}

// A `--runner` command line that plainly invokes a known runner gets that runner's report and
// retries-off flags (appended at the end). Lines with shell operators stay opaque: appended flags
// would reach the last command, not the runner.
const INFER_RUNNER = [
  ['node-test', /^node(?:\.exe)?\s(?:.*\s)?--test(?:\s|$)/], ['playwright', /\bplaywright\s+test\b/],
  ['vitest', /\bvitest\b/], ['jest', /\bjest\b/], ['mocha', /\bmocha\b/],
  ['pytest', /(?:^|[\s/\\])(?:py\.test|pytest)(?:\.exe)?(?:\s|$)/], ['nextest', /\bcargo\s+nextest\s+run\b/],
  ['cargo', /\bcargo\s+test\b/], ['go', /\bgo\s+test\b/], ['dotnet', /\bdotnet\s+test\b/], ['rspec', /\brspec\b/],
  ['maven', /(?:^|[\s/\\])mvnw?(?:\.cmd)?\s(?:.*\s)?test(?:\s|$)/],
  ['gradle', /(?:^|[\s/\\])gradlew?(?:\.bat)?\s(?:.*\s)?test(?:\s|$)/],
];

/** Runner name for a command line such as `uv run pytest` or `go test ./pkg/...`, or null. */
export function inferRunner(line) {
  const s = String(line || '').trim();
  if (!s || /&&|\|\||[;|<>`]|\$\(/.test(s)) return null;
  return (INFER_RUNNER.find(([, re]) => re.test(s)) || [null])[0];
}

function runnerFromOption(detected, opt) {
  const line = String(opt).trim();
  if (/\s/.test(line)) {
    const same = detected.find((r) => r.cmd && String(r.cmd).trim() === line);
    if (same) return { ...complete(same), source: same.source || 'detect' };
    const kind = inferRunner(line);
    if (kind) return { ...complete({ name: kind, cmd: line }), source: '--runner', inferred: true };
    return { name: 'custom', cmd: line, report: null, select: 'none', source: '--runner',
      retries_off: { mechanism: 'custom command (not modified)', coverage: 'unknown' } };
  }
  const hit = detected.find((r) => canon(r.name) === canon(line));
  if (hit) return { ...complete(hit), source: hit.source || 'detect' };
  if (catalog(line).cmd) return { ...complete({ name: line }), source: '--runner' };
  const names = detected.map((r) => r.name).join(', ') || 'none';
  throw usageError(`--runner "${opt}" is neither a detected runner (${names}), a known runner `
    + `(${Object.keys(RUNNERS).join(', ')}) nor a command line`);
}

/**
 * The runners for `project`: the `--runner` one, else one per ecosystem (package.json plus
 * pyproject.toml runs both suites). Wrappers such as `make test` run only when nothing else is
 * detected; per ecosystem the test script's runner wins, then a unit runner before an e2e one.
 */
export function resolveRunners(project, runnerOpt = null) {
  const detected = toArray(project && project.runners).filter((r) => r && r.name);
  if (runnerOpt) return [runnerFromOption(detected, runnerOpt)];
  const real = detected.filter((r) => r.kind !== 'wrapper');
  const pool = (real.length ? real : detected).filter((r) => r.cmd || catalog(r.name).cmd);
  const script = String((project && project.test_script) || '');
  const inScript = (r) => Boolean(script) && new RegExp(`\\b${canon(r.name).replace('node-test', 'node')}\\b`).test(script);
  const eco = (r) => r.ecosystem || catalog(r.name).ecosystem || '';
  const unit = (r) => (r.kind || catalog(r.name).kind) !== 'e2e';
  const groups = [...new Set(pool.map(eco))].map((e) => pool.filter((r) => eco(r) === e))
    .sort((a, b) => Number(b.some(inScript)) - Number(a.some(inScript)));
  return groups.map((g) => complete(g.find(inScript) || g.find(unit) || g[0]));
}

/** One runner for `project` (see resolveRunners); `ecosystem` picks the runner for that language. */
export function resolveRunner(project, runnerOpt = null, { ecosystem = null } = {}) {
  const list = resolveRunners(project, runnerOpt);
  return list.find((r) => ecosystem && r.ecosystem === ecosystem) || list[0] || null;
}

// ---------------------------------------------------------------------------
// Small helpers

/** Secret shapes and live-credential values removed from command lines, logs and reports. */
export const redact = (text) => M.makeRedactor()(text);
export const redactAll = (value) => M.redactDeep(value, redact);

/** A ledger check (plan §9.2) with the command, summary and finding texts redacted. */
export function makeCheck(fields) {
  const f = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
  const red = (x) => ({ ...x, message: redact(x.message), evidence: x.evidence == null ? x.evidence : redact(x.evidence) });
  return checkWithDefaults({ duration_ms: 0, ...f, command: f.command == null ? null : redact(f.command),
    summary: redact(f.summary || ''), findings: toArray(f.findings).map(red) });
}

/** Filesystem-safe project slug: '.' → 'root', 'packages/a' → 'packages-a'. */
export const projectSlug = (root) => (!root || root === '.' ? 'root'
  : toPosix(root).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'root');

/** Posix path for an artifact: repo-relative when inside the repo, absolute otherwise. */
export function artifactPath(repoRoot, file) {
  const rel = relPosix(repoRoot, file);
  return rel && rel !== '.' ? rel : toPosix(path.resolve(file));
}

/** The project's directory inside worktree `wt`. */
export const projectDir = (wt, project) => (project.root && project.root !== '.' ? path.join(wt.dir, project.root) : wt.dir);
const pickCounts = (c) => Object.fromEntries(COUNT_KEYS.map((k) => [k, c[k] ?? 0]));
const tail = (s, n) => (s && s.length > n ? '...' + s.slice(-n) : s || '');
const inside = (dir, f) => {
  const rel = path.relative(dir, f);
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
};

/** Substitute placeholders; a value inside a double-quoted segment is inserted raw, else shell-quoted. */
export function substitute(template, values) {
  let out = '';
  let quotes = 0;
  for (let i = 0; i < template.length;) {
    const m = /^<(f|d|c|cdir|target)>/.exec(template.slice(i));
    if (m && values[m[1]] != null) {
      const v = IS_WINDOWS ? String(values[m[1]]) : toPosix(values[m[1]]);
      out += quotes % 2 ? v : quoteArg(v);
      i += m[0].length;
    } else {
      if (template[i] === '"') quotes++;
      out += template[i++];
    }
  }
  return out;
}

/** Append arguments to a project command line (npm scripts need `--` before runner flags). */
export function appendArgs(cmd, args) {
  const extra = args.filter((a) => a != null && a !== '').join(' ');
  const dd = cmd.search(/\s--(?:\s|$)/);
  if (!extra) return cmd;
  // npm treats flags after a script name as its own config unless they follow `--`.
  const npmScript = /^\s*npm(?:\.cmd)?\s+(?:(?:run|run-script|rum|urn)\s+\S+|test|tst|t)(?:\s|$)/.test(cmd);
  if (npmScript && dd === -1) return `${cmd} -- ${extra}`;
  if (/^\s*cargo\s+(?:test|nextest\s+run)\b/.test(cmd) && dd !== -1) return `${cmd.slice(0, dd)} ${extra}${cmd.slice(dd)}`;
  return `${cmd} ${extra}`;
}

// ---------------------------------------------------------------------------
// Processes and environment

/** Run a project command line through the platform shell, in its own process group. Never throws. */
export const runStep = (line, { cwd, env, timeoutMs = DEFAULT_TIMEOUT_S * 1000, logFile = null, captureFile = null } = {}) =>
  spawnCapture(line, [], { shell: true, cwd, env, timeoutMs, logFile, captureFile, killGraceMs: 0 });

// Environment that narrows or redirects a test run, or belongs to a live probe: never inherited.
const SCRUB_ENV = new Set(['NODE_TEST_CONTEXT', 'PYTEST_ADDOPTS', 'GOFLAGS', 'VITEST', 'VITEST_MODE', 'VITEST_POOL_ID',
  'VITEST_WORKER_ID', 'JEST_WORKER_ID', 'NEXTEST_RETRIES', 'NEXTEST_PROFILE', 'CARGO_TARGET_DIR']);
const LIVE_ENV = /^ADC_LIVE_|^ADC_(?:TEST_RUN_ID|PROBE_RESULT|PROBE_ID)$/;

/** Environment for project commands: CI semantics, no colors, no narrowing variables, no live credentials. */
export function runEnv(extra = {}) {
  const env = { ...process.env };
  const removed = new Set();
  for (const k of Object.keys(env).filter((x) => LIVE_ENV.test(x) || SCRUB_ENV.has(x))) {
    delete env[k];
    removed.add(LIVE_ENV.test(k) ? 'ADC_LIVE_*' : k);
  }
  // An inherited NODE_OPTIONS=--test-shard=2/2 silently narrows node --test in base and snapshot
  // alike; its other options (CA certificates, memory limits) are kept.
  if (/(?:^|\s)--test-/.test(env.NODE_OPTIONS || '')) {
    const t = env.NODE_OPTIONS.trim().split(/\s+/);
    const kept = t.filter((x, i) => !/^--test-/.test(x) && !(/^--test-[^=]+$/.test(t[i - 1] || '') && !x.startsWith('-')));
    if (kept.length) env.NODE_OPTIONS = kept.join(' ');
    else delete env.NODE_OPTIONS;
    removed.add('NODE_OPTIONS --test-*');
  }
  // npm_config_yes=false: with CI set, `npx <tool>` would otherwise download an unpinned tool when
  // the project does not have it installed, and the clean run would test with the wrong version.
  const set = { CI: 'true', ADC_CLEAN_RUN: '1', NO_COLOR: '1', FORCE_COLOR: '0', PYTHONDONTWRITEBYTECODE: '1',
    npm_config_yes: 'false', npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false',
    ...extra };
  return { env: { ...env, ...set }, removed: [...removed], set: Object.keys(set) };
}

// Output of a shell, npx, a Python launcher or a .NET host that could not find the program to run.
const RUNNER_MISSING_RE = new RegExp([
  String.raw`^(?:[\w./-]+(?: \d+)?: )+(?:command )?not found\s*$`, String.raw`^\w+: command not found: \S+\s*$`,
  'is not recognized as an internal or external command', 'npx canceled due to missing packages',
  'npm (?:ERR!|error) could not determine executable to run', String.raw`No module named (?:pytest|mypy|pyright)\b`,
  '^error: no such command: `', 'Could not execute because the specified command or file was not found',
  String.raw`Could not find or load main class org\.apache\.maven`,
].join('|'), 'm');

/** True when a run's output says the runner itself is missing (not that tests failed). */
export const runnerMissing = (text) => RUNNER_MISSING_RE.test(String(text || ''));
const notFound = (r) => r.missing || r.runnerMissing || r.error === 'ENOENT' || r.exit === 127 || (IS_WINDOWS && r.exit === 9009);

// ---------------------------------------------------------------------------
// Worktree pool: one worktree per (commit, purpose) per process, removed at exit unless kept.

const POOL = new Map();
let hooked = false;

/** Check out `commit` into a temp worktree for `label` ('head', 'base', 'typecheck', 'mutation'), reused per process. */
export function acquireWorktree(root, commit, label, { keep = false } = {}) {
  const key = `${root}\0${commit}\0${label}`;
  const cur = POOL.get(key);
  if (cur && !cur.dirty && fs.existsSync(cur.dir)) {
    cur.keep ||= keep;
    return cur;
  }
  if (cur) releaseEntry(key, cur);
  const dir = path.join(tmpRoot(root), `${label}-${String(commit).slice(0, 12)}-${nonce().slice(0, 6)}`);
  worktreeAdd(root, commit, dir);
  const entry = { root, commit, label, dir, keep, dirty: false, installed: new Map(), links: [] };
  POOL.set(key, entry);
  if (!hooked) {
    hooked = true;
    process.once('exit', () => releaseWorktrees());
    onInterrupt(() => releaseWorktrees());
  }
  return entry;
}

function releaseEntry(key, entry) {
  POOL.delete(key);
  if (entry.keep) return;
  // Remove dependency links first, so no recursive delete can ever reach the user's node_modules.
  for (const link of entry.links) {
    try { fs.unlinkSync(link); } catch { try { fs.rmdirSync(link); } catch {} }
  }
  try { worktreeRemove(entry.root, entry.dir); } catch {}
}

/** Remove every pooled worktree that was not kept (also runs at process exit and on Ctrl-C). */
export function releaseWorktrees({ root = null } = {}) {
  for (const [key, entry] of [...POOL]) if (!root || entry.root === root) releaseEntry(key, entry);
}

// ---------------------------------------------------------------------------
// Install

const NODE_LOCKS = Object.keys(M.LOCKFILE_MANAGERS).filter((f) => ['npm', 'pnpm', 'yarn', 'bun'].includes(M.LOCKFILE_MANAGERS[f]));

/** Do a Node project's dependencies at `commit` equal the working tree's (lockfile, else package.json deps)? */
function sameNodeDeps(root, commit, rel) {
  const at = (f) => showFile(root, commit, rel ? `${rel}/${f}` : f);
  const lf = (s) => s && s.replace(/\r\n/g, '\n');
  for (const lock of NODE_LOCKS) {
    const [work, old] = [readText(path.join(root, rel, lock)), at(lock)];
    if (work != null || old != null) return work != null && old != null && lf(work) === lf(old);
  }
  const deps = (text) => {
    try {
      const j = JSON.parse(text);
      return JSON.stringify([j.dependencies || {}, j.devDependencies || {}, j.optionalDependencies || {}]);
    } catch { return null; }
  };
  const a = deps(readText(path.join(root, rel, 'package.json'), ''));
  return a != null && a === deps(at('package.json') || '');
}

/**
 * --no-install: link the working tree's node_modules into the worktree (junction on Windows) so
 * a Node project can run offline. Snapshot worktrees always match the working tree; a base
 * worktree is linked only when its dependency manifests are identical and the project has no
 * workspace links (those resolve to the working tree's packages, i.e. the snapshot's code).
 */
function linkDependencies(wt, project) {
  const rel = project.root && project.root !== '.' ? project.root : '';
  const [src, dest] = [path.join(wt.root, rel, 'node_modules'), path.join(wt.dir, rel, 'node_modules')];
  if (!fs.existsSync(path.join(wt.dir, rel, 'package.json')) || !fs.existsSync(src) || fs.existsSync(dest)) return {};
  const relPath = toPosix(path.join(rel, 'node_modules'));
  const no = (reason) => ({ not_linked: [{ path: relPath, reason }] });
  const ws = (dir) => Boolean(readJson(path.join(dir, 'package.json'), {})?.workspaces)
    || fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'));
  if (wt.label === 'base' && (ws(path.join(wt.root, rel)) || (rel && ws(wt.root)))) {
    return no('workspace links would resolve to the working tree');
  }
  if (wt.label === 'base' && !sameNodeDeps(wt.root, wt.commit, rel)) return no('dependencies differ between the base and the working tree');
  try {
    fs.symlinkSync(src, dest, IS_WINDOWS ? 'junction' : 'dir');
    wt.links.push(dest);
    return { linked: [relPath] };
  } catch (err) {
    return no(err.code || err.message);
  }
}

/**
 * Frozen install for `project` in worktree `wt`, once per directory and command. With a runner,
 * only a manager of the runner's ecosystem installs (pytest gets `uv sync`, not `npm ci`).
 */
export async function installProject(wt, project, { runner = null, noInstall = false, timeoutMs, logFile } = {}) {
  if (noInstall) {
    const key = `no-install:${projectDir(wt, project)}`;
    if (!wt.installed.has(key)) {
      wt.installed.set(key, { cmd: null, exit: null, ms: 0, skipped: 'no-install', ...linkDependencies(wt, project) });
    }
    return wt.installed.get(key);
  }
  const eco = runner && runner.ecosystem;
  const m = toArray(project.managers).find((x) => x && x.install && (!eco || !x.ecosystem || x.ecosystem === eco));
  if (!m) return { cmd: null, exit: null, ms: 0, skipped: 'no frozen install command detected' };
  let dir = m.cwd ? path.join(wt.dir, m.cwd) : projectDir(wt, project);
  // Workspace installs run where the lockfile is (pnpm/yarn/npm workspaces, cargo workspaces).
  const up = !m.cwd && m.lockfile && !fs.existsSync(path.join(dir, m.lockfile));
  for (let d = dir; up && d !== wt.dir && d.startsWith(wt.dir);) {
    d = path.dirname(d);
    if (fs.existsSync(path.join(d, m.lockfile))) { dir = d; break; }
  }
  const key = `${dir}\0${m.install}`;
  if (wt.installed.has(key)) return { ...wt.installed.get(key), reused: true };
  log(`install: ${m.install} (in ${toPosix(dir)})`);
  if (logFile) fs.appendFileSync(logFile, `$ ${m.install}\n`);
  const res = await runStep(m.install, { cwd: dir, env: runEnv().env, timeoutMs, logFile });
  wt.installed.set(key, { cmd: m.install, exit: res.exit, ms: res.ms, timedOut: res.timedOut, ...(res.error && { error: res.error }) });
  return wt.installed.get(key);
}

// ---------------------------------------------------------------------------
// Command lines

const REPORT_EXT = { junit: 'xml', trx: 'trx', 'jest-json': 'json', 'rspec-json': 'json', 'go-test-json': 'jsonl', 'cargo-text': 'txt' };
const NEXTEST_TOML = '[profile.adc-ci]\nfail-fast = false\nretries = 0\n\n[profile.adc-ci.junit]\npath = "junit.xml"\n';
// node options that take their value as the next argument (`--import tsx`, `--test-concurrency 1`).
const NODE_VALUE_OPTS = new Set(['--import', '--require', '-r', '--loader', '--experimental-loader', '--conditions', '-C',
  '--env-file', '--env-file-if-exists', '--input-type', '--title', '--disable-warning', '--watch-path',
  '--experimental-config-file', '--test-concurrency', '--test-name-pattern', '--test-skip-pattern', '--test-reporter',
  '--test-reporter-destination', '--test-timeout', '--test-shard', '--test-isolation', '--test-global-setup',
  '--test-coverage-include', '--test-coverage-exclude', '--test-coverage-branches', '--test-coverage-functions',
  '--test-coverage-lines', '--test-random-seed']);

function cargoTargetDir(dir) {
  const res = run('cargo', ['metadata', '--format-version', '1', '--no-deps'], { cwd: dir, timeoutMs: 120_000 });
  try { return JSON.parse(res.stdout).target_directory || path.join(dir, 'target'); } catch { return path.join(dir, 'target'); }
}

/**
 * Split a `node --test` command line into the part before its file patterns and the patterns:
 * node treats everything after the first pattern as test arguments, so added flags go before
 * them. Uses detect's `paths` when they are the command's tail; unclear lines stay whole.
 */
export function splitNodeTestCmd(cmd, paths = null) {
  const s = String(cmd || '').replace(/\s+$/, '');
  const known = toArray(paths).join(' ');
  if (known && s.endsWith(` ${known}`)) return { head: s.slice(0, -(known.length + 1)), paths: [...paths] };
  const at = /(?:^|\s)--test(?=\s|$)/.exec(s);
  const end = at ? at.index + at[0].length : 0;
  const tokens = at ? [...s.slice(end).matchAll(/\s+("[^"]*"|'[^']*'|\S+)/g)] : [];
  let cut = -1;
  for (let i = 0, value = false; i < tokens.length && cut === -1; i++) {
    const t = tokens[i][1];
    if (value) value = false;
    else if (t.startsWith('-')) value = !t.includes('=') && NODE_VALUE_OPTS.has(t);
    else cut = i;
  }
  const rest = cut === -1 ? [] : tokens.slice(cut).map((m) => m[1]);
  // Options after a pattern, or shell operators: not a plain pattern list, leave the line alone.
  if (!rest.length || rest.some((t) => /^-|^[&|;<>()]|[&|;<>]$/.test(t))) return { head: s, paths: [] };
  return { head: s.slice(0, end + tokens[cut].index), paths: rest };
}

/**
 * The command for `runner` in `dir`: report flags, retries off, `seed` (shuffle), `coverage` and
 * `select` ({ files, names }); `plan` computes it without writing anything. Returns
 * { cmd, env, report: { stdout | path | dir+dirs+glob, format }, applied, coverageFile, coverageDir }.
 */
export function buildRunCommand(runner, { dir, outDir, select = null, seed = null, coverage = false, plan = false } = {}) {
  const rep = runner.report;
  const fmt = rep ? normalizeFormat(rep.format) || rep.format : null;
  const v = { f: path.join(outDir, `report.${REPORT_EXT[fmt] || 'out'}`), d: path.join(outDir, 'reports'), c: null,
    cdir: path.join(outDir, 'coverage'), target: null };
  const fill = (t) => String(t).replace(/<(f|d|c|cdir|target)>/g, (m, k) => v[k] ?? m);
  if (!plan) ensureDir(v.d);
  const cv = (coverage && runner.coverage) || null;
  const applied = { retries: null, select: null, shuffle: null, coverage: null };
  const [env, extra] = [{}, []];
  let cmd = cv && cv.cmd ? cv.cmd : runner.cmd;
  let paths = [];
  if (runner.name === 'node-test') {
    const known = runner.base_cmd != null && cmd === runner.cmd && cmd.startsWith(runner.base_cmd);
    ({ head: cmd, paths } = known ? { head: runner.base_cmd, paths: toArray(runner.paths) } : splitNodeTestCmd(cmd, runner.paths));
  }
  if (runner.ensure && /^\s*cargo\b/.test(cmd) && !cmd.includes(runner.ensure)) cmd = appendArgs(cmd, [runner.ensure]);
  if (rep && rep.nextestConfig) {
    if (!plan) writeFileAtomic(path.join(v.d, 'nextest-adc.toml'), NEXTEST_TOML);
    v.target = plan ? '<target>' : toPosix(cargoTargetDir(dir));
  }
  if (rep && rep.flag && !(cv && cv.cmd)) {
    extra.push(substitute(rep.flag, v));
    if (runner.consoleFlag && !/destination=stdout/.test(rep.flag)) extra.push(runner.consoleFlag);
  }
  for (const [k, val] of Object.entries((rep && rep.env) || {})) env[k] = fill(val);
  // Retries off goes after the project's own options: for these CLIs the last occurrence wins.
  const mech = String((runner.retries_off && runner.retries_off.mechanism) || '').trim();
  if (/^-/.test(mech)) {
    if (!cmd.endsWith(mech)) extra.push(mech);
    applied.retries = mech;
  }
  if (seed != null && runner.shuffle) {
    const s = runner.shuffle(seed);
    extra.push(...s.map(quoteArg));
    applied.shuffle = s.join(' ');
  }
  if (cv) {
    v.c = path.join(/<cdir>/.test(cv.flag || cv.cmd || '') ? v.cdir : outDir, cv.file);
    if (!plan) ensureDir(v.cdir);
    if (cv.cmd) cmd = substitute(cmd, v);
    else extra.push(substitute(cv.flag, v));
    applied.coverage = cv.cmd ? cmd : cv.flag;
  }
  const sel = select && (select.files.length || select.names.length) ? selectionArgs(runner, select, dir) : null;
  if (sel) {
    if (runner.name === 'node-test' && select.files.length) paths = [];
    if (sel.packages) {
      cmd = cmd.replace(/(\s)\.\/\.\.\.(?=\s|$)/, `$1${sel.packages.map(quoteArg).join(' ')}`);
      if (!/\s\.\/\S/.test(cmd)) extra.push(...sel.packages.map(quoteArg));
    }
    extra.push(...sel.args);
    applied.select = sel.describe;
  }
  cmd = appendArgs(cmd, [...extra, ...paths]);
  const dirs = rep && (rep.dir || rep.dirs) ? uniq([rep.dir, ...toArray(rep.dirs)]).map((d) => path.resolve(dir, fill(d))) : null;
  const report = !rep ? null : rep.stdout ? { stdout: v.f, format: fmt }
    : rep.path ? { path: path.resolve(dir, fill(rep.path)), format: fmt }
      : dirs ? { dir: dirs[0], dirs, glob: rep.glob || '*', format: fmt } : { path: v.f, format: fmt };
  return { cmd, env, report, applied, coverageFile: v.c, coverageDir: v.cdir };
}

const goTestNames = (file) => [...readText(file, '').matchAll(/^func (Test\w*)\(\w+ \*testing\.T\)/gm)].map((m) => m[1]);
const classNames = (file) => [...readText(file, '').matchAll(/\bclass\s+([A-Z]\w*)/g)].map((m) => m[1]);

/** Runner arguments that restrict a run to `files` (relative to the project) and test `names`. */
export function selectionArgs(runner, { files = [], names = [] }, dir) {
  const q = quoteArg;
  const list = (l) => l.join(', ');
  if (runner.select === 'files') {
    // Names first: node --test ignores every option after the first file path.
    const named = names.length && runner.names ? runner.names(names) : [];
    return { args: [...named, ...files].map(q), describe: `files: ${list(files)}${names.length ? `; names: ${list(names)}` : ''}` };
  }
  if (runner.select === 'pytest') {
    const args = files.flatMap((f) => (names.length ? names.map((n) => `${f}::${n}`) : [f])).map(q);
    return { args, describe: `files: ${list(files)}` };
  }
  if (runner.select === 'go') {
    const packages = uniq(files.map((f) => path.posix.dirname(toPosix(f))).map((d) => (d === '.' ? '.' : `./${d}`)));
    const tests = names.length ? names : files.flatMap((f) => goTestNames(path.join(dir, f)));
    return { args: tests.length ? [q(`-run=^(?:${rx(tests)})$`)] : [], packages,
      describe: `packages: ${list(packages)}; tests: ${list(tests) || 'all'}` };
  }
  if (runner.select === 'cargo') {
    const posix = files.map(toPosix);
    const bins = posix.filter((f) => /^tests\/[^/]+\.rs$/.test(f)).map((f) => path.posix.basename(f, '.rs'));
    const src = posix.filter((f) => f.startsWith('src/'));
    // Unit tests in src/main.rs or src/bin/* belong to binary targets (`--lib` fails on a bin-only crate).
    const binSrc = src.filter((f) => /^src\/(?:main\.rs$|bin\/)/.test(f));
    const hasLib = fs.existsSync(path.join(dir, 'src', 'lib.rs'));
    const mods = src.filter((f) => !binSrc.includes(f)).map((f) => f.slice(4).replace(/(?:\/mod)?\.rs$/, '').replace(/\//g, '::'));
    const filters = [...names, ...(binSrc.length ? [] : mods.filter((m) => m && m !== 'lib').map((m) => `${m}::`))];
    const args = bins.flatMap((b) => ['--test', q(b)]);
    if (!bins.length && src.length && hasLib && src.length > binSrc.length) args.push('--lib');
    if (!bins.length && src.length && (binSrc.length || !hasLib)) args.push('--bins');
    if (filters.length) args.push('--', ...filters.map(q));
    return { args, describe: `targets: ${list(bins) || 'lib'}; filters: ${list(filters) || 'none'}` };
  }
  if (runner.select === 'classes') {
    const classes = names.length ? names : files.flatMap((f) => classNames(path.join(dir, f)));
    return classes.length ? { args: runner.classArgs(classes).map(q), describe: `classes: ${list(classes)}` } : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Running and parsing

/** Report files a run wrote: the report path, or the glob matches in every report dir (multi-module builds). */
function reportFiles(report) {
  if (!report || report.stdout) return [];
  if (report.path) return fs.existsSync(report.path) ? [report.path] : [];
  const re = new RegExp(`^${String(report.glob || '*').split('*').map(esc).join('.*')}$`);
  return toArray(report.dirs || report.dir).flatMap((d) => {
    try { return fs.readdirSync(d).filter((f) => re.test(f)).sort().map((f) => path.join(d, f)); } catch { return []; }
  });
}

/** Parse what a run produced: the report (files merged), else the runner's summary lines. */
export function parseRunOutput(report, stdout, stderr, roots) {
  if (report && report.format !== 'summary-text') {
    const texts = report.stdout ? [readText(report.stdout, null) ?? stdout] : reportFiles(report).map((f) => readText(f, ''));
    try {
      const parts = texts.filter((t) => t && t.trim()).map((t) => parseReport(report.format, t, { root: roots }));
      if (parts.length) {
        const counts = Object.fromEntries(COUNT_KEYS.map((k) => [k, parts.reduce((a, p) => a + (p[k] || 0), 0)]));
        return { counts, tests: parts.flatMap((p) => p.tests), source: 'report', format: parts[0].format,
          seeds: parts.flatMap((p) => p.seeds || []) };
      }
    } catch (err) {
      log(`report could not be parsed (${err.message}); falling back to summary lines`);
    }
  }
  // Runners without a report (unittest, minitest, make/just/npm wrappers) have summary lines only.
  const s = parseSummaryText(`${stdout}\n${stderr}`);
  if (!s || s.passed == null || s.failed == null) return { counts: null, tests: [], source: 'none', format: null, seeds: [] };
  const c = { passed: s.passed, failed: s.failed, errors: s.errors || 0, skipped: s.skipped || 0, flaky: s.flaky || 0 };
  const counts = pickCounts({ ...c, executed: c.passed + c.failed + c.errors + c.flaky });
  return { counts, tests: [], source: 'summary-text', format: `summary:${s.runner}`, seeds: [] };
}

const RERUNS_CONFIGURED = /unrecognized arguments:.*--(?:reruns|only-rerun|rerun-except|force-reruns)\b|'flaky' not found in `markers`/;

/**
 * pytest with pytest-rerunfailures configured in addopts (`--reruns 2`) or `flaky` markers under
 * --strict-markers rejects `-p no:rerunfailures` with a usage error. Retries are then turned off
 * with `--reruns 0`, which wins over addopts; `@pytest.mark.flaky(reruns=n)` still applies, so the
 * coverage is partial (reruns stay visible in the report as flaky).
 */
function pytestRerunsFallback(runner, built, res) {
  if (runner.name !== 'pytest' || built.applied.retries !== '-p no:rerunfailures' || res.exit === 0) return null;
  if (!RERUNS_CONFIGURED.test(`${res.stderr}\n${res.stdout}`.slice(-50_000))) return null;
  return { ...runner, retries_off: { mechanism: '--reruns 0', coverage: 'partial',
    note: 'pytest-rerunfailures is configured, so it cannot be disabled; @pytest.mark.flaky(reruns=n) still reruns' } };
}

/** Install (once) and run `runner` for `project` in worktree `wt`; log and report go under `outDir`. */
export async function runProject(wt, project, runner, {
  outDir, noInstall = false, timeoutMs = DEFAULT_TIMEOUT_S * 1000, select = null, seed = null, coverage = false,
  logName = 'run.log',
} = {}) {
  const logFile = path.join(ensureDir(outDir), logName);
  fs.writeFileSync(logFile, '');
  const dir = projectDir(wt, project);
  const install = await installProject(wt, project, { runner, noInstall, timeoutMs, logFile });
  let built = buildRunCommand(runner, { dir, outDir, select, seed, coverage });
  const rec = { cmd: built.cmd, install, applied: built.applied, report_files: [], log_path: logFile, dir,
    coverageFile: built.coverageFile, coverageDir: built.coverageDir, retries_off: runner.retries_off || null };
  if (install.cmd && install.exit !== 0) {
    return { ...rec, exit: null, ms: 0, counts: null, tests: [], source: 'none', status: 'unverified',
      reason: install.timedOut ? 'INSTALL_TIMEOUT' : 'INSTALL_FAILED' };
  }
  const exec = () => {
    // A reused worktree may hold reports of an earlier run (fixed paths, report dirs): never parse those.
    for (const f of reportFiles(built.report)) if (inside(wt.dir, f) || inside(outDir, f)) fs.rmSync(f, { force: true });
    log(`run: ${built.cmd} (in ${toPosix(dir)})`);
    fs.appendFileSync(logFile, `$ ${built.cmd}\n`);
    const captureFile = built.report && built.report.stdout;
    return runStep(built.cmd, { cwd: dir, env: runEnv(built.env).env, timeoutMs, logFile, captureFile });
  };
  let res = await exec();
  const fallback = pytestRerunsFallback(runner, built, res);
  if (fallback) {
    built = buildRunCommand(fallback, { dir, outDir, select, seed, coverage });
    Object.assign(rec, { cmd: built.cmd, applied: built.applied, retries_off: fallback.retries_off });
    res = await exec();
  }
  const parsed = parseRunOutput(built.report, res.stdout, res.stderr, [dir, wt.dir]);
  const { removed, set } = runEnv(built.env);
  const capture = built.report && built.report.stdout;
  return {
    ...rec, exit: res.exit, signal: res.signal, ms: res.ms, timedOut: res.timedOut, error: res.error, ...parsed,
    runnerMissing: !parsed.counts && res.exit !== 0 && runnerMissing(`${res.stderr}\n${res.stdout}`.slice(-20_000)),
    report_files: capture ? [capture].filter((f) => fs.existsSync(f)) : reportFiles(built.report),
    env: { set, removed }, stdoutTail: tail(res.stdout, 4000), stderrTail: tail(res.stderr, 4000),
  };
}

// ---------------------------------------------------------------------------
// Artifacts: redacted copies under .adc/cache/runs/<tree12>/<slug>/<run-id>/

// One folder per target (one CLI invocation; verify shares its target across steps): a ledger
// hashes its artifacts when a check is added, so a later run of the same tree (audit-tests after
// verify, a repeated clean-run) must never overwrite them.
const runIdOf = (target) => target.adcRunId || (target.adcRunId = `${stamp()}-${nonce().slice(0, 6)}`);
const RUN_DIR_RE = /^\d{8}T\d{6}Z-[0-9a-f]{6}$/;
const [KEEP_RUNS, KEEP_TREES] = [20, 50];
const pruned = new Set();

/** Keep the newest run folders per tree/project and the newest tree folders (old trees are stale anyway). */
function pruneRuns(runsDir, treeDir, slugDir, runId) {
  if (pruned.has(`${slugDir}\0${runId}`)) return;
  pruned.add(`${slugDir}\0${runId}`);
  const older = (dir, keep, filter) => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && filter(e.name))
        .map((e) => ({ full: path.join(dir, e.name), t: fs.statSync(path.join(dir, e.name)).mtimeMs }))
        .sort((a, b) => b.t - a.t).slice(keep).map((e) => e.full);
    } catch { return []; }
  };
  for (const d of [...older(slugDir, KEEP_RUNS, (n) => RUN_DIR_RE.test(n) && n !== runId),
    ...older(runsDir, KEEP_TREES, (n) => path.join(runsDir, n) !== treeDir)]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  }
}

/** A file's text, or its head and tail when it is larger than LOG_HEAD + LOG_TAIL. */
function readCapped(file) {
  const size = fs.statSync(file).size;
  if (size <= LOG_HEAD + LOG_TAIL) return readText(file, '');
  const fd = fs.openSync(file, 'r');
  try {
    const [head, end] = [Buffer.alloc(LOG_HEAD), Buffer.alloc(LOG_TAIL)];
    fs.readSync(fd, head, 0, LOG_HEAD, 0);
    fs.readSync(fd, end, 0, LOG_TAIL, size - LOG_TAIL);
    return `${head}\n[... ${size - LOG_HEAD - LOG_TAIL} bytes omitted by agentic-developer-companion ...]\n${end}`;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Copy a run's log and report files into the state dir, redacted; several report files (one per
 * class or module) go into a `reports/` folder. Returns `{ artifacts[], output_sha256 (of the log),
 * log_path, report_path }` (posix).
 */
export function storeArtifacts(target, tree, slug, rec, { prefix = '' } = {}) {
  const runsDir = path.join(target.state.paths.cache, 'runs');
  const treeDir = path.join(runsDir, String(tree).slice(0, 12));
  const runId = runIdOf(target);
  const dir = ensureDir(path.join(treeDir, slug, runId));
  pruneRuns(runsDir, treeDir, path.join(treeDir, slug), runId);
  const out = { artifacts: [], output_sha256: null, log_path: null, report_path: null };
  const save = (src, dest) => {
    const text = redact(readCapped(src));
    writeFileAtomic(dest, text);
    return text;
  };
  if (rec.log_path && fs.existsSync(rec.log_path)) {
    out.output_sha256 = sha256(save(rec.log_path, path.join(dir, `${prefix}run.log`)));
    out.artifacts.push(out.log_path = artifactPath(target.root, path.join(dir, `${prefix}run.log`)));
  }
  const files = toArray(rec.report_files || rec.report_path).filter((f) => fs.existsSync(f) && fs.statSync(f).isFile());
  if (files.length === 1) {
    save(files[0], path.join(dir, prefix + path.basename(files[0])));
    out.artifacts.push(out.report_path = artifactPath(target.root, path.join(dir, prefix + path.basename(files[0]))));
  } else if (files.length) {
    const sub = ensureDir(path.join(dir, `${prefix}reports`));
    const dup = (i) => files.some((g, j) => j !== i && path.basename(g) === path.basename(files[i]));
    files.forEach((f, i) => save(f, path.join(sub, `${dup(i) ? `${i}-` : ''}${path.basename(f)}`)));
    out.artifacts.push(out.report_path = artifactPath(target.root, sub));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Base counts: --base-counts file > .adc/cache/counts/<base-sha>-<slug>.json > a base-worktree run

const countsFile = (state, sha, slug) => path.join(state.paths.countsCache, `${sha}-${slug}.json`);

function writeCountsCache(state, sha, slug, rec) {
  const tests = toArray(rec.tests).slice(0, MAX_CACHED_IDS).map((t) => ({ id: t.id, status: t.status, ...(t.file && { file: t.file }) }));
  try {
    writeJsonAtomic(countsFile(state, sha, slug), { schema: 'adc-counts/1', base_sha: sha, project: rec.project,
      runner: rec.runner, cmd: redact(rec.cmd), ...pickCounts(rec.counts), tests, created_at: nowIso() });
  } catch (err) {
    log(`could not write the counts cache: ${err.message}`);
  }
}

/** Counts for `projectRoot` from a --base-counts file: a clean-run result, a counts object, or a map by project. */
export function importBaseCounts(file, projectRoot) {
  const json = readJson(file, null);
  if (!json) throw usageError(`--base-counts: cannot read JSON from ${toPosix(file)}`);
  const norm = (c) => (c && Number.isFinite(c.executed) ? { ...pickCounts(c), ...(c.tests && { tests: c.tests }) } : null);
  const want = toPosix(projectRoot || '.');
  if (Array.isArray(json.projects)) {
    const p = json.projects.find((x) => toPosix(x.root || '.') === want);
    return p ? norm(p.run || p.counts || p) : null;
  }
  if (json.projects && typeof json.projects === 'object') return norm(json.projects[projectRoot] || json.projects[want]);
  return norm(json.run || json);
}

async function baseCounts({ target, project, runner, slug, baseCountsFile, noInstall, timeoutMs, outRoot, keep, detectFn }) {
  const sha = target.base.sha;
  const prel = toPosix(project.root || '.');
  const imported = baseCountsFile ? importBaseCounts(path.resolve(target.root, baseCountsFile), prel) : null;
  if (imported) return { ...imported, source: 'file' };
  if (!sha) return { source: 'none', reason: 'NO_BASE' };
  const cached = readJson(countsFile(target.state, sha, slug), null);
  if (cached && cached.schema === 'adc-counts/1' && (!cached.runner || cached.runner === runner.name)) {
    return { ...cached, source: 'cache' };
  }
  const wt = acquireWorktree(target.root, sha, 'base', { keep });
  if (!fs.existsSync(projectDir(wt, project))) return { ...pickCounts({}), tests: [], source: 'absent-in-base' };
  // The base runs its own command (a narrowed test script in the snapshot must not narrow the base).
  let [baseRunner, baseProject] = [runner, project];
  try {
    const bp = toArray((await detectFn(wt.dir)).projects).find((p) => toPosix(p.root || '.') === prel);
    const opt = runner.source === '--runner' && (runner.name === 'custom' || runner.inferred) ? runner.cmd : runner.name;
    if (bp) [baseRunner, baseProject] = [resolveRunner(bp, opt) || runner, bp];
  } catch {}
  const rec = await runProject(wt, baseProject, baseRunner, { outDir: path.join(outRoot, slug, 'base'), noInstall, timeoutMs });
  const stored = storeArtifacts(target, target.snapshot.tree, slug, rec, { prefix: 'base-' });
  const { cmd, exit, linked, not_linked: notLinked } = rec.install;
  const install = cmd || linked || notLinked ? { cmd: cmd || null, exit: exit ?? null, ...(linked && { linked }),
    ...(notLinked && { not_linked: notLinked }) } : null;
  const common = { source: 'run', cmd: rec.cmd, artifacts: stored.artifacts, ...(install && { install }) };
  if (!rec.counts) {
    return { ...common, status: 'unverified', reason: rec.reason || (rec.runnerMissing ? 'RUNNER_NOT_FOUND' : 'NO_REPORT') };
  }
  writeCountsCache(target.state, sha, slug, { project: prel, runner: runner.name, cmd: rec.cmd, counts: rec.counts, tests: rec.tests });
  return { ...rec.counts, tests: rec.tests, ...common, status: rec.counts.failed || rec.counts.errors ? 'base-failing' : 'ok' };
}

// ---------------------------------------------------------------------------
// Outcomes (§9.1.1)

/** Does a parsed test belong to `file` (repo- or project-relative)? Uses file attributes, ids, modules, packages. */
export function testMatchesFile(t, file, { goModule = null, projectRoot = '.' } = {}) {
  const f = toPosix(file);
  const rel = projectRoot && projectRoot !== '.' && f.startsWith(projectRoot + '/') ? f.slice(projectRoot.length + 1) : f;
  const tf = t.file ? toPosix(t.file) : null;
  if (tf && [f, rel].some((v) => tf === v || tf.endsWith('/' + v) || v.endsWith('/' + tf))) return true;
  const id = String(t.id || '');
  for (const v of [f, rel]) {
    const dotted = v.replace(/\.[^./]+$/, '').replace(/\//g, '.');
    if (id.startsWith(v + '::') || id.includes(`/${v}::`)) return true;
    if (dotted && (id.startsWith(dotted + '::') || id.startsWith(dotted + '.') || id === dotted)) return true;
  }
  if (!t.package || !/\.go$/.test(f)) return false;
  const dir = path.posix.dirname(rel);
  if (goModule) return t.package === (dir === '.' ? goModule : `${goModule}/${dir}`);
  return dir === '.' ? !t.package.includes('/') : t.package.endsWith('/' + dir);
}

/**
 * Status for one project run (§9.1.1). `explained`: base tests gone from the run whose deletion
 * was waived (CK-TEST-DEL); `nowSkipped`: base tests that still exist but are skipped now (by id;
 * estimated from the skipped counts when null). Skipped tests fall under the skip rule, not the
 * shortfall rule; only tests that vanished from the run are a shortfall.
 */
export function evaluateRun(run, base, { explained = 0, skipFired = false, nowSkipped = null } = {}) {
  const c = run.counts;
  if (run.status === 'unverified') return { status: 'unverified', reason: run.reason };
  if (run.timedOut) return { status: 'unverified', reason: 'TIMEOUT' };
  if (notFound(run)) return { status: 'unverified', reason: 'RUNNER_NOT_FOUND' };
  if (!c) return { status: 'unverified', reason: run.source === 'none' && run.exit === 0 ? 'COUNTS_UNKNOWN' : 'NO_REPORT' };
  if (c.executed === 0) return { status: 'unverified', reason: 'NO_TESTS_EXECUTED' };
  if (c.failed > 0 || c.errors > 0) return { status: 'fail', reason: 'TESTS_FAILED' };
  let waived = null;
  if (base && c.executed < base.executed) {
    const drop = base.executed - c.executed;
    const shortfall = drop - Math.min(drop, nowSkipped ?? Math.max(0, c.skipped - (base.skipped || 0)));
    if (shortfall > explained) return { status: 'fail', reason: 'COUNT_SHORTFALL', shortfall };
    if (shortfall > 0) waived = { status: 'finding', reason: 'SHORTFALL_WAIVED', shortfall };
  }
  if (run.exit !== 0) return { status: 'fail', reason: 'EXIT_NONZERO' };
  if (base && c.skipped > (base.skipped || 0)) return { status: skipFired ? 'fail' : 'finding', reason: 'SKIP_INCREASE' };
  return waived || (c.flaky > 0 ? { status: 'finding', reason: 'FLAKY' } : { status: 'pass', reason: null });
}

const RANK = { fail: 5, unverified: 4, finding: 3, 'pass-with-baseline': 2, pass: 1, skipped: 0 };
export const worstStatus = (list) => list.reduce((a, s) => ((RANK[s] ?? 0) > (RANK[a] ?? 0) ? s : a), 'skipped');

/**
 * Command exit code: 1 for fail/finding, 4 for unverified, 3 when every unverified check is
 * unverified only because the runner or checker executable is missing (environment, §7.2).
 */
export function exitFor(status, checks = []) {
  if (status === 'fail' || status === 'finding') return EXIT.FINDINGS;
  if (status !== 'unverified') return EXIT.OK;
  const open = toArray(checks).filter((c) => c && c.status === 'unverified');
  const env = open.length && open.every((c) => ['RUNNER_NOT_FOUND', 'CHECKER_NOT_FOUND'].includes(c.reason));
  return env ? EXIT.ENV : EXIT.UNVERIFIABLE;
}

/** Waived deletions and fired checks from the newest ledger for this tree digest (§9.1.1, standalone runs). */
function ledgerContext(state, tree) {
  let best = null;
  let names = [];
  try { names = fs.readdirSync(state.paths.evidence).filter((x) => x.endsWith('.json')); } catch {}
  for (const n of names) {
    const j = readJson(path.join(state.paths.evidence, n), null);
    const t = j && j.tree_digest === tree ? Date.parse(j.finalized_at || j.created_at || '') || 0 : -1;
    if (t >= 0 && (!best || t > best.t)) best = { t, j };
  }
  return {
    waivers: toArray(best && best.j.waivers).filter((w) => w && w.check === 'CK-TEST-DEL'),
    fired: toArray(best && best.j.checks).filter((c) => c && (c.status === 'fail' || c.status === 'finding')).map((c) => c.id),
  };
}

// ---------------------------------------------------------------------------
// clean-run

/**
 * Clean run of the snapshot (§9.1 step 11) → `{ tree_digest, base, projects[], status, red_green?,
 * checks[] }`: one entry and one CK-CLEANRUN check per affected project and runner.
 */
export async function cleanRun({
  target, detectResult = null, noInstall = false, runner = null, allProjects = false, baseCountsFile = null,
  noBase = false, keep = false, redGreen = null, waivers, firedChecks, timeoutS = DEFAULT_TIMEOUT_S, dryRun = false,
  detectFn = (dir) => detect({ root: dir }),
} = {}) {
  const root = target.root;
  const tree = target.snapshot.tree;
  const det = detectResult || await detect({ root, stateInfo: dryRun ? null : target.state });
  let projects = toArray(det.projects);
  // An unknown stack with a user-given command line runs that command at the repository root.
  if (!projects.length && runner && /\s/.test(String(runner).trim())) projects = [{ root: '.', managers: [], runners: [] }];
  const changed = diffNameStatus(root, target.base.sha || emptyTree(root), target.snapshot.commit)
    .flatMap((f) => [f.path, f.oldPath].filter(Boolean));
  const affected = allProjects ? projects : projects.filter((p) => changed.some((f) => M.projectForFile(f, { projects }) === p));
  const ctx = ledgerContext(target.state, tree);
  const opts = {
    target, noInstall, baseCountsFile, noBase, keep, dryRun, detectFn, timeoutMs: Math.max(1, Number(timeoutS) || DEFAULT_TIMEOUT_S) * 1000,
    waived: waivers !== undefined ? toArray(waivers).filter((w) => !w.check || w.check === 'CK-TEST-DEL') : ctx.waivers,
    fired: firedChecks !== undefined ? toArray(firedChecks) : ctx.fired,
    check: (fields) => makeCheck({ id: 'CK-CLEANRUN', fm: FM['CK-CLEANRUN'], ...fields }),
  };
  const out = { tree_digest: tree, base: { ref: target.base.ref, sha: target.base.sha, source: target.base.source },
    changed_files: changed.length, projects: [], status: 'skipped', checks: [] };
  if (!projects.length || (!affected.length && !runner)) {
    const [status, reason, summary] = projects.length
      ? ['skipped', 'NO_AFFECTED_PROJECT', `no detected project owns a changed file (${changed.length} changed); nothing to run `
        + '(use --all-projects)']
      : ['unverified', 'NO_RUNNER', 'no test runner detected; ask the user for the test command and pass --runner "<command>"'];
    Object.assign(out, { status, checks: [opts.check({ status, reason, summary })] });
    if (redGreen && redGreen.length) out.red_green = { status: 'unverified', reason, pairs: [] };
    return out;
  }
  for (const project of affected.length ? affected : projects.slice(0, 1)) {
    const runners = resolveRunners(project, runner);
    const prel = toPosix(project.root || '.');
    const others = toArray(project.runners).map((r) => r.name).filter((n) => n && !runners.some((r) => r.name === canon(n)));
    if (!runners.length) {
      const summary = `no test runner detected for ${prel}; pass --runner "<command>"`;
      out.projects.push({ root: prel, status: 'unverified', reason: 'NO_RUNNER', check: opts.check({ project: prel, reason: 'NO_RUNNER', summary }) });
    }
    for (const r of runners) {
      const slug = projectSlug(prel) + (runners.length > 1 ? `-${r.name}` : '');
      out.projects.push(await cleanRunProject({ ...opts, project, runner: r, slug, others }));
    }
  }
  out.checks = out.projects.map((p) => p.check);
  for (const p of out.projects) delete p.check;
  if (redGreen && redGreen.length) {
    const { check, ...rest } = await redGreenProof({ ...opts, projects, files: redGreen, runnerOpt: runner });
    out.red_green = rest;
    out.checks.push(check);
  }
  out.status = worstStatus(out.checks.map((c) => c.status));
  if (!keep) releaseWorktrees({ root });
  return out;
}

const runSummary = (c) => (c ? `${c.executed} executed, ${c.passed} passed, ${c.failed} failed, ${c.errors} errors, `
  + `${c.skipped} skipped, ${c.flaky} flaky` : 'no counts');

async function cleanRunProject(o) {
  const { target, project, runner, slug, others, keep } = o;
  const tree = target.snapshot.tree;
  const prow = { root: toPosix(project.root || '.'), worktree: null, kept: Boolean(keep), install: null, run: null,
    base_counts: null, delta: null, report_path: null, log_path: null, status: 'unverified', reason: null };
  const check = (fields) => o.check({ project: prow.root, ...fields });
  if (o.dryRun) {
    const tmp = tmpRoot(target.root);
    const built = buildRunCommand(runner, { dir: path.join(tmp, 'dry-run'), outDir: path.join(tmp, 'dry-run-out'), plan: true });
    const m = toArray(project.managers).find((x) => x.install && (!x.ecosystem || x.ecosystem === runner.ecosystem));
    const summary = `dry run: would run \`${built.cmd}\` in a temp worktree of ${tree.slice(0, 12)}`;
    return Object.assign(prow, { status: 'skipped', reason: 'DRY_RUN', run: { cmd: built.cmd, runner: runner.name },
      install: { cmd: o.noInstall || !m ? null : m.install }, check: check({ status: 'skipped', reason: 'DRY_RUN', command: built.cmd, summary }) });
  }
  const outRoot = path.join(tmpRoot(target.root), `out-${tree.slice(0, 12)}-${nonce().slice(0, 6)}`);
  const head = acquireWorktree(target.root, target.snapshot.commit, 'head', { keep });
  const rec = await runProject(head, project, runner, { outDir: path.join(outRoot, slug, 'head'), noInstall: o.noInstall,
    timeoutMs: o.timeoutMs });
  const stored = storeArtifacts(target, tree, slug, rec);
  const retries = rec.retries_off || runner.retries_off;
  Object.assign(prow, { worktree: toPosix(head.dir), install: rec.install, report_path: stored.report_path, log_path: stored.log_path,
    run: { runner: runner.name, cmd: rec.cmd, exit: rec.exit, ms: rec.ms, ...(rec.counts || Object.fromEntries(COUNT_KEYS.map((k) => [k, null]))),
      retries_disabled: retries.coverage || 'unknown', mechanism: retries.mechanism || null, count_source: rec.source,
      report_format: rec.format || null, env: rec.env, ...(rec.timedOut && { timed_out: true }) },
    ...(others.length && { other_runners: others }) });

  const base = o.noBase ? null : await baseCounts({ ...o, slug, outRoot });
  const baseOk = base && Number.isFinite(base.executed) ? base : null;
  const bc = prow.base_counts = !base ? (o.noBase ? { source: 'none', reason: '--no-base' } : null) : {
    ...(baseOk && pickCounts(base)), source: base.source, ...(base.cmd && { cmd: base.cmd }), ...(base.status && { status: base.status }),
    ...(base.reason && { reason: base.reason }), ...(base.install && { install: base.install }),
  };
  if (baseOk && rec.counts) {
    prow.delta = Object.fromEntries(['executed', 'passed', 'failed', 'skipped', 'flaky'].map((k) => [k, rec.counts[k] - (baseOk[k] || 0)]));
  }
  // The head counts become a future base when the snapshot equals HEAD.
  if (rec.counts && target.snapshot.head && gitTry(target.root, ['rev-parse', `${target.snapshot.head}^{tree}`]) === tree) {
    const entry = { project: prow.root, runner: runner.name, cmd: rec.cmd, counts: rec.counts, tests: rec.tests };
    writeCountsCache(target.state, target.snapshot.head, slug, entry);
  }
  // A shortfall explained by waived test deletions (CK-TEST-DEL) is a finding, not a failure;
  // base tests that are merely skipped now are counted by id when both runs have ids.
  let [explained, nowSkipped] = [0, null];
  if (baseOk && rec.counts && rec.counts.executed < baseOk.executed && toArray(baseOk.tests).length && rec.tests.length) {
    const headById = new Map(rec.tests.map((t) => [t.id, t]));
    const ranInBase = baseOk.tests.filter((t) => t.status !== 'skipped');
    const waived = (t) => o.waived.some((w) => w.file && testMatchesFile(t, w.file, { projectRoot: prow.root }));
    nowSkipped = ranInBase.filter((t) => headById.get(t.id)?.status === 'skipped').length;
    explained = ranInBase.filter((t) => !headById.has(t.id) && waived(t)).length;
  }
  const verdict = evaluateRun(rec, baseOk, { explained, skipFired: o.fired.includes('CK-SKIP'), nowSkipped });
  Object.assign(prow, { status: verdict.status, reason: verdict.reason });
  const bad = verdict.reason && verdict.status !== 'pass';
  prow.summary = [
    runSummary(rec.counts),
    baseOk ? `(base: ${baseOk.executed}/${baseOk.passed}/${baseOk.failed}/${baseOk.skipped})`
      : bc && bc.source === 'none' ? '(no base counts)'
        : bc && bc.status === 'unverified' ? `(the base run gave no counts: ${bc.reason}; shortfall not checked)` : '',
    `retries_disabled: ${prow.run.retries_disabled}`, prow.run.retries_disabled !== 'full' ? `(${prow.run.mechanism})` : '',
    baseOk && (baseOk.failed || baseOk.errors) && verdict.reason === 'TESTS_FAILED'
      ? `(the base fails too: ${baseOk.failed} failed, ${baseOk.errors} errors)` : '',
    bad ? `- ${verdict.reason}${verdict.shortfall ? ` (${verdict.shortfall} fewer tests than the base)` : ''}` : '',
    rec.source === 'summary-text' ? '[counts from summary lines, no report]' : '',
    rec.install.linked ? '[--no-install: node_modules linked from the working tree]' : '',
    /^INSTALL_/.test(verdict.reason || '') ? `(\`${rec.install.cmd}\` exited ${rec.install.exit ?? 'on timeout'}; without network `
      + 'access re-run with --no-install to use the installed dependencies)' : '',
    others.length ? `[not run: ${others.join(', ')}]` : '',
  ].filter(Boolean).join(' ');
  if (!keep) fs.rmSync(outRoot, { recursive: true, force: true });
  const finding = (t, severity, message) => ({ id: 'CK-CLEANRUN', severity, file: t.file || null, line: null, message,
    evidence: truncate(t.message || '', 200) });
  const failing = rec.tests.filter((x) => x.status === 'failed' || x.status === 'error').slice(0, 50);
  const flaky = rec.tests.filter((x) => x.status === 'flaky').slice(0, 50);
  prow.check = check({
    status: verdict.status, reason: verdict.reason, command: [rec.install.cmd, rec.cmd].filter(Boolean).join(' && '),
    cwd: toPosix(rec.dir), exit_code: rec.exit, duration_ms: (rec.install.ms || 0) + (rec.ms || 0), summary: prow.summary,
    // The base run's report and log back the base counts the outcome depends on.
    output_sha256: stored.output_sha256, artifacts: [...stored.artifacts, ...((base && base.source === 'run' && base.artifacts) || [])],
    findings: [...failing.map((t) => finding(t, 'fail', `${t.status}: ${t.id}`)),
      ...flaky.map((t) => finding(t, 'finding', `flaky (passed after a retry): ${t.id}`))],
    data: { runner: runner.name, run: prow.run, install: prow.install, base_counts: bc, delta: prow.delta,
      worktree: keep ? prow.worktree : null, kept: Boolean(keep), shortfall_explained: explained },
  });
  return prow;
}

// ---------------------------------------------------------------------------
// Red-green proof (§9.4, §10.1 step 4): the base plus only the new test files must fail by
// assertion; the snapshot must pass.

/** Parse `--red-green` values: comma-separated `path` or `path::test-name` entries (spaces may be part of a path). */
export function parseRedGreenSpec(values) {
  return toArray(values).flatMap((v) => String(v || '').split(',')).map((v) => v.trim()).filter(Boolean).map((v) => {
    const i = v.indexOf('::');
    return i === -1 ? { file: toPosix(v), name: null } : { file: toPosix(v.slice(0, i)), name: v.slice(i + 2) };
  });
}

async function redGreenProof({ target, projects, files, runnerOpt, noInstall, keep, timeoutMs, dryRun }) {
  const root = target.root;
  const tree = target.snapshot.tree;
  const specs = parseRedGreenSpec(files).map((s) => ({ ...s, file: relPosix(root, path.resolve(root, s.file)) || s.file }));
  const res = { status: 'unverified', reason: null, files: specs.map((s) => s.file + (s.name ? `::${s.name}` : '')), pairs: [],
    base_report: null, head_report: null };
  const finish = (status, reason, summary, x = {}) => {
    const { base_counts: baseCounts = null, head_counts: headCounts = null, ...fields } = x;
    const data = { files: res.files, pairs: res.pairs, base_report: res.base_report, head_report: res.head_report,
      base_counts: baseCounts, head_counts: headCounts };
    return Object.assign(res, { status, reason, summary,
      check: makeCheck({ id: 'CK-REDGREEN', fm: FM['CK-REDGREEN'], ...fields, status, reason, summary, data }) });
  };
  const missing = specs.filter((s) => showFile(root, target.snapshot.commit, s.file) == null);
  if (missing.length) return finish('unverified', 'TEST_FILE_NOT_IN_SNAPSHOT', `not in the snapshot: ${missing.map((s) => s.file).join(', ')}`);
  if (!target.base.sha) return finish('unverified', 'NO_BASE', 'no base commit (unborn repository); the red half cannot run');
  const owners = uniq(specs.map((s) => M.projectForFile(s.file, { projects })));
  if (owners.length > 1) return finish('unverified', 'MULTIPLE_PROJECTS', 'red-green files span several projects; run once per project');
  if (!owners.length) return finish('unverified', 'NO_RUNNER', 'no detected project owns the red-green files');
  const project = owners[0];
  const prel = toPosix(project.root || '.');
  const runner = resolveRunner(project, runnerOpt, { ecosystem: fileEcosystem(specs[0].file) });
  if (!runner) return finish('unverified', 'NO_RUNNER', `no test runner detected for ${prel}`, { project: prel });
  const select = { files: specs.map((s) => (prel === '.' ? s.file : s.file.slice(prel.length + 1))), names: uniq(specs.map((s) => s.name)) };
  if (dryRun) {
    const summary = `dry run: would copy ${res.files.join(', ')} into a base worktree and run them there and in the snapshot`;
    return finish('skipped', 'DRY_RUN', summary, { project: prel });
  }
  const slug = projectSlug(prel);
  const outRoot = path.join(tmpRoot(root), `rg-${tree.slice(0, 12)}-${nonce().slice(0, 6)}`);
  // Red: the base with only the new test files copied in (the worktree becomes dirty: not reused).
  const baseWt = acquireWorktree(root, target.base.sha, 'base', { keep });
  baseWt.dirty = true;
  for (const s of specs) {
    ensureDir(path.dirname(path.join(baseWt.dir, s.file)));
    fs.writeFileSync(path.join(baseWt.dir, s.file), showFile(root, target.snapshot.commit, s.file));
  }
  const red = await runProject(baseWt, project, runner, { outDir: path.join(outRoot, 'red'), noInstall, timeoutMs, select });
  const redStored = storeArtifacts(target, tree, slug, red, { prefix: 'redgreen-base-' });
  // Green: the same selection in a clean snapshot worktree.
  const headWt = acquireWorktree(root, target.snapshot.commit, 'head', { keep });
  const green = await runProject(headWt, project, runner, { outDir: path.join(outRoot, 'green'), noInstall, timeoutMs, select });
  const greenStored = storeArtifacts(target, tree, slug, green, { prefix: 'redgreen-head-' });
  if (!keep) fs.rmSync(outRoot, { recursive: true, force: true });
  Object.assign(res, { base_report: redStored.report_path, head_report: greenStored.report_path });
  const x = { project: prel, command: red.cmd, cwd: toPosix(red.dir), exit_code: red.exit, duration_ms: (red.ms || 0) + (green.ms || 0),
    output_sha256: redStored.output_sha256, artifacts: [...redStored.artifacts, ...greenStored.artifacts], base_counts: red.counts,
    head_counts: green.counts };
  if (!red.counts || !green.counts || red.status === 'unverified' || green.status === 'unverified') {
    const reason = red.status === 'unverified' ? red.reason : green.status === 'unverified' ? green.reason : 'NO_REPORT';
    return finish('unverified', reason, `the ${!red.counts ? 'base' : 'snapshot'} run produced no parseable result`, x);
  }
  if (!red.tests.length || !green.tests.length) {
    const summary = 'the runner output has no per-test results (summary lines only); red-green needs a report with test ids';
    return finish('unverified', 'NO_TEST_IDS', summary, x);
  }
  const goModule = goModuleOf(projectDir(headWt, project));
  // Tests of the named files; when ids carry no file (cargo, TRX), the run was restricted to them anyway.
  const named = (t, s) => !s.name || String(t.id).includes(s.name);
  const pick = (tests) => {
    const hit = tests.filter((t) => specs.some((s) => testMatchesFile(t, s.file, { goModule, projectRoot: prel }) && named(t, s)));
    if (hit.length || !red.applied.select) return hit;
    return tests.filter((t) => specs.every((s) => !s.name) || specs.some((s) => s.name && named(t, s)));
  };
  const [redTests, greenTests] = [pick(red.tests), pick(green.tests)];
  const side = (t) => (t ? { status: t.status, failure_kind: t.failure_kind || null, message: t.message || null } : { status: 'missing' });
  for (const t of redTests) res.pairs.push({ id: t.id, base: side(t), head: side(greenTests.find((g) => g.id === t.id)) });
  for (const g of greenTests.filter((t) => !redTests.some((r) => r.id === t.id))) {
    res.pairs.push({ id: g.id, base: { status: 'missing' }, head: { status: g.status } });
  }
  const fail = (message, evidence) => ({ id: 'CK-REDGREEN', severity: 'fail', file: specs[0].file, line: null, message,
    evidence: truncate(evidence || '', 200) });
  if (!redTests.some((t) => t.status !== 'skipped')) {
    const err = red.tests.find((t) => t.failure_kind === 'error');
    if (!err) return finish('fail', 'NOT_EXECUTED', 'the named test is not in the base report (executed 0)', x);
    return finish('fail', 'NOT_EXECUTED_LOAD_ERROR', `the new test did not execute on the base: ${err.message || err.id}`,
      { ...x, findings: [fail('collection, import or compile error instead of an assertion failure', err.message || err.id)] });
  }
  const isRed = (p) => p.base.status === 'failed' && p.base.failure_kind === 'assertion';
  const proven = res.pairs.filter((p) => isRed(p) && p.head.status === 'passed');
  const wrongKind = res.pairs.filter((p) => ['failed', 'error'].includes(p.base.status) && p.base.failure_kind !== 'assertion');
  // Not green: anything failing in the snapshot, and every assertion red that does not pass there. A
  // file-level load error on the base has no counterpart id in the snapshot: a wrong kind, not a missing green.
  const notGreen = res.pairs.filter((p) => ['failed', 'error', 'flaky'].includes(p.head.status) || (isRed(p) && p.head.status !== 'passed'));
  x.findings = [...wrongKind.map((p) => fail(`fails on the base with an error, not an assertion: ${p.id}`, p.base.message)),
    ...notGreen.map((p) => fail(`does not pass in the snapshot: ${p.id} (${p.head.status})`, p.head.message))];
  const namedMissing = specs.filter((s) => s.name && !res.pairs.some((p) => String(p.id).includes(s.name))).map((s) => s.name);
  if (namedMissing.length) return finish('fail', 'NOT_EXECUTED', `named test not found in the base report: ${namedMissing.join(', ')}`, x);
  if (notGreen.length) return finish('fail', 'NOT_GREEN', `${notGreen.length} test(s) do not pass in the snapshot`, x);
  if (!proven.length && wrongKind.length) {
    const why = wrongKind[0].base.message || 'error';
    return finish('fail', 'WRONG_FAILURE_KIND', `the base run fails with an error (${why}), not an assertion failure`, x);
  }
  if (!proven.length) return finish('fail', 'NOT_RED', 'the new test passes on the base: it does not reproduce the bug', x);
  return finish('pass', null, `red-green proven for ${proven.length} test(s): assertion failure on the base `
    + `${target.base.sha.slice(0, 12)} with only the test file(s) copied in, pass in the snapshot ${tree.slice(0, 12)}`, x);
}

/** The module path of the Go module at `dir`, or null. */
export const goModuleOf = (dir) => (/^module\s+(\S+)/m.exec(readText(path.join(dir, 'go.mod'), '') || '') || [])[1] || null;

// ---------------------------------------------------------------------------
// typecheck: new errors vs the base (by file + code + message, ignoring line numbers)

const at = (file, line, code, message) => ({ file, line: line == null ? null : Number(line), code: code || null, message });
const TYPE_ERROR_PATTERNS = [
  // tsc: src/a.ts(12,5): error TS2322: ...   and pretty: src/a.ts:12:5 - error TS2322: ...
  [/^(.+?)\((\d+),(\d+)\): error (TS\d+): (.+)$/, (m) => at(m[1], m[2], m[4], m[5])],
  [/^(.+?):(\d+):(\d+) - error (TS\d+): (.+)$/, (m) => at(m[1], m[2], m[4], m[5])],
  [/^error (TS\d+): (.+)$/, (m) => at(null, null, m[1], m[2])],
  // dotnet build / msbuild: path(12,5): error CS0103: ... [proj]
  [/^(.+?)\((\d+),(\d+)\): error ([A-Z]+\d+): (.+?)(?: \[[^\]]+\])?$/, (m) => at(m[1], m[2], m[4], m[5])],
  // pyright: /abs/a.py:12:5 - error: message (rule)
  [/^\s*(.+?\.pyi?):(\d+):(\d+) - error: (.+?)(?: \((report\w+)\))?$/, (m) => at(m[1], m[2], m[5], m[4])],
  // mypy: a.py:12: error: message  [code]   (optionally with a column)
  [/^(.+?\.pyi?):(\d+):(?:(\d+):)? error: (.+?)(?:\s+\[([\w-]+)\])?$/, (m) => at(m[1], m[2], m[5], m[4])],
  // cargo --message-format=short: src/a.rs:3:5: error[E0425]: message
  [/^(.+?\.rs):(\d+):(\d+): error(?:\[(E\d+)\])?: (.+)$/, (m) => at(m[1], m[2], m[4], m[5])],
  // javac via maven / gradle
  [/^\[ERROR\] (.+?\.(?:java|kt)):\[(\d+),(\d+)\] (.+)$/, (m) => at(m[1], m[2], null, m[4])],
  [/^(.+?\.(?:java|kt)):(\d+): error: (.+)$/, (m) => at(m[1], m[2], null, m[3])],
  // go vet / go build (vet: prefix optional)
  [/^(?:vet: )?(\.{0,2}\/?[^\s:]+\.go):(\d+):(?:(\d+):)? (.+)$/, (m) => at(m[1], m[2], null, m[4])],
];

/** Errors from a type checker's output: `[{ file, line, code, message }]` (paths relative to `roots`). */
export function parseTypeErrors(output, { roots = [] } = {}) {
  const errors = new Map();
  const variants = rootVariants(roots);
  for (const raw of String(output || '').replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line || (/\bwarning\b[:[]/.test(line.split(':').slice(0, 4).join(':')) && !/\berror\b/.test(line))) continue;
    const hit = TYPE_ERROR_PATTERNS.find(([re]) => re.test(line));
    const e = hit && hit[1](hit[0].exec(line));
    if (!e || /^(?:warning|note|info)\b/i.test(e.message)) continue;
    const f = e.file && toPosix(e.file.trim());
    const r = f && variants.find((v) => f.startsWith(v + '/'));
    Object.assign(e, { file: f ? (r ? f.slice(r.length + 1) : f).replace(/^\.\//, '') : null, message: e.message.trim() });
    // msbuild prints each error twice (inline and in the summary): keep one.
    const key = `${e.file}\0${e.line}\0${e.code}\0${e.message}`;
    if (!errors.has(key)) errors.set(key, e);
  }
  return [...errors.values()];
}

const errorKey = (e) => `${e.file || ''}\0${e.code || ''}\0${String(e.message).replace(/\s+/g, ' ').replace(/\(\d+,\d+\)|:\d+:\d+/g, '')}`;

/** Head errors that are not in the base (multiset by file + code + message, line numbers ignored). */
export function newErrors(baseErrors, headErrors) {
  const counts = new Map();
  for (const e of baseErrors) counts.set(errorKey(e), (counts.get(errorKey(e)) || 0) + 1);
  return headErrors.filter((e) => {
    const n = counts.get(errorKey(e)) || 0;
    counts.set(errorKey(e), n - 1);
    return n <= 0;
  });
}

/** Type checkers of the detected projects: `name` selects one (a non-checker name selects all), `cmd` replaces them. */
function checkersFor(det, name, cmd) {
  const projects = toArray(det.projects);
  if (cmd) return [{ name: 'custom', cmd: cmd.trim(), project: projects[0] || { root: '.', managers: [] } }];
  const list = projects.flatMap((p) => toArray(p.typecheck).filter((t) => t && t.cmd).map((t) => ({ ...t, project: p })));
  const hit = name ? list.filter((c) => c.name === name) : [];
  return hit.length ? hit : list;
}

/** Machine-readable output flags: tsc `--pretty false`, cargo `--message-format=short`. */
const checkerCommand = (cmd) => (/\btsc\b/.test(cmd) && !/--pretty/.test(cmd) ? `${cmd} --pretty false`
  : /^\s*cargo\s+(?:check|build|clippy)\b/.test(cmd) && !/--message-format/.test(cmd) ? `${cmd} --message-format=short` : cmd);

async function typecheckIn(wt, c, cmd, { outRoot, label, noInstall, timeoutMs }) {
  const dir = projectDir(wt, c.project);
  const logFile = path.join(ensureDir(path.join(outRoot, label)), 'run.log');
  fs.writeFileSync(logFile, '');
  if (!fs.existsSync(dir)) return { exit: null, ms: 0, errors: [], absent: true, log_path: logFile };
  const install = await installProject(wt, c.project, { noInstall, timeoutMs, logFile });
  if (install.cmd && install.exit !== 0) return { exit: null, ms: install.ms, errors: [], install, failed: 'INSTALL_FAILED', log_path: logFile };
  fs.appendFileSync(logFile, `$ ${cmd}\n`);
  const res = await runStep(cmd, { cwd: dir, env: runEnv().env, timeoutMs, logFile });
  const text = `${res.stderr}\n${res.stdout}`;
  let errors = parseTypeErrors(text, { roots: [dir, wt.dir] });
  const missing = res.exit !== 0 && !errors.length && runnerMissing(text.slice(-20_000));
  if (res.exit !== 0 && !errors.length && !res.timedOut && !missing) {
    errors = [{ file: null, line: null, code: `exit-${res.exit}`, message: truncate(firstLine(text) || `exit ${res.exit}`, 300) }];
  }
  return { exit: res.exit, ms: res.ms, errors, install, timedOut: res.timedOut, error: res.error, missing, log_path: logFile };
}

/** Status of one checker from its snapshot (`head`) and base runs. */
function typecheckOutcome(head, base, fresh, strict) {
  // A base check that could not run (failed install, missing checker, timeout, or an unparseable
  // crash the snapshot does not repeat) is no baseline: comparing against it would report every
  // pre-existing error as new.
  const synthetic = base.errors.length && base.errors.every((e) => /^exit-/.test(String(e.code || '')));
  const baseProblem = base.absent ? null : base.failed || (base.timedOut && 'TIMEOUT') || (notFound(base) && 'CHECKER_NOT_FOUND')
    || (base.error && 'SPAWN_FAILED') || (synthetic && fresh.length && 'UNPARSEABLE_FAILURE') || null;
  const [status, reason] = head.timedOut ? ['unverified', 'TIMEOUT'] : head.failed ? ['unverified', head.failed]
    : notFound(head) ? ['unverified', 'CHECKER_NOT_FOUND'] : strict && head.errors.length ? ['fail', 'STRICT_ERRORS']
      : !head.errors.length ? ['pass', null] : baseProblem ? ['unverified', 'BASE_UNAVAILABLE']
        : fresh.length ? ['fail', 'NEW_ERRORS'] : ['pass-with-baseline', 'PRE_EXISTING_ERRORS'];
  return { status, reason, baseProblem };
}

/**
 * Type check in base and snapshot worktrees (§9.1 step 10) →
 * `{ cmd, base: { exit, errors }, head: { exit, errors }, new_errors[], status, checkers[], checks[] }`.
 */
export async function typecheck({
  target, detectResult = null, strict = false, runner = null, checkerCmd = null, noInstall = false, keep = false,
  timeoutS = DEFAULT_TIMEOUT_S, dryRun = false,
} = {}) {
  const root = target.root;
  const tree = target.snapshot.tree;
  const det = detectResult || await detect({ root, stateInfo: dryRun ? null : target.state });
  const timeoutMs = Math.max(1, Number(timeoutS) || DEFAULT_TIMEOUT_S) * 1000;
  const out = { cmd: null, base: null, head: null, new_errors: [], status: 'skipped', checkers: [], checks: [] };
  const check = (fields) => makeCheck({ id: 'CK-TYPES', fm: FM['CK-TYPES'], ...fields });
  const checkers = checkersFor(det, runner, checkerCmd);
  if (!checkers.length) out.checks.push(check({ status: 'skipped', reason: 'NO_CHECKER', summary: 'no compile or type checker detected' }));
  for (const c of checkers) {
    const prel = toPosix(c.project.root || '.');
    const cmd = checkerCommand(c.cmd);
    if (dryRun) {
      out.checkers.push({ name: c.name, project: prel, cmd, status: 'skipped' });
      const summary = `dry run: would run \`${cmd}\` in base and snapshot worktrees`;
      out.checks.push(check({ project: prel, status: 'skipped', reason: 'DRY_RUN', command: cmd, summary }));
      continue;
    }
    const io = { outRoot: path.join(tmpRoot(root), `tc-${tree.slice(0, 12)}-${nonce().slice(0, 6)}`), noInstall, timeoutMs };
    const head = await typecheckIn(acquireWorktree(root, target.snapshot.commit, 'typecheck', { keep }), c, cmd, { ...io, label: 'head' });
    const base = target.base.sha ? await typecheckIn(acquireWorktree(root, target.base.sha, 'base', { keep }), c, cmd, { ...io, label: 'base' })
      : { exit: null, errors: [], absent: true };
    const store = (r, prefix) => (r.log_path ? storeArtifacts(target, tree, projectSlug(prel), r, { prefix }) : { artifacts: [] });
    const [storedHead, storedBase] = [store(head, `typecheck-${c.name}-`), store(base, `typecheck-${c.name}-base-`)];
    if (!keep) fs.rmSync(io.outRoot, { recursive: true, force: true });
    const fresh = newErrors(base.errors, head.errors);
    const { status, reason, baseProblem } = typecheckOutcome(head, base, fresh, strict);
    const unknown = reason === 'BASE_UNAVAILABLE';
    const notLinked = toArray(base.install && base.install.not_linked)[0];
    const hint = baseProblem === 'INSTALL_FAILED' ? '; without network access re-run with --no-install'
      : notLinked ? `; --no-install could not link ${notLinked.path} into the base: ${notLinked.reason}` : '';
    const baseText = base.absent ? 'no base' : baseProblem ? `the base check did not run (${baseProblem}${hint})` : `${base.errors.length} in the base`;
    const summary = `${c.name}: ${head.errors.length} error(s) in the snapshot, ${baseText}, `
      + `${unknown ? 'new errors unknown' : `${fresh.length} new`}${strict ? ' (strict)' : ''}`;
    const rec = { name: c.name, project: prel, cmd, base: { exit: base.exit ?? null, errors: base.errors.length, ...(baseProblem && { problem: baseProblem }) },
      head: { exit: head.exit, errors: head.errors.length }, new_errors: unknown ? [] : fresh, status, reason };
    const finding = (e) => ({ id: 'CK-TYPES', severity: 'fail', line: e.line, file: e.file ? (prel === '.' ? e.file : `${prel}/${e.file}`) : null,
      message: `${e.code ? `${e.code}: ` : ''}${e.message}`, evidence: truncate(e.message, 200) });
    out.checkers.push(rec);
    out.checks.push(check({
      project: prel, status, reason, command: cmd, exit_code: head.exit, duration_ms: (head.ms || 0) + (base.ms || 0), summary,
      output_sha256: storedHead.output_sha256, artifacts: [...storedHead.artifacts, ...storedBase.artifacts],
      findings: (strict ? head.errors : rec.new_errors).slice(0, 100).map(finding),
      data: { checker: c.name, base: rec.base, head: rec.head, new_errors: unknown ? null : fresh.length, strict: Boolean(strict) },
    }));
  }
  const primary = out.checkers[0] || {};
  Object.assign(out, { cmd: primary.cmd || null, base: primary.base || null, head: primary.head || null,
    new_errors: out.checkers.flatMap((c) => c.new_errors), status: worstStatus(out.checks.map((c) => c.status)) });
  if (!keep) releaseWorktrees({ root });
  return out;
}

// ---------------------------------------------------------------------------
// Commands

export const COMMON_OPTIONS = {
  base: { type: 'string' }, runner: { type: 'string' }, 'no-install': { type: 'boolean' }, keep: { type: 'boolean' },
  timeout: { type: 'string' }, refresh: { type: 'boolean' },
};

/**
 * `--red-green` / `--tests` entries (`path` or `path::name`, comma-separated) as repo-relative paths:
 * a path that exists relative to `--cwd` is taken from there, anything else is repo-relative.
 */
export function repoRelativeEntries(values, cwd, root) {
  if (!values) return null;
  return parseRedGreenSpec(values).map(({ file, name }) => {
    const rel = cwd !== root && fs.existsSync(path.resolve(cwd, file)) ? relPosix(root, path.resolve(cwd, file)) : null;
    return (rel && rel !== '.' ? rel : file) + (name != null ? `::${name}` : '');
  });
}

/** Target and detection shared by the run commands (a dry run writes no state). */
export async function commandSetup(ctx, values) {
  const target = await prepareTarget(ctx, { base: values.base || null, createState: !ctx.dryRun });
  target.cwd = ctx.cwd;
  const stateInfo = ctx.dryRun ? null : target.state;
  return { target, detectResult: await detect({ root: target.root, stateInfo, refresh: Boolean(values.refresh) }) };
}

export const cleanRunCommand = defineCommand({
  name: 'clean-run',
  usage: [
    'clean-run [--base <ref>] [--no-install] [--runner <name|"command">] [--all-projects]',
    '          [--base-counts <file>] [--no-base] [--keep] [--red-green <test files>] [--timeout <s>] [--refresh] [--json]',
    'Runs the full suite of every project that owns a changed file (one runner per ecosystem) on the working-tree',
    'snapshot, in a temp worktree, frozen install, retries off; compares counts with the base (CK-CLEANRUN).',
    '--red-green f1,f2[::name]: the new tests must fail by assertion on the base and pass in the snapshot (CK-REDGREEN).',
  ].join('\n'),
  options: { ...COMMON_OPTIONS, 'all-projects': { type: 'boolean' }, 'base-counts': { type: 'string' },
    'no-base': { type: 'boolean' }, 'red-green': { type: 'string', multiple: true } },
  async run(ctx, values) {
    const timeoutS = numberOption(values, 'timeout', DEFAULT_TIMEOUT_S);
    const { target, detectResult } = await commandSetup(ctx, values);
    const res = await cleanRun({
      target, detectResult, noInstall: Boolean(values['no-install']), runner: values.runner || null,
      allProjects: Boolean(values['all-projects']), noBase: Boolean(values['no-base']), keep: Boolean(values.keep),
      baseCountsFile: values['base-counts'] ? path.resolve(ctx.cwd, values['base-counts']) : null,
      redGreen: repoRelativeEntries(values['red-green'], ctx.cwd, target.root), timeoutS, dryRun: ctx.dryRun,
    });
    const rows = res.projects.map((p) => `${p.root}${p.run ? ` (${p.run.runner})` : ''}: ${p.status}${p.reason ? ` (${p.reason})` : ''}`);
    const summary = rows.length ? rows.join('; ') + (res.red_green ? `; red-green: ${res.red_green.status}` : '') : res.checks[0].summary;
    return { result: redactAll(res), exit: exitFor(res.status, res.checks), summary: redact(`${res.status.toUpperCase()} - ${summary}`) };
  },
});

export const typecheckCommand = defineCommand({
  name: 'typecheck',
  usage: [
    'typecheck [--base <ref>] [--strict] [--runner <checker|"command">] [--no-install] [--keep] [--timeout <s>]',
    '          [--refresh] [--json]',
    'Runs the detected compile/type check in base and snapshot worktrees and reports new errors only (CK-TYPES).',
  ].join('\n'),
  options: { ...COMMON_OPTIONS, strict: { type: 'boolean' } },
  async run(ctx, values) {
    const timeoutS = numberOption(values, 'timeout', DEFAULT_TIMEOUT_S);
    const opt = values.runner ? String(values.runner).trim() : null;
    const isCmd = Boolean(opt && /\s/.test(opt));
    const { target, detectResult } = await commandSetup(ctx, values);
    const names = checkersFor(detectResult, null, null).map((c) => c.name);
    if (opt && !isCmd && !names.includes(opt)) {
      throw usageError(`--runner "${opt}" is not a detected type checker (${names.join(', ') || 'none'}); pass a command line instead`);
    }
    const res = await typecheck({ target, detectResult, strict: Boolean(values.strict), runner: isCmd ? null : opt,
      checkerCmd: isCmd ? opt : null, noInstall: Boolean(values['no-install']), keep: Boolean(values.keep), timeoutS, dryRun: ctx.dryRun });
    const exit = exitFor(res.status === 'pass-with-baseline' ? 'pass' : res.status, res.checks);
    return { result: redactAll(res), exit, summary: redact(`${res.status.toUpperCase()} - ${res.checks.map((c) => c.summary).join('; ')}`) };
  },
});
