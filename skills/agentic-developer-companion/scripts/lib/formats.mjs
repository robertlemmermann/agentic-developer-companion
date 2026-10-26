// Config-file readers shared by detect, deps, diff-scope and the tooling modules: TOML
// (strict for linting, lenient for manifests and lockfiles), INI and JSON with comments.
// Zero dependencies; every reader handles a BOM and \r\n. YAML lives in frontmatter.mjs.

import { stripBom } from './core.mjs';

// ---------------------------------------------------------------------------
// TOML

const isTable = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const BARE_KEY = /[A-Za-z0-9_-]+/y;
const DATE_RE = /\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:\d{2})?)?|\d{2}:\d{2}:\d{2}(?:\.\d+)?/y;
const NUMBER_RE = /[+-]?(?:0x[0-9a-fA-F_]+|0o[0-7_]+|0b[01_]+|inf|nan|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d[\d_]*)?)(?![A-Za-z0-9_.:-])/y;
const BOOL_RE = /(?:true|false)(?![A-Za-z0-9_-])/y;
const RAW_RE = /[^,\]}\n#]+/y;
const ESCAPES = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\', e: '\x1b' };

class TomlError extends Error {
  constructor(message, line) {
    super(message);
    this.line = line;
  }
}

class TomlParser {
  constructor(text, lenient) {
    this.s = stripBom(String(text ?? '')).replace(/\r\n?/g, '\n');
    this.p = 0;
    this.lenient = lenient;
    this.root = {};
    this.cur = this.root;
    this.prefix = '';
    this.keyLines = {};
    this.errors = [];
    // Line starts for O(log n) line numbers (lockfiles have tens of thousands of keys).
    this.starts = [0];
    for (let i = 0; i < this.s.length; i++) if (this.s[i] === '\n') this.starts.push(i + 1);
  }

  line(pos = this.p) {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid] <= pos) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  }

  fail(msg) { throw new TomlError(msg, this.line()); }
  excerpt() { return this.s.slice(this.p, this.p + 20).split('\n')[0]; }
  ws() { while (this.s[this.p] === ' ' || this.s[this.p] === '\t') this.p++; }
  skipComment() { if (this.s[this.p] === '#') while (this.p < this.s.length && this.s[this.p] !== '\n') this.p++; }

  skipTrivia() {
    for (;;) {
      this.ws();
      this.skipComment();
      if (this.s[this.p] !== '\n') return;
      this.p++;
    }
  }

  sticky(re) {
    re.lastIndex = this.p;
    const m = re.exec(this.s);
    if (m) this.p += m[0].length;
    return m ? m[0] : null;
  }

  parse() {
    for (;;) {
      this.skipTrivia();
      if (this.p >= this.s.length) return this.root;
      const start = this.p;
      try {
        this.statement();
      } catch (err) {
        if (!(err instanceof TomlError)) throw err;
        this.errors.push({ line: err.line, message: err.message });
        if (!this.lenient) return null;
        // Lenient: drop the rest of the line the error is on and carry on with the next one.
        this.p = Math.max(this.p, start);
        while (this.p < this.s.length && this.s[this.p] !== '\n') this.p++;
      }
    }
  }

  statement() {
    if (this.s[this.p] === '[') {
      const isArray = this.s[this.p + 1] === '[';
      this.p += isArray ? 2 : 1;
      const keys = this.keyPath();
      if (isArray ? !this.s.startsWith(']]', this.p) : this.s[this.p] !== ']') this.fail('unterminated table header');
      this.p += isArray ? 2 : 1;
      this.endLine();
      this.prefix = keys.join('.');
      this.keyLines[this.prefix] ??= this.line();
      if (isArray) {
        const parent = this.walk(this.root, keys.slice(0, -1));
        const k = keys[keys.length - 1];
        if (parent[k] === undefined || (this.lenient && !Array.isArray(parent[k]))) parent[k] = [];
        if (!Array.isArray(parent[k])) this.fail(`${keys.join('.')} is already a table`);
        const t = {};
        parent[k].push(t);
        this.cur = t;
      } else this.cur = this.walk(this.root, keys);
      return;
    }
    const keys = this.keyPath();
    if (this.s[this.p] !== '=') this.fail('expected "=" after a key');
    this.p++;
    this.ws();
    const line = this.line();
    const value = this.value();
    this.endLine();
    const parent = this.walk(this.cur, keys.slice(0, -1));
    const k = keys[keys.length - 1];
    if (!this.lenient && Object.hasOwn(parent, k)) this.fail(`duplicate key "${k}"`);
    parent[k] = value;
    this.keyLines[[this.prefix, ...keys].filter(Boolean).join('.')] = line;
  }

  endLine() {
    this.ws();
    this.skipComment();
    if (this.p < this.s.length && this.s[this.p] !== '\n') this.fail(`unexpected text: ${this.excerpt()}`);
  }

  walk(base, keys) {
    let t = base;
    for (const k of keys) {
      if (t[k] === undefined || (this.lenient && t[k] !== null && typeof t[k] !== 'object')) t[k] = {};
      t = Array.isArray(t[k]) ? t[k][t[k].length - 1] : t[k];
      if (!isTable(t)) this.fail(`"${k}" is not a table`);
    }
    return t;
  }

  keyPath() {
    const keys = [];
    for (;;) {
      this.ws();
      const ch = this.s[this.p];
      if (ch === '"') keys.push(this.basicString());
      else if (ch === "'") keys.push(this.literalString());
      else {
        const k = this.sticky(BARE_KEY);
        if (k == null) this.fail('expected a key');
        keys.push(k);
      }
      this.ws();
      if (this.s[this.p] !== '.') return keys;
      this.p++;
    }
  }

  basicString() {
    const multi = this.s.startsWith('"""', this.p);
    this.p += multi ? 3 : 1;
    if (multi && this.s[this.p] === '\n') this.p++;
    let out = '';
    for (;;) {
      if (this.p >= this.s.length) this.fail('unterminated string');
      const ch = this.s[this.p];
      if (multi ? this.s.startsWith('"""', this.p) : ch === '"') {
        this.p += multi ? 3 : 1;
        // `""""` ends a multi-line string with a quote inside it (up to two extra quotes).
        if (multi) for (let n = 0; n < 2 && this.s[this.p] === '"'; n++) { out += '"'; this.p++; }
        return out;
      }
      if (!multi && ch === '\n') this.fail('newline in a basic string');
      if (ch === '\\') {
        const e = this.s[this.p + 1];
        if (e in ESCAPES) { out += ESCAPES[e]; this.p += 2; continue; }
        if (e === 'u' || e === 'U') {
          const n = e === 'u' ? 4 : 8;
          const hex = this.s.slice(this.p + 2, this.p + 2 + n);
          if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== n) this.fail('invalid unicode escape');
          out += String.fromCodePoint(parseInt(hex, 16));
          this.p += 2 + n;
          continue;
        }
        if (multi && /[ \t\n]/.test(e)) {
          this.p++;
          while (/[ \t\n]/.test(this.s[this.p] || '')) this.p++;
          continue;
        }
        if (!this.lenient) this.fail(`invalid escape \\${e}`);
        out += e ?? '';
        this.p += 2;
        continue;
      }
      out += ch;
      this.p++;
    }
  }

  literalString() {
    const multi = this.s.startsWith("'''", this.p);
    this.p += multi ? 3 : 1;
    if (multi && this.s[this.p] === '\n') this.p++;
    const end = this.s.indexOf(multi ? "'''" : "'", this.p);
    if (end < 0) this.fail('unterminated string');
    let out = this.s.slice(this.p, end);
    if (!multi && out.includes('\n')) this.fail('newline in a literal string');
    this.p = end + (multi ? 3 : 1);
    if (multi) for (let n = 0; n < 2 && this.s[this.p] === "'"; n++) { out += "'"; this.p++; }
    return out;
  }

  value() {
    const ch = this.s[this.p];
    if (ch === '"') return this.basicString();
    if (ch === "'") return this.literalString();
    if (ch === '[') {
      this.p++;
      const arr = [];
      for (;;) {
        this.skipTrivia();
        if (this.s[this.p] === ']') { this.p++; return arr; }
        arr.push(this.value());
        this.skipTrivia();
        if (this.s[this.p] === ',') { this.p++; continue; }
        if (this.s[this.p] !== ']') this.fail('expected "," or "]" in an array');
      }
    }
    if (ch === '{') {
      this.p++;
      const t = {};
      this.ws();
      if (this.s[this.p] === '}') { this.p++; return t; }
      for (;;) {
        const keys = this.keyPath();
        if (this.s[this.p] !== '=') this.fail('expected "=" in an inline table');
        this.p++;
        this.ws();
        this.walk(t, keys.slice(0, -1))[keys[keys.length - 1]] = this.value();
        this.ws();
        if (this.s[this.p] === ',') { this.p++; this.ws(); continue; }
        if (this.s[this.p] === '}') { this.p++; return t; }
        this.fail('expected "," or "}" in an inline table');
      }
    }
    let m = this.sticky(BOOL_RE);
    if (m) return m === 'true';
    m = this.sticky(DATE_RE);
    if (m) return m;
    m = this.sticky(NUMBER_RE);
    if (m) {
      const t = m.replace(/_/g, '');
      if (/inf$/.test(t)) return t.startsWith('-') ? -Infinity : Infinity;
      if (/nan$/.test(t)) return NaN;
      return Number(t.replace(/^\+(?=0[xob])/, ''));
    }
    // Lenient: an unquoted value TOML does not allow (`1.2.3`, `latest`) is kept as its text.
    if (this.lenient && (m = this.sticky(RAW_RE))) return m.trim();
    this.fail(`invalid value: ${this.excerpt()}`);
    return null;
  }
}

/**
 * Parse TOML. Strict (default): stops at the first problem, `value` is null then. Lenient
 * (manifests, lockfiles): a line it cannot parse is skipped and recorded, duplicate keys
 * overwrite, and unquoted non-TOML values are kept as strings.
 * Returns `{ value, error, errors[{line, message}], keyLines{'a.b': line} }`.
 */
export function parseToml(text, { lenient = false } = {}) {
  const p = new TomlParser(text, lenient);
  const value = p.parse();
  return { value: lenient ? p.root : value, error: p.errors[0] || null, errors: p.errors, keyLines: p.keyLines };
}

// ---------------------------------------------------------------------------
// INI

/**
 * INI reader (setup.cfg, tox.ini, pytest.ini, .flake8, mypy.ini, .editorconfig):
 * `{ section: { key: value } }`; indented continuation lines are joined with \n.
 */
export function parseIni(text) {
  const out = {};
  let sec = null;
  let last = null;
  for (const raw of stripBom(String(text ?? '')).split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim() || /^\s*[#;]/.test(line)) continue;
    const s = /^\[([^\]]+)\]/.exec(line);
    if (s) { sec = s[1].trim(); out[sec] = out[sec] || {}; last = null; continue; }
    if (/^\s/.test(line) && sec && last) {
      out[sec][last] = `${out[sec][last]}\n${line.trim()}`.replace(/^\n/, '');
      continue;
    }
    const m = /^([^=:\s][^=:]*?)\s*[=:]\s*(.*)$/.exec(line);
    if (m && sec) { last = m[1].trim(); out[sec][last] = m[2].trim(); }
  }
  return out;
}

// ---------------------------------------------------------------------------
// JSON with comments

/** Comments blanked (line structure kept, so error positions stay valid) and trailing commas removed. */
export function stripJsonc(text) {
  const s = stripBom(String(text ?? ''));
  let out = '';
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      out += ch;
      if (ch === '\\') { out += s[i + 1] ?? ''; i++; } else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; out += ch; continue; }
    if (ch === '/' && s[i + 1] === '/') { while (i < s.length && s[i] !== '\n') i++; out += '\n'; continue; }
    if (ch === '/' && s[i + 1] === '*') {
      const end = s.indexOf('*/', i + 2);
      out += s.slice(i, end < 0 ? s.length : end + 2).replace(/[^\n]/g, ' ');
      i = end < 0 ? s.length : end + 1;
      continue;
    }
    out += ch;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

const lineAt = (text, index) => (index <= 0 ? 1 : text.slice(0, index).split('\n').length);

/**
 * JSON.parse that reports where it failed. With `jsonc`, comments and trailing commas are
 * accepted (`jsonc: true` in the result); without it they are an error that still carries the
 * `looseValue`. Returns `{ value }` / `{ value, jsonc }` or `{ error, line, looseValue? }`.
 */
export function parseJson(text, { jsonc = false } = {}) {
  const src = stripBom(String(text ?? ''));
  const attempt = (s) => { try { return { value: JSON.parse(s) }; } catch (err) { return { error: err.message }; } };
  const strict = attempt(src);
  if (!strict.error) return { value: strict.value, jsonc: false };
  const loose = attempt(stripJsonc(src));
  const m = /line (\d+)/.exec(strict.error);
  const pos = /position (\d+)/.exec(strict.error);
  const line = m ? Number(m[1]) : pos ? lineAt(src, Number(pos[1])) : 1;
  if (!loose.error) {
    if (jsonc) return { value: loose.value, jsonc: true };
    return { error: 'comments or trailing commas are not valid JSON here', line, looseValue: loose.value };
  }
  return { error: strict.error.replace(/^Unexpected token/, 'unexpected token'), line };
}

/** JSONC value (tsconfig.json, bun.lock, .vscode/*.json), or null when it does not parse. */
export function parseJsonc(text) {
  const r = parseJson(text, { jsonc: true });
  return r.error ? null : r.value;
}
