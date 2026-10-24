import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSSE } from '../../src/core/sse.mjs';
import {
  applyMessageDone,
  applyStreamDelta,
  dropStreamingResidues,
  mergeRefreshedMessages,
  statusKeepsStreaming,
} from '../../public/stream.js';
import { request as serverRequest, startServer, stopServer } from './_server.mjs';

test('a refresh keeps a local running tool the server has not stored yet', () => {
  const local = [
    { id: 'a1', role: 'assistant', text: '跑一下。' },
    { id: 'tool-call-1', role: 'tool', tool: { id: 'call-1', name: 'bash', status: 'running' } },
  ];
  const server = [{ id: 'a1', role: 'assistant', text: '跑一下。' }];
  const kept = mergeRefreshedMessages(local, server, { keepStreaming: true });
  assert.equal(kept.some((message) => message.tool?.id === 'call-1' && message.tool.status === 'running'), true);
  const settled = mergeRefreshedMessages(local, [
    ...server,
    { id: 't1', role: 'tool', tool: { id: 'call-1', name: 'bash', status: 'completed' } },
  ], { keepStreaming: true });
  assert.equal(settled.filter((message) => message.tool?.id === 'call-1').length, 1);
  assert.equal(settled.find((message) => message.tool?.id === 'call-1').tool.status, 'completed');
});

const TOKEN = 'unit-ghost-reply-token';
const TEXT_A = '这是一个 TypeScript/Node.js 项目，用于开发相关。';
const TEXT_B = '第二轮已经看完，结论里有顿号、和的字。';
const request = (base, method, apiPath, body) => serverRequest(base, method, apiPath, body, TOKEN);

function parseChunk(part) {
  return parseSSE(`${part}\n\n`).filter((ev) => ev.event);
}

async function collectSse(base, cid, { ready, quietMs = 400, timeout = 40000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  const res = await fetch(`${base}/api/conversations/${cid}/events`, {
    headers: { authorization: `Bearer ${TOKEN}`, accept: 'text/event-stream' },
    signal: ctrl.signal,
  });
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

async function openConversation(base) {
  const ws = await request(base, 'POST', '/api/workspaces', { name: 'ghost-ws' });
  assert.equal(ws.status, 201, JSON.stringify(ws.body));
  const conv = await request(base, 'POST', `/api/workspaces/${ws.body.id}/conversations`, { title: 'ghost' });
  assert.equal(conv.status, 201, JSON.stringify(conv.body));
  return { ws: ws.body, conv: conv.body };
}

async function waitFor(base, id, pred, timeoutMs = 30000) {
  const started = Date.now();
  let body;
  while (Date.now() - started < timeoutMs) {
    const got = await request(base, 'GET', `/api/conversations/${id}`);
    body = got.body;
    if (pred(body)) return body;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`conversation ${id} timed out: ${JSON.stringify(body)}`);
}

function assistantsOf(messages) {
  return (messages || []).filter((message) => message.role === 'assistant' && message.kind !== 'correction');
}

test('short delta fragments that already occurred are still appended', () => {
  const msgs = [];
  applyStreamDelta(msgs, { messageId: 'live-1', text: '这是一个 TypeScript/Node.js 项目，用于开发相关' });
  applyStreamDelta(msgs, { messageId: 'live-1', text: '，' });
  applyStreamDelta(msgs, { messageId: 'live-1', text: '也用于测试。' });
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].text, '这是一个 TypeScript/Node.js 项目，用于开发相关，也用于测试。');

  applyStreamDelta(msgs, { messageId: 'live-1', text: '甲、乙' });
  applyStreamDelta(msgs, { messageId: 'live-1', text: '、' });
  applyStreamDelta(msgs, { messageId: 'live-1', text: '丙' });
  assert.equal(msgs[0].text, '这是一个 TypeScript/Node.js 项目，用于开发相关，也用于测试。甲、乙、丙');

  const replaced = [];
  applyStreamDelta(replaced, { messageId: 'live-1', text: '甲、乙' });
  applyStreamDelta(replaced, { messageId: 'live-1', text: '甲、乙、丙', replace: true });
  assert.equal(replaced[0].text, '甲、乙、丙');
  assert.equal(replaced.filter((message) => message.streaming).length, 1);
});

test('message.done copies the assistant model onto the bubble', () => {
  const msgs = [];
  applyStreamDelta(msgs, { messageId: 'live-1', text: 'hi' });
  applyMessageDone(msgs, { messageId: '11', liveId: 'live-1', text: 'hi', model: 'deepseek-flash' });
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].id, '11');
  assert.equal(msgs[0].model, 'deepseek-flash');
  assert.equal(msgs[0].streaming, false);
});

test('two generations leave two assistant bubbles and a refresh drops the live fragment', () => {
  const round = (liveId, messageId, chunks, text) => [
    ...chunks.map((chunk) => ({ event: 'message.delta', data: { messageId: liveId, text: chunk } })),
    { event: 'message.done', data: { messageId, liveId, text } },
  ];
  const events = [
    { event: 'status', data: { status: 'running' } },
    ...round('live-1', '4', ['这是一个 TypeScript/Node.js 项目，用于开发相关', '，', '也用于。'], '这是一个 TypeScript/Node.js 项目，用于开发相关，也用于。'),
    { event: 'status', data: { status: 'done' } },
    { event: 'status', data: { status: 'running' } },
    ...round('live-2', '8', ['甲、乙', '、', '丙'], '甲、乙、丙'),
    { event: 'status', data: { status: 'done' } },
  ];
  const messages = [];
  for (const ev of events) {
    const data = ev?.data || {};
    if (ev?.event === 'message.delta') applyStreamDelta(messages, data);
    else if (ev?.event === 'message.done') applyMessageDone(messages, data);
    else if (ev?.event === 'status' && (data.status === 'done' || data.status === 'failed' || data.status === 'stopped' || data.status === 'idle')) {
      dropStreamingResidues(messages);
    }
  }
  const assistants = assistantsOf(messages);
  assert.equal(assistants.length, 2);
  assert.deepEqual(assistants.map((message) => message.text), [
    '这是一个 TypeScript/Node.js 项目，用于开发相关，也用于。',
    '甲、乙、丙',
  ]);
  assert.equal(messages.some((message) => message.streaming), false);
  assert.equal(messages.some((message) => String(message.id).startsWith('live')), false);

  const withGhost = messages.concat([{
    id: 'live',
    role: 'assistant',
    text: '这是一个 TypeScript',
    streaming: true,
  }]);
  const server = [
    { id: '2', role: 'user', text: '第一句' },
    { id: '4', role: 'assistant', text: assistants[0].text },
    { id: '6', role: 'user', text: '第二句' },
    { id: '8', role: 'assistant', text: assistants[1].text },
  ];
  const merged = mergeRefreshedMessages(withGhost, server, { keepStreaming: false });
  assert.deepEqual(assistantsOf(merged).map((message) => message.text), assistants.map((message) => message.text));
  assert.equal(merged.some((message) => message.streaming || message.id === 'live'), false);

  const legacy = [
    { id: '5', role: 'assistant', text: '完整回复' },
  ];
  applyStreamDelta(legacy, { messageId: 'live', text: '完整' });
  applyStreamDelta(legacy, { messageId: 'live', text: '回复' });
  applyMessageDone(legacy, { messageId: '5', text: '完整回复' });
  assert.equal(assistantsOf(legacy).length, 1);
  assert.equal(legacy[0].id, '5');
  assert.equal(legacy[0].streaming, false);
});

test('faux two turns: folded events match the transcript and leave no stream', { timeout: 45000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-ghost-script-'));
  const script = path.join(dataDir, 'two.json');
  await writeFile(script, JSON.stringify({
    turns: [
      { tool: 'ls', args: { path: '.' } },
      { text: TEXT_A },
      { tool: 'ls', args: { path: 'src' } },
      { text: TEXT_B },
    ],
  }));
  const srv = await startServer({
    token: TOKEN,
    env: {
      WEFT_LLM: 'faux',
      WEFT_FAUX_SCRIPT: script,
      WEFT_FAUX_TPS: '4',
    },
  });
  try {
    const { ws, conv } = await openConversation(srv.base);
    await mkdir(path.join(ws.path, 'src'));
    const pending = collectSse(srv.base, conv.id, {
      ready: (events) => events.some((ev) => ev.event === 'message.done' && ev.data?.text === TEXT_B),
      timeout: 40000,
    });
    assert.equal((await request(srv.base, 'POST', `/api/conversations/${conv.id}/messages`, { text: '先看一下' })).status, 202);
    const first = await waitFor(srv.base, conv.id, (body) => body.status === 'done' && body.messages?.some((message) => message.text === TEXT_A));
    assert.equal(assistantsOf(first.messages).length, 1, JSON.stringify(first.messages));
    assert.equal((await request(srv.base, 'POST', `/api/conversations/${conv.id}/messages`, { text: '再看 src' })).status, 202);
    const events = await pending;
    const done = await waitFor(srv.base, conv.id, (body) => (
      body.status === 'done' && body.messages?.some((message) => message.text === TEXT_B)
    ));
    const deltas = events.filter((ev) => ev.event === 'message.delta');
    assert.equal(deltas.length > 0, true, JSON.stringify(events.map((ev) => ev.event)));
    const open = new Set();
    for (const ev of events) {
      if (ev.event === 'message.delta') open.add(ev.data.messageId);
      if (ev.event === 'message.done' && ev.data?.liveId) {
        assert.equal(open.has(ev.data.liveId), true);
        open.delete(ev.data.liveId);
      }
    }
    assert.equal(open.size, 0, JSON.stringify([...open]));
    const replayed = [];
    let status = null;
    for (const ev of events) {
      const data = ev?.data || {};
      if (ev?.event === 'message.delta') applyStreamDelta(replayed, data);
      else if (ev?.event === 'message.done') applyMessageDone(replayed, data);
      else if (ev?.event === 'status') {
        status = data.status || status;
        if (status === 'done' || status === 'failed' || status === 'stopped' || status === 'idle') {
          dropStreamingResidues(replayed);
        }
      }
    }
    const merged = mergeRefreshedMessages(replayed, done.messages, {
      keepStreaming: statusKeepsStreaming(status),
    });
    const expected = assistantsOf(done.messages).map((message) => message.text);
    assert.deepEqual(expected, [TEXT_A, TEXT_B]);
    assert.deepEqual(assistantsOf(merged).map((message) => message.text), expected);
    assert.equal(merged.some((message) => message.streaming), false);
    assert.equal(merged.some((message) => message.id === 'live' || String(message.id).startsWith('live-')), false);
    assert.equal(assistantsOf(replayed).map((message) => message.text).join('\n'), expected.join('\n'));
  } finally {
    await stopServer(srv);
    await rm(srv.dataDir, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }
});

