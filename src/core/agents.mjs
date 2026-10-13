const AGENT_STATUSES = new Set(['waiting', 'running', 'done', 'error', 'stopped']);

export function mapConvStatusToAgent(status) {
  switch (status) {
    case 'running':
    case 'recovering':
      return 'running';
    case 'failed':
      return 'error';
    case 'stopped':
      return 'stopped';
    case 'done':
      return 'done';
    default:
      return 'waiting';
  }
}

function roleName(roleId, role, byId) {
  if (role?.id === roleId && role.name) return role.name;
  const found = byId.get(roleId);
  if (found?.name) return found.name;
  if (roleId === 'default') return 'Default';
  return roleId || 'Agent';
}

function groupMessagesByAgent(messages, n) {
  const groups = Array.from({ length: n }, () => []);
  let idx = 0;
  for (const m of messages || []) {
    if (m?.role === 'user' && typeof m.id === 'string') {
      const match = m.id.match(/:u:p(\d+)$/);
      if (match) {
        const next = Number(match[1]);
        if (Number.isInteger(next) && next >= 0 && next < n) idx = next;
      }
    }
    if (idx < n) groups[idx].push(m);
  }
  return groups;
}

function statsFromMessages(msgs) {
  let toolCalls = 0;
  let step = 0;
  let lastText = '';
  for (const m of msgs || []) {
    if (m.role === 'assistant') {
      step += 1;
      if (m.text) lastText = String(m.text);
    } else if (m.role === 'tool' || m.tool) {
      step += 1;
      toolCalls += 1;
    }
  }
  return { toolCalls, step, lastText };
}

/**
 * Derive the conversation's agents from persisted conversation / pipeline / messages.
 * No pipeline → a single default/role agent. Pipeline steps become one agent each.
 */
export function buildAgents({ conv, pipeline, role, roles = [], messages = [] } = {}) {
  const cid = conv?.id || 'conv';
  const byId = new Map((roles || []).filter((r) => r?.id).map((r) => [r.id, r]));
  if (role?.id) byId.set(role.id, { ...(byId.get(role.id) || {}), ...role });

  const pipeSteps = Array.isArray(pipeline?.steps) ? pipeline.steps : [];
  const fallbackRoleId = role?.id || conv?.roleId || 'default';
  const steps = pipeSteps.length ? pipeSteps : [{ role: fallbackRoleId }];
  const current = pipeSteps.length ? (Number(conv?.pipelineStep) || 0) : 0;
  const groups = groupMessagesByAgent(messages, steps.length);
  const convStatus = conv?.status || 'idle';

  return steps.map((s, i) => {
    const roleId = s?.role || fallbackRoleId;
    const { toolCalls, step, lastText } = statsFromMessages(groups[i]);
    let status;
    if (i < current) status = 'done';
    else if (i > current) status = 'waiting';
    else status = mapConvStatusToAgent(convStatus);
    if (!AGENT_STATUSES.has(status)) status = 'waiting';
    const totalSteps = step;
    return {
      id: `${cid}:agent:${i}`,
      roleId,
      name: roleName(roleId, role, byId),
      status,
      step,
      totalSteps,
      toolCalls,
      lastText,
    };
  });
}

export function agentEventData(agent, status = agent?.status) {
  if (!agent) return null;
  return {
    id: agent.id,
    roleId: agent.roleId,
    name: agent.name,
    status: AGENT_STATUSES.has(status) ? status : agent.status,
    step: agent.step,
    totalSteps: agent.totalSteps,
    lastText: agent.lastText || '',
  };
}
