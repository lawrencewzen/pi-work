import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { DEFAULT_SETTINGS, mergeSettings, normalizeSettings } from '../core/settings.mjs';

const SCHEMA_VERSION = 3;
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
    pipelineStep: row.pipeline_step,
    updatedAt: row.updated_at,
    createdAt: row.created_at,
    roleId: row.role_id,
    pipelineId: row.pipeline_id,
    workspacePath: row.workspace_path,
    lastProgressAt: row.last_progress_at,
    originalText: row.original_text,
    usage: usageFromSql(row.usage_json),
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
      original_text TEXT
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
      model TEXT
    );
    CREATE TABLE IF NOT EXISTS pipelines (
      id TEXT PRIMARY KEY,
      name TEXT,
      steps_json TEXT
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
  }

  {
    const row = db.prepare('SELECT version FROM schema_version LIMIT 1').get();
    if (!row) db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
    else if (row.version < SCHEMA_VERSION) db.prepare('UPDATE schema_version SET version = ?').run(SCHEMA_VERSION);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  const q = {
    insWs: db.prepare('INSERT INTO workspaces (id, name, path, source, git_url, branch, root_path, worktrees_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    listWs: db.prepare('SELECT * FROM workspaces'),
    getWs: db.prepare('SELECT * FROM workspaces WHERE id = ?'),
    getSettings: db.prepare('SELECT json FROM settings WHERE id = ?'),
    putSettings: db.prepare('INSERT INTO settings (id, json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json'),
    insConv: db.prepare(`INSERT INTO conversations (
      id, workspace_id, title, status, auto_continues, retries, last_checkpoint_at,
      current_step, pipeline_step, updated_at, created_at, role_id, pipeline_id,
      workspace_path, last_progress_at, original_text, usage_json
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
    getConv: db.prepare('SELECT * FROM conversations WHERE id = ?'),
    listConv: db.prepare('SELECT * FROM conversations WHERE workspace_id = ? ORDER BY updated_at DESC'),
    listRecoverable: db.prepare("SELECT * FROM conversations WHERE status IN ('running','recovering')"),
    updConv: db.prepare(`UPDATE conversations SET
      workspace_id=?, title=?, status=?, auto_continues=?, retries=?, last_checkpoint_at=?,
      current_step=?, pipeline_step=?, updated_at=?, role_id=?, pipeline_id=?,
      workspace_path=?, last_progress_at=?, original_text=?, usage_json=?
      WHERE id=?`),
    insMsg: db.prepare('INSERT INTO messages (id, conversation_id, role, text, tool_json, seq, meta_json) VALUES (?,?,?,?,?,?,?)'),
    getMsg: db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq ASC, rowid ASC'),
    getMsgById: db.prepare('SELECT * FROM messages WHERE id = ?'),
    maxMsgSeq: db.prepare('SELECT COALESCE(MAX(seq),0) AS m FROM messages WHERE conversation_id = ?'),
    updMsg: db.prepare('UPDATE messages SET role=?, text=?, tool_json=?, meta_json=? WHERE id=?'),
    getTool: db.prepare('SELECT * FROM tool_calls WHERE id = ?'),
    insTool: db.prepare(`INSERT INTO tool_calls (id, conversation_id, name, status, input_json, output_json, path, added, removed, before_hash, after_hash)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        conversation_id=excluded.conversation_id,
        name=COALESCE(excluded.name, tool_calls.name),
        status=COALESCE(excluded.status, tool_calls.status),
        input_json=COALESCE(excluded.input_json, tool_calls.input_json),
        output_json=COALESCE(excluded.output_json, tool_calls.output_json),
        path=COALESCE(excluded.path, tool_calls.path),
        added=COALESCE(excluded.added, tool_calls.added),
        removed=COALESCE(excluded.removed, tool_calls.removed),
        before_hash=COALESCE(excluded.before_hash, tool_calls.before_hash),
        after_hash=COALESCE(excluded.after_hash, tool_calls.after_hash)`),
    insChange: db.prepare('INSERT INTO changes (conversation_id, path, before_text, after_text, added, removed, tool_call_id) VALUES (?,?,?,?,?,?,?)'),
    listChanges: db.prepare('SELECT * FROM changes WHERE conversation_id = ? ORDER BY id ASC'),
    maxEvent: db.prepare('SELECT COALESCE(MAX(event_id),0) AS m FROM events WHERE conversation_id = ?'),
    insEvent: db.prepare('INSERT INTO events (conversation_id, event_id, event, data_json) VALUES (?,?,?,?)'),
    listEvents: db.prepare('SELECT * FROM events WHERE conversation_id = ? AND event_id > ? ORDER BY event_id ASC'),
    insRole: db.prepare('INSERT OR REPLACE INTO roles (id, name, system_prompt, tools_json, model) VALUES (?,?,?,?,?)'),
    listRoles: db.prepare('SELECT * FROM roles'),
    getRole: db.prepare('SELECT * FROM roles WHERE id = ?'),
    insPipe: db.prepare('INSERT OR REPLACE INTO pipelines (id, name, steps_json) VALUES (?,?,?)'),
    listPipes: db.prepare('SELECT * FROM pipelines'),
    getPipe: db.prepare('SELECT * FROM pipelines WHERE id = ?'),
  };

  if (!q.getRole.get(DEFAULT_ROLE.id)) {
    q.insRole.run(DEFAULT_ROLE.id, DEFAULT_ROLE.name, DEFAULT_ROLE.systemPrompt, j(DEFAULT_ROLE.tools), null);
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

  function roleFromRow(row) {
    if (!row) return undefined;
    const r = { id: row.id, name: row.name, systemPrompt: row.system_prompt, tools: p(row.tools_json) || [] };
    if (row.model) r.model = row.model;
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

    async createConversation({
      id, workspaceId, title, roleId, pipelineId, workspacePath, status = 'idle',
    } = {}) {
      const now = Date.now();
      const conv = {
        id: id || randomUUID(),
        workspaceId: workspaceId ?? null,
        title: title || 'New conversation',
        status,
        autoContinues: 0,
        retries: 0,
        lastCheckpointAt: null,
        currentStep: 0,
        pipelineStep: 0,
        updatedAt: now,
        createdAt: now,
        roleId: roleId ?? null,
        pipelineId: pipelineId ?? null,
        workspacePath: workspacePath ?? null,
        lastProgressAt: now,
        originalText: null,
        usage: null,
      };
      q.insConv.run(
        conv.id, conv.workspaceId, conv.title, conv.status, conv.autoContinues, conv.retries,
        conv.lastCheckpointAt, conv.currentStep, conv.pipelineStep, conv.updatedAt, conv.createdAt,
        conv.roleId, conv.pipelineId, conv.workspacePath, conv.lastProgressAt, conv.originalText,
        usageToSql(conv.usage),
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
    async updateConversation(id, patch = {}) {
      let conv = convFromRow(q.getConv.get(id));
      if (!conv) {
        const now = Date.now();
        conv = {
          id,
          workspaceId: null,
          title: 'New conversation',
          status: 'idle',
          autoContinues: 0,
          retries: 0,
          lastCheckpointAt: null,
          currentStep: 0,
          pipelineStep: 0,
          updatedAt: now,
          createdAt: now,
          roleId: null,
          pipelineId: null,
          workspacePath: null,
          lastProgressAt: now,
          originalText: null,
          usage: null,
        };
        q.insConv.run(
          conv.id, conv.workspaceId, conv.title, conv.status, conv.autoContinues, conv.retries,
          conv.lastCheckpointAt, conv.currentStep, conv.pipelineStep, conv.updatedAt, conv.createdAt,
          conv.roleId, conv.pipelineId, conv.workspacePath, conv.lastProgressAt, conv.originalText,
          usageToSql(conv.usage),
        );
      }
      const next = { ...conv, ...patch, updatedAt: Date.now() };
      q.updConv.run(
        next.workspaceId, next.title, next.status, next.autoContinues, next.retries, next.lastCheckpointAt,
        next.currentStep, next.pipelineStep, next.updatedAt, next.roleId, next.pipelineId,
        next.workspacePath, next.lastProgressAt, next.originalText, usageToSql(next.usage), id,
      );
      return next;
    },

    async addMessage(cid, msg) {
      const existing = msg.id ? q.getMsgById.get(msg.id) : undefined;
      if (existing) return msgFromRow(existing);
      const seq = (q.maxMsgSeq.get(cid)?.m || 0) + 1;
      const row = { id: msg.id || randomUUID(), role: msg.role, text: msg.text ?? null, tool: msg.tool ?? null };
      const meta = metaFromMsg(msg);
      q.insMsg.run(row.id, cid, row.role, row.text, row.tool ? j(row.tool) : null, seq, meta ? j(meta) : null);
      return msgFromRow({
        id: row.id,
        role: row.role,
        text: row.text,
        tool_json: row.tool ? j(row.tool) : null,
        meta_json: meta ? j(meta) : null,
      });
    },
    async getMessages(cid) {
      return q.getMsg.all(cid).map(msgFromRow);
    },
    async updateMessage(cid, mid, patch = {}) {
      const row = q.getMsgById.get(mid);
      if (!row) return undefined;
      const cur = msgFromRow(row);
      const tool = patch.tool ? { ...(cur.tool || {}), ...patch.tool } : cur.tool;
      const role = patch.role ?? cur.role;
      const text = patch.text !== undefined ? patch.text : cur.text;
      const meta = metaFromMsg(patch, p(row.meta_json));
      q.updMsg.run(role, text ?? null, tool ? j(tool) : null, meta ? j(meta) : null, mid);
      const out = { id: mid, role, text, ...(tool ? { tool } : {}) };
      applyMeta(out, meta);
      return out;
    },

    async getToolCall(toolCallId) {
      return toolFromRow(q.getTool.get(toolCallId));
    },
    async upsertToolCall(row) {
      const prev = toolFromRow(q.getTool.get(row.id)) || {};
      const next = { ...prev, ...row };
      q.insTool.run(
        next.id,
        next.conversationId ?? prev.conversationId ?? null,
        next.name ?? null,
        next.status ?? null,
        next.input !== undefined ? j(next.input) : (prev.input !== undefined ? j(prev.input) : null),
        next.output !== undefined ? j(next.output) : (prev.output !== undefined ? j(prev.output) : null),
        next.path ?? prev.path ?? null,
        next.added ?? prev.added ?? null,
        next.removed ?? prev.removed ?? null,
        next.beforeHash ?? prev.beforeHash ?? null,
        next.afterHash ?? prev.afterHash ?? null,
      );
      return toolFromRow(q.getTool.get(row.id));
    },

    async addChange({ conversationId, path: filePath, before, after, added, removed, toolCallId }) {
      q.insChange.run(conversationId, filePath, before ?? null, after ?? null, added ?? 0, removed ?? 0, toolCallId ?? null);
      return { path: filePath, before, after, added, removed, toolCallId };
    },
    async getChanges(cid) {
      const list = q.listChanges.all(cid);
      const byPath = new Map();
      for (const r of list) {
        const ch = {
          path: r.path,
          before: r.before_text,
          after: r.after_text,
          added: r.added,
          removed: r.removed,
          toolCallId: r.tool_call_id,
        };
        const prev = byPath.get(ch.path);
        if (!prev) byPath.set(ch.path, ch);
        else {
          prev.after = ch.after;
          prev.added = ch.added;
          prev.removed = ch.removed;
          prev.toolCallId = ch.toolCallId;
        }
      }
      return [...byPath.values()].map(({ path: pth, added, removed, toolCallId }) => ({ path: pth, added, removed, toolCallId }));
    },
    async getChangeForPath(cid, filePath) {
      const list = q.listChanges.all(cid).filter((r) => r.path === filePath);
      if (!list.length) return undefined;
      const first = list[0];
      const last = list[list.length - 1];
      return {
        path: filePath,
        before: first.before_text,
        after: last.after_text,
        added: last.added,
        removed: last.removed,
        toolCallId: last.tool_call_id,
      };
    },

    async appendEvent(cid, { event, data } = {}) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const next = (q.maxEvent.get(cid)?.m || 0) + 1;
        q.insEvent.run(cid, next, event, j(data));
        db.exec('COMMIT');
        return { id: next, event, data };
      } catch (err) {
        try { db.exec('ROLLBACK'); } catch { /* ignore */ }
        throw err;
      }
    },
    async getEvents(cid, { afterId = 0 } = {}) {
      return q.listEvents.all(cid, afterId).map((r) => ({
        id: r.event_id,
        event: r.event,
        data: p(r.data_json),
      }));
    },

    async createRole(role) {
      q.insRole.run(role.id, role.name, role.systemPrompt, j(role.tools), role.model ?? null);
      return role;
    },
    async listRoles() {
      return q.listRoles.all().map(roleFromRow);
    },
    async getRole(id) {
      return roleFromRow(q.getRole.get(id));
    },

    async createPipeline(pipeline) {
      q.insPipe.run(pipeline.id, pipeline.name, j(pipeline.steps));
      return pipeline;
    },
    async listPipelines() {
      return q.listPipes.all().map((r) => ({ id: r.id, name: r.name, steps: p(r.steps_json) }));
    },
    async getPipeline(id) {
      const r = q.getPipe.get(id);
      return r ? { id: r.id, name: r.name, steps: p(r.steps_json) } : undefined;
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
