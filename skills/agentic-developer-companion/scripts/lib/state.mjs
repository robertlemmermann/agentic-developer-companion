// The `.adc/` state directory (§7.3): location, git exclusion, the tracked-state refusal,
// owner-only permissions, template materialization, session files, metrics and hook log.

import fs from 'node:fs';
import path from 'node:path';
import {
  EXIT, AdcError, ensureDir, readJson, readText, writeFileAtomic, writeJsonAtomic, withLock, relPosix, toPosix, nowIso,
  run, stamp, runId, realPath, isDir, isObj, statOrNull, listDir, findUp, stripBom, cmp, usageError, redactLiveToken,
  IS_WINDOWS, TEMPLATES_DIR,
} from './core.mjs';
import { repoRoot, lsFiles, checkIgnore, appendExclude, requireRepo, resolveBase, createSnapshot } from './git.mjs';

export const STATE_DIR_NAME = '.adc';
export const DEFAULT_BUDGET = Object.freeze({ max_per_session: 2500, max_per_day: 2500, warn_at: 2000 });
const LOG_ROTATE_BYTES = 1024 * 1024;

/**
 * Where the state dir lives: --state-dir > ADC_HOME > <repo root>/.adc (> <cwd>/.adc outside git).
 * Pass `root` when the repository root is already known (hooks find it without git); a
 * relative --state-dir then resolves against `cwd` (default: `root`).
 * Returns { dir, root, rel, insideRepo, source }.
 */
export function resolveStateDir({ cwd = null, stateDirOption = null, env = process.env, root: knownRoot } = {}) {
  const known = knownRoot !== undefined;
  cwd = cwd || (known && knownRoot) || process.cwd();
  const root = known ? knownRoot : repoRoot(cwd);
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

/** Tracked files under the state dir (must be empty). `strict`: null when git cannot tell (see git.lsFiles). */
export function trackedStateFiles(info, { timeoutMs, strict = false } = {}) {
  if (!info.root || !info.insideRepo) return [];
  return lsFiles(info.root, [`:(top)${info.rel}`], { timeoutMs, strict });
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
 * info/exclude`, so linked worktrees and submodules work; `excludeFile` skips git). Never a
 * committed change.
 */
export function ensureExcluded(info, { excludeFile = null } = {}) {
  if (!info.insideRepo) return { ok: true, needed: false };
  const r = appendExclude(info.root, `/${info.rel}/`, { aliases: [`/${info.rel}`, `${info.rel}/`], excludeFile });
  return { needed: true, ...r };
}

/** Create the state dir owner-only (0700 / icacls) when missing; true when it is a directory. */
export function createStateDir(info) {
  if (!fs.existsSync(info.dir)) {
    ensureDir(info.dir, 0o700);
    setOwnerOnly(info.dir, { dir: true });
  }
  return isDir(info.dir);
}

/** Is `<rel>/<sub>` ignored by git right now (exclude file, .gitignore, negations all applied)? */
export function stateIgnored(info, sub = '.env.live') {
  if (!info.insideRepo) return true;
  return checkIgnore(info.root, `${info.rel}/${sub}`);
}

/**
 * Resolve, check and (optionally) create the state dir. Throws exit 3 when it is tracked. Pass
 * `root` when the repository root is already known (saves a `git rev-parse`).
 * Returns the info object extended with `paths` and `exclude`.
 */
export function prepareStateDir(ctx = {}, { create = true, root } = {}) {
  const info = resolveStateDir({ cwd: ctx.cwd, stateDirOption: ctx.stateDirOption, ...(root ? { root } : {}) });
  assertStateUntracked(info);
  let exclude = { ok: true, needed: info.insideRepo };
  if (create) {
    exclude = ensureExcluded(info);
    createStateDir(info);
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
  for (const raw of stripBom(String(text || '')).split('\n')) {
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

/** A session id as `--session` accepts it (the hooks' ids are sanitized to this alphabet too). */
export const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;

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

/**
 * Newest session file without a session-end record, or null: `{ id, mtime, session }`. Files are
 * read newest first, so a long session history costs one read, not one per file.
 */
export function newestOpenSession(stateDir) {
  const dir = statePaths(stateDir).sessions;
  const files = [];
  for (const f of listDir(dir)) {
    if (!f.endsWith('.json')) continue;
    const full = path.join(dir, f);
    const st = statOrNull(full);
    if (st) files.push({ f, full, mtime: st.mtimeMs });
  }
  // Stable sort: among equal mtimes the first listed wins.
  files.sort((a, b) => b.mtime - a.mtime);
  for (const { f, full, mtime } of files) {
    const s = readJson(full, null);
    if (s && !s.ended) return { id: s.session_id || f.replace(/\.json$/, ''), mtime, session: s };
  }
  return null;
}

/**
 * Session identity (§10.3.2): `explicit` (--session, validated) > the newest open hook session
 * file > a generated run id. Returns `{ id, source: 'flag' | 'session-file' | 'generated', record? }`.
 */
export function resolveSession(stateDir, explicit) {
  if (explicit) {
    if (!SESSION_ID_RE.test(String(explicit))) throw usageError(`--session must match ${SESSION_ID_RE}`);
    return { id: String(explicit), source: 'flag' };
  }
  const open = newestOpenSession(stateDir);
  if (open?.id) return { id: String(open.id), source: 'session-file', record: open.session };
  return { id: runId('run'), source: 'generated' };
}

/** `[{ name, file }]` for the `*.json` files in `<stateDir>/evidence` (or `evidenceDir`); [] when absent. */
export function ledgerFiles(stateDir, { evidenceDir = null } = {}) {
  const dir = evidenceDir || statePaths(stateDir).evidence;
  return listDir(dir).filter((n) => n.endsWith('.json')).map((name) => ({ name, file: path.join(dir, name) }));
}

/**
 * Evidence ledgers (`<state>/evidence/*.json` with an `adc-evidence/*` schema), newest first by
 * `created_at` (verify's snapshot time; later `evidence add` calls do not make a ledger fresher),
 * then by name. `max` reads only the most recently modified files (the stop hook reads 5);
 * `evidenceDir` overrides `<stateDir>/evidence`. Returns `[{ file, name, created_at, finalized, verdict }]`.
 */
export function listLedgers(stateDir, { max = Infinity, evidenceDir = null } = {}) {
  let files = ledgerFiles(stateDir, { evidenceDir });
  if (Number.isFinite(max)) {
    for (const f of files) f.mtimeMs = statOrNull(f.file)?.mtimeMs ?? -1;
    files = files.filter((f) => f.mtimeMs >= 0)
      .sort((a, b) => b.mtimeMs - a.mtimeMs || cmp(b.name, a.name)).slice(0, max);
  }
  const rows = [];
  for (const f of files) {
    const led = readJson(f.file, null);
    if (!isObj(led) || !String(led.schema || '').startsWith('adc-evidence/')) continue;
    const ts = [led.created_at, led.finalized_at, led.updated_at]
      .find((t) => typeof t === 'string' && !Number.isNaN(Date.parse(t))) || '';
    const verdict = typeof led.verdict === 'string' ? led.verdict : null;
    rows.push({ file: f.file, name: f.name, created_at: ts, finalized: Boolean(led.finalized_at), verdict });
  }
  const t = (r) => Date.parse(r.created_at) || 0;
  return rows.sort((a, b) => t(b) - t(a) || cmp(b.name, a.name));
}

// ---------------------------------------------------------------------------
// Git-free repository lookup (hooks: no git process on the hot path)

/**
 * Walk up from `start` to the first directory holding `.git` (a directory, or the file a linked
 * worktree or submodule has). Returns `{ root, gitDir, commonDir }` (root symlink-resolved) or null.
 */
export function locateRepo(start) {
  if (!start || typeof start !== 'string') return null;
  const abs = path.resolve(start);
  const st = statOrNull(abs);
  const dir = st && findUp(st.isDirectory() ? abs : path.dirname(abs), '.git');
  if (!dir) return null;
  let gitDir = path.join(dir, '.git');
  if (statOrNull(gitDir)?.isFile()) {
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(readText(gitDir, '') || '');
    if (!m) return null;
    gitDir = path.resolve(dir, m[1]);
  }
  const common = readText(path.join(gitDir, 'commondir'));
  const commonDir = common && common.trim() ? path.resolve(gitDir, common.trim()) : gitDir;
  return { root: realPath(dir), gitDir, commonDir };
}

// ---------------------------------------------------------------------------
// Generated files (scaffold, tooling port): create freely, never clobber without --force

/** Lazy `<state>/<sub...>/<stamp>/` backup dir: created on first call, null when the state dir is unusable. */
export function backupDirFactory(ctx, root, ...sub) {
  let dir;
  return () => {
    if (dir !== undefined) return dir;
    try {
      const info = prepareStateDir({ ...(ctx || {}), cwd: root }, { create: true });
      dir = ensureDir(path.join(info.dir, ...sub, stamp()));
    } catch {
      dir = null;
    }
    return dir;
  };
}

/**
 * Write (or with `dryRun` plan) generated files. Each output is `{ path, content, merge?, replace?,
 * absPath?, ...extra }`: `path` is relative to `root` (POSIX) unless `absPath` is given; `merge(current)`
 * returns the merged text for an existing file; `replace` overwrites without `force`. Existing files
 * are kept unless merged or forced; with `mergeNeedsForce` merges need `force` too. Paths outside
 * `root` and directories are skipped; the same path twice is merged into one output. Overwritten
 * (and forced merged) files are copied to `backupDir()` first. `host` and `kind` are copied to the
 * rows. Returns `{ written: [{ path, action, bytes }], skipped: [{ path, reason, planned? }], backups[] }`
 * with actions create | merge | overwrite | unchanged (`would-*` in a dry run).
 */
export function writeOutputs(outputs, {
  root, dryRun = false, force = false, mergeNeedsForce = false, backupDir = null,
} = {}) {
  const written = [];
  const skipped = [];
  const backups = [];
  const byPath = new Map();
  for (const o of outputs) {
    const abs = o.absPath || path.join(root, ...String(o.path).split('/'));
    const prev = byPath.get(abs);
    if (!prev) { byPath.set(abs, { ...o, abs }); continue; }
    if (o.merge && typeof prev.content === 'string') prev.content = o.merge(prev.content);
  }
  for (const o of byPath.values()) {
    const { path: shown, abs, content, merge, replace, absPath } = o;
    const extra = Object.fromEntries(['host', 'kind'].filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
    if (!absPath && (relPosix(root, abs) == null || String(shown).split('/').includes('..'))) {
      skipped.push({ path: shown, reason: 'outside the repository', ...extra });
      continue;
    }
    if (isDir(abs)) { skipped.push({ path: shown, reason: 'a directory exists at this path', ...extra }); continue; }
    let current = null;
    try { current = fs.readFileSync(abs); } catch {}
    let next = content;
    let action = 'create';
    if (current != null) {
      const text = current.toString('utf8');
      action = merge && !replace ? 'merge' : 'overwrite';
      if (action === 'merge') {
        try { next = merge(text); } catch (err) {
          if (!force) {
            const reason = `cannot merge (${err.message}); use --force to replace it`;
            skipped.push({ path: shown, reason, planned: 'overwrite', ...extra });
            continue;
          }
          next = content;
          action = 'overwrite';
        }
      }
      const lf = (t) => t.replace(/\r\n/g, '\n');
      const same = Buffer.isBuffer(next) ? current.equals(next) : lf(String(next)) === lf(text);
      if (same) { written.push({ path: shown, action: 'unchanged', bytes: current.length, ...extra }); continue; }
      if (!force && !replace && (action === 'overwrite' || mergeNeedsForce)) {
        const reason = `exists (use --force to ${action}; a backup is kept)`;
        skipped.push({ path: shown, reason, planned: action, ...extra });
        continue;
      }
      if (!dryRun && backupDir && (action === 'overwrite' || mergeNeedsForce)) {
        const dir = backupDir();
        if (dir) {
          const b = path.join(dir, ...String(shown).replace(/^(\.\.\/)+/, '').split('/'));
          ensureDir(path.dirname(b));
          fs.writeFileSync(b, current);
          backups.push(toPosix(b));
        }
      }
    }
    if (!dryRun) writeFileAtomic(abs, next);
    const done = dryRun ? `would-${action}` : action;
    written.push({ path: shown, action: done, bytes: Buffer.byteLength(next), ...extra });
  }
  return { written, skipped, backups };
}

// ---------------------------------------------------------------------------
// Append-only records

function appendJsonl(file, record) {
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
    const line = redactLiveToken(JSON.stringify({ ts: nowIso(), ...entry }));
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
  const root = requireRepo(ctx.cwd);
  const state = prepareStateDir({ ...ctx, cwd: root }, { create: createState, root });
  const b = resolveBase(root, base);
  const snap = snapshot || createSnapshot(root, { exclude: snapshotExcludes(state) });
  return { root, state, base: b, snapshot: snap };
}
