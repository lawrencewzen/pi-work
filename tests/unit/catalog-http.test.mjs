import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../e2e/helpers/server.mjs';

const TOKEN = 'catalog-test-token';
const scribe = {
  id: 'scribe',
  name: 'Scribe',
  systemPrompt: 'Write notes.',
  tools: ['read', 'write'],
};

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

test('role HTTP catalog, including template tombstones; pipeline routes are gone', async () => {
  const srv = await startServer({ extraEnv: { PI_WORK_TOKEN: TOKEN } });
  try {
    const roles = await api(srv.url, 'GET', '/roles');
    assert.equal(roles.status, 200);
    const planner = roles.body.find((role) => role.id === 'planner');
    assert.equal(planner?.builtin, true);
    assert.match(planner?.defaultPrompt || '', /## 交接/);
    assert.match(planner?.defaultPrompt || '', /角色：规划/);
    assert.equal(planner?.systemPrompt, planner?.defaultPrompt);
    for (const id of ['coder', 'tester', 'auditor']) {
      const role = roles.body.find((item) => item.id === id);
      assert.equal(role?.builtin, true);
      assert.match(role?.defaultPrompt || '', new RegExp(`角色：${{ coder: '编码', tester: '测试', auditor: '审计' }[id]}`));
    }
    const main = roles.body.find((role) => role.id === 'default');
    assert.equal(main?.builtin, true);
    assert.equal(main?.model, undefined);
    assert.equal(typeof main?.description, 'string');
    assert.equal(main?.effectiveModel?.follow, true);
    assert.deepEqual(roles.body.find((role) => role.id === 'auditor')?.tools, ['read', 'ls', 'grep']);

    assert.equal((await api(srv.url, 'GET', '/pipelines')).status, 404);
    assert.equal((await api(srv.url, 'POST', '/pipelines', {
      id: 'notes',
      name: 'Notes',
      steps: [{ role: 'scribe' }],
    })).status, 404);

    const delDefault = await api(srv.url, 'DELETE', '/roles/default');
    assert.equal(delDefault.status, 409);
    assert.equal(delDefault.body.error, 'protected');

    const delPlanner = await api(srv.url, 'DELETE', '/roles/planner');
    assert.equal(delPlanner.status, 409);
    assert.equal(delPlanner.body.error, 'protected');
    assert.equal(delPlanner.body.pipelines, undefined);

    const created = await api(srv.url, 'POST', '/roles', scribe);
    assert.equal(created.status, 201);
    assert.equal(created.body.id, 'scribe');
    const dup = await api(srv.url, 'POST', '/roles', scribe);
    assert.equal(dup.status, 409);

    const updated = await api(srv.url, 'PUT', '/roles/scribe', {
      name: 'Note taker',
      systemPrompt: 'Write short notes.',
      tools: ['read'],
      model: '',
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.name, 'Note taker');
    assert.equal(updated.body.model, undefined);

    const missing = await api(srv.url, 'PUT', '/roles/nope', { name: 'X', systemPrompt: 'y' });
    assert.equal(missing.status, 404);

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
    const patched = await api(srv.url, 'PATCH', `/conversations/${conv.body.id}`, { pipelineId: 'notes' });
    assert.equal(patched.status, 200);
    assert.equal('pipelineId' in patched.body, false);
    assert.equal('pipelineStep' in patched.body, false);

    assert.equal((await api(srv.url, 'DELETE', '/roles/scribe')).status, 200);
  } finally {
    await srv.kill();
  }

  const restarted = await startServer({ dataDir: srv.dataDir, extraEnv: { PI_WORK_TOKEN: TOKEN } });
  try {
    const roles = await api(restarted.url, 'GET', '/roles');
    assert.equal(roles.body.some((role) => role.id === 'planner'), true);
    assert.equal(roles.body.some((role) => role.id === 'scribe'), false);
    assert.equal((await api(restarted.url, 'GET', '/pipelines')).status, 404);

    const again = await api(restarted.url, 'POST', '/roles', {
      id: 'planner',
      name: 'Custom planner',
      systemPrompt: 'Plan it.',
      tools: ['read'],
    });
    assert.equal(again.status, 409);
    assert.equal(again.body.error, 'exists');
  } finally {
    await restarted.kill();
  }
});
