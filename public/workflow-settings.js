// Settings → Workflow. Pipelines only; sub-agents are edited on the Agent page.

const ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
const BUILTIN_ROLE_ORDER = ['planner', 'coder', 'tester', 'auditor'];
const CANONICAL_ROLE_NAMES = {
  coder: 'Coder',
  tester: 'Tester',
  auditor: 'Auditor',
  default: 'Default',
  planner: 'Planner',
};

export function roleTitle(role, ctx) {
  if (!role) return ctx.t('agent_name');
  const canonical = CANONICAL_ROLE_NAMES[role.id];
  if (canonical && role.name === canonical) return ctx.localizeRoleLabel(role.id);
  return role.name || ctx.localizeRoleLabel(role.id || '');
}

export function pipelineTitle(pipe, ctx) {
  const stored = String(pipe?.name || pipe?.id || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
  if (pipe?.id === 'demo' && /^demo$/i.test(stored)) return ctx.t('pipeline_demo_title');
  if (pipe?.id === 'feature' && /^feature$/i.test(stored)) return ctx.t('pipeline_feature_title');
  return stored.replace(/\b(coder|tester|auditor|default|planner)\b/gi, (part) => ctx.localizeRoleLabel(part));
}

function builtinRoles(ctx) {
  const byId = new Map(
    (ctx.state.roles || [])
      .filter((role) => role.builtin && role.id !== 'default' && role.defaultPrompt)
      .map((role) => [role.id, role]),
  );
  return BUILTIN_ROLE_ORDER.map((id) => byId.get(id)).filter(Boolean);
}

function subAgents(ctx) {
  return (ctx.state.roles || []).filter((role) => role && role.id && role.id !== 'default');
}

function preferredRoleId(roles) {
  const ids = (roles || []).map((role) => role.id).filter((id) => id && id !== 'default');
  return ['coder', 'planner'].find((id) => ids.includes(id)) || ids[0] || '';
}

function emptyPipelineDraft(roles) {
  return { id: '', name: '', steps: [{ role: preferredRoleId(roles), input: 'user' }] };
}

function pipelineDraftFrom(pipe) {
  const steps = (pipe.steps || []).map((step) => ({
    role: step.role,
    input: step.input === 'previous' ? 'previous' : 'user',
  }));
  return { id: pipe.id, name: pipe.name || '', steps };
}

export function captureWorkflowDraft(ctx) {
  const editor = ctx.state.workflowEditor;
  if (!editor || editor.skipCapture || editor.kind !== 'pipeline') return;
  if (document.getElementById('wf-pipe-name')) editor.draft = readPipelineDraft(ctx);
}

export function renderWorkflowTab(ctx) {
  const editor = ctx.state.workflowEditor;
  if (editor?.kind === 'pipeline') return renderPipelineEditor(ctx);
  return renderWorkflowList(ctx);
}

function renderWorkflowList(ctx) {
  const query = ctx.state.workflowQuery || '';
  return (
    `<h2>${ctx.escapeHtml(ctx.t('settings_tab_workflow'))}</h2>` +
    `<p class="wf-hint">${ctx.escapeHtml(ctx.t('wf_storage_hint'))}</p>` +
    `<div class="wf-toolbar">` +
    `<div class="wf-search">` +
    `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>` +
    `<input type="text" id="workflow-search-input" data-testid="workflow-search" value="${ctx.escapeHtml(query)}" placeholder="${ctx.escapeHtml(ctx.t('wf_search_pipelines'))}" />` +
    `</div>` +
    `<button type="button" class="btn p" data-action="workflow-new" data-testid="workflow-new">${ctx.escapeHtml(ctx.t('wf_new_pipeline'))}</button>` +
    `</div>` +
    `<div id="workflow-grid" class="wf-grid">${renderWorkflowCards(ctx, query)}</div>`
  );
}

function sorted(list, label) {
  return list.slice().sort((a, b) => label(a).localeCompare(label(b), undefined, { numeric: true, sensitivity: 'base' }));
}

function matchesQuery(haystack, query) {
  if (!query) return true;
  return haystack.toLowerCase().includes(query.trim().toLowerCase());
}

function renderWorkflowCards(ctx, query) {
  const list = sorted(ctx.state.pipelines || [], (pipe) => pipelineTitle(pipe, ctx)).filter((pipe) => {
    const chain = (pipe.steps || []).map((step) => step.role).join(' ');
    return matchesQuery(`${pipe.name || ''} ${pipe.id || ''} ${chain} ${pipelineTitle(pipe, ctx)}`, query);
  });
  if (!list.length) {
    const searching = Boolean(query && query.trim() && (ctx.state.pipelines || []).length);
    return emptyCatalog(ctx, searching ? 'wf_empty_search' : 'wf_empty_pipelines');
  }
  return list.map((pipe) => pipelineCard(ctx, pipe)).join('');
}

function emptyCatalog(ctx, key) {
  return (
    `<div class="catalog-empty">` +
    `<div class="catalog-empty-title">${ctx.escapeHtml(ctx.t(key))}</div>` +
    `</div>`
  );
}

function pipelineCard(ctx, pipe) {
  const title = pipelineTitle(pipe, ctx);
  const letter = (title || pipe.id || 'P').slice(0, 1).toUpperCase();
  const chain = (pipe.steps || []).map((step) => {
    const role = (ctx.state.roles || []).find((item) => item.id === step.role);
    return role ? roleTitle(role, ctx) : ctx.localizeRoleLabel(step.role);
  }).join(' → ');
  return (
    `<article class="wf-card" data-testid="workflow-pipeline-card" data-id="${ctx.escapeHtml(pipe.id)}">` +
    `<div class="wf-card-head">` +
    `<div class="wf-avatar">${ctx.escapeHtml(letter)}</div>` +
    `<div class="wf-card-id"><b>${ctx.escapeHtml(title)}</b><span>${ctx.escapeHtml(pipe.id)}</span></div>` +
    `</div>` +
    `<div class="wf-chain">${ctx.escapeHtml(chain)}</div>` +
    `<div class="wf-actions">` +
    `<button type="button" class="btn" data-action="workflow-edit" data-kind="pipeline" data-id="${ctx.escapeHtml(pipe.id)}">${ctx.escapeHtml(ctx.t('wf_edit'))}</button>` +
    `<button type="button" class="btn wf-btn-danger" data-action="workflow-delete" data-kind="pipeline" data-id="${ctx.escapeHtml(pipe.id)}">${ctx.escapeHtml(ctx.t('wf_delete'))}</button>` +
    `</div>` +
    `</article>`
  );
}

function editorShell(ctx, title, body) {
  return (
    `<h2>${ctx.escapeHtml(title)}</h2>` +
    `<button type="button" class="btn wf-back" data-action="workflow-cancel">${ctx.escapeHtml(ctx.t('wf_back'))}</button>` +
    `<form id="workflow-form" class="wf-editor">` +
    body +
    `<div id="workflow-form-error" class="modal-inline-error" role="alert"></div>` +
    `<div class="wf-editor-actions">` +
    `<button type="button" class="btn" data-action="workflow-cancel">${ctx.escapeHtml(ctx.t('btn_cancel'))}</button>` +
    `<button type="button" class="btn p" data-action="workflow-save" data-testid="workflow-save">${ctx.escapeHtml(ctx.t('btn_save'))}</button>` +
    `</div>` +
    `</form>`
  );
}

function renderBuiltinStepChoices(ctx) {
  const roles = builtinRoles(ctx);
  if (!roles.length) return '';
  const buttons = roles.map((role) => (
    `<button type="button" class="btn" data-action="workflow-add-builtin" data-template="${ctx.escapeHtml(role.id)}" data-testid="workflow-add-builtin-${ctx.escapeHtml(role.id)}">${ctx.escapeHtml(roleTitle(role, ctx))}</button>`
  )).join('');
  return (
    `<div class="wf-starters" data-testid="workflow-pipeline-builtins">` +
    `<div class="wf-starter-label">${ctx.escapeHtml(ctx.t('wf_pipeline_builtins'))}</div>` +
    `<div class="wf-starter-row">${buttons}</div>` +
    `<span class="wf-field-hint">${ctx.escapeHtml(ctx.t('wf_pipeline_builtin_hint'))}</span>` +
    `</div>`
  );
}

function renderPipelineEditor(ctx) {
  const editor = ctx.state.workflowEditor;
  const draft = editor.draft || emptyPipelineDraft(subAgents(ctx));
  const editing = editor.mode === 'edit';
  const title = editing ? ctx.t('wf_edit_pipeline') : ctx.t('wf_new_pipeline');
  const idField = editing
    ? `<input id="wf-pipe-id" data-testid="workflow-pipeline-id" value="${ctx.escapeHtml(draft.id)}" disabled />`
    : `<input id="wf-pipe-id" data-testid="workflow-pipeline-id" value="${ctx.escapeHtml(draft.id)}" placeholder="feature" autocomplete="off" />`;
  const steps = (draft.steps || []).map((step, index) => stepRow(ctx, step, index, draft.steps.length)).join('');
  const atLimit = (draft.steps || []).length >= 20;
  const body = (
    (editing ? '' : renderBuiltinStepChoices(ctx)) +
    `<div class="form-group"><label>${ctx.escapeHtml(ctx.t('wf_id'))}</label>${idField}<span class="wf-field-hint">${ctx.escapeHtml(ctx.t('wf_id_hint'))}</span></div>` +
    `<div class="form-group"><label>${ctx.escapeHtml(ctx.t('wf_name'))}</label><input id="wf-pipe-name" data-testid="workflow-pipeline-name" value="${ctx.escapeHtml(draft.name)}" autocomplete="off" /></div>` +
    `<div class="form-group"><label>${ctx.escapeHtml(ctx.t('wf_steps'))}</label><div id="wf-steps">${steps}</div>` +
    `<div class="wf-step-actions">` +
    `<button type="button" class="btn" data-action="workflow-add-step" data-testid="workflow-add-step" ${atLimit ? 'disabled' : ''}>${ctx.escapeHtml(ctx.t('wf_add_step'))}</button>` +
    `<button type="button" class="btn" data-action="set-settings-tab" data-tab="agents">${ctx.escapeHtml(ctx.t('wf_manage_agents'))}</button>` +
    `</div>` +
    `<span class="wf-field-hint">${ctx.escapeHtml(ctx.t('wf_step_limit'))}</span>` +
    `</div>`
  );
  return editorShell(ctx, title, body);
}

function stepRow(ctx, step, index, count) {
  const roles = subAgents(ctx);
  const known = roles.some((role) => role.id === step.role);
  const options = roles.map((role) => (
    `<option value="${ctx.escapeHtml(role.id)}" ${role.id === step.role ? 'selected' : ''}>${ctx.escapeHtml(roleTitle(role, ctx))}</option>`
  )).join('');
  const missing = !known && step.role
    ? `<option value="${ctx.escapeHtml(step.role)}" selected>${ctx.escapeHtml(ctx.localizeRoleLabel(step.role))}</option>`
    : '';
  const input = step.input === 'previous' ? 'previous' : 'user';
  return (
    `<div class="wf-step">` +
    `<span class="wf-step-index">${index + 1}</span>` +
    `<select class="wf-step-role" aria-label="${ctx.escapeHtml(ctx.t('wf_step_role'))}">${missing}${options}</select>` +
    `<select class="wf-step-input" aria-label="${ctx.escapeHtml(ctx.t('wf_step_input'))}">` +
    `<option value="user" ${input === 'user' ? 'selected' : ''}>${ctx.escapeHtml(ctx.t('wf_input_user'))}</option>` +
    `<option value="previous" ${input === 'previous' ? 'selected' : ''}>${ctx.escapeHtml(ctx.t('wf_input_previous'))}</option>` +
    `</select>` +
    `<button type="button" class="btn" data-action="workflow-move-step" data-dir="-1" data-index="${index}" ${index === 0 ? 'disabled' : ''}>${ctx.escapeHtml(ctx.t('wf_move_up'))}</button>` +
    `<button type="button" class="btn" data-action="workflow-move-step" data-dir="1" data-index="${index}" ${index === count - 1 ? 'disabled' : ''}>${ctx.escapeHtml(ctx.t('wf_move_down'))}</button>` +
    `<button type="button" class="btn" data-action="workflow-remove-step" data-index="${index}" ${count <= 1 ? 'disabled' : ''}>${ctx.escapeHtml(ctx.t('wf_remove_step'))}</button>` +
    `</div>`
  );
}

function readSteps() {
  return [...document.querySelectorAll('#wf-steps .wf-step')].map((row) => ({
    role: row.querySelector('.wf-step-role')?.value || '',
    input: row.querySelector('.wf-step-input')?.value === 'previous' ? 'previous' : 'user',
  }));
}

function readPipelineDraft(ctx) {
  const editor = ctx.state.workflowEditor || {};
  const id = editor.mode === 'edit'
    ? editor.id
    : (document.getElementById('wf-pipe-id')?.value || '').trim();
  return {
    id,
    name: document.getElementById('wf-pipe-name')?.value || '',
    steps: readSteps(),
  };
}

function showFormError(ctx, message) {
  const el = document.getElementById('workflow-form-error');
  if (!el) {
    ctx.showToast(message);
    return;
  }
  el.textContent = message;
  el.classList.add('is-visible');
}

function mapServerError(message, ctx) {
  const text = String(message || '');
  if (text === 'invalid id' || text === 'id mismatch') return ctx.t('wf_err_id');
  if (text === 'invalid name') return ctx.t('wf_err_name');
  if (text.startsWith('unknown role')) return ctx.t('wf_err_unknown_role');
  if (text.includes('steps')) return ctx.t('wf_err_steps');
  if (text.startsWith('invalid input')) return ctx.t('wf_err_input');
  return ctx.t('wf_err_invalid');
}

function errorText(err, ctx) {
  const body = err?.body || {};
  if (body.error === 'exists') return ctx.t('wf_err_exists');
  if (body.error === 'protected') return ctx.t('wf_err_protected');
  if (body.error === 'role_in_use') {
    const names = (body.pipelines || []).map((id) => {
      const pipe = (ctx.state.pipelines || []).find((item) => item.id === id);
      return pipe ? pipelineTitle(pipe, ctx) : id;
    });
    return ctx.t('wf_err_in_use_role', { names: names.join(', ') });
  }
  if (body.error === 'role_in_conversations') return ctx.t('wf_err_in_use_role_conv');
  if (body.error === 'pipeline_in_use') return ctx.t('wf_err_in_use_pipeline');
  if (body.error === 'not_found') return ctx.t('wf_err_missing');
  if (Array.isArray(body.errors) && body.errors.length) {
    return body.errors.map((item) => mapServerError(item, ctx)).join(' ');
  }
  return ctx.t('wf_err_invalid');
}

async function reloadCatalog(ctx) {
  try { ctx.state.roles = await ctx.api('/api/roles'); } catch { /* keep */ }
  try { ctx.state.pipelines = await ctx.api('/api/pipelines'); } catch { /* keep */ }
}

function openPipelineEditor(ctx, mode, id, draft) {
  ctx.state.workflowSection = 'pipelines';
  ctx.state.workflowEditor = {
    kind: 'pipeline',
    mode,
    id: id || '',
    draft: draft || emptyPipelineDraft(subAgents(ctx)),
    stepsUntouched: mode === 'create' && draft == null,
  };
  ctx.render();
}

export function filterWorkflow(query, ctx) {
  ctx.state.workflowQuery = query;
  const grid = document.getElementById('workflow-grid');
  if (!grid) return;
  grid.innerHTML = renderWorkflowCards(ctx, query);
}

function mutateSteps(ctx, fn) {
  const draft = readPipelineDraft(ctx);
  fn(draft.steps);
  ctx.state.workflowEditor.draft = draft;
  ctx.state.workflowEditor.skipCapture = true;
  try {
    ctx.render();
  } finally {
    if (ctx.state.workflowEditor) ctx.state.workflowEditor.skipCapture = false;
  }
}

function findTemplateRole(ctx, id) {
  return builtinRoles(ctx).find((role) => role.id === id) || null;
}

function addBuiltinStep(el, ctx) {
  const role = findTemplateRole(ctx, el.getAttribute('data-template'));
  if (!role) return;
  const editor = ctx.state.workflowEditor;
  mutateSteps(ctx, (steps) => {
    const placeholder = editor?.stepsUntouched && steps.length === 1
      && steps[0].role === preferredRoleId(subAgents(ctx))
      && steps[0].input !== 'previous';
    if (placeholder) {
      steps[0] = { role: role.id, input: 'user' };
      return;
    }
    if (steps.length >= 20) return;
    steps.push({ role: role.id, input: steps.length ? 'previous' : 'user' });
  });
  if (ctx.state.workflowEditor) ctx.state.workflowEditor.stepsUntouched = false;
}

export function handleWorkflowAction(action, el, ctx) {
  switch (action) {
    case 'workflow-new':
      openPipelineEditor(ctx, 'create');
      return true;
    case 'workflow-edit':
      return beginEdit(el, ctx);
    case 'workflow-delete':
      removeCatalogItem(el, ctx);
      return true;
    case 'workflow-cancel':
      ctx.state.workflowEditor = null;
      ctx.render();
      return true;
    case 'workflow-save':
      saveEditor(ctx);
      return true;
    case 'workflow-add-step':
      mutateSteps(ctx, (steps) => {
        if (steps.length >= 20) return;
        steps.push({ role: preferredRoleId(subAgents(ctx)), input: steps.length ? 'previous' : 'user' });
      });
      if (ctx.state.workflowEditor) ctx.state.workflowEditor.stepsUntouched = false;
      return true;
    case 'workflow-remove-step':
      mutateSteps(ctx, (steps) => {
        const index = Number(el.getAttribute('data-index'));
        if (steps.length <= 1 || !Number.isInteger(index)) return;
        steps.splice(index, 1);
      });
      return true;
    case 'workflow-move-step':
      mutateSteps(ctx, (steps) => {
        const index = Number(el.getAttribute('data-index'));
        const dir = Number(el.getAttribute('data-dir'));
        const next = index + dir;
        if (!Number.isInteger(index) || next < 0 || next >= steps.length) return;
        const [item] = steps.splice(index, 1);
        steps.splice(next, 0, item);
      });
      return true;
    case 'workflow-add-builtin':
      addBuiltinStep(el, ctx);
      return true;
    default:
      return false;
  }
}

function beginEdit(el, ctx) {
  const kind = el.getAttribute('data-kind');
  const id = el.getAttribute('data-id');
  if (kind !== 'pipeline') return true;
  const pipe = (ctx.state.pipelines || []).find((item) => item.id === id);
  if (!pipe) return true;
  openPipelineEditor(ctx, 'edit', id, pipelineDraftFrom(pipe));
  return true;
}

async function removeCatalogItem(el, ctx) {
  const kind = el.getAttribute('data-kind');
  const id = el.getAttribute('data-id');
  if (kind !== 'pipeline' || !id) return;
  const name = pipelineTitle((ctx.state.pipelines || []).find((item) => item.id === id) || { id, name: id }, ctx);
  if (typeof ctx.confirm !== 'function') return;
  const ok = await ctx.confirm({
    message: ctx.t('wf_confirm_delete_pipeline', { name }),
    danger: true,
    confirmLabel: ctx.t('wf_delete'),
  });
  if (!ok) return;
  try {
    await ctx.api(`/api/pipelines/${encodeURIComponent(id)}`, 'DELETE');
    ctx.showToast('wf_deleted');
    await reloadCatalog(ctx);
    ctx.render();
  } catch (err) {
    ctx.showToast(errorText(err, ctx));
  }
}

function validatePipelineDraft(draft, ctx) {
  if (!ID_RE.test(draft.id || '')) return ctx.t('wf_err_id');
  if (!String(draft.name || '').trim()) return ctx.t('wf_err_name');
  if (!Array.isArray(draft.steps) || draft.steps.length === 0 || draft.steps.length > 20) return ctx.t('wf_err_steps');
  const known = new Set((ctx.state.roles || []).map((role) => role.id));
  for (const step of draft.steps) {
    if (!known.has(step.role)) return ctx.t('wf_err_unknown_role');
    if (step.input !== 'user' && step.input !== 'previous') return ctx.t('wf_err_input');
  }
  return '';
}

async function saveEditor(ctx) {
  const editor = ctx.state.workflowEditor;
  if (!editor || editor.kind !== 'pipeline' || ctx.state.workflowSaving) return;
  const draft = readPipelineDraft(ctx);
  editor.draft = draft;
  const problem = validatePipelineDraft(draft, ctx);
  if (problem) {
    showFormError(ctx, problem);
    return;
  }
  const endpoint = editor.mode === 'edit' ? `/api/pipelines/${encodeURIComponent(draft.id)}` : '/api/pipelines';
  const method = editor.mode === 'edit' ? 'PUT' : 'POST';
  const payload = {
    id: draft.id,
    name: draft.name.trim(),
    steps: draft.steps.map((step) => ({ role: step.role, input: step.input })),
  };
  ctx.state.workflowSaving = true;
  try {
    await ctx.api(endpoint, method, payload);
    ctx.showToast('wf_saved');
    await reloadCatalog(ctx);
    ctx.state.workflowSaving = false;
    ctx.state.workflowEditor = null;
    ctx.state.workflowSection = 'pipelines';
    ctx.render();
  } catch (err) {
    ctx.state.workflowSaving = false;
    showFormError(ctx, errorText(err, ctx));
  }
}
