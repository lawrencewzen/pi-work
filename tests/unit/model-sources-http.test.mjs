import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { request as serverRequest, startServer, stopServer } from './_server.mjs';

const TOKEN = 'unit-model-sources-token';
const request = (base, method, apiPath, body) => serverRequest(base, method, apiPath, body, TOKEN);

function chatCompletionSse(text) {
  const chunk = (delta, finish) => JSON.stringify({
    id: 'chatcmpl-source',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  return [
    `data: ${chunk({ role: 'assistant', content: text }, null)}`,
    '',
    `data: ${chunk({}, 'stop')}`,
    '',
    'data: [DONE]',
    '',
    '',
  ].join('\n');
}

function startFake(label) {
  const hits = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      hits.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization || '',
        body: Buffer.concat(chunks).toString('utf8'),
      });
      if (req.method === 'POST' && String(req.url).includes('/chat/completions')) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.end(chatCompletionSse(`reply-${label}`));
        return;
      }
      const payload = req.url.endsWith('/models')
        ? { data: [{ id: label }] }
        : { choices: [{ message: { role: 'assistant', content: `reply-${label}` } }] };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        label,
        hits,
        baseUrl: `http://127.0.0.1:${port}/v1`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

function writeSettings(dataDir, value) {
  const db = new DatabaseSync(path.join(dataDir, 'weft.sqlite'));
  db.prepare('INSERT INTO settings (id, json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json')
    .run('app', JSON.stringify(value));
  db.close();
}

function readSettings(dataDir) {
  const db = new DatabaseSync(path.join(dataDir, 'weft.sqlite'));
  const row = db.prepare('SELECT json FROM settings WHERE id = ?').get('app');
  db.close();
  return JSON.parse(row.json);
}

async function openConversation(base) {
  const ws = await request(base, 'POST', '/api/workspaces', { name: 'route' });
  assert.equal(ws.status, 201);
  const conv = await request(base, 'POST', `/api/workspaces/${ws.body.id}/conversations`, { title: 'hi' });
  assert.equal(conv.status, 201);
  return conv.body.id;
}

async function waitFinished(base, id) {
  for (let i = 0; i < 40; i += 1) {
    const res = await request(base, 'GET', `/api/conversations/${id}`);
    if (res.body?.status === 'done' || res.body?.status === 'failed') return res.body;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`conversation ${id} did not finish`);
}

function chatHits(fake) {
  return fake.hits.filter((hit) => hit.method === 'POST' && hit.url.includes('/chat/completions'));
}

test('default and coder turns hit their own sources with their own keys', async () => {
  const [alpha, beta] = await Promise.all([startFake('alpha'), startFake('beta')]);
  const srv = await startServer({ token: TOKEN, env: { WEFT_RETRY_MAX: '2' } });
  try {
    const sourceA = await request(srv.base, 'POST', '/api/sources', {
      vendor: 'custom',
      name: 'A',
      baseUrl: alpha.baseUrl,
      apiKey: 'key-alpha-secret',
      models: ['alpha'],
    });
    const sourceB = await request(srv.base, 'POST', '/api/sources', {
      vendor: 'custom',
      name: 'B',
      baseUrl: beta.baseUrl,
      apiKey: 'key-beta-secret',
      models: ['beta'],
    });
    assert.equal(sourceA.status, 201);
    assert.equal(sourceB.status, 201);
    assert.equal(JSON.stringify(sourceA.body).includes('key-alpha-secret'), false);

    const saved = await request(srv.base, 'PUT', '/api/settings', {
      models: {
        default: { sourceId: sourceA.body.id, model: 'alpha' },
        coder: { sourceId: sourceB.body.id, model: 'beta' },
      },
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.provider, undefined);
    assert.equal(saved.body.baseUrl, undefined);
    assert.equal(saved.body.apiKey, undefined);
    assert.equal(saved.body.hasApiKey, undefined);
    assert.deepEqual(saved.body.models.default, { sourceId: sourceA.body.id, model: 'alpha' });
    assert.equal(saved.body.models.coder, undefined);

    const id = await openConversation(srv.base);
    const first = await request(srv.base, 'POST', `/api/conversations/${id}/messages`, { text: 'default turn' });
    assert.equal(first.status, 202);
    const done = await waitFinished(srv.base, id);
    assert.equal(done.status, 'done');
    assert.equal(done.messages.some((message) => message.role === 'assistant' && message.text === 'reply-alpha'), true);
    assert.equal(chatHits(alpha).length, 1);
    assert.equal(chatHits(beta).length, 0);
    assert.equal(chatHits(alpha)[0].authorization, 'Bearer key-alpha-secret');
    assert.equal(JSON.parse(chatHits(alpha)[0].body).model, 'alpha');

    const switched = await request(srv.base, 'PATCH', `/api/conversations/${id}`, {
      modelSourceId: sourceB.body.id,
      modelId: 'beta',
    });
    assert.equal(switched.status, 200);
    assert.equal(switched.body.modelSourceId, sourceB.body.id);
    assert.equal(switched.body.modelId, 'beta');
    assert.equal(Object.hasOwn(switched.body, 'roleId'), false);
    const second = await request(srv.base, 'POST', `/api/conversations/${id}/messages`, { text: 'coder turn' });
    assert.equal(second.status, 202);
    const coderDone = await waitFinished(srv.base, id);
    assert.equal(coderDone.status, 'done');
    assert.equal(coderDone.messages.some((message) => message.role === 'assistant' && message.text === 'reply-beta'), true);
    assert.equal(chatHits(beta).length, 1);
    assert.equal(chatHits(beta)[0].authorization, 'Bearer key-beta-secret');
    assert.equal(JSON.parse(chatHits(beta)[0].body).model, 'beta');
    assert.equal(chatHits(alpha).length, 1);
  } finally {
    await stopServer(srv);
    await Promise.all([alpha.close(), beta.close()]);
  }
});

test('conversation model is saved, validated, and used instead of the role binding', async () => {
  const [alpha, beta] = await Promise.all([startFake('alpha'), startFake('beta')]);
  const srv = await startServer({ token: TOKEN, env: { WEFT_RETRY_MAX: '2' } });
  try {
    const sourceA = await request(srv.base, 'POST', '/api/sources', {
      vendor: 'custom',
      name: 'A',
      baseUrl: alpha.baseUrl,
      apiKey: 'key-alpha-secret',
      models: ['alpha'],
    });
    const sourceB = await request(srv.base, 'POST', '/api/sources', {
      vendor: 'custom',
      name: 'B',
      baseUrl: beta.baseUrl,
      apiKey: 'key-beta-secret',
      models: ['beta'],
    });
    assert.equal(sourceA.status, 201);
    assert.equal(sourceB.status, 201);
    const bound = await request(srv.base, 'PUT', '/api/settings', {
      models: { default: { sourceId: sourceA.body.id, model: 'alpha' } },
    });
    assert.equal(bound.status, 200);

    const ws = await request(srv.base, 'POST', '/api/workspaces', { name: 'pinned' });
    assert.equal(ws.status, 201);
    const unknownSource = await request(
      srv.base,
      'POST',
      `/api/workspaces/${ws.body.id}/conversations`,
      { title: 'bad-source', modelSourceId: 'missing', modelId: 'alpha' },
    );
    assert.equal(unknownSource.status, 400);
    assert.deepEqual(unknownSource.body.errors, ['unknown model source']);
    const unknownModel = await request(
      srv.base,
      'POST',
      `/api/workspaces/${ws.body.id}/conversations`,
      { title: 'bad-model', modelSourceId: sourceA.body.id, modelId: 'beta' },
    );
    assert.equal(unknownModel.status, 400);
    assert.deepEqual(unknownModel.body.errors, ['unknown model']);

    const created = await request(srv.base, 'POST', `/api/workspaces/${ws.body.id}/conversations`, {
      title: 'pinned',
      modelSourceId: sourceB.body.id,
      modelId: 'beta',
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.modelSourceId, sourceB.body.id);
    assert.equal(created.body.modelId, 'beta');
    const got = await request(srv.base, 'GET', `/api/conversations/${created.body.id}`);
    assert.equal(got.status, 200);
    assert.equal(got.body.modelSourceId, sourceB.body.id);
    assert.equal(got.body.modelId, 'beta');

    const sent = await request(srv.base, 'POST', `/api/conversations/${created.body.id}/messages`, { text: 'use pinned' });
    assert.equal(sent.status, 202);
    const done = await waitFinished(srv.base, created.body.id);
    assert.equal(done.status, 'done');
    assert.equal(done.messages.some((message) => message.role === 'assistant' && message.text === 'reply-beta'), true);
    assert.equal(chatHits(beta).length, 1);
    assert.equal(chatHits(alpha).length, 0);
    assert.equal(JSON.parse(chatHits(beta)[0].body).model, 'beta');

    const cleared = await request(srv.base, 'PATCH', `/api/conversations/${created.body.id}`, {
      modelSourceId: null,
      modelId: null,
    });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.modelSourceId, null);
    assert.equal(cleared.body.modelId, null);
    const patchedUnknown = await request(srv.base, 'PATCH', `/api/conversations/${created.body.id}`, {
      modelSourceId: sourceB.body.id,
      modelId: 'alpha',
    });
    assert.equal(patchedUnknown.status, 400);
    assert.deepEqual(patchedUnknown.body.errors, ['unknown model']);
  } finally {
    await stopServer(srv);
    await Promise.all([alpha.close(), beta.close()]);
  }
});

test('settings ignore legacy fields and source tests keep unsaved origin rules', async () => {
  const [alpha, beta] = await Promise.all([startFake('alpha'), startFake('beta')]);
  const srv = await startServer({ token: TOKEN, env: { WEFT_RETRY_MAX: '2' } });
  try {
    const created = await request(srv.base, 'POST', '/api/sources', {
      vendor: 'custom',
      name: 'A',
      baseUrl: alpha.baseUrl,
      apiKey: 'key-alpha-secret',
      models: ['alpha'],
    });
    assert.equal(created.status, 201);
    const sourceId = created.body.id;

    const probed = await request(srv.base, 'POST', '/api/sources/test', { sourceId });
    assert.equal(probed.status, 200);
    assert.equal(probed.body.ok, true);
    assert.deepEqual(probed.body.models, ['alpha']);
    const afterProbe = await request(srv.base, 'GET', '/api/settings');
    const storedProbe = afterProbe.body.sources.find((source) => source.id === sourceId);
    assert.equal(storedProbe.lastTest.ok, true);
    const stamped = storedProbe.lastTest.at;

    const ignored = await request(srv.base, 'PUT', '/api/settings', {
      provider: 'ollama',
      baseUrl: 'http://evil.example/v1',
      apiKey: 'sk-should-not-stick',
      hasApiKey: true,
      language: 'en',
    });
    assert.equal(ignored.status, 200);
    assert.equal(ignored.body.language, 'en');
    assert.equal(ignored.body.provider, undefined);
    assert.equal(ignored.body.apiKey, undefined);
    assert.equal(ignored.body.hasApiKey, undefined);
    const row = readSettings(srv.dataDir);
    assert.equal(row.apiKey, undefined);
    assert.equal(row.provider, undefined);
    assert.equal(row.baseUrl, undefined);
    assert.equal(JSON.stringify(row).includes('sk-should-not-stick'), false);
    assert.equal(row.sources.find((source) => source.id === sourceId).apiKey, 'key-alpha-secret');

    const moved = await request(srv.base, 'POST', '/api/sources/test', {
      sourceId,
      baseUrl: 'https://example.test/v1',
    });
    assert.equal(moved.status, 400);
    assert.equal(moved.body.error, 'api key required');

    const overlay = await request(srv.base, 'POST', '/api/sources/test', {
      sourceId,
      baseUrl: beta.baseUrl,
      apiKey: 'key-beta-secret',
    });
    assert.equal(overlay.status, 200);
    assert.deepEqual(overlay.body.models, ['beta']);
    const afterOverlay = await request(srv.base, 'GET', '/api/settings');
    const still = afterOverlay.body.sources.find((source) => source.id === sourceId);
    assert.equal(still.lastTest.at, stamped);
    assert.equal(still.baseUrl, alpha.baseUrl);
    assert.equal(still.apiKey.includes('key-beta-secret'), false);

    const sameOrigin = await request(srv.base, 'POST', '/api/sources/test', {
      sourceId,
      baseUrl: `${alpha.baseUrl}/extra`,
    });
    assert.equal(sameOrigin.status, 200);
    assert.equal(sameOrigin.body.ok, true);
    const authHit = alpha.hits.find((hit) => hit.url.endsWith('/models') && hit.authorization === 'Bearer key-alpha-secret');
    assert.ok(authHit);
  } finally {
    await stopServer(srv);
    await Promise.all([alpha.close(), beta.close()]);
  }
});

test('a legacy settings row is migrated once and the old key is not kept at the top level', async () => {
  const srv = await startServer({ token: TOKEN, env: { WEFT_RETRY_MAX: '2' } });
  await stopServer(srv);
  writeSettings(srv.dataDir, {
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-legacy-secret-value',
    models: { coder: 'gpt-4o' },
    language: 'en',
  });

  const restarted = await startServer({
    token: TOKEN,
    dataDir: srv.dataDir,
    env: { WEFT_RETRY_MAX: '2' },
    authJson: false,
  });
  try {
    const settings = await request(restarted.base, 'GET', '/api/settings');
    assert.equal(settings.status, 200);
    assert.equal(settings.body.provider, undefined);
    assert.equal(settings.body.baseUrl, undefined);
    assert.equal(settings.body.apiKey, undefined);
    assert.equal(settings.body.hasApiKey, undefined);
    assert.equal(JSON.stringify(settings.body).includes('sk-legacy-secret-value'), false);
    assert.equal(settings.body.sources.length, 1);
    assert.equal(settings.body.models.coder, undefined);
    assert.equal(settings.body.models.default, undefined);
    assert.equal(settings.body.language, 'en');

    const row = readSettings(srv.dataDir);
    assert.equal(row.apiKey, undefined);
    assert.equal(row.provider, undefined);
    assert.equal(row.baseUrl, undefined);
    assert.equal(row.sources[0].apiKey, 'sk-legacy-secret-value');
  } finally {
    await stopServer(restarted);
  }
});

test('an untouched legacy preset does not create a source or keep string models', async () => {
  const srv = await startServer({ token: TOKEN, env: { WEFT_RETRY_MAX: '2' } });
  await stopServer(srv);
  writeSettings(srv.dataDir, {
    provider: 'openai',
    baseUrl: '',
    apiKey: '',
    models: { default: 'gpt-4o-leftover' },
    language: 'zh',
  });
  const restarted = await startServer({
    token: TOKEN,
    dataDir: srv.dataDir,
    env: { WEFT_RETRY_MAX: '2' },
    authJson: false,
  });
  try {
    const settings = await request(restarted.base, 'GET', '/api/settings');
    assert.equal(settings.status, 200);
    assert.deepEqual(settings.body.sources, []);
    assert.deepEqual(settings.body.models, {});
    assert.equal(settings.body.runtime, 'none');
    const row = readSettings(srv.dataDir);
    assert.equal(JSON.stringify(row).includes('gpt-4o-leftover'), false);
    assert.equal(row.apiKey, undefined);
  } finally {
    await stopServer(restarted);
  }
});

test('POST /api/sources/test keeps the redacted error and stores a probe code', async () => {
  const secret = 'sk-probe-secret-7788';
  const fake = http.createServer((req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `rejected ${secret}` } }));
  });
  const baseUrl = await new Promise((resolve) => {
    fake.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${fake.address().port}/v1`));
  });
  const srv = await startServer({ token: TOKEN, env: { WEFT_RETRY_MAX: '2' } });
  try {
    const created = await request(srv.base, 'POST', '/api/sources', {
      vendor: 'custom',
      name: 'Probe',
      baseUrl,
      apiKey: secret,
      models: [],
    });
    assert.equal(created.status, 201);
    const probed = await request(srv.base, 'POST', '/api/sources/test', { sourceId: created.body.id });
    assert.equal(probed.status, 200);
    assert.equal(probed.body.ok, false);
    assert.equal(probed.body.code, 'auth');
    assert.equal(probed.body.status, 401);
    assert.match(probed.body.error, /rejected/);
    assert.equal(probed.text.includes(secret), false);
    const settings = await request(srv.base, 'GET', '/api/settings');
    const stored = settings.body.sources.find((source) => source.id === created.body.id);
    assert.equal(stored.lastTest.ok, false);
    assert.equal(stored.lastTest.code, 'auth');
    assert.equal(stored.lastTest.status, 401);
    assert.deepEqual(stored.models, []);
    assert.equal(stored.catalog, undefined);
    assert.equal(JSON.stringify(settings.body).includes(secret), false);
  } finally {
    await stopServer(srv);
    await new Promise((resolve) => fake.close(resolve));
  }
});

function modelsServer(ids) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: ids.map((id) => ({ id })) }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

test('POST /api/sources/test enables fetched models when none are enabled, and keeps every name already enabled', async () => {
  const emptyUpstream = await modelsServer(['deepseek-chat', 'deepseek-reasoner']);
  const keptUpstream = await modelsServer(['new-one', 'keep-me']);
  const srv = await startServer({ token: TOKEN, env: { WEFT_RETRY_MAX: '2' } });
  try {
    const empty = await request(srv.base, 'POST', '/api/sources', {
      vendor: 'custom',
      name: 'DeepSeek',
      baseUrl: emptyUpstream.baseUrl,
      apiKey: 'sk-empty-models-key1',
      models: [],
    });
    assert.equal(empty.status, 201);
    const filled = await request(srv.base, 'POST', '/api/sources/test', { sourceId: empty.body.id });
    assert.equal(filled.status, 200);
    assert.equal(filled.body.ok, true);
    assert.deepEqual(filled.body.models, ['deepseek-chat', 'deepseek-reasoner']);
    const afterEmpty = await request(srv.base, 'GET', '/api/settings');
    const storedEmpty = afterEmpty.body.sources.find((source) => source.id === empty.body.id);
    assert.deepEqual(storedEmpty.models, ['deepseek-chat', 'deepseek-reasoner']);
    assert.deepEqual(storedEmpty.catalog, ['deepseek-chat', 'deepseek-reasoner']);
    assert.equal(storedEmpty.lastTest.ok, true);

    const kept = await request(srv.base, 'POST', '/api/sources', {
      vendor: 'custom',
      name: 'Kept',
      baseUrl: keptUpstream.baseUrl,
      apiKey: 'sk-kept-models-key1',
      models: ['keep-me', 'gone'],
    });
    assert.equal(kept.status, 201);
    const narrowed = await request(srv.base, 'POST', '/api/sources/test', { sourceId: kept.body.id });
    assert.equal(narrowed.body.ok, true);
    const afterKept = await request(srv.base, 'GET', '/api/settings');
    const storedKept = afterKept.body.sources.find((source) => source.id === kept.body.id);
    assert.deepEqual(storedKept.models, ['keep-me', 'gone']);
    assert.deepEqual(storedKept.catalog, ['new-one', 'keep-me']);

    const overridden = await request(srv.base, 'POST', '/api/sources/test', {
      sourceId: empty.body.id,
      vendor: 'custom',
      baseUrl: emptyUpstream.baseUrl,
    });
    assert.equal(overridden.body.ok, true);
    const afterOverride = await request(srv.base, 'GET', '/api/settings');
    const untouched = afterOverride.body.sources.find((source) => source.id === empty.body.id);
    assert.deepEqual(untouched.models, ['deepseek-chat', 'deepseek-reasoner']);
  } finally {
    await stopServer(srv);
    await emptyUpstream.close();
    await keptUpstream.close();
  }
});

test('PUT contextWindows merges, deletes with null, rejects invalid values, and conversation GET follows the model', async () => {
  const fake = await startFake('alpha');
  const srv = await startServer({ token: TOKEN, env: { WEFT_LLM: 'faux', WEFT_RETRY_MAX: '2' } });
  try {
    const sourceA = await request(srv.base, 'POST', '/api/sources', {
      vendor: 'custom',
      name: 'A',
      baseUrl: fake.baseUrl,
      apiKey: 'key-alpha-secret',
      models: ['alpha', 'beta'],
    });
    assert.equal(sourceA.status, 201);
    assert.equal(sourceA.body.contextWindows, undefined);
    assert.equal(sourceA.body.defaultContextWindow, 128000);
    assert.deepEqual(sourceA.body.defaultContextWindows, { alpha: 128000, beta: 128000 });
    const sourceId = sourceA.body.id;

    const bound = await request(srv.base, 'PUT', '/api/settings', {
      models: { default: { sourceId, model: 'alpha' } },
    });
    assert.equal(bound.status, 200);
    assert.equal(bound.body.sources.find((source) => source.id === sourceId).defaultContextWindow, 128000);

    const patched = await request(srv.base, 'PUT', `/api/sources/${sourceId}`, {
      contextWindows: { alpha: 256000 },
    });
    assert.equal(patched.status, 200);
    assert.deepEqual(patched.body.contextWindows, { alpha: 256000 });
    assert.equal(patched.body.defaultContextWindow, 128000);

    const merged = await request(srv.base, 'PUT', `/api/sources/${sourceId}`, {
      contextWindows: { beta: 64000 },
    });
    assert.equal(merged.status, 200);
    assert.deepEqual(merged.body.contextWindows, { alpha: 256000, beta: 64000 });

    const settings = await request(srv.base, 'GET', '/api/settings');
    const listed = settings.body.sources.find((source) => source.id === sourceId);
    assert.deepEqual(listed.contextWindows, { alpha: 256000, beta: 64000 });
    assert.equal(listed.defaultContextWindow, 128000);

    const invalid = await request(srv.base, 'PUT', `/api/sources/${sourceId}`, {
      contextWindows: { alpha: 12 },
    });
    assert.equal(invalid.status, 400);
    assert.deepEqual(invalid.body, { error: 'invalid context window' });
    const notInt = await request(srv.base, 'PUT', `/api/sources/${sourceId}`, {
      contextWindows: { alpha: 256000.5 },
    });
    assert.equal(notInt.status, 400);
    assert.deepEqual(notInt.body, { error: 'invalid context window' });
    const still = await request(srv.base, 'GET', '/api/settings');
    assert.deepEqual(still.body.sources.find((source) => source.id === sourceId).contextWindows, {
      alpha: 256000,
      beta: 64000,
    });

    const cidDefault = await openConversation(srv.base);
    const gotDefault = await request(srv.base, 'GET', `/api/conversations/${cidDefault}`);
    assert.equal(gotDefault.status, 200);
    assert.equal(gotDefault.body.contextWindow, 256000);

    const ws = await request(srv.base, 'POST', '/api/workspaces', { name: 'pinned-window' });
    assert.equal(ws.status, 201);
    const pinned = await request(srv.base, 'POST', `/api/workspaces/${ws.body.id}/conversations`, {
      title: 'beta-window',
      modelSourceId: sourceId,
      modelId: 'beta',
    });
    assert.equal(pinned.status, 201);
    const gotPinned = await request(srv.base, 'GET', `/api/conversations/${pinned.body.id}`);
    assert.equal(gotPinned.body.contextWindow, 64000);

    const unset = await request(srv.base, 'PUT', `/api/sources/${sourceId}`, {
      contextWindows: { beta: null },
    });
    assert.equal(unset.status, 200);
    assert.deepEqual(unset.body.contextWindows, { alpha: 256000 });
    const afterUnset = await request(srv.base, 'GET', `/api/conversations/${pinned.body.id}`);
    assert.equal(afterUnset.body.contextWindow, 128000);

    const cleared = await request(srv.base, 'PUT', `/api/sources/${sourceId}`, {
      contextWindows: { alpha: null },
    });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.contextWindows, undefined);
    const afterClear = await request(srv.base, 'GET', `/api/conversations/${cidDefault}`);
    assert.equal(afterClear.body.contextWindow, 128000);
  } finally {
    await stopServer(srv);
    await fake.close();
  }
});

test('settings sources expose per-model defaultContextWindows from the catalog', async () => {
  const srv = await startServer({ token: TOKEN, env: { WEFT_LLM: 'faux', WEFT_RETRY_MAX: '2' } });
  try {
    const created = await request(srv.base, 'POST', '/api/sources', {
      vendor: 'deepseek',
      name: 'DeepSeek',
      apiKey: 'key-flash-secret',
      models: ['deepseek-flash', 'ghost-model'],
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.defaultContextWindow, 128000);
    assert.equal(created.body.defaultContextWindows['deepseek-flash'], 1_000_000);
    assert.equal(created.body.defaultContextWindows['ghost-model'], 128000);

    const listed = await request(srv.base, 'GET', '/api/settings');
    const source = listed.body.sources.find((item) => item.id === created.body.id);
    assert.equal(source.defaultContextWindows['deepseek-flash'], 1_000_000);
  } finally {
    await stopServer(srv);
  }
});
