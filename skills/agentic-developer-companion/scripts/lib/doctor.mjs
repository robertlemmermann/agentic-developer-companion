// Environment and installation diagnostics (§6.6, §6.7, §8.6): host guess, OS, Node and Git,
// host CLIs against their floors, every prerequisite with the fallback in effect, every installed
// copy (with discovery confirmed by `copilot skill list --json` and `codex debug prompt-input`),
// registered hooks, launcher probes, the state dir, and `--verify-vendored` drift checks.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  EXIT, AdcError, usageError, unverifiable, defineCommand, readText, readJson, toPosix, relPosix, truncate,
  which, toolVersion, parseVersion, versionGte, quoteArg, nonce, IS_WINDOWS, SKILL_DIR, SKILL_NAME, ADC_SCRIPT,
  ASSETS_DIR, skillVersion, agentMarkers, runClass as runClassOf,
} from './core.mjs';
import { gitTry, gitRaw, gitVersion, repoRoot, resolveBase, lsFiles, gitPath, MIN_GIT } from './git.mjs';
import {
  resolveStateDir, statePaths, trackedStateFiles, stateIgnored, credentialStatus, checkOwnerOnly,
  prepareStateDir, materializeTemplates, newestOpenSession, parseEnvFile, DEFAULT_BUDGET,
} from './state.mjs';
import { spawnCapture, loadBudget, effectiveCaps, budgetView, makeRedactor, redactValue } from './live.mjs';

/** Prerequisite ids (assets/prerequisites.json) whose tools doctor runs or looks up on PATH. */
export const PROBED_TOOLS = Object.freeze([
  'git', 'node', 'gh', 'npx-skills', 'secret-scanner', 'diff-cover', 'mutation-tools', 'flake-tools',
  'external-validators', 'eval-runners', 'pwsh', 'git-bash', 'copilot', 'vscode', 'claude', 'codex',
]);

const MIN_NODE = '24.0.0';
const DISCOVERY_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 20_000;
const NONCE_RE = /^[A-Za-z0-9]{1,64}$/;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ---------------------------------------------------------------------------
// Host and runtime

/** Host guess from environment marker names (§8.4): `{ host, hooks_host, markers[], candidates[] }`. */
export function guessHostEnv(env = process.env) {
  const on = (k) => env[k] != null && env[k] !== '' && env[k] !== '0' && env[k] !== 'false';
  const keys = Object.keys(env).filter(on);
  const found = [];
  const add = (host, markers) => { if (markers.length) found.push({ host, markers }); };
  add('copilot-cloud', keys.filter((k) => k === 'COPILOT_AGENT_PROMPT' || k === 'GITHUB_COPILOT_API_TOKEN'));
  add('copilot-cli', keys.filter((k) => k === 'COPILOT_CLI'));
  // CLAUDE_CONFIG_DIR and CODEX_HOME are configuration that shell profiles set, not session markers.
  add('claude-code', keys.filter((k) => k === 'CLAUDECODE' || (k.startsWith('CLAUDE_') && k !== 'CLAUDE_CONFIG_DIR')));
  add('codex', keys.filter((k) => k.startsWith('CODEX_') && k !== 'CODEX_HOME'));
  add('vscode', keys.filter((k) => (k === 'TERM_PROGRAM' && env[k] === 'vscode') || k === 'VSCODE_IPC_HOOK_CLI'));
  const first = found[0] || null;
  const hooksHost = { 'copilot-cloud': 'copilot-cloud', 'copilot-cli': 'copilot', vscode: 'copilot', 'claude-code': 'claude', codex: 'codex' };
  return { host: first ? first.host : null, hooks_host: first ? hooksHost[first.host] : null, markers: first ? first.markers : [], candidates: found.map((f) => f.host) };
}

// Node release lines and their end of life (nodejs.org release schedule).
const NODE_EOL = { 24: '2028-04-30', 25: '2026-06-01', 26: '2029-04-30', 27: '2027-06-01', 28: '2030-04-30' };

/** `{ version, lts, eol, warning }` for a Node version string. */
export function nodeEol(version, now = new Date()) {
  const major = Number(String(version).replace(/^v/, '').split('.')[0]);
  const eol = NODE_EOL[major] || null;
  const lts = major % 2 === 0;
  let warning = null;
  if (!versionGte(String(version).replace(/^v/, ''), MIN_NODE)) warning = `Node ${version} is below the required ${MIN_NODE}`;
  else if (eol && eol < now.toISOString().slice(0, 10)) warning = `Node ${major} reached end of life on ${eol}; upgrade to the current LTS`;
  else if (eol && Date.parse(eol) - now.getTime() < 180 * 86_400_000) warning = `Node ${major} reaches end of life on ${eol}; plan the upgrade`;
  else if (!lts) warning = `Node ${major} is an odd-numbered line (never LTS); use an LTS release`;
  return { major, lts, eol, warning };
}

function osInfo(env) {
  let wsl = false;
  if (process.platform === 'linux') wsl = /microsoft/i.test(readText('/proc/version', '') || '') || Boolean(env.WSL_DISTRO_NAME);
  return {
    platform: process.platform, release: os.release(), arch: process.arch, wsl,
    shell: IS_WINDOWS ? (env.ComSpec ? path.basename(env.ComSpec) : null) : (env.SHELL ? path.basename(env.SHELL) : null),
  };
}

// ---------------------------------------------------------------------------
// Frontmatter (frontmatter.mjs when present; a small fallback for the SKILL.md subset otherwise)

function unquote(s) {
  const t = s.trim();
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) { try { return JSON.parse(t); } catch { return t.slice(1, -1); } }
  return null;
}

function plainScalar(s) {
  const q = unquote(s);
  if (q !== null) return q;
  const t = s.replace(/\s+#.*$/, '').trim();
  if (t === '' || /^(?:~|null)$/i.test(t)) return null;
  if (/^(?:true|false)$/i.test(t)) return /^true$/i.test(t);
  if (/^[-+]?\d+$/.test(t)) return Number(t);
  if (/^[-+]?(?:\.\d+|\d+\.\d*)(?:[eE][-+]?\d+)?$/.test(t)) return Number(t);
  if (/^\[.*\]$/.test(t)) return t.slice(1, -1).split(',').map((x) => x.trim()).filter(Boolean).map(plainScalar);
  return t;
}

const indentOf = (l) => l.length - l.trimStart().length;

function miniYaml(lines) {
  const root = {};
  const stack = [{ indent: -1, obj: root }];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const ind = indentOf(line);
    const m = /^\s*("[^"]*"|'[^']*'|[^:#\s][^:]*?):(?:\s+(.*))?$/.exec(line);
    if (!m) continue;
    while (stack.length > 1 && ind <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].obj;
    const key = unquote(m[1]) ?? m[1].trim();
    const v = m[2] == null ? '' : m[2];
    const next = lines.slice(i + 1).find((l) => l.trim() && !/^\s*#/.test(l));
    if (v.trim() === '') {
      if (next && /^\s*-\s/.test(next) && indentOf(next) >= ind) {
        const list = [];
        let j = i + 1;
        for (; j < lines.length; j++) {
          const l = lines[j];
          if (!l.trim()) continue;
          const lm = /^\s*-\s+(.*)$/.exec(l);
          if (!lm || indentOf(l) < ind) break;
          list.push(plainScalar(lm[1]));
        }
        parent[key] = list;
        i = j - 1;
      } else if (next && indentOf(next) > ind) {
        const obj = {};
        parent[key] = obj;
        stack.push({ indent: ind, obj });
      } else parent[key] = null;
      continue;
    }
    const block = /^([|>])([+-]?)\s*$/.exec(v.trim());
    if (block) {
      const body = [];
      let j = i + 1;
      let bi = null;
      for (; j < lines.length; j++) {
        const l = lines[j];
        if (!l.trim()) { body.push(''); continue; }
        if (indentOf(l) <= ind) break;
        if (bi == null) bi = indentOf(l);
        body.push(l.slice(bi));
      }
      i = j - 1;
      while (body.length && body[body.length - 1] === '') body.pop();
      let text = '';
      if (block[1] === '|') text = body.join('\n');
      else {
        for (let k = 0; k < body.length; k++) {
          if (body[k] === '') text += '\n';
          else text += (k > 0 && body[k - 1] !== '' ? ' ' : '') + body[k];
        }
      }
      parent[key] = block[2] === '-' ? text : `${text}\n`;
      continue;
    }
    parent[key] = plainScalar(v);
  }
  return root;
}

function fallbackParseFrontmatter(text) {
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/);
  if (!/^---\s*$/.test(lines[0])) return { data: {}, body: lines.join('\n'), errors: [], hasFrontmatter: false };
  const close = lines.findIndex((l, i) => i > 0 && /^---\s*$/.test(l));
  if (close < 0) return { data: {}, body: '', errors: [{ message: 'unclosed frontmatter' }], hasFrontmatter: true };
  return { data: miniYaml(lines.slice(1, close)), body: lines.slice(close + 1).join('\n'), errors: [], hasFrontmatter: true };
}

const INSTALL_KEY = /^(?:github-[a-z0-9-]+|local-path)$/;
function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (!isObj(v)) return v;
  return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortDeep(v[k])]));
}
function fallbackNormalize(data) {
  if (!isObj(data)) return data;
  const copy = { ...data };
  if (isObj(copy.metadata)) {
    const meta = Object.fromEntries(Object.entries(copy.metadata).filter(([k]) => !INSTALL_KEY.test(k)));
    if (Object.keys(meta).length) copy.metadata = meta; else delete copy.metadata;
  }
  return sortDeep(copy);
}

let fmLib = null;
async function frontmatterLib() {
  if (fmLib) return fmLib;
  try {
    const m = await import('./frontmatter.mjs');
    if (typeof m.parseFrontmatter === 'function') {
      fmLib = { parse: m.parseFrontmatter, normalize: typeof m.normalizeSkillFrontmatter === 'function' ? m.normalizeSkillFrontmatter : fallbackNormalize, source: 'frontmatter.mjs' };
      return fmLib;
    }
  } catch {}
  fmLib = { parse: fallbackParseFrontmatter, normalize: fallbackNormalize, source: 'fallback' };
  return fmLib;
}

/** Install provenance from parsed frontmatter: `{ local_path, github: {key: value} }` or null. */
export function provenanceOf(data) {
  const meta = isObj(data) && isObj(data.metadata) ? data.metadata : {};
  const github = Object.fromEntries(Object.entries(meta).filter(([k]) => /^github-/.test(k)).map(([k, v]) => [k, v == null ? null : String(v)]));
  const local = meta['local-path'] != null ? String(meta['local-path']) : null;
  if (!local && !Object.keys(github).length) return null;
  return { ...(local ? { local_path: toPosix(local) } : {}), ...(Object.keys(github).length ? { github } : {}) };
}

// ---------------------------------------------------------------------------
// Installed copies (§3.1 discovery directories)

function homes(env) {
  const h = (IS_WINDOWS ? env.USERPROFILE : env.HOME) || os.homedir();
  return {
    home: h,
    copilot: env.COPILOT_HOME ? path.resolve(env.COPILOT_HOME) : path.join(h, '.copilot'),
    claude: env.CLAUDE_CONFIG_DIR ? path.resolve(env.CLAUDE_CONFIG_DIR) : path.join(h, '.claude'),
    codex: env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(h, '.codex'),
  };
}

const PROJECT_DIRS = [
  ['.github/skills', ['copilot-cli', 'vscode', 'copilot-cloud', 'copilot-code-review']],
  ['.agents/skills', ['copilot-cli', 'vscode', 'copilot-cloud', 'codex']],
  ['.claude/skills', ['claude-code', 'copilot-cli', 'vscode', 'copilot-cloud']],
  ['.codex/skills', ['codex']],
];

/** Skill directories each host scans, from the repository (cwd up to the root) and the user's homes. */
export function discoveryDirs({ root = null, cwd = process.cwd(), env = process.env } = {}) {
  const out = [];
  const add = (dir, scope, location, hosts) => {
    const abs = path.resolve(dir);
    if (!out.some((o) => o.dir === abs)) out.push({ dir: abs, scope, location, hosts });
  };
  if (root) {
    const chain = [];
    for (let d = path.resolve(cwd); ; d = path.dirname(d)) {
      if (relPosix(root, d) == null) break;
      chain.push(d);
      if (path.resolve(d) === path.resolve(root) || path.dirname(d) === d) break;
    }
    if (!chain.length) chain.push(root);
    for (const d of chain) for (const [rel, hosts] of PROJECT_DIRS) add(path.join(d, ...rel.split('/')), 'project', rel, hosts);
  }
  const h = homes(env);
  add(path.join(h.copilot, 'skills'), 'user', '~/.copilot/skills', ['copilot-cli', 'vscode']);
  add(path.join(h.home, '.agents', 'skills'), 'user', '~/.agents/skills', ['copilot-cli', 'vscode', 'codex']);
  add(path.join(h.claude, 'skills'), 'user', '~/.claude/skills', ['claude-code', 'vscode']);
  add(path.join(h.codex, 'skills'), 'user', '~/.codex/skills', ['codex']);
  for (const d of String(env.COPILOT_SKILLS_DIRS || '').split(',').map((s) => s.trim()).filter(Boolean)) add(d, 'env', 'COPILOT_SKILLS_DIRS', ['copilot-cli']);
  for (const name of ['settings.json', 'config.json']) {
    const cfg = readJson(path.join(h.copilot, name), null);
    const dirs = isObj(cfg) && Array.isArray(cfg.skillDirectories) ? cfg.skillDirectories : [];
    for (const d of dirs) if (typeof d === 'string' && d) add(path.resolve(h.home, d.replace(/^~(?=[/\\]|$)/, h.home)), 'registered', `skillDirectories (${name})`, ['copilot-cli']);
  }
  if (!IS_WINDOWS) add('/etc/codex/skills', 'admin', '/etc/codex/skills', ['codex']);
  return out;
}

const realpath = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const samePath = (a, b) => (IS_WINDOWS ? toPosix(realpath(a)).toLowerCase() === toPosix(realpath(b)).toLowerCase() : realpath(a) === realpath(b));

async function describeCopy(dir, { scope, location, hosts, root }) {
  const fm = await frontmatterLib();
  const text = readText(path.join(dir, 'SKILL.md'), '');
  const parsed = fm.parse(text);
  const data = isObj(parsed.data) ? parsed.data : {};
  const meta = isObj(data.metadata) ? data.metadata : {};
  let symlink = false;
  try { symlink = fs.lstatSync(dir).isSymbolicLink() || realpath(dir) !== path.resolve(dir); } catch {}
  const copy = {
    path: toPosix(dir), scope, location, hosts, version: meta.version != null ? String(meta.version) : null,
    name_ok: data.name === SKILL_NAME, has_script: fs.existsSync(path.join(dir, 'scripts', 'adc.mjs')),
    this_copy: samePath(dir, SKILL_DIR), ...(symlink ? { symlink: true, target: toPosix(realpath(dir)) } : {}),
    provenance: provenanceOf(data), discovered_by: [],
  };
  if (scope === 'project' && root) {
    const rel = relPosix(root, dir);
    copy.rel = rel;
    copy.tracked = rel ? lsFiles(root, [`${rel}/SKILL.md`]).length > 0 : false;
  }
  return copy;
}

/** Every copy of this skill in a directory some host scans, plus the running copy. */
export async function findInstalledCopies({ root = null, cwd = process.cwd(), env = process.env } = {}) {
  const copies = [];
  for (const d of discoveryDirs({ root, cwd, env })) {
    const candidates = [path.join(d.dir, SKILL_NAME)];
    if (d.scope === 'registered' || d.scope === 'env') candidates.push(d.dir);
    for (const c of candidates) {
      if (!fs.existsSync(path.join(c, 'SKILL.md'))) continue;
      if (c === d.dir && path.basename(c) !== SKILL_NAME && !/^name:\s*["']?agentic-developer-companion["']?\s*$/m.test(readText(path.join(c, 'SKILL.md'), ''))) continue;
      const existing = copies.find((x) => samePath(x.path, c));
      if (existing) { existing.also_listed_as = [...(existing.also_listed_as || []), d.location]; continue; }
      copies.push(await describeCopy(c, { ...d, root }));
    }
  }
  if (!copies.some((c) => c.this_copy)) {
    // Not vendored even inside the repository: no host scans that folder.
    const c = await describeCopy(SKILL_DIR, { scope: 'other', location: 'running copy (not in a scanned directory)', hosts: [], root });
    if (root && relPosix(root, SKILL_DIR)) c.in_repo = true;
    copies.push(c);
  }
  return copies;
}

// ---------------------------------------------------------------------------
// Host discovery: ask the host CLIs which skills they actually load

/** Parse `copilot skill list --json` → `[{ name, path, source, enabled }]`. */
export function parseCopilotSkillList(text) {
  const s = String(text || '');
  const start = s.indexOf('[');
  const end = s.lastIndexOf(']');
  if (start < 0 || end < start) return null;
  let arr;
  try { arr = JSON.parse(s.slice(start, end + 1)); } catch { return null; }
  if (!Array.isArray(arr)) return null;
  return arr.filter(isObj).map((e) => ({
    name: String(e.name || ''), path: e.path ? toPosix(String(e.path)) : null, source: e.source ? String(e.source) : null,
    enabled: e.enabled === undefined ? null : Boolean(e.enabled),
  }));
}

function collectStrings(v, out) {
  if (typeof v === 'string') { if (v.includes('(file: ')) out.push(v); return out; }
  if (Array.isArray(v)) { for (const x of v) collectStrings(x, out); return out; }
  if (isObj(v)) for (const x of Object.values(v)) collectStrings(x, out);
  return out;
}

/** Parse `codex debug prompt-input` (JSON or text) → `[{ name, path }]` from its skills catalog. */
export function parseCodexPromptInput(text) {
  const s = String(text || '');
  let strings;
  try { strings = collectStrings(JSON.parse(s), []); } catch { strings = [s]; }
  const out = [];
  for (const str of strings) {
    const roots = {};
    for (const m of str.matchAll(/^- `([A-Za-z0-9_]+)` = `([^`\r\n]+)`\s*$/gm)) roots[m[1]] = m[2];
    for (const line of str.split(/\r?\n/)) {
      const lm = /^- ([^:\r\n]+?): .*\(file: ([^)\r\n]+)\)\s*$/.exec(line);
      if (!lm) continue;
      let file = lm[2].trim();
      const alias = /^([A-Za-z0-9_]+)[/\\](.*)$/.exec(file);
      if (alias && roots[alias[1]]) file = `${roots[alias[1]].replace(/[/\\]+$/, '')}/${alias[2]}`;
      file = toPosix(file);
      out.push({ name: lm[1].trim(), path: file.replace(/\/SKILL\.md$/i, '') });
    }
  }
  return out;
}

function cliSpawn(exe, args, opts) {
  if (IS_WINDOWS && /\.(cmd|bat)$/i.test(exe)) return spawnCapture([quoteArg(exe), ...args.map(quoteArg)].join(' '), [], { ...opts, shell: true });
  return spawnCapture(exe, args, opts);
}

async function hostDiscovery({ root, cwd, env, timeoutMs = DISCOVERY_TIMEOUT_MS }) {
  const jobs = {};
  const copilot = which('copilot', env);
  const codex = which('codex', env);
  if (copilot) jobs.copilot = cliSpawn(copilot, ['skill', 'list', '--json'], { cwd: root || cwd, env, timeoutMs, input: '' }).then((r) => ({ cmd: 'copilot skill list --json', r, parse: parseCopilotSkillList }));
  if (codex) jobs.codex = cliSpawn(codex, ['debug', 'prompt-input', 'x'], { cwd, env, timeoutMs, input: '' }).then((r) => ({ cmd: 'codex debug prompt-input "x"', r, parse: parseCodexPromptInput }));
  const out = {};
  for (const [host, p] of Object.entries(jobs)) {
    const { cmd, r, parse } = await p;
    const skills = r.exit === 0 ? parse(r.stdout) : null;
    out[host] = {
      command: cmd, ran: true, ok: Array.isArray(skills), exit: r.exit, ms: r.ms, ...(r.timedOut ? { timed_out: true } : {}),
      ...(Array.isArray(skills) ? { listed: skills.length, skill: skills.filter((s) => s.name === SKILL_NAME || s.name.endsWith(`:${SKILL_NAME}`)) } : {}),
      ...(!Array.isArray(skills) ? { error: truncate((r.error || r.stderr || r.stdout || 'unparsable output').trim().split(/\r?\n/)[0], 200) } : {}),
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Launcher probes (§8.6): run adc.mjs through each launcher a host uses and expect exact JSON

const posixQuote = (s) => `"${String(s).replace(/(["\\$`])/g, '\\$1')}"`;
const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** The launchers a host uses on this platform (all available ones when the host is unknown). */
export function launchersFor(hosts, { env = process.env, platform = process.platform } = {}) {
  const win = platform === 'win32';
  const map = win
    ? { 'copilot-cli': ['pwsh', 'powershell'], vscode: ['pwsh', 'powershell'], 'copilot-cloud': ['bash'], 'claude-code': ['exec', 'bash', 'powershell'], codex: ['cmd', 'pwsh'] }
    : { 'copilot-cli': ['bash'], vscode: ['bash'], 'copilot-cloud': ['bash'], 'claude-code': ['exec', 'sh'], codex: ['login-shell'] };
  const all = win ? ['exec', 'cmd', 'pwsh', 'powershell', 'bash'] : ['exec', 'sh', 'bash', 'login-shell'];
  const wanted = hosts && hosts.length ? [...new Set(hosts.flatMap((h) => map[h] || []))] : all;
  const out = [];
  for (const id of all.filter((x) => wanted.includes(x))) {
    const users = Object.entries(map).filter(([, l]) => l.includes(id)).map(([h]) => h);
    if (id === 'exec') out.push({ id, label: 'exec (no shell)', program: 'node', users });
    else if (id === 'sh') out.push({ id, label: 'sh -c', program: which('sh', env) ? 'sh' : null, users });
    else if (id === 'bash') out.push({ id, label: 'bash -c', program: which('bash', env) ? 'bash' : null, users });
    else if (id === 'login-shell') {
      const shell = env.SHELL && fs.existsSync(env.SHELL) ? env.SHELL : (fs.existsSync('/bin/sh') ? '/bin/sh' : null);
      out.push({ id, label: `${shell ? path.basename(shell) : '$SHELL'} -lc`, program: shell, users });
    } else if (id === 'pwsh') out.push({ id, label: 'pwsh -NoProfile -Command', program: which('pwsh', env) ? 'pwsh' : null, users });
    else if (id === 'powershell') out.push({ id, label: 'powershell.exe -NoProfile -Command', program: which('powershell', env) ? 'powershell' : null, users });
    else if (id === 'cmd') out.push({ id, label: 'cmd.exe /C', program: env.ComSpec || which('cmd', env) || 'cmd.exe', users });
  }
  return out;
}

function probeInvocation(l, n) {
  const script = toPosix(ADC_SCRIPT);
  const tail = ['doctor', '--probe', n, '--json'];
  const line = `node ${posixQuote(script)} ${tail.join(' ')}`;
  if (l.id === 'exec') return { file: 'node', args: [ADC_SCRIPT, ...tail] };
  if (l.id === 'sh' || l.id === 'bash') return { file: l.program, args: ['-c', line] };
  if (l.id === 'login-shell') return { file: l.program, args: ['-lc', line] };
  if (l.id === 'pwsh' || l.id === 'powershell') return { file: l.program, args: ['-NoProfile', '-NoLogo', '-Command', `& node ${psQuote(script)} ${tail.join(' ')}`] };
  return { file: l.program, args: ['/d', '/s', '/c', `"node "${script}" ${tail.join(' ')}"`], verbatim: true };
}

/** Run the probe through each launcher; `ok` only when stdout is exactly the expected JSON. */
export async function launcherProbes(hosts, { env = process.env, cwd = process.cwd(), redact = (s) => s, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const plan = launchersFor(hosts, { env });
  const jobs = plan.map(async (l) => {
    if (!l.program) return { launcher: l.label, used_by: l.users, ok: null, skipped: 'launcher not installed' };
    const n = nonce().slice(0, 16);
    const inv = probeInvocation(l, n);
    const r = await spawnCapture(inv.file, inv.args, { cwd, env, timeoutMs, windowsVerbatimArguments: Boolean(inv.verbatim) });
    const row = { launcher: l.label, used_by: l.users, ok: false, ms: r.ms, exit: r.exit };
    const outText = r.stdout.trim();
    let parsed = null;
    try { parsed = JSON.parse(outText); } catch {}
    if (isObj(parsed) && parsed.adc_probe === n) {
      Object.assign(row, { ok: true, node_version: String(parsed.node || ''), node_path: parsed.exec ? String(parsed.exec) : null });
      if (parsed.node && !versionGte(String(parsed.node), MIN_NODE)) Object.assign(row, { ok: false, detail: `node ${parsed.node} is too old` });
    } else if (r.error && r.exit == null) row.detail = `could not start: ${r.error}`;
    else if (r.timedOut) row.detail = 'timed out';
    else if (outText.includes(`"adc_probe"`)) row.detail = 'stdout carries extra output around the JSON (shell profile output?); hooks would be ignored';
    else if (/Node\.js 24\+ is required \(found ([^)]+)\)/.test(r.stderr)) row.detail = `this launcher resolves Node ${/\(found ([^)]+)\)/.exec(r.stderr)[1]} (24+ required), e.g. from a shell profile or version manager; render hooks with \`setup hooks --node-path\``;
    else if (r.exit === 127 || r.exit === 9009 || /not (found|recognized)|No such file/i.test(r.stderr)) row.detail = 'node is not on the PATH this launcher sees; render hooks with `setup hooks --node-path`';
    else row.detail = truncate(redact((r.stderr || r.stdout || `exit ${r.exit}`).trim().split(/\r?\n/)[0] || `exit ${r.exit}`), 200);
    return row;
  });
  return Promise.all(jobs);
}

// ---------------------------------------------------------------------------
// Prerequisites (assets/prerequisites.json)

function probeTool(item, env) {
  const tools = Array.isArray(item.tools) ? item.tools : [];
  if (item.check && item.check.cmd) {
    if (!which(item.check.cmd, env)) return { status: 'missing', tool: item.check.cmd };
    const v = toolVersion(item.check.cmd, Array.isArray(item.check.args) ? item.check.args : ['--version']);
    const version = v && v.version ? v.version : null;
    const minimum = item.minimum && parseVersion(String(item.minimum)) ? String(item.minimum) : null;
    if (minimum && version && !versionGte(version, minimum)) return { status: 'old', tool: item.check.cmd, version, path: v.path };
    return { status: version || !minimum ? 'present' : 'unknown', tool: item.check.cmd, version, path: v ? v.path : null, ...(version ? {} : { detail: 'version not recognised' }) };
  }
  const found = tools.map((t) => ({ t, p: which(t, env) })).filter((x) => x.p);
  if (!tools.length) return { status: 'unknown' };
  return found.length ? { status: 'present', tool: found.map((f) => f.t).join(', '), path: toPosix(found[0].p) } : { status: 'missing', tool: tools.join(' | ') };
}

function prereqRows(items, facts, env) {
  const rows = [];
  for (const item of items) {
    let r;
    if (PROBED_TOOLS.includes(item.id)) {
      if (item.id === 'git-bash' && !IS_WINDOWS) r = { status: 'n/a', detail: 'Windows only' };
      else if (item.id === 'node') r = facts.nodeOnPath;
      else r = facts.tools[item.id] || probeTool(item, env);
    } else r = computedPrereq(item.id, facts);
    const status = r.status;
    rows.push({
      id: item.id, category: item.category, group: item.group, name: item.name, minimum: item.minimum ?? null, status,
      ...(r.version ? { version: r.version } : {}), ...(r.tool ? { tool: r.tool } : {}), ...(r.detail ? { detail: r.detail } : {}),
      ...(['missing', 'old'].includes(status) ? { in_effect: item.fallback || item.without || null } : {}),
    });
  }
  return rows;
}

function computedPrereq(id, f) {
  switch (id) {
    case 'host': return f.hostsPresent.length ? { status: 'present', detail: f.hostsPresent.join(', ') } : { status: 'unknown', detail: 'no host CLI on PATH (VS Code and the cloud agent cannot be detected from a shell)' };
    case 'shell-permission': return f.agent ? { status: 'present', detail: 'this command ran through the host\'s shell tool' } : { status: 'unknown', detail: 'granted per host session; not checkable from a terminal' };
    case 'state-dir':
      if (f.state.tracked.length) return { status: 'missing', detail: `${f.state.rel || '.adc'}/ is tracked by git` };
      if (!f.state.exists) return { status: 'unknown', detail: 'not created yet (`doctor --init` or the first QA run creates it)' };
      return f.state.ignored ? { status: 'present', detail: f.state.dir } : { status: 'missing', detail: 'exists but is not ignored by git' };
    case 'temp-dir': return f.tempWritable ? { status: 'present', detail: toPosix(os.tmpdir()) } : { status: 'missing', detail: `${toPosix(os.tmpdir())} is not writable` };
    case 'qa-repo': return f.repo.root ? (f.repo.base_error ? { status: 'missing', detail: f.repo.base_error } : { status: 'present', detail: `base ${f.repo.base_ref || 'none'} (${f.repo.base_source})` }) : { status: 'missing', detail: 'not inside a Git work tree' };
    case 'node-launcher': {
      const ran = f.probes.filter((p) => p.ok !== null);
      if (!ran.length) return { status: 'unknown', detail: 'launcher probes not run' };
      const bad = ran.filter((p) => !p.ok);
      return bad.length ? { status: 'missing', detail: bad.map((p) => `${p.launcher}: ${p.detail || 'failed'}`).join('; ') } : { status: 'present', detail: ran.map((p) => p.launcher).join(', ') };
    }
    case 'hooks-registered': return f.hooks.length ? { status: 'present', detail: f.hooks.map((h) => `${h.host} (${h.scope})`).join(', ') } : { status: 'missing' };
    case 'live-token': return f.credential.set ? { status: 'present', detail: `set (source: ${f.credential.source})` } : { status: 'missing', detail: 'unset' };
    case 'budget-ledger': return f.budget.exists ? (f.budget.valid ? { status: 'present' } : { status: 'missing', detail: f.budget.error }) : { status: 'missing', detail: 'created on the first live run' };
    case 'adc-debug': return f.env.ADC_DEBUG === '1' ? { status: 'present' } : { status: 'missing' };
    case 'skill-installer': return fs.existsSync(path.join(homes(f.env).codex, 'skills', '.system', 'skill-installer', 'SKILL.md')) ? { status: 'present' } : { status: f.tools.codex && f.tools.codex.status === 'present' ? 'missing' : 'unknown' };
    case 'copilot-skill-add': return f.tools.copilot && ['present', 'old'].includes(f.tools.copilot.status) ? { status: f.tools.copilot.status, version: f.tools.copilot.version } : { status: 'missing' };
    case 'host-diagnostics': return ['copilot', 'claude'].some((h) => f.tools[h] && f.tools[h].status === 'present') ? { status: 'present' } : { status: 'missing' };
    case 'copilot-setup-steps': return f.repo.root ? { status: fs.existsSync(path.join(f.repo.root, '.github', 'workflows', 'copilot-setup-steps.yml')) ? 'present' : 'missing' } : { status: 'n/a' };
    case 'codeowners': return f.repo.root ? { status: ['CODEOWNERS', '.github/CODEOWNERS', 'docs/CODEOWNERS'].some((p) => fs.existsSync(path.join(f.repo.root, p))) ? 'present' : 'missing' } : { status: 'n/a' };
    case 'longpaths': return IS_WINDOWS ? { status: f.longpaths ? 'present' : 'missing' } : { status: 'n/a', detail: 'Windows only' };
    case 'wsl2': return IS_WINDOWS ? { status: which('wsl', f.env) ? 'present' : 'missing' } : { status: 'n/a', detail: 'Windows only' };
    default: return { status: 'unknown', detail: 'project- or host-specific; not checked by doctor' };
  }
}

// ---------------------------------------------------------------------------
// --verify-vendored: compare a vendored copy with its pinned release

const JUNK = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

function walkDir(dir) {
  const files = new Map();
  const walk = (d, rel, depth) => {
    if (depth > 20) return;
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === '.git' || JUNK.has(e.name)) continue;
      const full = path.join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (st.isDirectory()) walk(full, r, depth + 1);
      else if (st.isFile()) files.set(r, () => fs.readFileSync(full));
    }
  };
  walk(dir, '', 0);
  return files;
}

function gitBlobs(gitDir, shas) {
  const res = spawnSync('git', ['cat-file', '--batch'], { cwd: gitDir, input: shas.join('\n') + '\n', maxBuffer: 512 * 1024 * 1024, windowsHide: true });
  if (res.status !== 0) throw unverifiable('GIT_FAILED', `git cat-file failed: ${String(res.stderr || '').trim().split('\n')[0]}`);
  const buf = res.stdout;
  const out = new Map();
  let pos = 0;
  while (pos < buf.length) {
    const nl = buf.indexOf(10, pos);
    if (nl < 0) break;
    const header = buf.subarray(pos, nl).toString('utf8').split(' ');
    if (header[1] === 'missing') { pos = nl + 1; continue; }
    const size = Number(header[2]);
    out.set(header[0], buf.subarray(nl + 1, nl + 1 + size));
    pos = nl + 1 + size + 1;
  }
  return out;
}

/** Files of the skill folder inside a commit: `{ commit, skill_path, files: Map(rel → () => Buffer) }`. */
export function gitSkillTree(gitDir, commitish, { skillPath = null } = {}) {
  const commit = gitTry(gitDir, ['rev-parse', '--verify', '--quiet', `${commitish}^{commit}`]);
  if (!commit) throw usageError(`"${commitish}" does not name a commit in ${toPosix(gitDir)}`);
  const has = (p) => gitRaw(gitDir, ['cat-file', '-e', `${commit}:${p ? `${p}/` : ''}SKILL.md`]).exit === 0;
  const tries = [skillPath ? toPosix(skillPath).replace(/\/?SKILL\.md$/i, '').replace(/^\/+|\/+$/g, '') : null, `skills/${SKILL_NAME}`, ''].filter((p) => p !== null);
  let sp = tries.find((p) => has(p));
  if (sp === undefined) {
    const all = (gitTry(gitDir, ['-c', 'core.quotePath=false', 'ls-tree', '-r', '--name-only', '-z', commit]) || '').split('\0');
    const hit = all.filter((p) => p.endsWith(`${SKILL_NAME}/SKILL.md`)).sort((a, b) => a.length - b.length)[0];
    if (!hit) throw unverifiable('NO_SKILL_IN_REF', `no ${SKILL_NAME}/SKILL.md in ${commitish}`);
    sp = hit.replace(/\/SKILL\.md$/, '');
  }
  const out = gitTry(gitDir, ['-c', 'core.quotePath=false', 'ls-tree', '-r', '-z', '--full-tree', commit, '--', ...(sp ? [sp] : [])]) || '';
  const entries = [];
  for (const rec of out.split('\0').filter(Boolean)) {
    const m = /^(\d+) (\w+) ([0-9a-f]+)\t(.*)$/s.exec(rec);
    if (!m || m[2] !== 'blob') continue;
    const rel = sp ? m[4].slice(sp.length + 1) : m[4];
    if (JUNK.has(path.posix.basename(rel))) continue;
    entries.push({ rel, sha: m[3] });
  }
  const blobs = gitBlobs(gitDir, [...new Set(entries.map((e) => e.sha))]);
  const files = new Map(entries.map((e) => [e.rel, () => blobs.get(e.sha) || Buffer.alloc(0)]));
  return { commit, skill_path: sp || '.', files };
}

const isUrl = (s) => /^(?:https?|ssh|git|file):\/\//i.test(s) || /^[\w.-]+@[\w.-]+:/.test(s);

function fetchRemote(url, ref, { skillPath = null, timeoutMs = 180_000 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adc-vendored-'));
  const env = { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '' };
  try {
    let r = gitRaw(dir, ['init', '--bare', '-q', '.'], { env });
    if (r.exit !== 0) throw unverifiable('GIT_FAILED', 'git init failed in the OS temp dir');
    r = gitRaw(dir, ['-c', 'protocol.file.allow=always', 'fetch', '--depth', '1', '--no-tags', '--quiet', url, ref], { env, timeoutMs });
    if (r.exit !== 0) throw unverifiable('FETCH_FAILED', `could not fetch ${ref} from ${url}: ${(r.stderr || '').trim().split('\n').pop() || `exit ${r.exit}`}`);
    return { ...gitSkillTree(dir, 'FETCH_HEAD', { skillPath }), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

function provenanceRemote(prov, frontmatter) {
  const gh = prov && prov.github ? prov.github : {};
  const host = gh['github-host'] && /^[A-Za-z0-9.-]+$/.test(gh['github-host']) ? gh['github-host'] : 'github.com';
  const repo = gh['github-repo'];
  const owner = gh['github-owner'];
  let url = null;
  if (repo && isUrl(repo)) url = repo;
  else if (repo && repo.includes('/')) url = `https://${host}/${repo.replace(/\.git$/, '')}.git`;
  else if (repo && owner) url = `https://${host}/${owner}/${repo}.git`;
  else {
    const home = isObj(frontmatter) && isObj(frontmatter.metadata) ? String(frontmatter.metadata.homepage || '') : '';
    if (/^https:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+\/?$/.test(home)) url = `${home.replace(/\/+$/, '').replace(/\.git$/, '')}.git`;
  }
  const ref = ['github-sha', 'github-pinned', 'github-ref'].map((k) => gh[k]).find((v) => v && REF_RE.test(v) && !/^(?:true|false)$/i.test(v)) || null;
  return { url, ref, skill_path: gh['github-path'] || null, from_provenance: Boolean(repo) };
}

/** Compare SKILL.md semantically (install rewrites the frontmatter); returns `{ status, detail }`. */
export async function compareSkillMd(refBuf, copyBuf) {
  if (refBuf.equals(copyBuf)) return { status: 'identical' };
  const fm = await frontmatterLib();
  const a = fm.parse(refBuf.toString('utf8'));
  const b = fm.parse(copyBuf.toString('utf8'));
  const normBody = (s) => String(s || '').replace(/\r\n?/g, '\n').replace(/^\n+/, '').replace(/\s+$/, '');
  const da = fm.normalize(isObj(a.data) ? a.data : {});
  const db = fm.normalize(isObj(b.data) ? b.data : {});
  const keys = [...new Set([...Object.keys(da), ...Object.keys(db)])].filter((k) => JSON.stringify(da[k]) !== JSON.stringify(db[k]));
  const bodyDiffers = normBody(a.body) !== normBody(b.body);
  const errors = [...(a.errors || []), ...(b.errors || [])].length;
  if (!keys.length && !bodyDiffers && !errors) return { status: 'equivalent', detail: 'frontmatter equal after removing install provenance and key order; body equal' };
  return { status: 'different', detail: { frontmatter_keys: keys, body_differs: bodyDiffers, ...(errors ? { parse_errors: errors } : {}) } };
}

/** Compare a reference file map with a copy's: `{ status, missing[], extra[], changed[], changed_eol_only[], skill_md }`. */
export async function compareSkillTrees(refFiles, copyFiles) {
  const missing = [];
  const extra = [];
  const changed = [];
  const eolOnly = [];
  let skillMd = null;
  for (const rel of [...refFiles.keys()].sort()) {
    if (!copyFiles.has(rel)) { missing.push(rel); continue; }
    const a = refFiles.get(rel)();
    const b = copyFiles.get(rel)();
    if (rel === 'SKILL.md') { skillMd = await compareSkillMd(a, b); continue; }
    if (!a.equals(b)) {
      changed.push(rel);
      if (a.toString('latin1').replace(/\r\n/g, '\n') === b.toString('latin1').replace(/\r\n/g, '\n')) eolOnly.push(rel);
    }
  }
  for (const rel of [...copyFiles.keys()].sort()) if (!refFiles.has(rel)) extra.push(rel);
  const ok = !missing.length && !extra.length && !changed.length && (!skillMd || skillMd.status !== 'different');
  return { status: ok ? 'match' : 'mismatch', compared: refFiles.size, missing, extra, changed, ...(eolOnly.length ? { changed_eol_only: eolOnly } : {}), skill_md: skillMd || { status: 'missing' } };
}

function referenceFor(copy, { against, ref, cwd, frontmatter }) {
  const prov = copy.provenance;
  if (against && isUrl(against)) {
    const p = provenanceRemote(prov, frontmatter);
    const r = ref || p.ref || 'HEAD';
    return { kind: 'remote', source: against, ref: r, ...fetchRemote(against, r, { skillPath: p.skill_path }) };
  }
  if (against) {
    const dir = path.resolve(cwd, against);
    if (!fs.existsSync(dir)) throw usageError(`--against does not exist: ${toPosix(dir)}`);
    if (ref) {
      const isGit = gitRaw(dir, ['rev-parse', '--git-dir']).exit === 0;
      if (!isGit) throw usageError(`--ref needs --against to be a Git clone (or a URL); ${toPosix(dir)} is not a repository`);
      const p = provenanceRemote(prov, frontmatter);
      return { kind: 'git', source: toPosix(dir), ref, ...gitSkillTree(dir, ref, { skillPath: p.skill_path }) };
    }
    const skillDir = fs.existsSync(path.join(dir, 'SKILL.md')) ? dir : fs.existsSync(path.join(dir, 'skills', SKILL_NAME, 'SKILL.md')) ? path.join(dir, 'skills', SKILL_NAME) : null;
    if (!skillDir) throw usageError(`--against has neither SKILL.md nor skills/${SKILL_NAME}/SKILL.md: ${toPosix(dir)}`);
    return { kind: 'dir', source: toPosix(skillDir), ref: null, files: walkDir(skillDir) };
  }
  const p = provenanceRemote(prov, frontmatter);
  if (ref || p.from_provenance) {
    if (!p.url) throw unverifiable('NO_UPSTREAM', 'no upstream repository is known for this copy (no github-* provenance or metadata.homepage); pass --against <clone or URL>');
    const r = ref || p.ref || 'HEAD';
    return { kind: 'remote', source: p.url, ref: r, ...fetchRemote(p.url, r, { skillPath: p.skill_path }) };
  }
  if (prov && prov.local_path && fs.existsSync(path.join(prov.local_path, 'SKILL.md')) && !samePath(prov.local_path, copy.path)) {
    return { kind: 'local-path', source: prov.local_path, ref: null, files: walkDir(prov.local_path) };
  }
  if (!samePath(SKILL_DIR, copy.path)) return { kind: 'running-copy', source: toPosix(SKILL_DIR), ref: null, files: walkDir(SKILL_DIR) };
  throw unverifiable('NO_REFERENCE', 'nothing to compare with: pass --ref <tag> (fetched from the upstream repository) or --against <release dir | clone | URL>');
}

/**
 * Compare each vendored (project-scope) copy with its pinned release. Returns
 * `{ status: 'match'|'mismatch'|'unverified'|'none', copies[] }`.
 */
export async function verifyVendored(copies, { against = null, ref = null, cwd = process.cwd() } = {}) {
  const vendored = copies.filter((c) => c.scope === 'project');
  if (!vendored.length) return { status: 'none', detail: 'no copy of the skill under the repository (.github/skills, .agents/skills, .claude/skills, .codex/skills)', copies: [] };
  const fm = await frontmatterLib();
  const rows = [];
  for (const copy of vendored) {
    const row = { path: copy.path, rel: copy.rel || null, tracked: copy.tracked ?? null, version: copy.version, provenance: copy.provenance };
    let refTree = null;
    try {
      const data = fm.parse(readText(path.join(copy.path, 'SKILL.md'), '')).data;
      refTree = referenceFor(copy, { against, ref, cwd, frontmatter: data });
      row.reference = { kind: refTree.kind, source: refTree.source, ref: refTree.ref, ...(refTree.commit ? { commit: refTree.commit } : {}), ...(refTree.skill_path ? { skill_path: refTree.skill_path } : {}) };
      Object.assign(row, await compareSkillTrees(refTree.files, walkDir(copy.path)));
    } catch (err) {
      if (!(err instanceof AdcError)) throw err;
      if (err.exit === EXIT.USAGE) throw err;
      Object.assign(row, { status: 'unverified', reason: err.code, detail: err.message });
    } finally {
      if (refTree && refTree.cleanup) refTree.cleanup();
    }
    rows.push(row);
  }
  const status = rows.some((r) => r.status === 'mismatch') ? 'mismatch' : rows.some((r) => r.status === 'unverified') ? 'unverified' : 'match';
  return { status, copies: rows };
}

// ---------------------------------------------------------------------------
// State dir

function stateReport(info, { env, sessionId = null }) {
  const p = statePaths(info.dir);
  const tracked = info.root ? trackedStateFiles(info) : [];
  const exists = fs.existsSync(info.dir);
  let exclude = null;
  if (info.insideRepo) {
    try {
      const file = gitPath(info.root, 'info/exclude');
      const lines = (readText(file, '') || '').split(/\r?\n/).map((l) => l.trim());
      exclude = { file: toPosix(file), entry_present: [`/${info.rel}/`, `/${info.rel}`, `${info.rel}/`].some((e) => lines.includes(e)) };
    } catch { exclude = { file: null, entry_present: false }; }
  }
  const ignored = info.insideRepo ? stateIgnored(info, 'probe') : true;
  const envIgnored = info.insideRepo ? stateIgnored(info, '.env.live') : true;
  const credential = credentialStatus(info, env);
  const envLive = { exists: fs.existsSync(p.envLive), ignored: envIgnored };
  if (envLive.exists) envLive.perms = checkOwnerOnly(p.envLive);
  const loaded = loadBudget(info);
  const b = loaded.budget;
  const cls = runClassOf({}, env);
  const open = sessionId ? { id: sessionId, source: 'flag' } : (exists ? (() => { const s = newestOpenSession(info.dir); return s ? { id: String(s.id), source: 'session-file' } : null; })() : null);
  const caps = effectiveCaps(b, { runClass: cls, session: open ? b.sessions[open.id] : null, env });
  const budget = {
    path: loaded.path, exists: loaded.exists, valid: loaded.valid, ...(loaded.exists && !loaded.valid ? { error: loaded.error } : {}),
    unit: b.unit, max_per_session: b.max_per_session, max_per_day: b.max_per_day, warn_at: b.warn_at,
    defaults_exceeded: loaded.defaults_exceeded, run_class: cls, effective: { session: caps.session, day: caps.day },
    today: budgetView(b, { sessionId: open ? open.id : '(next run)', identitySource: open ? open.source : 'generated', caps, runClass: cls }),
    overrides: Object.entries(b.sessions).filter(([, s]) => isObj(s.override)).map(([id, s]) => ({ session: id, ...s.override })),
  };
  return {
    dir: toPosix(info.dir), rel: info.rel, source: info.source, inside_repo: info.insideRepo, exists, tracked: tracked.slice(0, 20),
    exclude, ignored, env_live: envLive, credential, budget,
  };
}

// ---------------------------------------------------------------------------
// The report

async function hooksList(root, env) {
  try {
    const m = await import('./hooks-render.mjs');
    if (typeof m.listRegisteredHooks !== 'function') return { hooks: [], available: false };
    return { hooks: m.listRegisteredHooks({ root, env }), available: true };
  } catch (err) {
    return { hooks: [], available: false, error: truncate(String(err.message || err), 200) };
  }
}

function prerequisitesFile() {
  const doc = readJson(path.join(ASSETS_DIR, 'prerequisites.json'), null);
  return doc && Array.isArray(doc.items) ? doc.items : [];
}

/** Build the doctor report. `opts`: `{ cwd, env, stateDirOption, discovery, probes, verifyVendored, against, ref, session }`. */
export async function doctorReport({ cwd = process.cwd(), env = process.env, stateDirOption = null, discovery = true, probes = true, vendored = null, session = null } = {}) {
  const warnings = [];
  const root = repoRoot(cwd);
  const info = resolveStateDir({ cwd, stateDirOption, env });
  const literals = [];
  if (env.ADC_LIVE_TOKEN) literals.push({ name: 'ADC_LIVE_TOKEN', value: env.ADC_LIVE_TOKEN });
  // The file value is read only to redact it from free text (probe output, CLI errors).
  const fileToken = parseEnvFile(readText(statePaths(info.dir).envLive, '') || '').ADC_LIVE_TOKEN;
  if (fileToken) literals.push({ name: 'ADC_LIVE_TOKEN', value: fileToken });
  const redact = await makeRedactor(literals);
  const guess = guessHostEnv(env);

  // Slow, independent work starts first (host CLIs listing skills can take 15+ s); awaited below.
  const hooksRes = await hooksList(root, env);
  const hookHosts = [...new Set(hooksRes.hooks.map((h) => ({ copilot: 'copilot-cli', 'copilot-cloud': 'copilot-cloud', claude: 'claude-code', codex: 'codex' })[h.host]).filter(Boolean))];
  const probeHosts = [...new Set([guess.host, ...hookHosts].filter(Boolean))];
  const discoveryP = discovery ? hostDiscovery({ root, cwd, env }) : Promise.resolve(null);
  const probesP = probes ? launcherProbes(probeHosts, { env, cwd, redact }) : Promise.resolve([]);

  const nodeE = nodeEol(process.versions.node);
  const nodePath = toolVersion('node', ['--version']);
  const node = { version: process.versions.node, path: toPosix(process.execPath), minimum: MIN_NODE, ok: versionGte(process.versions.node, MIN_NODE), lts: nodeE.lts, eol: nodeE.eol, ...(nodeE.warning ? { warning: nodeE.warning } : {}) };
  if (nodeE.warning) warnings.push(nodeE.warning);
  if (!nodePath) warnings.push('`node` is not on PATH: hooks run the bare `node` command; render them with `setup hooks --node-path`');
  else {
    node.on_path = { version: nodePath.version, path: nodePath.path, same: samePath(nodePath.path, process.execPath) };
    if (nodePath.version && !versionGte(nodePath.version, MIN_NODE)) warnings.push(`the \`node\` on PATH is ${nodePath.version} (hooks use it; this run used ${process.versions.node}); render hooks with \`setup hooks --node-path\``);
  }
  const gv = gitVersion();
  const git = { version: gv, path: which('git', env) ? toPosix(which('git', env)) : null, minimum: MIN_GIT, ok: Boolean(gv && versionGte(gv, MIN_GIT)) };
  if (!gv) warnings.push('git is not on PATH: QA modes cannot run (exit 3) and hooks emit {}');
  else if (!git.ok) warnings.push(`Git ${gv} is older than ${MIN_GIT}`);

  const items = prerequisitesFile();
  if (!items.length) warnings.push('assets/prerequisites.json is missing or unreadable');
  const tools = {};
  for (const id of PROBED_TOOLS) {
    const item = items.find((i) => i.id === id);
    if (!item) { warnings.push(`assets/prerequisites.json has no entry for "${id}"`); continue; }
    if (id === 'node') continue;
    if (id === 'git-bash' && !IS_WINDOWS) continue;
    tools[id] = probeTool(item, env);
  }
  const hostItems = items.filter((i) => i.category === 'host');
  const hosts = hostItems.map((i) => {
    const t = tools[i.id] || { status: 'missing' };
    return { id: i.id, name: i.name, present: ['present', 'old', 'unknown'].includes(t.status), version: t.version || null, minimum: i.minimum, ok: t.status === 'present' ? true : t.status === 'old' ? false : null, ...(t.path ? { path: t.path } : {}) };
  });
  for (const h of hosts) if (h.ok === false) warnings.push(`${h.name} ${h.version} is older than the supported ${h.minimum}`);

  const repo = { root: root ? toPosix(root) : null };
  if (root) {
    try { const b = resolveBase(root, null); Object.assign(repo, { base_ref: b.ref, base_source: b.source }); }
    catch (err) { repo.base_error = err.message; }
  }
  let tempWritable = false;
  try { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'adc-doctor-')); fs.rmSync(d, { recursive: true, force: true }); tempWritable = true; } catch {}

  const state = stateReport(info, { env, sessionId: session });
  if (state.tracked.length) warnings.push(`${state.rel || '.adc'}/ is tracked by git (${state.tracked.length} file(s)); every CLI command exits 3: run \`git rm -r --cached ${state.rel || '.adc'}\``);
  if (state.exists && state.inside_repo && !state.ignored) warnings.push(`${state.rel}/ is not ignored by git; run \`doctor --init\` to add the exclude entry (an in-tree negation such as !.adc/** overrides it)`);
  if (state.env_live.exists && state.env_live.perms && !state.env_live.perms.ok) warnings.push(`${state.rel || '.adc'}/.env.live is not owner-only (${state.env_live.perms.mode || state.env_live.perms.detail}); \`doctor --init\` re-applies it; if that does not help the filesystem cannot hold permissions (WSL DrvFs, FAT/exFAT): relocate with ADC_HOME`);
  if (state.env_live.exists && !state.env_live.ignored) warnings.push(`${state.rel || '.adc'}/.env.live is not ignored by git; \`live run\` will not read it until it is`);
  if (env.ADC_LIVE_TOKEN && runClassOf({}, env) !== 'ci') warnings.push('ADC_LIVE_TOKEN is set in this session\'s environment, so every tool call and hook inherits it; on developer machines keep it in .adc/.env.live instead');
  if (state.budget.defaults_exceeded) warnings.push(`budget.json raises the caps above the shipped defaults (${DEFAULT_BUDGET.max_per_session} per session and per day): ${state.budget.max_per_session} per session, ${state.budget.max_per_day} per day (agent runs keep the defaults)`);
  if (state.budget.exists && !state.budget.valid) warnings.push(`budget.json is ${state.budget.error}; headless live runs refuse (BUDGET_UNVERIFIED) when spend is already recorded today`);
  for (const o of state.budget.overrides) warnings.push(`session ${o.session} carries a terminal override of the session cap: ${o.max} (${o.ts})`);
  const osi = osInfo(env);
  if (osi.wsl && /^\/mnt\/[a-z]\//i.test(toPosix(info.dir))) warnings.push('the state dir is on a Windows drive under WSL (DrvFs), which may not hold owner-only permissions; relocate with ADC_HOME');

  const copies = await findInstalledCopies({ root, cwd, env });
  const disc = await discoveryP;
  if (disc) {
    for (const [host, d] of Object.entries(disc)) {
      for (const s of d.skill || []) {
        let c = s.path ? copies.find((x) => samePath(x.path, s.path)) : null;
        if (!c && s.path) {
          c = await describeCopy(s.path, { scope: 'discovered', location: `listed by ${host}`, hosts: [host === 'copilot' ? 'copilot-cli' : 'codex'], root });
          copies.push(c);
        }
        if (c && !c.discovered_by.includes(host)) c.discovered_by.push(host);
        if (c && s.enabled === false) c.disabled_in = [...(c.disabled_in || []), host];
      }
      if (!d.ok) warnings.push(`${d.command} did not return a skill list (${d.error || `exit ${d.exit}`})`);
    }
    for (const [host, d] of Object.entries(disc)) {
      const hostId = host === 'copilot' ? 'copilot-cli' : 'codex';
      const expected = copies.filter((c) => c.hosts.includes(hostId));
      if (d.ok && expected.length && !copies.some((c) => c.discovered_by.includes(host))) {
        warnings.push(`${host} does not list ${SKILL_NAME} although ${expected[0].path} is in a directory it scans (disabled skill, folder trust, or a name/frontmatter problem)`);
      }
    }
  }
  const versions = [...new Set(copies.map((c) => c.version).filter(Boolean))];
  if (versions.length > 1) warnings.push(`installed copies have different versions (${versions.join(', ')}); hosts load the first one they find`);
  const projectCopies = copies.filter((c) => c.scope === 'project');
  if (projectCopies.length && !projectCopies.some((c) => c.location === '.github/skills')) warnings.push('the repository has a copy in .agents/skills or .claude/skills but none in .github/skills: Copilot code review reads only .github/skills');
  for (const c of copies) if (!c.name_ok) warnings.push(`${c.path}/SKILL.md does not declare name: ${SKILL_NAME}`);
  const thisCopy = copies.find((c) => c.this_copy);
  if (thisCopy && !thisCopy.hosts.length) warnings.push(`this copy (${thisCopy.path}) is not in a directory any host scans; hosts load it only when registered (copilot skill add, skillDirectories, COPILOT_SKILLS_DIRS) or copied`);

  for (const h of hooksRes.hooks) {
    if (h.present === false) warnings.push(`hooks recorded in .adc/hooks-installed.json are missing from ${h.file}`);
    else if (h.matches_current === false) warnings.push(`registered ${h.host} hooks in ${h.file} differ from the current template; re-run \`setup hooks\``);
    for (const sp of h.skill_paths || []) {
      const abs = path.isAbsolute(sp) || /^[A-Za-z]:/.test(sp) ? sp : (root ? path.join(root, sp) : sp);
      if (!fs.existsSync(path.join(abs, 'scripts', 'adc.mjs'))) warnings.push(`registered ${h.host} hooks in ${h.file} point at ${sp}, which has no scripts/adc.mjs (dead hook)`);
    }
  }
  if (hooksRes.error) warnings.push(`registered hooks could not be listed: ${hooksRes.error}`);

  const probeRows = await probesP;
  for (const p of probeRows) if (p.ok === false) warnings.push(`launcher probe ${p.launcher} failed: ${p.detail || 'unexpected output'} (hooks launched this way would be dead)`);

  let longpaths = false;
  if (IS_WINDOWS && gv) longpaths = gitTry(root || cwd, ['config', '--get', 'core.longpaths']) === 'true';
  const facts = {
    env, agent: agentMarkers(env).length > 0, nodeOnPath: nodePath ? { status: nodePath.version && versionGte(nodePath.version, MIN_NODE) ? 'present' : 'old', version: nodePath.version, tool: 'node' } : { status: 'missing', tool: 'node' },
    tools, hostsPresent: hosts.filter((h) => h.present).map((h) => h.id), state: { ...state, dir: state.dir }, tempWritable, repo,
    probes: probeRows, hooks: hooksRes.hooks, credential: state.credential, budget: state.budget, longpaths,
  };
  const prerequisites = prereqRows(items, facts, env);

  const report = {
    schema: 'adc-doctor/1',
    skill: { name: SKILL_NAME, version: skillVersion(), path: toPosix(SKILL_DIR), script: toPosix(ADC_SCRIPT), invoke: `node "${toPosix(ADC_SCRIPT)}" <command> --json` },
    host_guess: guess.host, hooks_host: guess.hooks_host, host_markers: guess.markers, host_candidates: guess.candidates,
    os: osi, node, git, hosts, repo, install_paths: copies, discovery: disc, hooks: hooksRes.hooks, probes: probeRows, state,
    prerequisites, warnings,
  };
  if (vendored) {
    report.vendored = await verifyVendored(copies, vendored);
    if (report.vendored.status === 'mismatch') warnings.push('a vendored copy differs from its reference release (see vendored.copies)');
    if (report.vendored.status === 'unverified') warnings.push('a vendored copy could not be compared with its release (see vendored.copies[].detail)');
  }
  return redactValue(report, redact);
}

function humanReport(r) {
  const L = [];
  L.push(`${r.skill.name} ${r.skill.version} doctor`);
  L.push(`script:  ${r.skill.script}`);
  L.push(`host:    ${r.host_guess || 'unknown'}${r.host_markers.length ? ` (${r.host_markers.join(', ')})` : ''}`);
  L.push(`os:      ${r.os.platform} ${r.os.release} ${r.os.arch}${r.os.wsl ? ' (WSL)' : ''}`);
  L.push(`node:    ${r.node.version} ${r.node.ok ? 'ok' : 'TOO OLD'}${r.node.eol ? ` (EOL ${r.node.eol})` : ''}`);
  L.push(`git:     ${r.git.version || 'missing'}${r.git.version ? (r.git.ok ? ' ok' : ' TOO OLD') : ''}`);
  L.push(`hosts:   ${r.hosts.map((h) => `${h.id} ${h.present ? `${h.version || '?'}${h.ok === false ? ' (old)' : ''}` : 'missing'}`).join(' | ')}`);
  L.push('copies:');
  for (const c of r.install_paths) L.push(`  ${c.path} [${c.scope}${c.this_copy ? ', this copy' : ''}${c.tracked ? ', tracked' : ''}] v${c.version || '?'}${c.hosts.length ? ` read by ${c.hosts.join(', ')}` : ''}${c.discovered_by.length ? `; listed by ${c.discovered_by.join(', ')}` : ''}`);
  L.push(`hooks:   ${r.hooks.length ? r.hooks.map((h) => `${h.host}/${h.scope} ${h.level || ''} (${h.file})`).join('; ') : 'none registered'}`);
  L.push(`probes:  ${r.probes.length ? r.probes.map((p) => `${p.launcher} ${p.ok === null ? 'n/a' : p.ok ? 'ok' : 'FAIL'}`).join(', ') : 'not run'}`);
  const s = r.state;
  L.push(`state:   ${s.dir}${s.exists ? '' : ' (not created)'}${s.tracked.length ? ' TRACKED' : s.ignored ? ' (ignored)' : ' (NOT ignored)'}; ADC_LIVE_TOKEN ${s.credential.set ? `set (source: ${s.credential.source})` : 'unset'}`);
  L.push(`budget:  remaining ${s.budget.today.remaining} ${s.budget.unit} (today ${s.budget.today.spent_today}/${s.budget.effective.day}, per session ${s.budget.effective.session})`);
  const counts = {};
  for (const p of r.prerequisites) counts[p.status] = (counts[p.status] || 0) + 1;
  L.push(`prereqs: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}`);
  for (const p of r.prerequisites.filter((x) => ['missing', 'old'].includes(x.status) && x.category !== 'host')) L.push(`  ${p.status === 'old' ? 'old    ' : 'missing'} ${p.name}${p.in_effect ? ` -> ${p.in_effect}` : ''}`);
  if (r.vendored) {
    L.push(`vendored: ${r.vendored.status}`);
    for (const c of r.vendored.copies) L.push(`  ${c.path}: ${c.status}${c.reference ? ` vs ${c.reference.kind} ${c.reference.source}${c.reference.ref ? `@${c.reference.ref}` : ''}` : ''}${c.detail ? ` - ${typeof c.detail === 'string' ? c.detail : ''}` : ''}${c.changed && c.changed.length ? `; changed ${c.changed.slice(0, 5).join(', ')}` : ''}${c.missing && c.missing.length ? `; missing ${c.missing.slice(0, 5).join(', ')}` : ''}${c.extra && c.extra.length ? `; extra ${c.extra.slice(0, 5).join(', ')}` : ''}`);
  }
  if (r.init) L.push(`init:    ${r.init.refused ? `refused: ${r.init.refused}` : `${r.init.dry_run ? 'would create' : 'ready'} ${r.init.dir}`}`);
  if (r.warnings.length) { L.push('warnings:'); for (const w of r.warnings) L.push(`  - ${w}`); }
  return L.join('\n');
}

const USAGE = [
  'doctor [--init] [--verify-vendored [--against <dir|clone|url>] [--ref <tag|sha>]] [--no-discovery] [--no-probes]',
  '       [--session <id>] [--json]',
  'Host, OS, Node, Git, host CLIs vs their floors, every prerequisite with the fallback in effect, installed',
  'copies (and which host CLIs list them), registered hooks, launcher probes, the state dir and the budget.',
  '--init creates .adc/, writes the exclude entry and materializes the templates. --verify-vendored compares',
  'each copy under the repository with its release (SKILL.md semantically, other files byte for byte).',
  'Exit: 3 when .adc/ is tracked (the report is still printed), 1 on vendored drift, 4 when it cannot be compared.',
].join('\n');

export const doctorCommand = defineCommand({
  name: 'doctor',
  usage: USAGE,
  positionals: false,
  options: {
    init: { type: 'boolean' }, 'verify-vendored': { type: 'boolean' }, against: { type: 'string' }, ref: { type: 'string' },
    'no-discovery': { type: 'boolean' }, 'no-probes': { type: 'boolean' }, session: { type: 'string' }, probe: { type: 'string' },
  },
  run: async (ctx, values) => {
    if (values.probe != null) {
      // Launcher probe target (§8.6): answers with fixed JSON and does nothing else.
      if (!NONCE_RE.test(values.probe)) throw usageError('--probe takes an alphanumeric nonce');
      return { result: { adc_probe: values.probe, node: process.versions.node, exec: toPosix(process.execPath) }, exit: EXIT.OK };
    }
    if ((values.against || values.ref) && !values['verify-vendored']) throw usageError('--against and --ref are options of --verify-vendored');
    let init = null;
    if (values.init) {
      const info = resolveStateDir({ cwd: ctx.cwd, stateDirOption: ctx.stateDirOption });
      const tracked = info.root ? trackedStateFiles(info) : [];
      if (tracked.length) init = { dir: toPosix(info.dir), refused: `${info.rel}/ is tracked by git; run \`git rm -r --cached ${info.rel}\` first` };
      else if (ctx.dryRun) init = { dir: toPosix(info.dir), dry_run: true, would: ['create the state dir (0700)', ...(info.insideRepo ? [`add /${info.rel}/ to the exclude file`] : []), 'materialize budget.json and .env.live from the templates'] };
      else {
        const prepared = prepareStateDir(ctx, { create: true });
        const t = materializeTemplates(prepared);
        init = { dir: toPosix(prepared.dir), exclude: prepared.exclude, budget: t.budget, env_live: t.envLive };
        if (t.envLive.perms && !t.envLive.perms.ok) init.warning = '.env.live is still readable by others after chmod/icacls: this filesystem cannot hold permissions (WSL DrvFs, FAT/exFAT); relocate with ADC_HOME';
      }
    }
    const report = await doctorReport({
      cwd: ctx.cwd, stateDirOption: ctx.stateDirOption, discovery: !values['no-discovery'], probes: !values['no-probes'], session: values.session || null,
      vendored: values['verify-vendored'] ? { against: values.against || null, ref: values.ref || null, cwd: ctx.cwd } : null,
    });
    if (init) {
      report.init = init;
      if (init.warning) report.warnings.push(init.warning);
      if (init.env_live && !init.env_live.created && init.env_live.reason) report.warnings.push(`.env.live not created: ${init.env_live.reason}`);
    }
    let exit = EXIT.OK;
    if (report.state.tracked.length) exit = EXIT.ENV;
    else if (report.vendored && report.vendored.status === 'mismatch') exit = EXIT.FINDINGS;
    else if (report.vendored && ['unverified', 'none'].includes(report.vendored.status)) exit = EXIT.UNVERIFIABLE;
    const failing = report.prerequisites.filter((p) => p.category === 'required' && p.status === 'missing').length;
    return {
      result: report, exit, human: humanReport(report),
      summary: `${report.host_guess || 'unknown host'}; node ${report.node.version}; git ${report.git.version || 'missing'}; ${report.install_paths.length} cop${report.install_paths.length === 1 ? 'y' : 'ies'}; ${report.hooks.length} hook registration(s); ${report.warnings.length} warning(s)${failing ? `; ${failing} required item(s) missing` : ''}${exit === EXIT.ENV ? '; state dir tracked (exit 3)' : ''}`,
    };
  },
});
