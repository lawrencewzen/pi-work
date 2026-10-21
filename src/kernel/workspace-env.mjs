// Execution environment for one conversation workspace.
// Wraps official NodeExecutionEnv and applies resolveInWorkspace to every
// file path. Command cwd is kept inside that workspace. No scheduler.
import { realpath } from 'node:fs/promises';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { ExecutionError, FileError, err, ok } from '@earendil-works/pi-durable/env';
import { resolveInWorkspace } from '../core/paths.mjs';

const UTF8_OUTPUT = 'try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}';
const POWERSHELL_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'];
const POWERSHELL_PROGRAMS = ['pwsh', 'powershell'];

function sandboxError(filePath, error) {
  const cause = error instanceof Error ? error : undefined;
  const message = error?.code === 'E_SANDBOX'
    ? `E_SANDBOX: ${error.message}`
    : `E_SANDBOX: ${error?.message || 'path outside workspace'}`;
  return err(new FileError('invalid', message, filePath, cause));
}

/**
 * Official PowerShell invocation, used only when the environment has no bash.
 * Same flags as createPowerShellTool: no profile, Bypass execution policy.
 */
async function execPowerShell(inner, command, options, context) {
  const script = `${UTF8_OUTPUT}\n${command}`;
  let last = err(new ExecutionError('shell_unavailable', 'No bash shell found'));
  for (const program of POWERSHELL_PROGRAMS) {
    last = await inner.exec([program, ...POWERSHELL_ARGS, script], options, context);
    if (last.ok || last.error?.code !== 'spawn_error') return last;
  }
  return last;
}

export class WorkspaceExecutionEnv {
  constructor(inner, root) {
    this.inner = inner;
    this.root = root;
    this.id = inner.id;
  }

  get cwd() {
    return this.inner.cwd;
  }

  set cwd(value) {
    // Conversation cwd is fixed at construction. Official tools read env.cwd.
    this.inner.cwd = this.root;
  }

  async allow(filePath) {
    try {
      await resolveInWorkspace(this.root, filePath);
      return ok(filePath);
    } catch (error) {
      return sandboxError(filePath, error);
    }
  }

  async checked(filePath, context) {
    const resolved = await this.inner.absolutePath(filePath, context);
    if (!resolved.ok) return resolved;
    const allowed = await this.allow(resolved.value);
    if (!allowed.ok) return allowed;
    return resolved;
  }

  async absolutePath(filePath, context) {
    return this.checked(filePath, context);
  }

  async joinPath(parts, context) {
    const joined = await this.inner.joinPath(parts, context);
    if (!joined.ok) return joined;
    return this.checked(joined.value, context);
  }

  async readTextFile(filePath, context) {
    const resolved = await this.checked(filePath, context);
    if (!resolved.ok) return resolved;
    return this.inner.readTextFile(resolved.value, context);
  }

  async openTextLineReader(filePath, context) {
    const resolved = await this.checked(filePath, context);
    if (!resolved.ok) return resolved;
    return this.inner.openTextLineReader(resolved.value, context);
  }

  async readTextLines(filePath, options, context) {
    const resolved = await this.checked(filePath, context);
    if (!resolved.ok) return resolved;
    return this.inner.readTextLines(resolved.value, options, context);
  }

  async readBinaryFile(filePath, context) {
    const resolved = await this.checked(filePath, context);
    if (!resolved.ok) return resolved;
    return this.inner.readBinaryFile(resolved.value, context);
  }

  async openBinaryReader(filePath, options, context) {
    const resolved = await this.checked(filePath, context);
    if (!resolved.ok) return resolved;
    return this.inner.openBinaryReader(resolved.value, options, context);
  }

  async writeFile(filePath, content, context) {
    const resolved = await this.checked(filePath, context);
    if (!resolved.ok) return resolved;
    return this.inner.writeFile(resolved.value, content, context);
  }

  async appendFile(filePath, content, context) {
    const resolved = await this.checked(filePath, context);
    if (!resolved.ok) return resolved;
    return this.inner.appendFile(resolved.value, content, context);
  }

  async truncateFile(filePath, size, context) {
    const resolved = await this.checked(filePath, context);
    if (!resolved.ok) return resolved;
    return this.inner.truncateFile(resolved.value, size, context);
  }

  async flushFile(filePath, context) {
    const resolved = await this.checked(filePath, context);
    if (!resolved.ok) return resolved;
    return this.inner.flushFile(resolved.value, context);
  }

  async renameFile(sourcePath, destinationPath, context) {
    const source = await this.checked(sourcePath, context);
    if (!source.ok) return source;
    const destination = await this.checked(destinationPath, context);
    if (!destination.ok) return destination;
    return this.inner.renameFile(source.value, destination.value, context);
  }

  async fileInfo(filePath, context) {
    const resolved = await this.checked(filePath, context);
    if (!resolved.ok) return resolved;
    return this.inner.fileInfo(resolved.value, context);
  }

  async listDir(filePath, context) {
    const resolved = await this.checked(filePath, context);
    if (!resolved.ok) return resolved;
    return this.inner.listDir(resolved.value, context);
  }

  async openDirReader(filePath, context) {
    const resolved = await this.checked(filePath, context);
    if (!resolved.ok) return resolved;
    return this.inner.openDirReader(resolved.value, context);
  }

  async watch(targets, onChange, context) {
    const checked = [];
    for (const target of targets || []) {
      const resolved = await this.checked(target.path, context);
      if (!resolved.ok) return resolved;
      checked.push({ ...target, path: resolved.value });
    }
    return this.inner.watch(checked, onChange, context);
  }

  async canonicalPath(filePath, context) {
    const resolved = await this.checked(filePath, context);
    if (!resolved.ok) return resolved;
    const canonical = await this.inner.canonicalPath(resolved.value, context);
    if (!canonical.ok) return canonical;
    return this.allow(canonical.value);
  }

  async exists(filePath, context) {
    const resolved = await this.checked(filePath, context);
    if (!resolved.ok) return resolved;
    return this.inner.exists(resolved.value, context);
  }

  async createDir(filePath, options, context) {
    const resolved = await this.checked(filePath, context);
    if (!resolved.ok) return resolved;
    return this.inner.createDir(resolved.value, options, context);
  }

  async remove(filePath, options, context) {
    const resolved = await this.checked(filePath, context);
    if (!resolved.ok) return resolved;
    return this.inner.remove(resolved.value, options, context);
  }

  createTempDir(prefix, context) {
    return this.inner.createTempDir(prefix, context);
  }

  createTempFile(options, context) {
    return this.inner.createTempFile(options, context);
  }

  cleanup(context) {
    return this.inner.cleanup(context);
  }

  async exec(command, options, context) {
    const requested = options?.cwd ?? this.cwd;
    const cwd = await this.checked(requested, context);
    if (!cwd.ok) {
      return err(new ExecutionError('spawn_error', cwd.error.message, cwd.error));
    }
    const next = { ...options, cwd: cwd.value };
    if (typeof command !== 'string') {
      return this.inner.exec(command, next, context);
    }
    const result = await this.inner.exec(command, next, context);
    if (result.ok || result.error?.code !== 'shell_unavailable') return result;
    return execPowerShell(this.inner, command, next, context);
  }
}

/** Build a path-checked environment whose cwd is the conversation workspace. */
export async function createWorkspaceEnv({ cwd } = {}) {
  if (!cwd) {
    const error = new Error('E_SANDBOX: conversation cwd is not set');
    error.code = 'E_SANDBOX';
    throw error;
  }
  const root = await realpath(cwd);
  return new WorkspaceExecutionEnv(new NodeExecutionEnv({ cwd: root }), root);
}
