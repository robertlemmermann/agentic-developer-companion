// diff-scope (plan §7.2, §9.1 steps 2-8, §9.2 ratchet, §10.5): diff-scoped checks of the
// working-tree snapshot against the base. CK-SCOPE, CK-TEST-DEL, CK-SKIP, CK-ASSERT,
// CK-TEST-CFG, CK-SUPPRESS, CK-CI, CK-SWALLOW, CK-SECRETS, CK-LOCK (static), CK-RETRY.
// The ratchet compares occurrences on added lines with occurrences on removed lines of the
// same file (keyed by text and test-case context), so moved or reformatted lines do not count.

import fs from 'node:fs';
import path from 'node:path';
import {
  defineCommand, EXIT, which, runTool, sha256, asciiJson, toPosix, truncate, redactLiterals, readText, readInput,
  matchGlob, tmpRoot, nonce, ensureDir, parseVersion, versionGte, liveSecrets, parseJsonl, makeCheck, log,
} from './core.mjs';
import { emptyTree, diffNameStatus, diffLines, lsTree } from './git.mjs';
import { prepareTarget, snapshotExcludes } from './state.mjs';
import { detect } from './detect.mjs';
import * as M from './markers.mjs';
import {
  parseManifest, isParsableManifest, manifestDelta, lockFor, lockIndex, lockHas, lockManager, normPypi, goSumNeeded,
  blobReader, toolEnv,
} from './deps.mjs';

export const CHECK_FM = Object.freeze({
  'CK-SCOPE': ['FM-11'], 'CK-TEST-DEL': ['FM-01'], 'CK-SKIP': ['FM-01'], 'CK-ASSERT': ['FM-01', 'FM-03'],
  'CK-TEST-CFG': ['FM-01', 'FM-06'], 'CK-SUPPRESS': ['FM-05'], 'CK-CI': ['FM-06'], 'CK-SWALLOW': ['FM-07'],
  'CK-SECRETS': ['FM-09'], 'CK-LOCK': ['FM-12'], 'CK-RETRY': ['FM-13'],
});
// Files larger than this are not scanned line by line (lockfiles and manifests are still parsed).
const MAX_SCAN_BYTES = 2 * 1024 * 1024;
const MAX_FINDINGS_PER_CHECK = 200;
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const SEVERITY_RANK = { info: 0, finding: 1, fail: 2 };
const plural = (n, one, many = `${one}s`) => (n === 1 ? one : many);
// Path classes whose content some check reads (code files are read too).
const READ_CLASSES = ['ci', 'runnerConfig', 'lintConfig', 'manifest', 'lockfile'];

// ---------------------------------------------------------------------------
// Shared state for one run

function makeState(target, detectResult, env) {
  const root = target.root;
  const from = target.base.sha || emptyTree(root);
  const to = target.snapshot.commit;
  const pathspec = ['.', ...snapshotExcludes(target.state).map((p) => `:(top,exclude)${p}`)];
  const changes = diffNameStatus(root, from, to, pathspec);
  const linesByPath = new Map(diffLines(root, from, to, pathspec).map((f) => [f.path, f]));
  const secrets = liveSecrets(env);
  const blobs = blobReader(root);
  const S = {
    root, from, to, target, env, secrets, findings: [], unverified: {}, summaries: {}, data: {}, counts: {},
    read: blobs.read, prefetch: blobs.prefetch, headTree: null, baseTree: null,
  };
  const linesCache = new Map();
  const linesOf = (text) => {
    if (text == null || text.length > MAX_SCAN_BYTES) return null;
    if (!linesCache.has(text)) {
      const l = text.split(/\r?\n/);
      if (l.length && l[l.length - 1] === '') l.pop();
      linesCache.set(text, l);
    }
    return linesCache.get(text);
  };
  S.headLines = (file) => linesOf(S.read(to, file));
  S.baseLines = (file) => (target.base.sha ? linesOf(S.read(from, file)) : null);
  S.headFiles = () => (S.headTree ||= new Set(lsTree(root, to)));
  S.baseFiles = () => (S.baseTree ||= new Set(target.base.sha ? lsTree(root, from) : []));
  // A Rust file holding `#[cfg(test)]`/`#[test]` is a test file too, so Rust content is read.
  const testCache = new Map();
  S.isTest = (file, side) => {
    const k = `${side}\u0000${file}`;
    if (!testCache.has(k)) {
      const rev = side === 'base' ? (target.base.sha ? from : null) : to;
      const content = rev && M.langOf(file) === 'rs' ? S.read(rev, file) : null;
      testCache.set(k, M.isTestFile(file, detectResult, { codeOnly: true, content }));
    }
    return testCache.get(k);
  };
  // Rust keeps unit tests in `#[cfg(test)] mod tests { }` inside production files: those files
  // count as test files for test-case bookkeeping, but only the module's lines are test code.
  const rangeCache = new Map();
  S.testRanges = (side, file) => {
    if (M.langOf(file) !== 'rs' || M.isTestFile(file, detectResult, { codeOnly: true })) return null;
    const k = `${side}\u0000${file}`;
    if (!rangeCache.has(k)) {
      const lines = side === 'base' ? S.baseLines(file) : S.headLines(file);
      const ranges = lines ? M.rustTestRanges(lines) : [];
      rangeCache.set(k, ranges.length ? ranges : null);
    }
    return rangeCache.get(k);
  };
  /** Is `line` of `file` test code? (Always true in a test file, only inside the test module of a mixed one.) */
  S.testLine = (side, file, line) => {
    const r = S.testRanges(side, file);
    return !r || r.some(([a, b]) => line >= a && line <= b);
  };
  const caseCache = new Map();
  S.cases = (side, file) => {
    const k = `${side}\u0000${file}`;
    if (!caseCache.has(k)) {
      const lines = side === 'base' ? S.baseLines(file) : S.headLines(file);
      caseCache.set(k, lines ? M.testCases(lines, file) : []);
    }
    return caseCache.get(k);
  };
  const strip = (list) => (list || []).map((x) => ({ line: x.line, text: x.text.replace(/\r$/, '') }));
  S.files = changes.map((c) => {
    const d = linesByPath.get(c.path) || linesByPath.get(c.oldPath) || { added: [], removed: [], binary: false };
    const status = c.status === 'T' ? 'M' : c.status;
    return {
      path: c.path, old_path: c.oldPath || (status === 'A' ? null : c.path), status, binary: Boolean(d.binary),
      added: strip(d.added), removed: strip(d.removed), class: M.classifyPath(c.path), lang: M.langOf(c.path),
    };
  });
  // Both sides of every changed file some check reads, in two git processes instead of two per file.
  const readable = (p) => p && (M.langOf(p) || READ_CLASSES.some((k) => M.classifyPath(p)[k]));
  S.prefetch(S.files.filter((f) => !f.binary && (readable(f.path) || readable(f.old_path))).flatMap((f) => [
    ...(f.status !== 'D' ? [[to, f.path]] : []),
    ...(target.base.sha && f.status !== 'A' && f.old_path ? [[from, f.old_path]] : []),
  ]));
  S.add = (check, severity, file, line, message, evidence = '', extra = {}) => {
    S.findings.push({
      id: check, severity, file: file ? toPosix(file) : null, line: line ?? null,
      // Messages quote config values and commands, so they get the same masking as excerpts.
      message: redactText(message, secrets), evidence: truncate(redactText(evidence, secrets).trim(), 240), ...extra,
    });
  };
  return S;
}

/** Text that may quote changed lines: secret shapes masked in place, live-credential literals redacted. */
function redactText(text, secrets) {
  return redactLiterals(M.redactSecrets(String(text ?? '')), secrets);
}

/** A quoted value for a message: redacted before it is shortened, so a cut never leaves half a secret. */
const clip = (S, text, max) => truncate(redactText(text, S.secrets), max);

/** `items` minus one occurrence per element of `removeItems` (compared by `keyFn`). */
function multisetSubtract(items, removeItems, keyFn) {
  const counts = new Map();
  for (const r of removeItems) { const k = keyFn(r); counts.set(k, (counts.get(k) || 0) + 1); }
  const out = [];
  for (const it of items) {
    const k = keyFn(it);
    const n = counts.get(k) || 0;
    if (n > 0) counts.set(k, n - 1);
    else out.push(it);
  }
  return out;
}

const lineSet = (arr) => new Set(arr.map((x) => x.line));

/** Lines array for one side, falling back to a sparse array of the diff lines when content is unavailable. */
function sideLines(S, f, side) {
  const lines = side === 'base' ? (f.old_path ? S.baseLines(f.old_path) : null)
    : (f.status === 'D' ? null : S.headLines(f.path));
  if (lines) return lines;
  const src = side === 'base' ? f.removed : f.added;
  const sparse = [];
  for (const x of src) sparse[x.line - 1] = x.text;
  for (let i = 0; i < sparse.length; i++) if (sparse[i] === undefined) sparse[i] = '';
  return sparse;
}

/** Name of the test case a marker on `line` belongs to (decorators look forward, body markers look back). */
function caseContext(S, side, file, lines, line) {
  const cases = S.cases(side, file);
  if (!cases.length) return '';
  const text = (lines[line - 1] || '').trim();
  const forward = /^(?:@|#\[|\[)/.test(text);
  const same = cases.find((c) => c.line === line);
  if (same) return same.name || `unnamed:${norm(text)}`;
  if (forward) {
    const next = cases.find((c) => c.line > line && c.line <= line + 6);
    if (next) return next.name || 'unnamed';
  }
  let best = null;
  for (const c of cases) { if (c.line < line) best = c; else break; }
  return best ? (best.name || 'unnamed') : '';
}

/**
 * New occurrences of a catalog on the added lines of `f` (the ratchet): head hits on added
 * lines minus base hits on removed lines, keyed by id + normalized text (+ case context).
 */
function newHits(S, f, catalogs, { context = false } = {}) {
  if (f.status === 'D' || f.binary || !f.added.length) return [];
  const head = sideLines(S, f, 'head');
  const headHits = M.scanText(head, catalogs, { file: f.path, lines: lineSet(f.added) });
  if (!headHits.length) return [];
  const base = f.old_path && f.removed.length ? sideLines(S, f, 'base') : null;
  const baseHits = base ? M.scanText(base, catalogs, { file: f.old_path, lines: lineSet(f.removed) }) : [];
  const key = (side, lines, file) => (h) => {
    const ctx = context ? caseContext(S, side, file, lines, h.line) : '';
    // Inside a known test case the marker itself identifies the occurrence: editing the rest of a
    // line that already carried it (a skip reason, an assertion on the same line) adds nothing.
    return `${h.id}|${ctx ? norm(h.match ?? h.text) : norm(h.text)}|${ctx}`;
  };
  const headKey = key('head', head, f.path);
  const baseKey = key('base', base || [], f.old_path);
  const baseKeys = baseHits.map((h) => ({ k: baseKey(h) }));
  return multisetSubtract(headHits.map((h) => ({ ...h, k: headKey(h) })), baseKeys, (x) => x.k);
}

/** Like newHits for structural detectors `fn(lines, file) -> [{ id, line, text }]`. */
function newDerivedHits(S, f, fn) {
  if (f.status === 'D' || f.binary || !f.added.length) return [];
  const added = lineSet(f.added);
  const headHits = fn(sideLines(S, f, 'head'), f.path).filter((h) => added.has(h.line));
  if (!headHits.length) return [];
  const removed = lineSet(f.removed);
  const baseHits = f.old_path && f.removed.length
    ? fn(sideLines(S, f, 'base'), f.old_path).filter((h) => removed.has(h.line)) : [];
  return multisetSubtract(headHits, baseHits, (h) => `${h.id}|${norm(h.text)}`);
}

// ---------------------------------------------------------------------------
// CK-TEST-DEL: deleted or renamed-away test files, test cases removed inside a file

/** Whether a runner finds tests by file name for this language (so losing the name hides the file). */
function namingRequired(oldNaming, newPath) {
  if (!oldNaming) return false;
  if (['pytest', 'go', 'jvm', 'ruby', 'phpunit'].includes(oldNaming)) return true;
  if (oldNaming === 'js') return !/(?:^|\/)(?:__tests__|test|tests)\//.test(newPath);
  return false;
}

const caseKey = (c, lines) => c.name || `unnamed:${norm(lines?.[c.line - 1] || '')}`;
const caseLabel = (c) => c.name || `line ${c.line}`;

/** Assertion lines inside each case's range (from its declaration to the next one), aligned with `cases`. */
function caseAssertionCounts(cases, lines, file) {
  const counts = cases.map(() => 0);
  if (!lines || !cases.length) return counts;
  let ci = 0;
  for (const h of M.scanText(lines, M.ASSERTION_LINE, { file })) {
    while (ci + 1 < cases.length && cases[ci + 1].line <= h.line) ci++;
    if (h.line >= cases[ci].line) counts[ci]++;
  }
  return counts;
}

function checkTestDeletion(S) {
  const perFile = [];
  const addedPool = new Map(); // case key -> [{ file, line, assertions }]
  let filesDeleted = 0;
  let filesRenamedOut = 0;
  let casesBase = 0;
  let casesHead = 0;
  // Cases of `cases` (keyed in `lines`) that `others` (keyed in `otherLines`) does not have.
  const missingFrom = (cases, lines, others, otherLines) => multisetSubtract(cases,
    others.map((c) => ({ k: caseKey(c, otherLines) })), (c) => (c.k !== undefined ? c.k : caseKey(c, lines)));
  for (const f of S.files) {
    const oldTest = f.status !== 'A' && f.old_path && S.isTest(f.old_path, 'base');
    const newTest = f.status !== 'D' && S.isTest(f.path, 'head');
    if (!oldTest && !newTest) continue;
    // A modified file that stops looking like a test (a Rust module whose #[cfg(test)] block was
    // deleted) is still compared case by case, so the loss shows up.
    const keepsPath = f.status === 'M' || f.status === 'T';
    const headSide = newTest || (oldTest && keepsPath);
    const baseL = oldTest ? S.baseLines(f.old_path) : null;
    const headL = headSide ? S.headLines(f.path) : null;
    const baseCases = oldTest ? S.cases('base', f.old_path) : [];
    const headCases = headSide ? S.cases('head', f.path) : [];
    casesBase += baseCases.length;
    casesHead += headCases.length;
    const baseCounts = caseAssertionCounts(baseCases, baseL, f.old_path);
    const headCounts = caseAssertionCounts(headCases, headL, f.path);
    perFile.push({ f, oldTest, newTest, headSide, baseCases, headCases, baseL, headL, baseCounts });
    for (const c of missingFrom(headCases, headL, baseCases, baseL)) {
      const k = caseKey(c, headL);
      if (!addedPool.has(k)) addedPool.set(k, []);
      addedPool.get(k).push({ file: f.path, line: c.line, assertions: headCounts[headCases.indexOf(c)] });
    }
  }
  const takeMoved = (k, file) => {
    const list = addedPool.get(k);
    const i = list ? list.findIndex((x) => x.file !== file) : -1;
    return i === -1 ? null : list.splice(i, 1)[0];
  };
  // A case that moves to another file must take its assertions along (an emptied copy is a removal).
  const weakenedMoves = (from, moves) => {
    const weak = moves.filter((x) => x.to.assertions < x.before);
    if (!weak.length) return;
    const lost = weak.reduce((n, x) => n + x.before - x.to.assertions, 0);
    const detail = weak.slice(0, 5)
      .map((x) => `${caseLabel(x.c)} (${x.before} -> ${x.to.assertions}, now in ${x.to.file})`);
    S.add('CK-ASSERT', 'fail', weak[0].to.file, weak[0].to.line,
      `${weak.length} test ${plural(weak.length, 'case')} moved from ${from} with fewer assertions (${lost} assertion `
        + `${plural(lost, 'line')} lost): ${detail.join(', ')}`,
      (S.headLines(weak[0].to.file) || [])[weak[0].to.line - 1] || '', { rule: 'assert.moved-weakened' });
  };
  // Base line ranges of cases reported as removed or moved: their assertions are accounted for
  // here, so CK-ASSERT does not count them again. Renamed cases stay with CK-ASSERT.
  S.removedCaseRanges = new Map();
  const accounted = (e, list) => {
    if (!list.length || !e.f.old_path) return;
    const ranges = S.removedCaseRanges.get(e.f.old_path) || [];
    for (const c of list) {
      const idx = e.baseCases.indexOf(c);
      const end = idx + 1 < e.baseCases.length ? e.baseCases[idx + 1].line - 1 : (e.baseL ? e.baseL.length : c.line);
      ranges.push([c.line, end]);
    }
    S.removedCaseRanges.set(e.f.old_path, ranges);
  };
  for (const e of perFile) {
    const { f, oldTest, newTest, headSide, baseCases, headCases, baseL, baseCounts } = e;
    if (f.status === 'D' && oldTest) {
      filesDeleted++;
      if (!baseCases.length && !M.testNaming(f.old_path)) {
        S.add('CK-TEST-DEL', 'info', f.old_path, null, `test support file deleted: ${f.old_path}`, '');
        continue;
      }
      const moves = [];
      baseCases.forEach((c, i) => {
        const to = takeMoved(caseKey(c, baseL), f.old_path);
        if (to) moves.push({ c, to, before: baseCounts[i] });
      });
      if (baseCases.length && moves.length === baseCases.length) {
        const dest = [...new Set(moves.map((x) => x.to.file))];
        S.add('CK-TEST-DEL', 'info', f.old_path, null,
          `test file deleted; all ${baseCases.length} case(s) reappear in ${dest.join(', ')}`, '');
      } else {
        S.add('CK-TEST-DEL', 'fail', f.old_path, null,
          `test file deleted: ${f.old_path} (${baseCases.length} test ${plural(baseCases.length, 'case')}`
            + `${moves.length ? `, ${moves.length} reappear elsewhere` : ''})`,
          baseCases.slice(0, 5).map(caseLabel).join(', '), { side: 'base' });
      }
      weakenedMoves(f.old_path, moves);
      continue;
    }
    if (f.status === 'R' && oldTest && !newTest) {
      filesRenamedOut++;
      S.add('CK-TEST-DEL', 'fail', f.path, null, `test file renamed out of test discovery: ${f.old_path} -> ${f.path} `
        + `(${baseCases.length} case(s) no longer collected)`, `${f.old_path} -> ${f.path}`);
      continue;
    }
    if (f.status === 'R' && oldTest && newTest) {
      const oldNaming = M.testNaming(f.old_path);
      if (namingRequired(oldNaming, f.path) && !M.testNaming(f.path)) {
        filesRenamedOut++;
        S.add('CK-TEST-DEL', 'fail', f.path, null, `test file renamed away from the runner's naming convention `
          + `(${oldNaming}): ${f.old_path} -> ${f.path}; the runner no longer collects it`,
        `${f.old_path} -> ${f.path}`);
        continue;
      }
      S.add('CK-TEST-DEL', 'info', f.path, null, `test file renamed: ${f.old_path} -> ${f.path}`, '');
    }
    if (!oldTest || !headSide || !baseCases.length) continue;
    const removed = missingFrom(baseCases, baseL, headCases, e.headL);
    if (!removed.length) continue;
    const notMoved = [];
    const moves = [];
    for (const c of removed) {
      const to = takeMoved(caseKey(c, baseL), f.path);
      if (to) moves.push({ c, to, before: baseCounts[baseCases.indexOf(c)] });
      else notMoved.push(c);
    }
    accounted(e, moves.map((x) => x.c));
    weakenedMoves(f.path, moves);
    const netLoss = baseCases.length - headCases.length;
    const effective = Math.min(netLoss - moves.length, notMoved.length);
    if (effective <= 0) {
      if (moves.length) {
        S.add('CK-TEST-DEL', 'info', f.path, null,
          `${moves.length} test case(s) moved from ${f.path} to other test files`, '');
      }
      continue;
    }
    const lost = notMoved.slice(0, effective);
    accounted(e, lost);
    S.add('CK-TEST-DEL', 'fail', f.path, lost[0].line,
      `${effective} test ${plural(effective, 'case')} removed from ${f.path} (base ${baseCases.length} -> head `
        + `${headCases.length}): ${lost.slice(0, 5).map(caseLabel).join(', ')}`,
      baseL ? baseL[lost[0].line - 1] : '', { side: 'base' });
  }
  S.counts.tests = { files_changed: perFile.length, files_deleted: filesDeleted, files_renamed_out: filesRenamedOut,
    cases_base: casesBase, cases_head: casesHead, scope: 'changed test files' };
  S.summaries['CK-TEST-DEL'] = `${perFile.length} changed test file(s); test cases ${casesBase} -> ${casesHead}; `
    + `${filesDeleted} deleted, ${filesRenamedOut} renamed out of discovery`;
}

// ---------------------------------------------------------------------------
// CK-SKIP: added skip/focus/xfail/todo markers in test files

const SKIP_WHAT = {
  focus: 'focus marker (other tests stop running)', skip: 'skip marker', xfail: 'expected-failure marker',
  todo: 'todo placeholder', constraint: 'build constraint (the default `go test ./...` no longer runs this file)',
};

function checkSkips(S) {
  let base = 0;
  let head = 0;
  let fresh = 0;
  for (const f of S.files) {
    if (f.status === 'D' || !S.isTest(f.path, 'head')) continue;
    const hits = newHits(S, f, M.SKIP_MARKERS, { context: true });
    const headL = S.headLines(f.path);
    const baseL = f.old_path ? S.baseLines(f.old_path) : null;
    if (headL) head += M.scanText(headL, M.SKIP_MARKERS, { file: f.path }).length;
    if (baseL) base += M.scanText(baseL, M.SKIP_MARKERS, { file: f.old_path }).length;
    for (const h of hits) {
      fresh++;
      // A build constraint is how integration tests are kept out of the default run, so it is a finding.
      const severity = h.kind === 'todo' || h.kind === 'constraint' ? 'finding' : 'fail';
      S.add('CK-SKIP', severity, f.path, h.line, `${SKIP_WHAT[h.kind] || 'skip marker'} added in a test file`, h.text,
        { rule: h.id });
    }
  }
  S.counts.skips = { base, head, new: fresh, scope: 'changed test files' };
  S.summaries['CK-SKIP'] = `${fresh} new skip/focus marker(s); markers in changed test files ${base} -> ${head}`;
}

// ---------------------------------------------------------------------------
// CK-ASSERT: removed assertions, downgrades, tautologies, swallowed assertion errors

const inRanges = (line, ranges) => (ranges || []).some(([a, b]) => line >= a && line <= b);

// In tests, only handlers that catch assertion failures matter: explicit AssertionError catches,
// try blocks around assertions (tryWrappedAssertions), suppress(Exception) and `rescue nil`.
const TEST_SWALLOW = [M.ASSERTION_SWALLOW,
  M.SWALLOW_PATTERNS.filter((e) => e.id === 'swallow.py-suppress' || e.id === 'swallow.rb')];

function checkAssertions(S) {
  let base = 0;
  let head = 0;
  for (const f of S.files) {
    if (f.class.snapshot && f.status !== 'A') {
      if (f.status === 'D') {
        S.add('CK-ASSERT', 'finding', f.old_path, null, `expected-output snapshot deleted: ${f.old_path}`, '');
      } else {
        S.add('CK-ASSERT', 'info', f.path, null,
          `expected-output snapshot changed: ${f.path}; check the new expectation is correct`, '');
      }
      continue;
    }
    if (f.status === 'D' || f.binary || !S.isTest(f.path, 'head')) continue;
    const oldTest = f.status !== 'A' && f.old_path && S.isTest(f.old_path, 'base');
    const headL = sideLines(S, f, 'head');
    const added = lineSet(f.added);
    const inTest = (side, file) => (h) => S.testLine(side, file, h.line);
    const headAll = M.scanText(headL, M.ASSERTION_LINE, { file: f.path }).filter(inTest('head', f.path));
    head += headAll.length;
    const tautologies = newHits(S, f, M.TAUTOLOGIES, { context: true }).filter(inTest('head', f.path));
    for (const h of tautologies) {
      S.add('CK-ASSERT', 'finding', f.path, h.line, 'assertion that can never fail', h.text, { rule: h.id });
    }
    const swallowLines = new Set();
    const swallowed = [...newHits(S, f, TEST_SWALLOW), ...newDerivedHits(S, f, M.tryWrappedAssertions)]
      .filter(inTest('head', f.path)).sort((a, b) => a.line - b.line);
    for (const h of swallowed) {
      if (swallowLines.has(h.line)) continue;
      swallowLines.add(h.line);
      S.add('CK-ASSERT', 'finding', f.path, h.line, h.id === 'assert-swallow.try-wrap'
        ? 'assertion wrapped in a try block whose handler swallows the failure'
        : 'error handling in a test swallows assertion failures', h.text, { rule: h.id });
    }
    if (f.status === 'A' || !oldTest) {
      const cases = S.cases('head', f.path);
      if (cases.length && !headAll.length && f.status === 'A') {
        S.add('CK-ASSERT', 'finding', f.path, cases[0].line, `new test file has ${cases.length} test case(s) and no `
          + 'assertions', headL[cases[0].line - 1] || '');
      }
      continue;
    }
    const baseL = sideLines(S, f, 'base');
    base += M.scanText(baseL, M.ASSERTION_LINE, { file: f.old_path }).filter(inTest('base', f.old_path)).length;
    const ranges = S.removedCaseRanges?.get(f.old_path);
    const removedA = M.scanText(baseL, M.ASSERTION_LINE, { file: f.old_path, lines: lineSet(f.removed) })
      .filter((h) => !inRanges(h.line, ranges)).filter(inTest('base', f.old_path));
    // An assertion that can never fail is no replacement for one that could.
    const tautLines = new Set(tautologies.map((h) => h.line));
    const addedA = M.scanText(headL, M.ASSERTION_LINE, { file: f.path, lines: added }).filter(inTest('head', f.path))
      .filter((h) => !tautLines.has(h.line));
    const net = removedA.length - addedA.length;
    if (net > 0) {
      const first = multisetSubtract(removedA, addedA, (h) => norm(h.text))[0] || removedA[0];
      S.add('CK-ASSERT', 'fail', f.path, first.line, `${net} ${plural(net, 'assertion')} removed from ${f.path} `
        + `without a replacement${tautLines.size ? ' (an assertion that can never fail does not count)' : ''}`,
      first.text, { side: 'base' });
    }
    const weak = (lines, file, opts) => M.scanText(lines, M.WEAK_ASSERTIONS, { file, ...opts });
    if (removedA.some((h) => !weak([baseL[h.line - 1] || ''], f.old_path).length)) {
      for (const h of weak(headL, f.path, { lines: added })) {
        if (tautLines.has(h.line)) continue;
        S.add('CK-ASSERT', 'finding', f.path, h.line, 'assertion weakened to a truthiness/existence check', h.text,
          { rule: h.id });
      }
    }
  }
  S.counts.assertions = { base, head, scope: 'changed test files' };
  S.summaries['CK-ASSERT'] = `assertion lines in changed test files ${base} -> ${head}`;
}

// ---------------------------------------------------------------------------
// CK-RETRY: in-source retries added to tests (FM-13)

function checkRetries(S) {
  let fresh = 0;
  for (const f of S.files) {
    if (f.status === 'D' || !S.isTest(f.path, 'head')) continue;
    for (const h of newHits(S, f, M.IN_SOURCE_RETRIES, { context: true })) {
      fresh++;
      S.add('CK-RETRY', 'finding', f.path, h.line, 'in-source retry added: a retried test can hide a real failure '
        + '(flaky passes count as passes)', h.text, { rule: h.id });
    }
  }
  S.summaries['CK-RETRY'] = `${fresh} in-source ${plural(fresh, 'retry', 'retries')} added`;
}

// ---------------------------------------------------------------------------
// Config context helpers (shared by CK-TEST-CFG and CK-SUPPRESS)

const indentOf = (l) => l.length - l.trimStart().length;
const keyOf = (l) => {
  const t = l.trim();
  return /^(?:-\s+)?["']?([\w$@./-]+)["']?\s*[:=]/.exec(t)?.[1]
    ?? /^<([\w.:-]+)(?:[\s>/]|$)/.exec(t)?.[1]
    ?? /^([\w.]+)\s*(?:\{|\(\s*\{?\s*$)/.exec(t)?.[1]
    ?? null;
};

/** Ancestor keys (own key first) and the enclosing [section] of line `idx` (0-based). */
export function keyPath(lines, idx) {
  const keys = [];
  let section = null;
  const own = keyOf(lines[idx] || '');
  if (own) keys.push(own);
  let cur = indentOf(lines[idx] || '');
  for (let j = idx - 1; j >= 0; j--) {
    const l = lines[j];
    if (!l || !l.trim() || /^\s*(?:#|\/\/|;)/.test(l)) continue;
    const sec = /^\s*\[{1,2}\s*([^\]]+?)\s*\]{1,2}\s*$/.exec(l);
    if (sec && indentOf(l) === 0) { section = sec[1].replace(/["']/g, ''); break; }
    const ind = indentOf(l);
    if (ind < cur) {
      const k = keyOf(l);
      if (k) keys.push(k);
      cur = ind;
    }
  }
  return { keys, section };
}

/** Text of the enclosing XML element `tag` around line idx, or ''. */
function enclosingBlock(lines, idx, tag) {
  const open = new RegExp(`<${tag}[\\s>]`);
  const close = `</${tag}>`;
  let start = -1;
  for (let j = idx; j >= 0; j--) {
    if (j !== idx && lines[j].includes(close)) break;
    if (open.test(lines[j])) { start = j; break; }
  }
  if (start === -1) return '';
  let end = lines.length - 1;
  for (let j = idx; j < lines.length; j++) if (lines[j].includes(close)) { end = j; break; }
  return lines.slice(start, end + 1).join('\n');
}

// ---------------------------------------------------------------------------
// CK-TEST-CFG: runner configuration tampering

const TEST_CFG_KEYS = new Set([
  // jest / vitest / playwright / cypress / mocha / ava / karma
  'testmatch', 'testregex', 'testpathignorepatterns', 'testpathpattern', 'testpathpatterns', 'roots',
  'modulepathignorepatterns', 'projects', 'include', 'exclude', 'includesource', 'dir', 'testdir', 'testignore', 'grep',
  'grepinvert', 'specpattern', 'excludespecpattern', 'spec', 'ignore', 'extension', 'recursive', 'files', 'retries',
  'retry', 'bail', 'passwithnotests', 'allowonly', 'forbidonly', 'failonflakytests', 'coveragethreshold', 'thresholds',
  'branches', 'functions', 'lines', 'statements', 'collectcoveragefrom', 'coveragepathignorepatterns', 'testtimeout',
  'shard', 'workspace',
  // pytest / coverage / tox
  'addopts', 'testpaths', 'python_files', 'python_classes', 'python_functions', 'norecursedirs', 'collect_ignore',
  'collect_ignore_glob', 'xfail_strict', 'fail_under', 'omit', 'exclude_lines', 'exclude_also', 'source', 'commands',
  'reruns',
  // cargo / nextest
  'test', 'harness', 'autotests', 'default-filter', 'filter', 'fail-fast', 'retries', 'test-threads',
  'required-features',
  // maven / gradle
  'skiptests', 'skip', 'skipits', 'excludes', 'includes', 'testfailureignore', 'groups', 'excludedgroups',
  'reruninfailingtestscount', 'reruninfailingtests', 'rerunfailingtestscount', 'maven.test.skip', 'testsourcedirectory',
  'testexcludes', 'excludetestsmatching', 'includetestsmatching', 'enabled', 'ignorefailures', 'onlyif', 'maxretries',
  'failonpassedafterretry', 'excludetags', 'includetags',
  // dotnet
  'compile', 'istestproject', 'testcasefilter',
  // rspec / phpunit
  'tag', 'exclude-pattern', 'pattern', 'testsuite', 'directory', 'failonrisky', 'failonwarning',
  // codecov / nyc / c8
  'target', 'threshold', 'informational', 'check-coverage', 'per-file', 'require_ci_to_pass',
]);
// Runner flags that narrow the run or hide failures, and the shell idioms that discard an exit code.
const NARROW_FLAG_NAMES = ['-k', '-m', '-t', '--testNamePattern', '--testPathPattern', '--testPathPatterns',
  '--testPathIgnorePatterns', '--grep', '--grep-invert', '-g', '--invert', '--ignore(?:-glob)?', '--deselect',
  '--exclude', '--skip', '--filter', '-run', '-skip', '--lf', '--last-failed', '--only-changed', '--onlyChanged', '-o',
  '--changedSince', '--changed', '--findRelatedTests', '--passWithNoTests', '--pass-with-no-tests', '--reruns',
  '--retries', '--retry', '--no-fail', '--exit-zero', '-DskipTests', '--exclude-tag', '--tags?', '--testcasefilter',
  '--no-tests'];
const NARROW_FLAGS = new RegExp(String.raw`(?:^|\s)(?:${NARROW_FLAG_NAMES.join('|')})(?=[\s=]|$)`
  + String.raw`|\|\|\s*(?:true|:|exit\s+0)|-Dmaven\.test\.(?:skip|failure\.ignore)=true`);
const NARROW_FLAGS_ALL = new RegExp(NARROW_FLAGS.source, 'g');
// Command lines that run a test runner.
const TEST_COMMAND = new RegExp([
  String.raw`\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b`,
  String.raw`\b(?:npx|pnpx|bunx)\s+(?:jest|vitest|mocha|ava|playwright\s+test|cypress\s+run)\b`,
  String.raw`(?:^|[\s;&|("'])(?:jest|vitest|mocha|pytest|py\.test|tox|nox|rspec|phpunit|ctest)\b`,
  String.raw`\bpython\d?(?:\.\d+)?\s+-m\s+(?:pytest|unittest)\b`,
  String.raw`\b(?:uv|poetry|pdm|hatch|pipenv)\s+run\s+(?:pytest|python\s+-m\s+pytest|tox)\b`,
  String.raw`\bgo\s+test\b`, String.raw`\bcargo\s+(?:test|nextest)\b`, String.raw`\bdotnet\s+test\b`,
  String.raw`\bmvnw?\b.*\b(?:test|verify)\b`, String.raw`\bgradlew?\b.*\b(?:test|check)\b`,
  String.raw`\bmake\s+(?:test|check)\w*\b`, String.raw`\bjust\s+test\b`, String.raw`\bbundle\s+exec\s+(?:rspec|rake)\b`,
  String.raw`\brake\s+(?:test|spec)\b`, String.raw`\b(?:deno|swift|flutter|dart|mix)\s+test\b`,
].join('|'));
const TEST_PATH_TOKEN = /^[\w.@-]*\/[\w./*@-]*$|\.(?:test|spec)\.|_test\.\w+$|^test_\w+\.py$/;

/** Reason when `after` runs fewer tests than `before` or hides failures; null otherwise. */
export function narrowsCommand(before, after) {
  const b = String(before ?? '');
  const a = String(after ?? '');
  if (TEST_COMMAND.test(b) && !TEST_COMMAND.test(a)) return 'no longer invokes the test runner';
  const flagsOf = (s) => new Set((s.match(NARROW_FLAGS_ALL) || []).map((x) => x.trim()));
  const fb = flagsOf(b);
  const added = [...flagsOf(a)].filter((x) => !fb.has(x));
  if (added.length) return `adds ${added.join(', ')}`;
  const pathTok = (s) => new Set(s.split(/\s+/).filter((t) => TEST_PATH_TOKEN.test(t)));
  const pb = pathTok(b);
  const pa = [...pathTok(a)].filter((t) => !pb.has(t));
  if (pa.length && TEST_COMMAND.test(a)) return `restricts the run to ${pa.slice(0, 3).join(', ')}`;
  return null;
}

const MAKE_LIKE = /^(?:makefile|gnumakefile|.+\.mk|justfile|\.justfile|taskfile\.ya?ml)$/;
const CONFTEST_HOOK = new RegExp(String.raw`\b(?:collect_ignore(?:_glob)?|pytest_collection_modifyitems|`
  + String.raw`pytest_ignore_collect|pytest_collect_file|pytest_deselected|items\.remove|deselect)\b`);
const GRADLE_TEST_PARENT = /^(?:test|tests|tasks\.test|tasks\.named|withType|retry|filter|useJUnitPlatform)$/i;
const GRADLE_TEST_LINE = /\btest\s*\{|tasks\.test|withType\s*\(\s*Test|named\s*\(\s*["']test/;
const GRADLE_SETTING = new RegExp(String.raw`\b(?:exclude|include|excludeTestsMatching|includeTestsMatching|enabled|`
  + String.raw`ignoreFailures|onlyIf|maxRetries)\b`);
const POM_PROPERTY = /^(?:skiptests|maven\.test\.skip|skipits|maven\.test\.failure\.ignore|surefire\.\w+)$/i;
const MSBUILD_TEST_SETTING = new RegExp(String.raw`<Compile\s+Remove=|<IsTestProject>|<ExcludeFromCodeCoverage|`
  + String.raw`<VSTestTestCaseFilter|<TestCaseFilter`, 'i');

/** Is a changed line in this runner config relevant to test discovery or failure handling? */
function relevantCfgKey(file, lines, idx) {
  const base = path.posix.basename(file).toLowerCase();
  const { keys, section } = keyPath(lines, idx);
  // keys[0] is the line's own key only when the line has one (Groovy `exclude '...'` has none).
  const hasOwn = Boolean(keyOf(lines[idx] || ''));
  const parents = hasOwn ? keys.slice(1) : keys;
  const own = hasOwn ? keys[0]?.toLowerCase() : undefined;
  const sec = (section || '').toLowerCase();
  const known = (k) => TEST_CFG_KEYS.has(k.toLowerCase()) || TEST_CFG_KEYS.has(k.toLowerCase().split('.').pop());
  const hit = (list) => list.find(known) || null;
  if (base === 'pyproject.toml') return /^tool\.(?:pytest|coverage|tox|nox)/.test(sec) ? hit(keys) : null;
  if (base === 'setup.cfg' || base === 'tox.ini') {
    return /^(?:tool:pytest|pytest|coverage:|testenv|tox)/.test(sec) ? hit(keys) : null;
  }
  if (base === 'pytest.ini') return sec === 'pytest' ? hit(keys) : null;
  if (base === 'cargo.toml') {
    // A [[test]] target is one setting: report the section once, not each of its keys.
    if (sec === 'test') return '[[test]]';
    if (!/^(?:lib|bin|package)$/.test(sec)) return null;
    return ['test', 'harness', 'autotests', 'autobins'].includes(own) ? own : null;
  }
  if (/\.(?:cs|fs|vb)proj$|^directory\.build\.(?:props|targets)$/.test(base)) {
    return MSBUILD_TEST_SETTING.test(lines[idx]) ? own || 'Compile' : null;
  }
  if (base === 'pom.xml') {
    const inRunner = /surefire|failsafe/.test(enclosingBlock(lines, idx, 'plugin'));
    const inProps = parents.some((k) => k.toLowerCase() === 'properties');
    if (inProps) return POM_PROPERTY.test(own || '') ? own : null;
    return inRunner ? hit(keys) : null;
  }
  if (base === 'build.gradle' || base === 'build.gradle.kts') {
    const inTest = parents.some((k) => GRADLE_TEST_PARENT.test(k)) || GRADLE_TEST_LINE.test(lines[idx]);
    if (!inTest) return null;
    return hit(keys) || (GRADLE_SETTING.exec(lines[idx])?.[0] ?? null);
  }
  if (/^vite\.config\./.test(base)) return parents.some((k) => k === 'test') ? (hit(keys) || 'test') : null;
  if (/^(?:makefile|gnumakefile|.+\.mk|justfile|\.justfile)$/.test(base)) {
    for (let j = idx; j >= 0; j--) {
      const m = /^([A-Za-z0-9_.%/-]+)\s*:(?!=)/.exec(lines[j]);
      if (m && !/^\s/.test(lines[j])) return /^(?:test|check|ci|unit|integration|e2e)/i.test(m[1]) ? m[1] : null;
      const v = /^([A-Z_]*TEST[A-Z_]*)\s*[:?+]?=/.exec(lines[j]);
      if (v && j === idx) return v[1];
    }
    return null;
  }
  if (base === 'taskfile.yml' || base === 'taskfile.yaml') return keys.find((k) => /^test/i.test(k)) || null;
  if (base === 'codecov.yml' || base === '.codecov.yml') return hit(keys);
  if (base === '.rspec') return '.rspec';
  if (base === 'rakefile') return /test|spec/i.test(lines[idx]) ? 'task' : null;
  if (base === 'conftest.py') return CONFTEST_HOOK.test(lines[idx]) ? 'collection hook' : null;
  if (/^deno\.jsonc?$/.test(base)) return parents.includes('test') || own === 'test' ? 'test' : null;
  // Dedicated runner configs: jest, vitest, playwright, cypress, mocha, karma, ava, nyc, c8, nextest, runsettings,
  // phpunit.
  return hit(keys);
}

const keyList = (...words) => new RegExp(`^(?:${words.join('|')})$`, 'i');
// Settings that hide tests or failures (as opposed to, say, a reporter or a timeout).
const MASKING_KEYS = keyList('testpathignorepatterns', 'modulepathignorepatterns', 'exclude', 'excludes', 'testignore',
  'ignore', 'collect_ignore', 'collect_ignore_glob', 'norecursedirs', 'collection hook', 'testexcludes',
  'excludetestsmatching', 'skiptests', 'skip', 'skipits', String.raw`maven\.test\.skip`, 'testfailureignore',
  'ignorefailures', 'grepinvert', 'exclude-pattern', 'excludespecpattern', 'excludedgroups', 'excludetags', 'autotests',
  'harness', 'compile', 'retries', 'retry', 'reruns', 'passwithnotests', String.raw`\[\[test\]\]`);
// Coverage thresholds: lowering or removing one fails, raising one is a finding.
const THRESHOLD_KEYS = keyList('coveragethreshold', 'thresholds', 'branches', 'functions', 'lines', 'statements',
  'fail_under', 'target', 'threshold', 'minimum_coverage');
// Tuning and coverage-scope settings change how tests run or are measured, not which ones run.
const SOFT_CFG_KEYS = keyList('bail', 'testtimeout', 'timeout', 'shard', 'test-threads', 'fail-fast', 'maxworkers',
  'workers', 'slow', 'collectcoveragefrom', 'coveragepathignorepatterns', 'omit', 'exclude_lines', 'exclude_also',
  'source', 'per-file');
// Settings whose value is a command line or runner flags: judged with narrowsCommand.
const COMMAND_KEYS = keyList('addopts', 'commands', 'cmds', 'cmd', 'script', 'run');

/** Severity of one changed runner setting: { severity, why }. */
function settingSeverity(key, before, after, base) {
  if (COMMAND_KEYS.test(key) || MAKE_LIKE.test(base)) {
    // Command lines and runner flags: only a narrowing, masking or lowered threshold fails.
    const reason = narrowsCommand(before, after) || (thresholdLowered(before, after) ? 'lowers a threshold' : null);
    return reason ? { severity: 'fail', why: ` (${reason})` } : { severity: after ? 'finding' : 'fail', why: '' };
  }
  if (THRESHOLD_KEYS.test(key)) {
    if (!after) return { severity: 'fail', why: ' (threshold removed)' };
    return thresholdLowered(before, after) ? { severity: 'fail', why: ' (threshold lowered)' }
      : { severity: 'finding', why: '' };
  }
  if (SOFT_CFG_KEYS.test(key)) return { severity: 'finding', why: '' };
  return { severity: 'fail', why: '' };
}

// Exclusions that only name dependency, build or cache folders are routine, not tampering.
const CONVENTIONAL_DIR = new RegExp(String.raw`^(?:<rootdir>\/?)?\/?\.?(?:node_modules|dist|build|out|coverage|\.?venv|`
  + String.raw`env|vendor|target|\.git|\.next|\.nuxt|__pycache__|\.tox|\.nox|\.cache|\.pytest_cache|\.mypy_cache|`
  + String.raw`site-packages|bower_components|tmp|temp)(?:\/[*]{0,2})?\/?$`, 'i');
function benignExclusion(text) {
  const value = String(text).replace(/^[^:=]*[:=]/, '');
  const tokens = value.split(/[\s,[\]()'"`]+/).map((t) => t.replace(/^\*\*\//, '').replace(/\/\*\*$/, ''))
    .filter(Boolean);
  return tokens.length > 0 && tokens.every((t) => CONVENTIONAL_DIR.test(t));
}

/** Number of base test files under the directory a runner config governs. */
function governedBaseTests(S, file) {
  const dir = path.posix.dirname(file);
  const under = [...S.baseFiles()].filter((p) => (dir === '.' || p.startsWith(`${dir}/`)) && M.isCodeFile(p));
  // Rust files are classified by content: read them in one batch.
  S.prefetch(under.filter((p) => p.endsWith('.rs')).map((p) => [S.from, p]));
  return under.filter((p) => S.isTest(p, 'base')).length;
}

const THRESHOLD_ALL = new RegExp(M.THRESHOLD.source, 'g');
function thresholdLowered(before, after) {
  const name = (m) => m[1].replace(/\s+/g, '');
  const b = new Map([...String(before).matchAll(THRESHOLD_ALL)].map((m) => [name(m), Number(m[2])]));
  return [...String(after).matchAll(THRESHOLD_ALL)].some((m) => b.has(name(m)) && Number(m[2]) < b.get(name(m)));
}

function checkTestConfig(S) {
  let touched = 0;
  let ciChanges = 0;
  for (const f of S.files) {
    const file = f.status === 'D' ? f.old_path : f.path;
    const base = path.posix.basename(file).toLowerCase();
    const cls = M.classifyPath(file);
    if (!cls.runnerConfig && !cls.ci) continue;
    if (cls.ci) { ciChanges += ciTestCommands(S, f); continue; }
    if (base === 'package.json') { packageJsonTestConfig(S, f); continue; }
    const headL = f.status === 'D' ? [] : sideLines(S, f, 'head');
    const baseL = f.status === 'A' ? [] : sideLines(S, f, 'base');
    const groups = new Map();
    const collect = (lines, list, side) => {
      for (const x of list) {
        const key = relevantCfgKey(file, lines, x.line - 1);
        if (!key) continue;
        const g = groups.get(key) || { key, added: [], removed: [] };
        g[side].push(x);
        groups.set(key, g);
      }
    };
    collect(headL, f.added, 'added');
    collect(baseL, f.removed, 'removed');
    if (f.status === 'D') {
      for (let i = 0; i < baseL.length; i++) {
        const key = relevantCfgKey(file, baseL, i);
        if (key && !groups.has(key)) groups.set(key, { key, added: [], removed: [{ line: i + 1, text: baseL[i] }] });
      }
    }
    if (!groups.size) continue;
    touched++;
    const keys = [...groups.keys()];
    if (f.status === 'A') {
      // A new config that narrows or masks tests which already exist under it is tampering.
      const masking = keys.filter((k) => {
        const g = groups.get(k);
        if (COMMAND_KEYS.test(k)) return g.added.some((x) => narrowsCommand('', x.text));
        return MASKING_KEYS.test(k) && !g.added.every((x) => benignExclusion(x.text));
      });
      const governed = masking.length ? governedBaseTests(S, file) : 0;
      const first = groups.get(masking[0] || keys[0]).added[0];
      if (governed) {
        S.add('CK-TEST-CFG', 'fail', file, first?.line ?? null, `new runner configuration ${file} sets `
          + `${masking.slice(0, 6).join(', ')}, narrowing or masking ${governed} existing test file(s) it governs`,
        first?.text || '');
      } else {
        S.add('CK-TEST-CFG', 'finding', file, first?.line ?? null, `new runner configuration ${file} sets `
          + `${keys.slice(0, 6).join(', ')}; confirm it does not narrow test discovery or enable retries`,
        first?.text || '');
      }
      continue;
    }
    if (f.status === 'D') {
      S.add('CK-TEST-CFG', 'fail', file, null,
        `runner configuration deleted: ${file} (it set ${keys.slice(0, 6).join(', ')})`, '');
      continue;
    }
    for (const g of groups.values()) {
      // Pure re-formatting of the same setting is not a change.
      const a = g.added.map((x) => norm(x.text)).sort().join('\n');
      const r = g.removed.map((x) => norm(x.text)).sort().join('\n');
      if (a === r) continue;
      const first = g.added[0] || g.removed[0];
      const before = g.removed.map((x) => norm(x.text)).join(' ');
      const after = g.added.map((x) => norm(x.text)).join(' ');
      let { severity, why } = settingSeverity(g.key, before, after, base);
      const benign = !g.removed.length && g.added.every((x) => benignExclusion(x.text));
      if (benign && MASKING_KEYS.test(g.key)) severity = 'finding';
      S.add('CK-TEST-CFG', severity, file, g.added[0]?.line ?? null, `test runner setting "${g.key}" changed in ${file}`
        + `${before ? `: "${clip(S, before, 80)}"` : ''}${after ? ` -> "${clip(S, after, 80)}"` : ' (removed)'}${why}`,
      first.text, { side: g.added[0] ? 'head' : 'base' });
    }
  }
  S.summaries['CK-TEST-CFG'] = `${touched} runner configuration file(s) with discovery or failure-handling changes; `
    + `${ciChanges} CI test command change(s)`;
}

const PACKAGE_RUNNER_KEYS = ['jest', 'mocha', 'ava', 'c8', 'nyc', 'vitest'];

function packageJsonTestConfig(S, f) {
  const file = f.status === 'D' ? f.old_path : f.path;
  const parse = (t) => { try { return JSON.parse(t); } catch { return null; } };
  const before = f.status === 'A' ? {} : parse(S.read(S.from, f.old_path) ?? '') || {};
  const after = f.status === 'D' ? {} : parse(S.read(S.to, f.path) ?? '') || {};
  const lineOf = (needle) => {
    const lines = f.status === 'D' ? [] : S.headLines(f.path) || [];
    const i = lines.findIndex((l) => l.includes(`"${needle}"`));
    return i === -1 ? null : i + 1;
  };
  const scripts = new Set([...Object.keys(before.scripts || {}), ...Object.keys(after.scripts || {})]
    .filter((k) => /^(?:pre|post)?test(?:[:-]|$)/.test(k)));
  for (const k of scripts) {
    const b = before.scripts?.[k];
    const a = after.scripts?.[k];
    if (b === a) continue;
    if (b == null) {
      const why = NARROW_FLAGS.test(a) ? ' and it hides failures or narrows the run' : '';
      S.add('CK-TEST-CFG', f.status === 'A' || !why ? 'finding' : 'fail', file, lineOf(k),
        `test script "${k}" added: "${clip(S, a, 100)}"${why}`, a);
      continue;
    }
    if (a == null) {
      S.add('CK-TEST-CFG', 'fail', file, null, `test script "${k}" removed (was "${clip(S, b, 100)}")`, b,
        { side: 'base' });
      continue;
    }
    const why = narrowsCommand(b, a);
    S.add('CK-TEST-CFG', why ? 'fail' : 'finding', file, lineOf(k),
      `test script "${k}" changed: "${clip(S, b, 80)}" -> "${clip(S, a, 80)}"${why ? ` (${why})` : ''}`, a);
  }
  for (const k of PACKAGE_RUNNER_KEYS) {
    const b = JSON.stringify(before[k] ?? null);
    const a = JSON.stringify(after[k] ?? null);
    if (a === b || (before[k] == null && f.status === 'A')) continue;
    const value = (obj, x) => (obj[k]?.[x] == null ? '' : JSON.stringify(obj[k][x]));
    const changedKeys = new Set([...Object.keys(before[k] || {}), ...Object.keys(after[k] || {})]
      .filter((x) => JSON.stringify(before[k]?.[x]) !== JSON.stringify(after[k]?.[x])));
    const relevant = [...changedKeys].filter((x) => TEST_CFG_KEYS.has(x.toLowerCase()));
    if (!relevant.length && before[k] != null && after[k] != null) continue;
    const masks = relevant.some((x) => MASKING_KEYS.test(x) && !benignExclusion(JSON.stringify(after[k]?.[x] ?? '')));
    const judged = relevant
      .map((x) => settingSeverity(x, value(before, x) || '""', value(after, x), 'package.json').severity);
    const severity = before[k] == null ? (masks && governedBaseTests(S, file) ? 'fail' : 'finding')
      : after[k] == null || !relevant.length || judged.includes('fail') ? 'fail' : 'finding';
    const what = relevant.length ? ` (${relevant.join(', ')})` : before[k] == null ? ' (added)' : ' (removed)';
    S.add('CK-TEST-CFG', severity, file, lineOf(k), `"${k}" configuration in package.json changed${what}`,
      clip(S, a, 160));
  }
}

const CI_STEP_PREFIX = new RegExp(String.raw`^\s*-?\s*(?:(?:run|script|command|cmd|commands|inlineScript|bash|pwsh|`
  + String.raw`powershell|sh)\s*:\s*)?(?:[|>][-+]?\s*)?`);

/** A CI line reduced to its command: YAML keys (`- run:`, `script:`), list dashes and block markers removed. */
export function ciCommand(text) {
  return norm(String(text ?? '').replace(CI_STEP_PREFIX, ''));
}
const withoutThresholds = (t) => ciCommand(t).replace(THRESHOLD_ALL, (m, k) => k);

/** CI files: changed test commands go to CK-TEST-CFG (CK-CI handles weakening and removals). */
function ciTestCommands(S, f) {
  if (f.status !== 'M' && f.status !== 'R') return 0;
  let n = 0;
  const removed = f.removed.filter((x) => TEST_COMMAND.test(x.text));
  const added = f.added.filter((x) => TEST_COMMAND.test(x.text));
  const pairs = Math.min(removed.length, added.length);
  const unmatchedRemoved = multisetSubtract(removed, added, (x) => ciCommand(x.text));
  const unmatchedAdded = multisetSubtract(added, removed, (x) => ciCommand(x.text));
  for (let i = 0; i < Math.min(pairs, unmatchedRemoved.length, unmatchedAdded.length); i++) {
    const b = unmatchedRemoved[i].text;
    const a = unmatchedAdded[i].text;
    // Failure-masking edits (|| true, --passWithNoTests, ...) and lowered thresholds are CK-CI's: report each
    // edit once.
    if (M.scanText([a], M.CI_WEAKENING).length || withoutThresholds(a) === withoutThresholds(b)) continue;
    const why = narrowsCommand(ciCommand(b), ciCommand(a));
    n++;
    S.add('CK-TEST-CFG', why ? 'fail' : 'finding', f.path, unmatchedAdded[i].line,
      `CI test command changed: "${clip(S, ciCommand(b), 80)}" -> "${clip(S, ciCommand(a), 80)}"`
        + `${why ? ` (${why})` : ''}`, a);
  }
  return n;
}

// ---------------------------------------------------------------------------
// CK-SUPPRESS: new suppression directives (ratchet) and rules turned off in lint config

const LINT_SECTION_FILES = {
  'pyproject.toml': /^tool\.(?:ruff|mypy|pylint|pyright|flake8|black|isort|bandit|pydocstyle)\b/,
  'setup.cfg': /^(?:flake8|mypy|pylint|pycodestyle|pydocstyle|isort|tool:isort|mypy-.*)$/,
  'tox.ini': /^(?:flake8|pycodestyle|pydocstyle)$/,
  'cargo.toml': /^(?:workspace\.)?lints(?:\.\w+)?$/,
};
const MSBUILD_FILE = /^directory\.build\.(?:props|targets)$|\.(?:cs|fs|vb)proj$/;
const BARE_LIST_ITEM = /^\s*(?:-\s+)?["']?[\w@./*:-]+["']?\s*,?\s*$/;

/** For a lint/type config (or a manifest with lint sections): `inScope(lines, x)` for its lint lines; else null. */
function lintScopeOf(f) {
  const base = path.posix.basename(f.path).toLowerCase();
  const whole = f.class.lintConfig || MSBUILD_FILE.test(base);
  const sectionRe = LINT_SECTION_FILES[base];
  const isPkg = base === 'package.json';
  if (!whole && !sectionRe && !isPkg) return null;
  return (lines, x) => {
    if (whole) return true;
    const { keys, section } = keyPath(lines, x.line - 1);
    if (sectionRe) return sectionRe.test((section || '').toLowerCase());
    return keys.some((k) => k === 'eslintConfig' || k === 'rules' || k === 'stylelint');
  };
}

const LEVEL_NAMES = { 2: 'error', 1: 'warn', 0: 'off' };
const ruleLevel = (t) => {
  const m = /["']?([@\w/-]+)["']?\s*[:=]\s*\[?\s*(?:["'](error|warn|warning)["']|([0-2])\b)/.exec(t);
  return m && { rule: m[1], level: m[2] || LEVEL_NAMES[m[3]] };
};

function lintConfigChanges(S, f) {
  const file = f.path;
  const inScope = lintScopeOf(f);
  if (!inScope) return 0;
  const headL = sideLines(S, f, 'head');
  const baseL = f.status === 'A' ? [] : sideLines(S, f, 'base');
  let n = 0;
  const severity = f.status === 'A' ? 'finding' : 'fail';
  const hits = (lines, list) => M.scanText(lines, M.LINT_CONFIG_WEAKENING, { lines: lineSet(list) })
    .filter((h) => inScope(lines, h));
  const fresh = multisetSubtract(hits(headL, f.added), hits(baseL, f.removed), (h) => `${h.id}|${norm(h.text)}`);
  for (const h of fresh) {
    if (h.id === 'lintcfg.ignore-list') {
      S.add('CK-SUPPRESS', 'finding', file, h.line, `lint ignore/disable list changed in ${file}; check which rules or `
        + 'files it now skips', h.text, { rule: h.id });
    } else {
      const what = f.status === 'A' ? 'new lint configuration turns a check off'
        : 'lint/type rule turned off repo-wide';
      S.add('CK-SUPPRESS', severity, file, h.line, `${what} in ${file}`, h.text, { rule: h.id, scope: 'config' });
    }
    n++;
  }
  // Items added under an exclusion list (YAML/TOML/JSON lists whose parent key is ignore/disable/exclude...).
  const freshLines = new Set(fresh.map((h) => h.line));
  const removedTexts = new Set(f.removed.map((r) => norm(r.text)));
  for (const x of f.added) {
    if (!BARE_LIST_ITEM.test(x.text) || freshLines.has(x.line) || removedTexts.has(norm(x.text))) continue;
    if (!inScope(headL, x)) continue;
    const { keys } = keyPath(headL, x.line - 1);
    const parent = keys[keys[0] && keyOf(headL[x.line - 1] || '') ? 1 : 0];
    if (!parent || !M.LINT_EXCLUSION_KEYS.test(parent)) continue;
    S.add('CK-SUPPRESS', parent.toLowerCase().startsWith('disable') ? severity : 'finding', file, x.line,
      `"${norm(x.text).replace(/^-\s*/, '')}" added to ${parent} in ${file}`, x.text, { rule: 'lintcfg.list-item' });
    n++;
  }
  // Error -> warning downgrades of a rule ("error"/2 -> "warn"/1).
  const removedLevels = new Map(f.removed.map((x) => ruleLevel(x.text)).filter(Boolean).map((r) => [r.rule, r.level]));
  if (!removedLevels.size) return n;
  for (const x of f.added) {
    const r = ruleLevel(x.text);
    if (r && removedLevels.get(r.rule) === 'error' && /^warn/.test(r.level)) {
      S.add('CK-SUPPRESS', 'finding', file, x.line, `rule "${r.rule}" downgraded from error to warning in ${file}`,
        x.text, { rule: 'lintcfg.downgrade' });
      n++;
    }
  }
  return n;
}

const IGNORE_FILE = /^\.(?:eslint|stylelint|markdownlint|semgrep|gitleaks)ignore$/;
const listItems = (t) => [...String(t).matchAll(/["']([^"'\s,]+)["']/g)].map((m) => m[1]);
const bareItem = (t) => norm(t).replace(/^-\s*/, '').replace(/,$/, '').replace(/^["']|["']$/g, '');
const ownKey = (t) => /^\s*(?:-\s+)?["']?([\w$@./-]+)["']?\s*[:=]/.exec(t)?.[1]
  ?? /^\s*<([\w.:-]+)>/.exec(t)?.[1] ?? null;

/**
 * Lint configuration that loses checks without an "off" value: entries added to ignore files and
 * scanner allowlists, strictness settings removed, rules or linters removed from enable lists, and
 * deleted lint configurations. A setting moved to another lint file in the same change is not lost.
 */
function lintConfigRemovals(S) {
  let n = 0;
  const addedAnywhere = new Set();
  for (const f of S.files) {
    if (f.status !== 'D' && lintScopeOf(f)) for (const x of f.added) addedAnywhere.add(norm(x.text).replace(/,$/, ''));
  }
  for (const f of S.files) {
    const inScope = lintScopeOf(f);
    if (!inScope || f.binary) continue;
    const file = f.status === 'D' ? f.old_path : f.path;
    const base = path.posix.basename(file).toLowerCase();
    if (IGNORE_FILE.test(base)) {
      if (f.status === 'D') continue;
      const before = new Set(f.removed.map((x) => norm(x.text)));
      for (const x of f.added) {
        const t = x.text.trim();
        if (!t || t.startsWith('#') || t.startsWith('!') || before.has(norm(t)) || benignExclusion(`x=${t}`)) continue;
        const message = base === '.gitleaksignore' ? `secret-scanner ignore entry added to ${file}`
          : `"${t}" added to ${file}; the tool no longer checks it`;
        S.add('CK-SUPPRESS', 'finding', file, x.line, message, t, { rule: 'lintcfg.ignore-file' });
        n++;
      }
      continue;
    }
    if (base === '.gitleaks.toml' && f.status !== 'D') {
      const headL = sideLines(S, f, 'head');
      for (const x of f.added) {
        if (!x.text.trim() || /^\s*#/.test(x.text)) continue;
        if (!/allowlist/i.test(keyPath(headL, x.line - 1).section || '')) continue;
        S.add('CK-SUPPRESS', 'finding', file, x.line, `secret-scanner allowlist extended in ${file}`, x.text,
          { rule: 'lintcfg.secret-allowlist' });
        n++;
      }
    }
    if (f.status === 'A') continue;
    const baseL = sideLines(S, f, 'base');
    const removed = f.status === 'D' ? baseL.map((text, i) => ({ line: i + 1, text })) : f.removed;
    if (!removed.length) continue;
    const addedKeys = new Set(f.added.map((x) => ownKey(x.text)).filter(Boolean));
    const addsExtends = addedKeys.has('extends');
    const strict = M.scanText(baseL, M.STRICTNESS_ON, { lines: lineSet(removed) }).filter((h) => inScope(baseL, h));
    for (const h of strict) {
      // A new value for the same key is judged by the added-line rules (`"strict": false` fails there).
      if (addedAnywhere.has(norm(h.text).replace(/,$/, '')) || addedKeys.has(ownKey(h.text))) continue;
      S.add('CK-SUPPRESS', addsExtends ? 'finding' : 'fail', file, h.line, `strictness setting removed from ${file}; `
        + `the check falls back to its laxer default${addsExtends ? ' (a new "extends" may restore it)' : ''}`,
      h.text, { rule: 'lintcfg.strictness-removed', scope: 'config', side: 'base' });
      n++;
    }
    for (const x of removed) {
      if (!inScope(baseL, x)) continue;
      const own = ownKey(x.text);
      if (own && M.LINT_ENABLE_KEYS.test(own)) {
        const valueOf = (t) => t.slice(t.indexOf(own) + own.length);
        const before = listItems(valueOf(x.text));
        if (!before.length) continue;
        const after = new Set(f.added.filter((a) => ownKey(a.text) === own).flatMap((a) => listItems(valueOf(a.text))));
        const gone = before.filter((i) => !after.has(i) && !addedAnywhere.has(i));
        if (!gone.length) continue;
        S.add('CK-SUPPRESS', 'finding', file, x.line, `${gone.length} ${plural(gone.length, 'item')} removed from `
          + `"${own}" in ${file}: ${gone.slice(0, 6).join(', ')}`, x.text,
        { rule: 'lintcfg.enable-removed', side: 'base' });
        n++;
      } else if (!own && BARE_LIST_ITEM.test(x.text)) {
        const parent = keyPath(baseL, x.line - 1).keys[0];
        if (!parent || !M.LINT_ENABLE_KEYS.test(parent)) continue;
        const item = bareItem(x.text);
        if (f.added.some((a) => bareItem(a.text) === item)) continue;
        S.add('CK-SUPPRESS', 'finding', file, x.line, `"${item}" removed from ${parent} in ${file}`, x.text,
          { rule: 'lintcfg.enable-removed', side: 'base' });
        n++;
      }
    }
    if (f.status === 'D' && f.class.lintConfig) {
      S.add('CK-SUPPRESS', 'finding', file, null, `lint/type configuration deleted: ${file}`, '',
        { rule: 'lintcfg.deleted', side: 'base' });
      n++;
    }
  }
  return n;
}

// Manifests and build files that may hold lint settings (judged by lintScopeOf).
const LINT_SECTION_BASE = new RegExp(String.raw`^(?:pyproject\.toml|setup\.cfg|tox\.ini|cargo\.toml|package\.json|`
  + String.raw`directory\.build\.(?:props|targets))$|\.(?:cs|fs|vb)proj$`, 'i');

function checkSuppressions(S) {
  let added = 0;
  let removed = 0;
  let configChanges = 0;
  for (const f of S.files) {
    if (f.status === 'D' || f.binary) continue;
    if (f.class.lintConfig || LINT_SECTION_BASE.test(path.posix.basename(f.path))) {
      configChanges += lintConfigChanges(S, f);
    }
    if (!f.lang) continue;
    const hits = newHits(S, f, M.SUPPRESSIONS);
    const baseL = f.old_path && f.removed.length ? sideLines(S, f, 'base') : null;
    removed += baseL ? M.scanText(baseL, M.SUPPRESSIONS, { file: f.old_path, lines: lineSet(f.removed) }).length : 0;
    added += M.scanText(sideLines(S, f, 'head'), M.SUPPRESSIONS, { file: f.path, lines: lineSet(f.added) }).length;
    for (const h of hits) {
      S.add('CK-SUPPRESS', 'finding', f.path, h.line,
        `${h.scope === 'file' ? 'file-wide ' : ''}suppression directive added`, h.text,
        { rule: h.id, ...(h.scope ? { scope: h.scope } : {}) });
    }
  }
  configChanges += lintConfigRemovals(S);
  S.counts.suppressions = { added_lines: added, removed_lines: removed, net: added - removed,
    config_changes: configChanges, scope: 'added/removed lines (unchanged lines are equal on both sides)' };
  S.summaries['CK-SUPPRESS'] = `suppressions on changed lines: +${added} / -${removed} (net ${added - removed}); `
    + `${configChanges} lint-config weakening(s)`;
}

// ---------------------------------------------------------------------------
// CK-CI: CI edits that weaken existing test steps

// Steps whose failure a CI weakening hides: test runners plus lint, type, build and scan steps.
const CHECK_COMMAND = new RegExp(String.raw`\b(?:eslint|tsc|biome|oxlint|prettier\s+--check|ruff|mypy|pyright|flake8|`
  + String.raw`pylint|black\s+--check|golangci-lint|go\s+(?:vet|build)|staticcheck|`
  + String.raw`cargo\s+(?:clippy|check|build|fmt\s+--check|audit|deny)|dotnet\s+(?:build|format)|mvnw?|gradlew?|`
  + String.raw`(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:lint|typecheck|type-check|check|build|audit)|make|gitleaks|`
  + String.raw`trufflehog|semgrep|codeql|pip-audit|diff-cover|coverage\s+report)\b|`
  + String.raw`\buses:\s*\S*(?:test|cypress|playwright|lint|gitleaks|codeql|golangci)`, 'i');
// Weakenings that only make sense on a test step.
const TEST_ONLY_RULES = new Set(['ci.pass-with-no-tests', 'ci.skip-tests', 'ci.ignore-test-failures']);
const GATING_EVENTS = ['push', 'pull_request', 'pull_request_target', 'merge_group'];
const ON_KEY = /^["']?on["']?\s*:/;

/** Text of the YAML list item or mapping that line `idx` belongs to (a step, or a job for job-level keys). */
export function ciBlock(lines, idx) {
  const own = indentOf(lines[idx] || '');
  let start = -1;
  if (/^\s*-\s/.test(lines[idx] || '')) start = idx;
  else {
    for (let j = idx - 1; j >= 0; j--) {
      const l = lines[j];
      if (!l.trim() || /^\s*#/.test(l)) continue;
      if (indentOf(l) < own) { start = j; break; }
    }
  }
  if (start === -1) return lines.join('\n');
  const startInd = indentOf(lines[start]);
  let end = lines.length - 1;
  for (let j = start + 1; j < lines.length; j++) {
    const l = lines[j];
    if (!l.trim() || /^\s*#/.test(l)) continue;
    if (indentOf(l) <= startInd) { end = j - 1; break; }
  }
  return lines.slice(start, end + 1).join('\n');
}

/** Events a GitHub Actions workflow runs on (the `on:` key), or null when it has none. */
export function workflowEvents(lines) {
  const i = lines.findIndex((l) => ON_KEY.test(l));
  if (i === -1) return null;
  const out = new Set();
  const inline = lines[i].replace(/^["']?on["']?\s*:\s*/, '').replace(/\s+#.*$/, '').trim();
  if (inline.startsWith('{')) {
    for (const m of inline.matchAll(/([\w-]+)\s*:/g)) out.add(m[1]);
    return out;
  }
  if (inline) {
    for (const t of inline.replace(/^\[|\]$/g, '').split(',')) if (t.trim()) out.add(t.trim().replace(/["']/g, ''));
    return out;
  }
  let child = null;
  for (let j = i + 1; j < lines.length; j++) {
    const l = lines[j];
    if (!l.trim() || /^\s*#/.test(l)) continue;
    const ind = indentOf(l);
    if (ind === 0) break;
    if (child == null) child = ind;
    if (ind !== child) continue;
    const m = /^\s*(?:-\s*)?["']?([\w-]+)["']?/.exec(l);
    if (m) out.add(m[1]);
  }
  return out;
}

const generatedByCiGate = (lines) => M.CI_GATE_HEADER.test(lines.slice(0, 5).join('\n'));

function checkCi(S) {
  let files = 0;
  for (const f of S.files) {
    const oldCi = f.old_path && M.classifyPath(f.old_path).ci;
    const newCi = f.status !== 'D' && f.class.ci;
    if (!oldCi && !newCi) continue;
    files++;
    if (f.status === 'A') {
      const headL = sideLines(S, f, 'head');
      const weak = M.scanText(headL, M.CI_WEAKENING).length;
      S.add('CK-CI', 'finding', f.path, null, `new CI workflow ${f.path}`
        + `${generatedByCiGate(headL) ? ' (written by ci-gate)' : ''}`
        + `${weak ? `; it contains ${weak} failure-masking setting(s)` : ''}`, '');
      continue;
    }
    const baseL = sideLines(S, f, 'base');
    const baseTests = baseL.filter((l) => TEST_COMMAND.test(l)).length;
    if (f.status === 'D' || (oldCi && !newCi)) {
      const what = f.status === 'D' ? 'deleted' : `moved out of the CI directory (${f.path})`;
      S.add('CK-CI', baseTests ? 'fail' : 'finding', f.old_path, null,
        `CI workflow ${what}: ${f.old_path}${baseTests ? ` (${baseTests} test step line(s))` : ''}`, '');
      continue;
    }
    const headL = sideLines(S, f, 'head');
    const baseGenerated = generatedByCiGate(baseL);
    if (generatedByCiGate(headL) && !baseGenerated) {
      S.add('CK-CI', 'fail', f.path, 1, 'the ci-gate "generated" header was added to an existing workflow; that header '
        + 'downgrades CK-CI failures to findings', headL[0]);
    }
    const hardSeverity = baseGenerated ? 'finding' : 'fail';
    const addedHits = M.scanText(headL, M.CI_WEAKENING, { lines: lineSet(f.added) });
    const removedHits = M.scanText(baseL, M.CI_WEAKENING, { lines: lineSet(f.removed) });
    for (const h of multisetSubtract(addedHits, removedHits, (x) => `${x.id}|${norm(x.text)}`)) {
      // `|| true` on a cleanup step or an optional upload hides nothing the gate relies on.
      const block = ciBlock(headL, h.line - 1);
      const gating = TEST_ONLY_RULES.has(h.id) || TEST_COMMAND.test(block) || CHECK_COMMAND.test(block);
      S.add('CK-CI', h.severity || (gating ? hardSeverity : 'finding'), f.path, h.line,
        `CI change can turn a failing step green (${h.id.replace(/^ci\./, '')})`
          + `${gating ? '' : ' on a step that runs no test or check'}`, h.text, { rule: h.id });
    }
    // Triggers: a workflow that stops running on pushes or pull requests no longer gates them.
    if (/^\.github\/workflows\//.test(f.path)) {
      const before = workflowEvents(baseL);
      const after = workflowEvents(headL);
      const lost = before && after ? GATING_EVENTS.filter((e) => before.has(e) && !after.has(e)) : [];
      if (lost.length) {
        S.add('CK-CI', baseTests ? hardSeverity : 'finding', f.path, headL.findIndex((l) => ON_KEY.test(l)) + 1 || null,
          `workflow no longer runs on ${lost.join(', ')}`, `on: ${[...before].join(', ')} -> ${[...after].join(', ')}`,
          { rule: 'ci.trigger-removed' });
      }
    }
    // Test steps removed without a replacement.
    const removedTests = f.removed.filter((x) => TEST_COMMAND.test(x.text));
    const addedTests = f.added.filter((x) => TEST_COMMAND.test(x.text));
    if (removedTests.length > addedTests.length) {
      const first = multisetSubtract(removedTests, addedTests, (x) => ciCommand(x.text))[0] || removedTests[0];
      S.add('CK-CI', hardSeverity, f.path, null, `${removedTests.length - addedTests.length} test step(s) removed from `
        + f.path, first.text, { side: 'base', rule: 'ci.test-step-removed' });
    }
    // Lowered thresholds (same key, smaller number).
    const thresholds = (list) => list.map((x) => ({ x, m: M.THRESHOLD.exec(x.text) })).filter((t) => t.m);
    const before = thresholds(f.removed);
    for (const { x, m } of thresholds(f.added)) {
      const prev = before.find((b) => b.m[1].replace(/\s+/g, '') === m[1].replace(/\s+/g, ''));
      if (prev && Number(m[2]) < Number(prev.m[2])) {
        S.add('CK-CI', hardSeverity, f.path, x.line, `threshold lowered from ${prev.m[2]} to ${m[2]}`, x.text,
          { rule: 'ci.threshold-lowered' });
      }
    }
  }
  // Coverage/threshold configs outside CI (codecov.yml, .nycrc, jest coverageThreshold) are CK-TEST-CFG.
  S.summaries['CK-CI'] = `${files} CI file(s) changed`;
}

// ---------------------------------------------------------------------------
// CK-SWALLOW: swallowed errors and error -> warning downgrades in non-test code

/** Level rank of a logging call on a line and the call with its level blanked, or null. */
function logLevel(text) {
  const m = M.LOG_CALL.exec(text);
  if (!m) return null;
  const lvl = String(m[1] || m[2]).toLowerCase().replace(/^log/, '').replace(/f$/, '').replace(/information/, 'info');
  return { rank: M.LOG_LEVEL_RANK[lvl] ?? null, key: norm(text.replace(m[0], 'LOG(')) };
}

function checkSwallow(S) {
  let fresh = 0;
  for (const f of S.files) {
    if (f.status === 'D' || f.binary || !f.lang || f.class.generated) continue;
    const mixed = S.testRanges('head', f.path);
    if (S.isTest(f.path, 'head') && !mixed) continue;
    const prod = (h) => !mixed || !S.testLine('head', f.path, h.line);
    const seenLines = new Set();
    for (const h of newHits(S, f, M.SWALLOW_PATTERNS).filter(prod)) {
      if (seenLines.has(h.line)) continue;
      seenLines.add(h.line);
      fresh++;
      S.add('CK-SWALLOW', 'finding', f.path, h.line, /broad/.test(h.id)
        ? 'broad exception handler neither re-raises nor reports the error'
        : 'error swallowed: the failure is caught and dropped', h.text, { rule: h.id });
    }
    // An error-level log replaced by a lower level with the same text.
    const removedErr = f.removed.map((x) => logLevel(x.text)).filter((l) => l && l.rank === 3).map((l) => l.key);
    if (removedErr.length) {
      for (const x of f.added) {
        const l = logLevel(x.text);
        if (!l || l.rank == null || l.rank >= 3 || !prod(x) || !removedErr.includes(l.key)) continue;
        fresh++;
        S.add('CK-SWALLOW', 'finding', f.path, x.line, 'error log downgraded to a lower level', x.text,
          { rule: 'swallow.log-downgrade' });
      }
    }
    // A throw/raise replaced by a log call carrying the same message.
    const removedThrows = f.removed.filter((x) => M.THROW_LINE.test(x.text));
    const addedThrows = f.added.filter((x) => M.THROW_LINE.test(x.text));
    if (removedThrows.length <= addedThrows.length) continue;
    for (const t of removedThrows) {
      const lit = /(["'`])((?:\\.|(?!\1).){6,})\1/.exec(t.text)?.[2];
      const logged = lit && f.added.find((x) => M.LOG_CALL.test(x.text) && x.text.includes(lit) && prod(x));
      if (!logged) continue;
      fresh++;
      S.add('CK-SWALLOW', 'finding', f.path, logged.line, 'exception replaced by a log message; callers no longer see '
        + 'the failure', logged.text, { rule: 'swallow.throw-to-log' });
    }
  }
  S.summaries['CK-SWALLOW'] = `${fresh} swallowed error(s) or downgrade(s) added`;
}

// ---------------------------------------------------------------------------
// CK-SECRETS: gitleaks / trufflehog when installed, built-in regexes otherwise (D7)

/**
 * { name, exe?, missing? }: gitleaks, then trufflehog, then the built-in patterns; a forced scanner
 * that is absent says so.
 */
function selectScanner(env, forced) {
  const want = forced || env.ADC_SECRETS_SCANNER || 'auto';
  if (want === 'builtin') return { name: 'builtin' };
  for (const name of ['gitleaks', 'trufflehog']) {
    const exe = (want === 'auto' || want === name) && which(name, env);
    if (exe) return { name, exe };
  }
  if (want === 'auto') return { name: 'builtin' };
  const known = want === 'gitleaks' || want === 'trufflehog';
  return { name: 'builtin', missing: known ? `${want} is not installed` : `unknown scanner "${want}"` };
}

function runGitleaks(S, exe) {
  const report = path.join(ensureDir(tmpRoot(S.root)), `gitleaks-${nonce()}.json`);
  const range = S.target.base.sha ? `${S.from}..${S.to}` : S.to;
  const env = toolEnv(S.env);
  const v = parseVersion(runTool(exe, ['version'], { env, timeoutMs: 10_000 }).stdout);
  const common = ['--log-opts', range, '--redact', '--no-banner', '--report-format', 'json', '--report-path', report];
  // gitleaks 8.19 replaced `detect --source <dir>` with `git <dir>`.
  const args = !v || versionGte(v, '8.19.0') ? ['git', ...common, '--exit-code', '1', S.root]
    : ['detect', '--source', S.root, ...common, '--exit-code', '1'];
  const shown = `gitleaks ${args.filter((a) => a !== S.root && a !== report).join(' ')}`;
  const res = runTool(exe, args, { cwd: S.root, env, timeoutMs: 300_000 });
  try {
    if (res.exit !== 0 && res.exit !== 1) {
      const last = clip(S, (res.stderr || '').trim().split('\n').pop(), 160);
      const cmd = `gitleaks ${args.slice(0, 3).join(' ')}`;
      return { ok: false, error: `gitleaks exited ${res.exit}: ${last}`, cmd };
    }
    const items = JSON.parse(readText(report, '[]') || '[]').map((i) => ({
      id: `gitleaks.${i.RuleID}`, file: toPosix(i.File), line: i.StartLine, severity: 'fail',
      redacted: `${i.RuleID} (value redacted by gitleaks)`,
    }));
    return { ok: true, exit: res.exit, cmd: shown, items };
  } catch (err) {
    return { ok: false, error: `gitleaks report unreadable: ${err.message}` };
  } finally {
    fs.rmSync(report, { force: true });
  }
}

function runTrufflehog(S, exe, added) {
  const files = [...added.keys()].filter((p) => added.get(p).size && fs.existsSync(path.join(S.root, p)));
  if (!files.length) return { ok: true, exit: 0, items: [], cmd: 'trufflehog filesystem (no files)' };
  const args = ['filesystem', ...files.map((p) => path.join(S.root, p)), '--json', '--no-update', '--no-verification'];
  const res = runTool(exe, args, { cwd: S.root, env: toolEnv(S.env), timeoutMs: 300_000 });
  // 183 is trufflehog's "results found" exit code.
  if (res.exit !== 0 && res.exit !== 183) {
    return { ok: false, error: `trufflehog exited ${res.exit}`, cmd: 'trufflehog filesystem' };
  }
  const items = [];
  for (const j of parseJsonl(res.stdout)) {
    const meta = j.SourceMetadata?.Data?.Filesystem;
    if (!meta) continue;
    const file = toPosix(path.relative(S.root, meta.file));
    const line = Number(meta.line) || null;
    if (!added.get(file)?.has(line)) continue; // only secrets on added lines are this change's
    const detector = j.DetectorName || 'secret';
    items.push({ id: `trufflehog.${detector}`, file, line, severity: 'fail',
      redacted: `${detector} (value not recorded)` });
  }
  const cmd = 'trufflehog filesystem <changed files> --json --no-update --no-verification';
  return { ok: true, exit: res.exit, items, cmd };
}

/** The forms a pasted credential takes in source: raw, URL-encoded, base64 (padded, unpadded, URL-safe). */
function literalForms(value) {
  const b64 = Buffer.from(value).toString('base64');
  const b64url = Buffer.from(value).toString('base64url');
  return [...new Set([value, encodeURIComponent(value), b64, b64.replace(/=+$/, ''), b64url])];
}

function checkSecrets(S, { scanner = null } = {}) {
  const added = new Map(S.files.filter((f) => f.status !== 'D')
    .map((f) => [f.path, new Map(f.added.map((a) => [a.line, a.text]))]));
  const sel = selectScanner(S.env, scanner);
  let chosen = sel.name;
  if (sel.missing) S.data.scanner_error = sel.missing;
  const external = chosen === 'gitleaks' ? runGitleaks(S, sel.exe)
    : chosen === 'trufflehog' ? runTrufflehog(S, sel.exe, added) : null;
  if (external && !external.ok) { S.data.scanner_error = redactText(external.error, S.secrets); chosen = 'builtin'; }
  let count = 0;
  const label = (id) => id.replace(/^secret\./, '');
  if (chosen !== 'builtin') {
    for (const i of external.items) {
      count++;
      S.add('CK-SECRETS', 'fail', i.file, i.line, `secret detected by ${chosen} (${i.id.replace(/^\w+\./, '')})`,
        i.redacted, { rule: i.id });
    }
    S.data.scanner_command = external.cmd;
    S.data.scanner_exit = external.exit;
    // The external scanners know nothing of ADC_LIVE_TOKEN and skip lines carrying their own allow
    // directives (`gitleaks:allow`), so those lines still get the built-in patterns.
    const reported = new Set(external.items.map((i) => `${i.file}:${i.line}`));
    for (const f of S.files) {
      if (f.status === 'D' || f.binary) continue;
      for (const a of f.added) {
        const allowed = M.SECRET_ALLOW.test(a.text);
        for (const h of M.scanSecrets(a.text)) {
          if ((!allowed && h.id !== 'secret.adc-live-token') || reported.has(`${f.path}:${a.line}`)) continue;
          reported.add(`${f.path}:${a.line}`);
          count++;
          S.add('CK-SECRETS', h.severity, f.path, a.line, `possible secret (${label(h.id)}) added`
            + `${allowed ? ` behind an inline allow directive ${chosen} honors` : ''}`, h.redacted, { rule: h.id });
        }
      }
    }
  } else {
    for (const f of S.files) {
      if (f.status === 'D' || f.binary || !f.added.length) continue;
      for (const h of M.scanSecrets(f.added.map((a) => a.text).join('\n'))) {
        count++;
        S.add('CK-SECRETS', h.severity, f.path, f.added[h.line - 1]?.line ?? null,
          `possible secret (${label(h.id)}) added`, h.redacted, { rule: h.id });
      }
    }
  }
  // Live-test credentials by value: wherever they were pasted, they must not leave .adc/.
  for (const { name, value } of S.secrets.filter((s) => s.value.length >= 6)) {
    const forms = literalForms(value);
    for (const f of S.files) {
      for (const a of f.added) {
        if (!forms.some((v) => a.text.includes(v))) continue;
        count++;
        S.add('CK-SECRETS', 'fail', f.path, a.line, `the ${name} value appears in the change`, a.text,
          { rule: 'secret.adc-live-token-value' });
      }
    }
  }
  for (const f of S.files) {
    const kind = (f.status === 'A' || f.status === 'R') && M.credentialFileName(f.path);
    if (!kind) continue;
    count++;
    S.add('CK-SECRETS', 'finding', f.path, null, `credential-like file added (${kind}): ${f.path}`, '',
      { rule: `secret.file.${kind}` });
  }
  S.data.scanner = chosen;
  S.summaries['CK-SECRETS'] = `${count} possible secret(s) on added lines (scanner: ${chosen}`
    + `${S.data.scanner_error ? `; ${S.data.scanner_error}, fell back to built-in` : ''})`;
}

// ---------------------------------------------------------------------------
// CK-LOCK (static): manifest dependency changes paired with lockfile changes

const CONFLICT_MARKER = /^(?:<{7}|={7}|>{7})(?: |$)/m;

function checkLockStatic(S) {
  const changed = new Set(S.files.map((f) => f.path));
  const handledLocks = new Set();
  let pairs = 0;
  for (const f of S.files) {
    if (f.status !== 'D' && f.class.lockfile && CONFLICT_MARKER.test(S.read(S.to, f.path) || '')) {
      S.add('CK-LOCK', 'fail', f.path, null, `merge-conflict markers in ${f.path}`, '',
        { rule: 'lock.conflict-markers' });
    }
    if (f.status === 'D' && f.old_path && M.classifyPath(f.old_path).lockfile) {
      const dir = path.posix.dirname(f.old_path);
      const manifestStill = [...S.headFiles()].some((p) => path.posix.dirname(p) === dir && isParsableManifest(p));
      if (manifestStill) {
        S.add('CK-LOCK', 'fail', f.old_path, null, `lockfile deleted while its manifest remains: ${f.old_path}`, '',
          { rule: 'lock.deleted' });
      }
      handledLocks.add(f.old_path);
    }
    if (f.status === 'D' || !isParsableManifest(f.path)) continue;
    const before = f.status === 'A' ? null : parseManifest(f.old_path, S.read(S.from, f.old_path));
    const after = parseManifest(f.path, S.read(S.to, f.path));
    if (!after) continue;
    const delta = manifestDelta(before, after);
    const touched = [...delta.added, ...delta.changed.map((c) => c.dep), ...delta.removed];
    const lock = lockFor(f.path, S.headFiles());
    if (lock) handledLocks.add(lock);
    if (!touched.length) continue;
    pairs++;
    if (!lock) {
      const needs = goSumNeeded(after);
      if (needs.length) {
        S.add('CK-LOCK', 'fail', f.path, null,
          `${f.path} requires ${needs.length} module(s) but there is no go.sum next to it`,
          needs.slice(0, 4).map((d) => `${d.name}@${d.spec}`).join(', '), { rule: 'lock.missing' });
      }
      continue;
    }
    const idx = lockIndex(lock, S.read(S.to, lock));
    if (!idx.ok) continue;
    const lockDir = path.posix.dirname(lock);
    const importer = path.posix.relative(lockDir === '.' ? '' : lockDir, path.posix.dirname(f.path)) || '.';
    const registry = [...delta.added, ...delta.changed.map((c) => c.dep)]
      .filter((d) => d.kind === 'registry' || d.kind === 'alias');
    const missing = registry.filter((d) => !lockHas(idx, after.ecosystem, d, { importer }));
    const presenceOnly = ['go', 'yarn', 'pip-tools'].includes(idx.manager);
    if (!changed.has(lock) && (!presenceOnly || missing.length)) {
      const names = touched.slice(0, 4).map((d) => d.name).join(', ');
      S.add('CK-LOCK', 'fail', f.path, null, `dependencies changed in ${f.path} (${names}) but ${lock} was not updated`,
        missing.slice(0, 4).map((d) => `${d.name}@${d.spec}`).join(', '), { rule: 'lock.not-updated' });
    } else if (changed.has(lock) && missing.length) {
      const what = plural(missing.length, 'dependency is', 'dependencies are');
      S.add('CK-LOCK', 'fail', lock, null, `${missing.length} new ${what} missing from ${lock}: `
        + missing.slice(0, 4).map((d) => d.name).join(', '), '', { rule: 'lock.missing-entry' });
    }
  }
  for (const f of S.files) {
    if (f.status === 'D' || !f.class.lockfile || handledLocks.has(f.path)) continue;
    if (f.status === 'A') { S.add('CK-LOCK', 'info', f.path, null, `new lockfile ${f.path}`, ''); continue; }
    S.add('CK-LOCK', 'finding', f.path, null, `${f.path} changed without a manifest change `
      + `(${lockManager(f.path) || 'unknown manager'}): transitive dependency drift`, '', { rule: 'lock.drift' });
  }
  S.summaries['CK-LOCK'] = `${pairs} manifest(s) with dependency changes checked against their lockfiles (static)`;
}

// ---------------------------------------------------------------------------
// CK-SCOPE: files outside the spec, generated files, churn, duplicated blocks, shadowing

function matchesSpec(file, specPaths) {
  return specPaths.some((p) => {
    const s = toPosix(p).replace(/^\.\//, '').replace(/\/+$/, '');
    if (!s) return false;
    if (/[*?{[]/.test(s)) return matchGlob(file, s);
    return file === s || file.startsWith(`${s}/`);
  });
}

const MAX_OUTSIDE_SPEC = 25;

function checkScope(S, specPaths) {
  let outside = 0;
  if (specPaths && specPaths.length) {
    for (const f of S.files) {
      const file = f.status === 'D' ? f.old_path : f.path;
      if (M.classifyPath(file).lockfile || matchesSpec(file, specPaths)) continue;
      if (++outside <= MAX_OUTSIDE_SPEC) {
        S.add('CK-SCOPE', 'finding', file, null, 'changed file is outside the paths the spec names', '',
          { rule: 'scope.outside-spec' });
      }
    }
    if (outside > MAX_OUTSIDE_SPEC) {
      S.add('CK-SCOPE', 'finding', null, null, `${outside - MAX_OUTSIDE_SPEC} more file(s) outside the spec paths`, '',
        { rule: 'scope.outside-spec' });
    }
  }
  // Generated files edited (path heuristics or a generated-file header).
  for (const f of S.files) {
    if (f.status === 'D' || f.class.lockfile) continue;
    let generated = f.class.generated;
    if (!generated && f.lang && S.files.length <= 2000) {
      const head = f.status === 'A' ? f.added.slice(0, 10).map((a) => a.text)
        : (S.headLines(f.path) || []).slice(0, 10);
      generated = M.GENERATED_HEADER.test(head.join('\n'));
    }
    if (generated) {
      S.add('CK-SCOPE', 'finding', f.path, null, `generated file ${f.status === 'A' ? 'added' : 'edited'}: ${f.path}; `
        + 'regenerate it from its source instead', '', { rule: 'scope.generated' });
    }
  }
  // Formatting-only churn.
  let churn = 0;
  const squeezed = (list) => list.map((x) => x.text.replace(/\s+/g, '')).sort().join('\n');
  for (const f of S.files) {
    if (f.status !== 'M' || !f.added.length || f.added.length !== f.removed.length) continue;
    if (squeezed(f.added) !== squeezed(f.removed)) continue;
    churn++;
    S.add('CK-SCOPE', 'info', f.path, null, `formatting-only change in ${f.path}`, '', { rule: 'scope.formatting' });
  }
  duplicateBlocks(S);
  pythonShadowing(S);
  S.summaries['CK-SCOPE'] = `${S.files.length} changed file(s)`
    + `${specPaths?.length ? `, ${outside} outside the spec paths` : ' (no spec paths given)'}`
    + `; ${churn} formatting-only`;
}

const WINDOW = 6;
const TRIVIAL_LINE = new RegExp([
  String.raw`^[\s{}()[\];,]*$`, String.raw`^\s*(?:\/\/|#|\*|\/\*|"""|''')`,
  String.raw`^\s*(?:import|from|use|using|package|#include|require)\b`,
  String.raw`^\s*(?:else|end|fi|done|return;?|break;?|continue;?|pass)\s*$`,
].join('|'));

/** Windows of WINDOW significant lines (at least 120 characters): [{ start, end, h }] with 1-based lines. */
function windowsOf(lines) {
  const sig = [];
  lines.forEach((t, i) => { if (t != null && !TRIVIAL_LINE.test(t)) sig.push({ i, t: norm(t) }); });
  const out = [];
  for (let k = 0; k + WINDOW <= sig.length; k++) {
    const chunk = sig.slice(k, k + WINDOW);
    if (chunk.reduce((n, c) => n + c.t.length, 0) < 120) continue;
    out.push({ start: chunk[0].i + 1, end: chunk[WINDOW - 1].i + 1, h: sha256(chunk.map((c) => c.t).join('\n')) });
  }
  return out;
}

function duplicateBlocks(S) {
  const code = S.files.filter((f) => f.status !== 'D' && f.lang && !f.binary && !f.class.generated
    && !S.isTest(f.path, 'head') && f.added.length >= WINDOW).slice(0, 200);
  if (!code.length) return;
  const index = new Map();
  for (const f of code) {
    const lines = S.headLines(f.path);
    if (!lines || lines.length > 5000) continue;
    for (const w of windowsOf(lines)) {
      if (!index.has(w.h)) index.set(w.h, []);
      index.get(w.h).push({ file: f.path, start: w.start, end: w.end });
    }
  }
  const pairs = new Set();
  const reportedAt = new Map(); // file -> start lines already reported
  for (const f of code) {
    const added = lineSet(f.added);
    const addedLines = [];
    for (const a of f.added) addedLines[a.line - 1] = a.text;
    const near = reportedAt.get(f.path) || [];
    reportedAt.set(f.path, near);
    for (const w of windowsOf(addedLines)) {
      const others = (index.get(w.h) || []).filter((o) => o.file !== f.path || o.end < w.start || o.start > w.end);
      if (!others.length || !added.has(w.start)) continue;
      const o = others[0];
      const key = `${[f.path, o.file].sort().join('|')}|${Math.min(w.start, o.start)}`;
      if (pairs.has(key) || near.some((s) => Math.abs(s - w.start) < WINDOW)) continue;
      pairs.add(key);
      near.push(w.start);
      S.add('CK-SCOPE', 'finding', f.path, w.start, `duplicated block (${WINDOW}+ lines) also at ${o.file}:${o.start}`,
        (S.headLines(f.path) || [])[w.start - 1] || '', { rule: 'scope.duplicate' });
    }
  }
}

const PY_MANIFEST = /(?:^|\/)(?:pyproject\.toml|requirements[\w.-]*\.txt|setup\.cfg|Pipfile)$/;

function pythonShadowing(S) {
  const added = S.files.filter((f) => f.status === 'A' && /\.py$/.test(f.path));
  if (!added.length) return;
  const declared = new Map();
  for (const p of S.headFiles()) {
    if (!PY_MANIFEST.test(p) || p.split('/').length > 3) continue;
    for (const d of parseManifest(p, S.read(S.to, p))?.deps || []) {
      declared.set(normPypi(d.name).replace(/-/g, '_'), d.name);
    }
  }
  if (!declared.size) return;
  const baseFiles = [...S.baseFiles()];
  const seen = new Set();
  for (const f of added) {
    const parts = f.path.split('/');
    const rel = parts[0] === 'src' ? parts.slice(1) : parts;
    const mod = rel.length === 1 ? rel[0].replace(/\.py$/, '') : rel[0];
    if (!mod || seen.has(mod) || !declared.has(mod.toLowerCase())) continue;
    const prefix = parts[0] === 'src' ? `src/${mod}` : mod;
    if (baseFiles.some((b) => b === `${prefix}.py` || b.startsWith(`${prefix}/`))) continue;
    seen.add(mod);
    S.add('CK-SCOPE', 'finding', f.path, null, `new local module "${mod}" shadows the declared dependency `
      + `"${declared.get(mod.toLowerCase())}"; imports now load the local copy (a stub can make tests pass)`, f.path,
    { rule: 'scope.shadow-dependency' });
  }
}

// ---------------------------------------------------------------------------
// Assembly

const COUNT_DATA = {
  'CK-SKIP': 'skips', 'CK-SUPPRESS': 'suppressions', 'CK-ASSERT': 'assertions', 'CK-TEST-DEL': 'tests',
};

function buildChecks(S, ms) {
  const command = `git diff -U0 -M ${S.from} ${S.to}`;
  return Object.entries(CHECK_FM).map(([id, fm]) => {
    const own = S.findings.filter((f) => f.id === id);
    const top = own.reduce((m, f) => Math.max(m, SEVERITY_RANK[f.severity] ?? 0), 0);
    const failed = S.unverified[id];
    const status = top === 2 ? 'fail' : failed ? 'unverified' : top === 1 ? 'finding' : 'pass';
    const data = {};
    if (id === 'CK-SECRETS') {
      data.scanner = S.data.scanner;
      if (S.data.scanner_error) data.scanner_error = S.data.scanner_error;
    }
    if (id === 'CK-LOCK') data.part = 'static';
    if (COUNT_DATA[id]) data.counts = S.counts[COUNT_DATA[id]];
    if (failed) data.error = failed.message;
    const capped = own.slice(0, MAX_FINDINGS_PER_CHECK);
    if (capped.length < own.length) data.truncated = own.length - capped.length;
    const external = id === 'CK-SECRETS' && S.data.scanner_command;
    return makeCheck({
      id, fm, status, reason: failed ? failed.code : null,
      command: external ? S.data.scanner_command : command, cwd: toPosix(S.root),
      exit_code: external ? (S.data.scanner_exit ?? null) : 0, duration_ms: ms,
      summary: S.summaries[id] || (failed ? `could not run: ${failed.message}` : `${own.length} finding(s)`),
      output_sha256: sha256(asciiJson(own, 0)), findings: capped, data,
    });
  });
}

/**
 * Run every diff-scoped check on `target` (from state.prepareTarget). `allow` globs mark paths as
 * in scope and exempt them from soft findings (never from failures or secrets).
 * Returns { base, tree_digest, snapshot, files, findings, counts, checks }.
 */
export async function diffScope({ target, detectResult = null, specPaths = null, allow = [], env = process.env,
  scanner = null } = {}) {
  const started = Date.now();
  const S = makeState(target, detectResult, env);
  const steps = [
    ['CK-TEST-DEL', () => checkTestDeletion(S)],
    ['CK-SKIP', () => checkSkips(S)],
    ['CK-ASSERT', () => checkAssertions(S)],
    ['CK-RETRY', () => checkRetries(S)],
    ['CK-TEST-CFG', () => checkTestConfig(S)],
    ['CK-SUPPRESS', () => checkSuppressions(S)],
    ['CK-CI', () => checkCi(S)],
    ['CK-SWALLOW', () => checkSwallow(S)],
    ['CK-SECRETS', () => checkSecrets(S, { scanner })],
    ['CK-LOCK', () => checkLockStatic(S)],
    ['CK-SCOPE', () => checkScope(S, specPaths)],
  ];
  for (const [id, fn] of steps) {
    try { fn(); } catch (err) {
      const message = truncate(redactText(err.message || String(err), S.secrets), 200);
      S.unverified[id] = { code: err.code || 'STEP_ERROR', message };
    }
  }
  // --allow: in scope, and soft findings on those paths are dropped (failures and secrets stay).
  let allowed = 0;
  if (allow && allow.length) {
    S.findings = S.findings.filter((f) => {
      if (!f.file || f.severity === 'fail' || f.id === 'CK-SECRETS') return true;
      if (!allow.some((g) => matchGlob(f.file, g))) return true;
      allowed++;
      return false;
    });
  }
  const checks = buildChecks(S, Date.now() - started);
  const sev = (s) => S.findings.filter((f) => f.severity === s).length;
  const lineCount = (key) => S.files.reduce((n, f) => n + f[key].length, 0);
  return {
    base: { ref: target.base.ref, sha: target.base.sha, source: target.base.source },
    tree_digest: target.snapshot.tree,
    snapshot: target.snapshot.commit,
    files: S.files.map((f) => {
      const deleted = f.status === 'D';
      return {
        path: toPosix(deleted ? f.old_path : f.path), ...(f.status === 'R' ? { old_path: toPosix(f.old_path) } : {}),
        status: f.status, added: f.added.length, removed: f.removed.length, binary: f.binary,
        class: Object.fromEntries(Object.entries(f.class).filter(([, v]) => v).map(([k]) => [k, true])),
        ...(S.isTest(deleted ? f.old_path : f.path, deleted ? 'base' : 'head') ? { test: true } : {}),
      };
    }),
    findings: S.findings,
    counts: {
      files: S.files.length,
      added_lines: lineCount('added'),
      removed_lines: lineCount('removed'),
      findings: { fail: sev('fail'), finding: sev('finding'), info: sev('info') },
      allowed,
      tests: S.counts.tests || null,
      skips: S.counts.skips || null,
      suppressions: S.counts.suppressions || null,
      assertions: S.counts.assertions || null,
    },
    checks,
  };
}

// ---------------------------------------------------------------------------
// Spec paths

const SPEC_TOKEN = /[\w.@*{}/-]*[\w*}](?:\/[\w.@*{},-]+)+\/?|[\w.-]+\.[A-Za-z][\w]{0,7}\b/g;

/** File and directory paths (or globs) a spec names, kept only when they exist in a tree. */
export function extractSpecPaths(text, treeFiles = null) {
  const out = new Set();
  // Windows-style paths (`src\api\users.ts`) name the same files.
  const tokens = String(text ?? '').replace(/(?<=[\w.])\\(?=[\w.])/g, '/').match(SPEC_TOKEN) || [];
  let tree = null;
  if (treeFiles) {
    tree = { files: new Set(), dirs: new Set(), byName: new Map() };
    for (const f of treeFiles) {
      tree.files.add(f);
      for (let i = f.indexOf('/'); i !== -1; i = f.indexOf('/', i + 1)) tree.dirs.add(f.slice(0, i));
      const name = f.slice(f.lastIndexOf('/') + 1);
      if (!tree.byName.has(name)) tree.byName.set(name, []);
      tree.byName.get(name).push(f);
    }
  }
  for (const raw of tokens) {
    const t = raw.replace(/^\.\//, '').replace(/[.,:;]+$/, '');
    if (!t || /^https?:|^\w+:\/\//.test(t) || /^\d+(?:\.\d+)+$/.test(t)) continue;
    if (/[*?{]/.test(t)) { out.add(t); continue; }
    const s = t.replace(/\/$/, '');
    if (!tree) {
      if (t.includes('/')) out.add(s);
    } else if (tree.files.has(s) || tree.dirs.has(s)) {
      out.add(s);
    } else {
      // A path relative to some subdirectory: the first file whose path ends with it.
      const hit = (tree.byName.get(s.slice(s.lastIndexOf('/') + 1)) || []).find((f) => f.endsWith(`/${s}`));
      if (hit) out.add(hit);
    }
  }
  return [...out];
}

// ---------------------------------------------------------------------------
// Command

const USAGE = `usage: adc.mjs diff-scope [--base <ref>] [--spec <file>] [--allow <glob>]... [--json]

Diff-scoped checks of the working-tree snapshot (uncommitted and untracked files included)
against the base: CK-SCOPE, CK-TEST-DEL, CK-SKIP, CK-ASSERT, CK-TEST-CFG, CK-SUPPRESS, CK-CI,
CK-SWALLOW, CK-SECRETS, CK-LOCK (static), CK-RETRY.
--spec      a spec/issue file (- reads stdin); the paths it names define the expected scope (CK-SCOPE)
--allow     mark paths as in scope and drop soft findings on them (never failures or secrets)
Secret scanner: gitleaks or trufflehog when installed, built-in regexes otherwise
(override with ADC_SECRETS_SCANNER=builtin|gitleaks|trufflehog).
Exit: 0 clean, 1 failures or findings, 4 a check could not run.`;

export const diffScopeCommand = defineCommand({
  name: 'diff-scope',
  usage: USAGE,
  options: { base: { type: 'string' }, spec: { type: 'string' }, allow: { type: 'string', multiple: true } },
  positionals: false,
  async run(ctx, values) {
    const target = await prepareTarget(ctx, { base: values.base, createState: !ctx.dryRun });
    let detectResult = null;
    try {
      detectResult = await detect({ root: target.root, stateInfo: ctx.dryRun ? null : target.state });
    } catch (err) {
      log(`detect failed (${err.message}); test files are recognized by path only`);
    }
    let specPaths = null;
    if (values.spec) {
      const text = readInput(values.spec, ctx.cwd, { what: '--spec file' });
      const tree = [...lsTree(target.root, target.snapshot.commit),
        ...(target.base.sha ? lsTree(target.root, target.base.sha) : [])];
      specPaths = extractSpecPaths(text, new Set(tree));
    }
    const res = await diffScope({ target, detectResult, specPaths, allow: values.allow || [] });
    if (specPaths) res.spec_paths = specPaths;
    const hard = res.findings.some((f) => f.severity === 'fail' || f.severity === 'finding');
    const unverified = res.checks.some((c) => c.status === 'unverified');
    const exit = hard ? EXIT.FINDINGS : unverified ? EXIT.UNVERIFIABLE : EXIT.OK;
    const c = res.counts.findings;
    const human = [
      `diff-scope ${res.base.ref || 'empty tree'} (${String(res.base.sha || '').slice(0, 12) || '-'})..snapshot `
        + `${String(res.tree_digest).slice(0, 12)}: ${res.counts.files} file(s), `
        + `+${res.counts.added_lines}/-${res.counts.removed_lines}`,
      ...res.checks.map((k) => `  ${k.id.padEnd(11)} ${k.status.padEnd(10)} ${k.summary}`),
      ...res.findings.filter((f) => f.severity !== 'info').slice(0, 60).map((f) => `  - [${f.severity}] ${f.id} `
        + `${f.file || ''}${f.line ? `:${f.line}` : ''} ${f.message}${f.evidence ? ` | ${f.evidence}` : ''}`),
    ].join('\n');
    const summary = `${c.fail} fail, ${c.finding} finding(s), ${c.info} info on ${res.counts.files} file(s)`;
    return { result: res, exit, summary, human };
  },
});
