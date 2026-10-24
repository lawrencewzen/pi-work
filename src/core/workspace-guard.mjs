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
  const env = String(process.env.WEFT_WORKSPACE_ROOT || '').trim();
  if (env) return path.resolve(env);
  const home = os.homedir();
  const projects = path.join(home, 'projects');
  if (existsSync(projects)) return path.resolve(projects);
  return path.resolve(home);
}

const SYSTEM_PREFIXES = ['/etc', '/var', '/usr', '/bin', '/boot', '/dev', '/proc', '/sys', '/root'];

/**
 * Resolve `inputPath` with realpath and allow it only under DATA_DIR/workspaces
 * or WEFT_WORKSPACE_ROOT. Never allow `/`, `$HOME` itself, `~/.ssh`, `~/.gnupg`,
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

const MAX_BROWSE_ENTRIES = 500;

/** Same deny rules as resolveAllowedWorkspacePath, applied to an already-resolved path. */
async function isForbidden(resolved, home) {
  if (resolved === '/') return true;
  if (isUnder(path.join(home, '.ssh'), resolved) || isUnder(path.join(home, '.gnupg'), resolved)) return true;
  for (const prefix of SYSTEM_PREFIXES) {
    let realPrefix = prefix;
    try { realPrefix = await fs.realpath(prefix); } catch { /* missing */ }
    if (isUnder(realPrefix, resolved) || isUnder(prefix, resolved)) return true;
  }
  return false;
}

/**
 * Folder picker for the new-workspace dialog: lists the sub-folders of `inputPath`
 * (default: the workspace root). Only paths inside the workspace root are browsable;
 * hidden folders and symlinks that leave the root are skipped. Read-only.
 */
export async function listBrowsableDirs(inputPath) {
  const root = await realOrResolve(defaultWorkspaceRoot());
  const home = await realOrResolve(os.homedir());
  const raw = inputPath == null || String(inputPath).trim() === '' ? root : String(inputPath);
  if (raw.includes('\0')) throw fail('path is forbidden');
  let current;
  try {
    current = await fs.realpath(raw);
  } catch (err) {
    if (err?.code === 'ENOENT') throw fail('path does not exist', 404);
    throw fail('path is not allowed');
  }
  if (!isUnder(root, current)) throw fail('path is not under an allowed workspace root');
  if (await isForbidden(current, home)) throw fail('path is forbidden');

  let dirents;
  try {
    dirents = await fs.readdir(current, { withFileTypes: true });
  } catch {
    throw fail('path is not readable');
  }
  const entries = [];
  for (const ent of dirents) {
    if (ent.name.startsWith('.')) continue;
    if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;
    const full = path.join(current, ent.name);
    let real;
    try {
      real = await fs.realpath(full);
      if (!(await fs.stat(real)).isDirectory()) continue;
    } catch {
      continue;
    }
    if (!isUnder(root, real) || await isForbidden(real, home)) continue;
    entries.push({ name: ent.name, path: full, git: existsSync(path.join(real, '.git')) });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  return {
    root,
    path: current,
    parent: current === root ? null : path.dirname(current),
    selectable: current !== home,
    git: existsSync(path.join(current, '.git')),
    entries: entries.slice(0, MAX_BROWSE_ENTRIES),
    truncated: entries.length > MAX_BROWSE_ENTRIES,
  };
}
