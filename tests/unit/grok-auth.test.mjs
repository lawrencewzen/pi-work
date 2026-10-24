import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { load } from './_root.mjs';

const grok = await load('src/core/grok-auth.mjs');
const settings = await load('src/core/settings.mjs');

const {
  GROK_AUTH_SCOPE,
  GROK_LEGACY_SCOPE,
  GROK_API_KEY_SCOPE,
  GROK_CLIENT_ID,
  GROK_TOKEN_URL,
  GROK_DEVICE_CODE_URL,
  createGrokAuth,
  publicSession,
  lookupSessionEntry,
  needsRefresh,
  isHardExpired,
  credentialExpiryMs,
  entryFromTokenResponse,
  interpretDeviceToken,
  assertSafeVerificationUri,
  grokProxyHeaders,
  selectChatRuntime,
  redactAuthText,
  GROK_CLIENT_VERSION_DEFAULT,
  GROK_CLIENT_VERSION_MIN,
  grokClientVersion,
  grokVersionAtLeast,
  parseGrokVersion,
  readGrokCliVersion,
  resetGrokClientVersionCache,
} = grok;

function jwt(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `eyJhbGciOiJub25lIn0.${body}.signature1`;
}

async function tempAuth() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'Weft-grok-'));
  return path.join(dir, 'auth.json');
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return JSON.stringify(body); },
  };
}

test('loads canonical session and hides tokens from public status', async () => {
  const file = await tempAuth();
  const access = jwt({ sub: 'user-1', email: 'ada@example.com', exp: 4_000_000_000 });
  const refresh = 'refresh-test-value';
  const store = {
    [GROK_AUTH_SCOPE]: {
      key: access,
      auth_mode: 'oidc',
      create_time: '2020-01-01T00:00:00.000Z',
      user_id: 'user-1',
      email: 'ada@example.com',
      refresh_token: refresh,
      expires_at: '2099-01-01T00:00:00.000Z',
      oidc_issuer: 'https://auth.x.ai',
      oidc_client_id: GROK_CLIENT_ID,
    },
    [GROK_API_KEY_SCOPE]: { key: 'sk-keep-this', auth_mode: 'api_key', create_time: '2020-01-01T00:00:00.000Z', user_id: '' },
  };
  await fs.writeFile(file, JSON.stringify(store));
  const auth = createGrokAuth({ authFile: file, now: () => Date.parse('2026-01-01T00:00:00.000Z') });
  const status = await auth.status();
  assert.equal(status.signedIn, true);
  assert.equal(status.account, 'ada@example.com');
  assert.equal(status.email, 'ada@example.com');
  assert.equal(status.authMode, 'oidc');
  const dumped = JSON.stringify(status);
  assert.equal(dumped.includes(access), false);
  assert.equal(dumped.includes(refresh), false);
  assert.equal(dumped.includes('sk-keep-this'), false);
});

test('legacy scope is accepted; web_login and api_key are not a session', () => {
  const legacy = {
    [GROK_LEGACY_SCOPE]: { key: 'legacy-access', refresh_token: 'legacy-refresh', email: 'a@b.c' },
  };
  const found = lookupSessionEntry(legacy);
  assert.equal(found.scope, GROK_LEGACY_SCOPE);
  assert.equal(found.entry.key, 'legacy-access');

  const skipped = lookupSessionEntry({
    [GROK_AUTH_SCOPE]: { key: 'old', auth_mode: 'web_login', user_id: 'u' },
    [GROK_API_KEY_SCOPE]: { key: 'sk-only', auth_mode: 'api_key', user_id: '' },
  });
  assert.equal(skipped, null);
  assert.equal(publicSession({ key: 'tok', auth_mode: 'web_login' }).signedIn, false);
});

test('expiry uses expires_at, else the sooner of jwt exp and 30 days', () => {
  const now = Date.parse('2026-06-01T00:00:00.000Z');
  const withExpiry = { key: 'k', expires_at: '2026-06-01T01:00:00.000Z', create_time: '2020-01-01T00:00:00.000Z' };
  assert.equal(credentialExpiryMs(withExpiry, now), Date.parse('2026-06-01T01:00:00.000Z'));
  assert.equal(needsRefresh(withExpiry, now, 300_000), false);
  assert.equal(needsRefresh(withExpiry, Date.parse('2026-06-01T00:56:00.000Z'), 300_000), true);
  assert.equal(isHardExpired(withExpiry, Date.parse('2026-06-01T00:56:00.000Z')), false);

  const shortJwt = {
    key: jwt({ exp: Math.floor(now / 1000) + 120 }),
    create_time: new Date(now).toISOString(),
  };
  assert.equal(credentialExpiryMs(shortJwt, now), now + 120_000);
  assert.equal(isHardExpired(shortJwt, now + 121_000), true);

  const noHints = { key: 'plain', create_time: new Date(now).toISOString() };
  assert.equal(credentialExpiryMs(noHints, now), now + 30 * 24 * 60 * 60 * 1000);
});

test('refresh rewrites the session and keeps the api-key scope', async () => {
  const file = await tempAuth();
  const now = Date.parse('2026-06-01T00:00:00.000Z');
  const oldAccess = 'access-old';
  const oldRefresh = 'refresh-old';
  await fs.writeFile(file, JSON.stringify({
    [GROK_AUTH_SCOPE]: {
      key: oldAccess,
      auth_mode: 'oidc',
      create_time: '2026-01-01T00:00:00.000Z',
      user_id: 'user-1',
      email: 'ada@example.com',
      refresh_token: oldRefresh,
      expires_at: '2026-05-01T00:00:00.000Z',
      oidc_issuer: 'https://auth.x.ai',
      oidc_client_id: GROK_CLIENT_ID,
    },
    [GROK_API_KEY_SCOPE]: { key: 'sk-keep-this', auth_mode: 'api_key', create_time: '2026-01-01T00:00:00.000Z', user_id: '' },
  }));
  let called = 0;
  const auth = createGrokAuth({
    authFile: file,
    now: () => now,
    earlyMs: 300_000,
    fetch: async (url, opts) => {
      called += 1;
      assert.equal(url, GROK_TOKEN_URL);
      assert.match(opts.body, /grant_type=refresh_token/);
      assert.match(opts.body, new RegExp(`client_id=${GROK_CLIENT_ID}`));
      assert.match(opts.body, /refresh_token=refresh-old/);
      assert.equal(opts.redirect, 'error');
      return jsonResponse(200, {
        access_token: 'access-new',
        refresh_token: 'refresh-new',
        expires_in: 3600,
      });
    },
  });
  const resolved = await auth.resolveAccessToken();
  assert.equal(resolved.accessToken, 'access-new');
  assert.equal(called, 1);
  const disk = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(disk[GROK_AUTH_SCOPE].key, 'access-new');
  assert.equal(disk[GROK_AUTH_SCOPE].refresh_token, 'refresh-new');
  assert.equal(disk[GROK_AUTH_SCOPE].email, 'ada@example.com');
  assert.equal(disk[GROK_API_KEY_SCOPE].key, 'sk-keep-this');
  // Windows does not store POSIX mode bits; the user directory ACL protects the file.
  if (process.platform !== 'win32') {
    const mode = (await fs.stat(file)).mode & 0o777;
    assert.equal(mode, 0o600);
  }
  const again = await auth.resolveAccessToken();
  assert.equal(again.accessToken, 'access-new');
  assert.equal(called, 1);
});

test('refuses to send a refresh token to a non-x.ai issuer', async () => {
  const file = await tempAuth();
  await fs.writeFile(file, JSON.stringify({
    [GROK_AUTH_SCOPE]: {
      key: 'access-old',
      auth_mode: 'oidc',
      create_time: '2020-01-01T00:00:00.000Z',
      user_id: 'u',
      refresh_token: 'refresh-old',
      expires_at: '2020-01-02T00:00:00.000Z',
      oidc_issuer: 'https://evil.example',
      oidc_client_id: GROK_CLIENT_ID,
    },
  }));
  let called = 0;
  const auth = createGrokAuth({
    authFile: file,
    now: () => Date.parse('2026-01-01T00:00:00.000Z'),
    fetch: async () => { called += 1; return jsonResponse(200, { access_token: 'nope' }); },
  });
  await assert.rejects(() => auth.resolveAccessToken({ force: true }), (err) => err.code === 'bad_issuer');
  assert.equal(called, 0);
});

test('device login polls until approved and does not return secrets', async () => {
  const file = await tempAuth();
  const deviceCode = 'device-secret-code';
  let polls = 0;
  const auth = createGrokAuth({
    authFile: file,
    now: () => Date.parse('2026-06-01T00:00:00.000Z'),
    fetch: async (url) => {
      if (url === GROK_DEVICE_CODE_URL) {
        return jsonResponse(200, {
          device_code: deviceCode,
          user_code: 'ABCD-EFGH',
          verification_uri: 'https://auth.x.ai/device',
          verification_uri_complete: 'https://auth.x.ai/device?user_code=ABCD-EFGH',
          expires_in: 600,
          interval: 5,
        });
      }
      polls += 1;
      if (polls === 1) return jsonResponse(400, { error: 'authorization_pending' });
      return jsonResponse(200, {
        access_token: jwt({ sub: 'user-9', email: 'ada@example.com', exp: 4_000_000_000 }),
        refresh_token: 'refresh-from-device',
        expires_in: 3600,
      });
    },
  });
  const started = await auth.startLogin();
  assert.equal(started.userCode, 'ABCD-EFGH');
  assert.match(started.verificationUri, /^https:\/\/auth\.x\.ai\//);
  const pendingStatus = await auth.status();
  assert.equal(JSON.stringify(pendingStatus).includes(deviceCode), false);
  const first = await auth.pollLogin(started.loginId);
  assert.equal(first.status, 'pending');
  const done = await auth.pollLogin(started.loginId);
  assert.equal(done.status, 'done');
  assert.equal(done.grok.signedIn, true);
  assert.equal(done.grok.account, 'ada@example.com');
  assert.equal(JSON.stringify(done).includes(deviceCode), false);
  assert.equal(JSON.stringify(done).includes('refresh-from-device'), false);
  const disk = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(disk[GROK_AUTH_SCOPE].auth_mode, 'oidc');
  assert.ok(disk[GROK_AUTH_SCOPE].refresh_token);
});

test('rejects a non-https verification uri before storing a login', async () => {
  const auth = createGrokAuth({
    fetch: async () => jsonResponse(200, {
      device_code: 'd',
      user_code: 'ABCD',
      verification_uri: 'javascript:alert(1)',
      expires_in: 300,
      interval: 5,
    }),
  });
  await assert.rejects(() => auth.startLogin(), (err) => err.code === 'bad_verification_uri');
  assert.equal((await auth.status()).pending, null);
});

test('logout removes the oidc scope and keeps the api key', async () => {
  const file = await tempAuth();
  await fs.writeFile(file, JSON.stringify({
    [GROK_AUTH_SCOPE]: { key: 'access', auth_mode: 'oidc', refresh_token: 'r', expires_at: '2099-01-01T00:00:00.000Z', user_id: 'u', email: 'a@b.c' },
    [GROK_LEGACY_SCOPE]: { key: 'legacy', refresh_token: 'lr' },
    [GROK_API_KEY_SCOPE]: { key: 'sk-keep-this', auth_mode: 'api_key', user_id: '' },
  }));
  const auth = createGrokAuth({ authFile: file, now: () => Date.parse('2026-01-01T00:00:00.000Z') });
  const after = await auth.logout();
  assert.equal(after.signedIn, false);
  const disk = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(disk[GROK_AUTH_SCOPE], undefined);
  assert.equal(disk[GROK_LEGACY_SCOPE], undefined);
  assert.equal(disk[GROK_API_KEY_SCOPE].key, 'sk-keep-this');
});

test('interpretDeviceToken and verification uri helpers', () => {
  assert.equal(interpretDeviceToken(400, { error: 'authorization_pending' }).kind, 'pending');
  assert.equal(interpretDeviceToken(400, { error: 'slow_down' }).kind, 'slow_down');
  assert.equal(interpretDeviceToken(400, { error: 'access_denied' }).kind, 'denied');
  assert.equal(interpretDeviceToken(400, { error: 'expired_token' }).kind, 'expired');
  assert.equal(interpretDeviceToken(200, { access_token: 'a' }).kind, 'ok');
  assert.equal(assertSafeVerificationUri('https://accounts.x.ai/device'), 'https://accounts.x.ai/device');
  assert.throws(() => assertSafeVerificationUri('http://auth.x.ai/device'));
  assert.throws(() => assertSafeVerificationUri('https://evil.example/device'));
});

test('responses body maps tools and proxy headers stay on the subscription model', () => {
  const headers = grokProxyHeaders('test-access-token', 'grok-build', '1.0.50');
  assert.equal(headers.authorization, 'Bearer test-access-token');
  assert.equal(headers['x-xai-token-auth'], 'xai-grok-cli');
  assert.equal(headers['x-grok-client-version'], '1.0.50');
  assert.equal(headers['user-agent'], 'xai-grok-cli/1.0.50');
  assert.equal(headers['x-grok-model-override'], 'grok-build');
  assert.equal(redactAuthText(`err ${jwt({ a: 1 })} sk-supersecret`), 'err jwt-*** sk-***');
});

test('client version prefers grok --version, else a current default, and keeps the env override', () => {
  assert.equal(parseGrokVersion('grok 1.0.50\n'), '1.0.50');
  assert.equal(readGrokCliVersion(() => 'grok 1.0.50\n'), '1.0.50');
  assert.equal(readGrokCliVersion(() => {
    const err = new Error('missing');
    err.stdout = 'grok 1.0.13\n';
    throw err;
  }), '1.0.13');
  assert.equal(grokVersionAtLeast(GROK_CLIENT_VERSION_DEFAULT, GROK_CLIENT_VERSION_MIN), true);
  assert.equal(grokVersionAtLeast('1.0.12', GROK_CLIENT_VERSION_MIN), false);
  assert.equal(grokVersionAtLeast('1.0.13', GROK_CLIENT_VERSION_MIN), true);

  assert.equal(grokClientVersion({ WEFT_GROK_CLIENT_VERSION: '9.9.9' }, () => {
    throw new Error('cli should not be consulted when the env override is set');
  }), '9.9.9');
  assert.equal(grokClientVersion({ WEFT_GROK_CLIENT_VERSION: '   ' }, () => 'grok 1.2.3'), '1.2.3');
  assert.equal(grokClientVersion({}, () => 'grok 1.0.50'), '1.0.50');
  assert.equal(grokClientVersion({}, () => '0.1.220'), GROK_CLIENT_VERSION_DEFAULT);
  assert.equal(grokClientVersion({}, () => { throw new Error('grok missing'); }), GROK_CLIENT_VERSION_DEFAULT);

  resetGrokClientVersionCache();
  const headers = grokProxyHeaders('tok', 'grok-build', grokClientVersion({}, () => 'grok 1.0.50'));
  assert.equal(headers['x-grok-client-version'], '1.0.50');
  assert.equal(headers['user-agent'], 'xai-grok-cli/1.0.50');

  resetGrokClientVersionCache();
  assert.equal(grokVersionAtLeast(grokClientVersion({}), GROK_CLIENT_VERSION_MIN), true);
});

test('chat runtime uses a real model when one is connected, and faux only when asked', () => {
  assert.equal(selectChatRuntime('faux', { hasSession: true, hasApiKey: true }), 'faux');
  assert.equal(selectChatRuntime('openai', { hasSession: false }), 'openai');
  assert.equal(selectChatRuntime('', { hasSession: true }), 'openai');
  assert.equal(selectChatRuntime(undefined, { hasApiKey: true }), 'openai');
  assert.equal(selectChatRuntime('', { hasBaseUrl: true }), 'openai');
  assert.equal(selectChatRuntime('', { llmApi: 'faux' }), 'faux');
  assert.equal(selectChatRuntime('', { llmApi: 'faux', hasSession: true }), 'faux');
  assert.equal(selectChatRuntime('', { fauxScript: true }), 'faux');
  assert.equal(selectChatRuntime('openai', { fauxScript: true, llmApi: 'faux' }), 'openai');
  assert.equal(selectChatRuntime('', {}), 'none');
  assert.equal(selectChatRuntime(undefined, {}), 'none');
  assert.equal(selectChatRuntime('', { llmApi: 'openai-completions' }), 'none');
});

test('settings do not persist a grok blob', () => {
  const next = settings.mergeSettings({ provider: 'openai', apiKey: 'sk-real' }, {
    grok: { signedIn: true, accessToken: 'should-not-stick' },
    language: 'en',
  });
  assert.equal(next.grok, undefined);
  assert.equal(next.apiKey, 'sk-real');
  assert.equal(next.language, 'en');
  const pub = settings.publicSettings(next);
  assert.equal(JSON.stringify(pub).includes('sk-real'), false);
});

test('entryFromTokenResponse keeps profile fields across refresh', () => {
  const now = Date.parse('2026-06-01T00:00:00.000Z');
  const prev = { email: 'ada@example.com', user_id: 'user-1', team_id: 'team-7', refresh_token: 'old' };
  const entry = entryFromTokenResponse({ access_token: 'access-new', expires_in: 10 }, now, prev);
  assert.equal(entry.key, 'access-new');
  assert.equal(entry.email, 'ada@example.com');
  assert.equal(entry.user_id, 'user-1');
  assert.equal(entry.team_id, 'team-7');
  assert.equal(entry.refresh_token, 'old');
  assert.equal(entry.expires_at, new Date(now + 10_000).toISOString());
});
