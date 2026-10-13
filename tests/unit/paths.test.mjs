import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { load } from './_root.mjs';
const { truncatePath, resolveInWorkspace } = await load('src/core/paths.mjs');

test('truncatePath: short path unchanged', () => {
  assert.equal(truncatePath('src/a.ts', 40), 'src/a.ts');
});
test('truncatePath: keeps first segment and filename', () => {
  const r = truncatePath('src/very/deep/nested/folder/structure/foo.ts', 20);
  assert.equal(r, 'src/…/foo.ts');
  assert.ok(r.length <= 20);
});
test('truncatePath: windows separators normalized', () => {
  assert.equal(truncatePath('src\\a\\b\\c\\d\\e\\f\\g\\foo.ts', 14), 'src/…/foo.ts');
});
test('truncatePath: very long filename still within max', () => {
  const r = truncatePath('src/x/' + 'a'.repeat(80) + '.md', 20);
  assert.ok(r.length <= 20, r);
  assert.ok(r.endsWith('.md'));
  assert.ok(r.includes('…'));
});

async function ws() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'piw-'));
  const root = path.join(base, 'ws');
  await fs.mkdir(path.join(root, 'sub'), { recursive: true });
  await fs.writeFile(path.join(base, 'secret.txt'), 'x');
  return { base, root: await fs.realpath(root) };
}
const sandbox = (e) => e && e.code === 'E_SANDBOX';

test('sandbox: allows inner and not-yet-existing files', async () => {
  const { root } = await ws();
  assert.equal(await resolveInWorkspace(root, 'sub/new.md'), path.join(root, 'sub/new.md'));
  assert.equal(await resolveInWorkspace(root, './sub/../a.txt'), path.join(root, 'a.txt'));
});
test('sandbox: rejects ../ escape', async () => {
  const { root } = await ws();
  await assert.rejects(resolveInWorkspace(root, '../secret.txt'), sandbox);
  await assert.rejects(resolveInWorkspace(root, 'sub/../../secret.txt'), sandbox);
});
test('sandbox: rejects absolute outside path and NUL', async () => {
  const { base, root } = await ws();
  await assert.rejects(resolveInWorkspace(root, path.join(base, 'secret.txt')), sandbox);
  await assert.rejects(resolveInWorkspace(root, 'a\0b'), sandbox);
});
test('sandbox: rejects symlink escape (file and dir)', async () => {
  const { base, root } = await ws();
  await fs.symlink(path.join(base, 'secret.txt'), path.join(root, 'link.txt'));
  await fs.symlink(base, path.join(root, 'outdir'));
  await assert.rejects(resolveInWorkspace(root, 'link.txt'), sandbox);
  await assert.rejects(resolveInWorkspace(root, 'outdir/new.txt'), sandbox);
});
