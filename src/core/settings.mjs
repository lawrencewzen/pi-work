import { normalizeRoleModels, normalizeSources, publicSource } from './model-sources.mjs';
import { normalizeGitConnections } from './git-connections.mjs';

export const DEFAULT_SETTINGS = {
  version: 2,
  provider: 'openai',
  baseUrl: '',
  apiKey: '',
  sources: [],
  models: {},
  language: 'zh',
  theme: 'white',
  appearance: 'light',
  plugins: {},
  skills: {},
};

const THEMES = new Set(['white', 'claude', 'codex', 'grok', 'cursor']);
const APPEARANCES = new Set(['light', 'dark', 'system']);
const LANGS = new Set(['zh', 'en']);

/** Last 4 characters only, e.g. `••••abcd`. No sk- prefix. */
export function maskApiKey(key) {
  if (!key) return '';
  const s = String(key);
  if (!s) return '';
  return `••••${s.slice(-4)}`;
}

/**
 * Empty/null, equal to the currently masked form, or our bullet-mask pattern.
 * Does not treat arbitrary `...` / `**` inside a real key as masked.
 */
export function isMaskedOrEmptyApiKey(value, currentMasked = '') {
  if (value == null) return true;
  const s = String(value).trim();
  if (!s) return true;
  if (currentMasked && s === currentMasked) return true;
  if (/^[•*]+\w{0,4}$/.test(s)) return true;
  return false;
}

export function normalizeSettings(raw = {}) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const v2 = input.version === 2;
  const out = { ...DEFAULT_SETTINGS, ...input };
  if (!out.models || typeof out.models !== 'object' || Array.isArray(out.models)) out.models = {};
  out.plugins = normalizeFlagMap(out.plugins);
  out.skills = normalizeFlagMap(out.skills);
  if (typeof out.theme === 'string' && out.theme.includes('-')) {
    const [family, mode] = out.theme.split('-');
    if (THEMES.has(family)) out.theme = family;
    if (APPEARANCES.has(mode) && !input.appearance) out.appearance = mode;
  }
  if (!THEMES.has(out.theme)) out.theme = 'white';
  if (!APPEARANCES.has(out.appearance)) out.appearance = 'light';
  if (!LANGS.has(out.language)) out.language = 'zh';
  if (typeof out.provider !== 'string' || !out.provider) out.provider = 'openai';
  if (typeof out.baseUrl !== 'string') out.baseUrl = '';
  if (typeof out.apiKey !== 'string') out.apiKey = '';
  if (v2) {
    out.version = 2;
    delete out.provider;
    delete out.baseUrl;
    delete out.apiKey;
    out.sources = normalizeSources(out.sources);
    out.models = normalizeRoleModels(out.models);
  } else {
    delete out.version;
    if (!Array.isArray(input.sources)) delete out.sources;
  }
  // Grok session lives in ~/.grok/auth.json, never in the settings row.
  delete out.grok;
  const gitConnections = normalizeGitConnections(out.gitConnections);
  if (gitConnections.length) out.gitConnections = gitConnections;
  else delete out.gitConnections;
  return out;
}

export function publicSettings(s) {
  const n = normalizeSettings(s);
  const body = {
    models: { ...n.models },
    language: n.language,
    theme: n.theme,
    appearance: n.appearance,
    plugins: { ...n.plugins },
    skills: { ...n.skills },
  };
  if (n.version === 2) {
    body.version = 2;
    body.sources = (n.sources || []).map((source) => publicSource(source));
  } else {
    body.provider = n.provider;
    body.baseUrl = n.baseUrl;
    body.apiKey = maskApiKey(n.apiKey);
    body.hasApiKey = Boolean(n.apiKey);
  }
  return body;
}

export function mergeSettings(prev, patch = {}) {
  const patchObj = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
  const cur = normalizeSettings(prev);
  const replacingLegacy = cur.version !== 2 && patchObj.version === 2;
  const next = replacingLegacy
    ? {
      ...cur,
      ...patchObj,
      version: 2,
      sources: Array.isArray(patchObj.sources) ? patchObj.sources : [],
      models: patchObj.models && typeof patchObj.models === 'object' && !Array.isArray(patchObj.models)
        ? { ...patchObj.models }
        : {},
    }
    : { ...cur };
  if (!replacingLegacy) {
    if (cur.version !== 2) {
      if (patchObj.provider != null) next.provider = String(patchObj.provider);
      if (patchObj.baseUrl != null) next.baseUrl = String(patchObj.baseUrl);
      const hasNewKey = Object.prototype.hasOwnProperty.call(patchObj, 'apiKey')
        && !isMaskedOrEmptyApiKey(patchObj.apiKey, maskApiKey(cur.apiKey));
      if (hasNewKey) next.apiKey = String(patchObj.apiKey);
      const baseUrlChanging = patchObj.baseUrl != null && String(patchObj.baseUrl) !== String(cur.baseUrl);
      const providerChanging = patchObj.provider != null && String(patchObj.provider) !== String(cur.provider);
      if ((baseUrlChanging || providerChanging) && !hasNewKey) next.apiKey = '';
    }
    if (patchObj.language != null) next.language = String(patchObj.language);
    if (patchObj.theme != null) next.theme = String(patchObj.theme);
    if (patchObj.appearance != null) next.appearance = String(patchObj.appearance);
    if (patchObj.models && typeof patchObj.models === 'object' && !Array.isArray(patchObj.models)) {
      const models = { ...(cur.models && typeof cur.models === 'object' ? cur.models : {}) };
      for (const [key, value] of Object.entries(patchObj.models)) {
        if (value == null) delete models[key];
        else models[key] = value;
      }
      next.models = models;
    }
    if (Array.isArray(patchObj.sources)) next.sources = patchObj.sources;
    if (patchObj.version === 2) next.version = 2;
  }
  if (patchObj.plugins && typeof patchObj.plugins === 'object' && !Array.isArray(patchObj.plugins)) {
    next.plugins = { ...(cur.plugins || {}), ...patchObj.plugins };
  }
  if (patchObj.skills && typeof patchObj.skills === 'object' && !Array.isArray(patchObj.skills)) {
    next.skills = { ...(cur.skills || {}), ...patchObj.skills };
  }
  if (Object.prototype.hasOwnProperty.call(patchObj, 'gitConnections')) {
    next.gitConnections = patchObj.gitConnections;
  }
  delete next.grok;
  return normalizeSettings(next);
}

const FLAG_KEY = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

function normalizeFlagMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const [key, flag] of Object.entries(value)) {
    if (!FLAG_KEY.test(key)) continue;
    out[key] = !(flag === false || flag === 'false' || flag === 0 || flag === '0');
  }
  return out;
}
