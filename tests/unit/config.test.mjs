import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from './_root.mjs';
const { validateRole, validatePipeline } = await load('src/core/config.mjs');
const role = { id: 'coder', name: 'Coder', systemPrompt: 'write code', tools: ['read', 'write', 'edit'] };

test('valid role; default tools', () => {
  assert.equal(validateRole(role).ok, true);
  const r = validateRole({ id: 'reader', name: 'R', systemPrompt: 'x' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value.tools, ['read', 'ls', 'grep']);
  const trimmed = validateRole({ id: 'reader', name: 'R', systemPrompt: 'x', model: '  ' });
  assert.equal(trimmed.ok, true);
  assert.equal(trimmed.value.model, undefined);
});
test('invalid roles', () => {
  for (const bad of [{ ...role, id: 'Bad Id' }, { ...role, id: '' }, { ...role, systemPrompt: '' },
    { ...role, tools: ['rm'] }, { ...role, tools: 'read' }, null]) {
    const r = validateRole(bad);
    assert.equal(r.ok, false);
    assert.ok(r.errors.length > 0);
  }
});
test('pipeline validation', () => {
  const roles = [role, { ...role, id: 'tester' }];
  assert.equal(validatePipeline({ id: 'tdd', name: 'TDD', steps: [{ role: 'tester' }, { role: 'coder', input: 'previous' }] }, roles).ok, true);
  assert.equal(validatePipeline({ id: 'p', name: 'P', steps: [] }, roles).ok, false);
  assert.equal(validatePipeline({ id: 'p', name: 'P', steps: [{ role: 'ghost' }] }, roles).ok, false);
  assert.equal(validatePipeline({ id: 'p', name: 'P', steps: [{ role: 'coder', input: 'weird' }] }, roles).ok, false);
  assert.equal(validatePipeline({ id: 'p', name: 'P', steps: Array(21).fill({ role: 'coder' }) }, roles).ok, false);
  assert.equal(validatePipeline({ id: 'Bad', name: 'P', steps: [{ role: 'coder' }] }, roles).ok, false);
  const kept = validatePipeline({ id: 'tdd', name: 'TDD', steps: [{ role: 'coder', input: 'user', extra: true }] }, roles);
  assert.equal(kept.ok, true);
  assert.deepEqual(kept.value.steps, [{ role: 'coder', input: 'user' }]);
});
