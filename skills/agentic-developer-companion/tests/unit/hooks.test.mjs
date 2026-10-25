// Tests for the hooks: dialect detection and output shapes (hook-dialects.mjs), the handlers driven
// by the fixture files through `adc.mjs hook-run` (directly and through the rendered pwsh / sh /
// exec-form launchers), fail-open behavior with missing, crashing and too-old Node, rendering
// snapshots, and registration (merge, backup, record, list, remove) including the CLI.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import * as core from '../../scripts/lib/core.mjs';
import * as state from '../../scripts/lib/state.mjs';
import * as dialects from '../../scripts/lib/hook-dialects.mjs';
import * as hookRun from '../../scripts/lib/hook-run.mjs';
import * as hooksRender from '../../scripts/lib/hooks-render.mjs';

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
  return fs.realpathSync(dir);
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
  assert.deepEqual(content, [{ path: 'a.js', op: 'update', text: 'one\ntwo' }]);
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

test('shell parsing, observed-run classes and runner summary lines', () => {
  assert.deepEqual(hookRun.splitShell('cd a && git push -f || echo "x; y" ; ls | wc -l 2>&1'), [['cd', 'a'], ['git', 'push', '-f'], ['echo', 'x; y'], ['ls'], ['wc', '-l', '2>&1']]);
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
  const s = hookRun.fallbackSummary;
  assert.deepEqual(s('Tests:       1 failed, 2 skipped, 3 passed, 6 total'), { runner: 'jest', passed: 3, failed: 1, skipped: 2 });
  assert.deepEqual(s(' Test Files  1 passed (1)\n      Tests  4 passed | 1 skipped (5)'), { runner: 'vitest', passed: 4, failed: 0, skipped: 1 });
  assert.deepEqual(s('==== 2 failed, 5 passed, 1 skipped in 1.20s ===='), { runner: 'pytest', passed: 5, failed: 2, skipped: 1 });
  assert.deepEqual(s('test result: ok. 3 passed; 0 failed; 1 ignored\ntest result: FAILED. 1 passed; 2 failed; 0 ignored'), { runner: 'cargo', passed: 4, failed: 2, skipped: 1 });
  assert.deepEqual(s('Passed!  - Failed:     0, Passed:    12, Skipped:     1, Total:    13'), { runner: 'dotnet', passed: 12, failed: 0, skipped: 1 });
  assert.deepEqual(s('10 examples, 2 failures, 1 pending'), { runner: 'rspec', passed: 7, failed: 2, skipped: 1 });
  assert.deepEqual(s('Tests run: 9, Failures: 1, Errors: 1, Skipped: 2'), { runner: 'surefire', passed: 5, failed: 2, skipped: 2 });
  assert.deepEqual(s('# pass 4\n# fail 1\n# skipped 0'), { runner: 'node-test', passed: 4, failed: 1, skipped: 0 });
  assert.deepEqual(s('  5 passing (20ms)\n  1 failing'), { runner: 'mocha', passed: 5, failed: 1, skipped: 0 });
  assert.deepEqual(s('--- PASS: TestA (0.00s)\n--- FAIL: TestB (0.00s)\nFAIL\tpkg\t0.01s'), { runner: 'go', passed: 1, failed: 2, skipped: 0 });
  assert.equal(s('nothing here'), null);
});

test('scanCatalog reports line numbers, honors patch line maps and multi-line patterns', () => {
  const hits = hookRun.scanCatalog('a\ntry { x() } catch (e) {\n}\nit.only(1)', [{ id: 'empty-catch', re: /catch\s*(?:\([^)]*\))?\s*\{\s*\}/ }, { id: 'only', re: '\\bit\\.only\\(' }]);
  assert.deepEqual(hits.map((h) => [h.id, h.line]), [['empty-catch', 2], ['only', 4]]);
  assert.deepEqual(hookRun.scanCatalog('x\nit.only(1)', [{ id: 'only', re: /it\.only/ }], [10, 12]).map((h) => h.line), [12]);
});

test('findRepo resolves linked worktrees, and the exclude entry lands in the common git dir', () => {
  const repo = makeRepo();
  const wt = path.join(tmp('adc-wt-'), 'wt');
  git(repo, 'worktree', 'add', '-q', wt, 'HEAD');
  const found = hookRun.findRepo(path.join(wt));
  assert.equal(found.root, fs.realpathSync(wt));
  assert.equal(fs.realpathSync(found.commonDir), fs.realpathSync(path.join(repo, '.git')));
  const info = hookRun.hookStateInfo(found, { env: {} });
  assert.equal(hookRun.ensureHookState(info, found), true);
  fs.writeFileSync(path.join(wt, '.adc', 'probe'), 'x');
  assert.equal(spawnSync('git', ['check-ignore', '-q', '.adc/probe'], { cwd: wt }).status, 0);
  assert.equal(hookRun.findRepo(path.join(wt, 'missing', 'dir')), null);
  assert.equal(hookRun.findRepo(path.join(repo, 'README.md')).root, repo);
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

// ---------------------------------------------------------------------------
// Fixture cases through adc.mjs hook-run

const FIXTURE_FILES = ['copilot-camel', 'copilot-pascal', 'copilot-cloud', 'claude', 'codex'];
const NO_GIT_ROOT = hookRun.findRepo(os.tmpdir()) == null;

for (const file of FIXTURE_FILES) {
  for (const c of loadFixtures(file)) {
    const skip = c.setup && c.setup.no_git && !NO_GIT_ROOT ? 'the OS temp dir is inside a git work tree' : false;
    test(`fixture ${file}: ${c.name}`, { skip }, () => runCase(c, 'direct'));
  }
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

const copilotOnly = (c) => [c, ...(c.then || [])].every((s) => (s.dialect_arg || c.dialect_arg) === 'copilot');
const claudeOnly = (c) => [c, ...(c.then || [])].every((s) => (s.dialect_arg || c.dialect_arg) === 'claude');
const codexOnly = (c) => [c, ...(c.then || [])].every((s) => (s.dialect_arg || c.dialect_arg) === 'codex');

test('fixtures through the rendered Copilot powershell strings (pwsh -NoProfile -Command)', { skip: PWSH ? false : 'pwsh not installed', timeout: 240_000 }, async () => {
  let n = 0;
  for (const f of ['copilot-camel', 'copilot-pascal', 'copilot-cloud']) n += await viaLauncher(f, 'copilot-pwsh', copilotOnly);
  assert.ok(n > 50);
});

test('fixtures through the rendered Copilot bash strings (bash -c)', { skip: BASH ? false : 'bash not available', timeout: 120_000 }, async () => {
  for (const f of ['copilot-camel', 'copilot-pascal', 'copilot-cloud']) await viaLauncher(f, 'copilot-bash', copilotOnly);
});

test('fixtures through the rendered Codex command (sh -c) and commandWindows (pwsh -Command)', { timeout: 180_000 }, async (t) => {
  if (SH) await viaLauncher('codex', 'codex-sh', codexOnly);
  if (PWSH) await viaLauncher('codex', 'codex-pwsh', codexOnly);
  if (!SH && !PWSH) t.skip('no sh or pwsh');
});

test('fixtures through the rendered Claude user-scope exec form (command + args, no shell)', { timeout: 120_000 }, async () => {
  await viaLauncher('claude', 'claude-exec', claudeOnly);
});

test('fixtures through the Claude project-scope shell form (--dialect auto) under sh and pwsh', { timeout: 180_000 }, async (t) => {
  if (SH) await viaLauncher('claude', 'claude-shell-sh', claudeOnly);
  if (PWSH) await viaLauncher('claude', 'claude-shell-pwsh', claudeOnly);
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
  const r = hooksRender.renderHooks({ host, scope: opts.scope || null, level: opts.level || 'advise', nodePath: opts.nodePath || null, skillDir, root, home: SNAP_HOME, env: {} });
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
  assert.equal(hooksRender.guessHost({ COPILOT_CLI: '1' }), 'copilot');
  assert.equal(hooksRender.guessHost({ CLAUDECODE: '1' }), 'claude');
  assert.equal(hooksRender.guessHost({ CODEX_SANDBOX: 'seatbelt' }), 'codex');
  assert.equal(hooksRender.guessHost({ COPILOT_AGENT_PROMPT: 'x' }), 'copilot-cloud');
  assert.equal(hooksRender.guessHost({}), null);
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
  assert.equal(data.hooks.PreToolUse.length, 3);
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
