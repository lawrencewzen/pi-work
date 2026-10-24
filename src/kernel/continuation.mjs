// Auto-continue when a generation hits the output length cap.
// Continuation is Harness `onYield` only; this module does not schedule a run.
import { defineExtension, GenerationTask, hook } from '@earendil-works/pi-durable';
import { EXT_CONTINUATION } from './ids.mjs';
import {
  CONTINUE_TEXT,
  MAX_AUTO_CONTINUES,
  isAutoContinueText,
} from '../../public/continuation.js';

export {
  AUTO_CONTINUE_PREFIX,
  CONTINUE_TEXT,
  MANUAL_CONTINUE_TEXT,
  MAX_AUTO_CONTINUES,
  isAutoContinueText,
  isPromptUserMessage,
} from '../../public/continuation.js';

function messageText(message) {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  if (typeof message.text === 'string') return message.text;
  if (Array.isArray(message.content)) {
    return message.content.map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part.text === 'string') return part.text;
      return '';
    }).join('');
  }
  if (message.model?.[0]) return messageText(message.model[0]);
  return '';
}

function roleOf(message) {
  if (!message) return '';
  if (message.role) return message.role;
  if (message.kind === 'pi.user') return 'user';
  if (message.kind === 'pi.assistant') return 'assistant';
  return '';
}

/**
 * Auto-continue user messages after the most recent real user prompt.
 * Walks backward so a later human message resets the count.
 */
export function consecutiveAutoContinues(messages) {
  let count = 0;
  for (let i = (messages || []).length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (roleOf(message) !== 'user') continue;
    if (isAutoContinueText(messageText(message))) {
      count += 1;
      continue;
    }
    break;
  }
  return count;
}

export function shouldContinueFromLength(answer, messages) {
  if (answer?.stopReason !== 'length') return false;
  if (!Array.isArray(messages)) return false;
  return consecutiveAutoContinues(messages) < MAX_AUTO_CONTINUES;
}

async function messagesForYield(api, context) {
  if (!api || typeof api.context !== 'function' || !api.conversationId) return null;
  try {
    const view = await api.context(api.conversationId, context);
    if (Array.isArray(view?.entries)) return view.entries;
    if (Array.isArray(view?.messages)) return view.messages;
    return [];
  } catch {
    return null;
  }
}

/** Install the generation hook that continues a length-capped answer in the same run. */
export function installContinuationExtension(registry) {
  if (!registry) throw new Error('registry is required');
  registry.install(defineExtension({
    name: EXT_CONTINUATION,
    hooks: [
      hook(GenerationTask, {
        async onYield(answer, api, context) {
          const messages = await messagesForYield(api, context);
          if (!shouldContinueFromLength(answer, messages)) return undefined;
          return { continue: CONTINUE_TEXT };
        },
      }),
    ],
  }));
}
