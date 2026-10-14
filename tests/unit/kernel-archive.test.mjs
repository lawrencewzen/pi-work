import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  archivedMutation,
  isArchivedConversation,
  openingContext,
  visibleTurns,
} from '../../src/kernel/archive.mjs';
import { ROOT } from './_root.mjs';

const TOKEN = 'unit-kernel-archive-token';
const STRIP = [
  'PI_WORK_LLM',
  'PI_WORK_FAUX_SCRIPT',
  'PI_WORK_FAUX_TEXT',
  'PI_WORK_FAUX_HOLD',
  'PI_WORK_FAUX_HOLD_READY',
  'PI_WORK_FAUX_TOOL_LOG',
  'PI_WORK_FAUX_RECORD',
  'PI_WORK_FAUX_PLAN',
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

function waitExit(proc) {
  return new Promise((resolve) => {
    if (proc.exitCode != null || proc.signalCode != null) return resolve();
    proc.once('exit', resolve);
  });
}

async function startServer(extra = {}, { dataDir, expectReady = true } = {}) {
  dataDir ??= await mkdtemp(path.join(tmpdir(), 'piw-karch-'));
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

function storedRow(dataDir, id) {
  const db = new DatabaseSync(path.join(dataDir, 'pi-work.sqlite'), { readOnly: true });
  try {
    return db.prepare('SELECT status, auto_continues, harness_id FROM conversations WHERE id = ?').get(id);
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

test('visible history keeps user and assistant text and drops tool rows', () => {
  const messages = [
    { role: 'user', text: ' please ' },
    { role: 'assistant', text: '开始写' },
    { role: 'tool', text: 'wrote notes.txt (+1 −0)', tool: { name: 'write' } },
    { role: 'assistant', text: '   ' },
    { role: 'assistant', text: '写好了' },
  ];
  assert.deepEqual(visibleTurns(messages), [
    { role: 'user', text: 'please' },
    { role: 'assistant', text: '开始写' },
    { role: 'assistant', text: '写好了' },
  ]);
  const text = openingContext(messages);
  assert.match(text, /User:\nplease/);
  assert.match(text, /Assistant:\n开始写/);
  assert.match(text, /Assistant:\n写好了/);
  assert.equal(text.includes('wrote notes.txt'), false);
  assert.equal(text.includes('write'), false);
  assert.equal(openingContext([{ role: 'tool', text: 'only a tool' }]), '');
  assert.equal(isArchivedConversation({ harnessId: null }), true);
  assert.equal(isArchivedConversation({ harnessId: 4 }), false);
  assert.equal(isArchivedConversation(null), false);
  assert.deepEqual(archivedMutation(), { status: 409, body: { error: 'err_archived', status: 'archived' } });
});

test('kernel path: an old conversation is readable, read-only, and can open a new one', { timeout: 60000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-karch-'));
  const script = path.join(dataDir, 'write.json');
  const record = path.join(dataDir, 'requests.jsonl');
  await writeFile(script, JSON.stringify({
    turns: [
      { text: '开始写' },
      { tool: 'write', args: { path: 'notes.txt', content: 'alpha\n' } },
      { text: '写好了' },
    ],
  }));
  const legacy = await startServer({ PI_WORK_LLM: 'faux', PI_WORK_FAUX_SCRIPT: script }, { dataDir });
  let oldId;
  let workspaceId;
  let legacyMessages;
  let legacyChanges;
  let legacyDiff;
  let legacyContinues;
  try {
    const ws = await request(legacy.base, 'POST', '/api/workspaces', { name: 'archive' });
    assert.equal(ws.status, 201, JSON.stringify(ws.body));
    workspaceId = ws.body.id;
    const conv = await request(legacy.base, 'POST', `/api/workspaces/${workspaceId}/conversations`, { title: 'old' });
    assert.equal(conv.status, 201, JSON.stringify(conv.body));
    oldId = conv.body.id;
    const missing = await request(legacy.base, 'POST', `/api/conversations/${oldId}/from-history`, {});
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error, 'not found');
    const sent = await request(legacy.base, 'POST', `/api/conversations/${oldId}/messages`, { text: 'please keep this sentence' });
    assert.equal(sent.status, 202, JSON.stringify(sent.body));
    const done = await waitFinished(legacy.base, oldId);
    assert.equal(done.status, 'done', JSON.stringify(done.messages));
    assert.equal(Object.hasOwn(done, 'archived'), false);
    assert.equal(done.messages.some((message) => message.role === 'tool'), true);
    assert.equal(done.messages.some((message) => message.text === '写好了'), true);
    legacyMessages = done.messages;
    legacyContinues = done.autoContinues;
    const changes = await request(legacy.base, 'GET', `/api/conversations/${oldId}/changes`);
    const diff = await request(legacy.base, 'GET', `/api/conversations/${oldId}/diff?path=${encodeURIComponent('notes.txt')}`);
    assert.equal(changes.status, 200, JSON.stringify(changes.body));
    assert.equal(diff.status, 200, JSON.stringify(diff.body));
    assert.equal(diff.body.after, 'alpha\n');
    legacyChanges = changes.body;
    legacyDiff = diff.body;
  } finally {
    await stopProcess(legacy.proc);
  }

  const kernel = await startServer({
    PI_WORK_KERNEL: 'durable',
    PI_WORK_LLM: 'faux',
    PI_WORK_FAUX_TEXT: 'continued',
    PI_WORK_FAUX_RECORD: record,
  }, { dataDir });
  let newId;
  try {
    const listed = await request(kernel.base, 'GET', `/api/workspaces/${workspaceId}/conversations`);
    assert.equal(listed.status, 200);
    const oldRow = listed.body.find((item) => item.id === oldId);
    assert.equal(oldRow.status, 'archived');
    assert.equal(oldRow.archived, true);
    assert.equal(Object.hasOwn(oldRow, 'messages'), false);
    assert.equal(Object.hasOwn(oldRow, 'harnessId'), false);

    const got = await request(kernel.base, 'GET', `/api/conversations/${oldId}`);
    assert.equal(got.status, 200);
    assert.equal(got.body.status, 'archived');
    assert.equal(got.body.archived, true);
    assert.equal(got.body.autoContinues, legacyContinues);
    assert.deepEqual(got.body.messages, legacyMessages);
    const blocked = await request(kernel.base, 'POST', `/api/conversations/${oldId}/messages`, { text: 'more' });
    assert.equal(blocked.status, 409);
    assert.deepEqual(blocked.body, { error: 'err_archived', status: 'archived' });
    const resumed = await request(kernel.base, 'POST', `/api/conversations/${oldId}/resume`, {});
    assert.equal(resumed.status, 409);
    assert.equal(resumed.body.error, 'err_archived');
    const paused = await request(kernel.base, 'POST', `/api/conversations/${oldId}/pause`, {});
    assert.equal(paused.status, 409);
    assert.equal(paused.body.error, 'err_archived');
    const patched = await request(kernel.base, 'PATCH', `/api/conversations/${oldId}`, { roleId: 'coder' });
    assert.equal(patched.status, 409);
    assert.equal(patched.body.error, 'err_archived');
    const still = await request(kernel.base, 'GET', `/api/conversations/${oldId}`);
    assert.equal(still.body.status, 'archived');
    assert.equal(still.body.autoContinues, legacyContinues);
    assert.deepEqual(still.body.messages, legacyMessages);
    const changes = await request(kernel.base, 'GET', `/api/conversations/${oldId}/changes`);
    const diff = await request(kernel.base, 'GET', `/api/conversations/${oldId}/diff?path=${encodeURIComponent('notes.txt')}`);
    assert.deepEqual(changes.body, legacyChanges);
    assert.deepEqual(diff.body, legacyDiff);

    const opened = await request(kernel.base, 'POST', `/api/conversations/${oldId}/from-history`, { title: 'forked' });
    assert.equal(opened.status, 201, JSON.stringify(opened.body));
    assert.equal(opened.body.status, 'idle');
    assert.equal(opened.body.title, 'forked');
    assert.equal(opened.body.workspaceId, workspaceId);
    assert.equal(opened.body.sourceConversationId, oldId);
    assert.notEqual(opened.body.id, oldId);
    newId = opened.body.id;
    const fresh = await request(kernel.base, 'GET', `/api/conversations/${newId}`);
    assert.equal(fresh.body.status, 'idle');
    assert.equal(Object.hasOwn(fresh.body, 'archived'), false);
    assert.deepEqual(fresh.body.messages, []);
    const notOld = await request(kernel.base, 'POST', `/api/conversations/${newId}/from-history`, {});
    assert.equal(notOld.status, 409);
    assert.equal(notOld.body.error, 'err_not_archived');

    const sent = await request(kernel.base, 'POST', `/api/conversations/${newId}/messages`, { text: 'hello-new' });
    assert.equal(sent.status, 202, JSON.stringify(sent.body));
    const done = await waitFinished(kernel.base, newId);
    assert.equal(done.status, 'done', kernel.logs());
    assert.deepEqual(done.messages.map((message) => ({ role: message.role, text: message.text })), [
      { role: 'user', text: 'hello-new' },
      { role: 'assistant', text: 'continued' },
    ]);
    const [call] = await readRecords(record);
    assert.deepEqual(call.users, ['hello-new']);
    const context = sectionText(call, 'archive-context');
    assert.match(context, /please keep this sentence/);
    assert.match(context, /开始写/);
    assert.match(context, /写好了/);
    assert.equal(context.includes('wrote notes.txt'), false);
    assert.equal(context.includes('alpha'), false);
  } finally {
    await stopProcess(kernel.proc);
  }

  const again = await startServer({
    PI_WORK_KERNEL: 'durable',
    PI_WORK_LLM: 'faux',
    PI_WORK_FAUX_TEXT: 'continued',
    PI_WORK_FAUX_RECORD: record,
  }, { dataDir });
  try {
    const old = await request(again.base, 'GET', `/api/conversations/${oldId}`);
    assert.equal(old.body.status, 'archived');
    assert.deepEqual(old.body.messages, legacyMessages);
    const diff = await request(again.base, 'GET', `/api/conversations/${oldId}/diff?path=${encodeURIComponent('notes.txt')}`);
    assert.deepEqual(diff.body, legacyDiff);
    const kept = await request(again.base, 'GET', `/api/conversations/${newId}`);
    assert.equal(kept.body.status, 'done');
    assert.equal(kept.body.messages.some((message) => message.role === 'user' && message.text === 'hello-new'), true);
    assert.equal(kept.body.messages.some((message) => message.role === 'assistant' && message.text === 'continued'), true);
    const sent = await request(again.base, 'POST', `/api/conversations/${newId}/messages`, { text: 'again' });
    assert.equal(sent.status, 202, JSON.stringify(sent.body));
    const done = await waitFinished(again.base, newId);
    assert.equal(done.messages.filter((message) => message.role === 'assistant' && message.text === 'continued').length, 2);
    const calls = await readRecords(record);
    const last = calls[calls.length - 1];
    assert.deepEqual(last.users, ['hello-new', 'again']);
    assert.match(sectionText(last, 'archive-context'), /please keep this sentence/);
    assert.equal(sectionText(last, 'archive-context').includes('wrote notes.txt'), false);
  } finally {
    await stopProcess(again.proc);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('kernel path: a running old conversation is not resumed', { timeout: 40000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-karch-run-'));
  const script = path.join(dataDir, 'hold.json');
  await writeFile(script, JSON.stringify({
    turns: [
      { delayMs: 60000 },
      { text: 'should-not-run' },
    ],
  }));
  const legacy = await startServer({ PI_WORK_LLM: 'faux', PI_WORK_FAUX_SCRIPT: script }, { dataDir });
  let id;
  try {
    const ws = await request(legacy.base, 'POST', '/api/workspaces', { name: 'running' });
    assert.equal(ws.status, 201);
    const conv = await request(legacy.base, 'POST', `/api/workspaces/${ws.body.id}/conversations`, { title: 'running' });
    assert.equal(conv.status, 201);
    id = conv.body.id;
    const sent = await request(legacy.base, 'POST', `/api/conversations/${id}/messages`, { text: 'do-not-resume' });
    assert.equal(sent.status, 202, JSON.stringify(sent.body));
    const live = await request(legacy.base, 'GET', `/api/conversations/${id}`);
    assert.equal(live.body.status, 'running');
    assert.equal(live.body.autoContinues, 0);
  } finally {
    killChild(legacy.proc);
    await waitExit(legacy.proc);
  }

  const kernel = await startServer({
    PI_WORK_KERNEL: 'durable',
    PI_WORK_LLM: 'faux',
    PI_WORK_FAUX_TEXT: 'continued',
  }, { dataDir });
  try {
    await new Promise((resolve) => setTimeout(resolve, 400));
    const got = await request(kernel.base, 'GET', `/api/conversations/${id}`);
    assert.equal(got.body.status, 'archived');
    assert.equal(got.body.archived, true);
    assert.equal(got.body.autoContinues, 0);
    assert.equal(got.body.messages.some((message) => message.text === 'should-not-run'), false);
    assert.equal(got.body.messages.some((message) => message.role === 'user' && message.text === 'do-not-resume'), true);
    const resumed = await request(kernel.base, 'POST', `/api/conversations/${id}/resume`, {});
    assert.equal(resumed.status, 409);
    assert.equal(resumed.body.error, 'err_archived');
    const row = storedRow(dataDir, id);
    assert.equal(row.status, 'running');
    assert.equal(row.auto_continues, 0);
    assert.equal(row.harness_id, null);
    const after = await request(kernel.base, 'GET', `/api/conversations/${id}`);
    assert.equal(after.body.messages.some((message) => message.text === 'should-not-run'), false);
  } finally {
    await stopProcess(kernel.proc);
    await rm(dataDir, { recursive: true, force: true });
  }
});
