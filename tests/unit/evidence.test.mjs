// Unit and end-to-end tests for scripts/lib/evidence.mjs, trace.mjs and verify.mjs (WP-E).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as core from '../../skills/agentic-developer-companion/scripts/lib/core.mjs';
import * as ev from '../../skills/agentic-developer-companion/scripts/lib/evidence.mjs';
import * as tr from '../../skills/agentic-developer-companion/scripts/lib/trace.mjs';
import * as vf from '../../skills/agentic-developer-companion/scripts/lib/verify.mjs';

const ADC = core.ADC_SCRIPT;
delete process.env.ADC_HOME;

function makeRepo(files = {}, { commit = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adc-ev-'));
  const g = (...args) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout;
  };
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 'Test');
  g('config', 'commit.gpgsign', 'false');
  write(dir, files);
  if (commit) { g('add', '-A'); g('commit', '-q', '-m', 'init', '--allow-empty'); }
  return { dir, g };
}

function write(dir, files) {
  for (const [p, c] of Object.entries(files)) {
    if (c === null) { fs.rmSync(path.join(dir, p), { force: true }); continue; }
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), c);
  }
}

const cliEnv = () => {
  const env = { ...process.env };
  for (const k of ['ADC_HOME', 'ADC_LIVE_TOKEN', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'COPILOT_CLI', 'COPILOT_AGENT_PROMPT', 'GITHUB_COPILOT_API_TOKEN', 'CODEX_SANDBOX', 'CODEX_THREAD_ID']) delete env[k];
  return env;
};

function adc(args, { cwd, input, env } = {}) {
  const r = spawnSync(process.execPath, [ADC, ...args, '--json', ...(cwd ? ['--cwd', cwd] : [])], {
    encoding: 'utf8', input: input ?? '', env: { ...cliEnv(), ...(env || {}) }, timeout: 60_000,
  });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch {}
  return { status: r.status, json, stdout: r.stdout, stderr: r.stderr };
}

const ck = (id, status, extra = {}) => ({ id, status, summary: `${id} ${status}`, ...extra });

// A pure in-memory ledger for deriveVerdict tests.
function mem(checks, { waivers = [], claims = [] } = {}) {
  let seq = 0;
  const norm = (c) => ({ project: '.', reason: null, findings: [], data: {}, source: 'verify', ...c, seq: ++seq });
  return { checks: checks.map(norm), waivers: waivers.map((w) => ({ file: null, ...w, seq: ++seq })), claims: claims.map((c) => ({ ...c, seq: ++seq })) };
}

async function ledgerWith(dir, checks = [], { specText = null } = {}) {
  const ctx = core.makeContext({ cwd: dir });
  const target = await ev.prepareQaTarget(ctx);
  const { path: file } = await ev.initLedger({ target, tool: 'unknown', mode: 'verify', spec: specText ? 'SPEC.md' : null, specText });
  if (checks.length) await ev.addChecks(file, checks, { source: 'verify', root: target.root });
  return { file, target, ctx };
}

const readLedger = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const AWS_KEY = () => ['AKIA', 'IOSFODNN7', 'EXAMPLE'].join('');

// ---------------------------------------------------------------------------
// Host identity, hashing, normalization

test('detectTool maps host environment markers', () => {
  assert.equal(ev.detectTool({}), 'unknown');
  assert.equal(ev.detectTool({ CLAUDECODE: '1' }), 'claude-code');
  assert.equal(ev.detectTool({ CLAUDECODE: '0' }), 'unknown');
  assert.equal(ev.detectTool({ COPILOT_CLI: '1' }), 'copilot-cli');
  assert.equal(ev.detectTool({ COPILOT_AGENT_PROMPT: 'x', CLAUDECODE: '1' }), 'copilot-cloud');
  assert.equal(ev.detectTool({ CODEX_SANDBOX: 'seatbelt' }), 'codex');
  assert.equal(ev.detectTool({ CODEX_THREAD_ID: 'abc' }), 'codex');
  assert.equal(ev.detectTool({ TERM_PROGRAM: 'vscode' }), 'vscode');
});

test('canonicalJson is key-order independent and stable across a JSON round trip', () => {
  const a = { b: [1, { y: 2, x: 'é' }], a: null, c: undefined };
  const b = { a: null, b: [1, { x: 'é', y: 2 }] };
  assert.equal(ev.canonicalJson(a), ev.canonicalJson(b));
  assert.equal(ev.canonicalJson(JSON.parse(core.asciiJson(a))), ev.canonicalJson(a));
});

test('normalizeCheck validates input strictly and degrades script output', () => {
  assert.throws(() => ev.normalizeCheck({ id: 'nope', status: 'pass' }, { strict: true }), (e) => e.exit === 2);
  assert.throws(() => ev.normalizeCheck({ id: 'CK-X', status: 'great' }, { strict: true }), (e) => e.exit === 2);
  const c = ev.normalizeCheck({ id: 'ck-skip', status: 'weird', findings: Array.from({ length: 250 }, (_, i) => ({ file: `a\\b${i}.js`, line: '3', message: 'm' })) });
  assert.equal(c.id, 'CK-SKIP');
  assert.equal(c.status, 'unverified');
  assert.match(c.reason, /^BAD_STATUS/);
  assert.deepEqual(c.fm, ['FM-01']);
  assert.equal(c.findings.length, 200);
  assert.equal(c.findings_truncated, 50);
  assert.equal(c.findings[0].file, 'a/b0.js');
  assert.equal(c.findings[0].line, 3);
  const big = ev.normalizeCheck({ id: 'CK-A', status: 'pass', data: { blob: 'x'.repeat(300_000) } });
  assert.equal(big.data.truncated, true);
});

test('createQaSnapshot sees same-tick edits (racy git) and works with an ignored .adc/', () => {
  for (let i = 0; i < 8; i++) {
    const { dir, g } = makeRepo({ 'a.js': 'x\n' });
    fs.writeFileSync(path.join(dir, 'a.js'), 'y\n');
    write(dir, { '.adc/.env.live': 'ADC_LIVE_TOKEN\n', 'u.txt': 'untracked\n' });
    fs.appendFileSync(path.join(dir, '.git', 'info', 'exclude'), '/.adc/\n');
    core.sleepSync(40);
    const before = g('status', '--porcelain');
    const snap = ev.createQaSnapshot(dir, { exclude: ['.adc'] });
    assert.equal(g('cat-file', 'blob', `${snap.tree}:a.js`), 'y\n', 'a same-size edit right after the commit is in the snapshot');
    assert.deepEqual(g('ls-tree', '-r', '--name-only', snap.tree).trim().split('\n'), ['a.js', 'u.txt']);
    assert.equal(g('status', '--porcelain'), before);
  }
});

// ---------------------------------------------------------------------------
// Verdict rules (pure)

test('verdict: PASS needs a clean run; FAIL beats UNVERIFIED; UNVERIFIED is never upgraded', () => {
  assert.equal(ev.deriveVerdict(mem([ck('CK-SCOPE', 'pass'), ck('CK-CLEANRUN', 'pass')])).verdict, 'PASS');
  const noRun = ev.deriveVerdict(mem([ck('CK-SCOPE', 'pass')]));
  assert.equal(noRun.verdict, 'UNVERIFIED');
  assert.ok(noRun.reasons.some((r) => /CK-CLEANRUN missing/.test(r)));
  assert.equal(ev.deriveVerdict(mem([ck('CK-SKIP', 'fail'), ck('CK-CLEANRUN', 'unverified')])).verdict, 'FAIL');
  const upgraded = ev.deriveVerdict(mem([ck('CK-CLEANRUN', 'unverified', { reason: 'NO_RUNNER' }), ck('CK-CLEANRUN', 'pass', { source: 'input' })]));
  assert.equal(upgraded.verdict, 'UNVERIFIED');
  assert.equal(ev.deriveVerdict(mem([ck('CK-CLEANRUN', 'pass'), ck('CK-TYPES', 'pass-with-baseline')])).verdict, 'PASS');
  assert.equal(ev.verdictExit('FAIL'), 1);
  assert.equal(ev.verdictExit('UNVERIFIED'), 4);
  assert.equal(ev.verdictExit('PASS-WITH-FINDINGS'), 0);
});

test('verdict: soft and optional checks never fail or block on their own', () => {
  assert.equal(ev.deriveVerdict(mem([ck('CK-CLEANRUN', 'pass'), ck('CK-COVERAGE', 'fail')])).verdict, 'PASS-WITH-FINDINGS');
  assert.equal(ev.deriveVerdict(mem([ck('CK-CLEANRUN', 'pass'), ck('CK-COVERAGE', 'fail', { data: { hard: true } })])).verdict, 'FAIL');
  assert.equal(ev.deriveVerdict(mem([ck('CK-CLEANRUN', 'pass'), ck('CK-MUTATION', 'unverified', { reason: 'NO_TOOL' })])).verdict, 'PASS');
  assert.equal(ev.deriveVerdict(mem([ck('CK-CLEANRUN', 'pass'), ck('CK-SCOPE', 'finding')])).verdict, 'PASS-WITH-FINDINGS');
  assert.equal(ev.deriveVerdict(mem([ck('CK-CLEANRUN', 'pass'), ck('CK-SUPPRESS', 'fail')])).verdict, 'FAIL');
});

test('verdict: pending model steps, superseding entries and review confirmation', () => {
  const pendingTrace = mem([ck('CK-CLEANRUN', 'pass'), ck('CK-TRACE', 'unverified', { pending: true, reason: 'AWAITING_MATRIX' })]);
  assert.equal(ev.deriveVerdict(pendingTrace).verdict, 'UNVERIFIED');
  const done = mem([ck('CK-CLEANRUN', 'pass'), ck('CK-TRACE', 'unverified', { pending: true }), ck('CK-TRACE', 'pass', { source: 'input' })]);
  assert.equal(ev.deriveVerdict(done).verdict, 'PASS');
  const review = mem([ck('CK-CLEANRUN', 'pass'), ck('CK-REVIEW', 'unverified', { pending: true })]);
  assert.equal(ev.deriveVerdict(review).verdict, 'PASS');
  const critical = mem([ck('CK-CLEANRUN', 'pass'), ck('CK-REVIEW', 'unverified', { pending: true }), ck('CK-REVIEW', 'fail', { source: 'input' })]);
  const d = ev.deriveVerdict(critical);
  assert.equal(d.verdict, 'PASS-WITH-FINDINGS');
  assert.equal(d.needs_human_triage, true);
  const confirmed = mem([ck('CK-CLEANRUN', 'pass'), ck('CK-REVIEW', 'fail', { source: 'input' }),
    ck('CK-REVIEW', 'fail', { source: 'run', exit_code: 1, data: { repro: true, confirmed: true } })]);
  assert.equal(ev.deriveVerdict(confirmed).verdict, 'FAIL');
  const forged = mem([ck('CK-CLEANRUN', 'pass'), ck('CK-REVIEW', 'fail', { source: 'input', exit_code: 1, data: { confirmed: true } })]);
  assert.equal(ev.deriveVerdict(forged).verdict, 'PASS-WITH-FINDINGS', 'only a command run by the script confirms a critical');
});

test('verdict: waivers cover findings by file, cap at PASS-WITH-FINDINGS, and never excuse facts', () => {
  const del = (files) => ck('CK-TEST-DEL', 'fail', { findings: files.map((f) => ({ id: 'CK-TEST-DEL', severity: 'fail', file: f, line: null, message: 'deleted' })) });
  const one = mem([ck('CK-CLEANRUN', 'pass'), del(['a.test.js'])], { waivers: [{ check: 'CK-TEST-DEL', file: 'a.test.js', reason: 'spec' }] });
  const d = ev.deriveVerdict(one);
  assert.equal(d.verdict, 'PASS-WITH-FINDINGS');
  assert.equal(d.effective.find((r) => r.id === 'CK-TEST-DEL').effective, 'waived');
  const partial = mem([ck('CK-CLEANRUN', 'pass'), del(['a.test.js', 'b.test.js'])], { waivers: [{ check: 'CK-TEST-DEL', file: 'a.test.js', reason: 'spec' }] });
  assert.equal(ev.deriveVerdict(partial).verdict, 'FAIL');
  const secret = mem([ck('CK-CLEANRUN', 'pass'), ck('CK-SECRETS', 'fail')], { waivers: [{ check: 'CK-SECRETS', reason: 'spec' }] });
  assert.equal(ev.deriveVerdict(secret).verdict, 'FAIL');
});

test('verdict: clean-run count shortfall explained by waived deletions; skip increase escalates with CK-SKIP', () => {
  const del = ck('CK-TEST-DEL', 'fail', { findings: [{ id: 'CK-TEST-DEL', severity: 'fail', file: 'old.test.js', message: 'deleted' }] });
  const short = ck('CK-CLEANRUN', 'fail', { reason: 'COUNT_SHORTFALL', data: { run: { executed: 8, failed: 0, errors: 0 }, delta: { executed: -2 } } });
  const w = [{ check: 'CK-TEST-DEL', file: 'old.test.js', reason: 'spec' }];
  assert.equal(ev.deriveVerdict(mem([del, short], { waivers: w })).verdict, 'PASS-WITH-FINDINGS');
  const failing = ck('CK-CLEANRUN', 'fail', { data: { run: { executed: 8, failed: 1, errors: 0 }, delta: { executed: -2 } } });
  assert.equal(ev.deriveVerdict(mem([del, failing], { waivers: w })).verdict, 'FAIL');
  const skipped = ck('CK-CLEANRUN', 'finding', { data: { delta: { skipped: 2 } } });
  const d = ev.deriveVerdict(mem([skipped, ck('CK-SKIP', 'fail')]));
  assert.equal(d.effective.find((r) => r.id === 'CK-CLEANRUN').effective, 'fail');
});

test('claims: supported, contradicted, unsupported; flaky runs never support "tests pass"', () => {
  const claims = [{ text: 'All tests pass', evidence: ['CK-CLEANRUN'] }, { text: 'No type errors', evidence: ['CK-TYPES'] }, { text: 'Refactored', evidence: [] }];
  let d = ev.deriveVerdict(mem([ck('CK-CLEANRUN', 'pass'), ck('CK-TYPES', 'fail')], { claims }));
  assert.deepEqual(d.claims.map((c) => c.status), ['supported', 'contradicted', 'unsupported']);
  assert.equal(d.effective.find((r) => r.id === 'CK-CLAIMS').effective, 'fail');
  d = ev.deriveVerdict(mem([ck('CK-CLEANRUN', 'pass', { data: { run: { flaky: 1 } } }), ck('CK-TYPES', 'pass')], { claims: claims.slice(0, 1) }));
  assert.equal(d.claims[0].status, 'unsupported');
  assert.equal(d.verdict, 'PASS-WITH-FINDINGS');
  d = ev.deriveVerdict(mem([ck('CK-CLEANRUN', 'pass')], { claims: [{ text: 'All tests pass', evidence: ['CK-CLEANRUN'] }] }));
  assert.equal(d.verdict, 'PASS');
});

test('claims: text is split into claim sentences and mapped by keywords', () => {
  const parsed = ev.parseClaims('Summary:\n- Implemented the rate limiter.\n- All tests pass and the build compiles cleanly.\n- Thanks!\r\n');
  assert.deepEqual(parsed.map((c) => c.text), ['Implemented the rate limiter.', 'All tests pass and the build compiles cleanly.']);
  assert.deepEqual(ev.mapClaim(parsed[1].text), ['CK-CLEANRUN', 'CK-TYPES']);
  assert.deepEqual(ev.mapClaim('Implemented the rate limiter'), ['CK-TRACE']);
  assert.deepEqual(ev.mapClaim('No tests were deleted'), ['CK-TEST-DEL', 'CK-SKIP']);
  assert.deepEqual(ev.parseClaims('[{"text":"x works","evidence":["CK-LIVE"],"status":"supported"}]'), [{ text: 'x works', evidence: ['CK-LIVE'] }]);
  assert.equal(ev.parseClaims('just words').length, 1);
});

// ---------------------------------------------------------------------------
// Ledger files: integrity, staleness, finalize, redaction

test('ledger: entries are chained; edits, removals and artifact changes are refused at finalize', async () => {
  const { dir } = makeRepo({ 'a.txt': 'a\n' });
  const art = path.join(dir, '.adc', 'cache', 'runs', 'r1', 'run.log');
  const { file, target } = await ledgerWith(dir, []);
  write(dir, { '.adc/cache/runs/r1/run.log': 'log\n' });
  await ev.addChecks(file, [ck('CK-CLEANRUN', 'pass', { artifacts: ['.adc/cache/runs/r1/run.log'] }), ck('CK-SKIP', 'fail'), ck('CK-SCOPE', 'pass')], { source: 'verify', root: dir });
  const pristine = fs.readFileSync(file, 'utf8');
  assert.equal(ev.verifyIntegrity(readLedger(file), { root: dir }).ok, true);
  assert.ok(fs.existsSync(ev.markdownPath(file)));

  const tamper = (mutate) => { const l = JSON.parse(pristine); mutate(l); fs.writeFileSync(file, JSON.stringify(l)); };
  const kinds = () => ev.verifyIntegrity(readLedger(file), { root: dir }).problems.map((p) => p.kind);
  tamper((l) => { l.checks.find((c) => c.id === 'CK-SKIP').status = 'pass'; });
  assert.ok(kinds().includes('entry'));
  await assert.rejects(ev.finalizeLedger(file, { target }), (e) => e.exit === 4 && e.code === 'LEDGER_TAMPERED');
  tamper((l) => { l.checks.splice(l.checks.findIndex((c) => c.id === 'CK-SKIP'), 1); });
  assert.ok(kinds().includes('chain'));
  tamper((l) => { l.checks.pop(); });
  assert.ok(kinds().includes('head') && kinds().includes('count'));
  tamper((l) => { l.tree_digest = '0'.repeat(40); });
  assert.ok(kinds().includes('header') && kinds().includes('tree'));
  fs.writeFileSync(file, pristine);
  fs.writeFileSync(art, 'forged\n');
  assert.ok(kinds().includes('artifact'));
  fs.writeFileSync(art, 'log\n');
  assert.equal(ev.verifyIntegrity(readLedger(file), { root: dir }).ok, true);
});

test('ledger: finalize refuses a stale snapshot, seals, and freezes the ledger', async () => {
  const { dir } = makeRepo({ 'a.txt': 'a\n' });
  write(dir, { 'a.txt': 'changed\n', 'new.txt': 'untracked\n' });
  const { file, ctx } = await ledgerWith(dir, [ck('CK-CLEANRUN', 'pass'), ck('CK-SCOPE', 'pass')]);
  await ev.setClaims(file, 'All tests pass.\n');
  write(dir, { 'new.txt': 'edited after verify\n' });
  const staleTarget = await ev.prepareQaTarget(ctx);
  assert.equal(ev.ledgerStatus({ target: staleTarget }).stale, true);
  await assert.rejects(ev.finalizeLedger(file, { target: staleTarget }), (e) => e.exit === 4 && e.code === 'LEDGER_STALE');
  write(dir, { 'new.txt': 'untracked\n' });
  const target = await ev.prepareQaTarget(ctx);
  const st = ev.ledgerStatus({ target });
  assert.equal(st.stale, false);
  assert.equal(st.integrity.ok, true);
  const res = await ev.finalizeLedger(file, { target });
  assert.equal(res.verdict, 'PASS');
  const l = readLedger(file);
  assert.ok(l.finalized_at && l.integrity.ledger_sha256);
  assert.equal(l.checks.at(-1).id, 'CK-CLAIMS');
  assert.equal(l.checks.at(-1).source, 'derived');
  assert.equal(ev.verifyIntegrity(l, { root: dir }).ok, true);
  await assert.rejects(ev.addChecks(file, [ck('CK-TYPES', 'pass')], { source: 'verify', root: dir }), (e) => e.code === 'LEDGER_FINALIZED');
  l.verdict = 'PASS-WITH-FINDINGS';
  assert.ok(ev.verifyIntegrity(l, { root: dir }).problems.some((p) => p.kind === 'seal'));
  const metrics = fs.readFileSync(path.join(dir, '.adc', 'metrics.jsonl'), 'utf8');
  assert.match(metrics, /"kind":"evidence-finalize"/);
});

test('ledger: input checks are validated; stale input, CK-CLAIMS and matrix-less CK-TRACE are refused', async () => {
  const { dir } = makeRepo({ 'a.txt': 'a\n' });
  const { file } = await ledgerWith(dir, [ck('CK-TRACE', 'unverified', { pending: true })]);
  await assert.rejects(ev.addChecks(file, [ck('CK-CLAIMS', 'pass')], { source: 'input', root: dir }), (e) => e.exit === 2);
  await assert.rejects(ev.addChecks(file, [ck('CK-TRACE', 'pass')], { source: 'input', root: dir }), (e) => e.exit === 2 && /matrix/.test(e.message));
  await assert.rejects(ev.addChecks(file, [ck('CK-X', 'pass')], { source: 'input', root: dir, inputTree: 'f'.repeat(40) }), (e) => e.code === 'STALE_INPUT');
  const { added } = await ev.addChecks(file, [{ ...ck('CK-LINT', 'pass'), pending: true }], { source: 'input', root: dir });
  assert.equal(added[0].pending, undefined, 'input cannot create pending placeholders');
  assert.equal(added[0].source, 'input');
});

test('ledger: secrets and the live token never reach the ledger or its Markdown', async () => {
  const { dir } = makeRepo({ 'a.txt': 'a\n' });
  const token = ['hunter2', 'abcXYZ'].join('');
  const prev = process.env.ADC_LIVE_TOKEN;
  process.env['ADC_LIVE_TOKEN'] = token;
  try {
    const { file } = await ledgerWith(dir, [ck('CK-SECRETS', 'fail', {
      summary: `found ${AWS_KEY()} and ${token}`, findings: [{ severity: 'fail', file: 'x.js', line: 1, message: 'key', evidence: `k=${AWS_KEY()}` }],
    })]);
    await ev.setClaims(file, `Used the token ${token} for the smoke tests.`);
    const json = fs.readFileSync(file, 'utf8');
    const md = fs.readFileSync(ev.markdownPath(file), 'utf8');
    for (const text of [json, md, ev.renderMarkdown(readLedger(file))]) {
      assert.ok(!text.includes(AWS_KEY()), 'AWS-shaped key redacted');
      assert.ok(!text.includes(token), 'ADC_LIVE_TOKEN value redacted');
    }
    assert.match(json, /REDACTED/);
    assert.equal(ev.verifyIntegrity(readLedger(file), { root: dir }).ok, true);
  } finally {
    if (prev === undefined) delete process.env.ADC_LIVE_TOKEN; else process.env.ADC_LIVE_TOKEN = prev;
  }
});

test('waivers must quote the captured spec; without a spec only a terminal may waive', async () => {
  const spec = '# Spec\n\n3. Remove the legacy endpoint and its tests.\n';
  const { dir } = makeRepo({ 'a.txt': 'a\n' });
  const del = ck('CK-TEST-DEL', 'fail', { findings: [{ severity: 'fail', file: 'tests/old.test.js', message: 'deleted' }] });
  const { file } = await ledgerWith(dir, [ck('CK-CLEANRUN', 'pass'), del, ck('CK-SECRETS', 'pass'), ck('CK-TYPES', 'unverified')], { specText: spec });
  await assert.rejects(ev.addWaiver(file, { check: 'CK-TEST-DEL', reason: 'the user said so' }, { root: dir }), /quote the spec/);
  await assert.rejects(ev.addWaiver(file, { check: 'CK-TEST-DEL', reason: "spec: 'delete every test in the repo'" }, { root: dir }), /does not appear/);
  await assert.rejects(ev.addWaiver(file, { check: 'CK-SECRETS', reason: "'remove the legacy endpoint'" }, { root: dir }), /cannot be waived/);
  await assert.rejects(ev.addWaiver(file, { check: 'CK-SKIP', reason: "'remove the legacy endpoint'" }, { root: dir }), /no CK-SKIP entry/);
  await assert.rejects(ev.addWaiver(file, { check: 'CK-TEST-DEL', file: 'tests/other.js', reason: "'remove the legacy endpoint'" }, { root: dir }), /no finding/);
  const { waiver, ledger } = await ev.addWaiver(file, { check: 'CK-TEST-DEL', file: 'tests/old.test.js', reason: "spec 3: 'Remove the legacy  endpoint and its tests'" }, { root: dir });
  assert.equal(waiver.quote_verified, true);
  assert.equal(waiver.by, 'spec-quote');
  assert.equal(ev.deriveVerdict(ledger).effective.find((r) => r.id === 'CK-TEST-DEL').effective, 'waived');

  const other = makeRepo({ 'a.txt': 'a\n' });
  const { file: f2 } = await ledgerWith(other.dir, [ck('CK-CLEANRUN', 'pass'), del, ck('CK-TYPES', 'unverified')]);
  await assert.rejects(ev.addWaiver(f2, { check: 'CK-TEST-DEL', reason: "'whatever reason here'" }, { root: other.dir }), /from a terminal/);
  await assert.rejects(ev.addWaiver(f2, { check: 'CK-TYPES', reason: 'x' }, { root: other.dir }), /cannot be waived/);
  const tty = await ev.addWaiver(f2, { check: 'CK-TEST-DEL', reason: 'approved by the maintainer' }, { root: other.dir, interactive: true });
  assert.equal(tty.waiver.by, 'tty');
});

test('renderMarkdown: verdict, check table, findings, claims, reproduce commands; short form', async () => {
  const l = mem([ck('CK-CLEANRUN', 'pass', { command: 'npm ci && npx vitest run', exit_code: 0 }), ck('CK-SKIP', 'fail', { findings: [{ severity: 'fail', file: 'a.test.js', line: 4, message: 'added it.only', evidence: 'it.only(' }] })],
    { claims: [{ text: 'All | tests pass', evidence: ['CK-CLEANRUN'] }] });
  Object.assign(l, { tree_digest: 'abcdef1234567890', base: '1234567890ab', base_ref: 'main', base_source: 'origin/HEAD', tool: 'codex', mode: 'verify', observed_runs: [], created_at: core.nowIso(), integrity: {} });
  const md = ev.renderMarkdown(l);
  assert.match(md, /## Verification evidence: FAIL \(provisional\)/);
  assert.match(md, /\| CK-SKIP \| \. \| fail \|/);
  assert.match(md, /`a\.test\.js:4`: added it\.only/);
  assert.match(md, /All \\\| tests pass/);
  assert.match(md, /npm ci && npx vitest run {4}# CK-CLEANRUN, exit 0/);
  const short = ev.renderMarkdown(l, { short: true });
  assert.ok(!/### Findings/.test(short) && /### Reproduce/.test(short));
  assert.ok(/^[\x00-\x7e]*$/.test(md), 'ASCII only');
});

// ---------------------------------------------------------------------------
// Answer scoring

test('scoreAnswers rejects uncited answers, honors polarity and validates citations in the snapshot', async () => {
  const { dir } = makeRepo({ 'src/a.js': 'one\ntwo\nthree\n', 'tests/a.test.js': 't\n' });
  const ctx = core.makeContext({ cwd: dir });
  const target = await ev.prepareQaTarget(ctx);
  const r = ev.scoreAnswers({ answers: [
    { id: 'AT-NO-ASSERT', answer: 'no', citation: 'tests/a.test.js:1' },
    { id: 'AT-MOCK-DOMINATED', answer: 'yes', citations: ['tests/a.test.js:1'] },
    { id: 'AT-TAMPER', answer: 'no' },
    { id: 'AT-BEHAVIOR', answer: 'yes', citation: 'src/a.js:9' },
    { id: 'AT-ORDER', answer: 'no', citation: 'src/missing.js:1' },
    { id: 'AT-RETRY', answer: 'unknown' },
    { question: 'Custom question?', answer: 'yes', citation: 'src/a.js:2' },
    { question: 'Custom with polarity?', answer: 'yes', pass_if: 'yes', citation: 'src/a.js:2-3' },
    { id: 'AT-MIRROR', answer: 'maybe', citation: 'src/a.js:1' },
  ] }, { root: dir, tree: target.snapshot.tree });
  const outcome = Object.fromEntries(r.answers.map((a) => [a.id || a.question, a.outcome === 'rejected' ? `rejected:${a.reason}` : a.outcome]));
  assert.deepEqual(outcome, {
    'AT-NO-ASSERT': 'pass', 'AT-MOCK-DOMINATED': 'fail', 'AT-TAMPER': 'rejected:NO_CITATION', 'AT-BEHAVIOR': 'rejected:LINE_OUT_OF_RANGE',
    'AT-ORDER': 'rejected:FILE_NOT_IN_SNAPSHOT', 'AT-RETRY': 'unknown', 'Custom question?': 'rejected:NO_POLARITY',
    'Custom with polarity?': 'pass', 'AT-MIRROR': 'rejected:BAD_ANSWER',
  });
  assert.equal(r.kind, 'audit-tests');
  assert.deepEqual({ p: r.totals.passed, f: r.totals.failed, u: r.totals.unknown, x: r.totals.rejected }, { p: 2, f: 1, u: 1, x: 5 });
  assert.equal(r.totals.score, 0.667);
  assert.equal(r.verdict, 'fail');
  assert.equal(r.check.id, 'CK-MOCK');
  assert.equal(r.check.status, 'finding');
  assert.equal(r.dimensions.mocking.failed, 1);
});

test('scoreAnswers (review): criticals need a citation and a reproduction step', () => {
  const r = ev.scoreAnswers({
    kind: 'review', ready_to_merge: 'No',
    answers: [{ id: 'RV-SPEC', answer: 'yes', citation: 'src/a.js:1' }, { id: 'RV-BUG', answer: 'yes', citation: 'src/a.js:2' }],
    critical: [{ title: 'off by one', citation: 'src/a.js:2', repro: 'node -e "..."' }, { title: 'vague worry', citation: 'nowhere' }],
    minor: [{ title: 'naming', citation: 'src/a.js:3' }],
  });
  assert.equal(r.severity.critical, 1);
  assert.equal(r.severity.rejected_criticals, 1);
  assert.equal(r.severity.important, 1);
  assert.equal(r.check.id, 'CK-REVIEW');
  assert.equal(r.check.status, 'fail');
  assert.equal(r.check.findings[0].file, 'src/a.js');
  assert.equal(r.check.findings[0].line, 2);
  assert.equal(ev.scoreAnswers([]).check.status, 'unverified');
  assert.throws(() => ev.scoreAnswers({ nope: 1 }), (e) => e.exit === 2);
});

// ---------------------------------------------------------------------------
// trace

const SPEC = [
  '# Rate limiter', '', '<!-- template comment: must be ignored -->', 'Users hit the API too often. The limiter must return 429 after 100 requests per minute.',
  'It should be easy to read, I think.', '', '## Acceptance criteria', '- [ ] AC-1: Requests over the limit get `429` with a `Retry-After` header',
  '- [x] Limits are configurable in `config/limits.json`', '1. Counters reset every minute', '', '| ID | Criterion |', '|---|---|', '| AC-4 | Admin users are exempt |', '',
  '## Steps to reproduce', '1. Send 200 requests', '2. Observe no 429', '', '## Out of scope', '- must not touch billing', '', '```js', '// must be ignored too', '```', '',
  'Scenario: burst traffic', '  Given 150 requests in one second', '  Then 50 of them get 429', '', 'Notes:', '- The limiter must log nothing secret.', '',
  '## Background', 'The old limiter must have been removed in v2.', '', '## Implementation hints', '1. A numbered note in a neutral section', '',
].join('\r\n');

test('extractRequirements: checkboxes, sections, keywords, tables, Gherkin; skips fences, comments and excluded sections', () => {
  const reqs = tr.extractRequirements(SPEC);
  const texts = reqs.map((r) => r.text);
  assert.deepEqual(texts, [
    'The limiter must return 429 after 100 requests per minute.',
    'It should be easy to read, I think.',
    'Requests over the limit get `429` with a `Retry-After` header',
    'Limits are configurable in `config/limits.json`',
    'Counters reset every minute',
    'Admin users are exempt',
    'Scenario: burst traffic: Given 150 requests in one second Then 50 of them get 429',
    'A numbered note in a neutral section',
  ]);
  const byText = (t) => reqs.find((r) => r.text.startsWith(t));
  assert.equal(byText('The limiter').strength, 'strong');
  assert.equal(byText('It should').strength, 'weak');
  assert.equal(byText('Requests over').source_id, 'AC-1');
  assert.equal(byText('Admin users').source_id, 'AC-4');
  assert.equal(byText('Admin users').kind, 'table');
  assert.equal(byText('Requests over').kind, 'checkbox');
  assert.equal(byText('Limits are').checked, true);
  assert.equal(byText('Counters').strength, 'strong');
  assert.equal(byText('A numbered').strength, 'weak');
  assert.equal(byText('The limiter').line, 4);
  assert.deepEqual(reqs.map((r) => r.id), reqs.map((_, i) => `R${i + 1}`));
  assert.deepEqual(tr.specPaths(SPEC), ['config/limits.json']);
});

test('parseCitation accepts path:line, ranges, :col and #L forms; rejects absolute and parent paths', () => {
  assert.deepEqual(tr.parseCitation('src/a.ts:12'), { file: 'src/a.ts', start: 12, end: 12 });
  assert.deepEqual(tr.parseCitation('`src/a.ts:12-20`'), { file: 'src/a.ts', start: 12, end: 20 });
  assert.deepEqual(tr.parseCitation('src/a.ts:12:5'), { file: 'src/a.ts', start: 12, end: 12 });
  assert.deepEqual(tr.parseCitation('src/a.ts#L3-L4'), { file: 'src/a.ts', start: 3, end: 4 });
  assert.deepEqual(tr.parseCitation('src\\win\\a.ts:3'), { file: 'src/win/a.ts', start: 3, end: 3 });
  for (const bad of ['/abs/a.ts:1', 'C:/x/a.ts:1', '../a.ts:1', 'a.ts', 'a.ts:0', 'a.ts:5-2', '']) assert.equal(tr.parseCitation(bad), null, bad);
});

async function traceRepo() {
  const { dir, g } = makeRepo({
    'src/limiter.js': 'export function limit() {\n  return 200;\n}\n', 'src/old.js': 'a\nb\nc\nd\n', 'img.bin': Buffer.from([0, 1, 2, 3]),
    'tests/limiter.test.js': "test('x', () => {});\n", 'src/blank.js': 'x\n',
  });
  write(dir, {
    'src/limiter.js': "import fs from 'node:fs';\nexport function limit(n) {\n  return n > 100 ? 429 : 200;\n}\n",
    'src/old.js': 'a\nd\n', 'src/extra.js': 'export const unrelated = true;\n', 'img.bin': Buffer.from([9, 9, 9]),
    'tests/limiter.test.js': "test('x', () => {});\ntest('429 over limit', () => { expect(limit(101)).toBe(429); });\n",
    'src/blank.js': 'x\n\n}\n',
  });
  return { dir, g, target: await ev.prepareQaTarget(core.makeContext({ cwd: dir })) };
}

test('diffHunks: changes, additions, pure deletions and binaries with stable keys', async () => {
  const { dir, target } = await traceRepo();
  const { hunks } = tr.diffHunks(dir, target.base.sha, target.snapshot.commit);
  const keys = hunks.map((h) => `${h.key} ${h.kind}${h.trivial ? ' trivial' : ''}`);
  assert.deepEqual(keys, [
    'img.bin:binary binary', 'src/blank.js:2-3 addition trivial', 'src/extra.js:1-1 addition', 'src/limiter.js:1-3 change',
    'src/old.js:-2 deletion', 'tests/limiter.test.js:2-2 addition',
  ]);
});

test('trace skeleton and matrix evaluation: citations, missing, unknown, dismissals, extras', async () => {
  const { dir, target } = await traceRepo();
  const spec = '## Acceptance criteria\n- Requests over 100 get 429\n- Limits are logged\n\n## Ideas\n1. maybe refactor helpers\n';
  const sk = await tr.trace({ target, specText: spec, specPath: 'SPEC.md' });
  assert.equal(sk.requirements.length, 3);
  assert.equal(sk.requirements[2].strength, 'weak');
  assert.equal(sk.checks[0].status, 'unverified');
  assert.equal(sk.checks[0].pending, true);
  assert.equal(sk.extras.length, 6);
  assert.ok(sk.extras.find((e) => e.key === 'src/limiter.js:1-3').hint.includes('R1'), 'word-overlap hint');
  assert.match(tr.renderTraceMarkdown(sk), /\| R1 \| Requests over 100 get 429 \| unknown \|/);

  const args = { root: dir, base: target.base.sha, commit: target.snapshot.commit, tree: target.snapshot.tree, skeleton: sk };
  const matrix = (reqs, extras = []) => ({ requirements: reqs, extras });
  let r = await tr.evaluateMatrix({ ...args, matrix: matrix([
    { id: 'R1', status: 'implemented', evidence: ['src/limiter.js:3'], tests: ['tests/limiter.test.js:2'] },
    { id: 'R2', status: 'implemented', evidence: ['src/limiter.js:99', 'nope.js:1'] },
    { id: 'R3', status: 'dismissed', note: 'not a requirement' },
  ]) });
  assert.equal(r.status, 'fail');
  assert.equal(r.requirements.find((x) => x.id === 'R2').status, 'missing');
  assert.deepEqual(r.requirements.find((x) => x.id === 'R2').invalid_citations.map((c) => c.reason), ['LINE_OUT_OF_RANGE', 'FILE_NOT_IN_SNAPSHOT']);
  assert.equal(r.requirements.find((x) => x.id === 'R3').status, 'dismissed');

  r = await tr.evaluateMatrix({ ...args, matrix: matrix([{ id: 'R1', status: 'implemented', evidence: ['src/limiter.js:2-3'], tests: ['tests/limiter.test.js:2'] }]) });
  assert.equal(r.status, 'unverified', 'requirements dropped from the skeleton are not judged');
  assert.equal(r.reason, 'TRACE_INCOMPLETE');

  r = await tr.evaluateMatrix({ ...args, matrix: matrix([
    { id: 'R1', status: 'implemented', evidence: ['src/limiter.js:2-3'], tests: ['tests/limiter.test.js:2'] },
    { id: 'R2', status: 'implemented', evidence: ['src/old.js:1-2'] },
    { id: 'R3', status: 'dismissed' },
  ]) });
  assert.equal(r.status, 'finding');
  assert.deepEqual(r.extras.map((e) => e.key), ['img.bin:binary', 'src/extra.js:1-1'], 'unmapped hunks are extra functionality; blank/brace-only hunks are trivial');
  assert.equal(r.counts.untested, 1);

  r = await tr.evaluateMatrix({ ...args, matrix: matrix([
    { id: 'R1', status: 'implemented', evidence: ['src/limiter.js:2-3'], tests: ['tests/limiter.test.js:2'] },
    { id: 'R2', status: 'implemented', evidence: ['src/old.js:1-2'], tests: ['tests/limiter.test.js:1'], hunks: ['img.bin:binary'] },
    { id: 'R3', status: 'dismissed' },
  ], [{ key: 'src/extra.js:1-1', requirement: 'R2' }]) });
  assert.equal(r.status, 'pass');
  assert.equal(r.counts.extras, 0);

  r = await tr.evaluateMatrix({ ...args, skeleton: null, matrix: matrix([{ id: 'R1', status: 'dismissed' }]) });
  assert.equal(r.requirements[0].status, 'unknown', 'a strong requirement cannot be dismissed');
  r = await tr.evaluateMatrix({ ...args, skeleton: null, matrix: matrix([]) });
  assert.equal(r.reason, 'NO_REQUIREMENTS');
});

// ---------------------------------------------------------------------------
// verify orchestrator (in process, injectable step table)

test('verify degrades a missing module, a missing export, a thrown step and a bad result to unverified checks', async () => {
  const { dir, g } = makeRepo({ 'a.txt': 'a\n' });
  write(dir, { 'a.txt': 'b\n', 'u.txt': 'untracked\n' });
  const before = g('status', '--porcelain');
  const steps = [
    { name: 'detect', step: '1', module: './detect-does-not-exist.mjs', export: 'detect', ids: [], kind: 'detect', call: (fn) => fn() },
    { name: 'missing-export', step: 'x', module: './core.mjs', export: 'noSuchExport', ids: ['CK-SCOPE', 'CK-SKIP'], call: (fn) => fn() },
    { name: 'thrower', step: 'y', module: './git.mjs', export: 'git', ids: ['CK-DEPS'], call: (fn, s) => fn(s.target.root, ['definitely-not-a-git-command']) },
    { name: 'bad-result', step: 'z', module: './core.mjs', export: 'nowIso', ids: ['CK-LOCK'], call: (fn) => fn() },
    { name: 'needs-detect', step: 'w', module: './core.mjs', export: 'nowIso', ids: ['CK-CLEANRUN'], needsDetect: true, call: (fn) => fn() },
    { name: 'scorer', step: 'v', module: './evidence.mjs', export: 'scoreAnswers', ids: ['CK-MOCK', 'CK-TYPES'],
      call: (fn) => ({ checks: [fn([{ id: 'AT-NO-ASSERT', answer: 'no', citation: 'a.txt:1' }]).check] }) },
    { ...vf.DEFAULT_STEPS.find((s) => s.name === 'mutation-scope') },
  ];
  const res = await vf.runVerify(core.makeContext({ cwd: dir }), {}, { steps });
  const by = Object.fromEntries(res.result.checks.map((c) => [c.id, `${c.status}:${c.reason || ''}`]));
  assert.equal(by['CK-SCOPE'], 'unverified:MODULE_UNAVAILABLE');
  assert.equal(by['CK-SKIP'], 'unverified:MODULE_UNAVAILABLE');
  assert.equal(by['CK-DEPS'], 'unverified:GIT_FAILED');
  assert.equal(by['CK-LOCK'], 'unverified:NO_CHECKS_RETURNED');
  assert.equal(by['CK-CLEANRUN'], 'unverified:DETECT_UNAVAILABLE');
  assert.equal(by['CK-MOCK'], 'pass:');
  assert.equal(by['CK-TYPES'], 'unverified:NOT_REPORTED');
  assert.equal(by['CK-MUTATION'], 'skipped:NOT_REQUESTED');
  assert.equal(by['CK-REVIEW'], 'skipped:AWAITING_REVIEW');
  assert.match(res.result.checks.find((c) => c.id === 'CK-SCOPE').summary, /no export "noSuchExport"/);
  assert.match(res.result.checks.find((c) => c.id === 'CK-CLEANRUN').summary, /detect-does-not-exist\.mjs/);
  assert.equal(res.result.verdict, 'UNVERIFIED');
  assert.equal(res.exit, 4);
  assert.equal(res.result.worktree_unchanged, true);
  assert.equal(g('status', '--porcelain'), before);
  assert.ok(res.result.next_steps.some((s) => /MODULE_UNAVAILABLE/.test(s) && /CK-SCOPE, CK-SKIP/.test(s)));
  const ledger = readLedger(path.join(dir, res.result.ledger));
  assert.equal(ledger.mode, 'verify');
  assert.equal(ledger.steps.find((s) => s.name === 'thrower').status, 'degraded');
  assert.equal(ev.verifyIntegrity(ledger, { root: dir }).ok, true);
});

test('verify with the default steps: one snapshot, every expected check, porcelain unchanged', async () => {
  const { dir, g } = makeRepo({ 'README.md': '# x\n', 'src/x.js': 'export const x = 1;\n' });
  write(dir, { 'src/x.js': 'export const x = 2;\n', 'src/y.js': 'export const y = 3;\n' });
  const specFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'adc-spec-')), 'spec.md');
  fs.writeFileSync(specFile, '## Acceptance criteria\n- `src/y.js` exports y\n');
  const before = g('status', '--porcelain');
  const res = await vf.runVerify(core.makeContext({ cwd: dir }), { quick: true, offline: true, spec: specFile, claims: null, 'no-install': true }, {});
  assert.equal(g('status', '--porcelain'), before, 'git status --porcelain byte-identical');
  const ids = new Set(res.result.checks.map((c) => c.id));
  for (const id of ['CK-SCOPE', 'CK-TEST-DEL', 'CK-SKIP', 'CK-ASSERT', 'CK-TEST-CFG', 'CK-SUPPRESS', 'CK-CI', 'CK-SWALLOW', 'CK-SECRETS',
    'CK-DEPS', 'CK-LOCK', 'CK-TYPES', 'CK-CLEANRUN', 'CK-COVERAGE', 'CK-MUTATION', 'CK-FLAKE', 'CK-TRACE', 'CK-REVIEW', 'CK-CLAIMS']) {
    assert.ok(ids.has(id), `${id} present`);
  }
  for (const c of res.result.checks) assert.ok([...ev.STATUSES, 'waived'].includes(c.status), `${c.id} status ${c.status}`);
  assert.equal(res.result.checks.find((c) => c.id === 'CK-COVERAGE').reason, 'QUICK');
  assert.equal(res.result.checks.find((c) => c.id === 'CK-TRACE').status, 'unverified');
  assert.equal(res.exit, ev.verdictExit(res.result.verdict));
  assert.ok(fs.existsSync(path.join(dir, res.result.trace_matrix)));
  assert.ok(fs.existsSync(path.join(dir, res.result.markdown)));
  const ledger = readLedger(path.join(dir, res.result.ledger));
  assert.equal(ledger.tree_digest, res.result.tree_digest);
  assert.equal(new Set(ledger.checks.map((c) => c.tree_digest)).size, 1, 'every entry is for the one snapshot');
  assert.match(fs.readFileSync(path.join(dir, '.adc', 'metrics.jsonl'), 'utf8'), /"kind":"verify"/);
  assert.match(res.result.summary_markdown, /Verification evidence/);
});

test('verify --dry-run writes nothing; --finalize seals; bad options are usage errors', async () => {
  const { dir } = makeRepo({ 'a.txt': 'a\n' });
  const ctx = core.makeContext({ cwd: dir, 'dry-run': true });
  const plan = await vf.runVerify(ctx, { deep: true });
  assert.equal(plan.result.dry_run, true);
  assert.ok(plan.result.steps.find((s) => s.name === 'trace').skip_reason === 'NO_SPEC');
  assert.ok(!fs.existsSync(path.join(dir, '.adc')), 'no state dir created by a dry run');
  await assert.rejects(vf.runVerify(core.makeContext({ cwd: dir }), { quick: true, deep: true }), (e) => e.exit === 2);
  await assert.rejects(vf.runVerify(core.makeContext({ cwd: dir }), { times: '-1' }), (e) => e.exit === 2);
  const steps = [{ name: 'detect', module: './missing.mjs', export: 'detect', ids: [], kind: 'detect', call: (fn) => fn() }];
  const claims = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'adc-cl-')), 'claims.txt');
  fs.writeFileSync(claims, 'All tests pass.\n');
  const res = await vf.runVerify(core.makeContext({ cwd: dir }), { finalize: true, claims }, { steps });
  assert.equal(res.result.finalized, true);
  assert.equal(res.result.claims[0].status, 'unsupported');
  const ledger = readLedger(path.join(dir, res.result.ledger));
  assert.ok(ledger.finalized_at);
  assert.equal(ledger.checks.at(-1).id, 'CK-CLAIMS');
});

// ---------------------------------------------------------------------------
// End to end through adc.mjs

const LIB = path.join(core.SCRIPTS_DIR, 'lib');
const hasModules = (...names) => names.every((n) => fs.existsSync(path.join(LIB, n)));

test('e2e with the real step modules: planted skip fails, clean change passes, porcelain unchanged', { skip: !hasModules('diff-scope.mjs', 'clean-run.mjs') && 'diff-scope.mjs or clean-run.mjs not built yet' }, () => {
  const testFile = (body) => `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/math.js';\n${body}`;
  const { dir, g } = makeRepo({
    'package.json': '{ "name": "demo", "version": "1.0.0", "type": "module", "scripts": { "test": "node --test" } }\n',
    'package-lock.json': '{"name":"demo","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"demo","version":"1.0.0"}}}\n',
    'src/math.js': 'export const add = (a, b) => a + b;\n',
    'test/math.test.js': testFile("test('adds', () => { assert.equal(add(1, 2), 3); });\ntest('negatives', () => { assert.equal(add(-1, -2), -3); });\n"),
  });
  write(dir, {
    'src/math.js': 'export const add = (a, b) => a + b;\nexport const twice = (a) => add(a, a);\n',
    'test/math.test.js': testFile("test('adds', () => { assert.equal(add(1, 2), 3); });\ntest.skip('negatives', () => { assert.equal(add(-1, -2), -3); });\n"),
  });
  const before = g('status', '--porcelain');
  const bad = adc(['verify', '--quick', '--offline', '--claims', '-'], { cwd: dir, input: 'All tests pass.\n' });
  assert.ok(bad.json && bad.json.checks, bad.stderr);
  assert.equal(g('status', '--porcelain'), before, 'byte-identical after real worktree runs');
  const row = (res, id) => res.json.checks.find((c) => c.id === id && c.project === '.') || res.json.checks.find((c) => c.id === id);
  if (row(bad, 'CK-SKIP').status !== 'unverified') {
    assert.equal(row(bad, 'CK-SKIP').status, 'fail', 'diff-scope flags the added test.skip');
    assert.equal(bad.json.verdict, 'FAIL');
    assert.equal(bad.status, 1);
  }
  write(dir, { 'test/math.test.js': testFile("test('adds', () => { assert.equal(add(1, 2), 3); });\ntest('negatives', () => { assert.equal(add(-1, -2), -3); });\n") });
  const before2 = g('status', '--porcelain');
  const good = adc(['verify', '--quick', '--offline', '--claims', '-', '--finalize'], { cwd: dir, input: 'All tests pass.\n' });
  assert.ok(good.json && good.json.checks, good.stderr);
  assert.equal(good.status, ev.verdictExit(good.json.verdict));
  assert.equal(good.json.finalized, true);
  const hard = good.json.checks.filter((c) => !['CK-COVERAGE', 'CK-MUTATION', 'CK-FLAKE', 'CK-TRACE', 'CK-REVIEW', 'CK-TYPES', 'CK-CLAIMS'].includes(c.id));
  if (hard.every((c) => c.status === 'pass')) {
    assert.equal(good.json.verdict, 'PASS', JSON.stringify(good.json.reasons));
    assert.equal(good.json.claims[0].status, 'supported');
  }
  assert.equal(g('status', '--porcelain'), before2);
});

test('e2e: verify -> trace matrix -> claims -> score -> repro -> finalize -> render', () => {
  const { dir, g } = makeRepo({ 'src/limiter.js': 'export const limit = () => 200;\n', 'tests/limiter.test.js': "test('a', () => {});\n" });
  write(dir, { 'src/limiter.js': 'export const limit = (n) => (n > 100 ? 429 : 200);\n', 'tests/limiter.test.js': "test('a', () => {});\ntest('429', () => {});\n", 'notes.txt': 'untracked\n' });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adc-e2e-'));
  const spec = path.join(tmp, 'spec.md');
  fs.writeFileSync(spec, '## Acceptance criteria\n- Requests over 100 get 429\n');
  const before = g('status', '--porcelain');
  const v = adc(['verify', '--quick', '--offline', '--no-install', '--spec', spec], { cwd: dir, input: '' });
  assert.ok(v.json && v.json.ledger, v.stderr);
  assert.ok([0, 1, 4].includes(v.status));
  assert.equal(v.status, ev.verdictExit(v.json.verdict));
  assert.equal(g('status', '--porcelain'), before, 'verify leaves git status byte-identical');
  const ledgerAbs = path.join(dir, v.json.ledger);
  const L = ['--ledger', ledgerAbs];

  const matrixFile = path.join(dir, v.json.trace_matrix);
  const m = JSON.parse(fs.readFileSync(matrixFile, 'utf8'));
  m.requirements[0].status = 'implemented';
  m.requirements[0].evidence = ['src/limiter.js:1'];
  m.requirements[0].tests = ['tests/limiter.test.js:2'];
  for (const e of m.extras) e.requirement = 'R1';
  fs.writeFileSync(matrixFile, JSON.stringify(m));
  const add = adc(['evidence', 'add', matrixFile, ...L], { cwd: dir });
  assert.equal(add.status, 0, add.stderr);
  assert.equal(add.json.added[0].id, 'CK-TRACE');
  assert.equal(add.json.added[0].status, 'pass');

  const claims = adc(['evidence', 'claims', '-', ...L], { cwd: dir, input: 'Implemented the limiter as specified. All tests pass.\n' });
  assert.equal(claims.status, 0, claims.stderr);
  assert.equal(claims.json.added, 2);
  assert.deepEqual(claims.json.claims.map((c) => c.evidence), [['CK-TRACE'], ['CK-CLEANRUN']]);
  assert.equal(claims.json.claims[0].status, 'supported');

  const answers = path.join(tmp, 'answers.json');
  fs.writeFileSync(answers, JSON.stringify({ kind: 'review', answers: [{ id: 'RV-SPEC', answer: 'yes', citation: 'src/limiter.js:1' }],
    critical: [{ title: 'boundary at 100', citation: 'src/limiter.js:1', repro: 'node -e "process.exit(3)"' }] }));
  const sc = adc(['evidence', 'score', answers, ...L, '--add'], { cwd: dir });
  assert.equal(sc.status, 1, sc.stderr);
  assert.equal(sc.json.added[0].id, 'CK-REVIEW');
  const rp = adc(['evidence', 'add', '--check', 'CK-REVIEW', '--repro', 'node -e "process.exit(3)"', ...L], { cwd: dir });
  assert.equal(rp.status, 0, rp.stderr);
  assert.equal(rp.json.added[0].status, 'fail');
  assert.equal(rp.json.verdict, 'FAIL', 'a reproduced critical fails the verdict');
  const scripted = adc(['evidence', 'add', '--check', 'CK-CLEANRUN', '--run', 'node -e 0', ...L], { cwd: dir });
  assert.equal(scripted.status, 2);

  const waive = adc(['evidence', 'waive', 'CK-SCOPE', '--reason', 'because', ...L], { cwd: dir });
  assert.equal(waive.status, 2);
  const st = adc(['evidence', 'status', ...L], { cwd: dir });
  assert.equal(st.status, 0);
  assert.equal(st.json.stale, false);
  assert.equal(st.json.integrity.ok, true);
  assert.deepEqual(st.json.pending, []);

  const fin = adc(['evidence', 'finalize', ...L], { cwd: dir });
  assert.equal(fin.json.verdict, 'FAIL');
  assert.equal(fin.status, 1);
  const again = adc(['evidence', 'add', matrixFile, ...L], { cwd: dir });
  assert.equal(again.status, 2);
  assert.equal(again.json.error.code, 'LEDGER_FINALIZED');
  const md = adc(['evidence', 'render', '--short', ...L], { cwd: dir });
  assert.equal(md.status, 0);
  assert.match(md.json.markdown, /## Verification evidence: FAIL\n/);
  const out = path.join(tmp, 'evidence.md');
  assert.equal(adc(['evidence', 'render', '--out', out, ...L], { cwd: dir }).status, 0);
  assert.match(fs.readFileSync(out, 'utf8'), /### Claims/);
  assert.equal(g('status', '--porcelain'), before);
});

test('e2e: evidence init + add command output; tampered ledger is refused; trace CLI', () => {
  const { dir } = makeRepo({ 'a.js': 'x\n' });
  write(dir, { 'a.js': 'y\n' });
  const init = adc(['evidence', 'init'], { cwd: dir });
  assert.equal(init.status, 0, init.stderr);
  const ledgerAbs = path.join(dir, init.json.ledger);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adc-e2e2-'));
  const out = path.join(tmp, 'out.json');
  fs.writeFileSync(out, JSON.stringify({ tree_digest: init.json.tree_digest, checks: [ck('CK-CLEANRUN', 'pass'), ck('CK-SCOPE', 'pass')] }));
  const add = adc(['evidence', 'add', out], { cwd: dir });
  assert.equal(add.status, 0, add.stderr);
  assert.equal(add.json.verdict, 'PASS');
  fs.writeFileSync(out, JSON.stringify({ tree_digest: 'f'.repeat(40), checks: [ck('CK-TYPES', 'pass')] }));
  assert.equal(adc(['evidence', 'add', out], { cwd: dir }).json.error.code, 'STALE_INPUT');
  const l = readLedger(ledgerAbs);
  l.checks[0].status = 'fail';
  l.checks[1].status = 'pass';
  fs.writeFileSync(ledgerAbs, JSON.stringify(l));
  const fin = adc(['evidence', 'finalize'], { cwd: dir });
  assert.equal(fin.status, 4);
  assert.equal(fin.json.error.code, 'LEDGER_TAMPERED');

  const spec = path.join(tmp, 'spec.md');
  fs.writeFileSync(spec, '- [ ] a.js says y\n');
  const t = adc(['trace', '--spec', spec, '--out', path.join(tmp, 'm.json')], { cwd: dir });
  assert.equal(t.status, 0, t.stderr);
  assert.equal(t.json.requirements.length, 1);
  const m = JSON.parse(fs.readFileSync(path.join(tmp, 'm.json'), 'utf8'));
  m.requirements[0].status = 'implemented';
  m.requirements[0].evidence = ['a.js:1'];
  fs.writeFileSync(path.join(tmp, 'm.json'), JSON.stringify(m));
  const ev2 = adc(['trace', '--matrix', path.join(tmp, 'm.json')], { cwd: dir });
  assert.equal(ev2.json.status, 'pass', JSON.stringify(ev2.json.findings));
  assert.equal(ev2.status, 0);
  assert.equal(adc(['trace'], { cwd: dir }).status, 2);

  write(dir, { 'a.js': 'edited after the ledger\n' });
  const stale = adc(['evidence', 'claims', '-'], { cwd: dir, input: 'All tests pass.\n' });
  assert.equal(stale.status, 4);
  assert.equal(stale.json.error.code, 'LEDGER_STALE', 'a late write cannot refresh an old ledger');
  const st = adc(['evidence', 'status'], { cwd: dir });
  assert.equal(st.status, 0);
  assert.equal(st.json.stale, true);
  assert.equal(st.json.integrity.ok, false);
});
