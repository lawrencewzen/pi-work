import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentEventData } from '../../src/core/agents.mjs';
import { activityFields, currentActionText } from '../../src/kernel/subagents.mjs';

function userEntry(content, timestamp) {
  return { kind: 'pi.user', model: [{ role: 'user', content, ...(timestamp != null ? { timestamp } : {}) }] };
}

function assistantText(text, timestamp) {
  return {
    kind: 'pi.assistant',
    model: [{
      role: 'assistant',
      content: [{ type: 'text', text }],
      ...(timestamp != null ? { timestamp } : {}),
    }],
  };
}

function assistantTool(name, args, timestamp) {
  return {
    kind: 'pi.assistant',
    model: [{
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'c1', name, arguments: args || {} }],
      ...(timestamp != null ? { timestamp } : {}),
    }],
  };
}

function toolResult(name, timestamp) {
  return {
    kind: 'pi.tool-result',
    model: [{
      role: 'toolResult',
      toolCallId: 'c1',
      toolName: name,
      content: [],
      ...(timestamp != null ? { timestamp } : {}),
    }],
  };
}

test('currentActionText prefers description and otherwise uses name: primary arg', () => {
  assert.equal(currentActionText('bash', { command: 'npm test', description: '跑单元测试' }), '跑单元测试');
  assert.equal(currentActionText('bash', { command: 'npm test' }), 'bash: npm test');
  assert.equal(currentActionText('read', { path: 'src/auth.ts' }), 'read: src/auth.ts');
  assert.equal(currentActionText('read', { path: 'src/auth.ts', description: '   ' }), 'read: src/auth.ts');
  const long = currentActionText('read', { path: `src/${'a'.repeat(80)}.ts` });
  assert.equal(long.length, 60);
  assert.equal(long.startsWith('read: src/'), true);
});

test('running child exposes brief, timestamps, and currentAction from the last tool', () => {
  const running = activityFields({
    entries: [
      userEntry('Inspect auth.ts', 1000),
      assistantTool('read', { path: 'src/auth.ts', description: '看登录逻辑' }, 2000),
      toolResult('read', 3000),
    ],
  }, 'running');
  assert.deepEqual(running, {
    brief: 'Inspect auth.ts',
    startedAt: 1000,
    lastActivityAt: 3000,
    currentAction: '看登录逻辑',
  });
  assert.equal(running.endedAt, undefined);

  const fallback = activityFields({
    entries: [
      userEntry('RUN_TESTS please', 10),
      assistantTool('bash', { command: 'npm test' }, 20),
      toolResult('bash', 30),
    ],
  }, 'running');
  assert.equal(fallback.currentAction, 'bash: npm test');
  assert.equal(fallback.brief, 'RUN_TESTS please');
});

test('done child exposes endedAt and omits currentAction', () => {
  const done = activityFields({
    entries: [
      userEntry('Inspect auth.ts', 1000),
      assistantTool('read', { path: 'src/auth.ts' }, 2000),
      toolResult('read', 3000),
      assistantText('child-done', 4000),
    ],
  }, 'done');
  assert.equal(done.brief, 'Inspect auth.ts');
  assert.equal(done.startedAt, 1000);
  assert.equal(done.lastActivityAt, 4000);
  assert.equal(done.endedAt, 4000);
  assert.equal(done.currentAction, undefined);
});

test('assistant-only last message omits currentAction while running', () => {
  const fields = activityFields({
    entries: [
      userEntry('say hi', 1),
      assistantTool('read', { path: 'a.ts' }, 2),
      toolResult('read', 3),
      assistantText('just text', 4),
    ],
  }, 'running');
  assert.equal(fields.currentAction, undefined);
  assert.equal(fields.lastActivityAt, 4);
  assert.equal(fields.endedAt, undefined);
});

test('old messages without timestamp omit time fields and do not throw', () => {
  const done = activityFields({
    entries: [
      userEntry('legacy task'),
      assistantText('legacy answer'),
    ],
  }, 'done');
  assert.equal(done.brief, 'legacy task');
  assert.equal(done.startedAt, undefined);
  assert.equal(done.lastActivityAt, undefined);
  assert.equal(done.endedAt, undefined);
  assert.equal(done.currentAction, undefined);

  const running = activityFields({
    messages: [
      { role: 'user', text: 'old' },
      { role: 'tool', tool: { name: 'read', input: { path: 'src/auth.ts' } } },
    ],
  }, 'running');
  assert.equal(running.brief, 'old');
  assert.equal(running.currentAction, 'read: src/auth.ts');
  assert.equal(running.startedAt, undefined);
  assert.equal(running.lastActivityAt, undefined);
});

test('first message without timestamp does not borrow a later one for startedAt', () => {
  const fields = activityFields({
    entries: [
      userEntry('task'),
      assistantText('ok', 5000),
    ],
  }, 'done');
  assert.equal(fields.startedAt, undefined);
  assert.equal(fields.lastActivityAt, 5000);
  assert.equal(fields.endedAt, 5000);
});

test('agentEventData passes optional fields for sub-agents and strips currentAction when not running', () => {
  const running = agentEventData({
    id: 'c:sub:1',
    roleId: 'coder',
    name: 'Coder',
    status: 'running',
    step: 2,
    totalSteps: 2,
    lastText: '',
    brief: 'Inspect auth.ts',
    startedAt: 1000,
    lastActivityAt: 3000,
    currentAction: '看登录逻辑',
    endedAt: 3000,
  });
  assert.equal(running.brief, 'Inspect auth.ts');
  assert.equal(running.startedAt, 1000);
  assert.equal(running.lastActivityAt, 3000);
  assert.equal(running.currentAction, '看登录逻辑');
  assert.equal(running.endedAt, undefined);

  const stopped = agentEventData({
    id: 'c:sub:1',
    roleId: 'coder',
    name: 'Coder',
    status: 'running',
    step: 2,
    totalSteps: 2,
    lastText: '',
    brief: 'Inspect auth.ts',
    startedAt: 1000,
    lastActivityAt: 3000,
    currentAction: '看登录逻辑',
    endedAt: 4000,
  }, 'stopped');
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.currentAction, undefined);
  assert.equal(stopped.endedAt, 4000);
  assert.equal(stopped.brief, 'Inspect auth.ts');

  const chip = agentEventData({
    id: 'c:agent:0',
    roleId: 'default',
    name: 'Default',
    status: 'waiting',
    step: 0,
    totalSteps: 0,
    lastText: '',
  });
  assert.equal(Object.hasOwn(chip, 'brief'), false);
  assert.equal(Object.hasOwn(chip, 'startedAt'), false);
  assert.equal(Object.hasOwn(chip, 'currentAction'), false);
  assert.equal(Object.hasOwn(chip, 'endedAt'), false);
});
