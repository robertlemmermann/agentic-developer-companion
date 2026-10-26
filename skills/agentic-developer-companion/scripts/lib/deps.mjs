// deps-check (plan §7.2, §9.1 step 9, Appendix A FM-04/FM-12): new and changed dependencies
// exist and are what they claim, offline-first (lockfile => cached registry metadata => the
// registry's own CLI), look-alike names, and lockfile consistency (static parsing plus the
// package managers' own frozen checks in a temp worktree of the snapshot).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { builtinModules } from 'node:module';
import {
  defineCommand, EXIT, run, runShell, which, quoteArg, sha256, asciiJson, toPosix, truncate,
  redactLiterals, IS_WINDOWS, tmpRoot, readText, nonce,
} from './core.mjs';
import { emptyTree, diffNameStatus, diffLines, showFile, lsTree, worktreeAdd, worktreeRemove } from './git.mjs';
import { prepareTarget, snapshotExcludes } from './state.mjs';
import { classifyPath, redactSecrets } from './markers.mjs';

const MAX_LOOKUPS = 25;
const TOOL_TIMEOUT_MS = 120_000;
const LOOKUP_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// TOML subset (tables, arrays of tables, dotted keys, strings, arrays, inline tables)

/** Lenient TOML reader for manifests and lockfiles; a line it cannot parse is skipped. */
export function parseTomlLite(text) {
  const src = String(text ?? '').replace(/\r\n?/g, '\n');
  const root = {};
  let cur = root;
  let i = 0;
  const ws = () => { while (src[i] === ' ' || src[i] === '\t') i++; };
  const wsnl = () => {
    for (;;) {
      while (i < src.length && (src[i] === ' ' || src[i] === '\t' || src[i] === '\n')) i++;
      if (src[i] === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
      return;
    }
  };
  const fail = () => { throw new SyntaxError(`toml at ${i}`); };
  const str = () => {
    if (src.startsWith('"""', i) || src.startsWith("'''", i)) {
      const q = src.slice(i, i + 3);
      const end = src.indexOf(q, i + 3);
      if (end === -1) fail();
      let s = src.slice(i + 3, end).replace(/^\n/, '');
      i = end + 3;
      if (q === '"""') s = s.replace(/\\\n\s*/g, '');
      return s;
    }
    const q = src[i++];
    let s = '';
    while (i < src.length && src[i] !== q) {
      if (src[i] === '\n') fail();
      if (q === '"' && src[i] === '\\') {
        const n = src[i + 1];
        const map = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', b: '\b', f: '\f' };
        if (n === 'u' || n === 'U') {
          const len = n === 'u' ? 4 : 8;
          s += String.fromCodePoint(parseInt(src.slice(i + 2, i + 2 + len), 16) || 0xfffd);
          i += 2 + len;
          continue;
        }
        s += map[n] ?? n;
        i += 2;
        continue;
      }
      s += src[i++];
    }
    if (src[i] !== q) fail();
    i++;
    return s;
  };
  const key = () => {
    const parts = [];
    for (;;) {
      ws();
      if (src[i] === '"' || src[i] === "'") parts.push(str());
      else {
        const m = /^[A-Za-z0-9_-]+/.exec(src.slice(i, i + 256));
        if (!m) fail();
        parts.push(m[0]);
        i += m[0].length;
      }
      ws();
      if (src[i] === '.') { i++; continue; }
      return parts;
    }
  };
  const value = () => {
    ws();
    const c = src[i];
    if (c === '"' || c === "'") return str();
    if (c === '[') {
      i++;
      const arr = [];
      for (;;) {
        wsnl();
        if (src[i] === ']') { i++; return arr; }
        arr.push(value());
        wsnl();
        if (src[i] === ',') { i++; continue; }
        if (src[i] === ']') { i++; return arr; }
        fail();
      }
    }
    if (c === '{') {
      i++;
      const obj = {};
      for (;;) {
        ws();
        if (src[i] === '}') { i++; return obj; }
        const k = key();
        ws();
        if (src[i] !== '=') fail();
        i++;
        setDeep(obj, k, value());
        ws();
        if (src[i] === ',') { i++; continue; }
        if (src[i] === '}') { i++; return obj; }
        fail();
      }
    }
    const m = /^[^,\]}\n#]+/.exec(src.slice(i, i + 512));
    if (!m) fail();
    i += m[0].length;
    const raw = m[0].trim();
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    if (/^[+-]?\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(raw)) return Number(raw.replace(/_/g, ''));
    return raw;
  };
  const tablePath = (parts, arrayTable) => {
    let obj = root;
    parts.forEach((p, idx) => {
      const last = idx === parts.length - 1;
      if (last && arrayTable) {
        if (!Array.isArray(obj[p])) obj[p] = [];
        const t = {};
        obj[p].push(t);
        obj = t;
        return;
      }
      if (Array.isArray(obj[p])) { obj = obj[p][obj[p].length - 1]; return; }
      if (typeof obj[p] !== 'object' || obj[p] === null) obj[p] = {};
      obj = obj[p];
    });
    return obj;
  };
  while (i < src.length) {
    const lineStart = i;
    try {
      wsnl();
      if (i >= src.length) break;
      if (src[i] === '[') {
        const arrayTable = src[i + 1] === '[';
        i += arrayTable ? 2 : 1;
        const parts = key();
        ws();
        if (src[i] !== ']') fail();
        i += arrayTable ? 2 : 1;
        cur = tablePath(parts, arrayTable);
      } else {
        const k = key();
        ws();
        if (src[i] !== '=') fail();
        i++;
        setDeep(cur, k, value());
      }
      ws();
      if (src[i] === '#') while (i < src.length && src[i] !== '\n') i++;
      if (i < src.length && src[i] !== '\n') fail();
    } catch {
      i = src.indexOf('\n', Math.max(i, lineStart) + 1);
      if (i === -1) break;
    }
  }
  return root;
}

function setDeep(obj, parts, v) {
  let o = obj;
  for (let k = 0; k < parts.length - 1; k++) {
    if (typeof o[parts[k]] !== 'object' || o[parts[k]] === null) o[parts[k]] = {};
    o = o[parts[k]];
  }
  o[parts[parts.length - 1]] = v;
}

const jsonTry = (text) => { try { return JSON.parse(text); } catch { return null; } };
/** JSON with comments and trailing commas (bun.lock, tsconfig.json). */
export function parseJsonc(text) {
  const direct = jsonTry(text);
  if (direct) return direct;
  let out = '';
  const s = String(text ?? '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1;
      out += s.slice(i, j + 1);
      i = j;
    } else if (c === '/' && s[i + 1] === '/') { while (i < s.length && s[i] !== '\n') i++; out += '\n'; }
    else if (c === '/' && s[i + 1] === '*') { const e = s.indexOf('*/', i + 2); i = e === -1 ? s.length : e + 1; }
    else out += c;
  }
  return jsonTry(out.replace(/,(\s*[}\]])/g, '$1'));
}

// ---------------------------------------------------------------------------
// Names

export const normPypi = (n) => String(n).toLowerCase().replace(/[-_.]+/g, '-');
/** Canonical comparison key for a dependency name in its ecosystem. */
export function normName(ecosystem, name) {
  const n = String(name || '').trim();
  if (ecosystem === 'pypi') return normPypi(n);
  if (ecosystem === 'crates') return n.toLowerCase().replace(/_/g, '-');
  if (ecosystem === 'nuget' || ecosystem === 'go' || ecosystem === 'npm' || ecosystem === 'maven' || ecosystem === 'composer') return n.toLowerCase();
  return n;
}

// ---------------------------------------------------------------------------
// Manifests

/** Kind of an npm dependency spec: registry | local | workspace | git | url | alias. */
export function npmSpecKind(spec) {
  const s = String(spec ?? '').trim();
  if (/^(?:file|link|portal):/.test(s) || /^(?:\.{1,2}\/|\/|~\/)/.test(s)) return 'local';
  if (/^workspace:/.test(s)) return 'workspace';
  if (/^npm:/.test(s)) return 'alias';
  if (/^(?:git\+|git:|github:|gitlab:|bitbucket:|gist:)/.test(s) || /^[\w.-]+\/[\w.-]+(?:#.*)?$/.test(s)) return 'git';
  if (/^https?:/.test(s)) return 'url';
  return 'registry';
}

function pep508(req) {
  const s = String(req ?? '').trim();
  const m = /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)\s*(\[[^\]]*\])?\s*(.*)$/.exec(s);
  if (!m) return null;
  const rest = m[3].split(';')[0].trim();
  let kind = 'registry';
  if (rest.startsWith('@')) {
    const url = rest.slice(1).trim();
    kind = /^git\+/.test(url) ? 'git' : /^file:/.test(url) ? 'local' : 'url';
  }
  return { name: m[1], spec: rest || '*', kind };
}

const NPM_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

/**
 * Parse a manifest. Returns { ecosystem, deps: [{ name, spec, section, kind, real? }],
 * packageName?, workspaces?, replaces? } or null for an unsupported or unreadable file.
 */
export function parseManifest(file, text) {
  if (text == null) return null;
  const base = path.posix.basename(toPosix(file)).toLowerCase();
  const deps = [];
  const add = (name, spec, section, kind = 'registry', extra = {}) => {
    if (name) deps.push({ name: String(name), spec: spec == null ? '*' : String(spec), section, kind, ...extra });
  };
  if (base === 'package.json') {
    const j = jsonTry(text);
    if (!j || typeof j !== 'object') return null;
    for (const sec of NPM_SECTIONS) {
      for (const [n, spec] of Object.entries(j[sec] || {})) {
        const kind = npmSpecKind(spec);
        const real = kind === 'alias' ? /^npm:((?:@[^/@]+\/)?[^@]+)/.exec(String(spec))?.[1] : undefined;
        add(n, spec, sec, kind, real ? { real } : {});
      }
    }
    const ws = Array.isArray(j.workspaces) ? j.workspaces : Array.isArray(j.workspaces?.packages) ? j.workspaces.packages : [];
    return { ecosystem: 'npm', deps, packageName: typeof j.name === 'string' ? j.name : null, workspaces: ws };
  }
  if (base === 'composer.json') {
    const j = jsonTry(text);
    if (!j) return null;
    for (const sec of ['require', 'require-dev']) {
      for (const [n, spec] of Object.entries(j[sec] || {})) {
        if (/^(?:php|ext-.*|lib-.*|composer(?:-plugin)?-api|composer-runtime-api|hhvm)$/i.test(n)) continue;
        add(n, spec, sec);
      }
    }
    return { ecosystem: 'composer', deps, packageName: j.name || null };
  }
  if (base === 'pyproject.toml') {
    const t = parseTomlLite(text);
    const sources = t.tool?.uv?.sources || {};
    const srcKind = (n) => {
      const s = sources[n] || sources[normPypi(n)];
      if (!s || typeof s !== 'object') return null;
      if (s.workspace) return 'workspace';
      if (s.path) return 'local';
      if (s.git) return 'git';
      if (s.url) return 'url';
      return null;
    };
    const fromList = (list, section) => {
      for (const r of Array.isArray(list) ? list : []) {
        if (typeof r !== 'string') continue;
        const d = pep508(r);
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
        let kind = 'registry';
        let spec = v;
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          kind = v.path ? 'local' : v.git ? 'git' : v.url ? 'url' : 'registry';
          spec = v.version || v.path || v.git || v.url || '*';
        }
        add(n, Array.isArray(spec) ? '*' : spec, section, kind);
      }
    };
    poetryTable(poetry.dependencies, 'poetry');
    poetryTable(poetry['dev-dependencies'], 'poetry-dev');
    for (const [g, grp] of Object.entries(poetry.group || {})) poetryTable(grp?.dependencies, `poetry-group:${g}`);
    return { ecosystem: 'pypi', deps, packageName: t.project?.name || poetry.name || null };
  }
  if (base === 'pipfile') {
    const t = parseTomlLite(text);
    for (const sec of ['packages', 'dev-packages']) {
      for (const [n, v] of Object.entries(t[sec] || {})) {
        if (v && typeof v === 'object') add(n, v.version || '*', sec, v.path ? 'local' : v.git ? 'git' : v.file ? 'url' : 'registry');
        else add(n, v, sec);
      }
    }
    return { ecosystem: 'pypi', deps };
  }
  if (/^requirements(?:[-_.][\w.-]+)?\.(?:txt|in)$/.test(base) || base === 'constraints.txt') {
    const joined = String(text).replace(/\\\r?\n/g, ' ');
    for (const rawLine of joined.split(/\r?\n/)) {
      const line = rawLine.replace(/(?:^|\s)#.*$/, '').trim();
      if (!line) continue;
      const edit = /^(?:-e|--editable)\s+(\S+)/.exec(line);
      if (edit) {
        const target = edit[1];
        const egg = /#egg=([\w.-]+)/.exec(target)?.[1] || path.posix.basename(target.replace(/[#?].*$/, '').replace(/\.git$/, ''));
        add(egg, target, 'requirements', /^git\+/.test(target) ? 'git' : /^https?:/.test(target) ? 'url' : 'local');
        continue;
      }
      if (line.startsWith('-')) continue;
      if (/^(?:https?|file|git\+\w+):/.test(line) || /^\.{0,2}\//.test(line) || /\.(?:whl|tar\.gz|zip)$/.test(line)) {
        const egg = /#egg=([\w.-]+)/.exec(line)?.[1] || path.posix.basename(line).replace(/[-_]\d.*$/, '');
        add(egg, line, 'requirements', /^git\+/.test(line) ? 'git' : /^https?:/.test(line) ? 'url' : 'local');
        continue;
      }
      const d = pep508(line.replace(/\s+--hash[= ]\S+/g, ''));
      if (d) add(d.name, d.spec, 'requirements', d.kind);
    }
    return { ecosystem: 'pypi', deps };
  }
  if (base === 'setup.cfg') {
    const lines = String(text).split(/\r?\n/);
    let section = '';
    let inReq = false;
    for (const line of lines) {
      const sec = /^\s*\[([^\]]+)\]/.exec(line);
      if (sec) { section = sec[1].trim(); inReq = false; continue; }
      if (section === 'options' && /^install_requires\s*=/.test(line)) {
        inReq = true;
        const rest = line.split('=').slice(1).join('=').trim();
        if (rest) { const d = pep508(rest); if (d) add(d.name, d.spec, 'install_requires', d.kind); }
        continue;
      }
      if (inReq) {
        if (/^\s+\S/.test(line)) { const d = pep508(line.replace(/#.*$/, '')); if (d) add(d.name, d.spec, 'install_requires', d.kind); }
        else if (line.trim()) inReq = false;
      }
    }
    return { ecosystem: 'pypi', deps };
  }
  if (base === 'setup.py') {
    const m = /install_requires\s*=\s*\[([\s\S]*?)\]/.exec(String(text));
    if (m) for (const s of m[1].matchAll(/["']([^"']+)["']/g)) { const d = pep508(s[1]); if (d) add(d.name, d.spec, 'install_requires', d.kind); }
    return { ecosystem: 'pypi', deps };
  }
  if (base === 'go.mod') {
    const replaces = [];
    let block = null;
    for (const rawLine of String(text).split(/\r?\n/)) {
      const line = rawLine.replace(/\/\/(?!\s*indirect).*$/, '').trim();
      if (!line) continue;
      const open = /^(require|replace|exclude|retract)\s*\($/.exec(line);
      if (open) { block = open[1]; continue; }
      if (line === ')') { block = null; continue; }
      let kw = block;
      let body = line;
      const single = /^(require|replace|exclude|retract)\s+(.+)$/.exec(line);
      if (!block && single) { kw = single[1]; body = single[2]; }
      if (kw === 'require') {
        const m = /^(\S+)\s+(\S+)(\s*\/\/\s*indirect)?/.exec(body);
        if (m) add(m[1], m[2], m[3] ? 'require-indirect' : 'require');
      } else if (kw === 'replace') {
        const m = /^(\S+)(?:\s+(\S+))?\s*=>\s*(\S+)(?:\s+(\S+))?/.exec(body);
        if (m) replaces.push({ from: m[1], fromVersion: m[2] || null, to: m[3], toVersion: m[4] || null, local: /^(?:\.{1,2}[\\/]|\/|[A-Za-z]:[\\/])/.test(m[3]) });
      }
    }
    const mod = /^\s*module\s+(\S+)/m.exec(String(text))?.[1] || null;
    return { ecosystem: 'go', deps, packageName: mod, replaces };
  }
  if (base === 'cargo.toml') {
    const t = parseTomlLite(text);
    const table = (tbl, section) => {
      for (const [n, v] of Object.entries(tbl || {})) {
        if (v && typeof v === 'object') {
          const kind = v.path ? 'local' : v.git ? 'git' : v.workspace ? 'workspace' : 'registry';
          add(n, v.version || v.path || v.git || (v.workspace ? 'workspace' : '*'), section, kind, v.package ? { real: v.package } : {});
        } else add(n, v, section);
      }
    };
    for (const sec of ['dependencies', 'dev-dependencies', 'build-dependencies']) table(t[sec], sec);
    for (const [tgt, body] of Object.entries(t.target || {})) {
      for (const sec of ['dependencies', 'dev-dependencies', 'build-dependencies']) table(body?.[sec], `target.${tgt}.${sec}`);
    }
    table(t.workspace?.dependencies, 'workspace.dependencies');
    return { ecosystem: 'crates', deps, packageName: t.package?.name || null };
  }
  if (base === 'gemfile' || base.endsWith('.gemspec')) {
    for (const m of String(text).matchAll(/^\s*(?:gem|spec\.add_(?:development_|runtime_)?dependency|s\.add_(?:development_|runtime_)?dependency)\s*\(?\s*["']([^"']+)["']([^\n]*)$/gm)) {
      const rest = m[2];
      const kind = /\bpath\s*:|:path\s*=>/.test(rest) ? 'local' : /\b(?:git|github|gitlab|bitbucket)\s*:|:git\s*=>/.test(rest) ? 'git' : 'registry';
      const spec = /,\s*["']([^"']+)["']/.exec(rest)?.[1] || '*';
      add(m[1], spec, base === 'gemfile' ? 'gem' : 'gemspec', kind);
    }
    return { ecosystem: 'rubygems', deps };
  }
  if (/\.(?:cs|fs|vb)proj$/.test(base) || base === 'directory.packages.props' || base === 'directory.build.props') {
    const s = String(text);
    for (const m of s.matchAll(/<(PackageReference|PackageVersion|GlobalPackageReference)\b([^>]*?)(\/>|>([\s\S]*?)<\/\1>)/g)) {
      const attrs = m[2];
      const name = /\b(?:Include|Update)\s*=\s*"([^"]+)"/.exec(attrs)?.[1];
      const version = /\bVersion\s*=\s*"([^"]+)"/.exec(attrs)?.[1] || /<Version>([^<]+)<\/Version>/.exec(m[4] || '')?.[1] || '*';
      if (name) add(name, version, m[1]);
    }
    return { ecosystem: 'nuget', deps };
  }
  if (base === 'packages.config') {
    for (const m of String(text).matchAll(/<package\s+[^>]*\bid\s*=\s*"([^"]+)"[^>]*?(?:\bversion\s*=\s*"([^"]+)")?/g)) add(m[1], m[2] || '*', 'packages.config');
    return { ecosystem: 'nuget', deps };
  }
  if (base === 'pom.xml') {
    for (const m of String(text).matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
      const g = /<groupId>\s*([^<\s]+)\s*<\/groupId>/.exec(m[1])?.[1];
      const a = /<artifactId>\s*([^<\s]+)\s*<\/artifactId>/.exec(m[1])?.[1];
      const v = /<version>\s*([^<\s]+)\s*<\/version>/.exec(m[1])?.[1] || '*';
      const scope = /<scope>\s*([^<\s]+)\s*<\/scope>/.exec(m[1])?.[1] || 'compile';
      if (g && a) add(`${g}:${a}`, v, scope, scope === 'system' ? 'local' : 'registry');
    }
    return { ecosystem: 'maven', deps };
  }
  if (base === 'build.gradle' || base === 'build.gradle.kts') {
    const confs = 'implementation|api|compileOnly|runtimeOnly|testImplementation|testRuntimeOnly|testCompileOnly|annotationProcessor|kapt|ksp|developmentOnly|compile|testCompile|androidTestImplementation|debugImplementation';
    const re = new RegExp(`\\b(${confs})\\s*\\(?\\s*(?:platform\\s*\\(\\s*)?["']([^"':\\s]+):([^"':\\s]+)(?::([^"'\\s]+))?["']`, 'g');
    for (const m of String(text).matchAll(re)) add(`${m[2]}:${m[3]}`, m[4] || '*', m[1]);
    return { ecosystem: 'maven', deps };
  }
  return null;
}

/** Does this path name a manifest parseManifest understands? */
export function isParsableManifest(file) {
  const base = path.posix.basename(toPosix(file)).toLowerCase();
  return /^(?:package\.json|composer\.json|pyproject\.toml|pipfile|setup\.cfg|setup\.py|go\.mod|cargo\.toml|gemfile|pom\.xml|build\.gradle(?:\.kts)?|packages\.config|directory\.packages\.props|constraints\.txt)$/.test(base) ||
    /^requirements(?:[-_.][\w.-]+)?\.(?:txt|in)$/.test(base) || /\.(?:cs|fs|vb)proj$/.test(base) || base.endsWith('.gemspec');
}

/** Map of normalized name -> dep for a parsed manifest (registry, alias and other kinds). */
function depMap(parsed) {
  const map = new Map();
  if (!parsed) return map;
  for (const d of parsed.deps) map.set(`${d.section}\u0000${normName(parsed.ecosystem, d.name)}`, d);
  return map;
}

/**
 * Compare two parsed manifests: { added[], removed[], changed[{dep, old}], redirected[] }.
 * Keys are section + name, so moving a dependency between sections shows as remove + add.
 */
export function manifestDelta(before, after) {
  const a = depMap(before);
  const b = depMap(after);
  const out = { added: [], removed: [], changed: [], redirected: [] };
  const eco = (after || before)?.ecosystem;
  const namesBefore = new Set([...a.values()].map((d) => normName(eco, d.name)));
  for (const [k, d] of b) {
    const old = a.get(k);
    if (!old) {
      if (!namesBefore.has(normName(eco, d.name))) out.added.push(d);
      else {
        const prev = [...a.values()].find((x) => normName(eco, x.name) === normName(eco, d.name));
        if (prev && prev.spec !== d.spec) out.changed.push({ dep: d, old: prev });
        if (prev && prev.kind === 'registry' && ['local', 'git', 'url'].includes(d.kind)) out.redirected.push({ dep: d, old: prev });
      }
      continue;
    }
    if (old.spec !== d.spec) {
      out.changed.push({ dep: d, old });
      if (old.kind === 'registry' && ['local', 'git', 'url'].includes(d.kind)) out.redirected.push({ dep: d, old });
    }
  }
  const namesAfter = new Set([...b.values()].map((d) => normName(eco, d.name)));
  for (const [k, d] of a) if (!b.has(k) && !namesAfter.has(normName(eco, d.name))) out.removed.push(d);
  return out;
}

// ---------------------------------------------------------------------------
// Lockfiles

const LOCKS_FOR = [
  { test: (b) => b === 'package.json', locks: ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'], up: true },
  { test: (b) => b === 'pyproject.toml', locks: ['uv.lock', 'poetry.lock', 'pdm.lock'], up: true },
  { test: (b) => b === 'pipfile', locks: ['Pipfile.lock'], up: false },
  { test: (b) => b === 'go.mod', locks: ['go.sum'], up: false },
  { test: (b) => b === 'cargo.toml', locks: ['Cargo.lock'], up: true },
  { test: (b) => b === 'gemfile', locks: ['Gemfile.lock'], up: false },
  { test: (b) => b === 'composer.json', locks: ['composer.lock'], up: false },
  { test: (b) => /\.(?:cs|fs|vb)proj$/.test(b), locks: ['packages.lock.json'], up: false },
  { test: (b) => b === 'build.gradle' || b === 'build.gradle.kts', locks: ['gradle.lockfile'], up: false },
  { test: (b) => /^requirements(?:[-_.][\w.-]+)?\.in$/.test(b), locks: (b) => [b.replace(/\.in$/, '.txt')], up: false },
];

/** The lockfile that governs `manifest` in a tree (Set of POSIX paths), or null. */
export function lockFor(manifest, treeFiles) {
  const p = toPosix(manifest);
  const baseName = path.posix.basename(p);
  const rule = LOCKS_FOR.find((r) => r.test(baseName.toLowerCase()));
  if (!rule) return null;
  const names = typeof rule.locks === 'function' ? rule.locks(baseName) : rule.locks;
  let dir = path.posix.dirname(p);
  for (;;) {
    for (const n of names) {
      const cand = dir === '.' ? n : `${dir}/${n}`;
      if (treeFiles.has(cand)) return cand;
    }
    if (!rule.up || dir === '.' || dir === '') return null;
    dir = path.posix.dirname(dir);
  }
}

/** Modules a parsed go.mod requires that need go.sum entries (local `replace` targets need none). */
export function goSumNeeded(parsed) {
  if (!parsed || parsed.ecosystem !== 'go') return [];
  const local = new Set((parsed.replaces || []).filter((r) => r.local).map((r) => r.from));
  return parsed.deps.filter((d) => !local.has(d.name));
}

/** Manager that owns a lockfile name. */
export function lockManager(lock) {
  const b = path.posix.basename(toPosix(lock)).toLowerCase();
  return ({
    'package-lock.json': 'npm', 'npm-shrinkwrap.json': 'npm', 'pnpm-lock.yaml': 'pnpm', 'yarn.lock': 'yarn',
    'bun.lock': 'bun', 'bun.lockb': 'bun', 'uv.lock': 'uv', 'poetry.lock': 'poetry', 'pdm.lock': 'pdm',
    'pipfile.lock': 'pipenv', 'go.sum': 'go', 'cargo.lock': 'cargo', 'gemfile.lock': 'bundler',
    'composer.lock': 'composer', 'packages.lock.json': 'nuget', 'gradle.lockfile': 'gradle',
  })[b] || (/^requirements.*\.txt$/.test(b) ? 'pip-tools' : null);
}

/**
 * Index a lockfile: { manager, ok, names: Map(norm -> [{ version, resolved, integrity, specs }]),
 * root: { name -> spec } | null (direct dependencies recorded by npm/pnpm/bun), versions: Set('name@ver') }.
 */
export function lockIndex(lock, text) {
  const manager = lockManager(lock);
  const idx = { manager, ok: text != null, names: new Map(), root: null, importers: null, versions: new Set() };
  if (text == null) return idx;
  const eco = { npm: 'npm', pnpm: 'npm', yarn: 'npm', bun: 'npm', uv: 'pypi', poetry: 'pypi', pdm: 'pypi', pipenv: 'pypi', 'pip-tools': 'pypi', go: 'go', cargo: 'crates', bundler: 'rubygems', composer: 'composer', nuget: 'nuget', gradle: 'maven' }[manager];
  const put = (name, info = {}) => {
    if (!name) return;
    const k = normName(eco, name);
    if (!idx.names.has(k)) idx.names.set(k, []);
    idx.names.get(k).push(info);
    if (info.version) idx.versions.add(`${k}@${info.version}`);
  };
  try {
    if (manager === 'npm') {
      const j = jsonTry(text);
      if (!j) { idx.ok = false; return idx; }
      if (j.packages) {
        for (const [k, v] of Object.entries(j.packages)) {
          if (k === '') { idx.root = rootDeps(v); continue; }
          const name = v.name || k.slice(k.lastIndexOf('node_modules/') + 13);
          put(name, { version: v.version, resolved: v.resolved, integrity: v.integrity, link: Boolean(v.link) });
        }
      } else if (j.dependencies) {
        const walk = (deps) => {
          for (const [n, v] of Object.entries(deps || {})) { put(n, { version: v.version, resolved: v.resolved, integrity: v.integrity }); walk(v.dependencies); }
        };
        walk(j.dependencies);
      }
    } else if (manager === 'bun') {
      const j = parseJsonc(text);
      if (!j) { idx.ok = false; return idx; }
      idx.root = rootDeps(j.workspaces?.[''] || {});
      for (const [n, v] of Object.entries(j.packages || {})) {
        const ident = Array.isArray(v) ? String(v[0]) : '';
        put(n, { version: /@([^@]+)$/.exec(ident)?.[1], resolved: ident });
      }
    } else if (manager === 'pnpm') {
      parsePnpmLock(text, idx, put);
    } else if (manager === 'yarn') {
      for (const line of String(text).split(/\r?\n/)) {
        if (!line || line.startsWith(' ') || line.startsWith('#') || !line.endsWith(':') || line.startsWith('__metadata')) continue;
        for (const raw of line.slice(0, -1).split(/,\s*/)) {
          const entry = raw.trim().replace(/^"|"$/g, '');
          const m = /^((?:@[^@/]+\/)?[^@]+)@(.*)$/.exec(entry);
          if (!m) continue;
          const list = idx.names.get(normName('npm', m[1]));
          const specs = list?.[0]?.specs || new Set();
          specs.add(m[2].replace(/^npm:/, ''));
          if (!list) put(m[1], { specs });
        }
      }
    } else if (['cargo', 'uv', 'poetry', 'pdm'].includes(manager)) {
      const t = parseTomlLite(text);
      for (const p of Array.isArray(t.package) ? t.package : []) {
        put(p.name, { version: p.version, resolved: typeof p.source === 'string' ? p.source : p.source ? JSON.stringify(p.source) : null, checksum: p.checksum || null });
      }
    } else if (manager === 'pipenv' || manager === 'composer') {
      const j = jsonTry(text);
      if (!j) { idx.ok = false; return idx; }
      if (manager === 'pipenv') for (const sec of ['default', 'develop']) for (const [n, v] of Object.entries(j[sec] || {})) put(n, { version: String(v?.version || '').replace(/^==/, '') });
      else for (const sec of ['packages', 'packages-dev']) for (const p of j[sec] || []) put(p.name, { version: p.version });
    } else if (manager === 'go') {
      for (const line of String(text).split(/\r?\n/)) {
        const m = /^(\S+)\s+(v[^\s/]+)(\/go\.mod)?\s+h1:/.exec(line);
        if (m) put(m[1], { version: m[2], gomod: Boolean(m[3]) });
      }
    } else if (manager === 'bundler') {
      let section = '';
      for (const line of String(text).split(/\r?\n/)) {
        if (/^[A-Z][A-Z ]*$/.test(line)) { section = line.trim(); continue; }
        const spec = /^ {4}([A-Za-z0-9_.-]+) \(([^)]+)\)$/.exec(line);
        if (spec) put(spec[1], { version: spec[2] });
        if (section === 'DEPENDENCIES') {
          const d = /^ {2}([A-Za-z0-9_.-]+)(!)?(?: \(([^)]+)\))?$/.exec(line);
          if (d) { idx.root = idx.root || {}; idx.root[d[1]] = d[3] || '*'; if (!idx.names.has(normName('rubygems', d[1]))) put(d[1], { local: Boolean(d[2]) }); }
        }
      }
    } else if (manager === 'nuget') {
      const j = jsonTry(text);
      if (!j) { idx.ok = false; return idx; }
      for (const tfm of Object.values(j.dependencies || {})) for (const [n, v] of Object.entries(tfm || {})) put(n, { version: v?.resolved, type: v?.type });
    } else if (manager === 'gradle') {
      for (const line of String(text).split(/\r?\n/)) { const m = /^([^:#\s]+):([^:\s]+):([^=\s]+)=/.exec(line); if (m) put(`${m[1]}:${m[2]}`, { version: m[3] }); }
    } else if (manager === 'pip-tools') {
      const parsed = parseManifest('requirements.txt', text);
      for (const d of parsed?.deps || []) put(d.name, { version: d.spec.replace(/^==/, '') });
    }
  } catch {
    idx.ok = false;
  }
  return idx;
}

function rootDeps(entry) {
  const out = {};
  for (const sec of NPM_SECTIONS) for (const [n, s] of Object.entries(entry?.[sec] || {})) out[n] = String(s);
  return out;
}

function parsePnpmLock(text, idx, put) {
  const lines = String(text).split(/\r?\n/);
  const unq = (s) => s.trim().replace(/^['"]|['"]$/g, '');
  let top = null;
  let importer = null;
  let depSection = null;
  let depName = null;
  idx.importers = {};
  const v5Specifiers = {};
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    const t = line.trim();
    if (indent === 0) {
      top = t.replace(/:.*$/, '');
      importer = depSection = depName = null;
      if (top === 'importers' && /\{\s*\}/.test(t)) top = null;
      continue;
    }
    if (top === 'importers') {
      if (indent === 2) {
        importer = unq(t.replace(/:\s*(\{\s*\})?\s*$/, ''));
        idx.importers[importer] = idx.importers[importer] || {};
        depSection = depName = null;
      } else if (indent === 4 && importer != null) {
        depSection = /^(dependencies|devDependencies|optionalDependencies|peerDependencies):/.test(t) ? t.replace(/:.*$/, '') : null;
        depName = null;
      } else if (indent === 6 && depSection) {
        const m = /^(.+?):\s*(.*)$/.exec(t);
        if (m) {
          depName = unq(m[1]);
          if (m[2]) { idx.importers[importer][depName] = unq(m[2]); }
        }
      } else if (indent === 8 && depName) {
        const m = /^specifier:\s*(.+)$/.exec(t);
        if (m) idx.importers[importer][depName] = unq(m[1]);
      }
    } else if (top === 'specifiers' && indent === 2) {
      const m = /^(.+?):\s*(.+)$/.exec(t);
      if (m) v5Specifiers[unq(m[1])] = unq(m[2]);
    } else if ((top === 'packages' || top === 'snapshots') && indent === 2 && t.endsWith(':')) {
      const key = unq(t.slice(0, -1)).replace(/^\//, '');
      const m = /^((?:@[^@/]+\/)?[^@/(]+)[@/]([^(@/]+)/.exec(key);
      if (m) put(m[1], { version: m[2] });
    }
  }
  if (Object.keys(v5Specifiers).length && !Object.keys(idx.importers).length) idx.importers['.'] = v5Specifiers;
  idx.root = idx.importers['.'] || null;
  for (const imp of Object.values(idx.importers)) for (const n of Object.keys(imp)) if (!idx.names.has(normName('npm', n))) put(n, {});
}

/** Is `dep` (from a manifest in the lock's project) recorded in the lock? */
export function lockHas(idx, ecosystem, dep, { importer = '.' } = {}) {
  const name = dep.real || dep.name;
  const k = normName(ecosystem, name);
  if (idx.manager === 'go') {
    if (dep.spec && dep.spec !== '*') return idx.versions.has(`${k}@${dep.spec}`);
    return idx.names.has(k);
  }
  if (idx.manager === 'yarn') {
    const entries = idx.names.get(k);
    if (!entries) return false;
    const specs = entries[0].specs;
    return !specs || specs.has(String(dep.spec)) || specs.has(String(dep.spec).replace(/^npm:/, ''));
  }
  if (idx.manager === 'pnpm' && idx.importers && idx.importers[importer]) return dep.name in idx.importers[importer];
  return idx.names.has(k);
}

// ---------------------------------------------------------------------------
// Look-alike names (slopsquatting / typosquatting)

const POPULAR = {
  npm: `react react-dom lodash express axios chalk commander debug moment dayjs uuid typescript jest vitest mocha chai sinon
eslint prettier webpack vite rollup esbuild next vue svelte jquery underscore async request bluebird rxjs redux react-redux
react-router react-router-dom yargs minimist glob rimraf mkdirp fs-extra semver dotenv cors body-parser cookie-parser mongoose
mongodb mysql mysql2 pg sequelize prisma typeorm redis ioredis socket.io ws node-fetch cross-env nodemon ts-node tslib zod joi
yup ajv date-fns luxon ramda immer classnames clsx styled-components tailwindcss postcss autoprefixer sass less handlebars ejs pug
marked markdown-it highlight.js cheerio puppeteer playwright cypress supertest nock msw jsonwebtoken bcrypt bcryptjs passport
helmet morgan winston pino graphql firebase stripe openai colors ora inquirer prompts execa shelljs cross-spawn chokidar got
superagent qs query-string validator nanoid immutable core-js regenerator-runtime left-pad is-number kind-of object-assign
inherits safe-buffer readable-stream string-width strip-ansi ansi-styles supports-color source-map acorn browserslist electron
three d3 chart.js socket.io-client yaml js-yaml xml2js papaparse sharp multer formidable busboy koa fastify reflect-metadata
zustand mobx swr formik react-hook-form antd bootstrap lerna nx turbo husky lint-staged concurrently npm-run-all serve
http-server jsdom happy-dom enzyme karma jasmine ava tap c8 nyc web-vitals react-scripts gatsby nuxt astro solid-js preact lit
mustache sass-loader css-loader style-loader babel-loader ts-loader html-webpack-plugin terser uglify-js cssnano p-limit p-queue
lru-cache node-cache keyv json5 toml ini mime mime-types iconv-lite buffer events util path-to-regexp cookie tough-cookie
form-data abort-controller whatwg-fetch cross-fetch isomorphic-fetch undici tsx ts-jest babel-jest proxyquire faker chance
moment-timezone numeral big.js bignumber.js decimal.js crypto-js node-forge jose dotenv-expand pnpm yarn npm bun deno
@babel/core @babel/preset-env @types/node @types/react @types/jest @prisma/client @playwright/test @testing-library/react
@testing-library/jest-dom @angular/core @nestjs/core @apollo/client @aws-sdk/client-s3 @emotion/react @mui/material
@tanstack/react-query @faker-js/faker @typescript-eslint/parser @typescript-eslint/eslint-plugin @anthropic-ai/sdk @octokit/rest`,
  pypi: `requests numpy pandas scipy matplotlib seaborn scikit-learn tensorflow torch keras flask django fastapi uvicorn gunicorn
pydantic sqlalchemy alembic psycopg2 psycopg2-binary pymysql redis celery boto3 botocore pyyaml toml tomli click typer rich tqdm
pytest pytest-cov pytest-mock pytest-asyncio pytest-xdist hypothesis mock coverage tox nox black flake8 pylint mypy ruff isort
pre-commit setuptools wheel pip virtualenv poetry httpx aiohttp urllib3 certifi chardet charset-normalizer idna six
python-dateutil pytz arrow pendulum jinja2 markupsafe werkzeug itsdangerous beautifulsoup4 lxml html5lib selenium playwright
scrapy pillow opencv-python imageio pyjwt cryptography bcrypt passlib paramiko fabric invoke docker kubernetes
google-cloud-storage google-api-python-client azure-storage-blob openai anthropic langchain transformers datasets tokenizers
sentencepiece nltk spacy gensim networkx sympy statsmodels xgboost lightgbm catboost plotly dash streamlit gradio jupyter
notebook ipython ipykernel jupyterlab pyarrow polars dask numba cython attrs cattrs marshmallow jsonschema simplejson orjson
ujson msgpack protobuf grpcio pyzmq websockets websocket-client python-dotenv structlog loguru sentry-sdk prometheus-client
pyparsing packaging filelock platformdirs appdirs colorama termcolor tabulate openpyxl xlrd xlsxwriter python-docx pypdf
pypdf2 reportlab markdown mistune docutils sphinx mkdocs mkdocs-material faker factory-boy freezegun responses requests-mock
vcrpy pytest-django djangorestframework django-cors-headers channels graphene starlette sanic tornado twisted gevent eventlet
greenlet uvloop anyio trio tenacity backoff cachetools diskcache joblib psutil pywin32 pexpect watchdog schedule apscheduler
pika kafka-python confluent-kafka pymongo motor elasticsearch neo4j peewee asyncpg aiofiles httplib2 oauthlib
requests-oauthlib google-auth msal pyopenssl pycryptodome pynacl rsa pyasn1 setuptools-scm build twine hatchling flit pdm uv
pipenv pyinstaller cffi pybind11 typing-extensions mypy-extensions types-requests types-pyyaml colorlog humanize
python-slugify unidecode emoji regex`,
  crates: `serde serde_json serde_derive tokio rand clap anyhow thiserror log env_logger tracing tracing-subscriber reqwest hyper
axum actix-web rocket warp futures async-trait lazy_static once_cell regex chrono time uuid itertools rayon crossbeam
parking_lot bytes base64 hex sha2 md5 ring rustls openssl sqlx diesel rusqlite redis mongodb toml serde_yaml csv url http
tower tonic prost syn quote proc-macro2 libc winapi windows nix bitflags num num-traits criterion proptest quickcheck mockall
tempfile walkdir glob dirs indicatif colored termcolor crossterm ratatui image wasm-bindgen structopt`,
  go: `github.com/stretchr/testify github.com/gin-gonic/gin github.com/gorilla/mux github.com/spf13/cobra github.com/spf13/viper
github.com/sirupsen/logrus go.uber.org/zap github.com/pkg/errors github.com/google/uuid github.com/go-sql-driver/mysql
github.com/lib/pq github.com/jackc/pgx/v5 gorm.io/gorm github.com/redis/go-redis/v9 github.com/labstack/echo/v4
github.com/gofiber/fiber/v2 google.golang.org/grpc google.golang.org/protobuf github.com/golang/protobuf golang.org/x/sync
golang.org/x/net golang.org/x/crypto golang.org/x/text golang.org/x/sys github.com/prometheus/client_golang
github.com/aws/aws-sdk-go-v2 github.com/aws/aws-sdk-go k8s.io/client-go github.com/urfave/cli/v2 github.com/joho/godotenv
github.com/golang-jwt/jwt/v5 github.com/go-chi/chi/v5 github.com/rs/zerolog github.com/mattn/go-sqlite3
github.com/gorilla/websocket github.com/google/go-cmp github.com/onsi/ginkgo/v2 github.com/onsi/gomega github.com/golang/mock
go.uber.org/mock github.com/BurntSushi/toml gopkg.in/yaml.v3 github.com/mitchellh/mapstructure github.com/fatih/color`,
  rubygems: `rails rake rspec rspec-rails minitest puma sidekiq devise nokogiri pg mysql2 sqlite3 redis rack sinatra json bundler
rubocop pry byebug capybara selenium-webdriver factory_bot faker webmock vcr simplecov httparty faraday aws-sdk-s3 jwt bcrypt
activerecord activesupport thor dotenv rest-client sass jbuilder kaminari pundit cancancan`,
  nuget: `Newtonsoft.Json Serilog NUnit xunit xunit.runner.visualstudio Moq FluentAssertions AutoMapper Dapper
Microsoft.EntityFrameworkCore Microsoft.Extensions.DependencyInjection Microsoft.Extensions.Logging Microsoft.NET.Test.Sdk
MSTest.TestFramework MSTest.TestAdapter Polly MediatR FluentValidation Swashbuckle.AspNetCore StackExchange.Redis Npgsql
coverlet.collector NSubstitute Bogus RestSharp Humanizer CsvHelper Castle.Core System.Text.Json Azure.Storage.Blobs AWSSDK.S3`,
  maven: `org.junit.jupiter:junit-jupiter junit:junit org.mockito:mockito-core org.slf4j:slf4j-api ch.qos.logback:logback-classic
com.google.guava:guava org.apache.commons:commons-lang3 com.fasterxml.jackson.core:jackson-databind
org.springframework.boot:spring-boot-starter-web org.projectlombok:lombok org.assertj:assertj-core`,
  composer: `laravel/framework symfony/console guzzlehttp/guzzle monolog/monolog phpunit/phpunit doctrine/orm vlucas/phpdotenv`,
};
const popularCache = new Map();
function popularSet(ecosystem) {
  if (!popularCache.has(ecosystem)) {
    const list = (POPULAR[ecosystem] || '').split(/\s+/).filter(Boolean).map((n) => normName(ecosystem, n));
    popularCache.set(ecosystem, new Set(list));
  }
  return popularCache.get(ecosystem);
}

/** Optimal-string-alignment distance (transpositions count 1), capped at `max + 1`. */
export function editDistance(a, b, max = 3) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      rowMin = Math.min(rowMin, d[i][j]);
    }
    if (rowMin > max) return max + 1;
  }
  return d[a.length][b.length];
}

const HOMOGLYPH = (s) => s.replace(/rn/g, 'm').replace(/vv/g, 'w').replace(/0/g, 'o').replace(/1/g, 'l').replace(/5/g, 's').replace(/3/g, 'e');
const AFFIXES = ['-js', '.js', 'js-', 'node-', '-node', 'py-', 'python-', '-python', '-py', '-official', '-lib', '-dev'];

/** The popular (or sibling) package a new name imitates, or null. */
export function lookalikeOf(ecosystem, name, siblings = []) {
  const n = normName(ecosystem, name);
  const popular = popularSet(ecosystem);
  if (popular.has(n)) return null;
  const sib = siblings.map((s) => normName(ecosystem, s)).filter((s) => s && s !== n);
  const pool = [...popular, ...sib];
  const strip = (s) => s.replace(/[-_.]/g, '');
  for (const p of pool) {
    const minLen = Math.min(n.length, p.length);
    const d = editDistance(n, p, 2);
    if ((d === 1 && minLen >= 5) || (d === 2 && minLen >= 12)) return p;
    if (strip(n) === strip(p) && n !== p) return p;
    if (HOMOGLYPH(n) === p) return p;
    if (p.length >= 4 && AFFIXES.some((a) => (a.startsWith('-') || a.startsWith('.') ? n === p + a : n === a + p))) {
      if (!popular.has(n)) return p;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Existence: cache and registry

const home = () => os.homedir();

function npmRegistries(root, env, { scoped = false } = {}) {
  const regs = [];
  if (env.npm_config_registry) regs.push(env.npm_config_registry);
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
  for (const r of npmRegistries(root, env, { scoped: true })) { try { hosts.add(new URL(r).host); } catch { /* not a URL */ } }
  return hosts;
}

function npmCacheDirs(env) {
  // npm uses npm_config_cache when set and its platform default otherwise; mirror that exactly.
  if (env.npm_config_cache) return [env.npm_config_cache];
  return [IS_WINDOWS && env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'npm-cache') : path.join(home(), '.npm')];
}

/** cacache stores each key in index-v5/<sha256(key)> split 2/2/rest; a hit with integrity is a cached 200. */
function cacacheHas(cacheDir, key) {
  const h = sha256(key);
  const file = path.join(cacheDir, '_cacache', 'index-v5', h.slice(0, 2), h.slice(2, 4), h.slice(4));
  const text = readText(file);
  if (!text) return false;
  return text.split('\n').some((line) => {
    const tab = line.indexOf('\t');
    const entry = tab === -1 ? null : jsonTry(line.slice(tab + 1));
    return entry && entry.key === key && entry.integrity;
  });
}

function crateIndexPath(name) {
  const n = name.toLowerCase();
  if (n.length === 1) return ['1', n];
  if (n.length === 2) return ['2', n];
  if (n.length === 3) return ['3', n[0], n];
  return [n.slice(0, 2), n.slice(2, 4), n];
}

/** Evidence of existence in a local package-manager cache: { exists: true, source } or null. */
export function cacheLookup(ecosystem, name, { root = null, env = process.env } = {}) {
  try {
    if (ecosystem === 'npm') {
      const escaped = name.startsWith('@') ? name.replace('/', '%2f') : name;
      for (const dir of npmCacheDirs(env)) {
        for (const reg of npmRegistries(root, env)) {
          if (cacacheHas(dir, `make-fetch-happen:request-cache:${reg}${escaped}`)) return { exists: true, source: 'cache:npm', detail: reg };
        }
      }
    } else if (ecosystem === 'go') {
      const gopath = (env.GOPATH || path.join(home(), 'go')).split(path.delimiter)[0];
      const modcache = env.GOMODCACHE || path.join(gopath, 'pkg', 'mod');
      const escaped = name.replace(/[A-Z]/g, (c) => `!${c.toLowerCase()}`);
      const dir = path.join(modcache, 'cache', 'download', ...escaped.split('/'), '@v');
      const entries = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
      if (entries.some((f) => /\.(?:info|mod|zip)$/.test(f))) return { exists: true, source: 'cache:go' };
    } else if (ecosystem === 'crates') {
      const cargoHome = env.CARGO_HOME || path.join(home(), '.cargo');
      const indexRoot = path.join(cargoHome, 'registry', 'index');
      const parts = crateIndexPath(name.replace(/_/g, '-'));
      const partsUnderscore = crateIndexPath(name.replace(/-/g, '_'));
      for (const reg of fs.existsSync(indexRoot) ? fs.readdirSync(indexRoot) : []) {
        for (const p of [parts, partsUnderscore]) {
          if (fs.existsSync(path.join(indexRoot, reg, '.cache', ...p)) || fs.existsSync(path.join(indexRoot, reg, ...p))) return { exists: true, source: 'cache:cargo' };
        }
      }
    } else if (ecosystem === 'pypi') {
      const cacheRoot = env.UV_CACHE_DIR || (IS_WINDOWS && env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'uv', 'cache')
        : path.join(env.XDG_CACHE_HOME || path.join(home(), '.cache'), 'uv'));
      const n = normPypi(name);
      for (const simple of fs.existsSync(cacheRoot) ? fs.readdirSync(cacheRoot).filter((d) => /^simple-v\d+$/.test(d)) : []) {
        for (const index of fs.readdirSync(path.join(cacheRoot, simple))) {
          if (fs.existsSync(path.join(cacheRoot, simple, index, `${n}.rkyv`))) return { exists: true, source: 'cache:uv' };
        }
      }
    }
  } catch {
    // An unreadable cache is no evidence either way.
  }
  return null;
}

const firstLine = (s) => truncate(String(s || '').trim().split(/\r?\n/).filter(Boolean).slice(-1)[0] || '', 200);

/** Ask the ecosystem's own CLI. Returns { exists: true|false|null, source, detail? } or null when no tool exists. */
export function registryLookup(ecosystem, name, { root = null, env = process.env, timeoutMs = LOOKUP_TIMEOUT_MS } = {}) {
  const opts = { cwd: root || os.tmpdir(), env, timeoutMs };
  if (ecosystem === 'npm' && which('npm', env)) {
    const r = runShell(`npm view ${quoteArg(name)} name --json`, opts);
    if (r.exit === 0 && r.stdout.trim()) return { exists: true, source: 'registry:npm' };
    if (/\bE404\b|404 Not Found|is not in this registry/i.test(r.stderr + r.stdout)) return { exists: false, source: 'registry:npm' };
    return { exists: null, source: 'registry:npm', detail: firstLine(r.stderr || r.error) };
  }
  if (ecosystem === 'pypi') {
    if (which('uv', env)) {
      const uvEnv = { ...env, ...(env.PIP_INDEX_URL && !env.UV_INDEX_URL ? { UV_INDEX_URL: env.PIP_INDEX_URL } : {}) };
      const r = run('uv', ['pip', 'compile', '--no-header', '--no-annotate', '--quiet', '-'], { ...opts, cwd: os.tmpdir(), env: uvEnv, input: `${name}\n` });
      if (r.exit === 0) return { exists: true, source: 'registry:uv' };
      if (/was not found in the package registry/i.test(r.stderr)) return { exists: false, source: 'registry:uv' };
      if (!/network|connect|dns|timed out|offline/i.test(r.stderr)) {
        // Resolution failed for another reason (markers, Python version): the name exists.
        if (/no versions of|depends on|unsatisfiable/i.test(r.stderr)) return { exists: true, source: 'registry:uv', detail: 'resolution failed for another reason' };
      }
    }
    const pip = which('pip3', env) || which('pip', env);
    if (pip) {
      const r = run(pip, ['index', 'versions', name, '--disable-pip-version-check'], opts);
      if (r.exit === 0) return { exists: true, source: 'registry:pip' };
      // pip reports "No matching distribution" for missing names and for incompatible ones alike.
      return { exists: null, source: 'registry:pip', detail: firstLine(r.stderr) };
    }
    return null;
  }
  if (ecosystem === 'crates' && which('cargo', env)) {
    const r = run('cargo', ['info', name, '--quiet'], opts);
    if (r.exit === 0) return { exists: true, source: 'registry:cargo' };
    if (/could not find `[^`]+` in registry|no matching package named/i.test(r.stderr)) return { exists: false, source: 'registry:cargo' };
    return { exists: null, source: 'registry:cargo', detail: firstLine(r.stderr) };
  }
  if (ecosystem === 'go' && which('go', env)) {
    const r = run('go', ['list', '-m', '-json', `${name}@latest`], { ...opts, cwd: os.tmpdir(), env: { ...env, GOTOOLCHAIN: 'local', GOFLAGS: '-mod=mod', GO111MODULE: 'on' } });
    if (r.exit === 0) return { exists: true, source: 'registry:go' };
    if (/not found|\b404\b|\b410\b|unrecognized import path|no matching versions|repository not found|malformed module path|invalid version/i.test(r.stderr)) return { exists: false, source: 'registry:go' };
    return { exists: null, source: 'registry:go', detail: firstLine(r.stderr) };
  }
  if (ecosystem === 'rubygems' && which('gem', env)) {
    const r = runShell(`gem search --remote --exact ${quoteArg(name)}`, opts);
    if (r.exit === 0) {
      const found = r.stdout.split(/\r?\n/).some((l) => l.toLowerCase().startsWith(`${name.toLowerCase()} (`));
      return { exists: found, source: 'registry:gem' };
    }
    return { exists: null, source: 'registry:gem', detail: firstLine(r.stderr) };
  }
  if (ecosystem === 'nuget' && which('dotnet', env)) {
    const r = run('dotnet', ['package', 'search', name, '--exact-match', '--format', 'json'], opts);
    const j = r.exit === 0 ? jsonTry(r.stdout) : null;
    if (j && Array.isArray(j.searchResult)) {
      return { exists: j.searchResult.some((s) => (s.packages || []).length > 0), source: 'registry:dotnet' };
    }
    return { exists: null, source: 'registry:dotnet', detail: firstLine(r.stderr || r.stdout) };
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
];

/** Bare package name of a JS import specifier, or null for relative/builtin/aliased ones. */
export function jsPackageOf(spec) {
  const s = String(spec);
  if (!s || /^(?:\.|\/|#|~|@\/|\$|node:|bun:|deno:|virtual:|data:|https?:|npm:|jsr:|file:)/.test(s) || /[?!]/.test(s)) return null;
  const parts = s.split('/');
  const pkg = s.startsWith('@') ? (parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null) : parts[0];
  if (!pkg || NODE_BUILTINS.has(pkg)) return null;
  return pkg;
}

/** Go import paths in a file's text: [{ path, line }]. */
export function goImports(text) {
  const out = [];
  const lines = String(text ?? '').split(/\r?\n/);
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].replace(/\/\/.*$/, '').trim();
    if (inBlock) {
      if (l.startsWith(')')) { inBlock = false; continue; }
      const m = /^(?:[\w.]+\s+)?"([^"]+)"/.exec(l);
      if (m) out.push({ path: m[1], line: i + 1 });
      continue;
    }
    if (/^import\s*\($/.test(l)) { inBlock = true; continue; }
    const m = /^import\s+(?:[\w.]+\s+)?"([^"]+)"/.exec(l);
    if (m) out.push({ path: m[1], line: i + 1 });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Lock consistency via the package managers (in a temp worktree)

function lockTool(manager, offline, env) {
  const sh = (line) => ({ shell: true, line });
  switch (manager) {
    case 'npm': return which('npm', env) && sh(`npm ci --dry-run --ignore-scripts --no-audit --no-fund ${offline ? '--offline' : '--prefer-offline'}`);
    case 'pnpm': return which('pnpm', env) && sh(`pnpm install --frozen-lockfile --lockfile-only --ignore-scripts ${offline ? '--offline' : '--prefer-offline'}`);
    case 'uv': return which('uv', env) && { cmd: 'uv', args: ['lock', '--check', ...(offline ? ['--offline'] : [])] };
    case 'poetry': return which('poetry', env) && { cmd: 'poetry', args: ['check', '--lock', '--no-interaction'] };
    case 'go': return which('go', env) && { cmd: 'go', args: ['mod', 'tidy', '-diff'], env: { GOTOOLCHAIN: 'local', GOFLAGS: '-mod=mod', ...(offline ? { GOPROXY: 'off' } : {}) } };
    case 'cargo': return which('cargo', env) && { cmd: 'cargo', args: ['metadata', '--locked', '--format-version', '1', ...(offline ? ['--offline'] : [])] };
    case 'nuget': return !offline && which('dotnet', env) && { cmd: 'dotnet', args: ['restore', '--locked-mode'] };
    default: return null;
  }
}

const INCONSISTENT = [
  /can only install packages when your package\.json and package-lock\.json/i,
  /ERR_PNPM_OUTDATED_LOCKFILE|is not up to date with (?:<ROOT>[\\/])?package\.json|specifiers in the lockfile don't match/i,
  /lockfile at `[^`]*` needs to be updated/i,
  /changed significantly since poetry\.lock was last generated|poetry\.lock is not consistent with pyproject\.toml/i,
  /because --locked was passed|lock file needs to be updated/i,
  /\bNU1004\b/,
  /^diff \S+\/go\.(?:mod|sum) /m,
  /updates to go\.(?:mod|sum) needed|missing go\.sum entry/i,
];
const UNKNOWN = /ENOTCACHED|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|network (?:was )?disabled|GOPROXY=off|dial tcp|no such host|offline mode|unable to (?:get|fetch)|Could not resolve host|failed to (?:download|fetch|get)|requires go >=|flag provided but not defined|unexpected argument|unrecognized|timed? ?out/i;

/** Run one manager's frozen-lockfile check in `dir`. */
export function runLockTool(manager, dir, { offline = false, env = process.env, timeoutMs = TOOL_TIMEOUT_MS, secrets = [] } = {}) {
  const tool = lockTool(manager, offline, env);
  if (!tool) return { tool: manager, cmd: null, exit: null, status: 'unknown', detail: 'tool not available', ms: 0 };
  const res = tool.shell
    ? runShell(tool.line, { cwd: dir, env: { ...env, npm_config_update_notifier: 'false' }, timeoutMs })
    : run(tool.cmd, tool.args, { cwd: dir, env: { ...env, ...(tool.env || {}) }, timeoutMs });
  const cmd = tool.shell ? tool.line : [tool.cmd, ...tool.args].join(' ');
  const output = redactLiterals(redactSecrets(`${res.stdout}\n${res.stderr}`), secrets);
  let status;
  if (res.exit === 0) status = 'consistent';
  else if (INCONSISTENT.some((re) => re.test(output))) status = 'inconsistent';
  else status = 'unknown';
  if (status === 'inconsistent' && manager === 'go' && UNKNOWN.test(res.stderr) && !/^diff /m.test(res.stdout)) status = 'unknown';
  const detailLines = output.split(/\r?\n/).filter((l) => /missing|invalid|needs to be updated|not up to date|don't match|in sync|NU1004|^[-+]\s*\S|^diff /i.test(l));
  return {
    tool: manager, cmd, exit: res.exit, status, ms: res.ms, timed_out: res.timedOut,
    detail: truncate((detailLines.length ? detailLines.slice(0, 6).join(' | ') : firstLine(output)) || '', 500),
    output_sha256: sha256(output),
  };
}

// ---------------------------------------------------------------------------
// The check

const DEPS_FM = ['FM-04'];
const LOCK_FM = ['FM-12'];

/** Offline by default inside the Codex sandbox (network is off there) or when ADC_OFFLINE is set. */
export function defaultOffline(env = process.env) {
  if (env.ADC_OFFLINE && env.ADC_OFFLINE !== '0' && env.ADC_OFFLINE !== 'false') return true;
  return Object.keys(env).some((k) => k.startsWith('CODEX_SANDBOX'));
}

function liveSecrets(env) {
  return env.ADC_LIVE_TOKEN ? [{ name: 'ADC_LIVE_TOKEN', value: env.ADC_LIVE_TOKEN }] : [];
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
  // Callers that do not decide (verify passes its flag through) get the sandbox-aware default.
  if (offline == null) offline = defaultOffline(env);
  const root = target.root;
  const from = target.base.sha || emptyTree(root);
  const to = target.snapshot.commit;
  const pathspec = ['.', ...snapshotExcludes(target.state).map((p) => `:(top,exclude)${p}`)];
  const changes = diffNameStatus(root, from, to, pathspec);
  const headFiles = new Set(lsTree(root, to));
  const baseFiles = new Set(target.base.sha ? lsTree(root, from) : []);
  const changed = new Set(changes.map((c) => c.path));
  const secrets = liveSecrets(env);
  const content = new Map();
  const read = (rev, file) => {
    const k = `${rev}:${file}`;
    if (!content.has(k)) content.set(k, file ? showFile(root, rev, file) : null);
    return content.get(k);
  };
  const findings = [];
  // Specs and tool output can carry credentials (`git+https://<token>@host/...`): mask them everywhere.
  const clean = (text) => redactLiterals(redactSecrets(String(text ?? '')), secrets);
  const finding = (check, severity, file, line, message, evidence = '', rule = undefined) => {
    findings.push({ id: check, severity, file: file ? toPosix(file) : null, line: line ?? null, message: clean(message),
      evidence: truncate(clean(evidence), 240), ...(rule ? { rule } : {}) });
  };

  // 1. Manifests and their dependency deltas.
  const manifests = [];
  const newDeps = [];
  const unparsable = [];
  for (const c of changes) {
    if (c.status === 'D' || !isParsableManifest(c.path)) continue;
    const oldPath = c.oldPath || c.path;
    const before = parseManifest(oldPath, baseFiles.has(oldPath) ? read(from, oldPath) : null);
    const after = parseManifest(c.path, read(to, c.path));
    if (!after) {
      if (read(to, c.path) != null) {
        unparsable.push(toPosix(c.path));
        finding('CK-DEPS', 'finding', c.path, null, `${c.path} could not be parsed, so its dependencies were not checked`, '', 'deps.unparsable-manifest');
      }
      continue;
    }
    const delta = manifestDelta(before, after);
    const eco = after.ecosystem;
    manifests.push({ path: toPosix(c.path), ecosystem: eco, status: c.status, added: delta.added.length, removed: delta.removed.length, changed: delta.changed.length });
    const siblings = after.deps.map((d) => d.real || d.name);
    for (const d of delta.added) {
      newDeps.push({ name: d.real || d.name, declared_as: d.real ? d.name : undefined, ecosystem: eco, manifest: toPosix(c.path), section: d.section,
        spec: d.spec, old_spec: null, kind: d.kind, exists: null, source: null, lookalike_of: null, declared: true, siblings });
    }
    for (const r of delta.redirected) {
      finding('CK-DEPS', 'fail', c.path, null, `dependency "${r.dep.name}" was redirected from the registry (${r.old.spec}) to a ${r.dep.kind} source (${r.dep.spec}); a local stub can make tests pass without the real package`, `${r.dep.name}: ${r.old.spec} -> ${r.dep.spec}`, 'deps.redirected');
    }
    if (eco === 'go') {
      const oldReplaces = new Set((before?.replaces || []).map((r) => `${r.from}=>${r.to}`));
      const required = new Set(after.deps.map((d) => d.name));
      for (const r of after.replaces || []) {
        if (oldReplaces.has(`${r.from}=>${r.to}`)) continue;
        if (r.local && required.has(r.from)) finding('CK-DEPS', 'fail', c.path, null, `go.mod now replaces required module ${r.from} with the local directory ${r.to}`, `replace ${r.from} => ${r.to}`, 'deps.redirected');
        else finding('CK-DEPS', 'finding', c.path, null, `new replace directive: ${r.from} => ${r.to}${r.toVersion ? ` ${r.toVersion}` : ''}`, `replace ${r.from} => ${r.to}`, 'deps.replace');
      }
    }
  }

  // 2. Imports of undeclared packages (JS/TS, Go) on added lines.
  const lines = diffLines(root, from, to, pathspec);
  const npmManifestCache = new Map();
  const nearestManifest = (file, name) => {
    let dir = path.posix.dirname(file);
    for (;;) {
      const cand = dir === '.' ? name : `${dir}/${name}`;
      if (headFiles.has(cand)) return cand;
      if (dir === '.' || dir === '') return null;
      dir = path.posix.dirname(dir);
    }
  };
  const npmDeclared = (manifestPath) => {
    if (npmManifestCache.has(manifestPath)) return npmManifestCache.get(manifestPath);
    const set = new Set();
    const aliases = [];
    const addFrom = (p) => {
      const parsed = parseManifest(p, read(to, p));
      if (!parsed) return;
      for (const d of parsed.deps) set.add(d.name);
      if (parsed.packageName) set.add(parsed.packageName);
    };
    addFrom(manifestPath);
    if (headFiles.has('package.json')) addFrom('package.json');
    const pkgJsons = [...headFiles].filter((f) => f.endsWith('package.json') && !f.includes('node_modules/')).slice(0, 300);
    for (const p of pkgJsons) {
      const j = jsonTry(read(to, p) || '');
      if (j && typeof j.name === 'string') set.add(j.name);
    }
    for (const ts of ['tsconfig.json', 'jsconfig.json', `${path.posix.dirname(manifestPath)}/tsconfig.json`]) {
      if (!headFiles.has(ts)) continue;
      const j = parseJsonc(read(to, ts) || '');
      for (const k of Object.keys(j?.compilerOptions?.paths || {})) aliases.push(k.replace(/\*.*$/, ''));
    }
    const out = { names: set, aliases: aliases.filter(Boolean) };
    npmManifestCache.set(manifestPath, out);
    return out;
  };
  const seenImports = new Set();
  for (const f of lines) {
    if (f.binary || !f.added.length || f.status === 'D') continue;
    const cls = classifyPath(f.path);
    if (cls.generated) continue;
    if (/\.(?:[cm]?[jt]sx?|vue|svelte)$/.test(f.path)) {
      const manifest = nearestManifest(f.path, 'package.json');
      if (!manifest) continue;
      const declared = npmDeclared(manifest);
      for (const a of f.added) {
        for (const re of JS_IMPORT_RES) {
          re.lastIndex = 0;
          let m;
          while ((m = re.exec(a.text))) {
            if (declared.aliases.some((a) => m[1] === a.replace(/\/$/, '') || m[1].startsWith(a))) continue;
            const pkg = jsPackageOf(m[1]);
            if (!pkg || declared.names.has(pkg)) continue;
            const key = `${manifest}:${pkg}`;
            if (seenImports.has(key)) continue;
            seenImports.add(key);
            newDeps.push({ name: pkg, ecosystem: 'npm', manifest, section: 'import', spec: null, old_spec: null, kind: 'registry', exists: null,
              source: null, lookalike_of: null, declared: false, imported_at: `${toPosix(f.path)}:${a.line}`, siblings: [...declared.names] });
          }
        }
      }
    } else if (f.path.endsWith('.go')) {
      const gomod = nearestManifest(f.path, 'go.mod');
      if (!gomod) continue;
      const parsed = parseManifest(gomod, read(to, gomod));
      if (!parsed) continue;
      const addedLines = new Set(f.added.map((a) => a.line));
      const required = parsed.deps.map((d) => d.name);
      for (const imp of goImports(read(to, f.path))) {
        if (!addedLines.has(imp.line)) continue;
        const first = imp.path.split('/')[0];
        if (!first.includes('.')) continue; // standard library
        if (parsed.packageName && (imp.path === parsed.packageName || imp.path.startsWith(`${parsed.packageName}/`))) continue;
        if (required.some((r) => imp.path === r || imp.path.startsWith(`${r}/`))) continue;
        const key = `${gomod}:${imp.path}`;
        if (seenImports.has(key)) continue;
        seenImports.add(key);
        newDeps.push({ name: imp.path, ecosystem: 'go', manifest: gomod, section: 'import', spec: null, old_spec: null, kind: 'registry', exists: null,
          source: null, lookalike_of: null, declared: false, imported_at: `${toPosix(f.path)}:${imp.line}`, siblings: required });
      }
    }
  }

  // 3. Existence (lockfile => cache => resolver/registry) and look-alikes. A lock entry that
  // already existed at the base is proof enough; one added by this change may be hand-written
  // (a fabricated package plus a fabricated lock entry), so it only counts after the cache or
  // the registry confirms the name.
  let lookups = 0;
  const lockCache = new Map();
  const lockFor2 = (manifest) => {
    const lock = lockFor(manifest, headFiles);
    if (!lock) return null;
    if (!lockCache.has(lock)) {
      lockCache.set(lock, { head: lockIndex(lock, read(to, lock)), base: baseFiles.has(lock) ? lockIndex(lock, read(from, lock)) : null });
    }
    const c = lockCache.get(lock);
    return { lock, idx: c.head, baseIdx: c.base };
  };
  const registryHosts = npmRegistryHosts(root, env);
  for (const d of newDeps) {
    d.lookalike_of = lookalikeOf(d.ecosystem, d.name, d.siblings || []);
    delete d.siblings;
    if (d.kind === 'workspace') { d.source = 'workspace'; continue; }
    if (['local', 'git', 'url'].includes(d.kind)) { d.source = d.kind; continue; }
    const lk = lockFor2(d.manifest);
    const importer = lk ? (path.posix.relative(path.posix.dirname(lk.lock) === '.' ? '' : path.posix.dirname(lk.lock), path.posix.dirname(d.manifest)) || '.') : '.';
    const probe = { name: d.name, spec: d.spec && d.ecosystem === 'go' ? d.spec : '*' };
    if (lk && lk.idx.ok && lockHas(lk.idx, d.ecosystem, probe, { importer })) {
      const entry = lk.idx.names.get(normName(d.ecosystem, d.name))?.[0] || {};
      if (entry.link || entry.local) { d.source = 'workspace'; continue; }
      if (entry.resolved && /^https?:/.test(entry.resolved)) { try { d.resolved_host = new URL(entry.resolved).host; } catch { /* not a URL */ } }
      const baseHas = Boolean(lk.baseIdx && lk.baseIdx.ok && lk.baseIdx.names.has(normName(d.ecosystem, d.name)));
      if (baseHas) { d.exists = true; d.source = `lockfile:${lk.lock}`; continue; }
      d.lock_entry = 'new';
      if (d.ecosystem === 'npm' && d.resolved_host && !registryHosts.has(d.resolved_host)) d.unexpected_host = true;
    }
    const cached = cacheLookup(d.ecosystem, d.name, { root, env });
    if (cached) { d.exists = true; d.source = cached.source; continue; }
    if (resolver) {
      const r = await resolver(d.ecosystem, d.name, { spec: d.spec, root });
      const norm = typeof r === 'boolean' ? { exists: r, source: 'resolver' } : r || { exists: null, source: 'resolver' };
      d.exists = norm.exists ?? null;
      d.source = norm.source || 'resolver';
      continue;
    }
    if (offline) { d.source = d.lock_entry ? `offline (new entry in ${lk.lock})` : 'offline'; continue; }
    if (lookups >= maxLookups) { d.source = 'lookup-cap'; continue; }
    lookups++;
    const r = registryLookup(d.ecosystem, d.name, { root, env });
    if (!r) { d.source = 'no-registry-tool'; continue; }
    d.exists = r.exists;
    d.source = r.source;
    if (r.detail) d.detail = redactLiterals(r.detail, secrets);
  }
  for (const d of newDeps) {
    const where = d.imported_at || d.manifest;
    const [file, line] = d.imported_at ? [d.imported_at.replace(/:\d+$/, ''), Number(d.imported_at.split(':').pop())] : [d.manifest, null];
    if (d.exists === false) finding('CK-DEPS', 'fail', file, line, `${d.ecosystem} package "${d.name}" does not exist (${d.source})${d.lock_entry ? ' although the change added it to the lockfile' : ''}${d.lookalike_of ? `; it looks like "${d.lookalike_of}"` : ''}`, `${d.name}${d.spec ? ` ${d.spec}` : ''}`, 'deps.nonexistent');
    if (d.unexpected_host) finding('CK-DEPS', 'finding', file, line, `new lockfile entry for "${d.name}" resolves from ${d.resolved_host}, which is not a configured npm registry`, `${d.name} -> ${d.resolved_host}`, 'deps.unexpected-host');
    else if (d.lookalike_of) finding('CK-DEPS', 'finding', file, line, `new ${d.ecosystem} dependency "${d.name}" looks like "${d.lookalike_of}"; confirm it is the intended package`, d.name, 'deps.lookalike');
    if (!d.declared && d.exists !== false) finding('CK-DEPS', 'finding', file, line, `imports ${d.ecosystem} package "${d.name}" that ${d.ecosystem === 'go' ? 'go.mod does not require' : `${d.manifest} does not declare`}`, where, 'deps.undeclared-import');
    if (d.declared && ['local', 'git', 'url'].includes(d.kind)) finding('CK-DEPS', 'finding', file, line, `new dependency "${d.name}" comes from a ${d.kind} source (${d.spec}), not the registry`, `${d.name} ${d.spec}`, 'deps.non-registry');
    if (d.exists === null && d.declared && d.kind === 'registry') finding('CK-DEPS', 'info', file, line, `could not verify that "${d.name}" exists (${d.source}); run the registry lookup by hand`, d.name, 'deps.unverified');
  }

  // 4. Lockfile consistency for every project whose manifest or lockfile changed.
  const projects = new Map();
  for (const c of changes) {
    if (c.status === 'D') continue;
    if (isParsableManifest(c.path)) {
      const lock = lockFor(c.path, headFiles);
      if (lock) projects.set(lock, { lock, manifests: new Set([...(projects.get(lock)?.manifests || []), c.path]) });
      else {
        const parsed = parseManifest(c.path, read(to, c.path));
        const registryDeps = (parsed?.deps || []).filter((d) => d.kind === 'registry' || d.kind === 'alias');
        const needs = goSumNeeded(parsed);
        if (needs.length) {
          // Go refuses to build without checksums: a go.mod with requirements needs its go.sum.
          const dir = path.posix.dirname(c.path);
          const lock = dir === '.' ? 'go.sum' : `${dir}/go.sum`;
          projects.set(lock, { lock, manifests: new Set([c.path]), absent: needs.map((d) => `${d.name}@${d.spec}`) });
        } else if (parsed?.ecosystem === 'npm' && registryDeps.length) {
          finding('CK-LOCK', 'info', c.path, null, `${c.path} declares ${registryDeps.length} registry dependencies but the project has no lockfile; installs are not reproducible`, '', 'lock.missing');
        }
      }
    } else if (lockManager(c.path)) {
      if (!projects.has(c.path)) projects.set(c.path, { lock: c.path, manifests: new Set() });
    }
  }
  const lockReports = [];
  let headWorktree = null;
  let baseWorktree = null;
  // A nonce keeps concurrent runs on the same snapshot (verify plus a manual deps-check) apart.
  const wtRoot = path.join(tmpRoot(root), `deps-${String(target.snapshot.tree).slice(0, 12)}-${nonce().slice(0, 8)}`);
  try {
    for (const { lock, manifests: ms, absent } of projects.values()) {
      const manager = lockManager(lock);
      const dir = path.posix.dirname(lock);
      const idx = lockCache.get(lock)?.head || lockIndex(lock, read(to, lock));
      const report = { path: toPosix(lock), manager, project: dir, changed: changed.has(lock), static: { status: 'unknown', missing: [], mismatched: [] }, tool: null, status: 'unknown' };
      if (absent) {
        report.static.status = 'inconsistent';
        report.static.missing = absent;
        report.absent = true;
      } else if (/\.lockb$/.test(lock)) {
        report.static.status = 'unsupported';
      } else if (!idx.ok) {
        report.static.status = read(to, lock) == null ? 'unknown' : 'unparsable';
      } else {
        // Manifests of the project: the changed ones plus the one next to the lock.
        const manifestPaths = new Set(ms);
        for (const n of ['package.json', 'pyproject.toml', 'Pipfile', 'go.mod', 'Cargo.toml', 'Gemfile', 'composer.json']) {
          const cand = dir === '.' ? n : `${dir}/${n}`;
          if (headFiles.has(cand) && lockFor(cand, headFiles) === lock) manifestPaths.add(cand);
        }
        let checkedAny = false;
        for (const mp of manifestPaths) {
          const parsed = parseManifest(mp, read(to, mp));
          if (!parsed) continue;
          const importer = path.posix.relative(dir === '.' ? '' : dir, path.posix.dirname(mp)) || '.';
          for (const d of parsed.deps) {
            if (!['registry', 'alias'].includes(d.kind) || d.section === 'peerDependencies') continue;
            if (parsed.ecosystem === 'go' && d.section === 'require-indirect') continue;
            checkedAny = true;
            if (!lockHas(idx, parsed.ecosystem, d, { importer })) report.static.missing.push(`${d.name}${d.spec && d.spec !== '*' ? `@${d.spec}` : ''}`);
          }
          // npm/bun record the root's dependency specs verbatim; a different spec is drift.
          if ((idx.manager === 'npm' || idx.manager === 'bun') && idx.root && mp === (dir === '.' ? 'package.json' : `${dir}/package.json`)) {
            for (const d of parsed.deps) {
              if (d.section === 'peerDependencies') continue;
              if (d.name in idx.root && idx.root[d.name] !== d.spec) report.static.mismatched.push(`${d.name}: manifest ${d.spec}, lock ${idx.root[d.name]}`);
            }
            const declared = new Set(parsed.deps.filter((d) => d.section !== 'peerDependencies').map((d) => d.name));
            for (const n of Object.keys(idx.root)) if (!declared.has(n) && !parsed.deps.some((d) => d.name === n)) report.static.mismatched.push(`${n}: in lock, not in manifest`);
          }
        }
        report.static.status = !checkedAny && !report.static.mismatched.length ? 'consistent'
          : report.static.missing.length || report.static.mismatched.length ? 'inconsistent' : 'consistent';
      }
      if (tools && lockTool(manager, offline, env)) {
        if (!headWorktree) headWorktree = worktreeAdd(root, to, path.join(wtRoot, 'head'));
        const toolEnv = { ...env };
        report.tool = runLockTool(manager, path.join(headWorktree, ...(dir === '.' ? [] : dir.split('/'))), { offline, env: toolEnv, timeoutMs, secrets });
        if (report.tool.status === 'inconsistent' && target.base.sha && baseFiles.has(lock)) {
          if (!baseWorktree) baseWorktree = worktreeAdd(root, from, path.join(wtRoot, 'base'));
          const baseRes = runLockTool(manager, path.join(baseWorktree, ...(dir === '.' ? [] : dir.split('/'))), { offline, env: toolEnv, timeoutMs, secrets });
          report.tool.base_status = baseRes.status;
        }
      }
      const toolStatus = report.tool?.status;
      if (report.static.status === 'inconsistent' || toolStatus === 'inconsistent') report.status = 'inconsistent';
      else if (report.static.status === 'consistent' && toolStatus !== 'unknown') report.status = 'consistent';
      else if (toolStatus === 'consistent') report.status = 'consistent';
      else if (report.static.status === 'consistent') report.status = 'consistent';
      else if (report.static.status === 'unsupported') report.status = 'unsupported';
      else report.status = 'unknown';
      if (report.status === 'inconsistent') {
        const preexisting = report.tool?.base_status === 'inconsistent' && report.static.status !== 'inconsistent';
        const detail = [...report.static.missing.map((m) => `missing ${m}`), ...report.static.mismatched, report.tool?.status === 'inconsistent' ? report.tool.detail : ''].filter(Boolean).join('; ');
        finding('CK-LOCK', preexisting ? 'finding' : 'fail', lock, null,
          report.absent ? `${lock} is missing although ${[...ms][0]} requires ${report.static.missing.length} module(s)`
            : preexisting ? `${lock} was already inconsistent at the base (${manager}); not caused by this change` : `${lock} is not consistent with its manifest (${manager})`,
          detail, report.absent ? 'lock.missing' : preexisting ? 'lock.preexisting' : 'lock.inconsistent');
      }
      lockReports.push(report);
    }
  } finally {
    if (headWorktree) worktreeRemove(root, headWorktree);
    if (baseWorktree) worktreeRemove(root, baseWorktree);
  }
  const judged = lockReports.filter((r) => r.status !== 'unsupported');
  const lockStatus = !lockReports.length ? 'unchanged'
    : !judged.length ? 'unsupported'
      : judged.some((r) => r.status === 'inconsistent') ? 'inconsistent'
        : judged.every((r) => r.status === 'consistent') ? 'consistent' : 'unknown';

  // 5. Checks.
  const ms = Date.now() - started;
  const command = `git diff --name-status ${String(from).slice(0, 12)} ${String(to).slice(0, 12)} (manifests, lockfiles)`;
  const mk = (id, fm, own, status, summary, data, reason) => ({
    id, fm, project: '.', status, ...(reason ? { reason } : {}), cost: 0, command, cwd: toPosix(root), exit_code: 0, duration_ms: ms,
    summary, output_sha256: sha256(asciiJson(own, 0)), artifacts: [], findings: own, data,
  });
  const depsFindings = findings.filter((f) => f.id === 'CK-DEPS');
  const unverifiedDeps = newDeps.filter((d) => d.exists === null && d.declared && d.kind === 'registry');
  let depsStatus = depsFindings.some((f) => f.severity === 'fail') ? 'fail'
    : unverifiedDeps.length || unparsable.length ? 'unverified' : depsFindings.some((f) => f.severity === 'finding') ? 'finding' : 'pass';
  const depsSummary = !newDeps.length ? 'no new dependencies or undeclared imports'
    : `${newDeps.length} new dependenc${newDeps.length === 1 ? 'y' : 'ies'}: ${newDeps.filter((d) => d.exists === true).length} verified, ${newDeps.filter((d) => d.exists === false).length} nonexistent, ${unverifiedDeps.length} unverified${offline ? ' (offline)' : ''}, ${newDeps.filter((d) => d.lookalike_of).length} look-alike`;
  const lockFindings = findings.filter((f) => f.id === 'CK-LOCK');
  const lockCheckStatus = lockFindings.some((f) => f.severity === 'fail') ? 'fail'
    : lockStatus === 'unknown' ? 'unverified' : lockFindings.some((f) => f.severity === 'finding') ? 'finding'
      : lockStatus === 'unsupported' ? 'skipped' : 'pass';
  const lockSummary = lockStatus === 'unchanged' ? 'no manifest or lockfile changes'
    : `${lockReports.length} lockfile(s): ${lockReports.map((r) => `${r.path} ${r.status}${r.tool?.cmd ? ` (${r.manager} ${r.tool.status})` : ''}`).join(', ')}`;
  const checks = [
    mk('CK-DEPS', DEPS_FM, depsFindings, depsStatus, depsSummary, { offline, new_deps: newDeps.length, lookups }, depsStatus === 'unverified' ? (unparsable.length && !unverifiedDeps.length ? 'MANIFEST_UNPARSABLE' : offline ? 'OFFLINE' : 'REGISTRY_UNVERIFIED') : null),
    mk('CK-LOCK', LOCK_FM, lockFindings, lockCheckStatus, lockSummary, { part: 'consistency', lock_status: lockStatus, lockfiles: lockReports.length },
      lockCheckStatus === 'unverified' ? 'LOCK_UNVERIFIED' : lockCheckStatus === 'skipped' ? 'UNSUPPORTED_LOCKFILE' : null),
  ];
  return {
    base: { ref: target.base.ref, sha: target.base.sha, source: target.base.source },
    tree_digest: target.snapshot.tree,
    offline,
    manifests,
    new_deps: newDeps.map((d) => ({ ...d, ...(d.spec != null ? { spec: clean(d.spec) } : {}), ...(d.detail ? { detail: clean(d.detail) } : {}) })),
    lock_status: { status: lockStatus, lockfiles: lockReports.map((r) => ({ ...r, static: { ...r.static, missing: r.static.missing.map(clean), mismatched: r.static.mismatched.map(clean) } })) },
    ...(unparsable.length ? { unparsable } : {}),
    findings,
    counts: { manifests: manifests.length, new_deps: newDeps.length, registry_lookups: lookups, lockfiles: lockReports.length },
    checks,
  };
}

// ---------------------------------------------------------------------------
// Command

const USAGE = `usage: adc.mjs deps-check [--base <ref>] [--offline | --online] [--static-only] [--json]

New and changed dependencies in the working-tree snapshot vs the base: existence
(lockfile, local package-manager cache, then npm view / uv / pip index / cargo info /
go list -m / gem search), look-alike names, undeclared imports, and lockfile consistency
(static parse plus npm ci --dry-run, pnpm --frozen-lockfile, uv lock --check, poetry check
--lock, go mod tidy -diff, cargo metadata --locked in a temp worktree).
--offline is the default inside the Codex sandbox (CODEX_SANDBOX*) and with ADC_OFFLINE=1.
Exit: 0 pass, 1 failures or findings, 4 could not verify (offline and unresolved).`;

export const depsCheckCommand = defineCommand({
  name: 'deps-check',
  usage: USAGE,
  options: { base: { type: 'string' }, offline: { type: 'boolean' }, online: { type: 'boolean' }, 'static-only': { type: 'boolean' } },
  positionals: false,
  async run(ctx, values) {
    const offline = values.online ? false : (values.offline || defaultOffline());
    const target = await prepareTarget(ctx, { base: values.base, createState: !ctx.dryRun });
    const res = await depsCheck({ target, offline, tools: !values['static-only'] });
    const failed = res.checks.some((c) => c.status === 'fail' || c.status === 'finding');
    const unverified = res.checks.some((c) => c.status === 'unverified');
    const exit = failed ? EXIT.FINDINGS : unverified ? EXIT.UNVERIFIABLE : EXIT.OK;
    const human = [
      `deps-check ${res.base.ref || 'empty'}..snapshot ${String(res.tree_digest).slice(0, 12)}${offline ? ' (offline)' : ''}`,
      ...res.checks.map((c) => `  ${c.id.padEnd(9)} ${c.status.padEnd(10)} ${c.summary}`),
      ...res.findings.filter((f) => f.severity !== 'info').map((f) => `  - [${f.severity}] ${f.id} ${f.file || ''}${f.line ? `:${f.line}` : ''} ${f.message}`),
    ].join('\n');
    return { result: res, exit, summary: res.checks.map((c) => `${c.id} ${c.status}`).join(', '), human };
  },
});
