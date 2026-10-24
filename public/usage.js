// Shared by the browser composer and the Node runtime.
// Counts come only from provider-reported usage. Nothing here estimates tokens.

const EMPTY = '—';

const INPUT_KEYS = ['input', 'inputTokens', 'input_tokens', 'prompt_tokens', 'promptTokens'];
const OUTPUT_KEYS = ['output', 'outputTokens', 'output_tokens', 'completion_tokens', 'completionTokens'];
const CACHE_READ_KEYS = ['cacheRead', 'cache_read', 'cache_read_input_tokens'];
const CACHE_WRITE_KEYS = ['cacheWrite', 'cache_write', 'cache_creation_input_tokens'];
const TOTAL_KEYS = ['total', 'totalTokens', 'total_tokens'];
const WINDOW_KEYS = ['contextWindow', 'context_window'];

function finiteToken(v) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
  return v;
}

function firstNum(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
    const n = finiteToken(obj[key]);
    if (n != null) return n;
  }
  return null;
}

function positiveToken(v) {
  const n = finiteToken(v);
  if (n == null || n <= 0) return null;
  return n;
}

function blankUsage() {
  return { input: null, output: null, cacheRead: null, cacheWrite: null, total: null, any: false };
}

function addToken(acc, field, n) {
  if (n == null) return;
  acc[field] = (acc[field] ?? 0) + n;
  acc.any = true;
}

function sumModels(models) {
  if (!models || typeof models !== 'object' || Array.isArray(models)) return null;
  const acc = blankUsage();
  for (const model of Object.values(models)) {
    if (!model || typeof model !== 'object') continue;
    addToken(acc, 'input', firstNum(model, INPUT_KEYS));
    addToken(acc, 'output', firstNum(model, OUTPUT_KEYS));
    addToken(acc, 'cacheRead', firstNum(model, CACHE_READ_KEYS));
    addToken(acc, 'cacheWrite', firstNum(model, CACHE_WRITE_KEYS));
    addToken(acc, 'total', firstNum(model, TOTAL_KEYS));
  }
  return acc.any ? acc : null;
}

function usageFromParts(input, output, cacheRead, cacheWrite, total, contextWindow) {
  if (input == null && output == null && cacheRead == null && cacheWrite == null && total == null) return null;
  const usage = {};
  if (input != null) usage.input = input;
  if (output != null) usage.output = output;
  if (cacheRead != null) usage.cacheRead = cacheRead;
  if (cacheWrite != null) usage.cacheWrite = cacheWrite;
  if (total != null) usage.total = total;
  if (contextWindow != null) usage.contextWindow = contextWindow;
  return usage;
}

function pickUsage(src) {
  if (!src || typeof src !== 'object' || Array.isArray(src)) return null;
  const contextWindow = positiveToken(firstNum(src, WINDOW_KEYS));
  const top = usageFromParts(
    firstNum(src, INPUT_KEYS),
    firstNum(src, OUTPUT_KEYS),
    firstNum(src, CACHE_READ_KEYS),
    firstNum(src, CACHE_WRITE_KEYS),
    firstNum(src, TOTAL_KEYS),
    contextWindow,
  );
  if (top) return top;
  const summed = sumModels(src.models);
  if (!summed) return null;
  return usageFromParts(summed.input, summed.output, summed.cacheRead, summed.cacheWrite, summed.total, contextWindow);
}

/** Latest provider usage object, or null when the payload has no token counts. */
export function normalizeUsage(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return pickUsage(raw) || (raw.usage ? pickUsage(raw.usage) : null);
}

/** Attach normalized usage onto an LLM action. Leaves the action unchanged when absent. */
export function attachUsage(action, raw) {
  if (!action || typeof action !== 'object') return action;
  const usage = normalizeUsage(raw);
  if (usage) action.usage = usage;
  return action;
}

/**
 * Tokens occupying the context window for the latest model call.
 * Prefers the provider total. Otherwise sums only the counts that were present.
 */
export function contextUsed(usage) {
  const normalized = normalizeUsage(usage);
  if (!normalized) return null;
  if (normalized.total != null) return normalized.total;
  const parts = [normalized.input, normalized.output, normalized.cacheRead, normalized.cacheWrite]
    .filter((n) => n != null);
  if (!parts.length) return null;
  return parts.reduce((sum, n) => sum + n, 0);
}

/** Configured window (`LLM_CONTEXT_WINDOW`, default 128000). Not a measured quota. */
export function contextWindowFromEnv(env = process.env) {
  const raw = env?.LLM_CONTEXT_WINDOW;
  if (raw == null || raw === '') return 128000;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return n;
  return 128000;
}

function trimScaled(rounded) {
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function scale(value, div) {
  const scaled = value / div;
  return scaled >= 100 ? Math.round(scaled) : Math.round(scaled * 10) / 10;
}

/** Human token count: `999`, `1.2k`, `128k`, `1.5M`. */
export function formatTokenCount(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return null;
  if (v < 1000) return String(Math.round(v));
  if (v >= 1e9) return `${trimScaled(scale(v, 1e9))}B`;
  if (v >= 1e6 || scale(v, 1e3) >= 1000) return `${trimScaled(scale(v, 1e6))}M`;
  return `${trimScaled(scale(v, 1e3))}k`;
}

/**
 * Composer value. `—` when used tokens are unknown.
 * Window comes from the usage payload when the provider sent one, otherwise from the argument.
 */
export function formatContextValue(usage, contextWindow) {
  const normalized = normalizeUsage(usage);
  const used = contextUsed(normalized);
  if (used == null) return EMPTY;
  const usedText = formatTokenCount(used);
  if (!usedText) return EMPTY;
  const window = normalized?.contextWindow ?? positiveToken(typeof contextWindow === 'number' ? contextWindow : Number(contextWindow));
  if (window == null) return usedText;
  const windowText = formatTokenCount(window);
  if (!windowText) return usedText;
  return `${usedText} / ${windowText}`;
}

/** API/SSE shape: normalized usage, window, and the chip text. */
export function presentContext(usage, env = process.env) {
  const normalized = normalizeUsage(usage);
  const contextWindow = normalized?.contextWindow || contextWindowFromEnv(env);
  return {
    usage: normalized,
    contextWindow,
    contextLabel: formatContextValue(normalized, contextWindow),
  };
}

/** Chip text for the active conversation. No conversation, or no usage, stays `—`. */
export function composerContextText(conv) {
  if (!conv) return EMPTY;
  return formatContextValue(conv.usage, conv.contextWindow);
}

export const DEFAULT_CONTEXT_WINDOW = 128000;

/** Composer menu / settings presets. */
export const CONTEXT_WINDOW_PRESETS = [32000, 64000, 128000, 200000, 256000, 400000, 1_000_000];

function contextWindowMap(source) {
  const map = source?.contextWindows;
  if (!map || typeof map !== 'object' || Array.isArray(map)) return null;
  return map;
}

/** Source default when the user has not overridden a model. Prefers per-model catalog values. */
export function sourceDefaultContextWindow(source, model) {
  const name = typeof model === 'string' ? model.trim() : '';
  const map = source?.defaultContextWindows;
  if (name && map && typeof map === 'object' && !Array.isArray(map)
    && Object.prototype.hasOwnProperty.call(map, name)) {
    const n = positiveToken(map[name]);
    if (n != null) return n;
  }
  return positiveToken(source?.defaultContextWindow) ?? DEFAULT_CONTEXT_WINDOW;
}

/** `contextWindows[model]` when the user set one, otherwise the source default. */
export function sourceModelContextWindow(source, model) {
  const name = typeof model === 'string' ? model.trim() : '';
  const map = contextWindowMap(source);
  if (name && map && Object.prototype.hasOwnProperty.call(map, name)) {
    const n = positiveToken(map[name]);
    if (n != null) return n;
  }
  return sourceDefaultContextWindow(source, name);
}

export function hasCustomContextWindow(source, model) {
  const name = typeof model === 'string' ? model.trim() : '';
  const map = contextWindowMap(source);
  if (!name || !map || !Object.prototype.hasOwnProperty.call(map, name)) return false;
  return positiveToken(map[name]) != null;
}

/** Page-local override key. Two sources can share a model name. */
export function contextOverrideKey(sourceId, model) {
  const sid = typeof sourceId === 'string' ? sourceId.trim() : '';
  const name = typeof model === 'string' ? model.trim() : '';
  if (!sid || !name) return '';
  return `${sid}\x1f${name}`;
}

export function parseContextOverrideKey(key) {
  const text = typeof key === 'string' ? key : '';
  const i = text.indexOf('\x1f');
  if (i < 1) return null;
  const sourceId = text.slice(0, i);
  const model = text.slice(i + 1);
  if (!sourceId || !model) return null;
  return { sourceId, model };
}

function overrideFor(overrides, source, model) {
  const sid = typeof source?.id === 'string' ? source.id : '';
  const key = contextOverrideKey(sid, model);
  if (!key || !overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return { present: false };
  if (!Object.prototype.hasOwnProperty.call(overrides, key)) return { present: false };
  return { present: true, value: overrides[key] };
}

/**
 * Window for the composer chip.
 * Page-local override (including restore-to-default) wins, then the conversation
 * window when it still belongs to this model, then settings.
 */
export function resolveContextWindow({
  model,
  source,
  conversationWindow,
  conversationWindowModel,
  overrides,
} = {}) {
  const name = typeof model === 'string' ? model.trim() : '';
  const local = overrideFor(overrides, source, name);
  if (local.present) return positiveToken(local.value) ?? sourceModelContextWindow(source, name);
  const belongs = !conversationWindowModel || !name || String(conversationWindowModel) === name;
  if (belongs) {
    const fromConv = positiveToken(conversationWindow);
    if (fromConv != null) return fromConv;
  }
  return sourceModelContextWindow(source, name);
}

/** Rounded percents that always sum to 100. Missing used tokens count as 0. */
export function contextPercents(used, window) {
  const w = positiveToken(window) ?? DEFAULT_CONTEXT_WINDOW;
  const u = finiteToken(used) ?? 0;
  const ratio = w > 0 ? Math.min(1, u / w) : 0;
  const usedPct = Math.min(100, Math.round(ratio * 100));
  return { usedPct, remainPct: 100 - usedPct, ratio };
}

/**
 * Numbers for the composer chip. No usage still shows 0% / 100% and the window.
 * `warn` is true when used percent is at least 80.
 */
export function composerContextChip({ usage, window } = {}) {
  const used = contextUsed(usage);
  const w = positiveToken(window) ?? DEFAULT_CONTEXT_WINDOW;
  const tokens = used == null ? 0 : used;
  const { usedPct, remainPct, ratio } = contextPercents(tokens, w);
  return {
    used: tokens,
    remain: Math.max(0, w - tokens),
    window: w,
    usedPct,
    remainPct,
    ratio,
    warn: usedPct >= 80,
    usedText: formatTokenCount(tokens) || '0',
    remainText: formatTokenCount(Math.max(0, w - tokens)) || '0',
    windowText: formatTokenCount(w) || String(w),
  };
}

export function contextWindowPresetOptions(current) {
  const n = positiveToken(current);
  const rows = CONTEXT_WINDOW_PRESETS.map((tokens) => ({
    tokens,
    label: formatTokenCount(tokens),
    selected: n != null && n === tokens,
  }));
  if (n != null && !CONTEXT_WINDOW_PRESETS.includes(n)) {
    rows.push({ tokens: n, label: formatTokenCount(n), selected: true, custom: true });
  }
  return rows;
}
