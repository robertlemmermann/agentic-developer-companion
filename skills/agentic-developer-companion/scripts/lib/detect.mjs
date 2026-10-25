// Project detection (§7.4): one entry per project (monorepo-aware) with its package manager
// and frozen install, test runners with report and retries-off flags, test-file globs, type
// checkers and linters; the CI system and the test commands CI really runs; the default
// branch. Manifests and configs are read as text; project code is never executed. The result
// is cached in <state>/detect.json under a digest of every detection input (the hooks'
// session brief reads `summary` and the test globs from that file).

import fs from 'node:fs';
import path from 'node:path';
import {
  EXIT, defineCommand, usageError, readText, readJson, writeJsonAtomic, sha256, nowIso, toPosix,
  matchAny, matchGlob, which, skillVersion, generatedBy, redactLiterals, truncate, listFiles,
} from './core.mjs';
import { gitRaw, gitTry, repoRoot, resolveBase, revParse } from './git.mjs';
import { prepareStateDir, statePaths, STATE_DIR_NAME } from './state.mjs';

export const DETECT_SCHEMA = 'adc-detect/1';
const MAX_READ = 2 * 1024 * 1024;
const MAX_FILES = 200_000;
const MAX_DEPTH = 14;
const SCRIPT_DEPTH = 6;

// Heavy, generated or vendored folders: never a project, never a detection input.
const SKIP_DIRS = new Set(['.git', '.hg', '.svn', STATE_DIR_NAME, 'node_modules', 'bower_components', 'jspm_packages',
  '.venv', 'venv', '.tox', '.nox', '__pycache__', '.mypy_cache', '.pytest_cache', '.ruff_cache', 'target', 'dist',
  'build', 'out', 'obj', '.next', '.nuxt', '.svelte-kit', '.turbo', '.yarn', '.pnpm-store', '.gradle', '.idea',
  'vendor', 'coverage', '.cache', '.terraform', '.dart_tool', 'site-packages']);
// Manifests in these folders belong to test fixtures, not to the build.
const FIXTURE_DIRS = new Set(['fixtures', '__fixtures__', 'fixture', 'testdata', 'test-fixtures', 'test_fixtures',
  '__mocks__', '__snapshots__']);

const NODE_LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'];
const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb',
  'uv.lock', 'poetry.lock', 'pdm.lock', 'Pipfile.lock', 'Cargo.lock', 'go.sum', 'Gemfile.lock', 'packages.lock.json',
  'gradle.lockfile'];
const PRESENCE_NAMES = new Set([...LOCKFILES, 'conftest.py', 'gradlew', 'gradlew.bat', 'mvnw', 'mvnw.cmd', '.pnp.cjs',
  'noxfile.py', '.rspec', 'Steepfile']);
const CONTENT_NAMES = new Set(['package.json', 'pnpm-workspace.yaml', 'lerna.json', '.yarnrc.yml', 'tsconfig.json',
  'pyproject.toml', 'setup.py', 'setup.cfg', 'tox.ini', 'pytest.ini', '.pytest.ini', 'pytest.toml', '.pytest.toml',
  'Pipfile', 'mypy.ini', '.mypy.ini', 'ruff.toml', '.ruff.toml', 'pyrightconfig.json', '.flake8', 'go.mod', 'go.work',
  'Cargo.toml', 'clippy.toml', '.clippy.toml', 'global.json', 'pom.xml', 'build.gradle', 'build.gradle.kts',
  'settings.gradle', 'settings.gradle.kts', 'gradle.properties', 'Gemfile', 'Rakefile', '.rubocop.yml', 'Makefile',
  'makefile', 'GNUmakefile', 'justfile', 'Justfile', '.justfile', 'Jenkinsfile', '.gitlab-ci.yml',
  'bitbucket-pipelines.yml', '.travis.yml', 'biome.json', 'biome.jsonc']);
const CONTENT_RES = [/^(?:jest|vitest|vite|playwright|cypress)\.config\.[cm]?[jt]s$/, /^jest\.config\.json$/,
  /^vitest\.(?:workspace|projects)\.(?:[cm]?[jt]s|json)$/, /^\.mocharc\.(?:js|cjs|mjs|json|jsonc|ya?ml)$/,
  /^eslint\.config\.[cm]?[jt]s$/, /^\.eslintrc(?:\.(?:js|cjs|json|ya?ml))?$/, /^requirements(?:[-_.][\w.-]*)?\.txt$/,
  /\.(?:csproj|fsproj|vbproj)$/, /^\.golangci\.(?:ya?ml|toml|json)$/, /^azure-pipelines[\w.-]*\.ya?ml$/];
const MANIFEST_NAMES = new Set(['package.json', 'pyproject.toml', 'setup.py', 'setup.cfg', 'Pipfile', 'pytest.ini',
  '.pytest.ini', 'pytest.toml', '.pytest.toml', 'tox.ini', 'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle',
  'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'Gemfile']);
const MAKE_NAMES = ['GNUmakefile', 'makefile', 'Makefile'];
const JUST_NAMES = ['justfile', 'Justfile', '.justfile'];

const CODE_EXTS = new Set(['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts', 'py', 'go', 'rs', 'cs', 'fs', 'vb',
  'java', 'kt', 'kts', 'scala', 'groovy', 'rb']);
const ECO_ORDER = ['node', 'python', 'go', 'rust', 'dotnet', 'jvm', 'ruby', 'make', 'just', 'ci'];

/** Globs used by isTestFile when no detected project owns a file. */
export const DEFAULT_TEST_GLOBS = Object.freeze(['**/__tests__/**', '**/*.{test,spec}.*', '**/*_{test,spec}.*',
  '**/test_*.py', '**/conftest.py', '**/*_test.go', '**/*_spec.rb', 'test/**', 'tests/**', 'spec/**',
  '**/src/test/**', '**/*.cy.*', '**/*Tests/**', '**/*.Tests/**']);

// ---------------------------------------------------------------------------
// Runner catalog (§7.4 table). In `report`, `<f>` is the report file and `<d>` a report
// directory; consumers substitute them. `retries_off.mechanism` is a CLI flag when it starts
// with `-` (append it last), otherwise the reason nothing needs to be passed. `coverage`:
// full = the runner's own retries are off; partial = retries live in test code; unknown =
// the run cannot tell a retried test from a passing one.

const clone = (v) => JSON.parse(JSON.stringify(v));
const SUMMARY_REPORT = Object.freeze({ format: 'summary-text', stdout: true });
const JS_DEFAULT_GLOBS = ['**/__tests__/**', '**/*.{test,spec}.*'];
const NODE_TEST_EXT = '{cjs,mjs,js,cts,mts,ts}';

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); }
  return o;
}

function runnerDef(name, d) {
  return deepFreeze({ name, kind: 'unit', count_parser: (d.report && d.report.format) || 'summary-text', ...clone(d) });
}

export const RUNNERS = Object.freeze({
  'node-test': runnerDef('node-test', {
    ecosystem: 'node', cmd: 'node --test',
    report: { flag: '--test-reporter=junit --test-reporter-destination=<f>', format: 'junit' },
    retries_off: { mechanism: 'node:test has no retries', coverage: 'full' },
    test_globs: [`**/*.test.${NODE_TEST_EXT}`, `**/*-test.${NODE_TEST_EXT}`, `**/*_test.${NODE_TEST_EXT}`,
      `**/test-*.${NODE_TEST_EXT}`, `**/test.${NODE_TEST_EXT}`, `**/test/**/*.${NODE_TEST_EXT}`],
  }),
  jest: runnerDef('jest', {
    ecosystem: 'node', cmd: 'npx --no jest --ci',
    report: { flag: '--json --outputFile=<f>', format: 'jest-json' },
    retries_off: { mechanism: 'jest.retryTimes() lives in test code (no CLI switch); retried tests are reported as flaky', coverage: 'partial' },
    test_globs: JS_DEFAULT_GLOBS,
  }),
  vitest: runnerDef('vitest', {
    ecosystem: 'node', cmd: 'npx --no vitest run',
    report: { flag: '--reporter=junit --outputFile=<f>', format: 'junit' },
    retries_off: { mechanism: '--retry=0', coverage: 'full' },
    test_globs: JS_DEFAULT_GLOBS,
  }),
  mocha: runnerDef('mocha', {
    ecosystem: 'node', cmd: 'npx --no mocha',
    report: { flag: '--reporter xunit --reporter-option output=<f>', format: 'junit' },
    retries_off: { mechanism: '--retries 0', coverage: 'full' },
    test_globs: ['test/**', '**/*.{test,spec}.*'],
  }),
  playwright: runnerDef('playwright', {
    ecosystem: 'node', kind: 'e2e', cmd: 'npx --no playwright test',
    report: { flag: '--reporter=junit', env: { PLAYWRIGHT_JUNIT_OUTPUT_NAME: '<f>' }, format: 'junit' },
    retries_off: { mechanism: '--retries=0', coverage: 'full' },
    test_globs: ['**/*.{test,spec}.*'],
  }),
  cypress: runnerDef('cypress', {
    ecosystem: 'node', kind: 'e2e', cmd: 'npx --no cypress run',
    report: { flag: '--reporter junit --reporter-options mochaFile=<f>', format: 'junit' },
    retries_off: { mechanism: '--config retries=0', coverage: 'full' },
    test_globs: ['cypress/e2e/**', 'cypress/integration/**', 'cypress/component/**', '**/*.cy.*'],
  }),
  bun: runnerDef('bun', {
    ecosystem: 'node', cmd: 'bun test',
    report: { flag: '--reporter=junit --reporter-outfile=<f>', format: 'junit' },
    retries_off: { mechanism: '--retry=0', coverage: 'full' },
    test_globs: ['**/*.{test,spec}.*', '**/*_{test,spec}.*'],
  }),
  pytest: runnerDef('pytest', {
    ecosystem: 'python', cmd: 'python -m pytest',
    report: { flag: '--junit-xml=<f>', format: 'junit' },
    retries_off: { mechanism: '-p no:rerunfailures', coverage: 'full' },
    test_globs: ['test_*.py', '*_test.py', 'tests/**', 'conftest.py'],
  }),
  unittest: runnerDef('unittest', {
    ecosystem: 'python', cmd: 'python -m unittest discover',
    report: SUMMARY_REPORT,
    retries_off: { mechanism: 'unittest has no retries', coverage: 'full' },
    test_globs: ['test*.py', 'tests/**'],
  }),
  go: runnerDef('go', {
    ecosystem: 'go', cmd: 'go test ./...',
    report: { flag: '-json', format: 'go-test-json', stdout: true },
    retries_off: { mechanism: '-count=1', coverage: 'full' },
    test_globs: ['**/*_test.go'],
  }),
  cargo: runnerDef('cargo', {
    ecosystem: 'rust', cmd: 'cargo test --no-fail-fast',
    report: { format: 'cargo-text', stdout: true },
    retries_off: { mechanism: 'libtest has no retries, but plain cargo test cannot report a flaky test', coverage: 'unknown' },
    test_globs: ['tests/**'],
  }),
  nextest: runnerDef('nextest', {
    ecosystem: 'rust', cmd: 'cargo nextest run --no-fail-fast',
    // Without a JUnit profile in the repository, a tool config file defines one (clean-run writes it).
    report: { flag: '--tool-config-file adc:<d>/nextest-adc.toml --profile adc-ci', path: '<target>/nextest/adc-ci/junit.xml', format: 'junit', nextestConfig: true },
    retries_off: { mechanism: '--retries 0', coverage: 'full' },
    test_globs: ['tests/**'],
  }),
  dotnet: runnerDef('dotnet', {
    ecosystem: 'dotnet', cmd: 'dotnet test',
    report: { flag: '--logger trx --results-directory <d>', dir: '<d>', glob: '*.trx', format: 'trx' },
    retries_off: { mechanism: 'VSTest has no retry switch; retry attributes of the test framework are not visible', coverage: 'unknown' },
    test_globs: ['**/*Tests*/**', 'tests/**', 'test/**'],
  }),
  maven: runnerDef('maven', {
    ecosystem: 'jvm', cmd: 'mvn -B test',
    report: { dir: 'target/surefire-reports', glob: 'TEST-*.xml', format: 'junit' },
    retries_off: { mechanism: '-Dsurefire.rerunFailingTestsCount=0', coverage: 'full' },
    test_globs: ['src/test/**'],
  }),
  gradle: runnerDef('gradle', {
    ecosystem: 'jvm', cmd: './gradlew test',
    report: { dir: 'build/test-results/test', glob: 'TEST-*.xml', format: 'junit' },
    retries_off: { mechanism: 'Gradle has no retry switch; framework-level retries are not visible', coverage: 'unknown' },
    test_globs: ['src/test/**'],
  }),
  rspec: runnerDef('rspec', {
    ecosystem: 'ruby', cmd: 'bundle exec rspec',
    report: { flag: '--format json --out <f> --format progress', format: 'rspec-json' },
    retries_off: { mechanism: 'RSpec has no built-in retries', coverage: 'unknown' },
    test_globs: ['spec/**'],
  }),
  minitest: runnerDef('minitest', {
    ecosystem: 'ruby', cmd: 'bundle exec rake test',
    report: SUMMARY_REPORT,
    retries_off: { mechanism: 'Minitest has no built-in retries', coverage: 'unknown' },
    test_globs: ['test/**'],
  }),
  make: runnerDef('make', {
    ecosystem: 'make', kind: 'wrapper', cmd: 'make test', report: SUMMARY_REPORT,
    retries_off: { mechanism: 'make target: retries depend on the wrapped runner', coverage: 'unknown' }, test_globs: [],
  }),
  just: runnerDef('just', {
    ecosystem: 'just', kind: 'wrapper', cmd: 'just test', report: SUMMARY_REPORT,
    retries_off: { mechanism: 'just recipe: retries depend on the wrapped runner', coverage: 'unknown' }, test_globs: [],
  }),
  'npm-script': runnerDef('npm-script', {
    ecosystem: 'node', kind: 'wrapper', cmd: 'npm test', report: SUMMARY_REPORT,
    retries_off: { mechanism: 'package.json test script with an unrecognized runner', coverage: 'unknown' },
    test_globs: [...JS_DEFAULT_GLOBS, 'test/**', 'tests/**'],
  }),
  ci: runnerDef('ci', {
    ecosystem: 'ci', kind: 'wrapper', cmd: null, report: SUMMARY_REPORT,
    retries_off: { mechanism: 'command learned from CI; retries depend on the wrapped runner', coverage: 'unknown' }, test_globs: [],
  }),
});

// ---------------------------------------------------------------------------
// Small path helpers

const joinRel = (dir, name) => (!dir || dir === '.' ? name : `${dir}/${name}`);
const dirOf = (rel) => { const i = rel.lastIndexOf('/'); return i === -1 ? '.' : rel.slice(0, i); };
const baseOf = (rel) => rel.slice(rel.lastIndexOf('/') + 1);
const segsOf = (rel) => (rel === '.' ? [] : rel.split('/'));
const under = (rel, dir) => dir === '.' || rel === dir || rel.startsWith(`${dir}/`);
const subPath = (rel, dir) => (dir === '.' ? rel : rel === dir ? '' : rel.slice(dir.length + 1));
const uniq = (arr) => [...new Set(arr.filter((x) => x != null && x !== ''))];
const inFixtureDir = (rel) => segsOf(dirOf(rel)).some((s) => FIXTURE_DIRS.has(s));
function normRel(file) {
  let f = toPosix(String(file || '')).replace(/^\.\/+/, '');
  while (f.startsWith('./')) f = f.slice(2);
  return f.replace(/\/+$/, '');
}

// ---------------------------------------------------------------------------
// Text parsers (minimal, tolerant; all handle \r\n)

/** Minimal TOML reader: tables, arrays of tables, dotted keys, strings, arrays, inline tables. */
export function parseToml(text) {
  const src = String(text ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const root = {};
  let cur = root;
  let i = 0;
  const n = src.length;
  const ws = () => { while (i < n && (src[i] === ' ' || src[i] === '\t')) i++; };
  const skipLine = () => { while (i < n && src[i] !== '\n') i++; };
  const wsnl = () => { for (;;) { ws(); if (src[i] === '#') skipLine(); if (src[i] === '\n') { i++; continue; } return; } };
  const fail = (msg) => { throw new Error(msg); };
  const basic = () => {
    i++;
    let out = '';
    while (i < n && src[i] !== '"') {
      if (src[i] === '\n') fail('newline in string');
      if (src[i] === '\\') {
        const c = src[i + 1];
        const map = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\' };
        if (c in map) { out += map[c]; i += 2; continue; }
        if (c === 'u' || c === 'U') { const len = c === 'u' ? 4 : 8; out += String.fromCodePoint(parseInt(src.slice(i + 2, i + 2 + len), 16) || 0xfffd); i += 2 + len; continue; }
        out += c; i += 2; continue;
      }
      out += src[i++];
    }
    i++;
    return out;
  };
  const literal = () => { const end = src.indexOf("'", i + 1); if (end === -1) fail('unterminated string'); const s = src.slice(i + 1, end); i = end + 1; return s; };
  const multi = (q) => {
    i += 3;
    if (src[i] === '\n') i++;
    const end = src.indexOf(q.repeat(3), i);
    if (end === -1) fail('unterminated multi-line string');
    let s = src.slice(i, end);
    i = end + 3;
    while (src[i] === q[0]) { s += q[0]; i++; }
    if (q === '"') s = s.replace(/\\\n\s*/g, '').replace(/\\([ntr"\\])/g, (_, c) => ({ n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\' }[c]));
    return s;
  };
  const key = () => {
    const parts = [];
    for (;;) {
      ws();
      if (src[i] === '"') parts.push(basic());
      else if (src[i] === "'") parts.push(literal());
      else {
        const m = /^[A-Za-z0-9_-]+/.exec(src.slice(i, i + 256));
        if (!m) fail('bad key');
        parts.push(m[0]);
        i += m[0].length;
      }
      ws();
      if (src[i] === '.') { i++; continue; }
      return parts;
    }
  };
  const setPath = (obj, parts, value) => {
    let o = obj;
    for (const p of parts.slice(0, -1)) {
      if (o[p] == null || typeof o[p] !== 'object') o[p] = {};
      o = Array.isArray(o[p]) ? o[p][o[p].length - 1] : o[p];
    }
    o[parts[parts.length - 1]] = value;
  };
  const table = (parts, arrayTable) => {
    let o = root;
    parts.forEach((p, idx) => {
      const last = idx === parts.length - 1;
      if (last && arrayTable) {
        if (!Array.isArray(o[p])) o[p] = [];
        const t = {};
        o[p].push(t);
        o = t;
        return;
      }
      if (o[p] == null || typeof o[p] !== 'object') o[p] = {};
      o = Array.isArray(o[p]) ? o[p][o[p].length - 1] : o[p];
    });
    return o;
  };
  const value = () => {
    ws();
    if (src.startsWith('"""', i)) return multi('"');
    if (src.startsWith("'''", i)) return multi("'");
    if (src[i] === '"') return basic();
    if (src[i] === "'") return literal();
    if (src[i] === '[') {
      i++;
      const arr = [];
      for (;;) {
        wsnl();
        if (src[i] === ']') { i++; return arr; }
        arr.push(value());
        wsnl();
        if (src[i] === ',') { i++; continue; }
        if (src[i] === ']') { i++; return arr; }
        fail('bad array');
      }
    }
    if (src[i] === '{') {
      i++;
      const obj = {};
      for (;;) {
        ws();
        if (src[i] === '}') { i++; return obj; }
        const k = key();
        ws();
        if (src[i] !== '=') fail('expected =');
        i++;
        setPath(obj, k, value());
        ws();
        if (src[i] === ',') { i++; continue; }
        if (src[i] === '}') { i++; return obj; }
        fail('bad inline table');
      }
    }
    const m = /^[^,\]}\n#]+/.exec(src.slice(i, i + 512));
    if (!m) fail('bad value');
    i += m[0].length;
    const raw = m[0].trim();
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    if (/^[+-]?\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?$/.test(raw)) return Number(raw.replace(/_/g, ''));
    return raw;
  };
  for (;;) {
    wsnl();
    if (i >= n) break;
    try {
      if (src.startsWith('[[', i)) {
        i += 2;
        const k = key();
        if (!src.startsWith(']]', i)) fail('expected ]]');
        i += 2;
        cur = table(k, true);
      } else if (src[i] === '[') {
        i++;
        const k = key();
        if (src[i] !== ']') fail('expected ]');
        i++;
        cur = table(k, false);
      } else {
        const k = key();
        ws();
        if (src[i] !== '=') fail('expected =');
        i++;
        setPath(cur, k, value());
      }
      ws();
      if (src[i] === '#') skipLine();
      if (i < n && src[i] !== '\n') fail('trailing characters');
    } catch {
      skipLine();
    }
  }
  return root;
}

/** INI reader (setup.cfg, tox.ini, pytest.ini, .flake8, mypy.ini): `{ section: { key: value } }`. */
export function parseIni(text) {
  const out = {};
  let sec = null;
  let last = null;
  for (const raw of String(text ?? '').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim() || /^\s*[#;]/.test(line)) continue;
    const s = /^\[([^\]]+)\]/.exec(line);
    if (s) { sec = s[1].trim(); out[sec] = out[sec] || {}; last = null; continue; }
    if (/^\s/.test(line) && sec && last) { out[sec][last] = `${out[sec][last]}\n${line.trim()}`.replace(/^\n/, ''); continue; }
    const m = /^([^=:\s][^=:]*?)\s*[=:]\s*(.*)$/.exec(line);
    if (m && sec) { last = m[1].trim(); out[sec][last] = m[2].trim(); }
  }
  return out;
}

const YAML_KEY = /^((?:"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s"'#\-[\]{},&*!|>%@`][^#]*?|-[^\s#][^#]*?))\s*:(?=\s|$)/;
const isSeqLine = (t) => /^-(?:\s|$)/.test(t);

function stripYamlComment(raw) {
  let q = null;
  for (let k = 0; k < raw.length; k++) {
    const c = raw[k];
    if (q) { if (c === q) q = null; continue; }
    if ((c === '"' || c === "'") && (k === 0 || /[\s:[{,-]/.test(raw[k - 1]))) { q = c; continue; }
    if (c === '#' && (k === 0 || /\s/.test(raw[k - 1]))) return raw.slice(0, k);
  }
  return raw;
}

function yamlScalar(s) {
  const t = s.trim();
  if (t.startsWith('"')) {
    const end = t.lastIndexOf('"');
    const body = end > 0 ? t.slice(1, end) : t.slice(1);
    return body.replace(/\\(["\\/nrt0]|u[0-9a-fA-F]{4})/g, (_, c) => (c[0] === 'u' ? String.fromCharCode(parseInt(c.slice(1), 16))
      : { '"': '"', '\\': '\\', '/': '/', n: '\n', r: '\r', t: '\t', 0: '\0' }[c]));
  }
  if (t.startsWith("'")) {
    const end = t.lastIndexOf("'");
    return (end > 0 ? t.slice(1, end) : t.slice(1)).replace(/''/g, "'");
  }
  if (t === '' || t === '~' || t === 'null' || t === 'Null' || t === 'NULL') return null;
  if (/^(?:true|True|TRUE)$/.test(t)) return true;
  if (/^(?:false|False|FALSE)$/.test(t)) return false;
  return t;
}

function yamlFlow(str) {
  let p = 0;
  const skip = () => { while (p < str.length && /\s/.test(str[p])) p++; };
  const tok = (isKey) => {
    skip();
    if (str[p] === '"' || str[p] === "'") {
      const q = str[p];
      let k = p + 1;
      while (k < str.length && !(str[k] === q && (q !== "'" || str[k + 1] !== "'") && (q !== '"' || str[k - 1] !== '\\'))) k += q === "'" && str[k] === "'" ? 2 : 1;
      const raw = str.slice(p, k + 1);
      p = k + 1;
      return yamlScalar(raw);
    }
    const start = p;
    while (p < str.length && !/[,\]}]/.test(str[p]) && !(isKey && str[p] === ':' && /[\s,\]}]/.test(str[p + 1] ?? ' '))) p++;
    return yamlScalar(str.slice(start, p));
  };
  const val = () => {
    skip();
    if (str[p] === '[') {
      p++;
      const a = [];
      for (;;) {
        skip();
        if (p >= str.length) return a;
        if (str[p] === ']') { p++; return a; }
        a.push(val());
        skip();
        if (str[p] === ',') { p++; continue; }
        if (str[p] === ']') { p++; return a; }
        return a;
      }
    }
    if (str[p] === '{') {
      p++;
      const o = {};
      for (;;) {
        skip();
        if (p >= str.length) return o;
        if (str[p] === '}') { p++; return o; }
        const k = tok(true);
        skip();
        let v = null;
        if (str[p] === ':') { p++; v = val(); }
        o[String(k)] = v;
        skip();
        if (str[p] === ',') { p++; continue; }
        if (str[p] === '}') { p++; return o; }
        return o;
      }
    }
    return tok(false);
  };
  return val();
}

function flowBalanced(s) {
  let depth = 0;
  let q = null;
  for (const c of s) {
    if (q) { if (c === q) q = null; continue; }
    if (c === '"' || c === "'") q = c;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
  }
  return depth <= 0;
}

function yamlDocument(lines) {
  const L = lines.map((raw) => {
    const indent = raw.length - raw.replace(/^[ \t]+/, '').length;
    const text = stripYamlComment(raw).trimEnd();
    return { raw, indent, text: text.trim() ? text.slice(indent) : '' };
  });
  const anchors = new Map();
  let i = 0;
  const next = (from) => { let j = from; while (j < L.length && !L[j].text) j++; return j; };

  const blockScalar = (header, parentIndent) => {
    const m = /^([|>])([+-]?)(\d?)([+-]?)/.exec(header);
    const literal = m[1] === '|';
    const chomp = m[2] || m[4];
    let contentIndent = m[3] ? parentIndent + Number(m[3]) : null;
    const out = [];
    let j = i;
    for (; j < L.length; j++) {
      const raw = L[j].raw;
      if (!raw.trim()) { out.push(''); continue; }
      const ind = L[j].indent;
      if (contentIndent == null) { if (ind <= parentIndent) break; contentIndent = ind; }
      if (ind < contentIndent) break;
      out.push(raw.slice(contentIndent));
    }
    i = j;
    let trailing = 0;
    while (out.length && out[out.length - 1] === '') { out.pop(); trailing++; }
    let text = literal ? out.join('\n') : out.reduce((acc, l, k) => (k === 0 ? l : l === '' ? `${acc}\n` : acc.endsWith('\n') ? acc + l : `${acc} ${l}`), '');
    if (chomp === '+') text += '\n'.repeat(trailing + 1);
    else if (chomp !== '-' && out.length) text += '\n';
    return text;
  };

  const inlineValue = (rest, parentIndent) => {
    let anchor = null;
    let m = /^&(\S+)\s*/.exec(rest);
    if (m) { anchor = m[1]; rest = rest.slice(m[0].length); }
    m = /^!\S*\s*/.exec(rest);
    if (m) rest = rest.slice(m[0].length);
    let v;
    if (rest === '') {
      const j = next(i);
      if (j < L.length && (L[j].indent > parentIndent || (L[j].indent === parentIndent && isSeqLine(L[j].text)))) {
        i = j;
        v = node(L[j].indent);
      } else v = null;
    } else if (/^[|>]/.test(rest)) v = blockScalar(rest, parentIndent);
    else if (rest[0] === '*') v = anchors.has(rest.slice(1).trim()) ? clone(anchors.get(rest.slice(1).trim())) : null;
    else if (rest[0] === '[' || rest[0] === '{') {
      let s = rest;
      while (!flowBalanced(s) && i < L.length) { s += ` ${L[i].text}`; i++; }
      v = yamlFlow(s);
    } else {
      let s = rest;
      const quoted = s[0] === '"' || s[0] === "'";
      if (quoted && (s.length < 2 || s[s.length - 1] !== s[0])) {
        while (i < L.length) { const t = L[i].raw.trim(); s += ` ${t}`; i++; if (t.endsWith(s[0])) break; }
      } else if (!quoted) {
        for (let j = next(i); j < L.length && L[j].indent > parentIndent && !YAML_KEY.test(L[j].text) && !isSeqLine(L[j].text); j = next(j + 1)) {
          s += ` ${L[j].text}`;
          i = j + 1;
        }
      }
      v = yamlScalar(s);
    }
    if (anchor) anchors.set(anchor, v);
    return v;
  };

  const mapping = (indent) => {
    const obj = {};
    for (;;) {
      i = next(i);
      if (i >= L.length) break;
      const ln = L[i];
      if (ln.indent !== indent) break;
      const m = YAML_KEY.exec(ln.text);
      if (!m) break;
      const key = String(yamlScalar(m[1]));
      const rest = ln.text.slice(m[0].length).trim();
      i++;
      const v = inlineValue(rest, indent);
      if (key === '<<' && v && typeof v === 'object') {
        for (const src of Array.isArray(v) ? v : [v]) for (const [k, x] of Object.entries(src || {})) if (!(k in obj)) obj[k] = x;
      } else obj[key] = v;
    }
    return obj;
  };

  const sequence = (indent) => {
    const arr = [];
    for (;;) {
      i = next(i);
      if (i >= L.length) break;
      const ln = L[i];
      if (ln.indent !== indent || !isSeqLine(ln.text)) break;
      let rest = ln.text.replace(/^-\s*/, '');
      let col = indent + (ln.text.length - rest.length);
      let anchor = null;
      const am = /^&(\S+)\s+/.exec(rest);
      if (am && (YAML_KEY.test(rest.slice(am[0].length)) || isSeqLine(rest.slice(am[0].length)))) {
        anchor = am[1];
        rest = rest.slice(am[0].length);
        col += am[0].length;
      }
      if (rest === '') {
        i++;
        const j = next(i);
        if (j < L.length && L[j].indent > indent) { i = j; arr.push(node(L[j].indent)); } else arr.push(null);
        continue;
      }
      if (isSeqLine(rest) || YAML_KEY.test(rest)) {
        L[i] = { ...ln, indent: col, text: rest };
        const v = isSeqLine(rest) ? sequence(col) : mapping(col);
        if (anchor) anchors.set(anchor, v);
        arr.push(v);
        continue;
      }
      i++;
      arr.push(inlineValue(rest, indent));
    }
    return arr;
  };

  const node = (minIndent) => {
    i = next(i);
    if (i >= L.length || L[i].indent < minIndent) return null;
    const ln = L[i];
    if (isSeqLine(ln.text)) return sequence(ln.indent);
    if (YAML_KEY.test(ln.text)) return mapping(ln.indent);
    i++;
    return inlineValue(ln.text, ln.indent - 1);
  };
  return node(0);
}

/** Minimal YAML reader (block/flow collections, block scalars, anchors); one value per document. */
export function parseYaml(text) {
  const lines = String(text ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  const docs = [];
  let start = 0;
  for (let k = 0; k <= lines.length; k++) {
    if (k === lines.length || /^(?:---|\.\.\.)(?:\s|$)/.test(lines[k])) {
      const chunk = lines.slice(start, k);
      if (chunk.some((l) => stripYamlComment(l).trim())) {
        try { docs.push(yamlDocument(chunk)); } catch { docs.push(null); }
      }
      start = k + 1;
    }
  }
  return docs;
}

/**
 * Split a command line into segments (separated by && || ; | & and newlines) of unquoted
 * tokens. Quotes and backslashes follow POSIX sh; redirections are dropped.
 */
export function tokenizeShell(line) {
  const segments = [];
  let seg = [];
  let tok = null;
  const push = () => { if (tok !== null) { seg.push(tok); tok = null; } };
  const end = (op) => { push(); if (seg.length) segments.push({ tokens: seg, op }); seg = []; };
  const s = String(line ?? '').replace(/\r\n?/g, '\n');
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (c === '\\' && s[k + 1] === '\n') { k++; continue; }
    if (c === "'") {
      const e = s.indexOf("'", k + 1);
      tok = (tok ?? '') + (e === -1 ? s.slice(k + 1) : s.slice(k + 1, e));
      k = e === -1 ? s.length : e;
      continue;
    }
    if (c === '"') {
      let j = k + 1;
      let part = '';
      while (j < s.length && s[j] !== '"') {
        if (s[j] === '\\' && j + 1 < s.length && '"\\$`\n'.includes(s[j + 1])) { part += s[j + 1] === '\n' ? '' : s[j + 1]; j += 2; } else part += s[j++];
      }
      tok = (tok ?? '') + part;
      k = j;
      continue;
    }
    if (c === '\\') { tok = (tok ?? '') + (s[k + 1] ?? ''); k++; continue; }
    if (c === ' ' || c === '\t') { push(); continue; }
    if (c === '#' && tok === null) { while (k < s.length && s[k] !== '\n') k++; k--; continue; }
    if (c === '\n' || c === ';') { end(c === '\n' ? 'nl' : ';'); continue; }
    if (c === '(' && tok === null) { end('('); continue; }
    if (c === ')' && tok === null) { end(')'); continue; }
    if (c === ')') { push(); end(')'); continue; }
    if (c === '&' && s[k + 1] === '&') { end('&&'); k++; continue; }
    if (c === '|' && s[k + 1] === '|') { end('||'); k++; continue; }
    if (c === '|') { end('|'); continue; }
    if (c === '>' || c === '<') {
      if (tok !== null && /^\d+$/.test(tok)) tok = null;
      push();
      while (s[k + 1] === '>' || s[k + 1] === '&') k++;
      if (/\d/.test(s[k + 1] ?? '') && s[k] === '&') { while (/\d/.test(s[k + 1] ?? '')) k++; continue; }
      while (s[k + 1] === ' ' || s[k + 1] === '\t') k++;
      while (k + 1 < s.length && !/[\s;&|()]/.test(s[k + 1])) k++;
      continue;
    }
    if (c === '&') { end('&'); continue; }
    tok = (tok ?? '') + c;
  }
  end(null);
  return segments;
}

/** Quote an argument so the same text works in sh and cmd.exe; `portable` is false when it cannot. */
export function portableArg(arg) {
  const s = String(arg);
  if (s && /^[A-Za-z0-9_\-+=.,/:@]+$/.test(s)) return { text: s, portable: true };
  return { text: `"${s.replace(/"/g, '\\"')}"`, portable: !/["$`%!^\n]/.test(s) };
}

function joinArgs(args) {
  let portable = true;
  const text = args.map((a) => { const q = portableArg(a); if (!q.portable) portable = false; return q.text; }).join(' ');
  return { text, portable };
}

/** `name: recipe lines` for Makefile targets (or justfile recipes) whose name starts with "test". */
export function parseMakeTargets(text, { just = false } = {}) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const targets = [];
  for (let k = 0; k < lines.length; k++) {
    const line = lines[k];
    if (!line || /^\s/.test(line) || line.startsWith('#')) continue;
    let names;
    if (just) {
      const m = /^@?([A-Za-z_][A-Za-z0-9_-]*)(?:\s+[^:=]*?)?\s*:(?!=)/.exec(line);
      if (!m || /^(?:set|alias|export|import|mod)\b/.test(line)) continue;
      names = [m[1]];
    } else {
      const m = /^([^:=#\s][^:=#]*?)\s*::?(?!=)(.*)$/.exec(line);
      if (!m || /^\s*[A-Za-z_][\w.]*\s*[:+?!]?=/.test(line)) continue;
      names = m[1].split(/\s+/).filter((t) => t && !t.startsWith('.') && !t.includes('%') && !t.includes('$'));
    }
    const recipe = [];
    for (let j = k + 1; j < lines.length; j++) {
      const r = lines[j];
      if (just ? /^\s+\S/.test(r) : r.startsWith('\t')) recipe.push(r.trim().replace(/^[@+-]+\s*/, ''));
      else if (!r.trim() || r.trim().startsWith('#')) continue;
      else break;
    }
    for (const name of names) if (/^test/i.test(name) && !targets.some((t) => t.name === name)) targets.push({ name, recipe });
  }
  return targets;
}

const strings = (s) => [...String(s ?? '').matchAll(/(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g)].map((m) => m[2]);

/** Convert a micromatch/jest glob (extglobs, <rootDir>, leading ./) to the core glob dialect. */
export function normalizeGlob(glob) {
  let s = toPosix(String(glob ?? '').trim()).replace(/^<rootDir>\/?/, '').replace(/^\.\/+/, '');
  for (let k = 0; k < 4 && /[?+@*!]\([^()]*\)/.test(s); k++) {
    s = s.replace(/([?+@*!])\(([^()]*)\)/g, (_, op, body) => {
      const alts = body.split('|');
      if (op === '!') return '*';
      if (op === '?' || op === '*') return `{,${alts.join(',')}}`;
      return alts.length > 1 ? `{${alts.join(',')}}` : alts[0];
    });
  }
  if (!s) return null;
  if (s.endsWith('/')) return `${s}**`;
  const last = s.slice(s.lastIndexOf('/') + 1);
  if (!/[*?[{]/.test(s) && !last.includes('.')) return `${s}/**`;
  return s;
}

// ---------------------------------------------------------------------------
// Gather: list files, read every detection input, derive file-list facts.

function listRepoFiles(root) {
  let res = null;
  try {
    res = gitRaw(root, ['-c', 'core.quotePath=false', 'ls-files', '-z', '-c', '-o', '--exclude-standard'], { timeoutMs: 120_000 });
  } catch { res = null; }
  if (res && res.exit === 0) return { files: res.stdout.split('\0').filter(Boolean), source: 'git' };
  return { files: listFiles(root, { ignore: new Set([...SKIP_DIRS]), maxFiles: MAX_FILES, maxDepth: MAX_DEPTH }), source: 'walk' };
}

function relevantKind(rel) {
  const base = baseOf(rel);
  if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(rel) || /^\.azure-pipelines\/.+\.ya?ml$/.test(rel) || rel === '.circleci/config.yml') return 'content';
  if (/(?:^|\/)\.config\/nextest\.toml$/.test(rel) || /(?:^|\/)sorbet\/config$/.test(rel)) return 'content';
  if (/(?:^|\/)bin\/rails$/.test(rel)) return 'presence';
  if (CONTENT_NAMES.has(base) || CONTENT_RES.some((re) => re.test(base))) return 'content';
  if (PRESENCE_NAMES.has(base) || /\.(?:sln|slnx)$/.test(base)) return 'presence';
  return null;
}

function readHead(file, bytes) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString('utf8');
  } catch { return ''; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}

function excludedRel(rel, extraExcludes) {
  const segs = rel.split('/');
  for (let k = 0; k < segs.length - 1; k++) {
    if (SKIP_DIRS.has(segs[k]) && !(segs[k] === 'bin' && segs[k + 1] === 'rails')) return true;
  }
  return extraExcludes.some((x) => rel === x || rel.startsWith(`${x}/`));
}

function fileTags(sub) {
  const base = baseOf(sub);
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
  const tags = [];
  if (CODE_EXTS.has(ext)) tags.push(`ext:${ext}`);
  const segs = sub.split('/');
  const top = segs.length > 1 ? segs[0] : null;
  if (ext === 'py' && /^test_.*\.py$|_test\.py$/.test(base)) { tags.push('py-test', top ? `py-test-top:${top}` : 'py-test-root'); }
  if (base === '__init__.py' && segs.length === 2) tags.push(`py-pkg:${top}`);
  if (ext === 'go' && base.endsWith('_test.go')) tags.push('go-test');
  if (ext === 'rb' && base.endsWith('_spec.rb')) tags.push('rb-spec');
  if (ext === 'rb' && /_test\.rb$|^test_.*\.rb$/.test(base)) tags.push('rb-test');
  if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(base) || (segs.includes('__tests__') && CODE_EXTS.has(ext))) tags.push('js-test');
  if (/\.cy\.[cm]?[jt]sx?$/.test(base)) tags.push('cy-test');
  if (top && ['test', 'tests', 'spec', 'e2e', 'cypress', '__tests__'].includes(top)) tags.push(`dir:${top}`);
  if (sub.startsWith('src/test/')) tags.push('dir:src/test');
  return tags;
}

function gather(root, { stateInfo, env }) {
  const listing = listRepoFiles(root);
  const extra = [];
  if (stateInfo && stateInfo.rel) extra.push(stateInfo.rel);
  if (env.ADC_HOME) { const r = path.relative(root, path.resolve(env.ADC_HOME)); if (r && !r.startsWith('..') && !path.isAbsolute(r)) extra.push(toPosix(r)); }
  const files = listing.files.map(normRel).filter((f) => f && !excludedRel(f, extra) && f !== STATE_DIR_NAME && !f.startsWith(`${STATE_DIR_NAME}/`)).slice(0, MAX_FILES);
  const relevant = new Map();
  const oversize = [];
  for (const rel of files) {
    const kind = relevantKind(rel);
    if (!kind) continue;
    const full = path.join(root, ...rel.split('/'));
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    if (!st.isFile()) continue;
    if (kind === 'presence') {
      // yarn.lock's header tells Berry (`__metadata:`) from classic; nothing else is needed from lockfiles.
      relevant.set(rel, baseOf(rel) === 'yarn.lock' ? readHead(full, 512) : null);
      continue;
    }
    if (st.size > MAX_READ) { relevant.set(rel, null); oversize.push(rel); continue; }
    relevant.set(rel, readText(full, ''));
  }
  // Project candidates: manifests outside fixture folders, Makefiles/justfiles with test targets.
  const candidates = new Set(['.']);
  for (const [rel, text] of relevant) {
    if (inFixtureDir(rel)) continue;
    const base = baseOf(rel);
    if (MANIFEST_NAMES.has(base) || /\.(?:sln|slnx|csproj|fsproj|vbproj)$/.test(base)) candidates.add(dirOf(rel));
    else if (MAKE_NAMES.includes(base) && parseMakeTargets(text).length) candidates.add(dirOf(rel));
    else if (JUST_NAMES.includes(base) && parseMakeTargets(text, { just: true }).length) candidates.add(dirOf(rel));
  }
  const facts = new Map([...candidates].map((d) => [d, new Set()]));
  for (const rel of files) {
    if (inFixtureDir(rel)) continue;
    let d = dirOf(rel);
    while (!candidates.has(d)) d = d === '.' ? '.' : dirOf(d);
    for (const t of fileTags(subPath(rel, d))) facts.get(d).add(t);
  }
  return { root, listing: listing.source, fileCount: files.length, relevant, candidates, facts, oversize, probes: {} };
}

/** Does `rel` name a directory of the checkout? Recorded so a cache hit can re-check it. */
function dirExists(g, rel) {
  if (rel === '.') return true;
  if (!(rel in g.probes)) {
    let ok = false;
    try { ok = fs.statSync(path.join(g.root, ...rel.split('/'))).isDirectory(); } catch { ok = false; }
    g.probes[rel] = ok;
  }
  return g.probes[rel];
}

function inputDigest(g, platform) {
  const rel = [...g.relevant.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([p, t]) => [p, t == null ? null : sha256(t)]);
  const facts = [...g.facts.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([d, s]) => [d, [...s].sort()]);
  return sha256(JSON.stringify([DETECT_SCHEMA, skillVersion(), platform, rel, facts]));
}

// ---------------------------------------------------------------------------
// Derive context

function makeTools(whichFn, env) {
  const seen = {};
  const has = (name) => {
    if (!(name in seen)) seen[name] = Boolean(whichFn ? whichFn(name) : which(name, env));
    return seen[name];
  };
  return { has, seen };
}

function makeCtx(g, { platform, tools }) {
  const win = platform === 'win32';
  const byDir = new Map();
  for (const rel of g.relevant.keys()) { const d = dirOf(rel); if (!byDir.has(d)) byDir.set(d, []); byDir.get(d).push(rel); }
  for (const list of byDir.values()) list.sort();
  const ctx = {
    g, win, has: tools.has, warnings: [],
    inDir: (dir) => byDir.get(dir) || [],
    exists: (rel) => g.relevant.has(rel),
    read: (rel) => g.relevant.get(rel) ?? null,
    facts: (dir) => g.facts.get(dir) || new Set(),
    relevantIn: (dir, pred) => [...g.relevant.keys()].filter((r) => under(r, dir) && !inFixtureDir(r) && pred(r)),
    json(rel) {
      const t = ctx.read(rel);
      if (t == null) return null;
      try { return JSON.parse(t.replace(/^\uFEFF/, '')); } catch { ctx.warnings.push(`${rel}: invalid JSON; ignored`); return null; }
    },
    toml(rel) { const t = ctx.read(rel); return t == null ? null : parseToml(t); },
    ini(rel) { const t = ctx.read(rel); return t == null ? null : parseIni(t); },
    warn: (msg) => { if (!ctx.warnings.includes(msg)) ctx.warnings.push(msg); },
    envPrefix(envVars) {
      const entries = Object.entries(envVars || {});
      if (!entries.length) return '';
      return win ? entries.map(([k, v]) => `set "${k}=${v}" && `).join('') : `${entries.map(([k, v]) => `${k}=${portableArg(v).text}`).join(' ')} `;
    },
  };
  return ctx;
}

function newUnit(dir, ecosystem) {
  return { dir, ecosystem, languages: [], manifests: [], managers: [], runners: [], test_globs: [], typecheck: [], lint: [],
    coverage: [], test_script: null, workspace: null, delegates: false, warnings: [] };
}

function makeRunner(name, fields = {}) {
  const def = RUNNERS[name];
  const r = {
    name, kind: def.kind, ecosystem: def.ecosystem, cmd: def.cmd, report: clone(def.report), retries_off: clone(def.retries_off),
    count_parser: def.count_parser, source: null, ...fields,
  };
  if (fields.report) r.count_parser = fields.report.format || 'summary-text';
  return r;
}

// ---------------------------------------------------------------------------
// Node (package.json: npm, pnpm, yarn, bun; jest, vitest, mocha, playwright, cypress, node:test, bun test)

const NPM_PLACEHOLDER = /no test specified/;
const JS_RUNNER_BINS = new Set(['jest', 'vitest', 'mocha', 'playwright', 'cypress']);
const JEST_WRAPPERS = new Set(['react-scripts', 'craco', 'rescripts', 'react-app-rewired']);
const DELEGATE_BINS = new Set(['turbo', 'nx', 'lerna', 'wsrun', 'ultra', 'rush', 'moon']);
const NEUTRAL_BINS = new Set(['echo', 'exit', 'true', 'false', 'rimraf', 'rm', 'del', 'del-cli', 'mkdir', 'mkdirp', 'cp',
  'cpy', 'shx', 'tsc', 'vue-tsc', 'eslint', 'prettier', 'biome', 'cd', 'sleep', 'wait-on', 'node-gyp', 'husky',
  'printf', 'set', 'export', 'tsup', 'esbuild', 'webpack', 'vite', 'rollup', 'babel', 'swc', 'stylelint']);

const binName = (t) => baseOf(toPosix(String(t || ''))).replace(/\.(?:cmd|exe|bat|ps1|js|mjs|cjs)$/i, '');

function nodeManager(ctx, lockDir, pkg) {
  const has = (f) => ctx.exists(joinRel(lockDir, f));
  const pmField = typeof (pkg && pkg.packageManager) === 'string' ? pkg.packageManager : '';
  const declared = /^(npm|pnpm|yarn|bun)@/.exec(pmField);
  const found = [];
  if (has('pnpm-lock.yaml')) found.push(['pnpm', 'pnpm-lock.yaml']);
  if (has('bun.lock')) found.push(['bun', 'bun.lock']);
  else if (has('bun.lockb')) found.push(['bun', 'bun.lockb']);
  if (has('yarn.lock')) found.push(['yarn', 'yarn.lock']);
  if (has('package-lock.json')) found.push(['npm', 'package-lock.json']);
  else if (has('npm-shrinkwrap.json')) found.push(['npm', 'npm-shrinkwrap.json']);
  let pick = found[0] || null;
  if (found.length > 1) {
    const byField = declared && found.find(([n]) => n === declared[1]);
    if (byField) pick = byField;
    ctx.warn(`${lockDir === '.' ? 'repository root' : lockDir}: several lockfiles (${found.map(([, f]) => f).join(', ')}); using ${pick[1]}`);
  }
  const name = pick ? pick[0] : declared ? declared[1] : 'npm';
  const berry = name === 'yarn' && (has('.yarnrc.yml') || /^yarn@(?:[2-9]|\d{2,})/.test(pmField) || /^__metadata:/m.test(ctx.read(joinRel(lockDir, 'yarn.lock')) || ''));
  const lockfile = pick ? pick[1] : null;
  const install = !lockfile
    ? (name === 'npm' ? 'npm install --no-package-lock --no-audit --no-fund' : null)
    : { npm: 'npm ci', pnpm: 'pnpm install --frozen-lockfile', bun: 'bun install --frozen-lockfile',
      yarn: berry ? 'yarn install --immutable' : 'yarn install --frozen-lockfile' }[name];
  const exec = { npm: 'npx --no', pnpm: 'pnpm exec', yarn: 'yarn', bun: 'bunx --no-install' }[name];
  const runCmd = { npm: 'npm run', pnpm: 'pnpm run', yarn: 'yarn run', bun: 'bun run' }[name];
  const testCmd = { npm: 'npm test', pnpm: 'pnpm test', yarn: 'yarn test', bun: 'bun run test' }[name];
  const launcher = name === 'npm' ? 'npm' : name;
  return {
    entry: { name, lockfile, install, cwd: lockDir, frozen: Boolean(lockfile), ...(berry ? { variant: 'berry' } : {}), ecosystem: 'node' },
    exec, runCmd, testCmd, launcher, pnp: berry && (has('.pnp.cjs') || /nodeLinker:\s*["']?pnp/.test(ctx.read(joinRel(lockDir, '.yarnrc.yml')) || '')),
  };
}

function stripEnv(tokens) {
  const env = {};
  let crossEnv = false;
  let k = 0;
  for (; k < tokens.length; k++) {
    const t = tokens[k];
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(t);
    if (m) { env[m[1]] = m[2]; continue; }
    if (t === 'cross-env' || t === 'cross-env-shell') { crossEnv = true; continue; }
    if (t === 'env' && /^[A-Za-z_]\w*=/.test(tokens[k + 1] || '')) continue;
    if (binName(t) === 'dotenv') { const dd = tokens.indexOf('--', k); if (dd !== -1) { k = dd; continue; } }
    break;
  }
  return { env, crossEnv, rest: tokens.slice(k) };
}

function stripLaunchers(tokens) {
  let t = tokens.slice();
  let coverage = null;
  for (let guard = 0; guard < 6 && t.length; guard++) {
    const b = binName(t[0]);
    if (b === 'npx') {
      let k = 1;
      while (k < t.length && t[k].startsWith('-')) k += /^(?:-p|--package|-c|--call)$/.test(t[k]) ? 2 : 1;
      t = t.slice(k);
      continue;
    }
    if (b === 'pnpm' && (t[1] === 'exec' || t[1] === 'dlx')) { let k = 2; while (k < t.length && t[k].startsWith('-')) k++; t = t.slice(k); continue; }
    if (b === 'yarn' && t[1] === 'exec') { t = t.slice(2); continue; }
    if (b === 'bunx' || (b === 'bun' && t[1] === 'x')) { let k = b === 'bunx' ? 1 : 2; while (k < t.length && t[k].startsWith('-')) k++; t = t.slice(k); continue; }
    if (b === 'npm' && t[1] === 'exec') { const dd = t.indexOf('--'); t = dd === -1 ? t.slice(2) : t.slice(dd + 1); continue; }
    if (b === 'c8' || b === 'nyc') {
      coverage = b;
      let k = 1;
      while (k < t.length && t[k].startsWith('-')) {
        const opt = t[k];
        k++;
        if (!opt.includes('=') && k < t.length && !t[k].startsWith('-') && !isRunnerStart(t[k])) k++;
      }
      t = t.slice(k);
      continue;
    }
    break;
  }
  return { tokens: t, coverage };
}

const NODE_VALUED = /^(?:-r|--(?:import|require|loader|experimental-loader|env-file|conditions|test-concurrency|test-timeout|test-name-pattern|test-skip-pattern|test-shard))$/;

function isRunnerStart(tok) {
  const b = binName(tok);
  return JS_RUNNER_BINS.has(b) || JEST_WRAPPERS.has(b) || ['node', 'tsx', 'bun', 'npm', 'pnpm', 'yarn', 'npx'].includes(b);
}

/** Classify one script segment: a runner invocation, a script call, a workspace delegation, or neither. */
function classifySegment(tokens, scripts) {
  const { env, crossEnv, rest } = stripEnv(tokens);
  const { tokens: t, coverage } = stripLaunchers(rest);
  if (!t.length) return { kind: 'none' };
  const b = binName(t[0]);
  const args = t.slice(1);
  const base = { env, crossEnv, coverage };
  if (b === 'npm' || b === 'pnpm' || b === 'yarn' || b === 'bun') {
    const flags = args.filter((a) => a.startsWith('-'));
    const words = args.filter((a) => !a.startsWith('-'));
    const wsFlag = b === 'pnpm' ? flags.some((f) => /^(?:-r|--recursive|--filter(?:=.*)?|-F)$/.test(f)) || args.includes('--filter') || args.includes('-F')
      : b === 'npm' ? flags.some((f) => /^(?:--workspaces|-ws|--workspace(?:=.*)?|-w)$/.test(f))
        : b === 'yarn' ? words[0] === 'workspaces' || words[0] === 'workspace' : false;
    if (wsFlag) return { kind: 'delegate', via: `${b} ${args.join(' ')}`.trim() };
    if (b === 'bun' && words[0] === 'test') return { kind: 'runner', runner: 'bun', head: ['bun', 'test'], args: args.slice(args.indexOf('test') + 1), ...base };
    const w0 = words[0];
    if (['test', 't', 'tst'].includes(w0)) return { kind: 'script', name: 'test' };
    if (['run', 'run-script', 'rum', 'urn'].includes(w0) && words[1]) return { kind: 'script', name: words[1] };
    if ((b === 'pnpm' || b === 'yarn' || b === 'bun') && w0 && scripts && scripts[w0] != null) return { kind: 'script', name: w0 };
    // `yarn <bin>` and `pnpm <bin>` run a dependency's binary when no script has that name.
    if ((b === 'yarn' || b === 'pnpm') && w0 && !['install', 'add', 'i', 'exec', 'dlx'].includes(w0)) return classifySegment(args.slice(args.indexOf(w0)), scripts);
    return { kind: 'other', bin: b };
  }
  if (['run-s', 'run-p', 'npm-run-all', 'npm-run-all2'].includes(b)) {
    return { kind: 'scripts', patterns: args.filter((a) => !a.startsWith('-')) };
  }
  if (DELEGATE_BINS.has(b)) return { kind: 'delegate', via: `${b} ${args.join(' ')}`.trim() };
  if (b === 'jest' || b === 'vitest' || b === 'mocha') return { kind: 'runner', runner: b, head: [b], args, ...base };
  if (JEST_WRAPPERS.has(b) && args[0] === 'test') return { kind: 'runner', runner: 'jest', head: [b, 'test'], args: args.slice(1), ...base };
  if (b === 'playwright' && args[0] === 'test') return { kind: 'runner', runner: 'playwright', head: ['playwright', 'test'], args: args.slice(1), ...base };
  if (b === 'cypress' && args[0] === 'run') return { kind: 'runner', runner: 'cypress', head: ['cypress', 'run'], args: args.slice(1), ...base };
  if ((b === 'node' || b === 'tsx') && args.includes('--test')) {
    const at = args.indexOf('--test');
    const opts = [];
    const positionals = [];
    for (let k = 0; k < args.length; k++) {
      if (k === at) continue;
      const a = args[k];
      if (a.startsWith('-')) {
        opts.push(a);
        if (NODE_VALUED.test(a) && args[k + 1] != null) opts.push(args[++k]);
      } else positionals.push(a);
    }
    return { kind: 'runner', runner: 'node-test', head: [b], nodeOpts: opts, positionals, args: [], ...base };
  }
  // `node ./packages/jest-cli/bin/jest.js` (a runner started through its bin script).
  if (b === 'node') {
    const k = args.findIndex((a) => !a.startsWith('-'));
    const script = k === -1 ? null : binName(args[k]);
    if (script && (JS_RUNNER_BINS.has(script) || script === 'vitest.mjs')) {
      const runner = script.replace(/\.mjs$/, '');
      const rest = args.slice(k + 1);
      if (runner === 'playwright' && rest[0] !== 'test') return { kind: 'other', bin: b };
      if (runner === 'cypress' && rest[0] !== 'run') return { kind: 'other', bin: b };
      const sub = runner === 'playwright' || runner === 'cypress' ? 1 : 0;
      return { kind: 'runner', runner, head: ['node', ...args.slice(0, k + 1 + sub)], direct: true, args: rest.slice(sub), ...base };
    }
  }
  if (NEUTRAL_BINS.has(b)) return { kind: 'neutral', bin: b };
  return { kind: 'other', bin: b };
}

/** Follow a package.json script through nested script calls. */
function analyzeScript(name, scripts, seen = new Set(), depth = 0) {
  const out = { runners: [], delegates: [], unknown: [], chain: [name] };
  const text = scripts ? scripts[name] : null;
  if (typeof text !== 'string' || depth > SCRIPT_DEPTH || seen.has(name)) return out;
  if (name === 'test' && NPM_PLACEHOLDER.test(text)) return out;
  seen.add(name);
  for (const seg of tokenizeShell(text)) {
    const c = classifySegment(seg.tokens, scripts);
    if (c.kind === 'runner') out.runners.push({ ...c, via: name });
    else if (c.kind === 'delegate') out.delegates.push(c.via);
    else if (c.kind === 'other') out.unknown.push(c.bin);
    else if (c.kind === 'script' || c.kind === 'scripts') {
      const names = c.kind === 'script' ? [c.name]
        : Object.keys(scripts || {}).filter((s) => c.patterns.some((p) => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*?/g, '.*')}$`).test(s)));
      if (c.kind === 'script' && scripts[c.name] == null) { out.unknown.push(`script:${c.name}`); continue; }
      for (const nm of names) {
        const sub = analyzeScript(nm, scripts, seen, depth + 1);
        out.runners.push(...sub.runners);
        out.delegates.push(...sub.delegates);
        out.unknown.push(...sub.unknown);
        out.chain.push(...sub.chain);
      }
    }
  }
  return out;
}

// Mocha options that take a value (everything else that is not an option is a spec path).
const MOCHA_VALUED = new Set(['-r', '--require', '-t', '--timeout', '-s', '--slow', '-u', '--ui', '-R', '--reporter', '-O', '--reporter-option',
  '--reporter-options', '-g', '--grep', '-f', '--fgrep', '--file', '--ignore', '--exclude', '--extension', '--config', '--package', '-j', '--jobs',
  '--retries', '-n', '--node-option', '--loader', '--import', '--spec']);

function mochaSpecs(args) {
  const out = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === '--spec' && args[k + 1] != null) { out.push(args[++k]); continue; }
    if (a.startsWith('--spec=')) { out.push(a.slice(7)); continue; }
    if (a.startsWith('-')) { if (!a.includes('=') && MOCHA_VALUED.has(a)) k++; continue; }
    out.push(a);
  }
  return out;
}

// Arguments that would fight the report/retries flags or never terminate in a clean run.
const DROP_ARGS = {
  jest: { flags: ['--watch', '--watchAll', '--json', '--ci'], valued: ['--outputFile', '--reporters', '--testResultsProcessor', '-o'] },
  vitest: { flags: ['--watch', '-w', '--ui', '--open', '--run'], valued: ['--reporter', '--outputFile'] },
  mocha: { flags: ['--watch', '-w'], valued: ['--reporter', '-R', '--reporter-option', '--reporter-options', '-O'] },
  playwright: { flags: ['--ui', '--debug'], valued: ['--reporter'] },
  cypress: { flags: ['--headed', '--open'], valued: ['--reporter', '--reporter-options', '-r', '-o'] },
  'node-test': { flags: ['--watch'], valued: ['--test-reporter', '--test-reporter-destination'] },
  bun: { flags: ['--watch'], valued: ['--reporter', '--reporter-outfile'] },
};

function filterArgs(runner, args) {
  const spec = DROP_ARGS[runner] || { flags: [], valued: [] };
  const out = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    const nm = a.split('=')[0];
    const dotted = nm.split('.')[0];
    if (spec.flags.includes(nm)) continue;
    if (spec.valued.includes(nm) || spec.valued.includes(dotted)) { if (!a.includes('=') && args[k + 1] != null && !args[k + 1].startsWith('-')) k++; continue; }
    out.push(a);
  }
  if (runner === 'vitest' && ['run', 'watch', 'dev'].includes(out[0])) out.shift();
  return out;
}

function nodeRunnerFromOccurrence(ctx, pm, occ, dir, source, pkgDeps) {
  const name = occ.runner;
  const args = filterArgs(name, occ.args || []);
  let headTokens;
  let paths = null;
  if (name === 'node-test') {
    const opts = filterArgs('node-test', occ.nodeOpts || []);
    paths = occ.positionals || [];
    headTokens = occ.head[0] === 'tsx' ? [...pm.exec.split(' '), 'tsx', ...opts, '--test'] : ['node', ...opts, '--test'];
  } else if (name === 'bun') headTokens = ['bun', 'test'];
  else if (occ.direct) {
    headTokens = [...occ.head];
    if (name === 'jest') args.unshift('--ci');
  } else {
    headTokens = [...pm.exec.split(' '), ...occ.head];
    if (name === 'vitest') headTokens.push('run');
    if (name === 'jest') args.unshift('--ci');
    // react-scripts and friends watch by default unless told otherwise.
    if (name === 'jest' && JEST_WRAPPERS.has(occ.head[0])) args.push('--watchAll=false');
  }
  const env = occ.env || {};
  let envText = '';
  if (Object.keys(env).length && occ.crossEnv && pkgDeps.has('cross-env')) {
    envText = `${pm.exec} cross-env ${Object.entries(env).map(([k, v]) => `${k}=${portableArg(v).text}`).join(' ')} `;
    if (headTokens.slice(0, pm.exec.split(' ').length).join(' ') === pm.exec) headTokens = headTokens.slice(pm.exec.split(' ').length);
  } else envText = ctx.envPrefix(env);
  const head = joinArgs(headTokens.filter((x) => x !== ''));
  const rest = joinArgs([...args, ...(paths || [])]);
  const cmd = `${envText}${head.text}${rest.text ? ` ${rest.text}` : ''}`;
  const r = makeRunner(name, { cmd, source });
  if (name === 'mocha') { const specs = mochaSpecs(args); if (specs.length) r.specs = specs; }
  if (name === 'node-test') {
    // node treats options after the first file pattern as test arguments: insert flags before `paths`.
    r.base_cmd = `${envText}${head.text}`;
    r.paths = paths.map((p) => portableArg(p).text);
  }
  if (Object.keys(env).length) r.env = env;
  if (occ.coverage) r.coverage_wrapper = occ.coverage;
  if (!head.portable || !rest.portable) r.portable = false;
  return r;
}

function configGlobs(name, text, pkgSection) {
  if (name === 'jest') {
    if (pkgSection && Array.isArray(pkgSection.testMatch)) return pkgSection.testMatch;
    const m = /testMatch\s*:\s*\[([\s\S]*?)\]/.exec(text || '');
    return m ? strings(m[1]) : null;
  }
  if (name === 'vitest') {
    const at = (text || '').search(/\btest\s*:\s*\{/);
    if (at === -1) return null;
    const m = /\binclude\s*:\s*\[([\s\S]*?)\]/.exec(text.slice(at, at + 6000));
    return m ? strings(m[1]) : null;
  }
  if (name === 'playwright') {
    const out = [];
    const dir = /\btestDir\s*:\s*(['"`])([^'"`]+)\1/.exec(text || '');
    const tm = /\btestMatch\s*:\s*(?:\[([\s\S]*?)\]|(['"`])([^'"`]+)\2)/.exec(text || '');
    const base = dir ? normRel(dir[2]) : '';
    const matches = tm ? (tm[1] != null ? strings(tm[1]) : [tm[3]]) : null;
    if (matches && matches.length) for (const g of matches) out.push(base ? `${base}/${normRel(g)}` : g);
    else if (base) out.push(`${base}/**`);
    return out.length ? out : null;
  }
  if (name === 'cypress') {
    const m = /\bspecPattern\s*:\s*(?:\[([\s\S]*?)\]|(['"`])([^'"`]+)\2)/.exec(text || '');
    return m ? (m[1] != null ? strings(m[1]) : [m[3]]) : null;
  }
  if (name === 'mocha') {
    if (pkgSection && pkgSection.spec) return [].concat(pkgSection.spec);
    if (!text) return null;
    const t = text.trim();
    if (t.startsWith('{')) { try { const j = JSON.parse(t.replace(/^\s*\/\/.*$/gm, '')); return j.spec ? [].concat(j.spec) : null; } catch { /* fall through */ } }
    const y = parseYaml(t)[0];
    if (y && typeof y === 'object' && y.spec) return [].concat(y.spec);
    const m = /\bspec\s*:\s*(?:\[([\s\S]*?)\]|(['"`])([^'"`]+)\2)/.exec(t);
    return m ? (m[1] != null ? strings(m[1]) : [m[3]]) : null;
  }
  return null;
}

function nodeConfigFile(ctx, dir, runner) {
  const pats = {
    jest: /^jest\.config\.(?:[cm]?[jt]s|json)$/, vitest: /^(?:vitest\.config|vitest\.workspace|vitest\.projects)\.(?:[cm]?[jt]s|json)$/,
    playwright: /^playwright\.config\.[cm]?[jt]s$/, cypress: /^cypress\.config\.[cm]?[jt]s$/, mocha: /^\.mocharc\.(?:js|cjs|mjs|json|jsonc|ya?ml)$/,
  }[runner];
  if (!pats) return null;
  const hits = ctx.inDir(dir).filter((r) => pats.test(baseOf(r)));
  if (runner === 'vitest' && !hits.length) {
    const vite = ctx.inDir(dir).find((r) => /^vite\.config\.[cm]?[jt]s$/.test(baseOf(r)) && /\btest\s*:\s*\{/.test(ctx.read(r) || ''));
    if (vite) return vite;
  }
  return hits[0] || null;
}

function workspaceGlobs(ctx, dir, pkg) {
  const ws = pkg && pkg.workspaces;
  let globs = Array.isArray(ws) ? ws : ws && Array.isArray(ws.packages) ? ws.packages : null;
  let kind = globs ? 'package.json workspaces' : null;
  const pnpmWs = joinRel(dir, 'pnpm-workspace.yaml');
  if (ctx.exists(pnpmWs)) {
    const doc = parseYaml(ctx.read(pnpmWs) || '')[0];
    if (doc && Array.isArray(doc.packages)) { globs = doc.packages.map(String); kind = 'pnpm-workspace.yaml'; }
  }
  if (!globs) {
    const lerna = ctx.json(joinRel(dir, 'lerna.json'));
    if (lerna && Array.isArray(lerna.packages)) { globs = lerna.packages.map(String); kind = 'lerna.json'; }
  }
  return globs ? { globs, kind } : null;
}

// Workspace globs are anchored at the workspace root (a bare `app` means ./app, not any app/).
const anchoredMatch = (sub, glob) => matchGlob(`/${sub}`, `/${normRel(glob)}`);
const matchesWorkspace = (sub, globs) => {
  const inc = globs.filter((x) => !x.startsWith('!'));
  const exc = globs.filter((x) => x.startsWith('!')).map((x) => x.slice(1));
  return inc.some((x) => anchoredMatch(sub, x)) && !exc.some((x) => anchoredMatch(sub, x) || anchoredMatch(`${sub}/x`, x));
};

function detectNode(ctx) {
  const units = [];
  const pkgDirs = [...ctx.g.relevant.keys()].filter((r) => baseOf(r) === 'package.json' && !inFixtureDir(r)).map(dirOf).sort((a, b) => a.length - b.length || (a < b ? -1 : 1));
  const pkgs = new Map(pkgDirs.map((d) => [d, ctx.json(joinRel(d, 'package.json')) || {}]));
  const wsRoots = new Map();
  for (const d of pkgDirs) { const w = workspaceGlobs(ctx, d, pkgs.get(d)); if (w) wsRoots.set(d, w); }
  for (const dir of pkgDirs) {
    const pkg = pkgs.get(dir);
    let wsRoot = null;
    let skip = false;
    for (const [w, info] of wsRoots) {
      if (w === dir || !under(dir, w)) continue;
      if (matchesWorkspace(subPath(dir, w), info.globs)) { if (!wsRoot || w.length > wsRoot.length) wsRoot = w; } else if (!NODE_LOCKFILES.some((f) => ctx.exists(joinRel(dir, f)))) skip = true;
    }
    if (skip && !wsRoot) continue;
    const lockDir = wsRoot || dir;
    const pm = nodeManager(ctx, lockDir, wsRoot ? pkgs.get(wsRoot) : pkg);
    const u = newUnit(dir, 'node');
    u.manifests.push(joinRel(dir, 'package.json'));
    const tsconfig = ctx.exists(joinRel(dir, 'tsconfig.json'));
    const facts = ctx.facts(dir);
    u.languages.push(tsconfig || ['ts', 'tsx', 'mts', 'cts'].some((e) => facts.has(`ext:${e}`)) ? 'typescript' : 'javascript');
    u.managers.push({ ...pm.entry, ...(wsRoot ? { workspace: true } : {}) });
    if (!pm.entry.lockfile) u.warnings.push(`${joinRel(dir, 'package.json')}: no lockfile committed; the install is not frozen`);
    if (wsRoots.has(dir)) u.workspace = { kind: wsRoots.get(dir).kind, role: 'root', globs: wsRoots.get(dir).globs };
    else if (wsRoot) u.workspace = { kind: wsRoots.get(wsRoot).kind, role: 'member', root: wsRoot };
    const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
    const deps = new Set([...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.devDependencies || {}), ...Object.keys(pkg.optionalDependencies || {})]);
    const rootDeps = wsRoot ? new Set(Object.keys((pkgs.get(wsRoot) || {}).devDependencies || {})) : new Set();
    const allDeps = new Set([...deps, ...rootDeps]);
    const testScript = typeof scripts.test === 'string' && !NPM_PLACEHOLDER.test(scripts.test) ? scripts.test : null;
    u.test_script = testScript;
    const seenNames = new Set();
    if (testScript) {
      const a = analyzeScript('test', scripts);
      for (const occ of a.runners) {
        const src = occ.via === 'test' ? 'package.json scripts.test' : `package.json scripts.test -> scripts.${occ.via}`;
        if (seenNames.has(occ.runner)) continue;
        seenNames.add(occ.runner);
        u.runners.push(nodeRunnerFromOccurrence(ctx, pm, occ, dir, src, allDeps));
      }
      if (a.delegates.length && !a.runners.length) { u.delegates = true; u.delegates_via = uniq(a.delegates); }
      if (!a.runners.length && !a.delegates.length && a.unknown.length) {
        u.runners.push(makeRunner('npm-script', { cmd: pm.testCmd, source: 'package.json scripts.test', wraps: uniq(a.unknown).slice(0, 5) }));
      }
    }
    // Runners configured or installed but not named by the test script.
    for (const name of ['vitest', 'jest', 'mocha', 'playwright', 'cypress']) {
      if (seenNames.has(name)) continue;
      const cfg = nodeConfigFile(ctx, dir, name);
      const depName = { playwright: '@playwright/test', jest: 'jest', vitest: 'vitest', mocha: 'mocha', cypress: 'cypress' }[name];
      const inDeps = deps.has(depName) || (name === 'jest' && pkg.jest && typeof pkg.jest === 'object');
      if (u.delegates) {
        // A delegating workspace root only runs a suite its own config spreads over the members.
        if (!cfg || !/\b(?:projects|workspace)\s*:|vitest\.(?:workspace|projects)\./.test(`${cfg} ${ctx.read(cfg) || ''}`)) continue;
      } else if (!cfg && !inDeps) continue;
      seenNames.add(name);
      const head = { jest: ['jest'], vitest: ['vitest'], mocha: ['mocha'], playwright: ['playwright', 'test'], cypress: ['cypress', 'run'] }[name];
      u.runners.push(nodeRunnerFromOccurrence(ctx, pm, { runner: name, head, args: [], env: {} }, dir, cfg || `package.json ${deps.has(depName) ? 'devDependencies' : 'jest'}`, allDeps));
    }
    if (!u.runners.length && !u.delegates && pm.entry.name === 'bun' && facts.has('js-test')) {
      u.runners.push(makeRunner('bun', { cmd: 'bun test', source: `${pm.entry.lockfile} + test files` }));
    }
    // Test globs: the runner's config, else its defaults.
    for (const r of u.runners) {
      const cfg = r.name === 'node-test' ? null : nodeConfigFile(ctx, dir, r.name);
      let globs = r.name === 'node-test' && r.paths && r.paths.length ? r.paths.map((p) => normalizeGlob(p.replace(/^"|"$/g, '')))
        : r.name === 'mocha' && r.specs ? r.specs.map(normalizeGlob)
        : configGlobs(r.name, cfg ? ctx.read(cfg) : null, r.name === 'jest' ? pkg.jest : r.name === 'mocha' ? pkg.mocha : null);
      if (globs && globs.length) { r.config = cfg || undefined; globs = globs.map(normalizeGlob).filter(Boolean); }
      else globs = RUNNERS[r.name].test_globs;
      u.test_globs.push(...globs);
      if (!cfg) delete r.config;
      r.available = ctx.has(r.name === 'bun' ? 'bun' : r.name === 'node-test' && !/\b(?:tsx|cross-env)\b/.test(r.cmd) ? 'node' : pm.launcher);
    }
    // Coverage producers (CK-COVERAGE is skipped without one, §6.7).
    const names = new Set(u.runners.map((r) => r.name));
    if (names.has('vitest') && (allDeps.has('@vitest/coverage-v8') || allDeps.has('@vitest/coverage-istanbul'))) u.coverage.push({ name: 'vitest-coverage', format: 'istanbul', source: 'package.json devDependencies' });
    if (names.has('jest')) u.coverage.push({ name: 'jest-coverage', format: 'istanbul', source: 'built into jest' });
    if (names.has('node-test')) u.coverage.push({ name: 'node-test-coverage', format: 'lcov', source: 'built into node --test' });
    for (const c of ['c8', 'nyc']) if (allDeps.has(c)) u.coverage.push({ name: c, format: 'lcov', source: 'package.json devDependencies' });
    if (pm.pnp) u.warnings.push(`${joinRel(lockDir, '.yarnrc.yml')}: Yarn Plug'n'Play; commands run through \`yarn\``);
    // Type checking and linting.
    const tcScript = ['typecheck', 'type-check', 'check-types', 'types', 'tsc', 'check:types', 'types:check'].find((s) => typeof scripts[s] === 'string');
    if (tcScript) u.typecheck.push({ name: /vue-tsc/.test(scripts[tcScript]) ? 'vue-tsc' : 'tsc', cmd: `${pm.runCmd} ${tcScript}`, source: `package.json scripts.${tcScript}` });
    else if (tsconfig) u.typecheck.push({ name: 'tsc', cmd: `${pm.exec} tsc --noEmit`, config: joinRel(dir, 'tsconfig.json'), source: joinRel(dir, 'tsconfig.json') });
    const lintScript = ['lint', 'eslint', 'lint:js', 'lint:all'].find((s) => typeof scripts[s] === 'string');
    const eslintCfg = ctx.inDir(dir).find((r) => /^(?:eslint\.config\.[cm]?[jt]s|\.eslintrc(?:\.\w+)?)$/.test(baseOf(r)));
    const biomeCfg = ctx.inDir(dir).find((r) => /^biome\.jsonc?$/.test(baseOf(r)));
    if (lintScript) u.lint.push({ name: /biome/.test(scripts[lintScript]) ? 'biome' : 'eslint', cmd: `${pm.runCmd} ${lintScript}`, source: `package.json scripts.${lintScript}` });
    else if (eslintCfg || (pkg.eslintConfig && typeof pkg.eslintConfig === 'object')) {
      u.lint.push({ name: 'eslint', cmd: `${pm.exec} eslint .`, config: eslintCfg || joinRel(dir, 'package.json'), source: eslintCfg || 'package.json eslintConfig' });
    }
    else if (biomeCfg) u.lint.push({ name: 'biome', cmd: `${pm.exec} biome lint .`, config: biomeCfg, source: biomeCfg });
    if (!ctx.has(pm.launcher)) u.warnings.push(`${pm.launcher} is not on PATH (needed for ${pm.entry.install || pm.exec})`);
    units.push(u);
  }
  return units;
}

// ---------------------------------------------------------------------------
// Python (pyproject/setup/pytest/tox; uv, poetry, pdm, pipenv, pip; pytest, unittest)

const PY_MANIFESTS = ['pyproject.toml', 'setup.py', 'setup.cfg', 'Pipfile', 'pytest.ini', '.pytest.ini', 'pytest.toml', '.pytest.toml', 'tox.ini'];
const REQUIREMENTS_FILES = ['requirements.txt', 'requirements-dev.txt', 'requirements_dev.txt', 'requirements-test.txt',
  'dev-requirements.txt', 'test-requirements.txt'];
const normPkg = (n) => String(n || '').trim().toLowerCase().replace(/[-_.]+/g, '-');
const reqName = (s) => { const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(String(s || '')); return m ? normPkg(m[1]) : null; };

function pyDeps(ctx, dir, pyproject) {
  const out = new Set();
  const addList = (list) => { for (const x of [].concat(list || [])) { const n = typeof x === 'string' ? reqName(x) : null; if (n) out.add(n); } };
  const addTable = (t) => { if (t && typeof t === 'object' && !Array.isArray(t)) for (const k of Object.keys(t)) out.add(normPkg(k)); };
  if (pyproject) {
    const p = pyproject.project || {};
    addList(p.dependencies);
    for (const v of Object.values(p['optional-dependencies'] || {})) addList(v);
    for (const v of Object.values(pyproject['dependency-groups'] || {})) addList(v);
    const poetry = (pyproject.tool || {}).poetry || {};
    addTable(poetry.dependencies);
    addTable(poetry['dev-dependencies']);
    for (const g of Object.values(poetry.group || {})) addTable(g && g.dependencies);
    for (const v of Object.values(((pyproject.tool || {}).pdm || {})['dev-dependencies'] || {})) addList(v);
    addList(((pyproject.tool || {}).uv || {})['dev-dependencies']);
  }
  for (const r of ctx.inDir(dir).filter((x) => /^requirements(?:[-_.][\w.-]*)?\.txt$/.test(baseOf(x)))) {
    for (const line of (ctx.read(r) || '').split(/\r?\n/)) if (!/^\s*(?:#|-)/.test(line)) { const n = reqName(line); if (n) out.add(n); }
  }
  const pipfile = ctx.toml(joinRel(dir, 'Pipfile'));
  if (pipfile) { addTable(pipfile.packages); addTable(pipfile['dev-packages']); }
  const cfg = ctx.ini(joinRel(dir, 'setup.cfg'));
  if (cfg && cfg.options && cfg.options.install_requires) addList(cfg.options.install_requires.split('\n'));
  if (cfg && cfg['options.extras_require']) for (const v of Object.values(cfg['options.extras_require'])) addList(String(v).split('\n'));
  const tox = ctx.ini(joinRel(dir, 'tox.ini'));
  if (tox) for (const [sec, vals] of Object.entries(tox)) if (/^testenv/.test(sec) && vals.deps) addList(vals.deps.split('\n'));
  const setupPy = ctx.read(joinRel(dir, 'setup.py'));
  if (setupPy) for (const m of setupPy.matchAll(/['"]([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:[<>=!~;[][^'"]*)?['"]/g)) if (/^pytest/i.test(m[1])) out.add(normPkg(m[1]));
  return out;
}

/** pytest settings by pytest's own precedence (first file wins, never merged). */
function pytestConfig(ctx, dir, pyproject) {
  const words = (v) => [].concat(v || []).flatMap((x) => String(x).split(/\s+/)).filter(Boolean);
  const fromIni = (sec, file) => sec && ({ file, testpaths: words(sec.testpaths), python_files: words(sec.python_files), addopts: sec.addopts || null });
  const fromToml = (t, file) => t && ({ file, testpaths: words(t.testpaths), python_files: words(t.python_files), addopts: t.addopts ? [].concat(t.addopts).join(' ') : null });
  for (const f of ['pytest.toml', '.pytest.toml']) { const t = ctx.toml(joinRel(dir, f)); if (t) return fromToml(t.pytest || {}, joinRel(dir, f)); }
  for (const f of ['pytest.ini', '.pytest.ini']) { const t = ctx.ini(joinRel(dir, f)); if (t) return fromIni(t.pytest || {}, joinRel(dir, f)); }
  const tool = (pyproject && pyproject.tool) || {};
  if (tool.pytest && typeof tool.pytest === 'object') {
    if (tool.pytest.ini_options) return fromToml(tool.pytest.ini_options, `${joinRel(dir, 'pyproject.toml')} [tool.pytest.ini_options]`);
    return fromToml(tool.pytest, `${joinRel(dir, 'pyproject.toml')} [tool.pytest]`);
  }
  const tox = ctx.ini(joinRel(dir, 'tox.ini'));
  if (tox && tox.pytest) return fromIni(tox.pytest, `${joinRel(dir, 'tox.ini')} [pytest]`);
  const cfg = ctx.ini(joinRel(dir, 'setup.cfg'));
  if (cfg && cfg['tool:pytest']) return fromIni(cfg['tool:pytest'], `${joinRel(dir, 'setup.cfg')} [tool:pytest]`);
  return null;
}

function pythonLauncher(ctx) {
  if (ctx.win) return 'python';
  return !ctx.has('python') && ctx.has('python3') ? 'python3' : 'python';
}

function detectPython(ctx) {
  const units = [];
  const dirs = new Set([...ctx.g.relevant.keys()].filter((r) => PY_MANIFESTS.includes(baseOf(r)) && !inFixtureDir(r)).map(dirOf));
  const rootFacts = ctx.facts('.');
  if (!dirs.has('.') && (rootFacts.has('py-test') || ctx.exists('conftest.py') ||
    (ctx.inDir('.').some((r) => /^requirements(?:[-_.][\w.-]*)?\.txt$/.test(baseOf(r))) && rootFacts.has('ext:py')))) dirs.add('.');
  // uv workspaces: members share the root's lockfile and environment.
  const uvWs = new Map();
  for (const d of dirs) {
    const pp = ctx.toml(joinRel(d, 'pyproject.toml'));
    const ws = pp && pp.tool && pp.tool.uv && pp.tool.uv.workspace;
    if (ws && Array.isArray(ws.members)) uvWs.set(d, { members: ws.members.map(String), exclude: [].concat(ws.exclude || []).map(String) });
  }
  for (const dir of [...dirs].sort()) {
    const pyprojectFile = joinRel(dir, 'pyproject.toml');
    const pyproject = ctx.toml(pyprojectFile);
    const u = newUnit(dir, 'python');
    u.languages.push('python');
    for (const f of PY_MANIFESTS) if (ctx.exists(joinRel(dir, f))) u.manifests.push(joinRel(dir, f));
    let wsRoot = null;
    for (const [w, info] of uvWs) {
      if (w === dir || !under(dir, w)) continue;
      const sub = subPath(dir, w);
      if (info.members.some((m) => anchoredMatch(sub, m)) && !info.exclude.some((m) => anchoredMatch(sub, m))) wsRoot = w;
    }
    if (uvWs.has(dir)) u.workspace = { kind: 'uv workspace', role: 'root', globs: uvWs.get(dir).members };
    else if (wsRoot) u.workspace = { kind: 'uv workspace', role: 'member', root: wsRoot };
    const lockDir = wsRoot || dir;
    const tool = (pyproject && pyproject.tool) || {};
    let mgr = null;
    let prefix;
    const py = pythonLauncher(ctx);
    if (ctx.exists(joinRel(lockDir, 'uv.lock'))) {
      mgr = { name: 'uv', lockfile: 'uv.lock', install: uvWs.size && (wsRoot || uvWs.has(dir)) ? 'uv sync --locked --all-packages' : 'uv sync --locked', cwd: lockDir, frozen: true };
      prefix = 'uv run --frozen';
    } else if (ctx.exists(joinRel(dir, 'poetry.lock'))) {
      mgr = { name: 'poetry', lockfile: 'poetry.lock', install: 'poetry install --no-interaction', cwd: dir, frozen: true };
      prefix = 'poetry run';
    } else if (ctx.exists(joinRel(dir, 'pdm.lock'))) {
      mgr = { name: 'pdm', lockfile: 'pdm.lock', install: 'pdm install --frozen-lockfile', cwd: dir, frozen: true };
      prefix = 'pdm run';
    } else if (ctx.exists(joinRel(dir, 'Pipfile.lock'))) {
      mgr = { name: 'pipenv', lockfile: 'Pipfile.lock', install: 'pipenv install --deploy --dev', cwd: dir, frozen: true };
      prefix = 'pipenv run';
    } else {
      const req = REQUIREMENTS_FILES.map((f) => joinRel(dir, f)).find((f) => ctx.exists(f));
      if (req) {
        const hashed = /--hash=/.test(ctx.read(req) || '');
        mgr = { name: 'pip', lockfile: hashed ? baseOf(req) : null, install: hashed ? `${py} -m pip install --require-hashes -r ${baseOf(req)}` : null, cwd: dir, frozen: hashed };
        if (!hashed) mgr.install_hint = `${py} -m pip install -r ${baseOf(req)}`;
      } else if (tool.poetry) mgr = { name: 'poetry', lockfile: null, install: null, cwd: dir, frozen: false, install_hint: 'poetry install' };
      else if (tool.uv || ctx.exists(joinRel(dir, 'uv.toml'))) mgr = { name: 'uv', lockfile: null, install: null, cwd: dir, frozen: false, install_hint: 'uv sync' };
      prefix = mgr && mgr.name === 'poetry' && !mgr.lockfile ? 'poetry run' : mgr && mgr.name === 'uv' && !mgr.lockfile ? 'uv run' : null;
    }
    if (mgr) u.managers.push({ ...mgr, ...(wsRoot ? { workspace: true } : {}), ecosystem: 'python' });
    if (mgr && !mgr.frozen) u.warnings.push(`${joinRel(dir, mgr.name === 'pip' ? 'requirements.txt' : 'pyproject.toml')}: no lockfile with hashes; the install is not frozen`);
    const tool2 = (name) => (prefix ? `${prefix} ${name}` : `${py} -m ${name}`);
    const launcherTool = prefix ? prefix.split(' ')[0] : py;
    const deps = pyDeps(ctx, dir, pyproject);
    const cfg = pytestConfig(ctx, dir, pyproject);
    const facts = ctx.facts(dir);
    const conftest = ctx.relevantIn(dir, (r) => baseOf(r) === 'conftest.py').length > 0;
    const ciStep = (ctx.ci ? ctx.ci.steps : []).find((st) => st.cwd === dir && /\bpytest\b/.test(st.cmd));
    const pytestSignal = cfg || conftest || deps.has('pytest') || ciStep;
    const pyTests = facts.has('py-test');
    if (pytestSignal) {
      const r = makeRunner('pytest', { cmd: prefix ? `${prefix} pytest` : `${py} -m pytest`,
        source: cfg ? cfg.file : conftest ? 'conftest.py' : deps.has('pytest') ? 'pytest dependency' : `ci: ${ciStep.file}${ciStep.line ? `:${ciStep.line}` : ''}` });
      // A declared pytest-rerunfailures stays loaded (blocking it breaks its markers under --strict-markers);
      // --reruns=0 turns the CLI reruns off, but @pytest.mark.flaky(reruns=...) in test code still reruns.
      const rerun = deps.has('pytest-rerunfailures');
      const parts = [rerun ? '--reruns=0' : '-p no:rerunfailures', ...(deps.has('flaky') ? ['-p no:flaky'] : [])];
      r.retries_off = { mechanism: parts.join(' '), coverage: rerun ? 'partial' : 'full' };
      if (rerun) r.retries_note = '@pytest.mark.flaky(reruns=...) in test code overrides --reruns';
      if (cfg && cfg.addopts) r.addopts = cfg.addopts;
      r.available = ctx.has(launcherTool);
      u.runners.push(r);
      const files = cfg && cfg.python_files.length ? cfg.python_files : ['test_*.py', '*_test.py'];
      u.test_globs.push(...files.map((f) => normRel(f)), 'conftest.py');
      if (cfg && cfg.testpaths.length) u.test_globs.push(...cfg.testpaths.map((p) => normalizeGlob(p.endsWith('/') ? p : `${p}/`)));
      else u.test_globs.push('tests/**', ...(facts.has('dir:test') ? ['test/**'] : []));
    } else if (pyTests) {
      const tops = [...facts].filter((t) => t.startsWith('py-test-top:')).map((t) => t.slice(12));
      // Discovery from the root only descends into packages: a plain tests/ folder needs -s (the root
      // stays importable because `python -m` puts the working directory on sys.path).
      const startDir = tops.length === 1 && ['tests', 'test'].includes(tops[0]) && !facts.has('py-test-root') && !facts.has(`py-pkg:${tops[0]}`) ? tops[0] : null;
      const discover = startDir ? ` -s ${startDir}` : '';
      u.runners.push(makeRunner('unittest', { cmd: `${prefix ? `${prefix} python` : py} -m unittest discover${discover}`,
        source: 'test_*.py files (no pytest configuration or dependency)', available: ctx.has(launcherTool) }));
      u.test_globs.push(...RUNNERS.unittest.test_globs, ...(startDir ? [`${startDir}/**`] : []));
    }
    if (u.runners.length && (deps.has('pytest-cov') || deps.has('coverage'))) u.coverage.push({ name: deps.has('pytest-cov') ? 'pytest-cov' : 'coverage', format: 'cobertura', source: 'python dependency' });
    // Type checkers and linters.
    const mypyCfg = ['mypy.ini', '.mypy.ini'].map((f) => joinRel(dir, f)).find((f) => ctx.exists(f)) || (tool.mypy ? pyprojectFile : null) ||
      ((ctx.ini(joinRel(dir, 'setup.cfg')) || {}).mypy ? joinRel(dir, 'setup.cfg') : null);
    if (mypyCfg) {
      const filesSet = mypyCfg.endsWith('.toml') ? Boolean(tool.mypy && tool.mypy.files) : /^\s*files\s*=/m.test(ctx.read(mypyCfg) || '');
      u.typecheck.push({ name: 'mypy', cmd: `${tool2('mypy')}${filesSet ? '' : ' .'}`, config: mypyCfg, source: mypyCfg });
    }
    const pyrightCfg = ctx.exists(joinRel(dir, 'pyrightconfig.json')) ? joinRel(dir, 'pyrightconfig.json') : tool.pyright ? pyprojectFile : null;
    if (pyrightCfg) u.typecheck.push({ name: 'pyright', cmd: prefix ? `${prefix} pyright` : 'pyright', config: pyrightCfg, source: pyrightCfg });
    const ruffCfg = ['ruff.toml', '.ruff.toml'].map((f) => joinRel(dir, f)).find((f) => ctx.exists(f)) || (tool.ruff ? pyprojectFile : null);
    if (ruffCfg) u.lint.push({ name: 'ruff', cmd: `${tool2('ruff')} check .`, config: ruffCfg, source: ruffCfg });
    const flake8Cfg = ctx.exists(joinRel(dir, '.flake8')) ? joinRel(dir, '.flake8')
      : ((ctx.ini(joinRel(dir, 'setup.cfg')) || {}).flake8 ? joinRel(dir, 'setup.cfg') : (ctx.ini(joinRel(dir, 'tox.ini')) || {}).flake8 ? joinRel(dir, 'tox.ini') : null);
    if (flake8Cfg) u.lint.push({ name: 'flake8', cmd: tool2('flake8'), config: flake8Cfg, source: flake8Cfg });
    if (prefix && !ctx.has(launcherTool)) u.warnings.push(`${launcherTool} is not on PATH (needed for ${(mgr && mgr.install) || prefix})`);
    units.push(u);
  }
  return units;
}

// ---------------------------------------------------------------------------
// Go, Rust

function detectGo(ctx) {
  const units = [];
  const mods = [...ctx.g.relevant.keys()].filter((r) => baseOf(r) === 'go.mod' && !inFixtureDir(r)).map(dirOf).sort();
  const work = [...ctx.g.relevant.keys()].filter((r) => baseOf(r) === 'go.work' && !inFixtureDir(r)).map(dirOf);
  for (const dir of mods) {
    const u = newUnit(dir, 'go');
    u.languages.push('go');
    u.manifests.push(joinRel(dir, 'go.mod'));
    const mod = /^module\s+(\S+)/m.exec(ctx.read(joinRel(dir, 'go.mod')) || '');
    if (mod) u.module = mod[1];
    const w = work.filter((x) => under(dir, x)).sort((a, b) => b.length - a.length)[0];
    if (w != null) u.workspace = { kind: 'go.work', role: w === dir ? 'root' : 'member', root: w };
    u.managers.push({ name: 'go', lockfile: ctx.exists(joinRel(dir, 'go.sum')) ? 'go.sum' : null, install: 'go mod download',
      lock_check: 'go mod tidy -diff', cwd: dir, frozen: true, ecosystem: 'go' });
    u.runners.push(makeRunner('go', { source: joinRel(dir, 'go.mod'), available: ctx.has('go') }));
    u.test_globs.push(...RUNNERS.go.test_globs);
    u.typecheck.push({ name: 'go-vet', cmd: 'go vet ./...', source: joinRel(dir, 'go.mod') });
    u.coverage.push({ name: 'go-cover', format: 'go-cover', source: 'built into go test' });
    const golangci = [...ctx.inDir(dir), ...ctx.inDir('.')].find((r) => /^\.golangci\./.test(baseOf(r)));
    if (golangci) u.lint.push({ name: 'golangci-lint', cmd: 'golangci-lint run', config: golangci, source: golangci });
    if (!ctx.has('go')) u.warnings.push('go is not on PATH');
    units.push(u);
  }
  return units;
}

function nextestJunitProfile(text) {
  const t = parseToml(text || '');
  const profiles = (t && t.profile) || {};
  const names = Object.keys(profiles).filter((p) => profiles[p] && profiles[p].junit && profiles[p].junit.path);
  const pick = names.includes('ci') ? 'ci' : names[0];
  return pick ? { profile: pick, path: String(profiles[pick].junit.path) } : null;
}

function detectRust(ctx) {
  const units = [];
  const crates = [...ctx.g.relevant.keys()].filter((r) => baseOf(r) === 'Cargo.toml' && !inFixtureDir(r)).map(dirOf).sort((a, b) => a.length - b.length);
  const parsed = new Map(crates.map((d) => [d, ctx.toml(joinRel(d, 'Cargo.toml')) || {}]));
  const workspaces = crates.filter((d) => parsed.get(d).workspace);
  for (const dir of crates) {
    const owner = workspaces.filter((w) => w !== dir && under(dir, w)).sort((a, b) => b.length - a.length)[0];
    if (owner != null) {
      const ex = [].concat(parsed.get(owner).workspace.exclude || []).map((x) => normRel(String(x)));
      if (!ex.some((x) => under(subPath(dir, owner), x) || anchoredMatch(subPath(dir, owner), x))) continue;
    }
    const isWs = Boolean(parsed.get(dir).workspace);
    const u = newUnit(dir, 'rust');
    u.languages.push('rust');
    u.manifests.push(joinRel(dir, 'Cargo.toml'));
    if (isWs) u.workspace = { kind: 'cargo workspace', role: 'root', globs: [].concat(parsed.get(dir).workspace.members || []).map(String) };
    const ws = isWs ? ' --workspace' : '';
    const locked = ctx.exists(joinRel(dir, 'Cargo.lock'));
    u.managers.push({ name: 'cargo', lockfile: locked ? 'Cargo.lock' : null, install: locked ? 'cargo fetch --locked' : 'cargo fetch', cwd: dir, frozen: locked, ecosystem: 'rust' });
    if (!locked) u.warnings.push(`${joinRel(dir, 'Cargo.toml')}: no Cargo.lock committed; the fetch is not frozen`);
    const cargo = makeRunner('cargo', { cmd: `cargo test${ws} --no-fail-fast`, source: joinRel(dir, 'Cargo.toml'), available: ctx.has('cargo') });
    const cfgFile = joinRel(dir, '.config/nextest.toml');
    const configured = ctx.exists(cfgFile);
    const installed = ctx.has('cargo-nextest');
    let nextest = null;
    if (configured || installed) {
      nextest = makeRunner('nextest', { cmd: `cargo nextest run${ws} --no-fail-fast`, source: configured ? cfgFile : 'cargo-nextest on PATH', available: installed });
      const junit = configured ? nextestJunitProfile(ctx.read(cfgFile)) : null;
      if (junit) nextest.report = { flag: `--profile ${junit.profile}`, path: `target/nextest/${junit.profile}/${normRel(junit.path)}`, format: 'junit' };
      if (configured) nextest.config = cfgFile;
    }
    // The configured runner first, but only where it can run; plain cargo test is the fallback.
    if (nextest && installed) u.runners.push(nextest, cargo);
    else { u.runners.push(cargo); if (nextest) { u.runners.push(nextest); u.warnings.push(`${cfgFile} configures cargo-nextest, which is not installed; using cargo test`); } }
    u.test_globs.push('tests/**', ...(isWs ? ['**/tests/**'] : []));
    u.typecheck.push({ name: 'cargo-check', cmd: `cargo check --all-targets${ws}`, source: joinRel(dir, 'Cargo.toml') });
    if (ctx.has('cargo-llvm-cov')) u.coverage.push({ name: 'cargo-llvm-cov', format: 'lcov', source: 'cargo-llvm-cov on PATH' });
    const clippy = ['clippy.toml', '.clippy.toml'].map((f) => joinRel(dir, f)).find((f) => ctx.exists(f));
    if (clippy) u.lint.push({ name: 'clippy', cmd: `cargo clippy --all-targets${ws}`, config: clippy, source: clippy });
    units.push(u);
  }
  return units;
}

// ---------------------------------------------------------------------------
// .NET, JVM, Ruby

const TEST_SDK_PACKAGES = /^(?:Microsoft\.NET\.Test\.Sdk|xunit(?:\.v3)?|xunit\.runner\.visualstudio|nunit|NUnit3TestAdapter|MSTest(?:\.TestFramework|\.TestAdapter)?|TUnit(?:\.Engine)?|Expecto)$/i;

function csprojInfo(text, file) {
  const pkgs = [...String(text || '').matchAll(/<PackageReference\b[^>]*\b(?:Include|Update)\s*=\s*"([^"]+)"/gi)].map((m) => m[1]);
  const sdk = /<Project\b[^>]*\bSdk\s*=\s*"([^"]+)"/i.exec(text || '');
  const isTest = /<IsTestProject>\s*true\s*</i.test(text || '') || pkgs.some((p) => TEST_SDK_PACKAGES.test(p)) || (sdk && /MSTest\.Sdk/i.test(sdk[1])) ||
    /[.]?Tests?\.(?:cs|fs|vb)proj$/i.test(baseOf(file));
  return {
    file, isTest, pkgs,
    retryExt: pkgs.some((p) => /^Microsoft\.Testing\.Extensions\.Retry$/i.test(p)),
    trxExt: pkgs.some((p) => /^Microsoft\.Testing\.Extensions\.TrxReport$/i.test(p) || /^MSTest$/i.test(p)) || Boolean(sdk && /MSTest\.Sdk/i.test(sdk[1])),
    lang: file.endsWith('.fsproj') ? 'fsharp' : file.endsWith('.vbproj') ? 'vb' : 'csharp',
  };
}

function detectDotnet(ctx) {
  const units = [];
  const keys = [...ctx.g.relevant.keys()].filter((r) => !inFixtureDir(r));
  const slns = keys.filter((r) => /\.(?:sln|slnx)$/.test(r));
  const projs = keys.filter((r) => /\.(?:csproj|fsproj|vbproj)$/.test(r)).map((f) => csprojInfo(ctx.read(f), f));
  const slnDirs = uniq(slns.map(dirOf)).sort((a, b) => b.length - a.length);
  const groups = new Map();
  for (const d of slnDirs) groups.set(d, { dir: d, target: slns.filter((s) => dirOf(s) === d).sort()[0], projs: [] });
  for (const p of projs) {
    const owner = slnDirs.find((d) => under(p.file, d));
    if (owner != null) groups.get(owner).projs.push(p);
    else if (p.isTest) {
      const d = dirOf(p.file);
      if (!groups.has(d)) groups.set(d, { dir: d, target: projs.filter((x) => dirOf(x.file) === d).length > 1 ? p.file : null, projs: [] });
      groups.get(d).projs.push(p);
    }
  }
  const globalJson = (dir) => {
    for (let d = dir; ; d = dirOf(d)) { const j = ctx.json(joinRel(d, 'global.json')); if (j) return j; if (d === '.') return null; }
  };
  for (const grp of [...groups.values()].sort((a, b) => (a.dir < b.dir ? -1 : 1))) {
    const tests = grp.projs.filter((p) => p.isTest);
    const u = newUnit(grp.dir, 'dotnet');
    u.languages.push(...uniq(grp.projs.map((p) => p.lang)));
    u.manifests.push(...(grp.target ? [grp.target] : []), ...grp.projs.map((p) => p.file));
    const target = grp.target ? baseOf(grp.target) : null;
    const tArg = target ? ` ${portableArg(target).text}` : '';
    const locked = grp.projs.some((p) => ctx.exists(joinRel(dirOf(p.file), 'packages.lock.json')));
    u.managers.push({ name: 'nuget', lockfile: locked ? 'packages.lock.json' : null, install: `dotnet restore${tArg}${locked ? ' --locked-mode' : ''}`,
      cwd: grp.dir, frozen: locked, ecosystem: 'dotnet' });
    if (tests.length) {
      const gj = globalJson(grp.dir);
      const mtp = Boolean(gj && gj.test && /Microsoft\.Testing\.Platform/i.test(String(gj.test.runner || '')));
      const r = makeRunner('dotnet', { source: grp.target || tests[0].file, available: ctx.has('dotnet') });
      if (mtp) {
        const sel = target ? (/\.(?:sln|slnx)$/.test(target) ? ` --solution ${portableArg(target).text}` : ` --project ${portableArg(target).text}`) : '';
        r.cmd = `dotnet test${sel}`;
        r.platform = 'mtp';
        r.report = tests.every((p) => p.trxExt) ? { flag: '--report-trx --results-directory <d>', dir: '<d>', glob: '*.trx', format: 'trx' } : clone(SUMMARY_REPORT);
        r.count_parser = r.report.format;
        r.retries_off = { mechanism: 'Microsoft.Testing.Platform retries only with --retry-failed-tests, which is never passed', coverage: 'full' };
      } else {
        r.cmd = `dotnet test${tArg}`;
        r.platform = 'vstest';
      }
      u.runners.push(r);
      u.test_globs.push(...uniq(tests.map((p) => subPath(dirOf(p.file), grp.dir)).filter((d) => d && d !== '.').map((d) => `${d}/**`)), '**/*Tests*/**');
      const cov = tests.flatMap((p) => p.pkgs).find((x) => /^(?:coverlet\.collector|coverlet\.msbuild|Microsoft\.Testing\.Extensions\.CodeCoverage)$/i.test(x));
      if (cov) u.coverage.push({ name: cov.toLowerCase(), format: 'cobertura', source: 'PackageReference' });
    }
    u.typecheck.push({ name: 'dotnet-build', cmd: `dotnet build${tArg} --nologo`, source: grp.target || (grp.projs[0] && grp.projs[0].file) || grp.dir });
    if (!ctx.has('dotnet')) u.warnings.push('dotnet is not on PATH');
    units.push(u);
  }
  return units;
}

function detectJvm(ctx) {
  const units = [];
  const keys = [...ctx.g.relevant.keys()].filter((r) => !inFixtureDir(r));
  const poms = keys.filter((r) => baseOf(r) === 'pom.xml').map(dirOf).sort((a, b) => a.length - b.length);
  const settings = keys.filter((r) => /^settings\.gradle(?:\.kts)?$/.test(baseOf(r))).map(dirOf);
  const builds = keys.filter((r) => /^build\.gradle(?:\.kts)?$/.test(baseOf(r))).map(dirOf);
  const modulesOf = (dir) => [...String(/<modules>([\s\S]*?)<\/modules>/.exec(ctx.read(joinRel(dir, 'pom.xml')) || '')?.[1] || '')
    .matchAll(/<module>\s*([^<]+?)\s*<\/module>/g)].map((m) => normRel(m[1]));
  const lang = (dir, texts) => {
    const f = ctx.facts(dir);
    const out = [];
    if (f.has('ext:java') || !['kt', 'kts', 'scala', 'groovy'].some((e) => f.has(`ext:${e}`))) out.push('java');
    if (f.has('ext:kt') || /org\.jetbrains\.kotlin|kotlin\(/.test(texts)) out.push('kotlin');
    if (f.has('ext:scala')) out.push('scala');
    if (f.has('ext:groovy')) out.push('groovy');
    return uniq(out);
  };
  const wrapper = (dir, nix, winName) => (ctx.exists(joinRel(dir, ctx.win ? winName : nix)) || ctx.exists(joinRel(dir, nix)));
  // Maven: a pom listed as a module of an ancestor pom belongs to that reactor.
  const aggregated = new Set();
  for (const d of poms) for (const m of modulesOf(d)) aggregated.add(joinRel(d, m));
  for (const dir of poms) {
    if (aggregated.has(dir)) continue;
    const u = newUnit(dir, 'jvm');
    const text = ctx.read(joinRel(dir, 'pom.xml')) || '';
    u.languages.push(...lang(dir, text));
    u.manifests.push(joinRel(dir, 'pom.xml'));
    const mvnw = wrapper(dir, 'mvnw', 'mvnw.cmd');
    const mvn = mvnw ? (ctx.win ? 'mvnw.cmd' : './mvnw') : 'mvn';
    u.managers.push({ name: 'maven', lockfile: null, install: null, offline_flag: '-o', cwd: dir, frozen: false, ecosystem: 'jvm' });
    const modules = modulesOf(dir);
    const facts = ctx.facts(dir);
    const hasTests = facts.has('dir:src/test') || modules.length > 0 || /<artifactId>\s*(?:junit|junit-jupiter[\w-]*|testng)\s*</.test(text);
    if (hasTests) {
      const r = makeRunner('maven', { cmd: `${mvn} -B test`, source: joinRel(dir, 'pom.xml'), available: mvnw || ctx.has('mvn') });
      if (modules.length) r.report.dirs = modules.map((m) => `${m}/target/surefire-reports`);
      u.runners.push(r);
      u.test_globs.push('src/test/**', ...(modules.length ? ['**/src/test/**'] : []));
    }
    u.typecheck.push({ name: 'maven-compile', cmd: `${mvn} -B -q test-compile`, source: joinRel(dir, 'pom.xml') });
    if (/jacoco-maven-plugin/.test(text)) u.coverage.push({ name: 'jacoco', format: 'jacoco', source: joinRel(dir, 'pom.xml') });
    if (!mvnw && !ctx.has('mvn')) u.warnings.push('mvn is not on PATH and the project has no Maven wrapper');
    units.push(u);
  }
  // Gradle: a settings file roots a (multi-)project build; build files below it are subprojects.
  const gradleRoots = uniq([...settings, ...builds.filter((b) => !settings.some((s) => under(b, s)))]).sort();
  for (const dir of gradleRoots) {
    const u = newUnit(dir, 'jvm');
    const files = ['settings.gradle', 'settings.gradle.kts', 'build.gradle', 'build.gradle.kts'].map((f) => joinRel(dir, f)).filter((f) => ctx.exists(f));
    const buildTexts = keys.filter((r) => /^build\.gradle(?:\.kts)?$/.test(baseOf(r)) && under(r, dir)).map((r) => ctx.read(r) || '').join('\n');
    u.languages.push(...lang(dir, buildTexts));
    u.manifests.push(...files);
    const gw = wrapper(dir, 'gradlew', 'gradlew.bat');
    const gradle = gw ? (ctx.win ? 'gradlew.bat' : './gradlew') : 'gradle';
    u.managers.push({ name: 'gradle', lockfile: ctx.exists(joinRel(dir, 'gradle.lockfile')) ? 'gradle.lockfile' : null, install: null,
      offline_flag: '--offline', cwd: dir, frozen: false, ecosystem: 'jvm' });
    const settingsText = files.filter((f) => /settings\.gradle/.test(f)).map((f) => ctx.read(f) || '').join('\n');
    const subprojects = uniq([...settingsText.matchAll(/\binclude\s*\(?([^)\n]+)\)?/g)].flatMap((m) => [...m[1].matchAll(/['"]:?([^'"]+)['"]/g)].map((x) => x[1].replace(/:/g, '/'))));
    const facts = ctx.facts(dir);
    const caching = /^\s*org\.gradle\.caching\s*=\s*true\s*$/m.test(ctx.read(joinRel(dir, 'gradle.properties')) || '');
    if (facts.has('dir:src/test') || subprojects.length || /\btest(?:Implementation|RuntimeOnly)\b|useJUnitPlatform|junit/.test(buildTexts)) {
      // Cached test outputs would be counts without execution; the build cache is bypassed.
      const r = makeRunner('gradle', { cmd: `${gradle} test${caching ? ' --no-build-cache' : ''}`, source: files[0], available: gw || ctx.has('gradle') });
      if (subprojects.length) r.report.dirs = subprojects.map((s) => `${s}/build/test-results/test`);
      if (/org\.gradle\.test-retry|test-retry/.test(buildTexts)) r.retries_off = { mechanism: 'the org.gradle.test-retry plugin is configured in the build script', coverage: 'partial' };
      u.runners.push(r);
      u.test_globs.push('src/test/**', ...(subprojects.length ? ['**/src/test/**'] : []));
    }
    u.typecheck.push({ name: 'gradle-compile', cmd: `${gradle} testClasses`, source: files[0] });
    if (/\bjacoco\b/.test(buildTexts)) u.coverage.push({ name: 'jacoco', format: 'jacoco', source: files[0] });
    if (!gw && !ctx.has('gradle')) u.warnings.push('gradle is not on PATH and the project has no Gradle wrapper');
    units.push(u);
  }
  return units;
}

function detectRuby(ctx) {
  const units = [];
  const dirs = [...ctx.g.relevant.keys()].filter((r) => baseOf(r) === 'Gemfile' && !inFixtureDir(r)).map(dirOf).sort();
  for (const dir of dirs) {
    const u = newUnit(dir, 'ruby');
    u.languages.push('ruby');
    u.manifests.push(joinRel(dir, 'Gemfile'));
    const gems = new Set([...(ctx.read(joinRel(dir, 'Gemfile')) || '').matchAll(/^\s*gem\s+['"]([^'"]+)['"]/gm)].map((m) => m[1].toLowerCase()));
    const locked = ctx.exists(joinRel(dir, 'Gemfile.lock'));
    // Bundler 4 removed `install --frozen`; the local config setting is the supported switch.
    u.managers.push({ name: 'bundler', lockfile: locked ? 'Gemfile.lock' : null,
      install: locked ? 'bundle config set --local frozen true && bundle install' : 'bundle install', cwd: dir, frozen: locked, ecosystem: 'ruby' });
    const facts = ctx.facts(dir);
    const rails = gems.has('rails') || ctx.exists(joinRel(dir, 'bin/rails'));
    if (ctx.exists(joinRel(dir, '.rspec')) || gems.has('rspec') || gems.has('rspec-rails') || gems.has('rspec-core') || facts.has('rb-spec')) {
      const r = makeRunner('rspec', { source: ctx.exists(joinRel(dir, '.rspec')) ? joinRel(dir, '.rspec') : joinRel(dir, 'Gemfile'), available: ctx.has('bundle') });
      if (gems.has('rspec-retry')) r.retries_off = { mechanism: 'rspec-retry is configured in test code', coverage: 'partial' };
      u.runners.push(r);
      u.test_globs.push('spec/**');
    }
    if (gems.has('minitest') || facts.has('rb-test') || (rails && facts.has('dir:test'))) {
      const cmd = rails ? 'bundle exec rails test' : ctx.exists(joinRel(dir, 'Rakefile')) ? 'bundle exec rake test' : null;
      if (cmd) {
        const r = makeRunner('minitest', { cmd, source: rails ? 'rails' : joinRel(dir, 'Rakefile'), available: ctx.has('bundle') });
        if (gems.has('minitest-retry')) r.retries_off = { mechanism: 'minitest-retry is configured in test code', coverage: 'partial' };
        u.runners.push(r);
        u.test_globs.push('test/**');
      } else u.warnings.push(`${joinRel(dir, 'Gemfile')}: Minitest files but no Rakefile test task; give the test command`);
    }
    if (gems.has('simplecov')) u.coverage.push({ name: 'simplecov', format: 'simplecov', source: joinRel(dir, 'Gemfile') });
    if (ctx.exists(joinRel(dir, 'sorbet/config'))) u.typecheck.push({ name: 'sorbet', cmd: 'bundle exec srb tc', config: joinRel(dir, 'sorbet/config'), source: joinRel(dir, 'sorbet/config') });
    else if (ctx.exists(joinRel(dir, 'Steepfile'))) u.typecheck.push({ name: 'steep', cmd: 'bundle exec steep check', config: joinRel(dir, 'Steepfile'), source: joinRel(dir, 'Steepfile') });
    if (ctx.exists(joinRel(dir, '.rubocop.yml')) || gems.has('rubocop')) {
      u.lint.push({ name: 'rubocop', cmd: 'bundle exec rubocop', source: ctx.exists(joinRel(dir, '.rubocop.yml')) ? joinRel(dir, '.rubocop.yml') : joinRel(dir, 'Gemfile') });
    }
    if (!ctx.has('bundle')) u.warnings.push('bundle is not on PATH');
    units.push(u);
  }
  return units;
}

// ---------------------------------------------------------------------------
// Makefile / justfile test targets

const TARGET_PRIORITY = ['test', 'tests', 'test-all', 'test_all', 'testall', 'test-unit', 'test_unit', 'unit-test'];

function detectMake(ctx) {
  const units = [];
  for (const [names, tool, just] of [[MAKE_NAMES, 'make', false], [JUST_NAMES, 'just', true]]) {
    const files = [...ctx.g.relevant.keys()].filter((r) => names.includes(baseOf(r)) && !inFixtureDir(r)).sort();
    const byDir = new Map();
    for (const f of files) if (!byDir.has(dirOf(f))) byDir.set(dirOf(f), f);
    for (const [dir, file] of byDir) {
      const targets = parseMakeTargets(ctx.read(file), { just });
      if (!targets.length) continue;
      const main = TARGET_PRIORITY.map((n) => targets.find((t) => t.name === n)).find(Boolean) || targets[0];
      const u = newUnit(dir, tool);
      u.manifests.push(file);
      const recipe = main.recipe.join('\n');
      const wraps = [...new Set(tokenizeShell(recipe).map((s) => recognizeCommand(s.tokens)).filter(Boolean).map((x) => x.runner))];
      u.runners.push(makeRunner(tool, { cmd: `${tool} ${main.name}`, target: main.name, targets: targets.map((t) => t.name), source: `${file} target ${main.name}`,
        ...(wraps.length ? { wraps } : {}), available: ctx.has(tool) }));
      units.push(u);
    }
  }
  return units;
}

// ---------------------------------------------------------------------------
// CI: system, files, the test commands it runs (and the directory it runs them in)

const CI_FILES = [
  ['github-actions', (r) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(r)],
  ['gitlab-ci', (r) => r === '.gitlab-ci.yml'],
  ['azure-pipelines', (r) => /^azure-pipelines[\w.-]*\.ya?ml$/.test(r) || /^\.azure-pipelines\/.+\.ya?ml$/.test(r)],
  ['circleci', (r) => r === '.circleci/config.yml'],
  ['bitbucket-pipelines', (r) => r === 'bitbucket-pipelines.yml'],
  ['travis', (r) => r === '.travis.yml'],
  ['jenkins', (r) => r === 'Jenkinsfile'],
];
const RUN_KEYS = new Set(['run', 'script', 'before_script', 'bash', 'pwsh', 'powershell', 'command', 'sh']);
// Setup lines that mention a test tool without running tests (`pip install pytest`).
const INSTALL_LINE = new RegExp('^\\s*(?:sudo\\s+)?(?:' + [
  'pip3?\\s+install', 'python[\\d.]*\\s+-m\\s+pip\\b', 'uv\\s+(?:pip|tool|add|sync)\\b', 'poetry\\s+(?:add|install)', 'pipx\\b',
  'npm\\s+(?:i|install|ci|config)\\b', 'yarn\\s+(?:add|install)\\b', 'pnpm\\s+(?:add|install|i)\\b', 'bun\\s+(?:add|install)\\b',
  'gem\\s+install', 'bundle\\s+install', 'apt(?:-get)?\\b', 'brew\\b', 'choco\\b', 'go\\s+(?:install|get|mod)\\b',
  'cargo\\s+(?:install|fetch|binstall)\\b', 'dotnet\\s+(?:tool|restore|new)\\b', 'echo\\b', 'printf\\b', 'export\\b',
  'cd\\s+\\S+\\s*$', 'curl\\b', 'wget\\b'].join('|') + ')');
const TEST_LINE_RES = [
  /\b(?:npm|pnpm|yarn|bun)\s+(?:(?:-\S+|--\S+)\s+)*(?:run\s+|run-script\s+)?(?:test|t|tst)(?::[\w:.-]+)?\b/,
  /\b(?:npx|bunx|pnpm\s+exec|yarn)\s+(?:--?\S+\s+)*(?:jest|vitest|mocha|playwright\s+test|cypress\s+run)\b/,
  /^(?:jest|vitest|mocha)\b/, /\bnode\s+(?:\S+\s+)*--test\b/, /\bbun\s+test\b/,
  /\bpytest\b/, /\bpython[\d.]*\s+-m\s+(?:pytest|unittest)\b/, /^(?:tox|nox)\b/,
  /\bgo\s+test\b/, /\bcargo\s+(?:test|nextest\s+run)\b/, /\bdotnet\s+test\b/,
  /\b(?:\.\/)?mvnw?(?:\.cmd)?\b.*\s(?:test|verify|integration-test)\b/, /\b(?:\.\/)?gradlew?(?:\.bat)?\b.*\s(?:test|check|\S+:test)\b/,
  /\b(?:bundle\s+exec\s+)?(?:rspec|rake\s+(?:test|spec))\b/, /\brails\s+test\b/,
  /\b(?:make|just)\s+(?:-\S+\s+)*test[\w:.-]*/, /(?:^|[\s/])(?:run[-_]?)?tests?(?:[-_][\w-]+)?\.(?:sh|ps1|py|bat|cmd)\b/,
];

const firstString = (...vals) => { for (const v of vals) if (typeof v === 'string' && v.trim()) return v.trim(); return null; };

function normalizeCiDir(d, base) {
  if (d == null) return base ?? '.';
  let s = toPosix(String(d)).trim().replace(/^\$\{\{\s*github\.workspace\s*\}\}\/?/, '').replace(/^\$\(\s*(?:System\.DefaultWorkingDirectory|Build\.SourcesDirectory|Pipeline\.Workspace)\s*\)\/?/, '')
    .replace(/^\$(?:CI_PROJECT_DIR|GITHUB_WORKSPACE)\/?/, '');
  // Absolute and home paths name the executor's checkout (CircleCI `~/project`), not a subfolder.
  if (/^(?:\/|~|[A-Za-z]:\/)/.test(s)) return '.';
  s = normRel(s);
  if (!s || s === '.' || /[$]/.test(s)) return base ?? '.';
  return base && base !== '.' ? `${base}/${s}` : s;
}

function ciScriptsFromTree(tree) {
  const out = [];
  const emit = (script, wd, hint = null) => { if (typeof script === 'string' && script.trim()) out.push({ script, wd, hint }); };
  const visit = (node, wd) => {
    if (Array.isArray(node)) { for (const x of node) visit(x, wd); return; }
    if (!node || typeof node !== 'object') return;
    const here = firstString(node['working-directory'], node.workingDirectory, node.working_directory) != null
      ? normalizeCiDir(firstString(node['working-directory'], node.workingDirectory, node.working_directory), null) : wd;
    const def = node.defaults && node.defaults.run && firstString(node.defaults.run['working-directory']);
    const childWd = def ? normalizeCiDir(def, null) : here;
    if (typeof node.task === 'string' && node.inputs && typeof node.inputs === 'object') {
      const inp = node.inputs;
      if (/^DotNetCoreCLI@/i.test(node.task) && String(inp.command || '') === 'test') emit(`dotnet test ${inp.projects || ''}`.trim(), here, node.task);
      if (/^Maven@/i.test(node.task) && /\b(?:test|verify)\b/.test(String(inp.goals || ''))) emit(`mvn ${inp.goals}`, here, node.task);
      if (/^Gradle@/i.test(node.task) && /\b(?:test|check)\b/.test(String(inp.tasks || ''))) emit(`./gradlew ${inp.tasks}`, here, node.task);
    }
    for (const [k, v] of Object.entries(node)) {
      if (RUN_KEYS.has(k) && typeof v === 'string') emit(v, here);
      else if (RUN_KEYS.has(k) && Array.isArray(v) && v.flat(4).every((x) => typeof x === 'string')) for (const s of v.flat(4)) emit(s, here);
      else if (k === 'run' && v && typeof v === 'object' && typeof v.command === 'string') emit(v.command, firstString(v.working_directory) != null ? normalizeCiDir(v.working_directory, null) : here);
      else if (v && typeof v === 'object') visit(v, childWd);
    }
  };
  visit(tree, '.');
  return out;
}

function ciCommandLines(script) {
  const joined = String(script).replace(/\r\n?/g, '\n').replace(/[\\`^]\n\s*/g, ' ');
  return joined.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}

function isTestCommand(line) {
  if (INSTALL_LINE.test(line) || /--version\b|--help\b/.test(line)) return false;
  return TEST_LINE_RES.some((re) => re.test(line));
}

function lineOf(text, needle) {
  const lines = String(text).split(/\r?\n/);
  const first = String(needle).split('\n')[0].trim().slice(0, 60);
  const idx = lines.findIndex((l) => l.includes(first));
  return idx === -1 ? null : idx + 1;
}

function detectCi(ctx) {
  const systems = [];
  const files = [];
  const steps = [];
  for (const rel of [...ctx.g.relevant.keys()].sort()) {
    const hit = CI_FILES.find(([, test]) => test(rel));
    if (!hit) continue;
    if (!systems.includes(hit[0])) systems.push(hit[0]);
    files.push(rel);
    const text = ctx.read(rel) || '';
    let scripts = [];
    if (hit[0] === 'jenkins') {
      scripts = [...text.matchAll(/\b(?:sh|bat|powershell|pwsh)\s*\(?\s*(?:script\s*:\s*)?('''|"""|'|")([\s\S]*?)\1/g)].map((m) => ({ script: m[2], wd: '.' }));
    } else {
      for (const doc of parseYaml(text)) if (doc && typeof doc === 'object') scripts.push(...ciScriptsFromTree(doc));
      if (!scripts.length) {
        // Unparseable YAML: fall back to single-line `run:`/`script:` values.
        for (const m of text.matchAll(/^\s*-?\s*(?:run|script|command)\s*:\s*(?![|>])(.+)$/gm)) scripts.push({ script: m[1].replace(/^['"]|['"]$/g, ''), wd: '.' });
      }
    }
    for (const { script, wd, hint } of scripts) {
      for (const line of ciCommandLines(script)) {
        if (!isTestCommand(line)) continue;
        let cwd = wd || '.';
        const cd = /^cd\s+("[^"]+"|'[^']+'|\S+)\s*(?:&&|;)\s*/.exec(line);
        const cmd = cd ? line.slice(cd[0].length) : line;
        if (cd) cwd = normalizeCiDir(cd[1].replace(/^['"]|['"]$/g, ''), cwd === '.' ? null : cwd);
        steps.push({ file: rel, line: lineOf(text, line) ?? (hint ? lineOf(text, hint) : null), cmd: truncate(cmd, 400), cwd });
      }
    }
  }
  const dedup = [];
  for (const s of steps) if (!dedup.some((d) => d.cmd === s.cmd && d.cwd === s.cwd)) dedup.push(s);
  return {
    system: systems.length ? systems[0] : null,
    ...(systems.length > 1 ? { systems } : {}),
    files,
    test_commands: uniq(dedup.map((s) => s.cmd)),
    steps: dedup,
  };
}

/** Recognize a runner in one command segment (CI lines, make recipes). */
function recognizeCommand(tokens) {
  const { env, rest } = stripEnv(tokens);
  const { tokens: t } = stripLaunchers(rest);
  if (!t.length) return null;
  const b = binName(t[0]);
  const a = t.slice(1);
  const words = a.filter((x) => !x.startsWith('-'));
  const py = /^python[\d.]*$/.test(b) || b === 'py';
  const pyRun = ['uv', 'poetry', 'pdm', 'pipenv', 'hatch'].includes(b) && words[0] === 'run';
  if (b === 'pytest' || b === 'py.test' || (py && a[0] === '-m' && a[1] === 'pytest') || (pyRun && words.includes('pytest'))) return { runner: 'pytest', env };
  if ((py && a[0] === '-m' && a[1] === 'unittest') || (['uv', 'poetry', 'pdm', 'pipenv'].includes(b) && words[0] === 'run' && /unittest/.test(a.join(' ')))) return { runner: 'unittest', env };
  if (b === 'go' && words[0] === 'test') return { runner: 'go', env };
  if (b === 'cargo' && words[0] === 'nextest') return { runner: 'nextest', env };
  if (b === 'cargo' && words[0] === 'test') return { runner: 'cargo', env };
  if (b === 'dotnet' && words[0] === 'test') return { runner: 'dotnet', env };
  if (/^mvnw?$/.test(b) && words.some((w) => /^(?:test|verify|integration-test)$/.test(w))) return { runner: 'maven', env };
  if (/^gradlew?$/.test(b) && words.some((w) => /(?:^|:)(?:test|check)$/.test(w))) return { runner: 'gradle', env };
  if (b === 'rspec' || (b === 'bundle' && words[0] === 'exec' && words[1] === 'rspec')) return { runner: 'rspec', env };
  const bundled = b === 'bundle' && words[0] === 'exec' && (words[1] === 'rake' || words[1] === 'rails') && words[2] === 'test';
  if ((b === 'rake' && words[0] === 'test') || bundled || (b === 'rails' && words[0] === 'test')) return { runner: 'minitest', env };
  if (b === 'make' && words.some((w) => /^test/.test(w))) return { runner: 'make', env };
  if (b === 'just' && words.some((w) => /^test/.test(w))) return { runner: 'just', env };
  const js = classifySegment(tokens, null);
  if (js.kind === 'runner') return { runner: js.runner, env, occ: js };
  return null;
}

// Report or narrowing flags a learned CI command must not keep (the companion adds its own).
const CI_DROP = {
  // Plugin flags (pytest-cov, pytest-xdist) are dropped too: the plugin may be a CI-only install.
  pytest: /^--(?:junit-?xml|junitxml|junit-prefix)(?:=|$)|^--cov(?:-report)?(?:=|$)|^-n$|^--numprocesses(?:=|$)/,
  go: /^-json$/, dotnet: /^--logger(?:=|$)|^-l$|^--results-directory(?:=|$)/, rspec: /^--(?:format|out)(?:=|$)|^-[fo]$/,
};

const CI_VALUED = /^-(?:n|l|f|o)$|^--(?:logger|numprocesses|format|out|results-directory|junitxml|junit-xml|cov|cov-report)$/;

/** Is the program a command line starts with on PATH (or a repository script)? */
function launcherAvailable(ctx, cmd) {
  if (!cmd) return false;
  for (const seg of tokenizeShell(cmd)) {
    const { rest } = stripEnv(seg.tokens);
    if (!rest.length || ['set', 'cd', 'export'].includes(rest[0])) continue;
    if (/^\.{1,2}\//.test(rest[0])) return true;
    return ctx.has(binName(rest[0]));
  }
  return false;
}

function learnedRunner(ctx, step) {
  const segs = tokenizeShell(step.cmd);
  for (const seg of segs) {
    const rec = recognizeCommand(seg.tokens);
    if (!rec) continue;
    const name = rec.runner;
    if (rec.occ && RUNNERS[name] && RUNNERS[name].ecosystem === 'node') {
      const pm = { exec: 'npx --no', launcher: 'npm' };
      const r = nodeRunnerFromOccurrence(ctx, pm, rec.occ, step.cwd, `ci: ${step.file}${step.line ? `:${step.line}` : ''}`, new Set());
      return r;
    }
    const drop = CI_DROP[name];
    const toks = [];
    for (let k = 0; k < seg.tokens.length; k++) {
      const tk = seg.tokens[k];
      if (drop && drop.test(tk)) {
        if (!tk.includes('=') && CI_VALUED.test(tk) && seg.tokens[k + 1] && !seg.tokens[k + 1].startsWith('-')) k++;
        continue;
      }
      toks.push(tk);
    }
    const { env, rest } = stripEnv(toks);
    const joined = joinArgs(rest);
    const r = makeRunner(name, { cmd: `${ctx.envPrefix(env)}${joined.text}`, source: `ci: ${step.file}${step.line ? `:${step.line}` : ''}` });
    if (!joined.portable) r.portable = false;
    if (name === 'make' || name === 'just') r.target = (rest.slice(1).find((w) => /^test/.test(w)) || 'test');
    return r;
  }
  const r = makeRunner('ci', { cmd: step.cmd, source: `ci: ${step.file}${step.line ? `:${step.line}` : ''}` });
  if (/^\.\/|\$\{\{|\$\(/.test(step.cmd)) r.portable = false;
  return r;
}

// ---------------------------------------------------------------------------
// Assemble

function mergeUnits(units) {
  const byDir = new Map();
  for (const u of units) {
    if (!byDir.has(u.dir)) byDir.set(u.dir, []);
    byDir.get(u.dir).push(u);
  }
  const projects = [];
  for (const [dir, list] of byDir) {
    list.sort((a, b) => ECO_ORDER.indexOf(a.ecosystem) - ECO_ORDER.indexOf(b.ecosystem));
    const p = {
      root: dir, ecosystems: uniq(list.map((u) => u.ecosystem)), languages: uniq(list.flatMap((u) => u.languages)),
      manifests: uniq(list.flatMap((u) => u.manifests)), managers: list.flatMap((u) => u.managers), runners: list.flatMap((u) => u.runners),
      test_globs: uniq(list.flatMap((u) => u.test_globs)), typecheck: list.flatMap((u) => u.typecheck), lint: list.flatMap((u) => u.lint),
      coverage: list.flatMap((u) => u.coverage),
      test_script: (list.find((u) => u.test_script) || {}).test_script ?? null,
      workspace: (list.find((u) => u.workspace) || {}).workspace ?? null,
      warnings: uniq(list.flatMap((u) => u.warnings)),
    };
    const del = list.filter((u) => u.delegates);
    if (del.length) p.delegates_to = uniq(del.flatMap((u) => u.delegates_via || []));
    if (list.some((u) => u.module)) p.module = list.find((u) => u.module).module;
    // A workspace root without a runner of its own leaves the tests to its members.
    p._delegatingRoot = !p.runners.length && (del.length > 0 || list.some((u) => u.workspace && u.workspace.role === 'root'));
    projects.push(p);
  }
  return projects;
}

function summarize(projects) {
  const groups = new Map();
  for (const p of projects) {
    for (const eco of p.ecosystems) {
      if (!groups.has(eco)) groups.set(eco, { count: 0, managers: [], runners: [] });
      const g = groups.get(eco);
      g.count++;
      g.managers.push(...p.managers.filter((m) => m.ecosystem === eco).map((m) => m.name));
      g.runners.push(...p.runners.filter((r) => r.ecosystem === eco).map((r) => (r.name === 'make' || r.name === 'just' ? r.target : r.name)));
    }
  }
  const parts = [...groups.entries()].sort(([a], [b]) => ECO_ORDER.indexOf(a) - ECO_ORDER.indexOf(b))
    .map(([eco, g]) => `${eco}${g.count > 1 ? ` x${g.count}` : ''}(${uniq([...g.managers, ...g.runners]).join(', ') || 'no runner'})`);
  return parts.length ? parts.join(' \u00b7 ') : 'no projects detected';
}

function gitInfo(root) {
  try {
    if (!repoRoot(root)) return { default_branch: null, base_source: null };
  } catch {
    return { default_branch: null, base_source: null };
  }
  const branchName = (ref) => (ref ? ref.replace(/^origin\//, '') : null);
  const current = () => gitTry(root, ['symbolic-ref', '-q', '--short', 'HEAD']);
  try {
    const b = resolveBase(root, null);
    if (b.source === 'empty') return { default_branch: current(), base_source: 'empty' };
    if (b.source === 'HEAD') return { default_branch: current(), base_source: 'HEAD' };
    return { default_branch: branchName(b.ref), base_source: b.source };
  } catch (err) {
    // No merge base (shallow clone, unrelated history): the branch name is still known.
    const sym = gitTry(root, ['symbolic-ref', '-q', 'refs/remotes/origin/HEAD']);
    if (sym && revParse(root, sym)) return { default_branch: sym.replace(/^refs\/remotes\/origin\//, ''), base_source: 'origin/HEAD', base_error: err.code || 'GIT_FAILED' };
    for (const name of ['main', 'master']) {
      if (revParse(root, `refs/heads/${name}`) || revParse(root, `refs/remotes/origin/${name}`)) return { default_branch: name, base_source: name, base_error: err.code || 'GIT_FAILED' };
    }
    return { default_branch: current(), base_source: null, base_error: err.code || 'GIT_FAILED' };
  }
}

function derive(g, { platform, tools }) {
  const ctx = makeCtx(g, { platform, tools });
  const ci = detectCi(ctx);
  ctx.ci = ci;
  const units = [...detectNode(ctx), ...detectPython(ctx), ...detectGo(ctx), ...detectRust(ctx), ...detectDotnet(ctx),
    ...detectJvm(ctx), ...detectRuby(ctx), ...detectMake(ctx)];
  let projects = mergeUnits(units);
  // A folder CI tests in, with no runner detected from its manifests: CI's command is the runner.
  for (const step of ci.steps) {
    const exact = projects.find((p) => p.root === step.cwd);
    if (exact && (exact.runners.length || exact._delegatingRoot)) continue;
    // A job may test another repository it checks out into a subfolder: only folders of this one count.
    if (!exact && !dirExists(g, step.cwd)) continue;
    const r = learnedRunner(ctx, step);
    r.available = launcherAvailable(ctx, r.cmd);
    const owner = exact || { root: step.cwd, ecosystems: [], languages: [], manifests: [], managers: [], runners: [], test_globs: [],
      typecheck: [], lint: [], coverage: [], test_script: null, workspace: null, warnings: [], _delegatingRoot: false };
    if (!exact) projects.push(owner);
    if (owner.runners.some((x) => x.cmd === r.cmd)) continue;
    owner.runners.push(r);
    if (!owner.ecosystems.includes(r.ecosystem)) owner.ecosystems.push(r.ecosystem);
    owner.test_globs = uniq([...owner.test_globs, ...RUNNERS[r.name].test_globs]);
  }
  for (const step of ci.steps) {
    const o = dirExists(g, step.cwd) ? projectForFile(step.cwd === '.' ? '.' : `${step.cwd}/x`, { projects }) : null;
    step.project = o ? o.root : null;
  }
  for (const p of projects) {
    const own = ci.steps.filter((s) => s.project === p.root).map((s) => s.cmd);
    if (own.length) p.ci_test_commands = uniq(own);
  }
  // A folder is a project when it has a runner; the repository root also when it has a manifest,
  // unless it only delegates to workspace members (they are the projects then).
  const kept = projects.filter((p) => p.runners.length || (p.root === '.' && !p._delegatingRoot));
  const dropped = projects.filter((p) => !kept.includes(p));
  for (const p of kept) delete p._delegatingRoot;
  projects = kept.sort((a, b) => (a.root === '.' ? -1 : b.root === '.' ? 1 : a.root < b.root ? -1 : a.root > b.root ? 1 : 0));
  const tag = (list, root) => list.map((x) => ({ ...x, project: root }));
  const allTypecheck = [...projects.flatMap((p) => tag(p.typecheck, p.root)), ...dropped.flatMap((p) => tag(p.typecheck, p.root))];
  const allLint = [...projects.flatMap((p) => tag(p.lint, p.root)), ...dropped.flatMap((p) => tag(p.lint, p.root))];
  const warnings = uniq([...ctx.warnings, ...projects.flatMap((p) => p.warnings), ...g.oversize.map((f) => `${f}: larger than 2 MB; only its presence was used`)]);
  const nextSteps = [];
  if (!projects.some((p) => p.runners.length)) {
    nextSteps.push('No test runner was detected: ask the user for the test command and pass it as `clean-run --runner "<command>"` (headless runs record CK-CLEANRUN as UNVERIFIED).');
  }
  return {
    summary: summarize(projects),
    projects,
    ci,
    lint: allLint,
    typecheck: allTypecheck,
    other_packages: dropped.map((p) => ({ root: p.root, ecosystems: p.ecosystems,
      reason: !p._delegatingRoot ? 'no test runner' : p.delegates_to ? `test script delegates to workspace members (${p.delegates_to.join('; ')})`
        : 'workspace root without a test runner of its own (the members are the projects)' })),
    warnings,
    next_steps: nextSteps,
  };
}

// ---------------------------------------------------------------------------
// Secrets: commands copied from CI files and scripts can carry literal credentials.

const ENV_SECRET = /\b([A-Za-z_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIALS?)[A-Za-z0-9_]*)(\s*[=:]\s*)(?!\$|\[REDACTED)(["']?)([^\s"']{4,})\3/gi;

async function redactor(env) {
  let scan = null;
  try {
    const m = await import('./markers.mjs');
    if (typeof m.scanSecrets === 'function') scan = m.scanSecrets;
  } catch { /* markers.mjs not available in this build */ }
  const literals = env.ADC_LIVE_TOKEN ? [{ name: 'ADC_LIVE_TOKEN', value: String(env.ADC_LIVE_TOKEN) }] : [];
  return (s) => {
    let out = redactLiterals(s, literals).replace(ENV_SECRET, (_, k, sep) => `${k}${sep}[REDACTED]`);
    if (scan) {
      try {
        const hits = scan(out);
        if (hits.length && !/\n/.test(out)) out = hits[0].redacted;
      } catch { /* scanning must never break detection */ }
    }
    return out;
  };
}

// Fields that are identifiers or paths the companion computed itself (a digest would trip the
// generic high-entropy rule).
const SAFE_KEYS = new Set(['cache_key', 'repo_root', 'generated_at', 'generated_by', 'schema', 'platform', 'file_listing', 'path']);

const SECRET_NAME = /(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIALS?)/i;

function mapStrings(value, fn, key = null) {
  if (key && SAFE_KEYS.has(key)) return value;
  // An env map value under a credential-like name (`API_TOKEN: ...`) has no NAME= context to match.
  if (key && typeof value === 'string' && SECRET_NAME.test(key) && value && !/^\$/.test(value)) return '[REDACTED]';
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, fn, k)]));
  return value;
}

// ---------------------------------------------------------------------------
// Public API

/**
 * Detect the projects under `root`. With `stateInfo` (from prepareStateDir/prepareTarget) the
 * result is cached in `<state>/detect.json`; `refresh` bypasses the cache. Never runs project code.
 * Test seams: `platform` (command dialect), `which` (tool lookup), `write` (false: read-only cache).
 */
export async function detect({ root, stateInfo = null, refresh = false, write = true, platform = process.platform, which: whichFn = null, env = process.env } = {}) {
  if (!root) throw usageError('detect: a root directory is required');
  const abs = path.resolve(root);
  let st = null;
  try { st = fs.statSync(abs); } catch { st = null; }
  if (!st || !st.isDirectory()) throw usageError(`detect: not a directory: ${toPosix(abs)}`);
  const started = Date.now();
  const g = gather(abs, { stateInfo, env });
  const key = inputDigest(g, platform);
  const cacheFile = stateInfo ? (stateInfo.paths && stateInfo.paths.detect) || statePaths(stateInfo.dir).detect : null;
  const tools = makeTools(whichFn, env);
  const live = gitInfo(abs);
  if (cacheFile && !refresh) {
    const cached = readJson(cacheFile, null);
    const toolsSame = cached && cached.tools && typeof cached.tools === 'object' && Object.entries(cached.tools).every(([n, v]) => tools.has(n) === v);
    const probesSame = cached && Object.entries(cached.probes || {}).every(([rel, v]) => dirExists(g, rel) === v);
    if (cached && cached.schema === DETECT_SCHEMA && cached.cache_key === key && toolsSame && probesSame && Array.isArray(cached.projects)) {
      const { base_error: _drop, ...rest } = cached;
      return { ...rest, ...live, repo_root: toPosix(abs), duration_ms: Date.now() - started, cache: { hit: true, path: toPosix(cacheFile), written: false } };
    }
  }
  const derived = derive(g, { platform, tools });
  const result = {
    schema: DETECT_SCHEMA,
    cache_key: key,
    generated_at: nowIso(),
    generated_by: generatedBy(),
    detect_source: 'detect',
    repo_root: toPosix(abs),
    platform,
    file_listing: g.listing,
    files_scanned: g.fileCount,
    inputs: g.relevant.size,
    ...derived,
    ...live,
    tools: Object.fromEntries(Object.entries(tools.seen).sort(([a], [b]) => (a < b ? -1 : 1))),
    probes: Object.fromEntries(Object.entries(g.probes).sort(([a], [b]) => (a < b ? -1 : 1))),
  };
  const clean = mapStrings(result, await redactor(env));
  let written = false;
  let writeError = null;
  if (cacheFile && write && fs.existsSync(path.dirname(cacheFile))) {
    try { writeJsonAtomic(cacheFile, clean); written = true; } catch (err) { writeError = err.code || err.message; }
  }
  return { ...clean, duration_ms: Date.now() - started, cache: { hit: false, path: cacheFile ? toPosix(cacheFile) : null, written, ...(writeError ? { error: writeError } : {}) } };
}

/** The project owning a repo-relative (or absolute) file: the longest matching root, or null. */
export function projectForFile(file, detectResult) {
  const projects = (detectResult && Array.isArray(detectResult.projects)) ? detectResult.projects : [];
  let rel = toPosix(String(file || ''));
  if (path.isAbsolute(rel) || /^[A-Za-z]:\//.test(rel)) {
    const base = detectResult && detectResult.repo_root;
    rel = base ? toPosix(path.relative(base, rel)) : rel;
  }
  rel = normRel(rel);
  let best = null;
  for (const p of projects) {
    const r = normRel(p && p.root ? p.root : '.') || '.';
    if (!under(rel, r === '' ? '.' : r)) continue;
    const len = r === '.' || r === '' ? 0 : r.length;
    if (!best || len > best.len) best = { p, len };
  }
  return best ? best.p : null;
}

/**
 * Is `file` a test file for the project that owns it (that project's effective test globs),
 * or by the default globs when no project owns it? `opts.content` adds Rust inline test modules.
 */
export function isTestFile(file, detectResult, { content = null } = {}) {
  const rel = normRel(file);
  if (!rel) return false;
  const p = projectForFile(rel, detectResult);
  const root = p ? normRel(p.root || '.') || '.' : '.';
  const globs = p && Array.isArray(p.test_globs) && p.test_globs.length ? p.test_globs.filter((x) => typeof x === 'string') : DEFAULT_TEST_GLOBS;
  if (matchAny(subPath(rel, root), globs)) return true;
  if (content != null && /\.rs$/.test(rel) && /#\[cfg\(test\)\]/.test(String(content))) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Command

const USAGE = `usage: node <skill>/scripts/adc.mjs detect [--refresh] [--json] [--cwd <dir>] [--state-dir <dir>] [--dry-run]

Detects projects (monorepo-aware), package managers with their frozen install, test runners
with report and retries-off flags, test-file globs, type checkers, linters, the CI system and
the test commands CI runs, and the default branch. Reads files only; never runs project code.
The result is cached in .adc/detect.json (keyed by a digest of every detection input).

  --refresh    ignore the cache and detect again
  --dry-run    read the cache but write nothing (no .adc/ is created)`;

function human(res) {
  const lines = [`detect: ${res.summary}`];
  for (const p of res.projects) {
    const install = p.managers.map((m) => m.install || `${m.name} (no frozen install)`).join('; ');
    lines.push(`  ${p.root}  [${p.languages.join(', ') || p.ecosystems.join(', ')}]${install ? `  install: ${install}` : ''}`);
    for (const r of p.runners) lines.push(`    ${r.name}${r.kind === 'e2e' ? ' (e2e)' : ''}: ${r.cmd}   retries off: ${r.retries_off.coverage}${r.available === false ? '   (not on PATH)' : ''}`);
    for (const t of p.typecheck) lines.push(`    typecheck ${t.name}: ${t.cmd}`);
  }
  if (res.ci && res.ci.system) {
    const tests = res.ci.test_commands.length ? `; test: ${res.ci.test_commands.slice(0, 4).join(' | ')}` : '';
    lines.push(`ci: ${(res.ci.systems || [res.ci.system]).join(', ')} (${res.ci.files.join(', ')})${tests}`);
  }
  lines.push(`default branch: ${res.default_branch || 'unknown'} (${res.base_source || 'no git'})`);
  for (const w of res.warnings || []) lines.push(`warning: ${w}`);
  for (const s of res.next_steps || []) lines.push(`next: ${s}`);
  lines.push(`cache: ${res.cache.hit ? 'hit' : res.cache.written ? 'written' : 'not written'}${res.cache.path ? ` (${res.cache.path})` : ''}`);
  return lines.join('\n');
}

export const detectCommand = defineCommand({
  name: 'detect',
  usage: USAGE,
  options: { refresh: { type: 'boolean' } },
  positionals: false,
  async run(ctx, values) {
    const root = repoRoot(ctx.cwd) || ctx.cwd;
    let stateInfo = null;
    if (repoRoot(ctx.cwd) || ctx.stateDirOption) stateInfo = prepareStateDir({ ...ctx, cwd: root }, { create: !ctx.dryRun });
    const res = await detect({ root, stateInfo, refresh: Boolean(values.refresh), write: !ctx.dryRun });
    return { result: res, exit: EXIT.OK, summary: res.summary, human: human(res) };
  },
});
