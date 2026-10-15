const TEST_KEYS = {
  auth_failed: 'git_test_auth',
  cert_failed: 'git_test_cert',
  network: 'git_test_network',
  timeout: 'git_test_timeout',
  unknown: 'git_test_unknown',
  http_not_allowed: 'git_test_http',
  not_gitlab: 'git_test_unknown',
};

const KIND_LABEL = {
  'gitlab-self': 'git_kind_self',
  'gitlab-com': 'git_kind_com',
  other: 'git_kind_other',
};

function emptyForm() {
  return {
    kind: 'gitlab-self',
    name: '',
    baseUrl: '',
    token: '',
    tokenMasked: false,
    allowHttp: false,
    caFile: '',
  };
}

function ensureGitUi(state) {
  if (!state.gitUi) {
    state.gitUi = {
      loaded: false,
      loading: false,
      connections: [],
      drawer: null,
      editingId: null,
      advanced: false,
      form: emptyForm(),
      test: { phase: 'idle', username: '', code: '' },
      rowTesting: null,
    };
  }
  return state.gitUi;
}

export function gitlabTokenPage(baseUrl) {
  const text = String(baseUrl || '').trim();
  if (!text) return '';
  try {
    const url = new URL(text.includes('://') ? text : `https://${text}`);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return `${url.origin}/-/user_settings/personal_access_tokens`;
  } catch {
    return '';
  }
}

function kindHint(kind, t) {
  if (kind === 'gitlab-com') return t('git_kind_hint_com');
  if (kind === 'other') return t('git_kind_hint_other');
  return t('git_kind_hint_self');
}

function testText(code, t) {
  if (code === 'name') return t('git_err_name');
  if (code === 'url') return t('git_err_url');
  if (code === 'token') return t('git_err_token');
  return t(TEST_KEYS[code] || 'git_test_unknown');
}

function hostLabel(baseUrl) {
  return String(baseUrl || '').replace(/^https?:\/\//, '');
}

function captureForm(ctx) {
  const ui = ensureGitUi(ctx.state);
  const name = document.getElementById('git-name');
  if (!name) return ui.form;
  ui.form = {
    ...ui.form,
    name: name.value,
    baseUrl: document.getElementById('git-url')?.value || '',
    token: document.getElementById('git-token')?.value || '',
    tokenMasked: document.getElementById('git-token')?.dataset.mask === '1',
    allowHttp: Boolean(document.getElementById('git-http')?.checked),
    caFile: document.getElementById('git-ca')?.value || '',
  };
  return ui.form;
}

function payloadFromForm(form) {
  return {
    kind: form.kind,
    name: form.name.trim(),
    baseUrl: form.kind === 'gitlab-com' ? 'https://gitlab.com' : form.baseUrl.trim(),
    token: form.tokenMasked ? form.token : form.token,
    allowHttp: form.kind === 'gitlab-self' && form.allowHttp,
    caFile: form.caFile.trim(),
  };
}

async function reloadConnections(ctx) {
  const ui = ensureGitUi(ctx.state);
  ui.connections = await ctx.api('/api/git/connections');
  ui.loaded = true;
  ui.loading = false;
}

function scopeHint(t, escapeHtml) {
  return `${escapeHtml(t('git_token_need'))} <span class="mono">read_repository</span> ${escapeHtml(t('git_token_and'))} <span class="mono">read_api</span>${escapeHtml(t('git_token_mid'))} <span class="mono">.git/config</span>${escapeHtml(t('git_token_end'))}`;
}

function renderTest(ui, t, escapeHtml) {
  if (ui.test.phase === 'idle') return '';
  if (ui.test.phase === 'testing') {
    return `<div class="ms-result git-test" id="git-test-result" data-testid="git-test-result"><div class="git-line"><span class="ms-spin" aria-hidden="true"></span><span>${escapeHtml(t('git_testing'))}</span></div></div>`;
  }
  if (ui.test.phase === 'ok') {
    return `<div class="ms-result git-test" id="git-test-result" data-testid="git-test-result"><div class="git-line git-ok"><span aria-hidden="true">✓</span><b>${escapeHtml(ui.test.username || '')}</b></div><div class="ms-hint">${escapeHtml(t('git_test_ok'))}</div></div>`;
  }
  return `<div class="ms-result git-test" id="git-test-result" data-testid="git-test-result"><div class="git-bad">${escapeHtml(testText(ui.test.code, t))}</div></div>`;
}

function renderDrawer(ctx) {
  const { t, escapeHtml, state } = ctx;
  const ui = ensureGitUi(state);
  if (!ui.drawer) return '';
  const form = ui.form;
  const editing = ui.drawer === 'edit';
  const current = ui.connections.find((item) => item.id === ui.editingId);
  const title = editing ? t('git_edit_title', { name: current?.name || form.name || '' }) : t('git_add_title');
  const link = gitlabTokenPage(form.kind === 'gitlab-com' ? 'https://gitlab.com' : form.baseUrl);
  const tokenHint = editing
    ? (form.tokenMasked ? t('git_token_hint_edit') : t('git_token_keep'))
    : (form.kind === 'other' ? t('git_token_hint_other') : t('git_token_hint_new'));
  const kinds = ['gitlab-self', 'gitlab-com', 'other'].map((kind) => {
    const key = kind === 'gitlab-self' ? 'self' : (kind === 'gitlab-com' ? 'com' : 'other');
    return `<button type="button" class="ms-vendor${form.kind === kind ? ' on' : ''}" data-action="git-kind" data-kind="${kind}">${escapeHtml(t(`git_kind_${key}`))}</button>`;
  }).join('');
  return `<div class="ms-drawer-scrim" data-action="git-close-drawer"></div>` +
    `<div class="ms-drawer" data-testid="git-drawer">` +
    `<div class="ms-drawer-pane">` +
    `<div class="ms-dr-head"><b>${escapeHtml(title)}</b><button type="button" class="btn g btn-sm" data-action="git-close-drawer" aria-label="${escapeHtml(t('btn_cancel'))}">✕</button></div>` +
    `<div class="ms-dr-body">` +
    `<div class="ms-field"><label>${escapeHtml(t('git_kind'))}</label><div class="ms-vendors">${kinds}</div><div class="ms-hint">${escapeHtml(kindHint(form.kind, t))}</div></div>` +
    `<div class="ms-field"><label>${escapeHtml(t('git_name'))}</label><input class="ms-in" id="git-name" data-testid="git-name" value="${escapeHtml(form.name)}" placeholder="${escapeHtml(t('git_name_ph'))}" autocomplete="off"></div>` +
    `<div class="ms-field"><label>${escapeHtml(t('git_url'))}</label><input class="ms-in mono" id="git-url" data-testid="git-url" value="${escapeHtml(form.kind === 'gitlab-com' ? 'https://gitlab.com' : form.baseUrl)}" placeholder="${escapeHtml(t('git_url_ph'))}"${form.kind === 'gitlab-com' ? ' readonly' : ''} spellcheck="false" autocomplete="off"><div class="ms-hint">${escapeHtml(form.kind === 'gitlab-com' ? t('git_url_com_hint') : t('git_url_hint'))}</div></div>` +
    `<div class="ms-field"><label>${escapeHtml(t('git_token'))}</label><input class="ms-in mono${form.tokenMasked ? ' is-mask' : ''}" id="git-token" data-testid="git-token" type="${form.tokenMasked ? 'text' : 'password'}" data-mask="${form.tokenMasked ? '1' : ''}" value="${escapeHtml(form.token)}" placeholder="${escapeHtml(form.tokenMasked ? t('git_token_keep') : t('git_token_ph'))}" spellcheck="false" autocomplete="off"><div class="ms-hint">${scopeHint(t, escapeHtml)}</div><div class="ms-hint">${escapeHtml(tokenHint)}</div><div class="ms-hint"><a id="git-token-link" class="git-token-link${link ? '' : ' is-disabled'}" href="${escapeHtml(link || '#')}" target="_blank" rel="noreferrer">${escapeHtml(t('git_token_link'))}</a></div></div>` +
    (form.kind === 'gitlab-self'
      ? `<label class="git-chk"><input type="checkbox" id="git-http" data-testid="git-http"${form.allowHttp ? ' checked' : ''}><span>${escapeHtml(t('git_http'))}<span class="ms-hint git-chk-hint">${escapeHtml(t('git_http_hint'))}</span></span></label>`
      : '') +
    `<button type="button" class="git-adv" data-action="git-toggle-advanced" aria-expanded="${ui.advanced ? 'true' : 'false'}"><span class="git-caret${ui.advanced ? ' up' : ''}"></span>${escapeHtml(t('git_advanced'))}</button>` +
    `<div class="git-adv-body"${ui.advanced ? '' : ' hidden'}><div class="ms-field"><label>${escapeHtml(t('git_ca'))}</label><input class="ms-in mono" id="git-ca" data-testid="git-ca" value="${escapeHtml(form.caFile)}" placeholder="${escapeHtml(t('git_ca_ph'))}" spellcheck="false" autocomplete="off"><div class="ms-hint">${escapeHtml(t('git_ca_hint'))}</div></div></div>` +
    `<div class="ms-test-row"><button type="button" class="btn" data-action="git-test-form" data-testid="git-test"${ui.test.phase === 'testing' ? ' disabled aria-busy="true"' : ''}>${escapeHtml(t('git_test'))}</button></div>` +
    renderTest(ui, t, escapeHtml) +
    `</div>` +
    `<div class="ms-dr-foot">` +
    (editing ? `<button type="button" class="btn g git-danger" data-action="git-delete-form" data-testid="git-delete">${escapeHtml(t('btn_delete'))}</button>` : '') +
    `<button type="button" class="btn g" data-action="git-close-drawer">${escapeHtml(t('btn_cancel'))}</button>` +
    `<button type="button" class="btn p" data-action="git-save" data-testid="git-save">${escapeHtml(editing ? t('btn_save') : t('git_save_add'))}</button>` +
    `</div></div></div>`;
}

function renderRow(conn, ctx) {
  const { t, escapeHtml, state } = ctx;
  const ui = ensureGitUi(state);
  const testing = ui.rowTesting === conn.id;
  const dot = testing ? 'warn' : (conn.lastTest?.ok ? 'ok' : (conn.lastTest && conn.lastTest.ok === false ? 'bad' : ''));
  let meta;
  if (testing) {
    meta = `<span class="ms-spin" aria-hidden="true"></span><span>${escapeHtml(t('git_testing'))}</span>`;
  } else if (conn.lastTest?.ok) {
    meta = `<span class="mono">${escapeHtml(hostLabel(conn.baseUrl))}</span><span class="git-sep">·</span><span>${escapeHtml(conn.lastTest.username || '')}</span><span class="git-sep">·</span><span>${escapeHtml(t('git_connected'))}</span>`;
  } else if (conn.lastTest && conn.lastTest.ok === false) {
    meta = `<span class="mono">${escapeHtml(hostLabel(conn.baseUrl))}</span><span class="git-sep">·</span><span class="git-bad">${escapeHtml(testText(conn.lastTest.error, t))}</span>`;
  } else {
    meta = `<span class="mono">${escapeHtml(hostLabel(conn.baseUrl))}</span><span class="git-sep">·</span><span>${escapeHtml(t('git_untested'))}</span>`;
  }
  return `<div class="git-row" data-testid="git-row" data-id="${escapeHtml(conn.id)}">` +
    `<span class="git-dot ${dot}"></span>` +
    `<div class="git-row-main"><div class="git-row-title"><b>${escapeHtml(conn.name)}</b><span class="git-tag">${escapeHtml(t(KIND_LABEL[conn.kind] || 'git_kind_other'))}</span></div><div class="git-row-meta">${meta}</div></div>` +
    `<div class="git-acts">` +
    `<button type="button" class="btn g btn-sm" data-action="git-test-row" data-id="${escapeHtml(conn.id)}" data-testid="git-row-test"${testing ? ' disabled aria-busy="true"' : ''}>${escapeHtml(t('git_row_test'))}</button>` +
    `<button type="button" class="btn g btn-sm" data-action="git-edit" data-id="${escapeHtml(conn.id)}" data-testid="git-edit">${escapeHtml(t('git_row_edit'))}</button>` +
    `<button type="button" class="btn g btn-sm" data-action="git-delete" data-id="${escapeHtml(conn.id)}">${escapeHtml(t('git_row_delete'))}</button>` +
    `</div></div>`;
}

function gitScrollBody(ctx, ui) {
  const { t, escapeHtml } = ctx;
  const list = ui.connections || [];
  if (!ui.loaded) return `<div class="git-empty"><span class="ms-spin" aria-hidden="true"></span></div>`;
  if (!list.length) {
    return `<div class="git-empty" data-testid="git-empty"><b>${escapeHtml(t('git_empty_title'))}</b><p>${escapeHtml(t('git_empty_body'))}</p><p class="git-foot">${escapeHtml(t('git_empty_reserved'))}</p></div>`;
  }
  const ok = list.filter((item) => item.lastTest?.ok).length;
  const bad = list.filter((item) => item.lastTest && item.lastTest.ok === false).length;
  return `<div class="git-section"><b>${escapeHtml(t('git_section'))}</b><span>${escapeHtml(t('git_section_meta', { ok, bad }))}</span></div>` +
    `<div class="git-list" data-testid="git-list">${list.map((item) => renderRow(item, ctx)).join('')}</div>` +
    `<p class="git-foot">${escapeHtml(t('git_footnote_before'))} <span class="mono">.git/config</span>${escapeHtml(t('git_footnote_after'))}</p>`;
}

function paintGitList(ctx, ui) {
  const host = document.querySelector('[data-testid="git-page"] .git-scroll');
  if (!host || ctx.state.activeSettingsTab !== 'git') return false;
  host.innerHTML = gitScrollBody(ctx, ui);
  return true;
}

export function renderGitPane(ctx) {
  const { t, escapeHtml, state } = ctx;
  const ui = ensureGitUi(state);
  if (!ui.loaded && !ui.loading) {
    ui.loading = true;
    const stamp = (ui.stamp = (ui.stamp || 0) + 1);
    ctx.api('/api/git/connections').then((list) => {
      if (stamp !== ui.stamp) return;
      ui.connections = Array.isArray(list) ? list : [];
      ui.loaded = true;
      ui.loading = false;
      if (!paintGitList(ctx, ui)) ctx.render();
    }).catch(() => {
      if (stamp !== ui.stamp) return;
      ui.loading = false;
      ui.loaded = true;
      ui.connections = [];
      if (!paintGitList(ctx, ui)) ctx.render();
    });
  }
  const body = gitScrollBody(ctx, ui);
  return `<div class="sm-git${ui.drawer ? ' show' : ''}" data-testid="git-page">` +
    `<button type="button" class="sm-x ms-x" data-action="close-settings" aria-label="${escapeHtml(t('btn_cancel'))}">×</button>` +
    `<div class="git-head"><div><h2>${escapeHtml(t('settings_tab_git'))} <span class="git-aside">${escapeHtml(t('git_aside'))}</span></h2><p>${escapeHtml(t('git_lead'))}</p></div>` +
    `<button type="button" class="btn" data-action="git-add" data-testid="git-add">${escapeHtml(t('git_add'))}</button></div>` +
    `<div class="git-scroll">${body}</div>` +
    renderDrawer(ctx) +
    `</div>`;
}

function openAdd(ctx) {
  const ui = ensureGitUi(ctx.state);
  ui.drawer = 'add';
  ui.editingId = null;
  ui.advanced = false;
  ui.form = emptyForm();
  ui.test = { phase: 'idle', username: '', code: '' };
  ctx.render();
}

function openEdit(ctx, id) {
  const ui = ensureGitUi(ctx.state);
  const conn = ui.connections.find((item) => item.id === id);
  if (!conn) return;
  ui.drawer = 'edit';
  ui.editingId = id;
  ui.advanced = Boolean(conn.caFile);
  ui.form = {
    kind: conn.kind,
    name: conn.name || '',
    baseUrl: conn.baseUrl || '',
    token: conn.token || '',
    tokenMasked: Boolean(conn.token),
    allowHttp: conn.allowHttp === true,
    caFile: conn.caFile || '',
  };
  ui.test = { phase: 'idle', username: '', code: '' };
  ctx.render();
}

async function removeConnection(ctx, id) {
  const ui = ensureGitUi(ctx.state);
  const conn = ui.connections.find((item) => item.id === id);
  if (!conn) return;
  const ok = await ctx.confirm({
    title: ctx.t('git_delete_title', { name: conn.name }),
    message: ctx.t('git_delete_body'),
    confirmLabel: ctx.t('btn_delete'),
    danger: true,
  });
  if (!ok) return;
  await ctx.api(`/api/git/connections/${encodeURIComponent(id)}`, 'DELETE');
  ui.drawer = null;
  ui.editingId = null;
  await reloadConnections(ctx);
  ctx.render();
}

export async function handleGitAction(action, el, ctx) {
  const ui = ensureGitUi(ctx.state);
  if (action === 'git-add') {
    openAdd(ctx);
    return;
  }
  if (action === 'git-close-drawer') {
    ui.drawer = null;
    ui.test = { phase: 'idle', username: '', code: '' };
    ctx.render();
    return;
  }
  if (action === 'git-edit') {
    openEdit(ctx, el.getAttribute('data-id'));
    return;
  }
  if (action === 'git-delete') {
    await removeConnection(ctx, el.getAttribute('data-id'));
    return;
  }
  if (action === 'git-delete-form') {
    captureForm(ctx);
    await removeConnection(ctx, ui.editingId);
    return;
  }
  if (action === 'git-toggle-advanced') {
    captureForm(ctx);
    ui.advanced = !ui.advanced;
    ctx.render();
    return;
  }
  if (action === 'git-kind') {
    captureForm(ctx);
    const kind = el.getAttribute('data-kind') || 'gitlab-self';
    ui.form.kind = kind;
    if (kind === 'gitlab-com') ui.form.baseUrl = 'https://gitlab.com';
    if (kind !== 'gitlab-self') ui.form.allowHttp = false;
    ui.test = { phase: 'idle', username: '', code: '' };
    ctx.render();
    return;
  }
  if (action === 'git-test-row') {
    const id = el.getAttribute('data-id');
    ui.rowTesting = id;
    ctx.render();
    try {
      const result = await ctx.api(`/api/git/connections/${encodeURIComponent(id)}/test`, 'POST', {});
      if (result?.connection) {
        ui.connections = ui.connections.map((item) => (item.id === id ? result.connection : item));
      } else {
        await reloadConnections(ctx);
      }
    } catch {
      await reloadConnections(ctx).catch(() => {});
    } finally {
      ui.rowTesting = null;
      ctx.render();
    }
    return;
  }
  if (action === 'git-test-form') {
    const form = captureForm(ctx);
    ui.test = { phase: 'testing', username: '', code: '' };
    ctx.render();
    try {
      const body = payloadFromForm(form);
      if (ui.editingId) body.id = ui.editingId;
      const result = await ctx.api('/api/git/connections/test', 'POST', body);
      ui.test = result?.ok
        ? { phase: 'ok', username: result.username || '', code: '' }
        : { phase: 'fail', username: '', code: result?.code || 'unknown' };
    } catch (err) {
      ui.test = { phase: 'fail', username: '', code: err?.body?.code || 'network' };
    }
    ctx.render();
    return;
  }
  if (action === 'git-save') {
    const form = captureForm(ctx);
    const body = payloadFromForm(form);
    try {
      if (ui.drawer === 'edit' && ui.editingId) {
        await ctx.api(`/api/git/connections/${encodeURIComponent(ui.editingId)}`, 'PATCH', body);
      } else {
        await ctx.api('/api/git/connections', 'POST', body);
      }
      ui.drawer = null;
      ui.editingId = null;
      ui.test = { phase: 'idle', username: '', code: '' };
      await reloadConnections(ctx);
      ctx.render();
    } catch (err) {
      const errors = err?.body?.errors || [];
      ui.test = {
        phase: 'fail',
        username: '',
        code: errors.includes('token required') ? 'auth_failed' : (errors.includes('invalid baseUrl') ? 'unknown' : 'unknown'),
      };
      if (errors.includes('name required')) ui.test.code = 'name';
      ctx.render();
    }
  }
}

export function onGitField(target) {
  if (target?.id === 'git-url') {
    const link = document.getElementById('git-token-link');
    const href = gitlabTokenPage(target.value);
    if (link) {
      link.href = href || '#';
      link.classList.toggle('is-disabled', !href);
    }
  }
  if (target?.id === 'git-token' && target.dataset.mask === '1') {
    target.dataset.mask = '';
    target.classList.remove('is-mask');
  }
}

export function onGitTokenFocus(target, t) {
  if (target?.id !== 'git-token' || target.dataset.mask !== '1') return;
  target.value = '';
  target.dataset.mask = '';
  target.classList.remove('is-mask');
  target.type = 'password';
  target.placeholder = t('git_token_keep');
  const hint = target.parentElement?.querySelectorAll('.ms-hint')?.[1];
  if (hint) hint.textContent = t('git_token_keep');
}
