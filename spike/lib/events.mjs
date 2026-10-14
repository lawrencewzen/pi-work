import { textOf } from './text.mjs';

function deltaText(changes) {
  if (!Array.isArray(changes)) return '';
  return changes.flatMap((change) => {
    if (!change || typeof change !== 'object') return [];
    if ((change.type === 'text_delta' || change.type === 'thinking_delta') && typeof change.delta === 'string') {
      return [change.delta];
    }
    return [];
  }).join('');
}

/**
 * Map one experimental Pi Durable agent event onto the names the current UI
 * already consumes (tests/docs/API_CONTRACT.md §4). Unmapped events stay
 * available on the raw stream; this only covers the overlap.
 */
export function toSseLike(event) {
  if (!event || typeof event !== 'object') return null;
  switch (event.type) {
    case 'run_start':
      return { event: 'status', data: { status: 'running' } };
    case 'run_end':
      return { event: 'status', data: { status: 'idle' } };
    case 'message_update':
      return { event: 'message.delta', data: { text: deltaText(event.changes) } };
    case 'message_end':
      return {
        event: 'message.done',
        data: {
          messageId: event.entry?.id,
          kind: event.entry?.kind,
          text: textOf(event.entry?.model?.[0]),
        },
      };
    case 'tool_execution_start':
      return {
        event: 'tool.start',
        data: { tool: { id: event.toolCallId, name: event.toolName, input: event.args } },
      };
    case 'tool_execution_end':
      return {
        event: 'tool.end',
        data: { tool: { id: event.toolCallId, name: event.toolName } },
      };
    case 'auto_retry_start':
      return { event: 'retry', data: { attempt: event.attempt, reason: event.errorMessage } };
    case 'usage_changed':
      return { event: 'usage', data: { usage: event.usage } };
    case 'task_failed':
      return { event: 'error', data: { code: 'task_failed', message: event.message, kind: event.kind } };
    default:
      return null;
  }
}

export function formatTraceLine(conversationId, event) {
  const sse = toSseLike(event);
  const head = `conversation=${conversationId} raw=${event?.type || 'unknown'}`;
  if (!sse) return head;
  let data = '';
  try {
    data = JSON.stringify(sse.data);
  } catch {
    data = '"[unserializable]"';
  }
  if (data.length > 500) data = `${data.slice(0, 500)}…`;
  return `${head} sse=${sse.event} data=${data}`;
}
