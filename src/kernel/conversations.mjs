// HTTP facade over one Pi Durable Harness.
// Dialogue state lives in the Harness. This module records the conversation
// index, maps watchEvents onto the connected SSE clients, and reads diffs
// back out of tool-result entries.
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { createModels } from '@earendil-works/pi-ai/models';
import { createRegistry, watchEvents } from '@earendil-works/pi-durable';
import { liveDiff } from '../core/diff.mjs';
import { redactAuthText } from '../core/grok-auth.mjs';
import { resolveInWorkspace } from '../core/paths.mjs';
import { formatSSE } from '../core/sse.mjs';
import { contextWindowForConversation } from '../core/model-sources.mjs';
import { presentContext } from '../core/usage.mjs';
import {
  baselinesFromEntries,
  createMapContext,
  mapHarnessBatch,
  messagesFromEntries,
  statusFromSubmission,
} from './events.mjs';
import { createScriptFloorExtension, installDemo } from './faux-script.mjs';
import { FAUX_MODEL, openKernel } from './index.mjs';
import { createKernelModels, explicitDemo } from './models.mjs';
import { installPluginReload } from './plugins.mjs';
import { createAgentHost, installAgentExtensions } from './agent-config.mjs';
import { createSubagentControl } from './subagent-control.mjs';
import { createSubagentExtension, createSubagentHost } from './subagents.mjs';
import { createWorkspaceExtension, workspaceTools } from './tools.mjs';
import { installUsageExtension } from './usage.mjs';
import { installContinuationExtension } from './continuation.mjs';
import { createWorkspaceEnv } from './workspace-env.mjs';

const DETAIL_CAP = 1024 * 1024;

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * Harness settings. `WEFT_RETRY_MAX` is the number of attempts including the
 * first; Pi Durable's `maxRetries` counts the attempts after that.
 */
export function kernelSettings(env = process.env) {
  const maxAttempts = positiveInt(env.WEFT_RETRY_MAX, 5);
  return {
    retry: {
      enabled: true,
      maxRetries: Math.max(0, maxAttempts - 1),
      baseDelayMs: positiveInt(env.WEFT_RETRY_BASE_MS, 200),
    },
    stream: {
      timeoutMs: positiveInt(env.WEFT_STREAM_TIMEOUT_MS, 120_000),
    },
  };
}

/**
 * Open the Harness for the conversation HTTP routes.
 * `harness.resume()` continues unfinished work. Status is the last submission
 * reacquired with `harness.submission(id)`, not a host-side scan.
 */
export async function openConversationKernel({
  dataDir,
  store,
  demo,
  describeAgents,
  extensions,
  getSettings,
  grokAuth,
  env = process.env,
} = {}) {
  if (!dataDir) throw new Error('dataDir is required');
  if (!store) throw new Error('store is required');
  const faux = demo === true || explicitDemo(env);
  const models = createModels();
  if (faux) installDemo(models, env);
  const modelRoutes = createKernelModels({ models, getSettings, grokAuth, env });
  const routes = faux ? null : modelRoutes;
  const registry = createRegistry();
  const agentBridge = {};
  const subagentApi = {};
  const watches = new Map();
  const tails = new Map();
  const listeners = new Map();
  const settings = kernelSettings(env);
  let agentHost;

  async function conversationIdFor(harnessId) {
    const wanted = Number(harnessId);
    for (const [cid, watch] of watches) {
      if (Number(watch.harnessId) === wanted) return cid;
    }
    const rows = await store.listKernelConversations();
    return rows.find((row) => Number(row.harnessId) === wanted)?.id ?? null;
  }

  registry.install(createWorkspaceExtension());
  installAgentExtensions(registry, agentBridge);
  installUsageExtension(registry);
  installContinuationExtension(registry);
  installPluginReload(registry, agentBridge);
  const subagentExtension = createSubagentExtension({
    prepareChild: (parent) => subagentApi.prepareChild(parent),
    onChild: (parentId, childId) => subagentApi.onChild?.(parentId, childId),
  });
  agentBridge.extraTools = () => [
    ...(agentBridge.skillTool ? [agentBridge.skillTool] : []),
    ...(subagentExtension.tools || []),
  ];
  registry.install(subagentExtension);
  if (String(env.WEFT_FAUX_SCRIPT || '').trim()) registry.install(createScriptFloorExtension());
  const kernel = await openKernel({
    dataDir,
    models,
    registry,
    settings,
    env: async ({ cwd }) => (cwd ? createWorkspaceEnv({ cwd }) : undefined),
  });
  const { harness, context } = kernel;

  function enqueue(cid, fn) {
    const prev = tails.get(cid) || Promise.resolve();
    const run = prev.then(fn, fn);
    tails.set(cid, run.then(() => {}, () => {}));
    return run;
  }

  function push(cid, ev) {
    for (const fn of listeners.get(cid) || []) {
      try { fn(ev); } catch { /* a detached response must not stop the watch */ }
    }
  }

  async function emitAgent(cid, status, messages) {
    if (!agentHost) return;
    try {
      await agentHost.emitAgent(cid, status, messages);
    } catch (err) {
      console.error(`WEFT_KERNEL_AGENT ${redactAuthText(err instanceof Error ? err.message : err)}`);
    }
  }

  async function readView(harnessId) {
    const conversation = await harness.conversation(harnessId, context);
    if (!conversation) return null;
    const view = await conversation.viewState(context);
    try {
      return view.value;
    } finally {
      view.dispose();
    }
  }

  async function submissionView(conv) {
    // One pointer in the app index. Status is that submission's record.
    // A conversation with no pointer has not been sent a message yet.
    if (!conv?.lastSubmissionId) return { status: 'idle' };
    const handle = await harness.submission(conv.lastSubmissionId, context);
    if (!handle) {
      console.error(`WEFT_SUBMISSION_MISSING conversation=${conv.id} submission=${conv.lastSubmissionId}`);
      return {
        status: 'failed',
        llmError: { code: 'E_SUBMISSION_MISSING', message: '找不到这次运行的记录' },
      };
    }
    return statusFromSubmission(await handle.status(context));
  }

  async function readTranscript(harnessId) {
    const view = await readView(harnessId);
    if (!view) return { messages: [], usage: null, entries: [] };
    const mapped = messagesFromEntries(view.entries);
    return { ...mapped, entries: view.entries || [] };
  }

  async function deliver(cid, ev) {
    push(cid, ev);
    if (ev.event === 'status') {
      const conv = await store.getConversation(cid);
      const messages = conv?.harnessId ? (await readTranscript(conv.harnessId)).messages : [];
      await emitAgent(cid, ev.data.status, messages);
    }
  }

  async function conversationWindow(conv) {
    if (!conv || typeof getSettings !== 'function') return null;
    const settings = await getSettings();
    let grokSignedIn = false;
    if (typeof grokAuth?.status === 'function') {
      try {
        grokSignedIn = Boolean((await grokAuth.status())?.signedIn);
      } catch {
        grokSignedIn = false;
      }
    }
    return contextWindowForConversation(settings, conv, { grokSignedIn, env });
  }

  async function applyBatch(cid, batch, mapCtx) {
    const conv = await store.getConversation(cid);
    mapCtx.contextWindow = await conversationWindow(conv);
    const mapped = mapHarnessBatch(batch, mapCtx);
    for (const ev of mapped.events) await deliver(cid, ev);
    if (mapped.refresh) {
      const conv = await store.getConversation(cid);
      const status = (await submissionView(conv)).status;
      await deliver(cid, { event: 'status', data: { status } });
    }
  }

  async function attach(row) {
    if (!row?.harnessId || watches.has(row.id)) return;
    const stream = await watchEvents(harness, row.harnessId, context);
    const mapCtx = createMapContext({ retry: settings.retry });
    watches.set(row.id, { stream, mapCtx, harnessId: row.harnessId });
    stream.start((batch) => enqueue(row.id, async () => {
      try {
        await applyBatch(row.id, batch, mapCtx);
      } catch (err) {
        console.error(`WEFT_KERNEL_EVENT ${redactAuthText(err instanceof Error ? (err.stack || err.message) : err)}`);
      }
    }));
  }

  async function resolveModel(conv) {
    if (!routes || !conv?.harnessId) return;
    const conversation = await harness.conversation(conv.harnessId, context);
    if (!conversation) return;
    const model = await routes.modelFor(conv);
    await conversation.configure({ model: model ?? null }, context);
  }

  async function statusOf(conv) {
    return (await submissionView(conv)).status;
  }

  agentHost = createAgentHost({
    store,
    harness,
    context,
    registry,
    extensions,
    bridge: agentBridge,
    readTranscript,
    emit: (cid, event, data) => deliver(cid, { event, data }),
    describeAgents,
    resolveModel,
    statusOf,
  });

  function cidFor(harnessId) {
    const wanted = Number(harnessId);
    for (const [cid, watch] of watches) {
      if (Number(watch.harnessId) === wanted) return cid;
    }
    return null;
  }

  const subagents = createSubagentHost({
    store,
    harness,
    context,
    readTranscript,
    emit: (cid, event, data) => deliver(cid, { event, data }),
    watchEvents,
    cidFor,
  });
  subagentApi.prepareChild = subagents.prepareChild;
  subagentApi.onChild = subagents.onChild;
  const control = createSubagentControl({
    store,
    harness,
    context,
    listSubagents: (conv) => subagents.listSubagents(conv),
    emit: (cid, event, data) => deliver(cid, { event, data }),
  });

  const stored = await store.listKernelConversations();
  await agentHost.seed(stored);
  await subagents.seed(stored);
  for (const row of stored) await attach(row);
  await modelRoutes.warm();
  harness.resume();

  async function conversationFor(conv) {
    if (!conv?.harnessId) return null;
    return harness.conversation(conv.harnessId, context);
  }

  async function workspacePathFor(cid) {
    const conv = await store.getConversation(cid);
    return conv?.workspacePath || '';
  }

  async function diskText(workspacePath, filePath) {
    const abs = await resolveInWorkspace(workspacePath, filePath);
    try {
      const info = await stat(abs);
      if (info.size > DETAIL_CAP) {
        const err = new Error('文件过大');
        err.code = 'E_TOO_LARGE';
        throw err;
      }
      return await readFile(abs, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return '';
      throw err;
    }
  }

  async function baselinesFor(cid) {
    const conv = await store.getConversation(cid);
    if (!conv?.harnessId) return [];
    const transcript = await readTranscript(conv.harnessId);
    return baselinesFromEntries(transcript.entries);
  }

  async function createConversation(fields) {
    const conv = await store.createConversation({ ...fields });
    const created = await harness.createConversation({
      ownership: { kind: 'ownerless' },
      agent: {
        ...(faux ? { model: FAUX_MODEL } : {}),
        ...(fields.workspacePath ? { cwd: fields.workspacePath } : {}),
        tools: workspaceTools(),
      },
    }, context);
    const next = await store.updateConversation(conv.id, { harnessId: created.id });
    if (agentHost) await agentHost.afterCreate(next);
    await attach(next);
    return next;
  }

  return {
    harness,
    context,
    async close() {
      for (const watch of watches.values()) {
        try { await watch.stream.stop(); } catch { /* already stopped */ }
      }
      watches.clear();
      await subagents.close();
      await kernel.close();
    },
    async reloadPlugins() {
      if (agentHost?.reloadPlugins) await agentHost.reloadPlugins();
    },
    createConversation,
    listSubagents(conv) {
      return subagents.listSubagents(conv).then((agents) => agents.map((agent) => {
        const { harnessId, ...rest } = agent;
        return {
          ...rest,
          mode: agent.mode === 'background' ? 'background' : 'foreground',
        };
      }));
    },
    childMessages(cid, agentId) {
      return subagents.childMessages(cid, agentId);
    },
    sendToAgent(cid, agentId, text) {
      return control.sendToAgent(cid, agentId, text);
    },
    stopAgent(cid, agentId) {
      return control.stopAgent(cid, agentId);
    },
    stopConversation(cid) {
      return subagents.stopConversation(cid);
    },
    async changes(cid) {
      const workspacePath = await workspacePathFor(cid);
      const rows = [];
      for (const baseline of await baselinesFor(cid)) {
        if (baseline.oversized) {
          rows.push({
            path: baseline.path,
            added: baseline.added ?? 0,
            removed: baseline.removed ?? 0,
            toolCallId: baseline.toolCallId,
            error: '文件过大',
          });
          continue;
        }
        let disk;
        try {
          disk = await diskText(workspacePath, baseline.path);
        } catch (err) {
          if (err.code === 'E_TOO_LARGE') {
            rows.push({
              path: baseline.path,
              added: baseline.added ?? 0,
              removed: baseline.removed ?? 0,
              toolCallId: baseline.toolCallId,
              error: '文件过大',
            });
            continue;
          }
          throw err;
        }
        const diff = liveDiff({
          path: baseline.path,
          before: baseline.before ?? '',
          storedAfter: baseline.after ?? '',
          diskText: disk,
        });
        rows.push({
          path: baseline.path,
          added: diff.added,
          removed: diff.removed,
          toolCallId: baseline.toolCallId,
        });
      }
      return rows;
    },
    async diff(cid, filePath) {
      const baseline = (await baselinesFor(cid)).find((row) => row.path === filePath);
      if (!baseline) return { status: 404, body: { error: 'no diff' } };
      if (baseline.oversized) return { status: 200, body: { path: filePath, error: '文件过大' } };
      const workspacePath = await workspacePathFor(cid);
      try {
        const disk = await diskText(workspacePath, filePath);
        return {
          status: 200,
          body: liveDiff({
            path: filePath,
            before: baseline.before ?? '',
            storedAfter: baseline.after ?? '',
            diskText: disk,
          }),
        };
      } catch (err) {
        if (err.code === 'E_TOO_LARGE') return { status: 200, body: { path: filePath, error: '文件过大' } };
        throw err;
      }
    },
    async present(conv, { includeMessages = false } = {}) {
      if (!conv?.harnessId) return { ...conv, status: 'idle', messages: includeMessages ? [] : undefined };
      const transcript = await readTranscript(conv.harnessId);
      const view = await submissionView(conv);
      const status = view.status;
      const usage = presentContext(transcript.usage).usage;
      const out = { ...conv, status, usage };
      if (view.llmError) out.llmError = view.llmError;
      if (includeMessages) {
        out.messages = transcript.messages;
      }
      return out;
    },
    async postMessage(conv, text) {
      const conversation = await conversationFor(conv);
      if (!conversation) return { status: 404, body: { error: 'conversation not found' } };
      const prepared = agentHost ? await agentHost.prepareSend(conv, text) : null;
      const current = prepared?.conversation || conv;
      if (routes) {
        const model = await routes.modelFor(current);
        await conversation.configure({ model: model ?? null }, context);
      }
      const submission = await conversation.submit({
        type: 'input',
        content: text,
        requestId: prepared?.requestId || randomUUID(),
        whenBusy: 'steer',
      }, context);
      await store.updateConversation(current.id, { lastSubmissionId: submission.id });
      return { status: 202, body: { runId: String(submission.id), status: 'running' } };
    },
    async patchConversation(cid, body) {
      const conv = await store.getConversation(cid);
      if (!conv) return { status: 404, body: { error: 'conversation not found' } };
      return agentHost.patchConversation(cid, body);
    },
    subscribe(cid, fn) {
      let set = listeners.get(cid);
      if (!set) {
        set = new Set();
        listeners.set(cid, set);
      }
      set.add(fn);
      return () => {
        set.delete(fn);
        if (set.size === 0) listeners.delete(cid);
      };
    },
    async streamEvents(req, res, cid, { headers }) {
      const conv = await store.getConversation(cid);
      res.writeHead(200, {
        ...headers,
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write(':\n\n');
      const status = (await submissionView(conv)).status;
      res.write(formatSSE({ event: 'status', data: { status } }));
      const unsub = this.subscribe(cid, (ev) => {
        res.write(formatSSE({ event: ev.event, data: ev.data }));
      });
      const ping = setInterval(() => {
        try { res.write(':\n\n'); } catch { /* ignore */ }
      }, 15000);
      ping.unref?.();
      req.on('close', () => {
        clearInterval(ping);
        unsub();
      });
      return conv;
    },
  };
}
