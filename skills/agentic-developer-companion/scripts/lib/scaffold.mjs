// Test-engineering scaffolds (plan §10) rendered from assets/templates/<family>.tmpl with detected values;
// tooling kinds go to tooling.mjs. Nothing is written without --write and no existing file is replaced
// without --force; additive merges (ignore lines, probes.json entries) are the only in-place edits. Next
// steps and per-runner CI data live in the templates, so guidance, data and generated files stay in step.

import fs from 'node:fs';
import path from 'node:path';
import {
  EXIT, SKILL_DIR, SKILL_NAME, usageError, envError, parseOpts, makeContext, loadBundle, renderString, readText,
  readJson, listFiles, toPosix, relPosix, today, generatedBy, skillVersion, truncate, isDir, numberOption,
  selectSections, shellWords, realPath, samePath,
} from './core.mjs';
import { repoRoot, gitRaw } from './git.mjs';
import {
  resolveStateDir, assertStateUntracked, prepareStateDir, materializeTemplates, writeOutputs, backupDirFactory,
} from './state.mjs';
import { detect } from './detect.mjs';
import { parseToml } from './formats.mjs';
import { scaffoldTooling, TOOLING_KINDS, TOOLING_SCAFFOLD_OPTIONS } from './tooling.mjs';

const TEST_KINDS = Object.freeze(['e2e-web', 'e2e-api', 'e2e-cli', 'live', 'regress', 'ci-gate', 'flake']);

/** Languages per kind with their default output dir (the first is used when detection finds none). */
const KINDS = {
  'e2e-web': { ts: 'e2e/web', python: 'tests/e2e/web' },
  'e2e-api': { ts: 'e2e/api', js: 'e2e/api', python: 'tests/e2e/api', java: 'src/test/java/e2e',
    dotnet: 'tests/E2E.Api' },
  'e2e-cli': { ts: 'e2e/cli', js: 'e2e/cli', python: 'tests/e2e/cli', go: 'e2e/cli', rust: 'tests' },
  live: { ts: 'tests/live', js: 'tests/live', python: 'tests/live' },
  // null: the project root (a Go test lives in the package it tests).
  regress: { ts: 'test/regression', js: 'test/regression', python: 'tests/regression', go: null, rust: 'tests',
    java: 'src/test/java/regression', dotnet: 'tests/Regression', ruby: 'spec/regression' },
};

const OPTIONS = Object.fromEntries([
  ...['kind', 'lang', 'for', 'out', 'checklist', 'base-url', 'journeys', 'health-path', 'bin', 'pact', 'issue',
    'behavior', 'level', 'synthetic-cost', 'cost-header', 'cost-header-kind', 'schedule', 'test-cmd', 'os',
    'threshold', 'max-flaky', 'test', 'skill-path'].map((k) => [k, { type: 'string' }]),
  ...['write', 'force', 'audit', 'characterize'].map((k) => [k, { type: 'boolean' }]),
]);

const USAGE = `usage: node <skill>/scripts/adc.mjs scaffold <kind> [options] [--write] [--force] [--json]

  e2e-web  [--lang ts|python] [--base-url u] [--journeys "a,b,c"] [--for copilot|claude|codex|all] [--audit]
  e2e-api  [--lang ts|js|python|java|dotnet] [--base-url u] [--health-path /health] [--pact <provider>]
  e2e-cli  [--lang ts|js|python|go|rust] [--bin "<command>"]
  live     [--lang ts|js|python] [--checklist f] [--synthetic-cost n] [--cost-header h [--cost-header-kind
           per_request|cumulative]] [--base-url u] [--health-path p] [--schedule "<cron>"]
  regress  --issue <id|URL> --behavior "<what must hold>" [--level unit|integration|e2e] [--characterize]
  ci-gate  [--os linux,windows,macos] [--threshold 80] [--max-flaky 0] [--test-cmd "<cmd>"] [--for hosts]
  flake    [--test <id>] [--max-flaky 0]
  instructions | skill | agent | prompt | hooks | mcp | plugin   (delegated to \`tooling scaffold\`)

Common: --out <dir>, --skill-path <vendored skill dir> (live, ci-gate). Without --write nothing is written
(the result lists the files); existing files are kept unless --force (backup in .adc/backups/scaffold/).
Playbooks: references/{e2e,live,regress,ci-gate,flake}.md`;

// ---------------------------------------------------------------------------
// Rendering, paths, inputs and detection

/** Render a template; GitHub Actions `${{ ... }}` expressions pass through untouched. */
const render = (text, vars) => renderString(text, vars, { actions: true });

// Bundles are parsed once per process: ci-gate.tmpl is read by several builders and once per project.
const bundles = new Map();
const tmpl = (name) => bundles.get(name) || bundles.set(name, loadBundle(name)).get(name);

/** Sections whose attributes all match the filter (when/unless test `features`); fragments only for part=fragment. */
export const pickSections = (sections, filter = {}, features = new Set()) =>
  selectSections(sections, filter, { strict: true, features, loose: ['part', 'name', 'scope', 'mode'] })
    .filter((s) => (s.attrs.part === 'fragment') === (filter.part === 'fragment'));

const fragments = (bundle, name, filter, features) =>
  pickSections(bundle, { ...filter, part: 'fragment' }, features).filter((s) => s.attrs.name === name);

/** One named fragment, rendered, without its final newline. */
function fragment(bundle, name, filter, vars, features = new Set()) {
  const hit = fragments(bundle, name, filter, features)[0];
  if (!hit) throw envError('TEMPLATE_MISSING', `template fragment "${name}" not found for ${JSON.stringify(filter)}`);
  return render(hit.content, vars).replace(/\n$/, '');
}

/** The bundle's `next` fragments for this render, one next step per non-empty line. */
const nextSteps = (bundle, filter, features, vars) => fragments(bundle, 'next', filter, features)
  .flatMap((s) => render(s.content, vars).split('\n')).map((l) => l.trim()).filter(Boolean);

/** A JSON data fragment of ci-gate.tmpl (parsed once, read-only): `runners`, `audits` or `agents`. */
const ciDataCache = {};
const ciData = (name) =>
  (ciDataCache[name] ??= JSON.parse(fragments(tmpl('ci-gate'), name, {}, new Set())[0].content));

export function slugify(text, max = 48) {
  const s = String(text || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/g, '');
  return s || 'item';
}
const ident = (text, max) => slugify(text, max).replace(/-/g, '_');
const pascal = (text) => slugify(text).split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join('');

/** Single-quoted JS/TS string literal. */
export const jsString = (text) => `'${String(text).replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  .replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\u2028|\u2029/g, ' ')}'`;
/** Double-quoted literal, valid in Python, Go, Rust, Java and C# for the characters it can contain. */
export const cString = (text) => `"${String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  .replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\t/g, '\\t')}"`;
/** Free text that is safe inside comments, strings and test titles of every target language. */
const plainText = (text, max = 120) => truncate(String(text || '').replace(/[\r\n\t]+/g, ' ')
  .replace(/\*\//g, '* /').replace(/[`$\\{}'"]/g, '').trim(), max);

/** ESM -> CommonJS for the templates' own import/export forms (Jest without ESM support). */
export function toCommonJs(text) {
  const exported = [];
  let out = String(text)
    .replace(/^import (\w+) from '([^']+)';$/gm, "const $1 = require('$2');")
    .replace(/^import \{ ([^}]+) \} from '([^']+)';$/gm,
      (_, names, mod) => `const { ${names.replace(/\s+as\s+/g, ': ')} } = require('${mod}');`)
    .replace(/^import \* as (\w+) from '([^']+)';$/gm, "const $1 = require('$2');")
    .replace(/^export (async function|function|const|let|class) (\w+)/gm, (_, decl, name) => {
      exported.push(name);
      return `${decl} ${name}`;
    })
    .replace(/require\('(\.{1,2}\/[^']+)\.mjs'\)/g, "require('$1.cjs')");
  if (exported.length) out = out.replace(/\n*$/, `\n\nmodule.exports = { ${exported.join(', ')} };\n`);
  return out;
}

const abs = (root, rel) => path.join(root, ...String(rel).split('/'));
const joinOut = (out, rel) => (!out || out === '.' ? rel : `${out}/${rel}`);
const under = (rel, dir) => dir === '.' || rel === dir || rel.startsWith(`${dir}/`);
const within = (dir, p) => !/^\.\.(?:[\\/]|$)/.test(path.relative(dir, p)) && !path.isAbsolute(path.relative(dir, p));
const ciHeader = (kind) => `# generated by ${SKILL_NAME} ci-gate: ${kind} workflow (${generatedBy()}, ${today()})`;
const helperHeader = () => `generated by ${SKILL_NAME} ci-gate: gate helper (${generatedBy()})`;
const projectDir = (env) => abs(env.root, env.projectRoot);
const projectPkg = (env) => readJson(path.join(projectDir(env), 'package.json'), null) || {};
/** A repo-relative path as seen from the project root (the tests run from there). */
const projectRelative = (env, rel) => toPosix(path.relative(projectDir(env), abs(env.root, rel))) || '.';

/** An http(s) URL that is safe inside generated string literals (RFC 3986 characters, no quote) and has no
 * credentials in its authority. */
function httpUrl(url, hint = '') {
  if (/^https?:\/\/[A-Za-z0-9._~:/?#[\]@!$&()*+,;=%-]+$/.test(url) && !/^https?:\/\/[^/?#]*@/.test(url)) return url;
  throw usageError(`--base-url must be an http(s) URL without credentials${hint}`);
}

function httpPath(p) {
  if (/^\/[A-Za-z0-9._~!$&()*+,;=:@%/-]*$/.test(String(p).trim())) return String(p).trim();
  throw usageError(`--health-path must be an absolute URL path such as /health (got "${p}")`);
}

function parseFor(text) {
  const all = ['copilot', 'claude', 'codex'];
  const list = String(text || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const bad = list.find((h) => h !== 'all' && !all.includes(h));
  if (bad) throw usageError(`--for must be copilot, claude, codex or all (got "${bad}")`);
  return list.includes('all') ? all : [...new Set(list)];
}

// detect languages and ecosystems -> template language (also the accepted --lang aliases).
const LANG_OF = {
  typescript: 'ts', javascript: 'js', node: 'js', python: 'python', py: 'python', python3: 'python', go: 'go',
  golang: 'go', rust: 'rust', java: 'java', kotlin: 'java', jvm: 'java', csharp: 'dotnet', fsharp: 'dotnet',
  vb: 'dotnet', 'c#': 'dotnet', dotnet: 'dotnet', ruby: 'ruby',
};
const RUN_CMD = { vitest: 'npx vitest run', jest: 'npx jest', 'node-test': 'node --test', bun: 'bun test',
  mocha: 'npx mocha' };
// Where describe/it come from per runner (mocha: globals).
const TEST_API = { vitest: 'vitest', jest: '@jest/globals', 'node-test': 'node:test', bun: 'bun:test' };

const unitRunners = (p) => ((p && p.runners) || []).filter((r) => r && r.kind !== 'e2e');
const firstManager = (p) => (p && p.managers && p.managers[0]) || {};
const ecosystemOf = (p) => (p && p.ecosystems && p.ecosystems[0]) || (unitRunners(p)[0] || {}).ecosystem || null;

/** The project that owns `outRel` (longest root), else the root project, else the first one. */
function pickProject(det, outRel) {
  const projects = (det && det.projects) || [];
  const owner = outRel && [...projects].sort((a, b) => String(b.root).length - String(a.root).length)
    .find((p) => under(outRel, toPosix(p.root || '.')));
  return owner || projects.find((p) => (p.root || '.') === '.') || projects[0] || null;
}

/** --lang, else the detected language when the kind has a template for it; `out` is its default dir. */
function resolveLang(env, { strict = false } = {}) {
  const allowed = Object.keys(KINDS[env.kind]);
  const p = env.project || {};
  const given = env.values.lang && String(env.values.lang).toLowerCase();
  const detected = [...(p.languages || []), ...(p.ecosystems || [])].map((l) => LANG_OF[l]).find(Boolean);
  const lang = given ? LANG_OF[given] || given : allowed.includes(detected) ? detected : allowed[0];
  if (given && !allowed.includes(lang)) throw usageError(`${env.kind} supports --lang ${allowed.join(', ')}`);
  if (!given && strict && detected && detected !== lang) {
    throw usageError(`${env.kind} has no template for ${detected}; pass --lang ${allowed.join('|')} or write the test `
      + `by hand (references/${env.kind === 'regress' ? 'regress' : 'e2e'}.md)`);
  }
  return { lang, out: env.outRel || KINDS[env.kind][lang] || env.projectRoot };
}

/** Runner flavor, CommonJS (Jest with JavaScript), test header and import specifiers for Node templates. */
function nodeSetup(env, lang) {
  if (!['ts', 'js'].includes(lang)) return { flavor: null, cjs: false, vars: {} };
  const names = unitRunners(env.project).map((r) => r.name);
  const flavor = ['vitest', 'jest', 'node-test', 'mocha', 'bun'].find((f) => names.includes(f)) || 'node-test';
  const cjs = lang === 'js' && flavor === 'jest';
  const ext = lang === 'ts' ? 'ts' : cjs ? 'cjs' : 'mjs';
  // Node's type stripping (node --test) needs the .ts extension; bundling runners resolve bare specifiers.
  const imp = (spec) => (lang === 'js' ? `${spec}.${ext}` : flavor === 'node-test' ? `${spec}.ts` : spec);
  const from = TEST_API[flavor];
  const api = from ? `import { describe, it } from '${from}';` : '// describe and it are mocha globals';
  const header = cjs ? toCommonJs(api).trim() : api;
  return { flavor, cjs, imp, run: RUN_CMD[flavor], vars: { test_header: header, ext } };
}

/** The companion vendored inside the target repository (repo-relative POSIX path), or null. */
function vendoredSkill(env, explicit) {
  const candidates = explicit ? [realPath(path.resolve(env.cwd, explicit))]
    : ['.github/skills', '.agents/skills', '.claude/skills'].map((d) => abs(env.root, `${d}/${SKILL_NAME}`));
  const hit = candidates.map((c) => relPosix(env.root, c))
    .find((rel) => rel && rel !== '.' && fs.existsSync(abs(env.root, `${rel}/scripts/adc.mjs`)));
  if (!hit && explicit) throw usageError(`--skill-path ${explicit}: no scripts/adc.mjs inside the repository there`);
  return hit || null;
}

/** The workflow step that sets ADC to the vendored skill or to a pinned fetch of it. */
function getAdcStep(vendored, vars) {
  const bundle = tmpl('ci-gate');
  if (vendored) return fragment(bundle, 'get-adc-vendored', {}, { ...vars, skill_rel: vendored });
  const m = /^\s+homepage:\s*["']?(https:\/\/[^\s"']+)/m.exec(readText(path.join(SKILL_DIR, 'SKILL.md'), ''));
  const repo = m ? m[1].replace(/\/+$/, '') : `https://github.com/robertlemmermann/${SKILL_NAME}`;
  return fragment(bundle, 'get-adc-pinned', {}, { ...vars, adc_repo: repo, adc_ref: `v${skillVersion()}` });
}

// ---------------------------------------------------------------------------
// Outputs: render, merge, apply

const commonVars = (env, extra) => ({ generated_by: generatedBy(), version: skillVersion(), date: today(),
  skill_name: SKILL_NAME, default_branch: env.defaultBranch, ...extra });

// scope=repo: repo-relative path; scope=state: in the state dir; else under `out`. mode=lines merges ignore
// lines; mode=keep never replaces an existing file.
function renderFiles(bundle, filter, features, vars, out, { cjs = false } = {}) {
  return pickSections(bundle, filter, features).map((s) => {
    const rel = render(s.path, vars);
    const content = render(s.content, vars);
    const target = s.attrs.scope === 'repo' ? rel : joinOut(out, rel);
    const o = { path: cjs ? target.replace(/\.mjs$/, '.cjs') : target, content: cjs ? toCommonJs(content) : content };
    if (s.attrs.scope === 'state') o.state = rel;
    if (s.attrs.mode === 'lines') o.merge = mergeLines(content);
    if (s.attrs.mode === 'keep') o.merge = (current) => current;
    return o;
  });
}

/** Additive merge for ignore files: append the template's missing lines, keep everything else. */
export function mergeLines(content) {
  const wanted = content.split('\n').map((l) => l.trimEnd()).filter((l) => l && !l.startsWith('#'));
  return (current) => {
    const eol = current.includes('\r\n') ? '\r\n' : '\n';
    const have = new Set(current.split(/\r?\n/).map((l) => l.trim()));
    const missing = wanted.filter((l) => !have.has(l));
    if (!missing.length) return current;
    const sep = current === '' || current.endsWith('\n') ? '' : eol;
    return `${current}${sep}# added by ${SKILL_NAME} scaffold${eol}${missing.join(eol)}${eol}`;
  };
}

/** Additive merge of probe entries into an existing probes.json (by id; existing entries win). */
export function mergeProbes(probes) {
  return (current) => {
    const doc = JSON.parse(current);
    if (!doc || typeof doc !== 'object' || !Array.isArray(doc.probes)) throw new Error('not an adc-probes/1 manifest');
    const ids = new Set(doc.probes.map((p) => p && p.id));
    const add = probes.filter((p) => !ids.has(p.id));
    if (!add.length) return current;
    doc.probes.push(...add);
    return JSON.stringify(doc, null, 2) + '\n';
  };
}

/** Write (or plan) every output: never replaces a file without --force; a replaced file is backed up. */
function applyOutputs(outputs, env) {
  if (env.write && outputs.some((o) => o.state)) prepareStateDir({ ...env.ctx, cwd: env.root });
  const located = outputs.map((o) => {
    if (!o.state) return o;
    const absPath = abs(env.state.dir, o.state);
    return { ...o, absPath, path: relPosix(env.root, absPath) || toPosix(absPath) };
  });
  const backupDir = backupDirFactory(env.ctx, env.root, 'backups', 'scaffold');
  return writeOutputs(located, { root: env.root, dryRun: !env.write, force: env.force, backupDir });
}

// ---------------------------------------------------------------------------
// e2e-web (plan §10.2)

function webServerInfo(env) {
  const scripts = projectPkg(env).scripts || {};
  const script = ['start', 'preview', 'dev'].find((s) => typeof scripts[s] === 'string');
  if (!script) return null;
  const mgr = firstManager(env.project);
  const cmd = `${{ pnpm: 'pnpm run', yarn: 'yarn', bun: 'bun run' }[mgr.name] || 'npm run'} ${script}`;
  const port = /\bvite\b/.test(scripts[script]) ? (script === 'dev' ? 5173 : 4173) : 3000;
  return { cmd, port, install: mgr.install || 'npm ci' };
}

async function buildE2eWeb(env) {
  const { values } = env;
  const { lang, out } = resolveLang(env);
  const bundle = tmpl('e2e');
  const filter = { kind: 'web', lang };
  const server = lang === 'ts' ? webServerInfo(env) : null;
  const baseUrl = httpUrl(values['base-url'] || `http://localhost:${server ? server.port : 3000}`);
  // Unique by file name: two journeys that slug alike would otherwise share one spec file.
  const slugs = new Set();
  const journeys = `${values.journeys || ''}`.split(/[,;\n]/).map((j) => plainText(j, 80))
    .filter((j) => j && !slugs.has(slugify(j, 40)) && slugs.add(slugify(j, 40))).slice(0, 3);
  const hosts = parseFor(values.for);
  const features = new Set([server ? 'server' : 'no-server', journeys.length ? 'journeys' : 'no-journeys', ...hosts]);
  const vars = commonVars(env, {
    out, base_url: baseUrl, package_name: `${slugify(path.basename(env.root))}-e2e-web`, header: ciHeader('e2e-web'),
    server_cmd: server ? server.cmd : '', journey_count: String(journeys.length),
  });
  const serverCwd = toPosix(path.relative(abs(env.root, out), projectDir(env))) || '.';
  vars.web_server = server ? fragment(bundle, 'web-server', filter,
    { ...vars, server_cmd: jsString(server.cmd).slice(1, -1), server_cwd: jsString(serverCwd).slice(1, -1) }) : '';
  vars.app_install = server ? fragment(bundle, 'app-install', filter,
    { ...vars, install_cmd: server.install, project_root: env.projectRoot }) : '';
  const outputs = renderFiles(bundle, filter, features, vars, out);
  for (const j of journeys) {
    const jv = { ...vars, journey: j, journey_js: jsString(j), journey_py: cString(j), slug_ident: ident(j, 40) };
    const rel = lang === 'python' ? `test_web_${jv.slug_ident}.py` : `tests/${slugify(j, 40)}.spec.ts`;
    outputs.push({ path: joinOut(out, rel), content: `${fragment(bundle, 'journey', filter, jv)}\n` });
  }
  return {
    lang, out, outputs, next: nextSteps(bundle, filter, features, vars),
    data: { journeys, base_url: baseUrl, web_server: server ? server.cmd : null, for: hosts },
  };
}

// e2e-web --audit: hardening an existing suite into a prioritized fix list; nothing is written.
// Spec lines: [priority, rule, pattern, fix].
const SPEC_RULES = [
  ['P1', 'fixed-sleep', /\bwaitForTimeout\s*\(|\btime\.sleep\s*\(|=>\s*setTimeout\b|\bcy\.wait\s*\(\s*\d/,
    'wait on a condition: web-first assertions (expect(locator).toBeVisible()), waitForResponse, expect.poll'],
  ['P1', 'focused-test', /\b(?:test|it|describe)\.only\s*\(/, 'remove .only; set forbidOnly: !!process.env.CI'],
  ['P2', 'serial-mode', /\bdescribe\.serial\s*\(|mode\s*:\s*['"]serial['"]/,
    'serial mode shares state between tests: give each test its own data (fixtures, per-worker accounts)'],
  ['P2', 'hardcoded-url', /\b(?:goto|get|post|put|delete|fetch)\s*\(\s*['"`]https?:\/\//,
    'use relative URLs with use.baseURL (E2E_BASE_URL) so the suite runs against any environment'],
  ['P3', 'brittle-selector', /\bpage\.\$\$?\s*\(|locator\s*\(\s*['"`](?:\/\/|xpath=)|\.nth-child\(/,
    'prefer getByRole / getByLabel / getByTestId over CSS structure and XPath'],
  ['P3', 'force-click', /\{\s*force\s*:\s*true\s*\}/, 'force: true skips actionability checks and hides real bugs'],
];
// Config files: [priority, rule, applies(text, retries expression, its highest count), line pattern, fix].
const CONFIG_RULES = [
  ['P1', 'retries-hide-flakes', (t, r, n) => n > 0 && !/failOnFlakyTests/.test(t), /retries\s*:/,
    'retried passes are silent: add failOnFlakyTests: !!process.env.CI (Playwright 1.52+)'],
  ['P1', 'unbounded-retries', (t, r, n) => n > 2, /retries\s*:/, 'at most 2 retries'],
  ['P2', 'retries-outside-ci', (t, r) => /^\s*[1-9]/.test(r || ''), /retries\s*:/, 'retries: process.env.CI ? 2 : 0'],
  ['P2', 'no-forbid-only', (t) => !/forbidOnly/.test(t), null, 'add forbidOnly: !!process.env.CI'],
  ['P2', 'no-trace', (t) => !/trace\s*:/.test(t), null, "set use.trace: 'retain-on-failure'"],
  ['P2', 'trace-off', (t) => /trace\s*:\s*['"]off['"]/.test(t), /trace\s*:/,
    "use 'retain-on-failure' ('off' only for authenticated live probes)"],
  ['P2', 'no-base-url', (t) => !/baseURL/.test(t), null, 'read use.baseURL from E2E_BASE_URL'],
  ['P3', 'no-junit', (t) => !/junit/.test(t), null, 'add a junit reporter so CI can publish and count the results'],
];

function auditE2eWeb(env) {
  const all = listFiles(env.root);
  const load = (f) => (readText(abs(env.root, f), '') || '').replace(/\r\n/g, '\n');
  const texts = new Map();
  const text = (f) => texts.get(f) ?? texts.set(f, load(f)).get(f);
  const configs = all.filter((f) => /(^|\/)playwright\.config\.[cm]?[jt]s$/.test(f));
  const pyTests = all.filter((f) => /(^|\/)test_[^/]*\.py$/.test(f));
  const pySuite = all.some((f) => /(^|\/)conftest\.py$/.test(f)) && pyTests.some((f) => /playwright/.test(text(f)));
  const specs = all.filter((f) => /\.(?:spec|test|cy)\.[cm]?[jt]sx?$/.test(f)).concat(pySuite ? pyTests : []);
  const items = [];
  const add = (priority, rule, file, line, evidence, fix) =>
    items.push({ priority, rule, file, line, evidence: truncate(String(evidence).trim(), 160), fix });
  for (const cfg of configs) {
    const t = text(cfg);
    const lines = t.split('\n');
    const retries = (/retries\s*:\s*([^,\n]+)/.exec(t) || [])[1];
    // `process.env.CI ? 2 : 0` -> 2; an expression without a number counts as 1 (it may retry).
    const most = retries == null ? 0 : Math.max(...(retries.match(/\d+/g) || ['1']).map(Number));
    for (const [priority, rule, applies, lineRe, fix] of CONFIG_RULES.filter((r) => r[2](t, retries, most))) {
      const i = lineRe ? lines.findIndex((l) => lineRe.test(l)) : -1;
      add(priority, rule, cfg, i === -1 ? null : i + 1, i === -1 ? `${rule} (${cfg})` : lines[i], fix);
    }
  }
  let tagged = 0;
  for (const f of specs.slice(0, 2000)) {
    const t = text(f);
    texts.delete(f);
    if (/@smoke|@regression|tag\s*:\s*['"]@/.test(t)) tagged++;
    const hits = (l, i) => SPEC_RULES.forEach(([p, id, re, fix]) => re.test(l) && add(p, id, f, i + 1, l, fix));
    t.split('\n').forEach(hits);
  }
  if (specs.length && !tagged) add('P3', 'no-tags', specs[0], null, 'no @smoke/@regression tag', "{ tag: '@smoke' }");
  if (!configs.length && !pySuite) add('P1', 'no-suite', '.', null, 'no playwright config', 'scaffold e2e-web --write');
  const rank = (x) => Number(x.priority[1]);
  items.sort((a, b) => rank(a) - rank(b) || a.file.localeCompare(b.file) || (a.line || 0) - (b.line || 0));
  const counts = Object.fromEntries(['P1', 'P2', 'P3'].map((p) => [p, items.filter((x) => x.priority === p).length]));
  return { configs, files_scanned: specs.length, items: items.slice(0, 200), truncated: items.length > 200, counts };
}

// ---------------------------------------------------------------------------
// e2e-api and e2e-cli

const OPENAPI_FILES = ['', 'docs/', 'api/', 'spec/', 'specs/', 'openapi/', 'schema/']
  .flatMap((d) => ['openapi', 'swagger'].flatMap((n) => ['yaml', 'yml', 'json'].map((e) => `${d}${n}.${e}`)));

async function buildE2eApi(env) {
  const { values } = env;
  const { lang, out } = resolveLang(env);
  const bundle = tmpl('e2e');
  const node = nodeSetup(env, lang);
  const openapi = OPENAPI_FILES.find((rel) => fs.existsSync(abs(env.root, rel))) || null;
  if (values.pact && !node.flavor) {
    throw usageError('--pact skeletons are rendered for TypeScript/JavaScript only (Pact notes: references/e2e.md)');
  }
  const features = new Set([node.flavor, openapi && 'openapi', values.pact && 'pact']);
  const filter = { kind: 'api', lang };
  const vars = commonVars(env, {
    out, header: ciHeader('e2e-api'), openapi: openapi || '', contracts_dir: projectRelative(env, `${out}/contracts`),
    base_url: httpUrl(values['base-url'] || 'http://localhost:3000'),
    health_path: httpPath(values['health-path'] || '/health'),
    consumer: slugify(String(projectPkg(env).name || path.basename(env.root)).replace(/^@[^/]+\//, '')),
    provider: values.pact ? slugify(values.pact) : 'provider', ...node.vars,
  });
  if (node.flavor) {
    Object.assign(vars, { client_import: node.imp('./client'), contract_import: node.imp('./contract'),
      run_cmd: `${node.run} ${projectRelative(env, `${out}/api.e2e.test.${vars.ext}`)}` });
  }
  const data = { flavor: node.flavor, openapi, pact: values.pact ? vars.provider : null, base_url: vars.base_url };
  return {
    lang, out, outputs: renderFiles(bundle, filter, features, vars, out, { cjs: node.cjs }),
    next: nextSteps(bundle, filter, features, vars), data: { ...data, health_path: vars.health_path },
  };
}

function nodeCliTarget(env) {
  const pkg = projectPkg(env);
  let name = pkg.name ? String(pkg.name).replace(/^@[^/]+\//, '') : path.basename(projectDir(env));
  let bin = typeof pkg.bin === 'string' ? pkg.bin : null;
  const first = pkg.bin && typeof pkg.bin === 'object' ? Object.entries(pkg.bin)[0] : null;
  if (first) [name, bin] = first;
  return { name, script: bin ? toPosix(path.normalize(bin)).replace(/^\.\//, '') : null };
}

const toml = (env, file) => parseToml(readText(path.join(projectDir(env), file), ''), { lenient: true }).value || {};

function pyCliTarget(env) {
  const [name, entry] = Object.entries((toml(env, 'pyproject.toml').project || {}).scripts || {})[0] || [];
  const m = /^([A-Za-z0-9_.]+):([A-Za-z0-9_.]+)$/.exec(String(entry || '').trim());
  return m ? { name, module: m[1], func: m[2] } : null;
}

function goCliTarget(env) {
  const dir = projectDir(env);
  const mod = /^module\s+(\S+)/m.exec(readText(path.join(dir, 'go.mod'), '') || '');
  if (!mod) return null;
  const isMain = (d) => isDir(d) && fs.readdirSync(d).some((f) => f.endsWith('.go') && !f.endsWith('_test.go')
    && /^package\s+main\b/m.test(readText(path.join(d, f), '') || ''));
  if (isMain(dir)) return { pkg: '.', name: path.basename(mod[1]) };
  const cmd = path.join(dir, 'cmd');
  const sub = isDir(cmd) ? fs.readdirSync(cmd).sort().find((d) => isMain(path.join(cmd, d))) : null;
  return { pkg: sub ? `./cmd/${sub}` : null, name: sub || path.basename(mod[1]) };
}

function rustCliTarget(env) {
  const cargo = toml(env, 'Cargo.toml');
  const bin = [].concat(cargo.bin || []).map((b) => b && b.name).find(Boolean);
  const main = cargo.package && fs.existsSync(path.join(projectDir(env), 'src', 'main.rs'));
  return bin || (main ? cargo.package.name : null);
}

async function buildE2eCli(env) {
  const { values } = env;
  const { lang, out } = resolveLang(env, { strict: true });
  const bundle = tmpl('e2e');
  const node = nodeSetup(env, lang);
  const argv = values.bin == null ? null : shellWords(values.bin);
  if (values.bin != null && !argv) throw usageError('--bin has an unterminated quote');
  if (argv && !argv.length) throw usageError('--bin needs a command');
  const vars = commonVars(env, { out, ...node.vars });
  const missing = (where) => usageError(`no entry point in ${where}: pass --bin "<command to start the CLI>"`);
  let name;
  if (node.flavor) {
    const t = nodeCliTarget(env);
    // A Node script runs with the current Node (no shell, no .cmd shim); anything else as given.
    const script = argv ? (/\.[cm]?[jt]s$/.test(argv[0]) ? argv[0] : null) : t.script;
    if (!argv && !script) throw missing('package.json "bin"');
    name = argv ? path.basename(argv[0]).replace(/\.[^.]+$/, '') || t.name : t.name;
    const cli = script
      ? ['process.execPath', `path.resolve(PROJECT_ROOT, ${jsString(script)})`, ...(argv || []).slice(1).map(jsString)]
      : argv.map(jsString);
    Object.assign(vars, {
      cli_argv: `[${cli.join(', ')}]`, golden_dir: projectRelative(env, `${out}/golden`),
      harness_import: node.imp('./harness'),
      run_cmd: `${node.run} ${projectRelative(env, out)}/cli.e2e.test.${vars.ext}`,
      run_from: env.projectRoot === '.' ? 'the repository root' : env.projectRoot,
    });
  } else if (lang === 'python') {
    const t = pyCliTarget(env);
    if (!argv && !t) throw missing('pyproject.toml [project.scripts]');
    name = argv ? path.basename(argv[0]) : t.name;
    vars.cli_argv = argv ? `[${argv.map(cString).join(', ')}]`
      : `[sys.executable, "-c", ${cString(`import sys; from ${t.module} import ${t.func}; sys.exit(${t.func}())`)}]`;
  } else if (lang === 'go') {
    const t = goCliTarget(env);
    const pkg = argv ? argv[0] : t && t.pkg;
    if (!pkg) throw missing('go.mod (a main package at the module root or in cmd/*); --bin ./cmd/<name>');
    name = argv ? path.basename(argv[0]) : t.name;
    vars.go_pkg = cString(/^\.|\//.test(pkg) ? pkg : `./${pkg}`);
    vars.go_package = ident(path.basename(out), 30);
  } else {
    name = argv ? argv[0] : rustCliTarget(env);
    if (!/^[A-Za-z0-9_-]+$/.test(name || '')) throw missing('Cargo.toml (a [[bin]] or src/main.rs); --bin <bin name>');
    vars.bin_name = name;
  }
  vars.cli_name = plainText(name, 60);
  const filter = { kind: 'cli', lang };
  const features = new Set([node.cjs && 'cjs', lang === 'rust' && !/(^|\/)tests$/.test(out) && 'outside-tests']);
  return {
    lang, out, outputs: renderFiles(bundle, filter, features, vars, out, { cjs: node.cjs }),
    next: nextSteps(bundle, filter, features, vars), data: { flavor: node.flavor, cli: name },
  };
}

// ---------------------------------------------------------------------------
// live (plan §10.3): a plain probe project for `adc.mjs live run`, which owns credentials and budget

/** The checklist gate: missing, or the number of lines containing TODO (the runner's rule). */
export function checklistGate(file) {
  const text = readText(file);
  if (text == null) return { path: toPosix(file), exists: false, open: null, ok: false, reason: 'CHECKLIST_MISSING' };
  const open = text.split(/\r?\n/).filter((l) => l.includes('TODO'));
  const openItems = open.slice(0, 20).map((l) => truncate(l.trim(), 120));
  const reason = open.length ? 'CHECKLIST_OPEN' : null;
  return { path: toPosix(file), exists: true, open: open.length, open_items: openItems, ok: !reason, reason, text };
}

const PROBE_FORMS = {
  ts: [(f) => `npx playwright test ${f} --reporter=junit`, (k, n) => `probes/${k}/${n}.spec.ts`],
  js: [(f) => `node --test --test-reporter=junit ${f}`, (k, n) => `probes/${k}/${n}.test.mjs`],
  python: [(f) => `python -m pytest ${f} -p no:cacheprovider -q`, (k, n) => `probes/${k}/test_${ident(n)}.py`],
};

/** Manifest entries: read-only probes cost 1; synthetic ones carry the estimate the owner gave. */
function liveProbes(lang, out, syntheticCost, values) {
  const header = values['cost-header'];
  const kind = values['cost-header-kind'] || 'per_request';
  if (header && !/^[A-Za-z0-9-]{1,100}$/.test(header)) throw usageError('--cost-header must be an HTTP header name');
  if (!['per_request', 'cumulative'].includes(kind)) throw usageError('--cost-header-kind: per_request or cumulative');
  const [cmd, file] = PROBE_FORMS[lang];
  const probe = (k, name, cost, timeout) => ({
    id: `${k}/${name}`, kind: k, cmd: cmd(file(k, name)), cwd: out, cost, timeout_s: timeout,
    ...(header ? { cost_header: header, cost_header_kind: kind } : {}),
  });
  const synthetic = syntheticCost == null ? [] : [probe('synthetic', 'create-and-cleanup', syntheticCost, 300)];
  return [probe('readonly', 'health', 1, 120), ...synthetic];
}

async function buildLive(env) {
  const { values, root } = env;
  const { lang, out } = resolveLang(env);
  const bundle = tmpl('live');
  const checklistOut = joinOut(out, 'live-checklist.md');
  const inProject = abs(root, checklistOut);
  const checklist = values.checklist ? realPath(path.resolve(env.cwd, values.checklist)) : inProject;
  const gate = checklistGate(checklist);
  const shown = relPosix(root, checklist) || toPosix(checklist);
  const answered = (/estimated (?:credits|cost)[^:\n]*:\s*(\d+(?:\.\d+)?)/i.exec(gate.text) || [])[1];
  const estimate = values['synthetic-cost'] ?? answered;
  if (gate.ok && estimate == null) {
    throw usageError('the checklist is complete; synthetic probes also need their estimated cost: add "Estimated '
      + 'credits per synthetic run: <n>" to the checklist or pass --synthetic-cost <n>');
  }
  const cost = gate.ok ? numberOption({ 'synthetic-cost': estimate }, 'synthetic-cost', 0, { allowZero: true }) : null;
  const cron = values.schedule ? String(values.schedule).trim() : '17 */6 * * *';
  if (!/^[0-9*/,-]+(\s+[0-9A-Za-z*/,-]+){4}$/.test(cron)) throw usageError('--schedule must be a 5-field cron (UTC)');
  const vendored = vendoredSkill(env, values['skill-path']);
  const features = new Set([gate.ok ? 'synthetic' : 'no-synthetic', vendored ? 'vendored' : 'pinned']);
  const vars = commonVars(env, {
    out, cron, header: ciHeader('live'), package_name: `${slugify(path.basename(root))}-live-probes`,
    base_url: httpUrl(values['base-url'] || 'https://staging.example.invalid', ' (the token goes into .adc/.env.live)'),
    health_path: httpPath(values['health-path'] || '/health'), synthetic_cost: cost == null ? 'TODO' : String(cost),
    checklist: shown, gate_reason: gate.exists ? `${gate.open} TODO line(s) in ${shown}` : `${shown} is missing`,
    synthetic_env_note: gate.ok ? ', and in "live-write" (required reviewers) for the synthetic job' : '',
  });
  vars.get_adc = getAdcStep(vendored, vars);
  vars.probe_setup = fragment(bundle, 'probe-setup', { lang }, vars);
  vars.synthetic_job = gate.ok ? fragment(bundle, 'synthetic-job', { lang }, vars) : '';
  const outputs = renderFiles(bundle, { lang }, features, vars, out);
  // The checklist: the answered file when it was given elsewhere, else the template while none exists.
  if (gate.ok && !samePath(checklist, inProject)) {
    outputs.push({ path: checklistOut, content: gate.text.replace(/\r\n/g, '\n') });
  } else if (!fs.existsSync(inProject)) {
    outputs.push({ path: checklistOut, content: `${fragment(bundle, 'checklist', { lang }, vars)}\n` });
  }
  const probes = liveProbes(lang, out, cost, values);
  const manifest = `${JSON.stringify({ schema: 'adc-probes/1', probes }, null, 2)}\n`;
  outputs.push({ path: joinOut(out, 'probes.json'), content: manifest, merge: mergeProbes(probes) });
  const synthetic = { enabled: gate.ok, reason: gate.reason, checklist: shown, open: gate.open };
  synthetic.open_items = gate.open_items || [];
  if (gate.ok) synthetic.cost = cost;
  const data = { synthetic, health_path: vars.health_path, base_url: vars.base_url, vendored_skill: vendored };
  data.probes = probes.map((x) => x.id);
  return { lang, out, outputs, next: nextSteps(bundle, { lang }, features, vars), data };
}

/** After writing the live project: owner-only .adc/ templates and the ignore post-condition. */
function liveAfterWrite(env, out) {
  const info = prepareStateDir({ ...env.ctx, cwd: env.root }, { create: true });
  const mat = materializeTemplates(info);
  const state = { dir: toPosix(info.dir), exclude: info.exclude, budget: mat.budget, env_live: mat.envLive };
  const fail = (id, file, message, evidence = '') => ({ id, severity: 'fail', file, line: null, message, evidence });
  const { created, reason, path: envPath } = mat.envLive;
  const findings = created || !reason ? [] : [fail('LIVE-ENV-FILE', envPath, reason)];
  if (!env.state.root) return { state, findings, gitignore: { verified: false, reason: 'not a git repository' } };
  // Traces, HAR files and reports record request headers, so every one of them must stay out of git.
  const rels = ['test-results/x.xml', 'playwright-report/index.html', 'blob-report/x.zip', 'trace.har']
    .map((p) => joinOut(out, p));
  const res = gitRaw(env.root, ['check-ignore', '--stdin', '-z'], { input: `${rels.join('\0')}\0` });
  const ignored = new Set(res.exit === 0 ? res.stdout.split('\0') : []);
  const paths = rels.map((p) => ({ path: p, ignored: ignored.has(p) }));
  for (const p of paths.filter((x) => !x.ignored)) {
    const message = `${p.path} would not be ignored by git (traces and reports record request headers); fix the `
      + `ignore rules (an in-tree negation overrides ${out}/.gitignore)`;
    findings.push(fail('LIVE-GITIGNORE', p.path, message, `git check-ignore -q ${p.path}`));
  }
  return { state, findings, gitignore: { verified: paths.every((p) => p.ignored), paths } };
}

// ---------------------------------------------------------------------------
// regress (plan §10.1)

async function buildRegress(env) {
  const { values } = env;
  if (!values.issue) throw usageError('regress needs --issue <id or URL> (the bug the test pins down)');
  if (!values.behavior) throw usageError('regress needs --behavior "<what must hold>" (it names the test)');
  const level = values.level ? String(values.level) : 'unit';
  if (!['unit', 'integration', 'e2e'].includes(level)) throw usageError('--level must be unit, integration or e2e');
  const { lang, out } = resolveLang(env, { strict: true });
  const node = nodeSetup(env, lang);
  if (values.characterize && !['ts', 'js', 'python'].includes(lang)) {
    throw usageError('--characterize templates exist for TypeScript, JavaScript and Python; elsewhere use insta '
      + '(Rust), goldie (Go) or Verify (.NET), see references/regress.md');
  }
  const raw = String(values.issue).trim();
  const issueId = (/\/(?:issues|pull)\/(\d+)\b/.exec(raw) || [])[1] || raw.replace(/^#/, '');
  const issue = ident(issueId, 24);
  const numeric = /^\d+$/.test(issueId);
  const issueRef = numeric ? `#${issueId}` : plainText(issueId, 40);
  const behavior = plainText(values.behavior, 100);
  const testName = `test_${issue}_${ident(behavior, 48)}`;
  const fileName = {
    ts: `${issue}-${slugify(behavior, 40)}.test.ts`, js: `${issue}-${slugify(behavior, 40)}.test.${node.vars.ext}`,
    python: `${testName}.py`, go: `regression_${issue}_test.go`, rust: `regression_${issue}.rs`,
    java: `Issue${pascal(issue)}${pascal(behavior).slice(0, 40)}Test.java`, ruby: `issue_${issue}_spec.rb`,
    dotnet: `Issue${pascal(issue)}RegressionTests.cs`,
  }[lang];
  const testPath = joinOut(out, fileName);
  const slug = `${issue}-${slugify(behavior, 32)}`;
  const runCmd = node.flavor ? `${node.run} ${projectRelative(env, testPath)}` : {
    python: `python -m pytest ${testPath}`, go: `go test ./${joinOut(out, '...')} -run 'Test_${issue}_'`,
    rust: `cargo test --test regression_${issue}`, java: `mvn -B test -Dtest=${fileName.replace(/\.java$/, '')}`,
    dotnet: 'dotnet test --filter "Category=regression"', ruby: `bundle exec rspec ${testPath}`,
  }[lang];
  const goDir = abs(env.root, out);
  const goFiles = lang === 'go' && isDir(goDir) ? fs.readdirSync(goDir).filter((f) => f.endsWith('.go')).sort() : [];
  const goPackage = goFiles.map((f) => (/^package\s+(\w+)/m.exec(readText(abs(goDir, f), '')) || [])[1]).find(Boolean);
  const link = /^https?:\/\//.test(raw) ? plainText(raw, 200)
    : numeric ? `${issueRef} (link it with "Fixes ${issueRef}" in the PR)` : issueRef;
  const vars = commonVars(env, {
    out, issue_ref: issueRef, issue_link: link, behavior, test_name: testName, py_test_name: testName, slug, level,
    test_path: testPath, file_name: fileName, class_name: fileName.replace(/\.(java|cs)$/, ''),
    go_test_name: `T${testName.slice(1)}`, characterize_name: slug, run_cmd: runCmd, state_rel: env.state.rel || '.adc',
    go_package: goPackage ? goPackage.replace(/_test$/, '') : ident(path.basename(goDir), 30),
    golden_dir: projectRelative(env, `${out}/__golden__`), ...node.vars,
  });
  const features = new Set([level, values.characterize && 'characterize']);
  const bundle = tmpl('regress');
  const data = { issue: issueRef, test_name: testName, test_file: testPath, level, flavor: node.flavor };
  return {
    lang, out, outputs: renderFiles(bundle, { lang }, features, vars, out, { cjs: node.cjs }),
    next: nextSteps(bundle, { lang }, features, vars), data: { ...data, repro: `${vars.state_rel}/repro/${slug}/` },
  };
}

// ---------------------------------------------------------------------------
// ci-gate (plan §10.5); per-runner CI flags are ci-gate.tmpl's `runners` data (detect.mjs owns detection)

/** CI test step for one project (full suite, retries off, a report): { cmd, format, report, env, runner } or null. */
export function ciTestCommand(runner, { reportDir = 'reports', testCmd = null, quarantine = false } = {}) {
  const fill = (s) => String(s || '').replace(/<d>/g, reportDir);
  const known = testCmd ? null : ciData('runners')[runner.name];
  if (!known) {
    // A command the companion does not know: its own output is the report (summary-line parsing).
    const cmd = testCmd || runner.cmd;
    return cmd ? { cmd: `${cmd} 2>&1 | tee ${reportDir}/test-output.log`, format: 'summary',
      report: `${reportDir}/test-output.log`, env: {}, runner: testCmd ? 'custom' : runner.name } : null;
  }
  const parts = [known.cmd || runner.cmd, fill(known.ci), quarantine && known.skip].filter(Boolean);
  const env = Object.fromEntries(Object.entries(known.env || {}).map(([k, v]) => [k, fill(v)]));
  const report = fill(known.report || '<d>/junit.xml');
  return { cmd: parts.join(' ') + fill(known.tail), format: known.format || 'junit', report, env, runner: runner.name };
}

/** Coverage command and report for the changed-line gate, or null when no producer is known to exist. */
function ciCoverage(runner, env, p) {
  const c = (ciData('runners')[runner.name] || {}).coverage;
  if (!c) return null;
  const dir = abs(env.root, toPosix(p.root || '.'));
  const pkg = readJson(path.join(dir, 'package.json'), null) || {};
  const manifests = ['pyproject.toml', 'requirements.txt', 'requirements-dev.txt', 'setup.cfg', 'uv.lock']
    .map((f) => readText(path.join(dir, f), '')).join('\n').toLowerCase();
  const declared = (d) => (pkg.dependencies || {})[d] || (pkg.devDependencies || {})[d] || manifests.includes(d);
  if (c.requires && !c.requires.some(declared)) return null;
  return { cmd: c.cmd.replace('<cmd>', runner.cmd), report: c.report, tool: c.tool || 'diff-cover' };
}

const SETUP = { python: 'python', go: 'go', rust: 'rust', dotnet: 'dotnet', jvm: 'java', ruby: 'ruby' };

/** Toolchain setup steps for a project's CI jobs (always with Node 24: adc.mjs and gate.mjs need it). */
function setupFor(p, vars) {
  const bundle = tmpl('ci-gate');
  const root = toPosix(p.root || '.');
  const dir = root === '.' ? '' : `${root}/`;
  const mgr = firstManager(p);
  const has = (f) => fs.existsSync(abs(vars.repo_root, joinOut(root, f)));
  const lockfile = mgr.lockfile ? joinOut(root, mgr.lockfile) : '';
  const runners = (p.runners || []).map((r) => r.name);
  const v = {
    ...vars, project_root: root, project_dir: dir, lockfile,
    node_cache: ['npm', 'pnpm', 'yarn'].includes(mgr.name) && lockfile ? mgr.name : '',
    python_version: has('.python-version') ? `python-version-file: ${dir}.python-version` : "python-version: '3.12'",
    dotnet_version: has('global.json') ? `global-json-file: ${dir}global.json` : "dotnet-version: '8.0.x'",
    java_cache: ['maven', 'gradle'].filter((r) => runners.includes(r)).map((r) => `cache: ${r}`)[0] || '',
  };
  v.python_tool = ['uv', 'poetry'].includes(mgr.name) ? fragment(bundle, `python-tool-${mgr.name}`, {}, v) : '';
  const node = ['pnpm', 'yarn', 'bun'].includes(mgr.name) ? mgr.name : v.node_cache ? 'node-cache' : 'node';
  return fragment(bundle, `setup-${SETUP[ecosystemOf(p)] || node}`, {}, v);
}

/** --os, else the OSes the repository's workflows already use, else Linux. */
function osMatrix(env) {
  const labels = { linux: 'ubuntu-latest', windows: 'windows-latest', macos: 'macos-latest' };
  if (env.values.os) {
    const list = String(env.values.os).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
      .map((o) => labels[o] || (/^(ubuntu|windows|macos)-[\w.]+$/.test(o) ? o : null));
    if (!list.length || list.includes(null)) throw usageError('--os takes linux, windows, macos or runner labels');
    return [...new Set(list)];
  }
  const text = ((env.det.ci && env.det.ci.files) || []).map((f) => readText(abs(env.root, f), '')).join('\n');
  const seen = Object.values(labels).filter((o) => new RegExp(`\\b${o.slice(0, -7)}-(?:latest|[\\d.]+)\\b`).test(text));
  return seen.length ? seen : ['ubuntu-latest'];
}

/** The quarantine registry written by `scaffold flake` (adc-quarantine/1), repo-relative, or null. */
const findRegistry = (root) => ['tests', 'test', 'spec', '.'].map((d) => joinOut(d, 'quarantine.json'))
  .find((rel) => (readJson(abs(root, rel), null) || {}).schema === 'adc-quarantine/1') || null;

const PUBLISHER = { junit: 'java-junit', 'go-test-json': 'golang-json', trx: 'dotnet-trx', 'rspec-json': 'rspec-json' };

async function buildCiGate(env) {
  const { values, root } = env;
  const bundle = tmpl('ci-gate');
  const threshold = numberOption(values, 'threshold', 80, { allowZero: true });
  if (threshold > 100) throw usageError('--threshold is a percentage from 0 to 100');
  const maxFlaky = numberOption(values, 'max-flaky', 0, { integer: true, allowZero: true });
  const hosts = parseFor(values.for);
  const os = osMatrix(env);
  const testCmd = values['test-cmd'] || null;
  const projects = testCmd ? [env.project || { root: '.' }]
    : (env.det.projects || []).filter((p) => (p.runners || []).some((r) => r && r.cmd));
  const noRunner = 'pass --test-cmd "<the command that runs the whole suite>"';
  if (!projects.length) throw envError('NO_RUNNER', `no test runner was detected; ${noRunner}`);
  const registry = findRegistry(root);
  const [runners, auditCmds] = [ciData('runners'), ciData('audits')];
  const vendored = vendoredSkill(env, values['skill-path']);
  const base = commonVars(env, {
    header: ciHeader('ci-gate'), header_js: helperHeader(), threshold: String(threshold), max_flaky: String(maxFlaky),
    os_list: os.join(', '), registry: registry || 'tests/quarantine.json', repo_root: root,
    agent_hosts: hosts.join(', '),
  });
  base.get_adc = getAdcStep(vendored, base);
  const [jobs, testJobs, gateJobs, audits, notes] = [[], [], [], [], []];
  for (const p of projects) {
    const proot = toPosix(p.root || '.');
    const slug = proot === '.' ? 'root' : slugify(proot, 30);
    const runner = unitRunners(p).find((r) => r.cmd) || null;
    const { install, name: mgr = '' } = firstManager(p);
    const v = {
      ...base, slug, project_root: proot, project_dir: proot === '.' ? '' : `${proot}/`, setup: setupFor(p, base),
      project_label: proot === '.' ? 'repository root' : proot, os_matrix: os.map((o) => `"${o}"`).join(', '),
      install_cmd: install || `echo "no frozen install command was detected for ${proot}; add one here"`,
    };
    if (!install) notes.push(`${proot}: no frozen install command was detected; edit the "Install (frozen)" steps`);
    const step = runner || testCmd ? ciTestCommand(runner || {}, { testCmd, quarantine: Boolean(registry) }) : null;
    if (step) {
      const envLines = Object.entries(step.env).map(([k, x]) => `          ${k}: ${x}`);
      Object.assign(v, {
        test_cmd: step.cmd, report_format: step.format, report_path: step.report, runner_name: step.runner,
        report_upload: `${v.project_dir}${step.report}`, publisher: PUBLISHER[step.format] || '',
        test_env: envLines.length ? `\n        env:\n${envLines.join('\n')}` : '',
      });
      v.publish = v.publisher ? fragment(bundle, 'publish-junit', {}, v) : '';
      jobs.push(fragment(bundle, 'test-job', {}, v));
      testJobs.push(`test-${slug}`);
    }
    const cov = testCmd || !runner ? null : ciCoverage(runner, env, p);
    if (cov) {
      gateJobs.push(`coverage-${slug}`);
      const covVars = { ...v, coverage_cmd: cov.cmd, coverage_report: cov.report };
      jobs.push(fragment(bundle, cov.tool === 'adc' ? 'coverage-job-adc' : 'coverage-job', {}, covVars));
    } else if (runner && !testCmd) {
      notes.push(`${proot}: no changed-line coverage producer known for ${runner.name} (references/ci-gate.md)`);
    }
    const pw = (p.runners || []).find((r) => r.name === 'playwright');
    if (pw) {
      gateJobs.push(`e2e-${slug}`);
      const e2eCmd = registry ? `${pw.cmd} ${runners.playwright.skip}` : pw.cmd;
      jobs.push(fragment(bundle, 'e2e-job', {}, { ...v, e2e_cmd: e2eCmd }));
    }
    const eco = ecosystemOf(p) || 'node';
    const audit = auditCmds[`${eco}:${mgr}`] || auditCmds[eco];
    const auditName = `${eco} dependency audit (${proot})`;
    if (audit) audits.push(fragment(bundle, 'audit-step', {}, { ...v, audit_cmd: audit, audit_name: auditName }));
  }
  if (!testJobs.length && !gateJobs.length) throw envError('NO_RUNNER', `no CI test command was built; ${noRunner}`);
  const needs = ['changes', ...testJobs, ...gateJobs, 'ratchet', 'secrets', ...(registry ? ['quarantine'] : [])];
  const outputsOf = (job) => ['executed', 'passed', 'failed', 'skipped', 'flaky']
    .map((k) => `      ${k}: \${{ needs.${job}.outputs.${k} }}`).join('\n');
  const vars = {
    ...base, test_jobs: jobs.join('\n\n'), needs_list: needs.join(', '),
    merge_outputs: testJobs.length ? `    outputs:\n${outputsOf(testJobs[0])}` : '',
    audit_steps: audits.length ? audits.join('\n') : fragment(bundle, 'audit-none', {}, base),
    agent_jobs: hosts.map((h) => {
      const { label, cost, home, package: pkg } = ciData('agents')[h];
      const verify = fragment(bundle, `agent-verify-${h}`, {}, base);
      return fragment(bundle, 'agent-job', {}, { ...base, agent: h, agent_label: label, agent_cost: cost,
        agent_home: home, agent_package: pkg, agent_verify: verify });
    }).join('\n'),
    quarantine_job: registry ? fragment(bundle, 'quarantine-job', {}, base) : '',
  };
  const features = new Set([vendored ? 'vendored' : 'pinned', hosts.length && 'agents', registry && 'registry']);
  const outputs = renderFiles(bundle, {}, features, vars, '.');
  for (const o of outputs) if (o.path.endsWith('.yml')) o.content = o.content.replace(/\n{3,}/g, '\n\n');
  const data = { os, projects: projects.map((p) => toPosix(p.root || '.')), threshold, max_flaky: maxFlaky };
  return {
    lang: null, out: '.github', outputs, next: [...nextSteps(bundle, {}, features, vars), ...notes],
    data: { ...data, quarantine: registry, agent_hosts: hosts, vendored_skill: vendored, jobs: needs },
  };
}

// ---------------------------------------------------------------------------
// flake (plan §10.4)

async function buildFlake(env) {
  const { values } = env;
  const out = env.outRel || 'tests';
  const p = env.project || { root: '.', ecosystems: ['node'] };
  const runner = unitRunners(p)[0] || (p.runners || [])[0] || null;
  const e2e = (p.runners || []).find((r) => r.kind === 'e2e');
  const testId = values.test ? plainText(values.test, 160) : null;
  const maxFlaky = numberOption(values, 'max-flaky', 0, { integer: true, allowZero: true });
  const probeTests = testId ? ` --tests ${cString(testId)}` : '';
  const { only, skip } = (runner && ciData('runners')[runner.name]) || {};
  const see = '(see references/flake.md)';
  const vars = commonVars(env, {
    out, header: ciHeader('flake'), header_js: helperHeader(), max_flaky: String(maxFlaky),
    runner_name: runner ? runner.name : 'unknown', e2e_runner: e2e ? e2e.name : 'none',
    quarantine_run: runner && runner.cmd && only ? `${runner.cmd} ${only}`
      : 'echo "::error::no quarantine selector is known for this runner; edit this step (references/flake.md)"; exit 1',
    quarantine_skip: skip || see, quarantine_only: only || see, test_id: testId || '', slug: slugify(testId, 40),
    flake_probe: `node <skill>/scripts/adc.mjs flake-probe${probeTests} --times 20 --json`,
    install_cmd: firstManager(p).install || 'echo "no frozen install command was detected; add one here"',
    registry: joinOut(out, 'quarantine.json'), policy: joinOut(out, 'flaky-test-policy.md'),
    project_root: env.projectRoot, repo_root: env.root, state_rel: env.state.rel || '.adc',
  });
  vars.setup = setupFor(p, vars);
  const features = new Set(testId ? ['diagnosis'] : []);
  const bundle = tmpl('flake');
  // The helper the ci-gate workflow uses: identical content, so whichever scaffold runs second leaves it unchanged.
  const outputs = [...renderFiles(bundle, {}, features, vars, out),
    ...renderFiles(tmpl('ci-gate'), {}, new Set(['gate-script-only']), vars, '.')];
  return {
    lang: null, out, outputs, next: nextSteps(bundle, {}, features, vars),
    data: { runner: runner ? runner.name : null, max_flaky: maxFlaky, test: testId },
  };
}

// ---------------------------------------------------------------------------
// Entry points

const BUILDERS = {
  'e2e-web': buildE2eWeb, 'e2e-api': buildE2eApi, 'e2e-cli': buildE2eCli, live: buildLive, regress: buildRegress,
  'ci-gate': buildCiGate, flake: buildFlake,
};

async function prepare(kind, ctx, values) {
  // Real paths throughout: git reports the resolved top level (macOS /var is /private/var; symlinked checkouts).
  const cwd = realPath(ctx.cwd);
  const gitRoot = repoRoot(cwd);
  const root = gitRoot || cwd;
  const outAbs = values.out ? realPath(path.resolve(cwd, values.out)) : null;
  if ([cwd, root, outAbs].some((p) => p && within(SKILL_DIR, p))) {
    throw usageError('refusing to scaffold into the companion skill itself; pass --cwd <target repository>');
  }
  // Exit 3 while anything under the state dir is tracked; nothing is created here (and git is not asked twice).
  const state = resolveStateDir({ cwd: root, stateDirOption: ctx.stateDirOption, root: gitRoot });
  assertStateUntracked(state);
  const outRel = outAbs ? relPosix(root, outAbs) : null;
  if (outAbs && outRel == null) throw usageError(`--out must stay inside ${toPosix(root)} (got ${values.out})`);
  if (outRel && (outRel.split('/')[0] === '.git' || (state.rel && under(outRel, state.rel)))) {
    throw usageError(`--out must not point into .git or ${state.rel || 'the state dir'} (got ${values.out})`);
  }
  const det = await detect({ root, stateInfo: fs.existsSync(state.dir) ? state : null, write: false });
  const project = pickProject(det, outRel);
  return {
    kind, ctx, cwd, values, root, state, outRel, det, project, projectRoot: toPosix((project && project.root) || '.'),
    write: Boolean(values.write) && !ctx.dryRun, force: Boolean(values.force),
    defaultBranch: det.default_branch || 'main',
  };
}

/** Render one scaffold from parsed CLI `values`; the result lists written[], skipped[], next_steps[] and exit. */
export async function scaffold({ kind, ctx, values = {} }) {
  const kinds = [...TEST_KINDS, ...TOOLING_KINDS].join(', ');
  if (!kind) throw usageError(`scaffold needs a kind: ${kinds}`);
  if (TOOLING_KINDS.includes(kind)) {
    return { kind, delegated: 'tooling scaffold', ...(await scaffoldTooling(kind, { ctx, values })), exit: EXIT.OK };
  }
  if (!TEST_KINDS.includes(kind)) throw usageError(`unknown scaffold kind "${kind}" (expected ${kinds})`);
  const env = await prepare(kind, ctx, values);
  const detected = { summary: env.det.summary || null, project: env.project ? env.projectRoot : null,
    runner: (unitRunners(env.project)[0] || {}).name || null, manager: firstManager(env.project).name || null };
  if (kind === 'e2e-web' && values.audit) {
    const audit = auditE2eWeb(env);
    const next = audit.items.length ? ['fix P1 items first; each item names the rule, the location and the fix',
      'then add missing pieces with scaffold e2e-web --write (existing files are kept)'] : ['no hardening items found'];
    const exit = audit.counts.P1 || audit.counts.P2 ? EXIT.FINDINGS : EXIT.OK;
    const res = { kind, mode: 'audit', root: toPosix(env.root), dry_run: true, detected, audit, written: [] };
    return { ...res, next_steps: next, exit };
  }
  const plan = await BUILDERS[kind](env);
  const applied = applyOutputs(plan.outputs, env);
  const res = {
    kind, lang: plan.lang, root: toPosix(env.root), out: plan.out, dry_run: !env.write, detected, ...applied,
    next_steps: plan.next, ...plan.data, exit: EXIT.OK,
  };
  const checklist = joinOut(plan.out, 'live-checklist.md');
  if (kind === 'live' && env.write) {
    Object.assign(res, liveAfterWrite(env, plan.out));
    const runnerGate = checklistGate(abs(env.root, checklist));
    if (res.synthetic.enabled && !runnerGate.ok) {
      res.next_steps.unshift(`the runner reads ${checklist}, which has ${runnerGate.open ?? 'no'} TODO line(s): `
        + 'copy the answered checklist there (or re-run with --force), or synthetic probes stay SYNTHETIC_GATED');
    }
    if (res.findings.length) res.exit = EXIT.FINDINGS;
  } else if (kind === 'live') {
    res.state = { dir: toPosix(env.state.dir), planned: ['exclude entry', 'budget.json', '.env.live (empty, 0600)'] };
    res.gitignore = { verified: null, reason: 'dry run: verified with git check-ignore after --write' };
  }
  if (!env.write) {
    const n = applied.written.filter((w) => w.action !== 'unchanged').length;
    res.next_steps.unshift(`dry run: nothing was written; show the user these ${n} file(s), then re-run with --write`);
  }
  if (applied.skipped.length) {
    res.next_steps.unshift(`${applied.skipped.length} existing file(s) were left alone (listed in skipped); merge by `
      + 'hand, or re-run with --force (backups go to .adc/backups/scaffold/)');
  }
  return res;
}

/** `scaffold <kind> [options]` (also `--kind <kind>`); tooling kinds also accept tooling's options. */
export async function scaffoldCommand(argv) {
  // One parse with both option sets (shared names have the same types); the kind decides which apply.
  const { values, positionals } = parseOpts(argv, { ...TOOLING_SCAFFOLD_OPTIONS, ...OPTIONS });
  if (values.help) return { result: { usage: USAGE }, exit: EXIT.OK, human: USAGE, summary: '' };
  if (values.kind && positionals[0] && positionals[0] !== values.kind) {
    throw usageError(`two kinds given: ${positionals[0]} and --kind ${values.kind}`);
  }
  const kind = values.kind || positionals[0] || null;
  const foreign = TOOLING_KINDS.includes(kind) ? null : Object.keys(values).find((k) => !(k in OPTIONS)
    && k in TOOLING_SCAFFOLD_OPTIONS);
  if (foreign) throw usageError(`--${foreign} is a tooling scaffold option; ${kind || 'this kind'} does not take it`);
  const { exit, ...result } = await scaffold({ kind, ctx: makeContext(values), values });
  const n = (result.written || []).filter((w) => w.action !== 'unchanged').length;
  const findings = result.findings && result.findings.length ? `, ${result.findings.length} finding(s)` : '';
  const counts = result.audit && ['P1', 'P2', 'P3'].map((k) => `${result.audit.counts[k]} ${k}`).join(', ');
  const kept = (result.skipped || []).length;
  const done = `${n} file(s) ${result.dry_run ? 'planned (dry run)' : 'written'}, ${kept} skipped`;
  const summary = result.mode === 'audit' ? `${result.audit.items.length} hardening item(s): ${counts}`
    : `${kind}${result.lang ? ` (${result.lang})` : ''}: ${done}${findings}`;
  return { result, exit, summary };
}
scaffoldCommand.commandName = 'scaffold';
scaffoldCommand.usage = USAGE;
