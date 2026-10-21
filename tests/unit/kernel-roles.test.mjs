import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
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

test('kernel path: switching role changes the system prompt, skills, and tool list', { timeout: 30000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-krole-'));
  const record = path.join(dataDir, 'requests.jsonl');
  const srv = await startServer({
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
    assert.equal('pipelineId' in opened.body, false);
    assert.equal('pipelineStep' in opened.body, false);
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
    assert.equal('pipelineId' in cleared.body, false);
    assert.equal('pipelineStep' in cleared.body, false);
  } finally {
    await stopProcess(srv.proc);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('kernel path: PATCH while busy is 409 err_role_busy', { timeout: 30000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-krole-busy-'));
  const ready = path.join(dataDir, 'hold-ready');
  const srv = await startServer({
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

