// Unit tests for scripts/lib/core.mjs, git.mjs and state.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as core from '../../scripts/lib/core.mjs';
import * as git from '../../scripts/lib/git.mjs';
import * as state from '../../scripts/lib/state.mjs';

const ADC = core.ADC_SCRIPT;

export function makeRepo(files = {}, { commit = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adc-test-'));
  const g = (...args) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 'Test');
  g('config', 'commit.gpgsign', 'false');
  for (const [p, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), c);
  }
  if (commit) { g('add', '-A'); g('commit', '-q', '-m', 'init', '--allow-empty'); }
  return { dir, g };
}

test('asciiJson escapes every non-ASCII character', () => {
  const s = core.asciiJson({ a: 'héllo ✓ 😀' }, 0);
  assert.ok(/^[\x00-\x7e]*$/.test(s));
  assert.deepEqual(JSON.parse(s), { a: 'héllo ✓ 😀' });
});

test('globToRegExp handles **, *, braces and basename globs', () => {
  assert.ok(core.matchGlob('src/a/b.test.ts', '**/*.{test,spec}.*'));
  assert.ok(core.matchGlob('a.test.js', '**/*.{test,spec}.*'));
  assert.ok(core.matchGlob('tests/unit/x.py', 'tests/**'));
  assert.ok(core.matchGlob('pkg/test_foo.py', 'test_*.py'));
  assert.ok(!core.matchGlob('src/foo.py', 'test_*.py'));
  assert.ok(core.matchGlob('src\\x\\__tests__\\y.js', '**/__tests__/**'));
});

test('parseOpts rejects unknown options with a usage error', () => {
  assert.throws(() => core.parseOpts(['--nope'], {}), (e) => e instanceof core.AdcError && e.exit === 2);
  const { values, positionals } = core.parseOpts(['x', '--json', '--base', 'main'], { base: { type: 'string' } });
  assert.equal(values.base, 'main');
  assert.deepEqual(positionals, ['x']);
});

test('redactLiterals removes raw, URL-encoded and base64 forms', () => {
  const v = 'hunter2abc/+=';
  const text = `a ${v} b ${encodeURIComponent(v)} c ${Buffer.from(v).toString('base64')}`;
  const out = core.redactLiterals(text, [{ name: 'ADC_LIVE_TOKEN', value: v }]);
  assert.ok(!out.includes(v) && !out.includes(encodeURIComponent(v)) && !out.includes(Buffer.from(v).toString('base64')));
  assert.equal(out.split('[REDACTED:ADC_LIVE_TOKEN]').length - 1, 3);
});

test('template bundles parse sections, attributes and placeholders', () => {
  const sections = core.parseBundle('# comment\n@@@ file: a/{{name}}.txt kind=x|y @@@\nhello {{name}}\n\n@@@ file: b.txt @@@\nB\n');
  assert.equal(sections.length, 2);
  assert.deepEqual(core.selectSections(sections, { kind: 'y' }).map((s) => s.path), ['a/{{name}}.txt', 'b.txt']);
  assert.deepEqual(core.selectSections(sections, { kind: 'z' }).map((s) => s.path), ['b.txt']);
  assert.equal(core.renderString(sections[0].content, { name: 'n' }), 'hello n\n');
  assert.throws(() => core.renderString('{{missing}}', {}), /missing/);
});

test('withLock serializes and breaks stale locks', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adc-lock-'));
  const lock = path.join(dir, 'x.lock');
  fs.writeFileSync(lock, 'stale');
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lock, old, old);
  const v = await core.withLock(lock, () => 42);
  assert.equal(v, 42);
  assert.ok(!fs.existsSync(lock));
});

test('snapshot covers modified and untracked files and never includes .adc', () => {
  const { dir, g } = makeRepo({ 'a.txt': 'one\n', 'b.txt': 'two\n' });
  const statusBefore = g('status', '--porcelain');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'changed\n');
  fs.writeFileSync(path.join(dir, 'new.txt'), 'untracked\n');
  fs.mkdirSync(path.join(dir, '.adc'));
  fs.writeFileSync(path.join(dir, '.adc', 'secret.txt'), 'x');
  fs.rmSync(path.join(dir, 'b.txt'));
  const before = g('status', '--porcelain');
  const snap = git.createSnapshot(dir, { exclude: ['.adc'] });
  assert.equal(g('status', '--porcelain'), before, 'user index and worktree untouched');
  const files = git.lsTree(dir, snap.tree);
  assert.deepEqual(files.sort(), ['a.txt', 'new.txt']);
  const base = git.resolveBase(dir, null);
  assert.equal(base.source, 'main');
  const ns = git.diffNameStatus(dir, base.sha, snap.commit);
  assert.deepEqual(ns.map((f) => `${f.status} ${f.path}`).sort(), ['A new.txt', 'D b.txt', 'M a.txt']);
  const lines = git.diffLines(dir, base.sha, snap.commit, ['a.txt']);
  assert.equal(lines[0].added[0].text, 'changed');
  assert.equal(lines[0].removed[0].text, 'one');
  assert.equal(statusBefore, '');
});

test('state dir: exclude entry written, tracked state refused with exit 3', () => {
  const { dir, g } = makeRepo({ 'a.txt': 'x\n' });
  const info = state.prepareStateDir({ cwd: dir });
  assert.ok(fs.existsSync(path.join(dir, '.adc')));
  assert.ok(info.exclude.ok);
  assert.ok(state.stateIgnored(info, '.env.live'));
  const mat = state.materializeTemplates(info);
  assert.ok(mat.budget.created && mat.envLive.created);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, '.adc', '.env.live')).mode & 0o077, 0);
  const budget = JSON.parse(fs.readFileSync(path.join(dir, '.adc', 'budget.json'), 'utf8'));
  assert.equal(budget.max_per_session, 2500);
  assert.ok(budget.warn_at < budget.max_per_session);
  g('add', '-f', '.adc/budget.json');
  assert.throws(() => state.prepareStateDir({ cwd: dir }), (e) => e.exit === 3 && e.code === 'STATE_TRACKED');
});

test('.env.live is not materialized when a .gitignore negation un-ignores it', () => {
  const { dir } = makeRepo({ '.gitignore': '!.adc/\n!.adc/**\n', 'a.txt': 'x\n' });
  const info = state.prepareStateDir({ cwd: dir });
  const mat = state.materializeTemplates(info);
  assert.equal(mat.envLive.created, false);
  assert.ok(mat.envLive.reason);
});

test('exclude path resolves from a linked worktree', () => {
  const { dir, g } = makeRepo({ 'a.txt': 'x\n' });
  const wt = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'adc-wt-')), 'linked');
  g('worktree', 'add', '-q', wt);
  const info = state.prepareStateDir({ cwd: wt });
  assert.ok(info.exclude.ok);
  assert.ok(state.stateIgnored(info, '.env.live'));
});

test('parseEnvFile handles BOM, CRLF, export and quotes', () => {
  const m = state.parseEnvFile('﻿# c\r\nexport ADC_LIVE_TOKEN="abc def"\r\nX=\'y\'\r\nBAD LINE\n');
  assert.deepEqual(m, { ADC_LIVE_TOKEN: 'abc def', X: 'y' });
});

test('adc.mjs: unknown command exits 2; hook-run with garbage prints {} and exits 0', () => {
  const r1 = spawnSync(process.execPath, [ADC, 'nope'], { encoding: 'utf8' });
  assert.equal(r1.status, 2);
  for (const input of ['', 'not-json', '{}']) {
    const r = spawnSync(process.execPath, [ADC, 'hook-run', 'post-edit', '--dialect', 'claude'], { input, encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.ok(/^\{.*\}\n$/s.test(r.stdout), `one JSON object for ${JSON.stringify(input)}: ${r.stdout}`);
  }
});
