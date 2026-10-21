import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { DEFAULT_SETTINGS, mergeSettings, normalizeSettings } from '../core/settings.mjs';

const SCHEMA_VERSION = 6;
const MESSAGE_META_KEYS = ['kind', 'fromAgent', 'toAgent', 'agentId', 'roleId'];

function chmodSecret(p) {
  try { chmodSync(p, 0o600); } catch { /* wal/shm may not exist yet */ }
}

const DEFAULT_ROLE = {
  id: 'default',
  name: 'Default',
  systemPrompt: 'You are a helpful coding assistant. Use tools to work in the workspace.',
  tools: ['read', 'write', 'edit', 'ls', 'grep', 'bash'],
};

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
    roleId: row.role_id,
    workspacePath: row.workspace_path,
    lastProgressAt: row.last_progress_at,
    originalText: row.original_text,
    usage: usageFromSql(row.usage_json),
    harnessId: row.harness_id == null ? null : Number(row.harness_id),
    lastSubmissionId: row.last_submission_id == null ? null : Number(row.last_submission_id),
  };
}

export function createSqliteStore(dir) {
  mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, 'pi-work.sqlite');
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
      role_id TEXT,
      pipeline_id TEXT,
      workspace_path TEXT,
      last_progress_at INTEGER,
      original_text TEXT,
      harness_id INTEGER,
      host_mark TEXT,
      last_submission_id INTEGER
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
    CREATE TABLE IF NOT EXISTS roles (
      id TEXT PRIMARY KEY,
      name TEXT,
      system_prompt TEXT,
      tools_json TEXT,
      model TEXT,
      description TEXT,
      skills_json TEXT,
      plugin_tools INTEGER
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
  }

  {
    const roleCols = new Set(db.prepare('PRAGMA table_info(roles)').all().map((c) => c.name));
    if (!roleCols.has('description')) db.exec('ALTER TABLE roles ADD COLUMN description TEXT');
    if (!roleCols.has('skills_json')) db.exec('ALTER TABLE roles ADD COLUMN skills_json TEXT');
    if (!roleCols.has('plugin_tools')) db.exec('ALTER TABLE roles ADD COLUMN plugin_tools INTEGER');
  }

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
      current_step, updated_at, created_at, role_id,
      workspace_path, last_progress_at, original_text, usage_json, harness_id, host_mark,
      last_submission_id
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
    getConv: db.prepare('SELECT * FROM conversations WHERE id = ?'),
    listRecoverable: db.prepare("SELECT * FROM conversations WHERE status IN ('running','recovering') AND harness_id IS NULL"),
    listKernel: db.prepare('SELECT * FROM conversations WHERE harness_id IS NOT NULL'),
    updConv: db.prepare(`UPDATE conversations SET
      workspace_id=?, title=?, updated_at=?, role_id=?,
      workspace_path=?, last_progress_at=?, original_text=?, usage_json=?, harness_id=?,
      last_submission_id=?
      WHERE id=?`),
    listConv: db.prepare('SELECT * FROM conversations WHERE workspace_id = ? AND harness_id IS NOT NULL ORDER BY updated_at DESC'),
    insRole: db.prepare(`INSERT OR REPLACE INTO roles (
      id, name, system_prompt, tools_json, model, description, skills_json, plugin_tools
    ) VALUES (?,?,?,?,?,?,?,?)`),
    listRoles: db.prepare('SELECT * FROM roles'),
    getRole: db.prepare('SELECT * FROM roles WHERE id = ?'),
    delRole: db.prepare('DELETE FROM roles WHERE id = ?'),
    insTomb: db.prepare('INSERT OR IGNORE INTO catalog_tombstones (kind, id) VALUES (?, ?)'),
    delTomb: db.prepare('DELETE FROM catalog_tombstones WHERE kind = ? AND id = ?'),
    hasTomb: db.prepare('SELECT 1 AS ok FROM catalog_tombstones WHERE kind = ? AND id = ?'),
    countRoleRefs: db.prepare('SELECT COUNT(*) AS n FROM conversations WHERE role_id = ?'),
  };

  if (!q.getRole.get(DEFAULT_ROLE.id)) {
    q.insRole.run(...roleParams(DEFAULT_ROLE));
  }

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

  function roleParams(role) {
    let plugin = null;
    if (role.pluginTools === false) plugin = 0;
    else if (role.pluginTools === true) plugin = 1;
    return [
      role.id,
      role.name,
      role.systemPrompt,
      j(role.tools),
      role.model ?? null,
      typeof role.description === 'string' ? role.description : '',
      Array.isArray(role.skills) ? j(role.skills) : null,
      plugin,
    ];
  }

  function roleFromRow(row) {
    if (!row) return undefined;
    const r = {
      id: row.id,
      name: row.name,
      systemPrompt: row.system_prompt,
      tools: p(row.tools_json) || [],
      description: typeof row.description === 'string' ? row.description : '',
    };
    if (row.model) r.model = row.model;
    if (row.skills_json != null && row.skills_json !== '') {
      const skills = p(row.skills_json);
      if (Array.isArray(skills)) r.skills = skills;
    }
    if (row.plugin_tools === 0) r.pluginTools = false;
    else if (row.plugin_tools === 1) r.pluginTools = true;
    return r;
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
      id, workspaceId, title, roleId, workspacePath,
    } = {}) {
      const now = Date.now();
      const conv = {
        id: id || randomUUID(),
        workspaceId: workspaceId ?? null,
        title: title || 'New conversation',
        updatedAt: now,
        createdAt: now,
        roleId: roleId ?? null,
        workspacePath: workspacePath ?? null,
        lastProgressAt: now,
        originalText: null,
        usage: null,
        harnessId: null,
      };
      q.insConv.run(
        conv.id, conv.workspaceId, conv.title, null, null, null,
        null, null, conv.updatedAt, conv.createdAt,
        conv.roleId, conv.workspacePath, conv.lastProgressAt, conv.originalText,
        usageToSql(conv.usage), conv.harnessId, null, null,
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
          roleId: null,
          workspacePath: null,
          lastProgressAt: now,
          originalText: null,
          usage: null,
          harnessId: null,
        };
        q.insConv.run(
          conv.id, conv.workspaceId, conv.title, null, null, null,
          null, null, conv.updatedAt, conv.createdAt,
          conv.roleId, conv.workspacePath, conv.lastProgressAt, conv.originalText,
          usageToSql(conv.usage), null, null, patch.lastSubmissionId ?? null,
        );
      }
      const next = { ...conv, ...patch, updatedAt: Date.now() };
      q.updConv.run(
        next.workspaceId, next.title, next.updatedAt, next.roleId,
        next.workspacePath, next.lastProgressAt, next.originalText, usageToSql(next.usage),
        next.harnessId ?? null, next.lastSubmissionId ?? null, id,
      );
      return next;
    },

    async createRole(role) {
      q.insRole.run(...roleParams(role));
      return roleFromRow(q.getRole.get(role.id));
    },
    async updateRole(id, role) {
      if (!q.getRole.get(id)) return undefined;
      q.insRole.run(...roleParams({ ...role, id }));
      return roleFromRow(q.getRole.get(id));
    },
    async deleteRole(id) {
      q.delRole.run(id);
      return !q.getRole.get(id);
    },
    async listRoles() {
      return q.listRoles.all().map(roleFromRow);
    },
    async getRole(id) {
      return roleFromRow(q.getRole.get(id));
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
    async countConversationsReferencing({ roleId } = {}) {
      if (roleId) return Number(q.countRoleRefs.get(roleId)?.n || 0);
      return 0;
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
