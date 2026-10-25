// Live probes under the budget ledger (§10.3): the trusted runner. It loads ADC_LIVE_TOKEN
// (environment, then .adc/.env.live), resolves the session identity, checks spend against the
// session and daily caps before every probe (reserving under budget.json.lock), runs each probe
// with piped stdio, replaces every loaded secret value before anything is kept or printed, and
// records cost and outcome in budget.json, metrics.jsonl and the evidence ledger.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  EXIT, AdcError, usageError, envError, defineCommand, defineGroup, readText, readJson, writeFileAtomic,
  writeJsonAtomic, withLock, ensureDir, matchGlob, sha256, nonce, nowIso, stamp, today, toPosix, relPosix,
  truncate, redactLiterals, IS_WINDOWS, TEMPLATES_DIR,
} from './core.mjs';
import {
  DEFAULT_BUDGET, statePaths, prepareStateDir, parseEnvFile, setOwnerOnly, checkOwnerOnly, stateIgnored,
  newestOpenSession, appendMetrics, prepareTarget,
} from './state.mjs';

export const BUDGET_SCHEMA = 'adc-budget/1';
export const PROBES_SCHEMA = 'adc-probes/1';
export const DEFAULT_MANIFEST = 'tests/live/probes.json';
export const CHECKLIST_NAME = 'live-checklist.md';
export const CI_BUDGET_CEILING = 10_000;
export const KEEP_SESSIONS = 50;
const KEEP_DAYS = 90;
const KEEP_PROBE_ENTRIES = 200;
const KEEP_RUN_LOGS = 20;
const DEFAULT_TIMEOUT_S = 120;
const MAX_TIMEOUT_S = 3600;
const OUTPUT_CAP = 8 * 1024 * 1024;
const PROBE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const LIVE_FM = ['FM-02'];

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const finiteNonNeg = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const round = (n) => Math.round(n * 1000) / 1000;
const slug = (id) => String(id).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 100) || 'probe';

// ---------------------------------------------------------------------------
// Redaction: literal values first (raw, URL-encoded, base64), then secret shapes

const FALLBACK_SHAPES = [
  new RegExp('\\b(?:AKIA|ASIA)[0-9A-Z]{16}\\b', 'g'),
  new RegExp('\\bgh[pousr]_[A-Za-z0-9]{36,}', 'g'),
  new RegExp('\\bgithub' + '_pat_[A-Za-z0-9_]{22,}', 'g'),
  new RegExp('\\bxox[abposr]-[A-Za-z0-9-]{10,}', 'g'),
];
let shapeCache = null;

async function secretShapes() {
  if (shapeCache) return shapeCache;
  const list = FALLBACK_SHAPES.map((re) => ({ id: 'secret', re, group: false }));
  try {
    const m = await import('./markers.mjs');
    for (const p of Array.isArray(m.SECRET_PATTERNS) ? m.SECRET_PATTERNS : []) {
      if (!p || !(p.re instanceof RegExp)) continue;
      const flags = p.re.flags.includes('g') ? p.re.flags : `${p.re.flags}g`;
      list.push({ id: String(p.id || 'secret').replace(/^secret\./, ''), re: new RegExp(p.re.source, flags), group: true });
    }
  } catch {
    // markers.mjs is optional; the literal values are what matters for an opaque token.
  }
  shapeCache = list;
  return list;
}

/** A sync redactor for `literals` ([{name, value}]) plus secret shapes. */
export async function makeRedactor(literals = []) {
  const shapes = await secretShapes();
  const lits = literals.filter((l) => l && l.value && String(l.value).length >= 4);
  return (text) => {
    if (typeof text !== 'string' || !text) return text;
    let out = lits.length ? redactLiterals(text, lits) : text;
    out = out.replace(/ADC_LIVE_TOKEN(\s*[=:]\s*)["']?(?!\[REDACTED)[^\s"']+["']?/g, 'ADC_LIVE_TOKEN$1[REDACTED]');
    for (const s of shapes) {
      s.re.lastIndex = 0;
      out = out.replace(s.re, (m, g1) => (s.group && typeof g1 === 'string' && g1 ? m.replace(g1, `[REDACTED:${s.id}]`) : `[REDACTED:${s.id}]`));
    }
    return out;
  };
}

/** Redact every string inside a JSON value (hash-valued keys are kept). */
export function redactValue(value, redact, key = '') {
  if (typeof value === 'string') return /sha256$/.test(key) ? value : redact(value);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, redact, key));
  if (isObj(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[redact(k)] = redactValue(v, redact, k);
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Processes: async spawn with piped stdio, output caps and a tree kill on timeout

const active = new Set();

function killTree(child) {
  if (!child || child.exitCode !== null || child.pid == null) return;
  if (IS_WINDOWS) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    return;
  }
  try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {} }
  const t = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 2000);
  t.unref();
}

function collector(max) {
  const chunks = [];
  let size = 0;
  let dropped = 0;
  return {
    push(buf) {
      chunks.push(buf);
      size += buf.length;
      while (size > max && chunks.length > 1) { const c = chunks.shift(); size -= c.length; dropped += c.length; }
    },
    text() {
      let buf = Buffer.concat(chunks);
      if (buf.length > max) { dropped += buf.length - max; buf = buf.subarray(buf.length - max); }
      let s = buf.toString('utf8');
      // A secret cut in half at the truncation point would escape literal redaction.
      if (dropped) { const nl = s.indexOf('\n'); s = nl >= 0 ? s.slice(nl + 1) : ''; }
      return { text: s, dropped };
    },
  };
}

/**
 * Spawn `command` (with `args`, or a command line when `shell` is true) with piped stdio.
 * Resolves `{exit, signal, stdout, stderr, ms, timedOut, error, truncated}`; never rejects.
 * On timeout the whole process tree is killed (process group on POSIX, taskkill /T on Windows).
 */
export function spawnCapture(command, args = [], { cwd, env, timeoutMs = 0, shell = false, input = null, maxBytes = OUTPUT_CAP, windowsVerbatimArguments = false } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    let child;
    try {
      child = spawn(command, args, {
        cwd, env: env || process.env, shell, windowsHide: true, detached: !IS_WINDOWS, windowsVerbatimArguments,
        stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ exit: null, signal: null, stdout: '', stderr: '', ms: Date.now() - started, timedOut: false, error: err.code || err.message, truncated: false });
      return;
    }
    active.add(child);
    const out = collector(maxBytes);
    const errc = collector(maxBytes);
    child.stdout.on('data', (b) => out.push(b));
    child.stderr.on('data', (b) => errc.push(b));
    if (input != null) { child.stdin.on('error', () => {}); child.stdin.end(input); }
    let timedOut = false;
    let error = null;
    const timer = timeoutMs > 0 ? setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs) : null;
    let done = false;
    const finish = (code, signal) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      active.delete(child);
      const o = out.text();
      const e = errc.text();
      resolve({ exit: typeof code === 'number' ? code : null, signal: signal || null, stdout: o.text, stderr: e.text, ms: Date.now() - started, timedOut, error, truncated: Boolean(o.dropped || e.dropped) });
    };
    child.on('error', (err) => { error = err.code || err.message; finish(null, null); });
    child.on('close', finish);
  });
}

function onInterrupt() {
  for (const c of active) killTree(c);
  process.exit(130);
}

// ---------------------------------------------------------------------------
// The budget ledger (.adc/budget.json, §10.3.2)

function templateBudget() {
  const tpl = readJson(path.join(TEMPLATES_DIR, 'adc', 'budget.json'), null);
  return isObj(tpl) ? tpl : { schema: BUDGET_SCHEMA, unit: 'credits', ...DEFAULT_BUDGET, days: {}, sessions: {} };
}

/** Validate and fill a parsed budget ledger. Returns `{ ok, error, budget }`; budget is always complete. */
export function normalizeBudget(raw) {
  const base = templateBudget();
  if (!isObj(raw)) return { ok: false, error: 'not a JSON object', budget: normalizeBudget(base).budget };
  if (raw.schema != null && raw.schema !== BUDGET_SCHEMA) return { ok: false, error: `unknown schema "${truncate(String(raw.schema), 40)}"`, budget: normalizeBudget(base).budget };
  const notes = [];
  const cap = (k) => {
    if (raw[k] == null) return DEFAULT_BUDGET[k];
    const n = Number(raw[k]);
    if (!Number.isFinite(n) || n < 0) { notes.push(`${k} is not a non-negative number; using ${DEFAULT_BUDGET[k]}`); return DEFAULT_BUDGET[k]; }
    return n;
  };
  const budget = {
    ...raw, schema: BUDGET_SCHEMA, unit: typeof raw.unit === 'string' && raw.unit ? raw.unit : 'credits',
    max_per_session: cap('max_per_session'), max_per_day: cap('max_per_day'), warn_at: cap('warn_at'),
    days: {}, sessions: {}, cumulative: isObj(raw.cumulative) ? raw.cumulative : {},
  };
  for (const [d, v] of Object.entries(isObj(raw.days) ? raw.days : {})) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    budget.days[d] = { ...(isObj(v) ? v : {}), spent: finiteNonNeg(Number(isObj(v) ? v.spent : NaN)) ? Number(v.spent) : 0 };
  }
  for (const [id, v] of Object.entries(isObj(raw.sessions) ? raw.sessions : {})) {
    if (!isObj(v)) continue;
    budget.sessions[id] = { ...v, spent: finiteNonNeg(Number(v.spent)) ? Number(v.spent) : 0, probes: Array.isArray(v.probes) ? v.probes.filter(isObj) : [] };
  }
  return { ok: true, error: null, notes, budget };
}

/**
 * Read `.adc/budget.json` for a state dir (from state.prepareStateDir or resolveStateDir).
 * Returns `{ path, exists, valid, error, budget, defaults_exceeded }` and never writes.
 */
export function loadBudget(stateInfo) {
  const file = (stateInfo.paths || statePaths(stateInfo.dir)).budget;
  const text = readText(file);
  if (text == null) {
    const n = normalizeBudget(templateBudget());
    return { path: toPosix(file), exists: false, valid: false, error: 'missing', budget: n.budget, defaults_exceeded: false };
  }
  let raw;
  try { raw = JSON.parse(text); } catch (err) {
    const n = normalizeBudget(templateBudget());
    return { path: toPosix(file), exists: true, valid: false, error: `unparsable: ${truncate(err.message, 120)}`, budget: n.budget, defaults_exceeded: false };
  }
  const n = normalizeBudget(raw);
  const b = n.budget;
  return {
    path: toPosix(file), exists: true, valid: n.ok, error: n.error, notes: n.notes || [], budget: b,
    defaults_exceeded: n.ok && (b.max_per_session > DEFAULT_BUDGET.max_per_session || b.max_per_day > DEFAULT_BUDGET.max_per_day),
  };
}

/** Does metrics.jsonl or .adc/evidence/ already record live spend for `day` (UTC)? */
export function liveSpendRecorded(stateInfo, day = today()) {
  const p = stateInfo.paths || statePaths(stateInfo.dir);
  try {
    const st = fs.statSync(p.metrics);
    const fd = fs.openSync(p.metrics, 'r');
    const len = Math.min(st.size, 5 * 1024 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    for (const line of buf.toString('utf8').split('\n')) {
      if (!line.includes('"live-')) continue;
      let r;
      try { r = JSON.parse(line); } catch { continue; }
      if (!r || !String(r.ts || '').startsWith(day)) continue;
      if ((r.kind === 'live-probe' && Number(r.cost) > 0) || (r.kind === 'live-run' && Number(r.run_spent) > 0)) return true;
    }
  } catch {}
  try {
    for (const name of fs.readdirSync(p.evidence)) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(p.evidence, name);
      const st = fs.statSync(file);
      if (st.size > 20 * 1024 * 1024 || new Date(st.mtimeMs).toISOString().slice(0, 10) !== day) continue;
      const doc = readJson(file, null);
      if (doc && Array.isArray(doc.checks) && doc.checks.some((c) => c && c.id === 'CK-LIVE' && Number(c.cost) > 0)) return true;
    }
  } catch {}
  return false;
}

/**
 * Caps for one run (§10.3.1/§10.3.2): `agent` runs keep the shipped caps hard (a budget.json
 * raised above them is ignored, because the agent can write that file); `ci` runs may set the
 * session cap with ADC_LIVE_BUDGET (≤ 10,000, also lifting that day's cap); `interactive` runs
 * honor a `--credits-override` persisted on the session. `credits` limits this run's own spend.
 */
export function effectiveCaps(budget, { runClass = 'agent', session = null, env = process.env, credits = null } = {}) {
  const warnings = [];
  let sessionCap = budget.max_per_session;
  let dayCap = budget.max_per_day;
  const source = { session: 'budget.json', day: 'budget.json' };
  if (runClass === 'agent') {
    if (sessionCap > DEFAULT_BUDGET.max_per_session) {
      warnings.push(`budget.json raises max_per_session to ${sessionCap}; agent runs keep the shipped cap of ${DEFAULT_BUDGET.max_per_session}`);
      sessionCap = DEFAULT_BUDGET.max_per_session;
      source.session = 'default';
    }
    if (dayCap > DEFAULT_BUDGET.max_per_day) {
      warnings.push(`budget.json raises max_per_day to ${dayCap}; agent runs keep the shipped cap of ${DEFAULT_BUDGET.max_per_day}`);
      dayCap = DEFAULT_BUDGET.max_per_day;
      source.day = 'default';
    }
  } else if (runClass === 'ci') {
    const raw = env.ADC_LIVE_BUDGET;
    if (raw != null && String(raw).trim() !== '') {
      let n = Number(String(raw).trim());
      if (!Number.isFinite(n) || n < 0) warnings.push('ADC_LIVE_BUDGET is not a non-negative number; ignored');
      else {
        if (n > CI_BUDGET_CEILING) { warnings.push(`ADC_LIVE_BUDGET ${n} exceeds the ceiling; using ${CI_BUDGET_CEILING}`); n = CI_BUDGET_CEILING; }
        sessionCap = Math.floor(n);
        source.session = 'ADC_LIVE_BUDGET';
        if (sessionCap > dayCap) { dayCap = sessionCap; source.day = 'ADC_LIVE_BUDGET'; }
      }
    }
  } else if (runClass === 'interactive' && session && isObj(session.override) && finiteNonNeg(Number(session.override.max))) {
    sessionCap = Number(session.override.max);
    source.session = 'override';
    if (sessionCap > dayCap) { dayCap = sessionCap; source.day = 'override'; }
  }
  return { session: sessionCap, day: dayCap, run: credits == null ? null : credits, warn_at: budget.warn_at, source, warnings };
}

function sessionSpent(budget, id) {
  return budget.sessions[id] ? Number(budget.sessions[id].spent) || 0 : 0;
}

/** The `budget` object of the evidence ledger (§9.2) for a session under the given caps. */
export function budgetView(budget, { sessionId, identitySource, caps, runClass = null }) {
  const spent = sessionSpent(budget, sessionId);
  const day = budget.days[today()] ? Number(budget.days[today()].spent) || 0 : 0;
  const ses = budget.sessions[sessionId];
  return {
    unit: budget.unit, session_id: sessionId, identity_source: identitySource, run_class: runClass,
    max_per_session: caps.session, max_per_day: caps.day, warn_at: caps.warn_at, spent: round(spent), spent_today: round(day),
    remaining: round(Math.max(0, Math.min(caps.session - spent, caps.day - day))),
    ...(caps.run != null ? { run_limit: caps.run } : {}),
    ...(ses && isObj(ses.override) ? { override: ses.override } : {}),
    cap_sources: caps.source,
  };
}

/** Keep the newest `keep` sessions (by start) and `KEEP_DAYS` of day totals; `protect` survives. */
export function pruneBudget(budget, { keep = KEEP_SESSIONS, protect = null, now = new Date() } = {}) {
  const started = (s) => String(s.started || (s.probes.length ? s.probes[s.probes.length - 1].ts : '') || '');
  const ids = Object.keys(budget.sessions).sort((a, b) => (started(budget.sessions[b]) < started(budget.sessions[a]) ? -1 : started(budget.sessions[b]) > started(budget.sessions[a]) ? 1 : 0));
  const kept = new Set(ids.slice(0, keep));
  if (protect) kept.add(protect);
  const removed = ids.filter((id) => !kept.has(id));
  for (const id of removed) delete budget.sessions[id];
  const cutoff = new Date(now.getTime() - KEEP_DAYS * 86_400_000).toISOString().slice(0, 10);
  const removedDays = Object.keys(budget.days).filter((d) => d < cutoff);
  for (const d of removedDays) delete budget.days[d];
  for (const s of Object.values(budget.sessions)) if (s.probes.length > KEEP_PROBE_ENTRIES) s.probes = s.probes.slice(-KEEP_PROBE_ENTRIES);
  return { removed_sessions: removed, removed_days: removedDays, kept: Object.keys(budget.sessions).length };
}

/**
 * Load the ledger for a write, under the lock. A missing or unparsable ledger is recreated
 * from the template, except in headless runs when live spend is already recorded for today:
 * that is BUDGET_UNVERIFIED (exit 4), never a silent reset to the default caps.
 */
function loadForWrite(state, { interactive, notes, dryRun = false }) {
  const loaded = loadBudget(state);
  if (loaded.valid) return loaded.budget;
  if (!interactive && liveSpendRecorded(state)) {
    throw new AdcError(EXIT.UNVERIFIABLE, 'BUDGET_UNVERIFIED',
      `${loaded.path} is ${loaded.error} while metrics.jsonl or the evidence ledger already record live spend today; refusing to recreate it with the default caps (restore the file, or re-run from a terminal)`);
  }
  if (!dryRun) {
    if (loaded.exists) {
      const backup = `${loaded.path}.bad-${stamp()}`;
      try { fs.copyFileSync(loaded.path, backup); } catch {}
      notes.push(`budget.json was ${loaded.error}; kept a copy as ${path.basename(backup)} and recreated it with the shipped caps`);
    } else notes.push('budget.json was missing; recreated it from the shipped template (default caps)');
  } else notes.push(`budget.json is ${loaded.error}; a real run would recreate it with the shipped caps`);
  return loaded.budget;
}

function ensureSession(budget, id, { identitySource, runClass }) {
  if (!budget.sessions[id]) budget.sessions[id] = { started: nowIso(), spent: 0, identity_source: identitySource, run_class: runClass, probes: [] };
  return budget.sessions[id];
}

// ---------------------------------------------------------------------------
// Credentials (.adc/.env.live, §10.3.1)

const USERINFO_RE = /^[a-z][a-z0-9+.-]*:\/\/[^/?#@\s]*@/i;

/**
 * Credential values for a run: the environment wins over `.adc/.env.live`; CI and cloud-agent
 * runs use the environment only (§7.6). Every value found anywhere becomes a redaction literal.
 */
export function loadCredentials(state, { env = process.env, automation = false, fixPerms = true } = {}) {
  const p = state.paths || statePaths(state.dir);
  const out = { token: null, source: null, base_url: null, tenant: null, literals: [], file: { path: toPosix(p.envLive), exists: false }, error: null };
  const text = readText(p.envLive);
  let file = {};
  if (text != null) {
    out.file.exists = true;
    out.file.ignored = state.insideRepo ? stateIgnored(state, '.env.live') : true;
    if (fixPerms) setOwnerOnly(p.envLive);
    out.file.perms = checkOwnerOnly(p.envLive);
    if (!out.file.perms.ok) out.file.perms.warning = 'the file is readable by other users; the filesystem may not hold permissions (WSL DrvFs, FAT/exFAT): relocate the state dir with ADC_HOME';
    file = parseEnvFile(text);
  }
  const addLit = (v) => { if (v && !out.literals.some((l) => l.value === v)) out.literals.push({ name: 'ADC_LIVE_TOKEN', value: v }); };
  addLit(env.ADC_LIVE_TOKEN);
  addLit(file.ADC_LIVE_TOKEN);
  const fileUsable = out.file.exists && !automation && out.file.ignored !== false;
  if (env.ADC_LIVE_TOKEN) { out.token = env.ADC_LIVE_TOKEN; out.source = 'environment'; }
  else if (file.ADC_LIVE_TOKEN && fileUsable) { out.token = file.ADC_LIVE_TOKEN; out.source = `${state.rel || '.adc'}/.env.live`; }
  else if (file.ADC_LIVE_TOKEN && out.file.ignored === false) out.error = 'ENV_FILE_NOT_IGNORED';
  else if (file.ADC_LIVE_TOKEN && automation) out.error = 'ENV_FILE_IN_AUTOMATION';
  for (const key of ['ADC_LIVE_BASE_URL', 'ADC_LIVE_TENANT']) {
    const v = env[key] || (fileUsable ? file[key] : '') || '';
    const outKey = key === 'ADC_LIVE_BASE_URL' ? 'base_url' : 'tenant';
    if (v) out[outKey] = v;
  }
  for (const v of [env.ADC_LIVE_BASE_URL, file.ADC_LIVE_BASE_URL]) {
    if (v && USERINFO_RE.test(v)) {
      out.error = out.error || 'BASE_URL_USERINFO';
      out.literals.push({ name: 'ADC_LIVE_BASE_URL', value: v });
      const info = /^[a-z][a-z0-9+.-]*:\/\/([^/?#@\s]*)@/i.exec(v)[1];
      for (const part of [info, ...info.split(':')]) if (part && part.length >= 4) out.literals.push({ name: 'ADC_LIVE_BASE_URL', value: part });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Probe manifest (tests/live/probes.json) and the live safety checklist

/** Read and validate the probe manifest. Throws exit 3 when it is missing, exit 2 when it is invalid. */
export function loadManifest(root, manifest = DEFAULT_MANIFEST) {
  const file = path.resolve(root, manifest);
  const text = readText(file);
  if (text == null) throw envError('NO_PROBES', `${toPosix(manifest)} not found; scaffold a live project with \`scaffold live\` first`);
  let doc;
  try { doc = JSON.parse(text); } catch (err) { throw usageError(`${toPosix(manifest)} is not valid JSON: ${err.message}`); }
  if (!isObj(doc) || !Array.isArray(doc.probes)) throw usageError(`${toPosix(manifest)} must be {"schema": "${PROBES_SCHEMA}", "probes": [...]}`);
  if (doc.schema != null && doc.schema !== PROBES_SCHEMA) throw usageError(`${toPosix(manifest)}: unknown schema "${doc.schema}" (expected ${PROBES_SCHEMA})`);
  const errors = [];
  const probes = [];
  const seen = new Set();
  const dir = path.dirname(file);
  doc.probes.forEach((p, i) => {
    const where = `probes[${i}]`;
    if (!isObj(p)) { errors.push(`${where} is not an object`); return; }
    const id = String(p.id ?? '');
    if (!PROBE_ID_RE.test(id) || id.split('/').includes('..')) { errors.push(`${where}.id must match ${PROBE_ID_RE} (got "${truncate(id, 40)}")`); return; }
    if (seen.has(id)) { errors.push(`${where}.id "${id}" is not unique`); return; }
    seen.add(id);
    const kind = p.kind == null ? 'readonly' : String(p.kind);
    if (!['readonly', 'synthetic'].includes(kind)) errors.push(`${id}: kind must be readonly or synthetic`);
    if (typeof p.cmd !== 'string' || !p.cmd.trim()) errors.push(`${id}: cmd must be a non-empty command line`);
    let cost = p.cost;
    if (cost == null) {
      if (kind === 'synthetic') errors.push(`${id}: synthetic probes must declare an estimated cost`);
      cost = 1;
    }
    cost = Number(cost);
    if (!finiteNonNeg(cost)) errors.push(`${id}: cost must be a non-negative number`);
    const timeout = p.timeout_s == null ? DEFAULT_TIMEOUT_S : Number(p.timeout_s);
    if (!(timeout > 0 && timeout <= MAX_TIMEOUT_S)) errors.push(`${id}: timeout_s must be between 1 and ${MAX_TIMEOUT_S}`);
    const headerKind = p.cost_header_kind == null ? 'per_request' : String(p.cost_header_kind);
    if (!['per_request', 'cumulative'].includes(headerKind)) errors.push(`${id}: cost_header_kind must be per_request or cumulative`);
    if (p.cost_header != null && (typeof p.cost_header !== 'string' || !/^[A-Za-z0-9-]{1,100}$/.test(p.cost_header))) errors.push(`${id}: cost_header must be an HTTP header name`);
    // cwd is relative to the repository root; absent means the manifest's own folder.
    let cwd = dir;
    if (p.cwd != null) {
      if (typeof p.cwd !== 'string' || path.isAbsolute(p.cwd) || /^[A-Za-z]:/.test(p.cwd)) errors.push(`${id}: cwd must be relative to the repository root`);
      else cwd = path.resolve(root, p.cwd);
    }
    if (relPosix(root, cwd) == null) errors.push(`${id}: cwd must stay inside the repository`);
    probes.push({
      id, kind, cmd: typeof p.cmd === 'string' ? p.cmd : '', cwd, cwd_rel: relPosix(root, cwd) || '.', cost, timeout_s: timeout,
      cost_header: p.cost_header ? String(p.cost_header) : null, cost_header_kind: headerKind,
    });
  });
  if (errors.length) throw usageError(`${toPosix(manifest)} is invalid: ${errors.slice(0, 5).join('; ')}`, { errors });
  return { path: toPosix(file), rel: relPosix(root, file) || toPosix(manifest), dir, probes };
}

/** The live safety checklist gate for synthetic probes: present, and no line containing TODO. */
export function checklistStatus(dir) {
  const file = path.join(dir, CHECKLIST_NAME);
  const text = readText(file);
  if (text == null) return { path: toPosix(file), exists: false, open: null, ok: false, reason: 'CHECKLIST_MISSING' };
  const open = text.split(/\r?\n/).filter((l) => l.includes('TODO')).length;
  return { path: toPosix(file), exists: true, open, ok: open === 0, reason: open ? 'CHECKLIST_OPEN' : null };
}

// ---------------------------------------------------------------------------
// One probe

function headerValue(headers, name) {
  if (!isObj(headers) || !name) return null;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  if (key == null) return null;
  let v = headers[key];
  if (Array.isArray(v)) v = v[v.length - 1];
  if (v == null) return null;
  const n = Number(String(v).trim());
  return String(v).trim() !== '' && finiteNonNeg(n) ? n : null;
}

async function parseCounts(text) {
  try {
    const r = await import('./reports.mjs');
    const xml = /<testsuites?[\s>][\s\S]*<\/testsuites?>/.exec(text);
    if (xml && typeof r.parseReport === 'function') {
      const rep = r.parseReport('junit', xml[0]);
      if (rep && Number.isFinite(rep.executed)) return { source: 'junit', executed: rep.executed, passed: rep.passed, failed: rep.failed, errors: rep.errors, skipped: rep.skipped, flaky: rep.flaky };
    }
    if (typeof r.parseSummaryText === 'function') {
      const s = r.parseSummaryText(text);
      if (s) return { source: 'summary', ...s };
    }
  } catch {}
  return null;
}

async function runProbe(probe, { root, baseEnv, credentials, runId, sessionId, tmpDir, redact }) {
  const resultFile = path.join(tmpDir, `${slug(probe.id)}.json`);
  const env = { ...baseEnv, ADC_LIVE_TOKEN: credentials.token, ADC_TEST_RUN_ID: runId, ADC_PROBE_ID: probe.id, ADC_PROBE_RESULT: resultFile, ADC_SESSION_ID: sessionId };
  if (credentials.base_url) env.ADC_LIVE_BASE_URL = credentials.base_url;
  if (credentials.tenant) env.ADC_LIVE_TENANT = credentials.tenant;
  if (!fs.existsSync(probe.cwd)) {
    return { status: 'unverified', reason: 'BAD_CWD', exit_code: null, duration_ms: 0, output: `cwd does not exist: ${probe.cwd_rel}`, result: null };
  }
  const res = await spawnCapture(probe.cmd, [], { cwd: probe.cwd, env, shell: true, timeoutMs: probe.timeout_s * 1000 });
  let result = null;
  const rtext = readText(resultFile);
  if (rtext != null) { try { result = JSON.parse(rtext); } catch { result = { _unparsable: true }; } }
  try { fs.rmSync(resultFile, { force: true }); } catch {}
  const output = redact([res.stdout, res.stderr && `--- stderr ---\n${res.stderr}`].filter(Boolean).join('\n'));
  let status;
  let reason = null;
  const http = isObj(result) ? Number(result.http_status ?? result.status) : NaN;
  const httpStatus = Number.isInteger(http) && http >= 100 && http <= 599 ? http : null;
  if (res.timedOut) { status = 'fail'; reason = 'TIMEOUT'; }
  else if (res.error && res.exit == null) { status = 'unverified'; reason = 'SPAWN_FAILED'; }
  else if (res.exit === 0) status = 'pass';
  else if (res.exit === 127 || res.exit === 9009) { status = 'unverified'; reason = 'RUNNER_MISSING'; }
  else { status = 'fail'; reason = httpStatus === 401 || httpStatus === 403 ? 'AUTH_REJECTED' : 'PROBE_FAILED'; }
  return { status, reason, exit_code: res.exit, signal: res.signal, duration_ms: res.ms, output, truncated: res.truncated, result, http_status: httpStatus };
}

// ---------------------------------------------------------------------------
// Evidence

async function recordEvidence({ ctx, root, ledgerOpt, checks, session }) {
  const ev = await import('./evidence.mjs');
  if (typeof ev.addChecks !== 'function' || typeof ev.initLedger !== 'function') throw new Error('evidence.mjs is not available in this build');
  const target = await prepareTarget({ ...ctx, cwd: root });
  let file = ledgerOpt ? path.resolve(ctx.cwd, ledgerOpt) : null;
  let created = false;
  if (!file && typeof ev.listLedgers === 'function') {
    for (const f of ev.listLedgers(target.state).slice(0, 10)) {
      const doc = readJson(f, null);
      if (doc && !doc.finalized_at && doc.tree_digest === target.snapshot.tree) { file = f; break; }
    }
  }
  if (!file) {
    const init = await ev.initLedger({ target, sessionId: { id: session.id, source: session.source }, mode: 'live' });
    file = init.path;
    created = true;
  }
  await ev.addChecks(file, checks, { source: 'script', root: target.root });
  return { path: relPosix(target.root, file) || toPosix(file), created, tree_digest: target.snapshot.tree };
}

// ---------------------------------------------------------------------------
// The run

function parseCredits(v, name, { positiveInt = false } = {}) {
  if (v == null) return null;
  const n = Number(String(v).trim());
  if (String(v).trim() === '' || !Number.isFinite(n) || n < 0 || (positiveInt && (!Number.isInteger(n) || n <= 0))) {
    throw usageError(`--${name} must be a ${positiveInt ? 'positive integer' : 'non-negative number'}`);
  }
  return n;
}

function resolveSessionId(state, explicit) {
  if (explicit) {
    if (!SESSION_ID_RE.test(String(explicit))) throw usageError(`--session must match ${SESSION_ID_RE}`);
    return { id: String(explicit), source: 'flag' };
  }
  const open = newestOpenSession(state.dir);
  if (open && open.id) return { id: String(open.id), source: 'session-file' };
  return { id: `run-${stamp()}-${nonce().slice(0, 6)}`, source: 'generated' };
}

function liveCheck(fields) {
  return {
    id: 'CK-LIVE', fm: LIVE_FM, project: '.', status: 'unverified', reason: null, cost: 0, command: null, cwd: null,
    exit_code: null, duration_ms: null, summary: '', output_sha256: null, artifacts: [], findings: [], data: {}, ...fields,
  };
}

function pruneRunLogs(dir) {
  try {
    const runs = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory())
      .map((e) => ({ p: path.join(dir, e.name), t: fs.statSync(path.join(dir, e.name)).mtimeMs })).sort((a, b) => b.t - a.t);
    for (const r of runs.slice(KEEP_RUN_LOGS)) fs.rmSync(r.p, { recursive: true, force: true });
  } catch {}
}

/**
 * Run the probes of a live project under the budget ledger. Returns the `live run` result:
 * `{ session_id, identity_source, run_id, run_class, probes[], spent, run_spent, remaining,
 *    stopped_reason, budget, checks[], warnings[], ledger }` plus `exit`.
 */
export async function liveRun({
  ctx, state, root, manifest = DEFAULT_MANIFEST, probes = null, sessionId = null, credits = null,
  creditsOverride = null, dryRun = false, ledger = null, noLedger = false, env = process.env,
  runClass = 'agent', interactive = false, automation = false, notify = null,
}) {
  const warnings = [];
  const notes = [];
  const say = (msg) => { warnings.push(msg); if (notify) notify(msg); };
  if (creditsOverride != null && !interactive) throw usageError('--credits-override raises the cap and is accepted only from an interactive terminal: run this from a terminal');
  const paths = state.paths || statePaths(state.dir);
  const man = loadManifest(root, manifest);
  const globs = probes ? String(probes).split(',').map((s) => s.trim()).filter(Boolean) : null;
  const selected = globs ? man.probes.filter((p) => globs.some((g) => p.id === g || matchGlob(p.id, g))) : man.probes;
  if (!selected.length) throw usageError(globs ? `--probes ${probes} matches no probe in ${man.rel}` : `${man.rel} lists no probes`);

  const session = resolveSessionId(state, sessionId);
  const runId = `live-${stamp()}-${nonce().slice(0, 6)}`;
  const creds = loadCredentials(state, { env, automation, fixPerms: !dryRun });
  if (creds.error === 'BASE_URL_USERINFO') throw usageError('ADC_LIVE_BASE_URL must not carry credentials (user:password@host); put the token in ADC_LIVE_TOKEN');
  const redact = await makeRedactor(creds.literals);
  if (creds.file.perms && !creds.file.perms.ok) say(`.env.live permissions are not owner-only (${creds.file.perms.mode || creds.file.perms.detail}); ${creds.file.perms.warning}`);
  const checklist = checklistStatus(man.dir);
  const killSwitch = env.LIVE_TESTS_ENABLED != null && env.LIVE_TESTS_ENABLED !== 'true';

  const caps0 = (b) => effectiveCaps(b, { runClass, session: b.sessions[session.id], env, credits });
  const rows = [];
  const checks = [];
  let stopped = null;
  let stopDetail = null;
  let runSpent = 0;
  let view = null;
  const base = {
    session_id: session.id, identity_source: session.source, run_id: runId, run_class: runClass, dry_run: dryRun,
    manifest: man.rel, credential: { name: 'ADC_LIVE_TOKEN', set: Boolean(creds.token), source: creds.source },
    env_file_perms: creds.file.exists ? creds.file.perms : null, checklist,
  };

  // Pre-flight under the lock: validate (or recreate) the ledger, register the session, persist
  // an accepted override. Nothing is written in a dry run or when nothing can run.
  const persist = !dryRun && !killSwitch && Boolean(creds.token) && creds.token.length >= 4;
  const preflight = () => {
    const b = loadForWrite(state, { interactive, notes, dryRun: !persist });
    const ses = ensureSession(b, session.id, { identitySource: session.source, runClass });
    if (creditsOverride != null) {
      ses.override = { max: creditsOverride, ts: nowIso(), by: 'tty' };
      notes.push(`override accepted from the terminal: session cap ${creditsOverride} ${b.unit}`);
    }
    pruneBudget(b, { protect: session.id });
    if (persist) writeJsonAtomic(paths.budget, redactValue(b, redact));
    return b;
  };
  let budget;
  try {
    budget = persist ? await withLock(paths.budgetLock, preflight, { waitMs: 15_000 }) : preflight();
  } catch (err) {
    if (!(err instanceof AdcError) || err.code !== 'BUDGET_UNVERIFIED') throw err;
    stopped = 'BUDGET_UNVERIFIED';
    stopDetail = err.message;
    budget = loadBudget(state).budget;
  }
  const capsStart = caps0(budget);
  for (const w of capsStart.warnings) say(w);
  view = budgetView(budget, { sessionId: session.id, identitySource: session.source, caps: capsStart, runClass });
  if (!stopped && Math.max(view.spent, view.spent_today) >= capsStart.warn_at) say(`live spend is at or above warn_at (${capsStart.warn_at} ${budget.unit}): session ${view.spent}, today ${view.spent_today}`);

  if (!stopped && killSwitch) { stopped = 'KILL_SWITCH'; stopDetail = `LIVE_TESTS_ENABLED=${truncate(String(env.LIVE_TESTS_ENABLED), 20)} stops live runs (set it to true to allow them)`; }
  if (!stopped && !creds.token) {
    stopped = 'TOKEN_UNSET';
    stopDetail = creds.error === 'ENV_FILE_NOT_IGNORED' ? `${state.rel || '.adc'}/.env.live is not ignored by git, so it was not read; fix the ignore rules (or relocate with ADC_HOME) and re-run`
      : creds.error === 'ENV_FILE_IN_AUTOMATION' ? 'CI and cloud-agent runs read ADC_LIVE_TOKEN from the environment only (an environment-scoped secret), never from .env.live'
        : 'UNVERIFIED: ADC_LIVE_TOKEN unset (set it in .adc/.env.live, or in the environment for CI); probes never run unauthenticated';
  }
  if (!stopped && creds.token.length < 4) { stopped = 'TOKEN_UNSET'; stopDetail = 'ADC_LIVE_TOKEN is too short to be redacted reliably; refusing to run'; }

  let tmpDir = null;
  const logDir = path.join(paths.cache, 'live', runId);
  const baseEnv = { ...env };
  for (const k of ['ADC_LIVE_TOKEN', 'ADC_LIVE_BASE_URL', 'ADC_LIVE_TENANT']) delete baseEnv[k];
  const sigint = () => onInterrupt();
  if (!dryRun && !stopped) { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adc-live-')); process.once('SIGINT', sigint); process.once('SIGTERM', sigint); }

  try {
    for (const probe of selected) {
      const row = { id: probe.id, kind: probe.kind, status: 'skipped', reason: null, cost: 0, cost_source: null, estimate: probe.cost, duration_ms: null, exit_code: null };
      rows.push(row);
      if (stopped) { row.reason = stopped; row.status = 'not-run'; continue; }
      if (probe.kind === 'synthetic' && !checklist.ok) {
        row.reason = 'SYNTHETIC_GATED';
        checks.push(liveCheck({ project: probe.id, status: 'skipped', reason: 'SYNTHETIC_GATED', command: redact(probe.cmd), cwd: probe.cwd_rel, summary: `${probe.id}: synthetic probe not run (${checklist.exists ? `${checklist.open} TODO line(s) in ${CHECKLIST_NAME}` : `${CHECKLIST_NAME} missing`})`, data: { kind: probe.kind, estimate: probe.cost } }));
        continue;
      }
      // Reserve the estimate under the lock so concurrent runs cannot both pass the check.
      const reserve = () => {
        const b = loadForWrite(state, { interactive, notes, dryRun });
        const ses = ensureSession(b, session.id, { identitySource: session.source, runClass });
        const caps = effectiveCaps(b, { runClass, session: ses, env, credits });
        const d = today();
        const day = b.days[d] || { spent: 0 };
        // A dry run writes nothing, so the probes it would already have run are added here.
        const pending = dryRun ? runSpent : 0;
        const sesSpent = ses.spent + pending;
        const daySpent = day.spent + pending;
        const over = sesSpent + probe.cost > caps.session ? 'session' : daySpent + probe.cost > caps.day ? 'day'
          : caps.run != null && runSpent + probe.cost > caps.run ? 'run' : null;
        if (over) return { ok: false, over, caps, ses: sesSpent, day: daySpent };
        if (!dryRun) {
          ses.probes.push({ id: probe.id, run_id: runId, ts: nowIso(), day: d, estimate: probe.cost, cost: probe.cost, status: 'running', kind: probe.kind });
          ses.spent = round(ses.spent + probe.cost);
          b.days[d] = { ...day, spent: round(day.spent + probe.cost) };
          pruneBudget(b, { protect: session.id });
          writeJsonAtomic(paths.budget, redactValue(b, redact));
        }
        return { ok: true, caps };
      };
      let r;
      try {
        r = dryRun ? reserve() : await withLock(paths.budgetLock, reserve, { waitMs: 15_000 });
      } catch (err) {
        if (!(err instanceof AdcError) || err.code !== 'BUDGET_UNVERIFIED') throw err;
        stopped = 'BUDGET_UNVERIFIED'; stopDetail = err.message; row.status = 'not-run'; row.reason = stopped;
        continue;
      }
      if (!r.ok) {
        const capVal = r.over === 'session' ? r.caps.session : r.over === 'day' ? r.caps.day : r.caps.run;
        const spentVal = r.over === 'session' ? r.ses : r.over === 'day' ? r.day : runSpent;
        stopped = 'BUDGET_EXHAUSTED';
        stopDetail = `stopped before ${probe.id}: ${r.over === 'run' ? 'this run' : r.over} spent ${round(spentVal)} + estimate ${probe.cost} > ${r.over === 'run' ? '--credits' : `max_per_${r.over}`} ${capVal} ${budget.unit}`;
        row.status = 'not-run'; row.reason = stopped;
        continue;
      }
      if (dryRun) { row.status = 'would-run'; row.cost = probe.cost; row.cost_source = 'estimate'; runSpent += probe.cost; continue; }

      const res = await runProbe(probe, { root, baseEnv, credentials: creds, runId, sessionId: session.id, tmpDir, redact });
      const hv = isObj(res.result) && probe.cost_header ? headerValue(res.result.headers, probe.cost_header) : null;
      const reported = isObj(res.result) && finiteNonNeg(Number(res.result.cost)) && res.result.cost !== null && res.result.cost !== '' ? Number(res.result.cost) : null;
      // Settle the reservation: a finite, non-negative header (or reported) cost replaces the estimate.
      const settle = () => {
        // Spend already happened, so it is always recorded; a ledger that vanished meanwhile is
        // recreated here and the run stops below (headless) instead of trusting the fresh file.
        const before = notes.length;
        const b = loadForWrite(state, { interactive: true, notes, dryRun: false });
        const recreated = notes.length > before;
        const ses = ensureSession(b, session.id, { identitySource: session.source, runClass });
        let cost = probe.cost;
        let source = 'estimate';
        if (hv != null && probe.cost_header_kind === 'per_request') { cost = hv; source = 'header'; }
        else if (hv != null) {
          const key = probe.cost_header.toLowerCase();
          const prev = isObj(b.cumulative[key]) ? Number(b.cumulative[key].value) : NaN;
          if (Number.isFinite(prev) && hv >= prev) { cost = round(hv - prev); source = 'header'; }
          b.cumulative[key] = { value: hv, ts: nowIso() };
        } else if (reported != null) { cost = reported; source = 'reported'; }
        let entry = null;
        for (let i = ses.probes.length - 1; i >= 0; i--) {
          const e = ses.probes[i];
          if (e.run_id === runId && e.id === probe.id && e.status === 'running') { entry = e; break; }
        }
        const delta = entry ? cost - Number(entry.cost || 0) : cost;
        const d = entry && entry.day ? entry.day : today();
        if (entry) Object.assign(entry, { cost, cost_source: source, status: res.status, ...(res.reason ? { reason: res.reason } : {}), duration_ms: res.duration_ms });
        else ses.probes.push({ id: probe.id, run_id: runId, ts: nowIso(), day: d, estimate: probe.cost, cost, cost_source: source, status: res.status, kind: probe.kind });
        ses.spent = round(Math.max(0, ses.spent + delta));
        const day = b.days[d] || { spent: 0 };
        b.days[d] = { ...day, spent: round(Math.max(0, day.spent + delta)) };
        writeJsonAtomic(paths.budget, redactValue(b, redact));
        return { cost, source, b, recreated };
      };
      const s = await withLock(paths.budgetLock, settle, { waitMs: 30_000 });
      runSpent = round(runSpent + s.cost);
      ensureDir(logDir);
      const logFile = path.join(logDir, `${slug(probe.id)}.log`);
      writeFileAtomic(logFile, res.output ? `${res.output}\n` : '');
      const logRef = relPosix(root, logFile) || toPosix(logFile);
      const counts = res.output ? await parseCounts(res.output) : null;
      Object.assign(row, {
        status: res.status, reason: res.reason, cost: s.cost, cost_source: s.source, duration_ms: res.duration_ms, exit_code: res.exit_code,
        ...(res.http_status ? { http_status: res.http_status } : {}), log: logRef,
        ...(res.status !== 'pass' && res.output ? { tail: truncate(res.output.split('\n').slice(-15).join('\n'), 2000) } : {}),
      });
      checks.push(liveCheck({
        project: probe.id, status: res.status, reason: res.reason, cost: s.cost, command: redact(probe.cmd), cwd: probe.cwd_rel,
        exit_code: res.exit_code, duration_ms: res.duration_ms, output_sha256: sha256(res.output || ''), artifacts: [logRef],
        summary: `${probe.id} ${res.status}${res.reason ? ` (${res.reason})` : ''} in ${(res.duration_ms / 1000).toFixed(1)} s; cost ${s.cost} ${budget.unit} (${s.source})${res.http_status ? `; HTTP ${res.http_status}` : ''}`,
        data: { kind: probe.kind, estimate: probe.cost, cost_source: s.source, http_status: res.http_status, counts, run_id: runId, truncated: res.truncated || undefined },
      }));
      try { appendMetrics(state.dir, redactValue({ kind: 'live-probe', run_id: runId, session_id: session.id, probe: probe.id, status: res.status, cost: s.cost, cost_source: s.source, duration_ms: res.duration_ms }, redact)); } catch {}
      const caps = caps0(s.b);
      const after = budgetView(s.b, { sessionId: session.id, identitySource: session.source, caps, runClass });
      const prevSes = after.spent - s.cost;
      const prevDay = after.spent_today - s.cost;
      if ((prevSes < caps.warn_at && after.spent >= caps.warn_at) || (prevDay < caps.warn_at && after.spent_today >= caps.warn_at)) {
        say(`warn_at crossed: session ${after.spent}, today ${after.spent_today} of ${caps.session}/${caps.day} ${budget.unit}`);
      }
      if (s.recreated && !interactive) {
        stopped = 'BUDGET_UNVERIFIED';
        stopDetail = 'budget.json disappeared or became unparsable during the run; it was recreated with this probe\'s spend only, so the remaining probes are not run';
      }
    }
  } finally {
    if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.removeListener('SIGINT', sigint); process.removeListener('SIGTERM', sigint); }
  }
  if (!dryRun) pruneRunLogs(path.join(paths.cache, 'live'));

  const finalBudget = loadBudget(state).budget;
  const capsEnd = caps0(finalBudget);
  view = budgetView(finalBudget, { sessionId: session.id, identitySource: session.source, caps: capsEnd, runClass });
  const ran = rows.filter((r) => ['pass', 'fail', 'unverified'].includes(r.status));
  const notRun = rows.filter((r) => r.status === 'not-run').map((r) => r.id);
  if (stopped) {
    const status = stopped === 'KILL_SWITCH' ? 'skipped' : 'unverified';
    checks.unshift(liveCheck({
      status, reason: stopped, cost: runSpent, summary: stopped === 'TOKEN_UNSET' && /^UNVERIFIED/.test(stopDetail) ? stopDetail : `${stopped}: ${stopDetail}`,
      data: { not_run: notRun, budget: view, run_id: runId, probes: rows.map((r) => ({ id: r.id, status: r.status, cost: r.cost })), env_file_perms: base.env_file_perms },
    }));
  } else {
    const worst = ran.some((r) => r.status === 'fail') ? 'fail' : ran.some((r) => r.status === 'unverified') ? 'unverified' : ran.length ? 'pass' : 'skipped';
    checks.unshift(liveCheck({
      status: worst, cost: runSpent, reason: ran.length ? null : 'NO_PROBE_RAN',
      summary: `${ran.length} live probe(s) ran: ${ran.filter((r) => r.status === 'pass').length} pass, ${ran.filter((r) => r.status === 'fail').length} fail, ${ran.filter((r) => r.status === 'unverified').length} unverified; spent ${runSpent} ${finalBudget.unit} (session ${view.spent}/${view.max_per_session}, today ${view.spent_today}/${view.max_per_day})`,
      data: { budget: view, run_id: runId, probes: rows.map((r) => ({ id: r.id, status: r.status, cost: r.cost })), env_file_perms: base.env_file_perms },
    }));
  }
  for (const n of notes) say(n);

  const result = {
    ...base, probes: rows, spent: view.spent, run_spent: round(runSpent), spent_today: view.spent_today, remaining: view.remaining,
    stopped_reason: stopped, ...(stopDetail ? { stopped_detail: stopDetail } : {}), budget: view, checks, warnings, ledger: null,
  };
  if (!dryRun) {
    try {
      appendMetrics(state.dir, redactValue({ kind: 'live-run', run_id: runId, session_id: session.id, identity_source: session.source, run_class: runClass, run_spent: round(runSpent), session_spent: view.spent, day_spent: view.spent_today, remaining: view.remaining, stopped_reason: stopped, probes: ran.length, ...(view.override ? { override: view.override } : {}) }, redact));
    } catch {}
    if (!noLedger && state.root) {
      try { result.ledger = await recordEvidence({ ctx: ctx || {}, root, ledgerOpt: ledger, checks: redactValue(checks, redact), session }); }
      catch (err) { result.ledger_error = redact(truncate(String(err && err.message ? err.message : err), 300)); }
    }
  }
  const statuses = checks.map((c) => c.status);
  result.exit = statuses.includes('fail') ? EXIT.FINDINGS : statuses.includes('unverified') ? EXIT.UNVERIFIABLE : EXIT.OK;
  return redactValue(result, redact);
}

// ---------------------------------------------------------------------------
// Commands

const RUN_USAGE = [
  'live run [--manifest tests/live/probes.json] [--probes <glob,...>] [--session <id>] [--credits <n>]',
  '         [--credits-override <n>] [--ledger <file> | --no-ledger] [--dry-run] [--json]',
  'Runs the live probes under the budget ledger (.adc/budget.json): ADC_LIVE_TOKEN from the environment,',
  'else .adc/.env.live; spend checked before every probe; stops at BUDGET_EXHAUSTED. --credits lowers the',
  'limit for this run; --credits-override raises the session cap and works only from a real terminal.',
  'Exit: 0 all ran and passed, 1 a probe failed, 4 not verified (token unset, budget exhausted, runner missing).',
].join('\n');

function humanRun(r) {
  const lines = [`live run ${r.run_id} (session ${r.session_id}, ${r.identity_source}; ${r.run_class})${r.dry_run ? ' [dry run]' : ''}`];
  for (const p of r.probes) lines.push(`  ${p.status.padEnd(9)} ${p.id}${p.reason ? ` [${p.reason}]` : ''}  cost ${p.cost}${p.cost_source ? ` (${p.cost_source})` : ''}${p.duration_ms != null ? `  ${(p.duration_ms / 1000).toFixed(1)} s` : ''}`);
  lines.push(`spent ${r.run_spent} this run; session ${r.spent}/${r.budget.max_per_session}, today ${r.spent_today}/${r.budget.max_per_day}; remaining ${r.remaining} ${r.budget.unit}`);
  if (r.stopped_reason) lines.push(`stopped: ${r.stopped_reason}${r.stopped_detail ? ` - ${r.stopped_detail}` : ''}`);
  for (const w of r.warnings) lines.push(`warning: ${w}`);
  if (r.ledger) lines.push(`evidence: ${r.ledger.path}${r.ledger.created ? ' (new ledger)' : ''}`);
  if (r.ledger_error) lines.push(`evidence not recorded: ${r.ledger_error}`);
  return lines.join('\n');
}

export const liveRunCommand = defineCommand({
  name: 'live run',
  usage: RUN_USAGE,
  positionals: false,
  options: {
    manifest: { type: 'string' }, probes: { type: 'string' }, session: { type: 'string' }, credits: { type: 'string' },
    'credits-override': { type: 'string' }, ledger: { type: 'string' }, 'no-ledger': { type: 'boolean' },
  },
  run: async (ctx, values) => {
    if (values['credits-override'] != null && !ctx.interactiveTty) {
      throw usageError('--credits-override raises the cap and is accepted only from an interactive terminal: run this from a terminal');
    }
    const credits = parseCredits(values.credits, 'credits');
    const creditsOverride = parseCredits(values['credits-override'], 'credits-override', { positiveInt: true });
    const state = prepareStateDir(ctx, { create: !ctx.dryRun });
    const root = state.root || ctx.cwd;
    const r = await liveRun({
      ctx, state, root, manifest: values.manifest || DEFAULT_MANIFEST, probes: values.probes || null, sessionId: values.session || null,
      credits, creditsOverride, dryRun: ctx.dryRun, ledger: values.ledger || null, noLedger: Boolean(values['no-ledger']),
      runClass: ctx.runClass, interactive: ctx.interactiveTty, automation: ctx.automation,
      notify: (m) => process.stderr.write(`live run: ${m}\n`),
    });
    const { exit, ...result } = r;
    const n = (s) => result.probes.filter((p) => p.status === s).length;
    return {
      result, exit, human: humanRun(result),
      summary: `${result.probes.length} probe(s): ${n('pass')} pass, ${n('fail')} fail${n('not-run') ? `, ${n('not-run')} not run` : ''}; spent ${result.run_spent} (remaining ${result.remaining})${result.stopped_reason ? `; ${result.stopped_reason}` : ''}`,
    };
  },
});

export const liveCommand = defineGroup({ name: 'live', usage: `live run [options]\n\n${RUN_USAGE}`, subcommands: { run: liveRunCommand } });

function sessionRows(budget) {
  return Object.entries(budget.sessions).map(([id, s]) => ({
    id, started: s.started || null, spent: round(Number(s.spent) || 0), probes: s.probes.length, identity_source: s.identity_source || null,
    run_class: s.run_class || null, last: s.probes.length ? s.probes[s.probes.length - 1].ts || null : null,
    ...(isObj(s.override) ? { override: s.override } : {}), ...(Array.isArray(s.resets) && s.resets.length ? { resets: s.resets.length } : {}),
  })).sort((a, b) => (String(b.started) < String(a.started) ? -1 : String(b.started) > String(a.started) ? 1 : 0));
}

export const budgetShowCommand = defineCommand({
  name: 'budget show',
  usage: 'budget show [--session <id>] [--json]  (caps, today\'s spend and remainder, recent sessions)',
  positionals: false,
  options: { session: { type: 'string' } },
  run: async (ctx, values) => {
    const state = prepareStateDir(ctx, { create: false });
    const loaded = loadBudget(state);
    const b = loaded.budget;
    const d = today();
    const spentToday = b.days[d] ? round(b.days[d].spent) : 0;
    const result = {
      path: relPosix(state.root || ctx.cwd, loaded.path) || loaded.path, exists: loaded.exists, valid: loaded.valid, ...(loaded.error && loaded.exists ? { error: loaded.error } : {}),
      unit: b.unit, max_per_session: b.max_per_session, max_per_day: b.max_per_day, warn_at: b.warn_at,
      defaults: { ...DEFAULT_BUDGET }, defaults_exceeded: loaded.defaults_exceeded,
      today: { date: d, spent: spentToday, remaining: round(Math.max(0, b.max_per_day - spentToday)) },
      sessions: sessionRows(b),
    };
    if (values.session) {
      const s = b.sessions[values.session];
      if (!s) throw usageError(`no session "${values.session}" in ${result.path}`);
      result.session = { id: values.session, ...s, remaining: round(Math.max(0, Math.min(b.max_per_session - s.spent, b.max_per_day - spentToday))) };
    }
    const human = [`budget ${result.path}${loaded.exists ? '' : ' (not created yet; shipped defaults shown)'}`,
      `caps: ${b.max_per_session} per session, ${b.max_per_day} per day, warn at ${b.warn_at} ${b.unit}${loaded.defaults_exceeded ? ' (raised above the shipped defaults)' : ''}`,
      `today ${d}: spent ${spentToday}, remaining ${result.today.remaining}`,
      ...result.sessions.slice(0, 10).map((s) => `  ${s.id}: ${s.spent} spent, ${s.probes} probe(s)${s.override ? `, override ${s.override.max}` : ''}`)].join('\n');
    return { result, exit: EXIT.OK, human, summary: `today ${spentToday}/${b.max_per_day} ${b.unit}; ${result.sessions.length} session(s)` };
  },
});

export const budgetResetCommand = defineCommand({
  name: 'budget reset',
  usage: 'budget reset --session <id>  (interactive terminals only; zeroes that session\'s spend, keeps the daily total)',
  positionals: false,
  options: { session: { type: 'string' } },
  run: async (ctx, values) => {
    if (!ctx.interactiveTty) throw usageError('budget reset is accepted only from an interactive terminal: run this from a terminal');
    if (!values.session) throw usageError('budget reset needs --session <id>');
    const state = prepareStateDir(ctx, { create: !ctx.dryRun });
    const paths = state.paths;
    const body = () => {
      const loaded = loadBudget(state);
      if (!loaded.valid) throw envError('BUDGET_INVALID', `${loaded.path} is ${loaded.error}`);
      const s = loaded.budget.sessions[values.session];
      if (!s) throw usageError(`no session "${values.session}" in ${loaded.path}`);
      const previous = s.spent;
      s.resets = [...(Array.isArray(s.resets) ? s.resets : []), { ts: nowIso(), by: 'tty', previous_spent: previous }];
      s.spent = 0;
      if (!ctx.dryRun) writeJsonAtomic(paths.budget, loaded.budget);
      return { session: values.session, previous_spent: previous, spent: 0, dry_run: ctx.dryRun };
    };
    const result = ctx.dryRun ? body() : await withLock(paths.budgetLock, body, { waitMs: 15_000 });
    return { result, exit: EXIT.OK, summary: `${ctx.dryRun ? 'would reset' : 'reset'} session ${values.session} (was ${result.previous_spent}); the daily total is unchanged` };
  },
});

export const budgetPruneCommand = defineCommand({
  name: 'budget prune',
  usage: `budget prune [--dry-run]  (keep the newest ${KEEP_SESSIONS} sessions and ${KEEP_DAYS} days of totals)`,
  positionals: false,
  run: async (ctx) => {
    const state = prepareStateDir(ctx, { create: false });
    const body = () => {
      const loaded = loadBudget(state);
      if (!loaded.exists) return { removed_sessions: [], removed_days: [], kept: 0, dry_run: ctx.dryRun };
      if (!loaded.valid) throw envError('BUDGET_INVALID', `${loaded.path} is ${loaded.error}`);
      const res = pruneBudget(loaded.budget);
      if (!ctx.dryRun && (res.removed_sessions.length || res.removed_days.length)) writeJsonAtomic(state.paths.budget, loaded.budget);
      return { ...res, dry_run: ctx.dryRun };
    };
    const result = ctx.dryRun || !fs.existsSync(state.paths.budget) ? body() : await withLock(state.paths.budgetLock, body, { waitMs: 15_000 });
    return { result, exit: EXIT.OK, summary: `${ctx.dryRun ? 'would remove' : 'removed'} ${result.removed_sessions.length} session(s) and ${result.removed_days.length} day total(s); ${result.kept} kept` };
  },
});

export const budgetCommand = defineGroup({
  name: 'budget',
  usage: 'budget <show|reset|prune>\n  show [--session <id>]\n  reset --session <id>   (interactive terminals only)\n  prune                  (keep the newest 50 sessions)',
  subcommands: { show: budgetShowCommand, reset: budgetResetCommand, prune: budgetPruneCommand },
  defaultSub: 'show',
});
