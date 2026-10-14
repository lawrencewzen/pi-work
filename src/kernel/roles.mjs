// Role and pipeline adapter for one Pi Durable conversation.
// Idle role changes go through conversation.configure. A pipeline stays in that
// same conversation: when a harness run ends, the host configures the next
// role and submits the handoff with a stable requestId. Restart resumes the
// harness task; the same requestId is not admitted twice. This is not a
// scheduler — there is no timer, and Pi Durable owns the run.
import { randomUUID } from 'node:crypto';
import { Type } from '@earendil-works/pi-ai';
import { ConversationBusy, defineExtension, defineTool, section } from '@earendil-works/pi-durable';
import { agentEventData, mapConvStatusToAgent } from '../core/agents.mjs';
import { TOOLS } from '../core/config.mjs';
import { synthesizeStatus } from './events.mjs';
import { toolsForRole } from './tools.mjs';

const FALLBACK_ROLE = {
  id: 'default',
  name: 'Default',
  systemPrompt: 'You are a helpful coding assistant.',
  tools: TOOLS.slice(),
};

const LOOSE_PARAMS = Type.Object({}, { additionalProperties: true });

/**
 * Text of a pipeline handoff. `previous` is the prior step's assistant text.
 * Anything else, including `user` and a missing input, is the original user text.
 */
export function handoffInput(step, { originalText = '', previousText = '' } = {}) {
  if (step?.input === 'previous') return previousText || '';
  return originalText || '';
}

/** Stable id so a restarted process cannot admit the handoff twice. */
export function pipelineRequestId(conversationId, step) {
  return `pipeline:${conversationId}:step:${step}`;
}

/**
 * Install the skills section and any builtin tool names the registry does not
 * already provide. A later batch can register the real workspace tools first;
 * those names are left alone. Plugin tools are installed when a role is applied.
 */
export function installRoleExtensions(registry, bridge) {
  if (!registry) throw new Error('registry is required');
  registry.install(defineExtension({
    name: 'pi-work-skills',
    sections: [
      section('skills', async (input) => {
        try {
          const role = await bridge.resolveRole?.(input.conversationId);
          if (!role || typeof bridge.skillPrompt !== 'function') return undefined;
          const text = String((await bridge.skillPrompt(role)) || '').trim();
          return text || undefined;
        } catch (err) {
          console.error(`PI_WORK_KERNEL_ROLE ${err instanceof Error ? err.message : err}`);
          return undefined;
        }
      }),
    ],
  }));
  const have = new Set(registry.snapshot().tools().map((item) => item.tool.name));
  const missing = TOOLS.filter((name) => !have.has(name)).map(builtinTool);
  if (missing.length) {
    registry.install(defineExtension({ name: 'pi-work-builtin-tools', tools: missing }));
  }
}

function builtinTool(name) {
  const readOnly = name === 'read' || name === 'ls' || name === 'grep';
  return defineTool({
    name,
    description: name,
    parameters: LOOSE_PARAMS,
    replay: readOnly ? 'safe' : 'unsafe',
    async execute() {
      return {
        content: [{ type: 'text', text: `${name} is not available` }],
        isError: true,
      };
    },
  });
}

function pluginTool(spec, store, byHarness) {
  return defineTool({
    name: spec.name,
    description: spec.description || spec.name,
    parameters: LOOSE_PARAMS,
    replay: 'unsafe',
    async execute(args, api, context) {
      const cid = byHarness.get(api.conversationId);
      const conv = cid ? await store.getConversation(cid) : null;
      let result;
      try {
        result = await spec.handler(args || {}, {
          workspacePath: conv?.workspacePath,
          conversationId: cid,
          signal: context?.abortSignal,
        });
      } catch (err) {
        return {
          content: [{ type: 'text', text: String(err?.message || 'plugin tool failed').slice(0, 32_000) }],
          isError: true,
        };
      }
      const output = typeof result === 'string' ? result : result?.output ?? '';
      const text = typeof output === 'string' ? output : JSON.stringify(output ?? '');
      return {
        content: [{ type: 'text', text: text.slice(0, 32_000) }],
        isError: result?.status === 'error',
      };
    },
  });
}

/**
 * Host glue around configure / submit. `bridge` is the same object passed to
 * installRoleExtensions, so the skills section can see the current role.
 */
export function createRoleHost({
  store,
  harness,
  context,
  registry,
  extensions,
  bridge,
  readTranscript,
  emit,
  describeAgents,
  resolveModel,
} = {}) {
  if (!store) throw new Error('store is required');
  if (!harness) throw new Error('harness is required');
  if (!context) throw new Error('context is required');
  if (!registry) throw new Error('registry is required');
  const byHarness = new Map();
  const lastAgent = new Map();
  const locks = new Map();
  let pluginSpecs = [];

  function remember(conv) {
    if (conv?.harnessId != null) byHarness.set(conv.harnessId, conv.id);
  }

  function lock(cid, fn) {
    const prev = locks.get(cid) || Promise.resolve();
    const run = prev.then(fn, fn);
    locks.set(cid, run.then(() => {}, () => {}));
    return run;
  }

  async function resolveRole(harnessId) {
    const cid = byHarness.get(harnessId);
    if (!cid) return null;
    const conv = await store.getConversation(cid);
    if (!conv) return null;
    return loadEffectiveRole(conv);
  }

  if (bridge) {
    bridge.resolveRole = resolveRole;
    bridge.skillPrompt = (role) => (
      extensions && typeof extensions.skillPrompt === 'function' ? extensions.skillPrompt(role) : ''
    );
  }

  async function loadEffectiveRole(conv) {
    let roleId = conv?.roleId || null;
    if (conv?.pipelineId) {
      const pipe = await store.getPipeline(conv.pipelineId);
      const step = pipe?.steps?.[Number(conv.pipelineStep) || 0] || pipe?.steps?.[0];
      if (step?.role) roleId = step.role;
    }
    const role = (roleId && await store.getRole(roleId)) || await store.getRole('default') || FALLBACK_ROLE;
    return role;
  }

  async function refreshPlugins() {
    let list = [];
    try {
      if (extensions && typeof extensions.pluginTools === 'function') {
        list = await extensions.pluginTools();
      }
    } catch (err) {
      console.error(`PI_WORK_KERNEL_ROLE ${err instanceof Error ? err.message : err}`);
      list = [];
    }
    pluginSpecs = (Array.isArray(list) ? list : []).filter((tool) => (
      tool && typeof tool.name === 'string' && typeof tool.handler === 'function'
    ));
    registry.install(defineExtension({
      name: 'pi-work-plugin-tools',
      tools: pluginSpecs.map((spec) => pluginTool(spec, store, byHarness)),
    }));
  }

  function toolsFor(role) {
    const tools = toolsForRole(role);
    if (role?.pluginTools === false) return tools;
    const have = new Set(tools.map((tool) => tool.name));
    const byName = new Map();
    for (const item of registry.snapshot().tools()) byName.set(item.tool.name, item.tool);
    for (const spec of pluginSpecs) {
      if (have.has(spec.name)) continue;
      const tool = byName.get(spec.name);
      if (!tool) continue;
      tools.push(tool);
      have.add(spec.name);
    }
    return tools;
  }

  async function configure(conv, role) {
    if (!conv?.harnessId) return;
    const conversation = await harness.conversation(conv.harnessId, context);
    if (!conversation) return;
    await refreshPlugins();
    await conversation.configure({
      instructions: String(role?.systemPrompt || ''),
      tools: toolsFor(role),
    }, context);
    if (typeof resolveModel === 'function') await resolveModel(conv, role);
  }

  async function submissionFor(conv, step) {
    if (!conv?.harnessId) return undefined;
    return harness.commit(
      (tx) => tx.submissionByRequest(conv.harnessId, pipelineRequestId(conv.id, step)),
      context,
    );
  }

  async function liveStatus(conv) {
    if (!conv?.harnessId) return conv?.status || 'idle';
    const transcript = await readTranscript(conv.harnessId);
    const status = synthesizeStatus(conv, transcript.busy);
    if (status === 'running' || status === 'recovering' || status === 'paused') return status;
    const inspection = await harness.inspect(context);
    const pending = inspection.submissions.some((record) => (
      record.conversationId === conv.harnessId && (record.status === 'queued' || record.status === 'placed')
    )) || inspection.tasks.some((item) => item.record.conversationId === conv.harnessId);
    if (pending) return conv.hostMark === 'recovering' ? 'recovering' : 'running';
    return status;
  }

  function lastAssistantText(messages) {
    for (let i = (messages || []).length - 1; i >= 0; i -= 1) {
      const msg = messages[i];
      if (msg?.role === 'assistant' && msg.text) return String(msg.text);
    }
    return '';
  }

  function firstUserText(messages) {
    const msg = (messages || []).find((item) => item?.role === 'user' && item.kind !== 'handoff');
    return msg?.text ? String(msg.text) : '';
  }

  async function submitHandoff(conv, pipe, step) {
    const requestId = pipelineRequestId(conv.id, step);
    const existing = await submissionFor(conv, step);
    if (existing) return conv;
    const spec = pipe.steps[step] || {};
    const transcript = await readTranscript(conv.harnessId);
    const text = handoffInput(spec, {
      originalText: conv.originalText || firstUserText(transcript.messages),
      previousText: lastAssistantText(transcript.messages),
    });
    let next = conv;
    if ((Number(conv.pipelineStep) || 0) !== step || conv.roleId !== spec.role || conv.status !== 'running') {
      next = await store.updateConversation(conv.id, {
        pipelineStep: step,
        roleId: spec.role,
        status: 'running',
      });
    }
    remember(next);
    const role = (spec.role && await store.getRole(spec.role)) || await loadEffectiveRole(next);
    await configure(next, role);
    const conversation = await harness.conversation(next.harnessId, context);
    if (!conversation) throw new Error('missing harness conversation');
    const draft = { type: 'input', content: text, requestId, whenBusy: 'reject' };
    try {
      await conversation.submit(draft, context);
    } catch (err) {
      if (!(err instanceof ConversationBusy)) throw err;
      await conversation.waitForIdle(context);
      await conversation.submit(draft, context);
    }
    return next;
  }

  async function stepHasAnswer(conv) {
    const transcript = await readTranscript(conv.harnessId);
    return transcript.messages.some((msg) => msg.role === 'assistant');
  }

  async function settle(cid) {
    const conv = await store.getConversation(cid);
    if (!conv?.pipelineId || !conv.harnessId) return 'continue';
    if (conv.status === 'failed' || conv.hostMark === 'failed') return 'continue';
    const pipe = await store.getPipeline(conv.pipelineId);
    if (!pipe?.steps?.length) return 'continue';
    const step = Number(conv.pipelineStep) || 0;
    if (step > 0) {
      const record = await submissionFor(conv, step);
      if (!record) {
        await submitHandoff(conv, pipe, step);
        await emitAgent(cid, 'running');
        return 'advanced';
      }
      if (record.status === 'queued' || record.status === 'placed') return 'busy';
      if (record.status !== 'done') return 'continue';
    } else if (!(await stepHasAnswer(conv))) {
      return 'continue';
    }
    if (step >= pipe.steps.length - 1) return 'continue';
    await emitAgent(cid, 'done');
    const fresh = await store.getConversation(cid);
    await submitHandoff(fresh, pipe, step + 1);
    await emitAgent(cid, 'running');
    return 'advanced';
  }

  async function emitAgent(cid, status, messages) {
    if (typeof describeAgents !== 'function') return;
    const conv = await store.getConversation(cid);
    if (!conv) return;
    let msgs = messages;
    if (!msgs && conv.harnessId) msgs = (await readTranscript(conv.harnessId)).messages;
    msgs = await annotate(conv, msgs || []);
    let agents = [];
    try {
      agents = await describeAgents({ ...conv, status: conv.status }, msgs);
    } catch (err) {
      console.error(`PI_WORK_KERNEL_ROLE ${err instanceof Error ? err.message : err}`);
      return;
    }
    const idx = agentIndex(conv, agents);
    const agent = agents[idx] || agents[0];
    const data = agentEventData(agent, mapConvStatusToAgent(status));
    if (!data) return;
    const key = JSON.stringify(data);
    if (lastAgent.get(cid) === key) return;
    lastAgent.set(cid, key);
    if (typeof emit === 'function') await emit(cid, 'agent', data);
  }

  function agentIndex(conv, agents) {
    if (!conv?.pipelineId || !agents?.length) return 0;
    const step = Number(conv.pipelineStep) || 0;
    return Math.min(Math.max(0, step), agents.length - 1);
  }

  async function annotate(conv, messages) {
    if (!conv?.pipelineId || !conv.harnessId || !messages?.length) return messages || [];
    const pipe = await store.getPipeline(conv.pipelineId);
    if (!pipe?.steps?.length) return messages;
    const out = messages.map((msg) => ({ ...msg }));
    for (let step = 1; step < pipe.steps.length; step += 1) {
      const record = await submissionFor(conv, step);
      const entryId = record?.entry;
      if (entryId == null) continue;
      const msg = out.find((item) => item.role === 'user' && item.id === String(entryId));
      if (!msg) continue;
      msg.id = `${conv.id}:u:p${step}`;
      msg.kind = 'handoff';
      msg.fromAgent = pipe.steps[step - 1]?.role;
      msg.toAgent = pipe.steps[step]?.role;
    }
    return out;
  }

  async function pipelinePending(conv) {
    if (!conv?.pipelineId) return false;
    const pipe = await store.getPipeline(conv.pipelineId);
    if (!pipe?.steps?.length) return false;
    const step = Number(conv.pipelineStep) || 0;
    if (step < pipe.steps.length - 1) return true;
    if (step > 0) {
      const record = await submissionFor(conv, step);
      if (!record || record.status === 'queued' || record.status === 'placed') return true;
    }
    return false;
  }

  async function patchConversation(cid, body) {
    const conv = await store.getConversation(cid);
    if (!conv) return { status: 404, body: { error: 'conversation not found' } };
    const status = await liveStatus(conv);
    if (status === 'running' || status === 'recovering' || status === 'paused') {
      return { status: 409, body: { error: 'err_role_busy', status } };
    }
    const patch = {};
    const input = body && typeof body === 'object' ? body : {};
    if (Object.prototype.hasOwnProperty.call(input, 'roleId')) {
      if (input.roleId == null || input.roleId === '' || input.roleId === 'default') patch.roleId = null;
      else {
        const role = await store.getRole(String(input.roleId));
        if (!role) return { status: 400, body: { errors: ['unknown role'] } };
        patch.roleId = role.id;
      }
    }
    if (Object.prototype.hasOwnProperty.call(input, 'pipelineId')) {
      if (input.pipelineId == null || input.pipelineId === '') {
        patch.pipelineId = null;
        patch.pipelineStep = 0;
      } else {
        const pipe = await store.getPipeline(String(input.pipelineId));
        if (!pipe) return { status: 400, body: { errors: ['unknown pipeline'] } };
        patch.pipelineId = pipe.id;
        patch.pipelineStep = 0;
        if (!Object.prototype.hasOwnProperty.call(patch, 'roleId') && pipe.steps?.[0]?.role) {
          patch.roleId = pipe.steps[0].role;
        }
      }
    } else if (Object.prototype.hasOwnProperty.call(input, 'roleId')) {
      patch.pipelineId = null;
      patch.pipelineStep = 0;
    }
    if (!Object.keys(patch).length) return { status: 400, body: { error: 'empty patch' } };
    const next = await store.updateConversation(cid, patch);
    remember(next);
    await configure(next, await loadEffectiveRole(next));
    const transcript = next.harnessId ? await readTranscript(next.harnessId) : { messages: [] };
    const messages = await annotate(next, transcript.messages || []);
    const agents = typeof describeAgents === 'function' ? await describeAgents(next, messages) : [];
    return {
      status: 200,
      body: {
        id: next.id,
        roleId: next.roleId || null,
        pipelineId: next.pipelineId || null,
        pipelineStep: next.pipelineStep || 0,
        status: next.status,
        agents,
      },
    };
  }

  return {
    remember,
    resolveRole,
    annotate,
    emitAgent,
    pipelinePending,
    patchConversation,
    async afterCreate(conv) {
      remember(conv);
      await configure(conv, await loadEffectiveRole(conv));
      return conv;
    },
    async prepareSend(conv, text) {
      let next = conv;
      if (text && !next.originalText) {
        next = await store.updateConversation(next.id, { originalText: text });
      }
      if (next.pipelineId) {
        const pipe = await store.getPipeline(next.pipelineId);
        const step = pipe?.steps?.[Number(next.pipelineStep) || 0] || pipe?.steps?.[0];
        if (step?.role && step.role !== next.roleId) {
          next = await store.updateConversation(next.id, { roleId: step.role });
        }
      }
      remember(next);
      await configure(next, await loadEffectiveRole(next));
      return { requestId: randomUUID(), conversation: next };
    },
    onRunFinished(cid) {
      return lock(cid, () => settle(cid));
    },
    reconcile(conv) {
      if (!conv?.id) return Promise.resolve('continue');
      remember(conv);
      return lock(conv.id, () => settle(conv.id));
    },
    async seed(rows) {
      for (const row of rows || []) remember(row);
    },
  };
}
