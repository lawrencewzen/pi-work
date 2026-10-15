import { t, tPlural, getLocale, setLocale, applyI18n, translations } from './i18n.js';
import {
  clipOutputText,
  summarizeToolGroup,
  toolDiffCounts,
  toolFocus,
  toolGroupKey,
  toolKind,
  toolStatusBucket,
} from './tool-groups.js';
import { composerContextText } from './usage.js';
import { composerAgentPresentation, resolveDispatchModel } from './agent-chip.js';
import {
  renderModelsPane,
  renderModelPop,
  mountModelsPane,
  handleModelsAction,
  onModelsField,
  onModelsToggle,
  closeModelPop,
  noteSettingsReloaded,
} from './model-settings.js';
import { renderWorkflowTab, handleWorkflowAction, filterWorkflow, pipelineTitle, captureWorkflowDraft } from './workflow-settings.js';
import {
  renderAgentsPane,
  renderAgentSkillsPop,
  mountAgentsPane,
  handleAgentAction,
  onAgentField,
  onAgentToolChange,
  onAgentSkillChange,
  filterAgents,
  captureAgentDraft,
} from './agent-settings.js';
import {
  applyStreamDelta,
  applyMessageDone,
  dropStreamingResidues,
  mergeRefreshedMessages,
  statusKeepsStreaming,
} from './stream.js';

// Application State
const state = {
  workspaces: [],
  activeWorkspaceId: null,
  conversations: [],
  activeConversationId: null,
  activeConversationData: null,
  // 尚未创建的新对话（草稿）选好的角色 / 流水线，发出第一条消息时随创建请求带上
  draft: { roleId: '', pipelineId: '' },
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
  pluginQuery: '',
  skillQuery: '',
  about: {},
  allConversations: {}, // { [wid]: [conv, ...] }
  allRunningList: [],
  eventSource: null,
  unauthorized: false,
  theme: localStorage.getItem('piwork_theme') || 'white',
  appearance: localStorage.getItem('piwork_appearance') || 'light',
  fontSize: localStorage.getItem('piwork_font_size') || 'md',
  activeSettingsTab: 'general',
  workflowSection: 'pipelines',
  workflowEditor: null,
  workflowQuery: '',
  expandedTools: new Set(),
  expandedToolGroups: new Set(),
  expandedToolOutputs: new Set(),
  expandedSubagents: new Set(),
  viewingAgentId: null,
  viewingAgent: null,
  workspaceTree: [],
  workspaceTreeFor: null,
  treeLoadingFor: null,
  treeGen: 0,
  allowedWorkspaceRoot: '',
};

let runningPollInterval = null;
let convMetaRefreshTimer = null;
let workspaceTreeRefreshTimer = null;
let subagentPollTimer = null;
let viewingRefreshTimer = null;

const FILE_TREE_TOOLS = new Set(['write', 'edit', 'bash']);
const FILE_TREE_RUN_DONE = new Set(['done', 'stopped', 'failed']);

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
    const codes = [];
    let s = escapeHtml(txt);
    s = s.replace(/`([^`]+)`/g, (_, code) => {
      const token = `\u0000C${codes.length}\u0000`;
      codes.push(`<code>${code}</code>`);
      return token;
    });
    s = applyEmphasis(s);
    s = replaceMarkdownLinks(s);
    s = replaceAutolinks(s);
    s = s.replace(/\u0000C(\d+)\u0000/g, (_, i) => codes[Number(i)] || '');
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

function applyEmphasis(s) {
  let out = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*]+)\*([^*]|$)/g, '$1<em>$2</em>$3');
  return out;
}

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      const cp = Number(n);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => {
      const cp = parseInt(n, 16);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
    });
}

/** Allow only http(s) and mailto after entity/percent decoding. */
function safeUrl(escapedHref) {
  let url = decodeEntities(String(escapedHref || '')).replace(/[\u0000-\u001f]/g, '').trim();
  if (!url) return '';
  try {
    const decoded = decodeURIComponent(url);
    if (decoded !== url) url = decoded.trim();
  } catch { /* keep the original */ }
  if (!url || /[\s"'<>`]/.test(url)) return '';
  let parsed;
  try { parsed = new URL(url); } catch { return ''; }
  const proto = parsed.protocol.toLowerCase();
  if (proto !== 'http:' && proto !== 'https:' && proto !== 'mailto:') return '';
  if ((proto === 'http:' || proto === 'https:') && !parsed.hostname) return '';
  return parsed.href;
}

function linkHtml(href, label) {
  const safe = safeUrl(href);
  if (!safe) return '';
  return `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
}

function replaceMarkdownLinks(s) {
  return s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (full, label, href) => linkHtml(href, label) || full);
}

function replaceAutolinks(s) {
  return s.split(/(<a\b[^>]*>[\s\S]*?<\/a>)/g).map((part) => {
    if (part.startsWith('<a ')) return part;
    return part.replace(/(^|[\s(])(https?:\/\/[^\s<]+)/g, (full, pre, url) => {
      const core = url.replace(/[),.;!?]+$/, '');
      const trail = url.slice(core.length);
      const html = linkHtml(core, core);
      return html ? `${pre}${html}${trail}` : full;
    });
  }).join('');
}

const ROLE_LABEL_KEYS = {
  coder: 'role_coder',
  tester: 'role_tester',
  auditor: 'role_auditor',
  planner: 'role_planner',
  default: 'role_default',
  agent: 'agent_name',
};

export function localizeRoleLabel(value) {
  const raw = String(value || '').trim();
  if (!raw) return t('agent_name');
  const key = ROLE_LABEL_KEYS[raw.toLowerCase()];
  return key ? t(key) : raw;
}

/** New-file hunks have an empty old side (`@@ -0,0`). */
export function isAddedFileDiff(diffText) {
  if (!diffText) return false;
  const hunks = [...String(diffText).matchAll(/^@@\s+-\d+,(\d+)/gm)];
  return hunks.length > 0 && hunks.every((m) => m[1] === '0');
}

/** +0 −0 against the baseline: identical content, so it is not a Diff entry. */
export function changeHasDiff(ch) {
  if (!ch) return false;
  const added = Number(ch.added);
  const removed = Number(ch.removed);
  if (Number.isFinite(added) || Number.isFinite(removed)) {
    return added !== 0 || removed !== 0;
  }
  return true;
}

export function changesWithDiff(list) {
  return (Array.isArray(list) ? list : []).filter(changeHasDiff);
}

/** Loaded diff whose working copy matches the baseline (blank side-by-side columns). */
export function diffIsUnchanged(diff) {
  if (!diff) return false;
  const added = Number(diff.added);
  const removed = Number(diff.removed);
  if (Number.isFinite(added) && Number.isFinite(removed)) {
    return added === 0 && removed === 0;
  }
  const unified = typeof diff.unified === 'string' ? diff.unified : '';
  return unified.length > 0 && !/^@@/m.test(unified);
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

function isToastKey(message) {
  return typeof message === 'string' && message !== '' && Object.prototype.hasOwnProperty.call(translations.zh, message);
}

function toastText(message, vars) {
  if (isToastKey(message)) return t(message, vars || {});
  return message == null ? '' : String(message);
}

// Toast notification. i18n keys are translated when the toast is shown, not when the caller builds the string.
export function showToast(message, vars) {
  const existing = document.querySelector('.toast-msg');
  if (existing) existing.remove();
  const el = document.createElement('div');
  el.className = 'toast-msg';
  if (isToastKey(message)) {
    el.dataset.toastKey = message;
    if (vars) el.dataset.toastVars = JSON.stringify(vars);
  }
  el.textContent = toastText(message, vars);
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

function refreshToasts() {
  document.querySelectorAll('.toast-msg[data-toast-key]').forEach((el) => {
    let vars = {};
    try { vars = el.dataset.toastVars ? JSON.parse(el.dataset.toastVars) : {}; } catch { vars = {}; }
    el.textContent = t(el.dataset.toastKey, vars);
  });
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
    if (state.settings?.grok?.pending?.loginId) {
      state.grokPending = state.settings.grok.pending;
      scheduleGrokPoll(state.settings.grok.pending.interval);
    }
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

export async function loadConversations(wid, { draft = false } = {}) {
  try {
    state.conversations = await api(`/api/workspaces/${encodeURIComponent(wid)}/conversations`);
    state.allConversations[wid] = state.conversations;
  } catch {
    state.conversations = [];
  }

  const savedCid = localStorage.getItem('piwork_active_conv');
  if (draft) {
    state.activeConversationId = null;
  } else if (savedCid && state.conversations.some((c) => c.id === savedCid)) {
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

export async function selectWorkspace(wid, { draft = false } = {}) {
  if (state.activeWorkspaceId === wid) return;
  if (workspaceTreeRefreshTimer) {
    clearTimeout(workspaceTreeRefreshTimer);
    workspaceTreeRefreshTimer = null;
  }
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
  await loadConversations(wid, { draft });
}

function treeEntriesEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i]?.path !== b[i]?.path || a[i]?.type !== b[i]?.type) return false;
  }
  return true;
}

export async function loadWorkspaceTree() {
  const wid = state.activeWorkspaceId;
  if (!wid) {
    state.workspaceTree = [];
    state.workspaceTreeFor = null;
    return false;
  }
  const gen = ++state.treeGen;
  state.treeLoadingFor = wid;
  try {
    const data = await api(`/api/workspaces/${encodeURIComponent(wid)}/tree`);
    if (gen !== state.treeGen || state.activeWorkspaceId !== wid) return false;
    const next = Array.isArray(data?.entries) ? data.entries : [];
    const changed = state.workspaceTreeFor !== wid || !treeEntriesEqual(state.workspaceTree, next);
    state.workspaceTree = next;
    state.workspaceTreeFor = wid;
    return changed;
  } catch {
    if (gen !== state.treeGen || state.activeWorkspaceId !== wid) return false;
    if (state.workspaceTreeFor === wid) return false;
    state.workspaceTree = [];
    state.workspaceTreeFor = wid;
    return true;
  } finally {
    if (gen === state.treeGen && state.treeLoadingFor === wid) state.treeLoadingFor = null;
  }
}

function workspaceTreeRowsHtml() {
  const wid = state.activeWorkspaceId;
  const ready = state.workspaceTreeFor === wid;
  if (!wid || (ready && !state.workspaceTree.length)) {
    return `<div class="file-tree-empty">${escapeHtml(t('file_tree_empty'))}</div>`;
  }
  if (!ready) {
    return `<div class="file-tree-empty">${escapeHtml(t('file_tree_loading'))}</div>`;
  }
  return state.workspaceTree.map((ent) => {
    const depth = String(ent.path || '').split('/').length - 1;
    const name = String(ent.path || '').split('/').pop();
    const pad = 8 + depth * 12;
    const label = ent.type === 'dir' ? `${name}/` : name;
    const title = escapeHtml(name);
    if (ent.type === 'dir') {
      return `<div class="file-tree-row is-dir" style="padding-left:${pad}px" title="${title}"><span class="file-tree-name">${escapeHtml(label)}</span></div>`;
    }
    const active = ent.path === state.activeFilePath ? ' active' : '';
    return `<button type="button" class="file-tree-row${active}" style="padding-left:${pad}px" title="${title}" data-testid="workspace-file" data-action="load-workspace-file" data-path="${escapeHtml(ent.path)}"><span class="file-tree-name">${escapeHtml(label)}</span></button>`;
  }).join('');
}

function paintWorkspaceTree() {
  if (state.activeRightTab !== 'file') return;
  if (state.workspaceTreeFor !== state.activeWorkspaceId) return;
  const tree = document.querySelector('#right-viewport .file-tree');
  if (!tree) {
    renderRightPanel();
    return;
  }
  const top = tree.scrollTop;
  tree.innerHTML = workspaceTreeRowsHtml();
  tree.scrollTop = top;
}

function ensureWorkspaceTree() {
  const wid = state.activeWorkspaceId;
  if (!wid) return;
  if (state.workspaceTreeFor === wid || state.treeLoadingFor === wid) return;
  loadWorkspaceTree().then((changed) => {
    if (changed) paintWorkspaceTree();
  });
}

function toolWritesWorkspace(tool) {
  return FILE_TREE_TOOLS.has(String(tool?.name || '').trim().toLowerCase());
}

// write/edit/bash land files before the next paint. Step and run events cover
// bash-created paths and pipeline handoff, including when the tool row was missed.
function scheduleWorkspaceTreeRefresh() {
  const wid = state.activeWorkspaceId;
  if (!wid) return;
  if (workspaceTreeRefreshTimer) clearTimeout(workspaceTreeRefreshTimer);
  workspaceTreeRefreshTimer = setTimeout(() => {
    workspaceTreeRefreshTimer = null;
    if (state.activeWorkspaceId !== wid) return;
    loadWorkspaceTree().then((changed) => {
      if (changed) paintWorkspaceTree();
    });
  }, 120);
}

export async function selectConversation(cid) {
  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }
  clearSubagentView();

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
      const item = state.conversations.find((c) => c.id === cid);
      if (item) {
        item.status = state.activeConversationData.status || item.status;
        item.archived = isArchivedConversation(state.activeConversationData);
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

  const visibleChanges = changesWithDiff(state.changes);
  if (visibleChanges.length > 0) {
    state.activeFilePath = visibleChanges[visibleChanges.length - 1].path;
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
          state.activeConversationData.archived = isArchivedConversation(item);
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
    state.activeConversationData.archived = isArchivedConversation(conv);
    if (conv.status === 'failed') {
      if (conv.llmError) state.activeConversationData.llmError = conv.llmError;
    } else if (conv.status && conv.status !== 'recovering') {
      state.activeConversationData.llmError = null;
    }
    if (conv.lastCheckpointAt) state.activeConversationData.lastCheckpointAt = conv.lastCheckpointAt;
    if (conv.usage) state.activeConversationData.usage = conv.usage;
    if (conv.contextWindow != null) state.activeConversationData.contextWindow = conv.contextWindow;
    if ('roleId' in conv) state.activeConversationData.roleId = conv.roleId || null;
    if ('pipelineId' in conv) state.activeConversationData.pipelineId = conv.pipelineId || null;
    if (conv.pipelineStep != null) state.activeConversationData.pipelineStep = conv.pipelineStep;
    if (conv.agents) state.activeConversationData.agents = conv.agents;
    if (Array.isArray(conv.messages)) {
      const local = state.activeConversationData.messages || [];
      state.activeConversationData.messages = mergeRefreshedMessages(local, conv.messages, {
        keepStreaming: statusKeepsStreaming(conv.status),
      });
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
      if (state.activeConversationId === cid && FILE_TREE_RUN_DONE.has(data.status)) {
        scheduleWorkspaceTreeRefresh();
      }
      if (state.activeConversationData && state.activeConversationId === cid) {
        state.activeConversationData.status = data.status;
        if (data.status === 'done' || data.status === 'failed' || data.status === 'stopped' || data.status === 'idle') {
          dropStreamingResidues(state.activeConversationData.messages || []);
        }
        if (data.autoContinues != null) state.activeConversationData.autoContinues = data.autoContinues;
        if (data.title) {
          state.activeConversationData.title = data.title;
          const item = state.conversations.find((c) => c.id === cid);
          if (item) item.title = data.title;
        }
        if (data.status && data.status !== 'failed' && data.status !== 'recovering' && state.activeConversationData.llmError) {
          state.activeConversationData.llmError = null;
          renderChatThread();
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
      if (state.activeConversationId === cid && data.status === 'done') {
        scheduleWorkspaceTreeRefresh();
      }
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
      if (data.id && data.id === state.viewingAgentId) scheduleViewingAgentRefresh(cid);
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
        state.activeConversationData.messages = state.activeConversationData.messages || [];
        applyMessageDone(state.activeConversationData.messages, data);
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
      const tool = data.tool;
      if (state.activeConversationId === cid && toolWritesWorkspace(tool)) {
        scheduleWorkspaceTreeRefresh();
      }
      if (!state.activeConversationData || state.activeConversationId !== cid) return;
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
          const visible = changesWithDiff(state.changes);
          const newest = visible.length ? visible[visible.length - 1].path : null;
          const toolPath = tool?.path || tool?.input?.path || null;
          const stillExists = state.activeFilePath && state.changes.some((c) => c.path === state.activeFilePath);
          if (!state.userPickedFile) {
            const pick = (toolPath && visible.some((c) => c.path === toolPath)) ? toolPath : newest;
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

  sse.addEventListener('usage', (ev) => {
    try {
      const data = JSON.parse(ev.data);
      if (!state.activeConversationData || state.activeConversationId !== cid) return;
      if (data.usage) state.activeConversationData.usage = data.usage;
      if (data.contextWindow != null) state.activeConversationData.contextWindow = data.contextWindow;
      renderStatusBar();
    } catch { /* ignore */ }
  });

  sse.addEventListener('checkpoint', (ev) => {
    try {
      const data = JSON.parse(ev.data);
      if (state.activeConversationId === cid) scheduleWorkspaceTreeRefresh();
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

  sse.addEventListener('error', (ev) => {
    // Connection drops also fire "error" with no payload. Named SSE error
    // events (E_LLM and friends) arrive as MessageEvents with JSON data.
    if (typeof ev?.data !== 'string' || !ev.data) return;
    try {
      const data = JSON.parse(ev.data);
      if (!state.activeConversationData || state.activeConversationId !== cid) return;
      const message = String(data?.message || '').trim();
      const code = String(data?.code || 'E_LLM').trim() || 'E_LLM';
      if (!message && !code) return;
      state.activeConversationData.llmError = { code, message };
      renderStatusBar();
      renderChatThread();
      if (message || code === 'E_NO_MODEL') showToast(code === 'E_NO_MODEL' ? 'err_no_model' : message);
    } catch { /* ignore malformed payloads */ }
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
  if (!text || !text.trim()) return;
  if (isArchivedConversation(state.activeConversationData) || state.viewingAgentId) return;
  if (!state.activeConversationId) {
    // 没有选中的对话时，直接发送即新建一个对话；失败则把内容放回输入框
    const { roleId, pipelineId } = state.draft;
    const conv = await createNewConversation(pipelineId ? { pipelineId } : { roleId });
    if (!conv?.id) {
      const composer = document.querySelector('[data-testid="chat-input"]');
      if (composer && !composer.value.trim()) composer.value = text;
      return;
    }
  }
  const cid = state.activeConversationId;

  if (state.activeConversationData) {
    state.activeConversationData.messages = state.activeConversationData.messages || [];
    state.activeConversationData.messages.push({
      id: `usr-${Date.now()}`,
      role: 'user',
      text,
    });
    state.activeConversationData.llmError = null;
    state.activeConversationData.status = 'running';
    renderChatThread();
    renderStatusBar();
  }

  updateConversationStatus(cid, 'running');

  try {
    const res = await api(`/api/conversations/${encodeURIComponent(cid)}/messages`, 'POST', { text });
    if (res && res.status && res.status !== 'running' && res.status !== 'recovering') {
      const err = new Error('err_send_blocked');
      err.status = 409;
      err.body = res;
      throw err;
    }
    scheduleConversationRefresh(cid);
  } catch (err) {
    const blocked = err.status === 409;
    showToast(blocked ? (isToastKey(err.message) ? err.message : 'err_send_blocked') : (err.message || 'err_send'));
    const next = blocked ? (err.body?.status || 'stopped') : 'failed';
    if (state.activeConversationData && state.activeConversationId === cid) {
      state.activeConversationData.status = next;
      renderStatusBar();
    }
    updateConversationStatus(cid, next);
  }
}

export async function pauseConversation() {
  if (!state.activeConversationId || isArchivedConversation(state.activeConversationData)) return;
  try {
    const res = await api(`/api/conversations/${encodeURIComponent(state.activeConversationId)}/pause`, 'POST');
    updateConversationStatus(state.activeConversationId, res.status || 'paused');
    if (state.activeConversationData) {
      state.activeConversationData.status = res.status || 'paused';
      renderStatusBar();
    }
  } catch (err) {
    showToast(err.message || 'err_pause');
  }
}

export async function resumeConversation() {
  if (!state.activeConversationId || isArchivedConversation(state.activeConversationData)) return;
  try {
    const res = await api(`/api/conversations/${encodeURIComponent(state.activeConversationId)}/resume`, 'POST');
    updateConversationStatus(state.activeConversationId, res.status || 'running');
    if (state.activeConversationData) {
      state.activeConversationData.status = res.status || 'running';
      renderStatusBar();
    }
  } catch (err) {
    showToast(err.message || 'err_resume');
  }
}

export async function stopConversation() {
  if (!state.activeConversationId || isArchivedConversation(state.activeConversationData)) return;
  try {
    const res = await api(`/api/conversations/${encodeURIComponent(state.activeConversationId)}/stop`, 'POST');
    updateConversationStatus(state.activeConversationId, res.status || 'stopped');
    if (state.activeConversationData) {
      state.activeConversationData.status = res.status || 'stopped';
      renderStatusBar();
    }
  } catch (err) {
    showToast(err.message || 'err_stop');
  }
}

export async function createNewWorkspace(data) {
  const ws = await api('/api/workspaces', 'POST', data);
  showToast('ws_created', { name: ws.name || data?.name || '' });
  closeModal();
  try {
    await loadWorkspaces();
    if (ws.id) await selectWorkspace(ws.id);
  } catch { /* created; sidebar refresh is best-effort */ }
  return ws;
}

export async function createNewConversation(opts = {}) {
  if (!state.activeWorkspaceId) {
    showToast('err_select_workspace');
    return;
  }
  const body = { title: opts.title || '' };
  if (opts.roleId) body.roleId = opts.roleId;
  if (opts.pipelineId) body.pipelineId = opts.pipelineId;
  try {
    const conv = await api(`/api/workspaces/${encodeURIComponent(state.activeWorkspaceId)}/conversations`, 'POST', body);
    await loadConversations(state.activeWorkspaceId);
    state.draft = { roleId: '', pipelineId: '' };
    if (conv.id) await selectConversation(conv.id);
    return conv;
  } catch (err) {
    showToast(err.message || 'err_create_conversation');
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
    showToast('btn_saved');
    state.activeFileContent = content;
    if (state.activeConversationId) {
      try {
        const changes = await api(`/api/conversations/${encodeURIComponent(state.activeConversationId)}/changes`);
        state.changes = Array.isArray(changes) ? changes : state.changes;
      } catch { /* diff refresh is best-effort */ }
    }
    renderRightPanel();
  } catch (err) {
    showToast(err.message || 'err_save');
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
        `<button class="btn-icon-xs ws-node-add" data-testid="conversation-new" data-action="new-conversation" data-ws-id="${escapeHtml(ws.id)}" title="${escapeHtml(t('new_conversation'))}">+</button>` +
        `</div>` +
        (isActive ? `<div class="ws-node-children" id="conv-list-container"></div>` : '') +
        `</div>`
      );
    })
    .join('');
}

export function isArchivedConversation(conv) {
  return Boolean(conv && (conv.archived === true || conv.status === 'archived'));
}

export function isRealSubagent(agent) {
  return String(agent?.id || '').includes(':sub:');
}

/** Quiet 「后台」 mark. Only the kernel mode field counts. */
export function isBackgroundSubagent(agent) {
  return isRealSubagent(agent) && agent?.mode === 'background';
}

function agentProgressLabel(agent) {
  if (agent?.totalSteps != null && Number(agent.totalSteps) > 0) return `${agent.step || 0}/${agent.totalSteps}`;
  if (agent?.step != null && Number(agent.step) > 0) return String(agent.step);
  return '';
}

function oneLine(text, max = 72) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1)}…`;
}

function realSubagentName(agent) {
  if (isBackgroundSubagent(agent)) return agent.name || agent.roleId || t('agent_name');
  const roleId = String(agent?.roleId || '').toLowerCase();
  if (ROLE_LABEL_KEYS[roleId]) return localizeRoleLabel(agent.roleId);
  return agent?.name || localizeRoleLabel(agent?.roleId);
}

function clearSubagentView() {
  state.viewingAgentId = null;
  state.viewingAgent = null;
  if (subagentPollTimer) {
    clearTimeout(subagentPollTimer);
    subagentPollTimer = null;
  }
  if (viewingRefreshTimer) {
    clearTimeout(viewingRefreshTimer);
    viewingRefreshTimer = null;
  }
}

function scheduleSubagentPoll() {
  if (subagentPollTimer) {
    clearTimeout(subagentPollTimer);
    subagentPollTimer = null;
  }
  const status = state.viewingAgent?.status;
  if (!state.viewingAgentId || (status !== 'running' && status !== 'waiting')) return;
  const cid = state.activeConversationId;
  const aid = state.viewingAgentId;
  subagentPollTimer = setTimeout(() => {
    subagentPollTimer = null;
    refreshViewingAgent(cid, aid).catch(() => {});
  }, 1500);
}

function scheduleViewingAgentRefresh(cid) {
  if (!state.viewingAgentId || state.activeConversationId !== cid) return;
  if (viewingRefreshTimer) clearTimeout(viewingRefreshTimer);
  const aid = state.viewingAgentId;
  viewingRefreshTimer = setTimeout(() => {
    viewingRefreshTimer = null;
    refreshViewingAgent(cid, aid).catch(() => {});
  }, 200);
}

export async function refreshViewingAgent(cid, aid) {
  if (!cid || !aid) return;
  try {
    const body = await api(`/api/conversations/${encodeURIComponent(cid)}/agents/${encodeURIComponent(aid)}/messages`);
    if (state.activeConversationId !== cid || state.viewingAgentId !== aid) return;
    state.viewingAgent = { ...body, loading: false };
    const agents = state.activeConversationData?.agents;
    if (Array.isArray(agents)) {
      const idx = agents.findIndex((agent) => agent.id === aid);
      if (idx >= 0) {
        agents[idx] = {
          ...agents[idx],
          status: body.status || agents[idx].status,
          name: body.name || agents[idx].name,
          roleId: body.roleId || agents[idx].roleId,
          ...(body.mode === 'background' || body.mode === 'foreground' ? { mode: body.mode } : {}),
        };
      }
    }
    renderConversations();
    renderCenterNotice();
    renderChatThread();
    syncComposerLock();
    scheduleSubagentPoll();
  } catch {
    if (state.activeConversationId === cid && state.viewingAgentId === aid && state.viewingAgent) {
      state.viewingAgent.loading = false;
      renderChatThread();
    }
  }
}

export async function openSubagent(agentId) {
  if (!isRealSubagent({ id: agentId }) || !state.activeConversationId) return;
  const cid = state.activeConversationId;
  const known = (state.activeConversationData?.agents || []).find((agent) => agent.id === agentId);
  state.viewingAgentId = agentId;
  state.viewingAgent = {
    ...(known || { id: agentId }),
    messages: state.viewingAgent?.id === agentId ? (state.viewingAgent.messages || []) : [],
    loading: true,
  };
  renderConversations();
  renderCenterNotice();
  renderChatThread();
  syncComposerLock();
  await refreshViewingAgent(cid, agentId);
}

export function closeSubagentView() {
  if (!state.viewingAgentId) return;
  clearSubagentView();
  renderConversations();
  renderCenterNotice();
  renderChatThread();
  syncComposerLock();
}

export async function forkFromHistory() {
  const cid = state.activeConversationId;
  if (!cid || !isArchivedConversation(state.activeConversationData)) return;
  const btn = document.querySelector('[data-testid="archived-fork"]');
  if (btn) btn.disabled = true;
  try {
    const created = await api(`/api/conversations/${encodeURIComponent(cid)}/from-history`, 'POST', {});
    clearSubagentView();
    if (created?.id) localStorage.setItem('piwork_active_conv', created.id);
    if (state.activeWorkspaceId) await loadConversations(state.activeWorkspaceId);
    if (created?.id && state.activeConversationId !== created.id) await selectConversation(created.id);
  } catch (err) {
    showToast(isToastKey(err.message) ? err.message : 'err_archived');
    renderCenterNotice();
  }
}

function renderRealSubagentRow(agent) {
  const background = isBackgroundSubagent(agent);
  const mode = agent?.mode === 'background' || agent?.mode === 'foreground' ? agent.mode : '';
  const name = realSubagentName(agent);
  const st = agent.status || 'waiting';
  const progressStr = agentProgressLabel(agent);
  const last = oneLine(agent.lastText);
  const open = state.viewingAgentId === agent.id;
  return (
    `<div class="sub-agent-row is-real${open ? ' is-open' : ''}" data-testid="subagent-row" data-agent-id="${escapeHtml(agent.id || '')}" data-role-id="${escapeHtml(agent.roleId || '')}" data-mode="${escapeHtml(mode)}" data-status="${escapeHtml(st)}" data-action="open-subagent" title="${escapeHtml(last || name)}">` +
    `<span class="status-dot dot-${escapeHtml(st)}"></span>` +
    `<span class="sub-agent-copy">` +
    `<span class="sub-agent-line">` +
    `<span class="sub-agent-name">${escapeHtml(name)}</span>` +
    (background ? `<span class="sub-agent-bg" data-testid="subagent-background">${escapeHtml(t('subagent_background'))}</span>` : '') +
    (progressStr ? `<span class="sub-agent-progress" data-testid="subagent-progress">${escapeHtml(progressStr)}</span>` : '<span class="sub-agent-progress"></span>') +
    `<span class="sub-agent-status status-text-${escapeHtml(st)}">${escapeHtml(t(`status_${st}`) || st)}</span>` +
    `</span>` +
    (last ? `<span class="sub-agent-last" data-testid="subagent-last">${escapeHtml(last)}</span>` : '') +
    `</span>` +
    `</div>`
  );
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
      `<span class="main-agent-name">${escapeHtml(t('ag_group_main'))}</span>` +
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
        if (isRealSubagent(ag)) return renderRealSubagentRow(ag);
        const isDefault = index === 0;
        const name = String(ag.roleId || '').toLowerCase() === 'default'
          ? t('ag_group_main')
          : localizeRoleLabel(ag.roleId || ag.name || '');
        const st = ag.status || (isDefault ? conv.status || 'idle' : 'waiting');
        const statusClass = `dot-${st}`;
        const statusText = t(`status_${st}`) || st;
        const progressStr = agentProgressLabel(ag);

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
      const archived = isArchivedConversation(conv);

      return (
        `<div class="conv-tree-node ${isActive ? 'conv-active' : ''}" data-testid="conversation-item" data-id="${escapeHtml(conv.id)}" data-status="${escapeHtml(status)}"${archived ? ' data-archived="true"' : ''}>` +
        `<div class="conv-node-header" data-action="select-conversation" data-conv-id="${escapeHtml(conv.id)}" title="${escapeHtml(conv.title || '')}">` +
        `<svg class="conv-node-icon icon" viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>` +
        `<span class="conv-node-title">${escapeHtml(conv.title || t('default_conversation_title'))}</span>` +
        (archived ? `<span class="conv-archived-badge" data-testid="archived-badge">${escapeHtml(t('archived_badge'))}</span>` : '') +
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

function renderComposerContext() {
  const el = document.getElementById('composer-context-value');
  if (!el) return;
  el.textContent = composerContextText(state.activeConversationData);
}

const DISPATCH_BUSY = new Set(['running', 'recovering', 'paused']);

function dispatchContext() {
  return {
    conv: state.activeConversationId ? state.activeConversationData : state.draft,
    roles: state.roles,
    pipelines: state.pipelines,
    models: state.settings?.models || {},
    sources: state.settings?.sources || [],
    grokSignedIn: Boolean(state.settings?.grok?.signedIn),
    agentName: t('agent_name'),
  };
}

function renderComposerAgent() {
  const label = document.getElementById('composer-agent-chip');
  const btn = document.getElementById('composer-agent-chip-btn');
  if (!label) return;
  const ctx = dispatchContext();
  const base = composerAgentPresentation(ctx);
  const roleLabel = base.roleId && base.roleId !== 'default' ? localizeRoleLabel(base.roleId) : '';
  const view = composerAgentPresentation({ ...ctx, roleLabel });
  label.textContent = view.text;
  if (btn) {
    const detail = view.model
      ? (roleLabel ? `${roleLabel} · ${view.model}` : view.model)
      : roleLabel;
    btn.title = detail ? `${t('chip_agent_title')}: ${detail}` : t('chip_agent_title');
  }
}

function modelForDispatchRole(role) {
  return resolveDispatchModel({
    role,
    roleId: role?.id || '',
    models: state.settings?.models || {},
    sources: state.settings?.sources || [],
    grokSignedIn: Boolean(state.settings?.grok?.signedIn),
  });
}

function agentMenuItem({ label, model, selected, attrs }) {
  return `<button type="button" class="chip-menu-item" role="option" aria-selected="${selected ? 'true' : 'false'}" ${attrs}>` +
    `<span>${escapeHtml(label)}</span>` +
    (model ? `<span class="chip-menu-model">${escapeHtml(model)}</span>` : '') +
    `</button>`;
}

function renderAgentMenuHtml() {
  const conv = (state.activeConversationId ? state.activeConversationData : state.draft) || {};
  const activePipe = conv.pipelineId || '';
  const activeRole = activePipe ? '' : ((conv.roleId && conv.roleId !== 'default') ? conv.roleId : '');
  const roles = (state.roles || []).filter((r) => r && r.id && r.id !== 'default');
  const pipes = state.pipelines || [];
  const rows = [
    agentMenuItem({
      label: t('conv_default_agent'),
      model: modelForDispatchRole(null),
      selected: !activePipe && !activeRole,
      attrs: 'data-action="pick-dispatch" data-role-id=""',
    }),
  ];
  if (roles.length) {
    rows.push(`<div class="chip-menu-label">${escapeHtml(t('chip_pick_role'))}</div>`);
    for (const role of roles) {
      rows.push(agentMenuItem({
        label: localizeRoleLabel(role.id || role.name),
        model: modelForDispatchRole(role),
        selected: !activePipe && activeRole === role.id,
        attrs: `data-action="pick-dispatch" data-role-id="${escapeHtml(role.id)}"`,
      }));
    }
  }
  if (pipes.length) {
    rows.push(`<div class="chip-menu-label">${escapeHtml(t('chip_pick_pipeline'))}</div>`);
    for (const pipe of pipes) {
      const first = pipe.steps?.[0]?.role || '';
      const role = (state.roles || []).find((r) => r.id === first) || null;
      rows.push(agentMenuItem({
        label: pipelineOptionLabel(pipe),
        model: modelForDispatchRole(role),
        selected: activePipe === pipe.id,
        attrs: `data-action="pick-dispatch" data-pipeline-id="${escapeHtml(pipe.id)}" data-role-id="${escapeHtml(first)}"`,
      }));
    }
  }
  return rows.join('');
}

function closeAgentMenu() {
  document.getElementById('composer-agent-menu')?.classList.remove('is-open');
  document.getElementById('composer-agent-chip-btn')?.setAttribute('aria-expanded', 'false');
}

function toggleAgentMenu() {
  const menu = document.getElementById('composer-agent-menu');
  if (!menu) return;
  if (menu.classList.contains('is-open')) {
    closeAgentMenu();
    return;
  }
  if (!state.activeConversationId && !state.activeWorkspaceId) {
    showToast('err_select_workspace');
    return;
  }
  const status = state.activeConversationId ? (state.activeConversationData?.status || 'idle') : 'idle';
  if (isArchivedConversation(state.activeConversationData)) {
    showToast('err_archived');
    return;
  }
  if (state.viewingAgentId) return;
  if (DISPATCH_BUSY.has(status)) {
    showToast('err_role_busy');
    return;
  }
  menu.innerHTML = renderAgentMenuHtml();
  menu.classList.add('is-open');
  document.getElementById('composer-agent-chip-btn')?.setAttribute('aria-expanded', 'true');
}

export async function pickDispatchTarget(el) {
  if (!el) return;
  const cid = state.activeConversationId;
  if (!cid) {
    // 草稿对话：只记在本地，创建时带上
    const pipelineId = el.getAttribute('data-pipeline-id') || '';
    state.draft = { pipelineId, roleId: el.getAttribute('data-role-id') || '' };
    closeAgentMenu();
    renderStatusBar();
    return;
  }
  const patch = {};
  if (el.hasAttribute('data-pipeline-id')) {
    patch.pipelineId = el.getAttribute('data-pipeline-id') || null;
    const roleId = el.getAttribute('data-role-id');
    if (roleId) patch.roleId = roleId;
  } else {
    patch.roleId = el.getAttribute('data-role-id') || null;
    patch.pipelineId = null;
  }
  try {
    const res = await api(`/api/conversations/${encodeURIComponent(cid)}`, 'PATCH', patch);
    if (state.activeConversationId === cid && state.activeConversationData) {
      state.activeConversationData.roleId = res.roleId;
      state.activeConversationData.pipelineId = res.pipelineId;
      state.activeConversationData.pipelineStep = res.pipelineStep;
      if (Array.isArray(res.agents)) state.activeConversationData.agents = res.agents;
    }
    const item = state.conversations.find((c) => c.id === cid);
    if (item) {
      item.roleId = res.roleId;
      item.pipelineId = res.pipelineId;
      if (Array.isArray(res.agents)) item.agents = res.agents;
    }
    closeAgentMenu();
    renderStatusBar();
    renderConversations();
  } catch (err) {
    showToast(isToastKey(err.message) ? err.message : (err.message || 'err_role_switch'));
  }
}

function localizedErrorText(message, code) {
  if (code === 'E_NO_MODEL' || message === 'err_no_model') return t('err_no_model');
  const text = String(message || '').trim();
  if (!text) return '';
  return isToastKey(text) ? t(text) : text;
}

function renderDemoModelBadge() {
  const on = state.settings?.runtime === 'faux';
  const label = t('demo_model_badge');
  for (const id of ['demo-model-badge', 'demo-model-chip']) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.classList.toggle('is-hidden', !on);
    el.textContent = label;
  }
}

export function renderStatusBar() {
  renderComposerContext();
  renderComposerAgent();
  renderDemoModelBadge();
  const bar = document.getElementById('status-bar');
  if (!bar) return;

  const conv = state.activeConversationData;
  const status = conv?.status || 'idle';
  const autoContinues = conv?.autoContinues || 0;
  const statusTextStr = t(`status_${status}`) || status;

  const statusTextEl = document.getElementById('status-text');
  if (statusTextEl) {
    statusTextEl.textContent = statusTextStr;
    const failedText = status === 'failed'
      ? localizedErrorText(conv?.llmError?.message, conv?.llmError?.code)
      : '';
    if (failedText) statusTextEl.title = failedText;
    else statusTextEl.removeAttribute('title');
  }

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

  const archived = isArchivedConversation(conv);
  const btnPause = document.getElementById('btn-pause');
  const btnResume = document.getElementById('btn-resume');
  const btnStop = document.getElementById('btn-stop');
  if (btnPause) btnPause.disabled = archived || status !== 'running';
  if (btnResume) btnResume.disabled = archived || status !== 'paused';
  if (btnStop) btnStop.disabled = archived || (status !== 'running' && status !== 'paused' && status !== 'recovering');
  renderCenterNotice();
  syncComposerLock();
}

export function renderCenterNotice() {
  const host = document.getElementById('center-notice');
  if (!host) return;
  const parts = [];
  const conv = state.activeConversationData;
  if (state.viewingAgentId) {
    const agent = state.viewingAgent || (conv?.agents || []).find((item) => item.id === state.viewingAgentId) || {};
    const name = realSubagentName(agent.id ? agent : { id: state.viewingAgentId, name: agent.name, roleId: agent.roleId });
    const st = agent.status || 'waiting';
    parts.push(
      `<div class="center-notice-row" data-testid="subagent-banner">` +
      `<span class="center-notice-text" data-testid="subagent-banner-text">${escapeHtml(t('subagent_banner', { name, status: t(`status_${st}`) || st }))}</span>` +
      `<button type="button" class="btn btn-sm" data-testid="subagent-back" data-action="close-subagent">${escapeHtml(t('subagent_back'))}</button>` +
      `</div>`
    );
  }
  if (isArchivedConversation(conv) && !state.viewingAgentId) {
    parts.push(
      `<div class="center-notice-row" data-testid="archived-banner">` +
      `<span class="center-notice-text" data-testid="archived-banner-text">${escapeHtml(t('archived_banner'))}</span>` +
      `<button type="button" class="btn btn-sm" data-testid="archived-fork" data-action="fork-history">${escapeHtml(t('archived_fork'))}</button>` +
      `</div>`
    );
  }
  host.innerHTML = parts.join('');
}

export function syncComposerLock() {
  const conv = state.activeConversationData;
  const archived = isArchivedConversation(conv);
  const viewing = Boolean(state.viewingAgentId);
  const locked = archived || viewing;
  const input = document.querySelector('[data-testid="chat-input"]');
  const send = document.querySelector('[data-testid="chat-send"]');
  if (input) {
    input.disabled = locked;
    input.placeholder = archived ? t('archived_input') : (viewing ? t('subagent_input') : t('composer_placeholder'));
  }
  if (send) send.disabled = locked;
  const chip = document.getElementById('composer-agent-chip-btn');
  if (chip) {
    chip.disabled = archived || viewing;
    chip.setAttribute('aria-disabled', archived || viewing ? 'true' : 'false');
  }
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
            ${renderToolCallListHtml(sa.toolCalls)}
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
  renderCenterNotice();
  const thread = document.getElementById('center-thread');
  if (!thread) return;

  const viewing = Boolean(state.viewingAgentId);
  const conv = state.activeConversationData;
  if (viewing && state.viewingAgent?.loading && !(state.viewingAgent.messages || []).length) {
    thread.innerHTML = `<div class="empty-placeholder" data-testid="subagent-thread"><p style="font-size:12px;color:var(--text-muted);">${escapeHtml(t('subagent_loading'))}</p></div>`;
    return;
  }
  if (!viewing && (!conv || !conv.messages || conv.messages.length === 0)) {
    const errHtml = llmErrorHtml(conv);
    thread.innerHTML = errHtml || `
      <div class="empty-placeholder">
        <div>
          <h3 style="margin-bottom:8px;font-weight:600;">${escapeHtml(t('empty_chat_title'))}</h3>
          <p style="font-size:12px;color:var(--text-muted);">${escapeHtml(t('composer_placeholder'))}</p>
        </div>
      </div>
    `;
    if (errHtml) thread.scrollTop = thread.scrollHeight;
    return;
  }

  const rendered = [];
  const msgs = dedupeMessages(viewing ? (state.viewingAgent?.messages || []) : conv.messages);
  const toolRun = [];
  const flushToolRun = () => {
    if (!toolRun.length) return;
    rendered.push(renderToolGroupHtml(toolRun));
    toolRun.length = 0;
  };
  if (viewing && msgs.length === 0) {
    thread.innerHTML = `<div class="empty-placeholder" data-testid="subagent-thread"><p style="font-size:12px;color:var(--text-muted);">${escapeHtml(t('subagent_empty'))}</p></div>`;
    return;
  }

  const allAgents = viewing ? [] : (conv?.agents || []);
  const cardAgents = allAgents.filter((ag) => !isRealSubagent(ag));
  const subagents = cardAgents.length > 1 ? cardAgents : [];
  let subagentsInserted = false;

  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role === 'tool') {
      if (m.tool) toolRun.push(m.tool);
      else flushToolRun();
      continue;
    }
    flushToolRun();
    if (m.kind === 'correction') {
      rendered.push(
        `<div class="handoff-note msg-side-agent" data-testid="message" data-role="system" data-kind="correction">` +
        `<span>${escapeHtml(m.text || '')}</span>` +
        `</div>`
      );
      continue;
    }
    if (m.kind === 'handoff') {
      rendered.push(
        `<div class="handoff-note msg-side-agent" data-testid="message" data-role="system" data-kind="handoff">` +
        `<span>${escapeHtml(t('handoff_note', { from: localizeRoleLabel(m.fromAgent || ''), to: localizeRoleLabel(m.toAgent || '') }))}</span>` +
        `</div>`
      );
      continue;
    }
    if (m.role === 'user') {
      rendered.push(
        `<div class="msg-group msg-side-user" data-testid="message" data-role="user">` +
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
    } else {
      const bodyHtml = renderMarkdown(m.text || '');
      const sender = assistantLabel(m);
      const chip = assistantChip(m);
      rendered.push(
        `<div class="msg-group msg-side-agent" data-testid="message" data-role="assistant">` +
        `<div class="msg-header">` +
        `<div class="msg-avatar avatar-assistant">π</div>` +
        `<span class="msg-sender" data-testid="message-sender">${escapeHtml(sender)}</span>` +
        (chip ? `<span class="msg-chip">${escapeHtml(chip)}</span>` : '') +
        `</div>` +
        `<div class="msg-body" data-testid="message-body">${bodyHtml}</div>` +
        `</div>`
      );
    }
  }

  flushToolRun();
  if (!subagentsInserted && subagents.length > 0) {
    for (const sa of subagents) {
      rendered.push(renderSubagentCardHtml(sa));
    }
  }

  if (!viewing) {
    const errHtml = llmErrorHtml(conv);
    if (errHtml) rendered.push(errHtml);
  }

  const body = rendered.join('');
  thread.innerHTML = viewing ? `<div data-testid="subagent-thread">${body}</div>` : body;
  thread.scrollTop = thread.scrollHeight;
}

function llmErrorHtml(conv) {
  const err = conv?.llmError;
  if (!err) return '';
  const code = String(err.code || '').trim();
  const message = localizedErrorText(err.message, code);
  if (!message && !code) return '';
  return (
    `<div class="llm-error" data-testid="llm-error" role="alert">` +
    (code && code !== 'E_NO_MODEL' ? `<div class="llm-error-code">${escapeHtml(code)}</div>` : '') +
    (message ? `<div class="llm-error-text">${escapeHtml(message)}</div>` : '') +
    `</div>`
  );
}

function renderToolCallListHtml(calls) {
  if (!Array.isArray(calls) || calls.length === 0) return '';
  const parts = [];
  let rows = [];
  const flush = () => {
    if (!rows.length) return;
    parts.push(
      `<div class="tool-group is-open"><div class="tool-group-list">` +
      rows.map((tool) => renderToolRowHtml(tool)).join('') +
      `</div></div>`
    );
    rows = [];
  };
  for (const tc of calls) {
    if (tc && typeof tc === 'object') {
      rows.push(tc);
      continue;
    }
    flush();
    parts.push(`<div style="font-size:11.5px;font-family:var(--font-mono);">${escapeHtml(String(tc))}</div>`);
  }
  flush();
  return parts.join('');
}

export function renderToolGroupHtml(tools, idPrefix = '') {
  const list = (tools || []).filter(Boolean);
  if (!list.length) return '';
  const id = `${idPrefix}${toolGroupKey(list)}`;
  const open = state.expandedToolGroups.has(id);
  const summary = summarizeToolGroup(list, t);
  const fail = summary.failed > 0
    ? `<span class="tool-group-fail" data-testid="tool-group-fail">${escapeHtml(t('tool_fail_count', { n: summary.failed }))}</span>`
    : '';
  const spin = summary.running
    ? `<span class="tool-group-spin" data-testid="tool-group-spinner" aria-hidden="true"></span>`
    : '';
  return (
    `<div class="tool-group${open ? ' is-open' : ''}${summary.running ? ' is-running' : ''}" data-testid="tool-group" data-group-id="${escapeHtml(id)}">` +
    `<button type="button" class="tool-group-summary" data-testid="tool-group-summary" data-action="toggle-tool-group" data-group-id="${escapeHtml(id)}" aria-expanded="${open ? 'true' : 'false'}">` +
    spin +
    `<span class="tool-group-text" data-testid="tool-group-text">${escapeHtml(summary.text)}</span>` +
    fail +
    `<svg class="tool-group-chevron icon" data-testid="tool-group-chevron" viewBox="0 0 24 24" aria-hidden="true"><polyline points="9 6 15 12 9 18"></polyline></svg>` +
    `</button>` +
    `<div class="tool-group-list" data-testid="tool-group-list">` +
    list.map((tool) => renderToolRowHtml(tool)).join('') +
    `</div>` +
    `</div>`
  );
}

function toolIconSvg(name) {
  const kind = toolKind(name);
  const open = `<svg class="tool-kind-icon icon" viewBox="0 0 24 24" aria-hidden="true">`;
  const close = `</svg>`;
  if (kind === 'read') {
    return `${open}<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline>${close}`;
  }
  if (kind === 'write') {
    return `${open}<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="12" y1="18" x2="12" y2="12"></line><line x1="9" y1="15" x2="15" y2="15"></line>${close}`;
  }
  if (kind === 'edit') {
    return `${open}<path d="M12 20h9"></path><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"></path>${close}`;
  }
  if (kind === 'ls') {
    return `${open}<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>${close}`;
  }
  if (kind === 'grep') {
    return `${open}<circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.5-3.5"></path>${close}`;
  }
  if (kind === 'bash') {
    return `${open}<polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line>${close}`;
  }
  return `${open}<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path>${close}`;
}

function toolActionLabel(name) {
  const kind = toolKind(name);
  if (kind === 'other') return name || 'tool';
  return t(`tool_act_${kind}`);
}

function toolRowDisplay(tool) {
  const focus = toolFocus(tool);
  if (focus.mode === 'text') return truncateCommand(focus.text);
  const raw = tool?.path || tool?.input?.path || focus.text || '';
  return truncatePath(raw);
}

function truncateCommand(text, max = 64) {
  const s = String(text || '');
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(1, max - 1))}…`;
}

function toolOutputSource(output) {
  if (output == null || output === '') return '';
  if (typeof output === 'string') return output;
  return JSON.stringify(output, null, 2);
}

export function renderToolRowHtml(tool) {
  if (!tool) return '';
  const toolName = tool.name || 'tool';
  const rawPath = tool.path || tool.input?.path || '';
  const display = toolRowDisplay(tool);
  const diff = toolDiffCounts(tool);
  const showDiff = (toolName === 'write' || toolName === 'edit') && (diff.added != null || diff.removed != null);
  const added = diff.added != null ? `+${diff.added}` : '';
  const removed = diff.removed != null ? `−${diff.removed}` : '';
  const isExpanded = state.expandedTools.has(tool.id);
  const bucket = toolStatusBucket(tool.status);
  const diffBadge =
    `<span class="tool-diff-badge${showDiff ? '' : ' is-hidden'}">` +
    `<span class="add" data-testid="tool-row-added">${escapeHtml(added)}</span>` +
    `<span class="del" data-testid="tool-row-removed">${escapeHtml(removed)}</span>` +
    `</span>`;
  const statusHtml = bucket === 'failed' || bucket === 'interrupted'
    ? `<span class="tool-row-status is-${bucket}" data-testid="tool-row-status">${escapeHtml(localizeToolStatus(tool.status))}</span>`
    : '';
  const preview = pluginResultPreview(tool);
  const outputText = toolOutputSource(tool.output);
  const clipped = clipOutputText(outputText, state.expandedToolOutputs.has(tool.id));
  const inputText = tool.input ? JSON.stringify(tool.input, null, 2) : '';

  return (
    `<div class="tool-row-wrapper">` +
    `<div class="tool-row${bucket === 'interrupted' ? ' tool-interrupted' : ''}" data-testid="tool-row" data-tool="${escapeHtml(toolName)}" data-path="${escapeHtml(rawPath)}" data-action="toggle-tool" data-tool-id="${escapeHtml(tool.id)}">` +
    `<div class="tool-main">` +
    toolIconSvg(toolName) +
    `<span class="tool-action">${escapeHtml(toolActionLabel(toolName))}</span>` +
    `<span class="tool-path" data-testid="tool-row-path">${escapeHtml(display)}</span>` +
    (preview ? `<span class="tool-result" data-testid="tool-row-output">${escapeHtml(preview)}</span>` : '') +
    diffBadge +
    `</div>` +
    `<div class="tool-meta">${statusHtml}</div>` +
    `<div class="tool-detail-card" data-testid="tool-row-detail" style="display:${isExpanded ? 'block' : 'none'}">` +
    `<div class="tool-detail-block">` +
    (rawPath ? `<div class="tool-detail-line"><span class="tool-detail-k">${escapeHtml(t('tool_path_label'))}</span> ${escapeHtml(rawPath)}</div>` : '') +
    (inputText ? `<div class="tool-detail-line"><span class="tool-detail-k">${escapeHtml(t('tool_input'))}</span>\n${escapeHtml(inputText)}</div>` : '') +
    (outputText ? `<div class="tool-detail-line"><span class="tool-detail-k">${escapeHtml(t('tool_output'))}</span>\n${escapeHtml(clipped.text)}</div>` : '') +
    `</div>` +
    (clipped.clipped
      ? `<button type="button" class="tool-detail-more" data-testid="tool-output-more" data-action="expand-tool-output" data-tool-id="${escapeHtml(tool.id)}">${escapeHtml(t('tool_show_all'))}</button>`
      : '') +
    `</div>` +
    `</div>` +
    `</div>`
  );
}

function assistantLabel(m) {
  if (state.viewingAgentId) {
    const agent = state.viewingAgent
      || (state.activeConversationData?.agents || []).find((item) => item.id === state.viewingAgentId);
    const name = agent ? realSubagentName(agent) : '';
    if (name) return name;
  }
  const rid = m?.roleId || m?.agentId;
  if (rid) {
    const role = (state.roles || []).find((r) => r.id === rid);
    return localizeRoleLabel(role?.id || role?.name || rid);
  }
  return t('agent_name');
}

function assistantChip(m) {
  const rid = m?.roleId || '';
  const role = rid ? (state.roles || []).find((item) => item.id === rid) || null : null;
  const chip = resolveDispatchModel({
    role,
    roleId: rid,
    models: state.settings?.models || {},
    sources: state.settings?.sources || [],
    grokSignedIn: Boolean(state.settings?.grok?.signedIn),
  });
  if (!chip || chip === assistantLabel(m)) return '';
  return chip;
}

function localizeToolStatus(status) {
  const key = {
    completed: 'tool_status_completed',
    complete: 'tool_status_completed',
    interrupted: 'tool_status_interrupted',
    running: 'tool_status_running',
    failed: 'tool_status_failed',
    error: 'tool_status_failed',
    pending: 'tool_status_pending',
    waiting: 'tool_status_pending',
  }[String(status || '').toLowerCase()];
  return key ? t(key) : (status || '');
}

function pipelineOptionLabel(pipe) {
  const steps = Array.isArray(pipe?.steps) ? pipe.steps : [];
  const chain = steps.map((s) => localizeRoleLabel(s?.role || '')).filter(Boolean).join(' → ');
  const title = pipelineTitle(pipe, { t, localizeRoleLabel });
  return chain ? `${title} (${chain})` : title;
}

function workflowCtx() {
  return { state, t, escapeHtml, api, showToast, localizeRoleLabel, render: renderSettingsModal, confirm: confirmDialog };
}

function pluginSourceLabel(src) {
  const s = String(src || '').toLowerCase();
  if (s === 'builtin' || s === 'built-in' || s === 'bundled' || s === '内置') return t('plugin_source_builtin');
  if (s === 'community' || s === '社区') return t('plugin_source_community');
  if (s === 'local' || s === 'imported' || s === '本地导入' || s === '本地') return t('plugin_source_local');
  return src || t('plugin_source_local');
}

function catalogQuery(q) {
  return String(q || '').trim().toLowerCase();
}

function matchesCatalogQuery(item, q) {
  const query = catalogQuery(q);
  if (!query) return true;
  const tools = (item?.tools || []).map((tool) => tool?.name || '').join(' ');
  const hay = `${item?.name || ''} ${item?.id || ''} ${item?.description || ''} ${tools}`.toLowerCase();
  return hay.includes(query);
}

const BUILTIN_ROW_TOOLS = new Set(['read', 'write', 'edit', 'ls', 'grep', 'bash']);

function pluginResultPreview(tool) {
  const name = String(tool?.name || '');
  if (!name || BUILTIN_ROW_TOOLS.has(name)) return '';
  if (typeof tool?.output !== 'string') return '';
  const text = tool.output.trim();
  if (!text || text.includes('\n') || text.length > 80) return '';
  return text;
}

function describePluginFailure(code, detail) {
  const text = String(detail || '').trim();
  const missingTool = text.match(/^tool ([a-z][a-z0-9_]*) is not exported$/);
  if (missingTool) return t('err_plugin_tool_missing', { name: missingTool[1] });
  if (text === 'plugin main module was not found' || text.startsWith('plugin main must be a relative .mjs')) {
    return t('err_plugin_main_missing');
  }
  if (text === 'plugin.json is not valid JSON') return t('err_plugin_json');
  const taken = text.match(/^tool ([a-z][a-z0-9_]*) is already registered$/);
  if (taken) return t('err_plugin_tool_taken', { name: taken[1] });
  if (code && t(code) !== code) {
    const translated = t(code);
    if (text && (code === 'err_plugin_not_loadable' || code === 'err_plugin_invalid') && !translated.includes(text)) {
      return `${translated} — ${text}`;
    }
    return translated;
  }
  return text;
}

function extensionError(err, fallbackKey) {
  const mapped = describePluginFailure(err?.body?.code, err?.body?.error);
  if (mapped) return mapped;
  return err?.message || t(fallbackKey);
}

function showModalError(id, message) {
  const el = document.getElementById(id);
  if (!el) {
    showToast(message);
    return;
  }
  el.textContent = message;
  el.classList.add('is-visible');
}

export function toggleToolDetail(id) {
  if (!id) return;
  if (state.expandedTools.has(id)) state.expandedTools.delete(id);
  else state.expandedTools.add(id);
  renderChatThread();
}

export function toggleToolGroup(id) {
  if (!id) return;
  if (state.expandedToolGroups.has(id)) state.expandedToolGroups.delete(id);
  else state.expandedToolGroups.add(id);
  renderChatThread();
}

export function expandToolOutput(id) {
  if (!id) return;
  state.expandedToolOutputs.add(id);
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

  const visibleChanges = changesWithDiff(state.changes);
  const changesBar = document.getElementById('changed-files-bar');
  if (changesBar) {
    if (visibleChanges.length === 0) {
      changesBar.innerHTML = `<span style="font-size:11px;color:var(--text-muted);">${escapeHtml(t('no_changed_files'))}</span>`;
    } else {
      changesBar.innerHTML = visibleChanges
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
  if (badge) badge.textContent = visibleChanges.length || 0;

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
      const emptyKey = visibleChanges.length === 0 ? 'no_changes_yet' : 'select_file_for_diff';
      viewport.innerHTML = `
        <div class="diff-viewport" data-testid="diff-view">
          <div class="empty-placeholder">${escapeHtml(t(emptyKey))}</div>
        </div>
      `;
    } else if (diffIsUnchanged(state.activeDiff)) {
      viewport.innerHTML = `
        <div class="diff-viewport" data-testid="diff-view">
          <div class="empty-placeholder" data-testid="diff-unchanged">${escapeHtml(t('diff_no_change'))}</div>
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
  const treeHtml = workspaceTreeRowsHtml();

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
function grokErrorKey(code) {
  if (code === 'denied') return 'grok_err_denied';
  if (code === 'expired' || code === 'no_login') return 'grok_err_expired';
  if (code === 'device_unavailable' || code === 'bad_verification_uri' || code === 'bad_user_code') return 'grok_err_unavailable';
  return 'grok_err_failed';
}

let grokPollTimer = null;

function stopGrokPoll() {
  if (grokPollTimer) {
    clearTimeout(grokPollTimer);
    grokPollTimer = null;
  }
}

function scheduleGrokPoll(seconds) {
  stopGrokPoll();
  const ms = Math.max(1, Number(seconds) || 5) * 1000;
  grokPollTimer = setTimeout(() => { pollGrokLogin(); }, ms);
}

function modelsCtx() {
  return {
    state,
    t,
    escapeHtml,
    api,
    showToast,
    localizeRoleLabel,
    confirm: confirmDialog,
    render: renderSettingsModal,
    renderChrome: () => {
      renderStatusBar();
      renderChatThread();
    },
    startGrokSignIn,
  };
}

function paintGrok() {
  const ov = document.getElementById('settings-overlay');
  const open = ov && ov.style.display !== 'none' && state.activeSettingsTab === 'models';
  if (!open) return;
  renderSettingsModal();
}

async function refreshGrokStatus() {
  try {
    const settings = await api('/api/settings');
    state.settings = settings;
    noteSettingsReloaded(state);
    if (settings?.grok?.pending?.loginId) {
      state.grokPending = settings.grok.pending;
      scheduleGrokPoll(settings.grok.pending.interval);
    }
    paintGrok();
    renderStatusBar();
  } catch { /* status stays as last known */ }
}

export async function startGrokSignIn() {
  state.grokError = '';
  try {
    const started = await api('/api/grok/login', 'POST', {});
    state.grokPending = started;
    if (!state.settings) state.settings = {};
    state.settings.grok = { ...(state.settings.grok || {}), signedIn: false, pending: started };
    paintGrok();
    scheduleGrokPoll(started.interval);
  } catch (err) {
    state.grokError = grokErrorKey(err.body?.error || err.message);
    paintGrok();
  }
}

async function pollGrokLogin() {
  const pending = state.grokPending || state.settings?.grok?.pending;
  if (!pending?.loginId) return;
  try {
    const result = await api('/api/grok/login/poll', 'POST', { loginId: pending.loginId });
    if (result.status === 'done') {
      stopGrokPoll();
      state.grokPending = null;
      state.grokError = '';
      try {
        state.settings = await api('/api/settings');
        noteSettingsReloaded(state);
      } catch { /* toast still reports the login */ }
      if (state.modelsUi) state.modelsUi.drawer = null;
      showToast('grok_login_ok');
      paintGrok();
      renderStatusBar();
      renderChatThread();
      return;
    }
    state.grokPending = { ...pending, interval: result.interval || pending.interval, expiresAt: result.expiresAt || pending.expiresAt };
    if (state.settings) {
      state.settings.grok = { ...(state.settings.grok || {}), pending: state.grokPending, signedIn: false };
    }
    scheduleGrokPoll(result.interval || pending.interval);
  } catch (err) {
    stopGrokPoll();
    state.grokPending = null;
    if (state.settings?.grok) state.settings.grok.pending = null;
    state.grokError = grokErrorKey(err.body?.error || err.message);
    paintGrok();
  }
}

export async function logoutGrok() {
  stopGrokPoll();
  state.grokPending = null;
  try {
    await api('/api/grok/logout', 'POST', {});
    state.settings = await api('/api/settings');
    noteSettingsReloaded(state);
    state.grokError = '';
    showToast('grok_logged_out');
    paintGrok();
    renderStatusBar();
    renderChatThread();
  } catch (err) {
    state.grokError = grokErrorKey(err.body?.error || err.message);
    paintGrok();
  }
}

export async function cancelGrokLogin() {
  stopGrokPoll();
  const id = state.grokPending?.loginId || state.settings?.grok?.pending?.loginId;
  state.grokPending = null;
  if (state.settings?.grok) state.settings.grok.pending = null;
  try {
    const grok = await api('/api/grok/login/cancel', 'POST', { loginId: id || '' });
    if (state.settings) state.settings.grok = grok;
  } catch { /* local pending is already cleared */ }
  if (state.modelsUi?.drawer === 'grok') state.modelsUi.drawer = 'pick';
  paintGrok();
}

export function openSettings(tab = 'general') {
  setSettingsTab(tab);
}

export function closeSettings() {
  state.workflowEditor = null;
  closeModelPop(state);
  const ui = state.modelsUi;
  if (ui?.tick) {
    clearInterval(ui.tick);
    ui.tick = null;
  }
  const ov = document.getElementById('settings-overlay');
  if (ov) ov.style.display = 'none';
}

function agentCtx() {
  return { state, t, escapeHtml, api, showToast, localizeRoleLabel, render: renderSettingsModal, confirm: confirmDialog };
}

export function renderSettingsModal() {
  captureWorkflowDraft(workflowCtx());
  captureAgentDraft(agentCtx());
  let ov = document.getElementById('settings-overlay');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'settings-overlay';
    ov.className = 'sm-ov';
    document.body.appendChild(ov);
  }
  ov.style.display = 'flex';

  const tTab = state.activeSettingsTab;

  const models = tTab === 'models';
  const agents = tTab === 'agents';
  const ctx = models || agents ? modelsCtx() : null;
  const pane = models
    ? renderModelsPane(ctx)
    : agents
      ? renderAgentsPane(agentCtx())
      : `<div class="sm-body"><span class="sm-x" data-action="close-settings">×</span>${renderSettingsTabContent(tTab)}</div>`;
  ov.innerHTML = `
    <div class="sm">
      <div class="sm-nav">
        <h3>${escapeHtml(t('settings_title'))}</h3>
        <div class="${tTab === 'general' ? 'on' : ''}" data-action="set-settings-tab" data-tab="general">${escapeHtml(t('settings_tab_general'))}</div>
        <div class="${tTab === 'models' ? 'on' : ''}" data-action="set-settings-tab" data-tab="models">${escapeHtml(t('settings_tab_models'))}</div>
        <div class="${tTab === 'agents' ? 'on' : ''}" data-action="set-settings-tab" data-tab="agents" data-testid="settings-tab-agents">${escapeHtml(t('settings_tab_agents'))}<span class="sm-nav-new">${escapeHtml(t('settings_tab_new'))}</span></div>
        <div class="${tTab === 'plugins' ? 'on' : ''}" data-action="set-settings-tab" data-tab="plugins">${escapeHtml(t('settings_tab_plugins'))}</div>
        <div class="${tTab === 'skills' ? 'on' : ''}" data-action="set-settings-tab" data-tab="skills">${escapeHtml(t('settings_tab_skills'))}</div>
        <div class="${tTab === 'workflow' ? 'on' : ''}" data-action="set-settings-tab" data-tab="workflow" data-testid="settings-tab-workflow">${escapeHtml(t('settings_tab_workflow'))}</div>
        <div class="${tTab === 'about' ? 'on' : ''}" data-action="set-settings-tab" data-tab="about">${escapeHtml(t('settings_tab_about'))}</div>
      </div>
      ${pane}
    </div>
    ${models || agents ? renderModelPop(ctx) : ''}
    ${agents ? renderAgentSkillsPop(agentCtx()) : ''}
  `;
  if (models) mountModelsPane(state, t);
  if (agents) mountAgentsPane(state);
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

  if (tab === 'plugins') {
    const query = state.pluginQuery || '';
    const list = (state.plugins || []).filter((item) => matchesCatalogQuery(item, query));
    return `
      <h2>${escapeHtml(t('settings_tab_plugins'))}</h2>
      <div style="display:flex;gap:10px;margin-bottom:18px">
        <div style="flex:1;display:flex;align-items:center;gap:8px;border:1px solid var(--border-strong);border-radius:8px;padding:9px 12px;font-size:13px;color:var(--text-muted);background:var(--bg-surface)">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
          <input type="text" id="plugin-search-input" value="${escapeHtml(query)}" placeholder="${escapeHtml(t('search_plugins_placeholder'))}" style="border:none;background:transparent;outline:none;width:100%;color:var(--text-primary);font-size:13px;" />
        </div>
        <button class="btn p" data-action="open-import-plugin" style="padding:0 14px;border-radius:8px">${escapeHtml(t('btn_import_plugin'))}</button>
      </div>
      <div id="plugins-grid" style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px">
        ${renderPluginsListHtml(list, Boolean(catalogQuery(query)))}
      </div>
    `;
  }

  if (tab === 'skills') {
    const query = state.skillQuery || '';
    const list = (state.skills || []).filter((item) => matchesCatalogQuery(item, query));
    return `
      <h2>${escapeHtml(t('settings_tab_skills'))}</h2>
      <div style="display:flex;gap:10px;margin-bottom:18px">
        <div style="flex:1;display:flex;align-items:center;gap:8px;border:1px solid var(--border-strong);border-radius:8px;padding:9px 12px;font-size:13px;color:var(--text-muted);background:var(--bg-surface)">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
          <input type="text" id="skill-search-input" value="${escapeHtml(query)}" placeholder="${escapeHtml(t('search_skills_placeholder'))}" style="border:none;background:transparent;outline:none;width:100%;color:var(--text-primary);font-size:13px;" />
        </div>
        <button class="btn p" data-action="open-new-skill" data-testid="btn-new-skill" style="padding:0 14px;border-radius:8px">${escapeHtml(t('btn_new_skill'))}</button>
      </div>
      <div id="skills-grid" style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px">
        ${renderSkillsListHtml(list, Boolean(catalogQuery(query)))}
      </div>
    `;
  }

  if (tab === 'workflow') {
    return renderWorkflowTab(workflowCtx());
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
      const toolNames = (pl.tools || []).map((tool) => tool.name).filter(Boolean);
      const toolLine = toolNames.length ? `${t('plugin_tools_label')}: ${toolNames.join(', ')}` : '';
      const problem = !pl.loaded && (pl.error || pl.errorCode)
        ? describePluginFailure(pl.errorCode, pl.error)
        : '';
      return (
        `<div data-testid="plugin-card" data-plugin-id="${escapeHtml(pl.id)}" style="border:1px solid var(--border-subtle);border-radius:10px;padding:14px;display:flex;flex-direction:column;gap:10px;background:var(--bg-surface)">` +
        `<div style="display:flex;align-items:center;gap:10px">` +
        `<div style="width:30px;height:30px;border-radius:8px;background:var(--bg-surface-subtle);border:1px solid var(--border-subtle);display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:600;color:var(--text-secondary)">${escapeHtml(letter)}</div>` +
        `<b style="font-size:13px;font-weight:500;flex:1">${escapeHtml(pl.name || pl.id)}</b>` +
        `<div class="tg ${isOn ? 'on' : ''}" data-testid="plugin-toggle" data-action="toggle-plugin" data-plugin-id="${escapeHtml(pl.id)}" data-enabled="${!isOn}"></div>` +
        `</div>` +
        `<div style="font-size:12px;color:var(--text-secondary);line-height:1.5;min-height:36px">${escapeHtml(pl.description || '')}</div>` +
        (toolLine ? `<div style="font-size:11px;color:var(--text-muted)">${escapeHtml(toolLine)}</div>` : '') +
        (problem ? `<div style="font-size:11px;color:var(--status-failed);line-height:1.4">${escapeHtml(problem)}</div>` : '') +
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
      const isOn = sk.enabled !== false;
      return (
        `<div style="border:1px solid var(--border-subtle);border-radius:10px;padding:14px;display:flex;flex-direction:column;gap:10px;background:var(--bg-surface)">` +
        `<div style="display:flex;align-items:center;gap:10px">` +
        `<div style="width:30px;height:30px;border-radius:8px;background:var(--bg-surface-subtle);border:1px solid var(--border-subtle);display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:600;color:var(--text-secondary)">${escapeHtml(letter)}</div>` +
        `<b style="font-size:13px;font-weight:500;flex:1">${escapeHtml(sk.name || sk.id)}</b>` +
        `<div class="tg ${isOn ? 'on' : ''}" data-action="toggle-skill" data-skill-id="${escapeHtml(sk.id)}" data-enabled="${!isOn}"></div>` +
        `</div>` +
        `<div style="font-size:12px;color:var(--text-secondary);line-height:1.5;min-height:36px">${escapeHtml(sk.description || '')}</div>` +
        `<div style="font-size:11px;color:var(--text-muted);display:flex;gap:8px"><span>${escapeHtml(pluginSourceLabel(sk.source))}</span>${sk.version ? `<span>·</span><span>${escapeHtml(sk.version)}</span>` : ''}</div>` +
        (sk.deletable ? `<div style="display:flex;justify-content:flex-end"><button type="button" class="btn wf-btn-danger" data-action="delete-skill" data-skill-id="${escapeHtml(sk.id)}" data-skill-name="${escapeHtml(sk.name || sk.id)}" data-testid="skill-delete">${escapeHtml(t('skill_delete'))}</button></div>` : '') +
        `</div>`
      );
    })
    .join('');
}

export function setSettingsTab(tab) {
  closeModelPop(state);
  if (state.agentsUi) state.agentsUi.skillsOpen = false;
  state.activeSettingsTab = tab;
  renderSettingsModal();
  if (tab === 'models') refreshGrokStatus();
  if (tab === 'workflow') refreshWorkflowLists();
  if (tab === 'agents') refreshAgentLists();
}

async function refreshAgentLists() {
  const stamp = (state.agentRefresh = (state.agentRefresh || 0) + 1);
  try {
    const [roles, pipelines, skills, plugins, settings] = await Promise.all([
      api('/api/roles'),
      api('/api/pipelines'),
      api('/api/skills'),
      api('/api/plugins'),
      api('/api/settings'),
    ]);
    if (stamp !== state.agentRefresh) return;
    state.roles = roles;
    state.pipelines = pipelines;
    state.skills = skills;
    state.plugins = plugins;
    state.settings = settings;
    noteSettingsReloaded(state);
  } catch { /* keep existing lists */ }
  if (stamp !== state.agentRefresh) return;
  if (state.activeSettingsTab !== 'agents') return;
  const active = document.activeElement;
  const typing = active && ['ag-name', 'ag-desc', 'ag-prompt', 'ag-search', 'ag-skill-search'].includes(active.id);
  if (!typing) renderSettingsModal();
}

async function refreshWorkflowLists() {
  const stamp = (state.workflowRefresh = (state.workflowRefresh || 0) + 1);
  try {
    const [roles, pipelines] = await Promise.all([api('/api/roles'), api('/api/pipelines')]);
    if (stamp !== state.workflowRefresh) return;
    state.roles = roles;
    state.pipelines = pipelines;
  } catch { /* keep existing lists */ }
  if (stamp !== state.workflowRefresh) return;
  if (state.activeSettingsTab === 'workflow' && !state.workflowEditor) renderSettingsModal();
}

function applyChromeLabels() {
  document.title = 'pi-work';
  applyI18n();
}

export function rerenderI18nSurfaces() {
  applyI18n();
  refreshToasts();
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

export async function togglePlugin(id, enabled) {
  try {
    const saved = await api(`/api/plugins/${encodeURIComponent(id)}`, 'PUT', { enabled });
    const p = state.plugins.find((item) => item.id === id);
    if (p && saved && typeof saved === 'object') Object.assign(p, saved);
    else if (p) p.enabled = enabled;
    renderSettingsModal();
  } catch (err) {
    showToast(extensionError(err, 'err_plugin_update'));
  }
}

export async function deleteSkill(id, name) {
  if (!id) return;
  const ok = await confirmDialog({
    message: t('skill_confirm_delete', { name: name || id }),
    danger: true,
    confirmLabel: t('skill_delete'),
  });
  if (!ok) return;
  try {
    await api(`/api/skills/${encodeURIComponent(id)}`, 'DELETE');
    state.skills = (state.skills || []).filter((item) => item.id !== id);
    showToast('skill_deleted');
    renderSettingsModal();
  } catch (err) {
    showToast(extensionError(err, 'err_skill_save'));
  }
}

export async function toggleSkill(id, enabled) {
  try {
    const saved = await api(`/api/skills/${encodeURIComponent(id)}`, 'PUT', { enabled });
    const skill = state.skills.find((item) => item.id === id);
    if (skill && saved && typeof saved === 'object') Object.assign(skill, saved);
    else if (skill) skill.enabled = enabled;
    renderSettingsModal();
  } catch (err) {
    showToast(extensionError(err, 'err_skill_save'));
  }
}

export function filterPlugins(q) {
  state.pluginQuery = q;
  const grid = document.getElementById('plugins-grid');
  if (!grid) return;
  const query = catalogQuery(q);
  const filtered = (state.plugins || []).filter((item) => matchesCatalogQuery(item, query));
  grid.innerHTML = renderPluginsListHtml(filtered, Boolean(query));
}

export function filterSkills(q) {
  state.skillQuery = q;
  const grid = document.getElementById('skills-grid');
  if (!grid) return;
  const query = catalogQuery(q);
  const filtered = (state.skills || []).filter((item) => matchesCatalogQuery(item, query));
  grid.innerHTML = renderSkillsListHtml(filtered, Boolean(query));
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

let confirmPending = null;

export function confirmDialog({ message, title, confirmLabel, cancelLabel, danger = false } = {}) {
  if (confirmPending) return Promise.resolve(false);
  const titleText = title || t(danger ? 'confirm_delete_title' : 'confirm_title');
  const okText = confirmLabel || t(danger ? 'btn_delete' : 'btn_confirm');
  const cancelText = cancelLabel || t('btn_cancel');
  return new Promise((resolve) => {
    confirmPending = resolve;
    openModal(
      `<div class="modal-dialog confirm-dialog${danger ? ' is-danger' : ''}" role="alertdialog" aria-modal="true" aria-labelledby="confirm-dialog-title" aria-describedby="confirm-dialog-message" data-testid="confirm-dialog" data-danger="${danger ? 'true' : 'false'}">` +
      `<h3 id="confirm-dialog-title">${escapeHtml(titleText)} <span style="cursor:pointer;color:var(--text-muted)" data-action="confirm-cancel" aria-label="${escapeHtml(cancelText)}">×</span></h3>` +
      `<p id="confirm-dialog-message" class="confirm-message" data-testid="confirm-message">${escapeHtml(message || '')}</p>` +
      `<div class="modal-actions">` +
      `<button type="button" class="btn" data-action="confirm-cancel" data-testid="confirm-cancel">${escapeHtml(cancelText)}</button>` +
      `<button type="button" class="btn ${danger ? 'danger' : 'p'}" data-action="confirm-ok" data-testid="confirm-ok">${escapeHtml(okText)}</button>` +
      `</div></div>`,
    );
    const focusEl = document.querySelector(danger ? '[data-testid="confirm-cancel"]' : '[data-testid="confirm-ok"]');
    focusEl?.focus();
  });
}

function finishConfirm(ok) {
  const pending = confirmPending;
  confirmPending = null;
  const ov = document.getElementById('dialog-overlay');
  if (ov) {
    ov.style.display = 'none';
    ov.innerHTML = '';
  }
  if (pending) pending(Boolean(ok));
}

export function closeModal() {
  if (confirmPending) {
    finishConfirm(false);
    return;
  }
  const ov = document.getElementById('dialog-overlay');
  if (ov) ov.style.display = 'none';
}

function isSupportedGitUrl(url) {
  const s = String(url || '').trim();
  if (/^https?:\/\//i.test(s)) return true;
  if (/^ssh:\/\//i.test(s)) return true;
  if (/^git@[^\s:]+:\S+$/.test(s)) return true;
  return false;
}

const GIT_IMPORT_CODE_KEYS = {
  git_not_found: 'ws_err_git_not_found',
  auth_failed: 'ws_err_git_auth',
  cert_failed: 'ws_err_git_cert',
  repo_not_found: 'ws_err_git_repo',
  branch_not_found: 'ws_err_git_branch',
  network: 'ws_err_git_network',
  timeout: 'ws_err_git_timeout',
  unknown: 'ws_err_git_unknown',
};

function friendlyWorkspaceError(err) {
  const code = err?.body?.code;
  const key = GIT_IMPORT_CODE_KEYS[code];
  if (key) {
    const text = t(key);
    if (code === 'unknown') {
      const detail = String(err?.body?.detail || '').trim();
      return detail ? `${text}\n${detail}` : text;
    }
    return text;
  }
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

// 新对话不弹窗：进入草稿状态，发出第一条消息时才真正创建
export async function startNewConversation(wid) {
  const target = wid || state.activeWorkspaceId;
  if (!target) {
    showToast('err_select_workspace');
    return;
  }
  state.draft = { roleId: '', pipelineId: '' };
  if (state.activeWorkspaceId !== target) {
    await selectWorkspace(target, { draft: true });
  } else if (state.activeConversationId) {
    if (state.eventSource) {
      state.eventSource.close();
      state.eventSource = null;
    }
    state.activeConversationId = null;
    state.activeConversationData = null;
    localStorage.removeItem('piwork_active_conv');
    resetRightPanelAndStatus();
    renderConversations();
    renderChatThread();
  }
  closeAgentMenu();
  renderStatusBar();
  document.querySelector('[data-testid="chat-input"]')?.focus();
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
        <label>${escapeHtml(t('plugin_path_label'))}</label>
        <input id="plug-path-input" data-testid="plugin-path-input" placeholder="${escapeHtml(t('plugin_path_placeholder'))}" />
      </div>
      <p style="margin:0;font-size:12px;line-height:1.45;color:var(--text-muted)">${escapeHtml(t('plugin_path_hint'))}</p>
      <div id="plug-modal-error" class="modal-inline-error" role="alert" data-testid="plugin-import-error"></div>
      <div class="modal-actions">
        <button type="button" class="btn" data-action="close-modal">${escapeHtml(t('btn_cancel'))}</button>
        <button type="button" class="btn p" data-action="submit-import-plugin" data-testid="plugin-import-submit">${escapeHtml(t('btn_import_plugin'))}</button>
      </div>
    </div>
  `);
  document.getElementById('plug-path-input')?.focus();
}

let pluginImporting = false;

export async function submitImportPlugin() {
  if (pluginImporting) return;
  const pluginPath = document.getElementById('plug-path-input')?.value.trim();
  if (!pluginPath) {
    showModalError('plug-modal-error', t('err_plugin_path_required'));
    return;
  }
  pluginImporting = true;
  const btn = document.querySelector('[data-testid="plugin-import-submit"]');
  if (btn) btn.disabled = true;
  try {
    const pl = await api('/api/plugins', 'POST', { path: pluginPath });
    showToast('plugin_imported', { name: pl.name || pl.id });
    closeModal();
    try {
      state.plugins = await api('/api/plugins');
    } catch {
      const rest = (state.plugins || []).filter((item) => item.id !== pl.id);
      state.plugins = [...rest, pl];
    }
    renderSettingsModal();
  } catch (err) {
    showModalError('plug-modal-error', extensionError(err, 'err_import'));
    if (btn) btn.disabled = false;
  } finally {
    pluginImporting = false;
  }
}

export function openNewSkillModal() {
  openModal(`
    <div class="modal-dialog">
      <h3>${escapeHtml(t('skill_new_title'))} <span style="cursor:pointer;color:var(--text-muted)" data-action="close-modal">×</span></h3>
      <div class="form-group">
        <label>${escapeHtml(t('skill_name_label'))}</label>
        <input id="skill-name-input" data-testid="skill-name-input" placeholder="${escapeHtml(t('skill_name_placeholder'))}" />
      </div>
      <div class="form-group">
        <label>${escapeHtml(t('skill_desc_label'))}</label>
        <input id="skill-desc-input" placeholder="${escapeHtml(t('skill_desc_placeholder'))}" />
      </div>
      <div class="form-group">
        <label>${escapeHtml(t('skill_body_label'))}</label>
        <textarea id="skill-body-input" data-testid="skill-body-input" rows="6" placeholder="${escapeHtml(t('skill_body_placeholder'))}"></textarea>
      </div>
      <div id="skill-modal-error" class="modal-inline-error"></div>
      <div class="modal-actions">
        <button class="btn" data-action="close-modal">${escapeHtml(t('btn_cancel'))}</button>
        <button class="btn p" data-action="submit-new-skill" data-testid="skill-create-submit">${escapeHtml(t('btn_new_skill'))}</button>
      </div>
    </div>
  `);
}

export async function submitNewSkill() {
  const name = document.getElementById('skill-name-input')?.value.trim();
  const description = document.getElementById('skill-desc-input')?.value.trim();
  const body = document.getElementById('skill-body-input')?.value.trim();
  if (!name) {
    showModalError('skill-modal-error', t('skill_name_required'));
    return;
  }
  if (!body) {
    showModalError('skill-modal-error', t('skill_body_required'));
    return;
  }
  try {
    const created = await api('/api/skills', 'POST', { name, description, body });
    showToast('skill_created', { name: created?.name || name });
    closeModal();
    state.skills = await api('/api/skills');
    renderSettingsModal();
  } catch (err) {
    showModalError('skill-modal-error', extensionError(err, 'err_skill_save'));
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
  startGrokSignIn,
  logoutGrok,
  cancelGrokLogin,
  togglePlugin,
  toggleSkill,
  filterPlugins,
  filterSkills,
  startNewConversation,
  openNewWorkspaceModal,
  toggleWsModalTab,
  submitWorkspaceModal,
  openImportPluginModal,
  submitImportPlugin,
  openNewSkillModal,
  submitNewSkill,
  closeModal,
  toggleToolDetail,
  toggleSubagent,
  handleUnauthorized,
};

// ============================================================================
// Event Delegation
// ============================================================================
document.addEventListener('click', (e) => {
  const ui = state.modelsUi;
  if (ui?.pickerRole && !e.target.closest?.('.model-pop') && !e.target.closest?.('[data-action="toggle-model-pick"]')) {
    closeModelPop(state);
  }
  const agentsUi = state.agentsUi;
  if (agentsUi?.skillsOpen && !e.target.closest?.('.ag-skpop') && !e.target.closest?.('[data-action="ag-skills-open"]')) {
    agentsUi.skillsOpen = false;
    document.getElementById('ag-skpop')?.classList.remove('open');
  }
  const agentMenu = document.getElementById('composer-agent-menu');
  if (agentMenu?.classList.contains('is-open') && !e.target.closest('#composer-agent-wrap')) {
    closeAgentMenu();
  }
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
      startNewConversation(actionEl.getAttribute('data-ws-id'));
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
    case 'toggle-tool-group':
      toggleToolGroup(actionEl.getAttribute('data-group-id'));
      break;
    case 'expand-tool-output':
      expandToolOutput(actionEl.getAttribute('data-tool-id'));
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
    case 'grok-signin':
      startGrokSignIn();
      break;
    case 'grok-logout':
      logoutGrok();
      break;
    case 'grok-cancel':
      cancelGrokLogin();
      break;
    case 'toggle-plugin':
      togglePlugin(actionEl.getAttribute('data-plugin-id'), actionEl.getAttribute('data-enabled') === 'true');
      break;
    case 'toggle-skill':
      toggleSkill(actionEl.getAttribute('data-skill-id'), actionEl.getAttribute('data-enabled') === 'true');
      break;
    case 'delete-skill':
      deleteSkill(actionEl.getAttribute('data-skill-id'), actionEl.getAttribute('data-skill-name'));
      break;
    case 'open-import-plugin':
      openImportPluginModal();
      break;
    case 'submit-import-plugin':
      submitImportPlugin();
      break;
    case 'open-new-skill':
      openNewSkillModal();
      break;
    case 'submit-new-skill':
      submitNewSkill();
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
    case 'confirm-cancel':
      finishConfirm(false);
      break;
    case 'confirm-ok':
      finishConfirm(true);
      break;
    case 'toggle-subagent':
      toggleSubagent(actionEl.getAttribute('data-agent-id'));
      break;
    case 'open-subagent':
      openSubagent(actionEl.getAttribute('data-agent-id'));
      break;
    case 'close-subagent':
      closeSubagentView();
      break;
    case 'fork-history':
      forkFromHistory();
      break;
    case 'toggle-agent-picker':
      toggleAgentMenu();
      break;
    case 'pick-dispatch':
      pickDispatchTarget(actionEl);
      break;
    default:
      if (action === 'toggle-model-pick' || (action && action.startsWith('ms-'))) {
        void handleModelsAction(action, actionEl, modelsCtx()).catch((err) => {
          showToast(err?.message || 'err_save');
        });
        break;
      }
      if (action && action.startsWith('ag-')) {
        void handleAgentAction(action, actionEl, agentCtx()).catch((err) => {
          showToast(err?.message || 'err_save');
        });
        break;
      }
      handleWorkflowAction(action, actionEl, workflowCtx());
      break;
  }
});

document.addEventListener('submit', (e) => {
  if (e.target?.id === 'workflow-form') e.preventDefault();
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'plugin-search-input') {
    filterPlugins(e.target.value);
  } else if (e.target.id === 'skill-search-input') {
    filterSkills(e.target.value);
  } else if (e.target.id === 'workflow-search-input') {
    filterWorkflow(e.target.value, workflowCtx());
  } else if (e.target.id === 'ms-name' || e.target.id === 'ms-url' || e.target.id === 'ms-key' || e.target.id === 'ms-manual' || e.target.id === 'ms-grok-name' || e.target.id === 'ms-search') {
    onModelsField(e.target, modelsCtx());
  } else if (e.target.id === 'ag-search') {
    filterAgents(e.target.value, agentCtx());
  } else if (e.target.id === 'ag-name' || e.target.id === 'ag-desc' || e.target.id === 'ag-prompt' || e.target.id === 'ag-skill-search') {
    onAgentField(e.target, agentCtx());
  }
});

document.addEventListener('change', (e) => {
  if (e.target?.matches?.('[data-action="ms-toggle-model"]')) onModelsToggle(e.target, modelsCtx());
  else if (e.target?.matches?.('[data-testid="agent-tool-check"]')) onAgentToolChange(e.target, agentCtx());
  else if (e.target?.matches?.('[data-testid="agent-skill-check"]')) onAgentSkillChange(e.target, agentCtx());
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
    if (e.key === 'Enter' && e.target?.id === 'plug-path-input') {
      e.preventDefault();
      submitImportPlugin();
      return;
    }
    if (e.key === 'Escape') {
      if (confirmPending) {
        finishConfirm(false);
        return;
      }
      closeAgentMenu();
      closeSettings();
      closeModal();
    }
  });

  applyI18n();
  await loadInitialData();
  applyChromeLabels();
});
