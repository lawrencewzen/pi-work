import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, existsSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { DEFAULT_SETTINGS, mergeSettings, normalizeSettings } from '../core/settings.mjs';

const SCHEMA_VERSION = 7;
const MESSAGE_META_KEYS = ['kind', 'fromAgent', 'toAgent', 'agentId'];
export const APP_DB_FILE = 'weft.sqlite';
export const LEGACY_APP_DB_FILE = 'pi-work.sqlite';
const SQLITE_SIDECARS = Object.freeze(['', '-wal', '-shm']);

/**
 * App database path. If only the old filename exists, rename it (and WAL/SHM)
 * onto the new name. If both exist, keep the new file and leave the old one.
 */
export function resolveAppDatabasePath(dir, { log = console } = {}) {
  mkdirSync(dir, { recursive: true });
  const nextPath = path.join(dir, APP_DB_FILE);
  const legacyPath = path.join(dir, LEGACY_APP_DB_FILE);
  const nextExists = existsSync(nextPath);
  const legacyExists = existsSync(legacyPath);
  if (nextExists && legacyExists) {
    log.log?.(`WEFT_DB using ${APP_DB_FILE}; leftover ${LEGACY_APP_DB_FILE} was not renamed`);
    return nextPath;
  }
  if (!nextExists && legacyExists) {
    for (const suffix of SQLITE_SIDECARS) {
      const from = `${legacyPath}${suffix}`;
      const to = `${nextPath}${suffix}`;
      if (existsSync(from)) renameSync(from, to);
    }
    log.log?.(`WEFT_DB renamed ${LEGACY_APP_DB_FILE} -> ${APP_DB_FILE}`);
  }
  return nextPath;
}

function chmodSecret(p) {
  try { chmodSync(p, 0o600); } catch { /* wal/shm may not exist yet */ }
}

function j(v) {
  return JSON.stringify(v ?? null);
}
function p(v) {
  if (v == null || v === '') return null;
  try { return JSON.parse(v); } catch { return v; }
}

function usageToSql(v) {
  if (v == null) return null;
  return JSON.stringify(v);
}

function usageFromSql(v) {
  const parsed = p(v);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed;
}

function metaFromMsg(msg = {}, prev = null) {
  const meta = prev && typeof prev === 'object' ? { ...prev } : {};
  for (const k of MESSAGE_META_KEYS) {
    if (msg[k] !== undefined) {
      if (msg[k] == null || msg[k] === '') delete meta[k];
      else meta[k] = msg[k];
    }
  }
  return Object.keys(meta).length ? meta : null;
}

function applyMeta(out, meta) {
  if (!meta || typeof meta !== 'object') return out;
  for (const k of MESSAGE_META_KEYS) {
    if (meta[k] != null && meta[k] !== '') out[k] = meta[k];
  }
  return out;
}

function convFromRow(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    status: row.status,
    autoContinues: row.auto_continues,
    retries: row.retries,
    lastCheckpointAt: row.last_checkpoint_at,
    currentStep: row.current_step,
    updatedAt: row.updated_at,
    createdAt: row.created_at,
    workspacePath: row.workspace_path,
    lastProgressAt: row.last_progress_at,
    originalText: row.original_text,
    usage: usageFromSql(row.usage_json),
    harnessId: row.harness_id == null ? null : Number(row.harness_id),
    lastSubmissionId: row.last_submission_id == null ? null : Number(row.last_submission_id),
    modelSourceId: row.model_source_id || null,
    modelId: row.model_id || null,
  };
}

export function createSqliteStore(dir, { log = console } = {}) {
  const dbPath = resolveAppDatabasePath(dir, { log });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA busy_timeout = 5000');
  chmodSecret(dbPath);
  chmodSecret(`${dbPath}-wal`);
  chmodSecret(`${dbPath}-shm`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      source TEXT,
      git_url TEXT,
      branch TEXT,
      root_path TEXT,
      worktrees_json TEXT
    );
    CREATE TABLE IF NOT EXISTS settings (
      id TEXT PRIMARY KEY,
      json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS conversations (
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
      pipeline_id TEXT,
      workspace_path TEXT,
      last_progress_at INTEGER,
      original_text TEXT,
      harness_id INTEGER,
      host_mark TEXT,
      last_submission_id INTEGER,
      model_source_id TEXT,
      model_id TEXT
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT,
      text TEXT,
      tool_json TEXT,
      seq INTEGER,
      meta_json TEXT
    );
    CREATE TABLE IF NOT EXISTS tool_calls (
      id TEXT PRIMARY KEY,
      conversation_id TEXT,
      name TEXT,
      status TEXT,
      input_json TEXT,
      output_json TEXT,
      path TEXT,
      added INTEGER,
      removed INTEGER
    );
    CREATE TABLE IF NOT EXISTS changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT,
      path TEXT,
      before_text TEXT,
      after_text TEXT,
      added INTEGER,
      removed INTEGER,
      tool_call_id TEXT
    );
    CREATE TABLE IF NOT EXISTS events (
      conversation_id TEXT NOT NULL,
      event_id INTEGER NOT NULL,
      event TEXT,
      data_json TEXT,
      PRIMARY KEY (conversation_id, event_id)
    );
    CREATE TABLE IF NOT EXISTS catalog_tombstones (
      kind TEXT NOT NULL,
      id TEXT NOT NULL,
      PRIMARY KEY (kind, id)
    );
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER NOT NULL
    );
  `);

  {
    const wsCols = new Set(db.prepare('PRAGMA table_info(workspaces)').all().map((c) => c.name));
    const addCol = (name, ddl) => {
      if (!wsCols.has(name)) db.exec(`ALTER TABLE workspaces ADD COLUMN ${ddl}`);
    };
    addCol('source', 'source TEXT');
    addCol('git_url', 'git_url TEXT');
    addCol('branch', 'branch TEXT');
    addCol('root_path', 'root_path TEXT');
    addCol('worktrees_json', 'worktrees_json TEXT');
    // Removing a workspace only hides it; its conversations stay and come back when the path is added again.
    addCol('removed_at', 'removed_at INTEGER');
  }

  {
    const toolCols = new Set(db.prepare('PRAGMA table_info(tool_calls)').all().map((c) => c.name));
    if (!toolCols.has('before_hash')) db.exec('ALTER TABLE tool_calls ADD COLUMN before_hash TEXT');
    if (!toolCols.has('after_hash')) db.exec('ALTER TABLE tool_calls ADD COLUMN after_hash TEXT');
  }

  {
    const msgCols = new Set(db.prepare('PRAGMA table_info(messages)').all().map((c) => c.name));
    if (!msgCols.has('meta_json')) db.exec('ALTER TABLE messages ADD COLUMN meta_json TEXT');
  }

  {
    const convCols = new Set(db.prepare('PRAGMA table_info(conversations)').all().map((c) => c.name));
    if (!convCols.has('usage_json')) db.exec('ALTER TABLE conversations ADD COLUMN usage_json TEXT');
    if (!convCols.has('harness_id')) db.exec('ALTER TABLE conversations ADD COLUMN harness_id INTEGER');
    if (!convCols.has('host_mark')) db.exec('ALTER TABLE conversations ADD COLUMN host_mark TEXT');
    if (!convCols.has('last_submission_id')) db.exec('ALTER TABLE conversations ADD COLUMN last_submission_id INTEGER');
    if (!convCols.has('model_source_id')) db.exec('ALTER TABLE conversations ADD COLUMN model_source_id TEXT');
    if (!convCols.has('model_id')) db.exec('ALTER TABLE conversations ADD COLUMN model_id TEXT');
    if (convCols.has('role_id')) {
      try { db.exec('ALTER TABLE conversations DROP COLUMN role_id'); } catch { /* keep the column, stop reading it */ }
    }
  }

  db.exec('DROP TABLE IF EXISTS roles');

  {
    const row = db.prepare('SELECT version FROM schema_version LIMIT 1').get();
    if (!row) db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
    else if (row.version < SCHEMA_VERSION) db.prepare('UPDATE schema_version SET version = ?').run(SCHEMA_VERSION);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  // Dialogue state lives in the Harness. These tables only served the old shell,
  // the pre-harness archive, or the removed pipeline. Export legacy chats before
  // starting this build.
  db.exec(`
    DROP TABLE IF EXISTS events;
    DROP TABLE IF EXISTS messages;
    DROP TABLE IF EXISTS tool_calls;
    DROP TABLE IF EXISTS changes;
    DROP TABLE IF EXISTS pipelines;
  `);

  const q = {
    insWs: db.prepare('INSERT INTO workspaces (id, name, path, source, git_url, branch, root_path, worktrees_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    listWs: db.prepare('SELECT * FROM workspaces WHERE removed_at IS NULL'),
    removeWs: db.prepare('UPDATE workspaces SET removed_at = ? WHERE id = ? AND removed_at IS NULL'),
    findRemovedWs: db.prepare("SELECT * FROM workspaces WHERE removed_at IS NOT NULL AND path = ? AND COALESCE(source, 'local') = 'local' ORDER BY removed_at DESC LIMIT 1"),
    restoreWs: db.prepare('UPDATE workspaces SET removed_at = NULL, name = ? WHERE id = ?'),
    getWs: db.prepare('SELECT * FROM workspaces WHERE id = ?'),
    getSettings: db.prepare('SELECT json FROM settings WHERE id = ?'),
    putSettings: db.prepare('INSERT INTO settings (id, json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json'),
    insConv: db.prepare(`INSERT INTO conversations (
      id, workspace_id, title, status, auto_continues, retries, last_checkpoint_at,
      current_step, updated_at, created_at,
      workspace_path, last_progress_at, original_text, usage_json, harness_id, host_mark,
      last_submission_id, model_source_id, model_id
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
    getConv: db.prepare('SELECT * FROM conversations WHERE id = ?'),
    listRecoverable: db.prepare("SELECT * FROM conversations WHERE status IN ('running','recovering') AND harness_id IS NULL"),
    listKernel: db.prepare('SELECT * FROM conversations WHERE harness_id IS NOT NULL'),
    updConv: db.prepare(`UPDATE conversations SET
      workspace_id=?, title=?, updated_at=?,
      workspace_path=?, last_progress_at=?, original_text=?, usage_json=?, harness_id=?,
      last_submission_id=?, model_source_id=?, model_id=?
      WHERE id=?`),
    listConv: db.prepare('SELECT * FROM conversations WHERE workspace_id = ? AND harness_id IS NOT NULL ORDER BY updated_at DESC'),
    insTomb: db.prepare('INSERT OR IGNORE INTO catalog_tombstones (kind, id) VALUES (?, ?)'),
    delTomb: db.prepare('DELETE FROM catalog_tombstones WHERE kind = ? AND id = ?'),
    hasTomb: db.prepare('SELECT 1 AS ok FROM catalog_tombstones WHERE kind = ? AND id = ?'),
  };

  chmodSecret(dbPath);
  chmodSecret(`${dbPath}-wal`);
  chmodSecret(`${dbPath}-shm`);

  function msgFromRow(row) {
    if (!row) return undefined;
    const out = { id: row.id, role: row.role, text: row.text ?? undefined };
    const tool = p(row.tool_json);
    if (tool) out.tool = tool;
    applyMeta(out, p(row.meta_json));
    return out;
  }

  function toolFromRow(row) {
    if (!row) return undefined;
    return {
      id: row.id,
      conversationId: row.conversation_id,
      name: row.name,
      status: row.status,
      input: p(row.input_json),
      output: p(row.output_json),
      path: row.path ?? undefined,
      added: row.added ?? undefined,
      removed: row.removed ?? undefined,
      beforeHash: row.before_hash ?? undefined,
      afterHash: row.after_hash ?? undefined,
    };
  }

  function wsFromRow(r) {
    if (!r) return undefined;
    return {
      id: r.id,
      name: r.name,
      path: r.path,
      source: r.source || (r.git_url ? 'git' : 'local'),
      gitUrl: r.git_url ?? null,
      branch: r.branch ?? null,
      rootPath: r.root_path || r.path,
      // TODO: git worktrees are not implemented yet; reserved for future `git worktree add`.
      worktrees: p(r.worktrees_json) || [],
      ...(r.removed_at ? { removedAt: r.removed_at } : {}),
    };
  }

  return {
    async createWorkspace({ id, name, path: wsPath, source, gitUrl, branch, rootPath, worktrees } = {}) {
      const ws = {
        id: id || randomUUID(),
        name,
        path: wsPath,
        source: source || (gitUrl ? 'git' : 'local'),
        gitUrl: gitUrl ?? null,
        branch: branch ?? null,
        rootPath: rootPath || wsPath,
        // TODO: git worktrees are not implemented yet; reserved for future `git worktree add`.
        worktrees: Array.isArray(worktrees) ? worktrees : [],
      };
      q.insWs.run(ws.id, ws.name, ws.path, ws.source, ws.gitUrl, ws.branch, ws.rootPath, j(ws.worktrees));
      return ws;
    },
    async listWorkspaces() {
      return q.listWs.all().map(wsFromRow);
    },
    async getWorkspace(id) {
      return wsFromRow(q.getWs.get(id));
    },
    async removeWorkspace(id) {
      return q.removeWs.run(Date.now(), id).changes > 0;
    },
    /** A removed local workspace at the same path comes back with its conversations. */
    async restoreWorkspaceByPath(wsPath, name) {
      const row = q.findRemovedWs.get(wsPath);
      if (!row) return undefined;
      q.restoreWs.run(name || row.name, row.id);
      return wsFromRow(q.getWs.get(row.id));
    },

    async createConversation({
      id, workspaceId, title, workspacePath, modelSourceId, modelId,
    } = {}) {
      const now = Date.now();
      const conv = {
        id: id || randomUUID(),
        workspaceId: workspaceId ?? null,
        title: title || 'New conversation',
        updatedAt: now,
        createdAt: now,
        workspacePath: workspacePath ?? null,
        lastProgressAt: now,
        originalText: null,
        usage: null,
        harnessId: null,
        modelSourceId: modelSourceId ?? null,
        modelId: modelId ?? null,
      };
      q.insConv.run(
        conv.id, conv.workspaceId, conv.title, null, null, null,
        null, null, conv.updatedAt, conv.createdAt,
        conv.workspacePath, conv.lastProgressAt, conv.originalText,
        usageToSql(conv.usage), conv.harnessId, null, null,
        conv.modelSourceId, conv.modelId,
      );
      return conv;
    },
    async getConversation(id) {
      return convFromRow(q.getConv.get(id));
    },
    async listConversations(workspaceId, { q: query } = {}) {
      let list = q.listConv.all(workspaceId).map(convFromRow);
      if (query) {
        const n = String(query).toLowerCase();
        list = list.filter((c) => (c.title || '').toLowerCase().includes(n));
      }
      return list;
    },
    async listRecoverable() {
      return q.listRecoverable.all().map(convFromRow);
    },
    async listKernelConversations() {
      return q.listKernel.all().map(convFromRow);
    },
    async updateConversation(id, patch = {}) {
      let conv = convFromRow(q.getConv.get(id));
      if (!conv) {
        const now = Date.now();
        conv = {
          id,
          workspaceId: null,
          title: 'New conversation',
          updatedAt: now,
          createdAt: now,
          workspacePath: null,
          lastProgressAt: now,
          originalText: null,
          usage: null,
          harnessId: null,
          modelSourceId: null,
          modelId: null,
        };
        q.insConv.run(
          conv.id, conv.workspaceId, conv.title, null, null, null,
          null, null, conv.updatedAt, conv.createdAt,
          conv.workspacePath, conv.lastProgressAt, conv.originalText,
          usageToSql(conv.usage), null, null, patch.lastSubmissionId ?? null,
          conv.modelSourceId, conv.modelId,
        );
      }
      const next = { ...conv, ...patch, updatedAt: Date.now() };
      q.updConv.run(
        next.workspaceId, next.title, next.updatedAt,
        next.workspacePath, next.lastProgressAt, next.originalText, usageToSql(next.usage),
        next.harnessId ?? null, next.lastSubmissionId ?? null,
        next.modelSourceId ?? null, next.modelId ?? null, id,
      );
      return next;
    },

    async tombstoneCatalog(kind, id) {
      q.insTomb.run(kind, id);
    },
    async clearCatalogTombstone(kind, id) {
      q.delTomb.run(kind, id);
    },
    async hasCatalogTombstone(kind, id) {
      return Boolean(q.hasTomb.get(kind, id));
    },

    async getSettings() {
      const row = q.getSettings.get('app');
      return normalizeSettings(row ? p(row.json) : DEFAULT_SETTINGS);
    },
    async putSettings(patch = {}) {
      const cur = await this.getSettings();
      const next = mergeSettings(cur, patch);
      q.putSettings.run('app', j(next));
      return next;
    },

    close() {
      db.close();
    },
  };
}
