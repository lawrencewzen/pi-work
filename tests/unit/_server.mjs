import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ROOT } from './_root.mjs';

const STRIP = [
  'PI_WORK_LLM',
  'PI_WORK_FAUX_SCRIPT',
  'PI_WORK_FAUX_TEXT',
  'PI_WORK_FAUX_PLAN',
  'PI_WORK_FAUX_RECORD',
  'PI_WORK_FAUX_HOLD',
  'PI_WORK_FAUX_HOLD_READY',
  'PI_WORK_FAUX_TPS',
  'PI_WORK_FAUX_TOOL_LOG',
  'PI_WORK_MAX_SUBAGENTS',
  'PI_WORK_MAX_OUTPUT_TOKENS',
  'LLM_API',
  'LLM_API_KEY',
  'LLM_BASE_URL',
  'LLM_MODEL',
  'LLM_CONTEXT_WINDOW',
  'PI_WORK_GROK_AUTH',
  'GROK_HOME',
  'PI_WORK_GROK_PROXY',
  'PI_WORK_GROK_CLIENT_VERSION',
  'PI_WORK_TEST_GROK_TOKEN_URL',
  'PI_WORK_TOKEN',
  'PI_WORK_ALLOWED_HOSTS',
];

function childEnv(dataDir, { token, extra = {} } = {}) {
  const env = { ...process.env };
  for (const key of STRIP) delete env[key];
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(COUNT|KEY_|VALUE_)/.test(key)) delete env[key];
  }
  return {
    ...env,
    PORT: '0',
    PI_WORK_DATA_DIR: dataDir,
    PI_WORK_GROK_AUTH: path.join(dataDir, 'auth.json'),
    PI_WORK_RETRY_BASE_MS: '20',
    PI_WORK_RETRY_MAX: '5',
    ...(token ? { PI_WORK_TOKEN: token } : {}),
    ...extra,
  };
}

export function killChild(child) {
  if (!child || child.exitCode != null || child.signalCode != null) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  child.kill('SIGKILL');
}

export function stopServer(srv) {
  const proc = srv?.proc ?? srv;
  return new Promise((resolve) => {
    if (!proc || proc.exitCode != null) return resolve();
    const timer = setTimeout(() => killChild(proc), 2000);
    proc.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    proc.kill('SIGTERM');
  });
}

export async function startServer({
  env: extra = {},
  dataDir,
  token,
  expectReady = true,
  authJson = '{}',
  nodeArgs = [],
  formatLog = (log) => log,
} = {}) {
  dataDir ??= await mkdtemp(path.join(tmpdir(), 'piw-unit-'));
  if (authJson !== false && authJson != null) {
    await writeFile(path.join(dataDir, 'auth.json'), authJson.endsWith('\n') ? authJson : `${authJson}\n`, { mode: 0o600 });
  }
  const proc = spawn(process.execPath, [...nodeArgs, 'server.mjs'], {
    cwd: ROOT,
    env: childEnv(dataDir, { token, extra }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      killChild(proc);
      reject(new Error(`server not ready:\n${formatLog(log)}`));
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
      if (expectReady) reject(new Error(`server exited ${code}:\n${formatLog(log)}`));
      else resolve(null);
    });
  });
  if (expectReady) proc.removeAllListeners('exit');
  return {
    proc,
    base,
    dataDir,
    port: base ? Number(new URL(base).port) : undefined,
    logs: () => log,
  };
}

export async function request(base, method, apiPath, body, token) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(base + apiPath, {
    method,
    headers,
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, text };
}
