import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSSE } from '../../src/core/sse.mjs';
import {
  alignRetryMessage,
  applyStallClaim,
  blankControl,
  correctionText,
  decideToolCall,
  projectTranscript,
  wantsRetry,
} from '../../src/kernel/control.mjs';
import { ROOT } from './_root.mjs';

const TOKEN = 'unit-kernel-control-token';
const STRIP = [
  'PI_WORK_LLM',
  'PI_WORK_FAUX_SCRIPT',
  'PI_WORK_FAUX_TEXT',
  'PI_WORK_FAUX_PLAN',
  'PI_WORK_FAUX_RECORD',
  'PI_WORK_FAUX_HOLD',
  'PI_WORK_FAUX_HOLD_READY',
  'PI_WORK_FAUX_TOOL_LOG',
  'PI_WORK_KERNEL',
  'LLM_API',
  'LLM_API_KEY',
  'LLM_BASE_URL',
  'LLM_MODEL',
  'PI_WORK_GROK_AUTH',
  'GROK_HOME',
  'PI_WORK_STALL_MS',
  'PI_WORK_MAX_AUTO_CONTINUES',
  'PI_WORK_MAX_TOOL_CALLS',
  'PI_WORK_TOOL_LOOP',
  'PI_WORK_TOOL_NUDGE',
  'PI_WORK_EXPLORE_REPEAT',
  'PI_WORK_RETRY_MAX',
  'PI_WORK_RETRY_BASE_MS',
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
    PI_WORK_MAX_AUTO_CONTINUES: '10',
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

async function startServer(extra = {}, { dataDir } = {}) {
  dataDir ??= await mkdtemp(path.join(tmpdir(), 'piw-kctl-'));
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

async function collectSse(base, cid, { ready, quietMs = 300, timeout = 20000 } = {}) {
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

async function openConversation(base, { title = 'kernel', pipelineId, roleId, name = 'kernel-ws' } = {}) {
  const ws = await request(base, 'POST', '/api/workspaces', { name });
  assert.equal(ws.status, 201, JSON.stringify(ws.body));
  const body = { title };
  if (pipelineId) body.pipelineId = pipelineId;
  if (roleId) body.roleId = roleId;
  const conv = await request(base, 'POST', `/api/workspaces/${ws.body.id}/conversations`, body);
  assert.equal(conv.status, 201, JSON.stringify(conv.body));
  return { ws: ws.body, conv: conv.body };
}

async function waitFor(base, id, pred, timeoutMs = 20000) {
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

function nodeScript(name) {
  return `"${process.execPath}" ${name}`;
}

async function writeScript(dataDir, name, turns) {
  const file = path.join(dataDir, name);
  await writeFile(file, JSON.stringify({ turns }));
  return file;
}

async function exists(file) {
  try {
    await readFile(file);
    return true;
  } catch {
    return false;
  }
}

const LIMITS = { toolCap: 15, loopLimit: 3, nudgeAfter: 8, exploreLimit: 2 };

test('stall claim waits, continues once, then gives up at the cap', () => {
  const quiet = blankControl();
  quiet.lastProgressAt = 1_000;
  const early = applyStallClaim(quiet, {
    now: 1_100, stallMs: 500, status: 'running', maxAutoContinues: 2, progressAt: 0,
  });
  assert.equal(early.decision, 'wait');
  assert.equal(quiet.autoContinues, 0);

  const idle = applyStallClaim({ ...quiet }, {
    now: 2_000, stallMs: 500, status: 'paused', maxAutoContinues: 2, progressAt: 0,
  });
  assert.equal(idle.decision, 'wait');

  const first = blankControl();
  first.lastProgressAt = 1_000;
  const cont = applyStallClaim(first, {
    now: 1_600, stallMs: 500, status: 'running', maxAutoContinues: 1, progressAt: 0,
  });
  assert.equal(cont.decision, 'continue');
  assert.equal(first.autoContinues, 1);

  const again = applyStallClaim(first, {
    now: 3_000, stallMs: 500, status: 'running', maxAutoContinues: 1, progressAt: 0,
  });
  assert.equal(again.decision, 'give_up');
  assert.equal(first.gaveUp, true);
});

test('tool decisions match the orchestrator notes, in cap then loop then explore then nudge order', () => {
  const doc = blankControl();
  doc.toolCallsThisStep = 15;
  assert.match(decideToolCall(doc, { name: 'read', arguments: { path: 'a' } }, LIMITS).text, /已达上限（15）/);

  const loop = blankControl();
  loop.toolSig = 'ls\u0000{}';
  loop.toolSigCount = 3;
  const corrected = decideToolCall(loop, { name: 'ls', arguments: {} }, LIMITS);
  assert.equal(corrected.kind, 'correct');
  assert.match(corrected.text, /停止调用工具/);
  loop.loopCorrectedSig = corrected.sig;
  assert.match(decideToolCall(loop, { name: 'ls', arguments: {} }, LIMITS).text, /仍在用相同参数重复调用/);

  const explore = blankControl();
  explore.exploreCounts = { 'grep\u0000src': 2 };
  const again = decideToolCall(explore, { name: 'grep', arguments: { pattern: 'x', path: 'src' } }, LIMITS);
  assert.match(again.text, /不要再重复查看/);
  explore.exploreCorrected = { 'grep\u0000src': true };
  assert.match(decideToolCall(explore, { name: 'grep', arguments: { pattern: 'y', path: './src/' } }, LIMITS).text, /仍在重复查看/);

  const nudge = blankControl();
  nudge.toolCallsThisStep = 8;
  assert.match(decideToolCall(nudge, { name: 'read', arguments: { path: 'z' } }, LIMITS).text, /请根据已有结果直接回答/);
});

test('retry alignment keeps terminated and blocks 401 even when the text says timeout', () => {
  const terminated = { stopReason: 'error', errorMessage: 'terminated' };
  alignRetryMessage(terminated);
  assert.equal(terminated.errorMessage, 'terminated');
  assert.equal(wantsRetry(terminated), true);

  const reset = { stopReason: 'error', errorMessage: 'ECONNRESET' };
  alignRetryMessage(reset);
  assert.match(reset.errorMessage, /timeout/);
  assert.equal(wantsRetry({ stopReason: 'error', errorMessage: 'ECONNRESET' }), true);

  const denied = { stopReason: 'error', errorMessage: '401 unauthorized timeout' };
  alignRetryMessage(denied);
  assert.equal(denied.errorMessage, 'blocked retry');
  assert.equal(wantsRetry(denied), false);

  const blocked = correctionText('<harness>\n[error] Tool call blocked: 停止调用工具。\n</harness>');
  assert.equal(blocked, '停止调用工具。');
  const projected = projectTranscript([
    {
      id: 't1',
      kind: 'pi.tool-result',
      model: [{
        toolCallId: 'c1',
        toolName: 'read',
        isError: false,
        content: [],
        details: { piWorkControl: 'finish', text: '本步工具调用已达上限（15），已停止继续调用工具。' },
      }],
    },
    {
      id: 't2',
      kind: 'pi.tool-result',
      model: [{
        toolCallId: 'c2',
        toolName: 'ls',
        isError: true,
        content: [{ type: 'text', text: '<harness>\n[error] Tool call blocked: 停止调用工具。\n</harness>' }],
      }],
    },
  ]);
  assert.equal(projected.messages.some((message) => message.role === 'tool'), false);
  assert.equal(projected.messages[0].kind, 'correction');
});

test('pause lets the in-progress write finish and resume runs the next step', { timeout: 40_000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-kpause-'));
  const script = await writeScript(dataDir, 'pause.json', [
    { tool: 'bash', args: { command: nodeScript('slow-write.cjs') } },
    { tool: 'bash', args: { command: nodeScript('next-write.cjs') } },
    { text: 'paused-done' },
  ]);
  const srv = await startServer({
    PI_WORK_KERNEL: 'durable',
    PI_WORK_LLM: 'faux',
    PI_WORK_FAUX_SCRIPT: script,
  }, { dataDir });
  try {
    const first = await openConversation(srv.base, { title: 'pause', name: 'pause-a' });
    const second = await openConversation(srv.base, { title: 'other', name: 'pause-b' });
    await writeFile(path.join(first.ws.path, 'slow-write.cjs'), "setTimeout(() => { require('fs').writeFileSync('slow.txt', 'ok'); }, 900);\n");
    await writeFile(path.join(first.ws.path, 'next-write.cjs'), "require('fs').writeFileSync('next.txt', 'ok');\n");
    await writeFile(path.join(second.ws.path, 'slow-write.cjs'), "setTimeout(() => { require('fs').writeFileSync('slow.txt', 'ok'); }, 200);\n");
    await writeFile(path.join(second.ws.path, 'next-write.cjs'), "require('fs').writeFileSync('next.txt', 'ok');\n");
    const started = collectSse(srv.base, first.conv.id, {
      ready: (events) => events.some((ev) => ev.event === 'tool.start'),
      quietMs: 30,
      timeout: 15000,
    });
    assert.equal((await request(srv.base, 'POST', `/api/conversations/${first.conv.id}/messages`, { text: 'go' })).status, 202);
    await started;
    const paused = await request(srv.base, 'POST', `/api/conversations/${first.conv.id}/pause`, {});
    assert.equal(paused.status, 200, srv.logs());
    assert.equal(paused.body.status, 'paused');
    assert.equal((await request(srv.base, 'POST', `/api/conversations/${second.conv.id}/messages`, { text: 'go' })).status, 202);
    const other = await waitFor(srv.base, second.conv.id, (body) => body.status === 'done');
    assert.equal(other.status, 'done', srv.logs());
    const slowFile = path.join(first.ws.path, 'slow.txt');
    const slowUntil = Date.now() + 8000;
    while (!(await exists(slowFile)) && Date.now() < slowUntil) {
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    assert.equal(await exists(slowFile), true, srv.logs());
    assert.equal(await exists(path.join(first.ws.path, 'next.txt')), false);
    const held = await request(srv.base, 'GET', `/api/conversations/${first.conv.id}`);
    assert.equal(held.body.status, 'paused', srv.logs());
    await new Promise((resolve) => setTimeout(resolve, 400));
    const resumed = await request(srv.base, 'POST', `/api/conversations/${first.conv.id}/resume`, {});
    assert.equal(resumed.body.status, 'running');
    const done = await waitFor(srv.base, first.conv.id, (body) => body.status === 'done' && body.messages?.some((message) => message.text === 'paused-done'));
    assert.equal(await readFile(path.join(first.ws.path, 'next.txt'), 'utf8'), 'ok');
    assert.equal(done.messages.some((message) => message.text === 'paused-done'), true);
  } finally {
    await stopProcess(srv.proc);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('stop is terminal, resume stays stopped, and a later message can run', { timeout: 40_000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-kstop-'));
  const script = await writeScript(dataDir, 'stop.json', [
    { tool: 'bash', args: { command: nodeScript('stop-write.cjs') } },
    { text: 'after-stop' },
  ]);
  const srv = await startServer({
    PI_WORK_KERNEL: 'durable',
    PI_WORK_LLM: 'faux',
    PI_WORK_FAUX_SCRIPT: script,
  }, { dataDir });
  try {
    const { ws, conv } = await openConversation(srv.base, { title: 'stop' });
    await writeFile(path.join(ws.path, 'stop-write.cjs'), "setTimeout(() => { require('fs').writeFileSync('stop.txt', 'no'); }, 3000);\n");
    const started = collectSse(srv.base, conv.id, {
      ready: (events) => events.some((ev) => ev.event === 'tool.start'),
      quietMs: 30,
      timeout: 15000,
    });
    assert.equal((await request(srv.base, 'POST', `/api/conversations/${conv.id}/messages`, { text: 'go' })).status, 202);
    await started;
    const stopped = await request(srv.base, 'POST', `/api/conversations/${conv.id}/stop`, {});
    assert.equal(stopped.body.status, 'stopped', srv.logs());
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(await exists(path.join(ws.path, 'stop.txt')), false);
    const again = await request(srv.base, 'POST', `/api/conversations/${conv.id}/resume`, {});
    assert.equal(again.body.status, 'stopped');
    const sent = await request(srv.base, 'POST', `/api/conversations/${conv.id}/messages`, { text: 'again' });
    assert.equal(sent.status, 202, JSON.stringify(sent.body));
    const done = await waitFor(srv.base, conv.id, (body) => body.status === 'done');
    assert.equal(done.status, 'done', srv.logs());
    assert.notEqual(done.status, 'stopped');
  } finally {
    await stopProcess(srv.proc);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('a quiet model call submits 继续 and counts it as an auto-continue', { timeout: 30_000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-kstall-'));
  const script = await writeScript(dataDir, 'stall.json', [
    { delayMs: 450, text: 'first' },
    { text: 'second' },
  ]);
  const srv = await startServer({
    PI_WORK_KERNEL: 'durable',
    PI_WORK_LLM: 'faux',
    PI_WORK_FAUX_SCRIPT: script,
    PI_WORK_FAUX_DELAY_TICK: '0',
    PI_WORK_STALL_MS: '300',
  }, { dataDir });
  try {
    const { conv } = await openConversation(srv.base, { title: 'stall' });
    const eventsPromise = collectSse(srv.base, conv.id, {
      ready: (events) => events.some((ev) => ev.event === 'retry' && ev.data?.reason === 'stall')
        && events.some((ev) => ev.event === 'status' && ev.data?.status === 'done'),
      timeout: 15000,
    });
    assert.equal((await request(srv.base, 'POST', `/api/conversations/${conv.id}/messages`, { text: 'go' })).status, 202);
    const events = await eventsPromise;
    const done = await waitFor(srv.base, conv.id, (body) => body.status === 'done' && body.messages?.some((message) => message.text === 'second'));
    const stall = events.find((ev) => ev.event === 'retry' && ev.data?.reason === 'stall');
    assert.equal(stall.data.delayMs, 0);
    assert.equal(typeof stall.data.attempt, 'number');
    assert.ok(done.autoContinues >= 1, JSON.stringify(done));
    assert.equal(done.messages.some((message) => message.text === 'first'), true);
    assert.equal(done.messages.some((message) => message.text === 'second'), true);
  } finally {
    await stopProcess(srv.proc);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('stall past the auto-continue cap fails with E_STALL', { timeout: 20_000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-kgive-'));
  const srv = await startServer({
    PI_WORK_KERNEL: 'durable',
    PI_WORK_LLM: 'faux',
    PI_WORK_FAUX_HOLD: '1',
    PI_WORK_STALL_MS: '120',
    PI_WORK_MAX_AUTO_CONTINUES: '1',
  }, { dataDir });
  try {
    const { conv } = await openConversation(srv.base, { title: 'give-up' });
    const eventsPromise = collectSse(srv.base, conv.id, {
      ready: (events) => events.some((ev) => ev.event === 'error' && ev.data?.code === 'E_STALL'),
      timeout: 10000,
    });
    assert.equal((await request(srv.base, 'POST', `/api/conversations/${conv.id}/messages`, { text: 'go' })).status, 202);
    const events = await eventsPromise;
    const body = await waitFor(srv.base, conv.id, (row) => row.status === 'failed');
    assert.equal(body.status, 'failed', srv.logs());
    assert.equal(events.some((ev) => ev.event === 'error' && ev.data?.code === 'E_STALL' && ev.data?.message === 'stalled'), true);
  } finally {
    await stopProcess(srv.proc);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('a terminated generation retries with attempt, delay, and reason', { timeout: 30_000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-kretry-'));
  const script = await writeScript(dataDir, 'retry.json', [
    { error: 'terminated' },
    { text: 'final' },
  ]);
  const srv = await startServer({
    PI_WORK_KERNEL: 'durable',
    PI_WORK_LLM: 'faux',
    PI_WORK_FAUX_SCRIPT: script,
    PI_WORK_RETRY_BASE_MS: '20',
  }, { dataDir });
  try {
    const { conv } = await openConversation(srv.base, { title: 'retry' });
    const eventsPromise = collectSse(srv.base, conv.id, {
      ready: (events) => events.some((ev) => ev.event === 'status' && ev.data?.status === 'done'),
      timeout: 15000,
    });
    assert.equal((await request(srv.base, 'POST', `/api/conversations/${conv.id}/messages`, { text: 'go' })).status, 202);
    const events = await eventsPromise;
    const retry = events.find((ev) => ev.event === 'retry');
    assert.ok(retry, JSON.stringify(events));
    assert.equal(retry.data.attempt, 1);
    assert.equal(retry.data.delayMs, 20);
    assert.match(String(retry.data.reason), /terminated/);
    const done = await waitFor(srv.base, conv.id, (body) => body.status === 'done');
    assert.ok(done.autoContinues >= 1);
    assert.equal(done.messages.some((message) => message.text === 'final'), true);
  } finally {
    await stopProcess(srv.proc);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('401 and a sandbox tool error are not retried', { timeout: 30_000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-knoretry-'));
  const deniedScript = await writeScript(dataDir, 'denied.json', [
    { error: '401 unauthorized' },
    { text: 'should-not-appear' },
  ]);
  const denied = await startServer({
    PI_WORK_KERNEL: 'durable',
    PI_WORK_LLM: 'faux',
    PI_WORK_FAUX_SCRIPT: deniedScript,
  }, { dataDir });
  try {
    const { conv } = await openConversation(denied.base, { title: 'denied' });
    const eventsPromise = collectSse(denied.base, conv.id, {
      ready: (events) => events.some((ev) => ev.event === 'status' && ev.data?.status === 'failed'),
      timeout: 15000,
    });
    assert.equal((await request(denied.base, 'POST', `/api/conversations/${conv.id}/messages`, { text: 'go' })).status, 202);
    const events = await eventsPromise;
    assert.equal(events.some((ev) => ev.event === 'retry'), false, JSON.stringify(events));
    const body = await waitFor(denied.base, conv.id, (row) => row.status === 'failed');
    assert.equal(body.messages.some((message) => message.text === 'should-not-appear'), false);
  } finally {
    await stopProcess(denied.proc);
  }

  const sandScript = await writeScript(dataDir, 'sand.json', [
    { tool: 'read', args: { path: '../outside.txt' } },
    { text: 'after-sandbox' },
  ]);
  const sand = await startServer({
    PI_WORK_KERNEL: 'durable',
    PI_WORK_LLM: 'faux',
    PI_WORK_FAUX_SCRIPT: sandScript,
  }, { dataDir: await mkdtemp(path.join(tmpdir(), 'piw-ksandctl-')) });
  try {
    const { conv } = await openConversation(sand.base, { title: 'sand' });
    const eventsPromise = collectSse(sand.base, conv.id, {
      ready: (events) => events.some((ev) => ev.event === 'status' && ev.data?.status === 'done'),
      timeout: 15000,
    });
    assert.equal((await request(sand.base, 'POST', `/api/conversations/${conv.id}/messages`, { text: 'go' })).status, 202);
    const events = await eventsPromise;
    assert.equal(events.some((ev) => ev.event === 'retry'), false, JSON.stringify(events));
    const body = await waitFor(sand.base, conv.id, (row) => row.status === 'done');
    assert.equal(body.messages.some((message) => message.text === 'after-sandbox'), true, sand.logs());
    assert.equal(body.messages.some((message) => message.role === 'tool' && String(message.text).includes('E_SANDBOX')), true);
  } finally {
    await stopProcess(sand.proc);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('retries exhausted after a finished tool end the step with the stream note', { timeout: 30_000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-kcut-'));
  const script = await writeScript(dataDir, 'cut.json', [
    { tool: 'write', args: { path: 'kept.txt', content: 'kept' } },
    { error: 'terminated' },
    { error: 'terminated' },
  ]);
  const srv = await startServer({
    PI_WORK_KERNEL: 'durable',
    PI_WORK_LLM: 'faux',
    PI_WORK_FAUX_SCRIPT: script,
    PI_WORK_RETRY_MAX: '2',
    PI_WORK_RETRY_BASE_MS: '10',
  }, { dataDir });
  try {
    const { ws, conv } = await openConversation(srv.base, { title: 'cut' });
    assert.equal((await request(srv.base, 'POST', `/api/conversations/${conv.id}/messages`, { text: 'go' })).status, 202);
    const done = await waitFor(srv.base, conv.id, (body) => (
      body.status === 'done' && body.messages?.some((message) => String(message.text || '').includes('模型连接中断'))
    ));
    assert.equal(done.status, 'done', srv.logs());
    assert.equal(await readFile(path.join(ws.path, 'kept.txt'), 'utf8'), 'kept');
  } finally {
    await stopProcess(srv.proc);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('the default tool cap stops the 16th call', { timeout: 60_000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-kcap-'));
  const turns = Array.from({ length: 16 }, (_, index) => ({
    tool: 'read',
    args: { path: `f${index}.txt` },
  }));
  const script = await writeScript(dataDir, 'cap.json', turns);
  const srv = await startServer({
    PI_WORK_KERNEL: 'durable',
    PI_WORK_LLM: 'faux',
    PI_WORK_FAUX_SCRIPT: script,
    PI_WORK_EXPLORE_REPEAT: '30',
    PI_WORK_TOOL_LOOP: '30',
    PI_WORK_TOOL_NUDGE: '30',
  }, { dataDir });
  try {
    const { conv } = await openConversation(srv.base, { title: 'cap' });
    assert.equal((await request(srv.base, 'POST', `/api/conversations/${conv.id}/messages`, { text: 'go' })).status, 202);
    const done = await waitFor(srv.base, conv.id, (body) => (
      body.status === 'done' || body.status === 'failed'
    ), 45000);
    const tools = done.messages.filter((message) => message.role === 'tool');
    assert.equal(tools.length, 15, `${srv.logs()}\n${JSON.stringify(done.messages)}`);
    assert.equal(done.messages.some((message) => message.role === 'assistant' && String(message.text || '').includes('工具调用已达上限（15）')), true);
    assert.equal(done.status, 'done');
  } finally {
    await stopProcess(srv.proc);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('a tool cap is per pipeline step', { timeout: 40_000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-kpipe-'));
  const turns = [
    { tool: 'read', args: { path: 'a.txt' } },
    { tool: 'read', args: { path: 'b.txt' } },
    { tool: 'read', args: { path: 'c.txt' } },
    { text: 'pad' },
    { tool: 'read', args: { path: 'd.txt' } },
    { tool: 'read', args: { path: 'e.txt' } },
    { tool: 'read', args: { path: 'f.txt' } },
  ];
  const script = await writeScript(dataDir, 'pipe.json', turns);
  const srv = await startServer({
    PI_WORK_KERNEL: 'durable',
    PI_WORK_LLM: 'faux',
    PI_WORK_FAUX_SCRIPT: script,
    PI_WORK_MAX_TOOL_CALLS: '2',
    PI_WORK_TOOL_LOOP: '20',
    PI_WORK_EXPLORE_REPEAT: '20',
    PI_WORK_TOOL_NUDGE: '100',
  }, { dataDir });
  try {
    assert.equal((await request(srv.base, 'POST', '/api/roles', {
      id: 'pipe-coder', name: 'Coder', systemPrompt: 'code', tools: ['read'],
    })).status, 201);
    assert.equal((await request(srv.base, 'POST', '/api/roles', {
      id: 'pipe-tester', name: 'Tester', systemPrompt: 'test', tools: ['read'],
    })).status, 201);
    assert.equal((await request(srv.base, 'POST', '/api/pipelines', {
      id: 'cap-demo',
      name: 'Cap',
      steps: [{ role: 'pipe-coder', input: 'user' }, { role: 'pipe-tester', input: 'previous' }],
    })).status, 201);
    const { conv } = await openConversation(srv.base, { title: 'pipe', pipelineId: 'cap-demo' });
    assert.equal((await request(srv.base, 'POST', `/api/conversations/${conv.id}/messages`, { text: 'go' })).status, 202);
    const done = await waitFor(srv.base, conv.id, (body) => body.status === 'done' || body.status === 'failed', 30000);
    const tools = done.messages.filter((message) => message.role === 'tool');
    assert.equal(tools.length, 4, `${srv.logs()}\n${JSON.stringify(done.messages)}`);
    assert.equal(done.messages.filter((message) => message.role === 'assistant' && String(message.text || '').includes('工具调用已达上限')).length, 2);
    assert.equal(done.messages.some((message) => message.kind === 'handoff'), true);
    assert.equal(done.status, 'done');
  } finally {
    await stopProcess(srv.proc);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('the same path is explored at most twice', { timeout: 30_000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-kexp-'));
  const script = await writeScript(dataDir, 'explore.json', [
    { tool: 'grep', args: { pattern: '口令', path: 'src' } },
    { tool: 'grep', args: { pattern: 'password', path: './src/' } },
    { tool: 'grep', args: { pattern: 'token', path: 'src/' } },
    { text: '看过了' },
  ]);
  const srv = await startServer({
    PI_WORK_KERNEL: 'durable',
    PI_WORK_LLM: 'faux',
    PI_WORK_FAUX_SCRIPT: script,
    PI_WORK_TOOL_LOOP: '20',
    PI_WORK_TOOL_NUDGE: '100',
  }, { dataDir });
  try {
    const { ws, conv } = await openConversation(srv.base, { title: 'explore' });
    const { mkdir } = await import('node:fs/promises');
    await mkdir(path.join(ws.path, 'src'), { recursive: true });
    await writeFile(path.join(ws.path, 'src', 'a.txt'), '口令\n');
    assert.equal((await request(srv.base, 'POST', `/api/conversations/${conv.id}/messages`, { text: 'go' })).status, 202);
    const done = await waitFor(srv.base, conv.id, (body) => body.status === 'done' || body.status === 'failed');
    const tools = done.messages.filter((message) => message.role === 'tool' && message.tool?.name === 'grep');
    assert.equal(tools.length, 2, JSON.stringify(done.messages));
    assert.equal(done.messages.some((message) => message.kind === 'correction' && String(message.text).includes('不要再重复查看')), true);
    assert.equal(done.messages.some((message) => message.text === '看过了'), true, srv.logs());
  } finally {
    await stopProcess(srv.proc);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('repeated bash exploration stops each pipeline step', { timeout: 40_000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-kbash-'));
  const turns = [
    { tool: 'bash', args: { command: 'ls -la .' } },
    { tool: 'bash', args: { command: 'ls -a ./' } },
    { tool: 'bash', args: { command: 'grep -n 口令 .' } },
    { tool: 'bash', args: { command: 'find . -name "*.md"' } },
    { text: 'pad' },
    { tool: 'bash', args: { command: 'ls -la .' } },
    { tool: 'bash', args: { command: 'ls -a ./' } },
    { tool: 'bash', args: { command: 'grep -n 口令 .' } },
    { tool: 'bash', args: { command: 'find . -name "*.md"' } },
  ];
  const script = await writeScript(dataDir, 'bash.json', turns);
  const srv = await startServer({
    PI_WORK_KERNEL: 'durable',
    PI_WORK_LLM: 'faux',
    PI_WORK_FAUX_SCRIPT: script,
    PI_WORK_TOOL_LOOP: '20',
    PI_WORK_MAX_TOOL_CALLS: '20',
    PI_WORK_TOOL_NUDGE: '100',
  }, { dataDir });
  try {
    assert.equal((await request(srv.base, 'POST', '/api/roles', {
      id: 'pipe-coder', name: 'Coder', systemPrompt: 'code', tools: ['bash', 'read', 'ls'],
    })).status, 201);
    assert.equal((await request(srv.base, 'POST', '/api/roles', {
      id: 'pipe-tester', name: 'Tester', systemPrompt: 'test', tools: ['bash', 'read', 'ls'],
    })).status, 201);
    assert.equal((await request(srv.base, 'POST', '/api/pipelines', {
      id: 'explore-demo',
      name: 'Explore',
      steps: [{ role: 'pipe-coder', input: 'user' }, { role: 'pipe-tester', input: 'previous' }],
    })).status, 201);
    const { conv } = await openConversation(srv.base, { title: 'bash', pipelineId: 'explore-demo' });
    assert.equal((await request(srv.base, 'POST', `/api/conversations/${conv.id}/messages`, { text: 'go' })).status, 202);
    const done = await waitFor(srv.base, conv.id, (body) => body.status === 'done' || body.status === 'failed', 30000);
    assert.equal(done.messages.filter((message) => message.role === 'tool' && message.tool?.name === 'bash').length, 4, JSON.stringify(done.messages));
    assert.equal(done.messages.filter((message) => message.kind === 'correction' && String(message.text).includes('不要再重复查看')).length, 2);
    assert.equal(done.messages.filter((message) => message.role === 'assistant' && String(message.text || '').includes('仍在重复查看')).length, 2);
    assert.equal(done.messages.some((message) => message.kind === 'handoff'), true);
    assert.equal(done.status, 'done', srv.logs());
  } finally {
    await stopProcess(srv.proc);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('an identical tool loop stops after the correction', { timeout: 30_000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-kloop-'));
  const script = await writeScript(dataDir, 'loop.json', [
    { tool: 'ls', args: { path: '.' } },
    { tool: 'ls', args: { path: '.' } },
    { tool: 'ls', args: { path: '.' } },
    { tool: 'ls', args: { path: '.' } },
    { text: '目录已经看过。' },
  ]);
  const srv = await startServer({
    PI_WORK_KERNEL: 'durable',
    PI_WORK_LLM: 'faux',
    PI_WORK_FAUX_SCRIPT: script,
    PI_WORK_EXPLORE_REPEAT: '20',
    PI_WORK_TOOL_NUDGE: '100',
    PI_WORK_MAX_TOOL_CALLS: '25',
  }, { dataDir });
  try {
    const { conv } = await openConversation(srv.base, { title: 'loop' });
    assert.equal((await request(srv.base, 'POST', `/api/conversations/${conv.id}/messages`, { text: 'list it' })).status, 202);
    const done = await waitFor(srv.base, conv.id, (body) => body.status === 'done' || body.status === 'failed');
    const ls = done.messages.filter((message) => message.role === 'tool' && message.tool?.name === 'ls');
    assert.equal(ls.length, 3, JSON.stringify(done.messages));
    assert.equal(done.messages.some((message) => message.kind === 'correction' && String(message.text).includes('停止调用工具')), true);
    assert.equal(done.messages.some((message) => message.text === '目录已经看过。'), true, srv.logs());
  } finally {
    await stopProcess(srv.proc);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('eight silent tool calls inject a nudge', { timeout: 40_000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-knudge-'));
  const turns = Array.from({ length: 9 }, (_, index) => ({
    tool: 'read',
    args: { path: `n${index}.txt` },
  }));
  turns.push({ text: '就这些。' });
  const script = await writeScript(dataDir, 'nudge.json', turns);
  const srv = await startServer({
    PI_WORK_KERNEL: 'durable',
    PI_WORK_LLM: 'faux',
    PI_WORK_FAUX_SCRIPT: script,
    PI_WORK_EXPLORE_REPEAT: '30',
    PI_WORK_TOOL_LOOP: '30',
    PI_WORK_MAX_TOOL_CALLS: '30',
  }, { dataDir });
  try {
    const { conv } = await openConversation(srv.base, { title: 'nudge' });
    assert.equal((await request(srv.base, 'POST', `/api/conversations/${conv.id}/messages`, { text: 'go' })).status, 202);
    const done = await waitFor(srv.base, conv.id, (body) => body.status === 'done' || body.status === 'failed', 30000);
    const tools = done.messages.filter((message) => message.role === 'tool');
    assert.equal(tools.length, 8, JSON.stringify(done.messages));
    assert.equal(done.messages.some((message) => message.kind === 'correction' && String(message.text).includes('请根据已有结果直接回答')), true);
    assert.equal(done.messages.some((message) => message.text === '就这些。'), true, srv.logs());
  } finally {
    await stopProcess(srv.proc);
    await rm(dataDir, { recursive: true, force: true });
  }
});

function subagentsOf(body) {
  return (body?.agents || []).filter((agent) => String(agent.id || '').includes(':sub:'));
}

function payloadText(payload) {
  const users = (payload?.messages || []).filter((message) => message.role === 'user');
  const last = users[users.length - 1];
  if (!last) return '';
  if (typeof last.content === 'string') return last.content;
  if (Array.isArray(last.content)) {
    return last.content.map((part) => (typeof part === 'string' ? part : part?.text || '')).join('');
  }
  return '';
}

function sseChunk(delta, finish) {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-pause',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}`;
}

function textSse(text) {
  return [
    sseChunk({ role: 'assistant', content: text }, null),
    '',
    sseChunk({}, 'stop'),
    '',
    'data: [DONE]',
    '',
    '',
  ].join('\n');
}

function toolSse(name, args) {
  const id = 'call_fg_read';
  return [
    sseChunk({
      role: 'assistant',
      tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: '' } }],
    }, null),
    '',
    sseChunk({ tool_calls: [{ index: 0, id, function: { arguments: JSON.stringify(args) } }] }, null),
    '',
    sseChunk({}, 'tool_calls'),
    '',
    'data: [DONE]',
    '',
    '',
  ].join('\n');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Holds each child completion until its own release file exists. The first
// foreground completion answers with a tool call so a second model request is
// observable if pause fails to stop the next step.
function startSplitScout({ bgReady, fgReady, bgRelease, fgRelease }) {
  let closed = 0;
  let bgHits = 0;
  let fgHits = 0;
  const seen = [];
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
    if (!url.pathname.endsWith('/chat/completions')) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const text = payloadText(payload);
    seen.push(text);
    const kind = text.includes('FG_HOLD') ? 'fg' : 'bg';
    const firstFg = kind === 'fg' && fgHits === 0;
    if (kind === 'fg') fgHits += 1;
    else bgHits += 1;
    if (firstFg) await writeFile(fgReady, 'seen');
    if (kind === 'bg' && bgHits === 1) await writeFile(bgReady, 'seen');
    const releasePath = firstFg ? fgRelease : kind === 'bg' ? bgRelease : `${fgRelease}.next`;
    const released = await new Promise((resolve) => {
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
    if (!released || res.writableEnded || res.destroyed) return;
    const body = firstFg
      ? toolSse('read', { path: 'note.txt' })
      : textSse('SHOULD_NOT_FINISH');
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.end(body);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        closed: () => closed,
        bgHits: () => bgHits,
        fgHits: () => fgHits,
        seen: () => seen.slice(),
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

test('pause finishes the foreground step and leaves the background subagent running', { timeout: 90_000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-ksub-pause-'));
  const bgReady = path.join(dataDir, 'bg.ready');
  const fgReady = path.join(dataDir, 'fg.ready');
  const bgRelease = path.join(dataDir, 'bg.release');
  const fgRelease = path.join(dataDir, 'fg.release');
  const script = await writeScript(dataDir, 'subs.json', [
    { tool: 'subagent', args: { action: 'spawn', name: 'sleeper', agent: 'scout', message: 'BG_HOLD' } },
    { text: 'background is up' },
    { tool: 'delegate', args: { agent: 'scout', task: 'FG_HOLD' } },
    { text: 'should not run while paused' },
  ]);
  const fake = await startSplitScout({ bgReady, fgReady, bgRelease, fgRelease });
  const srv = await startServer({
    PI_WORK_KERNEL: 'durable',
    PI_WORK_LLM: 'faux',
    PI_WORK_FAUX_SCRIPT: script,
    PI_WORK_STALL_MS: '120000',
  }, { dataDir });
  try {
    const role = await request(srv.base, 'POST', '/api/roles', {
      id: 'scout',
      name: 'Scout',
      description: 'when the tree needs reading',
      systemPrompt: 'SCOUT PROMPT',
      tools: ['read'],
      pluginTools: false,
    });
    assert.equal(role.status, 201, JSON.stringify(role.body));
    const source = await request(srv.base, 'POST', '/api/sources', {
      vendor: 'custom',
      name: 'Scout',
      baseUrl: fake.baseUrl,
      apiKey: 'sk-scout-key-1234',
      models: ['model-scout'],
    });
    assert.equal(source.status, 201, JSON.stringify(source.body));
    const settings = await request(srv.base, 'PUT', '/api/settings', {
      models: { scout: { sourceId: source.body.id, model: 'model-scout' } },
    });
    assert.equal(settings.status, 200, JSON.stringify(settings.body));
    const { ws, conv } = await openConversation(srv.base, { title: 'sub-pause' });
    await writeFile(path.join(ws.path, 'note.txt'), 'note\n');
    assert.equal((await request(srv.base, 'POST', `/api/conversations/${conv.id}/messages`, { text: 'spawn' })).status, 202);
    const spawned = await waitFor(srv.base, conv.id, (body) => {
      const sleeper = subagentsOf(body).find((agent) => agent.name === 'sleeper');
      return body.status === 'done'
        && (body.messages || []).some((message) => message.text === 'background is up')
        && sleeper?.status === 'running';
    });
    assert.equal(spawned.status, 'done', srv.logs());
    assert.equal(fake.closed(), 0);
    assert.equal((await request(srv.base, 'POST', `/api/conversations/${conv.id}/messages`, { text: 'delegate' })).status, 202);
    const fgUntil = Date.now() + 15000;
    while (!(await exists(fgReady)) && Date.now() < fgUntil) {
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    assert.equal(await exists(fgReady), true, `${srv.logs()}\n${JSON.stringify(fake.seen())}`);
    const paused = await request(srv.base, 'POST', `/api/conversations/${conv.id}/pause`, {});
    assert.equal(paused.status, 200, srv.logs());
    assert.equal(paused.body.status, 'paused');
    const held = await request(srv.base, 'GET', `/api/conversations/${conv.id}`);
    const sleeper = subagentsOf(held.body).find((agent) => agent.name === 'sleeper');
    const scout = subagentsOf(held.body).find((agent) => agent.name === 'Scout');
    assert.equal(held.body.status, 'paused', JSON.stringify(held.body.agents));
    assert.equal(sleeper?.status, 'running', JSON.stringify(held.body.agents));
    assert.notEqual(scout?.status, 'stopped', JSON.stringify(held.body.agents));
    assert.equal(fake.closed(), 0, 'pause closed a subagent model call');
    assert.equal(fake.fgHits(), 1);
    assert.equal(fake.bgHits(), 1);
    await writeFile(fgRelease, 'go');
    const stepped = await waitFor(srv.base, conv.id, (body) => {
      const foreground = subagentsOf(body).find((agent) => agent.name === 'Scout');
      return body.status === 'paused' && (foreground?.toolCalls || 0) >= 1;
    });
    assert.equal(stepped.status, 'paused', srv.logs());
    await new Promise((resolve) => setTimeout(resolve, 800));
    const quiet = await request(srv.base, 'GET', `/api/conversations/${conv.id}`);
    assert.equal(quiet.body.status, 'paused');
    assert.equal(fake.fgHits(), 1, `foreground continued: ${JSON.stringify(fake.seen())}`);
    assert.equal(fake.closed(), 0);
    assert.equal(subagentsOf(quiet.body).find((agent) => agent.name === 'sleeper')?.status, 'running');
    assert.equal((quiet.body.messages || []).some((message) => message.text === 'should not run while paused'), false);
    const stopped = await request(srv.base, 'POST', `/api/conversations/${conv.id}/stop`, {});
    assert.equal(stopped.status, 200, JSON.stringify(stopped.body));
    assert.equal(stopped.body.status, 'stopped');
    const after = await waitFor(srv.base, conv.id, (body) => (
      body.status === 'stopped'
      && subagentsOf(body).find((agent) => agent.name === 'sleeper')?.status === 'stopped'
    ));
    assert.equal(after.status, 'stopped');
    const closedUntil = Date.now() + 8000;
    while (fake.closed() < 1 && Date.now() < closedUntil) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(fake.closed() >= 1, 'stop left the background model call open');
    console.log(`KERNEL_CONTROL_SUBAGENT_PAUSE ${JSON.stringify({
      fgHits: fake.fgHits(),
      bgHits: fake.bgHits(),
      closed: fake.closed(),
      sleeper: 'stopped',
    })}`);
  } finally {
    await stopProcess(srv.proc);
    await fake.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('a missing model after a finished tool stays failed', { timeout: 30_000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-knomodel-'));
  const script = await writeScript(dataDir, 'nomodel.json', [
    { tool: 'ls', args: { path: '.' } },
    { error: 'E_NO_MODEL' },
  ]);
  const srv = await startServer({
    PI_WORK_LLM: 'faux',
    PI_WORK_FAUX_SCRIPT: script,
  }, { dataDir });
  try {
    const { conv } = await openConversation(srv.base, { title: 'nomodel' });
    assert.equal((await request(srv.base, 'POST', `/api/conversations/${conv.id}/messages`, { text: 'list' })).status, 202);
    const body = await waitFor(srv.base, conv.id, (row) => row.status === 'failed' || row.status === 'done');
    assert.equal(body.status, 'failed', `${srv.logs()}\n${JSON.stringify(body.messages)}`);
    assert.equal(body.llmError?.code, 'E_NO_MODEL');
    assert.equal(body.messages.some((message) => message.role === 'tool'), true);
  } finally {
    await stopProcess(srv.proc);
    await rm(dataDir, { recursive: true, force: true });
  }
});
