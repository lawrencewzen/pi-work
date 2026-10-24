import http from 'node:http';
import https from 'node:https';
import { readFile } from 'node:fs/promises';

const CERT_RE = /CERT_|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER|ALTNAME/i;
const NETWORK_CODES = new Set([
  'ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'ECONNABORTED',
]);

export function classifyGitlabFailure(err, status) {
  if (status === 401 || status === 403) return 'auth_failed';
  const code = String(err?.code || '');
  const message = String(err?.message || '');
  if (code === 'ETIMEDOUT' || code === 'ECONNABORTED' || /timeout/i.test(message)) return 'timeout';
  if (CERT_RE.test(`${code} ${message}`)) return 'cert_failed';
  if (NETWORK_CODES.has(code)) return 'network';
  if (status === 404) return 'repo_not_found';
  return 'unknown';
}

export function httpAllowed(connection) {
  let url;
  try {
    url = new URL(connection.baseUrl);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && connection.kind === 'gitlab-self' && connection.allowHttp === true;
}

function endpoint(baseUrl, pathname, query) {
  const url = new URL(pathname, `${baseUrl.replace(/\/$/, '')}/`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value != null && value !== '') url.searchParams.set(key, String(value));
    }
  }
  return url;
}

export async function gitlabRequest({ baseUrl, token, caFile, pathname, query, timeoutMs = 20_000 }) {
  const url = endpoint(baseUrl, pathname, query);
  const secure = url.protocol === 'https:';
  let ca;
  if (secure && caFile) {
    try {
      ca = await readFile(caFile);
    } catch (err) {
      const wrapped = new Error('ca file unreadable');
      wrapped.code = err?.code === 'ENOENT' ? 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' : 'CERT_HAS_EXPIRED';
      throw wrapped;
    }
  }
  const lib = secure ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (secure ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      headers: {
        'PRIVATE-TOKEN': token,
        Accept: 'application/json',
        'User-Agent': 'weft',
      },
      ca,
      servername: url.hostname,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          status: res.statusCode || 0,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function callGitlab(connection, pathname, query) {
  if (!connection?.token) return { ok: false, code: 'auth_failed' };
  if (!httpAllowed(connection)) return { ok: false, code: 'http_not_allowed' };
  try {
    const res = await gitlabRequest({
      baseUrl: connection.baseUrl,
      token: connection.token,
      caFile: connection.caFile,
      pathname,
      query,
    });
    return { ok: true, status: res.status, body: res.body };
  } catch (err) {
    return { ok: false, code: classifyGitlabFailure(err) };
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function testGitlabConnection(connection) {
  if (connection?.kind === 'other') {
    // Still ask GitLab's user API so a mis-labeled instance can succeed.
  }
  const res = await callGitlab(connection, '/api/v4/user');
  if (!res.ok) return { ok: false, code: res.code };
  if (res.status === 401 || res.status === 403) return { ok: false, code: 'auth_failed' };
  if (res.status === 404 || res.status < 200 || res.status >= 300) return { ok: false, code: 'unknown' };
  const data = parseJson(res.body);
  const username = data && typeof data === 'object' ? String(data.username || data.name || '').trim() : '';
  if (!username) return { ok: false, code: 'unknown' };
  return { ok: true, username: username.slice(0, 200) };
}

function cleanRepoUrl(value, origin) {
  if (!value) return '';
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.hash = '';
    url.search = '';
    return `${url.origin}${url.pathname}`;
  } catch {
    return origin || '';
  }
}

export function mapGitlabProject(item, origin) {
  if (!item || typeof item !== 'object') return null;
  const path = String(item.path_with_namespace || item.path || '').trim();
  const id = item.id;
  if (id == null || !path) return null;
  let httpUrl = cleanRepoUrl(item.http_url_to_repo, origin);
  if (!httpUrl && origin) httpUrl = `${origin}/${path}.git`;
  return {
    id,
    path,
    description: String(item.description || ''),
    defaultBranch: String(item.default_branch || ''),
    lastActivityAt: String(item.last_activity_at || ''),
    httpUrl,
  };
}

export async function listGitlabProjects(connection, search = '') {
  if (connection?.kind === 'other') return { ok: false, code: 'not_gitlab' };
  const query = {
    membership: 'true',
    simple: 'true',
    order_by: 'last_activity_at',
    per_page: '50',
  };
  const term = String(search || '').trim();
  if (term) query.search = term.slice(0, 200);
  const res = await callGitlab(connection, '/api/v4/projects', query);
  if (!res.ok) return { ok: false, code: res.code };
  if (res.status === 401 || res.status === 403) return { ok: false, code: 'auth_failed' };
  if (res.status === 404) return { ok: false, code: 'unknown' };
  if (res.status < 200 || res.status >= 300) return { ok: false, code: 'unknown' };
  const data = parseJson(res.body);
  if (!Array.isArray(data)) return { ok: false, code: 'unknown' };
  const projects = data.map((item) => mapGitlabProject(item, connection.baseUrl)).filter(Boolean);
  return { ok: true, projects };
}

export function encodeProjectId(projectId) {
  const text = String(projectId ?? '').trim();
  if (!text || text.length > 300 || text.includes('..') || /[\0\r\n\s]/.test(text)) return '';
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(text)) return '';
  return encodeURIComponent(text);
}

export async function getGitlabProject(connection, projectId) {
  if (connection?.kind === 'other') return { ok: false, code: 'not_gitlab' };
  const id = encodeProjectId(projectId);
  if (!id) return { ok: false, code: 'repo_not_found' };
  const res = await callGitlab(connection, `/api/v4/projects/${id}`);
  if (!res.ok) return { ok: false, code: res.code };
  if (res.status === 401 || res.status === 403) return { ok: false, code: 'auth_failed' };
  if (res.status === 404) return { ok: false, code: 'repo_not_found' };
  if (res.status < 200 || res.status >= 300) return { ok: false, code: 'unknown' };
  const data = parseJson(res.body);
  const project = mapGitlabProject(data, connection.baseUrl);
  if (!project) return { ok: false, code: 'unknown' };
  return { ok: true, project };
}

export async function listGitlabBranches(connection, projectId) {
  if (connection?.kind === 'other') return { ok: false, code: 'not_gitlab' };
  const id = encodeProjectId(projectId);
  if (!id) return { ok: false, code: 'repo_not_found' };
  const res = await callGitlab(connection, `/api/v4/projects/${id}/repository/branches`, { per_page: '100' });
  if (!res.ok) return { ok: false, code: res.code };
  if (res.status === 401 || res.status === 403) return { ok: false, code: 'auth_failed' };
  if (res.status === 404) return { ok: false, code: 'branch_not_found' };
  if (res.status < 200 || res.status >= 300) return { ok: false, code: 'unknown' };
  const data = parseJson(res.body);
  if (!Array.isArray(data)) return { ok: false, code: 'unknown' };
  const branches = data.map((item) => ({
    name: String(item?.name || ''),
    default: item?.default === true,
  })).filter((item) => item.name);
  const marked = branches.find((item) => item.default);
  return { ok: true, branches, defaultBranch: marked?.name || '' };
}

export function cloneUrlForProject(connection, project) {
  const base = new URL(connection.baseUrl);
  const raw = project?.httpUrl || '';
  if (!raw) {
    const err = new Error('repo not found');
    err.gitCode = 'repo_not_found';
    err.status = 400;
    throw err;
  }
  const url = new URL(raw);
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  if (url.hostname.toLowerCase() !== base.hostname.toLowerCase()) {
    const err = new Error('repo not found');
    err.gitCode = 'repo_not_found';
    err.status = 400;
    throw err;
  }
  return `${base.origin}${url.pathname}`;
}
