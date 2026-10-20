import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from './_root.mjs';
import { resolveAuthToken, unauthenticatedHostsWarning } from '../../src/core/auth.mjs';

const TOKEN = 'unit-optional-auth-token';
const STRIP = [
  'PI_WORK_LLM',
  'PI_WORK_FAUX_SCRIPT',
  'PI_WORK_FAUX_TEXT',
  'LLM_API',
  'LLM_API_KEY',
  'LLM_BASE_URL',
  'LLM_MODEL',
  'PI_WORK_GROK_AUTH',
  'GROK_HOME',
  'PI_WORK_TOKEN',
  'PI_WORK_ALLOWED_HOSTS',
];

function childEnv(dataDir, extra = {}) {
  const env = { ...process.env };
  for (const key of STRIP) delete env[key];
  return {
    ...env,
    PORT: '0',
    PI_WORK_DATA_DIR: dataDir,
    PI_WORK_GROK_AUTH: path.join(dataDir, 'grok-auth.json'),
    PI_WORK_RETRY_BASE_MS: '20',
    PI_WORK_RETRY_MAX: '5',
    ...extra,
  };
}

async function startServer(extra = {}, { dataDir } = {}) {
  dataDir ??= await fs.mkdtemp(path.join(os.tmpdir(), 'piw-auth-'));
  await fs.writeFile(path.join(dataDir, 'grok-auth.json'), '{}\n', { mode: 0o600 });
  const proc = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    env: childEnv(dataDir, extra),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server not ready:\n${log}`)), 20000);
    const onData = (buf) => {
      log += buf;
      const match = log.match(/PI_WORK_READY (http:\/\/\S+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited ${code}:\n${log}`));
    });
  });
  proc.removeAllListeners('exit');
  return {
    proc,
    base,
    dataDir,
    port: Number(new URL(base).port),
    logs: () => log,
  };
}

function stopProcess(proc) {
  return new Promise((resolve) => {
    if (proc.exitCode != null) return resolve();
    const timer = setTimeout(() => proc.kill('SIGKILL'), 2000);
    proc.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    proc.kill('SIGTERM');
  });
}

function raw({ port, method = 'GET', path: reqPath = '/', headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: reqPath,
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (body != null) req.end(body);
    else req.end();
  });
}

function assertSecurityHeaders(headers) {
  assert.match(String(headers['content-security-policy'] || ''), /default-src 'self'/);
  assert.equal(headers['x-content-type-options'], 'nosniff');
  assert.equal(headers['referrer-policy'], 'no-referrer');
  assert.equal(headers['x-frame-options'], 'DENY');
}

test('resolveAuthToken only enables login for a non-empty PI_WORK_TOKEN', () => {
  assert.deepEqual(resolveAuthToken({}), { token: '', enabled: false });
  assert.deepEqual(resolveAuthToken({ PI_WORK_TOKEN: '   ' }), { token: '', enabled: false });
  assert.deepEqual(resolveAuthToken({ PI_WORK_TOKEN: 'abc' }), { token: 'abc', enabled: true });
  assert.equal(unauthenticatedHostsWarning({}), '');
  assert.equal(
    unauthenticatedHostsWarning({ PI_WORK_ALLOWED_HOSTS: 'lab.example' }),
    'PI_WORK_WARN 服务对这些主机开放且没有鉴权: lab.example',
  );
  assert.equal(unauthenticatedHostsWarning({ PI_WORK_TOKEN: 'abc', PI_WORK_ALLOWED_HOSTS: 'lab.example' }), '');
});

test('acceptance 1: fresh data dir serves /api without credentials and does not create auth.token', async () => {
  const srv = await startServer();
  try {
    const settings = await raw({ port: srv.port, path: '/api/settings' });
    assert.equal(settings.status, 200);
    assert.equal(typeof settings.json, 'object');
    assertSecurityHeaders(settings.headers);
    await assert.rejects(
      fs.access(path.join(srv.dataDir, 'auth.token')),
      (err) => err.code === 'ENOENT',
    );

    const log = srv.logs();
    assert.match(log, /PI_WORK_READY http:\/\/127\.0\.0\.1:\d+/);
    assert.equal(new URL(srv.base).hostname, '127.0.0.1');
    assert.doesNotMatch(log, /PI_WORK_LOGIN/);
    assert.doesNotMatch(log, /PI_WORK_TOKEN/);

    for (const reqPath of ['/login', '/login/', '/login?token=anything']) {
      const login = await raw({ port: srv.port, path: reqPath });
      assert.equal(login.status, 302, reqPath);
      assert.equal(login.headers.location, '/');
      assert.equal(login.headers['set-cookie'], undefined);
      assertSecurityHeaders(login.headers);
    }

    const events = await raw({ port: srv.port, path: '/api/conversations/missing/events' });
    assert.equal(events.status, 404);
    assert.equal(events.json?.error, 'conversation not found');

    const created = await raw({
      port: srv.port,
      method: 'POST',
      path: '/api/workspaces',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'open' }),
    });
    assert.equal(created.status, 201);
  } finally {
    await stopProcess(srv.proc);
  }

  const plantedDir = await fs.mkdtemp(path.join(os.tmpdir(), 'piw-auth-plant-'));
  const planted = 'planted-file-token\n';
  await fs.writeFile(path.join(plantedDir, 'auth.token'), planted, { mode: 0o600 });
  const again = await startServer({}, { dataDir: plantedDir });
  try {
    const settings = await raw({ port: again.port, path: '/api/settings' });
    assert.equal(settings.status, 200);
    assert.equal(await fs.readFile(path.join(plantedDir, 'auth.token'), 'utf8'), planted);
    assert.doesNotMatch(again.logs(), /PI_WORK_LOGIN/);
    assert.doesNotMatch(again.logs(), /planted-file-token/);
  } finally {
    await stopProcess(again.proc);
  }
});

test('acceptance 2: PI_WORK_TOKEN keeps 401, cookie login, and SSE tickets', async () => {
  const srv = await startServer({
    PI_WORK_TOKEN: TOKEN,
    PI_WORK_ALLOWED_HOSTS: 'lab.example',
  });
  try {
    const open = await raw({ port: srv.port, path: '/api/settings' });
    assert.equal(open.status, 401);
    assert.equal(open.json?.error, 'unauthorized');

    const wrong = await raw({ port: srv.port, path: '/login?token=wrong' });
    assert.equal(wrong.status, 401);

    const login = await raw({ port: srv.port, path: `/login?token=${encodeURIComponent(TOKEN)}` });
    assert.equal(login.status, 302);
    assert.equal(login.headers.location, '/');
    const setCookie = [].concat(login.headers['set-cookie'] || []).join('\n');
    assert.match(setCookie, new RegExp(`pi_work_token=${TOKEN}`));
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    assertSecurityHeaders(login.headers);

    const withCookie = await raw({
      port: srv.port,
      path: '/api/settings',
      headers: { cookie: `pi_work_token=${TOKEN}` },
    });
    assert.equal(withCookie.status, 200);

    const withBearer = await raw({
      port: srv.port,
      path: '/api/settings',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(withBearer.status, 200);

    const badBearer = await raw({
      port: srv.port,
      path: '/api/settings',
      headers: { authorization: 'Bearer wrong' },
    });
    assert.equal(badBearer.status, 401);

    const events = await raw({ port: srv.port, path: '/api/conversations/missing/events' });
    assert.equal(events.status, 401);

    const ticket = await raw({
      port: srv.port,
      method: 'POST',
      path: '/api/sse-ticket',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      body: '{}',
    });
    assert.equal(ticket.status, 200);
    assert.equal(typeof ticket.json?.ticket, 'string');
    const once = await raw({
      port: srv.port,
      path: `/api/conversations/missing/events?ticket=${ticket.json.ticket}`,
    });
    assert.equal(once.status, 404);
    const reused = await raw({
      port: srv.port,
      path: `/api/conversations/missing/events?ticket=${ticket.json.ticket}`,
    });
    assert.equal(reused.status, 401);

    const log = srv.logs();
    assert.match(log, /PI_WORK_READY http:\/\/127\.0\.0\.1:\d+/);
    assert.doesNotMatch(log, /PI_WORK_LOGIN/);
    assert.doesNotMatch(log, /没有鉴权/);
    assert.doesNotMatch(log, new RegExp(TOKEN));
    await assert.rejects(fs.access(path.join(srv.dataDir, 'auth.token')), (err) => err.code === 'ENOENT');
  } finally {
    await stopProcess(srv.proc);
  }
});

test('acceptance 3: Host, Origin, and Content-Type guards stay on without a token', async () => {
  const srv = await startServer();
  try {
    const host = await raw({
      port: srv.port,
      path: '/api/settings',
      headers: { host: 'evil.com' },
    });
    assert.equal(host.status, 400);
    assert.equal(host.json?.error, 'invalid host');
    assertSecurityHeaders(host.headers);

    const origin = await raw({
      port: srv.port,
      method: 'POST',
      path: '/api/workspaces',
      headers: {
        origin: 'http://evil.com',
        'content-type': 'application/json',
      },
      body: '{}',
    });
    assert.equal(origin.status, 403);
    assert.equal(origin.json?.error, 'invalid origin');
    assertSecurityHeaders(origin.headers);

    const plain = await raw({
      port: srv.port,
      method: 'POST',
      path: '/api/workspaces',
      headers: { 'content-type': 'text/plain' },
      body: 'hello',
    });
    assert.equal(plain.status, 415);
    assert.equal(plain.json?.error, 'unsupported media type');
    assertSecurityHeaders(plain.headers);
  } finally {
    await stopProcess(srv.proc);
  }
});

test('acceptance 4: PI_WORK_ALLOWED_HOSTS without a token prints a warning', async () => {
  const srv = await startServer({ PI_WORK_ALLOWED_HOSTS: 'lab.example,other.internal' });
  try {
    const settings = await raw({ port: srv.port, path: '/api/settings' });
    assert.equal(settings.status, 200);
    const log = srv.logs();
    assert.match(log, /PI_WORK_WARN 服务对这些主机开放且没有鉴权: lab\.example,other\.internal/);
    assert.match(log, /PI_WORK_READY http:\/\/127\.0\.0\.1:\d+/);
    assert.doesNotMatch(log, /PI_WORK_LOGIN/);
    assert.doesNotMatch(log, /PI_WORK_TOKEN/);
  } finally {
    await stopProcess(srv.proc);
  }
});
