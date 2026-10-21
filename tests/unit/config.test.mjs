import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from './_root.mjs';
const { validateRole } = await load('src/core/config.mjs');
const role = { id: 'coder', name: 'Coder', systemPrompt: 'write code', tools: ['read', 'write', 'edit'] };

test('valid role; default tools', () => {
  assert.equal(validateRole(role).ok, true);
  const r = validateRole({ id: 'reader', name: 'R', systemPrompt: 'x' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value.tools, ['read', 'ls', 'grep']);
  const trimmed = validateRole({ id: 'reader', name: 'R', systemPrompt: 'x', model: '  ' });
  assert.equal(trimmed.ok, true);
  assert.equal(trimmed.value.model, undefined);
  const ignored = validateRole({ id: 'reader', name: 'R', systemPrompt: 'x', model: 'gpt-4o', builtin: true });
  assert.equal(ignored.ok, true);
  assert.equal(ignored.value.model, undefined);
  assert.equal(ignored.value.builtin, undefined);
  const numeric = validateRole({ id: 'reader', name: 'R', systemPrompt: 'x', model: 1 });
  assert.equal(numeric.ok, true);
  assert.equal(numeric.value.model, undefined);
  const extra = validateRole({
    id: 'reader',
    name: 'R',
    systemPrompt: 'x',
    description: 'when to use',
    skills: [],
    pluginTools: false,
  });
  assert.equal(extra.ok, true);
  assert.equal(extra.value.description, 'when to use');
  assert.deepEqual(extra.value.skills, []);
  assert.equal(extra.value.pluginTools, false);
  const inherit = validateRole({ id: 'reader', name: 'R', systemPrompt: 'x' });
  assert.equal(inherit.value.skills, undefined);
  assert.equal(inherit.value.pluginTools, undefined);
  assert.equal(inherit.value.description, '');
});
test('role field limits', () => {
  assert.equal(validateRole({ id: 'reader', name: 'R', systemPrompt: 'x', description: 'd'.repeat(501) }).ok, false);
  assert.equal(validateRole({ id: 'reader', name: 'R', systemPrompt: 'x', skills: 'commit-message' }).ok, false);
  assert.equal(validateRole({ id: 'reader', name: 'R', systemPrompt: 'x', skills: ['Bad Skill'] }).ok, false);
  assert.equal(validateRole({ id: 'reader', name: 'R', systemPrompt: 'x', pluginTools: 'no' }).ok, false);
  const deduped = validateRole({
    id: 'reader',
    name: 'R',
    systemPrompt: 'x',
    skills: ['commit-message', 'commit-message'],
  });
  assert.deepEqual(deduped.value.skills, ['commit-message']);
});
test('invalid roles', () => {
  for (const bad of [{ ...role, id: 'Bad Id' }, { ...role, id: '' }, { ...role, systemPrompt: '' },
    { ...role, tools: ['rm'] }, { ...role, tools: 'read' }, null]) {
    const r = validateRole(bad);
    assert.equal(r.ok, false);
    assert.ok(r.errors.length > 0);
  }
});
