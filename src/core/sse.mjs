export function formatSSE({ id, event, data } = {}) {
  const lines = [];
  if (id !== undefined && id !== null && id !== '') lines.push(`id: ${id}`);
  if (event !== undefined && event !== null) lines.push(`event: ${event}`);
  if (data !== undefined && typeof data === 'object' && data !== null) {
    lines.push(`data: ${JSON.stringify(data)}`);
  } else if (typeof data === 'string') {
    const parts = data.split('\n');
    for (const part of parts) lines.push(`data: ${part}`);
  } else if (data !== undefined) {
    lines.push(`data: ${String(data)}`);
  }
  return `${lines.join('\n')}\n\n`;
}

function parseData(raw) {
  if (raw === '') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function parseSSE(text) {
  const src = String(text ?? '').replace(/\r\n/g, '\n');
  const chunks = src.split('\n\n');
  const events = [];
  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    let id;
    let event;
    const dataLines = [];
    for (const line of chunk.split('\n')) {
      if (line.startsWith('id:')) {
        const v = line.slice(3).trimStart();
        id = /^\d+$/.test(v) ? Number(v) : v;
      } else if (line.startsWith('event:')) {
        event = line.slice(6).trimStart();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).startsWith(' ') ? line.slice(6) : line.slice(5));
      }
    }
    const raw = dataLines.join('\n');
    const ev = { event, data: parseData(raw) };
    if (id !== undefined) ev.id = id;
    events.push(ev);
  }
  return events;
}
