// Pattern catalogs for the diff-scoped checks (plan §9.1 steps 3-8, Appendix A) and the post-edit
// hook, path classification, test files and test cases, and secret scanning and redaction.
// Imports only core.mjs: hooks load this module, so no git, no filesystem, no network.

import { toPosix, matchAny, redactLiterals, liveSecrets, redactLiveToken } from './core.mjs';

// Long patterns are written in pieces (each a valid literal; flags come from the first one):
// `cat` concatenates, `alt` joins alternatives, `group` wraps them in (?:...), `capture` in (...),
// `names` in ^(?:...)$.
const src = (res, sep) => res.map((r) => r.source).join(sep);
const cat = (...res) => new RegExp(src(res, ''), res[0].flags);
const alt = (...res) => new RegExp(src(res, '|'), res[0].flags);
const group = (...res) => new RegExp(`(?:${src(res, '|')})`, res[0].flags);
const capture = (...res) => new RegExp(`(${src(res, '|')})`, res[0].flags);
const names = (...res) => new RegExp(`^(?:${src(res, '|')})$`, res[0].flags);
const words = (s) => s.trim().split(/\s+/);

// ---------------------------------------------------------------------------
// Languages and comment masking

const EXT_LANG = Object.fromEntries(Object.entries({
  js: 'js jsx mjs cjs ts tsx mts cts vue svelte astro', py: 'py pyi', go: 'go', rs: 'rs',
  jvm: 'java kt kts groovy scala sc', cs: 'cs fs fsx vb', rb: 'rb rake', php: 'php', swift: 'swift',
  c: 'c h cc cpp cxx hpp hh m mm', dart: 'dart', ex: 'ex exs', sh: 'sh bash zsh', ps: 'ps1 psm1',
}).flatMap(([lang, exts]) => words(exts).map((e) => [`.${e}`, lang])));
const HASH_COMMENT = new Set(words('py rb sh ps ex'));
const baseOf = (p) => p.slice(p.lastIndexOf('/') + 1);
const extOf = (base) => (base.lastIndexOf('.') > 0 ? base.slice(base.lastIndexOf('.')).toLowerCase() : '');

/** Language family of a path ('js', 'py', 'go', 'rs', 'jvm', 'cs', 'rb', 'php', 'swift', 'c', ...) or null. */
export function langOf(file) {
  if (!file) return null;
  const base = baseOf(toPosix(file));
  return base === 'Rakefile' || base === 'Gemfile' ? 'rb' : EXT_LANG[extOf(base)] || null;
}

export const isCodeFile = (file) => langOf(file) != null;

/**
 * `line` up to its comment, in one pass (quotes respected; the `//` of `http://` is no comment).
 * Slash languages carry an open block comment to the next line in `state.block`.
 */
function stripComment(line, hash, state) {
  let out = '';
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (state.block) {
      if (c === '*' && line[i + 1] === '/') { state.block = false; i++; }
      continue;
    }
    if (quote) {
      out += c;
      if (c === '\\') out += line[++i] ?? '';
      else if (c === quote) quote = null;
      continue;
    }
    if (hash ? c === '#' : c === '/' && line[i + 1] === '/' && line[i - 1] !== ':') break;
    if (!hash && c === '/' && line[i + 1] === '*') { state.block = true; i++; continue; }
    if (c === '"' || c === "'" || c === '`') quote = c;
    out += c;
  }
  return out;
}

/** Lines with comments (and Python triple-quoted blocks) blanked, so code catalogs skip commented-out text. */
function maskComments(lines, lang) {
  const state = { block: false };
  const hash = HASH_COMMENT.has(lang);
  let triple = null;
  return lines.map((line) => {
    if (lang === 'py') {
      if (triple) {
        const end = line.indexOf(triple);
        if (end === -1) return '';
        triple = null;
        return stripComment(line.slice(end + 3), true, state);
      }
      const t = line.trim();
      const q = t.startsWith('"""') ? '"""' : t.startsWith("'''") ? "'''" : null;
      if (q && t.indexOf(q, 3) === -1) { triple = q; return ''; }
    }
    return stripComment(line, hash, state);
  });
}

// String literals blanked, so brace counting and keyword checks ignore their contents.
const STRING_LITERAL = /(["'`])(?:\\.|(?!\1).)*\1/g;
const blankLiteral = (s) => s[0] + ' '.repeat(Math.max(0, s.length - 2)) + s[0];
const blankStrings = (line) => String(line ?? '').replace(STRING_LITERAL, blankLiteral);
// Like blankStrings, but keeps a literal used as a property index (`describe['skip']`).
const blankNonIndex = (line) => String(line ?? '')
  .replace(STRING_LITERAL, (s, _q, at, all) => (/\[\s*$/.test(all.slice(0, at)) ? s : blankLiteral(s)));
const indentOf = (line) => line.length - line.trimStart().length;

/** The `{ ... }` block opening at or after column `col` of line `i` (0-based): { start, end, endCol, body } or null. */
function braceBlock(masked, i, col = 0) {
  let depth = 0;
  let open = null;
  const body = [];
  for (let j = i; j < masked.length && j < i + 2000; j++) {
    const line = blankStrings(masked[j]);
    let seg = '';
    for (let k = j === i ? col : 0; k < line.length; k++) {
      const c = line[k];
      if (c === '{' && depth++ === 0) { open = j; continue; }
      if (c === '}' && open != null && --depth === 0) {
        body.push(seg);
        return { start: open, end: j, endCol: k, body: body.join('\n') };
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
  const body = inline ? [inline] : [];
  let end = i;
  for (let j = i + 1; j < masked.length; j++) {
    if (!masked[j].trim()) continue;
    if (indentOf(masked[j]) <= indentOf(head)) break;
    body.push(masked[j]);
    end = j;
  }
  return { start: i, end, body: body.join('\n') };
}

function handlerBody(masked, i, lang) {
  if (lang === 'py' || lang === 'rb') return indentBlock(masked, i);
  const at = blankStrings(masked[i]).search(/\bcatch\b/);
  return braceBlock(masked, i, at === -1 ? 0 : at);
}

// ---------------------------------------------------------------------------
// Catalogs. Entry: { id, re, langs?, code?, blank?, kind?, severity?, scope?, next?, bodyNot?, name?, lookahead? }
//  langs: language families it applies to (absent: any file); code: match comment-masked text
//  (directive catalogs match raw text); blank: also blank string literals first, and the real line
//  must match too ('index' keeps `describe['skip']`); next: the next non-blank line must match;
//  bodyNot: the handler block opened on the line must be non-empty and must not match.

/** Rows `[id, langs, re, extra]` (id without the catalog prefix; '' langs: any file) plus the shared fields. */
const catalog = (prefix, shared, rows) => rows.map(([id, langs, re, extra]) =>
  ({ id: `${prefix}.${id}`, ...(langs ? { langs: words(langs) } : {}), ...shared, re, ...extra }));
const B = { blank: true };
const JS_CHAIN = cat(/\b(?:it|test|describe|context|suite|specify)/,
  /(?:\.(?:concurrent|sequential|serial|parallel|describe|each|step))*/);

/** Skip, focus, xfail and todo markers (plan Appendix A FM-01); applied to test files only. */
export const SKIP_MARKERS = catalog('skip', { code: true, kind: 'skip' }, [
  ['js-prefixed', 'js', /(?<![\w$.])(?:xit|xtest|xdescribe|xcontext|xspecify|xsuite)\s*\(/, B],
  ['js-focus-prefixed', 'js', /(?<![\w$.])(?:fit|fdescribe|fcontext|fspecify)\s*\(/, { ...B, kind: 'focus' }],
  ['js-only', 'js', cat(JS_CHAIN, /\.only\b/), { ...B, kind: 'focus' }],
  ['js-skip', 'js', cat(JS_CHAIN, /\.(?:skip|skipIf|runIf|fixme)\b/), B],
  ['js-todo', 'js', /\b(?:it|test|describe)(?:\.(?:concurrent|describe))*\.todo\b/, { ...B, kind: 'todo' }],
  ['js-failing', 'js', /\b(?:it|test)(?:\.(?:concurrent))*\.(?:failing|fails)\b/, { ...B, kind: 'xfail' }],
  ['js-bracket', 'js', /\b(?:it|test|describe)\s*\[\s*['"](?:only|skip)['"]\s*\]/, { blank: 'index' }],
  ['js-this-skip', 'js', /\bthis\.skip\s*\(/, B],
  ['js-pending', 'js', /(?<![\w$.])pending\s*\(\s*\)/, B],
  ['py-mark', 'py', /\bpytest\.mark\.(?:skip|skipif|xfail)\b/],
  ['py-call', 'py', /\bpytest\.(?:skip|xfail|importorskip)\s*\(/],
  ['py-unittest', 'py', alt(/@unittest\.(?:skip|skipIf|skipUnless|expectedFailure)\b/, /\bself\.skipTest\s*\(/,
    /\braise\s+(?:unittest\.)?SkipTest\b/)],
  ['go', 'go', /\b[tbf]\.(?:Skip|Skipf|SkipNow)\s*\(/],
  ['go-build-ignore', 'go', /^\s*\/\/\s*(?:go:build|\+build)\s+ignore\b/, { code: false }],
  // Any other build constraint drops the file from a plain `go test ./...` unless the tag is passed.
  ['go-build-tag', 'go', /^\s*\/\/\s*(?:go:build|\+build)\s+(?!ignore\b)\S/, { code: false, kind: 'constraint' }],
  ['rs-ignore', 'rs', /#\[ignore(?:\s*=\s*"[^"]*")?\s*\]/],
  ['jvm', 'jvm', /@(?:Disabled\w*|Ignore)\b|@Test\s*\([^)]*\benabled\s*=\s*false/],
  ['cs', 'cs', alt(/\[\s*(?:\w+\s*,\s*)*Ignore\b/, /\[\s*(?:Fact|Theory|SkippableFact|SkippableTheory)\s*\([^)]*\bSkip\s*=/,
    /\bAssert\.(?:Ignore|Inconclusive)\s*\(/)],
  ['rb', 'rb', alt(/^\s*(?:xit|xdescribe|xcontext|xspecify|xexample|xscenario)\b/, /^\s*(?:skip|pending)\b(?!\s*[=:])/,
    /(?:,\s*|\b)(?:skip|pending):\s*(?:true|['"])/, /,\s*:(?:skip|pending)\b/)],
  ['rb-focus', 'rb', alt(/^\s*(?:fit|fdescribe|fcontext|fspecify|fexample|fscenario)\b/, /(?:,\s*|\b)focus:\s*true/,
    /,\s*:focus\b/), { kind: 'focus' }],
  ['php', 'php', /\bmarkTest(?:Skipped|Incomplete)\s*\(|->skip\s*\(|@group\s+(?:skip|disabled)\b/],
  ['swift', 'swift', /\bthrow\s+XCTSkip\b|\bXCTSkip(?:If|Unless)\s*\(|@Test\s*\([^)]*\.disabled\b/],
  ['dart', 'dart', /\bskip\s*:\s*(?:true|['"])/],
]);

/** Test-case declarations: `name` is the group holding the case name, `lookahead` finds it on the next lines. */
export const TEST_CASE_LINE = catalog('case', { code: true }, [
  ['js', 'js', cat(/^\s*(?:it|test|specify|xit|xtest|fit|xspecify)(?:\.\w+(?:\((?:[^()]|\([^()]*\))*\)|`[^`]*`)?)*/,
    /\s*\(\s*(?:(['"`])((?:\\.|(?!\1).)*)\1)?/), { name: 2 }],
  ['py', 'py', /^\s*(?:async\s+)?def\s+(test\w*)\s*\(/, { name: 1 }],
  ['go', 'go', /^func\s+((?:Test|Fuzz|Example)\w*)\s*\(/, { name: 1 }],
  ['go-subtest', 'go', /\bt\.Run\s*\(\s*"((?:\\.|[^"\\])*)"/, { name: 1 }],
  ['rs', 'rs', /^\s*#\[(?:[\w]+::)?(?:test|rstest|test_case|quickcheck|proptest)\b[^\]]*\]/,
    { lookahead: /\bfn\s+(\w+)/ }],
  ['jvm', 'jvm', cat(/@/, group(/Test|ParameterizedTest|RepeatedTest|TestFactory|TestTemplate|Property/,
    /RetryingTest|RepeatedIfExceptionsTest|CartesianTest/), /\b/),
  { lookahead: /\b(?:void|fun|def)\s+`?([^`(\s]+(?: [^`(]+)*)`?\s*\(/ }],
  ['cs', 'cs', cat(/\[\s*(?:\w+\s*,\s*)*/, group(/Fact|Theory|Test|TestMethod|TestCase|DataTestMethod/,
    /SkippableFact|SkippableTheory|RetryFact|RetryTheory/), /\b/), { lookahead: /\b(?:void|Task|ValueTask)\s+(\w+)\s*\(/ }],
  ['rb', 'rb', /^\s*(?:[xf]?(?:it|specify|example|scenario)|test)\b\s*\(?\s*(?:(['"])((?:\\.|(?!\1).)*)\1)?/, { name: 2 }],
  ['rb-minitest', 'rb', /^\s*def\s+(test_\w+)/, { name: 1 }],
  ['php', 'php', /\bfunction\s+(test\w+)\s*\(/, { name: 1 }],
  ['php-pest', 'php', /^\s*(?:it|test)\s*\(\s*(['"])((?:\\.|(?!\1).)*)\1/, { name: 2 }],
  ['swift', 'swift', /\bfunc\s+(test\w+)\s*\(/, { name: 1 }],
  ['swift-testing', 'swift', /^\s*@Test\b/, { lookahead: /\bfunc\s+(\w+)/ }],
  ['dart', 'dart', /^\s*(?:test|testWidgets)\s*\(\s*(['"])((?:\\.|(?!\1).)*)\1/, { name: 2 }],
]);

/** Lines that assert something (counted once per line). */
export const ASSERTION_LINE = catalog('assert', { code: true }, [
  ['js', 'js', alt(/\bexpect(?:TypeOf)?\s*\(|\bassert(?:\.\w+)?\s*\(|\.should\b/, cat(/\bt\./,
    group(/is|not|deepEqual|notDeepEqual|true|false|truthy|falsy|throws|throwsAsync|notThrows|regex|snapshot/,
      /assert|like|equal|same|ok|match/), /\s*\(/))],
  ['py', 'py', alt(/^\s*assert\b|\bself\.assert\w+\s*\(|\bpytest\.(?:raises|warns|approx)\s*\(/,
    /\.assert_\w+\s*\(|\bnp\.testing\.assert_\w+\(/)],
  ['go', 'go', alt(/\b[tbf]\.(?:Error|Errorf|Fatal|Fatalf|Fail|FailNow)\s*\(|\b(?:assert|require)\.\w+\s*\(/,
    /\bExpect\s*\(|\bgomega\.\w+\(/)],
  ['rs', 'rs', alt(cat(/\b/, group(/assert|assert_eq|assert_ne|debug_assert|debug_assert_eq|debug_assert_ne/,
    /assert_matches|prop_assert|prop_assert_eq|prop_assert_ne/), /!\s*\(/), /#\[should_panic\b/)],
  ['jvm', 'jvm', /\bassert\w*\s*\(|\bAssertions\.\w+\s*\(|\bverify\s*\(|\bshould(?:Be|Equal|Throw)\w*\b|\bexpect\s*\(/],
  ['cs', 'cs', /\b(?:Assert|CollectionAssert|StringAssert|ClassicAssert)\.\w+\s*\(|\.Should\s*\(\s*\)|\.Verify\s*\(/],
  ['rb', 'rb', alt(/\bexpect\s*[({]|\.(?:should|must_\w+|wont_\w+)\b|\bassert(?:_\w+)?\b/,
    /\brefute(?:_\w+)?\b|\bis_expected\b/)],
  ['php', 'php', /\$this->assert\w+\s*\(|\bself::assert\w+\s*\(|\bstatic::assert\w+\s*\(|\bexpect\s*\(/],
  ['swift', 'swift', /\bXCTAssert\w*\s*\(|\bXCTFail\s*\(|#(?:expect|require)\s*\(/],
  ['dart', 'dart', /\bexpect(?:Later)?\s*\(/],
]);

/** Assertions that only check truthiness or existence (a "downgrade" when they replace stronger ones). */
export const WEAK_ASSERTIONS = catalog('weak', { code: true }, [
  ['js', 'js', alt(/\.(?:toBeTruthy|toBeDefined|toBeFalsy)\s*\(\s*\)|\.not\.(?:toBeNull|toBeUndefined|toThrow)\s*\(\s*\)/,
    /\bexpect\.anything\s*\(|\.toHaveBeenCalled\s*\(\s*\)|\bassert(?:\.ok)?\s*\(\s*[\w$.]+\s*\)\s*;?\s*$/)],
  ['py', 'py', alt(/^\s*assert\s+(?:not\s+)?[\w.]+(?:\(\))?\s*$|^\s*assert\s+[\w.]+\s+is\s+not\s+None\s*$/,
    /\bself\.assert(?:True|IsNotNone|False|IsNone)\s*\(\s*[\w.]+\s*\)/)],
  ['jvm', 'jvm', /\bassert(?:NotNull|True|False)\s*\(\s*[\w.]+\s*\)/],
  ['cs', 'cs', /\bAssert\.(?:IsNotNull|NotNull|IsTrue|True|IsFalse|False)\s*\(\s*[\w.]+\s*\)/],
  ['rs', 'rs', /\bassert!\s*\(\s*[\w.]+(?:\.is_(?:ok|some|err|none)\(\))?\s*\)/],
  ['rb', 'rb', /\bbe_truthy\b|\bbe_present\b|\bnot_to\s+be_nil\b|\bassert\s+[\w.]+\s*$/],
  ['go', 'go', /\b(?:assert|require)\.(?:NotNil|True|NoError)\s*\(\s*t\s*,\s*[\w.]+\s*\)/],
]);

/** Assertions that can never fail. */
export const TAUTOLOGIES = catalog('tautology', { code: true }, [
  ['js', 'js', alt(
    /\bexpect\s*\(\s*(true|false|null|\d+|'[^']*'|"[^"]*")\s*\)\s*\.(?:toBe|toEqual|toStrictEqual)\s*\(\s*\1\s*\)/,
    /\bexpect\s*\(\s*true\s*\)\s*\.toBeTruthy\s*\(\s*\)|\bassert(?:\.ok)?\s*\(\s*true\s*\)/), B],
  ['py', 'py', alt(/^\s*assert\s+(?:True|1|(\d+)\s*==\s*\1)\s*$|\bself\.assertTrue\s*\(\s*True\s*\)/,
    /\bself\.assertEqual\s*\(\s*(\d+|True)\s*,\s*\2\s*\)/)],
  ['rs', 'rs', /\bassert!\s*\(\s*true\s*\)|\bassert_eq!\s*\(\s*(\d+|true)\s*,\s*\1\s*\)/],
  ['jvm', 'jvm cs', alt(/\bassert(?:True|That)\s*\(\s*true\s*\)|\bAssert\.(?:IsTrue|True)\s*\(\s*true\s*\)/,
    /\bassertEquals\s*\(\s*(\d+)\s*,\s*\1\s*\)/)],
  ['go', 'go', /\bif\s+false\s*\{\s*t\.(?:Error|Fatal)/],
]);

/** Error handling that hides assertion failures inside tests (reported under CK-ASSERT). */
export const ASSERTION_SWALLOW = catalog('assert-swallow', { code: true }, [
  ['py', 'py', /\bexcept\s+(?:\(?[\w., ]*\bAssertionError\b[\w., ]*\)?)(?:\s+as\s+\w+)?\s*:/],
  ['js', 'js jvm cs',
    /\bcatch\s*\(\s*(?:\w+\s*:\s*)?(?:AssertionError|AssertionFailedError|JestAssertionError|AssertFailedException)\b/],
  ['rb', 'rb', /\brescue\s+(?:RSpec::Expectations::ExpectationNotMetError|Minitest::Assertion)\b/],
]);

/** Inline directives that make a secret scanner skip a line (gitleaks, trufflehog, detect-secrets). */
export const SECRET_ALLOW = /\bgitleaks:allow\b|\btrufflehog:ignore\b|\bpragma:\s*allowlist\s+secret\b/;

/** Lint and type suppression directives (FM-05); matched on raw text because they live in comments. */
export const SUPPRESSIONS = catalog('suppress', {}, [
  ['eslint-file', 'js', /\/\*\s*eslint-disable(?![-\w])/, { scope: 'file' }],
  ['eslint', 'js', /\beslint-disable-(?:next-)?line\b/],
  ['eslint-rule-comment', 'js', /\/\*\s*eslint\s+[@\w/-]+\s*:\s*(?:0|["']?off["']?)\b/, { scope: 'file' }],
  ['ts-nocheck', 'js', /@ts-nocheck\b/, { scope: 'file' }],
  ['ts-ignore', 'js', /@ts-(?:ignore|expect-error)\b/],
  ['biome', 'js', /\bbiome-ignore(?:-all|-start)?\b/],
  ['oxlint', 'js', /\boxlint-disable(?:-next-line|-line)?\b/],
  ['deno', 'js', /\bdeno-lint-ignore(?:-file)?\b/],
  ['js-coverage', 'js', /\/\*\s*(?:istanbul|c8|v8|node:coverage)\s+(?:ignore|disable)\b/],
  ['py-type-ignore', 'py', /#\s*type:\s*ignore\b/],
  ['py-pyright', 'py', /#\s*pyright:\s*(?:ignore\b|basic\b|strict\s*=\s*false)/],
  ['py-file-noqa', 'py', /#\s*(?:ruff|flake8)\s*:\s*noqa\b/i, { scope: 'file' }],
  ['py-noqa', 'py', /#\s*noqa\b/i],
  ['py-mypy-file', 'py', /#\s*mypy\s*:\s*(?:ignore-errors|disable-error-code)\b/, { scope: 'file' }],
  ['py-pylint', 'py', /#\s*pylint\s*:\s*disable(?:-next)?\s*=/],
  ['py-nosec', 'py', /#\s*nosec\b/],
  ['py-coverage', 'py', /#\s*pragma:\s*no\s*(?:cover|branch)\b/],
  ['go', 'go', /\/\/\s*nolint\b|\/\/\s*lint:(?:ignore|file-ignore)\b|\/\/\s*#?nosec\b/],
  ['rs-crate', 'rs', /#!\[allow\s*\(/, { scope: 'file' }],
  ['rs', 'rs', /#\[allow\s*\(/],
  ['cs', 'cs', /#pragma\s+warning\s+disable\b|\[(?:assembly:\s*)?SuppressMessage\s*\(|\/\/\s*ReSharper\s+disable\b/],
  ['jvm', 'jvm', /@Suppress(?:Warnings|FBWarnings|Lint)?\s*\(|\/\/\s*CHECKSTYLE:OFF\b|\/\/\s*NOPMD\b/],
  ['rb', 'rb', /#\s*rubocop\s*:\s*(?:disable|todo)\b|#\s*standard\s*:\s*disable\b|#\s*:nocov:/],
  ['php', 'php', alt(/@phpstan-ignore(?:-line|-next-line)?\b|@psalm-suppress\b/,
    /@codingStandardsIgnore\w*|\bphpcs:(?:ignore|disable)\b/)],
  ['swift', 'swift', /\/\/\s*swiftlint:disable\b/],
  ['c', 'c', /\/\/\s*NOLINT(?:NEXTLINE|BEGIN)?\b|#pragma\s+(?:GCC|clang)\s+diagnostic\s+ignored\b/],
  ['sh', 'sh', /#\s*shellcheck\s+disable=/],
  ['sonar', '', /\bNOSONAR\b/],
  // Lines behind an allow directive are hidden from the scanners that honor it; diff-scope still
  // scans them with the built-in patterns.
  ['secret-allow', '', SECRET_ALLOW],
]);

const TS_STRICT = /strict\w*|noImplicit\w+|noUnused\w+|noFallthroughCasesInSwitch|exactOptionalPropertyTypes|checkJs/;

/**
 * Lint/type configuration that turns a rule or check off (applied to lint-config files and the
 * lint sections of pyproject.toml, setup.cfg, package.json, Cargo.toml, MSBuild props).
 */
export const LINT_CONFIG_WEAKENING = catalog('lintcfg', {}, [
  ['rule-off', '', cat(/^\s*["']?/,
    /(?![\w@/-]*(?:max|min|warnings|width|version|depth|size|limit|timeout|ecma|indent|tab|level|line)[\w-]*["']?\s*[:=])/,
    /(?:@?[\w-]+\/)*[\w-]+["']?\s*[:=]\s*(?:["']off["']|0(?![\d.])|\[\s*(?:["']off["']|0(?![\d.])))/)],
  ['rule-allow', '', /^\s*["']?[\w:-]+["']?\s*=\s*(?:["']allow["']|\{\s*level\s*=\s*["']allow["'])/],
  ['ts-strict-off', '', cat(/["']/, group(TS_STRICT, /alwaysStrict|useUnknownInCatchVariables/),
    /["']\s*:\s*false\b/)],
  ['mypy-off', '', alt(
    cat(/^\s*(?:ignore_errors|ignore_missing_imports|allow_untyped_defs|allow_untyped_calls|allow_any_generics)/,
      /\s*=\s*(?:true|True)\b/),
    cat(/^\s*(?:strict|check_untyped_defs|disallow_untyped_defs|warn_unused_ignores|warn_return_any|strict_optional)/,
      /\s*=\s*(?:false|False)\b/),
    /^\s*disable_error_code\s*=/)],
  ['ignore-list', '', cat(/^\s*["']?/, group(/ignore|ignores|ignorePatterns|extend-ignore|extend_ignore|disable/,
    /disabled|per-file-ignores|per_file_ignores|extend-per-file-ignores|unfixable|exclude_rules|skip|globalIgnores/,
    /exclude|extend-exclude|extend_exclude|skip-dirs|skip-files|exclude-dirs|exclude-files/), /["']?\s*[:=]/)],
  ['disable-all', '', alt(/^\s*["']?(?:disable-all|disable_all)["']?\s*[:=]\s*true\b/,
    /^\s*["']?(?:recommended|all|enable-all)["']?\s*[:=]\s*false\b/)],
  ['severity-none', '', alt(/\bdotnet_diagnostic\.\w+\.severity\s*=\s*(?:none|silent|suggestion)\b/,
    /^\s*dotnet_analyzer_diagnostic\.[\w.]*severity\s*=\s*(?:none|silent)\b/)],
  ['msbuild-off', '', /<NoWarn>|<TreatWarningsAsErrors>\s*false\s*</i],
  ['msbuild-analyzers-off', '',
    /<(?:RunAnalyzers|RunAnalyzersDuringBuild|EnableNETAnalyzers|EnforceCodeStyleInBuild)>\s*false\s*</i],
  ['msbuild-nullable-off', '', /<Nullable>\s*disable\s*</i],
  ['rubocop-off', '', /^\s*Enabled\s*:\s*false\b/],
]);

/**
 * Lint/type settings that turn a check on: removing one (without adding it back anywhere in the
 * change) falls back to the tool's laxer default, the same as turning the check off.
 */
export const STRICTNESS_ON = catalog('strict', {}, [
  ['ts', '', cat(/["']/, group(TS_STRICT, /alwaysStrict|useUnknownInCatchVariables|noUncheckedIndexedAccess/,
    /noPropertyAccessFromIndexSignature/), /["']\s*:\s*true\b/)],
  ['mypy', '', cat(/^\s*/, group(/strict|check_untyped_defs|disallow_\w+|warn_unused_ignores|warn_return_any/,
    /warn_redundant_casts|strict_optional|no_implicit_optional|strict_equality/), /\s*=\s*(?:true|True)\b/)],
  ['pyright', '', /["']?typeCheckingMode["']?\s*[:=]\s*["']strict["']/],
  ['msbuild', '', alt(
    /<(?:TreatWarningsAsErrors|EnforceCodeStyleInBuild|RunAnalyzers|RunAnalyzersDuringBuild|EnableNETAnalyzers)>\s*true\s*</i,
    /<Nullable>\s*enable\s*<|<WarningsAsErrors>[^<]+</)],
  ['all', '', /^\s*["']?(?:enable-all|enable_all)["']?\s*[:=]\s*true\b/],
]);

/** Keys whose list items enable rules or linters (an item removed from them turns a check off). */
export const LINT_ENABLE_KEYS = /^(?:select|extend-select|extend_select|enable|enabled|presets|extends)$/i;

/** Keys whose list items are exclusions (an added item under them turns a check off or narrows it). */
export const LINT_EXCLUSION_KEYS = names(/ignore|ignores|ignorePatterns|extend-ignore|extend_ignore|exclude|extend-exclude/i,
  /extend_exclude|per-file-ignores|per_file_ignores|disable|disabled|skip-dirs|skip-files|skip_dirs|skip_files/,
  /exclude-dirs|exclude-files|exclude_dirs|exclude_files|exclude_rules|unfixable|globalIgnores/);

// A handler body that re-raises, fails, exits or reports at error level is not a swallow.
const HANDLED = alt(/\b(?:raise|throw|rethrow|panic|abort|exit|fail|Fail)\b/, cat(/\b/,
  group(/log|logger|logging|LOG|_log|_logger|Log|Logger|console|self\.log|self\.logger|this\.log|this\.logger/),
  /\s*\.\s*(?:error|exception|critical|fatal|severe|LogError|LogCritical|Error|Fatal)\b/),
/\bprintStackTrace\b|\breport\w*\(|\bcapture_?[Ee]xception\b/);
const BRACES = 'js jvm cs php swift c dart';

/** Error handling that swallows failures (FM-07); non-test files (in tests they are CK-ASSERT). */
export const SWALLOW_PATTERNS = catalog('swallow', { code: true }, [
  ['empty-catch', BRACES, /\bcatch\s*(?:\([^)]*\))?\s*\{\s*\}/],
  ['empty-catch', BRACES, /\bcatch\s*(?:\([^)]*\))?\s*\{\s*$/, { next: /^\s*\}/ }],
  ['promise-catch', 'js', cat(/\.catch\s*\(\s*/, group(cat(/(?:async\s*)?(?:\(\s*[\w$]*\s*\)|[\w$]+)\s*=>\s*/,
    /(?:\{\s*\}|null|undefined|void\s+0|false|\[\s*\]|\{\s*\}\s*\))/), /noop|_\.noop|lodash\.noop/), /\s*\)/)],
  ['py-except-pass', 'py', /^\s*except\b[^:]*:\s*(?:pass|\.\.\.|continue)\s*$/],
  ['py-except-pass', 'py', /^\s*except\b[^:]*:\s*$/, { next: /^\s*(?:pass|\.\.\.|continue)\s*$/ }],
  ['py-bare-except', 'py', /^\s*except\s*:/],
  ['py-suppress', 'py', /\b(?:contextlib\.)?suppress\s*\(\s*(?:Exception|BaseException)\s*\)/],
  ['go-blank-error', 'go', /^\s*_\s*(?:,\s*_\s*)?=\s*[\w.]+\s*\(/],
  ['go-empty-err', 'go', /\bif\b[^{]*\berr\s*!=\s*nil\s*\{\s*\}/],
  ['go-empty-err', 'go', /\bif\b[^{]*\berr\s*!=\s*nil\s*\{\s*$/, { next: /^\s*\}/ }],
  ['go-err-return-nil', 'go', /\bif\b[^{]*\berr\s*!=\s*nil\s*\{\s*return\s+nil\s*\}/],
  ['rs', 'rs', /\bErr\s*\(\s*_\w*\s*\)\s*=>\s*(?:\{\s*\}|\(\s*\))|\.ok\s*\(\s*\)\s*;\s*$/],
  ['rb', 'rb', /\brescue\s+nil\b|\brescue\s*(?:Exception|StandardError)?\s*(?:=>\s*\w+)?\s*;\s*(?:nil\s*;\s*)?end\b/],
  ['rb', 'rb', /^\s*rescue\b[^;]*$/, { next: /^\s*end\b/ }],
  // Broad handlers whose body neither re-raises nor reports at error level (plan Appendix A FM-07).
  ['py-broad-except', 'py', /^\s*except\s*\(?\s*(?:Exception|BaseException)\s*\)?(?:\s+as\s+\w+)?\s*:/,
    { bodyNot: HANDLED }],
  ['broad-catch', 'jvm',
    /\bcatch\s*\(\s*(?:final\s+)?(?:java\.lang\.)?(?:Exception|Throwable|RuntimeException)\s+\w+\s*\)\s*\{/, { bodyNot: HANDLED }],
  ['broad-catch', 'cs', /\bcatch\s*(?:\(\s*(?:System\.)?Exception(?:\s+\w+)?\s*\))?\s*\{/, { bodyNot: HANDLED }],
]);

/** Logging calls with their level (used to detect error -> warning downgrades). */
export const LOG_CALL = alt(cat(
  /\b(?:console|logger|log|logging|LOG|Log|slog|zap|logrus|Logger|_logger|_log|this\.(?:logger|log)|self\.(?:logger|log))/,
  /\s*\.\s*/, capture(/error|err|fatal|critical|exception|warn|warning|info|debug|trace|Error|Errorf|Fatal|Fatalf|Warn|Warnf/,
    /Warning|Info|Infof|Debug|Debugf|LogError|LogCritical|LogWarning|LogInformation|LogDebug/), /\s*\(/),
/\b(error|warn|info|debug|trace)!\s*\(/);
export const THROW_LINE = /\bthrow\b|^\s*raise\b|\bpanic!?\s*\(|\breturn\s+(?:nil\s*,\s*)?(?:err\b|fmt\.Errorf\b|errors\.)|\bErr\s*\(/;
export const LOG_LEVEL_RANK = Object.freeze({
  fatal: 3, critical: 3, error: 3, err: 3, exception: 3, warn: 2, warning: 2, info: 1, information: 1, debug: 0, trace: 0,
});

/** CI edits that turn a failing step green (FM-06); applied to added lines of CI files. */
export const CI_WEAKENING = catalog('ci', {}, [
  ['continue-on-error', '', /\bcontinue-on-error\s*:\s*(?:true\b|["']?\$\{\{)/],
  ['allow-failure', '', /\ballow_failure\s*:\s*(?:true\b|\{)|\bcontinueOnError\s*:\s*true\b|\bignore_failure\s*:\s*true\b/],
  ['or-true', '', /\|\|\s*(?:true\b|:\s*(?:$|[;)&|])|exit\s+0\b|echo\b)|;\s*(?:true|exit\s+0)\s*["']?\s*$/],
  ['pass-with-no-tests', '', /--pass(?:WithNoTests|-with-no-tests)\b|--allow-no-tests\b|--no-tests[= ](?:pass|warn)\b/],
  ['set-plus-e', '', /^\s*(?:-\s*)?set\s+\+e\b|\$ErrorActionPreference\s*=\s*['"]?(?:SilentlyContinue|Continue)\b/],
  ['if-false', '', /^\s*(?:-\s*)?if\s*:\s*(?:false|["']?\$\{\{\s*false\s*\}\}["']?|0)\s*$/],
  ['skip-tests', '', alt(/-DskipTests\b|-Dmaven\.test\.skip=true\b|--skip-tests?\b|(?:^|\s)-x\s+(?::?\w+:)?test\b/,
    /--exclude-task\s+test\b|\bSKIP_TESTS\s*[:=]\s*['"]?(?:1|true)\b/)],
  ['ignore-test-failures', '', alt(/-Dmaven\.test\.failure\.ignore=true\b|\btestFailureIgnore\b|\bignoreFailures\s*=\s*true\b/,
    /--exit-zero\b|--no-fail(?:-on-\w+)?\b|--fail-on-flaky-tests\s*=\s*false/)],
  ['fail-off', '', alt(/\bfail_ci_if_error\s*:\s*false\b|\bfail-on-error\s*:\s*false\b|\bfail_on_failure\s*:\s*false\b/,
    /\bfail-on-severity\s*:\s*(?:none|never)\b|\bfailOnStderr\s*:\s*false\b/)],
  ['paths-ignore', '', /^\s*paths-ignore\s*:/, { severity: 'finding' }],
]);

/** Coverage/quality thresholds with a numeric value; a lower number in the head is a weakening. */
export const THRESHOLD = cat(capture(/--(?:cov-)?fail-under[= ]|\bfail_under\s*[=:]\s*/,
  /--(?:break-at|threshold|min-coverage|minimum-coverage|coverage-threshold)[= ]/,
  /\b(?:minimum_coverage|branches|functions|lines|statements|mutationThreshold|break)\s*[:=]\s*|\btarget\s*:\s*/),
/["']?(\d+(?:\.\d+)?)%?/);

/** In-source retries added to tests (FM-13, CK-RETRY). */
export const IN_SOURCE_RETRIES = catalog('retry', { code: true }, [
  ['jest', 'js', /\bjest\.retryTimes\s*\(/, B],
  ['mocha', 'js', /\bthis\.retries\s*\(\s*[1-9]/, B],
  ['playwright', 'js', /\.describe\.configure\s*\(\s*\{[^}]*\bretries\s*:\s*[1-9]/, B],
  ['js-options', 'js', cat(/\b(?:it|test|describe)(?:\.(?:only|skip|concurrent|sequential))*\s*\(\s*(['"`])(?:(?!\1).)*\1/,
    /\s*,\s*\{[^}]*\bretr(?:y|ies)\s*:\s*(?:\{|[1-9])/), B],
  ['py', 'py', /@pytest\.mark\.flaky\b|@flaky\b|\bpytest\.mark\.flaky\b|@(?:pytest\.mark\.)?retry\b/],
  ['jvm', 'jvm', /@(?:RetryingTest|Retry|RepeatedIfExceptionsTest|Flaky)\b|\bretryAnalyzer\s*=/],
  ['cs', 'cs', /\[\s*(?:\w+\s*,\s*)*(?:Retry|RetryFact|RetryTheory)\b/],
  ['rb', 'rb', /\bretry:\s*[1-9]|:retry\s*=>\s*[1-9]|\brun_with_retry\b/],
  ['rs', 'rs', /#\[(?:retry|flaky)\b/],
]);

// ---------------------------------------------------------------------------
// Secrets (FM-09): the built-in scanner when gitleaks/trufflehog are absent (decision D7).
// Severity 'fail' for high-confidence token shapes, 'finding' for heuristics.

const NOT_A_VALUE = /(?![[<{$%]|process\.|os\.|env\.|getenv)/;

export const SECRET_PATTERNS = catalog('secret', { severity: 'fail' }, [
  ['aws-access-key-id', '', /\b((?:AKIA|ASIA|ABIA|ACCA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[A-Z2-7]{16})\b/],
  ['aws-secret-key', '', cat(/aws_?secret_?(?:access_?)?key\w*["']?\s*[:=]\s*/i, /["']?([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/)],
  ['github-token', '', /\b(gh[pousr]_[A-Za-z0-9]{36,255})\b/],
  ['github-fine-grained', '', /\b(github_pat_[A-Za-z0-9_]{60,255})\b/],
  ['gitlab-token', '', /\b(gl(?:pat|dt|rt|ptt|cbt)-[A-Za-z0-9_-]{20,})\b/],
  ['slack-token', '', /\b(xox[abposr]-[A-Za-z0-9-]{10,})\b/],
  ['slack-webhook', '', /(https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]{6,}\/B[A-Z0-9]{6,}\/[A-Za-z0-9]{16,})/],
  ['stripe-key', '', /\b((?:sk|rk)_live_[A-Za-z0-9]{20,})\b/],
  ['stripe-test-key', '', /\b((?:sk|rk)_test_[A-Za-z0-9]{20,})\b/, { severity: 'finding' }],
  ['google-api-key', '', /\b(AIza[0-9A-Za-z_-]{35})(?![0-9A-Za-z_-])/],
  ['openai-key', '', /\b(sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{16,}T3BlbkFJ[A-Za-z0-9_-]{16,})\b/],
  ['anthropic-key', '', /\b(sk-ant-(?:api|admin|oat)\d{2}-[A-Za-z0-9_-]{60,})\b/],
  ['npm-token', '', /\b(npm_[A-Za-z0-9]{36})\b/],
  ['pypi-token', '', /\b(pypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{50,})\b/],
  ['sendgrid-key', '', /\b(SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43})\b/],
  ['twilio-key', '', /\b(SK[0-9a-f]{32})\b/, { severity: 'finding' }],
  ['azure-storage-key', '', /AccountKey=([A-Za-z0-9+/]{86}==)/],
  ['private-key', '', /(-{5}BEGIN[ A-Z0-9_-]{0,40}PRIVATE KEY(?: BLOCK)?-{5})/],
  ['jwt', '', /\b(eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/, { severity: 'finding' }],
  ['url-credentials', '', /\b[a-z][a-z0-9+.-]{1,20}:\/\/([^/\s:@'"`]{2,64}:[^/\s:@'"`]{6,128})@([^\s/'"`]+)/,
    { severity: 'finding' }],
  // A value is quoted, or unquoted and last on its line (dotenv, YAML, shell): code such as
  // `{ ADC_LIVE_TOKEN: token }` and placeholders such as `[REDACTED]`, `<token>`, `${VAR}` or
  // `process.env.X` are not values.
  ['adc-live-token', '', cat(/\bADC_LIVE_TOKEN\s*[:=]\s*/, group(cat(/["']/, NOT_A_VALUE, /([^\s"'`;,()]{6,})["']/),
    cat(/(?![[<{$%"']|process\.|os\.|env\.|getenv)/, /([^\s"'`;,()]{6,})(?=\s*(?:#.*)?$)/)))],
  ['generic-assignment', '', cat(/\b/i, group(/api[_-]?key|apikey|secret(?:[_-]?key)?|client[_-]?secret|access[_-]?token/,
    /auth[_-]?token|private[_-]?key|passw(?:or)?d|pwd/), /\b["']?\s*[:=]\s*["']([^"'\s]{12,200})["']/),
  { severity: 'finding', generic: true }],
]);

const SECRET_GLOBAL = SECRET_PATTERNS.map((p) => ({ ...p, g: new RegExp(p.re.source, `${p.re.flags}g`) }));
const PLACEHOLDER = names(/x+|\*+|\.+|<[^>]*>|\$\{[^}]*\}|\{\{[^}]*\}\}|%\(?\w+\)?s?|changeme|change_me|replace_?me|your[_-]?\w*/i,
  /example\w*|dummy\w*|fake\w*|test\w*|sample\w*|placeholder\w*|redacted\w*|none|null|undefined|todo\w*|secret|password\w*/);
const ENV_REFERENCE = /process\.env|os\.environ|getenv|System\.getenv|Environment\.GetEnvironmentVariable|ENV\[|\$\{\{\s*secrets\./;
const RESERVED_HOST = /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|db|postgres|mysql|redis|mongo)$/i;

function entropy(s) {
  const counts = new Map();
  for (const c of s) counts.set(c, (counts.get(c) || 0) + 1);
  let h = 0;
  for (const n of counts.values()) h -= (n / s.length) * Math.log2(n / s.length);
  return h;
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
  // RFC 2606 / 6761 names never resolve to a real service: documentation and test fixtures.
  if (RESERVED_HOST.test(h) || /(?:^|\.)(?:example\.(?:com|net|org)|example|test|invalid|localhost)$/i.test(h)) return false;
  return pass !== user;
}

/** Secret values on one line: [{ id, severity, value }]; a specific rule wins over the generic one. */
function secretHits(line) {
  if (!line || line.length > 20_000) return [];
  const hits = [];
  for (const p of SECRET_GLOBAL) {
    for (const m of line.matchAll(p.g)) {
      const value = m[1] || m[2] || m[0];
      if (p.generic ? !plausibleGeneric(value, line) : p.id === 'secret.url-credentials' && !plausibleUrlCredential(m[1], m[2])) {
        continue;
      }
      hits.push({ id: p.id, severity: p.severity, value });
    }
  }
  const specific = hits.filter((h) => !h.id.startsWith('secret.generic')).map((h) => h.value);
  return hits.filter((h) => !h.id.startsWith('secret.generic') || !specific.some((v) => v.includes(h.value) || h.value.includes(v)));
}

/** A secret masked for messages: a short prefix (long values only) for recognizability, never the value. */
const maskSecret = (v) => `${v.length >= 16 ? v.slice(0, 4) : ''}...[REDACTED]`;
const maskValues = (line, hits) => [...hits].sort((a, b) => b.value.length - a.value.length)
  .reduce((out, h) => out.split(h.value).join(maskSecret(h.value)), line);

/** `text` with every detected secret value masked in place (for messages and excerpts). */
export function redactSecrets(text) {
  if (text == null) return text;
  return String(text).split(/(\r?\n)/).map((part) => maskValues(part, secretHits(part))).join('');
}

/** Built-in secret scan: [{ id, line, severity, redacted }] with every value on the line masked; never the value. */
export function scanSecrets(text) {
  const out = [];
  String(text ?? '').split(/\r?\n/).forEach((line, i) => {
    const hits = secretHits(line);
    if (!hits.length) return;
    const redacted = maskValues(line, hits).trim().slice(0, 300);
    const seen = new Set();
    for (const h of hits) {
      if (seen.has(`${h.id}:${h.value}`)) continue;
      seen.add(`${h.id}:${h.value}`);
      out.push({ id: h.id, line: i + 1, severity: h.severity, redacted });
    }
  });
  return out;
}

/** Credential-like file names (an added file is a finding even before its content is scanned). */
export function credentialFileName(file) {
  const base = baseOf(toPosix(file)).toLowerCase();
  if (/^\.env(?:\..+)?$/.test(base) && !/\.(?:example|sample|template|dist|defaults?)$/.test(base)) return 'dotenv';
  if (/^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)$/.test(base)) return 'ssh-key';
  if (/\.(?:pem|p12|pfx|key|keystore|jks|ppk|asc)$/.test(base) && !/\.pub(?:lic)?\./.test(base)) return 'key-file';
  if (/^(?:credentials(?:\.json)?|\.pypirc|\.netrc|_netrc|\.git-credentials|service-account.*\.json)$/.test(base)) {
    return 'credentials';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Scanning

const masksCache = new WeakMap();

/**
 * Scan `text` (a string or an array of lines) with one catalog or an array of catalogs. Options:
 * `file` (selects the language, filters `langs` and enables comment masking), `lang`, `lines` (Set
 * of 1-based line numbers to report). Returns [{ id, line, text, match, kind?, severity?, scope? }];
 * `match` is the marker itself, which keys the ratchet.
 */
export function scanText(text, catalogs, opts = {}) {
  const list = Array.isArray(catalogs) && Array.isArray(catalogs[0]) ? catalogs.flat() : (catalogs || []);
  const lang = opts.lang || (opts.file ? langOf(opts.file) : null);
  const raw = Array.isArray(text) ? text : String(text ?? '').split(/\r?\n/);
  let masked = null;
  const getMasked = () => {
    if (masked) return masked;
    masked = !lang ? raw : masksCache.get(raw) || maskComments(raw, lang);
    if (lang && Array.isArray(text)) masksCache.set(raw, masked);
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
      const m = subject ? e.re.exec(subject) : null;
      if (!m || (e.blank && !e.re.test(code))) continue;
      if (e.next) {
        const lines = e.code ? getMasked() : raw;
        let j = i + 1;
        while (j < lines.length && !lines[j].trim()) j++;
        if (j >= lines.length || !e.next.test(lines[j])) continue;
      }
      if (e.bodyNot) {
        const block = handlerBody(getMasked(), i, lang);
        // Empty and `pass`-only bodies belong to the empty-handler entries, not to this one.
        if (!block || /^(?:\s|pass\b|\.\.\.|continue\b|;)*$/.test(block.body) || e.bodyNot.test(blankStrings(block.body))) continue;
      }
      seen.add(e.id);
      out.push({
        id: e.id, line: i + 1, text: raw[i].trim().slice(0, 240), match: code.slice(m.index, m.index + m[0].length),
        ...(e.kind ? { kind: e.kind } : {}), ...(e.severity ? { severity: e.severity } : {}), ...(e.scope ? { scope: e.scope } : {}),
      });
    }
  }
  return out;
}

const linesOf = (lines) => (Array.isArray(lines) ? lines : String(lines ?? '').split(/\r?\n/));
const FAILS_TEST = /\b(?:raise|throw|rethrow|fail|Fail|assert\w*|Assert|expect|done)\b|\$this->fail|\bpytest\.fail\b|\bself\.fail\b/;
const CS_ASSERT_CATCH = alt(/^(?:System\.)?Exception\b/,
  cat(/\b/, group(/AssertionException|XunitException|AssertFailedException|AssertActualExpectedException/), /\b/));
// Handler types that catch assertion failures, per language (JUnit/Kotest assertions throw Errors).
const CATCHES_ASSERTIONS = {
  py: (t) => !t || /\b(?:Exception|BaseException|AssertionError)\b/.test(t),
  js: () => true,
  dart: () => true,
  jvm: (t) => /\b(?:Throwable|Error|AssertionError|AssertionFailedError|ComparisonFailure|MultipleFailuresError)\b/.test(t),
  cs: (t) => !t || CS_ASSERT_CATCH.test(t.trim()),
  php: (t) => /\b(?:Exception|Throwable|AssertionFailedError|ExpectationFailedException)\b/.test(t),
};

/**
 * Assertions inside a try block whose handler catches assertion failures and neither re-raises nor
 * fails the test (plan Appendix A FM-01). Returns [{ id, line, text }] with the handler line (1-based).
 */
export function tryWrappedAssertions(lines, file) {
  const lang = langOf(file);
  const catches = CATCHES_ASSERTIONS[lang];
  if (!catches) return [];
  const raw = linesOf(lines);
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
      for (let j = body.end + 1; j < masked.length; j++) {
        const l = masked[j];
        if (!l.trim()) continue;
        if (indentOf(l) !== indentOf(masked[i]) || !/^\s*(?:except|else|finally)\b/.test(l)) break;
        const m = /^\s*except\b\s*([^:]*):/.exec(l);
        if (!m) continue;
        const handler = indentBlock(masked, j);
        if (catches(m[1].replace(/\s+as\s+\w+\s*$/, '').trim()) && !FAILS_TEST.test(blankStrings(handler.body))) hit(j);
        j = handler.end;
      }
      continue;
    }
    const at = blankStrings(masked[i]).search(/\btry\s*\{/);
    if (at === -1) continue;
    const tryBlock = braceBlock(masked, i, at);
    if (!tryBlock || !hasAssert(tryBlock.start, tryBlock.end)) continue;
    // The catch clause follows the closing brace, on the same line or the next non-blank one.
    let j = tryBlock.end;
    let rest = blankStrings(masked[j]).slice(tryBlock.endCol + 1);
    if (!rest.trim()) {
      do j++; while (j < masked.length && !masked[j].trim());
      rest = blankStrings(masked[j] || '');
    }
    const m = /^\s*catch\s*(?:\(([^)]*)\))?\s*\{/.exec(rest);
    if (!m) continue;
    const handler = braceBlock(masked, j, blankStrings(masked[j]).indexOf('catch'));
    if (handler && catches(String(m[1] || '').replace(/\s+\$?\w+\s*$/, '').trim()) && !FAILS_TEST.test(handler.body)) hit(j);
  }
  return out;
}

/** 1-based [start, end] line ranges of Rust `#[cfg(test)] mod ... { }` blocks. */
export function rustTestRanges(lines) {
  const masked = maskComments(linesOf(lines), 'rs');
  const out = [];
  for (let i = 0; i < masked.length; i++) {
    if (!/#\[cfg\(\s*test\s*\)\]/.test(masked[i])) continue;
    for (let j = i; j < Math.min(masked.length, i + 4); j++) {
      const at = masked[j].search(/\bmod\s+\w+\s*\{/);
      if (at === -1) {
        if (/\bmod\s+\w+\s*;/.test(masked[j])) break;
        continue;
      }
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
  const masked = maskComments(linesOf(lines), lang);
  const entries = TEST_CASE_LINE.filter((e) => e.langs.includes(lang));
  const out = [];
  for (let i = 0; i < masked.length; i++) {
    for (const e of entries) {
      const m = e.re.exec(masked[i]);
      if (!m) continue;
      let name = e.name ? (m[e.name] ?? null) : null;
      for (let j = i; !name && e.lookahead && j < Math.min(masked.length, i + 8); j++) {
        const n = e.lookahead.exec(masked[j]);
        if (n) name = n.slice(1).find(Boolean) || null;
      }
      out.push({ line: i + 1, name: name ? name.trim() : null, id: e.id });
      break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Path classification (heuristic; detect.mjs refines `test` with the runner's real globs)

const TEST_DIRS = new Set(words(`test tests __tests__ spec specs e2e integration-tests integration_tests functional-tests
  acceptance-tests __mocks__ cypress testing`));
const DATA_EXTS = new Set(words('json yaml yml txt csv xml html md snap golden toml ini cfg sql log png jpg gif svg')
  .map((e) => `.${e}`));

/** Runner naming convention a test file name follows ('js', 'pytest', 'go', 'jvm', ...), or null. */
export function testNaming(file) {
  const base = baseOf(toPosix(file));
  const lower = base.toLowerCase();
  if (/\.(?:test|spec|e2e|e2e-spec|cy|it|bench)\.[cm]?[jt]sx?$/.test(lower) || /\.(?:test|spec)\.(?:vue|svelte)$/.test(lower)) return 'js';
  if (/^test_.*\.py$|_test\.py$|^tests\.py$|^conftest\.py$/.test(lower)) return 'pytest';
  if (/_test\.go$/.test(lower)) return 'go';
  if (/_spec\.rb$|_test\.rb$|^test_.*\.rb$/.test(lower)) return 'ruby';
  if (/^Test[A-Z_]\w*\.(?:java|kt|groovy|scala)$|^\w+(?:Test|Tests|TestCase|IT|Spec|Suite)\.(?:java|kt|groovy|scala)$/.test(base)) {
    return 'jvm';
  }
  if (/^\w+(?:Tests?|Specs?|Fixture)\.(?:cs|fs|vb)$/.test(base)) return 'dotnet';
  if (/^\w+Test\.php$/.test(base)) return 'phpunit';
  if (/^\w+Tests?\.swift$/.test(base)) return 'xctest';
  if (/_test\.(?:exs|dart)$/.test(lower)) return 'other';
  if (/(?:_test|_unittest|_tests)\.(?:c|cc|cpp|cxx)$|^test_\w+\.(?:c|cc|cpp|cxx)$/.test(lower)) return 'c';
  return null;
}

const RUNNER_CONFIG_BASE = names(/jest\.config\.[cm]?[jt]s(?:on)?|vitest\.(?:config|workspace|projects)\.[cm]?[jt]s/,
  /vite\.config\.[cm]?[jt]s|playwright(?:-ct)?\.config\.[cm]?[jt]s|cypress\.config\.[cm]?[jt]s|cypress\.json/,
  /\.mocharc(?:\.[cm]?js|\.json|\.jsonc|\.ya?ml)?|karma\.conf\.[cm]?[jt]s|ava\.config\.[cm]?js|wdio\.conf\.[cm]?[jt]s/,
  /\.c8rc(?:\.json)?|\.nycrc(?:\.json|\.ya?ml)?|pytest\.ini|tox\.ini|setup\.cfg|pyproject\.toml|conftest\.py|noxfile\.py/,
  /\.coveragerc|nextest\.toml|cargo\.toml|.+\.runsettings|.+\.testsettings|directory\.build\.(?:props|targets)/,
  /.+\.(?:cs|fs|vb)proj|pom\.xml|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|\.rspec|\.simplecov|rakefile/,
  /phpunit\.xml(?:\.dist)?|makefile|gnumakefile|.+\.mk|justfile|\.justfile|taskfile\.ya?ml|package\.json/,
  /codecov\.ya?ml|\.codecov\.ya?ml|deno\.jsonc?/);
const LOCKFILE_BASE = names(/package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|poetry\.lock/,
  /uv\.lock|pipfile\.lock|pdm\.lock|go\.sum|cargo\.lock|packages\.lock\.json|gemfile\.lock|composer\.lock/,
  /gradle\.lockfile|package\.resolved|pubspec\.lock|mix\.lock|flake\.lock|deno\.lock/);
const MANIFEST_BASE = names(/package\.json|pyproject\.toml|setup\.py|setup\.cfg|requirements(?:[-_.][\w.-]+)?\.(?:txt|in)/,
  /constraints\.txt|pipfile|go\.mod|cargo\.toml|.+\.(?:cs|fs|vb)proj|directory\.packages\.props|packages\.config/,
  /pom\.xml|build\.gradle(?:\.kts)?|gemfile|.+\.gemspec|composer\.json|deno\.jsonc?|package\.swift|pubspec\.yaml|mix\.exs/);
const LINT_CONFIG_BASE = names(/\.eslintrc(?:\.[cm]?js|\.json|\.ya?ml)?|eslint\.config\.[cm]?[jt]s/,
  /\.(?:eslint|stylelint|markdownlint|semgrep|gitleaks)ignore|\.gitleaks\.toml|biome\.jsonc?|\.oxlintrc\.json/,
  /tsconfig(?:\.[\w-]+)?\.json|jsconfig\.json|\.flake8|ruff\.toml|\.ruff\.toml|mypy\.ini|\.mypy\.ini|pyrightconfig\.json/,
  /\.pylintrc|pylintrc|\.golangci\.(?:ya?ml|toml|json)|clippy\.toml|\.clippy\.toml|\.stylelintrc(?:\.\w+)?/,
  /\.markdownlint(?:\.\w+)?|\.yamllint(?:\.ya?ml)?|\.rubocop(?:_todo)?\.ya?ml|\.standard\.yml|phpstan\.neon(?:\.dist)?/,
  /psalm\.xml|\.?phpcs\.xml(?:\.dist)?|\.swiftlint\.ya?ml|detekt\.ya?ml|checkstyle[\w-]*\.xml|pmd[\w-]*\.xml/,
  /spotbugs[\w-]*\.xml|\.clang-tidy|\.editorconfig|\.globalconfig|.+\.ruleset|stylecop\.json|\.pre-commit-config\.ya?ml/,
  /\.deepsource\.toml|sonar-project\.properties/);
const CI_BASE = names(/\.gitlab-ci\.ya?ml|azure-pipelines(?:[\w.-]*)\.ya?ml|\.travis\.ya?ml|bitbucket-pipelines\.ya?ml/,
  /\.drone\.ya?ml|appveyor\.ya?ml|\.appveyor\.ya?ml|jenkinsfile|cloudbuild\.ya?ml|buildspec\.ya?ml|\.woodpecker\.ya?ml/);
const GENERATED_DIRS = new Set(words(`dist target node_modules vendor __generated__ generated .next .nuxt .svelte-kit coverage
  htmlcov __pycache__ site-packages .gradle obj .turbo .parcel-cache`));
const GENERATED_BASE = cat(group(/\.min\.(?:js|css|mjs)|\.(?:js|css)\.map|\.pb\.go|_pb2(?:_grpc)?\.pyi?|\.pb\.(?:cc|h)/,
  /\.g\.(?:dart|cs)|\.designer\.cs|\.generated\.\w+|_generated\.go|^zz_generated[\w.]*\.go|\.pyc/), /$/);

/** Heuristic, path-only classification: { test, runnerConfig, ci, lockfile, lintConfig, manifest, generated, testData, snapshot }. */
export function classifyPath(file) {
  const p = toPosix(file).replace(/^\.\//, '');
  const segs = p.split('/');
  const lower = segs[segs.length - 1].toLowerCase();
  const dirs = segs.slice(0, -1).map((d) => d.toLowerCase());
  const code = isCodeFile(p);
  const inTestDir = dirs.some((d) => TEST_DIRS.has(d) || /\.(?:unit|integration|functional)?tests?$/.test(d)) ||
    /src\/(?:test|androidtest)\//.test(p.toLowerCase());
  const snapshot = dirs.includes('__snapshots__') || /\.(?:snap|ambr|golden)$/.test(lower) ||
    /\.(?:approved|verified|received)\.\w+$/.test(lower) || (dirs.includes('snapshots') && /\.snap(?:\.new)?$/.test(lower));
  const yml = /\.ya?ml$/.test(lower);
  const ci = (dirs[0] === '.github' && dirs[1] === 'workflows' && yml) || (dirs[0] === '.github' && dirs[1] === 'actions' &&
    /^action\.ya?ml$/.test(lower)) || CI_BASE.test(lower) || (dirs[0] === '.circleci' && yml) ||
    (dirs[0] === '.gitlab' && yml && dirs.includes('ci')) || (['.azure-pipelines', '.buildkite', '.woodpecker'].includes(dirs[0]) && yml);
  const lockfile = LOCKFILE_BASE.test(lower);
  const parent = dirs[dirs.length - 1];
  return {
    test: code && (testNaming(p) != null || inTestDir) && !snapshot,
    runnerConfig: RUNNER_CONFIG_BASE.test(lower) || (parent === '.config' && lower === 'nextest.toml') ||
      (parent === '.cargo' && lower === 'config.toml'),
    ci,
    lockfile,
    lintConfig: LINT_CONFIG_BASE.test(lower),
    manifest: MANIFEST_BASE.test(lower),
    generated: !lockfile && (dirs.some((d) => GENERATED_DIRS.has(d)) || GENERATED_BASE.test(lower)),
    testData: !code && inTestDir && (DATA_EXTS.has(extOf(lower)) || snapshot),
    snapshot,
  };
}

/** Content header that marks a generated file. */
export const GENERATED_HEADER = group(/Code generated\b.*\bDO NOT EDIT|@generated\b|<auto-generated/i,
  /This file (?:is|was|has been) (?:automatically |auto-)?generated|\bAUTO-?GENERATED FILE\b|\bDO NOT EDIT\b.*\bgenerated\b/);

/** The header ci-gate writes into the workflows it generates (plan §10.5). */
export const CI_GATE_HEADER = /^#\s*generated by agentic-developer-companion ci-gate\b/m;

// ---------------------------------------------------------------------------
// Test files (shared by detect, diff-scope, probes, trace and the post-edit hook)

/** Globs for test files no detected project owns (and for projects that report none). */
export const DEFAULT_TEST_GLOBS = Object.freeze(['**/__tests__/**', '**/*.{test,spec}.*', '**/*_{test,spec}.*',
  '**/test_*.py', '**/conftest.py', '**/*_test.go', '**/*_spec.rb', 'test/**', 'tests/**', 'spec/**',
  '**/src/test/**', '**/*.cy.*', '**/*Tests/**', '**/*.Tests/**']);

const relOf = (file) => toPosix(String(file || '')).replace(/^(?:\.\/)+/, '').replace(/\/+$/, '');

/** The project owning a repo-relative file (or an absolute one under `detectResult.repo_root`): longest root wins. */
export function projectForFile(file, detectResult) {
  const projects = Array.isArray(detectResult?.projects) ? detectResult.projects : [];
  let rel = toPosix(String(file || ''));
  if (/^(?:\/|[A-Za-z]:\/)/.test(rel) && detectResult?.repo_root) {
    const base = toPosix(detectResult.repo_root).replace(/\/+$/, '');
    if (rel.startsWith(`${base}/`)) rel = rel.slice(base.length + 1);
  }
  rel = relOf(rel);
  let best = null;
  for (const p of projects) {
    const r = relOf(p?.root || '.') || '.';
    const root = r === '.' ? '' : r;
    if (root && rel !== root && !rel.startsWith(`${root}/`)) continue;
    if (!best || root.length > best.len) best = { p, len: root.length };
  }
  return best ? best.p : null;
}

/**
 * Is `file` a test file? Path heuristics (classifyPath) unless `heuristic: false`, then, with
 * `content`, a Rust file holding `#[cfg(test)]` / `#[test]`, then the owning project's test globs
 * (DEFAULT_TEST_GLOBS when no project owns it or it lists none; `codeOnly`: globs count only for
 * source files, so fixtures under tests/ stay data).
 */
export function isTestFile(file, detectResult = null, { content = null, heuristic = true, codeOnly = false } = {}) {
  const rel = relOf(file);
  if (!rel) return false;
  if (heuristic && classifyPath(rel).test) return true;
  if (content != null && /\.rs$/.test(rel) && /#\[(?:cfg\(test\)|test\])/.test(String(content))) return true;
  if (codeOnly && !isCodeFile(rel)) return false;
  const p = projectForFile(rel, detectResult);
  const root = p ? relOf(p.root || '.') : '';
  const sub = root && root !== '.' ? (rel === root ? '' : rel.slice(root.length + 1)) : rel;
  const own = Array.isArray(p?.test_globs) ? p.test_globs.filter((g) => typeof g === 'string') : [];
  return matchAny(sub, own.length ? own : DEFAULT_TEST_GLOBS);
}

/** Lockfile base name (lower case) → package manager. */
export const LOCKFILE_MANAGERS = Object.freeze({
  'package-lock.json': 'npm', 'npm-shrinkwrap.json': 'npm', 'pnpm-lock.yaml': 'pnpm', 'yarn.lock': 'yarn',
  'bun.lock': 'bun', 'bun.lockb': 'bun', 'uv.lock': 'uv', 'poetry.lock': 'poetry', 'pdm.lock': 'pdm',
  'pipfile.lock': 'pipenv', 'go.sum': 'go', 'cargo.lock': 'cargo', 'gemfile.lock': 'bundler',
  'composer.lock': 'composer', 'packages.lock.json': 'nuget', 'gradle.lockfile': 'gradle',
  'package.resolved': 'swiftpm', 'pubspec.lock': 'pub', 'mix.lock': 'mix', 'flake.lock': 'nix', 'deno.lock': 'deno',
});

// ---------------------------------------------------------------------------
// Redaction for output, logs and the ledger (finding excerpts use redactSecrets' masking instead)

const SECRET_NAME = /(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIALS?)/i;
// Credential-named assignments (`API_TOKEN=...`, `password: ...`) whose value has no known shape.
const NAMED_SECRET = cat(/\b/gi, capture(cat(/[A-Za-z_]*/, SECRET_NAME, /[A-Za-z0-9_]*/)),
  /(\s*[=:]\s*)(?!\$|\[REDACTED)(["']?)([^\s"']{4,})\3/);

/**
 * A sync redactor: the raw, URL-encoded and base64 forms of `literals` ([{name, value}]) and of
 * the live credentials in `env`, the ADC_LIVE_TOKEN shapes, then every SECRET_PATTERNS match
 * (the captured value, else the whole match) as `[REDACTED:<id>]`; `names` also blanks the values
 * of credential-named assignments. Unlike redactSecrets, no plausibility filter applies: output
 * redaction errs on the side of hiding.
 */
export function makeRedactor({ literals = [], env = process.env, names: byName = false } = {}) {
  const lits = [...literals.filter((l) => l && l.value && String(l.value).length >= 4), ...liveSecrets(env)];
  return (text) => {
    if (typeof text !== 'string' || !text) return text;
    let out = redactLiveToken(lits.length ? redactLiterals(text, lits) : text);
    for (const p of SECRET_GLOBAL) {
      const label = `[REDACTED:${p.id.replace(/^secret\./, '')}]`;
      out = out.replace(p.g, (m, g1, g2) => {
        const v = typeof g1 === 'string' && g1 ? g1 : typeof g2 === 'string' && g2 ? g2 : null;
        return v ? m.replace(v, label) : label;
      });
    }
    return byName ? out.replace(NAMED_SECRET, (_, k, sep) => `${k}${sep}[REDACTED]`) : out;
  };
}

/** Keys whose string values are digests or object names, never secrets (redacting them breaks verification). */
export const HASH_KEY = /(?:sha256|^tree_digest|^session_nonce|^snapshot_commit|^base|^head|^prev|^tip|^sha|^tree|^commit|^cache_key)$/;

/**
 * `redact` applied to every string inside a JSON-like value. Strings under `keep` keys stay as
 * they are; `keys` redacts object keys too; `secretKeys` blanks any string under a credential-like
 * key (`API_TOKEN: ...` in an env map has no NAME= context for a pattern to match).
 */
export function redactDeep(value, redact, opts = {}, key = '', depth = 0) {
  const { keep = HASH_KEY, keys = false, secretKeys = false } = opts;
  if (typeof value === 'string') {
    if (key && keep && keep.test(key)) return value;
    if (secretKeys && key && SECRET_NAME.test(key) && value && !/^\$/.test(value)) return '[REDACTED]';
    return redact(value);
  }
  if (!value || typeof value !== 'object' || depth > 64) return value;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, redact, opts, key, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) out[keys ? redact(k) : k] = redactDeep(v, redact, opts, k, depth + 1);
  return out;
}
