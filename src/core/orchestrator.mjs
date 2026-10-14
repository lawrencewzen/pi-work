import { EventEmitter } from 'node:events';
import { createRetryPolicy, decideAutoContinue } from './retry.mjs';
import { executeTool } from '../tools/workspace.mjs';
import { buildAgents, agentEventData, mapConvStatusToAgent } from './agents.mjs';
import { TOOLS as TOOL_REGISTRY } from './config.mjs';
import { normalizeUsage, presentContext } from './usage.mjs';

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

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function stableStringify(value) {
  if (value == null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

export function toolSignature(name, args) {
  return `${String(name || '')}\u0000${stableStringify(args || {})}`;
}

/** Empty tool output is easy for the model to treat as "nothing happened" and call again. */
export function toolResultText(value) {
  const text = stringify(value);
  return text.trim() ? text : '(no output)';
}

function resetToolBudget(rt) {
  rt.toolSig = '';
  rt.toolSigCount = 0;
  rt.toolCallsThisStep = 0;
  rt.loopCorrectedSig = '';
  rt.sawToolResult = false;
}

function droppedStream(err) {
  if (!err) return false;
  if (err.code === 'E_NO_MODEL' || err.code === 'E_ABORTED' || err.code === 'E_SANDBOX') return false;
  if (err.status === 400 || err.status === 401 || err.status === 403) return false;
  if (err.code === 'E_STREAM_CUT' || err.code === 'E_EMPTY_OUTPUT' || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT') return true;
  return /terminated/i.test(String(err.message || ''));
}

function agentRef(cid, rt) {
  const roleId = rt?.role?.id || rt?.roleId || 'default';
  const idx = rt?.pipeline?.steps?.length ? (rt.pipelineStep || 0) : 0;
  return { roleId, agentId: `${cid}:agent:${idx}` };
}

function normalizePluginResult(name, result) {
  if (typeof result === 'string') {
    return { name, output: result.slice(0, 32_000), status: 'completed' };
  }
  const output = result?.output ?? '';
  const text = typeof output === 'string' ? output : JSON.stringify(output ?? '');
  return {
    name,
    output: text.slice(0, 32_000),
    status: result?.status === 'error' ? 'error' : 'completed',
    path: typeof result?.path === 'string' ? result.path : undefined,
    error: result?.error,
    code: result?.code,
  };
}

async function invokePlugin(tool, args, ctx) {
  if (ctx.signal?.aborted) throw abortError();
  let timer;
  const onAbort = () => {
    clearTimeout(timer);
  };
  ctx.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => tool.handler(args || {}, {
        workspacePath: ctx.workspacePath,
        conversationId: ctx.conversationId,
        signal: ctx.signal,
      })),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const err = new Error('plugin tool timed out');
          err.code = 'E_PLUGIN_TIMEOUT';
          reject(err);
        }, 10_000);
        if (ctx.signal?.aborted) {
          clearTimeout(timer);
          reject(abortError());
        }
      }),
    ]);
    return normalizePluginResult(tool.name, result);
  } catch (err) {
    if (isAbort(err) || ctx.signal?.aborted) throw abortError();
    return {
      name: tool.name,
      output: String(err?.message || 'plugin tool failed').slice(0, 32_000),
      status: 'error',
      error: err?.message,
      code: err?.code,
    };
  } finally {
    clearTimeout(timer);
    ctx.signal?.removeEventListener('abort', onAbort);
  }
}

export function createOrchestrator({
  llm,
  store,
  tools,
  retry,
  stallMs,
  maxAutoContinues,
  extensions,
  maxToolCalls,
  toolLoopLimit,
} = {}) {
  const retryPolicy = retry || createRetryPolicy({
    maxAttempts: Number(process.env.PI_WORK_RETRY_MAX) || 5,
    baseMs: Number(process.env.PI_WORK_RETRY_BASE_MS) || 200,
    maxMs: 30_000,
  });
  const stall = stallMs ?? (Number(process.env.PI_WORK_STALL_MS) || 120_000);
  const maxAC = maxAutoContinues ?? 10;
  const toolCap = positiveInt(maxToolCalls ?? process.env.PI_WORK_MAX_TOOL_CALLS, 25);
  const loopLimit = positiveInt(toolLoopLimit ?? process.env.PI_WORK_TOOL_LOOP, 3);
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
      usage: rt.usage || null,
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
        usage: null,
        toolBudgetReady: false,
      };
      resetToolBudget(rt);
      runtimes.set(id, rt);
    }
    if (opts.workspacePath) rt.workspacePath = opts.workspacePath;
    // Explicit null clears a previous role or pipeline. `??` would keep the old value.
    if (Object.prototype.hasOwnProperty.call(opts, 'roleId')) rt.roleId = opts.roleId || null;
    if (Object.prototype.hasOwnProperty.call(opts, 'pipelineId')) {
      const nextPipe = opts.pipelineId || null;
      if (nextPipe !== (rt.pipelineId || null)) {
        rt.pipeline = null;
        rt.pipelineStep = 0;
      }
      rt.pipelineId = nextPipe;
    }
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
    if (rt.usage) patch.usage = rt.usage;
    for (const [k, v] of Object.entries(extra)) {
      if (v !== undefined) patch[k] = v;
    }
    await store.updateConversation(rt.id, patch);
  }

  async function hydrateUsage(rt) {
    if (rt.usage) return;
    const conv = await store.getConversation(rt.id);
    if (conv?.usage) rt.usage = conv.usage;
  }

  async function recordUsage(cid, rt, raw) {
    const usage = normalizeUsage(raw);
    if (!usage) return;
    rt.usage = usage;
    await persist(rt, { usage });
    await emit(cid, 'usage', presentContext(usage));
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

  async function loadExtensions() {
    if (!extensions) return { prompt: '', tools: [] };
    let prompt = '';
    let pluginTools = [];
    try {
      if (typeof extensions.skillPrompt === 'function') {
        prompt = String((await extensions.skillPrompt()) || '');
      }
    } catch (err) {
      console.error(`PI_WORK_EXTENSION ${err?.message || err}`);
    }
    try {
      if (typeof extensions.pluginTools === 'function') {
        const list = await extensions.pluginTools();
        if (Array.isArray(list)) {
          pluginTools = list.filter((tool) => tool && typeof tool.name === 'string' && typeof tool.handler === 'function');
        }
      }
    } catch (err) {
      console.error(`PI_WORK_EXTENSION ${err?.message || err}`);
    }
    return { prompt, tools: pluginTools };
  }

  async function buildMessages(cid, rt, skillPrompt = '') {
    const stored = await store.getMessages(cid);
    const msgs = [];
    const system = [rt.role?.systemPrompt || '', String(skillPrompt || '').trim()].filter(Boolean).join('\n\n');
    if (system) msgs.push({ role: 'system', content: system, text: system });
    for (const m of stored) {
      if (m.role === 'user') msgs.push({ role: 'user', text: m.text || '', content: m.text || '' });
      else if (m.role === 'assistant') msgs.push({ role: 'assistant', text: m.text || '', content: m.text || '' });
      else if (m.role === 'tool') {
        const tool = m.tool || {};
        const id = String(tool.callId || tool.id || String(m.id || '').replace(/^tool:/, '') || `tool-${msgs.length}`);
        const output = toolResultText(tool.output ?? m.text ?? '');
        msgs.push({
          role: 'assistant',
          text: '',
          tool_calls: [{
            id,
            type: 'function',
            function: { name: tool.name || 'tool', arguments: stringify(tool.input || {}) },
          }],
        });
        msgs.push({
          role: 'tool',
          tool_call_id: id,
          text: output,
          content: output,
        });
      }
    }
    return msgs;
  }

  async function callTool(name, args, ctx) {
    if (tools && typeof tools[name] === 'function') return tools[name](args, ctx);
    return executeTool(name, args, ctx);
  }

  async function notePriorTools(cid, rt) {
    if (rt.toolBudgetReady) return;
    rt.toolBudgetReady = true;
    const msgs = await store.getMessages(cid);
    for (let i = msgs.length - 1; i >= 0; i -= 1) {
      const m = msgs[i];
      if (m?.kind === 'handoff') break;
      if (m?.role === 'tool' && m.tool?.status !== 'error') {
        rt.sawToolResult = true;
        break;
      }
    }
  }

  async function advancePipelineOrDone(cid, rt, epoch) {
    if (rt.epoch !== epoch || rt.status === 'paused' || rt.status === 'stopped') return 'stopped';
    if (rt.pipeline?.steps && rt.pipelineStep < rt.pipeline.steps.length - 1) {
      await emitAgent(cid, rt, 'done');
      const fromAgent = rt.role?.id || rt.roleId;
      rt.pipelineStep += 1;
      const step = rt.pipeline.steps[rt.pipelineStep];
      const role = await store.getRole(step.role);
      if (role) {
        rt.role = role;
        rt.roleId = role.id;
      }
      const toAgent = role?.id || step.role;
      const text = step.input === 'previous' ? (rt.lastAssistantText || '') : (rt.originalText || '');
      await store.addMessage(cid, {
        id: `${cid}:u:p${rt.pipelineStep}`,
        role: 'user',
        text,
        kind: 'handoff',
        fromAgent,
        toAgent,
      });
      resetToolBudget(rt);
      rt.toolBudgetReady = true;
      await persist(rt);
      await emitAgent(cid, rt, 'running');
      return 'advanced';
    }
    await emitAgent(cid, rt, 'done');
    rt.status = 'done';
    await persist(rt);
    await emit(cid, 'status', { status: 'done' });
    return 'done';
  }

  async function finishWithNote(cid, rt, epoch, note) {
    if (rt.epoch !== epoch || rt.status === 'paused' || rt.status === 'stopped') return 'stopped';
    const mid = `${cid}:a:${rt.currentStep}`;
    const { agentId, roleId } = agentRef(cid, rt);
    const stored = await store.getMessages(cid);
    const existing = stored.find((m) => m.id === mid);
    const text = existing?.text || note;
    if (!existing) {
      await store.addMessage(cid, {
        id: mid,
        role: 'assistant',
        text: note,
        agentId,
        roleId,
      });
      await emit(cid, 'message.delta', { messageId: mid, text: note, agentId, roleId });
      await emit(cid, 'message.done', { messageId: mid, text: note, agentId, roleId });
    }
    if (!rt.lastAssistantText) rt.lastAssistantText = text;
    rt.currentStep += 1;
    rt.lastCheckpointAt = Date.now();
    markProgress(rt);
    await persist(rt);
    await emit(cid, 'checkpoint', { at: rt.lastCheckpointAt, step: rt.currentStep });
    return advancePipelineOrDone(cid, rt, epoch);
  }

  async function injectCorrection(cid, rt, name) {
    const text = `停止调用工具。你已经用相同参数连续调用「${name}」${loopLimit} 次。请根据已有结果直接回答，不要再调用工具。`;
    const mid = `${cid}:u:loop:${rt.currentStep}:${rt.toolSigCount}`;
    const stored = await store.getMessages(cid);
    if (!stored.some((m) => m.id === mid)) {
      await store.addMessage(cid, {
        id: mid,
        role: 'user',
        text,
        kind: 'correction',
      });
      await emit(cid, 'message.delta', { messageId: mid, text, role: 'user', kind: 'correction' });
      await emit(cid, 'message.done', { messageId: mid, text, role: 'user', kind: 'correction' });
    }
    markProgress(rt);
  }

  async function runLoop(cid, epoch) {
    const rt = runtimes.get(cid);
    if (!rt || rt.epoch !== epoch) return;
    if (rt.status === 'stopped' || rt.status === 'paused') return;
    await hydrateUsage(rt);
    await notePriorTools(cid, rt);
    const loopToken = {};
    rt.loopToken = loopToken;
    rt.loopActive = true;
    try {
      await loadRolePipeline(rt);
      let attempt = 1;
      while (rt.epoch === epoch && (rt.status === 'running' || rt.status === 'recovering')) {
        if (rt.abort.signal.aborted && rt.abortReason !== 'stall') break;

        const assistantId = `${cid}:a:${rt.currentStep}`;
        const toolCallId = `${cid}:${rt.currentStep}`;
        const stored = await store.getMessages(cid);
        if (rt.epoch !== epoch) return;
        const existingAssistant = stored.find((m) => m.id === assistantId);
        if (existingAssistant) {
          if (existingAssistant.text) rt.lastAssistantText = existingAssistant.text;
          rt.currentStep += 1;
          rt.lastCheckpointAt = Date.now();
          markProgress(rt);
          await persist(rt);
          await emit(cid, 'checkpoint', { at: rt.lastCheckpointAt, step: rt.currentStep });
          continue;
        }
        const existingTool = await store.getToolCall(toolCallId);
        if (rt.epoch !== epoch) return;
        if (existingTool?.status === 'completed') {
          rt.currentStep += 1;
          rt.lastCheckpointAt = Date.now();
          markProgress(rt);
          await persist(rt);
          await emit(cid, 'checkpoint', { at: rt.lastCheckpointAt, step: rt.currentStep });
          continue;
        }

        const ext = await loadExtensions();
        const messages = await buildMessages(cid, rt, ext.prompt);
        const roleAllow = Array.isArray(rt.role?.tools) && rt.role.tools.length
          ? rt.role.tools
          : TOOL_REGISTRY;
        const toolNames = [...roleAllow];
        for (const tool of ext.tools) {
          if (!toolNames.includes(tool.name)) toolNames.push(tool.name);
        }
        let action;
        try {
          action = await llm.next({
            conversationId: cid,
            step: rt.currentStep,
            messages,
            signal: rt.abort.signal,
            onProgress: () => markProgress(rt),
            tools: toolNames,
            toolDefs: ext.tools.map((tool) => ({
              type: 'function',
              function: {
                name: tool.name,
                description: tool.description || '',
                parameters: tool.parameters || { type: 'object', properties: {} },
              },
            })),
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
          const dropped = droppedStream(err);
          const canRetry = retryPolicy.shouldRetry(err, attempt)
            || (dropped && retryPolicy.shouldRetry(Object.assign(new Error(err.message || 'terminated'), { code: 'E_STREAM_CUT' }), attempt));
          if (canRetry) {
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
          if (dropped && rt.sawToolResult) {
            const outcome = await finishWithNote(cid, rt, epoch, '模型连接中断。已按完成的工具结果结束本步。');
            if (outcome === 'advanced') {
              attempt = 1;
              continue;
            }
            return;
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

        if (action?.usage) await recordUsage(cid, rt, action.usage);

        if (action.type === 'end') {
          // Explicit `{end:true}` faux turns consume a step so the next pipeline
          // agent continues the script instead of re-reading the same end turn.
          if (action.consumed) {
            rt.currentStep += 1;
            rt.lastCheckpointAt = Date.now();
            markProgress(rt);
          }
          const outcome = await advancePipelineOrDone(cid, rt, epoch);
          if (outcome === 'advanced') continue;
          return;
        }

        if (action.type === 'text') {
          const mid = `${cid}:a:${rt.currentStep}`;
          const { agentId, roleId } = agentRef(cid, rt);
          const saved = await store.addMessage(cid, {
            id: mid,
            role: 'assistant',
            text: action.text,
            agentId,
            roleId,
          });
          const messageId = saved?.id || mid;
          const finalText = saved?.text != null ? saved.text : action.text;
          await emit(cid, 'message.delta', { messageId, text: action.text, agentId, roleId });
          await emit(cid, 'message.done', { messageId, text: finalText, agentId, roleId });
          rt.lastAssistantText = finalText;
          rt.toolSig = '';
          rt.toolSigCount = 0;
          rt.loopCorrectedSig = '';
          markProgress(rt);
        } else if (action.type === 'tool') {
          const sig = toolSignature(action.name, action.args || {});
          if (rt.toolCallsThisStep >= toolCap) {
            const outcome = await finishWithNote(cid, rt, epoch, `本步工具调用已达上限（${toolCap}），已停止继续调用工具。`);
            if (outcome === 'advanced') continue;
            return;
          }
          if (sig === rt.toolSig && rt.toolSigCount >= loopLimit) {
            if (rt.loopCorrectedSig === sig) {
              const outcome = await finishWithNote(cid, rt, epoch, `仍在用相同参数重复调用「${action.name}」，本步已停止。`);
              if (outcome === 'advanced') continue;
              return;
            }
            rt.loopCorrectedSig = sig;
            await injectCorrection(cid, rt, action.name);
            continue;
          }
          const toolCallId = `${cid}:${rt.currentStep}`;
          markProgress(rt);
          await persist(rt);
          const pluginHit = ext.tools.find((tool) => tool.name === action.name);
          const builtinOk = TOOL_REGISTRY.includes(action.name) && roleAllow.includes(action.name);
          if (!pluginHit && !builtinOk) {
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
              const toolCtx = {
                store,
                toolCallId,
                workspacePath: rt.workspacePath,
                conversationId: cid,
                signal: rt.abort.signal,
              };
              result = pluginHit
                ? await invokePlugin(pluginHit, action.args || {}, toolCtx)
                : await callTool(action.name, action.args || {}, toolCtx);
            } catch (err) {
              if (rt.epoch !== epoch || isAbort(err) || rt.status === 'paused' || rt.status === 'stopped') return;
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
                callId: action.callId || toolCallId,
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
                text: toolResultText(result.output),
                tool,
              });
              await emit(cid, 'tool.end', { tool });
              if (tool.status !== 'error') rt.sawToolResult = true;
            } else if (already && existing?.status === 'completed') {
              rt.sawToolResult = true;
            }
            markProgress(rt);
          }
          if (sig === rt.toolSig) rt.toolSigCount += 1;
          else {
            rt.toolSig = sig;
            rt.toolSigCount = 1;
            rt.loopCorrectedSig = '';
          }
          rt.toolCallsThisStep += 1;
        }

        if (rt.epoch !== epoch || rt.status === 'paused' || rt.status === 'stopped') return;
        rt.currentStep += 1;
        rt.lastCheckpointAt = Date.now();
        markProgress(rt);
        await persist(rt);
        await emit(cid, 'checkpoint', { at: rt.lastCheckpointAt, step: rt.currentStep });
      }
    } finally {
      if (rt.loopToken === loopToken) {
        rt.loopActive = false;
        rt.loopToken = null;
      }
    }
  }

  // Drop an in-flight loop before a stopped conversation is started again.
  // Bumping the epoch makes the old loop exit; waiting until it clears
  // loopActive keeps its trailing writes from landing on the new run.
  async function retireActiveLoop(rt) {
    const token = rt.loopToken;
    rt.epoch += 1;
    rt.abortReason = 'stop';
    try { rt.abort.abort(); } catch { /* ignore */ }
    if (!rt.loopActive) return;
    const deadline = Date.now() + 2000;
    while (rt.loopActive && rt.loopToken === token && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
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
      // Stop ends the current run only. A later user message in the same
      // conversation has to be able to start another one.
      if (rt.status === 'stopped') await retireActiveLoop(rt);
      rt.status = 'running';
      resetToolBudget(rt);
      rt.toolBudgetReady = true;
      markProgress(rt);
      const firstPatch = {
        workspacePath: opts.workspacePath ?? rt.workspacePath,
        roleId: rt.roleId,
        pipelineId: rt.pipelineId,
        pipelineStep: rt.pipelineStep,
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
        rt.autoContinues = (conv.autoContinues || 0) + 1;
        rt.retries = conv.retries || 0;
        rt.lastCheckpointAt = conv.lastCheckpointAt;
        rt.originalText = conv.originalText;
        rt.workspacePath = conv.workspacePath;
        rt.usage = conv.usage || rt.usage || null;
        const msgs = await store.getMessages(conv.id);
        const lastA = [...msgs].reverse().find((m) => m.role === 'assistant');
        if (lastA?.text) rt.lastAssistantText = lastA.text;
        markProgress(rt);
        await persist(rt);
        await loadRolePipeline(rt);
        await emitAgent(conv.id, rt, 'running');
        await emit(conv.id, 'status', { status: 'recovering', autoContinues: rt.autoContinues });
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
