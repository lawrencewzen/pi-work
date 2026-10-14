import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { createRegistry, defineExtension, Harness, watchEvents } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { formatTraceLine, toSseLike } from './events.mjs';
import { textOf } from './text.mjs';
import { createHoldTool, createSubagentExtension, Roster } from './subagents.mjs';
import { createWorkspaceTools } from './tools.mjs';

export { Roster };

export async function openKernel({
  dataDir,
  workspacePath,
  model,
  models,
  maxConcurrentSubagents = 4,
  getRole,
  controlDir,
  onLine,
} = {}) {
  if (!dataDir) throw new Error('dataDir is required');
  if (!workspacePath) throw new Error('workspacePath is required');
  if (!model?.provider || !model?.modelId) throw new Error('model { provider, modelId } is required');
  if (!models) throw new Error('models is required');
  await mkdir(dataDir, { recursive: true });
  const context = BACKGROUND_CONTEXT;
  const workspaceTools = createWorkspaceTools();
  const hold = createHoldTool(controlDir || path.join(dataDir, 'control'));
  const toolByName = new Map(workspaceTools.map((tool) => [tool.name, tool]));
  toolByName.set(hold.name, hold);
  const subagents = createSubagentExtension({
    getRole: getRole || (() => undefined),
    getMaxConcurrent: () => maxConcurrentSubagents,
    toolByName,
  });
  const registry = createRegistry();
  registry.install(defineExtension({ name: 'spike-workspace', tools: workspaceTools }));
  registry.install(defineExtension({ name: 'spike-hold', tools: [hold] }));
  registry.install(subagents);

  const storage = await openNodeSqliteStorage(path.join(dataDir, 'session.sqlite'));
  const harness = await Harness.open(storage, {
    models,
    registry,
    settings: {
      retry: { enabled: false, maxRetries: 0, baseDelayMs: 1 },
      compaction: { enabled: false },
      toolExecution: 'parallel',
    },
    env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd || workspacePath }),
    onReport: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      onLine?.(`harness-report ${message}`);
    },
  }, context);
  harness.resume();
  const root = await harness.root(context, { agent: { model, cwd: workspacePath } });

  const attached = new Set();
  const streams = [];
  const trace = [];

  async function attach(conversationId) {
    if (attached.has(conversationId)) return;
    attached.add(conversationId);
    const stream = await watchEvents(harness, conversationId, context);
    streams.push(stream);
    const entries = stream.snapshot?.entries || [];
    onLine?.(`attach conversation=${conversationId} entries=${entries.length}`);
    trace.push({ conversationId, eventType: 'attach', sse: null });
    for (const entry of entries) {
      const text = textOf(entry.model?.[0]);
      if (!text) continue;
      onLine?.(`snapshot conversation=${conversationId} kind=${entry.kind} text=${text.slice(0, 240)}`);
      trace.push({ conversationId, eventType: 'snapshot', sse: 'message.done' });
    }
    stream.start(async (events) => {
      for (const event of events) {
        const line = formatTraceLine(conversationId, event);
        trace.push({ conversationId, eventType: event.type, sse: toSseLike(event)?.event || null });
        onLine?.(line);
        const child = event?.details?.conversationId;
        if (typeof child === 'string' || typeof child === 'number') await attach(child);
      }
    });
  }

  await attach(root.id);

  return {
    context,
    harness,
    root,
    registry,
    trace,
    attach,
    async close() {
      for (const stream of streams) {
        await stream.stop().catch(() => {});
      }
      await harness.close(context);
    },
  };
}
