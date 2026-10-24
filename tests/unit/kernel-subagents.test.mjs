import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSSE } from '../../src/core/sse.mjs';
import { createExtensionHost } from '../../src/core/extensions.mjs';
import { openConversationKernel } from '../../src/kernel/conversations.mjs';
import { DELEGATE_DESCRIPTION, nameFromTask, SUBAGENT_DESCRIPTION } from '../../src/kernel/subagents.mjs';
import { SKILL_TOOL_DESCRIPTION } from '../../src/kernel/skill-tool.mjs';
import { createSqliteStore } from '../../src/store/sqlite.mjs';
import { killChild, request as serverRequest, startServer, stopServer } from './_server.mjs';

const TOKEN = 'unit-kernel-subagents-token';
const request = (base, method, apiPath, body) => serverRequest(base, method, apiPath, body, TOKEN);

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
    if (err?.name !== 'AbortError' && err?.message !== 'terminated') throw err;
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

function assertFiniteMs(value, label) {
  assert.equal(typeof value, 'number', `${label} type=${typeof value} value=${value}`);
  assert.equal(Number.isFinite(value), true, `${label} value=${value}`);
}

function assertRunningActivity(agent, { brief, currentAction, mode }) {
  assert.ok(agent, 'missing subagent');
  assert.equal(agent.status, 'running', JSON.stringify(agent));
  if (mode) assert.equal(agent.mode, mode);
  assert.equal(agent.brief, brief);
  assertFiniteMs(agent.startedAt, 'startedAt');
  assertFiniteMs(agent.lastActivityAt, 'lastActivityAt');
  assert.ok(agent.lastActivityAt >= agent.startedAt, JSON.stringify(agent));
  assert.equal(agent.currentAction, currentAction);
  assert.equal(agent.endedAt, undefined);
}

function assertDoneActivity(agent, { brief, mode }) {
  assert.ok(agent, 'missing subagent');
  assert.equal(agent.status, 'done', JSON.stringify(agent));
  if (mode) assert.equal(agent.mode, mode);
  assert.equal(agent.brief, brief);
  assertFiniteMs(agent.startedAt, 'startedAt');
  assertFiniteMs(agent.lastActivityAt, 'lastActivityAt');
  assertFiniteMs(agent.endedAt, 'endedAt');
  assert.equal(agent.currentAction, undefined);
}

function childHarnessId(agent) {
  const id = String(agent?.id || '');
  const marker = ':sub:';
  const at = id.lastIndexOf(marker);
  return at >= 0 ? Number(id.slice(at + marker.length)) : NaN;
}

function sectionText(snapshot, key) {
  return snapshot?.sections?.find((section) => section.key === key)?.value || '';
}

function sectionInner(snapshot, key) {
  return String(sectionText(snapshot, key) || '').replace(new RegExp(`</?${key}>`, 'gi'), '').trim();
}

function toolPropertyKeys(schema) {
  return Object.keys(schema?.properties || {});
}

async function writeScript(dataDir, name, turns) {
  const file = path.join(dataDir, name);
  await writeFile(file, JSON.stringify({ turns }));
  return file;
}

test('subagent messages 404 for an unknown conversation or agent', { timeout: 30000 }, async () => {
  const srv = await startServer({
    token: TOKEN,
    env: { WEFT_RETRY_MAX: '2', WEFT_LLM: 'faux', WEFT_FAUX_TEXT: 'still-here' },
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

test('foreground delegate returns the child answer; tools and name are self-contained', { timeout: 60000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-ksub-fg-'));
  const record = path.join(dataDir, 'parent-requests.jsonl');
  const task = 'Say CHILD_MODEL_OK';
  const script = await writeScript(dataDir, 'parent.json', [
    { tool: 'delegate', args: { task } },
    { text: 'parent-done' },
    { when: 'Say CHILD_MODEL_OK', text: 'CHILD_MODEL_OK' },
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
    const ws = await request(srv.base, 'POST', '/api/workspaces', { name: 'fg' });
    assert.equal(ws.status, 201);
    const conv = await request(srv.base, 'POST', `/api/workspaces/${ws.body.id}/conversations`, { title: 'fg' });
    assert.equal(conv.status, 201);
    const pendingEvents = collectSse(srv.base, conv.body.id, {
      ready: (list) => list.some((ev) => ev.event === 'agent' && ev.data?.name === nameFromTask(task) && ev.data?.lastText?.includes('CHILD_MODEL_OK')),
      timeout: 30000,
    }).catch((err) => {
      if (err?.name === 'AbortError' || err?.message === 'terminated') return [];
      throw err;
    });
    const sent = await request(srv.base, 'POST', `/api/conversations/${conv.body.id}/messages`, { text: 'dispatch child' });
    assert.equal(sent.status, 202);
    const done = await waitFor(srv.base, conv.body.id, (body) => (
      body.status === 'done' && toolTexts(body).some((text) => text.includes('CHILD_MODEL_OK'))
    ));
    assert.equal(done.status, 'done', srv.logs());
    assert.equal(assistantTexts(done).includes('CHILD_MODEL_OK'), false);
    assert.equal(assistantTexts(done).includes('parent-done'), true);
    const records = (await readFile(record, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    const parentCall = records.find((row) => (row.tools || []).includes('delegate'));
    assert.ok(parentCall, JSON.stringify(records));
    assert.equal(parentCall.toolDescriptions?.delegate, DELEGATE_DESCRIPTION);
    assert.equal(parentCall.toolDescriptions?.subagent, SUBAGENT_DESCRIPTION);
    assert.equal(parentCall.toolDescriptions?.skill, SKILL_TOOL_DESCRIPTION);
    assert.equal((parentCall.tools || []).includes('skill'), true);
    assert.equal(/role/i.test(parentCall.toolDescriptions?.delegate || ''), false);
    assert.equal(/Pick a subagent/i.test(JSON.stringify(parentCall.sections || [])), false);
    const childCall = records.find((row) => !(row.tools || []).includes('delegate'));
    assert.ok(childCall, JSON.stringify(records));
    assert.equal((childCall.tools || []).includes('delegate'), false);
    assert.equal((childCall.tools || []).includes('subagent'), false);
    assert.equal((childCall.tools || []).includes('skill'), false);
    assert.equal(sectionInner(childCall, 'instructions'), '');
    assert.equal(sectionInner(childCall, 'skills'), '');
    assert.equal(/Skills you can load with the skill tool/i.test(JSON.stringify(childCall.sections || [])), false);
    assert.equal(/Pick a subagent/i.test(JSON.stringify(childCall.sections || [])), false);
    const child = subagentsOf(done).find((agent) => agent.mode === 'foreground');
    assert.ok(child, JSON.stringify(done.agents));
    assert.equal(child.name, nameFromTask(task));
    assert.equal(Object.hasOwn(child, 'roleId'), false);
    assert.equal(child.status, 'done');
    assert.match(child.lastText, /CHILD_MODEL_OK/);
    for (const chip of done.agents.filter((agent) => !String(agent.id).includes(':sub:'))) {
      assert.equal(chip.mode, undefined);
    }
    const messages = await request(srv.base, 'GET', `/api/conversations/${conv.body.id}/agents/${encodeURIComponent(child.id)}/messages`);
    assert.equal(messages.status, 200);
    assert.equal(messages.body.mode, 'foreground');
    assert.equal(Object.hasOwn(messages.body, 'roleId'), false);
    assert.equal(messages.body.name, nameFromTask(task));
    assert.equal(messages.body.messages.filter((message) => message.role === 'user').length, 1);
    assert.match(messages.body.messages.find((message) => message.role === 'assistant')?.text || '', /CHILD_MODEL_OK/);
    const missing = await request(srv.base, 'GET', `/api/conversations/${conv.body.id}/agents/missing/messages`);
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error, 'agent not found');
    const events = await pendingEvents;
    const deltas = events.filter((ev) => ev.event === 'message.delta').map((ev) => ev.data?.text || '').join('');
    assert.equal(deltas.includes('CHILD_MODEL_OK'), false);
    const agentEvent = events.find((ev) => ev.event === 'agent' && ev.data?.name === nameFromTask(task) && ev.data?.lastText?.includes('CHILD_MODEL_OK'));
    assert.ok(agentEvent, JSON.stringify(events.filter((ev) => ev.event === 'agent')));
    assert.equal(agentEvent.data.mode, 'foreground');
    assert.equal(Object.hasOwn(agentEvent.data, 'roleId') && agentEvent.data.roleId, false);
    for (const ev of events.filter((item) => item.event === 'agent' && !String(item.data?.id || '').includes(':sub:'))) {
      assert.equal(ev.data.mode, undefined);
    }
  } finally {
    await stopServer(proc);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('child resolved agent is self-contained: empty instructions, parent model and cwd, no skills or dispatch tools', { timeout: 60000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-ksub-self-contained-'));
  const record = path.join(dataDir, 'requests.jsonl');
  const task = '请确认前台子代理已经收到了这一整段很长的任务说明并马上开始执行\n第二行不进名字';
  const script = await writeScript(dataDir, 'self.json', [
    { tool: 'delegate', args: { task } },
    { text: 'parent-done' },
    { when: '请确认前台子代理', text: 'CHILD_OK' },
  ]);
  const store = createSqliteStore(dataDir);
  let kernel = null;
  try {
    const wsPath = path.join(dataDir, 'ws');
    await mkdir(wsPath, { recursive: true });
    const ws = await store.createWorkspace({ name: 'self', path: wsPath });
    kernel = await openConversationKernel({
      dataDir,
      store,
      demo: true,
      extensions: createExtensionHost({ getSettings: () => store.getSettings() }),
      getSettings: () => store.getSettings(),
      env: {
        WEFT_LLM: 'faux',
        WEFT_FAUX_SCRIPT: script,
        WEFT_FAUX_RECORD: record,
        WEFT_RETRY_MAX: '2',
        WEFT_RETRY_BASE_MS: '20',
      },
    });
    const conv = await kernel.createConversation({
      workspaceId: ws.id,
      workspacePath: wsPath,
      title: 'self',
    });
    const posted = await kernel.postMessage(conv, 'dispatch');
    assert.equal(posted.status, 202);
    let done = null;
    let child = null;
    for (let i = 0; i < 120; i += 1) {
      const live = await store.getConversation(conv.id);
      done = await kernel.present(live, { includeMessages: true });
      child = (await kernel.listSubagents(live)).find((agent) => agent.mode === 'foreground');
      if (done.status === 'done' && assistantTexts(done).includes('parent-done') && child) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(done.status, 'done', JSON.stringify(done));
    assert.ok(child, 'foreground child never appeared');
    assert.equal(child.name, nameFromTask(task));
    assert.equal(child.name.length, 30);
    assert.equal(Object.hasOwn(child, 'roleId'), false);

    const parentHandle = await kernel.harness.conversation(conv.harnessId, kernel.context);
    const childHandle = await kernel.harness.conversation(childHarnessId(child), kernel.context);
    assert.ok(parentHandle && childHandle);
    const parentAgent = await parentHandle.agent(kernel.context);
    const childAgent = await childHandle.agent(kernel.context);
    assert.equal(childAgent.instructions ?? '', '');
    assert.deepEqual(childAgent.model, parentAgent.model);
    assert.equal(childAgent.cwd, parentAgent.cwd);
    assert.equal(childAgent.cwd, wsPath);
    const childToolNames = childAgent.tools.map((tool) => tool.name);
    assert.equal(childToolNames.includes('delegate'), false);
    assert.equal(childToolNames.includes('subagent'), false);
    assert.equal(childToolNames.includes('skill'), false);
    assert.equal(childToolNames.includes('read'), true);
    assert.equal(parentAgent.tools.some((tool) => tool.name === 'skill'), true);
    const parentDelegate = parentAgent.tools.find((tool) => tool.name === 'delegate');
    const parentSubagent = parentAgent.tools.find((tool) => tool.name === 'subagent');
    assert.deepEqual(toolPropertyKeys(parentDelegate.parameters), ['task']);
    assert.equal(toolPropertyKeys(parentSubagent.parameters).includes('agent'), false);
    assert.equal(toolPropertyKeys(parentSubagent.parameters).includes('name'), true);
    assert.equal(toolPropertyKeys(parentSubagent.parameters).includes('message'), true);
    assert.equal(parentAgent.sections.some((section) => section.key === 'subagents'), false);

    const records = (await readFile(record, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    const parentCall = records.find((row) => (row.tools || []).includes('delegate'));
    assert.ok(parentCall, JSON.stringify(records));
    assert.equal(/Pick a subagent/i.test(JSON.stringify(parentCall.sections || [])), false);
    const childCall = records.find((row) => (
      !(row.tools || []).includes('delegate')
      && (row.users || []).some((text) => String(text).includes('请确认前台子代理'))
    ));
    assert.ok(childCall, JSON.stringify(records));
    assert.equal(sectionInner(childCall, 'instructions'), '');
    assert.equal(sectionInner(childCall, 'skills'), '');
    assert.equal((childCall.tools || []).includes('skill'), false);
    assert.equal(/You are the default coding Agent/i.test(JSON.stringify(childCall.sections || [])), false);
    assert.equal(/Commit messages/i.test(JSON.stringify(childCall.sections || [])), false);
    assert.equal(/Skills you can load with the skill tool/i.test(JSON.stringify(childCall.sections || [])), false);
  } finally {
    if (kernel) await kernel.close();
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('background spawn reports the answer back to the main conversation', { timeout: 60000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-ksub-bg-'));
  const script = await writeScript(dataDir, 'parent.json', [
    { tool: 'subagent', args: { action: 'spawn', name: 'a', message: 'ping-a' } },
    { text: 'spawned' },
    { when: 'ping-a', text: 'SCOUT_PONG' },
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
    const worker = subagentsOf(done).find((agent) => agent.name === 'a');
    assert.ok(worker, JSON.stringify(done.agents));
    assert.equal(Object.hasOwn(worker, 'roleId'), false);
    assert.equal(worker.mode, 'background');
    assert.match(worker.lastText, /SCOUT_PONG/);
    const child = await request(srv.base, 'GET', `/api/conversations/${conv.body.id}/agents/${encodeURIComponent(worker.id)}/messages`);
    assert.equal(child.status, 200);
    assert.equal(child.body.mode, 'background');
    assert.equal(Object.hasOwn(child.body, 'roleId'), false);
    assert.ok(child.body.messages.some((message) => message.role === 'user' && message.text === 'ping-a'));
    assert.ok(child.body.messages.some((message) => message.role === 'assistant' && message.text === 'SCOUT_PONG'));
    const events = await pendingEvents;
    const agentEvent = events.find((ev) => ev.event === 'agent' && ev.data?.id === worker.id);
    assert.equal(agentEvent?.data?.mode, 'background');
  } finally {
    await stopServer(proc);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('stopping the conversation stops a background subagent', { timeout: 60000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-ksub-stop-'));
  const ready = path.join(dataDir, 'ready');
  const script = await writeScript(dataDir, 'parent.json', [
    { tool: 'subagent', args: { action: 'spawn', name: 'sleeper', message: 'hold' } },
    { text: 'spawned' },
    { when: 'hold', delayMs: 60000, text: 'SHOULD_NOT_FINISH' },
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
        WEFT_FAUX_HOLD_READY: ready,
      },
    });
    proc = srv.proc;
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
    const child = subagentsOf(after)[0];
    const messages = await request(srv.base, 'GET', `/api/conversations/${conv.body.id}/agents/${encodeURIComponent(child.id)}/messages`);
    assert.equal(messages.status, 200);
    assert.equal(messages.body.messages.some((message) => message.text === 'SHOULD_NOT_FINISH'), false);
  } finally {
    await stopServer(proc);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('a killed foreground subagent resumes the same child without a second submit', { timeout: 60000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-ksub-recover-'));
  const ready = path.join(dataDir, 'ready');
  const script = await writeScript(dataDir, 'parent.json', [
    { tool: 'delegate', args: { task: 'resume-task' } },
    { text: 'parent-resumed' },
    { when: 'resume-task', delayMs: 2500, text: 'RESUMED_CHILD' },
  ]);
  const env = {
    WEFT_RETRY_MAX: '2',
    WEFT_LLM: 'faux',
    WEFT_FAUX_SCRIPT: script,
    WEFT_FAUX_HOLD_READY: ready,
  };
  let proc = null;
  try {
    const first = await startServer({ token: TOKEN, env, dataDir });
    proc = first.proc;
    const ws = await request(first.base, 'POST', '/api/workspaces', { name: 'recover' });
    const conv = await request(first.base, 'POST', `/api/workspaces/${ws.body.id}/conversations`, { title: 'recover' });
    assert.equal((await request(first.base, 'POST', `/api/conversations/${conv.body.id}/messages`, { text: 'delegate' })).status, 202);
    await waitForFile(ready);
    const death = await killed(proc);
    proc = null;
    assert.ok(death.signal === 'SIGKILL' || death.code !== 0 || process.platform === 'win32');
    await rm(ready, { force: true });
    const second = await startServer({ token: TOKEN, env, dataDir });
    proc = second.proc;
    const done = await waitFor(second.base, conv.body.id, (body) => (
      toolTexts(body).some((text) => text.includes('RESUMED_CHILD'))
    ), 100);
    assert.match(toolTexts(done).join('\n'), /RESUMED_CHILD/, `${second.logs()}\n${JSON.stringify(done?.messages)}`);
    const child = subagentsOf(done).find((agent) => agent.mode === 'foreground');
    assert.ok(child);
    assert.equal(child.name, 'resume-task');
    const messages = await request(second.base, 'GET', `/api/conversations/${conv.body.id}/agents/${encodeURIComponent(child.id)}/messages`);
    assert.equal(messages.status, 200);
    const users = messages.body.messages.filter((message) => message.role === 'user');
    const assistants = messages.body.messages.filter((message) => message.role === 'assistant');
    assert.equal(users.length, 1, JSON.stringify(messages.body.messages));
    assert.equal(users[0].text, 'resume-task');
    assert.equal(assistants.length, 1);
    assert.equal(assistants[0].text, 'RESUMED_CHILD');
    assert.equal(subagentsOf(done).filter((agent) => agent.mode === 'foreground').length, 1);
  } finally {
    await stopServer(proc);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('a background subagent continues after restart and reports once', { timeout: 90000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-ksub-bgrecover-'));
  const ready = path.join(dataDir, 'ready');
  const script = await writeScript(dataDir, 'parent.json', [
    { tool: 'subagent', args: { action: 'spawn', name: 'bg', message: 'hold-bg' } },
    { text: 'parent-idle' },
    { when: 'hold-bg', delayMs: 2500, text: 'BG_ANSWER' },
  ]);
  const env = {
    WEFT_RETRY_MAX: '2',
    WEFT_LLM: 'faux',
    WEFT_FAUX_SCRIPT: script,
    WEFT_FAUX_HOLD_READY: ready,
  };
  let proc = null;
  try {
    const first = await startServer({ token: TOKEN, env, dataDir });
    proc = first.proc;
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
    await rm(ready, { force: true });
    const second = await startServer({ token: TOKEN, env, dataDir });
    proc = second.proc;
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
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('a killed foreground subagent writes the file once after restart', { timeout: 90_000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-ksub-write-'));
  const ready = path.join(dataDir, 'ready');
  const script = await writeScript(dataDir, 'write-child.json', [
    { tool: 'delegate', args: { task: 'WRITE_ONCE the output file' } },
    { text: 'parent-done' },
    { when: 'WRITE_ONCE', delayMs: 2500, tool: 'write', args: { path: 'child-out.txt', content: 'once\n' } },
    { when: 'WRITE_ONCE', text: 'child-wrote' },
  ]);
  const env = {
    WEFT_RETRY_MAX: '2',
    WEFT_LLM: 'faux',
    WEFT_FAUX_SCRIPT: script,
    WEFT_FAUX_HOLD_READY: ready,
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
    const children = subagentsOf(done).filter((agent) => agent.mode === 'foreground');
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
    { tool: 'delegate', args: { task: 'HOLD_CHILD' } },
    { text: 'parent-continued' },
    { when: 'HOLD_CHILD', delayMs: 60000, text: 'SHOULD_NOT_FINISH' },
  ]);
  const store = createSqliteStore(dataDir);
  let kernel = null;
  try {
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
        WEFT_LLM: 'faux',
        WEFT_FAUX_SCRIPT: script,
        WEFT_FAUX_HOLD_READY: ready,
        WEFT_RETRY_MAX: '2',
        WEFT_RETRY_BASE_MS: '20',
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
      scout = agents.find((agent) => agent.mode === 'foreground');
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
    assert.match(toolTexts(done).join('\n'), /\[subagent HOLD_CHILD was stopped by the user]/);
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
  const script = await writeScript(dataDir, 'stop-parent.json', [
    { tool: 'delegate', args: { task: 'hold-parent-stop' } },
    { text: 'parent-should-not-finish' },
    { when: 'hold-parent-stop', delayMs: 60000, text: 'CHILD_SHOULD_NOT_FINISH' },
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
        WEFT_FAUX_HOLD_READY: ready,
      },
    });
    proc = srv.proc;
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
    await rm(dataDir, { recursive: true, force: true });
  }
});

const EVIDENCE_DIR = '/tmp/t25-2-evidence';

async function writeEvidence(name, agent) {
  await mkdir(EVIDENCE_DIR, { recursive: true });
  await writeFile(path.join(EVIDENCE_DIR, name), `${JSON.stringify(agent, null, 2)}\n`);
}

test('foreground running agents[] has brief, timestamps, currentAction from description; done has endedAt', { timeout: 60000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-ksub-fields-fg-'));
  const ready = path.join(dataDir, 'ready');
  const task = 'Inspect auth.ts';
  const script = await writeScript(dataDir, 'fields-fg.json', [
    { tool: 'delegate', args: { task } },
    { text: 'parent-done' },
    { when: 'Inspect auth.ts', tool: 'read', args: { path: 'src/auth.ts', description: '看登录逻辑' } },
    { when: 'Inspect auth.ts', delayMs: 8000, text: 'child-read-done' },
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
        WEFT_FAUX_HOLD_READY: ready,
      },
    });
    proc = srv.proc;
    const ws = await request(srv.base, 'POST', '/api/workspaces', { name: 'fields-fg' });
    assert.equal(ws.status, 201);
    await mkdir(path.join(ws.body.path, 'src'), { recursive: true });
    await writeFile(path.join(ws.body.path, 'src/auth.ts'), 'export {}\n');
    const conv = await request(srv.base, 'POST', `/api/workspaces/${ws.body.id}/conversations`, { title: 'fields-fg' });
    assert.equal(conv.status, 201);
    const pendingEvents = collectSse(srv.base, conv.body.id, {
      ready: (list) => {
        const agents = list.filter((ev) => ev.event === 'agent' && String(ev.data?.id || '').includes(':sub:'));
        return agents.some((ev) => ev.data?.currentAction === '看登录逻辑' && ev.data?.brief === task)
          && agents.some((ev) => ev.data?.status === 'done' && ev.data?.endedAt != null && ev.data?.currentAction == null);
      },
      timeout: 45000,
    });
    assert.equal((await request(srv.base, 'POST', `/api/conversations/${conv.body.id}/messages`, { text: 'dispatch coder' })).status, 202);
    await waitForFile(ready);
    const runningBody = await waitFor(srv.base, conv.body.id, (body) => {
      const scout = subagentsOf(body)[0];
      return scout?.status === 'running' && scout?.currentAction === '看登录逻辑';
    });
    const running = subagentsOf(runningBody)[0];
    assertRunningActivity(running, { brief: task, currentAction: '看登录逻辑', mode: 'foreground' });
    await writeEvidence('foreground-running.json', running);

    const doneBody = await waitFor(srv.base, conv.body.id, (body) => {
      const scout = subagentsOf(body)[0];
      return body.status === 'done' && scout?.status === 'done' && assistantTexts(body).includes('parent-done');
    }, 120);
    const done = subagentsOf(doneBody)[0];
    assertDoneActivity(done, { brief: task, mode: 'foreground' });
    await writeEvidence('foreground-done.json', done);

    const events = await pendingEvents;
    const runningEvent = events.find((ev) => (
      ev.event === 'agent' && ev.data?.currentAction === '看登录逻辑' && ev.data?.brief === task
    ));
    assert.ok(runningEvent, JSON.stringify(events.filter((ev) => ev.event === 'agent')));
    assert.equal(runningEvent.data.mode, 'foreground');
    assertFiniteMs(runningEvent.data.startedAt, 'sse startedAt');
    assertFiniteMs(runningEvent.data.lastActivityAt, 'sse lastActivityAt');
    assert.equal(runningEvent.data.endedAt, undefined);
    const doneEvent = events.find((ev) => (
      ev.event === 'agent' && String(ev.data?.id || '').includes(':sub:') && ev.data?.status === 'done' && ev.data?.endedAt != null
    ));
    assert.ok(doneEvent, JSON.stringify(events.filter((ev) => ev.event === 'agent')));
    assert.equal(doneEvent.data.currentAction, undefined);
    assert.equal(doneEvent.data.brief, task);
  } finally {
    await stopServer(proc);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('background running agents[] uses tool:param currentAction; SSE carries the same fields', { timeout: 60000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-ksub-fields-bg-'));
  const ready = path.join(dataDir, 'ready');
  const task = 'RUN_TESTS please';
  const script = await writeScript(dataDir, 'fields-bg.json', [
    { tool: 'subagent', args: { action: 'spawn', name: 'worker', message: task } },
    { text: 'spawned' },
    { when: 'RUN_TESTS please', tool: 'bash', args: { command: 'npm test' } },
    { when: 'RUN_TESTS please', delayMs: 8000, text: 'tested' },
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
        WEFT_FAUX_HOLD_READY: ready,
      },
    });
    proc = srv.proc;
    const ws = await request(srv.base, 'POST', '/api/workspaces', { name: 'fields-bg' });
    const conv = await request(srv.base, 'POST', `/api/workspaces/${ws.body.id}/conversations`, { title: 'fields-bg' });
    const pendingEvents = collectSse(srv.base, conv.body.id, {
      ready: (list) => {
        const agents = list.filter((ev) => ev.event === 'agent' && ev.data?.mode === 'background');
        return agents.some((ev) => ev.data?.currentAction === 'bash: npm test' && ev.data?.brief === task)
          && agents.some((ev) => ev.data?.status === 'done' && ev.data?.endedAt != null && ev.data?.currentAction == null);
      },
      timeout: 45000,
    });
    assert.equal((await request(srv.base, 'POST', `/api/conversations/${conv.body.id}/messages`, { text: 'spawn worker' })).status, 202);
    await waitForFile(ready);
    const runningBody = await waitFor(srv.base, conv.body.id, (body) => {
      const worker = subagentsOf(body).find((agent) => agent.name === 'worker');
      return worker?.status === 'running' && worker?.currentAction === 'bash: npm test';
    });
    const running = subagentsOf(runningBody).find((agent) => agent.name === 'worker');
    assertRunningActivity(running, { brief: task, currentAction: 'bash: npm test', mode: 'background' });
    await writeEvidence('background-running.json', running);

    const doneBody = await waitFor(srv.base, conv.body.id, (body) => {
      const worker = subagentsOf(body).find((agent) => agent.name === 'worker');
      return worker?.status === 'done' && worker?.endedAt != null;
    }, 120);
    const done = subagentsOf(doneBody).find((agent) => agent.name === 'worker');
    assertDoneActivity(done, { brief: task, mode: 'background' });
    await writeEvidence('background-done.json', done);

    const events = await pendingEvents;
    const runningEvent = events.find((ev) => (
      ev.event === 'agent' && ev.data?.currentAction === 'bash: npm test' && ev.data?.brief === task
    ));
    assert.ok(runningEvent, JSON.stringify(events.filter((ev) => ev.event === 'agent')));
    assert.equal(runningEvent.data.mode, 'background');
    assertFiniteMs(runningEvent.data.startedAt, 'sse startedAt');
    const doneEvent = events.find((ev) => (
      ev.event === 'agent' && ev.data?.mode === 'background' && ev.data?.status === 'done' && ev.data?.endedAt != null
    ));
    assert.ok(doneEvent, JSON.stringify(events.filter((ev) => ev.event === 'agent')));
    assert.equal(doneEvent.data.currentAction, undefined);
  } finally {
    await stopServer(proc);
    await rm(dataDir, { recursive: true, force: true });
  }
});
