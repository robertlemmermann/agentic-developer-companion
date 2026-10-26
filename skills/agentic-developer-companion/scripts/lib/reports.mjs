// Test-report and coverage parsers: JUnit XML (Surefire, pytest, Vitest, Playwright, nextest,
// node --test), Jest/Vitest JSON, `go test -json`, `cargo test` text, TRX, RSpec JSON; LCOV,
// Cobertura, Istanbul and Go cover profiles; runner summary lines in console output.
// Imports only core.mjs: the post-shell hook loads parseSummaryText from here.

import path from 'node:path';
import { stripBom, toPosix, firstLine } from './core.mjs';

const TEXT_CAP = 32 * 1024;
const MESSAGE_CAP = 300;
const raw = String.raw;

// ---------------------------------------------------------------------------
// Minimal XML reader (elements, attributes, text, CDATA; comments, PIs and DOCTYPE skipped)

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decodeEntities(s) {
  if (!s || !s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, e) => {
    if (e[0] !== '#') return ENTITIES[e] ?? m;
    const code = /^#x/i.test(e) ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
  });
}

const TOKEN_RE = new RegExp([
  raw`<!\[CDATA\[([\s\S]*?)\]\]>`, raw`<!--[\s\S]*?-->`, raw`<\?[\s\S]*?\?>`, raw`<!DOCTYPE[^>[]*(?:\[[\s\S]*?\])?\s*>`,
  raw`<\/([^\s>]+)\s*>`, raw`<([^\s/>!?]+)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>`,
].join('|'), 'g');
const ATTR_RE = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
const localName = (n) => n.slice(n.indexOf(':') + 1);

/** Parse XML into `{ name, attrs, children, text }` nodes. Throws when no element is found. */
export function parseXml(input) {
  const text = stripBom(String(input ?? ''));
  const root = { name: '#document', attrs: {}, children: [], text: '' };
  const stack = [root];
  const addText = (s) => {
    const top = stack[stack.length - 1];
    if (top !== root && s && top.text.length < TEXT_CAP) top.text += s.slice(0, TEXT_CAP - top.text.length);
  };
  let last = 0;
  for (const m of text.matchAll(TOKEN_RE)) {
    if (m.index > last) addText(decodeEntities(text.slice(last, m.index)));
    last = m.index + m[0].length;
    if (m[1] !== undefined) addText(m[1]);
    else if (m[2] !== undefined) {
      // Tolerate mismatched closers: pop to the nearest matching element if there is one.
      const i = stack.findLastIndex((n, k) => k > 0 && n.name === localName(m[2]));
      if (i > 0) stack.length = i;
    } else if (m[3] !== undefined) {
      const node = { name: localName(m[3]), attrs: {}, children: [], text: '' };
      for (const a of (m[4] || '').matchAll(ATTR_RE)) {
        node.attrs[localName(a[1])] = decodeEntities(a[2] ?? a[3] ?? a[4] ?? '');
      }
      stack[stack.length - 1].children.push(node);
      if (!m[5]) stack.push(node);
    }
  }
  if (last < text.length) addText(decodeEntities(text.slice(last)));
  if (!root.children.length) throw new Error('not an XML document');
  return root.children[0];
}

const kids = (node, name) => node.children.filter((c) => c.name === name);
const kid = (node, name) => node.children.find((c) => c.name === name) || null;
const textOf = (node, name) => (node && kid(node, name) ? kid(node, name).text : '');

function* walk(node, name) {
  for (const c of node.children) {
    if (c.name === name) yield c;
    yield* walk(c, name);
  }
}

// ---------------------------------------------------------------------------
// Shared helpers

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;
/** Text without terminal color and title escape sequences. */
export const stripAnsi = (s) => String(s ?? '').replace(ANSI_RE, '');

const shortMessage = (s) => {
  const line = firstLine(s);
  return line.length > MESSAGE_CAP ? line.slice(0, MESSAGE_CAP - 3) + '...' : line;
};

/** Root spellings to strip: as given, resolved, and the macOS /private alias (/var → /private/var). */
export function rootVariants(root) {
  const out = new Set();
  const add = (v) => out.add(toPosix(v).replace(/\/+$/, ''));
  for (const r of [root].flat().filter(Boolean)) {
    const p = toPosix(r);
    add(p);
    add(path.resolve(r));
    if (p.startsWith('/private/')) add(p.slice('/private'.length));
    else if (/^\/(var|tmp)\//.test(p)) add('/private' + p);
  }
  return [...out].filter(Boolean).sort((a, b) => b.length - a.length);
}

/**
 * Normalize a path from a report: file:// URLs, backslashes, `./`, absolute paths under `opts.root`
 * (drive letters compare case-insensitively). `opts.roots` (from rootVariants) skips recomputing them.
 */
export function normalizeReportPath(p, opts = {}) {
  if (p == null || p === '') return null;
  let s = String(p).trim();
  if (/^file:\/\//i.test(s)) {
    try { s = decodeURIComponent(new URL(s).pathname); } catch { s = s.replace(/^file:\/\//i, ''); }
    if (/^\/[A-Za-z]:\//.test(s)) s = s.slice(1);
  }
  s = toPosix(s);
  const drive = /^[A-Za-z]:\//.test(s);
  const under = (r) => s === r || (drive ? s.toLowerCase().startsWith(r.toLowerCase() + '/') : s.startsWith(r + '/'));
  const r = (opts.roots || rootVariants(opts.root)).find(under);
  if (r) s = s === r ? '.' : s.slice(r.length + 1);
  return s.replace(/^(?:\.\/)+/, '');
}

// Failures that mean "the test could not load or compile", never a behavioral red.
const LOAD_ERROR_RE = new RegExp([
  raw`\b(?:ModuleNotFoundError|ImportError|No module named|cannot import name|Cannot find module`,
  raw`ERR_MODULE_NOT_FOUND|does not provide an export named|SyntaxError|IndentationError|LoadError`,
  raw`cannot load such file|could not compile|cannot find symbol|collection failure|Test suite failed to run)\b`,
  raw`error\[E\d{4}\]|\berror (?:CS|TS)\d{4}\b|\[(?:build|setup) failed\]|\(0 ?, ?_[\w$]+\.[\w$]+\) is not a function`,
].join('|'));
// Missing symbols: an error only when the failing frame is in a test file (else a crash of the code under test).
const SYMBOL_ERROR_RE = new RegExp(raw`\b(?:NameError|ReferenceError|AttributeError|NoMethodError|is not defined`
  + raw`|has no attribute|is not a function|undefined method|uninitialized constant)\b`);
const TEST_PATH_RE = new RegExp(raw`(?:^|\/)(?:tests?|specs?|__tests__|testing)\/|(?:^|\/)test_[^/]*$`
  + raw`|[._-](?:test|spec)s?\.[A-Za-z0-9]+$|Tests?\.(?:cs|java|kt|scala|swift)$`, 'i');
const FRAME_RE = new RegExp(raw`(?:at\s+(?:[^\n(]*\()?|❯\s+|^#?[ \t]*)`
  + raw`((?:file:\/\/)?[^\s()'"\x60]+?\.(?:[cm]?[jt]sx?|rb|go|rs|cs|java|kt|py)):(\d+)`, 'm');
const ABORTED = /^(?:hookFailure|cancelledByParent|testTimeoutFailure|parentAlreadyFinished)$/;

/** Does a path from a failure frame look like a test file? (Not a change classifier.) */
export const isTestPath = (p) => TEST_PATH_RE.test(toPosix(String(p || '')));

/** Location of the failing frame in a failure body: last frame for Python tracebacks, first otherwise. */
function failureLocation(body) {
  // Head and tail only: failure bodies can be large, and the generic pattern scans every position.
  const all = String(body || '');
  const text = all.length > 8000 ? `${all.slice(0, 4000)}\n${all.slice(-4000)}` : all;
  const m = [...text.matchAll(/^([^\s:]+\.py):(\d+):(?: in \S+| \w+)?/gm)].pop() || FRAME_RE.exec(text);
  return m ? { file: toPosix(m[1].replace(/^file:\/\//, '')), line: Number(m[2]) } : null;
}

/**
 * 'assertion' when the test body ran and failed (an assertion, or a crash inside the code under
 * test); 'error' when the test could not run as written (load, import, compile or missing-symbol
 * errors raised from the test file itself, hook failures, cancellations, timeouts).
 */
export function classifyFailure({ element = 'failure', type = '', message = '', body = '' } = {}, opts = {}) {
  const head = `${type}\n${message}`;
  const all = `${head}\n${body}`;
  if (element === 'error' || ABORTED.test(String(type).trim())) return 'error';
  if (LOAD_ERROR_RE.test(head) || LOAD_ERROR_RE.test(String(body).slice(0, 4000))) return 'error';
  // node:test reports a file that failed to load as ERR_TEST_FAILURE without an assertion.
  if (/ERR_TEST_FAILURE/.test(all) && /cause: 'test failed'|exitCode: \d+/.test(all) && !/AssertionError/.test(all)) {
    return 'error';
  }
  if (!SYMBOL_ERROR_RE.test(head) && !SYMBOL_ERROR_RE.test(String(body).slice(0, 2000))) return 'assertion';
  if (/AssertionError|ExpectationNotMet|AssertFailed|AssertionFailed/.test(head)) return 'assertion';
  const loc = failureLocation(body || message);
  return loc && isTestPath(normalizeReportPath(loc.file, opts)) ? 'error' : 'assertion';
}

const STATUS_KEY = { passed: 'passed', failed: 'failed', error: 'errors', flaky: 'flaky', skipped: 'skipped' };

/** Counts from test entries. `executed` is every test that ran (passed, failed, error, flaky). */
function countTests(tests) {
  const c = { executed: 0, passed: 0, failed: 0, errors: 0, skipped: 0, flaky: 0 };
  for (const t of tests.filter((x) => STATUS_KEY[x.status])) {
    c[STATUS_KEY[t.status]]++;
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
  if (mode === 'rerun') return final.status === 'passed' ? { ...final, status: 'flaky' } : final;
  const ran = entries.filter((e) => e.status !== 'skipped');
  const ok = ran.filter((e) => e.status === 'passed' || e.status === 'flaky').length;
  const bad = ran.filter((e) => e.status === 'failed' || e.status === 'error');
  if (!ran.length) final.status = 'skipped';
  else if (ok === ran.length) final.status = ran.some((e) => e.status === 'flaky') ? 'flaky' : 'passed';
  else if (ok === 0) Object.assign(final, bad[bad.length - 1], { attempts: entries.length });
  else {
    Object.assign(final, { status: 'flaky' }, bad[0] && { failure_kind: bad[0].failure_kind, message: bad[0].message });
  }
  final.runs = { passed: ok, failed: ran.length - ok, skipped: entries.length - ran.length };
  return final;
}

function groupCollapse(list, keyOf, mode) {
  const groups = new Map();
  for (const e of list) {
    const k = keyOf(e);
    if (groups.has(k)) groups.get(k).push(e);
    else groups.set(k, [e]);
  }
  return [...groups.values()].map((g) => collapse(g, mode));
}

const result = (tests, extra = {}) => ({ ...countTests(tests), tests, ...extra });
// Some writers emit only aggregate numbers; use them rather than report "nothing ran".
const aggregate = (c, source) => ({ ...c, passed: Math.max(0, c.passed), flaky: 0, tests: [], source });
const suiteError = (id, message, extra) => ({ id, status: 'error', failure_kind: 'error', ...extra,
  message: shortMessage(message) });

// ---------------------------------------------------------------------------
// JUnit family

const looksLikePath = (s) => /[/\\]/.test(s) || /\.(?:[cm]?[jt]sx?|py|rb|go|rs|cs|java|kt|php)$/i.test(s);

/** Test id for a JUnit case; `chain` is the enclosing <testsuite> names (node:test describe blocks). */
function junitId(name, classname, file, chain, opts) {
  // node:test writes classname="test" (top level) or the dotted describe chain, and the path in
  // `file`: without the file, same-named tests in different files would share an id (and collapse
  // as reruns).
  const nodeStyle = classname === 'test'
    || (chain.length > 0 && classname === chain.join('.') && !looksLikePath(classname));
  if (file && (!classname || nodeStyle)) {
    if (name === file || normalizeReportPath(name, opts) === file) return file;
    return `${file}::${[...(nodeStyle ? chain : []), name].join(' > ')}`;
  }
  return classname && classname !== name ? `${normalizeReportPath(classname, opts)}::${name}` : name;
}

const SKIPPED_STATUS = new Set(['skipped', 'disabled', 'notrun', 'ignored', 'pending']);

function junitCase(tc, suite, opts, chain = []) {
  const a = tc.attrs;
  const classname = a.classname || a.class || '';
  const file = normalizeReportPath(a.file || a.filepath || (looksLikePath(classname) ? classname : ''), opts);
  const entry = { id: junitId(a.name || '', classname, file, chain, opts), status: 'passed', ...(file && { file }),
    ...(suite && { suite }) };
  const bad = kid(tc, 'failure') || kid(tc, 'error');
  const skipped = kid(tc, 'skipped');
  const flaky = kid(tc, 'flakyFailure') || kid(tc, 'flakyError');
  const st = String(a.status || a.result || '').toLowerCase();
  if (bad) {
    const body = bad.text || textOf(bad, 'stackTrace');
    const reruns = kids(tc, 'rerunFailure').length + kids(tc, 'rerunError').length;
    const kind = classifyFailure({ element: bad.name, type: bad.attrs.type, message: bad.attrs.message, body }, opts);
    Object.assign(entry, { status: bad.name === 'failure' ? 'failed' : 'error', failure_kind: kind,
      message: shortMessage(bad.attrs.message || body || a.failure) },
    reruns && { reruns }, flaky && { retried: true });
  } else if (skipped || SKIPPED_STATUS.has(st)) {
    entry.status = 'skipped';
    const msg = skipped ? skipped.attrs.message || skipped.text : '';
    if (msg) entry.message = shortMessage(msg);
  } else if (flaky) {
    entry.status = 'flaky';
    entry.message = shortMessage(flaky.attrs.message || textOf(flaky, 'stackTrace') || flaky.text);
  } else if (['failed', 'failure', 'error'].includes(st)) {
    entry.status = st === 'error' ? 'error' : 'failed';
    entry.failure_kind = st === 'error' ? 'error' : 'assertion';
  }
  return entry;
}

function parseJunit(text, opts) {
  const root = parseXml(text);
  const tests = [];
  const visit = (node, suite, chain) => {
    // Test cases directly under this node form one attempt group (rerun semantics within a suite).
    const cases = kids(node, 'testcase').map((c) => junitCase(c, suite, opts, chain));
    tests.push(...groupCollapse(cases, (e) => e.id, opts.duplicates || 'rerun'));
    // Suite-level failures (a file that failed to load, a crashed fixture) are errors, never silence.
    for (const c of node.name === 'testsuite' ? [...kids(node, 'error'), ...kids(node, 'failure')] : []) {
      tests.push(suiteError(`${suite || 'suite'}::<suite>`, c.attrs.message || c.text, suite && { suite }));
    }
    for (const c of node.children.filter((x) => x.name === 'testsuite' || x.name === 'testsuites')) {
      visit(c, c.attrs.name || suite || '', c.name === 'testsuite' && c.attrs.name ? [...chain, c.attrs.name] : chain);
    }
  };
  const named = root.name === 'testsuite' && root.attrs.name;
  if (root.name === 'testcase') tests.push(junitCase(root, '', opts));
  else visit(root, named || '', named ? [named] : []);
  const suites = root.name === 'testsuite' ? [root] : [...walk(root, 'testsuite')];
  const n = (k) => (suites.length ? suites : [root])
    .reduce((sum, x) => sum + Number(x.attrs[k] || (k === 'skipped' && x.attrs.disabled) || 0), 0);
  if (tests.length || !(n('tests') > 0)) return result(tests);
  const [executed, failed, errors] = [Math.max(0, n('tests') - n('skipped')), n('failures'), n('errors')];
  return aggregate({ executed, passed: executed - failed - errors, failed, errors, skipped: n('skipped') },
    'aggregate-attributes');
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
    const exec = r.testExecError;
    const suiteMessage = exec ? exec.message || String(exec) : r.failureMessage || r.message || '';
    if (!cases.length && (r.status === 'failed' || exec || r.failureMessage)) {
      tests.push(suiteError(`${file}::<suite>`, suiteMessage.replace(/^\s*●\s*/, ''), { file }));
      continue;
    }
    for (const a of cases) {
      const title = a.fullName || [...(a.ancestorTitles || []), a.title].filter(Boolean).join(' ');
      const entry = { id: `${file}::${title}`, status: 'passed', file };
      const st = String(a.status || '').toLowerCase();
      const retries = Array.isArray(a.retryReasons) ? a.retryReasons.length : 0;
      const body = (a.failureMessages || []).join('\n');
      if (st === 'failed') {
        const kind = classifyFailure({ element: 'failure', message: firstLine(body), body }, opts);
        Object.assign(entry, { status: 'failed', failure_kind: kind, message: shortMessage(body) });
      } else if (['pending', 'skipped', 'todo', 'disabled'].includes(st)) entry.status = 'skipped';
      else if ((Number(a.invocations) || 1) > 1 || retries) {
        Object.assign(entry, { status: 'flaky', attempts: Number(a.invocations) || retries + 1 });
      }
      tests.push(entry);
    }
    if (cases.length && exec) tests.push(suiteError(`${file}::<suite>`, suiteMessage, { file }));
  }
  if (suites.length || !Number.isFinite(json.numTotalTests)) return result(tests);
  const skipped = (json.numPendingTests || 0) + (json.numTodoTests || 0);
  const errors = json.numRuntimeErrorTestSuites || 0;
  return aggregate({ executed: json.numTotalTests - skipped + errors, passed: json.numPassedTests || 0,
    failed: json.numFailedTests || 0, errors, skipped }, 'aggregate-fields');
}

// ---------------------------------------------------------------------------
// go test -json (test2json stream)

const GO_RESULT = { pass: 'passed', fail: 'failed', skip: 'skipped' };
const GO_NOISE = /^(?:=== (?:RUN|PAUSE|CONT)|--- (?:FAIL|PASS|SKIP))/;
const getOr = (map, key, init) => map.get(key) || map.set(key, init()).get(key);

/**
 * Go subtest structure in one pass (a quadratic scan is slow for large table tests): `parents`
 * holds every name with subtests, `failing` every name with a failing subtest (`failed(name)`).
 */
function subtestParents(names, failed) {
  const parents = new Set();
  const failing = new Set();
  for (const n of names) {
    const bad = failed(n);
    for (let i = n.indexOf('/'); i !== -1; i = n.indexOf('/', i + 1)) {
      parents.add(n.slice(0, i));
      if (bad) failing.add(n.slice(0, i));
    }
  }
  return { parents, failing };
}

function parseGoTestJson(text) {
  const pkgs = new Map();
  const builds = new Map();
  const seeds = [];
  const out = (o) => o.replace(/\r?\n$/, '');
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim().startsWith('{')) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.Action === 'build-output' || ev.Action === 'build-fail') {
      const key = String(ev.ImportPath || '').replace(/ \[.*\]$/, '');
      const b = getOr(builds, key, () => ({ output: [], failed: false }));
      if (ev.Action === 'build-fail') b.failed = true;
      else if (ev.Output && b.output.length < 50) b.output.push(out(ev.Output));
      continue;
    }
    if (!ev.Package) continue;
    const p = getOr(pkgs, ev.Package, () => ({ tests: new Map(), status: null, output: [], failedBuild: null }));
    if (ev.Test) {
      const t = getOr(p.tests, ev.Test, () => ({ results: [], output: [] }));
      if (ev.Action === 'output' && ev.Output && t.output.length < 40) t.output.push(out(ev.Output));
      if (GO_RESULT[ev.Action]) t.results.push(ev.Action);
      continue;
    }
    const seed = ev.Action === 'output' && ev.Output && /^-test\.shuffle (\d+)/.exec(ev.Output);
    if (seed) seeds.push(seed[1]);
    if (ev.Action === 'output' && ev.Output && p.output.length < 60) p.output.push(out(ev.Output));
    if (GO_RESULT[ev.Action]) p.status = ev.Action;
    if (ev.FailedBuild) p.failedBuild = String(ev.FailedBuild).replace(/ \[.*\]$/, '');
  }
  const tests = [];
  for (const [name, p] of pkgs) {
    const { parents, failing } = subtestParents(p.tests.keys(), (n) => p.tests.get(n).results.includes('fail'));
    let anyFailed = false;
    for (const [n, t] of p.tests) {
      // Leaf tests only: a parent of subtests repeats their outcome (unless it failed on its own).
      if (!t.results.length || (parents.has(n) && !(t.results.includes('fail') && !failing.has(n)))) continue;
      const msg = t.output.find((l) => l.trim() && !GO_NOISE.test(l.trim()));
      const fail = { failure_kind: 'assertion', ...(msg && { message: shortMessage(msg) }) };
      const entry = collapse(t.results.map((r) => ({ id: `${name}::${n}`, status: GO_RESULT[r], package: name,
        ...(r === 'fail' && fail) })), 'repeat');
      anyFailed ||= entry.status === 'failed' || entry.status === 'flaky';
      tests.push(entry);
    }
    if (p.status !== 'fail' || anyFailed) continue;
    const build = builds.get(p.failedBuild || name);
    const isBuild = Boolean(p.failedBuild || (build && build.failed))
      || p.output.some((l) => /\[(?:build|setup) failed\]/.test(l));
    const lines = (build && build.output.length ? build.output : p.output)
      .filter((l) => l.trim() && !/^(?:#|FAIL\b)/.test(l.trim()));
    const what = isBuild ? 'build failed' : 'package failed';
    tests.push(suiteError(`${name}::[${what}]`, lines[0] || what, { package: name }));
  }
  return result(tests, seeds.length ? { seeds } : {});
}

// ---------------------------------------------------------------------------
// cargo test (libtest human output)

/** Test binary name from a `Running ...` line, without the hash suffix (stable across builds). */
function cargoBinary(line) {
  const m = /^\s*Running (?:(?:unittests|tests|benches|examples)\s+)?(\S+)(?:\s+\(([^)]+)\))?/.exec(line);
  return m && toPosix(m[2] || m[1]).split('/').pop().replace(/\.exe$/i, '').replace(/-[0-9a-f]{8,}$/, '');
}

function parseCargoText(text) {
  const tests = [];
  const byName = new Map();
  const crashes = [];
  const compileErrors = [];
  let [binary, running, done, section, panicNext] = ['', false, true, null, false];
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = stripAnsi(rawLine);
    const doc = /^\s*Doc-tests (\S+)/.exec(line);
    const bin = doc ? `doctest:${doc[1]}` : /^\s*Running /.test(line) ? cargoBinary(line) : null;
    const t = /^test (.+?) \.\.\. (ok|FAILED|ignored(?:, (.*))?)$/.exec(line);
    const sec = /^---- (.+?) stdout ----$/.exec(line);
    if (bin) {
      if (running && !done) crashes.push(binary);
      [binary, running, done, section] = [bin, false, false, null];
    } else if (/^running \d+ tests?$/.test(line)) running = true;
    else if (/^test result: /.test(line)) [done, section] = [true, null];
    else if (t) {
      const status = { ok: 'passed', FAILED: 'failed' }[t[2]] || 'skipped';
      const entry = { id: binary ? `${binary}::${t[1]}` : t[1], status };
      if (status === 'failed') entry.failure_kind = 'assertion';
      if (status === 'skipped' && t[3]) entry.message = shortMessage(t[3]);
      tests.push(entry);
      byName.set(`${binary}\0${t[1]}`, entry);
    } else if (sec) [section, panicNext] = [byName.get(`${binary}\0${sec[1]}`) || null, false];
    else if (line === 'failures:') section = null;
    else if (section) {
      const old = /panicked at '(.*)', \S+$/.exec(line);
      if (old || (panicNext && line.trim())) {
        section.message = shortMessage(old ? old[1] : line);
        [section, panicNext] = [null, false];
      } else if (/^thread '.*' (?:\(\d+\) )?panicked at /.test(line)) panicNext = true;
    } else if (/^error(?:\[E\d+\])?: /.test(line) && !/^error: (?:test failed|\d+ targets? failed)/.test(line)) {
      compileErrors.push(line.trim());
    }
  }
  if (running && !done) crashes.push(binary);
  for (const b of crashes) {
    tests.push(suiteError(`${b}::[binary crashed]`, 'test binary exited before printing a result'));
  }
  if (compileErrors.some((l) => /could not compile|^error\[E/.test(l))) {
    tests.push(suiteError('[build failed]', compileErrors.find((l) => /^error\[E/.test(l)) || compileErrors[0]));
  }
  return result(tests);
}

// ---------------------------------------------------------------------------
// TRX (Visual Studio / dotnet test --logger trx)

const TRX_STATUS = {
  passed: 'passed', passedbutrunaborted: 'passed', warning: 'passed', completed: 'passed', failed: 'failed',
  error: 'error', timeout: 'error', aborted: 'error', disconnected: 'error', notexecuted: 'skipped',
  notrunnable: 'skipped', inconclusive: 'skipped', pending: 'skipped', inprogress: 'skipped',
};

function parseTrx(text, opts) {
  const root = parseXml(text);
  const defs = new Map();
  for (const ut of walk(root, 'UnitTest')) {
    const tm = kid(ut, 'TestMethod');
    defs.set(ut.attrs.id, { className: tm ? tm.attrs.className : '', method: tm ? tm.attrs.name : ut.attrs.name });
  }
  const all = [];
  const visit = (r) => {
    const inner = kid(r, 'InnerResults');
    if (inner && kids(inner, 'UnitTestResult').length) return kids(inner, 'UnitTestResult').forEach(visit);
    const def = defs.get(r.attrs.testId) || {};
    const testName = r.attrs.testName || def.method || '';
    const className = String(def.className || '').split(',')[0].trim();
    const id = className && !testName.startsWith(className) ? `${className}.${testName}` : testName;
    const status = TRX_STATUS[String(r.attrs.outcome || '').toLowerCase()] || 'error';
    const entry = { id, status, key: `${r.attrs.testId || id}\0${testName}`, ...(className && { class: className }) };
    if (status === 'failed' || status === 'error') {
      const info = kid(kid(r, 'Output') || { children: [] }, 'ErrorInfo');
      const msg = textOf(info, 'Message');
      entry.failure_kind = status === 'error' ? 'error'
        : classifyFailure({ element: 'failure', message: msg, body: textOf(info, 'StackTrace') }, opts);
      entry.message = shortMessage(msg || r.attrs.outcome);
    }
    all.push(entry);
  };
  const results = kid(root, 'Results');
  for (const r of results ? kids(results, 'UnitTestResult') : walk(root, 'UnitTestResult')) visit(r);
  const tests = groupCollapse(all, (e) => e.key, 'repeat').map(({ key, ...rest }) => rest);
  const counters = tests.length ? null : [...walk(root, 'Counters')][0];
  if (!counters) return result(tests);
  const n = (k) => Number(counters.attrs[k] || 0);
  const errors = n('error') + n('timeout') + n('aborted');
  const skipped = n('notExecuted') + n('inconclusive') + n('notRunnable');
  return aggregate({ executed: n('executed') || n('passed') + n('failed') + errors, passed: n('passed'),
    failed: n('failed'), errors, skipped }, 'aggregate-counters');
}

// ---------------------------------------------------------------------------
// RSpec JSON (`--format json`)

const RSPEC_EXPECTATION = new RegExp('ExpectationNotMetError|MockExpectationError|MultipleExpectationsNotMetError'
  + '|PendingExampleFixedError');

function parseRspecJson(text, opts) {
  const json = JSON.parse(stripBom(text));
  const tests = [];
  const seen = new Set();
  for (const ex of json.examples || []) {
    const file = normalizeReportPath(ex.file_path || '', opts) || '';
    let id = `${file}::${ex.full_description || ex.description || ex.id}`;
    if (seen.has(id)) id = `${id} [${ex.id || ex.line_number}]`;
    seen.add(id);
    const st = String(ex.status || '').toLowerCase();
    const entry = { id, status: st === 'passed' ? 'passed' : st === 'pending' ? 'skipped' : 'failed', file };
    if (entry.status === 'failed') {
      const exc = ex.exception || {};
      const cls = String(exc.class || '');
      const body = (exc.backtrace || []).join('\n') || exc.message || '';
      entry.failure_kind = RSPEC_EXPECTATION.test(cls) ? 'assertion'
        : classifyFailure({ element: 'failure', type: cls, message: exc.message || '', body }, opts);
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
    tests.push(suiteError(`${file || 'rspec'}::[error outside of examples${outside > 1 ? ` ${i + 1}` : ''}]`,
      msg.replace(/^\s*An error occurred while loading/, 'error loading'), file && { file }));
  }
  return result(tests);
}

// ---------------------------------------------------------------------------
// Public: test reports

const PARSERS = {
  junit: parseJunit, 'jest-json': parseJestJson, 'go-test-json': parseGoTestJson, 'cargo-text': parseCargoText,
  trx: parseTrx, 'rspec-json': parseRspecJson,
};
const FORMAT_ALIASES = {
  xml: 'junit', surefire: 'junit', nextest: 'junit', playwright: 'junit', 'node-test': 'junit', jest: 'jest-json',
  'vitest-json': 'jest-json', go: 'go-test-json', test2json: 'go-test-json', cargo: 'cargo-text', 'dotnet-trx': 'trx',
  rspec: 'rspec-json',
};

/** Canonical report format for a name or alias, or null. */
export const normalizeFormat = (format) => {
  const f = String(format || '').toLowerCase();
  return PARSERS[f] ? f : FORMAT_ALIASES[f] || null;
};

/**
 * Parse a test report → `{ executed, passed, failed, errors, skipped, flaky, tests[], format }`; each
 * test is `{ id, status, failure_kind?, file?, message?, attempts? }`. `opts.root` strips an absolute
 * worktree prefix so ids stay comparable across worktrees; `opts.duplicates: 'repeat'` reads repeated
 * JUnit cases as repeats instead of reruns.
 */
export function parseReport(format, text, opts = {}) {
  const f = normalizeFormat(format);
  if (!f) throw new Error(`unknown report format "${format}"`);
  return { ...PARSERS[f](String(text ?? ''), { ...opts, roots: rootVariants(opts.root) }), format: f };
}

// ---------------------------------------------------------------------------
// Coverage → { files: { 'posix/path': { lines: { "12": hits }, branches?: { "12": [covered, total] } } } }

const fileEntry = (files, file) => files[file] || (files[file] = { lines: {} });

function addLine(files, file, line, hits) {
  if (!file || !Number.isFinite(line) || line < 1) return;
  const f = fileEntry(files, file);
  f.lines[line] = Math.max(f.lines[line] ?? 0, Number(hits) || 0);
}

function addBranch(files, file, line, covered, total) {
  if (!file || !Number.isFinite(line)) return;
  const f = fileEntry(files, file);
  const cur = (f.branches ||= {})[line] || [0, 0];
  f.branches[line] = [cur[0] + covered, cur[1] + total];
}

function parseLcov(text, opts) {
  const files = {};
  let file = null;
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    const [tag, rest] = [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1)];
    const [n, hits, , taken] = rest.split(',');
    if (tag === 'SF') fileEntry(files, (file = normalizeReportPath(rest, opts)));
    else if (line === 'end_of_record') file = null;
    else if (file && tag === 'DA') addLine(files, file, Number(n), Number(hits));
    else if (file && tag === 'BRDA') addBranch(files, file, Number(n), Number(taken) > 0 ? 1 : 0, 1);
  }
  return files;
}

function parseCobertura(text, opts) {
  const root = parseXml(text);
  const { roots } = opts;
  // A relative filename is relative to a <source>; use the one inside the root, if any.
  const source = [...walk(root, 'source')].map((s) => toPosix(s.text.trim()))
    .find((s) => s && roots.some((r) => s === r || s.startsWith(r + '/')));
  const files = {};
  for (const cls of walk(root, 'class')) {
    const name = toPosix(cls.attrs.filename || cls.attrs.name || '');
    if (!name) continue;
    const abs = name.startsWith('/') || /^[A-Za-z]:\//.test(name);
    const file = normalizeReportPath(!abs && source ? `${source.replace(/\/+$/, '')}/${name}` : name, opts);
    fileEntry(files, file);
    for (const ln of kid(cls, 'lines') ? kids(kid(cls, 'lines'), 'line') : []) {
      const n = Number(ln.attrs.number);
      const cc = /\((\d+)\/(\d+)\)/.exec(ln.attrs['condition-coverage'] || '');
      addLine(files, file, n, Number(ln.attrs.hits));
      if (ln.attrs.branch === 'true' && cc) addBranch(files, file, n, Number(cc[1]), Number(cc[2]));
    }
  }
  return files;
}

function parseIstanbul(text, opts) {
  const files = {};
  for (const [key, value] of Object.entries(JSON.parse(stripBom(text)))) {
    const data = value && value.data && value.data.statementMap ? value.data : value;
    if (!data || typeof data !== 'object' || !data.statementMap) continue;
    const file = normalizeReportPath(data.path || key, opts);
    fileEntry(files, file);
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

/** `coverage-summary.json`: file-level line rates only (changed-line precision becomes 'file'). */
function parseIstanbulSummary(text, opts) {
  const files = {};
  for (const [key, v] of Object.entries(JSON.parse(stripBom(text)))) {
    if (key === 'total' || !v || !v.lines) continue;
    const { total, covered, pct } = v.lines;
    files[normalizeReportPath(key, opts)] = { summary: { lines_total: total, lines_covered: covered, pct } };
  }
  return files;
}

function parseGoCover(text, opts) {
  const files = {};
  const mod = opts.goModule || null;
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^(.+\.go):(\d+)\.\d+,(\d+)\.\d+ \d+ (\d+)$/.exec(line.trim());
    if (!m) continue;
    let file = toPosix(m[1]);
    // Profiles list import paths: map them through the module path to repo paths.
    if (mod && mod.module && (file === mod.module || file.startsWith(mod.module + '/'))) {
      const rest = file.slice(mod.module.length).replace(/^\//, '');
      file = mod.dir && mod.dir !== '.' ? `${toPosix(mod.dir).replace(/\/+$/, '')}/${rest}` : rest;
    } else file = normalizeReportPath(file, opts);
    for (let n = Number(m[2]); n <= Number(m[3]); n++) addLine(files, file, n, Number(m[4]));
  }
  return files;
}

const COVERAGE_PARSERS = {
  lcov: parseLcov, cobertura: parseCobertura, istanbul: parseIstanbul, 'istanbul-summary': parseIstanbulSummary,
  'go-cover': parseGoCover, json: parseIstanbul, 'coverage-final': parseIstanbul, xml: parseCobertura,
};

/** Guess a coverage format from content (coverage-delta --report). */
export function detectCoverageFormat(text) {
  const s = stripBom(String(text || '')).trimStart();
  if (s.startsWith('mode:')) return 'go-cover';
  if (s.startsWith('<')) return /<coverage\b/.test(s.slice(0, 4000)) ? 'cobertura' : null;
  if (!s.startsWith('{')) return /^(?:TN:|SF:)/m.test(s) ? 'lcov' : null;
  // The writers put these keys first: decide from the head, so a large report is parsed only once.
  const head = s.slice(0, 64 * 1024);
  if (/"statementMap"\s*:/.test(head)) return 'istanbul';
  if (/^\{\s*"total"\s*:\s*\{\s*"lines"\s*:\s*\{[^{}]*"pct"\s*:/.test(head)) return 'istanbul-summary';
  try {
    const j = JSON.parse(s);
    const first = Object.values(j).find((v) => v && typeof v === 'object');
    if (first && (first.statementMap || (first.data && first.data.statementMap))) return 'istanbul';
    if (j.total && j.total.lines && 'pct' in j.total.lines) return 'istanbul-summary';
  } catch {}
  return null;
}

/** Parse coverage → `{ format, files }`: paths relative to `opts.root`, Go import paths via `opts.goModule`. */
export function parseCoverage(format, text, opts = {}) {
  const f = format === 'auto' || !format ? detectCoverageFormat(text) : String(format).toLowerCase();
  if (!COVERAGE_PARSERS[f]) throw new Error(`unknown coverage format "${format}"`);
  return { format: f, files: COVERAGE_PARSERS[f](String(text ?? ''), { ...opts, roots: rootVariants(opts.root) }) };
}

// ---------------------------------------------------------------------------
// Runner summary lines in console output (post-shell hook: observed runs, never evidence).
// Line-anchored patterns use [ \t] rather than \s: with the m flag, `^\s*` spans newlines and makes
// a long run of blank lines quadratic (tool output can be megabytes).

const SAME = { failed: 'failed', passed: 'passed', skipped: 'skipped' };

function words(s, map) {
  const out = { passed: 0, failed: 0, skipped: 0 };
  for (const m of String(s).matchAll(/(\d+)\s+([a-z]+(?: [a-z]+)?)/gi)) {
    const key = map[m[2].toLowerCase()];
    if (key) out[key] = (out[key] || 0) + Number(m[1]);
  }
  return out;
}

const lastMatch = (text, re) => [...text.matchAll(re)].pop() || null;
const int = (m, i) => Number((m && m[i]) || 0);
const sumAll = (text, re, keys) => {
  const all = [...text.matchAll(re)];
  return all.length ? Object.fromEntries(keys.map((k, i) => [k, all.reduce((a, m) => a + Number(m[i + 1]), 0)])) : null;
};
// passed = total minus the other outcomes (runners that print totals).
const fromTotal = (total, o) => ({ ...o, total,
  passed: total - ['failed', 'errors', 'skipped', 'flaky'].reduce((a, k) => a + (o[k] || 0), 0) });
const countLine = (k) => new RegExp(`^[ \\t]*(\\d+) ${k}[ \\t]*$`, 'gm');
const PYTEST_RE = new RegExp(raw`^(?:=+ )?((?:\d+ (?:failed|passed|skipped|deselected|xfailed|xpassed|warnings?|errors?`
  + raw`|rerun|subtests? passed|subtests? failed)(?:, )?)+) in [\d.]+s(?: \([^)]*\))?(?: =+)?[ \t]*$`, 'gm');
const VITEST_RE = new RegExp(raw`^[ \t]*Tests[ \t]+((?:\d+ (?:failed|passed|skipped|todo|expected fail)[ \t]*`
  + raw`(?:\|[ \t]*)?)+)\(\d+\)[ \t]*$`, 'gm');
const RSPEC_RE = new RegExp(raw`^(\d+) examples?, (\d+) failures?(?:, (\d+) pending)?`
  + raw`(?:, (\d+) errors? occurred outside of examples)?`, 'gm');
const VSTEST_RE = /(?:Passed|Failed)!\s+-\s+Failed:\s+(\d+),\s+Passed:\s+(\d+),\s+Skipped:\s+(\d+),\s+Total:\s+(\d+)/g;
const MAVEN_RE = new RegExp(raw`Tests run: (\d+), Failures: (\d+), Errors: (\d+), Skipped: (\d+)`
  + raw`(?:, Flakes: (\d+))?(?!,\s*Time elapsed)`, 'g');

function goSummary(t) {
  const results = new Map([...t.matchAll(/^[ \t]*--- (PASS|FAIL|SKIP): (\S+)/gm)].map((m) => [m[2], m[1]]));
  const okPkgs = (t.match(/^ok\s+\S+\s+(?:[\d.]+s|\(cached\))/gm) || []).length;
  const failPkgs = (t.match(/^FAIL\s+\S+\s+(?:[\d.]+s|\[[^\]]+\])/gm) || []).length;
  if (!results.size && !okPkgs && !failPkgs) return null;
  // Leaf tests only: a parent of subtests repeats their outcome.
  const { parents, failing } = subtestParents(results.keys(), (x) => results.get(x) === 'FAIL');
  const leaves = [...results.keys()].filter((x) => !parents.has(x));
  const count = (s) => leaves.filter((x) => results.get(x) === s).length;
  const failedParents = [...parents].filter((x) => results.get(x) === 'FAIL' && !failing.has(x)).length;
  // Without -v, passing tests print nothing: the passed count is then unknown, not zero.
  const verbose = /^=== RUN /m.test(t) || count('PASS') > 0;
  const failed = count('FAIL') + failedParents;
  return { passed: verbose ? count('PASS') : null, failed, skipped: verbose ? count('SKIP') : null,
    ...(failPkgs && !failed && { errors: failPkgs }) };
}

const SUMMARY_DETECTORS = [
  ['pytest', (t) => {
    const m = lastMatch(t, PYTEST_RE);
    if (!m) return /^=+ no tests ran in [\d.]+s =+$/m.test(t) ? { passed: 0, failed: 0, skipped: 0 } : null;
    const w = words(m[1], { ...SAME, xfailed: 'skipped', xpassed: 'passed', error: 'errors', errors: 'errors',
      rerun: 'reruns' });
    return { ...w, errors: w.errors || 0 };
  }],
  ['jest', (t) => {
    const m = /^Test Suites:/m.test(t) && lastMatch(t, /^Tests:[ \t]+(.+)$/gm);
    return m && words(m[1], { ...SAME, todo: 'skipped', pending: 'skipped', total: 'total' });
  }],
  ['vitest', (t) => {
    const m = lastMatch(t, VITEST_RE);
    return m && words(m[1], { ...SAME, todo: 'skipped', 'expected fail': 'passed' });
  }],
  ['nextest', (t) => {
    const m = lastMatch(t, /^[ \t]*Summary \[[^\]]*\][ \t]+(\d+) tests? run: (.+)$/gm);
    return m && { flaky: 0, ...words(m[2], { ...SAME, flaky: 'flaky', 'timed out': 'failed' }), total: int(m, 1) };
  }],
  ['cargo', (t) => sumAll(t, /^test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored;/gm,
    ['passed', 'failed', 'skipped'])],
  ['go', goSummary],
  ['rspec', (t) => {
    const m = lastMatch(t, RSPEC_RE);
    return m && { ...fromTotal(int(m, 1), { failed: int(m, 2), skipped: int(m, 3) }), errors: int(m, 4) };
  }],
  ['minitest', (t) => {
    const m = lastMatch(t, /(\d+) (?:runs|tests), (\d+) assertions, (\d+) failures, (\d+) errors, (\d+) skips/g);
    return m && fromTotal(int(m, 1), { failed: int(m, 3), errors: int(m, 4), skipped: int(m, 5) });
  }],
  ['unittest', (t) => {
    const ran = lastMatch(t, /^Ran (\d+) tests? in [\d.]+s$/gm);
    const status = ran && /^(?:OK|FAILED)(?: \((.*)\))?$/m.exec(t.slice(ran.index));
    const w = Object.fromEntries(String((status && status[1]) || '').split(/,\s*/).filter(Boolean)
      .map((p) => p.split('=')).map(([k, v]) => [k.trim(), Number(v)]));
    const skipped = (w.skipped || 0) + (w['expected failures'] || 0);
    return ran && fromTotal(int(ran, 1), { failed: w.failures || 0, errors: w.errors || 0, skipped });
  }],
  ['dotnet', (t) => {
    const vstest = sumAll(t, VSTEST_RE, ['failed', 'passed', 'skipped', 'total']);
    const mtp = vstest ? null
      : lastMatch(t, /Test summary: total: (\d+), failed: (\d+), succeeded: (\d+), skipped: (\d+)/gi);
    return vstest || (mtp && { total: int(mtp, 1), failed: int(mtp, 2), passed: int(mtp, 3), skipped: int(mtp, 4) });
  }],
  ['maven', (t) => {
    const m = lastMatch(t, MAVEN_RE);
    return m && fromTotal(int(m, 1), { failed: int(m, 2), errors: int(m, 3), skipped: int(m, 4), flaky: int(m, 5) });
  }],
  ['gradle', (t) => {
    const m = lastMatch(t, /(\d+) tests? completed, (\d+) failed(?:, (\d+) skipped)?/g);
    return m && fromTotal(int(m, 1), { failed: int(m, 2), skipped: int(m, 3) });
  }],
  ['mocha', (t) => {
    const p = lastMatch(t, /^[ \t]*(\d+) passing \(/gm);
    const g = (k) => int(lastMatch(t, countLine(k)), 1);
    return p && { passed: int(p, 1), failed: g('failing'), skipped: g('pending') };
  }],
  ['node-test', (t) => {
    const get = (k) => {
      const m = lastMatch(t, new RegExp(`^(?:ℹ|#) ${k} (\\d+)[ \\t]*$`, 'gm'));
      return m ? Number(m[1]) : null;
    };
    const [passed, failed] = [get('pass'), get('fail')];
    if (passed == null || failed == null) return null;
    return { passed, failed: failed + get('cancelled'), skipped: get('skipped') + get('todo'), total: get('tests') };
  }],
  ['bun', (t) => {
    const ran = lastMatch(t, /^Ran (\d+) tests? across \d+ files?/gm);
    const g = (k) => int(lastMatch(t, countLine(k)), 1);
    return ran && { passed: g('pass'), failed: g('fail'), skipped: g('skip') + g('todo'), total: int(ran, 1) };
  }],
  ['playwright', (t) => {
    if (!/^[ \t]+\d+ (?:passed|failed) ?(?:\([\d.]+m?s\))?[ \t]*$/m.test(t)) return null;
    const g = (k) => int(lastMatch(t, new RegExp(`^[ \\t]+(\\d+) ${k}(?: \\([\\d.]+m?s\\))?[ \\t]*$`, 'gm')), 1);
    return { passed: g('passed'), failed: g('failed') + g('interrupted'), skipped: g('skipped') + g('did not run'),
      flaky: g('flaky') };
  }],
  ['phpunit', (t) => {
    const ok = lastMatch(t, /^OK \((\d+) tests?, \d+ assertions?\)/gm);
    if (ok) return { passed: int(ok, 1), failed: 0, skipped: 0, total: int(ok, 1) };
    const m = lastMatch(t, /^Tests: (\d+), Assertions: \d+(.*)\.$/gm);
    const num = (k) => int(new RegExp(`${k}: (\\d+)`).exec(m ? m[2] : ''), 1);
    return m && fromTotal(int(m, 1), { failed: num('Failures'), errors: num('Errors'),
      skipped: num('Skipped') + num('Incomplete') });
  }],
];

/** Runner summary from console output → `{ runner, passed, failed, skipped, ... }` (null when not stated), or null. */
export function parseSummaryText(text) {
  if (text == null) return null;
  const t = stripAnsi(text).replace(/\r\n?/g, '\n');
  if (!/\d/.test(t)) return null;
  for (const [runner, fn] of SUMMARY_DETECTORS) {
    let o = null;
    try { o = fn(t); } catch {}
    if (!o) continue;
    const extra = Object.fromEntries(['errors', 'flaky', 'total', 'reruns'].filter((k) => o[k] != null)
      .map((k) => [k, o[k]]));
    return { runner, passed: o.passed ?? null, failed: o.failed ?? null, skipped: o.skipped ?? null, ...extra };
  }
  return null;
}
