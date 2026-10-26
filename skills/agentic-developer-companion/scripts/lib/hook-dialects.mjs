// Hook dialects (§8.3): detect who is calling, normalize the three stdin payload shapes
// (Copilot camelCase, Copilot/Claude/Codex snake_case) into one record, extract target paths
// (including Codex `apply_patch` bodies and string-encoded Copilot `toolArgs`), and format a
// decision in the shape each host expects. Imports only core.mjs: hooks load it on every call.

import { isObj, sha256, toPosix, truncate } from './core.mjs';

export const DIALECTS = Object.freeze(['copilot', 'claude', 'codex']);
export const HOOK_EVENTS = Object.freeze(['session-start', 'post-edit', 'post-shell', 'stop', 'pre-guard',
  'session-end']);
/** Hook levels (§8.5), shared by the handler and the renderer. */
export const LEVELS = Object.freeze(['advise', 'gate', 'guard']);
export const CONTEXT_LIMIT = 2000;

/** Host event names (Claude and Codex output carry them in hookSpecificOutput.hookEventName). */
export const HOST_EVENT = Object.freeze({
  'session-start': 'SessionStart',
  'post-edit': 'PostToolUse',
  'post-shell': 'PostToolUse',
  'stop': 'Stop',
  'pre-guard': 'PreToolUse',
  'session-end': 'SessionEnd',
});

const KNOWN_HOST_EVENTS = new Set(['SessionStart', 'PostToolUse', 'Stop', 'PreToolUse', 'SessionEnd', 'SubagentStop',
  'PostToolUseFailure']);

// Tool names per kind, compared lowercased. Copilot runtime names, Claude names, Codex payload
// names; `str_replace_editor` is decided by its `command` argument (view is a read).
const EDIT_TOOLS = new Set(['edit', 'create', 'write', 'str_replace_editor', 'str_replace', 'apply_patch',
  'multiedit', 'notebookedit', 'edit_file', 'write_file', 'insert', 'replace']);
const SHELL_TOOLS = new Set(['bash', 'powershell', 'shell', 'local_shell', 'exec_command', 'unified_exec']);
const READ_TOOLS = new Set(['view', 'read', 'grep', 'glob', 'rg', 'ls', 'read_file', 'notebookread', 'search']);
// Copilot's camelCase payload keys (the camelCase hook config).
const CAMEL_KEYS = ['sessionId', 'toolName', 'toolArgs', 'toolResult', 'transcriptPath'];

const has = (o, k) => isObj(o) && Object.hasOwn(o, k);

/** Parse a value that may be a JSON-encoded string (Copilot camelCase `toolArgs`). */
export function decodeMaybeJson(value) {
  if (typeof value !== 'string') return value;
  const t = value.trim();
  if (!t || !'{["'.includes(t[0])) return value;
  try { return JSON.parse(t); } catch { return value; }
}

/**
 * Resolve the dialect. `COPILOT_CLI=1` wins over everything (a repository `.claude/settings.json`
 * can be executed by Copilot); then an explicit `--dialect`; then the payload shape.
 */
export function detectDialect(payload, { explicit = 'auto', env = process.env } = {}) {
  if (env.COPILOT_CLI && env.COPILOT_CLI !== '0' && env.COPILOT_CLI !== 'false') return 'copilot';
  if (DIALECTS.includes(explicit)) return explicit;
  const p = isObj(payload) ? payload : {};
  if (CAMEL_KEYS.some((k) => has(p, k))) return 'copilot';
  // Copilot PascalCase config: snake_case payload with tool_result{result_type,...} or an ISO timestamp.
  if (isObj(p.tool_result) || (typeof p.timestamp === 'string' && /^\d{4}-\d\d-\d\dT/.test(p.timestamp))) {
    return 'copilot';
  }
  // Codex: turn_id, apply_patch, or model + permission_mode without Claude's prompt_id.
  if (has(p, 'turn_id') || String(p.tool_name || '').toLowerCase() === 'apply_patch') return 'codex';
  if (has(p, 'model') && has(p, 'permission_mode') && !has(p, 'prompt_id') && !has(p, 'effort')) return 'codex';
  return 'claude';
}

/** Classify a tool by name (and, for str_replace_editor, by its subcommand). */
export function toolKind(name, input = {}) {
  const n = String(name || '').toLowerCase();
  if (!n) return 'none';
  if (n === 'str_replace_editor') {
    return String((isObj(input) && input.command) || '').toLowerCase() === 'view' ? 'read' : 'edit';
  }
  if (EDIT_TOOLS.has(n)) return 'edit';
  if (SHELL_TOOLS.has(n)) return 'shell';
  if (READ_TOOLS.has(n)) return 'read';
  return 'other';
}

function isoFrom(ts) {
  if (typeof ts === 'number' && Number.isFinite(ts)) {
    // Copilot camelCase timestamps are epoch milliseconds; seconds are accepted too.
    const d = new Date(ts < 1e11 ? ts * 1000 : ts);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof ts === 'string' && !Number.isNaN(Date.parse(ts))) return new Date(ts).toISOString();
  return null;
}

const RESULT_TEXT_KEYS = ['textResultForLlm', 'text_result_for_llm', 'stdout', 'stderr', 'output', 'aggregated_output',
  'formatted_output', 'text', 'content', 'result', 'message', 'error'];

/** Collect readable text from a tool result (string, {stdout,stderr}, content blocks...). */
export function resultText(value, max = 200_000) {
  const parts = [];
  let size = 0;
  const walk = (v, depth) => {
    if (v == null || depth > 4 || size >= max) return;
    if (typeof v === 'string') { parts.push(v); size += v.length; return; }
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    if (!isObj(v)) return;
    for (const k of RESULT_TEXT_KEYS) if (Object.hasOwn(v, k)) walk(v[k], depth + 1);
  };
  walk(value, 0);
  const text = parts.join('\n');
  return text.length > max ? text.slice(0, max) : text;
}

function exitCodeFrom(...values) {
  for (const v of values) {
    if (!isObj(v)) continue;
    for (const k of ['exit_code', 'exitCode', 'exit_status', 'returncode', 'return_code']) {
      if (Number.isInteger(v[k])) return v[k];
    }
  }
  return null;
}

// Exit codes the hosts print into the result text (measured 2026-10-25): Copilot CLI 1.0.103 ends
// shell results with `<shellId: 0 completed with exit code 1>`; Codex 0.164 starts apply_patch
// results with `Exit code: 0\nWall time: ...`. Anything else stays null.
const COPILOT_EXIT_TRAILER = /<shellId: [^>\s]+ completed with exit code (-?\d+)>\s*$/;
const CODEX_EXIT_HEADER = /^Exit code: (-?\d+)\r?\nWall time:/;

/** Exit code printed by the host into a tool result, or null. */
export function exitFromText(text) {
  if (typeof text !== 'string' || !text) return null;
  const m = COPILOT_EXIT_TRAILER.exec(text.slice(-200)) || CODEX_EXIT_HEADER.exec(text.slice(0, 200));
  return m ? Number(m[1]) : null;
}

/** The shell command line of a shell tool call (string, argv array, or `bash -lc <cmd>`). */
export function shellCommand(input) {
  const v = decodeMaybeJson(input);
  if (typeof v === 'string') return v;
  if (!isObj(v)) return '';
  for (const k of ['command', 'cmd', 'script', 'commandLine', 'command_line']) {
    const c = v[k];
    if (typeof c === 'string') return c;
    if (Array.isArray(c) && c.every((x) => typeof x === 'string')) {
      // ["bash", "-lc", "npm test"] -> "npm test"
      const i = c.findIndex((x) => ['-c', '-lc', '-Command', '-command', '/c', '/C'].includes(x));
      return i >= 0 && i + 1 < c.length ? c.slice(i + 1).join(' ') : c.join(' ');
    }
  }
  return '';
}

/**
 * One normalized record for every dialect. Fields absent from a payload are null; nothing
 * here throws on odd input.
 */
export function normalizePayload(payload, dialect, event) {
  const p = isObj(payload) ? payload : {};
  const camel = CAMEL_KEYS.some((k) => has(p, k));
  const transcript = p.transcriptPath ?? p.transcript_path ?? null;
  let sessionId = p.sessionId ?? p.session_id ?? null;
  if (sessionId != null) sessionId = String(sessionId);
  else if (typeof transcript === 'string' && transcript) sessionId = `t-${sha256(transcript).slice(0, 16)}`;
  else sessionId = 'unknown';

  const toolName = camel ? (p.toolName ?? null) : (p.tool_name ?? null);
  const toolInput = decodeMaybeJson(camel ? p.toolArgs : p.tool_input) ?? null;
  const rawResult = camel ? p.toolResult : (has(p, 'tool_result') ? p.tool_result : p.tool_response);
  const resultObj = decodeMaybeJson(rawResult);
  const resultType = isObj(resultObj) ? (resultObj.resultType ?? resultObj.result_type ?? null) : null;
  const lastMessage = p.last_assistant_message ?? p.lastAssistantMessage ?? null;
  const resultTextValue = rawResult == null ? null : resultText(resultObj);
  const payloadExit = exitCodeFrom(resultObj, p);
  const textExit = payloadExit == null ? exitFromText(resultTextValue) : null;
  const snake = has(p, 'hook_event_name') || has(p, 'session_id') || has(p, 'tool_name');

  return {
    dialect,
    event,
    host_event: typeof p.hook_event_name === 'string' ? p.hook_event_name : null,
    shape: camel ? 'camel' : snake ? 'snake' : 'unknown',
    session_id: sessionId,
    transcript_path: typeof transcript === 'string' ? transcript : null,
    cwd: typeof p.cwd === 'string' && p.cwd ? p.cwd : null,
    timestamp: isoFrom(p.timestamp),
    tool_name: toolName == null ? null : String(toolName),
    tool_kind: toolKind(toolName, toolInput),
    tool_input: toolInput,
    tool_result_text: resultTextValue,
    tool_result_type: resultType == null ? null : String(resultType),
    exit_code: payloadExit ?? textExit,
    exit_source: payloadExit != null ? 'payload' : textExit != null ? 'result-text' : null,
    stop_hook_active: p.stop_hook_active === true || p.stopHookActive === true,
    last_message: typeof lastMessage === 'string' ? lastMessage : null,
    source: typeof p.source === 'string' ? p.source : null,
    reason: typeof p.reason === 'string' ? p.reason : (typeof p.stopReason === 'string' ? p.stopReason : null),
    permission_mode: typeof p.permission_mode === 'string' ? p.permission_mode : null,
    agent_id: p.agent_id ?? p.agentId ?? null,
    tool_use_id: typeof p.tool_use_id === 'string' && p.tool_use_id ? p.tool_use_id : null,
    keys: Object.keys(p).sort(),
  };
}

// ---------------------------------------------------------------------------
// Paths

const PATH_KEYS = new Set(['path', 'file_path', 'filePath', 'filepath', 'notebook_path', 'notebookPath',
  'target_file', 'targetFile', 'file', 'filename', 'fileName', 'new_path', 'old_path', 'destination', 'source_path']);
const PATH_LIST_KEYS = new Set(['paths', 'files', 'file_paths', 'filePaths']);
const PATCH_HEADER = /^\*\*\* (Add|Update|Delete) File:\s*(.+?)\s*$/;
const PATCH_MOVE = /^\*\*\* Move to:\s*(.+?)\s*$/;
const PATCH_FILE = /\*\*\* (Add|Update|Delete) File:/;

const cleanPath = (s) => toPosix(String(s).trim().replace(/^["']|["']$/g, ''));

/**
 * Parse every `apply_patch` body found in the tool input. Returns
 * `[{path, op: 'add'|'update'|'delete', moveTo?, added: [{line, text}]}]`. `line` is the line in the
 * new file, or null where the patch does not say: Codex-style `@@` hunks carry context, not numbers.
 */
export function parsePatch(input) {
  const bodies = [];
  const walk = (v, depth) => {
    if (depth > 4 || v == null) return;
    if (typeof v === 'string') {
      if (/^\*\*\* (Begin Patch|Add File:|Update File:|Delete File:)/m.test(v)) bodies.push(v);
      return;
    }
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    if (isObj(v)) for (const x of Object.values(v)) walk(x, depth + 1);
  };
  walk(decodeMaybeJson(input), 0);
  const files = [];
  for (const body of bodies) {
    let cur = null;
    let lineNo = 0;
    let known = false;
    for (const raw of body.split(/\r?\n/)) {
      const h = PATCH_HEADER.exec(raw);
      if (h) {
        cur = { path: cleanPath(h[2]), op: h[1].toLowerCase(), added: [] };
        files.push(cur);
        lineNo = 0;
        // An added file is its `+` lines, so their numbers are exact; an update needs a numbered hunk.
        known = cur.op === 'add';
        continue;
      }
      if (!cur) continue;
      const mv = PATCH_MOVE.exec(raw);
      if (mv) { cur.moveTo = cleanPath(mv[1]); continue; }
      if (raw.startsWith('@@')) {
        // Unified-diff style hunk headers carry the new start line when present.
        const m = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(raw);
        known = Boolean(m);
        lineNo = m ? Number(m[1]) - 1 : 0;
        continue;
      }
      if (raw.startsWith('*** ')) continue;
      if (raw.startsWith('+')) { lineNo += 1; cur.added.push({ line: known ? lineNo : null, text: raw.slice(1) }); }
      else if (raw.startsWith(' ')) lineNo += 1;
    }
  }
  return files;
}

/** Target paths of an edit or read tool call (POSIX separators, as given: relative or absolute). */
export function extractPaths(norm) {
  const out = [];
  const add = (p) => {
    if (typeof p !== 'string' || !p.trim() || p.length > 4096 || /[\r\n]/.test(p)) return;
    const c = cleanPath(p);
    if (c && !out.includes(c)) out.push(c);
  };
  const input = norm && norm.tool_input;
  const name = String((norm && norm.tool_name) || '').toLowerCase();
  if (name === 'apply_patch' || (typeof input === 'string' && PATCH_FILE.test(input)) ||
      (isObj(input) && Object.values(input).some((v) => typeof v === 'string' && PATCH_FILE.test(v)))) {
    for (const f of parsePatch(input)) { add(f.path); if (f.moveTo) add(f.moveTo); }
  }
  const walk = (v, depth) => {
    if (depth > 3 || !isObj(v)) return;
    for (const [k, val] of Object.entries(v)) {
      // Copilot's grep/rg/glob take `paths` as one string or an array (measured, CLI 1.0.103).
      if ((PATH_KEYS.has(k) || PATH_LIST_KEYS.has(k)) && typeof val === 'string') add(val);
      else if (PATH_LIST_KEYS.has(k) && Array.isArray(val)) {
        val.forEach((x) => (typeof x === 'string' ? add(x) : walk(x, depth + 1)));
      } else if (Array.isArray(val)) val.forEach((x) => walk(x, depth + 1));
      else if (isObj(val)) walk(val, depth + 1);
    }
  };
  walk(input, 0);
  return out;
}

/** Search patterns of read/search tools (glob `pattern`, grep `include`), for the guard. */
export function extractPatterns(norm) {
  const input = norm && norm.tool_input;
  if (!isObj(input)) return [];
  return ['pattern', 'glob', 'include', 'includes', 'query'].map((k) => input[k]).filter((v) => typeof v === 'string');
}

const CONTENT_KEYS = ['content', 'file_text', 'fileText', 'new_string', 'newString', 'new_str', 'newStr',
  'new_source', 'newSource', 'new_text', 'newText', 'text', 'code'];
const EDIT_TEXT_KEYS = ['new_string', 'newString', 'new_str', 'newText', 'new_text'];

/**
 * New content per edited file, for marker scanning: Write `content`, Edit `new_string`,
 * MultiEdit `edits[]`, NotebookEdit `new_source`, Copilot `file_text`/`new_str`, patch `+` lines.
 * Returns `[{path, op, text, lines?, fragment?}]`: `lines` maps patch lines to file lines,
 * `fragment` marks replacement text whose position in the file is unknown.
 */
export function extractContent(norm) {
  const input = norm && norm.tool_input;
  const name = String((norm && norm.tool_name) || '').toLowerCase();
  const patchFiles = parsePatch(input);
  if (patchFiles.length) {
    return patchFiles.map((f) => ({ path: f.path, op: f.op, text: f.added.map((a) => a.text).join('\n'),
      lines: f.added.map((a) => a.line) }));
  }
  if (!isObj(input)) return [];
  const file = extractPaths(norm)[0] || null;
  const texts = CONTENT_KEYS.map((k) => input[k]).filter((v) => typeof v === 'string');
  if (Array.isArray(input.edits)) {
    for (const e of input.edits) {
      if (isObj(e)) for (const k of EDIT_TEXT_KEYS) if (typeof e[k] === 'string') texts.push(e[k]);
    }
  }
  const op = name === 'create' || name === 'write' || (name === 'str_replace_editor' && input.command === 'create')
    ? 'write' : 'update';
  if (!file && !texts.length) return [];
  // Replacement text (Edit new_string, edit new_str, MultiEdit, NotebookEdit cells) has no known
  // position in the file, so its line numbers are not reported.
  return [{ path: file, op, text: texts.join('\n'), ...(op === 'write' ? {} : { fragment: true }) }];
}

// ---------------------------------------------------------------------------
// Output

/**
 * Format an internal decision `{context?, block?, deny?, ask?, modifiedResult?: {text, resultType}}`
 * as the host expects. No decision yields `{}`. Codex rejects unknown fields, so its shapes use
 * only documented keys (Stop context becomes `systemMessage`).
 */
export function formatOutput(dialect, event, decision = {}, { hostEvent = null } = {}) {
  const d = decision || {};
  const evName = hostEvent && KNOWN_HOST_EVENTS.has(hostEvent) ? hostEvent : HOST_EVENT[event];
  const cap = (s) => truncate(String(s), CONTEXT_LIMIT);
  if (dialect === 'copilot') {
    if (d.deny) return { permissionDecision: 'deny', permissionDecisionReason: cap(d.deny) };
    if (d.ask) return { permissionDecision: 'ask', permissionDecisionReason: cap(d.ask) };
    if (d.block) return { decision: 'block', reason: cap(d.block) };
    const out = {};
    if (d.modifiedResult && event === 'post-shell') {
      out.modifiedResult = { resultType: d.modifiedResult.resultType || 'success',
        textResultForLlm: String(d.modifiedResult.text) };
    }
    if (d.context && event !== 'session-end') out.additionalContext = cap(d.context);
    return out;
  }
  // Claude and Codex share the nested shape.
  if (d.deny || d.ask) {
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: d.deny ? 'deny' : 'ask',
      permissionDecisionReason: cap(d.deny || d.ask) } };
  }
  if (d.block) return { decision: 'block', reason: cap(d.block) };
  if (!d.context || event === 'session-end') return {};
  if (dialect === 'codex' && evName === 'Stop') return { systemMessage: cap(d.context) };
  return { hookSpecificOutput: { hookEventName: evName, additionalContext: cap(d.context) } };
}
