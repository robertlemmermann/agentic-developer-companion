// Unit tests for scripts/lib/core.mjs, git.mjs and state.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as core from '../../skills/agentic-developer-companion/scripts/lib/core.mjs';
import * as git from '../../skills/agentic-developer-companion/scripts/lib/git.mjs';
import * as state from '../../skills/agentic-developer-companion/scripts/lib/state.mjs';

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

test('snapshot works once .adc/ is ignored through info/exclude', () => {
  const { dir } = makeRepo({ 'a.txt': 'x\n' });
  state.prepareStateDir({ cwd: dir });
  fs.writeFileSync(path.join(dir, '.adc', 'evidence.json'), '{}');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'new\n');
  const snap = git.createSnapshot(dir, { exclude: ['.adc'] });
  assert.deepEqual(git.lsTree(dir, snap.tree).sort(), ['a.txt', 'b.txt']);
});

test('snapshot sees a same-size edit made right after the index was written (racy git)', () => {
  for (let i = 0; i < 20; i++) {
    const { dir, g } = makeRepo({ 'f.txt': 'aaaa\n' });
    fs.writeFileSync(path.join(dir, 'f.txt'), 'bbbb\n');
    g('add', 'f.txt');
    fs.writeFileSync(path.join(dir, 'f.txt'), 'cccc\n');
    const snap = git.createSnapshot(dir);
    assert.equal(git.showFile(dir, snap.commit, 'f.txt'), 'cccc\n', `iteration ${i}`);
  }
});

// ---------------------------------------------------------------------------
// Canonical shared helpers (CONSOLIDATION.md): core, git, state, formats, markers, frontmatter

const LIB = '../../skills/agentic-developer-companion/scripts/lib';
const formats = await import(`${LIB}/formats.mjs`);
const markers = await import(`${LIB}/markers.mjs`);
const fm = await import(`${LIB}/frontmatter.mjs`);
const tmp = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `adc-${label}-`));
const POSIX = process.platform !== 'win32';

test('value and text helpers', () => {
  assert.ok(core.isObj({}) && !core.isObj([]) && !core.isObj(null));
  assert.deepEqual([core.toArray(null), core.toArray(''), core.toArray('a'), core.toArray(['a'])], [[], [], ['a'], ['a']]);
  assert.deepEqual(core.uniq(['b', 'a', 'b', null, '', 'a']), ['b', 'a']);
  assert.equal(core.firstLine('\n  one \r\ntwo\n'), 'one');
  assert.equal(core.lastLine('one\ntwo  \r\n\n'), 'two');
  assert.equal(core.lineOf('a\nb\nc', 4), 3);
  assert.equal(core.mdCell('a|b\nc'), 'a\\|b c');
  assert.deepEqual(core.parseJsonl('{"a":1}\r\nnot json\n[1]\n\n{"b":2}'), [{ a: 1 }, { b: 2 }]);
});

test('canonicalJson sorts keys and is stable for hashing; sha256File', () => {
  assert.equal(core.canonicalJson({ b: [1, undefined, Infinity], a: { d: 1, c: undefined } }), '{"a":{"d":1},"b":[1,null,null]}');
  const d = tmp('hash');
  fs.writeFileSync(path.join(d, 'f'), 'abc');
  assert.equal(core.sha256File(path.join(d, 'f')), core.sha256('abc'));
  assert.equal(core.sha256File(path.join(d, 'missing')), null);
});

test('path helpers: isAbsolutePath, realPath, samePath, findUp, statOrNull, listFiles with symlinks', () => {
  assert.ok(core.isAbsolutePath('C:\\x') && core.isAbsolutePath('C:/x') && core.isAbsolutePath(path.resolve('x')) && !core.isAbsolutePath('a/b'));
  const d = core.makeTempDir('paths');
  assert.ok(path.basename(d).startsWith('adc-paths-'));
  fs.mkdirSync(path.join(d, 'real', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(d, 'real', 'marker.txt'), 'x');
  fs.writeFileSync(path.join(d, 'real', 'sub', 'f.txt'), 'x');
  assert.equal(core.realPath(path.join(d, 'real', 'not', 'yet')), path.join(fs.realpathSync.native(path.join(d, 'real')), 'not', 'yet'));
  assert.ok(core.samePath(path.join(d, 'real', 'sub', '..'), path.join(d, 'real')));
  assert.equal(core.findUp(path.join(d, 'real', 'sub'), 'marker.txt'), path.join(d, 'real'));
  assert.equal(core.findUp(path.join(d, 'real', 'sub'), 'marker.txt', { stopAt: path.join(d, 'real', 'sub') }), null);
  assert.ok(core.isDir(d) && !core.isDir(path.join(d, 'real', 'marker.txt')) && core.statOrNull(path.join(d, 'nope')) === null);
  if (POSIX) {
    fs.symlinkSync(path.join(d, 'real', 'sub'), path.join(d, 'real', 'link'));
    assert.deepEqual(core.listFiles(path.join(d, 'real')), ['marker.txt', 'sub/f.txt']);
    assert.deepEqual(core.listFiles(path.join(d, 'real'), { followSymlinks: true }), ['link/f.txt', 'marker.txt', 'sub/f.txt']);
  }
});

test('readInput / readJsonInput / numberOption raise usage errors (exit 2)', () => {
  const d = tmp('input');
  fs.writeFileSync(path.join(d, 'a.json'), '\ufeff{"x":1}');
  assert.deepEqual(core.readJsonInput('a.json', d), { x: 1 });
  assert.throws(() => core.readInput('nope.txt', d, { what: '--claims file' }), (e) => e.exit === 2 && /--claims file not found/.test(e.message));
  fs.writeFileSync(path.join(d, 'bad.json'), '{');
  assert.throws(() => core.readJsonInput('bad.json', d), (e) => e.exit === 2);
  assert.equal(core.numberOption({}, 'timeout', 600), 600);
  assert.equal(core.numberOption({ timeout: '30' }, 'timeout', 600), 30);
  assert.equal(core.numberOption({ credits: '0' }, 'credits', null, { allowZero: true }), 0);
  for (const [v, o] of [['0', {}], ['-1', { allowZero: true }], ['1.5', { integer: true }], ['x', {}]]) {
    assert.throws(() => core.numberOption({ n: v }, 'n', null, o), (e) => e.exit === 2 && /^--n must be/.test(e.message));
  }
});

test('anchored globs match at the root only', () => {
  assert.ok(core.matchGlob('a/b.test.js', '*.test.js'));
  assert.ok(!core.matchGlob('a/b.test.js', '*.test.js', { anchored: true }));
  assert.ok(core.matchGlob('b.test.js', '*.test.js', { anchored: true }));
  assert.ok(core.matchAny('src/x.ts', ['*.md', 'src/**'], { anchored: true }));
});

test('quoteFor round-trips through sh; quoteArg keeps safe tokens bare', { skip: !POSIX }, () => {
  const nasty = `a b'c"d$HOME\`x\`\\z`;
  for (const shell of ['sh', 'sh-double']) {
    const r = spawnSync('sh', ['-c', `printf %s ${core.quoteFor(shell, nasty)}`], { encoding: 'utf8' });
    assert.equal(r.stdout, nasty, shell);
  }
  assert.equal(core.quoteArg('src/a.test.js'), 'src/a.test.js');
  assert.equal(core.quoteFor('sh-double', 'plain', { always: true }), '"plain"');
  assert.equal(core.quoteFor('pwsh', "it's"), "'it''s'");
  assert.equal(core.quoteFor('pwsh-double', 'a"$b'), '"a`"`$b"');
  assert.equal(core.quoteFor('cmd', 'a "b"'), '"a ""b"""');
});

test('splitShell: segments, operators, quotes, comments; redirections dropped or kept', () => {
  assert.deepEqual(core.splitShell('A=1 npm test -- -t "x y" 2>&1 | tee out.log && echo ok > f.txt # note'), [
    { tokens: ['A=1', 'npm', 'test', '--', '-t', 'x y'], op: '|' },
    { tokens: ['tee', 'out.log'], op: '&&' },
    { tokens: ['echo', 'ok'], op: null },
  ]);
  assert.deepEqual(core.splitShell("a 'b;c' \"d\\\"e\" f\\ g\r\nh || (i)"), [
    { tokens: ['a', 'b;c', 'd"e', 'f g'], op: 'nl' }, { tokens: ['h'], op: '||' }, { tokens: ['i'], op: ')' },
  ]);
  assert.deepEqual(core.splitShell('cat x >.adc/y 2>/dev/null; echo &>log', { redirects: 'keep' }).map((s) => s.tokens),
    [['cat', 'x', '>', '.adc/y', '2>', '/dev/null'], ['echo', '&>', 'log']]);
  assert.deepEqual(core.shellWords('node "cli.js" --x="a b" C:\\tools\\x.exe a|b \'\''), ['node', 'cli.js', '--x=a b', 'C:\\tools\\x.exe', 'a|b', '']);
  assert.equal(core.shellWords('a "b'), null);
});

test('hostFromEnv and hostHomes', () => {
  const h = core.hostFromEnv;
  assert.deepEqual(h({}), { tool: 'unknown', hooks: null, markers: [], candidates: [] });
  assert.equal(h({ CLAUDECODE: '0' }).tool, 'unknown');
  assert.deepEqual([h({ COPILOT_CLI: '1' }).tool, h({ COPILOT_CLI: '1' }).hooks], ['copilot-cli', 'copilot']);
  assert.equal(h({ COPILOT_AGENT_PROMPT: 'x', CLAUDECODE: '1' }).hooks, 'copilot-cloud');
  assert.equal(h({ CLAUDE_CODE_ENTRYPOINT: 'cli' }).hooks, 'claude');
  assert.equal(h({ CLAUDE_CONFIG_DIR: '/x', CODEX_HOME: '/y' }).tool, 'unknown');
  assert.equal(h({ CODEX_SANDBOX: 'seatbelt' }).hooks, 'codex');
  assert.equal(h({ TERM_PROGRAM: 'vscode' }).hooks, 'copilot');
  assert.deepEqual(h({ COPILOT_CLI: '1', CLAUDECODE: '1' }).candidates, ['copilot-cli', 'claude-code']);
  const homes = core.hostHomes({ env: { CODEX_HOME: '/opt/codex' }, home: '/home/u' });
  assert.equal(toPosixAbs(homes.codex), toPosixAbs(path.resolve('/opt/codex')));
  assert.equal(homes.claude, path.join('/home/u', '.claude'));
});
const toPosixAbs = (p) => core.toPosix(p);

test('liveSecrets and redactLiveToken (shapes, JSON/YAML forms, env literals, readable status)', () => {
  const T = ['tok', 'Value', '1234567'].join('');
  assert.deepEqual(core.liveSecrets({ ADC_LIVE_TOKEN: ` ${T}\n`, ADC_LIVE_API_KEY: 'abcdef', ADC_LIVE_BASE_URL: 'https://x', OTHER_TOKEN: 'zzzzzz' }),
    [{ name: 'ADC_LIVE_TOKEN', value: T }, { name: 'ADC_LIVE_API_KEY', value: 'abcdef' }]);
  const r = core.redactLiveToken;
  assert.equal(r(`ADC_LIVE_TOKEN=${T}\n`), 'ADC_LIVE_TOKEN=[REDACTED]\n');
  assert.equal(r(`{"ADC_LIVE_TOKEN": "${T} x"}`), '{"ADC_LIVE_TOKEN": "[REDACTED]"}');
  assert.equal(r(`ADC_LIVE_TOKEN: ${T}`), 'ADC_LIVE_TOKEN: [REDACTED]');
  assert.equal(r('ADC_LIVE_TOKEN: set (source: .adc/.env.live)'), 'ADC_LIVE_TOKEN: set (source: .adc/.env.live)');
  assert.equal(r(`ADC_LIVE_TOKEN       ${T}\nPATH  /bin`), 'ADC_LIVE_TOKEN       [REDACTED]\nPATH  /bin');
  assert.equal(r(`printed ${T}.`, { ADC_LIVE_TOKEN: T }), 'printed [REDACTED:ADC_LIVE_TOKEN].');
  assert.equal(r('a test run', { ADC_LIVE_TOKEN: 'test' }), 'a test run');
});

test('renderString keeps GitHub Actions expressions with actions: true; selectSections strict/features/loose', () => {
  assert.equal(core.renderString('${{ github.ref }} {{name}}', { name: 'n' }, { actions: true }), '${{ github.ref }} n');
  assert.throws(() => core.renderString('${{ github.ref }}', {}), /github\.ref/);
  assert.equal(core.renderString('${{name}}', { name: 'n' }), '$n');
  const secs = core.parseBundle('@@@ file: a kind=web lang=ts @@@\nA\n@@@ file: b kind=web @@@\nB\n@@@ file: c kind=web when=pact @@@\nC\n@@@ file: d kind=web part=fragment name=x @@@\nD\n');
  const names = (l) => l.map((s) => s.path);
  assert.deepEqual(names(core.selectSections(secs, { kind: 'web' })), ['a', 'b', 'c', 'd']);
  assert.deepEqual(names(core.selectSections(secs, { kind: 'web' }, { strict: true, features: new Set(), loose: ['part', 'name'] })), ['b', 'd']);
  assert.deepEqual(names(core.selectSections(secs, { kind: 'web', lang: 'ts' }, { strict: true, features: new Set(['pact']), loose: ['part', 'name'] })), ['a', 'b', 'c', 'd']);
});

test('runTool and toolVersion run installed CLIs', () => {
  const r = core.runTool(process.execPath, ['-e', 'console.log(process.argv.slice(1).join("|"))', 'a b', 'c']);
  assert.equal(r.exit, 0);
  assert.equal(r.stdout.trim(), 'a b|c');
  assert.match(core.toolVersion('node').version, /^\d+\.\d+\.\d+$/);
});

test('spawnCapture: output, input, stdout line callback, tee to log/capture files, tail cap', async () => {
  const node = (code, opts) => core.spawnCapture(process.execPath, ['-e', code], opts);
  let r = await node('console.log("out"); console.error("err"); process.exit(3)');
  assert.deepEqual([r.exit, r.stdout, r.stderr, r.timedOut, r.error], [3, 'out\n', 'err\n', false, null]);
  r = await node('process.stdin.pipe(process.stdout)', { input: 'hello' });
  assert.equal(r.stdout, 'hello');
  const seen = [];
  r = await node('for (let i = 0; i < 5; i++) console.log("l" + i); setTimeout(() => {}, 20000)', {
    onLine: (l) => { seen.push(l); return l === 'l2' ? 'stop' : null; },
  });
  assert.ok(r.stopped && seen.includes('l2') && r.ms < 15000);
  const d = tmp('spawn');
  fs.writeFileSync(path.join(d, 'log'), 'pre\n');
  r = await node('console.log(1); console.error(2)', { logFile: path.join(d, 'log'), captureFile: path.join(d, 'cap') });
  assert.equal(fs.readFileSync(path.join(d, 'log'), 'utf8').split('\n').sort().join(','), ',1,2,pre');
  assert.equal(fs.readFileSync(path.join(d, 'cap'), 'utf8').split('\n').sort().join(','), ',1,2');
  r = await node('process.stdout.write("x".repeat(100) + "\\nsecond\\nthird")', { maxBytes: 20 });
  assert.deepEqual([r.truncated, r.stdout], [true, 'second\nthird']);
  r = await core.spawnCapture(path.join(d, 'no-such-program'), []);
  assert.deepEqual([r.exit, r.error], [null, 'ENOENT']);
});

test('spawnCapture timeout kills the whole process group, also when the leader already exited', { skip: !POSIX }, async () => {
  for (const line of ['sleep 30 & sleep 30', 'sleep 30 & exit 0']) {
    const t0 = Date.now();
    const r = await core.spawnCapture(line, [], { shell: true, timeoutMs: 300 });
    assert.ok(r.timedOut && Date.now() - t0 < 10_000, line);
  }
});

test('git: parseUnifiedDiff hunks, readBlobs, lsTree entries, lsFiles strict, statusPorcelain, appendExclude', () => {
  const diff = ['diff --git a/f.txt b/f.txt', '--- a/f.txt', '+++ b/f.txt', '@@ -1,2 +1 @@', '-one', '-two', '+uno', '@@ -9 +8,2 @@', '+x', '+y', ''].join('\n');
  const [f] = git.parseUnifiedDiff(diff);
  assert.deepEqual(f.hunks.map((h) => [h.oldStart, h.oldCount, h.newStart, h.newCount, h.added.length, h.removed.length]), [[1, 2, 1, 1, 1, 2], [9, 1, 8, 2, 2, 0]]);
  assert.deepEqual(f.added.map((l) => l.line), [1, 8, 9]);
  const { dir, g } = makeRepo({ 'a.txt': 'A\n', 'sub/b.bin': Buffer.from([0, 1, 2, 255]) });
  const blobs = git.readBlobs(dir, ['HEAD:a.txt', 'HEAD:sub/b.bin', 'HEAD:missing']);
  assert.equal(blobs.get('HEAD:a.txt').toString(), 'A\n');
  assert.deepEqual([...blobs.get('HEAD:sub/b.bin')], [0, 1, 2, 255]);
  assert.equal(blobs.get('HEAD:missing'), null);
  const entries = git.lsTree(dir, 'HEAD', { entries: true, paths: ['sub'] });
  assert.deepEqual(entries.map((e) => [e.type, e.path]), [['blob', 'sub/b.bin']]);
  assert.equal(git.readBlobs(dir, [entries[0].sha]).get(entries[0].sha).length, 4);
  assert.deepEqual(git.lsTree(dir, 'HEAD'), ['a.txt', 'sub/b.bin']);
  assert.deepEqual(git.lsFiles(dir, ['a.txt']), ['a.txt']);
  const outside = tmp('nogit');
  assert.deepEqual(git.lsFiles(outside, []), []);
  assert.equal(git.lsFiles(outside, [], { strict: true }), null);
  fs.writeFileSync(path.join(dir, 'new.txt'), 'n');
  assert.equal(git.statusPorcelain(dir), '?? new.txt\0');
  const r1 = git.appendExclude(dir, '/.local/', { aliases: ['/.local'] });
  assert.ok(r1.ok && r1.written);
  assert.equal(git.appendExclude(dir, '/.local/').written, false);
  assert.ok(git.checkIgnore(dir, '.local/x'));
  const custom = path.join(outside, 'exclude');
  fs.writeFileSync(custom, '/.other');
  assert.equal(git.appendExclude(null, '/.other/', { aliases: ['/.other'], excludeFile: custom }).written, false);
  assert.ok(git.appendExclude(null, '/x/', { excludeFile: custom, comment: null }).written);
  assert.equal(fs.readFileSync(custom, 'utf8'), '/.other\n/x/\n');
  assert.equal(g('status', '--porcelain'), '?? new.txt');
});

test('state: git-free repo lookup and state dir (hooks), tracked check, ledgers', () => {
  const { dir, g } = makeRepo({ 'a.txt': 'x\n' });
  const repo = state.locateRepo(path.join(dir, 'a.txt'));
  assert.equal(repo.root, fs.realpathSync.native(dir));
  assert.equal(repo.commonDir, path.join(dir, '.git'));
  const wt = path.join(tmp('wt'), 'linked');
  g('worktree', 'add', '-q', wt);
  const linked = state.locateRepo(wt);
  assert.equal(path.resolve(linked.commonDir), fs.realpathSync.native(path.join(dir, '.git')));
  assert.equal(state.locateRepo(tmp('none')), null);
  const info = state.resolveStateDir({ root: repo.root, env: {} });
  assert.deepEqual([info.rel, info.insideRepo, info.source], ['.adc', true, 'default']);
  assert.equal(state.resolveStateDir({ root: repo.root, stateDirOption: 'st', env: {} }).rel, 'st');
  const ex = state.ensureExcluded(info, { excludeFile: path.join(repo.commonDir, 'info', 'exclude') });
  assert.ok(ex.ok && ex.written && ex.needed);
  assert.ok(state.createStateDir(info));
  if (POSIX) assert.equal(fs.statSync(info.dir).mode & 0o777, 0o700);
  assert.ok(state.stateIgnored({ ...info }, '.env.live'));
  assert.deepEqual(state.trackedStateFiles(info, { strict: true }), []);
  assert.equal(state.trackedStateFiles({ ...info, root: tmp('nogit2') }, { strict: true }), null);
  const ev = path.join(info.dir, 'evidence');
  fs.mkdirSync(ev);
  const iso = (s) => new Date(Date.now() + s * 1000).toISOString();
  const write = (n, doc, ageS) => {
    fs.writeFileSync(path.join(ev, n), JSON.stringify(doc));
    const t = new Date(Date.now() - ageS * 1000);
    fs.utimesSync(path.join(ev, n), t, t);
  };
  write('a.json', { schema: 'adc-evidence/1', verdict: 'PASS', created_at: iso(-60) }, 0);
  write('b.json', { schema: 'adc-evidence/1', verdict: 'FAIL', created_at: iso(-10), finalized_at: iso(-5) }, 50);
  write('c.json', { schema: 'adc-trace/1', created_at: iso(0) }, 0);
  write('d.json', { schema: 'adc-evidence/1', verdict: 'PASS', created_at: iso(-30) }, 100);
  assert.deepEqual(state.listLedgers(info.dir).map((r) => [r.name, r.verdict, r.finalized]), [['b.json', 'FAIL', true], ['d.json', 'PASS', false], ['a.json', 'PASS', false]]);
  assert.deepEqual(state.listLedgers(info.dir, { max: 2 }).map((r) => r.name), ['a.json'], 'only the two newest files by mtime are read');
});

test('state.writeOutputs: create, unchanged, keep without --force, merge, forced overwrite with backup, dry run', () => {
  const { dir } = makeRepo({ 'keep.txt': 'old\n', '.gitignore': 'a\r\n', 'same.txt': 'x\r\n' });
  fs.mkdirSync(path.join(dir, 'adir'));
  const backup = state.backupDirFactory({}, dir, 'backups', 'test');
  const merge = (cur) => `${cur}b\n`;
  const outs = [
    { path: 'new/one.txt', content: '1\n' }, { path: 'same.txt', content: 'x\n' }, { path: 'keep.txt', content: 'new\n', kind: 'k' },
    { path: '.gitignore', content: 'b\n', merge }, { path: 'adir', content: 'x' }, { path: '../escape.txt', content: 'x' },
    { path: 'new/one.txt', content: 'dup\n' },
  ];
  const plan = state.writeOutputs(outs, { root: dir, dryRun: true, backupDir: backup });
  assert.deepEqual(plan.written.map((w) => `${w.path}:${w.action}`), ['new/one.txt:would-create', 'same.txt:unchanged', '.gitignore:would-merge']);
  assert.deepEqual(plan.skipped.map((s) => s.path), ['keep.txt', 'adir', '../escape.txt']);
  assert.equal(plan.skipped[0].kind, 'k');
  assert.ok(!fs.existsSync(path.join(dir, 'new')));
  const res = state.writeOutputs(outs, { root: dir, force: true, backupDir: backup });
  assert.deepEqual(res.written.map((w) => `${w.path}:${w.action}`), ['new/one.txt:create', 'same.txt:unchanged', 'keep.txt:overwrite', '.gitignore:merge']);
  assert.equal(fs.readFileSync(path.join(dir, 'new/one.txt'), 'utf8'), '1\n');
  assert.equal(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), 'a\r\nb\n');
  assert.equal(res.backups.length, 1);
  assert.equal(fs.readFileSync(res.backups[0], 'utf8'), 'old\n');
  assert.ok(core.toPosix(res.backups[0]).includes('/.adc/backups/test/'));
  const strictMerge = state.writeOutputs([{ path: '.gitignore', content: 'c\n', merge: (c) => `${c}c\n` }], { root: dir, mergeNeedsForce: true });
  assert.equal(strictMerge.skipped[0].planned, 'merge');
  const replaced = state.writeOutputs([{ path: 'keep.txt', content: 'r\n', replace: true }], { root: dir });
  assert.equal(replaced.written[0].action, 'overwrite');
});

test('formats.parseToml: strict errors with lines and key lines; lenient skips bad lines', () => {
  const src = '\ufeff# c\r\n[package]\r\nname = "x" # n\r\nversion = 1.2.3\r\n[[bin]]\nname = "a"\n[[bin]]\nname = \'b\'\n[dependencies]\nserde = { version = "1", features = ["derive"] }\narr = [\n  "a", # c\n  "b",\n]\nm = """\nl1\nl2"""\nd = 1979-05-27\nh = 0xff\nf = 1_000.5\n';
  const strict = formats.parseToml(src);
  assert.equal(strict.value, null);
  assert.deepEqual(strict.error, { line: 4, message: 'invalid value: 1.2.3' });
  const lenient = formats.parseToml(src, { lenient: true });
  assert.deepEqual(lenient.value, {
    package: { name: 'x', version: '1.2.3' }, bin: [{ name: 'a' }, { name: 'b' }],
    dependencies: { serde: { version: '1', features: ['derive'] }, arr: ['a', 'b'], m: 'l1\nl2', d: '1979-05-27', h: 255, f: 1000.5 },
  });
  const ok = formats.parseToml('[a.b]\nc = true\n"d.e" = [1, 2]\n[x]\ny = -inf\n');
  assert.equal(ok.error, null);
  assert.deepEqual(ok.keyLines, { 'a.b': 1, 'a.b.c': 2, 'a.b.d.e': 3, x: 4, 'x.y': 5 });
  assert.deepEqual(formats.parseToml('a = 1\na = 2\n').error, { line: 2, message: 'duplicate key "a"' });
  assert.deepEqual(formats.parseToml('a = 1\na = 2\nbad\nb = 3\n', { lenient: true }), {
    value: { a: 2, b: 3 }, error: { line: 3, message: 'expected "=" after a key' }, errors: [{ line: 3, message: 'expected "=" after a key' }], keyLines: { a: 2, b: 4 },
  });
  assert.equal(formats.parseToml('s = "a\\qb"').error.message, 'invalid escape \\q');
  assert.equal(formats.parseToml('s = "a\\qb"', { lenient: true }).value.s, 'aqb');
});

test('formats: parseIni, stripJsonc, parseJson, parseJsonc', () => {
  assert.deepEqual(formats.parseIni('\ufeff; c\r\n[tool:pytest]\r\naddopts = -q\r\ntestpaths =\r\n    tests\r\n    more\r\n[flake8]\nmax-line-length: 100\n'),
    { 'tool:pytest': { addopts: '-q', testpaths: 'tests\nmore' }, flake8: { 'max-line-length': '100' } });
  const jsonc = '{\n  // c\n  "a": "x // not a comment", /* b\n c */ "b": [1, 2,],\n}\n';
  assert.equal(formats.stripJsonc(jsonc).split('\n').length, jsonc.split('\n').length);
  assert.deepEqual(formats.parseJsonc(jsonc), { a: 'x // not a comment', b: [1, 2] });
  assert.equal(formats.parseJsonc('{nope'), null);
  assert.deepEqual(formats.parseJson(jsonc, { jsonc: true }), { value: { a: 'x // not a comment', b: [1, 2] }, jsonc: true });
  const strict = formats.parseJson(jsonc);
  assert.match(strict.error, /comments or trailing commas/);
  assert.deepEqual(strict.looseValue, { a: 'x // not a comment', b: [1, 2] });
  assert.equal(formats.parseJson('{\n"a": 1,\n"b" 2}').line, 3);
});

test('markers: isTestFile / projectForFile with detect globs, heuristics and Rust content', () => {
  const det = { repo_root: '/r', projects: [{ root: '.', test_globs: ['**/*.test.js'] }, { root: 'svc', test_globs: ['checks/**'] }, { root: 'lib', test_globs: [] }] };
  assert.equal(markers.projectForFile('svc/checks/a.py', det).root, 'svc');
  assert.equal(markers.projectForFile('/r/svc/x', det).root, 'svc');
  assert.equal(markers.projectForFile('svcx/a', det).root, '.');
  assert.ok(markers.isTestFile('svc/checks/a.py', det, { heuristic: false }));
  assert.ok(!markers.isTestFile('checks/a.py', det, { heuristic: false }));
  assert.ok(markers.isTestFile('src/a_test.go', det), 'heuristics on by default');
  assert.ok(!markers.isTestFile('src/a_test.go', det, { heuristic: false }));
  assert.ok(markers.isTestFile('lib/tests/x.rb', det, { heuristic: false }), 'a project without globs falls back to the defaults');
  assert.ok(markers.isTestFile('tests/data.json', null) && !markers.isTestFile('tests/data.json', null, { codeOnly: true }));
  assert.ok(markers.isTestFile('src/lib.rs', null, { content: 'mod x;\n#[cfg(test)]\nmod tests {}' }));
  assert.ok(!markers.isTestFile('src/lib.rs', null, { content: 'fn main() {}' }));
  assert.ok(markers.DEFAULT_TEST_GLOBS.includes('**/*_test.go'));
  assert.equal(markers.LOCKFILE_MANAGERS['pnpm-lock.yaml'], 'pnpm');
});

test('markers.makeRedactor and redactDeep', () => {
  const aws = ['AKIA', 'IOSFODNN7', 'EXAMPLE'].join('');
  const tok = ['live', 'Tok', '987654321'].join('');
  const lit = ['hunter2', 'abc/+='].join('');
  const redact = markers.makeRedactor({ literals: [{ name: 'PW', value: lit }], env: { ADC_LIVE_TOKEN: tok } });
  const out = redact(`k=${aws} t=${tok} b64=${Buffer.from(lit).toString('base64')} ADC_LIVE_TOKEN=${'x'.repeat(12)} FOO_TOKEN=abcdef1`);
  assert.ok(!out.includes(aws) && !out.includes(tok) && !out.includes(Buffer.from(lit).toString('base64')) && !out.includes('xxxxxxxxxxxx'), out);
  assert.match(out, /\[REDACTED:aws[\w-]*\]/);
  assert.match(out, /\[REDACTED:ADC_LIVE_TOKEN\]/);
  assert.match(out, /\[REDACTED:PW\]/);
  assert.match(out, /FOO_TOKEN=abcdef1$/);
  assert.match(markers.makeRedactor({ env: {}, names: true })('FOO_TOKEN=abcdef1'), /^FOO_TOKEN=\[REDACTED\]$/);
  assert.equal(redact(''), '');
  const deep = markers.redactDeep({ cmd: `x ${tok}`, output_sha256: tok, list: [tok], nested: { tree: tok }, [tok]: 1, env: { API_TOKEN: 'plainvalue' } },
    redact, { keys: true, secretKeys: true });
  assert.deepEqual(deep, { cmd: 'x [REDACTED:ADC_LIVE_TOKEN]', output_sha256: tok, list: ['[REDACTED:ADC_LIVE_TOKEN]'], nested: { tree: tok },
    '[REDACTED:ADC_LIVE_TOKEN]': 1, env: { API_TOKEN: '[REDACTED]' } });
  assert.deepEqual(markers.redactDeep({ [tok]: tok }, redact), { [tok]: '[REDACTED:ADC_LIVE_TOKEN]' });
});

test('frontmatter: parseYamlAll, stringify flow/quote keys, Markdown lines and links', () => {
  assert.deepEqual(fm.parseYamlAll('# c\n---\non: push\njobs:\n  t:\n    steps:\n      - run: npm test\n...\n---\na: [b\n---\n- x\n'),
    [{ on: 'push', jobs: { t: { steps: [{ run: 'npm test' }] } } }, null, ['x']]);
  assert.deepEqual(fm.parseYamlAll(''), []);
  assert.deepEqual(fm.parseYamlAll('--- just text\n'), ['just text']);
  const data = { name: 'x', tools: ['read', "it's"], applyTo: 'src/**', paths: ['src/**'], yes: 'yes', description: 'a'.repeat(50) + ' ' + 'b'.repeat(60) };
  const text = fm.stringifyFrontmatter(data, { flowKeys: ['tools'] });
  assert.match(text, /^tools: \['read', 'it''s'\]$/m);
  assert.match(text, /^applyTo: "src\/\*\*"$/m);
  assert.match(text, /^ {2}- "src\/\*\*"$/m);
  assert.match(text, /^yes: "yes"$/m);
  assert.deepEqual(fm.parseFrontmatter(text + 'body').data, data);
  assert.equal(fm.stringifyFrontmatter({ a: 1 }, 'B\n'), '---\na: 1\n---\nB\n');
  const md = 'Intro [a](docs/a.md#x) `[no](code.md)`\r\n```sh\n[skip](x.md)\n```\n[ref]: <refs/r.md>\n![img](https://e.x/i.png)';
  const lines = fm.markdownLines(md);
  assert.deepEqual(lines.map((l) => [l.n, l.code, Boolean(l.fenceStart), Boolean(l.fenceEnd)]),
    [[1, false, false, false], [2, true, true, false], [3, true, false, false], [4, true, false, true], [5, false, false, false], [6, false, false, false]]);
  assert.equal(lines[1].lang, 'sh');
  assert.deepEqual(fm.markdownLinks(md), [{ line: 1, target: 'docs/a.md#x' }, { line: 5, target: 'refs/r.md' }, { line: 6, target: 'https://e.x/i.png' }]);
  assert.ok(fm.isExternalLink('https://x') && fm.isExternalLink('#a') && !fm.isExternalLink('C:/x.md') && !fm.isExternalLink('file:x') && !fm.isExternalLink('a.md'));
  assert.equal(fm.linkPath('docs/my%20file.md?x=1#h'), 'docs/my file.md');
});

test('makeCheck fills every ledger field (plan §9.2)', () => {
  const c = core.makeCheck({ id: 'CK-LIVE', status: 'pass', data: { n: 1 } });
  assert.deepEqual(Object.keys(c), ['id', 'fm', 'project', 'status', 'reason', 'cost', 'command', 'cwd', 'exit_code', 'duration_ms', 'summary',
    'output_sha256', 'artifacts', 'findings', 'data']);
  assert.deepEqual([c.id, c.status, c.reason, c.project, c.data.n], ['CK-LIVE', 'pass', null, '.', 1]);
  assert.notEqual(core.makeCheck({}).findings, core.makeCheck({}).findings, 'fresh arrays per check');
});

test('relPosix keeps in-repo names that start with two dots', () => {
  const root = path.resolve('/repo');
  assert.equal(core.relPosix(root, path.join(root, '..notes.md')), '..notes.md');
  assert.equal(core.relPosix(root, path.join(root, '..', 'x')), null);
  assert.equal(core.relPosix(root, root), '.');
});

test('parseUnifiedDiff treats --- and +++ inside a hunk as content', () => {
  const text = ['diff --git a/q.sql b/q.sql', '--- a/q.sql', '+++ b/q.sql', '@@ -1,2 +1,2 @@',
    '--- a SQL comment', '+++ plus content', ' kept', ''].join('\n');
  const [f] = git.parseUnifiedDiff(text);
  assert.equal(f.path, 'q.sql');
  assert.deepEqual(f.removed.map((l) => l.text), ['-- a SQL comment']);
  assert.deepEqual(f.added.map((l) => l.text), ['++ plus content']);
});

test('a command group prints its usage and exits 0 on --help', () => {
  for (const argv of [['evidence', '--help'], ['tooling', '-h'], ['hooks', 'help']]) {
    const r = spawnSync(process.execPath, [ADC, ...argv], { encoding: 'utf8' });
    assert.equal(r.status, 0, argv.join(' '));
  }
});

test('toolEnv drops live credentials only', () => {
  const env = core.toolEnv({ PATH: '/bin', ['ADC_LIVE_' + 'TOKEN']: ['abcd', 'efgh'].join(''), HOME: '/h' });
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'PATH']);
});

test('text helpers: tryJson, readJson(File), oneLine, words, indentOf, plural, cmp; lineOf agrees with lineLocator', () => {
  assert.deepEqual(core.tryJson('﻿{"a":1}'), { a: 1 });
  assert.equal(core.tryJson('{bad', 'fb'), 'fb');
  assert.equal(core.tryJson(null, 'fb'), 'fb');
  const d = tmp('json');
  fs.writeFileSync(path.join(d, 'ok.json'), '{"a":[1]}');
  fs.writeFileSync(path.join(d, 'bad.json'), '{"a":');
  assert.deepEqual(core.readJson(path.join(d, 'ok.json')), { a: [1] });
  assert.equal(core.readJson(path.join(d, 'bad.json'), 0), 0);
  assert.deepEqual(core.readJsonFile(path.join(d, 'ok.json')), { exists: true, value: { a: [1] } });
  assert.deepEqual(core.readJsonFile(path.join(d, 'missing.json')), { exists: false });
  const bad = core.readJsonFile(path.join(d, 'bad.json'));
  assert.ok(bad.exists && typeof bad.error === 'string' && !('value' in bad));
  assert.equal(core.oneLine('  a\n\t b  '), 'a b');
  assert.deepEqual([core.words(' a  b\nc '), core.words('')], [['a', 'b', 'c'], []]);
  assert.deepEqual([core.indentOf('  \tx'), core.indentOf('x')], [3, 0]);
  assert.deepEqual([core.plural(1, 'case'), core.plural(2, 'case'), core.plural(0, 'entry', 'entries')], ['case', 'cases', 'entries']);
  assert.deepEqual(['b', 'a', 'B'].sort(core.cmp), ['B', 'a', 'b']);
  const text = 'one\ntwo\n\nfour';
  const at = core.lineLocator(text);
  for (let i = -1; i <= text.length + 1; i++) assert.equal(core.lineOf(text, i), at(Math.max(i, 0)), `offset ${i}`);
  assert.equal(fm.lineLocator, core.lineLocator, 'frontmatter re-exports the core locator');
});

test('path helpers: isWithin, displayPath, normRel, isUnder, subPath, joinRel', () => {
  const root = path.resolve('/repo');
  assert.ok(core.isWithin(root, root) && !core.isWithin(root, root, { strict: true }));
  assert.ok(core.isWithin(root, path.join(root, '..notes', 'a')), 'a child named ..notes is inside');
  assert.ok(!core.isWithin(root, path.join(root, '..', 'x')) && !core.isWithin(root, path.resolve('/other')));
  assert.equal(core.displayPath(root, path.join(root, 'a', 'b.md')), 'a/b.md');
  assert.equal(core.displayPath(root, root), '.');
  assert.equal(core.displayPath(root, path.resolve('/home/u/.claude/settings.json')), core.toPosix(path.resolve('/home/u/.claude/settings.json')));
  assert.deepEqual(['././a/b/', './/a', '.\\a\\b', '.', null].map(core.normRel), ['a/b', 'a', 'a/b', '.', '']);
  assert.ok(core.isUnder('a/b', '.') && core.isUnder('a/b', 'a') && core.isUnder('a', 'a') && !core.isUnder('ab/c', 'a'));
  assert.deepEqual([core.subPath('a/b/c', 'a'), core.subPath('a', 'a'), core.subPath('x', '.')], ['b/c', '', 'x']);
  assert.deepEqual([core.joinRel('.', 'x'), core.joinRel('a', 'x'), core.joinRel('a', '')], ['x', 'a/x', '']);
});

test('file helpers: listDir, readFilePart; runId and tmpPath', () => {
  const d = tmp('part');
  fs.writeFileSync(path.join(d, 'f.txt'), 'head-middle-tail');
  fs.mkdirSync(path.join(d, 'sub'));
  assert.deepEqual(core.listDir(d).sort(), ['f.txt', 'sub']);
  assert.deepEqual(core.listDir(d, { types: true }).filter((e) => e.isDirectory()).map((e) => e.name), ['sub']);
  assert.deepEqual(core.listDir(path.join(d, 'missing')), []);
  assert.deepEqual(core.readFilePart(path.join(d, 'f.txt'), 4), { text: 'head', size: 16 });
  assert.deepEqual(core.readFilePart(path.join(d, 'f.txt'), 4, { fromEnd: true }), { text: 'tail', size: 16 });
  assert.deepEqual(core.readFilePart(path.join(d, 'f.txt'), 100), { text: 'head-middle-tail', size: 16 });
  assert.equal(core.readFilePart(path.join(d, 'missing'), 4), null);
  assert.match(core.runId('run'), /^run-\d{8}T\d{6}Z-[0-9a-f]{6}$/);
  assert.match(core.runId(), /^\d{8}T\d{6}Z-[0-9a-f]{6}$/);
  const p = core.tmpPath('/some/repo', 'out', 'abcdef0123456789');
  assert.equal(path.dirname(p), core.tmpRoot('/some/repo'));
  assert.match(path.basename(p), /^out-abcdef012345-[0-9a-f]{6}$/);
});

test('git: baseRef chain and resolveBase, ignoredPaths, lsFiles others, originUrl, workRoot, blobReader', () => {
  const { dir, g } = makeRepo({ 'a.txt': 'a\n', '.gitignore': 'ignored/\n*.log\n' });
  assert.deepEqual(git.baseRef(dir, null), { ref: 'main', tip: g('rev-parse', 'HEAD'), source: 'main' });
  g('checkout', '-q', '-b', 'feature');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'b\n');
  g('add', '-A');
  g('commit', '-q', '-m', 'b');
  const base = git.resolveBase(dir, null);
  assert.deepEqual([base.ref, base.source, base.sha], ['main', 'main', g('rev-parse', 'main')]);
  assert.equal(git.resolveBase(dir, 'feature').source, 'flag');
  assert.throws(() => git.baseRef(dir, 'no-such-ref'), (e) => e.exit === core.EXIT.USAGE);
  const ignored = git.ignoredPaths(dir, ['ignored/x', 'a.txt', 'z.log', 'z.log']);
  assert.deepEqual([...ignored].sort(), ['ignored/x', 'z.log']);
  assert.deepEqual(git.ignoredPaths(dir, []), new Set());
  fs.writeFileSync(path.join(dir, 'new.txt'), 'n\n');
  fs.writeFileSync(path.join(dir, 'x.log'), 'l\n');
  assert.deepEqual(git.lsFiles(dir).sort(), ['.gitignore', 'a.txt', 'b.txt']);
  assert.deepEqual(git.lsFiles(dir, [], { others: true }).sort(), ['.gitignore', 'a.txt', 'b.txt', 'new.txt']);
  assert.equal(git.originUrl(dir), null);
  g('remote', 'add', 'origin', ['https://user', 'secret@example.com/o/r.git'].join(':'));
  assert.equal(git.originUrl(dir), 'https://example.com/o/r.git');
  assert.equal(git.workRoot(path.join(dir)), fs.realpathSync.native(dir));
  const outside = tmp('noroot');
  assert.equal(git.workRoot(outside), fs.realpathSync.native(outside));
  fs.writeFileSync(path.join(dir, 'big.txt'), 'x'.repeat(100));
  fs.writeFileSync(path.join(dir, 'bin.dat'), Buffer.from([1, 0, 2]));
  g('add', '-A');
  g('commit', '-q', '-m', 'blobs');
  const pairs = [['HEAD', 'a.txt'], ['HEAD', 'big.txt'], ['HEAD', 'bin.dat'], ['HEAD', 'gone.txt'], ['main', 'a.txt']];
  const batched = git.blobReader(dir, { maxBytes: 50 });
  batched.prefetch(pairs);
  const single = git.blobReader(dir, { maxBytes: 50 });
  assert.deepEqual(pairs.map(([r, f]) => batched.read(r, f)), pairs.map(([r, f]) => single.read(r, f)));
  assert.deepEqual(pairs.map(([r, f]) => batched.read(r, f)), ['a\n', null, null, null, 'a\n']);
});

test('snapshot excludes a relocated state dir and an ignored one in one pass', () => {
  const { dir } = makeRepo({ 'a.txt': 'a\n', '.gitignore': 'st/\n' });
  for (const d of ['.adc', 'st', 'other']) {
    fs.mkdirSync(path.join(dir, d));
    fs.writeFileSync(path.join(dir, d, 'f'), d);
  }
  const snap = git.createSnapshot(dir, { exclude: ['.adc', 'st/', '.adc'] });
  const files = git.lsTree(dir, snap.commit);
  assert.deepEqual(files.sort(), ['.gitignore', 'a.txt', 'other/f']);
});

test('state: resolveSession, newestOpenSession reads the newest open file, ledgerFiles', () => {
  const sd = tmp('sess');
  assert.deepEqual(state.resolveSession(sd, 'abc-1'), { id: 'abc-1', source: 'flag' });
  assert.throws(() => state.resolveSession(sd, '-bad id'), (e) => e.exit === core.EXIT.USAGE);
  assert.equal(state.resolveSession(sd, null).source, 'generated');
  assert.match(state.resolveSession(sd, null).id, /^run-\d{8}T\d{6}Z-[0-9a-f]{6}$/);
  const write = (id, doc, ageS) => {
    const f = state.sessionFile(sd, id);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, typeof doc === 'string' ? doc : JSON.stringify(doc));
    const t = new Date(Date.now() - ageS * 1000);
    fs.utimesSync(f, t, t);
  };
  write('old', { session_id: 'old' }, 100);
  write('ended', { session_id: 'ended', ended: true }, 0);
  write('broken', '{', 1);
  write('mid', { session_id: 'mid' }, 50);
  assert.equal(state.newestOpenSession(sd).id, 'mid');
  const r = state.resolveSession(sd, null);
  assert.deepEqual([r.id, r.source, r.record.session_id], ['mid', 'session-file', 'mid']);
  assert.equal(state.newestOpenSession(tmp('nosess')), null);
  assert.deepEqual(state.ledgerFiles(sd), []);
  fs.mkdirSync(path.join(sd, 'evidence'));
  fs.writeFileSync(path.join(sd, 'evidence', 'l.json'), '{}');
  fs.writeFileSync(path.join(sd, 'evidence', 'notes.txt'), '');
  assert.deepEqual(state.ledgerFiles(sd), [{ name: 'l.json', file: path.join(sd, 'evidence', 'l.json') }]);
  assert.match(String(state.SESSION_ID_RE), /A-Za-z0-9/);
});

test('markers.classifyPath: every LOCKFILE_MANAGERS name is a lockfile (never generated); isTestFile matches classifyPath', () => {
  for (const name of Object.keys(markers.LOCKFILE_MANAGERS)) {
    const c = markers.classifyPath(`sub/${name}`);
    assert.ok(c.lockfile && !c.generated, name);
  }
  assert.ok(!markers.classifyPath('package.json').lockfile);
  const cases = { 'src/a.test.ts': true, 'tests/test_x.py': true, 'pkg/x_test.go': true, './spec/a_spec.rb': true,
    'src/a.ts': false, 'tests/__snapshots__/a.test.ts.snap': false, 'tests/data.json': false };
  for (const [f, isTest] of Object.entries(cases)) {
    assert.equal(markers.classifyPath(f).test, isTest, f);
    // The path heuristic alone, without the default globs (which also claim tests/** data files).
    assert.equal(markers.isTestFile(f, { projects: [{ root: '.', test_globs: ['none/**'] }] }), isTest, f);
  }
});
