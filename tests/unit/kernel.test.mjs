import { spawn } from 'node:child_process';
import { mkdtemp, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry } from '@earendil-works/pi-durable';
import { FAUX_MODEL, openKernel, registerFaux } from '../../src/kernel/index.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const workerPath = path.join(here, 'kernel-recover-worker.mjs');
const closedWorkerPath = path.join(here, 'kernel-closed-worker.mjs');

function catalog() {
  const models = createModels();
  const faux = registerFaux(models);
  return { models, faux, registry: createRegistry() };
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

test('open, close, and reopen the same root', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pi-kernel-open-'));
  const firstCatalog = catalog();
  const first = await openKernel({ dataDir: dir, models: firstCatalog.models, registry: firstCatalog.registry });
  try {
    await assert.rejects(
      openKernel({ dataDir: dir, models: firstCatalog.models, registry: firstCatalog.registry }),
      /already open/,
    );
    await access(path.join(dir, 'harness', 'session.sqlite'));
    assert.equal(first.storagePath, path.join(path.resolve(dir), 'harness', 'session.sqlite'));
    const root = await first.harness.root(first.context);
    await first.close();
    const secondCatalog = catalog();
    const second = await openKernel({ dataDir: dir, models: secondCatalog.models, registry: secondCatalog.registry });
    try {
      const again = await second.harness.root(second.context);
      assert.equal(again.id, root.id);
    } finally {
      await second.close();
    }
  } finally {
    await first.close();
  }
});

test('same requestId returns the same submission', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pi-kernel-submit-'));
  const { models, faux, registry } = catalog();
  faux.setResponses([
    fauxAssistantMessage('hello'),
    fauxAssistantMessage('second-call'),
  ]);
  const kernel = await openKernel({ dataDir: dir, models, registry });
  try {
    const first = await kernel.submit({ content: 'ping', requestId: 'greeting-1', model: FAUX_MODEL });
    assert.equal(first.settled.status, 'done');
    const second = await kernel.submit({
      conversation: first.conversation,
      content: 'ping again',
      requestId: 'greeting-1',
    });
    assert.equal(second.submission.id, first.submission.id);
    assert.equal(second.conversation.id, first.conversation.id);
    assert.equal(second.settled.status, 'done');
    assert.equal(faux.state.callCount, 1);
    const record = await kernel.harness.commit(
      (tx) => tx.submissionByRequest(first.conversation.id, 'greeting-1'),
      kernel.context,
    );
    assert.equal(record?.id, first.submission.id);
    assert.equal(record?.status, 'done');
  } finally {
    await kernel.close();
  }
  const rows = submissionRows(dir);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].record.requestId, 'greeting-1');
  assert.equal(rows[0].status, 'done');
});

function killChild(child) {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  child.kill('SIGKILL');
}

function spawnWorker(mode, env) {
  const child = spawn(process.execPath, [workerPath], {
    env: { ...process.env, ...env, PI_WORK_KERNEL_MODE: mode },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  const take = (chunk) => { out += chunk; };
  child.stdout.on('data', take);
  child.stderr.on('data', take);
  const exited = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code, signal) => resolve({ code, signal, out }));
  });
  return { child, exited };
}

async function waitForFile(file, ms) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    try {
      await access(file);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
  }
  throw new Error(`timeout waiting for ${file}`);
}

function spawnClosedWorker(mode) {
  const child = spawn(process.execPath, [closedWorkerPath], {
    env: { ...process.env, PI_WORK_KERNEL_MODE: mode },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  const take = (chunk) => { out += chunk; };
  child.stdout.on('data', take);
  child.stderr.on('data', take);
  const exited = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code, signal) => resolve({ code, signal, out }));
  });
  return { child, exited };
}

test('harness.closed with a storage error logs and exits the process', { timeout: 20_000 }, async () => {
  const failed = spawnClosedWorker('fail');
  const result = await failed.exited;
  assert.equal(result.code, 1, result.out);
  assert.match(result.out, /PI_WORK_HARNESS_CLOSED/);
  assert.match(result.out, /disk full/);
});

test('harness.closed after close() does not exit the process', { timeout: 20_000 }, async () => {
  const closed = spawnClosedWorker('close');
  const result = await closed.exited;
  assert.equal(result.code, 0, result.out);
  assert.equal(result.out.includes('PI_WORK_HARNESS_CLOSED'), false, result.out);
});

test('kill after submit, then resume finishes the same submission', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pi-kernel-recover-'));
  const dataDir = path.join(dir, 'data');
  const env = {
    PI_WORK_KERNEL_DATA: dataDir,
    PI_WORK_KERNEL_READY: path.join(dir, 'ready'),
    PI_WORK_KERNEL_RESULT: path.join(dir, 'result.json'),
  };
  const crash = spawnWorker('crash', env);
  let killed;
  try {
    const early = crash.exited;
    const ready = await Promise.race([
      waitForFile(env.PI_WORK_KERNEL_READY, 20_000).then(() => 'ready'),
      early.then((exit) => exit),
    ]);
    assert.equal(ready, 'ready', `crash worker exited before the model call: ${crash.child.pid} ${JSON.stringify(ready)}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
    killChild(crash.child);
    killed = await early;
  } finally {
    if (crash.child.exitCode === null && crash.child.signalCode === null) killChild(crash.child);
  }
  assert.ok(killed, 'crash worker did not exit');
  if (process.platform === 'win32') {
    assert.notEqual(killed.code, 0, `taskkill did not stop the worker: ${killed.out}`);
  } else {
    assert.equal(killed.signal, 'SIGKILL', `worker was not killed: code=${killed.code} signal=${killed.signal}\n${killed.out}`);
  }
  const resumed = spawnWorker('resume', env);
  const resultExit = await resumed.exited;
  assert.equal(resultExit.code, 0, `resume worker failed\n${resultExit.out}`);
  const result = JSON.parse(await readFile(env.PI_WORK_KERNEL_RESULT, 'utf8'));
  assert.equal(result.status, 'done');
  assert.equal(result.requestId, 'recover-1');
  assert.equal(result.sameSubmission, true);
  assert.equal(result.conversations, 1);
  assert.match(result.answer, /resumed-ok/);
  const rows = submissionRows(dataDir);
  assert.equal(rows.length, 1, JSON.stringify(rows));
  assert.equal(rows[0].record.requestId, 'recover-1');
  assert.equal(rows[0].status, 'done');
});
