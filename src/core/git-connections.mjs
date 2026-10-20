import { randomUUID } from 'node:crypto';
import { isMaskedOrEmptyApiKey, maskApiKey } from './settings.mjs';

export const GIT_KINDS = new Set(['gitlab-self', 'gitlab-com', 'other']);
export const GITLAB_COM_ORIGIN = 'https://gitlab.com';
const MAX_CONNECTIONS = 50;

export function normalizeOrigin(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  let url;
  try {
    url = new URL(text.includes('://') ? text : `https://${text}`);
  } catch {
    return '';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
  if (url.username || url.password) return '';
  if (!url.hostname || url.hostname.startsWith('-')) return '';
  return url.origin;
}

function normalizeLastTest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const ok = value.ok === true;
  return {
    ok,
    username: ok ? String(value.username || '').slice(0, 200) : '',
    error: ok ? '' : String(value.error || '').slice(0, 64),
    at: String(value.at || '').slice(0, 40),
  };
}

function connectionFromParts(input, { requireToken }) {
  const errors = [];
  const kind = String(input?.kind || '');
  if (!GIT_KINDS.has(kind)) errors.push('invalid kind');
  const name = String(input?.name || '').trim();
  if (!name) errors.push('name required');
  else if (name.length > 80) errors.push('name too long');
  const baseUrl = kind === 'gitlab-com' ? GITLAB_COM_ORIGIN : normalizeOrigin(input?.baseUrl);
  if (kind !== 'gitlab-com' && !baseUrl) errors.push('invalid baseUrl');
  const token = String(input?.token || '');
  if (requireToken && !token.trim()) errors.push('token required');
  if (token.length > 4096) errors.push('token too long');
  const caFile = String(input?.caFile || '').trim();
  if (/[\0\r\n]/.test(caFile) || caFile.length > 1024) errors.push('invalid caFile');
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      name,
      kind,
      baseUrl: kind === 'gitlab-com' ? GITLAB_COM_ORIGIN : baseUrl,
      token,
      allowHttp: kind === 'gitlab-self' && input?.allowHttp === true,
      caFile,
    },
  };
}

/** Drop broken rows. Tokens are kept; this does not mask them. */
export function normalizeGitConnections(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const id = String(item.id || '');
    if (!/^[A-Za-z0-9-]{8,80}$/.test(id) || seen.has(id)) continue;
    const built = connectionFromParts(item, { requireToken: true });
    if (!built.ok) continue;
    seen.add(id);
    out.push({
      id,
      ...built.value,
      lastTest: normalizeLastTest(item.lastTest),
    });
  }
  return out.slice(0, MAX_CONNECTIONS);
}

export function createGitConnection(input, { id = randomUUID() } = {}) {
  const built = connectionFromParts(input, { requireToken: true });
  if (!built.ok) return built;
  return { ok: true, value: { id, ...built.value, lastTest: null } };
}

export function updateGitConnection(current, patch = {}) {
  if (!current) return { ok: false, errors: ['not found'] };
  const next = {
    kind: patch.kind != null ? patch.kind : current.kind,
    name: patch.name != null ? patch.name : current.name,
    baseUrl: patch.baseUrl != null ? patch.baseUrl : current.baseUrl,
    caFile: patch.caFile != null ? patch.caFile : current.caFile,
    allowHttp: patch.allowHttp != null ? patch.allowHttp === true : current.allowHttp === true,
    token: current.token,
  };
  if (Object.prototype.hasOwnProperty.call(patch, 'token')
    && !isMaskedOrEmptyApiKey(patch.token, maskApiKey(current.token))) {
    next.token = String(patch.token);
  }
  const built = connectionFromParts(next, { requireToken: true });
  if (!built.ok) return built;
  return {
    ok: true,
    value: { id: current.id, ...built.value, lastTest: normalizeLastTest(current.lastTest) },
  };
}

export function publicGitConnection(conn) {
  const token = String(conn?.token || '');
  return {
    id: conn.id,
    name: conn.name,
    kind: conn.kind,
    baseUrl: conn.baseUrl,
    token: maskApiKey(token),
    hasToken: Boolean(token),
    allowHttp: conn.allowHttp === true,
    caFile: conn.caFile || '',
    lastTest: conn.lastTest || null,
  };
}

export function recordGitTest(conn, result, at = new Date().toISOString()) {
  const ok = result?.ok === true;
  return {
    ...conn,
    lastTest: {
      ok,
      username: ok ? String(result.username || '').slice(0, 200) : '',
      error: ok ? '' : String(result.code || 'unknown').slice(0, 64),
      at,
    },
  };
}

function hostOf(baseUrl) {
  try {
    return new URL(baseUrl).host.toLowerCase();
  } catch {
    return '';
  }
}

export function gitUrlHost(gitUrl) {
  const s = String(gitUrl || '').trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    try {
      return new URL(s).host.toLowerCase();
    } catch {
      return '';
    }
  }
  const ssh = s.match(/^git@([^:\s]+):(\S+)$/);
  if (ssh) return String(ssh[1] || '').toLowerCase();
  return '';
}

/** Only an exact host:port match: a connection's token never goes to another port or host. */
export function matchConnectionByUrl(connections, gitUrl) {
  const host = gitUrlHost(gitUrl);
  if (!host) return null;
  const list = Array.isArray(connections) ? connections : [];
  return list.find((conn) => hostOf(conn.baseUrl) === host) || null;
}

export function gitlabTokenPage(baseUrl) {
  const origin = normalizeOrigin(baseUrl);
  if (!origin) return '';
  return `${origin}/-/user_settings/personal_access_tokens`;
}
