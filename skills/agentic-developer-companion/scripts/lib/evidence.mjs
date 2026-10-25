// Evidence ledger (plan §9.2): tamper-evident entries chained with the session nonce (§7.3),
// derived claim status, quoted-spec waivers, verdict rules (§9.1), staleness against a fresh
// snapshot (§7.5), metrics (§10.6), generated Markdown (D12) and yes/no/unknown answer
// scoring for audit-tests and review (§9.3, §9.4).

import fs from 'node:fs';
import path from 'node:path';
import {
  EXIT, AdcError, usageError, unverifiable, defineCommand, defineGroup, readText, writeFileAtomic,
  writeJsonAtomic, withLock, sha256, nonce, nowIso, stamp, today, toPosix, relPosix, ensureDir, truncate,
  redactLiterals, runShell, generatedBy, ADC_SCRIPT, readJson, IS_WINDOWS, tmpRoot,
} from './core.mjs';
import { requireRepo, repoRoot, gitTry, git, gitRaw, headSha, gitPath, resolveBase, checkIgnore } from './git.mjs';
import { prepareStateDir, statePaths, newestOpenSession, readSession, appendMetrics, snapshotExcludes } from './state.mjs';
import { citationChecker, evaluateMatrix, renderTraceMarkdown, readSpecInput } from './trace.mjs';

export const SCHEMA = 'adc-evidence/1';
export const STATUSES = Object.freeze(['pass', 'fail', 'finding', 'skipped', 'unverified', 'pass-with-baseline']);
export const VERDICTS = Object.freeze(['PASS', 'PASS-WITH-FINDINGS', 'FAIL', 'UNVERIFIED']);
export const TOOLS = Object.freeze(['copilot-cli', 'vscode', 'copilot-cloud', 'claude-code', 'codex', 'unknown']);
export const CHECK_ID_RE = /^CK-[A-Z0-9][A-Z0-9-]{0,40}$/;

/** Failure modes per check (Appendix A); used when a check arrives without `fm`. */
export const CHECK_FM = Object.freeze({
  'CK-SCOPE': ['FM-11'], 'CK-TEST-DEL': ['FM-01'], 'CK-SKIP': ['FM-01'], 'CK-ASSERT': ['FM-01', 'FM-03'],
  'CK-TEST-CFG': ['FM-01', 'FM-06'], 'CK-SUPPRESS': ['FM-05'], 'CK-CI': ['FM-06'], 'CK-SWALLOW': ['FM-07'],
  'CK-SECRETS': ['FM-09'], 'CK-DEPS': ['FM-04'], 'CK-LOCK': ['FM-12'], 'CK-TYPES': ['FM-04'],
  'CK-CLEANRUN': ['FM-02', 'FM-13'], 'CK-COVERAGE': ['FM-03'], 'CK-MUTATION': ['FM-03', 'FM-16'],
  'CK-FLAKE': ['FM-13'], 'CK-RETRY': ['FM-13'], 'CK-TRACE': ['FM-14', 'FM-11'], 'CK-REVIEW': ['FM-15', 'FM-16'],
  'CK-CLAIMS': ['FM-02'], 'CK-REDGREEN': ['FM-03'], 'CK-MOCK': ['FM-08'], 'CK-LIVE': ['FM-02'],
});

// Soft checks report findings but never fail the verdict by themselves (§9.1 table).
const SOFT = new Set(['CK-SCOPE', 'CK-SWALLOW', 'CK-COVERAGE', 'CK-MUTATION', 'CK-FLAKE', 'CK-MOCK', 'CK-RETRY']);
// Optional probes: when they cannot run, the verdict is not UNVERIFIED (the gap is reported).
const OPTIONAL = new Set(['CK-COVERAGE', 'CK-MUTATION', 'CK-FLAKE']);
// Facts, not judgment calls: no spec quote can excuse them.
const NON_WAIVABLE = new Set(['CK-SECRETS', 'CK-CLEANRUN', 'CK-TYPES', 'CK-DEPS', 'CK-LOCK', 'CK-REDGREEN', 'CK-LIVE', 'CK-CLAIMS', 'CK-REVIEW']);
// Owned by the scripted steps; `evidence add --run` cannot record them (a narrowed command is not a clean run).
const SCRIPTED = new Set(Object.keys(CHECK_FM).filter((id) => id !== 'CK-REVIEW'));
const RANK = { skipped: 0, pass: 1, 'pass-with-baseline': 2, finding: 3, unverified: 4, fail: 5 };
const SHORTFALL_REASONS = new Set(['COUNT_SHORTFALL', 'EXECUTED_SHORTFALL', 'SHORTFALL', 'FEWER_TESTS', 'EXECUTED_DROPPED']);
const MAX_FINDINGS = 200;
const MAX_DATA_CHARS = 256 * 1024;
const MAX_CLAIMS = 100;
const HEADER_KEYS = ['schema', 'tool', 'mode', 'session_id', 'session_source', 'repo', 'base', 'base_ref', 'base_source',
  'tree_digest', 'snapshot_commit', 'head', 'spec', 'spec_sha256', 'spec_copy', 'spec_copy_sha256', 'effective_test_globs',
  'projects_summary', 'options', 'created_at', 'generated_by'];
// Fields recomputed on every write; excluded from entry hashes.
const DERIVED_KEYS = { checks: [], waivers: [], claims: ['status'] };
const HASH_KEY_RE = /(?:sha256|^tree_digest$|^session_nonce$|^snapshot_commit$|^base$|^head$|^prev$|^tip$|^sha$|^tree$|^commit$)$/;

const arr = (v) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]);
// Repository a ledger belongs to: explicit, else the one containing the ledger, else the cwd's.
const rootFor = (file, root) => root || repoRoot(path.dirname(file)) || requireRepo(process.cwd());
const posixRef = (root, file) => {
  const rel = root ? relPosix(root, file) : null;
  return rel && rel !== '.' ? rel : toPosix(file);
};

// ---------------------------------------------------------------------------
// Snapshot target: git.createSnapshot / state.prepareTarget with two fixes (reported upstream)
//
// 1. git.createSnapshot passes `:(top,exclude).adc` to `git add -A`; Git (2.43 here) exits 1 with
//    "paths are ignored" once `.adc/` is ignored, which prepareStateDir itself arranges. Ignored
//    paths are never added by `git add -A`, so exclude pathspecs are kept only for state dirs that
//    are not ignored (no state file is ever hashed) and every state dir is then removed from the
//    temporary index.
// 2. Copying the index gives the copy a new mtime. Git trusts the stat data of entries older than
//    the index file, so a same-size edit made in the timestamp tick of the last index write is
//    missed ("racy git"; about 4 in 100 snapshots in a tight loop). Backdating the copy keeps Git
//    re-checking those entries by content.

const SNAPSHOT_IDENT = {
  GIT_AUTHOR_NAME: 'agentic-developer-companion', GIT_AUTHOR_EMAIL: 'adc@localhost',
  GIT_COMMITTER_NAME: 'agentic-developer-companion', GIT_COMMITTER_EMAIL: 'adc@localhost',
};

/** Working-tree snapshot (§7.5) as `{ tree, commit, head }`; the user's index and working tree are untouched. */
export function createQaSnapshot(root, { exclude = ['.adc'] } = {}) {
  const head = headSha(root);
  const tmpIndex = path.join(ensureDir(tmpRoot(root)), `index-${nonce()}`);
  const env = { GIT_INDEX_FILE: tmpIndex };
  const clean = exclude.filter(Boolean).map((p) => toPosix(p).replace(/\/+$/, ''));
  try {
    const realIndex = gitPath(root, 'index');
    if (fs.existsSync(realIndex)) {
      fs.copyFileSync(realIndex, tmpIndex);
      const back = new Date(fs.statSync(realIndex).mtimeMs - 2000);
      fs.utimesSync(tmpIndex, back, back);
    } else if (head) git(root, ['read-tree', 'HEAD'], { env });
    const keep = clean.filter((p) => !checkIgnore(root, p));
    git(root, ['add', '-A', '--', '.', ...keep.map((p) => `:(top,exclude)${p}`)], { env, timeoutMs: 600_000 });
    for (const p of clean) gitRaw(root, ['rm', '-r', '--cached', '--quiet', '--ignore-unmatch', '--', `:(top)${p}`], { env });
    const tree = git(root, ['write-tree'], { env });
    const commit = git(root, ['commit-tree', tree, ...(head ? ['-p', head] : []), '-m', 'agentic-developer-companion snapshot'],
      { env: { ...env, ...SNAPSHOT_IDENT } });
    return { tree, commit, head };
  } finally {
    fs.rmSync(tmpIndex, { force: true });
    fs.rmSync(`${tmpIndex}.lock`, { force: true });
  }
}

/** state.prepareTarget built on createQaSnapshot. Returns { root, state, base, snapshot }. */
export async function prepareQaTarget(ctx, { base = null, snapshot = null, createState = true } = {}) {
  const root = requireRepo(ctx.cwd);
  const state = prepareStateDir({ ...ctx, cwd: root }, { create: createState });
  const b = resolveBase(root, base);
  return { root, state, base: b, snapshot: snapshot || createQaSnapshot(root, { exclude: snapshotExcludes(state) }) };
}

// ---------------------------------------------------------------------------
// Host identity

/** Host that runs this command, from environment markers (§8.4); 'unknown' when none is set. */
export function detectTool(env = process.env) {
  const on = (k) => Boolean(env[k]) && env[k] !== '0' && env[k] !== 'false';
  if (on('COPILOT_AGENT_PROMPT') || on('GITHUB_COPILOT_API_TOKEN')) return 'copilot-cloud';
  if (on('CLAUDECODE') || on('CLAUDE_CODE_ENTRYPOINT')) return 'claude-code';
  if (['CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED', 'CODEX_THREAD_ID'].some(on)) return 'codex';
  if (on('COPILOT_CLI')) return 'copilot-cli';
  // Heuristic: an integrated VS Code terminal; the Copilot harness sets no documented marker.
  if (env.TERM_PROGRAM === 'vscode' || on('VSCODE_IPC_HOOK_CLI')) return 'vscode';
  return 'unknown';
}

function checkTool(value) {
  if (value == null) return null;
  const t = String(value).toLowerCase();
  if (!TOOLS.includes(t)) throw usageError(`--tool must be one of ${TOOLS.join(', ')}`);
  return t;
}

// ---------------------------------------------------------------------------
// Secret redaction (every string written under .adc/ passes through it, §7.3)

const FALLBACK_SECRET_PATTERNS = [
  { id: 'aws-access-key-id', re: new RegExp('\\b(?:AKIA|ASIA)[0-9A-Z]{16}\\b', 'g') },
  { id: 'github-token', re: new RegExp('\\bgh[pousr]_[A-Za-z0-9]{36,}', 'g') },
  { id: 'github-pat', re: new RegExp('\\bgithub' + '_pat_[A-Za-z0-9_]{22,}', 'g') },
  { id: 'slack-token', re: new RegExp('\\bxox[abposr]-[A-Za-z0-9-]{10,}', 'g') },
  { id: 'private-key', re: new RegExp('-----BEGIN [A-Z ]*' + 'PRIVATE KEY-----[\\s\\S]*?(?:-----END [A-Z ]*' + 'PRIVATE KEY-----|$)', 'g') },
  { id: 'adc-live-token', re: /ADC_LIVE_TOKEN\s*[=:]\s*["']?[^\s"']+/g, replace: 'ADC_LIVE_TOKEN=<redacted>' },
];
let patternCache = null;

async function secretPatterns() {
  if (patternCache) return patternCache;
  const list = [...FALLBACK_SECRET_PATTERNS];
  try {
    const m = await import('./markers.mjs');
    for (const p of Array.isArray(m.SECRET_PATTERNS) ? m.SECRET_PATTERNS : []) {
      if (p && p.re instanceof RegExp) {
        list.push({ id: String(p.id || 'secret'), re: new RegExp(p.re.source, p.re.flags.includes('g') ? p.re.flags : `${p.re.flags}g`) });
      }
    }
  } catch {
    // markers.mjs is optional; the built-in shapes still apply.
  }
  patternCache = list;
  return list;
}

function redactWith(patterns, literals, text) {
  if (typeof text !== 'string' || !text) return text;
  let out = literals.length ? redactLiterals(text, literals) : text;
  for (const p of patterns) {
    p.re.lastIndex = 0;
    out = out.replace(p.re, p.replace || `[REDACTED:${p.id}]`);
  }
  return out;
}

/** A sync redactor for secret shapes plus the ADC_LIVE_TOKEN value in the environment. */
export async function makeRedactor(env = process.env) {
  const patterns = await secretPatterns();
  const literals = env.ADC_LIVE_TOKEN ? [{ name: 'ADC_LIVE_TOKEN', value: env.ADC_LIVE_TOKEN }] : [];
  return (text) => redactWith(patterns, literals, text);
}

function redactSync(text) {
  const literals = process.env.ADC_LIVE_TOKEN ? [{ name: 'ADC_LIVE_TOKEN', value: process.env.ADC_LIVE_TOKEN }] : [];
  return redactWith(patternCache || FALLBACK_SECRET_PATTERNS, literals, text);
}

/** Redact every string in a JSON value except hash-valued keys. */
export function redactDeep(value, redact, key = '') {
  if (key === 'artifact_sha256') return value;
  if (typeof value === 'string') return HASH_KEY_RE.test(key) ? value : redact(value);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, redact, key));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v, redact, k);
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Hashing

/** JSON with recursively sorted keys (the hashed form of every record). */
export function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map((x) => canonicalJson(x === undefined ? null : x)).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
  }
  if (typeof v === 'number' && !Number.isFinite(v)) return 'null';
  return JSON.stringify(v === undefined ? null : v);
}

const nonceHash = (ledger, value) => sha256(`${ledger.session_nonce}\n${canonicalJson(value)}`);

function headerHash(ledger) {
  const pick = {};
  for (const k of HEADER_KEYS) pick[k] = ledger[k] === undefined ? null : ledger[k];
  return nonceHash(ledger, pick);
}

function recordHash(ledger, list, record) {
  const copy = { ...record };
  delete copy.entry_sha256;
  for (const k of DERIVED_KEYS[list]) delete copy[k];
  return nonceHash(ledger, copy);
}

function sealHash(ledger) {
  const copy = JSON.parse(JSON.stringify(ledger));
  delete copy.integrity.ledger_sha256;
  return nonceHash(ledger, copy);
}

// Each record carries a global sequence number and the previous record's hash, so an edited,
// removed or reordered entry breaks the chain (tamper-evident; a forger needs the nonce).
function appendRecord(ledger, list, record) {
  const integ = ledger.integrity;
  record.seq = (integ.count || 0) + 1;
  record.prev = integ.head || null;
  record.entry_sha256 = recordHash(ledger, list, record);
  integ.count = record.seq;
  integ.head = record.entry_sha256;
  ledger[list].push(record);
  return record;
}

function hashFile(file) {
  try { return sha256(fs.readFileSync(file)); } catch { return null; }
}

/** Recompute header, entry, chain, artifact and seal hashes. Returns { ok, problems[] }. */
export function verifyIntegrity(ledger, { root = null } = {}) {
  const problems = [];
  if (!ledger || ledger.schema !== SCHEMA) return { ok: false, problems: [{ kind: 'schema', detail: `not an ${SCHEMA} ledger` }] };
  if (!/^[0-9a-f]{32}$/.test(String(ledger.session_nonce || ''))) problems.push({ kind: 'nonce', detail: 'session nonce missing or malformed' });
  const integ = ledger.integrity && typeof ledger.integrity === 'object' ? ledger.integrity : {};
  if (integ.header_sha256 !== headerHash(ledger)) problems.push({ kind: 'header', detail: 'ledger header fields were changed after creation' });
  const records = [];
  for (const list of ['checks', 'waivers', 'claims']) {
    for (const r of Array.isArray(ledger[list]) ? ledger[list] : []) if (r && typeof r === 'object') records.push({ list, r });
  }
  records.sort((a, b) => (Number(a.r.seq) || 0) - (Number(b.r.seq) || 0));
  let prev = null;
  records.forEach(({ list, r }, i) => {
    const label = `${list}#${r.seq}${r.id ? ` ${r.id}` : r.check ? ` ${r.check}` : ''}`;
    if (r.seq !== i + 1) problems.push({ kind: 'sequence', record: label, detail: `expected sequence number ${i + 1}` });
    if ((r.prev || null) !== prev) problems.push({ kind: 'chain', record: label, detail: 'previous-entry hash does not match (an entry was removed or reordered)' });
    if (r.entry_sha256 !== recordHash(ledger, list, r)) problems.push({ kind: 'entry', record: label, detail: 'entry hash mismatch (the entry was edited)' });
    if (list === 'checks' && r.tree_digest !== ledger.tree_digest) problems.push({ kind: 'tree', record: label, detail: 'entry was recorded for a different snapshot' });
    if (list === 'checks' && root && r.artifact_sha256 && typeof r.artifact_sha256 === 'object') {
      for (const [p, h] of Object.entries(r.artifact_sha256)) {
        if (h == null) continue;
        const now = hashFile(path.resolve(root, p));
        if (now !== h) problems.push({ kind: 'artifact', record: label, detail: `${p} ${now ? 'changed after it was recorded' : 'is missing'}` });
      }
    }
    prev = r.entry_sha256;
  });
  if ((integ.count || 0) !== records.length) problems.push({ kind: 'count', detail: `integrity.count is ${integ.count}, the ledger holds ${records.length} entries` });
  if ((integ.head || null) !== prev) problems.push({ kind: 'head', detail: 'the newest entry does not match integrity.head (an entry was removed)' });
  if (root && ledger.spec_copy && ledger.spec_copy_sha256) {
    if (hashFile(path.resolve(root, ledger.spec_copy)) !== ledger.spec_copy_sha256) problems.push({ kind: 'artifact', record: 'spec', detail: `${ledger.spec_copy} changed or is missing` });
  }
  if (ledger.finalized_at && integ.ledger_sha256 !== sealHash(ledger)) problems.push({ kind: 'seal', detail: 'the finalized ledger was changed' });
  return { ok: problems.length === 0, problems };
}

// ---------------------------------------------------------------------------
// Check normalization

function normalizeFindings(list, checkId) {
  if (!Array.isArray(list)) return [];
  return list.filter((f) => f && typeof f === 'object').slice(0, MAX_FINDINGS).map((f) => {
    const line = Number(f.line);
    const out = {
      id: CHECK_ID_RE.test(String(f.id || '')) ? String(f.id) : checkId,
      severity: ['fail', 'finding', 'info'].includes(f.severity) ? f.severity : 'finding',
      file: f.file == null || f.file === '' ? null : toPosix(String(f.file)),
      line: f.line != null && f.line !== '' && Number.isFinite(line) ? Math.trunc(line) : null,
      message: truncate(String(f.message || ''), 500),
      evidence: f.evidence == null ? '' : truncate(String(f.evidence), 300),
    };
    if (f.rule != null) out.rule = truncate(String(f.rule), 120);
    return out;
  });
}

function clampData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
  let text;
  try { text = JSON.stringify(data); } catch { return { unserializable: true }; }
  if (text.length <= MAX_DATA_CHARS) return JSON.parse(text);
  return { truncated: true, chars: text.length, keys: Object.keys(data).slice(0, 50) };
}

/**
 * Validate and fill one Check (shape in BUILD-SPEC / §9.2). `strict` (input from the CLI) throws
 * a usage error on a bad id or status; script output with a bad status becomes `unverified`.
 */
export function normalizeCheck(raw, { strict = false } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    if (strict) throw usageError('each check must be a JSON object');
    return null;
  }
  const id = String(raw.id || '').trim().toUpperCase();
  if (!CHECK_ID_RE.test(id)) {
    if (strict) throw usageError(`invalid check id "${raw.id}" (expected CK-...)`);
    return null;
  }
  let status = String(raw.status || '').trim().toLowerCase();
  let reason = raw.reason == null || raw.reason === '' ? null : truncate(String(raw.reason), 120);
  if (!STATUSES.includes(status)) {
    if (strict) throw usageError(`check ${id}: status must be one of ${STATUSES.join(', ')}`);
    reason = `BAD_STATUS:${truncate(status, 30)}`;
    status = 'unverified';
  }
  const fm = arr(raw.fm).map(String).filter((x) => /^FM-\d{2}$/.test(x));
  const total = Array.isArray(raw.findings) ? raw.findings.length : 0;
  const out = {
    id, fm: fm.length ? fm : [...(CHECK_FM[id] || [])], project: toPosix(String(raw.project || '.')),
    status, reason, cost: Number.isFinite(Number(raw.cost)) ? Number(raw.cost) : 0,
    command: raw.command == null || raw.command === '' ? null : truncate(String(raw.command), 2000),
    cwd: raw.cwd == null || raw.cwd === '' ? null : toPosix(String(raw.cwd)),
    exit_code: Number.isInteger(raw.exit_code) ? raw.exit_code : null,
    duration_ms: Number.isFinite(Number(raw.duration_ms)) && raw.duration_ms !== null ? Math.round(Number(raw.duration_ms)) : null,
    summary: truncate(String(raw.summary || ''), 1000),
    output_sha256: /^[0-9a-f]{64}$/.test(String(raw.output_sha256 || '')) ? raw.output_sha256 : null,
    artifacts: arr(raw.artifacts).map((a) => toPosix(String(a))).slice(0, 50),
    findings: normalizeFindings(raw.findings, id),
    data: clampData(raw.data),
  };
  if (total > MAX_FINDINGS) out.findings_truncated = total - MAX_FINDINGS;
  if (raw.pending === true) out.pending = true;
  return out;
}

// ---------------------------------------------------------------------------
// Ledger files

/** Read and minimally validate a ledger file; throws exit 2 when missing, exit 4 when not a ledger. */
export function readLedgerFile(file) {
  const text = readText(file);
  if (text == null) throw usageError(`ledger not found: ${toPosix(file)}`);
  let ledger;
  try { ledger = JSON.parse(text); } catch { throw unverifiable('LEDGER_INVALID', `ledger is not valid JSON: ${toPosix(file)}`); }
  if (!ledger || ledger.schema !== SCHEMA) throw unverifiable('LEDGER_INVALID', `not an ${SCHEMA} ledger: ${toPosix(file)}`);
  for (const k of ['checks', 'waivers', 'claims', 'observed_runs']) if (!Array.isArray(ledger[k])) ledger[k] = [];
  if (!ledger.integrity || typeof ledger.integrity !== 'object') ledger.integrity = {};
  return ledger;
}

/** The generated Markdown next to a ledger. */
export const markdownPath = (file) => file.replace(/\.json$/, '.md');
/** Folder for a ledger's artifacts (trace matrix, spec copy, run logs). A subfolder keeps `evidence/*.json` ledger-only. */
export const artifactsDir = (file) => file.replace(/\.json$/, '');

function evidenceDir(stateInfo) {
  return (stateInfo.paths || statePaths(stateInfo.dir)).evidence;
}

/** Ledgers in the state dir, newest first (by created_at, then name). */
export function listLedgers(stateInfo) {
  const dir = evidenceDir(stateInfo);
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { return []; }
  const rows = names.map((n) => {
    const file = path.join(dir, n);
    const doc = readJson(file, null);
    return { file, created: doc && doc.schema === SCHEMA ? String(doc.created_at || '') : null, name: n };
  }).filter((r) => r.created !== null);
  rows.sort((a, b) => (a.created === b.created ? (a.name < b.name ? 1 : -1) : a.created < b.created ? 1 : -1));
  return rows.map((r) => r.file);
}

/** `{ path, ledger }` for an explicit path, else the newest ledger; throws when there is none. */
export function loadLedger(pathOrNull, stateInfo) {
  const file = pathOrNull || listLedgers(stateInfo)[0];
  if (!file) throw new AdcError(EXIT.USAGE, 'NO_LEDGER', 'no evidence ledger found; run `verify` (or `evidence init`) first');
  return { path: file, ledger: readLedgerFile(file) };
}

/** A fresh `.adc/evidence/<stamp>-<tree12>[-n].json` path (its artifacts folder is free too). */
export function allocateLedgerPath(stateInfo, tree, { create = true } = {}) {
  const dir = create ? ensureDir(evidenceDir(stateInfo)) : evidenceDir(stateInfo);
  const base = `${stamp()}-${String(tree).slice(0, 12)}`;
  for (let i = 1; ; i++) {
    const file = path.join(dir, `${base}${i === 1 ? '' : `-${i}`}.json`);
    if (!fs.existsSync(file) && !fs.existsSync(artifactsDir(file))) return file;
  }
}

function repoIdentity(root) {
  const url = gitTry(root, ['config', '--get', 'remote.origin.url']);
  if (url) return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, '$1');
  return path.basename(root);
}

/** Session identity (§10.3.2): --session > newest open hook session file > generated run id. */
export function resolveSession(stateInfo, explicit) {
  if (explicit) return { id: String(explicit), source: 'flag' };
  const open = newestOpenSession(stateInfo.dir);
  if (open) return { id: String(open.id), source: 'session-file' };
  return { id: `run-${stamp()}-${nonce().slice(0, 6)}`, source: 'generated' };
}

function budgetSnapshot(stateInfo, sessionId, identitySource) {
  const b = readJson(statePaths(stateInfo.dir).budget, null);
  if (!b || typeof b !== 'object') return null;
  const ses = b.sessions && typeof b.sessions === 'object' ? b.sessions[sessionId] : null;
  const override = ses && ses.override && Number.isFinite(Number(ses.override.max)) ? ses.override : null;
  const maxSession = override ? Number(override.max) : Number(b.max_per_session) || 0;
  const maxDay = Number(b.max_per_day) || 0;
  const spent = ses ? Number(ses.spent) || 0 : 0;
  const day = b.days && b.days[today()] ? Number(b.days[today()].spent) || 0 : 0;
  return {
    unit: String(b.unit || 'credits'), session_id: sessionId, identity_source: identitySource,
    max_per_session: maxSession, max_per_day: maxDay, spent, spent_today: day,
    remaining: Math.max(0, Math.min(maxSession - spent, maxDay - day)), ...(override ? { override } : {}),
  };
}

function observedRuns(stateInfo, sessionId) {
  const s = readSession(stateInfo.dir, sessionId);
  if (!s || typeof s !== 'object') return [];
  const runs = [s.observed_runs, s.runs, s.events && s.events.observed_runs, s.events && s.events.runs].find(Array.isArray) || [];
  return runs.filter((r) => r && typeof r === 'object').slice(-50).map((r) => ({
    ts: r.ts ? String(r.ts) : null, cmd_head: truncate(String(r.cmd_head ?? r.cmd ?? ''), 200), class: r.class == null ? null : String(r.class),
    exit: Number.isInteger(r.exit) ? r.exit : null, counts: r.counts && typeof r.counts === 'object' ? r.counts : null,
    parse_source: String(r.parse_source || 'none'), source: String(r.source || 'hook:post-shell'), narrowed: Boolean(r.narrowed),
  }));
}

/**
 * Create a ledger for `target` (from prepareQaTarget). Returns { path, ledger }.
 * `mode` is 'verify' (written by the orchestrator) or 'manual' (`evidence init`).
 */
export async function initLedger({
  target, tool = null, spec = null, specText = null, sessionId = null, mode = 'manual', options = {},
  projectsSummary = null, effectiveTestGlobs = [], steps = null, file = null, dryRun = false,
}) {
  const redact = await makeRedactor();
  const st = target.state;
  const ledgerFile = file || allocateLedgerPath(st, target.snapshot.tree, { create: !dryRun });
  const session = sessionId && typeof sessionId === 'object' ? sessionId : resolveSession(st, sessionId);
  const ledger = {
    schema: SCHEMA, tool: tool || detectTool(), mode, session_id: session.id, session_source: session.source,
    session_nonce: nonce(), repo: repoIdentity(target.root), base: target.base.sha, base_ref: target.base.ref,
    base_source: target.base.source, tree_digest: target.snapshot.tree, snapshot_commit: target.snapshot.commit,
    head: target.snapshot.head, spec: spec == null ? null : truncate(String(spec), 500),
    spec_sha256: specText == null ? null : sha256(String(specText)), spec_copy: null, spec_copy_sha256: null,
    effective_test_globs: [...new Set(arr(effectiveTestGlobs).map(String))].slice(0, 100),
    projects_summary: projectsSummary == null ? null : truncate(String(projectsSummary), 500), options: clampData(options),
    budget: budgetSnapshot(st, session.id, session.source), steps: Array.isArray(steps) ? steps : [],
    checks: [], observed_runs: observedRuns(st, session.id), waivers: [], claims: [],
    verdict: 'UNVERIFIED', verdict_reasons: [], needs_human_triage: false,
    created_at: nowIso(), updated_at: null, finalized_at: null, generated_by: generatedBy(),
    integrity: { algorithm: 'sha256(session_nonce + LF + canonical JSON); entries chained by seq/prev', count: 0, head: null, header_sha256: null },
  };
  ledger.updated_at = ledger.created_at;
  if (specText != null) {
    // The spec is copied once so waiver quotes are checked against what was verified.
    const copy = path.join(artifactsDir(ledgerFile), 'spec.txt');
    const content = redact(String(specText));
    ledger.spec_copy = posixRef(target.root, copy);
    ledger.spec_copy_sha256 = sha256(content);
    if (!dryRun) writeFileAtomic(copy, content);
  }
  const clean = redactDeep(ledger, redact);
  clean.integrity.header_sha256 = headerHash(clean);
  refreshDerived(clean);
  if (!dryRun) writeLedger(ledgerFile, clean);
  return { path: ledgerFile, ledger: clean };
}

function writeLedger(file, ledger) {
  writeJsonAtomic(file, ledger);
  writeFileAtomic(markdownPath(file), renderMarkdown(ledger));
}

async function mutateLedger(file, fn, { dryRun = false } = {}) {
  const body = async () => {
    const ledger = readLedgerFile(file);
    if (ledger.finalized_at) throw new AdcError(EXIT.USAGE, 'LEDGER_FINALIZED', 'the ledger is finalized and cannot change; run verify again');
    const result = await fn(ledger);
    ledger.updated_at = nowIso();
    refreshDerived(ledger);
    if (!dryRun) writeLedger(file, ledger);
    return { ledger, result };
  };
  return dryRun ? body() : withLock(`${file}.lock`, body);
}

function refreshDerived(ledger) {
  const d = deriveVerdict(ledger);
  ledger.verdict = d.verdict;
  ledger.verdict_reasons = d.reasons;
  ledger.needs_human_triage = d.needs_human_triage;
  for (const c of ledger.claims) {
    const m = d.claims.find((x) => x.seq === c.seq);
    if (m) c.status = m.status;
  }
  return d;
}

// ---------------------------------------------------------------------------
// Adding checks

function inputDocToChecks(doc) {
  if (Array.isArray(doc)) return { checks: doc, tree: null, matrix: null };
  if (!doc || typeof doc !== 'object') throw usageError('the input must be a check object, an array of checks, an object with "checks", or a traceability matrix');
  if (Array.isArray(doc.answers)) throw usageError('this looks like an answers file; use `evidence score <file> --add`');
  if (Array.isArray(doc.requirements) && !doc.id) return { checks: [{ id: 'CK-TRACE', status: 'unverified', data: { matrix: doc } }], tree: doc.tree_digest || null, matrix: doc };
  if (Array.isArray(doc.checks)) return { checks: doc.checks, tree: doc.tree_digest || null, matrix: null };
  if (doc.id) return { checks: [doc], tree: doc.tree_digest || null, matrix: null };
  throw usageError('the input has no checks');
}

async function traceEntry(ledger, raw, { root, file, dryRun }) {
  const matrix = raw.data && raw.data.matrix && typeof raw.data.matrix === 'object' ? raw.data.matrix
    : raw.data && Array.isArray(raw.data.requirements) ? raw.data : null;
  if (!matrix) throw usageError('CK-TRACE entries must carry the completed matrix (requirements[] with file:line citations); its status is derived, never accepted');
  const placeholder = ledger.checks.find((c) => c.id === 'CK-TRACE' && c.pending);
  const skeletonRef = placeholder && placeholder.artifacts.find((a) => /(^|\/)trace\.json$/.test(a));
  const skeleton = skeletonRef ? readJson(path.resolve(root, skeletonRef), null) : null;
  const ev = await evaluateMatrix({ root, base: ledger.base, commit: ledger.snapshot_commit, tree: ledger.tree_digest, matrix, skeleton });
  const dir = artifactsDir(file);
  const jsonOut = path.join(dir, 'trace-completed.json');
  const mdOut = path.join(dir, 'trace-completed.md');
  if (!dryRun) {
    writeJsonAtomic(jsonOut, { schema: 'adc-trace/1', tree_digest: ledger.tree_digest, ...ev });
    writeFileAtomic(mdOut, renderTraceMarkdown(ev));
  }
  return {
    id: 'CK-TRACE', fm: ['FM-14', 'FM-11'], project: '.', status: ev.status, reason: ev.reason, summary: ev.summary,
    findings: ev.findings, artifacts: [posixRef(root, jsonOut), posixRef(root, mdOut)],
    data: { counts: ev.counts, requirements: ev.requirements.map((r) => ({ id: r.id, status: r.status, strength: r.strength, evidence: r.evidence, tests: r.tests })), extras: ev.extras.slice(0, 100) },
  };
}

/**
 * Append checks to a ledger. `source`: 'verify' | 'script' (in-process, trusted shape) or
 * 'input' (CLI; strict validation, no pending placeholders, CK-TRACE re-derived, CK-CLAIMS refused)
 * or 'run' (a command `evidence add --run` executed). Returns { ledger, added }.
 */
export async function addChecks(file, checks, { source = 'script', root = null, inputTree = null, dryRun = false } = {}) {
  const redact = await makeRedactor();
  const strict = source === 'input';
  const { ledger, result } = await mutateLedger(file, async (ledger) => {
    if (inputTree && inputTree !== ledger.tree_digest) {
      throw new AdcError(EXIT.USAGE, 'STALE_INPUT', `the input was produced for snapshot ${String(inputTree).slice(0, 12)}, the ledger is for ${String(ledger.tree_digest).slice(0, 12)}; re-run the command or verify`);
    }
    const repo = rootFor(file, root);
    const added = [];
    for (const raw0 of arr(checks)) {
      let raw = raw0;
      if (strict && raw && String(raw.id || '').toUpperCase() === 'CK-CLAIMS') throw usageError('CK-CLAIMS is derived at finalize; record claims with `evidence claims`');
      if (strict && raw && String(raw.id || '').toUpperCase() === 'CK-TRACE') raw = await traceEntry(ledger, raw, { root: repo, file, dryRun });
      const entry = normalizeCheck(raw, { strict });
      if (!entry) continue;
      if (source === 'input' || source === 'run') delete entry.pending;
      entry.tree_digest = ledger.tree_digest;
      entry.source = source;
      entry.added_at = nowIso();
      const placeholder = ledger.checks.find((c) => c.pending && c.id === entry.id && !entry.pending);
      if (placeholder) entry.supersedes = placeholder.seq;
      const artifactHashes = {};
      for (const a of entry.artifacts) artifactHashes[a] = hashFile(path.resolve(repo, a));
      entry.artifact_sha256 = artifactHashes;
      added.push(appendRecord(ledger, 'checks', redactDeep(entry, redact)));
    }
    return added;
  }, { dryRun });
  return { ledger, added: result };
}

// ---------------------------------------------------------------------------
// Claims (status is always derived, §9.2)

const CLAIM_MAP = [
  [/\ball (the )?(tests|specs|checks)\b|\b(tests?|specs?|suite)\b[^.;]*\b(pass(es|ed|ing)?|green|succeed(s|ed)?)\b|\b(pass(es|ed|ing)?|green)\b[^.;]*\btests?\b/i, ['CK-CLEANRUN']],
  [/\b(type[- ]?checks?|type[- ]?checked|types? check|compil(e|es|ed|ation)|tsc|mypy|pyright|builds? (cleanly|successfully)|no (type|compile|compiler) errors)\b/i, ['CK-TYPES']],
  [/\b(lint(s|ed|er|ing)?|eslint|ruff|clippy|no (new )?warnings)\b/i, ['CK-SUPPRESS']],
  [/\bcoverage\b/i, ['CK-COVERAGE']],
  [/\bdependenc(y|ies)\b|\block ?files?\b|\bpackages? (are |is )?(added|installed|real|exist)/i, ['CK-DEPS', 'CK-LOCK']],
  [/\bno (hard-?coded |leaked )?(secrets?|credentials?|api keys?)\b/i, ['CK-SECRETS']],
  [/\b(requirements?|acceptance criteria|the spec|specification|feature complete|as (requested|specified)|implement(s|ed)? (the|all|every))\b/i, ['CK-TRACE']],
  [/\bflak(y|iness)\b/i, ['CK-FLAKE']],
  [/\bmutation\b/i, ['CK-MUTATION']],
  [/\b(regression test|red[- ]green|fails? (before|without) the fix)\b/i, ['CK-REDGREEN']],
  [/\b(live|smoke|synthetic) (tests?|checks?|probes?)\b/i, ['CK-LIVE']],
  [/\breview(ed)?\b/i, ['CK-REVIEW']],
  [/\b(ci|pipeline|workflows?|github actions)\b/i, ['CK-CI']],
  [/\b(no|did not|didn't|without) (delet|remov|skipp|disabl)\w* (any )?tests?\b|\bno tests? (were |was )?(deleted|removed|skipped|disabled)\b/i, ['CK-TEST-DEL', 'CK-SKIP']],
  [/\b(in scope|no unrelated|only (changed|touched) )/i, ['CK-SCOPE']],
];
const CLAIM_HINT = /\b(pass(es|ed|ing)?|green|fix(es|ed)?|add(s|ed)?|implement(s|ed)?|works?|working|done|complete[ds]?|verified|updated?|removed?|no (new )?(errors?|warnings?|failures?)|all (tests|checks)|builds?|compil\w*|cover\w*|tests?|lint\w*|types?|dependenc\w*|secrets?)\b/i;

/** Map one claim to check ids by keywords (an approximation; the model may name `evidence` explicitly). */
export function mapClaim(text) {
  const ids = [];
  for (const [re, list] of CLAIM_MAP) if (re.test(text)) for (const id of list) if (!ids.includes(id)) ids.push(id);
  return ids;
}

function splitClaimText(text) {
  const out = [];
  for (const raw of String(text).replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, '').replace(/^#+\s+/, '').trim();
    if (!line) continue;
    for (const s of line.split(/(?<=[.!?])\s+(?=[A-Z0-9"'`(])/)) {
      const t = s.trim();
      if (t.length >= 8 && t.length <= 500 && CLAIM_HINT.test(t)) out.push(t);
    }
  }
  if (!out.length && String(text).trim()) out.push(truncate(String(text).trim().replace(/\s+/g, ' '), 300));
  return out;
}

/** Claims from text (an implementer summary), a JSON array of strings/objects, or { claims: [...] }. */
export function parseClaims(input) {
  let items;
  if (typeof input === 'string') {
    const t = input.trim();
    if (t.startsWith('[') || t.startsWith('{')) {
      try { return parseClaims(JSON.parse(t)); } catch {}
    }
    items = splitClaimText(t);
  } else if (Array.isArray(input)) items = input;
  else if (input && typeof input === 'object') items = Array.isArray(input.claims) ? input.claims : [input];
  else items = [];
  return items.map((it) => {
    if (typeof it === 'string') return { text: it.trim(), evidence: null };
    if (it && typeof it === 'object') return { text: String(it.text ?? it.claim ?? '').trim(), evidence: Array.isArray(it.evidence) ? it.evidence : null };
    return null;
  }).filter((c) => c && c.text).slice(0, MAX_CLAIMS);
}

/** Append claims (deduplicated by text). Any status in the input is ignored and re-derived. */
export async function setClaims(file, claims, { dryRun = false } = {}) {
  const redact = await makeRedactor();
  const parsed = parseClaims(claims);
  const { ledger, result } = await mutateLedger(file, (ledger) => {
    const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();
    const have = new Set(ledger.claims.map((c) => norm(c.text)));
    const added = [];
    for (const c of parsed) {
      if (ledger.claims.length >= MAX_CLAIMS) break;
      const text = truncate(redact(c.text), 500);
      if (have.has(norm(text))) continue;
      have.add(norm(text));
      const explicit = c.evidence ? c.evidence.map((x) => String(x).trim().toUpperCase()).filter((x) => CHECK_ID_RE.test(x)) : null;
      added.push(appendRecord(ledger, 'claims', {
        text, evidence: explicit && explicit.length ? [...new Set(explicit)] : mapClaim(text),
        mapped_by: explicit && explicit.length ? 'input' : 'keywords', source: 'input', added_at: nowIso(), status: 'unsupported',
      }));
    }
    return added;
  }, { dryRun });
  return { ledger, added: result };
}

// ---------------------------------------------------------------------------
// Waivers (§9.2): the only justification channel; quoted spec text, capped at PASS-WITH-FINDINGS

const normQuote = (s) => String(s).toLowerCase().replace(/[`*_>#]/g, '').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();

/** Quoted segments ('...', "...", curly quotes) of at least 8 characters. */
export function quotedSegments(reason) {
  const out = [];
  const re = /'([^']{8,})'|"([^"]{8,})"|“([^”]{8,})”|‘([^’]{8,})’/g;
  let m;
  while ((m = re.exec(String(reason)))) out.push((m[1] || m[2] || m[3] || m[4]).trim());
  return out;
}

/**
 * Record a waiver. The reason must quote the spec captured by the ledger; without a spec a
 * waiver is accepted only from a real terminal (`interactive`), never from an agent.
 */
export async function addWaiver(file, { check, file: wfile = null, reason }, { root = null, interactive = false, dryRun = false } = {}) {
  const id = String(check || '').trim().toUpperCase();
  if (!CHECK_ID_RE.test(id)) throw usageError(`invalid check id "${check}"`);
  if (NON_WAIVABLE.has(id)) throw usageError(`${id} cannot be waived: it records a fact (fix the cause and re-run verify)`);
  const text = String(reason || '').trim();
  if (!text) throw usageError('--reason "<quoted spec text>" is required');
  const redact = await makeRedactor();
  const { ledger, result } = await mutateLedger(file, (ledger) => {
    const entries = ledger.checks.filter((c) => c.id === id && !c.pending);
    if (!entries.length) throw usageError(`the ledger has no ${id} entry to waive`);
    if (entries.every((c) => c.status === 'unverified')) throw usageError(`${id} is unverified; UNVERIFIED is resolved by running the step, not by a waiver`);
    const quotes = quotedSegments(text);
    let specText = null;
    if (ledger.spec_copy) specText = readText(path.resolve(rootFor(file, root), ledger.spec_copy));
    let verified = null;
    let by;
    if (specText != null) {
      if (!quotes.length) throw usageError('the reason must quote the spec, e.g. --reason "spec section 3: \'remove the legacy endpoint and its tests\'"');
      const hay = normQuote(specText);
      verified = quotes.find((q) => hay.includes(normQuote(q))) || null;
      if (!verified) throw usageError('the quoted text does not appear in the spec this ledger was verified against');
      by = 'spec-quote';
    } else {
      if (!interactive) throw usageError('this ledger has no spec to quote; a waiver without a spec must be given by a person from a terminal (run this from a terminal)');
      by = 'tty';
    }
    const fileRef = wfile == null || wfile === '' ? null : toPosix(String(wfile));
    if (fileRef) {
      const known = entries.flatMap((c) => c.findings).some((f) => f.file === fileRef || f.rule === fileRef);
      if (!known) throw usageError(`${id} has no finding for "${fileRef}"`);
    }
    return appendRecord(ledger, 'waivers', {
      check: id, file: fileRef, reason: truncate(redact(text), 1000), quote: verified ? truncate(redact(verified), 500) : null,
      quote_verified: verified != null, by, added_at: nowIso(),
    });
  }, { dryRun });
  return { ledger, waiver: result };
}

// ---------------------------------------------------------------------------
// Verdict (§9.1): FAIL > UNVERIFIED > PASS-WITH-FINDINGS > PASS

function cleanRunFlaky(entry) {
  const d = entry.data || {};
  const run = d.run && typeof d.run === 'object' ? d.run : d;
  return Number(run.flaky ?? d.flaky ?? 0) || 0;
}

function shortfallOnly(entry) {
  const d = entry.data || {};
  const run = d.run && typeof d.run === 'object' ? d.run : d;
  const failed = Number(run.failed ?? 0) || 0;
  const errors = Number(run.errors ?? 0) || 0;
  const delta = d.delta && typeof d.delta === 'object' ? d.delta : null;
  const shortfall = SHORTFALL_REASONS.has(entry.reason) || Boolean(delta && Number(delta.executed) < 0);
  return shortfall && failed === 0 && errors === 0;
}

function claimStatus(claim, rows) {
  const ids = arr(claim.evidence);
  if (!ids.length) return 'unsupported';
  let allOk = true;
  for (const id of ids) {
    const r = rows.filter((e) => e.id === id);
    if (!r.length) { allOk = false; continue; }
    for (const e of r) {
      if (e.effective === 'fail' || e.effective === 'waived') return 'contradicted';
      const ok = (e.effective === 'pass' || e.effective === 'pass-with-baseline')
        && !(id === 'CK-CLEANRUN' && e.entries.some((x) => cleanRunFlaky(x) > 0));
      if (!ok) allOk = false;
    }
  }
  return allOk ? 'supported' : 'unsupported';
}

/**
 * Derive effective statuses, claim statuses and the verdict from a ledger (pure).
 * Returns { verdict, reasons[], needs_human_triage, effective[], claims[] }.
 */
export function deriveVerdict(ledger) {
  const checks = (ledger.checks || []).filter((c) => c && c.id && c.id !== 'CK-CLAIMS');
  const waivers = ledger.waivers || [];
  // A pending placeholder (CK-TRACE, CK-REVIEW) is superseded by any later entry with its id.
  const live = checks.filter((c) => !(c.pending && checks.some((o) => o.id === c.id && !o.pending && o.seq > c.seq)));
  const groups = new Map();
  for (const c of live) {
    const key = `${c.id}\u0000${c.project || '.'}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  const rows = [];
  let triage = false;
  for (const entries of groups.values()) {
    // Worst status wins, so a later "pass" can never upgrade a recorded failure or UNVERIFIED.
    const worst = entries.reduce((a, b) => ((RANK[b.status] ?? 4) > (RANK[a.status] ?? 4) ? b : a));
    const row = { id: worst.id, project: worst.project || '.', status: worst.status, effective: worst.status, reason: worst.reason || null, summary: worst.summary || '', waived: false, notes: [], entries, sources: [...new Set(entries.map((e) => e.source))] };
    if (worst.pending) row.effective = worst.id === 'CK-REVIEW' ? 'skipped' : 'unverified';
    if (row.id === 'CK-REVIEW' && row.effective === 'fail') {
      const confirmed = checks.some((c) => c.id === 'CK-REVIEW' && c.source === 'run' && c.data && c.data.confirmed === true && Number.isInteger(c.exit_code) && c.exit_code !== 0);
      if (!confirmed) {
        row.effective = 'finding';
        triage = true;
        row.notes.push('critical review finding not confirmed by a reproducing command (needs human triage)');
      }
    }
    if (SOFT.has(row.id) && row.effective === 'fail' && !(worst.data && worst.data.hard === true)) {
      row.effective = 'finding';
      row.notes.push('soft check: reported, does not fail the verdict');
    }
    if (OPTIONAL.has(row.id) && row.effective === 'unverified') {
      row.effective = 'skipped';
      row.notes.push(`optional probe could not run (${row.reason || 'no reason given'})`);
    }
    if ((row.effective === 'fail' || row.effective === 'finding') && !NON_WAIVABLE.has(row.id)) {
      const ws = waivers.filter((w) => w.check === row.id);
      if (ws.length) {
        const findings = entries.filter((e) => e.status === 'fail' || e.status === 'finding')
          .flatMap((e) => e.findings || []).filter((f) => f.severity !== 'info');
        const covers = (f) => ws.some((w) => !w.file || w.file === f.file || w.file === f.rule);
        if (findings.length ? findings.every(covers) : ws.some((w) => !w.file)) {
          row.effective = 'waived';
          row.waived = true;
          row.notes.push(`waived: ${ws.map((w) => w.quote || w.reason).join('; ')}`);
        }
      }
    }
    rows.push(row);
  }
  // §9.1.1: an executed-count shortfall explained by waived CK-TEST-DEL findings is not a failure.
  const testDel = rows.filter((r) => r.id === 'CK-TEST-DEL');
  const skip = rows.filter((r) => r.id === 'CK-SKIP');
  for (const r of rows.filter((x) => x.id === 'CK-CLEANRUN')) {
    if (r.effective === 'fail' && testDel.length && testDel.every((t) => t.waived)
      && r.entries.filter((e) => e.status === 'fail').every(shortfallOnly)) {
      r.effective = 'waived';
      r.waived = true;
      r.notes.push('executed-count shortfall explained by waived CK-TEST-DEL findings');
    }
    const skippedUp = r.entries.some((e) => e.data && e.data.delta && Number(e.data.delta.skipped) > 0);
    if (r.effective === 'finding' && skippedUp && skip.some((s) => s.effective === 'fail')) {
      r.effective = 'fail';
      r.notes.push('more tests skipped than on the base while CK-SKIP fired');
    }
  }

  const claims = (ledger.claims || []).map((c) => ({ seq: c.seq, text: c.text, evidence: arr(c.evidence), status: claimStatus(c, rows) }));
  const contradictedByFail = claims.some((c) => c.status === 'contradicted'
    && c.evidence.some((id) => rows.some((r) => r.id === id && r.effective === 'fail')));
  const claimsRow = {
    id: 'CK-CLAIMS', project: '.', reason: claims.length ? null : 'NO_CLAIMS', waived: false, notes: [], entries: [], sources: ['derived'],
    status: !claims.length ? 'skipped' : contradictedByFail ? 'fail' : claims.every((c) => c.status === 'supported') ? 'pass' : 'finding',
    summary: claims.length
      ? `${claims.filter((c) => c.status === 'supported').length}/${claims.length} claims supported, ${claims.filter((c) => c.status === 'contradicted').length} contradicted`
      : 'no implementer claims recorded',
  };
  claimsRow.effective = claimsRow.status;
  rows.push(claimsRow);

  const reasons = [];
  const pick = (s) => rows.filter((r) => r.effective === s);
  const describe = (r) => `${r.id}${r.project !== '.' ? ` (${r.project})` : ''} ${r.effective}${r.reason ? ` [${r.reason}]` : ''}: ${truncate(r.summary, 160)}`;
  let verdict;
  if (pick('fail').length) {
    verdict = 'FAIL';
    for (const r of pick('fail')) reasons.push(describe(r));
  } else if (pick('unverified').length || !rows.some((r) => r.id === 'CK-CLEANRUN')) {
    verdict = 'UNVERIFIED';
    for (const r of pick('unverified')) reasons.push(describe(r));
    if (!rows.some((r) => r.id === 'CK-CLEANRUN')) reasons.push('CK-CLEANRUN missing: no independent clean run is recorded');
  } else if (pick('finding').length || pick('waived').length || triage) {
    verdict = 'PASS-WITH-FINDINGS';
    for (const r of [...pick('finding'), ...pick('waived')]) reasons.push(describe(r));
  } else {
    verdict = 'PASS';
  }
  rows.sort((a, b) => (a.entries[0]?.seq ?? Infinity) - (b.entries[0]?.seq ?? Infinity));
  return { verdict, reasons, needs_human_triage: triage, effective: rows, claims };
}

/** Exit code for a verdict: 1 on FAIL, 4 on UNVERIFIED, else 0. */
export function verdictExit(verdict) {
  if (verdict === 'FAIL') return EXIT.FINDINGS;
  if (verdict === 'UNVERIFIED') return EXIT.UNVERIFIABLE;
  return EXIT.OK;
}

/** Slim per-check view: { id, project, status, effective, reason, summary, waived, notes, source }. */
export function checkRows(derived) {
  return derived.effective.map((r) => ({
    id: r.id, project: r.project, status: r.status, effective: r.effective, ...(r.reason ? { reason: r.reason } : {}),
    summary: r.summary, ...(r.waived ? { waived: true } : {}), ...(r.notes.length ? { notes: r.notes } : {}), source: r.sources.join(','),
  }));
}

// ---------------------------------------------------------------------------
// Finalize and status

/**
 * Finalize: recompute every entry, chain and artifact hash (refuse mismatches, exit 4), compare
 * the ledger's tree with a fresh snapshot (refuse stale, exit 4), record CK-CLAIMS, seal.
 */
export async function finalizeLedger(file, { target, dryRun = false } = {}) {
  const body = async () => {
    const ledger = readLedgerFile(file);
    if (ledger.finalized_at) throw new AdcError(EXIT.USAGE, 'LEDGER_FINALIZED', 'the ledger is already finalized');
    const integ = verifyIntegrity(ledger, { root: target.root });
    if (!integ.ok) {
      throw unverifiable('LEDGER_TAMPERED', `ledger integrity check failed (${integ.problems.length} problem(s), first: ${integ.problems[0].detail}); re-run verify`,
        { problems: integ.problems.slice(0, 20) });
    }
    if (target.snapshot.tree !== ledger.tree_digest) {
      throw unverifiable('LEDGER_STALE', `the working tree changed since this ledger was recorded (ledger ${String(ledger.tree_digest).slice(0, 12)}, now ${target.snapshot.tree.slice(0, 12)}); re-run verify`,
        { ledger_tree: ledger.tree_digest, current_tree: target.snapshot.tree });
    }
    const d = deriveVerdict(ledger);
    const claimsRow = d.effective.find((r) => r.id === 'CK-CLAIMS');
    const redact = await makeRedactor();
    const entry = normalizeCheck({ id: 'CK-CLAIMS', status: claimsRow.status, reason: claimsRow.reason, summary: claimsRow.summary,
      data: { claims: d.claims.map((c) => ({ text: c.text, status: c.status, evidence: c.evidence })) } });
    Object.assign(entry, { tree_digest: ledger.tree_digest, source: 'derived', added_at: nowIso(), artifact_sha256: {} });
    appendRecord(ledger, 'checks', redactDeep(entry, redact));
    ledger.finalized_at = nowIso();
    ledger.updated_at = ledger.finalized_at;
    refreshDerived(ledger);
    ledger.integrity.ledger_sha256 = sealHash(ledger);
    if (!dryRun) {
      writeLedger(file, ledger);
      try { appendMetrics(target.state.dir, { kind: 'evidence-finalize', verdict: ledger.verdict, tree: ledger.tree_digest.slice(0, 12) }); } catch {}
    }
    return { path: file, ledger, verdict: ledger.verdict };
  };
  return dryRun ? body() : withLock(`${file}.lock`, body);
}

/** Newest (or given) ledger with its verdict, integrity and staleness against a fresh snapshot. */
export function ledgerStatus({ target, ledgerPath = null }) {
  const file = ledgerPath || listLedgers(target.state)[0];
  if (!file) return { ledger: null, verdict: null, finalized: false, stale: null, message: 'no evidence ledger; run verify' };
  const ledger = readLedgerFile(file);
  const integrity = verifyIntegrity(ledger, { root: target.root });
  const d = deriveVerdict(ledger);
  return {
    ledger: posixRef(target.root, file), verdict: d.verdict, stored_verdict: ledger.verdict, finalized: Boolean(ledger.finalized_at),
    created_at: ledger.created_at, finalized_at: ledger.finalized_at, tree_digest: ledger.tree_digest, current_tree: target.snapshot.tree,
    stale: target.snapshot.tree !== ledger.tree_digest, integrity, needs_human_triage: d.needs_human_triage,
    pending: ledger.checks.filter((c) => c.pending && !ledger.checks.some((o) => o.id === c.id && !o.pending && o.seq > c.seq)).map((c) => c.id),
    checks: checkRows(d), claims: d.claims.map(({ seq, ...c }) => c),
  };
}

/** One metrics.jsonl record for a ledger (§10.6). */
export function metricsFor(input, extra = {}) {
  const ledger = { ...input, checks: arr(input.checks), waivers: arr(input.waivers), claims: arr(input.claims) };
  const pickData = (id) => ledger.checks.filter((c) => c.id === id).map((c) => c.data || {});
  const sum = (key) => pickData('CK-CLEANRUN').reduce((n, d) => n + (Number((d.run && d.run[key]) ?? d[key]) || 0), 0);
  const cov = pickData('CK-COVERAGE').map((d) => d.pct).find((v) => Number.isFinite(Number(v)));
  const mut = pickData('CK-MUTATION').map((d) => d.score).find((v) => Number.isFinite(Number(v)));
  const suspects = pickData('CK-FLAKE').reduce((n, d) => n + arr(d.suspect_tests).length, 0);
  const findings = (id) => ledger.checks.filter((c) => c.id === id).reduce((n, c) => n + arr(c.findings).length, 0);
  const statusCounts = {};
  for (const r of checkRows(deriveVerdict(ledger))) statusCounts[r.effective] = (statusCounts[r.effective] || 0) + 1;
  return {
    kind: 'verify', verdict: ledger.verdict, tree: String(ledger.tree_digest || '').slice(0, 12), tool: ledger.tool,
    executed: sum('executed'), passed: sum('passed'), failed: sum('failed'), skipped: sum('skipped'), flaky: sum('flaky'),
    flaky_suspects: suspects, coverage_pct: cov == null ? null : Number(cov), mutation_score: mut == null ? null : Number(mut),
    suppressions: findings('CK-SUPPRESS'), skip_markers: findings('CK-SKIP'), checks: statusCounts, ...extra,
  };
}

// ---------------------------------------------------------------------------
// Markdown (D12: generated only; you or CI post it)

const cell = (s, n = 160) => truncate(String(s == null ? '' : s).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|'), n);

/** Markdown for a ledger. `short` gives the postable summary: verdict, check table, reproduce commands. */
export function renderMarkdown(input, { short = false } = {}) {
  const ledger = { ...input, checks: arr(input.checks), waivers: arr(input.waivers), claims: arr(input.claims), observed_runs: arr(input.observed_runs) };
  const d = deriveVerdict(ledger);
  const out = [];
  const tree = String(ledger.tree_digest || '').slice(0, 12);
  const base = ledger.base ? `${ledger.base_ref || 'base'} @ ${String(ledger.base).slice(0, 12)}` : 'empty tree';
  out.push(`## Verification evidence: ${d.verdict}${ledger.finalized_at ? '' : ' (provisional)'}`, '');
  out.push(`- Snapshot \`${tree}\` vs ${base} (base from ${ledger.base_source || 'unknown'}); host ${ledger.tool || 'unknown'}; ledger mode ${ledger.mode || 'unknown'}`);
  out.push(ledger.finalized_at ? `- Finalized ${ledger.finalized_at}` : `- Recorded ${ledger.created_at}; not finalized (\`evidence finalize\`)`);
  if (ledger.projects_summary) out.push(`- Projects: ${cell(ledger.projects_summary, 300)}`);
  if (ledger.spec) out.push(`- Spec: ${cell(ledger.spec, 200)}`);
  if (d.needs_human_triage) out.push('- **Needs human triage**: the review reported a critical finding that no reproducing command confirmed.');
  if (ledger.mode === 'manual') out.push('- Created with `evidence init`: checks were recorded from command output, not by `verify`.');
  if (d.effective.some((r) => r.id === 'CK-REVIEW' && r.entries.every((e) => e.pending))) out.push('- No adversarial review was recorded; this verdict carries no second opinion.');
  out.push('', '| Check | Project | Status | Summary |', '|---|---|---|---|');
  for (const r of d.effective) {
    const pending = r.entries.some((e) => e.pending);
    const st = pending ? `not recorded (${r.effective})` : r.effective === r.status ? r.effective : `${r.effective} (recorded ${r.status})`;
    const src = r.sources.includes('input') ? ' (input)' : '';
    out.push(`| ${r.id}${src} | ${cell(r.project, 40)} | ${st}${r.reason ? ` [${cell(r.reason, 40)}]` : ''} | ${cell(r.summary)}${r.notes.length ? ` - ${cell(r.notes.join('; '), 200)}` : ''} |`);
  }
  if (d.reasons.length && !short) {
    out.push('', '### Why this verdict', '');
    for (const r of d.reasons.slice(0, 30)) out.push(`- ${cell(r, 300)}`);
  }
  if (!short) {
    const findings = ledger.checks.flatMap((c) => (c.findings || []).filter((f) => f.severity !== 'info').map((f) => ({ ...f, check: c.id })));
    if (findings.length) {
      out.push('', `### Findings (${findings.length}${findings.length > 40 ? ', first 40' : ''})`, '');
      for (const f of findings.slice(0, 40)) {
        const loc = f.file ? ` \`${f.file}${f.line ? `:${f.line}` : ''}\`` : f.rule ? ` ${f.rule}` : '';
        out.push(`- **${f.check}** ${f.severity}${loc}: ${cell(f.message, 240)}${f.evidence ? ` (\`${cell(f.evidence, 120).replace(/`/g, "'")}\`)` : ''}`);
      }
    }
    if (d.claims.length) {
      out.push('', '### Claims', '', '| Claim | Status | Evidence |', '|---|---|---|');
      for (const c of d.claims) out.push(`| ${cell(c.text, 200)} | ${c.status} | ${c.evidence.join(', ') || '-'} |`);
    }
    if (ledger.waivers.length) {
      out.push('', '### Waivers', '', '| Check | Finding | Reason | Quote verified |', '|---|---|---|---|');
      for (const w of ledger.waivers) out.push(`| ${w.check} | ${cell(w.file || 'all')} | ${cell(w.reason, 240)} | ${w.quote_verified ? 'yes' : `no (${w.by})`} |`);
    }
    if (ledger.observed_runs.length) {
      out.push('', `### Observed runs (${ledger.observed_runs.length}; hooks saw them, they are never evidence)`, '');
      for (const r of ledger.observed_runs.slice(-10)) out.push(`- ${cell(r.ts, 30)} \`${cell(r.cmd_head, 100).replace(/`/g, "'")}\` ${r.class || ''} exit ${r.exit == null ? 'unknown' : r.exit}`);
    }
    if (ledger.budget) {
      const b = ledger.budget;
      out.push('', `### Live budget`, '', `Session ${cell(b.session_id, 60)} (${b.identity_source}): spent ${b.spent} of ${b.max_per_session} ${b.unit}; today ${b.spent_today} of ${b.max_per_day}; remaining ${b.remaining}.`);
    }
  }
  const cmds = [];
  for (const c of ledger.checks) {
    if (c.command && !cmds.some((x) => x.command === c.command)) cmds.push({ id: c.id, command: c.command, cwd: c.cwd, exit: c.exit_code });
  }
  out.push('', '### Reproduce', '', 'Re-run every scripted step on the same snapshot (from the repository root):', '', '```',
    `node "<skill-dir>/scripts/adc.mjs" verify${ledger.base ? ` --base ${String(ledger.base).slice(0, 12)}` : ''}${ledger.spec ? ' --spec <spec>' : ''}`, '```');
  if (cmds.length) {
    out.push('', 'Commands the checks ran (cwd was the snapshot worktree or the repository root):', '', '```');
    for (const c of cmds.slice(0, 20)) out.push(`${c.command}${c.exit != null ? `    # ${c.id}, exit ${c.exit}` : `    # ${c.id}`}`);
    out.push('```');
  }
  if (!short) {
    const integ = ledger.integrity || {};
    out.push('', `<sub>${ledger.generated_by || generatedBy()}; ${integ.count || 0} chained entries, head \`${String(integ.head || '').slice(0, 12)}\`${integ.ledger_sha256 ? `, sealed \`${integ.ledger_sha256.slice(0, 12)}\`` : ''}. Tamper-evident, not tamper-proof: re-run verify for a ledger you did not see produced.</sub>`);
  }
  out.push('');
  return redactSync(out.join('\n'));
}

// ---------------------------------------------------------------------------
// Answer scoring (audit-tests §9.4, review §9.3): the model answers, the script aggregates

/** Built-in yes/no questions with their passing answer. Custom questions must give pass_if. */
export const QUESTIONS = Object.freeze({
  'AT-NO-ASSERT': { kind: 'audit-tests', dimension: 'structure', pass_if: 'no', question: 'Does any changed test lack an assertion?' },
  'AT-MIRROR': { kind: 'audit-tests', dimension: 'structure', pass_if: 'no', question: 'Do assertions mirror the implementation (expected values computed by the code under test)?' },
  'AT-EXCEPTION-ONLY': { kind: 'audit-tests', dimension: 'structure', pass_if: 'no', question: 'Does any test only check that no exception is thrown?' },
  'AT-MOCK-DOMINATED': { kind: 'audit-tests', dimension: 'mocking', pass_if: 'no', question: 'Is any test mock-dominated (mocks the unit under test, or the mock earns no assertions)?' },
  'AT-TAMPER': { kind: 'audit-tests', dimension: 'tampering', pass_if: 'no', question: 'Were tests deleted, skipped, weakened or excluded from discovery?' },
  'AT-RED-GREEN': { kind: 'audit-tests', dimension: 'red-green', pass_if: 'yes', question: 'Does each new regression test fail with an assertion on the base and pass on the snapshot?' },
  'AT-BEHAVIOR': { kind: 'audit-tests', dimension: 'coverage', pass_if: 'yes', question: 'Do the tests exercise the changed behavior (branches, error paths), not just the changed lines?' },
  'AT-RETRY': { kind: 'audit-tests', dimension: 'flake', pass_if: 'no', question: 'Were in-source retries added (jest.retryTimes, @pytest.mark.flaky, retries config)?' },
  'AT-ORDER': { kind: 'audit-tests', dimension: 'flake', pass_if: 'no', question: 'Do tests depend on order, wall-clock time, network or shared state?' },
  'RV-SPEC': { kind: 'review', dimension: 'spec', pass_if: 'yes', question: 'Is every requirement of the spec implemented?' },
  'RV-EDGE': { kind: 'review', dimension: 'spec', pass_if: 'yes', question: 'Are the edge cases the spec lists handled and tested?' },
  'RV-BUG': { kind: 'review', dimension: 'correctness', pass_if: 'no', question: 'Did you find a correctness bug you can reproduce?' },
  'RV-HIDDEN': { kind: 'review', dimension: 'correctness', pass_if: 'no', question: 'Assuming a hidden bug exists: is there special-casing of inputs, hard-coded output or a lookup table?' },
  'RV-ERRORS': { kind: 'review', dimension: 'correctness', pass_if: 'yes', question: 'Are errors handled without being swallowed or downgraded?' },
  'RV-TESTS': { kind: 'review', dimension: 'tests', pass_if: 'yes', question: 'Do the tests exercise the changed behavior?' },
  'RV-SCOPE': { kind: 'review', dimension: 'scope', pass_if: 'no', question: 'Does the diff contain changes unrelated to the spec?' },
  'RV-SECURITY': { kind: 'review', dimension: 'security', pass_if: 'no', question: 'Did you find a security problem (injection, secrets, authorization)?' },
});

function normAnswer(v) {
  if (v === true) return 'yes';
  if (v === false) return 'no';
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (['yes', 'y'].includes(s)) return 'yes';
  if (['no', 'n'].includes(s)) return 'no';
  if (['unknown', 'unsure', '?', 'n/a', 'na'].includes(s)) return 'unknown';
  return null;
}

/**
 * Aggregate yes/no/unknown answers. yes/no answers need a valid `file:line` citation (checked
 * against `tree` when root and tree are given), otherwise they are rejected and count as unknown.
 * Critical review items need a citation and a reproduction step. Returns { ..., check }.
 */
export function scoreAnswers(input, { root = null, tree = null } = {}) {
  const doc = Array.isArray(input) ? { answers: input } : input && typeof input === 'object' ? input : null;
  if (!doc || !Array.isArray(doc.answers)) throw usageError('answers must be a JSON array or an object with an "answers" array');
  const check = citationChecker(root, tree);
  const answers = [];
  const dims = {};
  const kinds = new Set();
  for (const raw of doc.answers.slice(0, 500)) {
    if (!raw || typeof raw !== 'object') continue;
    const id = raw.id ? String(raw.id) : null;
    const cat = id && QUESTIONS[id] ? QUESTIONS[id] : null;
    if (cat) kinds.add(cat.kind);
    const passIf = normAnswer(cat ? cat.pass_if : raw.pass_if);
    const answer = normAnswer(raw.answer);
    const citations = [...arr(raw.citation), ...arr(raw.citations)].map(String).slice(0, 20);
    const a = {
      id, dimension: String(cat ? cat.dimension : raw.dimension || 'general'), question: truncate(String(cat ? cat.question : raw.question || ''), 300),
      answer, pass_if: passIf, citations, outcome: null, note: truncate(String(raw.note || ''), 300),
    };
    const verdicts = citations.map((c) => check(c));
    if (answer == null) { a.outcome = 'rejected'; a.reason = 'BAD_ANSWER'; }
    else if (answer !== 'unknown' && passIf !== 'yes' && passIf !== 'no') { a.outcome = 'rejected'; a.reason = 'NO_POLARITY'; }
    else if (answer === 'unknown') a.outcome = 'unknown';
    else if (!citations.length) { a.outcome = 'rejected'; a.reason = 'NO_CITATION'; }
    else if (!verdicts.some((v) => v.ok)) { a.outcome = 'rejected'; a.reason = verdicts[0].reason; }
    else a.outcome = answer === passIf ? 'pass' : 'fail';
    const bad = verdicts.filter((v) => !v.ok);
    if (bad.length && a.outcome !== 'rejected') a.invalid_citations = bad.map((v) => v.reason);
    answers.push(a);
    const dm = dims[a.dimension] || (dims[a.dimension] = { passed: 0, failed: 0, unknown: 0, rejected: 0, score: null });
    dm[{ pass: 'passed', fail: 'failed', unknown: 'unknown', rejected: 'rejected' }[a.outcome]]++;
  }
  for (const dm of Object.values(dims)) dm.score = dm.passed + dm.failed ? Number((dm.passed / (dm.passed + dm.failed)).toFixed(3)) : null;
  const total = (k) => Object.values(dims).reduce((n, dm) => n + dm[k], 0);
  const totals = { questions: answers.length, passed: total('passed'), failed: total('failed'), unknown: total('unknown'), rejected: total('rejected') };
  totals.answered = totals.passed + totals.failed;
  totals.score = totals.answered ? Number((totals.passed / totals.answered).toFixed(3)) : null;
  totals.coverage = totals.questions ? Number((totals.answered / totals.questions).toFixed(3)) : 0;

  const items = (list) => arr(list).filter((x) => x && typeof x === 'object').slice(0, 100).map((x) => {
    const cit = [...arr(x.citation), ...arr(x.citations)].map(String);
    return { title: truncate(String(x.title || x.message || ''), 240), citations: cit, repro: truncate(String(x.repro || ''), 500), ok: cit.some((c) => check(c).ok) };
  });
  const criticalRaw = items(doc.critical || doc.criticals);
  const criticals = criticalRaw.filter((c) => c.ok && c.repro.trim());
  const rejectedCriticals = criticalRaw.filter((c) => !(c.ok && c.repro.trim()));
  const important = [...items(doc.important), ...rejectedCriticals.map((c) => ({ ...c, downgraded: 'critical without a valid citation or reproduction step' }))];
  const minor = items(doc.minor);
  const kind = doc.kind === 'review' || doc.kind === 'audit-tests' ? doc.kind
    : kinds.size === 1 ? [...kinds][0] : (criticalRaw.length || doc.ready_to_merge != null ? 'review' : 'audit-tests');
  const verdict = totals.failed || criticals.length ? 'fail' : totals.unknown || totals.rejected ? 'incomplete' : 'pass';

  const checkId = kind === 'review' ? 'CK-REVIEW' : 'CK-MOCK';
  let status;
  let reason = null;
  if (!totals.questions && !criticalRaw.length && !important.length) { status = 'unverified'; reason = 'NO_ANSWERS'; }
  else if (kind === 'review') status = criticals.length ? 'fail' : totals.failed || important.length || totals.rejected ? 'finding' : 'pass';
  else status = totals.failed ? 'finding' : 'pass';
  const findings = [
    ...criticals.map((c) => ({ id: checkId, severity: 'fail', ...citeLoc(c.citations), message: `critical: ${c.title}`, evidence: `repro: ${c.repro}` })),
    ...important.map((c) => ({ id: checkId, severity: 'finding', ...citeLoc(c.citations), message: `important: ${c.title}${c.downgraded ? ` (${c.downgraded})` : ''}`, evidence: c.repro ? `repro: ${c.repro}` : '' })),
    ...answers.filter((a) => a.outcome === 'fail').map((a) => ({ id: checkId, severity: 'finding', ...citeLoc(a.citations), message: `${a.id || a.dimension}: ${a.question} -> ${a.answer}`, evidence: a.note })),
    ...answers.filter((a) => a.outcome === 'rejected').map((a) => ({ id: checkId, severity: 'info', file: null, line: null, message: `answer rejected (${a.reason}): ${a.question}`, evidence: '' })),
  ];
  const summary = `${kind}: ${totals.passed} pass, ${totals.failed} fail, ${totals.unknown} unknown, ${totals.rejected} rejected`
    + (kind === 'review' ? `; ${criticals.length} critical, ${important.length} important, ${minor.length} minor; ready to merge: ${doc.ready_to_merge == null ? 'not stated' : String(doc.ready_to_merge)}` : '');
  return {
    kind, answers, dimensions: dims, totals, verdict,
    severity: { critical: criticals.length, important: important.length, minor: minor.length, rejected_criticals: rejectedCriticals.length },
    criticals, important, minor, ready_to_merge: doc.ready_to_merge == null ? null : truncate(String(doc.ready_to_merge), 40),
    declined_to_judge: arr(doc.declined_to_judge).map((x) => truncate(String(x), 300)).slice(0, 50),
    check: {
      id: checkId, fm: [...CHECK_FM[checkId]], project: '.', status, reason, summary, findings,
      data: { totals, dimensions: dims, severity: { critical: criticals.length, important: important.length, minor: minor.length }, ready_to_merge: doc.ready_to_merge ?? null, criticals },
    },
  };
}

function citeLoc(citations) {
  for (const c of citations) {
    const m = /^(.+?)(?::(\d+)|#L(\d+))/.exec(c);
    if (m) return { file: toPosix(m[1]), line: Number(m[2] || m[3]) };
  }
  return { file: null, line: null };
}

// ---------------------------------------------------------------------------
// Recorded commands (`evidence add --run|--repro`)

const NOT_FOUND_EXITS = new Set([126, 127, 9009]);

async function runRecorded({ root, file, id, command, repro, project, summary, timeoutS, dryRun }) {
  const cid = String(id || '').trim().toUpperCase();
  if (!CHECK_ID_RE.test(cid)) throw usageError('--check <CK-ID> is required with --run/--repro');
  if (SCRIPTED.has(cid)) throw usageError(`${cid} is recorded by the scripted steps; a hand-picked command cannot stand in for it (re-run verify)`);
  const cwd = project ? path.resolve(root, project) : root;
  const rel = relPosix(root, cwd);
  if (rel == null) throw usageError('--project must be inside the repository');
  const base = { id: cid, project: rel, command, cwd: rel, cost: 0, findings: [] };
  if (dryRun) return { ...base, status: 'skipped', reason: 'DRY_RUN', exit_code: null, summary: 'dry run: command not executed', data: { repro } };
  const res = runShell(command, { cwd, timeoutMs: Math.max(1, Number(timeoutS) || 600) * 1000 });
  const output = `${res.stdout || ''}${res.stderr ? `${res.stdout ? '\n' : ''}${res.stderr}` : ''}`;
  const redact = await makeRedactor();
  const log = path.join(artifactsDir(file), `run-${stamp()}-${nonce().slice(0, 6)}.log`);
  writeFileAtomic(log, redact(output));
  let status;
  let reason = null;
  let confirmed = false;
  if (res.timedOut) { status = 'unverified'; reason = 'TIMEOUT'; }
  else if (res.exit == null) { status = 'unverified'; reason = res.error ? `SPAWN_${String(res.error).toUpperCase()}` : `SIGNAL_${res.signal || 'UNKNOWN'}`; }
  else if (NOT_FOUND_EXITS.has(res.exit) || (IS_WINDOWS && /is not recognized as an internal or external command/i.test(res.stderr))) { status = 'unverified'; reason = 'COMMAND_NOT_FOUND'; }
  else if (repro) { confirmed = res.exit !== 0; status = confirmed ? 'fail' : 'pass'; }
  else status = res.exit === 0 ? 'pass' : 'fail';
  const text = summary || (repro ? (confirmed ? `reproduced: command exited ${res.exit}` : `not reproduced: command exited ${res.exit}`) : `command exited ${res.exit}`);
  return {
    ...base, status, reason, exit_code: res.exit, duration_ms: res.ms, summary: text, output_sha256: sha256(output),
    artifacts: [posixRef(root, log)], data: { repro, confirmed, signal: res.signal || null },
  };
}

// ---------------------------------------------------------------------------
// CLI

function readInputArg(arg, cwd) {
  if (arg === '-') {
    try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
  }
  const file = path.resolve(cwd, arg);
  const text = readText(file);
  if (text == null) throw usageError(`file not found: ${toPosix(file)}`);
  return text;
}

function parseJsonArg(arg, cwd) {
  const text = readInputArg(arg, cwd);
  try { return JSON.parse(text); } catch { throw usageError(`${arg === '-' ? 'stdin' : arg} is not valid JSON`); }
}

function openRepoState(ctx) {
  const root = requireRepo(ctx.cwd);
  const state = prepareStateDir({ ...ctx, cwd: root }, { create: false });
  return { root, state };
}

/**
 * The ledger plus a fresh snapshot of the working tree (§7.5: the CLI recomputes it). Changing
 * commands refuse a stale ledger, so evidence about one tree is never attached to another and
 * a late write cannot make an old ledger look fresh to the stop hook.
 */
function openCurrent(ctx, values, { refuseStale = true } = {}) {
  const { root, state } = openRepoState(ctx);
  const found = loadLedger(ledgerArg(ctx, values), state);
  const snapshot = createQaSnapshot(root, { exclude: snapshotExcludes(state) });
  if (refuseStale && snapshot.tree !== found.ledger.tree_digest) {
    throw unverifiable('LEDGER_STALE', `the working tree changed since this ledger was recorded (ledger ${String(found.ledger.tree_digest).slice(0, 12)}, now ${snapshot.tree.slice(0, 12)}); re-run verify. Keep scratch files (answers, matrices) outside the repository or under .adc/`,
      { ledger_tree: found.ledger.tree_digest, current_tree: snapshot.tree });
  }
  return { root, state, target: { root, state, base: null, snapshot }, ...found };
}

const ledgerArg = (ctx, values) => (values.ledger ? path.resolve(ctx.cwd, values.ledger) : null);
const LEDGER_OPT = { ledger: { type: 'string' } };
const adcCmd = () => `node "${toPosix(ADC_SCRIPT)}"`;

const initCmd = defineCommand({
  name: 'evidence init',
  usage: 'evidence init [--base <ref>] [--spec <file|-|url>] [--session <id>] [--tool <host>]\nCreate an empty ledger for the current working-tree snapshot (manual flows; verify creates its own).',
  options: { base: { type: 'string' }, spec: { type: 'string' }, session: { type: 'string' }, tool: { type: 'string' } },
  positionals: false,
  run: async (ctx, values) => {
    const tool = checkTool(values.tool);
    const target = await prepareQaTarget(ctx, { base: values.base || null, createState: !ctx.dryRun });
    const spec = values.spec ? readSpecInput(values.spec, { cwd: ctx.cwd, root: target.root }) : null;
    const { path: file, ledger } = await initLedger({ target, tool, spec: spec ? spec.ref : null, specText: spec ? spec.text : null, sessionId: values.session || null, mode: 'manual', dryRun: ctx.dryRun });
    return { result: { ledger: posixRef(target.root, file), dry_run: ctx.dryRun, tree_digest: ledger.tree_digest, session_id: ledger.session_id, verdict: ledger.verdict }, exit: EXIT.OK, summary: `${ctx.dryRun ? 'would create' : 'created'} ${posixRef(target.root, file)}` };
  },
});

const addCmd = defineCommand({
  name: 'evidence add',
  usage: [
    'evidence add <check.json|-> [--ledger <path>]',
    '  a check, an array of checks, a command\'s JSON output with checks[], or a completed trace matrix',
    'evidence add --check <CK-ID> --run "<command>" [--project <dir>] [--summary <text>] [--timeout <s>] [--ledger <path>]',
    'evidence add --check CK-REVIEW --repro "<command that demonstrates the bug>" [--ledger <path>]',
  ].join('\n'),
  options: { ...LEDGER_OPT, check: { type: 'string' }, run: { type: 'string' }, repro: { type: 'string' }, project: { type: 'string' }, summary: { type: 'string' }, timeout: { type: 'string' } },
  run: async (ctx, values, pos) => {
    const { root, path: file, ledger } = openCurrent(ctx, values);
    let checks;
    let source;
    let inputTree = null;
    if (values.run || values.repro) {
      if (values.run && values.repro) throw usageError('use either --run or --repro');
      if (pos.length) throw usageError('--run/--repro take no file argument');
      if (ledger.finalized_at) throw new AdcError(EXIT.USAGE, 'LEDGER_FINALIZED', 'the ledger is finalized and cannot change; run verify again');
      if (values.timeout != null && !(Number(values.timeout) > 0)) throw usageError('--timeout must be a positive number of seconds');
      checks = [await runRecorded({ root, file, id: values.check, command: values.run || values.repro, repro: Boolean(values.repro), project: values.project, summary: values.summary, timeoutS: values.timeout, dryRun: ctx.dryRun })];
      source = 'run';
    } else {
      if (pos.length !== 1) throw usageError('evidence add needs exactly one <file|-> (or --check with --run/--repro)');
      const parsed = inputDocToChecks(parseJsonArg(pos[0], ctx.cwd));
      checks = parsed.checks;
      inputTree = parsed.tree;
      source = 'input';
    }
    const res = await addChecks(file, checks, { source, root, inputTree, dryRun: ctx.dryRun });
    const d = deriveVerdict(res.ledger);
    return {
      result: { ledger: posixRef(root, file), dry_run: ctx.dryRun, added: res.added.map((c) => ({ id: c.id, project: c.project, status: c.status, reason: c.reason, summary: c.summary, seq: c.seq })), verdict: d.verdict, checks: checkRows(d) },
      exit: EXIT.OK, summary: `added ${res.added.length} check(s); verdict now ${d.verdict}`,
    };
  },
});

const claimsCmd = defineCommand({
  name: 'evidence claims',
  usage: 'evidence claims <file|-> [--ledger <path>]\nRecord the implementer\'s claims (text, or JSON [{ "text", "evidence": ["CK-..."] }]); status is always derived.',
  options: { ...LEDGER_OPT },
  run: async (ctx, values, pos) => {
    if (pos.length !== 1) throw usageError('evidence claims needs <file|->');
    const input = readInputArg(pos[0], ctx.cwd);
    const { root, path: file } = openCurrent(ctx, values);
    const res = await setClaims(file, input, { dryRun: ctx.dryRun });
    const d = deriveVerdict(res.ledger);
    return { result: { ledger: posixRef(root, file), dry_run: ctx.dryRun, added: res.added.length, claims: d.claims.map(({ seq, ...c }) => c), verdict: d.verdict }, exit: EXIT.OK, summary: `${res.added.length} claim(s) recorded; ${d.claims.filter((c) => c.status === 'supported').length}/${d.claims.length} supported` };
  },
});

const waiveCmd = defineCommand({
  name: 'evidence waive',
  usage: 'evidence waive <CK-ID> --reason "<quoted spec text>" [--file <path|R-id>] [--ledger <path>]\nWaivers cap the verdict at PASS-WITH-FINDINGS and must quote the spec the ledger captured.',
  options: { ...LEDGER_OPT, reason: { type: 'string' }, file: { type: 'string' } },
  run: async (ctx, values, pos) => {
    if (pos.length !== 1) throw usageError('evidence waive needs <CK-ID>');
    const { root, path: file } = openCurrent(ctx, values);
    const res = await addWaiver(file, { check: pos[0], file: values.file || null, reason: values.reason }, { root, interactive: ctx.interactiveTty, dryRun: ctx.dryRun });
    const d = deriveVerdict(res.ledger);
    return { result: { ledger: posixRef(root, file), dry_run: ctx.dryRun, waiver: res.waiver, verdict: d.verdict }, exit: EXIT.OK, summary: `waived ${res.waiver.check}${res.waiver.file ? ` (${res.waiver.file})` : ''}; verdict now ${d.verdict}` };
  },
});

const finalizeCmd = defineCommand({
  name: 'evidence finalize',
  usage: 'evidence finalize [--ledger <path>]\nVerify entry/artifact hashes and staleness, derive CK-CLAIMS and the verdict, seal the ledger. Exit 1 on FAIL, 4 on UNVERIFIED.',
  options: { ...LEDGER_OPT },
  positionals: false,
  run: async (ctx, values) => {
    const { target, path: file } = openCurrent(ctx, values, { refuseStale: false });
    const res = await finalizeLedger(file, { target, dryRun: ctx.dryRun });
    const d = deriveVerdict(res.ledger);
    return {
      result: { ledger: posixRef(target.root, file), markdown: posixRef(target.root, markdownPath(file)), dry_run: ctx.dryRun, verdict: d.verdict, needs_human_triage: d.needs_human_triage, reasons: d.reasons, checks: checkRows(d), claims: d.claims.map(({ seq, ...c }) => c) },
      exit: verdictExit(d.verdict), summary: `${d.verdict}${ctx.dryRun ? ' (dry run, not sealed)' : ''}; ledger ${posixRef(target.root, file)}`,
    };
  },
});

const renderCmd = defineCommand({
  name: 'evidence render',
  usage: 'evidence render [--md] [--short] [--out <path>] [--ledger <path>]\nPrint the ledger as Markdown (the summary to post with --short); --out writes it to a file.',
  options: { ...LEDGER_OPT, md: { type: 'boolean' }, short: { type: 'boolean' }, out: { type: 'string' } },
  positionals: false,
  run: async (ctx, values) => {
    await secretPatterns();
    const state = prepareStateDir(ctx, { create: false });
    const { path: file, ledger } = loadLedger(ledgerArg(ctx, values), state);
    const markdown = renderMarkdown(ledger, { short: Boolean(values.short) });
    let out = null;
    if (values.out) {
      out = path.resolve(ctx.cwd, values.out);
      if (!ctx.dryRun) writeFileAtomic(out, markdown);
    }
    return { result: { ledger: toPosix(file), verdict: deriveVerdict(ledger).verdict, markdown, ...(out ? { out: toPosix(out), dry_run: ctx.dryRun } : {}) }, exit: EXIT.OK, human: markdown, summary: out ? `${ctx.dryRun ? 'would write' : 'wrote'} ${toPosix(out)}` : '' };
  },
});

const statusCmd = defineCommand({
  name: 'evidence status',
  usage: 'evidence status [--ledger <path>]\nNewest ledger: verdict, integrity, pending model steps, and staleness against a fresh snapshot.',
  options: { ...LEDGER_OPT },
  positionals: false,
  run: async (ctx, values) => {
    const { root, state } = openRepoState(ctx);
    const target = { root, state, base: null, snapshot: createQaSnapshot(root, { exclude: snapshotExcludes(state) }) };
    const st = ledgerStatus({ target, ledgerPath: ledgerArg(ctx, values) });
    const summary = st.ledger
      ? `${st.verdict}${st.finalized ? ' (finalized)' : ' (provisional)'}${st.stale ? ', STALE: the working tree changed since' : ''}${st.integrity.ok ? '' : ', INTEGRITY FAILED'}`
      : st.message;
    return { result: st, exit: EXIT.OK, summary };
  },
});

const scoreCmd = defineCommand({
  name: 'evidence score',
  usage: 'evidence score <answers.json|-> [--ledger <path>] [--add]\nAggregate yes/no/unknown answers (audit-tests, review); answers without a file:line citation are rejected.\n--add records CK-REVIEW (review) or CK-MOCK (audit-tests) in the ledger.',
  options: { ...LEDGER_OPT, add: { type: 'boolean' } },
  run: async (ctx, values, pos) => {
    if (pos.length !== 1) throw usageError('evidence score needs <answers.json|->');
    const input = parseJsonArg(pos[0], ctx.cwd);
    let root = null;
    let found = null;
    if (values.add) {
      ({ root, ...found } = openCurrent(ctx, values));
    } else {
      try {
        const opened = openRepoState(ctx);
        root = opened.root;
        found = values.ledger || listLedgers(opened.state)[0] ? loadLedger(ledgerArg(ctx, values), opened.state) : null;
      } catch (err) {
        if (values.ledger) throw err;
      }
    }
    const scored = scoreAnswers(input, { root, tree: found ? found.ledger.tree_digest : null });
    let added = null;
    if (values.add) {
      const res = await addChecks(found.path, [scored.check], { source: 'input', root, dryRun: ctx.dryRun });
      added = res.added.map((c) => ({ id: c.id, status: c.status, seq: c.seq }));
    }
    const exit = scored.verdict === 'fail' ? EXIT.FINDINGS : EXIT.OK;
    return { result: { ...scored, ledger: found ? posixRef(root, found.path) : null, citations_checked_against: found ? found.ledger.tree_digest : null, added, dry_run: ctx.dryRun }, exit, summary: scored.check.summary };
  },
});

/** `evidence <init|add|claims|waive|finalize|render|status|score>`. */
export const evidenceCommand = defineGroup({
  name: 'evidence',
  usage: [
    'evidence <init|add|claims|waive|finalize|render|status|score> [options]',
    '  init        new ledger for the current snapshot (verify creates its own)',
    '  add         record checks, a completed trace matrix, or a command run (--run, --repro)',
    '  claims      record implementer claims (status derived from the checks)',
    '  waive       waive a finding with quoted spec text (caps at PASS-WITH-FINDINGS)',
    '  finalize    verify hashes and staleness, derive CK-CLAIMS and the verdict, seal',
    '  render      Markdown (--short for the summary to post, --out <file>)',
    '  status      newest ledger, stale or not, integrity',
    '  score       aggregate yes/no/unknown answers with file:line citations',
    `Run as: ${adcCmd()} evidence <sub> --json`,
  ].join('\n'),
  subcommands: { init: initCmd, add: addCmd, claims: claimsCmd, waive: waiveCmd, finalize: finalizeCmd, render: renderCmd, status: statusCmd, score: scoreCmd },
});
