import { actionFromGrokResponses, redactAuthText, toGrokResponsesBody } from '../core/grok-auth.mjs';

const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'read',
      description: 'Read a file in the workspace',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write',
      description: 'Write a file in the workspace',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit',
      description: 'Replace text in a workspace file',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, old: { type: 'string' }, new: { type: 'string' } },
        required: ['path', 'old', 'new'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ls',
      description: 'List a directory in the workspace',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep',
      description: 'Search file contents in the workspace',
      parameters: {
        type: 'object',
        properties: { pattern: { type: 'string' }, path: { type: 'string' }, glob: { type: 'string' } },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bash',
      description: 'Run a shell command in the workspace',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' }, timeout: { type: 'number' } },
        required: ['command'],
      },
    },
  },
];

function emptyOutput() {
  const err = new Error('empty model output');
  err.code = 'E_EMPTY_OUTPUT';
  return err;
}

function abortError() {
  const err = new Error('aborted');
  err.code = 'E_ABORTED';
  err.name = 'AbortError';
  return err;
}

function pickProviderMessage(json) {
  if (!json || typeof json !== 'object') return '';
  if (typeof json.message === 'string' && json.message.trim()) return json.message.trim();
  const err = json.error;
  if (typeof err === 'string' && err.trim()) return err.trim();
  if (err && typeof err === 'object') {
    if (typeof err.message === 'string' && err.message.trim()) return err.message.trim();
  }
  return '';
}

export function providerErrorText(body, status) {
  const raw = String(body ?? '').trim();
  let text = raw;
  if (raw.startsWith('{') || raw.startsWith('[')) {
    try {
      const picked = pickProviderMessage(JSON.parse(raw));
      if (picked) text = picked;
    } catch { /* keep the raw body */ }
  }
  const redacted = redactAuthText(text).trim();
  return redacted || (status ? `LLM HTTP ${status}` : '');
}

function httpError(status, body) {
  const err = new Error(providerErrorText(body, status));
  err.status = status;
  if (status === 429) err.code = 'ETIMEDOUT';
  else err.code = 'E_LLM';
  return err;
}

function toOpenAIMessages(messages = []) {
  const out = [];
  for (const m of messages) {
    if (!m) continue;
    if (m.role === 'system') out.push({ role: 'system', content: m.content ?? m.text ?? '' });
    else if (m.role === 'user') out.push({ role: 'user', content: m.content ?? m.text ?? '' });
    else if (m.role === 'assistant') {
      if (m.tool_calls) out.push({ role: 'assistant', content: m.content ?? m.text ?? null, tool_calls: m.tool_calls });
      else out.push({ role: 'assistant', content: m.content ?? m.text ?? '' });
    } else if (m.role === 'tool') {
      out.push({
        role: 'tool',
        tool_call_id: m.tool_call_id || m.tool?.id || m.id,
        content: typeof m.content === 'string' ? m.content : (m.text ?? JSON.stringify(m.output ?? m.tool?.output ?? '')),
      });
    }
  }
  return out;
}

function parseArgs(raw) {
  if (raw == null || raw === '') return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return { _raw: String(raw) }; }
}

export function createOpenAILLM({
  baseUrl = process.env.LLM_BASE_URL,
  apiKey = process.env.LLM_API_KEY,
  model = process.env.LLM_MODEL,
  stream = false,
  getConfig,
} = {}) {
  return {
    async next({ messages, signal, tools, model: modelOverride, roleId } = {}) {
      if (signal?.aborted) throw abortError();
      const last = [...(messages || [])].reverse().find((m) => m.role === 'assistant' || m.role === 'tool' || m.role === 'user');
      if (last?.role === 'assistant' && !last.tool_calls && (last.text || last.content)) {
        return { type: 'end' };
      }

      let cfg = { baseUrl, apiKey, model };
      if (typeof getConfig === 'function') {
        const extra = await getConfig({ roleId, model: modelOverride });
        if (extra && typeof extra === 'object') cfg = { ...cfg, ...extra };
      }
      const root = String(cfg.baseUrl || process.env.LLM_BASE_URL || '').replace(/\/$/, '');
      const key = cfg.apiKey || process.env.LLM_API_KEY;
      const mdl = modelOverride || cfg.model || process.env.LLM_MODEL;

      const allowed = Array.isArray(tools) && tools.length
        ? TOOL_DEFS.filter((t) => tools.includes(t.function.name))
        : TOOL_DEFS;

      const grok = cfg.api === 'grok-responses';
      const url = grok ? `${root}/responses` : `${root}/chat/completions`;
      const headers = {
        'content-type': 'application/json',
        ...(grok && cfg.headers && typeof cfg.headers === 'object' ? cfg.headers : {}),
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      };
      const body = grok
        ? toGrokResponsesBody(messages, allowed, mdl)
        : {
            model: mdl,
            messages: toOpenAIMessages(messages),
            tools: allowed,
            stream: !!stream,
          };

      const post = async (postHeaders) => {
        try {
          return await fetch(url, {
            method: 'POST',
            headers: postHeaders,
            body: JSON.stringify(body),
            signal,
          });
        } catch (err) {
          if (err?.name === 'AbortError' || signal?.aborted) throw abortError();
          if (err?.code) throw err;
          const wrapped = new Error(err?.message || 'LLM request failed');
          wrapped.code = err?.cause?.code || 'ECONNRESET';
          throw wrapped;
        }
      };

      let res = await post(headers);
      if (res.status === 401 && grok && typeof cfg.onUnauthorized === 'function') {
        try { await res.text(); } catch { /* drain */ }
        const refreshed = await cfg.onUnauthorized();
        if (refreshed?.apiKey) {
          const nextHeaders = {
            ...headers,
            ...(refreshed.headers || {}),
            authorization: `Bearer ${refreshed.apiKey}`,
          };
          res = await post(nextHeaders);
        }
      }

      if (!res.ok) {
        let errBody = '';
        try { errBody = await res.text(); } catch { /* ignore */ }
        throw httpError(res.status, errBody);
      }

      const json = await res.json();
      if (grok) return actionFromGrokResponses(json);
      const msg = json?.choices?.[0]?.message;
      const toolCalls = msg?.tool_calls;
      if (toolCalls?.length) {
        const tc = toolCalls[0];
        const name = tc.function?.name || tc.name;
        const args = parseArgs(tc.function?.arguments ?? tc.arguments);
        return { type: 'tool', name, args };
      }
      const text = msg?.content;
      if (text == null || String(text).trim() === '') throw emptyOutput();
      return { type: 'text', text: String(text) };
    },
  };
}
