import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOrchestrator } from './src/core/orchestrator.mjs';
import { createRetryPolicy } from './src/core/retry.mjs';
import { formatSSE } from './src/core/sse.mjs';
import { validateRole, validatePipeline } from './src/core/config.mjs';
import { resolveInWorkspace } from './src/core/paths.mjs';
import { listWorkspaceTree } from './src/core/workspace-tree.mjs';
import { diffStats, unifiedDiff } from './src/core/diff.mjs';
import { publicSettings } from './src/core/settings.mjs';
import { cloneGitRepo, stripGitUrlCredentials } from './src/core/git-import.mjs';
import { scanPlugins, scanSkills } from './src/core/catalog.mjs';
import { loadRoleTemplates, loadPipelineTemplates } from './src/core/roles-load.mjs';
import { buildAgents } from './src/core/agents.mjs';
import { createSqliteStore } from './src/store/sqlite.mjs';
import { loadFauxLLM, createFauxLLM } from './src/llm/faux.mjs';
import { createOpenAILLM } from './src/llm/openai.mjs';
import {
  loadOrCreateToken,
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
import { resolveAllowedWorkspacePath, defaultWorkspaceRoot } from './src/core/workspace-guard.mjs';
import { acquireDataDirLock } from './src/core/lock.mjs';
import fs from 'node:fs/promises';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const PORT = process.env.PORT !== undefined && process.env.PORT !== '' ? Number(process.env.PORT) : 3000;
const DATA_DIR = process.env.PI_WORK_DATA_DIR || path.join(ROOT, 'data');
const LLM_KIND = process.env.PI_WORK_LLM || 'faux';

await fs.mkdir(DATA_DIR, { recursive: true });

let dataLock;
try {
  dataLock = await acquireDataDirLock(DATA_DIR);
} catch (err) {
  console.error(`PI_WORK_ERROR ${err.message || err}`);
  process.exit(1);
}

const { token: AUTH_TOKEN, generated: TOKEN_GENERATED } = await loadOrCreateToken(DATA_DIR);

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

function liveStatus(orch, conv) {
  const s = orch.status(conv.id);
  if (s && s.status && s.status !== 'idle') {
    return {
      ...conv,
      status: s.status,
      autoContinues: s.autoContinues,
      retries: s.retries,
      currentStep: s.currentStep,
      lastCheckpointAt: s.lastCheckpointAt,
      pipelineStep: s.pipelineStep ?? conv.pipelineStep,
    };
  }
  return conv;
}

async function agentsFor(conv, messages) {
  const pipeline = conv.pipelineId ? await store.getPipeline(conv.pipelineId) : undefined;
  const roles = await store.listRoles();
  const role = (conv.roleId && await store.getRole(conv.roleId)) || await store.getRole('default');
  return buildAgents({ conv, pipeline, role, roles, messages });
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

function shutdown() {
  try { store.close(); } catch { /* ignore */ }
  try { dataLock?.release?.(); } catch { /* ignore */ }
  dataLock = null;
  process.exit(0);
}
process.on('exit', () => { try { dataLock?.release?.(); } catch { /* ignore */ } });
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, shutdown);
}

await loadRoleTemplates(store, path.join(ROOT, 'roles'));
await loadPipelineTemplates(store, path.join(ROOT, 'examples', 'pipelines'));

{
  const cur = await store.getSettings();
  const seed = {};
  if (!cur.baseUrl && process.env.LLM_BASE_URL) seed.baseUrl = process.env.LLM_BASE_URL;
  if (!cur.apiKey && process.env.LLM_API_KEY) seed.apiKey = process.env.LLM_API_KEY;
  if (!cur.models?.default && process.env.LLM_MODEL) seed.models = { default: process.env.LLM_MODEL };
  if (Object.keys(seed).length) await store.putSettings(seed);
}

const llm = LLM_KIND === 'openai'
  ? createOpenAILLM({
      getConfig: async ({ roleId, model: modelOverride } = {}) => {
        const s = await store.getSettings();
        const models = s.models || {};
        return {
          baseUrl: s.baseUrl || process.env.LLM_BASE_URL,
          apiKey: s.apiKey || process.env.LLM_API_KEY,
          model: modelOverride || (roleId && models[roleId]) || models.default || process.env.LLM_MODEL,
        };
      },
    })
  : (process.env.PI_WORK_FAUX_SCRIPT ? loadFauxLLM(process.env.PI_WORK_FAUX_SCRIPT) : createFauxLLM({ turns: [] }));

const orch = createOrchestrator({
  llm,
  store,
  retry: createRetryPolicy({
    maxAttempts: Number(process.env.PI_WORK_RETRY_MAX) || 5,
    baseMs: Number(process.env.PI_WORK_RETRY_BASE_MS) || 200,
    maxMs: 30_000,
  }),
  stallMs: Number(process.env.PI_WORK_STALL_MS) || 120_000,
});

await orch.recover();

const server = createServer(async (req, res) => {
  try {
    const port = boundPort();
    if (!hostAllowed(req.headers.host, port)) {
      sendJson(res, 400, { error: 'invalid host' });
      return;
    }

    const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);

    if (req.method === 'GET' && (url.pathname === '/login' || url.pathname === '/login/')) {
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
      const authed = requestAuthorized(req, AUTH_TOKEN);
      if (!authed) {
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

async function routeApi(req, res, url) {
  const p = url.pathname.replace(/\/$/, '') || '/';
  const m = req.method;

  if (m === 'GET' && p === '/api/health') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (m === 'GET' && p === '/api/workspace-root') {
    sendJson(res, 200, { root: defaultWorkspaceRoot() });
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
    if (body.gitUrl) {
      const id = randomUUID();
      const dest = path.join(DATA_DIR, 'workspaces', id, 'repo');
      try {
        await cloneGitRepo({ url: body.gitUrl, branch: body.branch, dest });
      } catch (err) {
        sendJson(res, err.status || 400, { error: err.message || 'git clone failed' });
        return;
      }
      const gitUrl = stripGitUrlCredentials(body.gitUrl);
      const ws = await store.createWorkspace({
        id,
        name: body.name,
        path: dest,
        source: 'git',
        gitUrl,
        branch: body.branch || null,
        rootPath: dest,
        worktrees: [],
      });
      sendJson(res, 201, { id: ws.id, name: ws.name, path: ws.path, source: ws.source, gitUrl: ws.gitUrl, branch: ws.branch, rootPath: ws.rootPath, worktrees: ws.worktrees });
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
    const ws = await store.createWorkspace({ name: body.name, path: resolved, source: 'local', rootPath: resolved, worktrees: [] });
    sendJson(res, 201, { id: ws.id, name: ws.name, path: ws.path, source: ws.source, gitUrl: ws.gitUrl, branch: ws.branch, rootPath: ws.rootPath, worktrees: ws.worktrees });
    return;
  }

  if (m === 'GET' && p === '/api/workspaces') {
    sendJson(res, 200, await store.listWorkspaces());
    return;
  }

  let match;
  match = p.match(/^\/api\/workspaces\/([^/]+)\/conversations$/);
  if (match && m === 'POST') {
    const wid = decodeURIComponent(match[1]);
    const ws = await store.getWorkspace(wid);
    if (!ws) { sendJson(res, 404, { error: 'workspace not found' }); return; }
    const body = await readBody(req);
    if (body.roleId) {
      const role = await store.getRole(body.roleId);
      if (!role) { sendJson(res, 400, { errors: ['unknown role'] }); return; }
    }
    if (body.pipelineId) {
      const pipe = await store.getPipeline(body.pipelineId);
      if (!pipe) { sendJson(res, 400, { errors: ['unknown pipeline'] }); return; }
    }
    const conv = await store.createConversation({
      workspaceId: wid,
      workspacePath: ws.path,
      title: body.title || 'New conversation',
      roleId: body.roleId,
      pipelineId: body.pipelineId,
      status: 'idle',
    });
    sendJson(res, 201, { id: conv.id, workspaceId: conv.workspaceId, title: conv.title, status: 'idle' });
    return;
  }
  if (match && m === 'GET') {
    const wid = decodeURIComponent(match[1]);
    const q = url.searchParams.get('q') || undefined;
    const list = await store.listConversations(wid, { q });
    sendJson(res, 200, list.map((c) => liveStatus(orch, c)));
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

  match = p.match(/^\/api\/conversations\/([^/]+)$/);
  if (match && m === 'GET') {
    const cid = decodeURIComponent(match[1]);
    const conv = await store.getConversation(cid);
    if (!conv) { sendJson(res, 404, { error: 'conversation not found' }); return; }
    const live = liveStatus(orch, conv);
    const messages = await store.getMessages(cid);
    const agents = await agentsFor(live, messages);
    sendJson(res, 200, {
      id: live.id,
      title: live.title,
      status: live.status,
      autoContinues: live.autoContinues,
      retries: live.retries,
      lastCheckpointAt: live.lastCheckpointAt,
      currentStep: live.currentStep,
      messages,
      agents,
    });
    return;
  }

  match = p.match(/^\/api\/conversations\/([^/]+)\/messages$/);
  if (match && m === 'POST') {
    const cid = decodeURIComponent(match[1]);
    const conv = await store.getConversation(cid);
    if (!conv) { sendJson(res, 404, { error: 'conversation not found' }); return; }
    const body = await readBody(req);
    const runId = randomUUID();
    const ws = conv.workspaceId ? await store.getWorkspace(conv.workspaceId) : null;
    await orch.start(cid, {
      workspacePath: conv.workspacePath || ws?.path,
      text: body.text || '',
      roleId: conv.roleId,
      pipelineId: conv.pipelineId,
      runId,
    });
    sendJson(res, 202, { runId });
    return;
  }

  match = p.match(/^\/api\/conversations\/([^/]+)\/(pause|resume|stop)$/);
  if (match && m === 'POST') {
    const cid = decodeURIComponent(match[1]);
    const action = match[2];
    const conv = await store.getConversation(cid);
    if (!conv) { sendJson(res, 404, { error: 'conversation not found' }); return; }
    const result = await orch[action](cid);
    sendJson(res, 200, { status: result.status });
    return;
  }

  match = p.match(/^\/api\/conversations\/([^/]+)\/changes$/);
  if (match && m === 'GET') {
    const cid = decodeURIComponent(match[1]);
    sendJson(res, 200, await store.getChanges(cid));
    return;
  }

  match = p.match(/^\/api\/conversations\/([^/]+)\/diff$/);
  if (match && m === 'GET') {
    const cid = decodeURIComponent(match[1]);
    const filePath = url.searchParams.get('path') || '';
    const ch = await store.getChangeForPath(cid, filePath);
    if (!ch) { sendJson(res, 404, { error: 'no diff' }); return; }
    const { added, removed } = diffStats(ch.before, ch.after);
    sendJson(res, 200, {
      path: filePath,
      before: ch.before,
      after: ch.after,
      unified: unifiedDiff(filePath, ch.before, ch.after),
      added,
      removed,
    });
    return;
  }

  match = p.match(/^\/api\/conversations\/([^/]+)\/events$/);
  if (match && m === 'GET') {
    const cid = decodeURIComponent(match[1]);
    const conv = await store.getConversation(cid);
    if (!conv) { sendJson(res, 404, { error: 'conversation not found' }); return; }
    const last = req.headers['last-event-id'];
    const afterId = last != null && last !== '' ? Number(last) : 0;
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(':\n\n');
    const pending = [];
    let replaying = true;
    const unsub = orch.subscribe(cid, (ev) => {
      if (replaying) pending.push(ev);
      else {
        res.write(formatSSE({ id: ev.id, event: ev.event, data: ev.data }));
      }
    });
    const past = await store.getEvents(cid, { afterId: Number.isFinite(afterId) ? afterId : 0 });
    const seen = new Set();
    for (const ev of past) {
      seen.add(ev.id);
      res.write(formatSSE({ id: ev.id, event: ev.event, data: ev.data }));
    }
    replaying = false;
    for (const ev of pending) {
      if (seen.has(ev.id)) continue;
      seen.add(ev.id);
      res.write(formatSSE({ id: ev.id, event: ev.event, data: ev.data }));
    }
    const ping = setInterval(() => {
      try { res.write(':\n\n'); } catch { /* ignore */ }
    }, 15000);
    ping.unref?.();
    req.on('close', () => {
      clearInterval(ping);
      unsub();
    });
    return;
  }

  if (p === '/api/roles' && m === 'GET') {
    sendJson(res, 200, await store.listRoles());
    return;
  }
  if (p === '/api/roles' && m === 'POST') {
    const body = await readBody(req);
    const v = validateRole(body);
    if (!v.ok) { sendJson(res, 400, { errors: v.errors }); return; }
    const role = await store.createRole(v.value);
    sendJson(res, 201, role);
    return;
  }

  if (p === '/api/pipelines' && m === 'GET') {
    sendJson(res, 200, await store.listPipelines());
    return;
  }
  if (p === '/api/pipelines' && m === 'POST') {
    const body = await readBody(req);
    const roles = await store.listRoles();
    const v = validatePipeline(body, roles);
    if (!v.ok) { sendJson(res, 400, { errors: v.errors }); return; }
    const pipe = await store.createPipeline(v.value);
    sendJson(res, 201, pipe);
    return;
  }

  if (p === '/api/settings' && m === 'GET') {
    sendJson(res, 200, publicSettings(await store.getSettings()));
    return;
  }
  if (p === '/api/settings' && m === 'PUT') {
    const body = await readBody(req);
    const saved = await store.putSettings(body || {});
    sendJson(res, 200, publicSettings(saved));
    return;
  }

  if (p === '/api/about' && m === 'GET') {
    let pkg = { name: 'pi-work', version: '0.0.0', description: '' };
    try {
      pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    } catch { /* ignore */ }
    sendJson(res, 200, { name: pkg.name, version: pkg.version, description: pkg.description || '' });
    return;
  }

  if (p === '/api/plugins' && m === 'GET') {
    const list = await scanPlugins(path.join(ROOT, 'plugins'));
    const s = await store.getSettings();
    const enabledMap = s.plugins || {};
    sendJson(res, 200, list.map((pl) => ({
      ...pl,
      enabled: enabledMap[pl.id] !== false,
    })));
    return;
  }
  if (p === '/api/plugins' && m === 'POST') {
    const body = await readBody(req);
    const id = String(body?.id || body?.name || '').trim();
    if (!id || !/^[a-zA-Z0-9._-]{1,64}$/.test(id)) {
      sendJson(res, 400, { error: 'invalid plugin id' });
      return;
    }
    const dir = path.join(ROOT, 'plugins', id);
    await fs.mkdir(dir, { recursive: true });
    const manifest = {
      id,
      name: body.name || id,
      description: body.description || '',
      version: body.version || '0.0.0',
      source: body.source || 'imported',
    };
    await fs.writeFile(path.join(dir, 'plugin.json'), JSON.stringify(manifest, null, 2));
    sendJson(res, 201, { ...manifest, enabled: true });
    return;
  }
  match = p.match(/^\/api\/plugins\/([^/]+)$/);
  if (match && m === 'PUT') {
    const id = decodeURIComponent(match[1]);
    const body = await readBody(req);
    const enabled = body?.enabled !== false;
    await store.putSettings({ plugins: { [id]: enabled } });
    sendJson(res, 200, { id, enabled });
    return;
  }

  if (p === '/api/skills' && m === 'GET') {
    sendJson(res, 200, await scanSkills(path.join(ROOT, 'skills')));
    return;
  }

  sendJson(res, 404, { error: 'not found' });
}

server.listen(PORT, '127.0.0.1', () => {
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : PORT;
  console.log(`PI_WORK_READY http://127.0.0.1:${port}`);
  if (TOKEN_GENERATED) {
    console.log(`PI_WORK_LOGIN http://127.0.0.1:${port}/login?token=${AUTH_TOKEN}`);
    console.log(`PI_WORK_TOKEN ${AUTH_TOKEN}`);
  }
});
