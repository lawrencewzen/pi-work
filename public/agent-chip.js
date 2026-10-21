// Composer model chip. Ids come from the conversation override, the role
// binding, or the first usable source. Nothing here invents one.

function trimmed(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function bindingOf(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const sourceId = trimmed(value.sourceId);
  const model = trimmed(value.model);
  if (!sourceId || !model) return null;
  return { sourceId, model };
}

function sourceList(sources) {
  return Array.isArray(sources) ? sources.filter((item) => item && typeof item === 'object') : [];
}

/** Ollama is the only preset that does not need a key. Public sources use hasApiKey. */
export function sourceNeedsKey(source) {
  if (!source || source.kind === 'grok' || source.id === 'grok') return false;
  if (source.needsKey === false || source.vendor === 'ollama') return false;
  return true;
}

function sourceHasKey(source) {
  return Boolean(source?.hasApiKey) || Boolean(trimmed(source?.apiKey));
}

/**
 * Same gate as the server `sourceAvailable`: a Grok source needs a session,
 * an API source needs a base URL and a key when the vendor requires one.
 * A failed last test is also treated as unavailable here so the chip and the
 * settings page show the model that the UI will actually fall back to.
 */
export function sourceUsable(source, { grokSignedIn = false } = {}) {
  if (!source) return false;
  if (source.kind === 'grok' || source.id === 'grok') {
    if (!(grokSignedIn || source.session?.signedIn)) return false;
  } else {
    if (sourceNeedsKey(source) && !sourceHasKey(source)) return false;
    if (!trimmed(source.baseUrl)) return false;
  }
  if (source.lastTest && source.lastTest.ok === false) return false;
  return true;
}

/** Why a source row is not usable. Empty string means it can be selected. */
export function sourceBlockReason(source, options) {
  if (!source) return 'missing';
  if (source.kind === 'grok' || source.id === 'grok') {
    if (!(options?.grokSignedIn || source.session?.signedIn)) return 'unsigned';
  } else if (sourceNeedsKey(source) && !sourceHasKey(source)) {
    return 'no_key';
  } else if (!trimmed(source.baseUrl)) {
    return 'no_url';
  }
  if (source.lastTest && source.lastTest.ok === false) return 'offline';
  return '';
}

function listedModel(source, model) {
  const names = Array.isArray(source?.models) ? source.models : [];
  if (!names.length) return false;
  return names.includes(model);
}

function bindingTarget(sources, binding, options) {
  if (!binding) return null;
  const source = sources.find((item) => item.id === binding.sourceId);
  if (!source || !sourceUsable(source, options)) return null;
  if (!listedModel(source, binding.model)) return null;
  return { source, model: binding.model };
}

/**
 * Role binding, then default, then the first model on the first usable source.
 * A role-template model string prefers a usable source that lists it; otherwise
 * the resolved source keeps that name. String values in `models` are ignored.
 */
export function resolveRoleTarget({ role, roleId, models, sources, grokSignedIn = false } = {}) {
  const list = sourceList(sources);
  const map = models && typeof models === 'object' && !Array.isArray(models) ? models : {};
  const options = { grokSignedIn };
  const rid = trimmed(roleId) || trimmed(role?.id);
  let resolved = null;
  if (rid) resolved = bindingTarget(list, bindingOf(map[rid]), options);
  if (!resolved && rid !== 'default') resolved = bindingTarget(list, bindingOf(map.default), options);
  if (!resolved) {
    for (const source of list) {
      if (!sourceUsable(source, options)) continue;
      const name = (source.models || []).find((item) => typeof item === 'string' && item.trim());
      if (!name) continue;
      resolved = { source, model: name.trim() };
      break;
    }
  }
  const hinted = trimmed(role?.model);
  if (!hinted) return resolved;
  const listed = list.find((source) => sourceUsable(source, options) && listedModel(source, hinted));
  if (listed) return { source: listed, model: hinted };
  if (resolved) return { source: resolved.source, model: hinted };
  return null;
}

export function resolveDispatchModel(input = {}) {
  return resolveRoleTarget(input)?.model || '';
}

export function httpOrigin(value) {
  const text = trimmed(value);
  if (!text) return '';
  try {
    const url = new URL(text);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.origin;
  } catch {
    return '';
  }
}

/** True when the value is empty or the masked form the server already returned. */
export function isMaskedOrEmptyKey(value, currentMasked = '') {
  if (value == null) return true;
  const text = String(value).trim();
  if (!text) return true;
  if (currentMasked && text === currentMasked) return true;
  if (/^[•*]+\w{0,4}$/.test(text)) return true;
  return false;
}

/**
 * Editing a source onto a different origin drops the stored key on the server.
 * The form must ask for a new key before that request is sent.
 */
export function needsFreshKey({ previousUrl = '', nextUrl = '', apiKey = '', maskedKey = '', needsKey = true } = {}) {
  if (!needsKey) return false;
  const previous = httpOrigin(previousUrl);
  const next = httpOrigin(nextUrl);
  if (!previous || !next || previous === next) return false;
  return isMaskedOrEmptyKey(apiKey, maskedKey);
}

/** Conversation override when that source is still usable; otherwise null. */
export function resolveConversationModel({ conv, sources, grokSignedIn = false } = {}) {
  const sourceId = trimmed(conv?.modelSourceId);
  const model = trimmed(conv?.modelId);
  if (!sourceId || !model) return null;
  const source = sourceList(sources).find((item) => item.id === sourceId);
  if (!source || !sourceUsable(source, { grokSignedIn })) return null;
  return { source, model };
}

export function composerAgentPresentation({
  conv,
  roles,
  models,
  sources,
  grokSignedIn = false,
} = {}) {
  const pinned = resolveConversationModel({ conv, sources, grokSignedIn });
  const list = Array.isArray(roles) ? roles : [];
  const roleId = trimmed(conv?.roleId);
  const role = list.find((item) => item && item.id === roleId) || null;
  const fallback = resolveDispatchModel({
    role,
    roleId,
    models,
    sources,
    grokSignedIn,
  });
  const model = pinned?.model || fallback;
  return {
    text: model,
    model,
    followingDefault: !pinned,
    sourceId: pinned?.source?.id || '',
  };
}
