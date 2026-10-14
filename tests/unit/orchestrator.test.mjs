import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { load } from './_root.mjs';
const { createOrchestrator } = await load('src/core/orchestrator.mjs');
const { createFauxLLM } = await load('src/llm/faux.mjs');
const { createMemoryStore } = await load('src/store/memory.mjs');

async function waitFor(fn, ms = 5000) {
  const t = Date.now();
  while (Date.now() - t < ms) { if (await fn()) return; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error('timeout');
}

test('two agents run in parallel, isolated', async () => {
  const mk = async () => fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'piw-o-')));
  const [wa, wb] = [await mk(), await mk()];
  const llm = createFauxLLM({ perConversation: true, turns: [
    { delayMs: 200 }, { tool: 'write', args: { path: 'out.txt', content: 'hello\n' } }, { text: 'done' }] });
  const store = createMemoryStore();
  const orch = createOrchestrator({ llm, store });
  const t0 = Date.now();
  await orch.start('A', { workspacePath: wa, text: 'go A' });
  await orch.start('B', { workspacePath: wb, text: 'go B' });
  assert.equal(orch.status('A').status, 'running');
  assert.equal(orch.status('B').status, 'running');
  await waitFor(() => orch.status('A').status === 'done' && orch.status('B').status === 'done');
  assert.ok(Date.now() - t0 < 1500, 'should run concurrently, not serially');
  assert.equal(await fs.readFile(path.join(wa, 'out.txt'), 'utf8'), 'hello\n');
  assert.equal(await fs.readFile(path.join(wb, 'out.txt'), 'utf8'), 'hello\n');
  const ma = await store.getMessages('A'); const mb = await store.getMessages('B');
  assert.ok(ma.every((m) => !String(m.text ?? '').includes('go B')));
  assert.ok(mb.every((m) => !String(m.text ?? '').includes('go A')));
});

test('pause one agent does not affect the other; stop is terminal', async () => {
  const w = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'piw-o-')));
  const llm = createFauxLLM({ perConversation: true, turns: [{ delayMs: 300 }, { text: 'ok' }] });
  const orch = createOrchestrator({ llm, store: createMemoryStore() });
  await orch.start('A', { workspacePath: w, text: 'a' });
  await orch.start('B', { workspacePath: w, text: 'b' });
  await orch.pause('A');
  assert.equal(orch.status('A').status, 'paused');
  await waitFor(() => orch.status('B').status === 'done');
  assert.equal(orch.status('A').status, 'paused');
  await orch.resume('A');
  await waitFor(() => orch.status('A').status === 'done');
  await orch.start('C', { workspacePath: w, text: 'c' });
  await orch.stop('C');
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(orch.status('C').status, 'stopped');
});

function abortError() {
  const err = new Error('aborted');
  err.code = 'E_ABORTED';
  err.name = 'AbortError';
  return err;
}

test('message after stop starts a new run in the same conversation', async () => {
  const w = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'piw-o-')));
  let calls = 0;
  const llm = {
    async next({ signal } = {}) {
      calls += 1;
      if (calls === 1) {
        await new Promise((resolve, reject) => {
          const onAbort = () => reject(abortError());
          if (signal?.aborted) return onAbort();
          signal?.addEventListener('abort', onAbort, { once: true });
        });
        return { type: 'text', text: 'should-not-land' };
      }
      if (calls === 2) return { type: 'text', text: 'resumed-reply' };
      return { type: 'end' };
    },
  };
  const store = createMemoryStore();
  const orch = createOrchestrator({ llm, store });
  await orch.start('S', { workspacePath: w, text: 'first' });
  assert.equal(orch.status('S').status, 'running');
  await waitFor(() => calls >= 1);
  assert.equal((await orch.stop('S')).status, 'stopped');
  // Resume must not revive a terminated run; only a new user message does.
  assert.equal((await orch.resume('S')).status, 'stopped');
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(orch.status('S').status, 'stopped');
  assert.equal(calls, 1);

  const started = await orch.start('S', { workspacePath: w, text: 'second' });
  assert.equal(started.status, 'running');
  await waitFor(() => orch.status('S').status === 'done');
  const msgs = await store.getMessages('S');
  assert.ok(msgs.some((m) => m.role === 'user' && m.text === 'first'));
  assert.ok(msgs.some((m) => m.role === 'user' && m.text === 'second'));
  assert.equal(msgs.some((m) => m.text === 'should-not-land'), false);
  assert.ok(msgs.some((m) => m.role === 'assistant' && m.text === 'resumed-reply'));
});

test('model usage is stored from the latest call and emitted on SSE', async () => {
  const prevWindow = process.env.LLM_CONTEXT_WINDOW;
  process.env.LLM_CONTEXT_WINDOW = '128000';
  const w = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'piw-o-')));
  let n = 0;
  const llm = {
    async next() {
      n += 1;
      if (n === 1) {
        return {
          type: 'text',
          text: 'first',
          usage: { prompt_tokens: 1000, completion_tokens: 10, total_tokens: 1010 },
        };
      }
      if (n === 2) {
        return {
          type: 'text',
          text: 'second',
          usage: { prompt_tokens: 1500, completion_tokens: 20, total_tokens: 1520 },
        };
      }
      return { type: 'end' };
    },
  };
  const store = createMemoryStore();
  const orch = createOrchestrator({ llm, store });
  const events = [];
  orch.subscribe('U', (ev) => events.push(ev));
  try {
    await orch.start('U', { workspacePath: w, text: 'go' });
    await waitFor(() => orch.status('U').status === 'done');
    const conv = await store.getConversation('U');
    assert.equal(conv.usage.total, 1520);
    assert.equal(conv.usage.input, 1500);
    assert.notEqual(conv.usage.total, 1010 + 1520);
    const usageEvents = events.filter((ev) => ev.event === 'usage');
    assert.equal(usageEvents.length, 2);
    assert.equal(usageEvents[0].data.contextLabel, '1k / 128k');
    assert.equal(usageEvents[1].data.contextLabel, '1.5k / 128k');
    assert.equal(usageEvents[1].data.contextWindow, 128000);
    assert.equal(usageEvents[1].data.usage.total, 1520);
    assert.equal(orch.status('U').usage.total, 1520);
  } finally {
    if (prevWindow == null) delete process.env.LLM_CONTEXT_WINDOW;
    else process.env.LLM_CONTEXT_WINDOW = prevWindow;
  }
});

test('a run with no provider usage does not invent token counts', async () => {
  const w = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'piw-o-')));
  let n = 0;
  const llm = {
    async next() {
      n += 1;
      if (n === 1) return { type: 'text', text: 'hi' };
      return { type: 'end' };
    },
  };
  const store = createMemoryStore();
  const orch = createOrchestrator({ llm, store });
  const events = [];
  orch.subscribe('N', (ev) => events.push(ev));
  await orch.start('N', { workspacePath: w, text: 'go' });
  await waitFor(() => orch.status('N').status === 'done');
  const conv = await store.getConversation('N');
  assert.equal(conv.usage ?? null, null);
  assert.equal(events.some((ev) => ev.event === 'usage'), false);
  assert.equal(orch.status('N').usage ?? null, null);
});

test('stream cut is retried and run completes', async () => {
  const w = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'piw-o-')));
  const llm = createFauxLLM({ turns: [{ text: 'part1' }, { cut: true }, { text: 'final' }] });
  const store = createMemoryStore();
  const orch = createOrchestrator({ llm, store });
  await orch.start('R', { workspacePath: w, text: 'x' });
  await waitFor(() => orch.status('R').status === 'done');
  assert.ok(orch.status('R').autoContinues >= 1 || orch.status('R').retries >= 1);
});
