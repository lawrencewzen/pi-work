import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const ROOT = process.env.PI_WORK_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../fixtures');

export async function tmpdir(p = 'piw-e2e-') { return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), p))); }

/** Start server.mjs with faux LLM. Returns {url, dataDir, proc, kill(signal), restart()} */
export async function startServer({ script = 'basic.json', dataDir, port = 0, extraEnv = {} } = {}) {
  dataDir ??= await tmpdir('piw-data-');
  const proc = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), PI_WORK_DATA_DIR: dataDir, PI_WORK_LLM: 'faux',
      PI_WORK_FAUX_SCRIPT: path.join(FIXTURES, script), PI_WORK_RETRY_BASE_MS: '50', PI_WORK_RETRY_MAX: '5',
      PI_WORK_STALL_MS: '2000', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  const url = await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('server not ready:\n' + log)), 20000);
    const on = (b) => { log += b; const m = log.match(/PI_WORK_READY (http:\/\/\S+)/); if (m) { clearTimeout(to); resolve(m[1]); } };
    proc.stdout.on('data', on); proc.stderr.on('data', on);
    proc.on('exit', (c) => { clearTimeout(to); reject(new Error(`server exited ${c}:\n${log}`)); });
  });
  proc.removeAllListeners('exit');
  const kill = (sig = 'SIGKILL') => new Promise((r) => { if (proc.exitCode !== null) return r(); proc.once('exit', r); proc.kill(sig); });
  return { url, dataDir, proc, kill, logs: () => log, port: Number(new URL(url).port) };
}

export async function authToken(dataDir) {
  return (await fs.readFile(path.join(dataDir, 'auth.token'), 'utf8')).trim();
}

export async function api(url, method, p, body, token) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(url + '/api' + p, { method, headers, body: body == null ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
