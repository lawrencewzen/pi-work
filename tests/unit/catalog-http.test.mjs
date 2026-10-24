import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../e2e/helpers/server.mjs';

const TOKEN = 'catalog-test-token';

function api(url, method, p, body) {
  return fetch(url + '/api' + p, {
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

test('retired role and pipeline routes are 404; leftover pipelineId is ignored', async () => {
  const srv = await startServer({ extraEnv: { WEFT_TOKEN: TOKEN } });
  try {
    assert.equal((await api(srv.url, 'GET', '/roles')).status, 404);
    assert.equal((await api(srv.url, 'POST', '/roles', { name: 'Scribe' })).status, 404);
    assert.equal((await api(srv.url, 'GET', '/pipelines')).status, 404);
    assert.equal((await api(srv.url, 'POST', '/pipelines', {
      id: 'notes',
      name: 'Notes',
      steps: [{ role: 'scribe' }],
    })).status, 404);

    const ws = await api(srv.url, 'POST', '/workspaces', { name: 'catalog-ws' });
    assert.equal(ws.status, 201);
    const conv = await api(srv.url, 'POST', `/workspaces/${ws.body.id}/conversations`, {
      title: 'ignores pipeline',
      pipelineId: 'notes',
    });
    assert.equal(conv.status, 201);
    const got = await api(srv.url, 'GET', `/conversations/${conv.body.id}`);
    assert.equal(got.status, 200);
    assert.equal('pipelineId' in got.body, false);
    assert.equal('pipelineStep' in got.body, false);
    assert.equal(Object.hasOwn(got.body, 'roleId'), false);
    const patched = await api(srv.url, 'PATCH', `/conversations/${conv.body.id}`, { pipelineId: 'notes' });
    assert.equal(patched.status, 200);
    assert.equal('pipelineId' in patched.body, false);
    assert.equal('pipelineStep' in patched.body, false);
  } finally {
    await srv.kill();
  }
});
