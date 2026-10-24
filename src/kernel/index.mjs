// Pi Durable 内核。server.mjs 的默认路径不经过这里。
import path from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { Harness } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { migrateWeftIds } from './migrate-weft-ids.mjs';

const context = BACKGROUND_CONTEXT;

/** Model ref for pi-ai's faux provider. Tests script responses on the handle from registerFaux. */
export const FAUX_MODEL = { provider: 'faux', modelId: 'faux-1' };

// README: one process owns a storage at a time. This process opens one Harness.
let openSlot = null;

function formatClosedError(error) {
  if (!(error instanceof Error)) {
    try {
      return String(error);
    } catch {
      return 'unknown error';
    }
  }
  const parts = [error.message || error.name];
  if (error.cause instanceof Error && error.cause.message) parts.push(error.cause.message);
  else if (error.cause != null) {
    try { parts.push(String(error.cause)); } catch { /* ignore */ }
  }
  return parts.join(': ');
}

/**
 * Storage errors close the Harness. Log the reason and exit so scripts/dev.sh and Docker restart the process.
 * Do not retry or reopen here.
 */
export function watchHarnessClosed(harness) {
  if (!harness || typeof harness.closed?.then !== 'function') return;
  harness.closed.then((end) => {
    if (end?.reason !== 'failed') return;
    console.error(`WEFT_HARNESS_CLOSED ${formatClosedError(end.error)}`);
    process.exit(1);
  });
}

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
export async function openKernel({ dataDir, models, registry, settings, env } = {}) {
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
    await migrateWeftIds(dataDir);
    storage = await openNodeSqliteStorage(storagePath);
    const harness = await Harness.open(storage, {
      models,
      registry,
      ...(settings ? { settings } : {}),
      ...(env ? { env } : {}),
    }, context);
    watchHarnessClosed(harness);
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
    };
  } catch (error) {
    if (openSlot === slot) openSlot = null;
    if (storage) await storage.close(context).catch(() => {});
    throw error;
  }
}
