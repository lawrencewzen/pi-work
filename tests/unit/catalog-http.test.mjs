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

test('role and pipeline HTTP catalog, including template tombstones', async () => {
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
    assert.equal(roles.body.find((role) => role.id === 'default')?.builtin, undefined);

    const pipes = await api(srv.url, 'GET', '/pipelines');
    assert.equal(pipes.status, 200);
    const feature = pipes.body.find((pipe) => pipe.id === 'feature');
    const demo = pipes.body.find((pipe) => pipe.id === 'demo');
    assert.ok(demo);
    assert.deepEqual(feature?.steps.map((step) => step.role), ['planner', 'coder', 'tester', 'auditor']);

    const delDefault = await api(srv.url, 'DELETE', '/roles/default');
    assert.equal(delDefault.status, 409);
    assert.equal(delDefault.body.error, 'protected');

    const delPlanner = await api(srv.url, 'DELETE', '/roles/planner');
    assert.equal(delPlanner.status, 409);
    assert.equal(delPlanner.body.error, 'role_in_use');
    assert.ok(delPlanner.body.pipelines.includes('feature'));

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

    const badPipe = await api(srv.url, 'POST', '/pipelines', {
      id: 'Bad Id',
      name: 'Nope',
      steps: [{ role: 'scribe' }],
    });
    assert.equal(badPipe.status, 400);

    const pipe = await api(srv.url, 'POST', '/pipelines', {
      id: 'notes',
      name: 'Notes',
      steps: [{ role: 'scribe', input: 'user' }, { role: 'auditor', input: 'previous' }],
    });
    assert.equal(pipe.status, 201);
    assert.equal((await api(srv.url, 'DELETE', '/roles/scribe')).status, 409);

    const ws = await api(srv.url, 'POST', '/workspaces', { name: 'catalog-ws' });
    assert.equal(ws.status, 201);
    const conv = await api(srv.url, 'POST', `/workspaces/${ws.body.id}/conversations`, {
      title: 'uses notes',
      pipelineId: 'notes',
    });
    assert.equal(conv.status, 201);
    const blocked = await api(srv.url, 'DELETE', '/pipelines/notes');
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error, 'pipeline_in_use');

    assert.equal((await api(srv.url, 'DELETE', '/pipelines/feature')).status, 200);
    assert.equal((await api(srv.url, 'DELETE', '/roles/planner')).status, 200);
  } finally {
    await srv.kill();
  }

  const restarted = await startServer({ dataDir: srv.dataDir, extraEnv: { PI_WORK_TOKEN: TOKEN } });
  try {
    const roles = await api(restarted.url, 'GET', '/roles');
    const pipes = await api(restarted.url, 'GET', '/pipelines');
    assert.equal(roles.body.some((role) => role.id === 'planner'), false);
    assert.equal(roles.body.some((role) => role.id === 'scribe'), true);
    assert.equal(pipes.body.some((pipe) => pipe.id === 'feature'), false);
    assert.equal(pipes.body.some((pipe) => pipe.id === 'demo'), true);
    assert.equal(pipes.body.some((pipe) => pipe.id === 'notes'), true);

    const again = await api(restarted.url, 'POST', '/roles', {
      id: 'planner',
      name: 'Custom planner',
      systemPrompt: 'Plan it.',
      tools: ['read'],
    });
    assert.equal(again.status, 201);
    assert.equal(again.body.name, 'Custom planner');
  } finally {
    await restarted.kill();
  }
});
