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
 * Derive the conversation's main agent from persisted messages.
 * Extra agents on the conversation are sub-agent instances.
 */
export function buildAgents({ conv, messages = [] } = {}) {
  const cid = conv?.id || 'conv';
  const { toolCalls, step, lastText } = statsFromMessages(messages);
  let status = mapConvStatusToAgent(conv?.status || 'idle');
  if (!AGENT_STATUSES.has(status)) status = 'waiting';
  return [{
    id: `${cid}:agent:0`,
    name: 'Agent',
    status,
    step,
    totalSteps: step,
    toolCalls,
    lastText,
  }];
}

const TERMINAL_STATUSES = new Set(['done', 'stopped', 'failed', 'error']);

function copyOptional(data, agent, key) {
  if (agent[key] !== undefined && agent[key] !== null && agent[key] !== '') data[key] = agent[key];
}

function copyTimestamp(data, agent, key) {
  const value = agent[key];
  if (typeof value === 'number' && Number.isFinite(value)) data[key] = value;
}

export function agentEventData(agent, status = agent?.status) {
  if (!agent) return null;
  const resolved = AGENT_STATUSES.has(status) ? status : agent.status;
  const data = {
    id: agent.id,
    name: agent.name,
    status: resolved,
    step: agent.step,
    totalSteps: agent.totalSteps,
    lastText: agent.lastText || '',
  };
  copyOptional(data, agent, 'brief');
  copyTimestamp(data, agent, 'startedAt');
  copyTimestamp(data, agent, 'lastActivityAt');
  if (TERMINAL_STATUSES.has(resolved)) copyTimestamp(data, agent, 'endedAt');
  else if (resolved === 'running') copyOptional(data, agent, 'currentAction');
  return data;
}
