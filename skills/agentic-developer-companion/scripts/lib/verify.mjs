// verify (plan §9.1): one working-tree snapshot, every scripted step through a dynamic import of
// its module (a missing module or export, or a thrown step, becomes an `unverified` check and never
// a crash), one evidence ledger, the derived verdict, and per-host next steps for the parts only
// the model can do (traceability matrix, adversarial review, claims).

import fs from 'node:fs';
import path from 'node:path';
import {
  EXIT, AdcError, usageError, defineCommand, toPosix, relPosix, truncate, readText, ADC_SCRIPT,
  writeFileAtomic, writeJsonAtomic,
} from './core.mjs';
import { gitRaw, requireRepo, resolveBase } from './git.mjs';
import { prepareStateDir, appendMetrics, snapshotExcludes } from './state.mjs';
import {
  initLedger, addChecks, setClaims, finalizeLedger, deriveVerdict, checkRows, verdictExit, readLedgerFile,
  renderMarkdown, markdownPath, artifactsDir, detectTool, metricsFor, resolveSession, allocateLedgerPath,
  prepareQaTarget, createQaSnapshot, TOOLS, CHECK_FM,
} from './evidence.mjs';
import { readSpecInput, specPaths, renderTraceMarkdown } from './trace.mjs';

const DIFF_SCOPE_IDS = ['CK-SCOPE', 'CK-TEST-DEL', 'CK-SKIP', 'CK-ASSERT', 'CK-TEST-CFG', 'CK-SUPPRESS', 'CK-CI', 'CK-SWALLOW', 'CK-SECRETS'];

/**
 * The scripted steps, in order. Each entry names the module (relative to this file) and export to
 * import, the check ids it must produce, and how to call it with the shared state `s`.
 * `needsDetect` steps are not called when detection failed; `when` false records them `skipped`.
 */
export const DEFAULT_STEPS = Object.freeze([
  { name: 'detect', step: '1', module: './detect.mjs', export: 'detect', ids: [], kind: 'detect',
    call: (fn, s) => fn({ root: s.target.root, stateInfo: s.target.state, refresh: s.opts.refresh }) },
  { name: 'diff-scope', step: '2-8', module: './diff-scope.mjs', export: 'diffScope', ids: DIFF_SCOPE_IDS,
    call: (fn, s) => fn({ target: s.target, detectResult: s.detectResult, specPaths: s.specPaths, allow: s.opts.allow }) },
  { name: 'deps-check', step: '9', module: './deps.mjs', export: 'depsCheck', ids: ['CK-DEPS', 'CK-LOCK'],
    call: (fn, s) => fn({ target: s.target, offline: s.opts.offline }) },
  { name: 'typecheck', step: '10', module: './clean-run.mjs', export: 'typecheck', ids: ['CK-TYPES'], needsDetect: true,
    call: (fn, s) => fn({ target: s.target, detectResult: s.detectResult, strict: false, runner: s.opts.runner }) },
  { name: 'clean-run', step: '11', module: './clean-run.mjs', export: 'cleanRun', ids: ['CK-CLEANRUN'], needsDetect: true,
    call: (fn, s) => fn({
      target: s.target, detectResult: s.detectResult, noInstall: s.opts.noInstall, runner: s.opts.runner,
      allProjects: s.opts.allProjects, baseCountsFile: s.opts.baseCounts, noBase: s.opts.noBase, keep: s.opts.keep,
    }) },
  { name: 'coverage-delta', step: '12', module: './probes.mjs', export: 'coverageDelta', ids: ['CK-COVERAGE'], needsDetect: true,
    when: (o) => !o.quick, skipReason: 'QUICK', skipSummary: 'skipped by --quick',
    call: (fn, s) => fn({ target: s.target, detectResult: s.detectResult, failUnder: s.opts.failUnder, report: null }) },
  { name: 'mutation-scope', step: '13', module: './probes.mjs', export: 'mutationScope', ids: ['CK-MUTATION'], needsDetect: true,
    when: (o) => o.deep, skipReason: 'NOT_REQUESTED', skipSummary: 'mutation testing runs with --deep',
    call: (fn, s) => fn({ target: s.target, detectResult: s.detectResult, budgetMin: s.opts.budgetMin }) },
  { name: 'flake-probe', step: '14', module: './probes.mjs', export: 'flakeProbe', ids: ['CK-FLAKE'], needsDetect: true,
    when: (o) => o.deep, skipReason: 'NOT_REQUESTED', skipSummary: 'the flake probe runs with --deep',
    call: (fn, s) => fn({ target: s.target, detectResult: s.detectResult, times: s.opts.times, tests: null }) },
  { name: 'trace', step: '15', module: './trace.mjs', export: 'trace', ids: ['CK-TRACE'], kind: 'trace',
    when: (o, s) => s.spec != null, skipReason: 'NO_SPEC', skipSummary: 'no --spec given',
    call: (fn, s) => fn({ target: s.target, specText: s.spec.text, specPath: s.spec.ref }) },
]);

function placeholder(id, status, reason, summary, step) {
  return {
    id, fm: [...(CHECK_FM[id] || [])], project: '.', status, reason, cost: 0, command: null, cwd: null, exit_code: null,
    duration_ms: null, summary: truncate(summary, 600), output_sha256: null, artifacts: [], findings: [], data: { step: step.name },
  };
}

const moduleUrl = (spec) => (/^file:/.test(spec) ? spec : new URL(spec, import.meta.url).href);

async function loadStepFn(step) {
  let mod;
  try {
    mod = await import(moduleUrl(step.module));
  } catch (err) {
    return { fn: null, detail: `${step.module} could not be loaded (${err.code || truncate(err.message, 200)})` };
  }
  if (typeof mod[step.export] !== 'function') return { fn: null, detail: `${step.module} has no export "${step.export}"` };
  return { fn: mod[step.export], detail: null };
}

/** Run one step; never throws. Returns { checks, log }. */
async function runStep(step, s) {
  const started = Date.now();
  const log = { name: step.name, step: step.step, module: toPosix(step.module), export: step.export };
  const degrade = (reason, summary, status = 'unverified') => {
    log.status = status === 'skipped' ? 'skipped' : 'degraded';
    log.reason = reason;
    log.ms = Date.now() - started;
    return { checks: step.ids.map((id) => placeholder(id, status, reason, summary, step)), log };
  };
  if (step.when && !step.when(s.opts, s)) return degrade(step.skipReason || 'NOT_REQUESTED', step.skipSummary || 'not requested', 'skipped');
  if (step.needsDetect && !s.detectOk) return degrade('DETECT_UNAVAILABLE', `not run: project detection failed (${s.detectError || 'unknown'})`);
  const { fn, detail } = await loadStepFn(step);
  if (!fn) {
    if (step.kind === 'detect') s.detectError = `MODULE_UNAVAILABLE: ${detail}`;
    return degrade('MODULE_UNAVAILABLE', `${step.name}: ${detail}`);
  }
  let res;
  try {
    res = await step.call(fn, s);
  } catch (err) {
    const code = err instanceof AdcError ? err.code : 'STEP_ERROR';
    if (step.kind === 'detect') s.detectError = `${code}: ${truncate(err.message, 200)}`;
    return degrade(code, `${step.name} failed: ${truncate(err && err.message ? err.message : String(err), 400)}`);
  }
  if (step.kind === 'detect') {
    log.ms = Date.now() - started;
    if (!res || typeof res !== 'object' || !Array.isArray(res.projects)) {
      s.detectError = 'detect returned no projects[]';
      log.status = 'degraded';
      log.reason = 'BAD_RESULT';
      return { checks: [], log };
    }
    s.detectResult = res;
    s.detectOk = true;
    log.status = 'ran';
    log.summary = truncate(String(res.summary || `${res.projects.length} project(s)`), 300);
    return { checks: [], log };
  }
  const raw = res && Array.isArray(res.checks) ? res.checks : null;
  if (!raw) return degrade('NO_CHECKS_RETURNED', `${step.name} returned no checks[]`);
  const checks = raw.filter((c) => c && typeof c === 'object' && typeof c.id === 'string');
  const present = new Set(checks.map((c) => c.id.toUpperCase()));
  for (const id of step.ids) {
    if (!present.has(id)) checks.push(placeholder(id, 'unverified', 'NOT_REPORTED', `${step.name} returned no ${id} entry`, step));
  }
  const ms = Date.now() - started;
  for (const c of checks) if (c.duration_ms == null) c.duration_ms = ms;
  if (step.after) {
    try {
      step.after(res, checks, s);
    } catch (err) {
      return degrade('STEP_ERROR', `${step.name}: could not store its artifacts (${truncate(err.message, 200)})`);
    }
  }
  log.status = 'ran';
  log.ms = ms;
  log.checks = checks.length;
  return { checks, log };
}

// The trace skeleton is stored twice: trace.json is the hashed reference, trace-matrix.json is the
// copy the model fills in (editing a hashed artifact would make finalize refuse the ledger).
function storeTrace(res, checks, s) {
  const dir = artifactsDir(s.ledgerFile);
  const { checks: _ignored, ...skeleton } = res;
  const doc = { ...skeleton, ledger: s.ledgerRef };
  const json = path.join(dir, 'trace.json');
  const work = path.join(dir, 'trace-matrix.json');
  const md = path.join(dir, 'trace.md');
  writeJsonAtomic(json, doc);
  writeJsonAtomic(work, doc);
  writeFileAtomic(md, renderTraceMarkdown(doc));
  const ref = (f) => relPosix(s.target.root, f) || toPosix(f);
  for (const c of checks) if (c.id === 'CK-TRACE') c.artifacts = [ref(json), ref(md)];
  s.traceMatrix = ref(work);
}

function porcelain(root) {
  const res = gitRaw(root, ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all']);
  return res.exit === 0 ? res.stdout : null;
}

const REVIEW_DISPATCH = {
  'claude-code': 'Claude Code: run the review in a fresh subagent with read-only tools (Read, Grep, Glob; isolation: worktree when available) and the references/review.md template; `/code-review` is a useful second opinion, not a replacement.',
  'copilot-cli': 'Copilot CLI: run `/review` with the references/review.md checklist, or a custom read-only agent; `/rubber-duck` adds a second model.',
  vscode: 'VS Code: start a new chat with a read-only custom agent and the references/review.md template (a different model than the implementer when possible).',
  'copilot-cloud': 'Copilot cloud agent: request Copilot code review on the pull request (`.github/skills/code-review` can carry the checklist); record CK-REVIEW later from a session that can run the template.',
  codex: 'Codex: run `codex review --uncommitted` for working-tree changes (`codex review --base <branch>` for committed ones) with the references/review.md checklist as the prompt.',
  unknown: 'Open a new conversation (fresh context), paste the references/review.md template with the diff, the spec and this ledger, and use a different model than the implementer when possible.',
};

function nextSteps({ derived, ledger, tool, ledgerRef, matrixRef, scratchDir, finalized, finalizeError, porcelainChanged }) {
  const adc = `node "${toPosix(ADC_SCRIPT)}"`;
  const L = `--ledger "${ledgerRef}"`;
  const out = [];
  if (porcelainChanged) out.push('WARNING: `git status --porcelain` changed while verify ran, so a step touched the working tree. Inspect `git status`, restore what changed, and report it.');
  if (finalizeError) out.push(`Finalize refused (${finalizeError.code}): ${finalizeError.message}`);
  const reasonHelp = {
    NO_RUNNER: 'ask the user for the test command, then re-run verify with `--runner "<command>"` (headless: leave it UNVERIFIED)',
    SHALLOW: 'run `git fetch --unshallow` (CI: checkout with fetch-depth 0) and re-run verify',
    PATH_TOO_LONG: 'run `git config --global core.longpaths true` and re-run verify',
    MODULE_UNAVAILABLE: 'this installation lacks the step module; run the manual fallback for that step from references/verify.md and record its output with `evidence add`',
    DETECT_UNAVAILABLE: 'fix project detection (`detect --json` shows why) or run the manual fallback from references/verify.md',
  };
  const groups = new Map();
  for (const r of derived.effective) {
    if (r.effective !== 'unverified' || r.entries.some((e) => e.pending)) continue;
    const key = `${r.reason}\u0000${r.summary}`;
    if (!groups.has(key)) groups.set(key, { reason: r.reason, summary: r.summary, ids: [] });
    groups.get(key).ids.push(`${r.id}${r.project !== '.' ? ` (${r.project})` : ''}`);
  }
  for (const g of groups.values()) {
    out.push(`${g.ids.join(', ')} could not be verified [${g.reason || 'no reason'}]: ${truncate(g.summary, 200)}. Next: ${reasonHelp[g.reason] || 'fix the cause and re-run verify (UNVERIFIED is resolved by running the step, never by argument)'}.`);
  }
  const pending = new Set(derived.effective.filter((r) => r.entries.some((e) => e.pending)).map((r) => r.id));
  if (pending.has('CK-TRACE') && matrixRef) {
    out.push(`Traceability: fill ${matrixRef} (for each requirement set status and cite implementation in evidence[] and tests in tests[] as path:line; map extras[] hunks with "requirement"), then run: ${adc} evidence add "${matrixRef}" ${L}`);
  }
  if (pending.has('CK-REVIEW')) {
    out.push(`Adversarial review (fresh context, read-only, correctness and spec gaps only). ${REVIEW_DISPATCH[tool] || REVIEW_DISPATCH.unknown} Record the yes/no/unknown answers with file:line citations (write them to ${scratchDir}/review-answers.json or pipe them with -; a scratch file inside the working tree makes the ledger stale): ${adc} evidence score "${scratchDir}/review-answers.json" ${L} --add. Confirm a critical finding with a reproducing command: ${adc} evidence add --check CK-REVIEW --repro "<command>" ${L}`);
  }
  if (!ledger.claims.length && !finalized) out.push(`Claims: record what the implementer claimed (their summary or last message) so each claim is mapped to evidence: ${adc} evidence claims <file|-> ${L}`);
  const waivable = derived.effective.filter((r) => ['CK-TEST-DEL', 'CK-SKIP', 'CK-ASSERT', 'CK-TEST-CFG', 'CK-SUPPRESS', 'CK-CI', 'CK-SCOPE', 'CK-TRACE'].includes(r.id) && (r.effective === 'fail' || r.effective === 'finding'));
  if (waivable.length && !finalized && ledger.spec) {
    out.push(`Only where the spec explicitly asks for it (${waivable.map((r) => r.id).join(', ')}): ${adc} evidence waive <CK-ID> --file <path> --reason "spec: '<exact quote>'" ${L}. Never waive on the implementer's word; a waiver caps the verdict at PASS-WITH-FINDINGS.`);
  }
  if (!finalized) out.push(`When the model steps are recorded: ${adc} evidence finalize ${L} (exit 1 on FAIL, 4 on UNVERIFIED).`);
  out.push(`Post the summary (verdict, check table, commands to reproduce): ${adc} evidence render --short ${L}`);
  return out;
}

function parsePositive(value, name, { integer = false } = {}) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || (integer && !Number.isInteger(n))) throw usageError(`--${name} must be a positive ${integer ? 'integer' : 'number'}`);
  return n;
}

function readArg(arg, cwd) {
  if (arg === '-') {
    try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
  }
  const file = path.resolve(cwd, arg);
  const text = readText(file);
  if (text == null) throw usageError(`--claims file not found: ${toPosix(file)}`);
  return text;
}

function options(values) {
  if (values.quick && values.deep) throw usageError('--quick and --deep are mutually exclusive');
  if (values.spec === '-' && values.claims === '-') throw usageError('only one of --spec and --claims can read stdin');
  if (values.tool && !TOOLS.includes(String(values.tool).toLowerCase())) throw usageError(`--tool must be one of ${TOOLS.join(', ')}`);
  return {
    quick: Boolean(values.quick), deep: Boolean(values.deep), finalize: Boolean(values.finalize),
    allow: Array.isArray(values.allow) ? values.allow : values.allow ? [values.allow] : [],
    offline: Boolean(values.offline) || Object.keys(process.env).some((k) => k.startsWith('CODEX_SANDBOX') && process.env[k]),
    noInstall: Boolean(values['no-install']), runner: values.runner || null, allProjects: Boolean(values['all-projects']),
    baseCounts: values['base-counts'] || null, noBase: Boolean(values['no-base']), keep: Boolean(values.keep),
    failUnder: parsePositive(values['fail-under'], 'fail-under'), budgetMin: parsePositive(values.budget, 'budget'),
    times: parsePositive(values.times, 'times', { integer: true }), refresh: Boolean(values.refresh),
    tool: values.tool ? String(values.tool).toLowerCase() : null,
  };
}

async function dryRunPlan(ctx, values, opts, steps, spec) {
  const root = requireRepo(ctx.cwd);
  const state = prepareStateDir({ ...ctx, cwd: root }, { create: false });
  const base = resolveBase(root, values.base || null);
  const s = { opts, spec, detectOk: true };
  const plan = [];
  for (const step of steps) {
    const { fn, detail } = await loadStepFn(step);
    const wanted = !step.when || step.when(opts, s);
    plan.push({ name: step.name, step: step.step, module: toPosix(step.module), export: step.export, ids: step.ids, available: Boolean(fn), ...(detail ? { detail } : {}), would_run: wanted && Boolean(fn), ...(wanted ? {} : { skip_reason: step.skipReason }) });
  }
  return {
    result: { dry_run: true, base, state_dir: toPosix(state.dir), steps: plan, ledger: null, next_steps: ['Run without --dry-run to execute the steps and write the ledger.'] },
    exit: EXIT.OK, summary: `dry run: ${plan.filter((p) => p.would_run).length}/${plan.length} steps would run`,
  };
}

/** The verify orchestrator; `steps` is injectable for tests. Returns { result, exit, summary }. */
export async function runVerify(ctx, values = {}, { steps = DEFAULT_STEPS } = {}) {
  const started = Date.now();
  const opts = options(values);
  const root = requireRepo(ctx.cwd);
  const spec = values.spec ? readSpecInput(values.spec, { cwd: ctx.cwd, root }) : null;
  const claimsText = values.claims ? readArg(values.claims, ctx.cwd) : null;
  if (ctx.dryRun) return dryRunPlan(ctx, values, opts, steps, spec);

  const target = await prepareQaTarget(ctx, { base: values.base || null });
  const before = porcelain(target.root);
  const tool = opts.tool || detectTool();
  const session = resolveSession(target.state, values.session || null);
  const ledgerFile = allocateLedgerPath(target.state, target.snapshot.tree);
  const ledgerRef = relPosix(target.root, ledgerFile) || toPosix(ledgerFile);
  const s = {
    ctx, values, opts, target, spec, specPaths: spec ? specPaths(spec.text) : null, detectResult: null, detectOk: false,
    detectError: null, ledgerFile, ledgerRef, traceMatrix: null,
  };
  const checks = [];
  const stepLog = [];
  for (const step0 of steps) {
    const step = step0.kind === 'trace' && !step0.after ? { ...step0, after: storeTrace } : step0;
    const { checks: got, log } = await runStep(step, s);
    checks.push(...got);
    stepLog.push(log);
  }
  checks.push({
    ...placeholder('CK-REVIEW', 'unverified', 'AWAITING_REVIEW', 'adversarial review not recorded yet (see next_steps)', { name: 'review' }),
    pending: true, data: { step: 'review', dispatch: REVIEW_DISPATCH[tool] || REVIEW_DISPATCH.unknown },
  });

  const projects = s.detectResult && Array.isArray(s.detectResult.projects) ? s.detectResult.projects : [];
  const globs = projects.flatMap((p) => (p && Array.isArray(p.test_globs) ? p.test_globs : []));
  const summaryText = s.detectResult ? (s.detectResult.summary || projects.map((p) => p.root).join(', ')) : null;
  await initLedger({
    target, tool, spec: spec ? spec.ref : null, specText: spec ? spec.text : null, sessionId: session, mode: 'verify', file: ledgerFile,
    options: { quick: opts.quick, deep: opts.deep, allow: opts.allow, offline: opts.offline, runner: opts.runner, no_install: opts.noInstall, all_projects: opts.allProjects },
    projectsSummary: summaryText, effectiveTestGlobs: globs, steps: stepLog,
  });
  await addChecks(ledgerFile, checks, { source: 'verify', root: target.root });
  if (claimsText != null && claimsText.trim()) await setClaims(ledgerFile, claimsText);

  let finalizeError = null;
  if (opts.finalize) {
    try {
      // The CLI's staleness rule (§7.5): finalize compares against a freshly computed snapshot.
      const fresh = { ...target, snapshot: createQaSnapshot(target.root, { exclude: snapshotExcludes(target.state) }) };
      await finalizeLedger(ledgerFile, { target: fresh });
    } catch (err) {
      if (!(err instanceof AdcError)) throw err;
      finalizeError = { code: err.code, message: err.message };
    }
  }
  const after = porcelain(target.root);
  const porcelainChanged = before != null && after != null && before !== after;
  const ledger = readLedgerFile(ledgerFile);
  const derived = deriveVerdict(ledger);
  const durationMs = Date.now() - started;
  try { appendMetrics(target.state.dir, metricsFor(ledger, { duration_ms: durationMs, finalized: Boolean(ledger.finalized_at) })); } catch {}

  const rows = checkRows(derived).map((r) => ({
    id: r.id, project: r.project, status: r.effective, ...(r.status !== r.effective ? { recorded_status: r.status } : {}),
    ...(r.reason ? { reason: r.reason } : {}), summary: r.summary, ...(r.notes ? { notes: r.notes } : {}),
  }));
  const abs = (ref) => (ref ? toPosix(path.resolve(target.root, ref)) : ref);
  const next = nextSteps({
    derived, ledger, tool, ledgerRef: abs(ledgerRef), matrixRef: abs(s.traceMatrix), scratchDir: toPosix(artifactsDir(ledgerFile)),
    finalized: Boolean(ledger.finalized_at), finalizeError, porcelainChanged,
  });
  const result = {
    ledger: ledgerRef, markdown: relPosix(target.root, markdownPath(ledgerFile)) || toPosix(markdownPath(ledgerFile)),
    verdict: derived.verdict, finalized: Boolean(ledger.finalized_at), needs_human_triage: derived.needs_human_triage,
    tree_digest: target.snapshot.tree, base: target.base, tool, session_id: session.id, session_source: session.source,
    checks: rows, claims: derived.claims.map(({ seq, ...c }) => c), reasons: derived.reasons, next_steps: next,
    trace_matrix: s.traceMatrix, steps: stepLog, worktree_unchanged: !porcelainChanged, duration_ms: durationMs,
    ...(finalizeError ? { finalize_error: finalizeError } : {}),
    summary_markdown: renderMarkdown(ledger, { short: true }),
  };
  const count = (st) => rows.filter((r) => r.status === st).length;
  const summary = `${derived.verdict}${ledger.finalized_at ? '' : ' (provisional)'}: ${count('pass')} pass, ${count('fail')} fail, `
    + `${count('finding')} finding, ${count('unverified')} unverified, ${count('skipped')} skipped; ledger ${ledgerRef}`;
  return { result, exit: finalizeError ? EXIT.UNVERIFIABLE : verdictExit(derived.verdict), summary };
}

export const verifyCommand = defineCommand({
  name: 'verify',
  usage: [
    'verify [--base <ref>] [--spec <file|-|url>] [--claims <file|->] [--quick|--deep] [--finalize] [--allow <glob>]...',
    '       [--session <id>] [--tool <host>] [--offline] [--no-install] [--runner "<cmd>"] [--all-projects]',
    '       [--base-counts <file>] [--no-base] [--keep] [--fail-under <pct>] [--budget <min>] [--times <n>] [--refresh]',
    '',
    'One working-tree snapshot; steps 1-14 (detect, diff-scope, deps-check, typecheck, clean-run,',
    'coverage-delta, and with --deep mutation-scope + flake-probe); with --spec a traceability skeleton',
    '(CK-TRACE stays unverified until the completed matrix is recorded); CK-REVIEW is left for the model.',
    '--quick also skips coverage-delta. --finalize seals the ledger now (headless runs).',
    'Exit 0 PASS / PASS-WITH-FINDINGS, 1 FAIL, 4 UNVERIFIED.',
  ].join('\n'),
  options: {
    base: { type: 'string' }, spec: { type: 'string' }, claims: { type: 'string' }, quick: { type: 'boolean' }, deep: { type: 'boolean' },
    finalize: { type: 'boolean' }, allow: { type: 'string', multiple: true }, session: { type: 'string' }, tool: { type: 'string' },
    offline: { type: 'boolean' }, 'no-install': { type: 'boolean' }, runner: { type: 'string' }, 'all-projects': { type: 'boolean' },
    'base-counts': { type: 'string' }, 'no-base': { type: 'boolean' }, keep: { type: 'boolean' }, 'fail-under': { type: 'string' },
    budget: { type: 'string' }, times: { type: 'string' }, refresh: { type: 'boolean' },
  },
  positionals: false,
  run: (ctx, values) => runVerify(ctx, values),
});
