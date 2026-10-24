import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { createModels } from '@earendil-works/pi-ai/models';
import { GROK_AUTH_SCOPE, GROK_CLIENT_ID } from '../../src/core/grok-auth.mjs';
import { createSqliteStore } from '../../src/store/sqlite.mjs';
import { streamSimple as completionsStreamSimple } from '@earendil-works/pi-ai/api/openai-completions';
import { createKernelModels, explicitDemo, providerIdForSource } from '../../src/kernel/models.mjs';
import { startFakeModel } from './kernel-models-fake.mjs';
import { ROOT } from './_root.mjs';
import { request as serverRequest, startServer, stopServer } from './_server.mjs';

const TOKEN = 'unit-kernel-models-token';
const KEY_DEFAULT = 'sk-default-secret-1111';
const KEY_DEFAULT_NEXT = 'sk-default-secret-3333';
const KEY_CODER = 'sk-coder-secret-2222';
const ACCESS_1 = 'access-1';
const REFRESH_1 = 'refresh-1';
const SECRETS = [KEY_DEFAULT, KEY_DEFAULT_NEXT, KEY_CODER, REFRESH_1];
const HOOK = pathToFileURL(path.join(ROOT, 'tests/unit/kernel-models-token-hook.mjs')).href;

test('explicit demo is only the three switches', () => {
  assert.equal(explicitDemo({}), false);
  assert.equal(explicitDemo({ WEFT_LLM: 'faux' }), true);
  assert.equal(explicitDemo({ LLM_API: 'faux' }), true);
  assert.equal(explicitDemo({ WEFT_FAUX_SCRIPT: '/tmp/script.json' }), true);
  assert.equal(explicitDemo({ WEFT_LLM: 'openai' }), false);
  assert.equal(explicitDemo({ LLM_API_KEY: KEY_DEFAULT }), false);
  assert.equal(explicitDemo({ [`PI${'_'}WORK_LLM`]: 'faux' }), false);
  assert.equal(explicitDemo({ [`PI${'_'}WORK_FAUX_SCRIPT`]: '/tmp/script.json' }), false);
});

test('model routing follows conversation, then default, then first usable source', async () => {
  const models = createModels();
  let settings = {
    version: 2,
    sources: [
      {
        id: 'srcdefault',
        kind: 'api',
        vendor: 'custom',
        name: 'Default',
        baseUrl: 'http://127.0.0.1:4101/v1',
        apiKey: KEY_DEFAULT,
        models: ['model-default'],
      },
      {
        id: 'srccoder',
        kind: 'api',
        vendor: 'custom',
        name: 'Coder',
        baseUrl: 'http://127.0.0.1:4102/v1',
        apiKey: KEY_CODER,
        models: ['model-coder'],
      },
    ],
    models: {
      default: { sourceId: 'srcdefault', model: 'model-default' },
      coder: { sourceId: 'srccoder', model: 'model-coder' },
    },
  };
  const routes = createKernelModels({
    models,
    getSettings: async () => settings,
    env: { WEFT_GROK_CLIENT_VERSION: '1.0.50' },
  });
  const main = await routes.modelFor({});
  const pinned = await routes.modelFor({ modelSourceId: 'srccoder', modelId: 'model-coder' });
  assert.equal(main.modelId, 'model-default');
  assert.equal(pinned.modelId, 'model-coder');
  assert.notEqual(main.provider, pinned.provider);
  assert.equal(models.getModel(main.provider, main.modelId).baseUrl, 'http://127.0.0.1:4101/v1');
  assert.equal(models.getModel(pinned.provider, pinned.modelId).baseUrl, 'http://127.0.0.1:4102/v1');

  settings = { ...settings, models: {} };
  const first = await routes.modelFor({});
  assert.equal(first.modelId, 'model-default');
  settings = {
    ...settings,
    models: {
      default: { sourceId: 'srcdefault', model: 'model-default' },
      coder: { sourceId: 'srccoder', model: 'model-coder' },
    },
  };

  settings = {
    ...settings,
    sources: settings.sources.map((source) => (
      source.id === 'srcdefault'
        ? { ...source, baseUrl: 'http://127.0.0.1:4199/v1', apiKey: KEY_DEFAULT_NEXT }
        : source
    )),
  };
  const refreshed = await routes.modelFor({});
  assert.equal(models.getModel(refreshed.provider, refreshed.modelId).baseUrl, 'http://127.0.0.1:4199/v1');

  settings = {
    ...settings,
    sources: settings.sources.filter((source) => source.id !== 'srccoder'),
    models: { default: settings.models.default },
  };
  await routes.modelFor({});
  assert.equal(models.getProvider(providerIdForSource({ id: 'srccoder', kind: 'api' })), undefined);

  settings = { version: 2, sources: [], models: {} };
  assert.equal(await routes.modelFor({}), null);
  assert.equal(models.getModel(main.provider, main.modelId), undefined);
});

test('chatModel uses a source context window and re-registers when it changes', async () => {
  const models = createModels();
  let settings = {
    version: 2,
    sources: [{
      id: 'srcdefault',
      kind: 'api',
      vendor: 'custom',
      name: 'Default',
      baseUrl: 'http://127.0.0.1:4101/v1',
      apiKey: KEY_DEFAULT,
      models: ['model-default', 'model-wide'],
      contextWindows: { 'model-wide': 256000 },
    }],
    models: { default: { sourceId: 'srcdefault', model: 'model-default' } },
  };
  const routes = createKernelModels({
    models,
    getSettings: async () => settings,
    env: { WEFT_GROK_CLIENT_VERSION: '1.0.50' },
  });
  const main = await routes.modelFor({});
  assert.equal(models.getModel(main.provider, 'model-default').contextWindow, 128000);
  assert.equal(models.getModel(main.provider, 'model-wide').contextWindow, 256000);

  settings = {
    ...settings,
    sources: settings.sources.map((source) => ({
      ...source,
      contextWindows: { 'model-default': 512000, 'model-wide': 256000 },
    })),
  };
  const refreshed = await routes.modelFor({});
  assert.equal(models.getModel(refreshed.provider, 'model-default').contextWindow, 512000);
  assert.equal(models.getModel(refreshed.provider, 'model-wide').contextWindow, 256000);
});

test('chatModel reads pi-ai catalog metadata and keeps user/env overrides', async () => {
  async function modelFor(source, env = {}) {
    const models = createModels();
    const settings = {
      version: 2,
      sources: [source],
      models: { default: { sourceId: source.id, model: source.models[0] } },
    };
    const routes = createKernelModels({
      models,
      getSettings: async () => settings,
      env: { WEFT_GROK_CLIENT_VERSION: '1.0.50', ...env },
    });
    const ref = await routes.modelFor({});
    return models.getModel(ref.provider, ref.modelId);
  }

  const flash = await modelFor({
    id: 'srcflash',
    kind: 'api',
    vendor: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: KEY_DEFAULT,
    models: ['deepseek-flash'],
  }, { LLM_CONTEXT_WINDOW: '200000' });
  assert.equal(flash.contextWindow, 1_000_000);
  assert.equal(flash.maxTokens, 384000);
  assert.equal(flash.reasoning, false);
  assert.equal(flash.thinkingLevelMap, undefined);
  assert.deepEqual(flash.input, ['text', 'image']);
  assert.equal(flash.cost.input, 0.3);
  assert.equal(flash.compat?.maxTokensField, 'max_tokens');

  const unknown = await modelFor({
    id: 'srcunknown',
    kind: 'api',
    vendor: 'custom',
    name: 'Custom',
    baseUrl: 'http://127.0.0.1:4101/v1',
    apiKey: KEY_DEFAULT,
    models: ['not-a-real-model'],
  });
  assert.equal(unknown.contextWindow, 128000);
  assert.equal(unknown.maxTokens, 32768);
  assert.equal(unknown.reasoning, false);
  assert.deepEqual(unknown.input, ['text']);
  assert.deepEqual(unknown.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.equal(unknown.compat, undefined);

  const userWindow = await modelFor({
    id: 'srcflash',
    kind: 'api',
    vendor: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: KEY_DEFAULT,
    models: ['deepseek-flash'],
    contextWindows: { 'deepseek-flash': 256000 },
  });
  assert.equal(userWindow.contextWindow, 256000);
  assert.equal(userWindow.maxTokens, 256000);

  const envMax = await modelFor({
    id: 'srcflash',
    kind: 'api',
    vendor: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: KEY_DEFAULT,
    models: ['deepseek-flash'],
  }, { WEFT_MAX_OUTPUT_TOKENS: '2048' });
  assert.equal(envMax.contextWindow, 1_000_000);
  assert.equal(envMax.maxTokens, 2048);
});

function rewriteDeepseekFetch(fakeBaseUrl) {
  const fake = new URL(fakeBaseUrl);
  return async (input, init) => {
    const href = typeof input === 'string'
      ? input
      : (input instanceof URL ? input.href : (input && typeof input.url === 'string' ? input.url : ''));
    const url = new URL(href);
    if (url.hostname !== 'api.deepseek.com') return fetch(input, init);
    url.protocol = fake.protocol;
    url.host = fake.host;
    if (input instanceof Request) return fetch(new Request(url, input), init);
    return fetch(url, init);
  };
}

function withoutTokenLimitValue(body) {
  const copy = JSON.parse(JSON.stringify(body));
  if (Object.prototype.hasOwnProperty.call(copy, 'max_tokens')) copy.max_tokens = '<limit>';
  if (Object.prototype.hasOwnProperty.call(copy, 'max_completion_tokens')) copy.max_completion_tokens = '<limit>';
  return copy;
}

async function drainCompletions(model, fetchImpl) {
  const stream = completionsStreamSimple(model, {
    messages: [{ role: 'user', content: 'ping', timestamp: Date.now() }],
  }, { apiKey: KEY_DEFAULT, fetch: fetchImpl, maxRetries: 0 });
  await stream.result();
}

test('deepseek-flash request body matches the pre-catalog shape except max_tokens', async () => {
  const fake = await startFakeModel({ mode: 'openai', text: 'from-catalog' });
  try {
    const models = createModels();
    const settings = {
      version: 2,
      sources: [{
        id: 'srcflash',
        kind: 'api',
        vendor: 'deepseek',
        name: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: KEY_DEFAULT,
        models: ['deepseek-flash'],
      }],
      models: { default: { sourceId: 'srcflash', model: 'deepseek-flash' } },
    };
    const routes = createKernelModels({
      models,
      getSettings: async () => settings,
      env: { WEFT_GROK_CLIENT_VERSION: '1.0.50' },
    });
    const ref = await routes.modelFor({});
    const catalogModel = models.getModel(ref.provider, ref.modelId);
    const legacyModel = {
      id: 'deepseek-flash',
      name: 'deepseek-flash',
      api: 'openai-completions',
      provider: catalogModel.provider,
      baseUrl: 'https://api.deepseek.com/v1',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 32768,
    };
    const fetchImpl = rewriteDeepseekFetch(fake.baseUrl);
    await drainCompletions(legacyModel, fetchImpl);
    await drainCompletions(catalogModel, fetchImpl);
    const [legacyHit, catalogHit] = fake.seen.filter((hit) => hit.path.endsWith('/chat/completions'));
    assert.ok(legacyHit?.body, 'legacy request was recorded');
    assert.ok(catalogHit?.body, 'catalog request was recorded');
    assert.equal(legacyHit.body.max_tokens, 32768);
    assert.equal(catalogHit.body.max_tokens, 384000);
    assert.deepEqual(withoutTokenLimitValue(catalogHit.body), withoutTokenLimitValue(legacyHit.body));
    assert.equal(Object.prototype.hasOwnProperty.call(catalogHit.body, 'thinking'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(catalogHit.body, 'reasoning'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(catalogHit.body, 'reasoning_effort'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(catalogHit.body, 'enable_thinking'), false);
  } finally {
    await fake.close();
  }
});

test('modelFor prefers a conversation model and falls back when that source is down', async () => {
  const models = createModels();
  let settings = {
    version: 2,
    sources: [
      {
        id: 'srcdefault',
        kind: 'api',
        vendor: 'custom',
        name: 'Default',
        baseUrl: 'http://127.0.0.1:4101/v1',
        apiKey: KEY_DEFAULT,
        models: ['model-default'],
      },
      {
        id: 'srccoder',
        kind: 'api',
        vendor: 'custom',
        name: 'Coder',
        baseUrl: 'http://127.0.0.1:4102/v1',
        apiKey: KEY_CODER,
        models: ['model-coder'],
      },
    ],
    models: {
      default: { sourceId: 'srcdefault', model: 'model-default' },
      coder: { sourceId: 'srccoder', model: 'model-coder' },
    },
  };
  const routes = createKernelModels({
    models,
    getSettings: async () => settings,
    env: { WEFT_GROK_CLIENT_VERSION: '1.0.50' },
  });

  const pinned = await routes.modelFor({
    modelSourceId: 'srcdefault',
    modelId: 'model-default',
  });
  assert.equal(pinned.modelId, 'model-default');
  const main = await routes.modelFor({});
  assert.equal(pinned.provider, main.provider);

  const missing = await routes.modelFor({
    modelSourceId: 'missing',
    modelId: 'ghost',
  });
  assert.equal(missing.modelId, 'model-default');

  settings = {
    ...settings,
    sources: settings.sources.map((source) => (
      source.id === 'srcdefault' ? { ...source, apiKey: '' } : source
    )),
  };
  const fallback = await routes.modelFor({
    modelSourceId: 'srcdefault',
    modelId: 'model-default',
  });
  assert.equal(fallback.modelId, 'model-coder');
});

function scrub(text) {
  let out = String(text ?? '');
  for (const secret of SECRETS) {
    if (secret) out = out.split(secret).join(`***${secret.slice(-4)}`);
  }
  return out;
}

function assertClean(text, label) {
  const raw = String(text ?? '');
  for (const secret of SECRETS) {
    if (secret && raw.includes(secret)) throw new Error(`${label} contained a raw key or token`);
  }
}

async function request(base, method, apiPath, body) {
  const res = await serverRequest(base, method, apiPath, body, TOKEN);
  assertClean(res.text, `${method} ${apiPath}`);
  return res;
}

async function seedGrok(dataDir) {
  const authFile = path.join(dataDir, 'auth.json');
  const store = {
    [GROK_AUTH_SCOPE]: {
      key: ACCESS_1,
      auth_mode: 'oidc',
      create_time: '2020-01-01T00:00:00.000Z',
      user_id: 'user-1',
      email: 'ada@example.com',
      refresh_token: REFRESH_1,
      expires_at: '2099-01-01T00:00:00.000Z',
      oidc_issuer: 'https://auth.x.ai',
      oidc_client_id: GROK_CLIENT_ID,
    },
  };
  await writeFile(authFile, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  const db = createSqliteStore(dataDir);
  await db.putSettings({
    sources: [{
      id: 'grok',
      kind: 'grok',
      vendor: 'grok',
      name: 'Grok 订阅',
      baseUrl: '',
      apiKey: '',
      models: ['grok-build'],
    }],
    models: {},
  });
  db.close();
}

async function waitTurn(base, cid, pred, attempts = 80) {
  let last = null;
  for (let i = 0; i < attempts; i += 1) {
    const got = await request(base, 'GET', `/api/conversations/${cid}`);
    last = got.body;
    if (pred(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return last;
}

function assistantTexts(body) {
  return (body?.messages || []).filter((message) => message.role === 'assistant').map((message) => message.text);
}

test('kernel models call each source, refresh Grok once, and hide keys', { timeout: 60000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-kmodels-'));
  const defaultFake = await startFakeModel({ mode: 'openai', text: 'from-default' });
  const coderFake = await startFakeModel({ mode: 'openai', text: 'from-coder' });
  const grokFake = await startFakeModel({ mode: 'grok', text: 'from-grok', access1: ACCESS_1, access2: 'access-2' });
  let proc = null;
  try {
    await seedGrok(dataDir);
    const srv = await startServer({
      dataDir,
      token: TOKEN,
      authJson: false,
      nodeArgs: ['--import', HOOK],
      formatLog: scrub,
      env: {
        WEFT_GROK_CLIENT_VERSION: '1.0.50',
        WEFT_GROK_PROXY: grokFake.baseUrl,
        WEFT_TEST_GROK_TOKEN_URL: grokFake.tokenUrl,
      },
    });
    proc = srv.proc;
    const { base } = srv;

    const createdDefault = await request(base, 'POST', '/api/sources', {
      vendor: 'custom',
      name: 'Default',
      baseUrl: defaultFake.baseUrl,
      apiKey: KEY_DEFAULT,
      models: ['model-default'],
    });
    assert.equal(createdDefault.status, 201);
    assert.equal(createdDefault.body.apiKey, `••••${KEY_DEFAULT.slice(-4)}`);
    assert.equal(createdDefault.body.hasApiKey, true);
    const createdCoder = await request(base, 'POST', '/api/sources', {
      vendor: 'custom',
      name: 'Coder',
      baseUrl: coderFake.baseUrl,
      apiKey: KEY_CODER,
      models: ['model-coder'],
    });
    assert.equal(createdCoder.status, 201);
    const bound = await request(base, 'PUT', '/api/settings', {
      models: {
        default: { sourceId: createdDefault.body.id, model: 'model-default' },
        coder: { sourceId: createdCoder.body.id, model: 'model-coder' },
        tester: { sourceId: 'grok', model: 'grok-build' },
      },
    });
    assert.equal(bound.status, 200);
    assert.deepEqual(bound.body.models.default, { sourceId: createdDefault.body.id, model: 'model-default' });
    assert.equal(bound.body.models.coder, undefined);
    assert.equal(bound.body.models.tester, undefined);
    const settingsText = JSON.stringify(bound.body);
    assertClean(settingsText, 'settings');
    const listedDefault = bound.body.sources.find((source) => source.id === createdDefault.body.id);
    const listedCoder = bound.body.sources.find((source) => source.id === createdCoder.body.id);
    assert.equal(listedDefault.apiKey, `••••${KEY_DEFAULT.slice(-4)}`);
    assert.equal(listedCoder.apiKey, `••••${KEY_CODER.slice(-4)}`);
    assert.equal(listedDefault.baseUrl, defaultFake.baseUrl);
    assert.equal(listedCoder.baseUrl, coderFake.baseUrl);

    const ws = await request(base, 'POST', '/api/workspaces', { name: 'kernel-models' });
    assert.equal(ws.status, 201);
    const mainConv = await request(base, 'POST', `/api/workspaces/${ws.body.id}/conversations`, { title: 'default-model' });
    assert.equal(mainConv.status, 201);
    const coderConv = await request(base, 'POST', `/api/workspaces/${ws.body.id}/conversations`, {
      title: 'coder-pinned',
      modelSourceId: createdCoder.body.id,
      modelId: 'model-coder',
    });
    assert.equal(coderConv.status, 201);

    const sentMain = await request(base, 'POST', `/api/conversations/${mainConv.body.id}/messages`, { text: 'ping-default' });
    assert.equal(sentMain.status, 202);
    const mainDone = await waitTurn(base, mainConv.body.id, (body) => assistantTexts(body).includes('from-default'));
    assert.equal(mainDone.status, 'done');
    assert.deepEqual(defaultFake.seen.map((hit) => hit.keyTail), [KEY_DEFAULT.slice(-4)]);
    assert.equal(coderFake.seen.length, 0);

    const sentCoder = await request(base, 'POST', `/api/conversations/${coderConv.body.id}/messages`, { text: 'ping-coder' });
    assert.equal(sentCoder.status, 202);
    const coderDone = await waitTurn(base, coderConv.body.id, (body) => assistantTexts(body).includes('from-coder'));
    assert.equal(coderDone.status, 'done');
    assert.deepEqual(coderFake.seen.map((hit) => hit.keyTail), [KEY_CODER.slice(-4)]);
    assert.equal(coderFake.seen[0].path.endsWith('/chat/completions'), true);
    assert.deepEqual(defaultFake.seen.map((hit) => hit.keyTail), [KEY_DEFAULT.slice(-4)]);

    const rotated = await request(base, 'PUT', `/api/sources/${createdDefault.body.id}`, { apiKey: KEY_DEFAULT_NEXT });
    assert.equal(rotated.status, 200);
    assert.equal(rotated.body.apiKey, `••••${KEY_DEFAULT_NEXT.slice(-4)}`);
    assertClean(rotated.text, 'rotated source');
    const sentRotated = await request(base, 'POST', `/api/conversations/${mainConv.body.id}/messages`, { text: 'ping-default-again' });
    assert.equal(sentRotated.status, 202);
    const rotatedDone = await waitTurn(
      base,
      mainConv.body.id,
      (body) => assistantTexts(body).filter((text) => text === 'from-default').length >= 2,
    );
    assert.equal(rotatedDone.status, 'done');
    assert.deepEqual(defaultFake.seen.map((hit) => hit.keyTail), [KEY_DEFAULT.slice(-4), KEY_DEFAULT_NEXT.slice(-4)]);

    const testerConv = await request(base, 'POST', `/api/workspaces/${ws.body.id}/conversations`, {
      title: 'grok-pinned',
      modelSourceId: 'grok',
      modelId: 'grok-build',
    });
    assert.equal(testerConv.status, 201);
    const sentGrok = await request(base, 'POST', `/api/conversations/${testerConv.body.id}/messages`, { text: 'ping-grok' });
    assert.equal(sentGrok.status, 202);
    const grokDone = await waitTurn(base, testerConv.body.id, (body) => assistantTexts(body).includes('from-grok'));
    assert.equal(grokDone.status, 'done', scrub(JSON.stringify(grokDone)));
    assert.equal(grokFake.refreshCount(), 1);
    const grokResponses = grokFake.seen.filter((hit) => hit.path.endsWith('/responses'));
    assert.equal(grokResponses.some((hit) => hit.tokenGen === 'access-1'), true);
    const accepted = grokResponses.find((hit) => hit.tokenGen === 'access-2');
    assert.ok(accepted);
    assert.equal(accepted.grokIdentifier, 'grok-shell');
    assert.equal(accepted.grokVersion, '1.0.50');
    assert.equal(accepted.grokModel, 'grok-build');
    assert.equal(accepted.tokenAuth, 'xai-grok-cli');
    assert.equal(grokFake.seen.filter((hit) => hit.path.endsWith('/oauth2/token')).length, 1);

    assert.equal((await request(base, 'DELETE', `/api/sources/${createdCoder.body.id}`)).status, 200);
    assert.equal((await request(base, 'DELETE', `/api/sources/${createdDefault.body.id}`)).status, 200);
    assert.equal((await request(base, 'DELETE', '/api/sources/grok')).status, 200);
    const bare = await request(base, 'POST', `/api/conversations/${mainConv.body.id}/messages`, { text: 'no-source' });
    assert.equal(bare.status, 202);
    const failed = await waitTurn(base, mainConv.body.id, (body) => body.status === 'failed' || body.status === 'done');
    assert.equal(failed.status, 'failed');
    assert.equal(failed.llmError?.code, 'E_NO_MODEL');
    assert.equal(failed.llmError?.message, 'err_no_model');
    assert.equal(failed.messages.some((message) => message.role === 'user' && message.text === 'no-source'), true);
    assertClean(JSON.stringify(failed), 'failed conversation');
    assertClean(srv.logs(), 'server log');
  } finally {
    await stopServer(proc);
    await defaultFake.close();
    await coderFake.close();
    await grokFake.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

