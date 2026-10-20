const gitImport = {
  source: 'pick',
  connections: [],
  connectionId: '',
  projects: [],
  projectId: '',
  branches: [],
  branch: '',
  search: '',
  nameTouched: false,
  suggestedName: '',
  addrUrl: '',
  addrBranch: '',
  loading: false,
  loadError: '',
  connOpen: false,
  branchOpen: false,
  timer: 0,
  ready: false,
};

function usableConnections() {
  return gitImport.connections.filter((item) => item.kind !== 'other' && item.hasToken && item.lastTest?.ok !== false);
}

function selectedConnection() {
  const list = usableConnections();
  return list.find((item) => item.id === gitImport.connectionId) || null;
}

function selectedProject() {
  return gitImport.projects.find((item) => String(item.id) === String(gitImport.projectId)) || null;
}

export function resetGitImport() {
  clearTimeout(gitImport.timer);
  gitImport.source = 'pick';
  gitImport.connections = [];
  gitImport.connectionId = '';
  gitImport.projects = [];
  gitImport.projectId = '';
  gitImport.branches = [];
  gitImport.branch = '';
  gitImport.search = '';
  gitImport.nameTouched = false;
  gitImport.suggestedName = '';
  gitImport.addrUrl = '';
  gitImport.addrBranch = '';
  gitImport.loading = false;
  gitImport.loadError = '';
  gitImport.connOpen = false;
  gitImport.branchOpen = false;
  gitImport.ready = false;
}

function formatDay(iso, locale) {
  const date = new Date(iso);
  if (!iso || Number.isNaN(date.getTime())) return '';
  if (locale === 'en') return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
}

function projectName(project) {
  const path = String(project?.path || '');
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] || path;
}

function paint(ctx) {
  const host = document.getElementById('ws-git-fields');
  if (!host) return;
  const focused = document.activeElement?.id;
  const pos = document.activeElement?.selectionStart;
  host.innerHTML = renderGitImportBody(ctx);
  syncGitSubmit();
  if (!focused) return;
  const next = document.getElementById(focused);
  if (!next) return;
  next.focus();
  if (typeof pos === 'number') {
    try { next.setSelectionRange(pos, pos); } catch { /* number inputs */ }
  }
}

function syncGitSubmit() {
  const btn = document.querySelector('[data-testid="workspace-create-submit"]');
  if (!btn || btn.classList.contains('is-busy')) return;
  const blocked = gitImport.source === 'pick' && !selectedProject();
  btn.disabled = blocked;
}

async function loadProjects(ctx) {
  const id = gitImport.connectionId;
  const search = gitImport.search.trim();
  if (!id) {
    gitImport.projects = [];
    gitImport.loading = false;
    paint(ctx);
    return;
  }
  gitImport.loading = true;
  gitImport.loadError = '';
  const list = document.getElementById('git-project-list');
  if (list) list.innerHTML = `<div class="git-none">${ctx.escapeHtml(ctx.t('git_loading'))}</div>`;
  else paint(ctx);
  try {
    const q = search ? `?search=${encodeURIComponent(search)}` : '';
    const data = await ctx.api(`/api/git/connections/${encodeURIComponent(id)}/projects${q}`);
    if (gitImport.connectionId !== id || gitImport.search.trim() !== search) return;
    gitImport.projects = Array.isArray(data?.projects) ? data.projects : [];
    if (gitImport.projectId && !selectedProject()) {
      gitImport.projectId = '';
      gitImport.branches = [];
      gitImport.branch = '';
    }
  } catch (err) {
    if (gitImport.connectionId !== id) return;
    gitImport.projects = [];
    gitImport.loadError = err?.body?.code || 'network';
  } finally {
    if (gitImport.connectionId === id && gitImport.search.trim() === search) {
      gitImport.loading = false;
      paint(ctx);
    }
  }
}

async function loadBranches(ctx) {
  const id = gitImport.connectionId;
  const projectId = gitImport.projectId;
  if (!id || !projectId) return;
  try {
    const data = await ctx.api(`/api/git/connections/${encodeURIComponent(id)}/projects/${encodeURIComponent(projectId)}/branches`);
    if (gitImport.connectionId !== id || String(gitImport.projectId) !== String(projectId)) return;
    gitImport.branches = Array.isArray(data?.branches) ? data.branches : [];
    const project = selectedProject();
    const marked = gitImport.branches.find((item) => item.default) || gitImport.branches.find((item) => item.name === project?.defaultBranch);
    gitImport.branch = marked?.name || data?.defaultBranch || project?.defaultBranch || gitImport.branches[0]?.name || '';
  } catch (err) {
    gitImport.branches = [];
    gitImport.branch = selectedProject()?.defaultBranch || '';
    gitImport.loadError = err?.body?.code || 'network';
  }
  const project = selectedProject();
  if (project && !gitImport.nameTouched) gitImport.suggestedName = projectName(project);
  paint(ctx);
}

export async function activateGitImport(ctx) {
  if (!gitImport.ready) {
    gitImport.ready = true;
    try {
      const list = await ctx.api('/api/git/connections');
      gitImport.connections = Array.isArray(list) ? list : [];
    } catch {
      gitImport.connections = [];
    }
    const first = usableConnections()[0];
    gitImport.connectionId = first?.id || '';
  }
  paint(ctx);
  if (gitImport.source === 'pick' && gitImport.connectionId) await loadProjects(ctx);
}

export function renderGitImportBody(ctx) {
  const { t, escapeHtml } = ctx;
  const locale = ctx.locale ? ctx.locale() : 'zh';
  const pickOn = gitImport.source === 'pick';
  const seg = `<div class="seg git-source">` +
    `<button type="button" data-action="git-source" data-source="pick" class="${pickOn ? 'on' : ''}" data-testid="git-source-pick">${escapeHtml(t('git_pick'))}</button>` +
    `<button type="button" data-action="git-source" data-source="address" class="${pickOn ? '' : 'on'}" data-testid="git-source-address">${escapeHtml(t('git_address'))}</button>` +
    `</div>`;
  if (!pickOn) {
    return seg +
      `<div class="form-group"><label>${escapeHtml(t('ws_name_label'))}</label><input id="git-addr-name" data-testid="git-import-name" value="${escapeHtml(gitImport.suggestedName)}" placeholder="${escapeHtml(t('ws_name_placeholder'))}"></div>` +
      `<div class="form-group"><label>${escapeHtml(t('ws_git_url_label'))}</label><input id="ws-git-url-input" class="mono" data-testid="git-url-input" value="${escapeHtml(gitImport.addrUrl)}" placeholder="${escapeHtml(t('ws_git_url_placeholder'))}" spellcheck="false"></div>` +
      `<div class="form-group"><label>${escapeHtml(t('ws_branch_label'))}</label><input id="ws-branch-input" class="mono" value="${escapeHtml(gitImport.addrBranch)}" placeholder="${escapeHtml(t('ws_branch_placeholder'))}" spellcheck="false"></div>` +
      `<p class="git-hint">${escapeHtml(t('git_addr_hint_before'))} <span class="mono">.git/config</span>${escapeHtml(t('git_addr_hint_after'))}</p>`;
  }
  const conn = selectedConnection();
  const usable = usableConnections();
  if (!conn) {
    return seg + `<div class="git-none" data-testid="git-no-conn">${escapeHtml(t('git_no_conn'))}</div>`;
  }
  const project = selectedProject();
  const branches = gitImport.branches.length
    ? gitImport.branches
    : (project?.defaultBranch ? [{ name: project.defaultBranch, default: true }] : []);
  const branchName = gitImport.branch || project?.defaultBranch || '';
  const isDefaultBranch = (name) => {
    const row = branches.find((item) => item.name === name);
    return row?.default === true || (project && name && name === project.defaultBranch);
  };
  const listHtml = gitImport.loadError
    ? `<div class="git-none git-bad">${escapeHtml(t(cloneKey(gitImport.loadError)))}</div>`
    : gitImport.loading
      ? `<div class="git-none">${escapeHtml(t('git_loading'))}</div>`
      : gitImport.projects.length
        ? gitImport.projects.map((item) => {
          const when = formatDay(item.lastActivityAt, locale);
          const meta = [t('git_default_branch', { branch: item.defaultBranch || '—' })];
          if (when) meta.push(t('git_updated', { date: when }));
          return `<button type="button" class="git-proj${String(item.id) === String(gitImport.projectId) ? ' on' : ''}" data-action="git-project" data-project="${escapeHtml(item.id)}" data-testid="git-project">` +
            `<div class="git-proj-path"><b class="mono">${escapeHtml(item.path)}</b></div>` +
            (item.description ? `<div class="git-proj-desc">${escapeHtml(item.description)}</div>` : '') +
            `<div class="git-proj-meta">${meta.map((part) => `<span>${escapeHtml(part)}</span>`).join('<span>·</span>')}</div>` +
            `</button>`;
        }).join('')
        : `<div class="git-none">${escapeHtml(t('git_no_match'))}</div>`;
  const branchBlock = project
    ? `<div class="form-group"><label>${escapeHtml(t('git_branch'))}</label><div class="git-pick">` +
      `<button type="button" class="git-pick-btn" id="git-branch-btn" data-action="git-branch-toggle" data-testid="git-branch"><span class="mono git-pick-label">${escapeHtml(branchName)}</span><span class="git-pick-note">${isDefaultBranch(branchName) ? escapeHtml(t('git_default')) : ''}</span><span class="git-caret"></span></button>` +
      `<div class="git-pop up${gitImport.branchOpen ? ' open' : ''}" data-testid="git-branch-pop">` +
      branches.map((item) => `<button type="button" class="${item.name === branchName ? 'on' : ''}" data-action="git-branch-pick" data-branch="${escapeHtml(item.name)}"><span class="mono">${escapeHtml(item.name)}</span>${isDefaultBranch(item.name) ? `<span class="git-pick-note">${escapeHtml(t('git_default'))}</span>` : ''}</button>`).join('') +
      `</div></div></div>` +
      `<div class="form-group"><label>${escapeHtml(t('ws_name_label'))}</label><input id="git-pick-name" data-testid="git-import-name" value="${escapeHtml(gitImport.suggestedName || projectName(project))}"><div class="git-hint">${escapeHtml(t('git_name_hint'))}</div></div>`
    : `<p class="git-hint">${escapeHtml(t('git_pick_wait'))}</p>`;
  return seg +
    `<div class="form-group"><label>${escapeHtml(t('git_conn'))}</label><div class="git-pick">` +
    `<button type="button" class="git-pick-btn" data-action="git-conn-toggle" data-testid="git-conn"><span class="git-dot ok"></span><span class="git-pick-label">${escapeHtml(conn.name)}</span><span class="git-pick-note">${escapeHtml(conn.lastTest?.username || '')}</span><span class="git-caret"></span></button>` +
    `<div class="git-pop${gitImport.connOpen ? ' open' : ''}">` +
    usable.map((item) => `<button type="button" data-action="git-conn-pick" data-conn="${escapeHtml(item.id)}" class="${item.id === conn.id ? 'on' : ''}"><span class="git-dot ok"></span><span>${escapeHtml(item.name)}</span><span class="git-pick-note">${escapeHtml(item.lastTest?.username || '')}</span></button>`).join('') +
    `</div></div></div>` +
    `<div class="form-group"><label>${escapeHtml(t('git_search'))}</label><input id="git-search" data-testid="git-search" value="${escapeHtml(gitImport.search)}" placeholder="${escapeHtml(t('git_search_ph'))}" autocomplete="off"></div>` +
    `<div class="git-projects" id="git-project-list">${listHtml}</div>` +
    branchBlock;
}

function cloneKey(code) {
  const keys = {
    auth_failed: 'ws_err_conn_auth',
    cert_failed: 'ws_err_conn_cert',
    repo_not_found: 'ws_err_conn_repo',
    branch_not_found: 'ws_err_conn_branch',
    network: 'ws_err_conn_network',
    timeout: 'ws_err_conn_timeout',
    unknown: 'ws_err_conn_unknown',
    http_not_allowed: 'ws_err_conn_http',
    host_mismatch: 'ws_err_conn_host',
    git_not_found: 'ws_err_conn_git',
    not_gitlab: 'ws_err_conn_not_gitlab',
  };
  return keys[code] || 'ws_err_conn_unknown';
}

export function gitImportCloneMessage(code, t) {
  return t(cloneKey(code));
}

export function gitImportPayload() {
  if (gitImport.source === 'address') {
    return {
      name: document.getElementById('git-addr-name')?.value.trim() || '',
      gitUrl: document.getElementById('ws-git-url-input')?.value.trim() || '',
      branch: document.getElementById('ws-branch-input')?.value.trim() || '',
    };
  }
  const project = selectedProject();
  if (!project) return { error: 'project' };
  return {
    name: document.getElementById('git-pick-name')?.value.trim() || gitImport.suggestedName || projectName(project),
    connectionId: gitImport.connectionId,
    projectId: project.id,
    branch: gitImport.branch || project.defaultBranch || '',
  };
}

export function gitImportProgressText(t) {
  if (gitImport.source === 'address') {
    const branch = document.getElementById('ws-branch-input')?.value.trim();
    const name = document.getElementById('git-addr-name')?.value.trim();
    if (name && branch) return t('git_cloning_named', { name, branch });
    return t('ws_cloning');
  }
  const project = selectedProject();
  const name = project ? projectName(project) : '';
  const branch = gitImport.branch || project?.defaultBranch || '';
  if (name && branch) return t('git_cloning_named', { name, branch });
  return t('ws_cloning');
}

export async function handleGitImportAction(action, el, ctx) {
  if (action === 'git-source') {
    gitImport.source = el.getAttribute('data-source') === 'address' ? 'address' : 'pick';
    gitImport.connOpen = false;
    gitImport.branchOpen = false;
    gitImport.loadError = '';
    paint(ctx);
    if (gitImport.source === 'pick') await loadProjects(ctx);
    return true;
  }
  if (action === 'git-conn-toggle') {
    gitImport.connOpen = !gitImport.connOpen;
    gitImport.branchOpen = false;
    paint(ctx);
    return true;
  }
  if (action === 'git-conn-pick') {
    gitImport.connectionId = el.getAttribute('data-conn') || '';
    gitImport.connOpen = false;
    gitImport.projectId = '';
    gitImport.projects = [];
    gitImport.branches = [];
    gitImport.branch = '';
    gitImport.nameTouched = false;
    gitImport.suggestedName = '';
    gitImport.search = '';
    paint(ctx);
    await loadProjects(ctx);
    return true;
  }
  if (action === 'git-project') {
    gitImport.projectId = el.getAttribute('data-project') || '';
    gitImport.branchOpen = false;
    gitImport.nameTouched = false;
    const project = selectedProject();
    gitImport.suggestedName = project ? projectName(project) : '';
    gitImport.branch = project?.defaultBranch || '';
    gitImport.branches = [];
    paint(ctx);
    await loadBranches(ctx);
    return true;
  }
  if (action === 'git-branch-toggle') {
    gitImport.branchOpen = !gitImport.branchOpen;
    gitImport.connOpen = false;
    paint(ctx);
    return true;
  }
  if (action === 'git-branch-pick') {
    gitImport.branch = el.getAttribute('data-branch') || '';
    gitImport.branchOpen = false;
    paint(ctx);
    return true;
  }
  return false;
}

export function onGitImportInput(target, ctx) {
  if (target?.id === 'git-search') {
    gitImport.search = target.value;
    clearTimeout(gitImport.timer);
    gitImport.timer = setTimeout(() => { void loadProjects(ctx); }, 300);
  }
  if (target?.id === 'git-pick-name') {
    gitImport.nameTouched = true;
    gitImport.suggestedName = target.value;
  }
  if (target?.id === 'git-addr-name') gitImport.suggestedName = target.value;
  if (target?.id === 'ws-git-url-input') gitImport.addrUrl = target.value;
  if (target?.id === 'ws-branch-input') gitImport.addrBranch = target.value;
}

export function gitImportSource() {
  return gitImport.source;
}

export function closeGitImportPops(ctx) {
  if (!gitImport.connOpen && !gitImport.branchOpen) return;
  gitImport.connOpen = false;
  gitImport.branchOpen = false;
  paint(ctx);
}
