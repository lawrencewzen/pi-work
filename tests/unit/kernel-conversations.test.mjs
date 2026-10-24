import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_RETRY_POLICY } from '@earendil-works/pi-durable';
import { parseSSE } from '../../src/core/sse.mjs';
import {
  baselinesFromEntries,
  createMapContext,
  mapHarnessBatch,
  messagesFromEntries,
  statusFromSubmission,
} from '../../src/kernel/events.mjs';
import { killChild, request as serverRequest, startServer, stopServer } from './_server.mjs';

const TOKEN = 'unit-kernel-conv-token';
const request = (base, method, apiPath, body) => serverRequest(base, method, apiPath, body, TOKEN);

function parseChunk(part) {
  return parseSSE(`${part}\n\n`).filter((ev) => ev.event);
}

async function collectSse(base, cid, { lastEventId, ready, quietMs = 500, timeout = 12000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  const headers = { authorization: `Bearer ${TOKEN}`, accept: 'text/event-stream' };
  if (lastEventId != null) headers['last-event-id'] = String(lastEventId);
  const res = await fetch(`${base}/api/conversations/${cid}/events`, { headers, signal: ctrl.signal });
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const events = [];
  let quiet = null;
  const arm = () => {
    if (!ready?.(events)) return;
    if (quiet) clearTimeout(quiet);
    quiet = setTimeout(() => ctrl.abort(), quietMs);
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop() || '';
      for (const part of parts) {
        if (!part.trim() || part.trim() === ':') continue;
        events.push(...parseChunk(part));
      }
      arm();
    }
  } catch (err) {
    if (err?.name !== 'AbortError') throw err;
  } finally {
    clearTimeout(timer);
    if (quiet) clearTimeout(quiet);
    ctrl.abort();
    try { await reader.cancel(); } catch { /* already closed */ }
  }
  return events;
}

async function openConversation(base, title = 'kernel') {
  const ws = await request(base, 'POST', '/api/workspaces', { name: 'kernel-ws' });
  assert.equal(ws.status, 201);
  const conv = await request(base, 'POST', `/api/workspaces/${ws.body.id}/conversations`, { title });
  assert.equal(conv.status, 201);
  assert.equal(conv.body.status, 'idle');
  assert.equal(conv.body.workspaceId, ws.body.id);
  assert.equal(conv.body.title, title);
  assert.equal(typeof conv.body.id, 'string');
  assert.equal(Object.hasOwn(conv.body, 'harnessId'), false);
  return { ws: ws.body, conv: conv.body };
}

test('harness batches map onto the contract events', () => {
  const ctx = createMapContext();
  const { events } = mapHarnessBatch([
    { type: 'run_start', inputs: [9] },
    { type: 'message_update', changes: [{ type: 'text_delta', contentIndex: 0, delta: 'he' }] },
    {
      type: 'message_end',
      entry: {
        id: 11,
        kind: 'pi.assistant',
        model: [{
          role: 'assistant',
          content: [{ type: 'text', text: 'hello' }],
          model: 'deepseek-flash',
          provider: 'src-abc',
          usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        }],
      },
    },
    { type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'read', args: { path: 'a.txt' } },
    {
      type: 'tool_execution_end',
      toolCallId: 'call-1',
      toolName: 'read',
      entry: {
        kind: 'pi.tool-result',
        model: [{
          role: 'toolResult',
          toolCallId: 'call-1',
          toolName: 'read',
          content: [{ type: 'text', text: 'file' }],
          isError: false,
          details: { path: 'a.txt', added: 2, removed: 1 },
        }],
      },
    },
    { type: 'auto_retry_start', attempt: 1, at: 10, errorMessage: '429' },
    { type: 'task_failed', taskId: 4, kind: 'pi.generation', message: 'boom' },
    { type: 'submission', record: { type: 'input', status: 'unanswered', reason: 'no_model', id: 9 } },
    { type: 'submission', record: { type: 'input', status: 'done', id: 3 } },
    { type: 'usage_changed', usage: { models: {}, tools: {} } },
  ], ctx);
  const names = events.map((ev) => ev.event);
  assert.deepEqual(names, [
    'status',
    'message.delta',
    'message.done',
    'usage',
    'tool.start',
    'tool.end',
    'retry',
    'error',
    'status',
    'error',
    'status',
    'status',
  ]);
  assert.equal(events[0].data.status, 'running');
  assert.deepEqual(events[1].data, { messageId: 'live-1', text: 'he' });
  assert.equal(events[2].data.messageId, '11');
  assert.equal(events[2].data.liveId, 'live-1');
  assert.equal(events[2].data.text, 'hello');
  assert.equal(events[2].data.model, 'deepseek-flash');
  assert.equal(events[3].data.usage.total, 5);
  assert.equal(events[3].data.contextLabel.includes('/'), true);
  assert.equal(events[4].data.tool.path, 'a.txt');
  assert.equal(events[4].data.tool.status, 'running');
  assert.equal(events[5].data.tool.output, 'file');
  assert.equal(events[5].data.tool.added, 2);
  assert.equal(events[5].data.tool.removed, 1);
  assert.equal(events[6].data.attempt, 1);
  assert.equal(events[6].data.reason, '429');
  assert.equal(events[6].data.delayMs, DEFAULT_RETRY_POLICY.baseDelayMs);
  assert.deepEqual(events[7].data, { code: 'E_LLM', message: 'boom' });
  assert.equal(events[8].data.status, 'failed');
  assert.deepEqual(events[9].data, { code: 'E_NO_MODEL', message: 'err_no_model' });
  assert.equal(events[10].data.status, 'failed');
  assert.equal(events[11].data.status, 'done');
  assert.equal(names.includes('usage_changed'), false);
});

test('status is the last submission record', () => {
  assert.deepEqual(statusFromSubmission({ status: 'queued' }), { status: 'running' });
  assert.deepEqual(statusFromSubmission({ status: 'placed' }), { status: 'running' });
  assert.deepEqual(statusFromSubmission({ status: 'done' }), { status: 'done' });
  assert.deepEqual(statusFromSubmission({ status: 'unanswered', reason: 'aborted' }), { status: 'stopped' });
  const failed = statusFromSubmission({ status: 'unanswered', reason: 'model_error', detail: 'provider exploded' });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.llmError.code, 'E_LLM');
  assert.equal(failed.llmError.message, 'provider exploded');
  assert.equal(statusFromSubmission({ status: 'unanswered', reason: 'no_model' }).llmError.code, 'E_NO_MODEL');
  assert.throws(() => statusFromSubmission(undefined), /Unexpected submission status/);
});

test('a snapshot asks the client to refetch instead of replaying rows', () => {
  const ctx = createMapContext();
  const mapped = mapHarnessBatch([{ type: 'snapshot' }], ctx);
  assert.equal(mapped.refresh, true);
  assert.deepEqual(mapped.events, []);
  assert.equal(ctx.liveId, null);
});

test('assistant messages carry the stored model name', () => {
  const { messages } = messagesFromEntries([
    {
      id: 1,
      kind: 'pi.user',
      model: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    },
    {
      id: 2,
      kind: 'pi.assistant',
      model: [{
        role: 'assistant',
        content: [{ type: 'text', text: 'first' }],
        model: 'deepseek-flash',
        provider: 'src-abc',
      }],
    },
    {
      id: 3,
      kind: 'pi.assistant',
      model: [{
        role: 'assistant',
        content: [{ type: 'text', text: 'second' }],
        model: 'grok-build',
      }],
    },
    {
      id: 4,
      kind: 'pi.assistant',
      model: [{
        role: 'assistant',
        content: [{ type: 'text', text: 'no model field' }],
      }],
    },
  ]);
  assert.equal(messages.find((message) => message.id === '1').role, 'user');
  assert.equal(Object.hasOwn(messages.find((message) => message.id === '1'), 'model'), false);
  assert.equal(messages.find((message) => message.id === '2').model, 'deepseek-flash');
  assert.equal(messages.find((message) => message.id === '3').model, 'grok-build');
  assert.equal(Object.hasOwn(messages.find((message) => message.id === '4'), 'model'), false);
});

test('a tool call without a result is still a running tool message', () => {
  const { messages } = messagesFromEntries([
    {
      id: 2,
      kind: 'pi.assistant',
      model: [{
        role: 'assistant',
        content: [
          { type: 'text', text: '跑一下。' },
          { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'sleep 3' } },
        ],
      }],
    },
  ]);
  const tool = messages.find((message) => message.role === 'tool');
  assert.equal(tool.tool.id, 'call-1');
  assert.equal(tool.tool.name, 'bash');
  assert.equal(tool.tool.status, 'running');
  assert.equal(tool.tool.input.command, 'sleep 3');
});

test('the first write of a path is the diff baseline', () => {
  const rows = baselinesFromEntries([
    {
      kind: 'pi.tool-result',
      model: [{ toolCallId: 'a', details: { path: 'a.txt', before: '', after: 'one', added: 1, removed: 0 } }],
    },
    {
      kind: 'pi.tool-result',
      model: [{ toolCallId: 'b', details: { path: 'a.txt', before: 'one', after: 'two', added: 1, removed: 1 } }],
    },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].before, '');
  assert.equal(rows[0].toolCallId, 'a');
});

test('kernel path: faux turn pushes live events, and a new connection starts at the current status', { timeout: 30000 }, async () => {
  const srv = await startServer({ token: TOKEN, env: { WEFT_LLM: 'faux', WEFT_FAUX_TEXT: 'kernel-ok' } });
  try {
    const { ws, conv } = await openConversation(srv.base);
    const listed = await request(srv.base, 'GET', `/api/workspaces/${ws.id}/conversations`);
    assert.equal(listed.status, 200);
    assert.equal(listed.body[0].id, conv.id);
    assert.equal(listed.body[0].status, 'idle');
    assert.equal(Object.hasOwn(listed.body[0], 'harnessId'), false);
    assert.equal(Object.hasOwn(listed.body[0], 'messages'), false);

    const sent = await request(srv.base, 'POST', `/api/conversations/${conv.id}/messages`, { text: 'ping' });
    assert.equal(sent.status, 202);
    assert.match(sent.body.runId, /^\d+$/);
    assert.equal(sent.body.status, 'running');

    const events = await collectSse(srv.base, conv.id, {
      ready: (list) => list.some((ev) => ev.event === 'status' && ev.data?.status === 'done'),
    });
    const statuses = events.filter((ev) => ev.event === 'status').map((ev) => ev.data.status);
    assert.equal(statuses.includes('running'), true);
    assert.equal(statuses.includes('done'), true);
    assert.equal(events.some((ev) => ev.event === 'message.done'), true);
    assert.equal(statuses.indexOf('running') < statuses.indexOf('done'), true);
    assert.equal(events.every((ev) => ev.id == null), true);

    const again = await collectSse(srv.base, conv.id, {
      ready: (list) => list.some((ev) => ev.event === 'status'),
      quietMs: 200,
    });
    assert.equal(again[0].event, 'status');
    assert.equal(again[0].data.status, 'done');
    assert.equal(again.some((ev) => ev.event === 'message.delta'), false);

    const got = await request(srv.base, 'GET', `/api/conversations/${conv.id}`);
    assert.equal(got.status, 200);
    assert.equal(got.body.status, 'done');
    assert.equal(got.body.messages.some((m) => m.role === 'user' && m.text === 'ping'), true);
    const assistant = got.body.messages.find((m) => m.role === 'assistant' && m.text === 'kernel-ok');
    assert.equal(assistant?.text, 'kernel-ok');
    assert.equal(assistant?.model, 'faux-1');
    assert.equal(got.body.contextLabel.includes('/'), true);
  } finally {
    await stopServer(srv);
    await rm(srv.dataDir, { recursive: true, force: true });
  }
});

test('kernel path: a killed run resumes to done', { timeout: 60000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-khold-'));
  const ready = path.join(dataDir, 'hold-ready');
  const first = await startServer({
    token: TOKEN,
    dataDir,
    env: {
      WEFT_LLM: 'faux',
      WEFT_FAUX_HOLD: '1',
      WEFT_FAUX_HOLD_READY: ready,
    },
  });
  let convId;
  try {
    const opened = await openConversation(first.base, 'hold');
    convId = opened.conv.id;
    const sent = await request(first.base, 'POST', `/api/conversations/${convId}/messages`, { text: 'please-resume' });
    assert.equal(sent.status, 202);
    const started = Date.now();
    while (Date.now() - started < 15000) {
      try {
        await readFile(ready, 'utf8');
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
    }
    await readFile(ready, 'utf8');
    const live = await request(first.base, 'GET', `/api/conversations/${convId}`);
    assert.equal(live.body.status, 'running');
  } finally {
    killChild(first.proc);
    await new Promise((resolve) => first.proc.once('exit', resolve));
  }

  const second = await startServer({
    token: TOKEN,
    dataDir,
    env: {
      WEFT_LLM: 'faux',
      WEFT_FAUX_TEXT: 'resumed-ok',
    },
  });
  try {
    let body;
    for (let i = 0; i < 40; i += 1) {
      const got = await request(second.base, 'GET', `/api/conversations/${convId}`);
      body = got.body;
      const assistant = body.messages?.find((m) => m.role === 'assistant');
      if (body.status === 'done' && assistant?.text === 'resumed-ok') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(body.messages.filter((m) => m.role === 'user' && m.text === 'please-resume').length, 1);
    assert.equal(body.messages.some((m) => m.role === 'assistant' && m.text === 'resumed-ok'), true);
    assert.equal(body.status, 'done');
    const events = await collectSse(second.base, convId, {
      ready: (list) => list.some((ev) => ev.event === 'status' && ev.data?.status === 'done'),
    });
    const statuses = events.filter((ev) => ev.event === 'status').map((ev) => ev.data.status);
    assert.equal(statuses.includes('recovering'), false);
    assert.equal(statuses.includes('done'), true);
  } finally {
    await stopServer(second);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('a harness that cannot open does not print WEFT_READY', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-kfail-'));
  await writeFile(path.join(dataDir, 'harness'), 'not-a-directory\n');
  const srv = await startServer({ token: TOKEN, env: { WEFT_LLM: 'faux' }, dataDir, expectReady: false });
  try {
    assert.equal(srv.base, null);
    assert.equal(srv.logs().includes('WEFT_READY'), false);
    assert.match(srv.logs(), /WEFT_KERNEL_OPEN_FAILED/);
  } finally {
    await stopServer(srv);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('kernel path: a message sent while busy is steered into the run', { timeout: 30000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-ksteer-'));
  const script = path.join(dataDir, 'steer.json');
  const record = path.join(dataDir, 'record.jsonl');
  await writeFile(script, JSON.stringify({
    turns: [
      { text: 'working', delayMs: 400, tool: 'write', args: { path: 'note.txt', content: 'n\n' } },
      { text: 'saw-steer' },
    ],
  }));
  const srv = await startServer({
    token: TOKEN,
    dataDir,
    env: {
      WEFT_LLM: 'faux',
      WEFT_FAUX_SCRIPT: script,
      WEFT_FAUX_RECORD: record,
    },
  });
  try {
    const { conv } = await openConversation(srv.base, 'steer');
    const events = collectSse(srv.base, conv.id, {
      ready: (list) => list.some((ev) => ev.event === 'status' && ev.data?.status === 'done'),
      timeout: 20000,
    });
    const sent = await request(srv.base, 'POST', `/api/conversations/${conv.id}/messages`, { text: 'first' });
    assert.equal(sent.status, 202);
    const started = Date.now();
    let running = null;
    while (Date.now() - started < 8000) {
      running = await request(srv.base, 'GET', `/api/conversations/${conv.id}`);
      if (running.body.status === 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.equal(running.body.status, 'running');
    const steered = await request(srv.base, 'POST', `/api/conversations/${conv.id}/messages`, { text: 'please-steer' });
    assert.equal(steered.status, 202);
    assert.notEqual(steered.body.error, 'err_send_blocked');
    await events;
    const got = await request(srv.base, 'GET', `/api/conversations/${conv.id}`);
    assert.equal(got.body.status, 'done', srv.logs());
    assert.equal(got.body.messages.some((message) => message.role === 'user' && message.text === 'please-steer'), true);
    assert.equal(got.body.messages.some((message) => message.text === 'saw-steer'), true);
    const lines = (await readFile(record, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(lines.some((row) => (row.users || []).includes('please-steer')), true, JSON.stringify(lines));
  } finally {
    await stopServer(srv);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('kernel path: stream timeout retries a held faux call', { timeout: 20000 }, async () => {
  const srv = await startServer({
    token: TOKEN,
    env: {
      WEFT_LLM: 'faux',
      WEFT_FAUX_HOLD: '1',
      WEFT_STREAM_TIMEOUT_MS: '150',
      WEFT_RETRY_BASE_MS: '20',
      WEFT_RETRY_MAX: '3',
    },
  });
  try {
    const { conv } = await openConversation(srv.base, 'timeout');
    const pending = collectSse(srv.base, conv.id, {
      ready: (list) => list.some((ev) => ev.event === 'status' && ev.data?.status === 'failed')
        && list.some((ev) => ev.event === 'retry'),
      timeout: 15000,
    });
    const sent = await request(srv.base, 'POST', `/api/conversations/${conv.id}/messages`, { text: 'hold' });
    assert.equal(sent.status, 202);
    const events = await pending;
    const retry = events.find((ev) => ev.event === 'retry');
    assert.equal(retry.data.attempt >= 1, true);
    assert.match(retry.data.reason, /timed out/i);
    const got = await request(srv.base, 'GET', `/api/conversations/${conv.id}`);
    assert.equal(got.body.status, 'failed', srv.logs());
  } finally {
    await stopServer(srv);
    await rm(srv.dataDir, { recursive: true, force: true });
  }
});

function appPointer(dataDir, convId) {
  const db = new DatabaseSync(path.join(dataDir, 'weft.sqlite'), { readOnly: true });
  try {
    const row = db.prepare('SELECT last_submission_id FROM conversations WHERE id = ?').get(convId);
    return row?.last_submission_id == null ? null : Number(row.last_submission_id);
  } finally {
    db.close();
  }
}

async function waitForStatus(base, id, accept) {
  let body = null;
  for (let i = 0; i < 50; i += 1) {
    const got = await request(base, 'GET', `/api/conversations/${id}`);
    body = got.body;
    if (accept(body)) return body;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return body;
}

test('last submission: done stays done after restart', { timeout: 40000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-kdone-'));
  const env = { WEFT_LLM: 'faux', WEFT_FAUX_TEXT: 'done-ok' };
  const first = await startServer({ token: TOKEN, env, dataDir });
  let convId;
  let pointer;
  try {
    const opened = await openConversation(first.base, 'done');
    convId = opened.conv.id;
    const idle = await request(first.base, 'GET', `/api/conversations/${convId}`);
    assert.equal(idle.body.status, 'idle');
    assert.equal(appPointer(dataDir, convId), null);
    const sent = await request(first.base, 'POST', `/api/conversations/${convId}/messages`, { text: 'ping' });
    assert.equal(sent.status, 202);
    const body = await waitForStatus(first.base, convId, (row) => row.status === 'done');
    assert.equal(body.status, 'done', first.logs());
    assert.equal(body.messages.some((message) => message.role === 'assistant' && message.text === 'done-ok'), true);
    pointer = appPointer(dataDir, convId);
    assert.equal(pointer, Number(sent.body.runId));
  } finally {
    killChild(first.proc);
    await new Promise((resolve) => first.proc.once('exit', resolve));
  }

  const second = await startServer({ token: TOKEN, env, dataDir });
  try {
    const got = await request(second.base, 'GET', `/api/conversations/${convId}`);
    assert.equal(got.body.status, 'done', second.logs());
    assert.equal(got.body.messages.some((message) => message.role === 'assistant' && message.text === 'done-ok'), true);
    assert.equal(appPointer(dataDir, convId), pointer);
  } finally {
    await stopServer(second);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('last submission: a faux error stays failed after restart', { timeout: 40000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-kfail-sub-'));
  const script = path.join(dataDir, 'fail.json');
  await writeFile(script, JSON.stringify({ turns: [{ error: 'provider exploded' }] }));
  const env = { WEFT_LLM: 'faux', WEFT_FAUX_SCRIPT: script };
  const first = await startServer({ token: TOKEN, env, dataDir });
  let convId;
  let pointer;
  try {
    const opened = await openConversation(first.base, 'fail');
    convId = opened.conv.id;
    const sent = await request(first.base, 'POST', `/api/conversations/${convId}/messages`, { text: 'break' });
    assert.equal(sent.status, 202);
    const body = await waitForStatus(first.base, convId, (row) => row.status === 'failed' || row.status === 'done');
    assert.equal(body.status, 'failed', first.logs());
    assert.equal(body.llmError?.code, 'E_LLM');
    assert.match(body.llmError?.message || '', /provider exploded/);
    pointer = appPointer(dataDir, convId);
    assert.equal(pointer, Number(sent.body.runId));
  } finally {
    killChild(first.proc);
    await new Promise((resolve) => first.proc.once('exit', resolve));
  }

  const second = await startServer({ token: TOKEN, env, dataDir });
  try {
    const got = await request(second.base, 'GET', `/api/conversations/${convId}`);
    assert.equal(got.body.status, 'failed', second.logs());
    assert.equal(got.body.llmError?.code, 'E_LLM');
    assert.match(got.body.llmError?.message || '', /provider exploded/);
    assert.equal(appPointer(dataDir, convId), pointer);
  } finally {
    await stopServer(second);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('last submission: stop stays stopped after restart', { timeout: 40000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-kstop-'));
  const ready = path.join(dataDir, 'hold-ready');
  const first = await startServer({
    token: TOKEN,
    dataDir,
    env: {
      WEFT_LLM: 'faux',
      WEFT_FAUX_HOLD: '1',
      WEFT_FAUX_HOLD_READY: ready,
    },
  });
  let convId;
  let pointer;
  try {
    const opened = await openConversation(first.base, 'stop');
    convId = opened.conv.id;
    const sent = await request(first.base, 'POST', `/api/conversations/${convId}/messages`, { text: 'hold-stop' });
    assert.equal(sent.status, 202);
    const started = Date.now();
    while (Date.now() - started < 15000) {
      try {
        await readFile(ready, 'utf8');
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
    }
    await readFile(ready, 'utf8');
    const live = await request(first.base, 'GET', `/api/conversations/${convId}`);
    assert.equal(live.body.status, 'running', first.logs());
    pointer = appPointer(dataDir, convId);
    assert.equal(pointer, Number(sent.body.runId));
    const stopped = await request(first.base, 'POST', `/api/conversations/${convId}/stop`);
    assert.equal(stopped.status, 200);
    const body = await waitForStatus(first.base, convId, (row) => row.status === 'stopped' || row.status === 'done');
    assert.equal(body.status, 'stopped', first.logs());
  } finally {
    killChild(first.proc);
    await new Promise((resolve) => first.proc.once('exit', resolve));
  }

  const second = await startServer({
    token: TOKEN,
    dataDir,
    env: {
      WEFT_LLM: 'faux',
      WEFT_FAUX_TEXT: 'should-not-resume',
    },
  });
  try {
    const got = await request(second.base, 'GET', `/api/conversations/${convId}`);
    assert.equal(got.body.status, 'stopped', second.logs());
    assert.equal(got.body.messages.some((message) => message.text === 'should-not-resume'), false);
    assert.equal(appPointer(dataDir, convId), pointer);
  } finally {
    await stopServer(second);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('a missing submission is failed, not 500', { timeout: 20000 }, async () => {
  const srv = await startServer({ token: TOKEN, env: { WEFT_LLM: 'faux', WEFT_FAUX_TEXT: 'ok' } });
  try {
    const { conv } = await openConversation(srv.base, 'missing');
    const db = new DatabaseSync(path.join(srv.dataDir, 'weft.sqlite'));
    db.prepare('UPDATE conversations SET last_submission_id = ? WHERE id = ?').run(999999, conv.id);
    db.close();
    const got = await request(srv.base, 'GET', `/api/conversations/${conv.id}`);
    assert.equal(got.status, 200, srv.logs());
    assert.equal(got.body.status, 'failed');
    assert.equal(got.body.llmError?.code, 'E_SUBMISSION_MISSING');
    assert.equal(got.body.llmError?.message, '找不到这次运行的记录');
    assert.match(srv.logs(), /WEFT_SUBMISSION_MISSING/);
    const events = await collectSse(srv.base, conv.id, {
      ready: (list) => list.some((ev) => ev.event === 'status'),
      quietMs: 200,
    });
    assert.equal(events[0].event, 'status');
    assert.equal(events[0].data.status, 'failed');
  } finally {
    await stopServer(srv);
    await rm(srv.dataDir, { recursive: true, force: true });
  }
});
