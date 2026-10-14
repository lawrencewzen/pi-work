import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { load } from './_root.mjs';
const { createOrchestrator, exploreTarget } = await load('src/core/orchestrator.mjs');
const { createFauxLLM } = await load('src/llm/faux.mjs');
const { createMemoryStore } = await load('src/store/memory.mjs');
const { createRetryPolicy } = await load('src/core/retry.mjs');

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

test('a later run can clear a conversation role', async () => {
  const w = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'piw-o-')));
  const store = createMemoryStore();
  await store.createRole({ id: 'coder', name: 'Coder', systemPrompt: 'code', tools: ['read'] });
  const llm = { async next() { return { type: 'end' }; } };
  const orch = createOrchestrator({ llm, store });
  await orch.start('C', { workspacePath: w, text: 'a', roleId: 'coder', pipelineId: null });
  await waitFor(() => orch.status('C').status === 'done');
  assert.equal((await store.getConversation('C')).roleId, 'coder');
  await orch.start('C', { workspacePath: w, text: 'b', roleId: null, pipelineId: null });
  await waitFor(() => orch.status('C').status === 'done');
  const conv = await store.getConversation('C');
  assert.equal(conv.roleId, null);
  assert.equal(conv.pipelineId ?? null, null);
});

test('tool results are sent back and an identical run is stopped', async () => {
  const w = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'piw-o-')));
  await fs.writeFile(path.join(w, 'keep.txt'), 'here\n');
  const seen = [];
  let answered = false;
  const llm = {
    async next({ messages }) {
      seen.push(messages);
      const corrected = messages.some((m) => String(m.text || m.content || '').includes('停止调用工具'));
      if (corrected) {
        if (answered) return { type: 'end' };
        answered = true;
        return { type: 'text', text: '目录已经看过。' };
      }
      return { type: 'tool', name: 'ls', args: { path: '.' } };
    },
  };
  const store = createMemoryStore();
  const orch = createOrchestrator({
    llm,
    store,
    toolLoopLimit: 3,
    maxToolCalls: 25,
    exploreRepeatLimit: 20,
    toolNudgeAfter: 100,
  });
  await orch.start('L', { workspacePath: w, text: 'list it' });
  await waitFor(() => orch.status('L').status === 'done');
  const msgs = await store.getMessages('L');
  const ls = msgs.filter((m) => m.role === 'tool' && m.tool?.name === 'ls');
  assert.equal(ls.length, 3);
  assert.ok(msgs.some((m) => m.kind === 'correction' && String(m.text).includes('停止调用工具')));
  assert.ok(msgs.some((m) => m.text === '目录已经看过。'));
  const fed = seen[1].find((m) => m.role === 'tool');
  assert.ok(fed);
  assert.match(String(fed.content), /keep\.txt/);
  assert.equal(String(fed.content).trim().length > 0, true);
});

test('explore targets ignore extra args and path spelling', () => {
  assert.equal(
    exploreTarget('grep', { pattern: '口令', path: './src/', glob: '*.mjs' }),
    exploreTarget('grep', { pattern: 'password', path: 'src' }),
  );
  assert.equal(
    exploreTarget('read', { path: '.\\src\\app.js', offset: 1 }),
    exploreTarget('read', { path: 'src/app.js', limit: 40 }),
  );
  assert.equal(exploreTarget('ls', {}), exploreTarget('ls', { path: './' }));
  assert.equal(
    exploreTarget('bash', { command: 'ls -la .' }),
    exploreTarget('bash', { command: 'grep -n 口令 ./' }),
  );
  assert.equal(exploreTarget('bash', { command: 'cat "src/app.js"' }), 'bash\u0000src/app.js');
  assert.equal(exploreTarget('bash', { command: 'git status' }), null);
  assert.equal(exploreTarget('write', { path: 'a.txt', content: 'x' }), null);
});

test('the same path is not explored more than twice with different args', async () => {
  const w = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'piw-o-')));
  await fs.mkdir(path.join(w, 'src'));
  const patterns = ['口令', 'password', 'token'];
  let i = 0;
  let answered = false;
  const llm = {
    async next({ messages }) {
      const stopped = messages.some((m) => String(m.text || m.content || '').includes('不要再重复查看'));
      if (stopped) {
        if (answered) return { type: 'end' };
        answered = true;
        return { type: 'text', text: '这个目录已经看过。' };
      }
      const pattern = patterns[i] || 'more';
      i += 1;
      return { type: 'tool', name: 'grep', args: { pattern, path: i % 2 ? './src/' : 'src', glob: '*.mjs' } };
    },
  };
  const store = createMemoryStore();
  const orch = createOrchestrator({ llm, store, toolNudgeAfter: 100, maxToolCalls: 15 });
  await orch.start('E', { workspacePath: w, text: '口令检查' });
  await waitFor(() => orch.status('E').status === 'done');
  const msgs = await store.getMessages('E');
  assert.equal(msgs.filter((m) => m.role === 'tool' && m.tool?.name === 'grep').length, 2);
  assert.ok(msgs.some((m) => m.kind === 'correction' && String(m.text).includes('不要再重复查看')));
  assert.ok(msgs.some((m) => m.text === '这个目录已经看过。'));
  assert.equal(orch.status('E').status, 'done');
});

test('repeating a path after the reminder ends the step and the pipeline still finishes', async () => {
  const w = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'piw-o-')));
  const store = createMemoryStore();
  await store.createRole({ id: 'coder', name: 'Coder', systemPrompt: 'code', tools: ['ls', 'bash', 'read'] });
  await store.createRole({ id: 'tester', name: 'Tester', systemPrompt: 'test', tools: ['ls', 'bash', 'read'] });
  await store.createPipeline({
    id: 'demo',
    name: 'Demo',
    steps: [{ role: 'coder', input: 'user' }, { role: 'tester', input: 'previous' }],
  });
  let n = 0;
  const llm = {
    async next() {
      n += 1;
      const cmds = ['ls -la .', 'ls -a ./', 'grep -n 口令 .', 'find . -name "*.md"'];
      return { type: 'tool', name: 'bash', args: { command: cmds[n % cmds.length] } };
    },
  };
  const orch = createOrchestrator({
    llm,
    store,
    toolLoopLimit: 20,
    maxToolCalls: 20,
    toolNudgeAfter: 100,
  });
  await orch.start('B', { workspacePath: w, text: 'go', roleId: 'coder', pipelineId: 'demo' });
  await waitFor(() => orch.status('B').status === 'done');
  const msgs = await store.getMessages('B');
  assert.equal(msgs.filter((m) => m.role === 'tool' && m.tool?.name === 'bash').length, 4);
  assert.equal(msgs.filter((m) => m.kind === 'correction' && String(m.text).includes('不要再重复查看')).length, 2);
  assert.equal(msgs.filter((m) => m.role === 'assistant' && String(m.text || '').includes('仍在重复查看')).length, 2);
  assert.ok(msgs.some((m) => m.kind === 'handoff'));
  assert.equal(orch.status('B').status, 'done');
});

test('eight silent tool calls inject a nudge to answer', async () => {
  const w = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'piw-o-')));
  let n = 0;
  let answered = false;
  const llm = {
    async next({ messages }) {
      if (messages.some((m) => String(m.text || m.content || '').includes('请根据已有结果直接回答'))) {
        if (answered) return { type: 'end' };
        answered = true;
        return { type: 'text', text: '还没找到口令。' };
      }
      n += 1;
      return { type: 'tool', name: 'read', args: { path: `notes/f${n}.txt` } };
    },
  };
  const store = createMemoryStore();
  const orch = createOrchestrator({ llm, store });
  await orch.start('N8', { workspacePath: w, text: '口令检查' });
  await waitFor(() => orch.status('N8').status === 'done');
  const msgs = await store.getMessages('N8');
  assert.equal(msgs.filter((m) => m.role === 'tool' && m.tool?.name === 'read').length, 8);
  assert.ok(msgs.some((m) => m.kind === 'correction' && String(m.text).includes('请根据已有结果直接回答')));
  assert.ok(msgs.some((m) => m.text === '还没找到口令。'));
});

test('the default per-step cap is 15', async () => {
  const w = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'piw-o-')));
  let n = 0;
  const llm = {
    async next() {
      n += 1;
      return { type: 'tool', name: 'read', args: { path: `uniq/f${n}.txt` } };
    },
  };
  const store = createMemoryStore();
  const orch = createOrchestrator({ llm, store, toolNudgeAfter: 100, exploreRepeatLimit: 20 });
  await orch.start('CAP', { workspacePath: w, text: 'keep looking' });
  await waitFor(() => orch.status('CAP').status === 'done');
  const msgs = await store.getMessages('CAP');
  assert.equal(msgs.filter((m) => m.role === 'tool').length, 15);
  assert.ok(msgs.some((m) => m.role === 'assistant' && String(m.text || '').includes('工具调用已达上限（15）')));
  assert.equal(orch.status('CAP').status, 'done');
});

test('a tool-call cap ends each pipeline step and the run still finishes', async () => {
  const w = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'piw-o-')));
  const store = createMemoryStore();
  await store.createRole({ id: 'coder', name: 'Coder', systemPrompt: 'code', tools: ['ls', 'read'] });
  await store.createRole({ id: 'tester', name: 'Tester', systemPrompt: 'test', tools: ['ls', 'read'] });
  await store.createPipeline({
    id: 'demo',
    name: 'Demo',
    steps: [{ role: 'coder', input: 'user' }, { role: 'tester', input: 'previous' }],
  });
  const llm = { async next() { return { type: 'tool', name: 'ls', args: { path: '.' } }; } };
  const orch = createOrchestrator({ llm, store, maxToolCalls: 2, toolLoopLimit: 20 });
  await orch.start('P', { workspacePath: w, text: 'go', roleId: 'coder', pipelineId: 'demo' });
  await waitFor(() => orch.status('P').status === 'done');
  const msgs = await store.getMessages('P');
  assert.equal(msgs.filter((m) => m.role === 'tool' && m.tool?.name === 'ls').length, 4);
  assert.equal(msgs.filter((m) => m.role === 'assistant' && String(m.text || '').includes('工具调用已达上限')).length, 2);
  assert.ok(msgs.some((m) => m.kind === 'handoff'));
  assert.equal(orch.status('P').status, 'done');
});

test('a terminated stream after a successful write finishes the step', async () => {
  const w = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'piw-o-')));
  let n = 0;
  const llm = {
    async next() {
      n += 1;
      if (n === 1) {
        return { type: 'tool', name: 'write', args: { path: 'notes/today.md', content: '今日\nQA-FILE-1\n' } };
      }
      const err = new Error('terminated');
      err.code = 'E_LLM';
      throw err;
    },
  };
  const store = createMemoryStore();
  const orch = createOrchestrator({
    llm,
    store,
    retry: createRetryPolicy({ maxAttempts: 2, baseMs: 1, maxMs: 5 }),
  });
  await orch.start('F', { workspacePath: w, text: 'write the note' });
  await waitFor(() => orch.status('F').status === 'done' || orch.status('F').status === 'failed');
  assert.equal(orch.status('F').status, 'done');
  assert.equal(await fs.readFile(path.join(w, 'notes/today.md'), 'utf8'), '今日\nQA-FILE-1\n');
  const msgs = await store.getMessages('F');
  assert.ok(msgs.some((m) => String(m.text || '').includes('已按完成的工具结果结束本步')));
  assert.equal(msgs.some((m) => String(m.text || '').includes('E_LLM')), false);
});

test('a missing model still fails after a tool instead of being marked done', async () => {
  const w = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'piw-o-')));
  let n = 0;
  const llm = {
    async next() {
      n += 1;
      if (n === 1) return { type: 'tool', name: 'ls', args: { path: '.' } };
      const err = new Error('err_no_model');
      err.code = 'E_NO_MODEL';
      throw err;
    },
  };
  const store = createMemoryStore();
  const orch = createOrchestrator({ llm, store, retry: createRetryPolicy({ maxAttempts: 2, baseMs: 1, maxMs: 5 }) });
  await orch.start('M', { workspacePath: w, text: 'list' });
  await waitFor(() => orch.status('M').status === 'failed' || orch.status('M').status === 'done');
  assert.equal(orch.status('M').status, 'failed');
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
