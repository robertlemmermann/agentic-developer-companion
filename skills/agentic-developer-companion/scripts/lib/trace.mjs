// Spec -> diff traceability (plan §9.5): requirement candidates extracted from a spec, the
// diff hunks of the working-tree snapshot, and the script-side evaluation of the matrix the
// model completes (CK-TRACE). Claimed statuses are checked against real file:line citations.

import fs from 'node:fs';
import path from 'node:path';
import {
  EXIT, usageError, defineCommand, readText, sha256, toPosix, relPosix, truncate, run, which,
  matchAny, writeFileAtomic, asciiJson,
} from './core.mjs';
import { git, emptyTree, showFile } from './git.mjs';

// state.prepareTarget, through evidence.prepareQaTarget's fallback when that module is present.
async function qaTarget(ctx, opts) {
  const ev = await import('./evidence.mjs');
  return ev.prepareQaTarget(ctx, opts);
}

export const TRACE_SCHEMA = 'adc-trace/1';
const MAX_SPEC_BYTES = 1024 * 1024;
const MAX_REQUIREMENTS = 200;
const MAX_HUNKS = 500;
const REQ_STATUSES = ['implemented', 'partial', 'missing', 'unknown', 'dismissed'];

// Default test-file globs (§7.4), used when neither detect nor markers is available.
export const DEFAULT_TEST_GLOBS = Object.freeze([
  '**/__tests__/**', '**/*.{test,spec}.*', '**/test_*.py', '**/*_test.py', '**/conftest.py',
  '**/*_test.go', '**/tests/**', '**/test/**', '**/spec/**', '**/src/test/**', '**/*Tests*/**',
  '**/*.Tests/**', '**/e2e/**', '**/cypress/**', '**/playwright/**',
]);

export const MATRIX_INSTRUCTIONS = Object.freeze([
  'For every requirement set status to implemented, partial, missing or unknown (weak candidates may be dismissed).',
  'List implementing code in evidence[] and the tests that exercise it in tests[], each as "path:line" or "path:start-end" in the snapshot.',
  'Map each diff hunk in extras[] to a requirement id with "requirement": "R1", or leave it null (it is then reported as extra functionality).',
  'You may append requirements the extractor missed; they count as strong requirements.',
  'Record the completed file with: evidence add <file> --ledger <ledger>. The script derives CK-TRACE; it never trusts a status without valid citations.',
]);

// ---------------------------------------------------------------------------
// Spec input

const GH_URL_RE = /^https?:\/\/[^/\s]+\/([^/\s]+)\/([^/\s]+)\/(issues|pull)\/(\d+)(?:[/?#].*)?$/;

/**
 * Read a spec given as a file path, `-` (stdin) or a GitHub issue/PR URL (via `gh`, when
 * installed and authenticated). Returns `{ ref, text, kind }`; throws a usage error otherwise.
 */
export function readSpecInput(ref, { cwd = process.cwd(), root = null } = {}) {
  const value = String(ref || '').trim();
  if (!value) throw usageError('--spec needs a file, "-" or an issue/PR URL');
  if (value === '-') {
    let text = '';
    try { text = fs.readFileSync(0, 'utf8'); } catch { text = ''; }
    if (!text.trim()) throw usageError('--spec - read nothing from stdin');
    return { ref: 'stdin', text: text.slice(0, MAX_SPEC_BYTES), kind: 'stdin' };
  }
  if (/^https?:\/\//i.test(value)) {
    const m = GH_URL_RE.exec(value);
    const gh = m ? which('gh') : null;
    if (m && gh) {
      const res = run(gh, [m[3] === 'pull' ? 'pr' : 'issue', 'view', value, '--json', 'title,body'], { timeoutMs: 30_000 });
      if (res.exit === 0) {
        try {
          const doc = JSON.parse(res.stdout);
          return { ref: value, text: `# ${doc.title || ''}\n\n${doc.body || ''}`.slice(0, MAX_SPEC_BYTES), kind: 'url' };
        } catch {}
      }
    }
    throw usageError(`could not read the spec from ${value}${m ? (gh ? ' with gh' : ' (gh is not installed)') : ''}; save the issue or PR text to a file and pass --spec <file>`);
  }
  const file = path.resolve(cwd, value);
  let stat;
  try { stat = fs.statSync(file); } catch { throw usageError(`spec file not found: ${toPosix(file)}`); }
  if (!stat.isFile()) throw usageError(`spec is not a file: ${toPosix(file)}`);
  const text = readText(file, '');
  const rel = root ? relPosix(root, file) : null;
  return { ref: rel && rel !== '.' ? rel : toPosix(file), text: text.slice(0, MAX_SPEC_BYTES), kind: 'file' };
}

// ---------------------------------------------------------------------------
// Requirement extraction

const EXCLUDED_SECTION = /\b(steps? to reproduce|reproduc\w*|environment|versions?|logs?|stack ?traces?|screenshots?|background|context|motivation|references?|links?|notes?|alternatives?|out[- ]of[- ]scope|non[- ]?goals?|related|faq|questions?|discussion|changelog|history|appendix)\b/i;
const REQUIREMENT_SECTION = /\b(acceptance|requirements?|criteria|definition of done|dod|deliverables?|tasks?|to-?dos?|checklist|expected|goals?|user stor(?:y|ies)|specification|spec|behaviou?r|features?|scope|must|should|changes?|proposal|solution)\b/i;
const STRONG_KEYWORD = /\b(must|shall|required|is required to|are required to)\b/i;
const SOFT_KEYWORD = /\b(should|needs? to|has to|have to)\b/i;
const ID_PREFIX = /^(?:\*\*|__)?\[?([A-Z][A-Z0-9]{0,9}-\d{1,5})\]?(?:\*\*|__)?\s*(?:[:.)-]|–|—)?\s+/;

function cleanText(s) {
  return String(s)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function sectionKind(title) {
  if (EXCLUDED_SECTION.test(title)) return 'excluded';
  if (REQUIREMENT_SECTION.test(title)) return 'requirement';
  return 'neutral';
}

/** Requirement candidates (numbered lists, checkboxes, must/should, acceptance sections, Gherkin). */
export function extractRequirements(text) {
  const lines = String(text || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  const seen = new Set();
  let section = { title: null, kind: 'neutral' };
  let fence = null;
  let inComment = false;
  let para = null;
  let scenario = null;
  let tableHeaderSeen = false;

  const add = (raw, line, kind, strength, extra = {}) => {
    let body = cleanText(raw);
    let sourceId = null;
    const idm = ID_PREFIX.exec(body);
    if (idm) { sourceId = idm[1]; body = body.slice(idm[0].length).trim(); }
    if (body.length < 4 || out.length >= MAX_REQUIREMENTS) return null;
    const key = body.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (!key || seen.has(key)) return null;
    seen.add(key);
    const req = {
      id: `R${out.length + 1}`, text: truncate(body, 400), line, kind, strength,
      section: section.title, ...(sourceId ? { source_id: sourceId } : {}), ...extra,
      status: 'unknown', evidence: [], tests: [], note: '',
    };
    out.push(req);
    return req;
  };
  const flushPara = () => {
    if (!para) return;
    const { text: ptext, starts } = para;
    para = null;
    if (section.kind === 'excluded') return;
    // Sentence ends are [.!?] followed by whitespace or the end, so "src/app.ts" stays whole.
    const re = /(?:[^.!?]|[.!?](?!\s|$))+[.!?]*/g;
    let m;
    while ((m = re.exec(ptext))) {
      const sentence = m[0].trim();
      if (!sentence) continue;
      const strong = STRONG_KEYWORD.test(sentence);
      const soft = SOFT_KEYWORD.test(sentence);
      if (!strong && !soft) continue;
      let line = starts[0][1];
      for (const [off, ln] of starts) if (off <= m.index) line = ln;
      add(sentence, line, 'keyword', strong || section.kind === 'requirement' ? 'strong' : 'weak');
    }
  };
  const flushScenario = () => {
    if (!scenario) return;
    const steps = scenario.steps.length ? `: ${scenario.steps.join(' ')}` : '';
    add(`Scenario: ${scenario.name}${steps}`, scenario.line, 'scenario', 'strong');
    scenario = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    let line = lines[i];
    const fm = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) { if (fm && fm[1][0] === fence[0] && fm[1].length >= fence.length) fence = null; continue; }
    if (fm) { flushPara(); flushScenario(); fence = fm[1]; continue; }
    if (inComment) {
      const end = line.indexOf('-->');
      if (end === -1) continue;
      inComment = false;
      line = line.slice(end + 3);
    }
    line = line.replace(/<!--.*?-->/g, '');
    const open = line.indexOf('<!--');
    if (open !== -1) { inComment = true; line = line.slice(0, open); }

    const trimmed = line.trim();
    if (!trimmed) { flushPara(); flushScenario(); tableHeaderSeen = false; continue; }

    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(trimmed)
      || /^(?:\*\*|__)([^*_].{0,78}?)(?:\*\*|__):?\s*$/.exec(trimmed)
      || /^([A-Z][A-Za-z /-]{2,40}):\s*$/.exec(trimmed);
    if (heading && (heading[2] || !STRONG_KEYWORD.test(heading[1]))) {
      flushPara(); flushScenario();
      const title = cleanText(heading[2] || heading[1]);
      section = { title, kind: sectionKind(title) };
      tableHeaderSeen = false;
      continue;
    }

    const sc = /^\s*Scenario(?: Outline)?:\s*(.+)$/i.exec(line);
    if (sc) { flushPara(); flushScenario(); scenario = { name: cleanText(sc[1]), line: lineNo, steps: [] }; continue; }
    if (scenario) {
      const step = /^\s*(Given|When|Then|And|But)\b\s*(.*)$/i.exec(line);
      if (step) { scenario.steps.push(`${step[1]} ${cleanText(step[2])}`); continue; }
      flushScenario();
    }
    if (/^\s*Feature:/i.test(line)) { flushPara(); continue; }

    if (/^\s*\|/.test(line)) {
      flushPara();
      if (/^\s*\|?\s*:?-{2,}/.test(line)) continue;
      if (!tableHeaderSeen) { tableHeaderSeen = true; continue; }
      if (section.kind !== 'requirement') continue;
      const cells = line.split('|').map((c) => c.trim()).filter(Boolean);
      if (cells.length) add(cells.join(' - '), lineNo, 'table', 'strong');
      continue;
    }

    const cb = /^\s*(?:[-*+]|\d+[.)])\s+\[( |x|X)\]\s+(.+)$/.exec(line);
    if (cb) {
      flushPara();
      if (section.kind !== 'excluded') add(cb[2], lineNo, 'checkbox', 'strong', { checked: cb[1] !== ' ' });
      continue;
    }
    const num = /^\s*(\d+)[.)]\s+(.+)$/.exec(line);
    if (num) {
      flushPara();
      if (section.kind === 'excluded') continue;
      const strong = section.kind === 'requirement' || STRONG_KEYWORD.test(num[2]) || SOFT_KEYWORD.test(num[2]);
      add(num[2], lineNo, 'numbered', strong ? 'strong' : 'weak');
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.+)$/.exec(line);
    if (bullet) {
      flushPara();
      if (section.kind === 'excluded') continue;
      if (section.kind === 'requirement') add(bullet[1], lineNo, 'bullet', 'strong');
      else if (STRONG_KEYWORD.test(bullet[1])) add(bullet[1], lineNo, 'keyword', 'strong');
      else if (SOFT_KEYWORD.test(bullet[1])) add(bullet[1], lineNo, 'keyword', 'weak');
      continue;
    }
    if (/^\s*>/.test(line)) line = line.replace(/^\s*>\s?/, '');
    if (!para) para = { text: '', starts: [] };
    if (para.text) para.text += ' ';
    para.starts.push([para.text.length, lineNo]);
    para.text += line.trim();
  }
  flushPara();
  flushScenario();
  return out;
}

/** Path-like tokens named in the spec (for CK-SCOPE's files-vs-spec comparison), or null. */
export function specPaths(text) {
  const found = new Set();
  const add = (p) => {
    const s = toPosix(p).replace(/^\.\//, '').replace(/[),.;:]+$/, '');
    if (!s || s.length > 200 || /^[a-z]+:\/\//i.test(s) || s.startsWith('/') || s.includes('..')) return;
    if (!/[/.]/.test(s) || /\s/.test(s)) return;
    if (!/\.[A-Za-z0-9]{1,8}$/.test(s) && !s.includes('/')) return;
    found.add(s);
  };
  const body = String(text || '');
  for (const m of body.matchAll(/`([^`\n]{2,200})`/g)) {
    const t = m[1].trim();
    if (/^[\w@.*{}\-/]+$/.test(t) && (t.includes('/') || /\.[A-Za-z0-9]{1,8}$/.test(t))) add(t);
  }
  for (const m of body.matchAll(/(?:^|[\s(])((?:[\w@.-]+\/)+[\w@.*-]+(?:\.[A-Za-z0-9]{1,8})?)(?=$|[\s),;:])/gm)) add(m[1]);
  const list = [...found].filter((p) => !/^\d+(\.\d+)+$/.test(p)).slice(0, 100);
  return list.length ? list : null;
}

// ---------------------------------------------------------------------------
// Diff hunks

const unquote = (s) => (s.startsWith('"') && s.endsWith('"') ? (() => { try { return JSON.parse(s); } catch { return s.slice(1, -1); } })() : s);

function isTrivialLine(t) {
  return /^\s*$/.test(t) || /^\s*[{}()[\];,]+\s*$/.test(t)
    || /^\s*(import\b|from\s+\S+\s+import\b|#include\b|using\s+[\w.]+\s*;|use\s+[\w:{}, ]+;|package\s+[\w.]+\s*;?|require\s*\()/.test(t);
}

/** Zero-context hunks between two revisions: [{ key, file, status, kind, start, end, old_start, after_line, added, removed, trivial, preview, text }]. */
export function diffHunks(root, from, to) {
  const out = git(root, ['-c', 'core.quotePath=false', 'diff', '-U0', '-M', '--no-color', '--no-ext-diff', '--no-textconv', from, to, '--']);
  const hunks = [];
  let file = null;
  let cur = null;
  const push = () => {
    if (!cur) return;
    const h = cur;
    cur = null;
    const lines = h.newCount > 0 ? h.addedText : h.removedText;
    const preview = (h.addedText.find((t) => t.trim()) || h.removedText.find((t) => t.trim()) || '').trim();
    hunks.push({
      key: h.newCount > 0 ? `${h.file}:${h.newStart}-${h.newStart + h.newCount - 1}` : `${h.file}:-${h.oldStart}`,
      file: h.file, status: file.status, kind: h.newCount > 0 ? (h.oldCount > 0 ? 'change' : 'addition') : 'deletion',
      start: h.newCount > 0 ? h.newStart : null, end: h.newCount > 0 ? h.newStart + h.newCount - 1 : null,
      old_start: h.oldCount > 0 ? h.oldStart : null, after_line: h.newCount > 0 ? null : h.newStart,
      added: h.newCount, removed: h.oldCount, trivial: lines.every(isTrivialLine),
      preview: truncate(preview, 120), text: truncate(lines.join('\n'), 2000),
    });
  };
  for (const raw of String(out).split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('diff --git ')) {
      push();
      const m = /^diff --git (?:"?a\/)(.+?)"? (?:"?b\/)(.+?)"?$/.exec(line);
      file = { path: m ? m[2] : null, oldPath: m ? m[1] : null, status: 'M', binary: false, hunks: 0 };
      continue;
    }
    if (!file) continue;
    if (line.startsWith('@@')) {
      push();
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) continue;
      file.hunks++;
      cur = {
        file: toPosix(file.path || file.oldPath), oldStart: Number(m[1]), oldCount: m[2] == null ? 1 : Number(m[2]),
        newStart: Number(m[3]), newCount: m[4] == null ? 1 : Number(m[4]), addedText: [], removedText: [],
      };
      continue;
    }
    if (cur) {
      if (line.startsWith('+')) cur.addedText.push(line.slice(1));
      else if (line.startsWith('-')) cur.removedText.push(line.slice(1));
      continue;
    }
    if (line.startsWith('new file mode')) file.status = 'A';
    else if (line.startsWith('deleted file mode')) file.status = 'D';
    else if (line.startsWith('rename from ')) { file.status = 'R'; file.oldPath = line.slice(12); }
    else if (line.startsWith('rename to ')) file.path = line.slice(10);
    else if (line.startsWith('--- ')) { const p = unquote(line.slice(4).trim()); if (p !== '/dev/null') file.oldPath = p.replace(/^a\//, ''); }
    else if (line.startsWith('+++ ')) { const p = unquote(line.slice(4).trim()); file.path = p === '/dev/null' ? file.oldPath : p.replace(/^b\//, ''); }
    else if (line.startsWith('Binary files ')) {
      file.binary = true;
      const f = toPosix(file.path || file.oldPath);
      hunks.push({ key: `${f}:binary`, file: f, status: file.status, kind: 'binary', start: null, end: null, old_start: null, after_line: null, added: 0, removed: 0, trivial: false, preview: '', text: '' });
    }
  }
  push();
  return { hunks: hunks.slice(0, MAX_HUNKS), truncated: Math.max(0, hunks.length - MAX_HUNKS) };
}

// ---------------------------------------------------------------------------
// Hints (requirement <-> hunk word overlap; a suggestion for the model, never evidence)

const STOP = new Set(('this that with from have must should shall will when then given which their there into each also only more '
  + 'than such used able make sure does what where while after before would could about other some them they been were '
  + 'being your file files code test tests line lines need needs true false null none like just same very well data value').split(' '));

function tokens(s) {
  const spaced = String(s || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return new Set((spaced.match(/[a-z][a-z0-9]{3,}|\d{3,}/g) || []).filter((t) => !STOP.has(t)).map((t) => t.replace(/(?:es|s)$/, '')));
}

function hintsFor(hunk, reqTokens) {
  const ht = tokens(`${hunk.file} ${hunk.text}`);
  const scored = [];
  for (const [id, set] of reqTokens) {
    let n = 0;
    for (const t of set) if (ht.has(t)) n++;
    if (n >= 1) scored.push([id, n]);
  }
  return scored.sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id]) => id);
}

// ---------------------------------------------------------------------------
// Skeleton

async function redactor() {
  try {
    const ev = await import('./evidence.mjs');
    if (typeof ev.makeRedactor === 'function') return await ev.makeRedactor();
  } catch {}
  return (s) => s;
}

/** The traceability skeleton the model completes: requirement candidates + diff hunks + a pending CK-TRACE. */
export async function trace({ target, specText, specPath = null }) {
  const redact = await redactor();
  const text = String(specText || '');
  const requirements = extractRequirements(text).map((r) => ({ ...r, text: redact(r.text) }));
  const from = target.base.sha || emptyTree(target.root);
  const { hunks, truncated } = diffHunks(target.root, from, target.snapshot.commit);
  const reqTokens = requirements.map((r) => [r.id, tokens(r.text)]);
  const extras = hunks.map(({ text: _t, ...h }) => ({ ...h, preview: redact(h.preview), hint: hintsFor({ ...h, text: _t }, reqTokens), requirement: null }));
  const strong = requirements.filter((r) => r.strength === 'strong').length;
  const summary = requirements.length
    ? `${requirements.length} requirement candidate(s) (${strong} strong), ${hunks.length} diff hunk(s); the matrix is not completed yet`
    : `no requirement candidates found in the spec; ${hunks.length} diff hunk(s); add the requirements to the matrix yourself`;
  return {
    schema: TRACE_SCHEMA,
    spec: { path: specPath, sha256: sha256(text), lines: text ? text.split(/\r?\n/).length : 0 },
    base: target.base.sha, base_ref: target.base.ref, tree_digest: target.snapshot.tree, snapshot_commit: target.snapshot.commit,
    requirements, extras, hunks_total: hunks.length, hunks_truncated: truncated,
    instructions: [...MATRIX_INSTRUCTIONS],
    checks: [{
      id: 'CK-TRACE', fm: ['FM-14', 'FM-11'], project: '.', status: 'unverified', reason: 'AWAITING_MATRIX', pending: true,
      cost: 0, command: null, cwd: null, exit_code: null, duration_ms: null, summary, output_sha256: null, artifacts: [],
      findings: [], data: { requirements: requirements.length, strong, hunks: hunks.length, spec: specPath },
    }],
  };
}

// ---------------------------------------------------------------------------
// Citations

/** Parse "path:12", "path:12-20", "path:12:5" or "path#L12-L20" into { file, start, end }; null when malformed. */
export function parseCitation(raw) {
  const s = String(raw == null ? '' : raw).trim().replace(/^`+|`+$/g, '');
  const m = /^(.+?)#L(\d+)(?:-L?(\d+))?$/.exec(s) || /^(.+?):(\d+)(?:-(\d+)|:\d+)?$/.exec(s);
  if (!m) return null;
  const file = toPosix(m[1]).replace(/^\.\//, '');
  if (!file || file.startsWith('/') || /^[A-Za-z]:/.test(file) || file.split('/').includes('..') || /\s$/.test(file)) return null;
  const start = Number(m[2]);
  const end = m[3] ? Number(m[3]) : start;
  if (!(start >= 1) || !(end >= start)) return null;
  return { file, start, end };
}

/** Returns check(raw) -> { ok, reason?, citation? }; validates against `tree` when root and tree are given. */
export function citationChecker(root, tree) {
  const lineCounts = new Map();
  return (raw) => {
    const citation = parseCitation(raw);
    if (!citation) return { ok: false, reason: 'BAD_CITATION' };
    if (!root || !tree) return { ok: true, citation, checked: false };
    if (!lineCounts.has(citation.file)) {
      const text = showFile(root, tree, citation.file);
      lineCounts.set(citation.file, text == null ? null : text.split('\n').length - (text.endsWith('\n') ? 1 : 0));
    }
    const n = lineCounts.get(citation.file);
    if (n == null) return { ok: false, reason: 'FILE_NOT_IN_SNAPSHOT', citation };
    if (citation.end > Math.max(n, 1)) return { ok: false, reason: 'LINE_OUT_OF_RANGE', citation };
    return { ok: true, citation, checked: true };
  };
}

async function defaultTestMatcher() {
  try {
    const m = await import('./markers.mjs');
    if (typeof m.classifyPath === 'function') {
      return (file) => {
        try { if (m.classifyPath(file).test) return true; } catch {}
        return matchAny(file, DEFAULT_TEST_GLOBS);
      };
    }
  } catch {}
  return (file) => matchAny(file, DEFAULT_TEST_GLOBS);
}

const arr = (v) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]);

function hits(cit, hunk) {
  if (cit.file !== hunk.file) return false;
  if (hunk.start != null) return cit.start <= hunk.end && cit.end >= hunk.start;
  if (hunk.after_line != null) return cit.start <= hunk.after_line + 1 && cit.end >= hunk.after_line;
  return false;
}

// ---------------------------------------------------------------------------
// Matrix evaluation

/**
 * Evaluate a completed matrix against the snapshot: citations must exist, requirements dropped
 * from the skeleton count as unknown, unmapped non-trivial hunks are extra functionality.
 * Returns { requirements, extras, counts, status, reason, summary, findings }.
 */
export async function evaluateMatrix({ root, base, commit, tree, matrix, skeleton = null, isTestFile = null }) {
  if (!matrix || typeof matrix !== 'object' || !Array.isArray(matrix.requirements)) {
    throw usageError('a traceability matrix needs a "requirements" array');
  }
  const isTest = isTestFile || await defaultTestMatcher();
  const check = citationChecker(root, tree);
  const skeletonReqs = skeleton && Array.isArray(skeleton.requirements) ? skeleton.requirements : [];
  const reqs = [];
  const seen = new Set();
  for (const raw of matrix.requirements.slice(0, MAX_REQUIREMENTS)) {
    if (!raw || typeof raw !== 'object') continue;
    const id = String(raw.id || `M${reqs.length + 1}`).slice(0, 40);
    if (seen.has(id)) continue;
    seen.add(id);
    const sk = skeletonReqs.find((r) => r.id === id);
    const strength = sk ? sk.strength : 'strong';
    const claimed = REQ_STATUSES.includes(String(raw.status || '').toLowerCase()) ? String(raw.status).toLowerCase() : 'unknown';
    const valid = [];
    const invalid = [];
    const take = (list, role) => {
      for (const c of arr(list).slice(0, 50)) {
        const r = check(c);
        if (r.ok) valid.push({ ...r.citation, raw: String(c), role: role === 'test' || isTest(r.citation.file) ? 'test' : 'impl' });
        else invalid.push({ citation: truncate(String(c), 200), reason: r.reason });
      }
    };
    take([...arr(raw.evidence), ...arr(raw.implementation), ...arr(raw.files)], 'impl');
    take(raw.tests, 'test');
    let status = claimed;
    let note = truncate(String(raw.note || ''), 300);
    if (claimed === 'dismissed' && strength !== 'weak') {
      status = 'unknown';
      note = 'a strong requirement cannot be dismissed; mark it missing, or waive CK-TRACE with a spec quote';
    } else if ((claimed === 'implemented' || claimed === 'partial') && valid.length === 0) {
      status = 'missing';
      note = 'claimed implemented but no valid file:line citation was given';
    }
    reqs.push({
      id, text: sk ? sk.text : truncate(String(raw.text || ''), 400), strength, kind: sk ? sk.kind : 'model',
      claimed_status: claimed, status, evidence: valid.filter((v) => v.role === 'impl').map((v) => v.raw),
      tests: valid.filter((v) => v.role === 'test').map((v) => v.raw), invalid_citations: invalid,
      tested: valid.some((v) => v.role === 'test'), hunks: arr(raw.hunks).map(String).slice(0, 100), note, _valid: valid,
    });
  }
  for (const sk of skeletonReqs) {
    if (seen.has(sk.id)) continue;
    reqs.push({
      id: sk.id, text: sk.text, strength: sk.strength, kind: sk.kind, claimed_status: null, status: 'unknown', evidence: [], tests: [],
      invalid_citations: [], tested: false, hunks: [], note: 'missing from the completed matrix', _valid: [],
    });
  }

  const { hunks } = diffHunks(root, base || emptyTree(root), commit);
  const live = new Set(reqs.filter((r) => r.status === 'implemented' || r.status === 'partial').map((r) => r.id));
  const explicit = new Map();
  for (const e of arr(matrix.extras)) if (e && e.key && e.requirement) explicit.set(String(e.key), String(e.requirement));
  for (const r of reqs) for (const k of r.hunks) if (!explicit.has(k)) explicit.set(k, r.id);
  const extras = [];
  let mapped = 0;
  for (const h of hunks) {
    const ex = explicit.get(h.key);
    const byCitation = reqs.some((r) => live.has(r.id) && r._valid.some((v) => hits(v, h)));
    if ((ex && live.has(ex)) || byCitation) { mapped++; continue; }
    if (h.trivial) continue;
    extras.push({ key: h.key, file: h.file, start: h.start, end: h.end, kind: h.kind, added: h.added, removed: h.removed, preview: h.preview });
  }

  const counts = { requirements: reqs.length, implemented: 0, partial: 0, missing: 0, unknown: 0, dismissed: 0, untested: 0, extras: extras.length, mapped_hunks: mapped, hunks: hunks.length, invalid_citations: 0 };
  const findings = [];
  for (const r of reqs) {
    counts[r.status]++;
    counts.invalid_citations += r.invalid_citations.length;
    if (r.status === 'missing') findings.push({ id: 'CK-TRACE', severity: 'fail', file: null, line: null, rule: r.id, message: `missing functionality: ${r.id} ${truncate(r.text, 160)}${r.note ? ` (${r.note})` : ''}`, evidence: '' });
    else if (r.status === 'unknown') findings.push({ id: 'CK-TRACE', severity: 'finding', file: null, line: null, rule: r.id, message: `not judged: ${r.id} ${truncate(r.text, 160)}${r.note ? ` (${r.note})` : ''}`, evidence: '' });
    else if (r.status === 'partial') findings.push({ id: 'CK-TRACE', severity: 'finding', file: null, line: null, rule: r.id, message: `partially implemented: ${r.id} ${truncate(r.text, 160)}`, evidence: r.evidence.join(', ') });
    if ((r.status === 'implemented' || r.status === 'partial') && !r.tested) {
      counts.untested++;
      findings.push({ id: 'CK-TRACE', severity: 'info', file: null, line: null, rule: r.id, message: `no test cited for ${r.id}`, evidence: '' });
    }
    for (const bad of r.invalid_citations) findings.push({ id: 'CK-TRACE', severity: 'info', file: null, line: null, rule: r.id, message: `invalid citation for ${r.id}: ${bad.reason}`, evidence: bad.citation });
  }
  for (const e of extras) findings.push({ id: 'CK-TRACE', severity: 'finding', file: e.file, line: e.start, message: `extra functionality: hunk ${e.key} is not mapped to any requirement`, evidence: e.preview });

  let status;
  let reason = null;
  if (counts.requirements === 0) { status = 'unverified'; reason = 'NO_REQUIREMENTS'; }
  else if (counts.missing) status = 'fail';
  else if (counts.unknown) { status = 'unverified'; reason = 'TRACE_INCOMPLETE'; }
  else if (counts.partial || counts.extras) status = 'finding';
  else status = 'pass';
  const summary = `${counts.implemented}/${counts.requirements - counts.dismissed} implemented, ${counts.partial} partial, ${counts.missing} missing, `
    + `${counts.unknown} not judged; ${counts.extras} unmapped hunk(s) of ${counts.hunks}; ${counts.untested} without a cited test`;
  return {
    requirements: reqs.map(({ _valid, ...r }) => r), extras, counts, status, reason, summary, findings,
  };
}

// ---------------------------------------------------------------------------
// Markdown

const cell = (s) => truncate(String(s == null ? '' : s).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|'), 160);

/** Markdown matrix for a skeleton or an evaluated matrix. */
export function renderTraceMarkdown(m) {
  const reqs = Array.isArray(m && m.requirements) ? m.requirements : [];
  const extras = Array.isArray(m && m.extras) ? m.extras : [];
  const out = ['# Traceability matrix', ''];
  if (m && m.status) out.push(`CK-TRACE: **${m.status}**${m.reason ? ` (${m.reason})` : ''}. ${m.summary || ''}`, '');
  out.push('| Req | Requirement | Status | Implementation | Tests |', '|---|---|---|---|---|');
  for (const r of reqs) {
    out.push(`| ${cell(r.id)}${r.strength === 'weak' ? ' (weak)' : ''} | ${cell(r.text)} | ${cell(r.status)} | ${cell(arr(r.evidence).join(', '))} | ${cell(arr(r.tests).join(', '))} |`);
  }
  if (!reqs.length) out.push('| - | no requirements | - | - | - |');
  const missing = reqs.filter((r) => r.status === 'missing');
  if (missing.length) {
    out.push('', '## Missing functionality', '');
    for (const r of missing) out.push(`- ${r.id}: ${cell(r.text)}${r.note ? ` (${cell(r.note)})` : ''}`);
  }
  const listed = m && m.status ? extras : extras.filter((e) => !e.requirement);
  out.push('', m && m.status ? '## Extra functionality (hunks mapped to no requirement)' : '## Diff hunks to map', '');
  if (!listed.length) out.push('None.');
  else {
    out.push('| Hunk | Kind | Preview | Hint |', '|---|---|---|---|');
    for (const e of listed.slice(0, 200)) out.push(`| ${cell(e.key)} | ${cell(e.kind)} | ${cell(e.preview ? `\`${e.preview}\`` : '')} | ${cell(arr(e.hint).join(', '))} |`);
    if (listed.length > 200) out.push('', `(${listed.length - 200} more)`);
  }
  out.push('');
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// CLI

/** `trace --spec <file|-|url>` (skeleton) or `trace --matrix <file>` (evaluation). */
export const traceCommand = defineCommand({
  name: 'trace',
  usage: [
    'trace --spec <file|-|issue-url> [--base <ref>] [--out <file>] [--md]',
    'trace --matrix <completed.json> [--base <ref>] [--md]',
    '',
    'Without --matrix: print the traceability skeleton (requirement candidates + diff hunks).',
    'With --matrix: evaluate a completed matrix against the current snapshot (exit 1 on missing',
    'or extra functionality, 4 when requirements are not judged). Record it in a ledger with',
    '`evidence add <file>`.',
  ].join('\n'),
  options: { spec: { type: 'string' }, base: { type: 'string' }, matrix: { type: 'string' }, out: { type: 'string' }, md: { type: 'boolean' } },
  positionals: false,
  run: async (ctx, values) => {
    if (!values.spec && !values.matrix) throw usageError('trace needs --spec <file|-|url> or --matrix <file>');
    if (values.spec && values.matrix) throw usageError('use either --spec or --matrix');
    if (values.matrix) {
      const file = path.resolve(ctx.cwd, values.matrix);
      const text = values.matrix === '-' ? fs.readFileSync(0, 'utf8') : readText(file);
      if (text == null) throw usageError(`matrix file not found: ${toPosix(file)}`);
      let matrix;
      try { matrix = JSON.parse(text); } catch { throw usageError('the matrix is not valid JSON'); }
      const target = await qaTarget(ctx, { base: values.base || matrix.base_ref || null, createState: false });
      const ev = await evaluateMatrix({ root: target.root, base: target.base.sha, commit: target.snapshot.commit, tree: target.snapshot.tree, matrix });
      const stale = Boolean(matrix.tree_digest && matrix.tree_digest !== target.snapshot.tree);
      const result = { schema: TRACE_SCHEMA, tree_digest: target.snapshot.tree, stale, ...ev };
      const exit = ev.status === 'pass' ? EXIT.OK : ev.status === 'unverified' ? EXIT.UNVERIFIABLE : EXIT.FINDINGS;
      return { result, exit, human: renderTraceMarkdown(ev), summary: `CK-TRACE ${ev.status}: ${ev.summary}${stale ? ' (working tree changed since the skeleton)' : ''}` };
    }
    const target = await qaTarget(ctx, { base: values.base || null, createState: false });
    const spec = readSpecInput(values.spec, { cwd: ctx.cwd, root: target.root });
    const skeleton = await trace({ target, specText: spec.text, specPath: spec.ref });
    let written = null;
    if (values.out) {
      written = path.resolve(ctx.cwd, values.out);
      if (!ctx.dryRun) writeFileAtomic(written, asciiJson(skeleton) + '\n');
    }
    const result = { ...skeleton, ...(written ? { written: toPosix(written), dry_run: ctx.dryRun } : {}) };
    return {
      result, exit: EXIT.OK, human: values.md ? renderTraceMarkdown(skeleton) : asciiJson(result),
      summary: skeleton.checks[0].summary,
    };
  },
});
