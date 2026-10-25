// Pattern catalogs for the diff-scoped checks (plan §9.1 steps 3-8, Appendix A) and the
// post-edit hook: skip/focus markers, suppressions, swallowed errors, CI weakening, in-source
// retries, secrets, assertion and test-case lines, plus heuristic path classification and two
// structural detectors (try blocks that swallow assertions, Rust inline test modules).
// Imports only core.mjs: hooks load this module, so no git, no filesystem, no network.

import { toPosix } from './core.mjs';

// ---------------------------------------------------------------------------
// Languages

const EXT_LANG = {
  '.js': 'js', '.jsx': 'js', '.mjs': 'js', '.cjs': 'js', '.ts': 'js', '.tsx': 'js', '.mts': 'js', '.cts': 'js',
  '.vue': 'js', '.svelte': 'js', '.astro': 'js',
  '.py': 'py', '.pyi': 'py',
  '.go': 'go',
  '.rs': 'rs',
  '.java': 'jvm', '.kt': 'jvm', '.kts': 'jvm', '.groovy': 'jvm', '.scala': 'jvm', '.sc': 'jvm',
  '.cs': 'cs', '.fs': 'cs', '.fsx': 'cs', '.vb': 'cs',
  '.rb': 'rb', '.rake': 'rb',
  '.php': 'php',
  '.swift': 'swift',
  '.c': 'c', '.h': 'c', '.cc': 'c', '.cpp': 'c', '.cxx': 'c', '.hpp': 'c', '.hh': 'c', '.m': 'c', '.mm': 'c',
  '.dart': 'dart', '.ex': 'ex', '.exs': 'ex',
  '.sh': 'sh', '.bash': 'sh', '.zsh': 'sh', '.ps1': 'ps', '.psm1': 'ps',
};
const HASH_COMMENT = new Set(['py', 'rb', 'sh', 'ps', 'ex']);
const SLASH_COMMENT = new Set(['js', 'go', 'rs', 'jvm', 'cs', 'php', 'swift', 'c', 'dart']);

const extOf = (base) => {
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i).toLowerCase() : '';
};
const baseOf = (p) => p.slice(p.lastIndexOf('/') + 1);

/** Language family of a path ('js', 'py', 'go', 'rs', 'jvm', 'cs', 'rb', 'php', 'swift', 'c', ...) or null. */
export function langOf(file) {
  if (!file) return null;
  const base = baseOf(toPosix(file));
  if (base === 'Rakefile' || base === 'Gemfile') return 'rb';
  return EXT_LANG[extOf(base)] || null;
}

export const isCodeFile = (file) => langOf(file) != null;

/**
 * Blank out comments (line and block, plus Python triple-quoted blocks) so code-only
 * catalogs do not fire on commented-out text. Returns an array with the same line count.
 */
export function maskComments(lines, lang) {
  const out = new Array(lines.length);
  let inBlock = false;
  let inTriple = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (lang === 'py' || inTriple) {
      if (inTriple) {
        const end = line.indexOf(inTriple);
        if (end === -1) { out[i] = ''; continue; }
        inTriple = null;
        out[i] = stripLineComment(line.slice(end + 3), lang);
        continue;
      }
      const t = line.trim();
      const q = t.startsWith('"""') ? '"""' : t.startsWith("'''") ? "'''" : null;
      if (q && t.indexOf(q, 3) === -1) { inTriple = q; out[i] = ''; continue; }
      out[i] = stripLineComment(line, lang);
      continue;
    }
    if (!SLASH_COMMENT.has(lang)) { out[i] = HASH_COMMENT.has(lang) ? stripLineComment(line, lang) : line; continue; }
    let s = '';
    let j = 0;
    while (j < line.length) {
      if (inBlock) {
        const end = line.indexOf('*/', j);
        if (end === -1) { j = line.length; break; }
        inBlock = false;
        j = end + 2;
        continue;
      }
      const start = findOutsideQuotes(line, '/*', j);
      const lc = findOutsideQuotes(line, '//', j);
      if (lc !== -1 && (start === -1 || lc < start)) { s += line.slice(j, lc); j = line.length; break; }
      if (start === -1) { s += line.slice(j); break; }
      s += line.slice(j, start);
      inBlock = true;
      j = start + 2;
    }
    out[i] = s;
  }
  return out;
}

function findOutsideQuotes(line, token, from) {
  let quote = null;
  for (let i = from; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (line.startsWith(token, i)) {
      // `http://` inside an unquoted token is not a comment start in practice; require a boundary.
      if (token === '//' && i > 0 && line[i - 1] === ':') continue;
      return i;
    }
  }
  return -1;
}

function stripLineComment(line, lang) {
  if (lang === 'rs' || !HASH_COMMENT.has(lang)) return line;
  const i = findOutsideQuotes(line, '#', 0);
  return i === -1 ? line : line.slice(0, i);
}

// Blank string literals so brace counting and keyword checks ignore their contents.
const STRING_LITERAL = /(["'`])(?:\\.|(?!\1).)*\1/g;
const blankLiteral = (s) => s[0] + ' '.repeat(Math.max(0, s.length - 2)) + s[0];
const blankStrings = (line) => String(line ?? '').replace(STRING_LITERAL, blankLiteral);
// Like blankStrings, but keeps a literal used as a property index (`describe['skip']`).
const blankNonIndex = (line) => String(line ?? '').replace(STRING_LITERAL, (s, _q, at, all) => (/\[\s*$/.test(all.slice(0, at)) ? s : blankLiteral(s)));
const indentOf = (line) => line.length - line.trimStart().length;

/**
 * The `{ ... }` block that opens at or after column `col` of line `i` (0-based) in
 * comment-masked lines: { start, end, body } with 0-based line numbers, or null.
 */
function braceBlock(masked, i, col = 0) {
  let depth = 0;
  let open = null;
  const body = [];
  for (let j = i; j < masked.length && j < i + 2000; j++) {
    const line = blankStrings(masked[j]);
    let k = j === i ? col : 0;
    let seg = '';
    for (; k < line.length; k++) {
      const c = line[k];
      if (c === '{') {
        depth++;
        if (open == null) { open = { line: j, col: k }; continue; }
      } else if (c === '}' && open != null) {
        depth--;
        if (depth === 0) {
          body.push(seg);
          return { start: open.line, end: j, endCol: k, body: body.join('\n') };
        }
      }
      if (open != null) seg += c;
    }
    if (open != null) body.push(seg);
  }
  return null;
}

/** The indented block under line `i` (0-based) plus any inline remainder after its `:`. */
function indentBlock(masked, i) {
  const head = masked[i] || '';
  const inline = head.slice(head.indexOf(':') + 1).trim();
  const base = indentOf(head);
  const body = inline ? [inline] : [];
  let end = i;
  for (let j = i + 1; j < masked.length; j++) {
    const l = masked[j];
    if (!l.trim()) continue;
    if (indentOf(l) <= base) break;
    body.push(l);
    end = j;
  }
  return { start: i, end, body: body.join('\n') };
}

/** Handler body of a `catch`/`except`/`rescue` line, for entries that inspect it (`bodyNot`). */
function handlerBody(masked, i, lang) {
  if (lang === 'py' || lang === 'rb') return indentBlock(masked, i);
  const at = blankStrings(masked[i]).search(/\bcatch\b/);
  return braceBlock(masked, i, at === -1 ? 0 : at);
}

// ---------------------------------------------------------------------------
// Catalogs. Entry shape: { id, re, langs?, code?, kind?, severity?, next?, bodyNot? }.
//  - langs: language families the entry applies to (absent = any file)
//  - code: match against comment-masked text (directive catalogs match raw text)
//  - next: for multi-line constructs, the next non-blank code line must match `next`
//  - blank: also blank string literals first (a marker inside a string is not a marker); the
//    unblanked line must match too, so back-references still compare real values. 'index'
//    keeps literals used as a property index (`describe['skip']`).
//  - bodyNot: the handler block opened on the line must be non-empty and must not match

/** Skip, focus, xfail and todo markers (plan Appendix A FM-01); applied to test files only. */
export const SKIP_MARKERS = [
  { id: 'skip.js-prefixed', langs: ['js'], code: true, blank: true, kind: 'skip', re: /(?<![\w$.])(?:xit|xtest|xdescribe|xcontext|xspecify|xsuite)\s*\(/ },
  { id: 'skip.js-focus-prefixed', langs: ['js'], code: true, blank: true, kind: 'focus', re: /(?<![\w$.])(?:fit|fdescribe|fcontext|fspecify)\s*\(/ },
  { id: 'skip.js-only', langs: ['js'], code: true, blank: true, kind: 'focus', re: /\b(?:it|test|describe|context|suite|specify)(?:\.(?:concurrent|sequential|serial|parallel|describe|each|step))*\.only\b/ },
  { id: 'skip.js-skip', langs: ['js'], code: true, blank: true, kind: 'skip', re: /\b(?:it|test|describe|context|suite|specify)(?:\.(?:concurrent|sequential|serial|parallel|describe|each|step))*\.(?:skip|skipIf|runIf|fixme)\b/ },
  { id: 'skip.js-todo', langs: ['js'], code: true, blank: true, kind: 'todo', re: /\b(?:it|test|describe)(?:\.(?:concurrent|describe))*\.todo\b/ },
  { id: 'skip.js-failing', langs: ['js'], code: true, blank: true, kind: 'xfail', re: /\b(?:it|test)(?:\.(?:concurrent))*\.(?:failing|fails)\b/ },
  { id: 'skip.js-bracket', langs: ['js'], code: true, blank: 'index', kind: 'skip', re: /\b(?:it|test|describe)\s*\[\s*['"](?:only|skip)['"]\s*\]/ },
  { id: 'skip.js-this-skip', langs: ['js'], code: true, blank: true, kind: 'skip', re: /\bthis\.skip\s*\(/ },
  { id: 'skip.js-pending', langs: ['js'], code: true, blank: true, kind: 'skip', re: /(?<![\w$.])pending\s*\(\s*\)/ },
  { id: 'skip.py-mark', langs: ['py'], code: true, kind: 'skip', re: /\bpytest\.mark\.(?:skip|skipif|xfail)\b/ },
  { id: 'skip.py-call', langs: ['py'], code: true, kind: 'skip', re: /\bpytest\.(?:skip|xfail|importorskip)\s*\(/ },
  { id: 'skip.py-unittest', langs: ['py'], code: true, kind: 'skip', re: /@unittest\.(?:skip|skipIf|skipUnless|expectedFailure)\b|\bself\.skipTest\s*\(|\braise\s+(?:unittest\.)?SkipTest\b/ },
  { id: 'skip.go', langs: ['go'], code: true, kind: 'skip', re: /\b[tbf]\.(?:Skip|Skipf|SkipNow)\s*\(/ },
  { id: 'skip.go-build-ignore', langs: ['go'], kind: 'skip', re: /^\s*\/\/\s*(?:go:build|\+build)\s+ignore\b/ },
  // Any other build constraint drops the file from a plain `go test ./...` unless the tag is passed.
  { id: 'skip.go-build-tag', langs: ['go'], kind: 'constraint', re: /^\s*\/\/\s*(?:go:build|\+build)\s+(?!ignore\b)\S/ },
  { id: 'skip.rs-ignore', langs: ['rs'], code: true, kind: 'skip', re: /#\[ignore(?:\s*=\s*"[^"]*")?\s*\]/ },
  { id: 'skip.jvm', langs: ['jvm'], code: true, kind: 'skip', re: /@(?:Disabled\w*|Ignore)\b|@Test\s*\([^)]*\benabled\s*=\s*false/ },
  { id: 'skip.cs', langs: ['cs'], code: true, kind: 'skip', re: /\[\s*(?:\w+\s*,\s*)*Ignore\b|\[\s*(?:Fact|Theory|SkippableFact|SkippableTheory)\s*\([^)]*\bSkip\s*=|\bAssert\.(?:Ignore|Inconclusive)\s*\(/ },
  { id: 'skip.rb', langs: ['rb'], code: true, kind: 'skip', re: /^\s*(?:xit|xdescribe|xcontext|xspecify|xexample|xscenario)\b|^\s*(?:skip|pending)\b(?!\s*[=:])|(?:,\s*|\b)(?:skip|pending):\s*(?:true|['"])|,\s*:(?:skip|pending)\b/ },
  { id: 'skip.rb-focus', langs: ['rb'], code: true, kind: 'focus', re: /^\s*(?:fit|fdescribe|fcontext|fspecify|fexample|fscenario)\b|(?:,\s*|\b)focus:\s*true|,\s*:focus\b/ },
  { id: 'skip.php', langs: ['php'], code: true, kind: 'skip', re: /\bmarkTest(?:Skipped|Incomplete)\s*\(|->skip\s*\(|@group\s+(?:skip|disabled)\b/ },
  { id: 'skip.swift', langs: ['swift'], code: true, kind: 'skip', re: /\bthrow\s+XCTSkip\b|\bXCTSkip(?:If|Unless)\s*\(|@Test\s*\([^)]*\.disabled\b/ },
  { id: 'skip.dart', langs: ['dart'], code: true, kind: 'skip', re: /\bskip\s*:\s*(?:true|['"])/ },
];

/** Test-case declarations; `name` is the capture group holding the case name, `lookahead` finds it on the next lines. */
export const TEST_CASE_LINE = [
  { id: 'case.js', langs: ['js'], code: true, re: /^\s*(?:it|test|specify|xit|xtest|fit|xspecify)(?:\.\w+(?:\((?:[^()]|\([^()]*\))*\)|`[^`]*`)?)*\s*\(\s*(?:(['"`])((?:\\.|(?!\1).)*)\1)?/, name: 2 },
  { id: 'case.py', langs: ['py'], code: true, re: /^\s*(?:async\s+)?def\s+(test\w*)\s*\(/, name: 1 },
  { id: 'case.go', langs: ['go'], code: true, re: /^func\s+((?:Test|Fuzz|Example)\w*)\s*\(/, name: 1 },
  { id: 'case.go-subtest', langs: ['go'], code: true, re: /\bt\.Run\s*\(\s*"((?:\\.|[^"\\])*)"/, name: 1 },
  { id: 'case.rs', langs: ['rs'], code: true, re: /^\s*#\[(?:[\w]+::)?(?:test|rstest|test_case|quickcheck|proptest)\b[^\]]*\]/, lookahead: /\bfn\s+(\w+)/ },
  { id: 'case.jvm', langs: ['jvm'], code: true, re: /@(?:Test|ParameterizedTest|RepeatedTest|TestFactory|TestTemplate|Property|RetryingTest|RepeatedIfExceptionsTest|CartesianTest)\b/, lookahead: /\b(?:void|fun|def)\s+`?([^`(\s]+(?: [^`(]+)*)`?\s*\(/ },
  { id: 'case.cs', langs: ['cs'], code: true, re: /\[\s*(?:\w+\s*,\s*)*(?:Fact|Theory|Test|TestMethod|TestCase|DataTestMethod|SkippableFact|SkippableTheory|RetryFact|RetryTheory)\b/, lookahead: /\b(?:void|Task|ValueTask)\s+(\w+)\s*\(/ },
  { id: 'case.rb', langs: ['rb'], code: true, re: /^\s*(?:[xf]?(?:it|specify|example|scenario)|test)\b\s*\(?\s*(?:(['"])((?:\\.|(?!\1).)*)\1)?/, name: 2 },
  { id: 'case.rb-minitest', langs: ['rb'], code: true, re: /^\s*def\s+(test_\w+)/, name: 1 },
  { id: 'case.php', langs: ['php'], code: true, re: /\bfunction\s+(test\w+)\s*\(/, name: 1 },
  { id: 'case.php-pest', langs: ['php'], code: true, re: /^\s*(?:it|test)\s*\(\s*(['"])((?:\\.|(?!\1).)*)\1/, name: 2 },
  { id: 'case.swift', langs: ['swift'], code: true, re: /\bfunc\s+(test\w+)\s*\(/, name: 1 },
  { id: 'case.swift-testing', langs: ['swift'], code: true, re: /^\s*@Test\b/, lookahead: /\bfunc\s+(\w+)/ },
  { id: 'case.dart', langs: ['dart'], code: true, re: /^\s*(?:test|testWidgets)\s*\(\s*(['"])((?:\\.|(?!\1).)*)\1/, name: 2 },
];

/** Lines that assert something (counted once per line). */
export const ASSERTION_LINE = [
  { id: 'assert.js', langs: ['js'], code: true, re: /\bexpect(?:TypeOf)?\s*\(|\bassert(?:\.\w+)?\s*\(|\.should\b|\bt\.(?:is|not|deepEqual|notDeepEqual|true|false|truthy|falsy|throws|throwsAsync|notThrows|regex|snapshot|assert|like|equal|same|ok|match)\s*\(/ },
  { id: 'assert.py', langs: ['py'], code: true, re: /^\s*assert\b|\bself\.assert\w+\s*\(|\bpytest\.(?:raises|warns|approx)\s*\(|\.assert_\w+\s*\(|\bnp\.testing\.assert_\w+\(/ },
  { id: 'assert.go', langs: ['go'], code: true, re: /\b[tbf]\.(?:Error|Errorf|Fatal|Fatalf|Fail|FailNow)\s*\(|\b(?:assert|require)\.\w+\s*\(|\bExpect\s*\(|\bgomega\.\w+\(/ },
  { id: 'assert.rs', langs: ['rs'], code: true, re: /\b(?:assert|assert_eq|assert_ne|debug_assert|debug_assert_eq|debug_assert_ne|assert_matches|prop_assert|prop_assert_eq|prop_assert_ne)!\s*\(|#\[should_panic\b/ },
  { id: 'assert.jvm', langs: ['jvm'], code: true, re: /\bassert\w*\s*\(|\bAssertions\.\w+\s*\(|\bverify\s*\(|\bshould(?:Be|Equal|Throw)\w*\b|\bexpect\s*\(/ },
  { id: 'assert.cs', langs: ['cs'], code: true, re: /\b(?:Assert|CollectionAssert|StringAssert|ClassicAssert)\.\w+\s*\(|\.Should\s*\(\s*\)|\.Verify\s*\(/ },
  { id: 'assert.rb', langs: ['rb'], code: true, re: /\bexpect\s*[({]|\.(?:should|must_\w+|wont_\w+)\b|\bassert(?:_\w+)?\b|\brefute(?:_\w+)?\b|\bis_expected\b/ },
  { id: 'assert.php', langs: ['php'], code: true, re: /\$this->assert\w+\s*\(|\bself::assert\w+\s*\(|\bstatic::assert\w+\s*\(|\bexpect\s*\(/ },
  { id: 'assert.swift', langs: ['swift'], code: true, re: /\bXCTAssert\w*\s*\(|\bXCTFail\s*\(|#(?:expect|require)\s*\(/ },
  { id: 'assert.dart', langs: ['dart'], code: true, re: /\bexpect(?:Later)?\s*\(/ },
];

/** Assertions that only check truthiness or existence (a "downgrade" when they replace stronger ones). */
export const WEAK_ASSERTIONS = [
  { id: 'weak.js', langs: ['js'], code: true, re: /\.(?:toBeTruthy|toBeDefined|toBeFalsy)\s*\(\s*\)|\.not\.(?:toBeNull|toBeUndefined|toThrow)\s*\(\s*\)|\bexpect\.anything\s*\(|\.toHaveBeenCalled\s*\(\s*\)|\bassert(?:\.ok)?\s*\(\s*[\w$.]+\s*\)\s*;?\s*$/ },
  { id: 'weak.py', langs: ['py'], code: true, re: /^\s*assert\s+(?:not\s+)?[\w.]+(?:\(\))?\s*$|^\s*assert\s+[\w.]+\s+is\s+not\s+None\s*$|\bself\.assert(?:True|IsNotNone|False|IsNone)\s*\(\s*[\w.]+\s*\)/ },
  { id: 'weak.jvm', langs: ['jvm'], code: true, re: /\bassert(?:NotNull|True|False)\s*\(\s*[\w.]+\s*\)/ },
  { id: 'weak.cs', langs: ['cs'], code: true, re: /\bAssert\.(?:IsNotNull|NotNull|IsTrue|True|IsFalse|False)\s*\(\s*[\w.]+\s*\)/ },
  { id: 'weak.rs', langs: ['rs'], code: true, re: /\bassert!\s*\(\s*[\w.]+(?:\.is_(?:ok|some|err|none)\(\))?\s*\)/ },
  { id: 'weak.rb', langs: ['rb'], code: true, re: /\bbe_truthy\b|\bbe_present\b|\bnot_to\s+be_nil\b|\bassert\s+[\w.]+\s*$/ },
  { id: 'weak.go', langs: ['go'], code: true, re: /\b(?:assert|require)\.(?:NotNil|True|NoError)\s*\(\s*t\s*,\s*[\w.]+\s*\)/ },
];

/** Assertions that can never fail. */
export const TAUTOLOGIES = [
  { id: 'tautology.js', langs: ['js'], code: true, blank: true, re: /\bexpect\s*\(\s*(true|false|null|\d+|'[^']*'|"[^"]*")\s*\)\s*\.(?:toBe|toEqual|toStrictEqual)\s*\(\s*\1\s*\)|\bexpect\s*\(\s*true\s*\)\s*\.toBeTruthy\s*\(\s*\)|\bassert(?:\.ok)?\s*\(\s*true\s*\)/ },
  { id: 'tautology.py', langs: ['py'], code: true, re: /^\s*assert\s+(?:True|1|(\d+)\s*==\s*\1)\s*$|\bself\.assertTrue\s*\(\s*True\s*\)|\bself\.assertEqual\s*\(\s*(\d+|True)\s*,\s*\2\s*\)/ },
  { id: 'tautology.rs', langs: ['rs'], code: true, re: /\bassert!\s*\(\s*true\s*\)|\bassert_eq!\s*\(\s*(\d+|true)\s*,\s*\1\s*\)/ },
  { id: 'tautology.jvm', langs: ['jvm', 'cs'], code: true, re: /\bassert(?:True|That)\s*\(\s*true\s*\)|\bAssert\.(?:IsTrue|True)\s*\(\s*true\s*\)|\bassertEquals\s*\(\s*(\d+)\s*,\s*\1\s*\)/ },
  { id: 'tautology.go', langs: ['go'], code: true, re: /\bif\s+false\s*\{\s*t\.(?:Error|Fatal)/ },
];

/** Error handling that hides assertion failures inside tests (reported under CK-ASSERT). */
export const ASSERTION_SWALLOW = [
  { id: 'assert-swallow.py', langs: ['py'], code: true, re: /\bexcept\s+(?:\(?[\w., ]*\bAssertionError\b[\w., ]*\)?)(?:\s+as\s+\w+)?\s*:/ },
  { id: 'assert-swallow.js', langs: ['js', 'jvm', 'cs'], code: true, re: /\bcatch\s*\(\s*(?:\w+\s*:\s*)?(?:AssertionError|AssertionFailedError|JestAssertionError|AssertFailedException)\b/ },
  { id: 'assert-swallow.rb', langs: ['rb'], code: true, re: /\brescue\s+(?:RSpec::Expectations::ExpectationNotMetError|Minitest::Assertion)\b/ },
];

/** Lint and type suppression directives (FM-05); matched on raw text because they live in comments. */
export const SUPPRESSIONS = [
  { id: 'suppress.eslint-file', langs: ['js'], scope: 'file', re: /\/\*\s*eslint-disable(?![-\w])/ },
  { id: 'suppress.eslint', langs: ['js'], re: /\beslint-disable-(?:next-)?line\b/ },
  { id: 'suppress.eslint-rule-comment', langs: ['js'], scope: 'file', re: /\/\*\s*eslint\s+[@\w/-]+\s*:\s*(?:0|["']?off["']?)\b/ },
  { id: 'suppress.ts-nocheck', langs: ['js'], scope: 'file', re: /@ts-nocheck\b/ },
  { id: 'suppress.ts-ignore', langs: ['js'], re: /@ts-(?:ignore|expect-error)\b/ },
  { id: 'suppress.biome', langs: ['js'], re: /\bbiome-ignore(?:-all|-start)?\b/ },
  { id: 'suppress.oxlint', langs: ['js'], re: /\boxlint-disable(?:-next-line|-line)?\b/ },
  { id: 'suppress.deno', langs: ['js'], re: /\bdeno-lint-ignore(?:-file)?\b/ },
  { id: 'suppress.js-coverage', langs: ['js'], re: /\/\*\s*(?:istanbul|c8|v8|node:coverage)\s+(?:ignore|disable)\b/ },
  { id: 'suppress.py-type-ignore', langs: ['py'], re: /#\s*type:\s*ignore\b/ },
  { id: 'suppress.py-pyright', langs: ['py'], re: /#\s*pyright:\s*(?:ignore\b|basic\b|strict\s*=\s*false)/ },
  { id: 'suppress.py-file-noqa', langs: ['py'], scope: 'file', re: /#\s*(?:ruff|flake8)\s*:\s*noqa\b/i },
  { id: 'suppress.py-noqa', langs: ['py'], re: /#\s*noqa\b/i },
  { id: 'suppress.py-mypy-file', langs: ['py'], scope: 'file', re: /#\s*mypy\s*:\s*(?:ignore-errors|disable-error-code)\b/ },
  { id: 'suppress.py-pylint', langs: ['py'], re: /#\s*pylint\s*:\s*disable(?:-next)?\s*=/ },
  { id: 'suppress.py-nosec', langs: ['py'], re: /#\s*nosec\b/ },
  { id: 'suppress.py-coverage', langs: ['py'], re: /#\s*pragma:\s*no\s*(?:cover|branch)\b/ },
  { id: 'suppress.go', langs: ['go'], re: /\/\/\s*nolint\b|\/\/\s*lint:(?:ignore|file-ignore)\b|\/\/\s*#?nosec\b/ },
  { id: 'suppress.rs-crate', langs: ['rs'], scope: 'file', re: /#!\[allow\s*\(/ },
  { id: 'suppress.rs', langs: ['rs'], re: /#\[allow\s*\(/ },
  { id: 'suppress.cs', langs: ['cs'], re: /#pragma\s+warning\s+disable\b|\[(?:assembly:\s*)?SuppressMessage\s*\(|\/\/\s*ReSharper\s+disable\b/ },
  { id: 'suppress.jvm', langs: ['jvm'], re: /@Suppress(?:Warnings|FBWarnings|Lint)?\s*\(|\/\/\s*CHECKSTYLE:OFF\b|\/\/\s*NOPMD\b/ },
  { id: 'suppress.rb', langs: ['rb'], re: /#\s*rubocop\s*:\s*(?:disable|todo)\b|#\s*standard\s*:\s*disable\b|#\s*:nocov:/ },
  { id: 'suppress.php', langs: ['php'], re: /@phpstan-ignore(?:-line|-next-line)?\b|@psalm-suppress\b|@codingStandardsIgnore\w*|\bphpcs:(?:ignore|disable)\b/ },
  { id: 'suppress.swift', langs: ['swift'], re: /\/\/\s*swiftlint:disable\b/ },
  { id: 'suppress.c', langs: ['c'], re: /\/\/\s*NOLINT(?:NEXTLINE|BEGIN)?\b|#pragma\s+(?:GCC|clang)\s+diagnostic\s+ignored\b/ },
  { id: 'suppress.sh', langs: ['sh'], re: /#\s*shellcheck\s+disable=/ },
  { id: 'suppress.sonar', re: /\bNOSONAR\b/ },
  // Inline allow directives hide a line from the secret scanners that honor them (gitleaks,
  // trufflehog, detect-secrets); diff-scope still scans such lines with the built-in patterns.
  { id: 'suppress.secret-allow', re: /\bgitleaks:allow\b|\btrufflehog:ignore\b|\bpragma:\s*allowlist\s+secret\b/ },
];

/** Inline directives that make a secret scanner skip a line (see suppress.secret-allow). */
export const SECRET_ALLOW = /\bgitleaks:allow\b|\btrufflehog:ignore\b|\bpragma:\s*allowlist\s+secret\b/;

/**
 * Lint/type configuration that turns a rule or check off (applied to lint-config files and
 * the lint sections of pyproject.toml, setup.cfg, package.json, Cargo.toml, MSBuild props).
 */
export const LINT_CONFIG_WEAKENING = [
  { id: 'lintcfg.rule-off', re: /^\s*["']?(?![\w@/-]*(?:max|min|warnings|width|version|depth|size|limit|timeout|ecma|indent|tab|level|line)[\w-]*["']?\s*[:=])(?:@?[\w-]+\/)*[\w-]+["']?\s*[:=]\s*(?:["']off["']|0(?![\d.])|\[\s*(?:["']off["']|0(?![\d.])))/ },
  { id: 'lintcfg.rule-allow', re: /^\s*["']?[\w:-]+["']?\s*=\s*(?:["']allow["']|\{\s*level\s*=\s*["']allow["'])/ },
  { id: 'lintcfg.ts-strict-off', re: /["'](?:strict\w*|noImplicit\w+|noUnused\w+|noFallthroughCasesInSwitch|exactOptionalPropertyTypes|checkJs|alwaysStrict|useUnknownInCatchVariables)["']\s*:\s*false\b/ },
  { id: 'lintcfg.mypy-off', re: /^\s*(?:ignore_errors|ignore_missing_imports|allow_untyped_defs|allow_untyped_calls|allow_any_generics)\s*=\s*(?:true|True)\b|^\s*(?:strict|check_untyped_defs|disallow_untyped_defs|warn_unused_ignores|warn_return_any|strict_optional)\s*=\s*(?:false|False)\b|^\s*disable_error_code\s*=/ },
  { id: 'lintcfg.ignore-list', re: /^\s*["']?(?:ignore|ignores|ignorePatterns|extend-ignore|extend_ignore|disable|disabled|per-file-ignores|per_file_ignores|extend-per-file-ignores|unfixable|exclude_rules|skip|globalIgnores|exclude|extend-exclude|extend_exclude|skip-dirs|skip-files|exclude-dirs|exclude-files)["']?\s*[:=]/ },
  { id: 'lintcfg.disable-all', re: /^\s*["']?(?:disable-all|disable_all)["']?\s*[:=]\s*true\b|^\s*["']?(?:recommended|all|enable-all)["']?\s*[:=]\s*false\b/ },
  { id: 'lintcfg.severity-none', re: /\bdotnet_diagnostic\.\w+\.severity\s*=\s*(?:none|silent|suggestion)\b|^\s*dotnet_analyzer_diagnostic\.[\w.]*severity\s*=\s*(?:none|silent)\b/ },
  { id: 'lintcfg.msbuild-off', re: /<NoWarn>|<TreatWarningsAsErrors>\s*false\s*</i },
  { id: 'lintcfg.msbuild-analyzers-off', re: /<(?:RunAnalyzers|RunAnalyzersDuringBuild|EnableNETAnalyzers|EnforceCodeStyleInBuild)>\s*false\s*</i },
  { id: 'lintcfg.msbuild-nullable-off', re: /<Nullable>\s*disable\s*</i },
  { id: 'lintcfg.rubocop-off', re: /^\s*Enabled\s*:\s*false\b/ },
];

/**
 * Lint/type settings that turn a check on: removing one (without adding it back anywhere in the
 * change) falls back to the tool's laxer default, the same as turning the check off.
 */
export const STRICTNESS_ON = [
  { id: 'strict.ts', re: /["'](?:strict\w*|noImplicit\w+|noUnused\w+|noFallthroughCasesInSwitch|exactOptionalPropertyTypes|checkJs|alwaysStrict|useUnknownInCatchVariables|noUncheckedIndexedAccess|noPropertyAccessFromIndexSignature)["']\s*:\s*true\b/ },
  { id: 'strict.mypy', re: /^\s*(?:strict|check_untyped_defs|disallow_\w+|warn_unused_ignores|warn_return_any|warn_redundant_casts|strict_optional|no_implicit_optional|strict_equality)\s*=\s*(?:true|True)\b/ },
  { id: 'strict.pyright', re: /["']?typeCheckingMode["']?\s*[:=]\s*["']strict["']/ },
  { id: 'strict.msbuild', re: /<(?:TreatWarningsAsErrors|EnforceCodeStyleInBuild|RunAnalyzers|RunAnalyzersDuringBuild|EnableNETAnalyzers)>\s*true\s*<|<Nullable>\s*enable\s*<|<WarningsAsErrors>[^<]+</i },
  { id: 'strict.all', re: /^\s*["']?(?:enable-all|enable_all)["']?\s*[:=]\s*true\b/ },
];

/** Keys whose list items enable rules or linters (an item removed from them turns a check off). */
export const LINT_ENABLE_KEYS = /^(?:select|extend-select|extend_select|enable|enabled|presets|extends)$/i;

/** Keys whose list items are exclusions (an added item under them turns a check off or narrows it). */
export const LINT_EXCLUSION_KEYS = /^(?:ignore|ignores|ignorePatterns|extend-ignore|extend_ignore|exclude|extend-exclude|extend_exclude|per-file-ignores|per_file_ignores|disable|disabled|skip-dirs|skip-files|skip_dirs|skip_files|exclude-dirs|exclude-files|exclude_dirs|exclude_files|exclude_rules|unfixable|globalIgnores)$/i;

// A handler body that re-raises, fails, exits or reports at error level is not a swallow.
const HANDLED = /\b(?:raise|throw|rethrow|panic|abort|exit|fail|Fail)\b|\b(?:log|logger|logging|LOG|_log|_logger|Log|Logger|console|self\.log|self\.logger|this\.log|this\.logger)\s*\.\s*(?:error|exception|critical|fatal|severe|LogError|LogCritical|Error|Fatal)\b|\bprintStackTrace\b|\breport\w*\(|\bcapture_?[Ee]xception\b/;

/** Error handling that swallows failures (FM-07); non-test files (in tests they are CK-ASSERT). */
export const SWALLOW_PATTERNS = [
  { id: 'swallow.empty-catch', langs: ['js', 'jvm', 'cs', 'php', 'swift', 'c', 'dart'], code: true, re: /\bcatch\s*(?:\([^)]*\))?\s*\{\s*\}/ },
  { id: 'swallow.empty-catch', langs: ['js', 'jvm', 'cs', 'php', 'swift', 'c', 'dart'], code: true, re: /\bcatch\s*(?:\([^)]*\))?\s*\{\s*$/, next: /^\s*\}/ },
  { id: 'swallow.promise-catch', langs: ['js'], code: true, re: /\.catch\s*\(\s*(?:(?:async\s*)?(?:\(\s*[\w$]*\s*\)|[\w$]+)\s*=>\s*(?:\{\s*\}|null|undefined|void\s+0|false|\[\s*\]|\{\s*\}\s*\))|noop|_\.noop|lodash\.noop)\s*\)/ },
  { id: 'swallow.py-except-pass', langs: ['py'], code: true, re: /^\s*except\b[^:]*:\s*(?:pass|\.\.\.|continue)\s*$/ },
  { id: 'swallow.py-except-pass', langs: ['py'], code: true, re: /^\s*except\b[^:]*:\s*$/, next: /^\s*(?:pass|\.\.\.|continue)\s*$/ },
  { id: 'swallow.py-bare-except', langs: ['py'], code: true, re: /^\s*except\s*:/ },
  { id: 'swallow.py-suppress', langs: ['py'], code: true, re: /\b(?:contextlib\.)?suppress\s*\(\s*(?:Exception|BaseException)\s*\)/ },
  { id: 'swallow.go-blank-error', langs: ['go'], code: true, re: /^\s*_\s*(?:,\s*_\s*)?=\s*[\w.]+\s*\(/ },
  { id: 'swallow.go-empty-err', langs: ['go'], code: true, re: /\bif\b[^{]*\berr\s*!=\s*nil\s*\{\s*\}/ },
  { id: 'swallow.go-empty-err', langs: ['go'], code: true, re: /\bif\b[^{]*\berr\s*!=\s*nil\s*\{\s*$/, next: /^\s*\}/ },
  { id: 'swallow.go-err-return-nil', langs: ['go'], code: true, re: /\bif\b[^{]*\berr\s*!=\s*nil\s*\{\s*return\s+nil\s*\}/ },
  { id: 'swallow.rs', langs: ['rs'], code: true, re: /\bErr\s*\(\s*_\w*\s*\)\s*=>\s*(?:\{\s*\}|\(\s*\))|\.ok\s*\(\s*\)\s*;\s*$/ },
  { id: 'swallow.rb', langs: ['rb'], code: true, re: /\brescue\s+nil\b|\brescue\s*(?:Exception|StandardError)?\s*(?:=>\s*\w+)?\s*;\s*(?:nil\s*;\s*)?end\b/ },
  { id: 'swallow.rb', langs: ['rb'], code: true, re: /^\s*rescue\b[^;]*$/, next: /^\s*end\b/ },
  // Broad handlers whose body neither re-raises nor reports at error level (plan Appendix A FM-07).
  { id: 'swallow.py-broad-except', langs: ['py'], code: true, re: /^\s*except\s*\(?\s*(?:Exception|BaseException)\s*\)?(?:\s+as\s+\w+)?\s*:/, bodyNot: HANDLED },
  { id: 'swallow.broad-catch', langs: ['jvm'], code: true, re: /\bcatch\s*\(\s*(?:final\s+)?(?:java\.lang\.)?(?:Exception|Throwable|RuntimeException)\s+\w+\s*\)\s*\{/, bodyNot: HANDLED },
  { id: 'swallow.broad-catch', langs: ['cs'], code: true, re: /\bcatch\s*(?:\(\s*(?:System\.)?Exception(?:\s+\w+)?\s*\))?\s*\{/, bodyNot: HANDLED },
];

/** Logging calls with their level (used to detect error -> warning downgrades). */
export const LOG_CALL = /\b(?:console|logger|log|logging|LOG|Log|slog|zap|logrus|Logger|_logger|_log|this\.(?:logger|log)|self\.(?:logger|log))\s*\.\s*(error|err|fatal|critical|exception|warn|warning|info|debug|trace|Error|Errorf|Fatal|Fatalf|Warn|Warnf|Warning|Info|Infof|Debug|Debugf|LogError|LogCritical|LogWarning|LogInformation|LogDebug)\s*\(|\b(error|warn|info|debug|trace)!\s*\(/;
export const THROW_LINE = /\bthrow\b|^\s*raise\b|\bpanic!?\s*\(|\breturn\s+(?:nil\s*,\s*)?(?:err\b|fmt\.Errorf\b|errors\.)|\bErr\s*\(/;
export const LOG_LEVEL_RANK = { fatal: 3, critical: 3, error: 3, err: 3, exception: 3, warn: 2, warning: 2, info: 1, information: 1, debug: 0, trace: 0 };

/** CI edits that turn a failing step green (FM-06); applied to added lines of CI files. */
export const CI_WEAKENING = [
  { id: 'ci.continue-on-error', re: /\bcontinue-on-error\s*:\s*(?:true\b|["']?\$\{\{)/ },
  { id: 'ci.allow-failure', re: /\ballow_failure\s*:\s*(?:true\b|\{)|\bcontinueOnError\s*:\s*true\b|\bignore_failure\s*:\s*true\b/ },
  { id: 'ci.or-true', re: /\|\|\s*(?:true\b|:\s*(?:$|[;)&|])|exit\s+0\b|echo\b)|;\s*(?:true|exit\s+0)\s*["']?\s*$/ },
  { id: 'ci.pass-with-no-tests', re: /--pass(?:WithNoTests|-with-no-tests)\b|--allow-no-tests\b|--no-tests[= ](?:pass|warn)\b/ },
  { id: 'ci.set-plus-e', re: /^\s*(?:-\s*)?set\s+\+e\b|\$ErrorActionPreference\s*=\s*['"]?(?:SilentlyContinue|Continue)\b/ },
  { id: 'ci.if-false', re: /^\s*(?:-\s*)?if\s*:\s*(?:false|["']?\$\{\{\s*false\s*\}\}["']?|0)\s*$/ },
  { id: 'ci.skip-tests', re: /-DskipTests\b|-Dmaven\.test\.skip=true\b|--skip-tests?\b|(?:^|\s)-x\s+(?::?\w+:)?test\b|--exclude-task\s+test\b|\bSKIP_TESTS\s*[:=]\s*['"]?(?:1|true)\b/ },
  { id: 'ci.ignore-test-failures', re: /-Dmaven\.test\.failure\.ignore=true\b|\btestFailureIgnore\b|\bignoreFailures\s*=\s*true\b|--exit-zero\b|--no-fail(?:-on-\w+)?\b|--fail-on-flaky-tests\s*=\s*false/ },
  { id: 'ci.fail-off', re: /\bfail_ci_if_error\s*:\s*false\b|\bfail-on-error\s*:\s*false\b|\bfail_on_failure\s*:\s*false\b|\bfail-on-severity\s*:\s*(?:none|never)\b|\bfailOnStderr\s*:\s*false\b/ },
  { id: 'ci.paths-ignore', severity: 'finding', re: /^\s*paths-ignore\s*:/ },
];

/** Coverage/quality thresholds with a numeric value; a lower number in the head is a weakening. */
export const THRESHOLD = /(--(?:cov-)?fail-under[= ]|\bfail_under\s*[=:]\s*|--(?:break-at|threshold|min-coverage|minimum-coverage|coverage-threshold)[= ]|\b(?:minimum_coverage|branches|functions|lines|statements|mutationThreshold|break)\s*[:=]\s*|\btarget\s*:\s*)["']?(\d+(?:\.\d+)?)%?/;

/** In-source retries added to tests (FM-13, CK-RETRY). */
export const IN_SOURCE_RETRIES = [
  { id: 'retry.jest', langs: ['js'], code: true, blank: true, re: /\bjest\.retryTimes\s*\(/ },
  { id: 'retry.mocha', langs: ['js'], code: true, blank: true, re: /\bthis\.retries\s*\(\s*[1-9]/ },
  { id: 'retry.playwright', langs: ['js'], code: true, blank: true, re: /\.describe\.configure\s*\(\s*\{[^}]*\bretries\s*:\s*[1-9]/ },
  { id: 'retry.js-options', langs: ['js'], code: true, blank: true, re: /\b(?:it|test|describe)(?:\.(?:only|skip|concurrent|sequential))*\s*\(\s*(['"`])(?:(?!\1).)*\1\s*,\s*\{[^}]*\bretr(?:y|ies)\s*:\s*(?:\{|[1-9])/ },
  { id: 'retry.py', langs: ['py'], code: true, re: /@pytest\.mark\.flaky\b|@flaky\b|\bpytest\.mark\.flaky\b|@(?:pytest\.mark\.)?retry\b/ },
  { id: 'retry.jvm', langs: ['jvm'], code: true, re: /@(?:RetryingTest|Retry|RepeatedIfExceptionsTest|Flaky)\b|\bretryAnalyzer\s*=/ },
  { id: 'retry.cs', langs: ['cs'], code: true, re: /\[\s*(?:\w+\s*,\s*)*(?:Retry|RetryFact|RetryTheory)\b/ },
  { id: 'retry.rb', langs: ['rb'], code: true, re: /\bretry:\s*[1-9]|:retry\s*=>\s*[1-9]|\brun_with_retry\b/ },
  { id: 'retry.rs', langs: ['rs'], code: true, re: /#\[(?:retry|flaky)\b/ },
];

// ---------------------------------------------------------------------------
// Secrets (FM-09). Built-in fallback when gitleaks/trufflehog are absent (decision D7).
// Severity 'fail' for high-confidence token shapes, 'finding' for heuristics.

export const SECRET_PATTERNS = [
  { id: 'secret.aws-access-key-id', severity: 'fail', re: /\b((?:AKIA|ASIA|ABIA|ACCA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[A-Z2-7]{16})\b/ },
  { id: 'secret.aws-secret-key', severity: 'fail', re: /aws_?secret_?(?:access_?)?key\w*["']?\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/i },
  { id: 'secret.github-token', severity: 'fail', re: /\b(gh[pousr]_[A-Za-z0-9]{36,255})\b/ },
  { id: 'secret.github-fine-grained', severity: 'fail', re: /\b(github_pat_[A-Za-z0-9_]{60,255})\b/ },
  { id: 'secret.gitlab-token', severity: 'fail', re: /\b(gl(?:pat|dt|rt|ptt|cbt)-[A-Za-z0-9_-]{20,})\b/ },
  { id: 'secret.slack-token', severity: 'fail', re: /\b(xox[abposr]-[A-Za-z0-9-]{10,})\b/ },
  { id: 'secret.slack-webhook', severity: 'fail', re: /(https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]{6,}\/B[A-Z0-9]{6,}\/[A-Za-z0-9]{16,})/ },
  { id: 'secret.stripe-key', severity: 'fail', re: /\b((?:sk|rk)_live_[A-Za-z0-9]{20,})\b/ },
  { id: 'secret.stripe-test-key', severity: 'finding', re: /\b((?:sk|rk)_test_[A-Za-z0-9]{20,})\b/ },
  { id: 'secret.google-api-key', severity: 'fail', re: /\b(AIza[0-9A-Za-z_-]{35})(?![0-9A-Za-z_-])/ },
  { id: 'secret.openai-key', severity: 'fail', re: /\b(sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{16,}T3BlbkFJ[A-Za-z0-9_-]{16,})\b/ },
  { id: 'secret.anthropic-key', severity: 'fail', re: /\b(sk-ant-(?:api|admin|oat)\d{2}-[A-Za-z0-9_-]{60,})\b/ },
  { id: 'secret.npm-token', severity: 'fail', re: /\b(npm_[A-Za-z0-9]{36})\b/ },
  { id: 'secret.pypi-token', severity: 'fail', re: /\b(pypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{50,})\b/ },
  { id: 'secret.sendgrid-key', severity: 'fail', re: /\b(SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43})\b/ },
  { id: 'secret.twilio-key', severity: 'finding', re: /\b(SK[0-9a-f]{32})\b/ },
  { id: 'secret.azure-storage-key', severity: 'fail', re: /AccountKey=([A-Za-z0-9+/]{86}==)/ },
  { id: 'secret.private-key', severity: 'fail', re: /(-{5}BEGIN[ A-Z0-9_-]{0,40}PRIVATE KEY(?: BLOCK)?-{5})/ },
  { id: 'secret.jwt', severity: 'finding', re: /\b(eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/ },
  { id: 'secret.url-credentials', severity: 'finding', re: /\b[a-z][a-z0-9+.-]{1,20}:\/\/([^/\s:@'"`]{2,64}:[^/\s:@'"`]{6,128})@([^\s/'"`]+)/ },
  // A value is quoted, or unquoted and last on its line (dotenv, YAML, shell): code such as
  // `{ ADC_LIVE_TOKEN: token }` and placeholders such as `[REDACTED]`, `<token>`, `${VAR}` or
  // `process.env.X` are not values.
  { id: 'secret.adc-live-token', severity: 'fail', re: /\bADC_LIVE_TOKEN\s*[:=]\s*(?:["'](?![[<{$%]|process\.|os\.|env\.|getenv)([^\s"'`;,()]{6,})["']|(?![[<{$%"']|process\.|os\.|env\.|getenv)([^\s"'`;,()]{6,})(?=\s*(?:#.*)?$))/ },
  { id: 'secret.generic-assignment', severity: 'finding', generic: true,
    re: /\b(?:api[_-]?key|apikey|secret(?:[_-]?key)?|client[_-]?secret|access[_-]?token|auth[_-]?token|private[_-]?key|passw(?:or)?d|pwd)\b["']?\s*[:=]\s*["']([^"'\s]{12,200})["']/i },
];

const SECRET_GLOBAL = SECRET_PATTERNS.map((p) => ({ ...p, g: new RegExp(p.re.source, p.re.flags + 'g') }));
const PLACEHOLDER = /^(?:x+|\*+|\.+|<[^>]*>|\$\{[^}]*\}|\{\{[^}]*\}\}|%\(?\w+\)?s?|changeme|change_me|replace_?me|your[_-]?\w*|example\w*|dummy\w*|fake\w*|test\w*|sample\w*|placeholder\w*|redacted\w*|none|null|undefined|todo\w*|secret|password\w*)$/i;
const ENV_REFERENCE = /process\.env|os\.environ|getenv|System\.getenv|Environment\.GetEnvironmentVariable|ENV\[|\$\{\{\s*secrets\./;

function entropy(s) {
  const counts = new Map();
  for (const c of s) counts.set(c, (counts.get(c) || 0) + 1);
  let h = 0;
  for (const n of counts.values()) { const p = n / s.length; h -= p * Math.log2(p); }
  return h;
}

/** Mask a secret value: keep a short prefix for recognizability, never the value. */
export function maskSecret(value) {
  const v = String(value);
  const keep = v.length >= 16 ? 4 : 0;
  return `${v.slice(0, keep)}...[REDACTED]`;
}

/** Secret values detected on one line: [{ id, severity, value }] (a specific rule wins over the generic one). */
function secretHits(line) {
  if (!line || line.length > 20_000) return [];
  const hits = [];
  for (const p of SECRET_GLOBAL) {
    const re = p.g;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(line))) {
      const value = m[1] || m[2] || m[0];
      if (m[0].length === 0) re.lastIndex++;
      if (p.generic && !plausibleGeneric(value, line)) continue;
      if (p.id === 'secret.url-credentials' && !plausibleUrlCredential(m[1], m[2])) continue;
      hits.push({ id: p.id, severity: p.severity, value });
    }
  }
  if (!hits.length) return hits;
  const specific = new Set(hits.filter((h) => !h.id.startsWith('secret.generic')).map((h) => h.value));
  return hits.filter((h) => !(h.id.startsWith('secret.generic') && [...specific].some((v) => v.includes(h.value) || h.value.includes(v))));
}

function maskValues(line, hits) {
  let out = line;
  for (const h of [...hits].sort((a, b) => b.value.length - a.value.length)) out = out.split(h.value).join(maskSecret(h.value));
  return out;
}

/** `text` with every detected secret value masked in place (for messages and excerpts). */
export function redactSecrets(text) {
  if (text == null) return text;
  return String(text).split(/(\r?\n)/).map((part) => {
    const hits = secretHits(part);
    return hits.length ? maskValues(part, hits) : part;
  }).join('');
}

/**
 * Built-in secret scan. Returns [{ id, line, severity, redacted }] where `redacted` is the
 * line with every detected value masked. The raw value is never returned.
 */
export function scanSecrets(text) {
  const out = [];
  const lines = String(text ?? '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const kept = secretHits(line);
    if (!kept.length) continue;
    const redacted = maskValues(line, kept);
    const seen = new Set();
    for (const h of kept) {
      const key = `${h.id}:${h.value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ id: h.id, line: i + 1, severity: h.severity, redacted: redacted.trim().slice(0, 300) });
    }
  }
  return out;
}

function plausibleGeneric(value, line) {
  if (PLACEHOLDER.test(value) || ENV_REFERENCE.test(line)) return false;
  if (/^[a-z]+(?:[_-][a-z]+)*$/i.test(value) && value.length < 24) return false;
  if (!/[0-9]/.test(value) && !/[^A-Za-z]/.test(value)) return false;
  return entropy(value) >= 3.3;
}

function plausibleUrlCredential(userPass, host) {
  const [user, pass] = String(userPass).split(':');
  if (!pass || PLACEHOLDER.test(pass) || PLACEHOLDER.test(user) || /^\$|^%|^\{/.test(pass)) return false;
  const h = String(host).split('/')[0].replace(/:\d+$/, '');
  if (/^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|db|postgres|mysql|redis|mongo)$/i.test(h)) return false;
  // RFC 2606 / 6761 names never resolve to a real service: documentation and test fixtures.
  if (/(?:^|\.)(?:example\.(?:com|net|org)|example|test|invalid|localhost)$/i.test(h)) return false;
  return pass !== user;
}

/** Credential-like file names (an added file is a finding even before its content is scanned). */
export function credentialFileName(file) {
  const base = baseOf(toPosix(file)).toLowerCase();
  if (/^\.env(?:\..+)?$/.test(base) && !/\.(?:example|sample|template|dist|defaults?)$/.test(base)) return 'dotenv';
  if (/^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)$/.test(base)) return 'ssh-key';
  if (/\.(?:pem|p12|pfx|key|keystore|jks|ppk|asc)$/.test(base) && !/\.pub(?:lic)?\./.test(base)) return 'key-file';
  if (/^(?:credentials(?:\.json)?|\.pypirc|\.netrc|_netrc|\.git-credentials|service-account.*\.json)$/.test(base)) return 'credentials';
  return null;
}

// ---------------------------------------------------------------------------
// Scanning

const masksCache = new WeakMap();

/**
 * Scan `text` with one catalog or an array of catalogs. Options: `file` (selects the language,
 * filters `langs` and enables comment masking), `lines` (Set of 1-based line numbers to report).
 * Returns [{ id, line, text, kind?, severity?, scope? }].
 */
export function scanText(text, catalogs, opts = {}) {
  const list = Array.isArray(catalogs) && Array.isArray(catalogs[0]) ? catalogs.flat() : (catalogs || []);
  const lang = opts.lang || (opts.file ? langOf(opts.file) : null);
  const raw = Array.isArray(text) ? text : String(text ?? '').split(/\r?\n/);
  let masked = null;
  const getMasked = () => {
    if (masked) return masked;
    if (!lang) { masked = raw; return masked; }
    if (Array.isArray(text) && masksCache.has(text)) { masked = masksCache.get(text); return masked; }
    masked = maskComments(raw, lang);
    if (Array.isArray(text)) masksCache.set(text, masked);
    return masked;
  };
  const entries = list.filter((e) => !e.langs || !lang || e.langs.includes(lang));
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    if (opts.lines && !opts.lines.has(i + 1)) continue;
    const seen = new Set();
    for (const e of entries) {
      if (seen.has(e.id)) continue;
      const code = e.code ? getMasked()[i] : raw[i];
      const subject = e.blank === 'index' ? blankNonIndex(code) : e.blank ? blankStrings(code) : code;
      if (!subject) continue;
      const m = e.re.exec(subject);
      if (!m || (e.blank && !e.re.test(code))) continue;
      if (e.next) {
        const src = e.code ? getMasked() : raw;
        let j = i + 1;
        while (j < src.length && !src[j].trim()) j++;
        if (j >= src.length || !e.next.test(src[j])) continue;
      }
      if (e.bodyNot) {
        const block = handlerBody(getMasked(), i, lang);
        // Empty and `pass`-only bodies belong to the empty-handler entries, not to this one.
        if (!block || /^(?:\s|pass\b|\.\.\.|continue\b|;)*$/.test(block.body) || e.bodyNot.test(blankStrings(block.body))) continue;
      }
      seen.add(e.id);
      // `match` is the marker itself (string contents taken from the real line), for ratchet keys.
      const hit = { id: e.id, line: i + 1, text: raw[i].trim().slice(0, 240), match: code.slice(m.index, m.index + m[0].length) };
      if (e.kind) hit.kind = e.kind;
      if (e.severity) hit.severity = e.severity;
      if (e.scope) hit.scope = e.scope;
      out.push(hit);
    }
  }
  return out;
}

const FAILS_TEST = /\b(?:raise|throw|rethrow|fail|Fail|assert\w*|Assert|expect|done)\b|\$this->fail|\bpytest\.fail\b|\bself\.fail\b/;
const BROAD_FOR_ASSERTIONS = {
  py: (t) => !t || /\b(?:Exception|BaseException|AssertionError)\b/.test(t),
  js: () => true,
  dart: () => true,
  // JUnit/Kotest assertions throw java.lang.AssertionError subclasses, which `catch (Exception)` misses.
  jvm: (t) => /\b(?:Throwable|Error|AssertionError|AssertionFailedError|ComparisonFailure|MultipleFailuresError)\b/.test(t),
  cs: (t) => !t || /^(?:System\.)?Exception\b|\b(?:AssertionException|XunitException|AssertFailedException|AssertActualExpectedException)\b/.test(t.trim()),
  php: (t) => /\b(?:Exception|Throwable|AssertionFailedError|ExpectationFailedException)\b/.test(t),
};

/**
 * Assertions wrapped in a try block whose handler catches assertion failures and neither
 * re-raises nor fails the test (plan Appendix A FM-01 "try/except wrapped around assertions").
 * Returns [{ id, line, text }] with the handler line (1-based).
 */
export function tryWrappedAssertions(lines, file) {
  const lang = langOf(file);
  const broad = BROAD_FOR_ASSERTIONS[lang];
  if (!broad) return [];
  const raw = Array.isArray(lines) ? lines : String(lines ?? '').split(/\r?\n/);
  const masked = maskComments(raw, lang);
  const asserts = new Set(scanText(raw, ASSERTION_LINE, { file }).map((h) => h.line - 1));
  const hasAssert = (a, b) => { for (let k = a; k <= b; k++) if (asserts.has(k)) return true; return false; };
  const out = [];
  const hit = (j) => out.push({ id: 'assert-swallow.try-wrap', line: j + 1, text: raw[j].trim().slice(0, 240) });
  for (let i = 0; i < masked.length; i++) {
    if (lang === 'py') {
      if (!/^\s*try\s*:\s*$/.test(masked[i])) continue;
      const body = indentBlock(masked, i);
      if (!hasAssert(i + 1, body.end)) continue;
      const base = indentOf(masked[i]);
      for (let j = body.end + 1; j < masked.length; j++) {
        const l = masked[j];
        if (!l.trim()) continue;
        if (indentOf(l) !== base || !/^\s*(?:except|else|finally)\b/.test(l)) break;
        const m = /^\s*except\b\s*([^:]*):/.exec(l);
        if (!m) continue;
        const handler = indentBlock(masked, j);
        if (broad(m[1].replace(/\s+as\s+\w+\s*$/, '').trim()) && !FAILS_TEST.test(blankStrings(handler.body))) hit(j);
        j = handler.end;
      }
      continue;
    }
    const t = blankStrings(masked[i]);
    const at = t.search(/\btry\s*\{/);
    if (at === -1) continue;
    const tryBlock = braceBlock(masked, i, at);
    if (!tryBlock || !hasAssert(tryBlock.start, tryBlock.end)) continue;
    // The catch clause follows the closing brace, on the same line or the next non-blank one.
    let j = tryBlock.end;
    let rest = blankStrings(masked[j]).slice(tryBlock.endCol + 1);
    if (!rest.trim()) {
      j++;
      while (j < masked.length && !masked[j].trim()) j++;
      rest = blankStrings(masked[j] || '');
    }
    const m = /^\s*catch\s*(?:\(([^)]*)\))?\s*\{/.exec(rest);
    if (!m) continue;
    const handler = braceBlock(masked, j, blankStrings(masked[j]).indexOf('catch'));
    if (handler && broad(String(m[1] || '').replace(/\s+\$?\w+\s*$/, '').trim()) && !FAILS_TEST.test(handler.body)) hit(j);
  }
  return out;
}

/** 1-based [start, end] line ranges of Rust `#[cfg(test)] mod ... { }` blocks. */
export function rustTestRanges(lines) {
  const raw = Array.isArray(lines) ? lines : String(lines ?? '').split(/\r?\n/);
  const masked = maskComments(raw, 'rs');
  const out = [];
  for (let i = 0; i < masked.length; i++) {
    if (!/#\[cfg\(\s*test\s*\)\]/.test(masked[i])) continue;
    for (let j = i; j < Math.min(masked.length, i + 4); j++) {
      const at = masked[j].search(/\bmod\s+\w+\s*\{/);
      if (at === -1) { if (/\bmod\s+\w+\s*;/.test(masked[j])) break; continue; }
      const block = braceBlock(masked, j, at);
      if (block) { out.push([i + 1, block.end + 1]); i = block.end; }
      break;
    }
  }
  return out;
}

/** Test-case declarations in a file's lines: [{ line, name, id }] (name may be null). */
export function testCases(lines, file) {
  const lang = langOf(file);
  if (!lang) return [];
  const raw = Array.isArray(lines) ? lines : String(lines ?? '').split(/\r?\n/);
  const masked = maskComments(raw, lang);
  const entries = TEST_CASE_LINE.filter((e) => e.langs.includes(lang));
  const out = [];
  for (let i = 0; i < masked.length; i++) {
    for (const e of entries) {
      const m = e.re.exec(masked[i]);
      if (!m) continue;
      let name = e.name ? (m[e.name] ?? null) : null;
      if (!name && e.lookahead) {
        for (let j = i; j < Math.min(masked.length, i + 8) && !name; j++) {
          const n = e.lookahead.exec(masked[j]);
          if (n) name = n.slice(1).find(Boolean) || null;
        }
      }
      out.push({ line: i + 1, name: name ? name.trim() : null, id: e.id });
      break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Path classification (heuristic; detect.mjs refines `test` with the runner's real globs)

const TEST_DIRS = new Set(['test', 'tests', '__tests__', 'spec', 'specs', 'e2e', 'integration-tests', 'integration_tests',
  'functional-tests', 'acceptance-tests', '__mocks__', 'cypress', 'testing']);
const DATA_EXTS = new Set(['.json', '.yaml', '.yml', '.txt', '.csv', '.xml', '.html', '.md', '.snap', '.golden', '.toml', '.ini', '.cfg', '.sql', '.log', '.png', '.jpg', '.gif', '.svg']);

/** Runner naming convention a test file name follows ('jest', 'pytest', 'go', ...), or null. */
export function testNaming(file) {
  const p = toPosix(file);
  const base = baseOf(p);
  const lower = base.toLowerCase();
  if (/\.(?:test|spec|e2e|e2e-spec|cy|it|bench)\.[cm]?[jt]sx?$/.test(lower) || /\.(?:test|spec)\.(?:vue|svelte)$/.test(lower)) return 'js';
  if (/^test_.*\.py$|_test\.py$|^tests\.py$|^conftest\.py$/.test(lower)) return 'pytest';
  if (/_test\.go$/.test(lower)) return 'go';
  if (/_spec\.rb$|_test\.rb$|^test_.*\.rb$/.test(lower)) return 'ruby';
  if (/^Test[A-Z_]\w*\.(?:java|kt|groovy|scala)$|^\w+(?:Test|Tests|TestCase|IT|Spec|Suite)\.(?:java|kt|groovy|scala)$/.test(base)) return 'jvm';
  if (/^\w+(?:Tests?|Specs?|Fixture)\.(?:cs|fs|vb)$/.test(base)) return 'dotnet';
  if (/^\w+Test\.php$/.test(base)) return 'phpunit';
  if (/^\w+Tests?\.swift$/.test(base)) return 'xctest';
  if (/_test\.(?:exs|dart)$/.test(lower)) return 'other';
  if (/(?:_test|_unittest|_tests)\.(?:c|cc|cpp|cxx)$|^test_\w+\.(?:c|cc|cpp|cxx)$/.test(lower)) return 'c';
  return null;
}

const RUNNER_CONFIG_BASE = /^(?:jest\.config\.[cm]?[jt]s(?:on)?|vitest\.(?:config|workspace|projects)\.[cm]?[jt]s|vite\.config\.[cm]?[jt]s|playwright(?:-ct)?\.config\.[cm]?[jt]s|cypress\.config\.[cm]?[jt]s|cypress\.json|\.mocharc(?:\.[cm]?js|\.json|\.jsonc|\.ya?ml)?|karma\.conf\.[cm]?[jt]s|ava\.config\.[cm]?js|wdio\.conf\.[cm]?[jt]s|\.c8rc(?:\.json)?|\.nycrc(?:\.json|\.ya?ml)?|pytest\.ini|tox\.ini|setup\.cfg|pyproject\.toml|conftest\.py|noxfile\.py|\.coveragerc|nextest\.toml|cargo\.toml|.+\.runsettings|.+\.testsettings|directory\.build\.(?:props|targets)|.+\.(?:cs|fs|vb)proj|pom\.xml|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|\.rspec|\.simplecov|rakefile|phpunit\.xml(?:\.dist)?|makefile|gnumakefile|.+\.mk|justfile|\.justfile|taskfile\.ya?ml|package\.json|codecov\.ya?ml|\.codecov\.ya?ml|deno\.jsonc?)$/;
const LOCKFILE_BASE = /^(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|poetry\.lock|uv\.lock|pipfile\.lock|pdm\.lock|go\.sum|cargo\.lock|packages\.lock\.json|gemfile\.lock|composer\.lock|gradle\.lockfile|package\.resolved|pubspec\.lock|mix\.lock|flake\.lock|deno\.lock)$/;
const MANIFEST_BASE = /^(?:package\.json|pyproject\.toml|setup\.py|setup\.cfg|requirements(?:[-_.][\w.-]+)?\.(?:txt|in)|constraints\.txt|pipfile|go\.mod|cargo\.toml|.+\.(?:cs|fs|vb)proj|directory\.packages\.props|packages\.config|pom\.xml|build\.gradle(?:\.kts)?|gemfile|.+\.gemspec|composer\.json|deno\.jsonc?|package\.swift|pubspec\.yaml|mix\.exs)$/;
const LINT_CONFIG_BASE = /^(?:\.eslintrc(?:\.[cm]?js|\.json|\.ya?ml)?|eslint\.config\.[cm]?[jt]s|\.(?:eslint|stylelint|markdownlint|semgrep|gitleaks)ignore|\.gitleaks\.toml|biome\.jsonc?|\.oxlintrc\.json|tsconfig(?:\.[\w-]+)?\.json|jsconfig\.json|\.flake8|ruff\.toml|\.ruff\.toml|mypy\.ini|\.mypy\.ini|pyrightconfig\.json|\.pylintrc|pylintrc|\.golangci\.(?:ya?ml|toml|json)|clippy\.toml|\.clippy\.toml|\.stylelintrc(?:\.\w+)?|\.markdownlint(?:\.\w+)?|\.yamllint(?:\.ya?ml)?|\.rubocop(?:_todo)?\.ya?ml|\.standard\.yml|phpstan\.neon(?:\.dist)?|psalm\.xml|\.?phpcs\.xml(?:\.dist)?|\.swiftlint\.ya?ml|detekt\.ya?ml|checkstyle[\w-]*\.xml|pmd[\w-]*\.xml|spotbugs[\w-]*\.xml|\.clang-tidy|\.editorconfig|\.globalconfig|.+\.ruleset|stylecop\.json|\.pre-commit-config\.ya?ml|\.deepsource\.toml|sonar-project\.properties)$/;
const GENERATED_DIRS = new Set(['dist', 'target', 'node_modules', 'vendor', '__generated__', 'generated', '.next', '.nuxt',
  '.svelte-kit', 'coverage', 'htmlcov', '__pycache__', 'site-packages', '.gradle', 'obj', '.turbo', '.parcel-cache']);
const GENERATED_BASE = /(?:\.min\.(?:js|css|mjs)|\.(?:js|css)\.map|\.pb\.go|_pb2(?:_grpc)?\.pyi?|\.pb\.(?:cc|h)|\.g\.(?:dart|cs)|\.designer\.cs|\.generated\.\w+|_generated\.go|^zz_generated[\w.]*\.go|\.pyc)$/;

/**
 * Heuristic, path-only classification:
 * { test, runnerConfig, ci, lockfile, lintConfig, manifest, generated, testData, snapshot }.
 */
export function classifyPath(file) {
  const p = toPosix(file).replace(/^\.\//, '');
  const segs = p.split('/');
  const base = segs[segs.length - 1];
  const lower = base.toLowerCase();
  const dirs = segs.slice(0, -1).map((d) => d.toLowerCase());
  const lowerPath = p.toLowerCase();
  const code = isCodeFile(p);
  const inTestDir = dirs.some((d) => TEST_DIRS.has(d) || /\.(?:unit|integration|functional)?tests?$/.test(d)) ||
    lowerPath.includes('src/test/') || lowerPath.includes('src/androidtest/');
  const named = testNaming(p) != null;
  const snapshot = dirs.includes('__snapshots__') || /\.(?:snap|ambr|golden)$/.test(lower) ||
    /\.(?:approved|verified|received)\.\w+$/.test(lower) || (dirs.includes('snapshots') && /\.snap(?:\.new)?$/.test(lower));
  const ci = (dirs[0] === '.github' && dirs[1] === 'workflows' && /\.ya?ml$/.test(lower)) ||
    (dirs[0] === '.github' && dirs[1] === 'actions' && /^action\.ya?ml$/.test(lower)) ||
    /^(?:\.gitlab-ci\.ya?ml|azure-pipelines(?:[\w.-]*)\.ya?ml|\.travis\.ya?ml|bitbucket-pipelines\.ya?ml|\.drone\.ya?ml|appveyor\.ya?ml|\.appveyor\.ya?ml|jenkinsfile|cloudbuild\.ya?ml|buildspec\.ya?ml|\.woodpecker\.ya?ml)$/.test(lower) ||
    (dirs[0] === '.circleci' && /\.ya?ml$/.test(lower)) || (dirs[0] === '.gitlab' && /\.ya?ml$/.test(lower) && dirs.includes('ci')) ||
    ((dirs[0] === '.azure-pipelines' || dirs[0] === '.buildkite' || dirs[0] === '.woodpecker') && /\.ya?ml$/.test(lower));
  const ext = extOf(lower);
  return {
    test: code && (named || inTestDir) && !snapshot,
    runnerConfig: RUNNER_CONFIG_BASE.test(lower) || (dirs[dirs.length - 1] === '.config' && lower === 'nextest.toml') ||
      (dirs[dirs.length - 1] === '.cargo' && lower === 'config.toml'),
    ci,
    lockfile: LOCKFILE_BASE.test(lower),
    lintConfig: LINT_CONFIG_BASE.test(lower),
    manifest: MANIFEST_BASE.test(lower),
    generated: !LOCKFILE_BASE.test(lower) && (dirs.some((d) => GENERATED_DIRS.has(d)) || GENERATED_BASE.test(lower)),
    testData: !code && inTestDir && (DATA_EXTS.has(ext) || snapshot),
    snapshot,
  };
}

/** Content header that marks a generated file. */
export const GENERATED_HEADER = /(?:Code generated\b.*\bDO NOT EDIT|@generated\b|<auto-generated|This file (?:is|was|has been) (?:automatically |auto-)?generated|\bAUTO-?GENERATED FILE\b|\bDO NOT EDIT\b.*\bgenerated\b)/i;

/** The header ci-gate writes into the workflows it generates (plan §10.5). */
export const CI_GATE_HEADER = /^#\s*generated by agentic-developer-companion ci-gate\b/m;

/** All catalogs by name, for callers that select at runtime (hooks). */
export const CATALOGS = Object.freeze({
  skip: SKIP_MARKERS, suppress: SUPPRESSIONS, swallow: SWALLOW_PATTERNS, retry: IN_SOURCE_RETRIES,
  ci: CI_WEAKENING, assert: ASSERTION_LINE, cases: TEST_CASE_LINE, secrets: SECRET_PATTERNS,
});
