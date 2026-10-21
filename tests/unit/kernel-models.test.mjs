import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { createModels } from '@earendil-works/pi-ai/models';
import { GROK_AUTH_SCOPE, GROK_CLIENT_ID } from '../../src/core/grok-auth.mjs';
import { createSqliteStore } from '../../src/store/sqlite.mjs';
import { createKernelModels, explicitDemo, providerIdForSource } from '../../src/kernel/models.mjs';
import { startFakeModel } from './kernel-models-fake.mjs';
import { ROOT } from './_root.mjs';

const TOKEN = 'unit-kernel-models-token';
const KEY_DEFAULT = 'sk-default-secret-1111';
const KEY_DEFAULT_NEXT = 'sk-default-secret-3333';
const KEY_CODER = 'sk-coder-secret-2222';
const ACCESS_1 = 'access-1';
const REFRESH_1 = 'refresh-1';
const SECRETS = [KEY_DEFAULT, KEY_DEFAULT_NEXT, KEY_CODER, REFRESH_1];

const STRIP = [
  'PI_WORK_LLM',
  'PI_WORK_FAUX_SCRIPT',
  'PI_WORK_FAUX_TEXT',
  'PI_WORK_FAUX_HOLD',
  'PI_WORK_FAUX_HOLD_READY',
  'PI_WORK_KERNEL',
  'LLM_API',
  'LLM_API_KEY',
  'LLM_BASE_URL',
  'LLM_MODEL',
  'PI_WORK_GROK_AUTH',
  'GROK_HOME',
  'PI_WORK_GROK_PROXY',
  'PI_WORK_GROK_CLIENT_VERSION',
  'PI_WORK_TEST_GROK_TOKEN_URL',
];

test('explicit demo is only the three switches', () => {
  assert.equal(explicitDemo({}), false);
  assert.equal(explicitDemo({ PI_WORK_LLM: 'faux' }), true);
  assert.equal(explicitDemo({ LLM_API: 'faux' }), true);
  assert.equal(explicitDemo({ PI_WORK_FAUX_SCRIPT: '/tmp/script.json' }), true);
  assert.equal(explicitDemo({ PI_WORK_LLM: 'openai' }), false);
  assert.equal(explicitDemo({ LLM_API_KEY: KEY_DEFAULT }), false);
});

test('role routing follows bindings and refreshes providers when a source changes', async () => {
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
    env: { PI_WORK_GROK_CLIENT_VERSION: '1.0.50' },
  });
  const main = await routes.modelFor({ roleId: null });
  const coder = await routes.modelFor({ roleId: 'coder' });
  assert.equal(main.modelId, 'model-default');
  assert.equal(coder.modelId, 'model-coder');
  assert.notEqual(main.provider, coder.provider);
  assert.equal(models.getModel(main.provider, main.modelId).baseUrl, 'http://127.0.0.1:4101/v1');
  assert.equal(models.getModel(coder.provider, coder.modelId).baseUrl, 'http://127.0.0.1:4102/v1');

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
  await routes.modelFor({ roleId: 'coder' });
  assert.equal(models.getProvider(providerIdForSource({ id: 'srccoder', kind: 'api' })), undefined);

  settings = { version: 2, sources: [], models: {} };
  assert.equal(await routes.modelFor({}), null);
  assert.equal(models.getModel(main.provider, main.modelId), undefined);
});

function childEnv(dataDir, extra = {}) {
  const env = { ...process.env };
  for (const key of STRIP) delete env[key];
  return {
    ...env,
    PORT: '0',
    PI_WORK_DATA_DIR: dataDir,
    PI_WORK_TOKEN: TOKEN,
    PI_WORK_GROK_AUTH: path.join(dataDir, 'auth.json'),
    PI_WORK_GROK_CLIENT_VERSION: '1.0.50',
    PI_WORK_RETRY_BASE_MS: '20',
    PI_WORK_RETRY_MAX: '5',
    ...extra,
  };
}

function killChild(child) {
  if (child.exitCode != null || child.signalCode != null) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  child.kill('SIGKILL');
}

function stopProcess(proc) {
  return new Promise((resolve) => {
    if (proc.exitCode != null) return resolve();
    const timer = setTimeout(() => killChild(proc), 2000);
    proc.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    proc.kill('SIGTERM');
  });
}

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
  const res = await fetch(base + apiPath, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  assertClean(text, `${method} ${apiPath}`);
  return { status: res.status, body: text ? JSON.parse(text) : null, text };
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

async function startServer(dataDir, extra) {
  const hook = pathToFileURL(path.join(ROOT, 'tests/unit/kernel-models-token-hook.mjs')).href;
  const proc = spawn(process.execPath, ['--import', hook, 'server.mjs'], {
    cwd: ROOT,
    env: childEnv(dataDir, extra),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      killChild(proc);
      reject(new Error(`server not ready:\n${scrub(log)}`));
    }, 20000);
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
      reject(new Error(`server exited ${code}:\n${scrub(log)}`));
    });
  });
  proc.removeAllListeners('exit');
  return { proc, base, logs: () => log };
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
    const srv = await startServer(dataDir, {
      PI_WORK_GROK_PROXY: grokFake.baseUrl,
      PI_WORK_TEST_GROK_TOKEN_URL: grokFake.tokenUrl,
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
    const mainConv = await request(base, 'POST', `/api/workspaces/${ws.body.id}/conversations`, { title: 'default-role' });
    assert.equal(mainConv.status, 201);
    const coderConv = await request(base, 'POST', `/api/workspaces/${ws.body.id}/conversations`, {
      title: 'coder-role',
      roleId: 'coder',
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
      title: 'tester-role',
      roleId: 'tester',
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
    if (proc) await stopProcess(proc);
    await defaultFake.close();
    await coderFake.close();
    await grokFake.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

