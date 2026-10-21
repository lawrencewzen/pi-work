import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { load, ROOT } from './_root.mjs';

const { createSqliteStore } = await load('src/store/sqlite.mjs');
const {
  BUILTIN_ROLE_IDS,
  loadRoleTemplates,
  shouldUpgradeBuiltinPrompt,
  shouldUpgradeBuiltinTools,
} = await load('src/core/roles-load.mjs');

const EN_TOOL_INTENT = '\n\nWhen calling any tool, always fill in the description parameter. Use at most 15 characters to state the purpose of this step (for example "read CLI entry" or "run unit tests"). Say why you are doing it, not a restatement of the command.';
const ZH_TOOL_INTENT = '\n\n调用任何工具时都填写 description 参数，用不超过 15 个字说明这一步的目的（例如「看 CLI 入口」「跑单元测试」），说的是为什么做，不是复述命令。';

async function readFactoryRole(id) {
  return JSON.parse(await fs.readFile(path.join(ROOT, 'roles', `${id}.json`), 'utf8'));
}

function previousFactoryPrompt(id, systemPrompt) {
  const intent = id === 'default' ? EN_TOOL_INTENT : ZH_TOOL_INTENT;
  assert.equal(systemPrompt.includes(intent), true, id);
  return systemPrompt.replace(intent, '');
}

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

test('builtin factory prompts require filling tool description', async () => {
  assert.deepEqual(BUILTIN_ROLE_IDS, ['default', 'planner', 'coder', 'tester', 'auditor']);
  for (const id of BUILTIN_ROLE_IDS) {
    const role = await readFactoryRole(id);
    const previous = previousFactoryPrompt(id, role.systemPrompt);
    assert.notEqual(previous, role.systemPrompt, id);
    if (id === 'default') {
      assert.match(role.systemPrompt, /description parameter/);
      assert.match(role.systemPrompt, /at most 15 characters/);
      assert.match(role.systemPrompt, /not a restatement of the command/);
    } else {
      assert.match(role.systemPrompt, /调用任何工具时都填写 description 参数/);
      assert.match(role.systemPrompt, /不超过 15 个字/);
      assert.match(role.systemPrompt, /不是复述命令/);
    }
  }
});

test('startup upgrades unedited factory prompts that lacked tool description', async (t) => {
  const rolesDir = path.join(ROOT, 'roles');
  const store = await openStore();
  t.after(() => store.close());
  const templates = {};
  for (const id of BUILTIN_ROLE_IDS) {
    templates[id] = await readFactoryRole(id);
    const previous = previousFactoryPrompt(id, templates[id].systemPrompt);
    await store.createRole({ ...templates[id], systemPrompt: previous });
    assert.equal(shouldUpgradeBuiltinPrompt(await store.getRole(id), templates[id]), true, id);
  }
  const custom = '我改过的提示词，不要覆盖';
  await store.updateRole('coder', { ...templates.coder, systemPrompt: custom, tools: ['read'] });
  assert.equal(shouldUpgradeBuiltinPrompt(await store.getRole('coder'), templates.coder), false);

  await loadRoleTemplates(store, rolesDir);
  for (const id of BUILTIN_ROLE_IDS) {
    const role = await store.getRole(id);
    if (id === 'coder') {
      assert.equal(role.systemPrompt, custom);
      assert.deepEqual(role.tools, ['read']);
    } else {
      assert.equal(role.systemPrompt, templates[id].systemPrompt, id);
    }
  }
  await loadRoleTemplates(store, rolesDir);
  assert.equal((await store.getRole('coder')).systemPrompt, custom);
  assert.equal((await store.getRole('default')).systemPrompt, templates.default.systemPrompt);
});
