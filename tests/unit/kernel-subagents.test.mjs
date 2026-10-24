import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSSE } from '../../src/core/sse.mjs';
import { createExtensionHost } from '../../src/core/extensions.mjs';
import { loadRoleTemplates } from '../../src/core/roles-load.mjs';
import { openConversationKernel } from '../../src/kernel/conversations.mjs';
import { createSqliteStore } from '../../src/store/sqlite.mjs';
import { killChild, request as serverRequest, startServer, stopServer } from './_server.mjs';
import { ROOT } from './_root.mjs';

const TOKEN = 'unit-kernel-subagents-token';
const request = (base, method, apiPath, body) => serverRequest(base, method, apiPath, body, TOKEN);

const SCOUT = {
  id: 'scout',
  name: 'Scout',
  description: 'when the tree needs reading',
  systemPrompt: 'SCOUT PROMPT',
  tools: ['read'],
  pluginTools: false,
  skills: ['commit-message'],
};

function killed(proc) {
  return new Promise((resolve) => {
    if (proc.exitCode != null || proc.signalCode != null) {
      resolve({ code: proc.exitCode, signal: proc.signalCode, out: '' });
      return;
    }
    let out = '';
    const take = (buf) => { out += buf; };
    proc.stdout?.on('data', take);
    proc.stderr?.on('data', take);
    proc.once('exit', (code, signal) => resolve({ code, signal, out }));
    killChild(proc);
  });
}

function parseChunk(part) {
  return parseSSE(`${part}\n\n`).filter((ev) => ev.event);
}

async function collectSse(base, cid, { ready, quietMs = 400, timeout = 12000 } = {}) {
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

async function waitForFile(file, timeout = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (existsSync(file)) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`timed out waiting for ${file}`);
}

function toolTexts(body) {
  return (body?.messages || [])
    .filter((message) => message.role === 'tool')
    .map((message) => message.text || message.tool?.output || '');
}

function assistantTexts(body) {
  return (body?.messages || []).filter((message) => message.role === 'assistant').map((message) => message.text || '');
}

function subagentsOf(body) {
  return (body?.agents || []).filter((agent) => String(agent.id || '').includes(':sub:'));
}

function childHarnessId(agent) {
  const id = String(agent?.id || '');
  const marker = ':sub:';
  const at = id.lastIndexOf(marker);
  return at >= 0 ? Number(id.slice(at + marker.length)) : NaN;
}

function systemText(payload) {
  return (payload?.messages || []).filter((message) => message.role === 'system').map((message) => (
    typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
  )).join('\n');
}

function toolNames(payload) {
  const names = [];
  for (const tool of payload?.tools || []) {
    const name = tool?.function?.name || tool?.custom?.name || tool?.name;
    if (name) names.push(name);
  }
  return names;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function chatCompletionSse(text) {
  const chunk = (delta, finish) => JSON.stringify({
    id: 'chatcmpl-subagent',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  return [
    `data: ${chunk({ role: 'assistant', content: text }, null)}`,
    '',
    `data: ${chunk({}, 'stop')}`,
    '',
    'data: [DONE]',
    '',
    '',
  ].join('\n');
}

/**
 * OpenAI-compatible stand-in. `releasePath` holds every completion until that
 * file exists; the first arrival also writes `readyPath`. Closing the request
 * before release does not answer it.
 */
function startScoutModel({ text, readyPath, releasePath }) {
  const seen = [];
  let closed = 0;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    let raw = '';
    try {
      raw = await readBody(req);
    } catch {
      res.writeHead(400);
      res.end('bad body');
      return;
    }
    let payload = null;
    try { payload = JSON.parse(raw); } catch { payload = null; }
    const record = {
      path: url.pathname,
      model: payload?.model || '',
      tools: toolNames(payload),
      system: systemText(payload),
      keyTail: String(req.headers.authorization || '').slice(-4),
    };
    seen.push(record);
    if (!url.pathname.endsWith('/chat/completions')) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    if (readyPath && seen.filter((hit) => hit.path.endsWith('/chat/completions')).length === 1) {
      await writeFile(readyPath, 'seen');
    }
    if (releasePath) {
      const released = new Promise((resolve) => {
        let settled = false;
        const timer = setInterval(() => {
          if (existsSync(releasePath)) finish(true);
        }, 20);
        const finish = (ok) => {
          if (settled) return;
          settled = true;
          clearInterval(timer);
          if (!ok) closed += 1;
          resolve(ok);
        };
        req.socket.on('close', () => finish(false));
      });
      const ok = await released;
      if (!ok || res.writableEnded || res.destroyed) return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.end(chatCompletionSse(text));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        seen,
        closed: () => closed,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

async function writeScript(dataDir, name, turns) {
  const file = path.join(dataDir, name);
  await writeFile(file, JSON.stringify({ turns }));
  return file;
}

async function bindScout(base, fake) {
  const role = await request(base, 'POST', '/api/roles', SCOUT);
  assert.equal(role.status, 201, JSON.stringify(role.body));
  const source = await request(base, 'POST', '/api/sources', {
    vendor: 'custom',
    name: 'Scout',
    baseUrl: fake.baseUrl,
    apiKey: 'sk-scout-key-1234',
    models: ['model-scout'],
  });
  assert.equal(source.status, 201, JSON.stringify(source.body));
  const settings = await request(base, 'PUT', '/api/settings', {
    models: { scout: { sourceId: source.body.id, model: 'model-scout' } },
  });
  assert.equal(settings.status, 200, JSON.stringify(settings.body));
}

test('subagent messages 404 for an unknown conversation or agent', { timeout: 30000 }, async () => {
  const srv = await startServer({
    token: TOKEN,
    env: { PI_WORK_RETRY_MAX: '2', PI_WORK_LLM: 'faux', PI_WORK_FAUX_TEXT: 'still-here' },
  });
  try {
    const missing = await request(srv.base, 'GET', '/api/conversations/none/agents/none/messages');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error, 'conversation not found');
    const ws = await request(srv.base, 'POST', '/api/workspaces', { name: 'off' });
    assert.equal(ws.status, 201);
    const conv = await request(srv.base, 'POST', `/api/workspaces/${ws.body.id}/conversations`, { title: 'off' });
    assert.equal(conv.status, 201);
    const unknownAgent = await request(srv.base, 'GET', `/api/conversations/${conv.body.id}/agents/none/messages`);
    assert.equal(unknownAgent.status, 404);
    assert.equal(unknownAgent.body.error, 'agent not found');
    const sent = await request(srv.base, 'POST', `/api/conversations/${conv.body.id}/messages`, { text: 'hi' });
    assert.equal(sent.status, 202);
    const done = await waitFor(srv.base, conv.body.id, (body) => assistantTexts(body).includes('still-here'));
    assert.equal(done.status, 'done');
    assert.equal(subagentsOf(done).length, 0);
  } finally {
    await stopServer(srv);
    await rm(srv.dataDir, { recursive: true, force: true });
  }
});

test('foreground delegate returns the child answer and lists roles in its description', { timeout: 60000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-ksub-fg-'));
  const record = path.join(dataDir, 'parent-requests.jsonl');
  const script = await writeScript(dataDir, 'parent.json', [
    { tool: 'delegate', args: { agent: 'scout', task: 'Say CHILD_MODEL_OK' } },
    { text: 'parent-done' },
  ]);
  const fake = await startScoutModel({ text: 'CHILD_MODEL_OK' });
  let proc = null;
  try {
    const srv = await startServer({
      token: TOKEN,
      dataDir,
      env: {
        PI_WORK_RETRY_MAX: '2',
        PI_WORK_LLM: 'faux',
        PI_WORK_FAUX_SCRIPT: script,
        PI_WORK_FAUX_RECORD: record,
      },
    });
    proc = srv.proc;
    await bindScout(srv.base, fake);
    const ws = await request(srv.base, 'POST', '/api/workspaces', { name: 'fg' });
    assert.equal(ws.status, 201);
    const conv = await request(srv.base, 'POST', `/api/workspaces/${ws.body.id}/conversations`, { title: 'fg' });
    assert.equal(conv.status, 201);
    const pendingEvents = collectSse(srv.base, conv.body.id, {
      ready: (list) => list.some((ev) => ev.event === 'agent' && ev.data?.roleId === 'scout' && ev.data?.lastText?.includes('CHILD_MODEL_OK')),
      timeout: 30000,
    });
    const sent = await request(srv.base, 'POST', `/api/conversations/${conv.body.id}/messages`, { text: 'dispatch scout' });
    assert.equal(sent.status, 202);
    const done = await waitFor(srv.base, conv.body.id, (body) => (
      body.status === 'done' && toolTexts(body).some((text) => text.includes('CHILD_MODEL_OK'))
    ));
    assert.equal(done.status, 'done', srv.logs());
    assert.equal(assistantTexts(done).includes('CHILD_MODEL_OK'), false);
    assert.equal(assistantTexts(done).includes('parent-done'), true);
    const childHit = fake.seen.find((hit) => hit.path.endsWith('/chat/completions'));
    assert.ok(childHit, JSON.stringify(fake.seen));
    assert.equal(childHit.model, 'model-scout');
    assert.equal(childHit.keyTail, '1234');
    assert.deepEqual(childHit.tools, ['read']);
    assert.match(childHit.system, /SCOUT PROMPT/);
    assert.match(childHit.system, /Commit messages/);
    assert.equal(childHit.system.includes('Pick a subagent by id'), false);
    const parentLines = (await readFile(record, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.match(parentLines[0].toolDescriptions?.delegate || '', /scout \(Scout\): when the tree needs reading/);
    assert.equal(parentLines[0].tools.includes('delegate'), true);
    const scout = subagentsOf(done).find((agent) => agent.roleId === 'scout');
    assert.ok(scout, JSON.stringify(done.agents));
    assert.equal(scout.name, 'Scout');
    assert.equal(scout.status, 'done');
    assert.equal(scout.mode, 'foreground');
    assert.match(scout.lastText, /CHILD_MODEL_OK/);
    for (const chip of done.agents.filter((agent) => !String(agent.id).includes(':sub:'))) {
      assert.equal(chip.mode, undefined);
    }
    const messages = await request(srv.base, 'GET', `/api/conversations/${conv.body.id}/agents/${encodeURIComponent(scout.id)}/messages`);
    assert.equal(messages.status, 200);
    assert.equal(messages.body.mode, 'foreground');
    assert.equal(messages.body.messages.filter((message) => message.role === 'user').length, 1);
    assert.match(messages.body.messages.find((message) => message.role === 'assistant')?.text || '', /CHILD_MODEL_OK/);
    const missing = await request(srv.base, 'GET', `/api/conversations/${conv.body.id}/agents/missing/messages`);
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error, 'agent not found');
    const events = await pendingEvents;
    const deltas = events.filter((ev) => ev.event === 'message.delta').map((ev) => ev.data?.text || '').join('');
    assert.equal(deltas.includes('CHILD_MODEL_OK'), false);
    const agentEvent = events.find((ev) => ev.event === 'agent' && ev.data?.roleId === 'scout' && ev.data?.lastText?.includes('CHILD_MODEL_OK'));
    assert.ok(agentEvent, JSON.stringify(events.filter((ev) => ev.event === 'agent')));
    assert.equal(agentEvent.data.mode, 'foreground');
    for (const ev of events.filter((item) => item.event === 'agent' && !String(item.data?.id || '').includes(':sub:'))) {
      assert.equal(ev.data.mode, undefined);
    }
  } finally {
    await stopServer(proc);
    await fake.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('background spawn reports the answer back to the main conversation', { timeout: 60000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-ksub-bg-'));
  const script = await writeScript(dataDir, 'parent.json', [
    { tool: 'subagent', args: { action: 'spawn', name: 'a', agent: 'scout', message: 'ping-a' } },
    { text: 'spawned' },
  ]);
  const fake = await startScoutModel({ text: 'SCOUT_PONG' });
  let proc = null;
  try {
    const srv = await startServer({
      token: TOKEN,
      dataDir,
      env: {
        PI_WORK_RETRY_MAX: '2',
        PI_WORK_LLM: 'faux',
        PI_WORK_FAUX_SCRIPT: script,
      },
    });
    proc = srv.proc;
    await bindScout(srv.base, fake);
    const ws = await request(srv.base, 'POST', '/api/workspaces', { name: 'bg' });
    const conv = await request(srv.base, 'POST', `/api/workspaces/${ws.body.id}/conversations`, { title: 'bg' });
    const pendingEvents = collectSse(srv.base, conv.body.id, {
      ready: (list) => list.some((ev) => ev.event === 'agent' && ev.data?.mode === 'background' && ev.data?.lastText?.includes('SCOUT_PONG')),
      timeout: 30000,
    });
    assert.equal((await request(srv.base, 'POST', `/api/conversations/${conv.body.id}/messages`, { text: 'run background' })).status, 202);
    const done = await waitFor(srv.base, conv.body.id, (body) => (
      (body.messages || []).some((message) => String(message.text || '').includes('[subagent a answered, no reply needed] SCOUT_PONG'))
    ), 120);
    assert.match(toolTexts(done).join('\n'), /Started a\./);
    assert.match((done.messages || []).map((message) => message.text || '').join('\n'), /\[subagent a answered, no reply needed] SCOUT_PONG/);
    const scout = subagentsOf(done).find((agent) => agent.name === 'a');
    assert.ok(scout, JSON.stringify(done.agents));
    assert.equal(scout.roleId, 'scout');
    assert.equal(scout.mode, 'background');
    assert.match(scout.lastText, /SCOUT_PONG/);
    const child = await request(srv.base, 'GET', `/api/conversations/${conv.body.id}/agents/${encodeURIComponent(scout.id)}/messages`);
    assert.equal(child.status, 200);
    assert.equal(child.body.mode, 'background');
    assert.ok(child.body.messages.some((message) => message.role === 'user' && message.text === 'ping-a'));
    assert.ok(child.body.messages.some((message) => message.role === 'assistant' && message.text === 'SCOUT_PONG'));
    const events = await pendingEvents;
    const agentEvent = events.find((ev) => ev.event === 'agent' && ev.data?.id === scout.id);
    assert.equal(agentEvent?.data?.mode, 'background');
  } finally {
    await stopServer(proc);
    await fake.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('stopping the conversation stops a background subagent', { timeout: 60000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-ksub-stop-'));
  const ready = path.join(dataDir, 'ready');
  const release = path.join(dataDir, 'release');
  const script = await writeScript(dataDir, 'parent.json', [
    { tool: 'subagent', args: { action: 'spawn', name: 'sleeper', agent: 'scout', message: 'hold' } },
    { text: 'spawned' },
  ]);
  const fake = await startScoutModel({ text: 'SHOULD_NOT_FINISH', readyPath: ready, releasePath: release });
  let proc = null;
  try {
    const srv = await startServer({
      token: TOKEN,
      dataDir,
      env: {
        PI_WORK_RETRY_MAX: '2',
        PI_WORK_LLM: 'faux',
        PI_WORK_FAUX_SCRIPT: script,
      },
    });
    proc = srv.proc;
    await bindScout(srv.base, fake);
    const ws = await request(srv.base, 'POST', '/api/workspaces', { name: 'stop' });
    const conv = await request(srv.base, 'POST', `/api/workspaces/${ws.body.id}/conversations`, { title: 'stop' });
    assert.equal((await request(srv.base, 'POST', `/api/conversations/${conv.body.id}/messages`, { text: 'spawn sleeper' })).status, 202);
    await waitForFile(ready);
    const idle = await waitFor(srv.base, conv.body.id, (body) => (
      body.status === 'done' && assistantTexts(body).includes('spawned')
    ));
    assert.equal(idle.status, 'done', srv.logs());
    const stopped = await request(srv.base, 'POST', `/api/conversations/${conv.body.id}/stop`);
    assert.equal(stopped.status, 200);
    assert.equal(stopped.body.status, 'stopped');
    const after = await waitFor(srv.base, conv.body.id, (body) => {
      const sleeper = subagentsOf(body).find((agent) => agent.name === 'sleeper');
      return sleeper?.status === 'stopped';
    });
    assert.equal(subagentsOf(after).find((agent) => agent.name === 'sleeper')?.status, 'stopped');
    const started = Date.now();
    while (fake.closed() < 1 && Date.now() - started < 8000) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(fake.closed() >= 1, 'background model call stayed open after stop');
    const child = subagentsOf(after)[0];
    const messages = await request(srv.base, 'GET', `/api/conversations/${conv.body.id}/agents/${encodeURIComponent(child.id)}/messages`);
    assert.equal(messages.status, 200);
    assert.equal(messages.body.messages.some((message) => message.text === 'SHOULD_NOT_FINISH'), false);
  } finally {
    await stopServer(proc);
    await fake.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('a killed foreground subagent resumes the same child without a second submit', { timeout: 60000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-ksub-recover-'));
  const ready = path.join(dataDir, 'ready');
  const release = path.join(dataDir, 'release');
  const script = await writeScript(dataDir, 'parent.json', [
    { tool: 'delegate', args: { agent: 'scout', task: 'resume-task' } },
    { text: 'parent-resumed' },
  ]);
  const fake = await startScoutModel({ text: 'RESUMED_CHILD', readyPath: ready, releasePath: release });
  const env = {
    PI_WORK_RETRY_MAX: '2',
    PI_WORK_LLM: 'faux',
    PI_WORK_FAUX_SCRIPT: script,
  };
  let proc = null;
  try {
    const first = await startServer({ token: TOKEN, env, dataDir });
    proc = first.proc;
    await bindScout(first.base, fake);
    const ws = await request(first.base, 'POST', '/api/workspaces', { name: 'recover' });
    const conv = await request(first.base, 'POST', `/api/workspaces/${ws.body.id}/conversations`, { title: 'recover' });
    assert.equal((await request(first.base, 'POST', `/api/conversations/${conv.body.id}/messages`, { text: 'delegate' })).status, 202);
    await waitForFile(ready);
    const death = await killed(proc);
    proc = null;
    assert.ok(death.signal === 'SIGKILL' || death.code !== 0 || process.platform === 'win32');
    const second = await startServer({ token: TOKEN, env, dataDir });
    proc = second.proc;
    await writeFile(release, 'go');
    const done = await waitFor(second.base, conv.body.id, (body) => (
      toolTexts(body).some((text) => text.includes('RESUMED_CHILD'))
    ), 100);
    assert.match(toolTexts(done).join('\n'), /RESUMED_CHILD/, `${second.logs()}\n${JSON.stringify(done?.messages)}`);
    const scout = subagentsOf(done).find((agent) => agent.roleId === 'scout');
    assert.ok(scout);
    const messages = await request(second.base, 'GET', `/api/conversations/${conv.body.id}/agents/${encodeURIComponent(scout.id)}/messages`);
    assert.equal(messages.status, 200);
    const users = messages.body.messages.filter((message) => message.role === 'user');
    const assistants = messages.body.messages.filter((message) => message.role === 'assistant');
    assert.equal(users.length, 1, JSON.stringify(messages.body.messages));
    assert.equal(users[0].text, 'resume-task');
    assert.equal(assistants.length, 1);
    assert.equal(assistants[0].text, 'RESUMED_CHILD');
    assert.equal(subagentsOf(done).filter((agent) => agent.roleId === 'scout').length, 1);
    const calls = fake.seen.filter((hit) => hit.path.endsWith('/chat/completions')).length;
    assert.ok(calls >= 1 && calls <= 3, `child model calls ${calls}`);
  } finally {
    await stopServer(proc);
    await fake.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('a background subagent continues after restart and reports once', { timeout: 90000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-ksub-bgrecover-'));
  const ready = path.join(dataDir, 'ready');
  const release = path.join(dataDir, 'release');
  const script = await writeScript(dataDir, 'parent.json', [
    { tool: 'subagent', args: { action: 'spawn', name: 'bg', agent: 'scout', message: 'hold-bg' } },
    { text: 'parent-idle' },
  ]);
  const fake = await startScoutModel({ text: 'BG_ANSWER', readyPath: ready, releasePath: release });
  const env = {
    PI_WORK_RETRY_MAX: '2',
    PI_WORK_LLM: 'faux',
    PI_WORK_FAUX_SCRIPT: script,
  };
  let proc = null;
  try {
    const first = await startServer({ token: TOKEN, env, dataDir });
    proc = first.proc;
    await bindScout(first.base, fake);
    const ws = await request(first.base, 'POST', '/api/workspaces', { name: 'bgrecover' });
    const conv = await request(first.base, 'POST', `/api/workspaces/${ws.body.id}/conversations`, { title: 'bgrecover' });
    assert.equal((await request(first.base, 'POST', `/api/conversations/${conv.body.id}/messages`, { text: 'spawn bg' })).status, 202);
    await waitForFile(ready);
    const idle = await waitFor(first.base, conv.body.id, (body) => (
      body.status === 'done' && assistantTexts(body).includes('parent-idle')
    ));
    assert.equal(idle.status, 'done', first.logs());
    const death = await killed(proc);
    proc = null;
    assert.ok(death.signal === 'SIGKILL' || death.code !== 0 || process.platform === 'win32');
    const second = await startServer({ token: TOKEN, env, dataDir });
    proc = second.proc;
    await writeFile(release, 'go');
    const reported = await waitFor(second.base, conv.body.id, (body) => (
      (body.messages || []).filter((message) => String(message.text || '').includes('BG_ANSWER')).length === 1
      && (body.status === 'done' || body.status === 'idle')
    ), 100);
    const reports = (reported.messages || []).filter((message) => String(message.text || '').includes('BG_ANSWER'));
    assert.equal(reports.length, 1, `${second.logs()}\n${JSON.stringify(reported?.messages)}`);
    assert.match(reports[0].text, /\[subagent bg answered, no reply needed] BG_ANSWER/);
    await stopServer(proc);
    proc = null;
    const third = await startServer({ token: TOKEN, env, dataDir });
    proc = third.proc;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const again = await request(third.base, 'GET', `/api/conversations/${conv.body.id}`);
    const againReports = (again.body.messages || []).filter((message) => String(message.text || '').includes('BG_ANSWER'));
    assert.equal(againReports.length, 1, JSON.stringify(again.body.messages));
  } finally {
    await stopServer(proc);
    await fake.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('a killed foreground subagent writes the file once after restart', { timeout: 90_000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-ksub-write-'));
  const ready = path.join(dataDir, 'ready');
  const script = await writeScript(dataDir, 'write-child.json', [
    { tool: 'delegate', args: { agent: 'coder', task: 'WRITE_ONCE the output file' } },
    { text: 'parent-done' },
    { when: 'WRITE_ONCE', delayMs: 2500, tool: 'write', args: { path: 'child-out.txt', content: 'once\n' } },
    { when: 'WRITE_ONCE', text: 'child-wrote' },
  ]);
  const env = {
    PI_WORK_RETRY_MAX: '2',
    PI_WORK_LLM: 'faux',
    PI_WORK_FAUX_SCRIPT: script,
    PI_WORK_FAUX_HOLD_READY: ready,
  };
  let proc = null;
  let wsPath;
  let convId;
  try {
    const first = await startServer({ token: TOKEN, env, dataDir });
    proc = first.proc;
    const ws = await request(first.base, 'POST', '/api/workspaces', { name: 'write-child' });
    assert.equal(ws.status, 201, JSON.stringify(ws.body));
    wsPath = ws.body.path;
    const conv = await request(first.base, 'POST', `/api/workspaces/${ws.body.id}/conversations`, { title: 'write-child' });
    assert.equal(conv.status, 201);
    convId = conv.body.id;
    assert.equal((await request(first.base, 'POST', `/api/conversations/${convId}/messages`, { text: 'dispatch child' })).status, 202);
    await waitForFile(ready);
    const death = await killed(proc);
    proc = null;
    assert.ok(death.signal === 'SIGKILL' || death.code !== 0 || process.platform === 'win32');
    await rm(ready, { force: true });
    const second = await startServer({ token: TOKEN, env, dataDir });
    proc = second.proc;
    const done = await waitFor(second.base, convId, (body) => (
      body.status === 'done' && assistantTexts(body).includes('parent-done')
    ), 200);
    assert.equal(done.status, 'done', second.logs());
    assert.equal(await readFile(path.join(wsPath, 'child-out.txt'), 'utf8'), 'once\n');
    assert.equal(assistantTexts(done).filter((text) => text === 'parent-done').length, 1, JSON.stringify(done.messages));
    const children = subagentsOf(done).filter((agent) => agent.roleId === 'coder');
    assert.equal(children.length, 1, JSON.stringify(done.agents));
    const messages = await request(second.base, 'GET', `/api/conversations/${convId}/agents/${encodeURIComponent(children[0].id)}/messages`);
    assert.equal(messages.status, 200, JSON.stringify(messages.body));
    const writes = (messages.body.messages || []).filter((message) => message.role === 'tool' && message.tool?.name === 'write');
    assert.equal(writes.length, 1, JSON.stringify(messages.body.messages));
  } finally {
    await stopServer(proc);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('aborting a foreground child returns stopped-by-the-user and the parent continues', { timeout: 60000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-ksub-abort-child-'));
  const ready = path.join(dataDir, 'ready');
  const script = await writeScript(dataDir, 'abort-child.json', [
    { tool: 'delegate', args: { agent: 'coder', task: 'HOLD_CHILD' } },
    { text: 'parent-continued' },
    { when: 'HOLD_CHILD', delayMs: 60000, text: 'SHOULD_NOT_FINISH' },
  ]);
  const store = createSqliteStore(dataDir);
  let kernel = null;
  try {
    await loadRoleTemplates(store, path.join(ROOT, 'roles'));
    const wsPath = path.join(dataDir, 'ws');
    await mkdir(wsPath, { recursive: true });
    const ws = await store.createWorkspace({ name: 'abort-child', path: wsPath });
    kernel = await openConversationKernel({
      dataDir,
      store,
      demo: true,
      extensions: createExtensionHost({ getSettings: () => store.getSettings() }),
      getSettings: () => store.getSettings(),
      env: {
        PI_WORK_LLM: 'faux',
        PI_WORK_FAUX_SCRIPT: script,
        PI_WORK_FAUX_HOLD_READY: ready,
        PI_WORK_RETRY_MAX: '2',
        PI_WORK_RETRY_BASE_MS: '20',
      },
    });
    const conv = await kernel.createConversation({
      workspaceId: ws.id,
      workspacePath: wsPath,
      title: 'abort-child',
    });
    const posted = await kernel.postMessage(conv, 'delegate and continue');
    assert.equal(posted.status, 202);
    await waitForFile(ready);
    let scout = null;
    for (let i = 0; i < 80; i += 1) {
      const live = await store.getConversation(conv.id);
      const agents = await kernel.listSubagents(live);
      scout = agents.find((agent) => agent.roleId === 'coder' || agent.mode === 'foreground');
      if (scout) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(scout, 'foreground child never appeared');
    const childId = childHarnessId(scout);
    const handle = await kernel.harness.conversation(childId, kernel.context);
    assert.ok(handle, `missing child conversation ${childId}`);
    await handle.abort(kernel.context);
    let done = null;
    for (let i = 0; i < 120; i += 1) {
      const live = await store.getConversation(conv.id);
      done = await kernel.present(live, { includeMessages: true });
      if (done.status === 'done' && assistantTexts(done).includes('parent-continued')) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(done.status, 'done', JSON.stringify(done));
    assert.equal(done.status === 'stopped' || done.status === 'failed', false);
    assert.match(toolTexts(done).join('\n'), /stopped by the user/);
    assert.equal(assistantTexts(done).includes('parent-continued'), true);
    assert.equal(assistantTexts(done).includes('SHOULD_NOT_FINISH'), false);
  } finally {
    if (kernel) await kernel.close();
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('stopping the main conversation while a foreground child is running still stops the parent', { timeout: 60000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-ksub-stop-parent-'));
  const ready = path.join(dataDir, 'ready');
  const release = path.join(dataDir, 'release');
  const script = await writeScript(dataDir, 'stop-parent.json', [
    { tool: 'delegate', args: { agent: 'scout', task: 'hold-parent-stop' } },
    { text: 'parent-should-not-finish' },
  ]);
  const fake = await startScoutModel({ text: 'CHILD_SHOULD_NOT_FINISH', readyPath: ready, releasePath: release });
  let proc = null;
  try {
    const srv = await startServer({
      token: TOKEN,
      dataDir,
      env: {
        PI_WORK_RETRY_MAX: '2',
        PI_WORK_LLM: 'faux',
        PI_WORK_FAUX_SCRIPT: script,
      },
    });
    proc = srv.proc;
    await bindScout(srv.base, fake);
    const ws = await request(srv.base, 'POST', '/api/workspaces', { name: 'stop-parent' });
    const conv = await request(srv.base, 'POST', `/api/workspaces/${ws.body.id}/conversations`, { title: 'stop-parent' });
    assert.equal((await request(srv.base, 'POST', `/api/conversations/${conv.body.id}/messages`, { text: 'delegate then stop' })).status, 202);
    await waitForFile(ready);
    const stopped = await request(srv.base, 'POST', `/api/conversations/${conv.body.id}/stop`);
    assert.equal(stopped.status, 200);
    const after = await waitFor(srv.base, conv.body.id, (body) => body.status === 'stopped' || body.status === 'done');
    assert.equal(after.status, 'stopped', srv.logs());
    assert.equal(assistantTexts(after).includes('parent-should-not-finish'), false);
    assert.equal(toolTexts(after).some((text) => text.includes('stopped by the user')), false);
  } finally {
    await stopServer(proc);
    await fake.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
