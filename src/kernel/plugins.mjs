// Plugin tools on the Pi Durable kernel.
// Loading and checks stay in plugins.mjs. Registration is `registry.install`:
// the same extension name replaces the previous tools in one step. A tool call
// that already started keeps the implementation it took; the next phase,
// request, or call resolves the registry again. This module does not schedule.
import { Type } from '@earendil-works/pi-ai';
import { defineExtension, defineTool, GenerationTask, hook } from '@earendil-works/pi-durable';
import { EXT_PLUGIN_RELOAD, EXT_PLUGIN_TOOLS } from './ids.mjs';

const LOOSE_PARAMS = Type.Object({}, { additionalProperties: true });
const EXTENSION = EXT_PLUGIN_TOOLS;

function pluginTool(spec, store, byHarness) {
  const handler = spec.handler;
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
        result = await handler(args || {}, {
          workspacePath: conv?.workspacePath,
          conversationId: cid,
          signal: context?.abortSignal,
        });
      } catch (err) {
        return {
          output: [{ type: 'text', text: String(err?.message || 'plugin tool failed').slice(0, 32_000) }],
          isError: true,
        };
      }
      const payload = typeof result === 'string' ? result : result?.output ?? '';
      const text = typeof payload === 'string' ? payload : JSON.stringify(payload ?? '');
      return {
        output: [{ type: 'text', text: text.slice(0, 32_000) }],
        isError: result?.status === 'error',
      };
    },
  });
}

async function readSpecs(extensions) {
  let list = [];
  try {
    if (extensions && typeof extensions.pluginTools === 'function') {
      list = await extensions.pluginTools();
    }
  } catch (err) {
    console.error(`WEFT_KERNEL_PLUGIN ${err instanceof Error ? err.message : err}`);
    list = [];
  }
  return (Array.isArray(list) ? list : []).filter((tool) => (
    tool && typeof tool.name === 'string' && typeof tool.handler === 'function'
  ));
}

function specKey(list) {
  return list.map((spec) => `${spec.name}:${spec.handler}`).join('\n');
}

/**
 * Phase-boundary hook. The handler is resolved when the phase starts, so a
 * reload installed from here is what the next model request sees.
 */
export function installPluginReload(registry, bridge) {
  if (!registry) throw new Error('registry is required');
  registry.install(defineExtension({
    name: EXT_PLUGIN_RELOAD,
    hooks: [
      hook(GenerationTask, {
        async afterTools(_assistant, _results, api) {
          try {
            if (typeof bridge?.afterTools === 'function') await bridge.afterTools(api.conversationId);
          } catch (err) {
            console.error(`WEFT_KERNEL_PLUGIN ${err instanceof Error ? err.message : err}`);
          }
        },
      }),
    ],
  }));
}

/**
 * Enabled plugin tools for the registry. Every conversation may offer them.
 */
export function createPluginHost({ registry, extensions, store, byHarness } = {}) {
  if (!registry) throw new Error('registry is required');
  if (!store) throw new Error('store is required');
  if (!byHarness) throw new Error('byHarness is required');
  let specs = [];
  let installedKey = null;

  async function refresh() {
    const next = await readSpecs(extensions);
    const key = specKey(next);
    if (key === installedKey) return false;
    specs = next;
    installedKey = key;
    registry.install(defineExtension({
      name: EXTENSION,
      tools: specs.map((spec) => pluginTool(spec, store, byHarness)),
    }));
    return true;
  }

  function toolsFor(baseTools) {
    const tools = (baseTools || []).slice();
    const have = new Set(tools.map((tool) => tool.name));
    const byName = new Map();
    for (const item of registry.snapshot().tools()) byName.set(item.tool.name, item.tool);
    for (const spec of specs) {
      if (have.has(spec.name)) continue;
      const tool = byName.get(spec.name);
      if (!tool) continue;
      tools.push(tool);
      have.add(spec.name);
    }
    return tools;
  }

  return { refresh, toolsFor };
}
