import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSSE } from '../../src/core/sse.mjs';
import { projectTranscript } from '../../src/kernel/control.mjs';
import { fauxTurnFromScript } from '../../src/kernel/faux-script.mjs';
import {
  applyMessageDone,
  applyStreamDelta,
  foldStreamEvents,
  mergeRefreshedMessages,
} from '../../public/stream.js';
import { ROOT } from './_root.mjs';

const TOKEN = 'unit-ghost-reply-token';
const TEXT_A = '这是一个 TypeScript/Node.js 项目，用于开发相关。';
const TEXT_B = '第二轮已经看完，结论里有顿号、和的字。';
const STRIP = [
  'PI_WORK_LLM',
  'PI_WORK_FAUX_SCRIPT',
  'PI_WORK_FAUX_TEXT',
  'PI_WORK_FAUX_PLAN',
  'PI_WORK_FAUX_HOLD',
  'PI_WORK_FAUX_HOLD_READY',
  'PI_WORK_FAUX_TPS',
  'PI_WORK_FAUX_DRAIN',
  'PI_WORK_KERNEL',
  'LLM_API',
  'LLM_API_KEY',
  'LLM_BASE_URL',
  'LLM_MODEL',
  'PI_WORK_GROK_AUTH',
  'GROK_HOME',
  'PI_WORK_TOOL_NUDGE',
  'PI_WORK_TOOL_LOOP',
  'PI_WORK_MAX_TOOL_CALLS',
  'PI_WORK_EXPLORE_REPEAT',
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
    PI_WORK_STALL_MS: '8000',
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

async function startServer(extra = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-ghost-'));
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
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited ${code}:\n${log}`));
    });
  });
  proc.removeAllListeners('exit');
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

function blocked(id, callId, text) {
  return {
    id,
    kind: 'pi.tool-result',
    model: [{
      toolCallId: callId,
      toolName: 'read',
      isError: true,
      content: [{ type: 'text', text: `<harness>\n[error] Tool call blocked: ${text}\n</harness>` }],
    }],
  };
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
  const folded = foldStreamEvents(events);
  const assistants = assistantsOf(folded.messages);
  assert.equal(assistants.length, 2);
  assert.deepEqual(assistants.map((message) => message.text), [
    '这是一个 TypeScript/Node.js 项目，用于开发相关，也用于。',
    '甲、乙、丙',
  ]);
  assert.equal(folded.messages.some((message) => message.streaming), false);
  assert.equal(folded.messages.some((message) => String(message.id).startsWith('live')), false);

  const withGhost = folded.messages.concat([{
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
    PI_WORK_KERNEL: 'durable',
    PI_WORK_LLM: 'faux',
    PI_WORK_FAUX_SCRIPT: script,
    PI_WORK_FAUX_TPS: '4',
    PI_WORK_EXPLORE_REPEAT: '20',
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
    const folded = foldStreamEvents(events);
    const merged = mergeRefreshedMessages(folded.messages, done.messages, {
      keepStreaming: folded.status === 'running' || folded.status === 'recovering',
    });
    const expected = assistantsOf(done.messages).map((message) => message.text);
    assert.deepEqual(expected, [TEXT_A, TEXT_B]);
    assert.deepEqual(assistantsOf(merged).map((message) => message.text), expected);
    assert.equal(merged.some((message) => message.streaming), false);
    assert.equal(merged.some((message) => message.id === 'live' || String(message.id).startsWith('live-')), false);
    assert.equal(assistantsOf(folded.messages).map((message) => message.text).join('\n'), expected.join('\n'));
  } finally {
    await stopProcess(srv.proc);
    await rm(srv.dataDir, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('duplicate corrections under one assistant project to a single note', () => {
  const note = '请根据已有结果直接回答。本步已经调用了 8 次工具，还没有写出回复。用已经看到的内容回答；如果还缺关键信息，直接说明缺什么，不要继续翻找。';
  const projected = projectTranscript([
    {
      id: 40,
      kind: 'pi.assistant',
      model: [{
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'c1', name: 'read' },
          { type: 'toolCall', id: 'c2', name: 'read' },
          { type: 'toolCall', id: 'c3', name: 'read' },
        ],
      }],
    },
    blocked('47', 'c1', note),
    blocked('48', 'c2', note),
    blocked('49', 'c3', note),
    {
      id: 60,
      kind: 'pi.assistant',
      model: [{
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'c4', name: 'read' }],
      }],
    },
    blocked('61', 'c4', note),
  ]);
  const corrections = projected.messages.filter((message) => message.kind === 'correction');
  assert.deepEqual(corrections.map((message) => message.id), ['47', '61']);
  assert.equal(corrections.every((message) => message.text === note), true);
  assert.equal(projected.messages.some((message) => message.role === 'tool'), false);
});

test('three parallel nudges in one assistant message show one correction', { timeout: 45000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-ghost-nudge-'));
  const turns = Array.from({ length: 8 }, (_, index) => ({
    tool: 'read',
    args: { path: `n${index}.txt` },
  }));
  turns.push({
    tools: [0, 1, 2].map((index) => ({
      tool: 'read',
      args: { path: `p${index}.txt` },
      id: `par-${index}`,
    })),
  });
  turns.push({ text: '就这些。' });
  const script = path.join(dataDir, 'parallel.json');
  await writeFile(script, JSON.stringify({ turns }));
  const message = fauxTurnFromScript(turns, {
    messages: Array.from({ length: 8 }, () => ({ role: 'assistant', content: '' })),
  });
  assert.equal(message.content.length, 3);
  const srv = await startServer({
    PI_WORK_KERNEL: 'durable',
    PI_WORK_LLM: 'faux',
    PI_WORK_FAUX_SCRIPT: script,
    PI_WORK_EXPLORE_REPEAT: '30',
    PI_WORK_TOOL_LOOP: '30',
    PI_WORK_MAX_TOOL_CALLS: '30',
    PI_WORK_TOOL_NUDGE: '8',
  });
  try {
    const { ws, conv } = await openConversation(srv.base);
    for (let index = 0; index < 8; index += 1) {
      await writeFile(path.join(ws.path, `n${index}.txt`), 'ok\n');
    }
    assert.equal((await request(srv.base, 'POST', `/api/conversations/${conv.id}/messages`, { text: 'go' })).status, 202);
    const done = await waitFor(srv.base, conv.id, (body) => body.status === 'done' || body.status === 'failed', 40000);
    const corrections = done.messages.filter((message) => message.kind === 'correction');
    const tools = done.messages.filter((message) => message.role === 'tool');
    assert.equal(done.status, 'done', `${srv.logs()}\n${JSON.stringify(done.messages)}`);
    assert.equal(corrections.length, 1, JSON.stringify(done.messages));
    assert.match(corrections[0].text, /请根据已有结果直接回答/);
    assert.match(corrections[0].text, /8 次工具/);
    assert.equal(tools.length, 8, JSON.stringify(done.messages));
    assert.equal(done.messages.some((message) => message.text === '就这些。'), true);
  } finally {
    await stopProcess(srv.proc);
    await rm(srv.dataDir, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }
});
