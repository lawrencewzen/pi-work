import http, { createServer } from 'node:http';
import { createReadStream, existsSync, statSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOLS as BUILTIN_TOOLS } from './src/core/config.mjs';
import { resolveInWorkspace } from './src/core/paths.mjs';
import { listWorkspaceTree } from './src/core/workspace-tree.mjs';
import { diffStats } from './src/core/diff.mjs';
import { publicSettings, isMaskedOrEmptyApiKey } from './src/core/settings.mjs';
import {
  VENDOR_PRESETS,
  publicSource,
  migrateLegacySettings,
  resolveConversationModelPatch,
  hasAvailableSource,
  validateRoleModels,
  createApiSource,
  applySourcePatch,
  contextWindowForConversation,
  grokSourceTemplate,
  sourceFromEnv,
  probeModels,
  probeFailurePayload,
  modelsAfterProbe,
  effectiveBaseUrl,
  vendorPreset,
  sourceNeedsKey,
  normalizeHttpUrl,
  GROK_SOURCE_ID,
} from './src/core/model-sources.mjs';
import { cloneGitRepo, stripGitUrlCredentials } from './src/core/git-import.mjs';
import {
  createGitConnection,
  matchConnectionByUrl,
  publicGitConnection,
  recordGitTest,
  updateGitConnection,
} from './src/core/git-connections.mjs';
import { cloneUrlForProject, getGitlabProject, listGitlabBranches, listGitlabProjects, testGitlabConnection } from './src/core/gitlab-api.mjs';
import { createExtensionHost } from './src/core/extensions.mjs';
import { describePlugins, installPlugin, PLUGIN_ID } from './src/core/plugins.mjs';
import { listSkills, listSkillRecords, createSkill, updateSkill, deleteSkill, SKILL_ID } from './src/core/skills.mjs';
import { buildAgents } from './src/core/agents.mjs';
import { createSqliteStore } from './src/store/sqlite.mjs';
import {
  createGrokAuth,
  selectChatRuntime,
  GROK_SESSION_MODEL,
  GrokAuthError,
} from './src/core/grok-auth.mjs';
import {
  resolveAuthToken,
  unauthenticatedHostsWarning,
  requestAuthorized,
  hostAllowed,
  originAllowed,
  isMutating,
  isJsonContentType,
  isSecureRequest,
  setCookieHeader,
  SECURITY_HEADERS,
  issueSseTicket,
  consumeSseTicket,
  tokensMatch,
} from './src/core/auth.mjs';
import { resolveAllowedWorkspacePath, defaultWorkspaceRoot, listBrowsableDirs } from './src/core/workspace-guard.mjs';
import { acquireDataDirLock } from './src/core/lock.mjs';
import { presentConversationContext } from './src/core/usage.mjs';
import { openConversationKernel } from './src/kernel/conversations.mjs';
import fs from 'node:fs/promises';

// 内置 fetch 默认不读 HTTP(S)_PROXY；配置了代理时让模型请求也走它（遵守 NO_PROXY）
const PROXY_ENV = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'].some((k) => String(process.env[k] || '').trim());
if (PROXY_ENV && process.env.NODE_USE_ENV_PROXY !== '1') {
  if (typeof http.setGlobalProxyFromEnv === 'function') http.setGlobalProxyFromEnv();
  else console.warn('WEFT_WARN 检测到代理环境变量，但当前 Node 不支持 http.setGlobalProxyFromEnv，请以 NODE_USE_ENV_PROXY=1 启动');
}

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const PORT = process.env.PORT !== undefined && process.env.PORT !== '' ? Number(process.env.PORT) : 3000;
const DATA_DIR = process.env.WEFT_DATA_DIR || path.join(ROOT, 'data');
const SKILL_DIRS = [path.join(ROOT, 'skills'), path.join(DATA_DIR, 'skills')];
const PLUGIN_DIRS = [path.join(ROOT, 'plugins'), path.join(DATA_DIR, 'plugins')];
const USER_SKILLS = path.join(DATA_DIR, 'skills');
const USER_PLUGINS = path.join(DATA_DIR, 'plugins');
await fs.mkdir(DATA_DIR, { recursive: true });

let dataLock;
try {
  dataLock = await acquireDataDirLock(DATA_DIR);
} catch (err) {
  console.error(`WEFT_ERROR ${err.message || err}`);
  process.exit(1);
}

const { token: AUTH_TOKEN, enabled: AUTH_ENABLED } = resolveAuthToken();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
  '.woff2': 'font/woff2',
};

function sendCatalogError(res, err) {
  const status = Number(err?.status) || 500;
  const body = { error: status >= 500 ? 'server error' : (err?.message || 'error') };
  if (err?.catalogCode) body.code = err.catalogCode;
  sendJson(res, status, body);
}

function sendJson(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(payload);
}

function boundPort() {
  const addr = server.address();
  return typeof addr === 'object' && addr ? addr.port : PORT;
}

async function readBody(req, limit = 2_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const err = new Error('payload too large');
      err.status = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const err = new Error('invalid JSON');
    err.status = 400;
    throw err;
  }
}

function envRequestsFaux() {
  return selectChatRuntime(process.env.WEFT_LLM, {
    llmApi: process.env.LLM_API,
    fauxScript: Boolean(String(process.env.WEFT_FAUX_SCRIPT || '').trim()),
  }) === 'faux';
}

function emptyGrokStatus() {
  return { signedIn: false, account: null, email: null, expiresAt: null, authMode: null, source: null, pending: null };
}

async function currentGrok() {
  try {
    return await grokAuth.status();
  } catch {
    return emptyGrokStatus();
  }
}

let droppedLegacySettingsFields = false;

async function ensureSettings() {
  const current = await store.getSettings();
  if (current.version === 2) {
    if (!droppedLegacySettingsFields) {
      await store.putSettings({});
      droppedLegacySettingsFields = true;
      return store.getSettings();
    }
    return current;
  }
  const grok = await currentGrok();
  const migrated = migrateLegacySettings(current, { grokSignedIn: Boolean(grok?.signedIn) });
  await store.putSettings(migrated);
  droppedLegacySettingsFields = true;
  const saved = await store.getSettings();
  return saved.version === 2 ? saved : migrated;
}

async function resolveChatKind() {
  if (envRequestsFaux()) return 'faux';
  if (String(process.env.WEFT_LLM || '').trim().toLowerCase() === 'openai') return 'openai';
  const [grok, settings] = await Promise.all([currentGrok(), ensureSettings()]);
  const available = hasAvailableSource(settings, { grokSignedIn: Boolean(grok?.signedIn) });
  return selectChatRuntime('', { hasApiKey: available });
}

async function settingsResponse(stored) {
  const grok = await currentGrok();
  const body = publicSettings(stored);
  body.vendors = VENDOR_PRESETS.map((item) => ({ ...item }));
  body.sources = (stored?.version === 2 ? (stored.sources || []) : []).map((source) => publicSource(source, grok));
  body.grok = grok;
  body.runtime = await resolveChatKind();
  return body;
}

function presentProbe(result) {
  if (result?.ok) return { ok: true, models: result.models || [] };
  return probeFailurePayload(result);
}

function lastTestFrom(result) {
  const lastTest = { ok: result?.ok === true, at: new Date().toISOString() };
  if (!lastTest.ok) {
    const failure = probeFailurePayload(result);
    lastTest.error = failure.error;
    if (failure.code) lastTest.code = failure.code;
    if (failure.status) lastTest.status = failure.status;
  }
  return lastTest;
}

function sendGrokError(res, err) {
  const code = err instanceof GrokAuthError ? err.code : 'login_failed';
  const status = code === 'no_login' ? 404 : 502;
  sendJson(res, status, { error: code });
}

function publicConversation(conv) {
  if (!conv) return conv;
  const out = { ...conv };
  delete out.harnessId;
  delete out.lastSubmissionId;
  delete out.autoContinues;
  delete out.retries;
  delete out.lastCheckpointAt;
  delete out.currentStep;
  delete out.pipelineId;
  delete out.pipelineStep;
  return out;
}

async function agentsFor(conv, messages) {
  return buildAgents({ conv, messages });
}

function serveStatic(req, res, url) {
  if (!existsSync(PUBLIC)) {
    res.writeHead(404, { ...SECURITY_HEADERS });
    res.end('Not found');
    return;
  }
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const fp = path.resolve(PUBLIC, `.${rel}`);
  if (!fp.startsWith(PUBLIC + path.sep) && fp !== PUBLIC) {
    res.writeHead(403, { ...SECURITY_HEADERS });
    res.end('Forbidden');
    return;
  }
  if (!existsSync(fp) || !statSync(fp).isFile()) {
    const fallback = path.join(PUBLIC, 'index.html');
    if (rel !== '/index.html' && existsSync(fallback)) {
      res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'text/html; charset=utf-8' });
      createReadStream(fallback).pipe(res);
      return;
    }
    res.writeHead(404, { ...SECURITY_HEADERS });
    res.end('Not found');
    return;
  }
  const type = MIME[path.extname(fp)] || 'application/octet-stream';
  res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': type });
  createReadStream(fp).pipe(res);
}

function isSsePath(p) {
  return /^\/api\/conversations\/[^/]+\/events$/.test(p);
}

const store = createSqliteStore(DATA_DIR);
let kernelApi = null;

async function reloadKernelPlugins() {
  if (typeof kernelApi?.reloadPlugins !== 'function') return;
  try {
    await kernelApi.reloadPlugins();
  } catch (err) {
    console.error(`WEFT_KERNEL_PLUGIN ${err instanceof Error ? err.message : err}`);
  }
}

function shutdown() {
  try { store.close(); } catch { /* ignore */ }
  try { dataLock?.release?.(); } catch { /* ignore */ }
  dataLock = null;
  if (!kernelApi) {
    process.exit(0);
    return;
  }
  kernelApi.close().finally(() => process.exit(0));
}
process.on('exit', () => { try { dataLock?.release?.(); } catch { /* ignore */ } });
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, shutdown);
}

const grokAuth = createGrokAuth();

await ensureSettings();
{
  const baseUrl = String(process.env.LLM_BASE_URL || '').trim();
  const apiKey = String(process.env.LLM_API_KEY || '').trim();
  const model = String(process.env.LLM_MODEL || '').trim();
  if (baseUrl || apiKey || model) {
    const cur = await ensureSettings();
    const hasApi = (cur.sources || []).some((source) => source.kind === 'api');
    if (!hasApi) {
      const seeded = sourceFromEnv({ baseUrl, apiKey, model });
      if (seeded?.source) {
        await store.putSettings({
          sources: [...(cur.sources || []), seeded.source],
          models: { ...(cur.models || {}), ...seeded.models },
        });
      }
    }
  }
}

const extensionHost = createExtensionHost({
  skillDirs: SKILL_DIRS,
  pluginDirs: PLUGIN_DIRS,
  getSettings: () => store.getSettings(),
});

try {
  kernelApi = await openConversationKernel({
    dataDir: DATA_DIR,
    store,
    demo: envRequestsFaux(),
    describeAgents: agentsFor,
    extensions: extensionHost,
    getSettings: () => ensureSettings(),
    grokAuth,
  });
} catch (err) {
  console.error(`WEFT_KERNEL_OPEN_FAILED ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}

const server = createServer(async (req, res) => {
  try {
    const port = boundPort();
    if (!hostAllowed(req.headers.host, port)) {
      sendJson(res, 400, { error: 'invalid host' });
      return;
    }

    const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);

    if (req.method === 'GET' && (url.pathname === '/login' || url.pathname === '/login/')) {
      if (!AUTH_ENABLED) {
        res.writeHead(302, {
          ...SECURITY_HEADERS,
          'cache-control': 'no-store',
          Location: '/',
        });
        res.end();
        return;
      }
      const given = url.searchParams.get('token') || '';
      if (!tokensMatch(given, AUTH_TOKEN)) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }
      res.writeHead(302, {
        ...SECURITY_HEADERS,
        'Set-Cookie': setCookieHeader(AUTH_TOKEN, { secure: isSecureRequest(req) }),
        Location: '/',
      });
      res.end();
      return;
    }

    if (isMutating(req.method)) {
      const origin = req.headers.origin;
      if (origin && !originAllowed(origin, port)) {
        sendJson(res, 403, { error: 'invalid origin' });
        return;
      }
      if (!isJsonContentType(req)) {
        sendJson(res, 415, { error: 'unsupported media type' });
        return;
      }
    }

    if (url.pathname.startsWith('/api/')) {
      const p = url.pathname.replace(/\/$/, '') || '/';
      if (AUTH_ENABLED && !requestAuthorized(req, AUTH_TOKEN)) {
        if (req.method === 'GET' && isSsePath(p) && consumeSseTicket(url.searchParams.get('ticket'))) {
          /* ticket consumed */
        } else {
          sendJson(res, 401, { error: 'unauthorized' });
          return;
        }
      }
      await routeApi(req, res, url);
      return;
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      serveStatic(req, res, url);
      return;
    }
    sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    const status = err.status || (err.code === 'E_SANDBOX' ? 403 : 500);
    if (!res.headersSent) {
      if (err.code === 'E_SANDBOX') sendJson(res, 403, { error: 'E_SANDBOX' });
      else sendJson(res, status, { error: err.message || 'server error' });
    } else {
      res.end();
    }
  }
});

function parseSourceId(raw) {
  let id = raw;
  try { id = decodeURIComponent(raw); } catch { return null; }
  if (id === GROK_SOURCE_ID) return id;
  if (!/^[a-f0-9]{8}$/.test(id) && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/.test(id)) return null;
  return id;
}

async function ensureGrokSource() {
  const settings = await ensureSettings();
  if ((settings.sources || []).some((source) => source.kind === 'grok' || source.id === GROK_SOURCE_ID)) return settings;
  await store.putSettings({ sources: [...(settings.sources || []), grokSourceTemplate()] });
  return ensureSettings();
}

async function handleSources(req, res, p, m) {
  if (p === '/api/sources' && m === 'POST') {
    const body = await readBody(req);
    const created = createApiSource(body || {});
    if (!created.source) {
      sendJson(res, 400, { error: created.error || 'invalid source' });
      return true;
    }
    const settings = await ensureSettings();
    if (settings.sources.some((source) => source.id === created.source.id)) {
      sendJson(res, 409, { error: 'exists' });
      return true;
    }
    await store.putSettings({ sources: [...settings.sources, created.source] });
    const grok = await currentGrok();
    sendJson(res, 201, publicSource(created.source, grok));
    return true;
  }

  if (p === '/api/sources/test' && m === 'POST') {
    const body = await readBody(req);
    const settings = await ensureSettings();
    const grok = await currentGrok();
    if (body?.sourceId != null && String(body.sourceId).trim()) {
      const id = parseSourceId(String(body.sourceId));
      const source = id && settings.sources.find((item) => item.id === id);
      if (!source) {
        sendJson(res, 404, { error: 'not found' });
        return true;
      }
      const override = {};
      for (const key of ['vendor', 'baseUrl', 'apiKey']) {
        if (body[key] != null) override[key] = body[key];
      }
      const hasOverride = Object.keys(override).length > 0;
      let probeSource = source;
      if (hasOverride) {
        const patched = applySourcePatch(source, override);
        if (!patched.source) {
          sendJson(res, 400, { error: patched.error || 'invalid source' });
          return true;
        }
        probeSource = patched.source;
      }
      const result = probeSource.kind === 'grok'
        ? { ok: Boolean(grok.signedIn), models: [GROK_SESSION_MODEL], error: grok.signedIn ? undefined : 'signed out' }
        : await probeModels({ baseUrl: effectiveBaseUrl(probeSource), apiKey: probeSource.apiKey });
      if (!hasOverride) {
        const sources = settings.sources.map((item) => {
          if (item.id !== source.id) return item;
          const next = { ...item, lastTest: lastTestFrom(result) };
          if (result?.ok) {
            const merged = modelsAfterProbe(item.models, result.models);
            next.models = merged.models;
            if (merged.catalog.length) next.catalog = merged.catalog;
            else delete next.catalog;
          }
          return next;
        });
        await store.putSettings({ sources });
      }
      sendJson(res, 200, probeSource.kind === 'grok' ? { ok: result.ok, models: result.models } : presentProbe(result));
      return true;
    }
    const preset = vendorPreset(body?.vendor);
    if (!preset) {
      sendJson(res, 400, { error: 'unknown vendor' });
      return true;
    }
    const baseUrl = body?.baseUrl != null && String(body.baseUrl).trim()
      ? normalizeHttpUrl(body.baseUrl)
      : (preset.id !== 'custom' ? preset.baseUrl : '');
    const apiKey = isMaskedOrEmptyApiKey(body?.apiKey) ? '' : String(body.apiKey);
    if (!baseUrl) {
      sendJson(res, 400, { error: 'base url required' });
      return true;
    }
    if (sourceNeedsKey({ kind: 'api', vendor: preset.id }) && !apiKey) {
      sendJson(res, 400, { error: 'api key required' });
      return true;
    }
    const result = await probeModels({ baseUrl, apiKey });
    sendJson(res, 200, presentProbe(result));
    return true;
  }

  const match = p.match(/^\/api\/sources\/([^/]+)$/);
  if (!match) return false;
  const id = parseSourceId(match[1]);
  const settings = await ensureSettings();
  const index = id ? settings.sources.findIndex((source) => source.id === id) : -1;
  if (index < 0) {
    sendJson(res, 404, { error: 'not found' });
    return true;
  }
  const current = settings.sources[index];
  if (m === 'DELETE') {
    if (current.kind === 'grok') {
      try { await grokAuth.logout(); } catch (err) {
        sendGrokError(res, err);
        return true;
      }
    }
    const sources = settings.sources.filter((source) => source.id !== current.id);
    const models = { ...(settings.models || {}) };
    if (models.default?.sourceId === current.id) models.default = null;
    await store.putSettings({ sources, models });
    sendJson(res, 200, { ok: true, id: current.id });
    return true;
  }
  if (m === 'PUT') {
    const body = await readBody(req);
    const patched = applySourcePatch(current, body || {});
    if (!patched.source) {
      sendJson(res, 400, { error: patched.error || 'invalid source' });
      return true;
    }
    const sources = settings.sources.slice();
    sources[index] = patched.source;
    await store.putSettings({ sources });
    sendJson(res, 200, publicSource(patched.source, await currentGrok()));
    return true;
  }
  return false;
}

async function loadGitConnections() {
  const settings = await store.getSettings();
  return Array.isArray(settings.gitConnections) ? settings.gitConnections : [];
}

async function saveGitConnections(list) {
  await store.putSettings({ gitConnections: list });
  return loadGitConnections();
}

function gitFailureBody(err) {
  const failure = { error: err?.message || 'git clone failed' };
  if (err?.gitCode) failure.code = err.gitCode;
  if (err?.gitCode === 'unknown' && err.detail) failure.detail = String(err.detail).slice(0, 800);
  if (err?.via) failure.via = err.via;
  return failure;
}

function connectionCloneError(code, via = 'connection') {
  const err = new Error(code === 'http_not_allowed' ? 'http not allowed' : 'git clone failed');
  err.status = 400;
  err.gitCode = code || 'unknown';
  err.via = via;
  return err;
}

function usesConnectionClone(connection, gitUrl) {
  if (!connection || !/^https?:\/\//i.test(gitUrl)) return false;
  if (connection.token) return true;
  if (connection.caFile) return true;
  return /^http:\/\//i.test(gitUrl);
}

async function planWorkspaceGit(body) {
  const connections = await loadGitConnections();
  let connection = null;
  if (body.connectionId) {
    connection = connections.find((item) => item.id === String(body.connectionId)) || null;
    if (!connection) {
      const err = new Error('not found');
      err.status = 404;
      throw err;
    }
  }
  let gitUrl = String(body.gitUrl || '').trim();
  let branch = body.branch || '';
  const projectId = body.projectId != null ? String(body.projectId).trim() : '';
  if (projectId) {
    if (!connection) {
      const err = new Error('connection required');
      err.status = 400;
      throw err;
    }
    const found = await getGitlabProject(connection, projectId);
    if (!found.ok) throw connectionCloneError(found.code || 'unknown');
    try {
      gitUrl = cloneUrlForProject(connection, found.project);
    } catch (err) {
      if (!err.via) err.via = 'connection';
      throw err;
    }
    if (!branch) branch = found.project.defaultBranch || '';
  } else if (!connection && gitUrl) {
    connection = matchConnectionByUrl(connections, gitUrl);
  }
  if (!gitUrl) {
    const err = new Error('invalid gitUrl');
    err.status = 400;
    throw err;
  }
  return { connection, gitUrl, branch };
}

async function testConnectionRecord(connection) {
  const result = await testGitlabConnection(connection);
  return { ok: result.ok === true, username: result.username || '', code: result.ok ? '' : (result.code || 'unknown') };
}

async function handleGitConnections(req, res, p, m) {
  if (!p.startsWith('/api/git/connections')) return false;

  if (p === '/api/git/connections' && m === 'GET') {
    sendJson(res, 200, (await loadGitConnections()).map(publicGitConnection));
    return true;
  }
  if (p === '/api/git/connections' && m === 'POST') {
    const body = await readBody(req);
    const list = await loadGitConnections();
    if (list.length >= 50) {
      sendJson(res, 400, { error: 'invalid connection', errors: ['too many connections'] });
      return true;
    }
    const built = createGitConnection(body || {});
    if (!built.ok) {
      sendJson(res, 400, { error: 'invalid connection', errors: built.errors });
      return true;
    }
    list.push(built.value);
    await saveGitConnections(list);
    sendJson(res, 201, publicGitConnection(built.value));
    return true;
  }
  if (p === '/api/git/connections/test' && m === 'POST') {
    const body = await readBody(req) || {};
    let connection;
    if (body.id) {
      const current = (await loadGitConnections()).find((item) => item.id === String(body.id));
      if (!current) {
        sendJson(res, 404, { error: 'not_found' });
        return true;
      }
      const updated = updateGitConnection(current, body);
      if (!updated.ok) {
        const code = updated.errors?.includes('token required') ? 'auth_failed' : 'unknown';
        sendJson(res, 200, { ok: false, code });
        return true;
      }
      connection = updated.value;
    } else {
      const built = createGitConnection(body);
      if (!built.ok) {
        const code = built.errors?.includes('token required') ? 'auth_failed' : 'unknown';
        sendJson(res, 200, { ok: false, code });
        return true;
      }
      connection = built.value;
    }
    const result = await testConnectionRecord(connection);
    sendJson(res, 200, result.ok ? { ok: true, username: result.username } : { ok: false, code: result.code });
    return true;
  }

  let match = p.match(/^\/api\/git\/connections\/([^/]+)\/projects\/([^/]+)\/branches$/);
  if (match && m === 'GET') {
    const connection = (await loadGitConnections()).find((item) => item.id === decodeURIComponent(match[1]));
    if (!connection) {
      sendJson(res, 404, { error: 'not_found' });
      return true;
    }
    const result = await listGitlabBranches(connection, decodeURIComponent(match[2]));
    if (!result.ok) {
      sendJson(res, 400, { error: 'git clone failed', code: result.code || 'unknown', via: 'connection' });
      return true;
    }
    sendJson(res, 200, { branches: result.branches, defaultBranch: result.defaultBranch || '' });
    return true;
  }
  match = p.match(/^\/api\/git\/connections\/([^/]+)\/projects$/);
  if (match && m === 'GET') {
    const connection = (await loadGitConnections()).find((item) => item.id === decodeURIComponent(match[1]));
    if (!connection) {
      sendJson(res, 404, { error: 'not_found' });
      return true;
    }
    const result = await listGitlabProjects(connection, urlSearch(req));
    if (!result.ok) {
      sendJson(res, 400, { error: 'git clone failed', code: result.code || 'unknown', via: 'connection' });
      return true;
    }
    sendJson(res, 200, { projects: result.projects });
    return true;
  }
  match = p.match(/^\/api\/git\/connections\/([^/]+)\/test$/);
  if (match && m === 'POST') {
    const id = decodeURIComponent(match[1]);
    const list = await loadGitConnections();
    const index = list.findIndex((item) => item.id === id);
    if (index < 0) {
      sendJson(res, 404, { error: 'not_found' });
      return true;
    }
    const result = await testConnectionRecord(list[index]);
    list[index] = recordGitTest(list[index], result);
    await saveGitConnections(list);
    sendJson(res, 200, result.ok
      ? { ok: true, username: result.username, connection: publicGitConnection(list[index]) }
      : { ok: false, code: result.code, connection: publicGitConnection(list[index]) });
    return true;
  }
  match = p.match(/^\/api\/git\/connections\/([^/]+)$/);
  if (match && m === 'PATCH') {
    const id = decodeURIComponent(match[1]);
    const list = await loadGitConnections();
    const index = list.findIndex((item) => item.id === id);
    if (index < 0) {
      sendJson(res, 404, { error: 'not_found' });
      return true;
    }
    const body = await readBody(req) || {};
    const updated = updateGitConnection(list[index], body);
    if (!updated.ok) {
      sendJson(res, 400, { error: 'invalid connection', errors: updated.errors });
      return true;
    }
    list[index] = updated.value;
    await saveGitConnections(list);
    sendJson(res, 200, publicGitConnection(updated.value));
    return true;
  }
  if (match && m === 'DELETE') {
    const id = decodeURIComponent(match[1]);
    const list = await loadGitConnections();
    if (!list.some((item) => item.id === id)) {
      sendJson(res, 404, { error: 'not_found' });
      return true;
    }
    await saveGitConnections(list.filter((item) => item.id !== id));
    sendJson(res, 200, { ok: true, id });
    return true;
  }
  return false;
}

function urlSearch(req) {
  try {
    return new URL(req.url, 'http://127.0.0.1').searchParams.get('search') || '';
  } catch {
    return '';
  }
}

async function routeApi(req, res, url) {
  const p = url.pathname.replace(/\/$/, '') || '/';
  const m = req.method;

  if (await handleGitConnections(req, res, p, m)) return;

  if (m === 'GET' && p === '/api/health') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (m === 'GET' && p === '/api/workspace-root') {
    sendJson(res, 200, { root: defaultWorkspaceRoot() });
    return;
  }

  if (m === 'GET' && p === '/api/workspace-root/dirs') {
    try {
      sendJson(res, 200, await listBrowsableDirs(url.searchParams.get('path')));
    } catch (err) {
      sendJson(res, err.status || 400, { error: err.message || 'path is not allowed', code: err.code || 'E_PATH' });
    }
    return;
  }

  if (m === 'POST' && p === '/api/sse-ticket') {
    sendJson(res, 200, issueSseTicket(60_000));
    return;
  }

  if (m === 'POST' && p === '/api/workspaces') {
    const body = await readBody(req);
    if (!body?.name) {
      sendJson(res, 400, { error: 'name required' });
      return;
    }
    const wantsGit = Boolean(body.gitUrl) || Boolean(body.connectionId) || (body.projectId != null && String(body.projectId).trim() !== '');
    if (wantsGit) {
      const id = randomUUID();
      const dest = path.join(DATA_DIR, 'workspaces', id, 'repo');
      try {
        const planned = await planWorkspaceGit(body);
        let gitUrl = planned.gitUrl;
        let branch = planned.branch || '';
        const connection = usesConnectionClone(planned.connection, gitUrl) ? planned.connection : null;
        try {
          await cloneGitRepo({ url: gitUrl, branch, dest, connection });
        } catch (err) {
          if (connection && !err.via) err.via = 'connection';
          throw err;
        }
        gitUrl = stripGitUrlCredentials(gitUrl);
        const ws = await store.createWorkspace({
          id,
          name: body.name,
          path: dest,
          source: 'git',
          gitUrl,
          branch: branch || null,
          rootPath: dest,
          worktrees: [],
        });
        sendJson(res, 201, { id: ws.id, name: ws.name, path: ws.path, source: ws.source, gitUrl: ws.gitUrl, branch: ws.branch, rootPath: ws.rootPath, worktrees: ws.worktrees });
      } catch (err) {
        sendJson(res, err.status || 400, gitFailureBody(err));
      }
      return;
    }
    if (!body.path) {
      const id = randomUUID();
      const dest = path.join(DATA_DIR, 'workspaces', id, 'repo');
      await fs.mkdir(dest, { recursive: true });
      const ws = await store.createWorkspace({
        id,
        name: body.name,
        path: dest,
        source: 'local',
        rootPath: dest,
        worktrees: [],
      });
      sendJson(res, 201, { id: ws.id, name: ws.name, path: ws.path, source: ws.source, gitUrl: ws.gitUrl, branch: ws.branch, rootPath: ws.rootPath, worktrees: ws.worktrees });
      return;
    }
    let resolved;
    try {
      resolved = await resolveAllowedWorkspacePath(body.path, { dataDir: DATA_DIR });
    } catch (err) {
      sendJson(res, err.status || 400, {
        error: err.message || 'path is not allowed',
        allowedRoot: defaultWorkspaceRoot(),
      });
      return;
    }
    const ws = (await store.restoreWorkspaceByPath(resolved, body.name))
      || await store.createWorkspace({ name: body.name, path: resolved, source: 'local', rootPath: resolved, worktrees: [] });
    sendJson(res, 201, { id: ws.id, name: ws.name, path: ws.path, source: ws.source, gitUrl: ws.gitUrl, branch: ws.branch, rootPath: ws.rootPath, worktrees: ws.worktrees });
    return;
  }

  if (m === 'GET' && p === '/api/workspaces') {
    sendJson(res, 200, await store.listWorkspaces());
    return;
  }

  {
    const removeMatch = m === 'DELETE' && p.match(/^\/api\/workspaces\/([^/]+)$/);
    if (removeMatch) {
      const wid = decodeURIComponent(removeMatch[1]);
      const ws = await store.getWorkspace(wid);
      if (!ws || ws.removedAt) { sendJson(res, 404, { error: 'workspace not found' }); return; }
      const busy = [];
      for (const item of await store.listConversations(wid)) {
        const live = await kernelApi.present(item);
        if (live.status === 'running') busy.push(live.id);
      }
      if (busy.length) {
        sendJson(res, 409, { error: 'workspace has active conversations', code: 'E_WS_BUSY', conversations: busy });
        return;
      }
      // Only hides the workspace. Files on disk and conversation records are kept.
      await store.removeWorkspace(wid);
      sendJson(res, 200, { id: wid, removed: true });
      return;
    }
  }

  let match;
  match = p.match(/^\/api\/workspaces\/([^/]+)\/conversations$/);
  if (match && m === 'POST') {
    const wid = decodeURIComponent(match[1]);
    const ws = await store.getWorkspace(wid);
    if (!ws) { sendJson(res, 404, { error: 'workspace not found' }); return; }
    const body = await readBody(req);
    const modelChoice = resolveConversationModelPatch(await store.getSettings(), body);
    if (modelChoice.present && !modelChoice.ok) {
      sendJson(res, 400, { errors: modelChoice.errors });
      return;
    }
    const conv = await kernelApi.createConversation({
      workspaceId: wid,
      workspacePath: ws.path,
      title: body.title || 'New conversation',
      status: 'idle',
      ...(modelChoice.present ? modelChoice.value : {}),
    });
    sendJson(res, 201, {
      id: conv.id,
      workspaceId: conv.workspaceId,
      title: conv.title,
      status: 'idle',
      modelSourceId: conv.modelSourceId || null,
      modelId: conv.modelId || null,
    });
    return;
  }
  if (match && m === 'GET') {
    const wid = decodeURIComponent(match[1]);
    const q = url.searchParams.get('q') || undefined;
    const list = await store.listConversations(wid, { q });
    const presented = [];
    for (const item of list) presented.push(publicConversation(await kernelApi.present(item)));
    sendJson(res, 200, presented);
    return;
  }

  match = p.match(/^\/api\/workspaces\/([^/]+)\/tree$/);
  if (match && m === 'GET') {
    const wid = decodeURIComponent(match[1]);
    const ws = await store.getWorkspace(wid);
    if (!ws) { sendJson(res, 404, { error: 'workspace not found' }); return; }
    try {
      const abs = await resolveInWorkspace(ws.path, '.');
      const entries = await listWorkspaceTree(abs);
      sendJson(res, 200, { entries });
    } catch (err) {
      if (err.code === 'E_SANDBOX') { sendJson(res, 403, { error: 'E_SANDBOX' }); return; }
      throw err;
    }
    return;
  }

  match = p.match(/^\/api\/workspaces\/([^/]+)\/files$/);
  if (match && m === 'GET') {
    const wid = decodeURIComponent(match[1]);
    const ws = await store.getWorkspace(wid);
    if (!ws) { sendJson(res, 404, { error: 'workspace not found' }); return; }
    const rel = url.searchParams.get('path') || '';
    try {
      const abs = await resolveInWorkspace(ws.path, rel);
      const content = await fs.readFile(abs, 'utf8');
      sendJson(res, 200, { path: rel, content });
    } catch (err) {
      if (err.code === 'E_SANDBOX') { sendJson(res, 403, { error: 'E_SANDBOX' }); return; }
      if (err.code === 'ENOENT') { sendJson(res, 404, { error: 'not found' }); return; }
      throw err;
    }
    return;
  }
  if (match && m === 'PUT') {
    const wid = decodeURIComponent(match[1]);
    const ws = await store.getWorkspace(wid);
    if (!ws) { sendJson(res, 404, { error: 'workspace not found' }); return; }
    const body = await readBody(req);
    try {
      const abs = await resolveInWorkspace(ws.path, body.path);
      let before = '';
      try { before = await fs.readFile(abs, 'utf8'); } catch { before = ''; }
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, body.content ?? '', 'utf8');
      const { added, removed } = diffStats(before, body.content ?? '');
      sendJson(res, 200, { path: body.path, added, removed });
    } catch (err) {
      if (err.code === 'E_SANDBOX') { sendJson(res, 403, { error: 'E_SANDBOX' }); return; }
      throw err;
    }
    return;
  }

  match = p.match(/^\/api\/conversations\/([^/]+)\/agents\/([^/]+)\/messages$/);
  if (match && m === 'GET') {
    const cid = decodeURIComponent(match[1]);
    const aid = decodeURIComponent(match[2]);
    const result = await kernelApi.childMessages(cid, aid);
    sendJson(res, result.status, result.body);
    return;
  }
  if (match && m === 'POST') {
    const cid = decodeURIComponent(match[1]);
    const aid = decodeURIComponent(match[2]);
    const body = await readBody(req);
    const result = await kernelApi.sendToAgent(cid, aid, body.text);
    sendJson(res, result.status, result.body);
    return;
  }

  match = p.match(/^\/api\/conversations\/([^/]+)\/agents\/([^/]+)\/stop$/);
  if (match && m === 'POST') {
    const cid = decodeURIComponent(match[1]);
    const aid = decodeURIComponent(match[2]);
    const result = await kernelApi.stopAgent(cid, aid);
    sendJson(res, result.status, result.body);
    return;
  }

  match = p.match(/^\/api\/conversations\/([^/]+)$/);
  if (match && m === 'GET') {
    const cid = decodeURIComponent(match[1]);
    const conv = await store.getConversation(cid);
    if (!conv) { sendJson(res, 404, { error: 'conversation not found' }); return; }
    const live = await kernelApi.present(conv, { includeMessages: true });
    const messages = live.messages;
    const agents = [
      ...(await agentsFor(live, messages)),
      ...(await kernelApi.listSubagents(live)),
    ];
    const settings = await ensureSettings();
    const grok = await currentGrok();
    const context = presentConversationContext(
      live.usage,
      contextWindowForConversation(settings, live, { grokSignedIn: Boolean(grok?.signedIn) }),
    );
    sendJson(res, 200, {
      id: live.id,
      title: live.title,
      status: live.status,
      modelSourceId: live.modelSourceId || null,
      modelId: live.modelId || null,
      messages,
      agents,
      usage: context.usage,
      contextWindow: context.contextWindow,
      contextLabel: context.contextLabel,
      ...(live.llmError ? { llmError: live.llmError } : {}),
    });
    return;
  }
  if (match && m === 'PATCH') {
    const cid = decodeURIComponent(match[1]);
    const conv = await store.getConversation(cid);
    if (!conv) { sendJson(res, 404, { error: 'conversation not found' }); return; }
    const body = await readBody(req);
    const patched = await kernelApi.patchConversation(cid, body);
    sendJson(res, patched.status, patched.body);
    return;
  }

  match = p.match(/^\/api\/conversations\/([^/]+)\/messages$/);
  if (match && m === 'POST') {
    const cid = decodeURIComponent(match[1]);
    const conv = await store.getConversation(cid);
    if (!conv) { sendJson(res, 404, { error: 'conversation not found' }); return; }
    const body = await readBody(req);
    const posted = await kernelApi.postMessage(conv, body.text || '');
    sendJson(res, posted.status, posted.body);
    return;
  }

  match = p.match(/^\/api\/conversations\/([^/]+)\/stop$/);
  if (match && m === 'POST') {
    const cid = decodeURIComponent(match[1]);
    const conv = await store.getConversation(cid);
    if (!conv) { sendJson(res, 404, { error: 'conversation not found' }); return; }
    const stopped = await kernelApi.stopConversation(cid);
    sendJson(res, stopped.status, stopped.body);
    return;
  }

  match = p.match(/^\/api\/conversations\/([^/]+)\/changes$/);
  if (match && m === 'GET') {
    const cid = decodeURIComponent(match[1]);
    try {
      sendJson(res, 200, await kernelApi.changes(cid));
    } catch (err) {
      if (err.code === 'E_SANDBOX') { sendJson(res, 403, { error: 'E_SANDBOX' }); return; }
      throw err;
    }
    return;
  }

  match = p.match(/^\/api\/conversations\/([^/]+)\/diff$/);
  if (match && m === 'GET') {
    const cid = decodeURIComponent(match[1]);
    const filePath = url.searchParams.get('path') || '';
    try {
      const result = await kernelApi.diff(cid, filePath);
      sendJson(res, result.status, result.body);
    } catch (err) {
      if (err.code === 'E_SANDBOX') { sendJson(res, 403, { error: 'E_SANDBOX' }); return; }
      throw err;
    }
    return;
  }

  match = p.match(/^\/api\/conversations\/([^/]+)\/events$/);
  if (match && m === 'GET') {
    const cid = decodeURIComponent(match[1]);
    const conv = await store.getConversation(cid);
    if (!conv) { sendJson(res, 404, { error: 'conversation not found' }); return; }
    await kernelApi.streamEvents(req, res, cid, { headers: SECURITY_HEADERS });
    return;
  }

  if (p === '/api/sources' || p === '/api/sources/test' || /^\/api\/sources\/[^/]+$/.test(p)) {
    if (await handleSources(req, res, p, m)) return;
  }

  if (p === '/api/settings' && m === 'GET') {
    sendJson(res, 200, await settingsResponse(await ensureSettings()));
    return;
  }
  if (p === '/api/settings' && m === 'PUT') {
    const body = await readBody(req) || {};
    const current = await ensureSettings();
    if (body.models && typeof body.models === 'object' && !Array.isArray(body.models)) {
      const invalid = validateRoleModels(current, body.models);
      if (invalid) { sendJson(res, 400, { error: invalid }); return; }
    } else if (body.models != null) {
      sendJson(res, 400, { error: 'invalid model binding' });
      return;
    }
    const patch = { ...body };
    delete patch.sources;
    delete patch.version;
    delete patch.grok;
    delete patch.provider;
    delete patch.baseUrl;
    delete patch.apiKey;
    delete patch.hasApiKey;
    delete patch.gitConnections;
    const saved = await store.putSettings(patch);
    sendJson(res, 200, await settingsResponse(saved));
    return;
  }

  if (p === '/api/grok/session' && m === 'GET') {
    sendJson(res, 200, await grokAuth.status());
    return;
  }
  if (p === '/api/grok/login' && m === 'POST') {
    try {
      sendJson(res, 200, await grokAuth.startLogin());
    } catch (err) {
      sendGrokError(res, err);
    }
    return;
  }
  if (p === '/api/grok/login/poll' && m === 'POST') {
    const body = await readBody(req);
    try {
      const result = await grokAuth.pollLogin(body?.loginId);
      if (result?.status === 'done') await ensureGrokSource();
      sendJson(res, 200, result);
    } catch (err) {
      sendGrokError(res, err);
    }
    return;
  }
  if (p === '/api/grok/login/cancel' && m === 'POST') {
    const body = await readBody(req);
    sendJson(res, 200, await grokAuth.cancelLogin(body?.loginId));
    return;
  }
  if (p === '/api/grok/logout' && m === 'POST') {
    try {
      sendJson(res, 200, await grokAuth.logout());
    } catch (err) {
      sendGrokError(res, err);
    }
    return;
  }

  if (p === '/api/about' && m === 'GET') {
    let pkg = { name: 'weft', version: '0.0.0', description: '' };
    try {
      pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    } catch { /* ignore */ }
    sendJson(res, 200, { name: pkg.name, version: pkg.version, description: pkg.description || '' });
    return;
  }

  if (p === '/api/plugins' && m === 'GET') {
    const s = await store.getSettings();
    sendJson(res, 200, await describePlugins(PLUGIN_DIRS, s.plugins || {}));
    return;
  }
  if (p === '/api/plugins' && m === 'POST') {
    const body = await readBody(req);
    try {
      const s = await store.getSettings();
      const current = await describePlugins(PLUGIN_DIRS, s.plugins || {});
      const existingToolNames = new Set(BUILTIN_TOOLS);
      for (const plugin of current) {
        if (plugin.enabled && plugin.loaded) {
          for (const tool of plugin.tools || []) existingToolNames.add(tool.name);
        }
      }
      const installed = await installPlugin(body?.path, USER_PLUGINS, {
        existingIds: new Set(current.map((plugin) => plugin.id)),
        existingToolNames,
        baseDir: ROOT,
      });
      await store.putSettings({ plugins: { [installed.id]: true } });
      await reloadKernelPlugins();
      sendJson(res, 201, installed);
    } catch (err) {
      sendCatalogError(res, err);
    }
    return;
  }
  match = p.match(/^\/api\/plugins\/([^/]+)$/);
  if (match && m === 'PUT') {
    const id = decodeURIComponent(match[1]);
    if (!PLUGIN_ID.test(id)) {
      sendJson(res, 400, { error: 'invalid plugin id', code: 'err_plugin_invalid' });
      return;
    }
    const body = await readBody(req);
    const s = await store.getSettings();
    const current = await describePlugins(PLUGIN_DIRS, s.plugins || {});
    if (!current.some((plugin) => plugin.id === id)) {
      sendJson(res, 404, { error: 'plugin not found', code: 'err_plugin_not_found' });
      return;
    }
    const enabled = body?.enabled !== false;
    await store.putSettings({ plugins: { [id]: enabled } });
    await reloadKernelPlugins();
    const next = await describePlugins(PLUGIN_DIRS, (await store.getSettings()).plugins || {});
    sendJson(res, 200, next.find((plugin) => plugin.id === id) || { id, enabled });
    return;
  }

  if (p === '/api/skills' && m === 'GET') {
    const s = await store.getSettings();
    sendJson(res, 200, await listSkills(SKILL_DIRS, s.skills || {}, USER_SKILLS));
    return;
  }
  if (p === '/api/skills' && m === 'POST') {
    const body = await readBody(req);
    try {
      const existing = await listSkillRecords(SKILL_DIRS);
      const created = await createSkill(USER_SKILLS, body || {}, new Set(existing.map((skill) => skill.id)));
      await store.putSettings({ skills: { [created.id]: true } });
      const list = await listSkills(SKILL_DIRS, (await store.getSettings()).skills || {}, USER_SKILLS);
      sendJson(res, 201, list.find((skill) => skill.id === created.id));
    } catch (err) {
      sendCatalogError(res, err);
    }
    return;
  }
  match = p.match(/^\/api\/skills\/([^/]+)$/);
  if (match && m === 'DELETE') {
    const id = decodeURIComponent(match[1]);
    try {
      await deleteSkill(SKILL_DIRS, USER_SKILLS, id);
      sendJson(res, 200, { ok: true, id });
    } catch (err) {
      sendCatalogError(res, err);
    }
    return;
  }
  if (match && (m === 'PUT' || m === 'PATCH')) {
    const id = decodeURIComponent(match[1]);
    if (!SKILL_ID.test(id)) {
      sendJson(res, 400, { error: 'invalid skill id', code: 'err_skill_invalid' });
      return;
    }
    const body = await readBody(req);
    try {
      const hasContent = body?.name != null || body?.description != null || body?.body != null;
      if (hasContent) await updateSkill(SKILL_DIRS, USER_SKILLS, id, body || {});
      if (body?.enabled != null || !hasContent) {
        const records = await listSkillRecords(SKILL_DIRS);
        if (!records.some((skill) => skill.id === id)) {
          sendJson(res, 404, { error: 'skill not found', code: 'err_skill_not_found' });
          return;
        }
        if (body?.enabled != null) {
          await store.putSettings({ skills: { [id]: body.enabled !== false } });
        }
      }
      const list = await listSkills(SKILL_DIRS, (await store.getSettings()).skills || {}, USER_SKILLS);
      const skill = list.find((item) => item.id === id);
      if (!skill) {
        sendJson(res, 404, { error: 'skill not found', code: 'err_skill_not_found' });
        return;
      }
      sendJson(res, 200, skill);
    } catch (err) {
      sendCatalogError(res, err);
    }
    return;
  }

  sendJson(res, 404, { error: 'not found' });
}

server.listen(PORT, '127.0.0.1', () => {
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : PORT;
  const hostWarning = unauthenticatedHostsWarning();
  if (hostWarning) console.warn(hostWarning);
  console.log(`WEFT_READY http://127.0.0.1:${port}`);
});
