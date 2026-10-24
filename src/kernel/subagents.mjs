// Foreground and background subagents, as in Pi Durable examples 22 and 23.
// Ownership, abort, and restart reuse belong to the Harness. This module
// configures a self-contained child (task text only, empty instructions) and
// reads what the tools already committed: details, the ownership index, and
// the background name document.
import { Type } from '@earendil-works/pi-ai';
import {
  AssistantEntry,
  configure,
  defineDoc,
  defineExtension,
  defineTask,
  defineTool,
  LiveDoc,
} from '@earendil-works/pi-durable';
import { agentEventData } from '../core/agents.mjs';
import { textOf } from './events.mjs';
import {
  EXT_SUBAGENTS,
  SUBAGENT_ANCHOR_KIND,
  SUBAGENT_REPORTER_KIND,
  SUBAGENTS_DOC_KIND,
} from './ids.mjs';

export const DELEGATE_DESCRIPTION = 'Run a self-contained task on a subagent and return its answer. The subagent cannot see this conversation, or your instructions; put everything it needs in task: what to do, where, when it is done, and what to report back.';
export const SUBAGENT_DESCRIPTION = `${DELEGATE_DESCRIPTION} On spawn, pass that text as message. \`name\` is used later with send, wait, and stop.`;
const DISPATCH_TOOLS = new Set(['delegate', 'subagent', 'skill']);
const NAME_CAP = 30;

// Example 23: the main conversation maps background names to child conversations.
export const Subagents = defineDoc({
  kind: SUBAGENTS_DOC_KIND,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  checkpointWhen: () => false,
  initial: () => ({ agents: {}, reporters: {} }),
});

const Anchor = defineTask({
  name: SUBAGENT_ANCHOR_KIND,
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
  name: SUBAGENT_REPORTER_KIND,
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

/** Foreground chip name: first line of the task, one line, at most 30 characters. */
export function nameFromTask(task) {
  return String(task || '').split(/\r?\n/, 1)[0].replace(/\s+/g, ' ').trim().slice(0, NAME_CAP);
}

function childTools(parentAgent) {
  return (parentAgent?.tools || []).filter((tool) => tool?.name && !DISPATCH_TOOLS.has(tool.name));
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
 * removed, so it cannot delegate, spawn, or load skills. `prepareChild` blanks
 * instructions and keeps the parent's workspace/plugin tools, model, and cwd.
 */
export function createSubagentExtension({
  prepareChild,
  onChild,
} = {}) {
  if (typeof prepareChild !== 'function') throw new Error('prepareChild is required');
  const blocked = [];

  const delegate = defineTool({
    name: 'delegate',
    description: DELEGATE_DESCRIPTION,
    parameters: Type.Object({
      task: Type.String(),
    }),
    replay: 'safe',
    execute: async (args, api, context) => {
      const parent = await api.agent(context);
      const prepared = await prepareChild(parent);
      if (prepared?.error) return reply(prepared.error, { isError: true });
      const name = nameFromTask(args.task);
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
      const details = { conversationId: child, name };
      await api.details(details, context);
      if (typeof onChild === 'function') onChild(api.conversationId, child);
      const handle = await api.conversation(child, context);
      if (!handle) return reply('subagent conversation disappeared', { isError: true });
      const settled = await (await handle.submit({
        type: 'input',
        content: args.task,
        requestId: `subagent:${api.taskId}`,
      }, context)).wait(context);
      if (context.abortSignal?.aborted) {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }
      if (settled.reason === 'aborted') {
        return reply(`[subagent ${name} was stopped by the user]`, {
          details: { conversationId: child, name },
        });
      }
      if (settled.status !== 'done' || settled.type !== 'input') {
        return reply(`subagent ${settled.status} ${settled.reason || ''}`, { isError: true });
      }
      const text = await assistantText(api, settled.answer, context);
      return reply(text, { details: { conversationId: child, name } });
    },
  });

  const subagent = defineTool({
    name: 'subagent',
    description: SUBAGENT_DESCRIPTION,
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
          lines.push(`${each}: ${busy ? 'working' : 'idle'}`);
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
        const parent = await api.agent(context);
        const prepared = await prepareChild(parent);
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
          state.agents[name] = { conversationId: child.id, reported: [] };
          const input = { name, conversationId: child.id, message, followUp: false };
          state.reporters[api.taskId] = await tx.createTask(Reporter, input, background);
          return { conversationId: child.id, text: `Started ${name}.` };
        }, context);
        if (result.error) return reply(result.error, { isError: true });
        await api.details({
          name,
          conversationId: result.conversationId,
        }, context);
        if (typeof onChild === 'function') onChild(api.conversationId, result.conversationId);
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
    name: EXT_SUBAGENTS,
    tasks: [Anchor, Reporter],
    tools: [delegate, subagent],
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

const ACTION_CAP = 60;
const PRIMARY_ARG_KEYS = ['command', 'cmd', 'path', 'query', 'pattern', 'url', 'message', 'task'];
const TERMINAL_CHILD = new Set(['done', 'stopped', 'failed', 'error']);

function clipAction(text) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (!value) return undefined;
  return value.length <= ACTION_CAP ? value : value.slice(0, ACTION_CAP);
}

function asTimestamp(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function toolCallsFromContent(content) {
  if (!Array.isArray(content)) return [];
  return content.filter((block) => block && block.type === 'toolCall' && block.name);
}

function primaryArg(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return '';
  for (const key of PRIMARY_ARG_KEYS) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  for (const [key, value] of Object.entries(args)) {
    if (key === 'description') continue;
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

/** Last-tool label for a running child. Prefer `description`, else `name: primary`. */
export function currentActionText(name, args) {
  const description = typeof args?.description === 'string' ? args.description.trim() : '';
  if (description) return clipAction(description);
  const primary = primaryArg(args);
  const label = String(name || '').trim();
  if (!label && !primary) return undefined;
  return clipAction(primary ? `${label}: ${primary}` : label);
}

function takeTool(call) {
  if (!call?.name) return null;
  const args = call.arguments && typeof call.arguments === 'object' && !Array.isArray(call.arguments)
    ? call.arguments
    : (call.input && typeof call.input === 'object' && !Array.isArray(call.input) ? call.input : {});
  return { name: call.name, args };
}

/**
 * Extra chip fields from a child transcript. Missing timestamps or text are omitted.
 * `entries` are preferred (pi-ai `timestamp` lives on `entry.model[0]`); mapped
 * `messages` are the fallback when entries are absent.
 */
export function activityFields(transcript, status) {
  const messages = transcript?.messages || [];
  const entries = transcript?.entries || [];
  let brief;
  let startedAt;
  let lastActivityAt;
  let lastTs;
  let sawFirst = false;
  let lastWasAssistantText = false;
  let lastTool = null;

  const noteFirst = (model) => {
    const ts = asTimestamp(model?.timestamp);
    if (!sawFirst) {
      sawFirst = true;
      if (ts != null) startedAt = ts;
    }
    if (ts != null) lastTs = ts;
    return ts;
  };

  if (entries.length) {
    for (const entry of entries) {
      const model = entry?.model?.[0];
      if (entry?.kind === 'pi.user') {
        noteFirst(model);
        lastWasAssistantText = false;
        if (brief == null) {
          const text = textOf(model?.content);
          if (text) brief = text;
        }
      } else if (entry?.kind === 'pi.assistant') {
        const ts = noteFirst(model);
        if (ts != null) lastActivityAt = ts;
        const calls = toolCallsFromContent(model?.content);
        const text = textOf(model?.content);
        if (calls.length) {
          lastTool = takeTool(calls[calls.length - 1]);
          lastWasAssistantText = false;
        } else if (text) {
          lastWasAssistantText = true;
        }
      } else if (entry?.kind === 'pi.tool-result') {
        const ts = noteFirst(model);
        if (ts != null) lastActivityAt = ts;
        lastWasAssistantText = false;
        if (!lastTool && model?.toolName) lastTool = takeTool({ name: model.toolName, arguments: {} });
      }
    }
  } else {
    for (const message of messages) {
      if (message?.role === 'user') {
        noteFirst(message);
        lastWasAssistantText = false;
        if (brief == null && message.text) brief = String(message.text);
      } else if (message?.role === 'assistant') {
        const ts = noteFirst(message);
        if (ts != null) lastActivityAt = ts;
        const tool = message.tool || (Array.isArray(message.toolCalls) ? message.toolCalls[message.toolCalls.length - 1] : null);
        if (tool?.name) {
          lastTool = takeTool({ name: tool.name, arguments: tool.arguments || tool.input || {} });
          lastWasAssistantText = false;
        } else if (message.text) {
          lastWasAssistantText = true;
        }
      } else if (message?.role === 'tool' || message?.tool) {
        const ts = noteFirst(message);
        if (ts != null) lastActivityAt = ts;
        lastWasAssistantText = false;
        if (message.tool?.name) lastTool = takeTool({ name: message.tool.name, arguments: message.tool.input || {} });
      }
    }
  }

  const out = {};
  if (brief) out.brief = brief;
  if (startedAt != null) out.startedAt = startedAt;
  if (lastActivityAt != null) out.lastActivityAt = lastActivityAt;
  if (TERMINAL_CHILD.has(status) && lastTs != null) out.endedAt = lastTs;
  if (status === 'running' && !lastWasAssistantText && lastTool) {
    const action = currentActionText(lastTool.name, lastTool.args);
    if (action) out.currentAction = action;
  }
  return out;
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
    name: patch.name || prev.name || '',
  });
}

function toolChild(details, mode) {
  if (details?.conversationId == null || !mode) return null;
  return { conversationId: details.conversationId, mode, name: details.name };
}

/** Read subagents from tool details, the background name document, ownership, and child viewState. */
export function createSubagentHost({
  store,
  harness,
  context,
  readTranscript,
  emit,
  watchEvents,
  cidFor,
} = {}) {
  if (!store) throw new Error('store is required');
  if (!harness) throw new Error('harness is required');
  if (!context) throw new Error('context is required');
  if (typeof readTranscript !== 'function') throw new Error('readTranscript is required');
  const childWatches = new Map();
  const lastAgent = new Map();
  let closed = false;

  async function prepareChild(parentAgent) {
    const change = { tools: childTools(parentAgent), instructions: '' };
    if (parentAgent?.cwd) change.cwd = parentAgent.cwd;
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
      if (entry?.conversationId) takeChild(meta, order, entry.conversationId, { mode: 'background', name });
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
    const out = [];
    for (const key of order) {
      const entry = meta.get(key);
      if (!entry?.conversationId) continue;
      const childLive = await harness.snapshot(LiveDoc, entry.conversationId, context);
      const transcript = await readTranscript(entry.conversationId);
      const stats = statsOf(transcript.messages);
      const aborted = generations.get(key)?.state?.outcome?.status === 'aborted';
      const name = entry.name || String(entry.conversationId);
      const status = childStatus(Boolean(childLive?.run), aborted, stats.lastText);
      out.push({
        id: `${conv.id}:sub:${entry.conversationId}`,
        name,
        status,
        step: stats.step,
        totalSteps: stats.totalSteps,
        toolCalls: stats.toolCalls,
        lastText: stats.lastText,
        mode: entry.mode === 'background' ? 'background' : 'foreground',
        harnessId: entry.conversationId,
        ...activityFields(transcript, status),
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
      console.error(`WEFT_KERNEL_SUBAGENT ${err instanceof Error ? err.message : err}`);
    });
    await run();
    stream.start(() => run());
  }

  function onChild(parentHarnessId, childId) {
    const parentCid = typeof cidFor === 'function' ? cidFor(parentHarnessId) : null;
    if (!parentCid) return;
    setImmediate(() => {
      attach(parentCid, childId).catch((err) => {
        console.error(`WEFT_KERNEL_SUBAGENT ${err instanceof Error ? err.message : err}`);
      });
    });
  }

  return {
    prepareChild,
    onChild,
    listSubagents,
    async seed(rows) {
      for (const row of rows || []) {
        if (!row?.harnessId) continue;
        const agents = await listSubagents(row);
        for (const agent of agents) {
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
