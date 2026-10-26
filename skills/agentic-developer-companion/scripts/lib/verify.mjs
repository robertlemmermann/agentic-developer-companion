// verify (plan §9.1): one working-tree snapshot, every scripted step through a dynamic import of
// its module (a missing module or export, or a thrown step, becomes an `unverified` check and never
// a crash), one evidence ledger, the derived verdict, and per-host next steps for the parts only
// the model can do (traceability matrix, adversarial review, claims).

import path from 'node:path';
import {
  EXIT, AdcError, usageError, defineCommand, toPosix, relPosix, truncate, ADC_SCRIPT, writeFileAtomic,
  writeJsonAtomic, ensureDir, makeCheck, numberOption, readInput, toArray,
} from './core.mjs';
import { requireRepo, resolveBase, createSnapshot, statusPorcelain } from './git.mjs';
import { prepareStateDir, prepareTarget, appendMetrics, snapshotExcludes } from './state.mjs';
import {
  initLedger, addChecks, setClaims, finalizeLedger, deriveVerdict, checkRows, verdictExit, readLedgerFile,
  renderMarkdown, markdownPath, artifactsDir, detectTool, checkTool, metricsFor, resolveSession, allocateLedgerPath,
  CHECK_FM,
} from './evidence.mjs';
import { readSpecInput, specPaths, renderTraceMarkdown } from './trace.mjs';

const DIFF_SCOPE_IDS = ['CK-SCOPE', 'CK-TEST-DEL', 'CK-SKIP', 'CK-ASSERT', 'CK-TEST-CFG', 'CK-SUPPRESS', 'CK-CI',
  'CK-SWALLOW', 'CK-SECRETS'];
// Checks a quoted spec may waive (evidence.mjs refuses the others).
const WAIVABLE = ['CK-TEST-DEL', 'CK-SKIP', 'CK-ASSERT', 'CK-TEST-CFG', 'CK-SUPPRESS', 'CK-CI', 'CK-SCOPE', 'CK-TRACE'];

// Options every worktree-based step shares: --no-install and --keep apply to all of them.
const wt = (s) => ({ target: s.target, detectResult: s.detectResult, noInstall: s.opts.noInstall, keep: s.opts.keep });

/**
 * The scripted steps, in order. Each entry names the module (relative to this file) and export to
 * import, the check ids it must produce, and how to call it with the shared state `s`. When
 * detection fails the steps still run with `detectResult: null` (each QA module then detects
 * itself, and a step that cannot is recorded `unverified`). A `when` that returns false records
 * the step's checks as `skipped`; `after(result, checks, s)` stores what the step produced.
 */
export const DEFAULT_STEPS = Object.freeze([
  { name: 'detect', step: '1', module: './detect.mjs', export: 'detect', ids: [], kind: 'detect',
    call: (fn, s) => fn({ root: s.target.root, stateInfo: s.target.state, refresh: s.opts.refresh }) },
  { name: 'diff-scope', step: '2-8', module: './diff-scope.mjs', export: 'diffScope', ids: DIFF_SCOPE_IDS,
    call: (fn, s) => fn({
      target: s.target, detectResult: s.detectResult, specPaths: s.specPaths, allow: s.opts.allow,
    }) },
  // `offline: null` lets deps-check apply its own default (Codex sandbox, ADC_OFFLINE).
  { name: 'deps-check', step: '9', module: './deps.mjs', export: 'depsCheck', ids: ['CK-DEPS', 'CK-LOCK'],
    call: (fn, s) => fn({ target: s.target, offline: s.opts.offline || null }) },
  { name: 'typecheck', step: '10', module: './clean-run.mjs', export: 'typecheck', ids: ['CK-TYPES'],
    call: (fn, s) => fn({ ...wt(s), strict: false, runner: s.opts.runner }) },
  { name: 'clean-run', step: '11', module: './clean-run.mjs', export: 'cleanRun', ids: ['CK-CLEANRUN'],
    call: (fn, s) => fn({
      ...wt(s), runner: s.opts.runner, allProjects: s.opts.allProjects, baseCountsFile: s.opts.baseCounts,
      noBase: s.opts.noBase,
      // §9.1.1: the skip-increase and shortfall rules depend on what diff-scope found; no waivers exist yet.
      firedChecks: s.fired(), waivers: [],
    }) },
  { name: 'coverage-delta', step: '12', module: './probes.mjs', export: 'coverageDelta', ids: ['CK-COVERAGE'],
    when: (o) => !o.quick, skipReason: 'QUICK', skipSummary: 'skipped by --quick',
    call: (fn, s) => fn({ ...wt(s), runner: s.opts.runner, failUnder: s.opts.failUnder, report: null }) },
  { name: 'mutation-scope', step: '13', module: './probes.mjs', export: 'mutationScope', ids: ['CK-MUTATION'],
    when: (o) => o.deep, skipReason: 'NOT_REQUESTED', skipSummary: 'mutation testing runs with --deep',
    call: (fn, s) => fn({ ...wt(s), budgetMin: s.opts.budgetMin }) },
  { name: 'flake-probe', step: '14', module: './probes.mjs', export: 'flakeProbe', ids: ['CK-FLAKE'],
    when: (o) => o.deep, skipReason: 'NOT_REQUESTED', skipSummary: 'the flake probe runs with --deep',
    call: (fn, s) => fn({ ...wt(s), runner: s.opts.runner, times: s.opts.times, tests: null }) },
  { name: 'trace', step: '15', module: './trace.mjs', export: 'trace', ids: ['CK-TRACE'],
    when: (o, s) => s.spec != null, skipReason: 'NO_SPEC', skipSummary: 'no --spec given',
    call: (fn, s) => fn({ target: s.target, specText: s.spec.text, specPath: s.spec.ref }), after: storeTrace },
]);

const placeholder = (id, status, reason, summary, step) => makeCheck({
  id, fm: [...(CHECK_FM[id] || [])], status, reason, summary: truncate(summary, 600), data: { step: step.name },
});

const moduleUrl = (spec) => (/^file:/.test(spec) ? spec : new URL(spec, import.meta.url).href);

async function loadStepFn(step) {
  let mod;
  try {
    mod = await import(moduleUrl(step.module));
  } catch (err) {
    return { fn: null, detail: `${step.module} could not be loaded (${err.code || truncate(err.message, 200)})` };
  }
  if (typeof mod[step.export] !== 'function') {
    return { fn: null, detail: `${step.module} has no export "${step.export}"` };
  }
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
  if (step.when && !step.when(s.opts, s)) {
    return degrade(step.skipReason || 'NOT_REQUESTED', step.skipSummary || 'not requested', 'skipped');
  }
  const { fn, detail } = await loadStepFn(step);
  if (!fn) return degrade('MODULE_UNAVAILABLE', `${step.name}: ${detail}`);
  let res;
  try {
    res = await step.call(fn, s);
  } catch (err) {
    const code = err instanceof AdcError ? err.code : 'STEP_ERROR';
    return degrade(code, `${step.name} failed: ${truncate(err && err.message ? err.message : String(err), 400)}`);
  }
  if (step.kind === 'detect') {
    log.ms = Date.now() - started;
    if (!Array.isArray(res?.projects)) {
      log.status = 'degraded';
      log.reason = 'BAD_RESULT';
      return { checks: [], log };
    }
    s.detectResult = res;
    log.status = 'ran';
    log.summary = truncate(String(res.summary || `${res.projects.length} project(s)`), 300);
    return { checks: [], log };
  }
  const raw = res && Array.isArray(res.checks) ? res.checks : null;
  if (!raw) return degrade('NO_CHECKS_RETURNED', `${step.name} returned no checks[]`);
  const checks = raw.filter((c) => c && typeof c === 'object' && typeof c.id === 'string');
  const present = new Set(checks.map((c) => c.id.toUpperCase()));
  for (const id of step.ids) {
    if (present.has(id)) continue;
    checks.push(placeholder(id, 'unverified', 'NOT_REPORTED', `${step.name} returned no ${id} entry`, step));
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

const REVIEW_DISPATCH = {
  'claude-code': 'Claude Code: run the review in a fresh subagent with read-only tools (Read, Grep, Glob; '
    + 'isolation: worktree when available) and the references/review.md template; `/code-review` is a useful '
    + 'second opinion, not a replacement.',
  'copilot-cli': 'Copilot CLI: run `/review` with the references/review.md checklist, or a custom read-only agent; '
    + '`/rubber-duck` adds a second model.',
  vscode: 'VS Code: start a new chat with a read-only custom agent and the references/review.md template (a different '
    + 'model than the implementer when possible).',
  'copilot-cloud': 'Copilot cloud agent: request Copilot code review on the pull request (`.github/skills/code-review` '
    + 'can carry the checklist); record CK-REVIEW later from a session that can run the template.',
  codex: 'Codex: run `codex review --uncommitted` for working-tree changes (`codex review --base <branch>` for '
    + 'committed ones) with the references/review.md checklist as the prompt.',
  unknown: 'Open a new conversation (fresh context), paste the references/review.md template with the diff, the spec '
    + 'and this ledger, and use a different model than the implementer when possible.',
};

const REASON_HELP = {
  NO_RUNNER: 'ask the user for the test command, then re-run verify with `--runner "<command>"` (headless: leave it '
    + 'UNVERIFIED)',
  SHALLOW: 'run `git fetch --unshallow` (CI: checkout with fetch-depth 0) and re-run verify',
  PATH_TOO_LONG: 'run `git config --global core.longpaths true` and re-run verify',
  MODULE_UNAVAILABLE: 'this installation lacks the step module; run the manual fallback for that step from '
    + 'references/verify.md and record its output with `evidence add`',
};

function nextSteps(
  { derived, ledger, tool, ledgerRef, matrixRef, scratchDir, finalized, finalizeError, porcelainChanged },
) {
  const adc = `node "${toPosix(ADC_SCRIPT)}"`;
  const L = `--ledger "${ledgerRef}"`;
  const out = [];
  if (porcelainChanged) {
    out.push('WARNING: `git status --porcelain` changed while verify ran, so a step touched the working tree. '
      + 'Inspect `git status`, restore what changed, and report it.');
  }
  if (finalizeError) out.push(`Finalize refused (${finalizeError.code}): ${finalizeError.message}`);
  const groups = new Map();
  for (const r of derived.effective) {
    if (r.effective !== 'unverified' || r.entries.some((e) => e.pending)) continue;
    const key = `${r.reason}\u0000${r.summary}`;
    if (!groups.has(key)) groups.set(key, { reason: r.reason, summary: r.summary, ids: [] });
    groups.get(key).ids.push(`${r.id}${r.project !== '.' ? ` (${r.project})` : ''}`);
  }
  for (const g of groups.values()) {
    const help = REASON_HELP[g.reason]
      || 'fix the cause and re-run verify (UNVERIFIED is resolved by running the step, never by argument)';
    out.push(`${g.ids.join(', ')} could not be verified [${g.reason || 'no reason'}]: ${truncate(g.summary, 200)}. `
      + `Next: ${help}.`);
  }
  const pending = new Set(derived.effective.filter((r) => r.entries.some((e) => e.pending)).map((r) => r.id));
  if (pending.has('CK-TRACE') && matrixRef) {
    out.push(`Traceability: fill ${matrixRef} (for each requirement set status and cite implementation in evidence[] `
      + 'and tests in tests[] as path:line; map extras[] hunks with "requirement"), then run: '
      + `${adc} evidence add "${matrixRef}" ${L}`);
  }
  if (pending.has('CK-REVIEW')) {
    const answers = `${scratchDir}/review-answers.json`;
    out.push('Adversarial review (fresh context, read-only, correctness and spec gaps only). '
      + `${REVIEW_DISPATCH[tool] || REVIEW_DISPATCH.unknown} Record the yes/no/unknown answers with file:line `
      + `citations (write them to ${answers} or pipe them with -; a scratch file inside the working tree makes the `
      + `ledger stale): ${adc} evidence score "${answers}" ${L} --add. Confirm a critical finding with a reproducing `
      + `command: ${adc} evidence add --check CK-REVIEW --repro "<command>" ${L}`);
  }
  if (!ledger.claims.length && !finalized) {
    out.push('Claims: record what the implementer claimed (their summary or last message) so each claim is mapped '
      + `to evidence: ${adc} evidence claims <file|-> ${L}`);
  }
  const waivable = derived.effective
    .filter((r) => WAIVABLE.includes(r.id) && (r.effective === 'fail' || r.effective === 'finding'));
  if (waivable.length && !finalized && ledger.spec) {
    out.push(`Only where the spec explicitly asks for it (${waivable.map((r) => r.id).join(', ')}): `
      + `${adc} evidence waive <CK-ID> --file <path> --reason "spec: '<exact quote>'" ${L}. Never waive on the `
      + "implementer's word; a waiver caps the verdict at PASS-WITH-FINDINGS.");
  }
  if (!finalized) {
    out.push(`When the model steps are recorded: ${adc} evidence finalize ${L} (exit 1 on FAIL, 4 on UNVERIFIED).`);
  }
  out.push(`Post the summary (verdict, check table, commands to reproduce): ${adc} evidence render --short ${L}`);
  return out;
}

function options(values) {
  if (values.quick && values.deep) throw usageError('--quick and --deep are mutually exclusive');
  if (values.spec === '-' && values.claims === '-') throw usageError('only one of --spec and --claims can read stdin');
  // Absent numbers stay undefined so each step applies its own default.
  return {
    quick: Boolean(values.quick), deep: Boolean(values.deep), finalize: Boolean(values.finalize),
    allow: toArray(values.allow), offline: Boolean(values.offline), noInstall: Boolean(values['no-install']),
    runner: values.runner || null, allProjects: Boolean(values['all-projects']),
    baseCounts: values['base-counts'] || null, noBase: Boolean(values['no-base']), keep: Boolean(values.keep),
    failUnder: numberOption(values, 'fail-under', undefined), budgetMin: numberOption(values, 'budget', undefined),
    times: numberOption(values, 'times', undefined, { integer: true }), refresh: Boolean(values.refresh),
    tool: checkTool(values.tool),
  };
}

async function dryRunPlan(ctx, root, values, opts, steps, spec) {
  const state = prepareStateDir({ ...ctx, cwd: root }, { create: false });
  const base = resolveBase(root, values.base || null);
  const s = { opts, spec };
  const plan = [];
  for (const step of steps) {
    const { fn, detail } = await loadStepFn(step);
    const wanted = !step.when || step.when(opts, s);
    plan.push({
      name: step.name, step: step.step, module: toPosix(step.module), export: step.export, ids: step.ids,
      available: Boolean(fn), ...(detail ? { detail } : {}), would_run: wanted && Boolean(fn),
      ...(wanted ? {} : { skip_reason: step.skipReason }),
    });
  }
  return {
    result: {
      dry_run: true, base, state_dir: toPosix(state.dir), steps: plan, ledger: null,
      next_steps: ['Run without --dry-run to execute the steps and write the ledger.'],
    },
    exit: EXIT.OK, summary: `dry run: ${plan.filter((p) => p.would_run).length}/${plan.length} steps would run`,
  };
}

/** The verify orchestrator; `steps` is injectable for tests. Returns { result, exit, summary }. */
export async function runVerify(ctx, values = {}, { steps = DEFAULT_STEPS } = {}) {
  const started = Date.now();
  const opts = options(values);
  const root = requireRepo(ctx.cwd);
  const spec = values.spec ? readSpecInput(values.spec, { cwd: ctx.cwd, root }) : null;
  const claimsText = values.claims ? readInput(values.claims, ctx.cwd, { what: '--claims file' }) : null;
  if (ctx.dryRun) return dryRunPlan(ctx, root, values, opts, steps, spec);

  const target = await prepareTarget(ctx, { base: values.base || null });
  const before = statusPorcelain(target.root);
  const tool = opts.tool || detectTool();
  const session = resolveSession(target.state, values.session || null);
  const ledgerFile = allocateLedgerPath(target.state, target.snapshot.tree);
  const ledgerRef = relPosix(target.root, ledgerFile) || toPosix(ledgerFile);
  // The scratch folder next_steps names for review answers must exist before the model writes there.
  ensureDir(artifactsDir(ledgerFile));
  const s = {
    ctx, values, opts, target, spec, specPaths: spec ? specPaths(spec.text) : null, detectResult: null,
    ledgerFile, ledgerRef, traceMatrix: null,
  };
  const checks = [];
  s.fired = () => [...new Set(checks.filter((c) => c.status === 'fail' || c.status === 'finding')
    .map((c) => String(c.id).toUpperCase()))];
  const stepLog = [];
  for (const step of steps) {
    const { checks: got, log } = await runStep(step, s);
    checks.push(...got);
    stepLog.push(log);
  }
  checks.push({
    ...placeholder('CK-REVIEW', 'unverified', 'AWAITING_REVIEW', 'adversarial review not recorded yet (see next_steps)',
      { name: 'review' }),
    pending: true, data: { step: 'review', dispatch: REVIEW_DISPATCH[tool] || REVIEW_DISPATCH.unknown },
  });

  const projects = s.detectResult?.projects || [];
  const globs = projects.flatMap((p) => toArray(p?.test_globs));
  const summaryText = s.detectResult ? (s.detectResult.summary || projects.map((p) => p.root).join(', ')) : null;
  await initLedger({
    target, tool, spec: spec ? spec.ref : null, specText: spec ? spec.text : null, sessionId: session, mode: 'verify',
    file: ledgerFile, projectsSummary: summaryText, effectiveTestGlobs: globs, steps: stepLog,
    options: {
      quick: opts.quick, deep: opts.deep, allow: opts.allow, offline: opts.offline, runner: opts.runner,
      no_install: opts.noInstall, all_projects: opts.allProjects,
    },
  });
  await addChecks(ledgerFile, checks, { source: 'verify', root: target.root });
  if (claimsText != null && claimsText.trim()) await setClaims(ledgerFile, claimsText);

  let finalizeError = null;
  if (opts.finalize) {
    try {
      // The CLI's staleness rule (§7.5): finalize compares against a freshly computed snapshot.
      const fresh = { ...target, snapshot: createSnapshot(target.root, { exclude: snapshotExcludes(target.state) }) };
      await finalizeLedger(ledgerFile, { target: fresh });
    } catch (err) {
      if (!(err instanceof AdcError)) throw err;
      finalizeError = { code: err.code, message: err.message };
    }
  }
  const after = statusPorcelain(target.root);
  const porcelainChanged = before != null && after != null && before !== after;
  const ledger = readLedgerFile(ledgerFile);
  const derived = deriveVerdict(ledger);
  const finalized = Boolean(ledger.finalized_at);
  const durationMs = Date.now() - started;
  try { appendMetrics(target.state.dir, metricsFor(ledger, { duration_ms: durationMs, finalized }, derived)); } catch {}

  const rows = checkRows(derived).map((r) => ({
    id: r.id, project: r.project, status: r.effective,
    ...(r.status !== r.effective ? { recorded_status: r.status } : {}), ...(r.reason ? { reason: r.reason } : {}),
    summary: r.summary, ...(r.notes ? { notes: r.notes } : {}),
  }));
  const abs = (ref) => (ref ? toPosix(path.resolve(target.root, ref)) : ref);
  const next = nextSteps({
    derived, ledger, tool, ledgerRef: abs(ledgerRef), matrixRef: abs(s.traceMatrix),
    scratchDir: toPosix(artifactsDir(ledgerFile)), finalized, finalizeError, porcelainChanged,
  });
  const markdown = markdownPath(ledgerFile);
  const result = {
    ledger: ledgerRef, markdown: relPosix(target.root, markdown) || toPosix(markdown),
    verdict: derived.verdict, finalized, needs_human_triage: derived.needs_human_triage,
    tree_digest: target.snapshot.tree, base: target.base, tool, session_id: session.id, session_source: session.source,
    checks: rows, claims: derived.claims.map(({ seq, ...c }) => c), reasons: derived.reasons, next_steps: next,
    trace_matrix: s.traceMatrix, steps: ledger.steps, worktree_unchanged: !porcelainChanged, duration_ms: durationMs,
    ...(finalizeError ? { finalize_error: finalizeError } : {}),
    summary_markdown: renderMarkdown(ledger, { short: true }),
  };
  const count = (st) => rows.filter((r) => r.status === st).length;
  const summary = `${derived.verdict}${finalized ? '' : ' (provisional)'}: ${count('pass')} pass, `
    + `${count('fail')} fail, ${count('finding')} finding, ${count('unverified')} unverified, `
    + `${count('skipped')} skipped; ledger ${ledgerRef}`;
  return { result, exit: finalizeError ? EXIT.UNVERIFIABLE : verdictExit(derived.verdict), summary };
}

/** `verify`: every scripted step into one ledger (runVerify with the default steps). */
export const verifyCommand = defineCommand({
  name: 'verify',
  usage: [
    'verify [--base <ref>] [--spec <file|-|url>] [--claims <file|->] [--quick|--deep] [--finalize] [--allow <glob>]...',
    '       [--session <id>] [--tool <host>] [--offline] [--no-install] [--runner "<cmd>"] [--all-projects]',
    '       [--base-counts <file>] [--no-base] [--keep] [--fail-under <pct>] [--budget <min>] [--times <n>]',
    '       [--refresh]',
    '',
    'One working-tree snapshot; steps 1-14 (detect, diff-scope, deps-check, typecheck, clean-run,',
    'coverage-delta, and with --deep mutation-scope + flake-probe); with --spec a traceability skeleton',
    '(CK-TRACE stays unverified until the completed matrix is recorded); CK-REVIEW is left for the model.',
    '--quick also skips coverage-delta. --finalize seals the ledger now (headless runs).',
    'Exit 0 PASS / PASS-WITH-FINDINGS, 1 FAIL, 4 UNVERIFIED.',
  ].join('\n'),
  options: {
    base: { type: 'string' }, spec: { type: 'string' }, claims: { type: 'string' }, quick: { type: 'boolean' },
    deep: { type: 'boolean' }, finalize: { type: 'boolean' }, allow: { type: 'string', multiple: true },
    session: { type: 'string' }, tool: { type: 'string' }, offline: { type: 'boolean' },
    'no-install': { type: 'boolean' }, runner: { type: 'string' }, 'all-projects': { type: 'boolean' },
    'base-counts': { type: 'string' },
    'no-base': { type: 'boolean' }, keep: { type: 'boolean' }, 'fail-under': { type: 'string' },
    budget: { type: 'string' }, times: { type: 'string' }, refresh: { type: 'boolean' },
  },
  positionals: false,
  run: (ctx, values) => runVerify(ctx, values),
});
