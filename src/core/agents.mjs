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
 * Derive the conversation's main agent from the persisted role and messages.
 * Extra agents on the conversation are sub-agent instances.
 */
export function buildAgents({ conv, role, roles = [], messages = [] } = {}) {
  const cid = conv?.id || 'conv';
  const byId = new Map((roles || []).filter((r) => r?.id).map((r) => [r.id, r]));
  if (role?.id) byId.set(role.id, { ...(byId.get(role.id) || {}), ...role });

  const roleId = role?.id || conv?.roleId || 'default';
  const { toolCalls, step, lastText } = statsFromMessages(messages);
  let status = mapConvStatusToAgent(conv?.status || 'idle');
  if (!AGENT_STATUSES.has(status)) status = 'waiting';
  return [{
    id: `${cid}:agent:0`,
    roleId,
    name: roleName(roleId, role, byId),
    status,
    step,
    totalSteps: step,
    toolCalls,
    lastText,
  }];
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
