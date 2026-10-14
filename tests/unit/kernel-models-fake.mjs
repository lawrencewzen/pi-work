import http from 'node:http';

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function chatCompletionSse(text) {
  const chunk = (delta, finish) => JSON.stringify({
    id: 'chatcmpl-kernel',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  return [
    `data: ${chunk({ role: 'assistant', content: text }, null)}`,
    '',
    `data: ${chunk({}, 'stop')}`,
    '',
    'data: [DONE]',
    '',
    '',
  ].join('\n');
}

function responsesSse(text) {
  const events = [
    ['response.output_item.added', {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'message', id: 'msg_kernel', role: 'assistant', status: 'in_progress', content: [] },
    }],
    ['response.output_text.delta', {
      type: 'response.output_text.delta',
      output_index: 0,
      delta: text,
    }],
    ['response.output_item.done', {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'message',
        id: 'msg_kernel',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text }],
      },
    }],
    ['response.completed', {
      type: 'response.completed',
      response: {
        id: 'resp_kernel',
        status: 'completed',
        output: [{
          type: 'message',
          id: 'msg_kernel',
          role: 'assistant',
          content: [{ type: 'output_text', text }],
        }],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    }],
  ];
  return `${events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n`).join('\n')}\n`;
}

function tokenGen(authorization, access1, access2) {
  if (authorization === `Bearer ${access1}`) return 'access-1';
  if (access2 && authorization === `Bearer ${access2}`) return 'access-2';
  if (authorization.toLowerCase().startsWith('bearer ')) return 'bearer-other';
  return 'none';
}

/**
 * Local stand-in for one model endpoint.
 * Records the key's last 4 characters and Grok header values, never the secret.
 */
export function startFakeModel({ mode, text, access1 = 'access-1', access2 = 'access-2' }) {
  const seen = [];
  let refreshed = 0;
  let currentAccess = access1;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const authorization = String(req.headers.authorization || '');
    const record = {
      method: req.method,
      path: url.pathname,
      keyTail: authorization.toLowerCase().startsWith('bearer ') ? authorization.slice(-4) : '',
      tokenGen: tokenGen(authorization, access1, access2),
      grokIdentifier: req.headers['x-grok-client-identifier'] || '',
      grokVersion: req.headers['x-grok-client-version'] || '',
      grokModel: req.headers['x-grok-model-override'] || '',
      tokenAuth: req.headers['x-xai-token-auth'] || '',
    };
    let raw = '';
    try {
      raw = await readBody(req);
    } catch {
      seen.push(record);
      res.writeHead(400);
      res.end('bad body');
      return;
    }
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed?.model === 'string') record.model = parsed.model;
    } catch { /* a token request is form-encoded */ }
    seen.push(record);

    if (mode === 'grok' && url.pathname.endsWith('/oauth2/token')) {
      refreshed += 1;
      currentAccess = access2;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        access_token: access2,
        refresh_token: 'refresh-2',
        expires_in: 3600,
        token_type: 'Bearer',
      }));
      return;
    }

    if (mode === 'grok' && url.pathname.endsWith('/responses')) {
      if (authorization !== `Bearer ${currentAccess}` || currentAccess === access1) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'unauthorized' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.end(responsesSse(text));
      return;
    }

    if (mode === 'openai' && url.pathname.endsWith('/chat/completions')) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.end(chatCompletionSse(text));
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found', path: url.pathname }));
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        port,
        baseUrl: `http://127.0.0.1:${port}/v1`,
        tokenUrl: `http://127.0.0.1:${port}/oauth2/token`,
        seen,
        refreshCount: () => refreshed,
        close: () => new Promise((done, fail) => server.close((err) => (err ? fail(err) : done()))),
      });
    });
  });
}
