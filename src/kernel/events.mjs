// Map Pi Durable agent events onto the HTTP/SSE names the UI already listens for.
// Nothing here is stored. HTTP status is the last submission record.
import { retryDelayMs } from '@earendil-works/pi-ai/utils/retry';
import { DEFAULT_RETRY_POLICY } from '@earendil-works/pi-durable';
import { redactAuthText } from '../core/grok-auth.mjs';
import { overlayContextWindow, presentContext } from '../core/usage.mjs';
import { isAutoContinueText } from './continuation.mjs';
import { latestCallUsage, reportedUsage } from './usage.mjs';

/** messageId for an assistant partial that has no transcript entry yet. */
export const LIVE_MESSAGE_ID = 'live';

/** True for the legacy `'live'` id and for `live-1`, `live-2`, … */
export function isLiveMessageId(id) {
  const value = id == null ? '' : String(id);
  return value === LIVE_MESSAGE_ID || value.startsWith('live-');
}

/** One id per in-flight assistant generation. Cleared when that message ends. */
function ensureLiveId(ctx) {
  if (!ctx) return LIVE_MESSAGE_ID;
  if (ctx.liveId) return ctx.liveId;
  ctx.liveSeq = (Number(ctx.liveSeq) || 0) + 1;
  ctx.liveId = `live-${ctx.liveSeq}`;
  return ctx.liveId;
}

export function createMapContext({ retry = DEFAULT_RETRY_POLICY, contextWindow = null } = {}) {
  return {
    retry,
    toolInputs: new Map(),
    liveSeq: 0,
    liveId: null,
    contextWindow: contextWindow ?? null,
  };
}

export function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((block) => {
    if (typeof block === 'string') return block;
    if (block && typeof block.text === 'string' && block.type !== 'toolCall') return block.text;
    return '';
  }).join('');
}

function toolBody({ id, name, status, input, output, path, added, removed }) {
  const tool = { id, name, status };
  if (input !== undefined) tool.input = input;
  if (output !== undefined) tool.output = output;
  if (path) tool.path = path;
  if (added != null) tool.added = added;
  if (removed != null) tool.removed = removed;
  return tool;
}

function assistantModelName(entry) {
  const value = entry?.model?.[0]?.model;
  return typeof value === 'string' && value ? value : '';
}

function messageDone(entry) {
  const message = entry.model?.[0];
  const text = textOf(message?.content);
  const data = { messageId: String(entry.id) };
  if (text) data.text = text;
  if (entry.kind === 'pi.user') {
    data.role = 'user';
    if (isAutoContinueText(text)) data.kind = 'auto-continue';
  } else {
    const model = assistantModelName(entry);
    if (model) data.model = model;
    const stopReason = message?.stopReason;
    if (typeof stopReason === 'string' && stopReason) data.stopReason = stopReason;
  }
  return { event: 'message.done', data };
}

function usageEvent(entry, ctx) {
  if (entry.kind !== 'pi.assistant') return null;
  const presented = overlayContextWindow(
    presentContext(reportedUsage(entry.model?.[0])),
    ctx?.contextWindow,
  );
  if (!presented.usage) return null;
  return { event: 'usage', data: presented };
}

function errorForSubmission(record) {
  const detail = typeof record.detail === 'string' ? record.detail : '';
  if (record.reason === 'no_model' || /\bE_NO_MODEL\b/.test(detail)) {
    return { code: 'E_NO_MODEL', message: 'err_no_model' };
  }
  return {
    code: record.reason === 'model_error' ? 'E_LLM' : (record.reason || 'E_LLM'),
    message: redactAuthText(detail || record.reason || 'model error'),
  };
}

function unavailableTool(entry) {
  const diagnostics = entry?.data?.diagnostics;
  return Array.isArray(diagnostics) && diagnostics.some((item) => item?.code === 'tool_unavailable');
}

function toolOutput(entry, result) {
  if (unavailableTool(entry)) return 'E_UNKNOWN_TOOL';
  return result ? textOf(result.content) : undefined;
}

function diffOf(result) {
  const details = result?.details;
  if (!details || typeof details !== 'object') return {};
  return {
    path: typeof details.path === 'string' ? details.path : undefined,
    added: details.added,
    removed: details.removed,
  };
}

function toolEnd(ev, ctx) {
  const args = ctx.toolInputs.get(ev.toolCallId) || {};
  const result = ev.entry?.model?.[0];
  const diff = diffOf(result);
  const output = toolOutput(ev.entry, result);
  const status = result ? (result.isError ? 'error' : 'completed') : 'error';
  return {
    event: 'tool.end',
    data: {
      tool: toolBody({
        id: ev.toolCallId,
        name: ev.toolName || result?.toolName,
        status,
        input: args,
        output,
        path: diff.path || args.path,
        added: diff.added,
        removed: diff.removed,
      }),
    },
  };
}

function queuedInputs(inbox) {
  return (inbox?.items || []).some((item) => item?.mode === 'steer' || item?.mode === 'followUp');
}

/**
 * HTTP status of one submission record.
 * `queued` / `placed` are running. `done` is finished.
 * `unanswered` is failed, except `reason: "aborted"`, which is stopped.
 * The error text is that record's reason and detail.
 */
export function statusFromSubmission(record) {
  if (record?.status === 'queued' || record?.status === 'placed') return { status: 'running' };
  if (record?.status === 'done') return { status: 'done' };
  if (record?.status === 'unanswered') {
    if (record.reason === 'aborted') return { status: 'stopped' };
    return { status: 'failed', llmError: errorForSubmission(record) };
  }
  throw new Error(`Unexpected submission status ${record?.status}`);
}

/**
 * One watchEvents batch, in order, as the SSE names the UI already handles.
 * A `snapshot` is not replayed; the caller pushes the current status so the
 * client refetches the conversation.
 */
export function mapHarnessBatch(batch, ctx) {
  const events = [];
  let refresh = false;
  for (const ev of batch || []) {
    if (!ev || typeof ev !== 'object') continue;
    if (ev.type === 'snapshot') {
      refresh = true;
      continue;
    }
    if (ev.type === 'run_start') {
      events.push({ event: 'status', data: { status: 'running' } });
      continue;
    }
    if (ev.type === 'inbox_update' && queuedInputs({ items: ev.items })) {
      events.push({ event: 'status', data: { status: 'running' } });
      continue;
    }
    if (ev.type === 'message_update') {
      for (const change of ev.changes || []) {
        if (change?.type === 'text_delta' && change.delta) {
          events.push({
            event: 'message.delta',
            data: { messageId: ensureLiveId(ctx), text: String(change.delta) },
          });
        }
      }
      continue;
    }
    if (ev.type === 'message_end' && (ev.entry?.kind === 'pi.user' || ev.entry?.kind === 'pi.assistant')) {
      const done = messageDone(ev.entry);
      if (ev.entry.kind === 'pi.assistant' && ctx.liveId) {
        done.data.liveId = ctx.liveId;
        ctx.liveId = null;
      }
      events.push(done);
      const usage = usageEvent(ev.entry, ctx);
      if (usage) events.push(usage);
      continue;
    }
    if (ev.type === 'tool_execution_start') {
      const input = ev.args && typeof ev.args === 'object' ? ev.args : {};
      ctx.toolInputs.set(ev.toolCallId, input);
      events.push({
        event: 'tool.start',
        data: {
          tool: toolBody({
            id: ev.toolCallId,
            name: ev.toolName,
            status: 'running',
            input,
            path: input.path,
          }),
        },
      });
      continue;
    }
    if (ev.type === 'tool_execution_end') {
      events.push(toolEnd(ev, ctx));
      continue;
    }
    if (ev.type === 'auto_retry_start') {
      events.push({
        event: 'retry',
        data: {
          attempt: ev.attempt,
          delayMs: retryDelayMs(ctx.retry || DEFAULT_RETRY_POLICY, ev.attempt),
          reason: redactAuthText(ev.errorMessage || ''),
        },
      });
      continue;
    }
    if (ev.type === 'task_failed') {
      events.push({
        event: 'error',
        data: { code: 'E_LLM', message: redactAuthText(ev.message || ev.kind || 'task failed') },
      });
      events.push({ event: 'status', data: { status: 'failed' } });
      continue;
    }
    if (ev.type === 'submission' && ev.record?.type === 'input' && ev.record.status === 'done') {
      events.push({ event: 'status', data: { status: 'done' } });
      continue;
    }
    if (ev.type === 'submission' && ev.record?.type === 'input' && ev.record.status === 'unanswered') {
      if (ev.record.reason === 'aborted') {
        events.push({ event: 'status', data: { status: 'stopped' } });
        continue;
      }
      events.push({ event: 'error', data: errorForSubmission(ev.record) });
      events.push({ event: 'status', data: { status: 'failed' } });
    }
  }
  return { events, refresh };
}

/** Transcript entries to the REST message list, plus the latest reported call usage. */
export function messagesFromEntries(entries) {
  const calls = new Map();
  const usage = latestCallUsage(entries);
  for (const entry of entries || []) {
    if (entry?.kind !== 'pi.assistant') continue;
    const content = entry.model?.[0]?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === 'toolCall' && block.id) {
        calls.set(block.id, { name: block.name, input: block.arguments || {} });
      }
    }
  }
  const answered = new Set();
  const messages = [];
  for (const entry of entries || []) {
    if (entry?.kind === 'pi.user' || entry?.kind === 'pi.assistant') {
      const text = textOf(entry.model?.[0]?.content);
      if (entry.kind === 'pi.assistant' && !text) continue;
      const msg = { id: String(entry.id), role: entry.kind === 'pi.user' ? 'user' : 'assistant' };
      if (text) msg.text = text;
      if (entry.kind === 'pi.user' && isAutoContinueText(text)) msg.kind = 'auto-continue';
      if (entry.kind === 'pi.assistant') {
        const model = assistantModelName(entry);
        if (model) msg.model = model;
        const stopReason = entry.model?.[0]?.stopReason;
        if (typeof stopReason === 'string' && stopReason) msg.stopReason = stopReason;
      }
      messages.push(msg);
      continue;
    }
    if (entry?.kind !== 'pi.tool-result') continue;
    const result = entry.model?.[0];
    if (!result) continue;
    if (result.toolCallId) answered.add(result.toolCallId);
    const known = calls.get(result.toolCallId) || {};
    const input = known.input || {};
    const diff = diffOf(result);
    const tool = toolBody({
      id: result.toolCallId,
      name: result.toolName || known.name,
      status: result.isError ? 'error' : 'completed',
      input,
      output: toolOutput(entry, result),
      path: diff.path || input.path,
      added: diff.added,
      removed: diff.removed,
    });
    messages.push({ id: String(entry.id), role: 'tool', text: tool.output || '', tool });
  }
  // A tool call with no result yet is still running. The refresh must keep it,
  // or a GET during the call erases the live tool.start row.
  for (const [id, known] of calls) {
    if (answered.has(id)) continue;
    const input = known.input || {};
    const tool = toolBody({
      id,
      name: known.name,
      status: 'running',
      input,
      path: typeof input.path === 'string' ? input.path : undefined,
    });
    messages.push({ id: `tool-${id}`, role: 'tool', tool });
  }
  return { messages, usage };
}

/** First write/edit details per path. Later edits of the same path keep that baseline. */
export function baselinesFromEntries(entries) {
  const byPath = new Map();
  for (const entry of entries || []) {
    if (entry?.kind !== 'pi.tool-result') continue;
    const details = entry.model?.[0]?.details;
    if (!details || typeof details.path !== 'string' || byPath.has(details.path)) continue;
    byPath.set(details.path, {
      path: details.path,
      before: details.before,
      after: details.after,
      added: details.added,
      removed: details.removed,
      oversized: details.oversized === true,
      linesBefore: details.linesBefore,
      linesAfter: details.linesAfter,
      toolCallId: entry.model?.[0]?.toolCallId || null,
    });
  }
  return [...byPath.values()];
}
