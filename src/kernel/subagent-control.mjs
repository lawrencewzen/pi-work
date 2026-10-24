// Host-side send/stop for one Pi Durable sub-conversation.
// Does not spawn, list, or schedule children; those stay in subagents.mjs.
import { randomUUID } from 'node:crypto';
import { agentEventData } from '../core/agents.mjs';
import { USER_TO_SUBAGENT_KIND } from './ids.mjs';

export { USER_TO_SUBAGENT_KIND };

export function parentNoteText(name, text) {
  return `你对 ${name} 说：${text}`;
}

export function parentModelText(name, text) {
  return `[用户对子 Agent ${name} 说] ${text}`;
}

function childHarnessId(agent) {
  if (agent?.harnessId != null) return agent.harnessId;
  const id = String(agent?.id || '');
  const at = id.lastIndexOf(':sub:');
  if (at < 0) return null;
  const raw = id.slice(at + 5);
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : raw;
}

export function createSubagentControl({
  store,
  harness,
  context,
  listSubagents,
  emit,
} = {}) {
  if (!store) throw new Error('store is required');
  if (!harness) throw new Error('harness is required');
  if (!context) throw new Error('context is required');
  if (typeof listSubagents !== 'function') throw new Error('listSubagents is required');

  async function findAgent(cid, aid) {
    const conv = await store.getConversation(cid);
    if (!conv) return { status: 404, body: { error: 'conversation not found' } };
    const agents = await listSubagents(conv);
    const agent = agents.find((item) => item.id === aid);
    if (!agent) return { status: 404, body: { error: 'agent not found' } };
    return { conv, agent };
  }

  async function emitStopped(cid, agent) {
    if (typeof emit !== 'function' || !agent) return;
    const data = agentEventData({ ...agent, status: 'stopped' }, 'stopped');
    if (!data) return;
    data.mode = agent.mode === 'background' ? 'background' : 'foreground';
    await emit(cid, 'agent', data);
  }

  return {
    async sendToAgent(cid, aid, text) {
      const trimmed = typeof text === 'string' ? text.trim() : '';
      if (!trimmed) return { status: 400, body: { error: 'text required' } };
      const found = await findAgent(cid, aid);
      if (found.status) return found;
      const { conv, agent } = found;
      if (agent.status !== 'running') return { status: 409, body: { error: 'agent not running' } };
      const childId = childHarnessId(agent);
      const child = childId != null ? await harness.conversation(childId, context) : null;
      if (!child) return { status: 404, body: { error: 'agent not found' } };
      await child.submit({
        type: 'input',
        content: trimmed,
        whenBusy: 'steer',
        requestId: randomUUID(),
      }, context);
      const parent = conv.harnessId != null ? await harness.conversation(conv.harnessId, context) : null;
      if (parent) {
        await parent.submit({
          type: 'write',
          entry: {
            kind: USER_TO_SUBAGENT_KIND,
            data: { agentId: agent.id, name: agent.name, text: trimmed },
            model: [{ role: 'user', content: parentModelText(agent.name, trimmed) }],
          },
        }, context);
      }
      return { status: 200, body: { ok: true } };
    },

    async stopAgent(cid, aid) {
      const found = await findAgent(cid, aid);
      if (found.status) return found;
      const { agent } = found;
      const childId = childHarnessId(agent);
      const child = childId != null ? await harness.conversation(childId, context) : null;
      if (child) await child.abort(context, { background: true });
      const conv = await store.getConversation(cid);
      const agents = conv ? await listSubagents(conv) : [];
      const updated = agents.find((item) => item.id === aid) || { ...agent, status: 'stopped' };
      await emitStopped(cid, updated);
      return { status: 200, body: { status: 'stopped' } };
    },
  };
}
