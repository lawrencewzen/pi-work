export const DEFAULT_SETTINGS = {
  provider: 'openai',
  baseUrl: '',
  apiKey: '',
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
  const out = { ...DEFAULT_SETTINGS, ...(raw && typeof raw === 'object' ? raw : {}) };
  if (!out.models || typeof out.models !== 'object' || Array.isArray(out.models)) out.models = {};
  out.plugins = normalizeFlagMap(out.plugins);
  out.skills = normalizeFlagMap(out.skills);
  if (typeof out.theme === 'string' && out.theme.includes('-')) {
    const [family, mode] = out.theme.split('-');
    if (THEMES.has(family)) out.theme = family;
    if (APPEARANCES.has(mode) && !raw.appearance) out.appearance = mode;
  }
  if (!THEMES.has(out.theme)) out.theme = 'white';
  if (!APPEARANCES.has(out.appearance)) out.appearance = 'light';
  if (!LANGS.has(out.language)) out.language = 'zh';
  if (typeof out.provider !== 'string' || !out.provider) out.provider = 'openai';
  if (typeof out.baseUrl !== 'string') out.baseUrl = '';
  if (typeof out.apiKey !== 'string') out.apiKey = '';
  // Grok session lives in ~/.grok/auth.json, never in the settings row.
  delete out.grok;
  return out;
}

export function publicSettings(s) {
  const n = normalizeSettings(s);
  return {
    provider: n.provider,
    baseUrl: n.baseUrl,
    apiKey: maskApiKey(n.apiKey),
    hasApiKey: Boolean(n.apiKey),
    models: { ...n.models },
    language: n.language,
    theme: n.theme,
    appearance: n.appearance,
    plugins: { ...n.plugins },
    skills: { ...n.skills },
  };
}

export function mergeSettings(prev, patch = {}) {
  const cur = normalizeSettings(prev);
  const next = { ...cur };
  if (patch.provider != null) next.provider = String(patch.provider);
  if (patch.baseUrl != null) next.baseUrl = String(patch.baseUrl);
  if (patch.language != null) next.language = String(patch.language);
  if (patch.theme != null) next.theme = String(patch.theme);
  if (patch.appearance != null) next.appearance = String(patch.appearance);
  const hasNewKey = Object.prototype.hasOwnProperty.call(patch, 'apiKey')
    && !isMaskedOrEmptyApiKey(patch.apiKey, maskApiKey(cur.apiKey));
  if (hasNewKey) next.apiKey = String(patch.apiKey);
  const baseUrlChanging = patch.baseUrl != null && String(patch.baseUrl) !== String(cur.baseUrl);
  const providerChanging = patch.provider != null && String(patch.provider) !== String(cur.provider);
  if ((baseUrlChanging || providerChanging) && !hasNewKey) {
    next.apiKey = '';
  }
  if (patch.models && typeof patch.models === 'object' && !Array.isArray(patch.models)) {
    next.models = { ...cur.models, ...patch.models };
  }
  if (patch.plugins && typeof patch.plugins === 'object' && !Array.isArray(patch.plugins)) {
    next.plugins = { ...cur.plugins, ...patch.plugins };
  }
  if (patch.skills && typeof patch.skills === 'object' && !Array.isArray(patch.skills)) {
    next.skills = { ...cur.skills, ...patch.skills };
  }
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
