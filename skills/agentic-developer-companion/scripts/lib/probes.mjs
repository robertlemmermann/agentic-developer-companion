// Soft QA probes on the working-tree snapshot (§7.2, §9.1 steps 12-14, §10.4): changed-line
// coverage (CK-COVERAGE), mutation testing restricted to changed files (CK-MUTATION) and repeated,
// shuffled runs of changed tests (CK-FLAKE). Built on the clean-run worktree and runner plumbing.

import { randomInt } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { defineCommand, usageError, readJson, readText, writeFileAtomic, ensureDir, nonce, toPosix, quoteArg, tmpRoot, which, IS_WINDOWS, truncate, matchAny } from './core.mjs';
import { diffLines, emptyTree, diffNameStatus, git } from './git.mjs';
import { prepareTarget } from './state.mjs';
import { parseCoverage, detectCoverageFormat, isTestPath, rootVariants } from './reports.mjs';
import {
  loadDetect, resolveRunner, projectOf, acquireWorktree, releaseWorktrees, runProject, storeArtifacts, makeCheck, projectSlug,
  worstStatus, exitFor, isCodeFile, testMatchesFile, runStep, runEnv, installProject, artifactPath, redactText, loadMarkers,
} from './clean-run.mjs';

const FM_COVERAGE = ['FM-03'];
const FM_MUTATION = ['FM-03', 'FM-16'];
const FM_FLAKE = ['FM-13'];
const DEFAULT_TIMES = 5;
const DEFAULT_BUDGET_MIN = 20;
const DEFAULT_TIMEOUT_S = 1800;
const GENERATED_RE = /(?:^|\/)(?:dist|build|out|vendor|node_modules|third_party|generated|__generated__|gen)\/|\.min\.[cm]?js$|\.pb\.go$|_pb2(?:_grpc)?\.pyi?$|\.g\.(?:cs|dart)$|\.designer\.cs$|\.generated\.\w+$/i;

const log = (msg) => { if (process.env.ADC_QUIET !== '1') process.stderr.write(`adc: ${msg}\n`); };

// ---------------------------------------------------------------------------
// Shared: file classification and changed lines

let detectMod;
let markersMod;
async function classifiers(detectResult) {
  if (detectMod === undefined) { try { detectMod = await import('./detect.mjs'); } catch { detectMod = null; } }
  if (markersMod === undefined) { try { markersMod = await import('./markers.mjs'); } catch { markersMod = null; } }
  const globs = (detectResult.projects || []).flatMap((p) => (p.test_globs || []).map((g) => (p.root && p.root !== '.' ? `${toPosix(p.root)}/${g}` : g)));
  const isTest = (f) => {
    if (detectMod && typeof detectMod.isTestFile === 'function') {
      try { return Boolean(detectMod.isTestFile(f, detectResult)); } catch {}
    }
    if (markersMod && typeof markersMod.classifyPath === 'function') {
      try { if (markersMod.classifyPath(f).test) return true; } catch {}
    }
    return isTestPath(f) || (globs.length > 0 && matchAny(f, globs));
  };
  const isGenerated = (f) => {
    if (markersMod && typeof markersMod.classifyPath === 'function') {
      try { if (markersMod.classifyPath(f).generated) return true; } catch {}
    }
    return GENERATED_RE.test(f);
  };
  return { isTest, isGenerated };
}

/** Added lines per changed source file (not tests, not generated): `[{ file, lines: [n...] }]`. */
async function changedSourceLines(target, detectResult) {
  const { isTest, isGenerated } = await classifiers(detectResult);
  const from = target.base.sha || emptyTree(target.root);
  const files = diffLines(target.root, from, target.snapshot.commit);
  return files
    .filter((f) => f.status !== 'D' && !f.binary && f.path && isCodeFile(f.path) && !isTest(f.path) && !isGenerated(f.path))
    .map((f) => ({ file: toPosix(f.path), lines: f.added.filter((a) => a.text.trim() !== '').map((a) => a.line) }))
    .filter((f) => f.lines.length);
}

const projectDirIn = (wt, project) => (project.root && project.root !== '.' ? path.join(wt.dir, project.root) : wt.dir);

/** Map a path from a coverage report to a repo-relative path. */
function toRepoPath(p, project, wtDir) {
  const s = toPosix(p);
  if (s.startsWith('/') || /^[A-Za-z]:\//.test(s)) {
    for (const r of rootVariants([wtDir])) if (s.startsWith(r + '/')) return s.slice(r.length + 1);
    return s;
  }
  return project && project.root && project.root !== '.' ? `${toPosix(project.root)}/${s}` : s;
}

const textOfDeps = (dir) => ['package.json', 'pyproject.toml', 'requirements.txt', 'requirements-dev.txt', 'dev-requirements.txt', 'setup.cfg', 'uv.lock', 'poetry.lock', 'Pipfile', 'Pipfile.lock', 'tox.ini']
  .map((f) => readText(path.join(dir, f), '') || '').join('\n');

const requirementMet = (dir, names) => !names || !names.length || names.some((n) => textOfDeps(dir).includes(n));

const ranges = (lines) => {
  const out = [];
  for (const n of [...lines].sort((a, b) => a - b)) {
    const last = out[out.length - 1];
    if (last && n === last[1] + 1) last[1] = n;
    else out.push([n, n]);
  }
  return out.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`));
};

// ---------------------------------------------------------------------------
// coverage-delta

/** Changed-line coverage from parsed coverage files (`{ files }` keyed by repo path) and changed lines. */
export function computeChangedCoverage(changed, coverageFiles) {
  let total = 0;
  let covered = 0;
  let precision = 'line';
  const uncovered = [];
  const notInReport = [];
  const branches = [];
  const perFile = [];
  for (const { file, lines } of changed) {
    const data = coverageFiles[file];
    if (!data) { notInReport.push(file); continue; }
    if (!data.lines || !Object.keys(data.lines).length) {
      if (data.summary && Number.isFinite(data.summary.pct)) {
        // File-level data only: approximate the changed lines by the file's line rate.
        precision = 'file';
        const n = lines.length;
        const c = Math.round((n * data.summary.pct) / 100);
        total += n; covered += c;
        perFile.push({ file, changed: n, covered: c, approximate: true });
      } else notInReport.push(file);
      continue;
    }
    const miss = [];
    let fileTotal = 0;
    let fileCovered = 0;
    for (const n of lines) {
      const k = String(n);
      if (!(k in data.lines)) continue;
      fileTotal++;
      if (data.lines[k] > 0) fileCovered++;
      else miss.push(n);
      const br = data.branches && data.branches[k];
      if (br && br[1] > br[0]) branches.push({ file, line: n, covered: br[0], total: br[1] });
    }
    total += fileTotal;
    covered += fileCovered;
    perFile.push({ file, changed: fileTotal, covered: fileCovered });
    if (miss.length) uncovered.push({ file, lines: miss, ranges: ranges(miss) });
  }
  return {
    changed_lines: total, covered, pct: total ? Math.round((covered / total) * 1000) / 10 : null,
    uncovered, files_not_in_report: notInReport, untested_branches: branches, precision, files: perFile,
  };
}

function findFile(dir, name, depth = 0) {
  if (!dir || !fs.existsSync(dir) || depth > 6) return null;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isFile() && e.name === name) return full;
    if (e.isDirectory()) { const hit = findFile(full, name, depth + 1); if (hit) return hit; }
  }
  return null;
}

async function diffCoverCrossCheck(target, wtDir, reportFile, format, outDir) {
  if (!which('diff-cover') || !['lcov', 'cobertura'].includes(format)) return null;
  const diffFile = path.join(outDir, 'snapshot.diff');
  const from = target.base.sha || emptyTree(target.root);
  writeFileAtomic(diffFile, git(target.root, ['diff', '--no-color', '--no-ext-diff', from, target.snapshot.commit]) + '\n');
  const jsonOut = path.join(outDir, 'diff-cover.json');
  const res = await runStep(`diff-cover ${quoteArg(reportFile)} --diff-file ${quoteArg(diffFile)} --format ${quoteArg(`json:${jsonOut}`)}`, { cwd: wtDir, env: runEnv().env, timeoutMs: 300_000 });
  const j = readJson(jsonOut, null);
  if (!j) return { exit: res.exit, error: 'no JSON report' };
  return { exit: res.exit, pct: j.total_percent_covered ?? null, lines: j.total_num_lines ?? null, violations: j.total_num_violations ?? null };
}

/**
 * Changed-line coverage (§9.1 step 12). With `report`, the given coverage file(s) are mapped onto
 * the snapshot diff; otherwise the suite runs with coverage in a snapshot worktree.
 * Returns `{ tool, changed_lines, covered, pct, uncovered[], precision, ..., checks }`.
 */
export async function coverageDelta({ target, detectResult = null, failUnder = null, report = null, runner = null, noInstall = false, keep = false, timeoutS = DEFAULT_TIMEOUT_S, dryRun = false } = {}) {
  const root = target.root;
  const tree = target.snapshot.tree;
  await loadMarkers();
  const det = detectResult || await loadDetect(root, target.state);
  const changed = await changedSourceLines(target, det);
  const threshold = failUnder == null || failUnder === '' ? null : Number(failUnder);
  if (threshold != null && !(threshold >= 0 && threshold <= 100)) throw usageError('--fail-under must be a number between 0 and 100');
  const out = { tool: null, source: null, changed_lines: 0, covered: 0, pct: null, uncovered: [], files_not_in_report: [], untested_branches: [], precision: 'line', fail_under: threshold, projects: [], checks: [] };
  const finish = (status, reason, summary, extra = {}) => {
    out.status = status;
    out.checks.push(makeCheck({
      id: 'CK-COVERAGE', fm: FM_COVERAGE, project: extra.project || '.', status, reason, summary, command: extra.command || null, cwd: extra.cwd || null,
      exit_code: extra.exit_code ?? null, duration_ms: extra.duration_ms || 0, output_sha256: extra.output_sha256 || null, artifacts: extra.artifacts || [],
      findings: out.uncovered.slice(0, 100).map((u) => ({ id: 'CK-COVERAGE', severity: threshold != null && status === 'fail' ? 'finding' : 'info', file: u.file, line: u.lines[0], message: `changed lines not covered: ${u.ranges.join(', ')}`, evidence: '' })),
      data: { tool: out.tool, source: out.source, changed_lines: out.changed_lines, covered: out.covered, pct: out.pct, precision: out.precision, fail_under: threshold, enforced: threshold != null, files_not_in_report: out.files_not_in_report, untested_branches: out.untested_branches.slice(0, 100), ...(extra.data || {}) },
    }));
    if (!keep) releaseWorktrees({ root });
    return out;
  };
  if (!changed.length) return finish('skipped', 'NO_CHANGED_CODE', 'no changed source lines (tests, docs and generated files are not measured)');
  const coverageByFile = {};
  const outRoot = path.join(tmpRoot(root), `cov-${tree.slice(0, 12)}-${nonce().slice(0, 6)}`);
  const extra = { artifacts: [], data: {} };
  if (report) {
    const files = (Array.isArray(report) ? report : String(report).split(',')).map((f) => f.trim()).filter(Boolean);
    const tools = [];
    for (const f of files) {
      const abs = path.resolve(target.cwd || root, f);
      const text = readText(abs, null);
      if (text == null) throw usageError(`--report: cannot read ${toPosix(abs)}`);
      const fmt = detectCoverageFormat(text);
      if (!fmt) throw usageError(`--report: unknown coverage format in ${toPosix(abs)} (expected LCOV, Cobertura XML, Istanbul JSON or a Go cover profile)`);
      const goModule = goModuleFor(root, '.');
      const parsed = parseCoverage(fmt, text, { root: [root], goModule });
      for (const [p, d] of Object.entries(parsed.files)) coverageByFile[toRepoPath(p, null, root)] = d;
      tools.push(fmt);
    }
    out.tool = `provided (${[...new Set(tools)].join(', ')})`;
    out.source = 'provided';
  } else {
    const projects = det.projects || [];
    const owners = [...new Set(changed.map((c) => projectOf(c.file, projects)).filter(Boolean))];
    if (!owners.length) return finish('skipped', 'NO_RUNNER', 'no detected project owns the changed source files; pass --report <coverage file>');
    const tools = [];
    const reasons = [];
    for (const project of owners) {
      const prel = toPosix(project.root || '.');
      const slug = projectSlug(prel);
      const r = resolveRunner(project, runner);
      if (!r) { reasons.push(`${prel}: no runner`); continue; }
      const cv = r.coverage;
      if (!cv) { reasons.push(`${prel}: ${r.name} has no built-in coverage mode here; pass --report <file>`); out.projects.push({ root: prel, runner: r.name, status: 'skipped', reason: 'NO_COVERAGE_TOOL' }); continue; }
      if (dryRun) { out.projects.push({ root: prel, runner: r.name, status: 'skipped', reason: 'DRY_RUN', coverage: cv.flag || cv.cmd }); continue; }
      const pdirRepo = path.join(root, project.root || '.');
      if (cv.tool && !which(cv.tool)) { reasons.push(`${prel}: ${cv.tool} is not installed`); out.projects.push({ root: prel, runner: r.name, status: 'skipped', reason: 'NO_COVERAGE_TOOL' }); continue; }
      if (!requirementMet(pdirRepo, cv.requires)) { reasons.push(`${prel}: ${cv.requires.join(' or ')} is not a dependency`); out.projects.push({ root: prel, runner: r.name, status: 'skipped', reason: 'NO_COVERAGE_TOOL' }); continue; }
      // The cache holds the coverage map already mapped to repo paths (worktree paths do not survive).
      const cacheFile = path.join(target.state.paths.cache, 'runs', tree.slice(0, 12), slug, 'coverage-map.json');
      const cached = readJson(cacheFile, null);
      let files = cached && cached.schema === 'adc-coverage-map/1' && cached.runner === r.name ? cached.files : null;
      let runRec = null;
      if (!files) {
        const wt = acquireWorktree(root, target.snapshot.commit, 'head', { keep });
        const pdir = projectDirIn(wt, project);
        runRec = await runProject(wt, project, r, { outDir: path.join(outRoot, slug), noInstall, timeoutMs: timeoutS * 1000, coverage: true, logName: 'coverage.log' });
        const produced = runRec.coverageFile && fs.existsSync(runRec.coverageFile) ? runRec.coverageFile : (cv.search ? findFile(runRec.coverageDir, cv.file) : null);
        const stored = await storeArtifacts(target, tree, slug, { log_path: runRec.log_path, report_path: produced }, { prefix: 'coverage-' });
        extra.artifacts.push(...stored.artifacts);
        extra.output_sha256 = extra.output_sha256 || stored.output_sha256;
        extra.command = extra.command || runRec.cmd;
        extra.exit_code = extra.exit_code ?? runRec.exit;
        extra.duration_ms = (extra.duration_ms || 0) + (runRec.ms || 0);
        if (!produced) { reasons.push(`${prel}: the coverage run wrote no report (exit ${runRec.exit})`); out.projects.push({ root: prel, runner: r.name, status: 'unverified', reason: runRec.status === 'unverified' ? runRec.reason : 'NO_COVERAGE_REPORT', cmd: runRec.cmd, exit: runRec.exit }); continue; }
        const parsed = parseCoverage(cv.format, readText(produced, ''), { root: [pdir], goModule: goModuleFor(pdir, '.') });
        files = {};
        for (const [p, d] of Object.entries(parsed.files)) files[toRepoPath(p, project, wt.dir)] = d;
        try { writeFileAtomic(cacheFile, JSON.stringify({ schema: 'adc-coverage-map/1', runner: r.name, format: cv.format, tree, files }) + '\n'); } catch {}
        const dc = await diffCoverCrossCheck(target, wt.dir, produced, cv.format, path.join(outRoot, slug));
        if (dc && prel === '.') extra.data.diff_cover = dc;
      } else extra.artifacts.push(artifactPath(root, cacheFile));
      Object.assign(coverageByFile, files);
      tools.push(`${r.name} (${cv.format})`);
      out.projects.push({ root: prel, runner: r.name, status: 'measured', source: runRec ? 'run' : 'cache', cmd: runRec ? runRec.cmd : null, exit: runRec ? runRec.exit : null });
    }
    if (!keep) fs.rmSync(outRoot, { recursive: true, force: true });
    if (dryRun) return finish('skipped', 'DRY_RUN', `dry run: would run the suite with coverage for ${owners.map((p) => p.root || '.').join(', ')}`);
    if (!tools.length) {
      const unverified = out.projects.some((p) => p.status === 'unverified');
      return finish(unverified ? 'unverified' : 'skipped', unverified ? 'NO_COVERAGE_REPORT' : 'NO_COVERAGE_TOOL', reasons.join('; ') || 'no coverage could be collected', extra);
    }
    out.tool = tools.join(', ');
    out.source = out.projects.every((p) => p.source === 'cache' || p.status !== 'measured') ? 'cache' : 'run';
    if (reasons.length) extra.data.not_measured = reasons;
  }
  Object.assign(out, computeChangedCoverage(changed, coverageByFile));
  const parts = [];
  if (out.pct == null) {
    const status = threshold != null ? 'fail' : 'skipped';
    return finish(status, 'NOT_IN_REPORT', `none of the ${changed.length} changed source file(s) appear in the coverage report (never loaded by the tests, or excluded)`, extra);
  }
  parts.push(`${out.pct}% of ${out.changed_lines} changed executable line(s) covered`);
  if (out.precision === 'file') parts.push('(approximate: file-level data)');
  if (out.files_not_in_report.length) parts.push(`; ${out.files_not_in_report.length} changed file(s) not in the report: ${out.files_not_in_report.slice(0, 5).join(', ')}`);
  if (out.untested_branches.length) parts.push(`; ${out.untested_branches.length} partially covered branch line(s)`);
  let status = 'pass';
  let reason = null;
  if (threshold != null && out.pct < threshold) { status = 'fail'; reason = 'BELOW_THRESHOLD'; parts.push(`; below --fail-under ${threshold}`); }
  else if (threshold == null) parts.push(' (report-only)');
  return finish(status, reason, parts.join(''), extra);
}

function goModuleFor(dir, rel) {
  const m = /^module\s+(\S+)/m.exec(readText(path.join(dir, 'go.mod'), '') || '');
  return m ? { module: m[1], dir: rel } : null;
}

// ---------------------------------------------------------------------------
// mutation-scope: parsers

const STRYKER_UNDETECTED = new Set(['Survived', 'NoCoverage']);

/** mutation-testing-report-schema JSON (StrykerJS, Stryker.NET) → counts and survivors. */
export function parseStrykerReport(json, { root = null, onlyFiles = null } = {}) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  const res = { mutants: 0, killed: 0, survived: 0, timeout: 0, no_coverage: 0, invalid: 0, ignored: 0, survivors: [] };
  for (const [file, entry] of Object.entries((data && data.files) || {})) {
    let rel = toPosix(file);
    if (root) for (const r of rootVariants([root])) if (rel.startsWith(r + '/')) { rel = rel.slice(r.length + 1); break; }
    if (onlyFiles && !onlyFiles.some((f) => f === rel || f.endsWith('/' + rel) || rel.endsWith('/' + f))) continue;
    for (const m of entry.mutants || []) {
      const st = m.status;
      if (st === 'Ignored' || st === 'Pending') { res.ignored++; continue; }
      if (st === 'CompileError' || st === 'RuntimeError') { res.invalid++; continue; }
      res.mutants++;
      if (st === 'Killed') res.killed++;
      else if (st === 'Timeout') res.timeout++;
      else if (st === 'Survived') res.survived++;
      else if (st === 'NoCoverage') res.no_coverage++;
      if (STRYKER_UNDETECTED.has(st)) res.survivors.push({ file: rel, line: m.location && m.location.start ? m.location.start.line : null, mutator: m.mutatorName || null, replacement: m.replacement ?? null, status: st });
    }
  }
  const detected = res.killed + res.timeout;
  const valid = detected + res.survived + res.no_coverage;
  res.score = valid ? Math.round((detected / valid) * 1000) / 10 : null;
  return res;
}

/** cargo-mutants `mutants.out/` text lists (caught/missed/timeout/unviable) → counts and survivors. */
export function parseCargoMutants({ caught = '', missed = '', timeout = '', unviable = '' } = {}) {
  const lines = (t) => String(t || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const res = { mutants: 0, killed: lines(caught).length + lines(timeout).length, survived: lines(missed).length, timeout: lines(timeout).length, no_coverage: 0, invalid: lines(unviable).length, ignored: 0, survivors: [] };
  for (const l of lines(missed)) {
    const m = /^(.+?\.rs):(\d+)(?::\d+)?:\s*(.+)$/.exec(l);
    res.survivors.push(m ? { file: toPosix(m[1]), line: Number(m[2]), mutator: null, replacement: m[3], status: 'Survived' } : { file: null, line: null, mutator: null, replacement: l, status: 'Survived' });
  }
  res.mutants = res.killed + res.survived;
  res.score = res.mutants ? Math.round((res.killed / res.mutants) * 1000) / 10 : null;
  return res;
}

/** mutmut 2/3 output: `mutmut results` lines (`name: survived`) or the run progress line with emoji counters. */
export function parseMutmutOutput(text, { onlyModules = null } = {}) {
  const t = String(text || '');
  const res = { mutants: 0, killed: 0, survived: 0, timeout: 0, no_coverage: 0, invalid: 0, ignored: 0, survivors: [] };
  const results = [...t.matchAll(/^\s*([\w.]+__mutmut_\d+|[\w./]+:\d+[^:]*): (killed|survived|no tests|timeout|suspicious|skipped|segfault|caught by type check|not checked)\s*$/gm)];
  if (results.length) {
    for (const [, name, st] of results) {
      if (onlyModules && !onlyModules.some((m) => name.startsWith(m + '.') || name.startsWith(m + '__'))) continue;
      if (st === 'skipped' || st === 'not checked') { res.ignored++; continue; }
      if (st === 'segfault') { res.invalid++; continue; }
      res.mutants++;
      if (st === 'killed' || st === 'caught by type check') res.killed++;
      else if (st === 'timeout' || st === 'suspicious') { res.killed++; res.timeout++; }
      else if (st === 'survived') { res.survived++; res.survivors.push({ file: null, line: null, mutator: name, replacement: null, status: 'Survived' }); }
      else if (st === 'no tests') { res.no_coverage++; res.survivors.push({ file: null, line: null, mutator: name, replacement: null, status: 'NoCoverage' }); }
    }
  } else {
    const prog = [...t.matchAll(/(\d+)\/(\d+)\s+🎉\s*(\d+)\s+(?:🫥\s*(\d+)\s+)?⏰\s*(\d+)\s+🤔\s*(\d+)\s+🙁\s*(\d+)\s+🔇\s*(\d+)/gu)].pop();
    if (!prog) return null;
    const killed = Number(prog[3]); const noTests = Number(prog[4] || 0); const to = Number(prog[5]); const susp = Number(prog[6]); const surv = Number(prog[7]); const skip = Number(prog[8]);
    Object.assign(res, { killed: killed + to + susp, timeout: to, survived: surv, no_coverage: noTests, ignored: skip });
    res.mutants = res.killed + surv + noTests;
  }
  const valid = res.killed + res.survived + res.no_coverage;
  res.score = valid ? Math.round((res.killed / valid) * 1000) / 10 : null;
  return res;
}

// ---------------------------------------------------------------------------
// mutation-scope

function mutationToolFor(project, pdir, languages) {
  const pkg = readJson(path.join(pdir, 'package.json'), null);
  const deps = pkg ? { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) } : {};
  if (deps['@stryker-mutator/core']) return 'stryker';
  if (languages.includes('rust') || fs.existsSync(path.join(pdir, 'Cargo.toml'))) return which('cargo-mutants') ? 'cargo-mutants' : null;
  if (languages.includes('csharp') || fs.readdirSync(pdir).some((f) => /\.(?:sln|slnx|csproj)$/.test(f))) return which('dotnet-stryker') ? 'stryker-net' : null;
  if (languages.includes('python') || fs.existsSync(path.join(pdir, 'pyproject.toml')) || fs.existsSync(path.join(pdir, 'setup.cfg'))) {
    if (IS_WINDOWS) return 'mutmut-windows';
    return which('mutmut') || /mutmut/.test(textOfDeps(pdir)) ? 'mutmut' : null;
  }
  return null;
}

const PY_MODULE = (f) => toPosix(f).replace(/\.py$/, '').replace(/\/__init__$/, '').replace(/^src\//, '').replace(/\//g, '.');

/**
 * Mutation testing restricted to changed source files (§9.1 step 13, `--deep`). Returns
 * `{ tool, mutants, killed, survived, score, survivors[], ..., checks }`; soft (report-only).
 */
export async function mutationScope({ target, detectResult = null, budgetMin = DEFAULT_BUDGET_MIN, noInstall = false, keep = false, dryRun = false } = {}) {
  const root = target.root;
  const tree = target.snapshot.tree;
  await loadMarkers();
  const det = detectResult || await loadDetect(root, target.state);
  const changed = await changedSourceLines(target, det);
  const budget = Number(budgetMin) > 0 ? Number(budgetMin) : DEFAULT_BUDGET_MIN;
  const out = { tool: null, mutants: 0, killed: 0, survived: 0, score: null, survivors: [], budget_min: budget, projects: [], checks: [] };
  const finish = (status, reason, summary, extra = {}) => {
    out.status = status;
    out.checks.push(makeCheck({
      id: 'CK-MUTATION', fm: FM_MUTATION, project: extra.project || '.', status, reason, summary, command: extra.command || null, cwd: null,
      exit_code: extra.exit_code ?? null, duration_ms: extra.duration_ms || 0, output_sha256: extra.output_sha256 || null, artifacts: extra.artifacts || [],
      findings: out.survivors.slice(0, 100).map((s) => ({ id: 'CK-MUTATION', severity: 'info', file: s.file, line: s.line, message: `surviving mutant${s.mutator ? ` (${s.mutator})` : ''}${s.replacement != null ? `: ${truncate(String(s.replacement), 120)}` : ''}`, evidence: s.status })),
      data: { tool: out.tool, mutants: out.mutants, killed: out.killed, survived: out.survived, score: out.score, budget_min: budget, soft: true, projects: out.projects },
    }));
    if (!keep) releaseWorktrees({ root });
    return out;
  };
  if (!changed.length) return finish('skipped', 'NO_CHANGED_CODE', 'no changed source files to mutate');
  const projects = det.projects || [];
  const owners = [...new Set(changed.map((c) => projectOf(c.file, projects)).filter(Boolean))];
  if (!owners.length) return finish('skipped', 'NO_RUNNER', 'no detected project owns the changed source files');
  const totals = { mutants: 0, killed: 0, survived: 0, timeout: 0, no_coverage: 0 };
  const tools = [];
  const extra = { artifacts: [], duration_ms: 0 };
  const deadline = Date.now() + budget * 60_000;
  const outRoot = path.join(tmpRoot(root), `mut-${tree.slice(0, 12)}-${nonce().slice(0, 6)}`);
  let partial = false;
  for (const project of owners) {
    const prel = toPosix(project.root || '.');
    const slug = projectSlug(prel);
    const files = changed.filter((c) => projectOf(c.file, projects) === project).map((c) => (prel === '.' ? c.file : c.file.slice(prel.length + 1)));
    const pdirRepo = path.join(root, project.root || '.');
    const tool = mutationToolFor(project, pdirRepo, project.languages || []);
    if (!tool) { out.projects.push({ root: prel, status: 'skipped', reason: 'NO_MUTATION_TOOL' }); continue; }
    if (tool === 'mutmut-windows') { out.projects.push({ root: prel, tool: 'mutmut', status: 'skipped', reason: 'POSIX_ONLY' }); continue; }
    if (dryRun) { out.projects.push({ root: prel, tool, status: 'skipped', reason: 'DRY_RUN', files }); continue; }
    const remaining = deadline - Date.now();
    if (remaining <= 0) { partial = true; out.projects.push({ root: prel, tool, status: 'skipped', reason: 'BUDGET_EXCEEDED' }); continue; }
    // Mutation tools edit sources: a dedicated worktree, never the clean-run one.
    const wt = acquireWorktree(root, target.snapshot.commit, 'mutation', { keep });
    const pdir = projectDirIn(wt, project);
    const odir = ensureDir(path.join(outRoot, slug));
    const logFile = path.join(odir, 'mutation.log');
    fs.writeFileSync(logFile, '');
    const install = await installProject(wt, project, { noInstall, timeoutMs: remaining, logFile });
    if (install.cmd && install.exit !== 0) { out.projects.push({ root: prel, tool, status: 'unverified', reason: 'INSTALL_FAILED' }); continue; }
    let cmd;
    if (tool === 'stryker') cmd = `npx stryker run --mutate ${quoteArg(files.join(','))} --reporters json,clear-text --incremental --incrementalFile ${quoteArg(path.join(target.state.paths.cache, `stryker-incremental-${slug}.json`))}`;
    else if (tool === 'stryker-net') cmd = `dotnet stryker --since:${target.base.sha || 'HEAD'} --reporter json --output ${quoteArg(path.join(odir, 'stryker-net'))}`;
    else if (tool === 'cargo-mutants') {
      const diffFile = path.join(odir, 'snapshot.diff');
      writeFileAtomic(diffFile, git(root, ['diff', '--no-color', '--no-ext-diff', target.base.sha || emptyTree(root), target.snapshot.commit, '--', prel === '.' ? '.' : prel]) + '\n');
      cmd = `cargo mutants --in-diff ${quoteArg(diffFile)} --output ${quoteArg(odir)} --no-shuffle`;
    } else cmd = `mutmut run --paths-to-mutate ${quoteArg(files.join(','))}`;
    fs.appendFileSync(logFile, `$ ${cmd}\n`);
    log(`mutation: ${cmd} (in ${toPosix(pdir)}, budget ${Math.round(remaining / 60000)} min)`);
    let res = await runStep(cmd, { cwd: pdir, env: runEnv().env, timeoutMs: remaining, logFile });
    if (tool === 'mutmut' && /no such option: --paths-to-mutate|unrecognized arguments/.test(res.stdout + res.stderr)) {
      // mutmut 3 reads paths_to_mutate from its config only.
      cmd = 'mutmut run';
      fs.appendFileSync(logFile, `$ ${cmd}\n`);
      res = await runStep(cmd, { cwd: pdir, env: runEnv().env, timeoutMs: Math.max(1000, deadline - Date.now()), logFile });
    }
    extra.duration_ms += res.ms;
    extra.command = extra.command || cmd;
    extra.exit_code = extra.exit_code ?? res.exit;
    let parsed = null;
    if (tool === 'stryker') {
      const j = readJson(path.join(pdir, 'reports', 'mutation', 'mutation.json'), null);
      if (j) parsed = parseStrykerReport(j, { root: pdir, onlyFiles: files });
    } else if (tool === 'stryker-net') {
      const f = findFile(path.join(odir, 'stryker-net'), 'mutation-report.json');
      if (f) parsed = parseStrykerReport(readJson(f, null), { root: pdir, onlyFiles: files });
    } else if (tool === 'cargo-mutants') {
      const mo = path.join(odir, 'mutants.out');
      if (fs.existsSync(mo)) parsed = parseCargoMutants({ caught: readText(path.join(mo, 'caught.txt'), ''), missed: readText(path.join(mo, 'missed.txt'), ''), timeout: readText(path.join(mo, 'timeout.txt'), ''), unviable: readText(path.join(mo, 'unviable.txt'), '') });
    } else {
      const results = await runStep('mutmut results', { cwd: pdir, env: runEnv().env, timeoutMs: 120_000, logFile });
      parsed = parseMutmutOutput(`${results.stdout}\n${res.stdout}`, { onlyModules: files.map(PY_MODULE) });
    }
    const stored = await storeArtifacts(target, tree, slug, { log_path: logFile }, { prefix: 'mutation-' });
    extra.artifacts.push(...stored.artifacts);
    extra.output_sha256 = extra.output_sha256 || stored.output_sha256;
    if (res.timedOut) partial = true;
    if (!parsed) { out.projects.push({ root: prel, tool, status: res.timedOut ? 'skipped' : 'unverified', reason: res.timedOut ? 'BUDGET_EXCEEDED' : 'TOOL_FAILED', exit: res.exit }); continue; }
    for (const k of Object.keys(totals)) totals[k] += parsed[k] || 0;
    for (const s of parsed.survivors) out.survivors.push({ ...s, file: s.file ? (prel === '.' ? s.file : `${prel}/${s.file}`) : s.file });
    tools.push(tool);
    out.projects.push({ root: prel, tool, status: 'measured', mutants: parsed.mutants, killed: parsed.killed, survived: parsed.survived, score: parsed.score, ...(res.timedOut ? { partial: true } : {}) });
  }
  if (!keep) fs.rmSync(outRoot, { recursive: true, force: true });
  if (dryRun) { out.tool = out.projects.map((p) => p.tool).filter(Boolean).join(', ') || null; return finish('skipped', 'DRY_RUN', `dry run: ${out.projects.map((p) => `${p.root}: ${p.tool || p.reason}`).join('; ')}`); }
  out.tool = [...new Set(tools)].join(', ') || null;
  Object.assign(out, { mutants: totals.mutants, killed: totals.killed, survived: totals.survived + totals.no_coverage, timeout: totals.timeout, no_coverage: totals.no_coverage });
  const detected = totals.killed;
  const valid = totals.killed + totals.survived + totals.no_coverage;
  out.score = valid ? Math.round((detected / valid) * 1000) / 10 : null;
  if (!tools.length) {
    const unverified = out.projects.find((p) => p.status === 'unverified');
    const budgetHit = out.projects.find((p) => p.reason === 'BUDGET_EXCEEDED');
    const reason = unverified ? unverified.reason : budgetHit ? 'BUDGET_EXCEEDED' : out.projects.find((p) => p.reason === 'POSIX_ONLY') ? 'POSIX_ONLY' : 'NO_MUTATION_TOOL';
    const summary = reason === 'NO_MUTATION_TOOL' ? 'no mutation tool for the changed files (StrykerJS, Stryker.NET, cargo-mutants, mutmut); skipped, verdict unaffected'
      : reason === 'POSIX_ONLY' ? 'mutmut needs fork() and does not run on native Windows (use WSL); skipped' : `mutation run did not complete (${reason})`;
    return finish(unverified ? 'unverified' : 'skipped', reason, summary, extra);
  }
  const summary = `${out.tool}: ${out.mutants} mutant(s), ${out.killed} killed, ${out.survived} survived, score ${out.score ?? 'n/a'}%${partial ? ' (partial: budget reached)' : ''} (soft)`;
  return finish('pass', partial ? 'PARTIAL' : null, summary, extra);
}

// ---------------------------------------------------------------------------
// flake-probe

const UNKNOWN_FLAG_RE = /Unrecognized CLI Parameter|unknown option|Unknown option|no such option|unrecognized arguments|flag provided but not defined|Unknown argument|error: unexpected argument/;

/** Changed or new test files of the snapshot, or the `--tests` list (paths, or `path::name`). */
async function testsToProbe(target, det, tests) {
  if (tests && tests.length) {
    return (Array.isArray(tests) ? tests : String(tests).split(',')).flatMap((t) => String(t).split(',')).map((t) => t.trim()).filter(Boolean).map((t) => {
      const i = t.indexOf('::');
      return i === -1 ? { file: toPosix(t), name: null } : { file: toPosix(t.slice(0, i)), name: t.slice(i + 2) };
    });
  }
  const { isTest } = await classifiers(det);
  const from = target.base.sha || emptyTree(target.root);
  return diffNameStatus(target.root, from, target.snapshot.commit).filter((f) => f.status !== 'D' && isTest(f.path)).map((f) => ({ file: toPosix(f.path), name: null }));
}

/** Aggregate per-test outcomes across runs: suspects have both passing and failing runs, or flaky reports. */
export function aggregateRuns(runs) {
  const byId = new Map();
  for (const r of runs) {
    for (const t of r.tests) {
      if (!byId.has(t.id)) byId.set(t.id, { id: t.id, passed: 0, failed: 0, skipped: 0, flaky: 0, runs: [] });
      const a = byId.get(t.id);
      const st = t.status === 'error' ? 'failed' : t.status;
      if (st in a) a[st]++;
      a.runs.push({ run: r.run, status: t.status });
    }
  }
  const all = [...byId.values()];
  const suspects = all.filter((a) => a.flaky > 0 || (a.passed > 0 && a.failed > 0)).map((a) => ({ id: a.id, passed: a.passed, failed: a.failed, flaky: a.flaky, runs: a.runs.length }));
  const consistent = all.filter((a) => a.failed > 0 && a.passed === 0 && a.flaky === 0).map((a) => a.id);
  return { tests: all.length, suspects, consistent };
}

/**
 * Repeat changed/new tests `times` times with shuffling and recorded seeds where the runner supports
 * it (§10.4); otherwise sequential runs with `shuffle: false`. Returns
 * `{ runs, shuffle, seeds[], failures[], suspect_tests[], consistent_failures[], checks }`.
 */
export async function flakeProbe({ target, detectResult = null, times = DEFAULT_TIMES, tests = null, runner = null, noInstall = false, keep = false, timeoutS = DEFAULT_TIMEOUT_S, dryRun = false } = {}) {
  const root = target.root;
  const tree = target.snapshot.tree;
  await loadMarkers();
  const det = detectResult || await loadDetect(root, target.state);
  const n = Math.max(1, Math.min(1000, Number.parseInt(times, 10) || DEFAULT_TIMES));
  const specs = await testsToProbe(target, det, tests);
  const out = { runs: 0, shuffle: false, seeds: [], failures: [], suspect_tests: [], consistent_failures: [], tests_probed: specs.map((s) => s.file + (s.name ? `::${s.name}` : '')), projects: [], checks: [] };
  const finish = (status, reason, summary, extra = {}) => {
    out.status = status;
    out.checks.push(makeCheck({
      id: 'CK-FLAKE', fm: FM_FLAKE, project: extra.project || '.', status, reason, summary, command: extra.command || null, cwd: null, exit_code: extra.exit_code ?? null,
      duration_ms: extra.duration_ms || 0, output_sha256: extra.output_sha256 || null, artifacts: extra.artifacts || [],
      findings: out.suspect_tests.slice(0, 100).map((s) => ({ id: 'CK-FLAKE', severity: 'finding', file: s.file || null, line: null, message: `flaky: ${s.id} (${s.passed} passed, ${s.failed} failed, ${s.flaky} flaky of ${s.runs} runs)`, evidence: '' })),
      data: { runs: out.runs, shuffle: out.shuffle, seeds: out.seeds, suspect_tests: out.suspect_tests.length, consistent_failures: out.consistent_failures, tests_probed: out.tests_probed, projects: out.projects },
    }));
    if (!keep) releaseWorktrees({ root });
    return out;
  };
  if (!specs.length) return finish('skipped', 'NO_CHANGED_TESTS', 'no new or changed test files to probe (pass --tests <files>)');
  const projects = det.projects || [];
  const groups = new Map();
  for (const s of specs) {
    const p = projectOf(s.file, projects) || (runner ? { root: '.', managers: [], runners: [] } : null);
    if (!p) continue;
    if (!groups.has(p)) groups.set(p, []);
    groups.get(p).push(s);
  }
  if (!groups.size) return finish('unverified', 'NO_RUNNER', 'no detected project owns the test files; pass --runner');
  const extra = { artifacts: [], duration_ms: 0 };
  const outRoot = path.join(tmpRoot(root), `flake-${tree.slice(0, 12)}-${nonce().slice(0, 6)}`);
  const allRuns = [];
  let unverified = null;
  for (const [project, group] of groups) {
    const prel = toPosix(project.root || '.');
    const slug = projectSlug(prel);
    const r = resolveRunner(project, runner);
    if (!r) { out.projects.push({ root: prel, status: 'unverified', reason: 'NO_RUNNER' }); unverified = unverified || 'NO_RUNNER'; continue; }
    const rel = (f) => (prel === '.' ? f : f.slice(prel.length + 1));
    const select = { files: group.map((s) => rel(s.file)), names: group.map((s) => s.name).filter(Boolean) };
    const pdirRepo = path.join(root, project.root || '.');
    let shuffle = typeof r.shuffle === 'function' && requirementMet(pdirRepo, r.shuffleRequires);
    const prow = { root: prel, runner: r.name, runs: 0, shuffle, retries_disabled: (r.retries_off || {}).coverage || 'unknown', status: 'pending' };
    out.projects.push(prow);
    if (dryRun) { prow.status = 'skipped'; prow.reason = 'DRY_RUN'; continue; }
    const wt = acquireWorktree(root, target.snapshot.commit, 'head', { keep });
    const goModule = goModuleFor(projectDirIn(wt, project), '.');
    for (let i = 1; i <= n; i++) {
      const seed = shuffle ? randomInt(1, 2 ** 31 - 1) : null;
      let rec = await runProject(wt, project, r, { outDir: path.join(outRoot, slug, `run-${i}`), noInstall, timeoutMs: timeoutS * 1000, select, seed, logName: 'run.log' });
      if (i === 1 && shuffle && !rec.counts && UNKNOWN_FLAG_RE.test(`${rec.stdoutTail}\n${rec.stderrTail}`)) {
        // The runner is too old for its shuffle flags: fall back to sequential runs.
        shuffle = false;
        prow.shuffle = false;
        prow.shuffle_note = 'shuffle flags rejected by the runner; sequential runs';
        rec = await runProject(wt, project, r, { outDir: path.join(outRoot, slug, 'run-1b'), noInstall, timeoutMs: timeoutS * 1000, select, logName: 'run.log' });
      }
      const stored = await storeArtifacts(target, tree, slug, rec, { prefix: `flake-${i}-` });
      extra.artifacts.push(...stored.artifacts);
      extra.output_sha256 = extra.output_sha256 || stored.output_sha256;
      extra.duration_ms += rec.ms || 0;
      extra.command = extra.command || rec.cmd;
      extra.exit_code = extra.exit_code ?? rec.exit;
      if (!rec.counts) {
        prow.status = 'unverified';
        prow.reason = rec.status === 'unverified' ? rec.reason : rec.timedOut ? 'TIMEOUT' : 'NO_REPORT';
        unverified = unverified || prow.reason;
        break;
      }
      const scoped = Boolean(rec.applied && rec.applied.select);
      let mine = rec.tests.filter((t) => group.some((s) => testMatchesFile(t, s.file, { goModule: goModule && goModule.module, projectRoot: prel }) && (!s.name || String(t.id).includes(s.name))));
      if (!mine.length && scoped) mine = rec.tests;
      const seeds = seed != null ? [String(seed)] : (rec.seeds || []).map(String);
      for (const sd of seeds) out.seeds.push(sd);
      allRuns.push({ run: allRuns.length + 1, project: prel, seed: seeds[0] || null, tests: mine.map((t) => ({ ...t, file: t.file ? (prel === '.' ? t.file : `${prel}/${t.file}`) : null })) });
      for (const t of mine.filter((x) => x.status === 'failed' || x.status === 'error' || x.status === 'flaky')) {
        if (out.failures.length < 200) out.failures.push({ run: allRuns.length, project: prel, seed: seeds[0] || null, id: t.id, status: t.status, failure_kind: t.failure_kind || null, message: t.message || null });
      }
      prow.runs++;
    }
    if (prow.status === 'pending') prow.status = 'probed';
    if (shuffle) out.shuffle = true;
  }
  if (!keep) fs.rmSync(outRoot, { recursive: true, force: true });
  out.runs = allRuns.length;
  if (dryRun) return finish('skipped', 'DRY_RUN', `dry run: would run ${out.tests_probed.join(', ')} ${n} time(s)`);
  const agg = aggregateRuns(allRuns);
  const fileOf = new Map(allRuns.flatMap((r) => r.tests.map((t) => [t.id, t.file])));
  out.suspect_tests = agg.suspects.map((s) => ({ ...s, file: fileOf.get(s.id) || null }));
  out.consistent_failures = agg.consistent;
  out.tests_seen = agg.tests;
  const retriesNote = out.projects.filter((p) => p.retries_disabled !== 'full').map((p) => `${p.root}: retries_disabled ${p.retries_disabled}`).join('; ');
  if (!out.runs) return finish('unverified', unverified || 'NO_REPORT', 'no probe run produced parseable results', extra);
  if (!agg.tests) return finish('unverified', 'NO_TESTS_EXECUTED', 'the probe runs executed none of the selected tests', extra);
  const base = `${out.runs} run(s) of ${agg.tests} test(s), shuffle ${out.shuffle ? 'on' : 'off'}${out.seeds.length ? ` (seeds ${out.seeds.slice(0, 5).join(', ')}${out.seeds.length > 5 ? ', ...' : ''})` : ''}`;
  const notes = [retriesNote, out.consistent_failures.length ? `${out.consistent_failures.length} test(s) failed in every run (not flaky; see CK-CLEANRUN)` : '', unverified ? `incomplete: ${unverified}` : ''].filter(Boolean).join('; ');
  if (out.suspect_tests.length) return finish('finding', 'FLAKY', `${out.suspect_tests.length} flaky test(s): ${out.suspect_tests.slice(0, 3).map((s) => s.id).join(', ')} - ${base}${notes ? `; ${notes}` : ''}`, extra);
  return finish(unverified ? 'unverified' : 'pass', unverified || null, `no flaky test in ${base}${notes ? `; ${notes}` : ''}`, extra);
}

// ---------------------------------------------------------------------------
// Commands

const COMMON = { base: { type: 'string' }, runner: { type: 'string' }, 'no-install': { type: 'boolean' }, keep: { type: 'boolean' }, timeout: { type: 'string' }, refresh: { type: 'boolean' } };

async function setup(ctx, values) {
  const target = await prepareTarget(ctx, { base: values.base || null, createState: !ctx.dryRun });
  target.cwd = ctx.cwd;
  const detectResult = await loadDetect(target.root, ctx.dryRun ? null : target.state, { refresh: Boolean(values.refresh) });
  return { target, detectResult };
}

const timeoutOf = (values) => (values.timeout ? Math.max(1, Number(values.timeout) || DEFAULT_TIMEOUT_S) : DEFAULT_TIMEOUT_S);

export const coverageDeltaCommand = defineCommand({
  name: 'coverage-delta',
  usage: [
    'coverage-delta [--base <ref>] [--fail-under <pct>] [--report <coverage file>[,<file>]] [--runner <name>] [--no-install] [--keep] [--json]',
    'Changed-line coverage of the snapshot (CK-COVERAGE). Without --report the suite runs with coverage in a temp worktree.',
    'Report-only unless --fail-under is given. Formats: LCOV, Cobertura XML, Istanbul JSON, Go cover profiles.',
  ].join('\n'),
  options: { ...COMMON, 'fail-under': { type: 'string' }, report: { type: 'string' } },
  async run(ctx, values) {
    const { target, detectResult } = await setup(ctx, values);
    const res = await coverageDelta({ target, detectResult, failUnder: values['fail-under'] ?? null, report: values.report || null, runner: values.runner || null, noInstall: Boolean(values['no-install']), keep: Boolean(values.keep), timeoutS: timeoutOf(values), dryRun: ctx.dryRun });
    return { result: res, exit: exitFor(res.status === 'skipped' ? 'pass' : res.status), summary: `${res.status.toUpperCase()} - ${res.checks[0].summary}` };
  },
});

export const mutationScopeCommand = defineCommand({
  name: 'mutation-scope',
  usage: [
    'mutation-scope [--base <ref>] [--budget <minutes>] [--no-install] [--keep] [--json]',
    'Mutation testing restricted to changed source files (CK-MUTATION, soft): StrykerJS --mutate, Stryker.NET --since,',
    'cargo mutants --in-diff, mutmut (POSIX only). Skipped when no tool is installed.',
  ].join('\n'),
  options: { base: COMMON.base, budget: { type: 'string' }, 'no-install': COMMON['no-install'], keep: COMMON.keep, refresh: COMMON.refresh },
  async run(ctx, values) {
    const { target, detectResult } = await setup(ctx, values);
    const res = await mutationScope({ target, detectResult, budgetMin: values.budget ? Number(values.budget) : DEFAULT_BUDGET_MIN, noInstall: Boolean(values['no-install']), keep: Boolean(values.keep), dryRun: ctx.dryRun });
    return { result: res, exit: exitFor(res.status === 'skipped' ? 'pass' : res.status), summary: `${res.status.toUpperCase()} - ${res.checks[0].summary}` };
  },
});

export const flakeProbeCommand = defineCommand({
  name: 'flake-probe',
  usage: [
    'flake-probe [--base <ref>] [--times <n>] [--tests <file[::name]>,...] [--runner <name>] [--no-install] [--keep] [--json]',
    'Repeats new/changed tests n times (default 5) with shuffling and recorded seeds where the runner supports it (CK-FLAKE).',
  ].join('\n'),
  options: { ...COMMON, times: { type: 'string' }, tests: { type: 'string', multiple: true } },
  async run(ctx, values) {
    const { target, detectResult } = await setup(ctx, values);
    const res = await flakeProbe({ target, detectResult, times: values.times ? Number(values.times) : DEFAULT_TIMES, tests: values.tests ? values.tests.flatMap((t) => t.split(',')) : null, runner: values.runner || null, noInstall: Boolean(values['no-install']), keep: Boolean(values.keep), timeoutS: timeoutOf(values), dryRun: ctx.dryRun });
    return { result: res, exit: exitFor(res.status === 'skipped' ? 'pass' : res.status), summary: `${res.status.toUpperCase()} - ${res.checks[0].summary}` };
  },
});

