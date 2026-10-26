// YAML frontmatter for SKILL.md, agents, instructions and prompt files: a parser for the YAML
// subset the hosts use (block and flow collections, plain, quoted, literal and folded scalars,
// comments, anchors, aliases) and a stringifier whose output parses back to the same data, plus
// a normalizer that compares `gh skill install` copies with their source, and the Markdown
// line and link helpers the tooling modules share. It reads untrusted files (lint, detect), so
// nesting deeper than the call stack and alias expansion ("billion laughs") are document errors.

import { isObj, stripBom, lineLocator } from './core.mjs';

// Moved to core.mjs; re-exported until tooling-lint imports it from there.
export { lineLocator };

export class YamlError extends Error {
  constructor(message, line = null, code = 'YAML_SYNTAX') {
    super(line ? `line ${line}: ${message}` : message);
    this.reason = message;
    this.line = line;
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Scalars

const NULL_RE = /^(?:~|null|Null|NULL)$/;
const TRUE_RE = /^(?:true|True|TRUE)$/;
const FALSE_RE = /^(?:false|False|FALSE)$/;
const INT_RE = /^[-+]?[0-9]+$/;
const FLOAT_RE = /^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?$/;

/** Resolve a plain scalar with the YAML 1.2 core schema (what the hosts' parsers use). */
export function resolvePlain(s) {
  if (s === '' || NULL_RE.test(s)) return null;
  if (TRUE_RE.test(s)) return true;
  if (FALSE_RE.test(s)) return false;
  if (INT_RE.test(s)) return Number(s);
  if (/^0o[0-7]+$/.test(s)) return parseInt(s.slice(2), 8);
  if (/^0x[0-9a-fA-F]+$/.test(s)) return parseInt(s.slice(2), 16);
  if (FLOAT_RE.test(s)) return Number(s);
  if (/^[-+]?\.(?:inf|Inf|INF)$/.test(s)) return s.startsWith('-') ? -Infinity : Infinity;
  if (/^\.(?:nan|NaN|NAN)$/.test(s)) return NaN;
  return s;
}

function applyTag(tag, raw, resolved, parser, line) {
  if (!tag) return resolved;
  switch (tag) {
    case '!!str': return raw == null ? '' : String(raw);
    case '!!int': { const n = Number(raw); return Number.isFinite(n) ? Math.trunc(n) : resolved; }
    case '!!float': { const n = Number(raw); return Number.isNaN(n) ? resolved : n; }
    case '!!bool': return TRUE_RE.test(String(raw)) ? true : FALSE_RE.test(String(raw)) ? false : resolved;
    case '!!null': return null;
    case '!!map': case '!!seq': case '!!binary': case '!!timestamp': return resolved;
    default:
      parser.warn(`tag ${tag} is not supported and was ignored`, line, 'UNSUPPORTED_TAG');
      return resolved;
  }
}

const ESCAPES = {
  '0': '\0', a: '\x07', b: '\b', t: '\t', '\t': '\t', n: '\n', v: '\v', f: '\f', r: '\r', e: '\x1b',
  ' ': ' ', '"': '"', '/': '/', '\\': '\\', N: '\x85', _: '\xa0', L: '\u2028', P: '\u2029',
};

const setKey = (obj, key, value) => {
  // A literal "__proto__" key must become data, not the object's prototype.
  if (key === '__proto__') Object.defineProperty(obj, key,
    { value, enumerable: true, writable: true, configurable: true });
  else obj[key] = value;
};

const isBlank = (line) => /^[ \t]*(?:#.*)?$/.test(line);
/** True when position `i` of `s` ends a token: the end of the text, a space or a tab (after ":" of a key). */
const endsToken = (s, i) => i >= s.length || s[i] === ' ' || s[i] === '\t';

// Aliases are copies: the nodes they copy are capped so a small document cannot exhaust memory.
const MAX_ALIAS_NODES = 100_000;
const nodeCount = (v) => (v !== null && typeof v === 'object'
  ? Object.values(v).reduce((n, x) => n + nodeCount(x), 1) : 1);

/** Cut a trailing comment from plain text: `#` at the start or after whitespace. */
function cutComment(s) {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '#' && (i === 0 || s[i - 1] === ' ' || s[i - 1] === '\t')) {
      return { text: s.slice(0, i), comment: true };
    }
  }
  return { text: s, comment: false };
}

// ---------------------------------------------------------------------------
// Block parser

class Parser {
  constructor(text, { lineOffset = 0 } = {}) {
    this.lines = text.split(/\r?\n/);
    this.endsWithNewline = /\n$/.test(text);
    if (this.endsWithNewline) this.lines.pop();
    this.offset = lineOffset;
    this.errors = [];
    this.warnings = [];
    this.keyLines = {};
    this.anchors = new Map();
    this.copied = 0;
    this.constructs = [];
  }

  anchor(name, value) { this.anchors.set(name, { value, size: nodeCount(value) }); }

  /** A copy of the anchored value (`i`: the 0-based line for errors). */
  alias(name, i) {
    const a = this.anchors.get(name);
    if (!a) this.fail(`unknown alias *${name}`, i, 'UNKNOWN_ALIAS');
    this.copied += a.size;
    if (this.copied > MAX_ALIAS_NODES) {
      this.fail(`aliases expand to more than ${MAX_ALIAS_NODES} nodes`, i, 'ALIAS_LIMIT');
    }
    return structuredClone(a.value);
  }

  ln(i) { return i + 1 + this.offset; }
  fail(message, i, code = 'YAML_SYNTAX') { throw new YamlError(message, this.ln(i), code); }
  warn(message, i, code) { this.warnings.push({ line: this.ln(i), code, message }); }
  error(message, i, code) { this.errors.push({ line: this.ln(i), code, message }); }
  // Valid YAML that strict parsers (strictyaml in skills-ref) reject: flow, anchor, alias, tag.
  construct(kind, i, path, text) { this.constructs.push({ kind, line: this.ln(i), path: path || null, text }); }

  indentOf(i) {
    const line = this.lines[i];
    let n = 0;
    while (n < line.length && line[n] === ' ') n++;
    if (line[n] === '\t') this.fail('tab characters are not allowed in indentation', i, 'TAB_INDENT');
    return n;
  }

  skipBlank(i) {
    while (i < this.lines.length && isBlank(this.lines[i])) i++;
    return i;
  }

  parseDocument() {
    let i = this.skipBlank(0);
    while (i < this.lines.length && /^%/.test(this.lines[i])) i = this.skipBlank(i + 1);
    if (i < this.lines.length && /^---(?:[ \t]|$)/.test(this.lines[i])) {
      const rest = this.lines[i].slice(3).trim();
      if (rest && !rest.startsWith('#')) this.lines[i] = '    ' + rest;
      else i = this.skipBlank(i + 1);
    }
    const { value, next } = this.parseNode(i, -1, '');
    let j = this.skipBlank(next);
    if (j < this.lines.length && /^\.\.\.[ \t]*$/.test(this.lines[j])) j = this.skipBlank(j + 1);
    if (j < this.lines.length) {
      if (/^---(?:[ \t]|$)/.test(this.lines[j])) this.fail('multiple YAML documents are not supported', j, 'MULTI_DOC');
      this.fail(`unexpected content: ${this.lines[j].trim().slice(0, 40)}`, j, 'UNEXPECTED');
    }
    return value;
  }

  /** A node whose lines are indented more than `parent`. */
  parseNode(i, parent, path) {
    const j = this.skipBlank(i);
    if (j >= this.lines.length) return { value: null, next: j };
    const n = this.indentOf(j);
    if (n <= parent) return { value: null, next: j };
    const content = this.lines[j].slice(n);
    if (/^-(?:[ \t]|$)/.test(content)) return this.parseSequence(j, n, path);
    if (this.splitKey(content, j)) return this.parseMapping(j, n, path);
    const r = this.parseInlineValue(j, n, parent, path);
    const k = this.skipBlank(r.next);
    if (k < this.lines.length && this.indentOf(k) > parent && !/^(?:---|\.\.\.)[ \t]*$/.test(this.lines[k])) {
      this.fail('unexpected content after a scalar value', k, 'UNEXPECTED');
    }
    return r;
  }

  /** `key: rest` split, or null when the text is not a mapping entry. */
  splitKey(content, i) {
    let key;
    let pos;
    const c0 = content[0];
    if (c0 === '"' || c0 === "'") {
      const q = this.scanQuotedLine(content, 0);
      if (!q) return null;
      key = q.value;
      pos = q.end;
      while (content[pos] === ' ' || content[pos] === '\t') pos++;
      if (content[pos] !== ':' || !endsToken(content, pos + 1)) return null;
    } else {
      if ('[{#|>*&!'.includes(c0)) return null;
      if (/^\?(?:[ \t]|$)/.test(content)) this.fail('complex mapping keys ("? ") are not supported', i, 'UNSUPPORTED');
      pos = -1;
      for (let k = 0; k < content.length; k++) {
        const ch = content[k];
        if (ch === '#' && k > 0 && (content[k - 1] === ' ' || content[k - 1] === '\t')) break;
        if (ch === ':' && endsToken(content, k + 1)) { pos = k; break; }
      }
      if (pos <= 0) return null;
      key = content.slice(0, pos).trim();
      if (!key) return null;
    }
    let restStart = pos + 1;
    while (content[restStart] === ' ' || content[restStart] === '\t') restStart++;
    return { key, rest: content.slice(restStart), restCol: restStart };
  }

  /** A double- or single-quoted scalar that ends on the same line; null when unterminated. */
  scanQuotedLine(s, start) {
    const q = s[start];
    let out = '';
    for (let p = start + 1; p < s.length; p++) {
      const ch = s[p];
      if (q === "'") {
        if (ch === "'") {
          if (s[p + 1] === "'") { out += "'"; p++; continue; }
          return { value: out, end: p + 1 };
        }
        out += ch;
      } else if (ch === '\\') {
        const r = this.decodeEscape(s, p, null);
        if (!r) return null;
        out += r.text;
        p = r.end - 1;
      } else if (ch === '"') return { value: out, end: p + 1 };
      else out += ch;
    }
    return null;
  }

  decodeEscape(s, p, i) {
    const e = s[p + 1];
    if (e === undefined) return null;
    if (e in ESCAPES) return { text: ESCAPES[e], end: p + 2 };
    const hex = { x: 2, u: 4, U: 8 }[e];
    if (hex) {
      const h = s.slice(p + 2, p + 2 + hex);
      if (h.length === hex && /^[0-9a-fA-F]+$/.test(h)) return { text: String.fromCodePoint(parseInt(h, 16)),
        end: p + 2 + hex };
    }
    if (i != null) this.fail(`invalid escape sequence \\${e}`, i, 'BAD_ESCAPE');
    return null;
  }

  parseMapping(i, n, path) {
    const obj = {};
    let j = i;
    for (;;) {
      j = this.skipBlank(j);
      if (j >= this.lines.length) break;
      const ind = this.indentOf(j);
      if (ind < n) break;
      if (ind > n) this.fail('unexpected indentation', j, 'BAD_INDENT');
      const content = this.lines[j].slice(n);
      if (n === 0 && /^(?:---|\.\.\.)[ \t]*$/.test(content)) break;
      const kv = this.splitKey(content, j);
      if (!kv) {
        if (/^-(?:[ \t]|$)/.test(content)) {
          this.fail('a sequence item cannot follow a mapping entry at the same indentation', j, 'BAD_INDENT');
        }
        this.fail(`expected "key: value", found: ${content.trim().slice(0, 40)}`, j, 'EXPECTED_KEY');
      }
      const keyPath = path ? `${path}.${kv.key}` : kv.key;
      if (Object.hasOwn(obj, kv.key)) this.error(`duplicate key "${kv.key}"`, j, 'DUPLICATE_KEY');
      if (!(keyPath in this.keyLines)) this.keyLines[keyPath] = this.ln(j);
      const r = this.parseValueAfterKey(j, n, n + kv.restCol, kv.rest, keyPath);
      setKey(obj, kv.key, r.value);
      j = r.next;
    }
    return { value: obj, next: j };
  }

  parseSequence(i, n, path) {
    const arr = [];
    let j = i;
    for (;;) {
      j = this.skipBlank(j);
      if (j >= this.lines.length) break;
      const ind = this.indentOf(j);
      if (ind < n) break;
      if (ind > n) this.fail('unexpected indentation', j, 'BAD_INDENT');
      const content = this.lines[j].slice(n);
      if (!/^-(?:[ \t]|$)/.test(content)) break;
      const itemPath = `${path}[${arr.length}]`;
      const after = content.slice(1);
      const pad = /^[ \t]*/.exec(after)[0].length;
      const rest = after.slice(pad);
      if (rest === '' || rest.startsWith('#')) {
        const r = this.parseNode(j + 1, n, itemPath);
        arr.push(r.value);
        j = r.next;
        continue;
      }
      // Re-read the item as if it started on its own line at its own column.
      const col = n + 1 + pad;
      this.lines[j] = ' '.repeat(col) + rest;
      const r = this.parseItem(j, col, n, itemPath);
      arr.push(r.value);
      j = r.next;
    }
    return { value: arr, next: j };
  }

  parseItem(j, col, parent, path) {
    const content = this.lines[j].slice(col);
    if (/^-(?:[ \t]|$)/.test(content)) return this.parseSequence(j, col, path);
    if (this.splitKey(content, j)) return this.parseMapping(j, col, path);
    return this.parseInlineValue(j, col, parent, path);
  }

  /** Leading `&anchor` / `!tag` properties of `text` on line j: `{ anchor, tag, len }` (`len`: characters used). */
  props(text, j, path) {
    let anchor = null;
    let tag = null;
    let len = 0;
    for (;;) {
      const m = /^([&!])(\S*)(?:[ \t]+|$)/.exec(text.slice(len));
      if (!m) return { anchor, tag, len };
      if (m[1] === '&') anchor = m[2];
      else tag = '!' + m[2];
      this.construct(m[1] === '&' ? 'anchor' : 'tag', j, path, m[0].trim());
      len += m[0].length;
    }
  }

  /** The value text after "key:" on line j (may continue on following lines). */
  parseValueAfterKey(j, n, col, rest, path) {
    const { anchor, tag, len } = this.props(rest, j, path);
    const text = rest.slice(len);
    const bare = cutComment(text).text.trim();
    let r;
    if (bare === '') {
      const k = this.skipBlank(j + 1);
      if (k < this.lines.length && this.indentOf(k) > n) r = this.parseNode(j + 1, n, path);
      else if (k < this.lines.length && this.indentOf(k) === n && /^-(?:[ \t]|$)/.test(this.lines[k].slice(n))) {
        r = this.parseSequence(k, n, path);
      }
      else r = { value: null, next: j + 1 };
      if (tag) r.value = applyTag(tag, r.value, r.value, this, j);
    } else {
      if (/^-(?:[ \t]|$)/.test(bare)) this.fail('a block sequence cannot start on the same line as its key', j,
        'BAD_SEQUENCE');
      r = this.parseInlineValue(j, col + len, n, path, tag);
    }
    if (anchor) this.anchor(anchor, r.value);
    return r;
  }

  /** Scalar, flow collection, alias or block scalar starting at (j, col). */
  parseInlineValue(j, col, parent, path, tag = null) {
    const line = this.lines[j];
    let c = col;
    let anchor = null;
    if (tag === null) {
      const p = this.props(line.slice(c), j, path);
      ({ anchor, tag } = p);
      c += p.len;
      if (c >= line.length || isBlank(line.slice(c))) {
        // "- &a" or "- !!str" followed by a nested block.
        const r = this.parseNode(j + 1, parent, path);
        if (anchor) this.anchor(anchor, r.value);
        r.value = applyTag(tag, r.value, r.value, this, j);
        return r;
      }
    }
    const ch = line[c];
    let r;
    if (ch === '"' || ch === "'") {
      r = this.parseQuoted(j, c);
      this.expectLineEnd(r.endLine, r.endCol);
      r.value = applyTag(tag, r.value, r.value, this, j);
    } else if (ch === '[' || ch === '{') {
      r = this.parseFlow(j, c, path);
      if (tag) r.value = applyTag(tag, r.value, r.value, this, j);
    } else if (ch === '|' || ch === '>') {
      r = this.parseBlockScalar(j, line.slice(c), parent);
      r.value = applyTag(tag, r.value, r.value, this, j);
    } else if (ch === '*') {
      const name = /^\*([^\s,\[\]{}]+)/.exec(line.slice(c))?.[1] || '';
      const value = this.alias(name, j);
      this.construct('alias', j, path, `*${name}`);
      this.expectLineEnd(j, c + 1 + name.length);
      r = { value, next: j + 1 };
    } else {
      r = this.parsePlain(j, c, parent, path);
      r.value = tag ? applyTag(tag, r.raw, resolvePlain(r.raw), this, j) : resolvePlain(r.raw);
    }
    if (anchor) this.anchor(anchor, r.value);
    return r;
  }

  expectLineEnd(i, col) {
    const tail = this.lines[i].slice(col);
    if (tail.trim() === '') return;
    if (/^[ \t]+#/.test(tail)) return;
    this.fail(`unexpected text after a value: ${tail.trim().slice(0, 40)}`, i, 'UNEXPECTED');
  }

  parsePlain(j, col, parent, path) {
    const first = cutComment(this.lines[j].slice(col));
    let raw = first.text.trim();
    const checkLine = (text, i) => {
      if (/:(?:[ \t]|$)/.test(text)) {
        this.warn(`unquoted ": " inside a plain scalar${path ? ` (${path})` : ''}; quote the value`, i,
          'UNQUOTED_COLON');
      }
    };
    if (/^[@`]/.test(raw)) this.warn(`a plain scalar cannot start with "${raw[0]}"; quote the value`, j,
      'RESERVED_INDICATOR');
    checkLine(raw, j);
    let k = j + 1;
    let next = j + 1;
    if (!first.comment) {
      let newlines = 0;
      while (k < this.lines.length) {
        const line = this.lines[k];
        if (line.trim() === '') { newlines++; k++; continue; }
        let ind = 0;
        while (ind < line.length && line[ind] === ' ') ind++;
        if (ind <= parent) break;
        const content = line.trim();
        if (content.startsWith('#')) break;
        if (ind === 0 && /^(?:---|\.\.\.)(?:[ \t]|$)/.test(line)) break;
        const cut = cutComment(content);
        checkLine(cut.text, k);
        raw += (newlines ? '\n'.repeat(newlines) : ' ') + cut.text.trim();
        newlines = 0;
        k++;
        next = k;
        if (cut.comment) break;
      }
    }
    return { raw, next };
  }

  parseQuoted(j, col) {
    const q = this.lines[j][col];
    let i = j;
    let p = col + 1;
    let out = '';
    let kept = 0; // characters produced by escapes are never trimmed by folding
    for (;;) {
      const line = this.lines[i];
      let joinNext = false;
      while (p < line.length) {
        const ch = line[p];
        if (q === "'") {
          if (ch === "'") {
            if (line[p + 1] === "'") { out += "'"; p += 2; continue; }
            return { value: out, next: i + 1, endLine: i, endCol: p + 1 };
          }
          out += ch;
          p++;
        } else if (ch === '\\') {
          if (p + 1 >= line.length) { joinNext = true; p++; break; }
          const r = this.decodeEscape(line, p, i);
          out += r.text;
          kept = out.length;
          p = r.end;
        } else if (ch === '"') {
          return { value: out, next: i + 1, endLine: i, endCol: p + 1 };
        } else {
          out += ch;
          p++;
        }
      }
      // Line folding inside a quoted scalar.
      if (!joinNext) out = out.slice(0, kept) + out.slice(kept).replace(/[ \t]+$/, '');
      i++;
      let empties = 0;
      while (i < this.lines.length && this.lines[i].trim() === '') { empties++; i++; }
      if (i >= this.lines.length) this.fail('unterminated quoted string', j, 'UNTERMINATED_QUOTE');
      if (/^(?:---|\.\.\.)(?:[ \t]|$)/.test(this.lines[i])) this.fail('unterminated quoted string', j,
        'UNTERMINATED_QUOTE');
      if (joinNext) out += '\n'.repeat(empties);
      else out += empties ? '\n'.repeat(empties) : ' ';
      kept = out.length;
      p = /^[ \t]*/.exec(this.lines[i])[0].length;
    }
  }

  parseBlockScalar(j, header, parent) {
    const style = header[0];
    let chomp = '';
    let indInd = 0;
    let h = 1;
    for (; h < header.length; h++) {
      const ch = header[h];
      if ((ch === '+' || ch === '-') && !chomp) chomp = ch;
      else if (/[1-9]/.test(ch) && !indInd) indInd = Number(ch);
      else break;
    }
    const tail = header.slice(h);
    if (tail.trim() !== '' && !/^[ \t]+#/.test(tail)) this.fail(`invalid block scalar header "${header.trim()}"`, j,
      'BAD_BLOCK_HEADER');
    const base = Math.max(parent, 0);
    let k = j + 1;
    let contentIndent = indInd ? base + indInd : null;
    if (contentIndent === null) {
      let m = k;
      while (m < this.lines.length && this.lines[m].trim() === '') m++;
      if (m < this.lines.length) {
        let ind = 0;
        while (this.lines[m][ind] === ' ') ind++;
        contentIndent = ind;
      } else contentIndent = parent + 1;
    }
    const content = [];
    if (contentIndent > parent) {
      while (k < this.lines.length) {
        const line = this.lines[k];
        if (line.trim() === '') {
          content.push(line.length > contentIndent ? line.slice(contentIndent) : '');
          k++;
          continue;
        }
        let ind = 0;
        while (ind < line.length && line[ind] === ' ') ind++;
        if (ind < contentIndent) break;
        content.push(line.slice(contentIndent));
        k++;
      }
    }
    // Trailing blank lines belong to the scalar only for chomping purposes.
    let last = content.length - 1;
    while (last >= 0 && content[last].trim() === '') last--;
    const body = content.slice(0, last + 1);
    const trailing = content.length - body.length;
    let out = '';
    if (style === '|') out = body.join('\n');
    else {
      let i = 0;
      while (i < body.length && body[i] === '') { out += '\n'; i++; }
      while (i < body.length) {
        out += body[i];
        let m = i + 1;
        let empties = 0;
        while (m < body.length && body[m] === '') { empties++; m++; }
        if (m >= body.length) break;
        const fold = !/^[ \t]/.test(body[i]) && !/^[ \t]/.test(body[m]);
        out += fold ? (empties ? '\n'.repeat(empties) : ' ') : '\n'.repeat(empties + 1);
        i = m;
      }
    }
    const atEof = k >= this.lines.length && !this.endsWithNewline && trailing === 0;
    const breaks = body.length ? (atEof ? 0 : 1) + trailing : trailing;
    if (chomp === '+') out += '\n'.repeat(breaks);
    else if (chomp === '' && body.length && breaks > 0) out += '\n';
    return { value: out, next: k };
  }

  /** A flow collection starting at (j, col); it may span lines. */
  parseFlow(j, col, path) {
    let text = '';
    let depth = 0;
    let quote = null;
    let i = j;
    let p = col;
    let endLine = -1;
    let endCol = -1;
    let lastSig = '';
    outer: for (; i < this.lines.length; i++, p = 0) {
      const line = this.lines[i];
      for (; p < line.length; p++) {
        const ch = line[p];
        if (quote) {
          text += ch;
          if (quote === '"' && ch === '\\') { if (p + 1 < line.length) { text += line[p + 1]; p++; } continue; }
          if (ch === quote) {
            if (quote === "'" && line[p + 1] === "'") { text += "'"; p++; continue; }
            quote = null;
            lastSig = ch;
          }
          continue;
        }
        if (ch === '#' && (p === 0 || line[p - 1] === ' ' || line[p - 1] === '\t')) break;
        // A quote only opens a quoted scalar where a scalar starts; "don't" in a plain scalar is text.
        if ((ch === '"' || ch === "'") && (lastSig === '' || '[{,:'.includes(lastSig))) quote = ch;
        if (ch === '[' || ch === '{') depth++;
        if (ch === ']' || ch === '}') depth--;
        text += ch;
        if (ch !== ' ' && ch !== '\t') lastSig = ch;
        if (depth === 0) { endLine = i; endCol = p + 1; break outer; }
      }
      text += '\n';
    }
    if (endLine < 0) this.fail('unterminated flow collection', j, 'UNTERMINATED_FLOW');
    this.expectLineEnd(endLine, endCol);
    this.construct('flow', j, path, this.lines[j][col] === '[' ? '[...]' : '{...}');
    const fp = new FlowParser(text, this, j);
    const value = fp.parseValue();
    fp.skipWs();
    if (fp.p < text.length) this.fail('unexpected text after a flow collection', j, 'UNEXPECTED');
    return { value, next: endLine + 1 };
  }
}

class FlowParser {
  constructor(s, parser, line) {
    this.s = s;
    this.p = 0;
    this.parser = parser;
    this.line = line;
  }

  /** The 0-based source line of the current position. */
  at() { return this.line + (this.lineAt ??= lineLocator(this.s))(this.p) - 1; }
  fail(msg) { this.parser.fail(msg, this.at(), 'BAD_FLOW'); }
  skipWs() { while (this.p < this.s.length && /[ \t\n\r]/.test(this.s[this.p])) this.p++; }

  parseValue() {
    this.skipWs();
    let anchor = null;
    let tag = null;
    for (;;) {
      const m = /^([&!])([^\s,\[\]{}]*)/.exec(this.s.slice(this.p));
      if (!m) break;
      if (m[1] === '&') anchor = m[2];
      else tag = '!' + m[2];
      this.p += m[0].length;
      this.skipWs();
    }
    const ch = this.s[this.p];
    let value;
    let raw;
    if (ch === '[') value = this.parseSeq();
    else if (ch === '{') value = this.parseMap();
    else if (ch === '"' || ch === "'") { value = this.parseQuoted(); raw = value; }
    else if (ch === '*') {
      const name = /^\*([^\s,\[\]{}]+)/.exec(this.s.slice(this.p))?.[1] || '';
      value = this.parser.alias(name, this.at());
      this.p += 1 + name.length;
    } else {
      raw = this.readPlain();
      value = resolvePlain(raw);
    }
    if (tag) value = applyTag(tag, raw === undefined ? value : raw, value, this.parser, this.at());
    if (anchor) this.parser.anchor(anchor, value);
    return value;
  }

  readPlain() {
    const start = this.p;
    while (this.p < this.s.length) {
      const ch = this.s[this.p];
      if (ch === ',' || ch === '[' || ch === ']' || ch === '{' || ch === '}') break;
      if (ch === ':' && /^[\s,\[\]{}]|^$/.test(this.s.slice(this.p + 1, this.p + 2))) break;
      if (ch === '#' && /\s/.test(this.s[this.p - 1] || '')) break;
      this.p++;
    }
    // Multi-line plain scalars fold like block ones: one break is a space, empty lines are newlines.
    const parts = this.s.slice(start, this.p).split('\n').map((l) => l.trim());
    while (parts.length && parts[parts.length - 1] === '') parts.pop();
    while (parts.length && parts[0] === '') parts.shift();
    let out = '';
    let empties = 0;
    for (const part of parts) {
      if (part === '') { empties++; continue; }
      out += out ? (empties ? '\n'.repeat(empties) : ' ') + part : part;
      empties = 0;
    }
    return out;
  }

  parseQuoted() {
    const q = this.s[this.p++];
    let out = '';
    let kept = 0;
    while (this.p < this.s.length) {
      const ch = this.s[this.p];
      if (ch === '\n') {
        out = out.slice(0, kept) + out.slice(kept).replace(/[ \t]+$/, '');
        this.p++;
        let empties = 0;
        for (;;) {
          while (this.s[this.p] === ' ' || this.s[this.p] === '\t') this.p++;
          if (this.s[this.p] !== '\n') break;
          empties++;
          this.p++;
        }
        out += empties ? '\n'.repeat(empties) : ' ';
        kept = out.length;
        continue;
      }
      if (q === "'") {
        if (ch === "'") {
          if (this.s[this.p + 1] === "'") { out += "'"; this.p += 2; continue; }
          this.p++;
          return out;
        }
      } else if (ch === '\\') {
        if (this.s[this.p + 1] === '\n') {
          // Escaped line break: join the lines without a space.
          this.p += 2;
          while (this.s[this.p] === ' ' || this.s[this.p] === '\t') this.p++;
          kept = out.length;
          continue;
        }
        const r = this.parser.decodeEscape(this.s, this.p, this.at());
        out += r.text;
        kept = out.length;
        this.p = r.end;
        continue;
      } else if (ch === '"') {
        this.p++;
        return out;
      }
      out += ch;
      this.p++;
    }
    this.fail('unterminated quoted string');
    return out;
  }

  parseSeq() {
    this.p++;
    const arr = [];
    for (;;) {
      this.skipWs();
      if (this.s[this.p] === ']') { this.p++; return arr; }
      if (this.p >= this.s.length) this.fail('unterminated flow sequence');
      let item = this.parseValue();
      this.skipWs();
      if (this.s[this.p] === ':' ) {
        // A single-pair mapping inside a flow sequence: [a: 1].
        this.p++;
        const v = this.peekEnd() ? null : this.parseValue();
        const o = {};
        setKey(o, String(item), v);
        item = o;
        this.skipWs();
      }
      arr.push(item);
      if (this.s[this.p] === ',') { this.p++; continue; }
      if (this.s[this.p] === ']') continue;
      this.fail('expected "," or "]" in a flow sequence');
    }
  }

  peekEnd() {
    this.skipWs();
    const ch = this.s[this.p];
    return ch === ',' || ch === '}' || ch === ']' || ch === undefined;
  }

  parseMap() {
    this.p++;
    const obj = {};
    for (;;) {
      this.skipWs();
      if (this.s[this.p] === '}') { this.p++; return obj; }
      if (this.p >= this.s.length) this.fail('unterminated flow mapping');
      let key;
      const ch = this.s[this.p];
      if (ch === '"' || ch === "'") key = this.parseQuoted();
      else if (ch === '[' || ch === '{') this.fail('complex keys are not supported in flow mappings');
      else key = this.readPlain();
      this.skipWs();
      let value = null;
      if (this.s[this.p] === ':') {
        this.p++;
        value = this.peekEnd() ? null : this.parseValue();
      }
      if (Object.hasOwn(obj, key)) this.parser.error(`duplicate key "${key}"`, this.at(), 'DUPLICATE_KEY');
      setKey(obj, String(key), value);
      this.skipWs();
      if (this.s[this.p] === ',') { this.p++; continue; }
      if (this.s[this.p] === '}') continue;
      this.fail('expected "," or "}" in a flow mapping');
    }
  }
}

// ---------------------------------------------------------------------------
// Public parsing API

/**
 * Parse YAML text and report every problem instead of throwing.
 * Returns { value, errors[{line, code, message}], warnings[...], keyLines{path: line},
 * constructs[{kind: 'flow'|'anchor'|'alias'|'tag', line, path, text}] }.
 */
export function parseYamlDocument(text, { lineOffset = 0 } = {}) {
  const p = new Parser(stripBom(String(text ?? '')), { lineOffset });
  let value = null;
  try {
    value = p.parseDocument();
  } catch (err) {
    // A stack overflow is nesting deeper than the parser's recursion: a document error, never a crash.
    const e = err instanceof RangeError
      ? new YamlError('the document nests too deeply', lineOffset + 1, 'TOO_DEEP') : err;
    if (!(e instanceof YamlError)) throw err;
    p.errors.push({ line: e.line, code: e.code, message: e.reason });
    value = null;
  }
  return { value, errors: p.errors, warnings: p.warnings, keyLines: p.keyLines, constructs: p.constructs };
}

/** Parse YAML text (maps, lists, block/flow, quoted and folded scalars). Throws YamlError. */
export function parseYaml(text) {
  const doc = parseYamlDocument(text);
  if (doc.errors.length) {
    const e = doc.errors[0];
    throw new YamlError(e.message, e.line, e.code);
  }
  return doc.value;
}

const DOC_MARKER = /^(?:---|\.\.\.)[ \t]*(?:#.*)?$/;

/**
 * Every document of a YAML stream (CI files, `---`-separated configs): one value per document,
 * null for a document that does not parse. Never throws.
 */
export function parseYamlAll(text) {
  const lines = stripBom(String(text ?? '')).split(/\r?\n/);
  const docs = [];
  let start = 0;
  const flush = (end) => {
    const chunk = lines.slice(start, end);
    if (!chunk.some((l) => !isBlank(l) && !DOC_MARKER.test(l) && !/^%/.test(l))) return;
    const doc = parseYamlDocument(chunk.join('\n') + '\n', { lineOffset: start });
    docs.push(doc.errors.length ? null : doc.value);
  };
  for (let i = 0; i < lines.length; i++) {
    // A `---` line opens the next document (and stays in it: `--- value` is valid); `...` ends one.
    if (/^---(?:[ \t]|$)/.test(lines[i])) { flush(i); start = i; }
    else if (/^\.\.\.[ \t]*$/.test(lines[i])) { flush(i); start = i + 1; }
  }
  flush(lines.length);
  return docs;
}

const FM_OPEN = /^---[ \t]*$/;
const FM_CLOSE = /^(?:---|\.\.\.)[ \t]*$/;

/**
 * Split a Markdown file into YAML frontmatter and body. Line endings in `body` are normalized
 * to LF. Returns { data, body, bodyStartLine, errors[], warnings[], hasFrontmatter, keyLines,
 * constructs[], raw, bom, crlf, openLine, closeLine, lateOpenLine }.
 */
export function parseFrontmatter(text) {
  const src = String(text ?? '');
  const bom = src.charCodeAt(0) === 0xfeff;
  const t = bom ? src.slice(1) : src;
  const lines = t.split(/\r?\n/);
  const out = {
    data: {}, body: lines.join('\n'), bodyStartLine: 1, errors: [], warnings: [], hasFrontmatter: false,
    keyLines: {}, constructs: [], raw: null, bom, crlf: /\r\n/.test(t), openLine: null, closeLine: null,
      lateOpenLine: null,
  };
  if (!FM_OPEN.test(lines[0])) {
    const first = lines.findIndex((l) => l.trim() !== '');
    if (first > 0 && FM_OPEN.test(lines[first])) out.lateOpenLine = first + 1;
    return out;
  }
  out.hasFrontmatter = true;
  out.openLine = 1;
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (FM_CLOSE.test(lines[i])) { close = i; break; }
  }
  if (close < 0) {
    out.errors.push({ line: 1, code: 'FM_UNCLOSED',
      message: 'frontmatter opened on line 1 has no closing "---" line' });
    out.body = '';
    return out;
  }
  out.closeLine = close + 1;
  out.raw = lines.slice(1, close).join('\n');
  const doc = parseYamlDocument(out.raw + '\n', { lineOffset: 1 });
  out.errors.push(...doc.errors);
  out.warnings.push(...doc.warnings);
  out.keyLines = doc.keyLines;
  out.constructs = doc.constructs;
  if (doc.value === null || doc.value === undefined) out.data = {};
  else if (!isObj(doc.value)) {
    out.errors.push({ line: 2, code: 'FM_NOT_MAPPING',
      message: 'frontmatter must be a YAML mapping of "key: value" lines' });
  } else out.data = doc.value;
  out.body = lines.slice(close + 1).join('\n');
  out.bodyStartLine = close + 2;
  return out;
}

// ---------------------------------------------------------------------------
// Installed copies: `gh skill install` rewrites SKILL.md frontmatter (keys sorted, scalars
// re-quoted) and adds provenance inside `metadata` (`github-*` for remote installs,
// `local-path` for --from-local); `gh skill publish` strips `metadata.github-*` again.

/** Matches a `metadata` key that `gh skill install` adds (install provenance, not authored data). */
export const INSTALL_METADATA_KEY = /^(?:github-[a-z0-9-]+|local-path)$/;

const sortDeep = (v) => {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v === null || typeof v !== 'object') return v;
  const o = {};
  for (const k of Object.keys(v).sort()) setKey(o, k, sortDeep(v[k]));
  return o;
};

/**
 * Frontmatter data for a semantic comparison of an installed copy with its source: install
 * provenance removed (an emptied `metadata` is dropped) and keys sorted at every level.
 */
export function normalizeSkillFrontmatter(data) {
  if (!isObj(data)) return data;
  const copy = { ...data };
  if (isObj(copy.metadata)) {
    const meta = Object.fromEntries(Object.entries(copy.metadata).filter(([k]) => !INSTALL_METADATA_KEY.test(k)));
    if (Object.keys(meta).length) copy.metadata = meta;
    else delete copy.metadata;
  }
  return sortDeep(copy);
}

// ---------------------------------------------------------------------------
// Stringify

const PLAIN_KEY = /^[A-Za-z0-9_][A-Za-z0-9_.\/-]*$/;
const YAML11_BOOL = /^(?:y|Y|yes|Yes|YES|n|N|no|No|NO|on|On|ON|off|Off|OFF)$/;
const PRINTABLE = /^[^\x00-\x08\x0b\x0c\x0e-\x1f\x7f\x85\u2028\u2029\ufeff]*$/;

/** True when `s` can be written as an unquoted plain scalar and read back unchanged. */
function plainSafe(s) {
  if (s === '' || s !== s.trim() || !PRINTABLE.test(s) || /[\n\r\t]/.test(s)) return false;
  if (/^[-?:,\[\]{}#&*!|>'"%@`]/.test(s)) return false;
  if (/:(?:\s|$)/.test(s) || /\s#/.test(s) || s.endsWith(':')) return false;
  if (resolvePlain(s) !== s) return false;
  // Values that YAML 1.1 parsers (PyYAML, older tools) would turn into booleans, numbers or dates.
  if (YAML11_BOOL.test(s)) return false;
  if (/^[-+.]?\d/.test(s) || /^\.(?:inf|nan)$/i.test(s)) return false;
  return true;
}

function quoteDouble(s) {
  return JSON.stringify(s).replace(/[\u007f-\u009f\u2028\u2029\ufeff]/g,
    (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

// Keys stay plain when YAML 1.2 reads them back as the same string: `on:` and `yes:` are written
// bare, as GitHub workflows and host docs do (only YAML 1.1 values are quoted defensively).
function stringifyKey(k) {
  return PLAIN_KEY.test(k) && (plainSafe(k) || YAML11_BOOL.test(k)) ? k : quoteDouble(k);
}

function foldable(s) {
  return !/[\n\r\t]/.test(s) && s === s.trim() && !/ {2}/.test(s) && PRINTABLE.test(s) && s.length > 0;
}

function foldLines(s, width) {
  const words = s.split(' ');
  const lines = [];
  let cur = '';
  for (const w of words) {
    if (cur && cur.length + 1 + w.length > width) { lines.push(cur); cur = w; }
    else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) lines.push(cur);
  return lines;
}

function stringifyScalar(v, indent, width) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return '.nan';
    if (v === Infinity) return '.inf';
    if (v === -Infinity) return '-.inf';
    return String(v);
  }
  if (typeof v === 'bigint') return String(v);
  const s = String(v);
  const pad = ' '.repeat(indent + 2);
  if (plainSafe(s) && s.length <= width) return s;
  if (foldable(s) && s.length > 40) {
    const lines = foldLines(s, Math.max(20, width - indent - 2));
    if (lines.length > 1) return '>-\n' + lines.map((l) => pad + l).join('\n');
  }
  // A literal block keeps the text exactly when no line starts or ends with blanks (indentation and chomping).
  if (s.includes('\n') && PRINTABLE.test(s) && !/\r|^[ \t]|[ \t]\n|[ \t]$/.test(s)) {
    const trailing = /\n*$/.exec(s)[0].length;
    const chomp = trailing === 0 ? '-' : trailing === 1 ? '' : '+';
    const body = trailing ? s.slice(0, s.length - trailing) : s;
    if (body !== '' && !/\n\n*$/.test(body)) {
      const lines = (chomp === '+' ? s.slice(0, s.length - 1) : body).split('\n');
      return `|${chomp}\n` + lines.map((l) => (l === '' ? '' : pad + l)).join('\n');
    }
  }
  return quoteDouble(s);
}

const QUOTE_KEYS = ['applyTo', 'paths', 'excludeAgent'];
const flowItem = (v, o) => (typeof v === 'string' ? `'${v.replace(/'/g, "''")}'` : stringifyScalar(v, 0, o.width));

function stringifyNode(v, indent, o, quote = false) {
  const pad = ' '.repeat(indent);
  if (Array.isArray(v)) {
    if (!v.length) return null;
    return v.map((item) => {
      if (isObj(item) && Object.keys(item).some((x) => item[x] !== undefined)) {
        const inner = stringifyNode(item, indent + 2, o).replace(/^ +/, '');
        return `${pad}- ${inner}`;
      }
      if (Array.isArray(item) && item.length) return `${pad}-\n${stringifyNode(item, indent + 2, o)}`;
      return `${pad}- ${inlineValue(item, indent, o, quote)}`;
    }).join('\n');
  }
  if (isObj(v)) {
    const keys = Object.keys(v).filter((k) => v[k] !== undefined);
    if (!keys.length) return null;
    return keys.map((k) => {
      const val = v[k];
      const key = `${pad}${stringifyKey(k)}:`;
      const q = o.quoteKeys.includes(k);
      const scalars = Array.isArray(val) && val.length && val.every((x) => x === null || typeof x !== 'object');
      if (scalars && o.flowKeys.includes(k)) {
        return `${key} [${val.map((x) => flowItem(x, o)).join(', ')}]`;
      }
      if ((isObj(val) && Object.keys(val).some((x) => val[x] !== undefined)) || (Array.isArray(val) && val.length)) {
        return `${key}\n${stringifyNode(val, indent + 2, o, q)}`;
      }
      return `${key} ${inlineValue(val, indent, o, q)}`;
    }).join('\n');
  }
  return pad + stringifyScalar(v, indent, o.width);
}

function inlineValue(v, indent, o, quote = false) {
  if (Array.isArray(v)) return '[]';
  if (isObj(v)) return '{}';
  if (quote && typeof v === 'string') return quoteDouble(v);
  return stringifyScalar(v, indent, o.width);
}

/**
 * YAML text for `value` (block style, insertion order, LF line endings). `flowKeys`: keys whose
 * scalar lists are written `[a, b]` (agent `tools`; strictyaml rejects flow style in SKILL.md);
 * `quoteKeys`: keys whose strings are always double-quoted (glob fields the hosts document quoted).
 */
export function stringifyYaml(value, { width = 80, flowKeys = [], quoteKeys = QUOTE_KEYS } = {}) {
  const o = { width, flowKeys, quoteKeys };
  if (Array.isArray(value) || isObj(value)) {
    const out = stringifyNode(value, 0, o);
    return out === null ? (Array.isArray(value) ? '[]\n' : '{}\n') : out + '\n';
  }
  return stringifyScalar(value, 0, width) + '\n';
}

/**
 * `---\n<yaml>---\n` followed by `body` when given; parseFrontmatter reads it back unchanged.
 * The second argument may be the stringifyYaml options instead of a body.
 */
export function stringifyFrontmatter(data, body = null, opts = {}) {
  if (body !== null && typeof body === 'object') { opts = body; body = null; }
  const yaml = data && Object.keys(data).length ? stringifyYaml(data, opts) : '';
  return `---\n${yaml}---\n${body == null ? '' : body}`;
}

// ---------------------------------------------------------------------------
// Markdown bodies

/**
 * Lines of a Markdown text with fenced-code state: `{ n, raw, code, fenceStart?, fenceEnd?, lang? }`
 * for code lines, `{ n, raw, code: false, prose }` otherwise, where `prose` has inline code spans
 * blanked (same length, so columns stay valid).
 */
export function markdownLines(text) {
  const out = [];
  let fence = null;
  const lines = String(text ?? '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const m = /^\s*(`{3,}|~{3,})(.*)$/.exec(raw);
    if (fence) {
      if (m && m[1][0] === fence.ch && m[1].length >= fence.len && m[2].trim() === '') {
        out.push({ n: i + 1, raw, code: true, fenceEnd: true, lang: fence.lang });
        fence = null;
      } else out.push({ n: i + 1, raw, code: true, lang: fence.lang });
      continue;
    }
    if (m) {
      fence = { ch: m[1][0], len: m[1].length, lang: m[2].trim().split(/\s+/)[0] || '' };
      out.push({ n: i + 1, raw, code: true, fenceStart: true, lang: fence.lang });
      continue;
    }
    out.push({ n: i + 1, raw, code: false, prose: raw.replace(/(`+)[^`]*?\1/g, (x) => ' '.repeat(x.length)) });
  }
  return out;
}

/** Inline and reference-style link targets outside code: `[{ line, target }]` (`<...>` unwrapped). */
export function markdownLinks(text) {
  const links = [];
  for (const l of markdownLines(text)) {
    if (l.code) continue;
    const re = /!?\[(?:[^\]\\]|\\.)*\]\(\s*(<[^>]*>|[^()\s]+(?:\([^()\s]*\)[^()\s]*)*)(?:\s+["'(][^)]*)?\)/g;
    let m;
    while ((m = re.exec(l.prose))) links.push({ line: l.n, target: m[1].replace(/^<|>$/g, '') });
    const ref = /^\s{0,3}\[[^\]]+\]:\s*(\S+)/.exec(l.prose);
    if (ref) links.push({ line: l.n, target: ref[1].replace(/^<|>$/g, '') });
  }
  return links;
}

/** A link that leaves the file tree: a URL scheme (not file: or a drive letter), `#anchor` or `//host`. */
export function isExternalLink(target) {
  const t = String(target);
  const scheme = /^[a-z][a-z0-9+.-]*:/i.test(t) && !/^[a-zA-Z]:[\\/]/.test(t) && !/^file:/i.test(t);
  return scheme || t.startsWith('#') || t.startsWith('//');
}

/** The file path of a link target: anchor and query removed, percent-decoding applied. */
export function linkPath(target) {
  let t = String(target).split('#')[0].split('?')[0];
  try { t = decodeURIComponent(t); } catch {}
  return t;
}
