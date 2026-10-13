import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveInWorkspace } from '../core/paths.mjs';
import { diffStats } from '../core/diff.mjs';

function toolError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

async function readText(abs) {
  try {
    return await fs.readFile(abs, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

function stringifyOutput(output) {
  return typeof output === 'string' ? output : JSON.stringify(output);
}

export async function executeTool(name, args = {}, ctx = {}) {
  const { store, toolCallId, workspacePath, signal, conversationId, timeout } = ctx;
  if (store && toolCallId) {
    const prev = await store.getToolCall(toolCallId);
    if (prev?.status === 'completed') {
      return {
        name: prev.name || name,
        path: prev.path,
        added: prev.added,
        removed: prev.removed,
        output: prev.output,
        status: 'completed',
        duplicate: true,
      };
    }
    if (name === 'bash' && prev?.status === 'started') {
      const output = prev.output ?? { interrupted: true, message: 'bash was interrupted; not re-run' };
      await store.upsertToolCall({
        id: toolCallId,
        conversationId,
        name: 'bash',
        status: 'completed',
        output,
      });
      return { name: 'bash', output, status: 'completed', duplicate: true, interrupted: true };
    }
  }

  const fns = { read, write, edit, ls, grep, bash };
  const fn = fns[name];
  if (!fn) throw toolError('E_UNKNOWN_TOOL', `unknown tool: ${name}`);

  if (name === 'bash' && store && toolCallId) {
    await store.upsertToolCall({
      id: toolCallId,
      conversationId,
      name: 'bash',
      status: 'started',
      input: args,
    });
  }

  const result = await fn(args, { workspacePath, signal, timeout, store, toolCallId, conversationId });

  if (store && toolCallId) {
    await store.upsertToolCall({
      id: toolCallId,
      conversationId,
      name,
      status: result.status || 'completed',
      input: args,
      output: result.output,
      path: result.path,
      added: result.added,
      removed: result.removed,
    });
    if ((name === 'write' || name === 'edit') && result.path != null) {
      await store.addChange({
        conversationId,
        path: result.path,
        before: result.before ?? '',
        after: result.after ?? '',
        added: result.added ?? 0,
        removed: result.removed ?? 0,
        toolCallId,
      });
    }
  }
  return result;
}

export async function read({ path: rel } = {}, { workspacePath } = {}) {
  const abs = await resolveInWorkspace(workspacePath, rel);
  const content = await fs.readFile(abs, 'utf8');
  return { name: 'read', path: rel, output: content, status: 'completed' };
}

export async function write({ path: rel, content = '' } = {}, { workspacePath } = {}) {
  const abs = await resolveInWorkspace(workspacePath, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const before = await readText(abs);
  await fs.writeFile(abs, content, 'utf8');
  const { added, removed } = diffStats(before, content);
  return {
    name: 'write',
    path: rel,
    before: before ?? '',
    after: content,
    added,
    removed,
    output: `wrote ${rel} (+${added} −${removed})`,
    status: 'completed',
  };
}

export async function edit({ path: rel, old: oldText, new: newText } = {}, { workspacePath } = {}) {
  const abs = await resolveInWorkspace(workspacePath, rel);
  const before = await fs.readFile(abs, 'utf8');
  if (!String(before).includes(oldText)) {
    throw toolError('E_EDIT', `old text not found in ${rel}`);
  }
  const after = String(before).replace(oldText, newText);
  await fs.writeFile(abs, after, 'utf8');
  const { added, removed } = diffStats(before, after);
  return {
    name: 'edit',
    path: rel,
    before,
    after,
    added,
    removed,
    output: `edited ${rel} (+${added} −${removed})`,
    status: 'completed',
  };
}

export async function ls({ path: rel = '.' } = {}, { workspacePath } = {}) {
  const abs = await resolveInWorkspace(workspacePath, rel);
  const st = await fs.stat(abs);
  if (!st.isDirectory()) {
    return { name: 'ls', path: rel, output: path.basename(abs), status: 'completed' };
  }
  const entries = await fs.readdir(abs, { withFileTypes: true });
  const lines = entries
    .map((e) => `${e.isDirectory() ? 'd' : 'f'} ${e.name}`)
    .join('\n');
  return { name: 'ls', path: rel, output: lines, status: 'completed' };
}

async function walkFiles(dir, rootReal, acc) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walkFiles(full, rootReal, acc);
    else if (e.isFile()) acc.push(full);
  }
}

function matchGlob(file, glob) {
  if (!glob) return true;
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '::DS::').replace(/\*/g, '[^/]*').replace(/::DS::/g, '.*');
  return new RegExp(`^${escaped}$`).test(file) || new RegExp(`${escaped}$`).test(file);
}

export async function grep({ pattern, path: rel = '.', glob } = {}, { workspacePath } = {}) {
  const abs = await resolveInWorkspace(workspacePath, rel);
  const rootReal = await fs.realpath(workspacePath);
  const files = [];
  const st = await fs.stat(abs);
  if (st.isFile()) files.push(abs);
  else await walkFiles(abs, rootReal, files);
  let re;
  try {
    re = new RegExp(pattern);
  } catch {
    re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  }
  const hits = [];
  for (const file of files) {
    const relFile = path.relative(rootReal, file).replaceAll('\\', '/');
    if (glob && !matchGlob(relFile, glob) && !matchGlob(path.basename(file), glob)) continue;
    let text;
    try { text = await fs.readFile(file, 'utf8'); } catch { continue; }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) hits.push(`${relFile}:${i + 1}:${lines[i]}`);
    }
  }
  return { name: 'grep', path: rel, output: hits.join('\n'), status: 'completed' };
}

export async function bash({ command, timeout: timeoutMs } = {}, { workspacePath, signal, timeout } = {}) {
  const cwd = workspacePath;
  const limit = timeoutMs ?? timeout ?? 60_000;
  const output = await new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', command], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (value, err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (err) reject(err);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      const err = new Error('bash timeout');
      err.code = 'ETIMEDOUT';
      finish(null, err);
    }, limit);
    const onAbort = () => {
      child.kill('SIGKILL');
      const err = new Error('aborted');
      err.code = 'E_ABORTED';
      err.name = 'AbortError';
      finish(null, err);
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (b) => { stdout += b; });
    child.stderr.on('data', (b) => { stderr += b; });
    child.on('error', (err) => finish(null, err));
    child.on('close', (code) => finish({ stdout, stderr, code }));
  });
  return {
    name: 'bash',
    output: stringifyOutput(output),
    stdout: output.stdout,
    stderr: output.stderr,
    code: output.code,
    status: 'completed',
  };
}
