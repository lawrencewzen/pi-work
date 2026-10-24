// Agent adapter for one Pi Durable conversation.
// The main agent has empty instructions, every workspace tool, enabled plugin
// tools, skill, and delegate / subagent. The skills section is a one-line catalog;
// the skill tool loads a body on demand. Children get none of that.
import { randomUUID } from 'node:crypto';
import { Type } from '@earendil-works/pi-ai';
import { defineExtension, defineTool, section } from '@earendil-works/pi-durable';
import { agentEventData, mapConvStatusToAgent } from '../core/agents.mjs';
import { TOOLS } from '../core/config.mjs';
import { unknownSkillError } from '../core/skills.mjs';
import { resolveConversationModelPatch } from '../core/model-sources.mjs';
import { createPluginHost } from './plugins.mjs';
import { isAutoContinueText } from './continuation.mjs';
import { EXT_BUILTIN_TOOLS, EXT_SKILLS } from './ids.mjs';
import { createSkillTool } from './skill-tool.mjs';
import { workspaceTools } from './tools.mjs';

const LOOSE_PARAMS = Type.Object({}, { additionalProperties: true });

const DEFAULT_TITLE = 'New conversation';

/** First user text names a conversation that still has the placeholder title. */
export function autoTitleFromText(currentTitle, text) {
  const cur = currentTitle == null ? '' : String(currentTitle);
  if (cur !== '' && cur !== DEFAULT_TITLE) return undefined;
  if (isAutoContinueText(text)) return undefined;
  return String(text ?? '').slice(0, 48);
}

/**
 * Install the skills catalog section, the skill loader, and any builtin tool
 * names the registry does not already provide. A later batch can register the
 * real workspace tools first; those names are left alone. Plugin tools are
 * installed when a conversation is configured.
 */
export function installAgentExtensions(registry, bridge) {
  if (!registry) throw new Error('registry is required');
  const skillTool = createSkillTool({
    loadSkill: (name) => (
      typeof bridge?.loadSkill === 'function'
        ? bridge.loadSkill(name)
        : { error: unknownSkillError(name, []) }
    ),
  });
  if (bridge) bridge.skillTool = skillTool;
  registry.install(defineExtension({
    name: EXT_SKILLS,
    sections: [
      section('skills', async (input) => {
        try {
          const names = new Set((input?.agent?.tools || []).map((tool) => tool.name));
          // Children drop delegate / subagent / skill; they stay self-contained.
          if (!names.has('delegate') && !names.has('subagent')) return undefined;
          if (typeof bridge.skillPrompt !== 'function') return undefined;
          const text = String((await bridge.skillPrompt()) || '').trim();
          return text || undefined;
        } catch (err) {
          console.error(`WEFT_KERNEL_AGENT ${err instanceof Error ? err.message : err}`);
          return undefined;
        }
      }),
    ],
    tools: [skillTool],
  }));
  const have = new Set(registry.snapshot().tools().map((item) => item.tool.name));
  const missing = TOOLS.filter((name) => !have.has(name)).map(builtinTool);
  if (missing.length) {
    registry.install(defineExtension({ name: EXT_BUILTIN_TOOLS, tools: missing }));
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
 * installAgentExtensions, so the skills section can list enabled skills.
 * `bridge.afterTools` reloads plugins at a generation boundary.
 */
export function createAgentHost({
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

  if (bridge) {
    bridge.skillPrompt = () => (
      extensions && typeof extensions.skillPrompt === 'function' ? extensions.skillPrompt() : ''
    );
    bridge.loadSkill = (name) => (
      extensions && typeof extensions.loadSkill === 'function'
        ? extensions.loadSkill(name)
        : { error: unknownSkillError(name, []) }
    );
  }

  function toolsFor({ dispatch = true } = {}) {
    const tools = plugins.toolsFor(workspaceTools());
    if (!dispatch || typeof bridge?.extraTools !== 'function') return tools;
    const have = new Set(tools.map((tool) => tool.name));
    for (const tool of bridge.extraTools() || []) {
      if (!tool?.name || have.has(tool.name)) continue;
      tools.push(tool);
      have.add(tool.name);
    }
    return tools;
  }

  async function configure(conv) {
    if (!conv?.harnessId) return;
    const conversation = await harness.conversation(conv.harnessId, context);
    if (!conversation) return;
    await plugins.refresh();
    await conversation.configure({
      instructions: '',
      tools: toolsFor(),
    }, context);
    if (typeof resolveModel === 'function') await resolveModel(conv);
  }

  if (bridge) {
    bridge.afterTools = async (harnessId) => {
      const changed = await plugins.refresh();
      if (!changed) return;
      const cid = byHarness.get(harnessId);
      if (!cid) return;
      const conv = await store.getConversation(cid);
      if (!conv) return;
      await configure(conv);
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
        await configure(conv);
      } catch (err) {
        console.error(`WEFT_KERNEL_PLUGIN ${err instanceof Error ? err.message : err}`);
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
      console.error(`WEFT_KERNEL_AGENT ${err instanceof Error ? err.message : err}`);
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
      modelSourceId: next.modelSourceId || null,
      modelId: next.modelId || null,
      status: next.status,
      agents,
    };
  }

  async function patchConversation(cid, body) {
    const conv = await store.getConversation(cid);
    if (!conv) return { status: 404, body: { error: 'conversation not found' } };
    const status = await liveStatus(conv);
    const patch = {};
    const input = body && typeof body === 'object' ? body : {};
    const modelChoice = resolveConversationModelPatch(await store.getSettings(), input);
    if (modelChoice.present) {
      if (!modelChoice.ok) return { status: 400, body: { errors: modelChoice.errors } };
      patch.modelSourceId = modelChoice.value.modelSourceId;
      patch.modelId = modelChoice.value.modelId;
    }
    if (!Object.keys(patch).length) {
      // Unknown keys (pipeline leftovers, retired fields) are ignored.
      if (Object.keys(input).length) {
        return { status: 200, body: await patchBody(conv) };
      }
      return { status: 400, body: { error: 'empty patch' } };
    }
    const next = await store.updateConversation(cid, patch);
    remember(next);
    // A model change while running is stored and picked up on the next submit.
    if (status !== 'running') await configure(next);
    return { status: 200, body: await patchBody(next) };
  }

  return {
    remember,
    reloadPlugins,
    async collectTools(options) {
      await plugins.refresh();
      return toolsFor(options);
    },
    emitAgent,
    patchConversation,
    async afterCreate(conv) {
      remember(conv);
      await configure(conv);
      return conv;
    },
    async prepareSend(conv, text) {
      let next = conv;
      const title = autoTitleFromText(next.title, text);
      if (title !== undefined) next = await store.updateConversation(next.id, { title });
      remember(next);
      await configure(next);
      return { requestId: randomUUID(), conversation: next };
    },
    async seed(rows) {
      for (const row of rows || []) remember(row);
    },
  };
}
