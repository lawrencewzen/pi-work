import { stream as completionsStream, streamSimple as completionsStreamSimple } from '@earendil-works/pi-ai/api/openai-completions';
import { stream as responsesStream, streamSimple as responsesStreamSimple } from '@earendil-works/pi-ai/api/openai-responses';
import { createProvider } from '@earendil-works/pi-ai/models';
import { GROK_CLIENT_ID, GROK_SESSION_MODEL, grokProxyHeaders } from '../../src/core/grok-auth.mjs';

const COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function chatModel({ provider, id, api, baseUrl, headers }) {
  return {
    id,
    name: id,
    api,
    provider,
    baseUrl,
    reasoning: false,
    input: ['text'],
    cost: COST,
    contextWindow: 128000,
    maxTokens: 4096,
    ...(headers ? { headers } : {}),
  };
}

/**
 * OpenAI-compatible Chat Completions source. pi-ai's built-in `openaiProvider()`
 * pins `baseUrl` to api.openai.com and the Responses API, so a private
 * base URL plus an API key is a `createProvider()` with `openai-completions`.
 */
export function createOpenAICompatProvider({ baseUrl, apiKey, modelId = 'spike-compat' }) {
  const id = 'openai-compat';
  return createProvider({
    id,
    name: 'OpenAI-compatible',
    baseUrl,
    auth: {
      apiKey: {
        name: 'OpenAI-compatible API key',
        async resolve() {
          if (!apiKey) return undefined;
          return { auth: { apiKey }, source: 'spike' };
        },
      },
    },
    models: [chatModel({ provider: id, id: modelId, api: 'openai-completions', baseUrl })],
    api: { stream: completionsStream, streamSimple: completionsStreamSimple },
  });
}

/**
 * Static Grok subscription-proxy headers. `grokProxyHeaders` also sets
 * Authorization; the access token is request auth, not a static header.
 */
export function grokStaticHeaders(model = GROK_SESSION_MODEL, version = '1.0.50') {
  const headers = { ...grokProxyHeaders('placeholder', model, version) };
  delete headers.authorization;
  return headers;
}

async function postRefresh({ tokenUrl, refreshToken, clientId, fetchImpl }) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: clientId || GROK_CLIENT_ID,
    refresh_token: refreshToken,
  });
  const response = await fetchImpl(tokenUrl, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || typeof data.access_token !== 'string' || data.access_token.length === 0) {
    throw new Error(`token refresh failed (HTTP ${response.status})`);
  }
  return {
    accessToken: data.access_token,
    refreshToken: typeof data.refresh_token === 'string' && data.refresh_token ? data.refresh_token : refreshToken,
  };
}

/**
 * One fetch that retries a single 401 after refreshing the access token.
 * The OpenAI SDK only sees the second response.
 */
export function refreshingFetch({ refresh, fetchImpl = globalThis.fetch }) {
  return async function grokFetch(input, init) {
    const first = await fetchImpl(input, init);
    if (first.status !== 401) return first;
    try { await first.arrayBuffer(); } catch { /* drained */ }
    let next;
    try {
      next = await refresh();
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
    fetch: refreshingFetch({
      refresh: state.refresh,
      fetchImpl: state.fetchImpl,
    }),
  });
}

/**
 * Grok subscription proxy (Responses API + proxy headers + refresh on 401).
 *
 * pi-ai's `xaiProvider()` does not cover this: its base URL is
 * `https://api.x.ai/v1`, `toAuth()` returns only `{ apiKey }`, and OAuth
 * refresh runs when the stored credential is near expiry, not when a request
 * comes back 401. This provider is the smallest adapter that does.
 */
export function createGrokProxyProvider({
  baseUrl,
  tokenUrl,
  accessToken,
  refreshToken,
  modelId = GROK_SESSION_MODEL,
  clientId = GROK_CLIENT_ID,
  fetchImpl = globalThis.fetch,
  version = '1.0.50',
}) {
  const id = 'grok-proxy';
  const headers = grokStaticHeaders(modelId, version);
  const state = {
    accessToken,
    refreshToken,
    refreshes: 0,
    fetchImpl,
    async refresh() {
      const next = await postRefresh({
        tokenUrl,
        refreshToken: state.refreshToken,
        clientId,
        fetchImpl,
      });
      state.accessToken = next.accessToken;
      state.refreshToken = next.refreshToken;
      state.refreshes += 1;
      return next;
    },
  };
  const provider = createProvider({
    id,
    name: 'Grok subscription proxy',
    baseUrl,
    headers,
    auth: {
      apiKey: {
        name: 'Grok session access token',
        async resolve() {
          if (!state.accessToken) return undefined;
          return { auth: { apiKey: state.accessToken, headers }, source: 'spike-grok-proxy' };
        },
      },
    },
    models: [chatModel({
      provider: id,
      id: modelId,
      api: 'openai-responses',
      baseUrl,
      headers,
    })],
    api: {
      stream: withRefresh(responsesStream, state),
      streamSimple: withRefresh(responsesStreamSimple, state),
    },
  });
  return { provider, state, modelId };
}
