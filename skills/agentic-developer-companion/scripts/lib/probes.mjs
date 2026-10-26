// Soft QA probes on the working-tree snapshot (§7.2, §9.1 steps 12-14, §10.4): changed-line
// coverage (CK-COVERAGE), mutation testing restricted to changed files (CK-MUTATION) and repeated,
// shuffled runs of changed tests (CK-FLAKE). Built on the clean-run worktree and runner plumbing.

import { randomInt } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  defineCommand, usageError, readJson, readText, writeFileAtomic, ensureDir, nonce, toPosix, relPosix, quoteArg,
  tmpRoot, which, IS_WINDOWS, truncate, log, numberOption, listFiles, toArray, uniq, isAbsolutePath,
} from './core.mjs';
import { diffLines, emptyTree, diffNameStatus, git } from './git.mjs';
import { parseCoverage, detectCoverageFormat, isTestPath, rootVariants, normalizeReportPath } from './reports.mjs';
import { detect } from './detect.mjs';
import * as M from './markers.mjs';
import {
  resolveRunner, acquireWorktree, releaseWorktrees, runProject, storeArtifacts, makeCheck, projectSlug, exitFor,
  testMatchesFile, runStep, runEnv, installProject, artifactPath, repoRelativeEntries, parseRedGreenSpec, redact,
  redactAll, commandSetup, COMMON_OPTIONS, DEFAULT_TIMEOUT_S, fileEcosystem, goModuleOf, projectDir,
} from './clean-run.mjs';

const DEFAULT_TIMES = 5;
const DEFAULT_BUDGET_MIN = 20;
const ROOT_PROJECT = Object.freeze({ root: '.', managers: [], runners: [] });

// ---------------------------------------------------------------------------
// Shared

const isTest = (f, det) => M.isTestFile(f, det) || isTestPath(f);
const subPath = (prel, f) => (prel === '.' ? f : f.slice(prel.length + 1));
const repoPath = (prel, f) => (f && prel !== '.' ? `${prel}/${f}` : f);
const score = (detected, valid) => (valid ? Math.round((detected / valid) * 1000) / 10 : null);
const diffOf = (target, ...paths) => git(target.root, ['diff', '--no-color', '--no-ext-diff',
  target.base.sha || emptyTree(target.root), target.snapshot.commit, ...(paths.length ? ['--', ...paths] : [])]) + '\n';

/** Added lines per changed source file (not tests, not generated): `[{ file, lines: [n...] }]`. */
function changedSourceLines(target, det) {
  const source = (f) => f.status !== 'D' && !f.binary && f.path && M.isCodeFile(f.path) && !isTest(f.path, det)
    && !M.classifyPath(f.path).generated;
  return diffLines(target.root, target.base.sha || emptyTree(target.root), target.snapshot.commit).filter(source)
    .map((f) => ({ file: toPosix(f.path), lines: f.added.filter((a) => a.text.trim() !== '').map((a) => a.line) }))
    .filter((f) => f.lines.length);
}

/**
 * Items grouped by owning project and the runner for their language (one runner per ecosystem):
 * `[{ project, prel, runner, items }]`; the runner is null when the project has none.
 */
function groupByRunner(items, det, runnerOpt, fallbackProject = null) {
  const groups = new Map();
  for (const it of items) {
    const project = M.projectForFile(it.file, det) || fallbackProject;
    if (!project) continue;
    const runner = resolveRunner(project, runnerOpt, { ecosystem: fileEcosystem(it.file) });
    const key = `${project.root || '.'}\0${runner ? runner.name : ''}`;
    if (!groups.has(key)) groups.set(key, { project, prel: toPosix(project.root || '.'), runner, items: [] });
    groups.get(key).items.push(it);
  }
  return [...groups.values()];
}

/** The slug for a group: the project's, plus the runner when the project has several groups. */
const groupSlug = (groups, g) => projectSlug(g.prel)
  + (groups.filter((x) => x.prel === g.prel).length > 1 ? `-${g.runner.name}` : '');

const MANIFESTS = ['package.json', 'pyproject.toml', 'requirements.txt', 'requirements-dev.txt', 'dev-requirements.txt',
  'setup.cfg', 'uv.lock', 'poetry.lock', 'Pipfile', 'Pipfile.lock', 'tox.ini'];

/** Do the project's manifests or lockfiles mention one of `names` (e.g. pytest-cov)? */
function dependsOn(dir, names) {
  if (!names || !names.length) return true;
  const text = MANIFESTS.map((f) => readText(path.join(dir, f), '') || '').join('\n');
  return names.some((n) => text.includes(n));
}

function ranges(lines) {
  const out = [];
  for (const n of [...lines].sort((a, b) => a - b)) {
    const last = out[out.length - 1];
    if (last && n === last[1] + 1) last[1] = n;
    else out.push([n, n]);
  }
  return out.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`));
}

/** Accumulates the command, exit, timing and artifacts of a probe's runs for its check. */
function tally() {
  const acc = { artifacts: [], duration_ms: 0, command: null, exit_code: null, output_sha256: null };
  acc.add = (stored, cmd, exit, ms) => {
    acc.artifacts.push(...stored.artifacts);
    acc.output_sha256 ??= stored.output_sha256;
    acc.command ??= cmd;
    acc.exit_code ??= exit;
    acc.duration_ms += ms || 0;
  };
  return acc;
}

/** Append the probe's single check to `out` (findings and data computed now) and release worktrees. */
function finishProbe(out, { id, fm, root, keep, findings, data }, status, reason, summary, acc = tally()) {
  out.status = status;
  out.checks.push(makeCheck({ id, fm, status, reason, summary, command: acc.command, exit_code: acc.exit_code,
    duration_ms: acc.duration_ms, output_sha256: acc.output_sha256, artifacts: acc.artifacts,
    findings: findings(status), data: data() }));
  if (!keep) releaseWorktrees({ root });
  return out;
}

const goModule = (dir, rel) => {
  const m = goModuleOf(dir);
  return m ? { module: m, dir: rel } : null;
};

// ---------------------------------------------------------------------------
// coverage-delta

/** Changed-line coverage from parsed coverage files (`{ files }` keyed by repo path) and changed lines. */
export function computeChangedCoverage(changed, coverageFiles) {
  const out = { changed_lines: 0, covered: 0, pct: null, uncovered: [], files_not_in_report: [], untested_branches: [],
    precision: 'line', files: [] };
  for (const { file, lines } of changed) {
    const data = coverageFiles[file];
    const hasLines = Boolean(data && data.lines && Object.keys(data.lines).length);
    if (data && !hasLines && data.summary && Number.isFinite(data.summary.pct)) {
      // File-level data only: approximate the changed lines by the file's line rate.
      const covered = Math.round((lines.length * data.summary.pct) / 100);
      Object.assign(out, { precision: 'file', changed_lines: out.changed_lines + lines.length,
        covered: out.covered + covered });
      out.files.push({ file, changed: lines.length, covered, approximate: true });
      continue;
    }
    if (!hasLines) {
      out.files_not_in_report.push(file);
      continue;
    }
    const executable = lines.filter((n) => String(n) in data.lines);
    const miss = executable.filter((n) => !(data.lines[n] > 0));
    for (const n of executable) {
      const br = data.branches && data.branches[n];
      if (br && br[1] > br[0]) out.untested_branches.push({ file, line: n, covered: br[0], total: br[1] });
    }
    out.changed_lines += executable.length;
    out.covered += executable.length - miss.length;
    out.files.push({ file, changed: executable.length, covered: executable.length - miss.length });
    if (miss.length) out.uncovered.push({ file, lines: miss, ranges: ranges(miss) });
  }
  out.pct = out.changed_lines ? Math.round((out.covered / out.changed_lines) * 1000) / 10 : null;
  return out;
}

/**
 * Repo path for a path from a coverage run in a worktree: parsed paths are project-relative, and
 * an absolute one (another package of the worktree) is made relative to `wtRoots` (rootVariants).
 */
function runCoveragePath(p, prel, wtRoots) {
  const s = toPosix(p);
  return isAbsolutePath(s) ? normalizeReportPath(s, { roots: wtRoots }) : repoPath(prel, s);
}

/**
 * Repo path for a path from a provided coverage report: as is, relative to the project holding
 * the report (`packages/a/coverage/lcov.info` lists `src/x.ts`), or, for an absolute path from
 * another checkout (a CI runner), the longest changed file it ends with.
 */
function providedCoveragePath(p, changed, prel) {
  if (changed.has(p)) return p;
  if (prel && changed.has(`${prel}/${p}`)) return `${prel}/${p}`;
  if (!isAbsolutePath(p)) return p;
  return [...changed].filter((f) => p.endsWith(`/${f}`)).sort((a, b) => b.length - a.length)[0] || p;
}

/** Cross-check with diff-cover when it is installed (plan §7.2: "or diff-cover if present"). */
async function diffCover(target, wtDir, reportFile, format, outDir) {
  if (!which('diff-cover') || !['lcov', 'cobertura'].includes(format)) return null;
  const diffFile = path.join(outDir, 'snapshot.diff');
  writeFileAtomic(diffFile, diffOf(target));
  const jsonOut = path.join(outDir, 'diff-cover.json');
  const cmd = `diff-cover ${quoteArg(reportFile)} --diff-file ${quoteArg(diffFile)} `
    + `--format ${quoteArg(`json:${jsonOut}`)}`;
  const res = await runStep(cmd, { cwd: wtDir, env: runEnv().env, timeoutMs: 300_000 });
  const j = readJson(jsonOut, null);
  if (!j) return { exit: res.exit, error: 'no JSON report' };
  return { exit: res.exit, pct: j.total_percent_covered ?? null, lines: j.total_num_lines ?? null,
    violations: j.total_num_violations ?? null };
}

/** `--fail-under` as a number in [0, 100], or null; anything else is a usage error. */
function failUnderOf(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!(n >= 0 && n <= 100)) throw usageError('--fail-under must be a number between 0 and 100');
  return n;
}

/** Coverage files given with `--report`, parsed and mapped onto repo paths. */
function providedCoverage(target, det, report, changedSet) {
  const root = target.root;
  const files = {};
  const formats = [];
  for (const f of toArray(report).flatMap((x) => String(x).split(',')).map((x) => x.trim()).filter(Boolean)) {
    const abs = path.resolve(target.cwd || root, f);
    const text = readText(abs, null);
    if (text == null) throw usageError(`--report: cannot read ${toPosix(abs)}`);
    const fmt = detectCoverageFormat(text);
    if (!fmt) {
      throw usageError(`--report: unknown coverage format in ${toPosix(abs)} (expected LCOV, Cobertura XML, `
        + 'Istanbul JSON or a Go cover profile)');
    }
    const rel = relPosix(root, abs);
    const owner = rel && rel !== '.' ? M.projectForFile(rel, det) : null;
    const prel = owner && owner.root && owner.root !== '.' ? toPosix(owner.root) : null;
    let parsed;
    try {
      parsed = parseCoverage(fmt, text, { root: [root, ...(prel ? [path.join(root, prel)] : [])],
        goModule: (prel && goModule(path.join(root, prel), prel)) || goModule(root, '.') });
    } catch (err) {
      throw usageError(`--report: ${toPosix(abs)} could not be parsed as ${fmt} (${truncate(err.message, 120)})`);
    }
    for (const [p, d] of Object.entries(parsed.files)) files[providedCoveragePath(toPosix(p), changedSet, prel)] = d;
    formats.push(fmt);
  }
  return { files, tool: `provided (${uniq(formats).join(', ')})` };
}

/** The coverage file a run produced: the expected path, else (Coverlet) a search of the coverage dir. */
const producedCoverage = (rec, cv) => (rec.coverageFile && fs.existsSync(rec.coverageFile) ? rec.coverageFile
  : cv.search ? listFiles(rec.coverageDir, { maxDepth: 6 }).map((f) => path.join(rec.coverageDir, f))
    .find((f) => path.basename(f) === cv.file) : null);

/**
 * Changed-line coverage (§9.1 step 12). With `report`, the given coverage file(s) are mapped onto
 * the snapshot diff; otherwise the suite of each owning project runs with coverage in a snapshot
 * worktree (one runner per ecosystem). Returns `{ tool, changed_lines, covered, pct, uncovered[],
 * precision, ..., checks }`; report-only unless `failUnder` is set.
 */
export async function coverageDelta({
  target, detectResult = null, failUnder = null, report = null, runner = null, noInstall = false, keep = false,
  timeoutS = DEFAULT_TIMEOUT_S, dryRun = false,
} = {}) {
  const root = target.root;
  const tree = target.snapshot.tree;
  const det = detectResult || await detect({ root, stateInfo: dryRun ? null : target.state });
  const threshold = failUnderOf(failUnder);
  const changed = changedSourceLines(target, det);
  const out = { tool: null, source: null, changed_lines: 0, covered: 0, pct: null, uncovered: [],
    files_not_in_report: [], untested_branches: [], precision: 'line', fail_under: threshold, projects: [],
    checks: [] };
  const extraData = {};
  const finish = (...a) => finishProbe(out, {
    id: 'CK-COVERAGE', fm: ['FM-03'], root, keep,
    findings: (status) => out.uncovered.slice(0, 100).map((u) => ({ id: 'CK-COVERAGE',
      severity: threshold != null && status === 'fail' ? 'finding' : 'info', file: u.file, line: u.lines[0],
      message: `changed lines not covered: ${u.ranges.join(', ')}`, evidence: '' })),
    data: () => ({ tool: out.tool, source: out.source, changed_lines: out.changed_lines, covered: out.covered,
      pct: out.pct, precision: out.precision, fail_under: threshold, enforced: threshold != null,
      files_not_in_report: out.files_not_in_report, untested_branches: out.untested_branches.slice(0, 100),
      ...extraData }),
  }, ...a);
  if (!changed.length) {
    return finish('skipped', 'NO_CHANGED_CODE',
      'no changed source lines (tests, docs and generated files are not measured)');
  }
  const changedSet = new Set(changed.map((c) => c.file));
  const acc = tally();
  let coverage = {};
  if (report) {
    const given = providedCoverage(target, det, report, changedSet);
    Object.assign(out, { tool: given.tool, source: 'provided' });
    coverage = given.files;
  } else {
    const groups = groupByRunner(changed, det, runner);
    if (!groups.length) {
      return finish('skipped', 'NO_RUNNER',
        'no detected project owns the changed source files; pass --report <coverage file>');
    }
    const outRoot = path.join(tmpRoot(root), `cov-${tree.slice(0, 12)}-${nonce().slice(0, 6)}`);
    const tools = [];
    const reasons = [];
    for (const g of groups) {
      const { project, prel, runner: r } = g;
      const row = { root: prel, runner: r ? r.name : null };
      const skip = (reason, why) => {
        reasons.push(`${prel}: ${why}`);
        out.projects.push({ ...row, status: 'skipped', reason });
      };
      const cv = r && r.coverage;
      if (!r) {
        reasons.push(`${prel}: no runner`);
        continue;
      }
      if (!cv) {
        skip('NO_COVERAGE_TOOL', `${r.name} has no built-in coverage mode here; pass --report <file>`);
        continue;
      }
      if (dryRun) {
        out.projects.push({ ...row, status: 'skipped', reason: 'DRY_RUN', coverage: cv.flag || cv.cmd });
        continue;
      }
      if (cv.tool && !which(cv.tool)) {
        skip('NO_COVERAGE_TOOL', `${cv.tool} is not installed`);
        continue;
      }
      if (!dependsOn(path.join(root, project.root || '.'), cv.requires)) {
        skip('NO_COVERAGE_TOOL', `${cv.requires.join(' or ')} is not a dependency`);
        continue;
      }
      const slug = groupSlug(groups, g);
      // The cache holds the coverage map already mapped to repo paths (worktree paths do not
      // survive); it is per tree and per command, as a `--runner` line may select other tests.
      const cacheFile = path.join(target.state.paths.cache, 'runs', tree.slice(0, 12), slug, 'coverage-map.json');
      const cached = readJson(cacheFile, null);
      const runnerCmd = redact(r.cmd || '');
      let files = cached && cached.schema === 'adc-coverage-map/1' && cached.runner === r.name
        && cached.runner_cmd === runnerCmd ? cached.files : null;
      let rec = null;
      if (files) acc.artifacts.push(artifactPath(root, cacheFile));
      else {
        const wt = acquireWorktree(root, target.snapshot.commit, 'head', { keep });
        const pdir = projectDir(wt, project);
        rec = await runProject(wt, project, r, { outDir: path.join(outRoot, slug), noInstall,
          timeoutMs: timeoutS * 1000, coverage: true, logName: 'coverage.log' });
        const produced = producedCoverage(rec, cv);
        const stored = storeArtifacts(target, tree, slug, { log_path: rec.log_path, report_path: produced },
          { prefix: 'coverage-' });
        acc.add(stored, rec.cmd, rec.exit, rec.ms);
        const fail = (reason, why) => {
          reasons.push(`${prel}: ${why}`);
          out.projects.push({ ...row, status: 'unverified', reason, cmd: rec.cmd, exit: rec.exit });
        };
        if (!produced) {
          const reason = rec.status === 'unverified' ? rec.reason : rec.runnerMissing ? 'RUNNER_NOT_FOUND'
            : rec.timedOut ? 'TIMEOUT' : 'NO_COVERAGE_REPORT';
          fail(reason, `the coverage run wrote no report (exit ${rec.exit})`);
          continue;
        }
        let parsed;
        try {
          parsed = parseCoverage(cv.format, readText(produced, ''), { root: [pdir], goModule: goModule(pdir, '.') });
        } catch (err) {
          fail('COVERAGE_UNPARSEABLE', `the coverage report could not be parsed (${truncate(err.message, 120)})`);
          continue;
        }
        files = {};
        const wtRoots = rootVariants([wt.dir]);
        for (const [p, d] of Object.entries(parsed.files)) files[runCoveragePath(p, prel, wtRoots)] = d;
        try {
          writeFileAtomic(cacheFile, JSON.stringify({ schema: 'adc-coverage-map/1', runner: r.name,
            runner_cmd: runnerCmd, format: cv.format, tree, files }) + '\n');
        } catch {}
        const dc = await diffCover(target, wt.dir, produced, cv.format, path.join(outRoot, slug));
        if (dc && prel === '.') extraData.diff_cover = dc;
      }
      Object.assign(coverage, files);
      tools.push(`${r.name} (${cv.format})`);
      out.projects.push({ ...row, status: 'measured', source: rec ? 'run' : 'cache', cmd: rec ? rec.cmd : null,
        exit: rec ? rec.exit : null });
    }
    if (!keep) fs.rmSync(outRoot, { recursive: true, force: true });
    if (dryRun) {
      const list = uniq(groups.map((g) => g.prel)).join(', ');
      return finish('skipped', 'DRY_RUN', `dry run: would run the suite with coverage for ${list}`);
    }
    if (!tools.length) {
      const unverified = out.projects.find((p) => p.status === 'unverified');
      return finish(unverified ? 'unverified' : 'skipped', unverified ? unverified.reason : 'NO_COVERAGE_TOOL',
        reasons.join('; ') || 'no coverage could be collected', acc);
    }
    const source = out.projects.some((p) => p.source === 'run') ? 'run' : 'cache';
    Object.assign(out, { tool: tools.join(', '), source });
    if (reasons.length) extraData.not_measured = reasons;
  }
  Object.assign(out, computeChangedCoverage(changed, coverage));
  if (out.pct == null) {
    return finish(threshold != null ? 'fail' : 'skipped', 'NOT_IN_REPORT', `none of the ${changed.length} changed `
      + 'source file(s) appear in the coverage report (never loaded by the tests, or excluded)', acc);
  }
  const notIn = out.files_not_in_report;
  const summary = [`${out.pct}% of ${out.changed_lines} changed executable line(s) covered`,
    out.precision === 'file' ? ' (approximate: file-level data)' : '',
    notIn.length ? `; ${notIn.length} changed file(s) not in the report: ${notIn.slice(0, 5).join(', ')}` : '',
    out.untested_branches.length ? `; ${out.untested_branches.length} partially covered branch line(s)` : ''].join('');
  if (threshold != null && out.pct < threshold) {
    return finish('fail', 'BELOW_THRESHOLD', `${summary}; below --fail-under ${threshold}`, acc);
  }
  return finish('pass', null, `${summary}${threshold == null ? ' (report-only)' : ''}`, acc);
}

// ---------------------------------------------------------------------------
// mutation-scope: report parsers

const emptyMutation = () => ({ mutants: 0, killed: 0, survived: 0, timeout: 0, no_coverage: 0, invalid: 0, ignored: 0,
  survivors: [] });
const STRYKER_STATUS = { Killed: 'killed', Timeout: 'timeout', Survived: 'survived', NoCoverage: 'no_coverage',
  CompileError: 'invalid', RuntimeError: 'invalid', Ignored: 'ignored', Pending: 'ignored' };

/** mutation-testing-report-schema JSON (StrykerJS, Stryker.NET) → counts and survivors. */
export function parseStrykerReport(json, { root = null, onlyFiles = null } = {}) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  const res = emptyMutation();
  const opts = { roots: rootVariants(root) };
  for (const [file, entry] of Object.entries((data && data.files) || {})) {
    const rel = normalizeReportPath(file, opts);
    if (onlyFiles && !onlyFiles.some((f) => f === rel || f.endsWith('/' + rel) || rel.endsWith('/' + f))) continue;
    for (const m of entry.mutants || []) {
      const key = STRYKER_STATUS[m.status];
      if (!key) continue;
      res[key]++;
      if (m.status === 'Survived' || m.status === 'NoCoverage') {
        res.survivors.push({ file: rel, line: m.location && m.location.start ? m.location.start.line : null,
          mutator: m.mutatorName || null, replacement: m.replacement ?? null, status: m.status });
      }
    }
  }
  res.mutants = res.killed + res.timeout + res.survived + res.no_coverage;
  res.score = score(res.killed + res.timeout, res.mutants);
  return res;
}

/** cargo-mutants `mutants.out/` text lists (caught/missed/timeout/unviable) → counts and survivors. */
export function parseCargoMutants({ caught = '', missed = '', timeout = '', unviable = '' } = {}) {
  const lines = (t) => String(t || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const res = { ...emptyMutation(), killed: lines(caught).length + lines(timeout).length,
    survived: lines(missed).length, timeout: lines(timeout).length, invalid: lines(unviable).length };
  for (const l of lines(missed)) {
    const m = /^(.+?\.rs):(\d+)(?::\d+)?:\s*(.+)$/.exec(l);
    res.survivors.push({ file: m ? toPosix(m[1]) : null, line: m ? Number(m[2]) : null, mutator: null,
      replacement: m ? m[3] : l, status: 'Survived' });
  }
  res.mutants = res.killed + res.survived;
  res.score = score(res.killed, res.mutants);
  return res;
}

const MUTMUT_STATUS = { killed: 'killed', 'caught by type check': 'killed', timeout: 'timeout', suspicious: 'timeout',
  survived: 'survived', 'no tests': 'no_coverage', skipped: 'ignored', 'not checked': 'ignored', segfault: 'invalid' };
const MUTMUT_RESULT = new RegExp(String.raw`^\s*([\w.]+__mutmut_\d+|[\w./]+:\d+[^:]*): `
  + `(${Object.keys(MUTMUT_STATUS).join('|')})\\s*$`, 'gm');
const MUTMUT_PROGRESS = /(\d+)\/(\d+)\s+🎉\s*(\d+)\s+(?:🫥\s*(\d+)\s+)?⏰\s*(\d+)\s+🤔\s*(\d+)\s+🙁\s*(\d+)\s+🔇\s*(\d+)/gu;

/** mutmut 2/3 output: `mutmut results` lines (`name: survived`) or the run progress line with emoji counters. */
export function parseMutmutOutput(text, { onlyModules = null } = {}) {
  const t = String(text || '');
  const res = emptyMutation();
  const results = [...t.matchAll(MUTMUT_RESULT)];
  if (results.length) {
    for (const [, name, st] of results) {
      if (onlyModules && !onlyModules.some((m) => name.startsWith(m + '.') || name.startsWith(m + '__'))) continue;
      const key = MUTMUT_STATUS[st];
      res[key]++;
      // A timeout or suspicious mutant made the tests misbehave: it counts as detected.
      if (key === 'timeout') res.killed++;
      if (key === 'survived' || key === 'no_coverage') {
        res.survivors.push({ file: null, line: null, mutator: name, replacement: null,
          status: key === 'survived' ? 'Survived' : 'NoCoverage' });
      }
    }
  } else {
    const prog = [...t.matchAll(MUTMUT_PROGRESS)].pop();
    if (!prog) return null;
    const [killed, noTests, to, susp, surv, skip] = [3, 4, 5, 6, 7, 8].map((i) => Number(prog[i] || 0));
    Object.assign(res, { killed: killed + to + susp, timeout: to, survived: surv, no_coverage: noTests,
      ignored: skip });
  }
  res.mutants = res.killed + res.survived + res.no_coverage;
  res.score = score(res.killed, res.mutants);
  return res;
}

// ---------------------------------------------------------------------------
// mutation-scope

function mutationToolFor(project, dir) {
  const langs = toArray(project.languages);
  const pkg = readJson(path.join(dir, 'package.json'), null) || {};
  if ({ ...pkg.dependencies, ...pkg.devDependencies }['@stryker-mutator/core']) return 'stryker';
  if (langs.includes('rust') || fs.existsSync(path.join(dir, 'Cargo.toml'))) {
    return which('cargo-mutants') ? 'cargo-mutants' : null;
  }
  if (langs.includes('csharp') || fs.readdirSync(dir).some((f) => /\.(?:sln|slnx|csproj)$/.test(f))) {
    return which('dotnet-stryker') ? 'stryker-net' : null;
  }
  if (langs.includes('python') || ['pyproject.toml', 'setup.cfg'].some((f) => fs.existsSync(path.join(dir, f)))) {
    if (IS_WINDOWS) return 'mutmut-windows';
    return which('mutmut') || dependsOn(dir, ['mutmut']) ? 'mutmut' : null;
  }
  return null;
}

const pyModule = (f) => toPosix(f).replace(/\.py$/, '').replace(/\/__init__$/, '').replace(/^src\//, '')
  .replace(/\//g, '.');

/** The mutation command for `tool` on `files` (project-relative). */
function mutationCommand(tool, { target, prel, files, odir, slug }) {
  const q = quoteArg;
  if (tool === 'stryker') {
    const inc = path.join(target.state.paths.cache, `stryker-incremental-${slug}.json`);
    return `npx stryker run --mutate ${q(files.join(','))} --reporters json,clear-text --incremental `
      + `--incrementalFile ${q(inc)}`;
  }
  if (tool === 'stryker-net') {
    return `dotnet stryker --since:${target.base.sha || 'HEAD'} --reporter json `
      + `--output ${q(path.join(odir, 'stryker-net'))}`;
  }
  if (tool === 'cargo-mutants') {
    const diffFile = path.join(odir, 'snapshot.diff');
    writeFileAtomic(diffFile, diffOf(target, prel));
    return `cargo mutants --in-diff ${q(diffFile)} --output ${q(odir)} --no-shuffle`;
  }
  return `mutmut run --paths-to-mutate ${q(files.join(','))}`;
}

/** Parse what the mutation tool left behind (reports, mutants.out, `mutmut results`). */
async function mutationResults(tool, { pdir, odir, files, res, logFile }) {
  if (tool === 'stryker') {
    const j = readJson(path.join(pdir, 'reports', 'mutation', 'mutation.json'), null);
    return j && parseStrykerReport(j, { root: pdir, onlyFiles: files });
  }
  if (tool === 'stryker-net') {
    const dir = path.join(odir, 'stryker-net');
    const f = listFiles(dir, { maxDepth: 6 }).find((x) => path.posix.basename(x) === 'mutation-report.json');
    return f ? parseStrykerReport(readJson(path.join(dir, f), null), { root: pdir, onlyFiles: files }) : null;
  }
  if (tool === 'cargo-mutants') {
    const mo = path.join(odir, 'mutants.out');
    if (!fs.existsSync(mo)) return null;
    const read = (n) => readText(path.join(mo, `${n}.txt`), '');
    return parseCargoMutants({ caught: read('caught'), missed: read('missed'), timeout: read('timeout'),
      unviable: read('unviable') });
  }
  const results = await runStep('mutmut results', { cwd: pdir, env: runEnv().env, timeoutMs: 120_000, logFile });
  return parseMutmutOutput(`${results.stdout}\n${res.stdout}`, { onlyModules: files.map(pyModule) });
}

/**
 * Mutation testing restricted to changed source files (§9.1 step 13, `--deep`). Returns
 * `{ tool, mutants, killed, survived, score, survivors[], ..., checks }`; soft (report-only).
 */
export async function mutationScope({
  target, detectResult = null, budgetMin = DEFAULT_BUDGET_MIN, noInstall = false, keep = false, dryRun = false,
} = {}) {
  const root = target.root;
  const tree = target.snapshot.tree;
  const det = detectResult || await detect({ root, stateInfo: dryRun ? null : target.state });
  const changed = changedSourceLines(target, det);
  const budget = Number(budgetMin) > 0 ? Number(budgetMin) : DEFAULT_BUDGET_MIN;
  const out = { tool: null, mutants: 0, killed: 0, survived: 0, score: null, survivors: [], budget_min: budget,
    projects: [], checks: [] };
  const finish = (...a) => finishProbe(out, {
    id: 'CK-MUTATION', fm: ['FM-03', 'FM-16'], root, keep,
    findings: () => out.survivors.slice(0, 100).map((s) => ({ id: 'CK-MUTATION', severity: 'info', file: s.file,
      line: s.line, evidence: s.status, message: `surviving mutant${s.mutator ? ` (${s.mutator})` : ''}`
        + `${s.replacement != null ? `: ${truncate(String(s.replacement), 120)}` : ''}` })),
    data: () => ({ tool: out.tool, mutants: out.mutants, killed: out.killed, survived: out.survived,
      score: out.score, budget_min: budget, soft: true, projects: out.projects }),
  }, ...a);
  if (!changed.length) return finish('skipped', 'NO_CHANGED_CODE', 'no changed source files to mutate');
  const ownerOf = new Map(changed.map((c) => [c.file, M.projectForFile(c.file, det)]));
  const owners = uniq([...ownerOf.values()]);
  if (!owners.length) return finish('skipped', 'NO_RUNNER', 'no detected project owns the changed source files');
  const totals = emptyMutation();
  const tools = [];
  const acc = tally();
  const deadline = Date.now() + budget * 60_000;
  const outRoot = path.join(tmpRoot(root), `mut-${tree.slice(0, 12)}-${nonce().slice(0, 6)}`);
  let partial = false;
  for (const project of owners) {
    const prel = toPosix(project.root || '.');
    const files = changed.filter((c) => ownerOf.get(c.file) === project).map((c) => subPath(prel, c.file));
    const tool = mutationToolFor(project, path.join(root, project.root || '.'));
    const row = { root: prel, tool: tool === 'mutmut-windows' ? 'mutmut' : tool };
    const remaining = deadline - Date.now();
    const skip = !tool ? 'NO_MUTATION_TOOL' : tool === 'mutmut-windows' ? 'POSIX_ONLY' : dryRun ? 'DRY_RUN'
      : remaining <= 0 ? 'BUDGET_EXCEEDED' : null;
    if (skip) {
      partial ||= skip === 'BUDGET_EXCEEDED';
      out.projects.push({ ...row, status: 'skipped', reason: skip, ...(skip === 'DRY_RUN' ? { files } : {}) });
      continue;
    }
    // Mutation tools edit sources: a dedicated worktree, never the clean-run one.
    const wt = acquireWorktree(root, target.snapshot.commit, 'mutation', { keep });
    const pdir = projectDir(wt, project);
    const slug = projectSlug(prel);
    const odir = ensureDir(path.join(outRoot, slug));
    const logFile = path.join(odir, 'mutation.log');
    fs.writeFileSync(logFile, '');
    const install = await installProject(wt, project, { noInstall, timeoutMs: remaining, logFile });
    if (install.cmd && install.exit !== 0) {
      out.projects.push({ ...row, status: 'unverified', reason: 'INSTALL_FAILED' });
      continue;
    }
    let cmd = mutationCommand(tool, { target, prel, files, odir, slug });
    fs.appendFileSync(logFile, `$ ${cmd}\n`);
    log(redact(`mutation: ${cmd} (in ${toPosix(pdir)}, budget ${Math.round(remaining / 60000)} min)`));
    let res = await runStep(cmd, { cwd: pdir, env: runEnv().env, timeoutMs: remaining, logFile });
    if (tool === 'mutmut' && /no such option: --paths-to-mutate|unrecognized arguments/.test(res.stdout + res.stderr)) {
      // mutmut 3 reads paths_to_mutate from its config only.
      cmd = 'mutmut run';
      fs.appendFileSync(logFile, `$ ${cmd}\n`);
      res = await runStep(cmd, { cwd: pdir, env: runEnv().env, timeoutMs: Math.max(1000, deadline - Date.now()),
        logFile });
    }
    const parsed = await mutationResults(tool, { pdir, odir, files, res, logFile });
    acc.add(storeArtifacts(target, tree, slug, { log_path: logFile }, { prefix: 'mutation-' }), cmd, res.exit, res.ms);
    partial ||= res.timedOut;
    if (!parsed) {
      out.projects.push({ ...row, status: res.timedOut ? 'skipped' : 'unverified',
        reason: res.timedOut ? 'BUDGET_EXCEEDED' : 'TOOL_FAILED', exit: res.exit });
      continue;
    }
    for (const k of ['mutants', 'killed', 'survived', 'timeout', 'no_coverage']) totals[k] += parsed[k] || 0;
    out.survivors.push(...parsed.survivors.map((s) => ({ ...s, file: repoPath(prel, s.file) })));
    tools.push(tool);
    out.projects.push({ ...row, status: 'measured', mutants: parsed.mutants, killed: parsed.killed,
      survived: parsed.survived, score: parsed.score, ...(res.timedOut ? { partial: true } : {}) });
  }
  if (!keep) fs.rmSync(outRoot, { recursive: true, force: true });
  if (dryRun) {
    out.tool = out.projects.map((p) => p.tool).filter(Boolean).join(', ') || null;
    const plan = out.projects.map((p) => `${p.root}: ${p.tool || p.reason}`).join('; ');
    return finish('skipped', 'DRY_RUN', `dry run: ${plan}`);
  }
  const undetected = totals.survived + totals.no_coverage;
  Object.assign(out, { tool: uniq(tools).join(', ') || null, mutants: totals.mutants, killed: totals.killed,
    survived: undetected, timeout: totals.timeout, no_coverage: totals.no_coverage,
    score: score(totals.killed, totals.killed + undetected) });
  if (!tools.length) {
    const unverified = out.projects.find((p) => p.status === 'unverified');
    const reason = unverified ? unverified.reason
      : ['BUDGET_EXCEEDED', 'POSIX_ONLY'].find((r) => out.projects.some((p) => p.reason === r)) || 'NO_MUTATION_TOOL';
    const summary = reason === 'NO_MUTATION_TOOL'
      ? 'no mutation tool for the changed files (StrykerJS, Stryker.NET, cargo-mutants, mutmut); skipped, '
        + 'verdict unaffected'
      : reason === 'POSIX_ONLY' ? 'mutmut needs fork() and does not run on native Windows (use WSL); skipped'
        : `mutation run did not complete (${reason})`;
    return finish(unverified ? 'unverified' : 'skipped', reason, summary, acc);
  }
  const summary = `${out.tool}: ${out.mutants} mutant(s), ${out.killed} killed, ${out.survived} survived, `
    + `score ${out.score ?? 'n/a'}%${partial ? ' (partial: budget reached)' : ''} (soft)`;
  return finish('pass', partial ? 'PARTIAL' : null, summary, acc);
}

// ---------------------------------------------------------------------------
// flake-probe

const UNKNOWN_FLAG_RE = new RegExp(['Unrecognized CLI Parameter', 'bad option: --', 'unknown option', 'Unknown option',
  'no such option', 'unrecognized arguments', 'flag provided but not defined', 'Unknown argument',
  'error: unexpected argument'].join('|'));

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
  return {
    tests: all.length,
    suspects: all.filter((a) => a.flaky > 0 || (a.passed > 0 && a.failed > 0))
      .map((a) => ({ id: a.id, passed: a.passed, failed: a.failed, flaky: a.flaky, runs: a.runs.length })),
    consistent: all.filter((a) => a.failed > 0 && a.passed === 0 && a.flaky === 0).map((a) => a.id),
  };
}

/**
 * Repeat changed/new tests `times` times with shuffling and recorded seeds where the runner supports
 * it (§10.4); otherwise sequential runs with `shuffle: false`. Returns
 * `{ runs, shuffle, seeds[], failures[], suspect_tests[], consistent_failures[], checks }`.
 */
export async function flakeProbe({
  target, detectResult = null, times = DEFAULT_TIMES, tests = null, runner = null, noInstall = false, keep = false,
  timeoutS = DEFAULT_TIMEOUT_S, dryRun = false,
} = {}) {
  const root = target.root;
  const tree = target.snapshot.tree;
  const det = detectResult || await detect({ root, stateInfo: dryRun ? null : target.state });
  const n = Math.max(1, Math.min(1000, Number.parseInt(times, 10) || DEFAULT_TIMES));
  const specs = tests && toArray(tests).length ? parseRedGreenSpec(tests)
    : diffNameStatus(root, target.base.sha || emptyTree(root), target.snapshot.commit)
      .filter((f) => f.status !== 'D' && isTest(f.path, det)).map((f) => ({ file: toPosix(f.path), name: null }));
  const out = { runs: 0, shuffle: false, seeds: [], failures: [], suspect_tests: [], consistent_failures: [],
    tests_probed: specs.map((s) => s.file + (s.name ? `::${s.name}` : '')), projects: [], checks: [] };
  const finish = (...a) => finishProbe(out, {
    id: 'CK-FLAKE', fm: ['FM-13'], root, keep,
    findings: () => out.suspect_tests.slice(0, 100).map((s) => ({ id: 'CK-FLAKE', severity: 'finding',
      file: s.file || null, line: null, evidence: '',
      message: `flaky: ${s.id} (${s.passed} passed, ${s.failed} failed, ${s.flaky} flaky of ${s.runs} runs)` })),
    data: () => ({ runs: out.runs, shuffle: out.shuffle, seeds: out.seeds, suspect_tests: out.suspect_tests.length,
      consistent_failures: out.consistent_failures, tests_probed: out.tests_probed, projects: out.projects }),
  }, ...a);
  if (!specs.length) {
    return finish('skipped', 'NO_CHANGED_TESTS', 'no new or changed test files to probe (pass --tests <files>)');
  }
  const groups = groupByRunner(specs, det, runner, runner ? ROOT_PROJECT : null);
  if (!groups.length) {
    return finish('unverified', 'NO_RUNNER', 'no detected project owns the test files; pass --runner');
  }
  const acc = tally();
  const outRoot = path.join(tmpRoot(root), `flake-${tree.slice(0, 12)}-${nonce().slice(0, 6)}`);
  const allRuns = [];
  let unverified = null;
  for (const g of groups) {
    const { project, prel, runner: r, items } = g;
    if (!r) {
      out.projects.push({ root: prel, status: 'unverified', reason: 'NO_RUNNER' });
      unverified ||= 'NO_RUNNER';
      continue;
    }
    const slug = groupSlug(groups, g);
    const select = { files: items.map((s) => subPath(prel, s.file)), names: uniq(items.map((s) => s.name)) };
    let shuffle = Boolean(r.shuffle) && dependsOn(path.join(root, project.root || '.'), r.shuffleRequires);
    const prow = { root: prel, runner: r.name, runs: 0, shuffle,
      retries_disabled: (r.retries_off || {}).coverage || 'unknown', status: 'pending' };
    out.projects.push(prow);
    if (dryRun) {
      Object.assign(prow, { status: 'skipped', reason: 'DRY_RUN' });
      continue;
    }
    const wt = acquireWorktree(root, target.snapshot.commit, 'head', { keep });
    const gomod = goModuleOf(projectDir(wt, project));
    const mine = (t) => items.some((s) => (!s.name || String(t.id).includes(s.name))
      && testMatchesFile(t, s.file, { goModule: gomod, projectRoot: prel }));
    for (let i = 1; i <= n; i++) {
      const seed = shuffle ? randomInt(1, 2 ** 31 - 1) : null;
      const opts = { outDir: path.join(outRoot, slug, `run-${i}`), noInstall, timeoutMs: timeoutS * 1000, select,
        seed };
      let rec = await runProject(wt, project, r, opts);
      if (i === 1 && shuffle && !rec.counts && UNKNOWN_FLAG_RE.test(`${rec.stdoutTail}\n${rec.stderrTail}`)) {
        // The runner is too old for its shuffle flags: fall back to sequential runs.
        shuffle = false;
        Object.assign(prow, { shuffle: false, shuffle_note: 'shuffle flags rejected by the runner; sequential runs' });
        rec = await runProject(wt, project, r, { ...opts, outDir: path.join(outRoot, slug, 'run-1b'), seed: null });
      }
      acc.add(storeArtifacts(target, tree, slug, rec, { prefix: `flake-${i}-` }), rec.cmd, rec.exit, rec.ms);
      if (!rec.counts) {
        prow.status = 'unverified';
        prow.reason = rec.status === 'unverified' ? rec.reason : rec.timedOut ? 'TIMEOUT'
          : rec.runnerMissing ? 'RUNNER_NOT_FOUND' : 'NO_REPORT';
        unverified ||= prow.reason;
        break;
      }
      // When ids carry no file (cargo, TRX), the run was restricted to the named files anyway.
      let picked = rec.tests.filter(mine);
      if (!picked.length && rec.applied && rec.applied.select) picked = rec.tests;
      const seeds = seed != null ? [String(seed)] : rec.seeds.map(String);
      out.seeds.push(...seeds);
      const run = allRuns.length + 1;
      const runSeed = seeds[0] || null;
      allRuns.push({ run, project: prel, seed: runSeed,
        tests: picked.map((t) => ({ ...t, file: t.file ? repoPath(prel, t.file) : null })) });
      for (const t of picked.filter((x) => ['failed', 'error', 'flaky'].includes(x.status))) {
        if (out.failures.length >= 200) break;
        out.failures.push({ run, project: prel, seed: runSeed, id: t.id, status: t.status,
          failure_kind: t.failure_kind || null, message: t.message || null });
      }
      prow.runs++;
    }
    if (prow.status === 'pending') prow.status = 'probed';
    out.shuffle ||= shuffle;
  }
  if (!keep) fs.rmSync(outRoot, { recursive: true, force: true });
  out.runs = allRuns.length;
  if (dryRun) return finish('skipped', 'DRY_RUN', `dry run: would run ${out.tests_probed.join(', ')} ${n} time(s)`);
  const agg = aggregateRuns(allRuns);
  const fileOf = new Map(allRuns.flatMap((r) => r.tests.map((t) => [t.id, t.file])));
  Object.assign(out, { suspect_tests: agg.suspects.map((s) => ({ ...s, file: fileOf.get(s.id) || null })),
    consistent_failures: agg.consistent, tests_seen: agg.tests });
  if (!out.runs) return finish('unverified', unverified || 'NO_REPORT', 'no probe run produced parseable results', acc);
  if (!agg.tests) {
    return finish('unverified', 'NO_TESTS_EXECUTED', 'the probe runs executed none of the selected tests', acc);
  }
  const seedList = out.seeds.slice(0, 5).join(', ') + (out.seeds.length > 5 ? ', ...' : '');
  const base = `${out.runs} run(s) of ${agg.tests} test(s), shuffle ${out.shuffle ? 'on' : 'off'}`
    + (out.seeds.length ? ` (seeds ${seedList})` : '');
  const notes = [
    out.projects.filter((p) => p.retries_disabled !== 'full')
      .map((p) => `${p.root}: retries_disabled ${p.retries_disabled}`).join('; '),
    out.consistent_failures.length
      ? `${out.consistent_failures.length} test(s) failed in every run (not flaky; see CK-CLEANRUN)` : '',
    unverified ? `incomplete: ${unverified}` : ''].filter(Boolean).join('; ');
  const tail = `${base}${notes ? `; ${notes}` : ''}`;
  if (out.suspect_tests.length) {
    const ids = out.suspect_tests.slice(0, 3).map((s) => s.id).join(', ');
    return finish('finding', 'FLAKY', `${out.suspect_tests.length} flaky test(s): ${ids} - ${tail}`, acc);
  }
  return finish(unverified ? 'unverified' : 'pass', unverified || null, `no flaky test in ${tail}`, acc);
}

// ---------------------------------------------------------------------------
// Commands

/** A probe command: numeric options are validated before anything is written; a skipped probe exits 0. */
function probeCommand(name, usage, options, prepare, probe) {
  return defineCommand({
    name, usage: usage.join('\n'), options,
    async run(ctx, values) {
      const opts = prepare(values);
      const { target, detectResult } = await commandSetup(ctx, values);
      const res = await probe({ target, detectResult, noInstall: Boolean(values['no-install']),
        keep: Boolean(values.keep), dryRun: ctx.dryRun, ...opts });
      return { result: redactAll(res), exit: exitFor(res.status === 'skipped' ? 'pass' : res.status, res.checks),
        summary: redact(`${res.status.toUpperCase()} - ${res.checks[0].summary}`) };
    },
  });
}

const timeoutOf = (values) => numberOption(values, 'timeout', DEFAULT_TIMEOUT_S);

export const coverageDeltaCommand = probeCommand('coverage-delta', [
  'coverage-delta [--base <ref>] [--fail-under <pct>] [--report <coverage file>[,<file>]] [--runner <name>]',
  '               [--no-install] [--keep] [--timeout <s>] [--refresh] [--json]',
  'Changed-line coverage of the snapshot (CK-COVERAGE). Without --report the suite runs with coverage in a temp',
  'worktree. Report-only unless --fail-under is given. Formats: LCOV, Cobertura XML, Istanbul JSON, Go cover profiles.',
], { ...COMMON_OPTIONS, 'fail-under': { type: 'string' }, report: { type: 'string' } },
(v) => ({ timeoutS: timeoutOf(v), failUnder: failUnderOf(v['fail-under']), report: v.report || null,
  runner: v.runner || null }), coverageDelta);

export const mutationScopeCommand = probeCommand('mutation-scope', [
  'mutation-scope [--base <ref>] [--budget <minutes>] [--no-install] [--keep] [--refresh] [--json]',
  'Mutation testing restricted to changed source files (CK-MUTATION, soft): StrykerJS --mutate, Stryker.NET --since,',
  'cargo mutants --in-diff, mutmut (POSIX only). Skipped when no tool is installed.',
], { base: COMMON_OPTIONS.base, budget: { type: 'string' }, 'no-install': COMMON_OPTIONS['no-install'],
  keep: COMMON_OPTIONS.keep, refresh: COMMON_OPTIONS.refresh },
(v) => ({ budgetMin: numberOption(v, 'budget', DEFAULT_BUDGET_MIN) }), mutationScope);

export const flakeProbeCommand = probeCommand('flake-probe', [
  'flake-probe [--base <ref>] [--times <n>] [--tests <file[::name]>,...] [--runner <name>] [--no-install] [--keep]',
  '            [--timeout <s>] [--refresh] [--json]',
  'Repeats new/changed tests n times (default 5) with shuffling and recorded seeds where the runner supports it',
  '(CK-FLAKE).',
], { ...COMMON_OPTIONS, times: { type: 'string' }, tests: { type: 'string', multiple: true } },
(v) => ({ times: numberOption(v, 'times', DEFAULT_TIMES, { integer: true }), timeoutS: timeoutOf(v),
  runner: v.runner || null, tests: v.tests }),
(o) => flakeProbe({ ...o, tests: repoRelativeEntries(o.tests, o.target.cwd, o.target.root) }));
