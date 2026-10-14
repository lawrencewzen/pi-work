import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ROOT } from './_root.mjs';

const TOKEN = 'unit-model-sources-token';
const STRIP = [
  'PI_WORK_LLM',
  'PI_WORK_FAUX_SCRIPT',
  'LLM_API',
  'LLM_API_KEY',
  'LLM_BASE_URL',
  'LLM_MODEL',
  'PI_WORK_GROK_AUTH',
  'GROK_HOME',
];

function childEnv(dataDir, authFile) {
  const env = { ...process.env };
  for (const key of STRIP) delete env[key];
  return {
    ...env,
    PORT: '0',
    PI_WORK_DATA_DIR: dataDir,
    PI_WORK_TOKEN: TOKEN,
    PI_WORK_GROK_AUTH: authFile,
    PI_WORK_RETRY_BASE_MS: '20',
    PI_WORK_RETRY_MAX: '2',
    PI_WORK_STALL_MS: '5000',
  };
}

async function startServer() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'piw-sources-'));
  const authFile = path.join(dataDir, 'auth.json');
  await fs.writeFile(authFile, '{}\n', { mode: 0o600 });
  const proc = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    env: childEnv(dataDir, authFile),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server not ready:\n${log}`)), 15000);
    const onData = (buf) => {
      log += buf;
      const match = log.match(/PI_WORK_READY (http:\/\/\S+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited ${code}:\n${log}`));
    });
  });
  proc.removeAllListeners('exit');
  return { proc, base, dataDir };
}

function stopProcess(proc) {
  return new Promise((resolve) => {
    if (proc.exitCode != null) return resolve();
    const timer = setTimeout(() => proc.kill('SIGKILL'), 2000);
    proc.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    proc.kill('SIGTERM');
  });
}

async function request(base, method, apiPath, body) {
  const res = await fetch(base + apiPath, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, text };
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
  const db = new DatabaseSync(path.join(dataDir, 'pi-work.sqlite'));
  db.prepare('INSERT INTO settings (id, json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json')
    .run('app', JSON.stringify(value));
  db.close();
}

function readSettings(dataDir) {
  const db = new DatabaseSync(path.join(dataDir, 'pi-work.sqlite'));
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
  const srv = await startServer();
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

    const switched = await request(srv.base, 'PATCH', `/api/conversations/${id}`, { roleId: 'coder' });
    assert.equal(switched.status, 200);
    assert.equal(switched.body.roleId, 'coder');
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
    await stopProcess(srv.proc);
    await Promise.all([alpha.close(), beta.close()]);
  }
});

test('settings ignore legacy fields and source tests keep unsaved origin rules', async () => {
  const [alpha, beta] = await Promise.all([startFake('alpha'), startFake('beta')]);
  const srv = await startServer();
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
    await stopProcess(srv.proc);
    await Promise.all([alpha.close(), beta.close()]);
  }
});

test('a legacy settings row is migrated once and the old key is not kept at the top level', async () => {
  const srv = await startServer();
  await stopProcess(srv.proc);
  writeSettings(srv.dataDir, {
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-legacy-secret-value',
    models: { coder: 'gpt-4o' },
    language: 'en',
  });

  const authFile = path.join(srv.dataDir, 'auth.json');
  const proc = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    env: childEnv(srv.dataDir, authFile),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  let base;
  try {
    base = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`server not ready:\n${log}`)), 15000);
      const onData = (buf) => {
        log += buf;
        const match = log.match(/PI_WORK_READY (http:\/\/\S+)/);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      };
      proc.stdout.on('data', onData);
      proc.stderr.on('data', onData);
      proc.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`server exited ${code}:\n${log}`));
      });
    });
    proc.removeAllListeners('exit');

    const settings = await request(base, 'GET', '/api/settings');
    assert.equal(settings.status, 200);
    assert.equal(settings.body.provider, undefined);
    assert.equal(settings.body.baseUrl, undefined);
    assert.equal(settings.body.apiKey, undefined);
    assert.equal(settings.body.hasApiKey, undefined);
    assert.equal(JSON.stringify(settings.body).includes('sk-legacy-secret-value'), false);
    assert.equal(settings.body.sources.length, 1);
    assert.equal(settings.body.models.coder.model, 'gpt-4o');
    assert.equal(settings.body.models.coder.sourceId, settings.body.sources[0].id);
    assert.equal(settings.body.language, 'en');

    const row = readSettings(srv.dataDir);
    assert.equal(row.apiKey, undefined);
    assert.equal(row.provider, undefined);
    assert.equal(row.baseUrl, undefined);
    assert.equal(row.sources[0].apiKey, 'sk-legacy-secret-value');
  } finally {
    await stopProcess(proc);
  }
});

test('an untouched legacy preset does not create a source or keep string models', async () => {
  const srv = await startServer();
  await stopProcess(srv.proc);
  writeSettings(srv.dataDir, {
    provider: 'openai',
    baseUrl: '',
    apiKey: '',
    models: { default: 'gpt-4o-leftover' },
    language: 'zh',
  });
  const authFile = path.join(srv.dataDir, 'auth.json');
  const proc = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    env: childEnv(srv.dataDir, authFile),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  try {
    const base = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`server not ready:\n${log}`)), 15000);
      const onData = (buf) => {
        log += buf;
        const match = log.match(/PI_WORK_READY (http:\/\/\S+)/);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      };
      proc.stdout.on('data', onData);
      proc.stderr.on('data', onData);
      proc.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`server exited ${code}:\n${log}`));
      });
    });
    proc.removeAllListeners('exit');
    const settings = await request(base, 'GET', '/api/settings');
    assert.equal(settings.status, 200);
    assert.deepEqual(settings.body.sources, []);
    assert.deepEqual(settings.body.models, {});
    assert.equal(settings.body.runtime, 'none');
    const row = readSettings(srv.dataDir);
    assert.equal(JSON.stringify(row).includes('gpt-4o-leftover'), false);
    assert.equal(row.apiKey, undefined);
  } finally {
    await stopProcess(proc);
  }
});
