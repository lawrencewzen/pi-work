import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from './_root.mjs';

const { buildAgents, agentEventData } = await load('src/core/agents.mjs');
const { effectiveModelFor } = await load('src/core/model-sources.mjs');

test('buildAgents names the main agent Agent and has no role field', () => {
  const agents = buildAgents({
    conv: { id: 'c1', status: 'idle' },
    messages: [{ role: 'assistant', text: 'hi' }],
  });
  assert.equal(agents.length, 1);
  assert.equal(agents[0].id, 'c1:agent:0');
  assert.equal(agents[0].name, 'Agent');
  assert.equal(agents[0].status, 'waiting');
  assert.equal(agents[0].lastText, 'hi');
  assert.equal(Object.hasOwn(agents[0], 'roleId'), false);
});

test('agentEventData omits retired role fields', () => {
  const data = agentEventData({
    id: 'c1:agent:0',
    name: 'Agent',
    status: 'waiting',
    step: 0,
    totalSteps: 0,
    lastText: '',
  });
  assert.equal(data.name, 'Agent');
  assert.equal(Object.hasOwn(data, 'roleId'), false);
});

test('effectiveModel follows settings.models.default then the first usable source', () => {
  const settings = {
    sources: [{
      id: 'src1', kind: 'api', vendor: 'custom', name: 'A',
      baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'key', models: ['alpha', 'beta'],
    }],
    models: { default: { sourceId: 'src1', model: 'alpha' }, coder: { sourceId: 'src1', model: 'beta' } },
  };
  assert.deepEqual(effectiveModelFor(settings), { sourceId: 'src1', model: 'alpha', follow: false });
  assert.deepEqual(effectiveModelFor({
    sources: settings.sources,
    models: { coder: { sourceId: 'src1', model: 'beta' } },
  }), { sourceId: 'src1', model: 'alpha', follow: true });
  assert.deepEqual(effectiveModelFor({ sources: [], models: {} }), {
    sourceId: null, model: null, follow: true,
  });
});
