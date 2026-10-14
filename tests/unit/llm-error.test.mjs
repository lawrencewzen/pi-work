import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from './_root.mjs';

const { createOpenAILLM, providerErrorText } = await load('src/llm/openai.mjs');

test('provider error text keeps the proxy message and redacts secrets', () => {
  const text = providerErrorText(JSON.stringify({
    error: { message: 'client version 0.1.220 is outdated; requires >= 1.0.13 sk-supersecret' },
  }), 426);
  assert.match(text, /outdated/);
  assert.match(text, /1\.0\.13/);
  assert.equal(text.includes('sk-supersecret'), false);
  assert.equal(text.includes('0.1.220'), true);
  assert.equal(providerErrorText('', 426), 'LLM HTTP 426');
});

test('chat completion failures surface E_LLM with the provider message', async () => {
  const llm = createOpenAILLM({
    baseUrl: 'http://llm.test/v1',
    apiKey: 'test-key',
    model: 'grok-build',
  });
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 426,
    async text() {
      return JSON.stringify({
        error: { message: 'client version 0.1.220 is outdated; requires >= 1.0.13' },
      });
    },
  });
  try {
    await assert.rejects(
      () => llm.next({ messages: [{ role: 'user', content: 'hi' }] }),
      (err) => {
        assert.equal(err.code, 'E_LLM');
        assert.equal(err.status, 426);
        assert.match(err.message, /requires >= 1\.0\.13/);
        assert.equal(err.message.includes('{'), false);
        return true;
      },
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('a dropped response body is a retryable stream cut', async () => {
  const llm = createOpenAILLM({
    baseUrl: 'http://llm.test/v1',
    apiKey: 'test-key',
    model: 'grok-build',
  });
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    async text() {
      const err = new TypeError('terminated');
      err.cause = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' });
      throw err;
    },
  });
  try {
    await assert.rejects(
      () => llm.next({ messages: [{ role: 'user', content: 'hi' }] }),
      (err) => err.code === 'E_STREAM_CUT' && err.message === 'terminated',
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('an HTTP body that only says terminated is a stream cut', async () => {
  const llm = createOpenAILLM({
    baseUrl: 'http://llm.test/v1',
    apiKey: 'test-key',
    model: 'grok-build',
  });
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 502,
    async text() { return 'terminated'; },
  });
  try {
    await assert.rejects(
      () => llm.next({ messages: [{ role: 'user', content: 'hi' }] }),
      (err) => err.code === 'E_STREAM_CUT' && err.status === 502,
    );
  } finally {
    globalThis.fetch = original;
  }
});
