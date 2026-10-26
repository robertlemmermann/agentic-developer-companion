// Unit and scenario tests for scripts/lib/markers.mjs, diff-scope.mjs and deps.mjs.
// Scenarios come from tests/fixtures (section "diffs") and run in temp git repos, both
// committed on a feature branch and uncommitted/untracked on main.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as core from '../../skills/agentic-developer-companion/scripts/lib/core.mjs';
import * as git from '../../skills/agentic-developer-companion/scripts/lib/git.mjs';
import * as state from '../../skills/agentic-developer-companion/scripts/lib/state.mjs';
import * as M from '../../skills/agentic-developer-companion/scripts/lib/markers.mjs';
import { diffScope, extractSpecPaths, narrowsCommand, keyPath, ciCommand, ciBlock, workflowEvents } from '../../skills/agentic-developer-companion/scripts/lib/diff-scope.mjs';
import * as deps from '../../skills/agentic-developer-companion/scripts/lib/deps.mjs';
import { parseToml } from '../../skills/agentic-developer-companion/scripts/lib/formats.mjs';
import { AWS_KEY, fixtureJson, git as gitCli, makeRepo, runAdc as adcRun, tmpDir, writeFile, writeFiles as writeTree } from './helpers.mjs';

const TMP = tmpDir('adc-diffscope-');
// Secrets are assembled at runtime so no secret-shaped literal exists in the repository.
const GH_TOKEN = ['ghp', '_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'].join('');
const PRIVATE_KEY_HEADER = ['-----BEGIN', ' RSA PRIVATE', ' KEY-----'].join('');
const PLACEHOLDERS = { '{{AWS_KEY}}': AWS_KEY, '{{GH}}': GH_TOKEN, '{{PK}}': PRIVATE_KEY_HEADER };
const fill = (s) => Object.entries(PLACEHOLDERS).reduce((t, [k, v]) => t.split(k).join(v), s);
// Hermetic environment: built-in scanner, no live token, an empty npm cache, no network lookups.
const NPM_CACHE = path.join(TMP, 'npm-cache');
const ENV = { ...process.env, ADC_SECRETS_SCANNER: 'builtin', npm_config_cache: NPM_CACHE, UV_CACHE_DIR: path.join(TMP, 'uv-cache'),
  GOMODCACHE: path.join(TMP, 'gomodcache'), CARGO_HOME: path.join(TMP, 'cargo-home') };
delete ENV.ADC_LIVE_TOKEN;
delete ENV.ADC_HOME;

let seq = 0;
const writeFiles = (dir, files) => writeTree(dir, files, fill);
const initRepo = (files) => makeRepo(files, { dir: fs.mkdtempSync(path.join(TMP, 'repo-')), message: 'base', config: { 'core.autocrlf': 'false' }, transform: fill }).dir;

const DIFFS = fixtureJson('diffs');
const templates = new Map();
/** A fresh copy of the base repository (plus a scenario's own `base` files, if any). */
function scenarioRepo(extraBase = null) {
  const key = extraBase ? JSON.stringify(extraBase) : '';
  if (!templates.has(key)) templates.set(key, initRepo({ ...DIFFS.base, ...(extraBase || {}) }));
  const dir = path.join(TMP, `s${++seq}`);
  fs.cpSync(templates.get(key), dir, { recursive: true });
  return dir;
}
function applyOps(dir, ops) {
  for (const op of ops) {
    const p = (rel) => path.join(dir, rel);
    if (op.op === 'write') writeFile(dir, op.path, fill(op.content));
    else if (op.op === 'delete') fs.rmSync(p(op.path));
    else if (op.op === 'rename') { fs.mkdirSync(path.dirname(p(op.to)), { recursive: true }); fs.renameSync(p(op.from), p(op.to)); }
    else if (op.op === 'edit') {
      const text = fs.readFileSync(p(op.path), 'utf8');
      assert.ok(text.includes(op.find), `fixture edit: "${op.find.slice(0, 40)}" not found in ${op.path}`);
      fs.writeFileSync(p(op.path), text.replace(op.find, fill(op.replace)));
    } else throw new Error(`unknown op ${op.op}`);
  }
}
/** committed: on a feature branch; uncommitted: working tree + untracked files; staged: in the index only. */
function prepare(ops, variant, extraBase = null) {
  const dir = scenarioRepo(extraBase);
  if (variant === 'committed') gitCli(dir, 'checkout', '-q', '-b', 'feature');
  applyOps(dir, ops);
  if (variant === 'committed') { gitCli(dir, 'add', '-A'); gitCli(dir, 'commit', '-q', '-m', 'change'); }
  if (variant === 'staged') gitCli(dir, 'add', '-A');
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
const resolverFor = (registry = DIFFS.registry) => (eco, name) => (name in registry ? registry[name] : null);
const resolver = resolverFor();

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

  test('broad handlers fire only when they neither re-raise nor report the error', () => {
    const ids = (lines, file) => M.scanText(lines, M.SWALLOW_PATTERNS, { file }).map((h) => `${h.id}@${h.line}`);
    assert.deepEqual(ids(['except Exception:', '    return None'], 'a.py'), ['swallow.py-broad-except@1']);
    assert.deepEqual(ids(['except Exception as exc:', '    log.warning(exc)', '    return None'], 'a.py'), ['swallow.py-broad-except@1']);
    assert.deepEqual(ids(['except Exception:', '    logger.exception("x")'], 'a.py'), []);
    assert.deepEqual(ids(['except Exception:', '    raise'], 'a.py'), []);
    assert.deepEqual(ids(['except Exception:', '    pass'], 'a.py'), ['swallow.py-except-pass@1'], 'pass-only bodies belong to the empty-handler rule');
    assert.deepEqual(ids(['except KeyError:', '    return 0'], 'a.py'), []);
    assert.deepEqual(ids(['} catch (Exception e) {', '  return null;', '}'], 'A.java'), ['swallow.broad-catch@1']);
    assert.deepEqual(ids(['} catch (Exception e) {', '  throw new IllegalStateException(e);', '}'], 'A.java'), []);
    assert.deepEqual(ids(['} catch (IOException e) {', '  return null;', '}'], 'A.java'), []);
    assert.deepEqual(ids(['catch (Exception ex)', '{'], 'A.cs'), [], 'the brace must open on the handler line');
    assert.deepEqual(ids(['catch {', '  return default;', '}'], 'A.cs'), ['swallow.broad-catch@1']);
    assert.deepEqual(ids(['\tif err := os.Remove(p); err != nil {', '\t}'], 'a.go'), ['swallow.go-empty-err@1']);
  });

  test('tryWrappedAssertions: try blocks around assertions whose handler swallows the failure', () => {
    const hits = (text, file) => M.tryWrappedAssertions(text.split('\n'), file).map((h) => h.line);
    assert.deepEqual(hits('def test_a():\n    try:\n        assert f() == 1\n    except AssertionError:\n        pass\n', 'test_a.py'), [4]);
    assert.deepEqual(hits('def test_a():\n    try:\n        assert f() == 1\n    except Exception as e:\n        print(e)\n', 'test_a.py'), [4]);
    assert.deepEqual(hits('def test_a():\n    try:\n        assert f() == 1\n    except ValueError:\n        pass\n', 'test_a.py'), [], 'ValueError does not catch AssertionError');
    assert.deepEqual(hits('def test_a():\n    try:\n        assert f() == 1\n    except Exception:\n        pytest.fail("boom")\n', 'test_a.py'), []);
    assert.deepEqual(hits('def test_a():\n    try:\n        x = f()\n    except Exception:\n        x = None\n    assert x\n', 'test_a.py'), [], 'no assertion inside the try');
    assert.deepEqual(hits("it('x', () => {\n  try {\n    expect(f()).toBe(1);\n  } catch (e) {\n    console.log(e);\n  }\n});", 'a.test.js'), [4]);
    assert.deepEqual(hits("it('x', () => {\n  try {\n    expect(f()).toBe(1);\n  } catch (e) {\n    throw e;\n  }\n});", 'a.test.js'), []);
    assert.deepEqual(hits("it('x', () => {\n  try { expect(f()).toBe(1); } catch {}\n});", 'a.test.js'), [2]);
    assert.deepEqual(hits('@Test void a() {\n  try {\n    assertEquals(1, f());\n  } catch (Exception e) {\n  }\n}', 'ATest.java'), [], 'JUnit assertions are Errors, not Exceptions');
    assert.deepEqual(hits('@Test void a() {\n  try {\n    assertEquals(1, f());\n  } catch (Throwable t) {\n  }\n}', 'ATest.java'), [4]);
    assert.deepEqual(hits('[Fact] public void A() {\n  try {\n    Assert.Equal(1, F());\n  }\n  catch (Exception) { }\n}', 'ATests.cs'), [5]);
  });

  test('rustTestRanges finds inline #[cfg(test)] modules', () => {
    const lines = ['pub fn a() -> i32 {', '    1', '}', '', '#[cfg(test)]', 'mod tests {', '    use super::*;', '    #[test]', '    fn t() { assert_eq!(a(), 1); }', '}', '', 'pub fn b() {}'];
    assert.deepEqual(M.rustTestRanges(lines), [[5, 10]]);
    assert.deepEqual(M.rustTestRanges(['#[cfg(test)]', 'mod tests;']), []);
  });

  test('markers inside string literals are not markers (JS)', () => {
    const hit = (line) => M.scanText([line], M.SKIP_MARKERS, { file: 'a.test.js' }).map((h) => h.id);
    assert.deepEqual(hit('const src = "it.only(\'x\', () => {})";'), []);
    assert.deepEqual(hit("it.only('it.skip in a title', () => {})"), ['skip.js-only']);
    assert.deepEqual(hit("describe['skip']('x', () => {})"), ['skip.js-bracket'], 'bracket access keeps its string');
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
      `url = "postgres://app:${['s3cr', 'etValue9'].join('')}@db.internal.acme-corp.io:5432/app"`,
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
    for (const host of ['api.example.test', 'db.example.com', 'x.invalid', 'svc.localhost:8080']) {
      assert.equal(M.scanSecrets(`u = "https://bob:${['s3cr', 'etValue9'].join('')}@${host}/v1"`).length, 0, `reserved name ${host}`);
    }
    assert.equal(M.credentialFileName('config/.env.production'), 'dotenv');
    assert.equal(M.credentialFileName('.env.example'), null);
    assert.equal(M.credentialFileName('keys/id_ed25519'), 'ssh-key');
  });

  test('gitleaks finds nothing in the skill tree', { skip: !core.which('gitleaks') && 'gitleaks not installed' }, () => {
    const r = core.run('gitleaks', ['detect', '--no-git', '--source', core.SKILL_DIR, '--redact', '--no-banner', '--exit-code', '1']);
    assert.equal(r.exit, 0, r.stdout + r.stderr);
  });

  test('the skill tree itself contains no secret-shaped strings', (t) => {
    const files = core.listFiles(core.SKILL_DIR).filter((f) => !/\.(?:png|jpg|gif|ico)$/.test(f));
    // Hard-fail on everything that ships plus this work package's own tests and fixtures; other
    // work packages' test files are reported (selftest's footprint area enforces them).
    const own = (f) => !f.startsWith('tests/') || f === 'tests/unit/diff-scope.test.mjs' || f === 'tests/fixtures/diffs.json';
    const hits = [];
    const elsewhere = [];
    for (const f of files) {
      const text = core.readText(path.join(core.SKILL_DIR, f)) || '';
      for (const h of M.scanSecrets(text)) if (h.severity === 'fail') (own(f) ? hits : elsewhere).push(`${f}:${h.line} ${h.id}`);
    }
    if (elsewhere.length) t.diagnostic(`secret-shaped literals in other test files (build them from parts): ${elsewhere.join(', ')}`);
    assert.deepEqual(hits, []);
  });

  test('secrets inside very long lines (minified bundles, one-line JSON) are found and masked', () => {
    const line = `${'x'.repeat(30_000)} const k = '${AWS_KEY}'; ${'y'.repeat(30_000)}`;
    assert.deepEqual(M.scanSecrets(line).map((h) => h.id), ['secret.aws-access-key-id']);
    assert.ok(!M.redactSecrets(line).includes(AWS_KEY));
  });

  test('redactSecrets masks every detected value in place and leaves other text alone', () => {
    const text = `run: jest --token=${GH_TOKEN}\nplain line\r\nkey ${AWS_KEY} and ${GH_TOKEN}`;
    const out = M.redactSecrets(text);
    assert.ok(!out.includes(GH_TOKEN) && !out.includes(AWS_KEY), out);
    assert.match(out, /^run: jest --token=ghp_\.\.\.\[REDACTED\]\nplain line\r\nkey /);
    assert.equal(M.redactSecrets('nothing to see'), 'nothing to see');
    assert.equal(M.redactSecrets(null), null);
  });

  test('blank modes: index literals survive, back-references compare the real values', () => {
    const skip = (line) => M.scanText([line], M.SKIP_MARKERS, { file: 'a.test.js' }).map((h) => h.id);
    assert.deepEqual(skip("assert(hit(\"describe['skip']('x', () => {})\"));"), [], 'bracket marker inside a string literal');
    const taut = (line) => M.scanText([line], M.TAUTOLOGIES, { file: 'a.test.js' }).map((h) => h.id);
    assert.deepEqual(taut("expect('a').toBe('a');"), ['tautology.js']);
    assert.deepEqual(taut("expect('ab').toBe('cd');"), [], 'blanked literals look equal; the real ones are not');
    assert.deepEqual(taut("nodeTest('x', 'assert.ok(true);')"), [], 'a tautology inside a string is test data');
    const hit = M.scanText(["  it.skip('later', () => { expect(f()).toBe(1); });"], M.SKIP_MARKERS, { file: 'a.test.js' })[0];
    assert.equal(hit.match, 'it.skip', 'hits carry the marker itself');
  });

  test('go build constraints in test files are a softer kind of skip', () => {
    const kinds = (line) => M.scanText([line], M.SKIP_MARKERS, { file: 'a_test.go' }).map((h) => `${h.id}:${h.kind}`);
    assert.deepEqual(kinds('//go:build integration'), ['skip.go-build-tag:constraint']);
    assert.deepEqual(kinds('// +build linux'), ['skip.go-build-tag:constraint']);
    assert.deepEqual(kinds('//go:build ignore'), ['skip.go-build-ignore:skip']);
  });

  test('ADC_LIVE_TOKEN: quoted values and unquoted line-final values count; code identifiers do not', () => {
    const ids = (line) => M.scanSecrets(line).map((h) => h.id);
    const v = ['abcd', 'efgh', '1234'].join('-');
    assert.deepEqual(ids(`ADC_LIVE_TOKEN=${v}`), ['secret.adc-live-token']);
    assert.deepEqual(ids(`export ADC_LIVE_TOKEN="${v}"  # set by hand`), ['secret.adc-live-token']);
    assert.deepEqual(ids(`  ADC_LIVE_TOKEN: ${v}`), ['secret.adc-live-token']);
    assert.deepEqual(ids(`env: { ADC_LIVE_TOKEN: '${v}' },`), ['secret.adc-live-token']);
    assert.deepEqual(ids('env: { ...ENV, ADC_LIVE_TOKEN: envToken },'), []);
    assert.deepEqual(ids('ADC_LIVE_TOKEN: ${{ secrets.ADC_LIVE_TOKEN }}'), []);
    assert.deepEqual(ids('const t = { ADC_LIVE_TOKEN: process.env.ADC_LIVE_TOKEN };'), []);
    assert.ok(!M.scanSecrets(`ADC_LIVE_TOKEN=${v}`)[0].redacted.includes(v));
  });
});

// ---------------------------------------------------------------------------
// deps.mjs (pure parts)

describe('deps parsing', () => {
  test('lenient TOML (manifests, lockfiles): tables, arrays of tables, inline tables, multi-line arrays', () => {
    const t = parseToml('a = 1\n[project]\nname = "x" # c\ndependencies = [\n  "requests>=2",\n  \'six\',\n]\n[tool.uv.sources]\nlib = { path = "../lib" }\n[[package]]\nname = "p1"\n[[package]]\nname = "p2"\n[package.source]\nregistry = "r"\nbad line here\nz = true\n', { lenient: true }).value;
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

  test('goSumNeeded ignores modules replaced by local directories', () => {
    const gomod = deps.parseManifest('go.mod', 'module m\n\nrequire (\n\tgithub.com/a/b v1.0.0\n\tgithub.com/c/d v1.0.0\n)\nreplace github.com/c/d => ../d\n');
    assert.deepEqual(deps.goSumNeeded(gomod).map((d) => d.name), ['github.com/a/b']);
    assert.deepEqual(deps.goSumNeeded(deps.parseManifest('package.json', '{}')), []);
  });

  test('blobReader: one batch for many blobs, same answers as git show (text, binary, missing, oversized)', () => {
    const files = { 'a.txt': 'alpha\r\n', 'b.bin': 'x\u0000y', 'big.txt': 'z'.repeat(100), 'sub/c.js': 'c\n' };
    const dir = initRepo(files);
    const head = gitCli(dir, 'rev-parse', 'HEAD').trim();
    const names = [...Object.keys(files), 'nope.txt'];
    const batched = git.blobReader(dir, { maxBytes: 50 });
    batched.prefetch(names.map((f) => [head, f]));
    // Without the repository, only what the batch loaded can still be read.
    fs.renameSync(path.join(dir, '.git'), path.join(dir, '.git-away'));
    assert.equal(batched.read(head, 'a.txt'), 'alpha\r\n');
    assert.equal(batched.read(head, 'sub/c.js'), 'c\n');
    fs.renameSync(path.join(dir, '.git-away'), path.join(dir, '.git'));
    const single = git.blobReader(dir, { maxBytes: 50 });
    for (const f of names) assert.equal(batched.read(head, f), single.read(head, f), f);
    assert.deepEqual(['b.bin', 'big.txt', 'nope.txt'].map((f) => single.read(head, f)), [null, null, null]);
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

  test('ciCommand strips YAML step syntax so moved commands compare equal', () => {
    assert.equal(ciCommand('      - run: npm test -- --ci'), 'npm test -- --ci');
    assert.equal(ciCommand('  script: pytest -q'), 'pytest -q');
    assert.equal(ciCommand('        run: |'), '');
    assert.equal(ciCommand('          python -m pytest'), 'python -m pytest');
  });

  test('keyPath finds the governing key in JSON/JS, YAML, INI/TOML', () => {
    const js = ['module.exports = {', '  testMatch: [', "    '**/a.test.js',", '  ],', '};'];
    assert.deepEqual(keyPath(js, 2).keys, ['testMatch', 'module.exports']);
    const ini = ['[pytest]', 'testpaths =', '    tests', '    integration'];
    assert.deepEqual(keyPath(ini, 3), { keys: ['testpaths'], section: 'pytest' });
    const yml = ['linters:', '  disable:', '    - errcheck'];
    assert.deepEqual(keyPath(yml, 2).keys, ['disable', 'linters']);
  });

  test('ciBlock scopes a line to its step or job; workflowEvents reads every on: form', () => {
    const wf = ['on: [push, pull_request]', 'jobs:', '  t:', '    continue-on-error: true', '    steps:', '      - run: docker rm db || true', '      - run: |', '          npm ci', '          npm test || true', '      - uses: codecov/codecov-action@v4', '        continue-on-error: true'];
    assert.equal(ciBlock(wf, 5), '      - run: docker rm db || true');
    assert.match(ciBlock(wf, 8), /- run: \|\n\s+npm ci\n\s+npm test \|\| true$/);
    assert.match(ciBlock(wf, 10), /codecov-action@v4\n\s+continue-on-error: true$/);
    assert.match(ciBlock(wf, 3), /^  t:[\s\S]*npm test/, 'a job-level key belongs to the whole job');
    assert.deepEqual([...workflowEvents(wf)], ['push', 'pull_request']);
    assert.deepEqual([...workflowEvents(['on:', '  pull_request:', '    branches: [main]', '  push:', 'jobs:'])], ['pull_request', 'push']);
    assert.deepEqual([...workflowEvents(['"on": workflow_dispatch'])], ['workflow_dispatch']);
    assert.deepEqual([...workflowEvents(['on: { push: { branches: [main] } }'])].includes('push'), true);
    assert.equal(workflowEvents(['name: x']), null);
  });

  test('extractSpecPaths keeps paths and globs that exist in the tree', () => {
    const tree = new Set(['src/api/users.ts', 'src/api/orders.ts', 'tests/api.test.ts', 'README.md']);
    const got = extractSpecPaths('Change `src/api/users.ts` and the handlers in src/api/. Add tests under tests/**/*.test.ts. See https://x.example/a/b and v1.2.3. Ignore lib/missing.ts.', tree);
    assert.deepEqual(got.sort(), ['src/api', 'src/api/users.ts', 'tests/**/*.test.ts'].sort());
    assert.deepEqual(extractSpecPaths('Edit src\\api\\orders.ts only.', tree), ['src/api/orders.ts'], 'Windows-style paths');
  });
});

// ---------------------------------------------------------------------------
// Scenarios (plan §13 Diff checks): every planted change fires its check once, in both variants

describe('diff-scope scenarios', () => {
  for (const s of DIFFS.scenarios) {
    for (const variant of ['committed', 'uncommitted']) {
      test(`${s.name} (${variant})`, async () => {
        const dir = prepare(s.ops, variant);
        const before = gitCli(dir, 'status', '--porcelain');
        const target = await targetFor(dir);
        const res = await diffScope({ target, env: ENV });
        assert.deepEqual(severities(res.findings), sortedExpect(s.expect), JSON.stringify(res.findings.filter((f) => f.severity !== 'info'), null, 1));
        assert.equal(gitCli(dir, 'status', '--porcelain'), before, 'diff-scope leaves the working tree and index untouched');
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
      const [, , scripted, cleanRun, deep] = row.split('|').map((c) => c.trim());
      const outcomes = [...Object.entries(e.expect), ...Object.entries(e.deps_expect || {})];
      if (!outcomes.length) assert.match(scripted, /^not caught$/i, row);
      for (const [id, sev] of outcomes) {
        const published = `${id} ${[...new Set(sev)].join('/')}`;
        assert.ok(scripted.includes(published), `${e.strategy}: "${published}" missing in "${scripted}"`);
      }
      if (e.deps_expect) assert.match(scripted, /deps-check/, row);
      assert.equal(cleanRun, e.clean_run, row);
      assert.equal(deep, e.deep, row);
    }
  });
});

// Per-ecosystem catalog coverage and false-positive guards: one run each, rotating the variants.
const ROTATION = ['uncommitted', 'committed', 'staged'];
for (const [section, title] of [['ecosystems', 'per-ecosystem coverage'], ['benign', 'false-positive guards (ordinary changes stay quiet)']]) {
  describe(`diff-scope ${title}`, () => {
    (DIFFS[section] || []).forEach((s, i) => {
      const variant = ROTATION[i % ROTATION.length];
      test(`${s.name} (${variant})`, async () => {
        const dir = prepare(s.ops, variant, s.base || null);
        const target = await targetFor(dir);
        const res = await diffScope({ target, env: ENV });
        assert.deepEqual(severities(res.findings), sortedExpect(s.expect), JSON.stringify(res.findings.filter((f) => f.severity !== 'info'), null, 1));
        if (s.deps_expect) {
          const d = await deps.depsCheck({ target, offline: true, resolver: resolverFor(s.registry || DIFFS.registry), tools: false, env: ENV });
          assert.deepEqual(severities(d.findings), sortedExpect(s.deps_expect), JSON.stringify(d.findings, null, 1));
        }
      });
    });
  });
}

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

  test('finding messages and deps output never quote a secret, even when the setting they report holds one', async () => {
    const dir = prepare([
      { op: 'edit', path: 'package.json', find: '"test": "jest"', replace: `"test": "jest --token=${GH_TOKEN}"` },
      { op: 'edit', path: 'package.json', find: '"left-pad": "^1.3.0"', replace: `"left-pad": "^1.3.0",\n    "private-lib": "git+https://${GH_TOKEN}@github.com/o/r.git"` },
      { op: 'edit', path: '.github/workflows/ci.yml', find: '      - run: npm test -- --ci\n', replace: `      - run: npm test -- --ci --auth ${GH_TOKEN}\n` },
    ], 'uncommitted');
    const target = await targetFor(dir);
    const res = await diffScope({ target, env: ENV });
    assert.ok(res.findings.some((f) => f.id === 'CK-TEST-CFG'), 'the changed test script is still reported');
    assert.ok(res.findings.some((f) => f.id === 'CK-SECRETS'));
    assert.ok(!JSON.stringify(res).includes(GH_TOKEN), 'no token in messages or evidence');
    const d = await deps.depsCheck({ target, offline: true, tools: false, env: ENV });
    assert.equal(d.new_deps.find((x) => x.name === 'private-lib').kind, 'git');
    assert.ok(!JSON.stringify(d).includes(GH_TOKEN), 'no token in new_deps[].spec, messages or lock details');
  });

  test('the live token is flagged in its base64 and URL-encoded forms too', async () => {
    const token = ['zz-live', '/value+77'].join('');
    const b64 = Buffer.from(token).toString('base64');
    const dir = prepare([{ op: 'write', path: 'src/blob.js', content: `module.exports = ['${b64}', '${encodeURIComponent(token)}'];\n` }], 'uncommitted');
    const res = await diffScope({ target: await targetFor(dir), env: { ...ENV, ADC_LIVE_TOKEN: token } });
    const json = JSON.stringify(res);
    assert.ok(!json.includes(b64) && !json.includes(encodeURIComponent(token)) && !json.includes(token));
    assert.deepEqual(res.findings.filter((f) => f.rule === 'secret.adc-live-token-value').map((f) => f.line), [1]);
  });

  test('every live credential (ADC_LIVE_*KEY, *SECRET, ...) is redacted and flagged like the token', async () => {
    const key = ['hunter2', 'abcKey'].join('');
    const dir = prepare([{ op: 'edit', path: 'tests/math.test.js', find: "  it('adds', () => {", replace: `  it.only('adds ${key}', () => {` }], 'uncommitted');
    const res = await diffScope({ target: await targetFor(dir), env: { ...ENV, ADC_LIVE_API_KEY: key } });
    assert.ok(!JSON.stringify(res).includes(key), "the value never appears, not even in another check's evidence");
    assert.deepEqual(severities(res.findings), { 'CK-SECRETS': ['fail'], 'CK-SKIP': ['fail'] });
    assert.match(res.findings.find((f) => f.rule === 'secret.adc-live-token-value').message, /ADC_LIVE_API_KEY/);
  });

  test('lockfiles above the 2 MiB line-scan limit are still parsed (CK-LOCK static)', async () => {
    const lock = JSON.parse(DIFFS.base['package-lock.json']);
    for (let i = 0; i < 12000; i++) {
      lock.packages[`node_modules/pad-${i}`] = { version: '1.0.0', resolved: `https://registry.npmjs.org/pad-${i}/-/pad-${i}-1.0.0.tgz`, integrity: `sha512-${'A'.repeat(88)}` };
    }
    const big = JSON.stringify(lock, null, 2) + '\n';
    assert.ok(big.length > 2 * 1024 * 1024);
    const dir = initRepo({ ...DIFFS.base, 'package-lock.json': big });
    const pkg = JSON.parse(DIFFS.base['package.json']);
    pkg.dependencies['adc-new-dep'] = '^1.0.0';
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
    // The lockfile changes, but not to record the new dependency.
    fs.writeFileSync(path.join(dir, 'package-lock.json'), big.replace('"version": "1.0.0"', '"version": "1.0.1"'));
    const res = await diffScope({ target: await targetFor(dir), env: ENV });
    assert.deepEqual(res.findings.filter((f) => f.id === 'CK-LOCK').map((f) => f.rule), ['lock.missing-entry']);
  });

  test('a changed manifest that cannot be parsed leaves CK-DEPS unverified, never pass', async () => {
    const dir = prepare([{ op: 'edit', path: 'package.json', find: '"left-pad": "^1.3.0"', replace: '"left-pad": "^1.3.0",' }], 'uncommitted');
    const d = await deps.depsCheck({ target: await targetFor(dir), offline: true, tools: false, env: ENV });
    const c = d.checks.find((x) => x.id === 'CK-DEPS');
    assert.equal(c.status, 'unverified');
    assert.equal(c.reason, 'MANIFEST_UNPARSABLE');
    assert.deepEqual(d.unparsable, ['package.json']);
    assert.equal(d.checks.find((x) => x.id === 'CK-LOCK').status, 'unverified', 'the lockfile cannot be judged either');
  });

  test('a forced secret scanner that is not installed falls back and says so', async () => {
    const empty = fs.mkdtempSync(path.join(TMP, 'nopath-'));
    const dir = prepare([{ op: 'write', path: 'src/aws.js', content: "module.exports = '{{AWS_KEY}}';\n" }], 'uncommitted');
    const res = await diffScope({ target: await targetFor(dir), env: { ...ENV, ADC_SECRETS_SCANNER: 'gitleaks', PATH: empty } });
    const c = res.checks.find((x) => x.id === 'CK-SECRETS');
    assert.equal(c.data.scanner, 'builtin');
    assert.equal(c.data.scanner_error, 'gitleaks is not installed');
    assert.equal(c.status, 'fail');
  });

  test('unborn repository: everything is new and diffs against the empty tree', async () => {
    const dir = fs.mkdtempSync(path.join(TMP, 'unborn-'));
    gitCli(dir, 'init', '-q', '-b', 'main');
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
    // Spec paths that are not an array break only the scope step.
    const res = await diffScope({ target: await targetFor(dir), env: ENV, specPaths: { length: 1 } });
    const byId = Object.fromEntries(res.checks.map((c) => [c.id, c]));
    assert.equal(byId['CK-SCOPE'].status, 'unverified');
    assert.equal(byId['CK-SCOPE'].reason, 'STEP_ERROR');
    assert.match(byId['CK-SCOPE'].data.error, /not a function/);
    assert.equal(byId['CK-SKIP'].status, 'fail');
    assert.equal(byId['CK-SECRETS'].status, 'pass');
  });
});

// ---------------------------------------------------------------------------
// deps-check with the package managers' own lock checks (only where the tool is installed)

// ---------------------------------------------------------------------------
// External secret scanners (decision D7), exercised through fake executables on PATH

describe('external secret scanners', { skip: core.IS_WINDOWS && 'fake scanners are POSIX shell shims' }, () => {
  const fakeBin = (name, body) => {
    const dir = fs.mkdtempSync(path.join(TMP, `bin-${name}-`));
    const script = path.join(dir, `${name}.mjs`);
    fs.writeFileSync(script, body);
    const shim = path.join(dir, name);
    fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
    fs.chmodSync(shim, 0o755);
    return dir;
  };
  const GITLEAKS = `import fs from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === 'version') { console.log(process.env.FAKE_VERSION || 'v8.21.2'); process.exit(0); }
fs.writeFileSync(process.env.FAKE_LOG, JSON.stringify(args));
if (process.env.FAKE_FAIL) { console.error('fatal: fake scanner failure'); process.exit(2); }
const report = args[args.indexOf('--report-path') + 1];
fs.writeFileSync(report, JSON.stringify([{ RuleID: 'aws-access-token', File: 'src/aws.js', StartLine: 1, Secret: 'REDACTED', Match: 'REDACTED' }]));
process.exit(1);
`;
  const TRUFFLEHOG = `import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
fs.writeFileSync(process.env.FAKE_LOG, JSON.stringify(args));
const files = args.filter((a) => path.isAbsolute(a));
for (const file of files) {
  console.log(JSON.stringify({ SourceMetadata: { Data: { Filesystem: { file, line: 1 } } }, DetectorName: 'AWS', Raw: 'never-recorded' }));
  console.log(JSON.stringify({ SourceMetadata: { Data: { Filesystem: { file, line: 99 } } }, DetectorName: 'AWS', Raw: 'not-an-added-line' }));
}
`;
  const planted = [{ op: 'write', path: 'src/aws.js', content: "module.exports = { accessKeyId: '{{AWS_KEY}}' };\n" }];

  test('package managers and secret scanners run without the live credentials in their environment', async () => {
    const SPY = `import fs from 'node:fs';
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(Object.keys(process.env).filter((k) => k.startsWith('ADC_LIVE_'))) + '\\n');
if (process.argv[2] === 'version') console.log('v8.21.2');
`;
    const log = path.join(fs.mkdtempSync(path.join(TMP, 'envspy-')), 'calls.jsonl');
    const env = { ...ENV, PATH: [fakeBin('npm', SPY), fakeBin('gitleaks', SPY), process.env.PATH].join(path.delimiter),
      FAKE_LOG: log, ADC_SECRETS_SCANNER: 'gitleaks', ADC_LIVE_TOKEN: ['live', 'token', '123'].join('-'),
      ADC_LIVE_API_KEY: ['live', 'key', '456'].join('-') };
    assert.equal(deps.runLockTool('npm', fs.mkdtempSync(path.join(TMP, 'envspy-npm-')), { env }).status, 'consistent');
    await diffScope({ target: await targetFor(prepare(planted, 'uncommitted')), env });
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(calls.length, 3, 'npm, gitleaks version and gitleaks git ran');
    assert.deepEqual(calls.flat(), []);
  });

  test('gitleaks is preferred when installed; its findings and command are recorded, values never', async () => {
    const bin = fakeBin('gitleaks', GITLEAKS);
    const log = path.join(bin, 'args.json');
    for (const variant of ['committed', 'uncommitted']) {
      const dir = prepare(planted, variant);
      const target = await targetFor(dir);
      const env = { ...ENV, ADC_SECRETS_SCANNER: 'auto', PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAKE_LOG: log };
      const res = await diffScope({ target, env });
      const check = res.checks.find((c) => c.id === 'CK-SECRETS');
      assert.equal(check.status, 'fail');
      assert.equal(check.data.scanner, 'gitleaks');
      assert.match(check.command, /^gitleaks git --log-opts [0-9a-f]{40}\.\.[0-9a-f]{40} --redact/);
      assert.equal(check.exit_code, 1);
      assert.deepEqual(res.findings.filter((f) => f.id === 'CK-SECRETS').map((f) => `${f.file}:${f.line}:${f.rule}`), ['src/aws.js:1:gitleaks.aws-access-token']);
      const args = JSON.parse(fs.readFileSync(log, 'utf8'));
      assert.ok(args.includes(`${target.base.sha}..${target.snapshot.commit}`), 'the range ends at the snapshot, so uncommitted and untracked files are scanned');
      assert.ok(!JSON.stringify(res).includes(AWS_KEY));
    }
    const old = await diffScope({ target: await targetFor(prepare(planted, 'uncommitted')), env: { ...ENV, ADC_SECRETS_SCANNER: 'gitleaks', PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAKE_LOG: log, FAKE_VERSION: '8.18.4' } });
    assert.equal(JSON.parse(fs.readFileSync(log, 'utf8'))[0], 'detect', 'gitleaks before 8.19 uses `detect --source`');
    assert.equal(old.checks.find((c) => c.id === 'CK-SECRETS').status, 'fail');
  });

  test('lines the external scanner cannot see still get the built-in patterns (allow directives, ADC_LIVE_TOKEN)', async () => {
    const bin = fakeBin('gitleaks', GITLEAKS);
    const live = ['abcd', 'efgh', '1234'].join('-');
    const ops = [...planted,
      { op: 'write', path: 'src/allow.js', content: "module.exports = '{{AWS_KEY}}'; // gitleaks:allow\n" },
      { op: 'write', path: 'deploy/live.sh', content: `export ADC_LIVE_TOKEN=${live}\n` },
      { op: 'write', path: 'src/plain.js', content: "module.exports = '{{GH}}';\n" }];
    const env = { ...ENV, ADC_SECRETS_SCANNER: 'gitleaks', PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAKE_LOG: path.join(bin, 'args.json') };
    const res = await diffScope({ target: await targetFor(prepare(ops, 'uncommitted')), env });
    const got = res.findings.filter((f) => f.id === 'CK-SECRETS').map((f) => `${f.file}:${f.line}:${f.rule}`).sort();
    assert.deepEqual(got, ['deploy/live.sh:1:secret.adc-live-token', 'src/allow.js:1:secret.aws-access-key-id', 'src/aws.js:1:gitleaks.aws-access-token'],
      'src/plain.js is left to gitleaks, which (fake) reports nothing there');
    assert.ok(res.findings.some((f) => f.id === 'CK-SUPPRESS' && f.rule === 'suppress.secret-allow'));
    assert.ok(!JSON.stringify(res).includes(live) && !JSON.stringify(res).includes(AWS_KEY));
  });

  test('a failing scanner falls back to the built-in regexes and says so', async () => {
    const bin = fakeBin('gitleaks', GITLEAKS);
    const env = { ...ENV, ADC_SECRETS_SCANNER: 'auto', PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAKE_LOG: path.join(bin, 'args.json'), FAKE_FAIL: '1' };
    const res = await diffScope({ target: await targetFor(prepare(planted, 'uncommitted')), env });
    const check = res.checks.find((c) => c.id === 'CK-SECRETS');
    assert.equal(check.data.scanner, 'builtin');
    assert.match(check.data.scanner_error, /gitleaks exited 2/);
    assert.match(check.summary, /fell back to built-in/);
    assert.deepEqual(severities(res.findings), { 'CK-SECRETS': ['fail'] });
  });

  test('trufflehog scans the changed files and only findings on added lines count', async () => {
    const bin = fakeBin('trufflehog', TRUFFLEHOG);
    const log = path.join(bin, 'args.json');
    const env = { ...ENV, ADC_SECRETS_SCANNER: 'trufflehog', PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAKE_LOG: log };
    const res = await diffScope({ target: await targetFor(prepare(planted, 'uncommitted')), env });
    const check = res.checks.find((c) => c.id === 'CK-SECRETS');
    assert.equal(check.data.scanner, 'trufflehog');
    assert.deepEqual(res.findings.filter((f) => f.id === 'CK-SECRETS').map((f) => `${f.file}:${f.line}`), ['src/aws.js:1']);
    const args = JSON.parse(fs.readFileSync(log, 'utf8'));
    assert.equal(args[0], 'filesystem');
    assert.ok(args.includes('--no-verification') && args.includes('--no-update'));
    assert.ok(!JSON.stringify(res).includes('never-recorded'));
  });
});

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
    const before = gitCli(dir, 'status', '--porcelain');
    const res = await deps.depsCheck({ target: await targetFor(dir), offline: true, tools: true, env: ENV });
    assert.equal(res.lock_status.status, 'inconsistent');
    assert.equal(res.lock_status.lockfiles[0].tool.status, 'inconsistent');
    assert.equal(res.checks.find((c) => c.id === 'CK-LOCK').status, 'fail');
    assert.equal(gitCli(dir, 'status', '--porcelain'), before);
    assert.equal(gitCli(dir, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length, 1, 'temp worktree removed');
  });

  test('a lock entry added by the change is not proof of existence; a base entry is', async () => {
    const lockWith = (extra) => {
      const lock = JSON.parse(DIFFS.base['package-lock.json']);
      Object.assign(lock.packages, extra);
      return JSON.stringify(lock, null, 2) + '\n';
    };
    const transitive = { 'node_modules/debug': { version: '4.3.4', resolved: 'https://registry.npmjs.org/debug/-/debug-4.3.4.tgz' } };
    const dir = initRepo({ ...DIFFS.base, 'package-lock.json': lockWith(transitive) });
    const pkg = JSON.parse(DIFFS.base['package.json']);
    Object.assign(pkg.dependencies, { debug: '^4.3.4', 'adc-fabricated-pkg': '^1.0.0', 'adc-offhost-pkg': '^1.0.0' });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
    const lock = JSON.parse(lockWith({
      ...transitive,
      'node_modules/adc-fabricated-pkg': { version: '1.0.0', resolved: 'https://registry.npmjs.org/adc-fabricated-pkg/-/adc-fabricated-pkg-1.0.0.tgz', integrity: 'sha512-AAAA' },
      'node_modules/adc-offhost-pkg': { version: '1.0.0', resolved: 'https://pkgs.attacker.example/adc-offhost-pkg-1.0.0.tgz' },
    }));
    lock.packages[''].dependencies = pkg.dependencies;
    fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n');
    const target = await targetFor(dir);
    const offline = await deps.depsCheck({ target, offline: true, tools: false, env: ENV });
    const by = Object.fromEntries(offline.new_deps.map((d) => [d.name, d]));
    assert.equal(by.debug.exists, true, 'promoted from a transitive entry that existed at the base');
    assert.match(by.debug.source, /^lockfile:/);
    assert.equal(by['adc-fabricated-pkg'].exists, null);
    assert.match(by['adc-fabricated-pkg'].source, /new entry in package-lock\.json/);
    assert.equal(offline.checks.find((c) => c.id === 'CK-DEPS').status, 'unverified');
    assert.ok(offline.findings.some((f) => f.rule === 'deps.unexpected-host' && /pkgs\.attacker\.example/.test(f.message)));
    const online = await deps.depsCheck({ target, offline: false, tools: false, env: ENV, resolver: (eco, name) => name !== 'adc-fabricated-pkg' });
    const fab = online.findings.find((f) => f.rule === 'deps.nonexistent');
    assert.match(fab.message, /adc-fabricated-pkg.*although the change added it to the lockfile/);
    assert.equal(online.checks.find((c) => c.id === 'CK-DEPS').status, 'fail');
  });

  test('depsCheck without an offline flag follows the sandbox default', async () => {
    const dir = prepare([{ op: 'write', path: 'requirements.txt', content: 'adc-unknown-offline-pkg==1.0\n' }], 'uncommitted');
    const res = await deps.depsCheck({ target: await targetFor(dir), tools: false, env: { ...ENV, CODEX_SANDBOX: 'seatbelt' } });
    assert.equal(res.offline, true);
    assert.equal(res.new_deps[0].source, 'offline');
  });

  test('registry lookups answer exists / does not exist (network; opt in with ADC_TEST_NETWORK=1)',
    { skip: process.env.ADC_TEST_NETWORK !== '1' && 'set ADC_TEST_NETWORK=1 to query the public registries' }, () => {
      const cases = [['npm', 'npm', 'left-pad'], ['pypi', 'uv', 'requests'], ['crates', 'cargo', 'serde'], ['rubygems', 'gem', 'rake']];
      for (const [eco, tool, real] of cases) {
        if (!core.which(tool)) continue;
        assert.equal(deps.registryLookup(eco, real, {}).exists, true, `${eco} ${real}`);
        assert.equal(deps.registryLookup(eco, 'adc-nonexistent-pkg-zz9', {}).exists, false, `${eco} missing`);
      }
      if (core.which('go')) assert.equal(deps.registryLookup('go', 'github.com/stretchr/testify', {}).exists, true);
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
  const runAdc = (args, dir, env = {}) => adcRun(args, { cwd: dir, env: { ...ENV, ADC_HOME: path.join(TMP, `home-${path.basename(dir)}`), ...env } });

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

  test('default state dir inside the repository (.adc/ in info/exclude), twice in a row', () => {
    const dir = prepare(DIFFS.scenarios.find((s) => s.name === 'it.only').ops, 'uncommitted');
    for (let i = 0; i < 2; i++) {
      // The second run finds .adc/ already ignored through info/exclude.
      const r = adcRun(['diff-scope'], { cwd: dir, env: ENV });
      assert.equal(r.status, 1, r.stderr);
      assert.ok(fs.existsSync(path.join(dir, '.adc')));
      assert.ok(!r.json.files.some((f) => f.path.startsWith('.adc/')));
    }
    assert.match(fs.readFileSync(path.join(dir, '.git', 'info', 'exclude'), 'utf8'), /^\/\.adc\/$/m);
    assert.equal(gitCli(dir, 'status', '--porcelain'), ' M tests/math.test.js\n', 'only the planted edit; .adc/ stays invisible');
  });

  test('a tracked .adc/ makes both commands exit 3', () => {
    const dir = scenarioRepo();
    fs.mkdirSync(path.join(dir, '.adc'));
    fs.writeFileSync(path.join(dir, '.adc', 'notes.json'), '{}\n');
    gitCli(dir, 'add', '-f', '.adc/notes.json');
    gitCli(dir, 'commit', '-q', '-m', 'oops');
    for (const cmd of ['diff-scope', 'deps-check']) {
      const r = adcRun([cmd], { cwd: dir, env: ENV });
      assert.equal(r.status, 3, `${cmd}: ${r.stdout}`);
      assert.equal(r.json.error.code, 'STATE_TRACKED');
    }
  });

  test('leak matrix: neither the .env.live token nor the environment token reaches the output', () => {
    const fileToken = ['hunter2', 'abc'].join('');
    const envToken = ['zz-second', '-value-77'].join('');
    // diff-scope never reads .adc/.env.live (plan §7.3), so it can only redact the environment value;
    // the file value stays out of the result because .adc/ is excluded and its line triggers nothing.
    const dir = prepare([
      { op: 'write', path: 'src/client.js', content: `const token = '${envToken}';\nmodule.exports = { token };\n` },
      { op: 'write', path: 'src/other.js', content: `module.exports = '${fileToken}';\n` },
    ], 'uncommitted');
    fs.mkdirSync(path.join(dir, '.adc'));
    fs.writeFileSync(path.join(dir, '.adc', '.env.live'), `ADC_LIVE_TOKEN=${fileToken}\n`);
    fs.appendFileSync(path.join(dir, '.git', 'info', 'exclude'), '/.adc/\n');
    const r = adcRun(['diff-scope'], { cwd: dir, env: { ...ENV, ADC_LIVE_TOKEN: envToken } });
    assert.equal(r.status, 1, r.stderr);
    for (const out of [r.stdout, r.stderr]) {
      assert.ok(!out.includes(fileToken) && !out.includes(envToken), 'no token value in stdout or stderr');
    }
    const res = r.json;
    assert.ok(res.findings.some((f) => f.rule === 'secret.adc-live-token-value' && f.file === 'src/client.js'));
    assert.ok(!res.files.some((f) => f.path.startsWith('.adc/')));
    const d = adcRun(['deps-check', '--offline', '--static-only'], { cwd: dir, env: { ...ENV, ADC_LIVE_TOKEN: envToken } });
    assert.ok(!d.stdout.includes(fileToken) && !d.stdout.includes(envToken));
  });

  test('deps-check --dry-run creates no state directory', () => {
    const dir = prepare(DIFFS.scenarios.find((s) => s.name === 'clean').ops, 'uncommitted');
    const r = adcRun(['deps-check', '--offline', '--static-only', '--dry-run'], { cwd: dir, env: ENV });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(!fs.existsSync(path.join(dir, '.adc')));
  });
});

test('redactDeep never returns a subtree nested deeper than its limit unredacted', () => {
  let deep = 'leaf';
  for (let i = 0; i < 80; i++) deep = { k: deep };
  const out = JSON.stringify(M.redactDeep(deep, (s) => s.toUpperCase()));
  assert.ok(!out.includes('"leaf"') && out.includes('[REDACTED:TOO_DEEP]'));
});
