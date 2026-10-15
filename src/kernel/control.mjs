// Pause, stall, retry alignment, and per-step tool limits for the Pi Durable kernel.
// The Harness still runs the model and the tools. This module only sets a
// conversation document, returns hook decisions, and arms a timer that submits
// one「继续」when a run goes quiet. It does not schedule tasks or keep checkpoints.
import { randomUUID } from 'node:crypto';
import { isRetryableAssistantError } from '@earendil-works/pi-ai/utils/retry';
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import {
  AssistantEntry,
  ConversationBusy,
  defineDoc,
  defineExtension,
  GenerationTask,
  hook,
  ProviderDoc,
  ToolTask,
  wrapTool,
} from '@earendil-works/pi-durable';
import {
  explorePathOf,
  exploreTarget,
  toolSignature,
} from '../core/explore.mjs';
import { createRetryPolicy, decideAutoContinue } from '../core/retry.mjs';
import { archivedMutation, isArchivedConversation } from './archive.mjs';
import { messagesFromEntries, textOf } from './events.mjs';
import { Roster } from './subagents.mjs';
import { loadScriptTurns, noteScriptAssistants, scriptMessages, scriptShouldContinue } from './faux-script.mjs';
import { workspaceTools } from './tools.mjs';

const CONTINUE_TEXT = '继续';
const STREAM_NOTE = '模型连接中断。已按完成的工具结果结束本步。';
const WRAPPED = new Set(['read', 'write', 'edit', 'ls', 'grep', 'bash']);
const WIDE_RETRY = createRetryPolicy({ maxAttempts: 100, baseMs: 1, maxMs: 30_000 });

export const ControlDoc = defineDoc({
  kind: 'pi-work.control',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'current',
  initial: () => blankControl(),
});

export function blankControl() {
  return {
    paused: false,
    stopped: false,
    gaveUp: false,
    autoContinues: 0,
    lastProgressAt: 0,
    step: 0,
    toolSig: '',
    toolSigCount: 0,
    toolCallsThisStep: 0,
    loopCorrectedSig: '',
    sawTextThisStep: false,
    nudged: false,
    exploreCounts: {},
    exploreCorrected: {},
  };
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function controlLimits(env = process.env) {
  return {
    stallMs: positiveInt(env.PI_WORK_STALL_MS, 120_000),
    maxAutoContinues: positiveInt(env.PI_WORK_MAX_AUTO_CONTINUES, 10),
    toolCap: positiveInt(env.PI_WORK_MAX_TOOL_CALLS, 15),
    loopLimit: positiveInt(env.PI_WORK_TOOL_LOOP, 3),
    nudgeAfter: positiveInt(env.PI_WORK_TOOL_NUDGE, 8),
    exploreLimit: positiveInt(env.PI_WORK_EXPLORE_REPEAT, 2),
  };
}

/** settings.retry for Harness.open. maxRetries is one less than the old maxAttempts. */
export function kernelRetryPolicy(env = process.env) {
  const maxAttempts = positiveInt(env.PI_WORK_RETRY_MAX, 5);
  return {
    enabled: true,
    maxRetries: Math.max(0, maxAttempts - 1),
    baseDelayMs: positiveInt(env.PI_WORK_RETRY_BASE_MS, 200),
    maxAgentDelayMs: 30_000,
  };
}

function httpStatus(text) {
  const hits = [...String(text).matchAll(/\b(400|401|403|429|[5]\d\d)\b/g)].map((match) => Number(match[1]));
  return hits.find((status) => status === 400 || status === 401 || status === 403) ?? hits[0];
}

function errorCode(text) {
  const match = String(text).match(/\b(ETIMEDOUT|ECONNRESET|E_STREAM_CUT|E_EMPTY_OUTPUT|E_SANDBOX|E_ABORTED|E_NO_MODEL)\b/);
  return match ? match[1] : undefined;
}

function droppedStream(err) {
  if (!err) return false;
  if (err.code === 'E_NO_MODEL' || err.code === 'E_ABORTED' || err.code === 'E_SANDBOX') return false;
  if (err.status === 400 || err.status === 401 || err.status === 403) return false;
  if (err.code === 'E_STREAM_CUT' || err.code === 'E_EMPTY_OUTPUT' || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT') {
    return true;
  }
  return /terminated/i.test(String(err.message || ''));
}

function asRetryError(text) {
  const err = new Error(text);
  const status = httpStatus(text);
  const code = errorCode(text);
  if (status) err.status = status;
  if (code) err.code = code;
  return err;
}

/** True when the old orchestrator would retry this assistant error. */
export function wantsRetry(message) {
  if (!message || message.stopReason === 'aborted') return false;
  const text = String(message.errorMessage || '');
  const err = asRetryError(text);
  if (WIDE_RETRY.shouldRetry(err, 1)) return true;
  if (!droppedStream(err)) return false;
  return WIDE_RETRY.shouldRetry(Object.assign(new Error(text || 'terminated'), { code: 'E_STREAM_CUT' }), 1);
}

/**
 * Make pi-ai's retry classifier agree with shouldRetry.
 * A non-retryable message that still matches the classifier is rewritten so the
 * next attempt is not sent. A retryable message the classifier misses gets a
 * timeout marker the classifier already treats as transient.
 */
export function alignRetryMessage(message) {
  if (!message || message.stopReason !== 'error') return message;
  const retryable = wantsRetry(message);
  const classified = isRetryableAssistantError(message);
  if (!retryable && classified) message.errorMessage = 'blocked retry';
  else if (retryable && !classified) {
    const text = String(message.errorMessage || '').trim();
    message.errorMessage = text ? `${text} timeout` : 'timeout';
  }
  return message;
}

export function decideToolCall(doc, call, limits) {
  const name = String(call?.name || '');
  const args = call?.arguments && typeof call.arguments === 'object' ? call.arguments : {};
  const sig = toolSignature(name, args);
  const target = exploreTarget(name, args);
  const state = doc || blankControl();
  if ((state.toolCallsThisStep || 0) >= limits.toolCap) {
    return { kind: 'finish', text: `本步工具调用已达上限（${limits.toolCap}），已停止继续调用工具。` };
  }
  if (sig === state.toolSig && (state.toolSigCount || 0) >= limits.loopLimit) {
    if (state.loopCorrectedSig === sig) {
      return { kind: 'finish', text: `仍在用相同参数重复调用「${name}」，本步已停止。` };
    }
    return {
      kind: 'correct',
      code: 'loop',
      sig,
      text: `停止调用工具。你已经用相同参数连续调用「${name}」${limits.loopLimit} 次。请根据已有结果直接回答，不要再调用工具。`,
    };
  }
  if (target && (state.exploreCounts?.[target] || 0) >= limits.exploreLimit) {
    const pathLabel = explorePathOf(target);
    if (state.exploreCorrected?.[target]) {
      return { kind: 'finish', text: `仍在重复查看「${pathLabel}」，本步已停止。` };
    }
    return {
      kind: 'correct',
      code: 'explore',
      target,
      text: `不要再重复查看同一路径。你已经用「${name}」查看「${pathLabel}」${limits.exploreLimit} 次。请根据已有结果直接回答，或说明还缺什么。`,
    };
  }
  if ((state.toolCallsThisStep || 0) >= limits.nudgeAfter && !state.sawTextThisStep && !state.nudged) {
    return {
      kind: 'correct',
      code: 'nudge',
      text: `请根据已有结果直接回答。本步已经调用了 ${state.toolCallsThisStep} 次工具，还没有写出回复。用已经看到的内容回答；如果还缺关键信息，直接说明缺什么，不要继续翻找。`,
    };
  }
  return null;
}

function applyCorrection(doc, decision) {
  if (decision.code === 'loop') doc.loopCorrectedSig = decision.sig;
  else if (decision.code === 'explore') {
    doc.exploreCorrected = { ...(doc.exploreCorrected || {}), [decision.target]: true };
  } else if (decision.code === 'nudge') doc.nudged = true;
}

function recordTool(doc, call) {
  const name = String(call?.name || '');
  const args = call?.arguments && typeof call.arguments === 'object' ? call.arguments : {};
  const sig = toolSignature(name, args);
  const target = exploreTarget(name, args);
  if (sig === doc.toolSig) doc.toolSigCount = (Number(doc.toolSigCount) || 0) + 1;
  else {
    doc.toolSig = sig;
    doc.toolSigCount = 1;
    doc.loopCorrectedSig = '';
  }
  if (target) {
    const counts = { ...(doc.exploreCounts || {}) };
    counts[target] = (Number(counts[target]) || 0) + 1;
    doc.exploreCounts = counts;
  }
  doc.toolCallsThisStep = (Number(doc.toolCallsThisStep) || 0) + 1;
}

export function resetBudget(doc) {
  doc.toolSig = '';
  doc.toolSigCount = 0;
  doc.toolCallsThisStep = 0;
  doc.loopCorrectedSig = '';
  doc.sawTextThisStep = false;
  doc.nudged = false;
  doc.exploreCounts = {};
  doc.exploreCorrected = {};
}

/**
 * One stall check against a control document. Mutates `doc` when it continues,
 * gives up, or records the first progress time. `status` must be `running`.
 */
export function applyStallClaim(doc, { now, stallMs, status, maxAutoContinues, progressAt = 0 } = {}) {
  const progress = Math.max(Number(doc.lastProgressAt) || 0, Number(progressAt) || 0);
  if (!progress) {
    doc.lastProgressAt = now;
    return { decision: 'wait', progressAt: now, changed: true };
  }
  if (doc.paused || doc.stopped || doc.gaveUp) return { decision: 'wait', progressAt: progress, changed: false };
  const decision = decideAutoContinue({
    lastProgressAt: progress,
    now,
    stallMs,
    status,
    autoContinues: Number(doc.autoContinues) || 0,
    maxAutoContinues,
  });
  if (decision === 'continue') {
    doc.autoContinues = (Number(doc.autoContinues) || 0) + 1;
    doc.lastProgressAt = now;
    return { decision, autoContinues: doc.autoContinues, progressAt: now, changed: true };
  }
  if (decision === 'give_up') {
    doc.gaveUp = true;
    return { decision, progressAt: progress, changed: true };
  }
  return { decision: 'wait', progressAt: progress, changed: false };
}

export function correctionText(output) {
  const raw = String(output || '');
  const marker = 'Tool call blocked: ';
  const at = raw.indexOf(marker);
  if (at < 0) return '';
  let text = raw.slice(at + marker.length);
  const end = text.search(/\n<\/harness>/);
  if (end >= 0) text = text.slice(0, end);
  return text.trim();
}

/** GET messages: hide finish sentinels and show blocked calls as correction notes. */
export function projectTranscript(entries) {
  const base = messagesFromEntries(entries);
  const hidden = new Set();
  const corrections = new Map();
  // Parallel tool calls in one assistant message can each be blocked with the
  // same note. The model still has every tool result; the thread shows the first.
  let assistantId = '';
  const seenCorrection = new Set();
  for (const entry of entries || []) {
    if (entry?.kind === 'pi.assistant') {
      assistantId = String(entry.id);
      continue;
    }
    if (entry?.kind !== 'pi.tool-result') continue;
    const result = entry.model?.[0];
    if (!result) continue;
    const id = String(entry.id);
    if (result.details?.piWorkControl === 'finish') {
      hidden.add(id);
      continue;
    }
    const note = correctionText(textOf(result.content));
    if (!note) continue;
    const key = `${assistantId}\0${note}`;
    if (seenCorrection.has(key)) {
      hidden.add(id);
      continue;
    }
    seenCorrection.add(key);
    corrections.set(id, note);
  }
  const messages = [];
  for (const message of base.messages) {
    if (hidden.has(message.id)) continue;
    if (corrections.has(message.id)) {
      messages.push({
        id: message.id,
        role: 'user',
        kind: 'correction',
        text: corrections.get(message.id),
      });
      continue;
    }
    messages.push(message);
  }
  return { messages, usage: base.usage };
}

function plainDoc(snap) {
  const base = blankControl();
  if (!snap) return base;
  return {
    ...base,
    ...snap,
    exploreCounts: { ...(snap.exploreCounts || {}) },
    exploreCorrected: { ...(snap.exploreCorrected || {}) },
  };
}

function withPause(result, paused) {
  if (!paused) return result;
  return {
    ...result,
    control: { ...(result?.control || {}), terminate: true },
  };
}

/**
 * Hooks and tool wrappers. `bridge` is filled by createControlHost before the
 * Harness resumes, the same way role extensions share their bridge.
 */
export function createControlExtension(bridge) {
  const limitsOf = () => bridge.limits || controlLimits();

  async function conversationId(api) {
    if (typeof bridge.conversationIdFor !== 'function') return null;
    return bridge.conversationIdFor(api.conversationId);
  }

  return defineExtension({
    name: 'pi-work-control',
    hooks: [
      hook(GenerationTask, {
        async beforeRequest(_request, api, context) {
          const cid = await conversationId(api);
          const conv = cid && bridge.store ? await bridge.store.getConversation(cid) : null;
          const step = Number(conv?.pipelineStep) || 0;
          await api.commit(async (tx) => {
            const doc = await tx.doc(ControlDoc, api.conversationId);
            if ((Number(doc.step) || 0) !== step) {
              resetBudget(doc);
              doc.step = step;
            }
            if (!doc.lastProgressAt) doc.lastProgressAt = Date.now();
            return undefined;
          }, context);
          bridge.touch?.(cid, Date.now());
          try {
            const provider = await api.snapshot(ProviderDoc, api.conversationId, context);
            const sessionId = provider?.sessionId;
            if (sessionId && typeof api.context === 'function') {
              const full = await api.context(api.conversationId, context);
              const count = (full?.entries || []).filter((entry) => entry?.kind === AssistantEntry.kind).length;
              noteScriptAssistants(sessionId, count);
            }
          } catch { /* the demo script still follows the messages on the request */ }
        },
        async afterResponse(message, api, context) {
          alignRetryMessage(message);
          const text = textOf(message?.content);
          const calls = Array.isArray(message?.content)
            && message.content.some((block) => block?.type === 'toolCall');
          if (text && !calls) {
            await api.commit(async (tx) => {
              const doc = await tx.doc(ControlDoc, api.conversationId);
              doc.sawTextThisStep = true;
              doc.toolSig = '';
              doc.toolSigCount = 0;
              doc.loopCorrectedSig = '';
              return undefined;
            }, context);
          }
          const cid = await conversationId(api);
          bridge.touch?.(cid, Date.now());
        },
        async onYield(answer, api, context) {
          const snap = plainDoc(await api.snapshot(ControlDoc, api.conversationId, context));
          if (snap?.paused || snap?.stopped || snap?.gaveUp) return undefined;
          // Demo scripts stop on a text answer, matching a real model. PI_WORK_FAUX_DRAIN
          // keeps going into the next tool or `{end:true}`, which is how the old loop
          // played fixtures such as basic.json in one user message.
          const drain = String(bridge.env?.PI_WORK_FAUX_DRAIN || '') === '1';
          const turns = drain ? loadScriptTurns(bridge.env) : null;
          if (turns && typeof api.context === 'function') {
            const full = await api.context(api.conversationId, context);
            const messages = scriptMessages(full?.entries || [], answer);
            if (scriptShouldContinue(turns, { messages })) return { continue: CONTINUE_TEXT };
          }
          if (typeof bridge.claimYield !== 'function') return undefined;
          const cid = await conversationId(api);
          if (!cid) return undefined;
          return bridge.claimYield(cid, api, context);
        },
      }),
      hook(ToolTask, {
        async beforeTool(call, api, context) {
          const snap = plainDoc(await api.snapshot(ControlDoc, api.conversationId, context));
          const decision = decideToolCall(snap, call, limitsOf());
          if (!decision) return undefined;
          if (decision.kind === 'finish' && WRAPPED.has(call.name)) {
            await api.memo('piWorkDecision', { kind: 'finish', text: decision.text }, context);
            return undefined;
          }
          if (decision.kind === 'correct') {
            await api.commit(async (tx) => {
              const doc = await tx.doc(ControlDoc, api.conversationId);
              applyCorrection(doc, decision);
              return undefined;
            }, context);
          }
          return { block: decision.text };
        },
        async afterTool(call, result, api, context) {
          const marker = result?.details?.piWorkControl;
          const snap = await api.snapshot(ControlDoc, api.conversationId, context);
          if (marker === 'finish') return withPause(result, snap?.paused);
          await api.commit(async (tx) => {
            const doc = await tx.doc(ControlDoc, api.conversationId);
            recordTool(doc, call);
            return undefined;
          }, context);
          const cid = await conversationId(api);
          bridge.touch?.(cid, Date.now());
          const paused = snap?.paused || (await api.snapshot(ControlDoc, api.conversationId, context))?.paused;
          return withPause(result, paused);
        },
      }),
    ],
    wraps: workspaceTools().map((tool) => wrapTool(tool, (inner) => ({
      ...inner,
      async execute(args, api, context) {
        const decision = await api.memo('piWorkDecision', context);
        if (decision?.kind === 'finish') {
          const text = String(decision.text || '');
          await api.commit(async (tx) => {
            await tx.appendEntry(AssistantEntry, api.conversationId, {
              model: [fauxAssistantMessage(text)],
            });
          }, context);
          return {
            content: [{ type: 'text', text: '' }],
            details: { piWorkControl: 'finish', text },
            control: { terminate: true },
          };
        }
        return inner.execute(args, api, context);
      },
    }))),
  });
}

function successfulTool(messages) {
  return (messages || []).some((message) => message?.role === 'tool' && message.tool?.status !== 'error');
}

/**
 * Host side of pause, resume, stop, and the stall timer.
 * `emit` writes an SSE row. Status changes go through `emit` directly when the
 * host mark must stay put.
 */
export function createControlHost({
  harness,
  context,
  store,
  bridge,
  emit,
  readTranscript,
  isBusy,
  env = process.env,
} = {}) {
  if (!harness) throw new Error('harness is required');
  if (!store) throw new Error('store is required');
  if (!bridge) throw new Error('bridge is required');
  const limits = controlLimits(env);
  const retryPolicy = kernelRetryPolicy(env);
  const progress = new Map();
  const softening = new Set();
  const softened = new Set();
  bridge.limits = limits;
  bridge.store = store;
  bridge.env = env;
  bridge.touch = (cid, at = Date.now()) => {
    if (cid) progress.set(cid, at);
  };

  async function conversationFor(conv) {
    if (!conv?.harnessId) return null;
    return harness.conversation(conv.harnessId, context);
  }

  async function claimOnDoc(cid, doc, status) {
    const outcome = applyStallClaim(doc, {
      now: Date.now(),
      stallMs: limits.stallMs,
      status,
      maxAutoContinues: limits.maxAutoContinues,
      progressAt: progress.get(cid) || 0,
    });
    if (outcome.progressAt) progress.set(cid, outcome.progressAt);
    return outcome;
  }

  async function giveUp(cid) {
    const conv = await store.getConversation(cid);
    if (!conv || conv.hostMark === 'failed') return;
    await store.updateConversation(cid, { status: 'failed', hostMark: 'failed' });
    await emit(cid, 'error', { code: 'E_STALL', message: 'stalled' });
    await emit(cid, 'status', { status: 'failed' });
  }

  async function emitStall(cid, attempt) {
    await store.updateConversation(cid, { autoContinues: attempt });
    await emit(cid, 'retry', { attempt, delayMs: 0, reason: 'stall' });
  }

  bridge.claimYield = async (cid, api, hookContext) => {
    const conv = await store.getConversation(cid);
    const status = conv?.status === 'running' ? 'running' : (conv?.status || 'idle');
    let outcome;
    await api.commit(async (tx) => {
      const doc = await tx.doc(ControlDoc, api.conversationId);
      outcome = await claimOnDoc(cid, doc, status);
      return undefined;
    }, hookContext);
    if (outcome?.decision === 'continue') {
      await emitStall(cid, outcome.autoContinues);
      return { continue: CONTINUE_TEXT };
    }
    if (outcome?.decision === 'give_up') await giveUp(cid);
    return undefined;
  };

  async function submitContinue(conversation) {
    try {
      await conversation.submit({
        type: 'input',
        content: CONTINUE_TEXT,
        requestId: randomUUID(),
        whenBusy: 'steer',
      }, context);
    } catch (err) {
      if (err instanceof ConversationBusy) return;
      throw err;
    }
  }

  let checking = false;
  async function checkStalls() {
    if (checking) return;
    checking = true;
    try {
      const rows = await store.listKernelConversations();
      for (const row of rows || []) {
        if (!row?.harnessId || row.status !== 'running') continue;
        if (row.hostMark === 'paused' || row.hostMark === 'stopped' || row.hostMark === 'failed') continue;
        if (typeof isBusy === 'function' && !(await isBusy(row.harnessId))) continue;
        const conversation = await harness.conversation(row.harnessId, context);
        if (!conversation) continue;
        const snap = await harness.snapshot(ControlDoc, row.harnessId, context);
        const progressAt = Math.max(Number(snap?.lastProgressAt) || 0, progress.get(row.id) || 0);
        if (snap?.paused || snap?.stopped || snap?.gaveUp) continue;
        if (progressAt) {
          const preview = decideAutoContinue({
            lastProgressAt: progressAt,
            now: Date.now(),
            stallMs: limits.stallMs,
            status: 'running',
            autoContinues: Number(snap?.autoContinues) || 0,
            maxAutoContinues: limits.maxAutoContinues,
          });
          if (preview === 'wait') continue;
        }
        let outcome;
        await conversation.commit(async (tx) => {
          const doc = await tx.doc(ControlDoc, conversation.id);
          outcome = await claimOnDoc(row.id, doc, 'running');
          return undefined;
        }, context);
        if (outcome?.decision === 'continue') {
          await emitStall(row.id, outcome.autoContinues);
          await submitContinue(conversation);
        } else if (outcome?.decision === 'give_up') {
          await giveUp(row.id);
        }
      }
    } finally {
      checking = false;
    }
  }

  const interval = Math.min(250, Math.max(50, Math.floor(limits.stallMs / 4) || 50));
  const timer = setInterval(() => {
    checkStalls().catch((err) => {
      console.error(`PI_WORK_KERNEL_STALL ${err instanceof Error ? err.message : err}`);
    });
  }, interval);
  timer.unref?.();

  async function loadConv(cid) {
    const conv = await store.getConversation(cid);
    if (!conv) return { missing: true };
    if (isArchivedConversation(conv)) return { archived: true };
    return { conv };
  }

  // Foreground children share the parent's pause: the current step finishes,
  // then afterTool stops the next model request. Background children stay up
  // until stop aborts them.
  async function syncForegroundPause(harnessId, paused) {
    if (harnessId == null) return;
    const roster = await harness.snapshot(Roster, harnessId, context);
    for (const entry of Object.values(roster?.agents || {})) {
      if (entry?.mode !== 'foreground' || entry.conversationId == null) continue;
      const child = await harness.conversation(entry.conversationId, context);
      if (!child) continue;
      await child.commit(async (tx) => {
        const doc = await tx.doc(ControlDoc, child.id);
        doc.paused = paused;
        if (!paused) doc.lastProgressAt = Date.now();
        return undefined;
      }, context);
    }
  }

  async function appendStreamNote(cid, conv) {
    const conversation = await conversationFor(conv);
    if (!conversation) return;
    await conversation.commit(async (tx) => {
      await tx.appendEntry(AssistantEntry, conversation.id, {
        model: [fauxAssistantMessage(STREAM_NOTE)],
      });
    }, context);
  }

  return {
    limits,
    retryPolicy,
    close() {
      clearInterval(timer);
    },
    touch(cid) {
      bridge.touch?.(cid, Date.now());
    },
    async beginUserTurn(conv) {
      if (!conv?.harnessId || isArchivedConversation(conv)) return;
      const conversation = await conversationFor(conv);
      if (conversation) {
        await conversation.commit(async (tx) => {
          const doc = await tx.doc(ControlDoc, conversation.id);
          resetBudget(doc);
          doc.paused = false;
          doc.stopped = false;
          doc.gaveUp = false;
          doc.lastProgressAt = Date.now();
          return undefined;
        }, context);
        progress.set(conv.id, Date.now());
      }
      const patch = {};
      if (conv.hostMark !== 'recovering') patch.status = 'running';
      if (conv.hostMark === 'paused' || conv.hostMark === 'stopped' || conv.hostMark === 'failed') {
        patch.hostMark = null;
      }
      if (Object.keys(patch).length) await store.updateConversation(conv.id, patch);
      softening.delete(conv.id);
      softened.delete(conv.id);
    },
    async noteGenerationRetry(cid) {
      const conv = await store.getConversation(cid);
      if (!conv) return;
      const next = (Number(conv.autoContinues) || 0) + 1;
      await store.updateConversation(cid, { autoContinues: next });
      const conversation = await conversationFor(conv);
      if (!conversation) return;
      await conversation.commit(async (tx) => {
        const doc = await tx.doc(ControlDoc, conversation.id);
        doc.autoContinues = Math.max(Number(doc.autoContinues) || 0, next);
        return undefined;
      }, context);
    },
    async absorb(cid, ev) {
      if (!ev) return ev;
      if (ev.event === 'message.delta' || ev.event === 'message.done' || ev.event === 'tool.start' || ev.event === 'tool.end') {
        bridge.touch?.(cid, Date.now());
      }
      if (ev.event === 'status' && ev.data?.status === 'running') {
        bridge.touch?.(cid, Date.now());
        softening.delete(cid);
        softened.delete(cid);
      }
      if (ev.event === 'retry' && ev.data?.reason !== 'stall') {
        await this.noteGenerationRetry(cid);
      }
      if (ev.event === 'error') {
        const code = ev.data?.code;
        const hard = code === 'E_NO_MODEL' || code === 'E_STALL' || code === 'E_SANDBOX' || code === 'E_ABORTED';
        if (!hard && (softening.has(cid) || wantsRetry({ stopReason: 'error', errorMessage: ev.data?.message || '' }))) {
          const transcript = typeof readTranscript === 'function' ? await readTranscript(cid) : null;
          if (softening.has(cid) || successfulTool(transcript?.messages)) {
            softening.add(cid);
            return null;
          }
        }
      }
      if (ev.event === 'status' && ev.data?.status === 'failed' && softening.has(cid)) {
        if (!softened.has(cid)) {
          softened.add(cid);
          const conv = await store.getConversation(cid);
          if (conv) await appendStreamNote(cid, conv);
          return { event: 'status', data: { ...ev.data, status: 'done' } };
        }
        return null;
      }
      const conv = await store.getConversation(cid);
      const mark = conv?.hostMark;
      if (ev.event === 'status') {
        const status = ev.data?.status;
        if (mark === 'paused' && status !== 'paused') return null;
        if (mark === 'stopped' && status !== 'stopped') return null;
        if (mark === 'failed' && status !== 'failed') return null;
      }
      return ev;
    },
    async pause(cid) {
      const loaded = await loadConv(cid);
      if (loaded.missing) return { status: 404, body: { error: 'conversation not found' } };
      if (loaded.archived) return archivedMutation();
      const { conv } = loaded;
      if (conv.hostMark === 'stopped' || conv.status === 'stopped') return { status: 'stopped' };
      if (conv.hostMark === 'paused' || conv.status === 'paused') return { status: 'paused' };
      const conversation = await conversationFor(conv);
      if (conversation) {
        await conversation.commit(async (tx) => {
          const doc = await tx.doc(ControlDoc, conversation.id);
          doc.paused = true;
          return undefined;
        }, context);
        await syncForegroundPause(conv.harnessId, true);
      }
      await store.updateConversation(cid, { status: 'paused', hostMark: 'paused' });
      await emit(cid, 'status', { status: 'paused' });
      return { status: 'paused' };
    },
    async resume(cid) {
      const loaded = await loadConv(cid);
      if (loaded.missing) return { status: 404, body: { error: 'conversation not found' } };
      if (loaded.archived) return archivedMutation();
      const { conv } = loaded;
      if (conv.hostMark === 'stopped' || conv.status === 'stopped') return { status: 'stopped' };
      if (conv.hostMark !== 'paused' && conv.status !== 'paused') {
        return { status: conv.status || 'idle' };
      }
      const conversation = await conversationFor(conv);
      if (conversation) {
        await syncForegroundPause(conv.harnessId, false);
        await conversation.commit(async (tx) => {
          const doc = await tx.doc(ControlDoc, conversation.id);
          doc.paused = false;
          doc.lastProgressAt = Date.now();
          return undefined;
        }, context);
      }
      progress.set(cid, Date.now());
      await store.updateConversation(cid, { status: 'running', hostMark: null });
      await emit(cid, 'status', { status: 'running' });
      const busy = typeof isBusy === 'function' && conversation
        ? await isBusy(conv.harnessId)
        : false;
      if (conversation && !busy) await submitContinue(conversation);
      return { status: 'running' };
    },
    async markStopped(cid) {
      const conv = await store.getConversation(cid);
      if (!conv?.harnessId || isArchivedConversation(conv)) return;
      const conversation = await conversationFor(conv);
      if (!conversation) return;
      await conversation.commit(async (tx) => {
        const doc = await tx.doc(ControlDoc, conversation.id);
        doc.stopped = true;
        doc.paused = false;
        return undefined;
      }, context);
    },
    async stop(cid) {
      const loaded = await loadConv(cid);
      if (loaded.missing) return { status: 404, body: { error: 'conversation not found' } };
      if (loaded.archived) return archivedMutation();
      const { conv } = loaded;
      const conversation = await conversationFor(conv);
      if (conversation) {
        await conversation.commit(async (tx) => {
          const doc = await tx.doc(ControlDoc, conversation.id);
          doc.stopped = true;
          doc.paused = false;
          return undefined;
        }, context);
      }
      await store.updateConversation(cid, { status: 'stopped', hostMark: 'stopped' });
      await emit(cid, 'status', { status: 'stopped' });
      if (conversation) {
        const pending = conversation.abort(context, { background: true }).catch(() => {});
        await Promise.race([
          pending,
          new Promise((resolve) => setTimeout(resolve, 2000)),
        ]);
      }
      return { status: 'stopped' };
    },
  };
}
