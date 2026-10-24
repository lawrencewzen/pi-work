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
  contextPercents,
  composerContextChip,
  resolveContextWindow,
  sourceDefaultContextWindow,
  sourceModelContextWindow,
  hasCustomContextWindow,
  contextOverrideKey,
  contextWindowPresetOptions,
  CONTEXT_WINDOW_PRESETS,
  DEFAULT_CONTEXT_WINDOW,
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

test('context percents round and always sum to 100', () => {
  assert.deepEqual(contextPercents(0, 128000), { usedPct: 0, remainPct: 100, ratio: 0 });
  assert.deepEqual(contextPercents(null, 128000), { usedPct: 0, remainPct: 100, ratio: 0 });
  const mid = contextPercents(16400, 200000);
  assert.equal(mid.usedPct, 8);
  assert.equal(mid.remainPct, 92);
  assert.equal(mid.usedPct + mid.remainPct, 100);
  const warn = contextPercents(102400, 128000);
  assert.equal(warn.usedPct, 80);
  assert.equal(warn.remainPct, 20);
  const full = contextPercents(300000, 256000);
  assert.equal(full.usedPct, 100);
  assert.equal(full.remainPct, 0);
  assert.equal(full.ratio, 1);
});

test('composer chip treats missing usage as 0% and warns at 80%', () => {
  const idle = composerContextChip({ usage: null, window: 128000 });
  assert.equal(idle.usedPct, 0);
  assert.equal(idle.remainPct, 100);
  assert.equal(idle.windowText, '128k');
  assert.equal(idle.warn, false);
  const used = composerContextChip({
    usage: { prompt_tokens: 16000, completion_tokens: 400, total_tokens: 16400 },
    window: 200000,
  });
  assert.equal(used.usedPct, 8);
  assert.equal(used.remainPct, 92);
  assert.equal(used.windowText, '200k');
  assert.equal(used.usedText, '16.4k');
  const hot = composerContextChip({ usage: { total: 102400 }, window: 128000 });
  assert.equal(hot.warn, true);
  assert.equal(hot.usedPct, 80);
});

test('window priority is override, then conversation for that model, then settings', () => {
  const source = {
    id: 'src-a',
    defaultContextWindow: 128000,
    contextWindows: { 'grok-4.6': 64000, 'grok-4': 256000 },
  };
  assert.equal(sourceModelContextWindow(source, 'grok-4.6'), 64000);
  assert.equal(sourceModelContextWindow(source, 'other'), 128000);
  const catalogSource = {
    id: 'src-ds',
    defaultContextWindow: 128000,
    defaultContextWindows: { 'deepseek-flash': 1_000_000 },
    contextWindows: {},
  };
  assert.equal(sourceDefaultContextWindow(catalogSource, 'deepseek-flash'), 1_000_000);
  assert.equal(sourceDefaultContextWindow(catalogSource, 'other'), 128000);
  assert.equal(sourceModelContextWindow(catalogSource, 'deepseek-flash'), 1_000_000);
  assert.equal(sourceDefaultContextWindow(catalogSource), 128000);
  assert.equal(hasCustomContextWindow(source, 'grok-4.6'), true);
  assert.equal(hasCustomContextWindow(source, 'other'), false);
  assert.equal(DEFAULT_CONTEXT_WINDOW, 128000);

  assert.equal(resolveContextWindow({
    model: 'grok-4.6',
    source,
    conversationWindow: 200000,
    conversationWindowModel: 'grok-4.6',
    overrides: { [contextOverrideKey(source.id, 'grok-4.6')]: 256000 },
  }), 256000);

  assert.equal(resolveContextWindow({
    model: 'grok-4.6',
    source: { id: 'src-a', defaultContextWindow: 128000, contextWindows: {} },
    conversationWindow: 200000,
    conversationWindowModel: 'grok-4.6',
    overrides: { [contextOverrideKey('src-a', 'grok-4.6')]: null },
  }), 128000);

  assert.equal(resolveContextWindow({
    model: 'grok-4.6',
    source,
    conversationWindow: 200000,
    conversationWindowModel: 'grok-4.6',
    overrides: {},
  }), 200000);

  assert.equal(resolveContextWindow({
    model: 'grok-4',
    source,
    conversationWindow: 200000,
    conversationWindowModel: 'grok-4.6',
    overrides: {},
  }), 256000);

  assert.equal(resolveContextWindow({
    model: 'grok-4.6',
    source,
  }), 64000);

  assert.equal(formatTokenCount(32000), '32k');
  assert.equal(formatTokenCount(256000), '256k');
  assert.equal(formatTokenCount(400000), '400k');
  assert.equal(formatTokenCount(1_000_000), '1M');
  assert.deepEqual(CONTEXT_WINDOW_PRESETS, [32000, 64000, 128000, 200000, 256000, 400000, 1_000_000]);
  const presets = contextWindowPresetOptions(192000);
  assert.equal(presets.some((row) => row.custom && row.tokens === 192000 && row.selected), true);
  assert.equal(contextWindowPresetOptions(128000).some((row) => row.custom), false);
});

test('two sources with the same model name keep separate windows', () => {
  const a = { id: 'src-a', defaultContextWindow: 128000, contextWindows: { shared: 64000 } };
  const b = { id: 'src-b', defaultContextWindow: 128000, contextWindows: { shared: 256000 } };
  assert.equal(resolveContextWindow({ model: 'shared', source: a }), 64000);
  assert.equal(resolveContextWindow({ model: 'shared', source: b }), 256000);

  const overrides = {
    [contextOverrideKey('src-a', 'shared')]: 32000,
    [contextOverrideKey('src-b', 'shared')]: 400000,
  };
  assert.equal(resolveContextWindow({ model: 'shared', source: a, overrides }), 32000);
  assert.equal(resolveContextWindow({ model: 'shared', source: b, overrides }), 400000);
  assert.equal(resolveContextWindow({
    model: 'shared',
    source: a,
    conversationWindow: 200000,
    conversationWindowModel: 'shared',
    overrides,
  }), 32000);
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
