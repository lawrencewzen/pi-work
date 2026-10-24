// Explicit faux script playback. The Harness still calls the model and runs tools.
// This module only picks the next scripted reply from the transcript already stored.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { appendFile, writeFile } from 'node:fs/promises';
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { getCurrentTools } from '@earendil-works/pi-ai/utils/transcript';
import { defineExtension, GenerationTask, hook, ProviderDoc } from '@earendil-works/pi-durable';
import { EXT_FAUX_SCRIPT } from './ids.mjs';
import { registerFaux } from './index.mjs';
import { stampScriptTurn } from './usage.mjs';

const DEMO_RESPONSE_COUNT = 100;

/** Tool names offered to the model, from the system entries already in the transcript. */
export function offeredToolNames(context) {
  const names = [];
  for (const message of context?.messages || []) {
    if (!message || message.role !== 'system') continue;
    for (const tool of message.toolsRemoved || []) {
      const index = names.indexOf(tool?.name);
      if (index >= 0) names.splice(index, 1);
    }
    for (const tool of message.toolsAdded || []) {
      if (tool?.name && !names.includes(tool.name)) names.push(tool.name);
    }
  }
  return names;
}

const scriptFloors = new Map();

/**
 * Retries reuse the request cutoff, so the failed assistant is in the transcript
 * but not in the messages the demo script sees. The floor is that transcript count,
 * keyed by the provider session of the conversation that is about to call the model.
 */
export function noteScriptAssistants(sessionId, count) {
  if (!sessionId) return;
  const next = Number(count) || 0;
  const prev = scriptFloors.get(sessionId) || 0;
  if (next > prev) scriptFloors.set(sessionId, next);
}

export function scriptAssistantFloor(sessionId) {
  return scriptFloors.get(sessionId) || 0;
}

function messageText(message) {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  if (typeof message.text === 'string') return message.text;
  if (!Array.isArray(message.content)) return '';
  return message.content.map((part) => {
    if (typeof part === 'string') return part;
    if (typeof part?.text === 'string') return part.text;
    return '';
  }).join('');
}

function lastUserText(context) {
  const messages = context?.messages || [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role !== 'user') continue;
    const text = messageText(message);
    if (text) return text;
  }
  return '';
}

/** One assistant message can name a single `tool` or several `tools`. */
function turnHasTool(turn) {
  return Boolean(turn?.tool) || (Array.isArray(turn?.tools) && turn.tools.length > 0);
}

function toolCallsOf(turn) {
  if (Array.isArray(turn?.tools) && turn.tools.length) {
    return turn.tools.map((item) => {
      const spec = item && typeof item === 'object' ? item : { tool: item };
      const args = spec.args && typeof spec.args === 'object' ? spec.args : {};
      const id = spec.id ? { id: String(spec.id) } : {};
      return fauxToolCall(String(spec.tool || spec.name || ''), args, id);
    });
  }
  if (turn?.tool) {
    const args = turn.args && typeof turn.args === 'object' ? turn.args : {};
    const id = turn.id ? { id: String(turn.id) } : {};
    return [fauxToolCall(String(turn.tool), args, id)];
  }
  return [];
}

/**
 * Fold standalone `delayMs` onto the next model turn, and turn `cut` into one
 * retryable error. Turns tagged `when` stay in the plan for per-message routing.
 */
export function planScriptTurns(turns) {
  const plan = [];
  let delay = 0;
  for (const turn of Array.isArray(turns) ? turns : []) {
    if (!turn || typeof turn !== 'object') continue;
    const marker = turn.when != null ? String(turn.when) : '';
    const bareDelay = turn.delayMs != null
      && turn.text == null
      && !turnHasTool(turn)
      && !turn.end
      && !turn.error
      && !turn.cut;
    if (bareDelay) {
      delay += Number(turn.delayMs) || 0;
      continue;
    }
    const next = { ...turn };
    if (marker) next.when = marker;
    else delete next.when;
    if (turn.cut) {
      next.error = next.error || 'terminated';
      delete next.cut;
    }
    const own = Number(turn.delayMs);
    const total = delay + (Number.isFinite(own) ? own : 0);
    if (total > 0) next.delayMs = total;
    else delete next.delayMs;
    delay = 0;
    if (turnHasTool(next) || next.text != null || next.end || next.error) plan.push(next);
  }
  return plan;
}

/** Turns for this request. `when` matches the latest user text; otherwise untagged turns. */
export function scriptPool(turns, context) {
  const plan = planScriptTurns(turns);
  const last = lastUserText(context);
  const scoped = plan.filter((turn) => turn.when && last.includes(turn.when));
  if (scoped.length) return scoped;
  return plan.filter((turn) => !turn.when);
}

export function scriptAssistantCount(context) {
  return (context?.messages || []).filter((message) => message?.role === 'assistant').length;
}

/**
 * Script index for onYield. Every assistant entry counts, including a tool
 * call with no text. `answer` is the yielding message, which the Harness has
 * not appended yet.
 */
export function scriptMessages(entries, answer) {
  const messages = [];
  for (const entry of entries || []) {
    if (entry?.kind === 'pi.user' || entry?.kind === 'pi.assistant') {
      messages.push({
        role: entry.kind === 'pi.user' ? 'user' : 'assistant',
        content: entry.model?.[0]?.content,
      });
    }
  }
  if (answer && typeof answer === 'object') {
    messages.push({ role: 'assistant', content: answer.content });
  }
  return messages;
}

/**
 * After a narration turn, keep going when the same script still has a tool or
 * a step-ending `end`. A following text turn waits for the next user message.
 */
export function scriptShouldContinue(turns, context) {
  const pool = scriptPool(turns, context);
  const used = scriptAssistantCount(context);
  if (used <= 0 || used >= pool.length) return false;
  const previous = pool[used - 1];
  const next = pool[used];
  if (!previous || previous.end || turnHasTool(previous) || previous.error) return false;
  if (!next || next.error) return false;
  return Boolean(turnHasTool(next) || next.end);
}

export function loadScriptTurns(env = process.env) {
  const scriptPath = String(env?.WEFT_FAUX_SCRIPT || '').trim();
  if (!scriptPath) return null;
  try {
    const script = JSON.parse(readFileSync(scriptPath, 'utf8'));
    return Array.isArray(script?.turns) ? script.turns : null;
  } catch {
    return null;
  }
}

/**
 * One faux reply chosen by how many assistant messages are already committed.
 * A restarted process sees the same transcript, so it does not repeat an earlier tool call.
 */
export function fauxTurnFromScript(turns, context) {
  const pending = scriptPool(turns, context);
  const used = scriptAssistantCount(context);
  const turn = pending[used];
  if (!turn) return fauxAssistantMessage('ok');
  let message;
  const calls = toolCallsOf(turn);
  const text = turn.text != null ? String(turn.text) : '';
  if (turn.error) {
    message = fauxAssistantMessage('', {
      stopReason: 'error',
      errorMessage: String(turn.error),
    });
  } else if (calls.length) {
    // Text followed by tool calls is one assistant message. The Harness runs the tools.
    const blocks = [];
    if (text) blocks.push(fauxText(text));
    blocks.push(...calls);
    message = fauxAssistantMessage(blocks, { stopReason: 'toolUse' });
  } else if (turn.end) {
    message = fauxAssistantMessage('');
  } else {
    // Text with no tool call ends this run. Later script turns wait for the next user message.
    const extra = {};
    if (turn.stopReason) extra.stopReason = String(turn.stopReason);
    message = fauxAssistantMessage(text, extra);
  }
  return stampScriptTurn(message, turn);
}

/**
 * Retries keep the request cutoff, so a failed assistant is in the transcript
 * but not in the messages this call sees. Remember that count before the request.
 */
export function createScriptFloorExtension() {
  return defineExtension({
    name: EXT_FAUX_SCRIPT,
    hooks: [
      hook(GenerationTask, {
        async beforeRequest(_request, api, context) {
          try {
            const provider = await api.snapshot(ProviderDoc, api.conversationId, context);
            const sessionId = provider?.sessionId;
            if (!sessionId || typeof api.context !== 'function') return;
            const full = await api.context(api.conversationId, context);
            const count = (full?.entries || []).filter((entry) => entry?.kind === 'pi.assistant').length;
            noteScriptAssistants(sessionId, count);
          } catch { /* the script still follows the messages on the request */ }
        },
      }),
    ],
  });
}

/** Explicit demo script only. WEFT_FAUX_TOOL_LOG records the offered tool names for tests. */
export function scriptedDemoStep(scriptPath, env = process.env, hooks = {}) {
  const script = JSON.parse(readFileSync(scriptPath, 'utf8'));
  const turns = script?.turns;
  const logPath = String(env.WEFT_FAUX_TOOL_LOG || '').trim();
  const ready = String(env.WEFT_FAUX_HOLD_READY || '').trim();
  return async (context, streamOptions) => {
    if (logPath) appendFileSync(logPath, `${JSON.stringify(offeredToolNames(context))}\n`);
    const have = scriptAssistantCount(context);
    const floor = scriptAssistantFloor(streamOptions?.sessionId);
    const used = Math.max(have, floor);
    let messages = context?.messages;
    if (used > have) {
      messages = [...(messages || [])];
      for (let i = have; i < used; i += 1) messages.push({ role: 'assistant', content: '' });
    }
    const view = messages === context?.messages ? context : { ...context, messages };
    const delay = Number(scriptPool(turns, view)[used]?.delayMs);
    if (Number.isFinite(delay) && delay > 0) {
      if (ready) writeFileSync(ready, 'seen');
      const tick = String(env.WEFT_FAUX_DELAY_TICK ?? '1') !== '0';
      const signal = streamOptions?.signal;
      const end = Date.now() + delay;
      while (Date.now() < end && !signal?.aborted) {
        if (tick) hooks.tick?.();
        const slice = Math.min(50, end - Date.now());
        if (slice > 0) await new Promise((resolve) => setTimeout(resolve, slice));
      }
      if (signal?.aborted) throw new Error('Request was aborted');
    }
    const chosen = scriptPool(turns, view)[used];
    // `{end:true}` is an empty assistant turn. Counting it keeps the next
    // scripted reply on the following model call whether or not the empty
    // assistant is stored.
    if (chosen?.end && streamOptions?.sessionId) {
      noteScriptAssistants(streamOptions.sessionId, used + 1);
    }
    return fauxTurnFromScript(turns, view);
  };
}

function parseFauxPlan(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('WEFT_FAUX_PLAN must be a non-empty JSON array');
  }
  return parsed.map((item) => {
    if (item === 'hold') return 'hold';
    if (typeof item === 'string') return item;
    throw new Error('WEFT_FAUX_PLAN items must be strings');
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
  const tools = getCurrentTools(messages);
  return {
    sections: replayedSections(messages),
    tools: tools.map((tool) => tool.name),
    toolDescriptions: Object.fromEntries(tools.map((tool) => [tool.name, tool.description || ''])),
    users: messages.filter((message) => message?.role === 'user').map((message) => (
      typeof message.content === 'string' ? message.content : ''
    )),
  };
}

function fauxProviderOptions(env) {
  const tps = Number(env?.WEFT_FAUX_TPS);
  if (!Number.isFinite(tps) || tps <= 0) return undefined;
  return { tokensPerSecond: tps };
}

/**
 * The faux provider does not apply `stream.timeoutMs`. A hold waits on the
 * timeout Pi Durable already passed, then fails with a retryable timeout error.
 * Abort still wins. With no timeout the call stays open, matching a hung model.
 */
function holdForStream(streamOptions) {
  const timeoutMs = Number(streamOptions?.timeoutMs);
  const signal = streamOptions?.signal;
  return new Promise((resolve, reject) => {
    let timer;
    const finish = (err) => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (err) reject(err);
      else resolve();
    };
    const onAbort = () => finish(new Error('Request was aborted'));
    if (signal?.aborted) {
      finish(new Error('Request was aborted'));
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => finish(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs);
    }
  });
}

/** Install the demo faux provider used by tests. Same behavior as before the move. */
export function installDemo(models, env) {
  const faux = registerFaux(models, fauxProviderOptions(env));
  const text = String(env.WEFT_FAUX_TEXT || '');
  const holdAll = String(env.WEFT_FAUX_HOLD || '').trim() === '1';
  const ready = String(env.WEFT_FAUX_HOLD_READY || '').trim();
  const scriptPath = String(env.WEFT_FAUX_SCRIPT || '').trim();
  const recordPath = String(env.WEFT_FAUX_RECORD || '').trim();
  const plan = holdAll ? null : parseFauxPlan(env.WEFT_FAUX_PLAN);
  const scripted = !holdAll && !plan && scriptPath ? scriptedDemoStep(scriptPath, env) : null;
  let cursor = 0;
  const step = async (context, streamOptions) => {
    if (recordPath) await appendFile(recordPath, `${JSON.stringify(requestSnapshot(context))}\n`);
    if (holdAll) {
      if (ready) await writeFile(ready, 'seen');
      await holdForStream(streamOptions);
      return fauxAssistantMessage(text);
    }
    if (plan) {
      const item = plan[Math.min(cursor, plan.length - 1)];
      cursor += 1;
      if (item === 'hold') {
        if (ready) await writeFile(ready, 'seen');
        await holdForStream(streamOptions);
      }
      return fauxAssistantMessage(item);
    }
    if (scripted) return scripted(context, streamOptions);
    return fauxAssistantMessage(text);
  };
  faux.setResponses(Array.from({ length: DEMO_RESPONSE_COUNT }, () => step));
  return faux;
}
