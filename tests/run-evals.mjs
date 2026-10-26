// Runs the skill's own `claude plugin eval` cases (paid: they bill the signed-in Claude account).
// `claude plugin eval` reads cases only from inside its target, and a bare skill folder is a valid
// target, but evals/ stays out of the shipped skill. So this copies the skill to the OS temp dir,
// puts evals/ inside the copy and evaluates that. Nothing is written to the repository.
//
//   node tests/run-evals.mjs [claude plugin eval options...]
//
// Defaults: --ablation none (so `tool_used: Skill` graders count), --threshold 0.8,
// --max-cost-usd 10, --no-publish, results in a temp dir that is printed.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NAME = 'agentic-developer-companion';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const has = (flag) => args.some((a) => a === flag || a.startsWith(`${flag}=`));

const target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'adc-eval-')), NAME);
fs.cpSync(path.join(repo, 'skills', NAME), target, { recursive: true });
fs.cpSync(path.join(repo, 'evals'), path.join(target, 'evals'), { recursive: true });

const out = has('--output-dir') ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'adc-eval-results-'));
const evalArgs = ['plugin', 'eval', target, '--trust-plugin',
  ...(has('--ablation') ? [] : ['--ablation', 'none']),
  ...(has('--threshold') ? [] : ['--threshold', '0.8']),
  ...(has('--max-cost-usd') ? [] : ['--max-cost-usd', '10']),
  ...(has('--publish-report') || has('--no-publish') ? [] : ['--no-publish']),
  ...(out ? ['--output-dir', out] : []),
  ...args];
process.stderr.write(`run-evals: target ${target}${out ? `, results ${out}` : ''}\n`);
// `claude` is a .cmd shim on Windows npm installs, which only a shell can start; quote for cmd.exe.
const res = process.platform === 'win32'
  ? spawnSync(['claude', ...evalArgs].map((a) => `"${a.replace(/"/g, '""')}"`).join(' '), { stdio: 'inherit', shell: true })
  : spawnSync('claude', evalArgs, { stdio: 'inherit' });
if (res.error) process.stderr.write(`run-evals: could not start claude: ${res.error.message}\n`);
process.exitCode = res.status ?? 1;
