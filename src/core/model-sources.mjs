import { randomBytes } from 'node:crypto';
import { maskApiKey, isMaskedOrEmptyApiKey } from './settings.mjs';
import { redactAuthText, GROK_SESSION_MODEL } from './grok-auth.mjs';

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
const ROLE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const BLOCKED_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

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

function normalizeLastTest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const at = typeof value.at === 'string' ? value.at.trim().slice(0, 40) : '';
  if (!at) return undefined;
  const last = { ok: value.ok === true, at };
  if (!last.ok && value.error != null) {
    const error = redactAuthText(value.error).trim();
    if (error) last.error = error.slice(0, 500);
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
    }));
  }
  return out;
}

export function normalizeRoleModels(models) {
  if (!models || typeof models !== 'object' || Array.isArray(models)) return {};
  const out = {};
  for (const [roleId, value] of Object.entries(models)) {
    if (BLOCKED_KEYS.has(roleId) || !ROLE_ID.test(roleId)) continue;
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const sourceId = typeof value.sourceId === 'string' ? value.sourceId.trim() : '';
    const model = typeof value.model === 'string' ? value.model.trim() : '';
    if (!sourceId || !model) continue;
    out[roleId] = { sourceId, model: model.slice(0, 200) };
  }
  return out;
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
  if (normalized.lastTest) body.lastTest = { ...normalized.lastTest };
  if (normalized.kind === 'grok') {
    body.session = {
      signedIn: Boolean(grokStatus?.signedIn),
      email: grokStatus?.email ?? null,
      expiresAt: grokStatus?.expiresAt ?? null,
    };
  }
  return body;
}

function legacyStringModels(models) {
  if (!models || typeof models !== 'object' || Array.isArray(models)) return [];
  const pairs = [];
  for (const [roleId, value] of Object.entries(models)) {
    if (BLOCKED_KEYS.has(roleId) || !ROLE_ID.test(roleId)) continue;
    if (typeof value !== 'string') continue;
    const model = value.trim().slice(0, 200);
    if (!model) continue;
    pairs.push([roleId, model]);
  }
  return pairs;
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
  if (provider || baseUrl || apiKey) {
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
    for (const [roleId, model] of legacyStringModels(input.models)) {
      pushModel(target, model);
      models[roleId] = { sourceId: target.id, model };
    }
  }
  return {
    ...input,
    version: SETTINGS_VERSION,
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

/**
 * Role binding, then default, then the first model on the first usable source.
 * A role-template model string prefers a source that lists it, otherwise the
 * resolved source keeps that name.
 */
export function resolveRoleTarget(settings, { roleId, model, grokSignedIn = false } = {}) {
  const sources = normalizeSources(settings?.sources);
  const bindings = normalizeRoleModels(settings?.models);
  const options = { grokSignedIn };
  let resolved = null;
  if (roleId) resolved = bindingTarget(sources, bindings[roleId], options);
  if (!resolved && roleId !== 'default') resolved = bindingTarget(sources, bindings.default, options);
  if (!resolved) {
    for (const source of sources) {
      if (!sourceAvailable(source, options)) continue;
      const name = (source.models || []).find((item) => typeof item === 'string' && item.trim());
      if (!name) continue;
      resolved = { source, model: name.trim() };
      break;
    }
  }
  const hinted = typeof model === 'string' ? model.trim() : '';
  if (!hinted) return resolved;
  const listed = sources.find((source) => sourceAvailable(source, options) && (source.models || []).includes(hinted));
  if (listed) return { source: listed, model: hinted };
  if (resolved) return { source: resolved.source, model: hinted };
  return null;
}

export function validateRoleModels(settings, models) {
  if (!models || typeof models !== 'object' || Array.isArray(models)) return 'invalid model binding';
  const sources = normalizeSources(settings?.sources);
  for (const [roleId, value] of Object.entries(models)) {
    if (BLOCKED_KEYS.has(roleId) || !ROLE_ID.test(roleId)) return 'invalid role id';
    if (value == null) continue;
    if (typeof value !== 'object' || Array.isArray(value)) return 'invalid model binding';
    const sourceId = typeof value.sourceId === 'string' ? value.sourceId.trim() : '';
    const model = typeof value.model === 'string' ? value.model.trim() : '';
    const source = sources.find((item) => item.id === sourceId);
    if (!source) return 'unknown source';
    if (!model || !(source.models || []).includes(model)) return 'model not in source';
  }
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

export function applySourcePatch(source, patch = {}) {
  if (!source) return { error: 'not found' };
  const next = {
    ...source,
    models: [...(source.models || [])],
    ...(source.lastTest ? { lastTest: { ...source.lastTest } } : {}),
  };
  if (source.kind === 'grok') {
    if (typeof patch.name === 'string' && patch.name.trim()) next.name = cleanName(patch.name, source.name);
    if (patch.models != null) {
      const models = normalizeModelList(patch.models);
      if (!models) return { error: 'invalid models' };
      next.models = models.length ? models : [GROK_SESSION_MODEL];
    }
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
  if (Object.prototype.hasOwnProperty.call(patch, 'apiKey')
    && !isMaskedOrEmptyApiKey(patch.apiKey, maskApiKey(source.apiKey))) {
    next.apiKey = String(patch.apiKey);
  }
  if (patch.models != null) {
    const models = normalizeModelList(patch.models);
    if (!models) return { error: 'invalid models' };
    next.models = models;
  }
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
      return { ok: false, error: probeErrorText(text, res.status, apiKey) };
    }
    let json = {};
    try { json = text ? JSON.parse(text) : {}; } catch {
      return { ok: false, error: 'invalid JSON' };
    }
    return { ok: true, models: modelIdsFrom(json) };
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    const message = timedOut ? 'timeout' : (err?.message || 'request failed');
    return { ok: false, error: redactProbeError(message, apiKey) || 'request failed' };
  }
}
