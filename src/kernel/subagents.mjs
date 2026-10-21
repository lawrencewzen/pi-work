// Foreground and background subagents, as in Pi Durable examples 22 and 23.
// Ownership, abort, and restart reuse belong to the Harness. This module
// configures a child from a role template and reads what the tools already
// committed: details, the ownership index, and the background name document.
import { Type } from '@earendil-works/pi-ai';
import {
  AssistantEntry,
  configure,
  defineDoc,
  defineExtension,
  defineTask,
  defineTool,
  LiveDoc,
  section,
} from '@earendil-works/pi-durable';
import { agentEventData } from '../core/agents.mjs';
import { textOf } from './events.mjs';

// Example 23: the main conversation maps background names to child conversations.
export const Subagents = defineDoc({
  kind: 'app.pi-work.subagents',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  checkpointWhen: () => false,
  initial: () => ({ agents: {}, reporters: {} }),
});

const Anchor = defineTask({
  name: 'app.pi-work.subagent-anchor',
  version: 1,
  initial: () => ({ phase: 'done' }),
  phases: {
    done: (_task, runtime, taskContext) => runtime.commit(
      () => ({ status: 'terminal', outcome: { status: 'completed', result: null } }),
      taskContext,
    ),
  },
  abort: (_task, runtime, taskContext) => runtime.commit(
    () => ({ status: 'terminal', outcome: { status: 'aborted' } }),
    taskContext,
  ),
});

const Reporter = defineTask({
  name: 'app.pi-work.subagent-reporter',
  version: 1,
  initial: () => ({ phase: 'deliver' }),
  phases: {
    deliver: async (reporter, runtime, taskContext) => {
      const { name, conversationId, message, followUp } = reporter.input;
      const subagent = await runtime.conversation(conversationId, taskContext);
      if (!subagent) throw new Error(`missing subagent conversation ${conversationId}`);
      const request = { type: 'input', content: message, whenBusy: followUp ? 'followUp' : 'steer' };
      const submission = await subagent.submit({ ...request, requestId: `subagent:${reporter.id}` }, taskContext);
      const settled = await submission.wait(taskContext);
      await runtime.commit(async (tx) => {
        const next = (report) => ({
          status: 'running',
          checkpoint: { phase: 'report', ...(report === undefined ? {} : { report }) },
        });
        if (settled.status === 'unanswered') {
          return next(settled.reason === 'aborted' ? undefined : `[subagent ${name} failed: ${settled.reason}]`);
        }
        if (settled.type !== 'input') return next();
        const agent = (await tx.doc(Subagents, runtime.conversationId)).agents[name];
        if (!agent || agent.reported.includes(settled.answer)) return next();
        agent.reported.push(settled.answer);
        const answer = (await tx.entry(AssistantEntry, settled.answer))?.model?.[0];
        return next(`[subagent ${name} answered, no reply needed] ${messageText(answer)}`);
      }, taskContext);
    },
    report: async (reporter, runtime, taskContext) => {
      const report = reporter.state.checkpoint.report;
      if (report !== undefined) {
        const main = await runtime.conversation(runtime.conversationId, taskContext);
        if (!main) throw new Error('missing parent conversation');
        await main.submit({
          type: 'input',
          content: report,
          whenBusy: 'followUp',
          requestId: `subagent-report:${reporter.id}`,
        }, taskContext);
      }
      await runtime.commit(
        () => ({ status: 'terminal', outcome: { status: 'completed', result: null } }),
        taskContext,
      );
    },
  },
  abort: (_reporter, runtime, taskContext) => runtime.commit(
    () => ({ status: 'terminal', outcome: { status: 'aborted' } }),
    taskContext,
  ),
});

function messageText(message) {
  if (!message) return '';
  if (typeof message === 'string' || Array.isArray(message)) return textOf(message);
  return textOf(message.content);
}

function reply(text, extra = {}) {
  return {
    output: [{ type: 'text', text }],
    ...(extra.details ? { details: extra.details } : {}),
    ...(extra.isError ? { isError: true } : {}),
  };
}

function matchRole(roles, agent) {
  const key = String(agent || '').trim();
  if (!key) return null;
  return roles.find((role) => role?.id === key) || roles.find((role) => role?.name === key) || null;
}

function roleLines(roles) {
  const lines = [];
  for (const role of roles || []) {
    if (!role?.id) continue;
    const description = String(role.description || '').replace(/\s+/g, ' ').trim();
    lines.push(`- ${role.id} (${role.name || role.id}): ${description}`);
  }
  return lines;
}

function delegateDescription(roles) {
  const lines = [
    'Run a task on a foreground subagent and return its answer.',
    '`agent` is a role id. Each line is id (name): when to use it.',
    ...roleLines(roles),
  ];
  return lines.join('\n');
}

async function assistantText(api, entryId, context) {
  const entry = await api.commit((tx) => tx.entry(AssistantEntry, entryId), context);
  return messageText(entry?.model?.[0]);
}

async function latestAssistantText(api, conversationId, context) {
  const page = await api.commit(
    (tx) => tx.scanEntries({ conversationId, order: 'descending' }, 40),
    context,
  );
  for (const entry of page.items) {
    const message = entry.model?.[0];
    if (message?.role === 'assistant') {
      const text = messageText(message);
      if (text) return text;
    }
  }
  return '';
}

/**
 * Dispatch tools for the main agent. A child is configured with this extension
 * removed, so it cannot delegate or spawn. `prepareChild` supplies the role's
 * model, tool whitelist, and prompt.
 */
export function createSubagentExtension({
  listRoles,
  prepareChild,
  onChild,
} = {}) {
  if (typeof listRoles !== 'function') throw new Error('listRoles is required');
  if (typeof prepareChild !== 'function') throw new Error('prepareChild is required');
  const blocked = [];
  let rolesSnapshot = [];

  const delegate = defineTool({
    name: 'delegate',
    get description() {
      return delegateDescription(rolesSnapshot);
    },
    parameters: Type.Object({
      agent: Type.String(),
      task: Type.String(),
    }),
    replay: 'safe',
    execute: async (args, api, context) => {
      const role = matchRole(await listRoles(), args.agent);
      if (!role) return reply(`unknown agent ${args.agent || ''}`, { isError: true });
      const parent = await api.agent(context);
      const prepared = await prepareChild(role, parent);
      if (prepared?.error) return reply(prepared.error, { isError: true });
      const child = await api.commit(async (tx) => {
        const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
        if (existing) return existing.id;
        const created = await tx.createConversation({ ownership: { kind: 'task', taskId: api.taskId } });
        await configure(tx, created.id, {
          ...prepared.change,
          extensions: { remove: blocked },
        });
        return created.id;
      }, context);
      const details = { conversationId: child, roleId: role.id, name: role.name || role.id };
      await api.details(details, context);
      if (typeof onChild === 'function') onChild(api.conversationId, child, role.id);
      const handle = await api.conversation(child, context);
      if (!handle) return reply('subagent conversation disappeared', { isError: true });
      const settled = await (await handle.submit({
        type: 'input',
        content: args.task,
        requestId: `subagent:${api.taskId}`,
      }, context)).wait(context);
      if (context.abortSignal?.aborted || settled.reason === 'aborted') {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }
      if (settled.status !== 'done' || settled.type !== 'input') {
        return reply(`subagent ${settled.status} ${settled.reason || ''}`, { isError: true });
      }
      const text = await assistantText(api, settled.answer, context);
      return reply(text, { details: { conversationId: child, roleId: role.id } });
    },
  });

  const subagent = defineTool({
    name: 'subagent',
    description: 'Background subagents from a role template: spawn, send, wait, stop, list. `agent` on spawn is a role id. Answers are reported back to this conversation.',
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal('spawn'),
        Type.Literal('send'),
        Type.Literal('wait'),
        Type.Literal('stop'),
        Type.Literal('list'),
      ]),
      name: Type.Optional(Type.String()),
      message: Type.Optional(Type.String()),
      agent: Type.Optional(Type.String()),
      followUp: Type.Optional(Type.Boolean()),
    }),
    replay: 'unsafe',
    execute: async (args, api, context) => {
      const { action, name, message, followUp } = args;
      const snapshot = await api.snapshot(Subagents, api.conversationId, context);
      const registry = snapshot ?? { agents: {}, reporters: {} };

      if (action === 'list') {
        const names = name === undefined ? Object.keys(registry.agents) : [name];
        const lines = [];
        for (const each of names) {
          const found = Object.hasOwn(registry.agents, each) ? registry.agents[each] : undefined;
          if (!found) continue;
          const busy = (await api.snapshot(LiveDoc, found.conversationId, context))?.run !== undefined;
          lines.push(`${each}: ${busy ? 'working' : 'idle'} role=${found.roleId || ''}`);
        }
        return reply(lines.length === 0 ? 'No subagents.' : lines.join('\n'));
      }
      if (!name) return reply(`${action} needs a name.`, { isError: true });
      const agent = Object.hasOwn(registry.agents, name) ? registry.agents[name] : undefined;
      if (action !== 'spawn' && !agent) return reply(`No subagent named ${name}.`, { isError: true });

      if (action === 'stop') {
        const handle = await api.conversation(agent.conversationId, context);
        if (!handle) return reply(`No conversation for ${name}.`, { isError: true });
        await handle.abort(context);
        return reply(`Stopped ${name}.`, { details: { name, conversationId: agent.conversationId } });
      }
      if (action === 'wait') {
        const handle = await api.conversation(agent.conversationId, context);
        if (!handle) return reply(`No conversation for ${name}.`, { isError: true });
        await handle.waitForIdle(context);
        const text = await latestAssistantText(api, agent.conversationId, context);
        return reply(text || '(no answer)', { details: { name, conversationId: agent.conversationId } });
      }
      if (message === undefined) return reply(`${action} needs a message.`, { isError: true });

      if (action === 'spawn') {
        const role = matchRole(await listRoles(), args.agent || '');
        if (!role) return reply(`unknown agent ${args.agent || ''}`, { isError: true });
        const parent = await api.agent(context);
        const prepared = await prepareChild(role, parent);
        if (prepared?.error) return reply(prepared.error, { isError: true });
        const result = await api.commit(async (tx) => {
          const state = await tx.doc(Subagents, api.conversationId);
          if (Object.hasOwn(state.agents, name)) return { error: `${name} already exists; use send.` };
          const background = { ownership: { kind: 'conversation' }, background: true };
          const anchor = await tx.createTask(Anchor, null, background);
          const child = await tx.createConversation({ ownership: { kind: 'task', taskId: anchor } });
          await configure(tx, child.id, {
            ...prepared.change,
            extensions: { remove: blocked },
          });
          state.agents[name] = { conversationId: child.id, reported: [], roleId: role.id };
          const input = { name, conversationId: child.id, message, followUp: false };
          state.reporters[api.taskId] = await tx.createTask(Reporter, input, background);
          return { conversationId: child.id, text: `Started ${name}.`, roleId: role.id };
        }, context);
        if (result.error) return reply(result.error, { isError: true });
        await api.details({
          name,
          conversationId: result.conversationId,
          roleId: result.roleId,
        }, context);
        if (typeof onChild === 'function') onChild(api.conversationId, result.conversationId, result.roleId);
        return reply(result.text, { details: { name, conversationId: result.conversationId } });
      }

      const result = await api.commit(async (tx) => {
        const state = await tx.doc(Subagents, api.conversationId);
        const current = state.agents[name];
        if (!current) return { error: `No subagent named ${name}.` };
        const background = { ownership: { kind: 'conversation' }, background: true };
        const input = {
          name,
          conversationId: current.conversationId,
          message,
          followUp: followUp === true,
        };
        state.reporters[api.taskId] = await tx.createTask(Reporter, input, background);
        return { conversationId: current.conversationId, text: `Sent to ${name}.` };
      }, context);
      if (result.error) return reply(result.error, { isError: true });
      await api.details({ name, conversationId: result.conversationId }, context);
      return reply(result.text, { details: { name, conversationId: result.conversationId } });
    },
  });

  const extension = defineExtension({
    name: 'pi-work-subagents',
    tasks: [Anchor, Reporter],
    tools: [delegate, subagent],
    sections: [
      section('subagents', async () => {
        try {
          rolesSnapshot = await listRoles();
          const lines = ['Pick a subagent by id. Each line is id (name): when to use it.', ...roleLines(rolesSnapshot)];
          return lines.join('\n');
        } catch (err) {
          console.error(`PI_WORK_KERNEL_SUBAGENT ${err instanceof Error ? err.message : err}`);
          return undefined;
        }
      }),
    ],
  });
  blocked.push(extension);
  return extension;
}

function statsOf(messages) {
  let toolCalls = 0;
  let step = 0;
  let lastText = '';
  for (const message of messages || []) {
    if (message?.role === 'assistant') {
      step += 1;
      if (message.text) lastText = String(message.text);
    } else if (message?.role === 'tool' || message?.tool) {
      step += 1;
      toolCalls += 1;
    }
  }
  return { toolCalls, step, totalSteps: step, lastText };
}

function childStatus(busy, aborted, lastText) {
  if (busy) return 'running';
  if (aborted) return 'stopped';
  if (lastText) return 'done';
  return 'waiting';
}

function takeChild(meta, order, id, patch) {
  if (id == null) return;
  const key = Number(id);
  if (!meta.has(key)) order.push(key);
  const prev = meta.get(key) || {};
  meta.set(key, {
    conversationId: id,
    mode: patch.mode || prev.mode || 'foreground',
    roleId: patch.roleId || prev.roleId || '',
    name: patch.name || prev.name || '',
  });
}

function toolChild(details, mode) {
  if (details?.conversationId == null || !mode) return null;
  return { conversationId: details.conversationId, mode, roleId: details.roleId, name: details.name };
}

/** Read subagents from tool details, the background name document, ownership, and child viewState. */
export function createSubagentHost({
  store,
  harness,
  context,
  readTranscript,
  emit,
  watchEvents,
  resolveModel,
  collectTools,
  cidFor,
} = {}) {
  if (!store) throw new Error('store is required');
  if (!harness) throw new Error('harness is required');
  if (!context) throw new Error('context is required');
  if (typeof readTranscript !== 'function') throw new Error('readTranscript is required');
  const roleIds = new Map();
  const childWatches = new Map();
  const lastAgent = new Map();
  let closed = false;

  function remember(childId, roleId) {
    if (childId == null || !roleId) return;
    roleIds.set(Number(childId), roleId);
  }

  async function roleFor(harnessId) {
    const roleId = roleIds.get(Number(harnessId));
    if (!roleId) return null;
    return (await store.getRole(roleId)) || { id: roleId, name: roleId, systemPrompt: '', tools: [] };
  }

  async function prepareChild(role, parentAgent) {
    const tools = typeof collectTools === 'function' ? await collectTools(role, { dispatch: false }) : [];
    let model;
    if (typeof resolveModel === 'function') model = await resolveModel(role);
    const change = { tools, instructions: String(role?.systemPrompt || '') };
    if (parentAgent?.cwd) change.cwd = parentAgent.cwd;
    if (model !== undefined) change.model = model;
    return { change };
  }

  async function listSubagents(conv) {
    if (!conv?.id || conv.harnessId == null) return [];
    const meta = new Map();
    const order = [];
    const parent = await readTranscript(conv.harnessId);
    for (const entry of parent.entries || []) {
      const result = entry?.model?.[0];
      const mode = result?.toolName === 'subagent' ? 'background' : result?.toolName === 'delegate' ? 'foreground' : null;
      const found = toolChild(result?.details, mode);
      if (found) takeChild(meta, order, found.conversationId, found);
    }
    const live = await harness.snapshot(LiveDoc, conv.harnessId, context);
    for (const slot of live?.tools || []) {
      const found = toolChild(slot.details, slot.name === 'subagent' ? 'background' : 'foreground');
      if (found) takeChild(meta, order, found.conversationId, found);
    }
    const roster = await harness.snapshot(Subagents, conv.harnessId, context);
    for (const [name, entry] of Object.entries(roster?.agents || {})) {
      if (entry?.conversationId) takeChild(meta, order, entry.conversationId, { mode: 'background', roleId: entry.roleId, name });
    }
    const graph = await harness.taskGraph(context);
    try {
      for (const node of Object.values(graph.value?.tasks || {})) {
        if (Number(node.conversationId) !== Number(conv.harnessId)) continue;
        for (const id of node.conversations || []) takeChild(meta, order, id, {});
      }
    } finally {
      graph.dispose();
    }
    const generations = order.length === 0 ? new Map() : await harness.commit(async (tx) => {
      const found = new Map();
      for (const key of order) {
        const id = meta.get(key)?.conversationId;
        const page = await tx.scanTasks({ conversationId: id, kind: 'pi.generation', order: 'descending' }, 1);
        found.set(key, page.items[0]);
      }
      return found;
    }, context);
    const roles = await store.listRoles();
    const byId = new Map(roles.filter((role) => role?.id).map((role) => [role.id, role]));
    const out = [];
    for (const key of order) {
      const entry = meta.get(key);
      if (!entry?.conversationId) continue;
      remember(entry.conversationId, entry.roleId);
      const childLive = await harness.snapshot(LiveDoc, entry.conversationId, context);
      const stats = statsOf((await readTranscript(entry.conversationId)).messages);
      const aborted = generations.get(key)?.state?.outcome?.status === 'aborted';
      const role = byId.get(entry.roleId);
      const name = entry.mode === 'background'
        ? (entry.name || role?.name || entry.roleId || String(entry.conversationId))
        : (role?.name || entry.name || entry.roleId || String(entry.conversationId));
      out.push({
        id: `${conv.id}:sub:${entry.conversationId}`,
        roleId: entry.roleId || role?.id || '',
        name,
        status: childStatus(Boolean(childLive?.run), aborted, stats.lastText),
        step: stats.step,
        totalSteps: stats.totalSteps,
        toolCalls: stats.toolCalls,
        lastText: stats.lastText,
        mode: entry.mode === 'background' ? 'background' : 'foreground',
        harnessId: entry.conversationId,
      });
    }
    return out;
  }

  async function emitAgent(cid, agent) {
    if (typeof emit !== 'function' || !agent) return;
    const data = agentEventData(agent);
    if (!data) return;
    data.mode = agent.mode === 'background' ? 'background' : 'foreground';
    const key = JSON.stringify(data);
    if (lastAgent.get(data.id) === key) return;
    lastAgent.set(data.id, key);
    await emit(cid, 'agent', data);
  }

  async function publish(parentCid, childId) {
    const conv = await store.getConversation(parentCid);
    if (!conv) return;
    const agents = await listSubagents(conv);
    const agent = agents.find((item) => item.harnessId === childId || item.id.endsWith(`:sub:${childId}`));
    if (agent) await emitAgent(parentCid, agent);
  }

  async function attach(parentCid, childId) {
    if (closed || childId == null || childWatches.has(childId) || typeof watchEvents !== 'function') return;
    const stream = await watchEvents(harness, childId, context);
    childWatches.set(childId, stream);
    const run = () => publish(parentCid, childId).catch((err) => {
      console.error(`PI_WORK_KERNEL_SUBAGENT ${err instanceof Error ? err.message : err}`);
    });
    await run();
    stream.start(() => run());
  }

  function onChild(parentHarnessId, childId, roleId) {
    remember(childId, roleId);
    const parentCid = typeof cidFor === 'function' ? cidFor(parentHarnessId) : null;
    if (!parentCid) return;
    setImmediate(() => {
      attach(parentCid, childId).catch((err) => {
        console.error(`PI_WORK_KERNEL_SUBAGENT ${err instanceof Error ? err.message : err}`);
      });
    });
  }

  return {
    prepareChild,
    onChild,
    roleFor,
    listSubagents,
    async seed(rows) {
      for (const row of rows || []) {
        if (!row?.harnessId) continue;
        const agents = await listSubagents(row);
        for (const agent of agents) {
          remember(agent.harnessId, agent.roleId);
          if (row.id) await attach(row.id, agent.harnessId);
        }
      }
    },
    async childMessages(cid, agentId) {
      const conv = await store.getConversation(cid);
      if (!conv) return { status: 404, body: { error: 'conversation not found' } };
      const agents = await listSubagents(conv);
      const agent = agents.find((item) => item.id === agentId);
      if (!agent) return { status: 404, body: { error: 'agent not found' } };
      const transcript = await readTranscript(agent.harnessId);
      return {
        status: 200,
        body: {
          id: agent.id,
          roleId: agent.roleId,
          name: agent.name,
          status: agent.status,
          mode: agent.mode === 'background' ? 'background' : 'foreground',
          messages: transcript.messages,
        },
      };
    },
    async stopConversation(cid) {
      const conv = await store.getConversation(cid);
      if (!conv) return { status: 404, body: { error: 'conversation not found' } };
      if (conv.harnessId != null) {
        const conversation = await harness.conversation(conv.harnessId, context);
        if (conversation) await conversation.abort(context, { background: true });
      }
      if (typeof emit === 'function') await emit(cid, 'status', { status: 'stopped' });
      const fresh = await store.getConversation(cid);
      for (const agent of await listSubagents(fresh)) await emitAgent(cid, agent);
      return { status: 200, body: { status: 'stopped' } };
    },
    async close() {
      closed = true;
      for (const stream of childWatches.values()) {
        try { await stream.stop(); } catch { /* already stopped */ }
      }
      childWatches.clear();
    },
  };
}
