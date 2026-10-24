// Settings → Models. Sources save in the drawer; the default model waits on the save bar.

import {
  resolveDispatchModel,
  sourceBlockReason,
  sourceNeedsKey,
  sourceUsable,
  needsFreshKey,
  isMaskedOrEmptyKey,
  httpOrigin,
} from './agent-chip.js';
import { formatProbeFailure, sourceProbeStatus } from './probe-error.js';
import {
  contextOverrideKey,
  contextWindowPresetOptions,
  formatTokenCount,
  hasCustomContextWindow,
  resolveContextWindow,
  sourceDefaultContextWindow,
} from './usage.js';

const FALLBACK_VENDORS = [
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', needsKey: true },
  { id: 'xai', name: 'xAI', baseUrl: 'https://api.x.ai/v1', needsKey: true },
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', needsKey: true },
  { id: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', needsKey: true },
  { id: 'gemini', name: 'Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', needsKey: true },
  { id: 'qwen', name: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', needsKey: true },
  { id: 'moonshot', name: 'Kimi', baseUrl: 'https://api.moonshot.cn/v1', needsKey: true },
  { id: 'zhipu', name: '智谱', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', needsKey: true },
  { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', needsKey: true },
  { id: 'ollama', name: '本地 Ollama', baseUrl: 'http://127.0.0.1:11434/v1', needsKey: false },
  { id: 'custom', name: '自定义 API', baseUrl: '', needsKey: true },
];

const ACCOUNTS = [
  { id: 'grok', mark: 'G', title: 'src_acc_grok', desc: 'src_acc_grok_desc', enabled: true },
  { id: 'codex', mark: 'C', title: 'src_acc_codex', desc: 'src_acc_codex_desc', enabled: false },
  { id: 'copilot', mark: 'H', title: 'src_acc_copilot', desc: 'src_acc_copilot_desc', enabled: false },
  { id: 'claude', mark: 'A', title: 'src_acc_claude', desc: 'src_acc_claude_desc', enabled: false },
];

function blankForm(vendorId = 'deepseek') {
  return {
    vendor: vendorId,
    baseUrl: '',
    apiKey: '',
    name: '',
    nameTouched: false,
    showKey: false,
    models: [],
    checked: {},
    manual: '',
    test: null,
    testing: false,
    warn: '',
    maskedKey: '',
    originalUrl: '',
    busy: false,
  };
}

function defaultUi() {
  return {
    ready: false,
    drawer: null,
    editId: null,
    form: blankForm(),
    grokName: '',
    grokChecked: {},
    draftDefault: null,
    savedDefault: null,
    pickerOpen: false,
    pickerQuery: '',
    tick: null,
    savingDefault: false,
    rowProbes: {},
    contextPicker: null,
  };
}

export function ensureModelsUi(state) {
  if (!state.modelsUi) state.modelsUi = defaultUi();
  return state.modelsUi;
}

function cloneDefaultBinding(models) {
  if (!models || typeof models !== 'object' || Array.isArray(models)) return null;
  const value = models.default;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const sourceId = typeof value.sourceId === 'string' ? value.sourceId.trim() : '';
  const model = typeof value.model === 'string' ? value.model.trim() : '';
  if (!sourceId || !model) return null;
  return { sourceId, model };
}

function sameBinding(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.sourceId === b.sourceId && a.model === b.model;
}

export function ensureDefaultBinding(state) {
  const ui = ensureModelsUi(state);
  if (!ui.ready) {
    const binding = cloneDefaultBinding(state.settings?.models);
    ui.draftDefault = binding;
    ui.savedDefault = binding;
    ui.ready = true;
  }
  return ui;
}

function readBinding(state) {
  return ensureDefaultBinding(state).draftDefault || null;
}

function writeBinding(state, binding) {
  const ui = ensureDefaultBinding(state);
  ui.draftDefault = binding?.sourceId && binding?.model
    ? { sourceId: binding.sourceId, model: binding.model }
    : null;
}

export function revertDefaultBinding(state) {
  const ui = ensureDefaultBinding(state);
  const saved = ui.savedDefault || null;
  ui.draftDefault = saved ? { sourceId: saved.sourceId, model: saved.model } : null;
}

export function noteSettingsReloaded(state) {
  const ui = state.modelsUi;
  if (!ui?.ready) return;
  const saved = cloneDefaultBinding(state.settings?.models);
  if (sameBinding(ui.draftDefault, ui.savedDefault)) {
    ui.draftDefault = saved;
    ui.savedDefault = saved;
    return;
  }
  const sources = state.settings?.sources || [];
  const binding = ui.draftDefault;
  if (binding) {
    const source = sources.find((item) => item.id === binding.sourceId);
    const names = Array.isArray(source?.models) ? source.models : [];
    if (!source || (names.length && !names.includes(binding.model))) ui.draftDefault = null;
  }
  ui.savedDefault = saved;
}

function vendorsOf(state) {
  const list = state.settings?.vendors;
  return Array.isArray(list) && list.length ? list : FALLBACK_VENDORS;
}

function vendorById(state, id) {
  return vendorsOf(state).find((item) => item.id === id) || null;
}

function sourcesOf(state) {
  return Array.isArray(state.settings?.sources) ? state.settings.sources : [];
}

function grokSignedIn(state) {
  return Boolean(state.settings?.grok?.signedIn);
}

function kindKey(source, state) {
  if (source.kind === 'grok') return 'src_kind_grok';
  const vendor = vendorById(state, source.vendor);
  if (source.vendor === 'ollama' || vendor?.needsKey === false || source.needsKey === false) return 'src_kind_local';
  return 'src_kind_api';
}

function hostLabel(baseUrl) {
  try {
    const url = new URL(String(baseUrl || ''));
    return `${url.hostname}${url.port ? `:${url.port}` : ''}`;
  } catch {
    return String(baseUrl || '');
  }
}

function formatStamp(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function testedWhen(iso, t) {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '';
  const sec = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (sec < 45) return t('src_tested_just');
  if (sec < 3600) return t('src_tested_min', { n: Math.max(1, Math.round(sec / 60)) });
  if (sec < 86400) return t('src_tested_hour', { n: Math.max(1, Math.round(sec / 3600)) });
  return t('src_tested_day', { n: Math.max(1, Math.round(sec / 86400)) });
}

function reasonText(source, reason, t) {
  return sourceProbeStatus(source, reason, t);
}

function probeResultText(test, t) {
  if (!test || test.ok) return '';
  if (test.text) return test.text;
  return formatProbeFailure(test, t) || t('src_test_failed');
}

function bindingUsable(binding, state) {
  if (!binding) return false;
  const source = sourcesOf(state).find((item) => item.id === binding.sourceId);
  if (!source || !sourceUsable(source, { grokSignedIn: grokSignedIn(state) })) return false;
  return (source.models || []).includes(binding.model);
}

function draftModels(ui) {
  return ui.draftDefault ? { default: ui.draftDefault } : {};
}

function effectiveModel(state) {
  const ui = ensureModelsUi(state);
  return resolveDispatchModel({
    models: draftModels(ui),
    sources: sourcesOf(state),
    grokSignedIn: grokSignedIn(state),
  });
}

function defaultChange(state) {
  const ui = ensureDefaultBinding(state);
  const next = ui.draftDefault || null;
  const prev = ui.savedDefault || null;
  if (sameBinding(next, prev)) return null;
  return { next, prev };
}

function safeHttps(url) {
  try {
    const parsed = new URL(String(url || ''));
    if (parsed.protocol !== 'https:') return '';
    const host = parsed.hostname.toLowerCase();
    if (host !== 'x.ai' && !host.endsWith('.x.ai')) return '';
    return parsed.href;
  } catch {
    return '';
  }
}

function remainText(iso, t) {
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms)) return '';
  if (ms <= 0) return t('src_code_expired');
  const total = Math.floor(ms / 1000);
  const min = Math.floor(total / 60);
  const sec = total % 60;
  return t('src_code_expires', { time: `${min}:${String(sec).padStart(2, '0')}` });
}

function applyVendorDefaults(state, ui, vendorId, { keepUrl = false } = {}) {
  const vendor = vendorById(state, vendorId) || FALLBACK_VENDORS[0];
  ui.form.vendor = vendor.id;
  if (!keepUrl) {
    ui.form.baseUrl = vendor.id === 'custom' ? (ui.form.baseUrl || '') : (vendor.baseUrl || '');
  }
  if (!ui.form.nameTouched) ui.form.name = vendor.name || '';
  ui.form.warn = '';
}

function prepareAddForm(state, ui, vendorId) {
  ui.editId = null;
  ui.form = blankForm(vendorId);
  applyVendorDefaults(state, ui, vendorId);
}

function prepareEditForm(state, ui, source) {
  ui.editId = source.id;
  ui.form = blankForm(source.vendor || 'custom');
  ui.form.vendor = source.vendor || 'custom';
  ui.form.baseUrl = source.baseUrl || '';
  ui.form.originalUrl = source.baseUrl || '';
  ui.form.apiKey = source.apiKey || '';
  ui.form.maskedKey = source.apiKey || '';
  ui.form.name = source.name || '';
  ui.form.nameTouched = true;
  const enabled = (source.models || []).filter((name) => typeof name === 'string' && name.trim());
  const catalog = Array.isArray(source.catalog)
    ? source.catalog.filter((name) => typeof name === 'string' && name.trim())
    : [];
  const names = catalog.length ? [...catalog] : [...enabled];
  for (const name of enabled) {
    if (!names.includes(name)) names.push(name);
  }
  ui.form.models = names;
  ui.form.checked = Object.fromEntries(names.map((name) => [name, enabled.includes(name)]));
}

function prepareGrokEdit(ui, source) {
  ui.editId = source.id;
  ui.grokName = source.name || '';
  ui.grokChecked = Object.fromEntries((source.models || []).map((name) => [name, true]));
  ui.form = blankForm();
  ui.form.models = [...(source.models || [])];
}

function checkedModels(form) {
  return (form.models || []).filter((name) => form.checked[name]);
}

function hostWarnActive(state, ui) {
  if (!ui.editId) return false;
  const source = sourcesOf(state).find((item) => item.id === ui.editId);
  if (!source || source.kind === 'grok') return false;
  const vendor = vendorById(state, ui.form.vendor);
  const needsKey = vendor ? vendor.needsKey !== false : sourceNeedsKey({ ...source, vendor: ui.form.vendor });
  return needsFreshKey({
    previousUrl: source.baseUrl || '',
    nextUrl: ui.form.baseUrl || '',
    apiKey: ui.form.apiKey,
    maskedKey: source.apiKey || '',
    needsKey,
  });
}

function formNeedsKey(state, ui) {
  const vendor = vendorById(state, ui.form.vendor);
  if (vendor) return vendor.needsKey !== false;
  return ui.form.vendor !== 'ollama';
}

async function reloadSettings(ctx) {
  const settings = await ctx.api('/api/settings');
  ctx.state.settings = settings;
  noteSettingsReloaded(ctx.state);
  return settings;
}

function stopTick(ui) {
  if (ui?.tick) {
    clearInterval(ui.tick);
    ui.tick = null;
  }
}

export function mountModelsPane(state, t) {
  const ui = ensureModelsUi(state);
  stopTick(ui);
  const pending = state.grokPending || state.settings?.grok?.pending;
  if (ui.drawer === 'grok' && pending?.expiresAt) {
    ui.tick = setInterval(() => {
      const el = document.getElementById('ms-grok-expire');
      if (!el) {
        stopTick(ui);
        return;
      }
      el.textContent = remainText(pending.expiresAt, t);
    }, 1000);
  }
  syncModelPop(state);
  const scroller = document.getElementById('ms-scroll');
  if (scroller) {
    const start = scroller.scrollTop;
    let armed = false;
    const arm = setTimeout(() => { armed = true; }, 0);
    const onScroll = () => {
      if (!armed || Math.abs(scroller.scrollTop - start) < 2) return;
      clearTimeout(arm);
      scroller.removeEventListener('scroll', onScroll);
      closeModelPop(state);
      closeContextWindowPop(state);
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
  }
  positionContextWindowPop(state);
}

export function closeModelPop(state) {
  const ui = state.modelsUi;
  if (!ui?.pickerOpen) return;
  ui.pickerOpen = false;
  ui.pickerQuery = '';
  document.getElementById('model-pop')?.classList.remove('open');
}

export function closeContextWindowPop(state) {
  const ui = state.modelsUi;
  if (!ui?.contextPicker) return;
  ui.contextPicker = null;
  document.getElementById('context-window-pop')?.classList.remove('open');
}

export function syncModelPop(state) {
  const ui = ensureModelsUi(state);
  if (!ui.pickerOpen) return;
  positionModelPop();
  const search = document.getElementById('ms-search');
  if (search && document.activeElement !== search) search.focus({ preventScroll: true });
}

function positionModelPop() {
  const pop = document.getElementById('model-pop');
  const btn = document.querySelector('[data-action="toggle-model-pick"][data-testid="model-pick"]');
  if (!pop || !btn) return;
  pop.classList.add('open');
  const rect = btn.getBoundingClientRect();
  const modal = document.querySelector('.sm')?.getBoundingClientRect();
  const limitBottom = (modal?.bottom ?? window.innerHeight) - 8;
  const limitTop = (modal?.top ?? 0) + 8;
  const limitLeft = (modal?.left ?? 0) + 8;
  const limitRight = (modal?.right ?? window.innerWidth) - 8;
  const width = Math.min(360, Math.max(220, limitRight - limitLeft));
  pop.style.width = `${width}px`;
  let left = rect.right - width;
  left = Math.max(limitLeft, Math.min(left, limitRight - width));
  pop.style.left = `${left}px`;
  pop.style.maxHeight = '';
  let height = pop.offsetHeight;
  let top = rect.bottom + 4;
  if (top + height > limitBottom) top = rect.top - 4 - height;
  if (top < limitTop) {
    const available = Math.max(160, limitBottom - limitTop);
    pop.style.maxHeight = `${available}px`;
    height = pop.offsetHeight;
    top = Math.max(limitTop, Math.min(rect.bottom + 4, limitBottom - height));
  }
  pop.style.top = `${top}px`;
}

function dotClass(reason) {
  if (!reason) return 'ok';
  if (reason === 'offline') return 'bad';
  if (reason === 'unsigned' || reason === 'no_key' || reason === 'no_url') return 'bad';
  return 'off';
}

function rowProbeOf(state, sourceId) {
  return ensureModelsUi(state).rowProbes?.[sourceId] || null;
}

function probeMarkHtml(probe, t, escapeHtml) {
  if (!probe || probe.phase === 'testing') return '';
  if (probe.ok) {
    return `<span class="ms-probe ok" data-testid="model-row-result"><span class="ms-mark" aria-hidden="true">✓</span>${escapeHtml(t('src_row_passed'))}</span>`;
  }
  const text = probe.text || formatProbeFailure(probe, t) || t('src_test_failed');
  return `<span class="ms-probe bad" data-testid="model-row-result"><span class="ms-mark" aria-hidden="true">✗</span>${escapeHtml(text)}</span>`;
}

function sourceTestButton(source, ctx, { usable, isGrok }) {
  const { t, escapeHtml, state } = ctx;
  const testing = rowProbeOf(state, source.id)?.phase === 'testing';
  const label = testing
    ? t('src_testing')
    : (isGrok ? t('src_refresh_models') : (usable ? t('src_test') : t('src_retry')));
  const spin = testing ? '<span class="ms-spin" aria-hidden="true"></span>' : '';
  return `<button type="button" class="btn g btn-sm" data-action="ms-test-source" data-source-id="${escapeHtml(source.id)}" data-testid="model-row-test"${testing ? ' disabled aria-busy="true"' : ''}>${spin}${escapeHtml(label)}</button>`;
}

function renderSourceRow(source, ctx) {
  const { t, escapeHtml, state } = ctx;
  const options = { grokSignedIn: grokSignedIn(state) };
  const reason = sourceBlockReason(source, options);
  const usable = !reason;
  const isGrok = source.kind === 'grok';
  const fresh = rowProbeOf(state, source.id);
  const settled = fresh && fresh.phase !== 'testing' ? fresh : null;
  const bits = [];
  if (isGrok && usable) {
    const email = source.session?.email || state.settings?.grok?.email || '';
    if (email) bits.push(`<span>${escapeHtml(email)}</span>`);
    const exp = formatStamp(source.session?.expiresAt || state.settings?.grok?.expiresAt);
    if (exp) bits.push(`<span>${escapeHtml(t('src_token_renews', { time: exp }))}</span>`);
    bits.push(`<span>${escapeHtml(t('src_not_metered'))}</span>`);
    if (settled) bits.push(probeMarkHtml(settled, t, escapeHtml));
  } else if (!usable) {
    const why = reasonText(source, reason, t);
    if (!isGrok && source.baseUrl) bits.push(`<span class="mono">${escapeHtml(hostLabel(source.baseUrl))}</span>`);
    else if (!isGrok && source.apiKey) bits.push(`<span class="mono">${escapeHtml(source.apiKey)}</span>`);
    if (settled && !settled.ok) bits.push(probeMarkHtml(settled, t, escapeHtml));
    else if (why) bits.push(`<span class="why">${escapeHtml(why)}</span>`);
  } else {
    if (source.apiKey) bits.push(`<span class="mono">${escapeHtml(source.apiKey)}</span>`);
    if (source.baseUrl) bits.push(`<span class="mono">${escapeHtml(hostLabel(source.baseUrl))}</span>`);
    if (settled?.ok) bits.push(probeMarkHtml(settled, t, escapeHtml));
    else if (source.lastTest?.ok) {
      const when = testedWhen(source.lastTest.at, t);
      if (when) bits.push(`<span>${escapeHtml(t('src_tested_ok', { when }))}</span>`);
    } else if (kindKey(source, state) === 'src_kind_api') {
      bits.push(`<span>${escapeHtml(t('src_metered'))}</span>`);
    }
  }
  const meta = bits.filter(Boolean).join('<span class="sep">·</span>');
  const enabledNames = (source.models || []).filter((name) => typeof name === 'string' && name.trim());
  const tags = !usable
    ? ''
    : (enabledNames.length
      ? enabledNames.map((name) => `<span class="ms-tag mono">${escapeHtml(name)}</span>`).join('')
      : `<span class="ms-none" data-testid="model-none-enabled">${escapeHtml(t('src_models_none'))}</span>`);
  const testBtn = sourceTestButton(source, ctx, { usable, isGrok });
  const actions = isGrok
    ? testBtn +
      `<button type="button" class="btn g btn-sm" data-action="ms-edit-source" data-source-id="${escapeHtml(source.id)}">${escapeHtml(t('src_edit'))}</button>`
    : testBtn +
      `<button type="button" class="btn g btn-sm" data-action="ms-edit-source" data-source-id="${escapeHtml(source.id)}">${escapeHtml(t('src_edit'))}</button>` +
      `<button type="button" class="btn g btn-sm" data-action="ms-delete-source" data-source-id="${escapeHtml(source.id)}">${escapeHtml(t('btn_delete'))}</button>`;
  return (
    `<div class="ms-src-row${usable ? '' : ' err'}" data-testid="model-source" data-source-id="${escapeHtml(source.id)}" data-usable="${usable ? 'true' : 'false'}">` +
    `<span class="ms-dot ${dotClass(reason)}"></span>` +
    `<div class="ms-src-main">` +
    `<div class="ms-src-title${usable ? '' : ' sec'}">${escapeHtml(source.name || source.id)} <span class="ms-tag">${escapeHtml(t(kindKey(source, state)))}</span></div>` +
    (meta ? `<div class="ms-src-meta">${meta}</div>` : '') +
    (tags ? `<div class="ms-models">${tags}</div>` : '') +
    `</div>` +
    `<div class="ms-src-acts">${actions}</div>` +
    `</div>`
  );
}

function pickVisual(ctx) {
  const { t, escapeHtml, state } = ctx;
  const binding = readBinding(state);
  const held = bindingUsable(binding, state) ? binding : null;
  const broken = Boolean(binding && !held);
  const effective = effectiveModel(state);
  const source = held ? sourcesOf(state).find((item) => item.id === held.sourceId) : null;
  const dot = broken ? 'warn' : (held ? 'ok' : 'off');
  let label;
  if (held) {
    label = `<span class="m mono">${escapeHtml(held.model)}</span>` +
      (source ? `<span class="from">${escapeHtml(source.name || '')}</span>` : '');
  } else if (effective) {
    label = `<span class="m mono">${escapeHtml(effective)}</span><span class="from">${escapeHtml(t('src_auto'))}</span>`;
  } else {
    label = `<span class="m">${escapeHtml(t('src_pick_model'))}</span>`;
  }
  let warn = '';
  if (broken) {
    const brokenSource = sourcesOf(state).find((item) => item.id === binding.sourceId);
    const brokenReason = brokenSource
      ? reasonText(brokenSource, sourceBlockReason(brokenSource, { grokSignedIn: grokSignedIn(state) }), t)
      : t('src_why_missing');
    const text = t('src_was_unavailable_default', { model: binding.model, reason: brokenReason, fallback: effective || t('src_none') });
    warn = `<div class="ms-role-warn">${escapeHtml(text)}</div>`;
  }
  return { held, dot, label, warn };
}

export function renderModelPickButton(ctx, { testId = 'model-pick' } = {}) {
  const { escapeHtml, state } = ctx;
  const ui = ensureModelsUi(state);
  const visual = pickVisual(ctx);
  const saved = ui.savedDefault || null;
  const binding = readBinding(state);
  const dirty = !sameBinding(binding, saved);
  let buttonClass = 'ms-pick-btn';
  if (dirty) buttonClass += ' dirty';
  return (
    `<button type="button" class="${buttonClass}" data-action="toggle-model-pick" data-testid="${escapeHtml(testId)}" aria-expanded="${ui.pickerOpen ? 'true' : 'false'}">` +
    `<span class="ms-dot ${visual.dot}"></span>${visual.label}<span class="ms-caret"></span>` +
    `</button>${visual.warn}`
  );
}

function renderDefaultRow(ctx) {
  const { t, escapeHtml } = ctx;
  return (
    `<div class="ms-role" data-testid="model-role">` +
    `<div class="ms-role-name"><b>${escapeHtml(t('src_default_title'))}</b></div>` +
    `<div class="ms-pick">${renderModelPickButton(ctx)}</div></div>`
  );
}

function renderPop(ctx) {
  const { t, escapeHtml, state } = ctx;
  const ui = ensureModelsUi(state);
  if (!ui.pickerOpen) return '';
  const query = String(ui.pickerQuery || '').trim().toLowerCase();
  const binding = readBinding(state);
  const held = bindingUsable(binding, state) ? binding : null;
  const options = { grokSignedIn: grokSignedIn(state) };
  const parts = [`<input class="ms-in ms-search" id="ms-search" data-testid="model-search" placeholder="${escapeHtml(t('src_search_models'))}" value="${escapeHtml(ui.pickerQuery || '')}" autocomplete="off">`];
  for (const source of sourcesOf(state)) {
    const reason = sourceBlockReason(source, options);
    const names = (source.models || []).filter((name) => typeof name === 'string' && name.trim());
    const visible = names.filter((name) => !query || name.toLowerCase().includes(query) || String(source.name || '').toLowerCase().includes(query));
    if (query && !visible.length) continue;
    const note = reason ? reasonText(source, reason, t) : '';
    parts.push(
      `<div class="ms-grp"><span class="ms-dot ${dotClass(reason)}"></span>${escapeHtml(source.name || source.id)}${note ? ` · ${escapeHtml(note)}` : ''}</div>`
    );
    if (!reason && !names.length) {
      parts.push(
        `<div class="ms-pop-empty" data-testid="model-pop-empty">` +
        `<span>${escapeHtml(t('src_no_enabled_models'))}</span>` +
        `<button type="button" data-action="ms-edit-source" data-source-id="${escapeHtml(source.id)}" data-testid="model-choose-models">${escapeHtml(t('src_choose_models'))}</button>` +
        `</div>`
      );
      continue;
    }
    for (const name of (query ? visible : names)) {
      const selected = held && held.sourceId === source.id && held.model === name;
      const dis = reason ? ' dis' : '';
      parts.push(
        `<button type="button" class="ms-opt mono${dis}${selected ? ' on' : ''}" data-action="ms-choose-model" data-source-id="${escapeHtml(source.id)}" data-model="${escapeHtml(name)}"${reason ? ' disabled' : ''}>` +
        `${escapeHtml(name)}${selected ? `<span class="x">${escapeHtml(t('src_selected_mark'))}</span>` : ''}` +
        `</button>`
      );
    }
  }
  parts.push(`<hr><button type="button" class="ms-opt sec" data-action="ms-pop-add">${escapeHtml(t('src_add_from_pop'))}</button>`);
  return parts.join('');
}

export function renderModelPop(ctx) {
  const ui = ensureModelsUi(ctx.state);
  if (!ui.pickerOpen) return '';
  return `<div class="model-pop open" id="model-pop" data-testid="model-pop" role="listbox">${renderPop(ctx)}</div>`;
}

function listedContextModels(state) {
  const rows = [];
  for (const source of sourcesOf(state)) {
    const names = (source.models || []).filter((name) => typeof name === 'string' && name.trim());
    for (const name of names) {
      rows.push({ source, model: name.trim() });
    }
  }
  return rows;
}

function renderContextWindowRows(ctx) {
  const { t, escapeHtml, state } = ctx;
  const rows = listedContextModels(state);
  if (!rows.length) return `<div class="ms-empty">${escapeHtml(t('src_models_none'))}</div>`;
  return rows.map(({ source, model }) => {
    const overrides = state.contextWindowOverrides || {};
    const current = resolveContextWindow({ model, source, overrides });
    const overrideKey = contextOverrideKey(source.id, model);
    const custom = overrideKey && Object.prototype.hasOwnProperty.call(overrides, overrideKey)
      ? overrides[overrideKey] != null
      : hasCustomContextWindow(source, model);
    const note = custom
      ? t('ctx_custom', { window: formatTokenCount(sourceDefaultContextWindow(source, model)) })
      : t('ctx_default');
    return (
      `<div class="ms-ctx-row" data-testid="context-window-row" data-source-id="${escapeHtml(source.id)}" data-model="${escapeHtml(model)}">` +
      `<div><div class="ms-ctx-name mono">${escapeHtml(model)}</div><div class="ms-ctx-note">${escapeHtml(note)}</div></div>` +
      `<button type="button" class="ms-pick-btn" data-action="ms-toggle-context-window" data-source-id="${escapeHtml(source.id)}" data-model="${escapeHtml(model)}" data-testid="context-window-pick" aria-expanded="${ctx.state.modelsUi?.contextPicker?.sourceId === source.id && ctx.state.modelsUi?.contextPicker?.model === model ? 'true' : 'false'}">` +
      `<span class="m mono">${escapeHtml(formatTokenCount(current) || String(current))}</span><span class="ms-caret"></span>` +
      `</button></div>`
    );
  }).join('');
}

function renderContextWindowsSection(ctx) {
  const { t, escapeHtml } = ctx;
  return (
    `<div class="ms-section ms-section-ctx" data-testid="context-window-section"><div><b>${escapeHtml(t('ctx_section'))}</b>` +
    `<span class="ms-section-desc">${escapeHtml(t('ctx_section_desc'))}</span></div></div>` +
    `<div class="ms-ctx">${renderContextWindowRows(ctx)}</div>`
  );
}

function renderContextWindowPopHtml(ctx) {
  const { t, escapeHtml, state } = ctx;
  const pick = ensureModelsUi(state).contextPicker;
  if (!pick) return '';
  const source = sourcesOf(state).find((item) => item.id === pick.sourceId);
  const current = resolveContextWindow({
    model: pick.model,
    source,
    overrides: state.contextWindowOverrides,
  });
  const options = contextWindowPresetOptions(current);
  const parts = options.map((option) => (
    `<button type="button" class="ms-opt mono${option.selected ? ' on' : ''}" data-action="ms-set-context-window" data-source-id="${escapeHtml(pick.sourceId)}" data-model="${escapeHtml(pick.model)}" data-tokens="${option.tokens}" data-testid="context-window-option">` +
    `${escapeHtml(option.label)}${option.selected ? `<span class="x">${escapeHtml(t('src_selected_mark'))}</span>` : ''}` +
    `</button>`
  ));
  parts.push(
    `<hr><button type="button" class="ms-opt sec" data-action="ms-reset-context-window" data-source-id="${escapeHtml(pick.sourceId)}" data-model="${escapeHtml(pick.model)}" data-testid="context-window-reset">${escapeHtml(t('ctx_restore'))}</button>`
  );
  return parts.join('');
}

export function renderContextWindowPop(ctx) {
  const ui = ensureModelsUi(ctx.state);
  if (!ui.contextPicker) return '';
  return `<div class="model-pop open" id="context-window-pop" data-testid="context-window-pop" role="listbox">${renderContextWindowPopHtml(ctx)}</div>`;
}

function positionContextWindowPop(state) {
  const ui = ensureModelsUi(state);
  const pick = ui.contextPicker;
  if (!pick) return;
  const pop = document.getElementById('context-window-pop');
  const btn = document.querySelector(`[data-action="ms-toggle-context-window"][data-source-id="${CSS.escape(pick.sourceId)}"][data-model="${CSS.escape(pick.model)}"]`);
  if (!pop || !btn) return;
  pop.classList.add('open');
  const rect = btn.getBoundingClientRect();
  const modal = document.querySelector('.sm')?.getBoundingClientRect();
  const limitBottom = (modal?.bottom ?? window.innerHeight) - 8;
  const limitTop = (modal?.top ?? 0) + 8;
  const limitLeft = (modal?.left ?? 0) + 8;
  const limitRight = (modal?.right ?? window.innerWidth) - 8;
  const width = Math.min(240, Math.max(160, limitRight - limitLeft));
  pop.style.width = `${width}px`;
  let left = rect.right - width;
  left = Math.max(limitLeft, Math.min(left, limitRight - width));
  pop.style.left = `${left}px`;
  pop.style.maxHeight = '';
  let height = pop.offsetHeight;
  let top = rect.bottom + 4;
  if (top + height > limitBottom) top = rect.top - 4 - height;
  if (top < limitTop) {
    const available = Math.max(160, limitBottom - limitTop);
    pop.style.maxHeight = `${available}px`;
    height = pop.offsetHeight;
    top = Math.max(limitTop, Math.min(rect.bottom + 4, limitBottom - height));
  }
  pop.style.top = `${top}px`;
}

function renderCheckboxes(names, checked, escapeHtml) {
  return names.map((name) => (
    `<label class="ms-chk"><input type="checkbox" data-action="ms-toggle-model" data-model="${escapeHtml(name)}"${checked[name] ? ' checked' : ''}><span class="mono">${escapeHtml(name)}</span></label>`
  )).join('');
}

function renderKeyDrawer(ctx) {
  const { t, escapeHtml, state } = ctx;
  const ui = ensureModelsUi(state);
  const editing = Boolean(ui.editId);
  const vendorId = ui.form.vendor;
  const custom = vendorId === 'custom';
  const hideKey = !formNeedsKey(state, ui);
  const chips = vendorsOf(state).map((vendor) => (
    `<button type="button" class="ms-vendor${vendor.id === vendorId ? ' on' : ''}" data-action="ms-pick-vendor" data-vendor="${escapeHtml(vendor.id)}">${escapeHtml(t(`vendor_${vendor.id}`) === `vendor_${vendor.id}` ? vendor.name : t(`vendor_${vendor.id}`))}</button>`
  )).join('');
  const warn = hostWarnActive(state, ui) ? t('src_host_key_warn') : (ui.form.warn || '');
  const test = ui.form.test;
  const result = test
    ? (test.ok
      ? `<div class="ms-result" data-testid="model-test-result"><div class="ms-ok"><span class="ms-mark ok" aria-hidden="true">✓</span>${escapeHtml(t('src_test_found', { n: ui.form.models.length }))}</div>` +
        `<div class="ms-checks">${renderCheckboxes(ui.form.models, ui.form.checked, escapeHtml)}</div>` +
        `<div class="ms-manual"><input class="ms-in mono" id="ms-manual" data-testid="model-manual" placeholder="${escapeHtml(t('src_manual_model'))}" value="${escapeHtml(ui.form.manual || '')}" autocomplete="off"><button type="button" class="btn btn-sm" data-action="ms-add-manual">${escapeHtml(t('src_add_model'))}</button></div></div>`
      : `<div class="ms-result" data-testid="model-test-result"><div class="ms-ok"><span class="ms-mark bad" aria-hidden="true">✗</span>${escapeHtml(probeResultText(test, t))}</div>` +
        (ui.form.models.length ? `<div class="ms-checks">${renderCheckboxes(ui.form.models, ui.form.checked, escapeHtml)}</div>` : '') +
        `<div class="ms-manual"><input class="ms-in mono" id="ms-manual" data-testid="model-manual" placeholder="${escapeHtml(t('src_manual_model'))}" value="${escapeHtml(ui.form.manual || '')}" autocomplete="off"><button type="button" class="btn btn-sm" data-action="ms-add-manual">${escapeHtml(t('src_add_model'))}</button></div></div>`)
    : (editing && ui.form.models.length
      ? `<div class="ms-result"><div class="ms-ok">${escapeHtml(t('src_enabled_models'))}</div><div class="ms-checks">${renderCheckboxes(ui.form.models, ui.form.checked, escapeHtml)}</div>` +
        `<div class="ms-manual"><input class="ms-in mono" id="ms-manual" data-testid="model-manual" placeholder="${escapeHtml(t('src_manual_model'))}" value="${escapeHtml(ui.form.manual || '')}" autocomplete="off"><button type="button" class="btn btn-sm" data-action="ms-add-manual">${escapeHtml(t('src_add_model'))}</button></div></div>`
      : '');
  const title = editing
    ? t('src_edit_named', { name: ui.form.name || vendorById(state, vendorId)?.name || '' })
    : t('src_add_api');
  return (
    `<div class="ms-drawer-pane" data-testid="model-drawer" data-drawer="key">` +
    `<div class="ms-dr-head">${editing ? '' : `<button type="button" class="btn g btn-sm" data-action="ms-back" aria-label="${escapeHtml(t('src_back'))}">‹</button>`}<b>${escapeHtml(title)}</b><button type="button" class="btn g btn-sm" data-action="ms-close-drawer" aria-label="${escapeHtml(t('btn_cancel'))}">✕</button></div>` +
    `<div class="ms-dr-body">` +
    `<div class="ms-field"><label>${escapeHtml(t('src_vendor'))}</label><div class="ms-vendors">${chips}</div></div>` +
    `<div class="ms-field"><label>${escapeHtml(t('src_base_url'))}</label><input class="ms-in mono" id="ms-url" data-testid="model-url" value="${escapeHtml(ui.form.baseUrl || '')}"${custom ? '' : ' readonly'} placeholder="${escapeHtml(t('src_url_placeholder'))}" autocomplete="off"><div class="ms-hint">${escapeHtml(custom ? t('src_url_custom_hint') : t('src_url_preset_hint'))}</div></div>` +
    (hideKey ? '' : `<div class="ms-field" id="ms-key-field"><label>${escapeHtml(t('src_api_key'))}</label><div class="ms-keywrap"><input class="ms-in mono" id="ms-key" data-testid="model-key" type="${ui.form.showKey ? 'text' : 'password'}" value="${escapeHtml(ui.form.apiKey || '')}" autocomplete="off"><button type="button" class="btn g btn-sm ms-eye" id="ms-key-eye" data-action="ms-toggle-key">${escapeHtml(t(ui.form.showKey ? 'src_hide' : 'src_show'))}</button></div><div class="ms-hint">${escapeHtml(editing ? t('src_key_keep_hint') : t('src_key_hint'))}</div></div>`) +
    `<div class="ms-field"><label>${escapeHtml(t('src_name'))}</label><input class="ms-in" id="ms-name" data-testid="model-name" value="${escapeHtml(ui.form.name || '')}" autocomplete="off"><div class="ms-hint">${escapeHtml(t('src_name_hint'))}</div></div>` +
    (warn ? `<div class="ms-warn" id="ms-host-warn" data-testid="model-host-warn">${escapeHtml(warn)}</div>` : `<div class="ms-warn" id="ms-host-warn" data-testid="model-host-warn" hidden></div>`) +
    `<div class="ms-test-row"><button type="button" class="btn" data-action="ms-test-form" data-testid="model-test"${ui.form.testing ? ' disabled aria-busy="true"' : ''}>${ui.form.testing ? '<span class="ms-spin" aria-hidden="true"></span>' : ''}${escapeHtml(ui.form.testing ? t('src_testing') : t('src_test_models'))}</button></div>` +
    result +
    `</div>` +
    `<div class="ms-dr-foot">` +
    (editing ? `<button type="button" class="btn g ms-danger" data-action="ms-delete-form">${escapeHtml(t('src_delete_this'))}</button>` : '') +
    `<button type="button" class="btn g" data-action="ms-close-drawer">${escapeHtml(t('btn_cancel'))}</button>` +
    `<button type="button" class="btn p" data-action="ms-save-form" data-testid="model-save-source"${ui.form.busy ? ' disabled' : ''}>${escapeHtml(editing ? t('btn_save') : t('src_add_btn'))}</button>` +
    `</div></div>`
  );
}

function renderGrokDrawer(ctx) {
  const { t, escapeHtml, state } = ctx;
  const pending = state.grokPending || state.settings?.grok?.pending;
  const url = safeHttps(pending?.verificationUri);
  const code = pending?.userCode || '';
  const errKey = state.grokError;
  const err = errKey ? t(errKey) : '';
  return (
    `<div class="ms-drawer-pane" data-testid="model-drawer" data-drawer="grok">` +
    `<div class="ms-dr-head"><button type="button" class="btn g btn-sm" data-action="ms-back" aria-label="${escapeHtml(t('src_back'))}">‹</button><b>${escapeHtml(t('src_grok_login_title'))}</b><button type="button" class="btn g btn-sm" data-action="ms-close-drawer" aria-label="${escapeHtml(t('btn_cancel'))}">✕</button></div>` +
    `<div class="ms-dr-body">` +
    `<p class="ms-lead">${escapeHtml(t('src_grok_login_lead'))}</p>` +
    (pending ? (
      `<div class="ms-step"><div class="ms-no">1</div><div class="ms-step-body">${escapeHtml(t('src_grok_step_url'))}` +
      `<div class="ms-url-row"><input class="ms-in mono" readonly value="${escapeHtml(url)}" data-testid="grok-url"><button type="button" class="btn btn-sm" data-action="ms-open-grok-url" data-testid="grok-open"${url ? '' : ' disabled'}>${escapeHtml(t('src_open'))}</button></div></div></div>` +
      `<div class="ms-step"><div class="ms-no">2</div><div class="ms-step-body">${escapeHtml(t('src_grok_step_code'))}` +
      `<div class="ms-code-row"><span class="ms-code mono" data-testid="grok-user-code">${escapeHtml(code)}</span><button type="button" class="btn btn-sm" data-action="ms-copy-code" data-testid="grok-copy">${escapeHtml(t('src_copy'))}</button></div>` +
      `<div class="ms-hint" id="ms-grok-expire">${escapeHtml(remainText(pending.expiresAt, t))}</div></div></div>` +
      `<div class="ms-waiting" data-testid="grok-device"><span class="ms-spin"></span>${escapeHtml(t('grok_waiting'))}</div>`
    ) : `<p class="ms-hint">${escapeHtml(t('src_grok_starting'))}</p>`) +
    (err ? `<div class="ms-warn" data-testid="grok-error">${escapeHtml(err)}</div>` : '') +
    `</div>` +
    `<div class="ms-dr-foot"><button type="button" class="btn" data-action="grok-cancel">${escapeHtml(t('grok_cancel'))}</button></div>` +
    `</div>`
  );
}

function renderGrokEdit(ctx) {
  const { t, escapeHtml, state } = ctx;
  const ui = ensureModelsUi(state);
  const source = sourcesOf(state).find((item) => item.id === 'grok') || {};
  const signed = Boolean(source.session?.signedIn || grokSignedIn(state));
  const email = source.session?.email || state.settings?.grok?.email || '';
  const exp = formatStamp(source.session?.expiresAt || state.settings?.grok?.expiresAt);
  const names = ui.form.models.length ? ui.form.models : (source.models || []);
  return (
    `<div class="ms-drawer-pane" data-testid="model-drawer" data-drawer="grok-edit">` +
    `<div class="ms-dr-head"><b>${escapeHtml(t('src_edit_named', { name: 'Grok Build' }))}</b><button type="button" class="btn g btn-sm" data-action="ms-close-drawer" aria-label="${escapeHtml(t('btn_cancel'))}">✕</button></div>` +
    `<div class="ms-dr-body">` +
    `<div class="ms-field"><label>${escapeHtml(t('src_name'))}</label><input class="ms-in" id="ms-grok-name" data-testid="model-grok-name" value="${escapeHtml(ui.grokName || '')}" autocomplete="off"></div>` +
    `<div class="ms-field"><label>${escapeHtml(t('src_account'))}</label>` +
    `<div class="ms-result"><div class="ms-ok"><span class="ms-dot ${signed ? 'ok' : 'bad'}"></span>${escapeHtml(signed ? (email || t('grok_signed_in')) : t('src_why_unsigned'))}</div>` +
    (signed && exp ? `<div class="ms-hint">${escapeHtml(t('src_token_renews', { time: exp }))} · ${escapeHtml(t('src_grok_file'))}</div>` : '') +
    `<div class="ms-inline-acts"><button type="button" class="btn btn-sm" data-action="ms-grok-relogin">${escapeHtml(t('src_relogin'))}</button>` +
    (signed ? `<button type="button" class="btn btn-sm" data-action="grok-logout" data-testid="grok-logout">${escapeHtml(t('grok_logout'))}</button>` : '') +
    `</div></div></div>` +
    `<div class="ms-field"><label>${escapeHtml(t('src_available_models'))} <button type="button" class="btn g btn-sm" data-action="ms-refresh-grok-form">${escapeHtml(t('src_refresh'))}</button></label>` +
    `<div class="ms-checks">${renderCheckboxes(names, ui.grokChecked, escapeHtml)}</div>` +
    `<div class="ms-hint">${escapeHtml(t('src_check_hint'))}</div></div>` +
    `</div>` +
    `<div class="ms-dr-foot"><button type="button" class="btn g ms-danger" data-action="ms-delete-form">${escapeHtml(t('src_delete_this'))}</button><button type="button" class="btn g" data-action="ms-close-drawer">${escapeHtml(t('btn_cancel'))}</button><button type="button" class="btn p" data-action="ms-save-grok">${escapeHtml(t('btn_save'))}</button></div>` +
    `</div>`
  );
}

function renderPickDrawer(ctx) {
  const { t, escapeHtml, state } = ctx;
  const grokCount = sourcesOf(state).some((source) => source.kind === 'grok') || grokSignedIn(state) ? 1 : 0;
  const cards = ACCOUNTS.map((item) => {
    const badge = item.id === 'grok' && grokCount
      ? `<span class="ms-done">${escapeHtml(t('src_signed_in_n', { n: grokCount }))}</span>`
      : (!item.enabled ? `<span class="ms-done">${escapeHtml(t('src_coming_soon'))}</span>` : '');
    return (
      `<button type="button" class="ms-card${item.enabled ? '' : ' dis'}"${item.enabled ? ' data-action="ms-pick-account"' : ' disabled'} data-account="${escapeHtml(item.id)}">` +
      `<span class="ms-ic">${escapeHtml(item.mark)}</span>` +
      `<span class="ms-card-copy"><b>${escapeHtml(t(item.title))}</b><span>${escapeHtml(t(item.desc))}</span></span>` +
      badge +
      `</button>`
    );
  }).join('');
  return (
    `<div class="ms-drawer-pane" data-testid="model-drawer" data-drawer="pick">` +
    `<div class="ms-dr-head"><b>${escapeHtml(t('src_add_title'))}</b><button type="button" class="btn g btn-sm" data-action="ms-close-drawer" aria-label="${escapeHtml(t('btn_cancel'))}">✕</button></div>` +
    `<div class="ms-dr-body">` +
    `<div class="ms-kind">${escapeHtml(t('src_group_account'))}</div>` +
    cards +
    `<div class="ms-kind">${escapeHtml(t('src_group_api'))}</div>` +
    `<button type="button" class="ms-card" data-action="ms-pick-api"><span class="ms-ic">K</span><span class="ms-card-copy"><b>${escapeHtml(t('src_add_api'))}</b><span>${escapeHtml(t('src_add_api_desc'))}</span></span></button>` +
    `<div class="ms-kind">${escapeHtml(t('src_group_local'))}</div>` +
    `<button type="button" class="ms-card" data-action="ms-pick-ollama"><span class="ms-ic">L</span><span class="ms-card-copy"><b>${escapeHtml(t('src_add_ollama'))}</b><span>${escapeHtml(t('src_add_ollama_desc'))}</span></span></button>` +
    `</div></div>`
  );
}

function renderDrawer(ctx) {
  const ui = ensureModelsUi(ctx.state);
  if (!ui.drawer) return '';
  let pane = '';
  if (ui.drawer === 'pick') pane = renderPickDrawer(ctx);
  else if (ui.drawer === 'grok') pane = renderGrokDrawer(ctx);
  else if (ui.drawer === 'grok-edit') pane = renderGrokEdit(ctx);
  else if (ui.drawer === 'key') pane = renderKeyDrawer(ctx);
  if (!pane) return '';
  return `<div class="ms-drawer-scrim" data-action="ms-close-drawer"></div><div class="ms-drawer">${pane}</div>`;
}

function renderSaveBar(ctx) {
  const { t, escapeHtml, state } = ctx;
  const ui = ensureModelsUi(state);
  const change = defaultChange(state);
  let msg = t('src_no_changes');
  if (change) {
    const model = change.next?.model || t('src_auto');
    msg = t('src_dirty_one', { detail: model });
  }
  return (
    `<div class="ms-savebar${change ? ' dirty' : ''}" data-testid="model-savebar">` +
    `<span class="ms-save-msg" data-testid="model-dirty">${escapeHtml(msg)}</span>` +
    `<button type="button" class="btn g" data-action="ms-discard-default" data-testid="model-discard"${change ? '' : ' disabled'}>${escapeHtml(t('src_discard'))}</button>` +
    `<button type="button" class="btn p" data-action="ms-save-default" data-testid="model-save"${change && !ui.savingDefault ? '' : ' disabled'}>${escapeHtml(ui.savingDefault ? t('src_saving') : t('btn_save'))}</button>` +
    `</div>`
  );
}

export function renderModelsPane(ctx) {
  const { t, escapeHtml, state } = ctx;
  const ui = ensureDefaultBinding(state);
  const sources = sourcesOf(state);
  const rows = sources.length
    ? sources.map((source) => renderSourceRow(source, ctx)).join('')
    : `<div class="ms-empty">${escapeHtml(t('src_empty'))}</div>`;
  return (
    `<div class="sm-models${ui.drawer ? ' show' : ''}" data-testid="models-page">` +
    `<button type="button" class="sm-x ms-x" data-action="close-settings" aria-label="${escapeHtml(t('btn_cancel'))}">×</button>` +
    `<div class="ms-head"><div><h2>${escapeHtml(t('settings_tab_models'))}</h2><p>${escapeHtml(t('src_page_desc'))}</p></div></div>` +
    `<div class="ms-scroll" id="ms-scroll">` +
    `<div class="ms-section"><div><b>${escapeHtml(t('src_sources'))}</b><span>${escapeHtml(t('src_count'))}</span></div>` +
    `<button type="button" class="btn btn-sm" data-action="ms-open-add" data-testid="model-add">${escapeHtml(t('src_add'))}</button></div>` +
    `<div class="ms-src" data-testid="model-source-list">${rows}</div>` +
    renderContextWindowsSection(ctx) +
    `<div class="ms-section ms-section-roles"><div><b>${escapeHtml(t('src_default_title'))}</b><span>${escapeHtml(t('src_default_hint'))}</span></div></div>` +
    `<div class="ms-roles">${renderDefaultRow(ctx)}</div>` +
    `</div>` +
    renderSaveBar(ctx) +
    renderDrawer(ctx) +
    `</div>`
  );
}

function knownError(err, t) {
  const code = String(err?.body?.error || err?.message || '');
  const key = {
    'api key required': 'src_err_key',
    'base url required': 'src_err_url',
    'unknown vendor': 'src_err_vendor',
    'unknown source': 'src_err_source',
    'model not in source': 'src_err_model',
    'not found': 'src_err_missing',
    'invalid models': 'src_err_models',
  }[code];
  return key ? t(key) : (code || t('err_save'));
}

function readFormFields(ui) {
  const name = document.getElementById('ms-name');
  const url = document.getElementById('ms-url');
  const key = document.getElementById('ms-key');
  const manual = document.getElementById('ms-manual');
  const grokName = document.getElementById('ms-grok-name');
  if (name) ui.form.name = name.value;
  if (url) ui.form.baseUrl = url.value;
  if (key) ui.form.apiKey = key.value;
  if (manual) ui.form.manual = manual.value;
  if (grokName) ui.grokName = grokName.value;
}

function setWarn(text) {
  const el = document.getElementById('ms-host-warn');
  if (!el) return;
  if (text) {
    el.hidden = false;
    el.textContent = text;
  } else {
    el.hidden = true;
    el.textContent = '';
  }
}

export function onModelsField(el, ctx) {
  const ui = ensureModelsUi(ctx.state);
  if (el.id === 'ms-search') {
    ui.pickerQuery = el.value;
    const pop = document.getElementById('model-pop');
    if (pop && ui.pickerOpen) {
      const start = el.selectionStart;
      pop.innerHTML = renderPop(ctx);
      const next = document.getElementById('ms-search');
      next?.focus();
      if (start != null) next.setSelectionRange(start, start);
      positionModelPop();
    }
    return;
  }
  readFormFields(ui);
  if (el.id === 'ms-name') ui.form.nameTouched = true;
  if (el.id === 'ms-url' || el.id === 'ms-key') {
    ui.form.warn = '';
    setWarn(hostWarnActive(ctx.state, ui) ? ctx.t('src_host_key_warn') : '');
  }
}

function toggleChecked(map, name, on) {
  map[name] = on;
}

export function onModelsToggle(el, ctx) {
  const ui = ensureModelsUi(ctx.state);
  const name = el.getAttribute('data-model') || '';
  if (!name) return;
  if (ui.drawer === 'grok-edit') toggleChecked(ui.grokChecked, name, el.checked);
  else toggleChecked(ui.form.checked, name, el.checked);
}

function openDrawer(ctx, which) {
  const ui = ensureModelsUi(ctx.state);
  closeModelPop(ctx.state);
  ui.drawer = which;
  ctx.render();
}

async function removeSource(ctx, id) {
  const source = sourcesOf(ctx.state).find((item) => item.id === id);
  const ok = await ctx.confirm({
    message: ctx.t('src_confirm_delete', { name: source?.name || id }),
    danger: true,
    confirmLabel: ctx.t('btn_delete'),
  });
  if (!ok) return;
  await ctx.api(`/api/sources/${encodeURIComponent(id)}`, 'DELETE');
  await reloadSettings(ctx);
  const ui = ensureModelsUi(ctx.state);
  ui.drawer = null;
  ui.editId = null;
  ctx.showToast('src_deleted');
  ctx.render();
  ctx.renderChrome();
}

function validateForm(ctx) {
  const ui = ensureModelsUi(ctx.state);
  readFormFields(ui);
  const { t } = ctx;
  if (hostWarnActive(ctx.state, ui)) {
    ui.form.warn = t('src_host_key_warn');
    return false;
  }
  const url = String(ui.form.baseUrl || '').trim();
  if (!httpOrigin(url)) {
    ui.form.warn = t('src_err_url');
    return false;
  }
  if (!ui.editId && formNeedsKey(ctx.state, ui) && isMaskedOrEmptyKey(ui.form.apiKey, ui.form.maskedKey)) {
    ui.form.warn = t('src_err_key');
    return false;
  }
  ui.form.warn = '';
  return true;
}

function sourcePayload(ctx, { includeKey }) {
  const ui = ensureModelsUi(ctx.state);
  const body = {
    vendor: ui.form.vendor,
    name: ui.form.name.trim(),
    baseUrl: ui.form.baseUrl.trim(),
    models: checkedModels(ui.form),
  };
  if (includeKey) {
    const masked = ui.editId ? (sourcesOf(ctx.state).find((item) => item.id === ui.editId)?.apiKey || '') : '';
    if (!isMaskedOrEmptyKey(ui.form.apiKey, masked)) body.apiKey = ui.form.apiKey.trim();
    else if (!ui.editId) body.apiKey = ui.form.apiKey.trim();
  }
  return body;
}

async function saveForm(ctx) {
  const ui = ensureModelsUi(ctx.state);
  if (!validateForm(ctx)) {
    ctx.render();
    return;
  }
  const probed = ui.form.test != null;
  ui.form.busy = true;
  ctx.render();
  try {
    let savedId = ui.editId;
    if (ui.editId) {
      await ctx.api(`/api/sources/${encodeURIComponent(ui.editId)}`, 'PUT', sourcePayload(ctx, { includeKey: true }));
    } else {
      const created = await ctx.api('/api/sources', 'POST', sourcePayload(ctx, { includeKey: true }));
      savedId = created?.id || '';
    }
    if (probed && savedId) {
      try {
        await ctx.api('/api/sources/test', 'POST', { sourceId: savedId });
      } catch { /* the source is saved; the row shows the last stored probe */ }
    }
    await reloadSettings(ctx);
    ui.drawer = null;
    ui.editId = null;
    ui.form.busy = false;
    ctx.showToast('msg_settings_saved');
    ctx.render();
    ctx.renderChrome();
  } catch (err) {
    ui.form.busy = false;
    ui.form.warn = knownError(err, ctx.t);
    ctx.render();
  }
}

async function testForm(ctx) {
  const ui = ensureModelsUi(ctx.state);
  if (!validateForm(ctx)) {
    ctx.render();
    return;
  }
  ui.form.testing = true;
  ui.form.test = null;
  ctx.render();
  try {
    const payload = sourcePayload(ctx, { includeKey: true });
    const body = ui.editId
      ? { sourceId: ui.editId, vendor: payload.vendor, baseUrl: payload.baseUrl, ...(payload.apiKey ? { apiKey: payload.apiKey } : {}) }
      : { vendor: payload.vendor, baseUrl: payload.baseUrl, apiKey: payload.apiKey || '' };
    const result = await ctx.api('/api/sources/test', 'POST', body);
    ui.form.testing = false;
    if (result?.ok) {
      const found = Array.isArray(result.models) ? result.models : [];
      const previous = new Set(ui.form.models);
      ui.form.models = [...found];
      const checked = {};
      for (const name of found) checked[name] = previous.size ? Boolean(ui.form.checked[name] || !previous.has(name)) : true;
      for (const name of Object.keys(ui.form.checked)) {
        if (ui.form.checked[name] && !checked[name] && !found.includes(name)) {
          ui.form.models.push(name);
          checked[name] = true;
        }
      }
      ui.form.checked = checked;
      ui.form.test = { ok: true };
    } else {
      ui.form.test = {
        ok: false,
        error: typeof result?.error === 'string' ? result.error : '',
        code: typeof result?.code === 'string' ? result.code : '',
        ...(Number.isInteger(result?.status) ? { status: result.status } : {}),
      };
    }
    ctx.render();
  } catch (err) {
    ui.form.testing = false;
    if (String(err?.body?.error || err?.message) === 'api key required') {
      ui.form.warn = ctx.t('src_host_key_warn');
      ctx.render();
      return;
    }
    ui.form.test = { ok: false, text: knownError(err, ctx.t) };
    ctx.render();
  }
}

async function testSourceRow(ctx, id) {
  if (!id) return;
  const ui = ensureModelsUi(ctx.state);
  ui.rowProbes = ui.rowProbes || {};
  if (ui.rowProbes[id]?.phase === 'testing') return;
  ui.rowProbes[id] = { phase: 'testing' };
  ctx.render();
  try {
    const result = await ctx.api('/api/sources/test', 'POST', { sourceId: id });
    await reloadSettings(ctx);
    if (result?.ok) {
      ui.rowProbes[id] = { phase: 'done', ok: true };
    } else {
      ui.rowProbes[id] = {
        phase: 'done',
        ok: false,
        error: typeof result?.error === 'string' ? result.error : '',
        code: typeof result?.code === 'string' ? result.code : '',
        ...(Number.isInteger(result?.status) ? { status: result.status } : {}),
      };
    }
  } catch (err) {
    ui.rowProbes[id] = { phase: 'done', ok: false, text: knownError(err, ctx.t) };
  }
  ctx.render();
}

async function saveDefault(ctx) {
  const ui = ensureModelsUi(ctx.state);
  const change = defaultChange(ctx.state);
  if (!change) return;
  ui.savingDefault = true;
  ctx.render();
  try {
    ctx.state.settings = await ctx.api('/api/settings', 'PUT', { models: { default: change.next } });
    noteSettingsReloaded(ctx.state);
    revertDefaultBinding(ctx.state);
    ui.savingDefault = false;
    ctx.showToast('msg_settings_saved');
    ctx.render();
    ctx.renderChrome();
  } catch (err) {
    ui.savingDefault = false;
    ctx.showToast(knownError(err, ctx.t));
    ctx.render();
  }
}

function chooseModel(ctx, sourceId, model) {
  const source = sourcesOf(ctx.state).find((item) => item.id === sourceId);
  if (!source || sourceBlockReason(source, { grokSignedIn: grokSignedIn(ctx.state) })) return;
  writeBinding(ctx.state, { sourceId, model });
  closeModelPop(ctx.state);
  ctx.render();
}

export async function handleModelsAction(action, el, ctx) {
  const ui = ensureModelsUi(ctx.state);
  const sourceId = el?.getAttribute?.('data-source-id') || '';
  if (action === 'toggle-model-pick') {
    closeContextWindowPop(ctx.state);
    if (ui.pickerOpen) closeModelPop(ctx.state);
    else {
      ui.pickerOpen = true;
      ui.pickerQuery = '';
      ctx.render();
    }
    return true;
  }
  if (action === 'ms-toggle-context-window') {
    const model = el.getAttribute('data-model') || '';
    closeModelPop(ctx.state);
    if (ui.contextPicker?.sourceId === sourceId && ui.contextPicker?.model === model) closeContextWindowPop(ctx.state);
    else {
      ui.contextPicker = { sourceId, model };
      ctx.render();
    }
    return true;
  }
  if (action === 'ms-set-context-window') {
    const model = el.getAttribute('data-model') || '';
    const tokens = Number(el.getAttribute('data-tokens'));
    closeContextWindowPop(ctx.state);
    if (ctx.setContextWindow) await ctx.setContextWindow(sourceId, model, tokens);
    return true;
  }
  if (action === 'ms-reset-context-window') {
    const model = el.getAttribute('data-model') || '';
    closeContextWindowPop(ctx.state);
    if (ctx.setContextWindow) await ctx.setContextWindow(sourceId, model, null);
    return true;
  }
  if (action === 'ms-open-add' || action === 'ms-pop-add') {
    ui.drawer = 'pick';
    ui.editId = null;
    closeModelPop(ctx.state);
    ctx.render();
    return true;
  }
  if (action === 'ms-close-drawer') {
    ui.drawer = null;
    ctx.render();
    return true;
  }
  if (action === 'ms-back') {
    ui.drawer = 'pick';
    ctx.render();
    return true;
  }
  if (action === 'ms-pick-account') {
    ui.drawer = 'grok';
    ctx.render();
    if (!ctx.state.grokPending && !ctx.state.settings?.grok?.pending) ctx.startGrokSignIn();
    return true;
  }
  if (action === 'ms-pick-api') {
    prepareAddForm(ctx.state, ui, 'deepseek');
    openDrawer(ctx, 'key');
    return true;
  }
  if (action === 'ms-pick-ollama') {
    prepareAddForm(ctx.state, ui, 'ollama');
    openDrawer(ctx, 'key');
    return true;
  }
  if (action === 'ms-pick-vendor') {
    readFormFields(ui);
    const next = el.getAttribute('data-vendor') || 'custom';
    const keepUrl = next === 'custom';
    applyVendorDefaults(ctx.state, ui, next, { keepUrl });
    if (next !== 'custom') ui.form.baseUrl = vendorById(ctx.state, next)?.baseUrl || '';
    ctx.render();
    return true;
  }
  if (action === 'ms-edit-source') {
    closeModelPop(ctx.state);
    const source = sourcesOf(ctx.state).find((item) => item.id === sourceId);
    if (!source) return true;
    if (source.kind === 'grok') {
      prepareGrokEdit(ui, source);
      openDrawer(ctx, 'grok-edit');
    } else {
      prepareEditForm(ctx.state, ui, source);
      openDrawer(ctx, 'key');
    }
    return true;
  }
  if (action === 'ms-delete-source' || action === 'ms-delete-form') {
    const id = sourceId || ui.editId;
    if (id) {
      try { await removeSource(ctx, id); } catch (err) { ctx.showToast(knownError(err, ctx.t)); }
    }
    return true;
  }
  if (action === 'ms-test-source') {
    await testSourceRow(ctx, sourceId);
    return true;
  }
  if (action === 'ms-test-form') {
    await testForm(ctx);
    return true;
  }
  if (action === 'ms-save-form') {
    await saveForm(ctx);
    return true;
  }
  if (action === 'ms-toggle-key') {
    ui.form.showKey = !ui.form.showKey;
    const input = document.getElementById('ms-key');
    const eye = document.getElementById('ms-key-eye');
    if (input) input.type = ui.form.showKey ? 'text' : 'password';
    if (eye) eye.textContent = ctx.t(ui.form.showKey ? 'src_hide' : 'src_show');
    return true;
  }
  if (action === 'ms-add-manual') {
    readFormFields(ui);
    const name = String(ui.form.manual || '').trim();
    if (name && !ui.form.models.includes(name)) ui.form.models.push(name);
    if (name) ui.form.checked[name] = true;
    ui.form.manual = '';
    if (!ui.form.test) ui.form.test = { ok: true };
    ctx.render();
    return true;
  }
  if (action === 'ms-save-grok') {
    readFormFields(ui);
    const names = (ui.form.models.length ? ui.form.models : (sourcesOf(ctx.state).find((item) => item.id === 'grok')?.models || []))
      .filter((name) => ui.grokChecked[name]);
    try {
      await ctx.api('/api/sources/grok', 'PUT', { name: ui.grokName.trim(), models: names });
      await reloadSettings(ctx);
      ui.drawer = null;
      ctx.showToast('msg_settings_saved');
      ctx.render();
      ctx.renderChrome();
    } catch (err) {
      ctx.showToast(knownError(err, ctx.t));
    }
    return true;
  }
  if (action === 'ms-refresh-grok-form') {
    try {
      const result = await ctx.api('/api/sources/test', 'POST', { sourceId: 'grok' });
      await reloadSettings(ctx);
      if (Array.isArray(result?.models) && result.models.length) {
        ui.form.models = result.models;
        for (const name of result.models) if (ui.grokChecked[name] == null) ui.grokChecked[name] = true;
      }
      ctx.render();
    } catch (err) {
      ctx.showToast(knownError(err, ctx.t));
    }
    return true;
  }
  if (action === 'ms-grok-relogin') {
    ui.drawer = 'grok';
    ctx.render();
    ctx.startGrokSignIn();
    return true;
  }
  if (action === 'ms-open-grok-url') {
    const pending = ctx.state.grokPending || ctx.state.settings?.grok?.pending;
    const url = safeHttps(pending?.verificationUri);
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
    return true;
  }
  if (action === 'ms-copy-code') {
    const code = ctx.state.grokPending?.userCode || ctx.state.settings?.grok?.pending?.userCode || '';
    if (!code) return true;
    try {
      await navigator.clipboard.writeText(code);
      ctx.showToast('src_copied');
    } catch {
      ctx.showToast('src_copy_failed');
    }
    return true;
  }
  if (action === 'ms-choose-model') {
    chooseModel(ctx, el.getAttribute('data-source-id') || '', el.getAttribute('data-model') || '');
    return true;
  }
  if (action === 'ms-discard-default') {
    revertDefaultBinding(ctx.state);
    closeModelPop(ctx.state);
    ctx.render();
    return true;
  }
  if (action === 'ms-save-default') {
    await saveDefault(ctx);
    return true;
  }
  return false;
}
