import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function fail(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  err.code = 'E_PATH';
  return err;
}

function isUnder(root, resolved) {
  if (!root || !resolved) return false;
  const r = path.resolve(root);
  return resolved === r || resolved.startsWith(r + path.sep);
}

async function realOrResolve(p) {
  try {
    return await fs.realpath(p);
  } catch {
    return path.resolve(p);
  }
}

export function defaultWorkspaceRoot() {
  const env = String(process.env.PI_WORK_WORKSPACE_ROOT || '').trim();
  if (env) return path.resolve(env);
  const home = os.homedir();
  const projects = path.join(home, 'projects');
  if (existsSync(projects)) return path.resolve(projects);
  return path.resolve(home);
}

const SYSTEM_PREFIXES = ['/etc', '/var', '/usr', '/bin', '/boot', '/dev', '/proc', '/sys', '/root'];

/**
 * Resolve `inputPath` with realpath and allow it only under DATA_DIR/workspaces
 * or PI_WORK_WORKSPACE_ROOT. Never allow `/`, `$HOME` itself, `~/.ssh`, `~/.gnupg`,
 * or system directories.
 */
export async function resolveAllowedWorkspacePath(inputPath, { dataDir } = {}) {
  if (inputPath == null || String(inputPath).trim() === '') {
    throw fail('path is required');
  }
  const raw = String(inputPath);
  if (raw.includes('\0')) throw fail('path is forbidden');

  let resolved;
  try {
    resolved = await fs.realpath(raw);
  } catch (err) {
    if (err?.code === 'ENOENT') throw fail('path does not exist');
    throw fail('path is not allowed');
  }

  const home = await realOrResolve(os.homedir());
  const dataWs = await realOrResolve(path.join(dataDir, 'workspaces'));
  const wsRoot = await realOrResolve(defaultWorkspaceRoot());
  const ssh = path.join(home, '.ssh');
  const gnupg = path.join(home, '.gnupg');

  if (isUnder(dataWs, resolved)) return resolved;

  if (resolved === '/' || resolved === home) {
    throw fail('path is forbidden');
  }
  if (isUnder(ssh, resolved) || isUnder(gnupg, resolved)) {
    throw fail('path is forbidden');
  }
  for (const prefix of SYSTEM_PREFIXES) {
    let realPrefix = prefix;
    try { realPrefix = await fs.realpath(prefix); } catch { /* missing */ }
    if (isUnder(realPrefix, resolved) || isUnder(prefix, resolved)) {
      throw fail('path is forbidden');
    }
  }

  if (isUnder(wsRoot, resolved) && resolved !== home) return resolved;

  throw fail('path is not under an allowed workspace root');
}
