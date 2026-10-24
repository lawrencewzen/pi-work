import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { load, ROOT } from './_root.mjs';
const { listBrowsableDirs } = await load('src/core/workspace-guard.mjs');

// macOS keeps the temp dir under /private/var, which the guard treats as a system path.
async function tmpBase() {
  const sys = await fs.realpath(os.tmpdir());
  const parent = /^\/(private\/)?var\//.test(sys) ? path.join(ROOT, 'data', 'test-tmp') : sys;
  await fs.mkdir(parent, { recursive: true });
  return fs.realpath(await fs.mkdtemp(path.join(parent, 'piw-browse-')));
}

const made = [];
test.after(async () => {
  for (const dir of made) await fs.rm(dir, { recursive: true, force: true });
});

async function tree() {
  const base = await tmpBase();
  made.push(base);
  const root = path.join(base, 'root');
  await fs.mkdir(path.join(root, 'b-app', '.git'), { recursive: true });
  await fs.mkdir(path.join(root, 'a-notes', 'deep'), { recursive: true });
  await fs.mkdir(path.join(root, '.hidden'), { recursive: true });
  await fs.writeFile(path.join(root, 'file.txt'), 'x');
  await fs.mkdir(path.join(base, 'outside'), { recursive: true });
  await fs.symlink(path.join(base, 'outside'), path.join(root, 'escape'));
  return { base, root };
}

async function withRoot(root, fn) {
  const prev = process.env.WEFT_WORKSPACE_ROOT;
  process.env.WEFT_WORKSPACE_ROOT = root;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.WEFT_WORKSPACE_ROOT;
    else process.env.WEFT_WORKSPACE_ROOT = prev;
  }
}

test('lists only visible sub-folders inside the root, marks git repos', async () => {
  const { root } = await tree();
  await withRoot(root, async () => {
    const top = await listBrowsableDirs('');
    assert.equal(top.path, root);
    assert.equal(top.parent, null);
    assert.deepEqual(top.entries.map((e) => e.name), ['a-notes', 'b-app']);
    assert.equal(top.entries.find((e) => e.name === 'b-app').git, true);
    const sub = await listBrowsableDirs(path.join(root, 'a-notes'));
    assert.equal(sub.parent, root);
    assert.deepEqual(sub.entries.map((e) => e.name), ['deep']);
    assert.equal(sub.selectable, true);
  });
});

test('refuses paths outside the root and ones that do not exist', async () => {
  const { base, root } = await tree();
  await withRoot(root, async () => {
    await assert.rejects(listBrowsableDirs(path.join(base, 'outside')), /not under an allowed workspace root/);
    await assert.rejects(listBrowsableDirs(path.join(root, 'escape')), /not under an allowed workspace root/);
    await assert.rejects(listBrowsableDirs(path.join(root, '..')), /not under an allowed workspace root/);
    await assert.rejects(listBrowsableDirs(path.join(root, 'missing')), (err) => err.status === 404);
  });
});
