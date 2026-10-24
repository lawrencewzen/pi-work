// Read-only export of pre-kernel conversations (no harness id) to Markdown.
// Run this on the data directory before starting a build that drops messages.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

function stamp(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '';
  return new Date(n).toISOString();
}

function fileName(row) {
  const base = String(row.title || 'conversation')
    .replace(/[^\w\u4e00-\u9fff.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'conversation';
  return `${base}-${String(row.id).slice(0, 8)}.md`;
}

function markdown(row, messages) {
  const lines = [
    `# ${row.title || 'Untitled'}`,
    '',
    `时间：${stamp(row.updated_at || row.created_at)}`,
    '',
  ];
  for (const message of messages) {
    const text = String(message.text || '').trim();
    if (!text) continue;
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    lines.push(message.role === 'user' ? '## 用户' : '## 助手', '', text, '');
  }
  return `${lines.join('\n').trim()}\n`;
}

/**
 * Write one Markdown file per conversation that has no harness id.
 * Does not modify the database.
 */
export function exportLegacyConversations(dataDir, outDir) {
  const db = new DatabaseSync(path.join(dataDir, 'weft.sqlite'), { readOnly: true });
  try {
    const rows = db.prepare(`
      SELECT id, title, created_at, updated_at
      FROM conversations
      WHERE harness_id IS NULL
      ORDER BY created_at, id
    `).all();
    const hasMessages = Boolean(db.prepare(
      "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'messages'",
    ).get());
    const listMessages = hasMessages
      ? db.prepare('SELECT role, text FROM messages WHERE conversation_id = ? ORDER BY seq, rowid')
      : null;
    mkdirSync(outDir, { recursive: true });
    const written = [];
    for (const row of rows) {
      const messages = listMessages ? listMessages.all(row.id) : [];
      const file = path.join(outDir, fileName(row));
      writeFileSync(file, markdown(row, messages));
      written.push(file);
    }
    return written;
  } finally {
    db.close();
  }
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  const [dataDir, outDir] = process.argv.slice(2);
  if (!dataDir || !outDir) {
    console.error('usage: node scripts/export-legacy-conversations.mjs <dataDir> <outDir>');
    process.exit(2);
  }
  const written = exportLegacyConversations(dataDir, outDir);
  console.log(`exported ${written.length}`);
  for (const file of written) console.log(file);
}
