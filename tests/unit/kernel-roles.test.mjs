import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { parseSSE } from '../../src/core/sse.mjs';
import { handoffInput } from '../../src/kernel/roles.mjs';
import { ROOT } from './_root.mjs';

const TOKEN = 'unit-kernel-roles-token';
const STRIP = [
  'PI_WORK_LLM',
  'PI_WORK_FAUX_SCRIPT',
  'PI_WORK_FAUX_TEXT',
  'PI_WORK_FAUX_PLAN',
  'PI_WORK_FAUX_RECORD',
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
  dataDir ??= await mkdtemp(path.join(tmpdir(), 'piw-krole-'));
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

async function collectSse(base, cid, { ready, quietMs = 300, timeout = 12000 } = {}) {
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

async function waitFor(base, cid, ready, attempts = 50) {
  let body = null;
  for (let i = 0; i < attempts; i += 1) {
    const got = await request(base, 'GET', `/api/conversations/${cid}`);
    body = got.body;
    if (ready(body)) return body;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return body;
}

function submissionRows(dataDir) {
  const db = new DatabaseSync(path.join(dataDir, 'harness', 'session.sqlite'), { readOnly: true });
  try {
    return db.prepare('SELECT status, record FROM submissions').all().map((row) => ({
      status: row.status,
      record: JSON.parse(row.record),
    }));
  } finally {
    db.close();
  }
}

function sectionText(snapshot, key) {
  return snapshot.sections.find((section) => section.key === key)?.value || '';
}

async function readRecords(file) {
  const text = await readFile(file, 'utf8');
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

const ALPHA = {
  id: 'alpha',
  name: 'Alpha',
  systemPrompt: 'OPEN PROMPT',
  tools: ['read', 'ls'],
  pluginTools: true,
};
const BETA = {
  id: 'beta',
  name: 'Beta',
  systemPrompt: 'SHUT PROMPT',
  tools: ['bash'],
  skills: [],
  pluginTools: false,
};

function projected(body) {
  return {
    pipelineStep: body.pipelineStep,
    agents: (body.agents || []).map((agent) => ({
      roleId: agent.roleId,
      name: agent.name,
      status: agent.status,
      step: agent.step,
      totalSteps: agent.totalSteps,
      toolCalls: agent.toolCalls,
      lastText: agent.lastText || '',
    })),
    handoffs: (body.messages || []).filter((msg) => msg.kind === 'handoff').map((msg) => ({
      role: msg.role,
      text: msg.text || '',
      kind: msg.kind,
      fromAgent: msg.fromAgent,
      toAgent: msg.toAgent,
    })),
  };
}

function agentTrace(events) {
  return events.filter((ev) => ev.event === 'agent').map((ev) => ({
    roleId: ev.data.roleId,
    name: ev.data.name,
    status: ev.data.status,
    step: ev.data.step,
    toolCalls: ev.data.toolCalls,
    lastText: ev.data.lastText || '',
  }));
}

test('handoff input uses the previous assistant text only for previous', () => {
  const previous = handoffInput({ input: 'previous' }, { originalText: 'ship it', previousText: 'plan-done' });
  const original = handoffInput({ input: 'user' }, { originalText: 'ship it', previousText: 'plan-done' });
  const omitted = handoffInput({ role: 'beta' }, { originalText: 'ship it', previousText: 'plan-done' });
  assert.equal(previous, 'plan-done');
  assert.equal(original, 'ship it');
  assert.equal(omitted, 'ship it');
});

test('kernel path: switching role changes the system prompt, skills, and tool list', { timeout: 30000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-krole-'));
  const record = path.join(dataDir, 'requests.jsonl');
  const srv = await startServer({
    PI_WORK_KERNEL: 'durable',
    PI_WORK_LLM: 'faux',
    PI_WORK_FAUX_TEXT: 'noted',
    PI_WORK_FAUX_RECORD: record,
  }, { dataDir });
  try {
    const ws = await request(srv.base, 'POST', '/api/workspaces', { name: 'roles' });
    assert.equal(ws.status, 201);
    const alpha = await request(srv.base, 'POST', '/api/roles', ALPHA);
    const beta = await request(srv.base, 'POST', '/api/roles', BETA);
    assert.equal(alpha.status, 201);
    assert.equal(beta.status, 201);
    const conv = await request(srv.base, 'POST', `/api/workspaces/${ws.body.id}/conversations`, { title: 'roles' });
    assert.equal(conv.status, 201);
    const opened = await request(srv.base, 'PATCH', `/api/conversations/${conv.body.id}`, { roleId: 'alpha' });
    assert.equal(opened.status, 200);
    assert.equal(opened.body.roleId, 'alpha');
    assert.equal(opened.body.pipelineId, null);
    const sent = await request(srv.base, 'POST', `/api/conversations/${conv.body.id}/messages`, { text: 'first' });
    assert.equal(sent.status, 202);
    const first = await waitFor(srv.base, conv.body.id, (body) => body.status === 'done');
    assert.equal(first.status, 'done', srv.logs());
    const [openCall] = await readRecords(record);
    assert.match(sectionText(openCall, 'instructions'), /OPEN PROMPT/);
    assert.match(sectionText(openCall, 'skills'), /Lead with findings/);
    assert.deepEqual(openCall.tools, ['read', 'ls', 'echo', 'delegate', 'subagent']);

    const shut = await request(srv.base, 'PATCH', `/api/conversations/${conv.body.id}`, { roleId: 'beta' });
    assert.equal(shut.status, 200);
    assert.equal(shut.body.roleId, 'beta');
    const sentAgain = await request(srv.base, 'POST', `/api/conversations/${conv.body.id}/messages`, { text: 'second' });
    assert.equal(sentAgain.status, 202);
    const second = await waitFor(srv.base, conv.body.id, (body) => (
      body.messages?.filter((msg) => msg.role === 'assistant').length >= 2 && body.status === 'done'
    ));
    assert.equal(second.status, 'done', srv.logs());
    const calls = await readRecords(record);
    const shutCall = calls[calls.length - 1];
    assert.match(sectionText(shutCall, 'instructions'), /SHUT PROMPT/);
    assert.equal(shutCall.sections.some((item) => item.key === 'skills'), false);
    assert.deepEqual(shutCall.tools, ['bash', 'delegate', 'subagent']);
    const cleared = await request(srv.base, 'PATCH', `/api/conversations/${conv.body.id}`, { roleId: null });
    assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
    assert.equal(cleared.body.roleId, null);
    assert.equal(cleared.body.pipelineId, null);
    assert.equal(cleared.body.pipelineStep, 0);
  } finally {
    await stopProcess(srv.proc);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('kernel path: a two-step pipeline matches the legacy handoff', { timeout: 40000 }, async () => {
  const previousSteps = [
    { role: 'alpha', input: 'user' },
    { role: 'beta', input: 'previous' },
  ];
  const originalSteps = [
    { role: 'alpha', input: 'user' },
    { role: 'beta', input: 'user' },
  ];
  const agents = [
    { roleId: 'alpha', name: 'Alpha', status: 'done', step: 1, totalSteps: 1, toolCalls: 0, lastText: 'plan-done' },
    { roleId: 'beta', name: 'Beta', status: 'done', step: 1, totalSteps: 1, toolCalls: 0, lastText: 'tests-pass' },
  ];
  const trace = [
    { roleId: 'alpha', name: 'Alpha', status: 'running', step: 0, toolCalls: undefined, lastText: '' },
    { roleId: 'alpha', name: 'Alpha', status: 'done', step: 1, toolCalls: undefined, lastText: 'plan-done' },
    { roleId: 'beta', name: 'Beta', status: 'running', step: 0, toolCalls: undefined, lastText: '' },
    { roleId: 'beta', name: 'Beta', status: 'done', step: 1, toolCalls: undefined, lastText: 'tests-pass' },
  ];
  const previousExpected = {
    pipelineStep: 1,
    agents,
    handoffs: [{ role: 'user', text: 'plan-done', kind: 'handoff', fromAgent: 'alpha', toAgent: 'beta' }],
  };
  const originalExpected = {
    pipelineStep: 1,
    agents,
    handoffs: [{ role: 'user', text: 'ship it', kind: 'handoff', fromAgent: 'alpha', toAgent: 'beta' }],
  };

  const srv = await startServer({
    PI_WORK_KERNEL: 'durable',
    PI_WORK_LLM: 'faux',
    PI_WORK_FAUX_PLAN: JSON.stringify(['plan-done', 'tests-pass', 'plan-done', 'tests-pass']),
  });
  try {
    const ws = await request(srv.base, 'POST', '/api/workspaces', { name: 'pipe' });
    assert.equal((await request(srv.base, 'POST', '/api/roles', ALPHA)).status, 201);
    assert.equal((await request(srv.base, 'POST', '/api/roles', BETA)).status, 201);
    assert.equal((await request(srv.base, 'POST', '/api/pipelines', {
      id: 'handoff',
      name: 'Handoff',
      steps: previousSteps,
    })).status, 201);
    assert.equal((await request(srv.base, 'POST', '/api/pipelines', {
      id: 'original',
      name: 'Original',
      steps: originalSteps,
    })).status, 201);

    const previous = await request(srv.base, 'POST', `/api/workspaces/${ws.body.id}/conversations`, {
      title: 'previous',
      pipelineId: 'handoff',
    });
    assert.equal(previous.status, 201);
    assert.equal((await request(srv.base, 'POST', `/api/conversations/${previous.body.id}/messages`, { text: 'ship it' })).status, 202);
    const previousBody = await waitFor(srv.base, previous.body.id, (body) => (
      body.status === 'done' && body.messages?.some((msg) => msg.text === 'tests-pass')
    ));
    assert.equal(previousBody.status, 'done', srv.logs());
    assert.deepEqual(projected(previousBody), previousExpected);
    assert.match(previousBody.messages.find((msg) => msg.kind === 'handoff').id, /:u:p1$/);
    const previousEvents = await collectSse(srv.base, previous.body.id, {
      ready: (list) => list.some((ev) => ev.event === 'status' && ev.data?.status === 'done'),
    });
    assert.deepEqual(agentTrace(previousEvents), trace);

    const original = await request(srv.base, 'POST', `/api/workspaces/${ws.body.id}/conversations`, {
      title: 'original',
      pipelineId: 'original',
    });
    assert.equal((await request(srv.base, 'POST', `/api/conversations/${original.body.id}/messages`, { text: 'ship it' })).status, 202);
    const originalBody = await waitFor(srv.base, original.body.id, (body) => (
      body.status === 'done' && body.messages?.some((msg) => msg.text === 'tests-pass')
    ));
    assert.equal(originalBody.status, 'done', srv.logs());
    assert.deepEqual(projected(originalBody), originalExpected);
    const originalEvents = await collectSse(srv.base, original.body.id, {
      ready: (list) => list.some((ev) => ev.event === 'status' && ev.data?.status === 'done'),
    });
    assert.deepEqual(agentTrace(originalEvents), trace);
  } finally {
    await stopProcess(srv.proc);
    await rm(srv.dataDir, { recursive: true, force: true });
  }
});

test('kernel path: PATCH while busy is 409 err_role_busy', { timeout: 30000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-krole-busy-'));
  const ready = path.join(dataDir, 'hold-ready');
  const srv = await startServer({
    PI_WORK_KERNEL: 'durable',
    PI_WORK_LLM: 'faux',
    PI_WORK_FAUX_HOLD: '1',
    PI_WORK_FAUX_HOLD_READY: ready,
  }, { dataDir });
  try {
    const ws = await request(srv.base, 'POST', '/api/workspaces', { name: 'busy' });
    const conv = await request(srv.base, 'POST', `/api/workspaces/${ws.body.id}/conversations`, { title: 'busy' });
    assert.equal((await request(srv.base, 'POST', `/api/conversations/${conv.body.id}/messages`, { text: 'wait' })).status, 202);
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
    const patched = await request(srv.base, 'PATCH', `/api/conversations/${conv.body.id}`, { roleId: 'coder' });
    assert.equal(patched.status, 409);
    assert.equal(patched.body.error, 'err_role_busy');
    assert.equal(patched.body.status, 'running');
  } finally {
    killChild(srv.proc);
    await new Promise((resolve) => srv.proc.once('exit', resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('kernel path: killing during a pipeline handoff resumes the next step once', { timeout: 60000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-krole-kill-'));
  const ready = path.join(dataDir, 'hold-ready');
  const first = await startServer({
    PI_WORK_KERNEL: 'durable',
    PI_WORK_LLM: 'faux',
    PI_WORK_FAUX_PLAN: JSON.stringify(['plan-done', 'hold']),
    PI_WORK_FAUX_HOLD_READY: ready,
  }, { dataDir });
  let convId;
  try {
    const ws = await request(first.base, 'POST', '/api/workspaces', { name: 'kill' });
    assert.equal((await request(first.base, 'POST', '/api/roles', ALPHA)).status, 201);
    assert.equal((await request(first.base, 'POST', '/api/roles', BETA)).status, 201);
    assert.equal((await request(first.base, 'POST', '/api/pipelines', {
      id: 'handoff',
      name: 'Handoff',
      steps: [
        { role: 'alpha', input: 'user' },
        { role: 'beta', input: 'previous' },
      ],
    })).status, 201);
    const conv = await request(first.base, 'POST', `/api/workspaces/${ws.body.id}/conversations`, {
      title: 'kill',
      pipelineId: 'handoff',
    });
    convId = conv.body.id;
    assert.equal((await request(first.base, 'POST', `/api/conversations/${convId}/messages`, { text: 'ship it' })).status, 202);
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
    const blocked = await request(first.base, 'PATCH', `/api/conversations/${convId}`, { roleId: 'alpha' });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error, 'err_role_busy');
  } finally {
    killChild(first.proc);
    await new Promise((resolve) => first.proc.once('exit', resolve));
  }

  const second = await startServer({
    PI_WORK_KERNEL: 'durable',
    PI_WORK_LLM: 'faux',
    PI_WORK_FAUX_PLAN: JSON.stringify(['tests-pass']),
  }, { dataDir });
  try {
    const body = await waitFor(second.base, convId, (got) => (
      got.status === 'done' && got.messages?.some((msg) => msg.text === 'tests-pass')
    ), 40);
    assert.equal(body.status, 'done', second.logs());
    assert.equal(body.pipelineStep, 1);
    assert.equal(body.messages.filter((msg) => msg.role === 'user' && msg.text === 'ship it' && msg.kind !== 'handoff').length, 1);
    assert.equal(body.messages.filter((msg) => msg.kind === 'handoff' && msg.text === 'plan-done' && msg.fromAgent === 'alpha' && msg.toAgent === 'beta').length, 1);
    assert.equal(body.messages.filter((msg) => msg.role === 'assistant' && msg.text === 'plan-done').length, 1);
    assert.equal(body.messages.filter((msg) => msg.role === 'assistant' && msg.text === 'tests-pass').length, 1);
    const events = await collectSse(second.base, convId, {
      ready: (list) => list.some((ev) => ev.event === 'status' && ev.data?.status === 'done'),
    });
    const statuses = events.filter((ev) => ev.event === 'status').map((ev) => ev.data.status);
    assert.equal(statuses.includes('recovering'), true);
  } finally {
    await stopProcess(second.proc);
  }

  try {
    const rows = submissionRows(dataDir);
    const inputs = rows.filter((row) => row.record.type === 'input');
    assert.equal(inputs.length, 2, JSON.stringify(rows));
    assert.equal(inputs.filter((row) => row.record.requestId === `pipeline:${convId}:step:1`).length, 1);
    assert.equal(inputs.every((row) => row.status === 'done'), true);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
