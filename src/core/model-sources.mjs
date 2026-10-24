import { randomBytes } from 'node:crypto';
import { maskApiKey, isMaskedOrEmptyApiKey } from './settings.mjs';
import { redactAuthText, GROK_SESSION_MODEL } from './grok-auth.mjs';
import { contextWindowFromEnv } from './usage.mjs';
import { catalogContextWindow, lookupModelCatalog } from '../kernel/model-catalog.mjs';

/** OpenAI-compatible vendors. Ollama is the only preset that does not need a key. */
export const VENDOR_PRESETS = [
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', needsKey: true },
  { id: 'xai', name: 'xAI', baseUrl: 'https://api.x.ai/v1', needsKey: true },
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', needsKey: true },
  { id: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', needsKey: true },
  { id: 'gemini', name: 'Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', needsKey: true },
  { id: 'qwen', name: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', needsKey: true },
  { id: 'moonshot', name: 'Kimi', baseUrl: 'https://api.moonshot.cn/v1', needsKey: true },
  { id: 'zhipu', name: '智谱', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', needsKey: true },
  { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', needsKey: true },
  { id: 'ollama', name: '本地 Ollama', baseUrl: 'http://127.0.0.1:11434/v1', needsKey: false },
  { id: 'custom', name: '自定义 API', baseUrl: '', needsKey: true },
];

export const GROK_SOURCE_ID = 'grok';
export const SETTINGS_VERSION = 2;

const SOURCE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/;
const BLOCKED_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const CONTEXT_WINDOW_MIN = 1000;
const CONTEXT_WINDOW_MAX = 10_000_000;

export function createSourceId() {
  return randomBytes(4).toString('hex');
}

export function vendorPreset(id) {
  const key = String(id || '').trim().toLowerCase();
  return VENDOR_PRESETS.find((item) => item.id === key) || null;
}

export function normalizeHttpUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  let url;
  try { url = new URL(text); } catch { return ''; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}

export function vendorForBaseUrl(baseUrl) {
  const url = normalizeHttpUrl(baseUrl);
  if (!url) return null;
  return VENDOR_PRESETS.find((item) => item.baseUrl && normalizeHttpUrl(item.baseUrl) === url) || null;
}

function cleanName(value, fallback) {
  const name = String(value ?? '').trim().slice(0, 80);
  return name || fallback;
}

/** @returns {string[]|null} null when the input is not a string array */
export function normalizeModelList(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) return null;
  const out = [];
  for (const item of value) {
    if (typeof item !== 'string') return null;
    const name = item.trim().slice(0, 200);
    if (!name || out.includes(name)) continue;
    if (out.length >= 100) break;
    out.push(name);
  }
  return out;
}

export function isValidContextWindow(value) {
  return Number.isInteger(value) && value >= CONTEXT_WINDOW_MIN && value <= CONTEXT_WINDOW_MAX;
}

/**
 * User-overridden token windows keyed by trimmed model name.
 * Illegal entries are dropped. Returns undefined when nothing remains.
 */
export function normalizeContextWindows(value) {
  if (value == null) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out = {};
  for (const [rawName, raw] of Object.entries(value)) {
    if (BLOCKED_KEYS.has(rawName)) continue;
    const name = String(rawName).trim();
    if (!name || BLOCKED_KEYS.has(name) || Object.prototype.hasOwnProperty.call(out, name)) continue;
    if (!isValidContextWindow(raw)) continue;
    out[name] = raw;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Merge a PATCH body onto stored windows. `null` deletes a name.
 * Invalid shape or values return `{ error: 'invalid context window' }`.
 */
export function mergeContextWindows(current, patch) {
  if (patch == null || typeof patch !== 'object' || Array.isArray(patch)) {
    return { error: 'invalid context window' };
  }
  const next = { ...(normalizeContextWindows(current) || {}) };
  for (const [rawName, raw] of Object.entries(patch)) {
    if (BLOCKED_KEYS.has(rawName)) return { error: 'invalid context window' };
    const name = String(rawName).trim();
    if (!name || BLOCKED_KEYS.has(name)) return { error: 'invalid context window' };
    if (raw === null) {
      delete next[name];
      continue;
    }
    if (!isValidContextWindow(raw)) return { error: 'invalid context window' };
    next[name] = raw;
  }
  return { contextWindows: Object.keys(next).length ? next : undefined };
}

function lookupUrlForSource(source, lookupUrl) {
  if (lookupUrl != null && String(lookupUrl).trim()) return String(lookupUrl).trim();
  if (!source || source.kind === 'grok') return '';
  return effectiveBaseUrl(source) || source.baseUrl || '';
}

function defaultContextWindowForModel(modelName, baseUrl, env = process.env) {
  const fromCatalog = catalogContextWindow(lookupModelCatalog(modelName, baseUrl));
  if (fromCatalog != null) return fromCatalog;
  return contextWindowFromEnv(env);
}

/** User override, else pi-ai catalog, else `LLM_CONTEXT_WINDOW` / 128000. */
export function contextWindowForModel(source, modelName, env = process.env, lookupUrl) {
  const name = typeof modelName === 'string' ? modelName.trim() : '';
  const windows = source?.contextWindows;
  if (name && windows && typeof windows === 'object' && !Array.isArray(windows)
    && Object.prototype.hasOwnProperty.call(windows, name)
    && isValidContextWindow(windows[name])) {
    return windows[name];
  }
  return defaultContextWindowForModel(name, lookupUrlForSource(source, lookupUrl), env);
}

/** Per-model catalog/env defaults for settings UI restore. */
export function defaultContextWindowsForSource(source, env = process.env) {
  const normalized = source && typeof source === 'object' ? source : {};
  const names = Array.isArray(normalized.models) ? normalized.models : [];
  const baseUrl = lookupUrlForSource(normalized);
  const out = {};
  for (const raw of names) {
    const name = typeof raw === 'string' ? raw.trim() : '';
    if (!name || Object.prototype.hasOwnProperty.call(out, name)) continue;
    out[name] = defaultContextWindowForModel(name, baseUrl, env);
  }
  return out;
}

/**
 * Same source+model pair `modelFor` uses, without the Grok token check.
 * Missing or unavailable sources return null.
 */
export function resolveConversationTarget(settings, conv, { grokSignedIn = false } = {}) {
  const sourceId = typeof conv?.modelSourceId === 'string' ? conv.modelSourceId.trim() : '';
  const modelId = typeof conv?.modelId === 'string' ? conv.modelId.trim() : '';
  let target = null;
  if (sourceId && modelId) {
    const source = normalizeSources(settings?.sources).find((item) => item.id === sourceId);
    if (source && sourceAvailable(source, { grokSignedIn })) {
      target = { source, model: modelId };
    }
  }
  if (!target) target = resolveRoleTarget(settings, { grokSignedIn });
  if (!target?.source || !target.model) return null;
  return target;
}

/** Configured window for a conversation's resolved model, or null when none. */
export function contextWindowForConversation(settings, conv, { grokSignedIn = false, env = process.env } = {}) {
  const target = resolveConversationTarget(settings, conv, { grokSignedIn });
  if (!target) return null;
  return contextWindowForModel(target.source, target.model, env);
}

/**
 * Enabled names after a successful source-row probe.
 * A refresh never drops a name the user already enabled (including ones typed in by hand).
 * An empty enabled list takes the whole fetched list.
 * An existing list stays as-is; `catalog` is the full fetch so the edit drawer can check new names.
 */
export function modelsAfterProbe(current, fetched) {
  const enabled = normalizeModelList(current) || [];
  const found = normalizeModelList(fetched) || [];
  if (!enabled.length) return { models: found, catalog: found.slice() };
  return { models: enabled.slice(), catalog: found.slice() };
}

const PROBE_CODES = new Set(['network', 'timeout', 'bad_json', 'auth', 'not_found', 'http']);

function probeStatus(value) {
  const status = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(status) || status < 100 || status > 599) return 0;
  return status;
}

export function probeFailurePayload(result) {
  const body = { ok: false, error: String(result?.error || 'request failed') };
  if (PROBE_CODES.has(result?.code)) body.code = result.code;
  const status = probeStatus(result?.status);
  if (status) body.status = status;
  return body;
}

function normalizeLastTest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const at = typeof value.at === 'string' ? value.at.trim().slice(0, 40) : '';
  if (!at) return undefined;
  const last = { ok: value.ok === true, at };
  if (!last.ok && value.error != null) {
    const error = redactAuthText(value.error).trim();
    if (error) last.error = error.slice(0, 500);
  }
  if (!last.ok && PROBE_CODES.has(value.code)) last.code = value.code;
  if (!last.ok) {
    const status = probeStatus(value.status);
    if (status) last.status = status;
  }
  return last;
}

function blankSource(partial) {
  const lastTest = normalizeLastTest(partial.lastTest);
  const source = {
    id: partial.id,
    kind: partial.kind,
    vendor: partial.vendor,
    name: partial.name,
    baseUrl: partial.baseUrl || '',
    apiKey: partial.apiKey || '',
    models: partial.models || [],
  };
  if (lastTest) source.lastTest = lastTest;
  const catalog = normalizeModelList(partial.catalog);
  if (catalog?.length) source.catalog = catalog;
  const contextWindows = normalizeContextWindows(partial.contextWindows);
  if (contextWindows) source.contextWindows = contextWindows;
  return source;
}

export function normalizeSources(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  let grokSeen = false;
  for (const item of list) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const kind = item.kind === 'grok' || item.id === GROK_SOURCE_ID ? 'grok' : 'api';
    if (kind === 'grok') {
      if (grokSeen) continue;
      grokSeen = true;
      const models = normalizeModelList(item.models) || [];
      out.push(blankSource({
        id: GROK_SOURCE_ID,
        kind: 'grok',
        vendor: 'grok',
        name: cleanName(item.name, 'Grok 订阅'),
        baseUrl: '',
        apiKey: '',
        models: models.length ? models : [GROK_SESSION_MODEL],
        lastTest: item.lastTest,
        catalog: item.catalog,
        contextWindows: item.contextWindows,
      }));
      continue;
    }
    const id = String(item.id || '').trim();
    if (!SOURCE_ID.test(id) || id === GROK_SOURCE_ID) continue;
    if (out.some((source) => source.id === id)) continue;
    const vendor = vendorPreset(item.vendor)?.id || String(item.vendor || 'custom').trim().toLowerCase().slice(0, 32) || 'custom';
    const models = normalizeModelList(item.models) || [];
    const baseUrl = normalizeHttpUrl(item.baseUrl);
    out.push(blankSource({
      id,
      kind: 'api',
      vendor,
      name: cleanName(item.name, vendorPreset(vendor)?.name || vendor),
      baseUrl,
      apiKey: typeof item.apiKey === 'string' ? item.apiKey : '',
      models,
      lastTest: item.lastTest,
      catalog: item.catalog,
      contextWindows: item.contextWindows,
    }));
  }
  return out;
}

export function normalizeRoleModels(models) {
  if (!models || typeof models !== 'object' || Array.isArray(models)) return {};
  const value = models.default;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const sourceId = typeof value.sourceId === 'string' ? value.sourceId.trim() : '';
  const model = typeof value.model === 'string' ? value.model.trim() : '';
  if (!sourceId || !model) return {};
  return { default: { sourceId, model: model.slice(0, 200) } };
}

export function publicSource(source, grokStatus) {
  const normalized = normalizeSources([source])[0];
  if (!normalized) return null;
  const body = {
    id: normalized.id,
    kind: normalized.kind,
    vendor: normalized.vendor,
    name: normalized.name,
    baseUrl: normalized.baseUrl,
    apiKey: maskApiKey(normalized.apiKey),
    hasApiKey: Boolean(normalized.apiKey),
    models: [...normalized.models],
  };
  if (normalized.catalog?.length) body.catalog = [...normalized.catalog];
  if (normalized.lastTest) body.lastTest = { ...normalized.lastTest };
  if (normalized.contextWindows) body.contextWindows = { ...normalized.contextWindows };
  body.defaultContextWindow = contextWindowFromEnv();
  body.defaultContextWindows = defaultContextWindowsForSource(normalized);
  if (normalized.kind === 'grok') {
    body.session = {
      signedIn: Boolean(grokStatus?.signedIn),
      email: grokStatus?.email ?? null,
      expiresAt: grokStatus?.expiresAt ?? null,
    };
  }
  return body;
}

function legacyDefaultModel(models) {
  if (!models || typeof models !== 'object' || Array.isArray(models)) return '';
  if (typeof models.default !== 'string') return '';
  return models.default.trim().slice(0, 200);
}

/**
 * A leftover provider row becomes an API source only when it was actually configured:
 * a key, an Ollama base URL, or a base URL that is not that vendor's preset.
 */
function wantsLegacyApiSource(provider, baseUrl, apiKey) {
  if (String(apiKey || '').trim()) return true;
  const url = normalizeHttpUrl(baseUrl);
  if (String(provider || '').trim().toLowerCase() === 'ollama' && url) return true;
  if (!url) return false;
  const presetUrl = normalizeHttpUrl(vendorPreset(provider)?.baseUrl);
  return url !== presetUrl;
}

function httpOrigin(value) {
  const normalized = normalizeHttpUrl(value);
  if (!normalized) return '';
  try { return new URL(normalized).origin; } catch { return ''; }
}

function pushModel(source, model) {
  if (!source.models.includes(model)) source.models.push(model);
}

/**
 * One-shot upgrade from the single provider/baseUrl/apiKey record.
 * Already-versioned settings are returned unchanged.
 * Pass `createId` to keep the function deterministic.
 */
export function migrateLegacySettings(raw, { grokSignedIn = false, createId = createSourceId } = {}) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : {};
  if (input.version === SETTINGS_VERSION) return input;
  delete input.grok;

  const provider = typeof input.provider === 'string' ? input.provider.trim() : '';
  const baseUrl = typeof input.baseUrl === 'string' ? input.baseUrl.trim() : '';
  const apiKey = typeof input.apiKey === 'string' ? input.apiKey : '';
  const sources = [];
  let apiSource = null;
  if (wantsLegacyApiSource(provider, baseUrl, apiKey)) {
    const preset = vendorPreset(provider);
    const vendor = preset?.id || (provider ? provider.toLowerCase().slice(0, 32) : 'custom');
    let id = createId();
    if (!SOURCE_ID.test(id) || id === GROK_SOURCE_ID) id = createSourceId();
    const storedUrl = normalizeHttpUrl(baseUrl) || (preset && preset.id !== 'custom' ? preset.baseUrl : '');
    apiSource = {
      id,
      kind: 'api',
      vendor,
      name: preset?.name || provider || '自定义 API',
      baseUrl: storedUrl,
      apiKey,
      models: [],
    };
    sources.push(apiSource);
  }
  let grokSource = null;
  if (grokSignedIn) {
    grokSource = {
      id: GROK_SOURCE_ID,
      kind: 'grok',
      vendor: 'grok',
      name: 'Grok 订阅',
      baseUrl: '',
      apiKey: '',
      models: [GROK_SESSION_MODEL],
    };
    sources.unshift(grokSource);
  }
  const target = grokSignedIn ? grokSource : apiSource;
  const models = {};
  if (target) {
    const model = legacyDefaultModel(input.models);
    if (model) {
      pushModel(target, model);
      models.default = { sourceId: target.id, model };
    }
  }
  return {
    ...input,
    version: SETTINGS_VERSION,
    provider: 'openai',
    baseUrl: '',
    apiKey: '',
    sources,
    models,
  };
}

export function sourceNeedsKey(source) {
  if (!source || source.kind === 'grok') return false;
  const preset = vendorPreset(source.vendor);
  if (preset) return preset.needsKey !== false;
  return true;
}

export function effectiveBaseUrl(source) {
  if (!source || source.kind === 'grok') return '';
  const stored = normalizeHttpUrl(source.baseUrl);
  if (stored) return stored;
  const preset = vendorPreset(source.vendor);
  if (preset && preset.id !== 'custom') return preset.baseUrl;
  return '';
}

export function sourceAvailable(source, { grokSignedIn = false } = {}) {
  if (!source) return false;
  if (source.kind === 'grok') return Boolean(grokSignedIn);
  if (sourceNeedsKey(source) && !String(source.apiKey || '').trim()) return false;
  return Boolean(effectiveBaseUrl(source));
}

export function hasAvailableSource(settings, options) {
  return normalizeSources(settings?.sources).some((source) => sourceAvailable(source, options));
}

function bindingTarget(sources, binding, options) {
  if (!binding) return null;
  const source = sources.find((item) => item.id === binding.sourceId);
  if (!source || !sourceAvailable(source, options)) return null;
  if (!binding.model) return null;
  return { source, model: binding.model };
}

function textOrNull(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

/**
 * Optional conversation-level model from a create/PATCH body.
 * Missing keys mean the request does not touch the stored pair. Both empty
 * or null means follow settings.models.default. A source+model pair must
 * exist on settings.sources (availability is checked later by modelFor).
 */
export function resolveConversationModelPatch(settings, body = {}) {
  if (!body || typeof body !== 'object') return { present: false };
  const hasSource = Object.prototype.hasOwnProperty.call(body, 'modelSourceId');
  const hasModel = Object.prototype.hasOwnProperty.call(body, 'modelId');
  if (!hasSource && !hasModel) return { present: false };
  const sourceId = hasSource ? textOrNull(body.modelSourceId) : null;
  const modelId = hasModel ? textOrNull(body.modelId) : null;
  if (!sourceId && !modelId) {
    return { present: true, ok: true, value: { modelSourceId: null, modelId: null } };
  }
  if (!sourceId || !modelId) {
    return { present: true, ok: false, errors: ['model source and model are required together'] };
  }
  const sources = normalizeSources(settings?.sources);
  const source = sources.find((item) => item.id === sourceId);
  if (!source) return { present: true, ok: false, errors: ['unknown model source'] };
  const names = Array.isArray(source.models) ? source.models : [];
  if (!names.includes(modelId)) return { present: true, ok: false, errors: ['unknown model'] };
  return { present: true, ok: true, value: { modelSourceId: source.id, modelId } };
}

/**
 * Default binding, then the first model on the first usable source.
 */
export function resolveRoleTarget(settings, { grokSignedIn = false } = {}) {
  const sources = normalizeSources(settings?.sources);
  const bindings = normalizeRoleModels(settings?.models);
  const options = { grokSignedIn };
  let resolved = bindingTarget(sources, bindings.default, options);
  if (!resolved) {
    for (const source of sources) {
      if (!sourceAvailable(source, options)) continue;
      const name = (source.models || []).find((item) => typeof item === 'string' && item.trim());
      if (!name) continue;
      resolved = { source, model: name.trim() };
      break;
    }
  }
  return resolved;
}

/**
 * What settings should show for the default model. `follow` is true when
 * settings.models.default is unset and the first usable source is used.
 */
export function effectiveModelFor(settings, { grokSignedIn = false } = {}) {
  const bindings = normalizeRoleModels(settings?.models);
  const own = bindings.default;
  if (own) return { sourceId: own.sourceId, model: own.model, follow: false };
  const resolved = resolveRoleTarget(settings, { grokSignedIn });
  if (!resolved) return { sourceId: null, model: null, follow: true };
  return { sourceId: resolved.source.id, model: resolved.model, follow: true };
}

export function validateRoleModels(settings, models) {
  if (!models || typeof models !== 'object' || Array.isArray(models)) return 'invalid model binding';
  if (!Object.prototype.hasOwnProperty.call(models, 'default')) return '';
  const value = models.default;
  if (value == null) return '';
  if (typeof value !== 'object' || Array.isArray(value)) return 'invalid model binding';
  const sources = normalizeSources(settings?.sources);
  const sourceId = typeof value.sourceId === 'string' ? value.sourceId.trim() : '';
  const model = typeof value.model === 'string' ? value.model.trim() : '';
  const source = sources.find((item) => item.id === sourceId);
  if (!source) return 'unknown source';
  if (!model || !(source.models || []).includes(model)) return 'model not in source';
  return '';
}

export function createApiSource(input = {}, createId = createSourceId) {
  const preset = vendorPreset(input?.vendor);
  if (!preset) return { error: 'unknown vendor' };
  const models = input?.models == null ? [] : normalizeModelList(input.models);
  if (!models) return { error: 'invalid models' };
  let baseUrl = '';
  if (input?.baseUrl != null && String(input.baseUrl).trim()) {
    baseUrl = normalizeHttpUrl(input.baseUrl);
    if (!baseUrl) return { error: 'base url required' };
  } else if (preset.id !== 'custom') {
    baseUrl = preset.baseUrl;
  }
  if (!baseUrl) return { error: 'base url required' };
  const rawKey = input?.apiKey == null ? '' : String(input.apiKey);
  const apiKey = isMaskedOrEmptyApiKey(rawKey) ? '' : rawKey;
  if (preset.needsKey && !apiKey.trim()) return { error: 'api key required' };
  let id = createId();
  if (!SOURCE_ID.test(String(id)) || id === GROK_SOURCE_ID) id = createSourceId();
  return {
    source: {
      id,
      kind: 'api',
      vendor: preset.id,
      name: cleanName(input?.name, preset.name),
      baseUrl,
      apiKey,
      models,
    },
  };
}

function applyContextWindowsPatch(next, patch) {
  if (!Object.prototype.hasOwnProperty.call(patch, 'contextWindows')) return '';
  const merged = mergeContextWindows(next.contextWindows, patch.contextWindows);
  if (merged.error) return merged.error;
  if (merged.contextWindows) next.contextWindows = merged.contextWindows;
  else delete next.contextWindows;
  return '';
}

export function applySourcePatch(source, patch = {}) {
  if (!source) return { error: 'not found' };
  const next = {
    ...source,
    models: [...(source.models || [])],
    ...(source.lastTest ? { lastTest: { ...source.lastTest } } : {}),
    ...(source.contextWindows ? { contextWindows: { ...source.contextWindows } } : {}),
  };
  if (source.kind === 'grok') {
    if (typeof patch.name === 'string' && patch.name.trim()) next.name = cleanName(patch.name, source.name);
    if (patch.models != null) {
      const models = normalizeModelList(patch.models);
      if (!models) return { error: 'invalid models' };
      next.models = models.length ? models : [GROK_SESSION_MODEL];
    }
    const windowError = applyContextWindowsPatch(next, patch);
    if (windowError) return { error: windowError };
    next.id = GROK_SOURCE_ID;
    next.kind = 'grok';
    next.vendor = 'grok';
    next.baseUrl = '';
    next.apiKey = '';
    return { source: next };
  }
  if (patch.vendor != null) {
    const preset = vendorPreset(patch.vendor);
    if (!preset) return { error: 'unknown vendor' };
    next.vendor = preset.id;
    if (patch.baseUrl == null && preset.id !== 'custom' && preset.baseUrl) next.baseUrl = preset.baseUrl;
  }
  if (typeof patch.name === 'string' && patch.name.trim()) next.name = cleanName(patch.name, next.name);
  if (patch.baseUrl != null) {
    const baseUrl = normalizeHttpUrl(patch.baseUrl);
    if (!baseUrl) return { error: 'base url required' };
    next.baseUrl = baseUrl;
  }
  const suppliedNewKey = Object.prototype.hasOwnProperty.call(patch, 'apiKey')
    && !isMaskedOrEmptyApiKey(patch.apiKey, maskApiKey(source.apiKey));
  if (suppliedNewKey) next.apiKey = String(patch.apiKey);
  if (patch.models != null) {
    const models = normalizeModelList(patch.models);
    if (!models) return { error: 'invalid models' };
    next.models = models;
  }
  const windowError = applyContextWindowsPatch(next, patch);
  if (windowError) return { error: windowError };
  const prevOrigin = httpOrigin(effectiveBaseUrl(source));
  const nextOrigin = httpOrigin(effectiveBaseUrl(next));
  if (prevOrigin !== nextOrigin && !suppliedNewKey) next.apiKey = '';
  if (sourceNeedsKey(next) && !String(next.apiKey || '').trim()) return { error: 'api key required' };
  if (!effectiveBaseUrl(next)) return { error: 'base url required' };
  return { source: next };
}

export function grokSourceTemplate() {
  return {
    id: GROK_SOURCE_ID,
    kind: 'grok',
    vendor: 'grok',
    name: 'Grok 订阅',
    baseUrl: '',
    apiKey: '',
    models: [GROK_SESSION_MODEL],
  };
}

/** Env prefill becomes one API source. Incomplete custom rows stay stored but unusable. */
export function sourceFromEnv({ baseUrl = '', apiKey = '', model = '', createId = createSourceId } = {}) {
  const urlText = String(baseUrl || '').trim();
  const key = String(apiKey || '').trim();
  const modelName = String(model || '').trim().slice(0, 200);
  if (!urlText && !key && !modelName) return null;
  const normalized = urlText ? normalizeHttpUrl(urlText) : '';
  if (urlText && !normalized) return null;
  const preset = normalized ? vendorForBaseUrl(normalized) : null;
  let id = createId();
  if (!SOURCE_ID.test(String(id)) || id === GROK_SOURCE_ID) id = createSourceId();
  const source = {
    id,
    kind: 'api',
    vendor: preset?.id || 'custom',
    name: preset?.name || '自定义 API',
    baseUrl: normalized,
    apiKey: key,
    models: modelName ? [modelName] : [],
  };
  const models = modelName ? { default: { sourceId: source.id, model: modelName } } : {};
  return { source, models };
}

export function redactProbeError(text, secret) {
  let out = redactAuthText(text);
  const key = String(secret || '');
  if (key.length >= 4) out = out.split(key).join('***');
  return out.trim().slice(0, 500);
}

function codeForHttpStatus(status) {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'not_found';
  return 'http';
}

const NETWORK_CODES = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH',
  'EAI_AGAIN', 'EPIPE', 'ECONNABORTED',
]);

function isNetworkFailure(err, message) {
  const cause = err?.cause?.code || err?.code || '';
  if (NETWORK_CODES.has(cause)) return true;
  const text = String(message || '');
  if (/^(fetch failed|failed to fetch|request failed)$/i.test(text)) return true;
  return /\b(ECONNREFUSED|ENOTFOUND|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|EPIPE|ECONNABORTED)\b|socket hang up|network error|networkerror|connect failed|fetch failed/i.test(text);
}

function probeErrorText(text, status, apiKey) {
  let raw = String(text || '').trim();
  if (raw.startsWith('{') || raw.startsWith('[')) {
    try {
      const json = JSON.parse(raw);
      const nested = json?.error;
      const picked = (nested && typeof nested === 'object' && typeof nested.message === 'string' && nested.message.trim())
        || (typeof nested === 'string' && nested.trim())
        || (typeof json?.message === 'string' && json.message.trim())
        || '';
      if (picked) raw = String(picked).trim();
    } catch { /* keep the raw body */ }
  }
  return redactProbeError(raw || `HTTP ${status}`, apiKey) || `HTTP ${status}`;
}

function modelIdsFrom(json) {
  const rows = Array.isArray(json?.data) ? json.data : (Array.isArray(json?.models) ? json.models : []);
  const ids = [];
  for (const item of rows) {
    const id = typeof item === 'string' ? item : item?.id;
    if (typeof id !== 'string') continue;
    const name = id.trim();
    if (!name || ids.includes(name)) continue;
    ids.push(name);
  }
  return ids;
}

export async function probeModels({ baseUrl, apiKey = '', fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = {}) {
  const root = normalizeHttpUrl(baseUrl);
  if (!root) return { ok: false, error: 'base url required' };
  const url = new URL(root);
  url.username = '';
  url.password = '';
  url.pathname = `${url.pathname.replace(/\/$/, '')}/models`;
  url.search = '';
  url.hash = '';
  const headers = { accept: 'application/json' };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  try {
    const res = await fetchImpl(url.toString(), {
      method: 'GET',
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = typeof res.text === 'function' ? await res.text() : '';
    if (!res.ok) {
      return probeFailurePayload({
        error: probeErrorText(text, res.status, apiKey),
        code: codeForHttpStatus(res.status),
        status: res.status,
      });
    }
    let json = {};
    try { json = text ? JSON.parse(text) : {}; } catch {
      return probeFailurePayload({ error: 'invalid JSON', code: 'bad_json' });
    }
    return { ok: true, models: modelIdsFrom(json) };
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError' || err?.cause?.code === 'ETIMEDOUT' || err?.code === 'ETIMEDOUT';
    if (timedOut) return probeFailurePayload({ error: 'timeout', code: 'timeout' });
    const message = redactProbeError(err?.message || 'request failed', apiKey) || 'request failed';
    if (isNetworkFailure(err, message)) return probeFailurePayload({ error: message, code: 'network' });
    return probeFailurePayload({ error: message });
  }
}
