// Map a model-source probe failure onto the current UI language.
// `error` stays the redacted vendor/transport text; `code` is preferred when present.

const CODES = new Set(['network', 'timeout', 'bad_json', 'auth', 'not_found', 'http']);

const CANNED = new Set([
  'timeout',
  'timed out',
  'etimedout',
  'invalid json',
  'fetch failed',
  'failed to fetch',
  'request failed',
  'network error',
  'networkerror',
  'socket hang up',
  'connect failed',
  'the operation was aborted due to timeout',
  'this operation was aborted',
]);

const KNOWN_ERROR = {
  'base url required': 'src_err_url',
  'api key required': 'src_err_key',
};

function normalizeCode(code) {
  const text = String(code || '').trim().toLowerCase();
  return CODES.has(text) ? text : '';
}

function normalizeStatus(status) {
  const value = typeof status === 'number' ? status : Number(status);
  if (!Number.isInteger(value) || value < 100 || value > 599) return 0;
  return value;
}

function kindFromStatus(status) {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'not_found';
  if (status) return 'http';
  return '';
}

function stripped(raw) {
  return String(raw || '')
    .replace(/\bsk-\*{3,}/gi, '')
    .replace(/\*{2,}/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function isCanned(raw) {
  const text = String(raw || '').trim();
  if (!text) return true;
  const lower = text.toLowerCase();
  if (CANNED.has(lower) || CANNED.has(stripped(text))) return true;
  if (/^http\s+\d{3}$/i.test(text)) return true;
  if (/^(?:connect |getaddrinfo |read |write )?(?:econnrefused|enotfound|econnreset|ehostunreach|enetunreach|eai_again|epipe|econnaborted|etimedout)(?:\s+[\d.:a-f[\]]+)?$/i.test(text)) return true;
  return false;
}

function isTimeoutText(raw) {
  const text = String(raw || '').trim();
  if (!text || /^http\s+\d{3}\b/i.test(text)) return false;
  const lower = text.toLowerCase();
  if (CANNED.has(lower) && (lower.includes('timeout') || lower.includes('timed out') || lower === 'etimedout' || lower.includes('aborted'))) return true;
  return /\btimeout\b|\btimed out\b|\betimedout\b/i.test(text);
}

function isNetworkText(raw) {
  const text = String(raw || '').trim();
  if (!text) return false;
  const lower = text.toLowerCase();
  if ([
    'fetch failed',
    'failed to fetch',
    'network error',
    'networkerror',
    'socket hang up',
    'connect failed',
    'request failed',
  ].includes(lower)) return true;
  return /\b(econnrefused|enotfound|econnreset|ehostunreach|enetunreach|eai_again|epipe|econnaborted)\b|socket hang up|failed to fetch|fetch failed|networkerror/i.test(text);
}

export function classifyProbeFailure(input = {}) {
  const raw = String(input?.error ?? '').trim();
  const explicit = normalizeCode(input?.code);
  let status = normalizeStatus(input?.status);
  const httpMatch = raw.match(/^HTTP\s+(\d{3})\b/i);
  if (!status && httpMatch) status = Number(httpMatch[1]);
  let kind = explicit;
  if (!kind) {
    if (httpMatch) kind = kindFromStatus(status);
    else if (/^invalid json$/i.test(raw)) kind = 'bad_json';
    else if (isTimeoutText(raw)) kind = 'timeout';
    else if (isNetworkText(raw)) kind = 'network';
  }
  const detail = raw && !isCanned(raw) ? raw : '';
  return { kind, status, detail };
}

function applyVars(key, vars = {}) {
  let text = String(key);
  for (const [name, value] of Object.entries(vars || {})) {
    text = text.replaceAll(`{${name}}`, String(value));
  }
  return text;
}

export function formatProbeFailure(input, translate) {
  const t = typeof translate === 'function' ? translate : ((key, vars) => applyVars(key, vars));
  const raw = String(input?.error ?? '').trim();
  const known = KNOWN_ERROR[raw.toLowerCase()];
  if (known && !normalizeCode(input?.code)) return t(known);
  const { kind, status, detail } = classifyProbeFailure(input);
  if (!kind) {
    if (!raw) return '';
    return t('probe_unknown', { detail: raw });
  }
  const label = kind === 'http'
    ? (status ? t('probe_http', { status }) : t('probe_http_plain'))
    : t(`probe_${kind}`);
  if (!detail) return label;
  return t('probe_with_detail', { label, detail });
}

/** Status line for a source row. Ollama keeps its own copy when the probe is a network failure. */
export function sourceProbeStatus(source, reason, translate) {
  const t = typeof translate === 'function' ? translate : ((key, vars) => applyVars(key, vars));
  if (reason === 'offline' && source?.lastTest && source.lastTest.ok === false) {
    const kind = classifyProbeFailure(source.lastTest).kind;
    if (source.vendor === 'ollama' && (!kind || kind === 'network')) return t('src_why_ollama');
    const text = formatProbeFailure(source.lastTest, t);
    if (text) return text;
  }
  if (reason === 'unsigned') return t('src_why_unsigned');
  if (reason === 'no_key') return t('src_why_no_key');
  if (reason === 'no_url') return t('src_why_no_url');
  if (reason === 'offline') return source?.vendor === 'ollama' ? t('src_why_ollama') : t('src_why_offline');
  return '';
}
