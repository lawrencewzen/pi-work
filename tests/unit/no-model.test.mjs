import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ROOT } from './_root.mjs';
import { request as serverRequest, startServer, stopServer } from './_server.mjs';

const TOKEN = 'unit-no-model-token';
const request = (base, method, apiPath, body) => serverRequest(base, method, apiPath, body, TOKEN);

async function openConversation(base, title = 'hi') {
  const ws = await request(base, 'POST', '/api/workspaces', { name: 'bare' });
  assert.equal(ws.status, 201);
  const conv = await request(base, 'POST', `/api/workspaces/${ws.body.id}/conversations`, { title });
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
  const srv = await startServer({ token: TOKEN });
  try {
    const settings = await request(srv.base, 'GET', '/api/settings');
    assert.equal(settings.status, 200);
    assert.equal(settings.body.runtime, 'none');

    const id = await openConversation(srv.base, 'New conversation');
    const sent = await request(srv.base, 'POST', `/api/conversations/${id}/messages`, { text: '你好' });
    assert.equal(sent.status, 202);

    const done = await waitFinished(srv.base, id);
    assert.equal(done.status, 'failed');
    assert.equal(done.llmError?.code, 'E_NO_MODEL');
    assert.equal(done.llmError?.message, 'err_no_model');
    assert.equal(done.messages.some((message) => message.role === 'assistant'), false);
    assert.equal(done.messages.some((message) => String(message.text || '').includes('reported usage')), false);
    assert.equal(done.messages.some((message) => message.role === 'user' && message.text === '你好'), true);
    assert.equal(done.title, '你好');
  } finally {
    await stopServer(srv);
  }
});

test('an explicit faux script still answers and is marked as the demo runtime', async () => {
  const script = path.join(ROOT, 'tests/fixtures/usage.json');
  const srv = await startServer({ token: TOKEN, env: { WEFT_FAUX_SCRIPT: script } });
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
    await stopServer(srv);
  }
});

test('LLM_API=faux opts into the demo runtime without loading a user-facing script', async () => {
  const srv = await startServer({ token: TOKEN, env: { LLM_API: 'faux' } });
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
    await stopServer(srv);
  }
});
