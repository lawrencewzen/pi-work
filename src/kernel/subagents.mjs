// Foreground and background subagents on one Pi Durable conversation.
// The Harness owns the child conversation, its submission, and the background
// reporter. This module only configures a child from a role template and reads
// the roster the tools already commit. It does not schedule, retry, or checkpoint.
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

export const Roster = defineDoc({
  kind: 'app.pi-work.subagents',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
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
        const state = await tx.doc(Roster, runtime.conversationId);
        const agent = state.agents[name];
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

/** Default 4. A positive integer in PI_WORK_MAX_SUBAGENTS overrides it. Anything else stays at 4. */
export function maxSubagents(env = process.env) {
  const raw = String(env?.PI_WORK_MAX_SUBAGENTS ?? '').trim();
  if (!raw) return 4;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) return 4;
  return value;
}

function messageText(message) {
  if (!message) return '';
  if (typeof message === 'string' || Array.isArray(message)) return textOf(message);
  return textOf(message.content);
}

function reply(text, extra = {}) {
  return {
    content: [{ type: 'text', text }],
    ...(extra.details ? { details: extra.details } : {}),
    ...(extra.isError ? { isError: true } : {}),
  };
}

function occupies(agent) {
  return Boolean(agent) && !agent.stopped && !agent.finished;
}

function matchRole(roles, agent) {
  const key = String(agent || '').trim();
  if (!key) return null;
  return roles.find((role) => role?.id === key) || roles.find((role) => role?.name === key) || null;
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

function rosterLines(roles) {
  const lines = ['Pick a subagent by id. Each line is id (name): when to use it.'];
  for (const role of roles || []) {
    if (!role?.id) continue;
    const description = String(role.description || '').replace(/\s+/g, ' ').trim();
    lines.push(`- ${role.id} (${role.name || role.id}): ${description}`);
  }
  return lines.join('\n');
}

/**
 * Dispatch tools for the main agent. A child is configured with this extension
 * removed, so it cannot delegate or spawn. `prepareChild` supplies the role's
 * model, tool whitelist, and prompt. `maxConcurrent` is read inside the creating
 * commit, counting roster entries that are not stopped and not finished.
 */
export function createSubagentExtension({
  listRoles,
  prepareChild,
  maxConcurrent,
  onChild,
} = {}) {
  if (typeof listRoles !== 'function') throw new Error('listRoles is required');
  if (typeof prepareChild !== 'function') throw new Error('prepareChild is required');
  if (typeof maxConcurrent !== 'function') throw new Error('maxConcurrent is required');
  const blocked = [];

  const delegate = defineTool({
    name: 'delegate',
    description: 'Run a task on a foreground subagent and return its answer. `agent` is a role id from the subagents section.',
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
      const key = `fg:${api.taskId}`;
      const created = await api.commit(async (tx) => {
        const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
        const state = await tx.doc(Roster, api.conversationId);
        if (existing) return { id: existing.id };
        const limit = maxConcurrent();
        const live = Object.values(state.agents).filter(occupies).length;
        if (live >= limit) return { refused: limit };
        const child = await tx.createConversation({ ownership: { kind: 'task', taskId: api.taskId } });
        await configure(tx, child.id, {
          ...prepared.change,
          extensions: { remove: blocked },
        });
        state.agents[key] = {
          conversationId: child.id,
          mode: 'foreground',
          roleId: role.id,
          name: role.name || role.id,
          reported: [],
          stopped: false,
          finished: false,
        };
        return { id: child.id };
      }, context);
      if (created.refused !== undefined) return reply(`limit ${created.refused}`, { isError: true });
      await api.details({ conversationId: created.id, roleId: role.id, name: role.name || role.id }, context);
      if (typeof onChild === 'function') onChild(api.conversationId, created.id, role.id);
      const handle = await api.conversation(created.id, context);
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
      const finish = () => api.commit(async (tx) => {
        const state = await tx.doc(Roster, api.conversationId);
        const agent = state.agents[key];
        if (!agent || agent.stopped) return;
        agent.finished = true;
      }, context);
      if (settled.status !== 'done' || settled.type !== 'input') {
        await finish();
        return reply(`subagent ${settled.status} ${settled.reason || ''}`, { isError: true });
      }
      const text = await assistantText(api, settled.answer, context);
      await finish();
      return reply(text, { details: { conversationId: created.id, roleId: role.id } });
    },
  });

  const subagent = defineTool({
    name: 'subagent',
    description: 'Background subagents from a role template: spawn, send, wait, stop, list. `agent` on spawn is a role id from the subagents section. Answers are reported back to this conversation.',
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
      const snapshot = await api.snapshot(Roster, api.conversationId, context);
      const registry = snapshot ?? { agents: {}, reporters: {} };

      if (action === 'list') {
        const names = name === undefined ? Object.keys(registry.agents) : [name];
        const lines = [];
        for (const each of names) {
          const found = Object.hasOwn(registry.agents, each) ? registry.agents[each] : undefined;
          if (!found) continue;
          if (found.stopped) {
            lines.push(`${each}: stopped role=${found.roleId || ''}`);
            continue;
          }
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
        await api.commit(async (tx) => {
          const state = await tx.doc(Roster, api.conversationId);
          if (state.agents[name]) state.agents[name].stopped = true;
        }, context);
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
          const state = await tx.doc(Roster, api.conversationId);
          if (Object.hasOwn(state.agents, name)) return { error: `${name} already exists; use send.` };
          const limit = maxConcurrent();
          const live = Object.values(state.agents).filter(occupies).length;
          if (live >= limit) return { error: `limit ${limit}` };
          const background = { ownership: { kind: 'conversation' }, background: true };
          const anchor = await tx.createTask(Anchor, null, background);
          const child = await tx.createConversation({ ownership: { kind: 'task', taskId: anchor } });
          await configure(tx, child.id, {
            ...prepared.change,
            extensions: { remove: blocked },
          });
          state.agents[name] = {
            conversationId: child.id,
            mode: 'background',
            roleId: role.id,
            name: role.name || role.id,
            reported: [],
            stopped: false,
            finished: false,
          };
          const input = { name, conversationId: child.id, message, followUp: false };
          state.reporters[api.taskId] = await tx.createTask(Reporter, input, background);
          return { conversationId: child.id, text: `Started ${name}.` };
        }, context);
        if (result.error) return reply(result.error, { isError: true });
        await api.details({ name, conversationId: result.conversationId, roleId: role.id }, context);
        if (typeof onChild === 'function') onChild(api.conversationId, result.conversationId, role.id);
        return reply(result.text, { details: { name, conversationId: result.conversationId } });
      }

      const result = await api.commit(async (tx) => {
        const state = await tx.doc(Roster, api.conversationId);
        const current = state.agents[name];
        if (!current) return { error: `No subagent named ${name}.` };
        if (current.stopped) return { error: `${name} is stopped.` };
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
          return rosterLines(await listRoles());
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

function presentStatus(entry, busy, lastText) {
  if (entry?.stopped) return 'stopped';
  if (busy) return 'running';
  if (entry?.finished) return 'done';
  if (lastText) return 'done';
  return 'waiting';
}

/**
 * Read the roster for HTTP and for parent `agent` SSE events.
 * Child transcript events stay on the child conversation.
 */
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
    roleIds.set(childId, roleId);
  }

  async function roleFor(harnessId) {
    const roleId = roleIds.get(harnessId);
    if (!roleId) return null;
    return (await store.getRole(roleId)) || { id: roleId, name: roleId, systemPrompt: '', tools: [] };
  }

  async function prepareChild(role, parentAgent) {
    const tools = typeof collectTools === 'function'
      ? await collectTools(role, { dispatch: false })
      : [];
    let model;
    if (typeof resolveModel === 'function') model = await resolveModel(role);
    const change = {
      tools,
      instructions: String(role?.systemPrompt || ''),
    };
    if (parentAgent?.cwd) change.cwd = parentAgent.cwd;
    if (model !== undefined) change.model = model;
    return { change };
  }

  async function entriesFor(harnessId) {
    if (harnessId == null) return [];
    const state = await harness.snapshot(Roster, harnessId, context);
    return Object.entries(state?.agents || {});
  }

  async function listSubagents(conv) {
    if (!conv?.id || conv.harnessId == null) return [];
    const roles = await store.listRoles();
    const byId = new Map(roles.filter((role) => role?.id).map((role) => [role.id, role]));
    const out = [];
    for (const [key, entry] of await entriesFor(conv.harnessId)) {
      if (!entry?.conversationId) continue;
      remember(entry.conversationId, entry.roleId);
      const live = await harness.snapshot(LiveDoc, entry.conversationId, context);
      const transcript = await readTranscript(entry.conversationId);
      const stats = statsOf(transcript.messages);
      const role = byId.get(entry.roleId);
      const name = entry.mode === 'background'
        ? key
        : (role?.name || entry.name || entry.roleId || key);
      out.push({
        id: `${conv.id}:sub:${entry.conversationId}`,
        roleId: entry.roleId || role?.id || '',
        name,
        status: presentStatus(entry, Boolean(live?.run), stats.lastText),
        step: stats.step,
        totalSteps: stats.totalSteps,
        toolCalls: stats.toolCalls,
        lastText: stats.lastText,
        harnessId: entry.conversationId,
      });
    }
    return out;
  }

  async function emitAgent(cid, agent) {
    if (typeof emit !== 'function' || !agent) return;
    const data = agentEventData(agent);
    if (!data) return;
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

  async function markStopped(harnessId) {
    if (harnessId == null) return;
    await harness.commit(async (tx) => {
      const state = await tx.doc(Roster, harnessId);
      for (const agent of Object.values(state.agents || {})) agent.stopped = true;
    }, context);
  }

  return {
    prepareChild,
    onChild,
    roleFor,
    listSubagents,
    async seed(rows) {
      for (const row of rows || []) {
        if (!row?.harnessId) continue;
        for (const [, entry] of await entriesFor(row.harnessId)) {
          remember(entry.conversationId, entry.roleId);
          if (row.id) await attach(row.id, entry.conversationId);
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
          messages: transcript.messages,
        },
      };
    },
    async stopConversation(cid) {
      const conv = await store.getConversation(cid);
      if (!conv) return { status: 404, body: { error: 'conversation not found' } };
      await store.updateConversation(cid, { status: 'stopped', hostMark: 'stopped' });
      if (conv.harnessId != null) {
        const conversation = await harness.conversation(conv.harnessId, context);
        if (conversation) await conversation.abort(context, { background: true });
        await markStopped(conv.harnessId);
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
