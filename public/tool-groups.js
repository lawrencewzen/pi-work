/** Consecutive tool-call grouping and summary text. No DOM. */

const KINDS = new Set(['read', 'write', 'edit', 'ls', 'grep', 'bash']);

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

function singlePhrase(tool, t) {
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

export function summarizeToolGroup(tools, t) {
  const list = (Array.isArray(tools) ? tools : []).filter(Boolean);
  const failed = list.filter((tool) => toolStatusBucket(tool.status) === 'failed').length;
  let runningTool = null;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (toolStatusBucket(list[i].status) === 'running') {
      runningTool = list[i];
      break;
    }
  }
  let text = '';
  if (runningTool) text = runningPhrase(runningTool, t);
  else if (list.length === 1) text = singlePhrase(list[0], t);
  else if (list.length > 1) text = countPhrase(list, t);
  return {
    text: presentSummary(text),
    failed,
    running: Boolean(runningTool),
  };
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
