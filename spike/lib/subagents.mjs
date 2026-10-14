import { appendFileSync, existsSync, mkdirSync, openSync, fsyncSync, closeSync, writeFileSync } from 'node:fs';
import path from 'node:path';
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
import { sleep, textOf } from './text.mjs';

export const Roster = defineDoc({
  kind: 'app.spike.subagents',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ agents: {}, reporters: {} }),
});

const Anchor = defineTask({
  name: 'app.spike.subagent-anchor',
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
  name: 'app.spike.subagent-reporter',
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
        const next = (report) => ({ status: 'running', checkpoint: { phase: 'report', ...(report === undefined ? {} : { report }) } });
        if (settled.status === 'unanswered') {
          return next(settled.reason === 'aborted' ? undefined : `[subagent ${name} failed: ${settled.reason}]`);
        }
        if (settled.type !== 'input') return next();
        const state = await tx.doc(Roster, runtime.conversationId);
        const agent = state.agents[name];
        if (!agent || agent.reported.includes(settled.answer)) return next();
        agent.reported.push(settled.answer);
        const answer = (await tx.entry(AssistantEntry, settled.answer))?.model?.[0];
        return next(`[subagent ${name} answered, no reply needed] ${textOf(answer)}`);
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

function reply(text, extra = {}) {
  return {
    content: [{ type: 'text', text }],
    ...(extra.details ? { details: extra.details } : {}),
    ...(extra.isError ? { isError: true } : {}),
  };
}

async function assistantText(api, entryId, context) {
  const entry = await api.commit((tx) => tx.entry(AssistantEntry, entryId), context);
  return textOf(entry?.model?.[0]);
}

async function latestAssistantText(api, conversationId, context) {
  const page = await api.commit(
    (tx) => tx.scanEntries({ conversationId, order: 'descending' }, 40),
    context,
  );
  for (const entry of page.items) {
    const message = entry.model?.[0];
    if (message?.role === 'assistant') {
      const text = textOf(message);
      if (text) return text;
    }
  }
  return '';
}

function roleChange(role, toolByName, blockedExtensions) {
  const missing = [];
  const tools = [];
  for (const name of role.tools || []) {
    const tool = toolByName.get(name);
    if (!tool) missing.push(name);
    else tools.push(tool);
  }
  if (missing.length > 0) {
    return { error: `role ${role.id} names unknown tools: ${missing.join(', ')}` };
  }
  return {
    change: {
      extensions: { remove: blockedExtensions },
      tools,
      instructions: role.systemPrompt,
      ...(role.model ? { model: role.model } : {}),
      ...(role.cwd ? { cwd: role.cwd } : {}),
    },
  };
}

function syncMarker(file) {
  const fd = openSync(file, 'w');
  try {
    writeFileSync(fd, 'holding\n');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Separate from the subagent extension so a child can hold without being able to spawn. */
export function createHoldTool(controlDir) {
  return defineTool({
    name: 'hold',
    description: 'Wait until this call is aborted, or return immediately if this call already started before a crash.',
    parameters: Type.Object({ token: Type.String() }),
    replay: 'safe',
    execute: async (args, _api, context) => {
      if (!/^[A-Za-z0-9_-]+$/.test(args.token)) {
        return reply('invalid hold token', { isError: true });
      }
      mkdirSync(controlDir, { recursive: true });
      const seen = path.join(controlDir, `${args.token}.seen`);
      const ticks = path.join(controlDir, `${args.token}.ticks`);
      if (existsSync(seen)) return reply('resumed-after-kill');
      syncMarker(seen);
      const started = Date.now();
      while (Date.now() - started < 30_000) {
        appendFileSync(ticks, `${Date.now()}\n`);
        await sleep(100, context.abortSignal);
      }
      return reply('held-without-kill');
    },
  });
}

/**
 * Foreground delegate (README / example 22) plus background subagents
 * (example 23): spawn, send, wait, stop, list. Role templates supply the
 * child's model, tools, and instructions. `maxConcurrent` counts roster
 * entries inside the creating commit, so two parallel spawns cannot both pass.
 */
export function createSubagentExtension({
  getRole,
  getMaxConcurrent,
  toolByName,
}) {
  const blocked = [];

  const delegate = defineTool({
    name: 'delegate',
    description: 'Run a task on a foreground subagent configured from a role template and return its answer.',
    parameters: Type.Object({
      task: Type.String(),
      roleId: Type.String(),
    }),
    replay: 'safe',
    execute: async (args, api, context) => {
      const role = getRole(args.roleId);
      if (!role) return reply(`unknown role ${args.roleId}`, { isError: true });
      const applied = roleChange(role, toolByName, blocked);
      if (applied.error) return reply(applied.error, { isError: true });
      const created = await api.commit(async (tx) => {
        const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
        const state = await tx.doc(Roster, api.conversationId);
        if (existing) return { id: existing.id };
        if (Object.keys(state.agents).length >= getMaxConcurrent()) {
          return { refused: getMaxConcurrent() };
        }
        const child = await tx.createConversation({ ownership: { kind: 'task', taskId: api.taskId } });
        await configure(tx, child.id, applied.change);
        state.agents[`fg:${api.taskId}`] = {
          conversationId: child.id,
          mode: 'foreground',
          roleId: role.id,
          reported: [],
        };
        return { id: child.id };
      }, context);
      if (created.refused !== undefined) {
        return reply(`limit ${created.refused}`, { isError: true });
      }
      await api.details({ conversationId: created.id, roleId: role.id }, context);
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
      if (settled.status !== 'done' || settled.type !== 'input') {
        return reply(`subagent ${settled.status} ${settled.reason || ''}`, { isError: true });
      }
      const text = await assistantText(api, settled.answer, context);
      await api.commit(async (tx) => {
        const state = await tx.doc(Roster, api.conversationId);
        delete state.agents[`fg:${api.taskId}`];
      }, context);
      return reply(text, { details: { conversationId: created.id, roleId: role.id } });
    },
  });

  const subagent = defineTool({
    name: 'subagent',
    description: 'Background subagents from a role template: spawn, send, wait, stop, list. Answers are reported back to this conversation.',
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
      roleId: Type.Optional(Type.String()),
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

      let role;
      if (action === 'spawn') {
        role = getRole(args.roleId || '');
        if (!role) return reply(`unknown role ${args.roleId || ''}`, { isError: true });
        const applied = roleChange(role, toolByName, blocked);
        if (applied.error) return reply(applied.error, { isError: true });
        const result = await api.commit(async (tx) => {
          const state = await tx.doc(Roster, api.conversationId);
          if (Object.hasOwn(state.agents, name)) return { error: `${name} already exists; use send.` };
          if (Object.keys(state.agents).length >= getMaxConcurrent()) {
            return { error: `limit ${getMaxConcurrent()}` };
          }
          const background = { ownership: { kind: 'conversation' }, background: true };
          const anchor = await tx.createTask(Anchor, null, background);
          const child = await tx.createConversation({ ownership: { kind: 'task', taskId: anchor } });
          await configure(tx, child.id, applied.change);
          state.agents[name] = { conversationId: child.id, mode: 'background', roleId: role.id, reported: [] };
          const input = { name, conversationId: child.id, message, followUp: false };
          state.reporters[api.taskId] = await tx.createTask(Reporter, input, background);
          return { conversationId: child.id, text: `Started ${name}.` };
        }, context);
        if (result.error) return reply(result.error, { isError: true });
        await api.details({ name, conversationId: result.conversationId }, context);
        return reply(result.text, { details: { name, conversationId: result.conversationId } });
      }

      const result = await api.commit(async (tx) => {
        const state = await tx.doc(Roster, api.conversationId);
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
    name: 'spike-subagents',
    tasks: [Anchor, Reporter],
    tools: [delegate, subagent],
  });
  blocked.push(extension);
  toolByName.set('delegate', delegate);
  toolByName.set('subagent', subagent);
  return extension;
}
