import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { describe, it, test } from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { registerEnvConformance } from '@earendil-works/pi-durable/testing';
import { createWorkspaceEnv } from '../../src/kernel/workspace-env.mjs';

const context = BACKGROUND_CONTEXT;

function expect(actual, message) {
  return {
    toBeTruthy() {
      assert.ok(actual, message);
    },
    toBe(expected) {
      assert.strictEqual(actual, expected);
    },
    toEqual(expected) {
      assert.deepEqual(actual, expected);
    },
    toMatchObject(expected) {
      assert.partialDeepStrictEqual(actual, expected);
    },
    toBeGreaterThan(expected) {
      assert.ok(actual > expected, `${actual} > ${expected}`);
    },
    get rejects() {
      return {
        toThrow(messageIncludes) {
          return assert.rejects(actual, (error) => {
            const text = error instanceof Error ? error.message : String(error);
            assert.ok(text.includes(messageIncludes), text);
            return true;
          });
        },
      };
    },
  };
}

async function withWorkspaceEnv(use) {
  const dir = await mkdtemp(path.join(tmpdir(), 'piw-env-'));
  const env = await createWorkspaceEnv({ cwd: dir });
  try {
    await use(env);
  } finally {
    await env.cleanup(context).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
}

registerEnvConformance({
  describe,
  expect,
  it: (name, run, timeoutMs) => it(name, { timeout: timeoutMs }, run),
}, 'workspace env conformance', withWorkspaceEnv);

test('sandbox: env rejects ../, absolute paths, and NUL', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'piw-env-sand-'));
  const root = path.join(base, 'ws');
  await mkdir(root);
  await writeFile(path.join(base, 'secret.txt'), 'secret');
  const env = await createWorkspaceEnv({ cwd: root });
  try {
    const parent = await env.readTextFile('../secret.txt', context);
    assert.equal(parent.ok, false);
    assert.equal(parent.error.code, 'invalid');
    assert.equal(String(parent.error.message).includes('E_SANDBOX'), true);

    const abs = await env.writeFile(path.join(base, 'secret.txt'), 'pwned', context);
    assert.equal(abs.ok, false);
    assert.equal(String(abs.error.message).includes('E_SANDBOX'), true);

    const nul = await env.readTextFile('a\0b', context);
    assert.equal(nul.ok, false);
    assert.equal(String(nul.error.message).includes('E_SANDBOX'), true);

    assert.equal(await readFile(path.join(base, 'secret.txt'), 'utf8'), 'secret');
    const inside = await env.writeFile('ok.txt', 'yes', context);
    assert.equal(inside.ok, true);
    assert.equal(await readFile(path.join(root, 'ok.txt'), 'utf8'), 'yes');
  } finally {
    await env.cleanup(context).catch(() => {});
    await rm(base, { recursive: true, force: true });
  }
});

test('sandbox: env rejects symlink escape (file and dir)', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'piw-env-link-'));
  const root = path.join(base, 'ws');
  await mkdir(root);
  await writeFile(path.join(base, 'secret.txt'), 'secret');
  await symlink(path.join(base, 'secret.txt'), path.join(root, 'link.txt'));
  await symlink(base, path.join(root, 'outdir'));
  const env = await createWorkspaceEnv({ cwd: await realpath(root) });
  try {
    const file = await env.readTextFile('link.txt', context);
    assert.equal(file.ok, false);
    assert.equal(String(file.error.message).includes('E_SANDBOX'), true);

    const dir = await env.writeFile('outdir/new.txt', 'pwned', context);
    assert.equal(dir.ok, false);
    assert.equal(String(dir.error.message).includes('E_SANDBOX'), true);
  } finally {
    await env.cleanup(context).catch(() => {});
    await rm(base, { recursive: true, force: true });
  }
});

test('sandbox: exec cwd cannot leave the workspace, and a command writes inside it', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'piw-env-exec-'));
  const env = await createWorkspaceEnv({ cwd: dir });
  try {
    const escape = await env.exec('printf escaped', { cwd: '..' }, context);
    assert.equal(escape.ok, false);
    assert.equal(String(escape.error.message).includes('E_SANDBOX'), true);

    const output = { stdout: '', stderr: '' };
    const command = process.platform === 'win32'
      ? 'echo bash-ok> sand.txt'
      : 'printf bash-ok > sand.txt && printf bash-ok';
    const ran = await env.exec(command, {
      onOutput: (text, _ctx, info) => {
        output[info.stream] += text;
      },
    }, context);
    assert.equal(ran.ok, true, ran.ok ? '' : ran.error.message);
    assert.equal(ran.value.exitCode, 0);
    assert.equal((await readFile(path.join(dir, 'sand.txt'), 'utf8')).includes('bash-ok'), true);
    if (process.platform !== 'win32') assert.equal(output.stdout.includes('bash-ok'), true);
  } finally {
    await env.cleanup(context).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});
