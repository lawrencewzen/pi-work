// Explicit faux script playback. The Harness still calls the model and runs tools.
// This module only picks the next scripted reply from the transcript already stored.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { stampScriptTurn } from './usage.mjs';

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
      && !turn.tool
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
    if (next.tool || next.text != null || next.end || next.error) plan.push(next);
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
  if (!previous || previous.end || previous.tool || previous.error) return false;
  if (!next || next.error) return false;
  return Boolean(next.tool || next.end);
}

export function loadScriptTurns(env = process.env) {
  const scriptPath = String(env?.PI_WORK_FAUX_SCRIPT || '').trim();
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
  if (turn.error) {
    message = fauxAssistantMessage('', {
      stopReason: 'error',
      errorMessage: String(turn.error),
    });
  } else if (turn.tool) {
    const args = turn.args && typeof turn.args === 'object' ? turn.args : {};
    const id = turn.id ? { id: String(turn.id) } : {};
    message = fauxAssistantMessage(
      [fauxToolCall(String(turn.tool), args, id)],
      { stopReason: 'toolUse' },
    );
  } else if (turn.end) {
    message = fauxAssistantMessage('');
  } else {
    message = fauxAssistantMessage(String(turn.text));
  }
  return stampScriptTurn(message, turn);
}

/** Explicit demo script only. PI_WORK_FAUX_TOOL_LOG records the offered tool names for tests. */
export function scriptedDemoStep(scriptPath, env = process.env, hooks = {}) {
  const script = JSON.parse(readFileSync(scriptPath, 'utf8'));
  const turns = script?.turns;
  const logPath = String(env.PI_WORK_FAUX_TOOL_LOG || '').trim();
  const ready = String(env.PI_WORK_FAUX_HOLD_READY || '').trim();
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
      const tick = String(env.PI_WORK_FAUX_DELAY_TICK ?? '1') !== '0';
      const end = Date.now() + delay;
      while (Date.now() < end) {
        if (tick) hooks.tick?.();
        const slice = Math.min(50, end - Date.now());
        if (slice > 0) await new Promise((resolve) => setTimeout(resolve, slice));
      }
    }
    const chosen = scriptPool(turns, view)[used];
    // `{end:true}` finishes a pipeline step. Counting it keeps the next step on
    // the following turn whether or not the empty assistant is stored.
    if (chosen?.end && streamOptions?.sessionId) {
      noteScriptAssistants(streamOptions.sessionId, used + 1);
    }
    return fauxTurnFromScript(turns, view);
  };
}
