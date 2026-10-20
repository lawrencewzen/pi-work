import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from './_root.mjs';

const TOKEN = 'unit-no-model-token';
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

function childEnv(dataDir, authFile, extra = {}) {
  const env = { ...process.env };
  for (const key of STRIP) delete env[key];
  return {
    ...env,
    PORT: '0',
    PI_WORK_DATA_DIR: dataDir,
    PI_WORK_TOKEN: TOKEN,
    PI_WORK_GROK_AUTH: authFile,
    PI_WORK_RETRY_BASE_MS: '20',
    PI_WORK_RETRY_MAX: '5',
    ...extra,
  };
}

async function startServer(extra = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'piw-nomodel-'));
  const authFile = path.join(dataDir, 'auth.json');
  await fs.writeFile(authFile, '{}\n', { mode: 0o600 });
  const proc = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    env: childEnv(dataDir, authFile, extra),
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
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function openConversation(base) {
  const ws = await request(base, 'POST', '/api/workspaces', { name: 'bare' });
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

test('unconfigured server refuses a turn instead of answering with the faux script', async () => {
  const srv = await startServer();
  try {
    const settings = await request(srv.base, 'GET', '/api/settings');
    assert.equal(settings.status, 200);
    assert.equal(settings.body.runtime, 'none');

    const id = await openConversation(srv.base);
    const sent = await request(srv.base, 'POST', `/api/conversations/${id}/messages`, { text: '你好' });
    assert.equal(sent.status, 202);

    const done = await waitFinished(srv.base, id);
    assert.equal(done.status, 'failed');
    assert.equal(done.llmError?.code, 'E_NO_MODEL');
    assert.equal(done.llmError?.message, 'err_no_model');
    assert.equal(done.messages.some((message) => message.role === 'assistant'), false);
    assert.equal(done.messages.some((message) => String(message.text || '').includes('reported usage')), false);
    assert.equal(done.messages.some((message) => message.role === 'user' && message.text === '你好'), true);
  } finally {
    await stopProcess(srv.proc);
  }
});

test('an explicit faux script still answers and is marked as the demo runtime', async () => {
  const script = path.join(ROOT, 'tests/fixtures/usage.json');
  const srv = await startServer({ PI_WORK_FAUX_SCRIPT: script });
  try {
    const settings = await request(srv.base, 'GET', '/api/settings');
    assert.equal(settings.body.runtime, 'faux');
    const id = await openConversation(srv.base);
    const sent = await request(srv.base, 'POST', `/api/conversations/${id}/messages`, { text: '你好' });
    assert.equal(sent.status, 202);
    const done = await waitFinished(srv.base, id);
    assert.equal(done.status, 'done');
    assert.equal(done.messages.some((message) => message.role === 'assistant' && message.text === 'reported usage'), true);
  } finally {
    await stopProcess(srv.proc);
  }
});

test('LLM_API=faux opts into the demo runtime without loading a user-facing script', async () => {
  const srv = await startServer({ LLM_API: 'faux' });
  try {
    const settings = await request(srv.base, 'GET', '/api/settings');
    assert.equal(settings.body.runtime, 'faux');
    const id = await openConversation(srv.base);
    await request(srv.base, 'POST', `/api/conversations/${id}/messages`, { text: '你好' });
    const done = await waitFinished(srv.base, id);
    assert.equal(done.status, 'done');
    assert.equal(done.messages.some((message) => message.role === 'assistant'), false);
    assert.equal(done.messages.some((message) => String(message.text || '').includes('reported usage')), false);
  } finally {
    await stopProcess(srv.proc);
  }
});
