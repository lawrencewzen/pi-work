import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from './_root.mjs';

const {
  resolveDispatchModel,
  activeDispatchTarget,
  composerAgentText,
  composerAgentPresentation,
} = await load('public/agent-chip.js');

const roles = [
  { id: 'default', name: 'Default' },
  { id: 'coder', name: 'Coder', model: 'role-model' },
  { id: 'tester', name: 'Tester' },
];

test('chip stays Agent when no model is configured', () => {
  assert.equal(composerAgentText({ agentName: 'Agent' }), 'Agent');
  assert.equal(resolveDispatchModel({}), '');
  assert.equal(resolveDispatchModel({ models: { coder: 'grok-4' } }), '');
  const view = composerAgentPresentation({
    conv: null,
    roles,
    models: {},
    agentName: 'Agent',
  });
  assert.equal(view.text, 'Agent');
  assert.equal(view.model, '');
});

test('default and role models match the server lookup order', () => {
  assert.equal(resolveDispatchModel({
    models: { default: 'grok-4.6' },
    sessionModel: 'grok-build',
  }), 'grok-4.6');
  assert.equal(resolveDispatchModel({
    roleId: 'tester',
    models: { tester: 'grok-4', default: 'grok-4.6' },
  }), 'grok-4');
  assert.equal(resolveDispatchModel({
    role: roles[1],
    roleId: 'coder',
    models: { coder: 'from-settings', default: 'grok-4.6' },
  }), 'role-model');
  assert.equal(resolveDispatchModel({
    roleId: 'tester',
    models: { default: 'grok-4.6' },
    sessionModel: 'grok-build',
  }), 'grok-4.6');
  assert.equal(resolveDispatchModel({ sessionModel: 'grok-build' }), 'grok-build');
  assert.equal(composerAgentText({ agentName: 'Agent', model: 'grok-4.6' }), 'Agent · grok-4.6');
  assert.equal(composerAgentText({ agentName: 'Agent', roleLabel: 'Coder' }), 'Agent · Coder');
});

test('pipeline step selects that role model', () => {
  const conv = { roleId: null, pipelineId: 'demo', pipelineStep: 1 };
  const pipelines = [{ id: 'demo', steps: [{ role: 'coder' }, { role: 'tester' }] }];
  const target = activeDispatchTarget({ conv, roles, pipelines });
  assert.equal(target.roleId, 'tester');
  const view = composerAgentPresentation({
    conv,
    roles,
    pipelines,
    models: { tester: 'tester-model', default: 'grok-4.6' },
    agentName: 'Agent',
    roleLabel: 'Tester',
  });
  assert.equal(view.model, 'tester-model');
  assert.equal(view.text, 'Agent · tester-model');
  assert.equal(view.roleId, 'tester');
});
