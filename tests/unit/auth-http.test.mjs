import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveAuthToken, unauthenticatedHostsWarning } from '../../src/core/auth.mjs';
import { startServer, stopServer } from './_server.mjs';

const TOKEN = 'unit-optional-auth-token';

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

test('resolveAuthToken only enables login for a non-empty WEFT_TOKEN', () => {
  assert.deepEqual(resolveAuthToken({}), { token: '', enabled: false });
  assert.deepEqual(resolveAuthToken({ WEFT_TOKEN: '   ' }), { token: '', enabled: false });
  assert.deepEqual(resolveAuthToken({ WEFT_TOKEN: 'abc' }), { token: 'abc', enabled: true });
  assert.equal(unauthenticatedHostsWarning({}), '');
  assert.equal(
    unauthenticatedHostsWarning({ WEFT_ALLOWED_HOSTS: 'lab.example' }),
    'WEFT_WARN 服务对这些主机开放且没有鉴权: lab.example',
  );
  assert.equal(unauthenticatedHostsWarning({ WEFT_TOKEN: 'abc', WEFT_ALLOWED_HOSTS: 'lab.example' }), '');
});

test('legacy env names no longer enable login or host warnings', async () => {
  const legacyToken = `PI${'_'}WORK_TOKEN`;
  const legacyHosts = `PI${'_'}WORK_ALLOWED_HOSTS`;
  assert.deepEqual(resolveAuthToken({ [legacyToken]: 'abc' }), { token: '', enabled: false });
  assert.equal(unauthenticatedHostsWarning({ [legacyHosts]: 'lab.example' }), '');

  const srv = await startServer({ env: { [legacyToken]: TOKEN } });
  try {
    const settings = await raw({ port: srv.port, path: '/api/settings' });
    assert.equal(settings.status, 200);
    assert.doesNotMatch(srv.logs(), /WEFT_TOKEN/);
  } finally {
    await stopServer(srv);
  }
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
    assert.match(log, /WEFT_READY http:\/\/127\.0\.0\.1:\d+/);
    assert.equal(new URL(srv.base).hostname, '127.0.0.1');
    assert.doesNotMatch(log, /WEFT_LOGIN/);
    assert.doesNotMatch(log, /WEFT_TOKEN/);

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
    await stopServer(srv);
  }

  const plantedDir = await fs.mkdtemp(path.join(os.tmpdir(), 'piw-auth-plant-'));
  const planted = 'planted-file-token\n';
  await fs.writeFile(path.join(plantedDir, 'auth.token'), planted, { mode: 0o600 });
  const again = await startServer({ dataDir: plantedDir });
  try {
    const settings = await raw({ port: again.port, path: '/api/settings' });
    assert.equal(settings.status, 200);
    assert.equal(await fs.readFile(path.join(plantedDir, 'auth.token'), 'utf8'), planted);
    assert.doesNotMatch(again.logs(), /WEFT_LOGIN/);
    assert.doesNotMatch(again.logs(), /planted-file-token/);
  } finally {
    await stopServer(again);
  }
});

test('acceptance 2: WEFT_TOKEN keeps 401, cookie login, and SSE tickets', async () => {
  const srv = await startServer({
    token: TOKEN,
    env: { WEFT_ALLOWED_HOSTS: 'lab.example' },
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
    assert.match(setCookie, new RegExp(`weft_token=${TOKEN}`));
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    assertSecurityHeaders(login.headers);

    const withCookie = await raw({
      port: srv.port,
      path: '/api/settings',
      headers: { cookie: `weft_token=${TOKEN}` },
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
    assert.match(log, /WEFT_READY http:\/\/127\.0\.0\.1:\d+/);
    assert.doesNotMatch(log, /WEFT_LOGIN/);
    assert.doesNotMatch(log, /没有鉴权/);
    assert.doesNotMatch(log, new RegExp(TOKEN));
    await assert.rejects(fs.access(path.join(srv.dataDir, 'auth.token')), (err) => err.code === 'ENOENT');
  } finally {
    await stopServer(srv);
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
    await stopServer(srv);
  }
});

test('acceptance 4: WEFT_ALLOWED_HOSTS without a token prints a warning', async () => {
  const srv = await startServer({ env: { WEFT_ALLOWED_HOSTS: 'lab.example,other.internal' } });
  try {
    const settings = await raw({ port: srv.port, path: '/api/settings' });
    assert.equal(settings.status, 200);
    const log = srv.logs();
    assert.match(log, /WEFT_WARN 服务对这些主机开放且没有鉴权: lab\.example,other\.internal/);
    assert.match(log, /WEFT_READY http:\/\/127\.0\.0\.1:\d+/);
    assert.doesNotMatch(log, /WEFT_LOGIN/);
    assert.doesNotMatch(log, /WEFT_TOKEN/);
  } finally {
    await stopServer(srv);
  }
});
