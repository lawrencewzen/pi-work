// Read-only archive of conversations the old orchestrator created.
// Those rows have no harness id. Their messages, tool calls, and diffs stay in
// the application tables. Opening a new conversation copies only the visible
// user and assistant text into a Harness document; a prompt section renders it.
// Old rows are not appended as pi.user / pi.assistant / pi.tool-result entries.
import { defineDoc, defineExtension, section } from '@earendil-works/pi-durable';

export const ARCHIVED_STATUS = 'archived';
export const ARCHIVED_ERROR = 'err_archived';

/** Conversation-scoped opening context. Empty until a history fork writes it. */
export const ArchiveContext = defineDoc({
  kind: 'pi-work.archive-context',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'current',
  initial: () => ({ text: '' }),
});

export function isArchivedConversation(conv) {
  return Boolean(conv) && conv.harnessId == null;
}

export function archivedMutation() {
  return { status: 409, body: { error: ARCHIVED_ERROR, status: ARCHIVED_STATUS } };
}

/**
 * Visible user and assistant text, in transcript order.
 * Tool rows are omitted, including their output. Blank text is omitted.
 */
export function visibleTurns(messages) {
  const turns = [];
  for (const msg of messages || []) {
    if (!msg || (msg.role !== 'user' && msg.role !== 'assistant')) continue;
    const text = String(msg.text ?? '').trim();
    if (!text) continue;
    turns.push({ role: msg.role, text });
  }
  return turns;
}

/** Opening context for a new Harness conversation. Empty when nothing visible remains. */
export function openingContext(messages) {
  const turns = visibleTurns(messages);
  if (!turns.length) return '';
  const body = turns.map((turn) => `${turn.role === 'user' ? 'User' : 'Assistant'}:\n${turn.text}`).join('\n\n');
  return `Earlier conversation, copied as text only. Tool calls were not replayed.\n\n${body}`;
}

export function presentArchived(conv, { includeMessages = false, messages = [] } = {}) {
  const out = {
    ...conv,
    status: ARCHIVED_STATUS,
    archived: true,
    usage: conv.usage || null,
  };
  if (includeMessages) out.messages = messages;
  return out;
}

/** Install the section that renders ArchiveContext. Selected with the other host extensions. */
export function installArchiveExtension(registry) {
  if (!registry) throw new Error('registry is required');
  registry.install(defineExtension({
    name: 'pi-work-archive-context',
    sections: [
      section('archive-context', async (input, context) => {
        try {
          const doc = await input.read.snapshot(ArchiveContext, input.conversationId, context);
          const text = String(doc?.text || '').trim();
          return text || undefined;
        } catch (err) {
          console.error(`PI_WORK_KERNEL_ARCHIVE ${err instanceof Error ? err.message : err}`);
          return undefined;
        }
      }),
    ],
  }));
}

/**
 * Create a kernel conversation in the same workspace and store the visible
 * history as opening context. Does not submit a model turn and does not copy
 * the pipeline, so no handoff is admitted.
 */
export async function openFromHistory({ conv, title, store, harness, context, createConversation } = {}) {
  if (!conv) return { status: 404, body: { error: 'conversation not found' } };
  if (!isArchivedConversation(conv)) return { status: 409, body: { error: 'err_not_archived' } };
  if (typeof createConversation !== 'function') throw new Error('createConversation is required');
  const messages = store ? await store.getMessages(conv.id) : [];
  const text = openingContext(messages);
  const requested = typeof title === 'string' ? title.trim() : '';
  const created = await createConversation({
    workspaceId: conv.workspaceId,
    workspacePath: conv.workspacePath,
    title: requested || conv.title || 'New conversation',
    roleId: conv.roleId,
    status: 'idle',
  });
  if (text && created?.harnessId && harness) {
    const conversation = await harness.conversation(created.harnessId, context);
    if (conversation) {
      await conversation.commit(async (tx) => {
        const doc = await tx.doc(ArchiveContext, conversation.id);
        doc.text = text;
      }, context);
    }
  }
  return {
    status: 201,
    body: {
      id: created.id,
      workspaceId: created.workspaceId,
      title: created.title,
      status: 'idle',
      sourceConversationId: conv.id,
    },
  };
}
