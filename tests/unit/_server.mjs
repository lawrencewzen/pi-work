import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ROOT } from './_root.mjs';

const STRIP = [
  'WEFT_LLM',
  'WEFT_FAUX_SCRIPT',
  'WEFT_FAUX_TEXT',
  'WEFT_FAUX_PLAN',
  'WEFT_FAUX_RECORD',
  'WEFT_FAUX_HOLD',
  'WEFT_FAUX_HOLD_READY',
  'WEFT_FAUX_TPS',
  'WEFT_FAUX_TOOL_LOG',
  'WEFT_MAX_SUBAGENTS',
  'WEFT_MAX_OUTPUT_TOKENS',
  'LLM_API',
  'LLM_API_KEY',
  'LLM_BASE_URL',
  'LLM_MODEL',
  'LLM_CONTEXT_WINDOW',
  'WEFT_GROK_AUTH',
  'GROK_HOME',
  'WEFT_GROK_PROXY',
  'WEFT_GROK_CLIENT_VERSION',
  'WEFT_TEST_GROK_TOKEN_URL',
  'WEFT_TOKEN',
  'WEFT_ALLOWED_HOSTS',
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
    WEFT_DATA_DIR: dataDir,
    WEFT_GROK_AUTH: path.join(dataDir, 'auth.json'),
    WEFT_RETRY_BASE_MS: '20',
    WEFT_RETRY_MAX: '5',
    ...(token ? { WEFT_TOKEN: token } : {}),
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
      const match = log.match(/WEFT_READY (http:\/\/\S+)/);
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
