import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const ROOT = process.env.WEFT_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../fixtures');

/**
 * macOS keeps os.tmpdir() under /private/var, which the workspace guard treats as a
 * system path, so workspaces there are refused. Use the git-ignored data/test-tmp instead.
 */
async function tmpBase() {
  const sys = await fs.realpath(os.tmpdir());
  if (!/^\/(private\/)?var\//.test(sys)) return sys;
  const local = path.join(ROOT, 'data', 'test-tmp');
  await fs.mkdir(local, { recursive: true });
  return local;
}

export async function tmpdir(p = 'piw-e2e-') { return fs.realpath(await fs.mkdtemp(path.join(await tmpBase(), p))); }

/** Child directories the server will accept. Pass `root` as WEFT_WORKSPACE_ROOT. */
export async function prepareWorkspaces(names = ['repo']) {
  const root = await tmpdir('piw-wsroot-');
  const dirs = [];
  for (const name of names) {
    const dir = path.join(root, name);
    await fs.mkdir(dir);
    dirs.push(dir);
  }
  return { root, dirs };
}

/** Start server.mjs with faux LLM. Returns {url, dataDir, proc, kill(signal), logs()}. Login is off unless extraEnv sets WEFT_TOKEN. */
export async function startServer({ script = 'basic.json', dataDir, port = 0, extraEnv = {} } = {}) {
  dataDir ??= await tmpdir('piw-data-');
  const env = {
    ...process.env,
    PORT: String(port),
    WEFT_DATA_DIR: dataDir,
    WEFT_LLM: 'faux',
    WEFT_FAUX_SCRIPT: path.join(FIXTURES, script),
    WEFT_RETRY_BASE_MS: '50',
    WEFT_RETRY_MAX: '5',
    ...extraEnv,
  };
  if (!Object.prototype.hasOwnProperty.call(extraEnv, 'WEFT_TOKEN')) delete env.WEFT_TOKEN;
  const proc = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  const url = await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('server not ready:\n' + log)), 20000);
    const on = (b) => { log += b; const m = log.match(/WEFT_READY (http:\/\/\S+)/); if (m) { clearTimeout(to); resolve(m[1]); } };
    proc.stdout.on('data', on); proc.stderr.on('data', on);
    proc.on('exit', (c) => { clearTimeout(to); reject(new Error(`server exited ${c}:\n${log}`)); });
  });
  proc.removeAllListeners('exit');
  const kill = (sig = 'SIGKILL') => new Promise((r) => { if (proc.exitCode !== null) return r(); proc.once('exit', r); proc.kill(sig); });
  return { url, dataDir, proc, kill, logs: () => log, port: Number(new URL(url).port) };
}

export async function api(url, method, p, body, token) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(url + '/api' + p, { method, headers, body: body == null ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
