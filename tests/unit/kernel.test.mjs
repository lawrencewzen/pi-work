import { spawn } from 'node:child_process';
import { mkdtemp, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createModels } from '@earendil-works/pi-ai/models';
import { createRegistry } from '@earendil-works/pi-durable';
import { openKernel, registerFaux } from '../../src/kernel/index.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const closedWorkerPath = path.join(here, 'kernel-closed-worker.mjs');

function catalog() {
  const models = createModels();
  registerFaux(models);
  return { models, registry: createRegistry() };
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

function spawnClosedWorker(mode) {
  const child = spawn(process.execPath, [closedWorkerPath], {
    env: { ...process.env, WEFT_KERNEL_MODE: mode },
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
  assert.match(result.out, /WEFT_HARNESS_CLOSED/);
  assert.match(result.out, /disk full/);
});

test('harness.closed after close() does not exit the process', { timeout: 20_000 }, async () => {
  const closed = spawnClosedWorker('close');
  const result = await closed.exited;
  assert.equal(result.code, 0, result.out);
  assert.equal(result.out.includes('WEFT_HARNESS_CLOSED'), false, result.out);
});
