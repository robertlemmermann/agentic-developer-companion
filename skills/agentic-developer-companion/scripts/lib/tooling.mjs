// `tooling` command group (§11): lint (tooling-lint.mjs), cost, port (tooling-port.mjs), trigger-set,
// modify, plugin and scaffold. Instructions, skills, agents, hooks, plugins and MCP configs are treated
// as software: known-good templates, measured context cost, headless trigger evals and a
// baseline/compare loop for every change.

import fs from 'node:fs';
import path from 'node:path';
import {
  defineCommand, defineGroup, makeContext, usageError, envError, EXIT, readText, readJson, writeFileAtomic,
  writeJsonAtomic, ensureDir, toPosix, relPosix, sha256, nowIso, today, nonce, which, run, runTool, spawnCapture,
  quoteArg, quoteFor, loadBundle, selectSections, renderString, parseBundle, generatedBy, listFiles, truncate,
  numberOption, realPath, hostHomes, lastLine, makeTempDir, isDir, statOrNull, uniq, parseJsonl, IS_WINDOWS, SKILL_DIR,
  ADC_SCRIPT, ASSETS_DIR,
} from './core.mjs';
import { repoRoot, gitRaw, gitTry, statusPorcelain } from './git.mjs';
import { LOCKFILE_MANAGERS, makeRedactor } from './markers.mjs';
import { prepareStateDir, statePaths, appendMetrics, writeOutputs, backupDirFactory } from './state.mjs';
import { parseFrontmatter, stringifyFrontmatter, markdownLines } from './frontmatter.mjs';
import { detect } from './detect.mjs';
import { lintPaths, lintCommand } from './tooling-lint.mjs';
import {
  HOSTS, SKILL_DIRS, CODEX_ONLY_SKILLS_DIR, COPY_IGNORE, classifyArtifact, skillNameProblems, toSkillName,
  inlineImports, parseHookConfig, renderHookConfig, mergeHooks, parseMcpConfig, renderMcpConfig, mergeMcp, mergeToml,
  cloudAgentMcp, parseAgent, renderAgent, renderOpenAiYaml, shortDescription, firstSentence, portCommand, migrate,
  migrationSources, MIGRATIONS, json, SCRIPT_EXT,
} from './tooling-port.mjs';

const CHARS_PER_TOKEN = 4;
const CLAUDE_LISTING_CAP = 1536;
const WALK_IGNORE = new Set(['.git', 'node_modules', '.adc', 'results', '.venv', '__pycache__']);
const TOOLING_DIRS = ['.github', '.claude', '.agents', '.codex', '.vscode', 'skills'];
const INSTRUCTION_NAMES = new Set(['AGENTS.md', 'AGENTS.override.md', 'CLAUDE.md', 'CLAUDE.local.md', 'GEMINI.md']);
const PAID_NOTE = 'paid: every run is a real model call billed to your account';
const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/** ceil(chars / 4): the usual English-text heuristic (roughly +-25%). */
export const estimateTokens = (chars) => Math.ceil(Math.max(0, chars) / CHARS_PER_TOKEN);

// Resolved paths throughout: git reports the real root, while the cwd may pass through a symlink
// (macOS /var -> /private/var), and every user path would otherwise look outside the repository.
const rootOf = (ctx) => realPath(repoRoot(ctx.cwd) || ctx.cwd);
const userPath = (ctx, p) => realPath(path.resolve(ctx.cwd, p));
/** Every command refuses (exit 3) while `.adc/` is tracked; this checks without creating it. */
const checkState = (ctx, root) => prepareStateDir({ ...ctx, cwd: root }, { create: false });
const openState = (ctx, root) => prepareStateDir({ ...ctx, cwd: root }, { create: true });
const backups = (ctx, root) => backupDirFactory(ctx, root, 'tooling', 'backups');
const absOf = (root, rel) => path.join(root, ...rel.split('/'));
const exists = (root, rel) => fs.existsSync(absOf(root, rel));
const relOf = (root, abs) => relPosix(root, abs) ?? toPosix(abs);
const listOpt = (v) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : null);
// Sortable unique id: UTC time to the millisecond (core.stamp stops at the second), so baselines made
// in the same second keep their order.
const tsId = () => `${new Date().toISOString().replace(/[-:.]/g, '')}-${nonce().slice(0, 6)}`;
const artifactSlug = (rel) => toPosix(rel).replace(/\/SKILL\.md$/, '').replace(/[^A-Za-z0-9._-]+/g, '__')
  .replace(/^_+|_+$/g, '')
  .slice(0, 120) || 'root';
const insideSkill = (abs) => {
  const r = path.relative(realPath(SKILL_DIR), realPath(abs));
  return !r.startsWith('..') && !path.isAbsolute(r);
};

function parseHosts(value, { allowAll = true } = {}) {
  const v = String(value || 'all').trim();
  if (v === 'all' && allowAll) return [...HOSTS];
  const list = uniq(v.split(',').map((s) => s.trim()).filter(Boolean));
  for (const h of list) if (!HOSTS.includes(h)) throw usageError(`host must be copilot, claude, `
    + `codex${allowAll ? ' or all' : ''} (got "${h}")`);
  return list;
}

// ---------------------------------------------------------------------------
// Discovery and context cost (§11.3)

/** Tooling files under `root` (or under the given paths): `[{ path, abs, kind, host, hosts, ... }]`. */
export function discoverTooling(root, { paths = null } = {}) {
  const rels = new Set();
  const addTree = (abs) => {
    for (const f of listFiles(abs, { ignore: WALK_IGNORE, maxFiles: 20_000 })) rels.add(relOf(root, path.join(abs, f)));
  };
  for (const p of paths || []) {
    const abs = path.resolve(root, p);
    if (!fs.existsSync(abs)) throw usageError(`not found: ${toPosix(p)}`);
    if (isDir(abs)) addTree(abs); else rels.add(relOf(root, abs));
  }
  if (!paths?.length) {
    for (const d of TOOLING_DIRS) if (isDir(path.join(root, d))) addTree(path.join(root, d));
    for (const f of listFiles(root, { ignore: WALK_IGNORE })) {
      if (INSTRUCTION_NAMES.has(path.posix.basename(f))) rels.add(f);
    }
  }
  return [...rels].sort().map((rel) => {
    const cls = classifyArtifact(rel);
    return cls && { path: rel, abs: path.isAbsolute(rel) ? rel : absOf(root, rel), ...cls };
  }).filter(Boolean);
}

const stripHtmlComments = (t) => t.replace(/<!--[\s\S]*?-->/g, '');
const lineCount = (t) => (t ? t.split('\n').length - (t.endsWith('\n') ? 1 : 0) : 0);
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const hostTokens = (h, text) => estimateTokens((h === 'claude' ? stripHtmlComments(text) : text).length);

/** The listing line a host shows for a skill, agent or command (Claude adds when_to_use, capped at 1,536). */
function listingText(data, host) {
  let desc = oneLine(data.description);
  if (host === 'claude' && data.when_to_use) desc = `${desc} ${oneLine(data.when_to_use)}`.slice(0, CLAUDE_LISTING_CAP);
  return `- ${String(data.name ?? '')}: ${desc}`;
}

/**
 * Characters and estimated tokens per tooling file, which files are always-on per host
 * (instructions, skill/agent/command listings) and which load on demand, per-host budgets,
 * duplicated rules and stale commands or paths. Returns `{ files[], totals, findings[], ... }`.
 */
export function toolingCost({
  root, paths = null, host = 'all', contextTokens = 200_000, artifacts = null, top = 10,
} = {}) {
  const hosts = host === 'all' ? [...HOSTS] : parseHosts(host, { allowAll: false });
  const claudeMd = ['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md'].some((f) => exists(root, f));
  const override = exists(root, 'AGENTS.override.md');
  const files = [];
  const byPath = new Map();
  // Every file is read and parsed once; the import, budget, duplicate and stale scans reuse it.
  const src = new Map();
  const notes = new Set();
  const entry = (rel, abs, kind, text, extra, data = {}) => {
    src.set(rel, { abs, text, data });
    return { path: rel, kind, hosts: [], chars: text.length, bytes: Buffer.byteLength(text), lines: lineCount(text),
      est_tokens: estimateTokens(text.length), load: 'on-demand', always_on: false, always_on_tokens: {},
        on_demand_tokens: 0, ...extra };
  };
  for (const a of artifacts || discoverTooling(root, { paths })) {
    if (a.kind === 'mcp') notes.add(
      'MCP tool definitions also cost context; they are not estimated here (use /context in the host).');
    if (a.kind === 'agent-toml') notes.add(`${a.path}: Codex TOML agent roles are unverified and not counted.`);
    if (['hooks', 'mcp', 'plugin', 'marketplace', 'agent-toml'].includes(a.kind)) continue;
    const text = readText(a.abs, '');
    const fm = parseFrontmatter(text);
    const body = fm.hasFrontmatter ? fm.body : text;
    const e = entry(a.path, a.abs, a.kind, text, { hosts: [...a.hosts] }, fm.data);
    const set = (h, n) => { if (hosts.includes(h) && e.hosts.includes(h)) e.always_on_tokens[h] = n; };
    const base = path.posix.basename(a.path);
    if (a.kind === 'instructions') {
      e.load = 'always';
      if (base === 'AGENTS.md') {
        e.hosts = ['copilot', ...(override ? [] : ['codex']), ...(claudeMd ? [] : ['claude'])];
        if (claudeMd) e.note =
          'Claude Code reads AGENTS.md only when no CLAUDE.md exists (or through an @AGENTS.md import)';
      }
      for (const h of e.hosts) set(h, hostTokens(h, text));
    } else if (a.kind === 'scoped') {
      const always = /\.instructions\.md$/.test(base)
        ? String(fm.data.applyTo ?? '').split(',').some((g) => ['**', '**/*'].includes(g.trim()))
        : /(^|\/)\.claude\/rules\//.test(a.path) && fm.data.paths == null;
      e.load = always ? 'always' : 'path-scoped';
      e.scoped_tokens = estimateTokens(body.length);
      if (always) for (const h of e.hosts) set(h, e.scoped_tokens);
    } else if (['skill', 'command', 'agent'].includes(a.kind)) {
      e.load = 'listing';
      e.name = String(fm.data.name ?? (a.kind === 'skill' ? a.name : base.replace(/\.agent\.md$|\.md$/, '')));
      // A Codex skill with allow_implicit_invocation: false is not listed for the model.
      const hidden = /^\s*allow_implicit_invocation:\s*false\b/m
        .test(readText(path.join(path.dirname(a.abs), 'agents', 'openai.yaml'), ''));
      for (const h of e.hosts) set(h,
        h === 'codex' && a.kind === 'skill' && hidden ? 0
        : estimateTokens(listingText({ ...fm.data, name: e.name }, h).length));
      e.on_demand_tokens = estimateTokens(body.length);
      e.body_chars = body.length;
      e.description_chars = String(fm.data.description ?? '').length + String(fm.data.when_to_use ?? '').length;
    } else e.on_demand_tokens = estimateTokens(text.length);
    e.always_on = Object.values(e.always_on_tokens).some((n) => n > 0);
    files.push(e);
    byPath.set(a.path, e);
  }
  // @imports load the imported file with the importer (Claude Code always; Copilot CLI as well).
  for (const e of [...files]) {
    if (e.load !== 'always' || !['instructions', 'scoped'].includes(e.kind)) continue;
    const { abs, text } = src.get(e.path);
    for (const imp of uniq(inlineImports(text, abs).files)) {
      const rel = relOf(root, imp);
      let t = byPath.get(rel);
      if (!t) {
        t = entry(rel, imp, 'import', readText(imp, ''), { load: 'always', imported_by: [] });
        files.push(t);
        byPath.set(rel, t);
      }
      const it = src.get(rel).text;
      t.imported_by = uniq([...(t.imported_by || []), e.path]);
      if (t.note && path.posix.basename(t.path) === 'AGENTS.md') t.note = `Claude Code loads AGENTS.md through the `
        + `@import in ${t.imported_by.join(', ')}`;
      for (const h of e.hosts) {
        if (h === 'codex' || !hosts.includes(h)) continue;
        if (!t.hosts.includes(h)) t.hosts.push(h);
        t.always_on_tokens[h] ??= hostTokens(h, it);
      }
      t.always_on = Object.values(t.always_on_tokens).some((n) => n > 0);
    }
  }
  const totals = {};
  const findings = [];
  for (const h of hosts) {
    const mine = files.filter((f) => f.hosts.includes(h));
    const t = { always_on_tokens: 0, instruction_tokens: 0, listing_tokens: 0, path_scoped_tokens: 0,
      on_demand_tokens: 0, files: mine.length, budgets: [] };
    for (const f of mine) {
      const n = f.always_on_tokens[h] || 0;
      t.always_on_tokens += n;
      t[f.load === 'listing' ? 'listing_tokens' : 'instruction_tokens'] += n;
      if (f.load === 'path-scoped') t.path_scoped_tokens += f.scoped_tokens || 0;
      t.on_demand_tokens += f.on_demand_tokens || 0;
    }
    const skillListing = mine.filter((f) => f.load === 'listing' && f.kind !== 'agent')
      .reduce((s, f) => s + (f.always_on_tokens[h] || 0), 0);
    const B = (id, file, limit, used, unit, source) =>
      t.budgets.push({ id, ...(file ? { file } : {}), limit, used, unit, source });
    const each = (pred, fn) => mine.filter(pred).forEach(fn);
    if (h === 'claude') {
      B('claude-skill-listing', null, Math.round(contextTokens * 0.01), skillListing, 'tokens',
        'Claude Code skill listing budget: 1% of the context window');
      each((f) => /(^|\/)CLAUDE(\.local)?\.md$/.test(f.path),
        (f) => B('claude-md-lines', f.path, 200, f.lines, 'lines', 'Claude Code memory guidance: under 200 lines'));
      each((f) => f.kind === 'skill',
        (f) => B('claude-listing-chars', f.path, CLAUDE_LISTING_CAP, f.description_chars, 'chars',
        'description + when_to_use are truncated at 1,536 characters'));
    } else if (h === 'codex') {
      B('codex-skills-catalog', null, Math.min(Math.round(contextTokens * 0.02), 10_000), skillListing, 'tokens',
        'Codex skills catalog: 2% of the context window, capped at 10,000 tokens');
      // AGENTS.md chain: one file per directory from the root down (AGENTS.override.md wins).
      let chain = { bytes: 0, file: null };
      for (const f of mine.filter((x) => /(^|\/)AGENTS(\.override)?\.md$/.test(x.path))) {
        const segs = path.posix.dirname(f.path) === '.' ? [] : path.posix.dirname(f.path).split('/');
        const bytes = segs.map((_, k) => segs.slice(0, k).join('/')).concat(segs.join('/')).reduce((sum, dir) => {
          const pick = ['AGENTS.override.md', 'AGENTS.md'].map((n) => (dir ? `${dir}/${n}` : n))
            .find((r) => byPath.has(r));
          return sum + (pick ? byPath.get(pick).bytes : 0);
        }, 0);
        if (bytes > chain.bytes) chain = { bytes, file: f.path };
      }
      B('codex-agents-md-bytes', chain.file, 32_768, chain.bytes, 'bytes',
        'Codex project_doc_max_bytes: 32 KiB of AGENTS.md from the root down to the working directory');
    } else {
      each((f) => ['instructions', 'scoped', 'import'].includes(f.kind),
        (f) => B('copilot-instruction-lines', f.path, 1000, f.lines, 'lines',
        'Copilot code review guidance: about 1,000 lines per instruction file'));
      each((f) => f.kind === 'skill',
        (f) => B('copilot-description-chars', f.path, 1024, String(src.get(f.path).data.description ?? '').length,
        'chars', 'skill description: at most 1,024 characters'));
      each((f) => f.kind === 'agent' && /\.github\/agents\//.test(f.path),
        (f) => B('copilot-agent-body-chars', f.path, 30_000, f.body_chars, 'chars',
        'Copilot custom agent prompt: at most 30,000 characters'));
    }
    for (const b of t.budgets) {
      b.ok = b.used <= b.limit;
      if (!b.ok) findings.push({ id: 'OVER_BUDGET', severity: 'finding', host: h, file: b.file || null,
        message: `${b.id}: ${b.used} ${b.unit} > ${b.limit} (${b.source})` });
    }
    totals[h] = t;
  }
  findings.push(...duplicateRules(files, hosts, src), ...staleReferences(root, files, src));
  const maxOf = (f) => Math.max(0, ...Object.values(f.always_on_tokens));
  const biggest = files.flatMap((f) => Object.entries(f.always_on_tokens).filter(([, n]) => n > 0)
    .map(([h, n]) => ({ path: f.path, host: h, tokens: n })));
  biggest.sort((a, b) => b.tokens - a.tokens || a.path.localeCompare(b.path));
  files.sort((a, b) => maxOf(b) - maxOf(a) || a.path.localeCompare(b.path));
  return {
    root: toPosix(root), context_tokens: contextTokens,
    method: 'est_tokens = ceil(chars / 4); listings count "- name: description" (+ when_to_use in Claude Code, capped '
      + 'at 1,536 chars); imports load with their importer',
    files, totals: { ...totals, max_always_on_tokens: Math.max(0, ...hosts.map((h) => totals[h].always_on_tokens)) },
    biggest_always_on: biggest.slice(0, top), findings, notes: [...notes],
  };
}

/** Rule-like lines (30+ characters, list markers and emphasis removed) outside code and headings. */
function ruleLines(text) {
  return markdownLines(text).filter((l) => !l.code && !/^\s*(#|<!--)/.test(l.raw)).map((l) => ({ line: l.n,
    text: l.raw.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim()
      .toLowerCase(),
  }))
    .filter((l) => l.text.length >= 30);
}

function duplicateRules(files, hosts, src) {
  const findings = [];
  const seen = new Set();
  const rules = new Map();
  for (const h of hosts) {
    const where = new Map();
    for (const f of files.filter((x) => (x.always_on_tokens[h] || 0) > 0
      && ['instructions', 'scoped', 'import'].includes(x.kind))) {
      if (!rules.has(f.path)) rules.set(f.path, ruleLines(src.get(f.path).text));
      for (const l of rules.get(f.path)) {
        const list = where.get(l.text) || where.set(l.text, []).get(l.text);
        if (!list.some((x) => x.file === f.path)) list.push({ file: f.path, line: l.line });
      }
    }
    for (const [text, list] of where) {
      const at = list.map((x) => `${x.file}:${x.line}`).join(', ');
      if (list.length < 2 || seen.has(at)) continue;
      seen.add(at);
      findings.push({ id: 'DUPLICATE_RULE', severity: 'finding', host: h, file: list[0].file, line: list[0].line,
        message: `the same rule is loaded ${list.length} times for ${h}: ${at}`, evidence: truncate(text, 120) });
    }
  }
  return findings;
}

// Package-manager subcommands that are not script names (`pnpm build` runs the script "build").
const NPM_BUILTIN = new Set(('install i ci add remove rm uninstall update up exec dlx x why list ls init create '
  + 'publish pack link audit outdated config version view info help login logout cache store run test t start stop '
    + 'restart '
  + 'rebuild prune dedupe workspace workspaces set import patch env bin root doctor fund explain query search owner '
  + 'deprecate dist-tag pkg npx node global upgrade').split(' '));
const NODE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
/** The Node package manager whose lockfile is at the root, or null. */
const lockManager = (root) => Object.entries(LOCKFILE_MANAGERS)
  .find(([f, m]) => NODE_MANAGERS.has(m) && exists(root, f))?.[1] || null;

/** Commands in fenced code and inline code spans: `[{ line, text, fenced }]`. */
function codeSnippets(text) {
  return markdownLines(text)
    .flatMap((l) => (l.code
    ? (l.fenceStart || l.fenceEnd ? [] : [{ line: l.n, text: l.raw.trim().replace(/^\$\s+/, ''), fenced: true }])
    : [...l.raw.matchAll(/`([^`\n]+)`/g)].map((m) => ({ line: l.n, text: m[1].trim(), fenced: false }))));
}

function staleReferences(root, files, src) {
  const findings = [];
  const unseen = []; // paths not on disk: dropped below when git ignores them (one git call for all)
  const pkg = readJson(path.join(root, 'package.json'));
  const scripts = pkg?.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : null;
  const manager = lockManager(root);
  const targets = (names, re) => {
    const t = names.map((n) => readText(path.join(root, n))).find((x) => x != null);
    return t == null ? null : new Set([...t.matchAll(re)].map((m) => m[1]));
  };
  const make = targets(['Makefile', 'makefile'], /^([A-Za-z0-9_.-]+)\s*:(?!=)/gm);
  const just = targets(['justfile', 'Justfile'], /^@?([A-Za-z0-9_-]+)[^\n:=]*:(?!=)/gm);
  for (const f of files.filter((x) => ['instructions', 'scoped', 'import', 'skill', 'agent', 'command',
    'skill-file'].includes(x.kind))) {
    const { abs, text } = src.get(f.path);
    const add = (id, s, message, evidence = s.text) => findings.push({ id, severity: 'finding', file: f.path,
      line: s.line, message, evidence: truncate(evidence, 120) });
    for (const s of codeSnippets(text)) {
      for (const seg of s.text.split(/\s*(?:&&|\|\||;)\s*/)) {
        const m = /^(npm|pnpm|yarn|bun)\s+(?:(run|run-script)\s+)?([A-Za-z0-9:_.-]+)/.exec(seg);
        if (m && pkg) {
          const [, tool, runWord, name] = m;
          if (manager && manager !== tool) add('STALE_COMMAND', s,
            `\`${seg}\` uses ${tool}, but the lockfile belongs to ${manager}`, seg);
          const script = tool === 'npm' && name === 't' ? 'test' : name;
          const isScript = runWord || (tool === 'npm' ? ['test', 't', 'start', 'stop', 'restart'].includes(name)
            : !NPM_BUILTIN.has(name));
          if (scripts && isScript && !(script in scripts) && !(script === 'start' && exists(root, 'server.js'))) {
            add('STALE_COMMAND', s, `\`${seg}\` runs the script "${script}", which package.json does not define`, seg);
          }
          continue;
        }
        const mk = /^make\s+([A-Za-z0-9_.-]+)/.exec(seg);
        if (mk && make && !make.has(mk[1])) add('STALE_COMMAND', s,
          `\`${seg}\`: the Makefile has no target "${mk[1]}"`, seg);
        const jr = /^just\s+([A-Za-z0-9_-]+)/.exec(seg);
        if (jr && just && !just.has(jr[1])) add('STALE_COMMAND', s,
          `\`${seg}\`: the justfile has no recipe "${jr[1]}"`, seg);
      }
      // Paths: only in files the host loads as instructions (reference files are documentation
      // full of example paths), only file-like paths, and never state, ignored or generated files.
      const p = s.text;
      if (s.fenced || f.kind === 'skill-file' || !/^(?:\.{1,2}\/)?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(p)
        || !/\.[A-Za-z0-9]{1,8}$/.test(p) || /^(?:\.\/)?\.adc\//.test(p)) continue;
      const candidates = [path.resolve(path.dirname(abs), p), path.resolve(root, p),
        ...(f.kind === 'skill' ? [path.resolve(path.dirname(abs), '..', p)] : [])];
      if (!candidates.some((c) => fs.existsSync(c))) {
        add('STALE_PATH', s, `\`${p}\` does not exist in the repository`, p);
        unseen.push({ finding: findings.at(-1), p });
      }
    }
  }
  // `../` paths are outside the repository (git would refuse the whole batch); they stay stale.
  const ask = unseen.filter((u) => !u.p.startsWith('../')).map((u) => u.p);
  if (!ask.length) return findings;
  const r = gitRaw(root, ['check-ignore', '--no-index', '--stdin'], { input: `${uniq(ask).join('\n')}\n` });
  const ignored = new Set(r.exit === 0 ? r.stdout.split(/\r?\n/) : []);
  const drop = new Set(unseen.filter((u) => ignored.has(u.p)).map((u) => u.finding));
  return findings.filter((x) => !drop.has(x));
}

const costCommand = defineCommand({
  name: 'tooling cost',
  usage: 'tooling cost [paths...] [--host all|copilot|claude|codex] [--context-tokens 200000] [--max-tokens n] '
    + '[--top 10]',
  options: {
    host: { type: 'string' }, 'context-tokens': { type: 'string' }, 'max-tokens': { type: 'string' },
    top: { type: 'string' },
  },
  async run(ctx, values, positionals) {
    const root = rootOf(ctx);
    checkState(ctx, root);
    const res = toolingCost({
      root, paths: positionals.length ? positionals.map((p) => userPath(ctx, p)) : null, host: values.host || 'all',
      contextTokens: numberOption(values, 'context-tokens', 200_000),
      top: numberOption(values, 'top', 10, { integer: true }),
    });
    const max = numberOption(values, 'max-tokens', null, { allowZero: true });
    if (max != null) Object.assign(res,
      { max_tokens: max, over_max: HOSTS.filter((h) => res.totals[h]?.always_on_tokens > max) });
    const per = HOSTS.filter((h) => res.totals[h]).map((h) => `${h} ${res.totals[h].always_on_tokens}`).join(', ');
    return { result: res, exit: res.over_max?.length ? EXIT.FINDINGS : EXIT.OK,
      summary: `${res.files.length} file(s); always-on tokens: ${per}; ${res.findings.length} finding(s)` };
  },
});

// ---------------------------------------------------------------------------
// Scaffold (§11.1)

export const TOOLING_KINDS = Object.freeze(['instructions', 'skill', 'agent', 'prompt', 'hooks', 'mcp', 'plugin']);

/** parseArgs options for tooling scaffolds; scaffold.mjs merges these to pass them through. */
export const TOOLING_SCAFFOLD_OPTIONS = Object.freeze(Object.fromEntries([
  ...('for name description topic apply-to events hooks-dir server command args url env license out skills agents '
    + 'marketplace owner version lang skill-root exclude-agent').split(' ').map((k) => [k, { type: 'string' }]),
  ...['write', 'force', 'include-hooks', 'include-mcp'].map((k) => [k, { type: 'boolean' }]),
]));

async function projectCommands(root) {
  const out = {};
  const pkg = readJson(path.join(root, 'package.json'));
  const sc = pkg?.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  // The project's own scripts come first (instructions name `npm test`, not the runner behind it).
  const mgr = lockManager(root) || 'npm';
  const runS = (s) => (s === 'test' ? `${mgr} test` : `${mgr} run ${s}`);
  if (sc.test && !/no test specified/.test(String(sc.test))) out.test = runS('test');
  if (sc.lint) out.lint = runS('lint');
  const tc = ['typecheck', 'type-check', 'tsc'].find((k) => sc[k]);
  if (tc) out.typecheck = runS(tc);
  let p = null;
  let r = null;
  try {
    r = await detect({ root, stateInfo: null, refresh: false });
    p = r.projects?.[0];
  } catch { /* placeholders below */ }
  return {
    install: out.install || p?.managers?.[0]?.install || '(add the install command)',
    test: out.test || p?.runners?.[0]?.cmd || '(add the full test command)',
    lint: out.lint || (p?.lint || r?.lint || [])[0]?.cmd || '(add the lint command)',
    typecheck: out.typecheck || (p?.typecheck || r?.typecheck || [])[0]?.cmd
      || '(add the type-check command, or remove this line)',
  };
}

function projectName(root) {
  const pkg = readJson(path.join(root, 'package.json'));
  return (typeof pkg?.name === 'string' && pkg.name) || path.basename(root);
}

const DEFAULT_DESCRIPTION = 'Describe in one sentence what this does. Use when (the requests and phrases that should '
  + 'trigger it). Not for (near-miss tasks it must not handle).';

function renderSections(kind, host, vars, fm = () => '') {
  return selectSections(loadBundle('tooling'), { kind, host })
    .filter((s) => String(s.attrs.kind).split('|').includes(kind)).map((s) => {
    const p = renderString(s.path, vars);
    return { path: p, content: renderString(s.content, { ...vars, frontmatter: fm(p) }) };
  });
}

function skillDirsFor(hosts, name, base = null) {
  if (base) return [{ dir: `${toPosix(base).replace(/\/+$/, '')}/${name}`, hosts }];
  const dirs = [];
  if (hosts.includes('copilot') && hosts.includes('codex')) dirs.push({ dir: `${SKILL_DIRS.codex}/${name}`,
    hosts: ['copilot', 'codex'] });
  else {
    for (const h of ['copilot', 'codex']) {
      if (hosts.includes(h)) dirs.push({ dir: `${SKILL_DIRS[h]}/${name}`, hosts: [h] });
    }
  }
  if (hosts.includes('claude')) dirs.push({ dir: `${SKILL_DIRS.claude}/${name}`, hosts: ['claude'] });
  return dirs;
}

function triggerSetTemplate(name) {
  const tpl = readText(path.join(ASSETS_DIR, 'evals', 'trigger-set.template.json'));
  if (tpl == null) throw envError('TEMPLATE_MISSING', 'assets/evals/trigger-set.template.json is missing');
  return json(JSON.parse(renderString(tpl, { skill_name: name })));
}

/**
 * The starter evals of a skill: the trigger set, one `claude plugin eval` case and skill-creator's
 * `evals.json` (a different format; the two are not interchangeable, so both are generated).
 */
function evalOutputs(evalsDir, name, { all = true } = {}) {
  const tpl = readText(path.join(ASSETS_DIR, 'evals', 'eval-case.template.md'));
  if (tpl == null) throw envError('TEMPLATE_MISSING', 'assets/evals/eval-case.template.md is missing');
  const vars = { case: `${name}-basic`, name };
  const outputs = parseBundle(tpl)
    .map((s) => ({ path: `${evalsDir}/${renderString(s.path, vars)}`, content: renderString(s.content, vars) }));
  if (!all) return outputs;
  const todo = {
    id: 1,
    prompt: `TODO: a realistic task that needs the ${name} skill, with the details a user would give`,
    expected_output: 'TODO: what a correct result contains',
    files: [],
    expectations: ['TODO: one verifiable statement about the output', 'TODO: another one'],
  };
  return [{ path: `${evalsDir}/trigger-set.json`, content: triggerSetTemplate(name) }, ...outputs,
    { path: `${evalsDir}/evals.json`, content: json({ skill_name: name, evals: [todo] }) }];
}

const HOOK_EVENTS = {
  posttooluse: 'PostToolUse', pretooluse: 'PreToolUse', sessionstart: 'SessionStart', sessionend: 'SessionEnd',
  stop: 'Stop', agentstop: 'Stop', userpromptsubmit: 'UserPromptSubmit', userpromptsubmitted: 'UserPromptSubmit',
};
const CAMEL_EVENTS = {
  PostToolUse: 'postToolUse', PreToolUse: 'preToolUse', SessionStart: 'sessionStart', SessionEnd: 'sessionEnd',
  Stop: 'agentStop', UserPromptSubmit: 'userPromptSubmitted',
};

function validName(name, what) {
  const problems = skillNameProblems(name);
  if (problems.length) throw usageError(`--name "${name}" is not a valid ${what} name: ${problems.join('; ')}`);
  return name;
}

async function buildScaffold(kind, hosts, values, root) {
  const outputs = [];
  const next = [];
  const manual = [];
  const add = (list, host) => outputs.push(...list.map((o) => ({ ...o, host })));
  const vars = { generated_by: generatedBy(), project_name: projectName(root) };
  const description = values.description ? oneLine(values.description) : DEFAULT_DESCRIPTION;
  if (description.length > 1024) throw usageError('--description must be at most 1,024 characters');
  if (/<[A-Za-z/][^>]*>/.test(description)) throw usageError('--description must not contain XML tags');
  if (kind === 'instructions') {
    const cmds = await projectCommands(root);
    const topic = toSkillName(values.topic || 'testing');
    const globs = listOpt(values['apply-to'] || '**/*.test.*,**/*.spec.*,**/test_*.py,**/*_test.go');
    const excludeAgent = values['exclude-agent'] ? String(values['exclude-agent']) : null;
    if (excludeAgent && !['code-review', 'cloud-agent'].includes(excludeAgent)) throw usageError(
      '--exclude-agent must be code-review or cloud-agent');
    const title = topic.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
    Object.assign(vars, { install_cmd: cmds.install, test_cmd: cmds.test, lint_cmd: cmds.lint,
      typecheck_cmd: cmds.typecheck, topic,
      topic_title: title, apply_to_md: globs.map((g) => `\`${g}\``).join(', ') });
    const fm = (p) => (p.endsWith('.instructions.md')
      ? stringifyFrontmatter({ applyTo: globs.join(','), description: `${title} rules`,
      ...(excludeAgent ? { excludeAgent } : {}) })
      : p.startsWith('.claude/rules/') ? stringifyFrontmatter({ paths: globs }) : '').trimEnd();
    for (const h of hosts) add(renderSections('instructions', h, vars, fm), h);
    next.push('Fill in the Conventions section of AGENTS.md with verifiable one-line rules; keep shared rules there '
      + 'and host-only notes in the host files.',
      'Measure the result: tooling cost (always-on tokens per host) and tooling lint.');
    if (hosts.includes('claude')) next.push('Do not add CLAUDE.local.md: it stops Claude Code from reading AGENTS.md '
      + 'unless the project-instructions setting reads both.');
  } else if (kind === 'agent') {
    const name = validName(values.name || 'my-agent', kind);
    Object.assign(vars, { name, description, summary: firstSentence(description) });
    const preload = listOpt(values.skills) || [];
    for (const sk of preload) validName(sk, 'skill');
    for (const h of hosts) {
      if (h === 'codex') {
        const dir = `${CODEX_ONLY_SKILLS_DIR}/${name}`;
        const meta = { version: '0.1.0',
          ...(shortDescription(description) ? { 'short-description': shortDescription(description) } : {}) };
        add(renderSections('agent', 'codex', { ...vars, skill_dir: dir },
          () => stringifyFrontmatter({ name, description, metadata: meta }).trimEnd()), h);
        outputs.push({ path: `${dir}/agents/openai.yaml`, content: renderOpenAiYaml({ name, description }), host: h });
        manual.push(`Codex has no custom agent files: ${name} is the skill ${dir} (invoke it as $${name}). The `
          + `.codex/agents/<name>.toml role format is unverified and was not generated.`);
        continue;
      }
      // Least privilege by default; shared conventions are preloaded as skills, not repeated in the body.
      const data = { name, description, tools: h === 'copilot' ? ['read', 'search'] : 'Read, Grep, Glob',
        ...(preload.length ? { skills: preload } : {}) };
      add(renderSections('agent', h, { ...vars, agent_file: name },
        () => stringifyFrontmatter(data, { flowKeys: ['tools', 'skills'] }).trimEnd()), h);
    }
    next.push('Keep the tool list least-privilege; add edit or execute tools only when the agent must change files or '
      + 'run commands.');
  } else if (kind === 'skill' || kind === 'prompt') {
    const name = validName(values.name || `my-${kind === 'prompt' ? 'command' : 'skill'}`, kind);
    Object.assign(vars, { name, description, summary: firstSentence(description), prompt_frontmatter: '' });
    const meta = { version: '0.1.0',
      ...(shortDescription(description) ? { 'short-description': shortDescription(description) } : {}) };
    const dirs = skillDirsFor(hosts, name, values['skill-root'] || null);
    for (const d of dirs) {
      const data = { name, description, ...(values.license ? { license: String(values.license) } : {}),
        metadata: meta };
      if (kind === 'prompt' && !(d.hosts.length === 1 && d.hosts[0] === 'codex')) {
        data['disable-model-invocation'] = true;
      }
      const files = renderSections(kind, d.hosts[0], { ...vars, skill_dir: d.dir, prompt_skill_dir: d.dir },
        () => stringifyFrontmatter(data).trimEnd());
      add(files.filter((o) => o.path.startsWith(`${d.dir}/`)), d.hosts.join(','));
      if (d.hosts.includes('codex')) outputs.push({ path: `${d.dir}/agents/openai.yaml`,
        content: renderOpenAiYaml({ name, description, implicit: kind !== 'prompt' }), host: 'codex' });
    }
    if (kind === 'prompt' && hosts.includes('copilot')) {
      const dir = dirs.find((d) => d.hosts.includes('copilot')).dir;
      const pfm = stringifyFrontmatter({ name, description }).trimEnd();
      add(renderSections('prompt', 'copilot',
        { ...vars, prompt_frontmatter: pfm, prompt_skill_dir: dir, skill_dir: dir })
        .filter((o) => o.path.startsWith('.github/prompts/')), 'copilot');
      manual.push('Prompt files run only in the VS Code Local harness and Visual Studio; Copilot CLI, the cloud agent '
        + 'and the Copilot harness use the skill instead.');
    }
    if (kind === 'skill') {
      const evalDir = (dirs.find((d) => d.hosts.includes('claude')) || dirs[0]).dir;
      add(evalOutputs(`${evalDir}/evals`, name), 'eval');
      next.push(`Write the trigger set (${evalDir}/evals/trigger-set.json) and the eval case before the body: replace `
        + `every TODO.`,
        `Then measure: tooling trigger-set ${evalDir} (free: shows the commands), tooling trigger-set ${evalDir} `
          + `--host claude --run (${PAID_NOTE}).`);
    }
    if (dirs.length > 1) manual.push(`Two copies were generated (${dirs.map((d) => d.dir).join(' and ')}) because `
      + `Claude Code reads only .claude/skills; after edits run \`tooling port ${dirs[0].dir} --to claude --force\` `
      + `to sync.`);
    next.push('Write the description as what + when + boundary in the third person (at most 1,024 characters) and '
      + 'keep SKILL.md under 500 lines.');
  } else if (kind === 'hooks') {
    const name = validName(values.name || 'adc-example-hook', 'hook');
    const dir = toPosix(values['hooks-dir'] || 'scripts/hooks').replace(/\/+$/, '');
    const events = uniq(listOpt(values.events || 'PostToolUse').map((e) => HOOK_EVENTS[e.toLowerCase()] || (() => {
      throw usageError(`--events: unsupported event "${e}" (use PostToolUse, PreToolUse, SessionStart, SessionEnd, `
        + `Stop, UserPromptSubmit)`);
    })()));
    Object.assign(vars, { name, hooks_dir: dir, script_path: `${dir}/${name}.mjs`,
      test_path: `${dir}/${name}.test.mjs` });
    add(renderSections('hooks', null, vars), 'all');
    for (const h of hosts) {
      const entries = events.map((ev) => ({
        event: ev, matcher: ['PostToolUse', 'PreToolUse'].includes(ev) ? 'Edit|Write' : null, extra: {}, source: h,
        timeout: 10,
        exec: { program: 'node',
          args: [vars.script_path, '--dialect', h, '--event', h === 'copilot' ? CAMEL_EVENTS[ev] : ev] },
      }));
      const r = renderHookConfig(entries, h, { file: name, guard: true });
      manual.push(...r.manual);
      const target = { copilot: `.github/hooks/${name}.json`, claude: '.claude/settings.json',
        codex: '.codex/hooks.json' }[h];
      outputs.push({ path: target, content: json(r.doc), host: h, merge: (cur) => mergeHooks(cur, r.doc) });
      if (h === 'claude' && hosts.includes('copilot')) {
        manual.push('Copilot CLI and VS Code also run hooks from .claude/settings.json (with Claude-style payloads), '
          + 'so with both files Copilot runs the handler twice per event: keep decide() idempotent, or drop one file.');
      }
      if (h === 'codex') manual.push('Codex loads .codex/hooks.json only for trusted projects and asks for a one-time '
        + 'review in /hooks; start Codex at the repository root (the hook path is relative).');
    }
    next.push(`Run the handler tests: node --test ${vars.test_path}`,
      `Edit decide() in ${vars.script_path} for your check; keep it fast (no network, no repository scans) and keep `
        + `the fail-open default.`);
  } else if (kind === 'mcp') {
    const name = toSkillName(values.server || 'example');
    const url = values.url ? String(values.url) : null;
    if (url && !/^https:\/\//i.test(url) && !/^http:\/\/(localhost|127\.|\[::1\])/i.test(url)) {
      throw usageError('--url must use https (http only for localhost)');
    }
    const vars2 = listOpt(values.env) || [];
    for (const n of vars2) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(n)) throw usageError(
      `--env: "${n}" is not an environment variable name`);
    const env = Object.fromEntries(vars2.map((n) => [n, `\${${n}}`]));
    // Secrets only as ${VAR} references; a remote server gets the first one as its bearer token.
    const server = { name, cwd: null, tools: null, ...(url
      ? { transport: 'http', command: null, args: [], env: {}, url,
        headers: vars2.length ? { Authorization: `Bearer \${${vars2[0]}}` } : {} }
      : { transport: 'stdio', command: values.command || 'npx',
        args: listOpt(values.args) || ['-y', 'example-mcp-server@1.0.0'], env, url: null, headers: {} }) };
    const shared = hosts.includes('claude') || hosts.length > 1;
    for (const t of [hosts.includes('copilot') && !shared ? 'copilot' : null, shared ? 'claude' : null,
      hosts.includes('codex') ? 'codex' : null].filter(Boolean)) {
      const r = renderMcpConfig([server], t, { file: name });
      manual.push(...r.manual);
      if (t === 'codex') outputs.push({ path: '.codex/config.toml', content: r.text, host: 'codex',
        merge: (cur) => mergeToml(cur, r.blocks) });
      else outputs.push({ path: t === 'claude' ? '.mcp.json' : '.github/mcp.json', content: json(r.doc),
        merge: (cur) => mergeMcp(cur, r.doc),
        host: t === 'claude' && hosts.includes('copilot') ? 'claude,copilot' : t });
    }
    if (!values.args && !url) next.push(
      'Replace example-mcp-server@1.0.0 with the real package pinned to an exact version (never @latest).');
    if (hosts.includes('copilot')) next.push(cloudAgentMcp([server]));
    next.push('Keep secrets out of the files: reference environment variables (${VAR}) and set them where the host '
      + 'starts.');
  }
  return { outputs, next_steps: next, manual_steps: uniq(manual) };
}

/**
 * Write a tooling scaffold (instructions, skill, agent, prompt, hooks, mcp, plugin) for one
 * or more hosts. Without `write` it is a dry run that lists the files. Existing files are
 * never overwritten without `force`. `opts = { ctx?, values }` (values as parsed CLI options).
 */
export async function scaffoldTooling(kind, opts = {}) {
  const values = { ...(opts.values || {}), ...(opts.options || {}) };
  if (opts.host && !values.for) values.for = opts.host;
  const ctx = opts.ctx || makeContext(values);
  if (!TOOLING_KINDS.includes(kind)) throw usageError(
    `unknown tooling kind "${kind}" (expected ${TOOLING_KINDS.join(', ')})`);
  if (kind === 'plugin') return pluginInit(ctx, values);
  const root = opts.root || rootOf(ctx);
  checkState(ctx, root);
  const hosts = parseHosts(values.for || values.host || 'all');
  const outRoot = values.out ? userPath(ctx, values.out) : root;
  if (insideSkill(outRoot)) throw usageError('refusing to scaffold into the companion skill itself');
  const write = Boolean(values.write) && !ctx.dryRun;
  const built = await buildScaffold(kind, hosts, values, root);
  const applied = writeOutputs(built.outputs,
    { root: outRoot, dryRun: !write, force: Boolean(values.force), mergeNeedsForce: true,
    backupDir: backups(ctx, root) });
  const next = [...built.next_steps];
  if (!write) next.unshift(
    `Dry run: nothing was written. Re-run with --write to create ${applied.written.length} file(s).`);
  if (applied.skipped.length) {
    const how = applied.skipped.some((s) => s.planned === 'merge') ? 'merge or overwrite' : 'overwrite';
    next.unshift(`${applied.skipped.length} file(s) exist and were left alone; pass --force to ${how} them (a backup `
      + `goes to .adc/tooling/backups/).`);
  }
  return { kind, hosts, out: toPosix(path.relative(root, outRoot) || '.'), dry_run: !write, written: applied.written,
    skipped: applied.skipped,
    backups: applied.backups, next_steps: next, manual_steps: built.manual_steps };
}

const scaffoldCommand = defineCommand({
  name: 'tooling scaffold',
  usage: [
    'tooling scaffold <instructions|skill|agent|prompt|hooks|mcp|plugin> [--for copilot|claude|codex|all] [--out dir] '
      + '[--write] [--force]',
    '  instructions: [--topic t] [--apply-to "glob,glob"] [--exclude-agent code-review|cloud-agent]',
    '  skill | prompt: --name n --description d [--license l] [--skill-root dir]   agent: --name n --description d '
      + '[--skills a,b]',
    '  hooks: [--name n] [--events PostToolUse,PreToolUse,SessionStart,SessionEnd,Stop,UserPromptSubmit] [--hooks-dir '
      + 'scripts/hooks]',
    '  mcp: [--server n] (--command c [--args a,b] | --url https://...) [--env VAR,VAR]   plugin: see tooling plugin '
      + 'init',
  ].join('\n'),
  options: TOOLING_SCAFFOLD_OPTIONS,
  async run(ctx, values, positionals) {
    if (!positionals[0]) throw usageError(`tooling scaffold needs a kind: ${TOOLING_KINDS.join(', ')}`);
    const res = await scaffoldTooling(positionals[0], { ctx, values });
    const n = res.written.filter((w) => w.action !== 'unchanged').length;
    return { result: res, exit: EXIT.OK,
      summary: `${res.kind} for ${res.hosts.join(', ')}: ${n} file(s) `
      + `${res.dry_run ? 'planned (dry run)' : 'written'}, ${res.skipped.length} skipped` };
  },
});

// ---------------------------------------------------------------------------
// Trigger sets (§11.4)

/** Deterministic, label-stratified 60/40 train/validation split. */
export function assignSplit(queries) {
  const out = queries.map((q) => ({ ...q }));
  for (const label of [true, false]) {
    const key = (q) => sha256(`${q.id}\n${q.query}`);
    const group = out.filter((q) => q.should_trigger === label).sort((a, b) => key(a).localeCompare(key(b)));
    const nTrain = Math.round(group.length * 0.6);
    group.forEach((q, k) => { q.split = k < nTrain ? 'train' : 'validation'; });
  }
  return out;
}

/** Load and validate a trigger set (`adc-trigger-set/1` or skill-creator's `[{query, should_trigger}]`). */
export function loadTriggerSet(file) {
  const text = readText(file);
  let doc = null;
  try { doc = text == null ? null : JSON.parse(text); } catch { /* reported below */ }
  if (doc == null) throw usageError(`trigger set not found or not valid JSON: ${toPosix(file)}`);
  const list = Array.isArray(doc) ? doc : doc.queries;
  if (!Array.isArray(list)) throw usageError(`${toPosix(file)}: expected a "queries" array`);
  const problems = [];
  const queries = list.map((q, k) => {
    if (typeof q?.query !== 'string' || !q.query.trim()) problems.push(
      `query ${k + 1}: "query" must be a non-empty string`);
    if (typeof q?.should_trigger !== 'boolean') problems.push(`query ${k + 1}: "should_trigger" must be true or false`);
    return { id: String(q?.id ?? `q${String(k + 1).padStart(2, '0')}`), query: String(q?.query ?? ''),
      should_trigger: q?.should_trigger === true };
  });
  const seen = new Set();
  const dup = queries.find((q) => { if (seen.has(q.id)) return true; seen.add(q.id); return false; });
  if (dup) problems.push(`duplicate query id "${dup.id}"`);
  if (problems.length) throw usageError(`${toPosix(file)}: ${problems.slice(0, 5).join('; ')}`);
  const pos = queries.filter((q) => q.should_trigger).length;
  const warnings = [];
  if (queries.length < 16) warnings.push(
    `only ${queries.length} queries; use about 20 (8-10 should-trigger, 8-10 near misses)`);
  if (pos < 8 || queries.length - pos < 8) warnings.push(`${pos} should-trigger and ${queries.length - pos} `
    + `should-not queries; aim for 8-10 of each`);
  return { doc: Array.isArray(doc) ? { queries: list } : doc, queries: assignSplit(queries),
    todo: queries.filter((q) => /\bTODO\b/.test(q.query)).map((q) => q.id),
    warnings, sha256: sha256(text) };
}

function skillInfo(root, cwd, p) {
  const abs = realPath(path.resolve(cwd, p || '.'));
  const dir = isDir(abs) ? abs : path.dirname(abs);
  const text = readText(path.join(dir, 'SKILL.md'));
  if (text == null) throw usageError(`no SKILL.md in ${relOf(root, dir)}; pass a skill directory`);
  const d = parseFrontmatter(text).data;
  const name = String(d.name ?? path.basename(dir));
  return { dir, rel: relOf(root, dir), name,
    description_sha256: sha256(`${name}\n${d.description ?? ''}\n${d.when_to_use ?? ''}`) };
}

const named = (v, name) => typeof v === 'string' && (v === name || v.endsWith(`:${name}`));
const events = (lines) => parseJsonl(lines.join('\n'));

function walkJson(v, visit) {
  if (Array.isArray(v)) { for (const x of v) walkJson(x, visit); return; }
  if (v && typeof v === 'object') { visit(v); for (const x of Object.values(v)) walkJson(x, visit); }
}

/** Claude Code stream-json: a `Skill` tool_use naming the skill (or a Read of its SKILL.md) counts as a trigger. */
export function detectClaudeTrigger(lines, name) {
  const res = { triggered: false, loaded: null, cost_usd: null, error: null };
  for (const ev of events(lines)) {
    if (ev.type === 'system' && ev.subtype === 'init' && Array.isArray(ev.skills)) {
      res.loaded = ev.skills.some((s) => named(typeof s === 'string' ? s : s?.name, name));
    }
    for (const c of ev.type === 'assistant' && Array.isArray(ev.message?.content) ? ev.message.content : []) {
      if (c?.type !== 'tool_use') continue;
      const values = Object.values(c.input || {});
      if (c.name === 'Skill' && values.some((v) => named(v, name) || named(String(v).split(/\s+/)[0], name))) {
        res.triggered = true;
      }
      if (c.name === 'Read' && toPosix(String(c.input?.file_path ?? '')).endsWith(`/${name}/SKILL.md`)) {
        res.triggered = true;
      }
    }
    if (ev.type === 'result') {
      if (typeof ev.total_cost_usd === 'number') res.cost_usd = ev.total_cost_usd;
      if (ev.is_error) res.error = String(ev.result || ev.subtype || 'error').slice(0, 200);
    }
  }
  return res;
}

/**
 * Copilot CLI: no documented skill-load event yet (Appendix C). Detection, in order: a JSONL
 * object whose type/tool mentions "skill" and names the skill; any string naming
 * `skills/<name>/SKILL.md`; a `--share` transcript line that mentions a skill and the name.
 */
export function detectCopilotTrigger(lines, transcript, name) {
  const pathRe = new RegExp(`skills[\\\\/]${RegExp.escape(name)}[\\\\/]SKILL\\.md`);
  let method = null;
  for (const ev of events(lines)) {
    walkJson(ev, (o) => {
      if (method) return;
      const kind = [o.type, o.kind, o.tool, o.toolName, o.name, o.event].filter((x) => typeof x === 'string').join(' ');
      if (/skill/i.test(kind) && ['skill', 'skillName', 'skill_name', 'name', 'id'].some((k) => named(o[k], name))) {
        method = 'jsonl-skill-event';
      } else if (Object.values(o).some((x) => typeof x === 'string' && pathRe.test(x))) method = 'jsonl-skill-path';
    });
    if (method) break;
  }
  // The quoted prompt (`> ...`) in the transcript is not a skill load.
  const mentions = (l) => /skill/i.test(l) && (l.includes(name) || pathRe.test(l)) && !/^\s*>/.test(l);
  if (!method && String(transcript || '').split(/\r?\n/).some(mentions)) method = 'share-transcript';
  return { triggered: Boolean(method), method };
}

/** Codex `exec --json`: reading the skill's SKILL.md (or running its scripts) is implicit invocation. */
export function detectCodexTrigger(lines, name) {
  const re = new RegExp(`skills[\\\\/]${RegExp.escape(name)}[\\\\/](SKILL\\.md|scripts[\\\\/])`);
  const res = { triggered: false, method: null, error: null };
  for (const ev of events(lines)) {
    walkJson(ev, (o) => {
      if (Object.values(o).some((x) => typeof x === 'string' && re.test(x))) {
        Object.assign(res, { triggered: true, method: 'skill-file-read' });
      }
    });
    if (res.triggered) break;
    if (ev.type === 'error' || ev.type === 'turn.failed') {
      res.error = String(ev.message || ev.error?.message || 'error').slice(0, 200);
    }
  }
  return res.triggered ? { ...res, error: null } : res;
}

/** Per-query pass rates (errors count as misbehaving runs), suite score, split scores and run-to-run spread. */
export function scoreTriggerRuns(queries, runsById, { runs = 3, queryThreshold = 0.5 } = {}) {
  const results = queries.map((q) => {
    const rs = runsById[q.id] || [];
    const behaved = rs.filter((r) => r.triggered === q.should_trigger).length;
    const rate = behaved / (Math.max(runs, rs.length) || 1);
    return { id: q.id, split: q.split, should_trigger: q.should_trigger, runs: rs, behaved,
      errors: rs.filter((r) => r.triggered == null).length,
      triggered: rs.filter((r) => r.triggered === true).length, pass_rate: Number(rate.toFixed(4)),
        passed: rate > queryThreshold };
  });
  const share = (list) => (list.length ? Number((list.filter((r) => r.passed).length / list.length).toFixed(4)) : null);
  const perRun = Array.from({ length: Math.max(0, ...results.map((r) => r.runs.length)) },
    (_, k) => results.filter((r) => r.runs[k]?.triggered === r.should_trigger).length / (results.length || 1));
  const mean = perRun.reduce((a, b) => a + b, 0) / (perRun.length || 1);
  const sd = perRun.length > 1 ? Math.sqrt(perRun.reduce((a, b) => a + (b - mean) ** 2, 0) / perRun.length) : 0;
  return { results, per_query_pass_rate: Object.fromEntries(results.map((r) => [r.id, r.pass_rate])),
    suite_score: share(results),
    train_score: share(results.filter((r) => r.split === 'train')),
      validation_score: share(results.filter((r) => r.split === 'validation')),
    run_scores: perRun.map((x) => Number(x.toFixed(4))), sd: Number(sd.toFixed(4)),
      errors: results.reduce((a, r) => a + r.errors, 0) };
}

/** A host CLI: `--cli` or `ADC_<HOST>_CLI` (an executable or a .mjs/.js script run with this Node), else PATH. */
function resolveCli(host, cli = null, cwd = process.cwd()) {
  cli ||= process.env[`ADC_${host.toUpperCase()}_CLI`] || null;
  if (cli && /\.(mjs|cjs|js)$/i.test(cli)) {
    const abs = path.resolve(cwd, cli);
    if (!fs.existsSync(abs)) throw usageError(`--cli script not found: ${toPosix(cli)}`);
    return { cmd: process.execPath, prefix: [abs], label: toPosix(cli) };
  }
  const exe = which(cli || host) || (cli && fs.existsSync(path.resolve(cwd, cli)) ? path.resolve(cwd, cli) : null);
  if (!exe) throw envError('NO_HOST_CLI',
    cli ? `--cli ${cli} was not found` : `${host} is not on PATH; install it or pass --cli <path>`);
  return { cmd: exe, prefix: [], label: toPosix(exe) };
}

const hostCli = (host) => { try { return resolveCli(host); } catch { return null; } };
const runCli = (cli, args, opts) => runTool(cli.cmd, [...cli.prefix, ...args], opts);

async function runOneTrigger({ host, cli, skill, query, ws, opts, budgetLeft }) {
  const env = { ...process.env, COPILOT_AUTO_UPDATE: 'false', ADC_TRIGGER_EVAL: '1' };
  delete env.CLAUDECODE;
  // A Windows .cmd shim runs through cmd.exe, where these characters would be interpreted.
  const q = IS_WINDOWS && !cli.prefix.length && !/\.exe$/i.test(cli.cmd) ? query.replace(/["%^&|<>!\r\n]/g, ' ')
    : query;
  const model = opts.model ? ['--model', opts.model] : [];
  const share = host === 'copilot' ? path.join(ws, `.share-${nonce().slice(0, 8)}.md`) : null;
  const args = {
    claude: ['-p', q, '--output-format', 'stream-json', '--verbose', '--tools', 'Skill,Read,Glob,Grep',
      '--permission-mode', 'dontAsk',
      '--no-session-persistence', ...model,
        ...(budgetLeft != null ? ['--max-budget-usd', Math.max(0.01, Math.min(1, budgetLeft)).toFixed(2)] : [])],
    copilot: ['-p', q, '--output-format', 'json', '--no-ask-user', '--trust-folder', '--share', share, ...model],
    codex: ['exec', '--json', '--ephemeral', '--skip-git-repo-check', ...model, q],
  }[host];
  const lines = [];
  let early = false;
  const detectNow = { claude: (l) => detectClaudeTrigger(l, skill.name),
    codex: (l) => detectCodexTrigger(l, skill.name) }[host];
  const res = await spawnCapture(cli.cmd, [...cli.prefix, ...args], {
    cwd: ws, env, timeoutMs: opts.timeoutMs, maxBytes: 20 * 1024 * 1024,
    // Stop as soon as the skill triggered: the rest of the turn would only add cost.
    onLine: (line) => {
      lines.push(line);
      if (detectNow?.([line]).triggered) {
        early = true;
        return 'stop';
      }
      return null;
    },
  });
  const det = detectNow ? detectNow(lines) : detectCopilotTrigger(lines, readText(share, ''), skill.name);
  if (share) fs.rmSync(share, { force: true });
  const failed = !det.triggered && !early
    && (res.error || res.timedOut || (res.exit !== 0 && res.exit !== null) || det.error);
  return { triggered: det.triggered ? true : failed ? null : false,
    method: det.method || (host === 'claude' ? 'skill-tool-call' : null),
    loaded: det.loaded ?? null, exit: res.exit, ms: res.ms, timed_out: res.timedOut, stopped_early: early,
      cost_usd: det.cost_usd ?? null,
    error: failed ? truncate(String(det.error || res.error || (res.timedOut ? 'timeout'
      : `exit ${res.exit}: ${lastLine(res.stderr)}`)), 200) : null };
}

async function runTriggerSet({ host, cli, skill, queries, runs, opts }) {
  // A fresh workspace holding only a copy of the skill: repository instructions and other skills cannot leak in.
  const base = makeTempDir('trigger');
  const ws = path.join(base, 'ws');
  const dest = path.join(ws, ...SKILL_DIRS[host].split('/'), skill.name);
  for (const f of listFiles(skill.dir, { ignore: new Set([...COPY_IGNORE, 'evals']) })) {
    ensureDir(path.dirname(path.join(dest, f)));
    fs.copyFileSync(path.join(skill.dir, f), path.join(dest, f));
  }
  ensureDir(ws);
  if (host === 'codex' && which('git')) run('git', ['init', '-q'], { cwd: ws });
  const runsById = {};
  // Claude reports the cost of each finished run. A run stopped early (the skill already
  // triggered) never prints its result event, so it is priced at the mean of the priced runs.
  const cost = { measured: 0, priced: 0, unpriced: 0 };
  const estimate = () => (cost.priced ? (cost.measured / cost.priced) * cost.unpriced : 0);
  const spent = () => cost.measured + estimate();
  const capped = host === 'claude' && opts.maxCostUsd != null;
  let partial = false;
  const jobs = queries.flatMap((q) => Array.from({ length: runs }, (_, k) => ({ q, k })));
  const worker = async () => {
    for (let j = jobs.shift(); j; j = jobs.shift()) {
      const slot = (runsById[j.q.id] ||= []);
      if (capped && spent() >= opts.maxCostUsd) {
        partial = true;
        slot[j.k] = { triggered: null, error: 'skipped: --max-cost-usd reached' };
        continue;
      }
      const r = await runOneTrigger({ host, cli, skill, query: j.q.query, ws, opts,
        budgetLeft: capped ? opts.maxCostUsd - spent() : null });
      if (typeof r.cost_usd === 'number') {
        cost.measured += r.cost_usd;
        cost.priced++;
      } else if (host === 'claude' && r.stopped_early) cost.unpriced++;
      slot[j.k] = r;
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.max(1, Math.min(8, opts.concurrency || 1)) }, worker));
  } finally {
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 });
  }
  const round = (x) => Number(x.toFixed(4));
  if (host !== 'claude') return { runsById, partial, cost_usd: null,
    cost: { method: `${host} does not report a cost per run; check your plan's usage page` } };
  return { runsById, partial, cost_usd: round(spent()),
    cost: { measured_usd: round(cost.measured), measured_runs: cost.priced, estimated_usd: round(estimate()),
    estimated_runs: cost.unpriced,
      method: 'result.total_cost_usd per run; runs stopped early are priced at the mean of the priced runs' } };
}

function triggerCommands(skillRel, setRel) {
  const base = `node "${toPosix(ADC_SCRIPT)}" tooling trigger-set `
    + `${quoteArg(skillRel)}${setRel ? ` --set ${quoteArg(setRel)}` : ''}`;
  return { claude: `${base} --host claude --run --runs 3 --max-cost-usd 10`,
    copilot: `${base} --host copilot --run --runs 3`, codex: `${base} --host codex --run --runs 3` };
}

/** The newest trigger result of a skill (by measurement time), optionally for one host and description. */
function latestResults(stateDir, slug, { host = null, descriptionSha = null } = {}) {
  const dir = path.join(statePaths(stateDir).tooling, slug);
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /^trigger-[a-z]+-.*\.json$/.test(f));
  } catch {
    return { latest: null, count: 0 };
  }
  const mine = files.map((f) => ({ file: path.join(dir, f), doc: readJson(path.join(dir, f)) }))
    .filter((x) => x.doc && (!host || x.doc.host === host))
    .sort((a, b) => String(a.doc.measured_at || '')
      .localeCompare(String(b.doc.measured_at || '')) || a.file.localeCompare(b.file));
  const matching = mine.filter((x) => !descriptionSha || x.doc.description_sha256 === descriptionSha);
  return { latest: matching.at(-1) || null, count: mine.length };
}

/**
 * Generate, validate and (with `runIt`, paid) execute a skill's trigger set headless.
 * Returns `{ queries[], results[], per_query_pass_rate, suite_score, ... }`.
 */
export async function triggerSet({
  ctx, root, skillPath, setPath = null, init = false, host = null, runIt = false, runs = null, threshold = null,
  queryThreshold = null, split = 'all', cli = null, model = null, maxCostUsd = null, timeoutS = 180, concurrency = 1,
  resultsFile = null, force = false,
} = {}) {
  const skill = skillInfo(root, ctx.cwd, skillPath);
  const setAbs = setPath ? userPath(ctx, setPath) : path.join(skill.dir, 'evals', 'trigger-set.json');
  const setRel = relOf(root, setAbs);
  const out = { skill: skill.name, skill_dir: skill.rel, set_path: setRel,
    description_sha256: skill.description_sha256, host: host || null };
  if (init) out.init = writeOutputs([{ path: setRel, content: triggerSetTemplate(skill.name), host: 'eval' }],
    { root, dryRun: ctx.dryRun, force, backupDir: backups(ctx, root) });
  if (!fs.existsSync(setAbs)) {
    if (ctx.dryRun && init) return { ...out, queries: [], results: [], per_query_pass_rate: {}, suite_score: null,
      ready: false, next_steps: ['Dry run: re-run without --dry-run to write the trigger set template.'] };
    throw usageError(`no trigger set at ${setRel}; create one with: tooling trigger-set ${skill.rel} --init`);
  }
  const set = loadTriggerSet(setAbs);
  // Flags win; otherwise the set's own runs / query_threshold / suite_threshold; then 3, 0.5, 0.8.
  runs = Number(runs ?? set.doc.runs ?? 3);
  threshold = Number(threshold ?? set.doc.suite_threshold ?? 0.8);
  queryThreshold = Number(queryThreshold ?? set.doc.query_threshold ?? 0.5);
  if (!(threshold >= 0 && threshold <= 1) || !(queryThreshold >= 0 && queryThreshold < 1)) {
    throw usageError('thresholds must be between 0 and 1');
  }
  if (!Number.isInteger(runs) || runs < 1 || runs > 10) throw usageError('--runs must be an integer from 1 to 10');
  const queries = split === 'all' ? set.queries : set.queries.filter((q) => q.split === split);
  Object.assign(out, { set_sha256: set.sha256, ready: set.todo.length === 0, todo: set.todo,
    warnings: [...set.warnings], queries, runs,
    query_threshold: queryThreshold, threshold, split });
  if (runIt && ctx.dryRun) {
    out.warnings.push('dry run: nothing was run (trigger runs are paid and write results)');
    runIt = false;
  }
  let runsById = null;
  let state = null;
  if (resultsFile) {
    const prev = readJson(path.resolve(ctx.cwd, resultsFile));
    if (!Array.isArray(prev?.results)) throw usageError(`${resultsFile}: not a trigger-set results file`);
    runsById = Object.fromEntries(prev.results.map((r) => [r.id, r.runs || []]));
    Object.assign(out, { host: prev.host || host, imported_from: toPosix(resultsFile) });
    if (prev.description_sha256 && prev.description_sha256 !== skill.description_sha256) {
      out.warnings.push('the imported results were measured on a different description');
    }
  } else if (runIt) {
    if (!host) throw usageError('--run needs --host claude|copilot|codex');
    if (!out.ready) throw usageError(
      `the trigger set still has TODO queries (${set.todo.slice(0, 5).join(', ')}); write real queries first`);
    const cliInfo = resolveCli(host, cli, ctx.cwd);
    state = openState(ctx, root); // created only for a run that really starts (results and metrics go there)
    out.iteration = latestResults(state.dir, artifactSlug(skill.rel), { host }).count + 1;
    if (out.iteration > 5) out.warnings.push(`iteration ${out.iteration}: more than 5 revisions against this set `
      + `risks overfitting; write 5-10 fresh queries`);
    const personal = path.join(hostHomes().claude, 'skills', skill.name);
    if (host === 'claude' && fs.existsSync(personal) && path.resolve(personal) !== path.resolve(skill.dir)) {
      out.warnings.push(
        `a personal skill ${toPosix(personal)} has the same name and takes precedence over the copy under test`);
    }
    if (host !== 'claude' && maxCostUsd != null) out.warnings.push(`--max-cost-usd applies to Claude Code only; `
      + `${host} reports no per-run cost, so cap spend with --runs and the query count`);
    const r = await runTriggerSet({ host, cli: cliInfo, skill, queries, runs,
      opts: { model, maxCostUsd: maxCostUsd ?? (host === 'claude' ? 10 : null), timeoutMs: timeoutS * 1000,
        concurrency } });
    runsById = r.runsById;
    Object.assign(out, { cli: cliInfo.label, cost_usd: r.cost_usd, cost: r.cost, partial: r.partial,
      measured_at: nowIso(),
      method: { claude: 'claude -p stream-json: Skill tool call',
        copilot: 'copilot -p JSONL + --share transcript (unconfirmed, Appendix C)',
        codex: 'codex exec --json: SKILL.md read' }[host],
      confidence: { claude: 'high', copilot: 'unconfirmed', codex: 'medium' }[host] });
  }
  if (!runsById) {
    const commands = triggerCommands(skill.rel, setPath ? setRel : null);
    return { ...out, results: [], per_query_pass_rate: {}, suite_score: null, commands,
      next_steps: [out.ready ? `Run it (${PAID_NOTE}): ${commands[host || 'claude']}`
        : `Replace the TODO queries in ${setRel}, then run it.`] };
  }
  const scored = scoreTriggerRuns(queries, runsById, { runs, queryThreshold });
  Object.assign(out, scored, { passed: scored.suite_score != null && scored.suite_score >= threshold });
  if (state) {
    const file = path.join(statePaths(state.dir).tooling, artifactSlug(skill.rel), `trigger-${host}-${tsId()}.json`);
    writeJsonAtomic(file, out);
    out.results_path = relOf(root, file);
    appendMetrics(state.dir,
      { kind: 'tooling-trigger-set', skill: skill.name, host, suite_score: out.suite_score, sd: out.sd,
      cost_usd: out.cost_usd ?? null,
      description_sha256: skill.description_sha256 });
  }
  return out;
}

const triggerSetCommand = defineCommand({
  name: 'tooling trigger-set',
  usage: 'tooling trigger-set [skill-dir] [--init] [--set file] [--host claude|copilot|codex] [--run] [--runs 3] '
    + '[--threshold 0.8] [--query-threshold 0.5] [--split all|train|validation] [--cli path] [--model m] '
    + '[--max-cost-usd 10] [--timeout-s 180] [--concurrency 1] [--results file] [--force]',
  options: {
    ...Object.fromEntries(('set host runs threshold query-threshold split cli model max-cost-usd timeout-s concurrency '
      + 'results').split(' ').map((k) => [k, { type: 'string' }])),
    init: { type: 'boolean' }, run: { type: 'boolean' }, force: { type: 'boolean' },
  },
  async run(ctx, values, positionals) {
    const root = rootOf(ctx);
    checkState(ctx, root);
    if (values.host && !HOSTS.includes(values.host)) throw usageError('--host must be claude, copilot or codex');
    const split = values.split || 'all';
    if (!['all', 'train', 'validation'].includes(split)) throw usageError('--split must be all, train or validation');
    const res = await triggerSet({ ctx, root, skillPath: positionals[0] || '.', setPath: values.set || null,
      init: Boolean(values.init), host: values.host || null,
      runIt: Boolean(values.run), runs: numberOption(values, 'runs', null, { integer: true }),
        threshold: numberOption(values, 'threshold', null, { allowZero: true }),
      queryThreshold: numberOption(values, 'query-threshold', null, { allowZero: true }), split,
        cli: values.cli || null, model: values.model || null,
      maxCostUsd: numberOption(values, 'max-cost-usd'), timeoutS: numberOption(values, 'timeout-s', 180),
      concurrency: numberOption(values, 'concurrency', 1, { integer: true }), resultsFile: values.results || null,
        force: Boolean(values.force) });
    const total = res.results.reduce((a, r) => a + r.runs.length, 0) || 1;
    // More than half of the runs errored: that is no measurement (exit 4), not a low score.
    const exit = res.suite_score == null ? EXIT.OK : res.errors / total > 0.5 ? EXIT.UNVERIFIABLE : res.passed
      ? EXIT.OK : EXIT.FINDINGS;
    const summary = res.suite_score == null
      ? `${res.queries.length} queries (${res.ready ? 'ready' : `${res.todo.length} TODO`}); not run`
      : `${res.host}: suite score ${res.suite_score} (threshold ${res.threshold}), train ${res.train_score}, `
        + `validation ${res.validation_score}${res.cost_usd != null ? `, $${res.cost_usd}` : ''}`;
    return { result: res, exit, summary };
  },
});

// ---------------------------------------------------------------------------
// Safe-change loop (§11.6)

/** tooling-lint results as comparable rows; a key ignores line numbers so moved text is not a new error. */
async function lintArtifact(root, absPaths, { strict = false } = {}) {
  try {
    const r = await lintPaths(absPaths, { host: 'all', strict, root });
    const row = (file, host, e) => {
      const message = String(e?.message ?? e);
      const rule = e?.rule || e?.id || null;
      return { file: relOf(root, path.resolve(root, String(file ?? ''))), host, rule, message,
        key: `${host}|${rule}|${message.replace(/\d+/g, '#')}` };
    };
    const errors = [];
    const warnings = [];
    for (const f of r.files) {
      for (const hr of f.host_results) {
        errors.push(...hr.errors.map((e) => row(f.path, hr.host, e)));
        warnings.push(...hr.warnings.map((w) => row(f.path, hr.host, w)));
      }
    }
    for (const s of r.security) (s.severity === 'error' ? errors : warnings).push(row(s.file, 'security', s));
    return { status: 'ok', errors, warnings };
  } catch (err) {
    return { status: 'error', reason: truncate(String(err?.message || err), 200), errors: [], warnings: [] };
  }
}

const artifactFiles = (root, rel) => (isDir(absOf(root, rel))
  ? listFiles(absOf(root, rel), { ignore: COPY_IGNORE, maxFiles: 2000 }).map((f) => `${rel}/${f}`) : [rel]);
const contentDigest = (root, files) => sha256([...files].sort().map((f) => `${f}\0${readText(absOf(root, f), '')}`)
  .join('\0'));

/** The context a host renders from the artifact: listing entry and body, imports inlined, configs normalized. */
function renderContext(root, rel, cls) {
  const abs = absOf(root, rel);
  const dir = isDir(abs);
  const file = dir ? path.join(abs, 'SKILL.md') : abs;
  const text = readText(file, '');
  if (['skill', 'agent', 'command'].includes(cls.kind)) {
    const fm = parseFrontmatter(text);
    const name = String(fm.data.name ?? path.basename(dir ? abs : file).replace(/\.agent\.md$|\.md$/, ''));
    return `<available_skills>\n<skill>\n<name>${name}</name>\n`
      + `<description>${oneLine(fm.data.description)}</description>\n</skill>\n`
      + `</available_skills>\n\n--- body (on demand) ---\n${fm.body}`;
  }
  if (cls.kind === 'instructions' || cls.kind === 'scoped') {
    const inl = inlineImports(text, file).text;
    return HOSTS.map((h) => `--- ${h} ---\n${h === 'claude' ? stripHtmlComments(inl) : h === 'codex' ? text : inl}`)
      .join('\n');
  }
  try {
    if (cls.kind === 'hooks') return JSON.stringify(parseHookConfig(text, cls.host, rel).entries, null, 2);
    if (cls.kind === 'mcp') return JSON.stringify(parseMcpConfig(text, cls.dialect, rel).servers, null, 2);
  } catch { /* an unparsable config is compared as text */ }
  return text;
}

/** Replace machine-specific paths so snapshots from two runs diff cleanly. */
function scrubPaths(text, root) {
  let out = String(text || '');
  const homes = hostHomes();
  for (const [p, label] of [[root, '<repo>'], [homes.codex, '<codex-home>'], [homes.home, '~']]) {
    for (const v of new Set([p, toPosix(p), realPath(p), toPosix(realPath(p))])) {
      if (v && v.length > 1) out = out.split(v).join(label);
    }
  }
  return out;
}

/** The first JSON value in CLI output that may carry warning lines around it. */
function firstJson(text) {
  const s = String(text || '').trim();
  try { return JSON.parse(s); } catch { /* look for the first line that starts JSON */ }
  const k = s.search(/^[[{]/m);
  try { return k < 0 ? null : JSON.parse(s.slice(k)); } catch { return null; }
}

/**
 * Rendered-context snapshots from the hosts' own free, sign-in-free commands (§11.6 step 1):
 * `skills-ref to-prompt`, `copilot instruction list --json` / `copilot skill list --json`, and the
 * skills and AGENTS.md parts of `codex debug prompt-input`. Run with --external.
 */
function externalSnapshots(root, rel, cls) {
  const out = [];
  const abs = absOf(root, rel);
  const snap = (name, r, value) => out.push({ name, exit: r.exit,
    output: value != null ? scrubPaths(value, root) : truncate(r.stderr || r.stdout, 2000) });
  if (cls.kind === 'skill' && which('skills-ref')) {
    const r = run('skills-ref', ['to-prompt', isDir(abs) ? abs : path.dirname(abs)], { timeoutMs: 30_000 });
    snap('skills-ref to-prompt', r, truncate(r.stdout || r.stderr, 200_000));
  }
  const sub = ['instructions', 'scoped'].includes(cls.kind) ? 'instruction' : cls.kind === 'skill' ? 'skill' : null;
  const copilot = sub && hostCli('copilot');
  if (copilot) {
    const r = runCli(copilot, [sub, 'list', '--json'],
      { cwd: root, timeoutMs: 60_000, env: { ...process.env, COPILOT_AUTO_UPDATE: 'false' } });
    const rows = firstJson(r.stdout);
    snap(`copilot ${sub} list --json`, r,
      Array.isArray(rows) ? JSON.stringify(rows.filter((x) => x?.source !== 'builtin'), null, 2) : null);
  }
  const codex = sub && hostCli('codex');
  if (codex) {
    const r = runCli(codex, ['debug', 'prompt-input', 'hello'], { cwd: root, timeoutMs: 60_000 });
    const texts = [];
    walkJson(firstJson(r.stdout), (o) => {
      if (/^(<skills_instructions>|# AGENTS\.md instructions)/.test(o.text ?? '')) texts.push(o.text);
    });
    snap('codex debug prompt-input (skills and AGENTS.md)', r, texts.length ? texts.join('\n\n') : null);
  }
  return out;
}

/** `claude plugin eval --json` results: overall score and the standard error of the case scores. */
function readOutcome(file) {
  if (!file) return { status: 'not-measured', score: null };
  const doc = readJson(file);
  if (!doc) throw usageError(`--outcome-results ${toPosix(file)}: not valid JSON`);
  const score = doc.aggregates?.overallScore ?? doc.overallScore ?? doc.score ?? null;
  if (typeof score !== 'number') throw usageError(`--outcome-results ${toPosix(file)}: no aggregates.overallScore `
    + `(claude plugin eval --json output expected)`);
  const cs = (Array.isArray(doc.cases) ? doc.cases : []).map((c) => c?.aggregates?.score)
    .filter((x) => typeof x === 'number');
  const mean = cs.length ? cs.reduce((a, b) => a + b, 0) / cs.length : score;
  const sd = cs.length > 1 ? Math.sqrt(cs.reduce((a, b) => a + (b - mean) ** 2, 0) / cs.length) / Math.sqrt(cs.length)
    : 0;
  return { status: 'measured', score, sd: Number(sd.toFixed(4)), partial: Boolean(doc.partial), source: toPosix(file) };
}

/** All measurements of one artifact (§11.6 steps 1 and 3). */
export async function measureArtifact({
  ctx, root, rel, state, strict = false, outcomeResults = null, external = false, triggerHost = null,
  runTriggers = false, triggerOpts = {},
}) {
  const abs = absOf(root, rel);
  if (!fs.existsSync(abs)) throw usageError(`not found: ${rel}`);
  const dir = isDir(abs);
  const cls = classifyArtifact(dir ? `${rel}/SKILL.md` : rel);
  if (!cls) throw usageError(
    `${rel} is not a recognized tooling file (instructions, skill, agent, prompt, command, hooks or MCP config)`);
  const files = artifactFiles(root, rel);
  const lint = await lintArtifact(root, [abs], { strict });
  const cost = toolingCost({ root, artifacts: discoverTooling(root, { paths: [abs] }) });
  const bad = new Set(lint.errors.map((e) => e.host));
  const m = { artifact: rel, kind: cls.kind, host: cls.host, measured_at: nowIso(), files,
    content_sha256: contentDigest(root, files), lint,
    cost: { per_host: Object.fromEntries(HOSTS.map((h) => [h,
      { always_on_tokens: cost.totals[h].always_on_tokens, on_demand_tokens: cost.totals[h].on_demand_tokens }])),
      max_always_on_tokens: cost.totals.max_always_on_tokens },
    trigger: { status: 'not-applicable' }, outcome: readOutcome(outcomeResults),
    // Portability: the hosts that load the artifact from its location without lint errors.
    hosts: cls.hosts.filter((h) => !bad.has(h) && !bad.has('security')), external: [] };
  if (cls.kind === 'skill') {
    const skill = skillInfo(root, root, dir ? rel : path.posix.dirname(rel));
    const sha = (m.description_sha256 = skill.description_sha256);
    m.trigger = { status: 'not-measured', description_sha256: sha };
    if (runTriggers) {
      const r = await triggerSet({ ctx, root, skillPath: absOf(root, skill.rel), host: triggerHost || 'claude',
        runIt: true, ...triggerOpts });
      m.trigger = { status: 'measured', host: r.host, suite_score: r.suite_score, sd: r.sd,
        results_path: r.results_path, description_sha256: sha };
    } else if (state) {
      // The latest score measured on the same name and description still describes this artifact.
      const found = latestResults(state.dir, artifactSlug(skill.rel),
        { host: triggerHost, descriptionSha: sha }).latest;
      if (found) m.trigger = { status: 'measured', host: found.doc.host, suite_score: found.doc.suite_score,
        sd: found.doc.sd ?? 0, results_path: relOf(root, found.file), description_sha256: sha };
    }
  }
  // The context is stored and its diff printed: a literal credential (an MCP env value) never is.
  const redact = makeRedactor();
  m.context = redact(renderContext(root, rel, cls));
  if (external) m.external = externalSnapshots(root, rel, cls).map((e) => ({ ...e, output: redact(e.output) }));
  return m;
}

const baselineRoot = (stateDir, rel) => path.join(statePaths(stateDir).tooling, artifactSlug(rel), 'baselines');

function latestBaseline(stateDir, rel) {
  const dir = baselineRoot(stateDir, rel);
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => fs.existsSync(path.join(dir, n, 'baseline.json'))).sort();
  } catch {
    return null;
  }
  if (!names.length) return null;
  const d = path.join(dir, names.at(-1));
  const doc = readJson(path.join(d, 'baseline.json'));
  if (!doc) return null;
  doc.context = readText(path.join(d, 'context.txt'), '');
  doc.external = (doc.external || [])
    .map((e, k) => ({ ...e, output: readText(path.join(d, `external-${k}.txt`), '') }));
  return { dir: d, doc };
}

function saveBaseline(root, stateDir, rel, measurement) {
  const dir = path.join(baselineRoot(stateDir, rel), tsId());
  for (const f of measurement.files) {
    const to = path.join(dir, 'files', ...f.split('/'));
    ensureDir(path.dirname(to));
    fs.copyFileSync(absOf(root, f), to);
  }
  const { context, external = [], ...rest } = measurement;
  writeFileAtomic(path.join(ensureDir(dir), 'context.txt'), context || '');
  external.forEach((e, k) => writeFileAtomic(path.join(dir, `external-${k}.txt`), e.output || ''));
  writeJsonAtomic(path.join(dir, 'baseline.json'),
    { schema: 'adc-tooling-baseline/1', ...rest, external: external.map((e) => ({ name: e.name, exit: e.exit })) });
  return dir;
}

/** Copy a baseline's files back; paths that would leave the repository are never written. */
function restoreFiles(root, base, dryRun) {
  const restored = [];
  for (const f of base.doc.files || []) {
    const from = path.join(base.dir, 'files', ...f.split('/'));
    if (path.isAbsolute(f) || f.split('/').includes('..') || !fs.existsSync(from)) continue;
    if (!dryRun) { ensureDir(path.dirname(absOf(root, f))); fs.copyFileSync(from, absOf(root, f)); }
    restored.push(f);
  }
  return restored;
}

function lineDiff(a, b, max = 40) {
  const [A, B] = [String(a).split('\n'), String(b).split('\n')];
  const [setA, setB] = [new Set(A), new Set(B)];
  const removed = A.filter((l) => !setB.has(l));
  const added = B.filter((l) => !setA.has(l));
  return { added: added.length, removed: removed.length,
    sample: [...removed.slice(0, max / 2).map((l) => `- ${truncate(l, 160)}`),
      ...added.slice(0, max / 2).map((l) => `+ ${truncate(l, 160)}`)] };
}

/** Deltas and the acceptance rule (§11.6 step 4). */
export function compareMeasurements(before, after, { note = null } = {}) {
  const failing = [];
  const unverified = [];
  const deltas = {};
  if (before.lint?.status === 'ok' && after.lint?.status === 'ok') {
    const [had, now] = [new Set(before.lint.errors.map((e) => e.key)), new Set(after.lint.errors.map((e) => e.key))];
    const added = after.lint.errors.filter((e) => !had.has(e.key));
    deltas.lint = { status: 'measured', errors_before: before.lint.errors.length,
      errors_after: after.lint.errors.length, new_errors: added,
      fixed: before.lint.errors.filter((e) => !now.has(e.key)).length, warnings_before: before.lint.warnings.length,
        warnings_after: after.lint.warnings.length };
    if (added.length) failing.push(`lint: ${added.length} new error(s)`);
  } else deltas.lint = { status: 'not-measured',
    reason: after.lint?.reason || before.lint?.reason || 'lint unavailable' };
  const tok = Object.fromEntries(HOSTS.map((h) => {
    const [b, a] = [before.cost?.per_host?.[h]?.always_on_tokens ?? 0,
      after.cost?.per_host?.[h]?.always_on_tokens ?? 0];
    return [h, { before: b, after: a, delta: a - b }];
  }));
  const up = Object.values(tok).some((t) => t.delta > 0);
  deltas.tokens = { per_host: tok, increased: up, decreased: Object.values(tok).some((t) => t.delta < 0),
    justified_by_note: Boolean(up && note) };
  if (up && !note) failing.push('tokens: always-on context cost went up without a change note (--note)');
  // Trigger and outcome scores may not fall below the baseline by more than the measured spread.
  for (const [key, sk] of [['trigger', 'suite_score'], ['outcome', 'score']]) {
    const [b, a] = [before[key], after[key]];
    if (b?.status === 'measured' && a?.status === 'measured') {
      const tolerance = Math.max(b.sd || 0, a.sd || 0);
      const delta = Number((a[sk] - b[sk]).toFixed(4));
      deltas[key] = { status: 'measured', before: b[sk], after: a[sk], delta, tolerance };
      if (delta < -tolerance - 1e-9) failing.push(
        `${key}: score fell from ${b[sk]} to ${a[sk]} (tolerance ${tolerance})`);
    } else if (b?.status === 'measured') {
      deltas[key] = { status: 'not-remeasured', before: b[sk], after: null };
      unverified.push(`${key}: measured in the baseline but not after the change`);
    } else deltas[key] = { status: a?.status === 'measured' ? 'no-baseline' : 'not-measured', after: a?.[sk] ?? null };
  }
  const [hb, ha] = [before.hosts || [], after.hosts || []];
  deltas.hosts = { before: hb, after: ha, lost: hb.filter((h) => !ha.includes(h)),
    gained: ha.filter((h) => !hb.includes(h)) };
  if (deltas.hosts.lost.length) failing.push(`portability: no longer loads in ${deltas.hosts.lost.join(', ')}`);
  deltas.context = lineDiff(before.context ?? '', after.context ?? '');
  // Host-rendered context (with --external): informational, like the golden transcripts.
  const ext = Object.fromEntries((after.external || [])
    .map((a) => [a.name, (before.external || []).find((x) => x.name === a.name)])
    .filter(([, b]) => typeof b?.output === 'string')
      .map(([n, b]) => [n, lineDiff(b.output, after.external.find((x) => x.name === n).output || '')]));
  if (Object.keys(ext).length) deltas.external = ext;
  return { verdict: failing.length ? 'reject' : unverified.length ? 'unverified' : 'accept', failing, unverified,
    deltas };
}

function changelogEntry(rel, cmp, note) {
  const t = cmp.deltas.tokens.per_host;
  const tokens = HOSTS.filter((h) => t[h].before || t[h].after).map((h) => `${h} ${t[h].before} -> ${t[h].after}`);
  const parts = [`always-on tokens ${tokens.join(', ') || 'unchanged'}`];
  for (const k of ['trigger', 'outcome']) {
    if (cmp.deltas[k].status === 'measured') parts.push(`${k} ${cmp.deltas[k].before} -> ${cmp.deltas[k].after}`);
  }
  if (cmp.deltas.lint.status === 'measured') parts.push(
    `lint errors ${cmp.deltas.lint.errors_before} -> ${cmp.deltas.lint.errors_after}`);
  return `- \`${rel}\`: ${note || 'tooling change'} (${parts.join('; ')}; `
    + `verified with tooling modify compare on ${today()}).`;
}

/** Insert `entry` under `## [Unreleased]` / `### Changed` (created when missing); CRLF files stay CRLF. */
function insertChangelog(text, entry) {
  if (!text?.trim()) return `# Changelog\n\n## [Unreleased]\n\n### Changed\n\n${entry}\n`;
  const crlf = text.includes('\r\n');
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const u = lines.findIndex((l) => /^##\s+\[?Unreleased\]?/i.test(l));
  if (u < 0) {
    const h2 = lines.findIndex((l) => /^##\s/.test(l));
    lines.splice(h2 < 0 ? lines.length : h2, 0, ...(h2 < 0 ? [''] : []), '## [Unreleased]', '', '### Changed', '',
      entry, '');
  } else {
    const next = lines.findIndex((l, i) => i > u && /^##\s/.test(l));
    const changed = lines.findIndex((l, i) => i > u && /^###\s+Changed/i.test(l));
    if (changed > u && (next < 0 || changed < next)) {
      let k = changed + 1;
      while (k < lines.length && lines[k].trim() === '') k++;
      lines.splice(k, 0, entry);
    } else lines.splice(u + 1, 0, '', '### Changed', '', entry);
  }
  return lines.join(crlf ? '\r\n' : '\n');
}

function bumpSemver(v, kind) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v || ''));
  if (!m) return null;
  const [maj, min, pat] = m.slice(1).map(Number);
  return kind === 'major' ? `${maj + 1}.0.0` : kind === 'minor' ? `${maj}.${min + 1}.0` : `${maj}.${min}.${pat + 1}`;
}

/** Bump metadata.version in a SKILL.md (in place, only that line) or version in a plugin.json. */
function bumpVersion(root, rel, cls, kind) {
  if (kind === 'none' || !['skill', 'plugin'].includes(cls.kind)) return null;
  const abs = absOf(root, rel);
  if (cls.kind === 'plugin') {
    const doc = readJson(abs);
    if (!doc?.version) return { file: rel, from: null, to: null, reason: 'no version field (commits drive updates)' };
    const to = bumpSemver(doc.version, kind);
    if (to) writeFileAtomic(abs, json({ ...doc, version: to }));
    return { file: rel, from: doc.version, to, ...(to ? {} : { reason: 'not semantic versioning' }) };
  }
  const file = isDir(abs) ? path.join(abs, 'SKILL.md') : abs;
  const lines = readText(file, '').split('\n');
  const close = lines.findIndex((l, i) => i > 0 && l.replace(/\r$/, '') === '---');
  let inMeta = false;
  for (let i = 1; lines[0]?.replace(/\r$/, '') === '---' && i < close; i++) {
    const l = lines[i].replace(/\r$/, '');
    if (/^metadata:\s*$/.test(l)) { inMeta = true; continue; }
    if (/^\S/.test(l)) inMeta = false;
    const m = inMeta && /^(\s+version:\s*)(["']?)([^"'\s]+)\2(\s*)$/.exec(l);
    if (!m) continue;
    const to = bumpSemver(m[3], kind);
    if (to) {
      lines[i] = `${m[1]}"${to}"${m[4]}${lines[i].endsWith('\r') ? '\r' : ''}`;
      writeFileAtomic(file, lines.join('\n'));
    }
    return { file: relOf(root, file), from: m[3], to, ...(to ? {} : { reason: 'not semantic versioning' }) };
  }
  return { file: relOf(root, file), from: null, to: null, reason: 'no metadata.version to bump; add one' };
}

function resolveArtifactRel(root, cwd, p) {
  if (!p) throw usageError('tooling modify needs an artifact path');
  let abs = realPath(path.resolve(cwd, p));
  if (!fs.existsSync(abs)) throw usageError(`not found: ${toPosix(p)}`);
  if (!isDir(abs) && path.basename(abs) === 'SKILL.md') abs = path.dirname(abs);
  const rel = relPosix(root, abs);
  if (!rel || rel === '.') throw usageError('the artifact must be a file or skill directory inside the repository');
  return rel;
}

const normBody = (t) => String(t || '').replace(/\r\n/g, '\n').trim();

/** Proof that a migration kept the substance: bodies, servers or hook commands are equal. */
function migrationEquivalence(kind, root, srcTexts, target) {
  const tAbs = absOf(root, target);
  const [srcRel, srcText] = Object.entries(srcTexts)[0] || ['', ''];
  const same = (src, dst, key, compared, what) => {
    const missing = src.filter((s) => !dst.some((d) => key(d) === key(s))).map((s) => s.name || s.event);
    const reason = missing.length ? `${what} missing or changed: ${missing.join(', ')}` : dst.length ? null
      : `no ${what} after migration`;
    return { equal: !reason, compared, reason };
  };
  if (kind === 'vscode-mcp-to-mcp-json') {
    return same(parseMcpConfig(srcText, 'vscode', srcRel).servers,
      parseMcpConfig(readText(tAbs, ''), 'mcpServers', target).servers,
      (s) => JSON.stringify([s.name, s.transport, s.command, s.args, s.url, Object.keys(s.env).sort(),
        Object.keys(s.headers).sort()]),
      'servers (name, transport, command, args, url, env and header names)', 'servers');
  }
  if (kind === 'copilot-hooks-to-camel') {
    return same(parseHookConfig(srcText, 'copilot', srcRel).entries,
      parseHookConfig(readText(tAbs, ''), 'copilot', target).entries,
      (e) => JSON.stringify([e.event, e.matcher || null,
        e.exec ? [e.exec.program, ...e.exec.args] : [e.posix, e.windows], e.timeout ?? 30]),
      'events, matchers, commands and timeouts after normalization', 'hook entries');
  }
  const file = isDir(tAbs) ? path.join(tAbs, 'SKILL.md') : tAbs;
  const body = normBody(parseFrontmatter(readText(file, '')).body);
  const equal = Object.values(srcTexts).some((t) => normBody(parseFrontmatter(t).body) === body);
  return { equal, compared: 'Markdown body', reason: equal ? null : 'the migrated body differs from the source body' };
}

async function migrateRun(ctx, root, values, p, common) {
  const kind = values.migrate;
  if (!MIGRATIONS[kind]) throw usageError(`--migrate must be one of ${Object.keys(MIGRATIONS).join(', ')}`);
  const state = openState(ctx, root);
  const srcAbs = absOf(root, resolveArtifactRel(root, ctx.cwd, p));
  const sources = migrationSources(kind, root, root, srcAbs);
  const srcTexts = Object.fromEntries(sources.map((s) => [s, readText(absOf(root, s), '')]));
  const before = [];
  for (const s of sources) {
    before.push(await measureArtifact({ ctx, root, rel: s, state, ...common, runTriggers: false }));
  }
  const baselines = ctx.dryRun ? [] : before.map((m) => relOf(root, saveBaseline(root, state.dir, m.artifact, m)));
  const mig = migrate(kind,
    { path: srcAbs, root, cwd: root, host: values.to || null, dryRun: ctx.dryRun, force: Boolean(values.force),
    backupDir: backups(ctx, root) });
  const report = { migration: kind, describe: mig.describe, sources: mig.sources, baselines, written: mig.written,
    skipped: mig.skipped,
    backups: mig.backups, dropped_fields: mig.dropped_fields, manual_steps: mig.manual_steps, notes: mig.notes,
      dry_run: ctx.dryRun, results: [] };
  if (ctx.dryRun) return { ...report, verdict: 'unverified',
    reason: 'dry run: nothing was migrated, so nothing was measured' };
  const targets = uniq(mig.written.filter((w) => !w.action.startsWith('would-')).map((w) => {
    const c = classifyArtifact(w.path);
    return c && c.kind !== 'skill-file' ? (c.kind === 'skill' ? c.dir : w.path) : null;
  }).filter(Boolean));
  for (const [k, t] of targets.entries()) {
    const after = await measureArtifact({ ctx, root, rel: t, state, ...common, runTriggers: false });
    const equivalence = migrationEquivalence(kind, root, srcTexts, t);
    const cmp = compareMeasurements(before[Math.min(k, before.length - 1)], after,
      { note: values.note || `migration ${kind}` });
    const lintOk = after.lint.status === 'ok';
    const failing = [...(after.lint.errors.length
      ? [`lint: ${after.lint.errors.length} error(s) in the migrated artifact`] : []),
      ...(equivalence.equal ? [] : [`equivalence: ${equivalence.reason}`]),
        ...cmp.failing.filter((f) => /^(trigger|outcome):/.test(f))];
    const unverified = [...cmp.unverified, ...(lintOk ? [] : [`lint: ${after.lint.reason || after.lint.status}`])];
    report.results.push({ artifact: t,
      lint: { status: after.lint.status, errors: after.lint.errors.length, warnings: after.lint.warnings.length },
      equivalence,
      deltas: { tokens: cmp.deltas.tokens, trigger: cmp.deltas.trigger, outcome: cmp.deltas.outcome },
      verdict: failing.length ? 'reject' : unverified.length ? 'unverified' : 'accept', failing, unverified });
    saveBaseline(root, state.dir, t, after);
  }
  const verdicts = report.results.map((r) => r.verdict);
  report.verdict = !verdicts.length ? 'unverified'
    : ['reject', 'unverified'].find((v) => verdicts.includes(v)) || 'accept';
  if (!verdicts.length) report.reason = mig.skipped.length ? 'targets exist and were not overwritten (use --force)'
    : 'nothing was written';
  appendMetrics(state.dir, { kind: 'tooling-migrate', migration: kind, sources: mig.sources, verdict: report.verdict });
  return report;
}

const summarize = (m) => ({ content_sha256: m.content_sha256, measured_at: m.measured_at, hosts: m.hosts,
  lint: m.lint && { status: m.lint.status, errors: m.lint.errors?.length ?? 0, warnings: m.lint.warnings?.length ?? 0 },
  tokens: Object.fromEntries(HOSTS.map((h) => [h, m.cost?.per_host?.[h]?.always_on_tokens ?? 0])),
  trigger: m.trigger && { status: m.trigger.status, score: m.trigger.suite_score ?? null, sd: m.trigger.sd ?? null },
  outcome: m.outcome && { status: m.outcome.status, score: m.outcome.score ?? null } });

async function modifyRun(ctx, verb, values, p) {
  const root = rootOf(ctx);
  checkState(ctx, root);
  if (values.run && !values.host) throw usageError(
    '--run needs --host claude|copilot|codex (it runs the paid trigger set)');
  const note = values.note ? String(values.note) : null;
  const common = { strict: Boolean(values.strict),
    outcomeResults: values['outcome-results'] ? path.resolve(ctx.cwd, values['outcome-results']) : null,
    external: Boolean(values.external), triggerHost: values.host || null,
      runTriggers: Boolean(values.run) && !ctx.dryRun,
    triggerOpts: { cli: values.cli || null, model: values.model || null,
      maxCostUsd: numberOption(values, 'max-cost-usd') } };
  if (verb === 'migrate') return migrateRun(ctx, root, values, p, common);
  const rel = resolveArtifactRel(root, ctx.cwd, p);
  // --dry-run measures and compares, but writes nothing (not even under .adc/).
  const state = ctx.dryRun ? checkState(ctx, root) : openState(ctx, root);
  if (verb === 'baseline') {
    const m = await measureArtifact({ ctx, root, rel, state, ...common });
    const dir = ctx.dryRun ? null : relOf(root, saveBaseline(root, state.dir, rel, m));
    const { context, ...rest } = m;
    const measure = m.kind === 'skill' && m.trigger.status !== 'measured'
      ? [`Measure triggering before the change (${PAID_NOTE}): tooling trigger-set ${rel} --host claude --run`] : [];
    return { ...rest, dry_run: ctx.dryRun, baseline_dir: dir, context_lines: lineCount(context || ''),
      next_steps: [...measure,
        `Change the artifact (one intent per change; see references/tooling-practices.md), then run: tooling modify `
        + `compare ${rel}`] };
  }
  const base = latestBaseline(state.dir, rel);
  if (!base) throw usageError(`no baseline for ${rel}; run: tooling modify baseline ${rel}`);
  const baselineDir = relOf(root, base.dir);
  if (verb === 'restore') {
    const restored = restoreFiles(root, base, ctx.dryRun);
    const extra = (fs.existsSync(absOf(root, rel)) ? artifactFiles(root, rel) : [])
      .filter((f) => !base.doc.files.includes(f));
    return { artifact: rel, restored, dry_run: ctx.dryRun, baseline_dir: baselineDir, not_in_baseline: extra,
      next_steps: extra.length
        ? [`These files were added after the baseline and were left in place: ${extra.join(', ')}`] : [] };
  }
  common.triggerHost ||= base.doc.trigger?.host || null;
  const after = await measureArtifact({ ctx, root, rel, state, ...common });
  // A score measured on the same description (trigger) or the same files (outcome) still applies.
  if (after.trigger?.status !== 'measured' && base.doc.trigger?.status === 'measured' && after.description_sha256
    && after.description_sha256 === base.doc.description_sha256) {
    after.trigger = { ...base.doc.trigger,
      reused: 'name and description unchanged, so the baseline trigger score still applies' };
  }
  if (after.outcome?.status !== 'measured' && base.doc.outcome?.status === 'measured'
    && after.content_sha256 === base.doc.content_sha256) {
    after.outcome = { ...base.doc.outcome, reused: 'content unchanged' };
  }
  const cmp = compareMeasurements(base.doc, after, { note });
  const out = { artifact: rel, baseline_dir: baselineDir, unchanged: after.content_sha256 === base.doc.content_sha256,
    before: summarize(base.doc),
    after: summarize(after), deltas: cmp.deltas, verdict: cmp.verdict, failing: cmp.failing, unverified: cmp.unverified,
    changelog_entry: changelogEntry(rel, cmp, note), recorded: null, restored: null };
  if (!ctx.dryRun) {
    writeJsonAtomic(path.join(path.dirname(path.dirname(base.dir)), `compare-${tsId()}.json`), out);
    appendMetrics(state.dir,
      { kind: 'tooling-modify', artifact: rel, verdict: cmp.verdict, tokens: cmp.deltas.tokens.per_host,
      trigger: cmp.deltas.trigger, outcome: cmp.deltas.outcome });
  }
  if (values.accept && cmp.verdict !== 'accept') out.recorded = { refused: `verdict is ${cmp.verdict}: `
    + `${[...cmp.failing, ...cmp.unverified].join('; ')}` };
  else if (values.accept && ctx.dryRun) out.recorded = { dry_run: true };
  else if (values.accept) {
    const clFile = path.join(root, 'CHANGELOG.md');
    writeFileAtomic(clFile, insertChangelog(readText(clFile, ''), out.changelog_entry));
    const version = bumpVersion(root, rel, classifyArtifact(isDir(absOf(root, rel)) ? `${rel}/SKILL.md` : rel),
      values.bump || 'patch');
    // The accepted state becomes the regression reference for the next change.
    const fresh = await measureArtifact({ ctx, root, rel, state, ...common, runTriggers: false });
    if (fresh.trigger?.status !== 'measured' && fresh.description_sha256 === after.description_sha256) {
      fresh.trigger = after.trigger;
    }
    if (fresh.outcome?.status !== 'measured') fresh.outcome = after.outcome;
    out.recorded = { changelog: 'CHANGELOG.md', version,
      baseline_dir: relOf(root, saveBaseline(root, state.dir, rel, fresh)) };
  }
  if (values.restore && cmp.verdict === 'reject') out.restored = { files: restoreFiles(root, base, ctx.dryRun),
    dry_run: ctx.dryRun };
  return out;
}

const modifyCommand = defineCommand({
  name: 'tooling modify',
  usage: 'tooling modify baseline|compare|restore <path> [--note "why"] [--accept] [--bump patch|minor|major|none] '
    + '[--restore] [--host h --run] '
    + '[--outcome-results f] [--external] [--strict]\n       tooling modify <path> --migrate '
    + `${Object.keys(MIGRATIONS).join('|')} [--to host] [--force]`,
  options: { ...Object.fromEntries('note bump migrate to host cli model max-cost-usd outcome-results'.split(' ')
    .map((k) => [k, { type: 'string' }])),
    ...Object.fromEntries('accept restore run external strict force'.split(' ').map((k) => [k, { type: 'boolean' }])) },
  async run(ctx, values, positionals) {
    const verbs = ['baseline', 'compare', 'restore'];
    const [verb, p] = verbs.includes(positionals[0]) ? positionals
      : [values.migrate ? 'migrate' : null, positionals[0]];
    if (!verb) throw usageError('tooling modify needs baseline|compare|restore <path>, or <path> --migrate <kind>');
    if (values.bump && !['patch', 'minor', 'major', 'none'].includes(values.bump)) throw usageError(
      '--bump must be patch, minor, major or none');
    if (values.host && !HOSTS.includes(values.host)) throw usageError('--host must be claude, copilot or codex');
    const res = await modifyRun(ctx, verb, values, p);
    let exit = ['compare', 'migrate'].includes(verb)
      ? { reject: EXIT.FINDINGS, unverified: EXIT.UNVERIFIABLE }[res.verdict] ?? EXIT.OK : EXIT.OK;
    if (res.recorded?.refused) exit = EXIT.FINDINGS;
    const summary = verb === 'baseline'
      ? `baseline of ${res.artifact} `
      + `${res.baseline_dir ? `stored in ${res.baseline_dir}` : 'measured (dry run: not stored)'}`
      : verb === 'restore' ? `restored ${res.restored.length} file(s) of ${res.artifact}`
        : `${verb} ${res.artifact || res.migration}: `
          + `${res.verdict}${res.failing?.length ? ` (${res.failing.join('; ')})` : ''}`;
    return { result: res, exit, summary };
  },
});

// ---------------------------------------------------------------------------
// Plugins for the user's own projects (§11.7)

const AP_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
const MANIFESTS = ['plugin.json', '.claude-plugin/plugin.json', '.codex-plugin/plugin.json'];
const MARKETPLACES = ['.claude-plugin/marketplace.json', '.github/plugin/marketplace.json',
  '.agents/plugins/marketplace.json', 'marketplace.json',
  '.plugin/marketplace.json'];
// Agent Plugins mcp.json server variants (the schema is closed per type).
const AP_MCP_KEYS = { stdio: ['type', 'command', 'args', 'env', 'cwd'], 'streamable-http': ['type', 'url', 'headers'],
  sse: ['type', 'url', 'headers'] };

/** Problems with a plugin name for each manifest format: `{ errors[], warnings[] }`. */
export function pluginNameProblems(name) {
  const n = String(name ?? '');
  const errors = [];
  const warnings = [];
  if (!/^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/.test(n) || /--|\.\./.test(n)) errors.push('Agent Plugins name: 1-64 '
    + 'of a-z 0-9 - ., alphanumeric at both ends, no -- or ..');
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(n)) errors.push('Claude Code plugin names are kebab-case (no dots)');
  if (['claude', 'anthropic', 'claude-code', 'claude-mods'].includes(n)
    || /^(claude|anthropic|anthropics|cc-plugin)-/.test(n)) {
    errors.push('reserved by Claude Code (claude-, anthropic-, anthropics-, cc-plugin- prefixes and the names claude, '
      + 'anthropic, claude-code, claude-mods)');
  } else if (/(^|[^a-z])(claude|anthropic)([^a-z]|$)/.test(n)) warnings.push('Claude Code warns about claude or '
    + 'anthropic as a whole word in plugin names');
  return { errors, warnings };
}

/** Project skills by name (first location wins): `Map(name -> repo-relative dir)`. */
function projectSkills(root) {
  const out = new Map();
  for (const base of [SKILL_DIRS.codex, SKILL_DIRS.copilot, SKILL_DIRS.claude, CODEX_ONLY_SKILLS_DIR]) {
    let names = [];
    try {
      names = fs.readdirSync(absOf(root, base), { withFileTypes: true }).filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      continue;
    }
    for (const n of names) if (!out.has(n) && exists(root, `${base}/${n}/SKILL.md`)) out.set(n, `${base}/${n}`);
  }
  return out;
}

function readMaybe(file) {
  const text = readText(file);
  if (text == null) return { exists: false };
  try { return { exists: true, doc: JSON.parse(text) }; } catch (err) { return { exists: true, error: err.message }; }
}

/** `tooling plugin init`: package the project's own skills, agents, hooks and MCP servers. */
export async function pluginInit(ctx, values) {
  const root = rootOf(ctx);
  checkState(ctx, root);
  const hosts = parseHosts(values.for || 'all');
  const project = projectName(root);
  const name = values.name || toSkillName(project.replace(/^@[^/]+\//, ''));
  const np = pluginNameProblems(name);
  if (np.errors.length) throw usageError(`plugin name "${name}": ${np.errors.join('; ')} (pass --name)`);
  const outAbs = values.out ? userPath(ctx, values.out) : absOf(root, `plugins/${name}`);
  if (insideSkill(outAbs)) throw usageError('refusing to generate a plugin inside the companion skill (decision D10)');
  const outRel = relPosix(root, outAbs);
  if (outRel == null) throw usageError('--out must be inside the repository');
  const P = (p) => (outRel === '.' ? p : `${outRel}/${p}`);
  const description = values.description ? String(values.description)
    : `Agentic tooling for ${project}: skills, agents, hooks and MCP servers packaged for ${hosts.join(', ')}.`;
  const owner = values.owner || gitTry(root, ['config', 'user.name']) || 'Your Team';
  const version = values.version || '0.1.0';
  if (!SEMVER.test(version)) throw usageError('--version must be semantic (X.Y.Z)');
  const outputs = [];
  const manual = [...np.warnings];
  const dropped = [];
  const contents = [];
  const add = (p, content, host, kind) => outputs.push({ path: P(p), content, host, kind });
  const copy = (srcDir, f, dest, host, kind) => add(dest, fs.readFileSync(path.join(srcDir, ...f.split('/'))), host,
    kind);
  const take = (r) => { dropped.push(...(r.dropped || [])); manual.push(...(r.manual || [])); return r; };
  // Copilot reads the root Agent Plugins manifest, and so does Codex (extras under extensions["com.openai"]);
  // Codex-only plugins use the .codex-plugin manifest.
  const apManifest = hosts.includes('copilot');
  const codexManifest = hosts.includes('codex') && !apManifest;
  // Skills: by default Codex-only skills (.codex/skills, usually translated agents) join only a Codex plugin.
  const available = projectSkills(root);
  const wanted = listOpt(values.skills)
    || [...available].filter(([, rel]) => !rel.startsWith(`${CODEX_ONLY_SKILLS_DIR}/`)
    || hosts.every((h) => h === 'codex')).map(([n]) => n);
  for (const w of wanted) if (!available.has(w)) throw usageError(`--skills: no project skill named "${w}" (found: `
    + `${[...available.keys()].join(', ') || 'none'})`);
  for (const sname of wanted) {
    const srcDir = absOf(root, available.get(sname));
    // A skill's own evals/ are development material: its plugin-eval cases move to the plugin's
    // evals/ (where claude plugin eval looks; Claude Code only), the rest stays in the repository.
    for (const f of listFiles(srcDir, { ignore: new Set([...COPY_IGNORE, 'evals']) })) {
      copy(srcDir, f, `skills/${sname}/${f}`, 'all', 'skill');
    }
    const evalDir = path.join(srcDir, 'evals');
    const evalFiles = fs.existsSync(evalDir) ? listFiles(evalDir, { ignore: COPY_IGNORE }) : [];
    const cases = uniq(evalFiles.filter((f) => /^[^/]+\/(prompt\.md|case\.yaml)$/.test(f)).map((f) => f.split('/')[0]));
    if (hosts.includes('claude') && cases.length) {
      for (const f of evalFiles.filter((x) => cases.includes(x.split('/')[0]))) {
        copy(evalDir, f, `evals/${f}`, 'claude', 'eval');
      }
    } else if (hosts.includes('claude')) outputs.push(...evalOutputs(P('evals'), sname, { all: false })
      .map((o) => ({ ...o, host: 'claude', kind: 'eval' })));
    contents.push(`- Skill \`${sname}\` (from ${available.get(sname)})`);
  }
  if (!wanted.length) {
    const dsc = 'Describe in one sentence what this skill does. Use when (the requests that should trigger it). Not '
      + 'for (near-miss tasks).';
    const fm = stringifyFrontmatter({ name, description: dsc, metadata: { version: '0.1.0' } }).trimEnd();
    outputs.push(...renderSections('skill', null,
      { name, description: dsc, summary: firstSentence(dsc), skill_dir: P(`skills/${name}`) }, () => fm)
      .map((o) => ({ ...o, host: 'all', kind: 'skill' })));
    if (hosts.includes('claude')) outputs.push(...evalOutputs(P('evals'), name, { all: false })
      .map((o) => ({ ...o, host: 'claude', kind: 'eval' })));
    wanted.push(name);
    contents.push(`- Skill \`${name}\` (starter; replace the TODO text)`);
  }
  // Agents: ported to each host's plugin agent folder (Codex plugins have none).
  const agentSel = listOpt(values.agents);
  for (const [base, h] of [['.github/agents', 'copilot'], ['.claude/agents', 'claude']]) {
    let names = [];
    try { names = fs.readdirSync(absOf(root, base)).filter((n) => n.endsWith('.md')); } catch { continue; }
    for (const n of names.filter((x) => !agentSel || agentSel.includes(x.replace(/\.agent\.md$|\.md$/, '')))) {
      const rel = `${base}/${n}`;
      const ir = parseAgent(readText(absOf(root, rel), ''), h, rel);
      if (ir.errors.length) {
        manual.push(`${rel} was not packaged: its frontmatter does not parse (${ir.errors[0]}).`);
        continue;
      }
      if (hosts.includes('claude')) {
        const r = take(renderAgent(ir, 'claude', { file: rel, pluginScoped: true }));
        add(`agents/${path.posix.basename(r.path)}`, r.content, 'claude', 'agent');
      }
      if (hosts.includes('copilot')) {
        const r = take(renderAgent(ir, 'copilot', { file: rel }));
        add(`com.github.copilot/agents/${path.posix.basename(r.path)}`, r.content, 'copilot', 'agent');
      }
      if (hosts.includes('codex')) manual.push(`Codex plugins have no agents: port ${rel} to a skill first (tooling `
        + `port ${rel} --to codex) and include it with --skills.`);
      contents.push(`- Agent \`${ir.name}\` (from ${rel})`);
    }
  }
  const hookFiles = {};
  if (values['include-hooks']) {
    const entries = [];
    let hookSources = [];
    try {
      hookSources = fs.readdirSync(absOf(root, '.github/hooks')).filter((x) => x.endsWith('.json'))
        .map((n) => [`.github/hooks/${n}`, 'copilot']);
    } catch { /* none */ }
    for (const [rel, h] of [...hookSources, ['.claude/settings.json', 'claude'],
      ['.codex/hooks.json', 'codex']].filter(([rel]) => exists(root, rel))) {
      try {
        entries.push(...take(parseHookConfig(readText(absOf(root, rel), ''), h, rel)).entries);
      } catch (err) {
        manual.push(`${rel}: ${err.message}`);
      }
    }
    // Scripts the hooks run are copied into the plugin and addressed through the plugin root,
    // because the install directory changes on every version; files they import are not followed.
    // Only the program and script arguments inside the repository are copied: a data argument
    // (`--env-file .env`, a key) must never end up in a published plugin.
    const copied = new Map();
    const skippedArgs = new Set();
    const pluginPath = (arg, program = false) => {
      const local = arg.replace(/^\$\{CLAUDE_PROJECT_DIR\}\//, '');
      if (/^[-$/~\\]/.test(local) || !/[/.]/.test(local) || local.split('/').includes('..')
        || !statOrNull(absOf(root, local))?.isFile()) return arg;
      if (!program && !SCRIPT_EXT.test(local)) { skippedArgs.add(local); return arg; }
      let dest = `hooks/scripts/${path.posix.basename(local)}`;
      if (copied.has(dest) && copied.get(dest) !== local) dest = `hooks/scripts/${local.replace(/\//g, '-')}`;
      if (!copied.has(dest)) {
        copied.set(dest, local);
        add(dest, fs.readFileSync(absOf(root, local)), 'all', 'hooks');
      }
      return `\${PLUGIN_ROOT}/${dest}`;
    };
    for (const e of entries) {
      if (e.exec) e.exec = { program: pluginPath(e.exec.program, true), args: e.exec.args.map((a) => pluginPath(a)) };
      else manual.push(`A ${e.event} hook uses a shell string; rewrite its file paths with \${PLUGIN_ROOT} (Copilot, `
        + `Codex) or \${CLAUDE_PLUGIN_ROOT} (Claude Code).`);
    }
    if (copied.size) manual.push(
      `Copied hook scripts into the plugin (${[...copied.values()].join(', ')}); copy any files they import as well.`);
    if (skippedArgs.size) manual.push(`Hook arguments ${[...skippedArgs].join(', ')} are not scripts and were not `
      + `copied (they may hold secrets); ship them yourself if the hook needs them.`);
    const targets = [['claude', 'hooks/hooks.json'], ['copilot', 'com.github.copilot/hooks/hooks.json'],
      ['codex', 'hooks/codex.hooks.json']];
    for (const [h, file] of entries.length ? targets.filter(([x]) => hosts.includes(x)) : []) {
      const r = take(renderHookConfig(entries, h, { file, pluginRoot: true }));
      add(file, json(h === 'claude' ? { description: `${name} hooks`, hooks: r.doc.hooks } : r.doc), h, 'hooks');
      hookFiles[h] = file;
    }
    if (hookFiles.codex) manual.push('Codex runs plugin hooks only after the user trusts them (/hooks).');
    if (entries.length) contents.push(`- Hooks: ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} `
      + `(${uniq(entries.map((e) => e.event)).join(', ')})`);
    else manual.push(
      '--include-hooks: no command hooks found in .github/hooks, .claude/settings.json or .codex/hooks.json.');
  }
  let hasMcp = false;
  if (values['include-mcp']) {
    const servers = [];
    for (const [rel, dialect] of [['.mcp.json', 'mcpServers'], ['.github/mcp.json', 'mcpServers'],
      ['.vscode/mcp.json', 'vscode']].filter(([rel]) => exists(root, rel))) {
      for (const s of take(parseMcpConfig(readText(absOf(root, rel), ''), dialect, rel)).servers) {
        if (!servers.some((x) => x.name === s.name)) servers.push(s);
      }
    }
    hasMcp = servers.length > 0;
    if (hasMcp && apManifest) add('mcp.json',
      json(take(renderMcpConfig(servers, 'agent-plugins', { file: 'mcp.json' })).doc), 'copilot,codex', 'mcp');
    if (hasMcp && (hosts.includes('claude') || codexManifest)) add('.mcp.json',
      json(take(renderMcpConfig(servers, 'claude', { file: '.mcp.json' })).doc), 'claude', 'mcp');
    if (hasMcp) contents.push(`- MCP servers: ${servers.map((s) => `\`${s.name}\``).join(', ')}`);
    else manual.push('--include-mcp: no .mcp.json, .github/mcp.json or .vscode/mcp.json found.');
  }
  const meta = { version, description, author: { name: owner },
    ...(values.license ? { license: String(values.license) } : {}) };
  if (apManifest) {
    const ap = { $schema: AP_SCHEMA, name, ...meta };
    if (hookFiles.codex) {
      ap.extensions = { 'com.openai': { hooks: `./${hookFiles.codex}` } };
      manual.push('Unverified: Codex reading plugin hooks from extensions["com.openai"].hooks in an Agent Plugins '
        + 'manifest (Appendix C); check with /plugins and /hooks in Codex.');
    }
    add('plugin.json', json(ap), 'copilot,codex', 'plugin');
  }
  if (hosts.includes('claude')) add('.claude-plugin/plugin.json', json({ name, ...meta }), 'claude', 'plugin');
  if (codexManifest) {
    const sd = shortDescription(description);
    add('.codex-plugin/plugin.json',
      json({ name, version, description, skills: './skills', ...(hasMcp ? { mcpServers: './.mcp.json' } : {}),
      ...(hookFiles.codex ? { hooks: `./${hookFiles.codex}` } : {}),
        interface: { displayName: name, ...(sd ? { shortDescription: sd } : {}) } }), 'codex', 'plugin');
  }
  // The repository is its own marketplace; .claude-plugin/marketplace.json is read by all three hosts.
  const mkt = values.marketplace || `${name}-marketplace`;
  const source = outRel === '.' ? './' : `./${outRel}`;
  const entry = { name, source, description, version };
  const mergeEntry = (cur) => {
    const c = cur.trim() ? JSON.parse(cur) : {};
    c.plugins = Array.isArray(c.plugins) ? c.plugins : [];
    const k = c.plugins.findIndex((p) => p?.name === name);
    if (k >= 0) c.plugins[k] = { ...c.plugins[k], ...entry }; else c.plugins.push(entry);
    return json(c);
  };
  const about = `Plugins from ${project}.`;
  const [mktFile, mktDoc] = hosts.includes('claude') || (hosts.includes('copilot') && hosts.includes('codex'))
    ? ['.claude-plugin/marketplace.json', { name: mkt, description: about, owner: { name: owner }, plugins: [entry] }]
    : hosts.includes('copilot')
      ? ['.github/plugin/marketplace.json',
      { name: mkt, owner: { name: owner }, metadata: { description: about }, plugins: [entry] }]
      : ['.agents/plugins/marketplace.json',
        { name: mkt, interface: { displayName: mkt }, plugins: [{ name, source }] }];
  outputs.push({ path: mktFile, content: json(mktDoc), merge: mergeEntry, host: hosts.join(','), kind: 'marketplace' });
  const install = [
    hosts.includes('copilot') &&
      `- Copilot CLI: \`copilot plugin marketplace add OWNER/REPO\` then \`copilot plugin install ${name}@${mkt}\``,
    hosts.includes('claude') &&
      `- Claude Code: \`claude plugin marketplace add OWNER/REPO\` then \`claude plugin install ${name}@${mkt}\``,
    hosts.includes('codex') &&
      `- Codex: \`codex plugin marketplace add OWNER/REPO\` then \`codex plugin add ${name}@${mkt}\``,
  ].filter(Boolean);
  outputs.push(...renderSections('plugin', null,
    { name, description, contents: contents.join('\n'), install: install.join('\n'), plugin_dir: outRel, version,
    date: today() }).map((o) => ({ ...o, path: P(o.path), host: 'all', kind: 'docs' })));
  const write = Boolean(values.write) && !ctx.dryRun;
  const applied = writeOutputs(outputs,
    { root, dryRun: !write, force: Boolean(values.force), mergeNeedsForce: true, backupDir: backups(ctx, root) });
  const next = [...(write ? []
    : [`Dry run: nothing was written. Re-run with --write to create ${applied.written.length} file(s).`]),
    ...(applied.skipped.length
      ? [`${applied.skipped.length} file(s) exist and were left alone; pass --force to merge or overwrite them.`] : []),
    `Check it: tooling plugin check ${outRel}`, `Test it locally: tooling plugin test ${outRel}`,
      `Release it: tooling plugin release ${outRel} --version X.Y.Z`];
  return { kind: 'plugin', name, hosts, plugin_dir: outRel, marketplace: mkt, marketplaces: [mktFile],
    dry_run: !write, files: applied.written.map((w) => w.path),
    written: applied.written, skipped: applied.skipped, backups: applied.backups, validators: [],
    local_test_commands: pluginTestCommands(outRel, name, mkt, wanted[0], hosts),
      release_steps: releaseSteps(name, version, outRel),
    dropped_fields: dropped, manual_steps: uniq(manual), next_steps: next };
}

/** Marketplace manifests under `root` whose entries point at the plugin (by name or source path). */
function marketplacesFor(root, pdir, name) {
  const target = realPath(pdir);
  const src = (p) => (typeof p.source === 'string' ? p.source : p.source?.source === 'local' ? p.source.path
    : p.source?.path);
  return MARKETPLACES.map((f) => ({ file: f, abs: absOf(root, f), doc: readMaybe(absOf(root, f)).doc }))
    .filter((m) => Array.isArray(m.doc?.plugins))
    .map((m) => ({ ...m, name: m.doc.name || null,
      entries: m.doc.plugins.filter((p) => p
      && (p.name === name || (src(p) && realPath(path.resolve(root, src(p))) === target))) }))
    .filter((m) => m.entries.length);
}

/** Run a host CLI with throwaway homes (`env` names the variables pointing at them); the homes are always removed. */
function inThrowawayHome(labels, fn) {
  const dirs = labels.map((l) => makeTempDir(l));
  try {
    return fn(...dirs);
  } finally {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 });
  }
}

const loadVerdict = (v, skills, loaded, what) => {
  v.loaded_skills = loaded;
  const missing = skills.filter((s) => !loaded.includes(s));
  if (!skills.length) Object.assign(v,
    { status: 'unknown', reason: `the plugin has no skills, so ${what} cannot show that it loaded` });
  else if (missing.length) Object.assign(v,
    { status: 'fail', errors: [`${v.host} did not load skill(s) ${missing.join(', ')} from the plugin`] });
  else v.status = 'pass';
  return v;
};

/**
 * Copilot CLI load check (free, no sign-in): `copilot --plugin-dir <dir> skill list --json` with a
 * throwaway COPILOT_HOME.
 */
function copilotLoadCheck(cli, pdir, prel, skills) {
  const v = { name: 'copilot --plugin-dir skill list --json (load check)', host: 'Copilot CLI',
    cmd: `COPILOT_PLUGIN_DIR_ONLY=true copilot --plugin-dir ${prel} skill list --json`,
    ran: false, status: 'skipped', errors: [], warnings: [], loaded_skills: [] };
  if (!cli) return { ...v, reason: 'copilot not on PATH (or set ADC_COPILOT_CLI)' };
  return inThrowawayHome(['copilot-home', 'copilot-cwd'], (home, cwd) => {
    const r = runCli(cli, ['--plugin-dir', pdir, 'skill', 'list', '--json'], { cwd, timeoutMs: 90_000,
      env: { ...process.env, COPILOT_HOME: home, COPILOT_PLUGIN_DIR_ONLY: 'true', COPILOT_AUTO_UPDATE: 'false' } });
    Object.assign(v, { ran: true, exit: r.exit });
    const rows = firstJson(r.stdout);
    if (!Array.isArray(rows)) {
      const why = lastLine(r.stderr || r.stdout) || `exit ${r.exit}`;
      return Object.assign(v, { status: 'error', reason: `no skill list in the output: ${why}` });
    }
    const base = realPath(pdir) + path.sep;
    // Every plugin skill must be listed with source "plugin" from inside the plugin directory.
    const loaded = rows.filter((x) => x?.source === 'plugin' && typeof x.path === 'string'
      && (realPath(x.path) + path.sep).startsWith(base)).map((x) => String(x.name));
    return loadVerdict(v, skills, loaded, 'a skill listing');
  });
}

/**
 * Codex load check (free, no sign-in): with a throwaway CODEX_HOME, register the repository
 * marketplace, install the plugin and render the prompt input; every plugin skill must appear as `<plugin>:<skill>`.
 */
function codexLoadCheck(cli, root, pdir, name, skills) {
  const v = { name: 'codex plugin marketplace add + plugin add + debug prompt-input (load check)', host: 'Codex',
    ran: false, status: 'skipped', errors: [], warnings: [],
    loaded_skills: [], cmd: `CODEX_HOME=<temp> codex plugin marketplace add . && codex plugin add `
      + `${name}@<marketplace> && codex debug prompt-input hello` };
  if (!cli) return { ...v, reason: 'codex not on PATH (or set ADC_CODEX_CLI)' };
  const mkts = marketplacesFor(root, pdir, name)
    .filter((m) => ['.agents/plugins/marketplace.json', '.claude-plugin/marketplace.json'].includes(m.file));
  if (!mkts.length) return { ...v,
    reason: 'no .agents/plugins/marketplace.json or .claude-plugin/marketplace.json lists the plugin; Codex installs '
    + 'plugins from marketplaces' };
  return inThrowawayHome(['codex-home', 'codex-cwd'], (home, cwd) => {
    const env = { ...process.env, CODEX_HOME: home };
    const step = (args, at) => runCli(cli, args, { cwd: at, env, timeoutMs: 90_000 });
    const fail = (what, r) => Object.assign(v,
      { status: 'fail', errors: [`${what} failed: ${lastLine(r.stderr || r.stdout) || `exit ${r.exit}`}`] });
    v.ran = true;
    const add = step(['plugin', 'marketplace', 'add', root], root);
    if (add.exit !== 0) return fail('codex plugin marketplace add', add);
    v.marketplace = /marketplace `([^`]+)`/.exec(`${add.stdout}\n${add.stderr}`)?.[1] || mkts[0].name;
    const inst = step(['plugin', 'add', `${name}@${v.marketplace}`], cwd);
    if (inst.exit !== 0) return fail(`codex plugin add ${name}@${v.marketplace}`, inst);
    const pi = step(['debug', 'prompt-input', 'hello'], cwd);
    v.exit = pi.exit;
    if (pi.exit !== 0) return Object.assign(v,
      { status: 'error', reason: `codex debug prompt-input failed: ${lastLine(pi.stderr || pi.stdout)}` });
    return loadVerdict(v, skills, skills.filter((s) => pi.stdout.includes(`${name}:${s}`)), 'the prompt input');
  });
}

/** `claude plugin validate --strict --json`: warnings fail --strict; a directory without a manifest is not a pass. */
function claudeValidate(cli, root, t) {
  const v = { name: 'claude plugin validate --strict --json',
    cmd: `claude plugin validate --strict --json ${relOf(root, t)}`, ran: false, status: 'skipped', errors: [],
    warnings: [] };
  if (!cli) return { ...v, reason: 'claude not on PATH' };
  const r = runCli(cli, ['plugin', 'validate', '--strict', '--json', t], { timeoutMs: 60_000 });
  Object.assign(v, { ran: true, exit: r.exit });
  const doc = firstJson(r.stdout);
  if (!doc) return Object.assign(v, { status: r.exit === 0 ? 'pass' : 'error' });
  const parts = [doc.manifest, ...(doc.contents || [])].filter(Boolean);
  const collect = (key) => parts.flatMap((p) => (p[key] || [])
    .map((x) => `${toPosix(path.relative(root, p.file || t))}: ${x.path ? `${x.path}: ` : ''}${x.message || x}`));
  return Object.assign(v,
    { errors: collect('errors'), warnings: collect('warnings'),
    status: !parts.length ? 'not-applicable' : doc.success ? 'pass' : 'fail' });
}

/** `tooling plugin check`: manifests, layout, name and version consistency, lint and the host validators. */
export async function pluginCheck(ctx, dirArg, { external = true } = {}) {
  const root = rootOf(ctx);
  checkState(ctx, root);
  const pdir = userPath(ctx, dirArg || '.');
  if (!isDir(pdir)) throw usageError(`not a directory: ${toPosix(dirArg || '.')}`);
  const prel = relOf(root, pdir);
  const at = (f) => (f ? (prel === '.' ? f : `${prel}/${f}`) : prel);
  const findings = [];
  const F = (severity, file, rule, message) => findings.push({ severity, file: at(file), rule, message });
  const files = listFiles(pdir, { ignore: COPY_IGNORE, maxFiles: 5000 });
  const [ap, cl, cx] = MANIFESTS.map((f) => readMaybe(path.join(pdir, ...f.split('/'))));
  if (!ap.exists && !cl.exists && !cx.exists) F('error', null, 'NO_MANIFEST',
    'no plugin.json, .claude-plugin/plugin.json or .codex-plugin/plugin.json');
  const hosts = uniq([...(ap.exists ? ['copilot', 'codex'] : []), ...(cl.exists ? ['claude'] : []),
    ...(cx.exists ? ['codex'] : [])]);
  // Most manifest, skill, agent and hook rules come from tooling lint below; these span files or close gaps
  // in the schema.
  const docs = MANIFESTS.map((f, k) => ({ file: f, doc: [ap, cl, cx][k].doc }))
    .filter((m) => m.doc && typeof m.doc === 'object');
  const names = uniq(docs.map((m) => m.doc.name).filter(Boolean));
  const versions = docs.filter((m) => m.doc.version).map((m) => ({ file: m.file, version: m.doc.version }));
  if (names.length > 1) F('error', null, 'NAME_MISMATCH', `manifests disagree on the plugin name: ${names.join(', ')}`);
  if (uniq(versions.map((v) => v.version)).length > 1) F('error', null, 'VERSION_MISMATCH',
    `manifest versions differ: ${versions.map((v) => `${v.file} ${v.version}`).join(', ')}`);
  const author = ap.doc?.author;
  const authorKeys = ['name', 'email', 'url'];
  if (author && (typeof author !== 'object' || Object.keys(author).some((k) => !authorKeys.includes(k)))) {
    F('error', 'plugin.json', 'AP_AUTHOR', 'author may contain only name, email and url strings');
  }
  const keywords = ap.doc?.keywords;
  if (keywords && (!Array.isArray(keywords) || keywords.some((k) => typeof k !== 'string'))) {
    F('error', 'plugin.json', 'AP_KEYWORDS', 'keywords must be an array of strings');
  }
  for (const [n, s] of Object.entries(ap.exists ? readMaybe(path.join(pdir, 'mcp.json')).doc?.mcpServers || {} : {})) {
    const allowed = AP_MCP_KEYS[s?.type];
    if (!allowed) {
      F('error', 'mcp.json', 'AP_MCP_TYPE', `${n}: type must be stdio, streamable-http or sse`);
      continue;
    }
    for (const k of Object.keys(s)) if (!allowed.includes(k)) F('error', 'mcp.json', 'AP_MCP_VARIANT',
      `${n}: "${k}" is not allowed for type ${s.type}`);
    if (s.env && ('PLUGIN_ROOT' in s.env || 'PLUGIN_DATA' in s.env)) F('error', 'mcp.json', 'AP_MCP_ENV',
      `${n}: env must not set PLUGIN_ROOT or PLUGIN_DATA`);
    if (s.type !== 'stdio' && !/^https:\/\/|^http:\/\/(localhost|127\.|\[::1\])/i.test(String(s.url))) F('error',
      'mcp.json', 'AP_MCP_URL', `${n}: url must be https (http only for loopback)`);
  }
  if (typeof cx.doc?.hooks === 'string' && !fs.existsSync(path.join(pdir, cx.doc.hooks))) F('error',
    '.codex-plugin/plugin.json', 'CODEX_HOOKS', `hooks file ${cx.doc.hooks} not found`);
  for (const f of files.filter((x) => /(^|\/)evals\/.+\/prompt\.md$/.test(x))) {
    if (/\bTODO\b/.test(readText(path.join(pdir, f), ''))) F('warning', f, 'EVAL_TODO',
      'eval case still contains TODO text');
  }
  const skills = files.filter((f) => /^skills\/[^/]+\/SKILL\.md$/.test(f))
    .map((f) => String(parseFrontmatter(readText(path.join(pdir, f), '')).data.name || f.split('/')[1]));
  const lint = await lintArtifact(root, [pdir]);
  for (const [sev, list] of [['error', lint.errors], ['warning', lint.warnings]]) {
    for (const e of list) findings.push({ severity: sev, file: e.file, rule: e.rule || 'LINT',
      message: `${e.host}: ${e.message}` });
  }
  const validators = [{ name: 'tooling lint', ran: lint.status === 'ok', status: lint.status,
    errors: lint.errors.length, warnings: lint.warnings.length, reason: lint.reason || null }];
  const name = names[0] || path.basename(pdir);
  const report = (v, rule, warningsFail = false) => {
    for (const e of [...v.errors,
      ...(warningsFail ? v.warnings.map((w) => `${w} (fails --strict)`)
      : [])]) findings.push({ severity: 'error', file: prel, rule, message: e });
    validators.push(v);
  };
  if (!external) validators.push({ name: 'host load checks', ran: false, status: 'skipped', errors: [], warnings: [],
    reason: 'not requested (tooling plugin check runs them; tooling plugin test runs them with --run)' });
  else {
    const claude = hostCli('claude');
    const roots = [...(cl.exists ? [pdir] : []),
      ...(exists(root, '.claude-plugin/marketplace.json') && path.resolve(root) !== pdir ? [root] : [])];
    for (const t of roots) report(claudeValidate(claude, root, t), 'CLAUDE_VALIDATE', true);
    if (cl.exists && files.some((x) => /^evals\/.+\/prompt\.md$/.test(x))) {
      // Parses every eval case and runs none: a case name that matches nothing costs nothing.
      const v = { name: 'claude plugin eval (load check, runs no case)',
        cmd: `claude plugin eval ${prel} --case __adc_load_check__ --trust-plugin --no-publish`,
        ran: false, status: 'skipped', errors: [], warnings: [], ...(claude ? {} : { reason: 'claude not on PATH' }) };
      if (claude) {
        const r = runCli(claude,
          ['plugin', 'eval', pdir, '--case', '__adc_load_check__', '--trust-plugin', '--no-publish', '--max-cost-usd',
          '0.01'], { timeoutMs: 60_000 });
        const text = `${r.stdout}\n${r.stderr}`;
        const failed = /failed to load/i.test(text);
        Object.assign(v, { ran: true, exit: r.exit,
          status: failed ? 'fail' : /No eval cases found matching/i.test(text) ? 'pass' : 'unknown',
          errors: failed ? text.split(/\r?\n/).filter((l) => /^✗|unknown frontmatter|failed/i.test(l)).slice(0, 10)
            : [] });
      }
      report(v, 'EVAL_LOAD');
    }
    if (ap.exists || cl.exists) report(copilotLoadCheck(hostCli('copilot'), pdir, prel, skills), 'COPILOT_LOAD');
    report(codexLoadCheck(hostCli('codex'), root, pdir, name, skills), 'CODEX_LOAD');
  }
  const mkt = MARKETPLACES.slice(0, 3).map((f) => readMaybe(absOf(root, f)).doc?.name).find(Boolean) || null;
  return { plugin_dir: prel, name, hosts, files, skills, findings, validators,
    errors: findings.filter((f) => f.severity === 'error').length,
    warnings: findings.filter((f) => f.severity === 'warning').length,
      local_test_commands: pluginTestCommands(prel, name, mkt, skills[0], hosts),
    release_steps: releaseSteps(name, versions[0]?.version || '0.1.0', prel) };
}

/**
 * The same command for bash, PowerShell and cmd. `steps` (argv arrays, quoted per shell, or
 * literal strings such as `/env`) run in order and stop at the first failure; `env` is set for
 * the steps only in bash and for the session in PowerShell and cmd.
 */
function shellVariants(env, ...steps) {
  const [k, v] = env ? Object.entries(env)[0] : [];
  const lines = (shell) => steps.map((st) => (typeof st === 'string' ? st
    : st.map((a) => quoteFor(shell, a)).join(' ')));
  return {
    bash: (k ? `${k}=${v} ` : '') + lines('sh').join(' && '),
    powershell: (k ? `$env:${k}='${v}'; ` : '')
      + lines('pwsh').reduce((acc, st) => (acc ? `${acc}; if ($LASTEXITCODE -eq 0) { ${st} }` : st), ''),
    cmd: (k ? `set ${k}=${v}&& ` : '') + lines('cmd').join(' && '),
  };
}

function pluginTestCommands(dir, name, mkt, skill, hosts) {
  const market = mkt || `${name}-marketplace`;
  const ask = `Use the ${skill || name} skill on this repository and say which skill you used.`;
  const only = { COPILOT_PLUGIN_DIR_ONLY: 'true' };
  const c = (host, purpose, cost, sideEffects, env, ...steps) => ({ host, purpose, cost, side_effects: sideEffects,
    ...shellVariants(env, ...steps) });
  return [
    ...(hosts.includes('claude') ? [
      c('claude', 'validate manifests and components', 'free', 'none', null,
        ['claude', 'plugin', 'validate', '--strict', '--json', dir]),
      c('claude', 'load the plugin for one headless prompt', 'paid', 'none', null,
        ['claude', '--plugin-dir', dir, '-p', ask, '--output-format', 'json']),
      c('claude', 'outcome evals (with/without the plugin), pinned model and a cost cap', 'paid',
        'writes evals/results/', null,
        ['claude', 'plugin', 'eval', dir, '--trust-plugin', '--json', '--threshold', '0.8', '--max-cost-usd', '10',
          '--model', '<pinned-model>',
          '--no-publish']),
      c('claude', 'always-on token cost after installing from the marketplace', 'free', 'none', null,
        ['claude', 'plugin', 'details', name])] : []),
    ...(hosts.includes('copilot') ? [
      c('copilot', 'list the skills Copilot CLI loads from the plugin (no sign-in needed)', 'free', 'none', only,
        ['copilot', '--plugin-dir', dir, 'skill', 'list', '--json']),
      c('copilot', 'load only this plugin for one headless prompt', 'paid', 'none', only,
        ['copilot', '--plugin-dir', dir, '-p', ask, '--output-format', 'json', '--no-ask-user']),
      c('copilot', 'register the repository marketplace and install from it (direct path installs are deprecated)',
        'free',
        'writes ~/.copilot (marketplace, installed plugin)', null, 'copilot plugin marketplace add .',
          ['copilot', 'plugin', 'install', `${name}@${market}`],
        'copilot plugin list --json'),
      c('copilot', 'see loaded hooks and skills in an interactive session', 'free', 'none', null, '/env')] : []),
    ...(hosts.includes('codex') ? [
      c('codex', 'register the repository marketplace and install the plugin', 'free',
        'writes ~/.codex/config.toml and the plugin cache', null,
        'codex plugin marketplace add .', ['codex', 'plugin', 'add', `${name}@${market}`]),
      c('codex', 'show that the plugin skills reach the model (no sign-in needed)', 'free', 'none', null,
        'codex debug prompt-input hello'),
      c('codex', 'check it loaded (interactive)', 'free', 'none', null, '/plugins')] : []),
  ];
}

function releaseSteps(name, version, prel) {
  return [
    `Bump the version in every manifest and marketplace entry: tooling plugin release ${prel} --version `
      + `${bumpSemver(version, 'patch') || 'X.Y.Z'} --write`,
    `Add a CHANGELOG.md entry for ${version} in ${prel}/CHANGELOG.md.`,
    `Commit, then tag: git tag -a v${version} -m "${name} ${version}"; for Claude Code also run claude plugin tag `
      + `${prel} --push (creates ${name}--v${version}).`,
    `Push the tags: git push origin v${version}`,
    'Pin consumers: marketplace entries in other repositories use { "source": "github", "repo": "OWNER/REPO", "ref": '
      + '"v<version>", "sha": "<40-character commit>" }.',
    'Publish SHA256SUMS (written by tooling plugin release --write) with the GitHub release.',
    'Copilot: repository-level autoUpdate is ignored; users run copilot plugin update <name>, or enable autoUpdate in '
      + 'user or managed settings.',
    'Claude Code: a pinned manifest version blocks updates until it changes; bump it on every release (or omit it so '
      + 'commits drive updates). Renamed plugins need a marketplace "renames" entry.',
    'Codex: users refresh with codex plugin marketplace upgrade.',
    'Enterprise: admins allow the marketplace with extraKnownMarketplaces + enabledPlugins (Copilot '
      + '.github/copilot/settings.json or managed settings; Claude managed settings, strictKnownMarketplaces must '
      + 'include it; Codex requirements.toml marketplaces.allowed_sources).',
  ];
}

/** `tooling plugin release`: version consistency, tags, pinned SHA, SHA256SUMS. */
export async function pluginRelease(ctx, dirArg, values) {
  const root = rootOf(ctx);
  checkState(ctx, root);
  const pdir = userPath(ctx, dirArg || '.');
  if (!isDir(pdir)) throw usageError(`not a directory: ${toPosix(dirArg || '.')}`);
  const prel = relOf(root, pdir);
  const manifests = MANIFESTS.map((f) => ({ file: prel === '.' ? f : `${prel}/${f}`,
    abs: path.join(pdir, ...f.split('/')) }))
    .map((m) => ({ ...m, ...readMaybe(m.abs) })).filter((m) => m.exists);
  if (!manifests.length) throw usageError(`${prel} has no plugin manifest`);
  const name = manifests.find((m) => m.doc?.name)?.doc.name || path.basename(pdir);
  const current = uniq(manifests.map((m) => m.doc?.version).filter(Boolean));
  const version = values.version || current[0] || null;
  if (!version) throw usageError('no version in the manifests; pass --version X.Y.Z');
  if (!SEMVER.test(version)) throw usageError('--version must be semantic (X.Y.Z)');
  const write = Boolean(values.write) && !ctx.dryRun;
  const dirty = (statusPorcelain(root, [prel]) || '').length > 0;
  const updated = [];
  const marketplaces = marketplacesFor(root, pdir, name);
  if (values.version) {
    for (const m of manifests.filter((x) => x.doc && x.doc.version !== version)) {
      updated.push({ file: m.file, from: m.doc.version ?? null, to: version });
      if (write) writeFileAtomic(m.abs, json({ ...m.doc, version }));
    }
    for (const mk of marketplaces) {
      const stale = mk.entries.filter((e) => 'version' in e && e.version !== version);
      for (const e of stale) {
        updated.push({ file: mk.file, entry: e.name, from: e.version, to: version });
        e.version = version;
      }
      if (stale.length && write) writeFileAtomic(mk.abs, json(mk.doc));
    }
  }
  const head = gitTry(root, ['rev-parse', 'HEAD']);
  const tags = (gitTry(root, ['tag', '-l', `v${version}`, `${name}--v${version}`]) || '').split(/\r?\n/)
    .filter(Boolean);
  const gh = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/
    .exec(gitTry(root, ['config', '--get', 'remote.origin.url']) || '');
  const files = listFiles(pdir, { ignore: COPY_IGNORE, maxFiles: 5000 }).filter((f) => f !== 'SHA256SUMS');
  const sums = files.map((f) => `${sha256(fs.readFileSync(path.join(pdir, f)))}  ${f}`).join('\n') + '\n';
  let sumsPath = null;
  if (write) {
    const file = path.join(statePaths(openState(ctx, root).dir).tooling, 'releases', `${name}-${version}`,
      'SHA256SUMS');
    writeFileAtomic(file, sums);
    sumsPath = relOf(root, file);
  }
  const warnings = [
    current.length > 1 && `manifest versions differ: ${current.join(', ')}`,
    dirty && 'the plugin directory had uncommitted changes before this run; commit before tagging',
    updated.length && write && 'versions were updated: commit the manifests before tagging',
    tags.length && `tags already exist: ${tags.join(', ')}`,
    !head && 'not a git repository with commits: no SHA to pin',
  ].filter(Boolean);
  return { plugin_dir: prel, name, version, current_versions: current, updated, dry_run: !write,
    tags: [{ host: 'copilot,codex', name: `v${version}`, cmd: `git tag -a v${version} -m "${name} ${version}"` },
      { host: 'claude', name: `${name}--v${version}`, cmd: `claude plugin tag ${prel} --push` }],
    pin: head ? { source: 'github', repo: gh ? `${gh[1]}/${gh[2]}` : 'OWNER/REPO', ref: `v${version}`, sha: head,
      ...(prel === '.' ? {} : { path: prel }) } : null,
    marketplaces: marketplaces.map((m) => ({ file: m.file, entries: m.entries.map((e) => e.name) })),
    sha256sums: { files: files.length, path: sumsPath, preview: sums.split('\n').slice(0, 5) }, warnings,
      release_steps: releaseSteps(name, version, prel) };
}

/**
 * `tooling plugin test`: the local test commands; `--run` executes the free, side-effect-free load
 * checks of `check`.
 */
export async function pluginTest(ctx, dirArg, values) {
  const check = await pluginCheck(ctx, dirArg, { external: Boolean(values.run) });
  const host = check.validators.filter((v) => v.name !== 'tooling lint');
  return { plugin_dir: check.plugin_dir, name: check.name, hosts: check.hosts,
    local_test_commands: check.local_test_commands,
    ran: host.filter((v) => v.ran)
      .map((v) => ({ name: v.name, cmd: v.cmd || null, status: v.status, exit: v.exit ?? null, errors: v.errors || [],
      loaded_skills: v.loaded_skills, reason: v.reason || null })),
    skipped: host.filter((v) => !v.ran).map((v) => ({ name: v.name, status: v.status, reason: v.reason || null })),
      check: { errors: check.errors, warnings: check.warnings },
    next_steps: [...(values.run ? []
      : ['Re-run with --run to execute the free load checks (claude plugin validate, Copilot and Codex in throwaway '
      + 'homes).']),
      'Paid commands are listed, never run by this script; run them yourself with a cost cap.',
      'Commands with side effects change user configuration; run them on a test machine or account.'] };
}

const pluginCommand = defineCommand({
  name: 'tooling plugin',
  usage: 'tooling plugin init [--for copilot|claude|codex|all] [--name n] [--out dir] [--skills a,b] [--agents a,b] '
    + '[--include-hooks] [--include-mcp] '
    + '[--marketplace m] [--owner o] [--version v] [--write] [--force]\n       tooling plugin check [dir] | test '
      + '[dir] [--run] | release [dir] [--version X.Y.Z] [--write]',
  options: { ...TOOLING_SCAFFOLD_OPTIONS, run: { type: 'boolean' } },
  async run(ctx, values, positionals) {
    const [verb, dir] = positionals;
    if (verb === 'init') {
      const res = await pluginInit(ctx, values);
      return { result: res, exit: EXIT.OK,
        summary: `plugin ${res.name} for ${res.hosts.join(', ')}: ${res.files.length} file(s) `
        + `${res.dry_run ? 'planned (dry run)' : 'written'}` };
    }
    if (verb === 'check') {
      const res = await pluginCheck(ctx, dir);
      const ran = res.validators.filter((v) => v.ran).map((v) => `${v.name}=${v.status}`).join(', ') || 'none ran';
      return { result: res, exit: res.errors ? EXIT.FINDINGS : EXIT.OK,
        summary: `plugin ${res.name}: ${res.errors} error(s), ${res.warnings} warning(s); validators ${ran}` };
    }
    if (verb === 'test') {
      const res = await pluginTest(ctx, dir, values);
      return { result: res, exit: res.ran.some((r) => r.status === 'fail') ? EXIT.FINDINGS : EXIT.OK,
        summary: `${res.local_test_commands.length} local test command(s); ran ${res.ran.length}` };
    }
    if (verb !== 'release') throw usageError('tooling plugin needs init, check, test or release');
    const res = await pluginRelease(ctx, dir, values);
    return { result: res, exit: EXIT.OK,
      summary: `plugin ${res.name} ${res.version}: ${res.updated.length} version update(s) `
      + `${res.dry_run ? 'planned' : 'written'}; ${res.warnings.length} warning(s)` };
  },
});

// ---------------------------------------------------------------------------
// The group

export const toolingCommand = defineGroup({
  name: 'tooling',
  usage: [
    'tooling <subcommand> [options]',
    '  lint [paths] [--host all|copilot|claude|codex] [--strict]     host-rule validation (tooling-lint)',
    '  cost [paths] [--host h] [--context-tokens n] [--max-tokens n] context cost per file and host',
    '  port <path> --to copilot|claude|codex|all [--out dir] [--force]  translate between hosts',
    '  trigger-set [skill] [--init] [--host h --run] [--runs 3]      trigger eval set (runs are paid)',
    '  modify baseline|compare|restore <path> | <path> --migrate k  safe-change loop and migrations',
    '  plugin init|check|test|release [dir]                          plugins for your own projects',
    '  scaffold <instructions|skill|agent|prompt|hooks|mcp|plugin> [--for h] [--write]',
  ].join('\n'),
  subcommands: { lint: lintCommand, cost: costCommand, port: portCommand, 'trigger-set': triggerSetCommand,
    modify: modifyCommand, plugin: pluginCommand,
    scaffold: scaffoldCommand },
});
