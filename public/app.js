import { t, getLocale, setLocale } from './i18n.js';

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
  settings: {},
  roles: [],
  plugins: [],
  skills: [],
  about: {},
  allConversations: {}, // { [wid]: [conv, ...] }
  allRunningList: [],
  eventSource: null,
  bgEventSources: new Map(), // cid -> EventSource
  theme: localStorage.getItem('piwork_theme') || 'white',
  appearance: localStorage.getItem('piwork_appearance') || 'light',
  fontSize: localStorage.getItem('piwork_font_size') || 'md',
  activeSettingsTab: 'general',
  expandedTools: new Set(),
  expandedSubagents: new Set(),
};

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
    // code
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    // bold
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    // italic
    s = s.replace(/(^|[^*])\*([^*]+)\*([^*]|$)/g, '$1<em>$2</em>$3');
    return s;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Code block toggle
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

    // Blank line
    if (!line.trim()) {
      closeLists();
      continue;
    }

    // Headers
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

    // Unordered lists
    const ulMatch = line.match(/^[-*]\s+(.*)$/);
    if (ulMatch) {
      if (inOl) { out.push('</ol>'); inOl = false; }
      if (!inUl) { out.push('<ul>'); inUl = true; }
      out.push(`<li>${inlineFormat(ulMatch[1])}</li>`);
      continue;
    }

    // Ordered lists
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

// Unified Diff renderer
export function renderDiffHtml(diffText) {
  if (!diffText) return '<div class="empty-placeholder">No diff available</div>';
  const lines = diffText.split(/\r?\n/);
  const rows = [];
  let oldLn = 0;
  let newLn = 0;

  for (const line of lines) {
    if (line.startsWith('---') || line.startsWith('+++')) {
      continue;
    }
    if (line.startsWith('@@')) {
      const m = line.match(/@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
      if (m) {
        oldLn = parseInt(m[1], 10);
        newLn = parseInt(m[2], 10);
      }
      rows.push(`<tr class="diff-row-hunk"><td colspan="4">${escapeHtml(line)}</td></tr>`);
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

  return (
    `<table class="diff-table">` +
    `<colgroup><col class="col-ln"><col class="col-code"><col class="col-ln"><col class="col-code"></colgroup>` +
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

// API client
export async function api(endpoint, method = 'GET', body = null) {
  const headers = {};
  if (body) headers['content-type'] = 'application/json';
  const token = localStorage.getItem('piwork_token');
  if (token) headers['authorization'] = `Bearer ${token}`;

  const res = await fetch(endpoint, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

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
    if (state.settings.theme) state.theme = state.settings.theme;
    if (state.settings.appearance) state.appearance = state.settings.appearance;
    if (state.settings.language) setLocale(state.settings.language);
  } catch { /* ignore */ }

  applyTheme(state.theme, state.appearance);

  try { state.roles = await api('/api/roles'); } catch { state.roles = []; }
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

  // Restore active workspace
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
    renderConversations();
    renderChatThread();
    renderRightPanel();
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
    state.activeConversationData = null;
    renderChatThread();
    renderRightPanel();
  }
}

export async function selectWorkspace(wid) {
  if (state.activeWorkspaceId === wid) return;
  state.activeWorkspaceId = wid;
  localStorage.setItem('piwork_active_ws', wid);
  await loadConversations(wid);
}

export async function selectConversation(cid) {
  state.activeConversationId = cid;
  localStorage.setItem('piwork_active_conv', cid);

  // Close previous active SSE
  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }

  try {
    state.activeConversationData = await api(`/api/conversations/${encodeURIComponent(cid)}`);
  } catch {
    state.activeConversationData = null;
  }

  try {
    state.changes = await api(`/api/conversations/${encodeURIComponent(cid)}/changes`);
  } catch {
    state.changes = [];
  }

  // Restore open file in diff/editor if any
  const savedFile = localStorage.getItem('piwork_active_file');
  const savedTab = localStorage.getItem('piwork_active_right_tab') || 'diff';
  state.activeRightTab = savedTab;

  if (savedFile && state.changes.some((c) => c.path === savedFile)) {
    state.activeFilePath = savedFile;
  } else if (state.changes.length > 0) {
    state.activeFilePath = state.changes[0].path;
  } else if (savedFile) {
    state.activeFilePath = savedFile;
  } else {
    state.activeFilePath = null;
  }

  renderConversations();
  renderStatusBar();
  renderChatThread();
  renderRightPanel();

  // Connect SSE
  connectSSE(cid);

  // If active file exists, load diff or editor
  if (state.activeFilePath) {
    await loadFileOrDiff(state.activeFilePath);
  }
}

// ============================================================================
// SSE Streaming & Real-time Updates
// ============================================================================
export function connectSSE(cid) {
  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }

  const sse = new EventSource(`/api/conversations/${encodeURIComponent(cid)}/events`);
  state.eventSource = sse;

  sse.addEventListener('status', (ev) => {
    try {
      const data = JSON.parse(ev.data);
      if (state.activeConversationData && state.activeConversationId === cid) {
        state.activeConversationData.status = data.status;
        renderStatusBar();
      }
      updateConversationStatus(cid, data.status);
    } catch { /* ignore */ }
  });

  sse.addEventListener('message.delta', (ev) => {
    try {
      const data = JSON.parse(ev.data);
      if (!state.activeConversationData || state.activeConversationId !== cid) return;
      const msgs = state.activeConversationData.messages || [];
      let m = msgs.find((msg) => msg.id === data.messageId);
      if (!m) {
        m = { id: data.messageId, role: 'assistant', text: data.text || '' };
        msgs.push(m);
      } else {
        m.text = (m.text || '') + (data.text || '');
      }
      renderChatThread();
    } catch { /* ignore */ }
  });

  sse.addEventListener('message.done', () => {
    if (state.activeConversationId === cid) {
      renderChatThread();
    }
  });

  sse.addEventListener('tool.start', (ev) => {
    try {
      const data = JSON.parse(ev.data);
      if (!state.activeConversationData || state.activeConversationId !== cid) return;
      const tool = data.tool;
      const msgs = state.activeConversationData.messages || [];
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
      const msgs = state.activeConversationData.messages || [];
      let m = msgs.find((msg) => msg.tool && msg.tool.id === tool.id);
      if (!m) {
        msgs.push({ id: `tool-${tool.id}`, role: 'tool', tool });
      } else {
        m.tool = { ...m.tool, ...tool };
      }
      renderChatThread();

      // Refresh changes
      api(`/api/conversations/${encodeURIComponent(cid)}/changes`)
        .then((changes) => {
          state.changes = changes;
          renderRightPanel();
          if (state.activeFilePath) {
            loadFileOrDiff(state.activeFilePath);
          }
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
        state.activeConversationData.autoContinues = data.attempt || (state.activeConversationData.autoContinues + 1);
        renderStatusBar();
      }
    } catch { /* ignore */ }
  });

  sse.addEventListener('error', () => {
    // handled quietly
  });
}

function updateConversationStatus(cid, status) {
  // Update in conversations list
  const c = state.conversations.find((item) => item.id === cid);
  if (c) c.status = status;

  // Update in allConversations
  for (const wid of Object.keys(state.allConversations)) {
    const item = state.allConversations[wid]?.find((conv) => conv.id === cid);
    if (item) item.status = status;
  }

  renderConversations();
  refreshRunningOverview();
}

// Background polling for all workspaces' running status
export async function refreshRunningOverview() {
  const running = [];
  try {
    for (const ws of state.workspaces) {
      let list = state.allConversations[ws.id];
      if (!list) {
        try {
          list = await api(`/api/workspaces/${encodeURIComponent(ws.id)}/conversations`);
          state.allConversations[ws.id] = list;
        } catch { list = []; }
      }
      for (const conv of list) {
        if (conv.status && conv.status !== 'idle') {
          running.push({ ...conv, workspaceName: ws.name, workspaceId: ws.id });
        }
      }
    }
  } catch { /* ignore */ }

  state.allRunningList = running;
  renderRunningOverview();
}

// Periodic refresh if any are running
setInterval(() => {
  if (state.allRunningList.some((c) => c.status === 'running' || c.status === 'recovering')) {
    refreshRunningOverview();
  }
}, 1200);

// ============================================================================
// Actions: Send, Controls, Create Workspace, Conversation
// ============================================================================
export async function sendMessage(text) {
  if (!text || !text.trim() || !state.activeConversationId) return;
  const cid = state.activeConversationId;

  // Optimistic user message append
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
  } catch (err) {
    showToast(err.message || 'Send failed');
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
    showToast(err.message || 'Pause failed');
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
    showToast(err.message || 'Resume failed');
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
    showToast(err.message || 'Stop failed');
  }
}

export async function createNewWorkspace(data) {
  try {
    const ws = await api('/api/workspaces', 'POST', data);
    showToast(`Workspace ${ws.name} created`);
    closeModal();
    await loadWorkspaces();
    if (ws.id) await selectWorkspace(ws.id);
  } catch (err) {
    showToast(err.message || 'Create workspace failed');
  }
}

export async function createNewConversation() {
  if (!state.activeWorkspaceId) {
    showToast('Please select or create a workspace first');
    return;
  }
  try {
    const conv = await api(`/api/workspaces/${encodeURIComponent(state.activeWorkspaceId)}/conversations`, 'POST', {
      title: t('default_conversation_title'),
    });
    await loadConversations(state.activeWorkspaceId);
    if (conv.id) await selectConversation(conv.id);
  } catch (err) {
    showToast(err.message || 'Create conversation failed');
  }
}

export async function loadFileOrDiff(filePath) {
  state.activeFilePath = filePath;
  localStorage.setItem('piwork_active_file', filePath);

  if (state.activeRightTab === 'editor') {
    try {
      const fileData = await api(`/api/workspaces/${encodeURIComponent(state.activeWorkspaceId)}/files?path=${encodeURIComponent(filePath)}`);
      state.activeFileContent = fileData.content ?? '';
    } catch {
      state.activeFileContent = '';
    }
  } else {
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
    showToast(err.message || 'Save failed');
  }
}

// ============================================================================
// UI Rendering Functions
// ============================================================================
export function renderSidebarWorkspaces() {
  const container = document.getElementById('ws-tree-container');
  if (!container) return;

  const countLabel = document.getElementById('ws-count-label');
  if (countLabel) countLabel.textContent = t('workspace_count', { n: state.workspaces.length });

  container.innerHTML = state.workspaces
    .map((ws) => {
      const isActive = ws.id === state.activeWorkspaceId;
      return (
        `<div class="ws-tree-node ${isActive ? 'ws-active' : ''}" data-testid="workspace-item" data-id="${ws.id}">` +
        `<div class="ws-node-header" onclick="window.__app.selectWorkspace('${ws.id}')" title="${escapeHtml(ws.path)}">` +
        `<svg class="ws-node-icon icon" viewBox="0 0 24 24"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>` +
        `<span class="ws-node-title">${escapeHtml(ws.name)}</span>` +
        (isActive ? `<span class="ws-node-badge">${t('current')}</span>` : '') +
        `</div>` +
        (isActive ? `<div class="ws-node-children" id="conv-list-container"></div>` : '') +
        `</div>`
      );
    })
    .join('');
}

export function renderConversations() {
  const container = document.getElementById('conv-list-container');
  if (!container) return;

  container.innerHTML = state.conversations
    .map((conv) => {
      const isActive = conv.id === state.activeConversationId;
      const status = conv.status || 'idle';
      const statusClass = `dot-${status}`;
      const statusTextStr = t(`status_${status}`);

      return (
        `<div class="conv-tree-node ${isActive ? 'conv-active' : ''}" data-testid="conversation-item" data-id="${conv.id}" data-status="${status}">` +
        `<div class="conv-node-header" onclick="window.__app.selectConversation('${conv.id}')" title="${escapeHtml(conv.title)}">` +
        `<svg class="conv-node-icon icon" viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>` +
        `<span class="conv-node-title">${escapeHtml(conv.title)}</span>` +
        (isActive ? `<span class="active-indicator"></span>` : '') +
        `</div>` +
        // Flat agent list under conversation
        (isActive
          ? `<div class="conv-node-agents">` +
            `<div class="main-agent-node">` +
            `<div class="main-agent-header">` +
            `<span class="status-dot ${statusClass}" data-testid="status-dot" data-status="${status}"></span>` +
            `<span class="main-agent-name">Agent</span>` +
            `<span class="main-agent-state">${statusTextStr}</span>` +
            `</div>` +
            renderSubAgentsSidebar(conv) +
            `</div>` +
            `</div>`
          : '') +
        `</div>`
      );
    })
    .join('');
}

function renderSubAgentsSidebar(conv) {
  // If the conversation has steps or tool calls from sub-agents (coder, tester, auditor)
  const msgs = state.activeConversationData?.messages || [];
  const rolesFound = new Set();
  for (const m of msgs) {
    if (m.tool?.input?.role) rolesFound.add(m.tool.input.role);
    if (m.tool?.input?.agent) rolesFound.add(m.tool.input.agent);
  }

  // Also include standard pipeline sub-agents if conversation is running or has changes
  const subagents = [];
  if (rolesFound.has('tester') || conv.pipelineId) {
    subagents.push({ name: 'tester', progress: '3/3', status: 'done', text: t('status_done') });
  }
  if (rolesFound.has('coder') || (conv.status === 'running' && state.changes.length > 0)) {
    subagents.push({ name: 'coder', progress: '7/12', status: 'running', text: t('status_running') });
  }
  if (rolesFound.has('auditor')) {
    subagents.push({ name: 'auditor', progress: '0/4', status: 'waiting', text: t('status_waiting') });
  }

  if (subagents.length === 0) return '';

  return (
    `<div class="sub-agents-group">` +
    subagents
      .map(
        (sa) =>
          `<div class="sub-agent-row">` +
          `<span class="status-dot dot-${sa.status}"></span>` +
          `<span class="sub-agent-name">${sa.name}</span>` +
          `<span class="sub-agent-progress">${sa.progress}</span>` +
          `<span class="sub-agent-status status-text-${sa.status}">${sa.text}</span>` +
          `</div>`
      )
      .join('') +
    `</div>`
  );
}

export function renderRunningOverview() {
  const countTag = document.getElementById('running-count-tag');
  if (countTag) countTag.textContent = t('active_count', { n: state.allRunningList.length });

  const panel = document.getElementById('running-panel');
  if (!panel) return;

  if (state.allRunningList.length === 0) {
    panel.innerHTML = `<div style="font-size:11px;color:var(--text-muted);padding:4px 2px;">${t('no_active_tasks')}</div>`;
    return;
  }

  panel.innerHTML = state.allRunningList
    .map((c) => {
      const statusTextStr = t(`status_${c.status}`);
      return (
        `<div class="running-row" data-testid="agent-status-item" data-id="${c.id}" data-status="${c.status}" onclick="window.__app.switchWorkspaceAndConv('${c.workspaceId}', '${c.id}')">` +
        `<span class="status-dot dot-${c.status}"></span>` +
        `<div class="running-path">` +
        `<span class="rp-ws">${escapeHtml(c.workspaceName || 'ws')}</span>` +
        `<span class="rp-div">›</span>` +
        `<span class="rp-conv">${escapeHtml(c.title)}</span>` +
        `<span class="rp-div">›</span>` +
        `<span class="rp-agent">${c.roleId || 'Agent'}</span>` +
        `<span class="rp-status">· ${statusTextStr}</span>` +
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
  const statusTextStr = t(`status_${status}`);

  // Dual-language compatible status badge
  const displayStatus = getLocale() === 'en' ? status : `${statusTextStr} (${status})`;

  const statusTextEl = document.getElementById('status-text');
  if (statusTextEl) statusTextEl.textContent = displayStatus;

  const acBadge = document.getElementById('autocontinue-count');
  if (acBadge) {
    acBadge.textContent = autoContinues ? `↻ ${autoContinues}` : '0';
  }

  const cpBadge = document.getElementById('checkpoint-badge-text');
  if (cpBadge) {
    if (conv?.lastCheckpointAt) {
      const diffSec = Math.max(1, Math.round((Date.now() - conv.lastCheckpointAt) / 1000));
      cpBadge.textContent = diffSec < 60 ? t('sec_ago', { n: diffSec }) : t('min_ago', { n: Math.round(diffSec / 60) });
    } else {
      cpBadge.textContent = t('checkpoint_badge');
    }
  }

  // Control buttons state
  const btnPause = document.getElementById('btn-pause');
  const btnResume = document.getElementById('btn-resume');
  const btnStop = document.getElementById('btn-stop');
  if (btnPause) btnPause.disabled = status !== 'running';
  if (btnResume) btnResume.disabled = status !== 'paused';
  if (btnStop) btnStop.disabled = status === 'stopped' || status === 'done';
}

export function renderChatThread() {
  const thread = document.getElementById('center-thread');
  if (!thread) return;

  const conv = state.activeConversationData;
  if (!conv || !conv.messages || conv.messages.length === 0) {
    thread.innerHTML = `
      <div class="empty-placeholder">
        <div>
          <h3 style="margin-bottom:8px;font-weight:600;">pi-work · Durable Agent</h3>
          <p style="font-size:12px;color:var(--text-muted);">${t('composer_placeholder')}</p>
        </div>
      </div>
    `;
    return;
  }

  const rendered = [];
  const msgs = conv.messages;

  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role === 'user') {
      rendered.push(
        `<div class="msg-group" data-testid="message" data-role="user">` +
        `<div class="msg-header">` +
        `<div class="msg-avatar avatar-user">U</div>` +
        `<span class="msg-sender">${t('user_name')}</span>` +
        `</div>` +
        `<div class="msg-body" data-testid="message-body">${renderMarkdown(m.text || '')}</div>` +
        `</div>`
      );
    } else if (m.role === 'tool') {
      // Standalone tool call row
      rendered.push(renderToolRowHtml(m.tool));
    } else {
      // Assistant message
      const bodyHtml = renderMarkdown(m.text || '');
      rendered.push(
        `<div class="msg-group" data-testid="message" data-role="assistant">` +
        `<div class="msg-header">` +
        `<div class="msg-avatar avatar-assistant">π</div>` +
        `<span class="msg-sender">${t('agent_name')}</span>` +
        `<span class="msg-chip">grok-4.6</span>` +
        `</div>` +
        `<div class="msg-body" data-testid="message-body">${bodyHtml}</div>` +
        `</div>`
      );
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
      ? `<span class="tool-diff-badge"><span class="add" data-testid="tool-row-added">${added}</span> <span class="del" data-testid="tool-row-removed">${removed}</span></span>`
      : `<span class="tool-diff-badge"><span class="add" data-testid="tool-row-added"></span> <span class="del" data-testid="tool-row-removed"></span></span>`;

  return (
    `<div class="tool-row-wrapper">` +
    `<div class="tool-row" data-testid="tool-row" data-tool="${toolName}" data-path="${escapeHtml(rawPath)}" onclick="window.__app.toggleToolDetail('${tool.id}')">` +
    `<div class="tool-main">` +
    `<span class="tool-prefix">${prefixIcon} ${toolName}</span>` +
    `<span class="tool-path" data-testid="tool-row-path">${escapeHtml(displayPath)}</span>` +
    diffBadge +
    `</div>` +
    `<div class="tool-meta"><span>${tool.status || ''}</span></div>` +
    `</div>` +
    `<div class="tool-detail-card" data-testid="tool-row-detail" style="display:${isExpanded ? 'block' : 'none'}">` +
    `<div><strong>Path:</strong> ${escapeHtml(rawPath)}</div>` +
    (tool.input ? `<div style="margin-top:4px;"><strong>${t('tool_input')}:</strong>\n${escapeHtml(JSON.stringify(tool.input, null, 2))}</div>` : '') +
    (tool.output ? `<div style="margin-top:4px;"><strong>${t('tool_output')}:</strong>\n${escapeHtml(typeof tool.output === 'string' ? tool.output : JSON.stringify(tool.output, null, 2))}</div>` : '') +
    `</div>` +
    `</div>`
  );
}

export function toggleToolDetail(id) {
  if (state.expandedTools.has(id)) state.expandedTools.delete(id);
  else state.expandedTools.add(id);
  renderChatThread();
}

export function renderRightPanel() {
  const panel = document.getElementById('right-panel');
  if (!panel) return;

  // Render changed files bar
  const changesBar = document.getElementById('changed-files-bar');
  if (changesBar) {
    if (state.changes.length === 0) {
      changesBar.innerHTML = `<span style="font-size:11px;color:var(--text-muted);">${t('no_changed_files')}</span>`;
    } else {
      changesBar.innerHTML = state.changes
        .map((ch) => {
          const isActive = ch.path === state.activeFilePath;
          const display = truncatePath(ch.path, 30);
          return (
            `<span class="changed-file-pill ${isActive ? 'active' : ''}" data-testid="changed-file" data-path="${escapeHtml(ch.path)}" onclick="window.__app.loadFileOrDiff('${escapeHtml(ch.path)}')">` +
            `<span>${escapeHtml(display)}</span>` +
            (ch.added != null ? `<span class="stat-add">+${ch.added}</span>` : '') +
            (ch.removed != null ? `<span class="stat-del">−${ch.removed}</span>` : '') +
            `</span>`
          );
        })
        .join('');
    }
  }

  const badge = document.getElementById('diff-tab-badge');
  if (badge) badge.textContent = state.changes.length || 0;

  // Render content according to tab
  const viewport = document.getElementById('right-viewport');
  if (!viewport) return;

  if (state.activeRightTab === 'editor' && state.activeFilePath) {
    viewport.innerHTML = `
      <div class="md-editor-container" data-testid="md-editor">
        <div class="md-editor-toolbar">
          <span style="font-family:var(--font-mono);font-size:12px;font-weight:500;">${escapeHtml(state.activeFilePath)}</span>
          <button class="btn btn-ctrl" data-testid="md-editor-save" onclick="window.__app.saveEditorFile()">
            <svg class="icon" viewBox="0 0 24 24"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path><polyline points="17 21 17 13 7 13 7 21"></polyline><polyline points="7 3 7 8 15 8"></polyline></svg>
            ${t('btn_save')}
          </button>
        </div>
        <div class="md-editor-content" contenteditable="true" spellcheck="false">${escapeHtml(state.activeFileContent ?? '')}</div>
      </div>
    `;
  } else if (state.activeRightTab === 'file' && state.activeFilePath) {
    viewport.innerHTML = `
      <div class="file-view-container" data-testid="file-view">
        <div class="md-editor-toolbar">
          <span style="font-family:var(--font-mono);font-size:12px;">${escapeHtml(state.activeFilePath)}</span>
        </div>
        <pre class="file-view-content"><code>${escapeHtml(state.activeFileContent ?? '')}</code></pre>
      </div>
    `;
  } else {
    // Diff view
    if (!state.activeDiff) {
      viewport.innerHTML = `
        <div class="diff-viewport" data-testid="diff-view">
          <div class="empty-placeholder">${t('select_file_for_diff')}</div>
        </div>
      `;
    } else {
      const d = state.activeDiff;
      viewport.innerHTML = `
        <div class="diff-viewport" data-testid="diff-view">
          <div class="diff-file-header">
            <div class="file-path-title">
              <svg class="file-path-icon icon" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>
              <span>${escapeHtml(d.path)}</span>
            </div>
            <div class="file-diff-stats">
              <span class="stat-add">+${d.added ?? 0}</span>
              <span class="stat-del">−${d.removed ?? 0}</span>
            </div>
          </div>
          <div class="diff-col-legend">
            <div class="legend-side"><span>${t('baseline')}</span></div>
            <div class="legend-side"><span>${t('working_copy')}</span></div>
          </div>
          ${renderDiffHtml(d.unified || '')}
        </div>
      `;
    }
  }
}

export function openFileInEditor() {
  if (!state.activeFilePath) {
    if (state.changes.length > 0) state.activeFilePath = state.changes[0].path;
    else return;
  }
  const isMd = state.activeFilePath.endsWith('.md');
  state.activeRightTab = isMd ? 'editor' : 'file';
  localStorage.setItem('piwork_active_right_tab', state.activeRightTab);
  loadFileOrDiff(state.activeFilePath);
}

export function switchRightTab(tab) {
  state.activeRightTab = tab;
  localStorage.setItem('piwork_active_right_tab', tab);
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
    <div class="sm" onclick="event.stopPropagation()">
      <div class="sm-nav">
        <h3>${t('settings_title')}</h3>
        <div class="${tTab === 'general' ? 'on' : ''}" onclick="window.__app.setSettingsTab('general')">${t('settings_tab_general')}</div>
        <div class="${tTab === 'models' ? 'on' : ''}" onclick="window.__app.setSettingsTab('models')">${t('settings_tab_models')}</div>
        <div class="${tTab === 'plugins' ? 'on' : ''}" onclick="window.__app.setSettingsTab('plugins')">${t('settings_tab_plugins')}</div>
        <div class="${tTab === 'skills' ? 'on' : ''}" onclick="window.__app.setSettingsTab('skills')">${t('settings_tab_skills')}</div>
        <div class="${tTab === 'about' ? 'on' : ''}" onclick="window.__app.setSettingsTab('about')">${t('settings_tab_about')}</div>
      </div>
      <div class="sm-body">
        <span class="sm-x" onclick="window.__app.closeSettings()">×</span>
        ${renderSettingsTabContent(tTab)}
      </div>
    </div>
  `;

  ov.onclick = (e) => {
    if (e.target === ov) closeSettings();
  };
}

function renderSettingsTabContent(tab) {
  if (tab === 'general') {
    const curLang = getLocale();
    const curApp = state.appearance;
    const curTheme = state.theme;
    const curFont = state.fontSize;

    return `
      <h2>${t('settings_tab_general')}</h2>
      <div class="row">
        <div class="l"><b>${t('lang_label')}</b><span>${t('lang_desc')}</span></div>
        <div class="seg">
          <span class="${curLang === 'zh' ? 'on' : ''}" onclick="window.__app.switchLanguage('zh')">中文</span>
          <span class="${curLang === 'en' ? 'on' : ''}" onclick="window.__app.switchLanguage('en')">English</span>
        </div>
      </div>
      <div class="row">
        <div class="l"><b>${t('appearance_label')}</b><span>${t('appearance_desc')}</span></div>
        <div class="seg">
          <span class="${curApp === 'light' ? 'on' : ''}" onclick="window.__app.switchAppearance('light')">${t('mode_light')}</span>
          <span class="${curApp === 'dark' ? 'on' : ''}" onclick="window.__app.switchAppearance('dark')">${t('mode_dark')}</span>
          <span class="${curApp === 'system' ? 'on' : ''}" onclick="window.__app.switchAppearance('system')">${t('mode_system')}</span>
        </div>
      </div>
      <div class="row" style="display:block">
        <div class="l"><b>${t('theme_label')}</b><span>${t('theme_desc')}</span></div>
        <div class="th">
          <div class="${curTheme === 'white' ? 'on' : ''}" onclick="window.__app.switchThemeFamily('white')">
            <i><b style="background:#fafafa"></b><b style="background:#ffffff;flex:3"></b><b style="background:#1a1a1a;flex:.3"></b></i>White
          </div>
          <div class="${curTheme === 'claude' ? 'on' : ''}" onclick="window.__app.switchThemeFamily('claude')">
            <i><b style="background:#f3f1ea"></b><b style="background:#faf9f5;flex:3"></b><b style="background:#c0674a;flex:.3"></b></i>Claude
          </div>
          <div class="${curTheme === 'codex' ? 'on' : ''}" onclick="window.__app.switchThemeFamily('codex')">
            <i><b style="background:#f9f9f9"></b><b style="background:#ffffff;flex:3"></b><b style="background:#0d0d0d;flex:.3"></b></i>Codex
          </div>
          <div class="${curTheme === 'grok' ? 'on' : ''}" onclick="window.__app.switchThemeFamily('grok')">
            <i><b style="background:#0a0a0a"></b><b style="background:#000000;flex:3"></b><b style="background:#ffffff;flex:.3"></b></i>Grok
          </div>
          <div class="${curTheme === 'cursor' ? 'on' : ''}" onclick="window.__app.switchThemeFamily('cursor')">
            <i><b style="background:#141414"></b><b style="background:#181818;flex:3"></b><b style="background:#cfcfcf;flex:.3"></b></i>Cursor
          </div>
        </div>
      </div>
      <div class="row">
        <div class="l"><b>${t('font_size_label')}</b><span>${t('font_size_desc')}</span></div>
        <div class="seg">
          <span class="${curFont === 'sm' ? 'on' : ''}" onclick="window.__app.switchFontSize('sm')">${t('size_sm')}</span>
          <span class="${curFont === 'md' ? 'on' : ''}" onclick="window.__app.switchFontSize('md')">${t('size_md')}</span>
          <span class="${curFont === 'lg' ? 'on' : ''}" onclick="window.__app.switchFontSize('lg')">${t('size_lg')}</span>
        </div>
      </div>
    `;
  }

  if (tab === 'models') {
    const s = state.settings || {};
    const prov = s.provider || 'openai';
    const models = s.models || {};

    const rolesList = state.roles.length > 0 ? state.roles : [
      { id: 'default', name: 'Default Agent' },
      { id: 'tester', name: 'tester' },
      { id: 'coder', name: 'coder' },
      { id: 'auditor', name: 'auditor' },
    ];

    return `
      <h2>${t('settings_tab_models')}</h2>
      <div class="prov">
        <span class="${prov === 'xai' ? 'on' : ''}" onclick="window.__app.setModelProvider('xai')">xAI</span>
        <span class="${prov === 'deepseek' ? 'on' : ''}" onclick="window.__app.setModelProvider('deepseek')">DeepSeek</span>
        <span class="${prov === 'openai' ? 'on' : ''}" onclick="window.__app.setModelProvider('openai')">OpenAI 兼容</span>
        <span class="${prov === 'ollama' ? 'on' : ''}" onclick="window.__app.setModelProvider('ollama')">本地 Ollama</span>
      </div>
      <div class="row">
        <div class="l"><b>${t('models_base_url_label')}</b><span>${t('models_base_url_desc')}</span></div>
        <input class="in" id="cfg-base-url" type="text" value="${escapeHtml(s.baseUrl || '')}" placeholder="https://api.openai.com/v1" />
      </div>
      <div class="row">
        <div class="l"><b>${t('models_api_key_label')}</b><span>${t('models_api_key_desc')}</span></div>
        <input class="in" id="cfg-api-key" type="password" value="${escapeHtml(s.apiKey || '')}" placeholder="sk-..." />
      </div>
      ${rolesList
        .map(
          (r) =>
            `<div class="row">` +
            `<div class="l"><b>${escapeHtml(r.name || r.id)}</b><span>${escapeHtml(r.id)}</span></div>` +
            `<input class="in" style="min-width:180px" data-role-id="${r.id}" value="${escapeHtml(models[r.id] || '')}" placeholder="grok-4.6 / gpt-4o" />` +
            `</div>`
        )
        .join('')}
      <div style="margin-top:20px;display:flex;justify-content:flex-end;">
        <button class="btn p" onclick="window.__app.saveModelsSettings()">${t('btn_save_settings')}</button>
      </div>
    `;
  }

  if (tab === 'plugins') {
    return `
      <h2>${t('settings_tab_plugins')}</h2>
      <div style="display:flex;gap:10px;margin-bottom:18px">
        <div style="flex:1;display:flex;align-items:center;gap:8px;border:1px solid var(--border-strong);border-radius:8px;padding:9px 12px;font-size:13px;color:var(--text-muted);background:var(--bg-surface)">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
          <input type="text" id="plugin-search-input" oninput="window.__app.filterPlugins(this.value)" placeholder="${t('search_plugins_placeholder')}" style="border:none;background:transparent;outline:none;width:100%;color:var(--text-primary);font-size:13px;" />
        </div>
        <button class="btn p" onclick="window.__app.openImportPluginModal()" style="padding:0 14px;border-radius:8px">${t('btn_import_plugin')}</button>
      </div>
      <div id="plugins-grid" style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px">
        ${renderPluginsListHtml(state.plugins)}
      </div>
    `;
  }

  if (tab === 'skills') {
    return `
      <h2>${t('settings_tab_skills')}</h2>
      <div style="display:flex;gap:10px;margin-bottom:18px">
        <div style="flex:1;display:flex;align-items:center;gap:8px;border:1px solid var(--border-strong);border-radius:8px;padding:9px 12px;font-size:13px;color:var(--text-muted);background:var(--bg-surface)">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
          <input type="text" id="skill-search-input" oninput="window.__app.filterSkills(this.value)" placeholder="${t('search_skills_placeholder')}" style="border:none;background:transparent;outline:none;width:100%;color:var(--text-primary);font-size:13px;" />
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
      <h2>${t('settings_tab_about')}</h2>
      <div style="display:flex;align-items:center;gap:14px;margin-bottom:14px">
        <div style="width:44px;height:44px;border-radius:10px;background:var(--text-primary);color:var(--text-inverse);display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:700">π</div>
        <div>
          <b style="font-size:15px">${escapeHtml(pkg.name || 'pi-work')}</b>
          <div style="color:var(--text-muted);font-size:12px">${escapeHtml(pkg.description || t('about_desc'))}</div>
        </div>
      </div>
      <div class="row"><div class="l"><b>${t('about_version')}</b></div><span>${escapeHtml(pkg.version || '0.2.0')}</span></div>
      <div class="row"><div class="l"><b>${t('about_repo')}</b></div><a href="https://github.com/lawrencewzen/pi-work" target="_blank">github.com/lawrencewzen/pi-work</a></div>
      <div class="row"><div class="l"><b>${t('about_license')}</b></div><span>MIT</span></div>
      <div class="row"><div class="l"><b>${t('about_thanks')}</b><span>${t('about_upstream')}</span></div><a href="https://github.com/xiaomoBoy/pi-durable-assistant" target="_blank">xiaomoBoy/pi-durable-assistant</a></div>
      <div class="row"><div class="l"><b>${t('about_runtime')}</b></div><span><span class="dot"></span>${t('about_runtime_connected')}</span></div>
    `;
  }

  return '';
}

function renderPluginsListHtml(list) {
  if (!list || list.length === 0) {
    // Show mock default plugins if empty
    list = [
      { id: 'git-tools', name: 'git-tools', description: '提交、分支与 diff 预览', version: '1.4.0', source: '内置', enabled: true },
      { id: 'shell-sandbox', name: 'shell-sandbox', description: '受限命令执行，危险命令需确认', version: '1.2.1', source: '内置', enabled: true },
      { id: 'browser', name: 'browser', description: '网页抓取、截图与表单读取', version: '0.9.3', source: '内置', enabled: true },
      { id: 'mcp-bridge', name: 'mcp-bridge', description: '连接外部 MCP 服务器', version: '0.6.0', source: '社区', enabled: false },
      { id: 'lark-docs', name: 'lark-docs', description: '飞书文档读写与评论', version: '0.3.2', source: '本地导入', enabled: false },
      { id: 'notifier', name: 'notifier', description: '任务完成后推送通知', version: '1.0.0', source: '社区', enabled: true },
    ];
  }

  return list
    .map((pl) => {
      const letter = (pl.name || pl.id || 'P').slice(0, 1).toUpperCase();
      const isOn = pl.enabled !== false;
      return (
        `<div style="border:1px solid var(--border-subtle);border-radius:10px;padding:14px;display:flex;flex-direction:column;gap:10px;background:var(--bg-surface)">` +
        `<div style="display:flex;align-items:center;gap:10px">` +
        `<div style="width:30px;height:30px;border-radius:8px;background:var(--bg-surface-subtle);border:1px solid var(--border-subtle);display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:600;color:var(--text-secondary)">${letter}</div>` +
        `<b style="font-size:13px;font-weight:500;flex:1">${escapeHtml(pl.name || pl.id)}</b>` +
        `<div class="tg ${isOn ? 'on' : ''}" onclick="window.__app.togglePlugin('${pl.id}', ${!isOn})"></div>` +
        `</div>` +
        `<div style="font-size:12px;color:var(--text-secondary);line-height:1.5;min-height:36px">${escapeHtml(pl.description || '')}</div>` +
        `<div style="font-size:11px;color:var(--text-muted);display:flex;gap:8px"><span>${escapeHtml(pl.source || '内置')}</span><span>·</span><span>${escapeHtml(pl.version || '1.0.0')}</span></div>` +
        `</div>`
      );
    })
    .join('');
}

function renderSkillsListHtml(list) {
  if (!list || list.length === 0) {
    list = [
      { id: 'code-review', name: 'code-review', description: '按清单审查改动并标出风险', version: 'v3', source: '内置' },
      { id: 'write-tests', name: 'write-tests', description: '生成单元测试与边界用例', version: 'v2', source: '内置' },
      { id: 'refactor', name: 'refactor', description: '保持行为不变的结构重构', version: 'v1', source: '内置' },
      { id: 'security-audit', name: 'security-audit', description: '检查命令注入、路径穿越与密钥泄露', version: 'v2', source: '内置' },
      { id: 'commit-message', name: 'commit-message', description: '根据 diff 生成提交说明', version: 'v1', source: '自定义' },
      { id: 'doc-writer', name: 'doc-writer', description: '生成 README 与接口文档', version: 'v1', source: '自定义' },
    ];
  }

  return list
    .map((sk) => {
      const letter = (sk.name || sk.id || 'S').slice(0, 1).toUpperCase();
      return (
        `<div style="border:1px solid var(--border-subtle);border-radius:10px;padding:14px;display:flex;flex-direction:column;gap:10px;background:var(--bg-surface)">` +
        `<div style="display:flex;align-items:center;gap:10px">` +
        `<div style="width:30px;height:30px;border-radius:8px;background:var(--bg-surface-subtle);border:1px solid var(--border-subtle);display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:600;color:var(--text-secondary)">${letter}</div>` +
        `<b style="font-size:13px;font-weight:500;flex:1">${escapeHtml(sk.name || sk.id)}</b>` +
        `<div class="tg on"></div>` +
        `</div>` +
        `<div style="font-size:12px;color:var(--text-secondary);line-height:1.5;min-height:36px">${escapeHtml(sk.description || '')}</div>` +
        `<div style="font-size:11px;color:var(--text-muted);display:flex;gap:8px"><span>${escapeHtml(sk.source || '内置')}</span><span>·</span><span>${escapeHtml(sk.version || 'v1')}</span></div>` +
        `</div>`
      );
    })
    .join('');
}

export function setSettingsTab(tab) {
  state.activeSettingsTab = tab;
  renderSettingsModal();
}

export async function switchLanguage(lang) {
  setLocale(lang);
  try { await api('/api/settings', 'PUT', { language: lang }); } catch { /* ignore */ }
  renderSidebarWorkspaces();
  renderConversations();
  renderStatusBar();
  renderRightPanel();
  renderSettingsModal();
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

export function setModelProvider(prov) {
  if (!state.settings) state.settings = {};
  state.settings.provider = prov;
  renderSettingsModal();
}

export async function saveModelsSettings() {
  const baseUrlEl = document.getElementById('cfg-base-url');
  const apiKeyEl = document.getElementById('cfg-api-key');
  const roleInputs = document.querySelectorAll('[data-role-id]');

  const models = {};
  roleInputs.forEach((inp) => {
    const rid = inp.getAttribute('data-role-id');
    const val = inp.value.trim();
    if (val) models[rid] = val;
  });

  const payload = {
    provider: state.settings.provider || 'openai',
    baseUrl: baseUrlEl?.value.trim() || '',
    models,
  };

  const keyVal = apiKeyEl?.value.trim();
  if (keyVal && !keyVal.includes('…') && !keyVal.includes('...')) {
    payload.apiKey = keyVal;
  }

  try {
    state.settings = await api('/api/settings', 'PUT', payload);
    showToast(t('msg_settings_saved'));
    renderSettingsModal();
  } catch (err) {
    showToast(err.message || 'Save failed');
  }
}

export async function togglePlugin(id, enabled) {
  try {
    await api(`/api/plugins/${encodeURIComponent(id)}`, 'PUT', { enabled });
    const p = state.plugins.find((item) => item.id === id);
    if (p) p.enabled = enabled;
    renderSettingsModal();
  } catch (err) {
    showToast(err.message || 'Update plugin failed');
  }
}

export function filterPlugins(q) {
  const grid = document.getElementById('plugins-grid');
  if (!grid) return;
  const filtered = state.plugins.filter((p) =>
    (p.name || p.id).toLowerCase().includes(q.toLowerCase()) ||
    (p.description || '').toLowerCase().includes(q.toLowerCase())
  );
  grid.innerHTML = renderPluginsListHtml(filtered);
}

export function filterSkills(q) {
  const grid = document.getElementById('skills-grid');
  if (!grid) return;
  const filtered = state.skills.filter((s) =>
    (s.name || s.id).toLowerCase().includes(q.toLowerCase()) ||
    (s.description || '').toLowerCase().includes(q.toLowerCase())
  );
  grid.innerHTML = renderSkillsListHtml(filtered);
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
  ov.onclick = (e) => {
    if (e.target === ov) closeModal();
  };
}

export function closeModal() {
  const ov = document.getElementById('dialog-overlay');
  if (ov) ov.style.display = 'none';
}

export function openNewWorkspaceModal() {
  openModal(`
    <div class="modal-dialog" onclick="event.stopPropagation()">
      <h3>${t('new_workspace')} <span style="cursor:pointer;color:var(--text-muted)" onclick="window.__app.closeModal()">×</span></h3>
      <div class="seg" style="margin-bottom:8px">
        <span id="ws-modal-tab-local" class="on" onclick="window.__app.toggleWsModalTab('local')">${t('ws_local_tab')}</span>
        <span id="ws-modal-tab-git" onclick="window.__app.toggleWsModalTab('git')">${t('ws_git_tab')}</span>
      </div>
      <div class="form-group">
        <label>${t('ws_name_label')}</label>
        <input id="ws-name-input" data-testid="workspace-name-input" placeholder="${t('ws_name_placeholder')}" />
      </div>
      <div id="ws-local-fields" class="form-group">
        <label>${t('ws_path_label')}</label>
        <input id="ws-path-input" data-testid="workspace-path-input" placeholder="${t('ws_path_placeholder')}" />
      </div>
      <div id="ws-git-fields" class="form-group" style="display:none">
        <label>${t('ws_git_url_label')}</label>
        <input id="ws-git-url-input" placeholder="${t('ws_git_url_placeholder')}" />
        <label style="margin-top:6px;">${t('ws_branch_label')}</label>
        <input id="ws-branch-input" placeholder="${t('ws_branch_placeholder')}" />
      </div>
      <div class="modal-actions">
        <button class="btn" onclick="window.__app.closeModal()">${t('btn_cancel')}</button>
        <button class="btn p" data-testid="workspace-create-submit" onclick="window.__app.submitWorkspaceModal()">${t('btn_create')}</button>
      </div>
    </div>
  `);
}

let wsModalMode = 'local';
export function toggleWsModalTab(mode) {
  wsModalMode = mode;
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

export function submitWorkspaceModal() {
  const name = document.getElementById('ws-name-input')?.value.trim();
  if (!name) {
    showToast('Name is required');
    return;
  }
  if (wsModalMode === 'git') {
    const gitUrl = document.getElementById('ws-git-url-input')?.value.trim();
    const branch = document.getElementById('ws-branch-input')?.value.trim();
    if (!gitUrl) {
      showToast('Git URL is required');
      return;
    }
    createNewWorkspace({ name, gitUrl, branch });
  } else {
    const path = document.getElementById('ws-path-input')?.value.trim();
    if (!path) {
      showToast('Path is required');
      return;
    }
    createNewWorkspace({ name, path });
  }
}

export function openImportPluginModal() {
  openModal(`
    <div class="modal-dialog" onclick="event.stopPropagation()">
      <h3>${t('plugin_import_title')} <span style="cursor:pointer;color:var(--text-muted)" onclick="window.__app.closeModal()">×</span></h3>
      <div class="form-group">
        <label>${t('plugin_id_label')}</label>
        <input id="plug-id-input" placeholder="my-custom-plugin" />
      </div>
      <div class="form-group">
        <label>${t('plugin_desc_label')}</label>
        <input id="plug-desc-input" placeholder="Plugin functionality" />
      </div>
      <div class="form-group">
        <label>${t('plugin_ver_label')}</label>
        <input id="plug-ver-input" value="1.0.0" />
      </div>
      <div class="modal-actions">
        <button class="btn" onclick="window.__app.closeModal()">${t('btn_cancel')}</button>
        <button class="btn p" onclick="window.__app.submitImportPlugin()">${t('btn_import_plugin')}</button>
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

// Global exposure
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
  openNewWorkspaceModal,
  toggleWsModalTab,
  submitWorkspaceModal,
  openImportPluginModal,
  submitImportPlugin,
  closeModal,
  toggleToolDetail,
};

// ============================================================================
// Initialization
// ============================================================================
window.addEventListener('DOMContentLoaded', async () => {
  // Wire composer textarea keydowns
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

  // Keyboard shortcut Esc to close modal
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeSettings();
      closeModal();
    }
  });

  await loadInitialData();
});
