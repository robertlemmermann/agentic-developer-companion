// Tests for WP-D: report and coverage parsers (reports.mjs), clean-run / red-green / typecheck
// (clean-run.mjs) and the coverage, mutation and flake probes (probes.mjs). End-to-end cases build
// tiny projects in temp git repos and run real runners (node --test always; go and pytest when present).
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as core from '../../scripts/lib/core.mjs';
import * as reports from '../../scripts/lib/reports.mjs';
import * as cr from '../../scripts/lib/clean-run.mjs';
import * as probes from '../../scripts/lib/probes.mjs';
import { prepareTarget } from '../../scripts/lib/state.mjs';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const fixture = (name) => fs.readFileSync(path.join(FIX, 'reports', name), 'utf8');
const ADC = core.ADC_SCRIPT;
process.env.ADC_QUIET = '1';

const TEMP = [];
const tmp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); TEMP.push(d); return d; };
// Go's build cache and its local telemetry counters (written to the user config dir, which
// GOTELEMETRY=off does not prevent) stay in the temp dir: tests leave nothing outside os.tmpdir().
// macOS has no override for that config dir.
const GO_CONFIG = path.join(os.tmpdir(), 'adc-wpd-goconfig');
const GO_ENV = { GOCACHE: path.join(os.tmpdir(), 'adc-wpd-gocache'), GOTOOLCHAIN: 'local', GOFLAGS: '', GOTELEMETRY: 'off',
  ...(process.platform === 'win32' ? { APPDATA: GO_CONFIG } : process.platform === 'darwin' ? {} : { XDG_CONFIG_HOME: GO_CONFIG }) };
Object.assign(process.env, GO_ENV);
after(() => { for (const d of TEMP) fs.rmSync(d, { recursive: true, force: true }); });

const HAS_GO = Boolean(core.which('go'));
// pytest on PATH, else an offline `uv run --with pytest` (uses uv's existing cache), else skipped.
const PYTEST_CMD = (() => {
  if (core.which('pytest')) return 'pytest';
  if (!core.which('uv')) return null;
  const r = spawnSync('uv', ['run', '--offline', '--no-project', '--with', 'pytest', 'pytest', '--version'], { encoding: 'utf8', timeout: 60_000 });
  return r.status === 0 ? 'uv run --offline --no-project --with pytest pytest' : null;
})();
const HAS_PYTEST = Boolean(PYTEST_CMD);
/** Is `pid` running? A zombie counts as dead (PID 1 in some containers never reaps orphans). */
function alive(pid) {
  try { process.kill(pid, 0); } catch { return false; }
  try { return !/^State:\s+Z/m.test(fs.readFileSync(`/proc/${pid}/status`, 'utf8')); } catch { return true; }
}
let HAS_MARKERS = false;
try { HAS_MARKERS = Array.isArray((await import('../../scripts/lib/markers.mjs')).SECRET_PATTERNS); } catch {}

function makeRepo(files = {}) {
  const dir = tmp('adc-wpd-repo-');
  TEMP.push(core.tmpRoot(dir)); // per-repo snapshot and worktree dir under the OS temp dir
  const g = (...args) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 'Test');
  g('config', 'commit.gpgsign', 'false');
  const write = (fs2) => {
    for (const [p, c] of Object.entries(fs2)) {
      const full = path.join(dir, p);
      if (c == null) { fs.rmSync(full, { force: true }); continue; }
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, c);
    }
  };
  write(files);
  g('add', '-A');
  g('commit', '-q', '-m', 'base', '--allow-empty');
  return { dir, g, write, state: tmp('adc-wpd-state-') };
}

function adc(args, { env = {} } = {}) {
  const r = spawnSync(process.execPath, [ADC, ...args, '--json'], { encoding: 'utf8', env: { ...process.env, ADC_QUIET: '1', ...env }, timeout: 120_000 });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch {}
  assert.ok(/^[\x00-\x7e]*$/.test(r.stdout), 'stdout is ASCII-only');
  return { exit: r.status, json, stderr: r.stderr, stdout: r.stdout };
}

const target = (repo) => prepareTarget({ cwd: repo.dir, stateDirOption: repo.state }, {});
const worktrees = (repo) => repo.g('worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length;

const NODE_PROJECT = {
  'package.json': JSON.stringify({ name: 'demo', version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n',
  'src/math.mjs': 'export function add(a, b) { return a + b; }\nexport function div(a, b) { return b === 0 ? 0 : a / b; }\n',
  'test/math.test.mjs': [
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { add, div } from '../src/math.mjs';",
    "test('adds', () => assert.equal(add(1, 2), 3));",
    "test('divides', () => assert.equal(div(4, 2), 2));", '',
  ].join('\n'),
};
const nodeTest = (name, body, imports = "import { add, div } from '../src/math.mjs';") => [
  "import { test } from 'node:test';", "import assert from 'node:assert/strict';", imports, `test(${JSON.stringify(name)}, () => { ${body} });`, '',
].join('\n');
const fallback = (dir) => cr.fallbackDetect(dir);
/** fallbackDetect with the pytest command this machine can run (pytest on PATH or uv). */
const pyDetect = (dir) => {
  const det = cr.fallbackDetect(dir);
  for (const p of det.projects) for (const r of p.runners) if (r.name === 'pytest') r.cmd = PYTEST_CMD;
  return det;
};

// ===========================================================================
// XML reader and helpers

describe('parseXml', () => {
  test('elements, attributes, entities, CDATA, comments, namespaces, BOM and CRLF', () => {
    const xml = '﻿<?xml version="1.0"?>\r\n<!DOCTYPE x>\r\n<!-- c --><a:root xmlns:a="u" k="&lt;v&gt; &#65;&#x42;"><b one=\'1\' two="2"/><c><![CDATA[<raw> & stuff]]> tail &amp; more</c></a:root>';
    const root = reports.parseXml(xml);
    assert.equal(root.name, 'root');
    assert.equal(root.attrs.k, '<v> AB');
    assert.deepEqual(root.children[0].attrs, { one: '1', two: '2' });
    assert.equal(root.children[1].text, '<raw> & stuff tail & more');
  });
  test('tolerates mismatched closers and unclosed elements; rejects non-XML', () => {
    const root = reports.parseXml('<a><b><c></b><d/></a>');
    assert.equal(root.name, 'a');
    assert.deepEqual(root.children.map((c) => c.name), ['b', 'd']);
    assert.throws(() => reports.parseXml('plain text'), /not an XML document/);
  });
});

describe('classifyFailure', () => {
  const cases = [
    [{ element: 'error', message: 'boom' }, 'error'],
    [{ element: 'failure', message: 'expected 4 to be 5', type: 'AssertionError' }, 'assertion'],
    [{ element: 'failure', message: "Cannot find module './x' imported from a" }, 'error'],
    [{ element: 'failure', message: "No module named 'nowhere'", type: 'ModuleNotFoundError' }, 'error'],
    [{ element: 'failure', message: "NameError: name 'f' is not defined", body: "def test():\n>  f()\nE  NameError\n\ntests/test_a.py:4: NameError" }, 'error'],
    [{ element: 'failure', message: "AttributeError: 'NoneType' object has no attribute 'x'", body: 'tests/test_a.py:4: in test\n    run()\nsrc/app.py:9: AttributeError' }, 'assertion'],
    [{ element: 'failure', message: 'notDefined is not defined', body: 'ReferenceError: notDefined is not defined\n    at Object.<anonymous> (/w/test/a.test.js:3:5)' }, 'error'],
    [{ element: 'failure', message: 'x is not a function', body: 'TypeError: x is not a function\n    at run (/w/src/app.js:3:5)\n    at Object.<anonymous> (/w/test/a.test.js:9:1)' }, 'assertion'],
    [{ element: 'failure', type: 'testCodeFailure', message: 'test failed', body: "[Error: test failed] { code: 'ERR_TEST_FAILURE', failureType: 'testCodeFailure', cause: 'test failed', exitCode: 1 }" }, 'error'],
    [{ element: 'failure', type: 'cancelledByParent', message: 'cancelled' }, 'error'],
    [{ element: 'failure', message: 'boom', body: 'error[E0425]: cannot find value `x` in this scope' }, 'error'],
  ];
  for (const [info, want] of cases) test(`${info.element}: ${info.message} -> ${want}`, () => assert.equal(reports.classifyFailure(info), want));
});

// ===========================================================================
// Test-report parsers on the shared fixtures

const byId = (res) => Object.fromEntries(res.tests.map((t) => [t.id, t]));
const counts = ({ executed, passed, failed, errors, skipped, flaky }) => ({ executed, passed, failed, errors, skipped, flaky });

describe('parseReport junit (Vitest, pytest rerun, Surefire, Playwright, nextest)', () => {
  const res = reports.parseReport('junit', fixture('junit.xml'), { root: '/work/demo' });
  const t = byId(res);
  test('totals across all suites', () => {
    assert.equal(res.format, 'junit');
    assert.deepEqual(counts(res), { executed: 24, passed: 9, failed: 7, errors: 4, skipped: 7, flaky: 4 });
  });
  test('vitest: assertion vs load failure, todo and skip are skipped', () => {
    assert.equal(t['vt/math.test.mjs::math > fails'].failure_kind, 'assertion');
    assert.equal(t['vt/math.test.mjs::math > fails'].file, 'vt/math.test.mjs');
    assert.equal(t['vt/broken.test.mjs'].failure_kind, 'error');
    assert.ok(!t['vt/broken.test.mjs'].message.includes('/work/demo') || t['vt/broken.test.mjs'].message.includes('imported from'));
    assert.equal(t['vt/math.test.mjs::math > later'].status, 'skipped');
  });
  test('pytest: rerun attempts collapse; passing final attempt is flaky; collection and setup errors', () => {
    assert.equal(t['tests.test_calc::test_flaky_once'].status, 'flaky');
    assert.equal(t['tests.test_calc::test_flaky_once'].attempts, 2);
    assert.equal(t['tests.test_calc::test_add_wrong'].status, 'failed');
    assert.equal(t['tests.test_calc::test_add_wrong'].failure_kind, 'assertion');
    assert.equal(t['tests.test_calc::test_name_error'].failure_kind, 'error');
    assert.equal(t['tests.test_import'].status, 'error');
    assert.equal(t['tests.test_calc::test_fixture_error'].status, 'error');
    assert.equal(t['tests.test_calc::test_xfail'].status, 'skipped');
    assert.equal(t['tests.test_calc::test_param[2-3-5]'].status, 'passed');
  });
  test('surefire: flakyFailure is flaky, failure + rerunFailure is failed, error element is error', () => {
    assert.equal(t['com.example.CalcTest::flakyAdd'].status, 'flaky');
    assert.equal(t['com.example.CalcTest::alwaysWrong'].status, 'failed');
    assert.equal(t['com.example.CalcTest::alwaysWrong'].reruns, 1);
    assert.equal(t['com.example.CalcTest::crashes'].status, 'error');
    assert.equal(t['com.example.CalcTest::disabled'].status, 'skipped');
  });
  test('playwright and nextest flaky handling', () => {
    assert.equal(t['a.spec.mjs::flaky'].status, 'flaky');
    assert.equal(t['a.spec.mjs::broken'].status, 'failed');
    assert.equal(t['a.spec.mjs::thrower'].status, 'error');
    assert.equal(t['demo::tests::flaky_pass'].status, 'flaky');
    assert.equal(t['demo::tests::flaky_fail'].status, 'failed', 'nextest flaky-fail keeps <failure>');
  });
  test('CRLF line endings parse identically', () => {
    const crlf = reports.parseReport('junit', fixture('junit.xml').replace(/\n/g, '\r\n'), { root: '/work/demo' });
    assert.deepEqual(counts(crlf), counts(res));
  });
  test('duplicates: repeat semantics distinguish repeats from reruns', () => {
    const xml = '<testsuite name="s"><testcase classname="c" name="x"/><testcase classname="c" name="x"><failure message="m"/></testcase><testcase classname="c" name="y"/><testcase classname="c" name="y"/></testsuite>';
    const rep = reports.parseReport('junit', xml, { duplicates: 'repeat' });
    assert.equal(byId(rep)['c::x'].status, 'flaky');
    assert.deepEqual(byId(rep)['c::x'].runs, { passed: 1, failed: 1, skipped: 0 });
    assert.equal(byId(rep)['c::y'].status, 'passed');
    const rerun = reports.parseReport('junit', xml);
    assert.equal(byId(rerun)['c::x'].status, 'failed');
    assert.equal(byId(rerun)['c::y'].status, 'flaky');
  });
  test('suite-level errors are counted; aggregate attributes are a fallback', () => {
    const r = reports.parseReport('junit', '<testsuite name="s" tests="1"><error message="setup crashed"/><testcase name="a"/></testsuite>');
    assert.equal(r.errors, 1);
    assert.equal(r.executed, 2);
    const agg = reports.parseReport('junit', '<testsuites><testsuite name="s" tests="5" failures="1" errors="0" skipped="1"/></testsuites>');
    assert.deepEqual(counts(agg), { executed: 4, passed: 3, failed: 1, errors: 0, skipped: 1, flaky: 0 });
  });
});

describe('parseReport other formats', () => {
  test('jest-json (Jest 30): retried pass is flaky, suite load failure is an error, ids are root-relative', () => {
    const res = reports.parseReport('jest-json', fixture('jest.json'), { root: '/work/demo' });
    assert.deepEqual(counts(res), { executed: 6, passed: 2, failed: 2, errors: 1, skipped: 2, flaky: 1 });
    const t = byId(res);
    assert.equal(t['jt/retry.test.js::flaky retried'].status, 'flaky');
    assert.equal(t['jt/broken.test.js::<suite>'].failure_kind, 'error');
    assert.equal(t['jt/math.test.js::math fails'].failure_kind, 'assertion');
    assert.equal(t['jt/math.test.js::math throws'].failure_kind, 'error', 'ReferenceError raised in the test file');
  });
  test('go-test-json: leaf subtests, build failure entry, shuffle seed', () => {
    const res = reports.parseReport('go-test-json', fixture('go-test.jsonl'));
    assert.deepEqual(counts(res), { executed: 5, passed: 2, failed: 2, errors: 1, skipped: 1, flaky: 0 });
    const t = byId(res);
    assert.ok(!t['example.com/demo/calc::TestTable'], 'parent of subtests is not counted');
    assert.equal(t['example.com/demo/calc::TestTable/two'].status, 'failed');
    assert.equal(t['example.com/demo/broken::[build failed]'].message, 'broken/broken_test.go:5:31: undefined: Y');
    assert.equal(res.seeds.length, 1);
  });
  test('go-test-json: -count=N outcomes collapse to flaky; a panicking package without test results is an error', () => {
    const ev = (a, test) => JSON.stringify({ Action: a, Package: 'p', ...(test ? { Test: test } : {}) });
    const text = [ev('run', 'TestA'), ev('pass', 'TestA'), ev('run', 'TestA'), ev('fail', 'TestA'), ev('fail'), 'not json'].join('\n');
    const t = byId(reports.parseReport('go-test-json', text));
    assert.equal(t['p::TestA'].status, 'flaky');
    const crash = reports.parseReport('go-test-json', [JSON.stringify({ Action: 'output', Package: 'q', Output: 'panic: boom\n' }), ev('fail').replace('"p"', '"q"')].join('\n'));
    assert.equal(crash.errors, 1);
    assert.equal(crash.tests[0].id, 'q::[package failed]');
  });
  test('cargo-text: binaries, doc tests, ignored with reason, panic messages', () => {
    const res = reports.parseReport('cargo-text', fixture('cargo-test.txt'));
    assert.deepEqual(counts(res), { executed: 5, passed: 3, failed: 2, errors: 0, skipped: 2, flaky: 0 });
    const t = byId(res);
    assert.equal(t['demo::tests::adds_wrong'].message, 'assertion `left == right` failed');
    assert.equal(t['demo::tests::net'].message, 'needs network');
    assert.equal(t['integration::it_works'].status, 'passed');
    assert.equal(t['doctest:demo::src/lib.rs - add (line 3)'].status, 'passed');
  });
  test('cargo-text: compile errors and crashed binaries are errors', () => {
    const compile = reports.parseReport('cargo-text', 'error[E0425]: cannot find value `y` in this scope\n --> src/lib.rs:3:5\nerror: could not compile `demo` (lib test) due to 1 previous error\n');
    assert.equal(compile.errors, 1);
    assert.equal(compile.tests[0].failure_kind, 'error');
    const crash = reports.parseReport('cargo-text', '     Running unittests src/lib.rs (target/debug/deps/demo-0123456789abcdef)\n\nrunning 2 tests\ntest a ... ok\nerror: test failed, to rerun pass `--lib`\n');
    assert.equal(byId(crash)['demo::[binary crashed]'].status, 'error');
  });
  test('trx: data-driven inner results, timeout as error, NotExecuted as skipped', () => {
    const res = reports.parseReport('trx', fixture('dotnet.trx'));
    assert.deepEqual(counts(res), { executed: 7, passed: 4, failed: 2, errors: 1, skipped: 1, flaky: 0 });
    const t = byId(res);
    assert.equal(t['Demo.MsTests.RowTests.DataRows (2,5)'].failure_kind, 'assertion');
    assert.equal(t['Demo.MsTests.RowTests.Hangs'].status, 'error');
    assert.ok(t['Demo.Tests.CalcTests.Theory(a: 1, b: 2, want: 3)']);
    const agg = reports.parseReport('trx', '<TestRun><ResultSummary><Counters total="3" executed="3" passed="2" failed="1" error="0" timeout="0" aborted="0" notExecuted="0"/></ResultSummary></TestRun>');
    assert.deepEqual(counts(agg), { executed: 3, passed: 2, failed: 1, errors: 0, skipped: 0, flaky: 0 });
  });
  test('rspec-json: expectation vs missing method in the spec; errors outside of examples', () => {
    const res = reports.parseReport('rspec-json', fixture('rspec.json'), { root: '/work/demo' });
    assert.deepEqual(counts(res), { executed: 3, passed: 1, failed: 2, errors: 0, skipped: 2, flaky: 0 });
    const t = byId(res);
    assert.equal(t['spec/calc_spec.rb::Calc adds wrong'].failure_kind, 'assertion');
    assert.equal(t['spec/calc_spec.rb::Calc raises'].failure_kind, 'error');
    const outside = reports.parseReport('rspec-json', JSON.stringify({ messages: ['\nAn error occurred while loading ./spec/broken_spec.rb. - Did you mean?\nLoadError:\n'], examples: [], summary: { example_count: 0, failure_count: 0, pending_count: 0, errors_outside_of_examples_count: 1 } }));
    assert.equal(outside.errors, 1);
    assert.equal(outside.tests[0].file, 'spec/broken_spec.rb');
  });
  test('format detection and aliases; unknown formats throw', () => {
    const want = { 'junit.xml': 'junit', 'dotnet.trx': 'trx', 'jest.json': 'jest-json', 'go-test.jsonl': 'go-test-json', 'cargo-test.txt': 'cargo-text', 'rspec.json': 'rspec-json' };
    for (const [f, fmt] of Object.entries(want)) assert.equal(reports.detectReportFormat(fixture(f)), fmt, f);
    assert.equal(reports.parseReport('auto', fixture('go-test.jsonl')).format, 'go-test-json');
    assert.equal(reports.normalizeFormat('surefire'), 'junit');
    assert.throws(() => reports.parseReport('nope', ''), /unknown report format/);
  });
});

// ===========================================================================
// Coverage parsers: four formats of the same run agree

describe('parseCoverage', () => {
  const expectMjs = { lines: { 2: 2, 5: 1, 6: 0, 8: 1 }, branches: { 5: [1, 2] } };
  test('lcov, cobertura and istanbul agree on src/math.mjs', () => {
    for (const [fmt, file] of [['lcov', 'lcov.info'], ['cobertura', 'cobertura.xml'], ['istanbul', 'istanbul.json']]) {
      const res = reports.parseCoverage(fmt, fixture(file), { root: '/work/demo' });
      assert.deepEqual(res.files['src/math.mjs'], expectMjs, fmt);
      assert.deepEqual(Object.keys(res.files).sort(), ['src/math.js', 'src/math.mjs'], fmt);
      assert.equal(reports.detectCoverageFormat(fixture(file)), fmt);
    }
  });
  test('go cover profile maps import paths through the module', () => {
    const res = reports.parseCoverage('go-cover', fixture('go-cover.out'), { goModule: { module: 'example.com/demo', dir: 'svc' } });
    assert.deepEqual(res.files['svc/calc/calc.go'].lines, { 3: 1, 5: 0, 6: 0, 7: 0, 8: 0, 9: 0 });
  });
  test('istanbul summary yields file-level data; CRLF lcov', () => {
    const sum = reports.parseCoverage('auto', JSON.stringify({ total: { lines: { total: 4, covered: 2, pct: 50 } }, '/r/a.js': { lines: { total: 4, covered: 2, pct: 50 } } }), { root: '/r' });
    assert.equal(sum.format, 'istanbul-summary');
    assert.equal(sum.files['a.js'].summary.pct, 50);
    const crlf = reports.parseCoverage('lcov', 'SF:a.js\r\nDA:1,0\r\nDA:2,3\r\nend_of_record\r\n');
    assert.deepEqual(crlf.files['a.js'].lines, { 1: 0, 2: 3 });
  });
});

// ===========================================================================
// Summary lines (post-shell hook)

describe('parseSummaryText', () => {
  const cases = [
    ['jest', 'Test Suites: 1 failed, 2 passed, 3 total\nTests:       1 failed, 1 skipped, 1 todo, 3 passed, 6 total\n', { passed: 3, failed: 1, skipped: 2 }],
    ['vitest', ' Test Files  1 failed | 1 passed (2)\n      Tests  1 failed | 4 passed | 2 skipped (7)\n', { passed: 4, failed: 1, skipped: 2 }],
    ['pytest', '==== 2 failed, 4 passed, 1 skipped, 1 xfailed, 2 errors, 4 rerun in 0.05s ====\n', { passed: 4, failed: 2, skipped: 2 }],
    ['pytest', '2 passed in 0.01s\n', { passed: 2, failed: 0, skipped: 0 }],
    ['cargo', 'test result: FAILED. 1 passed; 2 failed; 2 ignored; 0 measured; 0 filtered out; finished in 0.00s\ntest result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out\n', { passed: 2, failed: 2, skipped: 2 }],
    ['nextest', '     Summary [   0.010s] 4 tests run: 3 passed, 1 failed, 2 skipped\n', { passed: 3, failed: 1, skipped: 2 }],
    ['go', '=== RUN   TestA\n--- PASS: TestA (0.00s)\n=== RUN   TestT\n    --- FAIL: TestT/x (0.00s)\n--- FAIL: TestT (0.00s)\nFAIL\tm/p\t0.01s\n', { passed: 1, failed: 1, skipped: 0 }],
    ['go', '--- FAIL: TestB (0.00s)\nFAIL\tm/p\t0.01s\nok  \tm/q\t0.02s\n', { passed: null, failed: 1, skipped: null }],
    ['rspec', '5 examples, 2 failures, 2 pending\n', { passed: 1, failed: 2, skipped: 2 }],
    ['minitest', '3 runs, 5 assertions, 1 failures, 0 errors, 1 skips\n', { passed: 1, failed: 1, skipped: 1 }],
    ['unittest', 'Ran 4 tests in 0.002s\n\nFAILED (failures=1, skipped=1)\n', { passed: 2, failed: 1, skipped: 1 }],
    ['dotnet', 'Failed!  - Failed:     1, Passed:     2, Skipped:     1, Total:     4, Duration: 3 ms\n', { passed: 2, failed: 1, skipped: 1 }],
    ['dotnet', 'Test summary: total: 3, failed: 0, succeeded: 3, skipped: 0, duration: 0.5s\n', { passed: 3, failed: 0, skipped: 0 }],
    ['maven', '[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.01 s - in a.B\n[ERROR] Tests run: 5, Failures: 1, Errors: 1, Skipped: 1, Flakes: 1\n', { passed: 1, failed: 1, skipped: 1 }],
    ['gradle', '5 tests completed, 1 failed, 1 skipped\n', { passed: 3, failed: 1, skipped: 1 }],
    ['mocha', '  3 passing (12ms)\n  1 pending\n  1 failing\n', { passed: 3, failed: 1, skipped: 1 }],
    ['node-test', 'ℹ tests 4\nℹ suites 0\nℹ pass 3\nℹ fail 1\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\n', { passed: 3, failed: 1, skipped: 0 }],
    ['node-test', '# tests 2\n# pass 2\n# fail 0\n# skipped 1\n', { passed: 2, failed: 0, skipped: 1 }],
    ['bun', ' 3 pass\n 1 fail\nRan 4 tests across 1 files. [10ms]\n', { passed: 3, failed: 1, skipped: 0 }],
    ['playwright', '  2 failed\n  1 flaky\n  1 skipped\n  1 passed (2.6s)\n', { passed: 1, failed: 2, skipped: 1 }],
    ['phpunit', 'Tests: 4, Assertions: 6, Failures: 1, Skipped: 1.\n', { passed: 2, failed: 1, skipped: 1 }],
  ];
  for (const [runner, text, want] of cases) {
    test(`${runner}: ${JSON.stringify(text.slice(0, 40))}`, () => {
      const s = reports.parseSummaryText(`\x1b[32m${text.replace(/\n/g, '\r\n')}\x1b[0m`);
      assert.ok(s, 'parsed');
      assert.equal(s.runner, runner);
      assert.deepEqual({ passed: s.passed, failed: s.failed, skipped: s.skipped }, want);
    });
  }
  test('unrelated output and empty input give null', () => {
    assert.equal(reports.parseSummaryText('compiled 3 files in 2 seconds'), null);
    assert.equal(reports.parseSummaryText(''), null);
    assert.equal(reports.parseSummaryText(null), null);
  });
});

// ===========================================================================
// clean-run helpers

describe('clean-run helpers', () => {
  test('appendArgs inserts `--` for npm scripts and keeps cargo libtest args last', () => {
    assert.equal(cr.appendArgs('npm test', ['--a']), 'npm test -- --a');
    assert.equal(cr.appendArgs('npm test -- --x', ['--a']), 'npm test -- --x --a');
    assert.equal(cr.appendArgs('npx vitest run', ['--a', '']), 'npx vitest run --a');
    assert.equal(cr.appendArgs('npm run unit', ['--a']), 'npm run unit -- --a');
    assert.equal(cr.appendArgs('npm run test:unit', ['--a']), 'npm run test:unit -- --a');
    assert.equal(cr.appendArgs('npm t', ['--a']), 'npm t -- --a');
    assert.equal(cr.appendArgs('pnpm test', ['--a']), 'pnpm test --a');
    assert.equal(cr.appendArgs('cargo test -- --test-threads=1', ['--no-fail-fast']), 'cargo test --no-fail-fast -- --test-threads=1');
  });
  test('substitute quotes paths outside double quotes and inserts them raw inside', () => {
    const v = { f: path.join(os.tmpdir(), 'a b', 'r.trx') };
    const out = cr.substitute('--logger "trx;LogFileName=<f>" --out <f>', v);
    const raw = core.IS_WINDOWS ? v.f : core.toPosix(v.f);
    assert.ok(out.includes(`"trx;LogFileName=${raw}"`));
    assert.ok(out.endsWith(core.quoteArg(raw)));
  });
  test('buildRunCommand: report flags, retries off last, env placeholders, selection and shuffle', () => {
    const outDir = tmp('adc-wpd-build-');
    const vit = cr.resolveRunner({ runners: [{ name: 'vitest', cmd: 'npm test' }] });
    const b = cr.buildRunCommand(vit, { dir: outDir, outDir, select: { files: ['src/a.test.ts'], names: [] }, seed: 7 });
    assert.match(b.cmd, /^npm test -- --reporter=junit --outputFile=\S+report\.xml --retry=0 --sequence\.shuffle --sequence\.seed=7 src\/a\.test\.ts$/);
    assert.equal(b.report.format, 'junit');
    const pw = cr.buildRunCommand(cr.resolveRunner({}, 'playwright'), { dir: outDir, outDir });
    assert.ok(pw.env.PLAYWRIGHT_JUNIT_OUTPUT_NAME.endsWith('report.xml'));
    assert.match(pw.cmd, /--reporter=junit --retries=0$/);
    const go = cr.buildRunCommand(cr.resolveRunner({}, 'go'), { dir: outDir, outDir, select: { files: ['calc/calc_test.go'], names: ['TestAdd'] } });
    assert.match(go.cmd, /^go test \.\/calc -json -count=1 '?-run=\^\(\?:TestAdd\)\$'?$/);
    assert.ok(go.report.stdout);
    const cargo = cr.buildRunCommand(cr.resolveRunner({}, 'cargo'), { dir: outDir, outDir, select: { files: ['tests/api.rs'], names: [] } });
    assert.equal(cargo.cmd, 'cargo test --no-fail-fast --test api');
    const dn = cr.buildRunCommand(cr.resolveRunner({}, 'dotnet'), { dir: outDir, outDir });
    assert.ok(dn.report.dir && dn.report.glob === '*.trx');
  });
  test('resolveRunner: detected entry completed from defaults; --runner name, alias and command line', () => {
    const p = { runners: [{ name: 'jest', cmd: 'npx jest' }, { name: 'playwright', cmd: 'npx playwright test' }], test_script: 'jest' };
    const r = cr.resolveRunner(p);
    assert.equal(r.name, 'jest');
    assert.equal(r.report.format, 'jest-json');
    assert.equal(r.retries_off.coverage, 'partial');
    assert.equal(cr.resolveRunner(p, 'playwright').cmd, 'npx playwright test');
    assert.equal(cr.resolveRunner({}, 'node:test').name, 'node-test');
    const custom = cr.resolveRunner({}, 'make test');
    assert.equal(custom.name, 'custom');
    assert.equal(custom.report, null);
    assert.throws(() => cr.resolveRunner({}, 'nonsense'), (e) => e.exit === 2);
    assert.equal(cr.resolveRunner({ runners: [] }), null);
  });
  test('evaluateRun implements the §9.1.1 outcomes', () => {
    const c = (o) => ({ executed: 3, passed: 3, failed: 0, errors: 0, skipped: 0, flaky: 0, ...o });
    const run = (o, extra = {}) => ({ exit: 0, counts: c(o), source: 'report', ...extra });
    const base = c({});
    assert.deepEqual(cr.evaluateRun(run({}), base), { status: 'pass', reason: null });
    assert.equal(cr.evaluateRun(run({ executed: 0, passed: 0 }), base).reason, 'NO_TESTS_EXECUTED');
    assert.equal(cr.evaluateRun(run({ failed: 1 }), base).status, 'fail');
    assert.equal(cr.evaluateRun(run({ errors: 1 }), base).reason, 'TESTS_FAILED');
    assert.deepEqual(cr.evaluateRun(run({ executed: 2, passed: 2 }), base), { status: 'fail', reason: 'COUNT_SHORTFALL', shortfall: 1 });
    assert.equal(cr.evaluateRun(run({ executed: 2, passed: 2 }), base, { explained: 1 }).status, 'finding');
    assert.equal(cr.evaluateRun(run({ skipped: 1 }), base).status, 'finding');
    assert.equal(cr.evaluateRun(run({ skipped: 1 }), base, { skipFired: true }).status, 'fail');
    assert.equal(cr.evaluateRun(run({ flaky: 1 }), base).reason, 'FLAKY');
    assert.equal(cr.evaluateRun(run({}, { exit: 1 }), base).reason, 'EXIT_NONZERO');
    assert.equal(cr.evaluateRun({ exit: 127, counts: null }, base).reason, 'RUNNER_NOT_FOUND');
    assert.equal(cr.evaluateRun({ exit: 1, counts: null, source: 'none' }, base).reason, 'NO_REPORT');
    assert.equal(cr.evaluateRun({ timedOut: true, counts: null }, base).reason, 'TIMEOUT');
  });
  test('testMatchesFile: file attributes, path ids, dotted modules, go packages', () => {
    assert.ok(cr.testMatchesFile({ id: 'x::y', file: 'test/a.test.mjs' }, 'test/a.test.mjs'));
    assert.ok(cr.testMatchesFile({ id: 'vt/a.test.mjs::t' }, 'pkg/vt/a.test.mjs', { projectRoot: 'pkg' }));
    assert.ok(cr.testMatchesFile({ id: 'tests.test_calc::test_add' }, 'tests/test_calc.py'));
    assert.ok(cr.testMatchesFile({ id: 'm/calc::TestA', package: 'm/calc' }, 'calc/calc_test.go', { goModule: 'm' }));
    assert.ok(!cr.testMatchesFile({ id: 'm/other::TestA', package: 'm/other' }, 'calc/calc_test.go', { goModule: 'm' }));
    assert.ok(!cr.testMatchesFile({ id: 'tests.test_other::t' }, 'tests/test_calc.py'));
  });
  test('importBaseCounts accepts clean-run output, a map by project and a bare counts object', () => {
    const dir = tmp('adc-wpd-bc-');
    const w = (name, obj) => { const f = path.join(dir, name); fs.writeFileSync(f, JSON.stringify(obj)); return f; };
    assert.equal(cr.importBaseCounts(w('a.json', { projects: [{ root: '.', run: { executed: 9, passed: 9, failed: 0, errors: 0, skipped: 1, flaky: 0 } }] }), '.').executed, 9);
    assert.equal(cr.importBaseCounts(w('b.json', { projects: { 'pkg/a': { executed: 4, skipped: 0 } } }), 'pkg/a').executed, 4);
    assert.equal(cr.importBaseCounts(w('c.json', { executed: 2, passed: 2 }), '.').passed, 2);
    assert.throws(() => cr.importBaseCounts(path.join(dir, 'missing.json'), '.'), (e) => e.exit === 2);
  });
  test('parseTypeErrors and newErrors (line numbers ignored, multiset by file + code + message)', () => {
    const out = [
      'src/a.ts(3,5): error TS2322: Type \'string\' is not assignable to type \'number\'.',
      'src/b.ts:7:1 - error TS2304: Cannot find name \'x\'.',
      'error TS5023: Unknown compiler option \'nope\'.',
      'pkg/mod.py:12: error: Incompatible return value  [return-value]',
      'pkg/mod.py:13:5: note: see here',
      '  /w/app.py:4:9 - error: "y" is not defined (reportUndefinedVariable)',
      './calc/calc.go:9:2: fmt.Printf format %d has arg "x" of wrong type string',
      'src/lib.rs:2:5: error[E0308]: mismatched types',
      'src/lib.rs:2:5: warning: unused variable: `x`',
      '/w/Program.cs(10,13): error CS0103: The name \'z\' does not exist in the current context [/w/app.csproj]',
      '/w/Program.cs(10,13): error CS0103: The name \'z\' does not exist in the current context [/w/app.csproj]',
      '[ERROR] /w/src/App.java:[5,9] cannot find symbol',
    ].join('\r\n');
    const errs = cr.parseTypeErrors(out, { roots: ['/w'] });
    // msbuild prints every error twice (inline and in the summary): one entry; notes and warnings dropped.
    assert.equal(errs.length, 9);
    assert.deepEqual(errs.map((e) => e.code).filter(Boolean), ['TS2322', 'TS2304', 'TS5023', 'return-value', 'reportUndefinedVariable', 'E0308', 'CS0103']);
    assert.ok(errs.some((e) => e.file === 'app.py'));
    assert.ok(errs.some((e) => e.file === 'calc/calc.go'));
    const base = [{ file: 'a.ts', code: 'TS1', message: 'm', line: 3 }, { file: 'a.ts', code: 'TS1', message: 'm', line: 9 }];
    const head = [{ file: 'a.ts', code: 'TS1', message: 'm', line: 30 }, { file: 'a.ts', code: 'TS1', message: 'm', line: 31 }, { file: 'a.ts', code: 'TS1', message: 'm', line: 40 }, { file: 'b.ts', code: 'TS2', message: 'n', line: 1 }];
    assert.deepEqual(cr.newErrors(base, head).map((e) => `${e.file}:${e.line}`), ['a.ts:40', 'b.ts:1']);
  });
  test('parseRedGreenSpec splits lists and test names', () => {
    assert.deepEqual(cr.parseRedGreenSpec(['a.test.js, b.test.js', 'c.py::test_x', 'my tests/d.test.js']), [
      { file: 'a.test.js', name: null }, { file: 'b.test.js', name: null }, { file: 'c.py', name: 'test_x' }, { file: 'my tests/d.test.js', name: null },
    ]);
  });
  test('runEnv strips narrowing variables and live credentials, sets CI', () => {
    const saved = { ...process.env };
    process.env.PYTEST_ADDOPTS = '-k x';
    process.env.ADC_LIVE_TOKEN = ['hun', 'ter2', 'abc'].join('');
    try {
      const { env, removed } = cr.runEnv();
      assert.equal(env.PYTEST_ADDOPTS, undefined);
      assert.equal(env.ADC_LIVE_TOKEN, undefined);
      assert.equal(env.CI, 'true');
      assert.ok(removed.includes('PYTEST_ADDOPTS') && removed.includes('ADC_LIVE_*'));
    } finally {
      for (const k of ['PYTEST_ADDOPTS', 'ADC_LIVE_TOKEN']) if (!(k in saved)) delete process.env[k];
    }
  });
  test('fallbackDetect recognizes node --test, go, cargo and pytest projects', () => {
    const d = tmp('adc-wpd-detect-');
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ scripts: { test: 'node --test test/' } }));
    fs.writeFileSync(path.join(d, 'package-lock.json'), '{}');
    fs.writeFileSync(path.join(d, 'go.mod'), 'module x\n');
    const det = cr.fallbackDetect(d);
    const names = det.projects[0].runners.map((r) => r.name);
    assert.deepEqual(names, ['node-test', 'go']);
    assert.equal(det.projects[0].runners[0].cmd, 'node --test test/');
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ scripts: { test: 'node --test --test-reporter=spec --test-reporter-destination stdout test/' } }));
    assert.equal(cr.fallbackDetect(d).projects[0].runners[0].cmd, 'node --test test/');
    assert.equal(det.projects[0].managers[0].install, 'npm ci');
    assert.equal(cr.fallbackDetect(tmp('adc-wpd-empty-')).projects.length, 0);
  });
});

// ===========================================================================
// clean-run end to end (node --test)

describe('clean-run end to end', () => {
  test('CLI: untracked new test passes; counts vs base; artifacts; repo untouched; worktrees pruned', () => {
    const repo = makeRepo(NODE_PROJECT);
    repo.write({ 'test/more.test.mjs': nodeTest('adds negatives', 'assert.equal(add(-1, -2), -3);') });
    const before = repo.g('status', '--porcelain');
    const r = adc(['clean-run', '--cwd', repo.dir, '--state-dir', repo.state, '--runner', 'node-test']);
    assert.equal(r.exit, 0, r.stderr);
    const p = r.json.projects[0];
    assert.equal(r.json.status, 'pass');
    assert.equal(p.run.executed, 3);
    assert.equal(p.base_counts.executed, 2);
    assert.equal(p.base_counts.source, 'run');
    assert.equal(p.delta.executed, 1);
    assert.equal(p.run.retries_disabled, 'full');
    const ck = r.json.checks.find((c) => c.id === 'CK-CLEANRUN');
    assert.deepEqual(ck.fm, ['FM-02', 'FM-13']);
    assert.match(ck.summary, /3 executed, 3 passed, 0 failed/);
    // Snapshot log + report, and the base run's log + report that back the base counts.
    assert.equal(ck.artifacts.length, 4);
    assert.equal(ck.artifacts.filter((a) => /\/base-[^/]+$/.test(a)).length, 2);
    for (const a of ck.artifacts) assert.ok(fs.existsSync(path.isAbsolute(a) ? a : path.join(repo.dir, a)), a);
    assert.equal(ck.output_sha256, core.sha256(fs.readFileSync(ck.artifacts.find((a) => a.endsWith('/run.log')), 'utf8')));
    assert.equal(repo.g('status', '--porcelain'), before);
    assert.equal(worktrees(repo), 1);
    const hashes = ck.artifacts.map((a) => core.sha256(fs.readFileSync(a)));
    // Second run: base counts come from the cache; its artifacts never overwrite the first run's
    // (a ledger hashed those when the check was added).
    const again = adc(['clean-run', '--cwd', repo.dir, '--state-dir', repo.state, '--runner', 'node-test']);
    assert.equal(again.json.projects[0].base_counts.source, 'cache');
    const ck2 = again.json.checks.find((c) => c.id === 'CK-CLEANRUN');
    assert.ok(ck2.artifacts.every((a) => !ck.artifacts.includes(a)), 'a new run folder');
    assert.deepEqual(ck.artifacts.map((a) => core.sha256(fs.readFileSync(a))), hashes);
    const nobase = adc(['clean-run', '--cwd', repo.dir, '--state-dir', repo.state, '--runner', 'node-test', '--no-base']);
    assert.equal(nobase.json.projects[0].delta, null);
  });

  test('failing test in the snapshot: FAIL with the failing id; exit 1', async () => {
    const repo = makeRepo(NODE_PROJECT);
    repo.write({ 'src/math.mjs': 'export function add(a, b) { return a - b; }\nexport function div(a, b) { return b === 0 ? 0 : a / b; }\n' });
    const res = await cr.cleanRun({ target: await target(repo), detectResult: fallback(repo.dir), detectFn: fallback });
    assert.equal(res.status, 'fail');
    assert.equal(res.checks[0].reason, 'TESTS_FAILED');
    assert.ok(res.checks[0].findings.some((f) => /failed: .*adds/.test(f.message)));
    assert.equal(cr.exitFor(res.status), 1);
  });

  test('deleted test: COUNT_SHORTFALL fails; a waived CK-TEST-DEL deletion makes it a finding', async () => {
    const repo = makeRepo({ ...NODE_PROJECT, 'test/old.test.mjs': nodeTest('legacy', 'assert.ok(true);') });
    repo.write({ 'test/old.test.mjs': null });
    const t = await target(repo);
    const res = await cr.cleanRun({ target: t, detectResult: fallback(repo.dir), detectFn: fallback });
    assert.equal(res.status, 'fail');
    assert.equal(res.checks[0].reason, 'COUNT_SHORTFALL');
    const waived = await cr.cleanRun({ target: t, detectResult: fallback(repo.dir), detectFn: fallback, waivers: [{ check: 'CK-TEST-DEL', file: 'test/old.test.mjs' }] });
    assert.equal(waived.status, 'finding');
    assert.equal(waived.checks[0].reason, 'SHORTFALL_WAIVED');
    assert.equal(waived.checks[0].data.shortfall_explained, 1);
  });

  test('narrowed test script in the snapshot: the base runs its own command, so the shortfall is caught', async () => {
    const repo = makeRepo({ ...NODE_PROJECT, 'test/extra.test.mjs': nodeTest('extra', 'assert.ok(true);') });
    const pkg = JSON.parse(NODE_PROJECT['package.json']);
    pkg.scripts.test = 'node --test test/math.test.mjs';
    repo.write({ 'package.json': JSON.stringify(pkg) });
    const res = await cr.cleanRun({ target: await target(repo), detectResult: fallback(repo.dir), detectFn: fallback });
    assert.equal(res.projects[0].run.executed, 2);
    assert.equal(res.projects[0].base_counts.executed, 3);
    assert.equal(res.checks[0].reason, 'COUNT_SHORTFALL');
  });

  test('new skip marker: finding; FAIL when CK-SKIP also fired', async () => {
    const repo = makeRepo(NODE_PROJECT);
    repo.write({ 'test/math.test.mjs': NODE_PROJECT['test/math.test.mjs'].replace("test('divides', ()", "test('divides', { skip: true }, ()") });
    const t = await target(repo);
    const res = await cr.cleanRun({ target: t, detectResult: fallback(repo.dir), detectFn: fallback });
    assert.equal(res.status, 'finding');
    assert.equal(res.checks[0].reason, 'SKIP_INCREASE');
    const fired = await cr.cleanRun({ target: t, detectResult: fallback(repo.dir), detectFn: fallback, firedChecks: ['CK-SKIP'] });
    assert.equal(fired.status, 'fail');
  });

  test('opaque custom command line: counts from summary lines; --base-counts import', async () => {
    const repo = makeRepo({ ...NODE_PROJECT, 'run-tests.cjs': "require('node:child_process').execFileSync(process.execPath, ['--test'], { stdio: 'inherit' });\n" });
    repo.write({ 'src/extra.mjs': 'export const x = 1;\n' });
    const countsFile = path.join(repo.state, 'base-counts.json');
    fs.writeFileSync(countsFile, JSON.stringify({ projects: [{ root: '.', run: { executed: 2, passed: 2, failed: 0, errors: 0, skipped: 0, flaky: 0 } }] }));
    const res = await cr.cleanRun({ target: await target(repo), detectResult: fallback(repo.dir), runner: 'node run-tests.cjs', baseCountsFile: countsFile });
    const p = res.projects[0];
    assert.equal(p.run.runner, 'custom');
    assert.equal(p.run.count_source, 'summary-text');
    assert.equal(p.run.executed, 2);
    assert.equal(p.base_counts.source, 'file');
    assert.equal(res.status, 'pass');
  });

  test('unknown stack: UNVERIFIED NO_RUNNER (exit 4); --dry-run plans without running', () => {
    const repo = makeRepo({ 'README.md': '# x\n' });
    repo.write({ 'README.md': '# y\n' });
    const r = adc(['clean-run', '--cwd', repo.dir, '--state-dir', repo.state]);
    assert.equal(r.exit, 4);
    assert.equal(r.json.checks[0].reason, 'NO_RUNNER');
    const node = makeRepo(NODE_PROJECT);
    node.write({ 'src/math.mjs': '// changed\n' + NODE_PROJECT['src/math.mjs'] });
    const dry = adc(['clean-run', '--cwd', node.dir, '--state-dir', node.state, '--runner', 'node-test', '--dry-run']);
    assert.equal(dry.exit, 0);
    assert.equal(dry.json.checks[0].reason, 'DRY_RUN');
    assert.equal(worktrees(node), 1);
    assert.ok(!fs.existsSync(path.join(core.tmpRoot(node.dir), 'dry-run-out')), 'a dry run writes no output dirs');
    assert.ok(!fs.existsSync(path.join(node.state, 'cache')));
  });

  test('timeout kills the whole process tree and yields UNVERIFIED', { skip: core.IS_WINDOWS && 'POSIX process groups' }, async () => {
    const repo = makeRepo(NODE_PROJECT);
    repo.write({ 'src/math.mjs': '// changed\n' + NODE_PROJECT['src/math.mjs'] });
    const pidFile = path.join(repo.state, 'grandchild.pid');
    const script = `const { spawn } = require('node:child_process'); const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' }); require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); setTimeout(() => {}, 30000);`;
    const scriptFile = path.join(repo.state, 'hang.cjs');
    fs.writeFileSync(scriptFile, script);
    const started = Date.now();
    const res = await cr.cleanRun({ target: await target(repo), detectResult: fallback(repo.dir), runner: `node ${core.quoteArg(scriptFile)}`, noBase: true, timeoutS: 1 });
    assert.ok(Date.now() - started < 15_000);
    assert.equal(res.checks[0].reason, 'TIMEOUT');
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(alive(pid), false, 'grandchild was killed');
  });

  test('live token never reaches the run; secret shapes are redacted from stored logs', async () => {
    const repo = makeRepo(NODE_PROJECT);
    repo.write({ 'src/math.mjs': '// changed\n' + NODE_PROJECT['src/math.mjs'] });
    const token = ['hunter2', 'abcXYZ', '987'].join('');
    const shape = ['AKIA', 'IOSFODNN7', 'EXAMPLE'].join('');
    const printer = path.join(repo.state, 'print.cjs');
    fs.writeFileSync(printer, "console.log('token=' + (process.env.ADC_LIVE_TOKEN || 'absent')); console.log(['AKIA', 'IOSFODNN7', 'EXAMPLE'].join('')); console.log('# pass 1'); console.log('# fail 0');\n");
    process.env.ADC_LIVE_TOKEN = token;
    try {
      const res = await cr.cleanRun({ target: await target(repo), detectResult: fallback(repo.dir), runner: `node ${core.quoteArg(printer)}`, noBase: true });
      const log = fs.readFileSync(res.checks[0].artifacts.find((a) => a.endsWith('run.log')), 'utf8');
      assert.ok(log.includes('token=absent'));
      assert.ok(!log.includes(token));
      if (HAS_MARKERS) assert.ok(!log.includes(shape), 'secret shape redacted');
      assert.ok(!JSON.stringify(res).includes(token));
    } finally {
      delete process.env.ADC_LIVE_TOKEN;
    }
  });
});

// ===========================================================================
// Red-green proof

describe('clean-run --red-green', () => {
  const BUGGY = { ...NODE_PROJECT, 'src/math.mjs': 'export function add(a, b) { return a + b; }\nexport function div(a, b) { return b === 2 ? 0 : a / b; }\n' };
  const FIXED = 'export function add(a, b) { return a + b; }\nexport function div(a, b) { return b === 0 ? 0 : a / b; }\n';

  test('CLI: assertion failure on the base, pass in the snapshot -> CK-REDGREEN pass', () => {
    const repo = makeRepo(BUGGY);
    repo.write({ 'src/math.mjs': FIXED, 'test/regress.test.mjs': nodeTest('divides by two', 'assert.equal(div(8, 2), 4);') });
    const r = adc(['clean-run', '--cwd', repo.dir, '--state-dir', repo.state, '--runner', 'node-test', '--no-base', '--red-green', 'test/regress.test.mjs']);
    assert.equal(r.exit, 0, JSON.stringify(r.json && r.json.checks.map((c) => [c.status, c.summary, c.findings])));
    const rg = r.json.checks.find((c) => c.id === 'CK-REDGREEN');
    assert.equal(rg.status, 'pass');
    assert.equal(r.json.red_green.pairs.length, 1);
    assert.deepEqual(r.json.red_green.pairs[0].base, { status: 'failed', failure_kind: 'assertion', message: r.json.red_green.pairs[0].base.message });
    assert.equal(r.json.red_green.pairs[0].head.status, 'passed');
    assert.ok(r.json.red_green.base_report && r.json.red_green.head_report);
    assert.equal(worktrees(repo), 1);
  });

  test('a test that passes on the base does not reproduce the bug: NOT_RED', async () => {
    const repo = makeRepo(BUGGY);
    repo.write({ 'src/math.mjs': FIXED, 'test/regress.test.mjs': nodeTest('adds', 'assert.equal(add(1, 1), 2);') });
    const res = await cr.cleanRun({ target: await target(repo), detectResult: fallback(repo.dir), noBase: true, redGreen: ['test/regress.test.mjs'] });
    assert.equal(res.red_green.status, 'fail');
    assert.equal(res.red_green.reason, 'NOT_RED');
  });

  test('a test that cannot load on the base (new module) is not a red', async () => {
    const repo = makeRepo(BUGGY);
    repo.write({ 'src/math.mjs': FIXED, 'src/newmod.mjs': 'export const half = (x) => x / 2;\n', 'test/regress.test.mjs': nodeTest('halves', 'assert.equal(half(4), 2);', "import { half } from '../src/newmod.mjs';") });
    const res = await cr.cleanRun({ target: await target(repo), detectResult: fallback(repo.dir), noBase: true, redGreen: ['test/regress.test.mjs'] });
    assert.equal(res.red_green.status, 'fail');
    assert.ok(['WRONG_FAILURE_KIND', 'NOT_EXECUTED_LOAD_ERROR'].includes(res.red_green.reason), res.red_green.reason);
  });

  test('a test that still fails in the snapshot: NOT_GREEN', async () => {
    const repo = makeRepo(BUGGY);
    repo.write({ 'test/regress.test.mjs': nodeTest('divides by two', 'assert.equal(div(8, 2), 4);') });
    const res = await cr.cleanRun({ target: await target(repo), detectResult: fallback(repo.dir), noBase: true, redGreen: ['test/regress.test.mjs'] });
    assert.equal(res.red_green.reason, 'NOT_GREEN');
  });

  test('go: package selection with -run; red on the base, green in the snapshot', { skip: !HAS_GO && 'go not installed' }, async () => {
    const repo = makeRepo({
      'go.mod': 'module example.com/m\n\ngo 1.21\n',
      'calc/calc.go': 'package calc\n\nfunc Half(x int) int { return x / 3 }\n',
      'calc/calc_test.go': 'package calc\n\nimport "testing"\n\nfunc TestZero(t *testing.T) { if Half(0) != 0 { t.Fatal("zero") } }\n',
    });
    repo.write({ 'calc/calc.go': 'package calc\n\nfunc Half(x int) int { return x / 2 }\n', 'calc/half_test.go': 'package calc\n\nimport "testing"\n\nfunc TestHalfOfSix(t *testing.T) {\n\tif got := Half(6); got != 3 {\n\t\tt.Errorf("Half(6) = %d, want 3", got)\n\t}\n}\n' });
    const res = await cr.cleanRun({ target: await target(repo), detectResult: fallback(repo.dir), detectFn: fallback, redGreen: ['calc/half_test.go'] });
    assert.equal(res.projects[0].status, 'pass', JSON.stringify(res.projects[0]));
    assert.equal(res.projects[0].run.executed, 2);
    assert.equal(res.red_green.status, 'pass', JSON.stringify(res.red_green));
    assert.deepEqual(res.red_green.pairs.map((p) => p.id), ['example.com/m/calc::TestHalfOfSix']);
  });

  test('pytest: red-green on a new test file; the clean run counts against the base', { skip: !HAS_PYTEST && 'pytest not available' }, async () => {
    const repo = makeRepo({ 'pytest.ini': '[pytest]\npythonpath = .\n', 'app.py': 'def double(x):\n    return x + x + 1\n', 'tests/test_app.py': 'from app import double\n\ndef test_zero():\n    assert double(0) in (0, 1)\n' });
    repo.write({ 'app.py': 'def double(x):\n    return x + x\n', 'tests/test_double.py': 'from app import double\n\ndef test_two():\n    assert double(2) == 4\n' });
    const res = await cr.cleanRun({ target: await target(repo), detectResult: pyDetect(repo.dir), detectFn: pyDetect, redGreen: ['tests/test_double.py'] });
    assert.equal(res.projects[0].run.runner, 'pytest');
    assert.equal(res.projects[0].status, 'pass', JSON.stringify(res.projects[0]));
    assert.equal(res.projects[0].run.executed, 2);
    assert.equal(res.projects[0].base_counts.executed, 1);
    assert.equal(res.projects[0].run.retries_disabled, 'full');
    assert.equal(res.red_green.status, 'pass', JSON.stringify(res.red_green));
    assert.deepEqual(res.red_green.pairs.map((p) => [p.id, p.base.status, p.base.failure_kind, p.head.status]), [['tests.test_double::test_two', 'failed', 'assertion', 'passed']]);
  });

  test('pytest flake-probe: no pytest-randomly dependency -> sequential runs, shuffle false, suspect found', { skip: !HAS_PYTEST && 'pytest not available' }, async () => {
    const repo = makeRepo({ 'pytest.ini': '[pytest]\npythonpath = .\n', 'app.py': 'X = 1\n' });
    repo.write({ 'tests/test_flip.py': 'import pathlib\n\ndef test_flip():\n    p = pathlib.Path(__file__).with_name("counter")\n    n = int(p.read_text()) if p.exists() else 0\n    p.write_text(str(n + 1))\n    assert n % 2 == 0\n\ndef test_steady():\n    assert True\n' });
    const res = await probes.flakeProbe({ target: await target(repo), detectResult: pyDetect(repo.dir), times: 2 });
    assert.equal(res.shuffle, false);
    assert.equal(res.runs, 2);
    assert.deepEqual(res.seeds, []);
    assert.deepEqual(res.suspect_tests.map((t) => t.id), ['tests.test_flip::test_flip']);
    assert.equal(res.checks[0].status, 'finding');
  });

  test('pytest: an import error on the base is a collection error, not a red', { skip: !HAS_PYTEST && 'pytest not available' }, async () => {
    const repo = makeRepo({ 'pytest.ini': '[pytest]\npythonpath = .\n', 'app.py': 'def double(x):\n    return x * 2\n' });
    repo.write({ 'app.py': 'def double(x):\n    return x * 2\n\ndef triple(x):\n    return x * 3\n', 'tests/test_triple.py': 'from app import triple\n\ndef test_three():\n    assert triple(1) == 3\n' });
    const res = await cr.cleanRun({ target: await target(repo), detectResult: pyDetect(repo.dir), noBase: true, redGreen: ['tests/test_triple.py'] });
    assert.equal(res.red_green.status, 'fail');
    assert.ok(['WRONG_FAILURE_KIND', 'NOT_EXECUTED_LOAD_ERROR'].includes(res.red_green.reason), JSON.stringify(res.red_green));
  });
});

// ===========================================================================
// typecheck

describe('typecheck', () => {
  const CHECKER = "const fs = require('node:fs'); let bad = 0; for (const f of fs.readdirSync('src')) { fs.readFileSync('src/' + f, 'utf8').split('\\n').forEach((l, i) => { if (l.includes('TYPE_ERROR')) { bad++; console.log(`src/${f}(${i + 1},1): error TS2322: marker found`); } }); } process.exit(bad ? 2 : 0);\n";
  const det = { projects: [{ root: '.', managers: [], runners: [], typecheck: [{ name: 'fake-tsc', cmd: 'node check.cjs' }] }] };

  test('new errors fail; pre-existing errors on shifted lines are pass-with-baseline', async () => {
    const repo = makeRepo({ 'check.cjs': CHECKER, 'src/a.ts': 'const a = 1; // TYPE_ERROR\n' });
    repo.write({ 'src/a.ts': '\n\nconst a = 1; // TYPE_ERROR\n' });
    let res = await cr.typecheck({ target: await target(repo), detectResult: det });
    assert.equal(res.status, 'pass-with-baseline');
    assert.equal(res.head.errors, 1);
    assert.equal(res.base.errors, 1);
    assert.deepEqual(res.new_errors, []);
    repo.write({ 'src/b.ts': 'let b = 2; // TYPE_ERROR\n' });
    res = await cr.typecheck({ target: await target(repo), detectResult: det });
    assert.equal(res.status, 'fail');
    assert.equal(res.new_errors.length, 1);
    assert.equal(res.checks[0].findings[0].file, 'src/b.ts');
    const strict = await cr.typecheck({ target: await target(repo), detectResult: det, strict: true });
    assert.equal(strict.checks[0].findings.length, 2);
    const none = await cr.typecheck({ target: await target(repo), detectResult: { projects: [{ root: '.', runners: [] }] } });
    assert.equal(none.status, 'skipped');
    assert.equal(none.checks[0].reason, 'NO_CHECKER');
    assert.equal(worktrees(repo), 1);
  });

  test('CLI: --runner command line; a test-runner name passed by verify is ignored', () => {
    const repo = makeRepo({ 'check.cjs': CHECKER, 'src/a.ts': 'ok\n' });
    repo.write({ 'src/a.ts': 'ok // TYPE_ERROR\n' });
    const r = adc(['typecheck', '--cwd', repo.dir, '--state-dir', repo.state, '--runner', 'node check.cjs']);
    assert.equal(r.exit, 1, r.stderr);
    assert.equal(r.json.status, 'fail');
    assert.equal(r.json.checks[0].id, 'CK-TYPES');
    const bad = adc(['typecheck', '--cwd', repo.dir, '--state-dir', repo.state, '--runner', 'nope']);
    assert.equal(bad.exit, 2);
  });

  test('go vet: a new vet error in the snapshot fails', { skip: !HAS_GO && 'go not installed' }, async () => {
    const repo = makeRepo({ 'go.mod': 'module example.com/v\n\ngo 1.21\n', 'main.go': 'package main\n\nimport "fmt"\n\nfunc main() { fmt.Println("ok") }\n' });
    repo.write({ 'main.go': 'package main\n\nimport "fmt"\n\nfunc main() { fmt.Printf("%d\\n", "text") }\n' });
    const res = await cr.typecheck({ target: await target(repo), detectResult: fallback(repo.dir) });
    assert.equal(res.status, 'fail', JSON.stringify(res.checkers));
    assert.equal(res.checkers[0].name, 'go-vet');
    assert.ok(res.new_errors.some((e) => e.file === 'main.go'));
  });
});

// ===========================================================================
// probes: coverage-delta, mutation-scope, flake-probe

describe('coverage-delta', () => {
  test('computeChangedCoverage: executable lines only, uncovered ranges, branches, not-in-report, file-level', () => {
    const files = { 'a.js': { lines: { 1: 1, 2: 0, 3: 0, 5: 2 }, branches: { 5: [1, 2] } }, 'b.js': { summary: { pct: 50 } } };
    const r = probes.computeChangedCoverage([{ file: 'a.js', lines: [1, 2, 3, 4, 5] }, { file: 'b.js', lines: [1, 2] }, { file: 'c.js', lines: [1] }], files);
    assert.equal(r.changed_lines, 6);
    assert.equal(r.covered, 3);
    assert.equal(r.pct, 50);
    assert.deepEqual(r.uncovered, [{ file: 'a.js', lines: [2, 3], ranges: ['2-3'] }]);
    assert.deepEqual(r.untested_branches, [{ file: 'a.js', line: 5, covered: 1, total: 2 }]);
    assert.deepEqual(r.files_not_in_report, ['c.js']);
    assert.equal(r.precision, 'file');
  });

  test('CLI: node --test coverage maps changed lines; --fail-under enforces; --report uses a given file', () => {
    const repo = makeRepo(NODE_PROJECT);
    repo.write({
      'src/math.mjs': NODE_PROJECT['src/math.mjs'] + 'export function mul(a, b) {\n  return a * b;\n}\nexport function sub(a, b) {\n  return a - b;\n}\n',
      'test/mul.test.mjs': nodeTest('multiplies', 'assert.equal(mul(2, 3), 6);', "import { mul } from '../src/math.mjs';"),
    });
    const r = adc(['coverage-delta', '--cwd', repo.dir, '--state-dir', repo.state, '--runner', 'node-test']);
    assert.equal(r.exit, 0, r.stderr);
    assert.equal(r.json.precision, 'line');
    assert.ok(r.json.pct > 0 && r.json.pct < 100, String(r.json.pct));
    assert.ok(r.json.uncovered.some((u) => u.file === 'src/math.mjs' && u.lines.includes(7)), JSON.stringify(r.json.uncovered));
    assert.equal(r.json.checks[0].id, 'CK-COVERAGE');
    assert.equal(r.json.checks[0].status, 'pass');
    assert.equal(r.json.checks[0].data.enforced, false);
    const strict = adc(['coverage-delta', '--cwd', repo.dir, '--state-dir', repo.state, '--runner', 'node-test', '--fail-under', '100']);
    assert.equal(strict.exit, 1);
    assert.equal(strict.json.checks[0].reason, 'BELOW_THRESHOLD');
    assert.equal(strict.json.source, 'cache', 'coverage map reused for the same tree');
    const lcov = path.join(repo.state, 'given.info');
    fs.writeFileSync(lcov, 'SF:src/math.mjs\nDA:3,1\nDA:4,1\nDA:5,1\nDA:6,1\nDA:7,1\nDA:8,1\nend_of_record\n');
    const given = adc(['coverage-delta', '--cwd', repo.dir, '--state-dir', repo.state, '--report', lcov, '--fail-under', '90']);
    assert.equal(given.exit, 0, given.stdout);
    assert.equal(given.json.pct, 100);
    assert.equal(given.json.source, 'provided');
    assert.equal(worktrees(repo), 1);
  });

  test('no changed source lines: skipped', async () => {
    const repo = makeRepo(NODE_PROJECT);
    repo.write({ 'README.md': 'docs only\n', 'test/math.test.mjs': NODE_PROJECT['test/math.test.mjs'] + '// note\n' });
    const res = await probes.coverageDelta({ target: await target(repo), detectResult: fallback(repo.dir) });
    assert.equal(res.status, 'skipped');
    assert.equal(res.checks[0].reason, 'NO_CHANGED_CODE');
  });
});

describe('mutation-scope', () => {
  test('parseStrykerReport computes the Stryker score and survivors for changed files', () => {
    const report = { schemaVersion: '2', files: { '/w/src/a.js': { mutants: [
      { id: '1', mutatorName: 'ArithmeticOperator', replacement: 'a - b', status: 'Killed', location: { start: { line: 2, column: 3 } } },
      { id: '2', mutatorName: 'ConditionalExpression', replacement: 'true', status: 'Survived', location: { start: { line: 5, column: 7 } } },
      { id: '3', mutatorName: 'BlockStatement', status: 'NoCoverage', location: { start: { line: 9, column: 1 } } },
      { id: '4', mutatorName: 'StringLiteral', status: 'Timeout', location: { start: { line: 10, column: 1 } } },
      { id: '5', mutatorName: 'X', status: 'CompileError', location: { start: { line: 11, column: 1 } } },
      { id: '6', mutatorName: 'X', status: 'Ignored', location: { start: { line: 12, column: 1 } } },
    ] }, '/w/src/other.js': { mutants: [{ id: '7', status: 'Survived', location: { start: { line: 1 } } }] } } };
    const r = probes.parseStrykerReport(report, { root: '/w', onlyFiles: ['src/a.js'] });
    assert.deepEqual({ mutants: r.mutants, killed: r.killed, survived: r.survived, timeout: r.timeout, no_coverage: r.no_coverage, invalid: r.invalid, score: r.score }, { mutants: 4, killed: 1, survived: 1, timeout: 1, no_coverage: 1, invalid: 1, score: 50 });
    assert.deepEqual(r.survivors.map((s) => `${s.file}:${s.line}`), ['src/a.js:5', 'src/a.js:9']);
  });
  test('parseCargoMutants and parseMutmutOutput', () => {
    const c = probes.parseCargoMutants({ caught: 'src/lib.rs:3:5: replace add -> i32 with 0\nsrc/lib.rs:3:7: replace + with -\n', missed: 'src/lib.rs:9:5: replace is_even -> bool with true\n', timeout: '', unviable: 'src/lib.rs:1:1: replace x with Default::default()\n' });
    assert.deepEqual({ mutants: c.mutants, killed: c.killed, survived: c.survived, invalid: c.invalid, score: c.score }, { mutants: 3, killed: 2, survived: 1, invalid: 1, score: 66.7 });
    assert.deepEqual(c.survivors[0], { file: 'src/lib.rs', line: 9, mutator: null, replacement: 'replace is_even -> bool with true', status: 'Survived' });
    const m3 = probes.parseMutmutOutput('    app.x_double__mutmut_1: killed\n    app.x_double__mutmut_2: survived\n    other.x_f__mutmut_1: survived\n    app.x_double__mutmut_3: no tests\n', { onlyModules: ['app'] });
    assert.deepEqual({ mutants: m3.mutants, killed: m3.killed, survived: m3.survived, no_coverage: m3.no_coverage, score: m3.score }, { mutants: 3, killed: 1, survived: 1, no_coverage: 1, score: 33.3 });
    const prog = probes.parseMutmutOutput('⠋ 12/12  🎉 9  ⏰ 0  🤔 0  🙁 3  🔇 0\n');
    assert.deepEqual({ killed: prog.killed, survived: prog.survived, score: prog.score }, { killed: 9, survived: 3, score: 75 });
    assert.equal(probes.parseMutmutOutput('nothing here'), null);
  });
  test('CLI: no mutation tool for the changed files -> skipped, exit 0', () => {
    const repo = makeRepo(NODE_PROJECT);
    repo.write({ 'src/math.mjs': NODE_PROJECT['src/math.mjs'] + 'export const three = 3;\n' });
    const r = adc(['mutation-scope', '--cwd', repo.dir, '--state-dir', repo.state]);
    assert.equal(r.exit, 0, r.stderr);
    assert.equal(r.json.checks[0].id, 'CK-MUTATION');
    assert.equal(r.json.checks[0].status, 'skipped');
    assert.equal(r.json.checks[0].reason, 'NO_MUTATION_TOOL');
  });
});

describe('flake-probe', () => {
  test('aggregateRuns finds tests with mixed outcomes', () => {
    const agg = probes.aggregateRuns([
      { run: 1, tests: [{ id: 'a', status: 'passed' }, { id: 'b', status: 'failed' }, { id: 'c', status: 'passed' }] },
      { run: 2, tests: [{ id: 'a', status: 'failed' }, { id: 'b', status: 'failed' }, { id: 'c', status: 'flaky' }] },
    ]);
    assert.deepEqual(agg.suspects.map((s) => s.id), ['a', 'c']);
    assert.deepEqual(agg.consistent, ['b']);
  });

  test('CLI: an alternating test is a suspect; seeds are recorded with node --test-randomize', () => {
    const repo = makeRepo(NODE_PROJECT);
    const flaky = [
      "import { test } from 'node:test';", "import assert from 'node:assert/strict';", "import fs from 'node:fs';",
      "const f = new URL('./.counter', import.meta.url);",
      "test('alternates', () => { const n = fs.existsSync(f) ? Number(fs.readFileSync(f, 'utf8')) : 0; fs.writeFileSync(f, String(n + 1)); assert.equal(n % 2, 0); });",
      "test('stable', () => assert.ok(true));", '',
    ].join('\n');
    repo.write({ 'test/flaky.test.mjs': flaky });
    const r = adc(['flake-probe', '--cwd', repo.dir, '--state-dir', repo.state, '--runner', 'node-test', '--times', '4']);
    assert.equal(r.exit, 1, r.stderr + r.stdout);
    assert.equal(r.json.runs, 4);
    assert.equal(r.json.shuffle, true);
    assert.equal(r.json.seeds.length, 4);
    assert.deepEqual(r.json.suspect_tests.map((s) => s.id.split('::').pop()), ['alternates']);
    assert.equal(r.json.suspect_tests[0].file, 'test/flaky.test.mjs');
    assert.equal(r.json.checks[0].id, 'CK-FLAKE');
    assert.equal(r.json.checks[0].status, 'finding');
    assert.equal(worktrees(repo), 1);
  });

  test('stable tests pass; no changed tests is skipped; --tests selects explicitly', async () => {
    const repo = makeRepo(NODE_PROJECT);
    repo.write({ 'test/more.test.mjs': nodeTest('more', 'assert.equal(add(2, 2), 4);') });
    const t = await target(repo);
    const res = await probes.flakeProbe({ target: t, detectResult: fallback(repo.dir), times: 2 });
    assert.equal(res.status, 'pass', JSON.stringify(res.checks[0]));
    assert.equal(res.runs, 2);
    assert.deepEqual(res.tests_probed, ['test/more.test.mjs']);
    const explicit = await probes.flakeProbe({ target: t, detectResult: fallback(repo.dir), times: 1, tests: ['test/math.test.mjs'] });
    assert.equal(explicit.status, 'pass');
    assert.equal(explicit.tests_seen, 2);
    const clean = makeRepo(NODE_PROJECT);
    clean.write({ 'src/math.mjs': '// c\n' + NODE_PROJECT['src/math.mjs'] });
    const none = await probes.flakeProbe({ target: await target(clean), detectResult: fallback(clean.dir) });
    assert.equal(none.checks[0].reason, 'NO_CHANGED_TESTS');
  });
});

// ===========================================================================
// Added coverage: node:test ids, skip vs shortfall, environment exits, --no-install, --keep,
// monorepos, unborn repositories, Go and Cargo end to end.

describe('node:test JUnit ids', () => {
  // Shape of Node 24's junit reporter: classname "test" at top level, the dotted describe chain
  // inside suites, the absolute path in `file`.
  const xml = [
    '<?xml version="1.0" encoding="utf-8"?>', '<testsuites>',
    '\t<testsuite name="outer" tests="2" failures="1">',
    '\t\t<testsuite name="inner" tests="1" failures="1">',
    '\t\t\t<testcase name="same" classname="outer.inner" file="/work/demo/test/a.test.mjs"><failure type="testCodeFailure" message="1 !== 2">Error [ERR_TEST_FAILURE]: 1 !== 2\n  cause: AssertionError [ERR_ASSERTION]: 1 !== 2</failure></testcase>',
    '\t\t</testsuite>',
    '\t\t<testcase name="same" classname="outer" file="/work/demo/test/a.test.mjs"/>',
    '\t</testsuite>',
    '\t<testcase name="same" classname="test" file="/work/demo/test/a.test.mjs"><skipped type="skipped" message="later"/></testcase>',
    '\t<testcase name="same" classname="test" file="/work/demo/test/b.test.mjs"/>',
    '\t<testcase name="test/c.test.mjs" classname="test" file="/work/demo/test/c.test.mjs" failure="test failed"><failure type="testCodeFailure" message="test failed">[Error: test failed] { code: \'ERR_TEST_FAILURE\', failureType: \'testCodeFailure\', cause: \'test failed\', exitCode: 1, signal: null }</failure></testcase>',
    '\t<!-- tests 5 -->', '</testsuites>', '',
  ].join('\r\n');
  test('same-named tests in different files and describes get distinct, root-relative ids', () => {
    const res = reports.parseReport('junit', xml, { root: '/work/demo' });
    const t = byId(res);
    assert.deepEqual(Object.keys(t).sort(), ['test/a.test.mjs::outer > inner > same', 'test/a.test.mjs::outer > same', 'test/a.test.mjs::same', 'test/b.test.mjs::same', 'test/c.test.mjs']);
    assert.equal(t['test/a.test.mjs::outer > inner > same'].failure_kind, 'assertion');
    assert.equal(t['test/c.test.mjs'].failure_kind, 'error', 'a file that failed to load is an error');
    assert.equal(t['test/b.test.mjs::same'].status, 'passed', 'not collapsed with test/a as a rerun');
    assert.deepEqual(counts(res), { executed: 4, passed: 2, failed: 2, errors: 0, skipped: 1, flaky: 0 });
  });
  test('Vitest-style classname (a path) keeps the classname id even with a file attribute', () => {
    const r = reports.parseReport('junit', '<testsuite name="vt/a.test.ts"><testcase classname="vt/a.test.ts" name="s &gt; t" file="vt/a.test.ts"/></testsuite>');
    assert.equal(r.tests[0].id, 'vt/a.test.ts::s > t');
  });
});

describe('outcomes, exits and command plumbing', () => {
  const c = (o) => ({ executed: 3, passed: 3, failed: 0, errors: 0, skipped: 0, flaky: 0, ...o });
  const run = (o) => ({ exit: 0, counts: c(o), source: 'report' });
  test('a test that is skipped now is the skip rule, not a shortfall', () => {
    const base = c({});
    assert.deepEqual(cr.evaluateRun(run({ executed: 2, passed: 2, skipped: 1 }), base), { status: 'finding', reason: 'SKIP_INCREASE' });
    assert.equal(cr.evaluateRun(run({ executed: 2, passed: 2, skipped: 1 }), base, { skipFired: true }).status, 'fail');
    // By id: one test vanished and an unrelated new test is skipped -> still a shortfall.
    assert.deepEqual(cr.evaluateRun(run({ executed: 2, passed: 2, skipped: 1 }), base, { nowSkipped: 0 }), { status: 'fail', reason: 'COUNT_SHORTFALL', shortfall: 1 });
    // Waived deletion plus a new skip: the skip is reported.
    assert.equal(cr.evaluateRun(run({ executed: 1, passed: 1, skipped: 1 }), base, { nowSkipped: 1, explained: 1 }).reason, 'SKIP_INCREASE');
    assert.equal(cr.evaluateRun(run({ executed: 2, passed: 2 }), base, { explained: 1 }).reason, 'SHORTFALL_WAIVED');
    assert.equal(cr.evaluateRun({ exit: 1, counts: null, source: 'none', runnerMissing: true }, base).reason, 'RUNNER_NOT_FOUND');
  });
  test('exitFor: 3 only when every unverified check lacks its executable', () => {
    assert.equal(cr.exitFor('pass'), 0);
    assert.equal(cr.exitFor('finding'), 1);
    assert.equal(cr.exitFor('unverified', [{ status: 'unverified', reason: 'RUNNER_NOT_FOUND' }]), 3);
    assert.equal(cr.exitFor('unverified', [{ status: 'unverified', reason: 'RUNNER_NOT_FOUND' }, { status: 'unverified', reason: 'NO_REPORT' }]), 4);
    assert.equal(cr.exitFor('unverified', []), 4);
  });
  test('runnerMissing recognizes shells, npx, cmd.exe and Python launchers', () => {
    for (const text of ['/bin/sh: 1: vitest: not found', 'sh: jest: command not found', 'bash: line 1: vitest: command not found', 'zsh: command not found: pytest', "'pytest' is not recognized as an internal or external command,",
      'npm error npx canceled due to missing packages and no YES option: ["vitest@4.0.0"]', '/usr/bin/python3: No module named pytest', 'error: no such command: `nextest`']) {
      assert.ok(cr.runnerMissing(text), text);
    }
    assert.ok(!cr.runnerMissing('AssertionError: user not found in list'));
  });
  test('dropNodeTestPaths removes path arguments only', () => {
    assert.equal(cr.dropNodeTestPaths('node --test test/'), 'node --test');
    assert.equal(cr.dropNodeTestPaths('node --test --test-concurrency=1 test/*.test.mjs'), 'node --test --test-concurrency=1');
    assert.equal(cr.dropNodeTestPaths('node --test'), 'node --test');
    assert.equal(cr.dropNodeTestPaths('node --test --test-reporter spec'), 'node --test --test-reporter spec');
    const b = cr.buildRunCommand(cr.resolveRunner({ runners: [{ name: 'node-test', cmd: 'node --test test/' }] }), { dir: tmp('adc-wpd-b-'), outDir: tmp('adc-wpd-o-'), select: { files: ['test/x.test.mjs'], names: [] } });
    assert.match(b.cmd, /^node --test --test-reporter=junit .* test\/x\.test\.mjs$/);
    assert.ok(!/ test\/ /.test(b.cmd));
  });
  test('inferRunner: a --runner command line that plainly runs a known runner gets its report flags', () => {
    const want = { 'uv run --offline --with pytest pytest': 'pytest', 'python -m pytest tests': 'pytest', 'poetry run pytest -q': 'pytest',
      'node --test test/': 'node-test', 'npx vitest run': 'vitest', 'go test ./pkg/...': 'go', 'cargo nextest run': 'nextest', 'cargo test --workspace': 'cargo',
      'bundle exec rspec': 'rspec', './mvnw -q test': 'maven', 'make test': null, 'npm ci && npx vitest run': null, 'pytest | tee log': null, 'npm test': null };
    for (const [line, name] of Object.entries(want)) assert.equal(cr.inferRunner(line), name, line);
    const r = cr.resolveRunner({ runners: [] }, 'uv run pytest');
    assert.deepEqual([r.name, r.cmd, r.report.format, r.inferred], ['pytest', 'uv run pytest', 'junit', true]);
    const same = cr.resolveRunner({ runners: [{ name: 'vitest', cmd: 'npm test' }] }, 'npm test');
    assert.equal(same.name, 'vitest', 'a command identical to a detected runner is that runner');
  });
  test('runEnv forbids npx downloads of unpinned runners', () => {
    const { env } = cr.runEnv();
    assert.equal(env.npm_config_yes, 'false');
  });
});

describe('clean-run options and layouts', () => {
  test('CLI: a runner executable that does not exist -> UNVERIFIED RUNNER_NOT_FOUND, exit 3', () => {
    const repo = makeRepo(NODE_PROJECT);
    repo.write({ 'src/math.mjs': '// c\n' + NODE_PROJECT['src/math.mjs'] });
    const r = adc(['clean-run', '--cwd', repo.dir, '--state-dir', repo.state, '--runner', 'adc-no-such-runner-x1 --all', '--no-base']);
    assert.equal(r.exit, 3, r.stdout);
    assert.equal(r.json.checks[0].status, 'unverified');
    assert.equal(r.json.checks[0].reason, 'RUNNER_NOT_FOUND');
  });

  test('--no-install links the working tree node_modules; links are removed, the original survives', async () => {
    const dep = { 'node_modules/leftish/package.json': '{"name":"leftish","version":"1.0.0","type":"module","main":"index.js"}\n', 'node_modules/leftish/index.js': "export const pad = (s) => ' ' + s;\n" };
    const repo = makeRepo({ ...NODE_PROJECT, '.gitignore': 'node_modules/\n', ...dep, 'test/pad.test.mjs': nodeTest('pads', "assert.equal(pad('a'), ' a');", "import { pad } from 'leftish';") });
    repo.write({ 'test/more.test.mjs': nodeTest('pads twice', "assert.equal(pad(pad('a')), '  a');", "import { pad } from 'leftish';") });
    const res = await cr.cleanRun({ target: await target(repo), detectResult: fallback(repo.dir), detectFn: fallback, noInstall: true });
    const p = res.projects[0];
    assert.equal(res.status, 'pass', JSON.stringify(p));
    assert.deepEqual(p.install.linked, ['node_modules']);
    assert.equal(p.run.executed, 4);
    assert.equal(p.base_counts.executed, 3, 'base linked too: identical dependency manifests');
    assert.deepEqual(p.base_counts.install.linked, ['node_modules']);
    assert.match(res.checks[0].summary, /node_modules linked/);
    assert.ok(fs.existsSync(path.join(repo.dir, 'node_modules', 'leftish', 'index.js')), 'the user\'s node_modules is intact');
    assert.equal(worktrees(repo), 1);
    // Different dependency manifests: the base is not linked (it would test against the wrong deps).
    const pkg = JSON.parse(NODE_PROJECT['package.json']);
    pkg.dependencies = { leftish: '1.0.0' };
    repo.write({ 'package.json': JSON.stringify(pkg) });
    fs.rmSync(path.join(repo.state, 'cache', 'counts'), { recursive: true, force: true });
    const diff = await cr.cleanRun({ target: await target(repo), detectResult: fallback(repo.dir), detectFn: fallback, noInstall: true });
    assert.equal(diff.projects[0].base_counts.install.not_linked[0].reason, 'dependencies differ between the base and the working tree');
    assert.ok(fs.existsSync(path.join(repo.dir, 'node_modules', 'leftish', 'index.js')));
  });

  test('a failing frozen install is UNVERIFIED INSTALL_FAILED with the --no-install hint; tests do not run', async () => {
    const repo = makeRepo(NODE_PROJECT);
    repo.write({ 'src/math.mjs': '// c\n' + NODE_PROJECT['src/math.mjs'] });
    const det = fallback(repo.dir);
    det.projects[0].managers = [{ name: 'npm', lockfile: null, install: 'node -e "process.exit(3)"' }];
    const res = await cr.cleanRun({ target: await target(repo), detectResult: det, noBase: true });
    assert.equal(res.status, 'unverified');
    assert.equal(res.checks[0].reason, 'INSTALL_FAILED');
    assert.equal(res.projects[0].install.exit, 3);
    assert.match(res.checks[0].summary, /exited 3; without network access re-run with --no-install/);
    assert.equal(res.projects[0].run.exit, null, 'the suite never ran');
    assert.equal(cr.exitFor(res.status, res.checks), 4);
  });

  test('--keep keeps the worktree and the raw outputs; default prunes them', async () => {
    const repo = makeRepo(NODE_PROJECT);
    repo.write({ 'src/math.mjs': '// c\n' + NODE_PROJECT['src/math.mjs'] });
    const res = await cr.cleanRun({ target: await target(repo), detectResult: fallback(repo.dir), noBase: true, keep: true });
    const wt = res.projects[0].worktree;
    assert.ok(wt && fs.existsSync(path.join(wt, 'src', 'math.mjs')));
    assert.ok(!wt.startsWith(core.toPosix(repo.dir)), 'worktrees live in the OS temp dir, not in the repository');
    assert.equal(res.checks[0].data.kept, true);
    assert.equal(worktrees(repo), 2);
    repo.g('worktree', 'remove', '--force', wt);
    assert.equal(worktrees(repo), 1);
  });

  test('monorepo: only projects that own a changed file run; --all-projects runs every project', async () => {
    const pkg = (name) => JSON.stringify({ name, type: 'module', scripts: { test: 'node --test' } });
    const files = {
      'packages/a/package.json': pkg('a'), 'packages/a/test/a.test.mjs': nodeTest('a', 'assert.ok(true);', ''),
      'packages/b/package.json': pkg('b'), 'packages/b/test/b.test.mjs': nodeTest('b', 'assert.ok(true);', ''),
    };
    const repo = makeRepo(files);
    repo.write({ 'packages/a/test/a2.test.mjs': nodeTest('a2', 'assert.ok(true);', '') });
    const det = { projects: ['packages/a', 'packages/b'].map((root) => ({ root, languages: ['javascript'], managers: [], runners: [{ name: 'node-test', cmd: 'node --test' }] })) };
    const t = await target(repo);
    const one = await cr.cleanRun({ target: t, detectResult: det, noBase: true });
    assert.deepEqual(one.projects.map((p) => [p.root, p.status, p.run.executed]), [['packages/a', 'pass', 2]]);
    assert.deepEqual(one.checks.map((c) => c.project), ['packages/a']);
    assert.ok(one.checks[0].artifacts.every((a) => a.includes('/packages-a/')), 'artifacts per project slug');
    const all = await cr.cleanRun({ target: t, detectResult: det, noBase: true, allProjects: true });
    assert.deepEqual(all.projects.map((p) => [p.root, p.run.executed]), [['packages/a', 2], ['packages/b', 1]]);
  });

  test('unborn repository: no base, the snapshot still runs', async () => {
    const dir = tmp('adc-wpd-unborn-');
    TEMP.push(core.tmpRoot(dir));
    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    for (const [p, cont] of Object.entries(NODE_PROJECT)) { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), cont); }
    const state = tmp('adc-wpd-state-');
    const r = adc(['clean-run', '--cwd', dir, '--state-dir', state, '--runner', 'node-test']);
    assert.equal(r.exit, 0, r.stdout);
    assert.equal(r.json.projects[0].run.executed, 2);
    assert.equal(r.json.projects[0].base_counts.reason, 'NO_BASE');
    assert.equal(r.json.base.sha, null);
  });
});

describe('Go end to end', { skip: !HAS_GO && 'go not installed' }, () => {
  const GO = {
    'go.mod': 'module example.com/g\n\ngo 1.21\n',
    'calc/calc.go': 'package calc\n\nfunc Add(a, b int) int { return a + b }\n',
    'calc/calc_test.go': 'package calc\n\nimport "testing"\n\nfunc TestAdd(t *testing.T) {\n\tif Add(1, 2) != 3 {\n\t\tt.Fatal("add")\n\t}\n}\n',
  };
  test('CLI coverage-delta: go cover profile mapped through the module path', () => {
    const repo = makeRepo(GO);
    repo.write({ 'calc/calc.go': GO['calc/calc.go'] + '\nfunc Sign(x int) int {\n\tif x < 0 {\n\t\treturn -1\n\t}\n\treturn 1\n}\n', 'calc/sign_test.go': 'package calc\n\nimport "testing"\n\nfunc TestSign(t *testing.T) {\n\tif Sign(5) != 1 {\n\t\tt.Fatal("sign")\n\t}\n}\n' });
    const r = adc(['coverage-delta', '--cwd', repo.dir, '--state-dir', repo.state]);
    assert.equal(r.exit, 0, r.stdout);
    assert.match(r.json.tool, /go \(go-cover\)/);
    assert.ok(r.json.pct > 0 && r.json.pct < 100, String(r.json.pct));
    assert.deepEqual(r.json.uncovered.map((u) => u.file), ['calc/calc.go']);
    assert.ok(r.json.uncovered[0].lines.includes(7), JSON.stringify(r.json.uncovered));
  });
  test('CLI flake-probe: -shuffle seeds recorded; an order-independent alternating test is a suspect', () => {
    const repo = makeRepo(GO);
    repo.write({ 'calc/flaky_test.go': 'package calc\n\nimport (\n\t"os"\n\t"testing"\n)\n\nfunc TestAlternates(t *testing.T) {\n\tb, _ := os.ReadFile("counter")\n\tos.WriteFile("counter", append(b, \'x\'), 0o644)\n\tif len(b)%2 == 1 {\n\t\tt.Fatal("odd run")\n\t}\n}\n' });
    const r = adc(['flake-probe', '--cwd', repo.dir, '--state-dir', repo.state, '--times', '3']);
    assert.equal(r.exit, 1, r.stdout);
    assert.equal(r.json.shuffle, true);
    assert.equal(r.json.seeds.length, 3);
    assert.deepEqual(r.json.suspect_tests.map((s) => s.id), ['example.com/g/calc::TestAlternates']);
    assert.equal(r.json.checks[0].status, 'finding');
  });
});

describe('Cargo end to end', { skip: !core.which('cargo') && 'cargo not installed' }, () => {
  test('cargo test: human output parsed, ignored tests counted, red-green with --test selection', async () => {
    const repo = makeRepo({
      'Cargo.toml': '[package]\nname = "demo"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\n', '.gitignore': 'target\n',
      'src/lib.rs': 'pub fn half(x: i32) -> i32 { x / 3 }\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n    #[test]\n    fn zero() { assert_eq!(half(0), 0); }\n    #[test]\n    #[ignore = "slow"]\n    fn slow() {}\n}\n',
    });
    repo.write({ 'src/lib.rs': 'pub fn half(x: i32) -> i32 { x / 2 }\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n    #[test]\n    fn zero() { assert_eq!(half(0), 0); }\n    #[test]\n    #[ignore = "slow"]\n    fn slow() {}\n}\n', 'tests/half.rs': 'use demo::half;\n\n#[test]\nfn half_of_six() {\n    assert_eq!(half(6), 3);\n}\n' });
    const det = cr.fallbackDetect(repo.dir);
    for (const r of det.projects[0].runners) if (r.name === 'nextest') Object.assign(r, { name: 'cargo', cmd: 'cargo test' });
    // A dependency-free crate needs nothing from ~/.cargo; keep cargo's locks and caches in the temp dir.
    const savedHome = process.env.CARGO_HOME;
    process.env.CARGO_HOME = tmp('adc-wpd-cargo-home-');
    let res;
    try {
      res = await cr.cleanRun({ target: await target(repo), detectResult: det, noBase: true, redGreen: ['tests/half.rs'] });
    } finally {
      if (savedHome === undefined) delete process.env.CARGO_HOME; else process.env.CARGO_HOME = savedHome;
    }
    const p = res.projects[0];
    assert.equal(p.run.runner, 'cargo');
    assert.deepEqual([p.run.executed, p.run.passed, p.run.skipped], [2, 2, 1], JSON.stringify(p.run));
    assert.equal(p.run.retries_disabled, 'unknown');
    assert.match(res.checks[0].summary, /libtest has no retries/);
    assert.equal(res.red_green.status, 'pass', JSON.stringify(res.red_green));
    assert.deepEqual(res.red_green.pairs.map((x) => x.id), ['half::half_of_six']);
    assert.match(res.checks.find((x) => x.id === 'CK-REDGREEN').command, /cargo test --no-fail-fast --test half/);
  });
});

describe('TypeScript end to end', { skip: !core.which('tsc') && 'tsc not installed' }, () => {
  test('real tsc output: a new error fails, a pre-existing one on a shifted line does not', async () => {
    const tsconfig = JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: 'es2022', module: 'nodenext', moduleResolution: 'nodenext', types: [] }, include: ['src'] });
    const repo = makeRepo({ 'tsconfig.json': tsconfig, 'src/old.ts': 'export const n: number = "pre-existing";\n', 'src/ok.ts': 'export const s: string = "fine";\n' });
    repo.write({ 'src/old.ts': '// moved down\n\nexport const n: number = "pre-existing";\n', 'src/ok.ts': 'export const s: string = 42;\n' });
    const det = { projects: [{ root: '.', managers: [], runners: [], typecheck: [{ name: 'tsc', cmd: 'tsc --noEmit -p .' }] }] };
    const res = await cr.typecheck({ target: await target(repo), detectResult: det });
    assert.equal(res.status, 'fail', JSON.stringify(res.checkers));
    assert.match(res.cmd, /--pretty false$/);
    assert.deepEqual(res.new_errors.map((e) => [e.file, e.code]), [['src/ok.ts', 'TS2322']]);
    assert.deepEqual([res.base.errors, res.head.errors], [1, 2]);
    assert.equal(res.checks[0].findings[0].file, 'src/ok.ts');
    assert.equal(res.checks[0].findings[0].line, 1);
  });
});

// ===========================================================================
// Regressions found in the adversarial review

describe('review regressions', () => {
  test('parseSummaryText stays fast on long blank runs and unterminated summary lines', () => {
    const inputs = ['\n'.repeat(200_000) + '1\n', ' \n'.repeat(100_000) + '1\n', ` Tests  ${'1 passed   '.repeat(20_000)}\n`, '\t\n'.repeat(100_000) + '  3 passing (2ms)\n'];
    for (const text of inputs) {
      const started = Date.now();
      reports.parseSummaryText(text);
      assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms for ${JSON.stringify(text.slice(0, 20))}`);
    }
    assert.deepEqual(reports.parseSummaryText(`${'\n'.repeat(50_000)}  3 passing (2ms)\n  1 failing\n`), { runner: 'mocha', passed: 3, failed: 1, skipped: 0 });
    assert.deepEqual(reports.parseSummaryText(`${'\n'.repeat(50_000)} Tests  2 passed | 1 failed (3)\n`), { runner: 'vitest', passed: 2, failed: 1, skipped: 0 });
  });

  test('typecheck: a base check that cannot run is no baseline (BASE_UNAVAILABLE), never NEW_ERRORS', async () => {
    // The checker exists only in the working tree, so the base worktree cannot run it.
    const repo = makeRepo({ 'src/a.ts': 'const a: number = "x";\n' });
    repo.write({ 'tools/check.cjs': "console.log('src/a.ts(1,7): error TS2322: Type string is not assignable to type number.'); process.exit(2);\n" });
    const det = { projects: [{ root: '.', managers: [], runners: [], typecheck: [{ name: 'fake-tsc', cmd: 'node tools/check.cjs' }] }] };
    const res = await cr.typecheck({ target: await target(repo), detectResult: det });
    assert.equal(res.status, 'unverified', JSON.stringify(res.checkers));
    assert.equal(res.checks[0].reason, 'BASE_UNAVAILABLE');
    assert.equal(res.base.problem, 'UNPARSEABLE_FAILURE');
    assert.deepEqual(res.new_errors, []);
    assert.equal(res.checks[0].findings.length, 0);
    assert.equal((await cr.typecheck({ target: await target(repo), detectResult: det, strict: true })).status, 'fail');
    repo.write({ 'tools/check.cjs': 'process.exit(0);\n' });
    assert.equal((await cr.typecheck({ target: await target(repo), detectResult: det })).status, 'pass');
  });

  test('splitNodeTestCmd: flags go before the file patterns; option values and unclear lines are respected', () => {
    assert.deepEqual(cr.splitNodeTestCmd('node --import tsx --test test/a.ts'), { head: 'node --import tsx --test', paths: ['test/a.ts'] });
    assert.deepEqual(cr.splitNodeTestCmd('node --test --test-concurrency 1 "t/**/*.js" b.js'), { head: 'node --test --test-concurrency 1', paths: ['"t/**/*.js"', 'b.js'] });
    assert.deepEqual(cr.splitNodeTestCmd('node --test t/a.js && echo x').paths, []);
    assert.deepEqual(cr.splitNodeTestCmd('node --test t/a.js --foo').paths, []);
    assert.deepEqual(cr.splitNodeTestCmd('node --test --x=1 a.js', ['a.js']), { head: 'node --test --x=1', paths: ['a.js'] });
    const runner = cr.resolveRunner({ runners: [{ name: 'node-test', cmd: 'node --test t/a.test.mjs', paths: ['t/a.test.mjs'] }] });
    const built = cr.buildRunCommand(runner, { dir: os.tmpdir(), outDir: path.join(os.tmpdir(), 'adc-wpd-plan'), plan: true, seed: 7 });
    assert.match(built.cmd, /^node --test --test-reporter=junit .* --test-random-seed=7 t\/a\.test\.mjs$/);
    const sel = cr.buildRunCommand(runner, { dir: os.tmpdir(), outDir: path.join(os.tmpdir(), 'adc-wpd-plan'), plan: true, select: { files: ['t/b.test.mjs'], names: [] } });
    assert.match(sel.cmd, / t\/b\.test\.mjs$/);
    assert.ok(!/t\/a\.test\.mjs/.test(sel.cmd), sel.cmd);
  });

  test('CLI: a node --test script with file patterns still produces a JUnit report (per-test ids)', () => {
    const repo = makeRepo({ ...NODE_PROJECT, 'package.json': JSON.stringify({ name: 'demo', version: '1.0.0', type: 'module', scripts: { test: 'node --test "test/**/*.test.mjs"' } }) + '\n' });
    repo.write({ 'test/more.test.mjs': nodeTest('adds more', 'assert.equal(add(2, 2), 4);') });
    const r = adc(['clean-run', '--cwd', repo.dir, '--state-dir', repo.state]);
    assert.equal(r.exit, 0, r.stderr);
    const p = r.json.projects[0];
    assert.equal(p.run.count_source, 'report', p.run.cmd);
    assert.equal(p.run.executed, 3);
    assert.equal(p.base_counts.executed, 2);
    assert.match(p.run.cmd, /--test-reporter-destination=\S+ "test\/\*\*\/\*\.test\.mjs"$/);
  });

  test('unittest keeps its own name and summary-line counts; no pytest flags are added', () => {
    const runner = cr.resolveRunner({ runners: [{ name: 'unittest', cmd: 'python -m unittest discover -s tests', report: { format: 'summary-text', stdout: true }, retries_off: { mechanism: 'unittest has no retries', coverage: 'full' } }] });
    assert.equal(runner.name, 'unittest');
    const built = cr.buildRunCommand(runner, { dir: os.tmpdir(), outDir: path.join(os.tmpdir(), 'adc-wpd-plan'), plan: true, select: { files: ['tests/test_a.py'], names: [] }, seed: 3 });
    assert.equal(built.cmd, 'python -m unittest discover -s tests');
    const parsed = cr.parseRunOutput(built.report, '', 'Ran 3 tests in 0.010s\n\nOK (skipped=1)\n', [os.tmpdir()]);
    assert.equal(parsed.source, 'summary-text');
    assert.deepEqual(parsed.counts, { executed: 2, passed: 2, failed: 0, errors: 0, skipped: 1, flaky: 0 });
  });

  test('pytest with reruns in addopts: `-p no:rerunfailures` is rejected, retries go off with --reruns 0 (partial)', async () => {
    const FAKE = [
      "const fs = require('node:fs'); const a = process.argv.slice(2);",
      "if (a.includes('no:rerunfailures')) { console.error('ERROR: usage: pytest [options]\\npytest: error: unrecognized arguments: --reruns'); process.exit(4); }",
      "const out = (a.find((x) => x.startsWith('--junit-xml=')) || '').slice('--junit-xml='.length);",
      "fs.writeFileSync(out, '<testsuites><testsuite name=\"pytest\"><testcase classname=\"test_a\" name=\"test_ok\"/></testsuite></testsuites>');",
      "process.exit(a.includes('--reruns') && a[a.indexOf('--reruns') + 1] === '0' ? 0 : 3);", '',
    ].join('\n');
    const repo = makeRepo({ 'tools/pytest': FAKE, 'test_a.py': 'def test_ok():\n    pass\n' });
    repo.write({ 'test_b.py': 'def test_b():\n    pass\n' });
    const res = await cr.cleanRun({ target: await target(repo), detectResult: { projects: [{ root: '.', managers: [], runners: [] }] }, runner: 'node tools/pytest', noBase: true });
    const p = res.projects[0];
    assert.equal(res.status, 'pass', p.summary);
    assert.equal(p.run.retries_disabled, 'partial');
    assert.equal(p.run.mechanism, '--reruns 0');
    assert.match(p.run.cmd, /--reruns 0$/);
    assert.match(p.summary, /retries_disabled: partial \(--reruns 0\)/);
  });

  test('coverage-delta --report: paths relative to the subproject holding the report, and absolute CI paths', async () => {
    const repo = makeRepo({ 'packages/a/package.json': '{"name":"a"}\n', 'packages/a/src/x.js': 'export const x = 1;\n' });
    repo.write({ 'packages/a/src/x.js': 'export const x = 1;\nexport const y = 2;\n', 'packages/a/coverage/lcov.info': 'SF:src/x.js\nDA:1,1\nDA:2,0\nend_of_record\n' });
    const det = { projects: [{ root: 'packages/a', managers: [], runners: [] }] };
    const t = await target(repo);
    const sub = await probes.coverageDelta({ target: t, detectResult: det, report: path.join(repo.dir, 'packages/a/coverage/lcov.info') });
    assert.equal(sub.pct, 0, JSON.stringify(sub));
    assert.deepEqual(sub.uncovered.map((u) => [u.file, u.lines]), [['packages/a/src/x.js', [2]]]);
    const ci = path.join(repo.state, 'ci-lcov.info');
    fs.writeFileSync(ci, 'SF:/home/runner/work/r/r/packages/a/src/x.js\nDA:2,3\nend_of_record\n');
    const abs = await probes.coverageDelta({ target: t, detectResult: det, report: ci, failUnder: 90 });
    assert.equal(abs.pct, 100, JSON.stringify(abs));
    assert.equal(abs.status, 'pass');
  });

  test('invalid numeric options are usage errors (exit 2) before anything is written', () => {
    const repo = makeRepo(NODE_PROJECT);
    for (const args of [['flake-probe', '--times', '0'], ['flake-probe', '--times', '2.5'], ['clean-run', '--timeout', 'abc'], ['mutation-scope', '--budget=-1'], ['coverage-delta', '--fail-under', '120'], ['typecheck', '--timeout', '0']]) {
      const r = adc([...args, '--cwd', repo.dir, '--state-dir', repo.state]);
      assert.equal(r.exit, 2, `${args.join(' ')}: ${r.stderr}`);
    }
    assert.deepEqual(fs.readdirSync(repo.state), [], 'nothing was written');
  });

  test('--red-green and --tests entries are taken relative to --cwd when they exist there', () => {
    const root = tmp('adc-wpd-rel-');
    fs.mkdirSync(path.join(root, 'pkg', 'test'), { recursive: true });
    fs.writeFileSync(path.join(root, 'pkg', 'test', 'a.test.mjs'), '');
    assert.deepEqual(cr.repoRelativeEntries(['test/a.test.mjs::adds,other/b.js'], path.join(root, 'pkg'), root), ['pkg/test/a.test.mjs::adds', 'other/b.js']);
    assert.deepEqual(cr.repoRelativeEntries('pkg/test/a.test.mjs', root, root), ['pkg/test/a.test.mjs']);
    assert.equal(cr.repoRelativeEntries(null, root, root), null);
  });

  test('cargo selection: unit tests of a binary-only crate use --bins, not --lib', () => {
    const dir = tmp('adc-wpd-cargo-');
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'main.rs'), '');
    const runner = cr.resolveRunner({ runners: [{ name: 'cargo' }] });
    assert.deepEqual(cr.selectionArgs(runner, { files: ['src/main.rs'], names: [] }, dir).args, ['--bins']);
    fs.writeFileSync(path.join(dir, 'src', 'lib.rs'), '');
    assert.deepEqual(cr.selectionArgs(runner, { files: ['src/util.rs'], names: [] }, dir).args, ['--lib', '--', 'util::']);
  });

  test('CLI results and the counts cache never carry a secret-shaped literal from a command line', { skip: !HAS_MARKERS && 'markers.mjs not available' }, () => {
    const shape = ['ghp', '_', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('');
    const repo = makeRepo({ 'print.cjs': "console.log('# pass 1'); console.log('# fail 0');\n" });
    repo.write({ 'other.txt': 'changed\n' });
    const r = adc(['clean-run', '--cwd', repo.dir, '--state-dir', repo.state, '--runner', `node print.cjs ${shape}`]);
    assert.equal(r.exit, 0, r.stderr);
    assert.ok(!r.stdout.includes(shape), 'stdout redacted');
    assert.ok(!r.stderr.includes(shape), 'summary redacted');
    assert.match(r.json.projects[0].run.cmd, /\[REDACTED:/);
    const counts = path.join(repo.state, 'cache', 'counts');
    for (const f of fs.readdirSync(counts)) assert.ok(!fs.readFileSync(path.join(counts, f), 'utf8').includes(shape), f);
  });

  test('artifact folders: one per target, never reused by a later run; old runs and old trees are pruned', async () => {
    const state = tmp('adc-wpd-prune-');
    const cache = path.join(state, 'cache');
    const slugDir = path.join(cache, 'runs', 'aaaaaaaaaaaa', 'root');
    const age = (d, s) => { const t = new Date(Date.now() - s * 1000); fs.utimesSync(d, t, t); };
    for (let i = 0; i < 25; i++) { const d = path.join(slugDir, `20260101T0000${String(i).padStart(2, '0')}Z-abcdef`); fs.mkdirSync(d, { recursive: true }); age(d, 100 - i); }
    for (let i = 0; i < 55; i++) { const d = path.join(cache, 'runs', `tree${String(i).padStart(8, '0')}`); fs.mkdirSync(d, { recursive: true }); age(d, 1000 - i); }
    const log = path.join(state, 'x.log');
    fs.writeFileSync(log, 'hello\n');
    const t = { root: state, state: { paths: { cache } } };
    const a = await cr.storeArtifacts(t, 'aaaaaaaaaaaa0000', 'root', { log_path: log });
    const b = await cr.storeArtifacts(t, 'aaaaaaaaaaaa0000', 'root', { log_path: log }, { prefix: 'base-' });
    assert.equal(path.posix.dirname(a.log_path), path.posix.dirname(b.log_path), 'one folder per target');
    const c = await cr.storeArtifacts({ root: state, state: t.state }, 'aaaaaaaaaaaa0000', 'root', { log_path: log });
    assert.notEqual(path.posix.dirname(c.log_path), path.posix.dirname(a.log_path), 'a new target never reuses a folder');
    assert.ok(fs.existsSync(path.join(state, a.log_path)));
    assert.equal(fs.readdirSync(slugDir).filter((n) => /Z-/.test(n)).length, 21, 'the 20 newest earlier runs are kept');
    assert.equal(fs.readdirSync(path.join(cache, 'runs')).length, 51, 'the 50 newest other trees are kept');
  });

  test('runEnv drops inherited node --test-* options from NODE_OPTIONS and keeps the rest', () => {
    const saved = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = '--use-openssl-ca --test-shard 2/2 --max-old-space-size=100 --test-only';
    try {
      const r = cr.runEnv();
      assert.equal(r.env.NODE_OPTIONS, '--use-openssl-ca --max-old-space-size=100');
      assert.ok(r.removed.includes('NODE_OPTIONS --test-*'));
    } finally {
      if (saved === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = saved;
    }
  });
});
