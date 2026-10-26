// Live probes under the budget ledger (§10.3): the trusted runner. It loads ADC_LIVE_TOKEN
// (environment, then .adc/.env.live), resolves the session identity, checks spend against the
// session and daily caps before every probe (reserving under budget.json.lock), runs each probe
// with piped stdio, replaces every loaded secret value before anything is kept or printed, and
// records cost and outcome in budget.json, metrics.jsonl and the evidence ledger.

import fs from 'node:fs';
import path from 'node:path';
import {
  EXIT, usageError, envError, defineCommand, defineGroup, readText, readJson, readJsonFile, writeFileAtomic,
  writeJsonAtomic, withLock, matchGlob, sha256, nowIso, stamp, today, toPosix, relPosix, displayPath, truncate, isObj,
  toArray, parseJsonl, numberOption, makeCheck, spawnCapture, onInterrupt, makeTempDir, isAbsolutePath, listDir,
  statOrNull, cmp, runId as newRunId,
} from './core.mjs';
import {
  DEFAULT_BUDGET, statePaths, prepareStateDir, parseEnvFile, setOwnerOnly, checkOwnerOnly, stateIgnored,
  newestOpenSession, resolveSession, appendMetrics, prepareTarget, sanitizeId, listLedgers, ledgerFiles,
} from './state.mjs';
import { makeRedactor, redactDeep } from './markers.mjs';
import { initLedger, addChecks } from './evidence.mjs';

const BUDGET_SCHEMA = 'adc-budget/1';
const PROBES_SCHEMA = 'adc-probes/1';
const DEFAULT_MANIFEST = 'tests/live/probes.json';
const CHECKLIST = 'live-checklist.md';
export const CI_BUDGET_CEILING = 10_000;
const KEEP = { sessions: 50, days: 90, probes: 200, runLogs: 20 };
const MAX_TIMEOUT_S = 3600;
const PROBE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
const LOCK = { waitMs: 30_000 };
const TTY_ONLY = 'is accepted only from an interactive terminal: run this from a terminal';

const nonNeg = (v) => v != null && v !== '' && Number.isFinite(Number(v)) && Number(v) >= 0;
const round = (n) => Math.round(n * 1000) / 1000;
const desc = (x, y) => cmp(y, x);
const liveCheck = (fields) => makeCheck({ id: 'CK-LIVE', fm: ['FM-02'], ...fields });

// ---------------------------------------------------------------------------
// The budget ledger (.adc/budget.json, §10.3.2)

/** Validate and fill a parsed budget ledger: `{ ok, error, notes, budget }`; `budget` is always complete. */
export function normalizeBudget(raw) {
  const fresh = { schema: BUDGET_SCHEMA, unit: 'credits', ...DEFAULT_BUDGET, days: {}, sessions: {}, cumulative: {} };
  const foreign = isObj(raw) && raw.schema != null && raw.schema !== BUDGET_SCHEMA;
  if (!isObj(raw) || foreign) {
    return { ok: false, error: foreign ? `unknown schema "${truncate(String(raw.schema), 40)}"` : 'not a JSON object',
      notes: [], budget: fresh };
  }
  const notes = [];
  const cap = (k) => {
    if (raw[k] == null || nonNeg(raw[k])) return raw[k] == null ? DEFAULT_BUDGET[k] : Number(raw[k]);
    notes.push(`${k} is not a non-negative number; using ${DEFAULT_BUDGET[k]}`);
    return DEFAULT_BUDGET[k];
  };
  const spent = (v) => (isObj(v) && nonNeg(v.spent) ? Number(v.spent) : 0);
  const entries = (v) => Object.entries(isObj(v) ? v : {});
  const budget = {
    ...raw, schema: BUDGET_SCHEMA, unit: typeof raw.unit === 'string' && raw.unit ? raw.unit : 'credits',
    max_per_session: cap('max_per_session'), max_per_day: cap('max_per_day'), warn_at: cap('warn_at'),
    days: Object.fromEntries(entries(raw.days).filter(([d]) => /^\d{4}-\d{2}-\d{2}$/.test(d))
      .map(([d, v]) => [d, { ...(isObj(v) ? v : {}), spent: spent(v) }])),
    sessions: Object.fromEntries(entries(raw.sessions).filter(([, v]) => isObj(v))
      .map(([id, v]) => [id, { ...v, spent: spent(v), probes: toArray(v.probes).filter(isObj) }])),
    cumulative: isObj(raw.cumulative) ? raw.cumulative : {},
  };
  return { ok: true, error: null, notes, budget };
}

/** Read `.adc/budget.json` without writing: `{ path, exists, valid, error, notes, budget, defaults_exceeded }`. */
export function loadBudget(stateInfo) {
  const file = statePaths(stateInfo.dir).budget;
  const r = readJsonFile(file);
  const error = !r.exists ? 'missing' : r.error ? `unparsable: ${truncate(r.error, 120)}` : null;
  const { ok, error: shapeError, notes, budget: b } = normalizeBudget(r.value ?? null);
  const valid = !error && ok;
  const raised = b.max_per_session > DEFAULT_BUDGET.max_per_session || b.max_per_day > DEFAULT_BUDGET.max_per_day;
  return {
    path: toPosix(file), exists: r.exists, valid, error: error || shapeError, notes, budget: b,
    defaults_exceeded: valid && raised,
  };
}

/** Does metrics.jsonl or .adc/evidence/ already record live spend for `day` (UTC)? */
export function liveSpendRecorded(stateInfo, day = today()) {
  const p = statePaths(stateInfo.dir);
  const spent = (r) => String(r.ts || '').startsWith(day)
    && ((r.kind === 'live-probe' && Number(r.cost) > 0) || (r.kind === 'live-run' && Number(r.run_spent) > 0));
  if (parseJsonl(readText(p.metrics, '')).some(spent)) return true;
  // Only ledgers written that day can hold its spend, so the others are never parsed.
  return ledgerFiles(stateInfo.dir).some(({ file }) => {
    const st = statOrNull(file);
    return st != null && today(st.mtime) === day
      && toArray(readJson(file, null)?.checks).some((c) => c?.id === 'CK-LIVE' && Number(c.cost) > 0);
  });
}

/**
 * Caps for one run (§10.3.1/§10.3.2): `agent` runs keep the shipped caps hard (a budget.json
 * raised above them is ignored, because the agent can write that file); `ci` runs may set the
 * session cap with ADC_LIVE_BUDGET (≤ 10,000, also lifting that day's cap); `interactive` runs
 * honor a `--credits-override` persisted on the session. `credits` limits this run's own spend.
 */
export function effectiveCaps(budget, { runClass = 'agent', session = null, env = process.env, credits = null } = {}) {
  const warnings = [];
  const caps = { session: budget.max_per_session, day: budget.max_per_day };
  const source = { session: 'budget.json', day: 'budget.json' };
  const raise = (n, src) => {
    [caps.session, source.session] = [n, src];
    if (n > caps.day) [caps.day, source.day] = [n, src];
  };
  const ciBudget = String(env.ADC_LIVE_BUDGET ?? '').trim();
  if (runClass === 'agent') {
    for (const k of ['session', 'day']) {
      const def = DEFAULT_BUDGET[`max_per_${k}`];
      if (caps[k] <= def) continue;
      warnings.push(`budget.json raises max_per_${k} to ${caps[k]}; agent runs keep the shipped cap of ${def}`);
      [caps[k], source[k]] = [def, 'default'];
    }
  } else if (runClass === 'ci' && ciBudget) {
    const n = Number(ciBudget);
    if (!nonNeg(n)) warnings.push('ADC_LIVE_BUDGET is not a non-negative number; ignored');
    else {
      if (n > CI_BUDGET_CEILING) warnings.push(`ADC_LIVE_BUDGET ${n} exceeds the ceiling; using ${CI_BUDGET_CEILING}`);
      raise(Math.floor(Math.min(n, CI_BUDGET_CEILING)), 'ADC_LIVE_BUDGET');
    }
  } else if (runClass === 'interactive' && isObj(session?.override) && nonNeg(session.override.max)) {
    raise(Number(session.override.max), 'override');
  }
  return { ...caps, run: credits ?? null, warn_at: budget.warn_at, source, warnings };
}

/** The `budget` object of the evidence ledger (§9.2) for a session under the given caps. */
export function budgetView(budget, { sessionId, identitySource, caps, runClass = null }) {
  const ses = budget.sessions[sessionId];
  const spent = ses ? ses.spent : 0;
  const day = budget.days[today()]?.spent || 0;
  return {
    unit: budget.unit, session_id: sessionId, identity_source: identitySource, run_class: runClass,
    max_per_session: caps.session, max_per_day: caps.day, warn_at: caps.warn_at, spent: round(spent),
    spent_today: round(day), remaining: round(Math.max(0, Math.min(caps.session - spent, caps.day - day))),
    ...(caps.run != null ? { run_limit: caps.run } : {}), ...(isObj(ses?.override) ? { override: ses.override } : {}),
    cap_sources: caps.source,
  };
}

/** Keep the newest `keep` sessions (by start) and 90 days of day totals; `protect` survives. */
export function pruneBudget(budget, { keep = KEEP.sessions, protect = null, now = new Date() } = {}) {
  const started = (id) => String(budget.sessions[id].started || budget.sessions[id].probes.at(-1)?.ts || '');
  const ids = Object.keys(budget.sessions).sort((a, b) => desc(started(a), started(b)));
  const removed = ids.filter((id, i) => i >= keep && id !== protect);
  const cutoff = today(new Date(now.getTime() - KEEP.days * 86_400_000));
  const removedDays = Object.keys(budget.days).filter((d) => d < cutoff);
  for (const id of removed) delete budget.sessions[id];
  for (const d of removedDays) delete budget.days[d];
  for (const s of Object.values(budget.sessions)) s.probes = s.probes.slice(-KEEP.probes);
  return { removed_sessions: removed, removed_days: removedDays, kept: Object.keys(budget.sessions).length };
}

/**
 * loadBudget for a write (the caller holds the lock). A missing or unparsable ledger is
 * recreated from the shipped caps, except in headless runs when live spend is already recorded
 * for today: that is BUDGET_UNVERIFIED (exit 4), never a silent reset to the default caps.
 */
function loadForWrite(state, { interactive, say, dryRun }) {
  const loaded = loadBudget(state);
  loaded.notes.forEach(say);
  if (loaded.valid) return loaded;
  if (!interactive && liveSpendRecorded(state)) {
    throw envError('BUDGET_UNVERIFIED', `${loaded.path} is ${loaded.error} while metrics.jsonl or the evidence ledger `
      + 'already record live spend today; refusing to recreate it with the default caps (restore the file, or re-run '
      + 'from a terminal)');
  }
  if (dryRun) say(`budget.json is ${loaded.error}; a real run would recreate it with the shipped caps`);
  else if (!loaded.exists) say('budget.json was missing; recreated it from the shipped template (default caps)');
  else {
    const backup = `${loaded.path}.bad-${stamp()}`;
    try { fs.copyFileSync(loaded.path, backup); } catch {}
    say(`budget.json was ${loaded.error}; kept a copy as ${path.basename(backup)}, recreated with the shipped caps`);
  }
  return loaded;
}

// ---------------------------------------------------------------------------
// Credentials (.adc/.env.live, §10.3.1), the probe manifest and the safety checklist

/**
 * Credential values for a run: the environment wins over `.adc/.env.live`; CI and cloud-agent
 * runs use the environment only (§7.6). Every value found anywhere becomes a redaction literal.
 */
export function loadCredentials(state, { env = process.env, automation = false, fixPerms = true } = {}) {
  const p = statePaths(state.dir);
  const out = { token: null, source: null, literals: [], error: null, file: { path: toPosix(p.envLive) } };
  const text = readText(p.envLive);
  const file = text == null ? {} : parseEnvFile(text);
  out.file.exists = text != null;
  if (out.file.exists) {
    if (fixPerms) setOwnerOnly(p.envLive);
    const perms = checkOwnerOnly(p.envLive);
    if (!perms.ok) perms.warning = 'the filesystem may not hold permissions (WSL DrvFs, FAT/exFAT): use ADC_HOME';
    Object.assign(out.file, { ignored: state.insideRepo ? stateIgnored(state, '.env.live') : true, perms });
  }
  const literal = (name, v) => v && !out.literals.some((l) => l.value === v) && out.literals.push({ name, value: v });
  // The trimmed form too: a CI secret often ends in a newline that the probe strips before printing.
  const tokens = [env.ADC_LIVE_TOKEN, file.ADC_LIVE_TOKEN];
  for (const v of [...tokens, ...tokens.map((t) => t?.trim())]) literal('ADC_LIVE_TOKEN', v);
  const usable = out.file.exists && !automation && out.file.ignored !== false;
  const fileSource = `${state.rel || '.adc'}/.env.live`;
  if (env.ADC_LIVE_TOKEN) [out.token, out.source] = [env.ADC_LIVE_TOKEN, 'environment'];
  else if (file.ADC_LIVE_TOKEN && usable) [out.token, out.source] = [file.ADC_LIVE_TOKEN, fileSource];
  else if (file.ADC_LIVE_TOKEN) out.error = `ENV_FILE_${out.file.ignored === false ? 'NOT_IGNORED' : 'IN_AUTOMATION'}`;
  out.base_url = env.ADC_LIVE_BASE_URL || (usable && file.ADC_LIVE_BASE_URL) || null;
  out.tenant = env.ADC_LIVE_TENANT || (usable && file.ADC_LIVE_TENANT) || null;
  for (const v of [env.ADC_LIVE_BASE_URL, file.ADC_LIVE_BASE_URL]) {
    const m = v && /^[a-z][a-z0-9+.-]*:\/\/([^/?#@\s]*)@/i.exec(v);
    if (!m) continue;
    out.error ||= 'BASE_URL_USERINFO';
    for (const part of [v, m[1], ...m[1].split(':')]) if (part.length >= 4) literal('ADC_LIVE_BASE_URL', part);
  }
  return out;
}

/** Read and validate the probe manifest. Throws exit 3 when it is missing, exit 2 when it is invalid. */
export function loadManifest(root, manifest = DEFAULT_MANIFEST) {
  const file = path.resolve(root, manifest);
  const rel = relPosix(root, file) || toPosix(manifest);
  const { exists, value: doc, error } = readJsonFile(file);
  if (!exists) throw envError('NO_PROBES', `${rel} not found; create it with \`scaffold live\` first`);
  if (error) throw usageError(`${rel} is not valid JSON: ${error}`);
  if (!isObj(doc) || !Array.isArray(doc.probes) || (doc.schema != null && doc.schema !== PROBES_SCHEMA)) {
    throw usageError(`${rel} must be {"schema": "${PROBES_SCHEMA}", "probes": [...]}`);
  }
  const errors = [];
  const seen = new Set();
  const dir = path.dirname(file);
  const probes = doc.probes.map((p, i) => {
    const id = String(p?.id ?? '');
    const where = `probes[${i}] (${truncate(id, 40)})`;
    const bad = !isObj(p) ? 'is not an object' : seen.has(id) ? 'id is not unique'
      : !PROBE_ID_RE.test(id) || id.split('/').includes('..') ? `id must match ${PROBE_ID_RE}` : null;
    if (bad) return errors.push(`${where}: ${bad}`) && null;
    seen.add(id);
    const kind = String(p.kind ?? 'readonly');
    const cost = p.cost ?? (kind === 'synthetic' ? null : 1);
    const timeout = Number(p.timeout_s ?? 120);
    const headerKind = String(p.cost_header_kind ?? 'per_request');
    // cwd is relative to the repository root; absent means the manifest's own folder.
    const cwd = p.cwd == null ? dir : typeof p.cwd === 'string' && !isAbsolutePath(p.cwd) ? path.resolve(root, p.cwd)
      : null;
    const cwdRel = cwd && relPosix(root, cwd);
    const rules = [
      [['readonly', 'synthetic'].includes(kind), 'kind must be readonly or synthetic'],
      [typeof p.cmd === 'string' && p.cmd.trim(), 'cmd must be a non-empty command line'],
      [cost != null, 'synthetic probes must declare an estimated cost'],
      [cost == null || nonNeg(cost), 'cost must be a non-negative number'],
      [timeout > 0 && timeout <= MAX_TIMEOUT_S, `timeout_s must be between 1 and ${MAX_TIMEOUT_S}`],
      [['per_request', 'cumulative'].includes(headerKind), 'cost_header_kind must be per_request or cumulative'],
      [p.cost_header == null || /^[A-Za-z0-9-]{1,100}$/.test(p.cost_header), 'cost_header must be an HTTP header name'],
      [cwdRel != null, 'cwd must be a relative path inside the repository'],
    ];
    for (const [ok, msg] of rules) if (!ok) errors.push(`${where}: ${msg}`);
    return { id, kind, cmd: String(p.cmd ?? ''), cwd, cwd_rel: cwdRel, cost: Number(cost),
      timeout_s: timeout, cost_header: p.cost_header ? String(p.cost_header) : null, cost_header_kind: headerKind };
  });
  if (errors.length) throw usageError(`${rel} is invalid: ${errors.slice(0, 5).join('; ')}`, { errors });
  return { path: toPosix(file), rel, dir, probes };
}

/**
 * The live safety checklist gate for synthetic probes (the runner and `scaffold live`): the file
 * exists and no line contains TODO. Pass `text` when the caller has already read the file.
 * Returns `{ path, exists, open, open_items, ok, reason }`; `open_items` are the first 20 TODO lines.
 */
export function checklistStatus(file, text = readText(file)) {
  if (text == null) {
    return { path: toPosix(file), exists: false, open: null, open_items: [], ok: false, reason: 'CHECKLIST_MISSING' };
  }
  const open = text.split(/\r?\n/).filter((l) => l.includes('TODO'));
  const items = open.slice(0, 20).map((l) => truncate(l.trim(), 120));
  const reason = open.length ? 'CHECKLIST_OPEN' : null;
  return { path: toPosix(file), exists: true, open: open.length, open_items: items, ok: !reason, reason };
}

// ---------------------------------------------------------------------------
// One probe, the evidence ledger, session identity

function headerCost(headers, name) {
  const key = isObj(headers) && Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  const v = String((key ? [headers[key]].flat().at(-1) : null) ?? '').trim();
  return nonNeg(v) ? Number(v) : null;
}

async function runProbe(probe, { baseEnv, creds, runId, sessionId, tmpDir, redact }) {
  const resultFile = path.join(tmpDir, `${sanitizeId(probe.id)}.json`);
  const env = {
    ...baseEnv, ADC_LIVE_TOKEN: creds.token, ADC_TEST_RUN_ID: runId, ADC_PROBE_ID: probe.id, ADC_SESSION_ID: sessionId,
    ADC_PROBE_RESULT: resultFile, ...(creds.base_url ? { ADC_LIVE_BASE_URL: creds.base_url } : {}),
    ...(creds.tenant ? { ADC_LIVE_TENANT: creds.tenant } : {}),
  };
  const timeoutMs = probe.timeout_s * 1000;
  const res = await spawnCapture(probe.cmd, [], { cwd: probe.cwd, env, shell: true, timeoutMs });
  const result = readJson(resultFile, null);
  try { fs.rmSync(resultFile, { force: true }); } catch {}
  const http = Number(result?.http_status ?? result?.status);
  const httpStatus = Number.isInteger(http) && http >= 100 && http <= 599 ? http : null;
  const [status, reason] = res.timedOut ? ['fail', 'TIMEOUT']
    : res.exit == null && res.error ? ['unverified', 'SPAWN_FAILED'] : res.exit === 0 ? ['pass', null]
      : [127, 9009].includes(res.exit) ? ['unverified', 'RUNNER_MISSING']
        : ['fail', [401, 403].includes(httpStatus) ? 'AUTH_REJECTED' : 'PROBE_FAILED'];
  const output = redact([res.stdout, res.stderr && `--- stderr ---\n${res.stderr}`,
    res.error && `--- could not start the probe in ${probe.cwd_rel}: ${res.error}`].filter(Boolean).join('\n'));
  return { status, reason, exit_code: res.exit, duration_ms: res.ms, output, truncated: res.truncated, result,
    httpStatus };
}

async function recordEvidence({ ctx, root, ledgerOpt, checks, session }) {
  const target = await prepareTarget({ ...ctx, cwd: root });
  // Append to the newest unfinalized ledger of the same snapshot, else start one.
  let file = ledgerOpt ? path.resolve(ctx.cwd || root, ledgerOpt) : listLedgers(target.state.dir, { max: 10 })
    .find((r) => !r.finalized && readJson(r.file, null)?.tree_digest === target.snapshot.tree)?.file;
  const created = !file;
  if (created) file = (await initLedger({ target, sessionId: session, mode: 'live' })).path;
  await addChecks(file, checks, { source: 'script', root: target.root });
  return { path: displayPath(target.root, file), created, tree_digest: target.snapshot.tree };
}

const TOKEN_HELP = {
  ENV_FILE_NOT_IGNORED: (rel) => `${rel}/.env.live is not ignored by git, so it was not read; fix the ignore rules`,
  ENV_FILE_IN_AUTOMATION: () => 'CI and cloud-agent runs read ADC_LIVE_TOKEN from the environment only, not .env.live',
  unset: () => 'UNVERIFIED: ADC_LIVE_TOKEN unset (set it in .adc/.env.live, or in the environment for CI); probes '
    + 'never run unauthenticated',
};

// ---------------------------------------------------------------------------
// The run

/**
 * Run the probes of a live project under the budget ledger. Returns the `live run` result:
 * `{ session_id, identity_source, run_id, run_class, probes[], spent, run_spent, remaining,
 *    stopped_reason, budget, checks[], warnings[], ledger }` plus `exit`.
 */
export async function liveRun({
  ctx = {}, state, root, manifest = DEFAULT_MANIFEST, probes = null, sessionId = null, credits = null,
  creditsOverride = null, dryRun = false, ledger = null, noLedger = false, env = process.env,
  runClass = 'agent', interactive = false, automation = false, notify = null,
}) {
  if (creditsOverride != null && !interactive) throw usageError(`--credits-override raises the cap and ${TTY_ONLY}`);
  const paths = statePaths(state.dir);
  const man = loadManifest(root, manifest);
  const globs = probes ? String(probes).split(',').map((s) => s.trim()).filter(Boolean) : null;
  const selected = globs ? man.probes.filter((p) => globs.some((g) => p.id === g || matchGlob(p.id, g))) : man.probes;
  if (!selected.length) throw usageError(`${globs ? `--probes ${probes} matches no probe` : 'no probe'} in ${man.rel}`);
  const session = resolveSession(state.dir, sessionId);
  const runId = newRunId('live');
  const creds = loadCredentials(state, { env, automation, fixPerms: !dryRun });
  if (creds.error === 'BASE_URL_USERINFO') {
    throw usageError('ADC_LIVE_BASE_URL must not carry credentials (user:password@host); use ADC_LIVE_TOKEN');
  }
  const redact = makeRedactor({ literals: creds.literals, env });
  const scrub = (v) => redactDeep(v, redact, { keys: true });
  const warnings = [];
  const say = (msg) => { if (!warnings.includes(msg)) { warnings.push(msg); notify?.(redact(msg)); } };
  const perms = creds.file.perms;
  if (perms && !perms.ok) say(`.env.live is not owner-only (${perms.mode || perms.detail}); ${perms.warning}`);
  const checklist = checklistStatus(path.join(man.dir, CHECKLIST));
  const capsFor = (b) => effectiveCaps(b, { runClass, session: b.sessions[session.id], env, credits });
  const viewOf = (b) => budgetView(b, { sessionId: session.id, identitySource: session.source, caps: capsFor(b),
    runClass });
  const ensure = (b) => (b.sessions[session.id] ||= {
    started: nowIso(), spent: 0, identity_source: session.source, run_class: runClass, probes: [],
  });
  const save = (b) => { pruneBudget(b, { protect: session.id }); writeJsonAtomic(paths.budget, scrub(b)); };
  const locked = (fn) => (dryRun ? fn() : withLock(paths.budgetLock, fn, LOCK));
  let stopped = null;
  let stopDetail = null;
  const stop = (reason, detail) => { if (!stopped) [stopped, stopDetail] = [reason, detail]; };
  if (env.LIVE_TESTS_ENABLED != null && env.LIVE_TESTS_ENABLED !== 'true') {
    stop('KILL_SWITCH', `LIVE_TESTS_ENABLED=${truncate(String(env.LIVE_TESTS_ENABLED), 20)} stops live runs (set it to `
      + 'true to allow them)');
  } else if (!creds.token) stop('TOKEN_UNSET', (TOKEN_HELP[creds.error] || TOKEN_HELP.unset)(state.rel || '.adc'));
  else if (creds.token.length < 4) stop('TOKEN_UNSET', 'ADC_LIVE_TOKEN is too short to be redacted reliably');
  const budget = loadBudget(state).budget;
  capsFor(budget).warnings.forEach(say);

  let runSpent = 0;
  // Reserve the estimate under the lock (re-reading the ledger) so concurrent runs cannot both
  // pass the check; the first reservation also validates or recreates the ledger and persists
  // an accepted override. A dry run writes nothing and adds the probes it would already have run.
  const reserve = (probe) => {
    const b = loadForWrite(state, { interactive, say, dryRun }).budget;
    const ses = ensure(b);
    if (creditsOverride != null && ses.override?.max !== creditsOverride) {
      ses.override = { max: creditsOverride, ts: nowIso(), by: 'tty' };
      say(`override accepted from the terminal: session cap ${creditsOverride} ${b.unit}`);
    }
    const caps = capsFor(b);
    const d = today();
    const pending = dryRun ? runSpent : 0;
    const spent = { session: ses.spent + pending, day: (b.days[d]?.spent || 0) + pending, run: runSpent };
    const cap = { session: caps.session, day: caps.day, run: caps.run ?? Infinity };
    const over = ['session', 'day', 'run'].find((k) => spent[k] + probe.cost > cap[k]);
    if (!over && !dryRun) {
      ses.probes.push({ id: probe.id, run_id: runId, ts: nowIso(), day: d, estimate: probe.cost, cost: probe.cost,
        status: 'running', kind: probe.kind });
      ses.spent = round(ses.spent + probe.cost);
      b.days[d] = { ...b.days[d], spent: round((b.days[d]?.spent || 0) + probe.cost) };
    }
    if (!dryRun) save(b);
    return over ? { over, spent: round(spent[over]), cap: cap[over] } : {};
  };
  // Settle the reservation: a finite, non-negative header (or reported) cost replaces the estimate.
  // Spend already happened, so it is always recorded; a ledger that vanished meanwhile is
  // recreated here and the run stops afterwards (headless) instead of trusting the fresh file.
  const settle = (probe, res) => {
    const loaded = loadForWrite(state, { interactive: true, say, dryRun: false });
    const b = loaded.budget;
    const ses = ensure(b);
    const hv = probe.cost_header ? headerCost(res.result?.headers, probe.cost_header) : null;
    let [cost, source] = [probe.cost, 'estimate'];
    if (hv != null && probe.cost_header_kind === 'per_request') [cost, source] = [hv, 'header'];
    else if (hv != null) {
      const key = probe.cost_header.toLowerCase();
      const prev = Number(b.cumulative[key]?.value);
      if (Number.isFinite(prev) && hv >= prev) [cost, source] = [round(hv - prev), 'header'];
      b.cumulative[key] = { value: hv, ts: nowIso() };
    } else if (nonNeg(res.result?.cost)) [cost, source] = [Number(res.result.cost), 'reported'];
    const entry = ses.probes.findLast((e) => e.run_id === runId && e.id === probe.id && e.status === 'running');
    const delta = cost - (entry ? Number(entry.cost) || 0 : 0);
    const d = entry?.day || today();
    const fields = { cost, cost_source: source, status: res.status, ...(res.reason ? { reason: res.reason } : {}),
      duration_ms: res.duration_ms };
    if (entry) Object.assign(entry, fields);
    else ses.probes.push({ id: probe.id, run_id: runId, ts: nowIso(), day: d, estimate: probe.cost, ...fields });
    ses.spent = round(Math.max(0, ses.spent + delta));
    b.days[d] = { ...b.days[d], spent: round(Math.max(0, (b.days[d]?.spent || 0) + delta)) };
    save(b);
    return { cost, source, b, recreated: !loaded.valid };
  };

  const rows = [];
  const checks = [];
  const logDir = path.join(paths.cache, 'live', runId);
  const baseEnv = { ...env };
  for (const k of ['ADC_LIVE_TOKEN', 'ADC_LIVE_BASE_URL', 'ADC_LIVE_TENANT']) delete baseEnv[k];
  const tmpDir = !dryRun && !stopped ? makeTempDir('live') : null;
  const unhook = tmpDir ? onInterrupt(() => fs.rmSync(tmpDir, { recursive: true, force: true })) : null;
  try {
    for (const probe of selected) {
      const row = { id: probe.id, kind: probe.kind, status: 'not-run', reason: stopped, cost: 0, cost_source: null,
        estimate: probe.cost, duration_ms: null, exit_code: null };
      rows.push(row);
      if (stopped) continue;
      const base = { project: probe.id, command: redact(probe.cmd), cwd: probe.cwd_rel };
      if (probe.kind === 'synthetic' && !checklist.ok) {
        Object.assign(row, { status: 'skipped', reason: 'SYNTHETIC_GATED' });
        const why = checklist.exists ? `${checklist.open} TODO line(s) in ${CHECKLIST}` : `${CHECKLIST} missing`;
        checks.push(liveCheck({ ...base, status: 'skipped', reason: 'SYNTHETIC_GATED', data: { kind: probe.kind,
          estimate: probe.cost }, summary: `${probe.id}: synthetic probe not run (${why})` }));
        continue;
      }
      let r = {};
      try { r = await locked(() => reserve(probe)); } catch (err) {
        if (err?.code !== 'BUDGET_UNVERIFIED') throw err;
        stop(err.code, err.message);
      }
      if (r.over) {
        const [who, cap] = r.over === 'run' ? ['this run', '--credits'] : [r.over, `max_per_${r.over}`];
        stop('BUDGET_EXHAUSTED', `stopped before ${probe.id}: ${who} spent ${r.spent} + estimate ${probe.cost} > `
          + `${cap} ${r.cap} ${budget.unit}`);
      }
      if (stopped) { row.reason = stopped; continue; }
      if (dryRun) {
        Object.assign(row, { status: 'would-run', cost: probe.cost, cost_source: 'estimate' });
        runSpent += probe.cost;
        continue;
      }
      const res = await runProbe(probe, { baseEnv, creds, runId, sessionId: session.id, tmpDir, redact });
      const s = await locked(() => settle(probe, res));
      runSpent = round(runSpent + s.cost);
      const logFile = path.join(logDir, `${sanitizeId(probe.id)}.log`);
      writeFileAtomic(logFile, res.output ? `${res.output}\n` : '');
      const log = displayPath(root, logFile);
      const outcome = { status: res.status, reason: res.reason, cost: s.cost, duration_ms: res.duration_ms,
        exit_code: res.exit_code };
      const tail = res.status !== 'pass' && res.output && truncate(res.output.split('\n').slice(-15).join('\n'), 2000);
      Object.assign(row, outcome, { cost_source: s.source }, res.httpStatus ? { http_status: res.httpStatus } : {},
        { log }, tail ? { tail } : {});
      checks.push(liveCheck({
        ...base, ...outcome, output_sha256: sha256(res.output || ''), artifacts: [log],
        summary: `${probe.id} ${res.status}${res.reason ? ` (${res.reason})` : ''} in ${res.duration_ms} ms; cost `
          + `${s.cost} ${budget.unit} (${s.source})${res.httpStatus ? `; HTTP ${res.httpStatus}` : ''}`,
        data: { kind: probe.kind, estimate: probe.cost, cost_source: s.source, http_status: res.httpStatus,
          run_id: runId, truncated: res.truncated || undefined },
      }));
      try {
        appendMetrics(state.dir, scrub({ kind: 'live-probe', run_id: runId, session_id: session.id, probe: probe.id,
          status: res.status, cost: s.cost, cost_source: s.source, duration_ms: res.duration_ms }));
      } catch {}
      const after = viewOf(s.b);
      if (Math.max(after.spent, after.spent_today) >= after.warn_at) {
        say(`warn_at crossed: live spend is at or above ${after.warn_at} ${budget.unit}`);
      }
      if (s.recreated && !interactive) {
        stop('BUDGET_UNVERIFIED', 'budget.json disappeared or became unparsable during the run; it was recreated with '
          + 'this probe\'s spend only, so the remaining probes are not run');
      }
    }
  } finally {
    if (tmpDir) { fs.rmSync(tmpDir, { recursive: true, force: true }); unhook(); }
  }
  if (!dryRun) {
    const logs = path.dirname(logDir);
    const runs = listDir(logs).filter((d) => d.startsWith('live-')).sort(desc);
    for (const d of runs.slice(KEEP.runLogs)) fs.rmSync(path.join(logs, d), { recursive: true, force: true });
  }

  const view = viewOf(loadBudget(state).budget);
  const n = (status) => rows.filter((r) => r.status === status).length;
  const ran = n('pass') + n('fail') + n('unverified');
  const envFilePerms = creds.file.exists ? perms : null;
  checks.unshift(liveCheck({
    status: stopped ? (stopped === 'KILL_SWITCH' ? 'skipped' : 'unverified')
      : n('fail') ? 'fail' : n('unverified') ? 'unverified' : ran ? 'pass' : 'skipped',
    reason: stopped || (ran ? null : 'NO_PROBE_RAN'), cost: runSpent,
    summary: stopped ? (/^UNVERIFIED/.test(stopDetail) ? stopDetail : `${stopped}: ${stopDetail}`)
      : `${ran} live probe(s) ran: ${n('pass')} pass, ${n('fail')} fail, ${n('unverified')} unverified; spent `
        + `${runSpent} ${view.unit} (session ${view.spent}/${view.max_per_session}, today ${view.spent_today}/`
        + `${view.max_per_day})`,
    data: { ...(stopped ? { not_run: rows.filter((r) => r.status === 'not-run').map((r) => r.id) } : {}), budget: view,
      run_id: runId, probes: rows.map(({ id, status, cost }) => ({ id, status, cost })), env_file_perms: envFilePerms },
  }));
  const result = {
    session_id: session.id, identity_source: session.source, run_id: runId, run_class: runClass, dry_run: dryRun,
    manifest: man.rel, credential: { name: 'ADC_LIVE_TOKEN', set: Boolean(creds.token), source: creds.source },
    env_file_perms: envFilePerms, checklist, probes: rows, spent: view.spent, run_spent: round(runSpent),
    spent_today: view.spent_today, remaining: view.remaining, stopped_reason: stopped,
    ...(stopDetail ? { stopped_detail: stopDetail } : {}), budget: view, checks, warnings, ledger: null,
  };
  if (!dryRun) {
    try {
      appendMetrics(state.dir, scrub({ kind: 'live-run', run_id: runId, session_id: session.id, run_class: runClass,
        identity_source: session.source, run_spent: round(runSpent), session_spent: view.spent, probes: ran,
        day_spent: view.spent_today, remaining: view.remaining, stopped_reason: stopped,
        ...(view.override ? { override: view.override } : {}) }));
    } catch {}
    if (!noLedger && state.root) {
      try { result.ledger = await recordEvidence({ ctx, root, ledgerOpt: ledger, checks: scrub(checks), session }); }
      catch (err) { result.ledger_error = redact(truncate(String(err?.message ?? err), 300)); }
    }
  }
  const has = (status) => checks.some((c) => c.status === status);
  result.exit = has('fail') ? EXIT.FINDINGS : has('unverified') ? EXIT.UNVERIFIABLE : EXIT.OK;
  return scrub(result);
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
  const b = r.budget;
  const probeLine = (p) => `  ${p.status.padEnd(9)} ${p.id}${p.reason ? ` [${p.reason}]` : ''}  cost ${p.cost}`
    + `${p.cost_source ? ` (${p.cost_source})` : ''}${p.duration_ms != null ? `  ${p.duration_ms} ms` : ''}`;
  return [
    `live run ${r.run_id} (session ${r.session_id}, ${r.identity_source}; ${r.run_class})${r.dry_run ? ', dry' : ''}`,
    ...r.probes.map(probeLine),
    `spent ${r.run_spent} this run; session ${r.spent}/${b.max_per_session}, today ${r.spent_today}/${b.max_per_day}; `
      + `remaining ${r.remaining} ${b.unit}`,
    ...(r.stopped_reason ? [`stopped: ${r.stopped_reason}${r.stopped_detail ? ` - ${r.stopped_detail}` : ''}`] : []),
    ...r.warnings.map((w) => `warning: ${w}`),
    ...(r.ledger ? [`evidence: ${r.ledger.path}${r.ledger.created ? ' (new ledger)' : ''}`] : []),
    ...(r.ledger_error ? [`evidence not recorded: ${r.ledger_error}`] : []),
  ].join('\n');
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
    const credits = numberOption(values, 'credits', null, { allowZero: true });
    const creditsOverride = numberOption(values, 'credits-override', null, { integer: true });
    const state = prepareStateDir(ctx, { create: !ctx.dryRun });
    const { exit, ...result } = await liveRun({
      ctx, state, root: state.root || ctx.cwd, manifest: values.manifest || DEFAULT_MANIFEST, probes: values.probes,
      sessionId: values.session, credits, creditsOverride, dryRun: ctx.dryRun, ledger: values.ledger,
      noLedger: Boolean(values['no-ledger']), runClass: ctx.runClass, interactive: ctx.interactiveTty,
      automation: ctx.automation, notify: (m) => process.stderr.write(`live run: ${m}\n`),
    });
    const n = (s) => result.probes.filter((p) => p.status === s).length;
    const notRun = n('not-run') ? `, ${n('not-run')} not run` : '';
    const stop = result.stopped_reason ? `; ${result.stopped_reason}` : '';
    const summary = `${result.probes.length} probe(s): ${n('pass')} pass, ${n('fail')} fail${notRun}; spent `
      + `${result.run_spent} (remaining ${result.remaining})${stop}`;
    return { result, exit, human: humanRun(result), summary };
  },
});

export const liveCommand = defineGroup({
  name: 'live', usage: `live run [options]\n\n${RUN_USAGE}`, subcommands: { run: liveRunCommand },
});

const budgetShow = defineCommand({
  name: 'budget show',
  usage: 'budget show [--session <id>] [--json]  (caps, today\'s spend and remainder, recent sessions)',
  positionals: false,
  options: { session: { type: 'string' } },
  run: async (ctx, values) => {
    const state = prepareStateDir(ctx, { create: false });
    const loaded = loadBudget(state);
    const b = loaded.budget;
    const rel = displayPath(state.root || ctx.cwd, loaded.path);
    const ses = values.session ? b.sessions[values.session] : null;
    if (values.session && !ses) throw usageError(`no session "${values.session}" in ${rel}`);
    // Remainders under the caps this caller's run class gets (agent runs ignore raised caps).
    const caps = effectiveCaps(b, { runClass: ctx.runClass, session: ses });
    const d = today();
    const spentToday = round(b.days[d]?.spent || 0);
    const sessions = Object.entries(b.sessions).map(([id, s]) => ({
      id, started: s.started || null, spent: round(s.spent), probes: s.probes.length, run_class: s.run_class,
      identity_source: s.identity_source, ...(isObj(s.override) ? { override: s.override } : {}),
    })).sort((x, y) => desc(String(x.started), String(y.started)));
    const result = {
      path: rel, exists: loaded.exists, valid: loaded.valid, ...(loaded.exists ? { error: loaded.error } : {}),
      unit: b.unit, max_per_session: b.max_per_session, max_per_day: b.max_per_day, warn_at: b.warn_at,
      defaults_exceeded: loaded.defaults_exceeded,
      effective: { run_class: ctx.runClass, max_per_session: caps.session, max_per_day: caps.day },
      today: { date: d, spent: spentToday, remaining: round(Math.max(0, caps.day - spentToday)) }, sessions,
      ...(ses ? { session: { id: values.session, ...ses,
        remaining: round(Math.max(0, Math.min(caps.session - ses.spent, caps.day - spentToday))) } } : {}),
    };
    const human = [`budget ${rel}${loaded.exists ? '' : ' (not created yet; shipped defaults shown)'}`,
      `caps: ${b.max_per_session} per session, ${b.max_per_day} per day, warn at ${b.warn_at} ${b.unit}`
        + `${loaded.defaults_exceeded ? ' (raised above the shipped defaults)' : ''}`,
      `today ${d}: spent ${spentToday}, remaining ${result.today.remaining} (${ctx.runClass} caps)`,
      ...sessions.slice(0, 10).map((s) => `  ${s.id}: ${s.spent} spent, ${s.probes} probe(s)`
        + `${s.override ? `, override ${s.override.max}` : ''}`)].join('\n');
    const summary = `today ${spentToday}/${caps.day} ${b.unit}; ${sessions.length} session(s)`;
    return { result, exit: EXIT.OK, human, summary };
  },
});

/** `budget reset` / `budget prune`: rewrite the ledger under its lock with `mutate` (`--dry-run` writes nothing). */
async function budgetWrite(ctx, mutate) {
  const state = prepareStateDir(ctx, { create: false });
  const p = statePaths(state.dir);
  const body = () => {
    const loaded = loadBudget(state);
    if (loaded.exists && !loaded.valid) throw envError('BUDGET_INVALID', `${loaded.path} is ${loaded.error}`);
    const { changed, ...res } = mutate(loaded.budget, loaded.path, state);
    if (!ctx.dryRun && changed) writeJsonAtomic(p.budget, loaded.budget);
    return { ...res, dry_run: ctx.dryRun };
  };
  return ctx.dryRun || !fs.existsSync(p.budget) ? body() : withLock(p.budgetLock, body, LOCK);
}

const budgetReset = defineCommand({
  name: 'budget reset',
  usage: 'budget reset --session <id>  (terminals only; zeroes that session\'s spend, keeps the daily total)',
  positionals: false,
  options: { session: { type: 'string' } },
  run: async (ctx, values) => {
    if (!ctx.interactiveTty) throw usageError(`budget reset ${TTY_ONLY}`);
    if (!values.session) throw usageError('budget reset needs --session <id>');
    const result = await budgetWrite(ctx, (b, file) => {
      const s = b.sessions[values.session];
      if (!s) throw usageError(`no session "${values.session}" in ${file}`);
      const previous = s.spent;
      s.resets = [...toArray(s.resets), { ts: nowIso(), by: 'tty', previous_spent: previous }];
      s.spent = 0;
      return { session: values.session, previous_spent: previous, spent: 0, changed: true };
    });
    const summary = `${ctx.dryRun ? 'would reset' : 'reset'} session ${values.session} (was ${result.previous_spent})`;
    return { result, exit: EXIT.OK, summary: `${summary}; the daily total is kept` };
  },
});

const budgetPrune = defineCommand({
  name: 'budget prune',
  usage: `budget prune [--dry-run]  (keep the newest ${KEEP.sessions} sessions and ${KEEP.days} days of totals)`,
  positionals: false,
  run: async (ctx) => {
    const result = await budgetWrite(ctx, (b, file, state) => {
      // The open hook session is kept, so pruning cannot reset the cap of the session in progress.
      const open = newestOpenSession(state.dir);
      const res = pruneBudget(b, { protect: open ? String(open.id) : null });
      return { ...res, changed: res.removed_sessions.length + res.removed_days.length > 0 };
    });
    const { removed_sessions: rs, removed_days: rd, kept } = result;
    const summary = `${ctx.dryRun ? 'would remove' : 'removed'} ${rs.length} session(s), ${rd.length} day total(s)`;
    return { result, exit: EXIT.OK, summary: `${summary}; ${kept} kept` };
  },
});

export const budgetCommand = defineGroup({
  name: 'budget',
  usage: `budget <show|reset|prune>\n  show [--session <id>]\n  reset --session <id>   (interactive terminals only)\n`
    + `  prune                  (keep the newest ${KEEP.sessions} sessions)`,
  subcommands: { show: budgetShow, reset: budgetReset, prune: budgetPrune },
  defaultSub: 'show',
});
