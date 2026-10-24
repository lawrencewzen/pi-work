import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { presentContext } from '../../src/core/usage.mjs';
import { createMapContext, mapHarnessBatch } from '../../src/kernel/events.mjs';
import { fauxTurnFromScript } from '../../src/kernel/faux-script.mjs';
import { applyStampedUsage, latestCallUsage } from '../../src/kernel/usage.mjs';
import { ROOT } from './_root.mjs';
import { request as serverRequest, startServer, stopServer } from './_server.mjs';

const TOKEN = 'unit-kernel-usage-token';
const EM = '—';
const FIRST = { prompt_tokens: 1000, completion_tokens: 10, total_tokens: 1010 };
const SECOND = { prompt_tokens: 1500, completion_tokens: 20, total_tokens: 1520 };
const request = (base, method, apiPath, body) => serverRequest(base, method, apiPath, body, TOKEN);

async function openConversation(base) {
  const ws = await request(base, 'POST', '/api/workspaces', { name: 'usage' });
  assert.equal(ws.status, 201);
  const conv = await request(base, 'POST', `/api/workspaces/${ws.body.id}/conversations`, { title: 'usage' });
  assert.equal(conv.status, 201);
  return conv.body;
}

async function waitFor(base, cid, ready, attempts = 80) {
  let body = null;
  for (let i = 0; i < attempts; i += 1) {
    const got = await request(base, 'GET', `/api/conversations/${cid}`);
    body = got.body;
    if (ready(body)) return body;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return body;
}

async function waitForFile(file, timeout = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      await access(file);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
  }
  throw new Error(`timed out waiting for ${file}`);
}

function assistant(text, usage, { omitted = false } = {}) {
  const message = {
    role: 'assistant',
    content: [{ type: 'text', text }],
    ...(usage ? { usage } : {}),
  };
  if (omitted) message.weftUsageOmitted = true;
  return { kind: 'pi.assistant', model: [message] };
}

test('usage events keep the latest call and ignore the cumulative ledger', () => {
  const ctx = createMapContext();
  const { events } = mapHarnessBatch([
    {
      type: 'message_end',
      entry: assistant('first', { input: 1000, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 1010 }),
    },
    {
      type: 'usage_changed',
      usage: { models: { 'faux/faux-1': { totalTokens: 99999 } }, tools: {} },
    },
    {
      type: 'message_end',
      entry: assistant('second', { input: 1500, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 1520 }),
    },
    {
      type: 'usage_changed',
      usage: { models: { 'faux/faux-1': { totalTokens: 1010 + 1520 } }, tools: {} },
    },
    {
      type: 'message_end',
      entry: assistant('plain', { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }, { omitted: true }),
    },
  ], ctx);
  const usage = events.filter((ev) => ev.event === 'usage');
  assert.equal(usage.length, 2);
  assert.equal(usage[0].data.usage.total, 1010);
  assert.equal(usage[0].data.contextLabel, '1k / 128k');
  assert.equal(usage[1].data.usage.total, 1520);
  assert.equal(usage[1].data.contextLabel, '1.5k / 128k');
  assert.equal(usage[1].data.contextWindow, 128000);
  assert.notEqual(usage[1].data.usage.total, 1010 + 1520);
  const overlayCtx = createMapContext({ contextWindow: 256000 });
  const overlay = mapHarnessBatch([
    {
      type: 'message_end',
      entry: assistant('first', {
        input: 1000,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 1010,
        contextWindow: 200000,
      }),
    },
  ], overlayCtx);
  const overlayUsage = overlay.events.find((ev) => ev.event === 'usage');
  assert.equal(overlayUsage.data.contextWindow, 256000);
  assert.equal(overlayUsage.data.contextLabel, '1k / 256k');
  assert.equal(events.some((ev) => JSON.stringify(ev).includes('99999')), false);
  const entries = [
    assistant('first', { input: 1000, output: 10, totalTokens: 1010 }),
    assistant('plain', { input: 0, output: 0, totalTokens: 0 }, { omitted: true }),
  ];
  assert.equal(latestCallUsage(entries).totalTokens, 1010);
  assert.equal(latestCallUsage([assistant('plain', { totalTokens: 0 }, { omitted: true })]), null);
});

test('a script turn replaces the faux estimate and an omitted turn does not clear it', () => {
  const script = [
    { text: 'first', usage: FIRST },
    { text: 'second', usage: SECOND },
    { text: 'plain' },
  ];
  const first = fauxTurnFromScript(script, { messages: [] });
  const estimated = {
    ...first,
    usage: { input: 4, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 8, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
  assert.equal(applyStampedUsage(estimated), true);
  assert.equal(estimated.usage.totalTokens, 1010);
  assert.equal(estimated.usage.input, 1000);

  const plain = fauxTurnFromScript(script, {
    messages: [{ role: 'assistant' }, { role: 'assistant' }],
  });
  applyStampedUsage(plain);
  assert.equal(plain.weftUsageOmitted, true);
  const kept = latestCallUsage([
    { kind: 'pi.assistant', model: [estimated] },
    { kind: 'pi.assistant', model: [plain] },
  ]);
  assert.equal(kept.totalTokens, 1010);
  assert.equal(presentContext(null).contextLabel, EM);
});

async function kernelPresented(script, window) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-kuse-'));
  const scriptPath = path.join(dataDir, 'faux.json');
  await writeFile(scriptPath, JSON.stringify(script));
  const srv = await startServer({
    token: TOKEN,
    dataDir,
    env: {
      WEFT_LLM: 'faux',
      WEFT_FAUX_SCRIPT: scriptPath,
      LLM_CONTEXT_WINDOW: window,
    },
  });
  try {
    const conv = await openConversation(srv.base);
    const bodies = [];
    for (let i = 0; i < script.turns.filter((turn) => turn.text != null).length; i += 1) {
      const sent = await request(srv.base, 'POST', `/api/conversations/${conv.id}/messages`, { text: `m${i}` });
      assert.equal(sent.status, 202, srv.logs());
      const body = await waitFor(srv.base, conv.id, (row) => (
        row.status === 'done' && row.messages.filter((msg) => msg.role === 'assistant').length >= i + 1
      ));
      assert.equal(body.status, 'done', srv.logs());
      bodies.push(body);
    }
    return bodies;
  } finally {
    await stopServer(srv);
    await rm(dataDir, { recursive: true, force: true });
  }
}

test('kernel usage chip matches the legacy script, including a later call with no usage', { timeout: 40000 }, async () => {
  const usageScript = JSON.parse(await readFile(path.join(ROOT, 'tests', 'fixtures', 'usage.json'), 'utf8'));
  const quietScript = JSON.parse(await readFile(path.join(ROOT, 'tests', 'fixtures', 'no-usage.json'), 'utf8'));
  const [kernelUsage] = await kernelPresented(usageScript, '200000');
  assert.equal(kernelUsage.contextLabel, '16.4k / 200k');
  assert.equal(kernelUsage.usage.total, 16400);
  assert.equal(kernelUsage.contextWindow, 200000);

  const [kernelQuiet] = await kernelPresented(quietScript, '200000');
  assert.equal(kernelQuiet.usage, null);
  assert.equal(kernelQuiet.contextLabel, EM);

  const overwrite = {
    turns: [
      { text: 'first', usage: FIRST },
      { text: 'second', usage: SECOND },
      { text: 'plain' },
    ],
  };
  const kernelBodies = await kernelPresented(overwrite, '128000');
  assert.equal(kernelBodies[0].contextLabel, '1k / 128k');
  assert.equal(kernelBodies[0].usage.total, 1010);
  assert.equal(kernelBodies[1].contextLabel, '1.5k / 128k');
  assert.equal(kernelBodies[1].usage.total, 1520);
  assert.equal(kernelBodies[1].contextWindow, 128000);
  assert.notEqual(kernelBodies[1].usage.total, 1010 + 1520);
  assert.equal(kernelBodies[2].contextLabel, '1.5k / 128k');
  assert.equal(kernelBodies[2].usage.total, 1520);
});

function holdSource(token) {
  return `import { access, writeFile } from 'node:fs/promises';
export async function hold(args) {
  if (args && args.started) await writeFile(String(args.started), 'seen');
  const release = args && args.release ? String(args.release) : '';
  if (release) {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      try {
        await access(release);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
  }
  return { output: ${JSON.stringify(token)}, status: 'completed' };
}
`;
}

async function writeHoldPlugin(dir, token) {
  const folder = path.join(dir, 'hold');
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, 'plugin.json'), `${JSON.stringify({
    id: 'hold',
    name: 'Hold',
    description: 'waits',
    version: '0.1.0',
    source: 'local',
    main: 'index.mjs',
    tools: [{ name: 'hold', description: 'Wait, then answer', parameters: { type: 'object', properties: {} } }],
  }, null, 2)}\n`);
  await writeFile(path.join(folder, 'index.mjs'), holdSource(token));
  return folder;
}

function toolNames(snapshot) {
  return snapshot?.tools || [];
}

async function readRecords(file) {
  const text = await readFile(file, 'utf8');
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

test('importing and toggling a plugin applies on the next request; a running call keeps its code', { timeout: 40000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-kplug-'));
  const srcRoot = await mkdtemp(path.join(tmpdir(), 'piw-kplug-src-'));
  const started = path.join(dataDir, 'started');
  const release = path.join(dataDir, 'release');
  const record = path.join(dataDir, 'requests.jsonl');
  const scriptPath = path.join(dataDir, 'faux.json');
  await writeFile(scriptPath, JSON.stringify({
    turns: [
      { tool: 'hold', args: { started, release } },
      { text: 'after' },
    ],
  }));
  const folder = await writeHoldPlugin(srcRoot, 'v1');
  const srv = await startServer({
    token: TOKEN,
    dataDir,
    env: {
      WEFT_LLM: 'faux',
      WEFT_FAUX_SCRIPT: scriptPath,
      WEFT_FAUX_RECORD: record,
    },
  });
  try {
    const conv = await openConversation(srv.base);
    const imported = await request(srv.base, 'POST', '/api/plugins', { path: folder });
    assert.equal(imported.status, 201, srv.logs());
    assert.equal(imported.body.id, 'hold');
    const sent = await request(srv.base, 'POST', `/api/conversations/${conv.id}/messages`, { text: 'run hold' });
    assert.equal(sent.status, 202, srv.logs());
    await waitForFile(started);
    const disabled = await request(srv.base, 'PUT', '/api/plugins/hold', { enabled: false });
    assert.equal(disabled.status, 200, srv.logs());
    assert.equal(disabled.body.enabled, false);
    await writeFile(release, 'go');
    const done = await waitFor(srv.base, conv.id, (body) => body.status === 'done' || body.status === 'failed');
    assert.equal(done.status, 'done', `${srv.logs()}\n${JSON.stringify(done)}`);
    assert.equal(done.messages.some((msg) => msg.role === 'tool' && msg.text === 'v1'), true);
    const calls = await readRecords(record);
    assert.equal(calls.length >= 2, true, JSON.stringify(calls));
    assert.equal(toolNames(calls[0]).includes('hold'), true);
    assert.equal(toolNames(calls[calls.length - 1]).includes('hold'), false);
  } finally {
    await stopServer(srv);
    await rm(dataDir, { recursive: true, force: true });
    await rm(srcRoot, { recursive: true, force: true });
  }
});

test('replacing a plugin module keeps the running call and serves the new code next', { timeout: 40000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-khot-'));
  const srcRoot = await mkdtemp(path.join(tmpdir(), 'piw-khot-src-'));
  const started = path.join(dataDir, 'started');
  const release = path.join(dataDir, 'release');
  const scriptPath = path.join(dataDir, 'faux.json');
  await writeFile(scriptPath, JSON.stringify({
    turns: [
      { tool: 'hold', args: { started, release } },
      { tool: 'hold', args: {} },
      { text: 'done' },
    ],
  }));
  const folder = await writeHoldPlugin(srcRoot, 'v1');
  const srv = await startServer({
    token: TOKEN,
    dataDir,
    env: {
      WEFT_LLM: 'faux',
      WEFT_FAUX_SCRIPT: scriptPath,
    },
  });
  try {
    const conv = await openConversation(srv.base);
    const imported = await request(srv.base, 'POST', '/api/plugins', { path: folder });
    assert.equal(imported.status, 201, srv.logs());
    const sent = await request(srv.base, 'POST', `/api/conversations/${conv.id}/messages`, { text: 'run hold' });
    assert.equal(sent.status, 202, srv.logs());
    await waitForFile(started);
    await writeFile(path.join(dataDir, 'plugins', 'hold', 'index.mjs'), holdSource('v2'));
    const reloaded = await request(srv.base, 'PUT', '/api/plugins/hold', { enabled: true });
    assert.equal(reloaded.status, 200, srv.logs());
    await writeFile(release, 'go');
    const done = await waitFor(srv.base, conv.id, (body) => body.status === 'done' || body.status === 'failed');
    assert.equal(done.status, 'done', `${srv.logs()}\n${JSON.stringify(done?.messages)}`);
    const outputs = (done.messages || []).filter((msg) => msg.role === 'tool').map((msg) => msg.text);
    assert.deepEqual(outputs, ['v1', 'v2']);
  } finally {
    await stopServer(srv);
    await rm(dataDir, { recursive: true, force: true });
    await rm(srcRoot, { recursive: true, force: true });
  }
});
