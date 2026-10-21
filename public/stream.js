// Pure chat-stream merge. The browser and the unit tests share this so a
// replay of SSE events cannot leave a second assistant bubble behind.

function carriedText(data) {
  return data?.text != null && data.text !== '';
}

function copyMeta(target, data) {
  if (!data) return;
  if (data.agentId) target.agentId = data.agentId;
  if (data.roleId) target.roleId = data.roleId;
  if (data.kind) target.kind = data.kind;
  if (data.fromAgent) target.fromAgent = data.fromAgent;
  if (data.toAgent) target.toAgent = data.toAgent;
  if (typeof data.model === 'string' && data.model) target.model = data.model;
}

/** Drop assistant rows that are still marked streaming. At most the row `keepId` stays. */
export function dropStreamingResidues(msgs, keepId) {
  if (!Array.isArray(msgs)) return msgs;
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const msg = msgs[i];
    if (!msg?.streaming) continue;
    if (msg.role === 'user' || msg.role === 'tool') continue;
    if (keepId != null && msg.id === keepId) continue;
    msgs.splice(i, 1);
  }
  return msgs;
}

/**
 * Apply one `message.delta`.
 * `text` is an incremental fragment and is appended as-is.
 * `replace: true` means `text` is the full partial so far and replaces the bubble.
 */
export function applyStreamDelta(msgs, data) {
  if (!Array.isArray(msgs) || data?.messageId == null || data.messageId === '') return null;
  const incoming = data.text == null ? '' : String(data.text);
  const messageId = String(data.messageId);
  let m = msgs.find((msg) => msg && msg.id === messageId);
  if (!m) {
    dropStreamingResidues(msgs);
    m = {
      id: messageId,
      role: data.role || 'assistant',
      text: incoming,
      streaming: true,
    };
    copyMeta(m, data);
    msgs.push(m);
    return m;
  }
  copyMeta(m, data);
  if (m.streaming !== true) return m;
  if (data.replace) m.text = incoming;
  else if (incoming) m.text = `${m.text || ''}${incoming}`;
  m.streaming = true;
  return m;
}

/** Finish the open stream when its assistant `message.done` arrives. */
export function applyMessageDone(msgs, data) {
  if (!Array.isArray(msgs) || !data) return msgs;
  if (data.role === 'user') {
    const id = data.messageId != null ? String(data.messageId) : '';
    const user = id ? msgs.find((msg) => msg && msg.id === id) : null;
    if (user) {
      if (carriedText(data)) user.text = data.text;
      user.streaming = false;
      user.done = true;
    }
    return msgs;
  }
  const officialId = data.messageId != null && data.messageId !== '' ? String(data.messageId) : null;
  const liveId = data.liveId != null && data.liveId !== '' ? String(data.liveId) : null;
  let m = liveId ? msgs.find((msg) => msg && msg.id === liveId) : null;
  if (!m && officialId) m = msgs.find((msg) => msg && msg.id === officialId);
  if (!m && carriedText(data)) {
    for (let i = msgs.length - 1; i >= 0; i -= 1) {
      const msg = msgs[i];
      if (msg?.streaming && msg.role !== 'user' && msg.role !== 'tool') {
        m = msg;
        break;
      }
    }
  }
  if (m) {
    const existing = officialId && m.id !== officialId
      ? msgs.find((msg) => msg && msg !== m && msg.id === officialId)
      : null;
    if (existing) {
      if (carriedText(data)) existing.text = data.text;
      else if (m.text && !existing.text) existing.text = m.text;
      copyMeta(existing, data);
      existing.streaming = false;
      existing.done = true;
      const idx = msgs.indexOf(m);
      if (idx >= 0) msgs.splice(idx, 1);
      m = existing;
    } else {
      if (officialId) m.id = officialId;
      if (carriedText(data)) m.text = data.text;
      copyMeta(m, data);
      m.streaming = false;
      m.done = true;
    }
  } else if (officialId && carriedText(data)) {
    const created = {
      id: officialId,
      role: 'assistant',
      text: data.text,
      streaming: false,
      done: true,
    };
    copyMeta(created, data);
    msgs.push(created);
  }
  if (m || carriedText(data) || liveId) dropStreamingResidues(msgs);
  return msgs;
}

function dedupeById(messages) {
  const seen = new Set();
  const out = [];
  for (const m of messages) {
    if (!m) continue;
    const id = m.id || `${m.role}:${m.text || ''}:${m.tool?.id || ''}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(m);
  }
  return out;
}

/**
 * Merge a GET message list over the local thread.
 * A streaming row the server does not have is kept only while the turn is
 * still open (`keepStreaming`), and only the latest one.
 */
export function mergeRefreshedMessages(local, serverMessages, { keepStreaming = false } = {}) {
  const list = Array.isArray(local) ? local : [];
  const server = Array.isArray(serverMessages) ? serverMessages : [];
  const merged = [];
  const seen = new Set();
  for (const m of server) {
    if (!m) continue;
    seen.add(m.id);
    merged.push(m);
  }
  const pending = [];
  for (const m of list) {
    if (!m || seen.has(m.id)) continue;
    if (m.role === 'tool' && m.tool?.id) {
      const have = merged.some((row) => row?.role === 'tool' && row.tool?.id === m.tool.id);
      if (!have && keepStreaming) merged.push(m);
      continue;
    }
    if (m.streaming && m.role !== 'user' && m.role !== 'tool') {
      pending.push(m);
      continue;
    }
    if (String(m.id).startsWith('usr-')) {
      const dup = merged.some((x) => x.role === m.role && x.text === m.text);
      if (!dup) merged.push(m);
    }
  }
  if (keepStreaming && pending.length) {
    const last = pending[pending.length - 1];
    const dup = merged.some((x) => x.role === last.role && x.text && x.text === last.text);
    if (!dup) merged.push(last);
  }
  return dedupeById(merged);
}

export function statusKeepsStreaming(status) {
  return status === 'running';
}
