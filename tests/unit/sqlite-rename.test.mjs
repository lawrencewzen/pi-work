import { existsSync, renameSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  APP_DB_FILE,
  LEGACY_APP_DB_FILE,
  createSqliteStore,
  resolveAppDatabasePath,
} from '../../src/store/sqlite.mjs';
import { request, startServer, stopServer } from './_server.mjs';

const TOKEN = 'unit-sqlite-rename-token';
const SIDECARS = ['', '-wal', '-shm'];

function captureLog() {
  const lines = [];
  return {
    lines,
    log: {
      log: (message) => lines.push(String(message)),
      error: (message) => lines.push(String(message)),
    },
  };
}

function moveAppDb(dir, fromName, toName) {
  for (const suffix of SIDECARS) {
    const from = path.join(dir, `${fromName}${suffix}`);
    const to = path.join(dir, `${toName}${suffix}`);
    if (existsSync(from)) renameSync(from, to);
  }
}

test('resolveAppDatabasePath renames the legacy file and its WAL sidecars', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'weft-db-rename-'));
  try {
    const first = createSqliteStore(dir);
    await first.createWorkspace({ name: 'keep-me', path: dir });
    first.close();
    assert.equal(existsSync(path.join(dir, APP_DB_FILE)), true);
    moveAppDb(dir, APP_DB_FILE, LEGACY_APP_DB_FILE);
    assert.equal(existsSync(path.join(dir, LEGACY_APP_DB_FILE)), true);
    assert.equal(existsSync(path.join(dir, APP_DB_FILE)), false);

    const { lines, log } = captureLog();
    const dbPath = resolveAppDatabasePath(dir, { log });
    assert.equal(dbPath, path.join(dir, APP_DB_FILE));
    assert.equal(existsSync(path.join(dir, APP_DB_FILE)), true);
    assert.equal(existsSync(path.join(dir, LEGACY_APP_DB_FILE)), false);
    assert.ok(lines.some((line) => line.includes(`WEFT_DB renamed ${LEGACY_APP_DB_FILE}`)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolveAppDatabasePath keeps the new file when both names exist', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'weft-db-both-'));
  try {
    const store = createSqliteStore(dir);
    await store.createWorkspace({ name: 'from-new', path: dir });
    store.close();
    writeFileSync(path.join(dir, LEGACY_APP_DB_FILE), 'leftover-old-db');

    const { lines, log } = captureLog();
    const dbPath = resolveAppDatabasePath(dir, { log });
    assert.equal(dbPath, path.join(dir, APP_DB_FILE));
    assert.equal(existsSync(path.join(dir, LEGACY_APP_DB_FILE)), true);
    const again = createSqliteStore(dir, { log });
    try {
      const list = await again.listWorkspaces();
      assert.equal(list.some((ws) => ws.name === 'from-new'), true);
    } finally {
      again.close();
    }
    assert.ok(lines.some((line) => line.includes(`leftover ${LEGACY_APP_DB_FILE}`)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('opening the store after a rename keeps workspaces from the old file', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'weft-db-ws-'));
  try {
    const first = createSqliteStore(dir);
    const created = await first.createWorkspace({ name: 'kept-workspace', path: dir });
    first.close();
    moveAppDb(dir, APP_DB_FILE, LEGACY_APP_DB_FILE);

    const second = createSqliteStore(dir);
    try {
      const list = await second.listWorkspaces();
      assert.equal(list.length, 1);
      assert.equal(list[0].id, created.id);
      assert.equal(list[0].name, 'kept-workspace');
      assert.equal(existsSync(path.join(dir, APP_DB_FILE)), true);
      assert.equal(existsSync(path.join(dir, LEGACY_APP_DB_FILE)), false);
    } finally {
      second.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('server startup renames pi-work.sqlite and keeps conversations', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'weft-db-http-'));
  let wid;
  let cid;
  const first = await startServer({
    token: TOKEN,
    dataDir,
    env: { WEFT_LLM: 'faux', WEFT_FAUX_TEXT: 'ok' },
  });
  try {
    const ws = await request(first.base, 'POST', '/api/workspaces', { name: 'kept' }, TOKEN);
    assert.equal(ws.status, 201, ws.text);
    wid = ws.body.id;
    const conv = await request(first.base, 'POST', `/api/workspaces/${wid}/conversations`, { title: 'old-chat' }, TOKEN);
    assert.equal(conv.status, 201, conv.text);
    cid = conv.body.id;
  } finally {
    await stopServer(first);
  }

  moveAppDb(dataDir, APP_DB_FILE, LEGACY_APP_DB_FILE);
  assert.equal(existsSync(path.join(dataDir, LEGACY_APP_DB_FILE)), true);
  assert.equal(existsSync(path.join(dataDir, APP_DB_FILE)), false);

  const second = await startServer({
    token: TOKEN,
    dataDir,
    env: { WEFT_LLM: 'faux', WEFT_FAUX_TEXT: 'ok' },
  });
  try {
    assert.equal(existsSync(path.join(dataDir, APP_DB_FILE)), true);
    assert.equal(existsSync(path.join(dataDir, LEGACY_APP_DB_FILE)), false);
    assert.match(second.logs(), new RegExp(`WEFT_DB renamed ${LEGACY_APP_DB_FILE}`));
    const listed = await request(second.base, 'GET', `/api/workspaces/${wid}/conversations`, undefined, TOKEN);
    assert.equal(listed.status, 200, listed.text);
    assert.equal(listed.body.some((item) => item.id === cid), true);
    const one = await request(second.base, 'GET', `/api/conversations/${cid}`, undefined, TOKEN);
    assert.equal(one.status, 200, one.text);
    assert.equal(one.body.title, 'old-chat');
  } finally {
    await stopServer(second);
    await rm(dataDir, { recursive: true, force: true });
  }
});
