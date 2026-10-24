// Read-only view of pi-ai's bundled chat catalog. Callers must not copy the
// JSON into this repo; matching is by model id and source hostname.
import { getBuiltinModels, getBuiltinProviders } from '@earendil-works/pi-ai/providers/all';

let cached = null;

function chatCatalog() {
  if (cached) return cached;
  const list = [];
  for (const provider of getBuiltinProviders()) {
    for (const model of getBuiltinModels(provider)) {
      if (!model || typeof model.id !== 'string' || !model.id) continue;
      list.push(model);
    }
  }
  cached = list;
  return list;
}

export function hostnameOf(url) {
  const text = String(url || '').trim();
  if (!text) return '';
  try {
    return new URL(text).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Find a pi-ai catalog entry for (model id, source baseUrl).
 * Same id + same hostname first; otherwise the id must be unique in the catalog.
 */
export function lookupModelCatalog(modelId, baseUrl) {
  const id = typeof modelId === 'string' ? modelId.trim() : '';
  if (!id) return null;
  const hits = chatCatalog().filter((model) => model.id === id);
  if (!hits.length) return null;
  const host = hostnameOf(baseUrl);
  if (host) {
    const hostHits = hits.filter((model) => hostnameOf(model.baseUrl) === host);
    if (hostHits.length) return hostHits[0];
  }
  if (hits.length === 1) return hits[0];
  return null;
}

export function catalogContextWindow(entry) {
  const n = entry?.contextWindow;
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function catalogMaxTokens(entry) {
  const n = entry?.maxTokens;
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Compact catalog snapshot for provider fingerprints. */
export function catalogFingerprint(modelId, baseUrl) {
  const entry = lookupModelCatalog(modelId, baseUrl);
  if (!entry) return null;
  return [
    entry.contextWindow ?? null,
    entry.maxTokens ?? null,
    entry.reasoning === true,
    entry.input ?? null,
    entry.cost ?? null,
    entry.compat ?? null,
    entry.thinkingLevelMap ?? null,
  ];
}
