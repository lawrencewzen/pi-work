// One-shot rename of identifiers persisted in Pi Durable SQLite storage.
// Pi Durable has no public API to rename document / task / entry kinds or
// stored extension names (they are stored by name in `pi.agent`). This module
// rewrites only those identifier fields before Harness.open.
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  BRAND,
  EXTENSION_NAMES,
  KIND_NAMES,
  KIND_PREFIX,
} from './ids.mjs';

const LEGACY_BRAND = `pi${'-'}work`;
const LEGACY_KIND_PREFIX = `app.${LEGACY_BRAND}.`;
const LEGACY_BARE_KIND_PREFIX = `${LEGACY_BRAND}.`;
const BARE_KIND_PREFIX = `${BRAND}.`;
const LEGACY_EXT_PREFIX = `${LEGACY_BRAND}-`;
const AGENT_DOC_KIND = 'pi.agent';
const HARNESS_DB = 'session.sqlite';
const SQLITE_SIDECARS = Object.freeze([HARNESS_DB, `${HARNESS_DB}-wal`, `${HARNESS_DB}-shm`]);

export const BACKUP_PREFIX = `backup-before-${BRAND}-`;

export function harnessSqlitePath(dataDir) {
  return path.join(path.resolve(dataDir), 'harness', HARNESS_DB);
}

export function kindRenameMap() {
  return Object.fromEntries(KIND_NAMES.map((kind) => [
    LEGACY_KIND_PREFIX + kind.slice(KIND_PREFIX.length),
    kind,
  ]));
}

export function extensionRenameMap() {
  const prefix = `${BRAND}-`;
  return Object.fromEntries(EXTENSION_NAMES.map((name) => [
    LEGACY_EXT_PREFIX + name.slice(prefix.length),
    name,
  ]));
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

function prefixPairs(from, to, extra) {
  const pairs = [];
  if (from && to) pairs.push([from, to]);
  if (Array.isArray(extra)) {
    for (const pair of extra) {
      if (Array.isArray(pair) && pair[0] && pair[1]) pairs.push(pair);
    }
  }
  return pairs;
}

function kindPrefixPairs(maps) {
  return prefixPairs(maps.kindFrom, maps.kindTo, maps.kindPrefixes);
}

function extPrefixPairs(maps) {
  return prefixPairs(maps.extFrom, maps.extTo);
}

function renameMappedString(value, map, prefixes) {
  if (typeof value !== 'string') return value;
  if (Object.hasOwn(map, value)) return map[value];
  for (const [from, to] of prefixes || []) {
    if (from && to && value.startsWith(from) && value !== from) {
      return to + value.slice(from.length);
    }
  }
  return value;
}

function pathTouchesExtensions(opPath) {
  return Array.isArray(opPath) && opPath[0] === 'extensions';
}

function renameExtensionValue(value, rename) {
  if (typeof value === 'string') return rename(value);
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      if (typeof item !== 'string') return item;
      const renamed = rename(item);
      if (renamed !== item) changed = true;
      return renamed;
    });
    return changed ? next : value;
  }
  if (!value || typeof value !== 'object') return value;
  let changed = false;
  const next = { ...value };
  for (const key of ['add', 'remove']) {
    if (!Array.isArray(next[key])) continue;
    const renamed = renameExtensionValue(next[key], rename);
    if (renamed !== next[key]) {
      next[key] = renamed;
      changed = true;
    }
  }
  return changed ? next : value;
}

function renameAgentState(state, rename) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return state;
  if (!Object.hasOwn(state, 'extensions')) return state;
  const renamed = renameExtensionValue(state.extensions, rename);
  if (renamed === state.extensions) return state;
  return { ...state, extensions: renamed };
}

function renameDeltaOps(ops, rename) {
  if (!Array.isArray(ops)) return ops;
  let changed = false;
  const next = ops.map((op) => {
    if (!Array.isArray(op) || op.length === 0) return op;
    const type = op[0];
    if (type === 'r') {
      const patched = renameAgentState(op[1], rename);
      if (patched !== op[1]) {
        changed = true;
        return [type, patched];
      }
      return op;
    }
    if (type === 's' && pathTouchesExtensions(op[1])) {
      const patched = renameExtensionValue(op[2], rename);
      if (patched !== op[2]) {
        changed = true;
        return [type, op[1], patched];
      }
      return op;
    }
    if (type === 'p' && pathTouchesExtensions(op[1])) {
      const patched = renameExtensionValue(op[4], rename);
      if (patched !== op[4]) {
        changed = true;
        return [type, op[1], op[2], op[3], patched];
      }
    }
    return op;
  });
  return changed ? next : ops;
}

function tableExists(db, name) {
  return Boolean(db.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get('table', name));
}

function wouldRename(value, map, prefixes) {
  return typeof value === 'string' && renameMappedString(value, map, prefixes) !== value;
}

function scanNeedsRewrite(db, maps) {
  const { kinds, extensions } = maps;
  const kindPrefixes = kindPrefixPairs(maps);
  const renameExt = (value) => renameMappedString(value, extensions, extPrefixPairs(maps));

  if (tableExists(db, 'tasks')) {
    for (const row of db.prepare('SELECT kind, record FROM tasks').all()) {
      if (wouldRename(decodeIndexed(row.kind), kinds, kindPrefixes)) return true;
      try {
        const record = JSON.parse(row.record);
        if (wouldRename(record?.kind, kinds, kindPrefixes)) return true;
      } catch {
        /* checked again during the rewrite */
      }
    }
  }
  if (tableExists(db, 'documents')) {
    for (const row of db.prepare('SELECT kind, record FROM documents').all()) {
      if (wouldRename(decodeIndexed(row.kind), kinds, kindPrefixes)) return true;
      try {
        const record = JSON.parse(row.record);
        if (wouldRename(record?.kind, kinds, kindPrefixes)) return true;
      } catch {
        /* checked again during the rewrite */
      }
    }
  }
  if (tableExists(db, 'entries')) {
    for (const row of db.prepare('SELECT record FROM entries').all()) {
      try {
        const record = JSON.parse(row.record);
        if (wouldRename(record?.kind, kinds, kindPrefixes)) return true;
      } catch {
        /* checked again during the rewrite */
      }
    }
  }
  if (tableExists(db, 'documents') && tableExists(db, 'document_revisions')) {
    const rows = db.prepare(`
      SELECT r.kind AS rev_kind, r.content, d.kind AS doc_kind
      FROM document_revisions r
      JOIN documents d ON d.id = r.document_id
    `).all();
    for (const row of rows) {
      if (decodeIndexed(row.doc_kind) !== AGENT_DOC_KIND) continue;
      let content;
      try {
        content = JSON.parse(row.content);
      } catch {
        continue;
      }
      if (row.rev_kind === 'base') {
        if (renameAgentState(content, renameExt) !== content) return true;
      } else if (row.rev_kind === 'delta') {
        if (renameDeltaOps(content, renameExt) !== content) return true;
      }
    }
  }
  return false;
}

function parseRecordObject(raw, label) {
  const record = JSON.parse(raw);
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error(`invalid ${label}`);
  }
  return record;
}

function rewriteKindColumnAndRecord(db, table, maps) {
  const renameKind = (value) => renameMappedString(value, maps.kinds, kindPrefixPairs(maps));
  const rows = db.prepare(`SELECT id, kind, record FROM ${table}`).all();
  const update = db.prepare(`UPDATE ${table} SET kind = ?, record = ? WHERE id = ?`);
  for (const row of rows) {
    const columnKind = renameKind(decodeIndexed(row.kind));
    const record = parseRecordObject(row.record, `${table} record ${row.id}`);
    const recordKind = renameKind(record.kind);
    const columnChanged = columnKind !== decodeIndexed(row.kind);
    const recordChanged = recordKind !== record.kind;
    if (!columnChanged && !recordChanged) continue;
    if (recordChanged) record.kind = recordKind;
    update.run(
      columnChanged ? indexed(columnKind) : row.kind,
      recordChanged ? JSON.stringify(record) : row.record,
      row.id,
    );
  }
}

function rewriteEntryKinds(db, maps) {
  const renameKind = (value) => renameMappedString(value, maps.kinds, kindPrefixPairs(maps));
  const rows = db.prepare('SELECT id, record FROM entries').all();
  const update = db.prepare('UPDATE entries SET record = ? WHERE id = ?');
  for (const row of rows) {
    const record = parseRecordObject(row.record, `entries record ${row.id}`);
    const nextKind = renameKind(record.kind);
    if (nextKind === record.kind) continue;
    record.kind = nextKind;
    update.run(JSON.stringify(record), row.id);
  }
}

function rewriteAgentRevisions(db, maps) {
  const renameExt = (value) => renameMappedString(value, maps.extensions, extPrefixPairs(maps));
  const rows = db.prepare(`
    SELECT r.document_id, r.seq, r.kind AS rev_kind, r.content, d.kind AS doc_kind
    FROM document_revisions r
    JOIN documents d ON d.id = r.document_id
  `).all();
  const update = db.prepare(`
    UPDATE document_revisions SET content = ? WHERE document_id = ? AND seq = ?
  `);
  for (const row of rows) {
    if (decodeIndexed(row.doc_kind) !== AGENT_DOC_KIND) continue;
    const content = JSON.parse(row.content);
    let next = content;
    if (row.rev_kind === 'base') next = renameAgentState(content, renameExt);
    else if (row.rev_kind === 'delta') next = renameDeltaOps(content, renameExt);
    if (next === content) continue;
    update.run(JSON.stringify(next), row.document_id, row.seq);
  }
}

/**
 * Rewrite identifier fields in an already-open SQLite database.
 * `kinds` / `extensions` map exact stored strings; optional prefixes rename
 * unknown names that still use the old brand.
 */
export function rewriteStoredIds(db, {
  kinds = {},
  extensions = {},
  kindFrom,
  kindTo,
  kindPrefixes,
  extFrom,
  extTo,
} = {}) {
  const maps = { kinds, extensions, kindFrom, kindTo, kindPrefixes, extFrom, extTo };
  if (tableExists(db, 'tasks')) rewriteKindColumnAndRecord(db, 'tasks', maps);
  if (tableExists(db, 'documents')) rewriteKindColumnAndRecord(db, 'documents', maps);
  if (tableExists(db, 'entries')) rewriteEntryKinds(db, maps);
  if (tableExists(db, 'documents') && tableExists(db, 'document_revisions')) {
    rewriteAgentRevisions(db, maps);
  }
}

function forwardMaps() {
  return {
    kinds: kindRenameMap(),
    extensions: extensionRenameMap(),
    kindFrom: LEGACY_KIND_PREFIX,
    kindTo: KIND_PREFIX,
    kindPrefixes: [[LEGACY_BARE_KIND_PREFIX, BARE_KIND_PREFIX]],
    extFrom: LEGACY_EXT_PREFIX,
    extTo: `${BRAND}-`,
  };
}

export function needsWeftIdMigration(db) {
  return scanNeedsRewrite(db, forwardMaps());
}

function openDb(storagePath, readOnly = false) {
  return new DatabaseSync(storagePath, { readOnly, timeout: 5000 });
}

function backupStamp(now = new Date()) {
  return now.toISOString().replaceAll(':', '-').replaceAll('.', '-');
}

async function uniqueBackupDir(dataDir, stamp) {
  let dest = path.join(dataDir, `${BACKUP_PREFIX}${stamp}`);
  let extra = 0;
  while (existsSync(dest)) {
    extra += 1;
    dest = path.join(dataDir, `${BACKUP_PREFIX}${stamp}-${extra}`);
  }
  return dest;
}

async function copyHarnessFiles(dataDir, destDir) {
  const harnessDir = path.join(path.resolve(dataDir), 'harness');
  await mkdir(destDir, { recursive: true });
  const copied = [];
  for (const name of SQLITE_SIDECARS) {
    const source = path.join(harnessDir, name);
    if (!existsSync(source)) continue;
    await copyFile(source, path.join(destDir, name));
    copied.push(name);
  }
  return copied;
}

export async function listWeftBackupDirs(dataDir) {
  let entries = [];
  try {
    entries = await readdir(path.resolve(dataDir), { withFileTypes: true });
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(BACKUP_PREFIX))
    .map((entry) => path.join(path.resolve(dataDir), entry.name))
    .sort();
}

function formatError(error) {
  if (error instanceof Error) return error.message;
  try {
    return String(error);
  } catch {
    return 'unknown error';
  }
}

function applyForwardRewrite(db) {
  rewriteStoredIds(db, forwardMaps());
}

/**
 * Backup harness SQLite (and WAL/SHM) then rename stored identifiers.
 * Missing or already-migrated stores are left alone. Failures roll back the
 * SQL transaction, keep the backup, and return without throwing so startup
 * can continue.
 */
export async function migrateWeftIds(dataDir, { log = console } = {}) {
  if (!dataDir) return { status: 'skipped', reason: 'no-data-dir' };
  const storagePath = harnessSqlitePath(dataDir);
  if (!existsSync(storagePath)) return { status: 'skipped', reason: 'missing' };

  let needed = false;
  try {
    const inspect = openDb(storagePath, true);
    try {
      needed = needsWeftIdMigration(inspect);
    } finally {
      inspect.close();
    }
  } catch (err) {
    log.error?.(`WEFT_WEFT_IDS inspect failed: ${formatError(err)}`);
    return { status: 'failed', error: err };
  }
  if (!needed) return { status: 'skipped', reason: 'current' };

  let backupDir;
  try {
    backupDir = await uniqueBackupDir(path.resolve(dataDir), backupStamp());
    await copyHarnessFiles(dataDir, backupDir);
  } catch (err) {
    log.error?.(`WEFT_WEFT_IDS backup failed: ${formatError(err)}`);
    return { status: 'failed', error: err, backupDir };
  }

  let db;
  try {
    db = openDb(storagePath, false);
    db.exec('BEGIN IMMEDIATE');
    applyForwardRewrite(db);
    db.exec('COMMIT');
    log.log?.(`WEFT_WEFT_IDS migrated backup=${backupDir}`);
    return { status: 'migrated', backupDir };
  } catch (err) {
    try {
      db?.exec('ROLLBACK');
    } catch {
      /* keep the original error */
    }
    log.error?.(`WEFT_WEFT_IDS failed: ${formatError(err)}`);
    return { status: 'failed', error: err, backupDir };
  } finally {
    try {
      db?.close();
    } catch {
      /* already closed */
    }
  }
}
