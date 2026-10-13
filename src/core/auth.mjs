import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const COOKIE_NAME = 'pi_work_token';

export const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

const sseTickets = new Map();

export function tokensMatch(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && b.length > 0 && timingSafeEqual(a, b);
}

export async function loadOrCreateToken(dataDir) {
  const env = String(process.env.PI_WORK_TOKEN || '').trim();
  if (env) return { token: env, generated: false, source: 'env' };
  const tokenPath = path.join(dataDir, 'auth.token');
  try {
    const fromFile = (await fs.readFile(tokenPath, 'utf8')).trim();
    if (fromFile) {
      try { await fs.chmod(tokenPath, 0o600); } catch { /* ignore */ }
      return { token: fromFile, generated: false, source: 'file' };
    }
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
  const token = randomBytes(32).toString('hex');
  await fs.writeFile(tokenPath, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
  try { await fs.chmod(tokenPath, 0o600); } catch { /* ignore */ }
  return { token, generated: true, source: 'generated' };
}

export function cookieToken(req) {
  const raw = req.headers.cookie;
  if (!raw) return '';
  let found = '';
  for (const part of String(raw).split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k === COOKIE_NAME) {
      try { found = decodeURIComponent(v); } catch { found = v; }
    }
  }
  return found;
}

export function requestAuthorized(req, token) {
  if (!token) return false;
  const header = req.headers.authorization || '';
  const prefix = 'Bearer ';
  if (header.startsWith(prefix) && tokensMatch(header.slice(prefix.length), token)) return true;
  const ck = cookieToken(req);
  if (ck && tokensMatch(ck, token)) return true;
  return false;
}

function extraHosts(port) {
  const raw = String(process.env.PI_WORK_ALLOWED_HOSTS || '');
  const out = [];
  for (const part of raw.split(',')) {
    const h = part.trim().toLowerCase();
    if (!h) continue;
    out.push(h);
    if (!h.includes(':')) out.push(`${h}:${port}`);
  }
  return out;
}

export function allowedHosts(port) {
  const set = new Set([
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    `[::1]:${port}`,
    ...extraHosts(port),
  ]);
  return set;
}

export function hostAllowed(hostHeader, port) {
  const host = String(hostHeader || '').trim().toLowerCase();
  if (!host) return false;
  return allowedHosts(port).has(host);
}

export function originAllowed(origin, port) {
  if (origin == null || origin === '') return true;
  try {
    const u = new URL(origin);
    return hostAllowed(u.host, port);
  } catch {
    return false;
  }
}

export function isMutating(method) {
  const m = String(method || '').toUpperCase();
  return m === 'POST' || m === 'PUT' || m === 'PATCH' || m === 'DELETE';
}

export function isJsonContentType(req) {
  const ct = String(req.headers['content-type'] || '').toLowerCase();
  return ct.startsWith('application/json');
}

export function isSecureRequest(req) {
  if (req.socket?.encrypted) return true;
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  return proto === 'https';
}

export function setCookieHeader(token, { secure = false } = {}) {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function issueSseTicket(ttlMs = 60_000) {
  const ticket = randomBytes(24).toString('hex');
  const expiresAt = Date.now() + ttlMs;
  sseTickets.set(ticket, expiresAt);
  if (sseTickets.size > 256) {
    const now = Date.now();
    for (const [k, exp] of sseTickets) {
      if (exp <= now) sseTickets.delete(k);
    }
  }
  return { ticket, expiresAt: new Date(expiresAt).toISOString() };
}

export function consumeSseTicket(ticket) {
  if (!ticket || typeof ticket !== 'string') return false;
  const expiresAt = sseTickets.get(ticket);
  sseTickets.delete(ticket);
  if (expiresAt == null) return false;
  if (Date.now() > expiresAt) return false;
  return true;
}
