export const DEFAULT_SETTINGS = {
  provider: 'openai',
  baseUrl: '',
  apiKey: '',
  models: {},
  language: 'zh',
  theme: 'white',
  appearance: 'light',
  plugins: {},
};

const THEMES = new Set(['white', 'claude', 'codex', 'grok', 'cursor']);
const APPEARANCES = new Set(['light', 'dark', 'system']);
const LANGS = new Set(['zh', 'en']);

export function maskApiKey(key) {
  if (!key) return '';
  const s = String(key);
  if (s.length <= 4) return `…${s}`;
  return `${s.slice(0, 3)}…${s.slice(-4)}`;
}

export function isMaskedOrEmptyApiKey(value) {
  if (value == null) return true;
  const s = String(value).trim();
  if (!s) return true;
  if (s.includes('…') || s.includes('...') || /[•*]{2,}/.test(s)) return true;
  return false;
}

export function normalizeSettings(raw = {}) {
  const out = { ...DEFAULT_SETTINGS, ...(raw && typeof raw === 'object' ? raw : {}) };
  if (!out.models || typeof out.models !== 'object' || Array.isArray(out.models)) out.models = {};
  if (!out.plugins || typeof out.plugins !== 'object' || Array.isArray(out.plugins)) out.plugins = {};
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
  if (Object.prototype.hasOwnProperty.call(patch, 'apiKey') && !isMaskedOrEmptyApiKey(patch.apiKey)) {
    next.apiKey = String(patch.apiKey);
  }
  if (patch.models && typeof patch.models === 'object' && !Array.isArray(patch.models)) {
    next.models = { ...cur.models, ...patch.models };
  }
  if (patch.plugins && typeof patch.plugins === 'object' && !Array.isArray(patch.plugins)) {
    next.plugins = { ...cur.plugins, ...patch.plugins };
  }
  return normalizeSettings(next);
}
