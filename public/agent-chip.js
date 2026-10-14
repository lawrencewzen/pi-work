// Composer dispatch chip. Model ids come only from the role, settings, or the
// signed-in session default the server actually uses. Nothing here invents one.

function trimmed(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

/**
 * Same order as the server model lookup: role.model, settings for that role,
 * settings.default, env model, then the session model (grok-build when signed in).
 */
export function resolveDispatchModel({ role, roleId, models, envModel, sessionModel } = {}) {
  const map = models && typeof models === 'object' && !Array.isArray(models) ? models : {};
  const roleModel = trimmed(role?.model);
  if (roleModel) return roleModel;
  const rid = trimmed(roleId);
  if (rid && trimmed(map[rid])) return trimmed(map[rid]);
  if (trimmed(map.default)) return trimmed(map.default);
  if (trimmed(envModel)) return trimmed(envModel);
  if (trimmed(sessionModel)) return trimmed(sessionModel);
  return '';
}

/** Role that the next (or current pipeline) step will dispatch. */
export function activeDispatchTarget({ conv, roles, pipelines } = {}) {
  const list = Array.isArray(roles) ? roles : [];
  if (!conv) return { roleId: '', pipelineId: '', role: null };
  let roleId = trimmed(conv.roleId);
  const pipelineId = trimmed(conv.pipelineId);
  if (pipelineId) {
    const pipe = (Array.isArray(pipelines) ? pipelines : []).find((p) => p && p.id === pipelineId);
    const idx = Number(conv.pipelineStep) || 0;
    const step = pipe?.steps?.[idx] || pipe?.steps?.[0];
    if (step?.role) roleId = String(step.role);
  }
  const role = list.find((r) => r && r.id === roleId) || null;
  return { roleId, pipelineId, role };
}

/** Visible chip text: `编码 · grok-build`, or `Agent · grok-build` for the default role. */
export function composerAgentText({ agentName = 'Agent', model = '', roleLabel = '' } = {}) {
  const name = trimmed(agentName) || 'Agent';
  const id = trimmed(model);
  const role = trimmed(roleLabel);
  const head = role && role !== name ? role : name;
  if (id) return `${head} · ${id}`;
  if (role && role !== name) return `${name} · ${role}`;
  return name;
}

export function composerAgentPresentation({
  conv,
  roles,
  pipelines,
  models,
  agentName = 'Agent',
  roleLabel = '',
  envModel = '',
  sessionModel = '',
} = {}) {
  const target = activeDispatchTarget({ conv, roles, pipelines });
  const model = resolveDispatchModel({
    role: target.role,
    roleId: target.roleId,
    models,
    envModel,
    sessionModel,
  });
  return {
    text: composerAgentText({ agentName, model, roleLabel }),
    model,
    roleId: target.roleId,
    pipelineId: target.pipelineId,
  };
}
