import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { load, ROOT } from './_root.mjs';

const { createSqliteStore } = await load('src/store/sqlite.mjs');
const { loadRoleTemplates, shouldUpgradeBuiltinPrompt, shouldUpgradeBuiltinTools } = await load('src/core/roles-load.mjs');

const scribe = {
  id: 'scribe',
  name: 'Scribe',
  systemPrompt: 'Write notes.',
  tools: ['read', 'write'],
};

async function openStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'piw-cat-'));
  const store = createSqliteStore(dir);
  const orig = store.close.bind(store);
  store.close = () => {
    orig();
    return fs.rm(dir, { recursive: true, force: true });
  };
  return store;
}

async function withSqlite(fn) {
  const store = await openStore();
  try {
    await fn(store);
  } finally {
    await store.close();
  }
}

test('sqlite store updates and deletes roles', async () => {
  const store = await openStore();
  try {
    assert.equal(await store.updateRole('missing', scribe), undefined);
    await store.createRole(scribe);
    const updated = await store.updateRole('scribe', { ...scribe, name: 'Notes', model: 'grok-build' });
    assert.equal(updated.name, 'Notes');
    assert.equal(updated.model, 'grok-build');
    const cleared = await store.updateRole('scribe', { ...scribe, name: 'Notes' });
    assert.equal(cleared.model, undefined);
    assert.equal(await store.getRole('scribe').then((role) => role.name), 'Notes');
    assert.equal(await store.deleteRole('scribe'), true);
    assert.equal(await store.getRole('scribe'), undefined);

    await store.tombstoneCatalog('role', 'planner');
    assert.equal(await store.hasCatalogTombstone('role', 'planner'), true);
    await store.clearCatalogTombstone('role', 'planner');
    assert.equal(await store.hasCatalogTombstone('role', 'planner'), false);
  } finally {
    await store.close();
  }
});

test('sqlite counts conversations that reference a role', async () => {
  await withSqlite(async (store) => {
    const ws = await store.createWorkspace({ name: 'ws', path: '/tmp/piw-cat-ws' });
    await store.createRole(scribe);
    await store.createConversation({ workspaceId: ws.id, title: 'a', roleId: 'scribe' });
    await store.createConversation({ workspaceId: ws.id, title: 'b' });
    assert.equal(await store.countConversationsReferencing({ roleId: 'scribe' }), 1);
    assert.equal(await store.countConversationsReferencing({}), 0);
  });
});

test('startup drops the pipelines table and does not read pipeline columns', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'piw-drop-pipe-'));
  const dbPath = path.join(dir, 'pi-work.sqlite');
  const raw = new DatabaseSync(dbPath);
  raw.exec(`
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      workspace_id TEXT,
      title TEXT,
      status TEXT,
      auto_continues INTEGER DEFAULT 0,
      retries INTEGER DEFAULT 0,
      last_checkpoint_at INTEGER,
      current_step INTEGER DEFAULT 0,
      pipeline_step INTEGER DEFAULT 0,
      updated_at INTEGER,
      created_at INTEGER,
      role_id TEXT,
      pipeline_id TEXT,
      workspace_path TEXT,
      last_progress_at INTEGER,
      original_text TEXT,
      harness_id INTEGER
    );
    CREATE TABLE pipelines (id TEXT PRIMARY KEY, name TEXT, steps_json TEXT);
    INSERT INTO pipelines (id, name, steps_json) VALUES ('legacy', 'Legacy', '[]');
    INSERT INTO conversations (
      id, workspace_id, title, pipeline_step, pipeline_id, updated_at, created_at
    ) VALUES ('c1', 'w1', 'old', 2, 'legacy', 1, 1);
  `);
  raw.close();
  const store = createSqliteStore(dir);
  try {
    const check = new DatabaseSync(dbPath, { readOnly: true });
    try {
      assert.equal(
        check.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='pipelines'").get(),
        undefined,
      );
    } finally {
      check.close();
    }
    const conv = await store.getConversation('c1');
    assert.equal(conv?.id, 'c1');
    assert.equal('pipelineId' in conv, false);
    assert.equal('pipelineStep' in conv, false);
  } finally {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('templates seed builtin roles and honor tombstones', async (t) => {
  const store = await openStore();
  t.after(() => store.close());
  const rolesDir = path.join(ROOT, 'roles');
  await loadRoleTemplates(store, rolesDir);

  const planner = await store.getRole('planner');
  assert.equal(planner?.name, 'Planner');
  assert.deepEqual(planner.tools, ['read', 'ls', 'grep']);
  assert.equal(planner.description, '先读仓库，把需求拆成可执行的短计划。只读，不改代码。');
  assert.deepEqual((await store.getRole('auditor')).tools, ['read', 'ls', 'grep']);
  assert.deepEqual((await store.getRole('default')).tools, ['read', 'write', 'edit', 'ls', 'grep', 'bash']);

  await store.deleteRole('planner');
  await store.tombstoneCatalog('role', 'planner');
  await loadRoleTemplates(store, rolesDir);
  assert.equal(await store.getRole('planner'), undefined);
});

test('startup upgrades unedited builtin prompts and keeps edited ones', async (t) => {
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
  const store = await openStore();
  t.after(() => store.close());
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

test('startup upgrades untouched preset tools and fills an empty description', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'piw-roles-'));
  const oldAuditorPrompt = 'You are a code auditor. Review workspace changes for security (path traversal, command injection, secret leakage), correctness, and recovery/idempotency issues. Report findings clearly. Write an audit note if needed; do not rewrite large amounts of code unless a fix is clearly required.';
  await fs.writeFile(path.join(dir, 'auditor.json'), JSON.stringify({
    id: 'auditor',
    name: 'Auditor',
    description: '只读审查',
    systemPrompt: '新的只读提示词',
    tools: ['read', 'ls', 'grep'],
  }));
  await fs.writeFile(path.join(dir, 'coder.json'), JSON.stringify({
    id: 'coder',
    name: 'Coder',
    description: '改代码',
    systemPrompt: '编码出厂',
    tools: ['read', 'write', 'edit', 'ls', 'grep', 'bash'],
  }));
  const store = await openStore();
  t.after(() => store.close());
  await store.createRole({
    id: 'auditor',
    name: 'Old auditor',
    systemPrompt: oldAuditorPrompt,
    tools: ['read', 'write', 'ls', 'grep'],
    description: '',
    model: 'keep-binding-source',
  });
  await store.createRole({
    id: 'coder',
    name: 'My coder',
    description: '我写的说明',
    systemPrompt: '我改过的提示词',
    tools: ['read', 'write'],
  });
  const auditorTemplate = {
    id: 'auditor',
    systemPrompt: '新的只读提示词',
    tools: ['read', 'ls', 'grep'],
  };
  assert.equal(shouldUpgradeBuiltinTools(await store.getRole('auditor'), auditorTemplate), true);
  assert.equal(shouldUpgradeBuiltinTools(await store.getRole('coder'), {
    id: 'coder',
    tools: ['read', 'write', 'edit', 'ls', 'grep', 'bash'],
  }), false);
  await loadRoleTemplates(store, dir);
  const auditor = await store.getRole('auditor');
  assert.deepEqual(auditor.tools, ['read', 'ls', 'grep']);
  assert.equal(auditor.description, '只读审查');
  assert.equal(auditor.systemPrompt, '新的只读提示词');
  assert.equal(auditor.name, 'Old auditor');
  assert.equal(auditor.model, 'keep-binding-source');
  const coder = await store.getRole('coder');
  assert.deepEqual(coder.tools, ['read', 'write']);
  assert.equal(coder.description, '我写的说明');
  assert.equal(coder.systemPrompt, '我改过的提示词');
});
