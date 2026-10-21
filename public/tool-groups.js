/** Consecutive tool-call grouping and summary text. No DOM. */

const KINDS = new Set(['read', 'write', 'edit', 'ls', 'grep', 'bash']);
const COUNT_KINDS = new Set(['read', 'ls', 'grep', 'other']);
const CHANGE_KINDS = new Set(['write', 'edit']);
const PROBE_KINDS = new Set(['read', 'ls', 'grep']);
const NAMED_KIND_LIMIT = 2;

export const TOOL_GROUP_PREVIEW = 8;
export const TOOL_ERROR_PREVIEW_LINES = 8;

export function toolKind(name) {
  const key = String(name || '').toLowerCase();
  return KINDS.has(key) ? key : 'other';
}

/** running | failed | interrupted | done */
export function toolStatusBucket(status) {
  const value = String(status || '').toLowerCase();
  if (value === 'running' || value === 'pending' || value === 'waiting') return 'running';
  if (value === 'failed' || value === 'error') return 'failed';
  if (value === 'interrupted') return 'interrupted';
  return 'done';
}

export function oneLine(value, max = 72) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 1))}…`;
}

export function toolFileLabel(pathLike) {
  const s = String(pathLike || '').replaceAll('\\', '/').replace(/\/+$/, '');
  if (!s || s === '.' || s === './') return '';
  const parts = s.split('/').filter(Boolean);
  return parts.pop() || s;
}

function slashPath(value) {
  return String(value ?? '').replaceAll('\\', '/');
}

/** Workspace-relative path for display. Paths outside the workspace stay as-is. */
export function relativizePath(pathLike, workspacePath) {
  const raw = String(pathLike ?? '');
  const rootRaw = String(workspacePath ?? '');
  if (!raw || !rootRaw) return raw;
  const file = slashPath(raw);
  const root = slashPath(rootRaw).replace(/\/+$/, '');
  if (!root) return raw;
  const fileCmp = file.toLowerCase();
  const rootCmp = root.toLowerCase();
  if (fileCmp === rootCmp) return '.';
  if (fileCmp.startsWith(`${rootCmp}/`)) return file.slice(root.length + 1);
  return raw;
}

function rootVariants(workspacePath) {
  const rootRaw = String(workspacePath ?? '');
  if (!rootRaw) return [];
  const trimmed = rootRaw.replace(/[\\/]+$/, '');
  const forward = slashPath(trimmed).replace(/\/+$/, '');
  const backward = trimmed.replaceAll('/', '\\').replace(/\\+$/, '');
  const seen = new Set();
  const out = [];
  for (const item of [trimmed, forward, backward]) {
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  out.sort((a, b) => b.length - a.length);
  return out;
}

/** Replace absolute workspace prefixes in error text with relative paths. */
export function relativizeText(text, workspacePath) {
  const raw = String(text ?? '');
  if (!raw) return raw;
  let out = raw;
  for (const root of rootVariants(workspacePath)) {
    const sep = root.includes('\\') ? '\\' : '/';
    out = out.split(root + sep).join('');
    const quoted = new RegExp(`(['"])${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\1`, 'g');
    out = out.replace(quoted, '$1.$1');
  }
  return out;
}

const FILE_ERROR_CODES = [
  { re: /\bENOENT\b/, key: 'tool_err_enoent' },
  { re: /\bEACCES\b|\bEPERM\b/, key: 'tool_err_eacces' },
  { re: /\bE_SANDBOX\b/, key: 'tool_err_sandbox' },
  { re: /\bEISDIR\b/, key: 'tool_err_eisdir' },
  { re: /\bENOTDIR\b/, key: 'tool_err_enotdir' },
];

export function shortErrorHint(text, t) {
  const raw = String(text ?? '');
  for (const item of FILE_ERROR_CODES) {
    if (item.re.test(raw)) return t(item.key);
  }
  return '';
}

/**
 * What a row or a single-call summary should name.
 * `mode: 'path'` is a file path (may be empty). `mode: 'text'` is a command or pattern.
 */
export function toolFocus(tool) {
  const name = String(tool?.name || '');
  const kind = toolKind(name);
  const input = tool?.input && typeof tool.input === 'object' ? tool.input : {};
  if (kind === 'bash') {
    return { mode: 'text', text: oneLine(input.command || input.cmd || '') };
  }
  if (kind === 'grep') {
    const pattern = oneLine(input.pattern || input.query || '');
    const file = oneLine(tool?.path || input.path || '');
    return { mode: 'text', text: [pattern, file].filter(Boolean).join(' ') };
  }
  const file = String(tool?.path || input.path || input.file_path || input.file || '').trim();
  if (kind === 'ls' && (file === '' || file === '.' || file === './')) {
    return { mode: 'path', text: '' };
  }
  return { mode: 'path', text: file };
}

/** One-line intent from `input.description`, or empty when the model omitted it. */
export function toolIntent(tool) {
  const input = tool?.input && typeof tool.input === 'object' && !Array.isArray(tool.input)
    ? tool.input
    : {};
  if (typeof input.description !== 'string') return '';
  return oneLine(input.description);
}

/**
 * Expanded-row heading. Prefer the intent as the title and keep the command or
 * path as secondary detail so the actual call is still visible.
 */
export function toolRowHeading(tool) {
  const intent = toolIntent(tool);
  const focus = toolFocus(tool);
  if (intent) return { title: intent, detail: focus.text, intent: true };
  return { title: focus.text, detail: '', intent: false };
}

export function toolGroupKey(tools) {
  const list = Array.isArray(tools) ? tools : [];
  const first = list.find((tool) => tool && tool.id != null && String(tool.id) !== '');
  if (first) return `g:${first.id}`;
  const name = list[0]?.name || 'tool';
  return `g:${name}:${list.length}`;
}

function presentSummary(text) {
  if (!text) return '';
  const first = text.charAt(0);
  if (first >= 'a' && first <= 'z') return first.toUpperCase() + text.slice(1);
  return text;
}

function countClause(kind, n, name, t) {
  if (kind === 'other') {
    return t(n === 1 ? 'tool_sum_other_one' : 'tool_sum_other', { n, name: name || 'tool' });
  }
  return t(n === 1 ? `tool_sum_${kind}_one` : `tool_sum_${kind}`, { n });
}

function countPhrase(tools, t) {
  const order = [];
  const counts = new Map();
  const names = new Map();
  for (const tool of tools) {
    const kind = toolKind(tool?.name);
    const key = kind === 'other' ? `other:${tool?.name || 'tool'}` : kind;
    if (!counts.has(key)) {
      counts.set(key, 0);
      order.push(key);
      names.set(key, tool?.name || 'tool');
    }
    counts.set(key, counts.get(key) + 1);
  }
  const join = t('tool_sum_join');
  return order.map((key) => {
    const kind = key.startsWith('other:') ? 'other' : key;
    return countClause(kind, counts.get(key), names.get(key), t);
  }).join(join);
}

function targetOf(tool) {
  return toolFocus(tool).text;
}

function shortFocus(tool) {
  const focus = toolFocus(tool);
  if (focus.mode === 'path') return toolFileLabel(focus.text);
  return oneLine(focus.text, 32);
}

function singlePhrase(tool, t) {
  const intent = toolIntent(tool);
  if (intent) return intent;
  const kind = toolKind(tool?.name);
  const target = targetOf(tool);
  if (kind === 'other') {
    const name = tool?.name || 'tool';
    return target
      ? t('tool_one_other_target', { name, target })
      : t('tool_one_other', { name });
  }
  if (!target) return countPhrase([tool], t);
  return t(`tool_one_${kind}`, { target });
}

function runningPhrase(tool, t) {
  const intent = toolIntent(tool);
  if (intent) return intent;
  const kind = toolKind(tool?.name);
  const target = targetOf(tool);
  if (kind === 'other') {
    const name = tool?.name || 'tool';
    return target
      ? t('tool_run_other_target', { name, target })
      : t('tool_run_other', { name });
  }
  if (!target) return t(`tool_run_${kind}_bare`);
  return t(`tool_run_${kind}`, { target });
}

function actionLabel(tool, t) {
  const kind = toolKind(tool?.name);
  if (kind === 'other') return tool?.name || 'tool';
  return t(`tool_act_${kind}`);
}

function failedPhrase(tool, t) {
  const action = actionLabel(tool, t);
  const target = shortFocus(tool);
  if (!target) return t('tool_fail_bare', { action });
  return t('tool_fail_named', { action, target });
}

function changedClause(tools, t) {
  const names = [];
  const seen = new Set();
  for (const tool of tools) {
    if (isCallFailed(tool)) continue;
    if (!CHANGE_KINDS.has(toolKind(tool?.name))) continue;
    const path = targetOf(tool);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    names.push(toolFileLabel(path) || path);
  }
  if (!names.length) return '';
  const shown = names.slice(0, 3);
  const extra = names.length - shown.length;
  const joined = shown.join(t('tool_sum_names_join'));
  if (extra > 0) return t('tool_sum_changed_more', { names: joined, n: extra });
  return t('tool_sum_changed', { names: joined });
}

function failedClause(tools, t) {
  const failed = tools.filter((tool) => isRealToolFailure(tool, tools));
  if (!failed.length) return '';
  return failed.slice(0, 2).map((tool) => failedPhrase(tool, t)).join(t('tool_sum_names_join'));
}

function commandClause(tools, t) {
  const cmds = [];
  for (const tool of tools) {
    if (isCallFailed(tool)) continue;
    if (toolKind(tool?.name) !== 'bash') continue;
    const text = targetOf(tool);
    if (!text) continue;
    cmds.push(oneLine(text, 40));
  }
  if (!cmds.length) return '';
  const shown = cmds.slice(0, 2);
  return t('tool_sum_ran', { names: shown.join(t('tool_sum_names_join')) });
}

function uniqueFileNames(tools) {
  const names = [];
  const seen = new Set();
  for (const tool of tools) {
    const label = toolFileLabel(targetOf(tool));
    if (!label || seen.has(label)) continue;
    seen.add(label);
    names.push(label);
  }
  return names;
}

function grepQuery(tool) {
  const input = tool?.input && typeof tool.input === 'object' ? tool.input : {};
  return oneLine(input.pattern || input.query || '', 32);
}

function namedKindPhrase(kind, tools, t) {
  if (kind === 'grep') {
    const query = tools.map(grepQuery).find(Boolean);
    if (query) return t('tool_sum_grep_named', { query });
    return countPhrase(tools, t);
  }
  if (kind === 'read' || kind === 'ls') {
    const names = uniqueFileNames(tools);
    if (!names.length) return countPhrase(tools, t);
    const shown = names.slice(0, NAMED_KIND_LIMIT);
    const joined = shown.join(t('tool_sum_names_join'));
    if (tools.length > shown.length) {
      return t(`tool_sum_${kind}_named_more`, { names: joined, n: tools.length });
    }
    return t(`tool_sum_${kind}_named`, { names: joined });
  }
  return countPhrase(tools, t);
}

function namedCountClause(tools, t) {
  const rest = tools.filter((tool) => {
    if (isCallFailed(tool)) return false;
    return COUNT_KINDS.has(toolKind(tool?.name));
  });
  if (!rest.length) return '';
  const order = [];
  const groups = new Map();
  for (const tool of rest) {
    const kind = toolKind(tool?.name);
    const key = kind === 'other' ? `other:${tool?.name || 'tool'}` : kind;
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key).push(tool);
  }
  return order.map((key) => {
    const kind = key.startsWith('other:') ? 'other' : key;
    return namedKindPhrase(kind, groups.get(key), t);
  }).join(t('tool_sum_join'));
}

function richSummary(list, t) {
  if (list.length === 1) {
    const tool = list[0];
    if (toolStatusBucket(tool.status) === 'failed') return failedPhrase(tool, t);
    const intent = toolIntent(tool);
    if (intent) return intent;
    const kind = toolKind(tool?.name);
    if (CHANGE_KINDS.has(kind)) return changedClause(list, t) || singlePhrase(tool, t);
    if (kind === 'bash') return commandClause(list, t) || singlePhrase(tool, t);
    return singlePhrase(tool, t);
  }
  const clauses = [changedClause(list, t), failedClause(list, t), commandClause(list, t), namedCountClause(list, t)]
    .filter(Boolean);
  if (!clauses.length) return countPhrase(list, t);
  return clauses.join(t('tool_sum_join'));
}

export function summarizeToolGroup(tools, t) {
  const list = (Array.isArray(tools) ? tools : []).filter(Boolean);
  const failed = list.filter((tool) => isRealToolFailure(tool, list)).length;
  let runningTool = null;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (toolStatusBucket(list[i].status) === 'running') {
      runningTool = list[i];
      break;
    }
  }
  let text = '';
  if (runningTool) text = runningPhrase(runningTool, t);
  else if (list.length) text = richSummary(list, t);
  return {
    text: presentSummary(text),
    failed,
    running: Boolean(runningTool),
  };
}

export function toolGroupPreview(tools, showAll = false, limit = TOOL_GROUP_PREVIEW) {
  const list = (Array.isArray(tools) ? tools : []).filter(Boolean);
  if (showAll || list.length <= limit) return { tools: list, hidden: 0 };
  return {
    tools: list.slice(-limit),
    hidden: list.length - limit,
  };
}

function nonemptyLines(text) {
  const raw = String(text ?? '');
  if (!raw) return [];
  return raw.split(/\r?\n/).filter((line) => line.length > 0);
}

export function outputLineCount(text) {
  const raw = String(text ?? '');
  if (!raw) return 0;
  const lines = raw.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

export function parseToolOutput(output) {
  if (output == null || output === '') return { text: '', json: null };
  if (typeof output === 'object') {
    return { text: JSON.stringify(output), json: output };
  }
  const text = String(output);
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const json = JSON.parse(trimmed);
      if (json && typeof json === 'object') return { text, json };
    } catch {
      /* keep as text */
    }
  }
  return { text, json: null };
}

const HARNESS_TAG = /^<\/?harness>$/;
const HARNESS_SEVERITY = /^\[(error|warn|warning|info)\]\s+/i;

/**
 * Pi Durable appends diagnostics as:
 *   <harness>
 *   [error] ENOENT: ...
 *   </harness>
 * Drop the wrapper lines and the severity prefix. Text without that wrapper is unchanged.
 */
export function unwrapHarnessDiagnostics(text) {
  const raw = text == null ? '' : String(text);
  const lines = raw.split(/\r?\n/);
  if (!lines.some((line) => line.trim() === '<harness>')) return raw;
  const out = [];
  let inside = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (HARNESS_TAG.test(trimmed)) {
      inside = trimmed === '<harness>';
      continue;
    }
    out.push(inside ? line.replace(HARNESS_SEVERITY, '') : line);
  }
  while (out.length && out[0] === '') out.shift();
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}

function firstLine(text, max = 72) {
  const line = String(text ?? '').split(/\r?\n/).find((item) => item.trim()) || '';
  return oneLine(line, max);
}

function bashStreams(tool) {
  const parsed = parseToolOutput(tool?.output);
  const json = parsed.json && typeof parsed.json === 'object' ? parsed.json : null;
  const stdout = json && json.stdout != null ? String(json.stdout) : '';
  const stderr = json && json.stderr != null ? String(json.stderr) : '';
  const code = json && json.code != null
    ? json.code
    : (tool?.code != null ? tool.code : null);
  return { parsed, json, stdout, stderr, code };
}

function bashNonZero(tool) {
  if (toolKind(tool?.name) !== 'bash') return false;
  const { code } = bashStreams(tool);
  if (code == null || code === '') return false;
  return Number(code) !== 0;
}

function isCallFailed(tool) {
  return toolStatusBucket(tool?.status) === 'failed' || bashNonZero(tool);
}

function isCallSuccessful(tool) {
  return toolStatusBucket(tool?.status) === 'done' && !bashNonZero(tool);
}

function indexInGroup(tool, list) {
  const direct = list.indexOf(tool);
  if (direct >= 0) return direct;
  if (tool?.id == null || String(tool.id) === '') return -1;
  return list.findIndex((item) => item && item.id === tool.id);
}

/**
 * A failed read/ls/grep is a probe when a later call in the same group succeeded.
 * Write/edit/bash failures, a non-zero bash exit, and the group's last failure are real.
 */
export function isProbeFailure(tool, tools) {
  if (!isCallFailed(tool)) return false;
  if (!PROBE_KINDS.has(toolKind(tool?.name))) return false;
  const list = Array.isArray(tools) ? tools.filter(Boolean) : [];
  const index = indexInGroup(tool, list);
  if (index < 0 || index === list.length - 1) return false;
  return list.slice(index + 1).some(isCallSuccessful);
}

export function isRealToolFailure(tool, tools) {
  return isCallFailed(tool) && !isProbeFailure(tool, tools);
}

/** Short result hint shown on a row without expanding it. */
export function toolResultHint(tool, t, options = {}) {
  if (!tool) return { text: '', failed: false };
  const workspacePath = options.workspacePath || '';
  const bucket = toolStatusBucket(tool.status);
  const parsed = parseToolOutput(tool.output);
  const json = parsed.json && typeof parsed.json === 'object' ? parsed.json : null;
  const failText = json
    ? String(json.stderr || json.message || json.error || json.stdout || parsed.text || '')
    : parsed.text;

  if (bucket === 'failed' || bashNonZero(tool)) {
    const unwrapped = relativizeText(unwrapHarnessDiagnostics(failText || parsed.text), workspacePath);
    const short = shortErrorHint(unwrapped, t);
    return { text: short || firstLine(unwrapped, 64), failed: true };
  }
  if (bucket === 'running') return { text: '', failed: false };

  const kind = toolKind(tool?.name);
  if (kind === 'read') {
    return { text: t('tool_hint_lines', { n: outputLineCount(parsed.text) }), failed: false };
  }
  if (kind === 'ls') {
    return { text: t('tool_hint_items', { n: nonemptyLines(parsed.text).length }), failed: false };
  }
  if (kind === 'grep') {
    return { text: t('tool_hint_matches', { n: nonemptyLines(parsed.text).length }), failed: false };
  }
  if (kind === 'bash') {
    const { stdout, stderr, code } = bashStreams(tool);
    if (code != null && code !== '') {
      return { text: t('tool_hint_exit', { code }), failed: Number(code) !== 0 };
    }
    const line = firstLine(stdout || stderr || parsed.text, 48);
    return { text: line, failed: false };
  }
  return { text: '', failed: false };
}

/** Keep the first `limit` lines unless the caller asked for the full text. */
export function clipOutputText(text, showAll, limit = 20) {
  const raw = text == null ? '' : String(text);
  if (showAll) return { text: raw, clipped: false };
  const lines = raw.split(/\r?\n/);
  if (lines.length <= limit) return { text: raw, clipped: false };
  return { text: lines.slice(0, limit).join('\n'), clipped: true };
}

/** Badge numbers from the tool, or from `wrote path (+N −M)` when the payload omitted them. */
export function toolDiffCounts(tool) {
  if (!tool) return { added: null, removed: null };
  if (tool.added != null || tool.removed != null) {
    return {
      added: tool.added != null ? tool.added : null,
      removed: tool.removed != null ? tool.removed : null,
    };
  }
  const output = typeof tool.output === 'string' ? tool.output : '';
  const match = output.match(/\(\+(\d+)\s*[−-]\s*(\d+)\)/);
  if (!match) return { added: null, removed: null };
  return { added: Number(match[1]), removed: Number(match[2]) };
}
