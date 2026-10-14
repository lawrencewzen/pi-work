import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { load, ROOT } from './_root.mjs';

const { createMemoryStore } = await load('src/store/memory.mjs');
const { createSqliteStore } = await load('src/store/sqlite.mjs');
const { loadRoleTemplates, loadPipelineTemplates, shouldUpgradeBuiltinPrompt } = await load('src/core/roles-load.mjs');

const scribe = {
  id: 'scribe',
  name: 'Scribe',
  systemPrompt: 'Write notes.',
  tools: ['read', 'write'],
};

async function withSqlite(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'piw-cat-'));
  const store = createSqliteStore(dir);
  try {
    await fn(store);
  } finally {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

for (const [name, open] of [
  ['memory', async () => createMemoryStore()],
  ['sqlite', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'piw-cat-'));
    const store = createSqliteStore(dir);
    store.close = ((orig) => () => { orig(); return fs.rm(dir, { recursive: true, force: true }); })(store.close.bind(store));
    return store;
  }],
]) {
  test(`${name} store updates and deletes roles and pipelines`, async () => {
    const store = await open();
    try {
      assert.equal(await store.updateRole('missing', scribe), undefined);
      await store.createRole(scribe);
      const updated = await store.updateRole('scribe', { ...scribe, name: 'Notes', model: 'grok-build' });
      assert.equal(updated.name, 'Notes');
      assert.equal(updated.model, 'grok-build');
      const cleared = await store.updateRole('scribe', { ...scribe, name: 'Notes' });
      assert.equal(cleared.model, undefined);
      assert.equal(await store.getRole('scribe').then((role) => role.name), 'Notes');

      await store.createPipeline({ id: 'notes', name: 'Notes', steps: [{ role: 'scribe', input: 'user' }] });
      const pipe = await store.updatePipeline('notes', {
        id: 'notes',
        name: 'Note pass',
        steps: [{ role: 'scribe', input: 'previous' }],
      });
      assert.equal(pipe.name, 'Note pass');
      assert.equal(pipe.steps[0].input, 'previous');
      assert.equal(await store.deletePipeline('notes'), true);
      assert.equal(await store.getPipeline('notes'), undefined);
      assert.equal(await store.deleteRole('scribe'), true);
      assert.equal(await store.getRole('scribe'), undefined);

      await store.tombstoneCatalog('role', 'planner');
      assert.equal(await store.hasCatalogTombstone('role', 'planner'), true);
      await store.clearCatalogTombstone('role', 'planner');
      assert.equal(await store.hasCatalogTombstone('role', 'planner'), false);
    } finally {
      await store.close?.();
    }
  });
}

test('sqlite counts conversations that reference a role or pipeline', async () => {
  await withSqlite(async (store) => {
    const ws = await store.createWorkspace({ name: 'ws', path: '/tmp/piw-cat-ws' });
    await store.createRole(scribe);
    await store.createPipeline({ id: 'notes', name: 'Notes', steps: [{ role: 'scribe' }] });
    await store.createConversation({ workspaceId: ws.id, title: 'a', roleId: 'scribe' });
    await store.createConversation({ workspaceId: ws.id, title: 'b', pipelineId: 'notes' });
    assert.equal(await store.countConversationsReferencing({ roleId: 'scribe' }), 1);
    assert.equal(await store.countConversationsReferencing({ pipelineId: 'notes' }), 1);
  });
});

test('templates seed feature pipeline and honor tombstones', async () => {
  const store = createMemoryStore();
  const rolesDir = path.join(ROOT, 'roles');
  const pipesDir = path.join(ROOT, 'pipelines');
  const examplesDir = path.join(ROOT, 'examples', 'pipelines');
  await loadRoleTemplates(store, rolesDir);
  await loadPipelineTemplates(store, pipesDir);
  await loadPipelineTemplates(store, examplesDir);

  const planner = await store.getRole('planner');
  assert.equal(planner?.name, 'Planner');
  assert.deepEqual(planner.tools, ['read', 'ls', 'grep']);
  const feature = await store.getPipeline('feature');
  assert.deepEqual(feature?.steps.map((step) => step.role), ['planner', 'coder', 'tester', 'auditor']);
  assert.ok(await store.getPipeline('demo'));

  await store.deleteRole('planner');
  await store.tombstoneCatalog('role', 'planner');
  await store.deletePipeline('feature');
  await store.tombstoneCatalog('pipeline', 'feature');
  await loadRoleTemplates(store, rolesDir);
  await loadPipelineTemplates(store, pipesDir);
  assert.equal(await store.getRole('planner'), undefined);
  assert.equal(await store.getPipeline('feature'), undefined);
  assert.ok(await store.getPipeline('demo'));
});

test('startup upgrades unedited builtin prompts and keeps edited ones', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'piw-roles-'));
  const shipped = '你是规划。\n\n## 交接\n- 角色：规划';
  const previous = 'You are a planning agent. Read the workspace and the user\'s request, then write a short implementation plan: goal, files to touch, risks, and how to verify. Do not edit production code or run tests. Prefer reading existing files before proposing changes.';
  await fs.writeFile(path.join(dir, 'planner.json'), JSON.stringify({
    id: 'planner',
    name: 'Planner',
    systemPrompt: shipped,
    tools: ['read', 'ls', 'grep'],
  }));
  await fs.writeFile(path.join(dir, 'coder.json'), JSON.stringify({
    id: 'coder',
    name: 'Coder',
    systemPrompt: '编码出厂',
    tools: ['read', 'write'],
  }));
  const store = createMemoryStore();
  await store.createRole({
    id: 'planner',
    name: 'Planner',
    systemPrompt: previous,
    tools: ['read', 'ls', 'grep'],
    model: 'keep-me',
  });
  await store.createRole({
    id: 'coder',
    name: 'Coder',
    systemPrompt: '我改过的提示词',
    tools: ['read'],
  });
  assert.equal(shouldUpgradeBuiltinPrompt(await store.getRole('planner'), {
    id: 'planner',
    systemPrompt: shipped,
  }), true);
  assert.equal(shouldUpgradeBuiltinPrompt(await store.getRole('coder'), {
    id: 'coder',
    systemPrompt: '编码出厂',
  }), false);
  await loadRoleTemplates(store, dir);
  const planner = await store.getRole('planner');
  assert.equal(planner.systemPrompt, shipped);
  assert.equal(planner.model, 'keep-me');
  assert.deepEqual(planner.tools, ['read', 'ls', 'grep']);
  assert.equal((await store.getRole('coder')).systemPrompt, '我改过的提示词');
  await loadRoleTemplates(store, dir);
  assert.equal((await store.getRole('planner')).systemPrompt, shipped);
});
