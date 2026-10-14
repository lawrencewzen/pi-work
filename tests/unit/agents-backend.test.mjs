import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { load, ROOT } from './_root.mjs';

const { allocateRoleId, roleIdFromName } = await load('src/core/config.mjs');
const { createMemoryStore } = await load('src/store/memory.mjs');
const { planRoleModelMigration, effectiveModelFor } = await load('src/core/model-sources.mjs');
const { buildSkillPrompt } = await load('src/core/skills.mjs');
const { clearPluginCache } = await load('src/core/plugins.mjs');
const { createExtensionHost } = await load('src/core/extensions.mjs');
const { createOrchestrator } = await load('src/core/orchestrator.mjs');

const bundledSkills = [path.join(ROOT, 'skills')];

async function tmp() {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'piw-agent-')));
}

function writePlugin(dir, id, toolName) {
  const folder = path.join(dir, id);
  return fs.mkdir(folder, { recursive: true }).then(async () => {
    await fs.writeFile(path.join(folder, 'plugin.json'), `${JSON.stringify({
      id,
      name: id,
      description: `${id} tool`,
      version: '0.1.0',
      source: 'local',
      main: 'index.mjs',
      tools: [{ name: toolName, description: `Run ${toolName}`, parameters: { type: 'object', properties: { text: { type: 'string' } } } }],
    }, null, 2)}\n`);
    await fs.writeFile(path.join(folder, 'index.mjs'), `export async function ${toolName}(args) {\n  return { output: '${toolName}:' + String(args?.text || ''), status: 'completed' };\n}\n`);
  });
}

test('role ids come from ascii names and random tokens for other names', async () => {
  assert.equal(roleIdFromName('Reviewer'), 'reviewer');
  assert.equal(roleIdFromName('Note Taker'), 'note-taker');
  assert.equal(roleIdFromName('复核助手', { random: () => 'abc123' }), 'agent-abc123');
  assert.equal(roleIdFromName('123', { random: () => 'abc123' }), 'agent-abc123');
  const store = createMemoryStore();
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

test('two roles send different skill prompts and plugin tool lists', async () => {
  const skillDir = await tmp();
  const pluginDir = await tmp();
  await fs.mkdir(path.join(skillDir, 'commit-message'), { recursive: true });
  await fs.writeFile(path.join(skillDir, 'commit-message', 'SKILL.md'), [
    '---',
    'id: "commit-message"',
    'name: "Commit messages"',
    'description: "commits"',
    '---',
    '',
    'SKILL_COMMIT',
    '',
  ].join('\n'));
  await fs.mkdir(path.join(skillDir, 'review-notes'), { recursive: true });
  await fs.writeFile(path.join(skillDir, 'review-notes', 'SKILL.md'), [
    '---',
    'id: "review-notes"',
    'name: "Review notes"',
    'description: "reviews"',
    '---',
    '',
    'SKILL_REVIEW',
    '',
  ].join('\n'));
  await writePlugin(pluginDir, 'echo', 'echo');
  clearPluginCache();
  const store = createMemoryStore();
  await store.createRole({
    id: 'reader',
    name: 'Reader',
    systemPrompt: 'ROLE_READER',
    tools: ['read'],
    skills: ['commit-message'],
    pluginTools: false,
  });
  await store.createRole({
    id: 'writer',
    name: 'Writer',
    systemPrompt: 'ROLE_WRITER',
    tools: ['read'],
    skills: [],
    pluginTools: true,
  });
  const host = createExtensionHost({
    skillDirs: [skillDir],
    pluginDirs: [pluginDir],
    getSettings: () => store.getSettings(),
  });
  const workspace = await tmp();
  const seen = [];
  const llm = {
    async next(req) {
      seen.push(req);
      if (req.roleId === 'reader' && seen.filter((item) => item.roleId === 'reader').length === 1) {
        return { type: 'tool', name: 'echo', args: { text: 'nope' } };
      }
      return { type: 'end' };
    },
  };
  const orch = createOrchestrator({ llm, store, extensions: host });
  await orch.start('R', { workspacePath: workspace, text: 'read', roleId: 'reader' });
  await orch.start('W', { workspacePath: workspace, text: 'write', roleId: 'writer' });
  await waitFor(() => orch.status('R').status === 'done' && orch.status('W').status === 'done');
  const readerReq = seen.find((req) => req.roleId === 'reader');
  const writerReq = seen.find((req) => req.roleId === 'writer');
  const readerSystem = readerReq.messages.find((message) => message.role === 'system').content;
  const writerSystem = writerReq.messages.find((message) => message.role === 'system').content;
  assert.match(readerSystem, /ROLE_READER/);
  assert.match(readerSystem, /SKILL_COMMIT/);
  assert.equal(readerSystem.includes('SKILL_REVIEW'), false);
  assert.equal(readerReq.tools.includes('echo'), false);
  assert.match(writerSystem, /ROLE_WRITER/);
  assert.equal(writerSystem.includes('SKILL_COMMIT'), false);
  assert.equal(writerSystem.includes('SKILL_REVIEW'), false);
  assert.equal(writerReq.tools.includes('echo'), true);
  const readerMessages = await store.getMessages('R');
  assert.equal(readerMessages.some((message) => message.text === 'E_UNKNOWN_TOOL'), true);
  assert.equal(readerMessages.some((message) => message.text === 'echo:nope'), false);
});

async function waitFor(fn, ms = 5000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timeout');
}
