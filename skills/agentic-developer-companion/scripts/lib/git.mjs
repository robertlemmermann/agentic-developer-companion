// Git layer: repository identity, base resolution (§7.4), the working-tree snapshot (§7.5),
// temp worktrees, and diff parsing. Every call goes through `git` with an argument array.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  envError, unverifiable, usageError, run, nonce, tmpRoot, ensureDir, toPosix, versionGte, parseVersion, readText,
} from './core.mjs';

export const MIN_GIT = '2.31.0';
const SNAPSHOT_IDENT = {
  GIT_AUTHOR_NAME: 'agentic-developer-companion', GIT_AUTHOR_EMAIL: 'adc@localhost',
  GIT_COMMITTER_NAME: 'agentic-developer-companion', GIT_COMMITTER_EMAIL: 'adc@localhost',
};

/** Run git; returns the raw result object from core.run. Throws only when git itself is missing. */
export function gitRaw(cwd, args, { env, input, timeoutMs = 120_000 } = {}) {
  const res = run('git', args, { cwd, env: env ? { ...process.env, ...env } : process.env, input, timeoutMs });
  if (res.error === 'ENOENT') throw envError('NO_GIT', 'git is not on PATH (Git 2.31+ is required)');
  return res;
}

/** Run git and return stdout without the trailing newline; throws an exit-4 error on failure. */
export function git(cwd, args, opts = {}) {
  const res = gitRaw(cwd, args, opts);
  if (res.exit !== 0) {
    throw unverifiable('GIT_FAILED', `git ${args.join(' ')} failed: ${(res.stderr || res.stdout).trim().split('\n')[0]}`,
      { args, exit: res.exit });
  }
  return res.stdout.replace(/\r?\n$/, '');
}

/** git, or null on failure. */
export function gitTry(cwd, args, opts = {}) {
  const res = gitRaw(cwd, args, opts);
  return res.exit === 0 ? res.stdout.replace(/\r?\n$/, '') : null;
}

export function gitVersion() {
  const res = run('git', ['--version']);
  if (res.error) return null;
  const v = parseVersion(res.stdout);
  return v ? v.join('.') : null;
}

export function requireGit() {
  const v = gitVersion();
  if (!v) throw envError('NO_GIT', 'git is not on PATH (Git 2.31+ is required)');
  if (!versionGte(v, MIN_GIT)) throw envError('GIT_TOO_OLD', `Git ${MIN_GIT}+ is required (found ${v})`);
  return v;
}

/** Absolute repository root for `cwd`, or null outside a work tree. */
export function repoRoot(cwd) {
  try {
    const out = gitTry(cwd, ['rev-parse', '--show-toplevel']);
    return out ? path.resolve(out) : null;
  } catch {
    return null;
  }
}

export function requireRepo(cwd) {
  requireGit();
  const root = repoRoot(cwd);
  if (!root) throw envError('NOT_A_REPO', `not inside a Git work tree: ${toPosix(cwd)}`);
  return root;
}

export const revParse = (root, ref) => gitTry(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
export const headSha = (root) => revParse(root, 'HEAD');
export const isShallow = (root) => gitTry(root, ['rev-parse', '--is-shallow-repository']) === 'true';

export function emptyTree(root) {
  return git(root, ['hash-object', '-t', 'tree', '--stdin'], { input: '' });
}

/** Absolute path of a file inside the git dir (handles linked worktrees and submodules). */
export function gitPath(root, name) {
  const p = git(root, ['rev-parse', '--git-path', name]);
  return path.resolve(root, p);
}

/**
 * Base-ref resolution (§7.4): --base > origin/HEAD > main | master | init.defaultBranch > HEAD.
 * Returns { ref, tip, sha, source } where `sha` is the merge base with HEAD (the diff origin).
 */
export function resolveBase(root, explicit) {
  const head = headSha(root);
  let ref = null;
  let source = null;
  if (explicit) {
    if (!revParse(root, explicit)) {
      if (isShallow(root)) throw unverifiable('SHALLOW', `base "${explicit}" is not available in this shallow clone; run \`git fetch --unshallow\``);
      throw usageError(`--base "${explicit}" does not name a commit`);
    }
    ref = explicit;
    source = 'flag';
  }
  if (!ref) {
    const sym = gitTry(root, ['symbolic-ref', '-q', 'refs/remotes/origin/HEAD']);
    if (sym && revParse(root, sym)) { ref = sym.replace(/^refs\/remotes\//, ''); source = 'origin/HEAD'; }
  }
  if (!ref) {
    const configured = gitTry(root, ['config', '--get', 'init.defaultBranch']);
    for (const [name, src] of [['main', 'main'], ['master', 'master'], [configured, 'init.defaultBranch']]) {
      if (!name) continue;
      for (const candidate of [`refs/heads/${name}`, `refs/remotes/origin/${name}`]) {
        if (revParse(root, candidate)) { ref = candidate.replace(/^refs\/(heads|remotes)\//, ''); source = src; break; }
      }
      if (ref) break;
    }
  }
  if (!ref) {
    if (!head) return { ref: null, tip: null, sha: null, source: 'empty' };
    return { ref: 'HEAD', tip: head, sha: head, source: 'HEAD' };
  }
  const tip = revParse(root, ref);
  if (!head) return { ref, tip, sha: tip, source };
  const mb = gitTry(root, ['merge-base', ref, 'HEAD']);
  if (!mb) {
    if (isShallow(root)) throw unverifiable('SHALLOW', 'no merge base in this shallow clone; run `git fetch --unshallow`');
    throw unverifiable('NO_MERGE_BASE', `"${ref}" and HEAD share no history`);
  }
  return { ref, tip, sha: mb, source };
}

/**
 * Working-tree snapshot (§7.5): a temporary index seeded from the real one, `git add -A`
 * with the state dir excluded, then write-tree + commit-tree. Covers modified and untracked
 * files, honors .gitignore and info/exclude, and never touches the user's index or stash.
 */
export function createSnapshot(root, { exclude = ['.adc'] } = {}) {
  const head = headSha(root);
  const dir = ensureDir(tmpRoot(root));
  const tmpIndex = path.join(dir, `index-${nonce()}`);
  const env = { GIT_INDEX_FILE: tmpIndex };
  try {
    const realIndex = gitPath(root, 'index');
    if (fs.existsSync(realIndex)) {
      fs.copyFileSync(realIndex, tmpIndex);
      // Racy-git guard: the copy gets a fresh mtime, which would make git trust stale stat
      // data for files edited in the same tick as the last real index write. Backdating the
      // copy makes git re-hash every recently modified file.
      const t = new Date(fs.statSync(realIndex).mtimeMs - 2000);
      fs.utimesSync(tmpIndex, t, t);
    } else if (head) git(root, ['read-tree', 'HEAD'], { env });
    // Naming an already-ignored path in a pathspec makes `git add` exit 1, so only paths git
    // would otherwise pick up are excluded explicitly; the rm below covers the rest.
    const excluded = exclude.filter(Boolean).map((p) => toPosix(p).replace(/\/+$/, ''))
      .filter((p) => !checkIgnore(root, p) && !checkIgnore(root, `${p}/`));
    const pathspec = ['.', ...excluded.map((p) => `:(top,exclude)${p}`)];
    git(root, ['add', '-A', '--', ...pathspec], { env, timeoutMs: 600_000 });
    // Make sure nothing under an excluded path survives from the seeded index.
    for (const p of exclude.filter(Boolean)) {
      gitRaw(root, ['rm', '-r', '--cached', '--quiet', '--ignore-unmatch', '--', `:(top)${toPosix(p).replace(/\/+$/, '')}`], { env });
    }
    const tree = git(root, ['write-tree'], { env });
    const commit = git(root, ['commit-tree', tree, ...(head ? ['-p', head] : []), '-m', 'agentic-developer-companion snapshot'],
      { env: { ...env, ...SNAPSHOT_IDENT } });
    return { tree, commit, head };
  } finally {
    fs.rmSync(tmpIndex, { force: true });
    fs.rmSync(`${tmpIndex}.lock`, { force: true });
  }
}

/** Parse `git diff --name-status -z -M`. */
export function diffNameStatus(root, from, to, paths = []) {
  const out = git(root, ['-c', 'core.quotePath=false', 'diff', '--name-status', '-z', '-M', '--no-color', '--no-ext-diff', from, to, '--', ...paths]);
  const parts = out.split('\0').filter((p) => p !== '');
  const files = [];
  for (let i = 0; i < parts.length;) {
    const status = parts[i++];
    const code = status[0];
    if (code === 'R' || code === 'C') {
      files.push({ status: code, score: Number(status.slice(1)) || null, oldPath: parts[i++], path: parts[i++] });
    } else {
      files.push({ status: code, path: parts[i++] });
    }
  }
  return files;
}

/** `git diff --numstat` → { path, added, removed, binary }. */
export function diffNumstat(root, from, to, paths = []) {
  const out = git(root, ['-c', 'core.quotePath=false', 'diff', '--numstat', '-z', '-M', '--no-color', '--no-ext-diff', from, to, '--', ...paths]);
  const parts = out.split('\0');
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p) continue;
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/.exec(p);
    if (!m) continue;
    let file = m[3];
    if (file === '') { i += 2; file = parts[i]; } // rename: "\0old\0new"
    files.push({ path: file, added: m[1] === '-' ? 0 : Number(m[1]), removed: m[2] === '-' ? 0 : Number(m[2]), binary: m[1] === '-' });
  }
  return files;
}

/**
 * Added and removed lines per file from a zero-context diff:
 * [{ path, oldPath, status, binary, added: [{ line, text }], removed: [{ line, text }] }]
 */
export function diffLines(root, from, to, paths = []) {
  const out = git(root, ['-c', 'core.quotePath=false', 'diff', '-U0', '-M', '--no-color', '--no-ext-diff', '--no-textconv', from, to, '--', ...paths]);
  return parseUnifiedDiff(out);
}

/**
 * Parse unified diff text. Per file: `{ path, oldPath, status, binary, added, removed, hunks }`
 * where `hunks` are `{ oldStart, oldCount, newStart, newCount, added: [{line, text}], removed }`.
 */
export function parseUnifiedDiff(text) {
  const files = [];
  let cur = null;
  let hunk = null;
  let oldLine = 0;
  let newLine = 0;
  const unquote = (s) => {
    if (!(s.startsWith('"') && s.endsWith('"'))) return s;
    try { return JSON.parse(s); } catch { return s.slice(1, -1); }
  };
  for (const line of String(text).split('\n')) {
    if (line.startsWith('diff --git ')) {
      hunk = null;
      cur = { path: null, oldPath: null, status: 'M', binary: false, added: [], removed: [], hunks: [] };
      const m = /^diff --git (?:"?a\/)(.+?)"? (?:"?b\/)(.+?)"?$/.exec(line);
      if (m) { cur.oldPath = m[1]; cur.path = m[2]; }
      files.push(cur);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('new file mode')) cur.status = 'A';
    else if (line.startsWith('deleted file mode')) cur.status = 'D';
    else if (line.startsWith('rename from ')) { cur.status = 'R'; cur.oldPath = line.slice(12); }
    else if (line.startsWith('rename to ')) cur.path = line.slice(10);
    else if (line.startsWith('Binary files ')) cur.binary = true;
    else if (line.startsWith('--- ')) {
      const p = unquote(line.slice(4).trim());
      if (p !== '/dev/null') cur.oldPath = p.replace(/^a\//, '');
    } else if (line.startsWith('+++ ')) {
      const p = unquote(line.slice(4).trim());
      if (p !== '/dev/null') cur.path = p.replace(/^b\//, '');
      else cur.path = cur.oldPath;
    } else if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m) {
        oldLine = Number(m[1]);
        newLine = Number(m[3]);
        const count = (v) => (v == null ? 1 : Number(v));
        hunk = { oldStart: oldLine, oldCount: count(m[2]), newStart: newLine, newCount: count(m[4]) };
        Object.assign(hunk, { added: [], removed: [] });
        cur.hunks.push(hunk);
      }
    } else if (line.startsWith('+')) {
      const l = { line: newLine++, text: line.slice(1) };
      cur.added.push(l);
      if (hunk) hunk.added.push(l);
    } else if (line.startsWith('-')) {
      const l = { line: oldLine++, text: line.slice(1) };
      cur.removed.push(l);
      if (hunk) hunk.removed.push(l);
    } else if (line.startsWith('\\')) { /* "\ No newline at end of file" */ }
  }
  for (const f of files) {
    if (f.status === 'D') f.path = f.oldPath;
    if (f.status === 'A') f.oldPath = null;
  }
  return files;
}

/** File content at a revision, or null when absent. */
export function showFile(root, rev, file) {
  const res = gitRaw(root, ['cat-file', 'blob', `${rev}:${toPosix(file)}`]);
  return res.exit === 0 ? res.stdout : null;
}

/**
 * Files of a tree-ish (recursive): paths, or with `entries` `[{ mode, type, sha, path }]` (blobs
 * and submodule commits). `paths` limits the listing; entries keep repository-root paths.
 */
export function lsTree(root, rev, { paths = [], entries = false } = {}) {
  const args = ['-c', 'core.quotePath=false', 'ls-tree', '-r', '-z', entries ? '--full-tree' : '--name-only', rev];
  const out = gitTry(root, paths.length ? [...args, '--', ...paths] : args);
  if (out == null) return [];
  const recs = out.split('\0').filter(Boolean);
  if (!entries) return recs;
  return recs.map((r) => /^(\d+) (\w+) ([0-9a-f]+)\t(.*)$/s.exec(r)).filter(Boolean)
    .map((m) => ({ mode: m[1], type: m[2], sha: m[3], path: m[4] }));
}

/**
 * Raw contents of many objects in one `git cat-file --batch`: `specs` are object names or
 * `<rev>:<path>`. Returns Map(spec → Buffer | null); a missing object maps to null.
 */
export function readBlobs(root, specs) {
  const list = [...new Set(specs.map(String))];
  const out = new Map(list.map((x) => [x, null]));
  if (!list.length) return out;
  if (list.some((x) => /[\r\n]/.test(x))) throw usageError('readBlobs: object names cannot contain newlines');
  const res = spawnSync('git', ['cat-file', '--batch'],
    { cwd: root, input: list.join('\n') + '\n', maxBuffer: 1024 * 1024 * 1024, windowsHide: true });
  if (res.error && res.error.code === 'ENOENT') throw envError('NO_GIT', 'git is not on PATH (Git 2.31+ is required)');
  if (res.status !== 0) {
    throw unverifiable('GIT_FAILED', `git cat-file --batch failed: ${String(res.stderr || '').trim().split('\n')[0]}`);
  }
  const buf = res.stdout;
  let pos = 0;
  for (const spec of list) {
    const nl = buf.indexOf(10, pos);
    if (nl < 0) break;
    const header = buf.subarray(pos, nl).toString('utf8').split(' ');
    pos = nl + 1;
    if (header[header.length - 1] === 'missing' || header.length < 3) continue;
    const size = Number(header[2]);
    out.set(spec, buf.subarray(pos, pos + size));
    pos += size + 1;
  }
  return out;
}

/**
 * Tracked paths matching `pathspecs` ([] when git fails). `strict`: null when git fails, for
 * callers that must tell "nothing tracked" from "could not ask" (the hooks' tracked-state check).
 */
export function lsFiles(root, pathspecs = [], { timeoutMs, strict = false } = {}) {
  let res;
  try {
    const args = ['-c', 'core.quotePath=false', 'ls-files', '-z', '--', ...pathspecs];
    res = gitRaw(root, args, timeoutMs ? { timeoutMs } : {});
  } catch (err) {
    if (strict) return null;
    throw err;
  }
  if (res.exit !== 0) return strict ? null : [];
  return res.stdout.split('\0').filter(Boolean);
}

/** `git status --porcelain=v1 -z` including untracked files (no optional locks), or null on failure. */
export function statusPorcelain(root, paths = []) {
  const args = ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all'];
  const res = gitRaw(root, paths.length ? [...args, '--', ...paths] : args);
  return res.exit === 0 ? res.stdout : null;
}

/**
 * Add `entry` (e.g. `/.adc/`) to the repository's exclude file, never a committed change. The
 * file is `excludeFile` when given (git-free: hooks pass `<common git dir>/info/exclude`), else
 * `git rev-parse --git-path info/exclude` (linked worktrees and submodules). `aliases` are
 * equivalent spellings that count as present. Returns `{ ok, written, excludeFile, entry, error? }`.
 */
export function appendExclude(root, entry, {
  comment = 'agentic-developer-companion state (never commit)', aliases = [], excludeFile = null,
} = {}) {
  let file = excludeFile;
  try {
    file = file || gitPath(root, 'info/exclude');
    const current = readText(file, '') || '';
    const lines = current.split(/\r?\n/).map((l) => l.trim());
    if ([entry, ...aliases].some((e) => lines.includes(e))) {
      return { ok: true, written: false, excludeFile: toPosix(file), entry };
    }
    ensureDir(path.dirname(file));
    const sep = current && !current.endsWith('\n') ? '\n' : '';
    fs.appendFileSync(file, `${sep}${comment ? `# ${comment}\n` : ''}${entry}\n`);
    return { ok: true, written: true, excludeFile: toPosix(file), entry };
  } catch (err) {
    const excluded = file ? toPosix(file) : null;
    return { ok: false, written: false, excludeFile: excluded, entry, error: err.code || err.message };
  }
}

/** True when git would ignore `file` (relative to root). */
export function checkIgnore(root, file) {
  const res = gitRaw(root, ['check-ignore', '-q', '--', toPosix(file)]);
  return res.exit === 0;
}

/**
 * Check out `commitish` into a detached temp worktree. Repository hooks are disabled and
 * LFS smudging is skipped so a worktree never runs project code or touches the network.
 */
export function worktreeAdd(root, commitish, dir) {
  ensureDir(path.dirname(dir));
  if (fs.existsSync(dir)) worktreeRemove(root, dir);
  const noHooks = path.join(path.dirname(dir), 'no-hooks');
  const args = ['-c', `core.hooksPath=${toPosix(noHooks)}`];
  if (process.platform === 'win32') args.push('-c', 'core.longpaths=true');
  const res = gitRaw(root, [...args, 'worktree', 'add', '--detach', '--force', toPosix(dir), commitish],
    { env: { GIT_LFS_SKIP_SMUDGE: '1' }, timeoutMs: 600_000 });
  if (res.exit !== 0) {
    const msg = (res.stderr || '').trim();
    const longPath = /Filename too long|path too long/i.test(msg);
    throw unverifiable(longPath ? 'PATH_TOO_LONG' : 'WORKTREE_FAILED',
      longPath ? 'temp worktree path too long; enable `git config --global core.longpaths true`' : `git worktree add failed: ${msg.split('\n')[0]}`);
  }
  return dir;
}

export function worktreeRemove(root, dir) {
  gitRaw(root, ['worktree', 'remove', '--force', toPosix(dir)]);
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch {}
  gitRaw(root, ['worktree', 'prune']);
}

/** Files changed between two revisions plus their status, using rename detection. */
export function changedFiles(root, from, to) {
  return diffNameStatus(root, from, to);
}
