// Project detection (§7.4): one entry per project (monorepo-aware) with its package manager and
// frozen install, test runners with report and retries-off flags, test-file globs, type checkers,
// linters and coverage producers; the CI system and the test commands CI really runs; the default
// branch. Manifests are read as text, project code is never executed. The result is cached in
// <state>/detect.json under a digest of every detection input (hooks read `summary` and test globs).

import fs from 'node:fs';
import path from 'node:path';
import {
  EXIT, defineCommand, usageError, readText, readJson, writeJsonAtomic, sha256, nowIso, toPosix, matchGlob, which,
  skillVersion, generatedBy, truncate, listFiles, splitShell, uniq, isObj, isDir, statOrNull,
} from './core.mjs';
import { gitRaw, gitTry, repoRoot, resolveBase, revParse } from './git.mjs';
import { prepareStateDir, statePaths, STATE_DIR_NAME } from './state.mjs';
import * as M from './markers.mjs';
import { parseToml, parseIni, parseJsonc } from './formats.mjs';
import { parseYamlAll } from './frontmatter.mjs';

export const DETECT_SCHEMA = 'adc-detect/1';
const MAX_READ = 2 * 1024 * 1024;
const MAX_FILES = 200_000;
const { join: J, dirname: dirOf, basename: baseOf } = path.posix;
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// Heavy, generated or vendored folders: never a project, never a detection input.
const SKIP_DIRS = new Set(['.git', '.hg', '.svn', STATE_DIR_NAME, 'node_modules', 'bower_components', 'jspm_packages',
  '.venv', 'venv', '.tox', '.nox', '__pycache__', '.mypy_cache', '.pytest_cache', '.ruff_cache', 'target', 'dist',
  'build', 'out', 'obj', '.next', '.nuxt', '.svelte-kit', '.turbo', '.yarn', '.pnpm-store', '.gradle', '.idea',
  'vendor', 'coverage', '.cache', '.terraform', '.dart_tool', 'site-packages']);
// Manifests in these folders belong to test fixtures, not to the build.
const FIXTURE_DIRS = new Set(['fixtures', '__fixtures__', 'fixture', 'testdata', 'test-fixtures', 'test_fixtures',
  '__mocks__', '__snapshots__']);
const MAKE_RE = /^(?:GNUmakefile|[Mm]akefile)$/;
const JUST_RE = /^(?:[Jj]ustfile|\.justfile)$/;
const DOTNET_PROJ = /\.(?:csproj|fsproj|vbproj)$/;
const SLN = /\.(?:sln|slnx)$/;
const REQ_RE = /^requirements(?:[-_.][\w.-]*)?\.txt$/;
const CI_SYSTEMS = [
  ['github-actions', /^\.github\/workflows\/[^/]+\.ya?ml$/], ['gitlab-ci', /^\.gitlab-ci\.yml$/],
  ['azure-pipelines', /^(?:azure-pipelines[\w.-]*|\.azure-pipelines\/.+)\.ya?ml$/],
  ['circleci', /^\.circleci\/config\.yml$/], ['bitbucket-pipelines', /^bitbucket-pipelines\.yml$/],
  ['travis', /^\.travis\.yml$/],
];
const MANIFEST_NAMES = new Set(['package.json', 'pyproject.toml', 'setup.py', 'setup.cfg', 'Pipfile', 'pytest.ini',
  '.pytest.ini', 'pytest.toml', '.pytest.toml', 'tox.ini', 'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle',
  'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'Gemfile']);
// Detection inputs: `content` files are read and digested; `presence` files matter by name only.
const CONTENT_NAMES = new Set([...MANIFEST_NAMES, 'pnpm-workspace.yaml', 'lerna.json', '.yarnrc.yml', 'mypy.ini',
  '.mypy.ini', 'global.json']);
const CONTENT_RES = [REQ_RE, DOTNET_PROJ, MAKE_RE, JUST_RE, /^\.mocharc\.(?:js|cjs|mjs|json|jsonc|ya?ml)$/,
  /^jest\.config\.json$/, /^(?:jest|vitest|vite|playwright|cypress)\.config\.[cm]?[jt]s$/,
  /^vitest\.(?:workspace|projects)\.(?:[cm]?[jt]s|json)$/];
const PRESENCE_NAMES = new Set(['tsconfig.json', 'conftest.py', 'uv.toml', 'ruff.toml', '.ruff.toml', '.flake8',
  'pyrightconfig.json', 'go.work', 'clippy.toml', '.clippy.toml', 'gradlew', 'gradlew.bat', 'mvnw', 'mvnw.cmd',
  '.pnp.cjs', '.rspec', 'Rakefile', '.rubocop.yml', 'biome.json', 'biome.jsonc']);
const PRESENCE_RES = [SLN, /^\.golangci\.(?:ya?ml|toml|json)$/, /^eslint\.config\.[cm]?[jt]s$/,
  /^\.eslintrc(?:\.(?:js|cjs|json|ya?ml))?$/];
const CODE_EXTS = new Set(['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts', 'py', 'go', 'rs', 'cs', 'fs', 'vb',
  'java', 'kt', 'kts', 'scala', 'groovy', 'rb']);
const ECO_ORDER = ['node', 'python', 'go', 'rust', 'dotnet', 'jvm', 'ruby', 'make', 'just', 'ci'];

// ---------------------------------------------------------------------------
// Runner catalog (§7.4 table). In `report`, `<f>` is the report file and `<d>` a report directory
// (consumers substitute them). `retries_off.mechanism` is a CLI flag when it starts with `-`
// (append it last), otherwise the reason nothing needs to be passed. `coverage`: full = the
// runner's own retries are off; partial = retries live in test code; unknown = the run cannot
// tell a retried test from a passing one.

const SUMMARY = { format: 'summary-text', stdout: true };
const JS_GLOBS = ['**/__tests__/**', '**/*.{test,spec}.*'];
const junit = (flag, extra) => ({ ...(flag ? { flag } : {}), ...extra, format: 'junit' });
const wrapped = (what) => `${what}: retries depend on the wrapped runner`;
// name: [ecosystem, cmd, report, retries-off mechanism, its coverage, test globs, kind = 'unit']
const CATALOG = {
  'node-test': ['node', 'node --test', junit('--test-reporter=junit --test-reporter-destination=<f>'),
    'node:test has no retries', 'full',
    ['*.test', '*-test', '*_test', 'test-*', 'test', 'test/**/*'].map((g) => `**/${g}.{cjs,mjs,js,cts,mts,ts}`)],
  jest: ['node', 'npx --no jest --ci', { flag: '--json --outputFile=<f>', format: 'jest-json' },
    'jest.retryTimes() lives in test code; retried tests are reported as flaky', 'partial', JS_GLOBS],
  vitest: ['node', 'npx --no vitest run', junit('--reporter=junit --outputFile=<f>'), '--retry=0', 'full', JS_GLOBS],
  mocha: ['node', 'npx --no mocha', junit('--reporter xunit --reporter-option output=<f>'), '--retries 0', 'full',
    ['test/**', '**/*.{test,spec}.*']],
  playwright: ['node', 'npx --no playwright test',
    junit('--reporter=junit', { env: { PLAYWRIGHT_JUNIT_OUTPUT_NAME: '<f>' } }), '--retries=0', 'full',
    ['**/*.{test,spec}.*'], 'e2e'],
  cypress: ['node', 'npx --no cypress run', junit('--reporter junit --reporter-options mochaFile=<f>'),
    '--config retries=0', 'full', ['cypress/e2e/**', 'cypress/integration/**', 'cypress/component/**', '**/*.cy.*'],
    'e2e'],
  bun: ['node', 'bun test', junit('--reporter=junit --reporter-outfile=<f>'), '--retry=0', 'full',
    ['**/*.{test,spec}.*', '**/*_{test,spec}.*']],
  pytest: ['python', 'python -m pytest', junit('--junit-xml=<f>'), '-p no:rerunfailures', 'full',
    ['test_*.py', '*_test.py', 'tests/**', 'conftest.py']],
  unittest: ['python', 'python -m unittest discover', SUMMARY, 'unittest has no retries', 'full',
    ['test*.py', 'tests/**']],
  go: ['go', 'go test ./...', { flag: '-json', format: 'go-test-json', stdout: true }, '-count=1', 'full',
    ['**/*_test.go']],
  cargo: ['rust', 'cargo test --no-fail-fast', { format: 'cargo-text', stdout: true },
    'libtest has no retries, but plain cargo test cannot report a flaky test', 'unknown', ['tests/**']],
  // Without a JUnit profile in the repository, a tool config file defines one (clean-run writes it).
  nextest: ['rust', 'cargo nextest run --no-fail-fast', junit('--tool-config-file adc:<d>/nextest-adc.toml '
    + '--profile adc-ci', { path: '<target>/nextest/adc-ci/junit.xml', nextestConfig: true }), '--retries 0', 'full',
  ['tests/**']],
  dotnet: ['dotnet', 'dotnet test', { flag: '--logger trx --results-directory <d>', dir: '<d>', glob: '*.trx',
    format: 'trx' }, 'VSTest has no retry switch; framework retry attributes are not visible', 'unknown',
  ['**/*Tests*/**', 'tests/**', 'test/**']],
  maven: ['jvm', 'mvn -B test', junit(null, { dir: 'target/surefire-reports', glob: 'TEST-*.xml' }),
    '-Dsurefire.rerunFailingTestsCount=0', 'full', ['src/test/**']],
  gradle: ['jvm', './gradlew test --no-build-cache', 
    junit(null, { dir: 'build/test-results/test', glob: 'TEST-*.xml' }),
    'Gradle has no retry switch; framework-level retries are not visible', 'unknown', ['src/test/**']],
  rspec: ['ruby', 'bundle exec rspec', { flag: '--format json --out <f> --format progress', format: 'rspec-json' },
    'RSpec has no built-in retries', 'unknown', ['spec/**']],
  minitest: ['ruby', 'bundle exec rake test', SUMMARY, 'Minitest has no built-in retries', 'unknown', ['test/**']],
  make: ['make', 'make test', SUMMARY, wrapped('make target'), 'unknown', [], 'wrapper'],
  just: ['just', 'just test', SUMMARY, wrapped('just recipe'), 'unknown', [], 'wrapper'],
  'npm-script': ['node', 'npm test', SUMMARY, 'package.json test script with an unrecognized runner', 'unknown',
    [...JS_GLOBS, 'test/**', 'tests/**'], 'wrapper'],
  ci: ['ci', null, SUMMARY, wrapped('command learned from CI'), 'unknown', [], 'wrapper'],
};
const deepFreeze = (o) => {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); }
  return o;
};
export const RUNNERS = deepFreeze(Object.fromEntries(Object.entries(CATALOG).map(([name, [ecosystem, cmd, report,
  mechanism, coverage, globs, kind = 'unit']]) => [name, { name, kind, ecosystem, cmd, report: structuredClone(report),
  retries_off: { mechanism, coverage }, test_globs: [...globs], count_parser: report.format }])));

function makeRunner(name, fields = {}) {
  const { test_globs: _, ...def } = structuredClone(RUNNERS[name]);
  return { ...def, source: null, ...fields };
}
const newUnit = (dir, ecosystem, ...manifests) => ({ dir, ecosystem, languages: [], manifests, managers: [],
  runners: [], test_globs: [], typecheck: [], lint: [], coverage: [], test_script: null, workspace: null,
  warnings: [] });
const cfgTool = (name, cmd, file) => ({ name, cmd, config: file, source: file });
const ciRef = (s) => `ci: ${s.file}${s.line ? `:${s.line}` : ''}`;

// ---------------------------------------------------------------------------
// Paths, globs, quoting, Makefile targets

const under = (rel, dir) => dir === '.' || rel === dir || rel.startsWith(`${dir}/`);
const subPath = (rel, dir) => (dir === '.' ? rel : rel === dir ? '' : rel.slice(dir.length + 1));
const inFixtureDir = (rel) => dirOf(rel).split('/').some((s) => FIXTURE_DIRS.has(s));
// Workspace globs are anchored at the workspace root (a bare `app` means ./app, not any app/).
const anchored = (sub, glob) => matchGlob(sub, normRel(glob), { anchored: true });
function normRel(file) {
  let f = toPosix(String(file || '')).replace(/^\.\/+/, '');
  while (f.startsWith('./')) f = f.slice(2);
  return f.replace(/\/+$/, '');
}

/** Quote an argument so the same text works in sh and cmd.exe; `portable` is false when it cannot. */
export function portableArg(arg) {
  const s = String(arg);
  if (s && /^[A-Za-z0-9_\-+=.,/:@]+$/.test(s)) return { text: s, portable: true };
  return { text: `"${s.replace(/"/g, '\\"')}"`, portable: !/["$`%!^\n]/.test(s) };
}

function joinArgs(args) {
  const q = args.map(portableArg);
  return { text: q.map((x) => x.text).join(' '), portable: q.every((x) => x.portable) };
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
      else if (r.trim() && !r.trim().startsWith('#')) break;
    }
    for (const name of names.filter((n) => /^test/i.test(n))) {
      if (!targets.some((t) => t.name === name)) targets.push({ name, recipe });
    }
  }
  return targets;
}

const strings = (s) => [...String(s ?? '').matchAll(/(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g)].map((m) => m[2]);
// `key: [..]` or `key: '..'` in a JS/TS config file.
function listOrOne(text, key) {
  const m = new RegExp(`\\b${key}\\s*:\\s*(?:\\[([\\s\\S]*?)\\]|(['"\`])([^'"\`]+)\\2)`).exec(text || '');
  return m ? (m[1] != null ? strings(m[1]) : [m[3]]) : null;
}

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
  return !/[*?[{]/.test(s) && !baseOf(s).includes('.') ? `${s}/**` : s;
}

// ---------------------------------------------------------------------------
// Gather: list files, read every detection input, derive file-list facts

function listRepoFiles(root) {
  let res = null;
  try {
    res = gitRaw(root, ['-c', 'core.quotePath=false', 'ls-files', '-z', '-c', '-o', '--exclude-standard']);
  } catch { /* git is not installed: walk the directory */ }
  if (res?.exit === 0) return { files: res.stdout.split('\0').filter(Boolean), source: 'git' };
  return { files: listFiles(root, { ignore: SKIP_DIRS, maxFiles: MAX_FILES, maxDepth: 14 }), source: 'walk' };
}

function relevantKind(rel) {
  const base = baseOf(rel);
  if (CI_SYSTEMS.some(([, re]) => re.test(rel)) || /(?:^|\/)\.config\/nextest\.toml$/.test(rel)
    || CONTENT_NAMES.has(base) || CONTENT_RES.some((re) => re.test(base))) return 'content';
  if (PRESENCE_NAMES.has(base) || Object.hasOwn(M.LOCKFILE_MANAGERS, base.toLowerCase())
    || PRESENCE_RES.some((re) => re.test(base)) || /(?:^|\/)bin\/rails$/.test(rel)) return 'presence';
  return null;
}

function readHead(file, bytes = 512) {
  const buf = Buffer.alloc(bytes);
  let fd;
  try { fd = fs.openSync(file, 'r'); return buf.toString('utf8', 0, fs.readSync(fd, buf, 0, bytes, 0)); }
  catch { return ''; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

/** File-list facts the detectors use: languages by extension, test files, test folders, Python packages. */
function fileTags(sub) {
  const base = baseOf(sub);
  const ext = base.lastIndexOf('.') > 0 ? base.slice(base.lastIndexOf('.') + 1).toLowerCase() : '';
  const segs = sub.split('/');
  const top = segs.length > 1 ? segs[0] : null;
  const tags = CODE_EXTS.has(ext) ? [`ext:${ext}`] : [];
  if (/^test_.*\.py$|_test\.py$/.test(base)) tags.push('py-test', top ? `py-test-top:${top}` : 'py-test-root');
  if (base === '__init__.py' && segs.length === 2) tags.push(`py-pkg:${top}`);
  if (ext === 'rb' && base.endsWith('_spec.rb')) tags.push('rb-spec');
  if (ext === 'rb' && /_test\.rb$|^test_.*\.rb$/.test(base)) tags.push('rb-test');
  if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(base) || (segs.includes('__tests__') && tags.length)) tags.push('js-test');
  if (top === 'test') tags.push('dir:test');
  if (sub.startsWith('src/test/')) tags.push('dir:src/test');
  return tags;
}

function gather(root, { stateInfo, env }) {
  const listing = listRepoFiles(root);
  const own = [stateInfo?.rel, env.ADC_HOME && toPosix(path.relative(root, path.resolve(env.ADC_HOME)))]
    .filter((r) => r && !r.startsWith('..') && !path.isAbsolute(r));
  const skipped = (rel) => rel.split('/').slice(0, -1).some((s) => SKIP_DIRS.has(s))
    || own.some((x) => rel === x || rel.startsWith(`${x}/`));
  const files = listing.files.map(normRel).filter((f) => f && !skipped(f)).slice(0, MAX_FILES);
  const relevant = new Map();
  const oversize = [];
  for (const rel of files) {
    const kind = relevantKind(rel);
    const full = kind && path.join(root, ...rel.split('/'));
    const st = kind && statOrNull(full);
    if (!st?.isFile()) continue;
    // yarn.lock's header tells Berry (`__metadata:`) from classic; nothing else is needed from lockfiles.
    if (kind === 'presence') relevant.set(rel, baseOf(rel) === 'yarn.lock' ? readHead(full) : null);
    else if (st.size <= MAX_READ) relevant.set(rel, readText(full, ''));
    else { relevant.set(rel, null); oversize.push(rel); }
  }
  // Project candidates: manifests outside fixture folders, Makefiles/justfiles with test targets.
  const candidates = new Set(['.']);
  for (const [rel, text] of relevant) {
    const base = baseOf(rel);
    const make = (MAKE_RE.test(base) || JUST_RE.test(base)) && parseMakeTargets(text, { just: JUST_RE.test(base) });
    if (!inFixtureDir(rel) && (MANIFEST_NAMES.has(base) || DOTNET_PROJ.test(base) || SLN.test(base) || make?.length)) {
      candidates.add(dirOf(rel));
    }
  }
  const facts = new Map([...candidates].map((d) => [d, new Set()]));
  for (const rel of files.filter((f) => !inFixtureDir(f))) {
    let d = dirOf(rel);
    while (!candidates.has(d)) d = dirOf(d);
    for (const t of fileTags(subPath(rel, d))) facts.get(d).add(t);
  }
  return { root, listing: listing.source, fileCount: files.length, relevant, facts, oversize, probes: {} };
}

/** Does `rel` name a directory of the checkout? Recorded so a cache hit can re-check it. */
function dirExists(g, rel) {
  if (rel == null || rel === '.') return rel === '.';
  if (!(rel in g.probes)) g.probes[rel] = isDir(path.join(g.root, ...rel.split('/')));
  return g.probes[rel];
}

function inputDigest(g, platform) {
  const rel = [...g.relevant].sort(([a], [b]) => cmp(a, b)).map(([p, t]) => [p, t == null ? null : sha256(t)]);
  const facts = [...g.facts].sort(([a], [b]) => cmp(a, b)).map(([d, s]) => [d, [...s].sort()]);
  return sha256(JSON.stringify([DETECT_SCHEMA, skillVersion(), platform, rel, facts]));
}

function makeCtx(g, { platform, tools }) {
  const byDir = Map.groupBy([...g.relevant.keys()].sort(), dirOf);
  const memo = new Map();
  const parsed = (kind, rel, parse) => {
    const key = `${kind}:${rel}`;
    if (!memo.has(key)) memo.set(key, g.relevant.get(rel) == null ? null : parse(g.relevant.get(rel)));
    return memo.get(key);
  };
  const ctx = {
    g, win: platform === 'win32', has: tools.has, warnings: [], ci: { steps: [] },
    inDir: (dir) => byDir.get(dir) || [],
    exists: (rel) => g.relevant.has(rel),
    read: (rel) => g.relevant.get(rel) ?? null,
    facts: (dir) => g.facts.get(dir) || new Set(),
    /** Inputs outside fixture folders whose base name is `name` (or matches it). */
    inputs: (name) => [...g.relevant.keys()].filter((r) => !inFixtureDir(r)
      && (typeof name === 'string' ? baseOf(r) === name : name.test(baseOf(r)))),
    json: (rel) => parsed('json', rel, (t) => {
      try { return JSON.parse(t); } catch { ctx.warn(`${rel}: invalid JSON; ignored`); return null; }
    }),
    toml: (rel) => parsed('toml', rel, (t) => parseToml(t, { lenient: true }).value),
    ini: (rel) => parsed('ini', rel, parseIni),
    warn: (msg) => { if (!ctx.warnings.includes(msg)) ctx.warnings.push(msg); },
    envPrefix: (env) => Object.entries(env || {})
      .map(([k, v]) => (ctx.win ? `set "${k}=${v}" && ` : `${k}=${portableArg(v).text} `)).join(''),
  };
  return ctx;
}

// ---------------------------------------------------------------------------
// Node (package.json: npm, pnpm, yarn, bun; jest, vitest, mocha, playwright, cypress, node:test, bun test)

const NPM_PLACEHOLDER = /no test specified/;
const JS_RUNNER_BINS = new Set(['jest', 'vitest', 'mocha', 'playwright', 'cypress']);
const JS_SUB = { playwright: 'test', cypress: 'run' };
const jsDep = (runner) => (runner === 'playwright' ? '@playwright/test' : runner);
const JEST_WRAPPERS = new Set(['react-scripts', 'craco', 'rescripts', 'react-app-rewired']);
const DELEGATE_BINS = new Set(['turbo', 'nx', 'lerna', 'wsrun', 'ultra', 'rush', 'moon']);
const LAUNCH_BINS = new Set(['node', 'tsx', 'bun', 'npm', 'pnpm', 'yarn', 'npx', ...JS_RUNNER_BINS, ...JEST_WRAPPERS]);
const NEUTRAL_BINS = new Set(['echo', 'exit', 'true', 'false', 'rimraf', 'rm', 'del', 'del-cli', 'mkdir', 'mkdirp',
  'cp', 'cpy', 'shx', 'tsc', 'vue-tsc', 'eslint', 'prettier', 'biome', 'cd', 'sleep', 'wait-on', 'node-gyp', 'husky',
  'printf', 'set', 'export', 'tsup', 'esbuild', 'webpack', 'vite', 'rollup', 'babel', 'swc', 'stylelint']);
// By lockfile priority: [lockfiles, frozen install, binary runner, script runner, test script].
const NODE_PMS = {
  pnpm: [['pnpm-lock.yaml'], 'pnpm install --frozen-lockfile', 'pnpm exec', 'pnpm run', 'pnpm test'],
  bun: [['bun.lock', 'bun.lockb'], 'bun install --frozen-lockfile', 'bunx --no-install', 'bun run', 'bun run test'],
  yarn: [['yarn.lock'], 'yarn install --frozen-lockfile', 'yarn', 'yarn run', 'yarn test'],
  npm: [['package-lock.json', 'npm-shrinkwrap.json'], 'npm ci', 'npx --no', 'npm run', 'npm test'],
};
const NODE_LOCKS = Object.values(NODE_PMS).flatMap((p) => p[0]);
const NODE_CONFIGS = {
  jest: /^jest\.config\.(?:[cm]?[jt]s|json)$/, vitest: /^vitest\.(?:config|workspace|projects)\.(?:[cm]?[jt]s|json)$/,
  playwright: /^playwright\.config\.[cm]?[jt]s$/, cypress: /^cypress\.config\.[cm]?[jt]s$/,
  mocha: /^\.mocharc\.(?:js|cjs|mjs|json|jsonc|ya?ml)$/,
};
const NODE_VALUED = new Set(['-r', '--import', '--require', '--loader', '--experimental-loader', '--env-file',
  '--conditions', ...['concurrency', 'timeout', 'name-pattern', 'skip-pattern', 'shard'].map((o) => `--test-${o}`)]);
// Mocha options that take a value (everything else that is not an option is a spec path).
const MOCHA_VALUED = new Set(['-r', '--require', '-t', '--timeout', '-s', '--slow', '-u', '--ui', '-R', '--reporter',
  '-O', '--reporter-option', '--reporter-options', '-g', '--grep', '-f', '--fgrep', '--file', '--ignore', '--exclude',
  '--extension', '--config', '--package', '-j', '--jobs', '--retries', '-n', '--node-option', '--loader', '--import']);
// [flags, options with a value] that would fight the report/retries flags or never end in a clean run.
const DROP_ARGS = {
  jest: [['--watch', '--watchAll', '--json', '--ci'], ['--outputFile', '--reporters', '--testResultsProcessor', '-o']],
  vitest: [['--watch', '-w', '--ui', '--open', '--run'], ['--reporter', '--outputFile']],
  mocha: [['--watch', '-w'], ['--reporter', '-R', '--reporter-option', '--reporter-options', '-O']],
  playwright: [['--ui', '--debug'], ['--reporter']],
  cypress: [['--headed', '--open'], ['--reporter', '--reporter-options', '-r', '-o']],
  'node-test': [['--watch'], ['--test-reporter', '--test-reporter-destination']],
  bun: [['--watch'], ['--reporter', '--reporter-outfile']],
};
const TYPECHECK_SCRIPTS = ['typecheck', 'type-check', 'check-types', 'types', 'tsc', 'check:types', 'types:check'];
const LINT_SCRIPTS = ['lint', 'eslint', 'lint:js', 'lint:all'];
const DEP_KEYS = ['dependencies', 'devDependencies', 'optionalDependencies'];
const binName = (t) => baseOf(toPosix(String(t || ''))).replace(/\.(?:cmd|exe|bat|ps1|js|mjs|cjs)$/i, '');

function nodeManager(ctx, dir, pkg) {
  const has = (f) => ctx.exists(J(dir, f));
  const field = typeof pkg?.packageManager === 'string' ? pkg.packageManager : '';
  const declared = /^(npm|pnpm|yarn|bun)@/.exec(field)?.[1];
  const found = Object.entries(NODE_PMS).map(([n, d]) => [n, d[0].find(has)]).filter(([, f]) => f);
  const pick = found.find(([n]) => found.length > 1 && n === declared) || found[0];
  const [name, lockfile] = pick || [declared || 'npm', null];
  const several = `${dir === '.' ? 'repository root' : dir}: several lockfiles (${found.map((x) => x[1]).join(', ')})`;
  if (found.length > 1) ctx.warn(`${several}; using ${lockfile}`);
  const [, frozen, exec, run, test] = NODE_PMS[name];
  const berry = name === 'yarn' && (has('.yarnrc.yml') || /^yarn@(?:[2-9]|\d{2,})/.test(field)
    || /^__metadata:/m.test(ctx.read(J(dir, 'yarn.lock')) || ''));
  const install = !lockfile ? (name === 'npm' ? 'npm install --no-package-lock --no-audit --no-fund' : null)
    : berry ? 'yarn install --immutable' : frozen;
  const entry = { name, lockfile, install, cwd: dir, frozen: Boolean(lockfile), ...(berry && { variant: 'berry' }) };
  const pnp = berry && (has('.pnp.cjs') || /nodeLinker:\s*["']?pnp/.test(ctx.read(J(dir, '.yarnrc.yml')) || ''));
  return { entry: { ...entry, ecosystem: 'node' }, exec, run, test, launcher: name, pnp };
}

function stripEnv(tokens) {
  const env = {};
  let crossEnv = false;
  let k = 0;
  for (; k < tokens.length; k++) {
    const t = tokens[k];
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(t);
    if (m) env[m[1]] = m[2];
    else if (t === 'cross-env' || t === 'cross-env-shell') crossEnv = true;
    else if (t === 'env' && /^[A-Za-z_]\w*=/.test(tokens[k + 1] || '')) continue;
    else if (binName(t) === 'dotenv' && tokens.indexOf('--', k) !== -1) k = tokens.indexOf('--', k);
    else break;
  }
  return { env, crossEnv, rest: tokens.slice(k) };
}

function stripLaunchers(tokens) {
  let t = tokens.slice();
  let coverage = null;
  const flags = (k, valued) => {
    while (k < t.length && t[k].startsWith('-')) k += valued?.test(t[k]) ? 2 : 1;
    return k;
  };
  for (let guard = 0; guard < 6 && t.length; guard++) {
    const b = binName(t[0]);
    if (b === 'npx') t = t.slice(flags(1, /^(?:-p|--package|-c|--call)$/));
    else if (b === 'pnpm' && (t[1] === 'exec' || t[1] === 'dlx')) t = t.slice(flags(2));
    else if (b === 'yarn' && t[1] === 'exec') t = t.slice(2);
    else if (b === 'bunx' || (b === 'bun' && t[1] === 'x')) t = t.slice(flags(b === 'bunx' ? 1 : 2));
    else if (b === 'npm' && t[1] === 'exec') t = t.slice(t.includes('--') ? t.indexOf('--') + 1 : 2);
    else if (b === 'c8' || b === 'nyc') {
      coverage = b;
      let k = 1;
      while (k < t.length && t[k].startsWith('-')) {
        k++;
        if (!t[k - 1].includes('=') && k < t.length && !t[k].startsWith('-') && !LAUNCH_BINS.has(binName(t[k]))) k++;
      }
      t = t.slice(k);
    } else break;
  }
  return { tokens: t, coverage };
}

/** Classify one script segment: a runner invocation, a script call, a workspace delegation, or neither. */
function classifySegment(tokens, scripts) {
  const { env, crossEnv, rest } = stripEnv(tokens);
  const { tokens: t, coverage } = stripLaunchers(rest);
  if (!t.length) return { kind: 'none' };
  const b = binName(t[0]);
  const args = t.slice(1);
  const runner = (name, head, more, extra) => ({ kind: 'runner', runner: name, head, args: more, env, crossEnv,
    coverage, ...extra });
  const delegate = { kind: 'delegate', via: `${b} ${args.join(' ')}`.trim() };
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(b)) {
    const words = args.filter((a) => !a.startsWith('-'));
    const w0 = words[0];
    const ws = b === 'pnpm' ? args.some((f) => /^(?:-r|--recursive|--filter(?:=.*)?|-F)$/.test(f))
      : b === 'npm' ? args.some((f) => /^(?:--workspaces|-ws|--workspace(?:=.*)?|-w)$/.test(f))
        : b === 'yarn' && (w0 === 'workspaces' || w0 === 'workspace');
    if (ws) return delegate;
    if (b === 'bun' && w0 === 'test') return runner('bun', ['bun', 'test'], args.slice(args.indexOf('test') + 1));
    if (['test', 't', 'tst'].includes(w0)) return { kind: 'script', name: 'test' };
    if (['run', 'run-script', 'rum', 'urn'].includes(w0) && words[1]) return { kind: 'script', name: words[1] };
    if (b !== 'npm' && w0 && scripts?.[w0] != null) return { kind: 'script', name: w0 };
    // `yarn <bin>` and `pnpm <bin>` run a dependency's binary when no script has that name.
    if ((b === 'yarn' || b === 'pnpm') && w0 && !['install', 'add', 'i', 'exec', 'dlx'].includes(w0)) {
      return classifySegment(args.slice(args.indexOf(w0)), scripts);
    }
    return { kind: 'other', bin: b };
  }
  if (['run-s', 'run-p', 'npm-run-all', 'npm-run-all2'].includes(b)) {
    return { kind: 'scripts', patterns: args.filter((a) => !a.startsWith('-')) };
  }
  if (DELEGATE_BINS.has(b)) return delegate;
  if (b === 'jest' || b === 'vitest' || b === 'mocha') return runner(b, [b], args);
  if (JEST_WRAPPERS.has(b) && args[0] === 'test') return runner('jest', [b, 'test'], args.slice(1));
  if (JS_SUB[b] && args[0] === JS_SUB[b]) return runner(b, [b, args[0]], args.slice(1));
  if ((b === 'node' || b === 'tsx') && args.includes('--test')) {
    const nodeOpts = [];
    const positionals = [];
    for (let k = 0; k < args.length; k++) {
      if (args[k] === '--test') continue;
      if (!args[k].startsWith('-')) positionals.push(args[k]);
      else {
        nodeOpts.push(args[k]);
        if (NODE_VALUED.has(args[k]) && args[k + 1] != null) nodeOpts.push(args[++k]);
      }
    }
    return runner('node-test', [b], [], { nodeOpts, positionals });
  }
  // `node ./packages/jest-cli/bin/jest.js` (a runner started through its bin script).
  const k = b === 'node' ? args.findIndex((a) => !a.startsWith('-')) : -1;
  const script = k === -1 ? null : binName(args[k]);
  if (JS_RUNNER_BINS.has(script) && (!JS_SUB[script] || args[k + 1] === JS_SUB[script])) {
    const at = k + 1 + (JS_SUB[script] ? 1 : 0);
    return runner(script, ['node', ...args.slice(0, at)], args.slice(at), { direct: true });
  }
  return { kind: NEUTRAL_BINS.has(b) ? 'neutral' : 'other', bin: b };
}

/** Follow a package.json script through nested script calls. */
function analyzeScript(name, scripts, seen = new Set(), depth = 0) {
  const out = { runners: [], delegates: [], unknown: [] };
  const text = scripts[name];
  if (typeof text !== 'string' || depth > 6 || seen.has(name) || (name === 'test' && NPM_PLACEHOLDER.test(text))) {
    return out;
  }
  seen.add(name);
  for (const seg of splitShell(text)) {
    const c = classifySegment(seg.tokens, scripts);
    if (c.kind === 'runner') out.runners.push({ ...c, via: name });
    else if (c.kind === 'delegate') out.delegates.push(c.via);
    else if (c.kind === 'other') out.unknown.push(c.bin);
    else if (c.kind === 'script' && scripts[c.name] == null) out.unknown.push(`script:${c.name}`);
    else if (c.kind === 'script' || c.kind === 'scripts') {
      const glob = (p) => new RegExp(`^${p.split('*').map(RegExp.escape).join('.*')}$`);
      const names = c.name ? [c.name] : Object.keys(scripts).filter((s) => c.patterns.some((p) => glob(p).test(s)));
      for (const nm of names) {
        const sub = analyzeScript(nm, scripts, seen, depth + 1);
        for (const key of Object.keys(out)) out[key].push(...sub[key]);
      }
    }
  }
  return out;
}

function mochaSpecs(args) {
  const out = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === '--spec' && args[k + 1] != null) out.push(args[++k]);
    else if (a.startsWith('--spec=')) out.push(a.slice(7));
    else if (!a.startsWith('-')) out.push(a);
    else if (!a.includes('=') && MOCHA_VALUED.has(a)) k++;
  }
  return out;
}

function filterArgs(runner, args) {
  const [flags, valued] = DROP_ARGS[runner] || [[], []];
  const out = [];
  for (let k = 0; k < args.length; k++) {
    const nm = args[k].split('=')[0];
    if (flags.includes(nm)) continue;
    if (!valued.includes(nm) && !valued.includes(nm.split('.')[0])) out.push(args[k]);
    else if (!args[k].includes('=') && args[k + 1] != null && !args[k + 1].startsWith('-')) k++;
  }
  if (runner === 'vitest' && ['run', 'watch', 'dev'].includes(out[0])) out.shift();
  return out;
}

/** The command for one runner occurrence, built for the project's package manager. */
function nodeRunner(ctx, pm, occ, source, deps) {
  const name = occ.runner;
  const args = filterArgs(name, occ.args || []);
  const exec = pm.exec.split(' ');
  const launch = occ.head[0] === 'tsx' ? [...exec, 'tsx'] : ['node'];
  let head = name === 'node-test' ? [...launch, ...filterArgs(name, occ.nodeOpts), '--test']
    : name === 'bun' ? ['bun', 'test'] : occ.direct ? [...occ.head] : [...exec, ...occ.head];
  if (name === 'vitest' && !occ.direct) head.push('run');
  if (name === 'jest') args.unshift('--ci');
  // react-scripts and friends watch by default unless told otherwise.
  if (name === 'jest' && JEST_WRAPPERS.has(occ.head[0])) args.push('--watchAll=false');
  const env = occ.env || {};
  let envText = ctx.envPrefix(env);
  if (Object.keys(env).length && occ.crossEnv && deps.has('cross-env')) {
    envText = `${pm.exec} cross-env ${Object.entries(env).map(([k, v]) => `${k}=${portableArg(v).text}`).join(' ')} `;
    if (head.slice(0, exec.length).join(' ') === pm.exec) head = head.slice(exec.length);
  }
  const paths = name === 'node-test' ? occ.positionals : [];
  const h = joinArgs(head.filter(Boolean));
  const rest = joinArgs([...args, ...paths]);
  const r = makeRunner(name, { cmd: `${envText}${h.text}${rest.text ? ` ${rest.text}` : ''}`, source });
  const specs = name === 'mocha' ? mochaSpecs(args) : [];
  if (specs.length) r.specs = specs;
  // node treats options after the first file pattern as test arguments: flags go before `paths`.
  if (name === 'node-test') r.base_cmd = `${envText}${h.text}`;
  if (name === 'node-test') r.paths = paths.map((x) => portableArg(x).text);
  if (Object.keys(env).length) r.env = env;
  if (occ.coverage) r.coverage_wrapper = occ.coverage;
  if (!h.portable || !rest.portable) r.portable = false;
  return r;
}

function configGlobs(name, text, section) {
  if (name === 'jest') return Array.isArray(section?.testMatch) ? section.testMatch : listOrOne(text, 'testMatch');
  if (name === 'cypress') return listOrOne(text, 'specPattern');
  if (name === 'vitest') {
    const at = (text || '').search(/\btest\s*:\s*\{/);
    return at === -1 ? null : listOrOne(text.slice(at, at + 6000), 'include');
  }
  if (name === 'playwright') {
    const dir = /\btestDir\s*:\s*(['"`])([^'"`]+)\1/.exec(text || '');
    const base = dir ? normRel(dir[2]) : '';
    const matches = listOrOne(text, 'testMatch');
    if (matches?.length) return matches.map((g) => (base ? `${base}/${normRel(g)}` : g));
    return base ? [`${base}/**`] : null;
  }
  if (name !== 'mocha') return null;
  if (section?.spec) return [].concat(section.spec);
  const t = (text || '').trim();
  const doc = t.startsWith('{') ? parseJsonc(t) : parseYamlAll(t)[0];
  return isObj(doc) && doc.spec ? [].concat(doc.spec) : listOrOne(t, 'spec');
}

function nodeConfigFile(ctx, dir, runner) {
  const files = ctx.inDir(dir);
  const vite = (r) => /^vite\.config\.[cm]?[jt]s$/.test(baseOf(r)) && /\btest\s*:\s*\{/.test(ctx.read(r) || '');
  return files.find((r) => NODE_CONFIGS[runner]?.test(baseOf(r))) || (runner === 'vitest' && files.find(vite)) || null;
}

function workspaceGlobs(ctx, dir, pkg) {
  const pnpm = parseYamlAll(ctx.read(J(dir, 'pnpm-workspace.yaml')) || '')[0];
  if (Array.isArray(pnpm?.packages)) return { globs: pnpm.packages.map(String), kind: 'pnpm-workspace.yaml' };
  const ws = pkg?.workspaces;
  const globs = Array.isArray(ws) ? ws : Array.isArray(ws?.packages) ? ws.packages : null;
  if (globs) return { globs: globs.map(String), kind: 'package.json workspaces' };
  const lerna = ctx.json(J(dir, 'lerna.json'));
  return Array.isArray(lerna?.packages) ? { globs: lerna.packages.map(String), kind: 'lerna.json' } : null;
}

const matchesWorkspace = (sub, globs) => globs.some((x) => !x.startsWith('!') && anchored(sub, x))
  && !globs.some((x) => x.startsWith('!') && (anchored(sub, x.slice(1)) || anchored(`${sub}/x`, x.slice(1))));

/** Coverage producers, the type checker and the linter of a Node project (script first, else config file). */
function nodeTools(ctx, u, { dir, pm, pkg, scripts, deps, tsconfig }) {
  const names = new Set(u.runners.map((r) => r.name));
  const cov = (name, format, source) => u.coverage.push({ name, format, source });
  if (names.has('vitest') && ['@vitest/coverage-v8', '@vitest/coverage-istanbul'].some((d) => deps.has(d))) {
    cov('vitest-coverage', 'istanbul', 'package.json devDependencies');
  }
  if (names.has('jest')) cov('jest-coverage', 'istanbul', 'built into jest');
  if (names.has('node-test')) cov('node-test-coverage', 'lcov', 'built into node --test');
  for (const c of ['c8', 'nyc']) if (deps.has(c)) cov(c, 'lcov', 'package.json devDependencies');
  const tc = TYPECHECK_SCRIPTS.find((s) => typeof scripts[s] === 'string');
  const tcName = /vue-tsc/.test(scripts[tc]) ? 'vue-tsc' : 'tsc';
  if (tc) u.typecheck.push({ name: tcName, cmd: `${pm.run} ${tc}`, source: `package.json scripts.${tc}` });
  else if (tsconfig) u.typecheck.push(cfgTool('tsc', `${pm.exec} tsc --noEmit`, J(dir, 'tsconfig.json')));
  const ls = LINT_SCRIPTS.find((s) => typeof scripts[s] === 'string');
  const eslint = ctx.inDir(dir).find((r) => /^(?:eslint\.config\.[cm]?[jt]s|\.eslintrc(?:\.\w+)?)$/.test(baseOf(r)));
  const biome = ctx.inDir(dir).find((r) => /^biome\.jsonc?$/.test(baseOf(r)));
  const lsName = /biome/.test(scripts[ls]) ? 'biome' : 'eslint';
  if (ls) u.lint.push({ name: lsName, cmd: `${pm.run} ${ls}`, source: `package.json scripts.${ls}` });
  else if (eslint) u.lint.push(cfgTool('eslint', `${pm.exec} eslint .`, eslint));
  else if (isObj(pkg.eslintConfig)) {
    u.lint.push({ ...cfgTool('eslint', `${pm.exec} eslint .`, u.manifests[0]), source: 'package.json eslintConfig' });
  } else if (biome) u.lint.push(cfgTool('biome', `${pm.exec} biome lint .`, biome));
}

function detectNode(ctx) {
  const dirs = ctx.inputs('package.json').map(dirOf).sort((a, b) => a.length - b.length || cmp(a, b));
  const pkgs = new Map(dirs.map((d) => [d, ctx.json(J(d, 'package.json')) || {}]));
  const wsRoots = new Map(dirs.map((d) => [d, workspaceGlobs(ctx, d, pkgs.get(d))]).filter(([, w]) => w));
  const units = [];
  for (const dir of dirs) {
    const pkg = pkgs.get(dir);
    let wsRoot = null;
    let outside = false;
    for (const [w, info] of wsRoots) {
      if (w === dir || !under(dir, w)) continue;
      if (matchesWorkspace(subPath(dir, w), info.globs)) { if (!wsRoot || w.length > wsRoot.length) wsRoot = w; }
      else if (!NODE_LOCKS.some((f) => ctx.exists(J(dir, f)))) outside = true;
    }
    // A package inside a workspace that is not a member and has no lockfile of its own is no project.
    if (outside && !wsRoot) continue;
    const lockDir = wsRoot || dir;
    const pm = nodeManager(ctx, lockDir, pkgs.get(lockDir));
    const u = newUnit(dir, 'node', J(dir, 'package.json'));
    const tsconfig = ctx.exists(J(dir, 'tsconfig.json'));
    const facts = ctx.facts(dir);
    const ts = tsconfig || ['ts', 'tsx', 'mts', 'cts'].some((e) => facts.has(`ext:${e}`));
    u.languages.push(ts ? 'typescript' : 'javascript');
    u.managers.push({ ...pm.entry, ...(wsRoot ? { workspace: true } : {}) });
    if (!pm.entry.lockfile) u.warnings.push(`${u.manifests[0]}: no lockfile committed; the install is not frozen`);
    const ws = wsRoots.get(dir) || wsRoots.get(wsRoot);
    const role = wsRoots.has(dir) ? { role: 'root', globs: ws?.globs } : { role: 'member', root: wsRoot };
    if (ws) u.workspace = { kind: ws.kind, ...role };
    const scripts = isObj(pkg.scripts) ? pkg.scripts : {};
    const own = new Set(DEP_KEYS.flatMap((k) => Object.keys(pkg[k] || {})));
    const deps = new Set([...own, ...Object.keys((wsRoot && pkgs.get(wsRoot).devDependencies) || {})]);
    u.test_script = typeof scripts.test === 'string' && !NPM_PLACEHOLDER.test(scripts.test) ? scripts.test : null;
    const seen = new Set();
    if (u.test_script) {
      const a = analyzeScript('test', scripts);
      for (const occ of a.runners.filter((o) => !seen.has(o.runner) && seen.add(o.runner))) {
        const via = occ.via === 'test' ? '' : ` -> scripts.${occ.via}`;
        u.runners.push(nodeRunner(ctx, pm, occ, `package.json scripts.test${via}`, deps));
      }
      if (a.delegates.length && !a.runners.length) Object.assign(u, { delegates: true, delegates_via: a.delegates });
      else if (!a.runners.length && a.unknown.length) {
        const wraps = uniq(a.unknown).slice(0, 5);
        u.runners.push(makeRunner('npm-script', { cmd: pm.test, source: 'package.json scripts.test', wraps }));
      }
    }
    // Runners configured or installed but not named by the test script.
    for (const name of ['vitest', 'jest', 'mocha', 'playwright', 'cypress'].filter((n) => !seen.has(n))) {
      const cfg = nodeConfigFile(ctx, dir, name);
      const listed = own.has(jsDep(name));
      // A delegating workspace root only runs a suite its own config spreads over the members.
      const spreads = cfg && /\b(?:projects|workspace)\s*:|vitest\.(?:workspace|projects)\./.test(cfg + ctx.read(cfg));
      if (u.delegates ? !spreads : !cfg && !listed && !(name === 'jest' && isObj(pkg.jest))) continue;
      const occ = { runner: name, head: JS_SUB[name] ? [name, JS_SUB[name]] : [name], args: [] };
      u.runners.push(nodeRunner(ctx, pm, occ, cfg || `package.json ${listed ? 'devDependencies' : 'jest'}`, deps));
    }
    if (!u.runners.length && !u.delegates && pm.entry.name === 'bun' && facts.has('js-test')) {
      u.runners.push(makeRunner('bun', { source: `${pm.entry.lockfile} + test files` }));
    }
    // Test globs: the runner's own paths or config, else its defaults.
    for (const r of u.runners) {
      const cfg = r.name === 'node-test' ? null : nodeConfigFile(ctx, dir, r.name);
      const section = r.name === 'jest' ? pkg.jest : r.name === 'mocha' ? pkg.mocha : null;
      const paths = r.name === 'node-test' && r.paths.length ? r.paths.map((p) => p.replace(/^"|"$/g, '')) : null;
      const globs = (paths || r.specs || configGlobs(r.name, cfg && ctx.read(cfg), section) || []).map(normalizeGlob)
        .filter(Boolean);
      if (cfg && globs.length) r.config = cfg;
      u.test_globs.push(...(globs.length ? globs : RUNNERS[r.name].test_globs));
      const plainNode = r.name === 'node-test' && !/\b(?:tsx|cross-env)\b/.test(r.cmd);
      r.available = ctx.has(r.name === 'bun' ? 'bun' : plainNode ? 'node' : pm.launcher);
    }
    nodeTools(ctx, u, { dir, pm, pkg, scripts, deps, tsconfig });
    if (pm.pnp) u.warnings.push(`${J(lockDir, '.yarnrc.yml')}: Yarn Plug'n'Play; commands run through \`yarn\``);
    const needed = pm.entry.install || pm.exec;
    if (!ctx.has(pm.launcher)) u.warnings.push(`${pm.launcher} is not on PATH (needed for ${needed})`);
    units.push(u);
  }
  return units;
}

// ---------------------------------------------------------------------------
// Python (pyproject/setup/pytest/tox; uv, poetry, pdm, pipenv, pip; pytest, unittest)

const PY_MANIFESTS = ['pyproject.toml', 'setup.py', 'setup.cfg', 'Pipfile', 'pytest.ini', '.pytest.ini',
  'pytest.toml', '.pytest.toml', 'tox.ini'];
const REQUIREMENTS = ['requirements.txt', 'requirements-dev.txt', 'requirements_dev.txt', 'requirements-test.txt',
  'dev-requirements.txt', 'test-requirements.txt'];
// Locked managers: [lockfile, name, frozen install, run prefix].
const PY_LOCKED = [['uv.lock', 'uv', 'uv sync --locked', 'uv run --frozen'],
  ['poetry.lock', 'poetry', 'poetry install --no-interaction', 'poetry run'],
  ['pdm.lock', 'pdm', 'pdm install --frozen-lockfile', 'pdm run'],
  ['Pipfile.lock', 'pipenv', 'pipenv install --deploy --dev', 'pipenv run']];
const normPkg = (n) => String(n || '').trim().toLowerCase().replace(/[-_.]+/g, '-');

/** Normalized names of every dependency a Python project declares, in any of its manifests. */
function pyDeps(ctx, dir, pp) {
  const out = new Set();
  const add = (list) => {
    for (const x of [].concat(list || [])) {
      const n = typeof x === 'string' && /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(x);
      if (n) out.add(normPkg(n[1]));
    }
  };
  const keys = (t) => { if (isObj(t)) for (const k of Object.keys(t)) out.add(normPkg(k)); };
  const vals = (o) => (isObj(o) ? Object.values(o) : []);
  const tool = pp?.tool || {};
  const poetry = tool.poetry || {};
  const cfg = ctx.ini(J(dir, 'setup.cfg'));
  const pipfile = ctx.toml(J(dir, 'Pipfile'));
  const lines = (s) => String(s || '').split(/\r?\n/).filter((l) => !/^\s*(?:#|-)/.test(l));
  const project = pp?.project || {};
  for (const v of [project.dependencies, tool.uv?.['dev-dependencies'], ...vals(project['optional-dependencies']),
    ...vals(pp?.['dependency-groups']), ...vals(tool.pdm?.['dev-dependencies'])]) add(v);
  for (const t of [poetry.dependencies, poetry['dev-dependencies'], pipfile?.packages, pipfile?.['dev-packages'],
    ...vals(poetry.group).map((g) => g?.dependencies)]) keys(t);
  for (const r of ctx.inDir(dir).filter((x) => REQ_RE.test(baseOf(x)))) add(lines(ctx.read(r)));
  for (const v of [cfg?.options?.install_requires, ...vals(cfg?.['options.extras_require'])]) add(lines(v));
  for (const [sec, v] of Object.entries(ctx.ini(J(dir, 'tox.ini')) || {})) if (/^testenv/.test(sec)) add(lines(v.deps));
  const setupPy = ctx.read(J(dir, 'setup.py')) || '';
  for (const m of setupPy.matchAll(/['"](pytest[A-Za-z0-9._-]*)\s*(?:[<>=!~;[][^'"]*)?['"]/gi)) out.add(normPkg(m[1]));
  return out;
}

/** pytest settings by pytest's own precedence (first file wins, never merged). */
function pytestConfig(ctx, dir, pp) {
  const words = (v) => [].concat(v || []).flatMap((x) => String(x).split(/\s+/)).filter(Boolean);
  const conf = (s, file) => ({ file, testpaths: words(s.testpaths), python_files: words(s.python_files),
    addopts: s.addopts ? [].concat(s.addopts).join(' ') : null });
  for (const f of ['pytest.toml', '.pytest.toml', 'pytest.ini', '.pytest.ini']) {
    const t = f.endsWith('.toml') ? ctx.toml(J(dir, f)) : ctx.ini(J(dir, f));
    if (t) return conf(t.pytest || {}, J(dir, f));
  }
  const tp = pp?.tool?.pytest;
  const pyproject = J(dir, 'pyproject.toml');
  if (isObj(tp) && tp.ini_options) return conf(tp.ini_options, `${pyproject} [tool.pytest.ini_options]`);
  if (isObj(tp)) return conf(tp, `${pyproject} [tool.pytest]`);
  for (const [f, sec] of [['tox.ini', 'pytest'], ['setup.cfg', 'tool:pytest']]) {
    const t = ctx.ini(J(dir, f))?.[sec];
    if (t) return conf(t, `${J(dir, f)} [${sec}]`);
  }
  return null;
}

/** The package manager (`mgr`), the prefix that runs tools in its environment, and the manifest it reads. */
function pythonManager(ctx, dir, { wsRoot, uvWs, tool, py, file }) {
  const locked = PY_LOCKED.find(([f, n]) => ctx.exists(J(n === 'uv' ? wsRoot || dir : dir, f)));
  if (locked) {
    const [lockfile, name, install, prefix] = locked;
    const all = name === 'uv' && (wsRoot || uvWs.has(dir)) ? ' --all-packages' : '';
    const cwd = name === 'uv' ? wsRoot || dir : dir;
    return { mgr: { name, lockfile, install: `${install}${all}`, cwd, frozen: true }, prefix };
  }
  const req = REQUIREMENTS.map(file).find(Boolean);
  if (req && /--hash=/.test(ctx.read(req) || '')) {
    const install = `${py} -m pip install --require-hashes -r ${baseOf(req)}`;
    return { mgr: { name: 'pip', lockfile: baseOf(req), install, cwd: dir, frozen: true } };
  }
  const hint = req ? `${py} -m pip install -r ${baseOf(req)}` : tool.poetry ? 'poetry install' : 'uv sync';
  const name = req ? 'pip' : tool.poetry ? 'poetry' : 'uv';
  if (!req && !tool.poetry && !tool.uv && !file('uv.toml')) return { mgr: null };
  const mgr = { name, lockfile: null, install: null, cwd: dir, frozen: false, install_hint: hint };
  return { mgr, prefix: req ? null : `${name} run`, manifest: req || J(dir, 'pyproject.toml') };
}

function detectPython(ctx) {
  const dirs = new Set(PY_MANIFESTS.flatMap((f) => ctx.inputs(f)).map(dirOf));
  const rf = ctx.facts('.');
  const rootReqs = rf.has('ext:py') && ctx.inDir('.').some((r) => REQ_RE.test(baseOf(r)));
  if (rf.has('py-test') || ctx.exists('conftest.py') || rootReqs) dirs.add('.');
  if (!dirs.size) return [];
  // uv workspaces: members share the root's lockfile and environment.
  const uvWs = new Map();
  for (const d of dirs) {
    const ws = ctx.toml(J(d, 'pyproject.toml'))?.tool?.uv?.workspace;
    const exclude = [].concat(ws?.exclude || []).map(String);
    if (Array.isArray(ws?.members)) uvWs.set(d, { members: ws.members.map(String), exclude });
  }
  const py = ctx.win || ctx.has('python') || !ctx.has('python3') ? 'python' : 'python3';
  const units = [];
  for (const dir of [...dirs].sort()) {
    const ppFile = J(dir, 'pyproject.toml');
    const pp = ctx.toml(ppFile);
    const tool = pp?.tool || {};
    const file = (f) => (ctx.exists(J(dir, f)) ? J(dir, f) : null);
    const u = newUnit(dir, 'python', ...PY_MANIFESTS.map(file).filter(Boolean));
    u.languages.push('python');
    let wsRoot = null;
    for (const [w, info] of uvWs) {
      const sub = w !== dir && under(dir, w) ? subPath(dir, w) : null;
      if (sub && info.members.some((m) => anchored(sub, m)) && !info.exclude.some((m) => anchored(sub, m))) wsRoot = w;
    }
    if (uvWs.has(dir)) u.workspace = { kind: 'uv workspace', role: 'root', globs: uvWs.get(dir).members };
    else if (wsRoot) u.workspace = { kind: 'uv workspace', role: 'member', root: wsRoot };
    const { mgr, prefix = null, manifest } = pythonManager(ctx, dir, { wsRoot, uvWs, tool, py, file });
    if (mgr) u.managers.push({ ...mgr, ...(wsRoot ? { workspace: true } : {}), ecosystem: 'python' });
    if (mgr && !mgr.frozen) u.warnings.push(`${manifest}: no lockfile with hashes; the install is not frozen`);
    const run = (name) => (prefix ? `${prefix} ${name}` : `${py} -m ${name}`);
    const launcher = prefix ? prefix.split(' ')[0] : py;
    const deps = pyDeps(ctx, dir, pp);
    const cfg = pytestConfig(ctx, dir, pp);
    const facts = ctx.facts(dir);
    const conftest = ctx.inputs('conftest.py').some((r) => under(r, dir));
    const ciStep = ctx.ci.steps.find((st) => st.cwd === dir && /\bpytest\b/.test(st.cmd));
    if (cfg || conftest || deps.has('pytest') || ciStep) {
      const source = cfg?.file || (conftest ? 'conftest.py' : deps.has('pytest') ? 'pytest dependency' : ciRef(ciStep));
      const r = makeRunner('pytest', { cmd: run('pytest'), source, available: ctx.has(launcher) });
      // A declared pytest-rerunfailures stays loaded (blocking it breaks its markers under --strict-markers);
      // --reruns=0 turns the CLI reruns off, but @pytest.mark.flaky(reruns=...) in test code still reruns.
      const rerun = deps.has('pytest-rerunfailures');
      const flaky = deps.has('flaky') ? ' -p no:flaky' : '';
      const mechanism = `${rerun ? '--reruns=0' : '-p no:rerunfailures'}${flaky}`;
      r.retries_off = { mechanism, coverage: rerun ? 'partial' : 'full' };
      if (rerun) r.retries_note = '@pytest.mark.flaky(reruns=...) in test code overrides --reruns';
      if (cfg?.addopts) r.addopts = cfg.addopts;
      u.runners.push(r);
      const files = cfg?.python_files.length ? cfg.python_files : ['test_*.py', '*_test.py'];
      const paths = cfg?.testpaths.map((p) => normalizeGlob(p.endsWith('/') ? p : `${p}/`)) || [];
      u.test_globs.push(...files.map(normRel), 'conftest.py');
      u.test_globs.push(...(paths.length ? paths : ['tests/**', ...(facts.has('dir:test') ? ['test/**'] : [])]));
    } else if (facts.has('py-test')) {
      const tops = [...facts].filter((t) => t.startsWith('py-test-top:')).map((t) => t.slice(12));
      // Discovery from the root only descends into packages: a plain tests/ folder needs -s (the root
      // stays importable because `python -m` puts the working directory on sys.path).
      const start = tops.length === 1 && ['tests', 'test'].includes(tops[0]) && !facts.has('py-test-root')
        && !facts.has(`py-pkg:${tops[0]}`) ? tops[0] : null;
      const cmd = `${prefix ? `${prefix} python` : py} -m unittest discover${start ? ` -s ${start}` : ''}`;
      const source = 'test_*.py files (no pytest configuration or dependency)';
      u.runners.push(makeRunner('unittest', { cmd, source, available: ctx.has(launcher) }));
      u.test_globs.push(...RUNNERS.unittest.test_globs, ...(start ? [`${start}/**`] : []));
    }
    const covTool = ['pytest-cov', 'coverage'].find((d) => deps.has(d));
    if (u.runners.length && covTool) u.coverage.push({ name: covTool, format: 'cobertura', source: 'python deps' });
    // Type checkers and linters, by their config files.
    const first = (...c) => c.find(Boolean) || null;
    const setupCfg = ctx.ini(J(dir, 'setup.cfg')) || {};
    const mypy = first(file('mypy.ini'), file('.mypy.ini'), tool.mypy && ppFile, setupCfg.mypy && J(dir, 'setup.cfg'));
    const mypyFiles = mypy && (mypy === ppFile ? tool.mypy.files : /^\s*files\s*=/m.test(ctx.read(mypy) || ''));
    if (mypy) u.typecheck.push(cfgTool('mypy', `${run('mypy')}${mypyFiles ? '' : ' .'}`, mypy));
    const pyright = first(file('pyrightconfig.json'), tool.pyright && ppFile);
    if (pyright) u.typecheck.push(cfgTool('pyright', prefix ? `${prefix} pyright` : 'pyright', pyright));
    const ruff = first(file('ruff.toml'), file('.ruff.toml'), tool.ruff && ppFile);
    if (ruff) u.lint.push(cfgTool('ruff', `${run('ruff')} check .`, ruff));
    const tox = ctx.ini(J(dir, 'tox.ini')) || {};
    const flake8 = first(file('.flake8'), setupCfg.flake8 && J(dir, 'setup.cfg'), tox.flake8 && J(dir, 'tox.ini'));
    if (flake8) u.lint.push(cfgTool('flake8', run('flake8'), flake8));
    const needed = mgr?.install || prefix;
    if (prefix && !ctx.has(launcher)) u.warnings.push(`${launcher} is not on PATH (needed for ${needed})`);
    units.push(u);
  }
  return units;
}

// ---------------------------------------------------------------------------
// Go, Rust

function detectGo(ctx) {
  const work = ctx.inputs('go.work').map(dirOf);
  return ctx.inputs('go.mod').map(dirOf).sort().map((dir) => {
    const mod = J(dir, 'go.mod');
    const u = newUnit(dir, 'go', mod);
    u.languages.push('go');
    const name = /^module\s+(\S+)/m.exec(ctx.read(mod) || '');
    if (name) u.module = name[1];
    const w = work.filter((x) => under(dir, x)).sort((a, b) => b.length - a.length)[0];
    if (w != null) u.workspace = { kind: 'go.work', role: w === dir ? 'root' : 'member', root: w };
    u.managers.push({ name: 'go', lockfile: ctx.exists(J(dir, 'go.sum')) ? 'go.sum' : null, install: 'go mod download',
      lock_check: 'go mod tidy -diff', cwd: dir, frozen: true, ecosystem: 'go' });
    u.runners.push(makeRunner('go', { source: mod, available: ctx.has('go') }));
    u.test_globs.push(...RUNNERS.go.test_globs);
    u.typecheck.push({ name: 'go-vet', cmd: 'go vet ./...', source: mod });
    u.coverage.push({ name: 'go-cover', format: 'go-cover', source: 'built into go test' });
    const golangci = [...ctx.inDir(dir), ...ctx.inDir('.')].find((r) => /^\.golangci\./.test(baseOf(r)));
    if (golangci) u.lint.push(cfgTool('golangci-lint', 'golangci-lint run', golangci));
    if (!ctx.has('go')) u.warnings.push('go is not on PATH');
    return u;
  });
}

function detectRust(ctx) {
  const crates = ctx.inputs('Cargo.toml').map(dirOf).sort((a, b) => a.length - b.length);
  const toml = (d) => ctx.toml(J(d, 'Cargo.toml')) || {};
  const workspaces = crates.filter((d) => toml(d).workspace);
  const units = [];
  for (const dir of crates) {
    // Members are tested through their workspace; excluded crates stay projects of their own.
    const owner = workspaces.filter((w) => w !== dir && under(dir, w)).sort((a, b) => b.length - a.length)[0];
    const sub = owner != null ? subPath(dir, owner) : null;
    const excluded = (x) => under(sub, normRel(String(x))) || anchored(sub, String(x));
    if (owner != null && ![].concat(toml(owner).workspace.exclude || []).some(excluded)) continue;
    const ws = toml(dir).workspace;
    const flag = ws ? ' --workspace' : '';
    const manifest = J(dir, 'Cargo.toml');
    const u = newUnit(dir, 'rust', manifest);
    u.languages.push('rust');
    if (ws) u.workspace = { kind: 'cargo workspace', role: 'root', globs: [].concat(ws.members || []).map(String) };
    const locked = ctx.exists(J(dir, 'Cargo.lock'));
    const install = `cargo fetch${locked ? ' --locked' : ''}`;
    u.managers.push({ name: 'cargo', lockfile: locked ? 'Cargo.lock' : null, install, cwd: dir, frozen: locked,
      ecosystem: 'rust' });
    if (!locked) u.warnings.push(`${manifest}: no Cargo.lock committed; the fetch is not frozen`);
    const cargo = makeRunner('cargo', { cmd: `cargo test${flag} --no-fail-fast`, source: manifest });
    cargo.available = ctx.has('cargo');
    const cfgFile = J(dir, '.config/nextest.toml');
    const configured = ctx.exists(cfgFile);
    const installed = ctx.has('cargo-nextest');
    if (configured || installed) {
      const nextest = makeRunner('nextest', { cmd: `cargo nextest run${flag} --no-fail-fast`, available: installed,
        source: configured ? cfgFile : 'cargo-nextest on PATH', ...(configured ? { config: cfgFile } : {}) });
      const profiles = (configured && ctx.toml(cfgFile)?.profile) || {};
      const names = Object.keys(profiles).filter((p) => profiles[p]?.junit?.path);
      const pick = names.includes('ci') ? 'ci' : names[0];
      const reportPath = pick && `target/nextest/${pick}/${normRel(String(profiles[pick].junit.path))}`;
      if (pick) nextest.report = junit(`--profile ${pick}`, { path: reportPath });
      // The configured runner first, but only where it can run; plain cargo test is the fallback.
      u.runners.push(...(installed ? [nextest, cargo] : [cargo, nextest]));
      if (!installed) u.warnings.push(`${cfgFile} configures cargo-nextest, which is not installed; using cargo test`);
    } else u.runners.push(cargo);
    u.test_globs.push('tests/**', ...(ws ? ['**/tests/**'] : []));
    u.typecheck.push({ name: 'cargo-check', cmd: `cargo check --all-targets${flag}`, source: manifest });
    const llvmCov = { name: 'cargo-llvm-cov', format: 'lcov', source: 'cargo-llvm-cov on PATH' };
    if (ctx.has('cargo-llvm-cov')) u.coverage.push(llvmCov);
    const clippy = ['clippy.toml', '.clippy.toml'].map((f) => J(dir, f)).find(ctx.exists);
    if (clippy) u.lint.push(cfgTool('clippy', `cargo clippy --all-targets${flag}`, clippy));
    units.push(u);
  }
  return units;
}

// ---------------------------------------------------------------------------
// .NET, JVM, Ruby

const TEST_SDK = new RegExp(`^(?:${['Microsoft\\.NET\\.Test\\.Sdk', 'xunit(?:\\.v3)?', 'xunit\\.runner\\.visualstudio',
  'nunit', 'NUnit3TestAdapter', 'MSTest(?:\\.TestFramework|\\.TestAdapter)?', 'TUnit(?:\\.Engine)?', 'Expecto']
  .join('|')})$`, 'i');
const COVERLET = /^(?:coverlet\.(?:collector|msbuild)|Microsoft\.Testing\.Extensions\.CodeCoverage)$/i;

function csprojInfo(text, file) {
  const t = text || '';
  const pkgs = [...t.matchAll(/<PackageReference\b[^>]*\b(?:Include|Update)\s*=\s*"([^"]+)"/gi)].map((m) => m[1]);
  const mstestSdk = /<Project\b[^>]*\bSdk\s*=\s*"[^"]*MSTest\.Sdk/i.test(t);
  const isTest = /<IsTestProject>\s*true\s*</i.test(t) || pkgs.some((p) => TEST_SDK.test(p)) || mstestSdk
    || /[.]?Tests?\.(?:cs|fs|vb)proj$/i.test(baseOf(file));
  const trx = mstestSdk || pkgs.some((p) => /^(?:Microsoft\.Testing\.Extensions\.TrxReport|MSTest)$/i.test(p));
  return { file, pkgs, isTest, trx, lang: { fsproj: 'fsharp', vbproj: 'vb' }[file.split('.').pop()] || 'csharp' };
}

function detectDotnet(ctx) {
  const slns = ctx.inputs(SLN);
  const projs = ctx.inputs(DOTNET_PROJ).map((f) => csprojInfo(ctx.read(f), f));
  const slnDirs = uniq(slns.map(dirOf)).sort((a, b) => b.length - a.length);
  const slnIn = (d) => slns.filter((s) => dirOf(s) === d).sort()[0];
  const groups = new Map(slnDirs.map((d) => [d, { dir: d, target: slnIn(d), projs: [] }]));
  // Projects belong to the nearest solution; a test project without one is a group of its own.
  for (const p of projs) {
    const d = slnDirs.find((s) => under(p.file, s)) ?? (p.isTest ? dirOf(p.file) : null);
    if (d == null) continue;
    const several = projs.filter((x) => dirOf(x.file) === d).length > 1;
    if (!groups.has(d)) groups.set(d, { dir: d, target: several ? p.file : null, projs: [] });
    groups.get(d).projs.push(p);
  }
  const globalJson = (dir) => {
    for (let d = dir; ; d = dirOf(d)) { const j = ctx.json(J(d, 'global.json')); if (j || d === '.') return j; }
  };
  return [...groups.values()].sort((a, b) => cmp(a.dir, b.dir)).map((grp) => {
    const tests = grp.projs.filter((p) => p.isTest);
    const u = newUnit(grp.dir, 'dotnet', ...(grp.target ? [grp.target] : []), ...grp.projs.map((p) => p.file));
    u.languages.push(...uniq(grp.projs.map((p) => p.lang)));
    const target = grp.target ? portableArg(baseOf(grp.target)).text : null;
    const tArg = target ? ` ${target}` : '';
    const locked = grp.projs.some((p) => ctx.exists(J(dirOf(p.file), 'packages.lock.json')));
    u.managers.push({ name: 'nuget', lockfile: locked ? 'packages.lock.json' : null, cwd: grp.dir, frozen: locked,
      install: `dotnet restore${tArg}${locked ? ' --locked-mode' : ''}`, ecosystem: 'dotnet' });
    if (tests.length) {
      const mtp = /Microsoft\.Testing\.Platform/i.test(String(globalJson(grp.dir)?.test?.runner || ''));
      const r = makeRunner('dotnet', { cmd: `dotnet test${tArg}`, platform: mtp ? 'mtp' : 'vstest',
        source: grp.target || tests[0].file, available: ctx.has('dotnet') });
      if (mtp) {
        r.cmd = `dotnet test${target ? ` ${SLN.test(grp.target) ? '--solution' : '--project'} ${target}` : ''}`;
        const trx = { ...r.report, flag: '--report-trx --results-directory <d>' };
        r.report = tests.every((p) => p.trx) ? trx : structuredClone(SUMMARY);
        const mechanism = 'Microsoft.Testing.Platform retries only with --retry-failed-tests, which is never passed';
        r.retries_off = { mechanism, coverage: 'full' };
      }
      u.runners.push(r);
      const dirs = tests.map((p) => subPath(dirOf(p.file), grp.dir)).filter((d) => d && d !== '.');
      u.test_globs.push(...uniq(dirs).map((d) => `${d}/**`), '**/*Tests*/**');
      const cov = tests.flatMap((p) => p.pkgs).find((x) => COVERLET.test(x));
      if (cov) u.coverage.push({ name: cov.toLowerCase(), format: 'cobertura', source: 'PackageReference' });
    }
    const source = grp.target || grp.projs[0]?.file || grp.dir;
    u.typecheck.push({ name: 'dotnet-build', cmd: `dotnet build${tArg} --nologo`, source });
    if (!ctx.has('dotnet')) u.warnings.push('dotnet is not on PATH');
    return u;
  });
}

const MAVEN_TEST_DEP = /<artifactId>\s*(?:junit|junit-jupiter[\w-]*|testng)\s*</;
const GRADLE_TEST_DEP = /\btest(?:Implementation|RuntimeOnly)\b|useJUnitPlatform|junit/;

function jvmLanguages(ctx, dir, texts) {
  const f = ctx.facts(dir);
  const other = ['kt', 'kts', 'scala', 'groovy'].some((e) => f.has(`ext:${e}`));
  const kotlin = f.has('ext:kt') || /org\.jetbrains\.kotlin|kotlin\(/.test(texts);
  return [(f.has('ext:java') || !other) && 'java', kotlin && 'kotlin', f.has('ext:scala') && 'scala',
    f.has('ext:groovy') && 'groovy'].filter(Boolean);
}

/** One Maven or Gradle build (`b`: tool, wrapper names, test and compile arguments, subprojects, signals). */
function jvmUnit(ctx, dir, files, text, b) {
  const u = newUnit(dir, 'jvm', ...files);
  u.languages.push(...jvmLanguages(ctx, dir, text));
  // The project's wrapper script (`./mvnw`; `mvnw.cmd` on Windows) wins over the tool on PATH.
  const wrapped = ctx.exists(J(dir, ctx.win ? b.win : b.nix));
  const bin = !wrapped ? b.tool : ctx.win ? b.win : `./${b.nix}`;
  u.managers.push({ name: b.manager, lockfile: b.lockfile ?? null, install: null, offline_flag: b.offline, cwd: dir,
    frozen: false, ecosystem: 'jvm' });
  if (ctx.facts(dir).has('dir:src/test') || b.subs.length || b.tested) {
    const r = makeRunner(b.manager, { cmd: `${bin} ${b.test}`, source: files[0] });
    r.available = wrapped || ctx.has(b.tool);
    if (b.subs.length) r.report.dirs = b.subs.map((s) => `${s}/${r.report.dir}`);
    if (b.retry) r.retries_off = { mechanism: 'the org.gradle.test-retry plugin is configured', coverage: 'partial' };
    u.runners.push(r);
    u.test_globs.push('src/test/**', ...(b.subs.length ? ['**/src/test/**'] : []));
  }
  u.typecheck.push({ name: `${b.manager}-compile`, cmd: `${bin} ${b.compile}`, source: files[0] });
  if (b.jacoco) u.coverage.push({ name: 'jacoco', format: 'jacoco', source: files[0] });
  if (!wrapped && !ctx.has(b.tool)) u.warnings.push(`${b.tool} is not on PATH (and no wrapper)`);
  return u;
}

function detectJvm(ctx) {
  const poms = ctx.inputs('pom.xml').map(dirOf).sort((a, b) => a.length - b.length);
  const modulesOf = (dir) => [...(/<modules>([\s\S]*?)<\/modules>/.exec(ctx.read(J(dir, 'pom.xml')) || '')?.[1] || '')
    .matchAll(/<module>\s*([^<]+?)\s*<\/module>/g)].map((m) => normRel(m[1]));
  // Maven: a pom listed as a module of an ancestor pom belongs to that reactor.
  const aggregated = new Set(poms.flatMap((d) => modulesOf(d).map((m) => J(d, m))));
  const units = poms.filter((d) => !aggregated.has(d)).map((dir) => {
    const text = ctx.read(J(dir, 'pom.xml')) || '';
    return jvmUnit(ctx, dir, [J(dir, 'pom.xml')], text, { tool: 'mvn', nix: 'mvnw', win: 'mvnw.cmd', manager: 'maven',
      offline: '-o', test: '-B test', compile: '-B -q test-compile', subs: modulesOf(dir),
      tested: MAVEN_TEST_DEP.test(text), jacoco: /jacoco-maven-plugin/.test(text) });
  });
  // Gradle: a settings file roots a (multi-)project build; build files below it are subprojects.
  const settings = ctx.inputs(/^settings\.gradle(?:\.kts)?$/).map(dirOf);
  const builds = ctx.inputs(/^build\.gradle(?:\.kts)?$/);
  const roots = uniq([...settings, ...builds.map(dirOf).filter((b) => !settings.some((s) => under(b, s)))]);
  for (const dir of roots.sort()) {
    const files = ['settings.gradle', 'settings.gradle.kts', 'build.gradle', 'build.gradle.kts'].map((f) => J(dir, f))
      .filter(ctx.exists);
    const text = builds.filter((r) => under(r, dir)).map((r) => ctx.read(r) || '').join('\n');
    const settingsText = files.filter((f) => /settings\.gradle/.test(f)).map((f) => ctx.read(f) || '').join('\n');
    const subs = uniq([...settingsText.matchAll(/\binclude\s*\(?([^)\n]+)\)?/g)]
      .flatMap((m) => [...m[1].matchAll(/['"]:?([^'"]+)['"]/g)].map((x) => x[1].replace(/:/g, '/'))));
    // A test task restored from a build cache (enabled by the project, the user's gradle.properties or
    // an init script) reports results without running, so the cache is always bypassed.
    units.push(jvmUnit(ctx, dir, files, text, { tool: 'gradle', nix: 'gradlew', win: 'gradlew.bat', manager: 'gradle',
      offline: '--offline', lockfile: ctx.exists(J(dir, 'gradle.lockfile')) ? 'gradle.lockfile' : null,
      test: 'test --no-build-cache', compile: 'testClasses', subs, retry: /test-retry/.test(text),
      tested: GRADLE_TEST_DEP.test(text), jacoco: /\bjacoco\b/.test(text) }));
  }
  return units;
}

function detectRuby(ctx) {
  return ctx.inputs('Gemfile').map(dirOf).sort().map((dir) => {
    const gemfile = J(dir, 'Gemfile');
    const file = (f) => (ctx.exists(J(dir, f)) ? J(dir, f) : null);
    const gemList = [...(ctx.read(gemfile) || '').matchAll(/^\s*gem\s+['"]([^'"]+)['"]/gm)];
    const gems = new Set(gemList.map((m) => m[1].toLowerCase()));
    const locked = Boolean(file('Gemfile.lock'));
    const u = newUnit(dir, 'ruby', gemfile);
    u.languages.push('ruby');
    // Bundler 4 removed `install --frozen`; the local config setting is the supported switch.
    const install = locked ? 'bundle config set --local frozen true && bundle install' : 'bundle install';
    u.managers.push({ name: 'bundler', lockfile: locked ? 'Gemfile.lock' : null, install, cwd: dir, frozen: locked,
      ecosystem: 'ruby' });
    const facts = ctx.facts(dir);
    const rails = gems.has('rails') || Boolean(file('bin/rails'));
    const retry = (r, gem) => {
      if (gems.has(gem)) r.retries_off = { mechanism: `${gem} is configured in test code`, coverage: 'partial' };
      return r;
    };
    if (file('.rspec') || ['rspec', 'rspec-rails', 'rspec-core'].some((g) => gems.has(g)) || facts.has('rb-spec')) {
      const r = makeRunner('rspec', { source: file('.rspec') || gemfile, available: ctx.has('bundle') });
      u.runners.push(retry(r, 'rspec-retry'));
      u.test_globs.push('spec/**');
    }
    if (gems.has('minitest') || facts.has('rb-test') || (rails && facts.has('dir:test'))) {
      const cmd = rails ? 'bundle exec rails test' : file('Rakefile') ? 'bundle exec rake test' : null;
      const source = rails ? 'rails' : J(dir, 'Rakefile');
      const r = cmd && makeRunner('minitest', { cmd, source, available: ctx.has('bundle') });
      if (cmd) u.runners.push(retry(r, 'minitest-retry'));
      if (cmd) u.test_globs.push('test/**');
      else u.warnings.push(`${gemfile}: Minitest files but no Rakefile test task; give the test command`);
    }
    if (gems.has('simplecov')) u.coverage.push({ name: 'simplecov', format: 'simplecov', source: gemfile });
    if (file('.rubocop.yml') || gems.has('rubocop')) {
      u.lint.push({ name: 'rubocop', cmd: 'bundle exec rubocop', source: file('.rubocop.yml') || gemfile });
    }
    if (!ctx.has('bundle')) u.warnings.push('bundle is not on PATH');
    return u;
  });
}

// ---------------------------------------------------------------------------
// Makefile / justfile test targets

const TARGET_PRIORITY = ['test', 'tests', 'test-all', 'test_all', 'testall', 'test-unit', 'test_unit', 'unit-test'];

function detectMake(ctx) {
  const units = [];
  for (const [re, tool] of [[MAKE_RE, 'make'], [JUST_RE, 'just']]) {
    const byDir = new Map();
    for (const f of ctx.inputs(re).sort()) if (!byDir.has(dirOf(f))) byDir.set(dirOf(f), f);
    for (const [dir, file] of byDir) {
      const targets = parseMakeTargets(ctx.read(file), { just: tool === 'just' });
      if (!targets.length) continue;
      const main = TARGET_PRIORITY.map((n) => targets.find((t) => t.name === n)).find(Boolean) || targets[0];
      const wraps = uniq(splitShell(main.recipe.join('\n')).map((s) => recognizeCommand(s.tokens)?.runner));
      const u = newUnit(dir, tool, file);
      u.runners.push(makeRunner(tool, { cmd: `${tool} ${main.name}`, target: main.name,
        targets: targets.map((t) => t.name), source: `${file} target ${main.name}`, ...(wraps.length && { wraps }),
        available: ctx.has(tool) }));
      units.push(u);
    }
  }
  return units;
}

// ---------------------------------------------------------------------------
// CI: system, files, the test commands it runs (and the directory it runs them in)

const RUN_KEYS = new Set(['run', 'script', 'before_script', 'bash', 'pwsh', 'powershell', 'command', 'sh']);
const CI_WORKSPACE = new RegExp('^(?:\\$\\{\\{\\s*github\\.workspace\\s*\\}\\}|\\$(?:CI_PROJECT_DIR|GITHUB_WORKSPACE)'
  + '|\\$\\(\\s*(?:System\\.DefaultWorkingDirectory|Build\\.SourcesDirectory|Pipeline\\.Workspace)\\s*\\))/?');
// Setup lines that mention a test tool without running tests (`pip install pytest`).
const INSTALL_LINE = new RegExp(`^\\s*(?:sudo\\s+)?(?:${[
  'pip3?\\s+install', 'python[\\d.]*\\s+-m\\s+pip\\b', 'uv\\s+(?:pip|tool|add|sync)\\b', 'poetry\\s+(?:add|install)',
  'pipx\\b', 'npm\\s+(?:i|install|ci|config)\\b', 'yarn\\s+(?:add|install)\\b', 'pnpm\\s+(?:add|install|i)\\b',
  'bun\\s+(?:add|install)\\b', 'gem\\s+install', 'bundle\\s+install', 'apt(?:-get)?\\b', 'brew\\b', 'choco\\b',
  'go\\s+(?:install|get|mod)\\b', 'cargo\\s+(?:install|fetch|binstall)\\b', 'dotnet\\s+(?:tool|restore|new)\\b',
  'echo\\b', 'printf\\b', 'export\\b', 'curl\\b', 'wget\\b'].join('|')})`);
const TEST_LINE_RES = [
  /\b(?:npm|pnpm|yarn|bun)\s+(?:(?:-\S+|--\S+)\s+)*(?:run\s+|run-script\s+)?(?:test|t|tst)(?::[\w:.-]+)?\b/,
  /\b(?:npx|bunx|pnpm\s+exec|yarn)\s+(?:--?\S+\s+)*(?:jest|vitest|mocha|playwright\s+test|cypress\s+run)\b/,
  /^(?:jest|vitest|mocha)\b/, /\bnode\s+(?:\S+\s+)*--test\b/, /\bbun\s+test\b/,
  /\bpytest\b/, /\bpython[\d.]*\s+-m\s+(?:pytest|unittest)\b/, /^(?:tox|nox)\b/,
  /\bgo\s+test\b/, /\bcargo\s+(?:test|nextest\s+run)\b/, /\bdotnet\s+test\b/,
  /\b(?:\.\/)?mvnw?(?:\.cmd)?\b.*\s(?:test|verify|integration-test)\b/,
  /\b(?:\.\/)?gradlew?(?:\.bat)?\b.*\s(?:test|check|\S+:test)\b/,
  /\b(?:bundle\s+exec\s+)?(?:rspec|rake\s+(?:test|spec))\b/, /\brails\s+test\b/,
  /\b(?:make|just)\s+(?:-\S+\s+)*test[\w:.-]*/,
  /(?:^|[\s/])(?:run[-_]?)?tests?(?:[-_][\w-]+)?\.(?:sh|ps1|py|bat|cmd)\b/,
];
// Report or narrowing flags a learned CI command must not keep (the companion adds its own).
const CI_DROP = {
  // Plugin flags (pytest-cov, pytest-xdist) are dropped too: the plugin may be a CI-only install.
  pytest: /^--(?:junit-?xml|junitxml|junit-prefix)(?:=|$)|^--cov(?:-report)?(?:=|$)|^-n$|^--numprocesses(?:=|$)/,
  go: /^-json$/, dotnet: /^--logger(?:=|$)|^-l$|^--results-directory(?:=|$)/, rspec: /^--(?:format|out)(?:=|$)|^-[fo]$/,
};
const CI_VALUED = /^-[nlfo]$|^--(?:logger|numprocesses|format|out|results-directory|junit-?xml|cov|cov-report)$/;

const firstString = (...vals) => vals.find((v) => typeof v === 'string' && v.trim())?.trim() ?? null;

/**
 * A CI directory relative to the checkout, from `base` (the step's current directory). Absolute and
 * home paths name the checkout itself (CircleCI `~/project`); a path that leaves it is null.
 */
function ciDir(d, base = '.') {
  let s = toPosix(String(d)).trim();
  if (CI_WORKSPACE.test(s)) [s, base] = [s.replace(CI_WORKSPACE, ''), '.'];
  if (/^(?:\/|~|[A-Za-z]:\/)/.test(s)) return '.';
  s = normRel(s);
  if (base == null || !s || /[$]/.test(s)) return base;
  s = path.posix.normalize(base === '.' ? s : `${base}/${s}`);
  return s === '..' || s.startsWith('../') ? null : s;
}

function ciScripts(tree) {
  const out = [];
  const emit = (script, wd, hint) => { if (script?.trim?.()) out.push({ script, wd, hint }); };
  const visit = (node, wd) => {
    if (Array.isArray(node)) { for (const x of node) visit(x, wd); return; }
    if (!isObj(node)) return;
    // A YAML merge key (`<<: *defaults`) applies the merged mapping to this job or step.
    if (isObj(node['<<'])) { const { '<<': base, ...own } = node; node = { ...base, ...own }; }
    const dir = firstString(node['working-directory'], node.workingDirectory, node.working_directory);
    const here = dir == null ? wd : ciDir(dir);
    const def = firstString(node.defaults?.run?.['working-directory']);
    const inner = def == null ? here : ciDir(def);
    const inp = isObj(node.inputs) ? node.inputs : {};
    const task = typeof node.task === 'string' ? node.task : '';
    // Azure Pipelines tasks that run tests without a script.
    if (/^DotNetCoreCLI@/i.test(task) && inp.command === 'test') emit(`dotnet test ${inp.projects ?? ''}`, here, task);
    if (/^Maven@/i.test(task) && /\b(?:test|verify)\b/.test(inp.goals)) emit(`mvn ${inp.goals}`, here, task);
    if (/^Gradle@/i.test(task) && /\b(?:test|check)\b/.test(inp.tasks)) emit(`./gradlew ${inp.tasks}`, here, task);
    for (const [k, v] of Object.entries(node)) {
      const list = Array.isArray(v) ? v.flat(4) : null;
      if (RUN_KEYS.has(k) && typeof v === 'string') emit(v, here);
      else if (RUN_KEYS.has(k) && list?.every((x) => typeof x === 'string')) for (const s of list) emit(s, here);
      else if (k === 'run' && isObj(v) && typeof v.command === 'string') {
        emit(v.command, firstString(v.working_directory) == null ? here : ciDir(v.working_directory));
      } else if (v && typeof v === 'object') visit(v, inner);
    }
  };
  visit(tree, '.');
  return out;
}

const ciCommandLines = (script) => String(script).replace(/\r\n?/g, '\n').replace(/[\\`^]\n\s*/g, ' ').split('\n')
  .map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
const isTestCommand = (line) => !INSTALL_LINE.test(line) && !/--version\b|--help\b/.test(line)
  && TEST_LINE_RES.some((re) => re.test(line));

function lineNo(text, needle) {
  const first = String(needle).split('\n')[0].trim().slice(0, 60);
  const idx = String(text).split(/\r?\n/).findIndex((l) => l.includes(first));
  return idx === -1 ? null : idx + 1;
}

function detectCi(ctx) {
  const systems = [];
  const files = [];
  const steps = [];
  for (const rel of [...ctx.g.relevant.keys()].sort()) {
    const sys = CI_SYSTEMS.find(([, re]) => re.test(rel))?.[0];
    if (!sys) continue;
    if (!systems.includes(sys)) systems.push(sys);
    files.push(rel);
    const text = ctx.read(rel) || '';
    let scripts = parseYamlAll(text).flatMap(ciScripts);
    // Unparseable YAML: fall back to single-line `run:`/`script:` values.
    if (!scripts.length) {
      scripts = [...text.matchAll(/^\s*-?\s*(?:run|script|command)\s*:\s*(?![|>])(.+)$/gm)]
        .map((m) => ({ script: m[1].replace(/^['"]|['"]$/g, ''), wd: '.' }));
    }
    for (const { script, wd, hint } of scripts) {
      let cwd = wd;
      for (const line of ciCommandLines(script)) {
        // A leading `cd` (or PowerShell `Set-Location`) moves this line and the rest of the script.
        const cd = /^(?:cd|pushd|set-location|sl)\s+(?:-path\s+)?("[^"]+"|'[^']+'|[^\s;&|]+)\s*(?:$|&&|;)\s*/i
          .exec(line);
        if (cd) cwd = ciDir(cd[1].replace(/^['"]|['"]$/g, ''), cwd);
        const cmd = cd ? line.slice(cd[0].length) : line;
        if (!cmd || !isTestCommand(cmd)) continue;
        const at = lineNo(text, line) ?? (hint ? lineNo(text, hint) : null);
        steps.push({ file: rel, line: at, cmd: truncate(cmd, 400), cwd });
      }
    }
  }
  const dedup = steps.filter((s, i) => steps.findIndex((d) => d.cmd === s.cmd && d.cwd === s.cwd) === i);
  return { system: systems[0] || null, ...(systems.length > 1 ? { systems } : {}), files,
    test_commands: uniq(dedup.map((s) => s.cmd)), steps: dedup };
}

/** Recognize a runner in one command segment (CI lines, make recipes). */
function recognizeCommand(tokens) {
  const { env, rest } = stripEnv(tokens);
  const { tokens: t } = stripLaunchers(rest);
  if (!t.length) return null;
  const b = binName(t[0]);
  const a = t.slice(1);
  const w = a.filter((x) => !x.startsWith('-'));
  const py = /^python[\d.]*$/.test(b) || b === 'py';
  const pyRun = ['uv', 'poetry', 'pdm', 'pipenv', 'hatch'].includes(b) && w[0] === 'run';
  const bundled = b === 'bundle' && w[0] === 'exec';
  const hit = (runner) => ({ runner, env });
  const pyMod = (m) => (py && a[0] === '-m' && a[1] === m) || (pyRun && w.includes(m));
  if (b === 'pytest' || b === 'py.test' || pyMod('pytest')) return hit('pytest');
  if (pyMod('unittest')) return hit('unittest');
  if (b === 'go' && w[0] === 'test') return hit('go');
  if (b === 'cargo' && (w[0] === 'nextest' || w[0] === 'test')) return hit(w[0] === 'test' ? 'cargo' : 'nextest');
  if (b === 'dotnet' && w[0] === 'test') return hit('dotnet');
  if (/^mvnw?$/.test(b) && w.some((x) => /^(?:test|verify|integration-test)$/.test(x))) return hit('maven');
  if (/^gradlew?$/.test(b) && w.some((x) => /(?:^|:)(?:test|check)$/.test(x))) return hit('gradle');
  if (b === 'rspec' || (bundled && w[1] === 'rspec')) return hit('rspec');
  const rake = (x, y) => /^(?:rake|rails)$/.test(x) && y === 'test';
  if (rake(b, w[0]) || (bundled && rake(w[1], w[2]))) return hit('minitest');
  if ((b === 'make' || b === 'just') && w.some((x) => /^test/.test(x))) return hit(b);
  const js = classifySegment(tokens, null);
  return js.kind === 'runner' ? { runner: js.runner, env, occ: js } : null;
}

/** Is the program a command line starts with on PATH (or a repository script)? */
function launcherAvailable(ctx, cmd) {
  const firsts = splitShell(cmd).map((seg) => stripEnv(seg.tokens).rest[0]);
  const bin = firsts.find((t) => t && !['set', 'cd', 'export'].includes(t));
  return Boolean(bin) && (/^\.{1,2}\//.test(bin) || ctx.has(binName(bin)));
}

function learnedRunner(ctx, step) {
  for (const seg of splitShell(step.cmd)) {
    const rec = recognizeCommand(seg.tokens);
    if (!rec) continue;
    if (rec.occ) return nodeRunner(ctx, { exec: 'npx --no' }, rec.occ, ciRef(step), new Set());
    const toks = [];
    for (let k = 0; k < seg.tokens.length; k++) {
      const tk = seg.tokens[k];
      if (!CI_DROP[rec.runner]?.test(tk)) toks.push(tk);
      else if (!tk.includes('=') && CI_VALUED.test(tk) && seg.tokens[k + 1] && !seg.tokens[k + 1].startsWith('-')) k++;
    }
    const { env, rest } = stripEnv(toks);
    const joined = joinArgs(rest);
    const r = makeRunner(rec.runner, { cmd: `${ctx.envPrefix(env)}${joined.text}`, source: ciRef(step) });
    if (!joined.portable) r.portable = false;
    if (rec.runner === 'make' || rec.runner === 'just') r.target = rest.slice(1).find((x) => /^test/.test(x)) || 'test';
    return r;
  }
  const r = makeRunner('ci', { cmd: step.cmd, source: ciRef(step) });
  if (/^\.\/|\$\{\{|\$\(/.test(step.cmd)) r.portable = false;
  return r;
}

// ---------------------------------------------------------------------------
// Assemble

function mergeUnits(units) {
  return [...Map.groupBy(units, (u) => u.dir)].map(([dir, list]) => {
    list.sort((a, b) => ECO_ORDER.indexOf(a.ecosystem) - ECO_ORDER.indexOf(b.ecosystem));
    const all = (k) => list.flatMap((u) => u[k]);
    const first = (k) => list.find((u) => u[k])?.[k] ?? null;
    const p = { root: dir, ecosystems: uniq(list.map((u) => u.ecosystem)), languages: uniq(all('languages')),
      manifests: uniq(all('manifests')), managers: all('managers'), runners: all('runners'),
      test_globs: uniq(all('test_globs')), typecheck: all('typecheck'), lint: all('lint'), coverage: all('coverage'),
      test_script: first('test_script'), workspace: first('workspace'), warnings: uniq(all('warnings')) };
    const del = list.filter((u) => u.delegates);
    if (del.length) p.delegates_to = uniq(del.flatMap((u) => u.delegates_via));
    if (first('module')) p.module = first('module');
    // A workspace root without a runner of its own leaves the tests to its members.
    p._delegating = !p.runners.length && (del.length > 0 || list.some((u) => u.workspace?.role === 'root'));
    return p;
  });
}

function summarize(projects) {
  const groups = new Map();
  for (const p of projects) {
    for (const eco of p.ecosystems) {
      const g = groups.get(eco) || { count: 0, names: [] };
      groups.set(eco, g);
      g.count++;
      const runners = p.runners.filter((r) => r.ecosystem === eco);
      g.names.push(...p.managers.filter((m) => m.ecosystem === eco).map((m) => m.name),
        ...runners.map((r) => (r.name === 'make' || r.name === 'just' ? r.target : r.name)));
    }
  }
  const parts = [...groups].sort(([a], [b]) => ECO_ORDER.indexOf(a) - ECO_ORDER.indexOf(b))
    .map(([eco, g]) => `${eco}${g.count > 1 ? ` x${g.count}` : ''}(${uniq(g.names).join(', ') || 'no runner'})`);
  return parts.length ? parts.join(' · ') : 'no projects detected';
}

/** Default branch and how it was found (§7.4 base chain). */
function gitInfo(root) {
  if (!repoRoot(root)) return { default_branch: null, base_source: null };
  const current = () => gitTry(root, ['symbolic-ref', '-q', '--short', 'HEAD']);
  try {
    const b = resolveBase(root, null);
    if (b.source === 'empty' || b.source === 'HEAD') return { default_branch: current(), base_source: b.source };
    return { default_branch: b.ref.replace(/^origin\//, ''), base_source: b.source };
  } catch (err) {
    // No merge base (shallow clone, unrelated history): the branch name is still known.
    const base_error = err.code || 'GIT_FAILED';
    const sym = gitTry(root, ['symbolic-ref', '-q', 'refs/remotes/origin/HEAD']);
    if (sym && revParse(root, sym)) {
      return { default_branch: sym.replace(/^refs\/remotes\/origin\//, ''), base_source: 'origin/HEAD', base_error };
    }
    const name = ['main', 'master'].find((n) => revParse(root, `refs/heads/${n}`)
      || revParse(root, `refs/remotes/origin/${n}`));
    return { default_branch: name || current(), base_source: name || null, base_error };
  }
}

function derive(g, { platform, tools }) {
  const ctx = makeCtx(g, { platform, tools });
  const ci = detectCi(ctx);
  ctx.ci = ci;
  const detectors = [detectNode, detectPython, detectGo, detectRust, detectDotnet, detectJvm, detectRuby, detectMake];
  let projects = mergeUnits(detectors.flatMap((fn) => fn(ctx)));
  // A folder CI tests in, with no runner detected from its manifests: CI's command is the runner.
  for (const step of ci.steps) {
    const exact = projects.find((p) => p.root === step.cwd);
    // A job may test another repository it checks out into a subfolder: only folders of this one count.
    if (exact ? exact.runners.length || exact._delegating : !dirExists(g, step.cwd)) continue;
    const r = learnedRunner(ctx, step);
    r.available = launcherAvailable(ctx, r.cmd);
    const owner = exact || mergeUnits([newUnit(step.cwd, null)])[0];
    if (!exact) projects.push(owner);
    owner.runners.push(r);
    owner.ecosystems = uniq([...owner.ecosystems, r.ecosystem]);
    owner.test_globs = uniq([...owner.test_globs, ...RUNNERS[r.name].test_globs]);
  }
  for (const step of ci.steps) {
    const at = step.cwd === '.' ? '.' : `${step.cwd}/x`;
    step.project = dirExists(g, step.cwd) ? M.projectForFile(at, { projects })?.root ?? null : null;
  }
  for (const p of projects) {
    const own = uniq(ci.steps.filter((s) => s.project === p.root).map((s) => s.cmd));
    if (own.length) p.ci_test_commands = own;
  }
  // A folder is a project when it has a runner; the repository root also when it has a manifest,
  // unless it only delegates to workspace members (they are the projects then).
  const keep = (p) => p.runners.length || (p.root === '.' && !p._delegating);
  const dropped = projects.filter((p) => !keep(p));
  projects = projects.filter(keep).sort((a, b) => (a.root === '.' ? -1 : b.root === '.' ? 1 : cmp(a.root, b.root)));
  for (const r of projects.flatMap((p) => p.runners)) r.count_parser = r.report.format;
  const tagged = (key) => [...projects, ...dropped].flatMap((p) => p[key].map((x) => ({ ...x, project: p.root })));
  const other = dropped.map((p) => ({ root: p.root, ecosystems: p.ecosystems, reason: !p._delegating ? 'no test runner'
    : p.delegates_to ? `test script delegates to workspace members (${p.delegates_to.join('; ')})`
      : 'workspace root without a test runner of its own (the members are the projects)' }));
  for (const p of projects) delete p._delegating;
  const oversize = g.oversize.map((f) => `${f}: larger than 2 MB; only its presence was used`);
  return {
    summary: summarize(projects), projects, ci, lint: tagged('lint'), typecheck: tagged('typecheck'),
    other_packages: other,
    warnings: uniq([...ctx.warnings, ...projects.flatMap((p) => p.warnings), ...oversize]),
    next_steps: projects.some((p) => p.runners.length) ? [] : ['No test runner was detected: ask the user for the test '
      + 'command and pass it as `clean-run --runner "<command>"` (headless runs record CK-CLEANRUN as UNVERIFIED).'],
  };
}

// ---------------------------------------------------------------------------
// Secrets: commands copied from CI files and scripts can carry literal credentials.

// Identifiers and paths the companion computed itself (a digest would look like a key).
const KEEP_KEYS = /^(?:cache_key|repo_root|generated_at|generated_by|schema|platform|file_listing|path)$|sha256$/;
// A credential-named option whose value follows a space (`--password x`); `NAME=x` is the redactor's.
const SECRET_FLAG = new RegExp('(--?[\\w-]*(?:token|secret|passw(?:or)?d|api-?key|access-?key|private-?key|credential)'
  + '[\\w-]*\\s+)(?!\\$|\\[REDACTED|-)(["\']?)[^\\s"\']{4,}\\2', 'gi');

function redactResult(value, env) {
  const base = M.makeRedactor({ env, names: true });
  const redact = (s) => base(s).replace(SECRET_FLAG, '$1[REDACTED]');
  return M.redactDeep(value, redact, { keep: KEEP_KEYS, secretKeys: true });
}

// ---------------------------------------------------------------------------
// Public API

/**
 * Detect the projects under `root`. With `stateInfo` (from prepareStateDir/prepareTarget) the
 * result is cached in `<state>/detect.json`; `refresh` bypasses the cache. Never runs project code.
 * Test seams: `platform` (command dialect), `which` (tool lookup), `write` (false: read-only cache).
 */
export async function detect({ root, stateInfo = null, refresh = false, write = true, platform = process.platform,
  which: whichFn = null, env = process.env } = {}) {
  if (!root) throw usageError('detect: a root directory is required');
  const abs = path.resolve(root);
  if (!isDir(abs)) throw usageError(`detect: not a directory: ${toPosix(abs)}`);
  const started = Date.now();
  const g = gather(abs, { stateInfo, env });
  const key = inputDigest(g, platform);
  const cacheFile = stateInfo ? stateInfo.paths?.detect || statePaths(stateInfo.dir).detect : null;
  const seen = {};
  const tools = { has: (n) => (n in seen ? seen[n] : (seen[n] = Boolean(whichFn ? whichFn(n) : which(n, env)))) };
  const live = { ...gitInfo(abs), repo_root: toPosix(abs) };
  const done = (res, cache) => ({ ...res, duration_ms: Date.now() - started,
    cache: { path: cacheFile && toPosix(cacheFile), ...cache } });
  const c = cacheFile && !refresh ? readJson(cacheFile, null) : null;
  if (c?.schema === DETECT_SCHEMA && c.cache_key === key && Array.isArray(c.projects) && isObj(c.tools)
    && Object.entries(c.tools).every(([n, v]) => tools.has(n) === v)
    && Object.entries(c.probes || {}).every(([rel, v]) => dirExists(g, rel) === v)) {
    delete c.base_error;
    // Redacted again: a credential set after the cache was written must not come back from it.
    return done(redactResult({ ...c, ...live }, env), { hit: true, written: false });
  }
  const sorted = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => cmp(a, b)));
  const derived = derive(g, { platform, tools });
  const result = redactResult({ schema: DETECT_SCHEMA, cache_key: key, generated_at: nowIso(),
    generated_by: generatedBy(), detect_source: 'detect', platform, file_listing: g.listing, files_scanned: g.fileCount,
    inputs: g.relevant.size, ...derived, ...live, tools: sorted(seen), probes: sorted(g.probes) }, env);
  let written = false;
  let error = null;
  if (cacheFile && write && isDir(path.dirname(cacheFile))) {
    try { writeJsonAtomic(cacheFile, result); written = true; } catch (err) { error = err.code || err.message; }
  }
  return done(result, { hit: false, written, ...(error ? { error } : {}) });
}

export { DEFAULT_TEST_GLOBS, projectForFile } from './markers.mjs';

/** Is `file` a test file by its project's test globs (DEFAULT_TEST_GLOBS without one)? `content`: Rust inline tests. */
export const isTestFile = (file, detectResult, opts = {}) => M.isTestFile(file, detectResult,
  { ...opts, heuristic: false });

// ---------------------------------------------------------------------------
// Command

const USAGE = `usage: node <skill>/scripts/adc.mjs detect [--refresh] [--json] [--cwd <dir>] [--state-dir <dir>]
                                          [--dry-run]

Detects projects (monorepo-aware), package managers with their frozen install, test runners
with report and retries-off flags, test-file globs, type checkers, linters, the CI system and
the test commands CI runs, and the default branch. Reads files only; never runs project code.
The result is cached in .adc/detect.json (keyed by a digest of every detection input).

  --refresh    ignore the cache and detect again
  --dry-run    read the cache but write nothing (no .adc/ is created)`;

// The terminal view (`--json` or a pipe prints the full result).
const human = (res) => [`detect: ${res.summary}`, ...res.projects.flatMap((p) => [
  `  ${p.root}: ${p.managers.map((m) => m.install || `${m.name} (no frozen install)`).join('; ')}`,
  ...p.runners.map((r) => `    ${r.name}: ${r.cmd}`)]), ...res.warnings.map((w) => `warning: ${w}`),
...res.next_steps.map((s) => `next: ${s}`)].join('\n');

export const detectCommand = defineCommand({
  name: 'detect',
  usage: USAGE,
  options: { refresh: { type: 'boolean' } },
  positionals: false,
  async run(ctx, values) {
    const top = repoRoot(ctx.cwd);
    const root = top || ctx.cwd;
    const wanted = top || ctx.stateDirOption;
    const stateInfo = wanted ? prepareStateDir({ ...ctx, cwd: root }, { create: !ctx.dryRun }) : null;
    const res = await detect({ root, stateInfo, refresh: Boolean(values.refresh), write: !ctx.dryRun });
    return { result: res, exit: EXIT.OK, summary: res.summary, human: human(res) };
  },
});
