import { randomUUID } from 'node:crypto';
import { DEFAULT_SETTINGS, mergeSettings, normalizeSettings } from '../core/settings.mjs';

function clone(v) {
  return v == null ? v : JSON.parse(JSON.stringify(v));
}

function shapeWorkspace({ id, name, path, source, gitUrl, branch, rootPath, worktrees } = {}) {
  return {
    id: id || randomUUID(),
    name,
    path,
    source: source || (gitUrl ? 'git' : 'local'),
    gitUrl: gitUrl ?? null,
    branch: branch ?? null,
    rootPath: rootPath || path,
    // TODO: git worktrees are not implemented yet; reserved for future `git worktree add`.
    worktrees: Array.isArray(worktrees) ? worktrees : [],
  };
}

const DEFAULT_ROLE = {
  id: 'default',
  name: 'Default',
  systemPrompt: 'You are a helpful coding assistant. Use tools to work in the workspace.',
  tools: ['read', 'write', 'edit', 'ls', 'grep', 'bash'],
};

export function createMemoryStore() {
  const workspaces = new Map();
  const conversations = new Map();
  const messages = new Map();
  const toolCalls = new Map();
  const changes = new Map();
  const events = new Map();
  const eventSeq = new Map();
  const roles = new Map([[DEFAULT_ROLE.id, { ...DEFAULT_ROLE }]]);
  const pipelines = new Map();
  let settings = normalizeSettings(DEFAULT_SETTINGS);

  const convMsgs = (cid) => {
    if (!messages.has(cid)) messages.set(cid, []);
    return messages.get(cid);
  };

  return {
    async createWorkspace(input = {}) {
      const ws = shapeWorkspace(input);
      workspaces.set(ws.id, ws);
      return clone(ws);
    },
    async listWorkspaces() {
      return [...workspaces.values()].map(clone);
    },
    async getWorkspace(id) {
      return clone(workspaces.get(id));
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
      };
      conversations.set(conv.id, conv);
      convMsgs(conv.id);
      changes.set(conv.id, []);
      events.set(conv.id, []);
      eventSeq.set(conv.id, 0);
      return clone(conv);
    },
    async getConversation(id) {
      return clone(conversations.get(id));
    },
    async listConversations(workspaceId, { q } = {}) {
      let list = [...conversations.values()].filter((c) => c.workspaceId === workspaceId);
      if (q) {
        const n = String(q).toLowerCase();
        list = list.filter((c) => (c.title || '').toLowerCase().includes(n));
      }
      list.sort((a, b) => b.updatedAt - a.updatedAt);
      return list.map(clone);
    },
    async listRecoverable() {
      return [...conversations.values()]
        .filter((c) => c.status === 'running' || c.status === 'recovering')
        .map(clone);
    },
    async updateConversation(id, patch = {}) {
      let conv = conversations.get(id);
      if (!conv) {
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
          updatedAt: Date.now(),
          createdAt: Date.now(),
          roleId: null,
          pipelineId: null,
          workspacePath: null,
          lastProgressAt: Date.now(),
          originalText: null,
        };
        conversations.set(id, conv);
        convMsgs(id);
        changes.set(id, []);
        events.set(id, []);
        eventSeq.set(id, 0);
      }
      Object.assign(conv, patch, { updatedAt: Date.now() });
      return clone(conv);
    },

    async addMessage(cid, msg) {
      const list = convMsgs(cid);
      const row = { id: msg.id || randomUUID(), ...msg };
      if (list.some((m) => m.id === row.id)) return clone(list.find((m) => m.id === row.id));
      list.push(row);
      const conv = conversations.get(cid);
      if (conv) conv.updatedAt = Date.now();
      return clone(row);
    },
    async getMessages(cid) {
      return clone(convMsgs(cid));
    },
    async updateMessage(cid, mid, patch = {}) {
      const list = convMsgs(cid);
      const m = list.find((x) => x.id === mid);
      if (!m) return undefined;
      Object.assign(m, patch);
      if (patch.tool && m.tool) m.tool = { ...m.tool, ...patch.tool };
      return clone(m);
    },

    async getToolCall(toolCallId) {
      return clone(toolCalls.get(toolCallId));
    },
    async upsertToolCall(row) {
      const prev = toolCalls.get(row.id) || {};
      const next = { ...prev, ...row };
      toolCalls.set(row.id, next);
      return clone(next);
    },

    async addChange({ conversationId, path, before, after, added, removed, toolCallId }) {
      if (!changes.has(conversationId)) changes.set(conversationId, []);
      const row = { path, before, after, added, removed, toolCallId };
      changes.get(conversationId).push(row);
      return clone(row);
    },
    async getChanges(cid) {
      const list = changes.get(cid) || [];
      const byPath = new Map();
      for (const ch of list) {
        const prev = byPath.get(ch.path);
        if (!prev) {
          byPath.set(ch.path, { ...ch });
        } else {
          prev.after = ch.after;
          prev.added = ch.added;
          prev.removed = ch.removed;
          prev.toolCallId = ch.toolCallId;
        }
      }
      return [...byPath.values()].map(({ path, added, removed, toolCallId }) => ({ path, added, removed, toolCallId }));
    },
    async getChangeForPath(cid, filePath) {
      const list = changes.get(cid) || [];
      const of = list.filter((c) => c.path === filePath);
      if (!of.length) return undefined;
      const first = of[0];
      const last = of[of.length - 1];
      return clone({
        path: filePath,
        before: first.before,
        after: last.after,
        added: last.added,
        removed: last.removed,
        toolCallId: last.toolCallId,
      });
    },

    async appendEvent(cid, { event, data } = {}) {
      const next = (eventSeq.get(cid) || 0) + 1;
      eventSeq.set(cid, next);
      if (!events.has(cid)) events.set(cid, []);
      const row = { id: next, event, data };
      events.get(cid).push(row);
      return clone(row);
    },
    async getEvents(cid, { afterId = 0 } = {}) {
      return (events.get(cid) || []).filter((e) => e.id > afterId).map(clone);
    },

    async createRole(role) {
      roles.set(role.id, { ...role });
      return clone(role);
    },
    async listRoles() {
      return [...roles.values()].map(clone);
    },
    async getRole(id) {
      return clone(roles.get(id));
    },

    async createPipeline(pipeline) {
      pipelines.set(pipeline.id, { ...pipeline });
      return clone(pipeline);
    },
    async listPipelines() {
      return [...pipelines.values()].map(clone);
    },
    async getPipeline(id) {
      return clone(pipelines.get(id));
    },

    async getSettings() {
      return clone(settings);
    },
    async putSettings(patch = {}) {
      settings = mergeSettings(settings, patch);
      return clone(settings);
    },
  };
}
