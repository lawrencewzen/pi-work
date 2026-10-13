import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveInWorkspace } from '../core/paths.mjs';
import { diffStats } from '../core/diff.mjs';
import { TOOLS as TOOL_REGISTRY } from '../core/config.mjs';

const OUTPUT_CAP = 1024 * 1024;
const TRUNCATE_MARKER = '\n[truncated: output exceeded 1 MiB]\n';
const BASH_INTERRUPTED = 'INTERRUPTED — side effects unknown, check state before retrying';

function toolError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

export function sha256Text(text) {
  return createHash('sha256').update(text ?? '', 'utf8').digest('hex');
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

async function writeAtomic(abs, content) {
  const tmp = `${abs}.tmp.${process.pid}`;
  await fs.mkdir(path.dirname(abs), { recursive: true });
  try {
    await fs.writeFile(tmp, content, 'utf8');
    await fs.rename(tmp, abs);
  } catch (err) {
    try { await fs.unlink(tmp); } catch { /* ignore */ }
    throw err;
  }
}

function killProcessGroup(pid) {
  if (!pid) return;
  try { process.kill(-pid, 'SIGKILL'); } catch { /* ESRCH */ }
}

async function recoverWriteEdit(name, args, prev, ctx) {
  const { store, toolCallId, workspacePath, conversationId } = ctx;
  const input = args && Object.keys(args).length ? args : (prev.input || {});
  const rel = input.path || prev.path;
  const abs = await resolveInWorkspace(workspacePath, rel);
  const current = (await readText(abs)) ?? '';
  const currentHash = sha256Text(current);
  const beforeHash = prev.beforeHash;
  const afterHash = prev.afterHash;

  if (afterHash && currentHash === afterHash) {
    const output = prev.output ?? `${name} ${rel}`;
    await store.upsertToolCall({
      id: toolCallId,
      conversationId,
      name,
      status: 'completed',
      input,
      output,
      path: rel,
      beforeHash,
      afterHash,
    });
    return { name, path: rel, output, status: 'completed' };
  }

  if (beforeHash && currentHash === beforeHash) {
    const fn = name === 'edit' ? edit : write;
    const result = await fn(input, { workspacePath });
    await store.upsertToolCall({
      id: toolCallId,
      conversationId,
      name,
      status: result.status || 'completed',
      input,
      output: result.output,
      path: result.path,
      added: result.added,
      removed: result.removed,
      beforeHash,
      afterHash: afterHash || sha256Text(result.after ?? ''),
    });
    if (result.path != null) {
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
    return result;
  }

  const output = { interrupted: true, conflict: true, note: 'file changed externally' };
  await store.upsertToolCall({
    id: toolCallId,
    conversationId,
    name,
    status: 'completed',
    input,
    output,
    path: rel,
    beforeHash,
    afterHash,
  });
  return { name, path: rel, output, status: 'completed', interrupted: true, conflict: true };
}

async function journalMutatingStart(name, args, ctx) {
  const { store, toolCallId, workspacePath, conversationId } = ctx;
  const rel = args.path;
  const abs = await resolveInWorkspace(workspacePath, rel);
  const before = (await readText(abs)) ?? '';
  const beforeHash = sha256Text(before);
  let afterContent;
  if (name === 'write') {
    afterContent = args.content ?? '';
  } else {
    if (!String(before).includes(args.old)) {
      throw toolError('E_EDIT', `old text not found in ${rel}`);
    }
    afterContent = String(before).replace(args.old, args.new);
  }
  const afterHash = sha256Text(afterContent);
  await store.upsertToolCall({
    id: toolCallId,
    conversationId,
    name,
    status: 'started',
    input: args,
    path: rel,
    beforeHash,
    afterHash,
  });
  return { beforeHash, afterHash };
}

export async function executeTool(name, args = {}, ctx = {}) {
  const { store, toolCallId, workspacePath, signal, conversationId, timeout } = ctx;
  if (!TOOL_REGISTRY.includes(name)) throw toolError('E_UNKNOWN_TOOL', `unknown tool: ${name}`);

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
      const output = BASH_INTERRUPTED;
      await store.upsertToolCall({
        id: toolCallId,
        conversationId,
        name: 'bash',
        status: 'completed',
        output,
      });
      return { name: 'bash', output, status: 'completed', interrupted: true };
    }
    if ((name === 'write' || name === 'edit') && prev?.status === 'started') {
      return recoverWriteEdit(name, args, prev, ctx);
    }
  }

  const fns = { read, write, edit, ls, grep, bash };
  const fn = fns[name];
  if (!fn) throw toolError('E_UNKNOWN_TOOL', `unknown tool: ${name}`);

  let hashes;
  if ((name === 'write' || name === 'edit') && store && toolCallId) {
    hashes = await journalMutatingStart(name, args, ctx);
  }

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
      beforeHash: hashes?.beforeHash,
      afterHash: hashes?.afterHash ?? (result.after != null ? sha256Text(result.after) : undefined),
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
  const before = await readText(abs);
  await writeAtomic(abs, content);
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
  await writeAtomic(abs, after);
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
  // TODO: run under bubblewrap (bwrap) for a full OS sandbox: bind-mount the
  // workspace read-write, everything else read-only, network optional. v1
  // mitigations are env allow-list, cwd, 1 MiB combined output cap, and
  // process-group SIGKILL on timeout/abort. Full OS sandbox is recommended
  // but not required for v1.
  const env = {
    PATH: '/usr/bin:/bin:/usr/local/bin',
    HOME: workspacePath,
    LANG: 'C.UTF-8',
    TERM: 'dumb',
  };
  const output = await new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', command], {
      cwd,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let combined = 0;
    let truncated = false;
    let settled = false;
    const take = (buf) => {
      const s = String(buf);
      if (combined >= OUTPUT_CAP) {
        truncated = true;
        return '';
      }
      const room = OUTPUT_CAP - combined;
      if (s.length > room) {
        truncated = true;
        combined = OUTPUT_CAP;
        return s.slice(0, room);
      }
      combined += s.length;
      return s;
    };
    const finish = (value, err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (truncated) stdout += TRUNCATE_MARKER;
      if (err) reject(err);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      killProcessGroup(child.pid);
      const err = new Error('bash timeout');
      err.code = 'ETIMEDOUT';
      finish(null, err);
    }, limit);
    const onAbort = () => {
      killProcessGroup(child.pid);
      const err = new Error('aborted');
      err.code = 'E_ABORTED';
      err.name = 'AbortError';
      finish(null, err);
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (b) => { stdout += take(b); });
    child.stderr.on('data', (b) => { stderr += take(b); });
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
