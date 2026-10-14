import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSSE } from '../../src/core/sse.mjs';
import { maxSubagents } from '../../src/kernel/subagents.mjs';
import { ROOT } from './_root.mjs';

const TOKEN = 'unit-kernel-subagents-token';
const STRIP = [
  'PI_WORK_LLM',
  'PI_WORK_FAUX_SCRIPT',
  'PI_WORK_FAUX_TEXT',
  'PI_WORK_FAUX_PLAN',
  'PI_WORK_FAUX_RECORD',
  'PI_WORK_FAUX_HOLD',
  'PI_WORK_FAUX_HOLD_READY',
  'PI_WORK_KERNEL',
  'PI_WORK_MAX_SUBAGENTS',
  'LLM_API',
  'LLM_API_KEY',
  'LLM_BASE_URL',
  'LLM_MODEL',
  'PI_WORK_GROK_AUTH',
  'GROK_HOME',
];

const SCOUT = {
  id: 'scout',
  name: 'Scout',
  description: 'when the tree needs reading',
  systemPrompt: 'SCOUT PROMPT',
  tools: ['read'],
  pluginTools: false,
  skills: ['commit-message'],
};

test('max subagents defaults to 4 and accepts a positive integer', () => {
  assert.equal(maxSubagents({}), 4);
  assert.equal(maxSubagents({ PI_WORK_MAX_SUBAGENTS: '1' }), 1);
  assert.equal(maxSubagents({ PI_WORK_MAX_SUBAGENTS: '0' }), 4);
  assert.equal(maxSubagents({ PI_WORK_MAX_SUBAGENTS: 'nope' }), 4);
});

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
    PI_WORK_RETRY_MAX: '2',
    PI_WORK_STALL_MS: '5000',
    ...extra,
  };
}

function killChild(child) {
  if (!child || child.exitCode != null || child.signalCode != null) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  child.kill('SIGKILL');
}

function stopProcess(proc) {
  return new Promise((resolve) => {
    if (!proc || proc.exitCode != null) return resolve();
    const timer = setTimeout(() => killChild(proc), 2000);
    proc.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    proc.kill('SIGTERM');
  });
}

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

async function startServer(extra = {}, { dataDir, expectReady = true } = {}) {
  dataDir ??= await mkdtemp(path.join(tmpdir(), 'piw-ksub-'));
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
  return { status: res.status, body: text ? JSON.parse(text) : null, text };
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
        // After the body is consumed, aborting the client closes the socket
        // without a request `close` event.
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

test('kernel off keeps the subagent messages path unknown', { timeout: 30000 }, async () => {
  const srv = await startServer({ PI_WORK_LLM: 'faux', PI_WORK_FAUX_TEXT: 'still-orchestrator' });
  try {
    const missing = await request(srv.base, 'GET', '/api/conversations/none/agents/none/messages');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error, 'not found');
    const ws = await request(srv.base, 'POST', '/api/workspaces', { name: 'off' });
    assert.equal(ws.status, 201);
    const conv = await request(srv.base, 'POST', `/api/workspaces/${ws.body.id}/conversations`, { title: 'off' });
    assert.equal(conv.status, 201);
    const sent = await request(srv.base, 'POST', `/api/conversations/${conv.body.id}/messages`, { text: 'hi' });
    assert.equal(sent.status, 202);
    const done = await waitFor(srv.base, conv.body.id, (body) => assistantTexts(body).includes('still-orchestrator'));
    assert.equal(done.status, 'done');
    assert.equal(subagentsOf(done).length, 0);
  } finally {
    await stopProcess(srv.proc);
    await rm(srv.dataDir, { recursive: true, force: true });
  }
});

test('foreground delegate uses the child model, tool whitelist, and skills', { timeout: 60000 }, async () => {
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
      PI_WORK_KERNEL: 'durable',
      PI_WORK_LLM: 'faux',
      PI_WORK_FAUX_SCRIPT: script,
      PI_WORK_FAUX_RECORD: record,
    }, { dataDir });
    proc = srv.proc;
    await bindScout(srv.base, fake);
    const ws = await request(srv.base, 'POST', '/api/workspaces', { name: 'fg' });
    assert.equal(ws.status, 201);
    const conv = await request(srv.base, 'POST', `/api/workspaces/${ws.body.id}/conversations`, { title: 'fg' });
    assert.equal(conv.status, 201);
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
    const roster = parentLines[0].sections.find((section) => section.key === 'subagents');
    assert.match(roster?.value || '', /scout \(Scout\): when the tree needs reading/);
    assert.equal(parentLines[0].tools.includes('delegate'), true);
    const scout = subagentsOf(done).find((agent) => agent.roleId === 'scout');
    assert.ok(scout, JSON.stringify(done.agents));
    assert.equal(scout.name, 'Scout');
    assert.equal(scout.status, 'done');
    assert.match(scout.lastText, /CHILD_MODEL_OK/);
    const messages = await request(srv.base, 'GET', `/api/conversations/${conv.body.id}/agents/${encodeURIComponent(scout.id)}/messages`);
    assert.equal(messages.status, 200);
    assert.equal(messages.body.messages.filter((message) => message.role === 'user').length, 1);
    assert.match(messages.body.messages.find((message) => message.role === 'assistant')?.text || '', /CHILD_MODEL_OK/);
    const missing = await request(srv.base, 'GET', `/api/conversations/${conv.body.id}/agents/missing/messages`);
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error, 'agent not found');
    const events = await collectSse(srv.base, conv.body.id, {
      ready: (list) => list.some((ev) => ev.event === 'agent' && ev.data?.roleId === 'scout'),
    });
    const deltas = events.filter((ev) => ev.event === 'message.delta').map((ev) => ev.data?.text || '').join('');
    assert.equal(deltas.includes('CHILD_MODEL_OK'), false);
    const agentEvent = events.find((ev) => ev.event === 'agent' && ev.data?.roleId === 'scout' && ev.data?.lastText?.includes('CHILD_MODEL_OK'));
    assert.ok(agentEvent, JSON.stringify(events.filter((ev) => ev.event === 'agent')));
    console.log(`KERNEL_SUBAGENTS_FOREGROUND ${JSON.stringify({
      model: childHit.model,
      tools: childHit.tools,
      agent: { id: scout.id, status: scout.status, lastText: scout.lastText },
    })}`);
  } finally {
    if (proc) await stopProcess(proc);
    await fake.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('background spawn, send, wait, list, stop, and the concurrency cap', { timeout: 60000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-ksub-bg-'));
  const script = await writeScript(dataDir, 'parent.json', [
    { tool: 'subagent', args: { action: 'spawn', name: 'a', agent: 'scout', message: 'ping-a' } },
    { tool: 'subagent', args: { action: 'list' } },
    { tool: 'subagent', args: { action: 'wait', name: 'a' } },
    { tool: 'subagent', args: { action: 'send', name: 'a', message: 'ping-a-again' } },
    { tool: 'subagent', args: { action: 'wait', name: 'a' } },
    { tool: 'subagent', args: { action: 'stop', name: 'a' } },
    { text: 'bg-done' },
  ]);
  const fake = await startScoutModel({ text: 'SCOUT_PONG' });
  let proc = null;
  try {
    const srv = await startServer({
      PI_WORK_KERNEL: 'durable',
      PI_WORK_LLM: 'faux',
      PI_WORK_FAUX_SCRIPT: script,
    }, { dataDir });
    proc = srv.proc;
    await bindScout(srv.base, fake);
    const ws = await request(srv.base, 'POST', '/api/workspaces', { name: 'bg' });
    const conv = await request(srv.base, 'POST', `/api/workspaces/${ws.body.id}/conversations`, { title: 'bg' });
    assert.equal((await request(srv.base, 'POST', `/api/conversations/${conv.body.id}/messages`, { text: 'run background' })).status, 202);
    const done = await waitFor(srv.base, conv.body.id, (body) => toolTexts(body).some((text) => text.includes('Stopped a.')));
    assert.equal(done.status === 'done' || done.status === 'running', true, `${done?.status}\n${srv.logs()}`);
    const tools = toolTexts(done).join('\n');
    assert.match(tools, /Started a\./);
    assert.match(tools, /a: (working|idle) role=scout/);
    assert.match(tools, /SCOUT_PONG/);
    assert.match(tools, /Stopped a\./);
    assert.ok(fake.seen.filter((hit) => hit.path.endsWith('/chat/completions')).length >= 2);
    const scout = subagentsOf(done).find((agent) => agent.name === 'a');
    assert.ok(scout, JSON.stringify(done.agents));
    assert.equal(scout.roleId, 'scout');
    assert.equal(scout.status, 'stopped');
    const child = await request(srv.base, 'GET', `/api/conversations/${conv.body.id}/agents/${encodeURIComponent(scout.id)}/messages`);
    assert.equal(child.status, 200);
    assert.ok(child.body.messages.some((message) => message.role === 'user' && message.text === 'ping-a'));
    assert.ok(child.body.messages.some((message) => message.role === 'assistant' && message.text === 'SCOUT_PONG'));
    console.log(`KERNEL_SUBAGENTS_BACKGROUND ${JSON.stringify({ tools: toolTexts(done), status: scout.status })}`);
  } finally {
    if (proc) await stopProcess(proc);
    await fake.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('a second background spawn is refused when the cap is 1', { timeout: 60000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-ksub-cap-'));
  const script = await writeScript(dataDir, 'parent.json', [
    { tool: 'subagent', args: { action: 'spawn', name: 'a', agent: 'scout', message: 'one' } },
    { tool: 'subagent', args: { action: 'spawn', name: 'b', agent: 'scout', message: 'two' } },
    { text: 'cap-done' },
  ]);
  const fake = await startScoutModel({ text: 'ONE' });
  let proc = null;
  try {
    const srv = await startServer({
      PI_WORK_KERNEL: 'durable',
      PI_WORK_LLM: 'faux',
      PI_WORK_FAUX_SCRIPT: script,
      PI_WORK_MAX_SUBAGENTS: '1',
    }, { dataDir });
    proc = srv.proc;
    await bindScout(srv.base, fake);
    const ws = await request(srv.base, 'POST', '/api/workspaces', { name: 'cap' });
    const conv = await request(srv.base, 'POST', `/api/workspaces/${ws.body.id}/conversations`, { title: 'cap' });
    assert.equal((await request(srv.base, 'POST', `/api/conversations/${conv.body.id}/messages`, { text: 'two spawns' })).status, 202);
    const done = await waitFor(srv.base, conv.body.id, (body) => toolTexts(body).some((text) => text.includes('limit 1')));
    const tools = toolTexts(done).join('\n');
    assert.match(tools, /Started a\./);
    assert.match(tools, /limit 1/);
    assert.equal(tools.includes('Started b.'), false, tools);
    assert.equal(subagentsOf(done).some((agent) => agent.name === 'b'), false);
    console.log(`KERNEL_SUBAGENTS_LIMIT ${JSON.stringify(toolTexts(done))}`);
  } finally {
    if (proc) await stopProcess(proc);
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
      PI_WORK_KERNEL: 'durable',
      PI_WORK_LLM: 'faux',
      PI_WORK_FAUX_SCRIPT: script,
    }, { dataDir });
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
      return body.status === 'stopped' && sleeper?.status === 'stopped';
    });
    assert.equal(after.status, 'stopped', JSON.stringify(after.agents));
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
    console.log(`KERNEL_SUBAGENTS_STOP ${JSON.stringify({ status: after.status, agent: child.status, closed: fake.closed() })}`);
  } finally {
    if (proc) await stopProcess(proc);
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
    PI_WORK_KERNEL: 'durable',
    PI_WORK_LLM: 'faux',
    PI_WORK_FAUX_SCRIPT: script,
  };
  let proc = null;
  try {
    const first = await startServer(env, { dataDir });
    proc = first.proc;
    await bindScout(first.base, fake);
    const ws = await request(first.base, 'POST', '/api/workspaces', { name: 'recover' });
    const conv = await request(first.base, 'POST', `/api/workspaces/${ws.body.id}/conversations`, { title: 'recover' });
    assert.equal((await request(first.base, 'POST', `/api/conversations/${conv.body.id}/messages`, { text: 'delegate' })).status, 202);
    await waitForFile(ready);
    const death = await killed(proc);
    proc = null;
    assert.ok(death.signal === 'SIGKILL' || death.code !== 0 || process.platform === 'win32');
    const second = await startServer(env, { dataDir });
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
    console.log(`KERNEL_SUBAGENTS_RECOVER_FG ${JSON.stringify({ users: users.length, assistants: assistants.length, calls })}`);
  } finally {
    if (proc) await stopProcess(proc);
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
    PI_WORK_KERNEL: 'durable',
    PI_WORK_LLM: 'faux',
    PI_WORK_FAUX_SCRIPT: script,
  };
  let proc = null;
  try {
    const first = await startServer(env, { dataDir });
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
    const second = await startServer(env, { dataDir });
    proc = second.proc;
    await writeFile(release, 'go');
    const reported = await waitFor(second.base, conv.body.id, (body) => (
      (body.messages || []).filter((message) => String(message.text || '').includes('BG_ANSWER')).length === 1
      && (body.status === 'done' || body.status === 'idle')
    ), 100);
    const reports = (reported.messages || []).filter((message) => String(message.text || '').includes('BG_ANSWER'));
    assert.equal(reports.length, 1, `${second.logs()}\n${JSON.stringify(reported?.messages)}`);
    assert.match(reports[0].text, /\[subagent bg answered, no reply needed] BG_ANSWER/);
    await stopProcess(proc);
    proc = null;
    const third = await startServer(env, { dataDir });
    proc = third.proc;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const again = await request(third.base, 'GET', `/api/conversations/${conv.body.id}`);
    const againReports = (again.body.messages || []).filter((message) => String(message.text || '').includes('BG_ANSWER'));
    assert.equal(againReports.length, 1, JSON.stringify(again.body.messages));
    console.log(`KERNEL_SUBAGENTS_RECOVER_BG ${JSON.stringify({ reports: againReports.length })}`);
  } finally {
    if (proc) await stopProcess(proc);
    await fake.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
