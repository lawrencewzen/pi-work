import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from './_root.mjs';

const sources = await load('src/core/model-sources.mjs');
const settings = await load('src/core/settings.mjs');
const usage = await load('src/core/usage.mjs');

const {
  migrateLegacySettings,
  resolveRoleTarget,
  resolveConversationModelPatch,
  applySourcePatch,
  validateRoleModels,
  publicSource,
  probeModels,
  probeFailurePayload,
  modelsAfterProbe,
  normalizeSources,
  contextWindowForModel,
  contextWindowForConversation,
  GROK_SOURCE_ID,
} = sources;

const fixedId = () => 'srcfixed1';

function apiSource(overrides = {}) {
  return {
    id: 'src1',
    kind: 'api',
    vendor: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-old-secret-value',
    models: ['gpt-4o'],
    ...overrides,
  };
}

test('default and untouched preset rows do not become API sources', () => {
  const untouched = migrateLegacySettings({
    provider: 'openai',
    baseUrl: '',
    apiKey: '',
    models: { default: 'gpt-4o-leftover' },
  }, { createId: fixedId });
  assert.equal(untouched.version, 2);
  assert.deepEqual(untouched.sources, []);
  assert.deepEqual(untouched.models, {});
  assert.equal(untouched.provider, 'openai');
  assert.equal(untouched.baseUrl, '');
  assert.equal(untouched.apiKey, '');

  const presetOnly = migrateLegacySettings({
    provider: 'deepseek',
    baseUrl: '',
    apiKey: '',
    models: { coder: 'deepseek-chat' },
  }, { createId: fixedId });
  assert.deepEqual(presetOnly.sources, []);
  assert.deepEqual(presetOnly.models, {});

  const presetUrl = migrateLegacySettings({
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1/',
    apiKey: '',
    models: { default: 'gpt-4o' },
  }, { createId: fixedId });
  assert.deepEqual(presetUrl.sources, []);
  assert.deepEqual(presetUrl.models, {});
});

test('a real key, Ollama URL, or non-preset URL becomes one API source', () => {
  const keyed = migrateLegacySettings({
    provider: 'openai',
    baseUrl: '',
    apiKey: 'sk-legacy-secret-value',
    models: { default: 'gpt-4o', coder: 'gpt-4o' },
    language: 'en',
  }, { createId: fixedId });
  assert.equal(keyed.sources.length, 1);
  assert.equal(keyed.sources[0].id, 'srcfixed1');
  assert.equal(keyed.sources[0].baseUrl, 'https://api.openai.com/v1');
  assert.equal(keyed.sources[0].apiKey, 'sk-legacy-secret-value');
  assert.deepEqual(keyed.sources[0].models, ['gpt-4o']);
  assert.deepEqual(keyed.models, {
    default: { sourceId: 'srcfixed1', model: 'gpt-4o' },
    coder: { sourceId: 'srcfixed1', model: 'gpt-4o' },
  });
  assert.equal(keyed.apiKey, '');
  assert.equal(keyed.baseUrl, '');
  assert.equal(keyed.provider, 'openai');
  assert.equal(keyed.language, 'en');

  const ollama = migrateLegacySettings({
    provider: 'ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    apiKey: '',
    models: { default: 'llama3.2' },
  }, { createId: fixedId });
  assert.equal(ollama.sources.length, 1);
  assert.equal(ollama.sources[0].vendor, 'ollama');
  assert.equal(ollama.sources[0].apiKey, '');
  assert.equal(ollama.models.default.sourceId, 'srcfixed1');

  const customUrl = migrateLegacySettings({
    provider: 'openai',
    baseUrl: 'https://proxy.example/v1',
    apiKey: '',
    models: { tester: 'gpt-4o' },
  }, { createId: fixedId });
  assert.equal(customUrl.sources.length, 1);
  assert.equal(customUrl.sources[0].baseUrl, 'https://proxy.example/v1');
  assert.equal(customUrl.models.tester.model, 'gpt-4o');
});

test('signed-in Grok receives leftover string models, and version 2 is left alone', () => {
  const grokOnly = migrateLegacySettings({
    provider: 'openai',
    baseUrl: '',
    apiKey: '',
    models: { default: 'grok-4' },
  }, { grokSignedIn: true, createId: fixedId });
  assert.equal(grokOnly.sources.length, 1);
  assert.equal(grokOnly.sources[0].id, GROK_SOURCE_ID);
  assert.deepEqual(grokOnly.models, { default: { sourceId: GROK_SOURCE_ID, model: 'grok-4' } });
  assert.equal(grokOnly.sources[0].models.includes('grok-4'), true);

  const both = migrateLegacySettings({
    provider: 'openai',
    apiKey: 'sk-legacy-secret-value',
    models: { coder: 'gpt-4o' },
  }, { grokSignedIn: true, createId: fixedId });
  assert.deepEqual(both.sources.map((source) => source.id), [GROK_SOURCE_ID, 'srcfixed1']);
  assert.equal(both.models.coder.sourceId, GROK_SOURCE_ID);
  assert.equal(both.apiKey, '');

  const current = {
    version: 2,
    apiKey: 'leave-this-row',
    sources: [{ id: 'abc', kind: 'api', vendor: 'custom', name: 'C', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k', models: ['m'] }],
    models: { default: { sourceId: 'abc', model: 'm' } },
  };
  const again = migrateLegacySettings(current, { grokSignedIn: true, createId: () => 'nope' });
  assert.equal(again.version, 2);
  assert.equal(again.apiKey, 'leave-this-row');
  assert.equal(again.sources.length, 1);
  assert.equal(again.sources[0].id, 'abc');
  assert.deepEqual(again.models, current.models);
});

test('role routing falls back from the role binding to default, then the first usable source', () => {
  const grok = {
    id: GROK_SOURCE_ID, kind: 'grok', vendor: 'grok', name: 'Grok', baseUrl: '', apiKey: '', models: ['grok-build'],
  };
  const alpha = {
    id: 'aaaa', kind: 'api', vendor: 'custom', name: 'A', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'key-a', models: ['alpha'],
  };
  const beta = {
    id: 'bbbb', kind: 'api', vendor: 'custom', name: 'B', baseUrl: 'http://127.0.0.1:2/v1', apiKey: 'key-b', models: ['beta'],
  };
  const locked = {
    id: 'cccc', kind: 'api', vendor: 'openai', name: 'Locked', baseUrl: 'https://api.openai.com/v1', apiKey: '', models: ['hidden'],
  };
  const settingsRow = {
    sources: [grok, locked, alpha, beta],
    models: {
      coder: { sourceId: 'bbbb', model: 'beta' },
      default: { sourceId: 'aaaa', model: 'alpha' },
      auditor: { sourceId: 'cccc', model: 'hidden' },
    },
  };

  const coder = resolveRoleTarget(settingsRow, { roleId: 'coder' });
  assert.equal(coder.source.id, 'bbbb');
  assert.equal(coder.model, 'beta');

  const tester = resolveRoleTarget(settingsRow, { roleId: 'tester' });
  assert.equal(tester.source.id, 'aaaa');
  assert.equal(tester.model, 'alpha');

  const fallback = resolveRoleTarget(settingsRow, { roleId: 'auditor' });
  assert.equal(fallback.source.id, 'aaaa');
  assert.equal(fallback.model, 'alpha');

  const first = resolveRoleTarget({ sources: [grok, locked, beta] }, { grokSignedIn: false });
  assert.equal(first.source.id, 'bbbb');
  assert.equal(first.model, 'beta');

  const signedIn = resolveRoleTarget({ sources: [grok, alpha] }, { grokSignedIn: true });
  assert.equal(signedIn.source.id, GROK_SOURCE_ID);
  assert.equal(signedIn.model, 'grok-build');
});

test('a role template model prefers a source that lists it, otherwise keeps the resolved source', () => {
  const alpha = {
    id: 'aaaa', kind: 'api', vendor: 'custom', name: 'A', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'key-a', models: ['alpha'],
  };
  const beta = {
    id: 'bbbb', kind: 'api', vendor: 'custom', name: 'B', baseUrl: 'http://127.0.0.1:2/v1', apiKey: 'key-b', models: ['beta'],
  };
  const row = {
    sources: [alpha, beta],
    models: { default: { sourceId: 'aaaa', model: 'alpha' }, coder: { sourceId: 'aaaa', model: 'alpha' } },
  };

  const listed = resolveRoleTarget(row, { roleId: 'coder', model: 'beta' });
  assert.equal(listed.source.id, 'bbbb');
  assert.equal(listed.model, 'beta');

  const hinted = resolveRoleTarget(row, { roleId: 'coder', model: 'role-template' });
  assert.equal(hinted.source.id, 'aaaa');
  assert.equal(hinted.model, 'role-template');

  const nowhere = resolveRoleTarget({ sources: [] }, { roleId: 'coder', model: 'role-template' });
  assert.equal(nowhere, null);
});

test('changing origin without a new key drops the old key', () => {
  const same = applySourcePatch(apiSource(), { baseUrl: 'https://api.openai.com/v1/project' });
  assert.equal(same.error, undefined);
  assert.equal(same.source.apiKey, 'sk-old-secret-value');
  assert.equal(same.source.baseUrl, 'https://api.openai.com/v1/project');

  const moved = applySourcePatch(apiSource(), { baseUrl: 'https://api.deepseek.com/v1' });
  assert.equal(moved.error, 'api key required');
  assert.equal(moved.source, undefined);

  const masked = applySourcePatch(apiSource(), { baseUrl: 'https://example.test/v1', apiKey: '••••alue' });
  assert.equal(masked.error, 'api key required');

  const replaced = applySourcePatch(apiSource(), {
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: 'sk-new-secret-value',
  });
  assert.equal(replaced.error, undefined);
  assert.equal(replaced.source.apiKey, 'sk-new-secret-value');

  const ollama = applySourcePatch(apiSource({
    vendor: 'ollama',
    name: '本地 Ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    apiKey: 'leftover-key',
    models: ['llama'],
  }), { baseUrl: 'http://10.0.0.8:11434/v1' });
  assert.equal(ollama.error, undefined);
  assert.equal(ollama.source.apiKey, '');
  assert.equal(ollama.source.baseUrl, 'http://10.0.0.8:11434/v1');
});

test('role model bindings are rejected when the source or model is not usable', () => {
  const row = { sources: [apiSource({ id: 'src1', models: ['gpt-4o'] })] };
  assert.equal(validateRoleModels(row, {
    default: { sourceId: 'src1', model: 'gpt-4o' },
    coder: null,
  }), '');
  assert.equal(validateRoleModels(row, { default: 'gpt-4o' }), 'invalid model binding');
  assert.equal(validateRoleModels(row, { 'bad id': { sourceId: 'src1', model: 'gpt-4o' } }), 'invalid role id');
  assert.equal(validateRoleModels(row, { default: { sourceId: 'missing', model: 'gpt-4o' } }), 'unknown source');
  assert.equal(validateRoleModels(row, { default: { sourceId: 'src1', model: 'other' } }), 'model not in source');
  assert.equal(validateRoleModels(row, null), 'invalid model binding');
});

test('public settings and public sources do not leak a raw key', () => {
  const source = apiSource({ apiKey: 'sk-live-secret-9999' });
  const pub = publicSource(source);
  assert.equal(pub.apiKey, '••••9999');
  assert.equal(pub.hasApiKey, true);
  assert.equal(JSON.stringify(pub).includes('sk-live-secret-9999'), false);

  const body = settings.publicSettings({
    version: 2,
    provider: 'openai',
    baseUrl: 'https://secret.example/v1',
    apiKey: 'sk-live-secret-9999',
    sources: [source],
    models: { default: { sourceId: 'src1', model: 'gpt-4o' } },
  });
  assert.equal(body.version, 2);
  assert.equal(body.provider, undefined);
  assert.equal(body.baseUrl, undefined);
  assert.equal(body.apiKey, undefined);
  assert.equal(body.hasApiKey, undefined);
  assert.equal(JSON.stringify(body).includes('sk-live-secret-9999'), false);

  const stored = settings.normalizeSettings({
    version: 2,
    provider: 'ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    apiKey: 'sk-live-secret-9999',
    sources: [source],
  });
  assert.equal(stored.provider, undefined);
  assert.equal(stored.baseUrl, undefined);
  assert.equal(stored.apiKey, undefined);
  assert.equal(stored.sources[0].apiKey, 'sk-live-secret-9999');

  const merged = settings.mergeSettings({ version: 2, sources: [], models: {} }, {
    provider: 'ollama',
    baseUrl: 'http://evil.example/v1',
    apiKey: 'sk-should-not-stick',
    language: 'en',
  });
  assert.equal(merged.language, 'en');
  assert.equal(merged.provider, undefined);
  assert.equal(merged.apiKey, undefined);
  assert.equal(JSON.stringify(merged).includes('sk-should-not-stick'), false);
});

test('modelsAfterProbe enables every fetched name only when none are enabled', () => {
  assert.deepEqual(modelsAfterProbe([], ['deepseek-chat', 'deepseek-reasoner']), {
    models: ['deepseek-chat', 'deepseek-reasoner'],
    catalog: ['deepseek-chat', 'deepseek-reasoner'],
  });
  assert.deepEqual(modelsAfterProbe(['keep-me', 'gone'], ['new-one', 'keep-me']), {
    models: ['keep-me', 'gone'],
    catalog: ['new-one', 'keep-me'],
  });
  assert.deepEqual(modelsAfterProbe(['only'], []), {
    models: ['only'],
    catalog: [],
  });
});

test('probeModels reports success, failure, timeout, and redacts keys', async () => {
  const secret = 'sk-live-secret-9999';
  const ok = await probeModels({
    baseUrl: 'http://127.0.0.1:9/v1',
    apiKey: secret,
    fetchImpl: async (url, opts) => {
      assert.equal(url, 'http://127.0.0.1:9/v1/models');
      assert.equal(opts.headers.authorization, `Bearer ${secret}`);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: [{ id: 'alpha' }, { id: 'alpha' }, { id: 'beta' }] }),
      };
    },
  });
  assert.deepEqual(ok, { ok: true, models: ['alpha', 'beta'] });

  const failed = await probeModels({
    baseUrl: 'http://127.0.0.1:9/v1',
    apiKey: secret,
    fetchImpl: async () => ({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ error: { message: `rejected ${secret}` } }),
    }),
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'auth');
  assert.equal(failed.status, 401);
  assert.equal(failed.error.includes(secret), false);
  assert.match(failed.error, /sk-\*\*\*|rejected/);

  const timedOut = await probeModels({
    baseUrl: 'http://127.0.0.1:9/v1',
    apiKey: secret,
    fetchImpl: async () => {
      const err = new Error(`The operation was aborted due to timeout ${secret}`);
      err.name = 'TimeoutError';
      throw err;
    },
  });
  assert.deepEqual(timedOut, { ok: false, error: 'timeout', code: 'timeout' });

  const thrown = await probeModels({
    baseUrl: 'http://127.0.0.1:9/v1',
    apiKey: secret,
    fetchImpl: async () => {
      throw new Error(`connect failed ${secret}`);
    },
  });
  assert.equal(thrown.ok, false);
  assert.equal(thrown.code, 'network');
  assert.equal(thrown.error.includes(secret), false);
  assert.match(thrown.error, /connect failed/);
});

test('probeModels assigns a code for network, json, 403, 404, and other HTTP errors', async () => {
  const secret = 'sk-live-secret-9999';
  const refused = await probeModels({
    baseUrl: 'http://127.0.0.1:9/v1',
    apiKey: secret,
    fetchImpl: async () => {
      const err = new TypeError('fetch failed');
      err.cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), { code: 'ECONNREFUSED' });
      throw err;
    },
  });
  assert.deepEqual(refused, { ok: false, error: 'fetch failed', code: 'network' });

  const html = await probeModels({
    baseUrl: 'http://127.0.0.1:9/v1',
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => '<html>nope</html>' }),
  });
  assert.deepEqual(html, { ok: false, error: 'invalid JSON', code: 'bad_json' });

  const forbidden = await probeModels({
    baseUrl: 'http://127.0.0.1:9/v1',
    fetchImpl: async () => ({ ok: false, status: 403, text: async () => '' }),
  });
  assert.deepEqual(forbidden, { ok: false, error: 'HTTP 403', code: 'auth', status: 403 });

  const missing = await probeModels({
    baseUrl: 'http://127.0.0.1:9/v1',
    fetchImpl: async () => ({ ok: false, status: 404, text: async () => 'missing' }),
  });
  assert.deepEqual(missing, { ok: false, error: 'missing', code: 'not_found', status: 404 });

  const upstream = await probeModels({
    baseUrl: 'http://127.0.0.1:9/v1',
    apiKey: secret,
    fetchImpl: async () => ({
      ok: false,
      status: 502,
      text: async () => JSON.stringify({ error: { message: `overloaded ${secret}` } }),
    }),
  });
  assert.equal(upstream.code, 'http');
  assert.equal(upstream.status, 502);
  assert.equal(upstream.error.includes(secret), false);
  assert.match(upstream.error, /overloaded/);
});

test('stored lastTest keeps probe code and status and still redacts the error', () => {
  const stamped = '2026-10-14T00:00:00.000Z';
  const kept = publicSource(apiSource({
    lastTest: { ok: false, at: stamped, error: 'HTTP 404', code: 'not_found', status: 404, extra: 'no' },
  }));
  assert.deepEqual(kept.lastTest, { ok: false, at: stamped, error: 'HTTP 404', code: 'not_found', status: 404 });

  const dropped = publicSource(apiSource({
    lastTest: { ok: false, at: stamped, error: 'sk-live-secret-9999 blew up', code: 'explode', status: 99 },
  }));
  assert.equal(dropped.lastTest.code, undefined);
  assert.equal(dropped.lastTest.status, undefined);
  assert.equal(dropped.lastTest.error.includes('sk-live-secret-9999'), false);

  assert.deepEqual(probeFailurePayload({ error: 'timeout', code: 'timeout', status: 'nope' }), {
    ok: false,
    error: 'timeout',
    code: 'timeout',
  });
});

test('contextWindows are kept, merged, deleted, and invalid patch values error', () => {
  const kept = normalizeSources([apiSource({
    contextWindows: {
      ' gpt-4o ': 256000,
      'bad': 12,
      '': 8000,
      'gpt-4.1': 200000,
      nope: '128000',
      proto: null,
    },
  })]);
  assert.deepEqual(kept[0].contextWindows, { 'gpt-4o': 256000, 'gpt-4.1': 200000 });

  const missing = normalizeSources([apiSource()]);
  assert.equal(missing[0].contextWindows, undefined);

  const grok = normalizeSources([{
    id: GROK_SOURCE_ID,
    kind: 'grok',
    models: ['grok-build'],
    contextWindows: { 'grok-build': 256000, skip: 1 },
  }]);
  assert.deepEqual(grok[0].contextWindows, { 'grok-build': 256000 });

  const merged = applySourcePatch(apiSource({
    models: ['gpt-4o', 'gpt-4.1'],
    contextWindows: { 'gpt-4o': 256000, 'gpt-4.1': 200000 },
  }), { contextWindows: { 'gpt-4o': 512000, extra: 64000 } });
  assert.equal(merged.error, undefined);
  assert.deepEqual(merged.source.contextWindows, {
    'gpt-4o': 512000,
    'gpt-4.1': 200000,
    extra: 64000,
  });

  const cleared = applySourcePatch(merged.source, { contextWindows: { extra: null, 'gpt-4.1': null } });
  assert.deepEqual(cleared.source.contextWindows, { 'gpt-4o': 512000 });

  const emptied = applySourcePatch(cleared.source, { contextWindows: { 'gpt-4o': null } });
  assert.equal(emptied.error, undefined);
  assert.equal(emptied.source.contextWindows, undefined);

  const grokPatched = applySourcePatch(grok[0], { contextWindows: { 'grok-build': 256000 } });
  assert.equal(grokPatched.error, undefined);
  assert.equal(grokPatched.source.contextWindows['grok-build'], 256000);

  assert.equal(applySourcePatch(apiSource(), { contextWindows: { 'gpt-4o': 12 } }).error, 'invalid context window');
  assert.equal(applySourcePatch(apiSource(), { contextWindows: { 'gpt-4o': 10000001 } }).error, 'invalid context window');
  assert.equal(applySourcePatch(apiSource(), { contextWindows: { 'gpt-4o': 256000.5 } }).error, 'invalid context window');
  assert.equal(applySourcePatch(apiSource(), { contextWindows: { 'gpt-4o': '256000' } }).error, 'invalid context window');
  assert.equal(applySourcePatch(apiSource(), { contextWindows: ['gpt-4o'] }).error, 'invalid context window');
  assert.equal(applySourcePatch(apiSource(), { contextWindows: null }).error, 'invalid context window');
});

test('publicSource returns stored contextWindows and defaultContextWindow', () => {
  const pub = publicSource(apiSource({
    models: ['gpt-4o'],
    contextWindows: { 'gpt-4o': 256000 },
  }));
  assert.deepEqual(pub.contextWindows, { 'gpt-4o': 256000 });
  assert.equal(pub.defaultContextWindow, usage.contextWindowFromEnv());
  assert.deepEqual(pub.defaultContextWindows, { 'gpt-4o': 128000 });

  const plain = publicSource(apiSource());
  assert.equal(plain.contextWindows, undefined);
  assert.equal(plain.defaultContextWindow, usage.contextWindowFromEnv());
  assert.deepEqual(plain.defaultContextWindows, { 'gpt-4o': 128000 });

  const flash = publicSource(apiSource({
    vendor: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-flash', 'not-a-real-model'],
  }));
  assert.equal(flash.defaultContextWindow, usage.contextWindowFromEnv());
  assert.equal(flash.defaultContextWindows['deepseek-flash'], 1_000_000);
  assert.equal(flash.defaultContextWindows['not-a-real-model'], usage.contextWindowFromEnv());
});

test('conversation context window follows the resolved model, else stays unset', () => {
  const alpha = apiSource({ id: 'aaaa', models: ['alpha'], contextWindows: { alpha: 256000 } });
  const beta = apiSource({
    id: 'bbbb',
    name: 'B',
    baseUrl: 'http://127.0.0.1:2/v1',
    apiKey: 'key-b',
    models: ['beta'],
  });
  const settings = {
    sources: [alpha, beta],
    models: { default: { sourceId: 'aaaa', model: 'alpha' } },
  };
  assert.equal(contextWindowForModel(alpha, 'alpha'), 256000);
  assert.equal(contextWindowForModel(alpha, 'other'), 128000);
  const flashSource = apiSource({
    id: 'cccc',
    vendor: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-flash'],
  });
  assert.equal(contextWindowForModel(flashSource, 'deepseek-flash'), 1_000_000);
  assert.equal(contextWindowForModel({
    ...flashSource,
    contextWindows: { 'deepseek-flash': 256000 },
  }, 'deepseek-flash'), 256000);
  assert.equal(contextWindowForConversation(settings, { roleId: null }), 256000);
  assert.equal(contextWindowForConversation(settings, {
    modelSourceId: 'bbbb',
    modelId: 'beta',
  }), 128000);
  assert.equal(contextWindowForConversation({ sources: [] }, { roleId: null }), null);
});

test('conversation model patch accepts a listed pair and rejects unknown source or model', () => {
  const settings = {
    sources: [apiSource({ id: 'src1', models: ['gpt-4o', 'gpt-4.1'] })],
  };
  assert.deepEqual(resolveConversationModelPatch(settings, {}), { present: false });
  assert.deepEqual(resolveConversationModelPatch(settings, { modelSourceId: null, modelId: null }), {
    present: true,
    ok: true,
    value: { modelSourceId: null, modelId: null },
  });
  assert.deepEqual(resolveConversationModelPatch(settings, { modelSourceId: 'src1', modelId: 'gpt-4.1' }), {
    present: true,
    ok: true,
    value: { modelSourceId: 'src1', modelId: 'gpt-4.1' },
  });
  assert.deepEqual(resolveConversationModelPatch(settings, { modelSourceId: 'missing', modelId: 'gpt-4o' }), {
    present: true,
    ok: false,
    errors: ['unknown model source'],
  });
  assert.deepEqual(resolveConversationModelPatch(settings, { modelSourceId: 'src1', modelId: 'nope' }), {
    present: true,
    ok: false,
    errors: ['unknown model'],
  });
  assert.equal(resolveConversationModelPatch(settings, { modelSourceId: 'src1' }).ok, false);
});
