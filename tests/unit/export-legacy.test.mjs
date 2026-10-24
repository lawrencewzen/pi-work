import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import assert from 'node:assert/strict';
import { exportLegacyConversations } from '../../scripts/export-legacy-conversations.mjs';

test('export writes markdown for conversations that have no harness id', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-legacy-'));
  const outDir = path.join(dataDir, 'out');
  const db = new DatabaseSync(path.join(dataDir, 'weft.sqlite'));
  db.exec(`
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      title TEXT,
      created_at INTEGER,
      updated_at INTEGER,
      harness_id INTEGER
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT,
      role TEXT,
      text TEXT,
      seq INTEGER
    );
  `);
  db.prepare('INSERT INTO conversations (id, title, created_at, updated_at, harness_id) VALUES (?,?,?,?,?)')
    .run('old-1', '旧对话', 1_700_000_000_000, 1_700_000_100_000, null);
  db.prepare('INSERT INTO conversations (id, title, created_at, updated_at, harness_id) VALUES (?,?,?,?,?)')
    .run('new-1', '新对话', 1_700_000_000_000, 1_700_000_100_000, 4);
  const ins = db.prepare('INSERT INTO messages (id, conversation_id, role, text, seq) VALUES (?,?,?,?,?)');
  ins.run('m1', 'old-1', 'user', '请保留这句话', 1);
  ins.run('m2', 'old-1', 'assistant', '好的。', 2);
  ins.run('m3', 'old-1', 'tool', 'hidden', 3);
  ins.run('m4', 'new-1', 'user', '不要导出', 1);
  db.close();

  const written = exportLegacyConversations(dataDir, outDir);
  assert.equal(written.length, 1);
  const text = await readFile(written[0], 'utf8');
  assert.match(text, /^# 旧对话/);
  assert.match(text, /时间：/);
  assert.match(text, /## 用户\n\n请保留这句话/);
  assert.match(text, /## 助手\n\n好的。/);
  assert.equal(text.includes('不要导出'), false);
  assert.equal(text.includes('hidden'), false);

  const again = new DatabaseSync(path.join(dataDir, 'weft.sqlite'), { readOnly: true });
  const count = again.prepare('SELECT COUNT(*) AS n FROM messages').get();
  again.close();
  assert.equal(count.n, 4);
  await rm(dataDir, { recursive: true, force: true });
});
