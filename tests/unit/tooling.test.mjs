// Tests for tooling.mjs and tooling-port.mjs (WP-J): context cost, port round trips with the
// documented loss list, scaffolds per kind and host, trigger sets (fake host CLIs; nothing is
// spent), the modify baseline/compare loop and the migrations, and plugin init/check/test/release.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL = path.resolve(HERE, '..', '..', 'skills', 'agentic-developer-companion');
const ADC = path.join(SKILL, 'scripts', 'adc.mjs');
const P = await import('../../skills/agentic-developer-companion/scripts/lib/tooling-port.mjs');
const T = await import('../../skills/agentic-developer-companion/scripts/lib/tooling.mjs');
const { which } = await import('../../skills/agentic-developer-companion/scripts/lib/core.mjs');
const LINT_AVAILABLE = fs.existsSync(path.join(SKILL, 'scripts', 'lib', 'tooling-lint.mjs'));
const CLAUDE = which('claude');
// Real host CLIs run their free load checks when they are on PATH (nothing is installed or spent).
const COPILOT = which('copilot');
const CODEX = which('codex');
const TL = LINT_AVAILABLE ? await import('../../skills/agentic-developer-companion/scripts/lib/tooling-lint.mjs') : null;

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 }); });

function write(dir, rel, content) {
  const f = path.join(dir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n');
  return f;
}
const read = (dir, rel) => fs.readFileSync(path.join(dir, ...rel.split('/')), 'utf8');
const has = (dir, rel) => fs.existsSync(path.join(dir, ...rel.split('/')));
const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8' });

function tmpRepo(files = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'adc-tooling-')));
  dirs.push(dir);
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.invalid']);
  git(dir, ['config', 'user.name', 'Test']);
  for (const [rel, content] of Object.entries(files)) write(dir, rel, content);
  return dir;
}

function commitAll(dir) {
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'fixture', '--no-gpg-sign']);
}

function adc(cwd, ...args) {
  return adcEnv(null, cwd, ...args);
}

/** adc.mjs with extra environment variables (e.g. ADC_COPILOT_CLI pointing at a fake host CLI). */
function adcEnv(env, cwd, ...args) {
  const res = spawnSync(process.execPath, [ADC, ...args, '--json', '--cwd', cwd], { encoding: 'utf8', timeout: 120_000, env: env ? { ...process.env, ...env } : process.env });
  let json = null;
  try { json = JSON.parse(res.stdout); } catch {}
  return { exit: res.status, json, stdout: res.stdout, stderr: res.stderr };
}

/** In-process call of the tooling group (faster than a subprocess). */
async function tool(cwd, ...args) {
  return T.toolingCommand([...args, '--cwd', cwd]);
}

const SKILL_MD = (name, description, extra = '') => `---\nname: ${name}\ndescription: ${description}\n${extra}metadata:\n  version: "0.1.0"\n---\n\n# ${name}\n\nSteps for ${name}.\n`;

// Fake host CLIs: they "trigger" the skill under test when a 5+ letter word of the query occurs
// in the skill description found in the workspace, and print each host's event format.
const FAKE_CLAUDE = `import fs from 'node:fs'; import path from 'node:path';
const argv = process.argv.slice(2);
const q = argv[argv.indexOf('-p') + 1] || '';
if (process.env.FAKE_FAIL === '1') { process.stderr.write('boom\\n'); process.exit(1); }
const dir = path.join(process.cwd(), '.claude', 'skills');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const skills = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
out({ type: 'system', subtype: 'init', skills });
const words = q.toLowerCase().match(/[a-z]{5,}/g) || [];
for (const s of skills) {
  const desc = (/^description:\\s*(.*)$/m.exec(fs.readFileSync(path.join(dir, s, 'SKILL.md'), 'utf8')) || [, ''])[1].toLowerCase();
  if (words.some((w) => desc.includes(w))) out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Skill', input: { skill: s } }] } });
}
out({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.001 });
`;
const FAKE_CODEX = `import fs from 'node:fs'; import path from 'node:path';
const q = process.argv[process.argv.length - 1];
const dir = path.join(process.cwd(), '.agents', 'skills');
const words = q.toLowerCase().match(/[a-z]{5,}/g) || [];
for (const s of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
  const desc = (/^description:\\s*(.*)$/m.exec(fs.readFileSync(path.join(dir, s, 'SKILL.md'), 'utf8')) || [, ''])[1].toLowerCase();
  if (words.some((w) => desc.includes(w))) process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'cat .agents/skills/' + s + '/SKILL.md' } }) + '\\n');
}
process.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\\n');
`;
const FAKE_COPILOT = `import fs from 'node:fs'; import path from 'node:path';
const argv = process.argv.slice(2);
const q = argv[argv.indexOf('-p') + 1] || '';
const share = argv[argv.indexOf('--share') + 1];
const dir = path.join(process.cwd(), '.github', 'skills');
const words = q.toLowerCase().match(/[a-z]{5,}/g) || [];
let lines = ['# Session', '', '> ' + q];
for (const s of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
  const desc = (/^description:\\s*(.*)$/m.exec(fs.readFileSync(path.join(dir, s, 'SKILL.md'), 'utf8')) || [, ''])[1].toLowerCase();
  if (words.some((w) => desc.includes(w))) lines.push('Loaded skill: ' + s);
}
if (share) fs.writeFileSync(share, lines.join('\\n'));
process.stdout.write(JSON.stringify({ type: 'assistant.message', content: 'ok' }) + '\\n');
`;

// Host CLIs for the free load checks and rendered-context snapshots. The Copilot fake answers
// `--plugin-dir <d> skill list --json` and `instruction list --json`; the Codex fake keeps its
// marketplace and installs in CODEX_HOME and renders `debug prompt-input` from them.
const FAKE_COPILOT_LIST = `import fs from 'node:fs'; import path from 'node:path';
const argv = process.argv.slice(2);
const out = (o) => process.stdout.write(JSON.stringify(o, null, 2) + '\\n');
if (argv.includes('instruction')) {
  const rows = fs.existsSync('AGENTS.md') ? [{ id: 'model-agents-md', label: 'AGENTS.md', location: 'repository', type: 'model', sourcePath: 'AGENTS.md', bytes: fs.statSync('AGENTS.md').size }] : [];
  out(rows); process.exit(0);
}
const k = argv.indexOf('--plugin-dir');
const rows = [{ name: 'builtin-thing', source: 'builtin', path: '/x', enabled: true }];
if (k >= 0 && process.env.FAKE_EMPTY !== '1') {
  const d = argv[k + 1];
  for (const s of fs.existsSync(path.join(d, 'skills')) ? fs.readdirSync(path.join(d, 'skills')) : []) rows.push({ name: s, description: 'd', source: 'plugin', path: path.join(d, 'skills', s), enabled: true });
}
process.stderr.write('warning: not signed in\\n');
out(rows);
`;
const FAKE_CODEX_HOST = `import fs from 'node:fs'; import path from 'node:path';
const argv = process.argv.slice(2);
const home = process.env.CODEX_HOME;
const state = path.join(home, 'fake.json');
const st = fs.existsSync(state) ? JSON.parse(fs.readFileSync(state, 'utf8')) : { mkts: {}, installed: [] };
const save = () => fs.writeFileSync(state, JSON.stringify(st));
if (argv[0] === 'plugin' && argv[1] === 'marketplace' && argv[2] === 'add') {
  const root = path.resolve(argv[3]);
  const f = ['.agents/plugins/marketplace.json', '.claude-plugin/marketplace.json'].map((x) => path.join(root, x)).find((x) => fs.existsSync(x));
  if (!f) { process.stderr.write('no marketplace\\n'); process.exit(1); }
  const m = JSON.parse(fs.readFileSync(f, 'utf8'));
  st.mkts[m.name] = { root, plugins: m.plugins }; save();
  process.stdout.write('Added marketplace \\u0060' + m.name + '\\u0060 from ' + root + '.\\n'); process.exit(0);
}
if (argv[0] === 'plugin' && argv[1] === 'add') {
  const [n, m] = argv[2].split('@');
  const e = st.mkts[m] && st.mkts[m].plugins.find((p) => p.name === n);
  if (!e) { process.stderr.write('plugin not found\\n'); process.exit(1); }
  st.installed.push({ name: n, dir: path.resolve(st.mkts[m].root, typeof e.source === 'string' ? e.source : e.source.path) }); save(); process.exit(0);
}
if (argv[0] === 'debug' && argv[1] === 'prompt-input') {
  const lines = ['<skills_instructions>', '## Skills'];
  for (const p of st.installed) for (const s of fs.existsSync(path.join(p.dir, 'skills')) ? fs.readdirSync(path.join(p.dir, 'skills')) : []) lines.push('- ' + p.name + ':' + s + ': d (file: r1/' + s + '/SKILL.md)');
  const texts = [{ type: 'input_text', text: lines.join('\\n') + '\\n</skills_instructions>' }];
  if (fs.existsSync('AGENTS.md')) texts.push({ type: 'input_text', text: '# AGENTS.md instructions for ' + process.cwd() + '\\n\\n<INSTRUCTIONS>\\n' + fs.readFileSync('AGENTS.md', 'utf8') + '</INSTRUCTIONS>' });
  texts.push({ type: 'input_text', text: '<environment_context><current_date>' + new Date().toISOString() + '</current_date></environment_context>' });
  process.stdout.write(JSON.stringify([{ type: 'message', role: 'user', content: texts }], null, 2) + '\\n'); process.exit(0);
}
process.stderr.write('unsupported\\n'); process.exit(2);
`;

function fakeCli(dir, name, src) {
  return write(dir, `.fake/${name}.mjs`, src);
}

const POSITIVE = ['write release notes for version two', 'summarize merged pull requests for the release', 'prepare release notes for customers',
  'draft the changelog summary', 'generate release notes please', 'release notes for the mobile app', 'compile the changelog from merged work',
  'what changed since the last release, as notes', 'turn merged pull requests into notes', 'need release notes for the sprint'];
const NEGATIVE = ['fix the login bug', 'add a unit test to the parser', 'refactor the api client', 'explain how promises work', 'rename the variable foo',
  'update the dependency pins', 'write a dockerfile', 'speed up the build', 'review my css', 'translate this sentence'];

function triggerSetFile(name) {
  return { schema: 'adc-trigger-set/1', skill: name, queries: [
    ...POSITIVE.map((q, i) => ({ id: `pos-${i + 1}`, should_trigger: true, query: q })),
    ...NEGATIVE.map((q, i) => ({ id: `neg-${i + 1}`, should_trigger: false, query: q })),
  ] };
}

// ---------------------------------------------------------------------------

describe('frontmatter and YAML subset', () => {
  test('parses maps, lists, flow, quoted, folded, literal and multi-line plain scalars', () => {
    const y = 'name: x\ndescription: >-\n  one\n  two\n\n  three\ntools: [\'read\', "search", edit]\nlist:\n  - a\n  - "b: c"\nnested:\n  version: "0.1.0"\n  k: v\nlit: |\n  a\n    b\nplain: is\n  continued\nflag: true\nnone:\nd2: Build for AWS: ECS # comment\nhandoffs:\n  - label: Plan\n    send: true\n';
    const r = P.parseYamlLocal(y);
    assert.deepEqual(r.errors, []);
    assert.equal(r.value.description, 'one two\nthree');
    assert.deepEqual(r.value.tools, ['read', 'search', 'edit']);
    assert.deepEqual(r.value.list, ['a', 'b: c']);
    assert.equal(r.value.nested.version, '0.1.0');
    assert.equal(r.value.lit, 'a\n  b\n');
    assert.equal(r.value.plain, 'is continued');
    assert.equal(r.value.flag, true);
    assert.equal(r.value.none, null);
    assert.equal(r.value.d2, 'Build for AWS: ECS');
    assert.deepEqual(r.value.handoffs, [{ label: 'Plan', send: true }]);
  });

  test('stringify round-trips and quotes what plain YAML would change', () => {
    const data = { name: 'x', description: 'a'.repeat(50) + ' ' + 'b'.repeat(60), version: '1.10', yes: 'yes', glob: '**/*.ts', applyTo: 'src/**', paths: ['src/**'], meta: { 'short-description': 'Hi: there' }, list: ['read'], multi: 'l1\nl2' };
    const text = P.stringifyFrontmatter(data, { flowKeys: ['list'] }) + 'body\n';
    assert.match(text, /version: "1\.10"/);
    assert.match(text, /yes: "yes"/);
    assert.match(text, /glob: "\*\*\/\*\.ts"/);
    assert.match(text, /applyTo: "src\/\*\*"/);
    assert.match(text, /- "src\/\*\*"/);
    assert.match(text, /description: >-/);
    const back = P.readFrontmatter(text);
    assert.deepEqual(back.data, data);
    assert.equal(back.body, 'body\n');
  });

  test('reports bad YAML and unterminated frontmatter', () => {
    assert.ok(P.parseYamlLocal('a: [unclosed').errors.length > 0);
    assert.ok(P.parseYamlLocal('a: b\n   c: d\n').errors.length > 0);
    assert.ok(P.readFrontmatter('---\nname: x\n').errors.length > 0);
    assert.equal(P.readFrontmatter('# no frontmatter\n').hasFrontmatter, false);
    assert.equal(P.readFrontmatter('\ufeff---\r\nname: x\r\n---\r\nbody').data.name, 'x');
  });
});

describe('command lines, tools, classification', () => {
  test('splits simple commands and refuses shell syntax', () => {
    assert.deepEqual(P.splitSimpleCommand('node "${CLAUDE_PROJECT_DIR}/x.mjs" --a b'), ['node', '${CLAUDE_PROJECT_DIR}/x.mjs', '--a', 'b']);
    assert.deepEqual(P.splitSimpleCommand("node 'a b' $HOME/c"), ['node', 'a b', '${HOME}/c']);
    for (const bad of ['a && b', 'a | b', 'a > f', 'X=1 node a', 'echo `x`', 'ls *.js', 'a; b', '']) assert.equal(P.splitSimpleCommand(bad), null, bad);
  });

  test('renders argv for sh, PowerShell and cmd', () => {
    const argv = ['node', '${PLUGIN_ROOT}/x.mjs', "it's", '--flag', 'a b'];
    assert.equal(P.joinPosix(argv), `node "\${PLUGIN_ROOT}/x.mjs" 'it'\\''s' --flag 'a b'`);
    assert.equal(P.joinPowerShell(argv), `node "$env:PLUGIN_ROOT/x.mjs" 'it''s' --flag 'a b'`);
    assert.equal(P.joinCmd(argv), 'node %PLUGIN_ROOT%/x.mjs "it\'s" --flag "a b"');
    assert.equal(P.joinPowerShell(['C:/Program Files/node.exe', 'x']), "& 'C:/Program Files/node.exe' x");
  });

  test('maps agent tools between Copilot aliases and Claude names', () => {
    const c = P.toolsCopilotToCanonical(['read', 'search', 'edit', 'execute', 'web', 'github/*', 'gh/issue_read']);
    assert.deepEqual(c.tools, ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash', 'WebFetch', 'WebSearch', 'mcp__github__*', 'mcp__gh__issue_read']);
    const back = P.toolsCanonicalToCopilot(c.tools);
    assert.deepEqual(back.tools, ['read', 'search', 'edit', 'execute', 'web', 'github/*', 'gh/issue_read']);
    assert.equal(P.toolsCopilotToCanonical(['*']).tools, null);
    assert.deepEqual(P.toolsCanonicalToCopilot(['AskUserQuestion']).unmapped, ['AskUserQuestion']);
  });

  test('classifies tooling files by location', () => {
    const cases = {
      '.github/copilot-instructions.md': ['instructions', 'copilot'], 'AGENTS.md': ['instructions', 'portable'], 'src/AGENTS.md': ['scoped', 'codex'],
      'CLAUDE.md': ['instructions', 'claude'], '.github/instructions/a.instructions.md': ['scoped', 'copilot'], '.claude/rules/a.md': ['scoped', 'claude'],
      '.github/agents/r.agent.md': ['agent', 'copilot'], '.claude/agents/r.md': ['agent', 'claude'], '.github/prompts/p.prompt.md': ['prompt', 'copilot'],
      '.github/chatmodes/m.chatmode.md': ['chatmode', 'copilot'], '.claude/commands/a/b.md': ['command', 'claude'],
      '.claude/skills/s/SKILL.md': ['skill', 'claude'], '.agents/skills/s/SKILL.md': ['skill', 'codex'], '.github/skills/s/SKILL.md': ['skill', 'copilot'],
      'skills/s/SKILL.md': ['skill', 'portable'], '.claude/skills/s/references/r.md': ['skill-file', 'claude'], '.github/hooks/h.json': ['hooks', 'copilot'],
      '.claude/settings.json': ['hooks', 'claude'], '.codex/hooks.json': ['hooks', 'codex'], '.mcp.json': ['mcp', 'claude'], '.vscode/mcp.json': ['mcp', 'vscode'],
      '.codex/config.toml': ['mcp', 'codex'], '.claude-plugin/plugin.json': ['plugin', 'claude'],
    };
    for (const [p, [kind, host]] of Object.entries(cases)) {
      const c = P.classifyArtifact(p);
      assert.ok(c, p);
      assert.equal(c.kind, kind, p);
      assert.equal(c.host, host, p);
    }
    assert.deepEqual(P.classifyArtifact('.claude/skills/s/SKILL.md').hosts, ['claude', 'copilot']);
    assert.equal(P.classifyArtifact('src/index.ts'), null);
  });

  test('skill and plugin name rules', () => {
    assert.deepEqual(P.skillNameProblems('good-name'), []);
    for (const bad of ['Bad', '-x', 'x-', 'a--b', 'my-claude-skill', '']) assert.ok(P.skillNameProblems(bad).length, bad);
    assert.equal(P.toSkillName('Frontend/Component Thing'), 'frontend-component-thing');
    assert.deepEqual(T.pluginNameProblems('demo-tools').errors, []);
    assert.ok(T.pluginNameProblems('claude-tools').errors.length);
    assert.ok(T.pluginNameProblems('my.tools').errors.some((e) => /kebab/.test(e)));
    assert.ok(T.pluginNameProblems('tools-for-claude').warnings.length);
  });
});

describe('tooling port', () => {
  test('agents round-trip Copilot -> Claude -> Copilot with the documented losses; Codex gets a skill', async () => {
    const src = '---\nname: reviewer\ndescription: Reviews diffs for missing tests.\ntools: [\'read\', \'search\', \'edit\']\nmodel: GPT-5\nhandoffs:\n  - label: Fix\n    agent: fixer\nuser-invocable: true\n---\n\nYou review diffs.\n';
    const dir = tmpRepo({ '.github/agents/reviewer.agent.md': src });
    const r = await P.port({ path: '.github/agents/reviewer.agent.md', root: dir, to: 'all' });
    // Codex gets a skill in .codex/skills: Copilot also reads .agents/skills and would see it twice.
    assert.deepEqual(r.written.map((w) => w.path).sort(), ['.claude/agents/reviewer.md', '.codex/skills/reviewer/SKILL.md', '.codex/skills/reviewer/agents/openai.yaml']);
    assert.ok(r.dropped_fields.some((d) => d.field === 'handoffs' && /Claude/.test(d.reason)));
    const claude = P.readFrontmatter(read(dir, '.claude/agents/reviewer.md'));
    assert.equal(claude.data.tools, 'Read, Grep, Glob, Edit, Write');
    assert.equal(claude.data.omitClaudeMd, true);
    assert.equal(claude.body.trim(), 'You review diffs.');
    assert.match(read(dir, '.codex/skills/reviewer/agents/openai.yaml'), /default_prompt: .*\$reviewer/);
    assert.ok(r.manual_steps.some((m) => /unverified/.test(m)));
    // back to Copilot in a separate output tree
    const back = await P.port({ path: '.claude/agents/reviewer.md', root: dir, to: 'copilot', out: 'rt' });
    assert.deepEqual(back.written.map((w) => w.path), ['.github/agents/reviewer.agent.md']);
    const cp = P.readFrontmatter(read(dir, 'rt/.github/agents/reviewer.agent.md'));
    assert.deepEqual(cp.data.tools, ['read', 'search', 'edit']);
    assert.equal(cp.data.model, 'GPT-5');
    assert.equal(cp.data['user-invocable'], true);
    assert.equal(cp.data['include-custom-instructions'], undefined);
    assert.equal(cp.data.handoffs, undefined);
    assert.equal(cp.body, claude.body);
  });

  test('hooks round-trip Copilot -> Claude -> Codex -> Copilot; extras are reported', async () => {
    const hooks = { version: 1, hooks: { postToolUse: [{ type: 'command', bash: 'node scripts/check.mjs --x', powershell: 'node scripts/check.mjs --x', timeoutSec: 10, matcher: 'edit|create' }],
      sessionStart: [{ type: 'command', bash: './scripts/start.sh', powershell: '.\\scripts\\start.ps1', timeoutSec: 5 }], errorOccurred: [{ type: 'command', bash: 'node e.mjs', powershell: 'node e.mjs' }] } };
    const dir = tmpRepo({ '.github/hooks/check.json': hooks, 'scripts/check.mjs': 'process.stdout.write("{}")\n' });
    const r = await P.port({ path: '.github/hooks/check.json', root: dir, to: 'claude,codex' });
    assert.deepEqual(r.written.map((w) => w.path).sort(), ['.claude/settings.json', '.codex/hooks.json']);
    const claude = JSON.parse(read(dir, '.claude/settings.json'));
    const post = claude.hooks.PostToolUse[0];
    assert.equal(post.matcher, 'Edit|Write');
    // Copilot runs repository .claude/settings.json hooks in bash and PowerShell: no ${CLAUDE_PROJECT_DIR}.
    assert.equal(post.hooks[0].command, 'node scripts/check.mjs --x');
    assert.equal(post.hooks[0].timeout, 10);
    assert.ok(r.dropped_fields.some((d) => d.field === 'hooks.errorOccurred'), 'errorOccurred has no Claude/Codex event');
    assert.ok(r.dropped_fields.some((d) => d.field === 'powershell/commandWindows'), 'Claude keeps one command per hook');
    const codex = JSON.parse(read(dir, '.codex/hooks.json'));
    assert.equal(codex.hooks.PostToolUse[0].hooks[0].commandWindows, 'node scripts/check.mjs --x');
    assert.equal(codex.hooks.SessionStart[0].hooks[0].command, './scripts/start.sh');
    assert.ok(r.manual_steps.some((m) => /output shape/.test(m)));
    // Codex back to Copilot: identical to the original postToolUse entry
    const back = await P.port({ path: '.codex/hooks.json', root: dir, to: 'copilot', out: 'rt' });
    assert.equal(back.written[0].path, '.github/hooks/codex-hooks.json');
    const cp = JSON.parse(read(dir, 'rt/.github/hooks/codex-hooks.json'));
    assert.deepEqual(cp.hooks.postToolUse[0], hooks.hooks.postToolUse[0]);
    assert.equal(cp.version, 1);
    for (const list of Object.values(cp.hooks)) for (const e of list) assert.ok(!('command' in e), 'Copilot output never uses "command"');
    // Claude extras are reported when going to Copilot
    const cl = tmpRepo({ '.claude/settings.json': { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node', args: ['${CLAUDE_PROJECT_DIR}/g.mjs'], onFailure: 'block', if: 'Bash(git *)' }] }],
      Stop: [{ hooks: [{ type: 'prompt', prompt: 'check' }] }] } } });
    const r2 = await P.port({ path: '.claude/settings.json', root: cl, to: 'copilot' });
    const doc = JSON.parse(read(cl, '.github/hooks/claude-settings.json'));
    assert.equal(doc.hooks.preToolUse[0].bash, 'node g.mjs');
    assert.equal(doc.hooks.preToolUse[0].matcher, 'bash');
    assert.ok(r2.dropped_fields.some((d) => d.field === 'onFailure'));
    assert.ok(r2.dropped_fields.some((d) => d.field === 'if'));
    assert.ok(r2.dropped_fields.some((d) => /prompt/.test(d.reason)));
  });

  test('instructions: one source of truth per host, existing files need --force', async () => {
    const dir = tmpRepo({ '.github/copilot-instructions.md': '# Rules\n\n- Use 2-space indentation in TypeScript files.\n', 'AGENTS.md': '# Existing\n' });
    const r = await P.port({ path: '.github/copilot-instructions.md', root: dir, to: 'all' });
    assert.equal(read(dir, 'CLAUDE.md').split('\n').filter((l) => l === '@.github/copilot-instructions.md').length, 1);
    assert.deepEqual(r.skipped.map((s) => s.path), ['AGENTS.md']);
    assert.equal(read(dir, 'AGENTS.md'), '# Existing\n');
    const forced = await P.port({ path: '.github/copilot-instructions.md', root: dir, to: 'codex', force: true, backupDir: () => fs.mkdtempSync(path.join(dir, '.adc-bak-')) });
    assert.equal(forced.written[0].action, 'overwrite');
    assert.match(read(dir, 'AGENTS.md'), /2-space indentation/);
    assert.equal(forced.backups.length, 1);
    // AGENTS.md is native for Copilot; CLAUDE.md importing AGENTS.md is native for Codex
    const d2 = tmpRepo({ 'AGENTS.md': '# Shared\n\n- Run the whole suite.\n' });
    const r2 = await P.port({ path: 'AGENTS.md', root: d2, to: 'all' });
    assert.deepEqual(r2.written.map((w) => w.path), ['CLAUDE.md']);
    assert.ok(r2.notes.some((n) => /natively/.test(n)));
    const r3 = await P.port({ path: 'CLAUDE.md', root: d2, to: 'codex' });
    assert.deepEqual(r3.written, []);
    // idempotent: the same port again changes nothing
    const again = await P.port({ path: 'AGENTS.md', root: d2, to: 'claude' });
    assert.equal(again.written[0].action, 'unchanged');
    // A hand-written CLAUDE.md that already imports AGENTS.md is left alone (no second import).
    const d3 = tmpRepo({ 'AGENTS.md': '# Shared\n', 'CLAUDE.md': '@AGENTS.md\n\n- Claude-only note.\n' });
    const own = await P.port({ path: 'AGENTS.md', root: d3, to: 'claude' });
    assert.deepEqual([own.written[0].action, own.skipped.length], ['unchanged', 0]);
    assert.ok(r.manual_steps.some((m) => /load twice in Copilot/.test(m)), 'AGENTS.md generated from copilot-instructions.md duplicates rules in Copilot');
  });

  test('scoped rules: applyTo <-> paths round trip; Codex gets directory AGENTS.md sections', async () => {
    const dir = tmpRepo({ '.github/instructions/api.instructions.md': '---\napplyTo: "src/api/**/*.ts,src/api/**"\ndescription: API rules\nexcludeAgent: "code-review"\n---\n\n- Validate request bodies.\n' });
    const r = await P.port({ path: '.github/instructions/api.instructions.md', root: dir, to: 'claude,codex' });
    const rule = P.readFrontmatter(read(dir, '.claude/rules/api.md'));
    assert.deepEqual(rule.data.paths, ['src/api/**/*.ts', 'src/api/**']);
    assert.ok(r.dropped_fields.some((d) => d.field === 'excludeAgent'));
    assert.ok(r.dropped_fields.some((d) => d.field === 'applyTo' && d.value === 'src/api/**/*.ts' && /directory only/.test(d.reason)));
    assert.match(read(dir, 'src/api/AGENTS.md'), /<!-- adc:port begin \.github\/instructions\/api\.instructions\.md -->[\s\S]*Validate request bodies/);
    const back = await P.port({ path: '.claude/rules/api.md', root: dir, to: 'copilot', out: 'rt' });
    assert.equal(back.written.length, 1);
    const cp = P.readFrontmatter(read(dir, 'rt/.github/instructions/api.instructions.md'));
    assert.equal(cp.data.applyTo, 'src/api/**/*.ts,src/api/**');
    assert.equal(cp.data.description, 'API rules');
    assert.equal(cp.body.trim(), '- Validate request bodies.');
    const again = await P.port({ path: '.github/instructions/api.instructions.md', root: dir, to: 'codex', force: true });
    assert.equal(again.written[0].action, 'unchanged', 'marker sections are replaced, not duplicated');
  });

  test('MCP: VS Code inputs become env references; Codex TOML keeps env forwarding and bearer tokens', async () => {
    const vs = { inputs: [{ id: 'api-key', type: 'promptString', password: true }], servers: {
      docs: { type: 'stdio', command: 'npx', args: ['-y', 'docs-mcp@1.2.3'], env: { API_KEY: '${input:api-key}' }, envFile: '.env' },
      remote: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer ${input:api-key}', 'X-Tenant': 'public' } } } };
    const dir = tmpRepo({ '.vscode/mcp.json': vs });
    const r = await P.port({ path: '.vscode/mcp.json', root: dir, to: 'claude,copilot,codex' });
    const claude = JSON.parse(read(dir, '.mcp.json'));
    assert.equal(claude.mcpServers.docs.env.API_KEY, '${API_KEY}');
    assert.equal(claude.mcpServers.remote.headers.Authorization, 'Bearer ${API_KEY}');
    assert.ok(r.dropped_fields.some((d) => /envFile/.test(d.field)));
    assert.ok(r.manual_steps.some((m) => /API_KEY/.test(m)));
    const copilot = JSON.parse(read(dir, '.github/mcp.json'));
    assert.equal(copilot.mcpServers.docs.type, 'local');
    assert.deepEqual(copilot.mcpServers.docs.tools, ['*']);
    assert.ok(r.manual_steps.some((m) => /cloud agent/.test(m)));
    const toml = read(dir, '.codex/config.toml');
    assert.match(toml, /\[mcp_servers\.docs\]\ncommand = "npx"\nargs = \["-y", "docs-mcp@1\.2\.3"\]\nenv_vars = \["API_KEY"\]/);
    assert.match(toml, /bearer_token_env_var = "API_KEY"/);
    assert.match(toml, /http_headers = \{ X-Tenant = "public" \}/);
    const parsed = P.parseTomlLite(toml).value;
    assert.deepEqual(parsed.mcp_servers.docs.args, ['-y', 'docs-mcp@1.2.3']);
    const back = await P.port({ path: '.codex/config.toml', root: dir, to: 'claude', out: 'rt' });
    assert.equal(back.written.length, 1);
    const rt = JSON.parse(read(dir, 'rt/.mcp.json'));
    assert.equal(rt.mcpServers.docs.env.API_KEY, '${API_KEY}');
    assert.equal(rt.mcpServers.remote.headers.Authorization, 'Bearer ${API_KEY}');
    const ap = P.renderMcpConfig(P.parseMcpConfig(JSON.stringify(claude), 'mcpServers').servers, 'agent-plugins');
    assert.equal(ap.doc.$schema, 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json');
    assert.equal(ap.doc.mcpServers.remote.type, 'streamable-http');
    assert.ok(ap.dropped.some((d) => /headers/.test(d.field)), 'Agent Plugins never expands header variables');
  });

  test('prompt files and commands become skills; skills copy to other hosts', async () => {
    const dir = tmpRepo({
      '.github/prompts/release.prompt.md': '---\ndescription: Draft release notes\nagent: agent\nmodel: GPT-5\ntools: [\'githubRepo\']\nargument-hint: version\n---\n\nDraft notes for ${input:version} from #file:CHANGELOG.md.\n',
      '.claude/commands/frontend/component.md': '---\ndescription: Create a component\nallowed-tools: Bash(npm run *)\n---\n\nCreate $ARGUMENTS.\n',
      '.claude/skills/user-only/SKILL.md': SKILL_MD('user-only', 'Runs the release checklist on request.', 'disable-model-invocation: true\nwhen_to_use: on request\n'),
    });
    const r = await P.port({ path: '.github/prompts/release.prompt.md', root: dir, to: 'copilot' });
    const sk = P.readFrontmatter(read(dir, '.github/skills/release/SKILL.md'));
    assert.equal(sk.data['disable-model-invocation'], true);
    assert.equal(sk.data['argument-hint'], 'version');
    assert.deepEqual(r.dropped_fields.map((d) => d.field).sort(), ['agent', 'model', 'tools']);
    assert.ok(r.manual_steps.some((m) => m.includes('${input:version}') && m.includes('#file:CHANGELOG.md')));
    const c = await P.port({ path: '.claude/commands/frontend/component.md', root: dir, to: 'claude,codex' });
    assert.ok(has(dir, '.claude/skills/frontend-component/SKILL.md'));
    assert.match(read(dir, '.agents/skills/frontend-component/agents/openai.yaml'), /allow_implicit_invocation: true/);
    assert.ok(c.manual_steps.some((m) => /Claude-only placeholders/.test(m)));
    const s = await P.port({ path: '.claude/skills/user-only', root: dir, to: 'codex' });
    assert.ok(has(dir, '.agents/skills/user-only/SKILL.md'));
    assert.match(read(dir, '.agents/skills/user-only/agents/openai.yaml'), /allow_implicit_invocation: false/);
    assert.ok(s.dropped_fields.some((d) => d.field === 'when_to_use' && /ignores/.test(d.reason)));
  });

  test('dry run writes nothing; CLI reports usage errors', async () => {
    const dir = tmpRepo({ '.github/agents/a.agent.md': '---\ndescription: d\n---\nbody\n' });
    const r = await P.port({ path: '.github/agents/a.agent.md', root: dir, to: 'claude', dryRun: true });
    assert.equal(r.written[0].action, 'would-create');
    assert.equal(has(dir, '.claude/agents/a.md'), false);
    const e2e = adc(dir, 'tooling', 'port', '.github/agents/a.agent.md', '--to', 'claude');
    assert.equal(e2e.exit, 0, e2e.stderr);
    assert.equal(e2e.json.written[0].path, '.claude/agents/a.md');
    assert.equal(adc(dir, 'tooling', 'port', 'README.md').exit, 2);
    assert.equal(adc(dir, 'tooling', 'port', '.github/agents/a.agent.md', '--to', 'cursor').exit, 2);
  });
});

describe('tooling cost', () => {
  test('always-on tokens per host follow each host\'s loading rules', () => {
    const dir = tmpRepo({
      'AGENTS.md': '# Shared\n\n- Run the whole suite with `npm test` before reporting success.\n',
      'CLAUDE.md': '@AGENTS.md\n\n<!-- a long comment that Claude Code strips before loading -->\n',
      '.github/copilot-instructions.md': '- Copilot only.\n',
      '.github/instructions/api.instructions.md': '---\napplyTo: "src/api/**"\n---\n- api\n',
      '.claude/rules/all.md': '- always loaded rule\n',
      '.claude/skills/notes/SKILL.md': SKILL_MD('notes', 'Formats release notes. Use for release notes.'),
      '.claude/skills/notes/references/more.md': 'x'.repeat(400),
      '.agents/skills/hidden/SKILL.md': SKILL_MD('hidden', 'Runs only by name.'),
      '.agents/skills/hidden/agents/openai.yaml': 'policy:\n  allow_implicit_invocation: false\n',
      'package.json': { name: 'demo', scripts: { test: 'node --test' } },
    });
    const r = T.toolingCost({ root: dir });
    const f = Object.fromEntries(r.files.map((x) => [x.path, x]));
    assert.deepEqual(f['AGENTS.md'].hosts.sort(), ['claude', 'codex', 'copilot'], 'imported by CLAUDE.md');
    assert.equal(f['.github/instructions/api.instructions.md'].load, 'path-scoped');
    assert.equal(f['.claude/rules/all.md'].load, 'always');
    assert.equal(f['.claude/skills/notes/SKILL.md'].load, 'listing');
    assert.equal(f['.claude/skills/notes/references/more.md'].load, 'on-demand');
    assert.equal(f['.agents/skills/hidden/SKILL.md'].always_on_tokens.codex, 0, 'allow_implicit_invocation: false');
    assert.ok(f['CLAUDE.md'].always_on_tokens.claude < f['CLAUDE.md'].always_on_tokens.copilot, 'Claude strips HTML comments');
    assert.equal(r.totals.codex.always_on_tokens, f['AGENTS.md'].always_on_tokens.codex);
    const sum = (h) => r.files.reduce((a, x) => a + (x.always_on_tokens[h] || 0), 0);
    for (const h of ['copilot', 'claude', 'codex']) assert.equal(r.totals[h].always_on_tokens, sum(h));
    assert.ok(r.totals.claude.budgets.some((b) => b.id === 'claude-skill-listing' && b.ok));
    assert.equal(r.findings.length, 0, JSON.stringify(r.findings));
    // Without the import, Claude Code skips AGENTS.md when CLAUDE.md exists.
    write(dir, 'CLAUDE.md', '# Claude only\n');
    const r2 = T.toolingCost({ root: dir });
    assert.ok(!r2.files.find((x) => x.path === 'AGENTS.md').hosts.includes('claude'));
    // AGENTS.override.md shadows AGENTS.md for Codex.
    write(dir, 'AGENTS.override.md', '- local override\n');
    const r3 = T.toolingCost({ root: dir });
    assert.ok(!r3.files.find((x) => x.path === 'AGENTS.md').hosts.includes('codex'));
  });

  test('budgets, duplicated rules, stale commands and paths are findings', () => {
    const rule = '- Never delete or skip a failing test to make the suite pass.';
    const dir = tmpRepo({
      'AGENTS.md': `${rule}\n- Build with \`pnpm run build\`.\n- Read \`docs/missing.md\`.\n`,
      '.github/copilot-instructions.md': `${rule}\n`,
      'CLAUDE.md': Array.from({ length: 210 }, (_, i) => `- line ${i}`).join('\n') + '\n',
      'package.json': { name: 'demo', scripts: { test: 'node --test' } },
      'package-lock.json': '{}',
    });
    const r = T.toolingCost({ root: dir });
    const ids = r.findings.map((x) => x.id);
    assert.ok(ids.includes('OVER_BUDGET') && r.findings.some((x) => x.id === 'OVER_BUDGET' && /claude-md-lines/.test(x.message)));
    assert.ok(r.findings.some((x) => x.id === 'DUPLICATE_RULE' && x.host === 'copilot'));
    assert.ok(r.findings.some((x) => x.id === 'STALE_COMMAND' && /lockfile belongs to npm/.test(x.message)));
    assert.ok(r.findings.some((x) => x.id === 'STALE_COMMAND' && /does not define/.test(x.message)));
    assert.ok(r.findings.some((x) => x.id === 'STALE_PATH' && x.evidence === 'docs/missing.md'));
    // No STALE_PATH for state files, ignored build output, directories or reference documentation.
    write(dir, '.gitignore', 'dist/\n');
    write(dir, 'AGENTS.md', '- Read `.adc/detect.json`, `dist/bundle.js` and `docs/`.\n');
    write(dir, '.claude/skills/notes/SKILL.md', SKILL_MD('notes', 'Formats release notes. Use for release notes.'));
    write(dir, '.claude/skills/notes/references/more.md', '- Example: `src/example/file.ts`\n');
    assert.deepEqual(T.toolingCost({ root: dir }).findings.filter((x) => x.id === 'STALE_PATH'), []);
  });

  test('CLI: --max-tokens turns an over-budget host into exit 1', () => {
    const dir = tmpRepo({ 'AGENTS.md': '- rule\n'.repeat(200) });
    const ok = adc(dir, 'tooling', 'cost');
    assert.equal(ok.exit, 0, ok.stderr);
    assert.ok(ok.json.totals.codex.always_on_tokens > 100);
    const over = adc(dir, 'tooling', 'cost', '--max-tokens', '50');
    assert.equal(over.exit, 1);
    // No CLAUDE.md, so Claude Code reads AGENTS.md as well (v2.1.277+).
    assert.deepEqual(over.json.over_max.sort(), ['claude', 'codex', 'copilot']);
    assert.equal(adc(dir, 'tooling', 'cost', '--host', 'cursor').exit, 2);
  });
});

describe('tooling scaffold', () => {
  test('every kind for every host produces valid files; dry run writes nothing', async () => {
    const dir = tmpRepo({ 'package.json': { name: 'sc-app', scripts: { test: 'node --test', lint: 'eslint .' } }, 'package-lock.json': '{}' });
    const desc = 'Formats release notes from merged pull requests. Use when the user asks for release notes. Not for code changes.';
    const dry = await T.scaffoldTooling('skill', { values: { for: 'all', name: 'notes', description: desc, cwd: dir } });
    assert.equal(dry.dry_run, true);
    assert.ok(dry.written.every((w) => w.action === 'would-create'));
    assert.equal(has(dir, '.agents/skills/notes/SKILL.md'), false);
    for (const kind of ['instructions', 'skill', 'agent', 'prompt', 'hooks', 'mcp']) {
      for (const host of ['copilot', 'claude', 'codex', 'all']) {
        const out = path.join(dir, `out-${kind}-${host}`);
        const res = await T.scaffoldTooling(kind, { values: { for: host, name: `demo-${kind}`, description: desc, out, write: true, cwd: dir } });
        assert.equal(res.dry_run, false);
        assert.ok(res.written.length > 0, `${kind}/${host}`);
        for (const w of res.written) {
          const file = path.join(out, ...w.path.split('/'));
          const text = fs.readFileSync(file, 'utf8');
          assert.ok(!/\{\{[A-Za-z_]+\}\}/.test(text), `unrendered placeholder in ${w.path}`);
          if (file.endsWith('.json')) JSON.parse(text);
          if (file.endsWith('.toml')) assert.deepEqual(P.parseTomlLite(text).errors, []);
          if (/\.md$/.test(file) && text.startsWith('---')) assert.deepEqual(P.readFrontmatter(text).errors, [], w.path);
          if (file.endsWith('SKILL.md')) {
            const fm = P.readFrontmatter(text);
            assert.equal(fm.data.name, path.basename(path.dirname(file)), 'name == directory');
            assert.ok(String(fm.data.description).length <= 1024);
          }
          if (/\.github\/hooks\/.+\.json$/.test(w.path)) {
            const doc = JSON.parse(text);
            assert.equal(doc.version, 1);
            for (const list of Object.values(doc.hooks)) for (const e of list) { assert.ok(e.bash && e.powershell); assert.ok(!('command' in e)); assert.ok(e.timeoutSec <= 30); }
          }
          if (w.path === '.codex/hooks.json') for (const g of Object.values(JSON.parse(text).hooks)) assert.ok(g[0].hooks[0].commandWindows);
        }
      }
    }
    const all = path.join(dir, 'out-skill-all');
    assert.ok(fs.existsSync(path.join(all, '.agents', 'skills', 'demo-skill', 'agents', 'openai.yaml')));
    assert.ok(fs.existsSync(path.join(all, '.claude', 'skills', 'demo-skill', 'evals', 'trigger-set.json')));
    assert.ok(fs.existsSync(path.join(all, '.claude', 'skills', 'demo-skill', 'evals', 'demo-skill-basic', 'graders', 'skill-used.md')));
    assert.match(fs.readFileSync(path.join(dir, 'out-instructions-all', 'CLAUDE.md'), 'utf8'), /^@AGENTS\.md$/m);
    assert.match(fs.readFileSync(path.join(dir, 'out-instructions-all', 'AGENTS.md'), 'utf8'), /`npm test`/);
    assert.equal(P.readFrontmatter(fs.readFileSync(path.join(dir, 'out-prompt-claude', '.claude', 'skills', 'demo-prompt', 'SKILL.md'), 'utf8')).data['disable-model-invocation'], true);
    assert.ok(fs.existsSync(path.join(dir, 'out-agent-codex', '.codex', 'skills', 'demo-agent', 'agents', 'openai.yaml')));
  });

  test('never overwrites without --force; --force merges JSON with a backup', async () => {
    const dir = tmpRepo({ '.claude/settings.json': { permissions: { allow: ['Read'] } } });
    const first = await T.scaffoldTooling('hooks', { values: { for: 'claude', name: 'guard', write: true, cwd: dir } });
    assert.deepEqual(first.skipped.map((s) => s.path), ['.claude/settings.json']);
    assert.deepEqual(JSON.parse(read(dir, '.claude/settings.json')), { permissions: { allow: ['Read'] } });
    const forced = await T.scaffoldTooling('hooks', { values: { for: 'claude', name: 'guard', write: true, force: true, cwd: dir } });
    assert.ok(forced.written.some((w) => w.path === '.claude/settings.json' && w.action === 'merge'));
    const merged = JSON.parse(read(dir, '.claude/settings.json'));
    assert.deepEqual(merged.permissions, { allow: ['Read'] });
    assert.equal(merged.hooks.PostToolUse[0].hooks[0].command, 'node scripts/hooks/guard.mjs --dialect claude --event PostToolUse');
    assert.equal(forced.backups.length, 1);
    assert.match(forced.backups[0], /\.adc\/tooling\/backups\//);
    assert.ok(fs.existsSync(forced.backups[0]));
  });

  test('scaffolds lint clean; skill-creator evals.json, excludeAgent and skill preloads', async () => {
    const dir = tmpRepo({ 'package.json': { name: 'lint-app', scripts: { test: 'node --test' } } });
    const desc = 'Formats release notes from merged pull requests. Use when the user asks for release notes. Not for code changes.';
    for (const kind of ['instructions', 'skill', 'agent', 'prompt', 'hooks', 'mcp']) {
      for (const host of ['copilot', 'claude', 'codex', 'all']) {
        const out = path.join(dir, `lint-${kind}-${host}`);
        const res = await T.scaffoldTooling(kind, { values: { for: host, name: `demo-${kind}`, description: desc, out, write: true, cwd: dir } });
        if (!TL) continue;
        const files = res.written.map((w) => path.join(out, ...w.path.split('/'))).filter((f) => !f.endsWith('.mjs'));
        const r = await TL.lintPaths(files, { host: 'all', root: out });
        const errors = r.files.flatMap((f) => f.host_results.flatMap((h) => h.errors.map((e) => `${h.host} ${f.path} ${e.rule}: ${e.message}`)));
        assert.deepEqual(errors, [], `${kind}/${host}`);
        assert.deepEqual(r.security.filter((x) => x.severity === 'error'), [], `${kind}/${host} security`);
      }
    }
    await T.scaffoldTooling('skill', { values: { for: 'claude', name: 'notes', description: desc, write: true, cwd: dir } });
    const ev = JSON.parse(read(dir, '.claude/skills/notes/evals/evals.json'));
    assert.equal(ev.skill_name, 'notes');
    assert.ok(Array.isArray(ev.evals) && ev.evals[0].prompt && Array.isArray(ev.evals[0].expectations));
    assert.ok(has(dir, '.claude/skills/notes/evals/notes-basic/prompt.md'), 'claude plugin eval case next to it');
    await T.scaffoldTooling('instructions', { values: { for: 'copilot', topic: 'api', 'apply-to': 'src/api/**', 'exclude-agent': 'code-review', write: true, cwd: dir } });
    const fm = P.readFrontmatter(read(dir, '.github/instructions/api.instructions.md'));
    assert.deepEqual([fm.data.applyTo, fm.data.excludeAgent], ['src/api/**', 'code-review']);
    await assert.rejects(T.scaffoldTooling('instructions', { values: { for: 'copilot', 'exclude-agent': 'everyone', cwd: dir } }), /exclude-agent/);
    await T.scaffoldTooling('agent', { values: { for: 'copilot,claude', name: 'triage', description: desc, skills: 'notes', write: true, cwd: dir } });
    assert.deepEqual(P.readFrontmatter(read(dir, '.github/agents/triage.agent.md')).data.skills, ['notes']);
    assert.deepEqual(P.readFrontmatter(read(dir, '.claude/agents/triage.md')).data.skills, ['notes']);
  });

  test('the generated hook handler passes its own fixture tests', async () => {
    const dir = tmpRepo({});
    await T.scaffoldTooling('hooks', { values: { for: 'all', name: 'edit-guard', events: 'PostToolUse,PreToolUse,Stop', write: true, cwd: dir } });
    // A nested `node --test` inherits NODE_TEST_CONTEXT and would report to this runner instead of stdout.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const res = spawnSync(process.execPath, ['--test', '--test-reporter=tap', path.join(dir, 'scripts', 'hooks', 'edit-guard.test.mjs')], { cwd: dir, env, encoding: 'utf8', timeout: 60_000 });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /# pass 7/);
    const cp = JSON.parse(read(dir, '.github/hooks/edit-guard.json'));
    assert.match(cp.hooks.preToolUse[0].bash, /^command -v node >\/dev\/null 2>&1 && node /, 'preToolUse is fail-closed in Copilot: guard it');
    assert.match(cp.hooks.preToolUse[0].powershell, /Get-Command node/);
    assert.equal(cp.hooks.agentStop.length, 1);
    // A host that never closes stdin still gets exactly {} within the handler's time limit.
    const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, [path.join(dir, 'scripts', 'hooks', 'edit-guard.mjs'), '--dialect', 'copilot', '--event', 'postToolUse'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    const code = await new Promise((resolve) => child.on('close', resolve));
    assert.equal(code, 0);
    assert.equal(out, '{}\n');
  });

  test('CLI: scaffold kinds, name validation and plugin delegation', () => {
    const dir = tmpRepo({});
    const r = adc(dir, 'tooling', 'scaffold', 'agent', '--for', 'copilot', '--name', 'triage', '--write');
    assert.equal(r.exit, 0, r.stderr);
    assert.ok(has(dir, '.github/agents/triage.agent.md'));
    assert.equal(adc(dir, 'tooling', 'scaffold', 'skill', '--name', 'Bad_Name').exit, 2);
    assert.equal(adc(dir, 'tooling', 'scaffold', 'widget').exit, 2);
    const p = adc(dir, 'tooling', 'scaffold', 'plugin', '--for', 'claude', '--name', 'demo-kit');
    assert.equal(p.exit, 0, p.stderr);
    assert.equal(p.json.dry_run, true);
    assert.ok(p.json.files.includes('plugins/demo-kit/.claude-plugin/plugin.json'));
  });
});

describe('tooling trigger-set', () => {
  test('scoring: majority per query, suite share, split scores and run spread', () => {
    const qs = T.assignSplit([{ id: 'a', query: 'x', should_trigger: true }, { id: 'b', query: 'y', should_trigger: false }, { id: 'c', query: 'z', should_trigger: true }]);
    const s = T.scoreTriggerRuns(qs, {
      a: [{ triggered: true }, { triggered: true }, { triggered: false }],
      b: [{ triggered: true }, { triggered: false }, { triggered: true }],
      c: [{ triggered: null, error: 'x' }, { triggered: true }, { triggered: true }],
    }, { runs: 3 });
    assert.deepEqual(s.per_query_pass_rate, { a: 0.6667, b: 0.3333, c: 0.6667 });
    assert.equal(s.suite_score, 0.6667);
    assert.equal(s.errors, 1);
    // Per run k: the share of queries whose k-th run behaved as labeled (an error never does).
    assert.deepEqual(s.run_scores, [0.3333, 1, 0.3333]);
    assert.ok(s.sd > 0);
    const split = T.assignSplit(Array.from({ length: 20 }, (_, i) => ({ id: `q${i}`, query: `q ${i}`, should_trigger: i < 10 })));
    assert.equal(split.filter((q) => q.split === 'train').length, 12);
    assert.deepEqual(T.assignSplit(split).map((q) => q.split), split.map((q) => q.split), 'deterministic');
  });

  test('detects skill use in Claude, Codex and Copilot output', () => {
    const cl = T.detectClaudeTrigger([
      JSON.stringify({ type: 'system', subtype: 'init', skills: ['notes'] }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'my-plugin:notes' } }] } }),
      JSON.stringify({ type: 'result', total_cost_usd: 0.02 }),
    ], 'notes');
    assert.deepEqual([cl.triggered, cl.loaded, cl.cost_usd], [true, true, 0.02]);
    assert.equal(T.detectClaudeTrigger([JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'notes' }] } })], 'notes').triggered, false);
    assert.equal(T.detectCodexTrigger([JSON.stringify({ item: { command: 'sed -n 1,80p .agents/skills/notes/SKILL.md' } })], 'notes').triggered, true);
    assert.equal(T.detectCodexTrigger([JSON.stringify({ item: { command: 'cat .agents/skills/other/SKILL.md' } })], 'notes').triggered, false);
    assert.equal(T.detectCopilotTrigger([JSON.stringify({ type: 'skill.loaded', name: 'notes' })], '', 'notes').method, 'jsonl-skill-event');
    assert.equal(T.detectCopilotTrigger([], 'Loaded skill: notes', 'notes').method, 'share-transcript');
    assert.equal(T.detectCopilotTrigger([], '> use notes skill please', 'notes').triggered, false, 'the quoted prompt is not a load');
  });

  test('init, TODO refusal, a fake Claude run, results files and exit codes', async () => {
    const dir = tmpRepo({ '.claude/skills/notes/SKILL.md': SKILL_MD('notes', 'Formats release notes and changelog summaries from merged pull requests.') });
    const fake = fakeCli(dir, 'claude', FAKE_CLAUDE);
    const init = adc(dir, 'tooling', 'trigger-set', '.claude/skills/notes', '--init');
    assert.equal(init.exit, 0, init.stderr);
    assert.equal(init.json.ready, false);
    assert.equal(init.json.queries.length, 20);
    assert.equal(adc(dir, 'tooling', 'trigger-set', '.claude/skills/notes', '--host', 'claude', '--run', '--cli', fake).exit, 2, 'TODO queries are refused');
    assert.equal(adc(dir, 'tooling', 'trigger-set', '.claude/skills/notes', '--host', 'claude', '--run', '--cli', 'no-such-cli-xyz').exit, 2);
    write(dir, '.claude/skills/notes/evals/trigger-set.json', triggerSetFile('notes'));
    const dry = adc(dir, 'tooling', 'trigger-set', '.claude/skills/notes', '--host', 'claude', '--run', '--cli', fake, '--dry-run');
    assert.deepEqual([dry.exit, dry.json.suite_score, has(dir, '.adc')], [0, null, false], '--dry-run never runs (paid) nor writes');
    assert.ok(dry.json.warnings.some((w) => /dry run/.test(w)));
    const run = adc(dir, 'tooling', 'trigger-set', '.claude/skills/notes', '--host', 'claude', '--run', '--cli', fake, '--concurrency', '4');
    assert.equal(run.exit, 0, run.stderr);
    assert.equal(run.json.suite_score, 1);
    assert.equal(run.json.results.length, 20);
    assert.ok(run.json.results.every((r) => r.runs.length === 3));
    // 30 positive runs stop at the Skill call (no result event): priced at the mean of the 30 others.
    assert.equal(run.json.cost_usd, 0.06);
    assert.deepEqual([run.json.cost.measured_runs, run.json.cost.estimated_runs, run.json.cost.measured_usd], [30, 30, 0.03]);
    assert.ok(has(dir, run.json.results_path));
    assert.match(read(dir, '.adc/metrics.jsonl'), /tooling-trigger-set/);
    assert.equal(git(dir, ['status', '--porcelain', '--', '.adc']).stdout, '', '.adc stays excluded');
    // A description that loses its keywords drops below the threshold: exit 1.
    write(dir, '.claude/skills/notes/SKILL.md', SKILL_MD('notes', 'Helps with documents.'));
    const bad = adc(dir, 'tooling', 'trigger-set', '.claude/skills/notes', '--host', 'claude', '--run', '--cli', fake, '--concurrency', '4');
    assert.equal(bad.exit, 1);
    assert.equal(bad.json.suite_score, 0.5);
    assert.equal(bad.json.iteration, 2);
    // Re-score saved results without spending anything.
    const imported = adc(dir, 'tooling', 'trigger-set', '.claude/skills/notes', '--results', run.json.results_path);
    assert.equal(imported.json.suite_score, 1);
    assert.ok(imported.json.warnings.some((w) => /different description/.test(w)));
  });

  test('runs that fail count as errors (exit 4); Codex and Copilot fakes are scored', async () => {
    const dir = tmpRepo({ '.claude/skills/notes/SKILL.md': SKILL_MD('notes', 'Formats release notes and changelog summaries from merged pull requests.') });
    write(dir, '.claude/skills/notes/evals/trigger-set.json', triggerSetFile('notes'));
    const fake = fakeCli(dir, 'claude', FAKE_CLAUDE);
    process.env.FAKE_FAIL = '1';
    let res;
    try {
      res = await T.triggerSet({ ctx: { cwd: dir, dryRun: false, stateDirOption: null }, root: dir, skillPath: '.claude/skills/notes', host: 'claude', runIt: true, runs: 1, cli: fake, concurrency: 4 });
    } finally { delete process.env.FAKE_FAIL; }
    assert.equal(res.errors, 20);
    assert.ok(res.results.every((r) => r.runs[0].triggered === null && /exit 1/.test(r.runs[0].error)));
    const codex = await T.triggerSet({ ctx: { cwd: dir, dryRun: false, stateDirOption: null }, root: dir, skillPath: '.claude/skills/notes', host: 'codex', runIt: true, runs: 1, cli: fakeCli(dir, 'codex', FAKE_CODEX), concurrency: 4 });
    assert.equal(codex.suite_score, 1);
    assert.equal(codex.confidence, 'medium');
    assert.equal(codex.cost_usd, null, 'Codex reports no per-run cost');
    const copilot = await T.triggerSet({ ctx: { cwd: dir, dryRun: false, stateDirOption: null }, root: dir, skillPath: '.claude/skills/notes', host: 'copilot', runIt: true, runs: 1, cli: fakeCli(dir, 'copilot', FAKE_COPILOT), concurrency: 4 });
    assert.equal(copilot.suite_score, 1);
    assert.equal(copilot.confidence, 'unconfirmed');
  });
});

describe('tooling modify', () => {
  async function measuredSkill() {
    const dir = tmpRepo({ '.claude/skills/notes/SKILL.md': SKILL_MD('notes', 'Formats release notes and changelog summaries from merged pull requests. Use when the user asks for release notes.') });
    write(dir, '.claude/skills/notes/evals/trigger-set.json', triggerSetFile('notes'));
    commitAll(dir);
    const fake = fakeCli(dir, 'claude', FAKE_CLAUDE);
    return { dir, fake };
  }

  test('rejects a change that lowers the trigger score; --restore brings the baseline back', async () => {
    const { dir, fake } = await measuredSkill();
    assert.equal(adc(dir, 'tooling', 'trigger-set', '.claude/skills/notes', '--host', 'claude', '--run', '--cli', fake, '--concurrency', '4').exit, 0);
    const base = adc(dir, 'tooling', 'modify', 'baseline', '.claude/skills/notes');
    assert.equal(base.exit, 0, base.stderr);
    assert.equal(base.json.trigger.status, 'measured');
    assert.equal(base.json.trigger.suite_score, 1);
    const original = read(dir, '.claude/skills/notes/SKILL.md');
    write(dir, '.claude/skills/notes/SKILL.md', SKILL_MD('notes', 'Helps with documents.'));
    const unverified = adc(dir, 'tooling', 'modify', 'compare', '.claude/skills/notes');
    assert.equal(unverified.exit, 4, 'description changed but triggering was not re-measured');
    assert.equal(unverified.json.verdict, 'unverified');
    assert.equal(adc(dir, 'tooling', 'trigger-set', '.claude/skills/notes', '--host', 'claude', '--run', '--cli', fake, '--concurrency', '4').exit, 1);
    const cmp = adc(dir, 'tooling', 'modify', 'compare', '.claude/skills/notes', '--accept', '--restore');
    assert.equal(cmp.exit, 1);
    assert.equal(cmp.json.verdict, 'reject');
    assert.ok(cmp.json.failing.some((f) => /^trigger: score fell from 1 to 0\.5/.test(f)));
    assert.ok(cmp.json.recorded.refused);
    assert.equal(read(dir, '.claude/skills/notes/SKILL.md'), original);
    assert.equal(has(dir, 'CHANGELOG.md'), false);
  });

  test('accepts a change that only cuts tokens; --accept writes the changelog, bumps the version, re-baselines', async () => {
    const { dir, fake } = await measuredSkill();
    assert.equal(adc(dir, 'tooling', 'trigger-set', '.claude/skills/notes', '--host', 'claude', '--run', '--cli', fake, '--concurrency', '4').exit, 0);
    assert.equal(adc(dir, 'tooling', 'modify', 'baseline', '.claude/skills/notes').exit, 0);
    write(dir, '.claude/skills/notes/SKILL.md', SKILL_MD('notes', 'Formats release notes and changelog summaries from merged pull requests.'));
    assert.equal(adc(dir, 'tooling', 'trigger-set', '.claude/skills/notes', '--host', 'claude', '--run', '--cli', fake, '--concurrency', '4').exit, 0);
    const cmp = adc(dir, 'tooling', 'modify', 'compare', '.claude/skills/notes', '--accept', '--note', 'shorter description');
    assert.equal(cmp.exit, 0, JSON.stringify(cmp.json?.failing));
    assert.equal(cmp.json.verdict, 'accept');
    assert.ok(cmp.json.deltas.tokens.per_host.claude.delta < 0);
    assert.equal(cmp.json.deltas.trigger.status, 'measured');
    assert.match(read(dir, 'CHANGELOG.md'), /## \[Unreleased\][\s\S]*### Changed[\s\S]*`\.claude\/skills\/notes`: shorter description/);
    assert.deepEqual(cmp.json.recorded.version, { file: '.claude/skills/notes/SKILL.md', from: '0.1.0', to: '0.1.1' });
    assert.match(read(dir, '.claude/skills/notes/SKILL.md'), /version: "0\.1\.1"/);
    const again = adc(dir, 'tooling', 'modify', 'compare', '.claude/skills/notes');
    assert.equal(again.json.verdict, 'accept');
    assert.equal(again.json.unchanged, true, 'the accepted state is the new baseline');
  });

  test('token increases need a change note; instructions use the same loop', async () => {
    const dir = tmpRepo({ 'AGENTS.md': '# Rules\n\n- Run the whole suite.\n' });
    const dryBase = adc(dir, 'tooling', 'modify', 'baseline', 'AGENTS.md', '--dry-run');
    assert.deepEqual([dryBase.exit, dryBase.json.baseline_dir, has(dir, '.adc')], [0, null, false], 'a dry-run baseline stores nothing');
    assert.equal(adc(dir, 'tooling', 'modify', 'baseline', 'AGENTS.md').exit, 0);
    write(dir, 'AGENTS.md', '# Rules\n\n- Run the whole suite.\n- Also run the linter before every commit, and the type checker.\n');
    const noNote = adc(dir, 'tooling', 'modify', 'compare', 'AGENTS.md');
    assert.equal(noNote.json.verdict, 'reject');
    assert.ok(noNote.json.failing.some((f) => /tokens/.test(f)));
    const withNote = adc(dir, 'tooling', 'modify', 'compare', 'AGENTS.md', '--note', 'adds the lint rule');
    assert.equal(withNote.json.verdict, 'accept');
    assert.equal(withNote.json.deltas.tokens.justified_by_note, true);
    write(dir, 'AGENTS.md', '# Rules\n');
    const cut = adc(dir, 'tooling', 'modify', 'compare', 'AGENTS.md');
    assert.equal(cut.json.verdict, 'accept');
    assert.equal(cut.json.deltas.tokens.decreased, true);
    const restored = adc(dir, 'tooling', 'modify', 'restore', 'AGENTS.md');
    assert.equal(restored.exit, 0);
    assert.equal(read(dir, 'AGENTS.md'), '# Rules\n\n- Run the whole suite.\n');
    assert.equal(adc(dir, 'tooling', 'modify', 'compare', 'CLAUDE.md').exit, 2, 'missing artifact');
  });

  test('--external snapshots the host-rendered context and diffs it (fake Copilot and Codex CLIs)', () => {
    const dir = tmpRepo({ 'AGENTS.md': '# Rules\n\n- Run the whole suite.\n' });
    const env = { ADC_COPILOT_CLI: fakeCli(dir, 'copilot-list', FAKE_COPILOT_LIST), ADC_CODEX_CLI: fakeCli(dir, 'codex-host', FAKE_CODEX_HOST), CODEX_HOME: path.join(dir, '.fake', 'codex-home') };
    fs.mkdirSync(env.CODEX_HOME, { recursive: true });
    const b = adcEnv(env, dir, 'tooling', 'modify', 'baseline', 'AGENTS.md', '--external');
    assert.equal(b.exit, 0, b.stderr);
    assert.deepEqual(b.json.external.map((e) => [e.name, e.exit]), [['copilot instruction list --json', 0], ['codex debug prompt-input (skills and AGENTS.md)', 0]]);
    const saved = fs.readFileSync(path.join(dir, b.json.baseline_dir, 'external-1.txt'), 'utf8');
    assert.match(saved, /# AGENTS\.md instructions for <repo>/, 'machine paths are scrubbed');
    assert.ok(!/current_date/.test(saved), 'only the skills and AGENTS.md parts are kept');
    write(dir, 'AGENTS.md', '# Rules\n\n- Run the whole suite.\n- Run the linter.\n');
    const c = adcEnv(env, dir, 'tooling', 'modify', 'compare', 'AGENTS.md', '--external', '--note', 'adds the lint rule');
    assert.equal(c.json.verdict, 'accept');
    const d = c.json.deltas.external['codex debug prompt-input (skills and AGENTS.md)'];
    assert.deepEqual([d.added, d.removed, d.sample], [1, 0, ['+ - Run the linter.']]);
  });

  test('compareMeasurements: lint, outcome and portability rules', () => {
    const base = { lint: { status: 'ok', errors: [], warnings: [] }, cost: { per_host: {} }, trigger: { status: 'not-measured' }, outcome: { status: 'measured', score: 0.9, sd: 0.05 }, hosts: ['claude', 'copilot'] };
    const after = { ...base, lint: { status: 'ok', errors: [{ key: 'claude|X|bad' }], warnings: [] }, outcome: { status: 'measured', score: 0.86, sd: 0.02 }, hosts: ['claude'] };
    const c = T.compareMeasurements(base, after);
    assert.equal(c.verdict, 'reject');
    assert.ok(c.failing.some((f) => /^lint/.test(f)));
    assert.ok(c.failing.some((f) => /^portability/.test(f)));
    assert.ok(!c.failing.some((f) => /^outcome/.test(f)), '0.04 drop is inside the 0.05 tolerance');
    const worse = T.compareMeasurements(base, { ...base, outcome: { status: 'measured', score: 0.7, sd: 0 } });
    assert.ok(worse.failing.some((f) => /^outcome/.test(f)));
  });

  test('migrations produce lint-clean artifacts that keep the substance', async () => {
    const dir = tmpRepo({
      '.github/prompts/release.prompt.md': '---\ndescription: Drafts release notes from the merged pull requests. Use when asked for release notes.\nmodel: GPT-5\n---\n\nDraft the notes.\n',
      '.github/chatmodes/planner.chatmode.md': '---\ndescription: Plans work before coding.\ntools: [\'codebase\', \'search\']\n---\n\nPlan first.\n',
      '.claude/commands/frontend/component.md': '---\ndescription: Creates a React component from a short spec.\n---\n\nCreate the component.\n',
      '.claude/commands/lint-fix.md': '---\ndescription: Fixes lint errors in the changed files.\n---\n\nFix lint.\n',
      '.vscode/mcp.json': { servers: { docs: { type: 'stdio', command: 'npx', args: ['-y', 'docs-mcp@1.2.3'] } } },
      '.github/hooks/legacy.json': { hooks: { PostToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'node scripts/check.mjs', timeout: 10 }] }] } },
    });
    const expect = {
      'prompt-to-skill': ['.github/prompts/release.prompt.md', '.github/skills/release'],
      'chatmode-to-agent': ['.github/chatmodes/planner.chatmode.md', '.github/agents/planner.agent.md'],
      'claude-commands-to-skills': ['.claude/commands', '.claude/skills/lint-fix'],
      'vscode-mcp-to-mcp-json': ['.vscode/mcp.json', '.mcp.json'],
      'copilot-hooks-to-camel': ['.github/hooks/legacy.json', '.github/hooks/legacy.json'],
    };
    for (const [kind, [src, produced]] of Object.entries(expect)) {
      const r = adc(dir, 'tooling', 'modify', src, '--migrate', kind);
      assert.ok([0, 4].includes(r.exit), `${kind}: exit ${r.exit} ${r.stderr}`);
      const res = r.json.results.find((x) => x.artifact === produced);
      assert.ok(res, `${kind}: ${JSON.stringify(r.json.results.map((x) => x.artifact))}`);
      assert.equal(res.equivalence.equal, true, `${kind}: ${res.equivalence.reason}`);
      if (LINT_AVAILABLE) {
        assert.equal(res.lint.errors, 0, `${kind} lint errors`);
        assert.equal(res.verdict, 'accept', `${kind}: ${JSON.stringify(res.failing)} ${JSON.stringify(res.unverified)}`);
      }
      assert.ok(r.json.baselines.length >= 1, `${kind} keeps a baseline of the source`);
    }
    const hooks = JSON.parse(read(dir, '.github/hooks/legacy.json'));
    assert.equal(hooks.version, 1);
    assert.deepEqual(Object.keys(hooks.hooks), ['postToolUse']);
    assert.equal(hooks.hooks.postToolUse[0].matcher, 'edit|create');
    assert.ok(has(dir, '.claude/skills/frontend-component/SKILL.md'));
    assert.equal(adc(dir, 'tooling', 'modify', '.mcp.json', '--migrate', 'prompt-to-skill').exit, 2, 'wrong source kind');
  });
});

describe('tooling plugin', () => {
  test('init --for all packages project skills, agents, hooks and MCP; check, test and release', async () => {
    const dir = tmpRepo({
      '.claude/skills/notes/SKILL.md': SKILL_MD('notes', 'Formats release notes from merged pull requests. Use for release notes.'),
      '.github/agents/reviewer.agent.md': '---\nname: reviewer\ndescription: Reviews diffs for missing tests.\ntools: [\'read\', \'search\']\n---\n\nReview.\n',
      '.github/hooks/check.json': { version: 1, hooks: { postToolUse: [{ type: 'command', bash: 'node scripts/check.mjs', powershell: 'node scripts/check.mjs', timeoutSec: 10 }] } },
      'scripts/check.mjs': 'process.stdout.write("{}\\n");\n',
      '.mcp.json': { mcpServers: { docs: { command: 'npx', args: ['-y', 'docs-mcp@1.2.3'], env: { DOCS_TOKEN: '${DOCS_TOKEN}' } } } },
    });
    const dry = adc(dir, 'tooling', 'plugin', 'init', '--for', 'all', '--name', 'demo-tools', '--include-hooks', '--include-mcp', '--owner', 'Example Team');
    assert.equal(dry.exit, 0, dry.stderr);
    assert.equal(dry.json.dry_run, true);
    assert.equal(has(dir, 'plugins/demo-tools/plugin.json'), false);
    const init = adc(dir, 'tooling', 'plugin', 'init', '--for', 'all', '--name', 'demo-tools', '--include-hooks', '--include-mcp', '--owner', 'Example Team', '--write');
    assert.equal(init.exit, 0, init.stderr);
    for (const f of ['plugin.json', '.claude-plugin/plugin.json', 'skills/notes/SKILL.md', 'agents/reviewer.md', 'com.github.copilot/agents/reviewer.agent.md',
      'hooks/hooks.json', 'com.github.copilot/hooks/hooks.json', 'hooks/codex.hooks.json', 'hooks/scripts/check.mjs', 'mcp.json', '.mcp.json',
      'evals/notes-basic/prompt.md', 'README.md', 'CHANGELOG.md']) assert.ok(has(dir, `plugins/demo-tools/${f}`), f);
    assert.ok(has(dir, '.claude-plugin/marketplace.json'));
    const ap = JSON.parse(read(dir, 'plugins/demo-tools/plugin.json'));
    assert.equal(ap.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
    assert.ok(Object.keys(ap).every((k) => ['$schema', 'name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords', 'extensions'].includes(k)));
    const claudeHooks = JSON.parse(read(dir, 'plugins/demo-tools/hooks/hooks.json'));
    assert.deepEqual(claudeHooks.hooks.PostToolUse[0].hooks[0].args, ['${CLAUDE_PLUGIN_ROOT}/hooks/scripts/check.mjs']);
    const cpHooks = JSON.parse(read(dir, 'plugins/demo-tools/com.github.copilot/hooks/hooks.json'));
    assert.equal(cpHooks.hooks.postToolUse[0].bash, 'node "${PLUGIN_ROOT}/hooks/scripts/check.mjs"');
    assert.equal(cpHooks.hooks.postToolUse[0].powershell, 'node "$env:PLUGIN_ROOT/hooks/scripts/check.mjs"');
    const apMcp = JSON.parse(read(dir, 'plugins/demo-tools/mcp.json'));
    assert.equal(apMcp.mcpServers.docs.type, 'stdio');
    assert.equal(apMcp.mcpServers.docs.env, undefined, 'env references are not expanded by Agent Plugins');
    assert.ok(init.json.dropped_fields.some((d) => /DOCS_TOKEN/.test(d.field)));
    const mkt = JSON.parse(read(dir, '.claude-plugin/marketplace.json'));
    assert.deepEqual(mkt.plugins[0], { name: 'demo-tools', source: './plugins/demo-tools', description: ap.description, version: '0.1.0' });
    const check = adc(dir, 'tooling', 'plugin', 'check', 'plugins/demo-tools');
    assert.equal(check.exit, 0, JSON.stringify(check.json.findings.filter((f) => f.severity === 'error')));
    assert.equal(check.json.errors, 0);
    if (CLAUDE) {
      const v = check.json.validators.filter((x) => x.name.startsWith('claude plugin validate'));
      assert.equal(v.length, 2, 'plugin directory and marketplace root');
      assert.ok(v.every((x) => x.ran && x.status === 'pass'), JSON.stringify(v));
      const evalLoad = check.json.validators.find((x) => x.name.startsWith('claude plugin eval'));
      assert.equal(evalLoad.status, 'pass', JSON.stringify(evalLoad));
    }
    for (const [cli, prefix] of [[COPILOT, 'copilot --plugin-dir'], [CODEX, 'codex plugin marketplace add']]) {
      const v = check.json.validators.find((x) => x.name.startsWith(prefix));
      assert.ok(v, prefix);
      if (cli) assert.deepEqual([v.status, v.loaded_skills], ['pass', ['notes']], JSON.stringify(v));
      else assert.equal(v.status, 'skipped');
    }
    const t = adc(dir, 'tooling', 'plugin', 'test', 'plugins/demo-tools', '--run');
    assert.equal(t.exit, 0, t.stderr);
    assert.ok(t.json.local_test_commands.some((c) => c.host === 'copilot' && c.cost === 'paid' && /COPILOT_PLUGIN_DIR_ONLY=true copilot --plugin-dir/.test(c.bash) && /\$env:COPILOT_PLUGIN_DIR_ONLY/.test(c.powershell)));
    assert.ok(t.json.local_test_commands.some((c) => c.host === 'codex' && /codex plugin marketplace add/.test(c.bash)));
    if (CLAUDE) assert.ok(t.json.ran.some((r) => /claude plugin validate/.test(r.cmd) && r.status === 'pass'));
    commitAll(dir);
    git(dir, ['remote', 'add', 'origin', 'https://github.com/example-org/demo-repo.git']);
    const rel = adc(dir, 'tooling', 'plugin', 'release', 'plugins/demo-tools', '--version', '0.2.0', '--write');
    assert.equal(rel.exit, 0, rel.stderr);
    assert.deepEqual(rel.json.updated.map((u) => [u.file, u.from, u.to]), [['plugins/demo-tools/plugin.json', '0.1.0', '0.2.0'],
      ['plugins/demo-tools/.claude-plugin/plugin.json', '0.1.0', '0.2.0'], ['.claude-plugin/marketplace.json', '0.1.0', '0.2.0']]);
    assert.match(rel.json.pin.sha, /^[0-9a-f]{40}$/);
    assert.equal(rel.json.pin.repo, 'example-org/demo-repo');
    assert.ok(has(dir, rel.json.sha256sums.path));
    assert.match(read(dir, rel.json.sha256sums.path), /^[0-9a-f]{64} {2}plugin\.json$/m);
    assert.equal(JSON.parse(read(dir, 'plugins/demo-tools/.claude-plugin/plugin.json')).version, '0.2.0');
    assert.ok(rel.json.tags.some((x) => x.name === 'demo-tools--v0.2.0'));
  });

  test('host load checks run in throwaway homes (fake Copilot and Codex CLIs) and fail on missing skills', async () => {
    const dir = tmpRepo({ '.agents/skills/notes/SKILL.md': SKILL_MD('notes', 'Formats release notes from merged pull requests. Use for release notes.') });
    const env = { ADC_COPILOT_CLI: fakeCli(dir, 'copilot-list', FAKE_COPILOT_LIST), ADC_CODEX_CLI: fakeCli(dir, 'codex-host', FAKE_CODEX_HOST), ADC_CLAUDE_CLI: path.join(dir, 'no-claude.mjs') };
    assert.equal(adc(dir, 'tooling', 'plugin', 'init', '--for', 'copilot,codex', '--name', 'kit', '--write').exit, 0);
    const homeBefore = fs.readdirSync(os.tmpdir()).filter((n) => /^adc-(copilot|codex)-/.test(n)).length;
    const ok = adcEnv(env, dir, 'tooling', 'plugin', 'check', 'plugins/kit');
    assert.equal(ok.exit, 0, JSON.stringify(ok.json?.findings));
    const by = Object.fromEntries(ok.json.validators.map((v) => [v.name.split(' ')[0], v]));
    assert.deepEqual([by.copilot.status, by.copilot.loaded_skills], ['pass', ['notes']]);
    assert.deepEqual([by.codex.status, by.codex.loaded_skills, by.codex.marketplace], ['pass', ['notes'], 'kit-marketplace']);
    assert.equal(fs.readdirSync(os.tmpdir()).filter((n) => /^adc-(copilot|codex)-/.test(n)).length, homeBefore, 'throwaway homes are removed');
    const bad = adcEnv({ ...env, FAKE_EMPTY: '1' }, dir, 'tooling', 'plugin', 'check', 'plugins/kit');
    assert.equal(bad.exit, 1);
    assert.ok(bad.json.findings.some((f) => f.rule === 'COPILOT_LOAD' && /notes/.test(f.message)));
    const t = adcEnv(env, dir, 'tooling', 'plugin', 'test', 'plugins/kit');
    assert.deepEqual(t.json.ran, [], 'without --run nothing is executed');
    const tr = adcEnv(env, dir, 'tooling', 'plugin', 'test', 'plugins/kit', '--run');
    assert.deepEqual(tr.json.ran.map((r) => r.status), ['pass', 'pass']);
    assert.ok(tr.json.local_test_commands.some((c) => c.host === 'copilot' && /copilot plugin marketplace add \. && copilot plugin install kit@kit-marketplace/.test(c.bash) && /if \(\$LASTEXITCODE -eq 0\)/.test(c.powershell)));
  });

  test('init moves a skill\'s own plugin-eval cases to the plugin evals/ and keeps Codex-only skills out of shared plugins', async () => {
    const dir = tmpRepo({
      '.claude/skills/notes/SKILL.md': SKILL_MD('notes', 'Formats release notes from merged pull requests. Use for release notes.'),
      '.claude/skills/notes/evals/real-case/prompt.md': '---\nmax_turns: 5\n---\n\nWrite release notes for v2.\n',
      '.claude/skills/notes/evals/real-case/graders/used.md': '---\ntype: tool_used\ntool: Skill\n---\n',
      '.claude/skills/notes/evals/trigger-set.json': triggerSetFile('notes'),
      '.codex/skills/reviewer/SKILL.md': SKILL_MD('reviewer', 'Reviews diffs for missing tests. Use for reviews.'),
    });
    const r = adc(dir, 'tooling', 'plugin', 'init', '--for', 'all', '--name', 'kit');
    assert.equal(r.exit, 0, r.stderr);
    assert.ok(r.json.files.includes('plugins/kit/evals/real-case/prompt.md'));
    assert.ok(r.json.files.includes('plugins/kit/evals/real-case/graders/used.md'));
    assert.ok(!r.json.files.some((f) => /skills\/notes\/evals\//.test(f)), 'skill evals are not shipped inside the skill');
    assert.ok(!r.json.files.some((f) => /notes-basic/.test(f)), 'no TODO template when real cases exist');
    assert.ok(!r.json.files.some((f) => /skills\/reviewer\//.test(f)), '.codex/skills joins only Codex plugins by default');
    const cx = adc(dir, 'tooling', 'plugin', 'init', '--for', 'codex', '--name', 'kit');
    assert.ok(cx.json.files.includes('plugins/kit/skills/reviewer/SKILL.md'));
    assert.ok(!cx.json.files.some((f) => /\/evals\//.test(f)), 'plugin-eval cases are Claude Code only');
  });

  test('check reports broken manifests', async () => {
    const dir = tmpRepo({
      'plugins/bad/plugin.json': { $schema: 'https://agent-plugins.org/schemas/9.9.9/plugin.schema.json', name: 'bad', version: '1.0.0', commands: './x' },
      'plugins/bad/.claude-plugin/plugin.json': { name: 'claude-bad', version: '1.1.0', skills: 'skills' },
      'plugins/bad/mcp.json': { $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json', mcpServers: { s: { type: 'stdio', command: 'npx -y thing', url: 'https://x' } } },
      'plugins/bad/skills/Wrong/SKILL.md': '---\nname: other\ndescription: d\n---\nbody\n',
      'plugins/bad/.codex-plugin/plugin.json': { name: 'bad', mcp_servers: './mcp.json' },
    });
    const r = await T.toolingCommand(['plugin', 'check', 'plugins/bad', '--cwd', dir]);
    assert.equal(r.exit, 1);
    const rules = new Set(r.result.findings.filter((f) => f.severity === 'error').map((f) => f.rule));
    for (const rule of ['AP_SCHEMA', 'CLAUDE_NAME', 'CLAUDE_PATH', 'AP_MCP_COMMAND', 'AP_MCP_VARIANT', 'SKILL_NAME_DIR', 'SKILL_NAME', 'CODEX_CAMEL', 'NAME_MISMATCH', 'VERSION_MISMATCH']) assert.ok(rules.has(rule), rule);
    assert.ok(r.result.findings.some((f) => f.rule === 'AP_FIELD' && /commands/.test(f.message)));
  });

  test('refuses reserved names and the companion skill as a target', async () => {
    const dir = tmpRepo({});
    assert.equal(adc(dir, 'tooling', 'plugin', 'init', '--name', 'claude-helpers').exit, 2);
    assert.equal(adc(dir, 'tooling', 'plugin', 'init', '--name', 'ok-name', '--out', path.join(SKILL, 'tmp-plugin')).exit, 2);
    assert.equal(adc(dir, 'tooling', 'plugin', 'publish').exit, 2);
  });
});

describe('group, lint delegation, state guard', () => {
  test('tooling lint delegates to tooling-lint.mjs when it exists', () => {
    const dir = tmpRepo({ '.claude/skills/notes/SKILL.md': SKILL_MD('notes', 'Formats release notes. Use for release notes.') });
    const r = adc(dir, 'tooling', 'lint', '.claude/skills/notes');
    if (LINT_AVAILABLE) {
      assert.equal(r.exit, 0, r.stderr);
      assert.ok(Array.isArray(r.json.files));
    } else assert.equal(r.exit, 3);
  });

  test('every tooling subcommand refuses a tracked .adc/ with exit 3', () => {
    const dir = tmpRepo({ '.adc/budget.json': '{}', 'AGENTS.md': '- rule\n' });
    git(dir, ['add', '-f', '.adc/budget.json']);
    for (const args of [['cost'], ['port', 'AGENTS.md', '--to', 'claude'], ['scaffold', 'skill', '--name', 'x'], ['modify', 'baseline', 'AGENTS.md'], ['plugin', 'check', '.'], ['trigger-set', '.']]) {
      const r = adc(dir, 'tooling', ...args);
      assert.equal(r.exit, 3, `${args.join(' ')}: ${r.stdout}`);
      assert.equal(r.json.error.code, 'STATE_TRACKED');
    }
  });

  test('the group prints usage and rejects unknown subcommands', () => {
    const dir = tmpRepo({});
    const r = adc(dir, 'tooling');
    assert.equal(r.exit, 2);
    assert.deepEqual(r.json.subcommands, ['lint', 'cost', 'port', 'trigger-set', 'modify', 'plugin', 'scaffold']);
    assert.equal(adc(dir, 'tooling', 'nope').exit, 2);
  });
});
