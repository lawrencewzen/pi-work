import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startServer, tmpdir, api } from '../e2e/helpers/server.mjs';
import { load, ROOT } from './_root.mjs';

const { createSqliteStore } = await load('src/store/sqlite.mjs');
const { loadRoleTemplates } = await load('src/core/roles-load.mjs');

const TOKEN = 'agents-backend-token';

function call(url, method, p, body) {
  return api(url, method, p, body, TOKEN);
}

test('roles api generates ids, protects presets, resets templates, and publishes effectiveModel', async () => {
  const srv = await startServer({ extraEnv: { PI_WORK_TOKEN: TOKEN } });
  try {
    const created = await call(srv.url, 'POST', '/roles', {
      name: '复核助手',
      systemPrompt: '只做复核。',
      description: '用户要求复核时使用',
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.model, undefined);
    assert.equal(created.body.builtin, undefined);
    assert.equal(created.body.description, '用户要求复核时使用');
    assert.equal(created.body.skills, undefined);
    assert.equal(created.body.pluginTools, undefined);
    assert.equal(created.body.effectiveModel.follow, true);

    const explicit = await call(srv.url, 'POST', '/roles', {
      id: 'scribe',
      name: 'Scribe',
      systemPrompt: 'Write notes.',
      tools: ['read'],
      model: 'gpt-4o',
      builtin: true,
    });
    assert.equal(explicit.status, 201);
    assert.equal(explicit.body.id, 'scribe');
    assert.equal(explicit.body.model, undefined);
    assert.equal(explicit.body.builtin, undefined);

    const kept = await call(srv.url, 'PUT', '/roles/scribe', {
      name: 'Note taker',
      systemPrompt: 'Write short notes.',
      tools: ['read'],
      model: 1,
      skills: ['commit-message'],
      pluginTools: false,
    });
    assert.equal(kept.status, 200);
    assert.equal(kept.body.model, undefined);
    assert.deepEqual(kept.body.skills, ['commit-message']);
    assert.equal(kept.body.pluginTools, false);

    for (const id of ['default', 'planner', 'coder', 'tester', 'auditor']) {
      const role = (await call(srv.url, 'GET', '/roles')).body.find((item) => item.id === id);
      assert.equal(role.builtin, true, id);
      assert.equal(role.model, undefined, id);
      assert.ok(role.effectiveModel && 'follow' in role.effectiveModel, id);
    }
    assert.deepEqual((await call(srv.url, 'GET', '/roles')).body.find((role) => role.id === 'auditor').tools, ['read', 'ls', 'grep']);

    const source = await call(srv.url, 'POST', '/sources', {
      vendor: 'custom',
      name: 'Local',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'sk-test-secret-should-not-log',
      models: ['alpha'],
    });
    assert.equal(source.status, 201);
    const bound = await call(srv.url, 'PUT', '/settings', {
      models: { planner: { sourceId: source.body.id, model: 'alpha' } },
    });
    assert.equal(bound.status, 200);

    const edited = await call(srv.url, 'PUT', '/roles/planner', {
      name: 'Custom planner',
      systemPrompt: 'Plan it my way.',
      tools: ['read'],
      description: '自定义说明',
      skills: [],
      pluginTools: false,
      model: 'should-be-ignored',
    });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.model, undefined);
    assert.equal(edited.body.effectiveModel.follow, false);
    assert.equal(edited.body.effectiveModel.model, 'alpha');

    const reset = await call(srv.url, 'POST', '/roles/planner/reset');
    assert.equal(reset.status, 200);
    assert.equal(reset.body.name, 'Planner');
    assert.match(reset.body.systemPrompt, /角色：规划/);
    assert.deepEqual(reset.body.tools, ['read', 'ls', 'grep']);
    assert.equal(reset.body.description, '先读仓库，把需求拆成可执行的短计划。只读，不改代码。');
    assert.equal(reset.body.skills, undefined);
    assert.equal(reset.body.pluginTools, undefined);
    assert.equal(reset.body.model, undefined);
    const settings = await call(srv.url, 'GET', '/settings');
    assert.deepEqual(settings.body.models.planner, { sourceId: source.body.id, model: 'alpha' });
    const listed = (await call(srv.url, 'GET', '/roles')).body.find((role) => role.id === 'planner');
    assert.deepEqual(listed.effectiveModel, { sourceId: source.body.id, model: 'alpha', follow: false });
    const follower = (await call(srv.url, 'GET', '/roles')).body.find((role) => role.id === 'tester');
    assert.equal(follower.effectiveModel.follow, true);
    assert.equal(follower.effectiveModel.model, 'alpha');

    const notBuiltin = await call(srv.url, 'POST', '/roles/scribe/reset');
    assert.equal(notBuiltin.status, 400);
    assert.equal(notBuiltin.body.error, 'not_builtin');

    assert.equal((await call(srv.url, 'DELETE', '/roles/default')).body.error, 'protected');
    assert.equal((await call(srv.url, 'DELETE', '/pipelines/feature')).status, 200);
    assert.equal((await call(srv.url, 'DELETE', '/pipelines/demo')).status, 200);
    for (const id of ['planner', 'coder', 'tester', 'auditor']) {
      const denied = await call(srv.url, 'DELETE', `/roles/${id}`);
      assert.equal(denied.status, 409, id);
      assert.equal(denied.body.error, 'protected', id);
    }

    const scribeBound = await call(srv.url, 'PUT', '/settings', {
      models: { scribe: { sourceId: source.body.id, model: 'alpha' } },
    });
    assert.equal(scribeBound.status, 200);
    assert.deepEqual(scribeBound.body.models.scribe, { sourceId: source.body.id, model: 'alpha' });
    const removed = await call(srv.url, 'DELETE', '/roles/scribe');
    assert.equal(removed.status, 200);
    const after = await call(srv.url, 'GET', '/settings');
    assert.equal(after.body.models.scribe, undefined);
    assert.deepEqual(after.body.models.planner, { sourceId: source.body.id, model: 'alpha' });

    const skills = await call(srv.url, 'GET', '/skills');
    assert.equal(skills.status, 200);
    const commit = skills.body.find((skill) => skill.id === 'commit-message');
    assert.equal(commit.enabled, true);
    assert.equal(typeof commit.name, 'string');
    assert.equal(typeof commit.description, 'string');
  } finally {
    await srv.kill();
  }
});

test('startup migrates role.model and upgrades an unedited auditor', async () => {
  const dataDir = await tmpdir('piw-migrate-');
  const store = createSqliteStore(dataDir);
  await loadRoleTemplates(store, path.join(ROOT, 'roles'));
  const oldAuditorPrompt = 'You are a code auditor. Review workspace changes for security (path traversal, command injection, secret leakage), correctness, and recovery/idempotency issues. Report findings clearly. Write an audit note if needed; do not rewrite large amounts of code unless a fix is clearly required.';
  const auditor = await store.getRole('auditor');
  await store.updateRole('auditor', {
    ...auditor,
    systemPrompt: oldAuditorPrompt,
    tools: ['read', 'write', 'ls', 'grep'],
    description: '',
    model: 'missing-model',
  });
  const planner = await store.getRole('planner');
  await store.updateRole('planner', { ...planner, tools: ['read'], model: 'alpha' });
  const coder = await store.getRole('coder');
  await store.updateRole('coder', { ...coder, model: 'beta' });
  const secret = 'sk-test-secret-should-not-log';
  await store.putSettings({
    sources: [{
      id: 'srcmig1',
      kind: 'api',
      vendor: 'custom',
      name: 'Mig',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: secret,
      models: ['alpha'],
    }],
    models: { coder: { sourceId: 'srcmig1', model: 'alpha' } },
  });
  store.close();

  const srv = await startServer({ dataDir, extraEnv: { PI_WORK_TOKEN: TOKEN } });
  try {
    const log = srv.logs();
    assert.match(log, /PI_WORK_ROLE_MODEL dropped auditor model "missing-model"/);
    assert.equal(log.includes(secret), false);
    const roles = await call(srv.url, 'GET', '/roles');
    const auditorRole = roles.body.find((role) => role.id === 'auditor');
    assert.deepEqual(auditorRole.tools, ['read', 'ls', 'grep']);
    assert.equal(auditorRole.description, '审查改动是否正确、安全、是否做过头。只读，不改仓库。');
    assert.match(auditorRole.systemPrompt, /不要改仓库/);
    assert.equal(auditorRole.model, undefined);
    const plannerRole = roles.body.find((role) => role.id === 'planner');
    assert.deepEqual(plannerRole.tools, ['read']);
    assert.equal(plannerRole.model, undefined);
    assert.deepEqual(plannerRole.effectiveModel, { sourceId: 'srcmig1', model: 'alpha', follow: false });
    const settings = await call(srv.url, 'GET', '/settings');
    assert.deepEqual(settings.body.models.coder, { sourceId: 'srcmig1', model: 'alpha' });
    assert.deepEqual(settings.body.models.planner, { sourceId: 'srcmig1', model: 'alpha' });
    assert.equal(settings.body.models.auditor, undefined);
    assert.equal(JSON.stringify(settings.body).includes(secret), false);
  } finally {
    await srv.kill();
  }
});
