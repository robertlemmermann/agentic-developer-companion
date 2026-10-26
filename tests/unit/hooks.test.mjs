// Tests for the hooks: dialect detection and output shapes (hook-dialects.mjs), the handlers driven
// by the fixture files through `adc.mjs hook-run` (directly and through the rendered pwsh / sh /
// exec-form launchers), fail-open behavior with missing, crashing and too-old Node, rendering
// snapshots, and registration (merge, backup, record, list, remove) including the CLI.
import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import * as core from '../../skills/agentic-developer-companion/scripts/lib/core.mjs';
import * as state from '../../skills/agentic-developer-companion/scripts/lib/state.mjs';
import * as markers from '../../skills/agentic-developer-companion/scripts/lib/markers.mjs';
import * as dialects from '../../skills/agentic-developer-companion/scripts/lib/hook-dialects.mjs';
import * as hookRun from '../../skills/agentic-developer-companion/scripts/lib/hook-run.mjs';
import * as hooksRender from '../../skills/agentic-developer-companion/scripts/lib/hooks-render.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, '..', 'fixtures');
const SNAP = path.join(HERE, '..', 'snapshots');
const ADC = core.ADC_SCRIPT;
const SKILL = core.SKILL_DIR;
const PWSH = core.which('pwsh') || (fs.existsSync('/usr/local/bin/pwsh') ? '/usr/local/bin/pwsh' : null);
const SH = core.IS_WINDOWS ? null : core.which('sh');
const BASH = core.IS_WINDOWS ? null : core.which('bash');
const NODE_OLD = ['/opt/node22/bin/node', '/opt/node20/bin/node'].find((p) => fs.existsSync(p)) || null;
const AWS_KEY = ['AKIA', 'IOSFODNN7', 'EXAMPLE'].join('');
const TOKEN = ['hunter', '2abc', 'Zq9x'].join('');
const ENV_TOKEN = ['opaque', 'Env7', 'Value3'].join(''); // a second, environment-only value (leak matrix, plan §13)
const UPDATE = process.env.UPDATE_SNAPSHOTS === '1';
const POOL = Math.max(1, Math.min(4, os.availableParallelism ? os.availableParallelism() : os.cpus().length));
const cleanup = [];
after(() => { for (const d of cleanup) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });

const tmp = (prefix = 'adc-hooks-') => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); cleanup.push(d); return d; };
const HOME = tmp('adc-home-');

/** Process env without host or CI markers (the suite may itself run inside an agent session). */
function baseEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(CLAUDE|COPILOT|CODEX|GITHUB_COPILOT|ADC_|VSCODE_)/.test(k) || ['CI', 'GITHUB_ACTIONS', 'TERM_PROGRAM'].includes(k)) continue;
    env[k] = v;
  }
  env.HOME = HOME;
  env.USERPROFILE = HOME;
  return { ...env, ...extra };
}

const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: baseEnv() });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

let templateRepo = null;
function makeRepo() {
  if (!templateRepo) {
    templateRepo = tmp('adc-hooks-template-');
    git(templateRepo, 'init', '-q', '-b', 'main');
    git(templateRepo, 'config', 'user.email', 't@example.com');
    git(templateRepo, 'config', 'user.name', 'Test');
    git(templateRepo, 'config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(templateRepo, 'README.md'), '# fixture\n');
    git(templateRepo, 'add', '-A');
    git(templateRepo, 'commit', '-q', '-m', 'init');
  }
  const dir = tmp();
  fs.cpSync(templateRepo, dir, { recursive: true });
  const real = fs.realpathSync(dir);
  cleanup.push(core.tmpRoot(real)); // the tracked-state cache the hooks keep in the OS temp dir
  return real;
}

const get = (obj, dotted) => dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
const iso = (offsetS = 0) => new Date(Date.now() + offsetS * 1000).toISOString();

function substitute(value, vars) {
  if (typeof value === 'string') return Object.entries(vars).reduce((s, [k, v]) => s.split(k).join(v), value);
  if (Array.isArray(value)) return value.map((v) => substitute(v, vars));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, vars)]));
  return value;
}

function sessionIdOf(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (payload.sessionId != null) return String(payload.sessionId);
  if (payload.session_id != null) return String(payload.session_id);
  const t = payload.transcriptPath || payload.transcript_path;
  if (typeof t === 'string' && t) return `t-${core.sha256(t).slice(0, 16)}`;
  return 'unknown';
}

function applySetup(repo, setup = {}) {
  const adc = path.join(repo, '.adc');
  for (const [p, c] of Object.entries(setup.files || {})) {
    fs.mkdirSync(path.dirname(path.join(repo, p)), { recursive: true });
    fs.writeFileSync(path.join(repo, p), c);
  }
  if (setup.detect) { fs.mkdirSync(adc, { recursive: true }); fs.writeFileSync(path.join(adc, 'detect.json'), JSON.stringify(setup.detect)); }
  if (setup.ledger) {
    fs.mkdirSync(path.join(adc, 'evidence'), { recursive: true });
    const ts = iso(setup.ledger.offset_s || 0);
    fs.writeFileSync(path.join(adc, 'evidence', `${core.stamp()}-test.json`),
      JSON.stringify({ schema: 'adc-evidence/1', verdict: setup.ledger.verdict, created_at: ts, finalized_at: ts, checks: [] }));
  }
  if (setup.session) {
    const s = setup.session;
    const last = iso(s.last_offset_s || 0);
    fs.mkdirSync(path.join(adc, 'sessions'), { recursive: true });
    fs.writeFileSync(state.sessionFile(adc, s.id), JSON.stringify({
      schema: 'adc-session/1', session_id: s.id, started: iso(-3600), events: { 'post-edit': s.edits },
      edits: { count: s.edits, first: last, last, classes: {}, files: [], times: [last], findings: 0, state_dir_edits: 0 },
      observed_runs: [], gate: { notices: 0, last_notice_epoch: null, blocks: 0, last_block_epoch: null, consecutive: 0 },
      guard: { denials: 0, asks: 0, last: null }, ended: false,
    }));
  }
  if (setup.tracked_state) {
    fs.mkdirSync(adc, { recursive: true });
    fs.writeFileSync(path.join(adc, 'tracked.txt'), 'committed by mistake\n');
    git(repo, 'add', '-f', '.adc/tracked.txt');
    git(repo, 'commit', '-q', '-m', 'track state');
  }
}

function spawnAsync(cmd, args, { input = '', env, cwd, timeoutMs = 20_000, closeStdin = true } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(cmd, args, { env, cwd, windowsHide: true });
    const out = [];
    const err = [];
    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => err.push(c));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: null, stdout: '', stderr: String(e), ms: Date.now() - t0, bytes: Buffer.alloc(0) }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const bytes = Buffer.concat(out);
      resolve({ code, stdout: bytes.toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), ms: Date.now() - t0, bytes });
    });
    child.stdin.on('error', () => {});
    if (input) child.stdin.write(input);
    if (closeStdin) child.stdin.end();
  });
}

async function pool(items, fn, size = POOL) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) { const i = next++; results[i] = await fn(items[i], i); }
  }));
  return results;
}

/** Exactly one ASCII-only JSON object on stdout and exit 0; returns the parsed object. */
function assertHookOutput(res, label) {
  assert.equal(res.code, 0, `${label}: exit ${res.code}, stderr: ${res.stderr}`);
  assert.ok(/^[\x20-\x7e]+\r?\n$/.test(res.stdout), `${label}: stdout must be one ASCII line, got ${JSON.stringify(res.stdout).slice(0, 300)}`);
  const obj = JSON.parse(res.stdout);
  assert.ok(obj && typeof obj === 'object' && !Array.isArray(obj), `${label}: not an object`);
  return obj;
}

function checkExpect(obj, res, expect, label, repo, sid, vars) {
  if (expect.equals) assert.deepEqual(obj, expect.equals, `${label}: equals`);
  if (expect.keys) assert.deepEqual(Object.keys(obj).sort(), [...expect.keys].sort(), `${label}: keys`);
  for (const [p, v] of Object.entries(expect.values || {})) assert.deepEqual(get(obj, p), v, `${label}: ${p}`);
  for (const [p, re] of Object.entries(expect.match || {})) {
    assert.ok(new RegExp(re).test(String(get(obj, p))), `${label}: ${p} !~ /${re}/: ${JSON.stringify(get(obj, p))}`);
  }
  for (const p of expect.absent || []) assert.equal(get(obj, p), undefined, `${label}: ${p} must be absent`);
  for (const s of expect.not_contains || []) assert.ok(!res.stdout.includes(substitute(s, vars)), `${label}: output leaks ${s}`);
  if (expect.no_state) assert.ok(!fs.existsSync(path.join(repo, '.adc')), `${label}: .adc/ must not be created`);
  if (expect.session !== undefined && sid) {
    const file = state.sessionFile(path.join(repo, '.adc'), sid);
    if (expect.session === null) { assert.ok(!fs.existsSync(file), `${label}: no session file expected`); return; }
    const s = core.readJson(file, null);
    assert.ok(s, `${label}: session file missing (${file})`);
    for (const [p, v] of Object.entries(expect.session)) assert.deepEqual(get(s, p), v, `${label}: session ${p}`);
  }
}

function loadFixtures(name) {
  return JSON.parse(fs.readFileSync(path.join(FIX, 'hooks', `${name}.json`), 'utf8'));
}

// Launchers: how a host would start the handler for a step.
const rendered = new Map();
function renderedFor(host, level, scope = 'user') {
  const key = `${host}:${level}:${scope}`;
  if (!rendered.has(key)) rendered.set(key, hooksRender.renderHooks({ host, scope, level, skillDir: SKILL, root: scope === 'project' ? makeRepo() : null, home: HOME, env: baseEnv() }));
  return rendered.get(key);
}
function handlerFor(host, level, event, scope = 'user') {
  const cfg = renderedFor(host, level === 'guard' || event === 'pre-guard' ? 'guard' : level, scope).config;
  for (const list of Object.values(cfg.hooks)) {
    for (const item of list) {
      const hs = Array.isArray(item.hooks) ? item.hooks : [item];
      for (const h of hs) {
        const s = [h.bash, h.command, ...(h.args || [])].filter(Boolean).join(' ');
        if (new RegExp(`hook-run ${event} `).test(s)) return h;
      }
    }
  }
  throw new Error(`no ${event} handler rendered for ${host}`);
}

async function runStep(mode, step, { env, cwd, input }) {
  const level = step.level || 'advise';
  if (mode === 'direct') {
    const args = [ADC, 'hook-run', step.event, '--dialect', step.dialect_arg];
    if (step.level) args.push('--level', step.level);
    return spawnAsync(process.execPath, args, { input, env, cwd });
  }
  const h = (() => {
    if (mode.startsWith('copilot-')) return handlerFor('copilot', level, step.event);
    if (mode.startsWith('codex-')) return handlerFor('codex', level, step.event);
    if (mode === 'claude-exec') return handlerFor('claude', level, step.event);
    return handlerFor('claude', level, step.event, 'project');
  })();
  if (mode === 'copilot-pwsh') return spawnAsync(PWSH, ['-NoProfile', '-Command', h.powershell], { input, env, cwd });
  if (mode === 'copilot-bash') return spawnAsync(BASH, ['-c', h.bash], { input, env, cwd });
  if (mode === 'codex-sh') return spawnAsync(SH, ['-c', h.command], { input, env, cwd });
  if (mode === 'codex-pwsh') return spawnAsync(PWSH, ['-NoProfile', '-Command', h.commandWindows], { input, env, cwd });
  if (mode === 'claude-exec') return spawnAsync(h.command, h.args, { input, env, cwd });
  if (mode === 'claude-shell-sh') return spawnAsync(SH, ['-c', h.command], { input, env, cwd });
  if (mode === 'claude-shell-pwsh') return spawnAsync(PWSH, ['-NoProfile', '-Command', h.command], { input, env, cwd });
  throw new Error(`unknown mode ${mode}`);
}

/** Run one fixture case (and its `then` steps) in a fresh repository through one launcher. */
async function runCase(c, mode) {
  const noGit = c.setup && c.setup.no_git;
  const repo = noGit ? fs.realpathSync(tmp('adc-nogit-')) : makeRepo();
  const outside = fs.realpathSync(tmp('adc-outside-'));
  const vars = { '<REPO>': core.toPosix(repo), '<AWS_KEY>': AWS_KEY, '<TOKEN>': TOKEN };
  if (!noGit) applySetup(repo, c.setup || {});
  const steps = [c, ...(c.then || [])];
  for (let i = 0; i < steps.length; i++) {
    const step = { dialect_arg: c.dialect_arg, level: c.level, env: c.env, spawn_cwd: c.spawn_cwd, ...steps[i] };
    if (i > 0 && step.setup) applySetup(repo, step.setup);
    const payload = substitute(step.payload, vars);
    const input = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const env = baseEnv(substitute(step.env || {}, vars));
    const cwd = step.spawn_cwd === 'outside' ? outside : repo;
    const label = `${c.name} [step ${i + 1}: ${step.event}, ${mode}]`;
    const res = await runStep(mode, step, { env, cwd, input });
    const obj = assertHookOutput(res, label);
    assert.ok(res.ms < (mode === 'direct' ? 2000 : 6000), `${label}: took ${res.ms} ms`);
    checkExpect(obj, res, step.expect || {}, label, repo, sessionIdOf(payload), vars);
  }
}

// ---------------------------------------------------------------------------
// Dialects (in-process)

test('detectDialect: COPILOT_CLI wins, then --dialect, then the payload shape', () => {
  const d = dialects.detectDialect;
  assert.equal(d({ session_id: 'x', hook_event_name: 'Stop' }, { explicit: 'claude', env: { COPILOT_CLI: '1' } }), 'copilot');
  assert.equal(d({ session_id: 'x' }, { explicit: 'codex', env: {} }), 'codex');
  assert.equal(d({ sessionId: 'x', toolName: 'bash' }, { env: {} }), 'copilot');
  assert.equal(d({ hook_event_name: 'PostToolUse', tool_result: { result_type: 'success' } }, { env: {} }), 'copilot');
  assert.equal(d({ hook_event_name: 'SessionStart', timestamp: '2026-10-25T10:00:00Z' }, { env: {} }), 'copilot');
  assert.equal(d({ hook_event_name: 'PreToolUse', turn_id: 't', tool_name: 'Bash' }, { env: {} }), 'codex');
  assert.equal(d({ hook_event_name: 'PostToolUse', tool_name: 'apply_patch' }, { env: {} }), 'codex');
  assert.equal(d({ hook_event_name: 'SessionStart', model: 'gpt-5', permission_mode: 'default' }, { env: {} }), 'codex');
  assert.equal(d({ hook_event_name: 'SessionStart', prompt_id: 'p', permission_mode: 'default', model: 'opus' }, { env: {} }), 'claude');
  assert.equal(d({ hook_event_name: 'Stop', stop_hook_active: false }, { env: {} }), 'claude');
  assert.equal(d(null, { explicit: 'auto', env: {} }), 'claude');
});

test('normalizePayload: camelCase, string toolArgs, epoch timestamps, transcript-derived ids, result text and exit codes', () => {
  const n = dialects.normalizePayload({ sessionId: 7, timestamp: 1761400000000, cwd: '/r', toolName: 'edit', toolArgs: '{"path":"a.js","new_str":"x"}', toolResult: { resultType: 'success', textResultForLlm: 'ok' } }, 'copilot', 'post-edit');
  assert.equal(n.session_id, '7');
  assert.equal(n.timestamp, new Date(1761400000000).toISOString());
  assert.deepEqual(n.tool_input, { path: 'a.js', new_str: 'x' });
  assert.equal(n.tool_kind, 'edit');
  assert.equal(n.tool_result_text, 'ok');
  assert.equal(n.tool_result_type, 'success');
  const c = dialects.normalizePayload({ transcript_path: '/t/abc.jsonl', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'go test ./...' }, tool_response: { stdout: 'ok  pkg 0.1s', stderr: 'warn', exit_code: 1 } }, 'claude', 'post-shell');
  assert.equal(c.session_id, `t-${core.sha256('/t/abc.jsonl').slice(0, 16)}`);
  assert.equal(c.tool_kind, 'shell');
  assert.equal(c.exit_code, 1);
  assert.match(c.tool_result_text, /ok {2}pkg[\s\S]*warn/);
  assert.equal(dialects.normalizePayload({}, 'claude', 'stop').session_id, 'unknown');
  assert.equal(dialects.toolKind('str_replace_editor', { command: 'view' }), 'read');
  assert.equal(dialects.toolKind('str_replace_editor', { command: 'create' }), 'edit');
  assert.equal(dialects.toolKind('NotebookEdit'), 'edit');
  assert.equal(dialects.toolKind('PowerShell'), 'shell');
  assert.equal(dialects.toolKind('Glob'), 'read');
  assert.equal(dialects.shellCommand({ command: ['bash', '-lc', 'npm test'] }), 'npm test');
  assert.equal(dialects.shellCommand('{"command":"ls"}'), 'ls');
});

test('extractPaths and parsePatch cover every dialect, apply_patch headers and odd input', () => {
  const p = (tool_name, tool_input) => dialects.extractPaths({ tool_name, tool_input });
  assert.deepEqual(p('Write', { file_path: 'C:\\repo\\src\\a.ts', content: 'x' }), ['C:/repo/src/a.ts']);
  assert.deepEqual(p('NotebookEdit', { notebook_path: 'nb.ipynb', new_source: 'x' }), ['nb.ipynb']);
  assert.deepEqual(p('edit', { filePath: 'a.js' }), ['a.js']);
  assert.deepEqual(p('custom', { options: { target_file: 'deep/x.py' } }), ['deep/x.py']);
  assert.deepEqual(p('edit', { files: ['a', 'b'] }), ['a', 'b']);
  assert.deepEqual(p('edit', { path: 'multi\nline' }), []);
  const body = ['*** Begin Patch', '*** Add File: tests/a.test.js', '+it.only(1)', '*** Update File: src/old.js', '*** Move to: src/new.js', '@@ -3,2 +3,3 @@', ' keep', '-gone', '+added', '*** Delete File: tests/b.test.js', '*** End Patch'].join('\r\n');
  assert.deepEqual(p('apply_patch', { command: body }), ['tests/a.test.js', 'src/old.js', 'src/new.js', 'tests/b.test.js']);
  const files = dialects.parsePatch(body);
  assert.deepEqual(files.map((f) => f.op), ['add', 'update', 'delete']);
  assert.deepEqual(files[0].added, [{ line: 1, text: 'it.only(1)' }]);
  assert.deepEqual(files[1].added, [{ line: 4, text: 'added' }]);
  assert.equal(files[1].moveTo, 'src/new.js');
  const content = dialects.extractContent({ tool_name: 'MultiEdit', tool_input: { file_path: 'a.js', edits: [{ new_string: 'one' }, { new_string: 'two' }] } });
  assert.deepEqual(content, [{ path: 'a.js', op: 'update', text: 'one\ntwo', fragment: true }]);
  assert.deepEqual(dialects.extractContent({ tool_name: 'Write', tool_input: { file_path: 'b.js', content: 'x' } }), [{ path: 'b.js', op: 'write', text: 'x' }]);
  assert.deepEqual(dialects.extractPatterns({ tool_input: { pattern: '.adc/**', path: '.' } }), ['.adc/**']);
});

test('formatOutput: the decision shapes per host, and Codex output uses only documented keys', () => {
  const f = dialects.formatOutput;
  assert.deepEqual(f('copilot', 'post-edit', { context: 'c' }), { additionalContext: 'c' });
  assert.deepEqual(f('copilot', 'stop', { block: 'r' }), { decision: 'block', reason: 'r' });
  assert.deepEqual(f('copilot', 'pre-guard', { deny: 'r' }), { permissionDecision: 'deny', permissionDecisionReason: 'r' });
  assert.deepEqual(f('copilot', 'pre-guard', { ask: 'r' }), { permissionDecision: 'ask', permissionDecisionReason: 'r' });
  assert.deepEqual(f('copilot', 'post-shell', { modifiedResult: { text: 't' }, context: 'c' }), { modifiedResult: { resultType: 'success', textResultForLlm: 't' }, additionalContext: 'c' });
  assert.deepEqual(f('claude', 'post-shell', { modifiedResult: { text: 't' } }), {});
  assert.deepEqual(f('claude', 'session-start', { context: 'c' }), { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'c' } });
  assert.deepEqual(f('claude', 'stop', { context: 'c' }), { hookSpecificOutput: { hookEventName: 'Stop', additionalContext: 'c' } });
  assert.deepEqual(f('claude', 'pre-guard', { deny: 'r' }), { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'r' } });
  assert.deepEqual(f('codex', 'stop', { context: 'c' }), { systemMessage: 'c' });
  assert.deepEqual(f('codex', 'stop', { block: 'r' }), { decision: 'block', reason: 'r' });
  for (const d of ['copilot', 'claude', 'codex']) {
    assert.deepEqual(f(d, 'session-end', { context: 'c' }), {});
    assert.deepEqual(f(d, 'post-edit', {}), {});
    assert.equal(JSON.stringify(f(d, 'post-edit', { context: 'x'.repeat(5000) })).length < 2200, true);
  }
  const allowedTop = new Set(['continue', 'stopReason', 'suppressOutput', 'systemMessage', 'decision', 'reason', 'hookSpecificOutput']);
  const allowedSpecific = new Set(['hookEventName', 'permissionDecision', 'permissionDecisionReason', 'updatedInput', 'additionalContext', 'updatedMCPToolOutput']);
  for (const ev of dialects.HOOK_EVENTS) {
    for (const dec of [{ context: 'c' }, { block: 'b' }, { deny: 'd' }, { ask: 'a' }, { modifiedResult: { text: 't' } }]) {
      const out = f('codex', ev, dec);
      for (const k of Object.keys(out)) assert.ok(allowedTop.has(k), `codex ${ev}: ${k}`);
      for (const k of Object.keys(out.hookSpecificOutput || {})) assert.ok(allowedSpecific.has(k), `codex ${ev}: hookSpecificOutput.${k}`);
      if (ev === 'stop' && dec.context) assert.equal(out.hookSpecificOutput, undefined);
    }
  }
});

test('observed-run classes, narrowed runs and a redacted command head', () => {
  const r = (cmd) => hookRun.classifyRun(cmd);
  assert.equal(r('npm test').class, 'test');
  assert.equal(r('CI=1 pnpm run test:unit').class, 'test');
  assert.equal(r('npx vitest run').class, 'test');
  assert.equal(r('python -m pytest -q').class, 'test');
  assert.equal(r('./gradlew test').class, 'test');
  assert.equal(r('node --test tests/unit').class, 'test');
  assert.equal(r('npx tsc --noEmit').class, 'typecheck');
  assert.equal(r('ruff check .').class, 'lint');
  assert.equal(r('go build ./...').class, 'build');
  assert.equal(r('node "/x/scripts/adc.mjs" verify --json').class, 'companion');
  assert.equal(r('ls -la'), null);
  assert.equal(r('pytest -k test_login').narrowed, true);
  assert.equal(r('go test -run TestX ./...').narrowed, true);
  assert.equal(r('npm test').narrowed, false);
  assert.equal(r(`API_KEY=${TOKEN} npm test`).head, 'npm test');
  assert.equal(hookRun.classifyRun(`npm test -- ${AWS_KEY}`, (t) => t.includes(AWS_KEY)).head, 'npm test -- [REDACTED]');
  assert.equal(r(`npx jest --api-token=${TOKEN} -t x`).head, 'npx jest --api-token=[REDACTED] -t x');
  assert.equal(r(`pytest --password ${TOKEN} -q`).head, 'pytest --password [REDACTED] -q');
  assert.equal(r('bash -ec "npm test"').class, 'test', 'an inline script behind a flag cluster');
  assert.equal(r('2>/dev/null npm test').head, 'npm test', 'a leading redirection is not the executable');
});

test('scanEdit uses markers.mjs scanText: languages, comment masking, multi-line constructs and patch line maps', () => {
  const multiCatch = 'try {\n  run();\n} catch (e) {\n  log(e);\n}\n';
  assert.deepEqual(hookRun.scanEdit(multiCatch, markers.SWALLOW_PATTERNS, 'src/a.js'), [], 'a catch block with a body is not swallowing');
  assert.deepEqual(hookRun.scanEdit('try { run(); } catch (e) {\n}\n', markers.SWALLOW_PATTERNS, 'src/a.js').map((h) => [h.id, h.line]), [['swallow.empty-catch', 1]]);
  assert.deepEqual(hookRun.scanEdit('const a = 1; // # noqa\n', markers.SUPPRESSIONS, 'src/a.js'), [], 'a Python directive in a JS file');
  assert.equal(hookRun.scanEdit('x = 1  # noqa\n', markers.SUPPRESSIONS, 'src/a.py')[0].id, 'suppress.py-noqa');
  assert.deepEqual(hookRun.scanEdit("// it.only was here\nit('x', () => {});\n", markers.SKIP_MARKERS, 'tests/a.test.js'), [], 'commented-out focus');
  // Patch hunks map scanned lines to file lines; a hunk without line numbers maps to null, never to a guess.
  assert.deepEqual(hookRun.scanEdit("x\nit.only('x', () => {});\n", markers.SKIP_MARKERS, 'tests/a.test.js', [10, 12]).map((h) => h.line), [12]);
  assert.deepEqual(hookRun.scanEdit("a\nit.only('x', () => {});\n", markers.SKIP_MARKERS, 'tests/a.test.js', [7, null]).map((h) => h.line), [null]);
  assert.deepEqual(hookRun.scanEdit('', markers.SKIP_MARKERS, 'tests/a.test.js'), []);
});

test('exitFromText reads the exit code the hosts print into results (Copilot trailer, Codex header)', () => {
  assert.equal(dialects.exitFromText('# pass 1\n<shellId: 0 completed with exit code 1>'), 1);
  assert.equal(dialects.exitFromText('ok\n<shellId: my-shell completed with exit code 0>\n'), 0);
  assert.equal(dialects.exitFromText('Exit code: 2\nWall time: 0.1 seconds\nOutput:\nfailed'), 2);
  assert.equal(dialects.exitFromText('the docs say Exit code: 2 somewhere'), null);
  assert.equal(dialects.exitFromText(''), null);
  assert.equal(dialects.exitFromText(null), null);
  const n = dialects.normalizePayload({ sessionId: 's', toolName: 'bash', toolArgs: { command: 'npm test' }, toolResult: { resultType: 'success', textResultForLlm: 'x\n<shellId: 3 completed with exit code 7>' } }, 'copilot', 'post-shell');
  assert.deepEqual([n.exit_code, n.exit_source], [7, 'result-text']);
  const p = dialects.normalizePayload({ session_id: 's', tool_name: 'Bash', tool_response: { stdout: '<shellId: 3 completed with exit code 7>', exit_code: 3 } }, 'claude', 'post-shell');
  assert.deepEqual([p.exit_code, p.exit_source], [3, 'payload']);
});

test('extractPaths reads Copilot grep/rg/glob `paths` as a string or an array; parsePatch marks unnumbered hunks', () => {
  assert.deepEqual(dialects.extractPaths({ tool_name: 'grep', tool_input: { pattern: 'x', paths: '/r/.adc' } }), ['/r/.adc']);
  assert.deepEqual(dialects.extractPaths({ tool_name: 'rg', tool_input: { pattern: 'x', paths: ['/r/.adc', '/r/src'] } }), ['/r/.adc', '/r/src']);
  const files = dialects.parsePatch(['*** Begin Patch', '*** Update File: src/a.js', '@@ function x', '-a', '+b', '*** Add File: t/a.test.js', '+one', '+two', '*** End Patch'].join('\n'));
  assert.deepEqual(files[0].added, [{ line: null, text: 'b' }]);
  assert.deepEqual(files[1].added, [{ line: 1, text: 'one' }, { line: 2, text: 'two' }]);
});

test('lastAssistantMessage reads the tail of Copilot and Claude transcripts (bounded, partial lines skipped)', () => {
  const dir = tmp('adc-transcript-');
  const copilotFile = path.join(dir, 'events.jsonl');
  const filler = JSON.stringify({ type: 'tool.execution_complete', data: { result: 'x'.repeat(5000) } });
  fs.writeFileSync(copilotFile, [
    JSON.stringify({ type: 'assistant.message', data: { content: 'Earlier: tests are green' } }),
    ...Array.from({ length: 80 }, () => filler),
    JSON.stringify({ type: 'assistant.message', data: { content: 'All tests pass now.', toolRequests: [] } }),
    JSON.stringify({ type: 'assistant.message', data: { content: '', toolRequests: [{ name: 'bash' }] } }),
    JSON.stringify({ type: 'assistant.turn_end', data: {} }),
  ].join('\n') + '\n');
  assert.equal(hookRun.lastAssistantMessage(copilotFile), 'All tests pass now.');
  assert.equal(hookRun.lastAssistantMessage(copilotFile, { maxBytes: 64 }), null, 'only the bounded tail is read');
  const claudeFile = path.join(dir, 'claude.jsonl');
  fs.writeFileSync(claudeFile, `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Everything works.' }] } })}\n${JSON.stringify({ type: 'user', message: { content: 'x' } })}\n`);
  assert.equal(hookRun.lastAssistantMessage(claudeFile), 'Everything works.');
  assert.equal(hookRun.lastAssistantMessage(path.join(dir, 'missing.jsonl')), null);
  assert.equal(hookRun.lastAssistantMessage(null), null);
});

test('newestLedger picks the newest created_at among recently written ledgers and skips foreign JSON', () => {
  const dir = tmp('adc-evidence-');
  const write = (name, doc, mtimeS) => {
    const f = path.join(dir, name);
    fs.writeFileSync(f, JSON.stringify(doc));
    const t = new Date(Date.now() + mtimeS * 1000);
    fs.utimesSync(f, t, t);
  };
  write('a.json', { schema: 'adc-evidence/1', verdict: 'PASS', created_at: iso(-60) }, 0); // older ledger, touched last
  write('b.json', { schema: 'adc-evidence/1', verdict: 'FAIL', created_at: iso(-10) }, -5);
  write('c.json', { schema: 'adc-trace/1', created_at: iso(0) }, 2);
  write('d.md', { x: 1 }, 3);
  const led = hookRun.newestLedger(dir);
  assert.equal(led.file, 'b.json');
  assert.equal(led.verdict, 'FAIL');
  assert.equal(hookRun.newestLedger(path.join(dir, 'missing')), null);
});

test('locateRepo resolves linked worktrees, and the hook exclude entry lands in the common git dir', () => {
  const repo = makeRepo();
  const wt = path.join(tmp('adc-wt-'), 'wt');
  git(repo, 'worktree', 'add', '-q', wt, 'HEAD');
  const found = state.locateRepo(path.join(wt));
  assert.equal(found.root, fs.realpathSync(wt));
  assert.equal(fs.realpathSync(found.commonDir), fs.realpathSync(path.join(repo, '.git')));
  const info = hookRun.hookStateInfo(found, { env: {} });
  assert.equal(hookRun.ensureHookState(info, found), true);
  fs.writeFileSync(path.join(wt, '.adc', 'probe'), 'x');
  assert.equal(spawnSync('git', ['check-ignore', '-q', '.adc/probe'], { cwd: wt }).status, 0);
  assert.equal(state.locateRepo(path.join(wt, 'missing', 'dir')), null);
  assert.equal(state.locateRepo(path.join(repo, 'README.md')).root, repo);
});

test('readStdin gives up on a stream that never ends; decodeStdin handles BOMs and UTF-16', async () => {
  const never = new Readable({ read() {} });
  const t0 = Date.now();
  const buf = await hookRun.readStdin({ stream: never, timeoutMs: 100 });
  assert.equal(buf.length, 0);
  assert.ok(Date.now() - t0 < 1000);
  assert.equal((await hookRun.readStdin({ stream: { isTTY: true } })).length, 0);
  assert.equal(await hookRun.readStdin({ stream: Readable.from([Buffer.alloc(10)]), maxBytes: 5 }), null);
  assert.equal(hookRun.decodeStdin(Buffer.from('\ufeff{"a":1}', 'utf8')), '{"a":1}');
  assert.equal(hookRun.decodeStdin(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('{"é":1}', 'utf16le')])), '{"é":1}');
  assert.equal(hookRun.parsePayload('{}'), null);
  assert.equal(hookRun.parsePayload('{"cwd":"/x"}').cwd, '/x');
});

test('hookRunCommand in-process: an injected stream yields the same decision', async () => {
  const repo = makeRepo();
  const payload = JSON.stringify({ session_id: 'in-1', cwd: repo, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git reset --hard' } });
  const out = await hookRun.hookRunCommand(['pre-guard', '--dialect', 'claude', '--level', 'guard'], { stdin: Readable.from([Buffer.from(payload)]), env: baseEnv() });
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.deepEqual(await hookRun.hookRunCommand(['nope'], { stdin: Readable.from([]), env: baseEnv() }), {});
});

/** One in-process hook call with a JSON payload; returns the decision object. */
const inproc = (argv, payload, env = {}) =>
  hookRun.hookRunCommand(argv, { stdin: Readable.from([Buffer.from(JSON.stringify(payload))]), env: baseEnv(env) });
const claudeBash = (repo, command, extra = {}) => ({ session_id: 'g', cwd: repo, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, ...extra });
const decisionOf = (out) => (out.hookSpecificOutput ? out.hookSpecificOutput.permissionDecision : out.permissionDecision) || null;

test('post-edit scans code files only, and flags a manifest test script or runner config that cannot fail', async () => {
  const repo = makeRepo();
  const edit = (file, content, tool = 'Write') => inproc(['post-edit', '--dialect', 'claude'],
    { session_id: 'pe', cwd: repo, hook_event_name: 'PostToolUse', tool_name: tool, tool_input: tool === 'Write' ? { file_path: `${repo}/${file}`, content } : { file_path: `${repo}/${file}`, old_string: 'x', new_string: content }, tool_response: {} });
  // Prose and data that quote markers are not suppressions, swallowed errors or skipped tests.
  assert.deepEqual(await edit('README.md', 'Never add `// eslint-disable-next-line`; `try { x() } catch {}` hides errors; no it.only(\n'), {});
  assert.deepEqual(await edit('tests/fixtures/sample.json', '{"code": "it.only(\'x\', () => {}) // @ts-ignore"}\n'), {});
  const code = await edit('src/a.js', '// eslint-disable-next-line\ntry { x() } catch {}\n');
  assert.match(code.hookSpecificOutput.additionalContext, /src\/a\.js: adds a lint\/type suppression \(\S+\) at line 1; adds an exception-swallowing pattern \(\S+\) at line 2/);
  const pkg = await edit('package.json', '"test": "jest --passWithNoTests",\n"postinstall": "husky || true"', 'Edit');
  assert.match(pkg.hookSpecificOutput.additionalContext, /package\.json \([^)]*manifest[^)]*\): weakens a test command \(\S*pass-with-no-tests\) in an added line/);
  assert.doesNotMatch(pkg.hookSpecificOutput.additionalContext, /husky/, 'a non-test script with || true is not a test weakening');
  const cfg = await edit('pytest.ini', '[pytest]\naddopts = -q || true\n');
  assert.match(cfg.hookSpecificOutput.additionalContext, /pytest\.ini \(runner config\): weakens a test command \(\S*or-true\) at line 2/);
  const sessionFile = state.sessionFile(path.join(repo, '.adc'), 'pe');
  const before = core.readJson(sessionFile).edits.count;
  // The host's own plan or memory files and temp files are outside the change: no note, no gate epoch.
  const outside = fs.realpathSync(tmp('adc-outside-'));
  const planFile = { session_id: 'pe', cwd: repo, hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: `${outside}/plans/x.test.js`, content: "it.only('x', () => {})\n" }, tool_response: {} };
  assert.deepEqual(await inproc(['post-edit', '--dialect', 'claude'], planFile), {});
  assert.equal(core.readJson(sessionFile).edits.count, before);
});

test('guard: `git add -f` of a pathspec, glob or -A that covers .adc/ is denied once .adc/ exists', async () => {
  const repo = makeRepo();
  const guard = async (command, cwd = repo) => decisionOf(await inproc(['pre-guard', '--dialect', 'claude', '--level', 'guard'], claudeBash(cwd, command)));
  assert.equal(await guard('git add -f .'), null, 'nothing to pick up before .adc/ exists');
  fs.mkdirSync(path.join(repo, '.adc'));
  fs.mkdirSync(path.join(repo, 'sub'));
  for (const c of ['git add -f .', 'git add -fA', 'git add --force --all', 'git add -f -- :/', 'git add -f "*.json"', 'git add --force .adc/budget.json', 'git -C . add -f .']) {
    assert.equal(await guard(c), 'deny', c);
  }
  assert.equal(await guard('git add -f ..', path.join(repo, 'sub')), 'deny', 'a parent of the state dir, from a subdirectory');
  for (const c of ['git add -f build/out.js', 'git add -f src', 'git add -A', 'git add .', 'git -C sub add -f .']) assert.equal(await guard(c), null, c);
  assert.equal(await guard('git add -f .', path.join(repo, 'sub')), null, '. in a subdirectory does not contain .adc/');
});

test('guard: shell access to .env.live by glob, other letter case or a recursive read of .adc/ is denied; untracking stays allowed', async () => {
  const repo = makeRepo();
  const guard = async (command) => decisionOf(await inproc(['pre-guard', '--dialect', 'claude', '--level', 'guard'], claudeBash(repo, command)));
  for (const c of ['cat .adc/.e*', 'cat ./.adc/*', 'cat .ADC/.ENV.LIVE', 'type .adc\\.env.live', 'grep -r TOKEN .adc', 'rg --hidden TOKEN ./.adc/',
    'cp -r .adc /tmp/backup', 'tar czf s.tgz .adc', 'find .adc -type f -exec cat {} +', 'Select-String -Path .adc/* -Pattern TOKEN', 'cat .env.live']) {
    assert.equal(await guard(c), 'deny', c);
  }
  for (const c of ['cat .adc/budget.json', 'cat .adc/*.json', 'ls -la .adc', 'find .adc -name "*.json"', 'grep -r TOKEN .adc/evidence',
    'git rm -r --cached .adc', 'git rm --cached .adc/.env.live', 'git check-ignore -q .adc/.env.live', 'node scripts/adc.mjs doctor --state-dir .adc']) {
    assert.equal(await guard(c), null, c);
  }
});

test('guard: Windows backslash paths, inline scripts behind flag clusters and leading redirections are seen through', async () => {
  const repo = makeRepo();
  const guard = async (command) => inproc(['pre-guard', '--dialect', 'claude', '--level', 'guard'], claudeBash(repo, command));
  for (const c of ['Get-Content .adc\\*', 'Select-String -Path .adc\\* -Pattern TOKEN', `type ${repo.replace(/\//g, '\\')}\\.adc\\.env.live`,
    '>/dev/null git push --force', '2>&1 git reset --hard', 'bash -ec "git push -f"', 'pwsh -NoProfile -Command "git push --force"']) {
    assert.equal(decisionOf(await guard(c)), 'deny', c);
  }
  const del = await guard('Remove-Item tests\\unit\\a.test.js');
  assert.equal(decisionOf(del), 'ask');
  assert.match(del.hookSpecificOutput.permissionDecisionReason, /tests\/unit\/a\.test\.js/);
  for (const c of ['Get-Content .adc\\budget.json', 'echo "a\\"b" > out.txt', 'Remove-Item build\\out.js']) assert.equal(decisionOf(await guard(c)), null, c);
});

test('guard: a call that starts two Claude handlers (two matching `if` rules) is counted once', async () => {
  const repo = makeRepo();
  const p = claudeBash(repo, 'cat .adc/.env.live', { session_id: 'dup', tool_use_id: 'toolu_dup1' });
  // The session lock serializes the two handler processes; in-process the calls run one after the other.
  for (let i = 0; i < 2; i++) assert.equal(decisionOf(await inproc(['pre-guard', '--dialect', 'claude', '--level', 'guard'], p)), 'deny');
  await inproc(['pre-guard', '--dialect', 'claude', '--level', 'guard'], { ...p, tool_use_id: 'toolu_dup2' });
  assert.equal(core.readJson(state.sessionFile(path.join(repo, '.adc'), 'dup')).guard.denials, 2);
});

test('Copilot post-shell redacts the live token in every printed form, including the literal value of an exported ADC_LIVE_TOKEN', async () => {
  const repo = makeRepo();
  const shell = (text, env) => inproc(['post-shell', '--dialect', 'copilot'],
    { sessionId: 'rs', timestamp: 1761400000000, cwd: repo, toolName: 'bash', toolArgs: { command: 'echo $ADC_LIVE_TOKEN' }, toolResult: { resultType: 'success', textResultForLlm: text } }, env);
  const out = await shell(`${ENV_TOKEN}\n<shellId: 1 completed with exit code 0>`, { ADC_LIVE_TOKEN: ENV_TOKEN });
  assert.equal(out.modifiedResult.textResultForLlm, '[REDACTED:ADC_LIVE_TOKEN]\n<shellId: 1 completed with exit code 0>');
  assert.ok(!JSON.stringify(out).includes(ENV_TOKEN));
  assert.deepEqual(await shell('plain output\n', { ADC_LIVE_TOKEN: ENV_TOKEN }), {}, 'nothing to redact, no decision');
});

// ---------------------------------------------------------------------------
// Fixture cases through adc.mjs hook-run

const FIXTURE_FILES = ['copilot-camel', 'copilot-pascal', 'copilot-cloud', 'claude', 'codex'];
const NO_GIT_ROOT = state.locateRepo(os.tmpdir()) == null;

for (const file of FIXTURE_FILES) {
  // Cases are independent (one fresh repository each), so a file's cases run concurrently.
  describe(`fixtures ${file}.json through adc.mjs hook-run`, { concurrency: POOL }, () => {
    for (const c of loadFixtures(file)) {
      const skip = c.setup && c.setup.no_git && !NO_GIT_ROOT ? 'the OS temp dir is inside a git work tree' : false;
      test(c.name, { skip }, () => runCase(c, 'direct'));
    }
  });
}

/** Every case of a fixture file through a host launcher, in parallel; failures are reported together. */
async function viaLauncher(file, mode, filter = () => true) {
  const known = (c) => [c, ...(c.then || [])].every((s) => dialects.HOOK_EVENTS.includes(s.event));
  const cases = loadFixtures(file).filter((c) => !(c.setup && c.setup.no_git)).filter(known).filter(filter);
  const errors = [];
  await pool(cases, async (c) => { try { await runCase(c, mode); } catch (err) { errors.push(`${c.name}: ${err.message}`); } });
  assert.deepEqual(errors, [], errors.join('\n\n'));
  return cases.length;
}

/** The first case per event: the rendered command is the same string for every case of an event. */
function onePerEvent(pred) {
  const seen = new Set();
  return (c) => {
    if (!pred(c) || seen.has(c.event)) return false;
    seen.add(c.event);
    return true;
  };
}

const copilotOnly = (c) => [c, ...(c.then || [])].every((s) => (s.dialect_arg || c.dialect_arg) === 'copilot');
const claudeOnly = (c) => [c, ...(c.then || [])].every((s) => (s.dialect_arg || c.dialect_arg) === 'claude');
const codexOnly = (c) => [c, ...(c.then || [])].every((s) => (s.dialect_arg || c.dialect_arg) === 'codex');

test('fixtures through the rendered Copilot powershell strings (pwsh -NoProfile -Command)', { skip: PWSH ? false : 'pwsh not installed', timeout: 240_000 }, async () => {
  // Every case already ran through the bash string. Under pwsh (about 0.4 s of CPU per start, the
  // file's largest cost) every preToolUse case runs, because Copilot treats a failing preToolUse
  // hook as a denial, plus the first case of each other event.
  let n = 0;
  for (const f of ['copilot-camel', 'copilot-pascal', 'copilot-cloud']) {
    const first = onePerEvent(copilotOnly);
    n += await viaLauncher(f, 'copilot-pwsh', (c) => (c.event === 'pre-guard' ? copilotOnly(c) : first(c)));
  }
  assert.ok(n > 30);
});

test('fixtures through the rendered Copilot bash strings (bash -c)', { skip: BASH ? false : 'bash not available', timeout: 120_000 }, async () => {
  for (const f of ['copilot-camel', 'copilot-pascal', 'copilot-cloud']) await viaLauncher(f, 'copilot-bash', copilotOnly);
});

test('fixtures through the rendered Codex command (sh -c) and commandWindows (pwsh -Command)', { timeout: 180_000 }, async (t) => {
  if (SH) await viaLauncher('codex', 'codex-sh', codexOnly);
  // Every case already ran through sh; under pwsh one case per event proves the same strings parse and run.
  if (PWSH) await viaLauncher('codex', 'codex-pwsh', onePerEvent(codexOnly));
  if (!SH && !PWSH) t.skip('no sh or pwsh');
});

test('fixtures through the rendered Claude user-scope exec form (command + args, no shell)', { timeout: 120_000 }, async () => {
  await viaLauncher('claude', 'claude-exec', claudeOnly);
});

test('fixtures through the Claude project-scope shell form (--dialect auto) under sh and pwsh', { timeout: 180_000 }, async (t) => {
  if (SH) await viaLauncher('claude', 'claude-shell-sh', claudeOnly);
  if (PWSH) await viaLauncher('claude', 'claude-shell-pwsh', onePerEvent(claudeOnly));
  if (!SH && !PWSH) t.skip('no sh or pwsh');
});

// ---------------------------------------------------------------------------
// Fail-open launch paths, encoding, timing, leaks

const editPayload = (repo, file = 'tests/x.test.js', text = "it.only('x', () => {})") =>
  JSON.stringify({ sessionId: 'fo-1', timestamp: 1761400000000, cwd: repo, toolName: 'edit', toolArgs: { path: file, new_str: text } });

function fakeNodeDir(script) {
  const dir = tmp('adc-fakenode-');
  const f = path.join(dir, 'node');
  fs.writeFileSync(f, `#!/bin/sh\n${script}\n`);
  fs.chmodSync(f, 0o755);
  return dir;
}

test('Copilot guards print {} with exit 0 when node is missing, crashes or is too old', { skip: core.IS_WINDOWS ? 'POSIX fake executables' : false, timeout: 120_000 }, async () => {
  const repo = makeRepo();
  const h = handlerFor('copilot', 'guard', 'pre-guard');
  const input = JSON.stringify({ sessionId: 'fo-1', cwd: repo, toolName: 'bash', toolArgs: { command: 'git push --force' } });
  const sysPath = ['/usr/bin', '/bin'].join(path.delimiter);
  const variants = [
    ['missing node', tmp('adc-empty-path-')],
    ['crashing node', `${fakeNodeDir('echo "Segmentation fault" >&2; exit 139')}${path.delimiter}${sysPath}`],
    ['node that prints garbage and fails', `${fakeNodeDir('echo "{not json"; exit 3')}${path.delimiter}${sysPath}`],
  ];
  if (NODE_OLD) variants.push(['node too old', `${path.dirname(NODE_OLD)}${path.delimiter}${sysPath}`]);
  for (const [label, PATH] of variants) {
    const env = { ...baseEnv(), PATH };
    if (PWSH) {
      const res = await spawnAsync(PWSH, ['-NoProfile', '-Command', h.powershell], { input, env, cwd: repo });
      assert.deepEqual(assertHookOutput(res, `pwsh ${label}`), {}, `pwsh ${label}`);
    }
    if (BASH && label !== 'node that prints garbage and fails') {
      const res = await spawnAsync(BASH, ['-c', h.bash], { input, env, cwd: repo });
      assert.deepEqual(assertHookOutput(res, `bash ${label}`), {}, `bash ${label}`);
    }
  }
  if (NODE_OLD) {
    const res = await spawnAsync(NODE_OLD, [ADC, 'hook-run', 'pre-guard', '--dialect', 'copilot'], { input, env: baseEnv(), cwd: repo });
    assert.deepEqual(assertHookOutput(res, 'old node direct'), {});
  }
});

test('Codex commands fail open under pwsh -Command and sh -c: missing or crashing node is a non-blocking failure, old node prints {}', { skip: core.IS_WINDOWS ? 'POSIX fake executables' : false, timeout: 120_000 }, async () => {
  // Codex runs the bare command: exit 0 parses stdout, exit 2 with stderr blocks, any other exit is a
  // non-blocking failure. So the launch must never end with exit 2 or with JSON-looking stdout.
  const repo = makeRepo();
  const h = handlerFor('codex', 'guard', 'pre-guard');
  const input = JSON.stringify({ session_id: 'cx-fo', turn_id: 't', cwd: repo, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push --force' } });
  const sysPath = ['/usr/bin', '/bin'].join(path.delimiter);
  const variants = [
    ['missing node', tmp('adc-empty-path-')],
    ['crashing node', `${fakeNodeDir('echo "Segmentation fault" >&2; exit 139')}${path.delimiter}${sysPath}`],
    ['node exiting 2', `${fakeNodeDir('echo "fatal" >&2; exit 2')}${path.delimiter}${sysPath}`],
  ];
  for (const [label, PATH] of variants) {
    const env = { ...baseEnv(), PATH };
    const launches = [];
    if (PWSH) launches.push(['pwsh', await spawnAsync(PWSH, ['-NoProfile', '-Command', h.commandWindows], { input, env, cwd: repo })]);
    if (SH) launches.push(['sh', await spawnAsync(SH, ['-c', h.command], { input, env, cwd: repo })]);
    for (const [launcher, res] of launches) {
      assert.notEqual(res.code, 0, `${launcher} ${label}: must not look like a decision`);
      assert.equal(res.stdout.trim().startsWith('{'), false, `${launcher} ${label}: no JSON on stdout`);
      // pwsh -Command collapses every failure to 1 (openai/codex#54072); sh passes the code through,
      // and a node that really exits 2 would block under sh, which is why adc.mjs always exits 0.
      if (launcher === 'pwsh') assert.equal(res.code, 1, `pwsh ${label}: exit ${res.code}`);
    }
  }
  if (NODE_OLD) {
    const env = { ...baseEnv(), PATH: `${path.dirname(NODE_OLD)}${path.delimiter}${sysPath}` };
    if (PWSH) assert.deepEqual(assertHookOutput(await spawnAsync(PWSH, ['-NoProfile', '-Command', h.commandWindows], { input, env, cwd: repo }), 'pwsh old node'), {});
    if (SH) assert.deepEqual(assertHookOutput(await spawnAsync(SH, ['-c', h.command], { input, env, cwd: repo }), 'sh old node'), {});
  }
});

test('a non-ASCII payload through the Codex commandWindows under pwsh arrives intact, stdout byte-identical to a direct run', { skip: PWSH ? false : 'pwsh not installed', timeout: 60_000 }, async () => {
  const repo = makeRepo();
  const payload = (r) => JSON.stringify({ session_id: 'cx-u', turn_id: 't', cwd: r, hook_event_name: 'PostToolUse', tool_name: 'apply_patch',
    tool_input: { command: "*** Begin Patch\n*** Add File: tests/ünïcödé ✓.test.js\n+it.only('héllo wörld ✓', () => {});\n*** End Patch\n" } });
  const h = handlerFor('codex', 'advise', 'post-edit');
  const viaPwsh = await spawnAsync(PWSH, ['-NoProfile', '-Command', h.commandWindows], { input: payload(repo), env: baseEnv(), cwd: repo });
  const obj = assertHookOutput(viaPwsh, 'codex pwsh non-ASCII');
  assert.match(obj.hookSpecificOutput.additionalContext, /tests\/ünïcödé ✓\.test\.js \(test file\)[\s\S]*héllo wörld ✓/);
  const repo2 = makeRepo();
  const direct = await spawnAsync(process.execPath, [ADC, 'hook-run', 'post-edit', '--dialect', 'codex'], { input: payload(repo2), env: baseEnv(), cwd: repo2 });
  assert.equal(viaPwsh.bytes.toString('hex'), direct.bytes.toString('hex'), 'byte-identical stdout');
});

test('a non-ASCII payload through pwsh -Command arrives intact and stdout is byte-identical to a direct run', { skip: PWSH ? false : 'pwsh not installed', timeout: 60_000 }, async () => {
  const repo = makeRepo();
  const input = editPayload(repo, 'tests/ünïcödé ✓.test.js', "it.only('héllo wörld ✓', () => {})");
  const h = handlerFor('copilot', 'advise', 'post-edit');
  const direct = await spawnAsync(process.execPath, [ADC, 'hook-run', 'post-edit', '--dialect', 'copilot'], { input, env: baseEnv(), cwd: makeRepo() });
  const viaPwsh = await spawnAsync(PWSH, ['-NoProfile', '-Command', h.powershell], { input, env: baseEnv(), cwd: repo });
  const obj = assertHookOutput(viaPwsh, 'pwsh non-ASCII');
  assert.match(obj.additionalContext, /tests\/ünïcödé ✓\.test\.js \(test file\)/);
  assert.match(obj.additionalContext, /héllo wörld ✓/);
  assert.ok(viaPwsh.stdout.includes('\\u00fc') && viaPwsh.stdout.includes('\\u2713'));
  assert.equal(viaPwsh.bytes.toString('hex'), direct.bytes.toString('hex'), 'byte-identical stdout');
});

test('stdout is byte-identical between a direct run and the pwsh launcher for the same repository', { skip: PWSH ? false : 'pwsh not installed', timeout: 60_000 }, async () => {
  const repo = makeRepo();
  const input = JSON.stringify({ sessionId: 'bi-1', cwd: repo, toolName: 'bash', toolArgs: { command: 'git push -f' } });
  const h = handlerFor('copilot', 'guard', 'pre-guard');
  const a = await spawnAsync(process.execPath, [ADC, 'hook-run', 'pre-guard', '--dialect', 'copilot', '--level', 'guard'], { input, env: baseEnv(), cwd: repo });
  const b = await spawnAsync(PWSH, ['-NoProfile', '-Command', h.powershell], { input, env: baseEnv(), cwd: repo });
  assert.equal(b.bytes.toString('hex'), a.bytes.toString('hex'));
});

test('session-start on an uncached repository finishes under 500 ms', async () => {
  const times = [];
  for (let i = 0; i < 3; i++) {
    const repo = makeRepo();
    const res = await spawnAsync(process.execPath, [ADC, 'hook-run', 'session-start', '--dialect', 'claude'], { input: JSON.stringify({ session_id: 'perf', cwd: repo, hook_event_name: 'SessionStart', source: 'startup' }), env: baseEnv(), cwd: repo });
    assertHookOutput(res, 'session-start perf');
    times.push(res.ms);
  }
  assert.ok(Math.min(...times) < 500, `session-start took ${times.join(', ')} ms`);
});

test('a host that never closes stdin still gets {} and exit 0 within the watchdog', async () => {
  const repo = makeRepo();
  const res = await spawnAsync(process.execPath, [ADC, 'hook-run', 'stop', '--dialect', 'copilot'], { input: '{"sessionId":"open",', env: baseEnv(), cwd: repo, closeStdin: false, timeoutMs: 8000 });
  assert.deepEqual(assertHookOutput(res, 'open stdin'), {});
  assert.ok(res.ms < 3500, `took ${res.ms} ms`);
});

test('ADC_DEBUG hooks.log records metadata only: a token in tool output never reaches logs or session files', async () => {
  const repo = makeRepo();
  const env = baseEnv({ ADC_DEBUG: '1' });
  const steps = [
    ['post-edit', { session_id: 'leak', cwd: repo, hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: `${repo}/src/a.js`, content: `const t = "${TOKEN}";` } }],
    ['post-shell', { session_id: 'leak', cwd: repo, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: `ADC_LIVE_TOKEN=${TOKEN} npm test` }, tool_response: { stdout: `token ${TOKEN}\nTests: 1 passed, 1 total`, stderr: `ADC_LIVE_TOKEN=${TOKEN}` } }],
    ['stop', { session_id: 'leak', cwd: repo, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: `done ${TOKEN}` }],
    ['pre-guard', { session_id: 'leak', cwd: repo, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: `echo ${TOKEN} > .adc/.env.live` } }],
  ];
  for (const [event, payload] of steps) {
    const res = await spawnAsync(process.execPath, [ADC, 'hook-run', event, '--dialect', 'claude', '--level', 'guard'], { input: JSON.stringify(payload), env, cwd: repo });
    const obj = assertHookOutput(res, event);
    assert.ok(!res.stdout.includes(TOKEN) && !res.stderr.includes(TOKEN), `${event} output leaks the token`);
    if (event === 'pre-guard') assert.equal(obj.hookSpecificOutput.permissionDecision, 'deny');
  }
  const log = fs.readFileSync(path.join(repo, '.adc', 'hooks.log'), 'utf8');
  assert.ok(log.includes('"event":"post-shell"'), 'verbose log written');
  assert.ok(!log.includes(TOKEN), 'hooks.log leaks the token');
  for (const f of fs.readdirSync(path.join(repo, '.adc', 'sessions'))) {
    assert.ok(!fs.readFileSync(path.join(repo, '.adc', 'sessions', f), 'utf8').includes(TOKEN), `session ${f} leaks the token`);
  }
  const s = core.readJson(state.sessionFile(path.join(repo, '.adc'), 'leak'));
  assert.equal(s.observed_runs[0].cmd_head, 'npm test');
});

test('hooks create .adc/ only with the exclude entry, and only when there is something to record', async () => {
  const repo = makeRepo();
  const run1 = (event, payload) => spawnAsync(process.execPath, [ADC, 'hook-run', event, '--dialect', 'claude'], { input: JSON.stringify(payload), env: baseEnv(), cwd: repo });
  await run1('session-start', { session_id: 'x', cwd: repo, hook_event_name: 'SessionStart', source: 'startup' });
  assert.ok(!fs.existsSync(path.join(repo, '.adc')), 'session-start alone leaves no state');
  await run1('post-edit', { session_id: 'x', cwd: repo, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/a.js', new_string: 'a' } });
  assert.ok(fs.existsSync(path.join(repo, '.adc', 'sessions', 'x.json')));
  assert.match(fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8'), /^\/\.adc\/$/m);
  assert.equal(git(repo, 'status', '--porcelain'), '');
  if (!core.IS_WINDOWS) assert.equal(fs.statSync(path.join(repo, '.adc')).mode & 0o077, 0);
});

test('--state-dir and ADC_HOME relocate hook state', async () => {
  const repo = makeRepo();
  const home = tmp('adc-statehome-');
  const payload = JSON.stringify({ session_id: 'rel', cwd: repo, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/a.js', new_string: 'a' } });
  await spawnAsync(process.execPath, [ADC, 'hook-run', 'post-edit', '--dialect', 'claude'], { input: payload, env: baseEnv({ ADC_HOME: home }), cwd: repo });
  assert.ok(fs.existsSync(path.join(home, 'sessions', 'rel.json')));
  await spawnAsync(process.execPath, [ADC, 'hook-run', 'post-edit', '--dialect', 'claude', '--state-dir', '.state'], { input: payload, env: baseEnv(), cwd: repo });
  assert.ok(fs.existsSync(path.join(repo, '.state', 'sessions', 'rel.json')));
  assert.match(fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8'), /^\/\.state\/$/m);
  assert.ok(!fs.existsSync(path.join(repo, '.adc')));
});

// ---------------------------------------------------------------------------
// Real hosts, offline: each installed CLI is driven by a scripted fake model endpoint on
// 127.0.0.1 (no account, no network, no cost), with this skill's hooks registered through
// `setup hooks --write` in a temp HOME. The assertions read what the host passed to the model.

const findBin = (name, extra = []) => core.which(name) || extra.find((p) => fs.existsSync(p)) || null;
const HOST_BIN = {
  copilot: findBin('copilot', ['/opt/hostclis/bin/copilot']),
  claude: findBin('claude', ['/opt/claude-code/bin/claude']),
  codex: findBin('codex', ['/opt/hostclis/bin/codex']),
};
// Copilot unpacks a ~240 MB package into $HOME/.cache on first start; reuse an unpacked copy.
const COPILOT_DIST = (() => {
  const base = path.join(os.homedir(), '.cache', 'copilot', 'pkg', `${process.platform}-${process.arch}`);
  try { return fs.readdirSync(base).sort().reverse().map((v) => path.join(base, v)).find((d) => fs.existsSync(path.join(d, 'package.json'))) || null; } catch { return null; }
})();
const OFFLINE = { HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9', https_proxy: 'http://127.0.0.1:9', http_proxy: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };

/**
 * A fake model endpoint (OpenAI chat completions, OpenAI Responses, Anthropic Messages; streaming).
 * Step n of `steps` answers the request that carries n tool results: `{ call: name, args }` or `{ text }`.
 */
async function startFakeModel(steps) {
  const http = await import('node:http');
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch {}
      const url = req.url.split('?')[0];
      requests.push({ url, body });
      const sse = () => res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.method === 'GET') return json({ object: 'list', data: [{ id: 'fake', object: 'model', type: 'model' }] });
      const pick = (n, names) => { const s = steps[n] || { text: 'done' }; return s.call && names.includes(s.call) ? s : { text: s.text || 'done' }; };
      if (url.endsWith('/chat/completions')) {
        const n = (body.messages || []).filter((m) => m.role === 'tool').length;
        const s = pick(n, (body.tools || []).map((t) => (t.function ? t.function.name : '')));
        const base = { id: `c${requests.length}`, object: 'chat.completion.chunk', created: 1, model: body.model };
        const delta = s.call
          ? { role: 'assistant', content: null, tool_calls: [{ index: 0, id: `call_${requests.length}`, type: 'function', function: { name: s.call, arguments: JSON.stringify(s.args) } }] }
          : { role: 'assistant', content: s.text };
        sse();
        res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: s.call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
        res.end('data: [DONE]\n\n');
        return undefined;
      }
      if (url.endsWith('/responses')) {
        const n = (body.input || []).filter((i) => /_output$/.test(String(i.type))).length;
        const s = pick(n, (body.tools || []).map((t) => t.name));
        const custom = s.call && (body.tools || []).some((t) => t.name === s.call && t.type === 'custom');
        const item = !s.call ? { type: 'message', id: `m${n}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: s.text, annotations: [] }] }
          : custom ? { type: 'custom_tool_call', id: `t${n}`, call_id: `call_${requests.length}`, name: s.call, input: s.args.input, status: 'completed' }
            : { type: 'function_call', id: `f${n}`, call_id: `call_${requests.length}`, name: s.call, arguments: JSON.stringify(s.args), status: 'completed' };
        const response = { id: `r${requests.length}`, object: 'response', created_at: 1, model: body.model, status: 'completed', output: [item],
          usage: { input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 2 } };
        sse();
        for (const [type, o] of [['response.created', { response: { ...response, status: 'in_progress', output: [] } }], ['response.output_item.done', { output_index: 0, item }], ['response.completed', { response }]]) {
          res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...o })}\n\n`);
        }
        res.end();
        return undefined;
      }
      if (url.endsWith('/messages/count_tokens')) return json({ input_tokens: 1 });
      if (url.endsWith('/messages')) {
        let n = 0;
        for (const m of body.messages || []) if (Array.isArray(m.content)) n += m.content.filter((b) => b.type === 'tool_result').length;
        const names = (body.tools || []).map((t) => t.name);
        const s = names.length ? pick(n, names) : { text: 'title' };
        const block = s.call ? { type: 'tool_use', id: `toolu_${requests.length}`, name: s.call, input: {} } : { type: 'text', text: '' };
        const delta = s.call ? { type: 'input_json_delta', partial_json: JSON.stringify(s.args) } : { type: 'text_delta', text: s.text };
        const usage = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
        sse();
        for (const [type, o] of [
          ['message_start', { message: { id: `msg_${requests.length}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage } }],
          ['content_block_start', { index: 0, content_block: block }], ['content_block_delta', { index: 0, delta }], ['content_block_stop', { index: 0 }],
          ['message_delta', { delta: { stop_reason: s.call ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }], ['message_stop', {}],
        ]) res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...o })}\n\n`);
        res.end();
        return undefined;
      }
      return json({});
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }) };
}

/** Register this skill's hooks for `host` (guard level) with the real CLI command, in a temp HOME. */
function registerForHost(host, repo, env) {
  const r = spawnSync(process.execPath, [ADC, 'setup', 'hooks', '--host', host, '--level', 'guard', '--write', '--json', '--cwd', repo], { encoding: 'utf8', env });
  assert.equal(r.status, 0, `setup hooks --host ${host}: ${r.stderr}`);
  assert.equal(JSON.parse(r.stdout).written, true, `setup hooks --host ${host} wrote nothing`);
}

/** The latest request body that carried tools, and the session file the hooks wrote. */
function hostResult(model, repo) {
  const last = [...model.requests].reverse().find((r) => r.body && (r.body.messages || r.body.input) && (r.body.tools || []).length);
  const sessions = path.join(repo, '.adc', 'sessions');
  const files = fs.existsSync(sessions) ? fs.readdirSync(sessions).filter((f) => f.endsWith('.json')) : [];
  return { body: last ? last.body : {}, session: files.length ? core.readJson(path.join(sessions, files[0])) : null };
}

const count = (text, needle) => text.split(needle).length - 1;
const asText = (v) => (typeof v === 'string' ? v : JSON.stringify(v));

/** What the host showed the model, by channel (the last request of the run). */
function channels(body) {
  const ch = { user: '', system: '', tool: '' };
  for (const m of body.messages || []) {
    if (m.role === 'tool') ch.tool += asText(m.content);
    else if (m.role === 'system') ch.system += asText(m.content);
    else if (m.role === 'user' && Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b.type === 'tool_result') ch.tool += asText(b.content);
        else ch.user += asText(b.text ?? b);
      }
    } else if (m.role === 'user') ch.user += asText(m.content);
  }
  for (const i of body.input || []) {
    if (/_output$/.test(String(i.type))) ch.tool += asText(i.output);
    else if (i.type === 'message' && i.role === 'developer') ch.system += asText(i.content);
    else if (i.type === 'message' && i.role === 'user') ch.user += asText(i.content);
  }
  return ch;
}
const hostSkip = (name, extra = null) => (HOST_BIN[name] ? extra : `${name} CLI not installed`) || false;

describe('real hosts with the registered hooks (offline, scripted fake model)', { concurrency: 3 }, () => {
  test('Copilot CLI: brief, post-edit note, guard denials, modifiedResult redaction, stop gate', {
    skip: hostSkip('copilot', COPILOT_DIST ? null : 'no unpacked Copilot package in ~/.cache/copilot/pkg (run copilot once)'), timeout: 90_000,
  }, async () => {
    const repo = makeRepo();
    fs.mkdirSync(path.join(repo, 'tests')); // Copilot's create tool needs the parent directory
    const home = tmp('adc-host-copilot-');
    const env = baseEnv({ ...OFFLINE, HOME: home, USERPROFILE: home, COPILOT_HOME: path.join(home, '.copilot') });
    registerForHost('copilot', repo, env);
    const model = await startFakeModel([
      { call: 'create', args: { path: `${repo}/tests/e2e.test.js`, file_text: "const test = require('node:test');\ntest.only('e2e', () => {});\n" } },
      { call: 'bash', args: { command: 'node --test tests/', description: 'run tests' } },
      { call: 'view', args: { path: `${repo}/.adc/.env.live` } },
      { call: 'grep', args: { pattern: 'TOKEN', paths: `${repo}/.adc` } },
      { call: 'bash', args: { command: 'git push --force origin main', description: 'push' } },
      { call: 'bash', args: { command: `echo ADC_LIVE_TOKEN=${TOKEN}`, description: 'echo' } },
      // An exported token printed bare: no shape to match, so the hook redacts the literal value it inherits.
      { call: 'bash', args: { command: 'printf "%s\\n" "$ADC_LIVE_TOKEN"', description: 'print' } },
      { text: 'All tests pass now.' },
    ]);
    try {
      const res = await spawnAsync(HOST_BIN.copilot, ['-p', 'run the scripted task', '--allow-all', '--no-ask-user'], {
        cwd: repo, timeoutMs: 80_000,
        env: { ...env, ADC_LIVE_TOKEN: ENV_TOKEN, COPILOT_OFFLINE: 'true', COPILOT_PROVIDER_BASE_URL: `${model.url}/v1`, COPILOT_PROVIDER_API_KEY: 'fake', COPILOT_MODEL: 'gpt-4.1', COPILOT_AUTO_UPDATE: 'false', COPILOT_CLI_DIST_DIR: COPILOT_DIST },
      });
      assert.equal(res.code, 0, `copilot exit ${res.code}: ${res.stderr.slice(-800)}`);
      const { body, session } = hostResult(model, repo);
      const ch = channels(body);
      // Copilot injects the brief and the stop block as user messages and appends post-edit notes to the tool result.
      assert.ok(ch.user.includes('agentic-developer-companion is installed'), 'session brief reached the model');
      assert.match(ch.tool, /tests\/e2e\.test\.js \(test file\): adds a skip\/focus marker/, 'post-edit note reached the model');
      assert.equal(count(ch.tool, 'agentic-developer-companion guard:'), 3, 'view, grep and force-push denied');
      assert.ok(ch.tool.includes('ADC_LIVE_TOKEN=[REDACTED]') && !ch.tool.includes(TOKEN), 'modifiedResult redacted the token in the result');
      assert.ok(ch.tool.includes('[REDACTED:ADC_LIVE_TOKEN]') && !ch.tool.includes(ENV_TOKEN), 'the exported token value is redacted literally');
      assert.equal(count(ch.user, 'agentic-developer-companion completion gate'), 1, 'stop gate blocked once');
      assert.equal(session.dialect, 'copilot');
      assert.equal(session.tool, 'copilot-cli');
      assert.equal(session.edits.count, 1);
      assert.equal(typeof session.observed_runs[0].exit, 'number', 'exit code from the result trailer');
      assert.equal(session.observed_runs[0].exit_source, 'result-text');
      assert.equal(session.guard.denials, 3);
      assert.equal(session.gate.blocks, 1);
      assert.ok(session.ended, 'sessionEnd fired');
    } finally { await model.close(); }
  });

  test('Claude Code: brief and note as system context, Read and shell .env.live denied, test deletion asked, stop feedback', {
    skip: hostSkip('claude'), timeout: 90_000,
  }, async () => {
    const repo = makeRepo();
    const home = tmp('adc-host-claude-');
    const env = baseEnv({ ...OFFLINE, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude') });
    registerForHost('claude', repo, env);
    const model = await startFakeModel([
      { call: 'Write', args: { file_path: `${repo}/tests/e2e.test.js`, content: "const test = require('node:test');\ntest.only('e2e', () => {});\n" } },
      { call: 'Bash', args: { command: 'node --test tests/', description: 'run tests' } },
      { call: 'Read', args: { file_path: `${repo}/.adc/.env.live` } },
      { call: 'Bash', args: { command: 'cat .adc/.env.live', description: 'creds' } },
      { call: 'Bash', args: { command: 'git push --force origin main', description: 'push' } },
      // Claude's Bash keeps its cwd: the second command names no `.adc`, only `.env.live`.
      { call: 'Bash', args: { command: 'cd .adc', description: 'cd' } },
      { call: 'Bash', args: { command: 'cat .env.live', description: 'creds' } },
      { call: 'Bash', args: { command: 'cd .. && rm tests/e2e.test.js', description: 'delete' } },
      { text: 'All tests pass now.' },
    ]);
    try {
      const res = await spawnAsync(HOST_BIN.claude, ['-p', 'run the scripted task', '--permission-mode', 'acceptEdits', '--allowedTools', 'Bash,Read,Write,Edit', '--output-format', 'json'], {
        cwd: repo, timeoutMs: 80_000,
        env: { ...env, ANTHROPIC_BASE_URL: model.url, ANTHROPIC_API_KEY: 'sk-fake', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
      });
      assert.equal(res.code, 0, `claude exit ${res.code}: ${res.stderr.slice(-800)} ${res.stdout.slice(-400)}`);
      const { body, session } = hostResult(model, repo);
      const ch = channels(body);
      // Claude Code passes hook context as system messages and stop feedback as a user message.
      assert.ok(ch.system.includes('agentic-developer-companion is installed'), 'session brief');
      assert.match(ch.system, /agentic-developer-companion notes on this edit[\s\S]*tests\/e2e\.test\.js \(test file\)/, 'post-edit note');
      assert.equal(count(ch.tool, 'agentic-developer-companion guard:'), 5, 'Read, cat .adc/.env.live, force-push and cat .env.live (inside .adc/) denied; rm of a test file asked');
      // Under -p an `ask` cannot be answered: the call does not run and the reason reaches the model.
      assert.ok(fs.existsSync(path.join(repo, 'tests', 'e2e.test.js')), 'the asked deletion did not run');
      assert.match(ch.user, /completion gate[\s\S]*The final message states "All tests pass/, 'stop gate with the claim');
      assert.equal(session.dialect, 'claude');
      assert.equal(session.edits.count, 1);
      assert.equal(session.observed_runs[0].class, 'test');
      assert.equal(session.guard.denials, 4);
      assert.equal(session.guard.asks, 1, '`if: Bash(rm *)` started the guard for `cd .. && rm tests/e2e.test.js`');
    } finally { await model.close(); }
  });

  test('Codex: brief and note as developer messages, shell and apply_patch guard denials, stop gate', {
    skip: hostSkip('codex'), timeout: 90_000,
  }, async () => {
    const repo = makeRepo();
    const home = tmp('adc-host-codex-');
    const codexHome = path.join(home, '.codex');
    const env = baseEnv({ ...OFFLINE, HOME: home, USERPROFILE: home, CODEX_HOME: codexHome, SHELL: '/bin/bash' });
    registerForHost('codex', repo, env);
    const model = await startFakeModel([
      { call: 'apply_patch', args: { input: "*** Begin Patch\n*** Add File: tests/e2e.test.js\n+const test = require('node:test');\n+test.only('e2e', () => {});\n*** End Patch\n" } },
      { call: 'exec_command', args: { cmd: 'node --test tests/' } },
      { call: 'exec_command', args: { cmd: 'cat .adc/.env.live' } },
      { call: 'exec_command', args: { cmd: 'git push --force origin main' } },
      { call: 'apply_patch', args: { input: '*** Begin Patch\n*** Add File: .adc/evidence/forged.json\n+{}\n*** End Patch\n' } },
      { text: 'All tests pass.' },
    ]);
    fs.writeFileSync(path.join(codexHome, 'config.toml'), [
      'model = "gpt-5.5"', 'model_provider = "fake"', '[model_providers.fake]', 'name = "fake"', `base_url = "${model.url}/v1"`,
      'env_key = "FAKE_API_KEY"', 'wire_api = "responses"', `[projects."${core.toPosix(repo)}"]`, 'trust_level = "trusted"', '',
    ].join('\n'));
    try {
      const res = await spawnAsync(HOST_BIN.codex, ['exec', '--skip-git-repo-check', '--dangerously-bypass-hook-trust', '-s', 'workspace-write', '--json', 'run the scripted task'], {
        cwd: repo, timeoutMs: 80_000, env: { ...env, FAKE_API_KEY: 'fake' },
      });
      assert.equal(res.code, 0, `codex exit ${res.code}: ${res.stderr.slice(-800)}`);
      const { body, session } = hostResult(model, repo);
      const ch = channels(body);
      // Codex passes hook context as developer messages and the stop block as a user message.
      assert.ok(ch.system.includes('agentic-developer-companion is installed'), 'session brief');
      assert.match(ch.system, /tests\/e2e\.test\.js \(test file\): adds a skip\/focus marker/, 'post-edit note');
      assert.equal(count(ch.tool, 'agentic-developer-companion guard:'), 3, 'cat .env.live, force-push and the .adc/ patch denied');
      assert.ok(!fs.existsSync(path.join(repo, '.adc', 'evidence', 'forged.json')), 'the denied patch was not applied');
      assert.equal(count(ch.user, 'agentic-developer-companion completion gate'), 1, 'stop gate');
      assert.equal(session.dialect, 'codex');
      assert.equal(session.permission_mode, 'bypassPermissions');
      assert.equal(session.edits.count, 1);
      assert.equal(session.guard.denials, 3);
    } finally { await model.close(); }
  });
});

// ---------------------------------------------------------------------------
// Rendering

const SNAP_SKILL = '/opt/skills/agentic-developer-companion';
const SNAP_WIN = 'C:/Users/Dev User/.copilot/skills/agentic-developer-companion';
const SNAP_HOME = '/home/dev';
const SNAP_VARIANTS = {
  copilot: [
    ['user-advise', {}], ['user-gate', { level: 'gate' }], ['user-guard', { level: 'guard' }],
    ['user-advise-node-path', { nodePath: '/opt/node js/bin/node' }],
    ['user-advise-windows', { skillDir: SNAP_WIN, nodePath: 'C:/Program Files/nodejs/node.exe' }],
    ['user-advise-special-chars', { skillDir: '/opt/we$ird `dir` "q"/agentic-developer-companion' }],
    ['project-advise-external-skill', { scope: 'project' }],
    ['project-advise-vendored', { scope: 'project', vendored: '.github/skills' }],
  ],
  'copilot-cloud': [
    ['project-advise-vendored', { vendored: '.agents/skills' }],
    ['project-guard-vendored', { level: 'guard', vendored: '.github/skills' }],
    ['project-advise-not-vendored', {}],
  ],
  claude: [
    ['user-advise', {}], ['user-guard', { level: 'guard' }], ['project-gate', { scope: 'project', level: 'gate' }],
    ['user-advise-node-path', { nodePath: '/opt/node js/bin/node' }],
    ['user-advise-windows', { skillDir: SNAP_WIN, nodePath: 'C:/Program Files/nodejs/node.exe' }],
  ],
  codex: [
    ['user-advise', {}], ['user-guard', { level: 'guard' }], ['project-advise', { scope: 'project' }],
    ['user-advise-node-path', { nodePath: '/opt/node js/bin/node' }],
    ['user-advise-windows', { skillDir: SNAP_WIN, nodePath: 'C:/Program Files/nodejs/node.exe' }],
  ],
};

function renderVariant(host, opts) {
  const root = makeRepo();
  let skillDir = opts.skillDir || SNAP_SKILL;
  if (opts.vendored) {
    skillDir = path.join(root, opts.vendored, 'agentic-developer-companion');
    fs.mkdirSync(path.join(skillDir, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'scripts', 'adc.mjs'), '');
  }
  const r = hooksRender.renderHooks({ host, scope: opts.scope || null, level: opts.level || 'advise', nodePath: opts.nodePath || null, skillDir, root, home: SNAP_HOME, env: {}, shortPath: null });
  const snap = { target_file: r.target_file, skill_path: r.skill_path, node: r.node, warnings: r.warnings, config: r.config };
  return { r, snap: JSON.parse(JSON.stringify(snap).split(core.toPosix(root)).join('<REPO>')) };
}

for (const host of hooksRender.HOSTS) {
  test(`hooks render snapshots: ${host}`, () => {
    const file = path.join(SNAP, `${host}.json`);
    const actual = {};
    for (const [name, opts] of SNAP_VARIANTS[host]) {
      if (core.IS_WINDOWS && !opts.skillDir && !opts.vendored) continue; // POSIX skill paths resolve differently on Windows
      const { r, snap } = renderVariant(host, opts);
      actual[name] = snap;
      JSON.parse(JSON.stringify(r.config));
      if (host === 'copilot' || host === 'copilot-cloud') {
        assert.equal(r.config.version, 1);
        for (const [ev, list] of Object.entries(r.config.hooks)) {
          for (const e of list) {
            assert.equal(e.command, undefined, `${name} ${ev}: Copilot output must never carry "command"`);
            assert.ok(e.bash && e.powershell, `${name} ${ev}: bash and powershell`);
            assert.match(e.bash, / \|\| echo \{\}$/);
            assert.match(e.powershell, /; exit 0$/);
          }
        }
      }
      const hasGuard = JSON.stringify(r.config).includes('pre-guard');
      assert.equal(hasGuard, (opts.level || 'advise') === 'guard', `${name}: pre-guard only at level guard`);
    }
    if (UPDATE || !fs.existsSync(file)) {
      fs.mkdirSync(SNAP, { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(actual, null, 2)}\n`);
    }
    const expected = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const name of Object.keys(actual)) assert.deepEqual(actual[name], expected[name], `${host}/${name} differs from tests/snapshots/${host}.json (UPDATE_SNAPSHOTS=1 regenerates)`);
  });
}

test('the default render equals the shipped template with <SKILL> substituted (minus the opt-in guard entries)', () => {
  for (const host of ['copilot', 'claude', 'codex']) {
    const tpl = JSON.parse(fs.readFileSync(path.join(core.ASSETS_DIR, 'hooks', { copilot: 'copilot.hooks.json', claude: 'claude.settings.hooks.json', codex: 'codex.hooks.json' }[host]), 'utf8'));
    const r = hooksRender.renderHooks({ host, skillDir: SNAP_SKILL, home: SNAP_HOME, env: {} });
    const expected = JSON.parse(JSON.stringify(tpl).split('<SKILL>').join(SNAP_SKILL));
    delete expected.hooks[host === 'copilot' ? 'preToolUse' : 'PreToolUse'];
    assert.deepEqual(r.config, expected, host);
  }
  const cloud = JSON.parse(fs.readFileSync(path.join(core.ASSETS_DIR, 'hooks', 'copilot.cloud.hooks.json'), 'utf8'));
  assert.ok(Object.values(cloud.hooks).flat().every((e) => e.bash && e.powershell && !e.command));
});

test('rendered strings quote paths with spaces and shell metacharacters correctly in bash and pwsh', { skip: core.IS_WINDOWS ? 'POSIX paths' : false, timeout: 60_000 }, async () => {
  const base = path.join(tmp('adc-quote-'), 'we$ird `dir` "q" x');
  const skill = path.join(base, 'agentic-developer-companion');
  fs.mkdirSync(skill, { recursive: true });
  for (const p of ['SKILL.md', 'scripts', 'assets']) fs.cpSync(path.join(SKILL, p), path.join(skill, p), { recursive: true });
  const repo = makeRepo();
  const r = hooksRender.renderHooks({ host: 'copilot', level: 'guard', skillDir: skill, home: HOME, env: {} });
  const h = r.config.hooks.preToolUse[0];
  const input = JSON.stringify({ sessionId: 'q', cwd: repo, toolName: 'bash', toolArgs: { command: 'git reset --hard' } });
  if (BASH) assert.equal(assertHookOutput(await spawnAsync(BASH, ['-c', h.bash], { input, env: baseEnv(), cwd: repo }), 'bash quoting').permissionDecision, 'deny');
  if (PWSH) assert.equal(assertHookOutput(await spawnAsync(PWSH, ['-NoProfile', '-Command', h.powershell], { input, env: baseEnv(), cwd: repo }), 'pwsh quoting').permissionDecision, 'deny');
  const c = hooksRender.renderHooks({ host: 'claude', skillDir: skill, home: HOME, env: {} }).config.hooks.SessionStart[0].hooks[0];
  const out = assertHookOutput(await spawnAsync(c.command, c.args, { input: JSON.stringify({ session_id: 'q', cwd: repo, hook_event_name: 'SessionStart' }), env: baseEnv(), cwd: repo }), 'claude exec quoting');
  assert.ok(out.hookSpecificOutput.additionalContext.includes('we$ird'));
  const abs = hooksRender.renderHooks({ host: 'copilot', skillDir: skill, nodePath: process.execPath, home: HOME, env: {} }).config.hooks.sessionStart[0];
  const inp = JSON.stringify({ sessionId: 'q', cwd: repo, source: 'startup' });
  if (BASH) assert.ok(assertHookOutput(await spawnAsync(BASH, ['-c', abs.bash], { input: inp, env: { ...baseEnv(), PATH: '/nonexistent' }, cwd: repo }), 'abs node bash').additionalContext);
  if (PWSH) assert.ok(assertHookOutput(await spawnAsync(PWSH, ['-NoProfile', '-Command', abs.powershell], { input: inp, env: { ...baseEnv(), PATH: '/nonexistent' }, cwd: repo }), 'abs node pwsh').additionalContext);
});

test('Windows Node paths with spaces: shell-form hosts render the 8.3 short path, bare in every shell', () => {
  const ok = (stdout) => () => ({ exit: 0, stdout });
  assert.equal(hooksRender.windowsShortPath('C:\\Program Files\\nodejs\\node.exe', ok('C:\\PROGRA~1\\nodejs\\node.exe\r\n')), 'C:\\PROGRA~1\\nodejs\\node.exe');
  assert.equal(hooksRender.windowsShortPath('x', ok('C:\\Program Files\\x.exe\n')), null, 'short names disabled: still has a space');
  assert.equal(hooksRender.windowsShortPath('x', () => ({ exit: 1, stdout: '' })), null);
  const short = () => 'C:\\PROGRA~1\\nodejs\\node.exe';
  const nodePath = 'C:/Program Files/nodejs/node.exe';
  const cx = hooksRender.renderHooks({ host: 'codex', nodePath, skillDir: SNAP_WIN, home: SNAP_HOME, env: {}, shortPath: short });
  const h = cx.config.hooks.SessionStart[0].hooks[0];
  assert.equal(h.commandWindows, `C:\\PROGRA~1\\nodejs\\node.exe "${SNAP_WIN}/scripts/adc.mjs" hook-run session-start --dialect codex`);
  assert.equal(h.command, `C:/PROGRA~1/nodejs/node.exe "${SNAP_WIN}/scripts/adc.mjs" hook-run session-start --dialect codex`);
  assert.deepEqual(cx.warnings, []);
  const root = makeRepo();
  const cl = hooksRender.renderHooks({ host: 'claude', scope: 'project', root, nodePath, skillDir: SKILL, home: SNAP_HOME, env: {}, shortPath: short });
  assert.match(cl.config.hooks.Stop[0].hooks[0].command, /^C:\/PROGRA~1\/nodejs\/node\.exe "/);
  // Exec form needs no short path; without a short name the PowerShell form and a warning remain.
  assert.equal(hooksRender.renderHooks({ host: 'claude', nodePath, skillDir: SNAP_WIN, home: SNAP_HOME, env: {}, shortPath: short }).config.hooks.Stop[0].hooks[0].command, nodePath);
  const none = hooksRender.renderHooks({ host: 'codex', nodePath, skillDir: SNAP_WIN, home: SNAP_HOME, env: {}, shortPath: () => null });
  assert.match(none.config.hooks.SessionStart[0].hooks[0].commandWindows, /^& "C:\\Program Files\\nodejs\\node\.exe" /);
  assert.equal(none.warnings.length, 1);
});

test('renderHooks validates its inputs and resolves targets per host and scope', () => {
  assert.throws(() => hooksRender.renderHooks({ host: 'cursor' }), (e) => e.exit === 2);
  assert.throws(() => hooksRender.renderHooks({ host: 'claude', level: 'block' }), (e) => e.exit === 2);
  assert.throws(() => hooksRender.renderHooks({ host: 'copilot-cloud', scope: 'user' }), (e) => e.exit === 2);
  assert.throws(() => hooksRender.renderHooks({ host: 'codex', scope: 'project', root: null }), (e) => e.exit === 3);
  const env = { COPILOT_HOME: '/c/home', CLAUDE_CONFIG_DIR: '/cl/conf', CODEX_HOME: '/cx/home' };
  assert.equal(core.toPosix(hooksRender.targetFile('copilot', 'user', { env })), core.toPosix(path.resolve('/c/home/hooks/agentic-developer-companion.json')));
  assert.equal(core.toPosix(hooksRender.targetFile('claude', 'user', { env })), core.toPosix(path.resolve('/cl/conf/settings.json')));
  assert.equal(core.toPosix(hooksRender.targetFile('codex', 'user', { env })), core.toPosix(path.resolve('/cx/home/hooks.json')));
  assert.equal(core.toPosix(hooksRender.targetFile('claude', 'project', { root: '/r' })), core.toPosix(path.join('/r', '.claude', 'settings.local.json')));
  const g = hooksRender.renderHooks({ host: 'claude', level: 'guard', skillDir: SNAP_SKILL, home: SNAP_HOME, env: {} });
  assert.deepEqual(g.permission_rules.claude.permissions.deny, ['Read(./.adc/**)', 'Edit(./.adc/**)']);
  const pg = g.config.hooks.PreToolUse;
  assert.equal(pg[0].hooks[0].if, 'Bash(git *)');
  assert.deepEqual(pg[0].hooks[0].args.slice(-2), ['--level', 'guard']);
});

// ---------------------------------------------------------------------------
// Registration

function freshHome() {
  const home = tmp('adc-reg-home-');
  return { home, env: { HOME: home } };
}

test('writeHooks merges into existing configs, keeps foreign entries and keys, backs up, and is idempotent', () => {
  const root = makeRepo();
  const { home, env } = freshHome();
  // Claude: existing settings with permissions and a foreign hook.
  const claudeFile = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(claudeFile), { recursive: true });
  const foreign = { matcher: 'Bash', hooks: [{ type: 'command', command: 'my-audit' }] };
  fs.writeFileSync(claudeFile, JSON.stringify({ permissions: { allow: ['Bash(npm test)'] }, hooks: { PreToolUse: [foreign] }, theme: 'dark' }));
  const r1 = hooksRender.renderHooks({ host: 'claude', skillDir: SKILL, home, env, root });
  const w1 = hooksRender.writeHooks(r1, { root });
  assert.equal(w1.written, true);
  assert.ok(fs.existsSync(w1.backup_file));
  let data = JSON.parse(fs.readFileSync(claudeFile, 'utf8'));
  assert.deepEqual(data.permissions, { allow: ['Bash(npm test)'] });
  assert.equal(data.theme, 'dark');
  assert.deepEqual(data.hooks.PreToolUse, [foreign]);
  assert.equal(data.hooks.SessionStart.length, 1);
  // Level change: our entries are replaced, never duplicated.
  hooksRender.writeHooks(hooksRender.renderHooks({ host: 'claude', level: 'guard', skillDir: SKILL, home, env, root }), { root });
  hooksRender.writeHooks(hooksRender.renderHooks({ host: 'claude', level: 'guard', skillDir: SKILL, home, env, root }), { root });
  data = JSON.parse(fs.readFileSync(claudeFile, 'utf8'));
  assert.equal(data.hooks.PreToolUse.length, 4, 'the foreign group plus Bash, PowerShell and the file tools');
  assert.deepEqual(data.hooks.PreToolUse[0], foreign);
  assert.equal(data.hooks.Stop.length, 1);
  assert.deepEqual(data.hooks.Stop[0].hooks[0].args.slice(-2), ['--level', 'guard']);
  // Copilot: a new dedicated file; a foreign entry added by the user survives a re-write.
  const rc = hooksRender.renderHooks({ host: 'copilot', skillDir: SKILL, home, env, root });
  const wc = hooksRender.writeHooks(rc, { root });
  assert.equal(wc.created, true);
  assert.equal(wc.backup_file, null);
  const cfile = path.join(home, '.copilot', 'hooks', 'agentic-developer-companion.json');
  const cdata = JSON.parse(fs.readFileSync(cfile, 'utf8'));
  cdata.hooks.sessionStart.push({ type: 'command', bash: 'echo {}', powershell: "'{}'" });
  fs.writeFileSync(cfile, JSON.stringify(cdata));
  hooksRender.writeHooks(rc, { root });
  const c2 = JSON.parse(fs.readFileSync(cfile, 'utf8'));
  assert.equal(c2.hooks.sessionStart.length, 2);
  assert.equal(c2.hooks.sessionStart[1].bash, hooksRender.renderHooks({ host: 'copilot', skillDir: SKILL, home, env }).config.hooks.sessionStart[0].bash);
  // Codex: an existing description is kept.
  const xfile = path.join(home, '.codex', 'hooks.json');
  fs.mkdirSync(path.dirname(xfile), { recursive: true });
  fs.writeFileSync(xfile, JSON.stringify({ description: 'mine', hooks: {} }));
  hooksRender.writeHooks(hooksRender.renderHooks({ host: 'codex', skillDir: SKILL, home, env, root }), { root });
  assert.equal(JSON.parse(fs.readFileSync(xfile, 'utf8')).description, 'mine');
  // Records.
  const rec = core.readJson(path.join(root, '.adc', 'hooks-installed.json'));
  assert.deepEqual(rec.entries.map((e) => `${e.host}:${e.scope}:${e.level}`).sort(), ['claude:user:guard', 'codex:user:advise', 'copilot:user:advise']);
  assert.equal(git(root, 'status', '--porcelain'), '', 'records stay git-ignored');
});

test('writeHooks refuses an unparsable target and leaves it untouched; dry runs write nothing', () => {
  const { home, env } = freshHome();
  const file = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ "hooks": { // comment\n');
  const r = hooksRender.renderHooks({ host: 'claude', skillDir: SKILL, home, env });
  assert.throws(() => hooksRender.writeHooks(r, {}), (e) => e.exit === 3 && e.code === 'CONFIG_UNPARSABLE');
  assert.equal(fs.readFileSync(file, 'utf8'), '{ "hooks": { // comment\n');
  const { home: h2, env: e2 } = freshHome();
  const d = hooksRender.writeHooks(hooksRender.renderHooks({ host: 'codex', skillDir: SKILL, home: h2, env: e2 }), { dryRun: true });
  assert.equal(d.written, false);
  assert.ok(d.content.hooks.SessionStart);
  assert.ok(!fs.existsSync(path.join(h2, '.codex', 'hooks.json')));
});

test('Claude project scope writes settings.local.json, keeps it git-ignored and uses --dialect auto shell strings', () => {
  const root = makeRepo();
  const { home, env } = freshHome();
  const r = hooksRender.renderHooks({ host: 'claude', scope: 'project', level: 'gate', skillDir: SKILL, home, env, root });
  const w = hooksRender.writeHooks(r, { root });
  assert.equal(w.target_file, core.toPosix(path.join(root, '.claude', 'settings.local.json')));
  assert.equal(git(root, 'status', '--porcelain'), '');
  const h = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.local.json'), 'utf8')).hooks.Stop[0].hooks[0];
  assert.equal(h.args, undefined);
  assert.match(h.command, /^node ".*\/scripts\/adc\.mjs" hook-run stop --dialect auto --level gate$/);
  // Copilot runs this file too and ignores `if` (measured): the guard's Bash handlers collapse into one.
  const g = hooksRender.renderHooks({ host: 'claude', scope: 'project', level: 'guard', skillDir: SKILL, home, env, root }).config.hooks.PreToolUse;
  const bash = g.find((x) => x.matcher === 'Bash');
  assert.equal(bash.hooks.length, 1);
  assert.equal(bash.hooks[0].if, undefined);
  assert.match(bash.hooks[0].command, /hook-run pre-guard --dialect auto --level guard$/);
  const user = hooksRender.renderHooks({ host: 'claude', level: 'guard', skillDir: SKILL, home, env }).config.hooks.PreToolUse.find((x) => x.matcher === 'Bash');
  assert.deepEqual(user.hooks.map((x) => x.if), ['Bash(git *)', 'Bash(*.adc*)', 'Bash(*.env.live*)', 'Bash(rm *)']);
});

test('listRegisteredHooks reports host, scope, level and drift; removeHooks deletes exactly our entries', () => {
  const root = makeRepo();
  const { home, env } = freshHome();
  const vend = path.join(root, '.github', 'skills', 'agentic-developer-companion');
  fs.mkdirSync(path.join(vend, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(vend, 'scripts', 'adc.mjs'), '');
  hooksRender.writeHooks(hooksRender.renderHooks({ host: 'copilot', level: 'gate', skillDir: SKILL, home, env, root }), { root });
  hooksRender.writeHooks(hooksRender.renderHooks({ host: 'codex', level: 'guard', skillDir: SKILL, home, env, root }), { root });
  hooksRender.writeHooks(hooksRender.renderHooks({ host: 'copilot-cloud', skillDir: vend, home, env, root }), { root });
  let list = hooksRender.listRegisteredHooks({ root, home, env, skillDir: SKILL });
  const by = (h) => list.find((x) => x.host === h);
  assert.equal(by('copilot').level, 'gate');
  assert.equal(by('copilot').matches_current, true);
  assert.equal(by('codex').level, 'guard');
  assert.ok(by('codex').handlers.includes('pre-guard'));
  assert.equal(by('copilot-cloud').scope, 'project');
  assert.deepEqual(by('copilot-cloud').skill_paths, ['.github/skills/agentic-developer-companion']);
  assert.equal(by('copilot-cloud').matches_current, true);
  assert.equal(by('copilot-cloud').this_copy, false, 'the vendored copy is not the running one');
  assert.equal(by('copilot').this_copy, true);
  assert.ok(list.every((x) => x.recorded && x.present));
  // Drift: an edited command no longer matches the current render.
  const cfile = path.join(home, '.copilot', 'hooks', 'agentic-developer-companion.json');
  const c = JSON.parse(fs.readFileSync(cfile, 'utf8'));
  c.hooks.sessionStart[0].bash = c.hooks.sessionStart[0].bash.replace('session-start', 'session-start ');
  fs.writeFileSync(cfile, JSON.stringify(c));
  list = hooksRender.listRegisteredHooks({ root, home, env, skillDir: SKILL });
  assert.equal(by('copilot').matches_current, false);
  // Remove one host; the others stay.
  const xfile = path.join(home, '.codex', 'hooks.json');
  const x = JSON.parse(fs.readFileSync(xfile, 'utf8'));
  x.hooks.Stop.push({ hooks: [{ type: 'command', command: 'notify-me' }] });
  fs.writeFileSync(xfile, JSON.stringify(x));
  const rm = hooksRender.removeHooks({ host: 'codex', root, home, env });
  assert.equal(rm.source, 'record');
  assert.equal(rm.removed[0].entries, 6);
  assert.equal(rm.removed[0].deleted_file, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(xfile, 'utf8')).hooks, { Stop: [{ hooks: [{ type: 'command', command: 'notify-me' }] }] });
  list = hooksRender.listRegisteredHooks({ root, home, env, skillDir: SKILL });
  assert.equal(list.filter((l) => l.host === 'codex').length, 0);
  // Remove everything; our dedicated Copilot file is deleted.
  const all = hooksRender.removeHooks({ root, home, env });
  assert.ok(all.removed.some((r) => r.file.endsWith('agentic-developer-companion.json') && r.deleted_file));
  assert.ok(!fs.existsSync(cfile));
  assert.deepEqual(hooksRender.listRegisteredHooks({ root, home, env, skillDir: SKILL }), []);
  assert.deepEqual(core.readJson(path.join(root, '.adc', 'hooks-installed.json')).entries, []);
});

test('removeHooks without a record scans the host files for adc.mjs hook-run entries', () => {
  const { home, env } = freshHome();
  const file = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const r = hooksRender.renderHooks({ host: 'claude', skillDir: '/elsewhere/agentic-developer-companion', home, env });
  fs.writeFileSync(file, JSON.stringify({ model: 'opus', hooks: r.config.hooks }));
  const res = hooksRender.removeHooks({ host: 'claude', home, env });
  assert.equal(res.source, 'scan');
  assert.equal(res.removed[0].entries, 5);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { model: 'opus' });
});

// ---------------------------------------------------------------------------
// CLI end to end

function cli(args, { env = {}, cwd } = {}) {
  const r = spawnSync(process.execPath, [ADC, ...args], { encoding: 'utf8', env: baseEnv(env), cwd });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch {}
  return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
}

test('CLI: hooks render, setup hooks --write, headless refusal, list and --remove', () => {
  const repo = makeRepo();
  const { home } = freshHome();
  const env = { HOME: home, USERPROFILE: home };
  let r = cli(['hooks', 'render', '--host', 'copilot', '--json', '--cwd', repo], { env });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.json.config.hooks.sessionStart[0].powershell);
  assert.equal(r.json.written, false);
  assert.ok(/^[\x00-\x7e]*$/.test(r.stdout));
  r = cli(['setup', 'hooks', '--host', 'codex', '--write', '--dry-run', '--json', '--cwd', repo], { env });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.written, false);
  assert.ok(r.json.would_write.hooks.SessionStart);
  assert.ok(!fs.existsSync(path.join(home, '.codex', 'hooks.json')));
  r = cli(['setup', 'hooks', '--host', 'codex', '--level', 'gate', '--write', '--json', '--cwd', repo], { env });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.written, true);
  assert.ok(fs.existsSync(path.join(home, '.codex', 'hooks.json')));
  r = cli(['setup', 'hooks', '--host', 'claude', '--write', '--json', '--cwd', repo], { env: { ...env, CI: 'true' } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.written, false);
  assert.match(r.json.refused, /headless hosts: print only/);
  assert.ok(!fs.existsSync(path.join(home, '.claude', 'settings.json')));
  r = cli(['hooks', 'list', '--json', '--cwd', repo], { env });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json.hooks.map((h) => `${h.host}:${h.level}`), ['codex:gate']);
  r = cli(['setup', 'hooks', '--remove', '--json', '--cwd', repo], { env: { ...env, GITHUB_ACTIONS: 'true' } });
  assert.match(r.json.refused, /print only/);
  assert.ok(fs.existsSync(path.join(home, '.codex', 'hooks.json')));
  r = cli(['setup', 'hooks', '--remove', '--json', '--cwd', repo], { env });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.removed.length, 1);
  assert.ok(!fs.existsSync(path.join(home, '.codex', 'hooks.json')));
});

test('CLI: usage errors exit 2 with a JSON error; the host is guessed from the environment', () => {
  const repo = makeRepo();
  let r = cli(['hooks', 'render', '--host', 'cursor', '--json', '--cwd', repo]);
  assert.equal(r.code, 2);
  assert.equal(r.json.error.code, 'USAGE');
  r = cli(['hooks', 'render', '--json', '--cwd', repo]);
  assert.equal(r.code, 2);
  assert.match(r.json.error.message, /--host/);
  r = cli(['hooks', 'render', '--json', '--cwd', repo], { env: { CLAUDECODE: '1' } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.host, 'claude');
  r = cli(['hooks', 'render', '--host', 'claude', '--scope', 'project', '--json', '--cwd', fs.realpathSync(tmp('adc-norepo-'))]);
  assert.equal(r.code, 3);
  r = cli(['hooks', 'bogus', '--json', '--cwd', repo]);
  assert.equal(r.code, 2);
  r = cli(['hooks', 'render', '--host', 'copilot', '--node-path', '--json', '--cwd', repo]);
  assert.equal(r.json.node, core.toPosix(process.execPath));
});

const CLAUDE = core.which('claude');

test('rendered Claude hooks pass Claude Code\'s own hook validation (claude plugin validate, local and free)', { skip: CLAUDE ? false : 'claude not installed', timeout: 60_000 }, () => {
  for (const [scope, level] of [['user', 'advise'], ['user', 'guard'], ['project', 'gate']]) {
    const dir = path.join(tmp('adc-claude-validate-'), 'adc-hooks-probe');
    fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'adc-hooks-probe', version: '0.0.1', description: 'hook validation probe' }));
    const r = hooksRender.renderHooks({ host: 'claude', scope, level, skillDir: SKILL, root: scope === 'project' ? makeRepo() : null, home: HOME, env: {} });
    fs.writeFileSync(path.join(dir, 'hooks', 'hooks.json'), JSON.stringify({ description: 'probe', hooks: r.config.hooks }));
    const res = spawnSync(CLAUDE, ['plugin', 'validate', dir, '--json'], { encoding: 'utf8', env: baseEnv(), timeout: 50_000 });
    const out = JSON.parse(res.stdout);
    const hooksReport = (out.contents || []).filter((c) => c.type === 'hooks');
    const problems = hooksReport.flatMap((c) => [...(c.errors || []), ...(c.warnings || [])]);
    assert.deepEqual(problems, [], `${scope}/${level}: ${JSON.stringify(problems)}`);
    assert.equal(out.success, true, `${scope}/${level}: ${res.stdout.slice(0, 500)}`);
  }
});
