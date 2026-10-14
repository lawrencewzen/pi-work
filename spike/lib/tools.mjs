import { spawn } from 'node:child_process';
import { Type } from '@earendil-works/pi-ai';
import { defineTool } from '@earendil-works/pi-durable';
import { bash, edit, grep, ls, read, write } from '../../src/tools/workspace.mjs';

const OUTPUT_CAP = 1024 * 1024;

function asText(output) {
  return typeof output === 'string' ? output : JSON.stringify(output);
}

/**
 * Windows has no `/bin/sh`. The existing bash tool hardcodes that path, so the
 * spike keeps the same cwd and env allow-list and launches `cmd.exe` instead.
 * Unix keeps calling the existing tool.
 */
function bashWindows({ command, timeout }, workspacePath, signal) {
  const limit = timeout ?? 60_000;
  const env = {
    PATH: process.env.PATH || '',
    SYSTEMROOT: process.env.SYSTEMROOT || '',
    COMSPEC: process.env.ComSpec || 'cmd.exe',
    PATHEXT: process.env.PATHEXT || '',
    LANG: 'C.UTF-8',
  };
  const comspec = env.COMSPEC || 'cmd.exe';
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
    let settled = false;
    const take = (buf) => {
      const text = String(buf);
      if (combined >= OUTPUT_CAP) return '';
      const room = OUTPUT_CAP - combined;
      if (text.length > room) {
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
      if (err) reject(err);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      const err = new Error('bash timeout');
      err.code = 'ETIMEDOUT';
      finish(null, err);
    }, limit);
    const onAbort = () => {
      child.kill();
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
    status: 'completed',
  }));
}

async function runWorkspace(name, args, workspacePath, signal) {
  if (name === 'bash' && process.platform === 'win32') {
    return bashWindows(args, workspacePath, signal);
  }
  const fns = { read, write, edit, ls, grep, bash };
  return fns[name](args, { workspacePath, signal });
}

function workspaceTool({ name, description, parameters, replay = 'unsafe' }) {
  return defineTool({
    name,
    description,
    parameters,
    replay,
    execute: async (args, api, context) => {
      const agent = await api.agent(context);
      const workspacePath = agent.cwd;
      if (!workspacePath) {
        return { content: [{ type: 'text', text: 'E_SANDBOX: conversation cwd is not set' }], isError: true };
      }
      try {
        const result = await runWorkspace(name, args, workspacePath, context.abortSignal);
        return { content: [{ type: 'text', text: asText(result.output) }] };
      } catch (err) {
        const code = err?.code || 'E_TOOL';
        return { content: [{ type: 'text', text: `${code}: ${err?.message || err}` }], isError: true };
      }
    },
  });
}

export function createWorkspaceTools() {
  return [
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
    }),
    workspaceTool({
      name: 'edit',
      description: 'Replace the first occurrence of old text in a workspace file.',
      parameters: Type.Object({ path: Type.String(), old: Type.String(), new: Type.String() }),
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
      description: 'Run a shell command with its working directory set to this conversation\'s workspace.',
      parameters: Type.Object({
        command: Type.String(),
        timeout: Type.Optional(Type.Number()),
      }),
    }),
  ];
}
