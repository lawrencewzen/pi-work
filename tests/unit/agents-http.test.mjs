import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../e2e/helpers/server.mjs';

const TOKEN = 'agents-backend-token';

function call(url, method, p, body) {
  return fetch(`${url}/api${p}`, {
    method,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${TOKEN}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (res) => {
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  });
}

test('GET /api/roles is gone; conversations have no role fields', async () => {
  const srv = await startServer({ extraEnv: { WEFT_TOKEN: TOKEN } });
  try {
    const missing = await call(srv.url, 'GET', '/roles');
    assert.equal(missing.status, 404);
    assert.equal((await call(srv.url, 'POST', '/roles', { name: 'X' })).status, 404);
    assert.equal((await call(srv.url, 'DELETE', '/roles/default')).status, 404);

    const ws = await call(srv.url, 'POST', '/workspaces', { name: 'agents-http' });
    assert.equal(ws.status, 201);
    const conv = await call(srv.url, 'POST', `/workspaces/${ws.body.id}/conversations`, { title: 'main' });
    assert.equal(conv.status, 201);
    assert.equal(Object.hasOwn(conv.body, 'roleId'), false);
    const got = await call(srv.url, 'GET', `/conversations/${conv.body.id}`);
    assert.equal(got.status, 200);
    assert.equal(Object.hasOwn(got.body, 'roleId'), false);
    const main = (got.body.agents || []).find((agent) => agent.id === `${conv.body.id}:agent:0`);
    assert.equal(main?.name, 'Agent');
    assert.equal(Object.hasOwn(main, 'roleId'), false);
  } finally {
    await srv.kill();
  }
});
