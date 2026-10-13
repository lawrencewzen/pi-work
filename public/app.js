import { t, tPlural, getLocale, setLocale, applyI18n } from './i18n.js';

// Application State
const state = {
  workspaces: [],
  activeWorkspaceId: null,
  conversations: [],
  activeConversationId: null,
  activeConversationData: null,
  activeRightTab: 'diff', // 'diff' | 'file' | 'markdown' | 'editor'
  changes: [],
  activeFilePath: null,
  activeDiff: null,
  activeFileContent: null,
  userPickedFile: false,
  settings: {},
  roles: [],
  pipelines: [],
  plugins: [],
  skills: [],
  about: {},
  allConversations: {}, // { [wid]: [conv, ...] }
  allRunningList: [],
  eventSource: null,
  unauthorized: false,
  theme: localStorage.getItem('piwork_theme') || 'white',
  appearance: localStorage.getItem('piwork_appearance') || 'light',
  fontSize: localStorage.getItem('piwork_font_size') || 'md',
  activeSettingsTab: 'general',
  expandedTools: new Set(),
  expandedSubagents: new Set(),
  workspaceTree: [],
  workspaceTreeFor: null,
  treeLoadingFor: null,
  treeGen: 0,
  allowedWorkspaceRoot: '',
};

let runningPollInterval = null;
let convMetaRefreshTimer = null;

// ============================================================================
// Utilities
// ============================================================================
export function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function truncateFilename(name, max) {
  if (name.length <= max) return name;
  if (max <= 1) return '…'.slice(0, max);
  return `…${name.slice(-(max - 1))}`;
}

export function truncatePath(p, max = 40) {
  const s = String(p ?? '').replaceAll('\\', '/');
  if (s.length <= max) return s;
  const parts = s.split('/').filter((x) => x.length > 0);
  const filename = parts.pop() || s;
  const first = parts[0];
  if (first) {
    const candidate = `${first}/…/${filename}`;
    if (candidate.length <= max) return candidate;
    const prefix = `${first}/…/`;
    const budget = max - prefix.length;
    if (budget >= 1) {
      if (filename.length <= budget) return prefix + filename;
      return prefix + truncateFilename(filename, budget);
    }
  }
  return truncateFilename(s, max);
}

export function maskApiKey(key) {
  if (!key) return '';
  const s = String(key).trim();
  if (!s) return '';
  if (s.length <= 4) return '••••' + s;
  return '••••' + s.slice(-4);
}

/** Relative label such as "10秒前". `ts` is a millisecond timestamp. */
export function formatRelativeTime(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return '';
  const diffSec = Math.max(1, Math.round((Date.now() - n) / 1000));
  if (diffSec < 60) return t('sec_ago', { n: diffSec });
  return t('min_ago', { n: Math.max(1, Math.round(diffSec / 60)) });
}

/** Refresh every element stamped with data-rel-time / data-ts. */
export function refreshRelativeTimes() {
  document.querySelectorAll('[data-rel-time]').forEach((el) => {
    const text = formatRelativeTime(el.getAttribute('data-ts'));
    if (text) el.textContent = text;
  });
}

let relativeTimeTimer = null;
function startRelativeTimeTicker() {
  if (relativeTimeTimer) return;
  relativeTimeTimer = setInterval(refreshRelativeTimes, 15000);
}

export function dedupeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  const seen = new Set();
  const deduped = [];
  for (const m of messages) {
    if (!m) continue;
    const id = m.id || `${m.role}:${m.text || ''}:${m.tool?.id || ''}`;
    if (!seen.has(id)) {
      seen.add(id);
      deduped.push(m);
    }
  }
  return deduped;
}

// Markdown parser
export function renderMarkdown(src = '') {
  if (!src) return '';
  const lines = src.split(/\r?\n/);
  const out = [];
  let inCode = false;
  let codeLang = '';
  let codeBuffer = [];
  let inUl = false;
  let inOl = false;

  function closeLists() {
    if (inUl) { out.push('</ul>'); inUl = false; }
    if (inOl) { out.push('</ol>'); inOl = false; }
  }

  function inlineFormat(txt) {
    let s = escapeHtml(txt);
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*]+)\*([^*]|$)/g, '$1<em>$2</em>$3');
    return s;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.trim().startsWith('```')) {
      if (!inCode) {
        closeLists();
        inCode = true;
        codeLang = line.trim().slice(3).trim();
        codeBuffer = [];
      } else {
        inCode = false;
        out.push(
          `<div class="code-block-card">` +
          `<div class="code-block-bar"><span>${escapeHtml(codeLang || 'text')}</span></div>` +
          `<pre class="code-block-pre"><code>${escapeHtml(codeBuffer.join('\n'))}</code></pre>` +
          `</div>`
        );
        codeBuffer = [];
      }
      continue;
    }

    if (inCode) {
      codeBuffer.push(line);
      continue;
    }

    if (!line.trim()) {
      closeLists();
      continue;
    }

    const h3Match = line.match(/^###\s+(.*)$/);
    if (h3Match) {
      closeLists();
      out.push(`<h3>${inlineFormat(h3Match[1])}</h3>`);
      continue;
    }
    const h2Match = line.match(/^##\s+(.*)$/);
    if (h2Match) {
      closeLists();
      out.push(`<h2>${inlineFormat(h2Match[1])}</h2>`);
      continue;
    }
    const h1Match = line.match(/^#\s+(.*)$/);
    if (h1Match) {
      closeLists();
      out.push(`<h1>${inlineFormat(h1Match[1])}</h1>`);
      continue;
    }

    const ulMatch = line.match(/^[-*]\s+(.*)$/);
    if (ulMatch) {
      if (inOl) { out.push('</ol>'); inOl = false; }
      if (!inUl) { out.push('<ul>'); inUl = true; }
      out.push(`<li>${inlineFormat(ulMatch[1])}</li>`);
      continue;
    }

    const olMatch = line.match(/^\d+\.\s+(.*)$/);
    if (olMatch) {
      if (inUl) { out.push('</ul>'); inUl = false; }
      if (!inOl) { out.push('<ol>'); inOl = true; }
      out.push(`<li>${inlineFormat(olMatch[1])}</li>`);
      continue;
    }

    closeLists();
    out.push(`<p>${inlineFormat(line)}</p>`);
  }

  if (inCode) {
    out.push(`<pre class="code-block-pre"><code>${escapeHtml(codeBuffer.join('\n'))}</code></pre>`);
  }
  closeLists();
  return out.join('');
}

const ROLE_LABEL_KEYS = {
  coder: 'role_coder',
  tester: 'role_tester',
  auditor: 'role_auditor',
  default: 'role_default',
  agent: 'agent_name',
};

export function localizeRoleLabel(value) {
  const raw = String(value || '').trim();
  if (!raw) return t('agent_name');
  const key = ROLE_LABEL_KEYS[raw.toLowerCase()];
  return key ? t(key) : raw;
}

const PROVIDER_PRESETS = {
  xai: { baseUrl: 'https://api.x.ai/v1', modelHint: 'grok-4' },
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', modelHint: 'deepseek-chat' },
  openai: { baseUrl: 'https://api.openai.com/v1', modelHint: 'gpt-4o' },
  ollama: { baseUrl: 'http://127.0.0.1:11434/v1', modelHint: 'llama3.2' },
};

function providerPreset(prov) {
  return PROVIDER_PRESETS[prov] || PROVIDER_PRESETS.openai;
}

/** New-file hunks have an empty old side (`@@ -0,0`). */
export function isAddedFileDiff(diffText) {
  if (!diffText) return false;
  const hunks = [...String(diffText).matchAll(/^@@\s+-\d+,(\d+)/gm)];
  return hunks.length > 0 && hunks.every((m) => m[1] === '0');
}

// Unified Diff renderer
export function renderDiffHtml(diffText) {
  if (!diffText) return `<div class="empty-placeholder">${escapeHtml(t('no_diff_available'))}</div>`;
  const single = isAddedFileDiff(diffText);
  const lines = diffText.split(/\r?\n/);
  const rows = [];
  let oldLn = 0;
  let newLn = 0;

  for (const line of lines) {
    if (line === '' || line.startsWith('---') || line.startsWith('+++')) {
      continue;
    }
    if (line.startsWith('@@')) {
      const m = line.match(/@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
      if (m) {
        oldLn = parseInt(m[1], 10);
        newLn = parseInt(m[2], 10);
      }
      rows.push(`<tr class="diff-row-hunk"><td colspan="${single ? 2 : 4}">${escapeHtml(line)}</td></tr>`);
      continue;
    }
    if (single) {
      const added = line.startsWith('+');
      const code = escapeHtml(line.startsWith('+') || line.startsWith(' ') || line.startsWith('-') ? line.slice(1) : line);
      const cls = added || line.startsWith('+') ? 'add-line' : '';
      rows.push(
        `<tr class="diff-row">` +
        `<td class="ln ${cls}">${newLn || ''}</td>` +
        `<td class="code-cell ${cls}">${code}</td>` +
        `</tr>`
      );
      if (newLn) newLn++;
      continue;
    }
    if (line.startsWith('-')) {
      const code = escapeHtml(line.slice(1));
      rows.push(
        `<tr class="diff-row">` +
        `<td class="ln del-line">${oldLn}</td>` +
        `<td class="code-cell del-line right-border">${code}</td>` +
        `<td class="ln empty-cell"></td>` +
        `<td class="code-cell empty-cell"></td>` +
        `</tr>`
      );
      oldLn++;
    } else if (line.startsWith('+')) {
      const code = escapeHtml(line.slice(1));
      rows.push(
        `<tr class="diff-row">` +
        `<td class="ln empty-cell"></td>` +
        `<td class="code-cell empty-cell right-border"></td>` +
        `<td class="ln add-line">${newLn}</td>` +
        `<td class="code-cell add-line">${code}</td>` +
        `</tr>`
      );
      newLn++;
    } else {
      const code = escapeHtml(line.startsWith(' ') ? line.slice(1) : line);
      rows.push(
        `<tr class="diff-row">` +
        `<td class="ln">${oldLn || ''}</td>` +
        `<td class="code-cell right-border">${code}</td>` +
        `<td class="ln">${newLn || ''}</td>` +
        `<td class="code-cell">${code}</td>` +
        `</tr>`
      );
      if (oldLn) oldLn++;
      if (newLn) newLn++;
    }
  }

  const cols = single
    ? `<colgroup><col class="col-ln"><col class="col-code"></colgroup>`
    : `<colgroup><col class="col-ln"><col class="col-code"><col class="col-ln"><col class="col-code"></colgroup>`;
  return (
    `<table class="diff-table${single ? ' diff-single' : ''}">` +
    cols +
    `<tbody>${rows.join('')}</tbody>` +
    `</table>`
  );
}

// Toast notification
export function showToast(message) {
  const existing = document.querySelector('.toast-msg');
  if (existing) existing.remove();
  const el = document.createElement('div');
  el.className = 'toast-msg';
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

// ============================================================================
// Auth & API client
// ============================================================================
export function handleUnauthorized() {
  const first = !state.unauthorized;
  state.unauthorized = true;

  if (first) {
    if (state.eventSource) {
      state.eventSource.close();
      state.eventSource = null;
    }
    if (runningPollInterval) {
      clearInterval(runningPollInterval);
      runningPollInterval = null;
    }
  }

  let ov = document.getElementById('auth-overlay');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'auth-overlay';
    ov.className = 'auth-overlay';
    document.body.appendChild(ov);
  }
  ov.style.display = 'flex';
  ov.innerHTML = `
    <div class="auth-notice-card">
      <div style="font-size:32px;margin-bottom:12px;">🔒</div>
      <div class="auth-notice-title">${escapeHtml(t('unauthorized_notice'))}</div>
    </div>
  `;
}

export async function api(endpoint, method = 'GET', body = null) {
  if (state.unauthorized) {
    throw new Error('Unauthorized');
  }

  const isMutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method.toUpperCase());
  const headers = {};

  if (isMutating || body != null) {
    headers['Content-Type'] = 'application/json';
  }

  let reqBody = undefined;
  if (body != null) {
    reqBody = JSON.stringify(body);
  } else if (isMutating) {
    reqBody = '{}';
  }

  const res = await fetch(endpoint, {
    method,
    headers,
    credentials: 'same-origin',
    body: reqBody,
  });

  if (res.status === 401) {
    handleUnauthorized();
    const err = new Error('Unauthorized');
    err.status = 401;
    throw err;
  }

  if (!res.ok) {
    let errBody = null;
    try { errBody = await res.json(); } catch { /* ignore */ }
    const err = new Error(errBody?.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.body = errBody;
    throw err;
  }

  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return res.json();
  return res.text();
}

// ============================================================================
// Theme & Appearance
// ============================================================================
export function applyTheme(family = state.theme, mode = state.appearance) {
  state.theme = family;
  state.appearance = mode;
  localStorage.setItem('piwork_theme', family);
  localStorage.setItem('piwork_appearance', mode);

  let effectiveMode = mode;
  if (mode === 'system') {
    effectiveMode = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  const themeAttr = `${family}-${effectiveMode}`;
  document.documentElement.setAttribute('data-theme', themeAttr);
  document.documentElement.setAttribute('data-font-size', state.fontSize);
}

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (state.appearance === 'system') {
    applyTheme(state.theme, 'system');
  }
});

// ============================================================================
// Data Loading & Management
// ============================================================================
export async function loadInitialData() {
  try {
    state.settings = await api('/api/settings');
    rememberSavedSettings(state.settings);
    if (state.settings.theme) state.theme = state.settings.theme;
    if (state.settings.appearance) state.appearance = state.settings.appearance;
    if (state.settings.language) setLocale(state.settings.language);
  } catch { /* ignore */ }

  try {
    const rootInfo = await api('/api/workspace-root');
    state.allowedWorkspaceRoot = rootInfo?.root || '';
  } catch { /* hint falls back to the create-error payload */ }

  applyTheme(state.theme, state.appearance);
  applyI18n();

  try { state.roles = await api('/api/roles'); } catch { state.roles = []; }
  try { state.pipelines = await api('/api/pipelines'); } catch { state.pipelines = []; }
  try { state.plugins = await api('/api/plugins'); } catch { state.plugins = []; }
  try { state.skills = await api('/api/skills'); } catch { state.skills = []; }
  try { state.about = await api('/api/about'); } catch { state.about = {}; }

  await loadWorkspaces();
}

export async function loadWorkspaces() {
  try {
    state.workspaces = await api('/api/workspaces');
  } catch (err) {
    state.workspaces = [];
  }

  const savedWsId = localStorage.getItem('piwork_active_ws');
  if (savedWsId && state.workspaces.some((w) => w.id === savedWsId)) {
    state.activeWorkspaceId = savedWsId;
  } else if (state.workspaces.length > 0) {
    state.activeWorkspaceId = state.workspaces[0].id;
  } else {
    state.activeWorkspaceId = null;
  }

  renderSidebarWorkspaces();
  await refreshRunningOverview();

  if (state.activeWorkspaceId) {
    await loadConversations(state.activeWorkspaceId);
  } else {
    if (state.eventSource) {
      state.eventSource.close();
      state.eventSource = null;
    }
    state.activeConversationId = null;
    state.activeConversationData = null;
    resetRightPanelAndStatus();
    renderConversations();
    renderChatThread();
  }
}

export async function loadConversations(wid) {
  try {
    state.conversations = await api(`/api/workspaces/${encodeURIComponent(wid)}/conversations`);
    state.allConversations[wid] = state.conversations;
  } catch {
    state.conversations = [];
  }

  const savedCid = localStorage.getItem('piwork_active_conv');
  if (savedCid && state.conversations.some((c) => c.id === savedCid)) {
    state.activeConversationId = savedCid;
  } else if (state.conversations.length > 0) {
    state.activeConversationId = state.conversations[0].id;
  } else {
    state.activeConversationId = null;
  }

  renderSidebarWorkspaces();
  renderConversations();
  await refreshRunningOverview();

  if (state.activeConversationId) {
    await selectConversation(state.activeConversationId);
  } else {
    if (state.eventSource) {
      state.eventSource.close();
      state.eventSource = null;
    }
    state.activeConversationData = null;
    resetRightPanelAndStatus();
    renderChatThread();
  }
}

function resetRightPanelAndStatus() {
  state.changes = [];
  state.activeFilePath = null;
  state.activeDiff = null;
  state.activeFileContent = null;
  state.userPickedFile = false;
  renderStatusBar();
  renderRightPanel();
}

export async function selectWorkspace(wid) {
  if (state.activeWorkspaceId === wid) return;
  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }
  state.activeConversationId = null;
  state.activeConversationData = null;
  state.activeWorkspaceId = wid;
  state.workspaceTree = [];
  state.workspaceTreeFor = null;
  state.treeLoadingFor = null;
  state.treeGen += 1;
  localStorage.setItem('piwork_active_ws', wid);
  resetRightPanelAndStatus();
  renderChatThread();
  await loadConversations(wid);
}

export async function loadWorkspaceTree() {
  const wid = state.activeWorkspaceId;
  if (!wid) {
    state.workspaceTree = [];
    state.workspaceTreeFor = null;
    return;
  }
  const gen = ++state.treeGen;
  state.treeLoadingFor = wid;
  try {
    const data = await api(`/api/workspaces/${encodeURIComponent(wid)}/tree`);
    if (gen !== state.treeGen || state.activeWorkspaceId !== wid) return;
    state.workspaceTree = Array.isArray(data?.entries) ? data.entries : [];
    state.workspaceTreeFor = wid;
  } catch {
    if (gen !== state.treeGen || state.activeWorkspaceId !== wid) return;
    state.workspaceTree = [];
    state.workspaceTreeFor = wid;
  } finally {
    if (state.treeLoadingFor === wid) state.treeLoadingFor = null;
  }
}

function ensureWorkspaceTree() {
  const wid = state.activeWorkspaceId;
  if (!wid) return;
  if (state.workspaceTreeFor === wid || state.treeLoadingFor === wid) return;
  loadWorkspaceTree().then(() => {
    if (state.activeRightTab === 'file' && state.workspaceTreeFor === state.activeWorkspaceId) {
      renderRightPanel();
    }
  });
}

export async function selectConversation(cid) {
  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }

  state.activeConversationId = cid;
  localStorage.setItem('piwork_active_conv', cid);
  state.activeConversationData = null;
  resetRightPanelAndStatus();
  renderChatThread();
  renderConversations();

  try {
    state.activeConversationData = await api(`/api/conversations/${encodeURIComponent(cid)}`);
    if (state.activeConversationData) {
      if (state.activeConversationData.messages) {
        state.activeConversationData.messages = dedupeMessages(state.activeConversationData.messages);
      }
      if (state.activeConversationData.title) {
        const item = state.conversations.find((c) => c.id === cid);
        if (item) item.title = state.activeConversationData.title;
      }
    }
  } catch {
    state.activeConversationData = null;
  }

  try {
    state.changes = await api(`/api/conversations/${encodeURIComponent(cid)}/changes`);
  } catch {
    state.changes = [];
  }

  const savedTab = localStorage.getItem('piwork_active_right_tab') || 'diff';
  state.activeRightTab = savedTab;
  state.userPickedFile = false;

  if (state.changes.length > 0) {
    state.activeFilePath = state.changes[state.changes.length - 1].path;
  } else {
    state.activeFilePath = null;
  }

  renderConversations();
  renderStatusBar();
  renderChatThread();
  renderRightPanel();

  connectSSE(cid);

  if (state.activeFilePath) {
    await loadFileOrDiff(state.activeFilePath);
  }
}

function applyStreamDelta(msgs, data) {
  const incoming = data.text || '';
  let m = msgs.find((msg) => msg.id === data.messageId);
  if (!m) {
    m = {
      id: data.messageId,
      role: data.role || 'assistant',
      text: incoming,
      streaming: true,
      agentId: data.agentId,
      roleId: data.roleId,
      kind: data.kind,
      fromAgent: data.fromAgent,
      toAgent: data.toAgent,
    };
    msgs.push(m);
    return m;
  }
  if (data.agentId) m.agentId = data.agentId;
  if (data.roleId) m.roleId = data.roleId;
  if (data.kind) m.kind = data.kind;
  if (data.fromAgent) m.fromAgent = data.fromAgent;
  if (data.toAgent) m.toAgent = data.toAgent;
  if (m.done || m.streaming === false || m.streaming !== true) {
    return m;
  }
  const cur = m.text || '';
  if (!incoming) return m;
  if (!cur) {
    m.text = incoming;
  } else if (incoming.startsWith(cur)) {
    m.text = incoming;
  } else if (cur === incoming || cur.endsWith(incoming) || cur.includes(incoming)) {
    /* already have this chunk */
  } else {
    m.text = cur + incoming;
  }
  m.streaming = true;
  return m;
}

function scheduleConversationRefresh(cid) {
  if (!cid) return;
  if (convMetaRefreshTimer) clearTimeout(convMetaRefreshTimer);
  convMetaRefreshTimer = setTimeout(() => {
    refreshConversationMeta(cid);
  }, 120);
}

export async function refreshConversationMeta(cid) {
  if (!cid) return;
  const wid = state.activeWorkspaceId;
  try {
    if (wid) {
      const list = await api(`/api/workspaces/${encodeURIComponent(wid)}/conversations`);
      state.conversations = list;
      state.allConversations[wid] = list;
      const item = list.find((c) => c.id === cid);
      if (item) {
        if (state.activeConversationData && state.activeConversationData.id === cid) {
          if (item.title) state.activeConversationData.title = item.title;
          if (item.autoContinues != null) state.activeConversationData.autoContinues = item.autoContinues;
          if (item.status) state.activeConversationData.status = item.status;
          if (item.lastCheckpointAt) state.activeConversationData.lastCheckpointAt = item.lastCheckpointAt;
        }
      }
      renderConversations();
      renderStatusBar();
    }
    if (state.activeConversationId !== cid) return;
    const conv = await api(`/api/conversations/${encodeURIComponent(cid)}`);
    if (state.activeConversationId !== cid || !state.activeConversationData) return;
    if (conv.title) {
      state.activeConversationData.title = conv.title;
      const item = state.conversations.find((c) => c.id === cid);
      if (item) item.title = conv.title;
    }
    if (conv.autoContinues != null) state.activeConversationData.autoContinues = conv.autoContinues;
    if (conv.status) state.activeConversationData.status = conv.status;
    if (conv.lastCheckpointAt) state.activeConversationData.lastCheckpointAt = conv.lastCheckpointAt;
    if (conv.agents) state.activeConversationData.agents = conv.agents;
    if (Array.isArray(conv.messages)) {
      const local = state.activeConversationData.messages || [];
      const streaming = new Map(local.filter((m) => m.streaming).map((m) => [m.id, m]));
      const merged = [];
      const seen = new Set();
      for (const m of conv.messages) {
        seen.add(m.id);
        const live = streaming.get(m.id);
        merged.push(live || m);
      }
      for (const m of local) {
        if (seen.has(m.id)) continue;
        if (m.streaming || String(m.id).startsWith('usr-')) {
          const dup = merged.some((x) => x.role === m.role && x.kind !== 'handoff' && x.text === m.text);
          if (!dup) merged.push(m);
        }
      }
      state.activeConversationData.messages = dedupeMessages(merged);
    }
    renderConversations();
    renderStatusBar();
    renderChatThread();
  } catch { /* ignore */ }
}

// ============================================================================
// SSE Streaming & Real-time Updates
// ============================================================================
export function connectSSE(cid) {
  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }
  if (state.unauthorized) return;

  const sse = new EventSource(`/api/conversations/${encodeURIComponent(cid)}/events`);
  state.eventSource = sse;

  sse.addEventListener('status', (ev) => {
    try {
      const data = JSON.parse(ev.data);
      if (state.activeConversationData && state.activeConversationId === cid) {
        state.activeConversationData.status = data.status;
        if (data.autoContinues != null) state.activeConversationData.autoContinues = data.autoContinues;
        if (data.title) {
          state.activeConversationData.title = data.title;
          const item = state.conversations.find((c) => c.id === cid);
          if (item) item.title = data.title;
        }
        renderStatusBar();
        renderConversations();
      }
      updateConversationStatus(cid, data.status);
      scheduleConversationRefresh(cid);
    } catch { /* ignore */ }
  });

  sse.addEventListener('agent', (ev) => {
    try {
      const data = JSON.parse(ev.data);
      if (!state.activeConversationData || state.activeConversationId !== cid) return;
      state.activeConversationData.agents = state.activeConversationData.agents || [];
      const idx = state.activeConversationData.agents.findIndex((a) => a.id === data.id);
      if (idx >= 0) {
        state.activeConversationData.agents[idx] = { ...state.activeConversationData.agents[idx], ...data };
      } else {
        state.activeConversationData.agents.push(data);
      }
      renderConversations();
      renderChatThread();
      scheduleConversationRefresh(cid);
    } catch { /* ignore */ }
  });

  sse.addEventListener('message.delta', (ev) => {
    try {
      const data = JSON.parse(ev.data);
      if (!state.activeConversationData || state.activeConversationId !== cid) return;
      if (!data.messageId) return;
      state.activeConversationData.messages = state.activeConversationData.messages || [];
      applyStreamDelta(state.activeConversationData.messages, data);
      renderChatThread();
    } catch { /* ignore */ }
  });

  sse.addEventListener('message.done', (ev) => {
    try {
      const data = ev.data ? JSON.parse(ev.data) : {};
      if (state.activeConversationData && state.activeConversationId === cid) {
        const msgs = state.activeConversationData.messages || [];
        if (data.messageId) {
          const m = msgs.find((msg) => msg.id === data.messageId);
          if (m) {
            if (data.text != null && data.text !== '') {
              m.text = data.text;
            }
            if (data.agentId) m.agentId = data.agentId;
            if (data.roleId) m.roleId = data.roleId;
            m.streaming = false;
            m.done = true;
          }
        }
        renderChatThread();
        scheduleConversationRefresh(cid);
      }
    } catch {
      if (state.activeConversationId === cid) {
        renderChatThread();
      }
    }
  });

  sse.addEventListener('tool.start', (ev) => {
    try {
      const data = JSON.parse(ev.data);
      if (!state.activeConversationData || state.activeConversationId !== cid) return;
      const tool = data.tool;
      const msgs = state.activeConversationData.messages = state.activeConversationData.messages || [];
      let m = msgs.find((msg) => msg.tool && msg.tool.id === tool.id);
      if (!m) {
        msgs.push({ id: `tool-${tool.id}`, role: 'tool', tool });
      } else {
        m.tool = { ...m.tool, ...tool };
      }
      renderChatThread();
    } catch { /* ignore */ }
  });

  sse.addEventListener('tool.end', (ev) => {
    try {
      const data = JSON.parse(ev.data);
      if (!state.activeConversationData || state.activeConversationId !== cid) return;
      const tool = data.tool;
      const msgs = state.activeConversationData.messages = state.activeConversationData.messages || [];
      let m = msgs.find((msg) => msg.tool && msg.tool.id === tool.id);
      if (!m) {
        msgs.push({ id: `tool-${tool.id}`, role: 'tool', tool });
      } else {
        m.tool = { ...m.tool, ...tool };
      }
      renderChatThread();

      api(`/api/conversations/${encodeURIComponent(cid)}/changes`)
        .then((changes) => {
          state.changes = Array.isArray(changes) ? changes : [];
          const newest = state.changes.length ? state.changes[state.changes.length - 1].path : null;
          const toolPath = tool?.path || tool?.input?.path || null;
          const stillExists = state.activeFilePath && state.changes.some((c) => c.path === state.activeFilePath);
          if (!state.userPickedFile) {
            const pick = (toolPath && state.changes.some((c) => c.path === toolPath)) ? toolPath : newest;
            if (pick) {
              loadFileOrDiff(pick);
              return;
            }
          } else if (!stillExists) {
            state.userPickedFile = false;
            if (newest) {
              loadFileOrDiff(newest);
              return;
            }
            state.activeFilePath = null;
            state.activeDiff = null;
          }
          renderRightPanel();
          if (state.activeFilePath) loadFileOrDiff(state.activeFilePath);
        })
        .catch(() => {});
    } catch { /* ignore */ }
  });

  sse.addEventListener('checkpoint', (ev) => {
    try {
      const data = JSON.parse(ev.data);
      if (state.activeConversationData && state.activeConversationId === cid) {
        state.activeConversationData.lastCheckpointAt = data.at;
        state.activeConversationData.currentStep = data.step;
        renderStatusBar();
      }
    } catch { /* ignore */ }
  });

  sse.addEventListener('retry', (ev) => {
    try {
      const data = JSON.parse(ev.data);
      if (state.activeConversationData && state.activeConversationId === cid) {
        if (data.autoContinues != null) {
          state.activeConversationData.autoContinues = data.autoContinues;
        } else {
          state.activeConversationData.autoContinues = data.attempt || ((state.activeConversationData.autoContinues || 0) + 1);
        }
        renderStatusBar();
      }
    } catch { /* ignore */ }
  });

  sse.addEventListener('error', () => {
    // SSE error
  });
}

export function updateConversationStatus(cid, status) {
  const c = state.conversations.find((item) => item.id === cid);
  if (c) c.status = status;

  for (const wid of Object.keys(state.allConversations)) {
    const item = state.allConversations[wid]?.find((conv) => conv.id === cid);
    if (item) item.status = status;
  }

  const activeStatuses = new Set(['running', 'recovering', 'paused']);
  if (!activeStatuses.has(status)) {
    state.allRunningList = state.allRunningList.filter((item) => item.id !== cid);
  } else {
    const existing = state.allRunningList.find((item) => item.id === cid);
    const convInfo = c || state.allRunningList.find((item) => item.id === cid);
    const ws = state.workspaces.find((w) => w.id === state.activeWorkspaceId) || {};
    if (existing) {
      existing.status = status;
    } else if (convInfo) {
      state.allRunningList.push({
        ...convInfo,
        status,
        workspaceId: convInfo.workspaceId || ws.id,
        workspaceName: convInfo.workspaceName || ws.name,
      });
    }
  }

  renderConversations();
  renderRunningOverview();
}

// Background polling for all workspaces' running status
export async function refreshRunningOverview() {
  if (state.unauthorized) return;
  const activeStatuses = new Set(['running', 'recovering', 'paused']);
  const running = [];
  try {
    for (const ws of state.workspaces) {
      let list = [];
      try {
        list = await api(`/api/workspaces/${encodeURIComponent(ws.id)}/conversations`);
        state.allConversations[ws.id] = list;
      } catch {
        list = state.allConversations[ws.id] || [];
      }
      for (const conv of list) {
        if (conv.status && activeStatuses.has(conv.status)) {
          running.push({ ...conv, workspaceName: ws.name, workspaceId: ws.id });
        }
      }
    }
    state.allRunningList = running;
    renderRunningOverview();
  } catch { /* ignore */ }
}

runningPollInterval = setInterval(() => {
  if (state.unauthorized) {
    if (runningPollInterval) {
      clearInterval(runningPollInterval);
      runningPollInterval = null;
    }
    return;
  }
  refreshRunningOverview();
}, 2000);

// ============================================================================
// Actions: Send, Controls, Create Workspace, Conversation
// ============================================================================
export async function sendMessage(text) {
  if (!text || !text.trim() || !state.activeConversationId) return;
  const cid = state.activeConversationId;

  if (state.activeConversationData) {
    state.activeConversationData.messages = state.activeConversationData.messages || [];
    state.activeConversationData.messages.push({
      id: `usr-${Date.now()}`,
      role: 'user',
      text,
    });
    state.activeConversationData.status = 'running';
    renderChatThread();
    renderStatusBar();
  }

  updateConversationStatus(cid, 'running');

  try {
    await api(`/api/conversations/${encodeURIComponent(cid)}/messages`, 'POST', { text });
    scheduleConversationRefresh(cid);
  } catch (err) {
    showToast(err.message || t('err_send'));
    updateConversationStatus(cid, 'failed');
  }
}

export async function pauseConversation() {
  if (!state.activeConversationId) return;
  try {
    const res = await api(`/api/conversations/${encodeURIComponent(state.activeConversationId)}/pause`, 'POST');
    updateConversationStatus(state.activeConversationId, res.status || 'paused');
    if (state.activeConversationData) {
      state.activeConversationData.status = res.status || 'paused';
      renderStatusBar();
    }
  } catch (err) {
    showToast(err.message || t('err_pause'));
  }
}

export async function resumeConversation() {
  if (!state.activeConversationId) return;
  try {
    const res = await api(`/api/conversations/${encodeURIComponent(state.activeConversationId)}/resume`, 'POST');
    updateConversationStatus(state.activeConversationId, res.status || 'running');
    if (state.activeConversationData) {
      state.activeConversationData.status = res.status || 'running';
      renderStatusBar();
    }
  } catch (err) {
    showToast(err.message || t('err_resume'));
  }
}

export async function stopConversation() {
  if (!state.activeConversationId) return;
  try {
    const res = await api(`/api/conversations/${encodeURIComponent(state.activeConversationId)}/stop`, 'POST');
    updateConversationStatus(state.activeConversationId, res.status || 'stopped');
    if (state.activeConversationData) {
      state.activeConversationData.status = res.status || 'stopped';
      renderStatusBar();
    }
  } catch (err) {
    showToast(err.message || t('err_stop'));
  }
}

export async function createNewWorkspace(data) {
  const ws = await api('/api/workspaces', 'POST', data);
  showToast(t('ws_created', { name: ws.name || data?.name || '' }));
  closeModal();
  try {
    await loadWorkspaces();
    if (ws.id) await selectWorkspace(ws.id);
  } catch { /* created; sidebar refresh is best-effort */ }
  return ws;
}

export async function createNewConversation(opts = {}) {
  if (!state.activeWorkspaceId) {
    showToast(t('err_select_workspace'));
    return;
  }
  const body = { title: opts.title || '' };
  if (opts.roleId) body.roleId = opts.roleId;
  if (opts.pipelineId) body.pipelineId = opts.pipelineId;
  try {
    const conv = await api(`/api/workspaces/${encodeURIComponent(state.activeWorkspaceId)}/conversations`, 'POST', body);
    await loadConversations(state.activeWorkspaceId);
    if (conv.id) await selectConversation(conv.id);
    return conv;
  } catch (err) {
    showToast(err.message || t('err_create_conversation'));
  }
}

export async function loadFileOrDiff(filePath) {
  state.activeFilePath = filePath;
  localStorage.setItem('piwork_active_file', filePath);
  const tab = state.activeRightTab;

  if (tab === 'editor' || tab === 'markdown' || tab === 'file') {
    try {
      const fileData = await api(`/api/workspaces/${encodeURIComponent(state.activeWorkspaceId)}/files?path=${encodeURIComponent(filePath)}`);
      state.activeFileContent = fileData.content ?? '';
    } catch {
      state.activeFileContent = '';
    }
  }
  if (tab === 'diff' || !tab) {
    try {
      state.activeDiff = await api(`/api/conversations/${encodeURIComponent(state.activeConversationId)}/diff?path=${encodeURIComponent(filePath)}`);
    } catch {
      state.activeDiff = null;
    }
  }
  renderRightPanel();
}

export async function saveEditorFile() {
  const editorEl = document.querySelector('[data-testid="md-editor"] [contenteditable="true"]');
  if (!editorEl || !state.activeFilePath || !state.activeWorkspaceId) return;
  const content = editorEl.innerText;
  try {
    await api(`/api/workspaces/${encodeURIComponent(state.activeWorkspaceId)}/files`, 'PUT', {
      path: state.activeFilePath,
      content,
    });
    showToast(t('btn_saved'));
    state.activeFileContent = content;
  } catch (err) {
    showToast(err.message || t('err_save'));
  }
}

// ============================================================================
// UI Rendering Functions
// ============================================================================
export function renderSidebarWorkspaces() {
  const container = document.getElementById('ws-tree-container');
  if (!container) return;

  const countLabel = document.getElementById('ws-count-label');
  if (countLabel) countLabel.textContent = tPlural('workspace_count', state.workspaces.length);

  container.innerHTML = state.workspaces
    .map((ws) => {
      const isActive = ws.id === state.activeWorkspaceId;
      return (
        `<div class="ws-tree-node ${isActive ? 'ws-active' : ''}" data-testid="workspace-item" data-id="${escapeHtml(ws.id)}">` +
        `<div class="ws-node-header" data-action="select-workspace" data-ws-id="${escapeHtml(ws.id)}" title="${escapeHtml(ws.path)}">` +
        `<svg class="ws-node-icon icon" viewBox="0 0 24 24"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>` +
        `<span class="ws-node-title">${escapeHtml(ws.name)}</span>` +
        (isActive ? `<span class="ws-node-badge">${escapeHtml(t('current'))}</span>` : '') +
        `</div>` +
        (isActive ? `<div class="ws-node-children" id="conv-list-container"></div>` : '') +
        `</div>`
      );
    })
    .join('');
}

export function renderSidebarAgents(conv) {
  const agents = (state.activeConversationData && state.activeConversationData.id === conv.id && state.activeConversationData.agents)
    ? state.activeConversationData.agents
    : (conv.agents || []);

  if (agents.length === 0) {
    const status = conv.status || 'idle';
    const statusClass = `dot-${status}`;
    const statusTextStr = t(`status_${status}`) || status;
    return (
      `<div class="conv-node-agents">` +
      `<div class="main-agent-node">` +
      `<div class="main-agent-header">` +
      `<span class="status-dot ${statusClass}" data-testid="status-dot" data-status="${escapeHtml(status)}"></span>` +
      `<span class="main-agent-name">${escapeHtml(t('agent_name'))}</span>` +
      `<span class="main-agent-state">${escapeHtml(statusTextStr)}</span>` +
      `</div>` +
      `</div>` +
      `</div>`
    );
  }

  return (
    `<div class="conv-node-agents">` +
    agents
      .map((ag, index) => {
        const isDefault = index === 0;
        const name = localizeRoleLabel(ag.roleId || ag.name || '');
        const st = ag.status || (isDefault ? conv.status || 'idle' : 'waiting');
        const statusClass = `dot-${st}`;
        const statusText = t(`status_${st}`) || st;
        const progressStr = (ag.totalSteps != null && ag.totalSteps > 0)
          ? `${ag.step || 0}/${ag.totalSteps}`
          : (ag.step != null && ag.step > 0 ? `${ag.step}` : '');

        return (
          `<div class="sub-agent-row" data-agent-id="${escapeHtml(ag.id || '')}">` +
          `<span class="status-dot ${statusClass}" ${isDefault ? `data-testid="status-dot" data-status="${escapeHtml(st)}"` : ''}></span>` +
          `<span class="sub-agent-name">${escapeHtml(name)}</span>` +
          (progressStr ? `<span class="sub-agent-progress">${escapeHtml(progressStr)}</span>` : '') +
          `<span class="sub-agent-status status-text-${escapeHtml(st)}">${escapeHtml(statusText)}</span>` +
          `</div>`
        );
      })
      .join('') +
    `</div>`
  );
}

export function renderConversations() {
  const container = document.getElementById('conv-list-container');
  if (!container) return;

  container.innerHTML = state.conversations
    .map((conv) => {
      const isActive = conv.id === state.activeConversationId;
      const status = conv.status || 'idle';

      return (
        `<div class="conv-tree-node ${isActive ? 'conv-active' : ''}" data-testid="conversation-item" data-id="${escapeHtml(conv.id)}" data-status="${escapeHtml(status)}">` +
        `<div class="conv-node-header" data-action="select-conversation" data-conv-id="${escapeHtml(conv.id)}" title="${escapeHtml(conv.title || '')}">` +
        `<svg class="conv-node-icon icon" viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>` +
        `<span class="conv-node-title">${escapeHtml(conv.title || t('default_conversation_title'))}</span>` +
        (isActive ? `<span class="active-indicator"></span>` : '') +
        `</div>` +
        (isActive ? renderSidebarAgents(conv) : '') +
        `</div>`
      );
    })
    .join('');
}

export function renderRunningOverview() {
  const activeCount = state.allRunningList.filter((c) => c.status === 'running' || c.status === 'recovering').length;
  const pausedCount = state.allRunningList.filter((c) => c.status === 'paused').length;

  const countTag = document.getElementById('running-count-tag');
  if (countTag) {
    if (pausedCount > 0) {
      countTag.textContent = `${t('active_count', { n: activeCount })} · ${pausedCount} ${t('status_paused')}`;
    } else {
      countTag.textContent = t('active_count', { n: activeCount });
    }
  }

  const panel = document.getElementById('running-panel');
  if (!panel) return;

  if (state.allRunningList.length === 0) {
    panel.innerHTML = `<div style="font-size:11px;color:var(--text-muted);padding:4px 2px;">${escapeHtml(t('no_active_tasks'))}</div>`;
    return;
  }

  panel.innerHTML = state.allRunningList
    .map((c) => {
      const statusTextStr = t(`status_${c.status}`) || c.status;
      return (
        `<div class="running-row" data-testid="agent-status-item" data-id="${escapeHtml(c.id)}" data-status="${escapeHtml(c.status)}" data-action="switch-ws-conv" data-ws-id="${escapeHtml(c.workspaceId)}" data-conv-id="${escapeHtml(c.id)}">` +
        `<span class="status-dot dot-${escapeHtml(c.status)}"></span>` +
        `<div class="running-path">` +
        `<span class="rp-ws">${escapeHtml(c.workspaceName || 'ws')}</span>` +
        `<span class="rp-div">›</span>` +
        `<span class="rp-conv">${escapeHtml(c.title || '')}</span>` +
        `<span class="rp-div">›</span>` +
        `<span class="rp-agent">${escapeHtml(localizeRoleLabel(c.roleId || ''))}</span>` +
        `<span class="rp-status">· ${escapeHtml(statusTextStr)}</span>` +
        `</div>` +
        `</div>`
      );
    })
    .join('');
}

export function renderStatusBar() {
  const bar = document.getElementById('status-bar');
  if (!bar) return;

  const conv = state.activeConversationData;
  const status = conv?.status || 'idle';
  const autoContinues = conv?.autoContinues || 0;
  const statusTextStr = t(`status_${status}`) || status;

  const statusTextEl = document.getElementById('status-text');
  if (statusTextEl) statusTextEl.textContent = statusTextStr;

  const ws = (state.workspaces || []).find((w) => w.id === state.activeWorkspaceId);
  const wsEl = document.getElementById('topbar-workspace');
  const wsSep = document.getElementById('topbar-ws-sep');
  if (wsEl) wsEl.textContent = ws?.name || '';
  if (wsSep) wsSep.classList.toggle('is-hidden', !ws?.name);

  const acBadge = document.getElementById('autocontinue-count');
  const acSep = document.getElementById('autocontinue-sep');
  const showAc = autoContinues > 0;
  if (acBadge) {
    acBadge.classList.toggle('is-hidden', !showAc);
    acBadge.textContent = showAc ? `↻ ${autoContinues}` : '';
  }
  if (acSep) acSep.classList.toggle('is-hidden', !showAc);

  const cpBadge = document.getElementById('checkpoint-badge-text');
  if (cpBadge) {
    if (conv?.lastCheckpointAt) {
      cpBadge.setAttribute('data-rel-time', '');
      cpBadge.setAttribute('data-ts', String(conv.lastCheckpointAt));
      cpBadge.textContent = formatRelativeTime(conv.lastCheckpointAt);
    } else {
      cpBadge.removeAttribute('data-rel-time');
      cpBadge.removeAttribute('data-ts');
      cpBadge.textContent = t('checkpoint_badge');
    }
  }

  const btnPause = document.getElementById('btn-pause');
  const btnResume = document.getElementById('btn-resume');
  const btnStop = document.getElementById('btn-stop');
  if (btnPause) btnPause.disabled = status !== 'running';
  if (btnResume) btnResume.disabled = status !== 'paused';
  if (btnStop) btnStop.disabled = status !== 'running' && status !== 'paused' && status !== 'recovering';
}

export function renderSubagentCardHtml(sa) {
  if (!sa) return '';
  const isExpanded = state.expandedSubagents.has(sa.id);
  const status = sa.status || 'waiting';
  const statusText = t(`status_${status}`) || status;
  const progressStr = (sa.totalSteps != null && sa.totalSteps > 0)
    ? `${sa.step || 0}/${sa.totalSteps}`
    : `${sa.step || 0} ${t('step_unit')}`;
  const name = localizeRoleLabel(sa.roleId || sa.name || '');

  let body = '';
  if (isExpanded) {
    let toolCallsHtml = '';
    if (Array.isArray(sa.toolCalls) && sa.toolCalls.length > 0) {
      toolCallsHtml = `
        <div style="margin-top:6px;">
          <strong style="font-size:11px;color:var(--text-muted);">${escapeHtml(t('tool_output'))}:</strong>
          <div class="tools-feed" style="margin-top:4px;">
            ${sa.toolCalls.map((tc) => {
              if (typeof tc === 'object' && tc !== null) {
                return renderToolRowHtml(tc);
              }
              return `<div style="font-size:11.5px;font-family:var(--font-mono);">${escapeHtml(String(tc))}</div>`;
            }).join('')}
          </div>
        </div>
      `;
    } else if (typeof sa.toolCalls === 'number' && sa.toolCalls > 0) {
      toolCallsHtml = `<div style="font-size:11px;color:var(--text-muted);margin-top:4px;">${escapeHtml(t('tool_calls_count', { n: sa.toolCalls }))}</div>`;
    }

    let lastTextHtml = '';
    if (sa.lastText) {
      lastTextHtml = `
        <div class="subagent-task-desc" style="margin-top:6px;">
          ${renderMarkdown(sa.lastText)}
        </div>
      `;
    }

    body = `
      <div class="subagent-card-body">
        <div style="font-size:11.5px;display:flex;gap:12px;color:var(--text-secondary);">
          <span><strong>${escapeHtml(t('tool_status_label'))}:</strong> ${escapeHtml(statusText)}</span>
          <span><strong>${escapeHtml(t('step_label'))}:</strong> ${escapeHtml(progressStr)}</span>
        </div>
        ${lastTextHtml}
        ${toolCallsHtml}
      </div>
    `;
  }

  return (
    `<div class="subagent-card ${isExpanded ? 'subagent-card-expanded' : 'subagent-card-compact'}" data-testid="subagent-card" data-agent-id="${escapeHtml(sa.id)}">` +
    `<div class="subagent-card-header" data-action="toggle-subagent" data-agent-id="${escapeHtml(sa.id)}">` +
    `<div class="subagent-card-title">` +
    `<span class="subagent-role-pill">${escapeHtml(t('subagent_dispatched'))}</span>` +
    `<span class="status-dot dot-${escapeHtml(status)}"></span>` +
    `<span class="subagent-card-name">${escapeHtml(name)}</span>` +
    `<span class="subagent-progress-badge">${escapeHtml(progressStr)}</span>` +
    `</div>` +
    `<div class="subagent-card-right">` +
    `<span class="status-text-${escapeHtml(status)}">${escapeHtml(statusText)}</span>` +
    `<svg class="chevron-icon icon" viewBox="0 0 24 24" style="transform:${isExpanded ? 'rotate(180deg)' : 'none'}"><polyline points="6 9 12 15 18 9"></polyline></svg>` +
    `</div>` +
    `</div>` +
    body +
    `</div>`
  );
}

export function toggleSubagent(agentId) {
  if (!agentId) return;
  if (state.expandedSubagents.has(agentId)) {
    state.expandedSubagents.delete(agentId);
  } else {
    state.expandedSubagents.add(agentId);
  }
  renderChatThread();
}

export function renderChatThread() {
  const thread = document.getElementById('center-thread');
  if (!thread) return;

  const conv = state.activeConversationData;
  if (!conv || !conv.messages || conv.messages.length === 0) {
    thread.innerHTML = `
      <div class="empty-placeholder">
        <div>
          <h3 style="margin-bottom:8px;font-weight:600;">${escapeHtml(t('empty_chat_title'))}</h3>
          <p style="font-size:12px;color:var(--text-muted);">${escapeHtml(t('composer_placeholder'))}</p>
        </div>
      </div>
    `;
    return;
  }

  const rendered = [];
  const msgs = dedupeMessages(conv.messages);

  const subagents = (conv.agents || []).slice(1);
  let subagentsInserted = false;

  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.kind === 'handoff') {
      rendered.push(
        `<div class="handoff-note" data-testid="message" data-role="system" data-kind="handoff">` +
        `<span>${escapeHtml(t('handoff_note', { from: localizeRoleLabel(m.fromAgent || ''), to: localizeRoleLabel(m.toAgent || '') }))}</span>` +
        `</div>`
      );
      continue;
    }
    if (m.role === 'user') {
      rendered.push(
        `<div class="msg-group" data-testid="message" data-role="user">` +
        `<div class="msg-header">` +
        `<div class="msg-avatar avatar-user">U</div>` +
        `<span class="msg-sender">${escapeHtml(t('user_name'))}</span>` +
        `</div>` +
        `<div class="msg-body" data-testid="message-body">${renderMarkdown(m.text || '')}</div>` +
        `</div>`
      );

      // Render dispatched subagent cards after the user prompt
      if (!subagentsInserted && subagents.length > 0) {
        subagentsInserted = true;
        for (const sa of subagents) {
          rendered.push(renderSubagentCardHtml(sa));
        }
      }
    } else if (m.role === 'tool') {
      rendered.push(renderToolRowHtml(m.tool));
    } else {
      const bodyHtml = renderMarkdown(m.text || '');
      const sender = assistantLabel(m);
      const chip = assistantChip(m);
      rendered.push(
        `<div class="msg-group" data-testid="message" data-role="assistant">` +
        `<div class="msg-header">` +
        `<div class="msg-avatar avatar-assistant">π</div>` +
        `<span class="msg-sender">${escapeHtml(sender)}</span>` +
        (chip ? `<span class="msg-chip">${escapeHtml(chip)}</span>` : '') +
        `</div>` +
        `<div class="msg-body" data-testid="message-body">${bodyHtml}</div>` +
        `</div>`
      );
    }
  }

  if (!subagentsInserted && subagents.length > 0) {
    for (const sa of subagents) {
      rendered.push(renderSubagentCardHtml(sa));
    }
  }

  thread.innerHTML = rendered.join('');
  thread.scrollTop = thread.scrollHeight;
}

export function renderToolRowHtml(tool) {
  if (!tool) return '';
  const toolName = tool.name || 'tool';
  const rawPath = tool.path || tool.input?.path || '';
  const displayPath = truncatePath(rawPath);
  const added = tool.added != null ? `+${tool.added}` : '';
  const removed = tool.removed != null ? `−${tool.removed}` : '';
  const isExpanded = state.expandedTools.has(tool.id);

  let prefixIcon = '✎';
  if (toolName === 'read') prefixIcon = '📖';
  else if (toolName === 'bash') prefixIcon = '$';
  else if (toolName === 'ls' || toolName === 'grep') prefixIcon = '🔍';

  const diffBadge =
    added || removed
      ? `<span class="tool-diff-badge"><span class="add" data-testid="tool-row-added">${escapeHtml(added)}</span> <span class="del" data-testid="tool-row-removed">${escapeHtml(removed)}</span></span>`
      : `<span class="tool-diff-badge"><span class="add" data-testid="tool-row-added"></span> <span class="del" data-testid="tool-row-removed"></span></span>`;

  return (
    `<div class="tool-row-wrapper">` +
    `<div class="tool-row" data-testid="tool-row" data-tool="${escapeHtml(toolName)}" data-path="${escapeHtml(rawPath)}" data-action="toggle-tool" data-tool-id="${escapeHtml(tool.id)}">` +
    `<div class="tool-main">` +
    `<span class="tool-prefix">${prefixIcon} ${escapeHtml(toolName)}</span>` +
    `<span class="tool-path" data-testid="tool-row-path">${escapeHtml(displayPath)}</span>` +
    diffBadge +
    `</div>` +
    `<div class="tool-meta"><span>${escapeHtml(tool.status || '')}</span></div>` +
    `<div class="tool-detail-card" data-testid="tool-row-detail" style="display:${isExpanded ? 'block' : 'none'}">` +
    `<div><strong>${escapeHtml(t('tool_path_label'))}:</strong> ${escapeHtml(rawPath)}</div>` +
    (tool.input ? `<div style="margin-top:4px;"><strong>${escapeHtml(t('tool_input'))}:</strong>\n${escapeHtml(JSON.stringify(tool.input, null, 2))}</div>` : '') +
    (tool.output ? `<div style="margin-top:4px;"><strong>${escapeHtml(t('tool_output'))}:</strong>\n${escapeHtml(typeof tool.output === 'string' ? tool.output : JSON.stringify(tool.output, null, 2))}</div>` : '') +
    `</div>` +
    `</div>` +
    `</div>`
  );
}

function assistantLabel(m) {
  const rid = m?.roleId || m?.agentId;
  if (rid) {
    const role = (state.roles || []).find((r) => r.id === rid);
    return localizeRoleLabel(role?.id || role?.name || rid);
  }
  return t('agent_name');
}

function assistantChip(m) {
  const rid = m?.roleId;
  const models = state.settings?.models || {};
  if (rid && models[rid]) return models[rid];
  if (rid && rid !== 'default') return localizeRoleLabel(rid);
  return '';
}

function pluginSourceLabel(src) {
  const s = String(src || '').toLowerCase();
  if (s === 'builtin' || s === 'built-in' || s === '内置') return t('plugin_source_builtin');
  if (s === 'community' || s === '社区') return t('plugin_source_community');
  if (s === 'local' || s === 'imported' || s === '本地导入' || s === '本地') return t('plugin_source_local');
  return src || t('plugin_source_local');
}

export function toggleToolDetail(id) {
  if (state.expandedTools.has(id)) state.expandedTools.delete(id);
  else state.expandedTools.add(id);
  renderChatThread();
}

function syncRightTabActive() {
  const tab = state.activeRightTab || 'diff';
  const nav = document.querySelector('#right-panel .tabs-nav');
  if (!nav) return;
  nav.querySelectorAll('.tab-btn[data-tab]').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-tab') === tab);
  });
}

export function renderRightPanel() {
  syncRightTabActive();
  const panel = document.getElementById('right-panel');
  if (!panel) return;

  const changesBar = document.getElementById('changed-files-bar');
  if (changesBar) {
    if (state.changes.length === 0) {
      changesBar.innerHTML = `<span style="font-size:11px;color:var(--text-muted);">${escapeHtml(t('no_changed_files'))}</span>`;
    } else {
      changesBar.innerHTML = state.changes
        .map((ch) => {
          const isActive = ch.path === state.activeFilePath;
          const display = truncatePath(ch.path, 30);
          return (
            `<span class="changed-file-pill ${isActive ? 'active' : ''}" data-testid="changed-file" data-path="${escapeHtml(ch.path)}" data-action="load-file">` +
            `<span>${escapeHtml(display)}</span>` +
            (ch.added != null ? `<span class="stat-add">+${escapeHtml(ch.added)}</span>` : '') +
            (ch.removed != null ? `<span class="stat-del">−${escapeHtml(ch.removed)}</span>` : '') +
            `</span>`
          );
        })
        .join('');
    }
  }

  const badge = document.getElementById('diff-tab-badge');
  if (badge) badge.textContent = state.changes.length || 0;

  const viewport = document.getElementById('right-viewport');
  if (!viewport) return;

  if (state.activeRightTab === 'editor' && state.activeFilePath) {
    viewport.innerHTML = `
      <div class="md-editor-container" data-testid="md-editor">
        <div class="md-editor-toolbar">
          <span style="font-family:var(--font-mono);font-size:12px;font-weight:500;">${escapeHtml(state.activeFilePath)}</span>
          <button class="btn btn-ctrl" data-testid="md-editor-save" data-action="save-editor-file">
            <svg class="icon" viewBox="0 0 24 24"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path><polyline points="17 21 17 13 7 13 7 21"></polyline><polyline points="7 3 7 8 15 8"></polyline></svg>
            ${escapeHtml(t('btn_save'))}
          </button>
        </div>
        <div class="md-editor-content" contenteditable="true" spellcheck="false">${escapeHtml(state.activeFileContent ?? '')}</div>
      </div>
    `;
  } else if (state.activeRightTab === 'file') {
    ensureWorkspaceTree();
    viewport.innerHTML = renderFileBrowserHtml();
  } else {
    if (!state.activeDiff) {
      const emptyKey = state.changes.length === 0 ? 'no_changes_yet' : 'select_file_for_diff';
      viewport.innerHTML = `
        <div class="diff-viewport" data-testid="diff-view">
          <div class="empty-placeholder">${escapeHtml(t(emptyKey))}</div>
        </div>
      `;
    } else {
      const d = state.activeDiff;
      const single = isAddedFileDiff(d.unified || '');
      viewport.innerHTML = `
        <div class="diff-viewport" data-testid="diff-view">
          <div class="diff-file-header">
            <div class="file-path-title">
              <svg class="file-path-icon icon" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>
              <span>${escapeHtml(d.path)}</span>
            </div>
            <div class="file-diff-stats">
              <span class="stat-add">+${escapeHtml(d.added ?? 0)}</span>
              <span class="stat-del">−${escapeHtml(d.removed ?? 0)}</span>
            </div>
          </div>
          <div class="diff-col-legend${single ? ' is-single' : ''}">
            ${single ? '' : `<div class="legend-side"><span>${escapeHtml(t('baseline'))}</span></div>`}
            <div class="legend-side"><span>${escapeHtml(t('working_copy'))}</span></div>
          </div>
          ${renderDiffHtml(d.unified || '')}
        </div>
      `;
    }
  }
}

function renderFileBrowserHtml() {
  const wid = state.activeWorkspaceId;
  const ready = state.workspaceTreeFor === wid;
  let treeHtml;
  if (!wid) {
    treeHtml = `<div class="file-tree-empty">${escapeHtml(t('file_tree_empty'))}</div>`;
  } else if (!ready) {
    treeHtml = `<div class="file-tree-empty">${escapeHtml(t('file_tree_loading'))}</div>`;
  } else if (!state.workspaceTree.length) {
    treeHtml = `<div class="file-tree-empty">${escapeHtml(t('file_tree_empty'))}</div>`;
  } else {
    treeHtml = state.workspaceTree.map((ent) => {
      const depth = String(ent.path || '').split('/').length - 1;
      const name = String(ent.path || '').split('/').pop();
      const pad = 8 + depth * 12;
      if (ent.type === 'dir') {
        return `<div class="file-tree-row is-dir" style="padding-left:${pad}px">${escapeHtml(name)}/</div>`;
      }
      const active = ent.path === state.activeFilePath ? ' active' : '';
      return `<button type="button" class="file-tree-row${active}" style="padding-left:${pad}px" data-testid="workspace-file" data-action="load-workspace-file" data-path="${escapeHtml(ent.path)}">${escapeHtml(name)}</button>`;
    }).join('');
  }

  let preview;
  if (state.activeFilePath && state.activeFileContent != null && !looksBinary(state.activeFileContent)) {
    const shown = state.activeFileContent.length > 200000
      ? `${state.activeFileContent.slice(0, 200000)}\n…`
      : state.activeFileContent;
    preview = `
      <div class="md-editor-toolbar">
        <span style="font-family:var(--font-mono);font-size:12px;">${escapeHtml(state.activeFilePath)}</span>
      </div>
      <pre class="file-view-content"><code>${escapeHtml(shown)}</code></pre>
    `;
  } else if (state.activeFilePath && looksBinary(state.activeFileContent)) {
    preview = `<div class="file-preview-empty">${escapeHtml(state.activeFilePath)} — ${escapeHtml(t('file_binary'))}</div>`;
  } else {
    preview = `<div class="file-preview-empty">${escapeHtml(t('select_file_to_preview'))}</div>`;
  }

  return `
    <div class="file-browser" data-testid="file-tree">
      <div class="file-tree">${treeHtml}</div>
      <div class="file-preview" data-testid="file-view">${preview}</div>
    </div>
  `;
}

function looksBinary(text) {
  if (text == null || text === '') return false;
  return text.slice(0, 1000).includes('\u0000');
}

export function openFileInEditor() {
  if (!state.activeFilePath) {
    if (state.changes.length > 0) state.activeFilePath = state.changes[0].path;
    else return;
  }
  const isMd = state.activeFilePath.endsWith('.md');
  state.activeRightTab = isMd ? 'editor' : 'file';
  localStorage.setItem('piwork_active_right_tab', state.activeRightTab);
  syncRightTabActive();
  loadFileOrDiff(state.activeFilePath);
}

export function switchRightTab(tab) {
  state.activeRightTab = tab;
  localStorage.setItem('piwork_active_right_tab', tab);
  syncRightTabActive();
  if (tab === 'file') {
    ensureWorkspaceTree();
    if (state.activeFilePath) loadFileOrDiff(state.activeFilePath);
    else renderRightPanel();
    return;
  }
  if (state.activeFilePath) {
    loadFileOrDiff(state.activeFilePath);
  } else {
    renderRightPanel();
  }
}

// ============================================================================
// Settings Modal
// ============================================================================
export function openSettings(tab = 'general') {
  state.activeSettingsTab = tab;
  renderSettingsModal();
}

export function closeSettings() {
  const ov = document.getElementById('settings-overlay');
  if (ov) ov.style.display = 'none';
}

export function renderSettingsModal() {
  let ov = document.getElementById('settings-overlay');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'settings-overlay';
    ov.className = 'sm-ov';
    document.body.appendChild(ov);
  }
  ov.style.display = 'flex';

  const tTab = state.activeSettingsTab;

  ov.innerHTML = `
    <div class="sm">
      <div class="sm-nav">
        <h3>${escapeHtml(t('settings_title'))}</h3>
        <div class="${tTab === 'general' ? 'on' : ''}" data-action="set-settings-tab" data-tab="general">${escapeHtml(t('settings_tab_general'))}</div>
        <div class="${tTab === 'models' ? 'on' : ''}" data-action="set-settings-tab" data-tab="models">${escapeHtml(t('settings_tab_models'))}</div>
        <div class="${tTab === 'plugins' ? 'on' : ''}" data-action="set-settings-tab" data-tab="plugins">${escapeHtml(t('settings_tab_plugins'))}</div>
        <div class="${tTab === 'skills' ? 'on' : ''}" data-action="set-settings-tab" data-tab="skills">${escapeHtml(t('settings_tab_skills'))}</div>
        <div class="${tTab === 'about' ? 'on' : ''}" data-action="set-settings-tab" data-tab="about">${escapeHtml(t('settings_tab_about'))}</div>
      </div>
      <div class="sm-body">
        <span class="sm-x" data-action="close-settings">×</span>
        ${renderSettingsTabContent(tTab)}
      </div>
    </div>
  `;
}

function renderSettingsTabContent(tab) {
  if (tab === 'general') {
    const curLang = getLocale();
    const curApp = state.appearance;
    const curTheme = state.theme;
    const curFont = state.fontSize;

    return `
      <h2>${escapeHtml(t('settings_tab_general'))}</h2>
      <div class="row">
        <div class="l"><b>${escapeHtml(t('lang_label'))}</b><span>${escapeHtml(t('lang_desc'))}</span></div>
        <div class="seg">
          <span class="${curLang === 'zh' ? 'on' : ''}" data-action="switch-language" data-lang="zh">中文</span>
          <span class="${curLang === 'en' ? 'on' : ''}" data-action="switch-language" data-lang="en">English</span>
        </div>
      </div>
      <div class="row">
        <div class="l"><b>${escapeHtml(t('appearance_label'))}</b><span>${escapeHtml(t('appearance_desc'))}</span></div>
        <div class="seg">
          <span class="${curApp === 'light' ? 'on' : ''}" data-action="switch-appearance" data-mode="light">${escapeHtml(t('mode_light'))}</span>
          <span class="${curApp === 'dark' ? 'on' : ''}" data-action="switch-appearance" data-mode="dark">${escapeHtml(t('mode_dark'))}</span>
          <span class="${curApp === 'system' ? 'on' : ''}" data-action="switch-appearance" data-mode="system">${escapeHtml(t('mode_system'))}</span>
        </div>
      </div>
      <div class="row" style="display:block">
        <div class="l"><b>${escapeHtml(t('theme_label'))}</b><span>${escapeHtml(t('theme_desc'))}</span></div>
        <div class="th">
          <div class="${curTheme === 'white' ? 'on' : ''}" data-action="switch-theme-family" data-family="white">
            <i><b style="background:#fafafa"></b><b style="background:#ffffff;flex:3"></b><b style="background:#1a1a1a;flex:.3"></b></i>White
          </div>
          <div class="${curTheme === 'claude' ? 'on' : ''}" data-action="switch-theme-family" data-family="claude">
            <i><b style="background:#f3f1ea"></b><b style="background:#faf9f5;flex:3"></b><b style="background:#c0674a;flex:.3"></b></i>Claude
          </div>
          <div class="${curTheme === 'codex' ? 'on' : ''}" data-action="switch-theme-family" data-family="codex">
            <i><b style="background:#f9f9f9"></b><b style="background:#ffffff;flex:3"></b><b style="background:#0d0d0d;flex:.3"></b></i>Codex
          </div>
          <div class="${curTheme === 'grok' ? 'on' : ''}" data-action="switch-theme-family" data-family="grok">
            <i><b style="background:#0a0a0a"></b><b style="background:#000000;flex:3"></b><b style="background:#ffffff;flex:.3"></b></i>Grok
          </div>
          <div class="${curTheme === 'cursor' ? 'on' : ''}" data-action="switch-theme-family" data-family="cursor">
            <i><b style="background:#141414"></b><b style="background:#181818;flex:3"></b><b style="background:#cfcfcf;flex:.3"></b></i>Cursor
          </div>
        </div>
      </div>
      <div class="row">
        <div class="l"><b>${escapeHtml(t('font_size_label'))}</b><span>${escapeHtml(t('font_size_desc'))}</span></div>
        <div class="seg">
          <span class="${curFont === 'sm' ? 'on' : ''}" data-action="switch-font-size" data-size="sm">${escapeHtml(t('size_sm'))}</span>
          <span class="${curFont === 'md' ? 'on' : ''}" data-action="switch-font-size" data-size="md">${escapeHtml(t('size_md'))}</span>
          <span class="${curFont === 'lg' ? 'on' : ''}" data-action="switch-font-size" data-size="lg">${escapeHtml(t('size_lg'))}</span>
        </div>
      </div>
    `;
  }

  if (tab === 'models') {
    const s = state.settings || {};
    const prov = s.provider || 'openai';
    const preset = providerPreset(prov);
    const models = s.models || {};
    const maskedKey = s.apiKey || '';

    const rolesList = state.roles || [];

    return `
      <h2>${escapeHtml(t('settings_tab_models'))}</h2>
      <div class="prov">
        <span class="${prov === 'xai' ? 'on' : ''}" data-action="set-model-provider" data-provider="xai">xAI</span>
        <span class="${prov === 'deepseek' ? 'on' : ''}" data-action="set-model-provider" data-provider="deepseek">DeepSeek</span>
        <span class="${prov === 'openai' ? 'on' : ''}" data-action="set-model-provider" data-provider="openai">${escapeHtml(t('provider_openai'))}</span>
        <span class="${prov === 'ollama' ? 'on' : ''}" data-action="set-model-provider" data-provider="ollama">${escapeHtml(t('provider_ollama'))}</span>
      </div>
      <div class="row">
        <div class="l"><b>${escapeHtml(t('models_base_url_label'))}</b><span>${escapeHtml(t('models_base_url_desc'))}</span></div>
        <input class="in" id="cfg-base-url" type="text" data-original-val="${escapeHtml(s.baseUrl || '')}" value="${escapeHtml(s.baseUrl || '')}" placeholder="${escapeHtml(preset.baseUrl)}" />
      </div>
      <div class="row">
        <div class="l"><b>${escapeHtml(t('models_api_key_label'))}</b><span>${escapeHtml(t('models_api_key_desc'))}</span></div>
        <input class="in" id="cfg-api-key" type="text" data-original-masked="${escapeHtml(maskedKey)}" value="${escapeHtml(maskedKey)}" placeholder="${escapeHtml(t('models_api_key_placeholder'))}" autocomplete="off" />
      </div>
      <div id="cfg-key-warning" class="cfg-warn-box" style="display:none;">
        ${escapeHtml(t('models_key_safety_warn'))}
      </div>
      ${rolesList
        .map(
          (r) =>
            `<div class="row">` +
            `<div class="l"><b>${escapeHtml(localizeRoleLabel(r.id || r.name))}</b><span>${escapeHtml(r.id)}</span></div>` +
            `<input class="in" style="min-width:180px" data-role-id="${escapeHtml(r.id)}" value="${escapeHtml(models[r.id] || '')}" placeholder="${escapeHtml(t('model_placeholder_eg', { model: preset.modelHint }))}" />` +
            `</div>`
        )
        .join('')}
      <div style="margin-top:20px;display:flex;justify-content:flex-end;">
        <button class="btn p" data-action="save-models-settings">${escapeHtml(t('btn_save_settings'))}</button>
      </div>
    `;
  }

  if (tab === 'plugins') {
    return `
      <h2>${escapeHtml(t('settings_tab_plugins'))}</h2>
      <div style="display:flex;gap:10px;margin-bottom:18px">
        <div style="flex:1;display:flex;align-items:center;gap:8px;border:1px solid var(--border-strong);border-radius:8px;padding:9px 12px;font-size:13px;color:var(--text-muted);background:var(--bg-surface)">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
          <input type="text" id="plugin-search-input" placeholder="${escapeHtml(t('search_plugins_placeholder'))}" style="border:none;background:transparent;outline:none;width:100%;color:var(--text-primary);font-size:13px;" />
        </div>
        <button class="btn p" data-action="open-import-plugin" style="padding:0 14px;border-radius:8px">${escapeHtml(t('btn_import_plugin'))}</button>
      </div>
      <div id="plugins-grid" style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px">
        ${renderPluginsListHtml(state.plugins)}
      </div>
    `;
  }

  if (tab === 'skills') {
    return `
      <h2>${escapeHtml(t('settings_tab_skills'))}</h2>
      <div style="display:flex;gap:10px;margin-bottom:18px">
        <div style="flex:1;display:flex;align-items:center;gap:8px;border:1px solid var(--border-strong);border-radius:8px;padding:9px 12px;font-size:13px;color:var(--text-muted);background:var(--bg-surface)">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
          <input type="text" id="skill-search-input" placeholder="${escapeHtml(t('search_skills_placeholder'))}" style="border:none;background:transparent;outline:none;width:100%;color:var(--text-primary);font-size:13px;" />
        </div>
      </div>
      <div id="skills-grid" style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px">
        ${renderSkillsListHtml(state.skills)}
      </div>
    `;
  }

  if (tab === 'about') {
    const pkg = state.about || {};
    return `
      <h2>${escapeHtml(t('settings_tab_about'))}</h2>
      <div style="display:flex;align-items:center;gap:14px;margin-bottom:14px">
        <div style="width:44px;height:44px;border-radius:10px;background:var(--text-primary);color:var(--text-inverse);display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:700">π</div>
        <div>
          <b style="font-size:15px">${escapeHtml(pkg.name || 'pi-work')}</b>
          <div style="color:var(--text-muted);font-size:12px">${escapeHtml(t('about_desc'))}</div>
        </div>
      </div>
      <div class="row"><div class="l"><b>${escapeHtml(t('about_version'))}</b></div><span>${escapeHtml(pkg.version || '0.2.0')}</span></div>
      <div class="row"><div class="l"><b>${escapeHtml(t('about_repo'))}</b></div><a href="https://github.com/lawrencewzen/pi-work" target="_blank" rel="noopener">github.com/lawrencewzen/pi-work</a></div>
      <div class="row"><div class="l"><b>${escapeHtml(t('about_license'))}</b></div><span>MIT</span></div>
      <div class="row"><div class="l"><b>${escapeHtml(t('about_thanks'))}</b><span>${escapeHtml(t('about_upstream'))}</span></div><a href="https://github.com/xiaomoBoy/pi-durable-assistant" target="_blank" rel="noopener">xiaomoBoy/pi-durable-assistant</a></div>
      <div class="row"><div class="l"><b>${escapeHtml(t('about_runtime'))}</b></div><span><span class="dot"></span>${escapeHtml(t('about_runtime_connected'))}</span></div>
    `;
  }

  return '';
}

function renderCatalogEmpty(kind, searching) {
  const titleKey = searching
    ? (kind === 'plugins' ? 'empty_search_plugins' : 'empty_search_skills')
    : (kind === 'plugins' ? 'empty_plugins' : 'empty_skills');
  const hintKey = kind === 'plugins' ? 'empty_plugins_hint' : 'empty_skills_hint';
  const icon = kind === 'plugins' ? '🔌' : '✦';
  return (
    `<div class="catalog-empty">` +
    `<div class="catalog-empty-icon">${icon}</div>` +
    `<div class="catalog-empty-title">${escapeHtml(t(titleKey))}</div>` +
    (searching ? '' : `<div class="catalog-empty-hint">${escapeHtml(t(hintKey))}</div>`) +
    `</div>`
  );
}

function renderPluginsListHtml(list, searching = false) {
  if (!list || list.length === 0) {
    return renderCatalogEmpty('plugins', searching && (state.plugins || []).length > 0);
  }

  return list
    .map((pl) => {
      const letter = (pl.name || pl.id || 'P').slice(0, 1).toUpperCase();
      const isOn = pl.enabled !== false;
      return (
        `<div style="border:1px solid var(--border-subtle);border-radius:10px;padding:14px;display:flex;flex-direction:column;gap:10px;background:var(--bg-surface)">` +
        `<div style="display:flex;align-items:center;gap:10px">` +
        `<div style="width:30px;height:30px;border-radius:8px;background:var(--bg-surface-subtle);border:1px solid var(--border-subtle);display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:600;color:var(--text-secondary)">${escapeHtml(letter)}</div>` +
        `<b style="font-size:13px;font-weight:500;flex:1">${escapeHtml(pl.name || pl.id)}</b>` +
        `<div class="tg ${isOn ? 'on' : ''}" data-action="toggle-plugin" data-plugin-id="${escapeHtml(pl.id)}" data-enabled="${!isOn}"></div>` +
        `</div>` +
        `<div style="font-size:12px;color:var(--text-secondary);line-height:1.5;min-height:36px">${escapeHtml(pl.description || '')}</div>` +
        `<div style="font-size:11px;color:var(--text-muted);display:flex;gap:8px"><span>${escapeHtml(pluginSourceLabel(pl.source))}</span>${pl.version ? `<span>·</span><span>${escapeHtml(pl.version)}</span>` : ''}</div>` +
        `</div>`
      );
    })
    .join('');
}

function renderSkillsListHtml(list, searching = false) {
  if (!list || list.length === 0) {
    return renderCatalogEmpty('skills', searching && (state.skills || []).length > 0);
  }

  return list
    .map((sk) => {
      const letter = (sk.name || sk.id || 'S').slice(0, 1).toUpperCase();
      return (
        `<div style="border:1px solid var(--border-subtle);border-radius:10px;padding:14px;display:flex;flex-direction:column;gap:10px;background:var(--bg-surface)">` +
        `<div style="display:flex;align-items:center;gap:10px">` +
        `<div style="width:30px;height:30px;border-radius:8px;background:var(--bg-surface-subtle);border:1px solid var(--border-subtle);display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:600;color:var(--text-secondary)">${escapeHtml(letter)}</div>` +
        `<b style="font-size:13px;font-weight:500;flex:1">${escapeHtml(sk.name || sk.id)}</b>` +
        `</div>` +
        `<div style="font-size:12px;color:var(--text-secondary);line-height:1.5;min-height:36px">${escapeHtml(sk.description || '')}</div>` +
        `<div style="font-size:11px;color:var(--text-muted);display:flex;gap:8px"><span>${escapeHtml(pluginSourceLabel(sk.source))}</span>${sk.version ? `<span>·</span><span>${escapeHtml(sk.version)}</span>` : ''}</div>` +
        `</div>`
      );
    })
    .join('');
}

export function setSettingsTab(tab) {
  state.activeSettingsTab = tab;
  renderSettingsModal();
}

function applyChromeLabels() {
  document.title = 'pi-work';
  applyI18n();
}

export function rerenderI18nSurfaces() {
  applyI18n();
  renderSidebarWorkspaces();
  renderConversations();
  renderRunningOverview();
  renderStatusBar();
  renderChatThread();
  renderRightPanel();
  const settingsOv = document.getElementById('settings-overlay');
  if (settingsOv && settingsOv.style.display !== 'none') {
    renderSettingsModal();
  }
  const authOv = document.getElementById('auth-overlay');
  if (authOv && authOv.style.display !== 'none' && state.unauthorized) {
    handleUnauthorized();
  }
}

export async function switchLanguage(lang) {
  setLocale(lang);
  applyChromeLabels();
  try { await api('/api/settings', 'PUT', { language: lang }); } catch { /* ignore */ }
  rerenderI18nSurfaces();
}

export async function switchAppearance(mode) {
  applyTheme(state.theme, mode);
  try { await api('/api/settings', 'PUT', { appearance: mode }); } catch { /* ignore */ }
  renderSettingsModal();
}

export async function switchThemeFamily(family) {
  applyTheme(family, state.appearance);
  try { await api('/api/settings', 'PUT', { theme: family }); } catch { /* ignore */ }
  renderSettingsModal();
}

export function switchFontSize(sz) {
  state.fontSize = sz;
  localStorage.setItem('piwork_font_size', sz);
  document.documentElement.setAttribute('data-font-size', sz);
  renderSettingsModal();
}

function rememberSavedSettings(s) {
  const src = s || {};
  state._savedSettings = {
    provider: src.provider || 'openai',
    baseUrl: src.baseUrl || '',
    apiKey: src.apiKey || '',
    hasApiKey: Boolean(src.hasApiKey || src.apiKey),
  };
}

export function setModelProvider(prov) {
  if (!state.settings) state.settings = {};
  const roleInputs = document.querySelectorAll('[data-role-id]');
  if (!state.settings.models || typeof state.settings.models !== 'object') state.settings.models = {};
  roleInputs.forEach((inp) => {
    const rid = inp.getAttribute('data-role-id');
    if (rid) state.settings.models[rid] = inp.value.trim();
  });
  state.settings.provider = prov;
  state.settings.baseUrl = providerPreset(prov).baseUrl;
  renderSettingsModal();
  checkModelKeyWarning();
  const hasSavedKey = Boolean(state._savedSettings?.hasApiKey);
  if (!hasSavedKey) {
    api('/api/settings', 'PUT', { provider: prov, baseUrl: state.settings.baseUrl })
      .then((savedResp) => {
        if ((state.settings.provider || '') !== prov) return;
        state.settings.provider = savedResp.provider || prov;
        state.settings.baseUrl = savedResp.baseUrl || state.settings.baseUrl;
        state.settings.apiKey = savedResp.apiKey || '';
        state.settings.hasApiKey = Boolean(savedResp.hasApiKey);
        rememberSavedSettings(state.settings);
        checkModelKeyWarning();
      })
      .catch(() => { /* draft stays; Save still persists it */ });
  }
}

export function checkModelKeyWarning() {
  const warnEl = document.getElementById('cfg-key-warning');
  if (!warnEl) return;
  const baseUrlEl = document.getElementById('cfg-base-url');
  const apiKeyEl = document.getElementById('cfg-api-key');
  if (!baseUrlEl || !apiKeyEl) return;

  const saved = state._savedSettings || {};
  const hasSavedKey = Boolean(saved.hasApiKey || saved.apiKey);
  const origProvider = saved.provider || 'openai';
  const curProvider = state.settings.provider || 'openai';
  const origBaseUrl = saved.baseUrl || '';
  const curBaseUrl = baseUrlEl.value.trim();

  const enteredKey = apiKeyEl.value.trim();
  const maskedKey = apiKeyEl.getAttribute('data-original-masked') || '';
  const isNewKeyEntered = enteredKey && enteredKey !== maskedKey && !enteredKey.startsWith('••••');

  const changed = (origProvider !== curProvider) || (origBaseUrl !== curBaseUrl);
  if (hasSavedKey && changed && !isNewKeyEntered) {
    warnEl.style.display = 'block';
  } else {
    warnEl.style.display = 'none';
  }
}

export async function saveModelsSettings() {
  const baseUrlEl = document.getElementById('cfg-base-url');
  const apiKeyEl = document.getElementById('cfg-api-key');
  const roleInputs = document.querySelectorAll('[data-role-id]');

  const saved = state._savedSettings || {};
  const hasSavedKey = Boolean(saved.hasApiKey || saved.apiKey);
  const origProvider = saved.provider || 'openai';
  const curProvider = state.settings.provider || 'openai';
  const origBaseUrl = saved.baseUrl || '';
  const curBaseUrl = baseUrlEl?.value.trim() || '';

  const enteredKey = apiKeyEl?.value.trim() || '';
  const maskedKey = apiKeyEl?.getAttribute('data-original-masked') || '';
  const isNewKeyEntered = enteredKey && enteredKey !== maskedKey && !enteredKey.startsWith('••••') && !enteredKey.includes('…');

  const providerOrUrlChanged = (origProvider !== curProvider) || (origBaseUrl !== curBaseUrl);

  const models = {};
  roleInputs.forEach((inp) => {
    const rid = inp.getAttribute('data-role-id');
    const val = inp.value.trim();
    if (val && rid) models[rid] = val;
  });

  const payload = {
    provider: curProvider,
    baseUrl: curBaseUrl,
    models,
  };

  if (hasSavedKey && providerOrUrlChanged && !isNewKeyEntered) {
    const warnMsg = t('models_key_safety_confirm');
    if (!window.confirm(warnMsg)) {
      return;
    }
    payload.apiKey = '';
  } else if (isNewKeyEntered) {
    payload.apiKey = enteredKey;
  }

  try {
    state.settings = await api('/api/settings', 'PUT', payload);
    rememberSavedSettings(state.settings);
    showToast(t('msg_settings_saved'));
    renderSettingsModal();
  } catch (err) {
    showToast(err.message || t('err_save'));
  }
}

export async function togglePlugin(id, enabled) {
  try {
    await api(`/api/plugins/${encodeURIComponent(id)}`, 'PUT', { enabled });
    const p = state.plugins.find((item) => item.id === id);
    if (p) p.enabled = enabled;
    renderSettingsModal();
  } catch (err) {
    showToast(err.message || t('err_plugin_update'));
  }
}

export function filterPlugins(q) {
  const grid = document.getElementById('plugins-grid');
  if (!grid) return;
  const filtered = state.plugins.filter((p) =>
    (p.name || p.id).toLowerCase().includes(q.toLowerCase()) ||
    (p.description || '').toLowerCase().includes(q.toLowerCase())
  );
  grid.innerHTML = renderPluginsListHtml(filtered, Boolean(q && q.trim()));
}

export function filterSkills(q) {
  const grid = document.getElementById('skills-grid');
  if (!grid) return;
  const filtered = state.skills.filter((s) =>
    (s.name || s.id).toLowerCase().includes(q.toLowerCase()) ||
    (s.description || '').toLowerCase().includes(q.toLowerCase())
  );
  grid.innerHTML = renderSkillsListHtml(filtered, Boolean(q && q.trim()));
}

// Modal dialog helpers
export function openModal(html) {
  let ov = document.getElementById('dialog-overlay');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'dialog-overlay';
    ov.className = 'modal-overlay';
    document.body.appendChild(ov);
  }
  ov.style.display = 'flex';
  ov.innerHTML = html;
}

export function closeModal() {
  const ov = document.getElementById('dialog-overlay');
  if (ov) ov.style.display = 'none';
}

function isSupportedGitUrl(url) {
  const s = String(url || '').trim();
  if (/^https:\/\//i.test(s)) return true;
  if (/^ssh:\/\//i.test(s)) return true;
  if (/^git@[^\s:]+:\S+$/.test(s)) return true;
  return false;
}

function friendlyWorkspaceError(err) {
  const raw = String(err?.message || '');
  if (/invalid gitUrl/i.test(raw)) return t('ws_err_git_url');
  if (/invalid branch/i.test(raw)) return t('ws_err_branch');
  if (/clone failed/i.test(raw)) return t('ws_err_clone');
  if (/name required/i.test(raw)) return t('ws_name_required');
  const root = err?.body?.allowedRoot || state.allowedWorkspaceRoot || '';
  if (/not under an allowed workspace root|path is not allowed|path is forbidden/i.test(raw)) {
    return root ? t('ws_err_path_root', { root }) : t('ws_err_path');
  }
  if (/^path\b/i.test(raw) || /path is /i.test(raw)) return t('ws_err_path');
  return t('ws_err_generic');
}

function showWorkspaceModalError(message) {
  const el = document.getElementById('ws-modal-error');
  if (!el) {
    showToast(message);
    return;
  }
  el.textContent = message;
  el.classList.add('is-visible');
}

function clearWorkspaceModalError() {
  const el = document.getElementById('ws-modal-error');
  if (!el) return;
  el.textContent = '';
  el.classList.remove('is-visible');
}

function setWorkspaceSubmitBusy(busy) {
  const btn = document.querySelector('[data-testid="workspace-create-submit"]');
  if (!btn) return;
  if (busy) {
    if (!btn.dataset.idleLabel) btn.dataset.idleLabel = (btn.textContent || '').trim();
    btn.disabled = true;
    btn.classList.add('is-busy');
    btn.setAttribute('aria-busy', 'true');
    btn.textContent = wsModalMode === 'git' ? t('ws_cloning') : t('ws_creating');
  } else {
    btn.disabled = false;
    btn.classList.remove('is-busy');
    btn.removeAttribute('aria-busy');
    btn.textContent = btn.dataset.idleLabel || t('btn_create');
  }
}

export async function openNewConversationModal() {
  if (!state.activeWorkspaceId) {
    showToast(t('err_select_workspace'));
    return;
  }
  try { state.roles = await api('/api/roles'); } catch { /* keep existing */ }
  try { state.pipelines = await api('/api/pipelines'); } catch { /* keep existing */ }

  const roleOpts = (state.roles || [])
    .map((r) => `<option value="role:${escapeHtml(r.id)}">${escapeHtml(localizeRoleLabel(r.id || r.name))}</option>`)
    .join('');
  const pipeOpts = (state.pipelines || [])
    .map((p) => `<option value="pipeline:${escapeHtml(p.id)}">${escapeHtml(p.name || p.id)}</option>`)
    .join('');

  openModal(`
    <div class="modal-dialog">
      <h3>${escapeHtml(t('new_conversation'))} <span style="cursor:pointer;color:var(--text-muted)" data-action="close-modal">×</span></h3>
      <div class="form-group">
        <label>${escapeHtml(t('conv_title_label'))}</label>
        <input id="conv-title-input" data-testid="conversation-title-input" placeholder="${escapeHtml(t('conv_title_placeholder'))}" />
      </div>
      <div class="form-group">
        <label>${escapeHtml(t('conv_role_pipeline_label'))}</label>
        <select id="conv-role-pipeline">
          <option value="">${escapeHtml(t('conv_default_agent'))}</option>
          ${roleOpts ? `<optgroup label="${escapeHtml(t('conv_roles_group'))}">${roleOpts}</optgroup>` : ''}
          ${pipeOpts ? `<optgroup label="${escapeHtml(t('conv_pipelines_group'))}">${pipeOpts}</optgroup>` : ''}
        </select>
      </div>
      <div class="modal-actions">
        <button class="btn" data-action="close-modal">${escapeHtml(t('btn_cancel'))}</button>
        <button class="btn p" data-testid="conversation-create-submit" data-action="submit-conversation">${escapeHtml(t('btn_create'))}</button>
      </div>
    </div>
  `);
  document.getElementById('conv-title-input')?.focus();
}

export async function submitNewConversation() {
  if (!state.activeWorkspaceId) {
    showToast(t('err_select_workspace'));
    return;
  }
  const title = document.getElementById('conv-title-input')?.value.trim() || '';
  const picked = document.getElementById('conv-role-pipeline')?.value || '';
  const opts = {};
  if (title) opts.title = title;
  if (picked.startsWith('role:')) opts.roleId = picked.slice(5);
  else if (picked.startsWith('pipeline:')) opts.pipelineId = picked.slice(9);
  const conv = await createNewConversation(opts);
  if (conv) closeModal();
}

export function openNewWorkspaceModal() {
  if (!wsCreating) wsModalMode = 'local';
  openModal(`
    <div class="modal-dialog">
      <h3>${escapeHtml(t('new_workspace'))} <span style="cursor:pointer;color:var(--text-muted)" data-action="close-modal">×</span></h3>
      <div class="seg seg-split" style="margin-bottom:8px">
        <span id="ws-modal-tab-local" class="on" data-action="toggle-ws-modal-tab" data-tab="local">${escapeHtml(t('ws_local_tab'))}</span>
        <span id="ws-modal-tab-git" data-action="toggle-ws-modal-tab" data-tab="git">${escapeHtml(t('ws_git_tab'))}</span>
      </div>
      <div class="form-group">
        <label>${escapeHtml(t('ws_name_label'))}</label>
        <input id="ws-name-input" data-testid="workspace-name-input" placeholder="${escapeHtml(t('ws_name_placeholder'))}" />
      </div>
      <div id="ws-local-fields" class="form-group">
        <label>${escapeHtml(t('ws_path_label'))}</label>
        <input id="ws-path-input" data-testid="workspace-path-input" placeholder="${escapeHtml(t('ws_path_placeholder'))}" />
        <div id="ws-path-hint" class="form-hint">${state.allowedWorkspaceRoot ? escapeHtml(t('ws_path_hint', { root: state.allowedWorkspaceRoot })) : ''}</div>
      </div>
      <div id="ws-git-fields" class="form-group" style="display:none">
        <label>${escapeHtml(t('ws_git_url_label'))}</label>
        <input id="ws-git-url-input" placeholder="${escapeHtml(t('ws_git_url_placeholder'))}" />
        <label style="margin-top:6px;">${escapeHtml(t('ws_branch_label'))}</label>
        <input id="ws-branch-input" placeholder="${escapeHtml(t('ws_branch_placeholder'))}" />
      </div>
      <div id="ws-modal-error" class="modal-inline-error" role="alert"></div>
      <div class="modal-actions">
        <button class="btn" data-action="close-modal">${escapeHtml(t('btn_cancel'))}</button>
        <button class="btn p" data-testid="workspace-create-submit" data-action="submit-workspace">${escapeHtml(t('btn_create'))}</button>
      </div>
    </div>
  `);
  if (wsCreating) setWorkspaceSubmitBusy(true);
  if (!state.allowedWorkspaceRoot) {
    api('/api/workspace-root').then((info) => {
      state.allowedWorkspaceRoot = info?.root || '';
      const hint = document.getElementById('ws-path-hint');
      if (hint && state.allowedWorkspaceRoot) {
        hint.textContent = t('ws_path_hint', { root: state.allowedWorkspaceRoot });
      }
    }).catch(() => {});
  }
}

let wsModalMode = 'local';
let wsCreating = false;
export function toggleWsModalTab(mode) {
  if (wsCreating) return;
  wsModalMode = mode;
  clearWorkspaceModalError();
  const tabLoc = document.getElementById('ws-modal-tab-local');
  const tabGit = document.getElementById('ws-modal-tab-git');
  const locFields = document.getElementById('ws-local-fields');
  const gitFields = document.getElementById('ws-git-fields');

  if (mode === 'local') {
    tabLoc?.classList.add('on');
    tabGit?.classList.remove('on');
    if (locFields) locFields.style.display = 'flex';
    if (gitFields) gitFields.style.display = 'none';
  } else {
    tabLoc?.classList.remove('on');
    tabGit?.classList.add('on');
    if (locFields) locFields.style.display = 'none';
    if (gitFields) gitFields.style.display = 'flex';
  }
}

export async function submitWorkspaceModal() {
  if (wsCreating) return;
  clearWorkspaceModalError();
  const name = document.getElementById('ws-name-input')?.value.trim();
  if (!name) {
    showWorkspaceModalError(t('ws_name_required'));
    return;
  }

  let payload;
  if (wsModalMode === 'git') {
    const gitUrl = document.getElementById('ws-git-url-input')?.value.trim();
    const branch = document.getElementById('ws-branch-input')?.value.trim();
    if (!gitUrl) {
      showWorkspaceModalError(t('ws_git_required'));
      return;
    }
    if (!isSupportedGitUrl(gitUrl)) {
      showWorkspaceModalError(t('ws_err_git_url'));
      return;
    }
    payload = { name, gitUrl, branch };
  } else {
    const path = document.getElementById('ws-path-input')?.value.trim();
    if (!path) {
      showWorkspaceModalError(t('ws_path_required'));
      return;
    }
    payload = { name, path };
  }

  wsCreating = true;
  setWorkspaceSubmitBusy(true);
  try {
    await createNewWorkspace(payload);
  } catch (err) {
    showWorkspaceModalError(friendlyWorkspaceError(err));
  } finally {
    wsCreating = false;
    setWorkspaceSubmitBusy(false);
  }
}

export function openImportPluginModal() {
  openModal(`
    <div class="modal-dialog">
      <h3>${escapeHtml(t('plugin_import_title'))} <span style="cursor:pointer;color:var(--text-muted)" data-action="close-modal">×</span></h3>
      <div class="form-group">
        <label>${escapeHtml(t('plugin_id_label'))}</label>
        <input id="plug-id-input" placeholder="my-custom-plugin" />
      </div>
      <div class="form-group">
        <label>${escapeHtml(t('plugin_desc_label'))}</label>
        <input id="plug-desc-input" placeholder="Plugin functionality" />
      </div>
      <div class="form-group">
        <label>${escapeHtml(t('plugin_ver_label'))}</label>
        <input id="plug-ver-input" value="1.0.0" />
      </div>
      <div class="modal-actions">
        <button class="btn" data-action="close-modal">${escapeHtml(t('btn_cancel'))}</button>
        <button class="btn p" data-action="submit-import-plugin">${escapeHtml(t('btn_import_plugin'))}</button>
      </div>
    </div>
  `);
}

export async function submitImportPlugin() {
  const name = document.getElementById('plug-id-input')?.value.trim();
  const desc = document.getElementById('plug-desc-input')?.value.trim();
  const ver = document.getElementById('plug-ver-input')?.value.trim();
  if (!name) return;
  try {
    const pl = await api('/api/plugins', 'POST', { name, description: desc, version: ver });
    showToast(`Plugin ${pl.name} imported`);
    closeModal();
    state.plugins = await api('/api/plugins');
    renderSettingsModal();
  } catch (err) {
    showToast(err.message || 'Import failed');
  }
}

export async function switchWorkspaceAndConv(wid, cid) {
  if (state.activeWorkspaceId !== wid) {
    await selectWorkspace(wid);
  }
  if (state.activeConversationId !== cid) {
    await selectConversation(cid);
  }
}

// Global exposure for external or test compatibility
window.__app = {
  selectWorkspace,
  selectConversation,
  switchWorkspaceAndConv,
  sendMessage,
  pauseConversation,
  resumeConversation,
  stopConversation,
  createNewWorkspace,
  createNewConversation,
  loadFileOrDiff,
  saveEditorFile,
  openFileInEditor,
  switchRightTab,
  openSettings,
  closeSettings,
  setSettingsTab,
  switchLanguage,
  switchAppearance,
  switchThemeFamily,
  switchFontSize,
  setModelProvider,
  saveModelsSettings,
  togglePlugin,
  filterPlugins,
  filterSkills,
  openNewConversationModal,
  submitNewConversation,
  openNewWorkspaceModal,
  toggleWsModalTab,
  submitWorkspaceModal,
  openImportPluginModal,
  submitImportPlugin,
  closeModal,
  toggleToolDetail,
  toggleSubagent,
  handleUnauthorized,
  checkModelKeyWarning,
};

// ============================================================================
// Event Delegation
// ============================================================================
document.addEventListener('click', (e) => {
  if (e.target.id === 'settings-overlay') {
    closeSettings();
    return;
  }
  if (e.target.id === 'dialog-overlay') {
    closeModal();
    return;
  }

  const actionEl = e.target.closest('[data-action]');
  if (!actionEl) return;

  const action = actionEl.getAttribute('data-action');
  switch (action) {
    case 'new-workspace':
      openNewWorkspaceModal();
      break;
    case 'new-conversation':
      openNewConversationModal();
      break;
    case 'submit-conversation':
      submitNewConversation();
      break;
    case 'open-settings':
      openSettings();
      break;
    case 'close-settings':
      closeSettings();
      break;
    case 'set-settings-tab':
      setSettingsTab(actionEl.getAttribute('data-tab'));
      break;
    case 'pause-conversation':
      pauseConversation();
      break;
    case 'resume-conversation':
      resumeConversation();
      break;
    case 'stop-conversation':
      stopConversation();
      break;
    case 'send-message': {
      const composer = document.querySelector('[data-testid="chat-input"]');
      if (composer) {
        const val = composer.value.trim();
        if (val) {
          sendMessage(val);
          composer.value = '';
        }
      }
      break;
    }
    case 'switch-right-tab':
      switchRightTab(actionEl.getAttribute('data-tab'));
      break;
    case 'open-file-in-editor':
      openFileInEditor();
      break;
    case 'select-workspace':
      selectWorkspace(actionEl.getAttribute('data-ws-id'));
      break;
    case 'select-conversation':
      selectConversation(actionEl.getAttribute('data-conv-id'));
      break;
    case 'switch-ws-conv':
      switchWorkspaceAndConv(actionEl.getAttribute('data-ws-id'), actionEl.getAttribute('data-conv-id'));
      break;
    case 'toggle-tool':
      if (!e.target.closest('.tool-detail-card')) {
        toggleToolDetail(actionEl.getAttribute('data-tool-id'));
      }
      break;
    case 'load-file':
      state.userPickedFile = true;
      loadFileOrDiff(actionEl.getAttribute('data-path'));
      break;
    case 'load-workspace-file':
      state.userPickedFile = true;
      state.activeRightTab = 'file';
      loadFileOrDiff(actionEl.getAttribute('data-path'));
      break;
    case 'save-editor-file':
      saveEditorFile();
      break;
    case 'switch-language':
      switchLanguage(actionEl.getAttribute('data-lang'));
      break;
    case 'switch-appearance':
      switchAppearance(actionEl.getAttribute('data-mode'));
      break;
    case 'switch-theme-family':
      switchThemeFamily(actionEl.getAttribute('data-family'));
      break;
    case 'switch-font-size':
      switchFontSize(actionEl.getAttribute('data-size'));
      break;
    case 'set-model-provider':
      setModelProvider(actionEl.getAttribute('data-provider'));
      break;
    case 'save-models-settings':
      saveModelsSettings();
      break;
    case 'toggle-plugin':
      togglePlugin(actionEl.getAttribute('data-plugin-id'), actionEl.getAttribute('data-enabled') === 'true');
      break;
    case 'open-import-plugin':
      openImportPluginModal();
      break;
    case 'submit-import-plugin':
      submitImportPlugin();
      break;
    case 'toggle-ws-modal-tab':
      toggleWsModalTab(actionEl.getAttribute('data-tab'));
      break;
    case 'submit-workspace':
      submitWorkspaceModal();
      break;
    case 'close-modal':
      closeModal();
      break;
    case 'toggle-subagent':
      toggleSubagent(actionEl.getAttribute('data-agent-id'));
      break;
    default:
      break;
  }
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'plugin-search-input') {
    filterPlugins(e.target.value);
  } else if (e.target.id === 'skill-search-input') {
    filterSkills(e.target.value);
  } else if (e.target.id === 'cfg-base-url' || e.target.id === 'cfg-api-key') {
    checkModelKeyWarning();
  }
});

// ============================================================================
// Initialization
// ============================================================================
window.addEventListener('DOMContentLoaded', async () => {
  applyChromeLabels();
  startRelativeTimeTicker();
  const composer = document.querySelector('[data-testid="chat-input"]');
  const sendBtn = document.querySelector('[data-testid="chat-send"]');

  if (composer) {
    composer.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        const val = composer.value.trim();
        if (val) {
          sendMessage(val);
          composer.value = '';
        }
      }
    });
  }

  if (sendBtn) {
    sendBtn.addEventListener('click', () => {
      if (composer) {
        const val = composer.value.trim();
        if (val) {
          sendMessage(val);
          composer.value = '';
        }
      }
    });
  }

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeSettings();
      closeModal();
    }
  });

  applyI18n();
  await loadInitialData();
  applyChromeLabels();
});
