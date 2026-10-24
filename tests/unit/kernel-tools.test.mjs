import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Type } from '@earendil-works/pi-ai';
import { parseSSE } from '../../src/core/sse.mjs';
import { fauxTurnFromScript, offeredToolNames } from '../../src/kernel/faux-script.mjs';
import { withIntent, workspaceTools } from '../../src/kernel/tools.mjs';
import { createWorkspaceEnv } from '../../src/kernel/workspace-env.mjs';
import { ROOT } from './_root.mjs';
import { killChild, request as serverRequest, startServer, stopServer } from './_server.mjs';

const TOKEN = 'unit-kernel-tools-token';
const README = 'docs/deep/nested/folder/structure/README.md';
const BASIC = path.join(ROOT, 'tests/fixtures/basic.json');
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

async function openConversation(base, { title = 'kernel', name = 'kernel-ws' } = {}) {
  const ws = await request(base, 'POST', '/api/workspaces', { name });
  assert.equal(ws.status, 201, JSON.stringify(ws.body));
  const conv = await request(base, 'POST', `/api/workspaces/${ws.body.id}/conversations`, { title });
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
    WEFT_LLM: 'faux',
    WEFT_FAUX_SCRIPT: script,
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

test('workspaceTools lists every builtin tool in order', () => {
  assert.deepEqual(workspaceTools().map((tool) => tool.name), ['read', 'write', 'edit', 'ls', 'grep', 'bash']);
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

test('withIntent: bash with description runs; the original tool does not see it', async () => {
  let seen;
  const wrapped = withIntent({
    name: 'bash',
    description: 'run a command',
    parameters: Type.Object({
      command: Type.String(),
      timeout: Type.Optional(Type.Number()),
    }),
    async execute(args) {
      seen = args;
      return { output: [{ type: 'text', text: 'ok' }] };
    },
  });
  assert.ok(wrapped.parameters.properties.description);
  assert.equal(wrapped.parameters.required?.includes('description'), false);
  const prepared = wrapped.prepareArguments({ command: 'echo hi', description: '打招呼', timeout: 5 });
  assert.equal(prepared.command, 'echo hi');
  assert.equal(prepared.timeout, 5);
  assert.equal(prepared.description, '打招呼');
  const result = await wrapped.execute({ command: 'echo hi', description: '打招呼' }, {}, {});
  assert.deepEqual(seen, { command: 'echo hi' });
  assert.equal(result.output[0].text, 'ok');

  for (const tool of workspaceTools()) {
    assert.ok(tool.parameters?.properties?.description, tool.name);
    assert.equal((tool.parameters.required || []).includes('description'), false, tool.name);
  }
  const bash = workspaceTools().find((tool) => tool.name === 'bash');
  const dir = await mkdtemp(path.join(tmpdir(), 'piw-intent-'));
  const env = await createWorkspaceEnv({ cwd: dir });
  const chunks = [];
  try {
    const command = process.platform === 'win32' ? 'echo intent-ok' : 'printf intent-ok';
    const ran = await bash.execute(
      { command, description: '打招呼' },
      {
        env,
        output(text) { chunks.push(String(text ?? '')); },
        retainedOutput() { return { text: chunks.join(''), truncated: false }; },
        diagnostic() {},
      },
      BACKGROUND_CONTEXT,
    );
    const text = `${chunks.join('')}${ran?.structuredOutput?.output || ''}`;
    assert.equal(text.includes('intent-ok'), true, JSON.stringify({ chunks, ran }));
  } finally {
    await env.cleanup(BACKGROUND_CONTEXT).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
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

test('a tools array is one assistant message with each call', () => {
  const turns = [
    {
      tools: [
        { tool: 'read', args: { path: 'a.txt' }, id: 'a' },
        { tool: 'read', args: { path: 'b.txt' }, id: 'b' },
        { tool: 'ls', args: { path: '.' }, id: 'c' },
      ],
    },
  ];
  const message = fauxTurnFromScript(turns, { messages: [{ role: 'user', content: 'go' }] });
  assert.equal(message.stopReason, 'toolUse');
  assert.deepEqual(message.content.map((block) => block.name), ['read', 'read', 'ls']);
  assert.deepEqual(message.content.map((block) => block.id), ['a', 'b', 'c']);
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
  const srv = await startServer({ token: TOKEN, env: durableEnv(script), dataDir });
  try {
    const { ws, conv } = await openConversation(srv.base, { title: 'sandbox' });
    const outside = path.join(ws.path, '..', 'outside.txt');
    await writeFile(outside, 'secret');
    const pendingEvents = collectSse(srv.base, conv.id, {
      ready: (list) => list.some((ev) => ev.event === 'tool.end' && ev.data?.tool?.id === 'escape-read')
        && list.some((ev) => ev.event === 'tool.start' && ev.data?.tool?.id === 'bash-1')
        && list.some((ev) => ev.event === 'status' && ev.data?.status === 'done'),
    });
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
    const events = await pendingEvents;
    const escape = events.find((ev) => ev.event === 'tool.end' && ev.data?.tool?.id === 'escape-read');
    assert.equal(escape?.data?.tool?.path, '../outside.txt');
    assert.equal(escape?.data?.tool?.status, 'error');
    const started = events.find((ev) => ev.event === 'tool.start' && ev.data?.tool?.id === 'bash-1');
    assert.equal(started?.data?.tool?.status, 'running');
  } finally {
    await stopServer(srv);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('kernel path: bash runs a quoted node path and a script in a directory with spaces', { timeout: 40_000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-kquote-'));
  const nodeBin = process.execPath;
  const printOne = `"${nodeBin}" -e "console.log(1)"`;
  const spaced = `"${nodeBin}" "dir with spaces/hi.cjs"`;
  const script = await writeScript(dataDir, 'quoted.json', [
    { tool: 'bash', args: { command: printOne }, id: 'quote-eval' },
    { tool: 'bash', args: { command: spaced }, id: 'quote-space' },
    { text: 'quoted-done' },
  ]);
  const srv = await startServer({ token: TOKEN, env: durableEnv(script), dataDir });
  try {
    const { ws, conv } = await openConversation(srv.base, { title: 'quoted' });
    const dir = path.join(ws.path, 'dir with spaces');
    await mkdir(dir);
    await writeFile(path.join(dir, 'hi.cjs'), "console.log('space-ok');\n");
    const sent = await request(srv.base, 'POST', `/api/conversations/${conv.id}/messages`, { text: 'go' });
    assert.equal(sent.status, 202);
    const done = await waitFinished(srv.base, conv.id);
    assert.equal(done.status, 'done', `${JSON.stringify(done)}\n${srv.logs()}`);
    const tools = done.messages.filter((message) => message.role === 'tool').map((message) => message.text || '');
    assert.equal(tools.length, 2, JSON.stringify(tools));
    assert.equal(tools[0].includes('1'), true, tools[0]);
    assert.equal(tools[1].includes('space-ok'), true, tools[1]);
    assert.equal(done.messages.some((message) => message.role === 'assistant' && message.text === 'quoted-done'), true);
  } finally {
    await stopServer(srv);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('kernel path: two conversations write into their own workspaces', { timeout: 40_000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-kcwd-'));
  const script = await writeScript(dataDir, 'own.json', [
    { tool: 'write', args: { path: 'own.txt', content: 'mine' }, id: 'own' },
    { text: 'wrote-own' },
  ]);
  const srv = await startServer({ token: TOKEN, env: durableEnv(script), dataDir });
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
    await stopServer(srv);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('kernel path: write plus edit records the diff and tool events', { timeout: 60_000 }, async () => {
  const srv = await startServer({ token: TOKEN, env: { WEFT_LLM: 'faux', WEFT_FAUX_SCRIPT: BASIC } });
  try {
    const { conv } = await openConversation(srv.base, { title: 'diff' });
    const pendingEvents = collectSse(srv.base, conv.id, {
      ready: (list) => list.some((ev) => ev.event === 'tool.end' && ev.data?.tool?.name === 'edit')
        && list.some((ev) => ev.event === 'status' && ev.data?.status === 'done'),
    });
    const sent = await request(srv.base, 'POST', `/api/conversations/${conv.id}/messages`, { text: 'please' });
    assert.equal(sent.status, 202, JSON.stringify(sent.body));
    const done = await waitFinished(srv.base, conv.id);
    assert.equal(done.status, 'done', JSON.stringify(done.messages));
    assert.equal(done.messages.some((message) => String(message.text || '').includes('README')), true, JSON.stringify(done.messages));
    assert.equal(done.messages.some((message) => message.text === '完成 ✅'), true, JSON.stringify(done.messages));
    const changes = await request(srv.base, 'GET', `/api/conversations/${conv.id}/changes`);
    const diff = await request(srv.base, 'GET', `/api/conversations/${conv.id}/diff?path=${encodeURIComponent(README)}`);
    assert.equal(changes.status, 200, JSON.stringify(changes.body));
    assert.equal(diff.status, 200, JSON.stringify(diff.body));
    assert.deepEqual(changeView(changes.body), [{ path: README, added: diff.body.added, removed: diff.body.removed }]);
    assert.equal(diff.body.before, '');
    assert.equal(diff.body.after, '# Hello\n\nline two\nline3\n');
    assert.equal(diff.body.added > 0, true);
    assert.equal(typeof changes.body[0]?.toolCallId, 'string');
    assert.equal(changes.body[0].toolCallId.length > 0, true);
    const events = await pendingEvents;
    const ends = events.filter((ev) => ev.event === 'tool.end' && (ev.data?.tool?.name === 'write' || ev.data?.tool?.name === 'edit'));
    assert.equal(ends.length, 2, JSON.stringify(events.map((ev) => ev.event)));
    for (const ev of ends) {
      assert.equal(ev.data.tool.path, README);
      assert.equal(typeof ev.data.tool.added, 'number');
      assert.equal(typeof ev.data.tool.removed, 'number');
      assert.equal(ev.data.tool.status, 'completed');
    }
    const starts = events.filter((ev) => ev.event === 'tool.start' && (ev.data?.tool?.name === 'write' || ev.data?.tool?.name === 'edit'));
    assert.equal(starts.length, 2);
    for (const ev of starts) {
      assert.equal(ev.data.tool.path, README);
      assert.equal(ev.data.tool.status, 'running');
    }
  } finally {
    await stopServer(srv);
    await rm(srv.dataDir, { recursive: true, force: true });
  }
});

test('kernel path: the main agent offers every workspace tool plus plugins and dispatch', { timeout: 40_000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-ktools-'));
  const toolLog = path.join(dataDir, 'tools.log');
  const script = await writeScript(dataDir, 'tools.json', [
    { text: 'all-tools' },
  ]);
  const srv = await startServer({ token: TOKEN, env: durableEnv(script, { WEFT_FAUX_TOOL_LOG: toolLog }), dataDir });
  try {
    const { conv } = await openConversation(srv.base, { title: 'tools' });
    const sent = await request(srv.base, 'POST', `/api/conversations/${conv.id}/messages`, { text: 'go' });
    assert.equal(sent.status, 202);
    const done = await waitFinished(srv.base, conv.id);
    assert.equal(done.status, 'done', JSON.stringify(done.messages));
    const offered = (await readFile(toolLog, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    for (const name of ['read', 'write', 'edit', 'ls', 'grep', 'bash', 'echo', 'skill', 'delegate', 'subagent']) {
      assert.equal(offered[0].includes(name), true, name);
    }
  } finally {
    await stopServer(srv);
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
  const first = await startServer({ token: TOKEN, env, dataDir });
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

  const second = await startServer({ token: TOKEN, env, dataDir });
  try {
    const done = await waitFinished(second.base, convId, 20000);
    assert.equal(done.status, 'done', JSON.stringify(done.messages));
    const tool = done.messages.find((message) => message.role === 'tool');
    assert.equal(String(tool?.text || '').includes('interrupted'), true, JSON.stringify(done.messages));
    assert.equal(done.messages.some((message) => message.role === 'assistant' && message.text === 'continued'), true, JSON.stringify(done.messages));
    assert.deepEqual(await readFile(path.join(workspacePath, 'ran-count')), marker);
  } finally {
    await stopServer(second);
    await rm(dataDir, { recursive: true, force: true });
  }
});
