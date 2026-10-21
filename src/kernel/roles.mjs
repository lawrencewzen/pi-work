// Role adapter for one Pi Durable conversation.
// Idle role changes go through conversation.configure. Multi-role work is
// dispatched with sub-agents; this host does not rotate roles.
import { randomUUID } from 'node:crypto';
import { Type } from '@earendil-works/pi-ai';
import { defineExtension, defineTool, section } from '@earendil-works/pi-durable';
import { agentEventData, mapConvStatusToAgent } from '../core/agents.mjs';
import { TOOLS } from '../core/config.mjs';
import { createPluginHost } from './plugins.mjs';
import { toolsForRole } from './tools.mjs';

const FALLBACK_ROLE = {
  id: 'default',
  name: 'Default',
  systemPrompt: 'You are a helpful coding assistant.',
  tools: TOOLS.slice(),
};

const LOOSE_PARAMS = Type.Object({}, { additionalProperties: true });

const DEFAULT_TITLE = 'New conversation';

/** First user text names a conversation that still has the placeholder title. */
export function autoTitleFromText(currentTitle, text) {
  const cur = currentTitle == null ? '' : String(currentTitle);
  if (cur !== '' && cur !== DEFAULT_TITLE) return undefined;
  return String(text ?? '').slice(0, 48);
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
        output: [{ type: 'text', text: `${name} is not available` }],
        isError: true,
      };
    },
  });
}

/**
 * Host glue around configure / submit. `bridge` is the same object passed to
 * installRoleExtensions, so the skills section can see the current role.
 * `bridge.afterTools` reloads plugins at a generation boundary.
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
  statusOf,
} = {}) {
  if (!store) throw new Error('store is required');
  if (!harness) throw new Error('harness is required');
  if (!context) throw new Error('context is required');
  if (!registry) throw new Error('registry is required');
  const byHarness = new Map();
  const lastAgent = new Map();
  const plugins = createPluginHost({ registry, extensions, store, byHarness });

  function remember(conv) {
    if (conv?.harnessId != null) byHarness.set(conv.harnessId, conv.id);
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
    const roleId = conv?.roleId || null;
    const role = (roleId && await store.getRole(roleId)) || await store.getRole('default') || FALLBACK_ROLE;
    return role;
  }

  function toolsFor(role, { dispatch = true } = {}) {
    const tools = plugins.toolsFor(role, toolsForRole(role));
    if (!dispatch || typeof bridge?.extraTools !== 'function') return tools;
    const have = new Set(tools.map((tool) => tool.name));
    for (const tool of bridge.extraTools() || []) {
      if (!tool?.name || have.has(tool.name)) continue;
      tools.push(tool);
      have.add(tool.name);
    }
    return tools;
  }

  async function configure(conv, role) {
    if (!conv?.harnessId) return;
    const conversation = await harness.conversation(conv.harnessId, context);
    if (!conversation) return;
    await plugins.refresh();
    await conversation.configure({
      instructions: String(role?.systemPrompt || ''),
      tools: toolsFor(role),
    }, context);
    if (typeof resolveModel === 'function') await resolveModel(conv, role);
  }

  if (bridge) {
    bridge.afterTools = async (harnessId) => {
      const changed = await plugins.refresh();
      if (!changed) return;
      const cid = byHarness.get(harnessId);
      if (!cid) return;
      const conv = await store.getConversation(cid);
      if (!conv) return;
      await configure(conv, await loadEffectiveRole(conv));
    };
  }

  async function reloadPlugins() {
    const changed = await plugins.refresh();
    if (!changed) return;
    const rows = await store.listKernelConversations();
    for (const conv of rows || []) {
      if (!conv?.harnessId) continue;
      remember(conv);
      try {
        await configure(conv, await loadEffectiveRole(conv));
      } catch (err) {
        console.error(`PI_WORK_KERNEL_PLUGIN ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  async function liveStatus(conv) {
    if (typeof statusOf === 'function') return statusOf(conv);
    if (!conv?.harnessId) return 'idle';
    const inspection = await harness.inspect(context);
    const pending = inspection.submissions.some((record) => (
      record.conversationId === conv.harnessId && (record.status === 'queued' || record.status === 'placed')
    )) || inspection.tasks.some((item) => item.record.conversationId === conv.harnessId);
    return pending ? 'running' : 'idle';
  }

  async function emitAgent(cid, status, messages) {
    if (typeof describeAgents !== 'function') return;
    const conv = await store.getConversation(cid);
    if (!conv) return;
    let msgs = messages;
    if (!msgs && conv.harnessId) msgs = (await readTranscript(conv.harnessId)).messages;
    let agents = [];
    try {
      agents = await describeAgents({ ...conv, status: conv.status }, msgs || []);
    } catch (err) {
      console.error(`PI_WORK_KERNEL_ROLE ${err instanceof Error ? err.message : err}`);
      return;
    }
    const agent = agents[0];
    const data = agentEventData(agent, mapConvStatusToAgent(status));
    if (!data) return;
    const key = JSON.stringify(data);
    if (lastAgent.get(cid) === key) return;
    lastAgent.set(cid, key);
    if (typeof emit === 'function') await emit(cid, 'agent', data);
  }

  async function patchBody(next) {
    const transcript = next.harnessId ? await readTranscript(next.harnessId) : { messages: [] };
    const agents = typeof describeAgents === 'function' ? await describeAgents(next, transcript.messages || []) : [];
    return {
      id: next.id,
      roleId: next.roleId || null,
      status: next.status,
      agents,
    };
  }

  async function patchConversation(cid, body) {
    const conv = await store.getConversation(cid);
    if (!conv) return { status: 404, body: { error: 'conversation not found' } };
    const status = await liveStatus(conv);
    if (status === 'running') {
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
    if (!Object.keys(patch).length) {
      // pipelineId is ignored if still sent.
      if (Object.prototype.hasOwnProperty.call(input, 'pipelineId')) {
        return { status: 200, body: await patchBody(conv) };
      }
      return { status: 400, body: { error: 'empty patch' } };
    }
    const next = await store.updateConversation(cid, patch);
    remember(next);
    await configure(next, await loadEffectiveRole(next));
    return { status: 200, body: await patchBody(next) };
  }

  return {
    remember,
    reloadPlugins,
    resolveRole,
    async collectTools(role, options) {
      await plugins.refresh();
      return toolsFor(role, options);
    },
    emitAgent,
    patchConversation,
    async afterCreate(conv) {
      remember(conv);
      await configure(conv, await loadEffectiveRole(conv));
      return conv;
    },
    async prepareSend(conv, text) {
      let next = conv;
      const title = autoTitleFromText(next.title, text);
      if (title !== undefined) next = await store.updateConversation(next.id, { title });
      remember(next);
      await configure(next, await loadEffectiveRole(next));
      return { requestId: randomUUID(), conversation: next };
    },
    async seed(rows) {
      for (const row of rows || []) remember(row);
    },
  };
}
