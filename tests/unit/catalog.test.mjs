import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { load } from './_root.mjs';

const { createSqliteStore } = await load('src/store/sqlite.mjs');

async function openStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'piw-cat-'));
  const store = createSqliteStore(dir);
  const orig = store.close.bind(store);
  store.close = () => {
    orig();
    return fs.rm(dir, { recursive: true, force: true });
  };
  store.dir = dir;
  return store;
}

test('sqlite catalog tombstones still round-trip', async () => {
  const store = await openStore();
  try {
    await store.tombstoneCatalog('plugin', 'gone');
    assert.equal(await store.hasCatalogTombstone('plugin', 'gone'), true);
    await store.clearCatalogTombstone('plugin', 'gone');
    assert.equal(await store.hasCatalogTombstone('plugin', 'gone'), false);
  } finally {
    await store.close();
  }
});

test('startup drops pipelines and roles; leftover role_id is not read', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'piw-drop-roles-'));
  const dbPath = path.join(dir, 'weft.sqlite');
  const raw = new DatabaseSync(dbPath);
  raw.exec(`
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      workspace_id TEXT,
      title TEXT,
      status TEXT,
      auto_continues INTEGER DEFAULT 0,
      retries INTEGER DEFAULT 0,
      last_checkpoint_at INTEGER,
      current_step INTEGER DEFAULT 0,
      pipeline_step INTEGER DEFAULT 0,
      updated_at INTEGER,
      created_at INTEGER,
      role_id TEXT,
      pipeline_id TEXT,
      workspace_path TEXT,
      last_progress_at INTEGER,
      original_text TEXT,
      harness_id INTEGER
    );
    CREATE TABLE pipelines (id TEXT PRIMARY KEY, name TEXT, steps_json TEXT);
    CREATE TABLE roles (
      id TEXT PRIMARY KEY,
      name TEXT,
      system_prompt TEXT,
      tools_json TEXT
    );
    INSERT INTO pipelines (id, name, steps_json) VALUES ('legacy', 'Legacy', '[]');
    INSERT INTO roles (id, name, system_prompt, tools_json) VALUES ('coder', 'Coder', 'old prompt', '[]');
    INSERT INTO conversations (
      id, workspace_id, title, pipeline_step, pipeline_id, role_id, updated_at, created_at
    ) VALUES ('c1', 'w1', 'old', 2, 'legacy', 'coder', 1, 1);
  `);
  raw.close();
  const store = createSqliteStore(dir);
  try {
    const check = new DatabaseSync(dbPath, { readOnly: true });
    try {
      assert.equal(
        check.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='pipelines'").get(),
        undefined,
      );
      assert.equal(
        check.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='roles'").get(),
        undefined,
      );
    } finally {
      check.close();
    }
    const conv = await store.getConversation('c1');
    assert.equal(conv?.id, 'c1');
    assert.equal(Object.hasOwn(conv, 'roleId'), false);
    assert.equal('pipelineId' in conv, false);
    assert.equal('pipelineStep' in conv, false);
  } finally {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
