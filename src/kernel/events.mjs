// Map Pi Durable agent events onto the HTTP/SSE contract.
// The host does not schedule work. It only renames events watchEvents already emitted.
import { retryDelayMs } from '@earendil-works/pi-ai/utils/retry';
import { DEFAULT_RETRY_POLICY } from '@earendil-works/pi-durable';
import { redactAuthText } from '../core/grok-auth.mjs';
import { presentContext } from '../core/usage.mjs';
import { latestCallUsage, reportedUsage } from './usage.mjs';

/** messageId for an assistant partial that has no transcript entry yet. */
export const LIVE_MESSAGE_ID = 'live';

/** True for the legacy `'live'` id and for `live-1`, `live-2`, … */
export function isLiveMessageId(id) {
  const value = id == null ? '' : String(id);
  return value === LIVE_MESSAGE_ID || value.startsWith('live-');
}

function noteLiveId(ctx, id) {
  if (!ctx || !id) return;
  ctx.liveId = String(id);
  const match = /^live-(\d+)$/.exec(ctx.liveId);
  if (match) ctx.liveSeq = Math.max(Number(ctx.liveSeq) || 0, Number(match[1]));
}

/** One id per in-flight assistant generation. Cleared when that message ends. */
function ensureLiveId(ctx) {
  if (!ctx) return LIVE_MESSAGE_ID;
  if (ctx.liveId) return ctx.liveId;
  ctx.liveSeq = (Number(ctx.liveSeq) || 0) + 1;
  ctx.liveId = `live-${ctx.liveSeq}`;
  return ctx.liveId;
}

export function createMapContext({ retry = DEFAULT_RETRY_POLICY, step = 0 } = {}) {
  return {
    retry,
    step,
    toolInputs: new Map(),
    toolDiffs: new Map(),
    liveSeq: 0,
    liveId: null,
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

function messageDone(entry) {
  const message = entry.model?.[0];
  const text = textOf(message?.content);
  const data = { messageId: String(entry.id) };
  if (text) data.text = text;
  if (entry.kind === 'pi.user') data.role = 'user';
  return { event: 'message.done', data };
}

function usageEvent(entry) {
  if (entry.kind !== 'pi.assistant') return null;
  const presented = presentContext(reportedUsage(entry.model?.[0]));
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

function toolEnd(ev, ctx) {
  const args = ctx.toolInputs.get(ev.toolCallId) || {};
  const diff = ctx.toolDiffs.get(ev.toolCallId);
  const result = ev.entry?.model?.[0];
  const output = toolOutput(ev.entry, result);
  const status = result ? (result.isError ? 'error' : 'completed') : 'error';
  ctx.step += 1;
  return [
    {
      event: 'tool.end',
      data: {
        tool: toolBody({
          id: ev.toolCallId,
          name: ev.toolName || result?.toolName,
          status,
          input: args,
          output,
          path: args.path,
          added: diff?.added,
          removed: diff?.removed,
        }),
      },
    },
    { event: 'checkpoint', data: { at: Date.now(), step: ctx.step } },
  ];
}

/**
 * One watchEvents batch, in order, as contract events.
 * `ctx.step` advances on each tool commit. Status `running` is the host's job to
 * suppress while a restart is still marked recovering.
 */
export function mapHarnessBatch(batch, ctx) {
  const events = [];
  const snapshots = [];
  let failed = false;
  for (const ev of batch || []) {
    if (!ev || typeof ev !== 'object') continue;
    if (ev.type === 'snapshot') {
      snapshots.push(ev);
      continue;
    }
    if (ev.type === 'run_start') {
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
      const usage = usageEvent(ev.entry);
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
      events.push(...toolEnd(ev, ctx));
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
      if (!failed) {
        failed = true;
        events.push({ event: 'status', data: { status: 'failed' } });
      }
      continue;
    }
    if (ev.type === 'submission' && ev.record?.type === 'input' && ev.record.status === 'done') {
      events.push({ event: 'status', data: { status: 'done' } });
      continue;
    }
    if (ev.type === 'submission' && ev.record?.type === 'input' && ev.record.status === 'unanswered') {
      events.push({ event: 'error', data: errorForSubmission(ev.record) });
      if (!failed) {
        failed = true;
        events.push({ event: 'status', data: { status: 'failed' } });
      }
    }
  }
  return { events, snapshots };
}

/** Rebuild the open live bubble from deltas already stored. Incremental text is appended; `replace` overwrites. */
function foldLive(existing) {
  let liveId = null;
  let liveText = '';
  for (const ev of existing || []) {
    if (ev?.event === 'message.delta' && isLiveMessageId(ev.data?.messageId)) {
      const id = String(ev.data.messageId);
      if (liveId && liveId !== id) liveText = '';
      liveId = id;
      const text = String(ev.data.text || '');
      liveText = ev.data.replace ? text : liveText + text;
      continue;
    }
    if (ev?.event === 'message.done' && ev.data?.role !== 'user' && liveId) {
      const doneLive = ev.data.liveId != null ? String(ev.data.liveId) : null;
      // A done without liveId is the legacy protocol: it closes the open bubble
      // only when it carries the assistant text. A tool-only done must not.
      const closes = doneLive ? doneLive === liveId : Boolean(ev.data.text);
      if (closes) {
        liveId = null;
        liveText = '';
      }
    }
  }
  return { liveId, liveText };
}

function toolFromResultEntry(entry, ctx) {
  const result = entry.model?.[0];
  if (!result?.toolCallId) return null;
  const args = ctx?.toolInputs?.get(result.toolCallId) || {};
  const diff = ctx?.toolDiffs?.get(result.toolCallId);
  return {
    event: 'tool.end',
    data: {
      tool: toolBody({
        id: result.toolCallId,
        name: result.toolName,
        status: result.isError ? 'error' : 'completed',
        input: args,
        output: toolOutput(entry, result),
        path: args.path,
        added: diff?.added,
        removed: diff?.removed,
      }),
    },
  };
}

/**
 * Events a late subscriber still needs from the watch snapshot.
 * watchEvents does not replay, so anything already stored is left alone.
 */
export function snapshotGap(snapshot, existing, ctx) {
  const seenDone = new Set();
  const seenTools = new Set();
  for (const ev of existing || []) {
    if (ev?.event === 'message.done' && ev.data?.messageId != null) seenDone.add(String(ev.data.messageId));
    if (ev?.event === 'tool.end' && ev.data?.tool?.id != null) seenTools.add(String(ev.data.tool.id));
  }
  const open = foldLive(existing);
  if (open.liveId) noteLiveId(ctx, open.liveId);
  const liveText = open.liveText;
  const events = [];
  for (const entry of snapshot?.entries || []) {
    if (entry?.kind === 'pi.user' || entry?.kind === 'pi.assistant') {
      const id = String(entry.id);
      if (seenDone.has(id)) continue;
      const done = messageDone(entry);
      if (entry.kind === 'pi.assistant' && open.liveId && done.data.text && done.data.text === liveText) {
        done.data.liveId = open.liveId;
        open.liveId = null;
        if (ctx) ctx.liveId = null;
      }
      events.push(done);
      seenDone.add(id);
      const usage = usageEvent(entry);
      if (usage) events.push(usage);
      continue;
    }
    if (entry?.kind === 'pi.tool-result') {
      const end = toolFromResultEntry(entry, ctx);
      if (!end || seenTools.has(String(end.data.tool.id))) continue;
      events.push(end);
      seenTools.add(String(end.data.tool.id));
    }
  }
  const partial = textOf(snapshot?.generation?.message?.content);
  if (partial && partial !== liveText) {
    const already = (snapshot?.entries || []).some((entry) => (
      entry?.kind === 'pi.assistant'
      && seenDone.has(String(entry.id))
      && textOf(entry.model?.[0]?.content) === partial
    ));
    if (!already) {
      const messageId = open.liveId || ensureLiveId(ctx);
      noteLiveId(ctx, messageId);
      events.push({
        event: 'message.delta',
        data: { messageId, text: partial, replace: true },
      });
    }
  }
  return events;
}

/** Transcript entries to the contract message list, plus the latest reported call usage. */
export function messagesFromEntries(entries) {
  const calls = new Map();
  const usage = latestCallUsage(entries);
  for (const entry of entries || []) {
    if (entry?.kind !== 'pi.assistant') continue;
    const content = entry.model?.[0]?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === 'toolCall' && block.id) calls.set(block.id, block.arguments || {});
    }
  }
  const messages = [];
  for (const entry of entries || []) {
    if (entry?.kind === 'pi.user' || entry?.kind === 'pi.assistant') {
      const text = textOf(entry.model?.[0]?.content);
      if (entry.kind === 'pi.assistant' && !text) continue;
      const msg = { id: String(entry.id), role: entry.kind === 'pi.user' ? 'user' : 'assistant' };
      if (text) msg.text = text;
      messages.push(msg);
      continue;
    }
    if (entry?.kind !== 'pi.tool-result') continue;
    const result = entry.model?.[0];
    if (!result) continue;
    const input = calls.get(result.toolCallId) || {};
    const tool = toolBody({
      id: result.toolCallId,
      name: result.toolName,
      status: result.isError ? 'error' : 'completed',
      input,
      output: toolOutput(entry, result),
      path: input.path,
    });
    messages.push({ id: String(entry.id), role: 'tool', text: tool.output || '', tool });
  }
  return { messages, usage };
}

export function synthesizeStatus(conv, busy) {
  const mark = conv?.hostMark || null;
  if (mark === 'stopped') return 'stopped';
  if (mark === 'paused') return 'paused';
  if (mark === 'failed') return 'failed';
  if (busy) return mark === 'recovering' ? 'recovering' : 'running';
  if (conv?.status === 'failed') return 'failed';
  if (conv?.status === 'done') return 'done';
  if (conv?.status === 'running' || conv?.status === 'recovering') return conv.status;
  return conv?.status || 'idle';
}
