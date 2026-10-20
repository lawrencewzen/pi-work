import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { load, ROOT } from './_root.mjs';

const { allocateRoleId, roleIdFromName } = await load('src/core/config.mjs');
const { createSqliteStore } = await load('src/store/sqlite.mjs');
const { planRoleModelMigration, effectiveModelFor } = await load('src/core/model-sources.mjs');
const { buildSkillPrompt } = await load('src/core/skills.mjs');

const bundledSkills = [path.join(ROOT, 'skills')];

async function openStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'piw-role-'));
  const store = createSqliteStore(dir);
  const orig = store.close.bind(store);
  store.close = () => {
    orig();
    return fs.rm(dir, { recursive: true, force: true });
  };
  return store;
}

test('role ids come from ascii names and random tokens for other names', async (t) => {
  assert.equal(roleIdFromName('Reviewer'), 'reviewer');
  assert.equal(roleIdFromName('Note Taker'), 'note-taker');
  assert.equal(roleIdFromName('复核助手', { random: () => 'abc123' }), 'agent-abc123');
  assert.equal(roleIdFromName('123', { random: () => 'abc123' }), 'agent-abc123');
  const store = await openStore();
  t.after(() => store.close());
  await store.createRole({ id: 'reviewer', name: 'Taken', systemPrompt: 'x', tools: ['read'] });
  await store.tombstoneCatalog('role', 'note-taker');
  assert.equal(await allocateRoleId(store, 'Reviewer'), 'reviewer-2');
  assert.equal(await allocateRoleId(store, 'Note Taker'), 'note-taker-2');
  assert.equal(await allocateRoleId(store, '复核', { random: () => 'abc123' }), 'agent-abc123');
  await store.createRole({ id: 'agent-abc123', name: '占位', systemPrompt: 'x', tools: ['read'] });
  assert.equal(await allocateRoleId(store, '审计员', { random: () => 'abc123' }), 'agent-abc123-2');
});

test('role.model migration binds a listed model, keeps an existing binding, and drops the rest', () => {
  const secret = 'sk-test-secret-should-not-log';
  const settings = {
    sources: [{
      id: 'src1',
      kind: 'api',
      vendor: 'custom',
      name: 'A',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: secret,
      models: ['alpha'],
    }],
    models: { coder: { sourceId: 'src1', model: 'alpha' } },
  };
  const roles = [
    { id: 'planner', model: 'alpha' },
    { id: 'coder', model: 'beta' },
    { id: 'auditor', model: 'missing-model' },
    { id: 'tester', model: '   ' },
  ];
  const plan = planRoleModelMigration(roles, settings, { grokSignedIn: false });
  assert.equal(plan.changed, true);
  assert.deepEqual(plan.models.planner, { sourceId: 'src1', model: 'alpha' });
  assert.deepEqual(plan.models.coder, { sourceId: 'src1', model: 'alpha' });
  assert.equal(plan.models.auditor, undefined);
  assert.deepEqual(plan.clearIds, ['planner', 'coder', 'auditor']);
  assert.equal(plan.logs.length, 1);
  assert.match(plan.logs[0], /auditor/);
  assert.match(plan.logs[0], /missing-model/);
  assert.equal(plan.logs[0].includes(secret), false);
  assert.equal(JSON.stringify(plan).includes(secret), false);
});

test('effectiveModel follows default unless the role has its own binding', () => {
  const settings = {
    sources: [{
      id: 'src1', kind: 'api', vendor: 'custom', name: 'A',
      baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'key', models: ['alpha', 'beta'],
    }],
    models: { default: { sourceId: 'src1', model: 'alpha' }, coder: { sourceId: 'src1', model: 'beta' } },
  };
  assert.deepEqual(effectiveModelFor(settings, 'coder'), { sourceId: 'src1', model: 'beta', follow: false });
  assert.deepEqual(effectiveModelFor(settings, 'tester'), { sourceId: 'src1', model: 'alpha', follow: true });
  assert.deepEqual(effectiveModelFor(settings, 'default'), { sourceId: 'src1', model: 'alpha', follow: false });
  assert.deepEqual(effectiveModelFor({ sources: [], models: {} }, 'planner'), {
    sourceId: null, model: null, follow: true,
  });
});

test('skill prompt allow-list keeps only globally enabled skills', async () => {
  const all = await buildSkillPrompt(bundledSkills, {});
  assert.match(all, /Commit messages/);
  assert.match(all, /Review notes/);
  const subset = await buildSkillPrompt(bundledSkills, {}, ['commit-message']);
  assert.match(subset, /Commit messages/);
  assert.equal(subset.includes('Review notes'), false);
  const none = await buildSkillPrompt(bundledSkills, {}, []);
  assert.equal(none, '');
  const disabled = await buildSkillPrompt(bundledSkills, { 'commit-message': false }, ['commit-message', 'review-notes']);
  assert.equal(disabled.includes('Commit messages'), false);
  assert.match(disabled, /Review notes/);
});
