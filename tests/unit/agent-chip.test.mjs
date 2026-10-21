import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from './_root.mjs';

const {
  resolveDispatchModel,
  resolveRoleTarget,
  resolveConversationModel,
  sourceUsable,
  sourceBlockReason,
  needsFreshKey,
  isMaskedOrEmptyKey,
  composerAgentPresentation,
} = await load('public/agent-chip.js');

const roles = [
  { id: 'default', name: 'Default' },
  { id: 'coder', name: 'Coder', model: 'role-model' },
  { id: 'tester', name: 'Tester' },
];

const grok = {
  id: 'grok',
  kind: 'grok',
  name: 'Grok 订阅',
  models: ['grok-build'],
  session: { signedIn: true },
};
const deepseek = {
  id: 'ds',
  kind: 'api',
  vendor: 'deepseek',
  name: 'DeepSeek',
  baseUrl: 'https://api.deepseek.com/v1',
  hasApiKey: true,
  apiKey: '••••3f2a',
  models: ['deepseek-chat', 'deepseek-reasoner'],
};
const offline = {
  id: 'local',
  kind: 'api',
  vendor: 'ollama',
  name: '本地 Ollama',
  baseUrl: 'http://127.0.0.1:11434/v1',
  hasApiKey: false,
  models: ['llama3.2'],
  lastTest: { ok: false, at: '2026-10-14T00:00:00.000Z', error: 'connect failed' },
};

test('chip stays empty when no usable source is configured', () => {
  assert.equal(resolveDispatchModel({}), '');
  assert.equal(resolveDispatchModel({ models: { coder: 'grok-4' } }), '');
  assert.equal(resolveDispatchModel({
    models: { default: { sourceId: 'missing', model: 'ghost' } },
    sources: [deepseek],
  }), 'deepseek-chat');
  const view = composerAgentPresentation({
    conv: null,
    roles,
    models: {},
    sources: [],
  });
  assert.equal(view.text, '');
  assert.equal(view.model, '');
  assert.equal(view.followingDefault, true);
});

test('role binding, then default, then the first model of the first usable source', () => {
  const sources = [grok, deepseek, offline];
  assert.equal(resolveDispatchModel({
    sources,
    grokSignedIn: true,
  }), 'grok-build');
  assert.equal(resolveDispatchModel({
    roleId: 'tester',
    models: { default: { sourceId: 'ds', model: 'deepseek-chat' } },
    sources,
    grokSignedIn: true,
  }), 'deepseek-chat');
  assert.equal(resolveDispatchModel({
    roleId: 'coder',
    models: {
      coder: { sourceId: 'ds', model: 'deepseek-reasoner' },
      default: { sourceId: 'grok', model: 'grok-build' },
    },
    sources,
    grokSignedIn: true,
  }), 'deepseek-reasoner');
  assert.equal(resolveDispatchModel({
    roleId: 'tester',
    models: { tester: { sourceId: 'local', model: 'llama3.2' }, default: { sourceId: 'grok', model: 'grok-build' } },
    sources,
    grokSignedIn: true,
  }), 'grok-build');
});

test('unsigned grok, missing key, and a failed test are not usable', () => {
  const signedOut = { ...grok, session: { signedIn: false } };
  assert.equal(sourceUsable(signedOut, { grokSignedIn: false }), false);
  assert.equal(sourceBlockReason(signedOut, { grokSignedIn: false }), 'unsigned');
  assert.equal(sourceUsable(grok, { grokSignedIn: true }), true);
  const bare = { ...deepseek, hasApiKey: false, apiKey: '' };
  assert.equal(sourceBlockReason(bare), 'no_key');
  assert.equal(sourceUsable(offline), false);
  assert.equal(sourceBlockReason(offline), 'offline');
  assert.equal(resolveDispatchModel({
    models: { default: { sourceId: 'grok', model: 'grok-build' } },
    sources: [signedOut, deepseek],
    grokSignedIn: false,
  }), 'deepseek-chat');
});

test('a role template model prefers a source that lists it', () => {
  const target = resolveRoleTarget({
    role: roles[1],
    roleId: 'coder',
    models: { coder: { sourceId: 'ds', model: 'deepseek-chat' }, default: { sourceId: 'grok', model: 'grok-build' } },
    sources: [grok, { ...deepseek, models: ['deepseek-chat', 'role-model'] }],
    grokSignedIn: true,
  });
  assert.equal(target.model, 'role-model');
  assert.equal(target.source.id, 'ds');
  assert.equal(resolveDispatchModel({
    role: { id: 'coder', model: 'from-template' },
    roleId: 'coder',
    models: { default: { sourceId: 'grok', model: 'grok-build' } },
    sources: [grok],
    grokSignedIn: true,
  }), 'from-template');
});

test('conversation model override wins when that source is usable', () => {
  const conv = {
    roleId: 'tester',
    modelSourceId: 'ds',
    modelId: 'deepseek-reasoner',
  };
  const pinned = resolveConversationModel({
    conv,
    sources: [grok, deepseek],
    grokSignedIn: true,
  });
  assert.equal(pinned.model, 'deepseek-reasoner');
  const view = composerAgentPresentation({
    conv,
    roles,
    models: { tester: { sourceId: 'grok', model: 'grok-build' }, default: { sourceId: 'grok', model: 'grok-build' } },
    sources: [grok, deepseek],
    grokSignedIn: true,
  });
  assert.equal(view.model, 'deepseek-reasoner');
  assert.equal(view.text, 'deepseek-reasoner');
  assert.equal(view.followingDefault, false);
});

test('conversation model falls back when that source is not usable', () => {
  const view = composerAgentPresentation({
    conv: { modelSourceId: 'local', modelId: 'llama3.2' },
    roles,
    models: { default: { sourceId: 'grok', model: 'grok-build' } },
    sources: [grok, offline],
    grokSignedIn: true,
  });
  assert.equal(view.model, 'grok-build');
  assert.equal(view.followingDefault, true);
});

test('a new host without a new key is rejected before the request', () => {
  assert.equal(isMaskedOrEmptyKey(''), true);
  assert.equal(isMaskedOrEmptyKey('••••3f2a', '••••3f2a'), true);
  assert.equal(isMaskedOrEmptyKey('sk-new-key', '••••3f2a'), false);
  assert.equal(needsFreshKey({
    previousUrl: 'https://api.deepseek.com/v1',
    nextUrl: 'https://example.test/v1',
    apiKey: '••••3f2a',
    maskedKey: '••••3f2a',
  }), true);
  assert.equal(needsFreshKey({
    previousUrl: 'https://api.deepseek.com/v1',
    nextUrl: 'https://api.deepseek.com/v2',
    apiKey: '',
    maskedKey: '••••3f2a',
  }), false);
  assert.equal(needsFreshKey({
    previousUrl: 'http://127.0.0.1:11434/v1',
    nextUrl: 'http://127.0.0.1:11435/v1',
    needsKey: false,
  }), false);
  assert.equal(needsFreshKey({
    previousUrl: 'https://api.deepseek.com/v1',
    nextUrl: 'https://gateway.internal/v1',
    apiKey: 'sk-fresh',
    maskedKey: '••••3f2a',
  }), false);
});
