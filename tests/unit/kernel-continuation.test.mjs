import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createModels } from '@earendil-works/pi-ai/models';
import { messagesFromEntries } from '../../src/kernel/events.mjs';
import {
  CONTINUE_TEXT,
  MAX_AUTO_CONTINUES,
  consecutiveAutoContinues,
  isAutoContinueText,
  shouldContinueFromLength,
} from '../../src/kernel/continuation.mjs';
import { createKernelModels, DEFAULT_MAX_OUTPUT_TOKENS, maxOutputTokensFromEnv } from '../../src/kernel/models.mjs';
import { autoTitleFromText } from '../../src/kernel/agent-config.mjs';
import { applyMessageDone } from '../../public/stream.js';
import { request as serverRequest, startServer, stopServer } from './_server.mjs';

const TOKEN = 'unit-kernel-continuation-token';
const KEY = 'sk-continuation-secret';
const request = (base, method, apiPath, body) => serverRequest(base, method, apiPath, body, TOKEN);

async function openConversation(base, title = 'continuation') {
  const ws = await request(base, 'POST', '/api/workspaces', { name: 'continuation-ws' });
  assert.equal(ws.status, 201);
  const conv = await request(base, 'POST', `/api/workspaces/${ws.body.id}/conversations`, { title });
  assert.equal(conv.status, 201);
  return { ws: ws.body, conv: conv.body };
}

async function waitFor(base, cid, ready, attempts = 80) {
  let body = null;
  for (let i = 0; i < attempts; i += 1) {
    const got = await request(base, 'GET', `/api/conversations/${cid}`);
    body = got.body;
    if (ready(body)) return body;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return body;
}

async function writeScript(dataDir, name, turns) {
  const file = path.join(dataDir, name);
  await writeFile(file, JSON.stringify({ turns }));
  return file;
}

test('maxTokens defaults to 32768 and WEFT_MAX_OUTPUT_TOKENS overrides', async () => {
  assert.equal(maxOutputTokensFromEnv({}), DEFAULT_MAX_OUTPUT_TOKENS);
  assert.equal(maxOutputTokensFromEnv({ WEFT_MAX_OUTPUT_TOKENS: '2048' }), 2048);
  assert.equal(maxOutputTokensFromEnv({ WEFT_MAX_OUTPUT_TOKENS: 'nope' }), DEFAULT_MAX_OUTPUT_TOKENS);
  assert.equal(maxOutputTokensFromEnv({ WEFT_MAX_OUTPUT_TOKENS: '0' }), DEFAULT_MAX_OUTPUT_TOKENS);
  assert.equal(maxOutputTokensFromEnv({ WEFT_MAX_OUTPUT_TOKENS: '-8' }), DEFAULT_MAX_OUTPUT_TOKENS);
  assert.equal(maxOutputTokensFromEnv({ WEFT_MAX_OUTPUT_TOKENS: '1.5' }), DEFAULT_MAX_OUTPUT_TOKENS);

  const settings = {
    version: 2,
    sources: [{
      id: 'srcdefault',
      kind: 'api',
      vendor: 'custom',
      name: 'Default',
      baseUrl: 'http://127.0.0.1:4101/v1',
      apiKey: KEY,
      models: ['model-default'],
    }],
    models: { default: { sourceId: 'srcdefault', model: 'model-default' } },
  };

  async function tokensFor(env) {
    const models = createModels();
    const routes = createKernelModels({ models, getSettings: async () => settings, env });
    const main = await routes.modelFor({});
    return models.getModel(main.provider, main.modelId).maxTokens;
  }

  assert.equal(await tokensFor({}), 32768);
  assert.equal(await tokensFor({ WEFT_MAX_OUTPUT_TOKENS: '8192' }), 8192);
  assert.equal(await tokensFor({ WEFT_MAX_OUTPUT_TOKENS: 'abc' }), 32768);
});

test('consecutive auto-continues stop after the cap', () => {
  assert.equal(isAutoContinueText(CONTINUE_TEXT), true);
  assert.equal(isAutoContinueText('hello'), false);
  assert.equal(autoTitleFromText('New conversation', CONTINUE_TEXT), undefined);
  assert.equal(autoTitleFromText('New conversation', 'hello world'), 'hello world');

  const prompt = { role: 'user', content: 'hello' };
  const auto = { role: 'user', content: CONTINUE_TEXT };
  const answer = { stopReason: 'length' };
  assert.equal(shouldContinueFromLength(answer, [prompt]), true);
  assert.equal(shouldContinueFromLength({ stopReason: 'stop' }, [prompt]), false);

  const underCap = [prompt, ...Array.from({ length: MAX_AUTO_CONTINUES - 1 }, () => auto)];
  const atCap = [prompt, ...Array.from({ length: MAX_AUTO_CONTINUES }, () => auto)];
  assert.equal(consecutiveAutoContinues(underCap), MAX_AUTO_CONTINUES - 1);
  assert.equal(shouldContinueFromLength(answer, underCap), true);
  assert.equal(consecutiveAutoContinues(atCap), MAX_AUTO_CONTINUES);
  assert.equal(shouldContinueFromLength(answer, atCap), false);
  assert.equal(shouldContinueFromLength(answer, null), false);
  assert.equal(consecutiveAutoContinues([
    { kind: 'pi.user', model: [{ content: 'hello' }] },
    { kind: 'pi.assistant', model: [{ content: 'a' }] },
    { kind: 'pi.user', model: [{ content: CONTINUE_TEXT }] },
  ]), 1);
});

test('assistant snapshots carry stopReason and auto-continue kind', () => {
  const { messages } = messagesFromEntries([
    {
      id: 1,
      kind: 'pi.user',
      model: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    },
    {
      id: 2,
      kind: 'pi.assistant',
      model: [{
        role: 'assistant',
        content: [{ type: 'text', text: 'part-one' }],
        stopReason: 'length',
      }],
    },
    {
      id: 3,
      kind: 'pi.user',
      model: [{ role: 'user', content: [{ type: 'text', text: CONTINUE_TEXT }] }],
    },
    {
      id: 4,
      kind: 'pi.assistant',
      model: [{
        role: 'assistant',
        content: [{ type: 'text', text: 'part-two' }],
        stopReason: 'stop',
      }],
    },
  ]);
  assert.equal(messages.find((message) => message.id === '2').stopReason, 'length');
  assert.equal(messages.find((message) => message.id === '4').stopReason, 'stop');
  assert.equal(messages.find((message) => message.id === '3').kind, 'auto-continue');
  assert.equal(Object.hasOwn(messages.find((message) => message.id === '1'), 'kind'), false);
});

test('message.done inserts an auto-continue user row for the live thread', () => {
  const msgs = [
    { id: '1', role: 'user', text: 'hello' },
    { id: '2', role: 'assistant', text: 'part-one', stopReason: 'length', done: true },
  ];
  applyMessageDone(msgs, {
    messageId: '3',
    role: 'user',
    text: CONTINUE_TEXT,
    kind: 'auto-continue',
  });
  assert.equal(msgs.length, 3);
  assert.equal(msgs[2].kind, 'auto-continue');
  assert.equal(isAutoContinueText(msgs[2].text), true);
  applyMessageDone(msgs, {
    messageId: '4',
    text: 'part-two',
    stopReason: 'stop',
  });
  assert.equal(msgs[3].stopReason, 'stop');
});

test('kernel path: length then stop auto-continues into one run', { timeout: 30000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-kcont-'));
  const script = await writeScript(dataDir, 'continue.json', [
    { text: 'part-one', stopReason: 'length' },
    { text: 'part-two' },
  ]);
  const srv = await startServer({
    token: TOKEN,
    dataDir,
    env: { WEFT_LLM: 'faux', WEFT_FAUX_SCRIPT: script },
  });
  try {
    const { conv } = await openConversation(srv.base);
    const sent = await request(srv.base, 'POST', `/api/conversations/${conv.id}/messages`, { text: 'write a long answer' });
    assert.equal(sent.status, 202);
    const body = await waitFor(srv.base, conv.id, (row) => row.status === 'done');
    assert.equal(body.status, 'done', srv.logs());
    const users = body.messages.filter((message) => message.role === 'user');
    const assistants = body.messages.filter((message) => message.role === 'assistant');
    assert.equal(users.length, 2);
    assert.equal(users[0].text, 'write a long answer');
    assert.equal(users[1].kind, 'auto-continue');
    assert.equal(isAutoContinueText(users[1].text), true);
    assert.equal(assistants.length, 2);
    assert.equal(assistants[0].text, 'part-one');
    assert.equal(assistants[0].stopReason, 'length');
    assert.equal(assistants[1].text, 'part-two');
    assert.notEqual(assistants[1].stopReason, 'length');
    assert.equal(body.title, 'continuation');
  } finally {
    await stopServer(srv);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('kernel path: consecutive length stops after eight auto-continues', { timeout: 30000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-kcap-'));
  const turns = Array.from({ length: MAX_AUTO_CONTINUES + 2 }, (_, i) => ({
    text: `chunk-${i + 1}`,
    stopReason: 'length',
  }));
  const script = await writeScript(dataDir, 'cap.json', turns);
  const srv = await startServer({
    token: TOKEN,
    dataDir,
    env: { WEFT_LLM: 'faux', WEFT_FAUX_SCRIPT: script },
  });
  try {
    const { conv } = await openConversation(srv.base, 'cap');
    const sent = await request(srv.base, 'POST', `/api/conversations/${conv.id}/messages`, { text: 'keep going' });
    assert.equal(sent.status, 202);
    const body = await waitFor(srv.base, conv.id, (row) => row.status === 'done');
    assert.equal(body.status, 'done', srv.logs());
    const users = body.messages.filter((message) => message.role === 'user');
    const assistants = body.messages.filter((message) => message.role === 'assistant');
    const autos = users.filter((message) => message.kind === 'auto-continue');
    assert.equal(users[0].text, 'keep going');
    assert.equal(autos.length, MAX_AUTO_CONTINUES);
    assert.equal(assistants.length, MAX_AUTO_CONTINUES + 1);
    assert.equal(assistants.at(-1).text, `chunk-${MAX_AUTO_CONTINUES + 1}`);
    assert.equal(assistants.at(-1).stopReason, 'length');
    assert.equal(assistants.every((message) => message.stopReason === 'length'), true);
  } finally {
    await stopServer(srv);
    await rm(dataDir, { recursive: true, force: true });
  }
});
