// HTTP facade over one Pi Durable Harness.
// Scheduling and recovery belong to the Harness (`resume`, `submit`). This module
// records the UUID row, maps watchEvents into the existing events table, and
// answers the current REST shape.
import { randomUUID } from 'node:crypto';
import { appendFile, writeFile } from 'node:fs/promises';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { getCurrentTools } from '@earendil-works/pi-ai/utils/transcript';
import { ConversationBusy, createRegistry, watchEvents } from '@earendil-works/pi-durable';
import { redactAuthText } from '../core/grok-auth.mjs';
import { formatSSE } from '../core/sse.mjs';
import { presentContext } from '../core/usage.mjs';
import {
  createMapContext,
  mapHarnessBatch,
  messagesFromEntries,
  snapshotGap,
  synthesizeStatus,
} from './events.mjs';
import { FAUX_MODEL, openKernel, registerFaux } from './index.mjs';
import { createKernelModels, explicitDemo } from './models.mjs';
import {
  archivedMutation,
  installArchiveExtension,
  isArchivedConversation,
  openFromHistory,
  presentArchived,
} from './archive.mjs';
import { installPluginReload } from './plugins.mjs';
import { createRoleHost, installRoleExtensions } from './roles.mjs';
import { createWorkspaceExtension, scriptedDemoStep, toolsForRole } from './tools.mjs';
import { installUsageExtension } from './usage.mjs';

const DEMO_RESPONSE_COUNT = 100;

export function kernelRequested(env = process.env) {
  return String(env.PI_WORK_KERNEL || '').trim() === 'durable';
}

function parseFauxPlan(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('PI_WORK_FAUX_PLAN must be a non-empty JSON array');
  }
  return parsed.map((item) => {
    if (item === 'hold') return 'hold';
    if (typeof item === 'string') return item;
    throw new Error('PI_WORK_FAUX_PLAN items must be strings');
  });
}

function replayedSections(messages) {
  const shown = new Map();
  for (const message of messages || []) {
    if (message?.role !== 'system' || !message.sections) continue;
    for (const [key, value] of Object.entries(message.sections)) {
      if (value === null) shown.delete(key);
      else shown.set(key, value);
    }
  }
  return [...shown.entries()].map(([key, value]) => ({ key, value }));
}

function requestSnapshot(context) {
  const messages = context?.messages || [];
  return {
    sections: replayedSections(messages),
    tools: getCurrentTools(messages).map((tool) => tool.name),
    users: messages.filter((message) => message?.role === 'user').map((message) => (
      typeof message.content === 'string' ? message.content : ''
    )),
  };
}

function installDemo(models, env) {
  const faux = registerFaux(models);
  const text = String(env.PI_WORK_FAUX_TEXT || 'ok');
  const holdAll = String(env.PI_WORK_FAUX_HOLD || '').trim() === '1';
  const ready = String(env.PI_WORK_FAUX_HOLD_READY || '').trim();
  const scriptPath = String(env.PI_WORK_FAUX_SCRIPT || '').trim();
  const recordPath = String(env.PI_WORK_FAUX_RECORD || '').trim();
  const plan = holdAll ? null : parseFauxPlan(env.PI_WORK_FAUX_PLAN);
  // Hold still wins: a script or plan must not replace the in-flight model call used by recovery tests.
  const scripted = !holdAll && !plan && scriptPath ? scriptedDemoStep(scriptPath, env) : null;
  let cursor = 0;
  const step = async (context) => {
    if (recordPath) await appendFile(recordPath, `${JSON.stringify(requestSnapshot(context))}\n`);
    if (holdAll) {
      if (ready) await writeFile(ready, 'seen');
      await new Promise(() => {});
      return fauxAssistantMessage(text);
    }
    if (plan) {
      const item = plan[Math.min(cursor, plan.length - 1)];
      cursor += 1;
      if (item === 'hold') {
        if (ready) await writeFile(ready, 'seen');
        await new Promise(() => {});
      }
      return fauxAssistantMessage(item);
    }
    if (scripted) return scripted(context);
    return fauxAssistantMessage(text);
  };
  faux.setResponses(Array.from({ length: DEMO_RESPONSE_COUNT }, () => step));
  return faux;
}

/**
 * Open the Harness for the conversation HTTP routes.
 * Call `harness.resume()` only after unfinished rows are marked recovering,
 * so a restarted run keeps that status until it settles.
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
  const routes = faux ? null : createKernelModels({ models, getSettings, grokAuth, env });
  const registry = createRegistry();
  const roleBridge = {};
  const watches = new Map();
  const tails = new Map();
  const listeners = new Map();
  let roles;

  async function conversationIdFor(harnessId) {
    const wanted = Number(harnessId);
    for (const [cid, watch] of watches) {
      if (Number(watch.harnessId) === wanted) return cid;
    }
    const rows = await store.listKernelConversations();
    return rows.find((row) => Number(row.harnessId) === wanted)?.id ?? null;
  }

  registry.install(createWorkspaceExtension({
    onWrote: async (info) => {
      const cid = await conversationIdFor(info.harnessId);
      if (!cid) throw new Error(`no conversation for harness ${info.harnessId}`);
      watches.get(cid)?.mapCtx.toolDiffs.set(info.toolCallId, {
        added: info.added,
        removed: info.removed,
      });
      await store.addChange({
        conversationId: cid,
        path: info.path,
        before: info.before,
        after: info.after,
        added: info.added,
        removed: info.removed,
        toolCallId: info.toolCallId,
      });
    },
  }));
  installRoleExtensions(registry, roleBridge);
  installArchiveExtension(registry);
  installUsageExtension(registry);
  installPluginReload(registry, roleBridge);
  const kernel = await openKernel({ dataDir, models, registry });
  const { harness, context } = kernel;

  function enqueue(cid, fn) {
    const prev = tails.get(cid) || Promise.resolve();
    const run = prev.then(fn, fn);
    tails.set(cid, run.then(() => {}, () => {}));
    return run;
  }

  function notify(cid, row) {
    for (const fn of listeners.get(cid) || []) {
      try { fn(row); } catch { /* a detached response must not stop the watch */ }
    }
  }

  async function emit(cid, event, data) {
    const row = await store.appendEvent(cid, { event, data });
    notify(cid, row);
    return row;
  }

  async function emitAgent(cid, status, messages) {
    if (!roles) return;
    try {
      await roles.emitAgent(cid, status, messages);
    } catch (err) {
      console.error(`PI_WORK_KERNEL_AGENT ${redactAuthText(err instanceof Error ? err.message : err)}`);
    }
  }

  async function deliver(cid, ev) {
    if (roles && ev.event === 'status' && ev.data?.status === 'done') {
      const action = await roles.onRunFinished(cid);
      if (action !== 'continue') return;
    }
    if (ev.event === 'status') await emitStatus(cid, ev.data.status, omitStatus(ev.data));
    else await emit(cid, ev.event, ev.data);
  }

  async function emitStatus(cid, status, extra = {}) {
    const conv = await store.getConversation(cid);
    if (status === 'running' && conv?.hostMark === 'recovering') return;
    const patch = { status };
    if (status === 'done' || status === 'failed') patch.hostMark = null;
    if (status === 'recovering') patch.hostMark = 'recovering';
    if (conv) await store.updateConversation(cid, patch);
    await emit(cid, 'status', { status, ...extra });
    const messages = conv?.harnessId ? (await readTranscript(conv.harnessId)).messages : [];
    await emitAgent(cid, status, messages);
  }

  async function readView(harnessId) {
    const conversation = await harness.conversation(harnessId, context);
    if (!conversation) return null;
    const view = await conversation.viewState(context);
    try {
      const value = view.value;
      return {
        entries: value?.entries || [],
        live: value?.docs?.['pi.live'] || {},
      };
    } finally {
      view.dispose();
    }
  }

  async function readTranscript(harnessId) {
    const view = await readView(harnessId);
    if (!view) return { messages: [], usage: null, busy: false };
    const mapped = messagesFromEntries(view.entries);
    return { ...mapped, busy: Boolean(view.live?.run) };
  }

  async function submissionBlocked(harnessId) {
    const view = await readView(harnessId);
    if (view?.live?.run) return true;
    const inspection = await harness.inspect(context);
    return inspection.submissions.some((record) => (
      record.conversationId === harnessId && (record.status === 'queued' || record.status === 'placed')
    ));
  }

  async function unfinished(harnessId) {
    const inspection = await harness.inspect(context);
    const submission = inspection.submissions.some((record) => (
      record.conversationId === harnessId && (record.status === 'queued' || record.status === 'placed')
    ));
    const task = inspection.tasks.some((item) => item.record.conversationId === harnessId);
    return submission || task;
  }

  async function applyBatch(cid, batch, mapCtx) {
    const mapped = mapHarnessBatch(batch, mapCtx);
    for (const ev of mapped.events) await deliver(cid, ev);
    for (const snapshot of mapped.snapshots) await fillSnapshot(cid, snapshot, mapCtx);
    if (mapped.events.some((ev) => ev.event === 'checkpoint')) {
      const last = [...mapped.events].reverse().find((ev) => ev.event === 'checkpoint');
      if (last) {
        await store.updateConversation(cid, {
          lastCheckpointAt: last.data.at,
          currentStep: last.data.step,
        });
      }
    }
    const usage = [...mapped.events].reverse().find((ev) => ev.event === 'usage');
    if (usage?.data?.usage) await store.updateConversation(cid, { usage: usage.data.usage });
  }

  async function fillSnapshot(cid, snapshot, mapCtx) {
    const existing = await store.getEvents(cid);
    const gap = snapshotGap(snapshot, existing, mapCtx);
    for (const ev of gap) await deliver(cid, ev);
  }

  async function attach(row) {
    if (!row?.harnessId || watches.has(row.id)) return;
    const stream = await watchEvents(harness, row.harnessId, context);
    const mapCtx = createMapContext({ step: row.currentStep || 0 });
    watches.set(row.id, { stream, mapCtx, harnessId: row.harnessId });
    await enqueue(row.id, () => fillSnapshot(row.id, stream.snapshot, mapCtx));
    stream.start((batch) => enqueue(row.id, async () => {
      try {
        await applyBatch(row.id, batch, mapCtx);
      } catch (err) {
        console.error(`PI_WORK_KERNEL_EVENT ${redactAuthText(err instanceof Error ? (err.stack || err.message) : err)}`);
      }
    }));
  }

  async function settleStored(row) {
    if (await unfinished(row.harnessId)) {
      await store.updateConversation(row.id, { status: 'recovering', hostMark: 'recovering' });
      await emitStatus(row.id, 'recovering', { autoContinues: row.autoContinues || 0 });
      return;
    }
    if (roles && await roles.pipelinePending(row)) return;
    if (row.status !== 'running' && row.status !== 'recovering' && row.hostMark !== 'recovering') return;
    const view = await readView(row.harnessId);
    const lastAssistant = [...(view?.entries || [])].reverse().find((entry) => entry.kind === 'pi.assistant');
    const failed = lastAssistant?.model?.[0]?.stopReason === 'error';
    await store.updateConversation(row.id, { status: failed ? 'failed' : 'done', hostMark: null });
  }

  async function resolveModel(conv, role) {
    if (!routes || !conv?.harnessId) return;
    const conversation = await harness.conversation(conv.harnessId, context);
    if (!conversation) return;
    const roleId = role?.id || conv.roleId;
    const model = await routes.modelFor({ ...conv, roleId });
    await conversation.configure({ model: model ?? null }, context);
  }

  roles = createRoleHost({
    store,
    harness,
    context,
    registry,
    extensions,
    bridge: roleBridge,
    readTranscript,
    emit,
    describeAgents,
    resolveModel,
  });

  const stored = await store.listKernelConversations();
  await roles.seed(stored);
  for (const row of stored) await attach(row);
  for (const row of stored) await settleStored(row);
  harness.resume();
  for (const row of stored) await roles.reconcile(row);

  async function conversationFor(conv) {
    if (!conv?.harnessId) return null;
    return harness.conversation(conv.harnessId, context);
  }

  async function createConversation(fields) {
    const conv = await store.createConversation({ ...fields, status: 'idle' });
    const role = (fields.roleId && await store.getRole(fields.roleId)) || await store.getRole('default');
    const created = await harness.createConversation({
      ownership: { kind: 'ownerless' },
      agent: {
        ...(faux ? { model: FAUX_MODEL } : {}),
        ...(fields.workspacePath ? { cwd: fields.workspacePath } : {}),
        tools: toolsForRole(role),
      },
    }, context);
    const next = await store.updateConversation(conv.id, { harnessId: created.id, status: 'idle' });
    if (roles) await roles.afterCreate(next);
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
      await kernel.close();
    },
    async reloadPlugins() {
      if (roles?.reloadPlugins) await roles.reloadPlugins();
    },
    createConversation,
    async present(conv, { includeMessages = false } = {}) {
      if (isArchivedConversation(conv)) {
        const messages = includeMessages ? await store.getMessages(conv.id) : undefined;
        return presentArchived(conv, { includeMessages, messages });
      }
      const transcript = await readTranscript(conv.harnessId);
      const status = synthesizeStatus(conv, transcript.busy);
      const usage = presentContext(transcript.usage || conv.usage).usage;
      const out = { ...conv, status, usage };
      if (includeMessages) {
        out.messages = roles ? await roles.annotate(conv, transcript.messages) : transcript.messages;
      }
      return out;
    },
    async postMessage(conv, text) {
      if (isArchivedConversation(conv)) return archivedMutation();
      const conversation = await conversationFor(conv);
      if (!conversation) {
        return { status: 409, body: { error: 'err_send_blocked', status: conv?.status || 'stopped' } };
      }
      try {
        if (await submissionBlocked(conv.harnessId)) {
          return { status: 409, body: { error: 'err_send_blocked', status: 'running' } };
        }
        const prepared = roles ? await roles.prepareSend(conv, text) : null;
        const current = prepared?.conversation || conv;
        if (routes) {
          const model = await routes.modelFor(current);
          await conversation.configure({ model: model ?? null }, context);
        }
        const submission = await conversation.submit({
          type: 'input',
          content: text,
          requestId: prepared?.requestId || randomUUID(),
          whenBusy: 'reject',
        }, context);
        return { status: 202, body: { runId: String(submission.id), status: 'running' } };
      } catch (err) {
        if (err instanceof ConversationBusy) {
          return { status: 409, body: { error: 'err_send_blocked', status: 'running' } };
        }
        if (err instanceof Error && err.message) err.message = redactAuthText(err.message);
        throw err;
      }
    },
    async patchConversation(cid, body) {
      const conv = await store.getConversation(cid);
      if (!conv) return { status: 404, body: { error: 'conversation not found' } };
      if (isArchivedConversation(conv)) return archivedMutation();
      return roles.patchConversation(cid, body);
    },
    continueFromHistory(conv, { title } = {}) {
      return openFromHistory({ conv, title, store, harness, context, createConversation });
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
      const watch = watches.get(cid);
      if (watch) {
        const view = await readView(watch.harnessId);
        const snapshot = {
          entries: view?.entries || [],
          generation: view?.live?.generation,
          tools: view?.live?.tools || [],
        };
        await enqueue(cid, () => fillSnapshot(cid, snapshot, watch.mapCtx));
      }
      const last = req.headers['last-event-id'];
      const afterId = last != null && last !== '' ? Number(last) : 0;
      res.writeHead(200, {
        ...headers,
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write(':\n\n');
      const pending = [];
      let replaying = true;
      const unsub = this.subscribe(cid, (ev) => {
        if (replaying) pending.push(ev);
        else res.write(formatSSE({ id: ev.id, event: ev.event, data: ev.data }));
      });
      const past = await store.getEvents(cid, { afterId: Number.isFinite(afterId) ? afterId : 0 });
      const seen = new Set();
      for (const ev of past) {
        seen.add(ev.id);
        res.write(formatSSE({ id: ev.id, event: ev.event, data: ev.data }));
      }
      replaying = false;
      for (const ev of pending) {
        if (seen.has(ev.id)) continue;
        seen.add(ev.id);
        res.write(formatSSE({ id: ev.id, event: ev.event, data: ev.data }));
      }
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

function omitStatus(data) {
  const extra = { ...data };
  delete extra.status;
  return extra;
}
