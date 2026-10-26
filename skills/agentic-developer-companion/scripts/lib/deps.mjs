// deps-check (plan §7.2, §9.1 step 9, Appendix A FM-04/FM-12): new and changed dependencies
// exist and are what they claim, offline-first (lockfile => cached registry metadata => the
// registry's own CLI), look-alike names, and lockfile consistency (static parsing plus the
// package managers' own frozen checks in a temp worktree of the snapshot).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { builtinModules } from 'node:module';
import {
  defineCommand, EXIT, runTool, which, sha256, asciiJson, toPosix, truncate, redactLiterals, IS_WINDOWS, tmpRoot,
  readText, nonce, stripBom, lastLine, liveSecrets, makeCheck, toolEnv,
} from './core.mjs';
import {
  emptyTree, diffNameStatus, diffLines, gitRaw, readBlobs, showFile, lsTree, worktreeAdd, worktreeRemove,
} from './git.mjs';
import { prepareTarget, snapshotExcludes } from './state.mjs';
import { parseToml, parseIni, parseJsonc } from './formats.mjs';
import { classifyPath, redactSecrets, LOCKFILE_MANAGERS } from './markers.mjs';

const MAX_LOOKUPS = 25;
const TOOL_TIMEOUT_MS = 120_000;
const LOOKUP_TIMEOUT_MS = 30_000;
const MAX_BLOB_BYTES = 64 * 1024 * 1024;

/** Strict JSON (npm rejects comments in package.json), BOM tolerated; null when it does not parse. */
const json = (text) => { try { return JSON.parse(stripBom(String(text))); } catch { return null; } };
const toml = (text) => parseToml(text, { lenient: true }).value;
const lastUseful = (s) => truncate(lastLine(s), 200);
const NON_REGISTRY = new Set(['local', 'git', 'url']);


// ---------------------------------------------------------------------------
// Blob reads

/**
 * Cached text of `<rev>:<file>` blobs; null for a missing, binary (NUL) or oversized blob.
 * `prefetch([[rev, file], ...])` loads many in two git processes (`cat-file --batch-check` for the
 * sizes, `--batch` for the contents) instead of one `git cat-file blob` per file and side.
 */
export function blobReader(root, { maxBytes = MAX_BLOB_BYTES } = {}) {
  const cache = new Map();
  const specOf = (rev, file) => `${rev}:${toPosix(file)}`;
  const tooBig = (text) => text.length > maxBytes || text.includes('\u0000');
  function prefetch(pairs) {
    const want = [...new Set(pairs.filter(([, f]) => f && !/[\r\n]/.test(f)).map(([rev, f]) => specOf(rev, f)))]
      .filter((s) => !cache.has(s));
    if (want.length < 2) return;
    try {
      const res = gitRaw(root, ['cat-file', '--batch-check'], { input: `${want.join('\n')}\n` });
      const lines = res.stdout.split('\n');
      if (res.exit !== 0 || lines.length < want.length) return;
      const small = [];
      want.forEach((s, i) => {
        const m = /^([0-9a-f]+) (\w+) (\d+)\r?$/.exec(lines[i]);
        if (!m) return; // missing or unexpected: read() asks git for this one
        if (m[2] !== 'blob' || Number(m[3]) > maxBytes) cache.set(s, null);
        else small.push([s, m[1]]);
      });
      const blobs = readBlobs(root, small.map(([, sha]) => sha));
      for (const [s, sha] of small) {
        const buf = blobs.get(sha);
        if (buf) cache.set(s, buf.includes(0) ? null : buf.toString('utf8'));
      }
    } catch {
      // Batching is an optimization: read() falls back to one process per blob.
    }
  }
  function read(rev, file) {
    if (!file) return null;
    const s = specOf(rev, file);
    if (!cache.has(s)) {
      const text = showFile(root, rev, file);
      cache.set(s, text == null || tooBig(text) ? null : text);
    }
    return cache.get(s);
  }
  return { read, prefetch };
}

// ---------------------------------------------------------------------------
// Names

export const normPypi = (n) => String(n).toLowerCase().replace(/[-_.]+/g, '-');
const CASE_INSENSITIVE = new Set(['nuget', 'go', 'npm', 'maven', 'composer']);
/** Canonical comparison key for a dependency name in its ecosystem. */
export function normName(ecosystem, name) {
  const n = String(name || '').trim();
  if (ecosystem === 'pypi') return normPypi(n);
  if (ecosystem === 'crates') return n.toLowerCase().replace(/_/g, '-');
  return CASE_INSENSITIVE.has(ecosystem) ? n.toLowerCase() : n;
}

/**
 * Names handed to a cache path or a registry CLI come from an untrusted manifest: no leading `-`
 * (it would be read as an option), no `..` segment, no shell or path metacharacters.
 */
const SAFE_NAME = /^(?!(?:.*\/)?\.\.?(?:\/|$))[A-Za-z0-9@_][\w.@/~+-]{0,213}$/;

// ---------------------------------------------------------------------------
// Manifests

/** Kind of an npm dependency spec: registry | local | workspace | git | url | alias. */
export function npmSpecKind(spec) {
  const s = String(spec ?? '').trim();
  if (/^(?:file|link|portal):/.test(s) || /^(?:\.{1,2}\/|\/|~\/)/.test(s)) return 'local';
  if (/^workspace:/.test(s)) return 'workspace';
  if (/^npm:/.test(s)) return 'alias';
  if (/^(?:git\+|git:|github:|gitlab:|bitbucket:|gist:)/.test(s) || /^[\w.-]+\/[\w.-]+(?:#.*)?$/.test(s)) return 'git';
  return /^https?:/.test(s) ? 'url' : 'registry';
}

function pep508(req) {
  const m = /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)\s*(\[[^\]]*\])?\s*(.*)$/.exec(String(req ?? '').trim());
  if (!m) return null;
  const rest = m[3].split(';')[0].trim();
  const url = rest.startsWith('@') ? rest.slice(1).trim() : null;
  const kind = url == null ? 'registry' : /^git\+/.test(url) ? 'git' : /^file:/.test(url) ? 'local' : 'url';
  return { name: m[1], spec: rest || '*', kind };
}

const NPM_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const CARGO_SECTIONS = ['dependencies', 'dev-dependencies', 'build-dependencies'];
const sourceKind = (v) => (v.path ? 'local' : v.git ? 'git' : v.url || v.file ? 'url' : 'registry');
const urlKind = (s) => (/^git\+/.test(s) ? 'git' : /^https?:/.test(s) ? 'url' : 'local');
const REQUIREMENTS = /^requirements(?:[-_.][\w.-]+)?\.(?:txt|in)$/;
// A requirements line that names a URL, a path or an archive instead of a registry requirement.
const DIRECT_REFERENCE = /^(?:https?|file|git\+\w+):|^\.{0,2}\/|\.(?:whl|tar\.gz|zip)$/;
const GRADLE_CONFS = ['implementation', 'api', 'compileOnly', 'runtimeOnly', 'testImplementation', 'testRuntimeOnly',
  'testCompileOnly', 'annotationProcessor', 'kapt', 'ksp', 'developmentOnly', 'compile', 'testCompile',
  'androidTestImplementation', 'debugImplementation'];
const GRADLE_DEP = new RegExp(String.raw`\b(${GRADLE_CONFS.join('|')})\s*\(?\s*(?:platform\s*\(\s*)?` +
  String.raw`["']([^"':\s]+):([^"':\s]+)(?::([^"'\s]+))?["']`, 'g');
const GEM_DEP = new RegExp(String.raw`^\s*(?:gem|spec\.add_(?:development_|runtime_)?dependency|` +
  String.raw`s\.add_(?:development_|runtime_)?dependency)\s*\(?\s*["']([^"']+)["']([^\n]*)$`, 'gm');
const NUGET_REF = /<(PackageReference|PackageVersion|GlobalPackageReference)\b([^>]*?)(\/>|>([\s\S]*?)<\/\1>)/g;

/**
 * Parse a manifest. Returns { ecosystem, deps: [{ name, spec, section, kind, real? }],
 * packageName?, workspaces?, replaces? } or null for an unsupported or unreadable file.
 */
export function parseManifest(file, text) {
  if (text == null) return null;
  text = stripBom(String(text));
  const base = path.posix.basename(toPosix(file)).toLowerCase();
  const deps = [];
  const add = (name, spec, section, kind = 'registry', extra = {}) => {
    if (name) deps.push({ name: String(name), spec: spec == null ? '*' : String(spec), section, kind, ...extra });
  };
  const addReq = (req, section) => { const d = pep508(req); if (d) add(d.name, d.spec, section, d.kind); };
  if (base === 'package.json') {
    const j = json(text);
    if (!j || typeof j !== 'object') return null;
    for (const sec of NPM_SECTIONS) {
      for (const [n, spec] of Object.entries(j[sec] || {})) {
        const kind = npmSpecKind(spec);
        const real = kind === 'alias' ? /^npm:((?:@[^/@]+\/)?[^@]+)/.exec(String(spec))?.[1] : undefined;
        add(n, spec, sec, kind, real ? { real } : {});
      }
    }
    const ws = Array.isArray(j.workspaces) ? j.workspaces
      : Array.isArray(j.workspaces?.packages) ? j.workspaces.packages : [];
    return { ecosystem: 'npm', deps, packageName: typeof j.name === 'string' ? j.name : null, workspaces: ws };
  }
  if (base === 'composer.json') {
    const j = json(text);
    if (!j) return null;
    const platform = /^(?:php|ext-.*|lib-.*|composer(?:-plugin)?-api|composer-runtime-api|hhvm)$/i;
    for (const sec of ['require', 'require-dev']) {
      for (const [n, spec] of Object.entries(j[sec] || {})) if (!platform.test(n)) add(n, spec, sec);
    }
    return { ecosystem: 'composer', deps, packageName: j.name || null };
  }
  if (base === 'pyproject.toml') {
    const t = toml(text);
    const sources = t.tool?.uv?.sources || {};
    const srcKind = (n) => {
      const s = sources[n] || sources[normPypi(n)];
      if (!s || typeof s !== 'object') return null;
      return s.workspace ? 'workspace' : s.path ? 'local' : s.git ? 'git' : s.url ? 'url' : null;
    };
    const fromList = (list, section) => {
      for (const r of Array.isArray(list) ? list : []) {
        const d = typeof r === 'string' ? pep508(r) : null;
        if (d) add(d.name, d.spec, section, srcKind(d.name) || d.kind);
      }
    };
    fromList(t.project?.dependencies, 'project');
    for (const [g, list] of Object.entries(t.project?.['optional-dependencies'] || {})) fromList(list, `optional:${g}`);
    for (const [g, list] of Object.entries(t['dependency-groups'] || {})) fromList(list, `group:${g}`);
    fromList(t.tool?.uv?.['dev-dependencies'], 'uv-dev');
    for (const [g, list] of Object.entries(t.tool?.pdm?.['dev-dependencies'] || {})) fromList(list, `pdm-dev:${g}`);
    const poetry = t.tool?.poetry || {};
    const poetryTable = (tbl, section) => {
      for (const [n, v] of Object.entries(tbl || {})) {
        if (n.toLowerCase() === 'python') continue;
        const obj = v && typeof v === 'object' && !Array.isArray(v);
        const spec = obj ? v.version || v.path || v.git || v.url || '*' : v;
        add(n, Array.isArray(spec) ? '*' : spec, section, obj ? sourceKind({ ...v, file: null }) : 'registry');
      }
    };
    poetryTable(poetry.dependencies, 'poetry');
    poetryTable(poetry['dev-dependencies'], 'poetry-dev');
    for (const [g, grp] of Object.entries(poetry.group || {})) poetryTable(grp?.dependencies, `poetry-group:${g}`);
    return { ecosystem: 'pypi', deps, packageName: t.project?.name || poetry.name || null };
  }
  if (base === 'pipfile') {
    const t = toml(text);
    for (const sec of ['packages', 'dev-packages']) {
      for (const [n, v] of Object.entries(t[sec] || {})) {
        if (v && typeof v === 'object') add(n, v.version || '*', sec, sourceKind({ ...v, url: null }));
        else add(n, v, sec);
      }
    }
    return { ecosystem: 'pypi', deps };
  }
  if (REQUIREMENTS.test(base) || base === 'constraints.txt') {
    for (const rawLine of text.replace(/\\\r?\n/g, ' ').split(/\r?\n/)) {
      const line = rawLine.replace(/(?:^|\s)#.*$/, '').trim();
      const edit = /^(?:-e|--editable)\s+(\S+)/.exec(line);
      if (!line || (line.startsWith('-') && !edit)) continue;
      if (edit) {
        const egg = /#egg=([\w.-]+)/.exec(edit[1])?.[1]
          || path.posix.basename(edit[1].replace(/[#?].*$/, '').replace(/\.git$/, ''));
        add(egg, edit[1], 'requirements', urlKind(edit[1]));
      } else if (DIRECT_REFERENCE.test(line)) {
        const name = /#egg=([\w.-]+)/.exec(line)?.[1] || path.posix.basename(line).replace(/[-_]\d.*$/, '');
        add(name, line, 'requirements', urlKind(line));
      } else addReq(line.replace(/\s+--hash[= ]\S+/g, ''), 'requirements');
    }
    return { ecosystem: 'pypi', deps };
  }
  if (base === 'setup.cfg') {
    const reqs = String(parseIni(text).options?.install_requires ?? '');
    for (const l of reqs.split('\n')) addReq(l.replace(/#.*$/, ''), 'install_requires');
    return { ecosystem: 'pypi', deps };
  }
  if (base === 'setup.py') {
    const m = /install_requires\s*=\s*\[([\s\S]*?)\]/.exec(text);
    for (const s of m ? m[1].matchAll(/["']([^"']+)["']/g) : []) addReq(s[1], 'install_requires');
    return { ecosystem: 'pypi', deps };
  }
  if (base === 'go.mod') {
    const replaces = [];
    let block = null;
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.replace(/\/\/(?!\s*indirect).*$/, '').trim();
      const open = /^(require|replace|exclude|retract)\s*\($/.exec(line);
      if (open || line === ')') { block = open ? open[1] : null; continue; }
      const single = !block && /^(require|replace|exclude|retract)\s+(.+)$/.exec(line);
      const [kw, body] = single ? [single[1], single[2]] : [block, line];
      const m = kw === 'require' ? /^(\S+)\s+(\S+)(\s*\/\/\s*indirect)?/.exec(body)
        : kw === 'replace' ? /^(\S+)(?:\s+(\S+))?\s*=>\s*(\S+)(?:\s+(\S+))?/.exec(body) : null;
      if (m && kw === 'require') add(m[1], m[2], m[3] ? 'require-indirect' : 'require');
      if (m && kw === 'replace') {
        replaces.push({ from: m[1], fromVersion: m[2] || null, to: m[3], toVersion: m[4] || null,
          local: /^(?:\.{1,2}[\\/]|\/|[A-Za-z]:[\\/])/.test(m[3]) });
      }
    }
    return { ecosystem: 'go', deps, packageName: /^\s*module\s+(\S+)/m.exec(text)?.[1] || null, replaces };
  }
  if (base === 'cargo.toml') {
    const t = toml(text);
    const table = (tbl, section) => {
      for (const [n, v] of Object.entries(tbl || {})) {
        if (!v || typeof v !== 'object') { add(n, v, section); continue; }
        const kind = v.path ? 'local' : v.git ? 'git' : v.workspace ? 'workspace' : 'registry';
        const spec = v.version || v.path || v.git || (v.workspace ? 'workspace' : '*');
        add(n, spec, section, kind, v.package ? { real: v.package } : {});
      }
    };
    for (const sec of CARGO_SECTIONS) table(t[sec], sec);
    for (const [tgt, body] of Object.entries(t.target || {})) {
      for (const sec of CARGO_SECTIONS) table(body?.[sec], `target.${tgt}.${sec}`);
    }
    table(t.workspace?.dependencies, 'workspace.dependencies');
    return { ecosystem: 'crates', deps, packageName: t.package?.name || null };
  }
  if (base === 'gemfile' || base.endsWith('.gemspec')) {
    for (const [, name, rest] of text.matchAll(GEM_DEP)) {
      const kind = /\bpath\s*:|:path\s*=>/.test(rest) ? 'local'
        : /\b(?:git|github|gitlab|bitbucket)\s*:|:git\s*=>/.test(rest) ? 'git' : 'registry';
      add(name, /,\s*["']([^"']+)["']/.exec(rest)?.[1] || '*', base === 'gemfile' ? 'gem' : 'gemspec', kind);
    }
    return { ecosystem: 'rubygems', deps };
  }
  if (/\.(?:cs|fs|vb)proj$/.test(base) || base === 'directory.packages.props' || base === 'directory.build.props') {
    for (const m of text.matchAll(NUGET_REF)) {
      const version = /\bVersion\s*=\s*"([^"]+)"/.exec(m[2])?.[1]
        || /<Version>([^<]+)<\/Version>/.exec(m[4] || '')?.[1];
      add(/\b(?:Include|Update)\s*=\s*"([^"]+)"/.exec(m[2])?.[1], version || '*', m[1]);
    }
    return { ecosystem: 'nuget', deps };
  }
  if (base === 'packages.config') {
    for (const m of text.matchAll(/<package\s+[^>]*\bid\s*=\s*"([^"]+)"[^>]*?(?:\bversion\s*=\s*"([^"]+)")?/g)) {
      add(m[1], m[2] || '*', 'packages.config');
    }
    return { ecosystem: 'nuget', deps };
  }
  if (base === 'pom.xml') {
    for (const [, body] of text.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
      const tag = (t) => new RegExp(`<${t}>\\s*([^<\\s]+)\\s*</${t}>`).exec(body)?.[1];
      const scope = tag('scope') || 'compile';
      if (tag('groupId') && tag('artifactId')) {
        const kind = scope === 'system' ? 'local' : 'registry';
        add(`${tag('groupId')}:${tag('artifactId')}`, tag('version') || '*', scope, kind);
      }
    }
    return { ecosystem: 'maven', deps };
  }
  if (base === 'build.gradle' || base === 'build.gradle.kts') {
    for (const m of text.matchAll(GRADLE_DEP)) add(`${m[2]}:${m[3]}`, m[4] || '*', m[1]);
    return { ecosystem: 'maven', deps };
  }
  return null;
}

const MANIFEST_BASE = new RegExp(String.raw`^(?:package\.json|composer\.json|pyproject\.toml|pipfile|setup\.cfg|` +
  String.raw`setup\.py|go\.mod|cargo\.toml|gemfile|pom\.xml|build\.gradle(?:\.kts)?|packages\.config|` +
  String.raw`directory\.packages\.props|constraints\.txt|.+\.(?:cs|fs|vb)proj|.+\.gemspec)$`);

/** Does this path name a manifest parseManifest understands? */
export function isParsableManifest(file) {
  const base = path.posix.basename(toPosix(file)).toLowerCase();
  return MANIFEST_BASE.test(base) || REQUIREMENTS.test(base);
}

/**
 * Compare two parsed manifests: { added[], removed[], changed[{dep, old}], redirected[] }.
 * Keys are section + name; a dependency that only moves between sections is not new.
 */
export function manifestDelta(before, after) {
  const eco = (after || before)?.ecosystem;
  const key = (d) => normName(eco, d.name);
  const a = new Map((before?.deps || []).map((d) => [`${d.section}\u0000${key(d)}`, d]));
  const b = new Map((after?.deps || []).map((d) => [`${d.section}\u0000${key(d)}`, d]));
  const out = { added: [], removed: [], changed: [], redirected: [] };
  const firstBefore = new Map();
  for (const d of a.values()) if (!firstBefore.has(key(d))) firstBefore.set(key(d), d);
  const namesAfter = new Set([...b.values()].map(key));
  for (const [k, d] of b) {
    const old = a.get(k) || firstBefore.get(key(d));
    if (!old) { out.added.push(d); continue; }
    if (old.spec !== d.spec) out.changed.push({ dep: d, old });
    const respecified = a.has(k) ? old.spec !== d.spec : true;
    if (respecified && old.kind === 'registry' && NON_REGISTRY.has(d.kind)) out.redirected.push({ dep: d, old });
  }
  for (const [k, d] of a) if (!b.has(k) && !namesAfter.has(key(d))) out.removed.push(d);
  return out;
}

// ---------------------------------------------------------------------------
// Lockfiles

// [manifest base name, lockfile names (or a function of the manifest name), look in parent dirs]
const LOCKS_FOR = [
  [/^package\.json$/, ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock',
    'bun.lockb'], true],
  [/^pyproject\.toml$/, ['uv.lock', 'poetry.lock', 'pdm.lock'], true],
  [/^pipfile$/, ['Pipfile.lock']], [/^go\.mod$/, ['go.sum']], [/^cargo\.toml$/, ['Cargo.lock'], true],
  [/^gemfile$/, ['Gemfile.lock']], [/^composer\.json$/, ['composer.lock']],
  [/\.(?:cs|fs|vb)proj$/, ['packages.lock.json']], [/^build\.gradle(?:\.kts)?$/, ['gradle.lockfile']],
  [/^requirements(?:[-_.][\w.-]+)?\.in$/, (b) => [b.replace(/\.in$/, '.txt')]],
];

/** The lockfile that governs `manifest` in a tree (Set of POSIX paths), or null. Some managers look in parent dirs. */
export function lockFor(manifest, treeFiles) {
  const p = toPosix(manifest);
  const baseName = path.posix.basename(p);
  const rule = LOCKS_FOR.find(([re]) => re.test(baseName.toLowerCase()));
  if (!rule) return null;
  const names = typeof rule[1] === 'function' ? rule[1](baseName) : rule[1];
  for (let dir = path.posix.dirname(p); ; dir = path.posix.dirname(dir)) {
    const hit = names.map((n) => (dir === '.' ? n : `${dir}/${n}`)).find((c) => treeFiles.has(c));
    if (hit) return hit;
    if (!rule[2] || dir === '.' || dir === '') return null;
  }
}

/** Modules a parsed go.mod requires that need go.sum entries (local `replace` targets need none). */
export function goSumNeeded(parsed) {
  if (parsed?.ecosystem !== 'go') return [];
  const local = new Set((parsed.replaces || []).filter((r) => r.local).map((r) => r.from));
  return parsed.deps.filter((d) => !local.has(d.name));
}

const LOCK_ECOSYSTEM = {
  npm: 'npm', pnpm: 'npm', yarn: 'npm', bun: 'npm', uv: 'pypi', poetry: 'pypi', pdm: 'pypi', pipenv: 'pypi',
  'pip-tools': 'pypi', go: 'go', cargo: 'crates', bundler: 'rubygems', composer: 'composer', nuget: 'nuget',
  gradle: 'maven',
};

/** Manager that owns a lockfile this module can read, or null. */
export function lockManager(lock) {
  const b = path.posix.basename(toPosix(lock)).toLowerCase();
  const m = LOCKFILE_MANAGERS[b] || (/^requirements.*\.txt$/.test(b) ? 'pip-tools' : null);
  return m in LOCK_ECOSYSTEM ? m : null;
}

const linesMatching = (lines, re) => lines.map((l) => re.exec(l)).filter(Boolean);

/**
 * Index a lockfile: { manager, ok, names: Map(norm -> [{ version, resolved, ... }]), root: { name -> spec } | null
 * (direct dependencies recorded by npm/pnpm/bun/bundler), importers (pnpm), versions: Set('name@ver') }.
 */
export function lockIndex(lock, text) {
  const manager = lockManager(lock);
  const idx = { manager, ok: text != null, names: new Map(), root: null, importers: null, versions: new Set() };
  if (text == null) return idx;
  text = stripBom(String(text));
  const eco = LOCK_ECOSYSTEM[manager];
  const put = (name, info = {}) => {
    if (!name) return;
    const k = normName(eco, name);
    if (!idx.names.has(k)) idx.names.set(k, []);
    idx.names.get(k).push(info);
    if (info.version) idx.versions.add(`${k}@${info.version}`);
  };
  const lines = text.split(/\r?\n/);
  const needJson = ['npm', 'pipenv', 'composer', 'nuget'].includes(manager);
  const j = needJson ? json(text) : manager === 'bun' ? parseJsonc(text) : null;
  if ((needJson || manager === 'bun') && !j) return { ...idx, ok: false };
  try {
    if (manager === 'npm' && j.packages) {
      for (const [k, v] of Object.entries(j.packages)) {
        if (k === '') idx.root = rootDeps(v);
        else {
          const name = v.name || k.slice(k.lastIndexOf('node_modules/') + 13);
          put(name, { version: v.version, resolved: v.resolved, link: Boolean(v.link) });
        }
      }
    } else if (manager === 'npm') {
      const walk = (deps) => {
        for (const [n, v] of Object.entries(deps || {})) {
          put(n, { version: v.version, resolved: v.resolved });
          walk(v.dependencies);
        }
      };
      walk(j.dependencies);
    } else if (manager === 'bun') {
      idx.root = rootDeps(j.workspaces?.[''] || {});
      for (const [n, v] of Object.entries(j.packages || {})) {
        const ident = Array.isArray(v) ? String(v[0]) : '';
        put(n, { version: /@([^@]+)$/.exec(ident)?.[1], resolved: ident });
      }
    } else if (manager === 'pnpm') {
      parsePnpmLock(lines, idx, put);
    } else if (manager === 'yarn') {
      for (const line of lines) {
        if (!line || /^[ #]|^__metadata/.test(line) || !line.endsWith(':')) continue;
        for (const raw of line.slice(0, -1).split(/,\s*/)) {
          const m = /^((?:@[^@/]+\/)?[^@]+)@(.*)$/.exec(raw.trim().replace(/^"|"$/g, ''));
          if (!m) continue;
          const list = idx.names.get(normName('npm', m[1]));
          const specs = list?.[0]?.specs || new Set();
          specs.add(m[2].replace(/^npm:/, ''));
          if (!list) put(m[1], { specs });
        }
      }
    } else if (['cargo', 'uv', 'poetry', 'pdm'].includes(manager)) {
      const pkgs = toml(text).package;
      for (const p of Array.isArray(pkgs) ? pkgs : []) {
        const resolved = typeof p.source === 'string' ? p.source : p.source ? JSON.stringify(p.source) : null;
        put(p.name, { version: p.version, resolved });
      }
    } else if (manager === 'pipenv') {
      for (const sec of ['default', 'develop']) {
        for (const [n, v] of Object.entries(j[sec] || {})) {
          put(n, { version: String(v?.version || '').replace(/^==/, '') });
        }
      }
    } else if (manager === 'composer') {
      for (const p of [...(j.packages || []), ...(j['packages-dev'] || [])]) put(p.name, { version: p.version });
    } else if (manager === 'go') {
      for (const m of linesMatching(lines, /^(\S+)\s+(v[^\s/]+)(\/go\.mod)?\s+h1:/)) put(m[1], { version: m[2] });
    } else if (manager === 'bundler') {
      let section = '';
      for (const line of lines) {
        if (/^[A-Z][A-Z ]*$/.test(line)) { section = line.trim(); continue; }
        const spec = /^ {4}([A-Za-z0-9_.-]+) \(([^)]+)\)$/.exec(line);
        if (spec) put(spec[1], { version: spec[2] });
        const d = section === 'DEPENDENCIES' && /^ {2}([A-Za-z0-9_.-]+)(!)?(?: \(([^)]+)\))?$/.exec(line);
        if (!d) continue;
        idx.root = { ...idx.root, [d[1]]: d[3] || '*' };
        if (!idx.names.has(normName('rubygems', d[1]))) put(d[1], { local: Boolean(d[2]) });
      }
    } else if (manager === 'nuget') {
      for (const tfm of Object.values(j.dependencies || {})) {
        for (const [n, v] of Object.entries(tfm || {})) put(n, { version: v?.resolved });
      }
    } else if (manager === 'gradle') {
      for (const m of linesMatching(lines, /^([^:#\s]+):([^:\s]+):([^=\s]+)=/)) {
        put(`${m[1]}:${m[2]}`, { version: m[3] });
      }
    } else if (manager === 'pip-tools') {
      for (const d of parseManifest('requirements.txt', text)?.deps || []) {
        put(d.name, { version: d.spec.replace(/^==/, '') });
      }
    }
  } catch {
    idx.ok = false;
  }
  return idx;
}

function rootDeps(entry) {
  return Object.fromEntries(NPM_SECTIONS.flatMap((sec) => Object.entries(entry?.[sec] || {})
    .map(([n, s]) => [n, String(s)])));
}

function parsePnpmLock(lines, idx, put) {
  const unq = (s) => s.trim().replace(/^['"]|['"]$/g, '');
  let top = null;
  let importer = null;
  let depSection = null;
  let depName = null;
  idx.importers = {};
  const v5Specifiers = {};
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) {
      top = /^importers:\s*\{\s*\}/.test(t) ? null : t.replace(/:.*$/, '');
      importer = depSection = depName = null;
    } else if (top === 'importers' && indent === 2) {
      importer = unq(t.replace(/:\s*(\{\s*\})?\s*$/, ''));
      idx.importers[importer] ||= {};
      depSection = depName = null;
    } else if (top === 'importers' && indent === 4 && importer != null) {
      depSection = /^(?:dependencies|devDependencies|optionalDependencies|peerDependencies):/.test(t) ? t : null;
      depName = null;
    } else if (top === 'importers' && indent === 6 && depSection) {
      const m = /^(.+?):\s*(.*)$/.exec(t);
      if (m) depName = unq(m[1]);
      if (m?.[2]) idx.importers[importer][depName] = unq(m[2]);
    } else if (top === 'importers' && indent === 8 && depName) {
      const m = /^specifier:\s*(.+)$/.exec(t);
      if (m) idx.importers[importer][depName] = unq(m[1]);
    } else if (top === 'specifiers' && indent === 2) {
      const m = /^(.+?):\s*(.+)$/.exec(t);
      if (m) v5Specifiers[unq(m[1])] = unq(m[2]);
    } else if ((top === 'packages' || top === 'snapshots') && indent === 2 && t.endsWith(':')) {
      const m = /^((?:@[^@/]+\/)?[^@/(]+)[@/]([^(@/]+)/.exec(unq(t.slice(0, -1)).replace(/^\//, ''));
      if (m) put(m[1], { version: m[2] });
    }
  }
  if (Object.keys(v5Specifiers).length && !Object.keys(idx.importers).length) idx.importers['.'] = v5Specifiers;
  idx.root = idx.importers['.'] || null;
  for (const imp of Object.values(idx.importers)) {
    for (const n of Object.keys(imp)) if (!idx.names.has(normName('npm', n))) put(n, {});
  }
}

/** Is `dep` (from a manifest in the lock's project) recorded in the lock? */
export function lockHas(idx, ecosystem, dep, { importer = '.' } = {}) {
  const k = normName(ecosystem, dep.real || dep.name);
  if (idx.manager === 'go') {
    return dep.spec && dep.spec !== '*' ? idx.versions.has(`${k}@${dep.spec}`) : idx.names.has(k);
  }
  if (idx.manager === 'yarn') {
    const specs = idx.names.get(k)?.[0].specs;
    const spec = String(dep.spec);
    return idx.names.has(k) && (!specs || specs.has(spec) || specs.has(spec.replace(/^npm:/, '')));
  }
  if (idx.manager === 'pnpm' && idx.importers?.[importer]) return dep.name in idx.importers[importer];
  return idx.names.has(k);
}

// ---------------------------------------------------------------------------
// Look-alike names (slopsquatting / typosquatting)

const POPULAR = {
  npm: `react react-dom lodash express axios chalk commander debug moment dayjs uuid typescript jest vitest mocha chai
sinon eslint prettier webpack vite rollup esbuild next vue svelte jquery underscore async request bluebird rxjs redux
react-redux react-router react-router-dom yargs minimist glob rimraf mkdirp fs-extra semver dotenv cors body-parser
cookie-parser mongoose mongodb mysql mysql2 pg sequelize prisma typeorm redis ioredis socket.io ws node-fetch
cross-env nodemon ts-node tslib zod joi yup ajv date-fns luxon ramda immer classnames clsx styled-components
tailwindcss postcss autoprefixer sass less handlebars ejs pug marked markdown-it highlight.js cheerio puppeteer
playwright cypress supertest nock msw jsonwebtoken bcrypt bcryptjs passport helmet morgan winston pino graphql
firebase stripe openai colors ora inquirer prompts execa shelljs cross-spawn chokidar got superagent qs query-string
validator nanoid immutable core-js regenerator-runtime left-pad is-number kind-of object-assign inherits safe-buffer
readable-stream string-width strip-ansi ansi-styles supports-color source-map acorn browserslist electron three d3
chart.js socket.io-client yaml js-yaml xml2js papaparse sharp multer formidable busboy koa fastify reflect-metadata
zustand mobx swr formik react-hook-form antd bootstrap lerna nx turbo husky lint-staged concurrently npm-run-all serve
http-server jsdom happy-dom enzyme karma jasmine ava tap c8 nyc web-vitals react-scripts gatsby nuxt astro solid-js
preact lit mustache sass-loader css-loader style-loader babel-loader ts-loader html-webpack-plugin terser uglify-js
cssnano p-limit p-queue lru-cache node-cache keyv json5 toml ini mime mime-types iconv-lite buffer events util
path-to-regexp cookie tough-cookie form-data abort-controller whatwg-fetch cross-fetch isomorphic-fetch undici tsx
ts-jest babel-jest proxyquire faker chance moment-timezone numeral big.js bignumber.js decimal.js crypto-js node-forge
jose dotenv-expand pnpm yarn npm bun deno @babel/core @babel/preset-env @types/node @types/react @types/jest
@prisma/client @playwright/test @testing-library/react @testing-library/jest-dom @angular/core @nestjs/core
@apollo/client @aws-sdk/client-s3 @emotion/react @mui/material @tanstack/react-query @faker-js/faker
@typescript-eslint/parser @typescript-eslint/eslint-plugin @anthropic-ai/sdk @octokit/rest`,
  pypi: `requests numpy pandas scipy matplotlib seaborn scikit-learn tensorflow torch keras flask django fastapi
uvicorn gunicorn pydantic sqlalchemy alembic psycopg2 psycopg2-binary pymysql redis celery boto3 botocore pyyaml toml
tomli click typer rich tqdm pytest pytest-cov pytest-mock pytest-asyncio pytest-xdist hypothesis mock coverage tox nox
black flake8 pylint mypy ruff isort pre-commit setuptools wheel pip virtualenv poetry httpx aiohttp urllib3 certifi
chardet charset-normalizer idna six python-dateutil pytz arrow pendulum jinja2 markupsafe werkzeug itsdangerous
beautifulsoup4 lxml html5lib selenium playwright scrapy pillow opencv-python imageio pyjwt cryptography bcrypt passlib
paramiko fabric invoke docker kubernetes google-cloud-storage google-api-python-client azure-storage-blob openai
anthropic langchain transformers datasets tokenizers sentencepiece nltk spacy gensim networkx sympy statsmodels
xgboost lightgbm catboost plotly dash streamlit gradio jupyter notebook ipython ipykernel jupyterlab pyarrow polars
dask numba cython attrs cattrs marshmallow jsonschema simplejson orjson ujson msgpack protobuf grpcio pyzmq websockets
websocket-client python-dotenv structlog loguru sentry-sdk prometheus-client pyparsing packaging filelock platformdirs
appdirs colorama termcolor tabulate openpyxl xlrd xlsxwriter python-docx pypdf pypdf2 reportlab markdown mistune
docutils sphinx mkdocs mkdocs-material faker factory-boy freezegun responses requests-mock vcrpy pytest-django
djangorestframework django-cors-headers channels graphene starlette sanic tornado twisted gevent eventlet greenlet
uvloop anyio trio tenacity backoff cachetools diskcache joblib psutil pywin32 pexpect watchdog schedule apscheduler
pika kafka-python confluent-kafka pymongo motor elasticsearch neo4j peewee asyncpg aiofiles httplib2 oauthlib
requests-oauthlib google-auth msal pyopenssl pycryptodome pynacl rsa pyasn1 setuptools-scm build twine hatchling flit
pdm uv pipenv pyinstaller cffi pybind11 typing-extensions mypy-extensions types-requests types-pyyaml colorlog
humanize python-slugify unidecode emoji regex`,
  crates: `serde serde_json serde_derive tokio rand clap anyhow thiserror log env_logger tracing tracing-subscriber
reqwest hyper axum actix-web rocket warp futures async-trait lazy_static once_cell regex chrono time uuid itertools
rayon crossbeam parking_lot bytes base64 hex sha2 md5 ring rustls openssl sqlx diesel rusqlite redis mongodb toml
serde_yaml csv url http tower tonic prost syn quote proc-macro2 libc winapi windows nix bitflags num num-traits
criterion proptest quickcheck mockall tempfile walkdir glob dirs indicatif colored termcolor crossterm ratatui image
wasm-bindgen structopt`,
  go: `github.com/stretchr/testify github.com/gin-gonic/gin github.com/gorilla/mux github.com/spf13/cobra
github.com/spf13/viper github.com/sirupsen/logrus go.uber.org/zap github.com/pkg/errors github.com/google/uuid
github.com/go-sql-driver/mysql github.com/lib/pq github.com/jackc/pgx/v5 gorm.io/gorm github.com/redis/go-redis/v9
github.com/labstack/echo/v4 github.com/gofiber/fiber/v2 google.golang.org/grpc google.golang.org/protobuf
github.com/golang/protobuf golang.org/x/sync golang.org/x/net golang.org/x/crypto golang.org/x/text golang.org/x/sys
github.com/prometheus/client_golang github.com/aws/aws-sdk-go-v2 github.com/aws/aws-sdk-go k8s.io/client-go
github.com/urfave/cli/v2 github.com/joho/godotenv github.com/golang-jwt/jwt/v5 github.com/go-chi/chi/v5
github.com/rs/zerolog github.com/mattn/go-sqlite3 github.com/gorilla/websocket github.com/google/go-cmp
github.com/onsi/ginkgo/v2 github.com/onsi/gomega github.com/golang/mock go.uber.org/mock github.com/BurntSushi/toml
gopkg.in/yaml.v3 github.com/mitchellh/mapstructure github.com/fatih/color`,
  rubygems: `rails rake rspec rspec-rails minitest puma sidekiq devise nokogiri pg mysql2 sqlite3 redis rack sinatra
json bundler rubocop pry byebug capybara selenium-webdriver factory_bot faker webmock vcr simplecov httparty faraday
aws-sdk-s3 jwt bcrypt activerecord activesupport thor dotenv rest-client sass jbuilder kaminari pundit cancancan`,
  nuget: `Newtonsoft.Json Serilog NUnit xunit xunit.runner.visualstudio Moq FluentAssertions AutoMapper Dapper
Microsoft.EntityFrameworkCore Microsoft.Extensions.DependencyInjection Microsoft.Extensions.Logging
Microsoft.NET.Test.Sdk MSTest.TestFramework MSTest.TestAdapter Polly MediatR FluentValidation Swashbuckle.AspNetCore
StackExchange.Redis Npgsql coverlet.collector NSubstitute Bogus RestSharp Humanizer CsvHelper Castle.Core
System.Text.Json Azure.Storage.Blobs AWSSDK.S3`,
  maven: `org.junit.jupiter:junit-jupiter junit:junit org.mockito:mockito-core org.slf4j:slf4j-api
ch.qos.logback:logback-classic com.google.guava:guava org.apache.commons:commons-lang3
com.fasterxml.jackson.core:jackson-databind org.springframework.boot:spring-boot-starter-web org.projectlombok:lombok
org.assertj:assertj-core`,
  composer: `laravel/framework symfony/console guzzlehttp/guzzle monolog/monolog phpunit/phpunit doctrine/orm
vlucas/phpdotenv`,
};
const popularCache = new Map();
const popularSet = (eco) => {
  if (!popularCache.has(eco)) {
    popularCache.set(eco, new Set((POPULAR[eco] || '').split(/\s+/).filter(Boolean).map((n) => normName(eco, n))));
  }
  return popularCache.get(eco);
};

/** Optimal-string-alignment distance (transpositions count 1), capped at `max + 1`. */
export function editDistance(a, b, max = 3) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
      rowMin = Math.min(rowMin, d[i][j]);
    }
    if (rowMin > max) return max + 1;
  }
  return d[a.length][b.length];
}

const HOMOGLYPH = (s) => s.replace(/rn/g, 'm').replace(/vv/g, 'w').replace(/0/g, 'o').replace(/1/g, 'l')
  .replace(/5/g, 's').replace(/3/g, 'e');
const AFFIXES = ['-js', '.js', 'js-', 'node-', '-node', 'py-', 'python-', '-python', '-py', '-official', '-lib',
  '-dev'];
const unseparated = (s) => s.replace(/[-_.]/g, '');

/** The popular (or sibling) package a new name imitates, or null. */
export function lookalikeOf(ecosystem, name, siblings = []) {
  const n = normName(ecosystem, name);
  const popular = popularSet(ecosystem);
  if (popular.has(n)) return null;
  const bare = unseparated(n);
  const glyphs = HOMOGLYPH(n);
  for (const p of [...popular, ...siblings.map((s) => normName(ecosystem, s)).filter((s) => s && s !== n)]) {
    const d = editDistance(n, p, 2);
    const minLen = Math.min(n.length, p.length);
    if ((d === 1 && minLen >= 5) || (d === 2 && minLen >= 12) || (bare === unseparated(p) && n !== p) || glyphs === p) {
      return p;
    }
    if (p.length >= 4 && AFFIXES.some((a) => (/^[-.]/.test(a) ? n === p + a : n === a + p))) return p;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Existence: local caches, then the registry's CLI

const home = () => os.homedir();
const listDir = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir) : []);

function npmRegistries(root, env, { scoped = false } = {}) {
  const regs = env.npm_config_registry ? [env.npm_config_registry] : [];
  for (const rc of [root && path.join(root, '.npmrc'), path.join(home(), '.npmrc')]) {
    const text = rc ? readText(rc) : null;
    const m = text && /^\s*registry\s*=\s*(\S+)/m.exec(text);
    if (m) regs.push(m[1]);
    if (scoped && text) for (const s of text.matchAll(/^\s*@[\w.-]+:registry\s*=\s*(\S+)/gm)) regs.push(s[1]);
  }
  regs.push('https://registry.npmjs.org/');
  return [...new Set(regs.map((r) => (r.endsWith('/') ? r : `${r}/`)))];
}

/** Hosts npm is configured to install from (default, project and user .npmrc, scoped registries). */
export function npmRegistryHosts(root, env = process.env) {
  const hosts = new Set(['registry.npmjs.org', 'registry.yarnpkg.com']);
  for (const r of npmRegistries(root, env, { scoped: true })) {
    try { hosts.add(new URL(r).host); } catch { /* not a URL */ }
  }
  return hosts;
}

/** cacache keeps each key in index-v5/<sha256(key)> split 2/2/rest; an entry with integrity is a cached 200. */
function cacacheHas(cacheDir, key) {
  const h = sha256(key);
  const text = readText(path.join(cacheDir, '_cacache', 'index-v5', h.slice(0, 2), h.slice(2, 4), h.slice(4)));
  return Boolean(text) && text.split('\n').some((line) => {
    const entry = line.includes('\t') ? json(line.slice(line.indexOf('\t') + 1)) : null;
    return entry?.key === key && entry.integrity;
  });
}

const crateIndexPath = (n) => (n.length <= 2 ? [String(n.length), n]
  : n.length === 3 ? ['3', n[0], n] : [n.slice(0, 2), n.slice(2, 4), n]);
const localAppData = (env, ...sub) => (IS_WINDOWS && env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, ...sub) : null);

/** Evidence of existence in a local package-manager cache: { exists: true, source } or null. */
export function cacheLookup(ecosystem, name, { root = null, env = process.env } = {}) {
  if (!SAFE_NAME.test(name)) return null;
  try {
    if (ecosystem === 'npm') {
      // npm uses npm_config_cache when set and its platform default otherwise.
      const dir = env.npm_config_cache || localAppData(env, 'npm-cache') || path.join(home(), '.npm');
      const escaped = name.startsWith('@') ? name.replace('/', '%2f') : name;
      const key = (r) => `make-fetch-happen:request-cache:${r}${escaped}`;
      const reg = npmRegistries(root, env).find((r) => cacacheHas(dir, key(r)));
      if (reg) return { exists: true, source: 'cache:npm', detail: reg };
    } else if (ecosystem === 'go') {
      const gopath = (env.GOPATH || path.join(home(), 'go')).split(path.delimiter)[0];
      const modcache = env.GOMODCACHE || path.join(gopath, 'pkg', 'mod');
      const escaped = name.replace(/[A-Z]/g, (c) => `!${c.toLowerCase()}`);
      const versions = listDir(path.join(modcache, 'cache', 'download', ...escaped.split('/'), '@v'));
      if (versions.some((f) => /\.(?:info|mod|zip)$/.test(f))) return { exists: true, source: 'cache:go' };
    } else if (ecosystem === 'crates') {
      const indexRoot = path.join(env.CARGO_HOME || path.join(home(), '.cargo'), 'registry', 'index');
      const lower = name.toLowerCase();
      const parts = [crateIndexPath(lower.replace(/_/g, '-')), crateIndexPath(lower.replace(/-/g, '_'))];
      for (const reg of listDir(indexRoot)) {
        const hit = parts.some((p) => fs.existsSync(path.join(indexRoot, reg, '.cache', ...p))
          || fs.existsSync(path.join(indexRoot, reg, ...p)));
        if (hit) return { exists: true, source: 'cache:cargo' };
      }
    } else if (ecosystem === 'pypi') {
      const cacheRoot = env.UV_CACHE_DIR || localAppData(env, 'uv', 'cache')
        || path.join(env.XDG_CACHE_HOME || path.join(home(), '.cache'), 'uv');
      const file = `${normPypi(name)}.rkyv`;
      for (const simple of listDir(cacheRoot).filter((d) => /^simple-v\d+$/.test(d))) {
        const dir = path.join(cacheRoot, simple);
        if (listDir(dir).some((index) => fs.existsSync(path.join(dir, index, file)))) {
          return { exists: true, source: 'cache:uv' };
        }
      }
    }
  } catch {
    // An unreadable cache is no evidence either way.
  }
  return null;
}

const GO_NOT_FOUND = new RegExp(['not found', String.raw`\b404\b`, String.raw`\b410\b`, 'unrecognized import path',
  'no matching versions', 'repository not found', 'malformed module path', 'invalid version'].join('|'), 'i');

/**
 * Ask the ecosystem's own CLI: { exists: true|false|null, source, detail? }, or null when no tool exists.
 * Tools run without a shell (Windows `.cmd` shims through runTool), so a name is never shell text.
 */
export function registryLookup(ecosystem, name, {
  root = null, env = process.env, timeoutMs = LOOKUP_TIMEOUT_MS,
} = {}) {
  if (!SAFE_NAME.test(name)) {
    return { exists: null, source: 'unsafe-name', detail: 'not a package name a registry accepts' };
  }
  const opts = { cwd: root || os.tmpdir(), env: toolEnv(env), timeoutMs };
  const unknown = (source, text) => ({ exists: null, source, detail: lastUseful(text) });
  const tool = (exe) => which(exe, env);
  if (ecosystem === 'npm' && tool('npm')) {
    const r = runTool(tool('npm'), ['view', name, 'name', '--json'], opts);
    if (r.exit === 0 && r.stdout.trim()) return { exists: true, source: 'registry:npm' };
    if (/\bE404\b|404 Not Found|is not in this registry/i.test(r.stderr + r.stdout)) {
      return { exists: false, source: 'registry:npm' };
    }
    return unknown('registry:npm', r.stderr || r.error || r.stdout);
  }
  if (ecosystem === 'pypi') {
    if (tool('uv')) {
      // uv ignores pip's index setting: carry it over so lookups ask the same index pip would.
      const index = env.PIP_INDEX_URL && !env.UV_INDEX_URL ? { UV_INDEX_URL: env.PIP_INDEX_URL } : {};
      const uvEnv = { ...opts.env, ...index };
      const args = ['pip', 'compile', '--no-header', '--no-annotate', '--quiet', '-'];
      const r = runTool(tool('uv'), args, { ...opts, cwd: os.tmpdir(), env: uvEnv, input: `${name}\n` });
      if (r.exit === 0) return { exists: true, source: 'registry:uv' };
      if (/was not found in the package registry/i.test(r.stderr)) return { exists: false, source: 'registry:uv' };
      // Resolution failed for another reason (markers, Python version): the name exists.
      const offlineError = /network|connect|dns|timed out|offline/i.test(r.stderr);
      if (!offlineError && /no versions of|depends on|unsatisfiable/i.test(r.stderr)) {
        return { exists: true, source: 'registry:uv', detail: 'resolution failed for another reason' };
      }
    }
    const pip = tool('pip3') || tool('pip');
    if (!pip) return null;
    const r = runTool(pip, ['index', 'versions', name, '--disable-pip-version-check'], opts);
    // pip reports "No matching distribution" for missing names and for incompatible ones alike.
    return r.exit === 0 ? { exists: true, source: 'registry:pip' } : unknown('registry:pip', r.stderr);
  }
  if (ecosystem === 'crates' && tool('cargo')) {
    const r = runTool(tool('cargo'), ['info', name, '--quiet'], opts);
    if (r.exit === 0) return { exists: true, source: 'registry:cargo' };
    if (/could not find `[^`]+` in registry|no matching package named/i.test(r.stderr)) {
      return { exists: false, source: 'registry:cargo' };
    }
    return unknown('registry:cargo', r.stderr);
  }
  if (ecosystem === 'go' && tool('go')) {
    const goEnv = { ...opts.env, GOTOOLCHAIN: 'local', GOFLAGS: '-mod=mod', GO111MODULE: 'on' };
    const r = runTool(tool('go'), ['list', '-m', '-json', `${name}@latest`], { ...opts, cwd: os.tmpdir(), env: goEnv });
    if (r.exit === 0) return { exists: true, source: 'registry:go' };
    if (GO_NOT_FOUND.test(r.stderr)) return { exists: false, source: 'registry:go' };
    return unknown('registry:go', r.stderr);
  }
  if (ecosystem === 'rubygems' && tool('gem')) {
    const r = runTool(tool('gem'), ['search', '--remote', '--exact', name], opts);
    if (r.exit !== 0) return unknown('registry:gem', r.stderr);
    const prefix = `${name.toLowerCase()} (`;
    return { exists: r.stdout.split(/\r?\n/).some((l) => l.toLowerCase().startsWith(prefix)), source: 'registry:gem' };
  }
  if (ecosystem === 'nuget' && tool('dotnet')) {
    const r = runTool(tool('dotnet'), ['package', 'search', name, '--exact-match', '--format', 'json'], opts);
    const j = r.exit === 0 ? json(r.stdout) : null;
    if (Array.isArray(j?.searchResult)) {
      return { exists: j.searchResult.some((s) => (s.packages || []).length > 0), source: 'registry:dotnet' };
    }
    return unknown('registry:dotnet', r.stderr || r.stdout);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Imports that name packages the manifest does not declare (JS/TS and Go)

const NODE_BUILTINS = new Set(builtinModules.map((m) => m.replace(/^node:/, '').split('/')[0]));
const JS_IMPORT_RES = [
  /\bimport\s+(?:type\s+)?(?:[\w*{}\s,$]+?\s+from\s+)?['"]([^'"\n]+)['"]/g,
  /\bexport\s+(?:type\s+)?(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s+from\s+['"]([^'"\n]+)['"]/g,
  /\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  // The last line of a multi-line `import {\n a,\n} from 'pkg'`.
  /^\s*\}\s*from\s+['"]([^'"\n]+)['"]/g,
];
const NOT_A_PACKAGE = /^(?:\.|\/|#|~|@\/|\$|node:|bun:|deno:|virtual:|data:|https?:|npm:|jsr:|file:)|[?!]/;

/** Bare package name of a JS import specifier, or null for relative/builtin/aliased ones. */
export function jsPackageOf(spec) {
  const s = String(spec);
  if (!s || NOT_A_PACKAGE.test(s)) return null;
  const parts = s.split('/');
  const pkg = s.startsWith('@') ? (parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null) : parts[0];
  return pkg && !NODE_BUILTINS.has(pkg) ? pkg : null;
}

/** Go import paths in a file's text: [{ path, line }]. */
export function goImports(text) {
  const out = [];
  let inBlock = false;
  String(text ?? '').split(/\r?\n/).forEach((raw, i) => {
    const l = raw.replace(/\/\/.*$/, '').trim();
    if (inBlock && l.startsWith(')')) { inBlock = false; return; }
    if (!inBlock && /^import\s*\($/.test(l)) { inBlock = true; return; }
    const m = inBlock ? /^(?:[\w.]+\s+)?"([^"]+)"/.exec(l) : /^import\s+(?:[\w.]+\s+)?"([^"]+)"/.exec(l);
    if (m) out.push({ path: m[1], line: i + 1 });
  });
  return out;
}

// ---------------------------------------------------------------------------
// Lock consistency via the package managers (in a temp worktree)

const NPM_ENV = { npm_config_update_notifier: 'false' };

/** The manager's frozen-lockfile check: { exe, args, env } (exe resolved on PATH), or null when absent. */
function lockTool(manager, offline, env) {
  const exe = (name) => which(name, env);
  const off = (flag) => (offline ? [flag] : []);
  const npmMode = offline ? '--offline' : '--prefer-offline';
  switch (manager) {
    case 'npm': return exe('npm') && { exe: exe('npm'), name: 'npm', env: NPM_ENV,
      args: ['ci', '--dry-run', '--ignore-scripts', '--no-audit', '--no-fund', npmMode] };
    case 'pnpm': return exe('pnpm') && { exe: exe('pnpm'), name: 'pnpm', env: NPM_ENV,
      args: ['install', '--frozen-lockfile', '--lockfile-only', '--ignore-scripts', npmMode] };
    case 'uv': return exe('uv') && { exe: exe('uv'), name: 'uv', args: ['lock', '--check', ...off('--offline')] };
    case 'poetry': return exe('poetry') && { exe: exe('poetry'), name: 'poetry',
      args: ['check', '--lock', '--no-interaction'] };
    case 'go': return exe('go') && { exe: exe('go'), name: 'go', args: ['mod', 'tidy', '-diff'],
      env: { GOTOOLCHAIN: 'local', GOFLAGS: '-mod=mod', ...(offline ? { GOPROXY: 'off' } : {}) } };
    case 'cargo': return exe('cargo') && { exe: exe('cargo'), name: 'cargo',
      args: ['metadata', '--locked', '--format-version', '1', ...off('--offline')] };
    case 'nuget': return !offline && exe('dotnet') && { exe: exe('dotnet'), name: 'dotnet',
      args: ['restore', '--locked-mode'] };
    default: return null;
  }
}

const INCONSISTENT = [
  /can only install packages when your package\.json and package-lock\.json/i,
  /ERR_PNPM_OUTDATED_LOCKFILE|is not up to date with (?:<ROOT>[\\/])?package\.json/i,
  /specifiers in the lockfile don't match/i,
  /lockfile at `[^`]*` needs to be updated/i,
  /changed significantly since poetry\.lock was last generated|poetry\.lock is not consistent with pyproject\.toml/i,
  /because --locked was passed|lock file needs to be updated/i,
  /\bNU1004\b/,
  /^diff \S+\/go\.(?:mod|sum) /m,
  /updates to go\.(?:mod|sum) needed|missing go\.sum entry/i,
];
const UNKNOWN = new RegExp(['ENOTCACHED|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|network (?:was )?disabled',
  'GOPROXY=off|dial tcp',
  'no such host|offline mode|unable to (?:get|fetch)|Could not resolve host|failed to (?:download|fetch|get)',
  'requires go >=|flag provided but not defined|unexpected argument|unrecognized|timed? ?out'].join('|'), 'i');
const DETAIL_LINE = /missing|invalid|needs to be updated|not up to date|don't match|in sync|NU1004|^[-+]\s*\S|^diff /i;

/**
 * Run one manager's frozen-lockfile check in `dir`:
 * { tool, cmd, exit, status, ms, timed_out, detail, output_sha256 }.
 */
export function runLockTool(manager, dir, {
  offline = false, env = process.env, timeoutMs = TOOL_TIMEOUT_MS, secrets = [],
} = {}) {
  const tool = lockTool(manager, offline, env);
  if (!tool) return { tool: manager, cmd: null, exit: null, status: 'unknown', detail: 'tool not available', ms: 0 };
  const res = runTool(tool.exe, tool.args, { cwd: dir, env: { ...toolEnv(env), ...(tool.env || {}) }, timeoutMs });
  const output = redactLiterals(redactSecrets(`${res.stdout}\n${res.stderr}`), secrets);
  let status = res.exit === 0 ? 'consistent' : INCONSISTENT.some((re) => re.test(output)) ? 'inconsistent' : 'unknown';
  if (status === 'inconsistent' && manager === 'go' && UNKNOWN.test(res.stderr) && !/^diff /m.test(res.stdout)) {
    status = 'unknown';
  }
  const detailLines = output.split(/\r?\n/).filter((l) => DETAIL_LINE.test(l));
  const detail = detailLines.length ? detailLines.slice(0, 6).join(' | ')
    : lastUseful(output) || String(res.error || '');
  return {
    tool: manager, cmd: [tool.name, ...tool.args].join(' '), exit: res.exit, status, ms: res.ms,
    timed_out: res.timedOut, detail: truncate(detail, 500), output_sha256: sha256(output),
  };
}

// ---------------------------------------------------------------------------
// The check

/** Offline by default inside the Codex sandbox (network is off there) or when ADC_OFFLINE is set. */
export function defaultOffline(env = process.env) {
  if (env.ADC_OFFLINE && env.ADC_OFFLINE !== '0' && env.ADC_OFFLINE !== 'false') return true;
  return Object.keys(env).some((k) => k.startsWith('CODEX_SANDBOX'));
}

const relDir = (from, to) => path.posix.relative(from === '.' ? '' : from, to) || '.';
const newDep = (fields) => ({
  old_spec: null, kind: 'registry', exists: null, source: null, lookalike_of: null, ...fields,
});
const plural = (n, one, many) => (n === 1 ? one : many);

/** New and changed dependencies of the changed manifests; redirections and new Go replaces are findings. */
function manifestDeps(c, before, after, finding) {
  const delta = manifestDelta(before, after);
  const siblings = after.deps.map((d) => d.real || d.name);
  const deps = delta.added.map((d) => newDep({
    name: d.real || d.name, declared_as: d.real ? d.name : undefined, ecosystem: after.ecosystem,
    manifest: toPosix(c.path), section: d.section, spec: d.spec, kind: d.kind, declared: true, siblings,
  }));
  for (const r of delta.redirected) {
    finding('CK-DEPS', 'fail', c.path, null, `dependency "${r.dep.name}" was redirected from the registry `
      + `(${r.old.spec}) to a ${r.dep.kind} source (${r.dep.spec}); a local stub can make tests pass without the `
      + 'real package', `${r.dep.name}: ${r.old.spec} -> ${r.dep.spec}`, 'deps.redirected');
  }
  const oldReplaces = new Set((before?.replaces || []).map((r) => `${r.from}=>${r.to}`));
  const required = new Set(after.deps.map((d) => d.name));
  for (const r of (after.replaces || []).filter((x) => !oldReplaces.has(`${x.from}=>${x.to}`))) {
    const evidence = `replace ${r.from} => ${r.to}`;
    if (r.local && required.has(r.from)) {
      finding('CK-DEPS', 'fail', c.path, null,
        `go.mod now replaces required module ${r.from} with the local directory ${r.to}`, evidence, 'deps.redirected');
    } else {
      finding('CK-DEPS', 'finding', c.path, null,
        `new replace directive: ${r.from} => ${r.to}${r.toVersion ? ` ${r.toVersion}` : ''}`, evidence, 'deps.replace');
    }
  }
  return { deps, delta };
}

/** Packages imported on added lines (JS/TS, Go) that the nearest manifest does not declare. */
function undeclaredImports({ root, from, to, pathspec, headFiles, blobs }) {
  const read = (file) => blobs.read(to, file);
  const out = [];
  const seen = new Set();
  const nearest = (file, name) => {
    for (let dir = path.posix.dirname(file); ; dir = path.posix.dirname(dir)) {
      const cand = dir === '.' ? name : `${dir}/${name}`;
      if (headFiles.has(cand)) return cand;
      if (dir === '.' || dir === '') return null;
    }
  };
  // Workspace packages import each other by name (computed once, from up to 300 package.json files).
  let workspaceNames = null;
  const workspace = () => {
    if (workspaceNames) return workspaceNames;
    const manifests = [...headFiles].filter((f) => f.endsWith('package.json') && !f.includes('node_modules/'))
      .slice(0, 300);
    blobs.prefetch(manifests.map((p) => [to, p]));
    workspaceNames = new Set(manifests.map((p) => json(read(p) || '')?.name).filter((n) => typeof n === 'string'));
    return workspaceNames;
  };
  const npmCache = new Map();
  const npmDeclared = (manifest) => {
    if (npmCache.has(manifest)) return npmCache.get(manifest);
    const names = new Set(workspace());
    for (const p of [manifest, ...(headFiles.has('package.json') ? ['package.json'] : [])]) {
      const parsed = parseManifest(p, read(p));
      for (const d of parsed?.deps || []) names.add(d.name);
      if (parsed?.packageName) names.add(parsed.packageName);
    }
    const aliases = [];
    const tsconfigs = ['tsconfig.json', 'jsconfig.json', `${path.posix.dirname(manifest)}/tsconfig.json`];
    for (const ts of tsconfigs.filter((f) => headFiles.has(f))) {
      const paths = parseJsonc(read(ts) || '')?.compilerOptions?.paths || {};
      for (const k of Object.keys(paths)) aliases.push(k.replace(/\*.*$/, ''));
    }
    npmCache.set(manifest, { names, aliases: aliases.filter(Boolean) });
    return npmCache.get(manifest);
  };
  const push = (manifest, name, eco, at, siblings) => {
    if (seen.has(`${manifest}:${name}`)) return;
    seen.add(`${manifest}:${name}`);
    out.push(newDep({
      name, ecosystem: eco, manifest, section: 'import', spec: null, declared: false, imported_at: at, siblings,
    }));
  };
  const files = diffLines(root, from, to, pathspec)
    .filter((f) => !f.binary && f.added.length && f.status !== 'D' && !classifyPath(f.path).generated);
  blobs.prefetch(files.filter((f) => f.path.endsWith('.go')).map((f) => [to, f.path]));
  for (const f of files) {
    if (/\.(?:[cm]?[jt]sx?|vue|svelte)$/.test(f.path)) {
      const manifest = nearest(f.path, 'package.json');
      const declared = manifest && npmDeclared(manifest);
      for (const a of declared ? f.added : []) {
        for (const m of JS_IMPORT_RES.flatMap((re) => [...a.text.matchAll(re)])) {
          if (declared.aliases.some((x) => m[1] === x.replace(/\/$/, '') || m[1].startsWith(x))) continue;
          const pkg = jsPackageOf(m[1]);
          if (!pkg || declared.names.has(pkg)) continue;
          push(manifest, pkg, 'npm', `${toPosix(f.path)}:${a.line}`, [...declared.names]);
        }
      }
    } else if (f.path.endsWith('.go')) {
      const gomod = nearest(f.path, 'go.mod');
      const parsed = gomod && parseManifest(gomod, read(gomod));
      if (!parsed) continue;
      const added = new Set(f.added.map((a) => a.line));
      const required = parsed.deps.map((d) => d.name);
      const own = (imp, mod) => imp === mod || imp.startsWith(`${mod}/`);
      for (const imp of goImports(read(f.path))) {
        // Standard-library paths have no dot in their first element.
        if (!added.has(imp.line) || !imp.path.split('/')[0].includes('.')) continue;
        if (parsed.packageName && own(imp.path, parsed.packageName)) continue;
        if (required.some((r) => own(imp.path, r))) continue;
        push(gomod, imp.path, 'go', `${toPosix(f.path)}:${imp.line}`, required);
      }
    }
  }
  return out;
}

const SIBLING_MANIFESTS = ['package.json', 'pyproject.toml', 'Pipfile', 'go.mod', 'Cargo.toml', 'Gemfile',
  'composer.json'];

/** Static consistency of one lockfile with the manifests it governs: { status, missing[], mismatched[] }. */
function staticLockStatus({ lock, manifests, idx, headFiles, read }) {
  const st = { status: 'unknown', missing: [], mismatched: [] };
  const dir = path.posix.dirname(lock);
  // The project's manifests: the changed ones plus those next to the lock that it governs.
  const paths = new Set([...manifests, ...SIBLING_MANIFESTS.map((n) => path.posix.join(dir, n))
    .filter((p) => headFiles.has(p) && lockFor(p, headFiles) === lock)]);
  let checked = false;
  let unparsable = false;
  for (const mp of paths) {
    const parsed = parseManifest(mp, read(mp));
    if (!parsed) { unparsable = true; continue; }
    const deps = parsed.deps.filter((d) => d.section !== 'peerDependencies');
    for (const d of deps.filter((x) => ['registry', 'alias'].includes(x.kind) && x.section !== 'require-indirect')) {
      checked = true;
      if (!lockHas(idx, parsed.ecosystem, d, { importer: relDir(dir, path.posix.dirname(mp)) })) {
        st.missing.push(`${d.name}${d.spec && d.spec !== '*' ? `@${d.spec}` : ''}`);
      }
    }
    // npm and bun record the root's dependency specs verbatim; a different spec is drift.
    if (!['npm', 'bun'].includes(idx.manager) || !idx.root || mp !== path.posix.join(dir, 'package.json')) continue;
    for (const d of deps) {
      if (!(d.name in idx.root) || idx.root[d.name] === d.spec) continue;
      st.mismatched.push(`${d.name}: manifest ${d.spec}, lock ${idx.root[d.name]}`);
    }
    for (const n of Object.keys(idx.root)) {
      if (!parsed.deps.some((d) => d.name === n)) st.mismatched.push(`${n}: in lock, not in manifest`);
    }
  }
  // A manifest that cannot be parsed leaves the lock unjudged, never consistent.
  st.status = (checked && st.missing.length) || st.mismatched.length ? 'inconsistent'
    : unparsable ? 'unknown' : 'consistent';
  return st;
}

/** Lockfile consistency of each project whose manifest or lockfile changed (static parse, then the manager's check). */
function lockReports(ctx) {
  const { root, from, to, target, changes, headFiles, baseFiles, read, lockIdx, finding, offline, tools, env, timeoutMs,
    secrets } = ctx;
  const projects = new Map();
  for (const c of changes.filter((x) => x.status !== 'D')) {
    const lock = isParsableManifest(c.path) ? lockFor(c.path, headFiles) : lockManager(c.path) ? c.path : null;
    if (lock) {
      const manifests = new Set([...(projects.get(lock)?.manifests || []), ...(lock === c.path ? [] : [c.path])]);
      projects.set(lock, { lock, manifests });
      continue;
    }
    if (!isParsableManifest(c.path)) continue;
    const parsed = parseManifest(c.path, read(to, c.path));
    const needs = goSumNeeded(parsed);
    const registryDeps = (parsed?.deps || []).filter((d) => d.kind === 'registry' || d.kind === 'alias');
    if (needs.length) {
      // Go refuses to build without checksums: a go.mod with requirements needs its go.sum.
      const sum = path.posix.join(path.posix.dirname(c.path), 'go.sum');
      projects.set(sum, { lock: sum, manifests: new Set([c.path]), absent: needs.map((d) => `${d.name}@${d.spec}`) });
    } else if (parsed?.ecosystem === 'npm' && registryDeps.length) {
      finding('CK-LOCK', 'info', c.path, null, `${c.path} declares ${registryDeps.length} registry dependencies but `
        + 'the project has no lockfile; installs are not reproducible', '', 'lock.missing');
    }
  }
  const reports = [];
  const worktrees = {};
  // A nonce keeps concurrent runs on the same snapshot (verify plus a manual deps-check) apart.
  const wtRoot = path.join(tmpRoot(root), `deps-${String(target.snapshot.tree).slice(0, 12)}-${nonce().slice(0, 8)}`);
  const inWorktree = (side, rev, dir) => {
    worktrees[side] ||= worktreeAdd(root, rev, path.join(wtRoot, side));
    return path.join(worktrees[side], ...(dir === '.' ? [] : dir.split('/')));
  };
  try {
    for (const { lock, manifests, absent } of projects.values()) {
      const manager = lockManager(lock);
      const dir = path.posix.dirname(lock);
      const idx = lockIdx(lock).head;
      let st;
      if (absent) st = { status: 'inconsistent', missing: absent, mismatched: [] };
      else if (/\.lockb$/.test(lock)) st = { status: 'unsupported', missing: [], mismatched: [] };
      else if (!idx.ok) st = { status: read(to, lock) == null ? 'unknown' : 'unparsable', missing: [], mismatched: [] };
      else st = staticLockStatus({ lock, manifests, idx, headFiles, read: (f) => read(to, f) });
      const report = {
        path: toPosix(lock), manager, project: dir, changed: changes.some((c) => c.path === lock), static: st,
        tool: null, ...(absent ? { absent: true } : {}),
      };
      if (tools && lockTool(manager, offline, env)) {
        const opts = { offline, env, timeoutMs, secrets };
        report.tool = runLockTool(manager, inWorktree('head', to, dir), opts);
        if (report.tool.status === 'inconsistent' && target.base.sha && baseFiles.has(lock)) {
          report.tool.base_status = runLockTool(manager, inWorktree('base', from, dir), opts).status;
        }
      }
      const tool = report.tool?.status;
      report.status = st.status === 'inconsistent' || tool === 'inconsistent' ? 'inconsistent'
        : st.status === 'consistent' || tool === 'consistent' ? 'consistent'
          : st.status === 'unsupported' ? 'unsupported' : 'unknown';
      if (report.status === 'inconsistent') {
        const preexisting = report.tool?.base_status === 'inconsistent' && st.status !== 'inconsistent';
        const detail = [...st.missing.map((m) => `missing ${m}`), ...st.mismatched,
          tool === 'inconsistent' ? report.tool.detail : ''].filter(Boolean).join('; ');
        const message = absent
          ? `${lock} is missing although ${[...manifests][0]} requires ${st.missing.length} module(s)`
          : preexisting ? `${lock} was already inconsistent at the base (${manager}); not caused by this change`
            : `${lock} is not consistent with its manifest (${manager})`;
        const rule = absent ? 'lock.missing' : preexisting ? 'lock.preexisting' : 'lock.inconsistent';
        finding('CK-LOCK', preexisting ? 'finding' : 'fail', lock, null, message, detail, rule);
      }
      reports.push(report);
    }
  } finally {
    for (const wt of Object.values(worktrees)) worktreeRemove(root, wt);
  }
  return reports;
}

/**
 * deps-check. `resolver(ecosystem, name, { spec, root })` may replace registry calls (tests,
 * air-gapped mirrors); it returns { exists, source? } or a boolean, or null for "unknown".
 * `offline` defaults to defaultOffline(env) (the Codex sandbox, ADC_OFFLINE).
 * Returns { base, tree_digest, offline, manifests, new_deps, lock_status, findings, counts, checks }.
 */
export async function depsCheck({ target, offline = null, resolver = null, tools = true, env = process.env,
  timeoutMs = TOOL_TIMEOUT_MS, maxLookups = MAX_LOOKUPS } = {}) {
  const started = Date.now();
  if (offline == null) offline = defaultOffline(env);
  const root = target.root;
  const from = target.base.sha || emptyTree(root);
  const to = target.snapshot.commit;
  const pathspec = ['.', ...snapshotExcludes(target.state).map((p) => `:(top,exclude)${p}`)];
  const changes = diffNameStatus(root, from, to, pathspec);
  const headFiles = new Set(lsTree(root, to));
  const baseFiles = new Set(target.base.sha ? lsTree(root, from) : []);
  const secrets = liveSecrets(env);
  const blobs = blobReader(root);
  const read = blobs.read;
  // Every changed manifest and lockfile, both sides, plus the lockfiles of changed manifests: one batch.
  const relevant = changes.filter((c) => c.status !== 'D' && (isParsableManifest(c.path) || lockManager(c.path)));
  const locks = relevant.map((c) => lockFor(c.path, headFiles)).filter(Boolean);
  blobs.prefetch([
    ...relevant.map((c) => [to, c.path]), ...locks.map((l) => [to, l]),
    ...relevant.map((c) => c.oldPath || c.path).filter((p) => baseFiles.has(p)).map((p) => [from, p]),
    ...locks.filter((l) => baseFiles.has(l)).map((l) => [from, l]),
  ]);
  const lockCache = new Map();
  const lockIdx = (lock) => {
    if (!lockCache.has(lock)) {
      const base = baseFiles.has(lock) ? lockIndex(lock, read(from, lock)) : null;
      lockCache.set(lock, { head: lockIndex(lock, read(to, lock)), base });
    }
    return lockCache.get(lock);
  };
  const findings = [];
  // Specs and tool output can carry credentials (`git+https://<token>@host/...`): mask them everywhere.
  const clean = (text) => redactLiterals(redactSecrets(String(text ?? '')), secrets);
  const finding = (check, severity, file, line, message, evidence = '', rule = undefined) => {
    findings.push({ id: check, severity, file: file ? toPosix(file) : null, line: line ?? null, message: clean(message),
      evidence: truncate(clean(evidence), 240), ...(rule ? { rule } : {}) });
  };

  const manifests = [];
  const newDeps = [];
  const unparsable = [];
  for (const c of relevant.filter((x) => isParsableManifest(x.path))) {
    const oldPath = c.oldPath || c.path;
    const after = parseManifest(c.path, read(to, c.path));
    if (!after) {
      if (read(to, c.path) == null) continue;
      unparsable.push(toPosix(c.path));
      finding('CK-DEPS', 'finding', c.path, null, `${c.path} could not be parsed, so its dependencies were not checked`,
        '', 'deps.unparsable-manifest');
      continue;
    }
    const before = parseManifest(oldPath, baseFiles.has(oldPath) ? read(from, oldPath) : null);
    const { deps, delta } = manifestDeps(c, before, after, finding);
    manifests.push({ path: toPosix(c.path), ecosystem: after.ecosystem, status: c.status, added: delta.added.length,
      removed: delta.removed.length, changed: delta.changed.length });
    newDeps.push(...deps);
  }
  newDeps.push(...undeclaredImports({ root, from, to, pathspec, headFiles, blobs }));

  // Existence: lockfile => cache => resolver/registry. A lock entry that already existed at the base is
  // proof enough; one added by this change may be hand-written (a fabricated package plus a fabricated
  // lock entry), so it only counts after the cache or the registry confirms the name.
  let lookups = 0;
  const registryHosts = npmRegistryHosts(root, env);
  for (const d of newDeps) {
    d.lookalike_of = lookalikeOf(d.ecosystem, d.name, d.siblings || []);
    delete d.siblings;
    if (d.kind === 'workspace' || NON_REGISTRY.has(d.kind)) { d.source = d.kind; continue; }
    const lock = lockFor(d.manifest, headFiles);
    const lk = lock && lockIdx(lock);
    const key = normName(d.ecosystem, d.name);
    const probe = { name: d.name, spec: d.spec && d.ecosystem === 'go' ? d.spec : '*' };
    const importer = lock && relDir(path.posix.dirname(lock), path.posix.dirname(d.manifest));
    if (lk?.head.ok && lockHas(lk.head, d.ecosystem, probe, { importer })) {
      const entry = lk.head.names.get(key)?.[0] || {};
      if (entry.link || entry.local) { d.source = 'workspace'; continue; }
      if (/^https?:/.test(entry.resolved || '')) {
        try { d.resolved_host = new URL(entry.resolved).host; } catch { /* not a URL */ }
      }
      if (lk.base?.ok && lk.base.names.has(key)) { d.exists = true; d.source = `lockfile:${lock}`; continue; }
      d.lock_entry = 'new';
      if (d.ecosystem === 'npm' && d.resolved_host && !registryHosts.has(d.resolved_host)) d.unexpected_host = true;
    }
    const cached = cacheLookup(d.ecosystem, d.name, { root, env });
    if (cached) { d.exists = true; d.source = cached.source; continue; }
    if (resolver) {
      const r = await resolver(d.ecosystem, d.name, { spec: d.spec, root });
      const res = typeof r === 'boolean' ? { exists: r } : r || {};
      d.exists = res.exists ?? null;
      d.source = res.source || 'resolver';
      continue;
    }
    if (offline) { d.source = d.lock_entry ? `offline (new entry in ${lock})` : 'offline'; continue; }
    if (lookups >= maxLookups) { d.source = 'lookup-cap'; continue; }
    lookups++;
    const r = registryLookup(d.ecosystem, d.name, { root, env });
    if (!r) { d.source = 'no-registry-tool'; continue; }
    Object.assign(d, { exists: r.exists, source: r.source }, r.detail ? { detail: r.detail } : {});
  }
  for (const d of newDeps) {
    const at = d.imported_at ? /^(.*):(\d+)$/.exec(d.imported_at) : null;
    const add = (severity, message, evidence, rule) => finding('CK-DEPS', severity, at ? at[1] : d.manifest,
      at ? Number(at[2]) : null, message, evidence, rule);
    if (d.exists === false) {
      add('fail', `${d.ecosystem} package "${d.name}" does not exist (${d.source})`
        + `${d.lock_entry ? ' although the change added it to the lockfile' : ''}`
        + `${d.lookalike_of ? `; it looks like "${d.lookalike_of}"` : ''}`, `${d.name}${d.spec ? ` ${d.spec}` : ''}`,
      'deps.nonexistent');
    }
    if (d.unexpected_host) {
      add('finding', `new lockfile entry for "${d.name}" resolves from ${d.resolved_host}, which is not a configured `
        + 'npm registry', `${d.name} -> ${d.resolved_host}`, 'deps.unexpected-host');
    } else if (d.lookalike_of) {
      add('finding', `new ${d.ecosystem} dependency "${d.name}" looks like "${d.lookalike_of}"; confirm it is the `
        + 'intended package', d.name, 'deps.lookalike');
    }
    if (!d.declared && d.exists !== false) {
      const where = d.ecosystem === 'go' ? 'go.mod does not require' : `${d.manifest} does not declare`;
      add('finding', `imports ${d.ecosystem} package "${d.name}" that ${where}`, d.imported_at || d.manifest,
        'deps.undeclared-import');
    }
    if (d.declared && NON_REGISTRY.has(d.kind)) {
      add('finding', `new dependency "${d.name}" comes from a ${d.kind} source (${d.spec}), not the registry`,
        `${d.name} ${d.spec}`, 'deps.non-registry');
    }
    if (d.exists === null && d.declared && d.kind === 'registry') {
      add('info', `could not verify that "${d.name}" exists (${d.source}); run the registry lookup by hand`, d.name,
        'deps.unverified');
    }
  }

  const reports = lockReports({ root, from, to, target, changes, headFiles, baseFiles, read, lockIdx, finding, offline,
    tools, env, timeoutMs, secrets });
  const judged = reports.filter((r) => r.status !== 'unsupported');
  const lockStatus = !reports.length ? 'unchanged' : !judged.length ? 'unsupported'
    : judged.some((r) => r.status === 'inconsistent') ? 'inconsistent'
      : judged.every((r) => r.status === 'consistent') ? 'consistent' : 'unknown';

  const common = { command: `git diff --name-status ${String(from).slice(0, 12)} ${String(to).slice(0, 12)} `
    + '(manifests, lockfiles)', cwd: toPosix(root), exit_code: 0, duration_ms: Date.now() - started };
  const own = (id) => findings.filter((f) => f.id === id);
  const has = (list, severity) => list.some((f) => f.severity === severity);
  const count = (fn) => newDeps.filter(fn).length;
  const depsF = own('CK-DEPS');
  const unverified = newDeps.filter((d) => d.exists === null && d.declared && d.kind === 'registry');
  const depsStatus = has(depsF, 'fail') ? 'fail' : unverified.length || unparsable.length ? 'unverified'
    : has(depsF, 'finding') ? 'finding' : 'pass';
  const depsReason = depsStatus !== 'unverified' ? null
    : unparsable.length && !unverified.length ? 'MANIFEST_UNPARSABLE' : offline ? 'OFFLINE' : 'REGISTRY_UNVERIFIED';
  const lockF = own('CK-LOCK');
  const lockCheck = has(lockF, 'fail') ? 'fail' : lockStatus === 'unknown' ? 'unverified'
    : has(lockF, 'finding') ? 'finding' : lockStatus === 'unsupported' ? 'skipped' : 'pass';
  const checks = [
    makeCheck({ ...common, id: 'CK-DEPS', fm: ['FM-04'], status: depsStatus, reason: depsReason,
      summary: !newDeps.length ? 'no new dependencies or undeclared imports'
        : `${newDeps.length} new ${plural(newDeps.length, 'dependency', 'dependencies')}: `
          + `${count((d) => d.exists === true)} verified, ${count((d) => d.exists === false)} nonexistent, `
          + `${unverified.length} unverified${offline ? ' (offline)' : ''}, ${count((d) => d.lookalike_of)} look-alike`,
      output_sha256: sha256(asciiJson(depsF, 0)), findings: depsF,
      data: { offline, new_deps: newDeps.length, lookups } }),
    makeCheck({ ...common, id: 'CK-LOCK', fm: ['FM-12'], status: lockCheck,
      reason: lockCheck === 'unverified' ? 'LOCK_UNVERIFIED' : lockCheck === 'skipped' ? 'UNSUPPORTED_LOCKFILE' : null,
      summary: lockStatus === 'unchanged' ? 'no manifest or lockfile changes'
        : `${reports.length} lockfile(s): ${reports.map((r) => `${r.path} ${r.status}`
          + `${r.tool?.cmd ? ` (${r.manager} ${r.tool.status})` : ''}`).join(', ')}`,
      output_sha256: sha256(asciiJson(lockF, 0)), findings: lockF,
      data: { part: 'consistency', lock_status: lockStatus, lockfiles: reports.length } }),
  ];
  const cleanStatic = (st) => ({ ...st, missing: st.missing.map(clean), mismatched: st.mismatched.map(clean) });
  return {
    base: { ref: target.base.ref, sha: target.base.sha, source: target.base.source },
    tree_digest: target.snapshot.tree,
    offline,
    manifests,
    new_deps: newDeps.map((d) => ({ ...d, ...(d.spec != null ? { spec: clean(d.spec) } : {}),
      ...(d.detail ? { detail: clean(d.detail) } : {}) })),
    lock_status: { status: lockStatus, lockfiles: reports.map((r) => ({ ...r, static: cleanStatic(r.static) })) },
    ...(unparsable.length ? { unparsable } : {}),
    findings,
    counts: {
      manifests: manifests.length, new_deps: newDeps.length, registry_lookups: lookups, lockfiles: reports.length,
    },
    checks,
  };
}

// ---------------------------------------------------------------------------
// Command

const USAGE = `usage: adc.mjs deps-check [--base <ref>] [--offline | --online] [--static-only] [--json]

New and changed dependencies in the working-tree snapshot vs the base: existence
(lockfile, local package-manager cache, then npm view / uv / pip index / cargo info /
go list -m / gem search / dotnet package search), look-alike names, undeclared imports, and
lockfile consistency (static parse plus npm ci --dry-run, pnpm --frozen-lockfile, uv lock --check,
poetry check --lock, go mod tidy -diff, cargo metadata --locked, dotnet restore --locked-mode in a
temp worktree).
--offline      no registry lookups (default inside the Codex sandbox, CODEX_SANDBOX*, and with ADC_OFFLINE=1)
--online       look names up even where offline is the default
--static-only  parse lockfiles only; do not run the package managers' own checks
Exit: 0 pass, 1 failures or findings, 4 could not verify (offline and unresolved).`;

export const depsCheckCommand = defineCommand({
  name: 'deps-check',
  usage: USAGE,
  options: { base: { type: 'string' }, offline: { type: 'boolean' }, online: { type: 'boolean' },
    'static-only': { type: 'boolean' } },
  positionals: false,
  async run(ctx, values) {
    const offline = values.online ? false : (values.offline || defaultOffline());
    const target = await prepareTarget(ctx, { base: values.base, createState: !ctx.dryRun });
    const res = await depsCheck({ target, offline, tools: !values['static-only'] });
    const failed = res.checks.some((c) => c.status === 'fail' || c.status === 'finding');
    const unverified = res.checks.some((c) => c.status === 'unverified');
    const exit = failed ? EXIT.FINDINGS : unverified ? EXIT.UNVERIFIABLE : EXIT.OK;
    const human = [
      `deps-check ${res.base.ref || 'empty'}..snapshot ${String(res.tree_digest).slice(0, 12)}`
        + `${offline ? ' (offline)' : ''}`,
      ...res.checks.map((c) => `  ${c.id.padEnd(9)} ${c.status.padEnd(10)} ${c.summary}`),
      ...res.findings.filter((f) => f.severity !== 'info')
        .map((f) => `  - [${f.severity}] ${f.id} ${f.file || ''}${f.line ? `:${f.line}` : ''} ${f.message}`),
    ].join('\n');
    return { result: res, exit, summary: res.checks.map((c) => `${c.id} ${c.status}`).join(', '), human };
  },
});
