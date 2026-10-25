// `tooling` command group (§11): lint (delegated to tooling-lint.mjs), cost, port
// (tooling-port.mjs), trigger-set, modify, plugin and scaffold. Instructions, skills, agents,
// hooks, plugins and MCP configs are treated as software: known-good templates, measured
// context cost, headless trigger evals and a baseline/compare loop for every change.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  defineCommand, defineGroup, makeContext, usageError, envError, EXIT, readText, readJson, writeFileAtomic, writeJsonAtomic,
  ensureDir, toPosix, relPosix, sha256, nowIso, stamp, today, which, run, quoteArg, loadBundle, selectSections, renderString,
  generatedBy, listFiles, truncate, nonce, SKILL_DIR, ADC_SCRIPT, ASSETS_DIR, IS_WINDOWS,
} from './core.mjs';
import { repoRoot, gitTry } from './git.mjs';
import { prepareStateDir, statePaths, appendMetrics } from './state.mjs';
import {
  HOSTS, SKILL_DIRS, CODEX_ONLY_SKILLS_DIR, loadFrontmatterLib, readFrontmatter, stringifyFrontmatter, classifyArtifact, skillNameProblems,
  toSkillName, inlineImports, parseHookConfig, renderHookConfig, parseMcpConfig, renderMcpConfig, parseAgent, renderAgent,
  renderOpenAiYaml, shortDescription, applyOutputs, backupDirFactory, portCommand, migrate, migrationSources, MIGRATIONS,
} from './tooling-port.mjs';

const CHARS_PER_TOKEN = 4;
const CLAUDE_LISTING_CAP = 1536;
const WALK_IGNORE = new Set(['.git', 'node_modules', '.adc', 'results', '.venv', '__pycache__']);
const TOOLING_DIRS = ['.github', '.claude', '.agents', '.codex', '.vscode', 'skills'];
const INSTRUCTION_NAMES = new Set(['AGENTS.md', 'AGENTS.override.md', 'CLAUDE.md', 'CLAUDE.local.md', 'GEMINI.md']);
const PAID_NOTE = 'paid: every run is a real model call billed to your account';

/** ceil(chars / 4): the usual English-text heuristic (roughly +-25%). */
export const estimateTokens = (chars) => Math.ceil(Math.max(0, chars) / CHARS_PER_TOKEN);

const rootOf = (ctx) => repoRoot(ctx.cwd) || ctx.cwd;
/** Every command refuses (exit 3) while `.adc/` is tracked; this checks without creating it. */
const checkState = (ctx, root) => prepareStateDir({ ...ctx, cwd: root }, { create: false });
const openState = (ctx, root) => prepareStateDir({ ...ctx, cwd: root }, { create: true });
const absOf = (root, rel) => path.join(root, ...rel.split('/'));
const exists = (root, rel) => fs.existsSync(absOf(root, rel));

function parseHosts(value, { allowAll = true } = {}) {
  const v = String(value || 'all').trim();
  if (v === 'all' && allowAll) return [...HOSTS];
  const list = v.split(',').map((s) => s.trim()).filter(Boolean);
  for (const h of list) if (!HOSTS.includes(h)) throw usageError(`host must be copilot, claude, codex${allowAll ? ' or all' : ''} (got "${h}")`);
  return [...new Set(list)];
}

/** Sortable unique id: UTC time to the millisecond plus a random suffix. */
const tsId = () => `${new Date().toISOString().replace(/[-:.]/g, '')}-${nonce().slice(0, 6)}`;
const artifactSlug = (rel) => toPosix(rel).replace(/\/SKILL\.md$/, '').replace(/[^A-Za-z0-9._-]+/g, '__').replace(/^_+|_+$/g, '').slice(0, 120) || 'root';

// ---------------------------------------------------------------------------
// Discovery

/** Tooling files under `root` (or under the given paths): `[{ path, abs, kind, host, hosts, ... }]`. */
export function discoverTooling(root, { paths = null } = {}) {
  const rels = new Set();
  const addTree = (abs) => {
    for (const f of listFiles(abs, { ignore: WALK_IGNORE, maxFiles: 20_000 })) {
      const rel = relPosix(root, path.join(abs, f));
      rels.add(rel ?? toPosix(path.join(abs, f)));
    }
  };
  if (paths && paths.length) {
    for (const p of paths) {
      const abs = path.resolve(root, p);
      if (!fs.existsSync(abs)) throw usageError(`not found: ${toPosix(p)}`);
      if (fs.statSync(abs).isDirectory()) addTree(abs);
      else rels.add(relPosix(root, abs) ?? toPosix(abs));
    }
  } else {
    for (const d of TOOLING_DIRS) {
      const abs = path.join(root, d);
      if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) addTree(abs);
    }
    for (const f of listFiles(root, { maxFiles: 50_000 })) if (INSTRUCTION_NAMES.has(path.posix.basename(f))) rels.add(f);
  }
  const out = [];
  for (const rel of [...rels].sort()) {
    const cls = classifyArtifact(rel);
    if (cls) out.push({ path: rel, abs: path.isAbsolute(rel) ? rel : absOf(root, rel), ...cls });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Context cost (§11.3)

const stripHtmlComments = (t) => t.replace(/<!--[\s\S]*?-->/g, '');
const lineCount = (t) => (t ? t.split('\n').length - (t.endsWith('\n') ? 1 : 0) : 0);

function listingText(data, host) {
  const name = String(data.name ?? '');
  let desc = String(data.description ?? '').replace(/\s+/g, ' ').trim();
  if (host === 'claude' && data.when_to_use) desc = `${desc} ${String(data.when_to_use).replace(/\s+/g, ' ').trim()}`;
  if (host === 'claude' && desc.length > CLAUDE_LISTING_CAP) desc = desc.slice(0, CLAUDE_LISTING_CAP);
  return `- ${name}: ${desc}`;
}

function openAiImplicit(skillAbsDir) {
  const text = readText(path.join(skillAbsDir, 'agents', 'openai.yaml'));
  if (text == null) return true;
  return !/^\s*allow_implicit_invocation:\s*false\b/m.test(text);
}

/**
 * Characters and estimated tokens per tooling file, which files are always-on per host
 * (instructions, skill/agent/command listings) and which load on demand, per-host budgets,
 * duplicated rules and stale commands or paths. Returns `{ files[], totals, findings[], ... }`.
 */
export function toolingCost({ root, paths = null, host = 'all', contextTokens = 200_000, artifacts = null, top = 10 } = {}) {
  const arts = artifacts || discoverTooling(root, { paths });
  const hosts = host === 'all' ? [...HOSTS] : parseHosts(host, { allowAll: false });
  const claudeMdAtRoot = exists(root, 'CLAUDE.md') || exists(root, '.claude/CLAUDE.md') || exists(root, 'CLAUDE.local.md');
  const overrideAtRoot = exists(root, 'AGENTS.override.md');
  const files = [];
  const byPath = new Map();
  const notes = new Set();
  for (const a of arts) {
    if (['hooks', 'mcp', 'plugin', 'marketplace', 'agent-toml'].includes(a.kind)) {
      if (a.kind === 'mcp') notes.add('MCP tool definitions also cost context; they are not estimated here (use /context in the host).');
      if (a.kind === 'agent-toml') notes.add(`${a.path}: Codex TOML agent roles are unverified and not counted.`);
      continue;
    }
    const text = readText(a.abs, '');
    const fm = readFrontmatter(text);
    const body = fm.hasFrontmatter ? fm.body : text;
    const e = { path: a.path, kind: a.kind, hosts: [...a.hosts], chars: text.length, bytes: Buffer.byteLength(text), lines: lineCount(text),
      est_tokens: estimateTokens(text.length), load: 'on-demand', always_on: false, always_on_tokens: {}, on_demand_tokens: 0 };
    const set = (h, n) => { if (hosts.includes(h) && e.hosts.includes(h)) e.always_on_tokens[h] = n; };
    const base = path.posix.basename(a.path);
    if (a.kind === 'instructions') {
      e.load = 'always';
      if (base === 'AGENTS.md') {
        e.hosts = ['copilot', ...(overrideAtRoot ? [] : ['codex']), ...(claudeMdAtRoot ? [] : ['claude'])];
        if (claudeMdAtRoot) e.note = 'Claude Code reads AGENTS.md only when no CLAUDE.md exists (or through an @AGENTS.md import)';
      }
      for (const h of e.hosts) set(h, estimateTokens((h === 'claude' ? stripHtmlComments(text) : text).length));
    } else if (a.kind === 'scoped') {
      let always = false;
      if (/\.instructions\.md$/.test(base)) {
        const globs = String(fm.data.applyTo ?? '').split(',').map((s) => s.trim());
        always = globs.some((g) => g === '**' || g === '**/*');
      } else if (/(^|\/)\.claude\/rules\//.test(a.path)) always = fm.data.paths == null;
      e.load = always ? 'always' : 'path-scoped';
      e.scoped_tokens = estimateTokens(body.length);
      if (always) for (const h of e.hosts) set(h, estimateTokens(body.length));
    } else if (a.kind === 'skill' || a.kind === 'command' || a.kind === 'agent') {
      e.load = 'listing';
      e.name = String(fm.data.name ?? (a.kind === 'skill' ? a.name : base.replace(/\.agent\.md$|\.md$/, '')));
      const data = { ...fm.data, name: e.name };
      for (const h of e.hosts) {
        if (h === 'codex' && a.kind === 'skill' && !openAiImplicit(path.dirname(a.abs))) { e.always_on_tokens.codex = 0; continue; }
        set(h, estimateTokens(listingText(data, h).length));
      }
      e.on_demand_tokens = estimateTokens(body.length);
      e.description_chars = String(fm.data.description ?? '').length + (fm.data.when_to_use ? String(fm.data.when_to_use).length : 0);
    } else {
      e.on_demand_tokens = estimateTokens(text.length);
    }
    e.always_on = Object.values(e.always_on_tokens).some((n) => n > 0);
    files.push(e);
    byPath.set(a.path, e);
  }
  // @imports load the imported file with the importer (Claude Code always; Copilot CLI as well).
  for (const e of [...files]) {
    if (e.load !== 'always' || !['instructions', 'scoped'].includes(e.kind)) continue;
    const abs = absOf(root, e.path);
    const text = readText(abs, '');
    const inl = inlineImports(text, abs);
    for (const imp of new Set(inl.files)) {
      const rel = relPosix(root, imp) ?? toPosix(imp);
      let t = byPath.get(rel);
      if (!t) {
        const it = readText(imp, '');
        t = { path: rel, kind: 'import', hosts: [], chars: it.length, bytes: Buffer.byteLength(it), lines: lineCount(it), est_tokens: estimateTokens(it.length),
          load: 'always', always_on: false, always_on_tokens: {}, on_demand_tokens: 0, imported_by: [] };
        files.push(t);
        byPath.set(rel, t);
      }
      t.imported_by = [...new Set([...(t.imported_by || []), e.path])];
      if (t.note && path.posix.basename(t.path) === 'AGENTS.md') t.note = `Claude Code loads AGENTS.md through the @import in ${t.imported_by.join(', ')}`;
      for (const h of e.hosts) {
        if (h === 'codex' || !hosts.includes(h)) continue;
        if (!t.hosts.includes(h)) t.hosts.push(h);
        if (t.always_on_tokens[h] == null) t.always_on_tokens[h] = estimateTokens((h === 'claude' ? stripHtmlComments(readText(imp, '')) : readText(imp, '')).length);
      }
      t.always_on = Object.values(t.always_on_tokens).some((n) => n > 0);
    }
  }
  const totals = {};
  const findings = [];
  for (const h of hosts) {
    const mine = files.filter((f) => f.hosts.includes(h));
    const t = { always_on_tokens: 0, instruction_tokens: 0, listing_tokens: 0, path_scoped_tokens: 0, on_demand_tokens: 0, files: mine.length, budgets: [] };
    for (const f of mine) {
      const n = f.always_on_tokens[h] || 0;
      t.always_on_tokens += n;
      if (f.load === 'listing') t.listing_tokens += n; else t.instruction_tokens += n;
      if (f.load === 'path-scoped') t.path_scoped_tokens += f.scoped_tokens || 0;
      t.on_demand_tokens += f.on_demand_tokens || 0;
    }
    const listingSkills = mine.filter((f) => f.load === 'listing' && f.kind !== 'agent').reduce((s, f) => s + (f.always_on_tokens[h] || 0), 0);
    if (h === 'claude') {
      t.budgets.push({ id: 'claude-skill-listing', limit: Math.round(contextTokens * 0.01), used: listingSkills, unit: 'tokens', source: 'Claude Code skill listing budget: 1% of the context window' });
      for (const f of mine.filter((x) => /(^|\/)CLAUDE(\.local)?\.md$/.test(x.path))) t.budgets.push({ id: 'claude-md-lines', file: f.path, limit: 200, used: f.lines, unit: 'lines', source: 'Claude Code memory guidance: under 200 lines' });
      for (const f of mine.filter((x) => x.kind === 'skill' && x.description_chars != null)) t.budgets.push({ id: 'claude-listing-chars', file: f.path, limit: CLAUDE_LISTING_CAP, used: f.description_chars, unit: 'chars', source: 'description + when_to_use are truncated at 1,536 characters' });
    } else if (h === 'codex') {
      t.budgets.push({ id: 'codex-skills-catalog', limit: Math.min(Math.round(contextTokens * 0.02), 10_000), used: listingSkills, unit: 'tokens', source: 'Codex skills catalog: 2% of the context window, capped at 10,000 tokens' });
      const agentsFiles = mine.filter((f) => /(^|\/)AGENTS(\.override)?\.md$/.test(f.path));
      let maxChain = 0;
      let chainFile = null;
      for (const f of agentsFiles) {
        const segs = path.posix.dirname(f.path) === '.' ? [] : path.posix.dirname(f.path).split('/');
        let bytes = 0;
        for (let k = 0; k <= segs.length; k++) {
          const dir = segs.slice(0, k).join('/');
          const pick = [`${dir ? dir + '/' : ''}AGENTS.override.md`, `${dir ? dir + '/' : ''}AGENTS.md`].find((r) => byPath.has(r));
          if (pick) bytes += byPath.get(pick).bytes;
        }
        if (bytes > maxChain) { maxChain = bytes; chainFile = f.path; }
      }
      t.budgets.push({ id: 'codex-agents-md-bytes', file: chainFile, limit: 32_768, used: maxChain, unit: 'bytes', source: 'Codex project_doc_max_bytes: 32 KiB of AGENTS.md from the root down to the working directory' });
    } else if (h === 'copilot') {
      for (const f of mine.filter((x) => ['instructions', 'scoped', 'import'].includes(x.kind))) t.budgets.push({ id: 'copilot-instruction-lines', file: f.path, limit: 1000, used: f.lines, unit: 'lines', source: 'Copilot code review guidance: about 1,000 lines per instruction file' });
      for (const f of mine.filter((x) => x.kind === 'skill' && x.description_chars != null)) t.budgets.push({ id: 'copilot-description-chars', file: f.path, limit: 1024, used: String(readFrontmatter(readText(absOf(root, f.path), '')).data.description ?? '').length, unit: 'chars', source: 'skill description: at most 1,024 characters' });
      for (const f of mine.filter((x) => x.kind === 'agent' && /\.github\/agents\//.test(x.path))) t.budgets.push({ id: 'copilot-agent-body-chars', file: f.path, limit: 30_000, used: f.on_demand_tokens * CHARS_PER_TOKEN, unit: 'chars', source: 'Copilot custom agent prompt: at most 30,000 characters' });
    }
    for (const b of t.budgets) {
      b.ok = b.used <= b.limit;
      if (!b.ok) findings.push({ id: 'OVER_BUDGET', severity: 'finding', host: h, file: b.file || null, message: `${b.id}: ${b.used} ${b.unit} > ${b.limit} (${b.source})` });
    }
    totals[h] = t;
  }
  findings.push(...duplicateRules(root, files, hosts), ...staleReferences(root, files));
  const biggest = [];
  for (const f of files) for (const [h, n] of Object.entries(f.always_on_tokens)) if (n > 0) biggest.push({ path: f.path, host: h, tokens: n });
  biggest.sort((a, b) => b.tokens - a.tokens || a.path.localeCompare(b.path));
  files.sort((a, b) => Math.max(0, ...Object.values(b.always_on_tokens)) - Math.max(0, ...Object.values(a.always_on_tokens)) || a.path.localeCompare(b.path));
  return {
    root: toPosix(root),
    context_tokens: contextTokens,
    method: 'est_tokens = ceil(chars / 4); listings count "- name: description" (+ when_to_use in Claude Code, capped at 1,536 chars); imports load with their importer',
    files,
    totals: { ...totals, max_always_on_tokens: Math.max(0, ...hosts.map((h) => totals[h].always_on_tokens)) },
    biggest_always_on: biggest.slice(0, top),
    findings,
    notes: [...notes],
  };
}

function normalizedRuleLines(text) {
  const out = [];
  let inFence = false;
  text.split(/\r?\n/).forEach((raw, idx) => {
    if (/^\s*(```|~~~)/.test(raw)) { inFence = !inFence; return; }
    if (inFence || /^\s*#/.test(raw) || /^\s*<!--/.test(raw)) return;
    const s = raw.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (s.length >= 30) out.push({ line: idx + 1, text: s });
  });
  return out;
}

function duplicateRules(root, files, hosts) {
  const findings = [];
  const seenPairs = new Set();
  for (const h of hosts) {
    const loaded = files.filter((f) => f.hosts.includes(h) && (f.always_on_tokens[h] || 0) > 0 && ['instructions', 'scoped', 'import'].includes(f.kind));
    const where = new Map();
    for (const f of loaded) {
      for (const l of normalizedRuleLines(readText(absOf(root, f.path), ''))) {
        if (!where.has(l.text)) where.set(l.text, []);
        const list = where.get(l.text);
        if (!list.some((x) => x.file === f.path)) list.push({ file: f.path, line: l.line });
      }
    }
    for (const [text, list] of where) {
      if (list.length < 2) continue;
      const key = list.map((x) => `${x.file}:${x.line}`).join('|');
      if (seenPairs.has(key)) continue;
      seenPairs.add(key);
      findings.push({ id: 'DUPLICATE_RULE', severity: 'finding', host: h, file: list[0].file, line: list[0].line,
        message: `the same rule is loaded ${list.length} times for ${h}: ${list.map((x) => `${x.file}:${x.line}`).join(', ')}`, evidence: truncate(text, 120) });
    }
  }
  return findings;
}

const NPM_BUILTIN = new Set(['install', 'i', 'ci', 'add', 'remove', 'rm', 'uninstall', 'update', 'up', 'exec', 'dlx', 'x', 'why', 'list', 'ls', 'init',
  'create', 'publish', 'pack', 'link', 'audit', 'outdated', 'config', 'version', 'view', 'info', 'help', 'login', 'logout', 'cache', 'store', 'run',
  'test', 't', 'start', 'stop', 'restart', 'rebuild', 'prune', 'dedupe', 'workspace', 'workspaces', 'set', 'import', 'patch', 'env', 'bin', 'root',
  'doctor', 'fund', 'explain', 'query', 'search', 'owner', 'deprecate', 'dist-tag', 'pkg', 'npx', 'node', 'global', 'upgrade', 'help']);

function lockManager(root) {
  if (exists(root, 'pnpm-lock.yaml')) return 'pnpm';
  if (exists(root, 'yarn.lock')) return 'yarn';
  if (exists(root, 'bun.lock') || exists(root, 'bun.lockb')) return 'bun';
  if (exists(root, 'package-lock.json')) return 'npm';
  return null;
}

function codeSnippets(text) {
  const out = [];
  let inFence = false;
  text.split(/\r?\n/).forEach((raw, idx) => {
    if (/^\s*(```|~~~)/.test(raw)) { inFence = !inFence; return; }
    if (inFence) { out.push({ line: idx + 1, text: raw.trim().replace(/^\$\s+/, ''), fenced: true }); return; }
    for (const m of raw.matchAll(/`([^`\n]+)`/g)) out.push({ line: idx + 1, text: m[1].trim(), fenced: false });
  });
  return out;
}

function staleReferences(root, files) {
  const findings = [];
  const pkg = readJson(path.join(root, 'package.json'));
  const scripts = pkg && pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : null;
  const manager = lockManager(root);
  const makefile = readText(path.join(root, 'Makefile')) ?? readText(path.join(root, 'makefile'));
  const makeTargets = makefile ? new Set([...makefile.matchAll(/^([A-Za-z0-9_.-]+)\s*:(?!=)/gm)].map((m) => m[1])) : null;
  const justfile = readText(path.join(root, 'justfile')) ?? readText(path.join(root, 'Justfile'));
  const justRecipes = justfile ? new Set([...justfile.matchAll(/^@?([A-Za-z0-9_-]+)[^\n:=]*:(?!=)/gm)].map((m) => m[1])) : null;
  for (const f of files) {
    if (!['instructions', 'scoped', 'import', 'skill', 'agent', 'command', 'skill-file'].includes(f.kind)) continue;
    const abs = absOf(root, f.path);
    const text = readText(abs, '');
    for (const s of codeSnippets(text)) {
      for (const seg of s.text.split(/\s*(?:&&|\|\||;)\s*/)) {
        let m = /^(npm|pnpm|yarn|bun)\s+(?:(run|run-script)\s+)?([A-Za-z0-9:_.-]+)/.exec(seg);
        if (m && pkg) {
          const [, tool, runWord, name] = m;
          if (manager && manager !== tool && !(tool === 'npm' && /^(npx)$/.test(name))) {
            findings.push({ id: 'STALE_COMMAND', severity: 'finding', file: f.path, line: s.line, message: `\`${seg}\` uses ${tool}, but the lockfile belongs to ${manager}`, evidence: truncate(seg, 120) });
          }
          const isScriptRef = runWord || (tool === 'npm' ? ['test', 't', 'start', 'stop', 'restart'].includes(name) : !NPM_BUILTIN.has(name));
          const scriptName = tool === 'npm' && name === 't' ? 'test' : name;
          if (scripts && isScriptRef && !(scriptName in scripts) && !(tool === 'npm' && scriptName === 'start' && exists(root, 'server.js'))) {
            findings.push({ id: 'STALE_COMMAND', severity: 'finding', file: f.path, line: s.line, message: `\`${seg}\` runs the script "${scriptName}", which package.json does not define`, evidence: truncate(seg, 120) });
          }
          continue;
        }
        m = /^make\s+([A-Za-z0-9_.-]+)/.exec(seg);
        if (m && makeTargets && !makeTargets.has(m[1])) findings.push({ id: 'STALE_COMMAND', severity: 'finding', file: f.path, line: s.line, message: `\`${seg}\`: the Makefile has no target "${m[1]}"`, evidence: truncate(seg, 120) });
        m = /^just\s+([A-Za-z0-9_-]+)/.exec(seg);
        if (m && justRecipes && !justRecipes.has(m[1])) findings.push({ id: 'STALE_COMMAND', severity: 'finding', file: f.path, line: s.line, message: `\`${seg}\`: the justfile has no recipe "${m[1]}"`, evidence: truncate(seg, 120) });
      }
      if (s.fenced) continue;
      const p = s.text;
      if (/^(?:\.{1,2}\/)?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+\/?$/.test(p) && !/^[a-z]+:\/\//i.test(p) && /\.[A-Za-z0-9]{1,8}$|\/$/.test(p) && !/[<>*?{}$]/.test(p)) {
        const candidates = [path.resolve(path.dirname(abs), p), path.resolve(root, p)];
        if (f.kind === 'skill' || f.kind === 'skill-file') candidates.push(path.resolve(path.dirname(abs), '..', p));
        if (!candidates.some((c) => fs.existsSync(c))) {
          findings.push({ id: 'STALE_PATH', severity: 'finding', file: f.path, line: s.line, message: `\`${p}\` does not exist in the repository`, evidence: p });
        }
      }
    }
  }
  return findings;
}

const costCommand = defineCommand({
  name: 'tooling cost',
  usage: 'tooling cost [paths...] [--host all|copilot|claude|codex] [--context-tokens 200000] [--max-tokens n] [--top 10]',
  options: { host: { type: 'string' }, 'context-tokens': { type: 'string' }, 'max-tokens': { type: 'string' }, top: { type: 'string' } },
  async run(ctx, values, positionals) {
    await loadFrontmatterLib();
    const root = rootOf(ctx);
    checkState(ctx, root);
    const contextTokens = values['context-tokens'] ? Number(values['context-tokens']) : 200_000;
    if (!Number.isFinite(contextTokens) || contextTokens <= 0) throw usageError('--context-tokens must be a positive number');
    const res = toolingCost({ root, paths: positionals.length ? positionals.map((p) => path.resolve(ctx.cwd, p)) : null, host: values.host || 'all',
      contextTokens, top: values.top ? Number(values.top) : 10 });
    let exit = EXIT.OK;
    if (values['max-tokens'] != null) {
      const max = Number(values['max-tokens']);
      if (!Number.isFinite(max)) throw usageError('--max-tokens must be a number');
      res.max_tokens = max;
      res.over_max = Object.entries(res.totals).filter(([h, t]) => HOSTS.includes(h) && t.always_on_tokens > max).map(([h]) => h);
      if (res.over_max.length) exit = EXIT.FINDINGS;
    }
    const per = HOSTS.filter((h) => res.totals[h]).map((h) => `${h} ${res.totals[h].always_on_tokens}`).join(', ');
    return { result: res, exit, summary: `${res.files.length} file(s); always-on tokens: ${per}; ${res.findings.length} finding(s)` };
  },
});

// ---------------------------------------------------------------------------
// Scaffold (§11.1)

export const TOOLING_KINDS = Object.freeze(['instructions', 'skill', 'agent', 'prompt', 'hooks', 'mcp', 'plugin']);

/** parseArgs options for tooling scaffolds; scaffold.mjs (WP-H) merges these to pass them through. */
export const TOOLING_SCAFFOLD_OPTIONS = Object.freeze({
  for: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' }, topic: { type: 'string' }, 'apply-to': { type: 'string' },
  events: { type: 'string' }, 'hooks-dir': { type: 'string' }, server: { type: 'string' }, command: { type: 'string' }, args: { type: 'string' },
  url: { type: 'string' }, env: { type: 'string' }, license: { type: 'string' }, out: { type: 'string' }, write: { type: 'boolean' }, force: { type: 'boolean' },
  skills: { type: 'string' }, agents: { type: 'string' }, 'include-hooks': { type: 'boolean' }, 'include-mcp': { type: 'boolean' },
  marketplace: { type: 'string' }, owner: { type: 'string' }, version: { type: 'string' }, lang: { type: 'string' }, 'skill-root': { type: 'string' },
  'exclude-agent': { type: 'string' },
});

async function projectCommands(root) {
  const out = { install: null, test: null, lint: null, typecheck: null };
  // The project's own scripts come first (instructions name `npm test`, not the runner behind it).
  const pkg = readJson(path.join(root, 'package.json'));
  if (pkg && pkg.scripts && typeof pkg.scripts === 'object') {
    const mgr = lockManager(root) || 'npm';
    const sc = pkg.scripts;
    const runS = (s) => (mgr === 'npm' ? (s === 'test' ? 'npm test' : `npm run ${s}`) : `${mgr} ${s === 'test' ? 'test' : `run ${s}`}`);
    if (sc.test && !/no test specified/.test(String(sc.test))) out.test = runS('test');
    if (sc.lint) out.lint = runS('lint');
    const tc = ['typecheck', 'type-check', 'tsc'].find((k) => sc[k]);
    if (tc) out.typecheck = runS(tc);
  }
  try {
    const mod = await import('./detect.mjs');
    if (typeof mod.detect === 'function') {
      const r = await mod.detect({ root, stateInfo: null, refresh: false });
      const p = r && Array.isArray(r.projects) ? r.projects[0] : null;
      if (p) {
        out.install ||= p.managers?.[0]?.install ?? null;
        out.test ||= p.runners?.[0]?.cmd ?? null;
        out.typecheck ||= (p.typecheck || r.typecheck || [])[0]?.cmd ?? null;
        out.lint ||= (p.lint || r.lint || [])[0]?.cmd ?? null;
      }
    }
  } catch {
    // detect.mjs belongs to another work package; the manifest fallbacks below still apply.
  }
  if (pkg) {
    const mgr = lockManager(root) || 'npm';
    out.install ||= { npm: exists(root, 'package-lock.json') ? 'npm ci' : 'npm install', pnpm: 'pnpm install --frozen-lockfile', yarn: 'yarn install --immutable', bun: 'bun install --frozen-lockfile' }[mgr];
    if (!out.typecheck && exists(root, 'tsconfig.json')) out.typecheck = 'npx tsc --noEmit';
  } else if (exists(root, 'go.mod')) {
    out.install ||= 'go mod download';
    out.test ||= 'go test ./...';
    out.typecheck ||= 'go vet ./...';
  } else if (exists(root, 'Cargo.toml')) {
    out.install ||= 'cargo fetch --locked';
    out.test ||= 'cargo test';
    out.typecheck ||= 'cargo check';
  } else if (exists(root, 'pyproject.toml')) {
    const uv = exists(root, 'uv.lock');
    out.install ||= uv ? 'uv sync --locked' : 'pip install -e .';
    out.test ||= uv ? 'uv run pytest' : 'pytest';
  }
  return {
    install: out.install || '(add the install command)',
    test: out.test || '(add the full test command)',
    lint: out.lint || '(add the lint command)',
    typecheck: out.typecheck || '(add the type-check command, or remove this line)',
  };
}

function projectName(root) {
  const pkg = readJson(path.join(root, 'package.json'));
  return (pkg && typeof pkg.name === 'string' && pkg.name) || path.basename(root);
}

const DEFAULT_DESCRIPTION = 'Describe in one sentence what this does. Use when (the requests and phrases that should trigger it). Not for (near-miss tasks it must not handle).';

function firstSentence(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  const m = /^(.{10,}?[.!?])(\s|$)/.exec(s);
  return m ? m[1] : s;
}

function renderSections(kind, host, vars, fmFor) {
  const sections = selectSections(loadBundle('tooling'), { kind, host }).filter((s) => String(s.attrs.kind).split('|').includes(kind));
  return sections.map((s) => {
    const p = renderString(s.path, vars);
    const v = { ...vars, frontmatter: fmFor ? fmFor(p, s) : '' };
    return { path: p, content: renderString(s.content, v) };
  });
}

function skillDirsFor(hosts, name, base = null) {
  if (base) return [{ dir: `${toPosix(base).replace(/\/+$/, '')}/${name}`, hosts }];
  const all = hosts.length === HOSTS.length;
  if (all) return [{ dir: `${SKILL_DIRS.codex}/${name}`, hosts: ['copilot', 'codex'] }, { dir: `${SKILL_DIRS.claude}/${name}`, hosts: ['claude'] }];
  const dirs = [];
  if (hosts.includes('copilot') && hosts.includes('codex')) dirs.push({ dir: `${SKILL_DIRS.codex}/${name}`, hosts: ['copilot', 'codex'] });
  else {
    if (hosts.includes('copilot')) dirs.push({ dir: `${SKILL_DIRS.copilot}/${name}`, hosts: ['copilot'] });
    if (hosts.includes('codex')) dirs.push({ dir: `${SKILL_DIRS.codex}/${name}`, hosts: ['codex'] });
  }
  if (hosts.includes('claude')) dirs.push({ dir: `${SKILL_DIRS.claude}/${name}`, hosts: ['claude'] });
  return dirs;
}

function evalOutputs(evalsDir, name, { triggerSet = true, skillCreator = true } = {}) {
  const outputs = [];
  if (triggerSet) {
    const tpl = readText(path.join(ASSETS_DIR, 'evals', 'trigger-set.template.json'));
    if (tpl == null) throw envError('TEMPLATE_MISSING', 'assets/evals/trigger-set.template.json is missing');
    outputs.push({ path: `${evalsDir}/trigger-set.json`, content: JSON.stringify(JSON.parse(renderString(tpl, { skill_name: name })), null, 2) + '\n' });
  }
  const caseTpl = readText(path.join(ASSETS_DIR, 'evals', 'eval-case.template.md'));
  if (caseTpl == null) throw envError('TEMPLATE_MISSING', 'assets/evals/eval-case.template.md is missing');
  for (const s of parseEvalBundle(caseTpl)) {
    outputs.push({ path: `${evalsDir}/${renderString(s.path, { case: `${name}-basic`, name })}`, content: renderString(s.content, { case: `${name}-basic`, name }) });
  }
  if (skillCreator) outputs.push({ path: `${evalsDir}/evals.json`, content: JSON.stringify(skillCreatorEvals(name), null, 2) + '\n' });
  return outputs;
}

/**
 * skill-creator's `evals/evals.json` (a different format from `claude plugin eval` cases; the
 * two are not interchangeable, so both are generated and each tool ignores the other's files).
 */
function skillCreatorEvals(name) {
  return {
    skill_name: name,
    evals: [{
      id: 1,
      prompt: `TODO: a realistic task that needs the ${name} skill, with the details a user would give`,
      expected_output: 'TODO: what a correct result contains',
      files: [],
      expectations: ['TODO: one verifiable statement about the output', 'TODO: another one'],
    }],
  };
}

function parseEvalBundle(text) {
  const out = [];
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    const m = /^@@@ file: (\S+) @@@$/.exec(line);
    if (m) { if (cur) out.push(cur); cur = { path: m[1], lines: [] }; continue; }
    if (cur) cur.lines.push(line);
  }
  if (cur) out.push(cur);
  return out.map((s) => {
    while (s.lines.length && s.lines[s.lines.length - 1] === '') s.lines.pop();
    return { path: s.path, content: s.lines.join('\n') + '\n' };
  });
}

function hookEventList(value) {
  const map = { posttooluse: 'PostToolUse', pretooluse: 'PreToolUse', sessionstart: 'SessionStart', sessionend: 'SessionEnd', stop: 'Stop', agentstop: 'Stop', userpromptsubmit: 'UserPromptSubmit', userpromptsubmitted: 'UserPromptSubmit' };
  const list = String(value || 'PostToolUse').split(',').map((s) => s.trim()).filter(Boolean);
  return [...new Set(list.map((e) => {
    const v = map[e.toLowerCase()];
    if (!v) throw usageError(`--events: unsupported event "${e}" (use PostToolUse, PreToolUse, SessionStart, SessionEnd, Stop, UserPromptSubmit)`);
    return v;
  }))];
}

function validName(name, what) {
  const problems = skillNameProblems(name);
  if (problems.length) throw usageError(`--name "${name}" is not a valid ${what} name: ${problems.join('; ')}`);
  return name;
}

async function buildScaffold(kind, hosts, values, root) {
  const outputs = [];
  const next = [];
  const manual = [];
  const vars = { generated_by: generatedBy(), project_name: projectName(root) };
  const description = values.description ? String(values.description).replace(/\s+/g, ' ').trim() : DEFAULT_DESCRIPTION;
  if (description.length > 1024) throw usageError('--description must be at most 1,024 characters');
  if (/<[A-Za-z/][^>]*>/.test(description)) throw usageError('--description must not contain XML tags');
  if (kind === 'instructions') {
    const cmds = await projectCommands(root);
    const topic = toSkillName(values.topic || 'testing');
    const globs = String(values['apply-to'] || '**/*.test.*,**/*.spec.*,**/test_*.py,**/*_test.go').split(',').map((s) => s.trim()).filter(Boolean);
    const excludeAgent = values['exclude-agent'] ? String(values['exclude-agent']) : null;
    if (excludeAgent && !['code-review', 'cloud-agent'].includes(excludeAgent)) throw usageError('--exclude-agent must be code-review or cloud-agent');
    Object.assign(vars, { install_cmd: cmds.install, test_cmd: cmds.test, lint_cmd: cmds.lint, typecheck_cmd: cmds.typecheck, topic,
      topic_title: topic.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' '), apply_to_md: globs.map((g) => `\`${g}\``).join(', ') });
    const fmFor = (p) => {
      if (p.endsWith('.instructions.md')) {
        const data = { applyTo: globs.join(','), description: `${vars.topic_title} rules` };
        if (excludeAgent) data.excludeAgent = excludeAgent;
        return stringifyFrontmatter(data).trimEnd();
      }
      if (p.startsWith('.claude/rules/')) return stringifyFrontmatter({ paths: globs }).trimEnd();
      return '';
    };
    for (const h of hosts) outputs.push(...renderSections('instructions', h, vars, fmFor).map((o) => ({ ...o, host: h })));
    next.push('Fill in the Conventions section of AGENTS.md with verifiable one-line rules; keep shared rules there and host-only notes in the host files.');
    next.push('Measure the result: tooling cost (always-on tokens per host) and tooling lint.');
    if (hosts.includes('claude')) next.push('Do not add CLAUDE.local.md: it stops Claude Code from reading AGENTS.md unless the project-instructions setting reads both.');
  } else if (kind === 'skill' || kind === 'prompt' || kind === 'agent') {
    const name = validName(values.name || `my-${kind === 'agent' ? 'agent' : kind === 'prompt' ? 'command' : 'skill'}`, kind);
    Object.assign(vars, { name, description, summary: firstSentence(description) });
    const meta = { version: '0.1.0' };
    const sd = shortDescription(description);
    if (sd) meta['short-description'] = sd;
    if (kind === 'agent') {
      const preload = listOpt(values.skills) || [];
      for (const sk of preload) validName(sk, 'skill');
      for (const h of hosts) {
        if (h === 'codex') {
          const dir = `${CODEX_ONLY_SKILLS_DIR}/${name}`;
          const fm = stringifyFrontmatter({ name, description, metadata: meta }).trimEnd();
          outputs.push(...renderSections('agent', 'codex', { ...vars, skill_dir: dir }, () => fm).map((o) => ({ ...o, host: h })));
          outputs.push({ path: `${dir}/agents/openai.yaml`, content: renderOpenAiYaml({ name, description }), host: h });
          manual.push(`Codex has no custom agent files: ${name} is the skill ${dir} (invoke it as $${name}). The .codex/agents/<name>.toml role format is unverified and was not generated.`);
        } else {
          const data = h === 'copilot' ? { name, description, tools: ['read', 'search'] } : { name, description, tools: 'Read, Grep, Glob' };
          // Shared conventions are preloaded as skills rather than repeated in the agent body.
          if (preload.length) data.skills = preload;
          const fm = stringifyFrontmatter(data, { flowKeys: ['tools', 'skills'] }).trimEnd();
          outputs.push(...renderSections('agent', h, { ...vars, agent_file: name }, () => fm).map((o) => ({ ...o, host: h })));
        }
      }
      next.push('Keep the tool list least-privilege; add edit or execute tools only when the agent must change files or run commands.');
    } else {
      const dirs = skillDirsFor(hosts, name, values['skill-root'] || null);
      for (const d of dirs) {
        const extra = {};
        if (values.license) extra.license = String(values.license);
        const data = { name, description, ...extra, metadata: meta };
        if (kind === 'prompt' && (d.hosts.includes('copilot') || d.hosts.includes('claude'))) data['disable-model-invocation'] = true;
        const fm = stringifyFrontmatter(data).trimEnd();
        outputs.push(...renderSections(kind, d.hosts[0], { ...vars, skill_dir: d.dir, prompt_frontmatter: '', prompt_skill_dir: d.dir }, () => fm)
          .filter((o) => o.path.startsWith(d.dir + '/')).map((o) => ({ ...o, host: d.hosts.join(',') })));
        if (d.hosts.includes('codex')) outputs.push({ path: `${d.dir}/agents/openai.yaml`, content: renderOpenAiYaml({ name, description, implicit: kind !== 'prompt' }), host: 'codex' });
      }
      if (kind === 'prompt' && hosts.includes('copilot')) {
        const promptSkillDir = dirs.find((d) => d.hosts.includes('copilot'))?.dir;
        const pfm = stringifyFrontmatter({ name, description }).trimEnd();
        outputs.push(...renderSections('prompt', 'copilot', { ...vars, prompt_frontmatter: pfm, prompt_skill_dir: promptSkillDir, skill_dir: promptSkillDir }, () => '')
          .filter((o) => o.path.startsWith('.github/prompts/')).map((o) => ({ ...o, host: 'copilot' })));
        manual.push('Prompt files run only in the VS Code Local harness and Visual Studio; Copilot CLI, the cloud agent and the Copilot harness use the skill instead.');
      }
      if (kind === 'skill') {
        const evalDir = (dirs.find((d) => d.hosts.includes('claude')) || dirs[0]).dir;
        outputs.push(...evalOutputs(`${evalDir}/evals`, name).map((o) => ({ ...o, host: 'eval' })));
        next.push(`Write the trigger set (${evalDir}/evals/trigger-set.json) and the eval case before the body: replace every TODO.`);
        next.push(`Then measure: tooling trigger-set ${evalDir} (free: shows the commands), tooling trigger-set ${evalDir} --host claude --run (${PAID_NOTE}).`);
      }
      if (dirs.length > 1) manual.push(`Two copies were generated (${dirs.map((d) => d.dir).join(' and ')}) because Claude Code reads only .claude/skills; after edits run \`tooling port ${dirs[0].dir} --to claude --force\` to sync.`);
      next.push('Write the description as what + when + boundary in the third person (at most 1,024 characters) and keep SKILL.md under 500 lines.');
    }
  } else if (kind === 'hooks') {
    const name = validName(values.name || 'adc-example-hook', 'hook');
    const hooksDir = toPosix(values['hooks-dir'] || 'scripts/hooks').replace(/\/+$/, '');
    const events = hookEventList(values.events);
    Object.assign(vars, { name, hooks_dir: hooksDir, script_path: `${hooksDir}/${name}.mjs`, test_path: `${hooksDir}/${name}.test.mjs` });
    outputs.push(...renderSections('hooks', null, vars).map((o) => ({ ...o, host: 'all' })));
    const CAMEL = { PostToolUse: 'postToolUse', PreToolUse: 'preToolUse', SessionStart: 'sessionStart', SessionEnd: 'sessionEnd', Stop: 'agentStop', UserPromptSubmit: 'userPromptSubmitted' };
    for (const h of hosts) {
      const entries = events.map((ev) => ({
        event: ev, camel: h === 'copilot', matcher: ['PostToolUse', 'PreToolUse'].includes(ev) ? 'Edit|Write' : null, type: 'command',
        exec: { program: 'node', args: [`${hooksDir}/${name}.mjs`, '--dialect', h, '--event', h === 'copilot' ? CAMEL[ev] : ev] },
        posix: null, windows: null, windowsShell: null, timeout: 10, cwd: null, env: null, extra: {}, source: h,
      }));
      const r = renderHookConfig(entries, h, { file: name, guard: true });
      manual.push(...r.manual);
      const doc = h === 'claude' ? { hooks: r.doc.hooks } : r.doc;
      const target = h === 'copilot' ? `.github/hooks/${name}.json` : h === 'claude' ? '.claude/settings.json' : '.codex/hooks.json';
      outputs.push({ path: target, content: JSON.stringify(doc, null, 2) + '\n', host: h,
        merge: (cur) => { const c = cur.trim() ? JSON.parse(cur) : {}; c.hooks ||= {}; if (doc.version) c.version ??= doc.version; for (const [ev, list] of Object.entries(doc.hooks)) { const have = (c.hooks[ev] ||= []); const seen = new Set(have.map((x) => JSON.stringify(x))); for (const it of list) if (!seen.has(JSON.stringify(it))) have.push(it); } return JSON.stringify(c, null, 2) + '\n'; } });
      if (h === 'claude' && hosts.includes('copilot')) manual.push('Copilot CLI and VS Code also run hooks from .claude/settings.json (with Claude-style payloads), so with both files Copilot runs the handler twice per event: keep decide() idempotent, or drop one file. Whether Copilot applies Claude-shaped output from that file is undocumented.');
      if (h === 'codex') manual.push('Codex loads .codex/hooks.json only for trusted projects and asks for a one-time review in /hooks; start Codex at the repository root (the hook path is relative).');
    }
    next.push(`Run the handler tests: node --test ${vars.test_path}`);
    next.push(`Edit decide() in ${vars.script_path} for your check; keep it fast (no network, no repository scans) and keep the fail-open default.`);
  } else if (kind === 'mcp') {
    const serverName = toSkillName(values.server || 'example');
    const url = values.url ? String(values.url) : null;
    if (url && !/^https:\/\//i.test(url) && !/^http:\/\/(localhost|127\.|\[::1\])/i.test(url)) throw usageError('--url must use https (http only for localhost)');
    const env = {};
    for (const n of String(values.env || '').split(',').map((s) => s.trim()).filter(Boolean)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(n)) throw usageError(`--env: "${n}" is not an environment variable name`);
      env[n] = `\${${n}}`;
    }
    const server = url
      ? { name: serverName, transport: 'http', command: null, args: [], env: {}, cwd: null, url, headers: Object.keys(env).length ? { Authorization: `Bearer \${${Object.keys(env)[0]}}` } : {}, tools: null }
      : { name: serverName, transport: 'stdio', command: values.command || 'npx', args: values.args ? String(values.args).split(',').map((s) => s.trim()).filter(Boolean) : ['-y', 'example-mcp-server@1.0.0'], env, cwd: null, url: null, headers: {}, tools: null };
    const targets = new Set();
    if (hosts.includes('claude') || (hosts.includes('copilot') && hosts.length > 1)) targets.add('claude');
    else if (hosts.includes('copilot')) targets.add('copilot');
    if (hosts.includes('codex')) targets.add('codex');
    for (const t of targets) {
      const r = renderMcpConfig([server], t, { file: serverName });
      manual.push(...r.manual);
      if (t === 'codex') outputs.push({ path: '.codex/config.toml', content: r.text, host: 'codex', merge: (cur) => (/\[mcp_servers\.[^\]]*\]/.test(cur) && cur.includes(`[mcp_servers.${serverName}]`) ? cur : cur + (cur && !cur.endsWith('\n') ? '\n' : '') + (cur.trim() ? '\n' : '') + r.text) });
      else {
        const p = t === 'claude' ? '.mcp.json' : '.github/mcp.json';
        outputs.push({ path: p, content: JSON.stringify(r.doc, null, 2) + '\n', host: t === 'claude' && hosts.includes('copilot') ? 'claude,copilot' : t,
          merge: (cur) => { const c = cur.trim() ? JSON.parse(cur) : {}; c.mcpServers ||= {}; c.mcpServers[serverName] ??= r.doc.mcpServers[serverName]; return JSON.stringify(c, null, 2) + '\n'; } });
      }
    }
    if (!values.args && !url) next.push('Replace example-mcp-server@1.0.0 with the real package pinned to an exact version (never @latest).');
    if (hosts.includes('copilot')) {
      const cloud = renderMcpConfig([server], 'copilot').doc;
      next.push(`Copilot cloud agent: paste into repository Settings > Copilot > MCP servers (secrets as COPILOT_MCP_* agent secrets): ${JSON.stringify(cloud)}`);
    }
    next.push('Keep secrets out of the files: reference environment variables (${VAR}) and set them where the host starts.');
  }
  return { outputs, next_steps: next, manual_steps: [...new Set(manual)] };
}

/**
 * Write a tooling scaffold (instructions, skill, agent, prompt, hooks, mcp, plugin) for one
 * or more hosts. Without `write` it is a dry run that lists the files. Existing files are
 * never overwritten without `force`. `opts = { ctx?, values }` (values as parsed CLI options).
 */
export async function scaffoldTooling(kind, opts = {}) {
  await loadFrontmatterLib();
  const values = { ...(opts.values || {}), ...(opts.options || {}) };
  if (opts.host && !values.for) values.for = opts.host;
  const ctx = opts.ctx || makeContext(values);
  if (!TOOLING_KINDS.includes(kind)) throw usageError(`unknown tooling kind "${kind}" (expected ${TOOLING_KINDS.join(', ')})`);
  if (kind === 'plugin') return pluginInit(ctx, values);
  const root = opts.root || rootOf(ctx);
  checkState(ctx, root);
  const hosts = parseHosts(values.for || values.host || 'all');
  const outRoot = values.out ? path.resolve(ctx.cwd, values.out) : root;
  if (outRoot === SKILL_DIR || outRoot.startsWith(SKILL_DIR + path.sep)) throw usageError('refusing to scaffold into the companion skill itself');
  const write = Boolean(values.write) && !ctx.dryRun;
  const built = await buildScaffold(kind, hosts, values, root);
  const applied = applyOutputs(built.outputs, { outRoot, dryRun: !write, force: Boolean(values.force), backupDir: backupDirFactory(ctx, root) });
  const next = [...built.next_steps];
  if (!write) next.unshift(`Dry run: nothing was written. Re-run with --write to create ${applied.written.length} file(s).`);
  if (applied.skipped.length) next.unshift(`${applied.skipped.length} file(s) exist and were left alone; pass --force to ${applied.skipped.some((s) => s.planned === 'merge') ? 'merge or ' : ''}overwrite them (a backup goes to .adc/tooling/backups/).`);
  return {
    kind, hosts, out: toPosix(path.relative(root, outRoot) || '.'), dry_run: !write,
    written: applied.written, skipped: applied.skipped, backups: applied.backups,
    next_steps: next, manual_steps: built.manual_steps,
  };
}

const scaffoldCommand = defineCommand({
  name: 'tooling scaffold',
  usage: 'tooling scaffold <instructions|skill|agent|prompt|hooks|mcp|plugin> [--for copilot|claude|codex|all] [--name n] [--description d] [--out dir] [--write] [--force]',
  options: TOOLING_SCAFFOLD_OPTIONS,
  async run(ctx, values, positionals) {
    const kind = positionals[0];
    if (!kind) throw usageError(`tooling scaffold needs a kind: ${TOOLING_KINDS.join(', ')}`);
    const res = await scaffoldTooling(kind, { ctx, values });
    const n = res.written.filter((w) => w.action !== 'unchanged').length;
    return { result: res, exit: EXIT.OK, summary: `${kind} for ${res.hosts.join(', ')}: ${n} file(s) ${res.dry_run ? 'planned (dry run)' : 'written'}, ${res.skipped.length} skipped` };
  },
});

// ---------------------------------------------------------------------------
// Trigger sets (§11.4)

/** Deterministic, label-stratified 60/40 train/validation split. */
export function assignSplit(queries) {
  const out = queries.map((q) => ({ ...q }));
  for (const label of [true, false]) {
    const group = out.filter((q) => q.should_trigger === label)
      .sort((a, b) => sha256(`${a.id}\n${a.query}`).localeCompare(sha256(`${b.id}\n${b.query}`)));
    const nTrain = Math.round(group.length * 0.6);
    group.forEach((q, k) => { q.split = k < nTrain ? 'train' : 'validation'; });
  }
  return out;
}

/** Load and validate a trigger set (`adc-trigger-set/1` or skill-creator's `[{query, should_trigger}]`). */
export function loadTriggerSet(file) {
  const doc = readJson(file);
  if (doc == null) throw usageError(`trigger set not found or not valid JSON: ${toPosix(file)}`);
  const list = Array.isArray(doc) ? doc : doc.queries;
  if (!Array.isArray(list)) throw usageError(`${toPosix(file)}: expected a "queries" array`);
  const problems = [];
  const queries = list.map((q, k) => {
    if (!q || typeof q.query !== 'string' || !q.query.trim()) problems.push(`query ${k + 1}: "query" must be a non-empty string`);
    if (typeof q?.should_trigger !== 'boolean') problems.push(`query ${k + 1}: "should_trigger" must be true or false`);
    return { id: String(q?.id ?? `q${String(k + 1).padStart(2, '0')}`), query: String(q?.query ?? ''), should_trigger: q?.should_trigger === true };
  });
  if (problems.length) throw usageError(`${toPosix(file)}: ${problems.slice(0, 5).join('; ')}`);
  const ids = new Set();
  for (const q of queries) { if (ids.has(q.id)) throw usageError(`${toPosix(file)}: duplicate query id "${q.id}"`); ids.add(q.id); }
  const todo = queries.filter((q) => /\bTODO\b/.test(q.query)).map((q) => q.id);
  const pos = queries.filter((q) => q.should_trigger).length;
  const warnings = [];
  if (queries.length < 16) warnings.push(`only ${queries.length} queries; use about 20 (8-10 should-trigger, 8-10 near misses)`);
  if (pos < 8 || queries.length - pos < 8) warnings.push(`${pos} should-trigger and ${queries.length - pos} should-not queries; aim for 8-10 of each`);
  return { doc: Array.isArray(doc) ? { queries: list } : doc, queries: assignSplit(queries), todo, warnings, sha256: sha256(readText(file, '')) };
}

function skillInfo(root, cwd, p) {
  const abs = path.resolve(cwd, p || '.');
  const dir = fs.existsSync(abs) && fs.statSync(abs).isDirectory() ? abs : path.dirname(abs);
  const file = path.join(dir, 'SKILL.md');
  const text = readText(file);
  if (text == null) throw usageError(`no SKILL.md in ${toPosix(relPosix(root, dir) ?? dir)}; pass a skill directory`);
  const fm = readFrontmatter(text);
  const name = String(fm.data.name ?? path.basename(dir));
  const description = String(fm.data.description ?? '');
  const whenToUse = fm.data.when_to_use ? String(fm.data.when_to_use) : '';
  return { dir, rel: relPosix(root, dir) ?? toPosix(dir), file, name, description, description_sha256: sha256(`${name}\n${description}\n${whenToUse}`) };
}

function matchesSkill(input, name) {
  if (!input || typeof input !== 'object') return typeof input === 'string' && (input === name || input.endsWith(`:${name}`));
  return Object.values(input).some((v) => typeof v === 'string' && (v === name || v.endsWith(`:${name}`) || v.split(/\s+/)[0] === name || v.split(/\s+/)[0].endsWith(`:${name}`)));
}

/** Claude Code stream-json: a `Skill` tool_use naming the skill (or a Read of its SKILL.md) counts as a trigger. */
export function detectClaudeTrigger(lines, name) {
  const res = { triggered: false, loaded: null, cost_usd: null, error: null };
  for (const line of lines) {
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (!ev || typeof ev !== 'object') continue;
    if (ev.type === 'system' && ev.subtype === 'init' && Array.isArray(ev.skills)) {
      res.loaded = ev.skills.some((s) => { const n = typeof s === 'string' ? s : s?.name; return n === name || String(n).endsWith(`:${name}`); });
    }
    if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
      for (const c of ev.message.content) {
        if (c?.type !== 'tool_use') continue;
        if (c.name === 'Skill' && matchesSkill(c.input, name)) res.triggered = true;
        if (c.name === 'Read' && toPosix(String(c.input?.file_path ?? '')).endsWith(`/${name}/SKILL.md`)) res.triggered = true;
      }
    }
    if (ev.type === 'result') {
      if (typeof ev.total_cost_usd === 'number') res.cost_usd = ev.total_cost_usd;
      if (ev.is_error) res.error = String(ev.result || ev.subtype || 'error').slice(0, 200);
    }
  }
  return res;
}

function walkJson(v, visit, parent = null) {
  if (Array.isArray(v)) { for (const x of v) walkJson(x, visit, parent); return; }
  if (v && typeof v === 'object') { visit(v, parent); for (const x of Object.values(v)) walkJson(x, visit, v); }
}

/**
 * Copilot CLI: no documented skill-load event yet (Appendix C). Detection, in order: a JSONL
 * object whose type/tool mentions "skill" and names the skill; any string naming
 * `skills/<name>/SKILL.md`; a `--share` transcript line that mentions a skill and the name.
 */
export function detectCopilotTrigger(lines, transcript, name) {
  const pathRe = new RegExp(`skills[\\\\/]${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\\\/]SKILL\\.md`);
  let method = null;
  for (const line of lines) {
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    walkJson(ev, (o) => {
      if (method) return;
      const kind = [o.type, o.kind, o.tool, o.toolName, o.name, o.event].filter((x) => typeof x === 'string').join(' ');
      const named = ['skill', 'skillName', 'skill_name', 'name', 'id'].some((k) => typeof o[k] === 'string' && (o[k] === name || o[k].endsWith(`:${name}`)));
      if (/skill/i.test(kind) && named) method = 'jsonl-skill-event';
      else if (Object.values(o).some((x) => typeof x === 'string' && pathRe.test(x))) method = 'jsonl-skill-path';
    });
    if (method) break;
  }
  if (!method && transcript) {
    for (const l of String(transcript).split(/\r?\n/)) {
      if (/skill/i.test(l) && (l.includes(name) || pathRe.test(l)) && !/^\s*>/.test(l)) { method = 'share-transcript'; break; }
    }
  }
  return { triggered: Boolean(method), method };
}

/** Codex `exec --json`: reading the skill's SKILL.md (or running its scripts) is implicit invocation. */
export function detectCodexTrigger(lines, name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`skills[\\\\/]${esc}[\\\\/](SKILL\\.md|scripts[\\\\/])`);
  let error = null;
  for (const line of lines) {
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    let hit = false;
    walkJson(ev, (o) => { if (!hit && Object.values(o).some((x) => typeof x === 'string' && re.test(x))) hit = true; });
    if (hit) return { triggered: true, method: 'skill-file-read', error: null };
    if (ev && (ev.type === 'error' || ev.type === 'turn.failed')) error = String(ev.message || ev.error?.message || 'error').slice(0, 200);
  }
  return { triggered: false, method: null, error };
}

/** Per-query pass rates (errors count as misbehaving runs), suite score, split scores and run-to-run spread. */
export function scoreTriggerRuns(queries, runsById, { runs = 3, queryThreshold = 0.5 } = {}) {
  const results = [];
  for (const q of queries) {
    const rs = runsById[q.id] || [];
    const behaved = rs.filter((r) => r.triggered === q.should_trigger).length;
    const errors = rs.filter((r) => r.triggered == null).length;
    const denom = Math.max(runs, rs.length) || 1;
    const rate = behaved / denom;
    results.push({ id: q.id, split: q.split, should_trigger: q.should_trigger, runs: rs, behaved, errors, triggered: rs.filter((r) => r.triggered === true).length,
      pass_rate: Number(rate.toFixed(4)), passed: rate > queryThreshold });
  }
  const share = (list) => (list.length ? Number((list.filter((r) => r.passed).length / list.length).toFixed(4)) : null);
  const perRun = [];
  const maxRuns = Math.max(0, ...results.map((r) => r.runs.length));
  for (let k = 0; k < maxRuns; k++) {
    const ok = results.filter((r) => r.runs[k] && r.runs[k].triggered === r.should_trigger).length;
    perRun.push(ok / (results.length || 1));
  }
  const mean = perRun.length ? perRun.reduce((a, b) => a + b, 0) / perRun.length : 0;
  const sd = perRun.length > 1 ? Math.sqrt(perRun.reduce((a, b) => a + (b - mean) ** 2, 0) / perRun.length) : 0;
  return {
    results,
    per_query_pass_rate: Object.fromEntries(results.map((r) => [r.id, r.pass_rate])),
    suite_score: share(results),
    train_score: share(results.filter((r) => r.split === 'train')),
    validation_score: share(results.filter((r) => r.split === 'validation')),
    run_scores: perRun.map((x) => Number(x.toFixed(4))),
    sd: Number(sd.toFixed(4)),
    errors: results.reduce((a, r) => a + r.errors, 0),
  };
}

function resolveCli(host, cli) {
  const name = { claude: 'claude', copilot: 'copilot', codex: 'codex' }[host];
  cli ||= process.env[`ADC_${host.toUpperCase()}_CLI`] || null;
  if (cli) {
    const abs = path.resolve(cli);
    if (/\.(mjs|cjs|js)$/i.test(cli)) {
      if (!fs.existsSync(abs)) throw usageError(`--cli script not found: ${toPosix(cli)}`);
      return { cmd: process.execPath, prefix: [abs], shell: false, label: toPosix(cli) };
    }
    const exe = which(cli) || (fs.existsSync(abs) ? abs : null);
    if (!exe) throw envError('NO_HOST_CLI', `--cli ${cli} was not found`);
    return { cmd: exe, prefix: [], shell: IS_WINDOWS && /\.(cmd|bat)$/i.test(exe), label: toPosix(exe) };
  }
  const exe = which(name);
  if (!exe) throw envError('NO_HOST_CLI', `${name} is not on PATH; install it or pass --cli <path>`);
  return { cmd: exe, prefix: [], shell: IS_WINDOWS && /\.(cmd|bat)$/i.test(exe), label: toPosix(exe) };
}

/** Spawn without blocking; `onLine` may return 'stop' to end the run early (saves cost). */
function runAsync({ cmd, args, cwd, env, timeoutMs, shell, onLine }) {
  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let buf = '';
    let stopped = false;
    let timedOut = false;
    let child;
    try {
      child = shell
        ? spawn([cmd, ...args].map((a) => quoteArg(a)).join(' '), { cwd, env, shell: true, windowsHide: true })
        : spawn(cmd, args, { cwd, env, windowsHide: true });
    } catch (err) {
      resolve({ exit: null, stdout: '', stderr: String(err.message), ms: 0, timedOut: false, stopped: false, error: err.code || err.message });
      return;
    }
    const kill = () => { try { child.kill('SIGTERM'); } catch {} setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 2000).unref(); };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    child.stdout.on('data', (d) => {
      const s = d.toString('utf8');
      if (stdout.length < 20_000_000) stdout += s;
      buf += s;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (!stopped && onLine && onLine(line) === 'stop') { stopped = true; kill(); }
      }
    });
    child.stderr.on('data', (d) => { if (stderr.length < 1_000_000) stderr += d.toString('utf8'); });
    child.on('error', (err) => { clearTimeout(timer); resolve({ exit: null, stdout, stderr: stderr + String(err.message), ms: Date.now() - started, timedOut, stopped, error: err.code || err.message }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (buf && onLine && !stopped) onLine(buf);
      resolve({ exit: code, stdout, stderr, ms: Date.now() - started, timedOut, stopped, error: null });
    });
  });
}

function copySkillInto(skill, destDir) {
  ensureDir(destDir);
  for (const f of listFiles(skill.dir, { ignore: new Set(['.git', 'node_modules', 'evals', 'results']), maxFiles: 2000 })) {
    const to = path.join(destDir, ...f.split('/'));
    ensureDir(path.dirname(to));
    fs.copyFileSync(path.join(skill.dir, ...f.split('/')), to);
  }
}

async function runOneTrigger({ host, cli, skill, query, ws, opts, budgetLeft }) {
  const env = { ...process.env, COPILOT_AUTO_UPDATE: 'false', ADC_TRIGGER_EVAL: '1' };
  delete env.CLAUDECODE;
  const cmdQuery = cli.shell ? query.replace(/["%^&|<>!\r\n]/g, ' ') : query;
  let args;
  let sharePath = null;
  if (host === 'claude') {
    args = ['-p', cmdQuery, '--output-format', 'stream-json', '--verbose', '--tools', 'Skill,Read,Glob,Grep', '--permission-mode', 'dontAsk', '--no-session-persistence'];
    if (opts.model) args.push('--model', opts.model);
    if (budgetLeft != null) args.push('--max-budget-usd', String(Math.max(0.01, Math.min(1, budgetLeft)).toFixed(2)));
  } else if (host === 'copilot') {
    sharePath = path.join(ws, `.share-${nonce().slice(0, 8)}.md`);
    args = ['-p', cmdQuery, '--output-format', 'json', '--no-ask-user', '--trust-folder', '--share', sharePath];
    if (opts.model) args.push('--model', opts.model);
  } else {
    args = ['exec', '--json', '--ephemeral', '--skip-git-repo-check'];
    if (opts.model) args.push('--model', opts.model);
    args.push(cmdQuery);
  }
  const lines = [];
  let early = false;
  const res = await runAsync({ cmd: cli.cmd, args: [...cli.prefix, ...args], cwd: ws, env, timeoutMs: opts.timeoutMs, shell: cli.shell,
    onLine: (line) => {
      lines.push(line);
      if (host === 'claude' && detectClaudeTrigger([line], skill.name).triggered) { early = true; return 'stop'; }
      if (host === 'codex' && detectCodexTrigger([line], skill.name).triggered) { early = true; return 'stop'; }
      return null;
    } });
  let det;
  if (host === 'claude') det = detectClaudeTrigger(lines, skill.name);
  else if (host === 'codex') det = detectCodexTrigger(lines, skill.name);
  else det = detectCopilotTrigger(lines, sharePath ? readText(sharePath, '') : '', skill.name);
  if (sharePath) fs.rmSync(sharePath, { force: true });
  const failed = !det.triggered && !early && (res.error || res.timedOut || (res.exit !== 0 && res.exit !== null) || det.error);
  return {
    triggered: det.triggered ? true : failed ? null : false,
    method: det.method || (host === 'claude' ? 'skill-tool-call' : null),
    loaded: det.loaded ?? null,
    exit: res.exit, ms: res.ms, timed_out: res.timedOut, stopped_early: early,
    cost_usd: det.cost_usd ?? null,
    error: failed ? truncate(String(det.error || res.error || (res.timedOut ? 'timeout' : `exit ${res.exit}: ${(res.stderr || '').trim().split(/\r?\n/).pop() || ''}`)), 200) : null,
  };
}

async function runTriggerSet({ host, cli, skill, queries, runs, opts }) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'adc-trigger-'));
  const ws = path.join(base, 'ws');
  ensureDir(ws);
  copySkillInto(skill, path.join(ws, ...SKILL_DIRS[host].split('/'), skill.name));
  if (host === 'codex' && which('git')) run('git', ['init', '-q'], { cwd: ws });
  const runsById = {};
  // Claude reports the cost of each finished run. A run stopped early (the skill already
  // triggered) never prints its result event, so it is priced at the mean of the priced runs.
  let measured = 0;
  let priced = 0;
  let unpriced = 0;
  const estimate = () => (priced ? (measured / priced) * unpriced : 0);
  const spent = () => measured + estimate();
  let partial = false;
  const jobs = [];
  for (const q of queries) for (let k = 0; k < runs; k++) jobs.push({ q, k });
  let next = 0;
  const capped = host === 'claude' && opts.maxCostUsd != null;
  const worker = async () => {
    for (;;) {
      const j = jobs[next++];
      if (!j) return;
      if (capped && spent() >= opts.maxCostUsd) { partial = true; (runsById[j.q.id] ||= [])[j.k] = { triggered: null, error: 'skipped: --max-cost-usd reached' }; continue; }
      const r = await runOneTrigger({ host, cli, skill, query: j.q.query, ws, opts, budgetLeft: capped ? opts.maxCostUsd - spent() : null });
      if (typeof r.cost_usd === 'number') { measured += r.cost_usd; priced++; } else if (host === 'claude' && r.stopped_early) unpriced++;
      (runsById[j.q.id] ||= [])[j.k] = r;
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.max(1, Math.min(8, opts.concurrency || 1)) }, worker));
  } finally {
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 });
  }
  const round = (x) => Number(x.toFixed(4));
  if (host !== 'claude') return { runsById, cost_usd: null, cost: { method: `${host} does not report a cost per run; check your plan's usage page` }, partial };
  return { runsById, cost_usd: round(spent()), partial,
    cost: { measured_usd: round(measured), measured_runs: priced, estimated_usd: round(estimate()), estimated_runs: unpriced,
      method: 'result.total_cost_usd per run; runs stopped early are priced at the mean of the priced runs' } };
}

function triggerCommands(skillRel, setRel) {
  const adc = toPosix(ADC_SCRIPT);
  const base = `node "${adc}" tooling trigger-set ${quoteArg(skillRel)}${setRel ? ` --set ${quoteArg(setRel)}` : ''}`;
  return {
    claude: `${base} --host claude --run --runs 3 --max-cost-usd 10`,
    copilot: `${base} --host copilot --run --runs 3`,
    codex: `${base} --host codex --run --runs 3`,
  };
}

function latestResults(stateDir, slug, { host = null, descriptionSha = null } = {}) {
  const dir = path.join(statePaths(stateDir).tooling, slug);
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /^trigger-[a-z]+-.*\.json$/.test(f)).sort(); } catch { return { latest: null, count: 0 }; }
  // Newest by measurement time (milliseconds), so two runs in the same second keep their order.
  const all = files.map((f) => ({ file: path.join(dir, f), doc: readJson(path.join(dir, f)) })).filter((x) => x.doc)
    .sort((a, b) => String(a.doc.measured_at || '').localeCompare(String(b.doc.measured_at || '')) || a.file.localeCompare(b.file));
  const mine = all.filter((x) => (!host || x.doc.host === host));
  const matching = mine.filter((x) => !descriptionSha || x.doc.description_sha256 === descriptionSha);
  return { latest: matching.length ? matching[matching.length - 1] : null, count: mine.length };
}

/**
 * Generate, validate and (with `run`, paid) execute a skill's trigger set headless.
 * Returns `{ queries[], results[], per_query_pass_rate, suite_score, ... }`.
 */
export async function triggerSet({ ctx, root, skillPath, setPath = null, init = false, host = null, runIt = false, runs = 3, threshold = 0.8,
  queryThreshold = 0.5, split = 'all', cli = null, model = null, maxCostUsd = null, timeoutS = 180, concurrency = 1, resultsFile = null, force = false } = {}) {
  await loadFrontmatterLib();
  const skill = skillInfo(root, ctx.cwd, skillPath);
  const setAbs = setPath ? path.resolve(ctx.cwd, setPath) : path.join(skill.dir, 'evals', 'trigger-set.json');
  const setRel = relPosix(root, setAbs) ?? toPosix(setAbs);
  const out = { skill: skill.name, skill_dir: skill.rel, set_path: setRel, description_sha256: skill.description_sha256, host: host || null };
  if (init) {
    const tpl = readText(path.join(ASSETS_DIR, 'evals', 'trigger-set.template.json'));
    const content = JSON.stringify(JSON.parse(renderString(tpl, { skill_name: skill.name })), null, 2) + '\n';
    const applied = applyOutputs([{ path: setRel, content, host: 'eval' }], { outRoot: root, dryRun: ctx.dryRun, force, backupDir: backupDirFactory(ctx, root) });
    out.init = applied;
  }
  if (!fs.existsSync(setAbs)) {
    if (ctx.dryRun && init) return { ...out, queries: [], results: [], per_query_pass_rate: {}, suite_score: null, ready: false, next_steps: ['Dry run: re-run without --dry-run to write the trigger set template.'] };
    throw usageError(`no trigger set at ${setRel}; create one with: tooling trigger-set ${skill.rel} --init`);
  }
  const set = loadTriggerSet(setAbs);
  runs = Number(runs || set.doc.runs || 3);
  if (!Number.isInteger(runs) || runs < 1 || runs > 10) throw usageError('--runs must be an integer from 1 to 10');
  const queries = split === 'all' ? set.queries : set.queries.filter((q) => q.split === split);
  Object.assign(out, { set_sha256: set.sha256, ready: set.todo.length === 0, todo: set.todo, warnings: [...set.warnings], queries,
    runs, query_threshold: queryThreshold, threshold, split });
  const state = runIt || resultsFile ? openState(ctx, root) : null;
  let runsById = null;
  if (resultsFile) {
    const prev = readJson(path.resolve(ctx.cwd, resultsFile));
    if (!prev || !Array.isArray(prev.results)) throw usageError(`${resultsFile}: not a trigger-set results file`);
    runsById = Object.fromEntries(prev.results.map((r) => [r.id, r.runs || []]));
    out.host = prev.host || host;
    out.imported_from = toPosix(resultsFile);
    if (prev.description_sha256 && prev.description_sha256 !== skill.description_sha256) out.warnings.push('the imported results were measured on a different description');
  } else if (runIt) {
    if (!host) throw usageError('--run needs --host claude|copilot|codex');
    if (!out.ready) throw usageError(`the trigger set still has TODO queries (${set.todo.slice(0, 5).join(', ')}); write real queries first`);
    const cliInfo = resolveCli(host, cli);
    const slug = artifactSlug(skill.rel);
    const prior = latestResults(state.dir, slug, { host });
    out.iteration = prior.count + 1;
    if (out.iteration > 5) out.warnings.push(`iteration ${out.iteration}: more than 5 revisions against this set risks overfitting; write 5-10 fresh queries`);
    if (host === 'claude') {
      const personal = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'skills', skill.name);
      if (fs.existsSync(personal) && path.resolve(personal) !== path.resolve(skill.dir)) out.warnings.push(`a personal skill ${toPosix(personal)} has the same name and takes precedence over the copy under test`);
    }
    const r = await runTriggerSet({ host, cli: cliInfo, skill, queries, runs,
      opts: { model, maxCostUsd: maxCostUsd ?? (host === 'claude' ? 10 : null), timeoutMs: Number(timeoutS) * 1000, concurrency } });
    runsById = r.runsById;
    if (host !== 'claude' && maxCostUsd != null) out.warnings.push(`--max-cost-usd applies to Claude Code only; ${host} reports no per-run cost, so cap spend with --runs and the query count`);
    Object.assign(out, { cli: cliInfo.label, cost_usd: r.cost_usd, cost: r.cost, partial: r.partial, measured_at: nowIso(),
      method: host === 'claude' ? 'claude -p stream-json: Skill tool call' : host === 'copilot' ? 'copilot -p JSONL + --share transcript (unconfirmed, Appendix C)' : 'codex exec --json: SKILL.md read',
      confidence: host === 'claude' ? 'high' : host === 'copilot' ? 'unconfirmed' : 'medium' });
  }
  if (!runsById) {
    return { ...out, results: [], per_query_pass_rate: {}, suite_score: null, commands: triggerCommands(skill.rel, setPath ? setRel : null),
      next_steps: [out.ready ? `Run it (${PAID_NOTE}): ${triggerCommands(skill.rel, setPath ? setRel : null)[host || 'claude']}` : `Replace the TODO queries in ${setRel}, then run it.`] };
  }
  const scored = scoreTriggerRuns(queries, runsById, { runs, queryThreshold });
  Object.assign(out, scored, { passed: scored.suite_score != null && scored.suite_score >= threshold });
  if (state && runIt) {
    const slug = artifactSlug(skill.rel);
    const file = path.join(statePaths(state.dir).tooling, slug, `trigger-${host}-${tsId()}.json`);
    writeJsonAtomic(file, out);
    out.results_path = toPosix(relPosix(root, file) ?? file);
    appendMetrics(state.dir, { kind: 'tooling-trigger-set', skill: skill.name, host, suite_score: out.suite_score, sd: out.sd, cost_usd: out.cost_usd ?? null, description_sha256: skill.description_sha256 });
  }
  return out;
}

const triggerSetCommand = defineCommand({
  name: 'tooling trigger-set',
  usage: 'tooling trigger-set [skill-dir] [--init] [--set file] [--host claude|copilot|codex] [--run] [--runs 3] [--threshold 0.8] [--query-threshold 0.5] [--split all|train|validation] [--cli path] [--model m] [--max-cost-usd 10] [--timeout-s 180] [--concurrency 1] [--results file] [--force]',
  options: { init: { type: 'boolean' }, set: { type: 'string' }, host: { type: 'string' }, run: { type: 'boolean' }, runs: { type: 'string' },
    threshold: { type: 'string' }, 'query-threshold': { type: 'string' }, split: { type: 'string' }, cli: { type: 'string' }, model: { type: 'string' },
    'max-cost-usd': { type: 'string' }, 'timeout-s': { type: 'string' }, concurrency: { type: 'string' }, results: { type: 'string' }, force: { type: 'boolean' } },
  async run(ctx, values, positionals) {
    const root = rootOf(ctx);
    checkState(ctx, root);
    if (values.host && !HOSTS.includes(values.host)) throw usageError('--host must be claude, copilot or codex');
    const num = (v, d, name) => { if (v == null) return d; const n = Number(v); if (!Number.isFinite(n)) throw usageError(`--${name} must be a number`); return n; };
    const split = values.split || 'all';
    if (!['all', 'train', 'validation'].includes(split)) throw usageError('--split must be all, train or validation');
    const res = await triggerSet({ ctx, root, skillPath: positionals[0] || '.', setPath: values.set || null, init: Boolean(values.init), host: values.host || null,
      runIt: Boolean(values.run), runs: values.runs ? Number(values.runs) : null, threshold: num(values.threshold, 0.8, 'threshold'),
      queryThreshold: num(values['query-threshold'], 0.5, 'query-threshold'), split, cli: values.cli || null, model: values.model || null,
      maxCostUsd: num(values['max-cost-usd'], null, 'max-cost-usd'), timeoutS: num(values['timeout-s'], 180, 'timeout-s'),
      concurrency: num(values.concurrency, 1, 'concurrency'), resultsFile: values.results || null, force: Boolean(values.force) });
    let exit = EXIT.OK;
    if (res.suite_score != null) {
      const total = res.results.reduce((a, r) => a + r.runs.length, 0) || 1;
      if (res.errors / total > 0.5) exit = EXIT.UNVERIFIABLE;
      else if (!res.passed) exit = EXIT.FINDINGS;
    }
    const summary = res.suite_score == null
      ? `${res.queries.length} queries (${res.ready ? 'ready' : `${res.todo.length} TODO`}); not run`
      : `${res.host}: suite score ${res.suite_score} (threshold ${res.threshold}), train ${res.train_score}, validation ${res.validation_score}${res.cost_usd != null ? `, $${res.cost_usd}` : ''}`;
    return { result: res, exit, summary };
  },
});

// ---------------------------------------------------------------------------
// Safe-change loop (§11.6)

async function lintArtifact(root, absPaths, { strict = false } = {}) {
  let mod;
  try { mod = await import('./tooling-lint.mjs'); } catch { return { status: 'unavailable', reason: 'scripts/lib/tooling-lint.mjs is not available', errors: [], warnings: [] }; }
  if (typeof mod.lintPaths !== 'function') return { status: 'unavailable', reason: 'tooling-lint.mjs has no lintPaths', errors: [], warnings: [] };
  try {
    const r = await mod.lintPaths(absPaths, { host: 'all', strict, root });
    const errors = [];
    const warnings = [];
    const norm = (file, host, e) => {
      const message = typeof e === 'string' ? e : String(e?.message ?? JSON.stringify(e));
      const rule = typeof e === 'object' && e ? (e.rule || e.id || e.code || null) : null;
      return { file: toPosix(relPosix(root, path.resolve(root, String(file ?? ''))) ?? file), host, rule, message, key: `${host}|${rule}|${message.replace(/\d+/g, '#')}` };
    };
    for (const f of r?.files || []) {
      for (const hr of f.host_results || []) {
        for (const e of hr.errors || []) errors.push(norm(f.path, hr.host, e));
        for (const w of hr.warnings || []) warnings.push(norm(f.path, hr.host, w));
      }
    }
    return { status: 'ok', errors, warnings, security: Array.isArray(r?.security) ? r.security.length : 0 };
  } catch (err) {
    return { status: 'error', reason: truncate(String(err?.message || err), 200), errors: [], warnings: [] };
  }
}

function artifactFiles(root, rel) {
  const abs = absOf(root, rel);
  if (fs.statSync(abs).isDirectory()) return listFiles(abs, { ignore: new Set(['.git', 'node_modules', 'results']), maxFiles: 2000 }).map((f) => `${rel}/${f}`);
  return [rel];
}

function contentDigest(root, files) {
  return sha256(files.slice().sort().map((f) => `${f}\0${readText(absOf(root, f), '')}`).join('\0'));
}

function renderContext(root, rel, cls) {
  const abs = absOf(root, rel);
  const isDir = fs.statSync(abs).isDirectory();
  const file = isDir ? path.join(abs, 'SKILL.md') : abs;
  const text = readText(file, '');
  if (['skill', 'agent', 'command'].includes(cls.kind)) {
    const fm = readFrontmatter(text);
    const name = String(fm.data.name ?? path.basename(isDir ? abs : file).replace(/\.agent\.md$|\.md$/, ''));
    const desc = String(fm.data.description ?? '').replace(/\s+/g, ' ').trim();
    return `<available_skills>\n<skill>\n<name>${name}</name>\n<description>${desc}</description>\n</skill>\n</available_skills>\n\n--- body (on demand) ---\n${fm.body}`;
  }
  if (cls.kind === 'instructions' || cls.kind === 'scoped') {
    const inl = inlineImports(text, file);
    return HOSTS.map((h) => `--- ${h} ---\n${h === 'claude' ? stripHtmlComments(inl.text) : h === 'codex' ? text : inl.text}`).join('\n');
  }
  if (cls.kind === 'hooks') { try { return JSON.stringify(parseHookConfig(text, cls.host, rel).entries, null, 2); } catch { return text; } }
  if (cls.kind === 'mcp') { try { return JSON.stringify(parseMcpConfig(text, cls.dialect, rel).servers, null, 2); } catch { return text; } }
  return text;
}

function externalSnapshots(root, rel, cls) {
  const out = [];
  const abs = absOf(root, rel);
  if (cls.kind === 'skill' && which('skills-ref')) {
    const r = run('skills-ref', ['to-prompt', fs.statSync(abs).isDirectory() ? abs : path.dirname(abs)], { timeoutMs: 30_000 });
    out.push({ name: 'skills-ref to-prompt', exit: r.exit, output: truncate(r.stdout || r.stderr, 200_000) });
  }
  if (['instructions', 'scoped'].includes(cls.kind) && which('copilot')) {
    const r = run('copilot', ['instruction', 'list', '--json'], { cwd: root, timeoutMs: 30_000, env: { ...process.env, COPILOT_AUTO_UPDATE: 'false' } });
    out.push({ name: 'copilot instruction list --json', exit: r.exit, output: truncate(r.stdout || r.stderr, 200_000) });
  }
  return out;
}

function readOutcome(file) {
  if (!file) return { status: 'not-measured', score: null };
  const doc = readJson(file);
  if (!doc) throw usageError(`--outcome-results ${toPosix(file)}: not valid JSON`);
  const score = doc.aggregates?.overallScore ?? doc.overallScore ?? doc.score ?? null;
  if (typeof score !== 'number') throw usageError(`--outcome-results ${toPosix(file)}: no aggregates.overallScore (claude plugin eval --json output expected)`);
  const caseScores = Array.isArray(doc.cases) ? doc.cases.map((c) => c?.aggregates?.score).filter((x) => typeof x === 'number') : [];
  const mean = caseScores.length ? caseScores.reduce((a, b) => a + b, 0) / caseScores.length : score;
  const sd = caseScores.length > 1 ? Math.sqrt(caseScores.reduce((a, b) => a + (b - mean) ** 2, 0) / caseScores.length) / Math.sqrt(caseScores.length) : 0;
  return { status: 'measured', score, sd: Number(sd.toFixed(4)), partial: Boolean(doc.partial), source: toPosix(file) };
}

function loadingHosts(cls, lint) {
  const bad = new Set(lint.status === 'ok' ? lint.errors.map((e) => e.host) : []);
  return (cls.hosts || []).filter((h) => !bad.has(h));
}

/** All measurements of one artifact (§11.6 step 1/3). */
export async function measureArtifact({ ctx, root, rel, state, strict = false, outcomeResults = null, external = false, triggerHost = null, runTriggers = false, triggerOpts = {} }) {
  await loadFrontmatterLib();
  const abs = absOf(root, rel);
  if (!fs.existsSync(abs)) throw usageError(`not found: ${rel}`);
  const isDir = fs.statSync(abs).isDirectory();
  const cls = classifyArtifact(isDir ? `${rel}/SKILL.md` : rel);
  if (!cls) throw usageError(`${rel} is not a recognized tooling file (instructions, skill, agent, prompt, command, hooks or MCP config)`);
  const files = artifactFiles(root, rel);
  const lint = await lintArtifact(root, [abs], { strict });
  const cost = toolingCost({ root, artifacts: discoverTooling(root, { paths: [abs] }) });
  const costByHost = Object.fromEntries(HOSTS.map((h) => [h, { always_on_tokens: cost.totals[h].always_on_tokens, on_demand_tokens: cost.totals[h].on_demand_tokens }]));
  const m = { artifact: rel, kind: cls.kind, host: cls.host, measured_at: nowIso(), files, content_sha256: contentDigest(root, files), lint,
    cost: { per_host: costByHost, max_always_on_tokens: cost.totals.max_always_on_tokens }, trigger: { status: 'not-applicable' }, outcome: readOutcome(outcomeResults),
    hosts: loadingHosts(cls, lint), external: [] };
  if (cls.kind === 'skill') {
    const skill = skillInfo(root, root, isDir ? rel : path.posix.dirname(rel));
    m.description_sha256 = skill.description_sha256;
    m.trigger = { status: 'not-measured', description_sha256: skill.description_sha256 };
    if (runTriggers) {
      const r = await triggerSet({ ctx, root, skillPath: absOf(root, skill.rel), host: triggerHost || 'claude', runIt: true, ...triggerOpts });
      m.trigger = { status: 'measured', host: r.host, suite_score: r.suite_score, sd: r.sd, results_path: r.results_path, description_sha256: skill.description_sha256 };
    } else if (state) {
      const found = latestResults(state.dir, artifactSlug(skill.rel), { host: triggerHost, descriptionSha: skill.description_sha256 }).latest;
      if (found) m.trigger = { status: 'measured', host: found.doc.host, suite_score: found.doc.suite_score, sd: found.doc.sd ?? 0, results_path: toPosix(relPosix(root, found.file) ?? found.file), description_sha256: skill.description_sha256 };
    }
  }
  m.context = renderContext(root, rel, cls);
  if (external) m.external = externalSnapshots(root, rel, cls);
  return m;
}

function baselineRoot(stateDir, rel) {
  return path.join(statePaths(stateDir).tooling, artifactSlug(rel), 'baselines');
}

function latestBaseline(stateDir, rel) {
  const dir = baselineRoot(stateDir, rel);
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => fs.existsSync(path.join(dir, n, 'baseline.json'))).sort(); } catch { return null; }
  if (!names.length) return null;
  const d = path.join(dir, names[names.length - 1]);
  return { dir: d, doc: readJson(path.join(d, 'baseline.json')) };
}

function saveBaseline(root, stateDir, rel, measurement) {
  const dir = path.join(baselineRoot(stateDir, rel), tsId());
  ensureDir(dir);
  for (const f of measurement.files) {
    const to = path.join(dir, 'files', ...f.split('/'));
    ensureDir(path.dirname(to));
    fs.copyFileSync(absOf(root, f), to);
  }
  const { context, ...rest } = measurement;
  writeFileAtomic(path.join(dir, 'context.txt'), context || '');
  for (const [k, e] of (measurement.external || []).entries()) writeFileAtomic(path.join(dir, `external-${k}.txt`), e.output || '');
  writeJsonAtomic(path.join(dir, 'baseline.json'), { schema: 'adc-tooling-baseline/1', ...rest, external: (measurement.external || []).map((e) => ({ name: e.name, exit: e.exit })) });
  return dir;
}

function lineDiff(a, b, max = 40) {
  const A = String(a).split('\n');
  const B = String(b).split('\n');
  const setA = new Set(A);
  const setB = new Set(B);
  const removed = A.filter((l) => !setB.has(l));
  const added = B.filter((l) => !setA.has(l));
  return { added: added.length, removed: removed.length, sample: [...removed.slice(0, max / 2).map((l) => `- ${truncate(l, 160)}`), ...added.slice(0, max / 2).map((l) => `+ ${truncate(l, 160)}`)] };
}

/** Deltas and the acceptance rule (§11.6 step 4). */
export function compareMeasurements(before, after, { note = null } = {}) {
  const failing = [];
  const unverified = [];
  const deltas = {};
  // Lint: no new errors.
  if (before.lint?.status === 'ok' && after.lint?.status === 'ok') {
    const had = new Set(before.lint.errors.map((e) => e.key));
    const now = new Set(after.lint.errors.map((e) => e.key));
    const added = after.lint.errors.filter((e) => !had.has(e.key));
    const fixed = before.lint.errors.filter((e) => !now.has(e.key));
    deltas.lint = { status: 'measured', errors_before: before.lint.errors.length, errors_after: after.lint.errors.length, new_errors: added, fixed: fixed.length,
      warnings_before: before.lint.warnings.length, warnings_after: after.lint.warnings.length };
    if (added.length) failing.push(`lint: ${added.length} new error(s)`);
  } else deltas.lint = { status: 'not-measured', reason: after.lint?.reason || before.lint?.reason || 'lint unavailable' };
  // Tokens: not up unless a change note justifies it.
  const tok = {};
  let up = false;
  let down = false;
  for (const h of HOSTS) {
    const b = before.cost?.per_host?.[h]?.always_on_tokens ?? 0;
    const a = after.cost?.per_host?.[h]?.always_on_tokens ?? 0;
    tok[h] = { before: b, after: a, delta: a - b };
    if (a > b) up = true;
    if (a < b) down = true;
  }
  deltas.tokens = { per_host: tok, increased: up, decreased: down, justified_by_note: Boolean(up && note) };
  if (up && !note) failing.push('tokens: always-on context cost went up without a change note (--note)');
  // Trigger and outcome: not below baseline beyond the measured variance.
  for (const key of ['trigger', 'outcome']) {
    const b = before[key];
    const a = after[key];
    const scoreKey = key === 'trigger' ? 'suite_score' : 'score';
    if (b?.status === 'measured' && a?.status === 'measured') {
      const tol = Math.max(b.sd || 0, a.sd || 0);
      const delta = Number((a[scoreKey] - b[scoreKey]).toFixed(4));
      deltas[key] = { status: 'measured', before: b[scoreKey], after: a[scoreKey], delta, tolerance: tol };
      if (delta < -tol - 1e-9) failing.push(`${key}: score fell from ${b[scoreKey]} to ${a[scoreKey]} (tolerance ${tol})`);
    } else if (b?.status === 'measured') {
      deltas[key] = { status: 'not-remeasured', before: b[scoreKey], after: null };
      unverified.push(`${key}: measured in the baseline but not after the change`);
    } else deltas[key] = { status: a?.status === 'measured' ? 'no-baseline' : 'not-measured', after: a?.[scoreKey] ?? null };
  }
  // Portability: hosts lost.
  const lost = (before.hosts || []).filter((h) => !(after.hosts || []).includes(h));
  const gained = (after.hosts || []).filter((h) => !(before.hosts || []).includes(h));
  deltas.hosts = { before: before.hosts || [], after: after.hosts || [], lost, gained };
  if (lost.length) failing.push(`portability: no longer loads in ${lost.join(', ')}`);
  deltas.context = lineDiff(before.context ?? '', after.context ?? '');
  const verdict = failing.length ? 'reject' : unverified.length ? 'unverified' : 'accept';
  return { verdict, failing, unverified, deltas };
}

function changelogEntry(rel, cmp, note) {
  const t = cmp.deltas.tokens.per_host;
  const tokens = HOSTS.filter((h) => t[h].before || t[h].after).map((h) => `${h} ${t[h].before} -> ${t[h].after}`).join(', ') || 'unchanged';
  const parts = [`always-on tokens ${tokens}`];
  for (const k of ['trigger', 'outcome']) if (cmp.deltas[k].status === 'measured') parts.push(`${k} ${cmp.deltas[k].before} -> ${cmp.deltas[k].after}`);
  if (cmp.deltas.lint.status === 'measured') parts.push(`lint errors ${cmp.deltas.lint.errors_before} -> ${cmp.deltas.lint.errors_after}`);
  return `- \`${rel}\`: ${note || 'tooling change'} (${parts.join('; ')}; verified with tooling modify compare on ${today()}).`;
}

function insertChangelog(text, entry) {
  if (!text || !text.trim()) return `# Changelog\n\n## [Unreleased]\n\n### Changed\n\n${entry}\n`;
  const lines = text.split('\n');
  const u = lines.findIndex((l) => /^##\s+\[?Unreleased\]?/i.test(l));
  if (u >= 0) {
    let k = u + 1;
    const changed = lines.findIndex((l, idx) => idx > u && /^###\s+Changed/i.test(l));
    const nextH2 = lines.findIndex((l, idx) => idx > u && /^##\s/.test(l));
    if (changed > u && (nextH2 < 0 || changed < nextH2)) {
      k = changed + 1;
      while (k < lines.length && lines[k].trim() === '') k++;
      lines.splice(k, 0, entry);
    } else {
      lines.splice(u + 1, 0, '', '### Changed', '', entry);
    }
    return lines.join('\n');
  }
  const firstH2 = lines.findIndex((l) => /^##\s/.test(l));
  const block = ['## [Unreleased]', '', '### Changed', '', entry, ''];
  if (firstH2 >= 0) lines.splice(firstH2, 0, ...block);
  else lines.push('', ...block);
  return lines.join('\n');
}

function bumpSemver(v, kind) {
  const m = /^(\d+)\.(\d+)\.(\d+)(.*)$/.exec(String(v || ''));
  if (!m) return null;
  const [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (kind === 'major') return `${maj + 1}.0.0`;
  if (kind === 'minor') return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`;
}

/** Bump metadata.version in a SKILL.md (in place, only that line) or version in a plugin.json. */
function bumpVersion(root, rel, cls, kind) {
  if (kind === 'none') return null;
  const abs = absOf(root, rel);
  if (cls.kind === 'skill') {
    const file = fs.statSync(abs).isDirectory() ? path.join(abs, 'SKILL.md') : abs;
    const text = readText(file, '');
    const lines = text.split('\n');
    let inFm = false;
    let inMeta = false;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i].replace(/\r$/, '');
      if (i === 0 && l === '---') { inFm = true; continue; }
      if (inFm && l === '---') break;
      if (!inFm) break;
      if (/^metadata:\s*$/.test(l)) { inMeta = true; continue; }
      if (inMeta && /^\S/.test(l)) inMeta = false;
      const m = inMeta && /^(\s+version:\s*)(["']?)([^"'\s]+)\2(\s*)$/.exec(l);
      if (m) {
        const next = bumpSemver(m[3], kind);
        if (!next) return { file: toPosix(relPosix(root, file)), from: m[3], to: null, reason: 'not semantic versioning' };
        lines[i] = `${m[1]}"${next}"${m[4]}${lines[i].endsWith('\r') ? '\r' : ''}`;
        writeFileAtomic(file, lines.join('\n'));
        return { file: toPosix(relPosix(root, file)), from: m[3], to: next };
      }
    }
    return { file: toPosix(relPosix(root, file)), from: null, to: null, reason: 'no metadata.version to bump; add one' };
  }
  if (cls.kind === 'plugin') {
    const doc = readJson(abs);
    if (!doc || !doc.version) return { file: rel, from: null, to: null, reason: 'no version field (commits drive updates)' };
    const from = doc.version;
    const next = bumpSemver(from, kind);
    if (!next) return { file: rel, from, to: null, reason: 'not semantic versioning' };
    doc.version = next;
    writeJsonAtomic(abs, doc);
    return { file: rel, from, to: next };
  }
  return null;
}

function resolveArtifactRel(root, cwd, p) {
  if (!p) throw usageError('tooling modify needs an artifact path');
  let abs = path.resolve(cwd, p);
  if (!fs.existsSync(abs)) throw usageError(`not found: ${toPosix(p)}`);
  if (!fs.statSync(abs).isDirectory() && path.basename(abs) === 'SKILL.md') abs = path.dirname(abs);
  const rel = relPosix(root, abs);
  if (!rel || rel === '.') throw usageError('the artifact must be a file or skill directory inside the repository');
  return rel;
}

async function modifyRun(ctx, verb, values, p) {
  const root = rootOf(ctx);
  checkState(ctx, root);
  const note = values.note ? String(values.note) : null;
  const common = { strict: Boolean(values.strict), outcomeResults: values['outcome-results'] ? path.resolve(ctx.cwd, values['outcome-results']) : null,
    external: Boolean(values.external), triggerHost: values.host || null, runTriggers: Boolean(values.run),
    triggerOpts: { cli: values.cli || null, model: values.model || null, maxCostUsd: values['max-cost-usd'] != null ? Number(values['max-cost-usd']) : null } };
  if (values.run && !values.host) throw usageError('--run needs --host claude|copilot|codex (it runs the paid trigger set)');
  if (verb === 'migrate') {
    const kind = values.migrate;
    if (!kind || !MIGRATIONS[kind]) throw usageError(`--migrate must be one of ${Object.keys(MIGRATIONS).join(', ')}`);
    const state = openState(ctx, root);
    const srcRel = resolveArtifactRel(root, ctx.cwd, p);
    const sources = migrationSources(kind, root, root, absOf(root, srcRel));
    const srcTexts = Object.fromEntries(sources.map((s) => [s, readText(absOf(root, s), '')]));
    const before = [];
    for (const s of sources) before.push(await measureArtifact({ ctx, root, rel: s, state, ...common, runTriggers: false }));
    const baselineDirs = ctx.dryRun ? [] : before.map((m) => toPosix(relPosix(root, saveBaseline(root, state.dir, m.artifact, m)) ?? ''));
    const mig = await migrate(kind, { path: absOf(root, srcRel), root, cwd: root, host: values.to || null, dryRun: ctx.dryRun, force: Boolean(values.force), backupDir: backupDirFactory(ctx, root) });
    const report = { migration: kind, describe: mig.describe, sources: mig.sources, baselines: baselineDirs, written: mig.written, skipped: mig.skipped, backups: mig.backups,
      dropped_fields: mig.dropped_fields, manual_steps: mig.manual_steps, notes: mig.notes, dry_run: ctx.dryRun, results: [] };
    if (ctx.dryRun) return { ...report, verdict: 'unverified', reason: 'dry run: nothing was migrated, so nothing was measured' };
    const targets = [];
    for (const w of mig.written) {
      if (w.action.startsWith('would-')) continue;
      const c = classifyArtifact(w.path);
      if (!c || c.kind === 'skill-file') continue;
      const t = c.kind === 'skill' ? c.dir : w.path;
      if (!targets.includes(t)) targets.push(t);
    }
    for (const [k, t] of targets.entries()) {
      const srcMeasure = before[Math.min(k, before.length - 1)] || null;
      const after = await measureArtifact({ ctx, root, rel: t, state, ...common, runTriggers: false });
      const errs = after.lint.status === 'ok' ? after.lint.errors : [];
      const equivalence = migrationEquivalence(kind, root, srcTexts, t);
      const failing = [];
      if (errs.length) failing.push(`lint: ${errs.length} error(s) in the migrated artifact`);
      if (!equivalence.equal) failing.push(`equivalence: ${equivalence.reason}`);
      const cmp = srcMeasure ? compareMeasurements(srcMeasure, after, { note: note || `migration ${kind}` }) : null;
      for (const k of ['trigger', 'outcome']) if (cmp && cmp.deltas[k].status === 'measured' && cmp.failing.some((f) => f.startsWith(k))) failing.push(...cmp.failing.filter((f) => f.startsWith(k)));
      const unverified = cmp ? cmp.unverified : [];
      report.results.push({ artifact: t, lint: { status: after.lint.status, errors: errs.length, warnings: after.lint.warnings.length },
        equivalence, deltas: cmp ? { tokens: cmp.deltas.tokens, trigger: cmp.deltas.trigger, outcome: cmp.deltas.outcome } : null,
        verdict: failing.length ? 'reject' : unverified.length || after.lint.status !== 'ok' ? 'unverified' : 'accept', failing,
        unverified: after.lint.status !== 'ok' ? [...unverified, `lint: ${after.lint.reason || after.lint.status}`] : unverified });
      saveBaseline(root, state.dir, t, after);
    }
    const verdicts = report.results.map((r) => r.verdict);
    report.verdict = !verdicts.length ? 'unverified' : verdicts.includes('reject') ? 'reject' : verdicts.includes('unverified') ? 'unverified' : 'accept';
    if (!verdicts.length) report.reason = mig.skipped.length ? 'targets exist and were not overwritten (use --force)' : 'nothing was written';
    appendMetrics(state.dir, { kind: 'tooling-migrate', migration: kind, sources: mig.sources, verdict: report.verdict });
    return report;
  }
  const rel = resolveArtifactRel(root, ctx.cwd, p);
  const state = openState(ctx, root);
  if (verb === 'baseline') {
    const m = await measureArtifact({ ctx, root, rel, state, ...common });
    const dir = saveBaseline(root, state.dir, rel, m);
    const { context, ...rest } = m;
    return { ...rest, baseline_dir: toPosix(relPosix(root, dir) ?? dir), context_lines: lineCount(context || ''),
      next_steps: [m.kind === 'skill' && m.trigger.status !== 'measured' ? `Measure triggering before the change (${PAID_NOTE}): tooling trigger-set ${rel} --host claude --run` : null,
        `Change the artifact (one intent per change; see references/tooling-practices.md), then run: tooling modify compare ${rel}`].filter(Boolean) };
  }
  const base = latestBaseline(state.dir, rel);
  if (!base || !base.doc) throw usageError(`no baseline for ${rel}; run: tooling modify baseline ${rel}`);
  base.doc.context = readText(path.join(base.dir, 'context.txt'), '');
  if (!common.triggerHost && base.doc.trigger?.host) common.triggerHost = base.doc.trigger.host;
  if (verb === 'restore') {
    const restored = [];
    for (const f of base.doc.files) {
      const from = path.join(base.dir, 'files', ...f.split('/'));
      if (!fs.existsSync(from)) continue;
      if (!ctx.dryRun) { ensureDir(path.dirname(absOf(root, f))); fs.copyFileSync(from, absOf(root, f)); }
      restored.push(f);
    }
    const now = fs.existsSync(absOf(root, rel)) ? artifactFiles(root, rel) : [];
    const extra = now.filter((f) => !base.doc.files.includes(f));
    return { artifact: rel, restored, dry_run: ctx.dryRun, baseline_dir: toPosix(relPosix(root, base.dir) ?? base.dir), not_in_baseline: extra,
      next_steps: extra.length ? [`These files were added after the baseline and were left in place: ${extra.join(', ')}`] : [] };
  }
  // compare
  const after = await measureArtifact({ ctx, root, rel, state, ...common });
  if (after.trigger?.status !== 'measured' && base.doc.trigger?.status === 'measured' && after.description_sha256 && after.description_sha256 === base.doc.description_sha256) {
    after.trigger = { ...base.doc.trigger, reused: 'name and description unchanged, so the baseline trigger score still applies' };
  }
  if (after.outcome?.status !== 'measured' && base.doc.outcome?.status === 'measured' && after.content_sha256 === base.doc.content_sha256) after.outcome = { ...base.doc.outcome, reused: 'content unchanged' };
  const cmp = compareMeasurements(base.doc, after, { note });
  const entry = changelogEntry(rel, cmp, note);
  const { context, ...afterRest } = after;
  const out = { artifact: rel, baseline_dir: toPosix(relPosix(root, base.dir) ?? base.dir), unchanged: after.content_sha256 === base.doc.content_sha256,
    before: summarizeMeasurement(base.doc), after: summarizeMeasurement(afterRest), deltas: cmp.deltas, verdict: cmp.verdict, failing: cmp.failing, unverified: cmp.unverified,
    changelog_entry: entry, recorded: null, restored: null };
  const file = path.join(path.dirname(base.dir), '..', `compare-${tsId()}.json`);
  writeJsonAtomic(path.resolve(file), out);
  appendMetrics(state.dir, { kind: 'tooling-modify', artifact: rel, verdict: cmp.verdict, tokens: cmp.deltas.tokens.per_host, trigger: cmp.deltas.trigger, outcome: cmp.deltas.outcome });
  if (values.accept) {
    if (cmp.verdict !== 'accept') {
      out.recorded = { refused: `verdict is ${cmp.verdict}: ${[...cmp.failing, ...cmp.unverified].join('; ')}` };
    } else if (!ctx.dryRun) {
      const clFile = path.join(root, 'CHANGELOG.md');
      writeFileAtomic(clFile, insertChangelog(readText(clFile, ''), entry));
      const cls = classifyArtifact(fs.statSync(absOf(root, rel)).isDirectory() ? `${rel}/SKILL.md` : rel);
      const version = bumpVersion(root, rel, cls, values.bump || 'patch');
      const fresh = await measureArtifact({ ctx, root, rel, state, ...common, runTriggers: false });
      if (fresh.trigger?.status !== 'measured' && after.trigger?.status === 'measured' && fresh.description_sha256 === after.description_sha256) fresh.trigger = after.trigger;
      if (fresh.outcome?.status !== 'measured' && after.outcome?.status === 'measured') fresh.outcome = after.outcome;
      const dir = saveBaseline(root, state.dir, rel, fresh);
      out.recorded = { changelog: 'CHANGELOG.md', version, baseline_dir: toPosix(relPosix(root, dir) ?? dir) };
    } else out.recorded = { dry_run: true };
  }
  if (values.restore && cmp.verdict === 'reject') {
    const restored = [];
    if (!ctx.dryRun) {
      for (const f of base.doc.files) {
        const from = path.join(base.dir, 'files', ...f.split('/'));
        if (fs.existsSync(from)) { ensureDir(path.dirname(absOf(root, f))); fs.copyFileSync(from, absOf(root, f)); restored.push(f); }
      }
    }
    out.restored = { files: restored, dry_run: ctx.dryRun };
  }
  return out;
}

function summarizeMeasurement(m) {
  return { content_sha256: m.content_sha256, measured_at: m.measured_at, lint: m.lint ? { status: m.lint.status, errors: m.lint.errors?.length ?? 0, warnings: m.lint.warnings?.length ?? 0 } : null,
    tokens: Object.fromEntries(HOSTS.map((h) => [h, m.cost?.per_host?.[h]?.always_on_tokens ?? 0])), trigger: m.trigger ? { status: m.trigger.status, score: m.trigger.suite_score ?? null, sd: m.trigger.sd ?? null } : null,
    outcome: m.outcome ? { status: m.outcome.status, score: m.outcome.score ?? null } : null, hosts: m.hosts };
}

const normBody = (t) => String(t || '').replace(/\r\n/g, '\n').replace(/^\s+|\s+$/g, '');

/** Proof that a migration kept the substance: bodies, servers or hook commands are equal. */
function migrationEquivalence(kind, root, srcTexts, target) {
  const tAbs = absOf(root, target);
  const [srcRel, srcText] = Object.entries(srcTexts)[0] || ['', ''];
  if (kind === 'vscode-mcp-to-mcp-json') {
    const src = parseMcpConfig(srcText, 'vscode', srcRel).servers;
    const dst = parseMcpConfig(readText(tAbs, ''), 'mcpServers', target).servers;
    const key = (s) => JSON.stringify([s.name, s.transport, s.command, s.args, s.url, Object.keys(s.env || {}).sort(), Object.keys(s.headers || {}).sort()]);
    const missing = src.filter((s) => !dst.some((d) => key(d) === key(s))).map((s) => s.name);
    return { equal: missing.length === 0, compared: 'servers (name, transport, command, args, url, env and header names)', reason: missing.length ? `servers missing or changed: ${missing.join(', ')}` : null };
  }
  if (kind === 'copilot-hooks-to-camel') {
    const src = parseHookConfig(srcText, 'copilot', srcRel).entries;
    const dst = parseHookConfig(readText(tAbs, ''), 'copilot', target).entries;
    const key = (e) => JSON.stringify([e.event, e.matcher || null, e.exec ? [e.exec.program, ...e.exec.args] : [e.posix, e.windows], e.timeout ?? 30]);
    const missing = src.filter((e) => !dst.some((d) => key(d) === key(e))).map((e) => e.event);
    return { equal: dst.length > 0 && missing.length === 0, compared: 'events, matchers, commands and timeouts after normalization', reason: missing.length ? `entries missing or changed: ${missing.join(', ')}` : dst.length ? null : 'no hook entries after migration' };
  }
  const srcBodies = Object.values(srcTexts).map((t) => normBody(readFrontmatter(t).body));
  const file = fs.existsSync(tAbs) && fs.statSync(tAbs).isDirectory() ? path.join(tAbs, 'SKILL.md') : tAbs;
  const body = normBody(readFrontmatter(readText(file, '')).body);
  const equal = srcBodies.some((b) => b === body);
  return { equal, compared: 'Markdown body', reason: equal ? null : 'the migrated body differs from the source body' };
}

const modifyCommand = defineCommand({
  name: 'tooling modify',
  usage: 'tooling modify baseline|compare|restore <path> [--note "why"] [--accept] [--bump patch|minor|major|none] [--restore] [--host h --run] [--outcome-results f] [--external] [--strict]\n       tooling modify <path> --migrate prompt-to-skill|chatmode-to-agent|claude-commands-to-skills|vscode-mcp-to-mcp-json|copilot-hooks-to-camel [--to host] [--force]',
  options: { note: { type: 'string' }, accept: { type: 'boolean' }, bump: { type: 'string' }, restore: { type: 'boolean' }, migrate: { type: 'string' },
    to: { type: 'string' }, host: { type: 'string' }, run: { type: 'boolean' }, cli: { type: 'string' }, model: { type: 'string' }, 'max-cost-usd': { type: 'string' },
    'outcome-results': { type: 'string' }, external: { type: 'boolean' }, strict: { type: 'boolean' }, force: { type: 'boolean' } },
  async run(ctx, values, positionals) {
    const verbs = ['baseline', 'compare', 'restore', 'migrate'];
    let verb = positionals[0];
    let p = positionals[1];
    if (!verbs.includes(verb)) { p = positionals[0]; verb = values.migrate ? 'migrate' : null; }
    if (!verb) throw usageError('tooling modify needs baseline|compare|restore <path>, or <path> --migrate <kind>');
    if (values.bump && !['patch', 'minor', 'major', 'none'].includes(values.bump)) throw usageError('--bump must be patch, minor, major or none');
    if (values.host && !HOSTS.includes(values.host)) throw usageError('--host must be claude, copilot or codex');
    const res = await modifyRun(ctx, verb, values, p);
    let exit = EXIT.OK;
    if (verb === 'compare' || verb === 'migrate') exit = res.verdict === 'reject' ? EXIT.FINDINGS : res.verdict === 'unverified' ? EXIT.UNVERIFIABLE : EXIT.OK;
    if (values.accept && res.recorded && res.recorded.refused) exit = EXIT.FINDINGS;
    const summary = verb === 'baseline' ? `baseline of ${res.artifact} stored in ${res.baseline_dir}`
      : verb === 'restore' ? `restored ${res.restored.length} file(s) of ${res.artifact}`
        : `${verb} ${res.artifact || res.migration}: ${res.verdict}${res.failing?.length ? ` (${res.failing.join('; ')})` : ''}`;
    return { result: res, exit, summary };
  },
});

// ---------------------------------------------------------------------------
// Plugins for the user's own projects (§11.7)

const AP_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
const AP_SCHEMAS = ['https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', 'https://agent-plugins.org/schemas/1.1.0/plugin.schema.json'];
const AP_MCP_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';
const AP_FIELDS = ['$schema', 'name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords', 'extensions'];
const CODEX_PLUGIN_FIELDS = ['name', 'version', 'description', 'keywords', 'skills', 'mcpServers', 'apps', 'hooks', 'interface', 'extensions', 'author', 'homepage', 'repository', 'license'];
const CLAUDE_RESERVED_NAMES = ['claude', 'anthropic', 'claude-code', 'claude-mods'];
const CLAUDE_RESERVED_PREFIXES = ['claude-', 'anthropic-', 'anthropics-', 'cc-plugin-'];

/** Problems with a plugin name for each manifest format: `{ errors[], warnings[] }`. */
export function pluginNameProblems(name) {
  const errors = [];
  const warnings = [];
  const n = String(name ?? '');
  if (!/^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/.test(n) || n.includes('--') || n.includes('..')) errors.push('Agent Plugins name: 1-64 of a-z 0-9 - ., alphanumeric at both ends, no -- or ..');
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(n)) errors.push('Claude Code plugin names are kebab-case (no dots)');
  if (CLAUDE_RESERVED_NAMES.includes(n) || CLAUDE_RESERVED_PREFIXES.some((p) => n.startsWith(p))) errors.push('reserved by Claude Code (claude-, anthropic-, anthropics-, cc-plugin- prefixes and the names claude, anthropic, claude-code, claude-mods)');
  else if (/(^|[^a-z])(claude|anthropic)([^a-z]|$)/.test(n)) warnings.push('Claude Code warns about claude or anthropic as a whole word in plugin names');
  return { errors, warnings };
}

function projectSkills(root) {
  const out = new Map();
  for (const base of [SKILL_DIRS.codex, SKILL_DIRS.copilot, SKILL_DIRS.claude, CODEX_ONLY_SKILLS_DIR]) {
    const abs = absOf(root, base);
    let names = [];
    try { names = fs.readdirSync(abs, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { continue; }
    for (const n of names) if (!out.has(n) && fs.existsSync(path.join(abs, n, 'SKILL.md'))) out.set(n, `${base}/${n}`);
  }
  return out;
}

function projectAgents(root) {
  const out = [];
  for (const [base, host, re] of [['.github/agents', 'copilot', /\.agent\.md$|\.md$/], ['.claude/agents', 'claude', /\.md$/]]) {
    let names = [];
    try { names = fs.readdirSync(absOf(root, base)).filter((n) => re.test(n)); } catch { continue; }
    for (const n of names) out.push({ rel: `${base}/${n}`, host });
  }
  return out;
}

const listOpt = (v) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : null);

/** `tooling plugin init`: package the project's own skills, agents, hooks and MCP servers. */
export async function pluginInit(ctx, values) {
  await loadFrontmatterLib();
  const root = rootOf(ctx);
  checkState(ctx, root);
  const hosts = parseHosts(values.for || 'all');
  const name = values.name || toSkillName(projectName(root).replace(/^@[^/]+\//, ''));
  const np = pluginNameProblems(name);
  if (np.errors.length) throw usageError(`plugin name "${name}": ${np.errors.join('; ')} (pass --name)`);
  const outAbs = values.out ? path.resolve(ctx.cwd, values.out) : absOf(root, `plugins/${name}`);
  if (outAbs === SKILL_DIR || outAbs.startsWith(SKILL_DIR + path.sep)) throw usageError('refusing to generate a plugin inside the companion skill (decision D10)');
  const outRel = relPosix(root, outAbs);
  if (outRel == null) throw usageError('--out must be inside the repository');
  const P = (p) => (outRel === '.' ? p : `${outRel}/${p}`);
  const description = values.description ? String(values.description) : `Agentic tooling for ${projectName(root)}: skills, agents, hooks and MCP servers packaged for ${hosts.join(', ')}.`;
  const owner = values.owner || gitTry(root, ['config', 'user.name']) || 'Your Team';
  const version = values.version || '0.1.0';
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) throw usageError('--version must be semantic (X.Y.Z)');
  const outputs = [];
  const manual = [];
  const dropped = [];
  const contents = [];
  // Copilot reads the root Agent Plugins manifest, and so does Codex (extras under
  // extensions["com.openai"]); Codex-only plugins use the legacy .codex-plugin manifest.
  const writesApManifest = hosts.includes('copilot');
  const writesCodexManifest = hosts.includes('codex') && !writesApManifest;
  // Skills
  const available = projectSkills(root);
  // By default Codex-only skills (.codex/skills, usually translated agents) join only a Codex plugin.
  const wanted = listOpt(values.skills) || [...available.entries()]
    .filter(([, rel]) => !rel.startsWith(`${CODEX_ONLY_SKILLS_DIR}/`) || hosts.every((h) => h === 'codex')).map(([n]) => n);
  for (const w of wanted) if (!available.has(w)) throw usageError(`--skills: no project skill named "${w}" (found: ${[...available.keys()].join(', ') || 'none'})`);
  const skillNames = [];
  const caseDirs = new Map();
  for (const sname of wanted) {
    const srcDir = absOf(root, available.get(sname));
    // The skill's own evals/ are development material: its plugin-eval cases move to the
    // plugin's evals/ (where claude plugin eval looks), the rest stays in the repository.
    for (const f of listFiles(srcDir, { ignore: new Set(['.git', 'node_modules', 'results', 'evals']), maxFiles: 2000 })) {
      outputs.push({ path: P(`skills/${sname}/${f}`), content: fs.readFileSync(path.join(srcDir, ...f.split('/'))), host: 'all', kind: 'skill' });
    }
    const evalFiles = fs.existsSync(path.join(srcDir, 'evals')) ? listFiles(path.join(srcDir, 'evals'), { ignore: new Set(['results']), maxFiles: 500 }) : [];
    const cases = [...new Set(evalFiles.filter((f) => /^[^/]+\/(prompt\.md|case\.yaml)$/.test(f)).map((f) => f.split('/')[0]))];
    if (cases.length) caseDirs.set(sname, { srcDir: path.join(srcDir, 'evals'), cases, files: evalFiles.filter((f) => cases.includes(f.split('/')[0])) });
    skillNames.push(sname);
    contents.push(`- Skill \`${sname}\` (from ${available.get(sname)})`);
  }
  if (!skillNames.length) {
    const sname = name;
    const dsc = 'Describe in one sentence what this skill does. Use when (the requests that should trigger it). Not for (near-miss tasks).';
    const fm = stringifyFrontmatter({ name: sname, description: dsc, metadata: { version: '0.1.0' } }).trimEnd();
    outputs.push(...renderSections('skill', null, { name: sname, description: dsc, summary: firstSentence(dsc), skill_dir: P(`skills/${sname}`) }, () => fm).map((o) => ({ ...o, host: 'all', kind: 'skill' })));
    skillNames.push(sname);
    contents.push(`- Skill \`${sname}\` (starter; replace the TODO text)`);
  }
  // `claude plugin eval` cases (Claude Code only; the other hosts have no plugin eval runner).
  if (hosts.includes('claude')) {
    for (const sname of skillNames) {
      const own = caseDirs.get(sname);
      if (own) for (const f of own.files) outputs.push({ path: P(`evals/${f}`), content: fs.readFileSync(path.join(own.srcDir, ...f.split('/'))), host: 'claude', kind: 'eval' });
      else outputs.push(...evalOutputs(P('evals'), sname, { triggerSet: false, skillCreator: false }).map((o) => ({ ...o, host: 'claude', kind: 'eval' })));
    }
  }
  // Agents
  const agentSel = listOpt(values.agents);
  const agents = projectAgents(root).filter((a) => !agentSel || agentSel.includes(path.posix.basename(a.rel).replace(/\.agent\.md$|\.md$/, '')));
  for (const a of agents) {
    const ir = parseAgent(readText(absOf(root, a.rel), ''), a.host, a.rel);
    if (hosts.includes('claude')) {
      const r = renderAgent(ir, 'claude', { file: a.rel, pluginScoped: true });
      outputs.push({ path: P(`agents/${path.posix.basename(r.path)}`), content: r.content, host: 'claude', kind: 'agent' });
      dropped.push(...r.dropped);
      manual.push(...r.manual);
    }
    if (hosts.includes('copilot')) {
      const r = renderAgent(ir, 'copilot', { file: a.rel });
      outputs.push({ path: P(`com.github.copilot/agents/${path.posix.basename(r.path)}`), content: r.content, host: 'copilot', kind: 'agent' });
      dropped.push(...r.dropped);
      manual.push(...r.manual);
    }
    if (hosts.includes('codex')) manual.push(`Codex plugins have no agents: port ${a.rel} to a skill first (tooling port ${a.rel} --to codex) and include it with --skills.`);
    contents.push(`- Agent \`${ir.name}\` (from ${a.rel})`);
  }
  // Hooks
  let hookFiles = { claude: null, copilot: null, codex: null };
  if (values['include-hooks']) {
    const entries = [];
    const sources = [];
    try { for (const n of fs.readdirSync(absOf(root, '.github/hooks')).filter((x) => x.endsWith('.json'))) sources.push([`.github/hooks/${n}`, 'copilot']); } catch {}
    for (const [rel, h] of [['.claude/settings.json', 'claude'], ['.codex/hooks.json', 'codex']]) if (exists(root, rel)) sources.push([rel, h]);
    for (const [rel, h] of sources) {
      try {
        const r = parseHookConfig(readText(absOf(root, rel), ''), h, rel);
        entries.push(...r.entries);
        dropped.push(...r.dropped);
      } catch (err) { manual.push(`${rel}: ${err.message}`); }
    }
    for (const e of entries) {
      if (!e.exec) { manual.push(`A ${e.event} hook uses a shell string; rewrite its file paths with \${PLUGIN_ROOT} (Copilot, Codex) or \${CLAUDE_PLUGIN_ROOT} (Claude Code).`); continue; }
      e.exec = { ...e.exec, args: e.exec.args.map((arg) => {
        const local = arg.replace(/^\$\{CLAUDE_PROJECT_DIR\}\//, '');
        if (/^[-$/~\\]/.test(local) || !/[/.]/.test(local) || !exists(root, local) || !fs.statSync(absOf(root, local)).isFile()) return arg;
        const dest = `hooks/scripts/${path.posix.basename(local)}`;
        outputs.push({ path: P(dest), content: fs.readFileSync(absOf(root, local)), host: 'all', kind: 'hooks' });
        return `\${PLUGIN_ROOT}/${dest}`;
      }) };
    }
    if (entries.length) {
      if (hosts.includes('claude')) {
        const r = renderHookConfig(entries, 'claude', { file: 'hooks/hooks.json', pluginRoot: true });
        outputs.push({ path: P('hooks/hooks.json'), content: JSON.stringify({ description: `${name} hooks`, hooks: r.doc.hooks }, null, 2) + '\n', host: 'claude', kind: 'hooks' });
        manual.push(...r.manual); dropped.push(...r.dropped);
        hookFiles.claude = 'hooks/hooks.json';
      }
      if (hosts.includes('copilot')) {
        const r = renderHookConfig(entries, 'copilot', { file: 'com.github.copilot/hooks/hooks.json', pluginRoot: true });
        outputs.push({ path: P('com.github.copilot/hooks/hooks.json'), content: JSON.stringify(r.doc, null, 2) + '\n', host: 'copilot', kind: 'hooks' });
        manual.push(...r.manual); dropped.push(...r.dropped);
        hookFiles.copilot = 'com.github.copilot/hooks/hooks.json';
      }
      if (hosts.includes('codex')) {
        const r = renderHookConfig(entries, 'codex', { file: 'hooks/codex.hooks.json', pluginRoot: true });
        outputs.push({ path: P('hooks/codex.hooks.json'), content: JSON.stringify(r.doc, null, 2) + '\n', host: 'codex', kind: 'hooks' });
        manual.push(...r.manual); dropped.push(...r.dropped);
        hookFiles.codex = 'hooks/codex.hooks.json';
        manual.push('Codex runs plugin hooks only after the user trusts them (/hooks).');
      }
      contents.push(`- Hooks: ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} (${[...new Set(entries.map((e) => e.event))].join(', ')})`);
    } else manual.push('--include-hooks: no command hooks found in .github/hooks, .claude/settings.json or .codex/hooks.json.');
  }
  // MCP
  let hasMcp = false;
  if (values['include-mcp']) {
    const servers = [];
    for (const [rel, dialect] of [['.mcp.json', 'mcpServers'], ['.github/mcp.json', 'mcpServers'], ['.vscode/mcp.json', 'vscode']]) {
      if (!exists(root, rel)) continue;
      const r = parseMcpConfig(readText(absOf(root, rel), ''), dialect, rel);
      for (const s of r.servers) if (!servers.some((x) => x.name === s.name)) servers.push(s);
      dropped.push(...r.dropped);
      manual.push(...r.manual);
    }
    if (servers.length) {
      hasMcp = true;
      if (writesApManifest) {
        const r = renderMcpConfig(servers, 'agent-plugins', { file: 'mcp.json' });
        outputs.push({ path: P('mcp.json'), content: JSON.stringify(r.doc, null, 2) + '\n', host: 'copilot,codex', kind: 'mcp' });
        dropped.push(...r.dropped); manual.push(...r.manual);
      }
      if (hosts.includes('claude') || writesCodexManifest) {
        const r = renderMcpConfig(servers, 'claude', { file: '.mcp.json' });
        outputs.push({ path: P('.mcp.json'), content: JSON.stringify(r.doc, null, 2) + '\n', host: 'claude', kind: 'mcp' });
        dropped.push(...r.dropped); manual.push(...r.manual);
      }
      contents.push(`- MCP servers: ${servers.map((s) => `\`${s.name}\``).join(', ')}`);
    } else manual.push('--include-mcp: no .mcp.json, .github/mcp.json or .vscode/mcp.json found.');
  }
  // Manifests
  const author = { name: owner };
  if (writesApManifest) {
    const ap = { $schema: AP_SCHEMA, name, version, description, author };
    if (values.license) ap.license = String(values.license);
    if (hosts.includes('codex') && hookFiles.codex) {
      ap.extensions = { 'com.openai': { hooks: `./${hookFiles.codex}` } };
      manual.push('Unverified: Codex reading plugin hooks from extensions["com.openai"].hooks in an Agent Plugins manifest (Appendix C); check with /plugins and /hooks in Codex.');
    }
    outputs.push({ path: P('plugin.json'), content: JSON.stringify(ap, null, 2) + '\n', host: 'copilot,codex', kind: 'plugin' });
  }
  if (hosts.includes('claude')) {
    const cm = { name, version, description, author };
    if (values.license) cm.license = String(values.license);
    outputs.push({ path: P('.claude-plugin/plugin.json'), content: JSON.stringify(cm, null, 2) + '\n', host: 'claude', kind: 'plugin' });
  }
  if (writesCodexManifest) {
    const cx = { name, version, description, skills: './skills' };
    if (hasMcp) cx.mcpServers = './.mcp.json';
    if (hookFiles.codex) cx.hooks = `./${hookFiles.codex}`;
    cx.interface = { displayName: name };
    const sd = shortDescription(description);
    if (sd) cx.interface.shortDescription = sd;
    outputs.push({ path: P('.codex-plugin/plugin.json'), content: JSON.stringify(cx, null, 2) + '\n', host: 'codex', kind: 'plugin' });
  }
  // Marketplace (the repository serves as its own marketplace)
  const mkt = values.marketplace || `${name}-marketplace`;
  const source = outRel === '.' ? './' : `./${outRel}`;
  const entry = { name, source, description, version };
  const mergeEntry = (cur) => {
    const c = cur.trim() ? JSON.parse(cur) : {};
    c.plugins = Array.isArray(c.plugins) ? c.plugins : [];
    const k = c.plugins.findIndex((p) => p && p.name === name);
    if (k >= 0) c.plugins[k] = { ...c.plugins[k], ...entry }; else c.plugins.push(entry);
    return JSON.stringify(c, null, 2) + '\n';
  };
  const marketplaces = [];
  // One marketplace file per repository: .claude-plugin/marketplace.json is read by all three hosts.
  if (hosts.includes('claude') || (hosts.includes('copilot') && hosts.includes('codex'))) {
    marketplaces.push('.claude-plugin/marketplace.json');
    outputs.push({ path: '.claude-plugin/marketplace.json', content: JSON.stringify({ name: mkt, description: `Plugins from ${projectName(root)}.`, owner: { name: owner }, plugins: [entry] }, null, 2) + '\n', merge: mergeEntry, host: 'claude,copilot,codex', kind: 'marketplace' });
  } else if (hosts.includes('copilot')) {
    marketplaces.push('.github/plugin/marketplace.json');
    outputs.push({ path: '.github/plugin/marketplace.json', content: JSON.stringify({ name: mkt, owner: { name: owner }, metadata: { description: `Plugins from ${projectName(root)}.` }, plugins: [entry] }, null, 2) + '\n', merge: mergeEntry, host: 'copilot', kind: 'marketplace' });
  } else {
    marketplaces.push('.agents/plugins/marketplace.json');
    outputs.push({ path: '.agents/plugins/marketplace.json', content: JSON.stringify({ name: mkt, interface: { displayName: mkt }, plugins: [{ name, source }] }, null, 2) + '\n', merge: mergeEntry, host: 'codex', kind: 'marketplace' });
  }
  const install = [];
  if (hosts.includes('copilot')) install.push(`- Copilot CLI: \`copilot plugin marketplace add OWNER/REPO\` then \`copilot plugin install ${name}@${mkt}\` (or \`copilot plugin install OWNER/REPO:${outRel === '.' ? '' : outRel}\`)`);
  if (hosts.includes('claude')) install.push(`- Claude Code: \`claude plugin marketplace add OWNER/REPO\` then \`claude plugin install ${name}@${mkt}\``);
  if (hosts.includes('codex')) install.push(`- Codex: \`codex plugin marketplace add OWNER/REPO\` then \`codex plugin add ${name}@${mkt}\``);
  const vars = { name, description, contents: contents.join('\n'), install: install.join('\n'), plugin_dir: outRel, version, date: today() };
  outputs.push(...renderSections('plugin', null, vars).map((o) => ({ ...o, path: P(o.path), host: 'all', kind: 'docs' })));
  if (np.warnings.length) manual.push(...np.warnings);
  const write = Boolean(values.write) && !ctx.dryRun;
  const applied = applyOutputs(outputs, { outRoot: root, dryRun: !write, force: Boolean(values.force), backupDir: backupDirFactory(ctx, root) });
  const planned = applied.written.map((w) => w.path);
  const next = [];
  if (!write) next.push(`Dry run: nothing was written. Re-run with --write to create ${planned.length} file(s).`);
  if (applied.skipped.length) next.push(`${applied.skipped.length} file(s) exist and were left alone; pass --force to merge or overwrite them.`);
  next.push(`Check it: tooling plugin check ${outRel}`, `Test it locally: tooling plugin test ${outRel}`, `Release it: tooling plugin release ${outRel} --version X.Y.Z`);
  return {
    kind: 'plugin', name, hosts, plugin_dir: outRel, marketplace: mkt, marketplaces, dry_run: !write,
    files: planned, written: applied.written, skipped: applied.skipped, backups: applied.backups,
    validators: [], local_test_commands: pluginTestCommands(outRel, name, mkt, skillNames[0], hosts), release_steps: releaseSteps(name, version, outRel),
    dropped_fields: dropped, manual_steps: [...new Set(manual)], next_steps: next,
  };
}

function readMaybe(file) {
  const text = readText(file);
  if (text == null) return { exists: false };
  try { return { exists: true, doc: JSON.parse(text) }; } catch (err) { return { exists: true, error: err.message }; }
}

function pluginFinding(findings, severity, file, rule, message) { findings.push({ severity, file, rule, message }); }

function checkHookCommandsForRoot(findings, rel, doc, host) {
  const hooks = doc?.hooks;
  if (!hooks || typeof hooks !== 'object') { pluginFinding(findings, 'error', rel, 'HOOKS_WRAPPER', 'plugin hook files need a top-level "hooks" object'); return; }
  const rootVar = host === 'claude' ? /\$\{CLAUDE_PLUGIN_ROOT\}/ : /\$\{?PLUGIN_ROOT\}?|\$env:PLUGIN_ROOT|%PLUGIN_ROOT%/;
  for (const [ev, list] of Object.entries(hooks)) {
    for (const item of Array.isArray(list) ? list : []) {
      for (const h of Array.isArray(item?.hooks) ? item.hooks : [item]) {
        const cmds = [h?.command, h?.bash, h?.powershell, h?.commandWindows, ...(Array.isArray(h?.args) ? h.args : [])].filter((x) => typeof x === 'string');
        const refs = cmds.some((c) => /[\w-]+\.(mjs|cjs|js|ts|py|sh|ps1)\b/.test(c));
        if (refs && !cmds.some((c) => rootVar.test(c))) pluginFinding(findings, 'warning', rel, 'PLUGIN_ROOT', `${ev}: the command references a script without ${host === 'claude' ? '${CLAUDE_PLUGIN_ROOT}' : '${PLUGIN_ROOT}'}; plugin installs live in a versioned directory`);
        if (cmds.some((c) => /\$\{?(CLAUDE_)?PLUGIN_ROOT\}?[^"'\s]*\s*(>|>>)/.test(c))) pluginFinding(findings, 'warning', rel, 'PLUGIN_DATA', `${ev}: writes under the plugin root; keep state in \${PLUGIN_DATA} / \${CLAUDE_PLUGIN_DATA}`);
        if (host === 'copilot' && h && 'command' in h && !('bash' in h)) pluginFinding(findings, 'warning', rel, 'COPILOT_COMMAND', `${ev}: Copilot copies "command" to both shells; use bash + powershell`);
        if (host === 'copilot' && h && ev === 'preToolUse' && !h.cwd) pluginFinding(findings, 'warning', rel, 'COPILOT_CWD', 'preToolUse: set "cwd": "${PLUGIN_ROOT}" (github/copilot-cli#2540)');
      }
    }
  }
}

const CLI_ENV = Object.freeze({ claude: 'ADC_CLAUDE_CLI', copilot: 'ADC_COPILOT_CLI', codex: 'ADC_CODEX_CLI' });

/** The host CLI for validators: `ADC_<HOST>_CLI` (an executable or a .mjs script), else PATH; null when absent. */
function hostCli(host) {
  try { return resolveCli(host, process.env[CLI_ENV[host]] || null); } catch { return null; }
}

/** Run a resolved host CLI; a Windows .cmd shim goes through cmd.exe (Node cannot spawn it directly). */
function runCli(cli, args, opts = {}) {
  if (cli.shell) return run('cmd.exe', ['/d', '/s', '/c', [cli.cmd, ...cli.prefix, ...args].map((a) => quoteArg(a)).join(' ')], opts);
  return run(cli.cmd, [...cli.prefix, ...args], opts);
}

/** The first JSON value in CLI output that may carry warning lines around it. */
function firstJson(text) {
  const s = String(text || '').trim();
  try { return JSON.parse(s); } catch {}
  const k = s.search(/^[[{]/m);
  if (k < 0) return null;
  try { return JSON.parse(s.slice(k)); } catch { return null; }
}

const tempDir = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `adc-${label}-`));
const realOrResolved = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const lastLine = (r) => truncate(String(r.stderr || r.stdout || r.error || '').trim().split(/\r?\n/).filter(Boolean).pop() || `exit ${r.exit}`, 200);

const MARKETPLACE_FILES = ['.agents/plugins/marketplace.json', '.claude-plugin/marketplace.json', '.github/plugin/marketplace.json', 'marketplace.json', '.plugin/marketplace.json'];
const CODEX_MARKETPLACE_FILES = ['.agents/plugins/marketplace.json', '.claude-plugin/marketplace.json'];

/** Marketplace manifests under `root` whose entries point at the plugin (by name or source path). */
function marketplacesFor(root, pdir, name) {
  const out = [];
  const target = realOrResolved(pdir);
  for (const f of MARKETPLACE_FILES) {
    const r = readMaybe(absOf(root, f));
    if (!r.doc || !Array.isArray(r.doc.plugins)) continue;
    const src = (p) => (typeof p.source === 'string' ? p.source : p.source?.source === 'local' ? p.source.path : null);
    const hit = r.doc.plugins.find((p) => p && (p.name === name || (src(p) && realOrResolved(path.resolve(root, src(p))) === target)));
    if (hit) out.push({ file: f, name: r.doc.name || null, entry: hit });
  }
  return out;
}

/**
 * Copilot CLI load check (free, no sign-in, nothing installed): `copilot --plugin-dir <dir> skill
 * list --json` with a throwaway COPILOT_HOME; every plugin skill must be listed with source "plugin".
 */
function copilotLoadCheck(cli, pdir, prel, skills) {
  const v = { name: 'copilot --plugin-dir skill list --json (load check)', cmd: `COPILOT_PLUGIN_DIR_ONLY=true copilot --plugin-dir ${prel} skill list --json`,
    ran: false, status: 'skipped', errors: [], warnings: [], loaded_skills: [] };
  if (!cli) { v.reason = 'copilot not on PATH (or set ADC_COPILOT_CLI)'; return v; }
  const home = tempDir('copilot-home');
  const cwd = tempDir('copilot-cwd');
  try {
    const r = runCli(cli, ['--plugin-dir', pdir, 'skill', 'list', '--json'], { cwd, timeoutMs: 90_000,
      env: { ...process.env, COPILOT_HOME: home, COPILOT_PLUGIN_DIR_ONLY: 'true', COPILOT_AUTO_UPDATE: 'false' } });
    v.ran = true;
    v.exit = r.exit;
    const rows = firstJson(r.stdout);
    if (!Array.isArray(rows)) { v.status = 'error'; v.reason = `no skill list in the output: ${lastLine(r)}`; return v; }
    const base = realOrResolved(pdir) + path.sep;
    v.loaded_skills = rows.filter((x) => x && x.source === 'plugin' && typeof x.path === 'string' && (realOrResolved(x.path) + path.sep).startsWith(base)).map((x) => String(x.name));
    const missing = skills.filter((s) => !v.loaded_skills.includes(s));
    if (!skills.length) { v.status = 'unknown'; v.reason = 'the plugin has no skills, so a skill listing cannot show that it loaded'; }
    else if (missing.length) { v.status = 'fail'; v.errors.push(`Copilot CLI did not load skill(s) ${missing.join(', ')} from the plugin`); }
    else v.status = 'pass';
  } finally {
    for (const d of [home, cwd]) fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 });
  }
  return v;
}

/**
 * Codex load check (free, no sign-in): with a throwaway CODEX_HOME, register the repository
 * marketplace, install the plugin and render the prompt input; every plugin skill must appear
 * as `<plugin>:<skill>`.
 */
function codexLoadCheck(cli, root, pdir, prel, name, skills) {
  const v = { name: 'codex plugin marketplace add + plugin add + debug prompt-input (load check)',
    cmd: `CODEX_HOME=<temp> codex plugin marketplace add . && codex plugin add ${name}@<marketplace> && codex debug prompt-input hello`,
    ran: false, status: 'skipped', errors: [], warnings: [], loaded_skills: [] };
  if (!cli) { v.reason = 'codex not on PATH (or set ADC_CODEX_CLI)'; return v; }
  const mkts = marketplacesFor(root, pdir, name).filter((m) => CODEX_MARKETPLACE_FILES.includes(m.file));
  if (!mkts.length) { v.reason = 'no .agents/plugins/marketplace.json or .claude-plugin/marketplace.json lists the plugin; Codex installs plugins from marketplaces'; return v; }
  const home = tempDir('codex-home');
  const cwd = tempDir('codex-cwd');
  const env = { ...process.env, CODEX_HOME: home };
  try {
    v.ran = true;
    const add = runCli(cli, ['plugin', 'marketplace', 'add', root], { cwd: root, env, timeoutMs: 90_000 });
    if (add.exit !== 0) { v.status = 'fail'; v.errors.push(`codex plugin marketplace add failed: ${lastLine(add)}`); return v; }
    const m = /marketplace `([^`]+)`/.exec(`${add.stdout}\n${add.stderr}`);
    const mkt = m ? m[1] : mkts[0].name;
    v.marketplace = mkt;
    const inst = runCli(cli, ['plugin', 'add', `${name}@${mkt}`], { cwd, env, timeoutMs: 90_000 });
    if (inst.exit !== 0) { v.status = 'fail'; v.errors.push(`codex plugin add ${name}@${mkt} failed: ${lastLine(inst)}`); return v; }
    const pi = runCli(cli, ['debug', 'prompt-input', 'hello'], { cwd, env, timeoutMs: 90_000 });
    v.exit = pi.exit;
    if (pi.exit !== 0) { v.status = 'error'; v.reason = `codex debug prompt-input failed: ${lastLine(pi)}`; return v; }
    v.loaded_skills = skills.filter((s) => pi.stdout.includes(`${name}:${s}`));
    const missing = skills.filter((s) => !v.loaded_skills.includes(s));
    if (!skills.length) { v.status = 'unknown'; v.reason = 'the plugin has no skills, so the prompt input cannot show that it loaded'; }
    else if (missing.length) { v.status = 'fail'; v.errors.push(`Codex installed the plugin but did not expose skill(s) ${missing.map((s) => `${name}:${s}`).join(', ')}`); }
    else v.status = 'pass';
  } finally {
    for (const d of [home, cwd]) fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 });
  }
  return v;
}

/** `tooling plugin check`: layout, manifests, name rules, collisions, lint and external validators. */
export async function pluginCheck(ctx, dirArg, { external = true } = {}) {
  await loadFrontmatterLib();
  const root = rootOf(ctx);
  checkState(ctx, root);
  const pdir = path.resolve(ctx.cwd, dirArg || '.');
  if (!fs.existsSync(pdir) || !fs.statSync(pdir).isDirectory()) throw usageError(`not a directory: ${toPosix(dirArg || '.')}`);
  const prel = relPosix(root, pdir) ?? toPosix(pdir);
  const findings = [];
  const F = (sev, file, rule, msg) => pluginFinding(findings, sev, file ? (prel === '.' ? file : `${prel}/${file}`) : prel, rule, msg);
  const files = listFiles(pdir, { ignore: new Set(['.git', 'node_modules', 'results']), maxFiles: 5000 });
  const ap = readMaybe(path.join(pdir, 'plugin.json'));
  const cl = readMaybe(path.join(pdir, '.claude-plugin', 'plugin.json'));
  const cx = readMaybe(path.join(pdir, '.codex-plugin', 'plugin.json'));
  const hostsDetected = [];
  if (!ap.exists && !cl.exists && !cx.exists) F('error', null, 'NO_MANIFEST', 'no plugin.json, .claude-plugin/plugin.json or .codex-plugin/plugin.json');
  const versions = [];
  const names = new Set();
  if (ap.exists) {
    hostsDetected.push('copilot', 'codex');
    if (ap.error) F('error', 'plugin.json', 'JSON', ap.error);
    else {
      const d = ap.doc;
      if (!AP_SCHEMAS.includes(d.$schema)) F('error', 'plugin.json', 'AP_SCHEMA', `$schema must be ${AP_SCHEMA} (Copilot rejects unsupported versions)`);
      for (const k of Object.keys(d)) if (!AP_FIELDS.includes(k)) F('warning', 'plugin.json', 'AP_FIELD', `unknown top-level field "${k}" (closed field set; clients report and ignore it)`);
      if (d.author && (typeof d.author !== 'object' || Object.keys(d.author).some((k) => !['name', 'email', 'url'].includes(k)))) F('error', 'plugin.json', 'AP_AUTHOR', 'author may contain only name, email and url strings');
      if (d.keywords && (!Array.isArray(d.keywords) || d.keywords.some((k) => typeof k !== 'string'))) F('error', 'plugin.json', 'AP_KEYWORDS', 'keywords must be an array of strings');
      if (d.extensions != null && (typeof d.extensions !== 'object' || Array.isArray(d.extensions))) F('warning', 'plugin.json', 'AP_EXTENSIONS', 'extensions must be an object keyed by reverse-domain namespaces');
      if (typeof d.name !== 'string' || !d.name) F('error', 'plugin.json', 'AP_NAME', 'name is required');
      else { names.add(d.name); for (const e of pluginNameProblems(d.name).errors.filter((x) => x.startsWith('Agent Plugins'))) F('error', 'plugin.json', 'AP_NAME', e); }
      if (d.version) versions.push({ file: 'plugin.json', version: d.version });
    }
    if (fs.existsSync(path.join(pdir, 'SKILL.md'))) F('warning', 'SKILL.md', 'AP_ROOT_SKILL', 'Agent Plugins never discovers a SKILL.md at the plugin root; move it to skills/<name>/');
    const mcp = readMaybe(path.join(pdir, 'mcp.json'));
    if (mcp.exists) {
      if (mcp.error) F('error', 'mcp.json', 'JSON', mcp.error);
      else {
        if (mcp.doc.$schema !== AP_MCP_SCHEMA) F('error', 'mcp.json', 'AP_MCP_SCHEMA', `$schema must be ${AP_MCP_SCHEMA} (same version as plugin.json)`);
        for (const k of Object.keys(mcp.doc)) if (!['$schema', 'mcpServers'].includes(k)) F('error', 'mcp.json', 'AP_MCP_FIELD', `unknown top-level field "${k}"`);
        for (const [n, s] of Object.entries(mcp.doc.mcpServers || {})) {
          const allowed = s?.type === 'stdio' ? ['type', 'command', 'args', 'env', 'cwd'] : ['streamable-http', 'sse'].includes(s?.type) ? ['type', 'url', 'headers'] : null;
          if (!allowed) { F('error', 'mcp.json', 'AP_MCP_TYPE', `${n}: type must be stdio, streamable-http or sse`); continue; }
          for (const k of Object.keys(s)) if (!allowed.includes(k)) F('error', 'mcp.json', 'AP_MCP_VARIANT', `${n}: "${k}" is not allowed for type ${s.type}`);
          if (s.type === 'stdio') {
            if (typeof s.command !== 'string' || /\s/.test(s.command) || /\$\{/.test(s.command) || (s.command.includes('/') && !s.command.startsWith('./'))) F('error', 'mcp.json', 'AP_MCP_COMMAND', `${n}: command must be one token, a bare name or ./relative, without placeholders`);
            if (s.env && ('PLUGIN_ROOT' in s.env || 'PLUGIN_DATA' in s.env)) F('error', 'mcp.json', 'AP_MCP_ENV', `${n}: env must not set PLUGIN_ROOT or PLUGIN_DATA`);
            if (s.cwd && !/^(\.\/|\$\{PLUGIN_ROOT\}|\$\{PLUGIN_DATA\})/.test(s.cwd)) F('error', 'mcp.json', 'AP_MCP_CWD', `${n}: cwd must start with ./, \${PLUGIN_ROOT} or \${PLUGIN_DATA}`);
          } else if (typeof s.url !== 'string' || (!/^https:\/\//i.test(s.url) && !/^http:\/\/(localhost|127\.|\[::1\])/i.test(s.url))) F('error', 'mcp.json', 'AP_MCP_URL', `${n}: url must be https (http only for loopback)`);
        }
      }
    }
  }
  const skillDirs = fs.existsSync(path.join(pdir, 'skills')) ? fs.readdirSync(path.join(pdir, 'skills'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : [];
  const pluginSkills = [];
  for (const d of skillDirs) {
    const f = path.join(pdir, 'skills', d, 'SKILL.md');
    if (!fs.existsSync(f)) { if (files.some((x) => x.startsWith(`skills/${d}/`) && x.endsWith('/SKILL.md'))) F('warning', `skills/${d}`, 'NESTED_SKILL', 'skills are discovered only as immediate subdirectories of skills/'); continue; }
    const fm = readFrontmatter(readText(f, ''));
    const n = String(fm.data.name ?? '');
    if (!fm.hasFrontmatter) F('error', `skills/${d}/SKILL.md`, 'SKILL_FRONTMATTER', 'frontmatter must open with --- on line 1');
    for (const e of fm.errors) F('error', `skills/${d}/SKILL.md`, 'SKILL_YAML', e);
    if (n !== d) F('error', `skills/${d}/SKILL.md`, 'SKILL_NAME_DIR', `name "${n}" must equal the directory name "${d}"`);
    for (const p of skillNameProblems(n)) F('error', `skills/${d}/SKILL.md`, 'SKILL_NAME', `name "${n}": ${p}`);
    if (n !== d) for (const p of skillNameProblems(d)) F('error', `skills/${d}`, 'SKILL_NAME', `directory "${d}": ${p}`);
    if (!fm.data.description) F('error', `skills/${d}/SKILL.md`, 'SKILL_DESCRIPTION', 'description is required');
    pluginSkills.push(n || d);
  }
  if (cl.exists) {
    hostsDetected.push('claude');
    if (cl.error) F('error', '.claude-plugin/plugin.json', 'JSON', cl.error);
    else {
      const d = cl.doc;
      if (typeof d.name !== 'string' || !d.name) F('error', '.claude-plugin/plugin.json', 'CLAUDE_NAME', 'name is required');
      else {
        names.add(d.name);
        const p = pluginNameProblems(d.name);
        for (const e of p.errors.filter((x) => !x.startsWith('Agent Plugins'))) F('error', '.claude-plugin/plugin.json', 'CLAUDE_NAME', e);
        for (const w of p.warnings) F('warning', '.claude-plugin/plugin.json', 'CLAUDE_NAME', w);
      }
      for (const k of ['skills', 'commands', 'agents', 'hooks', 'mcpServers', 'lspServers', 'outputStyles']) {
        const vals = Array.isArray(d[k]) ? d[k] : typeof d[k] === 'string' ? [d[k]] : [];
        for (const v of vals) if (typeof v === 'string' && !(v.startsWith('./') || (k === 'skills' && v === '.'))) F('error', '.claude-plugin/plugin.json', 'CLAUDE_PATH', `${k}: component paths must start with ./ (got "${v}")`);
      }
      if (!d.description) F('warning', '.claude-plugin/plugin.json', 'CLAUDE_META', 'description missing (claude plugin validate --strict fails on it)');
      if (d.version) versions.push({ file: '.claude-plugin/plugin.json', version: d.version });
    }
    const hk = readMaybe(path.join(pdir, 'hooks', 'hooks.json'));
    if (hk.exists) { if (hk.error) F('error', 'hooks/hooks.json', 'JSON', hk.error); else checkHookCommandsForRoot(findings, prel === '.' ? 'hooks/hooks.json' : `${prel}/hooks/hooks.json`, hk.doc, 'claude'); }
    if (fs.existsSync(path.join(pdir, 'CLAUDE.md'))) F('warning', 'CLAUDE.md', 'CLAUDE_ROOT_MD', 'a CLAUDE.md at the plugin root is not loaded; put instructions in a skill');
    for (const a of files.filter((f) => /^agents\/[^/]+\.md$/.test(f))) {
      const fm = readFrontmatter(readText(path.join(pdir, ...a.split('/')), ''));
      for (const k of ['hooks', 'mcpServers', 'permissionMode']) if (fm.data[k] != null) F('warning', a, 'PLUGIN_AGENT_FIELD', `plugin subagents ignore "${k}"`);
      if (!fm.data.name || !fm.data.description) F('error', a, 'CLAUDE_AGENT', 'subagents need name and description (files without them are skipped silently)');
    }
  }
  const cpHooks = readMaybe(path.join(pdir, 'com.github.copilot', 'hooks', 'hooks.json'));
  if (cpHooks.exists) {
    if (cpHooks.error) F('error', 'com.github.copilot/hooks/hooks.json', 'JSON', cpHooks.error);
    else {
      if (cpHooks.doc.version !== 1) F('warning', 'com.github.copilot/hooks/hooks.json', 'COPILOT_VERSION', 'set "version": 1');
      checkHookCommandsForRoot(findings, prel === '.' ? 'com.github.copilot/hooks/hooks.json' : `${prel}/com.github.copilot/hooks/hooks.json`, cpHooks.doc, 'copilot');
    }
  }
  if (cx.exists) {
    hostsDetected.push('codex');
    if (cx.error) F('error', '.codex-plugin/plugin.json', 'JSON', cx.error);
    else {
      for (const k of Object.keys(cx.doc)) {
        if (/_/.test(k)) F('error', '.codex-plugin/plugin.json', 'CODEX_CAMEL', `"${k}": .codex-plugin fields are camelCase (e.g. mcpServers)`);
        else if (!CODEX_PLUGIN_FIELDS.includes(k)) F('warning', '.codex-plugin/plugin.json', 'CODEX_FIELD', `unknown field "${k}"`);
      }
      if (cx.doc.name) names.add(cx.doc.name);
      if (cx.doc.version) versions.push({ file: '.codex-plugin/plugin.json', version: cx.doc.version });
      if (typeof cx.doc.hooks === 'string') {
        const h = readMaybe(path.join(pdir, cx.doc.hooks));
        if (!h.exists) F('error', '.codex-plugin/plugin.json', 'CODEX_HOOKS', `hooks file ${cx.doc.hooks} not found`);
        else if (h.doc) checkHookCommandsForRoot(findings, `${prel}/${cx.doc.hooks.replace(/^\.\//, '')}`, h.doc, 'codex');
      }
    }
  }
  if (names.size > 1) F('error', null, 'NAME_MISMATCH', `manifests disagree on the plugin name: ${[...names].join(', ')}`);
  if (new Set(versions.map((v) => v.version)).size > 1) F('error', null, 'VERSION_MISMATCH', `manifest versions differ: ${versions.map((v) => `${v.file} ${v.version}`).join(', ')}`);
  const project = projectSkills(root);
  for (const s of pluginSkills) {
    const shadow = project.get(s);
    if (shadow && !path.resolve(root, shadow).startsWith(pdir)) F('warning', `skills/${s}`, 'SKILL_SHADOWED', `the project skill ${shadow} has the same name; project and personal skills silently shadow plugin skills`);
  }
  for (const f of files.filter((x) => /(^|\/)evals\/.+\/prompt\.md$/.test(x))) {
    if (/\bTODO\b/.test(readText(path.join(pdir, ...f.split('/')), ''))) F('warning', f, 'EVAL_TODO', 'eval case still contains TODO text');
  }
  // Lint (tooling-lint.mjs) and external validators.
  const lint = await lintArtifact(root, [pdir], {});
  for (const e of lint.errors) pluginFinding(findings, 'error', e.file, e.rule || 'LINT', `${e.host}: ${e.message}`);
  for (const w of lint.warnings) pluginFinding(findings, 'warning', w.file, w.rule || 'LINT', `${w.host}: ${w.message}`);
  const validators = [{ name: 'tooling lint', ran: lint.status === 'ok', status: lint.status, errors: lint.errors.length, warnings: lint.warnings.length, reason: lint.reason || null }];
  const claudeCli = external ? hostCli('claude') : null;
  const targets = [];
  if (cl.exists) targets.push(pdir);
  const mktFile = path.join(root, '.claude-plugin', 'marketplace.json');
  if (fs.existsSync(mktFile) && path.resolve(root) !== pdir) targets.push(root);
  for (const t of external ? targets : []) {
    const cmd = ['plugin', 'validate', '--strict', '--json', t];
    const v = { name: 'claude plugin validate --strict --json', cmd: `claude ${cmd.slice(0, -1).join(' ')} ${toPosix(relPosix(root, t) ?? t)}`, ran: false, status: 'skipped', errors: [], warnings: [] };
    if (!claudeCli) { v.reason = 'claude not on PATH'; validators.push(v); continue; }
    const r = runCli(claudeCli, cmd, { timeoutMs: 60_000 });
    v.ran = true;
    v.exit = r.exit;
    let doc = null;
    try { doc = JSON.parse(r.stdout); } catch {}
    if (doc) {
      const collect = (part, key) => (part?.[key] || []).map((x) => `${toPosix(path.relative(root, part.file || t))}: ${x.path ? `${x.path}: ` : ''}${x.message || x}`);
      v.errors = [...collect(doc.manifest, 'errors'), ...(doc.contents || []).flatMap((c) => collect(c, 'errors'))];
      v.warnings = [...collect(doc.manifest, 'warnings'), ...(doc.contents || []).flatMap((c) => collect(c, 'warnings'))];
      // A directory without a manifest validates "nothing" (contents: []): not a pass.
      v.status = !doc.manifest && !(doc.contents || []).length ? 'not-applicable' : doc.success ? 'pass' : 'fail';
    } else v.status = r.exit === 0 ? 'pass' : 'error';
    for (const e of v.errors) pluginFinding(findings, 'error', toPosix(relPosix(root, t) ?? t), 'CLAUDE_VALIDATE', e);
    for (const w of v.warnings) pluginFinding(findings, 'error', toPosix(relPosix(root, t) ?? t), 'CLAUDE_VALIDATE', `${w} (fails --strict)`);
    validators.push(v);
  }
  if (claudeCli && cl.exists && files.some((x) => /^evals\/.+\/prompt\.md$/.test(x))) {
    const args = ['plugin', 'eval', pdir, '--case', '__adc_load_check__', '--trust-plugin', '--no-publish', '--max-cost-usd', '0.01'];
    const r = runCli(claudeCli, args, { timeoutMs: 60_000 });
    const text = `${r.stdout}\n${r.stderr}`;
    const failedLoad = /failed to load/i.test(text);
    const v = { name: 'claude plugin eval (load check, runs no case)', cmd: `claude plugin eval ${prel} --case __adc_load_check__ --trust-plugin --no-publish`, ran: true, exit: r.exit,
      status: failedLoad ? 'fail' : /No eval cases found matching/i.test(text) ? 'pass' : 'unknown', errors: failedLoad ? text.split(/\r?\n/).filter((l) => /^✗|unknown frontmatter|failed/i.test(l)).slice(0, 10) : [], warnings: [] };
    for (const e of v.errors) pluginFinding(findings, 'error', prel, 'EVAL_LOAD', e);
    validators.push(v);
  } else if (external && !claudeCli && cl.exists) validators.push({ name: 'claude plugin eval (load check)', ran: false, status: 'skipped', reason: 'claude not on PATH', errors: [], warnings: [] });
  const pname = [...names][0] || path.basename(pdir);
  if (!external) validators.push({ name: 'host load checks', ran: false, status: 'skipped', reason: 'not requested (tooling plugin check runs them; tooling plugin test runs them with --run)', errors: [], warnings: [] });
  if (external && (ap.exists || cl.exists)) {
    const v = copilotLoadCheck(hostCli('copilot'), pdir, prel, pluginSkills);
    for (const e of v.errors) pluginFinding(findings, 'error', prel, 'COPILOT_LOAD', e);
    validators.push(v);
  }
  if (external && (ap.exists || cx.exists || cl.exists)) {
    const v = codexLoadCheck(hostCli('codex'), root, pdir, prel, pname, pluginSkills);
    for (const e of v.errors) pluginFinding(findings, 'error', prel, 'CODEX_LOAD', e);
    validators.push(v);
  }
  const name = pname;
  const mktName = ['.claude-plugin/marketplace.json', '.agents/plugins/marketplace.json', '.github/plugin/marketplace.json'].map((f) => readMaybe(absOf(root, f)).doc?.name).find(Boolean) || null;
  if (lint.status === 'ok' && lint.warnings.some((w) => /COLLISION/.test(String(w.rule)))) {
    for (let k = findings.length - 1; k >= 0; k--) if (findings[k].rule === 'SKILL_SHADOWED') findings.splice(k, 1);
  }
  return {
    plugin_dir: prel, name, hosts: [...new Set(hostsDetected)], files, skills: pluginSkills, findings, validators,
    errors: findings.filter((f) => f.severity === 'error').length, warnings: findings.filter((f) => f.severity === 'warning').length,
    local_test_commands: pluginTestCommands(prel, name, mktName, pluginSkills[0], [...new Set(hostsDetected)]),
    release_steps: releaseSteps(name, versions[0]?.version || '0.1.0', prel),
  };
}

/**
 * The same command for bash, PowerShell and cmd. `steps` run in order and stop at the first
 * failure; `env` is set for the steps only in bash and for the session in PowerShell and cmd.
 */
function shellVariants(env, ...steps) {
  const [k, v] = env ? Object.entries(env)[0] : [null, null];
  return {
    bash: (k ? `${k}=${v} ` : '') + steps.join(' && '),
    powershell: (k ? `$env:${k}='${v}'; ` : '') + steps.reduce((acc, st) => (acc ? `${acc}; if ($LASTEXITCODE -eq 0) { ${st} }` : st), ''),
    cmd: (k ? `set ${k}=${v}&& ` : '') + steps.join(' && '),
  };
}

function pluginTestCommands(prel, name, mkt, skill, hosts) {
  const dir = prel === '.' ? '.' : prel;
  const market = mkt || `${name}-marketplace`;
  const ask = `Use the ${skill || name} skill on this repository and say which skill you used.`;
  const out = [];
  if (hosts.includes('claude')) {
    out.push({ host: 'claude', purpose: 'validate manifests and components', cost: 'free', side_effects: 'none', argv: ['claude', 'plugin', 'validate', '--strict', '--json', dir], ...shellVariants(null, `claude plugin validate --strict --json ${quoteArg(dir)}`) });
    out.push({ host: 'claude', purpose: 'load the plugin for one headless prompt', cost: 'paid', side_effects: 'none', ...shellVariants(null, `claude --plugin-dir ${dir} -p "${ask}" --output-format json`) });
    out.push({ host: 'claude', purpose: 'outcome evals (with/without the plugin), pinned model and a cost cap', cost: 'paid', side_effects: 'writes evals/results/', ...shellVariants(null, `claude plugin eval ${dir} --trust-plugin --json --threshold 0.8 --max-cost-usd 10 --model <pinned-model> --no-publish`) });
    out.push({ host: 'claude', purpose: 'always-on token cost after installing from the marketplace', cost: 'free', side_effects: 'none', ...shellVariants(null, `claude plugin details ${name}`) });
  }
  if (hosts.includes('copilot')) {
    out.push({ host: 'copilot', purpose: 'list the skills Copilot CLI loads from the plugin (no sign-in needed)', cost: 'free', side_effects: 'none', ...shellVariants({ COPILOT_PLUGIN_DIR_ONLY: 'true' }, `copilot --plugin-dir ${dir} skill list --json`) });
    out.push({ host: 'copilot', purpose: 'load only this plugin for one headless prompt', cost: 'paid', side_effects: 'none', ...shellVariants({ COPILOT_PLUGIN_DIR_ONLY: 'true' }, `copilot --plugin-dir ${dir} -p "${ask}" --output-format json --no-ask-user`) });
    out.push({ host: 'copilot', purpose: 'register the repository marketplace and install from it (direct path installs are deprecated); marketplace plugins from a local directory load live', cost: 'free', side_effects: 'writes ~/.copilot (marketplace, installed plugin)', ...shellVariants(null, 'copilot plugin marketplace add .', `copilot plugin install ${name}@${market}`, 'copilot plugin list --json') });
    out.push({ host: 'copilot', purpose: 'see loaded hooks and skills in an interactive session', cost: 'free', side_effects: 'none', ...shellVariants(null, '/env') });
  }
  if (hosts.includes('codex')) {
    out.push({ host: 'codex', purpose: 'register the repository marketplace and install the plugin', cost: 'free', side_effects: 'writes ~/.codex/config.toml and the plugin cache', ...shellVariants(null, 'codex plugin marketplace add .', `codex plugin add ${name}@${market}`) });
    out.push({ host: 'codex', purpose: 'show that the plugin skills reach the model (no sign-in needed)', cost: 'free', side_effects: 'none', ...shellVariants(null, 'codex debug prompt-input "hello"') });
    out.push({ host: 'codex', purpose: 'check it loaded (interactive)', cost: 'free', side_effects: 'none', ...shellVariants(null, '/plugins') });
  }
  return out;
}

function releaseSteps(name, version, prel) {
  return [
    `Bump the version in every manifest and marketplace entry: tooling plugin release ${prel} --version ${bumpSemver(version, 'patch') || 'X.Y.Z'} --write`,
    `Add a CHANGELOG.md entry for ${version} in ${prel}/CHANGELOG.md.`,
    `Commit, then tag: git tag -a v${version} -m "${name} ${version}"; for Claude Code also run claude plugin tag ${prel} --push (creates ${name}--v${version} after checking plugin.json against the marketplace entry).`,
    `Push the tags: git push origin v${version}`,
    'Pin consumers: marketplace entries in other repositories use { "source": "github", "repo": "OWNER/REPO", "ref": "v<version>", "sha": "<40-character commit>" }.',
    'Publish SHA256SUMS (written by tooling plugin release --write) with the GitHub release.',
    'Copilot: repository-level autoUpdate is ignored; users run copilot plugin update <name>, or enable autoUpdate in user or managed settings.',
    'Claude Code: a pinned manifest version blocks updates until it changes; bump it on every release (or omit it so commits drive updates). Renamed plugins need a marketplace "renames" entry.',
    'Codex: users refresh with codex plugin marketplace upgrade.',
    'Enterprise: admins allow the marketplace with extraKnownMarketplaces + enabledPlugins (Copilot .github/copilot/settings.json or managed settings; Claude managed settings, strictKnownMarketplaces must include it; Codex requirements.toml marketplaces.allowed_sources).',
  ];
}

/** `tooling plugin release`: version consistency, tags, pinned SHA, SHA256SUMS. */
export async function pluginRelease(ctx, dirArg, values) {
  const root = rootOf(ctx);
  checkState(ctx, root);
  const pdir = path.resolve(ctx.cwd, dirArg || '.');
  if (!fs.existsSync(pdir)) throw usageError(`not a directory: ${toPosix(dirArg || '.')}`);
  const prel = relPosix(root, pdir) ?? toPosix(pdir);
  const manifests = [];
  for (const f of ['plugin.json', '.claude-plugin/plugin.json', '.codex-plugin/plugin.json']) {
    const r = readMaybe(path.join(pdir, ...f.split('/')));
    if (r.exists) manifests.push({ file: prel === '.' ? f : `${prel}/${f}`, abs: path.join(pdir, ...f.split('/')), doc: r.doc || null, error: r.error || null });
  }
  if (!manifests.length) throw usageError(`${prel} has no plugin manifest`);
  const name = manifests.find((m) => m.doc?.name)?.doc.name || path.basename(pdir);
  const current = [...new Set(manifests.map((m) => m.doc?.version).filter(Boolean))];
  const version = values.version || current[0] || null;
  if (!version) throw usageError('no version in the manifests; pass --version X.Y.Z');
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) throw usageError('--version must be semantic (X.Y.Z)');
  const source = prel === '.' ? './' : `./${prel}`;
  const marketplaces = [];
  for (const f of ['.claude-plugin/marketplace.json', '.github/plugin/marketplace.json', '.agents/plugins/marketplace.json', 'marketplace.json', '.plugin/marketplace.json']) {
    const r = readMaybe(absOf(root, f));
    if (!r.exists || !r.doc) continue;
    const entries = (r.doc.plugins || []).filter((p) => p && (p.name === name || p.source === source || p.source?.path === source));
    if (entries.length) marketplaces.push({ file: f, abs: absOf(root, f), doc: r.doc, entries });
  }
  const write = Boolean(values.write) && !ctx.dryRun;
  const dirty = (gitTry(root, ['status', '--porcelain', '--', prel === '.' ? '.' : prel]) || '').trim().length > 0;
  const updated = [];
  if (values.version) {
    for (const m of manifests) {
      if (!m.doc || m.doc.version === version) continue;
      updated.push({ file: m.file, from: m.doc.version ?? null, to: version });
      if (write) { m.doc.version = version; writeJsonAtomic(m.abs, m.doc); }
    }
    for (const mk of marketplaces) {
      let changed = false;
      for (const e of mk.entries) if ('version' in e && e.version !== version) { updated.push({ file: mk.file, entry: e.name, from: e.version, to: version }); e.version = version; changed = true; }
      if (changed && write) writeJsonAtomic(mk.abs, mk.doc);
    }
  }
  const head = gitTry(root, ['rev-parse', 'HEAD']);
  const tagList = (gitTry(root, ['tag', '-l', `v${version}`, `${name}--v${version}`]) || '').split(/\r?\n/).filter(Boolean);
  const remote = gitTry(root, ['config', '--get', 'remote.origin.url']) || '';
  const gh = /github\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/.exec(remote);
  const files = listFiles(pdir, { ignore: new Set(['.git', 'node_modules', 'results']), maxFiles: 5000 }).filter((f) => f !== 'SHA256SUMS');
  const sums = files.map((f) => `${sha256(fs.readFileSync(path.join(pdir, ...f.split('/'))))}  ${f}`).join('\n') + '\n';
  let sumsPath = null;
  if (write) {
    const state = openState(ctx, root);
    const file = path.join(statePaths(state.dir).tooling, 'releases', `${name}-${version}`, 'SHA256SUMS');
    writeFileAtomic(file, sums);
    sumsPath = toPosix(relPosix(root, file) ?? file);
  }
  const warnings = [];
  if (current.length > 1) warnings.push(`manifest versions differ: ${current.join(', ')}`);
  if (dirty) warnings.push('the plugin directory had uncommitted changes before this run; commit before tagging');
  if (updated.length && write) warnings.push('versions were updated: commit the manifests before tagging');
  if (tagList.length) warnings.push(`tags already exist: ${tagList.join(', ')}`);
  if (!head) warnings.push('not a git repository with commits: no SHA to pin');
  return {
    plugin_dir: prel, name, version, current_versions: current, updated, dry_run: !write,
    tags: [{ host: 'copilot,codex', name: `v${version}`, cmd: `git tag -a v${version} -m "${name} ${version}"` }, { host: 'claude', name: `${name}--v${version}`, cmd: `claude plugin tag ${prel} --push` }],
    pin: head ? { source: 'github', repo: gh ? `${gh[1]}/${gh[2]}` : 'OWNER/REPO', ref: `v${version}`, sha: head, ...(prel === '.' ? {} : { path: prel }) } : null,
    marketplaces: marketplaces.map((m) => ({ file: m.file, entries: m.entries.map((e) => e.name) })),
    sha256sums: { files: files.length, path: sumsPath, preview: sums.split('\n').slice(0, 5) },
    warnings, release_steps: releaseSteps(name, version, prel),
  };
}

/** `tooling plugin test`: the local test commands; `--run` executes the free, side-effect-free ones. */
export async function pluginTest(ctx, dirArg, values) {
  // The free, side-effect-free checks (claude plugin validate, the Copilot and Codex load checks
  // in throwaway homes) are the external validators of `check`; --run executes them.
  const check = await pluginCheck(ctx, dirArg, { external: Boolean(values.run) });
  const ran = check.validators.filter((v) => v.ran && v.name !== 'tooling lint')
    .map((v) => ({ name: v.name, cmd: v.cmd || null, status: v.status, exit: v.exit ?? null, errors: v.errors || [], loaded_skills: v.loaded_skills, reason: v.reason || null }));
  const skipped = check.validators.filter((v) => !v.ran && v.name !== 'tooling lint').map((v) => ({ name: v.name, status: v.status, reason: v.reason || null }));
  return { plugin_dir: check.plugin_dir, name: check.name, hosts: check.hosts, local_test_commands: check.local_test_commands, ran, skipped,
    check: { errors: check.errors, warnings: check.warnings },
    next_steps: [values.run ? null : 'Re-run with --run to execute the free load checks (claude plugin validate, Copilot and Codex in throwaway homes).',
      'Paid commands are listed, never run by this script; run them yourself with a cost cap.',
      'Commands with side effects change user configuration; run them on a test machine or account.'].filter(Boolean) };
}

const pluginCommand = defineCommand({
  name: 'tooling plugin',
  usage: 'tooling plugin init [--for copilot|claude|codex|all] [--name n] [--out dir] [--skills a,b] [--agents a,b] [--include-hooks] [--include-mcp] [--marketplace m] [--owner o] [--version v] [--write] [--force]\n       tooling plugin check [dir] | test [dir] [--run] | release [dir] [--version X.Y.Z] [--write]',
  options: { ...TOOLING_SCAFFOLD_OPTIONS, run: { type: 'boolean' } },
  async run(ctx, values, positionals) {
    const verb = positionals[0];
    if (!['init', 'check', 'test', 'release'].includes(verb)) throw usageError('tooling plugin needs init, check, test or release');
    if (verb === 'init') {
      const res = await pluginInit(ctx, values);
      return { result: res, exit: EXIT.OK, summary: `plugin ${res.name} for ${res.hosts.join(', ')}: ${res.files.length} file(s) ${res.dry_run ? 'planned (dry run)' : 'written'}` };
    }
    if (verb === 'check') {
      const res = await pluginCheck(ctx, positionals[1]);
      return { result: res, exit: res.errors ? EXIT.FINDINGS : EXIT.OK, summary: `plugin ${res.name}: ${res.errors} error(s), ${res.warnings} warning(s); validators ${res.validators.filter((v) => v.ran).map((v) => `${v.name}=${v.status}`).join(', ') || 'none ran'}` };
    }
    if (verb === 'test') {
      const res = await pluginTest(ctx, positionals[1], values);
      return { result: res, exit: res.ran.some((r) => r.status === 'fail') ? EXIT.FINDINGS : EXIT.OK, summary: `${res.local_test_commands.length} local test command(s); ran ${res.ran.length}` };
    }
    const res = await pluginRelease(ctx, positionals[1], values);
    return { result: res, exit: EXIT.OK, summary: `plugin ${res.name} ${res.version}: ${res.updated.length} version update(s) ${res.dry_run ? 'planned' : 'written'}; ${res.warnings.length} warning(s)` };
  },
});

// ---------------------------------------------------------------------------
// The group

async function lintSub(argv) {
  let mod = null;
  try { mod = await import('./tooling-lint.mjs'); } catch { mod = null; }
  if (!mod || typeof mod.lintCommand !== 'function') throw envError('NOT_AVAILABLE', 'tooling lint is not available in this build (scripts/lib/tooling-lint.mjs is missing)');
  return mod.lintCommand(argv);
}

const TOOLING_USAGE = [
  'tooling <subcommand> [options]',
  '  lint [paths] [--host all|copilot|claude|codex] [--strict]     host-rule validation (tooling-lint)',
  '  cost [paths] [--host h] [--context-tokens n] [--max-tokens n] context cost per file and host',
  '  port <path> --to copilot|claude|codex|all [--out dir] [--force]  translate between hosts',
  '  trigger-set [skill] [--init] [--host h --run] [--runs 3]      trigger eval set (runs are paid)',
  '  modify baseline|compare|restore <path> | <path> --migrate k  safe-change loop and migrations',
  '  plugin init|check|test|release [dir]                          plugins for your own projects',
  '  scaffold <instructions|skill|agent|prompt|hooks|mcp|plugin> [--for h] [--write]',
].join('\n');

export const toolingCommand = defineGroup({
  name: 'tooling',
  usage: TOOLING_USAGE,
  subcommands: { lint: lintSub, cost: costCommand, port: portCommand, 'trigger-set': triggerSetCommand, modify: modifyCommand, plugin: pluginCommand, scaffold: scaffoldCommand },
});

