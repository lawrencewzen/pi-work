/**
 * Grok Build session auth (same store and device flow as `grok login`).
 *
 * Verified from public xai-org/grok-build source (auth/model.rs, auth/config.rs,
 * auth/device_code.rs, auth/storage.rs, default_models.json):
 * - auth.json is a map of scope → credential. Current scope key is
 *   `https://auth.x.ai::<client_id>`. Legacy key: `https://accounts.x.ai/sign-in`.
 * - Access token field is `key`; refresh is `refresh_token`; mode `oidc`.
 * - Device grant: POST {issuer}/oauth2/device/code then poll {issuer}/oauth2/token.
 * - Public client id b1a00492-073a-47ea-816f-4c329264a828, no client secret.
 * - Subscription model `grok-build` uses api_backend `responses` and is not on
 *   the pay-per-token API (`supported_in_api: false`).
 *
 * Hypotheses (called out where they affect the wire):
 * - The subscription proxy rejects client versions below 1.0.13 (HTTP 426).
 *   Prefer `grok --version` when it reports a version at least that floor.
 *   Otherwise send 1.0.50. Override with WEFT_GROK_CLIENT_VERSION.
 * - Extra proxy headers `x-grok-client-identifier` / `user-agent` are included
 *   because public clients report HTTP 426 without them. Official
 *   grok_auth_credentials.rs documents Authorization + X-XAI-Token-Auth.
 * - When `expires_at` is absent, grok uses create_time + 30 days. We also cap
 *   that with an unverified JWT `exp` so a short-lived token is refreshed.
 * - Refresh is refused unless the issuer host is x.ai or a subdomain, so a
 *   tampered auth.json cannot exfiltrate the refresh token.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export const GROK_ISSUER = 'https://auth.x.ai';
export const GROK_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
export const GROK_SCOPE = 'openid profile email offline_access grok-cli:access api:access conversations:read conversations:write';
export const GROK_AUTH_SCOPE = `${GROK_ISSUER}::${GROK_CLIENT_ID}`;
export const GROK_LEGACY_SCOPE = 'https://accounts.x.ai/sign-in';
export const GROK_API_KEY_SCOPE = 'xai::api_key';
export const GROK_DEVICE_CODE_URL = `${GROK_ISSUER}/oauth2/device/code`;
export const GROK_TOKEN_URL = `${GROK_ISSUER}/oauth2/token`;
export const GROK_PROXY_BASE = 'https://cli-chat-proxy.grok.com/v1';
export const GROK_SESSION_MODEL = 'grok-build';
export const GROK_CLIENT_VERSION_DEFAULT = '1.0.50';
export const GROK_CLIENT_VERSION_MIN = '1.0.13';
export const GROK_EARLY_INVALIDATION_MS = 300_000;
export const GROK_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const MIN_POLL_SECS = 1;
const SLOW_DOWN_SECS = 5;

export class GrokAuthError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
    this.name = 'GrokAuthError';
  }
}

export function grokAuthFilePath(env = process.env, home = os.homedir()) {
  if (env.WEFT_GROK_AUTH) return env.WEFT_GROK_AUTH;
  const dir = env.GROK_HOME || path.join(home, '.grok');
  return path.join(dir, 'auth.json');
}

const GROK_VERSION_RE = /(\d+)\.(\d+)\.(\d+)/;
let cachedCliVersion;

export function parseGrokVersion(text) {
  const m = String(text ?? '').match(GROK_VERSION_RE);
  if (!m) return '';
  return `${Number(m[1])}.${Number(m[2])}.${Number(m[3])}`;
}

export function grokVersionAtLeast(version, floor = GROK_CLIENT_VERSION_MIN) {
  const left = parseGrokVersion(version);
  const right = parseGrokVersion(floor);
  if (!left || !right) return false;
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return true;
}

export function readGrokCliVersion(execFile = execFileSync) {
  let text = '';
  try {
    const out = execFile('grok', ['--version'], {
      encoding: 'utf8',
      timeout: 4000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    text = typeof out === 'string' ? out : `${out?.stdout || ''}\n${out?.stderr || ''}`;
  } catch (err) {
    text = `${err?.stdout || ''}\n${err?.stderr || ''}`;
  }
  return parseGrokVersion(text);
}

export function resetGrokClientVersionCache() {
  cachedCliVersion = undefined;
}

/**
 * Env override wins. Otherwise use `grok --version` when it is at least
 * GROK_CLIENT_VERSION_MIN. A missing CLI or an older report falls back to
 * GROK_CLIENT_VERSION_DEFAULT.
 */
export function resolveGrokClientVersion(env = process.env, readCli = readGrokCliVersion) {
  const override = String(env?.WEFT_GROK_CLIENT_VERSION ?? '').trim();
  if (override) return override;
  let detected = '';
  try {
    detected = parseGrokVersion(readCli());
  } catch {
    detected = '';
  }
  if (detected && grokVersionAtLeast(detected, GROK_CLIENT_VERSION_MIN)) return detected;
  return GROK_CLIENT_VERSION_DEFAULT;
}

export function grokClientVersion(env = process.env, readCli) {
  const override = String(env?.WEFT_GROK_CLIENT_VERSION ?? '').trim();
  if (override) return override;
  if (typeof readCli === 'function') return resolveGrokClientVersion({}, readCli);
  if (cachedCliVersion === undefined) cachedCliVersion = resolveGrokClientVersion({});
  return cachedCliVersion;
}

export function grokProxyBase(env = process.env) {
  return String(env.WEFT_GROK_PROXY || GROK_PROXY_BASE).replace(/\/$/, '');
}

export function decodeJwtPayload(token) {
  const parts = String(token || '').split('.');
  if (parts.length < 2) return null;
  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf8');
    const payload = JSON.parse(json);
    if (!payload || typeof payload !== 'object') return null;
    return payload;
  } catch {
    return null;
  }
}

function parseTime(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  const t = Date.parse(String(value));
  return Number.isFinite(t) ? t : null;
}

function jwtExpMs(token) {
  const exp = decodeJwtPayload(token)?.exp;
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return null;
  return exp * 1000;
}

export function credentialExpiryMs(entry, now = Date.now()) {
  if (!entry) return now;
  const explicit = parseTime(entry.expires_at ?? entry.expiresAt);
  if (explicit != null) return explicit;
  const created = parseTime(entry.create_time ?? entry.createTime);
  const ttl = (created != null ? created : now) + GROK_TOKEN_TTL_MS;
  const jwtExp = jwtExpMs(accessTokenOf(entry));
  if (jwtExp != null) return Math.min(jwtExp, ttl);
  return ttl;
}

export function isHardExpired(entry, now = Date.now()) {
  return now >= credentialExpiryMs(entry, now);
}

export function needsRefresh(entry, now = Date.now(), earlyMs = GROK_EARLY_INVALIDATION_MS) {
  return now >= credentialExpiryMs(entry, now) - earlyMs;
}

function accessTokenOf(entry) {
  if (!entry || typeof entry !== 'object') return '';
  const key = entry.key ?? entry.access_token ?? entry.accessToken;
  return typeof key === 'string' ? key.trim() : '';
}

function refreshTokenOf(entry) {
  if (!entry || typeof entry !== 'object') return '';
  const key = entry.refresh_token ?? entry.refreshToken;
  return typeof key === 'string' ? key.trim() : '';
}

export function authModeOf(entry) {
  const raw = String(entry?.auth_mode ?? entry?.authMode ?? '').trim().toLowerCase();
  if (raw === 'grok' || raw === 'web_login') return 'web_login';
  if (raw === 'api_key' || raw === 'apikey') return 'api_key';
  if (raw === 'external') return 'external';
  if (raw === 'oidc') return 'oidc';
  return raw;
}

function isSessionEntry(entry) {
  const token = accessTokenOf(entry);
  if (!token) return false;
  const mode = authModeOf(entry);
  if (mode === 'web_login' || mode === 'api_key') return false;
  if (mode === 'oidc' || mode === 'external') return true;
  // Missing mode: legacy files sometimes store only `{ key }` (documented curl).
  return true;
}

export function lookupSessionEntry(store) {
  if (!store || typeof store !== 'object' || Array.isArray(store)) return null;
  const tryKey = (key) => {
    const entry = store[key];
    if (!isSessionEntry(entry)) return null;
    return { scope: key, entry };
  };
  const canonical = tryKey(GROK_AUTH_SCOPE);
  if (canonical) return canonical;
  const keys = Object.keys(store).filter((k) => k.startsWith(`${GROK_ISSUER}::`) && k !== GROK_AUTH_SCOPE).sort();
  for (const key of keys) {
    const hit = tryKey(key);
    if (hit) return hit;
  }
  return tryKey(GROK_LEGACY_SCOPE);
}

function displayAccount(entry) {
  const email = typeof entry.email === 'string' ? entry.email.trim() : '';
  if (email) return email;
  const id = typeof entry.user_id === 'string' ? entry.user_id.trim() : '';
  if (id && id.length <= 128 && !id.includes('.')) return id;
  return 'Grok';
}

export function publicSession(entry, now = Date.now()) {
  if (!entry || !isSessionEntry(entry)) {
    return {
      signedIn: false,
      account: null,
      email: null,
      expiresAt: null,
      authMode: null,
      source: null,
    };
  }
  const refresh = refreshTokenOf(entry);
  const hard = isHardExpired(entry, now);
  if (hard && !refresh) {
    return {
      signedIn: false,
      account: null,
      email: null,
      expiresAt: new Date(credentialExpiryMs(entry, now)).toISOString(),
      authMode: authModeOf(entry) || null,
      source: null,
    };
  }
  const email = typeof entry.email === 'string' && entry.email.trim() ? entry.email.trim() : null;
  return {
    signedIn: true,
    account: displayAccount(entry),
    email,
    expiresAt: new Date(credentialExpiryMs(entry, now)).toISOString(),
    authMode: authModeOf(entry) || 'oidc',
    source: 'grok-auth-json',
  };
}

export function redactAuthText(text) {
  return String(text ?? '')
    .slice(0, 500)
    .replace(/sk-[A-Za-z0-9_-]{6,}/g, 'sk-***')
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, 'jwt-***');
}

export function assertSafeVerificationUri(uri) {
  let parsed;
  try { parsed = new URL(String(uri || '')); } catch {
    throw new GrokAuthError('bad_verification_uri', 'invalid verification uri');
  }
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== 'https:' || (host !== 'x.ai' && !host.endsWith('.x.ai'))) {
    throw new GrokAuthError('bad_verification_uri', 'unexpected verification uri');
  }
  return parsed.href;
}

export function assertUserCode(code) {
  const s = String(code || '');
  if (!/^[A-Za-z0-9-]{1,64}$/.test(s)) {
    throw new GrokAuthError('bad_user_code', 'invalid user code');
  }
  return s;
}

export function interpretDeviceToken(status, body) {
  const data = body && typeof body === 'object' ? body : {};
  if (typeof data.access_token === 'string' && data.access_token.trim()) {
    return { kind: 'ok', tokens: data };
  }
  const error = typeof data.error === 'string' ? data.error : '';
  if (error === 'authorization_pending') return { kind: 'pending' };
  if (error === 'slow_down') return { kind: 'slow_down' };
  if (error === 'access_denied') return { kind: 'denied' };
  if (error === 'expired_token') return { kind: 'expired' };
  if (status >= 200 && status < 300) return { kind: 'error', code: 'no_token' };
  return { kind: 'error', code: error || `http_${status || 0}` };
}

export function entryFromTokenResponse(tokens, now = Date.now(), prev = null) {
  const access = String(tokens?.access_token || '').trim();
  if (!access) throw new GrokAuthError('no_token', 'token response missing access_token');
  const accessClaims = decodeJwtPayload(access) || {};
  const idClaims = tokens.id_token ? (decodeJwtPayload(tokens.id_token) || {}) : {};
  const email = (typeof idClaims.email === 'string' && idClaims.email)
    || (typeof accessClaims.email === 'string' && accessClaims.email)
    || (typeof prev?.email === 'string' ? prev.email : null);
  const userId = (typeof idClaims.sub === 'string' && idClaims.sub)
    || (typeof accessClaims.sub === 'string' && accessClaims.sub)
    || (typeof prev?.user_id === 'string' ? prev.user_id : '');
  let expiresAt = null;
  if (tokens.expires_in != null && Number.isFinite(Number(tokens.expires_in))) {
    expiresAt = new Date(now + Number(tokens.expires_in) * 1000).toISOString();
  } else if (typeof accessClaims.exp === 'number') {
    expiresAt = new Date(accessClaims.exp * 1000).toISOString();
  }
  const refresh = (typeof tokens.refresh_token === 'string' && tokens.refresh_token.trim())
    || refreshTokenOf(prev)
    || '';
  const entry = {
    key: access,
    auth_mode: 'oidc',
    create_time: new Date(now).toISOString(),
    user_id: userId || '',
    refresh_token: refresh || undefined,
    expires_at: expiresAt || undefined,
    oidc_issuer: (typeof prev?.oidc_issuer === 'string' && prev.oidc_issuer) || GROK_ISSUER,
    oidc_client_id: (typeof prev?.oidc_client_id === 'string' && prev.oidc_client_id) || GROK_CLIENT_ID,
  };
  if (email) entry.email = email;
  for (const field of ['first_name', 'last_name', 'principal_type', 'principal_id', 'team_id', 'team_name', 'team_role', 'organization_id', 'organization_name', 'organization_role']) {
    if (prev && prev[field] != null && entry[field] == null) entry[field] = prev[field];
  }
  return entry;
}

function issuerTokenUrl(entry) {
  const issuer = String(entry?.oidc_issuer || GROK_ISSUER).replace(/\/$/, '');
  let parsed;
  try { parsed = new URL(issuer); } catch {
    throw new GrokAuthError('bad_issuer', 'invalid issuer');
  }
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== 'https:' || (host !== 'x.ai' && !host.endsWith('.x.ai'))) {
    throw new GrokAuthError('bad_issuer', 'refusing to refresh against a non-x.ai issuer');
  }
  return `${issuer}/oauth2/token`;
}

export function grokProxyHeaders(accessToken, model, version = grokClientVersion()) {
  const mdl = model || GROK_SESSION_MODEL;
  return {
    authorization: `Bearer ${accessToken}`,
    'x-xai-token-auth': 'xai-grok-cli',
    'x-grok-client-version': version,
    'x-grok-client-identifier': 'grok-shell',
    'x-grok-model-override': mdl,
    'user-agent': `xai-grok-cli/${version}`,
    accept: 'application/json',
  };
}

export const UNCONFIGURED_MODEL_CODE = 'E_NO_MODEL';
export const UNCONFIGURED_MODEL_MESSAGE = 'err_no_model';

export function unconfiguredModelError() {
  const err = new Error(UNCONFIGURED_MODEL_MESSAGE);
  err.code = UNCONFIGURED_MODEL_CODE;
  return err;
}

function namedRuntime(value) {
  const text = String(value || '').trim().toLowerCase();
  if (text === 'faux' || text === 'openai') return text;
  return '';
}

/**
 * A scripted model is used only when it is requested: `WEFT_LLM=faux`,
 * `LLM_API=faux`, or `WEFT_FAUX_SCRIPT`. Explicit `openai` forces the real
 * client. Otherwise a Grok session, API key, or base URL selects that client.
 * With none of those, return `none` so the server refuses the turn.
 */
export function selectChatRuntime(explicit, {
  hasSession = false,
  hasApiKey = false,
  hasBaseUrl = false,
  llmApi = '',
  fauxScript = false,
} = {}) {
  const chosen = namedRuntime(explicit);
  if (chosen) return chosen;
  if (namedRuntime(llmApi) === 'faux' || fauxScript) return 'faux';
  if (hasSession || hasApiKey || hasBaseUrl) return 'openai';
  return 'none';
}

async function readStore(file) {
  try {
    const raw = await fs.readFile(file, 'utf8');
    if (!raw.trim()) return { ok: true, store: {} };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, store: {} };
    return { ok: true, store: parsed };
  } catch (err) {
    if (err?.code === 'ENOENT') return { ok: true, store: {} };
    return { ok: false, store: {} };
  }
}

async function writeStore(file, store) {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  try { await fs.chmod(dir, 0o700); } catch { /* windows */ }
  const tmp = path.join(dir, `.auth.${process.pid}.${randomUUID()}.tmp`);
  const json = `${JSON.stringify(store, null, 2)}\n`;
  await fs.writeFile(tmp, json, { mode: 0o600 });
  try { await fs.chmod(tmp, 0o600); } catch { /* windows */ }
  try {
    await fs.rename(tmp, file);
  } catch (err) {
    try { await fs.unlink(tmp); } catch { /* ignore */ }
    throw err;
  }
  try { await fs.chmod(file, 0o600); } catch { /* windows */ }
}

function oauthHeaders(version) {
  return {
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'application/json',
    'x-grok-client-version': version,
    'x-grok-client-surface': 'ui',
  };
}

async function readJsonResponse(res) {
  const text = await res.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch {
    throw new GrokAuthError('bad_json', 'auth server returned invalid JSON');
  }
}

export function createGrokAuth(options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;
  const now = () => (typeof options.now === 'function' ? options.now() : Date.now());
  const earlyMs = () => (Number.isFinite(options.earlyMs) ? options.earlyMs : GROK_EARLY_INVALIDATION_MS);
  const authFile = () => options.authFile || grokAuthFilePath();
  const version = () => options.clientVersion || grokClientVersion();
  const pending = new Map();
  let refreshInflight = null;

  async function load() {
    const file = authFile();
    const { ok, store } = await readStore(file);
    if (!ok) return { file, store: {}, found: null, corrupt: true };
    const found = lookupSessionEntry(store);
    return { file, store, found, corrupt: false };
  }

  function withPending(base) {
    const current = [...pending.values()].find((p) => !p.done) || null;
    if (!current) return { ...base, pending: null };
    return {
      ...base,
      pending: {
        loginId: current.loginId,
        verificationUri: current.verificationUri,
        userCode: current.userCode,
        interval: current.interval,
        expiresAt: new Date(current.expiresAt).toISOString(),
      },
    };
  }

  async function status() {
    const { found } = await load();
    const base = publicSession(found?.entry, now());
    return withPending(base);
  }

  async function persistEntry(scope, entry) {
    const file = authFile();
    const { ok, store } = await readStore(file);
    const next = ok ? { ...store } : {};
    next[scope] = entry;
    await writeStore(file, next);
  }

  async function refreshFound(found) {
    const refresh = refreshTokenOf(found.entry);
    if (!refresh) throw new GrokAuthError('no_refresh', 'session has no refresh token');
    const clientId = found.entry.oidc_client_id || GROK_CLIENT_ID;
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: String(clientId),
      refresh_token: refresh,
    });
    const res = await fetchImpl(issuerTokenUrl(found.entry), {
      method: 'POST',
      redirect: 'error',
      headers: oauthHeaders(version()),
      body: body.toString(),
    });
    const data = await readJsonResponse(res);
    if (!res.ok || !data.access_token) {
      throw new GrokAuthError('refresh_failed', 'token refresh failed');
    }
    const entry = entryFromTokenResponse(data, now(), found.entry);
    await persistEntry(found.scope, entry);
    return { scope: found.scope, entry };
  }

  function queueRefresh(found) {
    if (!refreshInflight) {
      refreshInflight = refreshFound(found).finally(() => { refreshInflight = null; });
    }
    return refreshInflight;
  }

  async function resolveAccessToken({ force = false } = {}) {
    const { found } = await load();
    if (!found) return null;
    const t = now();
    const refresh = refreshTokenOf(found.entry);
    const stale = force || needsRefresh(found.entry, t, earlyMs());
    if (!stale) {
      return { accessToken: accessTokenOf(found.entry), entry: found.entry };
    }
    if (!refresh) {
      if (isHardExpired(found.entry, t)) return null;
      return { accessToken: accessTokenOf(found.entry), entry: found.entry };
    }
    try {
      const updated = await queueRefresh(found);
      return { accessToken: accessTokenOf(updated.entry), entry: updated.entry };
    } catch (err) {
      if (!force && !isHardExpired(found.entry, t)) {
        return { accessToken: accessTokenOf(found.entry), entry: found.entry };
      }
      throw err;
    }
  }

  async function forceRefresh() {
    return resolveAccessToken({ force: true });
  }

  async function startLogin() {
    const body = new URLSearchParams({
      client_id: GROK_CLIENT_ID,
      scope: GROK_SCOPE,
      referrer: 'grok-build',
    });
    const res = await fetchImpl(GROK_DEVICE_CODE_URL, {
      method: 'POST',
      redirect: 'error',
      headers: oauthHeaders(version()),
      body: body.toString(),
    });
    const data = await readJsonResponse(res);
    if (!res.ok) throw new GrokAuthError('device_unavailable', 'device login is unavailable');
    const verificationUri = assertSafeVerificationUri(data.verification_uri_complete || data.verification_uri);
    assertSafeVerificationUri(data.verification_uri);
    const userCode = assertUserCode(data.user_code);
    const deviceCode = String(data.device_code || '');
    if (!deviceCode) throw new GrokAuthError('device_unavailable', 'device login is unavailable');
    const interval = Math.max(MIN_POLL_SECS, Number(data.interval) || 5);
    const expiresIn = Math.max(60, Number(data.expires_in) || 300);
    for (const old of pending.values()) old.done = true;
    pending.clear();
    const loginId = randomUUID();
    const session = {
      loginId,
      deviceCode,
      verificationUri,
      userCode,
      interval,
      expiresAt: now() + expiresIn * 1000,
      done: false,
      inflight: null,
    };
    pending.set(loginId, session);
    return {
      loginId,
      verificationUri,
      userCode,
      interval,
      expiresAt: new Date(session.expiresAt).toISOString(),
    };
  }

  async function pollLogin(loginId) {
    const session = pending.get(String(loginId || ''));
    if (!session || session.done) throw new GrokAuthError('no_login', 'no device login in progress');
    if (now() >= session.expiresAt) {
      session.done = true;
      pending.delete(session.loginId);
      throw new GrokAuthError('expired', 'device code expired');
    }
    if (session.inflight) return session.inflight;
    session.inflight = pollOnce(session).finally(() => { session.inflight = null; });
    return session.inflight;
  }

  async function pollOnce(session) {
    const body = new URLSearchParams({
      grant_type: DEVICE_GRANT,
      device_code: session.deviceCode,
      client_id: GROK_CLIENT_ID,
    });
    const res = await fetchImpl(GROK_TOKEN_URL, {
      method: 'POST',
      redirect: 'error',
      headers: oauthHeaders(version()),
      body: body.toString(),
    });
    let data = {};
    try { data = await readJsonResponse(res); } catch {
      throw new GrokAuthError('bad_json', 'auth server returned invalid JSON');
    }
    const result = interpretDeviceToken(res.status, data);
    if (result.kind === 'pending') {
      return { status: 'pending', interval: session.interval, expiresAt: new Date(session.expiresAt).toISOString() };
    }
    if (result.kind === 'slow_down') {
      session.interval += SLOW_DOWN_SECS;
      return { status: 'pending', interval: session.interval, expiresAt: new Date(session.expiresAt).toISOString() };
    }
    if (result.kind === 'denied') throw new GrokAuthError('denied', 'sign-in was denied');
    if (result.kind === 'expired') {
      session.done = true;
      pending.delete(session.loginId);
      throw new GrokAuthError('expired', 'device code expired');
    }
    if (result.kind !== 'ok') throw new GrokAuthError('login_failed', 'device login failed');
    const entry = entryFromTokenResponse(result.tokens, now(), null);
    await persistEntry(GROK_AUTH_SCOPE, entry);
    session.done = true;
    pending.delete(session.loginId);
    return { status: 'done', grok: withPending(publicSession(entry, now())) };
  }

  async function logout() {
    const file = authFile();
    const { ok, store } = await readStore(file);
    if (!ok || !store || !Object.keys(store).length) {
      return withPending({ signedIn: false, account: null, email: null, expiresAt: null, authMode: null, source: null });
    }
    const next = { ...store };
    for (const key of Object.keys(next)) {
      if (key === GROK_API_KEY_SCOPE) continue;
      const mode = authModeOf(next[key]);
      if (mode === 'api_key') continue;
      if (key === GROK_AUTH_SCOPE || key === GROK_LEGACY_SCOPE || key.startsWith(`${GROK_ISSUER}::`)) {
        delete next[key];
      }
    }
    await writeStore(file, next);
    return withPending(publicSession(null, now()));
  }

  function cancelLogin(loginId) {
    if (loginId) pending.delete(String(loginId));
    else pending.clear();
    return status();
  }

  return {
    status,
    startLogin,
    pollLogin,
    logout,
    cancelLogin,
    resolveAccessToken,
    forceRefresh,
    authFile,
  };
}
