// diff-scope (plan §7.2, §9.1 steps 2-8, §9.2 ratchet, §10.5): diff-scoped checks of the
// working-tree snapshot against the base. CK-SCOPE, CK-TEST-DEL, CK-SKIP, CK-ASSERT,
// CK-TEST-CFG, CK-SUPPRESS, CK-CI, CK-SWALLOW, CK-SECRETS, CK-LOCK (static), CK-RETRY.
// The ratchet compares occurrences on added lines with occurrences on removed lines of the
// same file (keyed by text and test-case context), so moved or reformatted lines do not count.

import fs from 'node:fs';
import path from 'node:path';
import {
  defineCommand, EXIT, run, which, sha256, asciiJson, toPosix, truncate, redactLiterals, readText,
  matchGlob, tmpRoot, nonce, ensureDir, parseVersion, versionGte, usageError,
} from './core.mjs';
import { emptyTree, diffNameStatus, diffLines, showFile, lsTree } from './git.mjs';
import { prepareTarget, snapshotExcludes } from './state.mjs';
import * as M from './markers.mjs';
import { parseManifest, isParsableManifest, manifestDelta, lockFor, lockIndex, lockHas, lockManager, normPypi } from './deps.mjs';

export const CHECK_FM = Object.freeze({
  'CK-SCOPE': ['FM-11'], 'CK-TEST-DEL': ['FM-01'], 'CK-SKIP': ['FM-01'], 'CK-ASSERT': ['FM-01', 'FM-03'],
  'CK-TEST-CFG': ['FM-01', 'FM-06'], 'CK-SUPPRESS': ['FM-05'], 'CK-CI': ['FM-06'], 'CK-SWALLOW': ['FM-07'],
  'CK-SECRETS': ['FM-09'], 'CK-LOCK': ['FM-12'], 'CK-RETRY': ['FM-13'],
});
const MAX_CONTENT_BYTES = 2 * 1024 * 1024;
const MAX_FINDINGS_PER_CHECK = 200;
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const SEVERITY_RANK = { info: 0, finding: 1, fail: 2 };

// ---------------------------------------------------------------------------
// Shared state for one run

async function makeState(target, detectResult, env) {
  const root = target.root;
  const from = target.base.sha || emptyTree(root);
  const to = target.snapshot.commit;
  const excludes = snapshotExcludes(target.state);
  const pathspec = ['.', ...excludes.map((p) => `:(top,exclude)${p}`)];
  const changes = diffNameStatus(root, from, to, pathspec);
  const lineList = diffLines(root, from, to, pathspec);
  const linesByPath = new Map(lineList.map((f) => [f.path, f]));
  let detectIsTest = null;
  if (detectResult) {
    try {
      const det = await import('./detect.mjs');
      if (typeof det.isTestFile === 'function') detectIsTest = (f) => { try { return Boolean(det.isTestFile(f, detectResult)); } catch { return false; } };
    } catch { /* detect.mjs not available in this build */ }
  }
  const secrets = env.ADC_LIVE_TOKEN && String(env.ADC_LIVE_TOKEN).length >= 4 ? [{ name: 'ADC_LIVE_TOKEN', value: String(env.ADC_LIVE_TOKEN) }] : [];
  const contentCache = new Map();
  const S = {
    root, from, to, target, env, secrets, excludes,
    changes, linesByPath, findings: [], unverified: {}, summaries: {}, data: {}, counts: {},
    headTree: null, baseTree: null,
    read(rev, file) {
      const k = `${rev}\u0000${file}`;
      if (contentCache.has(k)) return contentCache.get(k);
      let text = file ? showFile(root, rev, file) : null;
      if (text != null && (text.length > MAX_CONTENT_BYTES || text.includes('\u0000'))) text = null;
      contentCache.set(k, text);
      return text;
    },
    headLines(file) { const t = S.read(to, file); return t == null ? null : linesOf(t); },
    baseLines(file) { if (!target.base.sha) return null; const t = S.read(from, file); return t == null ? null : linesOf(t); },
    headFiles() { if (!S.headTree) S.headTree = new Set(lsTree(root, to)); return S.headTree; },
    baseFiles() { if (!S.baseTree) S.baseTree = new Set(target.base.sha ? lsTree(root, from) : []); return S.baseTree; },
    isTest(file, side) {
      const cls = M.classifyPath(file);
      if (cls.test) return true;
      if (detectIsTest && M.isCodeFile(file) && detectIsTest(file)) return true;
      if (M.langOf(file) === 'rs') {
        const t = side === 'base' ? (target.base.sha ? S.read(from, file) : null) : S.read(to, file);
        if (t && /#\[(?:cfg\(test\)|test\])/.test(t)) return true;
      }
      return false;
    },
  };
  const linesCache = new Map();
  function linesOf(text) {
    if (linesCache.has(text)) return linesCache.get(text);
    const l = text.split(/\r?\n/);
    if (l.length && l[l.length - 1] === '') l.pop();
    linesCache.set(text, l);
    return l;
  }
  const caseCache = new Map();
  S.cases = (side, file) => {
    const k = `${side}\u0000${file}`;
    if (!caseCache.has(k)) {
      const lines = side === 'base' ? S.baseLines(file) : S.headLines(file);
      caseCache.set(k, lines ? M.testCases(lines, file) : []);
    }
    return caseCache.get(k);
  };
  S.files = changes.map((c) => {
    const d = linesByPath.get(c.path) || linesByPath.get(c.oldPath) || { added: [], removed: [], binary: false };
    const status = c.status === 'T' ? 'M' : c.status;
    const strip = (list) => (list || []).map((x) => ({ line: x.line, text: x.text.replace(/\r$/, '') }));
    return {
      path: c.path, old_path: c.oldPath || (status === 'A' ? null : c.path), status, binary: Boolean(d.binary),
      added: strip(d.added), removed: strip(d.removed), class: M.classifyPath(c.path), lang: M.langOf(c.path),
    };
  });
  S.add = (check, severity, file, line, message, evidence = '', extra = {}) => {
    S.findings.push({
      id: check, severity, file: file ? toPosix(file) : null, line: line ?? null,
      message: redactLiterals(message, secrets), evidence: redactEvidence(evidence, secrets), ...extra,
    });
  };
  return S;
}

/** Evidence excerpts never carry secrets: shape-masked and literal-redacted, then truncated. */
function redactEvidence(text, secrets) {
  let out = String(text ?? '');
  const hits = M.scanSecrets(out);
  if (hits.length) out = hits.map((h) => h.redacted).join(' | ');
  return truncate(redactLiterals(out, secrets).trim(), 240);
}

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
  const lines = side === 'base' ? (f.old_path ? S.baseLines(f.old_path) : null) : (f.status === 'D' ? null : S.headLines(f.path));
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
function newHits(S, f, catalogs, { context = false, fileFilter = null } = {}) {
  if (f.status === 'D' || f.binary || !f.added.length) return [];
  const head = sideLines(S, f, 'head');
  const headHits = M.scanText(head, catalogs, { file: fileFilter || f.path, lines: lineSet(f.added) });
  if (!headHits.length) return [];
  const base = f.old_path && f.removed.length ? sideLines(S, f, 'base') : null;
  const baseHits = base ? M.scanText(base, catalogs, { file: f.old_path, lines: lineSet(f.removed) }) : [];
  const key = (side, lines, file) => (h) => `${h.id}|${norm(h.text)}|${context ? caseContext(S, side, file, lines, h.line) : ''}`;
  const headKey = key('head', head, f.path);
  const baseKey = key('base', base || [], f.old_path);
  const baseKeys = baseHits.map((h) => ({ k: baseKey(h) }));
  return multisetSubtract(headHits.map((h) => ({ ...h, k: headKey(h) })), baseKeys, (x) => x.k);
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

function checkTestDeletion(S) {
  const perFile = [];
  const addedPool = new Map(); // case key -> [{file}]
  let filesDeleted = 0;
  let filesRenamedOut = 0;
  let casesBase = 0;
  let casesHead = 0;
  for (const f of S.files) {
    const oldTest = f.status !== 'A' && f.old_path && S.isTest(f.old_path, 'base');
    const newTest = f.status !== 'D' && S.isTest(f.path, 'head');
    if (!oldTest && !newTest) continue;
    const baseL = oldTest ? S.baseLines(f.old_path) : null;
    const headL = newTest ? S.headLines(f.path) : null;
    const baseCases = oldTest ? S.cases('base', f.old_path) : [];
    const headCases = newTest ? S.cases('head', f.path) : [];
    casesBase += baseCases.length;
    casesHead += headCases.length;
    const entry = { f, oldTest, newTest, baseCases, headCases, baseL, headL };
    perFile.push(entry);
    const added = multisetSubtract(headCases, baseCases.map((c) => ({ k: caseKey(c, baseL) })), (c) => (c.k !== undefined ? c.k : caseKey(c, headL)));
    for (const c of added) {
      const k = caseKey(c, headL);
      if (!addedPool.has(k)) addedPool.set(k, []);
      addedPool.get(k).push({ file: f.path });
    }
  }
  const takeMoved = (k, file) => {
    const list = addedPool.get(k);
    if (!list) return null;
    const i = list.findIndex((x) => x.file !== file);
    if (i === -1) return null;
    return list.splice(i, 1)[0].file;
  };
  S.removedCaseRanges = new Map();
  const assertionCount = (lines, file) => (lines ? M.scanText(lines, M.ASSERTION_LINE, { file }).length : 0);
  for (const e of perFile) {
    const { f, oldTest, newTest, baseCases, headCases, baseL } = e;
    const removed = multisetSubtract(baseCases, headCases.map((c) => ({ k: caseKey(c, e.headL) })), (c) => (c.k !== undefined ? c.k : caseKey(c, baseL)));
    // Remember which base line ranges belong to removed cases (their assertions count here, not in CK-ASSERT).
    if (removed.length && f.old_path) {
      const ranges = [];
      for (const c of removed) {
        const idx = baseCases.indexOf(c);
        const end = idx + 1 < baseCases.length ? baseCases[idx + 1].line - 1 : (baseL ? baseL.length : c.line);
        ranges.push([c.line, end]);
      }
      S.removedCaseRanges.set(f.old_path, ranges);
    }
    if (f.status === 'D' && oldTest) {
      filesDeleted++;
      const named = M.testNaming(f.old_path);
      if (!baseCases.length && !named) {
        S.add('CK-TEST-DEL', 'info', f.old_path, null, `test support file deleted: ${f.old_path}`, '');
        continue;
      }
      const moved = baseCases.map((c) => takeMoved(caseKey(c, baseL), f.old_path)).filter(Boolean);
      const dest = [...new Set(moved)];
      const destAssertions = dest.reduce((n, p) => n + assertionCount(S.headLines(p), p), 0);
      if (baseCases.length && moved.length === baseCases.length && destAssertions >= assertionCount(baseL, f.old_path)) {
        S.add('CK-TEST-DEL', 'info', f.old_path, null, `test file deleted; all ${baseCases.length} case(s) reappear in ${dest.join(', ')}`, '');
      } else {
        S.add('CK-TEST-DEL', 'fail', f.old_path, null,
          `test file deleted: ${f.old_path} (${baseCases.length} test case${baseCases.length === 1 ? '' : 's'}${moved.length ? `, ${moved.length} reappear elsewhere` : ''})`,
          baseCases.slice(0, 5).map((c) => c.name || `line ${c.line}`).join(', '), { side: 'base' });
      }
      continue;
    }
    if (f.status === 'R' && oldTest && !newTest) {
      filesRenamedOut++;
      S.add('CK-TEST-DEL', 'fail', f.path, null, `test file renamed out of test discovery: ${f.old_path} -> ${f.path} (${baseCases.length} case(s) no longer collected)`, `${f.old_path} -> ${f.path}`);
      continue;
    }
    if (f.status === 'R' && oldTest && newTest) {
      const oldNaming = M.testNaming(f.old_path);
      if (namingRequired(oldNaming, f.path) && !M.testNaming(f.path)) {
        filesRenamedOut++;
        S.add('CK-TEST-DEL', 'fail', f.path, null, `test file renamed away from the runner's naming convention (${oldNaming}): ${f.old_path} -> ${f.path}; the runner no longer collects it`, `${f.old_path} -> ${f.path}`);
        continue;
      }
      S.add('CK-TEST-DEL', 'info', f.path, null, `test file renamed: ${f.old_path} -> ${f.path}`, '');
    }
    if (!oldTest || !newTest || !baseCases.length) continue;
    const netLoss = baseCases.length - headCases.length;
    if (netLoss <= 0) continue;
    const notMoved = [];
    let movedCount = 0;
    for (const c of removed) {
      if (takeMoved(caseKey(c, baseL), f.path)) movedCount++;
      else notMoved.push(c);
    }
    const effective = Math.min(netLoss - movedCount, notMoved.length);
    if (effective <= 0) {
      S.add('CK-TEST-DEL', 'info', f.path, null, `${movedCount} test case(s) moved from ${f.path} to other test files`, '');
      continue;
    }
    const lost = notMoved.slice(0, effective);
    S.add('CK-TEST-DEL', 'fail', f.path, lost[0].line,
      `${effective} test case${effective === 1 ? '' : 's'} removed from ${f.path} (base ${baseCases.length} -> head ${headCases.length}): ${lost.slice(0, 5).map((c) => c.name || `line ${c.line}`).join(', ')}`,
      baseL ? baseL[lost[0].line - 1] : '', { side: 'base' });
  }
  S.counts.tests = { files_changed: perFile.length, files_deleted: filesDeleted, files_renamed_out: filesRenamedOut, cases_base: casesBase, cases_head: casesHead, scope: 'changed test files' };
  S.summaries['CK-TEST-DEL'] = `${perFile.length} changed test file(s); test cases ${casesBase} -> ${casesHead}; ${filesDeleted} deleted, ${filesRenamedOut} renamed out of discovery`;
}

// ---------------------------------------------------------------------------
// CK-SKIP: added skip/focus/xfail/todo markers in test files

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
      const severity = h.kind === 'todo' ? 'finding' : 'fail';
      const what = { focus: 'focus marker (other tests stop running)', skip: 'skip marker', xfail: 'expected-failure marker', todo: 'todo placeholder' }[h.kind] || 'skip marker';
      S.add('CK-SKIP', severity, f.path, h.line, `${what} added in a test file`, h.text, { rule: h.id });
    }
  }
  S.counts.skips = { base, head, new: fresh, scope: 'changed test files' };
  S.summaries['CK-SKIP'] = `${fresh} new skip/focus marker(s); markers in changed test files ${base} -> ${head}`;
}

// ---------------------------------------------------------------------------
// CK-ASSERT: removed assertions, downgrades, tautologies, swallowed assertion errors

function inRanges(line, ranges) {
  return (ranges || []).some(([a, b]) => line >= a && line <= b);
}

function checkAssertions(S) {
  let base = 0;
  let head = 0;
  for (const f of S.files) {
    if (f.class.snapshot && f.status !== 'A') {
      if (f.status === 'D') S.add('CK-ASSERT', 'finding', f.old_path, null, `expected-output snapshot deleted: ${f.old_path}`, '');
      else S.add('CK-ASSERT', 'info', f.path, null, `expected-output snapshot changed: ${f.path}; check the new expectation is correct`, '');
      continue;
    }
    if (f.status === 'D' || f.binary) continue;
    const newTest = S.isTest(f.path, 'head');
    if (!newTest) continue;
    const oldTest = f.status !== 'A' && f.old_path && S.isTest(f.old_path, 'base');
    const headL = sideLines(S, f, 'head');
    const added = lineSet(f.added);
    const headAll = M.scanText(headL, M.ASSERTION_LINE, { file: f.path });
    head += headAll.length;
    for (const h of M.scanText(headL, M.TAUTOLOGIES, { file: f.path, lines: added })) {
      S.add('CK-ASSERT', 'finding', f.path, h.line, 'assertion that can never fail', h.text, { rule: h.id });
    }
    const swallowLines = new Set();
    for (const h of newHits(S, f, [M.ASSERTION_SWALLOW, M.SWALLOW_PATTERNS])) {
      if (swallowLines.has(h.line)) continue;
      swallowLines.add(h.line);
      S.add('CK-ASSERT', 'finding', f.path, h.line, 'error handling in a test can swallow assertion failures', h.text, { rule: h.id });
    }
    if (f.status === 'A' || !oldTest) {
      const cases = S.cases('head', f.path);
      if (cases.length && !headAll.length && f.status === 'A') {
        S.add('CK-ASSERT', 'finding', f.path, cases[0].line, `new test file has ${cases.length} test case(s) and no assertions`, headL[cases[0].line - 1] || '');
      }
      continue;
    }
    const baseL = sideLines(S, f, 'base');
    base += M.scanText(baseL, M.ASSERTION_LINE, { file: f.old_path }).length;
    const ranges = S.removedCaseRanges?.get(f.old_path);
    const removedA = M.scanText(baseL, M.ASSERTION_LINE, { file: f.old_path, lines: lineSet(f.removed) }).filter((h) => !inRanges(h.line, ranges));
    const addedA = M.scanText(headL, M.ASSERTION_LINE, { file: f.path, lines: added });
    const net = removedA.length - addedA.length;
    if (net > 0) {
      const gone = multisetSubtract(removedA, addedA, (h) => norm(h.text));
      const first = gone[0] || removedA[0];
      S.add('CK-ASSERT', 'fail', f.path, first.line,
        `${net} assertion${net === 1 ? '' : 's'} removed from ${f.path} without a replacement`, first.text, { side: 'base' });
    }
    const weakRe = M.WEAK_ASSERTIONS;
    const removedStrong = removedA.filter((h) => !M.scanText([baseL[h.line - 1] || ''], weakRe, { file: f.old_path }).length);
    if (removedStrong.length) {
      for (const h of M.scanText(headL, weakRe, { file: f.path, lines: added })) {
        S.add('CK-ASSERT', 'finding', f.path, h.line, 'assertion weakened to a truthiness/existence check', h.text, { rule: h.id });
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
      S.add('CK-RETRY', 'finding', f.path, h.line, 'in-source retry added: a retried test can hide a real failure (flaky passes count as passes)', h.text, { rule: h.id });
    }
  }
  S.summaries['CK-RETRY'] = `${fresh} in-source retr${fresh === 1 ? 'y' : 'ies'} added`;
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
  let start = -1;
  for (let j = idx; j >= 0; j--) {
    if (new RegExp(`</${tag}>`).test(lines[j]) && j !== idx) break;
    if (new RegExp(`<${tag}[\\s>]`).test(lines[j])) { start = j; break; }
  }
  if (start === -1) return '';
  let end = lines.length - 1;
  for (let j = idx; j < lines.length; j++) if (new RegExp(`</${tag}>`).test(lines[j])) { end = j; break; }
  return lines.slice(start, end + 1).join('\n');
}

// ---------------------------------------------------------------------------
// CK-TEST-CFG: runner configuration tampering

const TEST_CFG_KEYS = new Set([
  // jest / vitest / playwright / cypress / mocha / ava / karma
  'testmatch', 'testregex', 'testpathignorepatterns', 'testpathpattern', 'testpathpatterns', 'roots', 'modulepathignorepatterns',
  'projects', 'include', 'exclude', 'includesource', 'dir', 'testdir', 'testignore', 'grep', 'grepinvert', 'specpattern',
  'excludespecpattern', 'spec', 'ignore', 'extension', 'recursive', 'files', 'retries', 'retry', 'bail', 'passwithnotests',
  'allowonly', 'forbidonly', 'failonflakytests', 'coveragethreshold', 'thresholds', 'branches', 'functions', 'lines', 'statements',
  'collectcoveragefrom', 'coveragepathignorepatterns', 'testtimeout', 'shard', 'workspace',
  // pytest / coverage / tox
  'addopts', 'testpaths', 'python_files', 'python_classes', 'python_functions', 'norecursedirs', 'collect_ignore',
  'collect_ignore_glob', 'xfail_strict', 'fail_under', 'omit', 'exclude_lines', 'exclude_also', 'source', 'commands', 'reruns',
  // cargo / nextest
  'test', 'harness', 'autotests', 'default-filter', 'filter', 'fail-fast', 'retries', 'test-threads', 'required-features',
  // maven / gradle
  'skiptests', 'skip', 'skipits', 'excludes', 'includes', 'testfailureignore', 'groups', 'excludedgroups',
  'reruninfailingtestscount', 'reruninfailingtests', 'rerunfailingtestscount', 'maven.test.skip', 'testsourcedirectory', 'testexcludes',
  'excludetestsmatching', 'includetestsmatching', 'enabled', 'ignorefailures', 'onlyif', 'maxretries', 'failonpassedafterretry', 'excludetags', 'includetags',
  // dotnet
  'compile', 'istestproject', 'testcasefilter',
  // rspec / phpunit
  'tag', 'exclude-pattern', 'pattern', 'testsuite', 'directory', 'failonrisky', 'failonwarning',
  // codecov / nyc / c8
  'target', 'threshold', 'informational', 'check-coverage', 'per-file', 'require_ci_to_pass',
]);
const NARROW_FLAGS = /(?:^|\s)(?:-k|-m|-t|--testNamePattern|--testPathPattern|--testPathPatterns|--testPathIgnorePatterns|--grep|--grep-invert|-g|--invert|--ignore(?:-glob)?|--deselect|--exclude|--skip|--filter|-run|-skip|--lf|--last-failed|--only-changed|--onlyChanged|-o|--changedSince|--changed|--findRelatedTests|--passWithNoTests|--pass-with-no-tests|--reruns|--retries|--retry|--no-fail|--exit-zero|-DskipTests|--exclude-tag|--tags?|--testcasefilter|--no-tests)(?=[\s=]|$)|\|\|\s*(?:true|:|exit\s+0)|-Dmaven\.test\.(?:skip|failure\.ignore)=true/;
const TEST_COMMAND = /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|\b(?:npx|pnpx|bunx)\s+(?:jest|vitest|mocha|ava|playwright\s+test|cypress\s+run)\b|(?:^|[\s;&|("'])(?:jest|vitest|mocha|pytest|py\.test|tox|nox|rspec|phpunit|ctest)\b|\bpython\d?(?:\.\d+)?\s+-m\s+(?:pytest|unittest)\b|\b(?:uv|poetry|pdm|hatch|pipenv)\s+run\s+(?:pytest|python\s+-m\s+pytest|tox)\b|\bgo\s+test\b|\bcargo\s+(?:test|nextest)\b|\bdotnet\s+test\b|\bmvnw?\b.*\b(?:test|verify)\b|\bgradlew?\b.*\b(?:test|check)\b|\bmake\s+(?:test|check)\w*\b|\bjust\s+test\b|\bbundle\s+exec\s+(?:rspec|rake)\b|\brake\s+(?:test|spec)\b|\b(?:deno|swift|flutter|dart|mix)\s+test\b/;

/** Reason when `after` runs fewer tests than `before` or hides failures; null otherwise. */
export function narrowsCommand(before, after) {
  const b = String(before ?? '');
  const a = String(after ?? '');
  if (TEST_COMMAND.test(b) && !TEST_COMMAND.test(a)) return 'no longer invokes the test runner';
  const flagsOf = (s) => new Set((s.match(new RegExp(NARROW_FLAGS.source, 'g')) || []).map((x) => x.trim()));
  const fb = flagsOf(b);
  const added = [...flagsOf(a)].filter((x) => !fb.has(x));
  if (added.length) return `adds ${added.join(', ')}`;
  const pathTok = (s) => new Set(s.split(/\s+/).filter((t) => /^[\w.@-]*\/[\w./*@-]*$|\.(?:test|spec)\.|_test\.\w+$|^test_\w+\.py$/.test(t)));
  const pb = pathTok(b);
  const pa = [...pathTok(a)].filter((t) => !pb.has(t));
  if (pa.length && TEST_COMMAND.test(a)) return `restricts the run to ${pa.slice(0, 3).join(', ')}`;
  return null;
}

/** Is a changed line in this runner config relevant to test discovery or failure handling? */
function relevantCfgKey(file, lines, idx) {
  const base = path.posix.basename(file).toLowerCase();
  const { keys, section } = keyPath(lines, idx);
  const own = keys[0]?.toLowerCase();
  const sec = (section || '').toLowerCase();
  const hit = (list) => list.find((k) => TEST_CFG_KEYS.has(k.toLowerCase()) || TEST_CFG_KEYS.has(k.toLowerCase().split('.').pop()));
  if (base === 'pyproject.toml') {
    if (!/^tool\.(?:pytest|coverage|tox|nox)/.test(sec)) return null;
    return hit(keys) || (sec.startsWith('tool.pytest') ? keys[keys.length - 1] || sec : null);
  }
  if (base === 'setup.cfg' || base === 'tox.ini') {
    if (!/^(?:tool:pytest|pytest|coverage:|testenv|tox)/.test(sec)) return null;
    return hit(keys) || null;
  }
  if (base === 'pytest.ini') return sec === 'pytest' ? (hit(keys) || keys[keys.length - 1] || 'pytest') : null;
  if (base === 'cargo.toml') {
    if (/^(?:\[)?test$/.test(sec) || sec === 'test' || /^(?:lib|bin|package)$/.test(sec)) {
      if (sec === 'test') return keys[0] || 'test';
      return ['test', 'harness', 'autotests', 'autobins'].includes(own) ? own : null;
    }
    return null;
  }
  if (/\.(?:cs|fs|vb)proj$|^directory\.build\.(?:props|targets)$/.test(base)) {
    const t = lines[idx];
    if (/<Compile\s+Remove=|<IsTestProject>|<ExcludeFromCodeCoverage|<VSTestTestCaseFilter|<TestCaseFilter/i.test(t)) return own || 'Compile';
    return null;
  }
  if (base === 'pom.xml') {
    const block = enclosingBlock(lines, idx, 'plugin');
    const inRunner = /surefire|failsafe/.test(block);
    const inProps = keys.slice(1).some((k) => k.toLowerCase() === 'properties');
    if (!inRunner && !inProps) return null;
    if (inProps) return /^(?:skiptests|maven\.test\.skip|skipits|maven\.test\.failure\.ignore|surefire\.\w+)$/i.test(own || '') ? own : null;
    return hit(keys) || null;
  }
  if (base === 'build.gradle' || base === 'build.gradle.kts') {
    const inTest = keys.slice(1).some((k) => /^(?:test|tests|tasks\.test|tasks\.named|withType|retry|filter|useJUnitPlatform)$/i.test(k)) || /\btest\s*\{|tasks\.test|withType\s*\(\s*Test|named\s*\(\s*["']test/.test(lines[idx]);
    if (!inTest) return null;
    return hit(keys) || (/\b(?:exclude|include|excludeTestsMatching|includeTestsMatching|enabled|ignoreFailures|onlyIf|maxRetries)\b/.exec(lines[idx])?.[0] ?? null);
  }
  if (/^vite\.config\./.test(base)) return keys.slice(1).some((k) => k === 'test') ? (hit(keys) || 'test') : null;
  if (/^(?:makefile|gnumakefile|.+\.mk|justfile|\.justfile)$/.test(base)) {
    for (let j = idx; j >= 0; j--) {
      const m = /^([A-Za-z0-9_.%/-]+)\s*:(?!=)/.exec(lines[j]);
      if (m && !/^\s/.test(lines[j])) return /^(?:test|check|ci|unit|integration|e2e)/i.test(m[1]) ? m[1] : null;
      const v = /^([A-Z_]*TEST[A-Z_]*)\s*[:?+]?=/.exec(lines[j]);
      if (v && j === idx) return v[1];
    }
    return null;
  }
  if (base === 'taskfile.yml' || base === 'taskfile.yaml') return keys.some((k) => /^test/i.test(k)) ? keys.find((k) => /^test/i.test(k)) : null;
  if (base === 'codecov.yml' || base === '.codecov.yml') return hit(keys) || null;
  if (base === '.rspec' || base === 'rakefile') return base === '.rspec' ? '.rspec' : (/test|spec/i.test(lines[idx]) ? 'task' : null);
  if (base === 'conftest.py') return /\b(?:collect_ignore(?:_glob)?|pytest_collection_modifyitems|pytest_ignore_collect|pytest_collect_file|pytest_deselected|items\.remove|deselect)\b/.test(lines[idx]) ? 'collection hook' : null;
  if (/^deno\.jsonc?$/.test(base)) return keys.slice(1).includes('test') || own === 'test' ? 'test' : null;
  // Dedicated runner configs: jest, vitest, playwright, cypress, mocha, karma, ava, nyc, c8, nextest, runsettings, phpunit.
  return hit(keys) || null;
}

function checkTestConfig(S) {
  let touched = 0;
  let ciChanges = 0;
  for (const f of S.files) {
    const file = f.status === 'D' ? f.old_path : f.path;
    const base = path.posix.basename(file).toLowerCase();
    const isRunnerCfg = M.classifyPath(file).runnerConfig;
    const isCi = M.classifyPath(file).ci;
    if (!isRunnerCfg && !isCi) continue;
    if (isCi) { ciChanges += ciTestCommands(S, f); continue; }
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
    if (f.status === 'A') {
      const keys = [...groups.keys()];
      S.add('CK-TEST-CFG', 'finding', file, groups.get(keys[0]).added[0]?.line ?? null,
        `new runner configuration ${file} sets ${keys.slice(0, 6).join(', ')}; confirm it does not narrow test discovery or enable retries`, groups.get(keys[0]).added[0]?.text || '');
      continue;
    }
    if (f.status === 'D') {
      S.add('CK-TEST-CFG', 'fail', file, null, `runner configuration deleted: ${file} (it set ${[...groups.keys()].slice(0, 6).join(', ')})`, '');
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
      S.add('CK-TEST-CFG', 'fail', file, g.added[0]?.line ?? null,
        `test runner setting "${g.key}" changed in ${file}${before ? `: "${truncate(before, 80)}"` : ''}${after ? ` -> "${truncate(after, 80)}"` : ' (removed)'}`,
        first.text, { side: g.added[0] ? 'head' : 'base' });
    }
  }
  S.summaries['CK-TEST-CFG'] = `${touched} runner configuration file(s) with discovery or failure-handling changes; ${ciChanges} CI test command change(s)`;
}

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
  const scripts = new Set([...Object.keys(before.scripts || {}), ...Object.keys(after.scripts || {})].filter((k) => /^(?:pre|post)?test(?:[:-]|$)/.test(k)));
  for (const k of scripts) {
    const b = before.scripts?.[k];
    const a = after.scripts?.[k];
    if (b === a) continue;
    if (b == null) {
      const why = NARROW_FLAGS.test(a) ? ' and it hides failures or narrows the run' : '';
      S.add('CK-TEST-CFG', f.status === 'A' || !why ? 'finding' : 'fail', file, lineOf(k), `test script "${k}" added: "${truncate(a, 100)}"${why}`, a);
      continue;
    }
    if (a == null) { S.add('CK-TEST-CFG', 'fail', file, null, `test script "${k}" removed (was "${truncate(b, 100)}")`, b, { side: 'base' }); continue; }
    const why = narrowsCommand(b, a);
    S.add('CK-TEST-CFG', why ? 'fail' : 'finding', file, lineOf(k), `test script "${k}" changed: "${truncate(b, 80)}" -> "${truncate(a, 80)}"${why ? ` (${why})` : ''}`, a);
  }
  for (const k of ['jest', 'mocha', 'ava', 'c8', 'nyc', 'vitest']) {
    const b = JSON.stringify(before[k] ?? null);
    const a = JSON.stringify(after[k] ?? null);
    if (a === b) continue;
    if (before[k] == null && f.status === 'A') continue;
    const changedKeys = new Set([...Object.keys(before[k] || {}), ...Object.keys(after[k] || {})]
      .filter((x) => JSON.stringify(before[k]?.[x]) !== JSON.stringify(after[k]?.[x])));
    const relevant = [...changedKeys].filter((x) => TEST_CFG_KEYS.has(x.toLowerCase()));
    if (!relevant.length && before[k] != null && after[k] != null) continue;
    S.add('CK-TEST-CFG', before[k] == null ? 'finding' : 'fail', file, lineOf(k),
      `"${k}" configuration in package.json changed${relevant.length ? ` (${relevant.join(', ')})` : before[k] == null ? ' (added)' : ' (removed)'}`, truncate(a, 160));
  }
}

/** CI files: changed test commands go to CK-TEST-CFG (CK-CI handles weakening and removals). */
function ciTestCommands(S, f) {
  if (f.status !== 'M' && f.status !== 'R') return 0;
  let n = 0;
  const removed = f.removed.filter((x) => TEST_COMMAND.test(x.text));
  const added = f.added.filter((x) => TEST_COMMAND.test(x.text));
  const pairs = Math.min(removed.length, added.length);
  const unmatchedRemoved = multisetSubtract(removed, added, (x) => norm(x.text));
  const unmatchedAdded = multisetSubtract(added, removed, (x) => norm(x.text));
  for (let i = 0; i < Math.min(pairs, unmatchedRemoved.length, unmatchedAdded.length); i++) {
    const b = unmatchedRemoved[i].text;
    const a = unmatchedAdded[i].text;
    // Failure-masking edits (|| true, --passWithNoTests, ...) are CK-CI's; report each edit once.
    if (M.scanText([a], M.CI_WEAKENING).length) continue;
    const why = narrowsCommand(b, a);
    n++;
    S.add('CK-TEST-CFG', why ? 'fail' : 'finding', f.path, unmatchedAdded[i].line,
      `CI test command changed: "${truncate(norm(b), 80)}" -> "${truncate(norm(a), 80)}"${why ? ` (${why})` : ''}`, a);
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

function lintConfigChanges(S, f) {
  const file = f.path;
  const base = path.posix.basename(file).toLowerCase();
  const isDedicated = f.class.lintConfig;
  const sectionRe = LINT_SECTION_FILES[base];
  const isMsbuild = /^directory\.build\.(?:props|targets)$|\.(?:cs|fs|vb)proj$/.test(base);
  const isPkg = base === 'package.json';
  if (!isDedicated && !sectionRe && !isMsbuild && !isPkg) return 0;
  const headL = sideLines(S, f, 'head');
  const baseL = f.status === 'A' ? [] : sideLines(S, f, 'base');
  let n = 0;
  const severity = f.status === 'A' ? 'finding' : 'fail';
  const inScope = (lines, x) => {
    if (isDedicated || isMsbuild) return true;
    const { keys, section } = keyPath(lines, x.line - 1);
    if (sectionRe) return sectionRe.test((section || '').toLowerCase());
    if (isPkg) return keys.some((k) => k === 'eslintConfig' || k === 'rules' || k === 'stylelint');
    return false;
  };
  const addedHits = M.scanText(headL, M.LINT_CONFIG_WEAKENING, { lines: lineSet(f.added) }).filter((h) => inScope(headL, h));
  const removedHits = M.scanText(baseL, M.LINT_CONFIG_WEAKENING, { lines: lineSet(f.removed) }).filter((h) => inScope(baseL, h));
  const fresh = multisetSubtract(addedHits, removedHits, (h) => `${h.id}|${norm(h.text)}`);
  for (const h of fresh) {
    if (h.id === 'lintcfg.ignore-list') {
      S.add('CK-SUPPRESS', 'finding', file, h.line, `lint ignore/disable list changed in ${file}; check which rules or files it now skips`, h.text, { rule: h.id });
    } else {
      S.add('CK-SUPPRESS', severity, file, h.line, `${f.status === 'A' ? 'new lint configuration turns a check off' : 'lint/type rule turned off repo-wide'} in ${file}`, h.text, { rule: h.id, scope: 'config' });
    }
    n++;
  }
  // Items added under an exclusion list (YAML/TOML/JSON lists whose parent key is ignore/disable/exclude...).
  for (const x of f.added) {
    const { keys } = keyPath(headL, x.line - 1);
    if (!inScope(headL, x)) continue;
    const parent = keys[keys[0] && keyOf(headL[x.line - 1] || '') ? 1 : 0];
    if (!parent || !M.LINT_EXCLUSION_KEYS.test(parent)) continue;
    if (!/^\s*(?:-\s+)?["']?[\w@./*:-]+["']?\s*,?\s*$/.test(x.text)) continue;
    if (fresh.some((h) => h.line === x.line)) continue;
    const wasThere = f.removed.some((r) => norm(r.text) === norm(x.text));
    if (wasThere) continue;
    S.add('CK-SUPPRESS', parent.toLowerCase().startsWith('disable') ? severity : 'finding', file, x.line, `"${norm(x.text).replace(/^-\s*/, '')}" added to ${parent} in ${file}`, x.text, { rule: 'lintcfg.list-item' });
    n++;
  }
  // Error -> warning downgrades of a rule ("error"/2 -> "warn"/1).
  const level = (t) => /["']?([@\w/-]+)["']?\s*[:=]\s*\[?\s*(?:["'](error|warn|warning)["']|([0-2])\b)/.exec(t);
  const removedLevels = new Map(f.removed.map((x) => level(x.text)).filter(Boolean).map((m) => [m[1], m[2] || ({ 2: 'error', 1: 'warn', 0: 'off' })[m[3]]]));
  for (const x of f.added) {
    const m = level(x.text);
    if (!m) continue;
    const now = m[2] || ({ 2: 'error', 1: 'warn', 0: 'off' })[m[3]];
    if (removedLevels.get(m[1]) === 'error' && /^warn/.test(now)) {
      S.add('CK-SUPPRESS', 'finding', file, x.line, `rule "${m[1]}" downgraded from error to warning in ${file}`, x.text, { rule: 'lintcfg.downgrade' });
      n++;
    }
  }
  return n;
}

function checkSuppressions(S) {
  let added = 0;
  let removed = 0;
  let configChanges = 0;
  for (const f of S.files) {
    if (f.status === 'D' || f.binary) continue;
    if (f.class.lintConfig || /^(?:pyproject\.toml|setup\.cfg|tox\.ini|cargo\.toml|package\.json|directory\.build\.(?:props|targets))$|\.(?:cs|fs|vb)proj$/i.test(path.posix.basename(f.path))) {
      configChanges += lintConfigChanges(S, f);
    }
    if (!f.lang) continue;
    const hits = newHits(S, f, M.SUPPRESSIONS);
    const baseL = f.old_path && f.removed.length ? sideLines(S, f, 'base') : null;
    removed += baseL ? M.scanText(baseL, M.SUPPRESSIONS, { file: f.old_path, lines: lineSet(f.removed) }).length : 0;
    added += M.scanText(sideLines(S, f, 'head'), M.SUPPRESSIONS, { file: f.path, lines: lineSet(f.added) }).length;
    for (const h of hits) {
      S.add('CK-SUPPRESS', 'finding', f.path, h.line, `${h.scope === 'file' ? 'file-wide ' : ''}suppression directive added`, h.text, { rule: h.id, ...(h.scope ? { scope: h.scope } : {}) });
    }
  }
  S.counts.suppressions = { added_lines: added, removed_lines: removed, net: added - removed, config_changes: configChanges, scope: 'added/removed lines (unchanged lines are equal on both sides)' };
  S.summaries['CK-SUPPRESS'] = `suppressions on changed lines: +${added} / -${removed} (net ${added - removed}); ${configChanges} lint-config weakening(s)`;
}

// ---------------------------------------------------------------------------
// CK-CI: CI edits that weaken existing test steps

function checkCi(S) {
  let files = 0;
  for (const f of S.files) {
    const oldCi = f.old_path && M.classifyPath(f.old_path).ci;
    const newCi = f.status !== 'D' && f.class.ci;
    if (!oldCi && !newCi) continue;
    files++;
    if (f.status === 'A') {
      const headL = sideLines(S, f, 'head');
      const generated = M.CI_GATE_HEADER.test(headL.slice(0, 5).join('\n'));
      const weak = M.scanText(headL, M.CI_WEAKENING).length;
      S.add('CK-CI', 'finding', f.path, null, `new CI workflow ${f.path}${generated ? ' (written by ci-gate)' : ''}${weak ? `; it contains ${weak} failure-masking setting(s)` : ''}`, '');
      continue;
    }
    const baseL = sideLines(S, f, 'base');
    const baseTests = baseL.filter((l) => TEST_COMMAND.test(l)).length;
    if (f.status === 'D' || (oldCi && !newCi)) {
      S.add('CK-CI', baseTests ? 'fail' : 'finding', f.old_path, null,
        `CI workflow ${f.status === 'D' ? 'deleted' : `moved out of the CI directory (${f.path})`}: ${f.old_path}${baseTests ? ` (${baseTests} test step line(s))` : ''}`, '');
      continue;
    }
    const headL = sideLines(S, f, 'head');
    const baseGenerated = M.CI_GATE_HEADER.test(baseL.slice(0, 5).join('\n'));
    const headGenerated = M.CI_GATE_HEADER.test(headL.slice(0, 5).join('\n'));
    if (headGenerated && !baseGenerated) {
      S.add('CK-CI', 'fail', f.path, 1, 'the ci-gate "generated" header was added to an existing workflow; that header downgrades CK-CI failures to findings', headL[0]);
    }
    const hardSeverity = baseGenerated ? 'finding' : 'fail';
    const addedHits = M.scanText(headL, M.CI_WEAKENING, { lines: lineSet(f.added) });
    const removedHits = M.scanText(baseL, M.CI_WEAKENING, { lines: lineSet(f.removed) });
    for (const h of multisetSubtract(addedHits, removedHits, (x) => `${x.id}|${norm(x.text)}`)) {
      S.add('CK-CI', h.severity || hardSeverity, f.path, h.line, `CI change can turn a failing step green (${h.id.replace(/^ci\./, '')})`, h.text, { rule: h.id });
    }
    // Test steps removed without a replacement.
    const removedTests = f.removed.filter((x) => TEST_COMMAND.test(x.text));
    const addedTests = f.added.filter((x) => TEST_COMMAND.test(x.text));
    if (removedTests.length > addedTests.length) {
      const gone = multisetSubtract(removedTests, addedTests, (x) => norm(x.text));
      const first = gone[0] || removedTests[0];
      S.add('CK-CI', hardSeverity, f.path, null, `${removedTests.length - addedTests.length} test step(s) removed from ${f.path}`, first.text, { side: 'base', rule: 'ci.test-step-removed' });
    }
    // Lowered thresholds (same key, smaller number).
    const thresholds = (list) => list.map((x) => ({ x, m: M.THRESHOLD.exec(x.text) })).filter((t) => t.m);
    const before = thresholds(f.removed);
    for (const { x, m } of thresholds(f.added)) {
      const prev = before.find((b) => b.m[1].replace(/\s+/g, '') === m[1].replace(/\s+/g, ''));
      if (prev && Number(m[2]) < Number(prev.m[2])) {
        S.add('CK-CI', hardSeverity, f.path, x.line, `threshold lowered from ${prev.m[2]} to ${m[2]}`, x.text, { rule: 'ci.threshold-lowered' });
      }
    }
  }
  // Coverage/threshold configs outside CI (codecov.yml, .nycrc, jest coverageThreshold) are CK-TEST-CFG.
  S.summaries['CK-CI'] = `${files} CI file(s) changed`;
}

// ---------------------------------------------------------------------------
// CK-SWALLOW: swallowed errors and error -> warning downgrades in non-test code

function checkSwallow(S) {
  let fresh = 0;
  for (const f of S.files) {
    if (f.status === 'D' || f.binary || !f.lang || f.class.generated) continue;
    if (S.isTest(f.path, 'head')) continue;
    for (const h of newHits(S, f, M.SWALLOW_PATTERNS)) {
      fresh++;
      S.add('CK-SWALLOW', 'finding', f.path, h.line, 'error swallowed: the failure is caught and dropped', h.text, { rule: h.id });
    }
    // error-level log replaced by a lower level with the same text
    const levelOf = (t) => {
      const m = M.LOG_CALL.exec(t);
      if (!m) return null;
      const lvl = String(m[1] || m[2]).toLowerCase().replace(/^log/, '').replace(/f$/, '').replace(/information/, 'info');
      return { rank: M.LOG_LEVEL_RANK[lvl] ?? null, key: norm(t.replace(m[0], 'LOG(')) };
    };
    const removedErr = f.removed.map((x) => ({ x, l: levelOf(x.text) })).filter((r) => r.l && r.l.rank === 3);
    if (removedErr.length) {
      for (const x of f.added) {
        const l = levelOf(x.text);
        if (!l || l.rank == null || l.rank >= 3) continue;
        if (removedErr.some((r) => r.l.key === l.key)) {
          fresh++;
          S.add('CK-SWALLOW', 'finding', f.path, x.line, 'error log downgraded to a lower level', x.text, { rule: 'swallow.log-downgrade' });
        }
      }
    }
    // throw/raise replaced by a log call carrying the same message
    const removedThrows = f.removed.filter((x) => M.THROW_LINE.test(x.text));
    const addedThrows = f.added.filter((x) => M.THROW_LINE.test(x.text));
    if (removedThrows.length > addedThrows.length) {
      for (const t of removedThrows) {
        const lit = /(["'`])((?:\\.|(?!\1).){6,})\1/.exec(t.text)?.[2];
        if (!lit) continue;
        const logged = f.added.find((x) => M.LOG_CALL.test(x.text) && x.text.includes(lit));
        if (logged) {
          fresh++;
          S.add('CK-SWALLOW', 'finding', f.path, logged.line, 'exception replaced by a log message; callers no longer see the failure', logged.text, { rule: 'swallow.throw-to-log' });
        }
      }
    }
  }
  S.summaries['CK-SWALLOW'] = `${fresh} swallowed error(s) or downgrade(s) added`;
}

// ---------------------------------------------------------------------------
// CK-SECRETS: gitleaks / trufflehog when installed, built-in regexes otherwise (D7)

function selectScanner(env, forced) {
  const want = forced || env.ADC_SECRETS_SCANNER || 'auto';
  if (want === 'builtin') return 'builtin';
  if ((want === 'auto' || want === 'gitleaks') && which('gitleaks', env)) return 'gitleaks';
  if ((want === 'auto' || want === 'trufflehog') && which('trufflehog', env)) return 'trufflehog';
  return 'builtin';
}

function addedIndex(S) {
  const idx = new Map();
  for (const f of S.files) if (f.status !== 'D') idx.set(f.path, new Map(f.added.map((a) => [a.line, a.text])));
  return idx;
}

function runGitleaks(S) {
  const dir = ensureDir(tmpRoot(S.root));
  const report = path.join(dir, `gitleaks-${nonce()}.json`);
  const range = S.target.base.sha ? `${S.from}..${S.to}` : S.to;
  const ver = run('gitleaks', ['version'], { env: S.env, timeoutMs: 10_000 });
  const v = parseVersion(ver.stdout);
  const modern = !v || versionGte(v, '8.19.0');
  const args = modern
    ? ['git', '--log-opts', range, '--redact', '--no-banner', '--report-format', 'json', '--report-path', report, '--exit-code', '1', S.root]
    : ['detect', '--source', S.root, '--log-opts', range, '--redact', '--no-banner', '--report-format', 'json', '--report-path', report, '--exit-code', '1'];
  const res = run('gitleaks', args, { cwd: S.root, env: S.env, timeoutMs: 300_000 });
  try {
    if (res.exit !== 0 && res.exit !== 1) return { ok: false, error: `gitleaks exited ${res.exit}: ${truncate((res.stderr || '').trim().split('\n').pop(), 160)}`, cmd: `gitleaks ${args.slice(0, 3).join(' ')}` };
    const items = JSON.parse(readText(report, '[]') || '[]');
    return { ok: true, exit: res.exit, cmd: `gitleaks ${args.filter((a) => a !== S.root && a !== report).join(' ')}`,
      items: items.map((i) => ({ id: `gitleaks.${i.RuleID}`, file: toPosix(i.File), line: i.StartLine, severity: 'fail', redacted: `${i.RuleID} (value redacted by gitleaks)` })) };
  } catch (err) {
    return { ok: false, error: `gitleaks report unreadable: ${err.message}` };
  } finally {
    fs.rmSync(report, { force: true });
  }
}

function runTrufflehog(S, added) {
  const files = [...added.keys()].filter((p) => fs.existsSync(path.join(S.root, p)) && added.get(p).size);
  if (!files.length) return { ok: true, exit: 0, items: [], cmd: 'trufflehog filesystem (no files)' };
  const args = ['filesystem', ...files.map((p) => path.join(S.root, p)), '--json', '--no-update', '--no-verification'];
  const res = run('trufflehog', args, { cwd: S.root, env: S.env, timeoutMs: 300_000 });
  if (res.exit !== 0 && res.exit !== 183) return { ok: false, error: `trufflehog exited ${res.exit}`, cmd: 'trufflehog filesystem' };
  const items = [];
  for (const line of res.stdout.split(/\r?\n/)) {
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    const meta = j?.SourceMetadata?.Data?.Filesystem;
    if (!meta) continue;
    const file = toPosix(path.relative(S.root, meta.file));
    const ln = Number(meta.line) || null;
    if (!added.get(file)?.has(ln)) continue; // only secrets on added lines are this change's
    items.push({ id: `trufflehog.${j.DetectorName || 'secret'}`, file, line: ln, severity: 'fail', redacted: `${j.DetectorName || 'secret'} (value not recorded)` });
  }
  return { ok: true, exit: res.exit, items, cmd: 'trufflehog filesystem <changed files> --json --no-update --no-verification' };
}

function checkSecrets(S, { scanner = null } = {}) {
  const added = addedIndex(S);
  let chosen = selectScanner(S.env, scanner);
  let external = null;
  if (chosen === 'gitleaks') external = runGitleaks(S);
  else if (chosen === 'trufflehog') external = runTrufflehog(S, added);
  if (external && !external.ok) { S.data.scanner_error = external.error; chosen = 'builtin'; }
  let count = 0;
  if (chosen !== 'builtin') {
    for (const i of external.items) {
      count++;
      S.add('CK-SECRETS', 'fail', i.file, i.line, `secret detected by ${chosen} (${i.id.replace(/^\w+\./, '')})`, i.redacted, { rule: i.id });
    }
    S.data.scanner_command = external.cmd;
    S.data.scanner_exit = external.exit;
  } else {
    for (const f of S.files) {
      if (f.status === 'D' || f.binary || !f.added.length) continue;
      const text = f.added.map((a) => a.text).join('\n');
      for (const h of M.scanSecrets(text)) {
        count++;
        const line = f.added[h.line - 1]?.line ?? null;
        S.add('CK-SECRETS', h.severity, f.path, line, `possible secret (${h.id.replace(/^secret\./, '')}) added`, h.redacted, { rule: h.id });
      }
    }
  }
  // The live-test token by value: wherever it was pasted, it must not leave .adc/.
  if (S.secrets.length) {
    const value = S.secrets[0].value;
    for (const f of S.files) {
      for (const a of f.added) {
        if (value.length >= 6 && a.text.includes(value)) {
          count++;
          S.add('CK-SECRETS', 'fail', f.path, a.line, 'the ADC_LIVE_TOKEN value appears in the change', a.text, { rule: 'secret.adc-live-token-value' });
        }
      }
    }
  }
  for (const f of S.files) {
    if (f.status !== 'A' && f.status !== 'R') continue;
    const kind = M.credentialFileName(f.path);
    if (kind) { count++; S.add('CK-SECRETS', 'finding', f.path, null, `credential-like file added (${kind}): ${f.path}`, '', { rule: `secret.file.${kind}` }); }
  }
  S.data.scanner = chosen;
  S.summaries['CK-SECRETS'] = `${count} possible secret(s) on added lines (scanner: ${chosen}${S.data.scanner_error ? `; ${S.data.scanner_error}, fell back to built-in` : ''})`;
}

// ---------------------------------------------------------------------------
// CK-LOCK (static): manifest dependency changes paired with lockfile changes

function checkLockStatic(S) {
  const changed = new Map(S.files.map((f) => [f.path, f]));
  const handledLocks = new Set();
  let pairs = 0;
  for (const f of S.files) {
    const lk = f.status !== 'D' ? M.classifyPath(f.path).lockfile : false;
    if (lk) {
      const text = S.read(S.to, f.path);
      if (text && /^(?:<{7}|={7}|>{7})(?: |$)/m.test(text)) S.add('CK-LOCK', 'fail', f.path, null, `merge-conflict markers in ${f.path}`, '', { rule: 'lock.conflict-markers' });
    }
    if (f.status === 'D' && f.old_path && M.classifyPath(f.old_path).lockfile) {
      const manifestStill = [...S.headFiles()].some((p) => isParsableManifest(p) && path.posix.dirname(p) === path.posix.dirname(f.old_path));
      if (manifestStill) S.add('CK-LOCK', 'fail', f.old_path, null, `lockfile deleted while its manifest remains: ${f.old_path}`, '', { rule: 'lock.deleted' });
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
    if (!lock) continue;
    const lockChanged = changed.has(lock);
    const idx = lockIndex(lock, S.read(S.to, lock));
    if (!idx.ok) continue;
    const importer = path.posix.relative(path.posix.dirname(lock) === '.' ? '' : path.posix.dirname(lock), path.posix.dirname(f.path)) || '.';
    const registry = [...delta.added, ...delta.changed.map((c) => c.dep)].filter((d) => d.kind === 'registry' || d.kind === 'alias');
    const missing = registry.filter((d) => !lockHas(idx, after.ecosystem, d, { importer }));
    const presenceOnly = ['go', 'yarn', 'pip-tools'].includes(idx.manager);
    if (!lockChanged && (!presenceOnly || missing.length)) {
      S.add('CK-LOCK', 'fail', f.path, null,
        `dependencies changed in ${f.path} (${touched.slice(0, 4).map((d) => d.name).join(', ')}) but ${lock} was not updated`,
        missing.slice(0, 4).map((d) => `${d.name}@${d.spec}`).join(', '), { rule: 'lock.not-updated' });
    } else if (lockChanged && missing.length) {
      S.add('CK-LOCK', 'fail', lock, null, `${missing.length} new dependenc${missing.length === 1 ? 'y is' : 'ies are'} missing from ${lock}: ${missing.slice(0, 4).map((d) => d.name).join(', ')}`, '', { rule: 'lock.missing-entry' });
    }
  }
  for (const f of S.files) {
    if (f.status === 'D' || !M.classifyPath(f.path).lockfile || handledLocks.has(f.path)) continue;
    if (f.status === 'A') { S.add('CK-LOCK', 'info', f.path, null, `new lockfile ${f.path}`, ''); continue; }
    const manager = lockManager(f.path);
    S.add('CK-LOCK', 'finding', f.path, null, `${f.path} changed without a manifest change (${manager || 'unknown manager'}): transitive dependency drift`, '', { rule: 'lock.drift' });
  }
  S.data.lock_part = 'static';
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

function checkScope(S, specPaths) {
  let outside = 0;
  if (specPaths && specPaths.length) {
    for (const f of S.files) {
      const file = f.status === 'D' ? f.old_path : f.path;
      if (M.classifyPath(file).lockfile || matchesSpec(file, specPaths)) continue;
      outside++;
      if (outside <= 25) S.add('CK-SCOPE', 'finding', file, null, `changed file is outside the paths the spec names`, '', { rule: 'scope.outside-spec' });
    }
    if (outside > 25) S.add('CK-SCOPE', 'finding', null, null, `${outside - 25} more file(s) outside the spec paths`, '', { rule: 'scope.outside-spec' });
  }
  // Generated files edited (path heuristics or a generated-file header).
  for (const f of S.files) {
    if (f.status === 'D' || f.class.lockfile) continue;
    let generated = f.class.generated;
    if (!generated && f.lang && S.files.length <= 2000) {
      const head = (f.status === 'A' ? f.added.slice(0, 10).map((a) => a.text) : (S.headLines(f.path) || []).slice(0, 10)).join('\n');
      generated = M.GENERATED_HEADER.test(head);
    }
    if (generated) S.add('CK-SCOPE', 'finding', f.path, null, `generated file ${f.status === 'A' ? 'added' : 'edited'}: ${f.path}; regenerate it from its source instead`, '', { rule: 'scope.generated' });
  }
  // Formatting-only churn.
  let churn = 0;
  for (const f of S.files) {
    if (f.status !== 'M' || !f.added.length || f.added.length !== f.removed.length) continue;
    const a = f.added.map((x) => x.text.replace(/\s+/g, '')).sort().join('\n');
    const r = f.removed.map((x) => x.text.replace(/\s+/g, '')).sort().join('\n');
    if (a === r) { churn++; S.add('CK-SCOPE', 'info', f.path, null, `formatting-only change in ${f.path}`, '', { rule: 'scope.formatting' }); }
  }
  duplicateBlocks(S);
  pythonShadowing(S);
  S.summaries['CK-SCOPE'] = `${S.files.length} changed file(s)${specPaths?.length ? `, ${outside} outside the spec paths` : ' (no spec paths given)'}; ${churn} formatting-only`;
}

const WINDOW = 6;
const trivialLine = (t) => /^[\s{}()[\];,]*$/.test(t) || /^\s*(?:\/\/|#|\*|\/\*|"""|''')/.test(t) || /^\s*(?:import|from|use|using|package|#include|require)\b/.test(t) || /^\s*(?:else|end|fi|done|return;?|break;?|continue;?|pass)\s*$/.test(t);

function duplicateBlocks(S) {
  const code = S.files.filter((f) => f.status !== 'D' && f.lang && !f.binary && !f.class.generated && !S.isTest(f.path, 'head') && f.added.length >= WINDOW).slice(0, 200);
  if (!code.length) return;
  const index = new Map();
  const windows = (lines) => {
    const sig = [];
    lines.forEach((t, i) => { if (t != null && !trivialLine(t)) sig.push({ i, t: norm(t) }); });
    const out = [];
    for (let k = 0; k + WINDOW <= sig.length; k++) {
      const chunk = sig.slice(k, k + WINDOW);
      if (chunk.reduce((n, c) => n + c.t.length, 0) < 120) continue;
      out.push({ start: chunk[0].i + 1, end: chunk[WINDOW - 1].i + 1, h: sha256(chunk.map((c) => c.t).join('\n')) });
    }
    return out;
  };
  for (const f of code) {
    const lines = S.headLines(f.path);
    if (!lines || lines.length > 5000) continue;
    for (const w of windows(lines)) {
      if (!index.has(w.h)) index.set(w.h, []);
      index.get(w.h).push({ file: f.path, start: w.start, end: w.end });
    }
  }
  const reported = new Set();
  for (const f of code) {
    const added = lineSet(f.added);
    const addedLines = [];
    for (const a of f.added) addedLines[a.line - 1] = a.text;
    for (const w of windows(addedLines)) {
      const others = (index.get(w.h) || []).filter((o) => o.file !== f.path || o.end < w.start || o.start > w.end);
      if (!others.length || !added.has(w.start)) continue;
      const o = others[0];
      const key = [f.path, o.file].sort().join('|') + `|${Math.min(w.start, o.start)}`;
      if (reported.has(key) || [...reported].some((r) => r.startsWith(`${f.path}:`) && Math.abs(Number(r.split(':')[1]) - w.start) < WINDOW)) continue;
      reported.add(key);
      reported.add(`${f.path}:${w.start}`);
      S.add('CK-SCOPE', 'finding', f.path, w.start, `duplicated block (${WINDOW}+ lines) also at ${o.file}:${o.start}`, (S.headLines(f.path) || [])[w.start - 1] || '', { rule: 'scope.duplicate' });
    }
  }
}

function pythonShadowing(S) {
  const added = S.files.filter((f) => f.status === 'A' && /\.py$/.test(f.path));
  if (!added.length) return;
  const declared = new Map();
  for (const p of S.headFiles()) {
    if (!/(?:^|\/)(?:pyproject\.toml|requirements[\w.-]*\.txt|setup\.cfg|Pipfile)$/.test(p) || p.split('/').length > 3) continue;
    for (const d of parseManifest(p, S.read(S.to, p))?.deps || []) declared.set(normPypi(d.name).replace(/-/g, '_'), d.name);
  }
  if (!declared.size) return;
  const baseFiles = S.baseFiles();
  const seen = new Set();
  for (const f of added) {
    const parts = f.path.split('/');
    const rel = parts[0] === 'src' ? parts.slice(1) : parts;
    const mod = rel.length === 1 ? rel[0].replace(/\.py$/, '') : (rel[1] === '__init__.py' || rel.length > 1 ? rel[0] : null);
    if (!mod || seen.has(mod) || !declared.has(mod.toLowerCase())) continue;
    const prefix = parts[0] === 'src' ? `src/${mod}` : mod;
    if ([...baseFiles].some((b) => b === `${prefix}.py` || b.startsWith(`${prefix}/`))) continue;
    seen.add(mod);
    S.add('CK-SCOPE', 'finding', f.path, null, `new local module "${mod}" shadows the declared dependency "${declared.get(mod.toLowerCase())}"; imports now load the local copy (a stub can make tests pass)`, f.path, { rule: 'scope.shadow-dependency' });
  }
}

// ---------------------------------------------------------------------------
// Assembly

function buildChecks(S, ms) {
  const command = `git diff -U0 -M ${S.from} ${S.to}`;
  return Object.entries(CHECK_FM).map(([id, fm]) => {
    const own = S.findings.filter((f) => f.id === id);
    const top = own.reduce((m, f) => Math.max(m, SEVERITY_RANK[f.severity] ?? 0), 0);
    let status = top === 2 ? 'fail' : top === 1 ? 'finding' : 'pass';
    let reason;
    if (S.unverified[id]) { status = top === 2 ? 'fail' : 'unverified'; reason = S.unverified[id].code; }
    const data = { ...(S.check_data?.[id] || {}) };
    if (id === 'CK-SECRETS') Object.assign(data, { scanner: S.data.scanner, ...(S.data.scanner_error ? { scanner_error: S.data.scanner_error } : {}) });
    if (id === 'CK-LOCK') data.part = 'static';
    if (id === 'CK-SKIP') data.counts = S.counts.skips;
    if (id === 'CK-SUPPRESS') data.counts = S.counts.suppressions;
    if (id === 'CK-ASSERT') data.counts = S.counts.assertions;
    if (id === 'CK-TEST-DEL') data.counts = S.counts.tests;
    if (S.unverified[id]) data.error = S.unverified[id].message;
    const capped = own.length > MAX_FINDINGS_PER_CHECK ? own.slice(0, MAX_FINDINGS_PER_CHECK) : own;
    if (capped.length < own.length) data.truncated = own.length - capped.length;
    const isSecretsExternal = id === 'CK-SECRETS' && S.data.scanner_command;
    return {
      id, fm, project: '.', status, ...(reason ? { reason } : {}), cost: 0,
      command: isSecretsExternal ? S.data.scanner_command : command, cwd: toPosix(S.root),
      exit_code: isSecretsExternal ? (S.data.scanner_exit ?? null) : 0, duration_ms: ms,
      summary: S.summaries[id] || (S.unverified[id] ? `could not run: ${S.unverified[id].message}` : `${own.length} finding(s)`),
      output_sha256: sha256(asciiJson(own, 0)), artifacts: [], findings: capped, data,
    };
  });
}

/**
 * Run every diff-scoped check on `target` (from state.prepareTarget). `allow` globs mark paths as
 * in scope and exempt them from soft findings (never from failures or secrets).
 * Returns { base, tree_digest, snapshot, files, findings, counts, checks }.
 */
export async function diffScope({ target, detectResult = null, specPaths = null, allow = [], env = process.env, scanner = null } = {}) {
  const started = Date.now();
  const S = await makeState(target, detectResult, env);
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
      S.unverified[id] = { code: err.code || 'STEP_ERROR', message: truncate(redactLiterals(err.message || String(err), S.secrets), 200) };
    }
  }
  // --allow: in scope, and soft findings on those paths are dropped (failures and secrets stay).
  let allowed = 0;
  if (allow && allow.length) {
    S.findings = S.findings.filter((f) => {
      if (!f.file || f.severity === 'fail' || f.id === 'CK-SECRETS') return true;
      if (allow.some((g) => matchGlob(f.file, g))) { allowed++; return false; }
      return true;
    });
  }
  const ms = Date.now() - started;
  const checks = buildChecks(S, ms);
  const sev = (s) => S.findings.filter((f) => f.severity === s).length;
  return {
    base: { ref: target.base.ref, sha: target.base.sha, source: target.base.source },
    tree_digest: target.snapshot.tree,
    snapshot: target.snapshot.commit,
    files: S.files.map((f) => ({
      path: toPosix(f.status === 'D' ? f.old_path : f.path), ...(f.status === 'R' ? { old_path: toPosix(f.old_path) } : {}), status: f.status,
      added: f.added.length, removed: f.removed.length, binary: f.binary,
      class: Object.fromEntries(Object.entries(f.class).filter(([, v]) => v).map(([k]) => [k, true])),
      ...(S.isTest(f.status === 'D' ? f.old_path : f.path, f.status === 'D' ? 'base' : 'head') ? { test: true } : {}),
    })),
    findings: S.findings,
    counts: {
      files: S.files.length,
      added_lines: S.files.reduce((n, f) => n + f.added.length, 0),
      removed_lines: S.files.reduce((n, f) => n + f.removed.length, 0),
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

/** File and directory paths (or globs) a spec names, kept only when they exist in a tree. */
export function extractSpecPaths(text, treeFiles = null) {
  const out = new Set();
  const tokens = String(text ?? '').match(/[\w.@*{}\/-]*[\w*}](?:\/[\w.@*{},-]+)+\/?|[\w.-]+\.[A-Za-z][\w]{0,7}\b/g) || [];
  const files = treeFiles ? [...treeFiles] : null;
  for (const raw of tokens) {
    const t = raw.replace(/^\.\//, '').replace(/[.,:;]+$/, '');
    if (!t || /^https?:|^\w+:\/\//.test(t) || /^\d+(?:\.\d+)+$/.test(t)) continue;
    if (/[*?{]/.test(t)) { out.add(t); continue; }
    if (!files) { if (t.includes('/')) out.add(t.replace(/\/$/, '')); continue; }
    const s = t.replace(/\/$/, '');
    if (files.some((f) => f === s || f.startsWith(`${s}/`) || f.endsWith(`/${s}`))) {
      const exact = files.find((f) => f === s || f.startsWith(`${s}/`));
      out.add(exact ? s : files.find((f) => f.endsWith(`/${s}`)));
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
--spec      a spec/issue file; the paths it names define the expected scope (CK-SCOPE)
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
      const det = await import('./detect.mjs');
      if (typeof det.detect === 'function') detectResult = await det.detect({ root: target.root, stateInfo: ctx.dryRun ? null : target.state });
    } catch { /* detect.mjs not available or failed: heuristics only */ }
    let specPaths = null;
    if (values.spec) {
      const specFile = path.resolve(ctx.cwd, values.spec);
      const text = readText(specFile);
      if (text == null) throw usageError(`--spec file not found: ${toPosix(specFile)}`);
      specPaths = extractSpecPaths(text, new Set([...lsTree(target.root, target.snapshot.commit), ...(target.base.sha ? lsTree(target.root, target.base.sha) : [])]));
    }
    const res = await diffScope({ target, detectResult, specPaths, allow: values.allow || [] });
    if (specPaths) res.spec_paths = specPaths;
    const hard = res.findings.some((f) => f.severity === 'fail' || f.severity === 'finding');
    const unverified = res.checks.some((c) => c.status === 'unverified');
    const exit = hard ? EXIT.FINDINGS : unverified ? EXIT.UNVERIFIABLE : EXIT.OK;
    const human = [
      `diff-scope ${res.base.ref || 'empty tree'} (${String(res.base.sha || '').slice(0, 12) || '-'})..snapshot ${String(res.tree_digest).slice(0, 12)}: ${res.counts.files} file(s), +${res.counts.added_lines}/-${res.counts.removed_lines}`,
      ...res.checks.map((c) => `  ${c.id.padEnd(11)} ${c.status.padEnd(10)} ${c.summary}`),
      ...res.findings.filter((f) => f.severity !== 'info').slice(0, 60).map((f) => `  - [${f.severity}] ${f.id} ${f.file || ''}${f.line ? `:${f.line}` : ''} ${f.message}${f.evidence ? ` | ${f.evidence}` : ''}`),
    ].join('\n');
    const c = res.counts.findings;
    return { result: res, exit, summary: `${c.fail} fail, ${c.finding} finding(s), ${c.info} info on ${res.counts.files} file(s)`, human };
  },
});
