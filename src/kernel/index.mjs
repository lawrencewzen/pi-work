// Pi Durable 内核。server.mjs 的默认路径不经过这里。
import path from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { Harness } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';

const context = BACKGROUND_CONTEXT;

/** Model ref for pi-ai's faux provider. Tests script responses on the handle from registerFaux. */
export const FAUX_MODEL = { provider: 'faux', modelId: 'faux-1' };

// README: one process owns a storage at a time. This process opens one Harness.
let openSlot = null;

/**
 * Install pi-ai's faux provider on a Models catalog so tests can call setResponses.
 * This does not read the product's script JSON.
 */
export function registerFaux(models, options) {
  if (!models || typeof models.setProvider !== 'function') throw new Error('models is required');
  const faux = fauxProvider(options);
  models.setProvider(faux.provider);
  return faux;
}

/**
 * Open the Pi Durable Harness on <dataDir>/harness/session.sqlite.
 * Returns the harness and a close function. A second open in this process throws
 * until close() finishes. Call harness.resume() after a restart to continue unfinished work.
 */
export async function openKernel({ dataDir, models, registry, settings } = {}) {
  if (!dataDir) throw new Error('dataDir is required');
  if (!models) throw new Error('models is required');
  if (!registry) throw new Error('registry is required');
  if (openSlot) {
    const error = new Error('Pi Durable Harness is already open in this process');
    error.code = 'E_HARNESS_OPEN';
    throw error;
  }
  const slot = {};
  openSlot = slot;
  const storagePath = path.join(path.resolve(dataDir), 'harness', 'session.sqlite');
  let storage;
  try {
    storage = await openNodeSqliteStorage(storagePath);
    const harness = await Harness.open(storage, {
      models,
      registry,
      ...(settings ? { settings } : {}),
    }, context);
    let closed = false;
    return {
      harness,
      context,
      storagePath,
      async close() {
        if (closed) return;
        closed = true;
        try {
          await harness.close(context);
        } finally {
          if (openSlot === slot) openSlot = null;
        }
      },
      async submit({ conversation, content, requestId, model } = {}) {
        if (typeof requestId !== 'string' || requestId.length === 0) throw new Error('requestId is required');
        if (content === undefined) throw new Error('content is required');
        const target = conversation ?? await createOwnerless(harness, model);
        const submission = await target.submit({ type: 'input', content, requestId }, context);
        const settled = await submission.wait(context);
        return { conversation: target, submission, settled };
      },
    };
  } catch (error) {
    if (openSlot === slot) openSlot = null;
    if (storage) await storage.close(context).catch(() => {});
    throw error;
  }
}

async function createOwnerless(harness, model) {
  if (!model?.provider || !model?.modelId) throw new Error('model { provider, modelId } is required');
  return harness.createConversation({
    ownership: { kind: 'ownerless' },
    agent: { model },
  }, context);
}
