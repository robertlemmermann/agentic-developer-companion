// Unit and scenario tests for scripts/lib/markers.mjs, diff-scope.mjs and deps.mjs.
// Scenarios come from tests/fixtures (section "diffs") and run in temp git repos, both
// committed on a feature branch and uncommitted/untracked on main.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as core from '../../scripts/lib/core.mjs';
import * as git from '../../scripts/lib/git.mjs';
import * as state from '../../scripts/lib/state.mjs';
import * as M from '../../scripts/lib/markers.mjs';
import { diffScope, extractSpecPaths, narrowsCommand, keyPath } from '../../scripts/lib/diff-scope.mjs';
import * as deps from '../../scripts/lib/deps.mjs';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
export function tableSection(name) {
  const table = path.join(FIX, 'table.json');
  if (fs.existsSync(table)) { const t = JSON.parse(fs.readFileSync(table, 'utf8')); if (t[name]) return t[name]; }
  return JSON.parse(fs.readFileSync(path.join(FIX, '_parts', `${name}.json`), 'utf8'));
}

const ADC = core.ADC_SCRIPT;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'adc-diffscope-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
// Secrets are assembled at runtime so no secret-shaped literal exists in the repository.
const AWS_KEY = ['AKIA', 'IOSFODNN7', 'EXAMPLE'].join('');
const GH_TOKEN = ['ghp', '_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'].join('');
const PLACEHOLDERS = { '{{AWS_KEY}}': AWS_KEY };
const fill = (s) => Object.entries(PLACEHOLDERS).reduce((t, [k, v]) => t.split(k).join(v), s);
// Hermetic environment: built-in scanner, no live token, an empty npm cache, no network lookups.
const NPM_CACHE = path.join(TMP, 'npm-cache');
const ENV = { ...process.env, ADC_SECRETS_SCANNER: 'builtin', npm_config_cache: NPM_CACHE, UV_CACHE_DIR: path.join(TMP, 'uv-cache'),
  GOMODCACHE: path.join(TMP, 'gomodcache'), CARGO_HOME: path.join(TMP, 'cargo-home') };
delete ENV.ADC_LIVE_TOKEN;
delete ENV.ADC_HOME;

let seq = 0;
function sh(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
function writeFiles(dir, files) {
  for (const [p, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), fill(c));
  }
}
function initRepo(files) {
  const dir = fs.mkdtempSync(path.join(TMP, 'repo-'));
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.email', 't@example.com');
  sh(dir, 'config', 'user.name', 'Test');
  sh(dir, 'config', 'commit.gpgsign', 'false');
  sh(dir, 'config', 'core.autocrlf', 'false');
  writeFiles(dir, files);
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', 'base');
  return dir;
}

const DIFFS = tableSection('diffs');
let template = null;
function scenarioRepo() {
  if (!template) template = initRepo(DIFFS.base);
  const dir = path.join(TMP, `s${++seq}`);
  fs.cpSync(template, dir, { recursive: true });
  return dir;
}
function applyOps(dir, ops) {
  for (const op of ops) {
    const p = (rel) => path.join(dir, rel);
    if (op.op === 'write') { fs.mkdirSync(path.dirname(p(op.path)), { recursive: true }); fs.writeFileSync(p(op.path), fill(op.content)); }
    else if (op.op === 'delete') fs.rmSync(p(op.path));
    else if (op.op === 'rename') { fs.mkdirSync(path.dirname(p(op.to)), { recursive: true }); fs.renameSync(p(op.from), p(op.to)); }
    else if (op.op === 'edit') {
      const text = fs.readFileSync(p(op.path), 'utf8');
      assert.ok(text.includes(op.find), `fixture edit: "${op.find.slice(0, 40)}" not found in ${op.path}`);
      fs.writeFileSync(p(op.path), text.replace(op.find, fill(op.replace)));
    } else throw new Error(`unknown op ${op.op}`);
  }
}
function prepare(ops, variant) {
  const dir = scenarioRepo();
  if (variant === 'committed') sh(dir, 'checkout', '-q', '-b', 'feature');
  applyOps(dir, ops);
  if (variant === 'committed') { sh(dir, 'add', '-A'); sh(dir, 'commit', '-q', '-m', 'change'); }
  return dir;
}
async function targetFor(dir) {
  // State dir outside the repository (see the foundation note in the default-location test).
  const ctx = core.makeContext({ cwd: dir, 'state-dir': path.join(TMP, `state-${path.basename(dir)}`) });
  return state.prepareTarget(ctx, {});
}
const severities = (findings, ids = null) => {
  const out = {};
  for (const f of findings) {
    if (f.severity === 'info' || (ids && !ids.includes(f.id))) continue;
    (out[f.id] ||= []).push(f.severity);
  }
  for (const k of Object.keys(out)) out[k].sort();
  return out;
};
const sortedExpect = (e) => Object.fromEntries(Object.entries(e || {}).filter(([, v]) => v.length).map(([k, v]) => [k, [...v].sort()]));
const resolver = (eco, name) => (name in DIFFS.registry ? DIFFS.registry[name] : null);

// ---------------------------------------------------------------------------
// markers.mjs

describe('markers', () => {
  test('classifyPath recognizes tests, configs, CI, lockfiles, manifests, generated files', () => {
    const c = (p) => M.classifyPath(p);
    assert.ok(c('tests/test_api.py').test);
    assert.ok(c('src/__tests__/a.js').test);
    assert.ok(c('pkg/calc_test.go').test);
    assert.ok(c('src/test/java/com/x/FooTest.java').test);
    assert.ok(c('spec/models/user_spec.rb').test);
    assert.ok(!c('src/app.py').test);
    assert.ok(!c('tests/fixtures/data.json').test && c('tests/fixtures/data.json').testData);
    assert.ok(c('src/__snapshots__/a.test.js.snap').snapshot && !c('src/__snapshots__/a.test.js.snap').test);
    assert.ok(c('jest.config.ts').runnerConfig && c('pytest.ini').runnerConfig && c('.mocharc.yml').runnerConfig && c('.config/nextest.toml').runnerConfig);
    assert.ok(c('.github/workflows/ci.yml').ci && c('.gitlab-ci.yml').ci && c('azure-pipelines.yml').ci && c('.circleci/config.yml').ci && c('Jenkinsfile').ci);
    assert.ok(!c('.github/dependabot.yml').ci);
    assert.ok(c('package-lock.json').lockfile && c('uv.lock').lockfile && c('go.sum').lockfile && c('Cargo.lock').lockfile && !c('Cargo.lock').generated);
    assert.ok(c('.eslintrc.json').lintConfig && c('tsconfig.base.json').lintConfig && c('.golangci.yml').lintConfig && c('.editorconfig').lintConfig);
    assert.ok(c('package.json').manifest && c('requirements-dev.txt').manifest && c('src/App.csproj').manifest && c('go.mod').manifest);
    assert.ok(c('dist/app.js').generated && c('api/v1/user.pb.go').generated && c('web/vendor.min.js').generated && !c('bin/cli.js').generated);
    assert.ok(c('C:\\repo\\tests\\test_x.py'.replace(/^C:\\repo\\/, '')).test, 'backslash paths are normalized');
  });

  test('testNaming follows each runner convention and is case-aware for JVM', () => {
    assert.equal(M.testNaming('a/b.test.ts'), 'js');
    assert.equal(M.testNaming('tests/test_x.py'), 'pytest');
    assert.equal(M.testNaming('x_test.go'), 'go');
    assert.equal(M.testNaming('src/FooTest.java'), 'jvm');
    assert.equal(M.testNaming('src/Latest.java'), null);
    assert.equal(M.testNaming('tests/service_checks.py'), null);
  });

  test('skip/focus markers per ecosystem, anchored to test APIs', () => {
    const hit = (line, file) => M.scanText([line], M.SKIP_MARKERS, { file }).map((h) => h.kind);
    assert.deepEqual(hit("it.only('x', () => {})", 'a.test.js'), ['focus']);
    assert.deepEqual(hit("test.describe.only('x', () => {})", 'a.spec.ts'), ['focus']);
    assert.deepEqual(hit("fdescribe('x', () => {})", 'a.test.js'), ['focus']);
    assert.deepEqual(hit("xit('x', () => {})", 'a.test.js'), ['skip']);
    assert.deepEqual(hit("test.skip.each([[1]])('x %i', () => {})", 'a.test.js'), ['skip']);
    assert.deepEqual(hit("describe['skip']('x', () => {})", 'a.test.js'), ['skip']);
    assert.deepEqual(hit("test.todo('later')", 'a.test.js'), ['todo']);
    assert.deepEqual(hit("test.fails('known bug', () => {})", 'a.test.js'), ['xfail']);
    assert.deepEqual(hit('const rows = query.skip(10).only(5);', 'a.test.js'), [], 'not a test API');
    assert.deepEqual(hit("// it.only('commented out')", 'a.test.js'), [], 'comments are masked');
    assert.deepEqual(hit('@pytest.mark.skipif(sys.platform == "win32", reason="x")', 'test_a.py'), ['skip']);
    assert.deepEqual(hit('pytestmark = pytest.mark.xfail', 'test_a.py'), ['skip']);
    assert.deepEqual(hit('    pytest.importorskip("numpy")', 'test_a.py'), ['skip']);
    assert.deepEqual(hit('@unittest.skip("x")', 'test_a.py'), ['skip']);
    assert.deepEqual(hit('\tt.Skipf("needs %s", x)', 'a_test.go'), ['skip']);
    assert.deepEqual(hit('//go:build ignore', 'a_test.go'), ['skip']);
    assert.deepEqual(hit('    #[ignore = "slow"]', 'lib.rs'), ['skip']);
    assert.deepEqual(hit('  @Disabled("flaky")', 'FooTest.java'), ['skip']);
    assert.deepEqual(hit('  @Test(enabled = false)', 'FooTest.java'), ['skip']);
    assert.deepEqual(hit('[Fact(Skip = "later")]', 'FooTests.cs'), ['skip']);
    assert.deepEqual(hit('[Test, Ignore("later")]', 'FooTests.cs'), ['skip']);
    assert.deepEqual(hit("  xit 'works' do", 'a_spec.rb'), ['skip']);
    assert.deepEqual(hit("  it 'works', focus: true do", 'a_spec.rb'), ['focus']);
    assert.deepEqual(hit('$this->markTestSkipped("x");', 'FooTest.php'), ['skip']);
    assert.deepEqual(hit('throw XCTSkip("x")', 'FooTests.swift'), ['skip']);
  });

  test('suppression directives per ecosystem; file-wide scope is flagged', () => {
    const ids = (line, file) => M.scanText([line], M.SUPPRESSIONS, { file }).map((h) => h.id);
    assert.deepEqual(ids('/* eslint-disable */', 'a.js'), ['suppress.eslint-file']);
    assert.deepEqual(ids('foo(); // eslint-disable-line no-console', 'a.ts'), ['suppress.eslint']);
    assert.deepEqual(ids('// @ts-nocheck', 'a.ts'), ['suppress.ts-nocheck']);
    assert.deepEqual(ids('// @ts-expect-error', 'a.ts'), ['suppress.ts-ignore']);
    assert.deepEqual(ids('x = 1  # type: ignore[assignment]', 'a.py'), ['suppress.py-type-ignore']);
    assert.deepEqual(ids('# ruff: noqa', 'a.py'), ['suppress.py-file-noqa']);
    assert.deepEqual(ids('import os  # noqa: F401', 'a.py'), ['suppress.py-noqa']);
    assert.deepEqual(ids('x()  //nolint:errcheck', 'a.go'), ['suppress.go']);
    assert.deepEqual(ids('#![allow(dead_code)]', 'lib.rs'), ['suppress.rs-crate']);
    assert.deepEqual(ids('#pragma warning disable CS0618', 'A.cs'), ['suppress.cs']);
    assert.deepEqual(ids('@SuppressWarnings("unchecked")', 'A.java'), ['suppress.jvm']);
    assert.deepEqual(ids('foo # rubocop:disable Metrics/AbcSize', 'a.rb'), ['suppress.rb']);
    assert.deepEqual(ids('/** @phpstan-ignore-next-line */', 'a.php'), ['suppress.php']);
    assert.deepEqual(ids('const disabled = true;', 'a.js'), []);
  });

  test('swallow patterns, including multi-line empty handlers', () => {
    const ids = (lines, file) => M.scanText(lines, M.SWALLOW_PATTERNS, { file }).map((h) => `${h.id}@${h.line}`);
    assert.deepEqual(ids(['try { a() } catch {}'], 'a.js'), ['swallow.empty-catch@1']);
    assert.deepEqual(ids(['} catch (err) {', '  // ignore', '}'], 'a.ts'), ['swallow.empty-catch@1']);
    assert.deepEqual(ids(['} catch (err) {', '  log(err);', '}'], 'a.ts'), []);
    assert.deepEqual(ids(['p.catch(() => {})'], 'a.js'), ['swallow.promise-catch@1']);
    assert.deepEqual(ids(['except Exception:', '    pass'], 'a.py'), ['swallow.py-except-pass@1']);
    assert.deepEqual(ids(['except:', '    log()'], 'a.py'), ['swallow.py-bare-except@1']);
    assert.deepEqual(ids(['if err != nil {', '}'], 'a.go'), ['swallow.go-empty-err@1']);
    assert.deepEqual(ids(['Err(_) => {}'], 'a.rs'), ['swallow.rs@1']);
    assert.deepEqual(ids(['value = compute rescue nil'], 'a.rb'), ['swallow.rb@1']);
  });

  test('CI weakening, lint-config weakening and in-source retries', () => {
    const ci = (l) => M.scanText([l], M.CI_WEAKENING).map((h) => h.id);
    assert.deepEqual(ci('        continue-on-error: true'), ['ci.continue-on-error']);
    assert.deepEqual(ci('      - run: npm test || true'), ['ci.or-true']);
    assert.deepEqual(ci('  allow_failure: true'), ['ci.allow-failure']);
    assert.deepEqual(ci('run: mvn -DskipTests package'), ['ci.skip-tests']);
    assert.deepEqual(ci("if: ${{ github.event_name == 'push' || github.ref == 'refs/heads/main' }}"), []);
    const lint = (l) => M.scanText([l], M.LINT_CONFIG_WEAKENING).map((h) => h.id);
    assert.deepEqual(lint('    "no-unused-vars": "off",'), ['lintcfg.rule-off']);
    assert.deepEqual(lint("    '@typescript-eslint/no-explicit-any': 0,"), ['lintcfg.rule-off']);
    assert.deepEqual(lint('  "maxWarnings": 0'), [], 'numeric settings are not rules');
    assert.deepEqual(lint('    "strict": false,'), ['lintcfg.ts-strict-off']);
    assert.deepEqual(lint('dotnet_diagnostic.CA1062.severity = none'), ['lintcfg.severity-none']);
    assert.deepEqual(lint('ignore_errors = True'), ['lintcfg.mypy-off']);
    const retry = (l, f) => M.scanText([l], M.IN_SOURCE_RETRIES, { file: f }).map((h) => h.id);
    assert.deepEqual(retry('jest.retryTimes(2);', 'a.test.js'), ['retry.jest']);
    assert.deepEqual(retry("test.describe.configure({ retries: 2 });", 'a.spec.ts'), ['retry.playwright']);
    assert.deepEqual(retry('@pytest.mark.flaky(reruns=3)', 'test_a.py'), ['retry.py']);
    assert.deepEqual(retry('this.retries(3);', 'a.test.js'), ['retry.mocha']);
  });

  test('test-case extraction with names across languages', () => {
    const names = (text, file) => M.testCases(text.split('\n'), file).map((c) => c.name);
    assert.deepEqual(names("it('a', () => {})\n  test.each([[1, 2]])('b %i', () => {})\nxit('c')\n// it('d')", 'a.test.js'), ['a', 'b %i', 'c']);
    assert.deepEqual(names('def test_one():\n    pass\nasync def test_two():\n    pass\n"""\ndef test_hidden():\n"""', 'test_a.py'), ['test_one', 'test_two']);
    assert.deepEqual(names('func TestA(t *testing.T) {\n\tt.Run("sub", func(t *testing.T) {})\n}\nfunc BenchmarkB(b *testing.B) {}', 'a_test.go'), ['TestA', 'sub']);
    assert.deepEqual(names('#[test]\nfn one() {}\n#[tokio::test(flavor = "multi_thread")]\nasync fn two() {}\n#[cfg(test)]', 'lib.rs'), ['one', 'two']);
    assert.deepEqual(names('@Test\nvoid addsNumbers() {}\n@TestInstance\nclass X {}', 'ATest.java'), ['addsNumbers']);
    assert.deepEqual(names('[Fact]\npublic void Adds() {}\n[TestCase(1)]\n[TestCase(2)]\npublic void P(int x) {}', 'ATests.cs'), ['Adds', 'P', 'P']);
    assert.deepEqual(names("it 'works' do\nend\ndef test_legacy\nend", 'a_spec.rb'), ['works', 'test_legacy']);
  });

  test('secret scanning masks values and ignores placeholders', () => {
    const lines = [
      `aws = "${AWS_KEY}"`,
      `token: ${GH_TOKEN}`,
      'password = "changeme"',
      'api_key = process.env.API_KEY',
      `url = "postgres://app:${['s3cr', 'etValue9'].join('')}@db.internal.example.org:5432/app"`,
      'url = "postgres://postgres:postgres@localhost:5432/app"',
      `ADC_LIVE_TOKEN=${['live', 'TokenValue1'].join('')}`,
      'ADC_LIVE_TOKEN=',
    ].join('\n');
    const hits = M.scanSecrets(lines);
    assert.deepEqual(hits.map((h) => `${h.id}@${h.line}`), ['secret.aws-access-key-id@1', 'secret.github-token@2', 'secret.url-credentials@5', 'secret.adc-live-token@7']);
    for (const h of hits) {
      assert.ok(!h.redacted.includes(AWS_KEY) && !h.redacted.includes(GH_TOKEN) && !h.redacted.includes('etValue9') && !h.redacted.includes('TokenValue1'), h.redacted);
      assert.ok(h.redacted.includes('[REDACTED]'));
    }
    assert.equal(M.scanSecrets('password = "hunter2abc"').length, 0, 'the leak-matrix token matches no regex by design');
    assert.equal(M.credentialFileName('config/.env.production'), 'dotenv');
    assert.equal(M.credentialFileName('.env.example'), null);
    assert.equal(M.credentialFileName('keys/id_ed25519'), 'ssh-key');
  });

  test('the skill tree itself contains no secret-shaped strings', () => {
    const files = core.listFiles(core.SKILL_DIR).filter((f) => !/\.(?:png|jpg|gif|ico)$/.test(f));
    const hits = [];
    for (const f of files) {
      const text = core.readText(path.join(core.SKILL_DIR, f)) || '';
      for (const h of M.scanSecrets(text)) if (h.severity === 'fail') hits.push(`${f}:${h.line} ${h.id}`);
    }
    assert.deepEqual(hits, []);
  });
});

// ---------------------------------------------------------------------------
// deps.mjs (pure parts)

describe('deps parsing', () => {
  test('parseTomlLite: tables, arrays of tables, inline tables, multi-line arrays', () => {
    const t = deps.parseTomlLite('a = 1\n[project]\nname = "x" # c\ndependencies = [\n  "requests>=2",\n  \'six\',\n]\n[tool.uv.sources]\nlib = { path = "../lib" }\n[[package]]\nname = "p1"\n[[package]]\nname = "p2"\n[package.source]\nregistry = "r"\nbad line here\nz = true\n');
    assert.equal(t.a, 1);
    assert.deepEqual(t.project.dependencies, ['requests>=2', 'six']);
    assert.equal(t.tool.uv.sources.lib.path, '../lib');
    assert.deepEqual(t.package.map((p) => p.name), ['p1', 'p2']);
    assert.equal(t.package[1].source.registry, 'r');
    assert.equal(t.package[1].source.z, true, 'an unparsable line is skipped, parsing continues');
  });

  test('parseManifest covers npm, Python, Go, Cargo, Ruby, NuGet, Maven, Gradle, Composer', () => {
    const names = (file, text) => deps.parseManifest(file, text).deps.map((d) => `${d.name}:${d.kind}`);
    assert.deepEqual(names('package.json', JSON.stringify({ dependencies: { a: '^1', b: 'file:../b', c: 'workspace:*', d: 'github:o/r', e: 'npm:real@^2' }, devDependencies: { f: '1' } })),
      ['a:registry', 'b:local', 'c:workspace', 'd:git', 'e:alias', 'f:registry']);
    assert.equal(deps.parseManifest('package.json', JSON.stringify({ dependencies: { e: 'npm:real-pkg@^2' } })).deps[0].real, 'real-pkg');
    assert.deepEqual(names('pyproject.toml', '[project]\ndependencies = ["requests[socks]>=2 ; python_version>\'3\'", "mylib @ file:///x"]\n[tool.poetry.dependencies]\npython = "^3.10"\nflask = "^3"\nlocal = { path = "../l" }\n'),
      ['requests:registry', 'mylib:local', 'flask:registry', 'local:local']);
    assert.deepEqual(names('requirements.txt', 'requests==2.31.0 \\\n    --hash=sha256:abc\n-e ./libs/pkg\n-r other.txt\ngit+https://github.com/o/r.git#egg=thing\n# c\nnumpy>=1  # pinned\n'),
      ['requests:registry', 'pkg:local', 'thing:git', 'numpy:registry']);
    const gomod = deps.parseManifest('go.mod', 'module example.com/m\n\ngo 1.22\n\nrequire (\n\tgithub.com/a/b v1.2.3\n\tgithub.com/c/d v0.1.0 // indirect\n)\nrequire golang.org/x/text v0.3.0\nreplace github.com/a/b => ../b\n');
    assert.deepEqual(gomod.deps.map((d) => `${d.name}@${d.spec}:${d.section}`), ['github.com/a/b@v1.2.3:require', 'github.com/c/d@v0.1.0:require-indirect', 'golang.org/x/text@v0.3.0:require']);
    assert.deepEqual(gomod.replaces.map((r) => `${r.from}=>${r.to}:${r.local}`), ['github.com/a/b=>../b:true']);
    assert.deepEqual(names('Cargo.toml', '[dependencies]\nserde = "1"\nlocal = { path = "../l" }\nrenamed = { version = "1", package = "real" }\n[dependencies.tokio]\nversion = "1"\n[target.\'cfg(unix)\'.dependencies]\nnix = "0.27"\n'),
      ['serde:registry', 'local:local', 'renamed:registry', 'tokio:registry', 'nix:registry']);
    assert.deepEqual(names('Gemfile', "source 'https://rubygems.org'\ngem 'rails', '~> 7.1'\ngem 'mine', path: '../mine'\n"), ['rails:registry', 'mine:local']);
    assert.deepEqual(names('App.csproj', '<Project><ItemGroup><PackageReference Include="Newtonsoft.Json" Version="13.0.3" /><PackageReference Include="Serilog">\n<Version>3.1.1</Version></PackageReference></ItemGroup></Project>'), ['Newtonsoft.Json:registry', 'Serilog:registry']);
    assert.deepEqual(names('pom.xml', '<project><dependencies><dependency><groupId>junit</groupId><artifactId>junit</artifactId><version>4.13.2</version><scope>test</scope></dependency></dependencies></project>'), ['junit:junit:registry']);
    assert.deepEqual(names('build.gradle.kts', 'dependencies {\n  implementation("com.google.guava:guava:33.0.0-jre")\n  testImplementation \'org.junit.jupiter:junit-jupiter:5.10.0\'\n  implementation(project(":core"))\n}\n'), ['com.google.guava:guava:registry', 'org.junit.jupiter:junit-jupiter:registry']);
    assert.deepEqual(names('composer.json', JSON.stringify({ require: { php: '>=8.1', 'ext-json': '*', 'monolog/monolog': '^3' } })), ['monolog/monolog:registry']);
    assert.equal(deps.parseManifest('README.md', 'x'), null);
  });

  test('manifestDelta reports added, removed, changed and redirected dependencies', () => {
    const m = (o) => deps.parseManifest('package.json', JSON.stringify(o));
    const d = deps.manifestDelta(m({ dependencies: { a: '^1', b: '^2', c: '^3' } }), m({ dependencies: { a: '^1', b: 'file:./stub', d: '^4' } }));
    assert.deepEqual(d.added.map((x) => x.name), ['d']);
    assert.deepEqual(d.removed.map((x) => x.name), ['c']);
    assert.deepEqual(d.changed.map((x) => x.dep.name), ['b']);
    assert.deepEqual(d.redirected.map((x) => x.dep.name), ['b']);
  });

  test('lockIndex and lockHas for every supported lockfile', () => {
    const has = (lock, text, eco, name, spec = '*', opts) => deps.lockHas(deps.lockIndex(lock, text), eco, { name, spec }, opts);
    const npmLock = JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: { a: '^1' } }, 'node_modules/a': { version: '1.0.0' }, 'node_modules/a/node_modules/@s/b': { version: '2.0.0' } } });
    assert.ok(has('package-lock.json', npmLock, 'npm', 'a') && has('package-lock.json', npmLock, 'npm', '@s/b') && !has('package-lock.json', npmLock, 'npm', 'zz'));
    assert.deepEqual(deps.lockIndex('package-lock.json', npmLock).root, { a: '^1' });
    const pnpm = "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      left-pad:\n        specifier: ^1.3.0\n        version: 1.3.0\n  packages/web:\n    devDependencies:\n      '@types/node':\n        specifier: ^20\n        version: 20.1.0\n\npackages:\n\n  left-pad@1.3.0:\n    resolution: {integrity: x}\n";
    assert.ok(has('pnpm-lock.yaml', pnpm, 'npm', 'left-pad'));
    assert.ok(has('pnpm-lock.yaml', pnpm, 'npm', '@types/node', '*', { importer: 'packages/web' }));
    assert.ok(!has('pnpm-lock.yaml', pnpm, 'npm', '@types/node', '*', { importer: '.' }));
    const yarn = '# yarn lockfile v1\n\n"@babel/core@^7.0.0", "@babel/core@^7.1.0":\n  version "7.2.0"\n\nleft-pad@^1.3.0:\n  version "1.3.0"\n';
    assert.ok(has('yarn.lock', yarn, 'npm', 'left-pad', '^1.3.0') && !has('yarn.lock', yarn, 'npm', 'left-pad', '^2.0.0') && has('yarn.lock', yarn, 'npm', '@babel/core', '^7.1.0'));
    const berry = '__metadata:\n  version: 6\n\n"left-pad@npm:^1.3.0":\n  version: 1.3.0\n';
    assert.ok(has('yarn.lock', berry, 'npm', 'left-pad', '^1.3.0'));
    assert.ok(has('Cargo.lock', '[[package]]\nname = "serde"\nversion = "1.0.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n', 'crates', 'serde'));
    assert.ok(has('uv.lock', 'version = 1\n[[package]]\nname = "python-dateutil"\nversion = "2.9.0"\n', 'pypi', 'Python_Dateutil'));
    assert.ok(has('poetry.lock', '[[package]]\nname = "requests"\nversion = "2.31.0"\n', 'pypi', 'requests'));
    const gosum = 'golang.org/x/text v0.3.0 h1:abc=\ngolang.org/x/text v0.3.0/go.mod h1:def=\n';
    assert.ok(has('go.sum', gosum, 'go', 'golang.org/x/text', 'v0.3.0') && !has('go.sum', gosum, 'go', 'golang.org/x/text', 'v0.4.0'));
    assert.ok(has('Gemfile.lock', 'GEM\n  remote: https://rubygems.org/\n  specs:\n    rails (7.1.0)\n      rack (>= 2)\n\nDEPENDENCIES\n  rails (~> 7.1)\n', 'rubygems', 'rails'));
    assert.ok(has('composer.lock', JSON.stringify({ packages: [{ name: 'monolog/monolog', version: '3.0.0' }] }), 'composer', 'monolog/monolog'));
    assert.ok(has('Pipfile.lock', JSON.stringify({ default: { requests: { version: '==2.31.0' } }, develop: {} }), 'pypi', 'requests'));
    assert.ok(has('packages.lock.json', JSON.stringify({ version: 1, dependencies: { 'net8.0': { 'Newtonsoft.Json': { type: 'Direct', resolved: '13.0.3' } } } }), 'nuget', 'newtonsoft.json'));
    assert.ok(has('bun.lock', '{\n  "lockfileVersion": 1,\n  "workspaces": { "": { "dependencies": { "a": "^1", }, }, },\n  "packages": { "a": ["a@1.0.0", "", {}, "sha512-x"], },\n}\n', 'npm', 'a'));
    assert.equal(deps.lockFor('packages/web/package.json', new Set(['pnpm-lock.yaml', 'packages/web/package.json'])), 'pnpm-lock.yaml');
    assert.equal(deps.lockFor('svc/go.mod', new Set(['go.sum', 'svc/go.mod'])), null, 'go.sum must sit next to go.mod');
  });

  test('look-alike detection: typos, separators, homoglyphs, affixes; popular names pass', () => {
    assert.equal(deps.lookalikeOf('npm', 'lodahs'), 'lodash');
    assert.equal(deps.lookalikeOf('npm', 'expresss'), 'express');
    assert.equal(deps.lookalikeOf('npm', 'left_pad'), 'left-pad');
    assert.equal(deps.lookalikeOf('npm', 'axios-js'), 'axios');
    assert.equal(deps.lookalikeOf('pypi', 'reqeusts'), 'requests');
    assert.equal(deps.lookalikeOf('pypi', 'python-dateutils'), 'python-dateutil');
    assert.equal(deps.lookalikeOf('pypi', 'Requests'), null, 'PyPI names are case-insensitive');
    assert.equal(deps.lookalikeOf('crates', 'serde-json'), null, 'crates.io treats - and _ alike');
    assert.equal(deps.lookalikeOf('go', 'github.com/stretchr/testfy'), 'github.com/stretchr/testify');
    assert.equal(deps.lookalikeOf('npm', 'react'), null);
    assert.equal(deps.lookalikeOf('npm', 'react-dnd'), null, 'distance 2 on short names is not a look-alike');
    assert.equal(deps.lookalikeOf('npm', 'my-internal-lib', ['my-internal-lob']), 'my-internal-lob');
    assert.equal(deps.editDistance('lodash', 'lodahs'), 1);
    assert.equal(deps.editDistance('abc', 'xyz', 1), 2);
  });

  test('cache lookups read npm cacache, Go module cache, Cargo index and uv cache layouts', () => {
    const root = fs.mkdtempSync(path.join(TMP, 'caches-'));
    const npmCache = path.join(root, 'npm');
    const key = 'make-fetch-happen:request-cache:https://registry.npmjs.org/@scope%2fpkg';
    const h = core.sha256(key);
    fs.mkdirSync(path.join(npmCache, '_cacache', 'index-v5', h.slice(0, 2), h.slice(2, 4)), { recursive: true });
    fs.writeFileSync(path.join(npmCache, '_cacache', 'index-v5', h.slice(0, 2), h.slice(2, 4), h.slice(4)), `\nabc\t${JSON.stringify({ key, integrity: 'sha512-x', time: 1 })}`);
    const env = { npm_config_cache: npmCache, GOMODCACHE: path.join(root, 'gomod'), CARGO_HOME: path.join(root, 'cargo'), UV_CACHE_DIR: path.join(root, 'uv') };
    assert.equal(deps.cacheLookup('npm', '@scope/pkg', { env })?.source, 'cache:npm');
    assert.equal(deps.cacheLookup('npm', 'other', { env }), null);
    fs.mkdirSync(path.join(env.GOMODCACHE, 'cache', 'download', 'github.com', '!burnt!sushi', 'toml', '@v'), { recursive: true });
    fs.writeFileSync(path.join(env.GOMODCACHE, 'cache', 'download', 'github.com', '!burnt!sushi', 'toml', '@v', 'v1.3.2.info'), '{}');
    assert.equal(deps.cacheLookup('go', 'github.com/BurntSushi/toml', { env })?.source, 'cache:go');
    fs.mkdirSync(path.join(env.CARGO_HOME, 'registry', 'index', 'index.crates.io-6f17d22bba15001f', '.cache', 'se', 'rd'), { recursive: true });
    fs.writeFileSync(path.join(env.CARGO_HOME, 'registry', 'index', 'index.crates.io-6f17d22bba15001f', '.cache', 'se', 'rd', 'serde'), 'x');
    assert.equal(deps.cacheLookup('crates', 'serde', { env })?.source, 'cache:cargo');
    fs.mkdirSync(path.join(env.UV_CACHE_DIR, 'simple-v24', 'pypi'), { recursive: true });
    fs.writeFileSync(path.join(env.UV_CACHE_DIR, 'simple-v24', 'pypi', 'python-dateutil.rkyv'), 'x');
    assert.equal(deps.cacheLookup('pypi', 'Python_Dateutil', { env })?.source, 'cache:uv');
  });

  test('imports: bare JS package names and Go import blocks', () => {
    assert.equal(deps.jsPackageOf('@scope/pkg/sub/path'), '@scope/pkg');
    assert.equal(deps.jsPackageOf('lodash/merge'), 'lodash');
    assert.equal(deps.jsPackageOf('node:fs'), null);
    assert.equal(deps.jsPackageOf('fs/promises'), null);
    assert.equal(deps.jsPackageOf('./local'), null);
    assert.deepEqual(deps.goImports('package x\n\nimport (\n\t"fmt"\n\tyaml "gopkg.in/yaml.v3"\n)\nimport "github.com/a/b"\n').map((i) => `${i.path}@${i.line}`), ['fmt@4', 'gopkg.in/yaml.v3@5', 'github.com/a/b@7']);
  });

  test('offline is the default inside the Codex sandbox', () => {
    assert.equal(deps.defaultOffline({ CODEX_SANDBOX: 'seatbelt' }), true);
    assert.equal(deps.defaultOffline({ CODEX_SANDBOX_NETWORK_DISABLED: '1' }), true);
    assert.equal(deps.defaultOffline({ ADC_OFFLINE: '1' }), true);
    assert.equal(deps.defaultOffline({}), false);
  });
});

// ---------------------------------------------------------------------------
// diff-scope helpers

describe('diff-scope helpers', () => {
  test('narrowsCommand detects narrowing, masking and a dropped runner', () => {
    assert.equal(narrowsCommand('jest', 'jest --coverage'), null);
    assert.match(narrowsCommand('jest', 'jest tests/math.test.js'), /restricts/);
    assert.match(narrowsCommand('pytest', 'pytest -k "not slow"'), /-k/);
    assert.match(narrowsCommand('npm test', 'npm test || true'), /\|\|/);
    assert.match(narrowsCommand('go test ./...', 'echo ok'), /no longer invokes/);
    assert.equal(narrowsCommand('pytest -k fast', 'pytest -k fast -q'), null, 'pre-existing flags are not new');
  });

  test('keyPath finds the governing key in JSON/JS, YAML, INI/TOML', () => {
    const js = ['module.exports = {', '  testMatch: [', "    '**/a.test.js',", '  ],', '};'];
    assert.deepEqual(keyPath(js, 2).keys, ['testMatch', 'module.exports']);
    const ini = ['[pytest]', 'testpaths =', '    tests', '    integration'];
    assert.deepEqual(keyPath(ini, 3), { keys: ['testpaths'], section: 'pytest' });
    const yml = ['linters:', '  disable:', '    - errcheck'];
    assert.deepEqual(keyPath(yml, 2).keys, ['disable', 'linters']);
  });

  test('extractSpecPaths keeps paths and globs that exist in the tree', () => {
    const tree = new Set(['src/api/users.ts', 'src/api/orders.ts', 'tests/api.test.ts', 'README.md']);
    const got = extractSpecPaths('Change `src/api/users.ts` and the handlers in src/api/. Add tests under tests/**/*.test.ts. See https://x.example/a/b and v1.2.3. Ignore lib/missing.ts.', tree);
    assert.deepEqual(got.sort(), ['src/api', 'src/api/users.ts', 'tests/**/*.test.ts'].sort());
  });
});

// ---------------------------------------------------------------------------
// Scenarios (plan §13 Diff checks): every planted change fires its check once, in both variants

describe('diff-scope scenarios', () => {
  for (const s of DIFFS.scenarios) {
    for (const variant of ['committed', 'uncommitted']) {
      test(`${s.name} (${variant})`, async () => {
        const dir = prepare(s.ops, variant);
        const before = sh(dir, 'status', '--porcelain');
        const target = await targetFor(dir);
        const res = await diffScope({ target, env: ENV });
        assert.deepEqual(severities(res.findings), sortedExpect(s.expect), JSON.stringify(res.findings.filter((f) => f.severity !== 'info'), null, 1));
        assert.equal(sh(dir, 'status', '--porcelain'), before, 'diff-scope leaves the working tree and index untouched');
        assert.equal(res.checks.length, 11);
        for (const c of res.checks) {
          assert.ok(['pass', 'fail', 'finding'].includes(c.status), `${c.id} ${c.status} ${c.summary}`);
          assert.ok(c.fm.length && c.command && c.summary && /^[0-9a-f]{64}$/.test(c.output_sha256));
        }
        if (s.deps_expect) {
          const d = await deps.depsCheck({ target, offline: true, resolver, tools: false, env: ENV });
          assert.deepEqual(severities(d.findings), sortedExpect(s.deps_expect), JSON.stringify(d.findings, null, 1));
        }
      });
    }
  }
});

describe('evasion matrix (plan §13)', () => {
  for (const e of DIFFS.evasion) {
    for (const variant of ['committed', 'uncommitted']) {
      test(`${e.strategy} (${variant})`, async () => {
        const dir = prepare(e.ops, variant);
        const target = await targetFor(dir);
        const res = await diffScope({ target, env: ENV });
        assert.deepEqual(severities(res.findings), sortedExpect(e.expect), JSON.stringify(res.findings.filter((f) => f.severity !== 'info'), null, 1));
        if (e.deps_expect) {
          const d = await deps.depsCheck({ target, offline: true, resolver, tools: false, env: ENV });
          assert.deepEqual(severities(d.findings), sortedExpect(e.deps_expect), JSON.stringify(d.findings, null, 1));
        }
      });
    }
  }

  test('references/failure-modes.md publishes the same outcome for every strategy', () => {
    const doc = fs.readFileSync(path.join(core.SKILL_DIR, 'references', 'failure-modes.md'), 'utf8');
    for (const e of DIFFS.evasion) {
      const row = doc.split('\n').find((l) => l.startsWith(`| ${e.strategy} |`));
      assert.ok(row, `failure-modes.md has a row for "${e.strategy}"`);
      const cell = row.split('|')[2];
      const checks = [...Object.keys(e.expect), ...Object.keys(e.deps_expect || {})];
      if (!checks.length) assert.match(cell, /not caught/i, row);
      for (const id of new Set(checks)) assert.ok(cell.includes(id), `${e.strategy}: ${id} missing in "${cell}"`);
    }
  });
});

// ---------------------------------------------------------------------------
// Behaviour that needs a custom repository

describe('diff-scope behaviour', () => {
  test('spec paths: files outside the named paths are scope findings; --allow exempts soft findings', async () => {
    const dir = prepare([
      { op: 'edit', path: 'src/math.js', find: 'module.exports', replace: '// tweak\nmodule.exports' },
      { op: 'edit', path: 'src/logger.js', find: "console.error('request failed', err);", replace: "console.warn('request failed', err);" },
    ], 'uncommitted');
    const target = await targetFor(dir);
    const res = await diffScope({ target, env: ENV, specPaths: ['src/math.js'] });
    assert.deepEqual(res.findings.filter((f) => f.id === 'CK-SCOPE').map((f) => f.file), ['src/logger.js']);
    const allowed = await diffScope({ target, env: ENV, specPaths: ['src/math.js'], allow: ['src/logger.js'] });
    assert.deepEqual(severities(allowed.findings), {});
    assert.equal(allowed.counts.allowed, 2);
  });

  test('--allow never exempts failures or secrets', async () => {
    const dir = prepare([
      { op: 'delete', path: 'tests/test_service.py' },
      { op: 'write', path: 'src/aws.js', content: "module.exports = '{{AWS_KEY}}';\n" },
    ], 'uncommitted');
    const res = await diffScope({ target: await targetFor(dir), env: ENV, allow: ['**'] });
    assert.deepEqual(severities(res.findings), { 'CK-TEST-DEL': ['fail'], 'CK-SECRETS': ['fail'] });
  });

  test('the ci-gate header downgrades CK-CI failures to findings only when the base had it', async () => {
    const dir = initRepo({ ...DIFFS.base, '.github/workflows/gate.yml': '# generated by agentic-developer-companion ci-gate\nname: gate\non: pull_request\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n' });
    fs.writeFileSync(path.join(dir, '.github/workflows/gate.yml'), fs.readFileSync(path.join(dir, '.github/workflows/gate.yml'), 'utf8').replace('      - run: npm test\n', '      - run: npm test\n        continue-on-error: true\n'));
    const res = await diffScope({ target: await targetFor(dir), env: ENV });
    assert.deepEqual(severities(res.findings), { 'CK-CI': ['finding'] });
  });

  test('untracked files are part of the snapshot; .adc and ignored files are not', async () => {
    const dir = prepare([{ op: 'write', path: 'tests/test_new.py', content: 'import pytest\n\n@pytest.mark.skip\ndef test_x():\n    assert 1 + 1 == 2\n' }], 'uncommitted');
    fs.writeFileSync(path.join(dir, '.gitignore'), 'ignored/\n');
    fs.mkdirSync(path.join(dir, 'ignored'));
    fs.writeFileSync(path.join(dir, 'ignored', 'x.test.js'), "it.only('x', () => {});\n");
    fs.mkdirSync(path.join(dir, '.adc'));
    fs.writeFileSync(path.join(dir, '.adc', 'notes.test.js'), "it.only('x', () => {});\n");
    const res = await diffScope({ target: await targetFor(dir), env: ENV });
    assert.deepEqual(res.files.map((f) => f.path).sort(), ['.gitignore', 'tests/test_new.py']);
    assert.deepEqual(severities(res.findings), { 'CK-SKIP': ['fail'] });
  });

  test('the live token value is redacted from evidence and flagged wherever it appears', async () => {
    const token = ['hunter2', 'abcLive'].join('');
    const dir = prepare([{ op: 'write', path: 'src/client.js', content: `const t = '${token}';\nmodule.exports = t;\n` }], 'uncommitted');
    const res = await diffScope({ target: await targetFor(dir), env: { ...ENV, ADC_LIVE_TOKEN: token } });
    const json = JSON.stringify(res);
    assert.ok(!json.includes(token), 'token value never appears in the result');
    assert.deepEqual(severities(res.findings), { 'CK-SECRETS': ['fail'] });
    assert.equal(res.findings.find((f) => f.id === 'CK-SECRETS').rule, 'secret.adc-live-token-value');
  });

  test('unborn repository: everything is new and diffs against the empty tree', async () => {
    const dir = fs.mkdtempSync(path.join(TMP, 'unborn-'));
    sh(dir, 'init', '-q', '-b', 'main');
    writeFiles(dir, { 'tests/a.test.js': "it.only('x', () => { expect(1).toBe(1); });\n", 'src/a.js': 'module.exports = 1;\n' });
    const res = await diffScope({ target: await targetFor(dir), env: ENV });
    assert.equal(res.base.sha, null);
    assert.deepEqual(severities(res.findings), { 'CK-SKIP': ['fail'], 'CK-ASSERT': ['finding'] });
  });

  test('CRLF files: markers and counts work the same', async () => {
    const dir = initRepo({ 'tests/test_crlf.py': 'def test_a():\r\n    assert 1 == 1\r\n\r\n\r\ndef test_b():\r\n    assert 2 == 2\r\n' });
    fs.writeFileSync(path.join(dir, 'tests/test_crlf.py'), 'def test_a():\r\n    assert 1 == 1\r\n');
    const res = await diffScope({ target: await targetFor(dir), env: ENV });
    assert.deepEqual(severities(res.findings), { 'CK-TEST-DEL': ['fail'] });
  });

  test('a step that throws makes only that check unverified', async () => {
    const dir = prepare([{ op: 'edit', path: 'tests/math.test.js', find: "  it('adds', () => {", replace: "  it.only('adds', () => {" }], 'uncommitted');
    const target = await targetFor(dir);
    const broken = { ...target, snapshot: { ...target.snapshot } };
    // An env object whose ADC_SECRETS_SCANNER getter throws breaks only the secrets step.
    const env = { ...ENV };
    Object.defineProperty(env, 'ADC_SECRETS_SCANNER', { get() { throw new Error('boom'); }, enumerable: true });
    const res = await diffScope({ target: broken, env });
    const byId = Object.fromEntries(res.checks.map((c) => [c.id, c]));
    assert.equal(byId['CK-SECRETS'].status, 'unverified');
    assert.equal(byId['CK-SKIP'].status, 'fail');
  });
});

// ---------------------------------------------------------------------------
// deps-check with the package managers' own lock checks (only where the tool is installed)

describe('deps-check lock tools', () => {
  const npmProject = (inSync) => {
    const files = {
      'package.json': JSON.stringify({ name: 'p', version: '1.0.0', dependencies: { localdep: 'file:./localdep' } }, null, 2) + '\n',
      'localdep/package.json': JSON.stringify({ name: 'localdep', version: '1.0.0' }) + '\n',
      'package-lock.json': JSON.stringify({ name: 'p', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'p', version: '1.0.0' } } }, null, 2) + '\n',
    };
    if (inSync) {
      files['package-lock.json'] = JSON.stringify({ name: 'p', version: '1.0.0', lockfileVersion: 3, requires: true, packages: {
        '': { name: 'p', version: '1.0.0', dependencies: { localdep: 'file:./localdep' } },
        'node_modules/localdep': { resolved: 'localdep', link: true },
        localdep: { version: '1.0.0' },
      } }, null, 2) + '\n';
    }
    return files;
  };

  test('npm ci --dry-run classifies an out-of-sync lockfile', { skip: !core.which('npm') && 'npm not installed' }, () => {
    for (const inSync of [true, false]) {
      const dir = fs.mkdtempSync(path.join(TMP, 'npm-'));
      writeFiles(dir, npmProject(inSync));
      const r = deps.runLockTool('npm', dir, { offline: true, env: ENV });
      assert.equal(r.status, inSync ? 'consistent' : 'inconsistent', `${inSync}: ${r.detail}`);
    }
  });

  test('go mod tidy -diff classifies an untidy go.mod', { skip: !core.which('go') && 'go not installed' }, () => {
    const dir = fs.mkdtempSync(path.join(TMP, 'go-'));
    writeFiles(dir, { 'go.mod': 'module example.com/m\n\ngo 1.21\n', 'a.go': 'package m\n' });
    assert.equal(deps.runLockTool('go', dir, { offline: true, env: ENV }).status, 'consistent');
    fs.writeFileSync(path.join(dir, 'go.mod'), 'module example.com/m\n\ngo 1.21\n\nrequire golang.org/x/text v0.3.0\n');
    const r = deps.runLockTool('go', dir, { offline: true, env: ENV });
    assert.equal(r.status, 'inconsistent', r.detail);
  });

  test('cargo metadata --locked classifies a stale Cargo.lock', { skip: !core.which('cargo') && 'cargo not installed' }, () => {
    const dir = fs.mkdtempSync(path.join(TMP, 'cargo-'));
    writeFiles(dir, {
      'Cargo.toml': '[package]\nname = "m"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\n',
      'src/lib.rs': '',
      'Cargo.lock': '# This file is automatically @generated by Cargo.\n# It is not intended for manual editing.\nversion = 4\n\n[[package]]\nname = "m"\nversion = "0.1.0"\n',
      'sub/Cargo.toml': '[package]\nname = "sub"\nversion = "0.1.0"\nedition = "2021"\n', 'sub/src/lib.rs': '',
    });
    assert.equal(deps.runLockTool('cargo', dir, { offline: true, env: ENV }).status, 'consistent');
    fs.writeFileSync(path.join(dir, 'Cargo.toml'), '[package]\nname = "m"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\nsub = { path = "sub" }\n');
    const r = deps.runLockTool('cargo', dir, { offline: true, env: ENV });
    assert.equal(r.status, 'inconsistent', r.detail);
  });

  test('uv lock --check classifies a stale uv.lock', { skip: !core.which('uv') && 'uv not installed' }, () => {
    const dir = fs.mkdtempSync(path.join(TMP, 'uv-'));
    writeFiles(dir, { 'pyproject.toml': '[project]\nname = "m"\nversion = "0.1.0"\nrequires-python = ">=3.8"\ndependencies = []\n' });
    const lock = core.run('uv', ['lock', '--offline'], { cwd: dir, env: ENV });
    if (lock.exit !== 0) return; // no usable interpreter here; nothing to compare against
    assert.equal(deps.runLockTool('uv', dir, { offline: true, env: ENV }).status, 'consistent');
    writeFiles(dir, { 'lib/pyproject.toml': '[project]\nname = "lib"\nversion = "0.1.0"\n[build-system]\nrequires = ["hatchling"]\nbuild-backend = "hatchling.build"\n' });
    fs.writeFileSync(path.join(dir, 'pyproject.toml'), '[project]\nname = "m"\nversion = "0.2.0"\nrequires-python = ">=3.8"\ndependencies = []\n');
    const r = deps.runLockTool('uv', dir, { offline: true, env: ENV });
    assert.equal(r.status, 'inconsistent', r.detail);
  });

  test('depsCheck runs the tool in a temp worktree and leaves nothing behind', { skip: !core.which('npm') && 'npm not installed' }, async () => {
    const dir = initRepo(npmProject(true));
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    pkg.dependencies.other = 'file:./other';
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
    writeFiles(dir, { 'other/package.json': JSON.stringify({ name: 'other', version: '1.0.0' }) + '\n' });
    const before = sh(dir, 'status', '--porcelain');
    const res = await deps.depsCheck({ target: await targetFor(dir), offline: true, tools: true, env: ENV });
    assert.equal(res.lock_status.status, 'inconsistent');
    assert.equal(res.lock_status.lockfiles[0].tool.status, 'inconsistent');
    assert.equal(res.checks.find((c) => c.id === 'CK-LOCK').status, 'fail');
    assert.equal(sh(dir, 'status', '--porcelain'), before);
    assert.equal(sh(dir, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length, 1, 'temp worktree removed');
  });

  test('offline with an unknown package: CK-DEPS is unverified, never pass', async () => {
    const dir = prepare([{ op: 'write', path: 'requirements.txt', content: 'adc-unknown-offline-pkg==1.0\n' }], 'uncommitted');
    const res = await deps.depsCheck({ target: await targetFor(dir), offline: true, tools: false, env: ENV });
    const c = res.checks.find((x) => x.id === 'CK-DEPS');
    assert.equal(c.status, 'unverified');
    assert.equal(c.reason, 'OFFLINE');
    assert.equal(res.new_deps[0].exists, null);
  });
});

// ---------------------------------------------------------------------------
// End to end through adc.mjs

describe('adc.mjs end to end', () => {
  const runAdc = (args, dir, env = {}) => {
    const r = spawnSync(process.execPath, [ADC, ...args, '--json', '--cwd', dir], {
      encoding: 'utf8', env: { ...ENV, ADC_HOME: path.join(TMP, `home-${path.basename(dir)}`), ...env },
    });
    let json = null;
    try { json = JSON.parse(r.stdout); } catch { /* asserted below */ }
    return { ...r, json };
  };

  test('diff-scope exits 1 with findings, 0 when clean; stdout is one ASCII JSON document', () => {
    const bad = prepare(DIFFS.scenarios.find((s) => s.name === 'it.only').ops, 'uncommitted');
    const r = runAdc(['diff-scope'], bad);
    assert.equal(r.status, 1, r.stderr);
    assert.ok(/^[\x00-\x7e]*$/.test(r.stdout));
    assert.deepEqual(severities(r.json.findings), { 'CK-SKIP': ['fail'] });
    assert.match(r.stderr, /diff-scope: 1 fail/);
    const clean = prepare(DIFFS.scenarios.find((s) => s.name === 'clean').ops, 'committed');
    const c = runAdc(['diff-scope', '--base', 'main'], clean);
    assert.equal(c.status, 0, c.stdout);
    assert.equal(c.json.base.source, 'flag');
    assert.equal(c.json.checks.length, 11);
  });

  test('diff-scope --spec and --allow', () => {
    const dir = prepare([{ op: 'edit', path: 'src/logger.js', find: "console.error('request failed', err);", replace: "console.warn('request failed', err);" }], 'uncommitted');
    const spec = path.join(TMP, `spec-${path.basename(dir)}.md`);
    fs.writeFileSync(spec, '# Task\n\n1. Change `src/math.js` only.\n');
    const r = runAdc(['diff-scope', '--spec', spec], dir);
    assert.equal(r.status, 1);
    assert.deepEqual(r.json.spec_paths, ['src/math.js']);
    assert.ok(r.json.findings.some((f) => f.id === 'CK-SCOPE' && f.file === 'src/logger.js'));
    const a = runAdc(['diff-scope', '--spec', spec, '--allow', 'src/logger.js'], dir);
    assert.equal(a.status, 0, a.stdout);
    const missing = runAdc(['diff-scope', '--spec', path.join(TMP, 'nope.md')], dir);
    assert.equal(missing.status, 2);
  });

  test('deps-check --offline --static-only', () => {
    const dir = prepare(DIFFS.scenarios.find((s) => s.name === 'fake dependency').ops, 'committed');
    const r = runAdc(['deps-check', '--offline', '--static-only'], dir);
    assert.equal(r.status, 1, r.stderr);
    assert.equal(r.json.offline, true);
    assert.equal(r.json.new_deps[0].name, 'adc-nonexistent-pkg-zz9');
    assert.equal(r.json.new_deps[0].exists, null);
    assert.equal(r.json.lock_status.status, 'inconsistent');
    const codex = runAdc(['deps-check', '--static-only'], dir, { CODEX_SANDBOX: 'seatbelt' });
    assert.equal(codex.json.offline, true, 'offline is the default under Codex');
  });

  test('--help prints usage and exits 0; unknown options exit 2', () => {
    const dir = scenarioRepo();
    assert.equal(runAdc(['diff-scope', '--help'], dir).status, 0);
    assert.equal(runAdc(['deps-check', '--bogus'], dir).status, 2);
  });

  test('default state dir inside the repository (.adc/ in info/exclude)', { skip: snapshotIgnoredBug() && 'git.mjs createSnapshot exits 4 when .adc/ is already ignored (foundation change requested)' }, () => {
    const dir = prepare(DIFFS.scenarios.find((s) => s.name === 'it.only').ops, 'uncommitted');
    const r = spawnSync(process.execPath, [ADC, 'diff-scope', '--json', '--cwd', dir], { encoding: 'utf8', env: ENV });
    assert.equal(r.status, 1, r.stderr);
    assert.ok(fs.existsSync(path.join(dir, '.adc')));
    assert.ok(!JSON.parse(r.stdout).files.some((f) => f.path.startsWith('.adc/')));
  });
});

/** True while git.mjs passes an exclude pathspec for an already-ignored .adc/ (git add then exits 1). */
function snapshotIgnoredBug() {
  const dir = fs.mkdtempSync(path.join(TMP, 'probe-'));
  sh(dir, 'init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(dir, '.adc'));
  fs.writeFileSync(path.join(dir, '.adc', 'x'), 'x');
  fs.appendFileSync(path.join(dir, '.git', 'info', 'exclude'), '/.adc/\n');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  try {
    git.createSnapshot(dir, { exclude: ['.adc'] });
    return false;
  } catch {
    return true;
  }
}
