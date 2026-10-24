import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import {
  EXT_SUBAGENTS,
  EXT_WORKSPACE,
  KIND_PREFIX,
  SUBAGENT_ANCHOR_KIND,
  SUBAGENT_REPORTER_KIND,
  SUBAGENTS_DOC_KIND,
  USER_TO_SUBAGENT_KIND,
} from '../../src/kernel/ids.mjs';
import {
  extensionRenameMap,
  harnessSqlitePath,
  kindRenameMap,
  listWeftBackupDirs,
  migrateWeftIds,
  rewriteStoredIds,
} from '../../src/kernel/migrate-weft-ids.mjs';
import { parentNoteText } from '../../src/kernel/subagent-control.mjs';
import { ROOT } from './_root.mjs';
import { killChild, request as serverRequest, startServer, stopServer } from './_server.mjs';

const TOKEN = 'unit-kernel-weft-ids-token';
const request = (base, method, apiPath, body) => serverRequest(base, method, apiPath, body, TOKEN);

const OLD_SUBAGENTS = 'app.pi-work.subagents';
const OLD_ANCHOR = 'app.pi-work.subagent-anchor';
const OLD_REPORTER = 'app.pi-work.subagent-reporter';
const OLD_NOTE = 'app.pi-work.user-to-subagent';
const OLD_EXT_SUBAGENTS = 'pi-work-subagents';
const OLD_EXT_WORKSPACE = 'pi-work-workspace';
const BODY_MARKERS = 'keep pi-work-subagents and app.pi-work.x unchanged';

function invert(map) {
  return Object.fromEntries(Object.entries(map).map(([from, to]) => [to, from]));
}

function openHarnessDb(storagePath, readOnly = false) {
  return new DatabaseSync(storagePath, { readOnly, timeout: 5000 });
}

function indexed(value) {
  return JSON.stringify(value);
}

function decodeIndexed(value) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function jsonExtractKinds(db, sql) {
  return db.prepare(sql).all().map((row) => row.kind);
}

function taskKindColumns(db) {
  return db.prepare('SELECT kind FROM tasks').all().map((row) => decodeIndexed(row.kind));
}

function documentKindColumns(db) {
  return db.prepare('SELECT kind FROM documents').all().map((row) => decodeIndexed(row.kind));
}

async function initHarnessDb(dataDir) {
  await mkdir(path.join(dataDir, 'harness'), { recursive: true });
  const storagePath = harnessSqlitePath(dataDir);
  const storage = await openNodeSqliteStorage(storagePath);
  await storage.close(BACKGROUND_CONTEXT);
  return storagePath;
}

function seedLegacyRows(db) {
  db.prepare('INSERT INTO record_ids (id, record_type) VALUES (?, ?)').run(2, 'conversation');
  db.prepare('INSERT INTO conversations (id, record) VALUES (?, ?)').run(2, JSON.stringify({ id: 2 }));

  db.prepare('INSERT INTO record_ids (id, record_type) VALUES (?, ?)').run(3, 'entry');
  db.prepare(`
    INSERT INTO entries (id, conversation_id, head, commit_seq, record) VALUES (?, ?, NULL, 1, ?)
  `).run(3, 2, JSON.stringify({
    id: 3,
    conversationId: 2,
    kind: 'pi.user',
    model: [{ role: 'user', content: [{ type: 'text', text: BODY_MARKERS }] }],
  }));

  db.prepare('INSERT INTO record_ids (id, record_type) VALUES (?, ?)').run(4, 'entry');
  db.prepare(`
    INSERT INTO entries (id, conversation_id, head, commit_seq, record) VALUES (?, ?, NULL, 2, ?)
  `).run(4, 2, JSON.stringify({
    id: 4,
    conversationId: 2,
    kind: OLD_NOTE,
    data: { agentId: 'c:sub:8', name: 'scout', text: 'keep going' },
    model: [{ role: 'user', content: 'note-model' }],
  }));

  db.prepare('INSERT INTO record_ids (id, record_type) VALUES (?, ?)').run(5, 'task');
  db.prepare(`
    INSERT INTO tasks (id, conversation_id, kind, status, abort_requested, background, record)
    VALUES (?, ?, ?, ?, 0, 1, ?)
  `).run(5, 2, indexed(OLD_REPORTER), 'waiting', JSON.stringify({
    id: 5,
    conversationId: 2,
    kind: OLD_REPORTER,
    version: 1,
    input: { name: 'scout', conversationId: 8, message: 'hold-bg', followUp: false },
    background: true,
    abortRequested: false,
    state: { status: 'waiting', checkpoint: { phase: 'deliver' }, on: [9], policy: 'all' },
  }));

  db.prepare('INSERT INTO record_ids (id, record_type) VALUES (?, ?)').run(6, 'task');
  db.prepare(`
    INSERT INTO tasks (id, conversation_id, kind, status, abort_requested, background, record)
    VALUES (?, ?, ?, ?, 0, 1, ?)
  `).run(6, 2, indexed(OLD_ANCHOR), 'terminal', JSON.stringify({
    id: 6,
    conversationId: 2,
    kind: OLD_ANCHOR,
    version: 1,
    input: null,
    background: true,
    abortRequested: false,
    state: { status: 'terminal', outcome: { status: 'completed', result: null } },
  }));

  db.prepare('INSERT INTO record_ids (id, record_type) VALUES (?, ?)').run(20, 'document');
  db.prepare(`
    INSERT INTO documents (id, kind, family, key_value, scope_kind, owner_id, created_at, retired_at, record)
    VALUES (?, ?, 0, ?, 'conversation', 2, 1, NULL, ?)
  `).run(20, indexed('pi.agent'), indexed(''), JSON.stringify({
    id: 20,
    kind: 'pi.agent',
    scope: { kind: 'conversation', conversationId: 2 },
    history: 'rewindable',
    fork: 'asOf',
    createdAt: 1,
  }));
  db.prepare(`
    INSERT INTO document_revisions (document_id, seq, kind, version, content) VALUES (?, ?, ?, 1, ?)
  `).run(20, 1, 'base', JSON.stringify({
    extensions: { remove: [OLD_EXT_WORKSPACE] },
  }));
  db.prepare(`
    INSERT INTO document_revisions (document_id, seq, kind, version, content) VALUES (?, ?, ?, 1, ?)
  `).run(20, 2, 'delta', JSON.stringify([
    ['s', ['extensions', 'remove', 0], OLD_EXT_SUBAGENTS],
  ]));

  db.prepare('INSERT INTO record_ids (id, record_type) VALUES (?, ?)').run(21, 'document');
  db.prepare(`
    INSERT INTO documents (id, kind, family, key_value, scope_kind, owner_id, created_at, retired_at, record)
    VALUES (?, ?, 0, ?, 'conversation', 2, 1, NULL, ?)
  `).run(21, indexed(OLD_SUBAGENTS), indexed(''), JSON.stringify({
    id: 21,
    kind: OLD_SUBAGENTS,
    scope: { kind: 'conversation', conversationId: 2 },
    history: 'latest',
    fork: 'initial',
    createdAt: 1,
  }));
  db.prepare(`
    INSERT INTO document_revisions (document_id, seq, kind, version, content) VALUES (?, ?, ?, 1, ?)
  `).run(21, 1, 'base', JSON.stringify({
    agents: { scout: { conversationId: 8, reported: [] } },
    reporters: { 5: 5 },
  }));
}

function userEntryText(db) {
  const row = db.prepare(`
    SELECT record FROM entries WHERE json_extract(record, '$.kind') = 'pi.user' LIMIT 1
  `).get();
  const record = JSON.parse(row.record);
  const content = record.model?.[0]?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('');
}

function agentRevision(db, seq) {
  const row = db.prepare(`
    SELECT content FROM document_revisions WHERE document_id = 20 AND seq = ?
  `).get(seq);
  return JSON.parse(row.content);
}

function reverseToLegacy(storagePath) {
  const db = openHarnessDb(storagePath);
  try {
    db.exec('BEGIN IMMEDIATE');
    rewriteStoredIds(db, {
      kinds: invert(kindRenameMap()),
      extensions: invert(extensionRenameMap()),
      kindFrom: KIND_PREFIX,
      kindTo: 'app.pi-work.',
      extFrom: 'weft-',
      extTo: 'pi-work-',
    });
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* keep err */ }
    throw err;
  } finally {
    db.close();
  }
}

async function walkFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walkFiles(full));
    else out.push(full);
  }
  return out;
}

function killed(proc) {
  return new Promise((resolve) => {
    if (proc.exitCode != null || proc.signalCode != null) {
      resolve({ code: proc.exitCode, signal: proc.signalCode });
      return;
    }
    proc.once('exit', (code, signal) => resolve({ code, signal }));
    killChild(proc);
  });
}

async function waitFor(base, cid, ready, attempts = 80) {
  let body = null;
  for (let i = 0; i < attempts; i += 1) {
    const got = await request(base, 'GET', `/api/conversations/${cid}`);
    body = got.body;
    if (ready(body)) return body;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return body;
}

async function waitForFile(file, timeout = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (existsSync(file)) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`timed out waiting for ${file}`);
}

function assistantTexts(body) {
  return (body?.messages || []).filter((message) => message.role === 'assistant').map((message) => message.text || '');
}

function subagentsOf(body) {
  return (body?.agents || []).filter((agent) => String(agent.id || '').includes(':sub:'));
}

function agentUrl(cid, aid, suffix) {
  return `/api/conversations/${cid}/agents/${encodeURIComponent(aid)}${suffix}`;
}

async function writeScript(dataDir, name, turns) {
  const file = path.join(dataDir, name);
  await writeFile(file, JSON.stringify({ turns }));
  return file;
}

test('src has no legacy stored identifier literals', async () => {
  const src = path.join(ROOT, 'src');
  const hits = [];
  for (const file of await walkFiles(src)) {
    const text = await readFile(file, 'utf8');
    if (text.includes('app.pi-work.') || text.includes('pi-work-')) hits.push(path.relative(ROOT, file));
  }
  assert.deepEqual(hits, []);
});

test('migrateWeftIds rewrites identifier fields and leaves message bodies alone', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-weft-ids-'));
  try {
    const storagePath = await initHarnessDb(dataDir);
    const seed = openHarnessDb(storagePath);
    try {
      seedLegacyRows(seed);
    } finally {
      seed.close();
    }

    const first = await migrateWeftIds(dataDir);
    assert.equal(first.status, 'migrated', JSON.stringify(first));
    assert.ok(first.backupDir);
    assert.equal(existsSync(path.join(first.backupDir, 'session.sqlite')), true);

    const db = openHarnessDb(storagePath, true);
    try {
      assert.equal(taskKindColumns(db).includes(OLD_REPORTER), false);
      assert.equal(taskKindColumns(db).includes(SUBAGENT_REPORTER_KIND), true);
      assert.equal(taskKindColumns(db).includes(SUBAGENT_ANCHOR_KIND), true);
      assert.equal(jsonExtractKinds(db, 'SELECT json_extract(record, \'$.kind\') AS kind FROM tasks').includes(OLD_REPORTER), false);
      assert.equal(documentKindColumns(db).includes(OLD_SUBAGENTS), false);
      assert.equal(documentKindColumns(db).includes(SUBAGENTS_DOC_KIND), true);
      const entryKinds = jsonExtractKinds(db, 'SELECT json_extract(record, \'$.kind\') AS kind FROM entries');
      assert.equal(entryKinds.includes(OLD_NOTE), false);
      assert.equal(entryKinds.includes(USER_TO_SUBAGENT_KIND), true);
      assert.equal(userEntryText(db), BODY_MARKERS);
      const roster = JSON.parse(db.prepare('SELECT content FROM document_revisions WHERE document_id = 21').get().content);
      assert.equal(roster.agents.scout.conversationId, 8);
      const waiting = db.prepare(`
        SELECT json_extract(record, '$.state.status') AS status
        FROM tasks WHERE json_extract(record, '$.kind') = ?
      `).get(SUBAGENT_REPORTER_KIND);
      assert.equal(waiting.status, 'waiting');
      assert.deepEqual(agentRevision(db, 1).extensions.remove, [EXT_WORKSPACE]);
      assert.equal(agentRevision(db, 2)[0][2], EXT_SUBAGENTS);
    } finally {
      db.close();
    }

    const second = await migrateWeftIds(dataDir);
    assert.equal(second.status, 'skipped');
    assert.equal((await listWeftBackupDirs(dataDir)).length, 1);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('migrateWeftIds rewrites bare pi-work. document kinds', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-weft-ids-bare-'));
  try {
    const storagePath = await initHarnessDb(dataDir);
    const seed = openHarnessDb(storagePath);
    try {
      seed.prepare('INSERT INTO record_ids (id, record_type) VALUES (?, ?)').run(2, 'conversation');
      seed.prepare('INSERT INTO conversations (id, record) VALUES (?, ?)').run(2, JSON.stringify({ id: 2 }));
      seed.prepare('INSERT INTO record_ids (id, record_type) VALUES (?, ?)').run(21, 'document');
      seed.prepare(`
        INSERT INTO documents (id, kind, family, key_value, scope_kind, owner_id, created_at, retired_at, record)
        VALUES (?, ?, 0, ?, 'conversation', 2, 1, NULL, ?)
      `).run(21, indexed('pi-work.control'), indexed(''), JSON.stringify({
        id: 21,
        kind: 'pi-work.control',
        scope: { kind: 'conversation', conversationId: 2 },
        history: 'latest',
        fork: 'initial',
        createdAt: 1,
      }));
    } finally {
      seed.close();
    }

    const first = await migrateWeftIds(dataDir);
    assert.equal(first.status, 'migrated', JSON.stringify(first));
    assert.ok(first.backupDir);
    assert.equal(existsSync(path.join(first.backupDir, 'session.sqlite')), true);

    const db = openHarnessDb(storagePath, true);
    try {
      assert.equal(documentKindColumns(db).includes('pi-work.control'), false);
      assert.equal(documentKindColumns(db).includes('weft.control'), true);
      const record = JSON.parse(db.prepare('SELECT record FROM documents WHERE id = 21').get().record);
      assert.equal(record.kind, 'weft.control');
    } finally {
      db.close();
    }

    const second = await migrateWeftIds(dataDir);
    assert.equal(second.status, 'skipped');
    assert.equal((await listWeftBackupDirs(dataDir)).length, 1);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('migrateWeftIds rolls back on failure and keeps the backup', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-weft-ids-fail-'));
  try {
    const storagePath = await initHarnessDb(dataDir);
    const seed = openHarnessDb(storagePath);
    try {
      seedLegacyRows(seed);
      seed.prepare('INSERT INTO record_ids (id, record_type) VALUES (?, ?)').run(30, 'task');
      seed.prepare(`
        INSERT INTO tasks (id, conversation_id, kind, status, abort_requested, background, record)
        VALUES (?, ?, ?, 'terminal', 0, 0, ?)
      `).run(30, 2, indexed('pi.generation'), JSON.stringify([]));
    } finally {
      seed.close();
    }

    const result = await migrateWeftIds(dataDir);
    assert.equal(result.status, 'failed');
    assert.ok(result.backupDir);
    assert.equal(existsSync(path.join(result.backupDir, 'session.sqlite')), true);

    const db = openHarnessDb(storagePath, true);
    try {
      assert.equal(taskKindColumns(db).includes(OLD_REPORTER), true);
      assert.equal(documentKindColumns(db).includes(OLD_SUBAGENTS), true);
      assert.equal(jsonExtractKinds(db, 'SELECT json_extract(record, \'$.kind\') AS kind FROM entries').includes(OLD_NOTE), true);
    } finally {
      db.close();
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('legacy harness ids migrate on startup: roster, notes, waiting reporter, body, backup', { timeout: 90_000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-weft-ids-boot-'));
  const ready = path.join(dataDir, 'ready');
  const script = await writeScript(dataDir, 'parent.json', [
    { tool: 'delegate', args: { task: 'fg-task' } },
    { tool: 'subagent', args: { action: 'spawn', name: 'scout', message: 'hold-bg' } },
    { text: 'parent-idle' },
    { when: 'fg-task', text: 'FG_DONE' },
    { when: 'hold-bg', delayMs: 8000, text: 'BG_ANSWER' },
  ]);
  const env = {
    WEFT_RETRY_MAX: '2',
    WEFT_LLM: 'faux',
    WEFT_FAUX_SCRIPT: script,
    WEFT_FAUX_HOLD_READY: ready,
  };
  let proc = null;
  try {
    const first = await startServer({ token: TOKEN, env, dataDir });
    proc = first.proc;
    const ws = await request(first.base, 'POST', '/api/workspaces', { name: 'weft-ids' });
    assert.equal(ws.status, 201, JSON.stringify(ws.body));
    const conv = await request(first.base, 'POST', `/api/workspaces/${ws.body.id}/conversations`, { title: 'weft-ids' });
    assert.equal(conv.status, 201);
    const cid = conv.body.id;
    assert.equal((await request(first.base, 'POST', `/api/conversations/${cid}/messages`, { text: BODY_MARKERS })).status, 202);
    await waitForFile(ready);
    const idle = await waitFor(first.base, cid, (body) => (
      body.status === 'done'
      && assistantTexts(body).includes('parent-idle')
      && subagentsOf(body).some((agent) => agent.name === 'scout' && agent.status === 'running')
      && subagentsOf(body).some((agent) => agent.mode === 'foreground' && String(agent.lastText || '').includes('FG_DONE'))
    ), 120);
    assert.equal(idle.status, 'done', first.logs());
    const scout = subagentsOf(idle).find((agent) => agent.name === 'scout');
    assert.ok(scout, JSON.stringify(idle.agents));
    const steered = await request(first.base, 'POST', agentUrl(cid, scout.id, '/messages'), { text: 'keep going' });
    assert.equal(steered.status, 200, JSON.stringify(steered.body));
    const noted = await waitFor(first.base, cid, (body) => (
      (body.messages || []).some((message) => message.role === 'note')
    ), 40);
    const note = (noted.messages || []).find((message) => message.role === 'note');
    assert.equal(note?.text, parentNoteText('scout', 'keep going'));

    await killed(proc);
    proc = null;
    await rm(ready, { force: true });

    reverseToLegacy(harnessSqlitePath(dataDir));
    const before = openHarnessDb(harnessSqlitePath(dataDir), true);
    try {
      assert.equal(taskKindColumns(before).includes(OLD_REPORTER), true);
      assert.equal(documentKindColumns(before).includes(OLD_SUBAGENTS), true);
      assert.equal(jsonExtractKinds(before, 'SELECT json_extract(record, \'$.kind\') AS kind FROM entries').includes(OLD_NOTE), true);
      assert.equal(userEntryText(before).includes(BODY_MARKERS), true);
    } finally {
      before.close();
    }
    assert.equal((await listWeftBackupDirs(dataDir)).length, 0);

    const second = await startServer({ token: TOKEN, env, dataDir });
    proc = second.proc;
    const opened = await waitFor(second.base, cid, (body) => (
      (body.messages || []).some((message) => message.role === 'user' && String(message.text || '').includes(BODY_MARKERS))
      && (body.messages || []).some((message) => message.role === 'note' && message.text === parentNoteText('scout', 'keep going'))
      && subagentsOf(body).some((agent) => agent.name === 'scout')
      && subagentsOf(body).some((agent) => agent.mode === 'foreground')
    ), 80);
    const user = (opened.messages || []).find((message) => message.role === 'user' && String(message.text || '').includes(BODY_MARKERS));
    assert.equal(user.text, BODY_MARKERS);
    const noteAfter = (opened.messages || []).find((message) => message.role === 'note');
    assert.equal(noteAfter.role, 'note');
    assert.equal(noteAfter.text, parentNoteText('scout', 'keep going'));
    const scoutAfter = subagentsOf(opened).find((agent) => agent.name === 'scout');
    assert.ok(scoutAfter, JSON.stringify(opened.agents));
    assert.equal(scoutAfter.mode, 'background');
    const foreground = subagentsOf(opened).find((agent) => agent.mode === 'foreground');
    assert.ok(foreground, JSON.stringify(opened.agents));
    assert.equal(foreground.name, 'fg-task');

    const reported = await waitFor(second.base, cid, (body) => (
      (body.messages || []).some((message) => String(message.text || '').includes('BG_ANSWER'))
    ), 120);
    assert.match(
      (reported.messages || []).map((message) => message.text || '').join('\n'),
      /\[subagent scout answered, no reply needed] BG_ANSWER/,
      `${second.logs()}\n${JSON.stringify(reported?.messages)}`,
    );

    assert.equal((await request(second.base, 'POST', `/api/conversations/${cid}/messages`, { text: 'continue after migrate' })).status, 202);
    const continued = await waitFor(second.base, cid, (body) => (
      (body.messages || []).some((message) => message.role === 'user' && message.text === 'continue after migrate')
    ), 80);
    assert.ok(continued, second.logs());

    const backupsAfterFirstMigrate = await listWeftBackupDirs(dataDir);
    assert.equal(backupsAfterFirstMigrate.length, 1, backupsAfterFirstMigrate.join(','));

    await stopServer(proc);
    proc = null;
    const third = await startServer({ token: TOKEN, env, dataDir });
    proc = third.proc;
    const again = await request(third.base, 'GET', `/api/conversations/${cid}`);
    assert.equal(again.status, 200);
    assert.equal((again.body.messages || []).some((message) => String(message.text || '').includes(BODY_MARKERS)), true);
    assert.equal((again.body.messages || []).some((message) => message.role === 'note'), true);
    assert.equal(subagentsOf(again.body).some((agent) => agent.name === 'scout'), true);
    assert.equal((await listWeftBackupDirs(dataDir)).length, 1);

    await stopServer(proc);
    proc = null;
    const backupDir = backupsAfterFirstMigrate[0];
    const harnessDir = path.join(dataDir, 'harness');
    for (const name of await readdir(backupDir)) {
      await copyFile(path.join(backupDir, name), path.join(harnessDir, name));
    }
    const restored = openHarnessDb(harnessSqlitePath(dataDir), true);
    try {
      assert.equal(taskKindColumns(restored).includes(OLD_REPORTER), true);
      assert.equal(documentKindColumns(restored).includes(OLD_SUBAGENTS), true);
      assert.equal(userEntryText(restored).includes(BODY_MARKERS), true);
    } finally {
      restored.close();
    }
  } finally {
    await stopServer(proc);
    await rm(dataDir, { recursive: true, force: true });
  }
});
