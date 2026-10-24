import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSSE } from '../../src/core/sse.mjs';
import { messagesFromEntries } from '../../src/kernel/events.mjs';
import {
  parentModelText,
  parentNoteText,
  USER_TO_SUBAGENT_KIND,
} from '../../src/kernel/subagent-control.mjs';
import { request as serverRequest, startServer, stopServer } from './_server.mjs';

const TOKEN = 'unit-kernel-subagent-control-token';
const request = (base, method, apiPath, body) => serverRequest(base, method, apiPath, body, TOKEN);

function parseChunk(part) {
  return parseSSE(`${part}\n\n`).filter((ev) => ev.event);
}

async function collectSse(base, cid, { ready, quietMs = 400, timeout = 20000 } = {}) {
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

async function waitFor(base, cid, ready, attempts = 80) {
  let body = null;
  for (let i = 0; i < attempts; i += 1) {
    const got = await request(base, 'GET', `/api/conversations/${cid}`);
    body = got.body;
    if (ready(body)) return body;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return body;
}

function assistantTexts(body) {
  return (body?.messages || []).filter((message) => message.role === 'assistant').map((message) => message.text || '');
}

function subagentsOf(body) {
  return (body?.agents || []).filter((agent) => String(agent.id || '').includes(':sub:'));
}

function agentUrl(cid, aid, suffix) {
  return `/api/conversations/${cid}/agents/${encodeURIComponent(aid)}${suffix}`;
}

async function writeScript(dataDir, name, turns) {
  const file = path.join(dataDir, name);
  await writeFile(file, JSON.stringify({ turns }));
  return file;
}

async function recordLines(file) {
  try {
    const raw = (await readFile(file, 'utf8')).trim();
    if (!raw) return [];
    return raw.split('\n').map((line) => JSON.parse(line));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

function recordHas(lines, needle) {
  return lines.some((row) => JSON.stringify(row).includes(needle));
}

test('user-to-subagent writes map to role note, not user', () => {
  const { messages } = messagesFromEntries([
    {
      id: 1,
      kind: 'pi.user',
      model: [{ role: 'user', content: [{ type: 'text', text: 'dispatch' }] }],
    },
    {
      id: 2,
      kind: USER_TO_SUBAGENT_KIND,
      data: { agentId: 'c:sub:3', name: 'worker', text: '改用 pnpm' },
      model: [{ role: 'user', content: parentModelText('worker', '改用 pnpm') }],
    },
  ]);
  assert.equal(messages.find((message) => message.id === '1').role, 'user');
  const note = messages.find((message) => message.id === '2');
  assert.equal(note.role, 'note');
  assert.equal(note.text, parentNoteText('worker', '改用 pnpm'));
  assert.equal(messages.some((message) => message.role === 'user' && String(message.text || '').includes('改用 pnpm')), false);
});

test('POST messages steers a running subagent; parent write is a note and does not wake it', { timeout: 60000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-ksubctl-steer-'));
  const record = path.join(dataDir, 'record.jsonl');
  const script = await writeScript(dataDir, 'parent.json', [
    { tool: 'subagent', args: { action: 'spawn', name: 'worker', message: 'hold-task' } },
    { text: 'parent-idle' },
    { text: 'parent-woke' },
    { when: 'hold-task', delayMs: 4000, tool: 'ls', args: { path: '.' } },
    { when: 'hold-task', text: 'child-first' },
    { when: 'please-steer', text: 'pad-0' },
    { when: 'please-steer', text: 'child-after-steer' },
  ]);
  let proc = null;
  try {
    const srv = await startServer({
      token: TOKEN,
      dataDir,
      env: {
        WEFT_RETRY_MAX: '2',
        WEFT_LLM: 'faux',
        WEFT_FAUX_SCRIPT: script,
        WEFT_FAUX_RECORD: record,
      },
    });
    proc = srv.proc;
    const ws = await request(srv.base, 'POST', '/api/workspaces', { name: 'steer' });
    assert.equal(ws.status, 201, JSON.stringify(ws.body));
    const conv = await request(srv.base, 'POST', `/api/workspaces/${ws.body.id}/conversations`, { title: 'steer' });
    assert.equal(conv.status, 201);
    const cid = conv.body.id;
    assert.equal((await request(srv.base, 'POST', `/api/conversations/${cid}/messages`, { text: 'spawn worker' })).status, 202);

    const idle = await waitFor(srv.base, cid, (body) => (
      body.status === 'done' && assistantTexts(body).includes('parent-idle')
      && subagentsOf(body).some((agent) => agent.name === 'worker' && agent.status === 'running')
    ), 120);
    assert.equal(idle.status, 'done', srv.logs());
    const worker = subagentsOf(idle).find((agent) => agent.name === 'worker');
    assert.ok(worker, JSON.stringify(idle.agents));
    assert.equal(worker.status, 'running');

    const blank = await request(srv.base, 'POST', agentUrl(cid, worker.id, '/messages'), { text: '   ' });
    assert.equal(blank.status, 400);
    assert.equal(blank.body.error, 'text required');

    const beforeSteer = await recordLines(record);
    const steered = await request(srv.base, 'POST', agentUrl(cid, worker.id, '/messages'), { text: 'please-steer' });
    assert.equal(steered.status, 200, JSON.stringify(steered.body));
    assert.deepEqual(steered.body, { ok: true });

    const stillRunning = await waitFor(srv.base, cid, (body) => {
      const current = subagentsOf(body).find((agent) => agent.id === worker.id);
      return current?.status === 'running'
        && (body.messages || []).some((message) => message.role === 'note');
    }, 40);
    assert.equal(stillRunning.status, 'done', `parent woke after steer: ${stillRunning.status}\n${srv.logs()}`);
    const workerStill = subagentsOf(stillRunning).find((agent) => agent.id === worker.id);
    assert.equal(workerStill?.status, 'running', JSON.stringify(workerStill));
    const note = (stillRunning.messages || []).find((message) => message.role === 'note');
    assert.ok(note, JSON.stringify(stillRunning.messages));
    assert.equal(note.text, parentNoteText('worker', 'please-steer'));
    assert.equal((stillRunning.messages || []).some((message) => (
      message.role === 'user' && String(message.text || '').includes('please-steer')
    )), false);
    assert.equal((stillRunning.messages || []).some((message) => (
      message.role === 'user' && String(message.text || '').includes('用户对子 Agent')
    )), false);
    const afterSteer = await recordLines(record);
    assert.equal(recordHas(afterSteer, parentModelText('worker', 'please-steer')), false, JSON.stringify(afterSteer));
    assert.equal(afterSteer.length, beforeSteer.length, 'write must not start a parent model call');

    const woke = await request(srv.base, 'POST', `/api/conversations/${cid}/messages`, { text: 'parent-wake' });
    assert.equal(woke.status, 202);
    const parentDone = await waitFor(srv.base, cid, (body) => assistantTexts(body).includes('parent-woke'));
    assert.equal(assistantTexts(parentDone).includes('parent-woke'), true, srv.logs());
    const afterWake = await recordLines(record);
    assert.equal(recordHas(afterWake, parentModelText('worker', 'please-steer')), true, JSON.stringify(afterWake));

    const childDone = await waitFor(srv.base, cid, (body) => {
      const current = subagentsOf(body).find((agent) => agent.id === worker.id);
      return current && String(current.lastText || '').includes('child-after-steer');
    }, 120);
    const after = subagentsOf(childDone).find((agent) => agent.id === worker.id);
    assert.match(after?.lastText || '', /child-after-steer/, JSON.stringify(after));

    const child = await request(srv.base, 'GET', agentUrl(cid, worker.id, '/messages'));
    assert.equal(child.status, 200);
    assert.equal(child.body.messages.some((message) => message.role === 'user' && message.text === 'please-steer'), true, JSON.stringify(child.body.messages));
    assert.equal(child.body.messages.some((message) => message.role === 'assistant' && message.text === 'child-after-steer'), true);
    const afterChild = await recordLines(record);
    assert.equal(recordHas(afterChild, 'please-steer'), true, JSON.stringify(afterChild));
  } finally {
    await stopServer(proc);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('empty text 400, unknown 404, idle agent 409', { timeout: 60000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-ksubctl-err-'));
  const script = await writeScript(dataDir, 'parent.json', [
    { tool: 'subagent', args: { action: 'spawn', name: 'done-bot', message: 'finish-now' } },
    { text: 'parent-idle' },
    { when: 'finish-now', text: 'child-done' },
  ]);
  let proc = null;
  try {
    const srv = await startServer({
      token: TOKEN,
      dataDir,
      env: {
        WEFT_RETRY_MAX: '2',
        WEFT_LLM: 'faux',
        WEFT_FAUX_SCRIPT: script,
      },
    });
    proc = srv.proc;
    const missingConv = await request(srv.base, 'POST', '/api/conversations/none/agents/none/messages', { text: 'hi' });
    assert.equal(missingConv.status, 404);
    const missingStop = await request(srv.base, 'POST', '/api/conversations/none/agents/none/stop');
    assert.equal(missingStop.status, 404);

    const ws = await request(srv.base, 'POST', '/api/workspaces', { name: 'err' });
    const conv = await request(srv.base, 'POST', `/api/workspaces/${ws.body.id}/conversations`, { title: 'err' });
    const cid = conv.body.id;
    const empty = await request(srv.base, 'POST', agentUrl(cid, 'none', '/messages'), { text: '' });
    assert.equal(empty.status, 400);
    assert.equal(empty.body.error, 'text required');
    const unknown = await request(srv.base, 'POST', agentUrl(cid, 'none', '/messages'), { text: 'hi' });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error, 'agent not found');
    const unknownStop = await request(srv.base, 'POST', agentUrl(cid, 'none', '/stop'));
    assert.equal(unknownStop.status, 404);
    assert.equal(unknownStop.body.error, 'agent not found');

    assert.equal((await request(srv.base, 'POST', `/api/conversations/${cid}/messages`, { text: 'spawn' })).status, 202);
    const done = await waitFor(srv.base, cid, (body) => (
      body.status === 'done' && subagentsOf(body).some((agent) => agent.name === 'done-bot' && agent.status === 'done')
    ), 120);
    const bot = subagentsOf(done).find((agent) => agent.name === 'done-bot');
    assert.ok(bot, JSON.stringify(done.agents));
    const idle = await request(srv.base, 'POST', agentUrl(cid, bot.id, '/messages'), { text: 'too-late' });
    assert.equal(idle.status, 409);
    assert.equal(idle.body.error, 'agent not running');
  } finally {
    await stopServer(proc);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('POST stop aborts only that subagent and emits agent stopped', { timeout: 60000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-ksubctl-stop-'));
  const script = await writeScript(dataDir, 'parent.json', [
    { tool: 'subagent', args: { action: 'spawn', name: 'alpha', message: 'hold-alpha' } },
    { tool: 'subagent', args: { action: 'spawn', name: 'beta', message: 'hold-beta' } },
    { text: 'both-idle' },
    { when: 'hold-alpha', delayMs: 20000, text: 'ALPHA_SHOULD_NOT' },
    { when: 'hold-beta', delayMs: 20000, text: 'BETA_SHOULD_NOT' },
  ]);
  let proc = null;
  try {
    const srv = await startServer({
      token: TOKEN,
      dataDir,
      env: {
        WEFT_RETRY_MAX: '2',
        WEFT_LLM: 'faux',
        WEFT_FAUX_SCRIPT: script,
      },
    });
    proc = srv.proc;
    const ws = await request(srv.base, 'POST', '/api/workspaces', { name: 'stop' });
    const conv = await request(srv.base, 'POST', `/api/workspaces/${ws.body.id}/conversations`, { title: 'stop' });
    const cid = conv.body.id;
    const pendingEvents = collectSse(srv.base, cid, {
      ready: (list) => list.some((ev) => ev.event === 'agent' && ev.data?.name === 'alpha' && ev.data?.status === 'stopped'),
      timeout: 40000,
    });
    assert.equal((await request(srv.base, 'POST', `/api/conversations/${cid}/messages`, { text: 'spawn both' })).status, 202);
    const idle = await waitFor(srv.base, cid, (body) => (
      body.status === 'done' && assistantTexts(body).includes('both-idle')
      && subagentsOf(body).filter((agent) => agent.status === 'running').length >= 2
    ), 150);
    assert.equal(idle.status, 'done', srv.logs());
    const alpha = subagentsOf(idle).find((agent) => agent.name === 'alpha');
    const beta = subagentsOf(idle).find((agent) => agent.name === 'beta');
    assert.ok(alpha && beta, JSON.stringify(idle.agents));
    assert.equal(alpha.status, 'running');
    assert.equal(beta.status, 'running');

    const stopped = await request(srv.base, 'POST', agentUrl(cid, alpha.id, '/stop'));
    assert.equal(stopped.status, 200, JSON.stringify(stopped.body));
    assert.equal(stopped.body.status, 'stopped');

    const after = await waitFor(srv.base, cid, (body) => (
      subagentsOf(body).find((agent) => agent.id === alpha.id)?.status === 'stopped'
    ));
    assert.equal(after.status, 'done', after.status);
    assert.equal(subagentsOf(after).find((agent) => agent.id === alpha.id)?.status, 'stopped');
    assert.equal(subagentsOf(after).find((agent) => agent.id === beta.id)?.status, 'running');
    assert.equal(assistantTexts(after).includes('ALPHA_SHOULD_NOT'), false);

    const events = await pendingEvents;
    const stoppedEvent = events.find((ev) => ev.event === 'agent' && ev.data?.id === alpha.id && ev.data?.status === 'stopped');
    assert.ok(stoppedEvent, JSON.stringify(events.filter((ev) => ev.event === 'agent')));
    assert.equal(stoppedEvent.data.name, 'alpha');
  } finally {
    await stopServer(proc);
    await rm(dataDir, { recursive: true, force: true });
  }
});
