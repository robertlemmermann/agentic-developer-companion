// Test-report and coverage parsers: JUnit XML (Surefire, pytest, Vitest, Playwright, nextest,
// node --test), Jest/Vitest JSON, `go test -json`, `cargo test` text, TRX, RSpec JSON; LCOV,
// Cobertura, Istanbul and Go cover profiles; runner summary lines in console output.
// Imports only core.mjs: the post-shell hook loads parseSummaryText from here.

import path from 'node:path';
import { stripBom, toPosix } from './core.mjs';

export const REPORT_FORMATS = Object.freeze(['junit', 'jest-json', 'go-test-json', 'cargo-text', 'trx', 'rspec-json']);
export const COVERAGE_FORMATS = Object.freeze(['lcov', 'cobertura', 'istanbul', 'istanbul-summary', 'go-cover']);

const TEXT_CAP = 32 * 1024;
const MESSAGE_CAP = 300;

// ---------------------------------------------------------------------------
// Minimal XML reader (elements, attributes, text, CDATA; comments, PIs and DOCTYPE skipped)

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export function decodeEntities(s) {
  if (!s || s.indexOf('&') === -1) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e] ?? m;
  });
}

const TOKEN_RE = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>[]*(?:\[[\s\S]*?\])?\s*>|<\/([^\s>]+)\s*>|<([^\s/>!?]+)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/g;
const ATTR_RE = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

const localName = (n) => { const i = n.indexOf(':'); return i === -1 ? n : n.slice(i + 1); };

/** Parse XML into `{ name, attrs, children, text }` nodes. Throws when no element is found. */
export function parseXml(input) {
  const text = stripBom(String(input ?? ''));
  const root = { name: '#document', attrs: {}, children: [], text: '' };
  const stack = [root];
  const addText = (s) => {
    const top = stack[stack.length - 1];
    if (top === root || !s) return;
    if (top.text.length < TEXT_CAP) top.text += s.slice(0, TEXT_CAP - top.text.length);
  };
  let last = 0;
  TOKEN_RE.lastIndex = 0;
  for (let m = TOKEN_RE.exec(text); m; m = TOKEN_RE.exec(text)) {
    if (m.index > last) addText(decodeEntities(text.slice(last, m.index)));
    last = TOKEN_RE.lastIndex;
    if (m[1] !== undefined) addText(m[1]);
    else if (m[2] !== undefined) {
      const name = localName(m[2]);
      // Tolerate mismatched closers: pop to the nearest matching element if there is one.
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].name === name) { stack.length = i; break; }
      }
    } else if (m[3] !== undefined) {
      const attrs = {};
      const raw = m[4] || '';
      ATTR_RE.lastIndex = 0;
      for (let a = ATTR_RE.exec(raw); a; a = ATTR_RE.exec(raw)) {
        attrs[localName(a[1])] = decodeEntities(a[2] ?? a[3] ?? a[4] ?? '');
      }
      const node = { name: localName(m[3]), attrs, children: [], text: '' };
      stack[stack.length - 1].children.push(node);
      if (!m[5]) stack.push(node);
    }
  }
  if (last < text.length) addText(decodeEntities(text.slice(last)));
  const top = root.children.find((c) => c.name);
  if (!top) throw new Error('not an XML document');
  return top;
}

const kids = (node, name) => node.children.filter((c) => c.name === name);
const kid = (node, name) => node.children.find((c) => c.name === name) || null;

function* walk(node, name) {
  for (const c of node.children) {
    if (c.name === name) yield c;
    yield* walk(c, name);
  }
}

// ---------------------------------------------------------------------------
// Shared helpers

const firstLine = (s) => String(s || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';
const shortMessage = (s) => {
  const line = firstLine(s);
  return line.length > MESSAGE_CAP ? line.slice(0, MESSAGE_CAP - 3) + '...' : line;
};

/** Normalize a path from a report: file:// URLs, backslashes, `./`, absolute paths under `root`. */
export function normalizeReportPath(p, opts = {}) {
  if (p == null || p === '') return null;
  let s = String(p).trim();
  if (/^file:\/\//i.test(s)) {
    try { s = decodeURIComponent(new URL(s).pathname); } catch { s = s.replace(/^file:\/\//i, ''); }
    if (/^\/[A-Za-z]:\//.test(s)) s = s.slice(1);
  }
  s = toPosix(s);
  for (const r of rootVariants(opts.root)) {
    if (s === r) return '.';
    if (s.startsWith(r + '/')) { s = s.slice(r.length + 1); break; }
    if (/^[A-Za-z]:\//.test(s) && s.toLowerCase().startsWith(r.toLowerCase() + '/')) { s = s.slice(r.length + 1); break; }
  }
  while (s.startsWith('./')) s = s.slice(2);
  return s;
}

/** Root spellings to strip: as given, realpath (macOS /var → /private/var), and both separators. */
export function rootVariants(root) {
  if (!root) return [];
  const out = new Set();
  const add = (r) => { if (r) out.add(toPosix(r).replace(/\/+$/, '')); };
  const roots = Array.isArray(root) ? root : [root];
  for (const r of roots) {
    add(r);
    add(path.resolve(r));
    const p = toPosix(r);
    if (p.startsWith('/private/')) add(p.slice('/private'.length));
    else if (/^\/(var|tmp)\//.test(p)) add('/private' + p);
  }
  return [...out].sort((a, b) => b.length - a.length);
}

// Failures that mean "the test could not load or compile", never a behavioral red.
const LOAD_ERROR_RE = /\b(?:ModuleNotFoundError|ImportError|No module named|cannot import name|Cannot find module|ERR_MODULE_NOT_FOUND|does not provide an export named|SyntaxError|IndentationError|LoadError|cannot load such file|could not compile|cannot find symbol|collection failure|Test suite failed to run)\b|error\[E\d{4}\]|\berror CS\d{4}\b|\berror TS\d{4}\b|\[(?:build|setup) failed\]|\(0 ?, ?_[\w$]+\.[\w$]+\) is not a function/;
// Missing symbols: an error only when the failing frame is inside a test file (else a crash of the code under test).
const SYMBOL_ERROR_RE = /\b(?:NameError|ReferenceError|AttributeError|NoMethodError|is not defined|has no attribute|is not a function|undefined method|uninitialized constant)\b/;
const TEST_PATH_RE = /(?:^|\/)(?:tests?|specs?|__tests__|testing)\/|(?:^|\/)test_[^/]*$|[._-](?:test|spec)s?\.[A-Za-z0-9]+$|Tests?\.(?:cs|java|kt|scala|swift)$/i;

export const isTestPath = (p) => TEST_PATH_RE.test(toPosix(String(p || '')));

/** Location of the failing frame in a failure body: last frame for Python tracebacks, first otherwise. */
export function failureLocation(body) {
  // Capped (head and tail: the first frame for most runners, the last for Python tracebacks):
  // failure bodies can be large, and the generic pattern scans every position.
  const raw = String(body || '');
  const text = raw.length > 8000 ? `${raw.slice(0, 4000)}\n${raw.slice(-4000)}` : raw;
  const py = [...text.matchAll(/^([^\s:]+\.py):(\d+):(?: in \S+| \w+)?/gm)];
  if (py.length) return { file: toPosix(py[py.length - 1][1]), line: Number(py[py.length - 1][2]) };
  const generic = /(?:at\s+(?:[^\n(]*\()?|❯\s+|^#?[ \t]*)((?:file:\/\/)?[^\s()'"`]+?\.(?:[cm]?[jt]sx?|rb|go|rs|cs|java|kt|py)):(\d+)/m.exec(text);
  if (generic) return { file: toPosix(generic[1].replace(/^file:\/\//, '')), line: Number(generic[2]) };
  return null;
}

/**
 * 'assertion' when the test body ran and failed (an assertion, or a crash inside the code under
 * test); 'error' when the test could not run as written (load, import, compile or missing-symbol
 * errors raised from the test file itself, hook failures, cancellations, timeouts).
 */
export function classifyFailure({ element = 'failure', type = '', message = '', body = '' } = {}, opts = {}) {
  if (element === 'error') return 'error';
  const head = `${type}\n${message}`;
  const all = `${head}\n${body}`;
  if (/^(?:hookFailure|cancelledByParent|testTimeoutFailure|parentAlreadyFinished)$/.test(String(type).trim())) return 'error';
  if (LOAD_ERROR_RE.test(head) || LOAD_ERROR_RE.test(String(body).slice(0, 4000))) return 'error';
  if (/ERR_TEST_FAILURE/.test(all) && /cause: 'test failed'|exitCode: \d+/.test(all) && !/AssertionError/.test(all)) return 'error';
  if (SYMBOL_ERROR_RE.test(head) || SYMBOL_ERROR_RE.test(String(body).slice(0, 2000))) {
    if (/AssertionError|ExpectationNotMet|AssertFailed|AssertionFailed/.test(head)) return 'assertion';
    const loc = failureLocation(body || message);
    if (loc && isTestPath(normalizeReportPath(loc.file, opts))) return 'error';
  }
  return 'assertion';
}

const STATUS_KEY = { passed: 'passed', failed: 'failed', error: 'errors', flaky: 'flaky', skipped: 'skipped' };

/** Counts from test entries. `executed` is every test that ran (passed, failed, error, flaky). */
export function countTests(tests) {
  const c = { executed: 0, passed: 0, failed: 0, errors: 0, skipped: 0, flaky: 0 };
  for (const t of tests) {
    const key = STATUS_KEY[t.status];
    if (!key) continue;
    c[key]++;
    if (t.status !== 'skipped') c.executed++;
  }
  return c;
}

/**
 * Collapse repeated attempts of one id. 'rerun': earlier attempts are retries (pytest-rerunfailures
 * writes them as empty test cases), so a passing final attempt means flaky. 'repeat': every
 * attempt is a real outcome (go -count, Playwright --repeat-each): mixed outcomes mean flaky.
 */
function collapse(entries, mode) {
  if (entries.length === 1) return entries[0];
  const final = { ...entries[entries.length - 1], attempts: entries.length };
  const statuses = entries.map((e) => e.status);
  if (mode === 'rerun') {
    if (final.status === 'passed') final.status = 'flaky';
  } else {
    const ran = statuses.filter((s) => s !== 'skipped');
    const ok = ran.filter((s) => s === 'passed' || s === 'flaky').length;
    if (!ran.length) final.status = 'skipped';
    else if (ok === ran.length) final.status = ran.includes('flaky') ? 'flaky' : 'passed';
    else if (ok === 0) {
      const bad = entries.filter((e) => e.status === 'failed' || e.status === 'error');
      Object.assign(final, bad[bad.length - 1]);
      final.attempts = entries.length;
    } else {
      const bad = entries.filter((e) => e.status === 'failed' || e.status === 'error');
      final.status = 'flaky';
      if (bad.length) { final.failure_kind = bad[0].failure_kind; final.message = bad[0].message; }
    }
    final.runs = { passed: ok, failed: ran.length - ok, skipped: statuses.length - ran.length };
  }
  return final;
}

function groupCollapse(list, keyOf, mode) {
  const order = [];
  const groups = new Map();
  for (const e of list) {
    const k = keyOf(e);
    if (!groups.has(k)) { groups.set(k, []); order.push(k); }
    groups.get(k).push(e);
  }
  return order.map((k) => collapse(groups.get(k), mode));
}

function result(tests, extra = {}) {
  return { ...countTests(tests), tests, ...extra };
}

// ---------------------------------------------------------------------------
// JUnit family

const looksLikePath = (s) => /[/\\]/.test(s) || /\.(?:[cm]?[jt]sx?|py|rb|go|rs|cs|java|kt|php)$/i.test(s);

/** Test id for a JUnit case; `chain` is the enclosing <testsuite> names (node:test describe blocks). */
function junitId(name, classname, file, chain, opts) {
  // node:test writes classname="test" (top level) or the dotted describe chain, and the path in
  // `file`: without the file, same-named tests in different files would share an id (and collapse
  // as reruns).
  const nodeStyle = classname === 'test' || (chain.length > 0 && classname === chain.join('.') && !looksLikePath(classname));
  if (file && (!classname || nodeStyle)) {
    if (name === file || normalizeReportPath(name, opts) === file) return file;
    return `${file}::${[...(nodeStyle ? chain : []), name].join(' > ')}`;
  }
  return classname && classname !== name ? `${normalizeReportPath(classname, opts)}::${name}` : name;
}

function junitCase(tc, suiteName, opts, chain = []) {
  const a = tc.attrs;
  const name = a.name || '';
  const classname = a.classname || a.class || '';
  const file = normalizeReportPath(a.file || a.filepath || (looksLikePath(classname) ? classname : ''), opts);
  const id = junitId(name, classname, file, chain, opts);
  const failure = kid(tc, 'failure');
  const error = kid(tc, 'error');
  const skipped = kid(tc, 'skipped');
  const flakyEl = kid(tc, 'flakyFailure') || kid(tc, 'flakyError');
  const statusAttr = String(a.status || a.result || '').toLowerCase();
  const entry = { id, status: 'passed' };
  if (file) entry.file = file;
  if (suiteName) entry.suite = suiteName;
  const bad = failure || error;
  if (bad) {
    entry.status = failure ? 'failed' : 'error';
    const body = bad.text || (kid(bad, 'stackTrace') || {}).text || '';
    entry.failure_kind = classifyFailure({ element: bad.name, type: bad.attrs.type, message: bad.attrs.message, body }, opts);
    entry.message = shortMessage(bad.attrs.message || body || a.failure);
    if (kids(tc, 'rerunFailure').length || kids(tc, 'rerunError').length) entry.reruns = kids(tc, 'rerunFailure').length + kids(tc, 'rerunError').length;
    if (flakyEl) entry.retried = true;
  } else if (skipped || ['skipped', 'disabled', 'notrun', 'ignored', 'pending'].includes(statusAttr)) {
    entry.status = 'skipped';
    const msg = skipped ? (skipped.attrs.message || skipped.text) : '';
    if (msg) entry.message = shortMessage(msg);
  } else if (flakyEl) {
    entry.status = 'flaky';
    entry.message = shortMessage(flakyEl.attrs.message || (kid(flakyEl, 'stackTrace') || {}).text || flakyEl.text);
  } else if (['failed', 'failure', 'error'].includes(statusAttr)) {
    entry.status = statusAttr === 'error' ? 'error' : 'failed';
    entry.failure_kind = statusAttr === 'error' ? 'error' : 'assertion';
  }
  return entry;
}

function parseJunit(text, opts) {
  const root = parseXml(text);
  const tests = [];
  const visit = (node, suiteName, chain) => {
    // Test cases directly under this node form one attempt group (rerun semantics within a suite).
    const own = [];
    for (const c of node.children) {
      if (c.name === 'testcase') own.push(junitCase(c, suiteName, opts, chain));
    }
    tests.push(...groupCollapse(own, (e) => e.id, opts.duplicates || 'rerun'));
    if (node.name === 'testsuite') {
      // Suite-level failures (a file that failed to load, a crashed fixture) are errors, never silence.
      for (const c of node.children) {
        if (c.name === 'error' || c.name === 'failure') {
          const body = c.text || '';
          tests.push({ id: `${suiteName || 'suite'}::<suite>`, status: 'error', failure_kind: 'error', message: shortMessage(c.attrs.message || body), ...(suiteName ? { suite: suiteName } : {}) });
        }
      }
    }
    for (const c of node.children) {
      if (c.name === 'testsuite' || c.name === 'testsuites') {
        visit(c, c.attrs.name || suiteName || '', c.name === 'testsuite' && c.attrs.name ? [...chain, c.attrs.name] : chain);
      }
    }
  };
  if (root.name === 'testcase') tests.push(junitCase(root, '', opts));
  else visit(root, root.name === 'testsuite' ? (root.attrs.name || '') : '', root.name === 'testsuite' && root.attrs.name ? [root.attrs.name] : []);
  if (!tests.length) {
    // Some writers emit only aggregate attributes; use them rather than report "nothing ran".
    const suites = root.name === 'testsuite' ? [root] : [...walk(root, 'testsuite')];
    const agg = { tests: 0, failures: 0, errors: 0, skipped: 0 };
    for (const s of suites.length ? suites : [root]) {
      for (const k of Object.keys(agg)) agg[k] += Number(s.attrs[k] || (k === 'skipped' ? s.attrs.disabled : 0) || 0);
    }
    if (agg.tests > 0) {
      const executed = Math.max(0, agg.tests - agg.skipped);
      return { executed, passed: Math.max(0, executed - agg.failures - agg.errors), failed: agg.failures, errors: agg.errors, skipped: agg.skipped, flaky: 0, tests: [], source: 'aggregate-attributes' };
    }
  }
  return result(tests);
}

// ---------------------------------------------------------------------------
// Jest / Vitest JSON (`--json --outputFile`)

function parseJestJson(text, opts) {
  const json = JSON.parse(stripBom(text));
  const tests = [];
  const suites = Array.isArray(json.testResults) ? json.testResults : [];
  for (const r of suites) {
    const file = normalizeReportPath(r.name || r.testFilePath || r.file || '', opts) || '';
    const cases = r.assertionResults || r.testResults || [];
    const suiteMessage = r.testExecError ? (r.testExecError.message || String(r.testExecError)) : (r.failureMessage || r.message || '');
    if (!cases.length && (r.status === 'failed' || r.testExecError || r.failureMessage)) {
      tests.push({ id: `${file}::<suite>`, status: 'error', failure_kind: 'error', file, message: shortMessage(suiteMessage.replace(/^\s*●\s*/, '')) });
      continue;
    }
    for (const a of cases) {
      const title = a.fullName || [...(a.ancestorTitles || []), a.title].filter(Boolean).join(' ');
      const entry = { id: `${file}::${title}`, status: 'passed', file };
      const st = String(a.status || '').toLowerCase();
      if (st === 'failed') {
        const body = (a.failureMessages || []).join('\n');
        entry.status = 'failed';
        entry.failure_kind = classifyFailure({ element: 'failure', message: firstLine(body), body }, opts);
        entry.message = shortMessage(body);
      } else if (['pending', 'skipped', 'todo', 'disabled'].includes(st)) entry.status = 'skipped';
      else if ((Number(a.invocations) || 1) > 1 || (Array.isArray(a.retryReasons) && a.retryReasons.length)) {
        entry.status = 'flaky';
        entry.attempts = Number(a.invocations) || (a.retryReasons.length + 1);
      }
      tests.push(entry);
    }
    if (cases.length && r.testExecError) {
      tests.push({ id: `${file}::<suite>`, status: 'error', failure_kind: 'error', file, message: shortMessage(suiteMessage) });
    }
  }
  if (!suites.length && Number.isFinite(json.numTotalTests)) {
    const skipped = (json.numPendingTests || 0) + (json.numTodoTests || 0);
    const errors = json.numRuntimeErrorTestSuites || 0;
    return { executed: json.numTotalTests - skipped + errors, passed: json.numPassedTests || 0, failed: json.numFailedTests || 0, errors, skipped, flaky: 0, tests: [], source: 'aggregate-fields' };
  }
  return result(tests);
}

// ---------------------------------------------------------------------------
// go test -json (test2json stream)

function parseGoTestJson(text) {
  const pkgs = new Map();
  const builds = new Map();
  const seeds = [];
  const pkg = (name) => {
    if (!pkgs.has(name)) pkgs.set(name, { tests: new Map(), order: [], status: null, output: [], failedBuild: null });
    return pkgs.get(name);
  };
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('{')) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.Action === 'build-output' || ev.Action === 'build-fail') {
      const key = String(ev.ImportPath || '').replace(/ \[.*\]$/, '');
      if (!builds.has(key)) builds.set(key, { output: [], failed: false });
      const b = builds.get(key);
      if (ev.Action === 'build-fail') b.failed = true;
      else if (ev.Output && b.output.length < 50) b.output.push(ev.Output.replace(/\r?\n$/, ''));
      continue;
    }
    if (!ev.Package) continue;
    const p = pkg(ev.Package);
    if (ev.Test) {
      if (!p.tests.has(ev.Test)) { p.tests.set(ev.Test, { results: [], output: [] }); p.order.push(ev.Test); }
      const t = p.tests.get(ev.Test);
      if (ev.Action === 'output' && ev.Output && t.output.length < 40) t.output.push(ev.Output.replace(/\r?\n$/, ''));
      if (ev.Action === 'pass' || ev.Action === 'fail' || ev.Action === 'skip') t.results.push(ev.Action);
    } else {
      if (ev.Action === 'output' && ev.Output) {
        const m = /^-test\.shuffle (\d+)/.exec(ev.Output);
        if (m) seeds.push(m[1]);
        if (p.output.length < 60) p.output.push(ev.Output.replace(/\r?\n$/, ''));
      }
      if (ev.Action === 'pass' || ev.Action === 'fail' || ev.Action === 'skip') p.status = ev.Action;
      if (ev.FailedBuild) p.failedBuild = String(ev.FailedBuild).replace(/ \[.*\]$/, '');
    }
  }
  const tests = [];
  for (const [name, p] of pkgs) {
    const names = p.order;
    const isParent = (n) => names.some((o) => o !== n && o.startsWith(n + '/'));
    let anyFailed = false;
    for (const n of names) {
      const t = p.tests.get(n);
      const failedLeaf = names.some((o) => o.startsWith(n + '/') && p.tests.get(o).results.includes('fail'));
      if (isParent(n) && !(t.results.includes('fail') && !failedLeaf)) continue;
      if (!t.results.length) continue;
      const attempts = t.results.map((r) => {
        const e = { id: `${name}::${n}`, status: r === 'pass' ? 'passed' : r === 'skip' ? 'skipped' : 'failed', package: name };
        if (r === 'fail') {
          e.failure_kind = 'assertion';
          const msg = t.output.find((l) => !/^(?:=== (?:RUN|PAUSE|CONT)|--- (?:FAIL|PASS|SKIP))/.test(l.trim()) && l.trim());
          if (msg) e.message = shortMessage(msg);
        }
        return e;
      });
      const entry = collapse(attempts, 'repeat');
      if (entry.status === 'failed' || entry.status === 'flaky') anyFailed = true;
      tests.push(entry);
    }
    if (p.status === 'fail' && !anyFailed) {
      const build = builds.get(p.failedBuild || name);
      const isBuild = Boolean(p.failedBuild) || (build && build.failed) || p.output.some((l) => /\[build failed\]|\[setup failed\]/.test(l));
      const lines = (build && build.output.length ? build.output : p.output).filter((l) => l.trim() && !/^#/.test(l.trim()) && !/^FAIL\b/.test(l.trim()));
      tests.push({ id: `${name}::${isBuild ? '[build failed]' : '[package failed]'}`, status: 'error', failure_kind: 'error', package: name, message: shortMessage(lines[0] || (isBuild ? 'build failed' : 'package failed')) });
    }
  }
  return result(tests, seeds.length ? { seeds } : {});
}

// ---------------------------------------------------------------------------
// cargo test (libtest human output)

/** Test binary name from a `Running ...` line, without the hash suffix (stable across builds). */
function cargoBinary(line) {
  const m = /^\s*Running (?:(?:unittests|tests|benches|examples)\s+)?(\S+)(?:\s+\(([^)]+)\))?/.exec(line);
  if (!m) return null;
  return toPosix(m[2] || m[1]).split('/').pop().replace(/\.exe$/i, '').replace(/-[0-9a-f]{8,}$/, '');
}

function parseCargoText(text) {
  const lines = String(text).split(/\r?\n/);
  const tests = [];
  const byName = new Map();
  let binary = '';
  let sawRunning = false;
  let sawResult = true;
  let section = null;
  let panicNext = false;
  const crashes = [];
  const compileErrors = [];
  for (const raw of lines) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, '');
    const doc = /^\s*Doc-tests (\S+)/.exec(line);
    const bin = doc ? `doctest:${doc[1]}` : (/^\s*Running /.test(line) ? cargoBinary(line) : null);
    if (bin) {
      if (sawRunning && !sawResult) crashes.push(binary);
      binary = bin;
      sawRunning = false;
      sawResult = false;
      section = null;
      continue;
    }
    if (/^running \d+ tests?$/.test(line)) { sawRunning = true; continue; }
    if (/^test result: /.test(line)) { sawResult = true; section = null; continue; }
    const t = /^test (.+?) \.\.\. (ok|FAILED|ignored(?:, (.*))?|bench:.*)$/.exec(line);
    if (t) {
      if (t[2].startsWith('bench')) continue;
      const id = binary ? `${binary}::${t[1]}` : t[1];
      const entry = { id, status: t[2] === 'ok' ? 'passed' : t[2] === 'FAILED' ? 'failed' : 'skipped' };
      if (entry.status === 'failed') entry.failure_kind = 'assertion';
      if (entry.status === 'skipped' && t[3]) entry.message = shortMessage(t[3]);
      tests.push(entry);
      byName.set(`${binary}\0${t[1]}`, entry);
      continue;
    }
    const sec = /^---- (.+?) stdout ----$/.exec(line);
    if (sec) { section = byName.get(`${binary}\0${sec[1]}`) || null; panicNext = false; continue; }
    if (/^failures:$/.test(line)) { section = null; continue; }
    if (section) {
      const old = /panicked at '(.*)', \S+$/.exec(line);
      if (old) { section.message = shortMessage(old[1]); section = null; }
      else if (/^thread '.*' (?:\(\d+\) )?panicked at /.test(line)) panicNext = true;
      else if (panicNext && line.trim()) { section.message = shortMessage(line); section = null; panicNext = false; }
      continue;
    }
    if (/^error(?:\[E\d+\])?: /.test(line) && !/^error: test failed/.test(line) && !/^error: \d+ targets? failed/.test(line)) compileErrors.push(line.trim());
  }
  if (sawRunning && !sawResult) crashes.push(binary);
  for (const b of crashes) tests.push({ id: `${b}::[binary crashed]`, status: 'error', failure_kind: 'error', message: 'test binary exited before printing a result' });
  if (compileErrors.some((l) => /could not compile|^error\[E/.test(l))) {
    tests.push({ id: '[build failed]', status: 'error', failure_kind: 'error', message: shortMessage(compileErrors.find((l) => /^error\[E/.test(l)) || compileErrors[0]) });
  }
  return result(tests);
}

// ---------------------------------------------------------------------------
// TRX (Visual Studio / dotnet test --logger trx)

const TRX_STATUS = {
  passed: 'passed', passedbutrunaborted: 'passed', warning: 'passed', completed: 'passed',
  failed: 'failed', error: 'error', timeout: 'error', aborted: 'error',
  notexecuted: 'skipped', notrunnable: 'skipped', inconclusive: 'skipped', pending: 'skipped', inprogress: 'skipped', disconnected: 'error',
};

function parseTrx(text, opts) {
  const root = parseXml(text);
  const defs = new Map();
  for (const ut of walk(root, 'UnitTest')) {
    const tm = kid(ut, 'TestMethod');
    defs.set(ut.attrs.id, { className: tm ? tm.attrs.className : '', method: tm ? tm.attrs.name : ut.attrs.name });
  }
  const resultsNode = kid(root, 'Results');
  const raw = [];
  const visit = (r) => {
    const inner = kid(r, 'InnerResults');
    if (inner && kids(inner, 'UnitTestResult').length) { kids(inner, 'UnitTestResult').forEach(visit); return; }
    const def = defs.get(r.attrs.testId) || {};
    const testName = r.attrs.testName || def.method || '';
    let className = def.className || '';
    if (className.includes(',')) className = className.split(',')[0].trim();
    const id = className && !testName.startsWith(className) ? `${className}.${testName}` : testName;
    const status = TRX_STATUS[String(r.attrs.outcome || '').toLowerCase()] || 'error';
    const entry = { id, status, key: `${r.attrs.testId || id}\0${testName}` };
    if (className) entry.class = className;
    const info = kid(kid(r, 'Output') || { children: [] }, 'ErrorInfo');
    if (status === 'failed' || status === 'error') {
      const msg = info ? ((kid(info, 'Message') || {}).text || '') : '';
      const stack = info ? ((kid(info, 'StackTrace') || {}).text || '') : '';
      entry.failure_kind = status === 'error' ? 'error' : classifyFailure({ element: 'failure', message: msg, body: stack }, opts);
      entry.message = shortMessage(msg || r.attrs.outcome);
    }
    raw.push(entry);
  };
  if (resultsNode) kids(resultsNode, 'UnitTestResult').forEach(visit);
  else for (const r of walk(root, 'UnitTestResult')) visit(r);
  const tests = groupCollapse(raw, (e) => e.key, 'repeat').map(({ key, ...rest }) => rest);
  if (!tests.length) {
    const counters = [...walk(root, 'Counters')][0];
    if (counters) {
      const n = (k) => Number(counters.attrs[k] || 0);
      const errors = n('error') + n('timeout') + n('aborted');
      return { executed: n('executed') || (n('passed') + n('failed') + errors), passed: n('passed'), failed: n('failed'), errors, skipped: n('notExecuted') + n('inconclusive') + n('notRunnable'), flaky: 0, tests: [], source: 'aggregate-counters' };
    }
  }
  return result(tests);
}

// ---------------------------------------------------------------------------
// RSpec JSON (`--format json`)

function parseRspecJson(text, opts) {
  const json = JSON.parse(stripBom(text));
  const tests = [];
  const seen = new Map();
  for (const ex of json.examples || []) {
    const file = normalizeReportPath(ex.file_path || '', opts) || '';
    let id = `${file}::${ex.full_description || ex.description || ex.id}`;
    if (seen.has(id)) id = `${id} [${ex.id || ex.line_number}]`;
    seen.set(id, true);
    const st = String(ex.status || '').toLowerCase();
    const entry = { id, status: st === 'passed' ? 'passed' : st === 'pending' ? 'skipped' : 'failed', file };
    if (entry.status === 'failed') {
      const exc = ex.exception || {};
      const cls = String(exc.class || '');
      const body = [exc.message || '', ...(exc.backtrace || [])].join('\n');
      if (/ExpectationNotMetError|MockExpectationError|MultipleExpectationsNotMetError|PendingExampleFixedError/.test(cls)) entry.failure_kind = 'assertion';
      else entry.failure_kind = classifyFailure({ element: 'failure', type: cls, message: exc.message || '', body: (exc.backtrace || []).join('\n') || body }, opts);
      entry.message = shortMessage(`${cls}: ${firstLine(exc.message)}`.replace(/^: /, ''));
    }
    if (entry.status === 'skipped' && ex.pending_message) entry.message = shortMessage(ex.pending_message);
    tests.push(entry);
  }
  const outside = Number((json.summary || {}).errors_outside_of_examples_count || 0);
  const messages = (json.messages || []).filter((m) => /error occurred|Failure\/Error|LoadError|SyntaxError/.test(m));
  for (let i = 0; i < outside; i++) {
    const msg = messages[i] || '';
    const m = /while loading (\S+?)\.?\s/.exec(msg);
    const file = m ? normalizeReportPath(m[1], opts) : null;
    tests.push({ id: `${file || 'rspec'}::[error outside of examples${outside > 1 ? ` ${i + 1}` : ''}]`, status: 'error', failure_kind: 'error', ...(file ? { file } : {}), message: shortMessage(msg.replace(/^\s*An error occurred while loading/, 'error loading')) });
  }
  return result(tests);
}

// ---------------------------------------------------------------------------
// Public: test reports

const PARSERS = {
  junit: parseJunit, 'jest-json': parseJestJson, 'go-test-json': parseGoTestJson,
  'cargo-text': parseCargoText, trx: parseTrx, 'rspec-json': parseRspecJson,
};
const FORMAT_ALIASES = {
  xml: 'junit', 'junit-xml': 'junit', surefire: 'junit', xunit: 'junit', nextest: 'junit', playwright: 'junit', 'node-test': 'junit',
  jest: 'jest-json', 'vitest-json': 'jest-json', go: 'go-test-json', 'go-json': 'go-test-json', test2json: 'go-test-json',
  cargo: 'cargo-text', libtest: 'cargo-text', 'dotnet-trx': 'trx', rspec: 'rspec-json',
};

export const normalizeFormat = (format) => {
  const f = String(format || '').toLowerCase();
  return PARSERS[f] ? f : FORMAT_ALIASES[f] || null;
};

/** Guess a report format from its content (used when a runner's report format is unknown). */
export function detectReportFormat(text) {
  const s = stripBom(String(text || '')).trimStart();
  if (s.startsWith('<')) return /<TestRun\b/.test(s.slice(0, 4000)) ? 'trx' : 'junit';
  if (s.startsWith('{')) {
    if (/^\{"(?:Time|Action|ImportPath)"/.test(s)) return 'go-test-json';
    try {
      const j = JSON.parse(s);
      if (Array.isArray(j.examples) && j.summary) return 'rspec-json';
      if (Array.isArray(j.testResults) || 'numTotalTests' in j) return 'jest-json';
    } catch {
      if (/"Action"\s*:/.test(s.slice(0, 2000))) return 'go-test-json';
    }
  }
  if (/^running \d+ tests?$|^test result: /m.test(s)) return 'cargo-text';
  return null;
}

/**
 * Parse a test report. Returns `{ executed, passed, failed, errors, skipped, flaky, tests[] }`;
 * each test is `{ id, status, failure_kind?, file?, message?, attempts? }`.
 * `opts.root` strips an absolute worktree prefix so ids stay comparable across worktrees.
 */
export function parseReport(format, text, opts = {}) {
  const f = normalizeFormat(format) || (format === 'auto' || !format ? detectReportFormat(text) : null);
  if (!f) throw new Error(`unknown report format "${format}"`);
  const out = PARSERS[f](String(text ?? ''), opts);
  out.format = f;
  return out;
}

// ---------------------------------------------------------------------------
// Coverage

function addLine(files, file, line, hits) {
  if (!file || !Number.isFinite(line) || line < 1) return;
  const f = files[file] || (files[file] = { lines: {} });
  const k = String(line);
  const h = Number(hits) || 0;
  if (!(k in f.lines) || f.lines[k] < h) f.lines[k] = h;
}

function addBranch(files, file, line, covered, total) {
  if (!file || !Number.isFinite(line)) return;
  const f = files[file] || (files[file] = { lines: {} });
  f.branches = f.branches || {};
  const k = String(line);
  const cur = f.branches[k] || [0, 0];
  f.branches[k] = [cur[0] + covered, cur[1] + total];
}

function parseLcov(text, opts) {
  const files = {};
  let file = null;
  const branchAcc = new Map();
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('SF:')) { file = normalizeReportPath(line.slice(3), opts); files[file] = files[file] || { lines: {} }; continue; }
    if (!file) continue;
    if (line.startsWith('DA:')) {
      const [n, h] = line.slice(3).split(',');
      addLine(files, file, Number(n), Number(h));
    } else if (line.startsWith('BRDA:')) {
      const [n, , , taken] = line.slice(5).split(',');
      const key = `${file}\0${n}`;
      const cur = branchAcc.get(key) || [0, 0];
      branchAcc.set(key, [cur[0] + (taken && taken !== '-' && Number(taken) > 0 ? 1 : 0), cur[1] + 1]);
    } else if (line === 'end_of_record') file = null;
  }
  for (const [key, [c, t]] of branchAcc) {
    const [f, n] = key.split('\0');
    addBranch(files, f, Number(n), c, t);
  }
  return files;
}

function parseCobertura(text, opts) {
  const root = parseXml(text);
  const sources = [...walk(root, 'source')].map((s) => s.text.trim()).filter(Boolean);
  const roots = rootVariants(opts.root);
  const files = {};
  for (const cls of walk(root, 'class')) {
    let name = toPosix(cls.attrs.filename || cls.attrs.name || '');
    if (!name) continue;
    const isAbs = name.startsWith('/') || /^[A-Za-z]:\//.test(name);
    if (!isAbs && sources.length) {
      const src = sources.map(toPosix).find((s) => roots.some((r) => s === r || s.startsWith(r + '/'))) || null;
      if (src) name = `${src.replace(/\/+$/, '')}/${name}`;
    }
    const file = normalizeReportPath(name, opts);
    files[file] = files[file] || { lines: {} };
    const lines = kid(cls, 'lines');
    for (const ln of lines ? kids(lines, 'line') : []) {
      const n = Number(ln.attrs.number);
      addLine(files, file, n, Number(ln.attrs.hits));
      const cc = /\((\d+)\/(\d+)\)/.exec(ln.attrs['condition-coverage'] || '');
      if (ln.attrs.branch === 'true' && cc) addBranch(files, file, n, Number(cc[1]), Number(cc[2]));
    }
  }
  return files;
}

function parseIstanbul(text, opts) {
  const json = JSON.parse(stripBom(text));
  const files = {};
  for (const [key, value] of Object.entries(json)) {
    const data = value && value.data && value.data.statementMap ? value.data : value;
    if (!data || typeof data !== 'object' || !data.statementMap) continue;
    const file = normalizeReportPath(data.path || key, opts);
    files[file] = files[file] || { lines: {} };
    for (const [sid, loc] of Object.entries(data.statementMap)) {
      if (loc && loc.start) addLine(files, file, Number(loc.start.line), Number((data.s || {})[sid] || 0));
    }
    for (const [bid, br] of Object.entries(data.branchMap || {})) {
      const counts = (data.b || {})[bid] || [];
      const line = Number(br.line || (br.loc && br.loc.start && br.loc.start.line));
      addBranch(files, file, line, counts.filter((c) => c > 0).length, counts.length);
    }
  }
  return files;
}

function parseIstanbulSummary(text, opts) {
  const json = JSON.parse(stripBom(text));
  const files = {};
  for (const [key, v] of Object.entries(json)) {
    if (key === 'total' || !v || !v.lines) continue;
    files[normalizeReportPath(key, opts)] = { summary: { lines_total: v.lines.total, lines_covered: v.lines.covered, pct: v.lines.pct } };
  }
  return files;
}

function parseGoCover(text, opts) {
  const files = {};
  const mod = opts.goModule || null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('mode:')) continue;
    const m = /^(.+\.go):(\d+)\.\d+,(\d+)\.\d+ \d+ (\d+)$/.exec(line);
    if (!m) continue;
    let file = toPosix(m[1]);
    if (mod && mod.module && (file === mod.module || file.startsWith(mod.module + '/'))) {
      const rest = file.slice(mod.module.length).replace(/^\//, '');
      file = mod.dir && mod.dir !== '.' ? `${toPosix(mod.dir).replace(/\/+$/, '')}/${rest}` : rest;
    } else file = normalizeReportPath(file, opts);
    for (let n = Number(m[2]); n <= Number(m[3]); n++) addLine(files, file, n, Number(m[4]));
  }
  return files;
}

const COVERAGE_PARSERS = { lcov: parseLcov, cobertura: parseCobertura, istanbul: parseIstanbul, 'istanbul-summary': parseIstanbulSummary, 'go-cover': parseGoCover };

/** Guess a coverage format from content. */
export function detectCoverageFormat(text) {
  const s = stripBom(String(text || '')).trimStart();
  if (s.startsWith('mode:')) return 'go-cover';
  if (s.startsWith('<')) return /<coverage\b/.test(s.slice(0, 4000)) ? 'cobertura' : null;
  if (s.startsWith('{')) {
    try {
      const j = JSON.parse(s);
      const first = Object.values(j).find((v) => v && typeof v === 'object');
      if (first && (first.statementMap || (first.data && first.data.statementMap))) return 'istanbul';
      if (j.total && j.total.lines && 'pct' in j.total.lines) return 'istanbul-summary';
    } catch {}
    return null;
  }
  if (/^(?:TN:|SF:)/m.test(s)) return 'lcov';
  return null;
}

/**
 * Parse a coverage report → `{ format, files: { 'posix/path': { lines: { "12": hits }, branches?: { "12": [covered, total] } } } }`.
 * Paths are made relative to `opts.root`; Go import paths use `opts.goModule = { module, dir }`.
 */
export function parseCoverage(format, text, opts = {}) {
  const f = format === 'auto' || !format ? detectCoverageFormat(text) : String(format).toLowerCase();
  const parser = COVERAGE_PARSERS[f === 'json' || f === 'coverage-final' ? 'istanbul' : f === 'xml' ? 'cobertura' : f];
  if (!parser) throw new Error(`unknown coverage format "${format}"`);
  return { format: f, files: parser(String(text ?? ''), opts) };
}

// ---------------------------------------------------------------------------
// Runner summary lines in console output (post-shell hook: observed runs, never evidence)

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;
// Line-anchored patterns below use [ \t] rather than \s: with the m flag, `^\s*` spans newlines and
// makes a long run of blank lines quadratic (tool output can be megabytes).

function words(s, map) {
  const out = {};
  for (const m of String(s).matchAll(/(\d+)\s+([a-z]+(?: [a-z]+)?)/gi)) {
    const key = map[m[2].toLowerCase()];
    if (key) out[key] = (out[key] || 0) + Number(m[1]);
  }
  return out;
}

const pick = (runner, o) => ({
  runner,
  passed: o.passed ?? null,
  failed: o.failed ?? null,
  skipped: o.skipped ?? null,
  ...(o.errors != null ? { errors: o.errors } : {}),
  ...(o.flaky != null ? { flaky: o.flaky } : {}),
  ...(o.total != null ? { total: o.total } : {}),
  ...(o.reruns != null ? { reruns: o.reruns } : {}),
});

const lastMatch = (text, re) => {
  let m = null;
  for (const x of text.matchAll(re)) m = x;
  return m;
};

const SUMMARY_DETECTORS = [
  ['pytest', (t) => {
    const m = lastMatch(t, /^(?:=+ )?((?:\d+ (?:failed|passed|skipped|deselected|xfailed|xpassed|warnings?|errors?|rerun|subtests? passed|subtests? failed)(?:, )?)+) in [\d.]+s(?: \([^)]*\))?(?: =+)?[ \t]*$/gm);
    if (!m) return /^=+ no tests ran in [\d.]+s =+$/m.test(t) ? { passed: 0, failed: 0, skipped: 0 } : null;
    const w = words(m[1], { failed: 'failed', passed: 'passed', skipped: 'skipped', xfailed: 'skipped', xpassed: 'passed', error: 'errors', errors: 'errors', rerun: 'reruns' });
    return { passed: w.passed || 0, failed: w.failed || 0, skipped: w.skipped || 0, errors: w.errors || 0, ...(w.reruns ? { reruns: w.reruns } : {}) };
  }],
  ['jest', (t) => {
    if (!/^Test Suites:/m.test(t)) return null;
    const m = lastMatch(t, /^Tests:[ \t]+(.+)$/gm);
    if (!m) return null;
    const w = words(m[1], { failed: 'failed', passed: 'passed', skipped: 'skipped', todo: 'skipped', pending: 'skipped', total: 'total' });
    return { passed: w.passed || 0, failed: w.failed || 0, skipped: w.skipped || 0, total: w.total };
  }],
  ['vitest', (t) => {
    const m = lastMatch(t, /^[ \t]*Tests[ \t]+((?:\d+ (?:failed|passed|skipped|todo|expected fail)[ \t]*(?:\|[ \t]*)?)+)\(\d+\)[ \t]*$/gm);
    if (!m) return null;
    const w = words(m[1], { failed: 'failed', passed: 'passed', skipped: 'skipped', todo: 'skipped', 'expected fail': 'passed' });
    return { passed: w.passed || 0, failed: w.failed || 0, skipped: w.skipped || 0 };
  }],
  ['nextest', (t) => {
    const m = lastMatch(t, /^[ \t]*Summary \[[^\]]*\][ \t]+(\d+) tests? run: (.+)$/gm);
    if (!m) return null;
    const w = words(m[2], { passed: 'passed', failed: 'failed', skipped: 'skipped', flaky: 'flaky', 'timed out': 'failed' });
    return { passed: w.passed || 0, failed: w.failed || 0, skipped: w.skipped || 0, flaky: w.flaky || 0, total: Number(m[1]) };
  }],
  ['cargo', (t) => {
    const all = [...t.matchAll(/^test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored;/gm)];
    if (!all.length) return null;
    return all.reduce((a, m) => ({ passed: a.passed + Number(m[1]), failed: a.failed + Number(m[2]), skipped: a.skipped + Number(m[3]) }), { passed: 0, failed: 0, skipped: 0 });
  }],
  ['go', (t) => {
    const results = new Map();
    for (const m of t.matchAll(/^[ \t]*--- (PASS|FAIL|SKIP): (\S+)/gm)) results.set(m[2], m[1]);
    const okPkgs = (t.match(/^ok\s+\S+\s+(?:[\d.]+s|\(cached\))/gm) || []).length;
    const failPkgs = (t.match(/^FAIL\s+\S+\s+(?:[\d.]+s|\[[^\]]+\])/gm) || []).length;
    if (!results.size && !okPkgs && !failPkgs) return null;
    // Count leaf tests only: a parent of subtests repeats their outcome.
    const names = [...results.keys()];
    const leaves = names.filter((n) => !names.some((o) => o !== n && o.startsWith(n + '/')));
    const count = (s) => leaves.filter((n) => results.get(n) === s).length;
    const failedParents = names.filter((n) => !leaves.includes(n) && results.get(n) === 'FAIL'
      && !names.some((o) => o.startsWith(n + '/') && results.get(o) === 'FAIL')).length;
    // Without -v, passing tests print nothing: the passed count is then unknown, not zero.
    const verbose = /^=== RUN /m.test(t) || count('PASS') > 0;
    return { passed: verbose ? count('PASS') : null, failed: count('FAIL') + failedParents, skipped: verbose ? count('SKIP') : null,
      ...(failPkgs && !count('FAIL') && !failedParents ? { errors: failPkgs } : {}) };
  }],
  ['rspec', (t) => {
    const m = lastMatch(t, /^(\d+) examples?, (\d+) failures?(?:, (\d+) pending)?(?:, (\d+) errors? occurred outside of examples)?/gm);
    if (!m) return null;
    const total = Number(m[1]); const failed = Number(m[2]); const pending = Number(m[3] || 0);
    return { passed: total - failed - pending, failed, skipped: pending, errors: Number(m[4] || 0), total };
  }],
  ['minitest', (t) => {
    const m = lastMatch(t, /(\d+) (?:runs|tests), (\d+) assertions, (\d+) failures, (\d+) errors, (\d+) skips/g);
    if (!m) return null;
    const runs = Number(m[1]); const f = Number(m[3]); const e = Number(m[4]); const s = Number(m[5]);
    return { passed: runs - f - e - s, failed: f, skipped: s, errors: e, total: runs };
  }],
  ['unittest', (t) => {
    const ran = lastMatch(t, /^Ran (\d+) tests? in [\d.]+s$/gm);
    if (!ran) return null;
    const total = Number(ran[1]);
    const status = /^(OK|FAILED)(?: \((.*)\))?$/m.exec(t.slice(ran.index));
    const w = status && status[2] ? Object.fromEntries(status[2].split(/,\s*/).map((p) => p.split('=')).map(([k, v]) => [k.trim(), Number(v)])) : {};
    const failed = w.failures || 0; const errors = w.errors || 0; const skipped = (w.skipped || 0) + (w['expected failures'] || 0);
    return { passed: total - failed - errors - skipped, failed, skipped, errors, total };
  }],
  ['dotnet', (t) => {
    const all = [...t.matchAll(/(?:Passed|Failed)!\s+-\s+Failed:\s+(\d+),\s+Passed:\s+(\d+),\s+Skipped:\s+(\d+),\s+Total:\s+(\d+)/g)];
    if (all.length) return all.reduce((a, m) => ({ failed: a.failed + Number(m[1]), passed: a.passed + Number(m[2]), skipped: a.skipped + Number(m[3]), total: a.total + Number(m[4]) }), { failed: 0, passed: 0, skipped: 0, total: 0 });
    const mtp = lastMatch(t, /Test summary: total: (\d+), failed: (\d+), succeeded: (\d+), skipped: (\d+)/gi);
    return mtp ? { total: Number(mtp[1]), failed: Number(mtp[2]), passed: Number(mtp[3]), skipped: Number(mtp[4]) } : null;
  }],
  ['maven', (t) => {
    const m = lastMatch(t, /Tests run: (\d+), Failures: (\d+), Errors: (\d+), Skipped: (\d+)(?:, Flakes: (\d+))?(?!,\s*Time elapsed)/g);
    if (!m) return null;
    const total = Number(m[1]); const f = Number(m[2]); const e = Number(m[3]); const s = Number(m[4]); const fl = Number(m[5] || 0);
    return { passed: total - f - e - s - fl, failed: f, skipped: s, errors: e, flaky: fl, total };
  }],
  ['gradle', (t) => {
    const m = lastMatch(t, /(\d+) tests? completed, (\d+) failed(?:, (\d+) skipped)?/g);
    if (!m) return null;
    const total = Number(m[1]); const f = Number(m[2]); const s = Number(m[3] || 0);
    return { passed: total - f - s, failed: f, skipped: s, total };
  }],
  ['mocha', (t) => {
    const p = lastMatch(t, /^[ \t]*(\d+) passing \(/gm);
    if (!p) return null;
    const f = lastMatch(t, /^[ \t]*(\d+) failing[ \t]*$/gm); const s = lastMatch(t, /^[ \t]*(\d+) pending[ \t]*$/gm);
    return { passed: Number(p[1]), failed: f ? Number(f[1]) : 0, skipped: s ? Number(s[1]) : 0 };
  }],
  ['node-test', (t) => {
    const get = (k) => { const m = lastMatch(t, new RegExp(`^(?:ℹ|#) ${k} (\\d+)[ \\t]*$`, 'gm')); return m ? Number(m[1]) : null; };
    const pass = get('pass'); const fail = get('fail');
    if (pass == null || fail == null) return null;
    return { passed: pass, failed: fail + (get('cancelled') || 0), skipped: (get('skipped') || 0) + (get('todo') || 0), total: get('tests') ?? undefined };
  }],
  ['bun', (t) => {
    const ran = lastMatch(t, /^Ran (\d+) tests? across \d+ files?/gm);
    if (!ran) return null;
    const g = (k) => { const m = lastMatch(t, new RegExp(`^[ \\t]*(\\d+) ${k}[ \\t]*$`, 'gm')); return m ? Number(m[1]) : 0; };
    return { passed: g('pass'), failed: g('fail'), skipped: g('skip') + g('todo'), total: Number(ran[1]) };
  }],
  ['playwright', (t) => {
    if (!/^[ \t]+\d+ (?:passed|failed) ?(?:\([\d.]+m?s\))?[ \t]*$/m.test(t)) return null;
    const g = (k) => { const m = lastMatch(t, new RegExp(`^[ \\t]+(\\d+) ${k}(?: \\([\\d.]+m?s\\))?[ \\t]*$`, 'gm')); return m ? Number(m[1]) : 0; };
    return { passed: g('passed'), failed: g('failed') + g('interrupted'), skipped: g('skipped') + g('did not run'), flaky: g('flaky') };
  }],
  ['phpunit', (t) => {
    const ok = lastMatch(t, /^OK \((\d+) tests?, \d+ assertions?\)/gm);
    if (ok) return { passed: Number(ok[1]), failed: 0, skipped: 0, total: Number(ok[1]) };
    const m = lastMatch(t, /^Tests: (\d+), Assertions: \d+(.*)\.$/gm);
    if (!m) return null;
    const num = (k) => { const x = new RegExp(`${k}: (\\d+)`).exec(m[2]); return x ? Number(x[1]) : 0; };
    const total = Number(m[1]); const f = num('Failures'); const e = num('Errors'); const s = num('Skipped') + num('Incomplete');
    return { passed: total - f - e - s, failed: f, skipped: s, errors: e, total };
  }],
];

/** Runner summary from console output → `{ runner, passed, failed, skipped, ... }` (null when not stated), or null. */
export function parseSummaryText(text) {
  if (text == null) return null;
  const t = String(text).replace(ANSI_RE, '').replace(/\r\n?/g, '\n');
  if (!/\d/.test(t)) return null;
  for (const [runner, fn] of SUMMARY_DETECTORS) {
    let o = null;
    try { o = fn(t); } catch { o = null; }
    if (o) return pick(runner, o);
  }
  return null;
}
