// Unit tests for scripts/lib/frontmatter.mjs (YAML subset) and scripts/lib/tooling-lint.mjs.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  parseFrontmatter, parseYaml, parseYamlDocument, stringifyYaml, stringifyFrontmatter, YamlError, resolvePlain,
  normalizeSkillFrontmatter, INSTALL_METADATA_KEY,
} from '../../skills/agentic-developer-companion/scripts/lib/frontmatter.mjs';
import * as lint from '../../skills/agentic-developer-companion/scripts/lib/tooling-lint.mjs';
import * as core from '../../skills/agentic-developer-companion/scripts/lib/core.mjs';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
export function tableSection(name) {
  const table = path.join(FIX, 'table.json');
  if (fs.existsSync(table)) { const t = JSON.parse(fs.readFileSync(table, 'utf8')); if (t[name]) return t[name]; }
  return JSON.parse(fs.readFileSync(path.join(FIX, '_parts', `${name}.json`), 'utf8'));
}

const SKILL_DIR = core.SKILL_DIR;
const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
function tmp(prefix = 'adc-lint-') {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  dirs.push(d);
  return d;
}

// Test-only credentials, assembled at run time so no secret-shaped literal is stored.
const SECRETS = { aws: ['AKIA', 'IOSFODNN7', 'EXAMPLE'].join('') };
const LITERAL_TOKEN = ['tok', '9f3k2', 'Lm8Qz7', 'Xw4Rt1'].join('');

function expand(content) {
  return content
    .replace(/\{\{repeat (\d+)\|([^}]*)\}\}/g, (_, n, t) => Array(Number(n)).fill(t).join('\n'))
    .replace(/\{\{bytes (\d+)\}\}/g, (_, n) => 'x'.repeat(Number(n)))
    .replace(/\{\{base64 (\d+)\}\}/g, (_, n) => 'QUJD'.repeat(Math.ceil(Number(n) / 4)))
    .replace(/\{\{secret (\w+)\}\}/g, (_, k) => SECRETS[k])
    .replace(/\{\{literal-token\}\}/g, LITERAL_TOKEN);
}

function materialize(files) {
  const dir = tmp();
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, expand(content));
  }
  return dir;
}

function findings(res) {
  const out = [];
  for (const f of res.files) {
    for (const r of f.host_results) {
      for (const [sev, list] of [['error', r.errors], ['warning', r.warnings], ['note', r.notes]]) {
        for (const x of list) out.push({ file: f.path, host: r.host, sev, ...x });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// YAML subset

describe('frontmatter: YAML parser', () => {
  test('reads the skill\'s own SKILL.md frontmatter with key lines', () => {
    const fm = parseFrontmatter(fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8'));
    assert.equal(fm.hasFrontmatter, true);
    assert.deepEqual(fm.errors, []);
    assert.equal(fm.data.name, 'agentic-developer-companion');
    assert.match(fm.data.description, /^QA companion/);
    assert.ok(!fm.data.description.includes('\n'), 'folded scalar joins lines');
    assert.equal(typeof fm.data.metadata.version, 'string');
    assert.equal(fm.keyLines.name, 2);
    assert.ok(fm.keyLines['metadata.version'] > fm.keyLines.metadata);
    assert.equal(fm.bodyStartLine, fm.closeLine + 1);
  });

  test('block and flow collections, nested and same-indent sequences', () => {
    const v = parseYaml([
      'a: 1', 'b: [x, "y z", {c: d}]', 'c:', '- p', '- q: 1', '  r: 2', 'd:', '  e:', '    - - n1', '      - n2', '    - f: [1, 2]',
      'g: {}', 'h: []', 'tools: [', '  "read",  # comment', '  edit,', ']', 'k with space: v', '"quoted: key": w', '',
    ].join('\n'));
    assert.deepEqual(v, {
      a: 1, b: ['x', 'y z', { c: 'd' }], c: ['p', { q: 1, r: 2 }], d: { e: [['n1', 'n2'], { f: [1, 2] }] }, g: {}, h: [],
      tools: ['read', 'edit'], 'k with space': 'v', 'quoted: key': 'w',
    });
  });

  test('scalars: core schema, quoting, escapes, comments, plain multi-line', () => {
    const v = parseYaml([
      'n1: ~', 'n2: null', 'n3:', 'b1: true', 'b2: False', 'i: -12', 'hex: 0x1F', 'oct: 0o17', 'f: 1.5e3', 'inf: -.inf', 'ver: 1.0', 'sver: "1.0"',
      'semver: 0.1.0', 'yes: yes', "s1: 'it''s'", 's2: "tab\\tA\\u00e9\\x41 \\"q\\""', 'url: https://example.com/a?b=c#frag', 'c: value # trailing',
      'hash: a#b', 'colon: a:b', 'win: C:\\path\\x', 'p: multi', '  line', '', '  para', '',
    ].join('\n'));
    assert.equal(v.n1, null); assert.equal(v.n2, null); assert.equal(v.n3, null);
    assert.equal(v.b1, true); assert.equal(v.b2, false); assert.equal(v.i, -12); assert.equal(v.hex, 31); assert.equal(v.oct, 15);
    assert.equal(v.f, 1500); assert.equal(v.inf, -Infinity); assert.equal(v.ver, 1); assert.equal(v.sver, '1.0'); assert.equal(v.semver, '0.1.0');
    assert.equal(v.yes, 'yes', 'YAML 1.2: yes is a string');
    assert.equal(v.s1, "it's"); assert.equal(v.s2, 'tab\tA\u00e9A "q"'); assert.equal(v.url, 'https://example.com/a?b=c#frag');
    assert.equal(v.c, 'value'); assert.equal(v.hash, 'a#b'); assert.equal(v.colon, 'a:b'); assert.equal(v.win, 'C:\\path\\x');
    assert.equal(v.p, 'multi line\npara');
    assert.equal(resolvePlain('.nan'), resolvePlain('.nan') === resolvePlain('.nan') ? 0 : NaN, 'NaN is not equal to itself');
  });

  test('block scalars: literal, folded, chomping and indentation indicators', () => {
    const v = parseYaml([
      'lit: |', '  a', '   b', '', '  c', 'strip: |-', '  x', 'keep: |+', '  y', '', '', 'fold: >', '  one', '  two', '', '  three', '    more', '  four',
      'foldstrip: >-', '  folded', '  text', 'ind: |2', '    deep', '  base', 'lead: >', '', '  lead', 'last: x', '',
    ].join('\n'));
    assert.equal(v.lit, 'a\n b\n\nc\n');
    assert.equal(v.strip, 'x');
    assert.equal(v.keep, 'y\n\n\n');
    assert.equal(v.fold, 'one two\nthree\n  more\nfour\n');
    assert.equal(v.foldstrip, 'folded text');
    assert.equal(v.ind, '  deep\nbase\n');
    assert.equal(v.lead, '\nlead\n');
  });

  test('quoted scalars fold across lines; escaped line breaks join', () => {
    const v = parseYaml('a: "folded\n  across\n\n  lines"\nb: \'single\n  folded\'\nc: "esc \\\n  joined"\nd: [ "x\n   y" ]\n');
    assert.deepEqual(v, { a: 'folded across\nlines', b: 'single folded', c: 'esc joined', d: ['x y'] });
  });

  test('anchors, aliases, tags, flow plain scalars with apostrophes', () => {
    const v = parseYaml('base: &b {x: 1}\ncopy: *b\nstr: !!str 123\nint: !!int "42"\nlist: [don\'t, b]\n');
    assert.deepEqual(v, { base: { x: 1 }, copy: { x: 1 }, str: '123', int: 42, list: ["don't", 'b'] });
    v.copy.x = 2;
    assert.equal(v.base.x, 1, 'aliases are copies');
  });

  test('errors carry codes and line numbers; parseYaml throws YamlError', () => {
    const cases = [
      ['a: [1, 2\n', 'UNTERMINATED_FLOW'], ['a: "x\n', 'UNTERMINATED_QUOTE'], ['\ta: 1\n', 'TAB_INDENT'], ['a:\n  b: 1\n c: 2\n', 'BAD_INDENT'],
      ['a: x\na: y\n', 'DUPLICATE_KEY'], ['a: *nope\n', 'UNKNOWN_ALIAS'], ['a: "bad \\q"\n', 'BAD_ESCAPE'], ['--- a\n--- b\n', null],
      ['x: - y\n', 'BAD_SEQUENCE'], ["a: 'ok' trailing\n", 'UNEXPECTED'], ['a: b\n- c\n', 'BAD_INDENT'],
    ];
    for (const [src, code] of cases) {
      const d = parseYamlDocument(src);
      assert.ok(d.errors.length, `expected an error for ${JSON.stringify(src)}`);
      if (code) assert.equal(d.errors[0].code, code, JSON.stringify(src));
      assert.ok(d.errors[0].line >= 1);
    }
    assert.throws(() => parseYaml('a: [1\n'), (e) => e instanceof YamlError && e.line === 1);
  });

  test('warnings: unquoted colon (Codex-style recovery) and reserved indicators', () => {
    const d = parseYamlDocument('description: Build for AWS: ECS\nb: @x\n');
    assert.deepEqual(d.errors, []);
    assert.equal(d.value.description, 'Build for AWS: ECS');
    assert.deepEqual(d.warnings.map((w) => w.code), ['UNQUOTED_COLON', 'RESERVED_INDICATOR']);
  });

  test('a "__proto__" key becomes data, never the prototype', () => {
    const v = parseYaml('__proto__: {polluted: true}\n');
    assert.equal(({}).polluted, undefined);
    assert.deepEqual(Object.keys(v), ['__proto__']);
    assert.equal(Object.getPrototypeOf(v), Object.prototype);
  });

  test('parseFrontmatter: CRLF, BOM, late opening, unclosed, non-mapping, body', () => {
    const crlf = parseFrontmatter('---\r\nname: x\r\ndescription: y\r\n---\r\nBody\r\nline 2\r\n');
    assert.equal(crlf.crlf, true);
    assert.deepEqual(crlf.data, { name: 'x', description: 'y' });
    assert.equal(crlf.body, 'Body\nline 2\n');
    assert.equal(crlf.bodyStartLine, 5);
    const bom = parseFrontmatter('\ufeff---\nname: x\n---\n');
    assert.equal(bom.bom, true); assert.equal(bom.data.name, 'x');
    const late = parseFrontmatter('\n\n---\nname: x\n---\n');
    assert.equal(late.hasFrontmatter, false); assert.equal(late.lateOpenLine, 3);
    const unclosed = parseFrontmatter('---\nname: x\n');
    assert.equal(unclosed.errors[0].code, 'FM_UNCLOSED');
    assert.equal(parseFrontmatter('---\n- a\n---\n').errors[0].code, 'FM_NOT_MAPPING');
    const none = parseFrontmatter('# Title\n');
    assert.equal(none.hasFrontmatter, false); assert.equal(none.body, '# Title\n');
    const errLine = parseFrontmatter('---\nname: x\nfoo: [bad\n---\n');
    assert.equal(errLine.errors[0].line, 3, 'line numbers count the opening ---');
  });

  test('stringify round-trips seeded random documents', () => {
    let seed = 11;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const pick = (a) => a[Math.floor(rnd() * a.length)];
    const atoms = ['a', 'b c', 'x: y', '#tag', 'a #b', ' lead', 'trail ', 'yes', 'no', 'on', 'null', '~', 'true', '1.0', '0.1.0', '007', '-x',
      '- x', '[x]', '{y}', '"q"', "'s'", "it's", 'multi\nline', 'multi\nline\n', 'end\n\n', '\nstart', 'tab\there', 'caf\u00e9 \u2713', '', ' ',
      '@at', '`bt', '%pct', 'a: b: c', 'C:\\path', 'https://x.y/z?q=1#f', '*star', '&amp', '!bang', '|pipe', '>gt', '? q', ': c', 'x:', 'a  b',
      'long ' + 'word '.repeat(30).trim(), 'long: ' + 'colon text '.repeat(15).trim(), 'k\r\nv', 'nul\u0000x', 'sep\u2028x'];
    const gen = (d) => {
      const r = rnd();
      if (d > 3 || r < 0.45) {
        const t = rnd();
        if (t < 0.7) return pick(atoms);
        if (t < 0.8) return Math.floor(rnd() * 1000) - 500;
        if (t < 0.85) return Math.round(rnd() * 1e6) / 1e3;
        if (t < 0.9) return rnd() < 0.5;
        return null;
      }
      if (r < 0.7) return Array.from({ length: Math.floor(rnd() * 4) }, () => gen(d + 1));
      const o = {};
      for (let i = 0; i < Math.floor(rnd() * 4); i++) o[pick(['k', 'key one', 'a-b', 'on', '1', 'x.y', 'with: colon', '#h', '', '\u00dc']) + i] = gen(d + 1);
      return o;
    };
    for (let i = 0; i < 1500; i++) {
      const v = gen(0);
      const y = stringifyYaml(v);
      assert.deepEqual(parseYaml(y), v, `round trip failed for ${JSON.stringify(v)}:\n${y}`);
    }
  });

  test('gh skill install rewrite: sorted keys, 4-space metadata, single-quoted scalars, provenance', () => {
    // Shape measured from gh 2.99.0 `skill install --from-local` (2026-10-25), with remote provenance added.
    const installed = [
      '---',
      "compatibility: 'Node.js 24+ and Git on PATH. Windows: PowerShell 7 for Copilot CLI and Codex hooks.'",
      "description: 'QA companion for agent-made code. Use when verifying changes: it''s the \"tests pass\" check.'",
      'license: Apache-2.0',
      'metadata:',
      '    author: robertlemmermann',
      '    github-pinned: true',
      '    github-ref: v0.1.0',
      '    github-repo: https://github.com/robertlemmermann/agentic-developer-companion',
      '    github-tree-sha: 4b825dc642cb6eb9a060e54bf8d69288fbee4904',
      '    local-path: /home/dev/src/agentic-developer-companion/skills/agentic-developer-companion',
      '    short-description: QA for agent-made changes and agentic tooling',
      '    version: 0.1.0',
      'name: agentic-developer-companion',
      '---',
      '# agentic-developer-companion',
      '',
    ].join('\r\n');
    const fm = parseFrontmatter(installed);
    assert.deepEqual(fm.errors, []);
    assert.deepEqual(fm.warnings, [], 'quoted scalars carry the ": " safely');
    assert.deepEqual(fm.constructs, [], 'block style only');
    assert.equal(fm.data.description, 'QA companion for agent-made code. Use when verifying changes: it\'s the "tests pass" check.');
    assert.equal(fm.data.metadata.version, '0.1.0', 'an unquoted semver stays a string');
    assert.equal(fm.data.metadata['github-pinned'], true);
    assert.equal(fm.keyLines['metadata.version'], 13);
    const source = parseFrontmatter([
      '---', 'name: agentic-developer-companion', 'description: >-', '  QA companion for agent-made code. Use when verifying changes:',
      '  it\'s the "tests pass" check.', 'license: Apache-2.0', 'compatibility: >-', '  Node.js 24+ and Git on PATH. Windows: PowerShell 7',
      '  for Copilot CLI and Codex hooks.', 'metadata:', '  version: "0.1.0"', '  short-description: QA for agent-made changes and agentic tooling',
      '  author: robertlemmermann', '---', '# agentic-developer-companion', ''].join('\n'));
    assert.deepEqual(source.errors, []);
    assert.deepEqual(normalizeSkillFrontmatter(fm.data), normalizeSkillFrontmatter(source.data), 'same skill once provenance and order are ignored');
    assert.notDeepEqual(fm.data, source.data);
  });

  test('normalizeSkillFrontmatter: strips only install provenance, sorts keys, does not mutate', () => {
    const data = { name: 'x', metadata: { 'local-path': '/a', 'github-repo': 'o/r', 'github-x': 1, githubish: 'kept' }, a: { z: 1, b: [{ d: 1, c: 2 }] } };
    const before = JSON.stringify(data);
    const n = normalizeSkillFrontmatter(data);
    assert.equal(JSON.stringify(data), before);
    assert.deepEqual(Object.keys(n), ['a', 'metadata', 'name']);
    assert.deepEqual(n.metadata, { githubish: 'kept' });
    assert.deepEqual(Object.keys(n.a.b[0]), ['c', 'd']);
    assert.equal(normalizeSkillFrontmatter({ name: 'x', metadata: { 'local-path': '/a' } }).metadata, undefined, 'an emptied metadata map is dropped');
    for (const k of ['github-repo', 'github-tree-sha', 'local-path']) assert.ok(INSTALL_METADATA_KEY.test(k), k);
    for (const k of ['version', 'github', 'short-description', 'local-paths']) assert.ok(!INSTALL_METADATA_KEY.test(k), k);
  });

  test('constructs strict parsers reject are reported with lines and paths', () => {
    const d = parseYamlDocument('a: &x 1\nb: *x\nc: !!str 2\nd: [1, {e: f}]\ng:\n  - {h: i}\nj: plain [not flow]\nk: "{quoted}"\n');
    assert.deepEqual(d.errors, []);
    assert.deepEqual(d.constructs.map((c) => `${c.kind}@${c.line}:${c.path}`), ['anchor@1:a', 'alias@2:b', 'tag@3:c', 'flow@4:d', 'flow@6:g[0]']);
    assert.deepEqual(parseFrontmatter('---\nname: x\nmetadata: {a: b}\n---\n').constructs.map((c) => c.line), [3], 'frontmatter lines count the opening ---');
    assert.deepEqual(parseFrontmatter(fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8')).constructs, [], 'the skill itself is block style');
  });

  test('stringifyFrontmatter output parses back with the same body', () => {
    const data = { name: 'my-skill', description: 'Formats data: quickly. '.repeat(8).trim(), metadata: { version: '1.0', 'short-description': 'Formats data quickly and safely' }, 'allowed-tools': 'Read Grep' };
    const text = stringifyFrontmatter(data, '\n# My skill\n\nBody.\n');
    assert.match(text, /^---\nname: my-skill\ndescription: >-\n/);
    assert.match(text, /version: "1\.0"/);
    const back = parseFrontmatter(text);
    assert.deepEqual(back.data, data);
    assert.equal(back.body, '\n# My skill\n\nBody.\n');
    assert.equal(stringifyFrontmatter({}), '---\n---\n');
  });
});

// ---------------------------------------------------------------------------
// Rule catalog

describe('tooling-lint: rule catalog', () => {
  test('every rule has an id, a kind, hosts with severities, a title and resolvable sources', () => {
    const ids = new Set();
    for (const r of lint.RULES) {
      assert.match(r.id, /^[A-Z]{2,3}(?:-[A-Z0-9]+)+$/, r.id);
      assert.ok(!ids.has(r.id), `duplicate rule ${r.id}`);
      ids.add(r.id);
      assert.ok(r.kind && r.title, r.id);
      assert.ok(r.sources.length, `${r.id} has no source`);
      for (const s of r.sources) assert.ok(lint.SOURCES[s], `${r.id} cites unknown source ${s}`);
      if (r.group === 'security') assert.ok(['warning', 'error'].includes(r.severity), r.id);
      else {
        assert.ok(Object.keys(r.hosts).length, `${r.id} applies to no host`);
        for (const [h, sev] of Object.entries(r.hosts)) {
          assert.ok(lint.HOSTS.includes(h), `${r.id}: host ${h}`);
          assert.ok(['error', 'warning', 'note'].includes(sev), `${r.id}: severity ${sev}`);
        }
      }
    }
  });

  test('references/tooling-lint.md documents every rule and every source key', () => {
    const ref = fs.readFileSync(path.join(SKILL_DIR, 'references', 'tooling-lint.md'), 'utf8');
    for (const r of lint.RULES) assert.ok(ref.includes(`\`${r.id}\``), `rule ${r.id} missing from references/tooling-lint.md`);
    for (const k of Object.keys(lint.SOURCES)) assert.ok(ref.includes(`\`${k}\``), `source ${k} missing from references/tooling-lint.md`);
    const lines = ref.replace(/\n$/, '').split('\n');
    assert.ok(lines.length <= 300, `reference has ${lines.length} lines`);
    assert.ok(/^## Contents/m.test(ref), 'a table of contents for a reference over 100 lines');
  });
});

// ---------------------------------------------------------------------------
// Fixture cases (documented examples must be clean; every rule must fire somewhere)

const triggered = new Set();
const lintCases = tableSection('lint').cases;

describe('tooling-lint: fixture cases', () => {
  for (const c of lintCases) {
    test(c.name, async () => {
      const dir = materialize(c.files);
      const res = await lint.lintPaths(c.lint.map((p) => path.join(dir, ...p.split('/'))), {
        root: dir, host: c.host || 'all', strict: Boolean(c.strict), home: path.join(dir, 'home'), env: {}, allowHosts: c.allowHosts || [],
      });
      assert.equal(res.internal_errors, undefined, JSON.stringify(res.internal_errors));
      const all = findings(res);
      for (const f of all) triggered.add(f.rule);
      for (const s of res.security) triggered.add(s.rule);
      const e = c.expect || {};
      const show = () => JSON.stringify(all.map((f) => `${f.host}:${f.sev}:${f.rule}:${f.file}:${f.message}`), null, 1);
      for (const id of e.rules || []) assert.ok(all.some((f) => f.rule === id), `expected ${id}; got ${show()}`);
      for (const id of e.absent || []) assert.ok(!all.some((f) => f.rule === id), `did not expect ${id}; got ${show()}`);
      for (const [host, ids] of Object.entries(e.absent_for || {})) {
        for (const id of ids) assert.ok(!all.some((f) => f.rule === id && f.host === host), `did not expect ${id} for ${host}`);
      }
      for (const h of e.clean_for || []) {
        const bad = all.filter((f) => f.host === h && f.sev !== 'note');
        assert.deepEqual(bad.map((f) => `${f.rule}: ${f.message}`), [], `expected no errors or warnings for ${h}`);
      }
      for (const [id, map] of Object.entries(e.severity || {})) {
        for (const [host, sev] of Object.entries(map)) {
          assert.ok(all.some((f) => f.rule === id && f.host === host && f.sev === sev), `expected ${id} as ${sev} for ${host}; got ${show()}`);
        }
      }
      for (const [id, n] of Object.entries(e.count || {})) {
        const files = new Set(all.filter((f) => f.rule === id).map((f) => `${f.file}:${f.line}:${f.message}`));
        assert.equal(files.size, n, `expected ${n} distinct ${id} findings; got ${show()}`);
      }
      for (const [id, n] of Object.entries(e.count_min || {})) {
        const files = new Set(all.filter((f) => f.rule === id).map((f) => `${f.file}:${f.line}`));
        assert.ok(files.size >= n, `expected at least ${n} ${id} findings; got ${show()}`);
      }
      for (const id of e.security || []) assert.ok(res.security.some((s) => s.rule === id), `expected security ${id}; got ${JSON.stringify(res.security)}`);
      if (e.no_security) assert.deepEqual(res.security, []);
      if (e.hosts_only) for (const f of res.files) for (const r of f.host_results) assert.ok(e.hosts_only.includes(r.host), `unexpected host ${r.host}`);
      for (const p of e.file_clean || []) assert.ok(!all.some((f) => f.file === p && f.sev !== 'note'), `expected ${p} clean; got ${show()}`);
      for (const [p, reads] of Object.entries(e.reads || {})) assert.deepEqual(res.files.find((f) => f.path === p)?.reads, reads, p);
      // Nothing secret-shaped ever reaches the output.
      assert.ok(!JSON.stringify(res).includes(SECRETS.aws), 'secret leaked into the lint result');
    });
  }

  test('every catalog rule except external validators fires in at least one case', () => {
    const missing = lint.RULES.filter((r) => r.kind !== 'external' && !triggered.has(r.id)).map((r) => r.id);
    assert.deepEqual(missing, []);
  });
});

// ---------------------------------------------------------------------------
// The skill itself, rendered hook configs, lintSkillDir

describe('tooling-lint: the companion skill and its rendered hooks', () => {
  test('the skill lints clean with --strict (links count only once their target exists)', async () => {
    const res = await lint.lintSkillDir(SKILL_DIR, { strict: true });
    assert.equal(res.files.length, 1);
    assert.equal(res.files[0].kind, 'skill');
    assert.deepEqual(res.security, []);
    const missing = [];
    const bad = [];
    for (const r of res.files[0].host_results) {
      for (const f of [...r.errors, ...r.warnings]) {
        const m = f.rule === 'SK-LINK-MISSING' && /link target (\S+) does not exist/.exec(f.message);
        // Reference files written by other work packages may not exist yet during the build;
        // the rule is right to report them, and the check tightens by itself once they land.
        if (m && !fs.existsSync(path.join(SKILL_DIR, ...m[1].split('/')))) missing.push(m[1]);
        else bad.push(`${r.host}: ${f.rule}: ${f.message}`);
      }
    }
    assert.deepEqual(bad, []);
    if (missing.length) console.error(`# not yet written: ${[...new Set(missing)].join(', ')}`);
    assert.ok(fs.existsSync(path.join(SKILL_DIR, 'references', 'tooling-lint.md')), 'this work package\'s reference exists');
  });

  test('lintSkillDir: lowercase skill.md is linted (and flagged); a folder without one is a usage error', async () => {
    const dir = materialize({ 'lower-case/skill.md': '---\nname: lower-case\ndescription: Does a thing. Use when testing.\n---\nBody.\n' });
    const res = await lint.lintSkillDir(path.join(dir, 'lower-case'));
    assert.ok(findings(res).some((f) => f.rule === 'SK-FILENAME'));
    await assert.rejects(lint.lintSkillDir(path.join(dir, 'nope')), (e) => e.exit === core.EXIT.USAGE);
    await assert.rejects(lint.lintPaths([path.join(dir, 'missing')], { root: dir }), (e) => e.exit === core.EXIT.USAGE);
    await assert.rejects(lint.lintPaths([dir], { root: dir, host: 'vscode' }), (e) => e.exit === core.EXIT.USAGE);
  });

  test('every hook config hooks-render produces lints without errors or warnings', async (t) => {
    let hr;
    try { hr = await import('../../skills/agentic-developer-companion/scripts/lib/hooks-render.mjs'); } catch { t.skip('hooks-render.mjs is not available'); return; }
    if (typeof hr.renderHooks !== 'function') { t.skip('renderHooks is not available'); return; }
    const root = tmp();
    const home = path.join(root, 'home');
    fs.mkdirSync(path.join(root, '.git'));
    let rendered = 0;
    for (const host of hr.HOSTS) {
      for (const scope of ['user', 'project']) {
        for (const level of hr.LEVELS) {
          if (host === 'copilot-cloud' && scope === 'user') continue;
          const r = hr.renderHooks({ host, scope, level, root, env: {}, home });
          fs.mkdirSync(path.dirname(r.target_file), { recursive: true });
          fs.writeFileSync(r.target_file, JSON.stringify(r.config, null, 2) + '\n');
          const res = await lint.lintPaths([r.target_file], { root, home, env: {} });
          assert.notEqual(res.files[0].kind, 'unknown', `${host}/${scope} target is a known tooling location`);
          const bad = findings(res).filter((f) => f.sev !== 'note').map((f) => `${f.host}: ${f.rule}: ${f.message}`);
          assert.deepEqual(bad, [], `${host} ${scope} ${level}`);
          assert.deepEqual(res.security, [], `${host} ${scope} ${level}`);
          fs.rmSync(r.target_file);
          rendered++;
        }
      }
    }
    assert.ok(rendered >= 18);
  });
});

// ---------------------------------------------------------------------------
// External validators (fakes; one guarded real run of the free `claude plugin validate`)

const ok = (stdout = '', exit = 0, stderr = '') => ({ exit, signal: null, stdout, stderr, ms: 1, error: null, timedOut: false });
function fakeTools(handlers, versions = {}) {
  const calls = [];
  return {
    calls,
    which: (name) => (handlers[name] ? `/fake/bin/${name}` : null),
    version: (name) => ({ path: `/fake/bin/${name}`, version: versions[name] || '99.0.0', raw: '' }),
    exec: (exe, args, opts) => { const tool = path.posix.basename(exe); calls.push([tool, ...args]); return handlers[tool](args, opts); },
  };
}
const skillMd = (name, extra = '') => `---\nname: ${name}\ndescription: Does a thing. Use when testing.${extra}\n---\n# ${name}\n\nBody.\n`;

describe('tooling-lint: external validators', () => {
  test('skills-ref: pass, and each "- problem" item (with wrapped lines) becomes a spec error', () => {
    const root = materialize({ 'skills/a/SKILL.md': skillMd('a'), 'skills/b/SKILL.md': skillMd('b') });
    const skills = ['a', 'b'].map((n) => ({ dir: path.join(root, 'skills', n), file: path.join(root, 'skills', n, 'SKILL.md'), name: n }));
    const tools = fakeTools({ 'skills-ref': (args) => (args[1].endsWith('a') ? ok('Valid skill: skills/a\n')
      : ok('', 1, 'Validation failed for skills/b:\n  - Invalid YAML in frontmatter: While scanning\n    metadata: {x: 1}\n  - Unexpected fields in frontmatter: bogus\n')) });
    const out = lint.runExternalValidators({ root, skills, hosts: ['spec'] }, tools).filter((e) => e.tool === 'skills-ref');
    assert.deepEqual(out.map((e) => e.status), ['pass', 'fail']);
    assert.deepEqual(out[1].findings.map((f) => f.message), ['skills-ref: Invalid YAML in frontmatter: While scanning metadata: {x: 1}', 'skills-ref: Unexpected fields in frontmatter: bogus']);
    assert.ok(out[1].findings.every((f) => f.rule === 'EXT-SKILLS-REF' && f.severity === 'error' && f.host === 'spec'));
    const none = lint.runExternalValidators({ root, skills, hosts: ['spec'] }, fakeTools({})).filter((e) => e.tool === 'skills-ref');
    assert.ok(none.every((e) => e.status === 'skipped' && /uv tool install/.test(e.summary)));
  });

  test('claude plugin validate: a bare skills directory is not applicable, never a pass', () => {
    const root = materialize({ 'skills/a/SKILL.md': skillMd('a') });
    const skills = [{ dir: path.join(root, 'skills', 'a'), file: path.join(root, 'skills', 'a', 'SKILL.md'), name: 'a' }];
    const bare = JSON.stringify({ success: true, strict: true, target: path.join(root, 'skills'), manifest: null, contents: [], advice: [], directory: null });
    const out = lint.runExternalValidators({ root, skills, hosts: ['claude'] }, fakeTools({ claude: () => ok(bare) }, { claude: '2.1.310' }));
    assert.equal(out.find((e) => e.tool === 'claude plugin validate').status, 'not-applicable');
    const old = lint.runExternalValidators({ root, skills, hosts: ['claude'] }, fakeTools({ claude: () => ok(bare) }, { claude: '2.1.200' }));
    assert.equal(old.find((e) => e.tool === 'claude plugin validate').status, 'skipped');
    const garbage = lint.runExternalValidators({ root, skills, hosts: ['claude'] }, fakeTools({ claude: () => ok('', 2, 'boom') }, { claude: '2.1.310' }));
    assert.equal(garbage.find((e) => e.tool === 'claude plugin validate').status, 'error');
  });

  test('claude plugin validate: plugin errors and warnings merge into the manifest; listing findings are notes', async () => {
    const root = materialize({ 'plug/.claude-plugin/plugin.json': j({ name: 'plug', version: '1.0.0', description: 'x', author: { name: 'a' } }) });
    const manifest = path.join(root, 'plug', '.claude-plugin', 'plugin.json');
    const report = { success: false, strict: true, manifest: { file: manifest, type: 'plugin', errors: [{ path: 'hooks', message: 'Invalid input' }], warnings: [{ path: 'keywords', message: 'unused' }] },
      contents: [], directory: { findings: [{ code: 'README_MISSING', title: 'README missing', severity: 'error', message: 'This plugin has no README.md.' }] } };
    const tools = fakeTools({ claude: () => ok(JSON.stringify(report), 1) }, { claude: '2.1.310' });
    const res = await lint.lintPaths([path.join(root, 'plug')], { root, external: true, host: 'claude', home: path.join(root, 'home'), env: {}, ...tools });
    const ext = res.external.find((e) => e.tool === 'claude plugin validate');
    assert.equal(ext.status, 'fail');
    assert.equal(ext.findings[0].file, 'plug/.claude-plugin/plugin.json', 'external findings are reported with display paths');
    const all = findings(res).filter((f) => f.rule === 'EXT-CLAUDE-VALIDATE');
    assert.deepEqual(all.map((f) => f.sev).sort(), ['error', 'note', 'warning']);
    assert.ok(all.find((f) => f.sev === 'error').message.includes('hooks: Invalid input'));
    assert.equal(res.summary.clean, false);
    assert.equal(res.summary.external.failed, 1);
  });

  test('gh skill publish --dry-run: only gh-discoverable skills; TSV errors are errors, warnings notes', () => {
    const root = materialize({ 'skills/good/SKILL.md': skillMd('good'), 'skills/Bad_Skill/SKILL.md': skillMd('Bad_Skill'), '.github/skills/hidden/SKILL.md': skillMd('hidden') });
    const mk = (rel, name) => ({ dir: path.join(root, ...rel.split('/')), file: path.join(root, ...rel.split('/'), 'SKILL.md'), name });
    const tsv = ['error\tBad_Skill\tname "Bad_Skill" does not follow agentskills.io naming convention', 'warning\tgood\trecommended field missing: license',
      'warning\t\tno git remote found. Create a GitHub repository with: gh repo create', 'validation failed with 1 error(s)', ''].join('\n');
    const tools = fakeTools({ gh: () => ok(tsv, 1) }, { gh: '2.99.0' });
    const out = lint.runExternalValidators({ root, skills: [mk('skills/good', 'good'), mk('skills/Bad_Skill', 'Bad_Skill')], hosts: ['spec'] }, tools).find((e) => e.tool === 'gh skill publish');
    assert.equal(out.status, 'fail');
    assert.deepEqual(out.findings.map((f) => `${f.severity}:${path.basename(path.dirname(f.abs))}`), ['error:Bad_Skill', 'note:good']);
    assert.match(out.summary, /no git remote found/);
    assert.deepEqual(tools.calls[0], ['gh', 'skill', 'publish', '--dry-run', root]);
    const hidden = lint.runExternalValidators({ root, skills: [mk('.github/skills/hidden', 'hidden')], hosts: ['spec'] }, tools).find((e) => e.tool === 'gh skill publish');
    assert.equal(hidden.status, 'not-applicable');
    const oldGh = lint.runExternalValidators({ root, skills: [mk('skills/good', 'good')], hosts: ['spec'] }, fakeTools({ gh: () => ok('') }, { gh: '2.89.0' }));
    assert.equal(oldGh.find((e) => e.tool === 'gh skill publish').status, 'skipped');
    const repoOnly = lint.runExternalValidators({ root, skills: [mk('skills/good', 'good')], hosts: ['spec'] }, fakeTools({ gh: () => ok('', 1, 'not a git repository') }, { gh: '2.99.0' }));
    assert.equal(repoOnly.find((e) => e.tool === 'gh skill publish').status, 'error', 'a failure without skill errors is not a validation failure');
  });

  test('copilot skill list / instruction list: listed, disabled, shadowed, missing, out of scope', () => {
    const root = materialize({
      '.agents/skills/one/SKILL.md': skillMd('one'), '.claude/skills/one/SKILL.md': skillMd('one'), '.github/skills/off/SKILL.md': skillMd('off'),
      '.github/skills/gone/SKILL.md': skillMd('gone'), 'skills/elsewhere/SKILL.md': skillMd('elsewhere'),
      'AGENTS.md': '# A\n', 'docs/AGENTS.md': '# nested\n', '.github/copilot-instructions.md': 'x\n',
    });
    const mk = (rel) => ({ dir: path.join(root, ...rel.split('/')), file: path.join(root, ...rel.split('/'), 'SKILL.md'), name: path.posix.basename(rel) });
    const rows = [{ name: 'one', path: path.join(root, '.agents', 'skills', 'one'), enabled: true, source: 'project' },
      { name: 'off', path: path.join(root, '.github', 'skills', 'off'), enabled: false, source: 'project' }];
    const instr = [{ sourcePath: 'AGENTS.md' }];
    const tools = fakeTools({ copilot: (args) => ok(JSON.stringify(args[0] === 'skill' ? rows : instr)) });
    const skills = ['.agents/skills/one', '.claude/skills/one', '.github/skills/off', '.github/skills/gone', 'skills/elsewhere'].map(mk);
    const instructions = ['AGENTS.md', 'docs/AGENTS.md', '.github/copilot-instructions.md'].map((r) => path.join(root, ...r.split('/')));
    const out = lint.runExternalValidators({ root, skills, instructions, hosts: ['copilot'], env: {}, home: path.join(root, 'home') }, tools);
    const sk = out.find((e) => e.tool === 'copilot skill list');
    const by = Object.fromEntries(sk.findings.map((f) => [toRel(root, f.abs), `${f.severity}:${f.message}`]));
    assert.equal(by['.agents/skills/one/SKILL.md'], undefined);
    assert.match(by['.claude/skills/one/SKILL.md'], /^note:Copilot loads "one" from \.agents\/skills\/one/);
    assert.match(by['.github/skills/off/SKILL.md'], /^warning:.*disabled/);
    assert.match(by['.github/skills/gone/SKILL.md'], /^warning:.*does not show "gone"/);
    assert.equal(by['skills/elsewhere/SKILL.md'], undefined, 'not in a Copilot skill folder: not checked');
    assert.equal(sk.status, 'fail');
    const ins = out.find((e) => e.tool === 'copilot instruction list');
    assert.deepEqual(ins.findings.map((f) => toRel(root, f.abs)), ['.github/copilot-instructions.md'], 'nested AGENTS.md is not expected in the root listing');
    const na = lint.runExternalValidators({ root, skills: [mk('skills/elsewhere')], hosts: ['copilot'], env: {}, home: path.join(root, 'home') }, tools);
    assert.equal(na[0].status, 'not-applicable');
  });

  test('codex debug prompt-input and codex doctor: listed skills, ignored config keys (no model call)', () => {
    const root = materialize({ '.agents/skills/one/SKILL.md': skillMd('one'), '.agents/skills/two/SKILL.md': skillMd('two'), 'home/.agents/skills/one/SKILL.md': skillMd('one'),
      '.codex/config.toml': 'bogus = 1\n', 'sub/.codex/config.toml': '', 'home/.codex/config.toml': 'model = "x"\n' });
    const home = path.join(root, 'home');
    const block = ['<skills_instructions>', '## Skills', '### Skill roots', `- \`r0\` = \`${path.join(root, '.agents', 'skills')}\``, '### Available skills',
      '- one: Does a thing. Use when testing (really). (file: r0/one/SKILL.md)', '</skills_instructions>'].join('\n');
    const stdout = JSON.stringify([{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: `intro\n${block}\n` }] }]);
    const doctor = JSON.stringify({ schemaVersion: 1, checks: { 'config.load': { status: 'warning', details: { 'config.toml': path.join(home, '.codex', 'config.toml'),
      'startup warning': `Codex is ignoring 1 unrecognized configuration setting.\n  project (${path.join(root, '.codex', 'config.toml')}): \`bogus\` is ignored.` } } } });
    const tools = fakeTools({ codex: (args) => ok(args[0] === 'doctor' ? doctor : stdout, args[0] === 'doctor' ? 1 : 0) });
    const skills = ['.agents/skills/one', '.agents/skills/two', 'home/.agents/skills/one'].map((rel) => ({ dir: path.join(root, ...rel.split('/')), file: path.join(root, ...rel.split('/'), 'SKILL.md'), name: path.posix.basename(rel) }));
    const configs = ['.codex/config.toml', 'sub/.codex/config.toml', 'home/.codex/config.toml'].map((r) => path.join(root, ...r.split('/')));
    const out = lint.runExternalValidators({ root, skills, codexConfigs: configs, hosts: ['codex'], env: {}, home }, tools);
    const cx = out.find((e) => e.tool === 'codex');
    assert.deepEqual(tools.calls[0], ['codex', 'debug', 'prompt-input', 'x']);
    const by = Object.fromEntries(cx.findings.map((f) => [toRel(root, f.abs), f.severity]));
    assert.deepEqual(by, { '.agents/skills/two/SKILL.md': 'warning', 'home/.agents/skills/one/SKILL.md': 'note' });
    assert.equal(cx.status, 'fail');
    const doc = Object.fromEntries(out.filter((e) => e.tool === 'codex doctor').map((e) => [e.target, e]));
    assert.equal(doc['.codex/config.toml'].status, 'fail');
    assert.match(doc['.codex/config.toml'].findings[0].message, /Codex ignores `bogus`/);
    assert.equal(doc['.codex/config.toml'].findings[0].rule, 'EXT-CODEX-CONFIG');
    assert.equal(doc['sub/.codex/config.toml'].status, 'not-applicable', 'a layer Codex did not load is not verified');
    assert.equal(doc['home/.codex/config.toml'].status, 'pass');
    assert.ok(!tools.calls.some((c) => c.includes('exec')), 'never a billed codex exec');
    assert.deepEqual(lint.codexListedSkills('no block here'), null);
    const noBlock = lint.runExternalValidators({ root, skills: skills.slice(0, 1), hosts: ['codex'], env: {}, home }, fakeTools({ codex: () => ok('[]') }));
    assert.equal(noBlock[0].status, 'error');
  });

  test('waza: runs only with an eval.yaml; a failure is a Copilot warning', () => {
    const root = materialize({ 'skills/w/SKILL.md': skillMd('w'), 'evals/w/eval.yaml': 'name: w\n' });
    const skills = [{ dir: path.join(root, 'skills', 'w'), file: path.join(root, 'skills', 'w', 'SKILL.md'), name: 'w' }];
    const out = lint.runExternalValidators({ root, skills, hosts: ['copilot'], env: {}, home: path.join(root, 'home') }, fakeTools({ waza: () => ok('2 of 3 tasks failed', 1) }));
    const w = out.find((e) => e.tool === 'waza');
    assert.equal(w.status, 'fail');
    assert.equal(w.findings[0].rule, 'EXT-WAZA');
  });

  test('every external rule is produced by some validator above', () => {
    const ids = lint.RULES.filter((r) => r.kind === 'external').map((r) => r.id).sort();
    assert.deepEqual(ids, ['EXT-CLAUDE-VALIDATE', 'EXT-CODEX-CONFIG', 'EXT-CODEX-SKILL', 'EXT-COPILOT-INSTRUCTION', 'EXT-COPILOT-SKILL', 'EXT-GH-SKILL', 'EXT-SKILLS-REF', 'EXT-WAZA']);
  });

  test('real claude plugin validate (free, no model call) when installed', async (t) => {
    const v = core.toolVersion('claude');
    if (!v || !core.versionGte(v.version || '0.0.0', '2.1.259')) { t.skip('claude >= 2.1.259 is not installed'); return; }
    const root = materialize({
      'skills/a/SKILL.md': skillMd('a'),
      'plug/.claude-plugin/plugin.json': j({ name: 'plug', version: '1.0.0', description: 'A test plugin', author: { name: 'tester' }, license: 'MIT' }),
      'plug/README.md': 'A test plugin.\n',
    });
    const skills = [{ dir: path.join(root, 'skills', 'a'), file: path.join(root, 'skills', 'a', 'SKILL.md'), name: 'a' }];
    // Claude Code writes settings backups into its config folder: keep them in the temp dir.
    const configDir = tmp('adc-claude-cfg-');
    const exec = (exe, args, o) => lint.execTool(exe, args, { ...o, env: { ...process.env, CLAUDE_CONFIG_DIR: configDir } });
    const out = lint.runExternalValidators({ root, skills, plugins: [path.join(root, 'plug')], hosts: ['claude'], env: {}, home: path.join(root, 'home') }, { exec });
    const byTarget = Object.fromEntries(out.filter((e) => e.tool === 'claude plugin validate').map((e) => [e.target, e.status]));
    assert.equal(byTarget.skills, 'not-applicable');
    assert.equal(byTarget.plug, 'pass');
  });
});

function toRel(root, abs) { return core.toPosix(path.relative(root, abs)); }
function j(v) { return JSON.stringify(v, null, 2) + '\n'; }

// ---------------------------------------------------------------------------
// CLI end to end: node scripts/adc.mjs tooling lint --json --cwd <temp repo>

function gitInit(dir) {
  const r = spawnSync('git', ['init', '-q'], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}
function adc(args, { cwd, env = {} } = {}) {
  const r = spawnSync(process.execPath, [core.ADC_SCRIPT, ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, ADC_LINT_NO_EXTERNAL: '1', CI: '', GITHUB_ACTIONS: '', ...env },
  });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch {}
  return { exit: r.status, json, stdout: r.stdout, stderr: r.stderr };
}

describe('tooling-lint: CLI (adc.mjs tooling lint)', () => {
  let available = true;
  test('tooling lint is reachable through the tooling group', async (t) => {
    try { const m = await import('../../skills/agentic-developer-companion/scripts/lib/tooling.mjs'); available = typeof m.toolingCommand === 'function'; } catch { available = false; }
    if (!available) t.skip('tooling.mjs (WP-J) is not available; lintCommand is tested directly below');
  });

  test('clean repository: exit 0, ASCII JSON with the documented shape', async (t) => {
    if (!available) { t.skip('tooling.mjs missing'); return; }
    const dir = materialize({ '.github/skills/good-skill/SKILL.md': skillMd('good-skill', '\nlicense: MIT'), 'AGENTS.md': '# Agents\n\nRun the tests with npm test.\n' });
    gitInit(dir);
    const r = adc(['tooling', 'lint', '--json', '--cwd', dir, '--strict']);
    assert.equal(r.exit, 0, r.stdout + r.stderr);
    assert.ok(/^[\x00-\x7f]*$/.test(r.stdout), 'ASCII-only stdout');
    assert.deepEqual(r.json.files.map((f) => f.path).sort(), ['.github/skills/good-skill/SKILL.md', 'AGENTS.md']);
    for (const f of r.json.files) for (const h of f.host_results) assert.deepEqual([...h.errors, ...h.warnings], [], `${f.path} ${h.host}`);
    assert.equal(r.json.summary.clean, true);
    assert.deepEqual(r.json.external, [], 'ADC_LINT_NO_EXTERNAL skips the external validators');
    assert.match(r.stderr, /tooling: 2 file\(s\), 0 error\(s\)/);
  });

  test('findings: exit 1; --host narrows the results; explicit paths', async (t) => {
    if (!available) { t.skip('tooling.mjs missing'); return; }
    const dir = materialize({ 'skills/Bad/SKILL.md': skillMd('Bad'), '.github/hooks/h.json': j({ version: 1, hooks: { preToolUse: [{ type: 'command', bash: 'x.sh' }] } }) });
    gitInit(dir);
    const all = adc(['tooling', 'lint', '--json', '--cwd', dir, 'skills']);
    assert.equal(all.exit, 1);
    assert.ok(all.json.files.every((f) => f.path.startsWith('skills/')), 'only the named path');
    assert.ok(findings(all.json).some((f) => f.rule === 'SK-NAME-FORMAT' && f.host === 'spec'));
    const codex = adc(['tooling', 'lint', '--json', '--cwd', dir, '--host', 'codex']);
    assert.ok(codex.json.files.every((f) => f.host_results.every((h) => h.host === 'codex')));
    const hooks = adc(['tooling', 'lint', '.github/hooks/h.json', '--json', '--cwd', dir]);
    assert.ok(findings(hooks.json).some((f) => f.rule === 'HK-CP-NO-WINDOWS'));
  });

  test('usage errors exit 2; a tracked .adc/ exits 3', async (t) => {
    if (!available) { t.skip('tooling.mjs missing'); return; }
    const dir = materialize({ 'AGENTS.md': '# A\n' });
    gitInit(dir);
    const bad = adc(['tooling', 'lint', '--json', '--cwd', dir, '--host', 'vscode']);
    assert.equal(bad.exit, 2);
    assert.equal(bad.json.error.code, 'USAGE');
    assert.equal(adc(['tooling', 'lint', 'nope.md', '--json', '--cwd', dir]).exit, 2);
    fs.mkdirSync(path.join(dir, '.adc'));
    fs.writeFileSync(path.join(dir, '.adc', 'x.json'), '{}\n');
    assert.equal(spawnSync('git', ['add', '-f', '.adc/x.json'], { cwd: dir }).status, 0);
    assert.equal(adc(['tooling', 'lint', '--json', '--cwd', dir]).exit, 3);
  });

  test('lintCommand directly: human output, --allow-host, outside a git repository', async () => {
    const dir = materialize({ '.github/hooks/a.json': j({ version: 1, hooks: { postToolUse: [{ type: 'http', url: 'https://audit.example.net/h', timeoutSec: 5 }] } }) });
    const denied = await lint.lintCommand(['--cwd', dir, '--no-external']);
    assert.equal(denied.exit, 0, 'a security warning fails the run only with --strict');
    assert.ok(denied.result.security.some((s) => s.rule === 'SEC-HTTP-HOOK'));
    assert.match(denied.human, /security:\n {2}warning SEC-HTTP-HOOK/);
    assert.equal((await lint.lintCommand(['--cwd', dir, '--no-external', '--strict'])).exit, 1);
    const allowed = await lint.lintCommand(['--cwd', dir, '--no-external', '--allow-host', 'audit.example.net']);
    assert.deepEqual(allowed.result.security, []);
    assert.equal(allowed.exit, 0);
    const help = await lint.lintCommand(['--help']);
    assert.match(help.human, /--host all\|copilot\|claude\|codex/);
  });
});
