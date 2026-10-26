// Shared unit-test helpers: temp dirs (removed after the importing file's tests), file trees,
// git repositories, fixtures, a host-free child environment and adc.mjs runners.
import { after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ADC_SCRIPT, tryJson } from '../../skills/agentic-developer-companion/scripts/lib/core.mjs';

export const FIX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
/** A JSON file, parsed strictly: a missing or broken file fails the test loudly. */
export const readJsonStrict = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
/** tests/fixtures/<name>.json */
export const fixtureJson = (name) => readJsonStrict(path.join(FIX, `${name}.json`));
export const read = (dir, rel) => fs.readFileSync(path.join(dir, ...rel.split('/')), 'utf8');
export const has = (dir, rel) => fs.existsSync(path.join(dir, ...rel.split('/')));

// Test-only credential, assembled at run time so no secret-shaped literal is stored.
export const AWS_KEY = ['AKIA', 'IOSFODNN7', 'EXAMPLE'].join('');

const temp = [];
after(() => { for (const p of temp) fs.rmSync(p, { recursive: true, force: true, maxRetries: 3 }); });
/** Remove `p` after this file's tests. */
export const removeAfter = (p) => { temp.push(p); return p; };
/** A fresh directory under the OS temp dir (realpath'd with `real`: macOS /var vs /private/var). */
export function tmpDir(prefix = 'adc-test-', { real = false } = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return removeAfter(real ? fs.realpathSync(d) : d);
}

/** Write one file: a string or Buffer as is, any other value as pretty JSON; null or undefined deletes it. */
export function writeFile(dir, rel, content) {
  const abs = path.join(dir, ...rel.split('/'));
  if (content == null) { fs.rmSync(abs, { force: true }); return abs; }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, typeof content === 'string' || Buffer.isBuffer(content) ? content : `${JSON.stringify(content, null, 2)}\n`);
  return abs;
}

/** Write `{ relPath: content }` (see writeFile); `transform` rewrites string contents first. */
export function writeFiles(dir, files, transform = null) {
  for (const [rel, c] of Object.entries(files)) writeFile(dir, rel, transform && typeof c === 'string' ? transform(c) : c);
  return dir;
}

/** git in `cwd`; throws on a non-zero exit; returns stdout byte for byte. */
export function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

/**
 * A git repository on branch `main` with `files` committed (`commit: false` leaves them untracked).
 * `dir` (an existing empty directory) replaces the temp dir made from `prefix`; `config` adds local settings.
 */
export function makeRepo(files = {}, { prefix = 'adc-repo-', real = false, dir = null, commit = true, message = 'init', config = {}, transform = null } = {}) {
  dir ||= tmpDir(prefix, { real });
  git(dir, 'init', '-q', '-b', 'main');
  // Local settings appended to .git/config directly: one spawn per repository instead of one per key.
  const sections = {};
  for (const [key, value] of Object.entries({ 'user.email': 't@example.com', 'user.name': 'Test', 'commit.gpgsign': 'false', ...config })) {
    const dot = key.lastIndexOf('.');
    (sections[key.slice(0, dot)] ||= []).push(`\t${key.slice(dot + 1)} = ${value}\n`);
  }
  fs.appendFileSync(path.join(dir, '.git', 'config'), Object.entries(sections).map(([name, lines]) => `[${name}]\n${lines.join('')}`).join(''));
  writeFiles(dir, files, transform);
  if (commit) { git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', message, '--allow-empty'); }
  return { dir, g: (...args) => git(dir, ...args) };
}

// Host-session, CI, live-test and generated-test markers.
const HOST_MARKER = /^(?:ADC_|CLAUDE|COPILOT|GITHUB_COPILOT|CODEX|VSCODE_|E2E_)|^(?:CI|GITHUB_ACTIONS|TERM_PROGRAM|LIVE_TESTS_ENABLED|UPDATE_GOLDEN|UPDATE_CONTRACTS|GOLDEN_DIR)$/;
/** process.env without host or CI markers (the suite may itself run inside an agent session), plus `extra`. */
export function hostFreeEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!HOST_MARKER.test(k)) env[k] = v;
  return { ...env, ...extra };
}

/** `node adc.mjs <args> --json [--cwd cwd]`; `env` is the child's whole environment. */
export function runAdc(args, { cwd, env = process.env, input = '', timeout = 120_000 } = {}) {
  const r = spawnSync(process.execPath, [ADC_SCRIPT, ...args, '--json', ...(cwd ? ['--cwd', cwd] : [])], { encoding: 'utf8', input, env, timeout });
  return { status: r.status, json: tryJson(r.stdout), stdout: r.stdout, stderr: r.stderr };
}

/** spawn without blocking the event loop; killed after `timeout` ms. `bytes` is stdout undecoded. */
export function spawnAsync(cmd, args, { input = '', env, cwd, timeout = 60_000, closeStdin = true } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(cmd, args, { env, cwd, windowsHide: true });
    const out = [];
    const err = [];
    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => err.push(c));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.on('error', (e) => { clearTimeout(timer); resolve({ status: null, stdout: '', stderr: String(e), ms: Date.now() - t0, bytes: Buffer.alloc(0) }); });
    child.on('close', (status) => {
      clearTimeout(timer);
      const bytes = Buffer.concat(out);
      resolve({ status, stdout: bytes.toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), ms: Date.now() - t0, bytes });
    });
    child.stdin.on('error', () => {});
    if (input) child.stdin.write(input);
    if (closeStdin) child.stdin.end();
  });
}
