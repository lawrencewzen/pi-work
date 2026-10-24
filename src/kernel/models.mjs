// Real model sources for the Pi Durable kernel.
// Providers are pi-ai catalogs on the Harness. This module does not schedule
// work, store checkpoints, or fall back to the faux provider.
import { stream as completionsStream, streamSimple as completionsStreamSimple } from '@earendil-works/pi-ai/api/openai-completions';
import { stream as responsesStream, streamSimple as responsesStreamSimple } from '@earendil-works/pi-ai/api/openai-responses';
import { createProvider } from '@earendil-works/pi-ai/models';
import {
  GROK_SESSION_MODEL,
  grokClientVersion,
  grokProxyBase,
  grokProxyHeaders,
  selectChatRuntime,
} from '../core/grok-auth.mjs';
import { contextWindowFromEnv } from '../core/usage.mjs';
import {
  GROK_SOURCE_ID,
  contextWindowForModel,
  effectiveBaseUrl,
  normalizeSources,
  resolveConversationTarget,
  resolveRoleTarget,
  sourceAvailable,
} from '../core/model-sources.mjs';
import {
  catalogFingerprint,
  catalogMaxTokens,
  lookupModelCatalog,
} from './model-catalog.mjs';

const COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
export const GROK_PROVIDER_ID = 'grok-proxy';
export const DEFAULT_MAX_OUTPUT_TOKENS = 32768;

function clonePlain(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function explicitMaxOutputTokens(env = process.env) {
  const raw = env?.WEFT_MAX_OUTPUT_TOKENS;
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Positive integer from `WEFT_MAX_OUTPUT_TOKENS`, otherwise 32768. */
export function maxOutputTokensFromEnv(env = process.env) {
  return explicitMaxOutputTokens(env) ?? DEFAULT_MAX_OUTPUT_TOKENS;
}

function capMaxTokens(tokens, contextWindow) {
  if (!Number.isInteger(contextWindow) || contextWindow <= 0) return tokens;
  return Math.min(tokens, contextWindow);
}

function maxTokensForModel(catalog, contextWindow, env) {
  const explicit = explicitMaxOutputTokens(env);
  const fromCatalog = catalogMaxTokens(catalog);
  const tokens = explicit ?? fromCatalog ?? DEFAULT_MAX_OUTPUT_TOKENS;
  return capMaxTokens(tokens, contextWindow);
}

/**
 * Faux is on only when the process asks for it: `WEFT_LLM=faux`,
 * `LLM_API=faux`, or `WEFT_FAUX_SCRIPT`. Anything else stays off.
 */
export function explicitDemo(env = process.env) {
  return selectChatRuntime(env?.WEFT_LLM, {
    llmApi: env?.LLM_API,
    fauxScript: Boolean(String(env?.WEFT_FAUX_SCRIPT || '').trim()),
  }) === 'faux';
}

export function providerIdForSource(source) {
  if (!source) return '';
  if (source.kind === 'grok' || source.id === GROK_SOURCE_ID) return GROK_PROVIDER_ID;
  return `src-${source.id}`;
}

function chatModel({ provider, id, api, baseUrl, headers, source, env }) {
  const catalog = lookupModelCatalog(id, baseUrl);
  const contextWindow = contextWindowForModel(source, id, env, baseUrl);
  const model = {
    id,
    name: id,
    api,
    provider,
    baseUrl,
    // Catalog reasoning/thinkingLevelMap would inject thinking fields on
    // DeepSeek when no thinking level is selected. Keep the previous request
    // shape; see tests that compare fake-server bodies.
    reasoning: false,
    input: Array.isArray(catalog?.input) && catalog.input.length ? clonePlain(catalog.input) : ['text'],
    cost: catalog?.cost && typeof catalog.cost === 'object' ? clonePlain(catalog.cost) : COST,
    contextWindow: contextWindow ?? contextWindowFromEnv(env),
    maxTokens: maxTokensForModel(catalog, contextWindow, env),
    ...(headers ? { headers } : {}),
  };
  if (catalog?.compat && typeof catalog.compat === 'object' && !Array.isArray(catalog.compat)) {
    model.compat = clonePlain(catalog.compat);
  }
  return model;
}

function modelIds(source, extra) {
  const out = [];
  const list = Array.isArray(source?.models) ? source.models : [];
  for (const item of [...list, extra]) {
    const name = typeof item === 'string' ? item.trim() : '';
    if (!name || out.includes(name)) continue;
    out.push(name);
  }
  return out;
}

function grokStaticHeaders(model, version) {
  const headers = { ...grokProxyHeaders('placeholder', model, version) };
  delete headers.authorization;
  return headers;
}

/**
 * One 401 refresh per user turn. The OpenAI SDK retry on this call is forced
 * off (`maxRetries: 0`); Harness `settings.retry` may run the turn again, but
 * the budget is already spent, so those attempts do not refresh a second time.
 */
function refreshingFetch(state) {
  return async function grokFetch(input, init) {
    const fetchImpl = state.fetchImpl || globalThis.fetch;
    const first = await fetchImpl(input, init);
    if (first.status !== 401) return first;
    if (state.refreshesLeft <= 0) return first;
    state.refreshesLeft -= 1;
    try { await first.arrayBuffer(); } catch { /* drained */ }
    let next = null;
    try {
      next = await state.refresh();
    } catch {
      return new Response('unauthorized', { status: 401 });
    }
    if (!next?.accessToken) return new Response('unauthorized', { status: 401 });
    const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
    headers.set('authorization', `Bearer ${next.accessToken}`);
    return fetchImpl(input, { ...init, headers });
  };
}

function withRefresh(base, state) {
  return (model, context, options) => base(model, context, {
    ...options,
    maxRetries: 0,
    fetch: refreshingFetch(state),
  });
}

function withoutAuthorization(base) {
  return (model, context, options) => base(model, context, {
    ...options,
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
      headers.delete('authorization');
      const fetchImpl = options?.fetch || globalThis.fetch;
      return fetchImpl(input, { ...init, headers });
    },
  });
}

function createOpenAICompatProvider({ id, baseUrl, apiKey, modelList, contextWindows, env }) {
  const key = String(apiKey || '');
  const api = key
    ? { stream: completionsStream, streamSimple: completionsStreamSimple }
    : { stream: withoutAuthorization(completionsStream), streamSimple: withoutAuthorization(completionsStreamSimple) };
  const source = { contextWindows };
  return createProvider({
    id,
    name: 'OpenAI-compatible',
    baseUrl,
    auth: {
      apiKey: {
        name: 'OpenAI-compatible API key',
        async resolve() {
          // A keyless source (Ollama) still has to satisfy pi-ai's apiKey check.
          // The request wrapper removes Authorization so the placeholder is not sent.
          if (!key) return { auth: { apiKey: 'local' }, source: 'kernel-openai-compat' };
          return { auth: { apiKey: key }, source: 'kernel-openai-compat' };
        },
      },
    },
    models: modelList.map((modelId) => chatModel({
      provider: id,
      id: modelId,
      api: 'openai-completions',
      baseUrl,
      source,
      env,
    })),
    api,
  });
}

function createGrokProxyProvider({ baseUrl, modelList, version, grokAuth, fetchImpl, contextWindows, env }) {
  const state = {
    refreshesLeft: 1,
    fetchImpl,
    async refresh() {
      if (typeof grokAuth?.forceRefresh !== 'function') return null;
      const next = await grokAuth.forceRefresh();
      if (!next?.accessToken) return null;
      return { accessToken: next.accessToken };
    },
    arm() { state.refreshesLeft = 1; },
  };
  const provider = createProvider({
    id: GROK_PROVIDER_ID,
    name: 'Grok subscription proxy',
    baseUrl,
    auth: {
      apiKey: {
        name: 'Grok session access token',
        async resolve() {
          if (typeof grokAuth?.resolveAccessToken !== 'function') return undefined;
          const session = await grokAuth.resolveAccessToken();
          if (!session?.accessToken) return undefined;
          return { auth: { apiKey: session.accessToken }, source: 'grok-auth' };
        },
      },
    },
    models: modelList.map((modelId) => {
      const headers = grokStaticHeaders(modelId, version);
      return chatModel({
        provider: GROK_PROVIDER_ID,
        id: modelId,
        api: 'openai-responses',
        baseUrl,
        headers,
        source: { contextWindows },
        env,
      });
    }),
    api: {
      stream: withRefresh(responsesStream, state),
      streamSimple: withRefresh(responsesStreamSimple, state),
    },
  });
  return { provider, arm: () => state.arm() };
}

/**
 * Register one provider per available source. Call again after settings change;
 * updated sources replace their provider and removed sources are dropped.
 * Returns the model ref for this turn, or null when nothing can be called.
 */
export function createKernelModels({ models, getSettings, grokAuth, env = process.env, fetchImpl } = {}) {
  if (!models || typeof models.setProvider !== 'function') throw new Error('models is required');
  const apiFingerprints = new Map();
  let grokFingerprint = '';
  let armGrok = () => {};

  function dropApi(id) {
    models.deleteProvider(id);
    apiFingerprints.delete(id);
  }

  function dropGrok() {
    if (!grokFingerprint) return;
    models.deleteProvider(GROK_PROVIDER_ID);
    grokFingerprint = '';
    armGrok = () => {};
  }

  function installApi(source, extra) {
    const id = providerIdForSource(source);
    const ids = modelIds(source, extra);
    const baseUrl = effectiveBaseUrl(source);
    if (!id || !baseUrl || !ids.length) {
      if (id && apiFingerprints.has(id)) dropApi(id);
      return;
    }
    const fingerprint = JSON.stringify([
      baseUrl,
      source.apiKey || '',
      ids,
      source.contextWindows || null,
      maxOutputTokensFromEnv(env),
      ids.map((modelId) => catalogFingerprint(modelId, baseUrl)),
    ]);
    if (apiFingerprints.get(id) === fingerprint) return;
    models.setProvider(createOpenAICompatProvider({
      id,
      baseUrl,
      apiKey: source.apiKey || '',
      modelList: ids,
      contextWindows: source.contextWindows,
      env,
    }));
    apiFingerprints.set(id, fingerprint);
  }

  function installGrok(source, extra) {
    const ids = modelIds(source, extra);
    if (!ids.length) ids.push(GROK_SESSION_MODEL);
    const baseUrl = grokProxyBase(env);
    const version = grokClientVersion(env);
    const fingerprint = JSON.stringify([
      baseUrl,
      version,
      ids,
      source.contextWindows || null,
      maxOutputTokensFromEnv(env),
      ids.map((modelId) => catalogFingerprint(modelId, baseUrl)),
    ]);
    if (grokFingerprint === fingerprint) return;
    const built = createGrokProxyProvider({
      baseUrl,
      modelList: ids,
      version,
      grokAuth,
      fetchImpl,
      contextWindows: source.contextWindows,
      env,
    });
    models.setProvider(built.provider);
    grokFingerprint = fingerprint;
    armGrok = built.arm;
  }

  async function signedIn() {
    if (typeof grokAuth?.status !== 'function') return false;
    try {
      const status = await grokAuth.status();
      return Boolean(status?.signedIn);
    } catch {
      return false;
    }
  }

  async function tokenReady() {
    if (typeof grokAuth?.resolveAccessToken !== 'function') return false;
    try {
      const session = await grokAuth.resolveAccessToken();
      return Boolean(session?.accessToken);
    } catch {
      return false;
    }
  }

  function sync(settings, { grokSignedIn, target }) {
    const sources = normalizeSources(settings?.sources);
    const wanted = new Set();
    let wantGrok = false;
    for (const source of sources) {
      const extra = target?.source?.id === source.id ? target.model : '';
      if (source.kind === 'grok') {
        if (!grokSignedIn) continue;
        installGrok(source, extra);
        wantGrok = true;
        continue;
      }
      if (!sourceAvailable(source, { grokSignedIn })) continue;
      installApi(source, extra);
      const id = providerIdForSource(source);
      if (id) wanted.add(id);
    }
    for (const id of [...apiFingerprints.keys()]) {
      if (!wanted.has(id)) dropApi(id);
    }
    if (!wantGrok) dropGrok();
  }

  return {
    /** Install every available source before resume, so a restarted child can call its model. */
    async warm() {
      if (typeof getSettings !== 'function') return;
      const settings = await getSettings();
      sync(settings, { grokSignedIn: await signedIn(), target: null });
    },
    async modelFor(conv) {
      if (typeof getSettings !== 'function') return null;
      const settings = await getSettings();
      const grokSignedIn = await signedIn();
      let target = resolveConversationTarget(settings, conv, { grokSignedIn });
      if (target?.source?.kind === 'grok' && !(await tokenReady())) {
        target = resolveRoleTarget(settings, { grokSignedIn: false });
        if (target?.source?.kind === 'grok') target = null;
      }
      sync(settings, { grokSignedIn, target });
      if (!target?.source || !target.model) return null;
      if (target.source.kind === 'grok') armGrok();
      return { provider: providerIdForSource(target.source), modelId: target.model };
    },
  };
}
