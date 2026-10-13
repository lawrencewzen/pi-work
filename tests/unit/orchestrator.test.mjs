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

test('stream cut is retried and run completes', async () => {
  const w = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'piw-o-')));
  const llm = createFauxLLM({ turns: [{ text: 'part1' }, { cut: true }, { text: 'final' }] });
  const store = createMemoryStore();
  const orch = createOrchestrator({ llm, store });
  await orch.start('R', { workspacePath: w, text: 'x' });
  await waitFor(() => orch.status('R').status === 'done');
  assert.ok(orch.status('R').autoContinues >= 1 || orch.status('R').retries >= 1);
});
