import { EventEmitter } from 'node:events';
import { createRetryPolicy, decideAutoContinue } from './retry.mjs';
import { executeTool } from '../tools/workspace.mjs';
import { buildAgents, agentEventData, mapConvStatusToAgent } from './agents.mjs';
import { TOOLS as TOOL_REGISTRY } from './config.mjs';

const DEFAULT_TITLE = 'New conversation';

function autoTitleFromText(currentTitle, opts = {}) {
  if (opts.title) return opts.title;
  const cur = currentTitle == null ? '' : String(currentTitle);
  if (cur === '' || cur === DEFAULT_TITLE) return String(opts.text ?? '').slice(0, 48);
  return undefined;
}

function abortError() {
  const err = new Error('aborted');
  err.code = 'E_ABORTED';
  err.name = 'AbortError';
  return err;
}

function isAbort(err) {
  return err?.code === 'E_ABORTED' || err?.name === 'AbortError';
}

async function sleep(ms, signal) {
  if (ms <= 0) return;
  await new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const t = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function stringify(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

export function createOrchestrator({
  llm,
  store,
  tools,
  retry,
  stallMs,
  maxAutoContinues,
} = {}) {
  const retryPolicy = retry || createRetryPolicy({
    maxAttempts: Number(process.env.PI_WORK_RETRY_MAX) || 5,
    baseMs: Number(process.env.PI_WORK_RETRY_BASE_MS) || 200,
    maxMs: 30_000,
  });
  const stall = stallMs ?? (Number(process.env.PI_WORK_STALL_MS) || 120_000);
  const maxAC = maxAutoContinues ?? 10;
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);
  const runtimes = new Map();

  function statusOf(id) {
    const rt = runtimes.get(id);
    if (!rt) return { status: 'idle', autoContinues: 0, retries: 0, currentStep: 0, pipelineStep: 0, lastCheckpointAt: null };
    return {
      status: rt.status,
      autoContinues: rt.autoContinues,
      retries: rt.retries,
      currentStep: rt.currentStep,
      pipelineStep: rt.pipelineStep,
      lastCheckpointAt: rt.lastCheckpointAt,
    };
  }

  function ensureRuntime(id, opts = {}) {
    let rt = runtimes.get(id);
    if (!rt) {
      rt = {
        id,
        status: 'idle',
        autoContinues: 0,
        retries: 0,
        currentStep: 0,
        pipelineStep: 0,
        lastCheckpointAt: null,
        lastProgressAt: Date.now(),
        workspacePath: opts.workspacePath ?? null,
        roleId: opts.roleId ?? null,
        pipelineId: opts.pipelineId ?? null,
        originalText: opts.text ?? null,
        lastAssistantText: '',
        abort: new AbortController(),
        abortReason: null,
        epoch: 0,
        loopActive: false,
        role: null,
        pipeline: null,
      };
      runtimes.set(id, rt);
    }
    if (opts.workspacePath) rt.workspacePath = opts.workspacePath;
    if (opts.roleId) rt.roleId = opts.roleId;
    if (opts.pipelineId) rt.pipelineId = opts.pipelineId;
    if (opts.text && !rt.originalText) rt.originalText = opts.text;
    return rt;
  }

  async function emit(cid, event, data) {
    const row = await store.appendEvent(cid, { event, data });
    const payload = { conversationId: cid, id: row.id, event: row.event, data: row.data };
    emitter.emit('event', payload);
    emitter.emit(`c:${cid}`, row);
    return row;
  }

  async function snapshotAgents(cid, rt) {
    if (rt && !rt.pipeline && rt.pipelineId) {
      rt.pipeline = await store.getPipeline(rt.pipelineId);
    }
    if (rt && !rt.role) {
      const roleId = rt.roleId;
      rt.role = (roleId && await store.getRole(roleId)) || await store.getRole('default') || {
        id: 'default',
        name: 'Default',
        systemPrompt: 'You are a helpful coding assistant.',
        tools: ['read', 'write', 'edit', 'ls', 'grep', 'bash'],
      };
    }
    const conv = (await store.getConversation(cid)) || {};
    const messages = await store.getMessages(cid);
    const roles = await store.listRoles();
    return buildAgents({
      conv: {
        ...conv,
        id: cid,
        status: rt?.status ?? conv.status,
        pipelineStep: rt?.pipelineStep ?? conv.pipelineStep,
        currentStep: rt?.currentStep ?? conv.currentStep,
        roleId: rt?.roleId ?? conv.roleId,
        pipelineId: rt?.pipelineId ?? conv.pipelineId,
      },
      pipeline: rt?.pipeline || (conv.pipelineId && await store.getPipeline(conv.pipelineId)),
      role: rt?.role,
      roles,
      messages,
    });
  }

  async function emitAgent(cid, rt, status) {
    const agents = await snapshotAgents(cid, rt);
    const idx = rt?.pipeline?.steps?.length ? rt.pipelineStep : 0;
    const agent = agents[Math.min(Math.max(0, idx), Math.max(0, agents.length - 1))] || agents[0];
    const data = agentEventData(agent, status || mapConvStatusToAgent(rt?.status));
    if (!data) return null;
    return emit(cid, 'agent', data);
  }

  function markProgress(rt) {
    rt.lastProgressAt = Date.now();
  }

  async function persist(rt, extra = {}) {
    const patch = {
      status: rt.status,
      autoContinues: rt.autoContinues,
      retries: rt.retries,
      lastCheckpointAt: rt.lastCheckpointAt,
      currentStep: rt.currentStep,
      pipelineStep: rt.pipelineStep,
      lastProgressAt: rt.lastProgressAt,
      workspacePath: rt.workspacePath,
      roleId: rt.roleId,
      pipelineId: rt.pipelineId,
      originalText: rt.originalText,
    };
    for (const [k, v] of Object.entries(extra)) {
      if (v !== undefined) patch[k] = v;
    }
    await store.updateConversation(rt.id, patch);
  }

  async function loadRolePipeline(rt) {
    if (rt.pipelineId) {
      rt.pipeline = await store.getPipeline(rt.pipelineId);
    }
    let roleId = rt.roleId;
    if (rt.pipeline?.steps?.length) {
      const step = rt.pipeline.steps[rt.pipelineStep] || rt.pipeline.steps[0];
      roleId = step.role;
      rt.roleId = roleId;
    }
    rt.role = (roleId && await store.getRole(roleId)) || await store.getRole('default') || {
      id: 'default',
      name: 'Default',
      systemPrompt: 'You are a helpful coding assistant.',
      tools: ['read', 'write', 'edit', 'ls', 'grep', 'bash'],
    };
  }

  async function buildMessages(cid, rt) {
    const stored = await store.getMessages(cid);
    const msgs = [];
    if (rt.role?.systemPrompt) msgs.push({ role: 'system', content: rt.role.systemPrompt, text: rt.role.systemPrompt });
    for (const m of stored) {
      if (m.role === 'user') msgs.push({ role: 'user', text: m.text || '', content: m.text || '' });
      else if (m.role === 'assistant') msgs.push({ role: 'assistant', text: m.text || '', content: m.text || '' });
      else if (m.role === 'tool' && m.tool) {
        msgs.push({
          role: 'assistant',
          text: '',
          tool_calls: [{
            id: m.tool.id,
            type: 'function',
            function: { name: m.tool.name, arguments: stringify(m.tool.input || {}) },
          }],
        });
        msgs.push({
          role: 'tool',
          tool_call_id: m.tool.id,
          text: stringify(m.tool.output ?? m.text ?? ''),
          content: stringify(m.tool.output ?? m.text ?? ''),
        });
      }
    }
    return msgs;
  }

  async function callTool(name, args, ctx) {
    if (tools && typeof tools[name] === 'function') return tools[name](args, ctx);
    return executeTool(name, args, ctx);
  }

  async function runLoop(cid, epoch) {
    const rt = runtimes.get(cid);
    if (!rt || rt.epoch !== epoch) return;
    if (rt.status === 'stopped' || rt.status === 'paused') return;
    rt.loopActive = true;
    try {
      await loadRolePipeline(rt);
      let attempt = 1;
      while (rt.epoch === epoch && (rt.status === 'running' || rt.status === 'recovering')) {
        if (rt.abort.signal.aborted && rt.abortReason !== 'stall') break;

        const messages = await buildMessages(cid, rt);
        let action;
        try {
          action = await llm.next({
            conversationId: cid,
            step: rt.currentStep,
            messages,
            signal: rt.abort.signal,
            onProgress: () => markProgress(rt),
            tools: rt.role?.tools,
            model: rt.role?.model,
            roleId: rt.role?.id,
          });
          attempt = 1;
        } catch (err) {
          if (rt.epoch !== epoch) return;
          if (rt.status === 'paused' || rt.status === 'stopped') return;
          if (isAbort(err) || rt.abort.signal.aborted) {
            if (rt.abortReason === 'stall') {
              rt.abort = new AbortController();
              rt.abortReason = null;
              markProgress(rt);
              await persist(rt);
              continue;
            }
            return;
          }
          if (retryPolicy.shouldRetry(err, attempt)) {
            const delayMs = retryPolicy.delayMs(attempt);
            rt.retries += 1;
            rt.autoContinues += 1;
            markProgress(rt);
            await persist(rt);
            await emit(cid, 'retry', { attempt, delayMs, reason: err.code || err.message });
            attempt += 1;
            try {
              await sleep(delayMs, rt.abort.signal);
            } catch (e) {
              if (rt.status === 'paused' || rt.status === 'stopped') return;
              if (rt.abortReason === 'stall') {
                rt.abort = new AbortController();
                rt.abortReason = null;
              }
            }
            continue;
          }
          rt.status = 'failed';
          await persist(rt);
          await emitAgent(cid, rt, 'error');
          await emit(cid, 'error', { code: err.code || 'E_LLM', message: err.message });
          await emit(cid, 'status', { status: 'failed' });
          return;
        }

        if (rt.epoch !== epoch) return;
        if (rt.status === 'paused' || rt.status === 'stopped') return;

        if (action.type === 'end') {
          // Explicit `{end:true}` faux turns consume a step so the next pipeline
          // agent continues the script instead of re-reading the same end turn.
          if (action.consumed) {
            rt.currentStep += 1;
            rt.lastCheckpointAt = Date.now();
            markProgress(rt);
          }
          if (rt.pipeline?.steps && rt.pipelineStep < rt.pipeline.steps.length - 1) {
            await emitAgent(cid, rt, 'done');
            rt.pipelineStep += 1;
            const step = rt.pipeline.steps[rt.pipelineStep];
            const role = await store.getRole(step.role);
            if (role) {
              rt.role = role;
              rt.roleId = role.id;
            }
            const text = step.input === 'previous' ? (rt.lastAssistantText || '') : (rt.originalText || '');
            await store.addMessage(cid, { id: `${cid}:u:p${rt.pipelineStep}`, role: 'user', text });
            await persist(rt);
            await emitAgent(cid, rt, 'running');
            continue;
          }
          await emitAgent(cid, rt, 'done');
          rt.status = 'done';
          await persist(rt);
          await emit(cid, 'status', { status: 'done' });
          return;
        }

        if (action.type === 'text') {
          const mid = `${cid}:a:${rt.currentStep}`;
          await store.addMessage(cid, { id: mid, role: 'assistant', text: action.text });
          await emit(cid, 'message.delta', { messageId: mid, text: action.text });
          await emit(cid, 'message.done', { messageId: mid });
          rt.lastAssistantText = action.text;
          markProgress(rt);
        } else if (action.type === 'tool') {
          const toolCallId = `${cid}:${rt.currentStep}`;
          markProgress(rt);
          await persist(rt);
          const roleAllow = Array.isArray(rt.role?.tools) && rt.role.tools.length
            ? rt.role.tools
            : TOOL_REGISTRY;
          if (!TOOL_REGISTRY.includes(action.name) || !roleAllow.includes(action.name)) {
            const tool = {
              id: toolCallId,
              name: action.name,
              status: 'error',
              input: action.args,
              output: 'E_UNKNOWN_TOOL',
              error: 'E_UNKNOWN_TOOL',
              code: 'E_UNKNOWN_TOOL',
            };
            if (store) {
              await store.upsertToolCall({
                id: toolCallId,
                conversationId: cid,
                name: action.name,
                status: 'completed',
                input: action.args,
                output: 'E_UNKNOWN_TOOL',
              });
            }
            await store.addMessage(cid, {
              id: `tool:${toolCallId}`,
              role: 'tool',
              text: 'E_UNKNOWN_TOOL',
              tool,
            });
            await emit(cid, 'tool.end', { tool });
          } else {
            const existing = await store.getToolCall(toolCallId);
            const already = existing?.status === 'completed';
            if (!already && existing?.status !== 'started') {
              await emit(cid, 'tool.start', {
                tool: { id: toolCallId, name: action.name, input: action.args, status: 'running', path: action.args?.path },
              });
            }
            let result;
            try {
              result = await callTool(action.name, action.args || {}, {
                store,
                toolCallId,
                workspacePath: rt.workspacePath,
                conversationId: cid,
                signal: rt.abort.signal,
              });
            } catch (err) {
              if (isAbort(err) || rt.status === 'paused' || rt.status === 'stopped') return;
              result = {
                name: action.name,
                path: action.args?.path,
                output: err.message,
                status: 'error',
                error: err.message,
                code: err.code,
              };
              if (store) {
                await store.upsertToolCall({
                  id: toolCallId,
                  conversationId: cid,
                  name: action.name,
                  status: 'completed',
                  input: action.args,
                  output: err.message,
                  path: action.args?.path,
                });
              }
            }
            if (!already && !result.duplicate) {
              const tool = {
                id: toolCallId,
                name: action.name,
                path: result.path ?? action.args?.path,
                added: result.added,
                removed: result.removed,
                status: result.status || 'completed',
                input: action.args,
                output: result.output,
              };
              await store.addMessage(cid, {
                id: `tool:${toolCallId}`,
                role: 'tool',
                text: stringify(result.output),
                tool,
              });
              await emit(cid, 'tool.end', { tool });
            }
            markProgress(rt);
          }
        }

        if (rt.status === 'paused' || rt.status === 'stopped') return;
        rt.currentStep += 1;
        rt.lastCheckpointAt = Date.now();
        markProgress(rt);
        await persist(rt);
        await emit(cid, 'checkpoint', { at: rt.lastCheckpointAt, step: rt.currentStep });
      }
    } finally {
      if (rt.epoch === epoch) rt.loopActive = false;
    }
  }

  function kick(cid) {
    const rt = runtimes.get(cid);
    rt.epoch += 1;
    rt.abort = new AbortController();
    rt.abortReason = null;
    const epoch = rt.epoch;
    queueMicrotask(() => {
      void runLoop(cid, epoch).catch((err) => {
        emit(cid, 'error', { code: err.code || 'E_LOOP', message: err.message }).catch(() => {});
      });
    });
  }

  function checkStalls() {
    const now = Date.now();
    for (const rt of runtimes.values()) {
      if (rt.status !== 'running') continue;
      const decision = decideAutoContinue({
        lastProgressAt: rt.lastProgressAt,
        now,
        stallMs: stall,
        status: rt.status,
        autoContinues: rt.autoContinues,
        maxAutoContinues: maxAC,
      });
      if (decision === 'continue') {
        rt.autoContinues += 1;
        rt.abortReason = 'stall';
        markProgress(rt);
        persist(rt).catch(() => {});
        emit(rt.id, 'retry', { attempt: rt.autoContinues, delayMs: 0, reason: 'stall' }).catch(() => {});
        try { rt.abort.abort(); } catch { /* ignore */ }
      } else if (decision === 'give_up') {
        rt.status = 'failed';
        rt.abortReason = 'stop';
        persist(rt).catch(() => {});
        emitAgent(rt.id, rt, 'error').catch(() => {});
        emit(rt.id, 'error', { code: 'E_STALL', message: 'stalled' }).catch(() => {});
        emit(rt.id, 'status', { status: 'failed' }).catch(() => {});
        try { rt.abort.abort(); } catch { /* ignore */ }
      }
    }
  }

  const stallTimer = setInterval(checkStalls, Math.min(250, Math.max(50, stall)));
  stallTimer.unref?.();

  return {
    async start(cid, opts = {}) {
      const rt = ensureRuntime(cid, opts);
      if (rt.status === 'stopped') return { status: 'stopped' };
      rt.status = 'running';
      markProgress(rt);
      const firstPatch = {
        workspacePath: opts.workspacePath ?? rt.workspacePath,
        roleId: opts.roleId ?? rt.roleId,
        pipelineId: opts.pipelineId ?? rt.pipelineId,
      };
      if (opts.title) firstPatch.title = opts.title;
      await persist(rt, firstPatch);
      if (opts.text) {
        if (!rt.originalText) rt.originalText = opts.text;
        await store.addMessage(cid, { id: `${cid}:u:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`, role: 'user', text: opts.text });
        const conv = await store.getConversation(cid);
        const title = autoTitleFromText(conv?.title, opts);
        const extra = { originalText: rt.originalText };
        if (title !== undefined) extra.title = title;
        await persist(rt, extra);
      }
      await loadRolePipeline(rt);
      await emitAgent(cid, rt, 'running');
      await emit(cid, 'status', { status: 'running' });
      kick(cid);
      return { status: 'running' };
    },

    async pause(id) {
      const rt = ensureRuntime(id);
      if (rt.status === 'stopped') return { status: 'stopped' };
      rt.status = 'paused';
      rt.abortReason = 'pause';
      try { rt.abort.abort(); } catch { /* ignore */ }
      await persist(rt);
      await emit(id, 'status', { status: 'paused' });
      return { status: 'paused' };
    },

    async resume(id) {
      const rt = ensureRuntime(id);
      if (rt.status === 'stopped') return { status: 'stopped' };
      if (rt.status !== 'paused' && rt.status !== 'recovering') {
        return { status: rt.status };
      }
      rt.status = 'running';
      markProgress(rt);
      await persist(rt);
      await emit(id, 'status', { status: 'running' });
      kick(id);
      return { status: 'running' };
    },

    async stop(id) {
      const rt = ensureRuntime(id);
      rt.status = 'stopped';
      rt.abortReason = 'stop';
      try { rt.abort.abort(); } catch { /* ignore */ }
      await persist(rt);
      await emitAgent(id, rt, 'stopped');
      await emit(id, 'status', { status: 'stopped' });
      return { status: 'stopped' };
    },

    status: statusOf,

    async recover() {
      const list = await store.listRecoverable();
      for (const conv of list) {
        const rt = ensureRuntime(conv.id, {
          workspacePath: conv.workspacePath,
          roleId: conv.roleId,
          pipelineId: conv.pipelineId,
        });
        rt.status = 'recovering';
        rt.currentStep = conv.currentStep || 0;
        rt.pipelineStep = conv.pipelineStep || 0;
        rt.autoContinues = conv.autoContinues || 0;
        rt.retries = conv.retries || 0;
        rt.lastCheckpointAt = conv.lastCheckpointAt;
        rt.originalText = conv.originalText;
        rt.workspacePath = conv.workspacePath;
        const msgs = await store.getMessages(conv.id);
        const lastA = [...msgs].reverse().find((m) => m.role === 'assistant');
        if (lastA?.text) rt.lastAssistantText = lastA.text;
        markProgress(rt);
        await persist(rt);
        await loadRolePipeline(rt);
        await emitAgent(conv.id, rt, 'running');
        await emit(conv.id, 'status', { status: 'recovering' });
        kick(conv.id);
      }
    },

    on(event, fn) {
      emitter.on(event, fn);
      return () => emitter.off(event, fn);
    },
    subscribe(cid, fn) {
      const ev = `c:${cid}`;
      emitter.on(ev, fn);
      return () => emitter.off(ev, fn);
    },
  };
}
