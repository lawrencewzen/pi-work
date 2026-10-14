// Workspace tools for the Pi Durable kernel.
// The Harness schedules tool tasks. This module only registers the six existing
// workspace tools, locks cwd to the conversation workspace, and lets the host
// record a diff after a successful write. It does not schedule, retry, or checkpoint.
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { Type } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { defineExtension, defineTool, hook, ToolTask } from '@earendil-works/pi-durable';
import { diffStats } from '../core/diff.mjs';
import { bash, edit, grep, ls, read, write } from '../tools/workspace.mjs';

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
    const child = spawn(comspec, ['/d', '/s', '/c', command], {
      cwd: workspacePath,
      env,
      windowsHide: true,
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

function modelTurns(turns) {
  return (Array.isArray(turns) ? turns : []).filter((turn) => (
    turn && (turn.tool || turn.text != null || turn.end)
  ));
}

/**
 * One faux reply chosen by how many assistant messages are already committed.
 * A restarted process sees the same transcript, so it does not repeat an earlier tool call.
 */
export function fauxTurnFromScript(turns, context) {
  const pending = modelTurns(turns);
  const used = (context?.messages || []).filter((message) => message?.role === 'assistant').length;
  const turn = pending[used];
  if (!turn) return fauxAssistantMessage('ok');
  if (turn.tool) {
    const args = turn.args && typeof turn.args === 'object' ? turn.args : {};
    const id = turn.id ? { id: String(turn.id) } : {};
    return fauxAssistantMessage(
      [fauxToolCall(String(turn.tool), args, id)],
      { stopReason: 'toolUse' },
    );
  }
  if (turn.end) return fauxAssistantMessage('');
  return fauxAssistantMessage(String(turn.text));
}

/** Explicit demo script only. PI_WORK_FAUX_TOOL_LOG records the offered tool names for tests. */
export function scriptedDemoStep(scriptPath, env = process.env) {
  const script = JSON.parse(readFileSync(scriptPath, 'utf8'));
  const turns = modelTurns(script?.turns);
  const logPath = String(env.PI_WORK_FAUX_TOOL_LOG || '').trim();
  return (context) => {
    if (logPath) appendFileSync(logPath, `${JSON.stringify(offeredToolNames(context))}\n`);
    return fauxTurnFromScript(turns, context);
  };
}
