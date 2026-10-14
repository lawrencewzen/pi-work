// HTTP facade over one Pi Durable Harness.
// Scheduling and recovery belong to the Harness (`resume`, `submit`). This module
// records the UUID row, maps watchEvents into the existing events table, and
// answers the current REST shape.
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { ConversationBusy, createRegistry, watchEvents } from '@earendil-works/pi-durable';
import { agentEventData, mapConvStatusToAgent } from '../core/agents.mjs';
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

const DEMO_RESPONSE_COUNT = 100;

export function kernelRequested(env = process.env) {
  return String(env.PI_WORK_KERNEL || '').trim() === 'durable';
}

function installDemo(models, env) {
  const faux = registerFaux(models);
  const text = String(env.PI_WORK_FAUX_TEXT || 'ok');
  const hold = String(env.PI_WORK_FAUX_HOLD || '').trim() === '1';
  const ready = String(env.PI_WORK_FAUX_HOLD_READY || '').trim();
  const step = hold
    ? async () => {
      if (ready) await writeFile(ready, 'seen');
      await new Promise(() => {});
      return fauxAssistantMessage(text);
    }
    : () => fauxAssistantMessage(text);
  faux.setResponses(Array.from({ length: DEMO_RESPONSE_COUNT }, () => step));
  return faux;
}

/**
 * Open the Harness for the conversation HTTP routes.
 * Call `harness.resume()` only after unfinished rows are marked recovering,
 * so a restarted run keeps that status until it settles.
 */
export async function openConversationKernel({ dataDir, store, demo, describeAgents, env = process.env } = {}) {
  if (!dataDir) throw new Error('dataDir is required');
  if (!store) throw new Error('store is required');
  const models = createModels();
  if (demo) installDemo(models, env);
  const registry = createRegistry();
  const kernel = await openKernel({ dataDir, models, registry });
  const { harness, context } = kernel;
  const watches = new Map();
  const tails = new Map();
  const listeners = new Map();

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
    if (typeof describeAgents !== 'function') return;
    try {
      const conv = await store.getConversation(cid);
      if (!conv) return;
      const agents = await describeAgents({ ...conv, status }, messages || []);
      const agent = Array.isArray(agents) ? agents[0] : null;
      const data = agentEventData(agent, mapConvStatusToAgent(status));
      if (!data) return;
      await emit(cid, 'agent', data);
    } catch (err) {
      console.error(`PI_WORK_KERNEL_AGENT ${err instanceof Error ? err.message : err}`);
    }
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
    for (const ev of mapped.events) {
      if (ev.event === 'status') await emitStatus(cid, ev.data.status, omitStatus(ev.data));
      else await emit(cid, ev.event, ev.data);
    }
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
    for (const ev of gap) {
      if (ev.event === 'status') await emitStatus(cid, ev.data.status, omitStatus(ev.data));
      else await emit(cid, ev.event, ev.data);
    }
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
        console.error(`PI_WORK_KERNEL_EVENT ${err instanceof Error ? err.stack : err}`);
      }
    }));
  }

  async function settleStored(row) {
    if (await unfinished(row.harnessId)) {
      await store.updateConversation(row.id, { status: 'recovering', hostMark: 'recovering' });
      await emitStatus(row.id, 'recovering', { autoContinues: row.autoContinues || 0 });
      return;
    }
    if (row.status !== 'running' && row.status !== 'recovering' && row.hostMark !== 'recovering') return;
    const view = await readView(row.harnessId);
    const lastAssistant = [...(view?.entries || [])].reverse().find((entry) => entry.kind === 'pi.assistant');
    const failed = lastAssistant?.model?.[0]?.stopReason === 'error';
    await store.updateConversation(row.id, { status: failed ? 'failed' : 'done', hostMark: null });
  }

  const stored = await store.listKernelConversations();
  for (const row of stored) await attach(row);
  for (const row of stored) await settleStored(row);
  harness.resume();

  async function conversationFor(conv) {
    if (!conv?.harnessId) return null;
    return harness.conversation(conv.harnessId, context);
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
    async createConversation(fields) {
      const conv = await store.createConversation({ ...fields, status: 'idle' });
      const created = await harness.createConversation({
        ownership: { kind: 'ownerless' },
        ...(demo ? { agent: { model: FAUX_MODEL } } : {}),
      }, context);
      const next = await store.updateConversation(conv.id, { harnessId: created.id, status: 'idle' });
      await attach(next);
      return next;
    },
    async present(conv, { includeMessages = false } = {}) {
      if (!conv?.harnessId) {
        const idle = { ...conv, status: synthesizeStatus(conv, false), usage: conv.usage || null };
        if (includeMessages) idle.messages = [];
        return idle;
      }
      const transcript = await readTranscript(conv.harnessId);
      const status = synthesizeStatus(conv, transcript.busy);
      const usage = presentContext(transcript.usage || conv.usage).usage;
      const out = { ...conv, status, usage };
      if (includeMessages) out.messages = transcript.messages;
      return out;
    },
    async postMessage(conv, text) {
      const conversation = await conversationFor(conv);
      if (!conversation) {
        return { status: 409, body: { error: 'err_send_blocked', status: conv?.status || 'stopped' } };
      }
      try {
        const submission = await conversation.submit({
          type: 'input',
          content: text,
          requestId: randomUUID(),
          whenBusy: 'reject',
        }, context);
        return { status: 202, body: { runId: String(submission.id), status: 'running' } };
      } catch (err) {
        if (err instanceof ConversationBusy) {
          return { status: 409, body: { error: 'err_send_blocked', status: 'running' } };
        }
        throw err;
      }
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
