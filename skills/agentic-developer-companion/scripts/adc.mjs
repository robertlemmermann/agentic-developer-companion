// agentic-developer-companion: single CLI entry point.
// Zero dependencies. Always launched as `node <skill>/scripts/adc.mjs <command> [options]`.
//
// This file must stay parseable by old Node versions: the version guard below runs
// before any library module is loaded, so it uses no static imports.

const MIN_NODE = 24;
const argv = process.argv.slice(2);
const isHook = argv[0] === 'hook-run';
const major = Number(String(process.versions.node).split('.')[0]);

if (!(major >= MIN_NODE)) {
  if (isHook) {
    // Hooks never fail: an unsupported Node yields "no decision".
    process.stdout.write('{}\n');
    process.exit(0);
  }
  process.stderr.write(
    'agentic-developer-companion: Node.js ' + MIN_NODE + '+ is required (found ' +
      process.versions.node + '). Scripts are unavailable; follow the playbooks in ' +
      'references/ by hand (guidance-only mode).\n'
  );
  process.exit(3);
}

// command -> [module under ./lib, exported handler]
const COMMANDS = {
  'verify': ['verify.mjs', 'verifyCommand'],
  'detect': ['detect.mjs', 'detectCommand'],
  'diff-scope': ['diff-scope.mjs', 'diffScopeCommand'],
  'deps-check': ['deps.mjs', 'depsCheckCommand'],
  'typecheck': ['clean-run.mjs', 'typecheckCommand'],
  'clean-run': ['clean-run.mjs', 'cleanRunCommand'],
  'coverage-delta': ['probes.mjs', 'coverageDeltaCommand'],
  'mutation-scope': ['probes.mjs', 'mutationScopeCommand'],
  'flake-probe': ['probes.mjs', 'flakeProbeCommand'],
  'evidence': ['evidence.mjs', 'evidenceCommand'],
  'trace': ['trace.mjs', 'traceCommand'],
  'hooks': ['hooks-render.mjs', 'hooksCommand'],
  'setup': ['hooks-render.mjs', 'setupCommand'],
  'hook-run': ['hook-run.mjs', 'hookRunCommand'],
  'tooling': ['tooling.mjs', 'toolingCommand'],
  'live': ['live.mjs', 'liveCommand'],
  'budget': ['live.mjs', 'budgetCommand'],
  'scaffold': ['scaffold.mjs', 'scaffoldCommand'],
  'doctor': ['doctor.mjs', 'doctorCommand'],
};

const HELP = [
  'usage: node <skill>/scripts/adc.mjs <command> [options]',
  '',
  'QA of agent-made changes:',
  '  verify            every scripted verify step -> evidence ledger + verdict',
  '  detect            projects, package managers, test runners, CI, base branch',
  '  diff-scope        diff-scoped checks on the working-tree snapshot',
  '  deps-check        new dependencies exist; lockfile consistency',
  '  typecheck         new compile/type errors vs the base',
  '  clean-run         independent full-suite run of the snapshot in a temp worktree',
  '  coverage-delta    changed-line coverage',
  '  mutation-scope    mutation testing on changed files',
  '  flake-probe       repeat and shuffle changed tests',
  '  evidence          init | add | claims | waive | finalize | render | status | score',
  '  trace             spec -> diff traceability skeleton',
  'Test engineering:',
  '  scaffold          e2e-web | e2e-api | e2e-cli | live | regress | ci-gate | flake | tooling kinds',
  '  live run          run live probes under the budget ledger',
  '  budget            show | reset | prune',
  'Agentic tooling:',
  '  tooling           lint | cost | port | trigger-set | modify | plugin | scaffold',
  'Hooks and environment:',
  '  hooks render      render hook config for a host (alias: setup hooks)',
  '  hook-run <event>  hook handler (reads stdin, prints one JSON object)',
  '  doctor            environment and installation diagnostics',
  '  version | help',
  '',
  'Common options: --json --cwd <dir> --base <ref> --state-dir <dir> --dry-run --yes',
  'Exit codes: 0 ok, 1 findings, 2 usage, 3 environment missing, 4 could not verify.',
].join('\n');

async function main() {
  const command = argv[0];
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(HELP + '\n');
    return 0;
  }
  if (command === 'version' || command === '--version') {
    const core = await import('./lib/core.mjs');
    process.stdout.write(core.skillVersion() + '\n');
    return 0;
  }
  const entry = COMMANDS[command];
  if (!entry) {
    process.stderr.write('adc: unknown command "' + command + '"\n\n' + HELP + '\n');
    return 2;
  }
  if (isHook) {
    // The handler returns the decision object (or its JSON text); this file prints it exactly once.
    const [mod, core] = await Promise.all([import('./lib/' + entry[0]), import('./lib/core.mjs')]);
    const out = await mod[entry[1]](argv.slice(1));
    if (typeof out === 'string') return out.trim().startsWith('{') ? out.trim() : '{}';
    return out && typeof out === 'object' ? core.asciiJson(out, 0) : '{}';
  }
  const core = await import('./lib/core.mjs');
  return core.dispatch(command, argv.slice(1), () => import('./lib/' + entry[0]), entry[1]);
}

if (isHook) {
  // Hooks: exactly one ASCII-only JSON object on stdout, exit 0, whatever happens
  // (a module that cannot load, a thrown error, a handler slower than 2 s).
  let printed = false;
  const emit = (text) => {
    if (printed) return;
    printed = true;
    try { process.stdout.write(text + '\n'); } catch {}
  };
  const watchdog = setTimeout(() => { emit('{}'); process.exit(0); }, 2000);
  watchdog.unref();
  const done = (text) => { emit(text); clearTimeout(watchdog); process.exitCode = 0; };
  main().then((text) => done(typeof text === 'string' ? text : '{}'), () => done('{}'));
} else {
  main().then(
    (code) => { process.exitCode = typeof code === 'number' ? code : 0; },
    (err) => {
      process.stderr.write('adc: internal error: ' + (err && err.stack ? err.stack : String(err)) + '\n');
      process.exitCode = 4;
    }
  );
}
