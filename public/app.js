import { t, tPlural, getLocale, setLocale, applyI18n, translations } from './i18n.js';
import {
  clipOutputText,
  isProbeFailure,
  isRealToolFailure,
  parseToolOutput,
  relativizePath,
  relativizeText,
  summarizeToolGroup,
  toolDiffCounts,
  toolFocus,
  toolGroupKey,
  toolKind,
  toolResultHint,
  toolRowHeading,
  toolStatusBucket,
  unwrapHarnessDiagnostics,
  TOOL_ERROR_PREVIEW_LINES,
  toolGroupPreview,
} from './tool-groups.js';
import {
  composerContextChip,
  contextOverrideKey,
  contextWindowPresetOptions,
  parseContextOverrideKey,
  resolveContextWindow,
  sourceDefaultContextWindow,
} from './usage.js';
import {
  composerAgentPresentation,
  resolveConversationModel,
  resolveDispatchModel,
  resolveRoleTarget,
  sourceUsable,
} from './agent-chip.js';
import {
  renderModelsPane,
  renderModelPop,
  mountModelsPane,
  handleModelsAction,
  onModelsField,
  onModelsToggle,
  closeModelPop,
  closeContextWindowPop,
  renderContextWindowPop,
  noteSettingsReloaded,
} from './model-settings.js';
import { renderGitPane, handleGitAction, onGitField, onGitTokenFocus } from './git-settings.js';
import {
  resetGitImport,
  activateGitImport,
  renderGitImportBody,
  gitImportPayload,
  gitImportProgressText,
  gitImportCloneMessage,
  handleGitImportAction,
  onGitImportInput,
  gitImportSource,
  closeGitImportPops,
} from './git-import-ui.js';
import {
  applyStreamDelta,
  applyMessageDone,
  dropStreamingResidues,
  mergeRefreshedMessages,
  statusKeepsStreaming,
} from './stream.js';
import { isPromptUserMessage, MANUAL_CONTINUE_TEXT } from './continuation.js';
import { renderMarkdown } from './markdown.js';

// Application State
const state = {
  workspaces: [],
  activeWorkspaceId: null,
  conversations: [],
  activeConversationId: null,
  activeConversationData: null,
  // 尚未创建的新对话（草稿）选好的模型，发出第一条消息时随创建请求带上
  draft: { modelSourceId: '', modelId: '' },
  activeRightTab: 'diff', // 'diff' | 'file' | 'markdown' | 'editor' | 'agent'
  changes: [],
  activeFilePath: null,
  activeDiff: null,
  activeFileContent: null,
  userPickedFile: false,
  settings: {},
  plugins: [],
  skills: [],
  pluginQuery: '',
  skillQuery: '',
  about: {},
  allConversations: {}, // { [wid]: [conv, ...] }
  allRunningList: [],
  eventSource: null,
  unauthorized: false,
  theme: localStorage.getItem('weft_theme') || 'white',
  appearance: localStorage.getItem('weft_appearance') || 'light',
  fontSize: localStorage.getItem('weft_font_size') || 'md',
  activeSettingsTab: 'general',
  expandedTools: new Set(),
  expandedToolGroups: new Set(),
  expandedToolOutputs: new Set(),
  collapsedToolDetails: new Set(),
  expandedToolGroupOlder: new Set(),
  viewingAgentId: null,
  viewingAgent: null,
  subagentPickerOpen: false,
  subagentPickerAnimate: false,
  collapsedSubagentTrees: new Set(),
  pendingSubagentNudges: {},
  subagentDrafts: {},
  workspaceTree: [],
  workspaceTreeFor: null,
  treeLoadingFor: null,
  treeGen: 0,
  allowedWorkspaceRoot: '',
  // Layout (prototype): side panels, widths, which projects are expanded
  // Below the overlay widths a side panel floats over the chat, so it starts closed there.
  leftOpen: window.innerWidth >= 860 ? readPref('weft_left_open', true) : false,
  rightOpen: window.innerWidth >= 1180 ? readPref('weft_right_open', true) : false,
  leftW: clampNum(Number(localStorage.getItem('weft_left_w')) || 264, 200, 420),
  rightW: clampNum(Number(localStorage.getItem('weft_right_w')) || 440, 320, 900),
  openProjects: new Set(readJson('weft_open_projects', [])),
  diffs: {},
  closedChangeFiles: new Set(),
  contextWindowOverrides: {},
};

function readPref(key, fallback) {
  const v = localStorage.getItem(key);
  if (v === 'true') return true;
  if (v === 'false') return false;
  return fallback;
}

function readJson(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key) || 'null');
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

function clampNum(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

let runningPollInterval = null;
let convMetaRefreshTimer = null;
let workspaceTreeRefreshTimer = null;
let subagentPollTimer = null;
let viewingRefreshTimer = null;
let subagentClockTimer = null;
let lastSidebarSig = '';
const subagentRowFx = new Map();

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
  if (diffSec < 3600) return t('min_ago', { n: Math.max(1, Math.round(diffSec / 60)) });
  if (diffSec < 86400) return t('hour_ago', { n: Math.floor(diffSec / 3600) });
  const then = new Date(n);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.ceil((today.getTime() - then.getTime()) / 86400000);
  if (days <= 1) return t('yesterday');
  if (days < 7) return t(`weekday_${then.getDay()}`);
  if (days < 30) return t('day_ago', { n: days });
  return t('date_md', { m: then.getMonth() + 1, d: then.getDate() });
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
// Two families from the design prototype: white = 石墨, claude = 陶土. Older ids fall back to 石墨.
const THEME_FAMILIES = new Set(['white', 'claude']);

export function applyTheme(family = state.theme, mode = state.appearance) {
  if (!THEME_FAMILIES.has(family)) family = 'white';
  state.theme = family;
  state.appearance = mode;
  localStorage.setItem('weft_theme', family);
  localStorage.setItem('weft_appearance', mode);

  let effectiveMode = mode;
  if (mode === 'system') {
    effectiveMode = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  const themeAttr = `${family}-${effectiveMode}`;
  document.documentElement.setAttribute('data-theme', themeAttr);
  document.documentElement.setAttribute('data-font-size', state.fontSize);
  renderModeToggle();
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

  const savedWsId = localStorage.getItem('weft_active_ws');
  if (savedWsId && state.workspaces.some((w) => w.id === savedWsId)) {
    state.activeWorkspaceId = savedWsId;
  } else if (state.workspaces.length > 0) {
    state.activeWorkspaceId = state.workspaces[0].id;
  } else {
    state.activeWorkspaceId = null;
  }
  openProject(state.activeWorkspaceId);

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

  const savedCid = localStorage.getItem('weft_active_conv');
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
  openProject(wid);
  state.workspaceTree = [];
  state.workspaceTreeFor = null;
  state.treeLoadingFor = null;
  state.treeGen += 1;
  localStorage.setItem('weft_active_ws', wid);
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
  const changed = new Set(changesWithDiff(state.changes).map((c) => c.path));
  const dirChev = '<svg class="ws-chev is-open" viewBox="0 0 12 12" aria-hidden="true" style="transform:rotate(90deg)"><path d="M4.5 3l3 3-3 3"></path></svg>';
  return state.workspaceTree.map((ent) => {
    const depth = String(ent.path || '').split('/').length - 1;
    const name = String(ent.path || '').split('/').pop();
    const pad = 8 + depth * 14;
    const title = escapeHtml(ent.path || name);
    if (ent.type === 'dir') {
      return `<div class="file-tree-row is-dir" style="padding-left:${pad}px" title="${title}"><span class="file-tree-icon">${dirChev}</span><span class="file-tree-name">${escapeHtml(name)}</span></div>`;
    }
    const active = ent.path === state.activeFilePath ? ' active' : '';
    const mod = changed.has(ent.path) ? '<span class="file-tree-mod">M</span>' : '';
    return `<button type="button" class="file-tree-row${active}" style="padding-left:${pad}px" title="${title}" data-testid="workspace-file" data-action="load-workspace-file" data-path="${escapeHtml(ent.path)}"><span class="file-tree-icon"></span><span class="file-tree-name">${escapeHtml(name)}</span>${mod}</button>`;
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
// bash-created paths, including when the tool row was missed.
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
  localStorage.setItem('weft_active_conv', cid);
  state.activeConversationData = null;
  state.diffs = {};
  state.closedChangeFiles = new Set();
  state.forceThreadBottom = true;
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

  const savedTab = localStorage.getItem('weft_active_right_tab') || 'diff';
  state.activeRightTab = savedTab === 'agent' || savedTab === 'markdown' ? 'diff' : savedTab;
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

  refreshChangeDiffs();
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
          if (item.status) state.activeConversationData.status = item.status;
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
    if (conv.status) state.activeConversationData.status = conv.status;
    if (conv.status === 'failed') {
      if (conv.llmError) state.activeConversationData.llmError = conv.llmError;
    } else if (conv.status) {
      state.activeConversationData.llmError = null;
    }
    if (conv.usage) state.activeConversationData.usage = conv.usage;
    if (conv.contextWindow != null) state.activeConversationData.contextWindow = conv.contextWindow;
    if ('modelSourceId' in conv) state.activeConversationData.modelSourceId = conv.modelSourceId || null;
    if ('modelId' in conv) state.activeConversationData.modelId = conv.modelId || null;
    if (conv.contextWindow != null) {
      state.activeConversationData.contextWindowModel = resolveComposerTarget()?.model || '';
    }
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
  sse.onopen = () => {
    refreshConversationMeta(cid);
  };

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
        if (data.title) {
          state.activeConversationData.title = data.title;
          const item = state.conversations.find((c) => c.id === cid);
          if (item) item.title = data.title;
        }
        if (data.status && data.status !== 'failed' && state.activeConversationData.llmError) {
          state.activeConversationData.llmError = null;
        }
        renderStatusBar();
        renderChatThread();
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
      if (data.id && data.id === state.viewingAgentId && state.viewingAgent) {
        state.viewingAgent = { ...state.viewingAgent, ...data };
      }
      renderConversations();
      renderChatThread();
      if (state.activeRightTab === 'agent') {
        renderRightPanel();
        if (data.id && data.id === state.viewingAgentId) scheduleViewingAgentRefresh(cid);
      }
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
          if (state.activeConversationId !== cid) return;
          state.changes = Array.isArray(changes) ? changes : [];
          const visible = changesWithDiff(state.changes);
          const toolPath = tool?.path || tool?.input?.path || null;
          if (toolPath) delete state.diffs[toolPath];
          for (const key of Object.keys(state.diffs)) {
            if (!visible.some((c) => c.path === key)) delete state.diffs[key];
          }
          const newest = visible.length ? visible[visible.length - 1].path : null;
          const stillExists = state.activeFilePath && visible.some((c) => c.path === state.activeFilePath);
          if (!state.userPickedFile || !stillExists) {
            state.userPickedFile = false;
            state.activeFilePath = (toolPath && visible.some((c) => c.path === toolPath)) ? toolPath : newest;
          }
          renderRightPanel();
          refreshChangeDiffs();
          if (state.activeFilePath && state.activeRightTab !== 'diff' && state.activeRightTab !== 'agent') loadFileOrDiff(state.activeFilePath);
        })
        .catch(() => {});
    } catch { /* ignore */ }
  });

  sse.addEventListener('usage', (ev) => {
    try {
      const data = JSON.parse(ev.data);
      if (!state.activeConversationData || state.activeConversationId !== cid) return;
      if (data.usage) state.activeConversationData.usage = data.usage;
      if (data.contextWindow != null) {
        state.activeConversationData.contextWindow = data.contextWindow;
        state.activeConversationData.contextWindowModel = resolveComposerTarget()?.model || '';
      }
      renderStatusBar();
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

  const activeStatuses = new Set(['running']);
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
  const activeStatuses = new Set(['running']);
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
  if (!state.activeConversationId) {
    // 没有选中的对话时，直接发送即新建一个对话；失败则把内容放回输入框
    const { modelSourceId, modelId } = state.draft;
    const conv = await createNewConversation({ modelSourceId, modelId });
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
    state.forceThreadBottom = true;
    renderChatThread();
    renderStatusBar();
  }

  updateConversationStatus(cid, 'running');

  try {
    await api(`/api/conversations/${encodeURIComponent(cid)}/messages`, 'POST', { text });
    scheduleConversationRefresh(cid);
  } catch (err) {
    showToast(err.message || 'err_send');
    const next = 'failed';
    if (state.activeConversationData && state.activeConversationId === cid) {
      state.activeConversationData.status = next;
      renderStatusBar();
    }
    updateConversationStatus(cid, next);
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
      renderChatThread();
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
  if (opts.modelSourceId && opts.modelId) {
    body.modelSourceId = opts.modelSourceId;
    body.modelId = opts.modelId;
  }
  try {
    const conv = await api(`/api/workspaces/${encodeURIComponent(state.activeWorkspaceId)}/conversations`, 'POST', body);
    await loadConversations(state.activeWorkspaceId);
    state.draft = { modelSourceId: '', modelId: '' };
    if (conv.id) await selectConversation(conv.id);
    return conv;
  } catch (err) {
    showToast(err.message || 'err_create_conversation');
  }
}

export async function loadFileOrDiff(filePath) {
  state.activeFilePath = filePath;
  localStorage.setItem('weft_active_file', filePath);
  const tab = state.activeRightTab;
  const cid = state.activeConversationId;

  if (tab === 'editor' || tab === 'markdown' || tab === 'file') {
    try {
      const fileData = await api(`/api/workspaces/${encodeURIComponent(state.activeWorkspaceId)}/files?path=${encodeURIComponent(filePath)}`);
      state.activeFileContent = fileData.content ?? '';
    } catch {
      state.activeFileContent = '';
    }
  }
  if ((tab === 'diff' || !tab) && cid) {
    state.closedChangeFiles.delete(filePath);
    try {
      const d = await api(`/api/conversations/${encodeURIComponent(cid)}/diff?path=${encodeURIComponent(filePath)}`);
      if (state.activeConversationId !== cid) return;
      state.activeDiff = d;
      state.diffs[filePath] = d;
    } catch {
      state.activeDiff = null;
    }
  }
  renderRightPanel();
}

/** Click on a changed file: select it; clicking the selected one folds or unfolds its diff. */
function toggleChangeFile(filePath) {
  if (!filePath) return;
  state.userPickedFile = true;
  if (state.activeRightTab !== 'diff') state.activeRightTab = 'diff';
  if (state.activeFilePath === filePath && !state.closedChangeFiles.has(filePath)) {
    state.closedChangeFiles.add(filePath);
    renderRightPanel();
    return;
  }
  loadFileOrDiff(filePath);
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
    delete state.diffs[state.activeFilePath];
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
const CHEV_SVG = '<svg class="ws-chev" viewBox="0 0 12 12" aria-hidden="true"><path d="M4.5 3l3 3-3 3"></path></svg>';
const ACTIVE_RUN = new Set(['running']);

function projectConversations(wid) {
  if (wid === state.activeWorkspaceId && Array.isArray(state.conversations)) return state.conversations;
  return state.allConversations[wid] || [];
}

function sortedByRecent(list) {
  return [...list].sort((x, y) => (Number(y.updatedAt) || 0) - (Number(x.updatedAt) || 0));
}

function conversationMeta(conv) {
  const st = conv.status || 'idle';
  if (ACTIVE_RUN.has(st)) {
    const n = (conv.id === state.activeConversationId ? (state.activeConversationData?.agents || []) : [])
      .filter((ag) => isRealSubagent(ag) && ACTIVE_RUN.has(ag.status)).length;
    return { text: n > 0 ? t('agents_running_count', { n: n + 1 }) : t('status_running'), cls: 'is-running' };
  }
  if (st === 'paused' || st === 'waiting') return { text: t(`status_${st}`), cls: 'is-waiting' };
  if (st === 'failed') return { text: t('status_failed'), cls: 'is-failed' };
  return { text: conv.updatedAt ? formatRelativeTime(conv.updatedAt) : '', cls: '', ts: conv.updatedAt };
}

function conversationRowHtml(conv, { wsId = '' } = {}) {
  const isActive = conv.id === state.activeConversationId;
  const status = conv.status || 'idle';
  const meta = conversationMeta(conv);
  const relAttrs = meta.ts ? ` data-rel-time data-ts="${escapeHtml(String(meta.ts))}"` : '';
  const agents = isActive ? listedSubagents(state.activeConversationData?.agents || []) : [];
  const tree = agents.length ? subagentTreeHtml(conv.id, agents) : '';
  const collapsed = state.collapsedSubagentTrees.has(conv.id);
  const orbit = agents.length ? subagentOrbitHtml(agents, Date.now()) : '';
  const toggle = agents.length
    ? `<button type="button" class="subagent-tree-toggle${collapsed ? '' : ' is-open'}" data-testid="subagent-tree-toggle" data-action="toggle-subagent-tree" data-conv-id="${escapeHtml(conv.id)}" aria-label="${escapeHtml(collapsed ? t('subagent_tree_expand') : t('subagent_tree_collapse'))}" aria-expanded="${collapsed ? 'false' : 'true'}">${CHEV_SVG}</button>`
    : '';
  return (
    `<div class="conv-tree-node ${isActive ? 'conv-active' : ''}" data-testid="conversation-item" data-id="${escapeHtml(conv.id)}" data-status="${escapeHtml(status)}">` +
    `<div class="conv-node-header" data-action="switch-ws-conv" data-ws-id="${escapeHtml(wsId)}" data-conv-id="${escapeHtml(conv.id)}" data-ctx="conversation" title="${escapeHtml(conv.title || '')}">` +
    `<span class="status-dot dot-${escapeHtml(status)}"></span>` +
    `<span class="conv-node-title">${escapeHtml(conv.title || t('default_conversation_title'))}</span>` +
    (orbit ? '' : `<span class="conv-node-meta ${meta.cls}"${relAttrs}>${escapeHtml(meta.text || '')}</span>`) +
    orbit +
    toggle +
    `</div>` +
    tree +
    `</div>`
  );
}

function isDraftActive() {
  return Boolean(state.activeWorkspaceId && !state.activeConversationId);
}

function sidebarRenderSignature() {
  const parts = [];
  parts.push(state.activeWorkspaceId || '', state.activeConversationId || '', state.viewingAgentId || '');
  parts.push(isDraftActive() ? '1' : '0');
  parts.push([...state.openProjects].join(','));
  parts.push([...state.collapsedSubagentTrees].join(','));
  for (const ws of state.workspaces) {
    parts.push(ws.id, ws.name, ws.path);
    for (const conv of sortedByRecent(projectConversations(ws.id))) {
      parts.push(conv.id, conv.title || '', conv.status || '', String(conv.updatedAt || ''));
    }
  }
  for (const agent of listedSubagents(state.activeConversationData?.agents || [])) {
    parts.push(
      agent.id || '',
      agent.status || '',
      agent.name || '',
      agent.brief || '',
      agent.lastText || '',
      agent.currentAction || '',
      String(agent.startedAt || ''),
      String(agent.lastActivityAt || ''),
      String(agent.endedAt || ''),
    );
  }
  return parts.join('\x1f');
}

export function renderSidebarWorkspaces() {
  const container = document.getElementById('ws-tree-container');
  if (!container) return;

  const sig = sidebarRenderSignature();
  if (sig === lastSidebarSig && container.childElementCount) {
    tickSubagentClock();
    armSubagentClock();
    renderRightOpenDot();
    return;
  }

  container.innerHTML = state.workspaces
    .map((ws) => {
      const isActive = ws.id === state.activeWorkspaceId;
      const live = sortedByRecent(projectConversations(ws.id));
      const open = state.openProjects.has(ws.id) || (isActive && state.openProjects.size === 0);
      const runN = live.filter((c) => ACTIVE_RUN.has(c.status)).length;
      const count = open ? '' : (runN ? t('running_count', { n: runN }) : (live.length ? String(live.length) : ''));
      const draft = isActive && isDraftActive();
      const rows = live.map((c) => conversationRowHtml(c, { wsId: ws.id })).join('');
      return (
        `<div class="ws-tree-node ${isActive ? 'ws-active' : ''}${open ? ' is-open' : ''}" data-testid="workspace-item" data-id="${escapeHtml(ws.id)}">` +
        `<div class="ws-node-header" data-action="toggle-project" data-ws-id="${escapeHtml(ws.id)}" data-ctx="project" title="${escapeHtml(ws.path)}">` +
        CHEV_SVG +
        `<span class="ws-node-title">${escapeHtml(ws.name)}</span>` +
        `<span class="ws-node-count${runN ? ' is-running' : ''}">${escapeHtml(count)}</span>` +
        `<button type="button" class="btn-icon-xs ws-node-more" data-action="project-menu" data-ws-id="${escapeHtml(ws.id)}" title="${escapeHtml(t('more_actions'))}">⋯</button>` +
        `<button type="button" class="btn-icon-xs ws-node-add" data-testid="conversation-new" data-action="new-conversation" data-ws-id="${escapeHtml(ws.id)}" title="${escapeHtml(t('new_conversation_in', { name: ws.name }))}">+</button>` +
        `</div>` +
        `<div class="ws-node-children"${isActive ? ' id="conv-list-container"' : ''}>` +
        (draft
          ? `<div class="draft-row is-active" data-testid="draft-row"><span class="draft-dot"></span><span class="conv-node-title">${escapeHtml(t('new_conversation'))}</span><span class="conv-node-meta">${escapeHtml(t('draft_label'))}</span></div>`
          : '') +
        rows +
        (!rows && !draft ? `<div class="ws-empty-note">${escapeHtml(t('ws_no_conversations'))}</div>` : '') +
        `</div>` +
        `</div>`
      );
    })
    .join('');
  lastSidebarSig = sig;
  markSubagentRowsEntered();
  armSubagentClock();
  renderRightOpenDot();
}

function renderRightOpenDot() {
  const dot = document.getElementById('right-open-dot');
  if (dot) dot.classList.toggle('is-on', changesWithDiff(state.changes).length > 0);
}

export function isRealSubagent(agent) {
  return String(agent?.id || '').includes(':sub:');
}

function listedSubagents(agents) {
  return (agents || []).filter(isRealSubagent);
}

const SUBAGENT_STATUS_ICON =
  '<svg class="subagent-status-icon" viewBox="0 0 12 12" aria-hidden="true" data-testid="subagent-status-icon">' +
  '<circle class="sa-ring" cx="6" cy="6" r="5" fill="none"></circle>' +
  '<circle class="sa-arc" cx="6" cy="6" r="5" fill="none"></circle>' +
  '<circle class="sa-fill" cx="6" cy="6" r="5"></circle>' +
  '<path class="sa-check" d="M3.55 6.2l1.75 1.75 3.2-3.35" fill="none"></path>' +
  '<rect class="sa-stop" x="4.35" y="4.35" width="3.3" height="3.3" rx="0.45"></rect>' +
  '</svg>';

const SUBAGENT_ENDED = new Set(['done', 'stopped', 'failed']);
const SUBAGENT_LIVE = new Set(['running', 'waiting', 'recovering', 'resuming']);
const SUBAGENT_STUCK_AFTER_MS = 60_000;

function isLiveSubagent(agent) {
  return SUBAGENT_LIVE.has(agent?.status || '');
}

function finiteTs(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function formatMmSs(ms) {
  if (!Number.isFinite(ms)) return '';
  const sec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(sec / 60);
  const ss = String(sec % 60).padStart(2, '0');
  return `${String(m).padStart(2, '0')}:${ss}`;
}

function firstBriefLine(text) {
  const raw = String(text || '');
  if (!raw) return '';
  const line = raw.split(/\r?\n/).map((item) => item.trim()).find(Boolean);
  return String(line || raw).replace(/\s+/g, ' ').trim();
}

function subagentSummary(agent) {
  const fromBrief = firstBriefLine(agent?.brief);
  if (fromBrief) return fromBrief;
  const last = String(agent?.lastText || '').replace(/\s+/g, ' ').trim();
  if (last) return last;
  return realSubagentName(agent);
}

function isSubagentStuck(agent, now) {
  if ((agent?.status || '') !== 'running') return false;
  const last = finiteTs(agent?.lastActivityAt);
  if (!last) return false;
  return now - last > SUBAGENT_STUCK_AFTER_MS;
}

function subagentVisualStatus(agent, now = Date.now()) {
  const st = agent?.status || 'waiting';
  if (st === 'running' && isSubagentStuck(agent, now)) return 'stuck';
  if (st === 'done') return 'done';
  if (st === 'stopped' || st === 'failed') return 'stopped';
  if (SUBAGENT_LIVE.has(st)) return 'running';
  return st || 'waiting';
}

function subagentTimeText(agent, now = Date.now()) {
  const visual = subagentVisualStatus(agent, now);
  if (visual === 'done') return t('status_done');
  if (visual === 'stopped') return (agent?.status || '') === 'failed' ? t('status_failed') : t('status_stopped');
  if (visual === 'stuck') {
    const last = finiteTs(agent?.lastActivityAt);
    const clock = last ? formatMmSs(now - last) : '';
    return clock ? t('subagent_idle_for', { time: clock }) : '';
  }
  const started = finiteTs(agent?.startedAt);
  if (!started) return '';
  return formatMmSs(now - started);
}

function subagentActionText(agent, visual) {
  if (visual !== 'running' && visual !== 'stuck') return '';
  return String(agent?.currentAction || '').replace(/\s+/g, ' ').trim();
}

function noteSubagentRowFx(agents) {
  const now = Date.now();
  const ids = new Set();
  for (const agent of agents) {
    const id = agent.id || '';
    if (!id) continue;
    ids.add(id);
    const st = agent.status || 'waiting';
    let fx = subagentRowFx.get(id);
    if (!fx) {
      subagentRowFx.set(id, { entered: false, endedHighlightUntil: 0, lastStatus: st });
      continue;
    }
    if (SUBAGENT_ENDED.has(st) && SUBAGENT_LIVE.has(fx.lastStatus)) fx.endedHighlightUntil = now + 1600;
    fx.lastStatus = st;
  }
  for (const id of [...subagentRowFx.keys()]) {
    if (!ids.has(id)) subagentRowFx.delete(id);
  }
}

function markSubagentRowsEntered() {
  for (const fx of subagentRowFx.values()) fx.entered = true;
}

function subagentRowFxClass(id) {
  const fx = subagentRowFx.get(id);
  const bits = [];
  if (!fx || !fx.entered) bits.push('is-entering');
  if (fx && fx.endedHighlightUntil > Date.now()) bits.push('is-just-ended');
  return bits.length ? ` ${bits.join(' ')}` : '';
}

function subagentOrbitHtml(agents, now) {
  const live = agents.filter(isLiveSubagent).length;
  const allEnded = agents.length > 0 && live === 0;
  const sats = agents.map((agent, i) => {
    const visual = subagentVisualStatus(agent, now);
    const dur = (1.6 + 0.45 * i).toFixed(2);
    const delay = (-((i * 137) % 360) / 360 * (1.6 + 0.45 * i)).toFixed(3);
    return `<span class="subagent-orbit-track" data-sat="${escapeHtml(visual)}" style="--sat-dur:${dur}s;--sat-delay:${delay}s"><span class="subagent-orbit-sat"></span></span>`;
  }).join('');
  const count = allEnded
    ? t('subagent_orbit_done', { n: agents.length })
    : t('subagent_orbit_frac', { live, total: agents.length });
  return (
    `<span class="subagent-orbit-cluster" data-testid="subagent-orbit-cluster" data-action="noop">` +
    `<span class="subagent-orbit${allEnded ? ' is-done' : ''}" data-testid="subagent-orbit" aria-hidden="true">` +
    `<span class="subagent-orbit-core"></span>${sats}</span>` +
    `<span class="subagent-orbit-count ${allEnded ? 'is-done' : 'is-running'}" data-testid="subagent-orbit-count">${escapeHtml(count)}</span>` +
    `</span>`
  );
}

function subagentTreeRowHtml(agent) {
  const now = Date.now();
  const st = agent.status || 'waiting';
  const visual = subagentVisualStatus(agent, now);
  const summary = subagentSummary(agent);
  const time = subagentTimeText(agent, now);
  const action = subagentActionText(agent, visual);
  const open = state.viewingAgentId === agent.id;
  const fx = subagentRowFxClass(agent.id || '');
  const title = summary || t('subagent_open_title');
  return (
    `<div class="subagent-tree-row-shell${fx}">` +
    `<div class="subagent-tree-row-shell-inner">` +
    `<div class="subagent-tree-row${open ? ' is-active' : ''}${visual === 'stuck' ? ' is-stuck' : ''}${fx.includes('is-just-ended') ? ' is-just-ended' : ''}" data-testid="subagent-tree-row" data-agent-id="${escapeHtml(agent.id || '')}" data-depth="0" data-status="${escapeHtml(st)}" data-visual="${escapeHtml(visual)}" data-action="open-subagent" data-ctx="subagent" title="${escapeHtml(title)}">` +
    SUBAGENT_STATUS_ICON +
    `<div class="subagent-tree-main">` +
    `<div class="subagent-tree-line">` +
    `<span class="subagent-tree-summary" data-testid="subagent-tree-summary">${escapeHtml(summary)}</span>` +
    `<span class="subagent-tree-time${visual === 'stuck' ? ' is-idle' : ''}" data-testid="subagent-tree-time">${escapeHtml(time)}</span>` +
    `</div>` +
    `<div class="subagent-tree-action-slot${action ? ' is-open' : ''}">` +
    `<div class="subagent-tree-action-clip">` +
    (action ? `<div class="subagent-tree-action" data-testid="subagent-tree-action">${escapeHtml(action)}</div>` : '') +
    `</div></div></div></div></div></div>`
  );
}

function subagentTreeHtml(convId, agents) {
  const rows = agents || listedSubagents(state.activeConversationData?.agents || []);
  if (!rows.length) return '';
  noteSubagentRowFx(rows);
  const collapsed = state.collapsedSubagentTrees.has(convId);
  return (
    `<div class="subagent-tree-wrap${collapsed ? '' : ' is-open'}" data-testid="subagent-tree-wrap" data-conv-id="${escapeHtml(convId || '')}">` +
    `<div class="subagent-tree-clip"><div class="subagent-tree">${rows.map(subagentTreeRowHtml).join('')}</div></div>` +
    `</div>`
  );
}

function tickPanelSubagentClocks(byId, now) {
  if (state.activeRightTab !== 'agent') return;
  if (state.viewingAgentId && state.viewingAgent) {
    byId.set(state.viewingAgentId, { ...(byId.get(state.viewingAgentId) || {}), ...state.viewingAgent });
  }
  let restyle = false;
  document.querySelectorAll('[data-testid="subagent-card"], [data-testid="subagent-banner"]').forEach((el) => {
    const agent = byId.get(el.getAttribute('data-agent-id'));
    if (!agent) return;
    if (el.getAttribute('data-visual') !== subagentVisualStatus(agent, now)) restyle = true;
  });
  if (restyle) {
    renderRightPanel();
    return;
  }
  document.querySelectorAll('[data-subagent-time]').forEach((el) => {
    const agent = byId.get(el.getAttribute('data-subagent-time'));
    if (!agent) return;
    const next = subagentTimeText(agent, now);
    if (el.textContent !== next) el.textContent = next;
  });
}

function tickSubagentClock() {
  const now = Date.now();
  const agents = listedSubagents(state.activeConversationData?.agents || []);
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  document.querySelectorAll('[data-testid="subagent-tree-row"]').forEach((row) => {
    const agent = byId.get(row.getAttribute('data-agent-id'));
    if (!agent) return;
    const visual = subagentVisualStatus(agent, now);
    if (row.getAttribute('data-visual') !== visual) row.setAttribute('data-visual', visual);
    row.classList.toggle('is-stuck', visual === 'stuck');
    const timeEl = row.querySelector('[data-testid="subagent-tree-time"]');
    const nextTime = subagentTimeText(agent, now);
    if (timeEl && timeEl.textContent !== nextTime) timeEl.textContent = nextTime;
    timeEl?.classList.toggle('is-idle', visual === 'stuck');
    const slot = row.querySelector('.subagent-tree-action-slot');
    const action = subagentActionText(agent, visual);
    slot?.classList.toggle('is-open', Boolean(action));
    const actionEl = row.querySelector('[data-testid="subagent-tree-action"]');
    if (actionEl && actionEl.textContent !== action) actionEl.textContent = action;
  });
  tickPanelSubagentClocks(byId, now);
  const cluster = document.querySelector('[data-testid="subagent-orbit-cluster"]');
  if (!cluster) return;
  const live = agents.filter(isLiveSubagent).length;
  const allEnded = agents.length > 0 && live === 0;
  cluster.querySelector('[data-testid="subagent-orbit"]')?.classList.toggle('is-done', allEnded);
  cluster.querySelectorAll('.subagent-orbit-track').forEach((track, i) => {
    const agent = agents[i];
    if (!agent) return;
    const visual = subagentVisualStatus(agent, now);
    if (track.getAttribute('data-sat') !== visual) track.setAttribute('data-sat', visual);
  });
  const countEl = cluster.querySelector('[data-testid="subagent-orbit-count"]');
  if (countEl) {
    const count = allEnded
      ? t('subagent_orbit_done', { n: agents.length })
      : t('subagent_orbit_frac', { live, total: agents.length });
    if (countEl.textContent !== count) countEl.textContent = count;
    countEl.classList.toggle('is-running', !allEnded);
    countEl.classList.toggle('is-done', allEnded);
  }
}

function armSubagentClock() {
  const agents = listedSubagents(state.activeConversationData?.agents || []);
  const running = agents.some((agent) => (agent.status || '') === 'running');
  if (!running) {
    if (subagentClockTimer) {
      clearInterval(subagentClockTimer);
      subagentClockTimer = null;
    }
    return;
  }
  if (!subagentClockTimer) {
    subagentClockTimer = setInterval(tickSubagentClock, 1000);
  }
}

function applySubagentPatch(aid, patch) {
  if (!aid || !patch) return;
  const agents = state.activeConversationData?.agents;
  if (Array.isArray(agents)) {
    const idx = agents.findIndex((agent) => agent.id === aid);
    if (idx >= 0) agents[idx] = { ...agents[idx], ...patch };
    else agents.push({ id: aid, ...patch });
  }
  if (state.viewingAgentId === aid && state.viewingAgent) {
    state.viewingAgent = { ...state.viewingAgent, ...patch };
  }
}

function prunePendingNudges(aid, messages) {
  const pending = state.pendingSubagentNudges[aid];
  if (!pending?.length) return;
  const later = (messages || []).filter((m) => m.role === 'user').slice(1).map((m) => String(m.text || ''));
  const used = new Set();
  const next = [];
  for (const item of pending) {
    const idx = later.findIndex((text, i) => text === item.text && !used.has(i));
    if (idx >= 0) used.add(idx);
    else next.push(item);
  }
  state.pendingSubagentNudges[aid] = next;
}

function toggleSubagentTree(convId) {
  if (!convId) return;
  if (state.collapsedSubagentTrees.has(convId)) state.collapsedSubagentTrees.delete(convId);
  else state.collapsedSubagentTrees.add(convId);
  const collapsed = state.collapsedSubagentTrees.has(convId);
  const wrap = document.querySelector(`[data-testid="subagent-tree-wrap"][data-conv-id="${convId.replace(/"/g, '')}"]`);
  const btn = document.querySelector(`[data-testid="subagent-tree-toggle"][data-conv-id="${convId.replace(/"/g, '')}"]`);
  wrap?.classList.toggle('is-open', !collapsed);
  if (btn) {
    btn.classList.toggle('is-open', !collapsed);
    btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    btn.setAttribute('aria-label', collapsed ? t('subagent_tree_expand') : t('subagent_tree_collapse'));
  }
  lastSidebarSig = sidebarRenderSignature();
}

function syncSubagentSendReady() {
  const input = document.querySelector('[data-testid="subagent-input"]');
  const send = document.querySelector('[data-testid="subagent-send"]');
  if (!send) return;
  send.classList.toggle('is-ready', Boolean(input?.value.trim()));
}

async function sendSubagentNudge() {
  const cid = state.activeConversationId;
  const aid = state.viewingAgentId;
  const input = document.querySelector('[data-testid="subagent-input"]');
  const text = (input?.value || state.subagentDrafts[aid] || '').trim();
  if (!cid || !aid || !text) return;
  try {
    await api(`/api/conversations/${encodeURIComponent(cid)}/agents/${encodeURIComponent(aid)}/messages`, 'POST', { text });
    if (input) input.value = '';
    state.subagentDrafts[aid] = '';
    const pending = state.pendingSubagentNudges[aid] || [];
    pending.push({ id: `nudge-${Date.now()}`, text });
    state.pendingSubagentNudges[aid] = pending;
    renderRightPanel();
    scheduleViewingAgentRefresh(cid);
  } catch (err) {
    showToast(err.message || 'err_send');
  }
}

async function stopSubagent() {
  const cid = state.activeConversationId;
  const aid = state.viewingAgentId;
  if (!cid || !aid) return;
  try {
    const res = await api(`/api/conversations/${encodeURIComponent(cid)}/agents/${encodeURIComponent(aid)}/stop`, 'POST');
    applySubagentPatch(aid, { status: res?.status || 'stopped' });
    renderConversations();
    renderChatThread();
    renderRightPanel();
  } catch (err) {
    showToast(err.message || 'err_stop');
  }
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
  const name = String(agent?.name || '').trim();
  if (name) return name;
  const brief = String(agent?.brief || '').trim();
  if (brief) return brief;
  return t('agent_name');
}

function clearSubagentView() {
  state.viewingAgentId = null;
  state.viewingAgent = null;
  state.subagentPickerOpen = false;
  state.subagentPickerAnimate = false;
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
    prunePendingNudges(aid, body.messages || []);
    const agents = state.activeConversationData?.agents;
    if (Array.isArray(agents)) {
      const idx = agents.findIndex((agent) => agent.id === aid);
      if (idx >= 0) {
        const extra = {};
        for (const key of ['brief', 'startedAt', 'endedAt', 'lastActivityAt', 'currentAction', 'step', 'totalSteps', 'lastText']) {
          if (body[key] != null) extra[key] = body[key];
        }
        agents[idx] = {
          ...agents[idx],
          status: body.status || agents[idx].status,
          name: body.name || agents[idx].name,
          ...(body.mode === 'background' || body.mode === 'foreground' ? { mode: body.mode } : {}),
          ...extra,
        };
      }
    }
    renderChatThread();
    renderConversations();
    renderRightPanel();
    scheduleSubagentPoll();
  } catch {
    if (state.activeConversationId === cid && state.viewingAgentId === aid && state.viewingAgent) {
      state.viewingAgent.loading = false;
      renderRightPanel();
    }
  }
}

export async function openSubagent(agentId) {
  if (!isRealSubagent({ id: agentId }) || !state.activeConversationId) return;
  const cid = state.activeConversationId;
  const known = (state.activeConversationData?.agents || []).find((agent) => agent.id === agentId);
  const same = state.viewingAgentId === agentId;
  state.viewingAgentId = agentId;
  state.viewingAgent = {
    ...(known || { id: agentId }),
    messages: same ? (state.viewingAgent?.messages || []) : [],
    loading: true,
  };
  state.subagentPickerOpen = false;
  state.activeRightTab = 'agent';
  setRightOpen(true);
  renderChatThread();
  renderConversations();
  renderRightPanel();
  await refreshViewingAgent(cid, agentId);
}

export function closeSubagentView() {
  if (!state.viewingAgentId) return;
  clearSubagentView();
  if (state.activeRightTab === 'agent') state.activeRightTab = 'diff';
  renderChatThread();
  renderConversations();
  refreshChangeDiffs();
  renderRightPanel();
}

export function renderConversations() {
  renderSidebarWorkspaces();
}

export function renderRunningOverview() {
  renderSidebarWorkspaces();
}

function resolveComposerTarget() {
  const ctx = dispatchContext();
  const pinned = resolveConversationModel(ctx);
  if (pinned) return pinned;
  return resolveRoleTarget({
    models: ctx.models,
    sources: ctx.sources,
    grokSignedIn: ctx.grokSignedIn,
  });
}

function composerContextView() {
  const target = resolveComposerTarget();
  const conv = state.activeConversationId ? state.activeConversationData : null;
  const window = resolveContextWindow({
    model: target?.model || '',
    source: target?.source,
    conversationWindow: conv?.contextWindow,
    conversationWindowModel: conv?.contextWindowModel,
    overrides: state.contextWindowOverrides,
  });
  return {
    target,
    view: composerContextChip({ usage: conv?.usage, window }),
  };
}

function renderComposerContext() {
  const el = document.getElementById('composer-context-value');
  const winEl = document.getElementById('composer-context-window');
  const host = document.getElementById('composer-context');
  const btn = document.getElementById('composer-context-limit-btn');
  const display = document.getElementById('composer-context-display');
  const ring = document.getElementById('composer-context-ring');
  if (!el) return;
  const { target, view } = composerContextView();
  el.replaceChildren();
  const used = document.createElement('span');
  used.className = 'ctx-used';
  used.textContent = t('ctx_used_short', { used: view.usedPct });
  const remainSep = document.createElement('span');
  remainSep.className = 'ctx-remain-sep';
  remainSep.textContent = ' · ';
  const remain = document.createElement('span');
  remain.className = 'ctx-remain';
  remain.textContent = t('ctx_left_short', { left: view.remainPct });
  const winSep = document.createElement('span');
  winSep.className = 'ctx-win-sep';
  winSep.textContent = ' · ';
  el.append(used, remainSep, remain, winSep);
  if (winEl) winEl.textContent = view.windowText;
  if (display) {
    display.title = t('ctx_title', {
      used: view.usedText,
      window: view.windowText,
      usedPct: view.usedPct,
      leftPct: view.remainPct,
    });
  }
  if (host) host.classList.toggle('is-warn', view.warn);
  if (btn) btn.disabled = !target?.model || !target?.source;
  if (ring) {
    const c = 2 * Math.PI * 5;
    ring.setAttribute('stroke-dasharray', `${view.ratio * c} ${c}`);
  }
  const menu = document.getElementById('composer-context-menu');
  if (menu?.classList.contains('is-open')) menu.innerHTML = renderContextMenuHtml();
}

function dispatchContext() {
  return {
    conv: state.activeConversationId ? state.activeConversationData : state.draft,
    models: state.settings?.models || {},
    sources: state.settings?.sources || [],
    grokSignedIn: Boolean(state.settings?.grok?.signedIn),
  };
}

function renderComposerAgent() {
  const label = document.getElementById('composer-agent-chip');
  const btn = document.getElementById('composer-agent-chip-btn');
  if (!label) return;
  const view = composerAgentPresentation(dispatchContext());
  label.textContent = view.model || t('chip_no_model');
  if (btn) {
    btn.title = view.model ? `${t('chip_agent_title')}: ${view.model}` : t('chip_no_model');
  }
}

function defaultDispatchModel() {
  return resolveDispatchModel({
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

function listedComposerSources() {
  const sources = Array.isArray(state.settings?.sources) ? state.settings.sources : [];
  return sources.filter((source) => source && Array.isArray(source.models) && source.models.some((name) => typeof name === 'string' && name.trim()));
}

function renderAgentMenuHtml() {
  const conv = (state.activeConversationId ? state.activeConversationData : state.draft) || {};
  const grokSignedIn = Boolean(state.settings?.grok?.signedIn);
  const defaultModel = defaultDispatchModel();
  const followDefault = !String(conv.modelSourceId || '').trim() || !String(conv.modelId || '').trim();
  const selectedSourceId = followDefault ? '' : String(conv.modelSourceId || '');
  const selectedModel = followDefault ? '' : String(conv.modelId || '');
  const defaultLabel = defaultModel ? t('chip_follow_default', { model: defaultModel }) : t('chip_follow_default_none');
  const rows = [
    agentMenuItem({
      label: defaultLabel,
      selected: followDefault,
      attrs: 'data-action="pick-model" data-follow-default="1" data-source-id="" data-model=""',
    }),
  ];
  for (const source of listedComposerSources()) {
    const title = source.name || source.id || '';
    rows.push(`<div class="chip-menu-label">${escapeHtml(title)}</div>`);
    for (const raw of source.models || []) {
      const name = typeof raw === 'string' ? raw.trim() : '';
      if (!name) continue;
      const selected = !followDefault && selectedSourceId === source.id && selectedModel === name;
      const usable = sourceUsable(source, { grokSignedIn });
      const disabled = usable ? '' : ' disabled';
      rows.push(agentMenuItem({
        label: name,
        selected,
        attrs: `data-action="pick-model" data-source-id="${escapeHtml(source.id)}" data-model="${escapeHtml(name)}"${disabled}`,
      }));
    }
  }
  return rows.join('');
}

function closeAgentMenu() {
  document.getElementById('composer-agent-menu')?.classList.remove('is-open');
  document.getElementById('composer-agent-chip-btn')?.setAttribute('aria-expanded', 'false');
}

function closeContextMenu() {
  document.getElementById('composer-context-menu')?.classList.remove('is-open');
  document.getElementById('composer-context-limit-btn')?.setAttribute('aria-expanded', 'false');
}

function renderContextMenuHtml() {
  const { target, view } = composerContextView();
  const model = target?.model || '';
  const options = contextWindowPresetOptions(view.window);
  const rows = [
    `<div class="chip-menu-title">${escapeHtml(t('ctx_menu_title', { model }))}</div>`,
    `<div class="chip-menu-stat">${escapeHtml(t('ctx_menu_used', { count: view.usedText, pct: view.usedPct }))}</div>`,
    `<div class="chip-menu-stat">${escapeHtml(t('ctx_menu_remain', { count: view.remainText, pct: view.remainPct }))}</div>`,
    '<div class="chip-menu-sep"></div>',
  ];
  for (const option of options) {
    rows.push(
      `<button type="button" class="chip-menu-item" role="menuitem" aria-selected="${option.selected ? 'true' : 'false'}" data-action="pick-context-window" data-source-id="${escapeHtml(target?.source?.id || '')}" data-model="${escapeHtml(model)}" data-tokens="${option.tokens}" data-testid="composer-context-option">` +
      `<span>${escapeHtml(option.label)}</span>` +
      `</button>`
    );
  }
  return rows.join('');
}

function toggleContextMenu() {
  const menu = document.getElementById('composer-context-menu');
  const btn = document.getElementById('composer-context-limit-btn');
  if (!menu || !btn || btn.disabled) return;
  if (menu.classList.contains('is-open')) {
    closeContextMenu();
    return;
  }
  closeAgentMenu();
  menu.innerHTML = renderContextMenuHtml();
  menu.classList.add('is-open');
  btn.setAttribute('aria-expanded', 'true');
}

function applyContextOverridesToSettings() {
  const overrides = state.contextWindowOverrides;
  const sources = state.settings?.sources;
  if (!overrides || !Array.isArray(sources)) return;
  for (const [key, tokens] of Object.entries(overrides)) {
    const parsed = parseContextOverrideKey(key);
    if (!parsed) continue;
    const source = sources.find((item) => item.id === parsed.sourceId);
    if (!source) continue;
    if (!source.contextWindows || typeof source.contextWindows !== 'object' || Array.isArray(source.contextWindows)) {
      source.contextWindows = {};
    }
    if (tokens == null) delete source.contextWindows[parsed.model];
    else source.contextWindows[parsed.model] = tokens;
  }
}

function applyReturnedContextWindows(sourceId, res) {
  if (!res || typeof res !== 'object') return false;
  const src = res.id === sourceId ? res : (Array.isArray(res.sources) ? res.sources.find((item) => item.id === sourceId) : null);
  const live = (state.settings?.sources || []).find((item) => item.id === sourceId);
  if (!src || !live) return false;
  if (src.contextWindows && typeof src.contextWindows === 'object' && !Array.isArray(src.contextWindows)) {
    live.contextWindows = { ...src.contextWindows };
  } else {
    delete live.contextWindows;
  }
  if (src.defaultContextWindow != null) live.defaultContextWindow = src.defaultContextWindow;
  if (src.defaultContextWindows && typeof src.defaultContextWindows === 'object' && !Array.isArray(src.defaultContextWindows)) {
    live.defaultContextWindows = { ...src.defaultContextWindows };
  }
  return true;
}

export async function setSourceContextWindow(sourceId, model, tokens) {
  const name = typeof model === 'string' ? model.trim() : '';
  const key = contextOverrideKey(sourceId, name);
  const sources = Array.isArray(state.settings?.sources) ? state.settings.sources : [];
  const source = sources.find((item) => item.id === sourceId);
  if (!source || !key) return;
  const prevMap = source.contextWindows && typeof source.contextWindows === 'object' && !Array.isArray(source.contextWindows)
    ? { ...source.contextWindows }
    : {};
  const hadOverride = Object.prototype.hasOwnProperty.call(state.contextWindowOverrides, key);
  const prevOverride = hadOverride ? state.contextWindowOverrides[key] : undefined;
  if (!source.contextWindows || typeof source.contextWindows !== 'object' || Array.isArray(source.contextWindows)) {
    source.contextWindows = {};
  }
  const nextTokens = tokens == null || tokens === '' ? null : Number(tokens);
  if (nextTokens != null && !(Number.isFinite(nextTokens) && nextTokens > 0)) return;
  if (nextTokens == null) delete source.contextWindows[name];
  else source.contextWindows[name] = nextTokens;
  state.contextWindowOverrides[key] = nextTokens;
  closeContextMenu();
  renderStatusBar();
  const settingsOpen = document.getElementById('settings-overlay')?.style.display === 'flex' && state.activeSettingsTab === 'models';
  if (settingsOpen) renderSettingsModal();
  try {
    const res = await api(`/api/sources/${encodeURIComponent(sourceId)}`, 'PUT', {
      contextWindows: { [name]: nextTokens },
    });
    const applied = applyReturnedContextWindows(sourceId, res);
    if (applied) {
      delete state.contextWindowOverrides[key];
      const conv = state.activeConversationData;
      const target = resolveComposerTarget();
      if (conv && target?.source?.id === sourceId && target?.model === name) {
        conv.contextWindow = nextTokens ?? sourceDefaultContextWindow(source, name);
        conv.contextWindowModel = name;
      }
      renderStatusBar();
      if (settingsOpen) renderSettingsModal();
    }
  } catch (err) {
    source.contextWindows = prevMap;
    if (hadOverride) state.contextWindowOverrides[key] = prevOverride;
    else delete state.contextWindowOverrides[key];
    showToast(isToastKey(err.message) ? err.message : (err.message || 'err_context_window'));
    renderStatusBar();
    if (settingsOpen) renderSettingsModal();
  }
}

function toggleAgentMenu() {
  const menu = document.getElementById('composer-agent-menu');
  if (!menu) return;
  if (menu.classList.contains('is-open')) {
    closeAgentMenu();
    return;
  }
  closeContextMenu();
  if (!state.activeConversationId && !state.activeWorkspaceId) {
    showToast('err_select_workspace');
    return;
  }
  if (!listedComposerSources().length) {
    closeAgentMenu();
    openSettings('models');
    return;
  }
  menu.innerHTML = renderAgentMenuHtml();
  menu.classList.add('is-open');
  document.getElementById('composer-agent-chip-btn')?.setAttribute('aria-expanded', 'true');
}

export async function pickComposerModel(el) {
  if (!el) return;
  const follow = el.getAttribute('data-follow-default') === '1';
  const modelSourceId = follow ? null : (el.getAttribute('data-source-id') || null);
  const modelId = follow ? null : (el.getAttribute('data-model') || null);
  const cid = state.activeConversationId;
  if (!cid) {
    state.draft = { modelSourceId: modelSourceId || '', modelId: modelId || '' };
    closeAgentMenu();
    closeContextMenu();
    renderStatusBar();
    return;
  }
  try {
    const res = await api(`/api/conversations/${encodeURIComponent(cid)}`, 'PATCH', { modelSourceId, modelId });
    if (state.activeConversationId === cid && state.activeConversationData) {
      state.activeConversationData.modelSourceId = res.modelSourceId ?? null;
      state.activeConversationData.modelId = res.modelId ?? null;
    }
    const item = state.conversations.find((c) => c.id === cid);
    if (item) {
      item.modelSourceId = res.modelSourceId ?? null;
      item.modelId = res.modelId ?? null;
    }
    closeAgentMenu();
    closeContextMenu();
    renderStatusBar();
  } catch (err) {
    showToast(isToastKey(err.message) ? err.message : (err.message || 'err_model_switch'));
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

const SEND_ICON = '<svg viewBox="0 0 14 14" aria-hidden="true"><path d="M7 11.5V2.5M3 6.5l4-4 4 4"></path></svg>';
const STOP_ICON = '<svg viewBox="0 0 14 14" aria-hidden="true"><rect x="4" y="4" width="6" height="6" rx="1"></rect></svg>';

export function renderStatusBar() {
  renderComposerContext();
  renderComposerAgent();
  renderDemoModelBadge();
  const bar = document.getElementById('status-bar');
  if (!bar) return;

  const conv = state.activeConversationData;
  const draft = isDraftActive();
  const status = conv?.status || 'idle';
  const statusTextStr = t(`status_${status}`) || status;
  const ws = (state.workspaces || []).find((w) => w.id === state.activeWorkspaceId);

  const center = document.getElementById('col-center');
  if (center) {
    center.classList.toggle('is-draft', draft);
    center.classList.toggle('is-empty', !state.activeWorkspaceId);
  }

  const title = document.getElementById('top-title');
  if (title) {
    const item = state.conversations.find((c) => c.id === state.activeConversationId);
    title.textContent = draft
      ? t('new_conversation')
      : (state.activeConversationId ? (conv?.title || item?.title || t('default_conversation_title')) : '');
    title.classList.toggle('is-draft', draft);
  }

  const wsEl = document.getElementById('topbar-workspace');
  if (wsEl) wsEl.textContent = '';

  const pill = document.getElementById('status-pill');
  if (pill) pill.classList.toggle('is-hidden', !state.activeConversationId);
  const dot = document.getElementById('status-dot');
  if (dot) {
    dot.className = `status-dot dot-${status}`;
    dot.setAttribute('data-status', status);
  }
  const statusTextEl = document.getElementById('status-text');
  if (statusTextEl) {
    statusTextEl.textContent = statusTextStr;
    const failedText = status === 'failed'
      ? localizedErrorText(conv?.llmError?.message, conv?.llmError?.code)
      : '';
    if (failedText) statusTextEl.title = failedText;
    else statusTextEl.removeAttribute('title');
  }

  const projName = document.getElementById('composer-project-name');
  if (projName) projName.textContent = ws?.name || '';
  const projChip = document.getElementById('composer-project-chip');
  if (projChip) {
    projChip.title = ws?.path || '';
    projChip.classList.toggle('is-hidden', !ws);
  }
  const draftName = document.getElementById('draft-proj-name');
  if (draftName) draftName.textContent = ws?.name || t('pick_project');
  const hint = document.getElementById('draft-hint');
  if (hint) {
    hint.textContent = !state.workspaces.length
      ? t('draft_hint_no_project')
      : (draft && ws ? t('draft_hint', { path: ws.name }) : '');
  }

  renderCenterNotice();
  syncComposerLock();
  syncSendReady();
}

function formatElapsed(ms) {
  const sec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const ss = String(sec % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

let runStartedAt = null;
let runStartedFor = null;
let runTicker = null;

const TOOL_COMMAND_PREVIEW_LINES = 5;

function lastIsStreamingAssistantBody(msgs) {
  const last = Array.isArray(msgs) ? msgs[msgs.length - 1] : null;
  if (!last || last.role !== 'assistant') return false;
  if (last.kind === 'correction') return false;
  return last.streaming === true && Boolean(String(last.text || '').trim());
}

/** Trailing tool group: skip empty assistant bubbles that have not started a body yet. */
function threadEndsWithToolGroup(msgs) {
  for (let i = (msgs || []).length - 1; i >= 0; i -= 1) {
    const m = msgs[i];
    if (m?.role === 'tool') return Boolean(m.tool);
    if (m?.kind === 'correction') continue;
    if (m?.role === 'assistant' && !String(m.text || '').trim()) continue;
    return false;
  }
  return false;
}

function showRunClock(conv, msgs) {
  return Boolean(state.activeConversationId) && ACTIVE_RUN.has(conv?.status) && !lastIsStreamingAssistantBody(msgs);
}

function pendingStatusText(conv, msgs) {
  const tools = [];
  for (const m of msgs || []) {
    if (m?.role === 'tool' && m.tool) tools.push(m.tool);
  }
  const summary = summarizeToolGroup(tools, t);
  let text = summary.running ? summary.text : t('pending_thinking');
  const live = (conv?.agents || []).filter((ag) => isRealSubagent(ag) && ACTIVE_RUN.has(ag.status)).length;
  if (live) text = `${text} ${t('pending_subagents', { n: live })}`;
  return text;
}

function elapsedNow() {
  return formatElapsed(Date.now() - (runStartedAt || Date.now()));
}

function armRunClock(conv, show) {
  const running = Boolean(state.activeConversationId) && ACTIVE_RUN.has(conv?.status);
  if (!running) {
    runStartedAt = null;
    runStartedFor = null;
    if (runTicker) { clearInterval(runTicker); runTicker = null; }
    return;
  }
  if (runStartedFor !== state.activeConversationId || runStartedAt == null) {
    runStartedFor = state.activeConversationId;
    const last = [...(conv?.messages || [])].reverse().find((m) => isPromptUserMessage(m));
    const ts = Number(last?.createdAt || last?.ts || 0);
    runStartedAt = ts > 0 && ts <= Date.now() ? ts : Date.now();
  }
  if (!show) {
    if (runTicker) { clearInterval(runTicker); runTicker = null; }
    return;
  }
  if (!runTicker) {
    runTicker = setInterval(() => {
      const el = document.querySelector('[data-run-elapsed]');
      if (el && runStartedAt) el.textContent = formatElapsed(Date.now() - runStartedAt);
    }, 1000);
  }
}

function assistantPendingHtml(conv, msgs) {
  if (!showRunClock(conv, msgs) || threadEndsWithToolGroup(msgs)) return '';
  return (
    `<div class="msg-group msg-side-agent is-pending" data-testid="assistant-pending">` +
    `<div class="pending-line">` +
    `<span class="run-spin" aria-hidden="true"><span></span></span>` +
    `<span class="pending-status" data-testid="assistant-pending-status">${escapeHtml(pendingStatusText(conv, msgs))}</span>` +
    `<span class="pending-elapsed" data-testid="assistant-pending-elapsed" data-run-elapsed>${escapeHtml(elapsedNow())}</span>` +
    `</div>` +
    `</div>`
  );
}

function syncSendReady() {
  const input = document.querySelector('[data-testid="chat-input"]');
  const send = document.querySelector('[data-testid="chat-send"]');
  if (!send) return;
  const hasText = Boolean(input && !input.disabled && input.value.trim());
  const stopMode = ACTIVE_RUN.has(state.activeConversationData?.status) && !hasText && Boolean(state.activeConversationId);
  if (stopMode) {
    send.dataset.state = 'stop';
    send.setAttribute('data-action', 'stop-conversation');
    send.setAttribute('aria-label', t('btn_stop'));
    send.setAttribute('title', t('btn_stop_title'));
    send.setAttribute('data-i18n-aria', 'btn_stop');
    send.setAttribute('data-i18n-title', 'btn_stop_title');
    send.innerHTML = STOP_ICON;
    send.classList.add('is-ready');
    return;
  }
  send.removeAttribute('data-state');
  send.setAttribute('data-action', 'send-message');
  send.removeAttribute('aria-label');
  send.removeAttribute('data-i18n-aria');
  send.setAttribute('title', t('send_title'));
  send.setAttribute('data-i18n-title', 'send_title');
  send.innerHTML = SEND_ICON;
  send.classList.toggle('is-ready', hasText);
}

export function renderCenterNotice() {
  const host = document.getElementById('center-notice');
  if (!host) return;
  host.innerHTML = '';
}

export function syncComposerLock() {
  const conv = state.activeConversationData;
  const noWorkspace = !state.activeWorkspaceId;
  const input = document.querySelector('[data-testid="chat-input"]');
  const send = document.querySelector('[data-testid="chat-send"]');
  const status = conv?.status || 'idle';
  if (input) {
    input.disabled = noWorkspace;
    input.placeholder = isDraftActive()
      ? t('draft_placeholder')
      : (ACTIVE_RUN.has(status) ? t('composer_placeholder_running') : t('composer_placeholder'));
  }
  if (send) send.disabled = noWorkspace;
  const chip = document.getElementById('composer-agent-chip-btn');
  if (chip) {
    chip.disabled = false;
    chip.setAttribute('aria-disabled', 'false');
  }
}

const DELEGATE_TOOLS = new Set(['delegate', 'subagent']);

function realSubagentRowHtml(agent) {
  const background = isBackgroundSubagent(agent);
  const mode = agent?.mode === 'background' || agent?.mode === 'foreground' ? agent.mode : '';
  const name = realSubagentName(agent);
  const st = agent.status || 'waiting';
  const progressStr = agentProgressLabel(agent);
  const last = oneLine(agent.lastText || agent.task || '');
  const open = state.viewingAgentId === agent.id;
  return (
    `<div class="sub-agent-row is-real${open ? ' is-open' : ''}" data-testid="subagent-row" data-agent-id="${escapeHtml(agent.id || '')}" data-mode="${escapeHtml(mode)}" data-status="${escapeHtml(st)}" data-action="open-subagent" data-ctx="subagent" title="${escapeHtml(t('subagent_open_title'))}">` +
    `<span class="status-dot dot-${escapeHtml(st)}"></span>` +
    `<span class="sub-agent-name">${escapeHtml(name)}</span>` +
    (background ? `<span class="sub-agent-bg" data-testid="subagent-background">${escapeHtml(t('subagent_background'))}</span>` : '') +
    `<span class="sub-agent-last" data-testid="subagent-last">${escapeHtml(last)}</span>` +
    (progressStr ? `<span class="sub-agent-progress" data-testid="subagent-progress">${escapeHtml(progressStr)}</span>` : '') +
    `<span class="sub-agent-status status-text-${escapeHtml(st)}">${escapeHtml(t(`status_${st}`) || st)}</span>` +
    `<span class="sub-agent-go">›</span>` +
    `</div>`
  );
}

function agentsCardHtml(agents) {
  if (!agents.length) return '';
  return `<div class="agents-card" data-testid="subagents-card">${agents.map(realSubagentRowHtml).join('')}</div>`;
}

function lastVisibleAssistant(msgs) {
  for (let i = (msgs || []).length - 1; i >= 0; i -= 1) {
    const m = msgs[i];
    if (m?.role === 'assistant' && m.kind !== 'correction' && String(m.text || '').trim()) return m;
  }
  return null;
}

function truncationFooterHtml(message, enabled) {
  if (!enabled || message?.stopReason !== 'length' || message.streaming) return '';
  return (
    `<div class="msg-truncated" data-testid="output-truncated">` +
    `<span>${escapeHtml(t('output_truncated'))}</span>` +
    `<button type="button" class="btn btn-sm" data-action="continue-truncated" data-testid="continue-truncated">${escapeHtml(t('btn_continue'))}</button>` +
    `</div>`
  );
}

/** Messages → HTML blocks. Shared by the main thread and the sub-agent pane. */
function threadBlocksHtml(msgs, { afterToolRun, senderName, streamSpin, liveTail, showTruncationContinue } = {}) {
  const rendered = [];
  const toolRun = [];
  const last = msgs[msgs.length - 1];
  const truncated = lastVisibleAssistant(msgs);
  const flushToolRun = (live = false) => {
    if (!toolRun.length) return;
    rendered.push(renderToolGroupHtml(toolRun, '', { live }));
    if (afterToolRun) {
      const extra = afterToolRun(toolRun);
      if (extra) rendered.push(extra);
    }
    toolRun.length = 0;
  };
  for (const m of msgs) {
    if (m.role === 'tool') {
      if (m.tool) toolRun.push(m.tool);
      else flushToolRun();
      continue;
    }
    if (m.role === 'assistant' && m.kind !== 'correction' && !String(m.text || '').trim()) continue;
    flushToolRun();
    if (m.kind === 'correction') {
      rendered.push(
        `<div class="handoff-note msg-side-agent" data-testid="message" data-role="system" data-kind="correction">` +
        `<span>${escapeHtml(m.text || '')}</span>` +
        `</div>`
      );
      continue;
    }
    if (m.role === 'note') {
      const note = String(m.text || '').trim();
      if (!note) continue;
      rendered.push(
        `<div class="chat-note" data-testid="message" data-role="note">` +
        `<span>${escapeHtml(note)}</span>` +
        `</div>`
      );
      continue;
    }
    if (m.role === 'user') {
      if (!isPromptUserMessage(m)) {
        rendered.push(
          `<div class="handoff-note msg-side-agent" data-testid="auto-continue-note" data-role="system" data-kind="auto-continue">` +
          `<span>${escapeHtml(t('auto_continue_note'))}</span>` +
          `</div>`
        );
        continue;
      }
      rendered.push(
        `<div class="msg-group msg-side-user" data-testid="message" data-role="user">` +
        `<div class="msg-body" data-testid="message-body">${renderMarkdown(m.text || '')}</div>` +
        `</div>`
      );
      continue;
    }
    if (!String(m.text || '').trim()) continue;
    const roleLabel = senderName || '';
    const chip = assistantChip(m);
    const headerBits = [];
    if (roleLabel) headerBits.push(`<span class="msg-sender" data-testid="message-sender">${escapeHtml(roleLabel)}</span>`);
    if (chip && !senderName) headerBits.push(`<span class="msg-chip" data-testid="message-chip">${escapeHtml(chip)}</span>`);
    const header = headerBits.length ? `<div class="msg-header">${headerBits.join('')}</div>` : '';
    const spin = streamSpin && m === last
      ? `<span class="msg-stream-spin" data-testid="assistant-stream-spin" aria-hidden="true"></span>`
      : '';
    rendered.push(
      `<div class="msg-group msg-side-agent" data-testid="message" data-role="assistant">` +
      header +
      `<div class="msg-body" data-testid="message-body">${renderMarkdown(m.text || '')}${spin}</div>` +
      (m === truncated ? truncationFooterHtml(m, showTruncationContinue) : '') +
      `</div>`
    );
  }
  flushToolRun(Boolean(liveTail));
  return rendered;
}

export function renderChatThread() {
  renderCenterNotice();
  const thread = document.getElementById('center-thread');
  if (!thread) return;

  const conv = state.activeConversationData;
  if (!conv || !conv.messages || conv.messages.length === 0) {
    armRunClock(conv, showRunClock(conv, []));
    const pending = assistantPendingHtml(conv, []);
    const errHtml = llmErrorHtml(conv);
    const inner = [pending, errHtml].filter(Boolean).join('')
      || (state.activeConversationId ? `<div class="thread-empty">${escapeHtml(t('empty_chat_hint'))}</div>` : '');
    thread.innerHTML = inner ? `<div class="thread-inner">${inner}</div>` : '';
    if (pending || errHtml) thread.scrollTop = thread.scrollHeight;
    return;
  }

  const prevTop = thread.scrollTop;
  const stick = thread.scrollHeight - prevTop - thread.clientHeight < 80;
  const msgs = dedupeMessages(conv.messages);
  const allAgents = conv.agents || [];
  const realAgents = allAgents.filter((ag) => isRealSubagent(ag));
  let agentsPlaced = false;
  const streamSpin = lastIsStreamingAssistantBody(msgs);
  const clock = showRunClock(conv, msgs);
  armRunClock(conv, clock);
  const liveTail = clock && threadEndsWithToolGroup(msgs);

  const rendered = threadBlocksHtml(msgs, {
    streamSpin,
    liveTail,
    showTruncationContinue: !ACTIVE_RUN.has(conv?.status),
    afterToolRun(tools) {
      if (agentsPlaced || !realAgents.length) return '';
      if (!tools.some((tool) => DELEGATE_TOOLS.has(String(tool?.name || '').toLowerCase()))) return '';
      agentsPlaced = true;
      return agentsCardHtml(realAgents);
    },
  });

  if (!agentsPlaced && realAgents.length) rendered.push(agentsCardHtml(realAgents));

  const pending = assistantPendingHtml(conv, msgs);
  if (pending) rendered.push(pending);
  const errHtml = llmErrorHtml(conv);
  if (errHtml) rendered.push(errHtml);

  thread.innerHTML = `<div class="thread-inner">${rendered.join('')}</div>`;
  if (stick || state.forceThreadBottom) thread.scrollTop = thread.scrollHeight;
  else thread.scrollTop = prevTop;
  state.forceThreadBottom = false;
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
    const group = rows;
    parts.push(
      `<div class="tool-group is-open"><div class="tool-group-list">` +
      group.map((tool) => renderToolRowHtml(tool, group)).join('') +
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

function conversationWorkspacePath() {
  const data = state.activeConversationData;
  if (data?.workspacePath) return data.workspacePath;
  const listed = (state.conversations || []).find((item) => item.id === state.activeConversationId);
  if (listed?.workspacePath) return listed.workspacePath;
  const wid = data?.workspaceId || listed?.workspaceId || state.activeWorkspaceId;
  const ws = (state.workspaces || []).find((item) => item.id === wid);
  return ws?.path || '';
}

export function renderToolGroupHtml(tools, idPrefix = '', opts = {}) {
  const list = (tools || []).filter(Boolean);
  if (!list.length) return '';
  const live = Boolean(opts.live);
  const id = `${idPrefix}${toolGroupKey(list)}`;
  const open = state.expandedToolGroups.has(id);
  const summary = summarizeToolGroup(list, t);
  const preview = toolGroupPreview(list, state.expandedToolGroupOlder.has(id));
  const spinning = summary.running || live;
  const realFailed = summary.failed > 0 && !spinning;
  const fail = summary.failed > 0
    ? `<span class="tool-group-fail" data-testid="tool-group-fail">${escapeHtml(t('tool_fail_count', { n: summary.failed }))}</span>`
    : '';
  const spin = spinning
    ? `<span class="tool-group-spin" data-testid="tool-group-spinner" aria-hidden="true"></span>`
    : '';
  const thinking = live && !summary.running
    ? `${t('tool_sum_join')}${t('pending_thinking')}`
    : '';
  const elapsed = live
    ? `<span class="pending-elapsed" data-testid="tool-group-elapsed" data-run-elapsed>${escapeHtml(elapsedNow())}</span>`
    : '';
  const older = preview.hidden > 0
    ? `<button type="button" class="tool-group-older" data-testid="tool-group-older" data-action="expand-tool-group-older" data-group-id="${escapeHtml(id)}">${escapeHtml(tPlural('tool_group_older', preview.hidden))}</button>`
    : '';
  const groupClass = [
    'tool-group',
    open ? 'is-open' : '',
    spinning ? 'is-running' : '',
    live ? 'is-live' : '',
    realFailed ? 'is-failed' : '',
  ].filter(Boolean).join(' ');
  return (
    `<div class="${groupClass}" data-testid="tool-group" data-group-id="${escapeHtml(id)}">` +
    `<button type="button" class="tool-group-summary" data-testid="tool-group-summary" data-action="toggle-tool-group" data-group-id="${escapeHtml(id)}" aria-expanded="${open ? 'true' : 'false'}">` +
    spin +
    `<span class="tool-group-text" data-testid="tool-group-text">${escapeHtml(summary.text)}${escapeHtml(thinking)}</span>` +
    fail +
    `<svg class="tool-group-chevron icon" data-testid="tool-group-chevron" viewBox="0 0 24 24" aria-hidden="true"><polyline points="9 6 15 12 9 18"></polyline></svg>` +
    elapsed +
    `</button>` +
    `<div class="tool-group-list" data-testid="tool-group-list">` +
    older +
    preview.tools.map((tool) => renderToolRowHtml(tool, list)).join('') +
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

function toolRowOriginal(tool, workspacePath) {
  const focus = toolFocus(tool);
  if (focus.mode === 'text') return truncateCommand(focus.text);
  const raw = tool?.path || tool?.input?.path || focus.text || '';
  return truncatePath(relativizePath(raw, workspacePath));
}

function toolRowDisplay(tool, workspacePath) {
  const heading = toolRowHeading(tool);
  const original = toolRowOriginal(tool, workspacePath);
  if (heading.intent) return { title: heading.title, detail: original, intent: true };
  return { title: original, detail: '', intent: false };
}

function truncateCommand(text, max = 64) {
  const s = String(text || '');
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(1, max - 1))}…`;
}

function isToolDetailOpen(tool, tools) {
  const id = tool?.id;
  if (id == null || String(id) === '') return false;
  if (state.collapsedToolDetails.has(id)) return false;
  if (state.expandedTools.has(id)) return true;
  return isRealToolFailure(tool, tools);
}

function isChangeTool(tool) {
  const kind = toolKind(tool?.name);
  return kind === 'write' || kind === 'edit';
}

function clipTailLines(text, limit) {
  const raw = text == null ? '' : String(text);
  const lines = raw.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  if (lines.length <= limit) return { text: raw, clipped: false };
  return { text: lines.slice(-limit).join('\n'), clipped: true };
}

function toolRowOutputText(tool, workspacePath) {
  const parsed = parseToolOutput(tool?.output);
  const json = parsed.json && typeof parsed.json === 'object' ? parsed.json : null;
  let raw = parsed.text;
  if (toolKind(tool?.name) === 'bash' && json && (json.stdout != null || json.stderr != null)) {
    const stdout = json.stdout == null ? '' : String(json.stdout);
    const stderr = json.stderr == null ? '' : String(json.stderr);
    raw = [stdout, stderr].filter((part) => part !== '').join(stdout && stderr ? '\n' : '');
    if (!raw) raw = parsed.text;
  }
  return relativizeText(unwrapHarnessDiagnostics(raw), workspacePath);
}

function clipToolRowOutput(tool, outputText, showAll, realFail) {
  if (showAll) return clipOutputText(outputText, true);
  if (toolKind(tool?.name) === 'bash') return clipTailLines(outputText, TOOL_COMMAND_PREVIEW_LINES);
  const limit = realFail ? TOOL_ERROR_PREVIEW_LINES : 20;
  return clipOutputText(outputText, false, limit);
}

export function renderToolRowHtml(tool, tools = []) {
  if (!tool) return '';
  const group = Array.isArray(tools) && tools.length ? tools : [tool];
  const workspacePath = conversationWorkspacePath();
  const toolName = tool.name || 'tool';
  const changeKind = isChangeTool(tool);
  const rawPath = tool.path || tool.input?.path || '';
  const display = toolRowDisplay(tool, workspacePath);
  const pathClass = display.intent ? 'tool-path is-intent' : 'tool-path';
  const origHtml = display.detail
    ? `<span class="tool-path-orig" data-testid="tool-row-orig">${escapeHtml(display.detail)}</span>`
    : '';
  const diff = toolDiffCounts(tool);
  const showDiff = changeKind && (diff.added != null || diff.removed != null);
  const added = diff.added != null ? `+${diff.added}` : '';
  const removed = diff.removed != null ? `−${diff.removed}` : '';
  const bucket = toolStatusBucket(tool.status);
  const probe = isProbeFailure(tool, group);
  const realFail = isRealToolFailure(tool, group);
  const isExpanded = !changeKind && isToolDetailOpen(tool, group);
  const hint = toolResultHint(tool, t, { workspacePath });
  const hintFailed = hint.failed && !probe;
  const diffBadge =
    `<span class="tool-diff-badge${showDiff ? '' : ' is-hidden'}">` +
    `<span class="add" data-testid="tool-row-added">${escapeHtml(added)}</span>` +
    `<span class="del" data-testid="tool-row-removed">${escapeHtml(removed)}</span>` +
    `</span>`;
  const statusHtml = realFail
    ? `<span class="tool-row-status is-failed" data-testid="tool-row-status">${escapeHtml(localizeToolStatus('failed'))}</span>`
    : (bucket === 'interrupted'
      ? `<span class="tool-row-status is-interrupted" data-testid="tool-row-status">${escapeHtml(localizeToolStatus(tool.status))}</span>`
      : '');
  const preview = pluginResultPreview(tool);
  const outputText = toolRowOutputText(tool, workspacePath);
  const showAllOutput = state.expandedToolOutputs.has(tool.id);
  const clipped = clipToolRowOutput(tool, outputText, showAllOutput, realFail);
  const hintHtml = hint.text
    ? `<span class="tool-row-hint${hintFailed ? ' is-failed' : ''}" data-testid="tool-row-hint">${escapeHtml(hint.text)}</span>`
    : (preview ? `<span class="tool-result" data-testid="tool-row-output">${escapeHtml(preview)}</span>` : '');
  const rowClass = [
    'tool-row',
    bucket === 'interrupted' ? 'tool-interrupted' : '',
    realFail ? 'is-failed' : '',
  ].filter(Boolean).join(' ');
  const rowAction = changeKind && rawPath ? 'open-tool-diff' : 'toggle-tool';
  const detailHtml = changeKind
    ? ''
    : (
      `<div class="tool-detail-card" data-testid="tool-row-detail" style="display:${isExpanded ? 'block' : 'none'}">` +
      (isExpanded && clipped.text
        ? `<div class="tool-detail-block${realFail ? ' is-failed' : ''}">${escapeHtml(clipped.text)}</div>`
        : '') +
      (isExpanded && clipped.clipped
        ? `<button type="button" class="tool-detail-more" data-testid="tool-output-more" data-action="expand-tool-output" data-tool-id="${escapeHtml(tool.id)}">${escapeHtml(t('tool_show_all'))}</button>`
        : '') +
      `</div>`
    );

  return (
    `<div class="tool-row-wrapper">` +
    `<div class="${rowClass}" data-testid="tool-row" data-tool="${escapeHtml(toolName)}" data-path="${escapeHtml(rawPath)}" data-action="${rowAction}" data-tool-id="${escapeHtml(tool.id)}">` +
    `<div class="tool-main">` +
    toolIconSvg(toolName) +
    `<span class="tool-action">${escapeHtml(toolActionLabel(toolName))}</span>` +
    `<span class="${pathClass}" data-testid="tool-row-path">${escapeHtml(display.title)}</span>` +
    origHtml +
    hintHtml +
    diffBadge +
    `</div>` +
    `<div class="tool-meta">${statusHtml}</div>` +
    detailHtml +
    `</div>` +
    `</div>`
  );
}

function assistantChip(m) {
  const chip = typeof m?.model === 'string' ? m.model.trim() : '';
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

function findToolById(id) {
  const msgs = state.activeConversationData?.messages || [];
  for (const message of msgs) {
    if (message?.role === 'tool' && message.tool && String(message.tool.id) === String(id)) {
      return message.tool;
    }
  }
  return null;
}

function toolGroupFor(tool) {
  const msgs = state.activeConversationData?.messages || [];
  const tools = [];
  let capturing = false;
  let found = false;
  for (const message of msgs) {
    if (message?.role === 'tool' && message.tool) {
      capturing = true;
      tools.push(message.tool);
      if (tool && (message.tool === tool || String(message.tool.id) === String(tool.id))) found = true;
      continue;
    }
    if (capturing) {
      if (found) return tools;
      tools.length = 0;
      capturing = false;
    }
  }
  return found ? tools : (tool ? [tool] : []);
}

export function toggleToolDetail(id) {
  if (!id) return;
  const tool = findToolById(id);
  const open = tool ? isToolDetailOpen(tool, toolGroupFor(tool)) : state.expandedTools.has(id);
  if (open) {
    state.expandedTools.delete(id);
    state.collapsedToolDetails.add(id);
  } else {
    state.collapsedToolDetails.delete(id);
    state.expandedTools.add(id);
  }
  renderChatThread();
}

function openToolFileDiff(id) {
  const tool = findToolById(id);
  const raw = tool?.path || tool?.input?.path || '';
  if (!raw) {
    toggleToolDetail(id);
    return;
  }
  const filePath = relativizePath(raw, conversationWorkspacePath()) || raw;
  state.userPickedFile = true;
  if (state.activeRightTab !== 'diff') state.activeRightTab = 'diff';
  state.closedChangeFiles.delete(filePath);
  setRightOpen(true);
  loadFileOrDiff(filePath);
}

export function toggleToolGroup(id) {
  if (!id) return;
  if (state.expandedToolGroups.has(id)) state.expandedToolGroups.delete(id);
  else state.expandedToolGroups.add(id);
  renderChatThread();
}

export function expandToolGroupOlder(id) {
  if (!id) return;
  state.expandedToolGroupOlder.add(id);
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
  const visual = tab === 'editor' || tab === 'markdown' ? 'file' : tab;
  nav.querySelectorAll('.tab-btn[data-tab]').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-tab') === visual);
  });
}

function diffTotals(list) {
  let added = 0;
  let removed = 0;
  for (const ch of list) {
    added += Number(ch.added) || 0;
    removed += Number(ch.removed) || 0;
  }
  return { added, removed };
}

/** Prototype-style unified diff: one column, sign + text. */
export function renderUnifiedDiffHtml(diffText) {
  if (!diffText) return `<div class="diff-note">${escapeHtml(t('no_diff_available'))}</div>`;
  const rows = [];
  let dels = [];
  let adds = [];
  const row = (kind, code) => {
    const sign = kind === 'add' ? '+' : kind === 'del' ? '−' : '';
    return `<div class="diff-line is-${kind}"><span class="sign">${sign}</span><span class="code">${escapeHtml(code)}</span></div>`;
  };
  // Within one run of changes, removed lines read before the lines that replace them.
  const flush = () => {
    for (const code of dels) rows.push(row('del', code));
    for (const code of adds) rows.push(row('add', code));
    dels = [];
    adds = [];
  };
  for (const line of String(diffText).split(/\r?\n/)) {
    if (line === '' || line.startsWith('---') || line.startsWith('+++') || line.startsWith('diff ') || line.startsWith('index ')) continue;
    if (line.startsWith('\\')) continue;
    if (line.startsWith('@@')) {
      flush();
      if (rows.length) rows.push(`<div class="diff-line is-hunk"><span class="sign"></span><span class="code">⋯</span></div>`);
      continue;
    }
    if (line[0] === '+') { adds.push(line.slice(1)); continue; }
    if (line[0] === '-') { dels.push(line.slice(1)); continue; }
    flush();
    rows.push(row('ctx', line[0] === ' ' ? line.slice(1) : line));
  }
  flush();
  if (!rows.length) return `<div class="diff-note">${escapeHtml(t('diff_no_change'))}</div>`;
  return `<div class="diff-lines">${rows.join('')}</div>`;
}

function changeFileHtml(ch) {
  const open = !state.closedChangeFiles.has(ch.path);
  const active = ch.path === state.activeFilePath;
  const d = state.diffs[ch.path];
  let body = '';
  if (open) {
    if (!d) body = `<div class="diff-note">${escapeHtml(t('loading'))}</div>`;
    else if (diffIsUnchanged(d)) body = `<div class="diff-note" data-testid="diff-unchanged">${escapeHtml(t('diff_no_change'))}</div>`;
    else body = renderUnifiedDiffHtml(d.unified || '');
  }
  return (
    `<div class="change-file${open ? ' is-open' : ''}${active ? ' active' : ''}"${open && d ? ' data-testid="diff-view"' : ''} data-path="${escapeHtml(ch.path)}">` +
    `<div class="changed-file-pill" data-testid="changed-file" data-path="${escapeHtml(ch.path)}" data-action="load-file" data-ctx="change-file" title="${escapeHtml(ch.path)}">` +
    CHEV_SVG +
    `<span class="changed-file-path">${escapeHtml(truncatePath(ch.path, 60))}</span>` +
    (ch.added != null ? `<span class="stat-add">+${escapeHtml(ch.added)}</span>` : '') +
    (ch.removed != null ? `<span class="stat-del">−${escapeHtml(ch.removed)}</span>` : '') +
    `</div>` +
    (open ? `<div class="diff-viewport">${body}</div>` : '') +
    `</div>`
  );
}

function renderChangesPaneHtml(visible) {
  if (!state.activeConversationId) {
    return `<div class="pane-empty" data-testid="diff-view">${escapeHtml(t('no_changes_yet'))}</div>`;
  }
  if (!visible.length) {
    return `<div class="pane-empty" data-testid="diff-view">${escapeHtml(t('no_changes_yet'))}</div>`;
  }
  const tot = diffTotals(visible);
  return (
    `<div class="changes-pane">` +
    `<div class="changes-head">` +
    `<div class="changes-head-line"><b>${escapeHtml(t('changes_file_count', { n: visible.length }))}</b>` +
    `<span class="stat-add">+${tot.added}</span><span class="stat-del">−${tot.removed}</span></div>` +
    `<div class="changes-head-note">${escapeHtml(t('changes_note'))}</div>` +
    `</div>` +
    visible.map(changeFileHtml).join('') +
    `</div>`
  );
}

function subagentDotClass(visual) {
  return `dot-${String(visual || 'waiting').replace(/[^a-z0-9_-]/gi, '')}`;
}

function subagentPanelSummary(agent) {
  const fromBrief = firstBriefLine(agent?.brief);
  if (fromBrief) return fromBrief;
  return realSubagentName(agent) || t('agent_name');
}

function subagentPanelSubtitle(agent, visual) {
  if (visual === 'running' || visual === 'stuck') {
    const action = subagentActionText(agent, visual);
    return action ? t('subagent_now', { action }) : '';
  }
  if (visual === 'done' || visual === 'stopped') return firstBriefLine(agent?.lastText);
  return '';
}

function revealMainConversationPane() {
  const leaveAgent = state.activeRightTab === 'agent' || Boolean(state.viewingAgentId);
  clearSubagentView();
  state.activeRightTab = 'diff';
  localStorage.setItem('weft_active_right_tab', 'diff');
  if (!leaveAgent) return;
  renderConversations();
  refreshChangeDiffs();
  renderRightPanel();
}

function showSubagentOverview() {
  clearSubagentView();
  state.activeRightTab = 'agent';
  setRightOpen(true);
  renderConversations();
  renderRightPanel();
}

function closeSubagentPicker() {
  if (!state.subagentPickerOpen) return;
  state.subagentPickerOpen = false;
  document.querySelector('[data-testid="subagent-picker"]')?.remove();
  const toggle = document.querySelector('[data-testid="subagent-picker-toggle"]');
  if (toggle) toggle.setAttribute('aria-expanded', 'false');
}

function toggleSubagentPicker() {
  if (state.subagentPickerOpen) {
    closeSubagentPicker();
    return;
  }
  state.subagentPickerOpen = true;
  state.subagentPickerAnimate = true;
  renderRightPanel();
  state.subagentPickerAnimate = false;
}

function subagentRowBits(agent) {
  const visual = subagentVisualStatus(agent);
  return {
    visual,
    summary: subagentPanelSummary(agent),
    sub: subagentPanelSubtitle(agent, visual),
    time: subagentTimeText(agent),
    dot: subagentDotClass(visual),
  };
}

function subagentCardHtml(agent) {
  const bits = subagentRowBits(agent);
  const aid = agent.id || '';
  return (
    `<button type="button" class="subagent-card" data-testid="subagent-card" data-action="open-subagent" data-agent-id="${escapeHtml(aid)}" data-status="${escapeHtml(agent.status || 'waiting')}" data-visual="${escapeHtml(bits.visual)}">` +
    `<span class="status-dot ${escapeHtml(bits.dot)}"></span>` +
    `<span class="subagent-card-main">` +
    `<span class="subagent-card-summary">${escapeHtml(bits.summary)}</span>` +
    (bits.sub ? `<span class="subagent-card-sub">${escapeHtml(bits.sub)}</span>` : '') +
    `</span>` +
    `<span class="subagent-time" data-subagent-time="${escapeHtml(aid)}">${escapeHtml(bits.time)}</span>` +
    `<span class="subagent-card-go" aria-hidden="true">›</span>` +
    `</button>`
  );
}

function subagentPickerHtml(currentId) {
  const agents = listedSubagents(state.activeConversationData?.agents || []);
  return (
    `<div class="subagent-picker${state.subagentPickerAnimate ? ' is-entering' : ' is-open'}" data-testid="subagent-picker" role="menu">` +
    agents.map((agent) => {
      const bits = subagentRowBits(agent);
      const aid = agent.id || '';
      const current = aid === currentId;
      return (
        `<button type="button" class="subagent-picker-item${current ? ' is-current' : ''}" role="menuitem" data-testid="subagent-picker-item" data-action="open-subagent" data-agent-id="${escapeHtml(aid)}">` +
        `<span class="status-dot ${escapeHtml(bits.dot)}"></span>` +
        `<span class="subagent-picker-summary">${escapeHtml(bits.summary)}</span>` +
        `<span class="subagent-time" data-subagent-time="${escapeHtml(aid)}">${escapeHtml(bits.time)}</span>` +
        `</button>`
      );
    }).join('') +
    `</div>`
  );
}

function renderSubagentOverviewHtml() {
  const agents = listedSubagents(state.activeConversationData?.agents || []);
  const n = agents.length;
  return (
    `<div class="subagent-overview" data-testid="subagent-overview">` +
    `<div class="subagent-crumb" data-testid="subagent-crumb">` +
    `<span class="agent-pane-tag">${escapeHtml(t('subagent_tag'))}</span>` +
    `<span class="tab-count">${escapeHtml(String(n))}</span>` +
    `</div>` +
    `<div class="subagent-cards">${agents.map(subagentCardHtml).join('')}</div>` +
    `</div>`
  );
}

function renderAgentTab() {
  const slot = document.getElementById('agent-tab-slot');
  if (!slot) return;
  const agents = listedSubagents(state.activeConversationData?.agents || []);
  if (!agents.length) {
    slot.innerHTML = '';
    if (state.activeRightTab === 'agent') state.activeRightTab = 'diff';
    return;
  }
  const n = agents.length;
  slot.innerHTML =
    `<button type="button" class="tab-btn${state.activeRightTab === 'agent' ? ' active' : ''}" data-action="switch-right-tab" data-tab="agent" data-testid="agent-tab" title="${escapeHtml(t('subagent_tab_title'))}">` +
    `<span>${escapeHtml(t('subagent_tag'))}</span>` +
    `<span class="tab-count">${escapeHtml(String(n))}</span>` +
    `</button>`;
}

function viewingAgentInfo() {
  const known = (state.activeConversationData?.agents || []).find((item) => item.id === state.viewingAgentId) || {};
  return { id: state.viewingAgentId, ...known, ...(state.viewingAgent || {}) };
}

function pendingNudgeHtml(item) {
  return (
    `<div class="msg-group msg-side-user subagent-nudge-pending" data-testid="subagent-nudge-pending">` +
    `<div class="msg-body" data-testid="message-body">${renderMarkdown(item.text || '')}</div>` +
    `<div class="subagent-nudge-note">${escapeHtml(t('subagent_interrupt_pending'))}</div>` +
    `</div>`
  );
}

function agentPaneFootHtml(agent) {
  const st = agent.status || 'waiting';
  if (st !== 'running') return `<div class="agent-pane-foot is-empty"></div>`;
  return (
    `<div class="agent-pane-foot is-composer">` +
    `<div class="subagent-composer">` +
    `<textarea data-testid="subagent-input" rows="2" placeholder="${escapeHtml(t('subagent_interrupt_placeholder'))}"></textarea>` +
    `<div class="subagent-composer-bar">` +
    `<span class="subagent-composer-hint">${escapeHtml(t('subagent_interrupt_hint'))}</span>` +
    `<button type="button" class="subagent-stop-btn" data-testid="subagent-stop" data-action="stop-subagent" title="${escapeHtml(t('subagent_stop_title'))}">` +
    `<span class="subagent-stop-sq" aria-hidden="true"></span>${escapeHtml(t('subagent_stop'))}` +
    `</button>` +
    `<button type="button" class="btn-send" data-testid="subagent-send" data-action="send-subagent" title="${escapeHtml(t('send_title'))}">${SEND_ICON}</button>` +
    `</div></div></div>`
  );
}

function renderAgentPaneHtml() {
  const agent = viewingAgentInfo();
  const st = agent.status || 'waiting';
  const name = realSubagentName(agent);
  const bits = subagentRowBits(agent);
  const msgs = dedupeMessages(state.viewingAgent?.messages || []);
  const firstUser = msgs.find((m) => isPromptUserMessage(m));
  const rest = firstUser ? msgs.filter((m) => m !== firstUser) : msgs;
  const lastAssistant = [...msgs].reverse().find((m) => m.role === 'assistant' && m.text);
  const done = st === 'done';
  const pending = state.pendingSubagentNudges[agent.id] || [];
  const threadMsgs = done && lastAssistant ? rest.filter((m) => m !== lastAssistant) : rest;
  let thread;
  if (state.viewingAgent?.loading && !msgs.length) thread = `<div class="pane-empty">${escapeHtml(t('subagent_loading'))}</div>`;
  else if (!threadMsgs.length && !pending.length && !(done && lastAssistant) && st !== 'stopped') {
    thread = `<div class="pane-empty">${escapeHtml(t('subagent_empty'))}</div>`;
  } else thread = threadBlocksHtml(threadMsgs, { senderName: name }).join('');
  const pendingHtml = pending.map(pendingNudgeHtml).join('');
  const brief = String(agent.brief || firstUser?.text || '').trim();
  const briefHtml = brief
    ? `<div class="agent-pane-brief" data-testid="subagent-brief"><span class="k">${escapeHtml(t('subagent_brief'))}</span><span class="v">${escapeHtml(brief)}</span></div>`
    : '';
  const stoppedNote = st === 'stopped'
    ? `<div class="subagent-stopped-note" data-testid="subagent-stopped-note"><div class="subagent-stopped-title">${escapeHtml(t('subagent_stopped_title'))}</div><div class="subagent-stopped-body">${escapeHtml(t('subagent_stopped_body'))}</div></div>`
    : '';
  const resultHtml = done && lastAssistant
    ? `<div class="agent-pane-result msg-group" data-testid="subagent-handed-back">` +
      `<span class="k">${escapeHtml(t('subagent_handed_back'))}</span>` +
      `<div class="msg-body" data-testid="message" data-role="assistant"><span class="msg-sender" data-testid="message-sender">${escapeHtml(name)}</span><div data-testid="message-body">${renderMarkdown(lastAssistant.text)}</div></div>` +
      `</div>`
    : '';
  return (
    `<div class="agent-pane" data-testid="subagent-pane">` +
    `<div class="subagent-crumb" data-testid="subagent-crumb">` +
    `<button type="button" class="agent-pane-tag" data-action="show-subagent-overview">${escapeHtml(t('subagent_tag'))}</button>` +
    `<span class="subagent-crumb-sep" aria-hidden="true">›</span>` +
    `<button type="button" class="subagent-crumb-now" data-action="toggle-subagent-picker" data-testid="subagent-picker-toggle" aria-expanded="${state.subagentPickerOpen ? 'true' : 'false'}" title="${escapeHtml(t('subagent_switch'))}">` +
    `<span class="subagent-crumb-label" data-testid="subagent-banner-text">${escapeHtml(bits.summary)}</span>` +
    `<span class="subagent-crumb-caret" aria-hidden="true">▾</span>` +
    `</button>` +
    (state.subagentPickerOpen ? subagentPickerHtml(agent.id) : '') +
    `</div>` +
    `<div class="agent-pane-body">` +
    `<div class="subagent-detail-head" data-testid="subagent-banner" data-visual="${escapeHtml(bits.visual)}" data-agent-id="${escapeHtml(agent.id || '')}">` +
    `<span class="status-dot ${escapeHtml(bits.dot)}"></span>` +
    `<span class="subagent-detail-summary">${escapeHtml(bits.summary)}</span>` +
    `<span class="subagent-time" data-subagent-time="${escapeHtml(agent.id || '')}">${escapeHtml(bits.time)}</span>` +
    `</div>` +
    briefHtml +
    `<div class="agent-pane-thread" data-testid="subagent-thread">${thread}${pendingHtml}${resultHtml}${stoppedNote}</div>` +
    `</div>` +
    agentPaneFootHtml(agent) +
    `</div>`
  );
}

export function renderRightPanel() {
  renderAgentTab();
  syncRightTabActive();
  renderRightOpenDot();
  const panel = document.getElementById('right-panel');
  if (!panel) return;

  const visibleChanges = changesWithDiff(state.changes);
  const tot = diffTotals(visibleChanges);
  const stat = document.getElementById('diff-tab-stat');
  if (stat) stat.innerHTML = visibleChanges.length ? `<span class="add">+${tot.added}</span><span class="del">−${tot.removed}</span>` : '';
  const badge = document.getElementById('diff-tab-badge');
  if (badge) badge.textContent = visibleChanges.length || 0;
  const editBtn = document.querySelector('[data-testid="file-open-editor"]');
  if (editBtn) editBtn.classList.toggle('is-hidden', !state.activeFilePath || state.activeRightTab === 'agent' || state.activeRightTab === 'editor');

  const viewport = document.getElementById('right-viewport');
  if (!viewport) return;

  if (state.activeRightTab === 'agent') {
    armSubagentClock();
    if (!state.viewingAgentId) {
      viewport.innerHTML = renderSubagentOverviewHtml();
      return;
    }
    const body = viewport.querySelector('.agent-pane-body');
    const stick = !body || body.scrollHeight - body.scrollTop - body.clientHeight < 80;
    const draftEl = viewport.querySelector('[data-testid="subagent-input"]');
    if (draftEl) state.subagentDrafts[state.viewingAgentId] = draftEl.value;
    const keepFocus = document.activeElement?.getAttribute?.('data-testid') === 'subagent-input';
    const selStart = keepFocus ? document.activeElement.selectionStart : null;
    const selEnd = keepFocus ? document.activeElement.selectionEnd : null;
    viewport.innerHTML = renderAgentPaneHtml();
    const next = viewport.querySelector('.agent-pane-body');
    if (next && stick) next.scrollTop = next.scrollHeight;
    const nextInput = viewport.querySelector('[data-testid="subagent-input"]');
    if (nextInput) {
      nextInput.value = state.subagentDrafts[state.viewingAgentId] || '';
      if (keepFocus) {
        nextInput.focus();
        if (selStart != null) nextInput.setSelectionRange(selStart, selEnd ?? selStart);
      }
      syncSubagentSendReady();
    }
    return;
  }
  if (state.activeRightTab === 'editor' && state.activeFilePath) {
    viewport.innerHTML = `
      <div class="md-editor-container" data-testid="md-editor">
        <div class="md-editor-toolbar">
          <span class="path">${escapeHtml(state.activeFilePath)}</span>
          <button type="button" class="btn btn-sm p" data-testid="md-editor-save" data-action="save-editor-file">${escapeHtml(t('btn_save'))}</button>
        </div>
        <div class="md-editor-content" contenteditable="true" spellcheck="false">${escapeHtml(state.activeFileContent ?? '')}</div>
      </div>
    `;
    return;
  }
  if (state.activeRightTab === 'file') {
    ensureWorkspaceTree();
    viewport.innerHTML = renderFileBrowserHtml();
    return;
  }
  const pane = viewport.querySelector('.changes-pane');
  const top = pane ? pane.scrollTop : 0;
  viewport.innerHTML = renderChangesPaneHtml(visibleChanges);
  const next = viewport.querySelector('.changes-pane');
  if (next) next.scrollTop = top;
}

function renderFileBrowserHtml() {
  const treeHtml = workspaceTreeRowsHtml();
  const ws = (state.workspaces || []).find((w) => w.id === state.activeWorkspaceId);

  let preview;
  if (state.activeFilePath && state.activeFileContent != null && !looksBinary(state.activeFileContent)) {
    const shown = state.activeFileContent.length > 200000
      ? `${state.activeFileContent.slice(0, 200000)}\n…`
      : state.activeFileContent;
    const lines = shown.split('\n');
    const changed = changesWithDiff(state.changes).some((c) => c.path === state.activeFilePath);
    preview =
      `<div class="file-preview-head"><span>${escapeHtml(state.activeFilePath)}</span><span>${escapeHtml(changed ? t('file_modified_note') : t('file_lines', { n: lines.length }))}</span></div>` +
      `<div class="file-lines file-view-content">${lines.map((line, i) => `<div class="file-line"><span class="n">${i + 1}</span><span class="code">${escapeHtml(line)}</span></div>`).join('')}</div>`;
  } else if (state.activeFilePath && looksBinary(state.activeFileContent)) {
    preview = `<div class="file-preview-empty">${escapeHtml(state.activeFilePath)} — ${escapeHtml(t('file_binary'))}</div>`;
  } else {
    preview = `<div class="file-preview-empty">${escapeHtml(t('select_file_to_preview'))}</div>`;
  }

  return `
    <div class="file-browser" data-testid="file-tree">
      <div class="file-tree">${ws ? `<div class="file-tree-root" title="${escapeHtml(ws.path || '')}">${escapeHtml(truncatePath(ws.path || ws.name, 52))}</div>` : ''}${treeHtml}</div>
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
  localStorage.setItem('weft_active_right_tab', state.activeRightTab);
  setRightOpen(true);
  syncRightTabActive();
  loadFileOrDiff(state.activeFilePath);
}

export function switchRightTab(tab) {
  if (tab === 'agent') {
    showSubagentOverview();
    return;
  }
  const leaveAgent = state.activeRightTab === 'agent' || Boolean(state.viewingAgentId);
  state.activeRightTab = tab;
  if (tab !== 'agent') localStorage.setItem('weft_active_right_tab', tab);
  if (leaveAgent) clearSubagentView();
  setRightOpen(true);
  syncRightTabActive();
  if (leaveAgent) renderConversations();
  if (tab === 'file') {
    ensureWorkspaceTree();
    if (state.activeFilePath) loadFileOrDiff(state.activeFilePath);
    else renderRightPanel();
    return;
  }
  refreshChangeDiffs();
  renderRightPanel();
}

/** Loads the diff of every visible changed file that is expanded and not cached yet. */
function refreshChangeDiffs({ force = false } = {}) {
  const cid = state.activeConversationId;
  if (!cid) return;
  const visible = changesWithDiff(state.changes).slice(-30);
  const todo = visible.filter((ch) => !state.closedChangeFiles.has(ch.path) && (force || !state.diffs[ch.path]));
  if (!todo.length) return;
  Promise.all(todo.map((ch) => api(`/api/conversations/${encodeURIComponent(cid)}/diff?path=${encodeURIComponent(ch.path)}`)
    .then((d) => { if (state.activeConversationId === cid) state.diffs[ch.path] = d; })
    .catch(() => {})))
    .then(() => {
      if (state.activeConversationId === cid && (state.activeRightTab === 'diff' || !state.activeRightTab)) renderRightPanel();
    });
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
    confirm: confirmDialog,
    render: renderSettingsModal,
    renderChrome: () => {
      renderStatusBar();
      renderChatThread();
    },
    setContextWindow: setSourceContextWindow,
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
    applyContextOverridesToSettings();
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
  closeModelPop(state);
  const ui = state.modelsUi;
  if (ui?.tick) {
    clearInterval(ui.tick);
    ui.tick = null;
  }
  const ov = document.getElementById('settings-overlay');
  if (ov) ov.style.display = 'none';
}

function gitCtx() {
  return { state, t, escapeHtml, api, showToast, render: renderSettingsModal, confirm: confirmDialog };
}

function gitImportCtx() {
  return { state, t, escapeHtml, api, locale: getLocale };
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

  const models = tTab === 'models';
  const git = tTab === 'git';
  const ctx = models ? modelsCtx() : null;
  const pane = models
    ? renderModelsPane(ctx)
    : git
      ? renderGitPane(gitCtx())
      : `<div class="sm-body"><span class="sm-x" data-action="close-settings">×</span>${renderSettingsTabContent(tTab)}</div>`;
  ov.innerHTML = `
    <div class="sm">
      <div class="sm-nav">
        <h3>${escapeHtml(t('settings_title'))}</h3>
        <div class="${tTab === 'general' ? 'on' : ''}" data-action="set-settings-tab" data-tab="general">${escapeHtml(t('settings_tab_general'))}</div>
        <div class="${tTab === 'models' ? 'on' : ''}" data-action="set-settings-tab" data-tab="models">${escapeHtml(t('settings_tab_models'))}</div>
        <div class="${tTab === 'git' ? 'on' : ''}" data-action="set-settings-tab" data-tab="git" data-testid="settings-tab-git">${escapeHtml(t('settings_tab_git'))}</div>
        <div class="${tTab === 'plugins' ? 'on' : ''}" data-action="set-settings-tab" data-tab="plugins">${escapeHtml(t('settings_tab_plugins'))}</div>
        <div class="${tTab === 'skills' ? 'on' : ''}" data-action="set-settings-tab" data-tab="skills">${escapeHtml(t('settings_tab_skills'))}</div>
        <div class="${tTab === 'about' ? 'on' : ''}" data-action="set-settings-tab" data-tab="about">${escapeHtml(t('settings_tab_about'))}</div>
      </div>
      ${pane}
    </div>
    ${models ? renderModelPop(ctx) : ''}
    ${models ? renderContextWindowPop(ctx) : ''}
  `;
  if (models) mountModelsPane(state, t);
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
            <i><b style="background:#f5f5f5"></b><b style="background:#fcfcfc;flex:3"></b><b style="background:#2b2b2b;flex:.3"></b></i>${escapeHtml(t('theme_graphite'))}
          </div>
          <div class="${curTheme === 'claude' ? 'on' : ''}" data-action="switch-theme-family" data-family="claude">
            <i><b style="background:#f3f1ec"></b><b style="background:#faf9f6;flex:3"></b><b style="background:oklch(0.6 0.1 45);flex:.3"></b></i>${escapeHtml(t('theme_terra'))}
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

  if (tab === 'about') {
    const pkg = state.about || {};
    return `
      <h2>${escapeHtml(t('settings_tab_about'))}</h2>
      <div style="display:flex;align-items:center;gap:14px;margin-bottom:14px">
        <div style="width:44px;height:44px;border-radius:10px;background:var(--text-primary);color:var(--text-inverse);display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:700">W</div>
        <div>
          <b style="font-size:15px">${escapeHtml(t('app_name'))}</b>
          <div style="color:var(--text-muted);font-size:12px">${escapeHtml(t('about_desc'))}</div>
        </div>
      </div>
      <div class="row"><div class="l"><b>${escapeHtml(t('about_version'))}</b></div><span>${escapeHtml(pkg.version || '0.2.0')}</span></div>
      <div class="row"><div class="l"><b>${escapeHtml(t('about_repo'))}</b></div><a href="https://github.com/lawrencewzen/weft" target="_blank" rel="noopener">github.com/lawrencewzen/weft</a></div>
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
  state.activeSettingsTab = tab === 'agents' ? 'models' : tab;
  renderSettingsModal();
  if (state.activeSettingsTab === 'models') refreshGrokStatus();
}

function applyChromeLabels() {
  document.title = 'Weft';
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

function settingsOpen() {
  const ov = document.getElementById('settings-overlay');
  return Boolean(ov && ov.style.display !== 'none');
}

export async function switchAppearance(mode) {
  applyTheme(state.theme, mode);
  try { await api('/api/settings', 'PUT', { appearance: mode }); } catch { /* ignore */ }
  if (settingsOpen()) renderSettingsModal();
}

export async function switchThemeFamily(family) {
  applyTheme(family, state.appearance);
  try { await api('/api/settings', 'PUT', { theme: family }); } catch { /* ignore */ }
  if (settingsOpen()) renderSettingsModal();
}

export function switchFontSize(sz) {
  state.fontSize = sz;
  localStorage.setItem('weft_font_size', sz);
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
  if (code && (err?.body?.via === 'connection' || code === 'http_not_allowed' || code === 'host_mismatch' || code === 'not_gitlab')) {
    return gitImportCloneMessage(code, t);
  }
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
    btn.textContent = wsModalMode === 'git' ? gitImportProgressText(t) : t('ws_creating');
    document.getElementById('ws-dialog')?.classList.add('is-busy');
    const progress = document.getElementById('ws-modal-progress');
    progress?.classList.add('on');
    const text = document.getElementById('ws-progress-text');
    if (text) text.textContent = wsModalMode === 'git' ? gitImportProgressText(t) : t('ws_creating');
  } else {
    btn.disabled = false;
    btn.classList.remove('is-busy');
    btn.removeAttribute('aria-busy');
    btn.textContent = btn.dataset.idleLabel || t('btn_create');
    document.getElementById('ws-dialog')?.classList.remove('is-busy');
    document.getElementById('ws-modal-progress')?.classList.remove('on');
  }
}

// 新对话不弹窗：进入草稿状态，发出第一条消息时才真正创建
export async function startNewConversation(wid) {
  const target = wid || state.activeWorkspaceId;
  if (!target) {
    showToast('err_select_workspace');
    return;
  }
  state.draft = { modelSourceId: '', modelId: '' };
  if (state.activeWorkspaceId !== target) {
    await selectWorkspace(target, { draft: true });
  } else if (state.activeConversationId) {
    if (state.eventSource) {
      state.eventSource.close();
      state.eventSource = null;
    }
    state.activeConversationId = null;
    state.activeConversationData = null;
    localStorage.removeItem('weft_active_conv');
    resetRightPanelAndStatus();
    renderConversations();
    renderChatThread();
  }
  closeAgentMenu();
  renderStatusBar();
  document.querySelector('[data-testid="chat-input"]')?.focus();
}

export function openNewWorkspaceModal() {
  if (!wsCreating) {
    wsModalMode = 'local';
    resetGitImport();
  }
  openModal(`
    <div class="modal-dialog" id="ws-dialog">
      <h3>${escapeHtml(t('new_workspace'))} <span style="cursor:pointer;color:var(--text-muted)" data-action="close-modal">×</span></h3>
      <div class="seg seg-split" style="margin-bottom:8px">
        <span id="ws-modal-tab-local" class="on" data-action="toggle-ws-modal-tab" data-tab="local">${escapeHtml(t('ws_local_tab'))}</span>
        <span id="ws-modal-tab-git" data-action="toggle-ws-modal-tab" data-tab="git">${escapeHtml(t('ws_git_tab'))}</span>
      </div>
      <div id="ws-local-fields">
        <div class="form-group">
          <label>${escapeHtml(t('ws_name_label'))}</label>
          <input id="ws-name-input" data-testid="workspace-name-input" placeholder="${escapeHtml(t('ws_name_placeholder'))}" />
        </div>
        <div class="form-group">
          <label>${escapeHtml(t('ws_path_label'))}</label>
          <div class="path-row">
            <input id="ws-path-input" data-testid="workspace-path-input" placeholder="${escapeHtml(t('ws_path_placeholder'))}" />
            <button type="button" class="btn" data-action="ws-browse" data-testid="workspace-browse">${escapeHtml(t('ws_browse'))}</button>
          </div>
          <div id="ws-dir-browser" class="dir-browser" data-testid="dir-browser" hidden></div>
          <div id="ws-path-hint" class="form-hint">${state.allowedWorkspaceRoot ? escapeHtml(t('ws_path_hint', { root: state.allowedWorkspaceRoot })) : ''}</div>
        </div>
      </div>
      <div id="ws-git-fields" class="git-import-body" style="display:none">${renderGitImportBody(gitImportCtx())}</div>
      <div id="ws-modal-progress" class="git-progress" data-testid="git-progress"><span class="ms-spin" aria-hidden="true"></span><span id="ws-progress-text">${escapeHtml(t('ws_cloning'))}</span></div>
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

// ---- Folder picker in the new-workspace dialog ------------------------------
let dirBrowse = null;

function dirSep(root) {
  return String(root || '').includes('\\') && !String(root || '').includes('/') ? '\\' : '/';
}

function dirCrumbs(data) {
  const sep = dirSep(data.root);
  const root = String(data.root || '');
  const rootName = root.split(/[\\/]/).filter(Boolean).pop() || root;
  const crumbs = [{ label: rootName, path: root }];
  const rest = String(data.path || '').slice(root.length).split(/[\\/]/).filter(Boolean);
  let acc = root.replace(/[\\/]+$/, '');
  for (const part of rest) {
    acc = `${acc}${sep}${part}`;
    crumbs.push({ label: part, path: acc });
  }
  return crumbs;
}

function renderDirBrowser() {
  const host = document.getElementById('ws-dir-browser');
  if (!host || !dirBrowse) return;
  const { data, loading, error } = dirBrowse;
  const folderSvg = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M1.5 3.2c0-.6.4-1 1-1h2.3l1 1.2h3.7c.6 0 1 .4 1 1v4.4c0 .6-.4 1-1 1h-7c-.6 0-1-.4-1-1z"></path></svg>';
  const crumbs = data ? dirCrumbs(data) : [];
  let list;
  if (error) list = `<div class="dir-note is-error">${escapeHtml(error)}</div>`;
  else if (!data) list = `<div class="dir-note">${escapeHtml(t('loading'))}</div>`;
  else if (!data.entries.length) list = `<div class="dir-note">${escapeHtml(t('ws_dir_empty'))}</div>`;
  else {
    list = data.entries.map((ent) =>
      `<div class="dir-row" data-action="ws-dir-open" data-path="${escapeHtml(ent.path)}" data-testid="dir-row" title="${escapeHtml(ent.path)}">` +
      `<span class="dir-icon">${folderSvg}</span><span class="dir-name">${escapeHtml(ent.name)}</span>` +
      (ent.git ? '<span class="dir-git">Git</span>' : '') +
      `<button type="button" class="dir-choose" data-action="ws-dir-choose" data-path="${escapeHtml(ent.path)}" data-testid="dir-choose">${escapeHtml(t('ws_dir_choose'))}</button>` +
      `</div>`).join('') +
      (data.truncated ? `<div class="dir-note">${escapeHtml(t('ws_dir_truncated'))}</div>` : '');
  }
  host.innerHTML =
    `<div class="dir-crumbs">` +
    (data?.parent ? `<button type="button" class="dir-up" data-action="ws-dir-open" data-path="${escapeHtml(data.parent)}" title="${escapeHtml(t('ws_dir_up'))}">←</button>` : '') +
    crumbs.map((c, i) => (i === crumbs.length - 1
      ? `<span class="dir-crumb is-current">${escapeHtml(c.label)}</span>`
      : `<button type="button" class="dir-crumb" data-action="ws-dir-open" data-path="${escapeHtml(c.path)}">${escapeHtml(c.label)}</button><span class="dir-crumb-sep">/</span>`)).join('') +
    (loading ? '<span class="ms-spin dir-spin" aria-hidden="true"></span>' : '') +
    `</div>` +
    `<div class="dir-list">${list}</div>` +
    `<div class="dir-foot">` +
    `<span class="dir-foot-path" title="${escapeHtml(data?.path || '')}">${escapeHtml(data?.path || '')}${data?.git ? ' · Git' : ''}</span>` +
    `<button type="button" class="btn p" data-action="ws-dir-choose" data-path="${escapeHtml(data?.path || '')}" data-testid="dir-choose-here"${data?.selectable ? '' : ' disabled'}>${escapeHtml(t('ws_dir_choose_here'))}</button>` +
    `</div>`;
}

async function openDirBrowser(dirPath) {
  const seq = (dirBrowse?.seq || 0) + 1;
  dirBrowse = { ...(dirBrowse || {}), seq, loading: true, error: '' };
  renderDirBrowser();
  try {
    const q = dirPath ? `?path=${encodeURIComponent(dirPath)}` : '';
    const data = await api(`/api/workspace-root/dirs${q}`);
    if (dirBrowse?.seq !== seq) return;
    dirBrowse = { seq, data, loading: false, error: '' };
  } catch (err) {
    if (dirBrowse?.seq !== seq) return;
    dirBrowse = { ...dirBrowse, loading: false, error: t('ws_dir_error') };
  }
  renderDirBrowser();
}

function toggleDirBrowser() {
  const host = document.getElementById('ws-dir-browser');
  if (!host) return;
  if (!host.hidden) {
    host.hidden = true;
    return;
  }
  host.hidden = false;
  const typed = document.getElementById('ws-path-input')?.value.trim();
  dirBrowse = null;
  openDirBrowser(typed || '').then(() => {
    // A typed path outside the root falls back to the root itself.
    if (typed && dirBrowse?.error) openDirBrowser('');
  });
}

function chooseDir(dirPath) {
  if (!dirPath) return;
  const input = document.getElementById('ws-path-input');
  if (input) input.value = dirPath;
  const name = document.getElementById('ws-name-input');
  if (name && !name.value.trim()) name.value = dirPath.split(/[\\/]/).filter(Boolean).pop() || '';
  const host = document.getElementById('ws-dir-browser');
  if (host) host.hidden = true;
  clearWorkspaceModalError();
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
  const dialog = document.getElementById('ws-dialog');

  if (mode === 'local') {
    tabLoc?.classList.add('on');
    tabGit?.classList.remove('on');
    dialog?.classList.remove('git-import');
    if (locFields) locFields.style.display = 'flex';
    if (gitFields) gitFields.style.display = 'none';
    const submit = document.querySelector('[data-testid="workspace-create-submit"]');
    if (submit && !wsCreating) submit.disabled = false;
  } else {
    tabLoc?.classList.remove('on');
    tabGit?.classList.add('on');
    dialog?.classList.add('git-import');
    if (locFields) locFields.style.display = 'none';
    if (gitFields) gitFields.style.display = 'flex';
    void activateGitImport(gitImportCtx());
  }
}

export async function submitWorkspaceModal() {
  if (wsCreating) return;
  clearWorkspaceModalError();
  const name = document.getElementById('ws-name-input')?.value.trim();
  if (wsModalMode !== 'git' && !name) {
    showWorkspaceModalError(t('ws_name_required'));
    return;
  }

  let payload;
  if (wsModalMode === 'git') {
    const picked = gitImportPayload();
    if (picked.error === 'project') {
      showWorkspaceModalError(t('git_need_project'));
      return;
    }
    if (!picked.name) {
      showWorkspaceModalError(t('ws_name_required'));
      return;
    }
    if (gitImportSource() === 'address') {
      if (!picked.gitUrl) {
        showWorkspaceModalError(t('ws_git_required'));
        return;
      }
      if (!isSupportedGitUrl(picked.gitUrl)) {
        showWorkspaceModalError(t('ws_err_git_url'));
        return;
      }
    }
    payload = picked;
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
  if (wid && state.activeWorkspaceId !== wid) {
    if (cid) localStorage.setItem('weft_active_conv', cid);
    await selectWorkspace(wid);
  }
  if (state.activeConversationId !== cid) {
    await selectConversation(cid);
    return;
  }
  revealMainConversationPane();
}


// ============================================================================
// Layout: side panels, resizing, context menus
// ============================================================================
const LEFT_OVERLAY_BELOW = 860;
const RIGHT_OVERLAY_BELOW = 1180;

function persistOpenProjects() {
  localStorage.setItem('weft_open_projects', JSON.stringify([...state.openProjects]));
}

function openProject(wid) {
  if (!wid || state.openProjects.has(wid)) return;
  state.openProjects.add(wid);
  persistOpenProjects();
}

function toggleProject(wid) {
  if (!wid) return;
  const isOpen = state.openProjects.has(wid) || (wid === state.activeWorkspaceId && state.openProjects.size === 0);
  if (isOpen) state.openProjects.delete(wid);
  else state.openProjects.add(wid);
  persistOpenProjects();
  renderSidebarWorkspaces();
}

export function applyLayout() {
  const shell = document.getElementById('app-shell');
  if (!shell) return;
  // Overlay positioning below the breakpoints lives in app.css media queries.
  shell.classList.toggle('left-closed', !state.leftOpen);
  shell.classList.toggle('right-closed', !state.rightOpen);
  shell.style.setProperty('--left-w', `${state.leftW}px`);
  shell.style.setProperty('--right-w', `${state.rightW}px`);
}

export function setLeftOpen(open) {
  state.leftOpen = Boolean(open);
  if (window.innerWidth >= LEFT_OVERLAY_BELOW) localStorage.setItem('weft_left_open', String(state.leftOpen));
  applyLayout();
}

export function setRightOpen(open) {
  state.rightOpen = Boolean(open);
  if (window.innerWidth >= RIGHT_OVERLAY_BELOW) localStorage.setItem('weft_right_open', String(state.rightOpen));
  applyLayout();
}

let lastLayoutWidth = window.innerWidth;

function onLayoutResize() {
  const vw = window.innerWidth;
  if (lastLayoutWidth >= LEFT_OVERLAY_BELOW && vw < LEFT_OVERLAY_BELOW) state.leftOpen = false;
  if (lastLayoutWidth < LEFT_OVERLAY_BELOW && vw >= LEFT_OVERLAY_BELOW) state.leftOpen = readPref('weft_left_open', true);
  if (lastLayoutWidth >= RIGHT_OVERLAY_BELOW && vw < RIGHT_OVERLAY_BELOW) state.rightOpen = false;
  if (lastLayoutWidth < RIGHT_OVERLAY_BELOW && vw >= RIGHT_OVERLAY_BELOW) state.rightOpen = readPref('weft_right_open', true);
  lastLayoutWidth = vw;
  applyLayout();
}

/** A floating side panel closes when the chat behind it is clicked. */
function closeOverlaysFrom(target) {
  if (!target?.closest?.('#col-center')) return;
  const vw = window.innerWidth;
  if (vw < LEFT_OVERLAY_BELOW && state.leftOpen) setLeftOpen(false);
  if (vw < RIGHT_OVERLAY_BELOW && state.rightOpen && !target.closest('[data-action="toggle-right"],[data-action="open-subagent"],[data-action="open-file-in-editor"]')) setRightOpen(false);
}

function startDividerDrag(e, side) {
  if (e.button !== 0) return;
  e.preventDefault();
  const shell = document.getElementById('app-shell');
  const divider = e.currentTarget;
  const startX = e.clientX;
  const startW = side === 'left' ? state.leftW : state.rightW;
  const move = (ev) => {
    const dx = ev.clientX - startX;
    if (side === 'left') {
      state.leftW = clampNum(startW + dx, 200, 420);
    } else {
      const max = Math.max(360, window.innerWidth - (state.leftOpen ? state.leftW : 0) - 420);
      state.rightW = clampNum(startW - dx, 320, max);
    }
    applyLayout();
  };
  const up = () => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    shell?.classList.remove('is-dragging');
    divider.classList.remove('is-active');
    localStorage.setItem('weft_left_w', String(state.leftW));
    localStorage.setItem('weft_right_w', String(state.rightW));
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
  shell?.classList.add('is-dragging');
  divider.classList.add('is-active');
}

function resetDivider(side) {
  if (side === 'left') state.leftW = 264;
  else state.rightW = 440;
  localStorage.setItem('weft_left_w', String(state.leftW));
  localStorage.setItem('weft_right_w', String(state.rightW));
  applyLayout();
}

function renderModeToggle() {
  const btn = document.getElementById('mode-toggle');
  if (!btn) return;
  const dark = document.documentElement.getAttribute('data-theme')?.endsWith('-dark');
  btn.title = dark ? t('switch_to_light') : t('switch_to_dark');
  btn.setAttribute('aria-label', btn.title);
  btn.innerHTML = dark
    ? '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><circle cx="7" cy="7" r="2.6"></circle><path d="M7 1.2v1.4M7 11.4v1.4M1.2 7h1.4M11.4 7h1.4M2.9 2.9l1 1M10.1 10.1l1 1M2.9 11.1l1-1M10.1 3.9l1-1"></path></svg>'
    : '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M11.8 8.6A5 5 0 0 1 5.4 2.2a5 5 0 1 0 6.4 6.4z"></path></svg>';
}

function toggleMode() {
  const dark = document.documentElement.getAttribute('data-theme')?.endsWith('-dark');
  switchAppearance(dark ? 'light' : 'dark');
}

// ---- Context menu ----------------------------------------------------------
let ctxItems = [];

function closeCtxMenu() {
  const menu = document.getElementById('ctx-menu');
  if (menu && !menu.hidden) {
    menu.hidden = true;
    menu.innerHTML = '';
  }
  ctxItems = [];
}

function openCtxMenu(e, items, title = '') {
  e.preventDefault();
  e.stopPropagation();
  const menu = document.getElementById('ctx-menu');
  if (!menu || !items.length) return;
  ctxItems = items;
  menu.innerHTML =
    (title ? `<div class="ctx-menu-title">${escapeHtml(title)}</div>` : '') +
    items.map((item, i) => (item.sep
      ? '<div class="ctx-menu-sep"></div>'
      : `<button type="button" class="ctx-menu-item${item.danger ? ' is-danger' : ''}" data-ctx-index="${i}" role="menuitem"${item.disabled ? ' disabled' : ''}>` +
        `<span>${escapeHtml(item.label)}</span></button>`)).join('');
  menu.hidden = false;
  const w = menu.offsetWidth || 220;
  const h = menu.offsetHeight || 120;
  const anchor = e.type === 'click' && e.currentTarget?.getBoundingClientRect ? e.currentTarget.getBoundingClientRect() : null;
  const target = e.type === 'click' ? (e.target.closest('[data-action]') || e.target) : null;
  const r = anchor && anchor.width ? anchor : target?.getBoundingClientRect?.();
  let x = r ? (r.left + w > window.innerWidth ? r.right - w : r.left) : e.clientX;
  let y = r ? (r.bottom + h + 8 > window.innerHeight ? r.top - h - 4 : r.bottom + 4) : e.clientY;
  x = Math.max(8, Math.min(x, window.innerWidth - w - 8));
  y = Math.max(8, Math.min(y, window.innerHeight - h - 8));
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    showToast('copied');
  } catch {
    showToast('err_copy');
  }
}

function projectMenuItems(wid) {
  const ws = state.workspaces.find((w) => w.id === wid);
  if (!ws) return [];
  return [
    { label: t('new_conversation'), run: () => startNewConversation(wid) },
    { label: t('copy_path'), run: () => copyText(ws.path || '') },
    { label: t('show_files'), run: async () => { if (state.activeWorkspaceId !== wid) await selectWorkspace(wid); switchRightTab('file'); } },
    { sep: true },
    { label: t('ws_remove'), danger: true, run: () => removeWorkspace(wid) },
  ];
}

/** Hides the workspace from the list. Files on disk and its conversations are kept. */
async function removeWorkspace(wid) {
  const ws = state.workspaces.find((w) => w.id === wid);
  if (!ws) return;
  const busy = projectConversations(wid).some((c) => ACTIVE_RUN.has(c.status));
  if (busy) {
    showToast('ws_remove_busy');
    return;
  }
  const ok = await confirmDialog({
    title: t('ws_remove_title', { name: ws.name }),
    message: t('ws_remove_message', { path: ws.path || '' }),
    confirmLabel: t('ws_remove'),
    danger: true,
  });
  if (!ok) return;
  try {
    await api(`/api/workspaces/${encodeURIComponent(wid)}`, 'DELETE');
  } catch (err) {
    showToast(err?.status === 409 || err?.body?.code === 'E_WS_BUSY' ? 'ws_remove_busy' : (err?.message || 'err_save'));
    return;
  }
  state.openProjects.delete(wid);
  persistOpenProjects();
  delete state.allConversations[wid];
  if (state.activeWorkspaceId === wid) {
    if (state.eventSource) {
      state.eventSource.close();
      state.eventSource = null;
    }
    state.activeWorkspaceId = null;
    state.activeConversationId = null;
    state.activeConversationData = null;
    localStorage.removeItem('weft_active_ws');
    localStorage.removeItem('weft_active_conv');
  }
  showToast('ws_removed', { name: ws.name });
  await loadWorkspaces();
}

function conversationMenuItems(wid, cid) {
  const conv = projectConversations(wid).find((c) => c.id === cid) || {};
  const running = ACTIVE_RUN.has(conv.status);
  const items = [];
  if (running) {
    items.push({ label: t('btn_stop'), run: async () => { await switchWorkspaceAndConv(wid, cid); stopConversation(); } });
    items.push({ sep: true });
  }
  items.push({ label: t('open_conversation'), run: () => switchWorkspaceAndConv(wid, cid) });
  items.push({ label: t('copy_conversation_id'), run: () => copyText(cid) });
  return items;
}

function subagentMenuItems(aid) {
  const agent = (state.activeConversationData?.agents || []).find((a) => a.id === aid) || {};
  return [
    { label: t('subagent_open'), run: () => openSubagent(aid) },
    { label: t('copy_output'), disabled: !agent.lastText, run: () => copyText(agent.lastText || '') },
  ];
}

function changeFileMenuItems(filePath) {
  return [
    { label: t('show_in_files'), run: () => { state.activeFilePath = filePath; switchRightTab('file'); } },
    { label: t('copy_path'), run: () => copyText(filePath) },
  ];
}

function handleContextMenu(e) {
  const el = e.target.closest('[data-ctx]');
  if (!el) {
    closeCtxMenu();
    return;
  }
  const kind = el.getAttribute('data-ctx');
  if (kind === 'project') {
    const wid = el.getAttribute('data-ws-id');
    const ws = state.workspaces.find((w) => w.id === wid);
    openCtxMenu(e, projectMenuItems(wid), ws?.name || '');
  } else if (kind === 'conversation') {
    const wid = el.getAttribute('data-ws-id');
    const cid = el.getAttribute('data-conv-id');
    openCtxMenu(e, conversationMenuItems(wid, cid), el.getAttribute('title') || '');
  } else if (kind === 'subagent') {
    openCtxMenu(e, subagentMenuItems(el.getAttribute('data-agent-id')), t('subagent_tag'));
  } else if (kind === 'change-file') {
    openCtxMenu(e, changeFileMenuItems(el.getAttribute('data-path')), el.getAttribute('data-path') || '');
  }
}

function openDraftProjectMenu(e) {
  const items = state.workspaces.map((ws) => ({
    label: (ws.id === state.activeWorkspaceId ? '✓ ' : '') + ws.name,
    run: () => startNewConversation(ws.id),
  }));
  items.push({ sep: true }, { label: t('new_workspace'), run: () => openNewWorkspaceModal() });
  openCtxMenu(e, items, t('pick_project'));
}

function openProjectChipMenu(e) {
  const wid = state.activeWorkspaceId;
  if (!wid) return;
  const ws = state.workspaces.find((w) => w.id === wid);
  openCtxMenu(e, projectMenuItems(wid), ws?.path || ws?.name || '');
}

function newChatFromTop() {
  const wid = state.activeWorkspaceId || state.workspaces[0]?.id;
  if (!wid) {
    openNewWorkspaceModal();
    return;
  }
  startNewConversation(wid);
}

document.addEventListener('contextmenu', handleContextMenu);
document.addEventListener('mousedown', (e) => {
  const divider = e.target.closest?.('.col-divider');
  if (divider) startDividerDrag(e, divider.getAttribute('data-side'));
  if (!e.target.closest?.('#ctx-menu')) {
    const menu = document.getElementById('ctx-menu');
    if (menu && !menu.hidden && !e.target.closest?.('[data-action="project-menu"],[data-action="pick-draft-project"],[data-action="project-chip-menu"]')) closeCtxMenu();
  }
});
document.addEventListener('dblclick', (e) => {
  const divider = e.target.closest?.('.col-divider');
  if (divider) resetDivider(divider.getAttribute('data-side'));
});
document.addEventListener('click', (e) => {
  const item = e.target.closest?.('#ctx-menu [data-ctx-index]');
  if (!item) return;
  const entry = ctxItems[Number(item.getAttribute('data-ctx-index'))];
  closeCtxMenu();
  entry?.run?.();
}, true);
window.addEventListener('resize', () => {
  onLayoutResize();
  closeCtxMenu();
});
document.addEventListener('pointerdown', (e) => closeOverlaysFrom(e.target));
window.addEventListener('blur', closeCtxMenu);

// Global exposure for external or test compatibility
window.__app = {
  selectWorkspace,
  selectConversation,
  switchWorkspaceAndConv,
  sendMessage,
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
  handleUnauthorized,
};

// ============================================================================
// Event Delegation
// ============================================================================
document.addEventListener('click', (e) => {
  const ui = state.modelsUi;
  if (ui?.pickerOpen && !e.target.closest?.('.model-pop') && !e.target.closest?.('[data-action="toggle-model-pick"]')) {
    closeModelPop(state);
  }
  if (ui?.contextPicker && !e.target.closest?.('#context-window-pop') && !e.target.closest?.('[data-action="ms-toggle-context-window"]')) {
    closeContextWindowPop(state);
  }
  const agentMenu = document.getElementById('composer-agent-menu');
  if (agentMenu?.classList.contains('is-open') && !e.target.closest('#composer-agent-wrap')) {
    closeAgentMenu();
  }
  const contextMenu = document.getElementById('composer-context-menu');
  if (contextMenu?.classList.contains('is-open') && !e.target.closest('#composer-context-wrap')) {
    closeContextMenu();
  }
  if (state.subagentPickerOpen && !e.target.closest?.('[data-testid="subagent-picker"], [data-action="toggle-subagent-picker"]')) {
    closeSubagentPicker();
  }
  if (e.target.id === 'settings-overlay') {
    closeSettings();
    return;
  }
  if (e.target.id === 'dialog-overlay') {
    closeModal();
    return;
  }

  if (!e.target.closest?.('.git-pick')) closeGitImportPops(gitImportCtx());

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
    case 'stop-conversation':
      stopConversation();
      break;
    case 'send-message': {
      const composer = document.querySelector('[data-testid="chat-input"]');
      if (composer) {
        const val = composer.value.trim();
        if (val) {
          composer.value = '';
          sendMessage(val);
          syncSendReady();
        }
      }
      break;
    }
    case 'continue-truncated':
      sendMessage(MANUAL_CONTINUE_TEXT);
      break;
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
      if (window.innerWidth < LEFT_OVERLAY_BELOW) setLeftOpen(false);
      break;
    case 'toggle-tool-group':
      toggleToolGroup(actionEl.getAttribute('data-group-id'));
      break;
    case 'expand-tool-group-older':
      expandToolGroupOlder(actionEl.getAttribute('data-group-id'));
      break;
    case 'expand-tool-output':
      expandToolOutput(actionEl.getAttribute('data-tool-id'));
      break;
    case 'open-tool-diff':
      openToolFileDiff(actionEl.getAttribute('data-tool-id'));
      break;
    case 'toggle-tool':
      if (!e.target.closest('.tool-detail-card')) {
        toggleToolDetail(actionEl.getAttribute('data-tool-id'));
      }
      break;
    case 'load-file':
      toggleChangeFile(actionEl.getAttribute('data-path'));
      break;
    case 'toggle-left':
      setLeftOpen(!state.leftOpen);
      break;
    case 'toggle-right':
      setRightOpen(!state.rightOpen);
      if (state.rightOpen) renderRightPanel();
      break;
    case 'new-chat-top':
      newChatFromTop();
      break;
    case 'toggle-project':
      toggleProject(actionEl.getAttribute('data-ws-id'));
      break;
    case 'project-menu': {
      const wid = actionEl.getAttribute('data-ws-id');
      const ws = state.workspaces.find((w) => w.id === wid);
      openCtxMenu(e, projectMenuItems(wid), ws?.name || '');
      break;
    }
    case 'toggle-mode':
      toggleMode();
      break;
    case 'pick-draft-project':
      openDraftProjectMenu(e);
      break;
    case 'project-chip-menu':
      openProjectChipMenu(e);
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
    case 'ws-browse':
      toggleDirBrowser();
      break;
    case 'ws-dir-open':
      if (!e.target.closest('[data-action="ws-dir-choose"]')) openDirBrowser(actionEl.getAttribute('data-path'));
      break;
    case 'ws-dir-choose':
      chooseDir(actionEl.getAttribute('data-path'));
      break;
    case 'git-add':
    case 'git-close-drawer':
    case 'git-edit':
    case 'git-delete':
    case 'git-delete-form':
    case 'git-toggle-advanced':
    case 'git-kind':
    case 'git-test-row':
    case 'git-test-form':
    case 'git-save':
    case 'git-source':
    case 'git-conn-toggle':
    case 'git-conn-pick':
    case 'git-project':
    case 'git-branch-toggle':
    case 'git-branch-pick':
      void (async () => {
        const handled = await handleGitImportAction(action, actionEl, gitImportCtx());
        if (!handled) await handleGitAction(action, actionEl, gitCtx());
      })().catch((err) => {
        showToast(err?.message || 'err_save');
      });
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
    case 'open-subagent':
      openSubagent(actionEl.getAttribute('data-agent-id'));
      break;
    case 'show-subagent-overview':
      showSubagentOverview();
      break;
    case 'toggle-subagent-picker':
      toggleSubagentPicker();
      break;
    case 'toggle-subagent-tree':
      toggleSubagentTree(actionEl.getAttribute('data-conv-id'));
      break;
    case 'noop':
      break;
    case 'send-subagent':
      sendSubagentNudge();
      break;
    case 'stop-subagent':
      stopSubagent();
      break;
    case 'close-subagent':
      closeSubagentView();
      break;
    case 'toggle-agent-picker':
      toggleAgentMenu();
      break;
    case 'pick-model':
      pickComposerModel(actionEl);
      break;
    case 'toggle-context-menu':
      toggleContextMenu();
      break;
    case 'pick-context-window':
      void setSourceContextWindow(
        actionEl.getAttribute('data-source-id') || '',
        actionEl.getAttribute('data-model') || '',
        actionEl.getAttribute('data-tokens'),
      );
      break;
    default:
      if (action === 'toggle-model-pick' || (action && action.startsWith('ms-'))) {
        void handleModelsAction(action, actionEl, modelsCtx()).catch((err) => {
          showToast(err?.message || 'err_save');
        });
        break;
      }
      break;
  }
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'plugin-search-input') {
    filterPlugins(e.target.value);
  } else if (e.target.id === 'skill-search-input') {
    filterSkills(e.target.value);
  } else if (e.target.id === 'ms-name' || e.target.id === 'ms-url' || e.target.id === 'ms-key' || e.target.id === 'ms-manual' || e.target.id === 'ms-grok-name' || e.target.id === 'ms-search') {
    onModelsField(e.target, modelsCtx());
  } else if (e.target.id === 'git-url' || e.target.id === 'git-token') {
    onGitField(e.target);
  } else if (e.target.id === 'git-search' || e.target.id === 'git-pick-name' || e.target.id === 'git-addr-name' || e.target.id === 'ws-git-url-input' || e.target.id === 'ws-branch-input') {
    onGitImportInput(e.target, gitImportCtx());
  } else if (e.target?.getAttribute?.('data-testid') === 'subagent-input') {
    const aid = state.viewingAgentId;
    if (aid) state.subagentDrafts[aid] = e.target.value;
    syncSubagentSendReady();
  }
});

document.addEventListener('focusin', (e) => {
  if (e.target?.id === 'git-token') onGitTokenFocus(e.target, t);
});

document.addEventListener('change', (e) => {
  if (e.target?.matches?.('[data-action="ms-toggle-model"]')) onModelsToggle(e.target, modelsCtx());
});

// ============================================================================
// Initialization
// ============================================================================
window.addEventListener('DOMContentLoaded', async () => {
  applyChromeLabels();
  startRelativeTimeTicker();
  const composer = document.querySelector('[data-testid="chat-input"]');

  if (composer) {
    composer.addEventListener('input', syncSendReady);
    composer.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229 && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        const val = composer.value.trim();
        if (val) {
          composer.value = '';
          sendMessage(val);
          syncSendReady();
        }
      }
    });
  }

  document.addEventListener('keydown', (e) => {
    if (e.target?.getAttribute?.('data-testid') !== 'subagent-input') return;
    if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229 && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      sendSubagentNudge();
    }
  });

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
      if (state.subagentPickerOpen) {
        closeSubagentPicker();
        return;
      }
      const menu = document.getElementById('ctx-menu');
      if (menu && !menu.hidden) {
        closeCtxMenu();
        return;
      }
      closeAgentMenu();
      closeContextMenu();
      closeSettings();
      closeModal();
    }
  });

  applyLayout();
  applyI18n();
  await loadInitialData();
  applyChromeLabels();
  renderModeToggle();
  renderStatusBar();
});
