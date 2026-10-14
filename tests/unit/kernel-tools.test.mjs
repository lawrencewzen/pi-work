import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSSE } from '../../src/core/sse.mjs';
import { fauxTurnFromScript, offeredToolNames, toolsForRole, workspaceTools } from '../../src/kernel/tools.mjs';
import { ROOT } from './_root.mjs';

const TOKEN = 'unit-kernel-tools-token';
const README = 'docs/deep/nested/folder/structure/README.md';
const BASIC = path.join(ROOT, 'tests/fixtures/basic.json');
const STRIP = [
  'PI_WORK_LLM',
  'PI_WORK_FAUX_SCRIPT',
  'PI_WORK_FAUX_TEXT',
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
  dataDir ??= await mkdtemp(path.join(tmpdir(), 'piw-ktools-'));
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

async function openConversation(base, { title = 'kernel', roleId, name = 'kernel-ws' } = {}) {
  const ws = await request(base, 'POST', '/api/workspaces', { name });
  assert.equal(ws.status, 201, JSON.stringify(ws.body));
  const body = { title };
  if (roleId) body.roleId = roleId;
  const conv = await request(base, 'POST', `/api/workspaces/${ws.body.id}/conversations`, body);
  assert.equal(conv.status, 201, JSON.stringify(conv.body));
  return { ws: ws.body, conv: conv.body };
}

async function waitFinished(base, id, timeoutMs = 20000) {
  const started = Date.now();
  let body;
  while (Date.now() - started < timeoutMs) {
    const got = await request(base, 'GET', `/api/conversations/${id}`);
    body = got.body;
    if (body?.status === 'done' || body?.status === 'failed') return body;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`conversation ${id} did not finish: ${JSON.stringify(body)}`);
}

async function writeScript(dataDir, name, turns) {
  const file = path.join(dataDir, name);
  await writeFile(file, JSON.stringify({ turns }));
  return file;
}

function durableEnv(script, extra = {}) {
  return {
    PI_WORK_KERNEL: 'durable',
    PI_WORK_LLM: 'faux',
    PI_WORK_FAUX_SCRIPT: script,
    ...extra,
  };
}

function diffView(body) {
  return {
    path: body?.path,
    before: body?.before,
    after: body?.after,
    unified: body?.unified,
    added: body?.added,
    removed: body?.removed,
  };
}

function changeView(body) {
  return (body || []).map((row) => ({ path: row.path, added: row.added, removed: row.removed }));
}

test('read, ls, and grep replay safely; write, edit, and bash do not', () => {
  const replay = Object.fromEntries(workspaceTools().map((tool) => [tool.name, tool.replay]));
  assert.deepEqual(replay, {
    read: 'safe',
    write: 'unsafe',
    edit: 'unsafe',
    ls: 'safe',
    grep: 'safe',
    bash: 'unsafe',
  });
});

test('a role tool list is the offered set, in that order', () => {
  assert.deepEqual(toolsForRole({ tools: ['grep', 'read'] }).map((tool) => tool.name), ['grep', 'read']);
  assert.deepEqual(toolsForRole({ tools: [] }).map((tool) => tool.name), ['read', 'write', 'edit', 'ls', 'grep', 'bash']);
  assert.deepEqual(
    offeredToolNames({
      messages: [
        { role: 'system', toolsAdded: [{ name: 'read' }, { name: 'ls' }], toolsRemoved: [] },
        { role: 'user', content: 'hi' },
      ],
    }),
    ['read', 'ls'],
  );
});

test('a scripted demo turn follows committed assistant messages', () => {
  const turns = [
    { tool: 'bash', args: { command: 'sleep 40' }, id: 'bash-hold' },
    { text: 'continued' },
  ];
  const first = fauxTurnFromScript(turns, { messages: [{ role: 'user', content: 'go' }] });
  assert.equal(first.stopReason, 'toolUse');
  assert.equal(first.content[0].name, 'bash');
  assert.equal(first.content[0].id, 'bash-hold');
  const second = fauxTurnFromScript(turns, {
    messages: [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: [{ type: 'toolCall', id: 'bash-hold', name: 'bash' }] },
      { role: 'toolResult', content: [{ type: 'text', text: 'Tool bash was interrupted' }] },
    ],
  });
  assert.equal(second.content[0].text, 'continued');
});

test('kernel path: path escape is E_SANDBOX and bash stays in the workspace', { timeout: 40_000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-ksand-'));
  const command = process.platform === 'win32'
    ? 'echo bash-ok> sand.txt & echo bash-ok'
    : 'printf bash-ok > sand.txt && printf bash-ok';
  const script = await writeScript(dataDir, 'sandbox.json', [
    { tool: 'read', args: { path: '../outside.txt' }, id: 'escape-read' },
    { tool: 'write', args: { path: '../outside.txt', content: 'pwned' }, id: 'escape-write' },
    { tool: 'bash', args: { command }, id: 'bash-1' },
    { text: 'sandbox-done' },
  ]);
  const srv = await startServer(durableEnv(script), { dataDir });
  try {
    const { ws, conv } = await openConversation(srv.base, { title: 'sandbox' });
    const outside = path.join(ws.path, '..', 'outside.txt');
    await writeFile(outside, 'secret');
    const sent = await request(srv.base, 'POST', `/api/conversations/${conv.id}/messages`, { text: 'check' });
    assert.equal(sent.status, 202);
    const done = await waitFinished(srv.base, conv.id);
    assert.equal(done.status, 'done', JSON.stringify(done));
    const tools = done.messages.filter((message) => message.role === 'tool').map((message) => message.text || '');
    assert.equal(tools.filter((text) => text.includes('E_SANDBOX')).length, 2, JSON.stringify(tools));
    assert.equal(tools.some((text) => text.includes('bash-ok')), true, JSON.stringify(tools));
    assert.equal(done.messages.some((message) => message.role === 'assistant' && message.text === 'sandbox-done'), true);
    assert.equal(await readFile(outside, 'utf8'), 'secret');
    assert.equal((await readFile(path.join(ws.path, 'sand.txt'), 'utf8')).includes('bash-ok'), true);
    const events = await collectSse(srv.base, conv.id, {
      ready: (list) => list.some((ev) => ev.event === 'status' && ev.data?.status === 'done'),
    });
    const escape = events.find((ev) => ev.event === 'tool.end' && ev.data?.tool?.id === 'escape-read');
    assert.equal(escape?.data?.tool?.path, '../outside.txt');
    assert.equal(escape?.data?.tool?.status, 'error');
    const started = events.find((ev) => ev.event === 'tool.start' && ev.data?.tool?.id === 'bash-1');
    assert.equal(started?.data?.tool?.status, 'running');
  } finally {
    await stopProcess(srv.proc);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('kernel path: two conversations write into their own workspaces', { timeout: 40_000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-kcwd-'));
  const script = await writeScript(dataDir, 'own.json', [
    { tool: 'write', args: { path: 'own.txt', content: 'mine' }, id: 'own' },
    { text: 'wrote-own' },
  ]);
  const srv = await startServer(durableEnv(script), { dataDir });
  try {
    const first = await openConversation(srv.base, { title: 'a', name: 'ws-a' });
    const second = await openConversation(srv.base, { title: 'b', name: 'ws-b' });
    assert.notEqual(path.resolve(first.ws.path), path.resolve(second.ws.path));
    const sentA = await request(srv.base, 'POST', `/api/conversations/${first.conv.id}/messages`, { text: 'a' });
    const sentB = await request(srv.base, 'POST', `/api/conversations/${second.conv.id}/messages`, { text: 'b' });
    assert.equal(sentA.status, 202);
    assert.equal(sentB.status, 202);
    const doneA = await waitFinished(srv.base, first.conv.id);
    const doneB = await waitFinished(srv.base, second.conv.id);
    assert.equal(doneA.status, 'done', JSON.stringify(doneA.messages));
    assert.equal(doneB.status, 'done', JSON.stringify(doneB.messages));
    assert.equal(await readFile(path.join(first.ws.path, 'own.txt'), 'utf8'), 'mine');
    assert.equal(await readFile(path.join(second.ws.path, 'own.txt'), 'utf8'), 'mine');
  } finally {
    await stopProcess(srv.proc);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('kernel path: write plus edit matches the old path changes and diff', { timeout: 60_000 }, async () => {
  // basic.json opens with a narration turn. The harness stops when a model reply has no tool
  // call, so both paths run the fixture's write and edit, which are the turns that touch the file.
  const basic = JSON.parse(await readFile(BASIC, 'utf8'));
  const turns = basic.turns.filter((turn) => turn.tool || turn.text === '完成 ✅');
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-kdiff-script-'));
  const script = await writeScript(dataDir, 'write-edit.json', turns);

  async function run(extra) {
    const srv = await startServer({ PI_WORK_LLM: 'faux', PI_WORK_FAUX_SCRIPT: script, ...extra });
    try {
      const { conv } = await openConversation(srv.base, { title: 'diff' });
      const sent = await request(srv.base, 'POST', `/api/conversations/${conv.id}/messages`, { text: 'please' });
      assert.equal(sent.status, 202, JSON.stringify(sent.body));
      const done = await waitFinished(srv.base, conv.id);
      assert.equal(done.status, 'done', JSON.stringify(done.messages));
      assert.equal(done.messages.some((message) => message.text === '完成 ✅'), true, JSON.stringify(done.messages));
      const changes = await request(srv.base, 'GET', `/api/conversations/${conv.id}/changes`);
      const diff = await request(srv.base, 'GET', `/api/conversations/${conv.id}/diff?path=${encodeURIComponent(README)}`);
      assert.equal(changes.status, 200, JSON.stringify(changes.body));
      assert.equal(diff.status, 200, JSON.stringify(diff.body));
      let events = [];
      if (extra.PI_WORK_KERNEL === 'durable') {
        events = await collectSse(srv.base, conv.id, {
          ready: (list) => list.some((ev) => ev.event === 'tool.end' && ev.data?.tool?.name === 'edit'),
        });
      }
      return { changes: changes.body, diff: diff.body, events };
    } finally {
      await stopProcess(srv.proc);
      await rm(srv.dataDir, { recursive: true, force: true });
    }
  }

  const legacy = await run({});
  const kernel = await run({ PI_WORK_KERNEL: 'durable' });
  assert.deepEqual(changeView(kernel.changes), changeView(legacy.changes));
  assert.deepEqual(diffView(kernel.diff), diffView(legacy.diff));
  assert.equal(typeof kernel.changes[0]?.toolCallId, 'string');
  assert.equal(kernel.changes[0].toolCallId.length > 0, true);
  assert.equal(typeof legacy.changes[0]?.toolCallId, 'string');
  const ends = kernel.events.filter((ev) => ev.event === 'tool.end' && (ev.data?.tool?.name === 'write' || ev.data?.tool?.name === 'edit'));
  assert.equal(ends.length, 2, JSON.stringify(kernel.events.map((ev) => ev.event)));
  for (const ev of ends) {
    assert.equal(ev.data.tool.path, README);
    assert.equal(typeof ev.data.tool.added, 'number');
    assert.equal(typeof ev.data.tool.removed, 'number');
    assert.equal(ev.data.tool.status, 'completed');
  }
  const starts = kernel.events.filter((ev) => ev.event === 'tool.start' && (ev.data?.tool?.name === 'write' || ev.data?.tool?.name === 'edit'));
  assert.equal(starts.length, 2);
  for (const ev of starts) {
    assert.equal(ev.data.tool.path, README);
    assert.equal(ev.data.tool.status, 'running');
  }
  await rm(dataDir, { recursive: true, force: true });
});

test('kernel path: a role without a tool does not offer it and rejects the call', { timeout: 40_000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-krole-'));
  const toolLog = path.join(dataDir, 'tools.log');
  const script = await writeScript(dataDir, 'role.json', [
    { tool: 'write', args: { path: 'secret.txt', content: 'no' }, id: 'denied-write' },
    { tool: 'bash', args: { command: 'echo no' }, id: 'denied-bash' },
    { text: 'role-done' },
  ]);
  const srv = await startServer(durableEnv(script, { PI_WORK_FAUX_TOOL_LOG: toolLog }), { dataDir });
  try {
    const { ws, conv } = await openConversation(srv.base, { title: 'audit', roleId: 'auditor' });
    const sent = await request(srv.base, 'POST', `/api/conversations/${conv.id}/messages`, { text: 'review' });
    assert.equal(sent.status, 202);
    const done = await waitFinished(srv.base, conv.id);
    assert.equal(done.status, 'done', JSON.stringify(done.messages));
    const denied = done.messages.filter((message) => message.role === 'tool').map((message) => message.text || '');
    assert.equal(denied.length, 2, JSON.stringify(denied));
    assert.equal(denied.every((text) => text.includes('not available')), true, JSON.stringify(denied));
    await assert.rejects(readFile(path.join(ws.path, 'secret.txt'), 'utf8'));
    const offered = (await readFile(toolLog, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(offered[0], ['read', 'ls', 'grep']);
    assert.equal(offered[0].includes('write'), false);
    assert.equal(offered[0].includes('bash'), false);
  } finally {
    await stopProcess(srv.proc);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('kernel path: killing the process does not rerun an unsafe tool, and the model receives interrupted', { timeout: 90_000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-kkill-'));
  const command = process.platform === 'win32'
    ? 'echo x>>ran-count & ping -n 40 127.0.0.1 >nul'
    : 'printf x >> ran-count && sleep 40';
  const script = await writeScript(dataDir, 'hang.json', [
    { tool: 'bash', args: { command, timeout: 120000 }, id: 'bash-hold' },
    { text: 'continued' },
  ]);
  const env = durableEnv(script);
  const first = await startServer(env, { dataDir });
  let convId;
  let workspacePath;
  let marker;
  try {
    const opened = await openConversation(first.base, { title: 'hang' });
    convId = opened.conv.id;
    workspacePath = opened.ws.path;
    const sent = await request(first.base, 'POST', `/api/conversations/${convId}/messages`, { text: 'hang' });
    assert.equal(sent.status, 202);
    const stamp = path.join(workspacePath, 'ran-count');
    const started = Date.now();
    while (Date.now() - started < 20000) {
      try {
        marker = await readFile(stamp);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
    }
    assert.ok(marker, `bash did not start:\n${first.logs()}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
    marker = await readFile(stamp);
  } finally {
    if (first.proc.exitCode == null && first.proc.signalCode == null) {
      const exited = new Promise((resolve) => first.proc.once('exit', resolve));
      killChild(first.proc);
      await exited;
    }
  }

  const second = await startServer(env, { dataDir });
  try {
    const done = await waitFinished(second.base, convId, 20000);
    assert.equal(done.status, 'done', JSON.stringify(done.messages));
    const tool = done.messages.find((message) => message.role === 'tool');
    assert.equal(String(tool?.text || '').includes('interrupted'), true, JSON.stringify(done.messages));
    assert.equal(done.messages.some((message) => message.role === 'assistant' && message.text === 'continued'), true, JSON.stringify(done.messages));
    assert.deepEqual(await readFile(path.join(workspacePath, 'ran-count')), marker);
  } finally {
    await stopProcess(second.proc);
    await rm(dataDir, { recursive: true, force: true });
  }
});
