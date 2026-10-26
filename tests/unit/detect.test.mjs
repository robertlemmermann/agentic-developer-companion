// Unit and end-to-end tests for scripts/lib/detect.mjs (plan §7.4, §13 Detection row).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as core from '../../skills/agentic-developer-companion/scripts/lib/core.mjs';
import * as state from '../../skills/agentic-developer-companion/scripts/lib/state.mjs';
import { parseToml } from '../../skills/agentic-developer-companion/scripts/lib/formats.mjs';
import * as M from '../../skills/agentic-developer-companion/scripts/lib/markers.mjs';
import { parseReport } from '../../skills/agentic-developer-companion/scripts/lib/reports.mjs';
import * as cr from '../../skills/agentic-developer-companion/scripts/lib/clean-run.mjs';
import {
  detect, RUNNERS, detectCommand, parseMakeTargets, normalizeGlob, portableArg,
} from '../../skills/agentic-developer-companion/scripts/lib/detect.mjs';
import { AWS_KEY, FIX, fixtureJson, makeRepo, runAdc as adcCli, tmpDir, writeFiles } from './helpers.mjs';

const { scanSecrets, projectForFile, DEFAULT_TEST_GLOBS } = M;
// A test file by the detected projects' globs alone (no path heuristics).
const isTestFile = (file, res, opts = {}) => M.isTestFile(file, res, { ...opts, heuristic: false });

const tmp = () => tmpDir('adc-detect-');
const runAdc = (args, { cwd } = {}) => adcCli(args, { cwd, env: { ...process.env, ADC_QUIET: '1' } });

// Partial deep match: arrays need the same length; `x_re` regex keys, `x_include` subset keys.
function match(actual, expected, where = '') {
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), `${where}: expected an array, got ${JSON.stringify(actual)}`);
    assert.equal(actual.length, expected.length, `${where}: length ${actual.length} != ${expected.length} in ${JSON.stringify(actual).slice(0, 600)}`);
    expected.forEach((e, i) => match(actual[i], e, `${where}[${i}]`));
    return;
  }
  if (expected && typeof expected === 'object') {
    assert.ok(actual && typeof actual === 'object', `${where}: expected an object, got ${JSON.stringify(actual)}`);
    for (const [k, v] of Object.entries(expected)) {
      if (k.endsWith('_re')) {
        const key = k.slice(0, -3);
        const val = actual[key];
        for (const re of [].concat(v)) {
          const ok = Array.isArray(val) ? val.some((x) => new RegExp(re).test(String(x))) : new RegExp(re).test(String(val));
          assert.ok(ok, `${where}.${key}: /${re}/ did not match ${JSON.stringify(val)}`);
        }
      } else if (k.endsWith('_include')) {
        const key = k.slice(0, -8);
        for (const item of v) assert.ok((actual[key] || []).includes(item), `${where}.${key}: missing ${item} in ${JSON.stringify(actual[key])}`);
      } else if (k.endsWith('_names')) {
        assert.deepEqual((actual[k.slice(0, -6)] || []).map((x) => x.name), v, `${where}.${k}`);
      } else match(actual[k], v, `${where}.${k}`);
    }
    return;
  }
  assert.deepEqual(actual, expected, `${where}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
}

const fixture = fixtureJson('detect');

for (const c of fixture.cases) {
  test(`fixture: ${c.name}`, async () => {
    const dir = writeFiles(tmp(), c.files);
    const tools = { 'cargo-nextest': false, ...(c.tools || {}) };
    const res = await detect({ root: dir, platform: c.platform || 'linux', which: (n) => (n in tools ? tools[n] : true), env: {} });
    const { is_test: isTest, not_test: notTest, project_for: projectFor, top_typecheck: topTc, next_steps_re: nextRe, ...rest } = c.expect;
    match(res, rest, c.name);
    for (const f of isTest || []) assert.ok(isTestFile(f, res), `${c.name}: ${f} should be a test file`);
    for (const f of notTest || []) assert.ok(!isTestFile(f, res), `${c.name}: ${f} should not be a test file`);
    for (const [f, root] of Object.entries(projectFor || {})) assert.equal(projectForFile(f, res)?.root ?? null, root, `${c.name}: owner of ${f}`);
    if (topTc) match(res.typecheck, topTc, `${c.name}.typecheck`);
    if (nextRe) match(res, { next_steps_re: nextRe }, c.name);
    // Shape every consumer relies on (verify, clean-run, typecheck, hooks).
    assert.equal(res.schema, 'adc-detect/1');
    assert.match(res.cache_key, /^[0-9a-f]{64}$/);
    assert.equal(typeof res.summary, 'string');
    for (const p of res.projects) {
      assert.equal(typeof p.root, 'string');
      for (const k of ['languages', 'managers', 'runners', 'test_globs', 'typecheck', 'lint', 'coverage']) assert.ok(Array.isArray(p[k]), `${c.name}: ${p.root}.${k}`);
      for (const r of p.runners) {
        assert.ok(r.name && r.report && r.report.format && r.retries_off && ['full', 'partial', 'unknown'].includes(r.retries_off.coverage), `${c.name}: runner ${r.name}`);
        assert.equal(r.count_parser, r.report.format);
        assert.equal(typeof r.source, 'string');
      }
    }
    assert.ok(/^[\x00-\x7e]*$/.test(core.asciiJson(res)), 'ASCII-only JSON');
  });
}

test('RUNNERS catalog: every runner has a report, retries-off and globs; node-test per spec', () => {
  for (const [name, r] of Object.entries(RUNNERS)) {
    assert.equal(r.name, name);
    assert.ok(r.report && r.report.format, name);
    assert.ok(['full', 'partial', 'unknown'].includes(r.retries_off.coverage), name);
    assert.ok(Array.isArray(r.test_globs), name);
    if (r.report.flag && r.report.format !== 'go-test-json') assert.ok(/<f>|<d>/.test(r.report.flag) || r.report.env || r.report.dir || r.report.stdout, name);
  }
  assert.deepEqual(RUNNERS['node-test'].report, { flag: '--test-reporter=junit --test-reporter-destination=<f>', format: 'junit' });
  assert.equal(RUNNERS['node-test'].retries_off.coverage, 'full');
  assert.throws(() => { RUNNERS.jest.report.flag = 'x'; }, TypeError);
});

test('splitShell (the tokenizer detect uses): quotes, operators, redirections, continuations, CRLF', () => {
  const segs = core.splitShell("FOO='a b' jest --ci && echo \"x \\\"y\\\"\" 2>&1 | tee log.txt; npm run test:unit > out.txt\r\nnode --test 'test/**'");
  assert.deepEqual(segs.map((s) => s.tokens), [['FOO=a b', 'jest', '--ci'], ['echo', 'x "y"'], ['tee', 'log.txt'], ['npm', 'run', 'test:unit'], ['node', '--test', 'test/**']]);
  assert.deepEqual(core.splitShell('pytest \\\n  -q tests').map((s) => s.tokens), [['pytest', '-q', 'tests']]);
  assert.deepEqual(core.splitShell('(cd web && npm test)').map((s) => s.tokens), [['cd', 'web'], ['npm', 'test']]);
});

test('portableArg quotes for sh and cmd.exe alike', () => {
  assert.deepEqual(portableArg('src/x.ts'), { text: 'src/x.ts', portable: true });
  assert.deepEqual(portableArg('test/**/*.mjs'), { text: '"test/**/*.mjs"', portable: true });
  assert.equal(portableArg('$HOME').portable, false);
  assert.equal(portableArg('50%').portable, false);
  // sh turns `\\` into `\` inside double quotes, and a trailing `\` escapes the closing quote.
  assert.equal(portableArg('src\\unit tests').portable, true);
  assert.equal(portableArg('a\\\\b c').portable, false);
  assert.equal(portableArg('dir with space\\').portable, false);
});

test('lenient parseToml (detect reads manifests with it): tables, arrays of tables, inline tables, CRLF, bad lines', () => {
  const { value: t } = parseToml('a = 1\r\n[tool.pytest.ini_options]\r\ntestpaths = [\r\n  "tests", # c\r\n  \'it\',\r\n]\r\naddopts = """-q\r\n-x"""\r\n[[test]]\r\nname = "one"\r\n[[test]]\r\nname = "two"\r\n[deps]\r\nx = { version = "1", features = ["a"] }\r\n"quoted.key" = true\r\nbad line here\r\nafter = 2\r\n', { lenient: true });
  assert.equal(t.a, 1);
  assert.deepEqual(t.tool.pytest.ini_options.testpaths, ['tests', 'it']);
  assert.equal(t.tool.pytest.ini_options.addopts, '-q\n-x');
  assert.deepEqual(t.test.map((x) => x.name), ['one', 'two']);
  assert.deepEqual(t.deps.x, { version: '1', features: ['a'] });
  assert.equal(t.deps['quoted.key'], true);
  assert.equal(t.deps.after, 2);
});

test('CI YAML: block and folded scalars, comments in scripts, flow maps, anchors and merge keys, CRLF', async () => {
  const dir = writeFiles(tmp(), {
    '.github/workflows/ci.yml': [
      'name: ci # trailing comment',
      'on: [push, pull_request]',
      'x-web: &web',
      '  working-directory: web',
      'jobs:',
      '  test:',
      '    runs-on: ubuntu-latest',
      '    strategy: { matrix: { node: [20, 22] } }',
      '    defaults:',
      '      run:',
      '        working-directory: api',
      '    steps:',
      '      - uses: actions/checkout@v4',
      '      - name: "Run: tests"',
      '        run: |',
      '          npm ci',
      '          # not a yaml comment',
      '          npm test',
      '      - <<: *web',
      '        run: >-',
      '          npm test --',
      '          --coverage',
    ].join('\r\n'),
    '.gitlab-ci.yml': '.base: &base\n  script:\n    - cd svc && pytest -q\nunit:\n  <<: *base\n  stage: test\n',
    'api/package.json': { scripts: { test: 'jest' }, devDependencies: { jest: '29' } },
    'web/package.json': { scripts: { test: 'vitest' }, devDependencies: { vitest: '2' } },
    'svc/pyproject.toml': '[project]\nname = "svc"\n',
  });
  const res = await detect({ root: dir, platform: 'linux', which: () => true, env: {} });
  const steps = res.ci.steps.map((s) => `${s.file}|${s.cwd}|${s.cmd}`);
  assert.deepEqual(steps, ['.github/workflows/ci.yml|api|npm test', '.github/workflows/ci.yml|web|npm test -- --coverage',
    '.gitlab-ci.yml|svc|pytest -q'], JSON.stringify(res.ci.steps));
  assert.equal(res.ci.steps[0].line, 18);
  assert.deepEqual(res.ci.systems, ['github-actions', 'gitlab-ci']);
  assert.equal(res.projects.find((p) => p.root === 'svc').runners[0].source, 'ci: .gitlab-ci.yml:3');
  assert.deepEqual(res.projects.find((p) => p.root === 'web').ci_test_commands, ['npm test -- --coverage']);
});

test('parseMakeTargets: Makefile targets and justfile recipes named test*', () => {
  const mk = parseMakeTargets('VAR := 1\n.PHONY: test\ntest: deps\n\t@go test ./...\n\t-echo done\ntest-%:\n\techo x\ntest-int test-e2e: deps\n\t./it.sh\nbuild:\n\tgo build\n');
  assert.deepEqual(mk.map((t) => t.name), ['test', 'test-int', 'test-e2e']);
  assert.deepEqual(mk[0].recipe, ['go test ./...', 'echo done']);
  const just = parseMakeTargets('set shell := ["bash", "-c"]\nalias t := test\n\n@test *args:\n  cargo test {{args}}\n\nlint:\n  cargo clippy\n', { just: true });
  assert.deepEqual(just.map((t) => t.name), ['test']);
  assert.deepEqual(just[0].recipe, ['cargo test {{args}}']);
});

test('normalizeGlob converts jest/micromatch globs to the core dialect', () => {
  assert.equal(normalizeGlob('<rootDir>/src/**/*.test.js'), 'src/**/*.test.js');
  assert.equal(normalizeGlob('**/?(*.)+(spec|test).?([mc])[jt]s?(x)'), '**/{,*.}{spec,test}.{,[mc]}[jt]s{,x}');
  assert.ok(core.matchGlob('src/a.spec.ts', normalizeGlob('**/?(*.)+(spec|test).?([mc])[jt]s?(x)')));
  assert.ok(core.matchGlob('src/a.test.mjs', normalizeGlob('**/?(*.)+(spec|test).?([mc])[jt]s?(x)')));
  assert.equal(normalizeGlob('./e2e'), 'e2e/**');
  assert.equal(normalizeGlob('tests/'), 'tests/**');
});

test('isTestFile and projectForFile: defaults without a result, absolute paths, Rust inline tests', () => {
  assert.ok(isTestFile('pkg/a_test.go', null));
  assert.ok(isTestFile('src\\__tests__\\a.js', null));
  assert.ok(!isTestFile('src/a.js', null));
  assert.ok(DEFAULT_TEST_GLOBS.includes('**/*.{test,spec}.*'));
  const res = { repo_root: '/repo', projects: [{ root: '.', test_globs: ['tests/**'] }, { root: 'crates/a', test_globs: ['tests/**'] }] };
  assert.equal(projectForFile('/repo/crates/a/src/lib.rs', res).root, 'crates/a');
  assert.equal(projectForFile('./crates/ab/x.rs', res).root, '.');
  assert.ok(isTestFile('crates/a/tests/t.rs', res));
  assert.ok(!isTestFile('crates/a/src/lib.rs', res));
  assert.ok(isTestFile('crates/a/src/lib.rs', res, { content: 'fn f() {}\n#[cfg(test)]\nmod tests {}\n' }));
  assert.equal(projectForFile('x', { projects: [] }), null);
});

test('state dir, .git and dependency folders are never detection inputs', async () => {
  const dir = writeFiles(tmp(), {
    'package.json': { name: 'r', scripts: { test: 'vitest' }, devDependencies: { vitest: '2' } },
    '.adc/package.json': { name: 'evil', scripts: { test: 'jest' } },
    '.adc/.env.live': 'ADC_LIVE_TOKEN=hunter2abc\n',
    'node_modules/dep/package.json': { name: 'dep', scripts: { test: 'mocha' } },
    'vendor/x/go.mod': 'module x\n',
    'relocated-state/package.json': { name: 'evil2', scripts: { test: 'jest' } },
  });
  const res = await detect({ root: dir, platform: 'linux', which: () => true, env: { ADC_HOME: path.join(dir, 'relocated-state') } });
  assert.deepEqual(res.projects.map((p) => p.root), ['.']);
  assert.ok(!JSON.stringify(res).includes('hunter2abc'));
});

test('malformed inputs never break detection: bad JSON, BOM, CRLF, unparseable YAML/TOML', async () => {
  const dir = writeFiles(tmp(), {
    'package.json': '{ "name": "broken", ',
    'svc/package.json': '\ufeff{\r\n  "name": "bom",\r\n  "scripts": { "test": "vitest run" },\r\n  "devDependencies": { "vitest": "2" }\r\n}\r\n',
    'svc/package-lock.json': '{}',
    'py/pyproject.toml': '[project\nname = = "x"\n[tool.pytest.ini_options]\ntestpaths = ["t"]\n',
    '.github/workflows/bad.yml': 'jobs: [unclosed\n  - run: pytest\n\t\tbad: : :\n',
  });
  const res = await detect({ root: dir, platform: 'linux', which: () => true, env: {} });
  assert.ok(res.warnings.some((w) => /package\.json: invalid JSON/.test(w)), JSON.stringify(res.warnings));
  const svc = res.projects.find((p) => p.root === 'svc');
  assert.equal(svc.runners[0].name, 'vitest');
  const py = res.projects.find((p) => p.root === 'py');
  assert.ok(py && py.runners[0].name === 'pytest' && py.test_globs.includes('t/**'), JSON.stringify(py));
  assert.ok(Array.isArray(res.ci.steps));
});

test('own source files carry no secret-shaped literals', () => {
  const files = [path.join(core.SKILL_DIR, 'scripts', 'lib', 'detect.mjs'), fileURLToPath(import.meta.url), path.join(FIX, 'detect.json')];
  for (const f of files) assert.deepEqual(scanSecrets(fs.readFileSync(f, 'utf8')).map((h) => `${h.id}:${h.line}`), [], f);
});

test('secrets in CI commands and the live token never reach the result or detect.json', async () => {
  const pw = ['s3cr', 'etVal', 'ue99'].join('');
  const live = ['live', 'tok', '42xyz'].join('');
  const { dir } = makeRepo({
    '.github/workflows/ci.yml': `on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: AWS_ACCESS_KEY_ID=${AWS_KEY} DB_PASSWORD=${pw} pytest -q\n      - run: echo ${live} && go test ./... --token=${live}\n`,
    'go.mod': 'module x\n',
  });
  const info = state.prepareStateDir({ cwd: dir }, { create: true });
  const res = await detect({ root: dir, stateInfo: info, platform: 'linux', which: () => true, env: { ADC_LIVE_TOKEN: live } });
  const text = JSON.stringify(res) + fs.readFileSync(info.paths.detect, 'utf8');
  for (const v of [AWS_KEY, pw, live]) assert.ok(!text.includes(v), `leaked ${v.slice(0, 4)}...`);
  // A credential in a package.json test script ends up in runner.env: redacted by name.
  const dir2 = writeFiles(tmp(), { 'package.json': { name: 'z', scripts: { test: `SERVICE_TOKEN=${pw} jest` }, devDependencies: { jest: '29' } } });
  const r2 = await detect({ root: dir2, platform: 'linux', which: () => true, env: {} });
  assert.ok(!JSON.stringify(r2).includes(pw));
  assert.equal(r2.projects[0].runners[0].env.SERVICE_TOKEN, '[REDACTED]');
  assert.ok(res.ci.test_commands.some((c) => /pytest -q/.test(c) && /REDACTED/.test(c)));
  assert.match(res.cache_key, /^[0-9a-f]{64}$/, 'the digest is not mistaken for a secret');
});

test('a cd line in a CI script moves the commands after it; the workspace variable names the checkout', async () => {
  const dir = writeFiles(tmp(), {
    '.github/workflows/ci.yml': 'on: push\njobs:\n  t:\n    runs-on: x\n    steps:\n      - run: |\n          cd frontend\n'
      + '          npm ci\n          npm test\n          cd "$GITHUB_WORKSPACE"\n          go test ./...\n'
      + '      - shell: pwsh\n        run: |\n          Set-Location -Path frontend\n          npm test -- --ci\n',
    'frontend/package.json': { scripts: { test: 'vitest' }, devDependencies: { vitest: '2' } }, 'go.mod': 'module m\n',
  });
  const res = await detect({ root: dir, platform: 'linux', which: () => true, env: {} });
  assert.deepEqual(res.ci.steps.map((s) => [s.cmd, s.cwd, s.project, s.line]), [['npm test', 'frontend', 'frontend', 9],
    ['go test ./...', '.', '.', 11], ['npm test -- --ci', 'frontend', 'frontend', 15]]);
  assert.deepEqual(res.projects.map((p) => [p.root, p.runners.map((r) => r.name)]), [['.', ['go']], ['frontend', ['vitest']]]);
});

test('a numeric CI working directory (a YAML 1.2 number) still names the folder', async () => {
  const dir = writeFiles(tmp(), {
    '.github/workflows/ci.yml': 'on: push\njobs:\n  t:\n    runs-on: x\n    defaults:\n      run:\n        working-directory: 2024\n'
      + '    steps:\n      - run: npm test\n',
    '2024/package.json': { scripts: { test: 'vitest' }, devDependencies: { vitest: '2' } },
  });
  const res = await detect({ root: dir, platform: 'linux', which: () => true, env: {} });
  assert.deepEqual(res.ci.steps.map((s) => [s.cmd, s.cwd, s.project, s.line]), [['npm test', '2024', '2024', 9]]);
});

test('CI directories that leave the checkout are never probed and never become projects', async () => {
  const outside = tmpDir('adc-detect-outside-');
  const dir = writeFiles(path.join(outside, 'repo'), {
    '.github/workflows/ci.yml': 'on: push\njobs:\n  t:\n    runs-on: x\n    steps:\n      - run: pytest\n'
      + '        working-directory: ../sibling\n      - run: cd web/../.. && go test ./...\n      - run: cd web/../api && npm test\n',
    'go.mod': 'module m\n', 'api/package.json': { scripts: { test: 'jest' }, devDependencies: { jest: '29' } },
  });
  writeFiles(outside, { 'sibling/pyproject.toml': '[tool.pytest.ini_options]\n' });
  const res = await detect({ root: dir, platform: 'linux', which: () => true, env: {} });
  assert.deepEqual(res.ci.steps.map((s) => [s.cmd, s.cwd, s.project]), [['pytest', null, null], ['go test ./...', null, null],
    ['npm test', 'api', 'api']]);
  assert.deepEqual(Object.keys(res.probes), ['api'], 'nothing outside the checkout is probed');
  assert.deepEqual(res.projects.map((p) => p.root), ['.', 'api']);
});

test('credentials after a space-separated option are redacted; a cache hit is redacted with the current token', async () => {
  const pw = ['hunt', 'er2s', 'ecret'].join('');
  const live = ['late', 'tok', '77abc'].join('');
  const { dir } = makeRepo({
    '.github/workflows/ci.yml': `on: push\njobs:\n  t:\n    runs-on: x\n    steps:\n      - run: pytest --db-password ${pw} -q\n`
      + `      - run: go test ./... -args -token "${live}"\n`,
    'go.mod': 'module x\n', 'requirements.txt': 'pytest\n',
  });
  const info = state.prepareStateDir({ cwd: dir }, { create: true });
  const first = await detect({ root: dir, stateInfo: info, platform: 'linux', which: () => true, env: {} });
  assert.ok(!JSON.stringify(first).includes(pw), JSON.stringify(first.ci.test_commands));
  assert.ok(first.ci.test_commands.includes('pytest --db-password [REDACTED] -q'), JSON.stringify(first.ci.test_commands));
  // The token was set only after detect.json was written: the hit must not hand it back.
  const second = await detect({ root: dir, stateInfo: info, platform: 'linux', which: () => true, env: { ADC_LIVE_TOKEN: live } });
  assert.equal(second.cache.hit, true);
  assert.ok(!JSON.stringify(second).includes(live));
  assert.match(second.cache_key, /^[0-9a-f]{64}$/);
});

test('cache: written with stateInfo, hit on unchanged inputs, refreshed on change, refresh flag, tool changes, read-only', async () => {
  const { dir } = makeRepo({ 'package.json': { name: 'c', scripts: { test: 'jest' }, devDependencies: { jest: '29' } }, 'package-lock.json': '{}' });
  const info = state.prepareStateDir({ cwd: dir }, { create: true });
  const which = () => true;
  const a = await detect({ root: dir, stateInfo: info, platform: 'linux', which, env: {} });
  assert.equal(a.cache.hit, false);
  assert.equal(a.cache.written, true);
  const onDisk = JSON.parse(fs.readFileSync(info.paths.detect, 'utf8'));
  assert.equal(onDisk.summary, 'node(npm, jest)');
  assert.equal(onDisk.cache, undefined, 'cache metadata is not persisted');
  assert.ok(Array.isArray(onDisk.projects[0].test_globs), 'the hooks read test globs from detect.json');
  const b = await detect({ root: dir, stateInfo: info, platform: 'linux', which, env: {} });
  assert.equal(b.cache.hit, true);
  assert.equal(b.cache_key, a.cache_key);
  assert.equal(b.default_branch, 'main');
  const c = await detect({ root: dir, stateInfo: info, refresh: true, platform: 'linux', which, env: {} });
  assert.equal(c.cache.hit, false);
  // A new untracked manifest is an input change.
  writeFiles(dir, { 'pyproject.toml': '[project]\nname = "c"\n[dependency-groups]\ndev = ["pytest"]\n' });
  const d = await detect({ root: dir, stateInfo: info, platform: 'linux', which, env: {} });
  assert.equal(d.cache.hit, false);
  assert.notEqual(d.cache_key, a.cache_key);
  assert.match(d.summary, /python\(pytest\)/);
  // A tool that appeared or disappeared invalidates the cache.
  const e = await detect({ root: dir, stateInfo: info, platform: 'linux', which: (n) => n !== 'npm', env: {} });
  assert.equal(e.cache.hit, false);
  assert.equal(e.projects[0].runners[0].available, false);
  // write: false (dry run) leaves the cache untouched.
  const before = fs.readFileSync(info.paths.detect, 'utf8');
  writeFiles(dir, { 'go.mod': 'module c\n' });
  const f = await detect({ root: dir, stateInfo: info, write: false, platform: 'linux', which, env: {} });
  assert.equal(f.cache.written, false);
  assert.equal(fs.readFileSync(info.paths.detect, 'utf8'), before);
  // Without stateInfo nothing is written.
  const g = await detect({ root: dir, platform: 'linux', which, env: {} });
  assert.equal(g.cache.path, null);
  // A CI working directory that appears later (no detection input changed) is re-checked on a hit.
  writeFiles(dir, { '.github/workflows/ci.yml': 'on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: ./run-tests.sh\n        working-directory: tools/it\n' });
  const h1 = await detect({ root: dir, stateInfo: info, platform: 'linux', which, env: {} });
  assert.equal(h1.probes['tools/it'], false);
  assert.ok(!h1.projects.some((p) => p.root === 'tools/it'));
  assert.equal((await detect({ root: dir, stateInfo: info, platform: 'linux', which, env: {} })).cache.hit, true);
  writeFiles(dir, { 'tools/it/run-tests.sh': 'echo ok\n' });
  const h2 = await detect({ root: dir, stateInfo: info, platform: 'linux', which, env: {} });
  assert.equal(h2.cache.hit, false);
  assert.equal(h2.cache_key, h1.cache_key, 'same inputs; only the probe changed');
  assert.deepEqual(h2.projects.find((p) => p.root === 'tools/it').runners.map((r) => r.name), ['ci']);
});

test('git listing: untracked manifests count, ignored ones do not; default branch from origin/HEAD', async () => {
  const { dir, g } = makeRepo({ '.gitignore': 'ignored/\n', 'go.mod': 'module m\n' });
  writeFiles(dir, { 'svc/go.mod': 'module svc\n', 'ignored/go.mod': 'module ign\n' });
  g('update-ref', 'refs/remotes/origin/trunk', 'HEAD');
  g('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');
  const res = await detect({ root: dir, platform: 'linux', which: () => true, env: {} });
  assert.equal(res.file_listing, 'git');
  assert.deepEqual(res.projects.map((p) => p.root), ['.', 'svc']);
  assert.equal(res.default_branch, 'trunk');
  assert.equal(res.base_source, 'origin/HEAD');
});

test('outside git: directory walk, no default branch', async () => {
  const dir = writeFiles(tmp(), { 'Gemfile': "gem 'rspec'\n" });
  const res = await detect({ root: dir, platform: 'linux', which: () => true, env: {} });
  assert.equal(res.file_listing, 'walk');
  assert.equal(res.default_branch, null);
  assert.equal(res.base_source, null);
  assert.equal(res.projects[0].runners[0].name, 'rspec');
  await assert.rejects(detect({ root: path.join(dir, 'missing') }), (e) => e instanceof core.AdcError && e.exit === core.EXIT.USAGE);
});

test('real run: the node-test runner with the report flag before its paths writes a parseable JUnit report', async () => {
  const dir = writeFiles(tmp(), {
    'package.json': { name: 'nt', type: 'module', scripts: { test: "node --test 'test/**/*.test.mjs'" } },
    'test/a.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert';\ntest('adds', () => assert.equal(1 + 1, 2));\ntest('skips', { skip: true }, () => {});\n",
  });
  const res = await detect({ root: dir, env: process.env });
  const r = res.projects[0].runners[0];
  assert.equal(r.name, 'node-test');
  const report = path.join(dir, 'report.xml');
  const line = `${r.base_cmd} ${r.report.flag.replace('<f>', core.quoteArg(report))} ${r.paths.join(' ')}`;
  const env = { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}` };
  delete env.NODE_TEST_CONTEXT;
  const run = core.runShell(line, { cwd: dir, env, timeoutMs: 60_000 });
  assert.equal(run.exit, 0, run.stderr || run.stdout);
  const xml = fs.readFileSync(report, 'utf8');
  assert.match(xml, /<testcase[^>]*name="adds"/);
  const counts = parseReport(r.report.format, xml);
  assert.equal(counts.passed, 1);
  assert.equal(counts.skipped, 1);
});

test('clean-run compatibility: every detected runner builds a command with its report target resolved', async () => {
  const out = tmp();
  for (const c of fixture.cases) {
    const dir = writeFiles(tmp(), c.files);
    const tools = { 'cargo-nextest': false, ...(c.tools || {}) };
    const res = await detect({ root: dir, platform: 'linux', which: (n) => (n in tools ? tools[n] : true), env: {} });
    for (const p of res.projects) {
      for (const r of p.runners) {
        if (r.report.nextestConfig) continue; // needs `cargo metadata` on a real crate
        const resolved = cr.resolveRunner({ ...p, runners: [r] }, r.name);
        const built = cr.buildRunCommand(resolved, { dir: path.join(dir, p.root === '.' ? '' : p.root), outDir: path.join(out, c.name, p.root.replace(/\//g, '_'), r.name) });
        assert.ok(!/<f>|<d>/.test(built.cmd), `${c.name}/${r.name}: unresolved placeholder in ${built.cmd}`);
        assert.ok(built.cmd.startsWith(r.name === 'node-test' ? r.base_cmd : r.cmd), `${c.name}/${r.name}: ${built.cmd}`);
        if (r.report.format !== 'summary-text') assert.ok(built.report && (built.report.path || built.report.dir || built.report.stdout), `${c.name}/${r.name}: report target`);
      }
    }
  }
});

test('e2e: adc.mjs detect --json writes .adc/detect.json, hits the cache, honors --refresh and --dry-run', () => {
  const { dir } = makeRepo({
    'package.json': { name: 'e2e', scripts: { test: 'vitest run' }, devDependencies: { vitest: '2' } }, 'package-lock.json': '{}',
    'services/api/go.mod': 'module api\n', 'services/api/a_test.go': '',
  });
  const dry = runAdc(['detect', '--dry-run'], { cwd: dir });
  assert.equal(dry.status, 0, dry.stderr);
  assert.ok(!fs.existsSync(path.join(dir, '.adc')), '--dry-run creates no state dir');
  const first = runAdc(['detect'], { cwd: path.join(dir, 'services') });
  assert.equal(first.status, 0, first.stderr);
  assert.ok(/^[\x00-\x7e]*$/.test(first.stdout), 'ASCII-only stdout');
  assert.equal(first.json.summary, 'node(npm, vitest) \u00b7 go(go)');
  assert.deepEqual(first.json.projects.map((p) => p.root), ['.', 'services/api']);
  assert.equal(first.json.cache.hit, false);
  assert.equal(first.json.default_branch, 'main');
  assert.match(first.stderr, /detect: node\(npm, vitest\)/);
  const cached = JSON.parse(fs.readFileSync(path.join(dir, '.adc', 'detect.json'), 'utf8'));
  assert.equal(cached.summary, first.json.summary);
  assert.match(fs.readFileSync(path.join(dir, '.git', 'info', 'exclude'), 'utf8'), /^\/\.adc\/$/m);
  const second = runAdc(['detect'], { cwd: dir });
  assert.equal(second.json.cache.hit, true);
  const third = runAdc(['detect', '--refresh'], { cwd: dir });
  assert.equal(third.json.cache.hit, false);
  const help = runAdc(['detect', '--help']);
  assert.equal(help.status, 0);
  assert.match(help.json.usage, /--refresh/);
  const bad = runAdc(['detect', '--nope'], { cwd: dir });
  assert.equal(bad.status, 2);
});

test('e2e: a tracked .adc/ makes detect exit 3', () => {
  const { dir } = makeRepo({ 'go.mod': 'module t\n', '.adc/detect.json': '{}' });
  const res = runAdc(['detect'], { cwd: dir });
  assert.equal(res.status, 3, res.stdout);
  assert.equal(res.json.error.code, 'STATE_TRACKED');
});

test('e2e: outside a git repository detect still works and creates no state dir', () => {
  const dir = writeFiles(tmp(), { 'Cargo.toml': '[package]\nname = "x"\n' });
  const res = runAdc(['detect'], { cwd: dir });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.json.summary, 'rust(cargo)');
  assert.equal(res.json.cache.path, null);
  assert.ok(!fs.existsSync(path.join(dir, '.adc')));
});

test('detectCommand is a command handler with usage', () => {
  assert.equal(typeof detectCommand, 'function');
  assert.equal(detectCommand.commandName, 'detect');
  assert.match(detectCommand.usage, /detect \[--refresh\]/);
});
