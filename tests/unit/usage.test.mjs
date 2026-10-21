import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { load } from './_root.mjs';

const {
  normalizeUsage,
  contextUsed,
  contextWindowFromEnv,
  formatTokenCount,
  formatContextValue,
  presentContext,
  composerContextText,
} = await load('public/usage.js');
const { createSqliteStore } = await load('src/store/sqlite.mjs');

test('token formatting matches the composer mockup scale', () => {
  assert.equal(formatTokenCount(999), '999');
  assert.equal(formatTokenCount(1200), '1.2k');
  assert.equal(formatTokenCount(16400), '16.4k');
  assert.equal(formatTokenCount(128000), '128k');
  assert.equal(formatTokenCount(200000), '200k');
  assert.equal(formatTokenCount(1_500_000), '1.5M');
  assert.equal(formatTokenCount(-1), null);
});

test('unknown usage stays an em dash and does not invent a count', () => {
  assert.equal(normalizeUsage(null), null);
  assert.equal(normalizeUsage({}), null);
  assert.equal(normalizeUsage({ prompt_tokens: '1200' }), null);
  assert.equal(normalizeUsage({ text: 'hello world' }), null);
  assert.equal(formatContextValue(null, 128000), '—');
  assert.equal(formatContextValue({}, 200000), '—');
  assert.equal(composerContextText(null), '—');
  assert.equal(composerContextText({}), '—');
  assert.equal(composerContextText({ contextWindow: 128000 }), '—');
});

test('latest provider usage is shown against the reported or configured window', () => {
  const openai = normalizeUsage({ prompt_tokens: 1200, completion_tokens: 40, total_tokens: 1240 });
  assert.deepEqual(openai, { input: 1200, output: 40, total: 1240 });
  assert.equal(contextUsed(openai), 1240);
  assert.equal(formatContextValue(openai, 128000), '1.2k / 128k');
  assert.equal(composerContextText({ usage: openai, contextWindow: 128000 }), '1.2k / 128k');

  const withWindow = normalizeUsage({ input_tokens: 16400, output_tokens: 10, total_tokens: 16410, context_window: 200000 });
  assert.equal(formatContextValue(withWindow, 128000), '16.4k / 200k');

  const pi = normalizeUsage({
    models: {
      a: { input: 100, output: 5, cacheRead: 20 },
      b: { input: 10, output: 1 },
    },
  });
  assert.equal(pi.input, 110);
  assert.equal(pi.output, 6);
  assert.equal(pi.cacheRead, 20);
  assert.equal(contextUsed(pi), 136);

  const topWins = normalizeUsage({ input: 5, models: { a: { input: 100, output: 9 } } });
  assert.equal(topWins.input, 5);
  assert.equal(topWins.output, undefined);

  assert.equal(contextWindowFromEnv({}), 128000);
  assert.equal(contextWindowFromEnv({ LLM_CONTEXT_WINDOW: 'nope' }), 128000);
  assert.equal(contextWindowFromEnv({ LLM_CONTEXT_WINDOW: '64000' }), 64000);
  const presented = presentContext(
    { prompt_tokens: 1200, completion_tokens: 0, total_tokens: 1200 },
    { LLM_CONTEXT_WINDOW: '200000' },
  );
  assert.equal(presented.usage.total, 1200);
  assert.equal(presented.contextWindow, 200000);
  assert.equal(presented.contextLabel, '1.2k / 200k');
  assert.equal(presentContext(null, {}).contextLabel, '—');
  assert.equal(formatContextValue({ total: 0 }, 128000), '0 / 128k');
});

test('sqlite keeps the latest usage across later conversation updates', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'piw-usage-'));
  const store = createSqliteStore(dir);
  try {
    const conv = await store.createConversation({ workspaceId: 'w', title: 't' });
    assert.equal(conv.usage, null);
    const usage = { input: 1200, output: 40, total: 1240 };
    await store.updateConversation(conv.id, { usage, title: 't2' });
    const loaded = await store.getConversation(conv.id);
    assert.equal(loaded.title, 't2');
    assert.deepEqual(loaded.usage, usage);
  } finally {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
