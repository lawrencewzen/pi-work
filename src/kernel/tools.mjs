// Workspace tools for the Pi Durable kernel.
// The Harness schedules tool tasks. This module only registers the six existing
// workspace tools, locks cwd to the conversation workspace, and lets the host
// record a diff after a successful write. It does not schedule, retry, or checkpoint.
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { Type } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { defineExtension, defineTool, hook, ToolTask } from '@earendil-works/pi-durable';
import { diffStats } from '../core/diff.mjs';
import { bash, edit, grep, ls, read, write } from '../tools/workspace.mjs';
import { stampScriptTurn } from './usage.mjs';

const OUTPUT_CAP = 1024 * 1024;
const TRUNCATE_MARKER = '\n[truncated: output exceeded 1 MiB]\n';

const WORKSPACE_TOOL_NAMES = ['read', 'write', 'edit', 'ls', 'grep', 'bash'];

function asText(output) {
  return typeof output === 'string' ? output : JSON.stringify(output);
}

function errorResult(code, message) {
  return {
    content: [{ type: 'text', text: `${code}: ${message}` }],
    isError: true,
  };
}

/**
 * Windows has no /bin/sh. cmd.exe is the interpreter COMSPEC always provides.
 * /d skips AutoRun, /s /c runs one command string and exits. PowerShell can be
 * stopped by execution policy and loads profiles, so it is a worse default.
 * cwd is the conversation workspace. HOME, USERPROFILE, TEMP, and TMP point at
 * that same directory, matching the unix tool's HOME lock. The product bash in
 * src/tools/workspace.mjs is unchanged and still uses /bin/sh.
 *
 * cmd.exe /s strips one leading quote and the last quote of the /c string.
 * Node's default spawn quoting then eats the quotes around an executable path
 * that contains spaces (for example "C:\Program Files\nodejs\node.exe").
 * windowsVerbatimArguments skips that quoting, and the extra quote pair around
 * the whole command is what /s removes, so inner quotes survive.
 */
function bashWindows({ command, timeout }, workspacePath, signal) {
  const limit = timeout ?? 60_000;
  const comspec = process.env.ComSpec || process.env.COMSPEC || 'cmd.exe';
  const env = {
    PATH: process.env.PATH || '',
    SYSTEMROOT: process.env.SYSTEMROOT || process.env.SystemRoot || '',
    COMSPEC: comspec,
    PATHEXT: process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD',
    HOME: workspacePath,
    USERPROFILE: workspacePath,
    TEMP: workspacePath,
    TMP: workspacePath,
    LANG: 'C.UTF-8',
  };
  return new Promise((resolve, reject) => {
    const child = spawn(comspec, ['/d', '/s', '/c', `"${command}"`], {
      cwd: workspacePath,
      env,
      windowsHide: true,
      windowsVerbatimArguments: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let combined = 0;
    let truncated = false;
    let settled = false;
    const take = (buf) => {
      const text = String(buf);
      if (combined >= OUTPUT_CAP) {
        truncated = true;
        return '';
      }
      const room = OUTPUT_CAP - combined;
      if (text.length > room) {
        truncated = true;
        combined = OUTPUT_CAP;
        return text.slice(0, room);
      }
      combined += text.length;
      return text;
    };
    const finish = (value, err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (truncated && value) value.stdout += TRUNCATE_MARKER;
      if (err) reject(err);
      else resolve(value);
    };
    const stop = () => {
      if (!child.pid) return;
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    };
    const timer = setTimeout(() => {
      stop();
      const err = new Error('bash timeout');
      err.code = 'ETIMEDOUT';
      finish(null, err);
    }, limit);
    const onAbort = () => {
      stop();
      const err = new Error('aborted');
      err.code = 'E_ABORTED';
      err.name = 'AbortError';
      finish(null, err);
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (buf) => { stdout += take(buf); });
    child.stderr.on('data', (buf) => { stderr += take(buf); });
    child.on('error', (err) => finish(null, err));
    child.on('close', (code) => finish({ stdout, stderr, code }));
  }).then((output) => ({
    name: 'bash',
    output: asText(output),
    stdout: output.stdout,
    stderr: output.stderr,
    code: output.code,
    status: 'completed',
  }));
}

async function runWorkspace(name, args, workspacePath, signal) {
  if (!workspacePath) {
    const err = new Error('conversation cwd is not set');
    err.code = 'E_SANDBOX';
    throw err;
  }
  if (name === 'bash' && process.platform === 'win32') {
    return bashWindows(args, workspacePath, signal);
  }
  const fns = { read, write, edit, ls, grep, bash };
  return fns[name](args, { workspacePath, signal, timeout: args?.timeout });
}

function workspaceTool({ name, description, parameters, replay = 'unsafe' }) {
  return defineTool({
    name,
    description,
    parameters,
    replay,
    execute: async (args, api, context) => {
      const agent = await api.agent(context);
      const workspacePath = agent?.cwd;
      if (!workspacePath) return errorResult('E_SANDBOX', 'conversation cwd is not set');
      try {
        const result = await runWorkspace(name, args, workspacePath, context.abortSignal);
        const content = [{ type: 'text', text: asText(result.output) }];
        if ((name === 'write' || name === 'edit') && result.path != null && result.status !== 'error') {
          return {
            content,
            details: {
              path: String(result.path),
              before: result.before ?? '',
              after: result.after ?? '',
            },
          };
        }
        return { content };
      } catch (err) {
        return errorResult(err?.code || 'E_TOOL', err?.message || String(err));
      }
    },
  });
}

const workspaceToolList = [
  workspaceTool({
    name: 'read',
    description: 'Read a UTF-8 file inside this conversation\'s workspace.',
    parameters: Type.Object({ path: Type.String() }),
    replay: 'safe',
  }),
  workspaceTool({
    name: 'write',
    description: 'Write a UTF-8 file inside this conversation\'s workspace.',
    parameters: Type.Object({ path: Type.String(), content: Type.String() }),
    replay: 'unsafe',
  }),
  workspaceTool({
    name: 'edit',
    description: 'Replace the first occurrence of old text in a workspace file.',
    parameters: Type.Object({ path: Type.String(), old: Type.String(), new: Type.String() }),
    replay: 'unsafe',
  }),
  workspaceTool({
    name: 'ls',
    description: 'List a directory inside this conversation\'s workspace.',
    parameters: Type.Object({ path: Type.Optional(Type.String()) }),
    replay: 'safe',
  }),
  workspaceTool({
    name: 'grep',
    description: 'Search file contents inside this conversation\'s workspace.',
    parameters: Type.Object({
      pattern: Type.String(),
      path: Type.Optional(Type.String()),
      glob: Type.Optional(Type.String()),
    }),
    replay: 'safe',
  }),
  workspaceTool({
    name: 'bash',
    description: 'Run a shell command with its working directory locked to this conversation\'s workspace.',
    parameters: Type.Object({
      command: Type.String(),
      timeout: Type.Optional(Type.Number()),
    }),
    replay: 'unsafe',
  }),
];

export function workspaceTools() {
  return workspaceToolList;
}

/** Role whitelist. An empty list matches the orchestrator and offers every workspace tool. */
export function toolsForRole(role) {
  const allowed = Array.isArray(role?.tools) && role.tools.length
    ? role.tools
    : WORKSPACE_TOOL_NAMES;
  const byName = new Map(workspaceToolList.map((tool) => [tool.name, tool]));
  return allowed.map((name) => byName.get(name)).filter(Boolean);
}

/**
 * Host hook: after write/edit succeeds, diffStats records the baseline and toolCallId.
 * Details stay off the transcript. Unsafe replay stays the kernel default.
 */
export function createWorkspaceExtension({ onWrote } = {}) {
  return defineExtension({
    name: 'pi-work-workspace',
    tools: workspaceToolList,
    hooks: [
      hook(ToolTask, {
        async afterTool(call, result, api) {
          const details = result?.details;
          const tracked = details
            && !result.isError
            && (call.name === 'write' || call.name === 'edit')
            && typeof details.path === 'string';
          if (!tracked) return undefined;
          const before = details.before ?? '';
          const after = details.after ?? '';
          const { added, removed } = diffStats(before, after);
          if (typeof onWrote === 'function') {
            await onWrote({
              harnessId: api.conversationId,
              toolCallId: call.id,
              path: details.path,
              before,
              after,
              added,
              removed,
            });
          }
          const next = { ...result };
          delete next.details;
          return next;
        },
      }),
    ],
  });
}

/** Tool names offered to the model, from the system entries already in the transcript. */
export function offeredToolNames(context) {
  const names = [];
  for (const message of context?.messages || []) {
    if (!message || message.role !== 'system') continue;
    for (const tool of message.toolsRemoved || []) {
      const index = names.indexOf(tool?.name);
      if (index >= 0) names.splice(index, 1);
    }
    for (const tool of message.toolsAdded || []) {
      if (tool?.name && !names.includes(tool.name)) names.push(tool.name);
    }
  }
  return names;
}

const scriptFloors = new Map();

/**
 * Retries reuse the request cutoff, so the failed assistant is in the transcript
 * but not in the messages the demo script sees. The floor is that transcript count,
 * keyed by the provider session of the conversation that is about to call the model.
 */
export function noteScriptAssistants(sessionId, count) {
  if (!sessionId) return;
  const next = Number(count) || 0;
  const prev = scriptFloors.get(sessionId) || 0;
  if (next > prev) scriptFloors.set(sessionId, next);
}

export function scriptAssistantFloor(sessionId) {
  return scriptFloors.get(sessionId) || 0;
}

function messageText(message) {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  if (typeof message.text === 'string') return message.text;
  if (!Array.isArray(message.content)) return '';
  return message.content.map((part) => {
    if (typeof part === 'string') return part;
    if (typeof part?.text === 'string') return part.text;
    return '';
  }).join('');
}

function lastUserText(context) {
  const messages = context?.messages || [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role !== 'user') continue;
    const text = messageText(message);
    if (text) return text;
  }
  return '';
}

/**
 * Fold standalone `delayMs` onto the next model turn, and turn `cut` into one
 * retryable error. Turns tagged `when` stay in the plan for per-message routing.
 */
export function planScriptTurns(turns) {
  const plan = [];
  let delay = 0;
  for (const turn of Array.isArray(turns) ? turns : []) {
    if (!turn || typeof turn !== 'object') continue;
    const marker = turn.when != null ? String(turn.when) : '';
    const bareDelay = turn.delayMs != null
      && turn.text == null
      && !turn.tool
      && !turn.end
      && !turn.error
      && !turn.cut;
    if (bareDelay) {
      delay += Number(turn.delayMs) || 0;
      continue;
    }
    const next = { ...turn };
    if (marker) next.when = marker;
    else delete next.when;
    if (turn.cut) {
      next.error = next.error || 'terminated';
      delete next.cut;
    }
    const own = Number(turn.delayMs);
    const total = delay + (Number.isFinite(own) ? own : 0);
    if (total > 0) next.delayMs = total;
    else delete next.delayMs;
    delay = 0;
    if (next.tool || next.text != null || next.end || next.error) plan.push(next);
  }
  return plan;
}

/** Turns for this request. `when` matches the latest user text; otherwise untagged turns. */
export function scriptPool(turns, context) {
  const plan = planScriptTurns(turns);
  const last = lastUserText(context);
  const scoped = plan.filter((turn) => turn.when && last.includes(turn.when));
  if (scoped.length) return scoped;
  return plan.filter((turn) => !turn.when);
}

export function scriptAssistantCount(context) {
  return (context?.messages || []).filter((message) => message?.role === 'assistant').length;
}

/**
 * Script index for onYield. Every assistant entry counts, including a tool
 * call with no text. `answer` is the yielding message, which the Harness has
 * not appended yet.
 */
export function scriptMessages(entries, answer) {
  const messages = [];
  for (const entry of entries || []) {
    if (entry?.kind === 'pi.user' || entry?.kind === 'pi.assistant') {
      messages.push({
        role: entry.kind === 'pi.user' ? 'user' : 'assistant',
        content: entry.model?.[0]?.content,
      });
    }
  }
  if (answer && typeof answer === 'object') {
    messages.push({ role: 'assistant', content: answer.content });
  }
  return messages;
}

/**
 * After a narration turn, keep going when the same script still has a tool or
 * a step-ending `end`. A following text turn waits for the next user message.
 */
export function scriptShouldContinue(turns, context) {
  const pool = scriptPool(turns, context);
  const used = scriptAssistantCount(context);
  if (used <= 0 || used >= pool.length) return false;
  const previous = pool[used - 1];
  const next = pool[used];
  if (!previous || previous.end || previous.tool || previous.error) return false;
  if (!next || next.error) return false;
  return Boolean(next.tool || next.end);
}

export function loadScriptTurns(env = process.env) {
  const scriptPath = String(env?.PI_WORK_FAUX_SCRIPT || '').trim();
  if (!scriptPath) return null;
  try {
    const script = JSON.parse(readFileSync(scriptPath, 'utf8'));
    return Array.isArray(script?.turns) ? script.turns : null;
  } catch {
    return null;
  }
}

/**
 * One faux reply chosen by how many assistant messages are already committed.
 * A restarted process sees the same transcript, so it does not repeat an earlier tool call.
 */
export function fauxTurnFromScript(turns, context) {
  const pending = scriptPool(turns, context);
  const used = scriptAssistantCount(context);
  const turn = pending[used];
  if (!turn) return fauxAssistantMessage('ok');
  let message;
  if (turn.error) {
    message = fauxAssistantMessage('', {
      stopReason: 'error',
      errorMessage: String(turn.error),
    });
  } else if (turn.tool) {
    const args = turn.args && typeof turn.args === 'object' ? turn.args : {};
    const id = turn.id ? { id: String(turn.id) } : {};
    message = fauxAssistantMessage(
      [fauxToolCall(String(turn.tool), args, id)],
      { stopReason: 'toolUse' },
    );
  } else if (turn.end) {
    message = fauxAssistantMessage('');
  } else {
    message = fauxAssistantMessage(String(turn.text));
  }
  return stampScriptTurn(message, turn);
}

/** Explicit demo script only. PI_WORK_FAUX_TOOL_LOG records the offered tool names for tests. */
export function scriptedDemoStep(scriptPath, env = process.env, hooks = {}) {
  const script = JSON.parse(readFileSync(scriptPath, 'utf8'));
  const turns = script?.turns;
  const logPath = String(env.PI_WORK_FAUX_TOOL_LOG || '').trim();
  const ready = String(env.PI_WORK_FAUX_HOLD_READY || '').trim();
  return async (context, streamOptions) => {
    if (logPath) appendFileSync(logPath, `${JSON.stringify(offeredToolNames(context))}\n`);
    const have = scriptAssistantCount(context);
    const floor = scriptAssistantFloor(streamOptions?.sessionId);
    const used = Math.max(have, floor);
    let messages = context?.messages;
    if (used > have) {
      messages = [...(messages || [])];
      for (let i = have; i < used; i += 1) messages.push({ role: 'assistant', content: '' });
    }
    const view = messages === context?.messages ? context : { ...context, messages };
    const delay = Number(scriptPool(turns, view)[used]?.delayMs);
    if (Number.isFinite(delay) && delay > 0) {
      if (ready) writeFileSync(ready, 'seen');
      const tick = String(env.PI_WORK_FAUX_DELAY_TICK ?? '1') !== '0';
      const end = Date.now() + delay;
      while (Date.now() < end) {
        if (tick) hooks.tick?.();
        const slice = Math.min(50, end - Date.now());
        if (slice > 0) await new Promise((resolve) => setTimeout(resolve, slice));
      }
    }
    const chosen = scriptPool(turns, view)[used];
    // `{end:true}` finishes a pipeline step. Counting it keeps the next step on
    // the following turn whether or not the empty assistant is stored.
    if (chosen?.end && streamOptions?.sessionId) {
      noteScriptAssistants(streamOptions.sessionId, used + 1);
    }
    return fauxTurnFromScript(turns, view);
  };
}
