import { readFileSync } from 'node:fs';

function abortError() {
  const err = new Error('aborted');
  err.code = 'E_ABORTED';
  err.name = 'AbortError';
  return err;
}

function streamCut() {
  const err = new Error('stream cut');
  err.code = 'E_STREAM_CUT';
  return err;
}

async function abortableDelay(ms, signal, onProgress) {
  if (ms <= 0) return;
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (signal?.aborted) throw abortError();
    onProgress?.();
    const remain = ms - (Date.now() - start);
    const slice = Math.min(50, Math.max(0, remain));
    await new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(abortError());
      const t = setTimeout(resolve, slice);
      const onAbort = () => {
        clearTimeout(t);
        reject(abortError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}

export function createFauxLLM(script = { turns: [] }) {
  const turns = Array.isArray(script.turns) ? script.turns : [];
  const perConversation = !!script.perConversation;
  const cutsThrown = new Set();
  const cursors = new Map();
  let globalCursor = 0;

  function cutKey(conversationId, index) {
    return perConversation ? `${conversationId}:${index}` : String(index);
  }

  function readCursor(conversationId, step) {
    if (step != null) return step;
    if (perConversation) return cursors.get(conversationId) || 0;
    return globalCursor;
  }

  function writeCursor(conversationId, index) {
    if (perConversation) cursors.set(conversationId, index);
    else globalCursor = index;
  }

  return {
    async next({ conversationId, step, signal, onProgress } = {}) {
      let i = readCursor(conversationId, step);
      if (i >= turns.length) return { type: 'end' };
      const turn = turns[i];

      if (turn.delayMs != null) {
        await abortableDelay(Number(turn.delayMs) || 0, signal, onProgress);
        writeCursor(conversationId, i + 1);
        return { type: 'delay', ms: turn.delayMs };
      }

      if (turn.cut) {
        const key = cutKey(conversationId, i);
        if (!cutsThrown.has(key)) {
          cutsThrown.add(key);
          throw streamCut();
        }
        writeCursor(conversationId, i + 1);
        return { type: 'skip' };
      }

      writeCursor(conversationId, i + 1);
      if (turn.end) return { type: 'end', consumed: true };
      if (turn.tool) return { type: 'tool', name: turn.tool, args: turn.args || {} };
      if (turn.text != null) return { type: 'text', text: String(turn.text) };
      return { type: 'end' };
    },
  };
}

export function loadFauxLLM(scriptPath = process.env.PI_WORK_FAUX_SCRIPT) {
  if (!scriptPath) throw new Error('PI_WORK_FAUX_SCRIPT is not set');
  const script = JSON.parse(readFileSync(scriptPath, 'utf8'));
  return createFauxLLM(script);
}
