// Settings → Agent. Sub-agent models, tools, skills, and prompts live here.
// The default model binding is edited on the Models page and on the main agent.

import { roleTitle } from './workflow-settings.js';
import {
  AGENT_DRAFT_ROLE,
  ensureRoleBindings,
  revertRoleBinding,
  sameModelBinding,
  renderModelPickButton,
  syncModelPop,
  closeModelPop,
  noteSettingsReloaded,
} from './model-settings.js';

const TOOL_ORDER = ['read', 'write', 'edit', 'ls', 'grep', 'bash'];
const PRESET_ORDER = ['planner', 'coder', 'tester', 'auditor'];
const READ_TOOLS = ['read', 'ls', 'grep'];
const GROUPS = [
  { id: 'read', tools: ['read', 'ls', 'grep'] },
  { id: 'write', tools: ['write', 'edit'] },
  { id: 'bash', tools: ['bash'] },
  { id: 'plugins', plugin: true },
];
const SKILL_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

function defaultUi() {
  return {
    query: '',
    selectedId: '',
    returnId: '',
    creating: false,
    starter: 'blank',
    draft: null,
    baseline: null,
    expanded: {},
    skillsOpen: false,
    skillsQuery: '',
    saving: false,
    error: '',
    editScroll: 0,
    listScroll: 0,
  };
}

export function ensureAgentsUi(state) {
  if (!state.agentsUi) state.agentsUi = defaultUi();
  return state.agentsUi;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function initial(text) {
  const value = String(text || '').trim();
  if (!value) return '＋';
  return [...value][0];
}

function rolesOf(state) {
  return (state.roles || []).filter((role) => role && role.id);
}

function roleById(state, id) {
  return rolesOf(state).find((role) => role.id === id) || null;
}

function isMain(role) {
  return role?.id === 'default';
}

function isPreset(role) {
  return Boolean(role?.builtin) && !isMain(role);
}

function enabledSkills(state) {
  return (state.skills || []).filter((skill) => skill && skill.id && skill.enabled === true);
}

function pluginToolNames(state) {
  const names = [];
  for (const plugin of state.plugins || []) {
    if (!plugin || plugin.enabled === false) continue;
    for (const tool of plugin.tools || []) {
      const name = typeof tool?.name === 'string' ? tool.name.trim() : '';
      if (name && !names.includes(name)) names.push(name);
    }
  }
  return names;
}

function normalizeTools(list) {
  const set = new Set(Array.isArray(list) ? list : []);
  return TOOL_ORDER.filter((id) => set.has(id));
}

function blankDraft() {
  return {
    name: '',
    description: '',
    systemPrompt: '',
    tools: READ_TOOLS.slice(),
    pluginTools: false,
    skillsInherit: false,
    skills: [],
    modelBinding: null,
  };
}

function draftFromRole(role, binding, ctx) {
  const inherit = !Array.isArray(role?.skills);
  return {
    name: roleTitle(role, ctx),
    description: typeof role?.description === 'string' ? role.description : '',
    systemPrompt: role?.systemPrompt || '',
    tools: normalizeTools(role?.tools),
    pluginTools: role?.pluginTools !== false,
    skillsInherit: inherit,
    skills: inherit ? [] : role.skills.filter((id) => typeof id === 'string'),
    modelBinding: binding && binding.sourceId && binding.model ? { sourceId: binding.sourceId, model: binding.model } : null,
  };
}

function savedBinding(state, roleId) {
  return ensureRoleBindings(state).roleSaved?.[roleId] || null;
}

function liveBinding(state, roleId) {
  const ui = ensureAgentsUi(state);
  if (ui.creating) return ui.draft?.modelBinding || null;
  return ensureRoleBindings(state).roleDraft?.[roleId] || null;
}

export function captureAgentDraft(ctx) {
  const ui = ctx.state.agentsUi;
  if (!ui?.draft) return;
  const edit = document.getElementById('ag-edit');
  const key = edit?.getAttribute('data-edit-key') || '';
  if (!edit || key !== editKey(ui)) return;
  const name = document.getElementById('ag-name');
  if (!name) return;
  ui.draft.name = name.value;
  const desc = document.getElementById('ag-desc');
  if (desc) ui.draft.description = desc.value;
  const prompt = document.getElementById('ag-prompt');
  if (prompt) ui.draft.systemPrompt = prompt.value;
  ui.editScroll = edit.scrollTop;
  const items = document.getElementById('ag-items');
  if (items) ui.listScroll = items.scrollTop;
  const search = document.getElementById('ag-search');
  if (search) ui.query = search.value;
  const skillSearch = document.getElementById('ag-skill-search');
  if (skillSearch) ui.skillsQuery = skillSearch.value;
}

function editKey(ui) {
  const rev = ui.editRev || 0;
  return ui.creating ? `new:${ui.starter || 'blank'}:${rev}` : `${ui.selectedId || ''}:${rev}`;
}

function bumpEdit(ui) {
  ui.editRev = (ui.editRev || 0) + 1;
}

function toolsKey(list) {
  return normalizeTools(list).join('\0');
}

function skillsKey(draft) {
  if (!draft) return '';
  if (draft.skillsInherit) return '*';
  return [...(draft.skills || [])].sort().join('\0');
}

function dirtyFields(ctx) {
  const ui = ensureAgentsUi(ctx.state);
  const draft = ui.draft;
  const base = ui.baseline;
  if (!draft || !base) return [];
  const fields = [];
  if (draft.name.trim() !== String(base.name || '').trim()) fields.push('name');
  const currentModel = ui.creating ? (draft.modelBinding || null) : liveBinding(ctx.state, ui.selectedId);
  const baseModel = ui.creating ? (base.modelBinding || null) : savedBinding(ctx.state, ui.selectedId);
  if (!sameModelBinding(currentModel, baseModel)) fields.push('model');
  const showWhen = ui.creating || ui.selectedId !== 'default';
  if (showWhen && String(draft.description || '') !== String(base.description || '')) fields.push('when');
  if (toolsKey(draft.tools) !== toolsKey(base.tools) || draft.pluginTools !== base.pluginTools) fields.push('tools');
  if (skillsKey(draft) !== skillsKey(base)) fields.push('skills');
  if (String(draft.systemPrompt || '') !== String(base.systemPrompt || '')) fields.push('prompt');
  return fields;
}

function isDirty(ctx) {
  return dirtyFields(ctx).length > 0;
}

function displayName(ctx) {
  const ui = ensureAgentsUi(ctx.state);
  const typed = String(ui.draft?.name || '').trim();
  if (typed) return typed;
  if (ui.creating) return ctx.t('ag_new_title');
  return ctx.t('ag_unnamed');
}

function fieldLabel(ctx, field) {
  return ctx.t(`ag_field_${field}`);
}

function saveMessage(ctx) {
  const ui = ensureAgentsUi(ctx.state);
  if (ui.error) return ui.error;
  if (ui.creating && !isDirty(ctx)) return ctx.t('ag_save_new');
  const fields = dirtyFields(ctx);
  if (!fields.length) return ctx.t('ag_save_clean');
  const name = ui.creating ? ctx.t('ag_new_title') : displayName(ctx);
  const detail = fields.map((field) => fieldLabel(ctx, field)).join(ctx.t('ag_field_sep'));
  const key = fields.length === 1 ? 'ag_save_dirty_one' : 'ag_save_dirty';
  return ctx.t(key, { n: fields.length, name, fields: detail });
}

function canSave(ctx) {
  const ui = ensureAgentsUi(ctx.state);
  if (!ui.draft || ui.saving) return false;
  if (!ui.draft.name.trim() || !ui.draft.systemPrompt.trim()) return false;
  if (String(ui.draft.description || '').length > 500) return false;
  if (ui.creating) return true;
  return isDirty(ctx);
}

function promptMeta(ctx) {
  const ui = ensureAgentsUi(ctx.state);
  const text = ui.draft?.systemPrompt || '';
  const count = ctx.t('ag_prompt_count', { n: [...text].length });
  const role = ui.creating ? null : roleById(ctx.state, ui.selectedId);
  const changed = role?.builtin && typeof role.defaultPrompt === 'string' && text !== role.defaultPrompt;
  return changed ? `${count} · ${ctx.t('ag_prompt_changed')}` : count;
}

function applyChrome(ctx) {
  const msg = document.getElementById('ag-save-msg');
  if (msg) msg.textContent = saveMessage(ctx);
  const meta = document.getElementById('ag-prompt-meta');
  if (meta) meta.textContent = promptMeta(ctx);
  const save = document.getElementById('ag-save');
  if (save) save.disabled = !canSave(ctx);
  const discard = document.getElementById('ag-discard');
  const ui = ensureAgentsUi(ctx.state);
  if (discard) discard.disabled = ui.creating ? false : !isDirty(ctx);
}

export function onAgentField(el, ctx) {
  const ui = ensureAgentsUi(ctx.state);
  if (!ui.draft) return;
  if (el.id === 'ag-name') ui.draft.name = el.value;
  if (el.id === 'ag-desc') ui.draft.description = el.value;
  if (el.id === 'ag-prompt') ui.draft.systemPrompt = el.value;
  if (el.id === 'ag-skill-search') {
    ui.skillsQuery = el.value;
    const list = document.getElementById('ag-skill-list');
    if (list) list.innerHTML = skillRows(ctx);
    return;
  }
  ui.error = '';
  applyChrome(ctx);
}

function groupState(draft, group) {
  if (group.plugin) return draft.pluginTools === false ? 'off' : 'on';
  const on = group.tools.filter((tool) => draft.tools.includes(tool)).length;
  if (on === 0) return 'off';
  if (on === group.tools.length) return 'on';
  return 'partial';
}

function setGroup(draft, group, on) {
  if (group.plugin) {
    draft.pluginTools = on;
    return;
  }
  const rest = draft.tools.filter((tool) => !group.tools.includes(tool));
  draft.tools = normalizeTools(on ? rest.concat(group.tools) : rest);
}

function selectedSkillIds(draft, enabled) {
  const ids = enabled.map((skill) => skill.id);
  if (draft.skillsInherit) return ids;
  const allow = new Set(ids);
  return (draft.skills || []).filter((id) => allow.has(id));
}

function subAgents(state) {
  return rolesOf(state).filter((role) => role.id !== 'default');
}

function orderedPresets(state) {
  const presets = subAgents(state).filter((role) => role.builtin);
  const rank = new Map(PRESET_ORDER.map((id, index) => [id, index]));
  return presets.sort((a, b) => (rank.get(a.id) ?? 99) - (rank.get(b.id) ?? 99) || a.id.localeCompare(b.id));
}

function orderedCustom(ctx) {
  return subAgents(ctx.state)
    .filter((role) => !role.builtin)
    .sort((a, b) => roleTitle(a, ctx).localeCompare(roleTitle(b, ctx), undefined, { numeric: true, sensitivity: 'base' }));
}

function matches(query, role, ctx) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return true;
  const title = roleTitle(role, ctx).toLowerCase();
  const desc = String(role.description || '').toLowerCase();
  const name = String(role.name || '').toLowerCase();
  return title.includes(q) || desc.includes(q) || name.includes(q);
}

function itemHtml(ctx, role) {
  const ui = ensureAgentsUi(ctx.state);
  const title = roleTitle(role, ctx);
  const on = !ui.creating && ui.selectedId === role.id;
  const blurb = String(role.description || '').replace(/\s+/g, ' ').trim();
  return (
    `<div class="ag-item${on ? ' on' : ''}" data-action="ag-select" data-role-id="${ctx.escapeHtml(role.id)}" data-testid="agent-item" role="button" tabindex="0">` +
    `<div class="ag-av">${ctx.escapeHtml(initial(title))}</div>` +
    `<div class="ag-item-copy"><b>${ctx.escapeHtml(title)}</b><span>${ctx.escapeHtml(blurb)}</span></div>` +
    `</div>`
  );
}

function groupHtml(ctx, label, roles) {
  if (!roles.length) return '';
  return `<div class="ag-grp">${ctx.escapeHtml(label)}</div>` + roles.map((role) => itemHtml(ctx, role)).join('');
}

function renderItems(ctx) {
  const ui = ensureAgentsUi(ctx.state);
  const query = ui.query || '';
  const main = rolesOf(ctx.state).filter((role) => isMain(role) && matches(query, role, ctx));
  const presets = orderedPresets(ctx.state).filter((role) => matches(query, role, ctx));
  const custom = orderedCustom(ctx).filter((role) => matches(query, role, ctx));
  const html = groupHtml(ctx, ctx.t('ag_group_main'), main)
    + groupHtml(ctx, ctx.t('ag_group_preset'), presets)
    + groupHtml(ctx, ctx.t('ag_group_custom'), custom);
  if (html) return html;
  return `<div class="ag-empty">${ctx.escapeHtml(ctx.t('ag_empty_search'))}</div>`;
}

export function filterAgents(query, ctx) {
  const ui = ensureAgentsUi(ctx.state);
  ui.query = query;
  const box = document.getElementById('ag-items');
  if (box) box.innerHTML = renderItems(ctx);
}

function skillRows(ctx) {
  const ui = ensureAgentsUi(ctx.state);
  const q = String(ui.skillsQuery || '').trim().toLowerCase();
  const enabled = enabledSkills(ctx.state);
  const picked = new Set(selectedSkillIds(ui.draft, enabled));
  const rows = enabled.filter((skill) => {
    if (!q) return true;
    const name = `${skill.name || ''} ${skill.id || ''} ${skill.description || ''}`.toLowerCase();
    return name.includes(q);
  });
  if (!rows.length) return `<div class="ag-sk-empty">${ctx.escapeHtml(ctx.t('ag_empty_search'))}</div>`;
  return rows.map((skill) => (
    `<label class="ag-sk-row"><input type="checkbox" data-testid="agent-skill-check" data-skill-id="${ctx.escapeHtml(skill.id)}"${picked.has(skill.id) ? ' checked' : ''}>` +
    `<span><b>${ctx.escapeHtml(skill.name || skill.id)}</b><span>${ctx.escapeHtml(skill.description || '')}</span></span></label>`
  )).join('');
}

function positionFloat(pop, anchor) {
  if (!pop || !anchor) return;
  const rect = anchor.getBoundingClientRect();
  const modal = document.querySelector('.sm')?.getBoundingClientRect();
  const limitBottom = (modal?.bottom ?? window.innerHeight) - 8;
  const limitTop = (modal?.top ?? 0) + 8;
  const limitLeft = (modal?.left ?? 0) + 8;
  const limitRight = (modal?.right ?? window.innerWidth) - 8;
  const width = Math.min(pop.dataset.floatWidth ? Number(pop.dataset.floatWidth) : pop.offsetWidth, Math.max(220, limitRight - limitLeft));
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

export function mountAgentsPane(state) {
  const ui = state.agentsUi;
  if (!ui) return;
  const edit = document.getElementById('ag-edit');
  if (edit) edit.scrollTop = ui.editScroll || 0;
  const items = document.getElementById('ag-items');
  if (items) items.scrollTop = ui.listScroll || 0;
  syncModelPop(state);
  const skills = document.getElementById('ag-skpop');
  const anchor = document.getElementById('ag-skills-open');
  if (skills && anchor && ui.skillsOpen) positionFloat(skills, anchor);
  const scroller = document.getElementById('ag-edit');
  if (scroller) {
    const start = scroller.scrollTop;
    let armed = false;
    const arm = setTimeout(() => { armed = true; }, 0);
    const onScroll = () => {
      if (!armed || Math.abs(scroller.scrollTop - start) < 2) return;
      clearTimeout(arm);
      scroller.removeEventListener('scroll', onScroll);
      closeModelPop(state);
      if (ui.skillsOpen) {
        ui.skillsOpen = false;
        document.getElementById('ag-skpop')?.classList.remove('open');
      }
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
  }
}

function toolPicks(ctx, group) {
  const ui = ensureAgentsUi(ctx.state);
  if (!ui.expanded?.[group.id] || group.plugin) return '';
  const boxes = group.tools.map((tool) => (
    `<label class="ag-tool-pick"><input type="checkbox" data-testid="agent-tool-check" data-tool="${ctx.escapeHtml(tool)}"${ui.draft.tools.includes(tool) ? ' checked' : ''}><span class="mono">${ctx.escapeHtml(tool)}</span></label>`
  )).join('');
  return `<div class="ag-tool-picks">${boxes}</div>`;
}

function toolBlock(ctx) {
  const ui = ensureAgentsUi(ctx.state);
  const draft = ui.draft;
  const names = pluginToolNames(ctx.state);
  let on = 0;
  const rows = GROUPS.map((group) => {
    const state = groupState(draft, group);
    if (state !== 'off') on += 1;
    const title = ctx.t(`ag_tool_${group.id}`);
    const detail = group.plugin
      ? `${ctx.escapeHtml(ctx.t('ag_tool_plugins_desc'))}${names.length ? ` · <span class="mono">${ctx.escapeHtml(names.join(' '))}</span>` : ''}`
      : `${ctx.escapeHtml(ctx.t(`ag_tool_${group.id}_desc`))} · <span class="mono">${ctx.escapeHtml(group.tools.join(' '))}</span>`;
    const partial = state === 'partial' ? `<span class="ag-partial">${ctx.escapeHtml(ctx.t('ag_tool_partial'))}</span>` : '';
    return (
      `<div class="ag-tool" data-testid="agent-tool" data-group="${ctx.escapeHtml(group.id)}" data-state="${state}">` +
      `<div><button type="button" class="ag-tool-name" data-action="ag-expand-group" data-group="${ctx.escapeHtml(group.id)}"><b>${ctx.escapeHtml(title)}</b></button>` +
      `<div class="ag-tool-d">${detail}</div>` +
      toolPicks(ctx, group) +
      `</div>` +
      `<button type="button" class="ag-sw-hit" data-action="ag-toggle-group" data-group="${ctx.escapeHtml(group.id)}" data-testid="${group.plugin ? 'agent-plugin-tools' : `agent-tool-${group.id}`}" aria-pressed="${state === 'on' ? 'true' : 'false'}">` +
      `${partial}<span class="ag-sw ${state}"></span></button>` +
      `</div>`
    );
  }).join('');
  const hintKey = ui.creating ? 'ag_tools_hint_new' : (isPreset(roleById(ctx.state, ui.selectedId)) ? 'ag_tools_hint_preset' : 'ag_tools_hint');
  return (
    `<div class="ag-sect"><div class="ag-lab">${ctx.escapeHtml(ctx.t('ag_tools'))}<span class="ag-lab-r">${ctx.escapeHtml(ctx.t('ag_tools_on', { on, total: GROUPS.length }))}</span></div>` +
    `<div class="ag-tools">${rows}</div>` +
    `<div class="ag-hint">${ctx.escapeHtml(ctx.t(hintKey))}</div></div>`
  );
}

function skillsSummary(ctx) {
  const ui = ensureAgentsUi(ctx.state);
  const enabled = enabledSkills(ctx.state);
  const picked = selectedSkillIds(ui.draft, enabled);
  const byId = new Map(enabled.map((skill) => [skill.id, skill.name || skill.id]));
  if (!picked.length) {
    return `<span class="ag-muted">${ctx.escapeHtml(ctx.t('ag_skills_none'))}</span>`;
  }
  const shown = picked.slice(0, 3).map((id) => `<span class="ag-sk">${ctx.escapeHtml(byId.get(id) || id)}</span>`).join('');
  const more = picked.length > 3 ? `<span class="ag-muted">${ctx.escapeHtml(ctx.t('ag_skills_more', { n: picked.length - 3 }))}</span>` : '';
  return shown + more;
}

function skillsBlock(ctx) {
  const ui = ensureAgentsUi(ctx.state);
  const enabled = enabledSkills(ctx.state);
  const picked = selectedSkillIds(ui.draft, enabled);
  const follow = ui.draft.skillsInherit ? `<span class="ag-follow">${ctx.escapeHtml(ctx.t('ag_skills_follow'))}</span>` : '';
  const scope = ui.creating || ui.selectedId !== 'default' ? 'ag_skills_scope' : 'ag_skills_main';
  return (
    `<div class="ag-sect"><div class="ag-lab">${ctx.escapeHtml(ctx.t('ag_skills'))}<span class="ag-lab-r">${ctx.escapeHtml(ctx.t(scope))}</span></div>` +
    `<div class="ag-skbox">` +
    `<div class="ag-sksum">${skillsSummary(ctx)}</div>` +
    `<span class="ag-skcount">${ctx.escapeHtml(ctx.t('ag_skills_count', { on: picked.length, total: enabled.length }))}</span>` +
    follow +
    `<button type="button" class="btn btn-sm" id="ag-skills-open" data-action="ag-skills-open" data-testid="agent-skills-open">${ctx.escapeHtml(ctx.t('ag_skills_pick'))}</button>` +
    `</div></div>`
  );
}

export function renderAgentSkillsPop(ctx) {
  const ui = ensureAgentsUi(ctx.state);
  if (!ui.skillsOpen || !ui.draft) return '';
  const total = enabledSkills(ctx.state).length;
  return (
    `<div class="ag-skpop open" id="ag-skpop" data-testid="agent-skills-pop" data-float-width="380">` +
    `<div class="ag-sktop"><input class="ag-in" id="ag-skill-search" data-testid="agent-skills-search" placeholder="${ctx.escapeHtml(ctx.t('ag_skills_search'))}" value="${ctx.escapeHtml(ui.skillsQuery || '')}" autocomplete="off">` +
    `<button type="button" class="btn g btn-sm" data-action="ag-skills-all">${ctx.escapeHtml(ctx.t('ag_skills_all'))}</button>` +
    `<button type="button" class="btn g btn-sm" data-action="ag-skills-none">${ctx.escapeHtml(ctx.t('ag_skills_clear'))}</button></div>` +
    `<div class="ag-sklst" id="ag-skill-list">${skillRows(ctx)}</div>` +
    `<div class="ag-skbot"><span>${ctx.escapeHtml(ctx.t('ag_skills_foot', { n: total }))}</span><button type="button" class="btn p btn-sm" data-action="ag-skills-done">${ctx.escapeHtml(ctx.t('ag_skills_done'))}</button></div>` +
    `</div>`
  );
}

function starters(ctx) {
  const ui = ensureAgentsUi(ctx.state);
  const chips = [`<button type="button" class="ag-chip${ui.starter === 'blank' ? ' on' : ''}" data-action="ag-starter" data-starter="blank" data-testid="agent-starter-blank">${ctx.escapeHtml(ctx.t('ag_starter_blank'))}</button>`];
  const roles = orderedPresets(ctx.state).concat(orderedCustom(ctx));
  for (const role of roles) {
    const on = ui.starter === role.id;
    chips.push(
      `<button type="button" class="ag-chip${on ? ' on' : ''}" data-action="ag-starter" data-starter="${ctx.escapeHtml(role.id)}" data-testid="agent-starter">${ctx.escapeHtml(ctx.t('ag_starter_copy', { name: roleTitle(role, ctx) }))}</button>`
    );
  }
  return (
    `<div class="ag-sect"><label>${ctx.escapeHtml(ctx.t('ag_starter'))}</label><div class="ag-chips">${chips.join('')}</div></div>`
  );
}

function editorHtml(ctx) {
  const ui = ensureAgentsUi(ctx.state);
  const role = ui.creating ? null : roleById(ctx.state, ui.selectedId);
  if (!ui.creating && !role) {
    ui.draft = null;
    ensureSelection(ctx);
    return editorHtml(ctx);
  }
  const draft = ui.draft;
  const title = displayName(ctx);
  const preset = isPreset(role);
  const main = isMain(role);
  let note = ctx.t('ag_custom_note');
  if (ui.creating) note = ctx.t('ag_new_note');
  else if (main) note = ctx.t('ag_main_note');
  else if (preset) note = ctx.t('ag_preset_note');
  const tag = preset ? `<span class="ag-tag" data-testid="agent-preset-tag">${ctx.escapeHtml(ctx.t('ag_preset_tag'))}</span>` : '';
  const copy = ui.creating ? '' : `<button type="button" class="btn g btn-sm" data-action="ag-copy" data-testid="agent-copy">${ctx.escapeHtml(ctx.t('ag_copy'))}</button>`;
  const reset = !ui.creating && role?.builtin
    ? `<button type="button" class="btn g btn-sm" data-action="ag-reset" data-testid="agent-reset">${ctx.escapeHtml(ctx.t('ag_reset'))}</button>`
    : '';
  const pickId = ui.creating ? AGENT_DRAFT_ROLE : role.id;
  const when = main ? '' : (
    `<div class="ag-sect"><label for="ag-desc">${ctx.escapeHtml(ctx.t('ag_when'))}</label>` +
    `<textarea id="ag-desc" data-testid="agent-description" placeholder="${ctx.escapeHtml(ctx.t('ag_when_ph'))}">${ctx.escapeHtml(draft.description || '')}</textarea>` +
    `<div class="ag-hint">${ctx.escapeHtml(ctx.t('ag_when_hint'))}</div></div>`
  );
  const headTitle = ui.creating ? ctx.t('ag_new_title') : title;
  return (
    `<div class="ag-edit" id="ag-edit" data-edit-key="${ctx.escapeHtml(editKey(ui))}">` +
    `<div class="ag-ehead">` +
    `<div class="ag-av ag-av-lg">${ctx.escapeHtml(ui.creating && !draft.name.trim() ? '＋' : initial(headTitle))}</div>` +
    `<div class="ag-tt"><div class="ag-titleline"><b>${ctx.escapeHtml(headTitle)}</b>${tag}</div><div>${ctx.escapeHtml(note)}</div></div>` +
    copy + reset +
    `</div>` +
    (ui.creating ? starters(ctx) : '') +
    `<div class="ag-row2 ag-sect">` +
    `<div><label for="ag-name">${ctx.escapeHtml(ctx.t('ag_name'))}</label><input class="ag-in" id="ag-name" data-testid="agent-name" value="${ctx.escapeHtml(draft.name || '')}" placeholder="${ctx.escapeHtml(ctx.t('ag_name_ph'))}" autocomplete="off"></div>` +
    `<div><label>${ctx.escapeHtml(ctx.t('ag_model'))}</label>${renderModelPickButton(ctx, pickId, { testId: 'agent-model-pick' })}</div>` +
    `</div>` +
    when +
    toolBlock(ctx) +
    skillsBlock(ctx) +
    `<div class="ag-sect"><div class="ag-lab"><label for="ag-prompt">${ctx.escapeHtml(ctx.t('ag_prompt'))}</label><span class="ag-lab-r" id="ag-prompt-meta">${ctx.escapeHtml(promptMeta(ctx))}</span></div>` +
    `<textarea id="ag-prompt" class="ag-prompt" data-testid="agent-prompt" placeholder="${ctx.escapeHtml(ctx.t('ag_prompt_ph'))}">${ctx.escapeHtml(draft.systemPrompt || '')}</textarea></div>` +
    `</div>`
  );
}

function ensureSelection(ctx) {
  const ui = ensureAgentsUi(ctx.state);
  ensureRoleBindings(ctx.state);
  if (ui.draft) return;
  const coder = roleById(ctx.state, 'coder');
  const main = roleById(ctx.state, 'default');
  const first = coder || main || rolesOf(ctx.state)[0];
  if (!first) {
    ui.creating = true;
    ui.starter = 'blank';
    ui.draft = blankDraft();
    ui.baseline = clone(ui.draft);
    return;
  }
  selectExisting(ctx, first.id);
}

function selectExisting(ctx, id) {
  const ui = ensureAgentsUi(ctx.state);
  const role = roleById(ctx.state, id);
  if (!role) return;
  revertRoleBinding(ctx.state, id);
  ui.creating = false;
  ui.starter = '';
  ui.selectedId = id;
  ui.returnId = id;
  ui.expanded = {};
  ui.skillsOpen = false;
  ui.skillsQuery = '';
  ui.error = '';
  ui.baseline = draftFromRole(role, savedBinding(ctx.state, id), ctx);
  ui.draft = clone(ui.baseline);
  ui.editScroll = 0;
  bumpEdit(ui);
}

function beginCreate(ctx, starterId) {
  const ui = ensureAgentsUi(ctx.state);
  ui.creating = true;
  ui.selectedId = '';
  ui.expanded = {};
  ui.skillsOpen = false;
  ui.skillsQuery = '';
  ui.error = '';
  ui.editScroll = 0;
  if (!starterId || starterId === 'blank') {
    ui.starter = 'blank';
    ui.draft = blankDraft();
  } else {
    const role = roleById(ctx.state, starterId);
    ui.starter = role ? role.id : 'blank';
    if (!role) ui.draft = blankDraft();
    else ui.draft = draftFromRole(role, savedBinding(ctx.state, role.id) || ensureRoleBindings(ctx.state).roleDraft?.[role.id] || null, ctx);
  }
  ui.baseline = clone(ui.draft);
  bumpEdit(ui);
}

function headerDelete(ctx) {
  const ui = ensureAgentsUi(ctx.state);
  const role = ui.creating ? null : roleById(ctx.state, ui.selectedId);
  if (!role || role.builtin) return '';
  return `<button type="button" class="btn g btn-sm ag-del" data-action="ag-delete" data-testid="agent-delete">${ctx.escapeHtml(ctx.t('ag_delete'))}</button>`;
}

export function renderAgentsPane(ctx) {
  ensureSelection(ctx);
  const ui = ensureAgentsUi(ctx.state);
  const dirty = isDirty(ctx);
  const { t, escapeHtml } = ctx;
  return (
    `<div class="sm-agents" data-testid="agents-page">` +
    `<button type="button" class="sm-x ag-x" data-action="close-settings" aria-label="${escapeHtml(t('btn_cancel'))}">×</button>` +
    `<div class="ag-head"><h2>${escapeHtml(t('settings_tab_agents'))}</h2><p>${escapeHtml(t('ag_page_desc'))}</p></div>` +
    `<div class="ag-split">` +
    `<div class="ag-list">` +
    `<div class="ag-search"><input class="ag-in" id="ag-search" data-testid="agent-search" placeholder="${escapeHtml(t('ag_search'))}" value="${escapeHtml(ui.query || '')}" autocomplete="off"></div>` +
    `<div class="ag-items" id="ag-items">${renderItems(ctx)}</div>` +
    `<div class="ag-foot"><button type="button" class="btn" data-action="ag-new" data-testid="agent-new">${escapeHtml(t('ag_new'))}</button></div>` +
    `</div>` +
    editorHtml(ctx) +
    `</div>` +
    `<div class="ag-savebar${dirty ? ' dirty' : ''}" data-testid="agent-savebar">` +
    `<span class="ag-save-msg" id="ag-save-msg" data-testid="agent-dirty">${escapeHtml(saveMessage(ctx))}</span>` +
    headerDelete(ctx) +
    `<button type="button" class="btn g" id="ag-discard" data-action="ag-discard" data-testid="agent-discard"${ui.creating || dirty ? '' : ' disabled'}>${escapeHtml(t('src_discard'))}</button>` +
    `<button type="button" class="btn p" id="ag-save" data-action="ag-save" data-testid="agent-save"${canSave(ctx) ? '' : ' disabled'}>${escapeHtml(ui.saving ? t('src_saving') : t('btn_save'))}</button>` +
    `</div>` +
    `</div>`
  );
}

async function guardSwitch(ctx) {
  if (!isDirty(ctx)) return true;
  return ctx.confirm({
    message: ctx.t('ag_discard_switch'),
    confirmLabel: ctx.t('src_discard'),
  });
}

function abandon(ctx) {
  const ui = ensureAgentsUi(ctx.state);
  if (!ui.creating && ui.selectedId) revertRoleBinding(ctx.state, ui.selectedId);
  ui.creating = false;
}

function nameToSave(ctx) {
  const ui = ensureAgentsUi(ctx.state);
  const typed = ui.draft.name.trim();
  if (!ui.creating && ui.selectedId) {
    const role = roleById(ctx.state, ui.selectedId);
    if (role && typed === String(ui.baseline?.name || '').trim()) return role.name;
  }
  return typed;
}

function rolePayload(ctx) {
  const ui = ensureAgentsUi(ctx.state);
  const draft = ui.draft;
  const role = ui.creating ? null : roleById(ctx.state, ui.selectedId);
  const description = role && isMain(role) ? (role.description || '') : String(draft.description || '').slice(0, 500);
  const payload = {
    name: nameToSave(ctx),
    systemPrompt: String(draft.systemPrompt || '').trim(),
    tools: normalizeTools(draft.tools),
    description,
    pluginTools: draft.pluginTools !== false,
  };
  if (!draft.skillsInherit) {
    payload.skills = [...new Set((draft.skills || []).filter((id) => SKILL_ID.test(id)))];
  }
  return payload;
}

function currentModelBinding(ctx) {
  const ui = ensureAgentsUi(ctx.state);
  if (ui.creating) return ui.draft?.modelBinding || null;
  return liveBinding(ctx.state, ui.selectedId);
}

function baselineModelBinding(ctx) {
  const ui = ensureAgentsUi(ctx.state);
  if (ui.creating) return ui.baseline?.modelBinding || null;
  return savedBinding(ctx.state, ui.selectedId);
}

async function reloadCatalog(ctx) {
  const [roles, settings] = await Promise.all([
    ctx.api('/api/roles'),
    ctx.api('/api/settings'),
  ]);
  ctx.state.roles = roles;
  ctx.state.settings = settings;
  noteSettingsReloaded(ctx.state);
  try { ctx.state.pipelines = await ctx.api('/api/pipelines'); } catch { /* keep */ }
  try { ctx.state.skills = await ctx.api('/api/skills'); } catch { /* keep */ }
  try { ctx.state.plugins = await ctx.api('/api/plugins'); } catch { /* keep */ }
}

function knownRoleError(err, ctx) {
  const body = err?.body || {};
  if (Array.isArray(body.errors) && body.errors.length) {
    const text = body.errors.join(' ');
    if (text.includes('systemPrompt')) return ctx.t('ag_err_prompt');
    if (text.includes('name')) return ctx.t('ag_err_name');
    if (text.includes('description')) return ctx.t('ag_err_description');
    return text;
  }
  return body.error || err?.message || ctx.t('ag_err_save');
}

function deleteError(err, ctx) {
  const body = err?.body || {};
  if (body.error === 'protected') return ctx.t('ag_err_protected');
  if (body.error === 'role_in_conversations') return ctx.t('ag_err_in_conversations');
  if (body.error === 'role_in_use') {
    const names = (body.pipelines || []).map((id) => {
      const pipe = (ctx.state.pipelines || []).find((item) => item.id === id);
      return pipe?.name || id;
    });
    return ctx.t('ag_err_in_use', { names: names.join(ctx.t('ag_field_sep')) });
  }
  return ctx.t('ag_err_delete');
}

async function saveAgent(ctx) {
  const ui = ensureAgentsUi(ctx.state);
  captureAgentDraft(ctx);
  ui.error = '';
  if (!ui.draft.name.trim()) {
    ui.error = ctx.t('ag_err_name');
    ctx.render();
    return;
  }
  if (!ui.draft.systemPrompt.trim()) {
    ui.error = ctx.t('ag_err_prompt');
    ctx.render();
    return;
  }
  if (String(ui.draft.description || '').length > 500) {
    ui.error = ctx.t('ag_err_description');
    ctx.render();
    return;
  }
  if (!ui.creating && !isDirty(ctx)) return;
  const binding = currentModelBinding(ctx);
  const modelChanged = ui.creating
    ? Boolean(binding)
    : !sameModelBinding(binding, baselineModelBinding(ctx));
  ui.saving = true;
  ctx.render();
  try {
    let id = ui.selectedId;
    if (ui.creating) {
      const created = await ctx.api('/api/roles', 'POST', rolePayload(ctx));
      id = created?.id || '';
    } else {
      await ctx.api(`/api/roles/${encodeURIComponent(id)}`, 'PUT', rolePayload(ctx));
    }
    if (id && modelChanged) {
      ctx.state.settings = await ctx.api('/api/settings', 'PUT', { models: { [id]: binding || null } });
      noteSettingsReloaded(ctx.state);
      revertRoleBinding(ctx.state, id);
    }
    await reloadCatalog(ctx);
    if (id) revertRoleBinding(ctx.state, id);
    ui.saving = false;
    ui.creating = false;
    selectExisting(ctx, id);
    ctx.showToast('ag_saved');
    ctx.render();
  } catch (err) {
    ui.saving = false;
    ui.error = knownRoleError(err, ctx);
    ctx.showToast(ui.error);
    ctx.render();
  }
}

async function resetAgent(ctx) {
  const ui = ensureAgentsUi(ctx.state);
  const role = roleById(ctx.state, ui.selectedId);
  if (!role?.builtin) return;
  const ok = await ctx.confirm({
    message: ctx.t('ag_confirm_reset', { name: roleTitle(role, ctx) }),
    confirmLabel: ctx.t('ag_reset'),
  });
  if (!ok) return;
  try {
    await ctx.api(`/api/roles/${encodeURIComponent(role.id)}/reset`, 'POST');
    await reloadCatalog(ctx);
    selectExisting(ctx, role.id);
    ctx.showToast('ag_reset_done');
    ctx.render();
  } catch (err) {
    ctx.showToast(knownRoleError(err, ctx) || ctx.t('ag_err_reset'));
  }
}

async function deleteAgent(ctx) {
  const ui = ensureAgentsUi(ctx.state);
  const role = roleById(ctx.state, ui.selectedId);
  if (!role || role.builtin) return;
  const ok = await ctx.confirm({
    message: ctx.t('ag_confirm_delete', { name: roleTitle(role, ctx) }),
    danger: true,
    confirmLabel: ctx.t('btn_delete'),
  });
  if (!ok) return;
  try {
    await ctx.api(`/api/roles/${encodeURIComponent(role.id)}`, 'DELETE');
    await reloadCatalog(ctx);
    ctx.showToast('ag_deleted');
    ui.draft = null;
    ui.selectedId = '';
    ensureSelection(ctx);
    ctx.render();
  } catch (err) {
    ctx.showToast(deleteError(err, ctx));
  }
}

function toggleGroup(ctx, groupId) {
  const ui = ensureAgentsUi(ctx.state);
  const group = GROUPS.find((item) => item.id === groupId);
  if (!group || !ui.draft) return;
  const state = groupState(ui.draft, group);
  if (state === 'partial') {
    ui.expanded[groupId] = !ui.expanded[groupId];
    ctx.render();
    return;
  }
  setGroup(ui.draft, group, state !== 'on');
  ui.expanded[groupId] = false;
  ctx.render();
}

function toggleTool(ctx, tool, on) {
  const ui = ensureAgentsUi(ctx.state);
  if (!ui.draft || !TOOL_ORDER.includes(tool)) return;
  const set = new Set(ui.draft.tools);
  if (on) set.add(tool);
  else set.delete(tool);
  ui.draft.tools = normalizeTools([...set]);
  ctx.render();
}

function toggleSkill(ctx, id, on) {
  const ui = ensureAgentsUi(ctx.state);
  if (!ui.draft || !SKILL_ID.test(id)) return;
  const enabled = enabledSkills(ctx.state).map((skill) => skill.id);
  let next = new Set(selectedSkillIds(ui.draft, enabledSkills(ctx.state)));
  if (on) next.add(id);
  else next.delete(id);
  next = new Set([...next].filter((skillId) => enabled.includes(skillId)));
  const allOn = enabled.length > 0 && enabled.every((skillId) => next.has(skillId));
  if (allOn) {
    ui.draft.skillsInherit = true;
    ui.draft.skills = [];
  } else {
    ui.draft.skillsInherit = false;
    ui.draft.skills = enabled.filter((skillId) => next.has(skillId));
  }
  ctx.render();
}

export function onAgentToolChange(el, ctx) {
  toggleTool(ctx, el.getAttribute('data-tool') || '', el.checked);
}

export function onAgentSkillChange(el, ctx) {
  toggleSkill(ctx, el.getAttribute('data-skill-id') || '', el.checked);
}

export async function handleAgentAction(action, el, ctx) {
  const ui = ensureAgentsUi(ctx.state);
  captureAgentDraft(ctx);
  if (action === 'ag-select') {
    const id = el.getAttribute('data-role-id') || '';
    if (!ui.creating && id === ui.selectedId) return true;
    if (!(await guardSwitch(ctx))) return true;
    abandon(ctx);
    selectExisting(ctx, id);
    ctx.render();
    return true;
  }
  if (action === 'ag-new') {
    if (!(await guardSwitch(ctx))) return true;
    abandon(ctx);
    if (ui.selectedId) ui.returnId = ui.selectedId;
    beginCreate(ctx, 'blank');
    ctx.render();
    return true;
  }
  if (action === 'ag-starter') {
    beginCreate(ctx, el.getAttribute('data-starter') || 'blank');
    ctx.render();
    return true;
  }
  if (action === 'ag-copy') {
    const role = roleById(ctx.state, ui.selectedId);
    if (!role || !ui.draft) return true;
    const copied = clone(ui.draft);
    copied.modelBinding = liveBinding(ctx.state, role.id);
    if (!(await guardSwitch(ctx))) return true;
    abandon(ctx);
    ui.returnId = role.id;
    ui.creating = true;
    ui.selectedId = '';
    ui.starter = role.id;
    ui.expanded = {};
    ui.skillsOpen = false;
    ui.skillsQuery = '';
    ui.error = '';
    ui.draft = copied;
    ui.baseline = clone(copied);
    ui.editScroll = 0;
    bumpEdit(ui);
    ctx.render();
    return true;
  }
  if (action === 'ag-reset') {
    await resetAgent(ctx);
    return true;
  }
  if (action === 'ag-delete') {
    await deleteAgent(ctx);
    return true;
  }
  if (action === 'ag-discard') {
    if (ui.creating) {
      const back = ui.returnId || 'coder';
      ui.creating = false;
      ui.draft = null;
      if (roleById(ctx.state, back)) selectExisting(ctx, back);
      else ensureSelection(ctx);
      ctx.render();
      return true;
    }
    if (ui.selectedId) {
      revertRoleBinding(ctx.state, ui.selectedId);
      selectExisting(ctx, ui.selectedId);
      ctx.render();
    }
    return true;
  }
  if (action === 'ag-save') {
    await saveAgent(ctx);
    return true;
  }
  if (action === 'ag-toggle-group') {
    toggleGroup(ctx, el.getAttribute('data-group') || '');
    return true;
  }
  if (action === 'ag-expand-group') {
    const groupId = el.getAttribute('data-group') || '';
    const group = GROUPS.find((item) => item.id === groupId);
    if (!group || group.plugin) return true;
    ui.expanded[groupId] = !ui.expanded[groupId];
    ctx.render();
    return true;
  }
  if (action === 'ag-skills-open') {
    closeModelPop(ctx.state);
    ui.skillsOpen = !ui.skillsOpen;
    if (ui.skillsOpen) ui.skillsQuery = '';
    ctx.render();
    return true;
  }
  if (action === 'ag-skills-done') {
    ui.skillsOpen = false;
    ctx.render();
    return true;
  }
  if (action === 'ag-skills-all') {
    ui.draft.skillsInherit = true;
    ui.draft.skills = [];
    ctx.render();
    return true;
  }
  if (action === 'ag-skills-none') {
    ui.draft.skillsInherit = false;
    ui.draft.skills = [];
    ctx.render();
    return true;
  }
  return false;
}
