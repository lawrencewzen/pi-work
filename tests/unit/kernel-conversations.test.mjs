import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_RETRY_POLICY } from '@earendil-works/pi-durable';
import { parseSSE } from '../../src/core/sse.mjs';
import {
  createMapContext,
  mapHarnessBatch,
  snapshotGap,
} from '../../src/kernel/events.mjs';
import { ROOT } from './_root.mjs';

const TOKEN = 'unit-kernel-conv-token';
const STRIP = [
  'PI_WORK_LLM',
  'PI_WORK_FAUX_SCRIPT',
  'PI_WORK_FAUX_TEXT',
  'PI_WORK_FAUX_HOLD',
  'PI_WORK_FAUX_HOLD_READY',
  'PI_WORK_KERNEL',
  'LLM_API',
  'LLM_API_KEY',
  'LLM_BASE_URL',
  'LLM_MODEL',
  'PI_WORK_GROK_AUTH',
  'GROK_HOME',
];

function childEnv(dataDir, extra = {}) {
  const env = { ...process.env };
  for (const key of STRIP) delete env[key];
  return {
    ...env,
    PORT: '0',
    PI_WORK_DATA_DIR: dataDir,
    PI_WORK_TOKEN: TOKEN,
    PI_WORK_GROK_AUTH: path.join(dataDir, 'auth.json'),
    PI_WORK_RETRY_BASE_MS: '20',
    PI_WORK_RETRY_MAX: '5',
    PI_WORK_STALL_MS: '5000',
    ...extra,
  };
}

function killChild(child) {
  if (child.exitCode != null || child.signalCode != null) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  child.kill('SIGKILL');
}

function stopProcess(proc) {
  return new Promise((resolve) => {
    if (proc.exitCode != null) return resolve();
    const timer = setTimeout(() => killChild(proc), 2000);
    proc.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    proc.kill('SIGTERM');
  });
}

async function startServer(extra = {}, { dataDir, expectReady = true } = {}) {
  dataDir ??= await mkdtemp(path.join(tmpdir(), 'piw-kconv-'));
  await writeFile(path.join(dataDir, 'auth.json'), '{}\n');
  const proc = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    env: childEnv(dataDir, extra),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      killChild(proc);
      reject(new Error(`server not ready:\n${log}`));
    }, 20000);
    const onData = (buf) => {
      log += buf;
      const match = log.match(/PI_WORK_READY (http:\/\/\S+)/);
      if (match && expectReady) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.once('exit', (code) => {
      clearTimeout(timer);
      if (expectReady) reject(new Error(`server exited ${code}:\n${log}`));
      else resolve(null);
    });
  });
  if (expectReady) proc.removeAllListeners('exit');
  return { proc, base, dataDir, logs: () => log };
}

async function request(base, method, apiPath, body) {
  const res = await fetch(base + apiPath, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

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
  ctx.toolDiffs.set('call-1', { added: 2, removed: 1 });
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
        model: [{ role: 'toolResult', toolCallId: 'call-1', toolName: 'read', content: [{ type: 'text', text: 'file' }], isError: false }],
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
    'checkpoint',
    'retry',
    'error',
    'status',
    'error',
    'status',
  ]);
  assert.equal(events[0].data.status, 'running');
  assert.deepEqual(events[1].data, { messageId: 'live-1', text: 'he' });
  assert.equal(events[2].data.messageId, '11');
  assert.equal(events[2].data.liveId, 'live-1');
  assert.equal(events[2].data.text, 'hello');
  assert.equal(events[3].data.usage.total, 5);
  assert.equal(events[3].data.contextLabel.includes('/'), true);
  assert.equal(events[4].data.tool.path, 'a.txt');
  assert.equal(events[4].data.tool.status, 'running');
  assert.equal(events[5].data.tool.output, 'file');
  assert.equal(events[5].data.tool.added, 2);
  assert.equal(events[5].data.tool.removed, 1);
  assert.equal(typeof events[6].data.at, 'number');
  assert.equal(events[6].data.step, 1);
  assert.equal(events[7].data.attempt, 1);
  assert.equal(events[7].data.reason, '429');
  assert.equal(events[7].data.delayMs, DEFAULT_RETRY_POLICY.baseDelayMs);
  assert.deepEqual(events[8].data, { code: 'E_LLM', message: 'boom' });
  assert.equal(events[9].data.status, 'failed');
  assert.deepEqual(events[10].data, { code: 'E_NO_MODEL', message: 'err_no_model' });
  assert.equal(events[11].data.status, 'done');
  assert.equal(names.includes('usage_changed'), false);
});

test('a late snapshot fills only transcript rows the event log does not already have', () => {
  const existing = [
    { id: 1, event: 'message.done', data: { messageId: '8', text: 'ping' } },
    { id: 2, event: 'message.delta', data: { messageId: 'live', text: 'hel' } },
  ];
  const gap = snapshotGap({
    entries: [
      { id: 8, kind: 'pi.user', model: [{ role: 'user', content: 'ping' }] },
      { id: 11, kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text: 'hello' }], usage: { input: 1, output: 1, totalTokens: 2 } }] },
    ],
    generation: { message: { content: [{ type: 'text', text: 'hello' }] } },
  }, existing, createMapContext());
  assert.deepEqual(gap.map((ev) => ev.event), ['message.done', 'usage']);
  assert.equal(gap[0].data.messageId, '11');
  assert.equal(gap[0].data.text, 'hello');
  const again = snapshotGap({
    entries: [
      { id: 8, kind: 'pi.user', model: [{ role: 'user', content: 'ping' }] },
      { id: 11, kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text: 'hello' }] }] },
    ],
  }, existing.concat(gap.map((ev, i) => ({ id: 3 + i, ...ev }))), createMapContext());
  assert.deepEqual(again, []);
});

test('a snapshot partial replaces the open live bubble instead of appending', () => {
  const ctx = createMapContext();
  const gap = snapshotGap({
    entries: [],
    generation: { message: { content: [{ type: 'text', text: '甲、乙、丙' }] } },
  }, [
    { id: 1, event: 'message.delta', data: { messageId: 'live-1', text: '甲、乙' } },
  ], ctx);
  assert.equal(gap.length, 1);
  assert.equal(gap[0].event, 'message.delta');
  assert.equal(gap[0].data.replace, true);
  assert.equal(gap[0].data.text, '甲、乙、丙');
  assert.equal(gap[0].data.messageId, 'live-1');
  assert.equal(ctx.liveId, 'live-1');
  const { events } = mapHarnessBatch([
    { type: 'message_update', changes: [{ type: 'text_delta', contentIndex: 0, delta: '。' }] },
  ], ctx);
  assert.deepEqual(events[0].data, { messageId: 'live-1', text: '。' });
});

test('a finished generation does not reopen a live bubble from the snapshot', () => {
  const ctx = createMapContext();
  const gap = snapshotGap({
    entries: [
      { id: 4, kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text: '甲、乙、丙' }] }] },
    ],
    generation: { message: { content: [{ type: 'text', text: '甲、乙、丙' }] } },
  }, [
    { id: 1, event: 'message.delta', data: { messageId: 'live', text: '甲、乙' } },
    { id: 2, event: 'message.delta', data: { messageId: 'live', text: '、丙' } },
    { id: 3, event: 'message.done', data: { messageId: '4', text: '甲、乙、丙' } },
  ], ctx);
  assert.deepEqual(gap, []);
  assert.equal(ctx.liveId, null);
});

test('kernel path: faux turn, then Last-Event-ID resumes without gaps or repeats', { timeout: 30000 }, async () => {
  const srv = await startServer({ PI_WORK_KERNEL: 'durable', PI_WORK_LLM: 'faux', PI_WORK_FAUX_TEXT: 'kernel-ok' });
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
    const ids = events.map((ev) => ev.id);
    assert.equal(ids[0], 1);
    for (let i = 1; i < ids.length; i += 1) assert.equal(ids[i], ids[i - 1] + 1);

    const cursor = ids[Math.floor(ids.length / 2)];
    const expected = events.filter((ev) => ev.id > cursor);
    const tail = await collectSse(srv.base, conv.id, {
      lastEventId: cursor,
      ready: (list) => list.length >= expected.length,
    });
    assert.deepEqual(tail.map((ev) => ev.id), expected.map((ev) => ev.id));
    assert.deepEqual(tail.map((ev) => ev.event), expected.map((ev) => ev.event));
    assert.deepEqual(tail.map((ev) => ev.data), expected.map((ev) => ev.data));

    const got = await request(srv.base, 'GET', `/api/conversations/${conv.id}`);
    assert.equal(got.status, 200);
    assert.equal(got.body.status, 'done');
    assert.equal(got.body.messages.some((m) => m.role === 'user' && m.text === 'ping'), true);
    assert.equal(got.body.messages.some((m) => m.role === 'assistant' && m.text === 'kernel-ok'), true);
    assert.equal(got.body.contextLabel.includes('/'), true);
  } finally {
    await stopProcess(srv.proc);
    await rm(srv.dataDir, { recursive: true, force: true });
  }
});

test('kernel path: a busy conversation is 409, and a killed run resumes to done', { timeout: 60000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-khold-'));
  const ready = path.join(dataDir, 'hold-ready');
  const first = await startServer({
    PI_WORK_KERNEL: 'durable',
    PI_WORK_LLM: 'faux',
    PI_WORK_FAUX_HOLD: '1',
    PI_WORK_FAUX_HOLD_READY: ready,
  }, { dataDir });
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
    const blocked = await request(first.base, 'POST', `/api/conversations/${convId}/messages`, { text: 'again' });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error, 'err_send_blocked');
  } finally {
    killChild(first.proc);
    await new Promise((resolve) => first.proc.once('exit', resolve));
  }

  const second = await startServer({
    PI_WORK_KERNEL: 'durable',
    PI_WORK_LLM: 'faux',
    PI_WORK_FAUX_TEXT: 'resumed-ok',
  }, { dataDir });
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
    assert.equal(statuses.includes('recovering'), true);
    assert.equal(statuses.indexOf('recovering') < statuses.indexOf('done'), true);
  } finally {
    await stopProcess(second.proc);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('kernel path without a demo model fails the turn as E_NO_MODEL', { timeout: 20000 }, async () => {
  const srv = await startServer({ PI_WORK_KERNEL: 'durable' });
  try {
    const { conv } = await openConversation(srv.base, 'New conversation');
    const sent = await request(srv.base, 'POST', `/api/conversations/${conv.id}/messages`, { text: '你好' });
    assert.equal(sent.status, 202);
    let body;
    for (let i = 0; i < 40; i += 1) {
      const got = await request(srv.base, 'GET', `/api/conversations/${conv.id}`);
      body = got.body;
      if (body.status === 'failed' || body.status === 'done') break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(body.status, 'failed');
    assert.equal(body.llmError?.code, 'E_NO_MODEL');
    assert.equal(body.messages.some((m) => m.role === 'user' && m.text === '你好'), true);
    assert.equal(body.title, '你好');
  } finally {
    await stopProcess(srv.proc);
    await rm(srv.dataDir, { recursive: true, force: true });
  }
});

test('a harness that cannot open does not print PI_WORK_READY', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-kfail-'));
  await writeFile(path.join(dataDir, 'harness'), 'not-a-directory\n');
  const srv = await startServer({ PI_WORK_KERNEL: 'durable', PI_WORK_LLM: 'faux' }, { dataDir, expectReady: false });
  try {
    assert.equal(srv.base, null);
    assert.equal(srv.logs().includes('PI_WORK_READY'), false);
    assert.match(srv.logs(), /PI_WORK_KERNEL_OPEN_FAILED/);
  } finally {
    await stopProcess(srv.proc);
    await rm(dataDir, { recursive: true, force: true });
  }
});
