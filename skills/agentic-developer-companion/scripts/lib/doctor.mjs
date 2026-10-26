// Environment and installation diagnostics (§6.6, §6.7, §8.6): host guess, OS, Node and Git,
// host CLIs against their floors, every prerequisite with the fallback in effect, every installed
// copy, registered hooks, launcher probes, the state dir, and `--verify-vendored` drift checks.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  EXIT, AdcError, usageError, unverifiable, defineCommand, readText, readJson, toPosix, relPosix, truncate, isObj,
  uniq, firstLine, lastLine, which, toolVersion, parseVersion, versionGte, nonce, quoteFor, spawnCapture, hostFromEnv,
  hostHomes, samePath, realPath, listFiles, makeTempDir, isAutomation, agentMarkers, runClass as runClassOf, isDir,
  isAbsolutePath, isWithin, plural, tryJson, IS_WINDOWS, SKILL_DIR, SKILL_NAME, ADC_SCRIPT, ASSETS_DIR, skillVersion,
} from './core.mjs';
import {
  gitTry, gitRaw, gitVersion, repoRoot, resolveBase, revParse, lsFiles, lsTree, readBlobs, gitPath, ignoredPaths,
  MIN_GIT,
} from './git.mjs';
import {
  resolveStateDir, statePaths, trackedStateFiles, credentialStatus, checkOwnerOnly, prepareStateDir,
  materializeTemplates, newestOpenSession, parseEnvFile, DEFAULT_BUDGET,
} from './state.mjs';
import { parseFrontmatter, normalizeSkillFrontmatter } from './frontmatter.mjs';
import { listRegisteredHooks } from './hooks-render.mjs';
import { makeRedactor, redactDeep } from './markers.mjs';
import { loadBudget, effectiveCaps, budgetView } from './live.mjs';

/** Prerequisite ids (assets/prerequisites.json) whose tools doctor runs or looks up on PATH. */
export const PROBED_TOOLS = Object.freeze([
  'git', 'node', 'gh', 'npx-skills', 'secret-scanner', 'diff-cover', 'mutation-tools', 'flake-tools',
  'external-validators', 'eval-runners', 'pwsh', 'git-bash', 'copilot', 'vscode', 'claude', 'codex',
]);

const MIN_NODE = '24.0.0';
const NONCE_RE = /^[A-Za-z0-9]{1,64}$/;
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const JUNK = ['.DS_Store', 'Thumbs.db', 'desktop.ini'];
// Node release lines and their end of life (nodejs.org release schedule).
const NODE_EOL = { 24: '2028-04-30', 25: '2026-06-01', 26: '2029-04-30', 27: '2027-06-01', 28: '2030-04-30' };
const HOOK_HOSTS = { copilot: 'copilot-cli', 'copilot-cloud': 'copilot-cloud', claude: 'claude-code', codex: 'codex' };
const NODE_PATH_HINT = 'render hooks with `setup hooks --node-path`';
const st = (status, detail) => ({ status, ...(detail ? { detail } : {}) });
const skillData = (text) => { const d = parseFrontmatter(text || '').data; return isObj(d) ? d : {}; };

// ---------------------------------------------------------------------------
// Host, runtime, installed copies (§3.1 discovery directories)

/** Host guess from environment markers (§8.4): `{ host, hooks_host, markers[], candidates[] }`. */
export function guessHostEnv(env = process.env) {
  const { tool, hooks, markers, candidates } = hostFromEnv(env);
  return { host: tool === 'unknown' ? null : tool, hooks_host: hooks, markers, candidates };
}

/** `{ major, lts, eol, warning }` for a Node version string. */
export function nodeEol(version, now = new Date()) {
  const v = String(version).replace(/^v/, '');
  const major = Number(v.split('.')[0]);
  const eol = NODE_EOL[major] || null;
  const days = eol ? (Date.parse(eol) - now.getTime()) / 86_400_000 : Infinity;
  const warning = !versionGte(v, MIN_NODE) ? `Node ${version} is below the required ${MIN_NODE}`
    : days < 0 ? `Node ${major} reached end of life on ${eol}; upgrade to the current LTS`
      : days < 180 ? `Node ${major} reaches end of life on ${eol}; plan the upgrade`
        : major % 2 ? `Node ${major} is an odd-numbered line (never LTS); use an LTS release` : null;
  return { major, lts: major % 2 === 0, eol, warning };
}

/** Install provenance from parsed frontmatter: `{ local_path, github: {key: value} }` or null. */
function provenanceOf(data) {
  const meta = isObj(data?.metadata) ? data.metadata : {};
  const gh = Object.entries(meta).filter(([k]) => k.startsWith('github-')).map(([k, v]) => [k, v?.toString() ?? null]);
  const local = meta['local-path'] != null ? toPosix(String(meta['local-path'])) : null;
  if (!local && !gh.length) return null;
  return { ...(local ? { local_path: local } : {}), ...(gh.length ? { github: Object.fromEntries(gh) } : {}) };
}

const PROJECT_DIRS = [
  ['.github/skills', ['copilot-cli', 'vscode', 'copilot-cloud', 'copilot-code-review']],
  ['.agents/skills', ['copilot-cli', 'vscode', 'copilot-cloud', 'codex']],
  ['.claude/skills', ['claude-code', 'copilot-cli', 'vscode', 'copilot-cloud']],
  ['.codex/skills', ['codex']],
];

/** Skill directories each host scans, from the repository (cwd up to the root) and the user's homes. */
function discoveryDirs({ root = null, cwd = process.cwd(), env = process.env } = {}) {
  const out = [];
  const add = (dir, scope, location, hosts) => {
    const abs = path.resolve(dir);
    if (!out.some((o) => o.dir === abs)) out.push({ dir: abs, scope, location, hosts });
  };
  for (let d = root && (isWithin(root, cwd) ? path.resolve(cwd) : root); d; d = path.dirname(d)) {
    for (const [rel, hosts] of PROJECT_DIRS) add(path.join(d, ...rel.split('/')), 'project', rel, hosts);
    if (relPosix(root, d) === '.' || path.dirname(d) === d) break;
  }
  const h = hostHomes({ env });
  add(path.join(h.copilot, 'skills'), 'user', '~/.copilot/skills', ['copilot-cli', 'vscode']);
  add(path.join(h.home, '.agents', 'skills'), 'user', '~/.agents/skills', ['copilot-cli', 'vscode', 'codex']);
  add(path.join(h.claude, 'skills'), 'user', '~/.claude/skills', ['claude-code', 'vscode']);
  add(path.join(h.codex, 'skills'), 'user', '~/.codex/skills', ['codex']);
  for (const d of uniq(String(env.COPILOT_SKILLS_DIRS || '').split(',').map((x) => x.trim()))) {
    add(d, 'env', 'COPILOT_SKILLS_DIRS', ['copilot-cli']);
  }
  for (const name of ['settings.json', 'config.json']) {
    const dirs = readJson(path.join(h.copilot, name), null)?.skillDirectories;
    for (const d of (Array.isArray(dirs) ? dirs : []).filter((x) => typeof x === 'string' && x)) {
      add(path.resolve(h.home, d.replace(/^~(?=[/\\]|$)/, h.home)), 'registered', `${name} skillDirectories`,
        ['copilot-cli']);
    }
  }
  if (!IS_WINDOWS) add('/etc/codex/skills', 'admin', '/etc/codex/skills', ['codex']);
  return out;
}

function describeCopy(dir, { scope, location, hosts, root }) {
  const data = skillData(readText(path.join(dir, 'SKILL.md'), ''));
  const rel = scope === 'project' && root ? relPosix(root, dir) : undefined;
  let symlink = false;
  try { symlink = fs.lstatSync(dir).isSymbolicLink(); } catch {}
  return {
    path: toPosix(dir), scope, location, hosts, version: data.metadata?.version?.toString() ?? null,
    name_ok: data.name === SKILL_NAME, has_script: fs.existsSync(path.join(dir, 'scripts', 'adc.mjs')),
    this_copy: samePath(dir, SKILL_DIR), ...(symlink ? { symlink, target: toPosix(realPath(dir)) } : {}),
    provenance: provenanceOf(data),
    ...(rel !== undefined ? { rel, tracked: Boolean(rel) && lsFiles(root, [`${rel}/SKILL.md`]).length > 0 } : {}),
  };
}

/** Every copy of this skill in a directory some host scans, plus the running copy. */
function findInstalledCopies({ root = null, cwd = process.cwd(), env = process.env } = {}) {
  const copies = [];
  for (const d of discoveryDirs({ root, cwd, env })) {
    // A registered folder may be the skill itself rather than its parent.
    for (const c of [path.join(d.dir, SKILL_NAME), ...(['registered', 'env'].includes(d.scope) ? [d.dir] : [])]) {
      const md = readText(path.join(c, 'SKILL.md'));
      if (md == null || (c === d.dir && path.basename(c) !== SKILL_NAME && skillData(md).name !== SKILL_NAME)) continue;
      const seen = copies.find((x) => samePath(x.path, c));
      if (seen) seen.also_listed_as = [...(seen.also_listed_as || []), d.location];
      else copies.push(describeCopy(c, { ...d, root }));
    }
  }
  // A running copy outside the scanned directories (even inside the repository) loads only when registered.
  const location = 'running copy (not in a scanned directory)';
  if (!copies.some((c) => c.this_copy)) copies.push(describeCopy(SKILL_DIR, { scope: 'other', location, hosts: [] }));
  return copies;
}

// ---------------------------------------------------------------------------
// Launcher probes (§8.6): run adc.mjs through each launcher a host uses and expect exact JSON

const LAUNCH = {
  win32: { 'copilot-cli': ['pwsh', 'powershell'], vscode: ['pwsh', 'powershell'], 'copilot-cloud': ['bash'],
    'claude-code': ['exec', 'bash', 'powershell'], codex: ['cmd', 'pwsh'] },
  posix: { 'copilot-cli': ['bash'], vscode: ['bash'], 'copilot-cloud': ['bash'], 'claude-code': ['exec', 'sh'],
    codex: ['login-shell'] },
};
const ORDER = { win32: ['exec', 'cmd', 'pwsh', 'powershell', 'bash'], posix: ['exec', 'sh', 'bash', 'login-shell'] };

/** The launchers a host uses on this platform (all available ones when the host is unknown). */
function launchersFor(hosts, { env = process.env, platform = process.platform } = {}) {
  const p = platform === 'win32' ? 'win32' : 'posix';
  const wanted = new Set(hosts?.length ? hosts.flatMap((h) => LAUNCH[p][h] || []) : ORDER[p]);
  const shell = env.SHELL && fs.existsSync(env.SHELL) ? env.SHELL : fs.existsSync('/bin/sh') ? '/bin/sh' : null;
  const onPath = (n) => (which(n, env) ? n : null);
  const programs = {
    exec: ['exec (no shell)', 'node'], sh: ['sh -c', onPath('sh')], bash: ['bash -c', onPath('bash')],
    'login-shell': [`${shell ? path.basename(shell) : '$SHELL'} -lc`, shell],
    pwsh: ['pwsh -NoProfile -Command', onPath('pwsh')],
    powershell: ['powershell.exe -NoProfile -Command', onPath('powershell')],
    cmd: ['cmd.exe /C', env.ComSpec || which('cmd', env) || 'cmd.exe'],
  };
  return ORDER[p].filter((id) => wanted.has(id)).map((id) => ({
    id, label: programs[id][0], program: programs[id][1],
    users: Object.keys(LAUNCH[p]).filter((h) => LAUNCH[p][h].includes(id)),
  }));
}

function probeInvocation(l, n) {
  const script = toPosix(ADC_SCRIPT);
  const tail = `doctor --probe ${n} --json`;
  if (l.id === 'exec') return { file: 'node', args: [ADC_SCRIPT, ...tail.split(' ')] };
  const q = (shell) => quoteFor(shell, script, { always: true });
  const run = (...args) => ({ file: l.program, args });
  if (l.id === 'cmd') return { ...run('/d', '/s', '/c', `"node "${script}" ${tail}"`), verbatim: true };
  if (l.id.includes('sh')) return run(l.id === 'login-shell' ? '-lc' : '-c', `node ${q('sh-double')} ${tail}`);
  return run('-NoProfile', '-NoLogo', '-Command', `& node ${q('pwsh')} ${tail}`);
}

/** Run the probe through each launcher; `ok` only when stdout is exactly the expected JSON. */
export async function launcherProbes(hosts, { env = process.env, cwd = process.cwd(), redact = (s) => s } = {}) {
  return Promise.all(launchersFor(hosts, { env }).map(async (l) => {
    if (!l.program) return { launcher: l.label, used_by: l.users, ok: null, skipped: 'launcher not installed' };
    const n = nonce().slice(0, 16);
    const inv = probeInvocation(l, n);
    const opts = { cwd, env, timeoutMs: 20_000, windowsVerbatimArguments: Boolean(inv.verbatim) };
    const r = await spawnCapture(inv.file, inv.args, opts);
    const row = { launcher: l.label, used_by: l.users, ok: false, ms: r.ms, exit: r.exit };
    const out = r.stdout.trim();
    const parsed = tryJson(out);
    if (parsed?.adc_probe === n) {
      const old = parsed.node && !versionGte(String(parsed.node), MIN_NODE);
      return { ...row, ok: !old, node_version: String(parsed.node || ''), node_path: parsed.exec?.toString() || null,
        ...(old ? { detail: `node ${parsed.node} is too old` } : {}) };
    }
    const tooOld = /Node\.js 24\+ is required \(found ([^)]+)\)/.exec(r.stderr);
    row.detail = r.error && r.exit == null ? `could not start: ${r.error}` : r.timedOut ? 'timed out'
      : out.includes('"adc_probe"') ? 'stdout has extra output around the JSON (shell profile?); hooks would be ignored'
        : tooOld ? `this launcher resolves Node ${tooOld[1]} (24+ required, a shell profile?); ${NODE_PATH_HINT}`
          : r.exit === 127 || r.exit === 9009 || /not (found|recognized)|No such file/i.test(r.stderr)
            ? `node is not on the PATH this launcher sees; ${NODE_PATH_HINT}`
            : truncate(redact(firstLine(r.stderr || r.stdout) || `exit ${r.exit}`), 200);
    return row;
  }));
}

/** Prerequisite status for a tool entry of assets/prerequisites.json. */
function probeTool(item, env) {
  const c = item.check;
  const tools = item.tools || [];
  const found = tools.filter((t) => which(t, env));
  if (!c?.cmd && !tools.length) return st('unknown');
  if (!c?.cmd) return found.length ? { status: 'present', tool: found.join(', '), path: toPosix(which(found[0], env)) }
    : { status: 'missing', tool: tools.join(' | ') };
  if (!which(c.cmd, env)) return { status: 'missing', tool: c.cmd };
  const v = toolVersion(c.cmd, c.args || ['--version']);
  const version = v?.version || null;
  const min = parseVersion(item.minimum) ? String(item.minimum) : null;
  if (min && version && !versionGte(version, min)) return { status: 'old', tool: c.cmd, version, path: v.path };
  return { status: version || !min ? 'present' : 'unknown', tool: c.cmd, version, path: v?.path || null,
    ...(version ? {} : { detail: 'version not recognised' }) };
}

/** Git Bash on Windows (CLAUDE_CODE_GIT_BASH_PATH, else bin/bash.exe beside git's cmd/); never WSL's System32 bash. */
export function gitBashPath(env = process.env, find = (n) => which(n, env)) {
  const set = env.CLAUDE_CODE_GIT_BASH_PATH;
  if (set) return fs.existsSync(set) ? set : null;
  const git = find('git');
  const beside = git && path.join(path.dirname(path.dirname(git)), 'bin', 'bash.exe');
  if (beside && fs.existsSync(beside)) return beside;
  const bash = find('bash');
  return bash && !/[\\/]system32[\\/]/i.test(bash) ? bash : null;
}

const winOnly = (fn) => (f) => (IS_WINDOWS ? fn(f) : st('n/a', 'Windows only'));
const inRepo = (...files) => ({ repo }) => (!repo.root ? st('n/a')
  : st(files.some((p) => fs.existsSync(path.join(repo.root, p))) ? 'present' : 'missing'));
const COMPUTED = {
  host: (f) => (f.hostsPresent.length ? st('present', f.hostsPresent.join(', '))
    : st('unknown', 'no host CLI on PATH (VS Code and the cloud agent cannot be detected from a shell)')),
  'shell-permission': (f) => (f.agent ? st('present', 'this command ran through the host\'s shell tool')
    : st('unknown', 'granted per host session; not checkable from a terminal')),
  'state-dir': ({ state: s }) => (s.tracked.length ? st('missing', `${s.rel || '.adc'}/ is tracked by git`)
    : !s.exists ? st('unknown', 'not created yet (`doctor --init` or the first QA run creates it)')
      : s.ignored ? st('present', s.dir) : st('missing', 'exists but is not ignored by git')),
  'temp-dir': ({ tempWritable: w }) => st(w ? 'present' : 'missing', toPosix(os.tmpdir()) + (w ? '' : ' not writable')),
  'qa-repo': ({ repo: r }) => (!r.root ? st('missing', 'not inside a Git work tree')
    : r.base_error ? st('missing', r.base_error) : st('present', `base ${r.base_ref || 'none'} (${r.base_source})`)),
  'node-launcher': ({ probes: ps }) => {
    const [ok, bad] = [ps.filter((p) => p.ok), ps.filter((p) => p.ok === false)];
    return bad.length ? st('missing', bad.map((p) => `${p.launcher}: ${p.detail}`).join('; '))
      : ok.length ? st('present', ok.map((p) => p.launcher).join(', ')) : st('unknown', 'launcher probes not run');
  },
  'hooks-registered': ({ hooks }) => st(hooks.length ? 'present' : 'missing', hooks.map((h) => h.host).join()),
  'live-token': ({ state: { credential: c } }) => (c.set ? st('present', `set (source: ${c.source})`)
    : st('missing', 'unset')),
  'budget-ledger': ({ state: { budget: b } }) => st(b.valid ? 'present' : 'missing', b.valid ? '' : b.error),
  'adc-debug': ({ env }) => st(env.ADC_DEBUG === '1' ? 'present' : 'missing'),
  'copilot-skill-add': ({ tools: { copilot: c } }) => (c?.status === 'missing' ? st('missing') : c),
  'copilot-setup-steps': inRepo('.github/workflows/copilot-setup-steps.yml'),
  codeowners: inRepo('CODEOWNERS', '.github/CODEOWNERS', 'docs/CODEOWNERS'),
  longpaths: winOnly((f) => st(f.longpaths ? 'present' : 'missing')),
};

function prereqRows(items, facts) {
  return items.map((item) => {
    const r = item.id === 'node' ? facts.nodeOnPath : item.id === 'git-bash' && !IS_WINDOWS ? st('n/a', 'Windows only')
      : facts.tools[item.id] || COMPUTED[item.id]?.(facts) || st('unknown', 'project- or host-specific; not checked');
    return {
      id: item.id, category: item.category, group: item.group, name: item.name, minimum: item.minimum ?? null,
      status: r.status, ...(r.version ? { version: r.version } : {}), ...(r.tool ? { tool: r.tool } : {}),
      ...(r.detail ? { detail: r.detail } : {}),
      ...(['missing', 'old'].includes(r.status) ? { in_effect: item.fallback || item.without || null } : {}),
    };
  });
}

// ---------------------------------------------------------------------------
// --verify-vendored: compare a vendored copy with its pinned release

/** A folder's files as `Map(rel → () => Buffer)`; links are followed, `.git` and OS junk skipped. */
function dirFiles(dir) {
  const opts = { ignore: new Set(['.git', ...JUNK]), followSymlinks: true, maxDepth: 20, maxFiles: Infinity };
  const rels = listFiles(dir, opts);
  return new Map(rels.map((r) => [r, () => fs.readFileSync(path.join(dir, r))]));
}

/** Files of the skill folder inside a commit: `{ commit, skill_path, files: Map(rel → () => Buffer) }`. */
function gitSkillTree(gitDir, commitish, { skillPath = null } = {}) {
  const commit = revParse(gitDir, commitish);
  if (!commit) throw usageError(`"${commitish}" does not name a commit in ${toPosix(gitDir)}`);
  const want = skillPath ? toPosix(skillPath).replace(/\/?SKILL\.md$/i, '').replace(/^\/+|\/+$/g, '') : null;
  const has = (p) => gitRaw(gitDir, ['cat-file', '-e', `${commit}:${p ? `${p}/` : ''}SKILL.md`]).exit === 0;
  const sp = [want, `skills/${SKILL_NAME}`, ''].filter((p) => p !== null).find(has);
  if (sp === undefined) throw unverifiable('NO_SKILL_IN_REF', `no SKILL.md in ${commitish} (root, skills/<name>)`);
  const entries = lsTree(gitDir, commit, { entries: true, paths: sp ? [sp] : [] }).filter((e) => e.type === 'blob')
    .map((e) => ({ rel: sp ? e.path.slice(sp.length + 1) : e.path, sha: e.sha }))
    .filter((e) => !JUNK.includes(path.posix.basename(e.rel)));
  const blobs = readBlobs(gitDir, entries.map((e) => e.sha));
  const files = new Map(entries.map((e) => [e.rel, () => blobs.get(e.sha) || Buffer.alloc(0)]));
  return { commit, skill_path: sp || '.', files };
}

const isUrl = (s) => /^(?:https?|ssh|git|file):\/\//i.test(s) || /^[\w.-]+@[\w.-]+:/.test(s);

/** Shallow-fetch `ref` from `url` into a temp bare repo; its blobs are read before it is removed. */
function fetchRemote(url, ref, skillPath) {
  const dir = makeTempDir('vendored');
  const env = { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '' };
  try {
    if (gitRaw(dir, ['init', '--bare', '-q', '.'], { env }).exit) throw unverifiable('GIT_FAILED', 'git init failed');
    const args = ['-c', 'protocol.file.allow=always', 'fetch', '--depth', '1', '--no-tags', '--quiet', url, ref];
    const r = gitRaw(dir, args, { env, timeoutMs: 180_000 });
    const why = lastLine(r.stderr) || `exit ${r.exit}`;
    if (r.exit) throw unverifiable('FETCH_FAILED', `could not fetch ${ref} from ${url}: ${why}`);
    return gitSkillTree(dir, 'FETCH_HEAD', { skillPath });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** A copy's upstream from `github-*` provenance or metadata.homepage: `{ url, ref, skill_path, from_provenance }`. */
function provenanceRemote(prov, data) {
  const gh = prov?.github || {};
  const host = /^[A-Za-z0-9.-]+$/.test(gh['github-host'] || '') ? gh['github-host'] : 'github.com';
  const [repo, owner, home] = [gh['github-repo'], gh['github-owner'], String(data?.metadata?.homepage || '')];
  const homeRepo = /^https:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+\/?$/.test(home) && home.replace(/\/+$|\.git\/*$/g, '');
  const url = repo && isUrl(repo) ? repo : repo?.includes('/') ? `https://${host}/${repo.replace(/\.git$/, '')}.git`
    : repo && owner ? `https://${host}/${owner}/${repo}.git` : homeRepo ? `${homeRepo}.git` : null;
  const ref = ['github-sha', 'github-pinned', 'github-ref'].map((k) => gh[k])
    .find((v) => v && REF_RE.test(v) && !/^(?:true|false)$/i.test(v)) || null;
  return { url, ref, skill_path: gh['github-path'] || null, from_provenance: Boolean(repo) };
}

/** Compare SKILL.md semantically (install rewrites the frontmatter); returns `{ status, detail }`. */
export function compareSkillMd(refBuf, copyBuf) {
  if (refBuf.equals(copyBuf)) return { status: 'identical' };
  const [a, b] = [refBuf, copyBuf].map((buf) => parseFrontmatter(buf.toString('utf8')));
  const [da, db] = [a, b].map((p) => normalizeSkillFrontmatter(isObj(p.data) ? p.data : {}));
  const body = (s) => String(s || '').replace(/\r\n?/g, '\n').replace(/^\n+/, '').replace(/\s+$/, '');
  const same = (k) => JSON.stringify(da[k]) === JSON.stringify(db[k]);
  const keys = uniq([...Object.keys(da), ...Object.keys(db)]).filter((k) => !same(k));
  const bodyDiffers = body(a.body) !== body(b.body);
  const errors = (a.errors?.length || 0) + (b.errors?.length || 0);
  if (!keys.length && !bodyDiffers && !errors) {
    return { status: 'equivalent', detail: 'frontmatter equal without install provenance and key order; body equal' };
  }
  const detail = { frontmatter_keys: keys, body_differs: bodyDiffers, ...(errors ? { parse_errors: errors } : {}) };
  return { status: 'different', detail };
}

/** Compare a reference file map with a copy's: `{ status, missing, extra, changed, changed_eol_only, skill_md }`. */
function compareSkillTrees(refFiles, copyFiles) {
  const [missing, changed, eolOnly] = [[], [], []];
  let skillMd = { status: 'missing' };
  const lf = (buf) => buf.toString('latin1').replace(/\r\n/g, '\n');
  for (const rel of [...refFiles.keys()].sort()) {
    if (!copyFiles.has(rel)) { missing.push(rel); continue; }
    const [a, b] = [refFiles.get(rel)(), copyFiles.get(rel)()];
    if (rel === 'SKILL.md') skillMd = compareSkillMd(a, b);
    else if (!a.equals(b)) changed.push(rel) && lf(a) === lf(b) && eolOnly.push(rel);
  }
  const extra = [...copyFiles.keys()].sort().filter((rel) => !refFiles.has(rel));
  const ok = !missing.length && !extra.length && !changed.length && skillMd.status !== 'different';
  return { status: ok ? 'match' : 'mismatch', compared: refFiles.size, missing, extra, changed,
    ...(eolOnly.length ? { changed_eol_only: eolOnly } : {}), skill_md: skillMd };
}

function referenceFor(copy, { against, ref, cwd }) {
  const p = provenanceRemote(copy.provenance, skillData(readText(path.join(copy.path, 'SKILL.md'), '')));
  const remote = (url, r = ref || p.ref || 'HEAD') => ({ kind: 'remote', source: url, ref: r,
    ...fetchRemote(url, r, p.skill_path) });
  const local = (kind, dir) => ({ kind, source: toPosix(dir), ref: null, files: dirFiles(dir) });
  if (against && isUrl(against)) return remote(against);
  if (against) {
    const dir = path.resolve(cwd, against);
    if (!fs.existsSync(dir)) throw usageError(`--against does not exist: ${toPosix(dir)}`);
    const isGit = gitRaw(dir, ['rev-parse', '--git-dir']).exit === 0;
    if (ref && !isGit) throw usageError(`--ref needs --against to be a Git clone or a URL: ${toPosix(dir)}`);
    if (ref) return { kind: 'git', source: toPosix(dir), ref, ...gitSkillTree(dir, ref, { skillPath: p.skill_path }) };
    const skillDir = [dir, path.join(dir, 'skills', SKILL_NAME)].find((d) => fs.existsSync(path.join(d, 'SKILL.md')));
    if (!skillDir) throw usageError(`--against has no SKILL.md or skills/${SKILL_NAME}/SKILL.md: ${toPosix(dir)}`);
    return local('dir', skillDir);
  }
  if (ref || p.from_provenance) {
    if (!p.url) throw unverifiable('NO_UPSTREAM', 'no upstream known (no github-* provenance); pass --against');
    return remote(p.url);
  }
  const lp = copy.provenance?.local_path;
  if (lp && fs.existsSync(path.join(lp, 'SKILL.md')) && !samePath(lp, copy.path)) return local('local-path', lp);
  if (!samePath(SKILL_DIR, copy.path)) return local('running-copy', SKILL_DIR);
  throw unverifiable('NO_REFERENCE', 'nothing to compare with: pass --ref <tag> or --against <dir | clone | URL>');
}

/** Compare each vendored (project-scope) copy with its pinned release: `{ status, copies[] }`. */
function verifyVendored(copies, { against = null, ref = null, cwd = process.cwd() } = {}) {
  const vendored = copies.filter((c) => c.scope === 'project');
  if (!vendored.length) return { status: 'none', detail: 'no copy of the skill in a project skill folder', copies: [] };
  const rows = vendored.map((copy) => {
    const { path: p, rel, tracked, version, provenance } = copy;
    const row = { path: p, rel, tracked, version, provenance };
    try {
      const t = referenceFor(copy, { against, ref, cwd });
      row.reference = { kind: t.kind, source: t.source, ref: t.ref, ...(t.commit ? { commit: t.commit } : {}),
        ...(t.skill_path ? { skill_path: t.skill_path } : {}) };
      return Object.assign(row, compareSkillTrees(t.files, dirFiles(copy.path)));
    } catch (err) {
      if (!(err instanceof AdcError) || err.exit === EXIT.USAGE) throw err;
      return Object.assign(row, { status: 'unverified', reason: err.code, detail: err.message });
    }
  });
  return { status: ['mismatch', 'unverified'].find((s) => rows.some((r) => r.status === s)) || 'match', copies: rows };
}

// ---------------------------------------------------------------------------
// The report

function stateReport(info, { env, sessionId }) {
  const p = statePaths(info.dir);
  let exclude = null;
  try {
    const file = info.insideRepo && gitPath(info.root, 'info/exclude');
    const lines = file && readText(file, '').split(/\r?\n/).map((l) => l.trim());
    const entries = [`/${info.rel}/`, `/${info.rel}`, `${info.rel}/`];
    if (file) exclude = { file: toPosix(file), entry_present: entries.some((e) => lines.includes(e)) };
  } catch { exclude = { file: null, entry_present: false }; }
  // Both ignore checks from one `git check-ignore` (a path outside the repository is never committed).
  const ignored = info.insideRepo ? ignoredPaths(info.root, [`${info.rel}/.env.live`, `${info.rel}/probe`]) : null;
  const isIgnored = (sub) => !ignored || ignored.has(`${info.rel}/${sub}`);
  const envLive = { exists: fs.existsSync(p.envLive), ignored: isIgnored('.env.live') };
  if (envLive.exists) envLive.perms = checkOwnerOnly(p.envLive);
  const { budget: b, ...loaded } = loadBudget(info);
  const cls = runClassOf({}, env);
  const hook = !sessionId && newestOpenSession(info.dir);
  const open = sessionId ? { id: sessionId, source: 'flag' } : hook && { id: String(hook.id), source: 'session-file' };
  const caps = effectiveCaps(b, { runClass: cls, session: open ? b.sessions[open.id] : null, env });
  const view = { sessionId: open?.id || '(next)', identitySource: open?.source || 'generated', caps, runClass: cls };
  return {
    dir: toPosix(info.dir), rel: info.rel, source: info.source, inside_repo: info.insideRepo, exists: isDir(info.dir),
    tracked: trackedStateFiles(info).slice(0, 20), exclude, ignored: isIgnored('probe'), env_live: envLive,
    credential: credentialStatus(info, env),
    budget: {
      path: loaded.path, exists: loaded.exists, valid: loaded.valid, ...(loaded.valid ? {} : { error: loaded.error }),
      unit: b.unit, max_per_session: b.max_per_session, max_per_day: b.max_per_day, warn_at: b.warn_at,
      defaults_exceeded: loaded.defaults_exceeded, run_class: cls, effective: { session: caps.session, day: caps.day },
      today: budgetView(b, view), overrides: Object.entries(b.sessions).filter(([, x]) => isObj(x.override))
        .map(([id, x]) => ({ session: id, ...x.override })),
    },
  };
}

/** Warnings about the state dir, the credential and the budget. */
function stateWarnings(s, { env, info, wsl }) {
  const rel = s.rel || '.adc';
  const { perms } = s.env_live;
  const [b, def] = [s.budget, DEFAULT_BUDGET.max_per_session];
  return [
    s.tracked.length && `${rel}/ is tracked by git: every CLI command exits 3; run \`git rm -r --cached ${rel}\``,
    s.exists && s.inside_repo && !s.ignored && `${rel}/ is not git-ignored: run \`doctor --init\` (check for !.adc/**)`,
    perms && !perms.ok && `${rel}/.env.live is not owner-only (${perms.mode || perms.detail}): run \`doctor --init\`; `
      + 'if that does not help, the filesystem cannot hold permissions (WSL DrvFs, FAT): relocate with ADC_HOME',
    s.env_live.exists && !s.env_live.ignored && `${rel}/.env.live is not git-ignored, so \`live run\` will not read it`,
    env.ADC_LIVE_TOKEN && runClassOf({}, env) !== 'ci' && 'ADC_LIVE_TOKEN is set in this session\'s environment, so '
      + 'every tool call and hook inherits it; on developer machines keep it in .adc/.env.live',
    isAutomation(env) && s.credential.set && s.credential.source !== 'environment'
      && 'CI and cloud-agent runs never read .env.live: give `live run` ADC_LIVE_TOKEN as an environment secret',
    b.defaults_exceeded && `budget.json raises the caps above the shipped defaults (${def}): ${b.max_per_session} per `
      + `session, ${b.max_per_day} per day (agent runs keep ${def})`,
    b.exists && !b.valid && `budget.json is ${b.error}: headless runs refuse (BUDGET_UNVERIFIED) with spend today`,
    ...b.overrides.map((o) => `session ${o.session} carries a terminal override of the session cap: ${o.max}`),
    wsl && /^\/mnt\/[a-z]\//i.test(toPosix(info.dir)) && 'the state dir is on a Windows drive under WSL (DrvFs), '
      + 'which may not hold owner-only modes; use ADC_HOME',
  ].filter(Boolean);
}

/** Warnings about installed copies and registered hooks. */
function installWarnings(copies, hooks, root) {
  const out = [];
  const versions = uniq(copies.map((c) => c.version));
  if (versions.length > 1) out.push(`installed copies have different versions (${versions.join(', ')})`);
  const project = copies.filter((c) => c.scope === 'project').map((c) => c.location);
  const review = 'no copy in .github/skills, the only folder Copilot code review reads';
  if (project.length && !project.includes('.github/skills')) out.push(review);
  for (const c of copies) if (!c.name_ok) out.push(`${c.path}/SKILL.md does not declare name: ${SKILL_NAME}`);
  const self = copies.find((c) => c.this_copy && !c.hosts.length);
  if (self) out.push(`this copy (${self.path}) is in no directory a host scans; it loads only if registered or copied`);
  for (const h of hooks) {
    if (h.present === false) out.push(`hooks recorded in .adc/hooks-installed.json are missing from ${h.file}`);
    else if (h.matches_current === false) out.push(`${h.host} hooks in ${h.file} differ from the template`);
    for (const sp of h.skill_paths || []) {
      const abs = isAbsolutePath(sp) || !root ? sp : path.join(root, sp);
      const dead = !fs.existsSync(path.join(abs, 'scripts', 'adc.mjs'));
      if (dead) out.push(`${h.host} hooks in ${h.file} point at ${sp}, which has no scripts/adc.mjs (dead hook)`);
    }
  }
  return out;
}

function runtime(env) {
  const e = nodeEol(process.versions.node);
  const p = toolVersion('node', ['--version']);
  const gv = gitVersion();
  const node = { version: process.versions.node, path: toPosix(process.execPath), minimum: MIN_NODE,
    ok: versionGte(process.versions.node, MIN_NODE), lts: e.lts, eol: e.eol, ...(e.warning && { warning: e.warning }),
    ...(p ? { on_path: { version: p.version, path: p.path, same: samePath(p.path, process.execPath) } } : {}) };
  const gitExe = which('git', env);
  const git = { version: gv, path: gitExe && toPosix(gitExe), minimum: MIN_GIT,
    ok: Boolean(gv && versionGte(gv, MIN_GIT)) };
  const warnings = [
    e.warning, !p && `\`node\` is not on PATH, but hooks run the bare \`node\` command; ${NODE_PATH_HINT}`,
    p?.version && !versionGte(p.version, MIN_NODE) && `the \`node\` on PATH is ${p.version}; ${NODE_PATH_HINT}`,
    !gv && 'git is not on PATH: QA modes cannot run (exit 3) and hooks emit {}',
    gv && !git.ok && `Git ${gv} is older than ${MIN_GIT}`,
  ];
  const nodeOnPath = { status: !p ? 'missing' : versionGte(p.version, MIN_NODE) ? 'present' : 'old', tool: 'node',
    ...(p && { version: p.version }) };
  return { node, git, nodeOnPath, warnings: warnings.filter(Boolean) };
}

/** Build the doctor report. `opts`: `{ cwd, env, stateDirOption, probes, vendored, session }`. */
export async function doctorReport({
  cwd = process.cwd(), env = process.env, stateDirOption = null, probes = true, vendored = null, session = null,
} = {}) {
  const root = repoRoot(cwd);
  const info = resolveStateDir({ cwd, stateDirOption, env, root });
  // The file value is read only to redact it from free text (probe output, CLI errors).
  const fileToken = parseEnvFile(readText(statePaths(info.dir).envLive, '')).ADC_LIVE_TOKEN;
  const literals = [env.ADC_LIVE_TOKEN, fileToken].map((value) => ({ name: 'ADC_LIVE_TOKEN', value }));
  const redact = makeRedactor({ literals, env });
  const guess = guessHostEnv(env);
  const warnings = [];
  let hooks = [];
  try { hooks = listRegisteredHooks({ root, env }); } catch (err) { warnings.push(`hooks not listed: ${err.message}`); }
  // The launcher probes run while the rest is collected; awaited below.
  const probeHosts = uniq([guess.host, ...hooks.map((h) => HOOK_HOSTS[h.host])]);
  const probesP = probes ? launcherProbes(probeHosts, { env, cwd, redact }) : [];
  const rt = runtime(env);
  warnings.push(...rt.warnings);
  const items = readJson(path.join(ASSETS_DIR, 'prerequisites.json'), null)?.items;
  const prereqs = Array.isArray(items) ? items : [];
  if (!prereqs.length) warnings.push('assets/prerequisites.json is missing or unreadable');
  const tools = {};
  for (const id of PROBED_TOOLS.filter((t) => t !== 'node' && (t !== 'git-bash' || IS_WINDOWS))) {
    const item = prereqs.find((i) => i.id === id);
    const bash = id === 'git-bash' && gitBashPath(env);
    const gitBash = bash ? { status: 'present', tool: 'bash', path: toPosix(bash) } : st('missing', 'no Git Bash');
    if (!item) warnings.push(`assets/prerequisites.json has no entry for "${id}"`);
    else tools[id] = id === 'git-bash' ? gitBash : probeTool(item, env);
  }
  const hosts = prereqs.filter((i) => i.category === 'host').map((i) => {
    const t = tools[i.id] || { status: 'missing' };
    const ok = t.status === 'present' ? true : t.status === 'old' ? false : null;
    if (ok === false) warnings.push(`${i.name} ${t.version} is older than the supported ${i.minimum}`);
    const present = ['present', 'old', 'unknown'].includes(t.status);
    return { id: i.id, name: i.name, present, version: t.version || null, minimum: i.minimum, ok, path: t.path };
  });
  const repo = { root: root && toPosix(root) };
  try { if (root) ({ ref: repo.base_ref, source: repo.base_source } = resolveBase(root, null)); }
  catch (err) { repo.base_error = err.message; }
  let tempWritable = false;
  try { fs.rmSync(makeTempDir('doctor'), { recursive: true, force: true }); tempWritable = true; } catch {}
  const state = stateReport(info, { env, sessionId: session });
  const procVersion = process.platform === 'linux' ? readText('/proc/version', '') : '';
  const wsl = Boolean(procVersion && (env.WSL_DISTRO_NAME || /microsoft/i.test(procVersion)));
  warnings.push(...stateWarnings(state, { env, info, wsl }));

  const copies = findInstalledCopies({ root, cwd, env });
  warnings.push(...installWarnings(copies, hooks, root));
  const probeRows = await probesP;
  for (const p of probeRows.filter((x) => x.ok === false)) {
    warnings.push(`launcher probe ${p.launcher} failed: ${p.detail || 'unexpected output'} (such hooks are dead)`);
  }
  const facts = {
    env, agent: agentMarkers(env).length > 0, tools, state, tempWritable, repo, probes: probeRows, hooks,
    nodeOnPath: rt.nodeOnPath, hostsPresent: hosts.filter((h) => h.present).map((h) => h.id),
    longpaths: IS_WINDOWS && rt.git.version && gitTry(root || cwd, ['config', '--get', 'core.longpaths']) === 'true',
  };
  const shell = IS_WINDOWS ? env.ComSpec : env.SHELL;
  const report = {
    schema: 'adc-doctor/1',
    skill: { name: SKILL_NAME, version: skillVersion(), path: toPosix(SKILL_DIR), script: toPosix(ADC_SCRIPT),
      invoke: `node "${toPosix(ADC_SCRIPT)}" <command> --json` },
    host_guess: guess.host, hooks_host: guess.hooks_host, host_markers: guess.markers,
    host_candidates: guess.candidates,
    os: { platform: process.platform, release: os.release(), arch: process.arch, shell: shell && path.basename(shell),
      wsl },
    node: rt.node, git: rt.git, hosts, repo, install_paths: copies, hooks, probes: probeRows, state,
    prerequisites: prereqRows(prereqs, facts), warnings,
  };
  if (vendored) {
    report.vendored = verifyVendored(copies, vendored);
    const v = report.vendored.status;
    if (v === 'mismatch') warnings.push('a vendored copy differs from its reference release (see vendored.copies)');
    if (v === 'unverified') warnings.push('a vendored copy could not be compared with a release (see vendored.copies)');
  }
  return redactDeep(report, redact, { keys: true });
}

function humanReport(r) {
  const s = r.state;
  const list = (label, xs) => (xs?.length ? `; ${label} ${xs.slice(0, 5).join(', ')}` : '');
  const flags = (c) => [c.scope, c.this_copy && 'this copy', c.tracked && 'tracked'].filter(Boolean).join(', ');
  const counts = Object.entries(Object.groupBy(r.prerequisites, (p) => p.status)).map(([k, v]) => `${v.length} ${k}`);
  const token = s.credential.set ? `set (source: ${s.credential.source})` : 'unset';
  return [
    `${r.skill.name} ${r.skill.version} doctor (${r.skill.script})`,
    `host ${r.host_guess || 'unknown'}; ${r.os.platform} ${r.os.release}${r.os.wsl ? ' (WSL)' : ''}`,
    `node ${r.node.version}${r.node.ok ? '' : ' (too old)'}`,
    `git ${r.git.version || 'missing'}${r.git.version && !r.git.ok ? ' (too old)' : ''}`,
    `hosts: ${r.hosts.map((h) => `${h.id} ${h.present ? h.version || '?' : 'missing'}`).join(', ')}`,
    ...r.install_paths.map((c) => `copy: ${c.path} v${c.version || '?'} [${flags(c)}]`),
    `hooks: ${r.hooks.map((h) => `${h.host}/${h.scope}`).join(', ') || 'none'}`,
    `probes: ${r.probes.map((p) => `${p.launcher} ${p.ok === null ? 'n/a' : p.ok ? 'ok' : 'FAIL'}`).join(', ')}`,
    `state: ${s.dir}${s.tracked.length ? ' TRACKED' : !s.exists ? ' (none yet)' : s.ignored ? '' : ' (not ignored)'}`,
    `ADC_LIVE_TOKEN ${token}`,
    `budget: remaining ${s.budget.today.remaining} ${s.budget.unit}`,
    `prerequisites: ${counts.join(', ')}`,
    ...r.prerequisites.filter((p) => ['missing', 'old'].includes(p.status) && p.category !== 'host')
      .map((p) => `  ${p.status} ${p.name}${p.in_effect ? ` -> ${p.in_effect}` : ''}`),
    ...(r.vendored ? [`vendored: ${r.vendored.status}`, ...r.vendored.copies.map((c) => `  ${c.path}: ${c.status}`
      + `${list('changed', c.changed)}${list('missing', c.missing)}${list('extra', c.extra)}`)] : []),
    ...(r.init ? [`init: ${r.init.refused || `${r.init.dry_run ? 'would create' : 'ready'} ${r.init.dir}`}`] : []),
    ...r.warnings.map((w) => `warning: ${w}`),
  ].join('\n');
}

const USAGE = [
  'doctor [--init] [--verify-vendored [--against <dir|clone|url>] [--ref <tag|sha>]] [--no-probes] [--session <id>]',
  'Host, OS, Node, Git, host CLIs vs their floors, every prerequisite with the fallback in effect, installed copies,',
  'registered hooks, launcher probes, the state dir and the budget. --init creates .adc/, its exclude entry and the',
  'templates. --verify-vendored compares each copy under the repository with its release (SKILL.md semantically).',
  'Exit: 3 when .adc/ is tracked (the report is still printed), 1 on vendored drift, 4 when it cannot be compared.',
].join('\n');

function initState(ctx) {
  const root = repoRoot(ctx.cwd);
  const info = resolveStateDir({ cwd: ctx.cwd, stateDirOption: ctx.stateDirOption, root });
  const dir = toPosix(info.dir);
  const refused = `${info.rel}/ is tracked by git; run \`git rm -r --cached ${info.rel}\` first`;
  if (trackedStateFiles(info).length) return { dir, refused };
  const would = ['create the state dir (0700)', info.insideRepo && `add /${info.rel}/ to the exclude file`,
    'write budget.json and .env.live from the templates'];
  if (ctx.dryRun) return { dir, dry_run: true, would: would.filter(Boolean) };
  const prepared = prepareStateDir(ctx, { create: true, root });
  const t = materializeTemplates(prepared);
  return { dir, exclude: prepared.exclude, budget: t.budget, env_live: t.envLive };
}

export const doctorCommand = defineCommand({
  name: 'doctor',
  usage: USAGE,
  positionals: false,
  options: {
    init: { type: 'boolean' }, 'verify-vendored': { type: 'boolean' }, 'no-probes': { type: 'boolean' },
    against: { type: 'string' }, ref: { type: 'string' }, session: { type: 'string' }, probe: { type: 'string' },
    // Accepted for older invocations: doctor no longer asks host CLIs which skills they list.
    'no-discovery': { type: 'boolean' },
  },
  run: async (ctx, values) => {
    if (values.probe != null) {
      // Launcher probe target (§8.6): answers with fixed JSON and does nothing else.
      if (!NONCE_RE.test(values.probe)) throw usageError('--probe takes an alphanumeric nonce');
      const result = { adc_probe: values.probe, node: process.versions.node, exec: toPosix(process.execPath) };
      return { result, exit: EXIT.OK };
    }
    const vv = values['verify-vendored'];
    if ((values.against || values.ref) && !vv) throw usageError('--against and --ref are options of --verify-vendored');
    // The ref reaches `git fetch` as an argument, so nothing option-shaped gets through.
    if (values.ref && !REF_RE.test(values.ref)) throw usageError('--ref must be a tag, branch or commit name');
    const init = values.init ? initState(ctx) : null;
    const vendored = vv ? { against: values.against, ref: values.ref, cwd: ctx.cwd } : null;
    const report = await doctorReport({ cwd: ctx.cwd, stateDirOption: ctx.stateDirOption, session: values.session,
      probes: !values['no-probes'], vendored });
    if (init) {
      report.init = init;
      const e = init.env_live;
      if (e?.perms && !e.perms.ok) report.warnings.push('.env.live is not owner-only after chmod/icacls: use ADC_HOME');
      if (e && !e.created && e.reason) report.warnings.push(`.env.live not created: ${e.reason}`);
    }
    const v = report.vendored?.status;
    const exit = report.state.tracked.length ? EXIT.ENV : v === 'mismatch' ? EXIT.FINDINGS
      : ['unverified', 'none'].includes(v) ? EXIT.UNVERIFIABLE : EXIT.OK;
    const failing = report.prerequisites.filter((p) => p.category === 'required' && p.status === 'missing').length;
    const n = report.install_paths.length;
    const summary = [report.host_guess || 'no host', `node ${report.node.version}`, `git ${report.git.version || '-'}`,
      `${n} ${plural(n, 'copy', 'copies')}`, `${report.hooks.length} hook(s)`, `${report.warnings.length} warning(s)`,
      failing && `${failing} required item(s) missing`, exit === EXIT.ENV && 'state dir tracked (exit 3)'];
    return { result: report, exit, human: humanReport(report), summary: summary.filter(Boolean).join('; ') };
  },
});
