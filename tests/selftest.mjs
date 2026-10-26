// `selftest`: the skill's own tests (§13) behind one command, run from the repository root:
//   node tests/selftest.mjs [--only area,...] [--jobs n]
// It is development tooling and is not shipped: the skill folder carries only what a consumer
// needs, while tests/, evals/, README.md, CHANGELOG.md and THIRD_PARTY_NOTICES.md live at the
// repository root. Areas backed by unit files (tests/unit/) run `node --test --test-reporter=tap
// <file>` in a child process and parse the TAP stream; the cross-cutting areas check the skill
// folder (footprint, frontmatter, prerequisites) and the root material (README, release, evals)
// directly. Scenarios run in temp repositories that are removed afterwards: the skill tree and
// the user's repositories are only ever read.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  EXIT, SKILL_DIR, SKILL_NAME, IS_WINDOWS, defineCommand, usageError, readText, readJson, run, which,
  toolVersion, versionGte, parseVersion, toPosix, tmpRoot, truncate, nowIso, nonce,
} from '../skills/agentic-developer-companion/scripts/lib/core.mjs';
import { createSnapshot, lsTree } from '../skills/agentic-developer-companion/scripts/lib/git.mjs';
import { materializeTemplates, prepareStateDir } from '../skills/agentic-developer-companion/scripts/lib/state.mjs';

const OWN_LIB = path.join(SKILL_DIR, 'scripts', 'lib');
/** The repository root that holds tests/, evals/, README.md, CHANGELOG.md for a skill at skills/<name>/. */
const devRootOf = (skillDir) => path.resolve(skillDir, '..', '..');
/** The only top-level entries a shipped skill folder may hold (owner decision 2026-10-25). */
const SHIPPED_TOP = new Set(['SKILL.md', 'PREREQUISITES.md', 'references', 'scripts', 'assets']);
/** True when `skillDir` sits at skills/<name>/ in a checkout of this repository (it has tests/selftest.mjs). */
const isDevLayout = (skillDir) => path.basename(path.dirname(path.resolve(skillDir))) === 'skills'
  && exists(path.join(devRootOf(skillDir), 'tests', 'selftest.mjs'));
/** Development-only material: it lives at the repository root and never inside the skill folder. */
const DEV_ONLY = ['tests', 'evals', 'CHANGELOG.md', 'THIRD_PARTY_NOTICES.md', '.gitattributes', 'README.md'];

/** Unit files per area (tests/unit/); any other unit file present runs under `scripts`. */
export const UNIT_FILES = Object.freeze({
  scripts: ['core.test.mjs'],
  frontmatter: ['tooling-lint.test.mjs'],
  hooks: ['hooks.test.mjs'],
  diffs: ['diff-scope.test.mjs'],
  detect: ['detect.test.mjs'],
  reports: ['reports.test.mjs'],
  evidence: ['evidence.test.mjs'],
  live: ['live.test.mjs'],
  tooling: ['tooling.test.mjs'],
  scaffold: ['scaffold.test.mjs'],
});

/** Areas in run order with what each covers (`--only` takes these names). */
export const AREAS = Object.freeze({
  footprint: 'skill folder only: file count, folder size, file size, LF, no development files, references linked and within budget, links, substitution tokens, .env files, adc templates, notices',
  frontmatter: 'SKILL.md frontmatter invariants, tooling-lint --strict, skills-ref / claude plugin validate / gh skill publish --dry-run when installed',
  scripts: 'node --check on every module, the adc.mjs command table, version and help, core unit tests',
  prereqs: 'assets/prerequisites.json and PREREQUISITES.md agree; optional items have fallbacks; doctor probes have entries',
  readme: 'root README.md: sections in order, links resolve, Mermaid fences, no absolute local paths',
  release: 'git tag = metadata.version = top entry of the root CHANGELOG.md',
  evals: 'root evals/ layout and trigger set; prints the paid eval commands (never runs them)',
  hooks: 'malformed input, old Node, ASCII-only output, session-start latency, hook unit tests',
  adc: 'tracked .adc/ refusals, snapshot exclusion, exclude entry in worktrees and submodules, leak checks',
  diffs: 'no secret-shaped literal in the repository, diff-scope unit tests (scenarios and evasion matrix)',
  detect: 'detect unit tests',
  reports: 'report parser, clean-run and probe unit tests',
  evidence: 'evidence ledger, trace and verify unit tests',
  live: 'live runner, budget and doctor unit tests',
  tooling: 'tooling cost, port, trigger-set, modify and plugin unit tests',
  scaffold: 'scaffold unit tests',
});

const LIMITS = Object.freeze({ files: 100, folderEntries: 50, fileBytes: 5 * 1024 * 1024, skillLines: 150, refLines: 300, tocOver: 100,
  prereqLines: 200, evalFiles: 10, descriptionChars: 1024, compatibilityChars: 500 });
const DEFAULT_TIMEOUT_S = 600;
const FALLBACK_EVENTS = ['session-start', 'post-edit', 'post-shell', 'stop', 'pre-guard', 'session-end'];
const MIN_GH = '2.90.0';
// Side-by-side gh installs probed after PATH (a newer gh next to a distro package).
const EXTRA_GH = IS_WINDOWS ? [] : ['/opt/ghnew/bin/gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh'];

// ---------------------------------------------------------------------------
// Small helpers

const mk = (name, status, detail = '', extra = {}) => ({ name, status, detail: truncate(String(detail ?? ''), 1500), ...extra });
const pass = (name, detail, extra) => mk(name, 'pass', detail, extra);
const fail = (name, detail, extra) => mk(name, 'fail', detail, extra);
const skip = (name, detail, extra) => mk(name, 'skipped', detail, extra);
const verdict = (name, problems, okDetail, extra) => (problems.length ? fail(name, listDetail(problems), extra) : pass(name, okDetail, extra));

function listDetail(items, max = 8) {
  const shown = items.slice(0, max).join('; ');
  return items.length > max ? `${shown}; ... ${items.length - max} more` : shown;
}

const lineCount = (text) => { if (!text) return 0; const n = text.split('\n').length; return text.endsWith('\n') ? n - 1 : n; };
const isAscii = (s) => !/[^\x00-\x7f]/.test(s);
const realDir = (d) => { try { return fs.realpathSync.native(d); } catch { return d; } };
const exists = (p) => { try { fs.statSync(p); return true; } catch { return false; } };
const errText = (err) => truncate(String(err && err.message ? err.message : err), 400);
const firstLine = (s) => String(s || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';

/** Process environment for children: host-session markers, ADC_* and repository-redirecting git variables removed. */
export function childEnv(base = process.env, extra = {}) {
  const drop = /^(?:ADC_|CLAUDE|COPILOT|GITHUB_COPILOT|CODEX_|VSCODE_|TERM_PROGRAM$|NODE_TEST_CONTEXT$|NODE_OPTIONS$|GIT_(?:DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|PREFIX|CEILING_DIRECTORIES)$)/;
  const env = {};
  for (const [k, v] of Object.entries(base)) if (!drop.test(k.toUpperCase())) env[k] = v;
  env.GIT_TERMINAL_PROMPT = '0';
  return { ...env, ...extra };
}

const GITC = ['-c', 'user.name=adc-selftest', '-c', 'user.email=adc-selftest@localhost', '-c', 'commit.gpgsign=false',
  '-c', 'core.autocrlf=false', '-c', 'init.defaultBranch=main', '-c', 'protocol.file.allow=always'];

function git(sx, cwd, args, opts = {}) {
  return run('git', [...GITC, ...args], { cwd, env: sx.env, timeoutMs: 120_000, ...opts });
}

function gitOk(sx, cwd, args, opts) {
  const r = git(sx, cwd, args, opts);
  if (r.exit !== 0) throw new Error(`git ${args.join(' ')} failed: ${firstLine(r.stderr || r.stdout || r.error)}`);
  return r.stdout.replace(/\r?\n$/, '');
}

/** `node <skill>/scripts/adc.mjs ...` synchronously, with the sanitized environment. */
function adc(sx, args, { cwd, input = '', env = {}, timeoutMs = 120_000, nodeArgs = [] } = {}) {
  return run(process.execPath, [...nodeArgs, sx.adc, ...args], { cwd: cwd || sx.tmp(), input, env: { ...sx.env, ...env }, timeoutMs });
}

function parseJsonOut(stdout) {
  try { return JSON.parse(String(stdout || '').trim()); } catch { return undefined; }
}

/** A temp repository under this run's temp root, realpath'd (macOS /var vs /private/var). */
function makeRepo(sx, name, files = {}, { commit = true } = {}) {
  const dir = path.join(sx.tmp(), name);
  fs.mkdirSync(dir, { recursive: true });
  gitOk(sx, dir, ['init', '-q']);
  writeFiles(dir, files);
  if (commit) {
    gitOk(sx, dir, ['add', '-A']);
    gitOk(sx, dir, ['commit', '-q', '--allow-empty', '-m', 'init']);
  }
  const real = realDir(dir);
  sx.repos.push(real);
  return real;
}

function writeFiles(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

/** Every file under `dir` (relative POSIX path -> base64 content) except top-level `skip` names. */
function snapshotDir(dir, { skip = [] } = {}) {
  const out = {};
  const walk = (abs, rel) => {
    let entries = [];
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!rel && skip.includes(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      const a = path.join(abs, e.name);
      if (e.isDirectory()) walk(a, r);
      else if (e.isFile()) { try { out[r] = fs.readFileSync(a).toString('base64'); } catch {} }
    }
  };
  walk(dir, '');
  return out;
}

// ---------------------------------------------------------------------------
// TAP (node --test --test-reporter=tap)

function tapUnquote(v) {
  const s = v.trim();
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) return s.slice(1, -1).replace(/''/g, "'");
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) { try { return JSON.parse(s); } catch { return s.slice(1, -1); } }
  return s;
}

/** The YAML diagnostic block node emits after a test point: flat keys, quoted or `|-` block scalars. */
function parseTapYaml(lines) {
  const out = {};
  const indentOf = (l) => /^\s*/.exec(l)[0].length;
  const base = lines.length ? indentOf(lines.find((l) => l.trim()) || '') : 0;
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)([A-Za-z_][\w-]*):(?:\s(.*))?$/.exec(lines[i]);
    if (!m || m[1].length !== base) continue;
    const raw = (m[3] || '').trim();
    if (/^[|>][+-]?$/.test(raw)) {
      const block = [];
      while (i + 1 < lines.length && (lines[i + 1].trim() === '' || indentOf(lines[i + 1]) > base)) block.push(lines[++i]);
      const ind = Math.min(...block.filter((l) => l.trim()).map(indentOf), Infinity);
      out[m[2]] = block.map((l) => l.slice(Number.isFinite(ind) ? ind : 0)).join('\n').replace(/\s+$/, '');
    } else out[m[2]] = tapUnquote(raw);
  }
  return out;
}

const tapName = (s) => s.replace(/\\#/g, '#').replace(/\\\\/g, '\\').trim();

/**
 * Parse node's TAP reporter output. Returns { tests, suites, pass, fail, cancelled, skipped,
 * todo, duration_ms, complete, bail, points, failures[{name, path[], location, error, failureType}] }.
 */
export function parseTap(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const points = [];
  const summary = {};
  const stack = [];
  let cur = null;
  let yaml = null;
  let plan = false;
  let bail = null;
  for (const line of lines) {
    if (yaml) {
      if (/^\s*\.\.\.\s*$/.test(line)) { cur.yaml = parseTapYaml(yaml); yaml = null; } else yaml.push(line);
      continue;
    }
    let m = /^(\s*)# Subtest: (.*)$/.exec(line);
    if (m) {
      const depth = Math.floor(m[1].length / 4);
      stack.length = depth;
      stack[depth] = tapName(m[2]);
      continue;
    }
    m = /^(\s*)(not ok|ok)\b\s*(\d+)?\s*(?:-\s*)?(.*)$/.exec(line);
    if (m) {
      const depth = Math.floor(m[1].length / 4);
      let name = m[4];
      let directive = null;
      const d = /(?:^|\s)#\s+(SKIP|TODO)\b\s*(.*)$/i.exec(name);
      if (d) { directive = { kind: d[1].toUpperCase(), reason: d[2].trim() }; name = name.slice(0, d.index); }
      cur = { depth, ok: m[2] === 'ok', num: m[3] ? Number(m[3]) : null, name: tapName(name), path: [...stack.slice(0, depth), tapName(name)], directive, yaml: null };
      points.push(cur);
      continue;
    }
    if (cur && !cur.yaml && /^\s*---\s*$/.test(line)) { yaml = []; continue; }
    m = /^# (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) ([\d.]+)\s*$/.exec(line);
    if (m) { summary[m[1]] = Number(m[2]); continue; }
    if (/^1\.\.\d+/.test(line)) plan = true;
    if (/^\s*Bail out!/.test(line)) bail = line.trim();
  }
  const failures = points
    .filter((p) => !p.ok && p.directive?.kind !== 'TODO' && p.yaml?.failureType !== 'subtestsFailed')
    .map((p) => ({ name: p.name, path: p.path, location: p.yaml?.location ? toPosix(p.yaml.location) : null,
      error: p.yaml?.error != null ? String(p.yaml.error) : null, failureType: p.yaml?.failureType || null }));
  const leaves = points.filter((p) => p.yaml?.type !== 'suite');
  const count = (f) => leaves.filter(f).length;
  return {
    tests: summary.tests ?? leaves.length,
    suites: summary.suites ?? points.length - leaves.length,
    pass: summary.pass ?? count((p) => p.ok && !p.directive),
    fail: summary.fail ?? count((p) => !p.ok && p.directive?.kind !== 'TODO'),
    cancelled: summary.cancelled ?? 0,
    skipped: summary.skipped ?? count((p) => p.directive?.kind === 'SKIP'),
    todo: summary.todo ?? count((p) => p.directive?.kind === 'TODO'),
    duration_ms: summary.duration_ms ?? null,
    complete: plan && summary.tests != null,
    bail,
    points: points.length,
    failures,
  };
}

// ---------------------------------------------------------------------------
// Unit files: async children with a per-file timeout that kills the whole process tree

const live = new Set();

function killTree(child) {
  if (!child || child.exitCode != null) return;
  try {
    if (IS_WINDOWS) run('taskkill', ['/pid', String(child.pid), '/T', '/F'], { timeoutMs: 10_000 });
    else process.kill(-child.pid, 'SIGKILL');
  } catch {
    try { child.kill('SIGKILL'); } catch {}
  }
}

function killAll() { for (const c of live) killTree(c); }

/** Run one unit file: `{ exit, signal, timedOut, stdout, stderr, ms }`. */
export function runUnitProcess(file, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let child;
    try {
      child = spawn(process.execPath, ['--test', '--test-reporter=tap', file], {
        cwd, env, windowsHide: true, detached: !IS_WINDOWS, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ exit: null, signal: null, timedOut: false, stdout: '', stderr: errText(err), ms: 0 });
      return;
    }
    live.add(child);
    const cap = 32 * 1024 * 1024;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { if (stdout.length < cap) stdout += d; });
    child.stderr.on('data', (d) => { if (stderr.length < cap) stderr += d; });
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    const done = (exit, signal, error) => {
      clearTimeout(timer);
      live.delete(child);
      // A detached group may still hold children of the runner; never leave them behind.
      if (!IS_WINDOWS) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
      resolve({ exit, signal, timedOut, stdout, stderr: error ? `${stderr}\n${error}` : stderr, ms: Date.now() - started });
    };
    child.on('error', (err) => done(null, null, errText(err)));
    child.on('close', (code, signal) => done(code, signal));
  });
}

/** Cases for one unit file run: one summary case plus one case per failing test. */
export function unitCases(rel, res, tap, timeoutS) {
  const secs = (res.ms / 1000).toFixed(1);
  const counts = `${tap.tests} test(s): ${tap.pass} pass, ${tap.fail} fail, ${tap.skipped} skipped, ${tap.todo} todo${tap.cancelled ? `, ${tap.cancelled} cancelled` : ''} (${secs} s)`;
  const cases = [];
  const file = { kind: 'unit-file', ms: res.ms, tests: tap.tests };
  if (res.timedOut) cases.push(fail(rel, `timed out after ${timeoutS} s and was killed; ${counts}`, file));
  else if (res.exit === 0 && tap.fail === 0 && tap.cancelled === 0 && tap.complete) {
    cases.push(tap.tests > 0 && tap.skipped + tap.todo >= tap.tests ? skip(rel, `every test skipped: ${counts}`, file) : pass(rel, counts, file));
  } else {
    const why = !tap.complete ? `incomplete TAP output (exit ${res.exit ?? res.signal ?? '?'}): ${firstLine(res.stderr) || firstLine(res.stdout.split('\n').slice(-5).join('\n')) || 'no output'}`
      : `exit ${res.exit ?? res.signal}`;
    cases.push(fail(rel, `${why}; ${counts}`, file));
  }
  for (const f of tap.failures.slice(0, 25)) {
    const error = String(f.error || f.failureType || 'failed').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 3).join(' | ');
    cases.push(fail(`${rel} > ${f.path.join(' > ')}`, `${error}${f.location ? ` (${f.location.replace(/^.*\/(tests\/unit\/)/, '$1')})` : ''}`, { kind: 'unit-test' }));
  }
  if (tap.failures.length > 25) cases.push(fail(`${rel} > ...`, `${tap.failures.length - 25} more failing test(s)`, { kind: 'unit-test' }));
  return cases;
}

// ---------------------------------------------------------------------------
// Markdown helpers (GitHub-flavored, enough for our own docs)

/** Text with fenced code blocks blanked (line numbers kept) and the fences returned separately. */
export function splitFences(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const prose = [];
  const fences = [];
  let open = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!open) {
      const m = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)/.exec(line);
      if (m) { open = { char: m[1][0], len: m[1].length, info: m[2].toLowerCase(), start: i + 1, body: [] }; prose.push(''); continue; }
      prose.push(line);
    } else {
      const m = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (m && m[1][0] === open.char && m[1].length >= open.len) { fences.push(open); open = null; } else open.body.push(line);
      prose.push('');
    }
  }
  if (open) fences.push({ ...open, unclosed: true });
  return { lines: prose, fences };
}

/** Inline code spans on one line: [{ start, end, run }] (end exclusive). */
function codeSpans(line) {
  const spans = [];
  const re = /(`+)/g;
  let m;
  while ((m = re.exec(line))) {
    const run1 = m[1];
    const close = line.indexOf(run1, m.index + run1.length);
    let end = close;
    // The closing run must be exactly as long as the opening one.
    while (end !== -1 && line[end + run1.length] === '`') end = line.indexOf(run1, end + run1.length + 1);
    if (end === -1) continue;
    spans.push({ start: m.index, end: end + run1.length, run: run1.length });
    re.lastIndex = end + run1.length;
  }
  return spans;
}

const maskSpans = (line) => {
  let out = line;
  for (const s of codeSpans(line)) out = out.slice(0, s.start) + ' '.repeat(s.end - s.start) + out.slice(s.end);
  return out;
};

/** ATX headings outside code: [{ level, text, line }]. */
export function markdownHeadings(text) {
  const { lines } = splitFences(text);
  const out = [];
  lines.forEach((l, i) => {
    const m = /^ {0,3}(#{1,6})\s+(.*?)\s*(?:\s#+\s*)?$/.exec(l);
    if (m && m[2]) out.push({ level: m[1].length, text: m[2], line: i + 1 });
    else if (/^ {0,3}#{1,6}\s*$/.test(l)) out.push({ level: /#+/.exec(l)[0].length, text: '', line: i + 1 });
  });
  return out;
}

/** GitHub's heading anchor: lowercase, punctuation and emoji dropped, spaces to hyphens. */
export function githubSlug(text) {
  const plain = String(text)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/[`*~]/g, '');
  return plain.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '').replace(/ /g, '-');
}

/** Anchors a Markdown file offers: heading slugs (with GitHub's -1, -2 suffixes) and HTML ids. */
export function markdownAnchors(text) {
  const anchors = new Set();
  const seen = new Map();
  for (const h of markdownHeadings(text)) {
    const base = githubSlug(h.text);
    const n = seen.get(base) || 0;
    seen.set(base, n + 1);
    anchors.add(n ? `${base}-${n}` : base);
  }
  for (const m of String(text).matchAll(/<a\s+(?:[^>]*\s)?(?:id|name)=["']([^"']+)["']/gi)) anchors.add(m[1].toLowerCase());
  return anchors;
}

const INLINE_LINK = /(!?)\[((?:[^[\]\\]|\\.|\[(?:[^[\]\\]|\\.)*\])*)\]\(\s*(<[^>\n]*>|[^\s()]*(?:\([^\s()]*\)[^\s()]*)*)(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?\s*\)/g;

/** Links outside code: [{ target, line, image, text }] (inline and reference definitions). */
export function markdownLinks(text) {
  const { lines } = splitFences(text);
  const out = [];
  lines.forEach((raw, i) => {
    const line = maskSpans(raw);
    const def = /^ {0,3}\[([^\]]+)\]:\s*(<[^>]*>|\S+)/.exec(line);
    if (def) { out.push({ target: def[2].replace(/^<|>$/g, ''), line: i + 1, image: false, text: def[1], definition: true }); return; }
    for (const m of line.matchAll(INLINE_LINK)) {
      out.push({ target: m[3].replace(/^<|>$/g, ''), line: i + 1, image: m[1] === '!', text: m[2] });
      // Badges: the image inside a link's text is a link of its own.
      for (const inner of m[2].matchAll(INLINE_LINK)) out.push({ target: inner[3].replace(/^<|>$/g, ''), line: i + 1, image: inner[1] === '!', text: inner[2] });
    }
  });
  return out;
}

/**
 * Check the relative links of one Markdown file: target exists (file or folder) and, for
 * Markdown targets, the anchor exists. `root` bounds `/`-rooted links. Returns problem strings.
 */
export function checkMarkdownLinks(file, { text = null, root = null, label = null } = {}) {
  const src = text ?? readText(file, '');
  const shown = label || toPosix(path.basename(file));
  const problems = [];
  const anchorCache = new Map();
  const anchorsOf = (abs) => {
    if (!anchorCache.has(abs)) anchorCache.set(abs, markdownAnchors(abs === file ? src : readText(abs, '')));
    return anchorCache.get(abs);
  };
  for (const l of markdownLinks(src)) {
    const t = l.target.trim();
    if (!t || /^[a-z][a-z0-9+.-]*:/i.test(t) || t.startsWith('//')) continue;
    if (t.includes('\\')) { problems.push(`${shown}:${l.line} link "${t}" uses a backslash (use forward slashes)`); continue; }
    const hash = t.indexOf('#');
    let p = hash === -1 ? t : t.slice(0, hash);
    const anchor = hash === -1 ? null : t.slice(hash + 1);
    p = p.replace(/\?.*$/, '');
    try { p = decodeURIComponent(p); } catch {}
    let abs = file;
    if (p) {
      if (p.startsWith('/')) {
        if (!root) { problems.push(`${shown}:${l.line} link "${t}" is absolute`); continue; }
        abs = path.join(root, ...p.split('/').filter(Boolean));
      } else abs = path.resolve(path.dirname(file), ...p.split('/'));
      if (!exists(abs)) { problems.push(`${shown}:${l.line} link target not found: ${t}`); continue; }
    }
    if (anchor && /\.(?:md|markdown)$/i.test(abs) && !/^L\d+/.test(anchor)) {
      let a = anchor;
      try { a = decodeURIComponent(a); } catch {}
      if (!anchorsOf(abs).has(a.toLowerCase())) problems.push(`${shown}:${l.line} anchor not found: ${t}`);
    }
  }
  return problems;
}

const MERMAID_TYPES = new Set(['flowchart', 'graph', 'sequenceDiagram', 'classDiagram', 'classDiagram-v2', 'stateDiagram', 'stateDiagram-v2',
  'erDiagram', 'journey', 'gantt', 'pie', 'quadrantChart', 'requirementDiagram', 'gitGraph', 'mindmap', 'timeline', 'zenuml',
  'sankey-beta', 'sankey', 'xychart-beta', 'xychart', 'block-beta', 'block', 'packet-beta', 'packet', 'kanban', 'architecture-beta',
  'architecture', 'radar-beta', 'treemap-beta', 'C4Context', 'C4Container', 'C4Component', 'C4Dynamic', 'C4Deployment']);

/** Problems in one Mermaid fence body: unknown diagram type, unbalanced ( [ { or quotes. */
export function checkMermaid(body) {
  const lines = (Array.isArray(body) ? body : String(body).split('\n'));
  let i = 0;
  const skipBlank = () => { while (i < lines.length && (!lines[i].trim() || /^\s*%%/.test(lines[i]))) i++; };
  skipBlank();
  if (i < lines.length && lines[i].trim() === '---') {
    i++;
    while (i < lines.length && lines[i].trim() !== '---') i++;
    i++;
    skipBlank();
  }
  if (i >= lines.length) return ['empty diagram'];
  const type = lines[i].trim().split(/[\s;:]/)[0];
  const problems = [];
  if (!MERMAID_TYPES.has(type)) problems.push(`unknown diagram type "${truncate(type, 40)}"`);
  const flow = type === 'flowchart' || type === 'graph';
  const stack = [];
  const pairs = { ')': '(', ']': '[', '}': '{' };
  for (let k = i + 1; k < lines.length; k++) {
    let l = lines[k];
    if (/^\s*%%/.test(l)) continue;
    if ((l.match(/"/g) || []).length % 2) { problems.push(`line ${k + 1}: unbalanced double quote`); continue; }
    l = l.replace(/"[^"]*"/g, '""');
    // Free text after ':' (sequence messages, task names) is not structure.
    if (!flow && !/^\s*(?:classDiagram|erDiagram)/.test(type)) l = l.replace(/:.*$/, '');
    // Asymmetric node shape `id>text]` opens with '>'.
    if (flow) l = l.replace(/(\w)>([^\]\n]*)\]/g, '$1');
    for (const c of l) {
      if (c === '(' || c === '[' || c === '{') stack.push({ c, line: k + 1 });
      else if (pairs[c]) {
        const top = stack.pop();
        if (!top || top.c !== pairs[c]) { problems.push(`line ${k + 1}: unbalanced "${c}"`); stack.length = 0; break; }
      }
    }
  }
  if (stack.length) problems.push(`line ${stack[stack.length - 1].line}: "${stack[stack.length - 1].c}" is never closed`);
  return problems;
}

// ---------------------------------------------------------------------------
// The skill tree

function gitIgnoredSet(cwd, rels, env) {
  if (!rels.length) return new Set();
  const r = run('git', ['check-ignore', '--stdin', '-z'], { cwd, env, input: rels.join('\0') + '\0', timeoutMs: 60_000 });
  if (r.exit !== 0 && r.exit !== 1) return new Set();
  return new Set(r.stdout.split('\0').filter(Boolean).map((p) => toPosix(p).replace(/\/$/, '')));
}

/** Files and folders of the skill tree as git would ship them (`.git`, `node_modules` and ignored paths left out). */
export function walkSkillTree(root, { env = process.env } = {}) {
  const all = [];
  const walk = (abs, rel, depth) => {
    if (depth > 24) return;
    let entries = [];
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (e.name === '.git' || e.name === 'node_modules') continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      const a = path.join(abs, e.name);
      if (e.isSymbolicLink()) all.push({ rel: r, abs: a, kind: 'symlink' });
      else if (e.isDirectory()) { all.push({ rel: r, abs: a, kind: 'dir' }); walk(a, r, depth + 1); }
      else if (e.isFile()) all.push({ rel: r, abs: a, kind: 'file' });
    }
  };
  walk(root, '', 0);
  const ignored = gitIgnoredSet(root, all.map((x) => (x.kind === 'dir' ? `${x.rel}/` : x.rel)), env);
  const isIgnored = (rel) => {
    const parts = rel.split('/');
    for (let k = 1; k <= parts.length; k++) if (ignored.has(parts.slice(0, k).join('/'))) return true;
    return false;
  };
  const kept = all.filter((x) => !isIgnored(x.rel));
  const files = kept.filter((x) => x.kind === 'file').map((x) => {
    let size = 0;
    try { size = fs.statSync(x.abs).size; } catch {}
    return { rel: x.rel, abs: x.abs, size };
  });
  const parentOf = (rel) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '.');
  const dirs = [{ rel: '.', abs: root, entries: 0 }, ...kept.filter((x) => x.kind === 'dir').map((x) => ({ rel: x.rel, abs: x.abs, entries: 0 }))];
  const byRel = new Map(dirs.map((d) => [d.rel, d]));
  for (const x of kept) { const d = byRel.get(parentOf(x.rel)); if (d) d.entries++; }
  return { root, files, dirs, symlinks: kept.filter((x) => x.kind === 'symlink').map((x) => x.rel), ignored: all.length - kept.length };
}

function readTextFile(abs) {
  let buf;
  try { buf = fs.readFileSync(abs); } catch { return null; }
  if (buf.subarray(0, 8000).includes(0)) return null;
  return buf.toString('utf8');
}

// ---------------------------------------------------------------------------
// Run context

function makeContext({ skillDir, env, timeoutS, external, keep }) {
  const dir = path.resolve(skillDir);
  const ownAdc = path.join(SKILL_DIR, 'scripts', 'adc.mjs');
  const targetAdc = path.join(dir, 'scripts', 'adc.mjs');
  const top = run('git', ['rev-parse', '--show-toplevel'], { cwd: dir, env: childEnv(env), timeoutMs: 30_000 });
  const devRoot = devRootOf(dir);
  const readme = path.join(devRoot, 'README.md');
  let tmpBase = null;
  const modules = new Map();
  const sx = {
    skillDir: dir,
    devRoot,
    // The repository checkout (skills/<name>/ next to tests/, evals/, README.md, CHANGELOG.md); an
    // installed copy has none of the development material, so those checks are skipped for it.
    devLayout: isDevLayout(dir),
    name: path.basename(dir),
    adc: exists(targetAdc) ? targetAdc : ownAdc,
    repoRoot: top.exit === 0 ? path.resolve(top.stdout.trim()) : null,
    readme: exists(readme) ? path.resolve(readme) : null,
    env: childEnv(env),
    timeoutS,
    external,
    keep,
    repos: [],
    tmp() {
      if (!tmpBase) tmpBase = realDir(fs.mkdtempSync(path.join(os.tmpdir(), 'adc-selftest-')));
      return tmpBase;
    },
    get tmpBase() { return tmpBase; },
    /** Import a lib module from the tree under test (else the running copy); `{ mod, error }`. */
    async lib(name) {
      if (modules.has(name)) return modules.get(name);
      const candidates = [path.join(dir, 'scripts', 'lib', name), path.join(OWN_LIB, name)];
      const file = candidates.find(exists);
      let res;
      if (!file) res = { mod: null, error: `scripts/lib/${name} is not present` };
      else {
        try { res = { mod: await import(pathToFileURL(file).href), error: null }; } catch (err) { res = { mod: null, error: `scripts/lib/${name} failed to load: ${errText(err)}` }; }
      }
      modules.set(name, res);
      return res;
    },
    libExists: (name) => exists(path.join(dir, 'scripts', 'lib', name)),
    tree: null,
  };
  sx.getTree = () => (sx.tree ||= walkSkillTree(dir, { env: sx.env }));
  return sx;
}

function cleanup(sx) {
  if (sx.keep || !sx.tmpBase) return;
  for (const repo of sx.repos) {
    for (const key of new Set([repo, realDir(repo)])) {
      try { fs.rmSync(tmpRoot(key), { recursive: true, force: true, maxRetries: 3 }); } catch {}
    }
  }
  try { fs.rmSync(sx.tmpBase, { recursive: true, force: true, maxRetries: 3 }); } catch {}
}

// ---------------------------------------------------------------------------
// Area: footprint

const PORTED_RE = /^\s*(?:\/\/+|#+|\/\*+|\*+|<!--|--|;+)\s*Ported from\b:?\s*(.*?)\s*(?:-->|\*\/)?\s*$/i;

async function areaFootprint(sx) {
  const t = sx.getTree();
  const cases = [];
  const S = sx.skillDir;

  cases.push(t.files.length <= LIMITS.files
    ? pass('file count', `${t.files.length} file(s) (limit ${LIMITS.files})`)
    : fail('file count', `${t.files.length} file(s), limit ${LIMITS.files}`));

  const largest = [...t.dirs].sort((a, b) => b.entries - a.entries)[0];
  const big = t.dirs.filter((d) => d.entries > LIMITS.folderEntries).map((d) => `${d.rel}/ has ${d.entries} entries`);
  cases.push(verdict('entries per folder', big, `largest: ${largest ? `${largest.rel}/ (${largest.entries})` : 'n/a'} (limit ${LIMITS.folderEntries})`));

  const huge = t.files.filter((f) => f.size > LIMITS.fileBytes).map((f) => `${f.rel} (${(f.size / 1048576).toFixed(1)} MB)`);
  const maxFile = [...t.files].sort((a, b) => b.size - a.size)[0];
  cases.push(verdict('file size', huge, `largest: ${maxFile ? `${maxFile.rel} (${Math.ceil(maxFile.size / 1024)} KB)` : 'n/a'} (limit 5 MB)`));

  const texts = new Map();
  const crlf = [];
  for (const f of t.files) {
    if (f.size > LIMITS.fileBytes) continue;
    const text = readTextFile(f.abs);
    if (text == null) continue;
    texts.set(f.rel, text);
    const idx = text.indexOf('\r');
    if (idx !== -1) crlf.push(`${f.rel}:${text.slice(0, idx).split('\n').length}`);
  }
  cases.push(verdict('LF line endings', crlf.map((x) => `CR in ${x}`), `${texts.size} text file(s), no CR`));
  cases.push(verdict('no symlinks', t.symlinks.map((s) => `${s} is a symlink`), 'none'));
  // The tree walk drops ignored paths; the folder listing below does not, so an ignored test
  // folder inside the skill (which `gh skill install` from a working copy would still copy) is caught too.
  let top = [];
  try { top = fs.readdirSync(S); } catch {}
  const devOnly = top.filter((n) => !SHIPPED_TOP.has(n)).map((n) => (DEV_ONLY.includes(n)
    ? `${n} is development material; keep it at the repository root` : `${n} is not one of ${[...SHIPPED_TOP].join(', ')}`));
  devOnly.push(...t.files.filter((f) => /\.test\.[cm]?[jt]s$|(?:^|\/)selftest\.m?js$/.test(f.rel)).map((f) => `${f.rel} is test code`));
  devOnly.push(...t.dirs.filter((d) => /(?:^|\/)(?:fixtures|snapshots|__tests__)$/.test(d.rel)).map((d) => `${d.rel}/ is test data`));
  cases.push(verdict('skill folder ships only consumer files', devOnly, `top level: ${top.sort().join(', ')}; no tests, fixtures, evals, changelog or notices`));

  const markers = (await sx.lib('markers.mjs')).mod;
  const credNames = [];
  for (const f of t.files) {
    const base = path.posix.basename(f.rel);
    if (/^\.env/i.test(base)) credNames.push(`${f.rel} is a .env file`);
    else if (markers?.credentialFileName && markers.credentialFileName(f.rel)) credNames.push(`${f.rel} looks like a credential file (${markers.credentialFileName(f.rel)})`);
  }
  cases.push(verdict('no .env or credential files', credNames, `none${markers ? '' : ' (.env* only: markers.mjs not available)'}`));

  const tplDir = path.join(S, 'assets', 'templates', 'adc');
  if (!exists(tplDir)) cases.push(fail('adc templates hold no values', 'assets/templates/adc/ is missing (env.live.example and budget.json are shipped there)'));
  else {
    const problems = [];
    const names = fs.readdirSync(tplDir).sort();
    for (const n of names) {
      const text = readText(path.join(tplDir, n), '');
      if (n.endsWith('.json')) {
        const j = (() => { try { return JSON.parse(text); } catch { return undefined; } })();
        if (j === undefined) { problems.push(`${n} is not valid JSON`); continue; }
        for (const k of ['sessions', 'days']) {
          if (j && k in j && (typeof j[k] !== 'object' || j[k] === null || Object.keys(j[k]).length)) problems.push(`${n}: "${k}" must ship empty`);
        }
        continue;
      }
      text.split(/\r?\n/).forEach((l, k) => {
        const m = /^\s*#?\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(l);
        if (!m) return;
        const value = m[2].replace(/\s+#.*$/, '').trim().replace(/^(["'])\1$/, '');
        if (value) problems.push(`${n}:${k + 1} ${m[1]} has a value`);
      });
    }
    if (!names.includes('env.live.example')) problems.push('env.live.example is missing');
    if (!names.includes('budget.json')) problems.push('budget.json is missing');
    cases.push(verdict('adc templates hold no values', problems, `${names.join(', ')}: empty values`));
  }

  const skillText = texts.get('SKILL.md') ?? readText(path.join(S, 'SKILL.md'));
  if (skillText == null) cases.push(fail('SKILL.md length', 'SKILL.md is missing'));
  else {
    const n = lineCount(skillText);
    cases.push(n <= LIMITS.skillLines ? pass('SKILL.md length', `${n} line(s) (limit ${LIMITS.skillLines})`) : fail('SKILL.md length', `${n} lines, limit ${LIMITS.skillLines}`));
  }

  const refDir = path.join(S, 'references');
  const refFiles = t.files.filter((f) => /^references\/[^/]+$/.test(f.rel)).map((f) => path.posix.basename(f.rel));
  const refFolders = t.dirs.filter((d) => /^references\/[^/]+$/.test(d.rel)).map((d) => path.posix.basename(d.rel));
  const refMd = refFiles.filter((n) => /\.md$/i.test(n));
  const linkedRefs = new Set();
  for (const l of skillText ? markdownLinks(skillText) : []) {
    const p = l.target.split('#')[0];
    if (/^(?:\.\/)?references\//.test(p)) linkedRefs.add(path.posix.normalize(p.replace(/^\.\//, '')));
  }
  const refProblems = [
    ...refFolders.map((n) => `references/${n}/ is a folder (references stay one level deep)`),
    ...refFiles.filter((n) => !linkedRefs.has(`references/${n}`)).map((n) => `references/${n} is not linked from SKILL.md`),
  ];
  cases.push(verdict('references linked from SKILL.md', refProblems, `${refFiles.length} reference(s), all linked; one level deep`));

  const budget = [];
  for (const n of refMd) {
    const text = texts.get(`references/${n}`) ?? readText(path.join(refDir, n), '');
    const lines = lineCount(text);
    if (lines > LIMITS.refLines) budget.push(`references/${n} has ${lines} lines (limit ${LIMITS.refLines})`);
    if (lines > LIMITS.tocOver && !hasToc(text)) budget.push(`references/${n} has ${lines} lines and no table of contents`);
  }
  cases.push(verdict('references within budget', budget, `each <= ${LIMITS.refLines} lines; a table of contents above ${LIMITS.tocOver}`));

  const linkProblems = [];
  const docs = ['SKILL.md', 'PREREQUISITES.md', ...refMd.map((n) => `references/${n}`)];
  for (const rel of docs) {
    const abs = path.join(S, ...rel.split('/'));
    if (!exists(abs)) continue;
    linkProblems.push(...checkMarkdownLinks(abs, { root: sx.repoRoot, label: rel }));
  }
  cases.push(verdict('relative links in SKILL.md and references resolve', linkProblems, `${docs.filter((d) => exists(path.join(S, ...d.split('/')))).length} file(s) checked`));

  const tokens = [];
  if (skillText) tokens.push(...substitutionTokens(skillText, { strict: true }).map((x) => `SKILL.md:${x.line} ${x.token}`));
  for (const n of refMd) {
    const text = texts.get(`references/${n}`) ?? readText(path.join(refDir, n), '');
    tokens.push(...substitutionTokens(text, { strict: false }).map((x) => `references/${n}:${x.line} ${x.token}`));
  }
  cases.push(verdict('no host substitution tokens', tokens, 'none in SKILL.md; none outside code in references'));

  const ported = [];
  for (const [rel, text] of texts) {
    if (/^THIRD_PARTY_NOTICES\.md$/i.test(rel)) continue;
    const head = text.split('\n').slice(0, 20);
    for (const l of head) {
      const m = PORTED_RE.exec(l);
      if (m) { ported.push({ rel, source: m[1] }); break; }
    }
  }
  const notices = sx.devLayout ? readText(path.join(sx.devRoot, 'THIRD_PARTY_NOTICES.md')) : null;
  const noticeProblems = [];
  if (!sx.devLayout && ported.length) {
    cases.push(skip('THIRD_PARTY_NOTICES.md covers every "Ported from" header', `${ported.length} ported file(s); not a repository checkout (the notices live at the repository root)`));
    return cases;
  }
  for (const p of ported) {
    if (notices == null) { noticeProblems.push(`${p.rel} has a "Ported from" header but THIRD_PARTY_NOTICES.md is missing`); continue; }
    if (!notices.includes(p.rel) && !notices.includes(path.posix.basename(p.rel))) noticeProblems.push(`${p.rel} is not listed in THIRD_PARTY_NOTICES.md`);
    const src = (p.source.match(/https?:\/\/[^\s)>"']+/) || [p.source.split(/\s+/)[0]])[0].replace(/[.,;]+$/, '');
    if (src && !notices.includes(src)) noticeProblems.push(`${p.rel}: source "${truncate(src, 80)}" is not named in THIRD_PARTY_NOTICES.md`);
  }
  cases.push(verdict('THIRD_PARTY_NOTICES.md covers every "Ported from" header', noticeProblems,
    ported.length ? `${ported.length} ported file(s), all listed` : `no ported code${notices == null ? ' (THIRD_PARTY_NOTICES.md not present)' : ''}`));
  return cases;
}

/** A table of contents: a "Contents"/"Table of contents" heading, or three in-page links near the top. */
export function hasToc(text) {
  if (markdownHeadings(text).some((h) => /^(?:table of )?contents\b|^toc$|^on this page$/i.test(h.text.replace(/^[^A-Za-z]+/, '')))) return true;
  const top = String(text).split('\n').slice(0, 60).join('\n');
  return (top.match(/\]\(#[^)]+\)/g) || []).length >= 3;
}

/**
 * Host substitutions (§5.3). `strict` (SKILL.md): anywhere, including `$1`-style tokens. Otherwise
 * (references, which hosts never preprocess): only outside code, so docs can name the tokens.
 */
export function substitutionTokens(text, { strict = false } = {}) {
  const out = [];
  const src = String(text ?? '');
  const lines = strict ? src.split(/\r?\n/) : splitFences(src).lines;
  lines.forEach((raw, i) => {
    const hits = new Set();
    if (strict) {
      for (const m of raw.matchAll(/!`[^`\n]+`/g)) hits.add(m[0]);
      for (const m of raw.matchAll(/\$ARGUMENTS\b|\$\{CLAUDE_SKILL_DIR\}|\$\{CLAUDE_SESSION_ID\}|\$\d+\b/g)) hits.add(m[0]);
    } else {
      for (const s of codeSpans(raw)) if (s.run === 1 && raw[s.start - 1] === '!') hits.add(raw.slice(s.start - 1, s.end));
      for (const m of maskSpans(raw).matchAll(/\$ARGUMENTS\b|\$\{CLAUDE_SKILL_DIR\}|\$\{CLAUDE_SESSION_ID\}/g)) hits.add(m[0]);
    }
    for (const token of hits) out.push({ line: i + 1, token: truncate(token, 60) });
  });
  return out;
}

// ---------------------------------------------------------------------------
// Area: frontmatter

const SPEC_KEYS = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools']);
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** Version core.skillVersion() would read from a SKILL.md (the foundation's own regex). */
function foundationVersion(text) {
  const m = /^\s+version:\s*["']?([0-9][^"'\s]*)["']?\s*$/m.exec(String(text).split(/^---\s*$/m)[1] || '');
  return m ? m[1] : null;
}

/** Candidate gh binaries (ADC_GH, every gh on PATH, side-by-side installs); the first >= 2.90 wins. */
export function findGh(env = process.env) {
  const seen = new Set();
  const found = [];
  const add = (p) => {
    if (!p || seen.has(p) || !exists(p)) return;
    seen.add(p);
    const v = toolVersion(p);
    if (v) found.push({ path: p, version: v.version });
  };
  add(env.ADC_GH);
  for (const dir of String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)) {
    for (const n of IS_WINDOWS ? ['gh.exe', 'gh.cmd'] : ['gh']) add(path.join(dir, n));
  }
  for (const p of EXTRA_GH) add(p);
  return found.find((g) => g.version && versionGte(g.version, MIN_GH)) || found[0] || null;
}

async function areaFrontmatter(sx) {
  const cases = [];
  const file = path.join(sx.skillDir, 'SKILL.md');
  const text = readText(file);
  if (text == null) return [fail('SKILL.md frontmatter', 'SKILL.md is missing')];
  const fm = (await sx.lib('frontmatter.mjs'));
  if (!fm.mod?.parseFrontmatter) cases.push(skip('skill frontmatter invariants', fm.error || 'frontmatter.mjs has no parseFrontmatter'));
  else {
    const p = [];
    const res = fm.mod.parseFrontmatter(text);
    const data = res.data || {};
    if (text.split(/\r?\n/)[0] !== '---') p.push('line 1 is not "---"');
    for (const e of res.errors || []) p.push(`YAML: ${typeof e === 'string' ? e : e.message || JSON.stringify(e)}`);
    for (const k of Object.keys(data)) if (!SPEC_KEYS.has(k)) p.push(`"${k}" is not one of the spec's six fields`);
    if ('allowed-tools' in data) p.push('allowed-tools is set (decision D8: none is shipped)');
    if (data.name !== sx.name) p.push(`name "${data.name}" does not equal the directory name "${sx.name}"`);
    if (typeof data.name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(data.name) || data.name.length > 64) p.push('name must be 1-64 lowercase letters, digits and single hyphens');
    if (typeof data.description !== 'string' || !data.description.trim()) p.push('description is missing');
    else if (data.description.length > LIMITS.descriptionChars) p.push(`description has ${data.description.length} chars (limit ${LIMITS.descriptionChars})`);
    if (data.compatibility != null && String(data.compatibility).length > LIMITS.compatibilityChars) p.push(`compatibility exceeds ${LIMITS.compatibilityChars} chars`);
    if (!data.license) p.push('license is missing');
    const md = data.metadata;
    if (!md || typeof md !== 'object' || Array.isArray(md)) p.push('metadata map is missing');
    else {
      for (const [k, v] of Object.entries(md)) if (typeof v !== 'string') p.push(`metadata.${k} is not a string (the spec maps strings to strings)`);
      if (!SEMVER.test(String(md.version ?? ''))) p.push(`metadata.version "${md.version ?? ''}" is not a semantic version`);
      const sd = md['short-description'];
      if (typeof sd !== 'string' || sd.length < 25 || sd.length > 64) p.push(`metadata.short-description must be 25-64 chars (Codex picker; got ${typeof sd === 'string' ? sd.length : 'none'})`);
      if (foundationVersion(text) !== String(md.version)) p.push(`core.skillVersion() would read "${foundationVersion(text)}" instead of "${md.version}"`);
    }
    cases.push(verdict('skill frontmatter invariants', p, `name ${data.name}, version ${md?.version}, ${Object.keys(data).length} field(s), description ${String(data.description || '').length} chars`));
  }

  const tl = await sx.lib('tooling-lint.mjs');
  if (!tl.mod?.lintSkillDir) {
    cases.push(skip('tooling lint --strict (built-in rules)', tl.error || 'tooling-lint.mjs has no lintSkillDir'));
    return cases;
  }
  const gh = sx.external ? findGh(sx.env) : null;
  const whichFn = (name, env) => (name === 'gh' ? (gh ? gh.path : null) : which(name, env));
  const versionFn = (name, ...rest) => toolVersion(name === 'gh' && gh ? gh.path : name, ...rest);
  let res;
  try {
    res = await tl.mod.lintSkillDir(sx.skillDir, { strict: true, external: sx.external, env: sx.env, which: whichFn, version: versionFn });
  } catch (err) {
    cases.push(fail('tooling lint --strict (built-in rules)', `lintSkillDir threw: ${errText(err)}`));
    return cases;
  }
  const items = [];
  for (const f of res.files || []) {
    for (const h of f.host_results || []) {
      for (const [sev, list] of [['error', h.errors || []], ['warning', h.warnings || []]]) {
        for (const x of list) if (!String(x.rule || '').startsWith('EXT-')) items.push(`${sev} ${h.host} ${x.rule}${x.line ? ` (line ${x.line})` : ''}: ${x.message}`);
      }
    }
  }
  for (const s of res.security || []) items.push(`security ${s.severity} ${s.rule} ${s.file || ''}${s.line ? `:${s.line}` : ''}: ${s.message}`);
  for (const e of res.internal_errors || []) items.push(`internal error in ${e.file}: ${e.message}`);
  cases.push(verdict('tooling lint --strict (built-in rules)', items, `no errors, warnings or security findings across ${(res.summary?.hosts || []).join(', ') || 'all hosts'}`));
  if (!sx.external) {
    cases.push(skip('external validators', 'not run (--no-external)'));
    return cases;
  }
  for (const e of res.external || []) {
    const name = `external: ${e.tool}${e.target && e.target !== '.' ? ` ${e.target}` : ''}`;
    const extra = { command: e.command };
    const detail = e.summary || '';
    if (e.status === 'pass') cases.push(pass(name, detail, extra));
    else if (e.status === 'fail') cases.push(fail(name, [detail, ...(e.findings || []).slice(0, 5).map((f) => f.message)].filter(Boolean).join('; '), extra));
    else if (e.status === 'not-applicable') cases.push(skip(name, `not applicable: ${detail}`, extra));
    else if (e.status === 'error') cases.push(skip(name, `validator error, not counted: ${detail}`, extra));
    else cases.push(skip(name, detail, extra));
  }
  if (!(res.external || []).some((e) => e.tool === 'gh skill publish')) {
    cases.push(skip('external: gh skill publish', gh ? `gh ${gh.version} at ${toPosix(gh.path)} was not run` : 'no gh on PATH'));
  }
  return cases;
}

// ---------------------------------------------------------------------------
// Area: scripts

async function areaScripts(sx) {
  const cases = [];
  const t = sx.getTree();
  const modules = t.files.filter((f) => /\.(?:mjs|cjs|js)$/.test(f.rel) && /^scripts\//.test(f.rel));
  // The repository's own test code (selftest and the unit files) at the root, when this is the repository layout.
  const devTests = path.join(sx.devRoot, 'tests');
  const devModules = !sx.devLayout || !exists(devTests) ? [] : [devTests, path.join(devTests, 'unit')].flatMap((d) => {
    try { return fs.readdirSync(d).filter((n) => /\.m?js$/.test(n)).map((n) => ({ rel: toPosix(path.relative(sx.devRoot, path.join(d, n))), abs: path.join(d, n) })); } catch { return []; }
  });
  const broken = [];
  for (const f of [...modules, ...devModules]) {
    const r = run(process.execPath, ['--check', f.abs], { cwd: sx.skillDir, env: sx.env, timeoutMs: 60_000 });
    if (r.exit !== 0) broken.push(`${f.rel}: ${firstLine(r.stderr.split('\n').filter((l) => /Error/.test(l)).join('\n') || r.stderr) || `exit ${r.exit}`}`);
  }
  cases.push(verdict('node --check', broken, `${modules.length} skill module(s) and ${devModules.length} repository test file(s) parse`));

  const adcText = readText(path.join(sx.skillDir, 'scripts', 'adc.mjs'));
  if (adcText == null) {
    cases.push(fail('adc.mjs command table', 'scripts/adc.mjs is missing'));
    return cases;
  }
  const statics = adcText.split('\n').map((l, i) => ({ l, i })).filter(({ l }) => /^\s*import\s+(?:[\w*{]|['"])/.test(l));
  cases.push(verdict('adc.mjs loads nothing before the Node version guard', statics.map(({ i }) => `static import at scripts/adc.mjs:${i + 1}`), 'no static imports; the guard runs on any Node'));

  const table = [...adcText.matchAll(/^\s*'([a-z][a-z-]*)':\s*\['([\w.-]+\.mjs)',\s*'(\w+)'\]/gm)].map((m) => ({ command: m[1], file: m[2], exportName: m[3] }));
  const problems = [];
  if (!table.length) problems.push('no COMMANDS entries found in scripts/adc.mjs');
  if (table.some((c) => c.command === 'selftest')) problems.push('adc.mjs has a selftest command (selftest is development tooling: node tests/selftest.mjs)');
  for (const c of table) {
    if (!exists(path.join(sx.skillDir, 'scripts', 'lib', c.file))) { problems.push(`${c.command}: scripts/lib/${c.file} is missing`); continue; }
    const { mod, error } = await sx.lib(c.file);
    if (!mod) problems.push(`${c.command}: ${error}`);
    else if (typeof mod[c.exportName] !== 'function') problems.push(`${c.command}: ${c.file} does not export ${c.exportName}()`);
  }
  cases.push(verdict('adc.mjs command table', problems, `${table.length} command(s) resolve to an exported handler`));

  const skillText = readText(path.join(sx.skillDir, 'SKILL.md'), '');
  const want = foundationVersion(skillText);
  const v = adc(sx, ['version'], { cwd: sx.skillDir });
  const h = adc(sx, ['help'], { cwd: sx.skillDir });
  const vp = [];
  if (v.exit !== 0 || v.stdout.trim() !== want) vp.push(`"adc.mjs version" printed "${truncate(v.stdout.trim(), 40)}" (exit ${v.exit}), SKILL.md says "${want}"`);
  if (h.exit !== 0) vp.push(`"adc.mjs help" exited ${h.exit}`);
  for (const c of table) if (!h.stdout.includes(c.command)) vp.push(`help does not mention "${c.command}"`);
  if (/\bselftest\b/.test(h.stdout)) vp.push('help mentions selftest, which the shipped skill does not have');
  const u = adc(sx, ['no-such-command'], { cwd: sx.skillDir });
  if (u.exit !== EXIT.USAGE) vp.push(`an unknown command exited ${u.exit} (expected ${EXIT.USAGE})`);
  cases.push(verdict('adc.mjs version, help and usage exit', vp, `version ${want}; help lists every command; unknown command exits 2`));

  const shims = t.files.filter((f) => /^scripts\//.test(f.rel) && /\.(?:sh|ps1|cmd|bat|bash|zsh)$/i.test(f.rel)).map((f) => `${f.rel} is a shell shim`);
  const shebangs = modules.filter((f) => /^scripts\//.test(f.rel) && (readTextFile(f.abs) || '').startsWith('#!')).map((f) => `${f.rel} starts with a shebang`);
  cases.push(verdict('scripts are launched as node <file>', [...shims, ...shebangs], 'no shell shims, no shebangs'));
  return cases;
}

// ---------------------------------------------------------------------------
// Area: prereqs

const normCell = (s) => String(s ?? '').replace(/\\\|/g, '|').replace(/\s+/g, ' ').trim();
const normMin = (s) => { const v = normCell(s); return ['', '\u2014', '\u2013', '-', 'n/a', 'none'].includes(v.toLowerCase()) ? '' : v; };

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') { cur += '\\|'; i++; continue; }
    if (s[i] === '|') { cells.push(cur); cur = ''; continue; }
    cur += s[i];
  }
  cells.push(cur);
  return cells.map(normCell);
}

/** Rows of every table in PREREQUISITES.md with the category and group their section implies. */
export function parsePrereqTables(md) {
  const { lines } = splitFences(md);
  const rows = [];
  let section = '';
  let group = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let m = /^##\s+(.*)$/.exec(l);
    if (m) { section = m[1].trim(); group = null; continue; }
    m = /^###\s+(.*)$/.exec(l);
    if (m) { group = m[1].trim(); continue; }
    if (!/^\s*\|/.test(l) || !/^\s*\|?\s*:?-{3,}/.test(lines[i + 1] || '')) continue;
    const header = splitRow(l).map((h) => h.toLowerCase());
    i += 2;
    const col = (re) => header.findIndex((h) => re.test(h));
    const ci = { name: 0, minimum: col(/^minimum/), needed: col(/needed for|used for|unlocks/), fallback: col(/fallback|without/) };
    const category = /required/i.test(section) ? 'required' : /host/i.test(section) || /^host$/.test(header[0]) ? 'host'
      : /optional|windows/i.test(section) ? 'optional' : 'other';
    const grp = category === 'required' ? 'Core' : category === 'host' ? 'Host minimums' : /windows/i.test(section) ? 'Windows' : group;
    for (; i < lines.length && /^\s*\|/.test(lines[i]); i++) {
      const c = splitRow(lines[i]);
      rows.push({ name: c[ci.name], minimum: ci.minimum >= 0 ? c[ci.minimum] : '', needed_for: ci.needed >= 0 ? c[ci.needed] : '',
        fallback: ci.fallback >= 0 ? c[ci.fallback] : '', category, group: grp, section, line: i + 1 });
    }
    i--;
  }
  return rows;
}

async function areaPrereqs(sx) {
  const cases = [];
  const jsonFile = path.join(sx.skillDir, 'assets', 'prerequisites.json');
  const mdFile = path.join(sx.skillDir, 'PREREQUISITES.md');
  const json = readJson(jsonFile);
  const md = readText(mdFile);
  if (!json || !Array.isArray(json.items)) cases.push(fail('assets/prerequisites.json parses', exists(jsonFile) ? 'not valid JSON or no "items" array' : 'missing'));
  if (md == null) cases.push(fail('PREREQUISITES.md present', 'missing'));
  if (cases.length) return cases;

  const items = json.items;
  const p0 = [];
  const ids = new Set();
  for (const it of items) {
    if (!it.id) p0.push(`an item has no id (${it.name || '?'})`);
    else if (ids.has(it.id)) p0.push(`duplicate id "${it.id}"`);
    ids.add(it.id);
    if (!['required', 'optional', 'host'].includes(it.category)) p0.push(`${it.id}: category "${it.category}" is not required, optional or host`);
    if (it.check && Array.isArray(it.tools) && !it.tools.includes(it.check.cmd)) p0.push(`${it.id}: check.cmd "${it.check.cmd}" is not in tools[]`);
  }
  if (json.doc && json.doc !== 'PREREQUISITES.md') p0.push(`"doc" names ${json.doc}`);
  cases.push(verdict('prerequisites.json is well-formed', p0, `${items.length} item(s), unique ids`));

  const rows = parsePrereqTables(md).filter((r) => r.category !== 'other');
  const key = (s) => normCell(s).toLowerCase();
  const byName = new Map();
  const dupRows = [];
  for (const r of rows) { if (byName.has(key(r.name))) dupRows.push(`"${r.name}" appears twice in PREREQUISITES.md`); byName.set(key(r.name), r); }
  const jsonNames = new Set(items.map((it) => key(it.name)));
  const missingInMd = items.filter((it) => !byName.has(key(it.name))).map((it) => `${it.id} ("${it.name}") has no row in PREREQUISITES.md`);
  const missingInJson = rows.filter((r) => !jsonNames.has(key(r.name))).map((r) => `PREREQUISITES.md:${r.line} "${r.name}" is not in prerequisites.json`);
  cases.push(verdict('same items in both files', [...missingInMd, ...missingInJson, ...dupRows], `${rows.length} table row(s) = ${items.length} item(s)`));

  const diffs = [];
  for (const it of items) {
    const r = byName.get(key(it.name));
    if (!r) continue;
    const where = `${it.id} (PREREQUISITES.md:${r.line})`;
    if (r.category !== it.category) diffs.push(`${where}: category ${it.category} vs table section "${r.section}"`);
    if (it.category === 'optional' && r.group && it.group && r.group !== it.group) diffs.push(`${where}: group "${it.group}" vs "${r.group}"`);
    if (normMin(it.minimum) !== normMin(r.minimum)) diffs.push(`${where}: minimum "${it.minimum ?? ''}" vs "${r.minimum}"`);
    const fb = it.category === 'required' ? it.without : it.fallback;
    if (normCell(fb) !== normCell(r.fallback)) diffs.push(`${where}: ${it.category === 'required' ? 'without' : 'fallback'} text differs`);
    if (normCell(it.needed_for) !== normCell(r.needed_for)) diffs.push(`${where}: needed_for text differs`);
  }
  cases.push(verdict('category, minimum, needed-for and fallback agree', diffs, 'every row matches its item'));

  const noFallback = items.filter((it) => (it.category === 'optional' || it.category === 'host') && !normCell(it.fallback)).map((it) => `${it.id} has no fallback`);
  const noWithout = items.filter((it) => it.category === 'required' && !normCell(it.without)).map((it) => `${it.id} does not say what happens without it`);
  cases.push(verdict('every optional item has a fallback', [...noFallback, ...noWithout], 'all present'));

  const doc = await sx.lib('doctor.mjs');
  if (!Array.isArray(doc.mod?.PROBED_TOOLS)) cases.push(skip('every doctor probe has an entry', doc.error || 'doctor.mjs exports no PROBED_TOOLS'));
  else {
    const missing = doc.mod.PROBED_TOOLS.filter((id) => !ids.has(id)).map((id) => `doctor probes "${id}" but prerequisites.json has no such item`);
    cases.push(verdict('every doctor probe has an entry', missing, `${doc.mod.PROBED_TOOLS.length} probed id(s) present`));
  }
  const n = lineCount(md);
  cases.push(n < LIMITS.prereqLines ? pass('PREREQUISITES.md length', `${n} line(s) (under ${LIMITS.prereqLines})`) : fail('PREREQUISITES.md length', `${n} lines (keep it under ${LIMITS.prereqLines})`));
  return cases;
}

// ---------------------------------------------------------------------------
// Area: readme

/** The §12 sections after the title, in order. */
export const README_SECTIONS = Object.freeze([
  ['What it is', /\bwhat it is\b/i], ['Features', /\bfeatures\b/i], ['Works with', /\bworks with\b/i], ['Install', /\binstall/i],
  ['Use', /^\W*use\b/i], ['Hooks (optional)', /\bhooks\b/i], ['The .adc/ directory', /\.adc\b.*\bdirectory\b|\bdirectory\b.*\.adc\b/i],
  ['Evidence ledger', /\bevidence ledger\b/i], ['Testing the skill itself', /\btesting\b/i], ['Using it at work', /\bat work\b/i],
  ['Security & privacy', /\bsecurity\b/i], ['Roadmap / Changelog / License', /\broadmap\b|\bchangelog\b/i],
]);

const LOCAL_PATH = /(?:^|[\s("'`=<])((?:\/(?:home|Users)\/[^/\s"'`)<>]+\/[^\s"'`)<>]*)|\/root\/[^\s"'`)<>]+|\/(?:private\/)?var\/folders\/[^\s"'`)<>]+|\/mnt\/[a-z]\/Users\/[^\s"'`)<>]+|[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/][^\s"'`)<>]+|file:\/\/\/[^\s"'`)<>]+)/;

/** README checks (§12): returns cases. `file` is the README path, `root` the repository root. */
export function checkReadme(file, { root = path.dirname(file), skillName = SKILL_NAME } = {}) {
  const text = readText(file, '');
  const cases = [];
  const heads = markdownHeadings(text);
  const p1 = [];
  if (!heads.length || heads[0].level !== 1) p1.push('the first heading is not the H1 title');
  const h2 = heads.filter((h) => h.level === 2);
  const firstH2 = h2.length ? h2[0].line : Infinity;
  const intro = text.split('\n').slice(heads[0]?.line || 0, firstH2 - 1).join('\n');
  if (!/^\s*[^\s#[!].{10,}/m.test(intro)) p1.push('no tagline after the title');
  if (!/\[!\[[^\]]*licen[sc]e/i.test(intro)) p1.push('no license badge before the first section');
  if (!/\[!\[[^\]]*(?:tag|release|version)/i.test(intro)) p1.push('no latest-tag badge before the first section');
  if (!/agent ?skills/i.test(intro)) p1.push('no "Agent Skills spec" link before the first section');
  const emoji = /^\s*\p{Extended_Pictographic}/u;
  if (heads[0] && !emoji.test(heads[0].text)) p1.push('the title has no emoji');
  const order = [];
  const want = README_SECTIONS;
  // Each H2 takes the first unused §12 section it matches; then order, gaps and extras are reported.
  const used = new Set();
  const mapped = h2.map((h) => {
    const k = want.findIndex((w, i) => !used.has(i) && w[1].test(h.text));
    if (k >= 0) used.add(k);
    return { h, k };
  });
  let last = -1;
  for (const { h, k } of mapped) {
    if (k < 0) order.push(`line ${h.line}: unexpected section "${truncate(h.text, 60)}"`);
    else if (k < last) order.push(`line ${h.line}: "${truncate(h.text, 60)}" is out of order (§12 puts "${want[k][0]}" before "${want[last][0]}")`);
    else last = k;
    if (!emoji.test(h.text)) order.push(`line ${h.line}: "${truncate(h.text, 40)}" has no emoji`);
  }
  want.forEach((w, i) => { if (!used.has(i)) order.push(`missing section "${w[0]}"`); });
  cases.push(verdict('title, tagline and badges', p1, 'H1 with emoji, tagline, license / tag / spec badges'));
  cases.push(verdict('the 12 sections in order', order, `${h2.length} sections in the §12 order, each with an emoji`));

  const linkProblems = checkMarkdownLinks(file, { text, root, label: 'README.md' });
  const prereq = markdownLinks(text).some((l) => new RegExp(`(?:^|/)skills/${skillName}/PREREQUISITES\\.md(?:#|$)`).test(l.target));
  if (!prereq) linkProblems.push(`README.md does not link skills/${skillName}/PREREQUISITES.md`);
  const binaryImages = markdownLinks(text).filter((l) => l.image && !/^[a-z][a-z0-9+.-]*:/i.test(l.target)).map((l) => `README.md:${l.line} image "${l.target}" is a file in the repository (no binary assets at the root)`);
  cases.push(verdict('relative links resolve', [...linkProblems, ...binaryImages], `${markdownLinks(text).length} link(s); PREREQUISITES.md linked`));

  const { fences } = splitFences(text);
  const mermaid = fences.filter((f) => f.info === 'mermaid');
  const mp = [];
  if (mermaid.length < 2) mp.push(`${mermaid.length} Mermaid diagram(s); §12 asks for two`);
  for (const f of mermaid) {
    if (f.unclosed) mp.push(`line ${f.start}: unclosed fence`);
    for (const p of checkMermaid(f.body)) mp.push(`fence at line ${f.start}: ${p.replace(/^line (\d+)/, (_, n) => `line ${f.start + Number(n)}`)}`);
  }
  const unclosed = fences.filter((f) => f.unclosed && f.info !== 'mermaid').map((f) => `line ${f.start}: unclosed code fence`);
  cases.push(verdict('Mermaid fences parse', [...mp, ...unclosed], `${mermaid.length} diagram(s) with a known type and balanced brackets`));

  const abs = [];
  text.split('\n').forEach((l, i) => { const m = LOCAL_PATH.exec(l); if (m) abs.push(`line ${i + 1}: ${truncate(m[1], 80)}`); });
  cases.push(verdict('no absolute local paths', abs, 'none'));
  return cases;
}

async function areaReadme(sx) {
  if (!sx.devLayout) return [skip('README.md', 'not a repository checkout (installed copies carry no README.md)')];
  if (!sx.readme) return [fail('README.md', `${toPosix(path.join(sx.devRoot, 'README.md'))} is missing`)];
  return checkReadme(sx.readme, { root: path.dirname(sx.readme), skillName: sx.name });
}

// ---------------------------------------------------------------------------
// Area: release

const VERSION_IN = /v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/;

/** Top CHANGELOG.md entry: { version, line, unreleased } or null. */
export function changelogTop(text) {
  let unreleased = false;
  for (const h of markdownHeadings(text)) {
    if (h.level !== 2) continue;
    if (/unreleased/i.test(h.text)) { unreleased = true; continue; }
    const m = VERSION_IN.exec(h.text);
    if (m) return { version: m[1], line: h.line, unreleased };
  }
  return null;
}

const cmpVersion = (a, b) => { const x = parseVersion(a); const y = parseVersion(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };

async function areaRelease(sx) {
  const cases = [];
  const skillText = readText(path.join(sx.skillDir, 'SKILL.md'), '');
  const fm = await sx.lib('frontmatter.mjs');
  let version = null;
  if (fm.mod?.parseFrontmatter) version = fm.mod.parseFrontmatter(skillText).data?.metadata?.version ?? null;
  version = version != null ? String(version) : foundationVersion(skillText);
  if (!version) return [fail('metadata.version', 'SKILL.md has no metadata.version')];

  const changelog = sx.devLayout ? readText(path.join(sx.devRoot, 'CHANGELOG.md')) : null;
  if (!sx.devLayout) cases.push(skip('CHANGELOG.md top entry = metadata.version', 'not a repository checkout (CHANGELOG.md lives at the repository root)'));
  else if (changelog == null) cases.push(fail('CHANGELOG.md top entry = metadata.version', 'CHANGELOG.md is missing at the repository root'));
  else {
    const top = changelogTop(changelog);
    if (!top) cases.push(fail('CHANGELOG.md top entry = metadata.version', 'no "## [x.y.z]" entry'));
    else if (top.version !== version) cases.push(fail('CHANGELOG.md top entry = metadata.version', `CHANGELOG.md:${top.line} is ${top.version}, metadata.version is ${version}`));
    else cases.push(pass('CHANGELOG.md top entry = metadata.version', `${version}${top.unreleased ? ' (an Unreleased section sits above it)' : ''}`));
  }

  const rel = sx.repoRoot ? toPosix(path.relative(sx.repoRoot, sx.skillDir)) : null;
  if (!sx.repoRoot) cases.push(skip('git tag = metadata.version', 'the skill is not inside a Git repository'));
  else if (rel !== `skills/${sx.name}`) cases.push(skip('git tag = metadata.version', `the skill sits at ${rel || '.'} inside another repository; its tags are not the skill's`));
  else {
    const semverTags = (out) => out.split(/\r?\n/).map((t) => t.trim()).filter((t) => /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(t));
    const at = git(sx, sx.repoRoot, ['tag', '--points-at', 'HEAD']);
    const all = git(sx, sx.repoRoot, ['tag', '--list']);
    const atHead = at.exit === 0 ? semverTags(at.stdout) : [];
    const tags = all.exit === 0 ? semverTags(all.stdout).sort((a, b) => cmpVersion(a.replace(/^v/, ''), b.replace(/^v/, ''))) : [];
    if (atHead.length) {
      const wrong = atHead.filter((t) => t.replace(/^v/, '') !== version);
      cases.push(wrong.length ? fail('git tag = metadata.version', `HEAD is tagged ${wrong.join(', ')} but metadata.version is ${version}`)
        : pass('git tag = metadata.version', `HEAD is tagged ${atHead.join(', ')}`));
    } else if (!tags.length) cases.push(pass('git tag = metadata.version', `no release tag yet (metadata.version ${version})`));
    else {
      const latest = tags[tags.length - 1];
      const c = cmpVersion(latest.replace(/^v/, ''), version);
      if (c > 0) cases.push(fail('git tag = metadata.version', `metadata.version ${version} is behind the latest tag ${latest}`));
      else cases.push(pass('git tag = metadata.version', c === 0 ? `${latest} exists (HEAD is past it)` : `HEAD is untagged; ${version} is newer than the latest tag ${latest}`));
    }
  }

  if (sx.readme) {
    const m = /\bVersion\s+v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/.exec(readText(sx.readme, ''));
    if (m) cases.push(m[1] === version ? pass('README version line', `README says ${m[1]}`) : fail('README version line', `README says ${m[1]}, metadata.version is ${version}`));
  }
  return cases;
}

// ---------------------------------------------------------------------------
// Area: evals

async function areaEvals(sx) {
  const cases = [];
  const dir = path.join(sx.devRoot, 'evals');
  const S = toPosix(sx.skillDir);
  const adcPath = toPosix(sx.adc);
  const repo = sx.devLayout ? toPosix(sx.devRoot) : '<repo>';
  const set = `${repo}/evals/trigger-set.json`;
  // `claude plugin eval` reads cases only inside its target and the repository root is not a
  // plugin, so tests/run-evals.mjs evaluates a temp copy of the skill with evals/ inside it.
  const paid = [
    `node "${repo}/tests/run-evals.mjs"`,
    `node "${adcPath}" tooling trigger-set "${S}" --set "${set}" --host claude --run --runs 3 --max-cost-usd 10`,
    `node "${adcPath}" tooling trigger-set "${S}" --set "${set}" --host copilot --run --runs 3`,
  ];
  if (!sx.devLayout) {
    cases.push(skip('evals/ present', 'not a repository checkout (evals/ lives at the repository root)'));
    cases.push(skip('paid evals (manual)', `never run by selftest; run by hand from a checkout: ${paid.join(' ; ')}`, { commands: paid }));
    return cases;
  }
  if (!exists(dir)) {
    cases.push(fail('evals/ present', 'evals/ is missing (the skill\'s own trigger set and eval cases live there)'));
    cases.push(skip('paid evals (manual)', `never run by selftest; run by hand: ${paid.join(' ; ')}`, { commands: paid }));
    return cases;
  }
  const evalFiles = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) walk(path.join(d, e.name)); else evalFiles.push(e.name); } };
  walk(dir);
  cases.push(evalFiles.length <= LIMITS.evalFiles ? pass('evals/ file count', `${evalFiles.length} file(s) (limit ${LIMITS.evalFiles})`)
    : fail('evals/ file count', `${evalFiles.length} files, limit ${LIMITS.evalFiles}`));
  if (exists(path.join(dir, 'results'))) cases.push(fail('no eval results in the tree', 'evals/results/ exists; pass --output-dir outside the repository'));

  const setFile = path.join(dir, 'trigger-set.json');
  const tooling = await sx.lib('tooling.mjs');
  if (!exists(setFile)) cases.push(fail('trigger set', 'evals/trigger-set.json is missing'));
  else {
    const p = [];
    const notes = [];
    const doc = readJson(setFile);
    if (!doc) p.push('not valid JSON');
    else {
      if (doc.skill && doc.skill !== sx.name) p.push(`"skill" is "${doc.skill}", not "${sx.name}"`);
      if (tooling.mod?.loadTriggerSet) {
        try {
          const ts = tooling.mod.loadTriggerSet(setFile);
          if (ts.todo.length) p.push(`TODO placeholders in ${ts.todo.join(', ')}`);
          notes.push(...ts.warnings);
          notes.unshift(`${ts.queries.length} queries (${ts.queries.filter((q) => q.should_trigger).length} should trigger)`);
        } catch (err) { p.push(errText(err)); }
      } else {
        const qs = Array.isArray(doc) ? doc : doc.queries;
        if (!Array.isArray(qs) || !qs.length) p.push('no queries');
        else {
          const bad = qs.filter((q) => !q || typeof q.query !== 'string' || !q.query.trim() || typeof q.should_trigger !== 'boolean');
          if (bad.length) p.push(`${bad.length} malformed quer(ies)`);
          if (!qs.some((q) => q?.should_trigger === true) || !qs.some((q) => q?.should_trigger === false)) p.push('needs both should-trigger and should-not queries');
          notes.push(`${qs.length} queries (tooling.mjs not available: structural check only)`);
        }
      }
    }
    cases.push(verdict('trigger set', p, notes.join('; ')));
  }

  const fm = (await sx.lib('frontmatter.mjs')).mod;
  const caseDirs = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name !== 'results');
  const cp = [];
  for (const e of caseDirs) {
    const base = path.join(dir, e.name);
    const prompt = readText(path.join(base, 'prompt.md'));
    if (prompt == null && !exists(path.join(base, 'case.yaml'))) { cp.push(`evals/${e.name}: no prompt.md (or case.yaml)`); continue; }
    if (prompt != null && fm?.parseFrontmatter) {
      const r = fm.parseFrontmatter(prompt);
      if (!r.hasFrontmatter) cp.push(`evals/${e.name}/prompt.md has no frontmatter`);
      else if ((r.errors || []).length) cp.push(`evals/${e.name}/prompt.md: ${r.errors.map((x) => x.message || x).join('; ')}`);
      if (!String(r.body || '').trim()) cp.push(`evals/${e.name}/prompt.md has no prompt text`);
    }
    const gdir = path.join(base, 'graders');
    const graders = exists(gdir) ? fs.readdirSync(gdir).filter((n) => /\.md$/i.test(n)) : [];
    if (!graders.length && prompt != null) cp.push(`evals/${e.name}: no graders/*.md`);
    for (const g of graders) {
      const gt = readText(path.join(gdir, g), '');
      const r = fm?.parseFrontmatter ? fm.parseFrontmatter(gt) : null;
      if (r && (!r.hasFrontmatter || !r.data?.type)) cp.push(`evals/${e.name}/graders/${g} has no "type" in its frontmatter`);
    }
  }
  cases.push(caseDirs.length ? verdict('eval cases', cp, `${caseDirs.length} case(s): ${caseDirs.map((e) => e.name).join(', ')}`)
    : fail('eval cases', 'no eval case folder (prompt.md + graders/*.md) under evals/'));
  cases.push(skip('paid evals (manual)', `never run by selftest (they bill your account); run by hand: ${paid.join(' ; ')}`, { commands: paid }));
  return cases;
}

// ---------------------------------------------------------------------------
// Area: hooks (direct checks; hooks.test.mjs covers every dialect fixture)

function claudePayload(event, repo, over = {}) {
  const base = { session_id: 'adc-selftest', cwd: repo, permission_mode: 'default' };
  const readme = path.join(repo, 'README.md');
  const by = {
    'session-start': { hook_event_name: 'SessionStart', source: 'startup' },
    'post-edit': { hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: readme, content: 'hello\n' }, tool_response: { filePath: readme, success: true } },
    'post-shell': { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'git status' }, tool_response: { stdout: '', stderr: '', interrupted: false, isImage: false } },
    'stop': { hook_event_name: 'Stop', stop_hook_active: false },
    'pre-guard': { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: readme } },
    'session-end': { hook_event_name: 'SessionEnd', reason: 'exit' },
  };
  return JSON.stringify({ ...base, ...(by[event] || {}), ...over });
}

function oneJsonObject(stdout) {
  const s = String(stdout || '');
  const lines = s.split('\n').filter((l) => l.trim());
  if (lines.length !== 1) return { ok: false, why: `${lines.length} output line(s)` };
  if (!isAscii(s)) return { ok: false, why: 'non-ASCII bytes on stdout' };
  const v = parseJsonOut(s);
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, why: `not one JSON object: ${truncate(s.trim(), 80)}` };
  return { ok: true, value: v };
}

async function hookEvents(sx) {
  const d = await sx.lib('hook-dialects.mjs');
  return Array.isArray(d.mod?.HOOK_EVENTS) && d.mod.HOOK_EVENTS.length ? [...d.mod.HOOK_EVENTS] : FALLBACK_EVENTS;
}

const OLD_NODE = "data:text/javascript,Object.defineProperty(process.versions,'node',{value:'18.19.0'})";

async function areaHooks(sx) {
  const cases = [];
  const events = await hookEvents(sx);
  const outside = path.join(sx.tmp(), 'no-repo');
  fs.mkdirSync(outside, { recursive: true });
  const inRepo = git(sx, outside, ['rev-parse', '--is-inside-work-tree']).stdout.trim() === 'true';
  if (inRepo) cases.push(skip('malformed payloads print {} and exit 0', `the OS temp dir ${toPosix(os.tmpdir())} is inside a Git work tree`));
  else {
    const p = [];
    for (const ev of events) {
      for (const [label, input] of [['empty', ''], ['not-json', 'not-json'], ['{}', '{}']]) {
        const r = adc(sx, ['hook-run', ev], { cwd: outside, input, timeoutMs: 15_000 });
        if (r.exit !== 0 || r.stdout.trim() !== '{}' || !isAscii(r.stdout)) p.push(`${ev} <${label}>: exit ${r.exit}, stdout ${truncate(r.stdout.trim(), 60) || '(none)'}`);
      }
    }
    cases.push(verdict('malformed payloads print {} and exit 0', p, `${events.length} event(s) x empty / not-json / {}`));
  }

  const oldHook = adc(sx, ['hook-run', 'session-start'], { cwd: outside, input: claudePayload('session-start', outside), nodeArgs: ['--import', OLD_NODE] });
  if (/Cannot redefine|Cannot assign/i.test(oldHook.stderr)) cases.push(skip('Node older than 24: hooks print {}, commands exit 3', 'this runtime cannot simulate an older process.versions.node'));
  else {
    const oldCli = adc(sx, ['detect', '--json', '--cwd', outside], { cwd: outside, nodeArgs: ['--import', OLD_NODE] });
    const p = [];
    if (oldHook.exit !== 0 || oldHook.stdout.trim() !== '{}') p.push(`hook-run: exit ${oldHook.exit}, stdout ${truncate(oldHook.stdout.trim(), 60)}`);
    if (oldCli.exit !== EXIT.ENV || !/Node\.js 24\+/.test(oldCli.stderr)) p.push(`detect: exit ${oldCli.exit} (expected 3 with a "Node.js 24+" message)`);
    cases.push(verdict('Node older than 24: hooks print {}, commands exit 3', p, 'simulated Node 18.19.0: hook {} exit 0; CLI exit 3'));
  }

  if (!sx.libExists('hook-run.mjs')) {
    cases.push(skip('non-ASCII payload yields ASCII-only JSON', 'scripts/lib/hook-run.mjs is not present'));
    cases.push(skip('session-start latency (uncached)', 'scripts/lib/hook-run.mjs is not present'));
    return cases;
  }
  const uni = makeRepo(sx, 'hooks-unicode-\u00fc\u65e5', { 'README.md': 'x\n' });
  const file = path.join(uni, 'tests', '\u00fc-\u65e5\u672c.test.js');
  const payload = claudePayload('post-edit', uni, { tool_input: { file_path: file, content: "it.only('\u00fc works', () => {})\n" }, tool_response: { filePath: file, success: true } });
  const r = adc(sx, ['hook-run', 'post-edit', '--dialect', 'claude'], { cwd: uni, input: payload });
  const o = oneJsonObject(r.stdout);
  const text = o.ok ? JSON.stringify(o.value) : '';
  if (r.exit !== 0 || !o.ok) cases.push(fail('non-ASCII payload yields ASCII-only JSON', `exit ${r.exit}; ${o.why || ''}`));
  else if (!text.normalize('NFC').includes('\u00fc')) cases.push(fail('non-ASCII payload yields ASCII-only JSON', `the decision does not name the edited file: ${truncate(text, 120)}`));
  else cases.push(pass('non-ASCII payload yields ASCII-only JSON', 'post-edit on tests/\\u00fc-\\u65e5\\u672c.test.js: \\uXXXX escapes, file named in the warning'));

  const base = [];
  for (let k = 0; k < 3; k++) base.push(run(process.execPath, ['-e', '0'], { env: sx.env }).ms);
  const times = [];
  let bad = null;
  for (let k = 0; k < 3; k++) {
    const repo = makeRepo(sx, `hooks-latency-${k}`, { 'package.json': '{"name":"x","scripts":{"test":"node --test"}}\n' });
    const res = adc(sx, ['hook-run', 'session-start', '--dialect', 'claude'], { cwd: repo, input: claudePayload('session-start', repo) });
    const chk = oneJsonObject(res.stdout);
    if (res.exit !== 0 || !chk.ok) bad = `exit ${res.exit}; ${chk.why || ''}`;
    times.push(res.ms);
  }
  const best = Math.min(...times);
  const handler = Math.max(0, best - Math.min(...base));
  const detail = `best of 3: ${best} ms wall, ~${handler} ms over a bare node start (target 500 ms, budget 2000 ms)`;
  if (bad) cases.push(fail('session-start latency (uncached)', bad));
  else cases.push(handler <= 500 && best <= 2000 ? pass('session-start latency (uncached)', detail) : fail('session-start latency (uncached)', detail));
  return cases;
}

// ---------------------------------------------------------------------------
// Area: adc (§13 `.adc/` handling)

/** CLI commands that act on a repository's state dir; each must exit 3 while `.adc/` is tracked. */
export const STATE_COMMANDS = Object.freeze([
  ['detect'], ['diff-scope'], ['deps-check', '--offline'], ['typecheck'], ['clean-run', '--no-install'], ['coverage-delta'],
  ['mutation-scope'], ['flake-probe'], ['evidence', 'status'], ['trace', '--spec', 'spec.md'], ['verify', '--quick'],
  ['live', 'run', '--dry-run'], ['budget', 'show'], ['tooling', 'lint', '.'], ['scaffold', 'regress', '--dry-run'], ['doctor', '--no-probes'],
]);

const notBuilt = (r) => /internal error: .*(?:Cannot find module|ERR_MODULE_NOT_FOUND)/s.test(r.stderr) || /NOT_IMPLEMENTED/.test(r.stdout);

async function areaAdc(sx) {
  const cases = [];
  const budgetFile = path.join(sx.skillDir, 'assets', 'templates', 'adc', 'budget.json');
  const b = readJson(budgetFile);
  if (!b) cases.push(fail('budget.json template caps', 'assets/templates/adc/budget.json is missing or not JSON'));
  else {
    const p = [];
    if (b.max_per_session !== 2500) p.push(`max_per_session is ${b.max_per_session}, expected 2500`);
    if (!(typeof b.warn_at === 'number' && b.warn_at < b.max_per_session)) p.push(`warn_at ${b.warn_at} is not below max_per_session`);
    if (b.max_per_day != null && b.max_per_day !== 2500) p.push(`max_per_day is ${b.max_per_day}, expected 2500`);
    cases.push(verdict('budget.json template caps', p, `max_per_session ${b.max_per_session}, max_per_day ${b.max_per_day}, warn_at ${b.warn_at}`));
  }

  // A tracked state dir: every state-touching command refuses, every hook stays silent.
  const tracked = makeRepo(sx, 'adc-tracked', { 'README.md': 'x\n', 'spec.md': '- The tool must work.\n', '.adc/detect.json': '{}\n' });
  const statusBefore = git(sx, tracked, ['status', '--porcelain']).stdout;
  const refused = [];
  const unbuilt = [];
  const wrong = [];
  for (const args of STATE_COMMANDS) {
    const r = adc(sx, [...args, '--json', '--cwd', tracked], { cwd: tracked, timeoutMs: 120_000 });
    const label = args.filter((a) => !a.startsWith('--') && a !== 'spec.md' && a !== '.').join(' ');
    const out = parseJsonOut(r.stdout);
    if (notBuilt(r)) { unbuilt.push(label); continue; }
    if (args[0] === 'doctor') {
      if (r.exit !== EXIT.ENV || !out || out.error) wrong.push(`doctor: exit ${r.exit}${out?.error ? ` (${out.error.code})` : ''}; expected 3 with the report still printed`);
      else refused.push(label);
      continue;
    }
    if (r.exit !== EXIT.ENV) wrong.push(`${label}: exit ${r.exit}${out?.error ? ` (${out.error.code})` : ''}`);
    else if (out?.error && out.error.code !== 'STATE_TRACKED') wrong.push(`${label}: exit 3 but code ${out.error.code}`);
    else refused.push(label);
  }
  const statusAfter = git(sx, tracked, ['status', '--porcelain']).stdout;
  if (statusAfter !== statusBefore) wrong.push('git status changed while the commands refused');
  const tail = unbuilt.length ? `; not built yet: ${unbuilt.join(', ')}` : '';
  if (!refused.length && !wrong.length) cases.push(skip('tracked .adc/: every state command exits 3', `no command module present${tail}`));
  else cases.push(wrong.length ? fail('tracked .adc/: every state command exits 3', `${listDetail(wrong)}${tail}`)
    : pass('tracked .adc/: every state command exits 3', `${refused.length} command(s) refused${tail}`));

  const events = await hookEvents(sx);
  const before = snapshotDir(path.join(tracked, '.adc'));
  const hp = [];
  for (const ev of ['session-start', ...events.filter((e) => e !== 'session-start')]) {
    const r = adc(sx, ['hook-run', ev, '--dialect', 'claude', '--level', 'guard'], { cwd: tracked, input: claudePayload(ev, tracked) });
    const o = oneJsonObject(r.stdout);
    if (r.exit !== 0 || !o.ok) { hp.push(`${ev}: exit ${r.exit}; ${o.why || ''}`); continue; }
    const s = JSON.stringify(o.value);
    if (ev !== 'session-start' && s !== '{}') hp.push(`${ev}: printed ${truncate(s, 80)} (expected {})`);
    if (/"(?:deny|block)"/.test(s)) hp.push(`${ev}: blocked a harmless call`);
  }
  const after = snapshotDir(path.join(tracked, '.adc'));
  if (JSON.stringify(before) !== JSON.stringify(after)) hp.push('a hook wrote into the tracked .adc/');
  if (git(sx, tracked, ['status', '--porcelain']).stdout !== statusBefore) hp.push('git status changed after the hooks ran');
  cases.push(verdict('tracked .adc/: hooks print one JSON object, exit 0, write nothing', hp, `${events.length} event(s): exit 0, {} outside the session brief, .adc/ untouched`));

  // Snapshot exclusion without an exclude entry.
  try {
    const repo = makeRepo(sx, 'adc-snapshot', { 'a.txt': 'a\n' });
    writeFiles(repo, { '.adc/evidence/x.json': '{}\n', '.adc/.env.live': 'x\n', 'b.txt': 'b\n' });
    const st0 = git(sx, repo, ['status', '--porcelain']).stdout;
    const snap = createSnapshot(repo, { exclude: ['.adc'] });
    const files = lsTree(repo, snap.tree);
    const p = [];
    if (files.some((f) => f === '.adc' || f.startsWith('.adc/'))) p.push(`the snapshot tree contains ${files.filter((f) => f.startsWith('.adc')).join(', ')}`);
    if (!files.includes('b.txt')) p.push('the untracked b.txt is missing from the snapshot');
    if (git(sx, repo, ['status', '--porcelain']).stdout !== st0) p.push('the snapshot changed git status (the real index was touched)');
    cases.push(verdict('snapshot never contains .adc/ (no exclude entry)', p, `tree ${snap.tree.slice(0, 12)}: ${files.length} file(s), no .adc/`));
  } catch (err) { cases.push(fail('snapshot never contains .adc/ (no exclude entry)', errText(err))); }

  // Exclude entry from a linked worktree and inside a submodule (state.mjs and the hooks).
  const excludeCase = (name, run1) => {
    try { cases.push(run1()); } catch (err) { cases.push(fail(name, errText(err))); }
  };
  const ignoredIn = (dir, rel) => git(sx, dir, ['check-ignore', '-q', '--', rel]).exit === 0;
  excludeCase('linked worktree: .adc/ excluded via the common git dir', () => {
    const name = 'linked worktree: .adc/ excluded via the common git dir';
    const main = makeRepo(sx, 'adc-wt-main', { 'a.txt': 'a\n' });
    const wt = path.join(sx.tmp(), 'adc-wt-linked');
    gitOk(sx, main, ['worktree', 'add', '-q', '-b', 'selftest-wt', wt]);
    const wtReal = realDir(wt);
    sx.repos.push(wtReal);
    const info = prepareStateDir({ cwd: wtReal, stateDirOption: path.join(wtReal, '.adc') });
    fs.writeFileSync(path.join(info.dir, 'probe.json'), '{}\n');
    const p = [];
    if (!info.exclude?.ok) p.push(`exclude entry not written: ${info.exclude?.error || '?'}`);
    if (!ignoredIn(wtReal, '.adc/probe.json')) p.push('.adc/probe.json is not ignored in the linked worktree');
    if (git(sx, wtReal, ['status', '--porcelain']).stdout.includes('.adc')) p.push('git status in the worktree lists .adc/');
    const wt2 = path.join(sx.tmp(), 'adc-wt-hook');
    gitOk(sx, main, ['worktree', 'add', '-q', '-b', 'selftest-wt2', wt2]);
    const wt2Real = realDir(wt2);
    sx.repos.push(wt2Real);
    if (sx.libExists('hook-run.mjs')) {
      const r = adc(sx, ['hook-run', 'post-edit', '--dialect', 'claude'], { cwd: wt2Real, input: claudePayload('post-edit', wt2Real) });
      if (r.exit !== 0) p.push(`hook-run post-edit in a linked worktree exited ${r.exit}`);
      if (exists(path.join(wt2Real, '.adc')) && git(sx, wt2Real, ['status', '--porcelain']).stdout.includes('.adc')) p.push('after a hook, git status in the worktree lists .adc/');
    }
    return verdict(name, p, `exclude file ${toPosix(path.relative(sx.tmp(), info.exclude.excludeFile || ''))}; CLI state dir and hook state dir both ignored`);
  });
  excludeCase('submodule: .adc/ excluded via the submodule git dir', () => {
    const name = 'submodule: .adc/ excluded via the submodule git dir';
    const lib = makeRepo(sx, 'adc-sub-lib', { 'lib.txt': 'l\n' });
    const sup = makeRepo(sx, 'adc-sub-super', { 'a.txt': 'a\n' });
    gitOk(sx, sup, ['submodule', 'add', '-q', lib, 'sub']);
    gitOk(sx, sup, ['commit', '-q', '-m', 'sub']);
    const sub = realDir(path.join(sup, 'sub'));
    sx.repos.push(sub);
    const info = prepareStateDir({ cwd: sub, stateDirOption: path.join(sub, '.adc') });
    fs.writeFileSync(path.join(info.dir, 'probe.json'), '{}\n');
    const p = [];
    if (!info.exclude?.ok) p.push(`exclude entry not written: ${info.exclude?.error || '?'}`);
    if (!ignoredIn(sub, '.adc/probe.json')) p.push('.adc/probe.json is not ignored inside the submodule');
    if (git(sx, sub, ['status', '--porcelain']).stdout.includes('.adc')) p.push('git status in the submodule lists .adc/');
    if (git(sx, sup, ['status', '--porcelain']).stdout.trim()) p.push('the superproject sees the submodule as modified');
    return verdict(name, p, 'entry written to the submodule\'s own info/exclude');
  });
  excludeCase('.gitignore negation: .env.live is never materialized', () => {
    const name = '.gitignore negation: .env.live is never materialized';
    const repo = makeRepo(sx, 'adc-negation', { '.gitignore': '!/.adc/\n!/.adc/**\n', 'a.txt': 'a\n' });
    const info = prepareStateDir({ cwd: repo, stateDirOption: path.join(repo, '.adc') });
    const res = materializeTemplates(info);
    const p = [];
    if (res.envLive.created || exists(path.join(repo, '.adc', '.env.live'))) p.push('.env.live was created although .gitignore un-ignores .adc/');
    if (!res.envLive.reason) p.push('no reason given for refusing .env.live');
    return verdict(name, p, `refused: ${truncate(res.envLive.reason || '', 120)}`);
  });

  // --credits-override needs a real terminal.
  if (!sx.libExists('live.mjs')) cases.push(skip('--credits-override without a terminal exits 2', 'scripts/lib/live.mjs is not present'));
  else {
    const repo = makeRepo(sx, 'adc-credits', { 'a.txt': 'a\n' });
    const r = adc(sx, ['live', 'run', '--credits-override', '100', '--json', '--cwd', repo], { cwd: repo });
    cases.push(r.exit === EXIT.USAGE ? pass('--credits-override without a terminal exits 2', firstLine(parseJsonOut(r.stdout)?.error?.message || r.stderr))
      : fail('--credits-override without a terminal exits 2', `exit ${r.exit}: ${truncate(r.stdout.trim() || r.stderr.trim(), 160)}`));
  }

  cases.push(...leakChecks(sx));
  return cases;
}

/** Leak matrix subset (§13): a token in .adc/.env.live and another in the environment never surface. */
function leakChecks(sx) {
  const cases = [];
  const fileToken = ['hunter2', 'abc', nonce().slice(0, 8)].join('');
  const envToken = ['s3cond', 'Val', nonce().slice(0, 8)].join('');
  const leaks = (s) => [fileToken, envToken].filter((t) => String(s ?? '').includes(t)).map((t) => (t === fileToken ? 'the .env.live token' : 'the environment token'));
  const repo = makeRepo(sx, 'adc-leak', { 'src/app.js': 'export const a = 1;\n', 'README.md': 'x\n' });
  const info = prepareStateDir({ cwd: repo, stateDirOption: path.join(repo, '.adc') });
  materializeTemplates(info, { envLive: false });
  fs.writeFileSync(path.join(info.dir, '.env.live'), ['ADC_LIVE_TOKEN', fileToken].join('=') + '\n', { mode: 0o600 });
  writeFiles(repo, { 'src/app.js': 'export const a = 2;\n', 'src/new.js': 'export const b = 1;\n' });
  const env = { ADC_LIVE_TOKEN: envToken };
  const statusBefore = git(sx, repo, ['status', '--porcelain']).stdout;

  const ds = sx.libExists('diff-scope.mjs') ? adc(sx, ['diff-scope', '--json', '--cwd', repo], { cwd: repo, env }) : null;
  if (!ds || notBuilt(ds)) cases.push(skip('token absent from diff-scope output and the snapshot tree', 'diff-scope is not built yet'));
  else {
    const p = leaks(ds.stdout + ds.stderr).map((w) => `${w} appears in the diff-scope output`);
    const tree = parseJsonOut(ds.stdout)?.tree_digest;
    if (!tree) p.push(`no tree_digest in the output (exit ${ds.exit})`);
    else {
      const files = lsTree(repo, tree);
      if (files.some((f) => f.startsWith('.adc'))) p.push('the snapshot tree contains .adc/');
      const grep = git(sx, repo, ['grep', '-q', '-F', '-e', fileToken, '-e', envToken, tree]);
      if (grep.exit === 0) p.push('a token is in the snapshot tree');
    }
    cases.push(verdict('token absent from diff-scope output and the snapshot tree', p, `tree ${String(tree).slice(0, 12)}: no .adc/, no token`));
  }

  const dr = sx.libExists('doctor.mjs') ? adc(sx, ['doctor', '--json', '--no-probes', '--cwd', repo], { cwd: repo, env }) : null;
  if (!dr || notBuilt(dr)) cases.push(skip('token absent from doctor output', 'doctor is not built yet'));
  else {
    const out = parseJsonOut(dr.stdout);
    const p = leaks(dr.stdout + dr.stderr).map((w) => `${w} appears in doctor --json`);
    if (!out || out.error) p.push(`doctor printed no report (exit ${dr.exit})`);
    cases.push(verdict('token absent from doctor output', p, 'credential reported as set/unset only'));
  }

  if (!sx.libExists('hook-run.mjs')) cases.push(skip('token absent from hook output and hooks.log', 'scripts/lib/hook-run.mjs is not present'));
  else {
    const p = [];
    const hookEnv = { ...env, ADC_DEBUG: '1' };
    const outputs = [];
    outputs.push(adc(sx, ['hook-run', 'session-start', '--dialect', 'claude'], { cwd: repo, input: claudePayload('session-start', repo), env: hookEnv }));
    const resp = { stdout: `token ${fileToken} and ${envToken}\n2 passed`, stderr: envToken, interrupted: false, isImage: false };
    outputs.push(adc(sx, ['hook-run', 'post-shell', '--dialect', 'claude'], { cwd: repo, input: claudePayload('post-shell', repo, { tool_input: { command: 'npm test' }, tool_response: resp }), env: hookEnv }));
    outputs.push(adc(sx, ['hook-run', 'post-shell', '--dialect', 'copilot'], { cwd: repo, env: hookEnv,
      input: JSON.stringify({ sessionId: 'adc-selftest-cp', timestamp: Date.now(), cwd: repo, toolName: 'bash', toolArgs: { command: 'npm test' }, toolResult: { resultType: 'success', textResultForLlm: resp.stdout } }) }));
    for (const r of outputs) {
      // A Copilot `modifiedResult` hands the tool's own output back to the model; only the rest is the hook's.
      const o = parseJsonOut(r.stdout);
      const own = o && typeof o === 'object' ? JSON.stringify({ ...o, modifiedResult: undefined }) : r.stdout;
      p.push(...leaks(own + r.stderr).map((w) => `${w} appears in a hook's own output`));
    }
    const state = snapshotDir(info.dir);
    for (const [rel, b64] of Object.entries(state)) {
      if (rel === '.env.live') continue;
      p.push(...leaks(Buffer.from(b64, 'base64').toString('utf8')).map((w) => `${w} written to .adc/${rel}`));
    }
    cases.push(verdict('token absent from hook output and hooks.log', p, `${outputs.length} hook run(s) with ADC_DEBUG=1; .adc/ files clean`));
  }

  const vr = sx.libExists('verify.mjs') ? adc(sx, ['verify', '--quick', '--json', '--cwd', repo], { cwd: repo, env, timeoutMs: 300_000 }) : null;
  if (!vr || notBuilt(vr)) cases.push(skip('verify: git status unchanged, token absent from ledger and metrics', 'verify is not built yet'));
  else {
    const p = leaks(vr.stdout + vr.stderr).map((w) => `${w} appears in verify output`);
    const out = parseJsonOut(vr.stdout);
    if (!out || out.error) p.push(`verify produced no ledger (exit ${vr.exit}: ${truncate(out?.error?.message || vr.stderr.trim(), 120)})`);
    const statusAfter = git(sx, repo, ['status', '--porcelain']).stdout;
    if (statusAfter !== statusBefore) p.push(`git status --porcelain changed: ${JSON.stringify(statusBefore)} -> ${JSON.stringify(statusAfter)}`);
    for (const [rel, b64] of Object.entries(snapshotDir(info.dir))) {
      if (rel === '.env.live') continue;
      p.push(...leaks(Buffer.from(b64, 'base64').toString('utf8')).map((w) => `${w} written to .adc/${rel}`));
    }
    for (const [rel, b64] of Object.entries(snapshotDir(repo, { skip: ['.git', '.adc'] }))) {
      p.push(...leaks(Buffer.from(b64, 'base64').toString('utf8')).map((w) => `${w} written to ${rel}`));
    }
    cases.push(verdict('verify: git status unchanged, token absent from ledger and metrics', p, `verdict ${out?.verdict || '?'}; status byte-identical; ledger, Markdown and metrics clean`));
  }
  return cases;
}

// ---------------------------------------------------------------------------
// Area: diffs (direct part: the committed tree holds no secret-shaped literal)

async function areaDiffs(sx) {
  const cases = [];
  // In the repository layout the committed tree is the whole repository: the skill plus the
  // development material at the root (tests and fixtures, evals, README, changelog).
  const scope = sx.devLayout ? walkSkillTree(sx.devRoot, { env: sx.env }) : sx.getTree();
  const where = sx.devLayout ? 'the repository' : 'the skill tree';
  const name = `no secret-shaped literal in ${where}`;
  const markers = await sx.lib('markers.mjs');
  if (!markers.mod?.scanSecrets) cases.push(skip(name, markers.error || 'markers.mjs has no scanSecrets'));
  else {
    const hits = [];
    let scanned = 0;
    for (const f of scope.files) {
      if (f.size > LIMITS.fileBytes) continue;
      const text = readTextFile(f.abs);
      if (text == null) continue;
      scanned++;
      for (const h of markers.mod.scanSecrets(text)) hits.push(`${f.rel}:${h.line} ${h.id} (${h.severity}): ${truncate(h.redacted, 100)}`);
    }
    cases.push(verdict(name, hits, `${scanned} text file(s) in ${where} scanned with the built-in patterns`));
  }
  const gl = which('gitleaks', sx.env);
  if (!gl) cases.push(skip('gitleaks finds nothing', 'gitleaks is not on PATH'));
  else {
    // One run per top-level path, so `.git/` and ignored state never reach the scanner.
    const roots = sx.devLayout ? [sx.skillDir, ...DEV_ONLY.map((n) => path.join(sx.devRoot, n))].filter(exists) : [sx.skillDir];
    const leaks = [];
    const errors = [];
    for (const [k, src] of roots.entries()) {
      const report = path.join(sx.tmp(), `gitleaks-${k}.json`);
      const common = ['--redact', '--no-banner', '--exit-code', '1', '--report-format', 'json', '--report-path', report];
      let r = run(gl, ['dir', src, ...common], { env: sx.env, timeoutMs: 300_000 });
      if (r.exit !== 0 && r.exit !== 1) r = run(gl, ['detect', '--no-git', '--source', src, ...common], { env: sx.env, timeoutMs: 300_000 });
      if (r.exit === 1) {
        const found = readJson(report, []);
        leaks.push(...(Array.isArray(found) && found.length ? found.map((x) => `${toPosix(x.File || '')}:${x.StartLine} ${x.RuleID}`) : [`${toPosix(src)}: leaks reported`]));
      } else if (r.exit !== 0) errors.push(`${toPosix(src)}: exit ${r.exit} ${firstLine(r.stderr)}`);
    }
    const cmd = `gitleaks dir <path> --redact (${roots.map((p) => toPosix(path.relative(sx.devRoot, p)) || '.').join(', ')})`;
    if (leaks.length) cases.push(fail('gitleaks finds nothing', listDetail(leaks), { command: cmd }));
    else if (errors.length) cases.push(skip('gitleaks finds nothing', `gitleaks failed: ${listDetail(errors)}`, { command: cmd }));
    else cases.push(pass('gitleaks finds nothing', `no leaks in ${roots.length} path(s)`, { command: cmd }));
  }
  return cases;
}

const DIRECT = { footprint: areaFootprint, frontmatter: areaFrontmatter, scripts: areaScripts, prereqs: areaPrereqs, readme: areaReadme,
  release: areaRelease, evals: areaEvals, hooks: areaHooks, adc: areaAdc, diffs: areaDiffs };

// ---------------------------------------------------------------------------
// Runner

/** Parse `--only a,b` into area names (throws a usage error for an unknown one). */
export function resolveAreas(only) {
  const all = Object.keys(AREAS);
  if (only == null || only === '' || (Array.isArray(only) && !only.length)) return all;
  const list = (Array.isArray(only) ? only : String(only).split(',')).map((s) => s.trim()).filter(Boolean);
  if (list.includes('all')) return all;
  const unknown = list.filter((a) => !all.includes(a));
  if (unknown.length) throw usageError(`unknown selftest area(s): ${unknown.join(', ')} (expected ${all.join(', ')})`);
  return all.filter((a) => list.includes(a));
}

/** Unit files per selected area, with every unit file no area claims added to `scripts`. */
function unitPlan(sx, areas) {
  const dir = path.join(sx.devRoot, 'tests', 'unit');
  const present = exists(dir) ? fs.readdirSync(dir).filter((n) => /\.test\.m?js$/.test(n)).sort() : [];
  const claimed = new Set(Object.values(UNIT_FILES).flat());
  const plan = [];
  for (const area of areas) {
    const files = [...(UNIT_FILES[area] || [])];
    if (area === 'scripts') files.push(...present.filter((n) => !claimed.has(n)));
    for (const n of files) plan.push({ area, rel: `tests/unit/${n}`, abs: path.join(dir, n), present: present.includes(n) });
  }
  return plan;
}

async function runUnits(sx, plan, { jobs, units, progress }) {
  const results = new Map();
  const todo = [];
  for (const u of plan) {
    if (!units) results.set(u.rel, [skip(u.rel, 'unit files not run (--skip-units)', { kind: 'unit-file' })]);
    else if (!u.present && !sx.devLayout) results.set(u.rel, [skip(u.rel, 'not a repository checkout (unit files live in tests/unit/)', { kind: 'unit-file' })]);
    else if (!u.present) results.set(u.rel, [fail(u.rel, `${u.rel} is missing`, { kind: 'unit-file' })]);
    else todo.push(u);
  }
  const onSignal = () => { killAll(); process.exit(130); };
  if (todo.length) { process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal); }
  try {
    let next = 0;
    const worker = async () => {
      while (next < todo.length) {
        const u = todo[next++];
        const res = await runUnitProcess(u.abs, { cwd: sx.devRoot, env: sx.env, timeoutMs: sx.timeoutS * 1000 });
        const tap = parseTap(res.stdout);
        const cs = unitCases(u.rel, res, tap, sx.timeoutS);
        results.set(u.rel, cs);
        progress?.(`${u.area}: ${u.rel} ${cs[0].status} (${cs[0].detail})`);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(jobs, todo.length || 1)) }, worker));
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    killAll();
  }
  return results;
}

/**
 * Run the selected areas against a skill tree (default: this one). Returns `{ schema, skill_dir,
 * version, passed, failed, skipped, unit_tests, areas[], cases[{area, kind, name, status, detail}] }`;
 * the counts are cases: a direct check, a unit file's summary, or one failing unit test each.
 */
export async function selftest({ skillDir = SKILL_DIR, only = null, timeoutS = DEFAULT_TIMEOUT_S, jobs = 1, external = true,
  units = true, keep = false, env = process.env, progress = null } = {}) {
  const areas = resolveAreas(only);
  const started = Date.now();
  if (!exists(path.join(skillDir, 'SKILL.md'))) throw usageError(`no SKILL.md in ${toPosix(skillDir)}`);
  const sx = makeContext({ skillDir, env, timeoutS, external, keep });
  const byArea = new Map(areas.map((a) => [a, { direct: [], units: [], ms: 0 }]));
  try {
    for (const area of areas) {
      if (!DIRECT[area]) continue;
      const t0 = Date.now();
      let cs;
      try { cs = await DIRECT[area](sx); } catch (err) { cs = [fail(`${area} checks`, `internal error: ${errText(err)}`)]; }
      byArea.get(area).direct = cs;
      byArea.get(area).ms += Date.now() - t0;
      const f = cs.filter((c) => c.status === 'fail').length;
      progress?.(`${area}: ${cs.length - f - cs.filter((c) => c.status === 'skipped').length} pass, ${f} fail, ${cs.filter((c) => c.status === 'skipped').length} skipped (${Date.now() - t0} ms)`);
    }
    const plan = unitPlan(sx, areas);
    const unitResults = await runUnits(sx, plan, { jobs, units, progress });
    for (const u of plan) {
      const a = byArea.get(u.area);
      const cs = unitResults.get(u.rel) || [];
      a.units.push(...cs);
      a.ms += cs.reduce((s, c) => s + (c.ms || 0), 0);
    }
  } finally {
    cleanup(sx);
  }
  const cases = [];
  const areaRows = [];
  for (const area of areas) {
    const a = byArea.get(area);
    const cs = [...a.direct.map((c) => ({ kind: 'check', ...c })), ...a.units].map((c) => ({ area, ...c }));
    cases.push(...cs);
    const n = (s) => cs.filter((c) => c.status === s).length;
    areaRows.push({ area, status: n('fail') ? 'fail' : n('pass') ? 'pass' : 'skipped', passed: n('pass'), failed: n('fail'), skipped: n('skipped'), ms: a.ms });
  }
  const count = (s) => cases.filter((c) => c.status === s).length;
  const unitFiles = cases.filter((c) => c.kind === 'unit-file' && c.status !== 'skipped');
  if (keep && sx.tmpBase) progress?.(`temp repositories kept in ${toPosix(sx.tmpBase)}`);
  return {
    schema: 'adc-selftest/1',
    ...(keep && sx.tmpBase ? { kept_dir: toPosix(sx.tmpBase) } : {}),
    skill_dir: toPosix(sx.skillDir),
    version: foundationVersion(readText(path.join(sx.skillDir, 'SKILL.md'), '')),
    node: process.versions.node,
    platform: `${process.platform}-${process.arch}`,
    started_at: new Date(started).toISOString(),
    finished_at: nowIso(),
    duration_ms: Date.now() - started,
    passed: count('pass'),
    failed: count('fail'),
    skipped: count('skipped'),
    unit_tests: { files: unitFiles.length, tests: unitFiles.reduce((n, c) => n + (c.tests || 0), 0),
      failing: cases.filter((c) => c.kind === 'unit-test').length },
    areas: areaRows,
    cases,
  };
}

/** What a run would do, without running anything (`--list` / `--dry-run`). */
export function selftestPlan({ skillDir = SKILL_DIR, only = null } = {}) {
  const areas = resolveAreas(only);
  const sx = { skillDir: path.resolve(skillDir), devRoot: devRootOf(path.resolve(skillDir)) };
  const plan = unitPlan(sx, areas);
  return {
    skill_dir: toPosix(sx.skillDir),
    areas: areas.map((a) => ({ area: a, covers: AREAS[a], direct: Boolean(DIRECT[a]),
      unit_files: plan.filter((u) => u.area === a).map((u) => ({ file: u.rel, present: u.present })) })),
  };
}

function renderHuman(res) {
  const lines = [];
  for (const a of res.areas) {
    lines.push(`${a.status.toUpperCase().padEnd(7)} ${a.area.padEnd(11)} ${a.passed} pass, ${a.failed} fail, ${a.skipped} skipped (${(a.ms / 1000).toFixed(1)} s)`);
    for (const c of res.cases.filter((x) => x.area === a.area && x.status !== 'pass')) {
      lines.push(`  ${c.status === 'fail' ? 'FAIL' : 'skip'}  ${c.name}: ${c.detail}`);
    }
  }
  lines.push(`selftest: ${res.passed} passed, ${res.failed} failed, ${res.skipped} skipped in ${(res.duration_ms / 1000).toFixed(1)} s (${res.skill_dir}, Node ${res.node}, ${res.platform})`);
  return lines.join('\n');
}

const USAGE = [
  'node tests/selftest.mjs [--only area,area] [--list] [--jobs n] [--timeout s] [--skip-units] [--no-external] [--keep] [--skill-dir dir] [--quiet] [--json]',
  '',
  `Areas: ${Object.keys(AREAS).join(', ')}.`,
  'Unit-file areas run `node --test --test-reporter=tap tests/unit/<file>`; the other checks read the',
  'skill folder and the repository root. Paid evals are printed, never run. Exit 1 on any failure.',
  '  --only        comma-separated areas (default: all)',
  '  --list        print the plan without running anything (also --dry-run)',
  '  --jobs        unit files run in parallel (default 1: timing checks stay meaningful)',
  `  --timeout     seconds per unit file before it is killed (default ${DEFAULT_TIMEOUT_S})`,
  '  --skip-units  direct checks only',
  '  --no-external do not run skills-ref, claude plugin validate or gh skill publish',
  '  --keep        keep the temp repositories (path printed on stderr)',
  '  --skill-dir   test another copy of the skill (default: this one); an installed copy skips the',
  '                checks of root material (README, CHANGELOG, evals, unit files)',
].join('\n');

export const selftestCommand = defineCommand({
  name: 'selftest',
  usage: USAGE,
  positionals: false,
  options: {
    only: { type: 'string' }, list: { type: 'boolean' }, jobs: { type: 'string' }, timeout: { type: 'string' },
    'skip-units': { type: 'boolean' }, 'no-external': { type: 'boolean' }, keep: { type: 'boolean' },
    'skill-dir': { type: 'string' }, quiet: { type: 'boolean' },
  },
  run: async (ctx, values) => {
    const skillDir = values['skill-dir'] ? path.resolve(ctx.cwd, values['skill-dir']) : SKILL_DIR;
    const int = (v, name, min, max, dflt) => {
      if (v == null) return dflt;
      const n = Number(v);
      if (!Number.isInteger(n) || n < min || n > max) throw usageError(`--${name} must be an integer from ${min} to ${max}`);
      return n;
    };
    const jobs = int(values.jobs, 'jobs', 1, 16, 1);
    const timeoutS = int(values.timeout, 'timeout', 1, 86_400, DEFAULT_TIMEOUT_S);
    if (values.list || ctx.dryRun) {
      const plan = selftestPlan({ skillDir, only: values.only });
      const human = plan.areas.map((a) => `${a.area.padEnd(11)} ${a.covers}${a.unit_files.length ? `\n${' '.repeat(12)}${a.unit_files.map((u) => `${u.file}${u.present ? '' : ' (missing)'}`).join(', ')}` : ''}`).join('\n');
      return { result: plan, exit: EXIT.OK, human, summary: `${plan.areas.length} area(s) planned, nothing run` };
    }
    const progress = values.quiet ? null : (msg) => process.stderr.write(`selftest: ${msg}\n`);
    const res = await selftest({ skillDir, only: values.only, timeoutS, jobs, external: !values['no-external'], units: !values['skip-units'],
      keep: Boolean(values.keep), progress });
    return {
      result: res,
      exit: res.failed ? EXIT.FINDINGS : EXIT.OK,
      human: renderHuman(res),
      summary: `${res.passed} passed, ${res.failed} failed, ${res.skipped} skipped (${res.areas.length} area(s), ${(res.duration_ms / 1000).toFixed(1)} s)`,
    };
  },
});

// Standalone entry: `node tests/selftest.mjs [options]` (the shipped adc.mjs has no selftest command).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { dispatch } = await import('../skills/agentic-developer-companion/scripts/lib/core.mjs');
  process.exitCode = await dispatch('selftest', process.argv.slice(2), async () => ({ selftestCommand }), 'selftestCommand');
}
