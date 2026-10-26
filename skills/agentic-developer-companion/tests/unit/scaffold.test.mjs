// Unit and end-to-end tests for scripts/lib/scaffold.mjs and its template bundles (WP-H):
// rendering rules, write/merge/force semantics, every kind and language, generated-file validity
// (JSON, YAML, JS, TS, Python, Go, Rust, Ruby), the generated CI helper, and real runs of the
// scaffolds on sample projects (CLI harness, regression red-green, API tests, live probes under
// `adc.mjs live run`; Playwright when the browsers and the npm registry are reachable).
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import * as core from '../../scripts/lib/core.mjs';
import * as scaffold from '../../scripts/lib/scaffold.mjs';

const ADC = core.ADC_SCRIPT;
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'adc-scaffold-')));
const HOME = path.join(TMP, 'home');
fs.mkdirSync(HOME);
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const MARKERS = ['ADC_HOME', 'ADC_LIVE_TOKEN', 'ADC_LIVE_BASE_URL', 'ADC_LIVE_TENANT', 'ADC_LIVE_BUDGET', 'LIVE_TESTS_ENABLED',
  'CI', 'GITHUB_ACTIONS', 'COPILOT_CLI', 'COPILOT_AGENT_PROMPT', 'GITHUB_COPILOT_API_TOKEN', 'UPDATE_GOLDEN', 'UPDATE_CONTRACTS', 'GOLDEN_DIR'];

/** A clean environment: no host or CI markers, no live variables, an empty HOME. */
function baseEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (MARKERS.includes(k) || k === 'CLAUDECODE' || k.startsWith('CLAUDE_') || k.startsWith('CODEX_') || k.startsWith('E2E_')) delete env[k];
  return { ...env, HOME, USERPROFILE: HOME, ...extra };
}

let seq = 0;
function write(dir, files) {
  for (const [p, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), c);
  }
}

function git(dir, ...args) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

/** A temp git repository with `files` committed (or a plain directory with { git: false }). */
function repo(files = {}, { git: useGit = true, commit = true } = {}) {
  const dir = path.join(TMP, `r${++seq}`);
  fs.mkdirSync(dir);
  if (useGit) {
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 't@example.com');
    git(dir, 'config', 'user.name', 'Test');
    git(dir, 'config', 'commit.gpgsign', 'false');
  }
  write(dir, files);
  if (useGit && commit) {
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'init', '--allow-empty');
  }
  return dir;
}

function adc(args, { cwd, env } = {}) {
  const r = spawnSync(process.execPath, [ADC, ...args, '--json', ...(cwd ? ['--cwd', cwd] : [])], {
    encoding: 'utf8', input: '', env: env || baseEnv(), timeout: 60_000,
  });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch {}
  return { status: r.status, json, stdout: r.stdout, stderr: r.stderr };
}

/** Run a scaffold and assert its exit code; returns the parsed result. */
function sc(dir, kind, extra = [], { exit = 0, env } = {}) {
  const r = adc(['scaffold', kind, ...extra], { cwd: dir, env });
  assert.equal(r.status, exit, `scaffold ${kind} ${extra.join(' ')} exited ${r.status}\n${r.stderr}\n${r.stdout.slice(0, 2000)}`);
  assert.ok(r.json, `no JSON on stdout: ${r.stdout.slice(0, 500)}`);
  return r.json;
}

const read = (dir, rel) => fs.readFileSync(path.join(dir, ...rel.split('/')), 'utf8');
const has = (dir, rel) => fs.existsSync(path.join(dir, ...rel.split('/')));
const paths = (res) => res.written.map((w) => w.path);
const tool = (name) => core.which(name);

function tree(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) tree(full, base, out);
    else out.push(core.toPosix(path.relative(base, full)));
  }
  return out.sort();
}

// ---------------------------------------------------------------------------
// Validators for generated files

function checkJs(file) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  assert.equal(r.status, 0, `node --check ${file}: ${r.stderr}`);
}

function checkTs(file) {
  const src = fs.readFileSync(file, 'utf8');
  const out = path.join(TMP, `ts-check-${++seq}.mjs`);
  const strip = spawnSync(process.execPath, ['--no-warnings', '-e',
    "const m=require('node:module');process.stdout.write(m.stripTypeScriptTypes(require('fs').readFileSync(0,'utf8')))"], { input: src, encoding: 'utf8' });
  assert.equal(strip.status, 0, `TypeScript does not parse in strip-only mode (${file}): ${strip.stderr}`);
  fs.writeFileSync(out, strip.stdout);
  checkJs(out);
}

function checkPython(file) {
  if (!tool('python3')) return;
  const r = spawnSync('python3', ['-c', 'import ast,sys; ast.parse(open(sys.argv[1]).read(), sys.argv[1])', file], { encoding: 'utf8' });
  assert.equal(r.status, 0, `python syntax ${file}: ${r.stderr}`);
}

let yamlAvailable = null;
function checkYaml(file) {
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(!/\t/.test(text), `${file}: tabs in YAML`);
  assert.match(text, /^on:$/m, `${file}: no on: key`);
  assert.match(text, /^jobs:$/m, `${file}: no jobs: key`);
  if (yamlAvailable === null) yamlAvailable = Boolean(tool('python3')) && spawnSync('python3', ['-c', 'import yaml'], { encoding: 'utf8' }).status === 0;
  if (!yamlAvailable) return;
  const r = spawnSync('python3', ['-c', `import yaml,sys,json
d = yaml.safe_load(open(sys.argv[1]))
assert isinstance(d, dict) and 'jobs' in d, 'no jobs'
for name, job in d['jobs'].items():
    assert 'runs-on' in job, name + ': runs-on'
    for i, step in enumerate(job.get('steps', [])):
        assert ('run' in step) != ('uses' in step), name + ': step %d needs exactly one of run/uses' % i
print(json.dumps(sorted(d['jobs'])))`, file], { encoding: 'utf8' });
  assert.equal(r.status, 0, `YAML ${file}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

function checkGo(file) {
  if (!tool('gofmt')) return;
  const r = spawnSync('gofmt', ['-e', '-l', file], { encoding: 'utf8' });
  assert.equal(r.status, 0, `gofmt ${file}: ${r.stderr}`);
}

function checkRust(file) {
  if (!tool('rustfmt')) return;
  const r = spawnSync('rustfmt', ['--edition', '2021', '--emit', 'stdout', file], { encoding: 'utf8' });
  assert.equal(r.status, 0, `rustfmt ${file}: ${r.stderr}`);
}

function checkRuby(file) {
  if (!tool('ruby')) return;
  const r = spawnSync('ruby', ['-c', file], { encoding: 'utf8' });
  assert.equal(r.status, 0, `ruby -c ${file}: ${r.stderr}`);
}

function checkBraces(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/"(?:\\.|[^"\\])*"/g, '""').replace(/\/\/.*$/gm, '');
  let depth = 0;
  for (const c of text) { if (c === '{') depth++; else if (c === '}') depth--; assert.ok(depth >= 0, `${file}: unbalanced braces`); }
  assert.equal(depth, 0, `${file}: unbalanced braces`);
}

/** Validate every written file by its extension; returns the number of checked files. */
function validateAll(dir, res) {
  let n = 0;
  for (const w of res.written) {
    const file = path.isAbsolute(w.path) ? w.path : path.join(dir, ...w.path.split('/'));
    if (!fs.existsSync(file)) continue;
    const ext = path.extname(file);
    if (ext === '.json') JSON.parse(fs.readFileSync(file, 'utf8'));
    else if (ext === '.mjs' || ext === '.cjs' || ext === '.js') checkJs(file);
    else if (ext === '.ts') checkTs(file);
    else if (ext === '.py') checkPython(file);
    else if (ext === '.yml' || ext === '.yaml') checkYaml(file);
    else if (ext === '.go') checkGo(file);
    else if (ext === '.rs') checkRust(file);
    else if (ext === '.rb') checkRuby(file);
    else if (ext === '.java' || ext === '.cs') checkBraces(file);
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(!/\{\{\s*[A-Za-z0-9_.-]+\s*\}\}/.test(text.replace(/\$\{\{[\s\S]*?\}\}/g, '')), `${w.path}: unrendered placeholder`);
    assert.ok(!text.includes('\r'), `${w.path}: CR in a generated file`);
    n++;
  }
  return n;
}

let markers;
async function loadMarkers() {
  if (markers !== undefined) return markers;
  try { markers = await import('../../scripts/lib/markers.mjs'); } catch { markers = null; }
  return markers;
}

/** The companion's own diff checks must find nothing to flag in what the scaffolds generate. */
async function assertNoSelfFindings(dir, res, { allowSkips = false } = {}) {
  const M = await loadMarkers();
  if (!M || typeof M.scanText !== 'function') return;
  for (const w of res.written) {
    const file = path.isAbsolute(w.path) ? w.path : path.join(dir, ...w.path.split('/'));
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    const catalogs = [M.SUPPRESSIONS, M.SWALLOW_PATTERNS, M.IN_SOURCE_RETRIES, ...(allowSkips ? [] : [M.SKIP_MARKERS])].filter(Array.isArray);
    if (/\.ya?ml$/.test(file)) catalogs.push(M.CI_WEAKENING);
    for (const cat of catalogs) {
      let hits = [];
      try { hits = M.scanText(text, cat, { path: w.path, file: w.path }); } catch { hits = M.scanText(text, cat); }
      assert.deepEqual(hits.map((h) => `${h.id}:${h.line}`), [], `${w.path} trips the companion's own checks: ${JSON.stringify(hits.slice(0, 3))}`);
    }
    if (typeof M.scanSecrets === 'function') assert.deepEqual(M.scanSecrets(text), [], `${w.path}: secret-shaped text`);
    if (/^\.github\/workflows\//.test(w.path) && M.CI_GATE_HEADER) assert.match(text.split('\n')[0], M.CI_GATE_HEADER, `${w.path}: missing the ci-gate header`);
  }
}

// ---------------------------------------------------------------------------
// Sample projects

const NODE_LOCK = (name) => JSON.stringify({ name, version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name, version: '1.0.0' } } });

function nodeProject({ flavor = 'node-test', ts = false, bin = true, extra = {} } = {}) {
  const scripts = { 'node-test': 'node --test', vitest: 'vitest run', jest: 'jest' };
  const dev = { vitest: { vitest: '^3.0.0' }, jest: { jest: '^30.0.0' } }[flavor] || {};
  const pkg = { name: 'sumtool', version: '1.0.0', type: 'module', scripts: { test: scripts[flavor] }, devDependencies: dev };
  if (bin) pkg.bin = { sumtool: 'bin/cli.mjs' };
  return {
    'package.json': JSON.stringify(pkg, null, 2),
    'package-lock.json': NODE_LOCK('sumtool'),
    ...(ts ? { 'tsconfig.json': '{ "compilerOptions": { "strict": true } }', 'src/index.ts': 'export const one: number = 1;\n' } : {}),
    'src/sum.mjs': 'export function sum(values) {\n  return values.reduce((a, b) => a + b);\n}\n',
    'bin/cli.mjs': [
      "import { sum } from '../src/sum.mjs';",
      'const args = process.argv.slice(2);',
      "if (args.includes('--help')) { console.log('usage: sumtool <n...>\\n  --help  show this help'); process.exit(0); }",
      "const bad = args.find((a) => a.startsWith('--'));",
      'if (bad) { console.error(`unknown option ${bad}`); process.exit(2); }',
      'console.log(String(sum(args.map(Number))));',
      '',
    ].join('\n'),
    ...extra,
  };
}

const PY_PROJECT = {
  'pyproject.toml': '[project]\nname = "pytool"\nversion = "0.1.0"\n\n[project.scripts]\npytool = "pytool.cli:main"\n\n[dependency-groups]\ndev = ["pytest>=8"]\n',
  'uv.lock': 'version = 1\n',
  'pytool/__init__.py': '',
  'pytool/cli.py': 'import sys\n\ndef main():\n    if "--help" in sys.argv:\n        print("usage: pytool")\n        return 0\n    print("bad option", file=sys.stderr)\n    return 2\n',
  'tests/test_x.py': 'def test_x():\n    assert True\n',
};
const GO_PROJECT = {
  'go.mod': 'module example.com/gotool\n\ngo 1.21\n',
  'main.go': 'package main\n\nimport (\n\t"fmt"\n\t"os"\n)\n\nfunc main() {\n\tfor _, a := range os.Args[1:] {\n\t\tif a == "--help" {\n\t\t\tfmt.Println("usage: gotool")\n\t\t\treturn\n\t\t}\n\t\tfmt.Fprintln(os.Stderr, "unknown option", a)\n\t\tos.Exit(2)\n\t}\n}\n',
  'main_test.go': 'package main\n\nimport "testing"\n\nfunc TestNothing(t *testing.T) {}\n',
};
const RUST_PROJECT = {
  'Cargo.toml': '[package]\nname = "rstool"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\n',
  'Cargo.lock': '# This file is automatically @generated by Cargo.\nversion = 3\n\n[[package]]\nname = "rstool"\nversion = "0.1.0"\n',
  'src/main.rs': 'fn main() {\n    let args: Vec<String> = std::env::args().skip(1).collect();\n    if args.iter().any(|a| a == "--help") {\n        println!("usage: rstool");\n        return;\n    }\n    if let Some(a) = args.first() {\n        eprintln!("unknown option {a}");\n        std::process::exit(2);\n    }\n}\n',
};

// ---------------------------------------------------------------------------
// Pure helpers

describe('rendering helpers', () => {
  test('renderTemplate renders {{vars}} and passes GitHub ${{ }} expressions through', () => {
    const out = scaffold.renderTemplate('a {{x}} ${{ matrix.os }} ${{ needs.{{x}}.result }} {{ y }}', { x: '1', y: 'two' });
    assert.equal(out, 'a 1 ${{ matrix.os }} ${{ needs.{{x}}.result }} two');
    assert.throws(() => scaffold.renderTemplate('{{missing}}', {}), (e) => e.code === 'TEMPLATE_VAR');
  });

  test('pickSections: every attribute must match; when/unless use features; fragments are separate', () => {
    const sections = core.parseBundle([
      '@@@ file: a.txt lang=ts|js @@@', 'a',
      '@@@ file: b.txt lang=python @@@', 'b',
      '@@@ file: c.txt when=pact @@@', 'c',
      '@@@ file: d.txt unless=pact @@@', 'd',
      '@@@ file: f part=fragment name=f lang=ts @@@', 'f',
      '@@@ file: e.txt scope=repo mode=lines @@@', 'e',
    ].join('\n'));
    const names = (list) => list.map((s) => s.path).sort();
    assert.deepEqual(names(scaffold.pickSections(sections, { lang: 'js' })), ['a.txt', 'd.txt', 'e.txt']);
    assert.deepEqual(names(scaffold.pickSections(sections, { lang: 'python' }, new Set(['pact']))), ['b.txt', 'c.txt', 'e.txt']);
    assert.deepEqual(names(scaffold.pickSections(sections, {})), ['d.txt', 'e.txt']);
    assert.deepEqual(names(scaffold.pickSections(sections, { lang: 'ts', part: 'fragment' })), ['f']);
  });

  test('toCommonJs converts the template import and export forms', () => {
    const cjs = scaffold.toCommonJs([
      "import assert from 'node:assert/strict';",
      "import { describe, it } from '@jest/globals';",
      "import { a as b } from './harness.mjs';",
      'export const X = 1;',
      'export function f() {}',
      'export async function g() {}',
    ].join('\n'));
    assert.match(cjs, /const assert = require\('node:assert\/strict'\);/);
    assert.match(cjs, /const \{ describe, it \} = require\('@jest\/globals'\);/);
    assert.match(cjs, /const \{ a: b \} = require\('\.\/harness\.cjs'\);/);
    assert.match(cjs, /module\.exports = \{ X, f, g \};\n$/);
    assert.ok(!/^(?:import|export) /m.test(cjs));
  });

  test('splitArgv honors quotes and rejects unterminated ones', () => {
    assert.deepEqual(scaffold.splitArgv(`node "bin/my cli.mjs" --flag 'a b' ""`), ['node', 'bin/my cli.mjs', '--flag', 'a b', '']);
    assert.throws(() => scaffold.splitArgv('node "x'), (e) => e.exit === core.EXIT.USAGE);
  });

  test('slugify, jsString and cString produce safe identifiers and literals', () => {
    assert.equal(scaffold.slugify('Sign up & Checkout!'), 'sign-up-checkout');
    assert.equal(scaffold.slugify('Ünïcödé'), 'unicode');
    assert.equal(scaffold.slugify('!!!'), 'item');
    assert.equal(scaffold.jsString("it's a \\ test\n"), "'it\\'s a \\\\ test\\n'");
    assert.equal(scaffold.cString('say "hi"\\'), '"say \\"hi\\"\\\\"');
  });

  test('mergeLines appends only missing lines and keeps CRLF files CRLF', () => {
    const merge = scaffold.mergeLines('a/\nb/\n# comment\n');
    assert.equal(merge('a/\nb/\n'), 'a/\nb/\n');
    assert.equal(merge('x\r\na/\r\n'), 'x\r\na/\r\n# added by agentic-developer-companion scaffold\r\nb/\r\n');
    assert.equal(merge('x'), 'x\n# added by agentic-developer-companion scaffold\nb/\na/\n'.replace('b/\na/', 'a/\nb/'));
  });

  test('mergeProbes adds missing probe ids, keeps existing entries, refuses a non-manifest', () => {
    const merge = scaffold.mergeProbes([{ id: 'readonly/health', cost: 1 }, { id: 'synthetic/x', cost: 5 }]);
    const cur = JSON.stringify({ schema: 'adc-probes/1', probes: [{ id: 'readonly/health', cost: 3, custom: true }] });
    const out = JSON.parse(merge(cur));
    assert.deepEqual(out.probes.map((p) => [p.id, p.cost]), [['readonly/health', 3], ['synthetic/x', 5]]);
    assert.equal(merge(JSON.stringify(out)), JSON.stringify(out));
    assert.throws(() => merge('{"nope": 1}'));
    assert.throws(() => merge('not json'));
  });

  test('checklistGate counts TODO lines like the live runner', () => {
    const dir = repo({}, { git: false });
    assert.equal(scaffold.checklistGate(path.join(dir, 'missing.md')).reason, 'CHECKLIST_MISSING');
    write(dir, { 'a.md': '# x\n- one: TODO\r\n- two: done\n- three: TODO later\n', 'b.md': '# x\n- all answered\n' });
    const a = scaffold.checklistGate(path.join(dir, 'a.md'));
    assert.equal(a.ok, false);
    assert.equal(a.open, 2);
    assert.equal(a.reason, 'CHECKLIST_OPEN');
    assert.equal(scaffold.checklistGate(path.join(dir, 'b.md')).ok, true);
  });

  test('ciTestCommand: full suite, retries off, a report per runner', () => {
    const c = (name, cmd, opts) => scaffold.ciTestCommand({ name, cmd }, opts);
    assert.deepEqual(c('node-test', 'node --test'), { cmd: 'node --test --test-reporter=spec --test-reporter-destination=stdout --test-reporter=junit --test-reporter-destination=reports/junit.xml', format: 'junit', report: 'reports/junit.xml', env: {}, runner: 'node-test' });
    assert.match(c('vitest', 'npx --no vitest run').cmd, /--retry=0 .*--outputFile\.junit=reports\/junit\.xml$/);
    assert.equal(c('jest', 'npx --no jest --ci').format, 'jest-json');
    assert.match(c('pytest', 'uv run --frozen pytest').cmd, /^uv run --frozen pytest -p no:rerunfailures --junit-xml=reports\/junit\.xml$/);
    assert.equal(c('go', 'go test ./...').cmd, 'go test ./... -count=1 -json > reports/go-test.jsonl');
    assert.equal(c('nextest', 'cargo nextest run').format, 'cargo-text');
    assert.equal(c('dotnet', 'dotnet test').report, 'reports/**/*.trx');
    assert.match(c('maven', 'mvn -B test').cmd, /-Dsurefire\.rerunFailingTestsCount=0$/);
    assert.equal(c('rspec', 'bundle exec rspec').format, 'rspec-json');
    assert.deepEqual(c('playwright', 'npx playwright test').env, { PLAYWRIGHT_JUNIT_OUTPUT_NAME: 'reports/junit.xml' });
    assert.equal(c('make', 'make test').format, 'summary');
    assert.match(c('pytest', 'python -m pytest', { quarantine: true }).cmd, /-m "not quarantine"/);
    assert.equal(scaffold.ciTestCommand({ name: 'x', cmd: null }, { testCmd: 'make check' }).cmd, 'make check 2>&1 | tee reports/test-output.log');
    assert.equal(scaffold.ciTestCommand({ name: 'unknown', cmd: null }), null);
  });

  test('every template bundle parses and declares only known attributes', () => {
    const known = new Set(['kind', 'lang', 'when', 'unless', 'scope', 'mode', 'part', 'name']);
    for (const name of ['e2e', 'live', 'regress', 'ci-gate', 'flake']) {
      const sections = core.loadBundle(name);
      assert.ok(sections.length > 3, `${name}.tmpl has sections`);
      for (const s of sections) {
        for (const k of Object.keys(s.attrs)) assert.ok(known.has(k), `${name}.tmpl ${s.path}: unknown attribute ${k}`);
        if (s.attrs.part === 'fragment') assert.ok(s.attrs.name, `${name}.tmpl ${s.path}: fragment without a name`);
        assert.ok(!s.content.includes('\r'), `${name}.tmpl ${s.path}: CR`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Command surface and write semantics

describe('scaffold command', () => {
  test('without --write it is a dry run: files are listed, nothing is created', () => {
    const dir = repo(nodeProject());
    const res = sc(dir, 'e2e-cli');
    assert.equal(res.dry_run, true);
    assert.ok(res.written.length >= 2);
    assert.ok(res.written.every((w) => w.action.startsWith('would-')));
    assert.ok(!has(dir, 'e2e'));
    assert.ok(!has(dir, '.adc'));
    assert.match(res.next_steps[0], /dry run/);
    const viaFlag = sc(dir, '--kind', ['e2e-cli']);
    assert.deepEqual(paths(viaFlag), paths(res));
  });

  test('--write creates, a re-run is unchanged, edits are kept without --force, --force backs up', () => {
    const dir = repo(nodeProject());
    const first = sc(dir, 'e2e-cli', ['--write']);
    assert.ok(first.written.every((w) => w.action === 'create'));
    const again = sc(dir, 'e2e-cli', ['--write']);
    assert.ok(again.written.every((w) => w.action === 'unchanged'));
    fs.appendFileSync(path.join(dir, 'e2e/cli/harness.mjs'), '// local edit\n');
    const kept = sc(dir, 'e2e-cli', ['--write']);
    assert.deepEqual(kept.skipped.map((s) => s.path), ['e2e/cli/harness.mjs']);
    assert.match(read(dir, 'e2e/cli/harness.mjs'), /local edit/);
    const forced = sc(dir, 'e2e-cli', ['--write', '--force']);
    assert.equal(forced.written.find((w) => w.path === 'e2e/cli/harness.mjs').action, 'overwrite');
    assert.ok(!read(dir, 'e2e/cli/harness.mjs').includes('local edit'));
    assert.equal(forced.backups.length, 1);
    assert.match(fs.readFileSync(forced.backups[0], 'utf8'), /local edit/);
    assert.match(core.toPosix(forced.backups[0]), /\/\.adc\/backups\/scaffold\//);
    assert.equal(git(dir, 'status', '--porcelain', '--', '.adc'), '');
  });

  test('--write --dry-run writes nothing', () => {
    const dir = repo(nodeProject());
    const res = sc(dir, 'flake', ['--write', '--dry-run']);
    assert.equal(res.dry_run, true);
    assert.ok(!has(dir, 'tests'));
  });

  test('usage errors exit 2: unknown kind, unsupported language, missing regress inputs, --out outside the repo', () => {
    const dir = repo(nodeProject());
    assert.equal(sc(dir, 'e2e-mobile', [], { exit: 2 }).error.code, 'USAGE');
    assert.equal(adc(['scaffold'], { cwd: dir }).status, 2);
    assert.match(sc(dir, 'e2e-web', ['--lang', 'cobol'], { exit: 2 }).error.message, /supports --lang ts, python/);
    assert.match(sc(dir, 'regress', ['--behavior', 'x'], { exit: 2 }).error.message, /--issue/);
    assert.match(sc(dir, 'regress', ['--issue', '1'], { exit: 2 }).error.message, /--behavior/);
    assert.match(sc(dir, 'e2e-cli', ['--out', path.join(TMP, 'elsewhere')], { exit: 2 }).error.message, /inside/);
    assert.match(sc(dir, 'e2e-cli', ['--out', '.git/x'], { exit: 2 }).error.message, /\.git/);
    assert.match(sc(dir, 'e2e-web', ['--base-url', 'https://user:pw@example.test'], { exit: 2 }).error.message, /without credentials/);
    assert.equal(adc(['scaffold', 'e2e-web', '--no-such-flag'], { cwd: dir }).status, 2);
  });

  test('a tracked state dir refuses with exit 3', () => {
    const dir = repo({ ...nodeProject(), '.adc/budget.json': '{}' });
    const r = sc(dir, 'e2e-cli', [], { exit: 3 });
    assert.equal(r.error.code, 'STATE_TRACKED');
  });

  test('refuses to scaffold into the skill itself', () => {
    const r = adc(['scaffold', 'flake'], { cwd: core.SKILL_DIR });
    assert.equal(r.status, 2);
    assert.match(r.json.error.message, /companion skill itself/);
  });

  test('--help prints the usage', () => {
    const r = adc(['scaffold', '--help']);
    assert.equal(r.status, 0);
    assert.match(r.json.usage, /e2e-web .*e2e-api|ci-gate/s);
  });

  test('tooling kinds are delegated to tooling.mjs scaffoldTooling', async (t) => {
    let mod = null;
    try { mod = await import('../../scripts/lib/tooling.mjs'); } catch {}
    if (!mod || typeof mod.scaffoldTooling !== 'function') return t.skip('tooling.mjs is not available in this build');
    const dir = repo(nodeProject());
    const res = sc(dir, 'skill', ['--for', 'claude', '--name', 'demo-skill', '--description', 'Use when testing the scaffold delegation of the companion.']);
    assert.equal(res.delegated, 'tooling scaffold');
    assert.ok(Array.isArray(res.written) && res.written.length > 0);
    assert.ok(res.written.every((w) => String(w.action).startsWith('would-')));
  });

  test('works outside a git repository (no ignore verification needed for non-live kinds)', () => {
    const dir = repo(nodeProject(), { git: false });
    const res = sc(dir, 'e2e-cli', ['--write']);
    assert.ok(has(dir, 'e2e/cli/cli.e2e.test.mjs'));
    assert.equal(res.lang, 'js');
  });
});

// ---------------------------------------------------------------------------
// e2e-cli

describe('e2e-cli', () => {
  test('node-test project: the generated harness and tests run green, golden written locally, never in CI', async () => {
    const dir = repo(nodeProject());
    const res = sc(dir, 'e2e-cli', ['--write']);
    assert.deepEqual(paths(res).sort(), ['e2e/cli/cli.e2e.test.mjs', 'e2e/cli/harness.mjs']);
    validateAll(dir, res);
    await assertNoSelfFindings(dir, res);
    assert.match(read(dir, 'e2e/cli/harness.mjs'), /export const CLI = \[process\.execPath, path\.resolve\(PROJECT_ROOT, 'bin\/cli\.mjs'\)\];/);
    const ci = spawnSync(process.execPath, ['--test', 'e2e/cli/cli.e2e.test.mjs'], { cwd: dir, encoding: 'utf8', env: baseEnv({ CI: 'true' }) });
    assert.notEqual(ci.status, 0, 'CI must not write a missing golden file');
    assert.match(ci.stdout + ci.stderr, /golden file help\.golden is missing/);
    assert.ok(!has(dir, 'e2e/cli/golden/help.golden'));
    const local = spawnSync(process.execPath, ['--test', 'e2e/cli/cli.e2e.test.mjs'], { cwd: dir, encoding: 'utf8', env: baseEnv() });
    assert.equal(local.status, 0, local.stdout + local.stderr);
    assert.match(local.stdout, /pass 5/);
    assert.equal(read(dir, 'e2e/cli/golden/help.golden'), 'usage: sumtool <n...>\n  --help  show this help\n');
    const again = spawnSync(process.execPath, ['--test', 'e2e/cli/cli.e2e.test.mjs'], { cwd: dir, encoding: 'utf8', env: baseEnv({ CI: 'true' }) });
    assert.equal(again.status, 0, again.stdout + again.stderr);
    fs.writeFileSync(path.join(dir, 'e2e/cli/golden/help.golden'), 'something else\n');
    const drift = spawnSync(process.execPath, ['--test', 'e2e/cli/cli.e2e.test.mjs'], { cwd: dir, encoding: 'utf8', env: baseEnv({ CI: 'true' }) });
    assert.notEqual(drift.status, 0, 'golden drift must fail');
  });

  test('TypeScript and runner flavors: node-test imports .ts, vitest imports vitest, jest + JavaScript becomes CommonJS', async () => {
    const ts = repo(nodeProject({ ts: true }));
    const r1 = sc(ts, 'e2e-cli', ['--write']);
    assert.equal(r1.lang, 'ts');
    assert.match(read(ts, 'e2e/cli/cli.e2e.test.ts'), /from 'node:test';[\s\S]*from '\.\/harness\.ts';/);
    validateAll(ts, r1);
    const run = spawnSync(process.execPath, ['--test', 'e2e/cli/cli.e2e.test.ts'], { cwd: ts, encoding: 'utf8', env: baseEnv() });
    assert.equal(run.status, 0, `TypeScript harness under node --test (type stripping): ${run.stdout}${run.stderr}`);

    const vi = repo(nodeProject({ flavor: 'vitest', ts: true }));
    const r2 = sc(vi, 'e2e-cli', ['--write']);
    assert.match(read(vi, 'e2e/cli/cli.e2e.test.ts'), /import \{ describe, it \} from 'vitest';[\s\S]*from '\.\/harness';/);
    validateAll(vi, r2);

    const jest = repo(nodeProject({ flavor: 'jest' }));
    const r3 = sc(jest, 'e2e-cli', ['--write']);
    assert.deepEqual(paths(r3).sort(), ['e2e/cli/cli.e2e.test.cjs', 'e2e/cli/harness.cjs']);
    assert.match(read(jest, 'e2e/cli/cli.e2e.test.cjs'), /const \{ describe, it \} = require\('@jest\/globals'\);[\s\S]*require\('\.\/harness\.cjs'\)/);
    assert.match(read(jest, 'e2e/cli/harness.cjs'), /module\.exports = \{ PROJECT_ROOT, CLI, GOLDEN_DIR, runCli, normalize, expectGolden \};/);
    validateAll(jest, r3);
    await assertNoSelfFindings(jest, r3);
  });

  test('--bin overrides the entry point; no bin entry and no --bin is a usage error', () => {
    const dir = repo(nodeProject({ bin: false }));
    assert.match(sc(dir, 'e2e-cli', [], { exit: 2 }).error.message, /--bin/);
    const res = sc(dir, 'e2e-cli', ['--bin', 'bin/cli.mjs --verbose', '--write']);
    assert.match(read(dir, 'e2e/cli/harness.mjs'), /\[process\.execPath, path\.resolve\(PROJECT_ROOT, 'bin\/cli\.mjs'\), '--verbose'\]/);
    assert.equal(res.cli, 'cli');
    const other = repo(nodeProject({ bin: false }));
    sc(other, 'e2e-cli', ['--bin', 'mytool sub', '--write']);
    assert.match(read(other, 'e2e/cli/harness.mjs'), /export const CLI = \['mytool', 'sub'\];/);
  });

  test('Go module: the harness builds the CLI and the generated tests pass', { timeout: 120_000 }, (t) => {
    const dir = repo(GO_PROJECT);
    const res = sc(dir, 'e2e-cli', ['--write']);
    assert.deepEqual(paths(res).sort(), ['e2e/cli/cli_e2e_test.go', 'e2e/cli/harness_test.go']);
    validateAll(dir, res);
    assert.match(read(dir, 'e2e/cli/harness_test.go'), /^package cli$/m);
    assert.match(read(dir, 'e2e/cli/harness_test.go'), /const cliPackage = "\."/);
    if (!tool('go')) return t.skip('go not installed');
    const env = baseEnv({ GOFLAGS: '-mod=mod', GOPROXY: 'off', GOCACHE: path.join(TMP, 'gocache'), GOPATH: path.join(TMP, 'gopath') });
    const r = spawnSync('go', ['test', './e2e/cli/...'], { cwd: dir, encoding: 'utf8', env, timeout: 110_000 });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(has(dir, 'e2e/cli/testdata/help.golden'));
  });

  test('Rust crate: std-only integration test against CARGO_BIN_EXE passes', { timeout: 150_000 }, (t) => {
    const dir = repo(RUST_PROJECT);
    const res = sc(dir, 'e2e-cli', ['--write']);
    assert.deepEqual(paths(res), ['tests/cli_e2e.rs']);
    validateAll(dir, res);
    assert.match(read(dir, 'tests/cli_e2e.rs'), /CARGO_BIN_EXE_rstool/);
    if (!tool('cargo')) return t.skip('cargo not installed');
    const r = spawnSync('cargo', ['test', '--offline', '--test', 'cli_e2e'], { cwd: dir, encoding: 'utf8', env: baseEnv({ CARGO_TARGET_DIR: path.join(TMP, 'cargo-target'), CARGO_TERM_COLOR: 'never' }), timeout: 140_000 });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /5 passed/);
  });

  test('Python project: harness and tests are valid and start the console-script entry point', async () => {
    const dir = repo(PY_PROJECT);
    const res = sc(dir, 'e2e-cli', ['--write']);
    assert.equal(res.lang, 'python');
    assert.deepEqual(paths(res).sort(), ['tests/e2e/cli/harness.py', 'tests/e2e/cli/test_cli_e2e.py']);
    validateAll(dir, res);
    await assertNoSelfFindings(dir, res);
    assert.match(read(dir, 'tests/e2e/cli/harness.py'), /CLI = \[sys\.executable, "-c", "import sys; from pytool\.cli import main; sys\.exit\(main\(\)\)"\]/);
    if (!tool('python3')) return;
    // The harness itself runs without pytest: normalize() and run_cli() against the real entry point.
    const probe = spawnSync('python3', ['-c', [
      'import sys; sys.path.insert(0, "tests/e2e/cli"); sys.path.insert(0, ".")',
      'import os, harness',
      'r = harness.run_cli(["--help"]); assert r.returncode == 0 and "usage" in r.stdout, r',
      'bad = harness.run_cli(["--nope"]); assert bad.returncode != 0 and bad.stderr.strip(), bad',
      'sample = "wrote " + os.path.join(os.getcwd(), "out", "a.txt") + "\\r\\nat 2026-01-02T03:04:05.678Z in 12ms\\r\\n"',
      'assert harness.normalize(sample) == "wrote <ROOT>/out/a.txt\\nat <TIMESTAMP> in <DURATION>\\n", harness.normalize(sample)',
      'print("ok")',
    ].join('\n')], { cwd: dir, encoding: 'utf8', env: baseEnv() });
    assert.equal(probe.status, 0, probe.stdout + probe.stderr);
  });

  test('a language without a CLI template is a usage error naming the options', () => {
    const dir = repo({ 'Gemfile': "source 'https://rubygems.org'\n", 'Gemfile.lock': 'GEM\n', '.rspec': '--require spec_helper\n', 'spec/a_spec.rb': '' });
    assert.match(sc(dir, 'e2e-cli', [], { exit: 2 }).error.message, /no template for ruby/);
  });
});

// ---------------------------------------------------------------------------
// regress

describe('regress', () => {
  test('node-test: named, tagged, linked; red on the base and green after the fix (clean-run --red-green)', { timeout: 120_000 }, async (t) => {
    const dir = repo(nodeProject());
    const res = sc(dir, 'regress', ['--issue', 'https://github.com/o/r/issues/7', '--behavior', 'sum of an empty list is 0', '--write']);
    const testFile = 'test/regression/7-sum-of-an-empty-list-is-0.test.mjs';
    assert.equal(res.test_file, testFile);
    assert.equal(res.test_name, 'test_7_sum_of_an_empty_list_is_0');
    assert.ok(paths(res).includes('.adc/repro/7-sum-of-an-empty-list-is-0/repro.md'));
    assert.ok(paths(res).includes('.adc/repro/7-sum-of-an-empty-list-is-0/repro.mjs'));
    validateAll(dir, res);
    await assertNoSelfFindings(dir, res);
    const text = read(dir, testFile);
    assert.match(text, /describe\('@regression #7'/);
    assert.match(text, /it\('test_7_sum_of_an_empty_list_is_0'/);
    assert.match(text, /Issue: https:\/\/github\.com\/o\/r\/issues\/7/);
    assert.match(text, /clean-run --red-green test\/regression\/7-sum-of-an-empty-list-is-0\.test\.mjs/);
    // The unedited skeleton is red by construction (a placeholder assertion failure).
    const red = spawnSync(process.execPath, ['--test', testFile], { cwd: dir, encoding: 'utf8', env: baseEnv() });
    assert.notEqual(red.status, 0);
    assert.match(red.stdout, /not reproduced yet/);
    assert.equal(git(dir, 'status', '--porcelain', '--', '.adc'), '', '.adc/ stays ignored');
    // The model's adaptation: the real call and assertion, then the fix in the working tree.
    fs.writeFileSync(path.join(dir, testFile), text
      .replace("// ADAPT: import the code under test, e.g. import { parse } from '../../src/parse';", "import { sum } from '../../src/sum.mjs';")
      .replace(/assert\.fail\([^\n]*\);/, 'assert.equal(sum([]), 0);'));
    fs.writeFileSync(path.join(dir, 'src/sum.mjs'), 'export function sum(values) {\n  return values.reduce((a, b) => a + b, 0);\n}\n');
    let cleanRun = null;
    try { cleanRun = await import('../../scripts/lib/clean-run.mjs'); } catch {}
    if (!cleanRun || typeof cleanRun.cleanRunCommand !== 'function') return t.skip('clean-run.mjs is not available in this build');
    const before = git(dir, 'status', '--porcelain');
    const rg = adc(['clean-run', '--red-green', testFile], { cwd: dir });
    assert.equal(rg.status, 0, rg.stderr + rg.stdout.slice(0, 2000));
    const check = rg.json.checks.find((c) => c.id === 'CK-REDGREEN');
    assert.equal(check.status, 'pass', JSON.stringify(check));
    assert.equal(rg.json.red_green.pairs[0].base.status, 'failed');
    assert.equal(rg.json.red_green.pairs[0].head.status, 'passed');
    assert.equal(git(dir, 'status', '--porcelain'), before, 'the red-green proof leaves the working tree as it was');
  });

  test('every language renders a valid, named, tagged test', async () => {
    const cases = [
      ['ts', nodeProject({ ts: true }), 'test/regression/gh_12-null-input-is-rejected.test.ts', /it\('test_gh_12_null_input_is_rejected'/],
      ['python', PY_PROJECT, 'tests/regression/test_gh_12_null_input_is_rejected.py', /^def test_gh_12_null_input_is_rejected\(\):$/m],
      ['go', GO_PROJECT, 'regression_gh_12_test.go', /^func Test_gh_12_null_input_is_rejected\(t \*testing\.T\) \{$/m],
      ['rust', RUST_PROJECT, 'tests/regression_gh_12.rs', /^fn test_gh_12_null_input_is_rejected\(\) \{$/m],
      ['java', { 'pom.xml': '<project><modelVersion>4.0.0</modelVersion><groupId>a</groupId><artifactId>b</artifactId><version>1</version></project>\n' }, 'src/test/java/regression/IssueGh12NullInputIsRejectedTest.java', /@Tag\("regression"\)\nclass IssueGh12NullInputIsRejectedTest \{/],
      ['dotnet', { 'App.Tests.csproj': '<Project Sdk="Microsoft.NET.Sdk"></Project>\n' }, 'tests/Regression/IssueGh12RegressionTests.cs', /\[Trait\("Category", "regression"\)\]\npublic class IssueGh12RegressionTests/],
      ['ruby', { 'Gemfile': "source 'https://rubygems.org'\n", '.rspec': '--require spec_helper\n' }, 'spec/regression/issue_gh_12_spec.rb', /RSpec\.describe "regression GH-12", :regression do/],
    ];
    for (const [lang, files, file, re] of cases) {
      const dir = repo(files);
      const res = sc(dir, 'regress', ['--issue', 'GH-12', '--behavior', 'null input is rejected', '--lang', lang, '--write']);
      assert.equal(res.lang, lang);
      assert.ok(paths(res).includes(file), `${lang}: ${file} not in ${paths(res).join(', ')}`);
      assert.match(read(dir, file), re, `${lang}: ${file}`);
      validateAll(dir, res);
      await assertNoSelfFindings(dir, res);
      if (lang === 'go') assert.match(read(dir, file), /^package main$/m);
      if (lang === 'python') assert.match(read(dir, 'tests/regression/conftest.py'), /addinivalue_line\("markers", "regression:/);
    }
  });

  test('--characterize adds a golden-master test; --level is validated and recorded', async () => {
    const dir = repo(nodeProject());
    const res = sc(dir, 'regress', ['--issue', '9', '--behavior', 'rounding stays stable', '--level', 'integration', '--characterize', '--write']);
    const ch = paths(res).find((p) => p.endsWith('.characterization.test.mjs'));
    assert.ok(ch, paths(res).join(', '));
    assert.match(read(dir, ch), /current behavior is unchanged/);
    assert.match(read(dir, '.adc/repro/9-rounding-stays-stable/repro.md'), /Chosen level: \*\*integration\*\*/);
    validateAll(dir, res);
    assert.match(sc(dir, 'regress', ['--issue', '9', '--behavior', 'x', '--level', 'system'], { exit: 2 }).error.message, /--level/);
    const go = repo(GO_PROJECT);
    assert.match(sc(go, 'regress', ['--issue', '9', '--behavior', 'x', '--characterize'], { exit: 2 }).error.message, /goldie/);
  });
});

// ---------------------------------------------------------------------------
// e2e-api

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

function runAsync(cmd, args, opts) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeout || 60_000);
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}

describe('e2e-api', () => {
  test('node-test: client, contract snapshot and negative tests run against a real server', async () => {
    const dir = repo(nodeProject());
    const res = sc(dir, 'e2e-api', ['--write', '--health-path', '/healthz']);
    assert.deepEqual(paths(res).sort(), ['e2e/api/api.e2e.test.mjs', 'e2e/api/client.mjs', 'e2e/api/contract.mjs']);
    validateAll(dir, res);
    await assertNoSelfFindings(dir, res);
    const seen = [];
    const { server, url } = await startServer((req, res2) => {
      seen.push({ url: req.url, auth: req.headers.authorization || null, tag: req.headers['x-test-run'] });
      if (req.url === '/healthz') { res2.writeHead(200, { 'content-type': 'application/json' }); return res2.end(JSON.stringify({ status: 'pass', checks: { db: [{ status: 'pass' }] } })); }
      if (req.url === '/private') { res2.writeHead(req.headers.authorization ? 200 : 401); return res2.end(); }
      res2.writeHead(404); res2.end();
    });
    try {
      const env = baseEnv({ E2E_API_BASE_URL: url, E2E_API_TOKEN: 'test-token-value', E2E_API_PROTECTED_PATHS: '/private', E2E_TEST_RUN_ID: 'run-1' });
      const r = await runAsync(process.execPath, ['--test', 'e2e/api/api.e2e.test.mjs'], { cwd: dir, env });
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.match(r.stdout, /pass 4/);
      assert.deepEqual(JSON.parse(read(dir, 'e2e/api/contracts/get-health.json')), { checks: { db: [{ status: 'string' }] }, status: 'string' });
      assert.ok(seen.some((s) => s.url === '/private' && s.auth === null), 'the negative test sends no credentials');
      assert.ok(seen.filter((s) => s.url === '/healthz').every((s) => s.auth === 'Bearer test-token-value' && s.tag === 'run-1'));
      // A changed response shape fails the contract (CI never rewrites it).
      server.removeAllListeners('request');
      server.on('request', (req, res2) => {
        if (req.url === '/healthz') { res2.writeHead(200, { 'content-type': 'application/json' }); return res2.end(JSON.stringify({ state: 'pass' })); }
        res2.writeHead(404); res2.end();
      });
      const drift = await runAsync(process.execPath, ['--test', 'e2e/api/api.e2e.test.mjs'], { cwd: dir, env: { ...env, CI: 'true', E2E_API_PROTECTED_PATHS: '' } });
      assert.notEqual(drift.status, 0);
      assert.match(drift.stdout, /response shape changed/);
    } finally {
      server.close();
    }
  });

  test('TypeScript, Python, Java and .NET variants are valid; OpenAPI adds the fuzz workflow; --pact adds a consumer test', async () => {
    const ts = repo(nodeProject({ flavor: 'vitest', ts: true, extra: { 'openapi.yaml': 'openapi: 3.0.0\ninfo: { title: x, version: "1" }\npaths: {}\n' } }));
    const r1 = sc(ts, 'e2e-api', ['--write', '--pact', 'Billing API']);
    assert.ok(paths(r1).includes('e2e/api/pact/sumtool-billing-api.pact.test.ts'), paths(r1).join(', '));
    assert.ok(paths(r1).includes('.github/workflows/api-fuzz.yml'));
    assert.match(read(ts, '.github/workflows/api-fuzz.yml'), /uvx schemathesis run openapi\.yaml/);
    assert.match(read(ts, 'e2e/api/api.e2e.test.ts'), /from 'vitest';[\s\S]*from '\.\/client';/);
    assert.equal(r1.openapi, 'openapi.yaml');
    validateAll(ts, r1);
    await assertNoSelfFindings(ts, r1);
    for (const [lang, files, expected] of [
      ['python', PY_PROJECT, ['tests/e2e/api/conftest.py', 'tests/e2e/api/contract.py', 'tests/e2e/api/requirements-e2e.txt', 'tests/e2e/api/test_api_e2e.py']],
      ['java', {}, ['src/test/java/e2e/ApiE2ETest.java']],
      ['dotnet', {}, ['tests/E2E.Api/ApiE2ETests.cs', 'tests/E2E.Api/E2E.Api.csproj']],
    ]) {
      const dir = repo(files);
      const res = sc(dir, 'e2e-api', ['--write', '--lang', lang]);
      assert.deepEqual(paths(res).sort(), expected);
      validateAll(dir, res);
      await assertNoSelfFindings(dir, res);
    }
    const py = repo(PY_PROJECT);
    assert.match(sc(py, 'e2e-api', ['--pact', 'x'], { exit: 2 }).error.message, /TypeScript\/JavaScript only/);
    assert.match(sc(py, 'e2e-api', ['--health-path', 'health'], { exit: 2 }).error.message, /--health-path/);
  });
});

// ---------------------------------------------------------------------------
// e2e-web

const SAMPLE_SUITE = {
  'package.json': JSON.stringify({ name: 'web', private: true, scripts: { start: 'vite preview' }, devDependencies: { '@playwright/test': '^1.50.0' } }),
  'package-lock.json': NODE_LOCK('web'),
  'playwright.config.ts': "import { defineConfig } from '@playwright/test';\nexport default defineConfig({ retries: 3, use: { trace: 'off' } });\n",
  'tests/login.spec.ts': [
    "import { test, expect } from '@playwright/test';",
    "test('login', async ({ page }) => {",
    "  await page.goto('http://localhost:3000/login');",
    '  await page.waitForTimeout(2000);',
    "  await page.$('#user');",
    "  await page.click('text=Go', { force: true });",
    '});',
    "test.only('focused', async () => {});",
    '',
  ].join('\n'),
};

describe('e2e-web', () => {
  test('TypeScript project: config, fixtures, page object, smoke, journeys, workflow; all valid', async () => {
    const dir = repo({ ...nodeProject(), 'package.json': JSON.stringify({ name: 'shop', private: true, scripts: { start: 'vite preview', test: 'node --test' } }) });
    const res = sc(dir, 'e2e-web', ['--write', '--journeys', "sign up, search; checkout, wishlist", '--for', 'claude,codex']);
    assert.equal(res.lang, 'ts');
    assert.deepEqual(res.journeys, ['sign up', 'search', 'checkout']);
    for (const f of ['e2e/web/playwright.config.ts', 'e2e/web/fixtures.ts', 'e2e/web/pages/home.page.ts', 'e2e/web/tests/global.setup.ts', 'e2e/web/tests/smoke.spec.ts',
      'e2e/web/tests/sign-up.spec.ts', 'e2e/web/tests/search.spec.ts', 'e2e/web/tests/checkout.spec.ts', 'e2e/web/package.json', 'e2e/web/.gitignore', '.github/workflows/e2e-web.yml']) {
      assert.ok(paths(res).includes(f), `${f} missing`);
    }
    const cfg = read(dir, 'e2e/web/playwright.config.ts');
    for (const re of [/forbidOnly: isCI/, /retries: isCI \? 2 : 0/, /failOnFlakyTests: isCI/, /trace: 'retain-on-failure'/, /baseURL/, /'junit'/, /'blob'/, /command: 'npm run start'/, /cwd: '\.\.\/\.\.'/, /http:\/\/localhost:4173/]) assert.match(cfg, re);
    assert.match(read(dir, 'e2e/web/tests/sign-up.spec.ts'), /test\.fixme\('sign up'/);
    const jobs = checkYaml(path.join(dir, '.github/workflows/e2e-web.yml'));
    if (jobs) assert.deepEqual(jobs, ['report', 'test']);
    assert.match(read(dir, '.github/workflows/e2e-web.yml'), /merge-reports --reporter html,junit/);
    validateAll(dir, res);
    await assertNoSelfFindings(dir, { written: res.written.filter((w) => !/sign-up|search|checkout/.test(w.path)) });
    assert.ok(res.next_steps.some((s) => s.includes('npx playwright init-agents --loop=claude')));
    assert.ok(res.next_steps.some((s) => s.includes('codex mcp add playwright')));
    // The scaffold's own suite passes its hardening audit (no P1/P2 items).
    const audit = sc(dir, 'e2e-web', ['--audit']);
    assert.equal(audit.audit.counts.P1, 0, JSON.stringify(audit.audit.items));
    assert.equal(audit.audit.counts.P2, 0, JSON.stringify(audit.audit.items));
  });

  test('Python variant is valid', async () => {
    const dir = repo(PY_PROJECT);
    const res = sc(dir, 'e2e-web', ['--write', '--journeys', 'checkout']);
    assert.equal(res.lang, 'python');
    assert.ok(paths(res).includes('tests/e2e/web/test_web_checkout.py'));
    assert.match(read(dir, 'tests/e2e/web/test_web_checkout.py'), /@pytest\.mark\.skip\(reason="journey not implemented yet: " \+ "checkout"\)/);
    validateAll(dir, res);
  });

  test('--audit lists a prioritized hardening plan for an existing suite and writes nothing', () => {
    const dir = repo(SAMPLE_SUITE);
    const res = sc(dir, 'e2e-web', ['--audit'], { exit: 1 });
    assert.equal(res.mode, 'audit');
    const rules = res.audit.items.map((i) => `${i.priority}:${i.rule}`);
    for (const r of ['P1:fixed-sleep', 'P1:focused-test', 'P1:retries-hide-flakes', 'P1:unbounded-retries', 'P2:trace-off', 'P2:no-forbid-only', 'P2:hardcoded-url', 'P3:brittle-selector', 'P3:force-click', 'P3:no-tags']) {
      assert.ok(rules.includes(r), `${r} missing from ${rules.join(', ')}`);
    }
    assert.deepEqual(res.audit.items.map((i) => i.priority), [...res.audit.items.map((i) => i.priority)].sort());
    assert.equal(res.audit.items.find((i) => i.rule === 'fixed-sleep').line, 4);
    assert.deepEqual(tree(dir), ['package-lock.json', 'package.json', 'playwright.config.ts', 'tests/login.spec.ts']);
  });

  test('the generated suite runs with Playwright (network and browsers permitting)', { timeout: 180_000 }, async (t) => {
    const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
    if (process.env.ADC_SKIP_NETWORK_TESTS) return t.skip('ADC_SKIP_NETWORK_TESTS is set');
    if (!fs.existsSync(path.join(browsers, 'chromium-1243')) || !tool('npm')) return t.skip('Chromium build 1243 (Playwright 1.63) or npm not available');
    const dir = repo({ 'package.json': JSON.stringify({ name: 'demo', private: true, scripts: { start: 'node server.mjs' } }), 'package-lock.json': NODE_LOCK('demo') });
    sc(dir, 'e2e-web', ['--write', '--journeys', 'sign up']);
    const web = path.join(dir, 'e2e/web');
    const npmCli = core.IS_WINDOWS ? 'npm.cmd' : 'npm';
    const install = spawnSync(npmCli, ['install', '--no-audit', '--no-fund', '@playwright/test@1.63.0'], { cwd: web, encoding: 'utf8', env: baseEnv(), timeout: 120_000, shell: core.IS_WINDOWS });
    if (install.status !== 0) return t.skip(`npm registry not reachable: ${(install.stderr || '').split('\n').slice(-3).join(' ')}`);
    const { server, url } = await startServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><html><head><title>Demo</title></head><body><main>Hello</main></body></html>'); });
    try {
      const cli = path.join(web, 'node_modules', '@playwright', 'test', 'cli.js');
      const r = await runAsync(process.execPath, [cli, 'test', '--project=chromium'], { cwd: web, env: baseEnv({ PLAYWRIGHT_BROWSERS_PATH: browsers, E2E_BASE_URL: url }), timeout: 120_000 });
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.match(r.stdout, /2 passed/);
      assert.match(r.stdout, /1 skipped/);
      assert.ok(fs.existsSync(path.join(web, 'test-results', 'junit.xml')), 'junit report written');
      assert.ok(spawnSync('git', ['check-ignore', '-q', 'e2e/web/test-results/junit.xml'], { cwd: dir }).status === 0, 'reports are ignored');
    } finally {
      server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// live

describe('live', () => {
  test('read-only by default: no synthetic probe without an answered checklist; .adc/ materialized; ignores verified', async () => {
    const dir = repo(nodeProject());
    const dry = sc(dir, 'live', []);
    assert.equal(dry.synthetic.enabled, false);
    assert.equal(dry.gitignore.verified, null);
    assert.ok(!has(dir, '.adc'));
    const res = sc(dir, 'live', ['--write', '--lang', 'ts']);
    assert.equal(res.synthetic.enabled, false);
    assert.equal(res.synthetic.reason, 'CHECKLIST_MISSING');
    assert.ok(!paths(res).some((p) => p.includes('synthetic')));
    for (const f of ['tests/live/package.json', 'tests/live/playwright.config.ts', 'tests/live/probes/readonly/health.spec.ts', 'tests/live/probes/support/result.ts',
      'tests/live/probes.json', 'tests/live/runbook.md', 'tests/live/live-checklist.md', 'tests/live/.gitignore', '.github/workflows/live-probes.yml']) assert.ok(paths(res).includes(f), f);
    const manifest = JSON.parse(read(dir, 'tests/live/probes.json'));
    assert.deepEqual(manifest, { schema: 'adc-probes/1', probes: [{ id: 'readonly/health', kind: 'readonly', cmd: 'npx playwright test probes/readonly/health.spec.ts --reporter=junit', cwd: 'tests/live', cost: 1, timeout_s: 120 }] });
    const cfg = read(dir, 'tests/live/playwright.config.ts');
    assert.match(cfg, /trace: 'off'/);
    assert.ok(!/recordHar|routeFromHAR/.test(cfg));
    assert.equal(res.gitignore.verified, true);
    assert.ok(res.gitignore.paths.every((p) => p.ignored));
    assert.equal(res.state.budget.created, true);
    assert.equal(res.state.env_live.created, true);
    if (!core.IS_WINDOWS) assert.equal(fs.statSync(path.join(dir, '.adc/.env.live')).mode & 0o777, 0o600);
    assert.match(read(dir, '.adc/.env.live'), /^ADC_LIVE_TOKEN=$/m);
    assert.equal(git(dir, 'status', '--porcelain', '--', '.adc'), '');
    assert.ok(scaffold.checklistGate(path.join(dir, 'tests/live/live-checklist.md')).open > 5, 'the template checklist starts with TODO lines');
    const wf = read(dir, '.github/workflows/live-probes.yml');
    assert.match(wf, /if: \$\{\{ vars\.LIVE_TESTS_ENABLED == 'true' \}\}/);
    assert.match(wf, /node "\$ADC" live run --probes 'readonly\/\*' --json/);
    assert.match(wf, /concurrency:/);
    assert.match(wf, /retention-days: 1/);
    assert.ok(!/npx playwright test/.test(wf), 'the workflow never runs the test runner directly');
    validateAll(dir, res);
    await assertNoSelfFindings(dir, res);
  });

  test('synthetic probes: refused with TODO lines, generated with an answered checklist and a cost, merged into probes.json', async () => {
    const dir = repo(nodeProject());
    sc(dir, 'live', ['--write', '--lang', 'js']);
    const template = read(dir, 'tests/live/live-checklist.md');
    const open = sc(dir, 'live', ['--write', '--lang', 'js', '--checklist', 'tests/live/live-checklist.md']);
    assert.equal(open.synthetic.enabled, false);
    assert.equal(open.synthetic.reason, 'CHECKLIST_OPEN');
    assert.ok(open.synthetic.open > 5);
    assert.ok(open.next_steps.some((s) => /NOT generated/.test(s)));
    const answered = template.replace(/TODO/g, 'answered by the owner').replace('Estimated credits per synthetic run: TODO', 'Estimated credits per synthetic run: 4');
    fs.writeFileSync(path.join(dir, 'answers.md'), answered.replace('Estimated credits per synthetic run: answered by the owner', 'no cost line'));
    assert.match(sc(dir, 'live', ['--checklist', 'answers.md'], { exit: 2 }).error.message, /estimated cost/);
    fs.writeFileSync(path.join(dir, 'tests/live/live-checklist.md'), answered);
    const res = sc(dir, 'live', ['--write', '--lang', 'js', '--checklist', 'tests/live/live-checklist.md']);
    assert.equal(res.synthetic.enabled, true);
    assert.equal(res.synthetic.cost, 4);
    assert.ok(paths(res).includes('tests/live/probes/synthetic/create-and-cleanup.test.mjs'));
    assert.equal(res.written.find((w) => w.path === 'tests/live/probes.json').action, 'merge');
    const probes = JSON.parse(read(dir, 'tests/live/probes.json')).probes;
    assert.deepEqual(probes.map((p) => [p.id, p.kind, p.cost]), [['readonly/health', 'readonly', 1], ['synthetic/create-and-cleanup', 'synthetic', 4]]);
    const wf = read(dir, '.github/workflows/live-probes.yml');
    assert.equal(res.written.find((w) => w.path === '.github/workflows/live-probes.yml').action !== 'overwrite' || wf.includes('live-write'), true);
    const forced = sc(dir, 'live', ['--write', '--lang', 'js', '--checklist', 'tests/live/live-checklist.md', '--force']);
    assert.ok(forced.written.some((w) => w.path === '.github/workflows/live-probes.yml'));
    assert.match(read(dir, '.github/workflows/live-probes.yml'), /environment: live-write/);
    checkYaml(path.join(dir, '.github/workflows/live-probes.yml'));
    const synth = read(dir, 'tests/live/probes/synthetic/create-and-cleanup.test.mjs');
    assert.match(synth, /assertWritesAllowed\(\);/);
    assert.match(synth, /finally \{/);
    validateAll(dir, forced);
    await assertNoSelfFindings(dir, forced);
    // An answered checklist kept elsewhere is copied into the project when none exists there.
    const other = repo(nodeProject());
    fs.writeFileSync(path.join(other, 'answers.md'), answered);
    const copied = sc(other, 'live', ['--write', '--lang', 'python', '--checklist', 'answers.md']);
    assert.equal(copied.synthetic.enabled, true);
    assert.equal(read(other, 'tests/live/live-checklist.md'), answered);
    assert.ok(paths(copied).includes('tests/live/probes/synthetic/test_create_and_cleanup.py'));
    validateAll(other, copied);
  });

  test('the ignore post-condition fails (exit 1) when a rule re-includes trace files', () => {
    const dir = repo({ ...nodeProject(), 'tests/live/.gitignore': '*.har\n!trace.har\n' });
    const res = sc(dir, 'live', ['--write', '--lang', 'js'], { exit: 1 });
    assert.equal(res.gitignore.verified, false);
    assert.deepEqual(res.findings.map((f) => [f.id, f.file]), [['LIVE-GITIGNORE', 'tests/live/trace.har']]);
  });

  test('the generated probe project runs under `adc.mjs live run`; the token never appears in the output', { timeout: 60_000 }, async (t) => {
    let live = null;
    try { live = await import('../../scripts/lib/live.mjs'); } catch {}
    if (!live || typeof live.liveRunCommand !== 'function') return t.skip('live.mjs is not available in this build');
    const token = ['tok', 'scaffold', String(Date.now())].join('-');
    const { server, url } = await startServer((req, res) => {
      if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401); return res.end(`denied ${req.headers.authorization || ''}`); }
      if (req.url === '/health') { res.writeHead(200, { 'content-type': 'application/health+json' }); return res.end(JSON.stringify({ status: 'pass' })); }
      res.writeHead(404); res.end();
    });
    try {
      const dir = repo({ 'package.json': JSON.stringify({ name: 'svc', private: true, type: 'module' }) });
      sc(dir, 'live', ['--write', '--lang', 'js', '--base-url', url]);
      const r = await runAsync(process.execPath, [ADC, 'live', 'run', '--json', '--cwd', dir], { env: baseEnv({ ADC_LIVE_TOKEN: token }) });
      assert.equal(r.status, 0, r.stdout + r.stderr);
      const out = JSON.parse(r.stdout);
      assert.deepEqual(out.probes.map((p) => [p.id, p.status, p.cost]), [['readonly/health', 'pass', 1]]);
      assert.ok(!r.stdout.includes(token) && !r.stderr.includes(token));
      // A rejected token fails closed and is reported as AUTH_REJECTED.
      const bad = await runAsync(process.execPath, [ADC, 'live', 'run', '--json', '--cwd', dir], { env: baseEnv({ ADC_LIVE_TOKEN: `${token}-wrong` }) });
      const badOut = JSON.parse(bad.stdout);
      assert.equal(badOut.probes[0].status, 'fail');
      assert.equal(badOut.probes[0].reason, 'AUTH_REJECTED');
      assert.ok(!bad.stdout.includes(`${token}-wrong`));
    } finally {
      server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// ci-gate and the generated gate helper

describe('ci-gate', () => {
  test('node project: Merge OK aggregate over path-filtered jobs, retries off, reports, coverage, ratchet, secrets, audit', async () => {
    const dir = repo(nodeProject());
    const res = sc(dir, 'ci-gate', ['--write']);
    assert.deepEqual(paths(res).sort(), ['.github/adc/gate.mjs', '.github/workflows/ci-gate.yml']);
    const wf = read(dir, '.github/workflows/ci-gate.yml');
    const jobs = checkYaml(path.join(dir, '.github/workflows/ci-gate.yml'));
    if (jobs) assert.deepEqual(jobs, ['audit', 'changes', 'coverage-root', 'merge-ok', 'ratchet', 'secrets', 'test-root']);
    assert.match(wf, /needs: \[changes, test-root, coverage-root, ratchet, secrets\]/);
    assert.match(wf, /name: Merge OK\n    if: \$\{\{ always\(\) \}\}/);
    assert.match(wf, /dorny\/paths-filter@v4/);
    assert.match(wf, /npm ci/);
    assert.match(wf, /node --test --test-reporter=spec --test-reporter-destination=stdout --test-reporter=junit --test-reporter-destination=reports\/junit\.xml/);
    assert.match(wf, /gate\.mjs" counts --format junit --report 'reports\/junit\.xml'/);
    assert.match(wf, /dorny\/test-reporter@v3/);
    assert.match(wf, /diff-cover/);
    assert.match(wf, /node "\$ADC" diff-scope --base "origin\/\$BASE_REF" --json/);
    assert.match(wf, /gitleaks/);
    assert.match(wf, /npm audit --audit-level=high/);
    assert.match(wf, /executed: \$\{\{ needs\.test-root\.outputs\.executed \}\}/);
    assert.match(wf, /ADC_REF: v\d+\.\d+\.\d+/);
    assert.match(wf, /os: \["ubuntu-latest"\]/);
    assert.ok(!/needs: \[[^\]]*audit/.test(wf), 'the audit job is not part of Merge OK');
    validateAll(dir, res);
    await assertNoSelfFindings(dir, res);
    const M = await loadMarkers();
    if (M && M.CI_GATE_HEADER) assert.match(wf, M.CI_GATE_HEADER);
  });

  test('stacks, OS matrix, vendored skill, agent jobs, quarantine registry, --test-cmd and the no-runner error', async () => {
    const py = repo({ ...PY_PROJECT, '.python-version': '3.12\n' });
    const r1 = sc(py, 'ci-gate', ['--write', '--os', 'linux,windows,macos', '--threshold', '90', '--for', 'copilot']);
    const w1 = read(py, '.github/workflows/ci-gate.yml');
    assert.match(w1, /os: \["ubuntu-latest", "windows-latest", "macos-latest"\]/);
    assert.match(w1, /astral-sh\/setup-uv@v7/);
    assert.match(w1, /python-version-file: \.python-version/);
    assert.match(w1, /uv run --frozen pytest -p no:rerunfailures --junit-xml=reports\/junit\.xml/);
    assert.match(w1, /pip-audit/);
    assert.match(w1, /copilot -p "Use the agentic-developer-companion skill to verify origin\/\$BASE_REF/);
    assert.match(w1, /COPILOT_GITHUB_TOKEN: \$\{\{ secrets\.COPILOT_GITHUB_TOKEN \}\}/);
    assert.ok(!/coverage-root/.test(w1), 'no pytest-cov: no coverage job');
    assert.ok(r1.next_steps.some((s) => /no changed-line coverage producer/.test(s)));
    validateAll(py, r1);
    await assertNoSelfFindings(py, r1);

    const go = repo({ ...GO_PROJECT, '.github/skills/agentic-developer-companion/scripts/adc.mjs': '// vendored\n', '.github/workflows/old.yml': 'jobs:\n  a:\n    runs-on: windows-latest\n' });
    const r2 = sc(go, 'ci-gate', ['--write', '--for', 'claude,codex']);
    const w2 = read(go, '.github/workflows/ci-gate.yml');
    assert.equal(r2.vendored_skill, '.github/skills/agentic-developer-companion');
    assert.match(w2, /ADC=\$GITHUB_WORKSPACE\/\.github\/skills\/agentic-developer-companion\/scripts\/adc\.mjs/);
    assert.match(w2, /os: \["windows-latest"\]/, 'the OS matrix follows the existing workflows');
    assert.match(w2, /go-version-file: go\.mod/);
    assert.match(w2, /go test \.\/\.\.\. -count=1 -json > reports\/go-test\.jsonl/);
    assert.match(w2, /node "\$ADC" "\$\{args\[@\]\}" > "\$RUNNER_TEMP\/coverage-delta\.json"/);
    assert.match(w2, /claude -p "\/agentic-developer-companion verify origin\/\$BASE_REF --yes"/);
    assert.match(w2, /codex exec --json -s workspace-write/);
    assert.match(w2, /"Use \\\$agentic-developer-companion to verify/);
    checkYaml(path.join(go, '.github/workflows/ci-gate.yml'));
    await assertNoSelfFindings(go, r2);

    const node = repo(nodeProject({ extra: { 'tests/quarantine.json': JSON.stringify({ schema: 'adc-quarantine/1', tests: [] }) } }));
    sc(node, 'ci-gate', ['--write']);
    const w3 = read(node, '.github/workflows/ci-gate.yml');
    assert.match(w3, /--test-skip-pattern=@quarantine/);
    assert.match(w3, /needs: \[changes, test-root, coverage-root, ratchet, secrets, quarantine\]/);
    assert.match(w3, /gate\.mjs quarantine --registry tests\/quarantine\.json/);

    const bare = repo({ 'README.md': 'nothing to test\n' });
    assert.equal(sc(bare, 'ci-gate', [], { exit: 3 }).error.code, 'NO_RUNNER');
    const custom = sc(bare, 'ci-gate', ['--test-cmd', 'make check', '--write']);
    assert.match(read(bare, '.github/workflows/ci-gate.yml'), /make check 2>&1 \| tee reports\/test-output\.log/);
    assert.match(read(bare, '.github/workflows/ci-gate.yml'), /--format summary --report 'reports\/test-output\.log'/);
    validateAll(bare, custom);
    assert.match(sc(bare, 'ci-gate', ['--threshold', '120'], { exit: 2 }).error.message, /--threshold/);
    assert.match(sc(bare, 'ci-gate', ['--os', 'solaris', '--test-cmd', 'x'], { exit: 2 }).error.message, /--os/);
  });

  test('gate.mjs counts, ratchet, coverage and quarantine behave as the workflows expect', async () => {
    const dir = repo(nodeProject());
    sc(dir, 'ci-gate', ['--write']);
    const gate = path.join(dir, '.github/adc/gate.mjs');
    const out = path.join(TMP, `gh-${++seq}`);
    fs.mkdirSync(out);
    const run = (args, extra = {}) => {
      const env = baseEnv({ ADC: ADC, GITHUB_OUTPUT: path.join(out, 'output'), GITHUB_STEP_SUMMARY: path.join(out, 'summary.md'), ...extra });
      return spawnSync(process.execPath, [gate, ...args], { cwd: dir, encoding: 'utf8', env });
    };
    const junit = (cases) => `<?xml version="1.0"?>\n<testsuites><testsuite name="s" tests="${cases.length}">${cases.join('')}</testsuite></testsuites>\n`;
    write(dir, {
      'reports/ok.xml': junit(['<testcase classname="a" name="one"/>', '<testcase classname="a" name="two"/>', '<testcase classname="a" name="three"><skipped/></testcase>']),
      'reports/sub/fail.xml': junit(['<testcase classname="b" name="bad"><failure message="boom">x</failure></testcase>']),
      'reports/empty.xml': junit([]),
    });
    const ok = run(['counts', '--format', 'junit', '--report', 'reports/ok.xml', '--project', '.', '--out', path.join(out, 'counts.json')]);
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    const counts = JSON.parse(fs.readFileSync(path.join(out, 'counts.json'), 'utf8'));
    assert.equal(counts.schema, 'adc-counts/1');
    assert.deepEqual(counts.projects['.'], { executed: 2, passed: 2, failed: 0, errors: 0, skipped: 1, flaky: 0 });
    assert.match(fs.readFileSync(path.join(out, 'output'), 'utf8'), /^executed=2$/m);
    assert.match(fs.readFileSync(path.join(out, 'summary.md'), 'utf8'), /\| 2 \| 2 \| 0 \| 0 \| 1 \| 0 \|/);
    let clean = null;
    try { clean = await import('../../scripts/lib/clean-run.mjs'); } catch {}
    if (clean && typeof clean.importBaseCounts === 'function') {
      assert.equal(clean.importBaseCounts(path.join(out, 'counts.json'), '.').executed, 2, 'clean-run --base-counts imports the CI counts');
    }
    const glob = run(['counts', '--format', 'junit', '--report', 'reports/**/*.xml']);
    assert.equal(glob.status, 1, 'the failing report fails the gate');
    assert.match(glob.stdout, /::error::1 failed and 0 errored test/);
    assert.equal(run(['counts', '--format', 'junit', '--report', 'reports/empty.xml']).status, 1);
    assert.match(run(['counts', '--format', 'junit', '--report', 'reports/none.xml']).stdout, /no test report matches/);
    assert.equal(run(['counts', '--format', 'junit', '--report', 'reports/ok.xml'], { ADC: '' }).status, 1);
    assert.equal(run(['counts', '--report', 'x']).status, 2);
    assert.equal(run(['nope']).status, 2);

    write(dir, {
      'ds-fail.json': JSON.stringify({ base: { ref: 'main' }, findings: [{ id: 'CK-SKIP', severity: 'fail', file: 'a.test.js', line: 3, message: 'it.only added' }, { id: 'CK-SCOPE', severity: 'finding', file: 'b.js', line: null, message: 'outside spec, 50%: x' }] }),
      'ds-soft.json': JSON.stringify({ base: { ref: 'main' }, findings: [{ id: 'CK-CI', severity: 'finding', file: '.github/workflows/x.yml', message: 'new CI workflow' }] }),
      'ds-error.json': JSON.stringify({ error: { code: 'SHALLOW', message: 'run git fetch --unshallow' } }),
    });
    const hard = run(['ratchet', '--report', 'ds-fail.json', '--exit', '1']);
    assert.equal(hard.status, 1);
    assert.match(hard.stdout, /::error file=a\.test\.js,line=3,title=CK-SKIP::CK-SKIP: it\.only added/);
    assert.match(hard.stdout, /::warning file=b\.js,title=CK-SCOPE::CK-SCOPE: outside spec, 50%25: x/);
    assert.equal(run(['ratchet', '--report', 'ds-soft.json', '--exit', '1']).status, 0);
    assert.equal(run(['ratchet', '--report', 'ds-soft.json', '--exit', '4']).status, 1);
    assert.match(run(['ratchet', '--report', 'ds-error.json', '--exit', '4']).stdout, /could not run: SHALLOW/);
    assert.equal(run(['ratchet', '--report', 'missing.json', '--exit', '0']).status, 1);

    write(dir, { 'cov.json': JSON.stringify({ tool: 'adc', changed_lines: 10, pct: 80, precision: 'line', uncovered: [{ file: 'a.go', lines: [3, 4] }] }) });
    assert.equal(run(['coverage', '--report', 'cov.json']).status, 0);
    assert.match(fs.readFileSync(path.join(out, 'summary.md'), 'utf8'), /80\.0% of 10 changed line/);

    const reg = (tests) => { write(dir, { 'tests/quarantine.json': JSON.stringify({ schema: 'adc-quarantine/1', tests }) }); return run(['quarantine', '--registry', 'tests/quarantine.json', '--today', '2026-10-25']); };
    const good = reg([{ id: 'login flaky', owner: '@team', issue: '#12', added: '2026-10-20', expires: '2026-11-10', reason: 'race' }]);
    assert.equal(good.status, 0, good.stdout);
    assert.match(fs.readFileSync(path.join(out, 'output'), 'utf8'), /^count=1$/m);
    assert.equal(reg([{ id: 'x', owner: 'o', issue: 'i', expires: '2026-10-01' }]).status, 1);
    assert.match(reg([{ id: 'x', owner: 'o', issue: 'i', expires: '2026-10-01' }]).stdout, /expired on 2026-10-01/);
    assert.match(reg([{ id: 'x', expires: '2026-12-01' }]).stdout, /"owner" is required/);
    assert.match(reg([{ id: 'x', owner: 'o', issue: 'i', added: '2026-10-01', expires: '2026-12-31' }]).stdout, /more than 30 days/);
    assert.equal(reg([]).status, 0);

    const mod = await import(pathToFileURL(gate).href);
    assert.deepEqual(mod.expand(path.join(dir, 'reports', '**', '*.xml').replace(/\\/g, '/')).map((f) => path.basename(f)), ['empty.xml', 'ok.xml', 'fail.xml']);
  });
});

// ---------------------------------------------------------------------------
// flake

describe('flake', () => {
  test('policy, registry, weekly workflow and the shared gate helper; --test adds a diagnosis report', async () => {
    const dir = repo(nodeProject());
    const res = sc(dir, 'flake', ['--write', '--test', 'sum > handles floats', '--max-flaky', '1']);
    for (const f of ['tests/flaky-test-policy.md', 'tests/quarantine.json', '.github/workflows/quarantine.yml', '.github/adc/gate.mjs', '.adc/repro/flake/sum-handles-floats/diagnosis.md']) {
      assert.ok(paths(res).includes(f), `${f} missing from ${paths(res).join(', ')}`);
    }
    assert.deepEqual(JSON.parse(read(dir, 'tests/quarantine.json')), { schema: 'adc-quarantine/1', max_flaky: 1, max_days: 30, policy: 'tests/flaky-test-policy.md', tests: [] });
    const policy = read(dir, 'tests/flaky-test-policy.md');
    for (const re of [/@quarantine/, /--test-skip-pattern=@quarantine/, /failOnFlakyTests/, /gh run rerun --failed/, /more than 1 flaky/, /owner/, /expires/]) assert.match(policy, re);
    const wf = read(dir, '.github/workflows/quarantine.yml');
    assert.match(wf, /node --test --test-name-pattern=@quarantine/);
    assert.match(wf, /if: \$\{\{ needs\.registry\.outputs\.count != '0' \}\}/);
    assert.match(read(dir, '.adc/repro/flake/sum-handles-floats/diagnosis.md'), /flake-probe --tests "sum > handles floats" --times 20/);
    validateAll(dir, res);
    await assertNoSelfFindings(dir, res);
    // ci-gate after flake: identical gate helper (unchanged), quarantine exclusion and registry check.
    const gate = sc(dir, 'ci-gate', ['--write']);
    assert.equal(gate.written.find((w) => w.path === '.github/adc/gate.mjs').action, 'unchanged');
    assert.equal(gate.quarantine, 'tests/quarantine.json');
    assert.match(read(dir, '.github/workflows/ci-gate.yml'), /--test-skip-pattern=@quarantine/);
  });

  test('pytest project uses markers for the quarantine', () => {
    const dir = repo(PY_PROJECT);
    sc(dir, 'flake', ['--write']);
    assert.match(read(dir, '.github/workflows/quarantine.yml'), /uv run --frozen pytest -m quarantine/);
    assert.match(read(dir, 'tests/flaky-test-policy.md'), /-m "not quarantine"/);
  });
});
