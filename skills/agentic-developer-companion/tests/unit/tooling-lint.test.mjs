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
} from '../../scripts/lib/frontmatter.mjs';
import * as lint from '../../scripts/lib/tooling-lint.mjs';
import * as core from '../../scripts/lib/core.mjs';

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
      // Nothing secret-shaped ever reaches the output.
      assert.ok(!JSON.stringify(res).includes(SECRETS.aws), 'secret leaked into the lint result');
    });
  }

  test('every catalog rule except external validators fires in at least one case', () => {
    const missing = lint.RULES.filter((r) => r.kind !== 'external' && !triggered.has(r.id)).map((r) => r.id);
    assert.deepEqual(missing, []);
  });
});
