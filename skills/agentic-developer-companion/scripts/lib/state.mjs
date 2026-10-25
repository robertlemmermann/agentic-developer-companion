// The `.adc/` state directory (§7.3): location, git exclusion, the tracked-state refusal,
// owner-only permissions, template materialization, session files, metrics and hook log.

import fs from 'node:fs';
import path from 'node:path';
import {
  EXIT, AdcError, envError, ensureDir, readJson, readText, writeFileAtomic, writeJsonAtomic, withLock,
  relPosix, toPosix, nowIso, run, IS_WINDOWS, TEMPLATES_DIR,
} from './core.mjs';
import { repoRoot, lsFiles, checkIgnore, gitPath } from './git.mjs';

export const STATE_DIR_NAME = '.adc';
export const DEFAULT_BUDGET = Object.freeze({ max_per_session: 2500, max_per_day: 2500, warn_at: 2000 });
const LOG_ROTATE_BYTES = 1024 * 1024;

/**
 * Where the state dir lives: --state-dir > ADC_HOME > <repo root>/.adc (> <cwd>/.adc outside git).
 * Returns { dir, root, rel, insideRepo, source }.
 */
export function resolveStateDir({ cwd = process.cwd(), stateDirOption = null, env = process.env } = {}) {
  const root = repoRoot(cwd);
  let dir;
  let source;
  if (stateDirOption) { dir = path.resolve(cwd, stateDirOption); source = 'flag'; }
  else if (env.ADC_HOME) { dir = path.resolve(env.ADC_HOME); source = 'ADC_HOME'; }
  else { dir = path.join(root || cwd, STATE_DIR_NAME); source = root ? 'default' : 'default-no-git'; }
  const rel = root ? relPosix(root, dir) : null;
  const insideRepo = Boolean(rel && rel !== '.');
  return { dir, root, rel: insideRepo ? rel : null, insideRepo, source };
}

export function statePaths(dir) {
  return {
    dir,
    budget: path.join(dir, 'budget.json'),
    budgetLock: path.join(dir, 'budget.json.lock'),
    envLive: path.join(dir, '.env.live'),
    detect: path.join(dir, 'detect.json'),
    evidence: path.join(dir, 'evidence'),
    sessions: path.join(dir, 'sessions'),
    countsCache: path.join(dir, 'cache', 'counts'),
    cache: path.join(dir, 'cache'),
    metrics: path.join(dir, 'metrics.jsonl'),
    hooksLog: path.join(dir, 'hooks.log'),
    hooksInstalled: path.join(dir, 'hooks-installed.json'),
    repro: path.join(dir, 'repro'),
    tooling: path.join(dir, 'tooling'),
  };
}

/** Tracked files under the state dir (must be empty). */
export function trackedStateFiles(info) {
  if (!info.root || !info.insideRepo) return [];
  return lsFiles(info.root, [`:(top)${info.rel}`]);
}

/** Every CLI command refuses (exit 3) while anything under the state dir is tracked by git. */
export function assertStateUntracked(info) {
  const tracked = trackedStateFiles(info);
  if (tracked.length) {
    throw new AdcError(EXIT.ENV, 'STATE_TRACKED',
      `${info.rel}/ is tracked by git (${tracked.length} file(s), e.g. ${tracked[0]}); run \`git rm -r --cached ${info.rel}\` and keep it ignored`,
      { tracked: tracked.slice(0, 20) });
  }
}

/**
 * Add `/<rel>/` to the repository's exclude file (resolved with `git rev-parse --git-path
 * info/exclude`, so linked worktrees and submodules work). Never a committed change.
 */
export function ensureExcluded(info) {
  if (!info.insideRepo) return { ok: true, needed: false };
  const entry = `/${info.rel}/`;
  let excludeFile;
  try {
    excludeFile = gitPath(info.root, 'info/exclude');
    const current = readText(excludeFile, '');
    const lines = current.split(/\r?\n/).map((l) => l.trim());
    if (!lines.includes(entry) && !lines.includes(`/${info.rel}`) && !lines.includes(`${info.rel}/`)) {
      ensureDir(path.dirname(excludeFile));
      const sep = current && !current.endsWith('\n') ? '\n' : '';
      fs.appendFileSync(excludeFile, `${sep}# agentic-developer-companion state (never commit)\n${entry}\n`);
      return { ok: true, needed: true, written: true, excludeFile: toPosix(excludeFile), entry };
    }
    return { ok: true, needed: true, written: false, excludeFile: toPosix(excludeFile), entry };
  } catch (err) {
    return { ok: false, needed: true, written: false, excludeFile: excludeFile ? toPosix(excludeFile) : null, entry, error: err.code || err.message };
  }
}

/** Is `<rel>/<sub>` ignored by git right now (exclude file, .gitignore, negations all applied)? */
export function stateIgnored(info, sub = '.env.live') {
  if (!info.insideRepo) return true;
  return checkIgnore(info.root, `${info.rel}/${sub}`);
}

/**
 * Resolve, check and (optionally) create the state dir. Throws exit 3 when it is tracked.
 * Returns the info object extended with `paths` and `exclude`.
 */
export function prepareStateDir(ctx = {}, { create = true } = {}) {
  const info = resolveStateDir({ cwd: ctx.cwd, stateDirOption: ctx.stateDirOption });
  assertStateUntracked(info);
  let exclude = { ok: true, needed: info.insideRepo };
  if (create) {
    exclude = ensureExcluded(info);
    const existed = fs.existsSync(info.dir);
    ensureDir(info.dir, 0o700);
    if (!existed) setOwnerOnly(info.dir, { dir: true });
  }
  return { ...info, paths: statePaths(info.dir), exclude, ignored: info.insideRepo ? stateIgnored(info, 'probe') : true };
}

/** Path components relative to the snapshot exclusion list (always `.adc`, plus a relocated dir). */
export function snapshotExcludes(info) {
  const ex = [STATE_DIR_NAME];
  if (info && info.insideRepo && info.rel && info.rel !== STATE_DIR_NAME) ex.push(info.rel);
  return ex;
}

// ---------------------------------------------------------------------------
// Permissions

let cachedSid;
function currentSid() {
  if (cachedSid !== undefined) return cachedSid;
  const res = run('whoami', ['/user', '/fo', 'csv', '/nh']);
  const m = /"([^"]*)","(S-[0-9-]+)"/.exec(res.stdout || '');
  cachedSid = m ? m[2] : null;
  return cachedSid;
}

/** Owner-only access: 0o600 files / 0o700 dirs on POSIX; icacls with the user's SID on Windows. */
export function setOwnerOnly(file, { dir = false } = {}) {
  try {
    if (IS_WINDOWS) {
      const sid = currentSid();
      if (!sid) return { ok: false, detail: 'could not resolve the current user SID' };
      const res = run('icacls', [file, '/inheritance:r', '/grant:r', `*${sid}:${dir ? '(OI)(CI)F' : '(R,W)'}`]);
      return { ok: res.exit === 0, detail: res.exit === 0 ? 'icacls' : (res.stderr || res.stdout).trim() };
    }
    fs.chmodSync(file, dir ? 0o700 : 0o600);
    return { ok: true, detail: dir ? '0700' : '0600' };
  } catch (err) {
    return { ok: false, detail: err.code || err.message };
  }
}

/** Verify owner-only access; also detects filesystems that cannot hold permissions. */
export function checkOwnerOnly(file) {
  try {
    if (!fs.existsSync(file)) return { ok: true, present: false };
    if (IS_WINDOWS) {
      const res = run('icacls', [file]);
      const aces = (res.stdout || '').split(/\r?\n/).slice(0, -1)
        .map((l) => l.replace(file, '').trim()).filter((l) => /:\(/.test(l));
      const inherited = aces.some((a) => /\(I\)/.test(a));
      return { ok: res.exit === 0 && aces.length === 1 && !inherited, present: true, detail: aces.join('; ') };
    }
    const mode = fs.statSync(file).mode & 0o777;
    return { ok: (mode & 0o077) === 0, present: true, mode: mode.toString(8).padStart(4, '0') };
  } catch (err) {
    return { ok: false, present: true, detail: err.code || err.message };
  }
}

// ---------------------------------------------------------------------------
// Templates: budget.json and .env.live

/**
 * Materialize the shipped templates into the state dir. `.env.live` is created only after the
 * post-condition holds: the path is git-ignored and nothing under the state dir is tracked.
 */
export function materializeTemplates(info, { envLive = true } = {}) {
  const p = info.paths || statePaths(info.dir);
  const out = { budget: { path: toPosix(p.budget), created: false }, envLive: { path: toPosix(p.envLive), created: false } };
  if (!fs.existsSync(p.budget)) {
    const tpl = readText(path.join(TEMPLATES_DIR, 'adc', 'budget.json'));
    writeFileAtomic(p.budget, tpl);
    out.budget.created = true;
  }
  if (envLive && !fs.existsSync(p.envLive)) {
    const ignored = stateIgnored(info, '.env.live');
    const tracked = trackedStateFiles(info);
    if (!ignored || tracked.length) {
      out.envLive.reason = !ignored
        ? `${info.rel}/.env.live would not be ignored by git; fix the ignore rules (an in-tree negation such as !.adc/** overrides the exclude file) or relocate with ADC_HOME / --state-dir`
        : `${info.rel}/ has tracked files`;
    } else {
      const tpl = readText(path.join(TEMPLATES_DIR, 'adc', 'env.live.example'));
      writeFileAtomic(p.envLive, tpl, { mode: 0o600 });
      setOwnerOnly(p.envLive);
      out.envLive.created = true;
    }
  }
  if (fs.existsSync(p.envLive)) {
    if (!IS_WINDOWS) setOwnerOnly(p.envLive);
    out.envLive.perms = checkOwnerOnly(p.envLive);
  }
  return out;
}

/** Parse a dotenv-style file: BOM and \r stripped, optional `export `, optional quotes. */
export function parseEnvFile(text) {
  const map = {};
  for (const raw of String(text || '').replace(/^﻿/, '').split('\n')) {
    const line = raw.replace(/\r$/, '').trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2) || (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) v = v.slice(1, -1);
    map[m[1]] = v;
  }
  return map;
}

/** `{ set, source }` for ADC_LIVE_TOKEN; the value itself is never returned. */
export function credentialStatus(info, env = process.env) {
  if (env.ADC_LIVE_TOKEN) return { name: 'ADC_LIVE_TOKEN', set: true, source: 'environment' };
  const file = (info.paths || statePaths(info.dir)).envLive;
  const text = readText(file);
  if (text != null && parseEnvFile(text).ADC_LIVE_TOKEN) return { name: 'ADC_LIVE_TOKEN', set: true, source: `${info.rel || STATE_DIR_NAME}/.env.live` };
  return { name: 'ADC_LIVE_TOKEN', set: false, source: null };
}

// ---------------------------------------------------------------------------
// Session files (written by hooks, read by the stop hook and the live runner)

export function sanitizeId(id) {
  const s = String(id || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100);
  return s || 'unknown';
}

export const sessionFile = (stateDir, id) => path.join(statePaths(stateDir).sessions, `${sanitizeId(id)}.json`);

export function readSession(stateDir, id) {
  return readJson(sessionFile(stateDir, id), null);
}

/** Read-modify-write a session file under a short lock. `mutate(session)` returns the new object. */
export async function updateSession(stateDir, id, mutate) {
  const file = sessionFile(stateDir, id);
  return withLock(`${file}.lock`, () => {
    const cur = readJson(file, null) || { schema: 'adc-session/1', session_id: String(id), started: nowIso(), events: {} };
    const next = mutate(cur) || cur;
    next.updated = nowIso();
    writeJsonAtomic(file, next);
    return next;
  }, { waitMs: 800 });
}

/** Newest session file without a session-end record, or null. */
export function newestOpenSession(stateDir) {
  const dir = statePaths(stateDir).sessions;
  let best = null;
  let entries = [];
  try { entries = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return null; }
  for (const f of entries) {
    const full = path.join(dir, f);
    const s = readJson(full, null);
    if (!s || s.ended) continue;
    const mtime = fs.statSync(full).mtimeMs;
    if (!best || mtime > best.mtime) best = { id: s.session_id || f.replace(/\.json$/, ''), mtime, session: s };
  }
  return best;
}

// ---------------------------------------------------------------------------
// Append-only records

export function appendJsonl(file, record) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, JSON.stringify(record) + '\n');
}

export const appendMetrics = (stateDir, record) => appendJsonl(statePaths(stateDir).metrics, { ts: nowIso(), ...record });

/**
 * hooks.log: metadata only (event, tool, key names, byte lengths, classification, timings),
 * never payload bodies; rotated at 1 MB. The token-shape rewrite is belt and braces.
 */
export function hookLog(stateDir, entry) {
  try {
    const file = statePaths(stateDir).hooksLog;
    ensureDir(path.dirname(file));
    try {
      if (fs.statSync(file).size > LOG_ROTATE_BYTES) fs.renameSync(file, `${file}.1`);
    } catch {}
    const line = JSON.stringify({ ts: nowIso(), ...entry }).replace(/ADC_LIVE_TOKEN\s*=\s*\S+/g, 'ADC_LIVE_TOKEN=[REDACTED]');
    fs.appendFileSync(file, line + '\n');
  } catch {
    // Logging must never break a hook.
  }
}

// ---------------------------------------------------------------------------
// Target preparation shared by every QA command

/**
 * Resolve the repository, the state dir (refusing a tracked one), the base and the
 * working-tree snapshot. Pass `snapshot` to reuse one created by `verify`.
 * Returns { root, state, base: { ref, tip, sha, source }, snapshot: { tree, commit, head } }.
 */
export async function prepareTarget(ctx, { base = null, snapshot = null, createState = true } = {}) {
  const { requireRepo, resolveBase, createSnapshot } = await import('./git.mjs');
  const root = requireRepo(ctx.cwd);
  const state = prepareStateDir({ ...ctx, cwd: root }, { create: createState });
  const b = resolveBase(root, base);
  const snap = snapshot || createSnapshot(root, { exclude: snapshotExcludes(state) });
  return { root, state, base: b, snapshot: snap };
}
