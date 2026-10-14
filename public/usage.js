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
