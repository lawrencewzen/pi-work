import fs from 'node:fs/promises';
import path from 'node:path';

function sandbox(message = 'path outside workspace') {
  const err = new Error(message);
  err.code = 'E_SANDBOX';
  return err;
}

function truncateFilename(name, max) {
  if (name.length <= max) return name;
  if (max <= 1) return '…'.slice(0, max);
  return `…${name.slice(-(max - 1))}`;
}

/** Collapse a path for display: keep first segment + filename, then shorten the filename. */
export function truncatePath(p, max = 40) {
  const s = String(p ?? '').replaceAll('\\', '/');
  if (s.length <= max) return s;
  const parts = s.split('/').filter((x) => x.length > 0);
  const filename = parts.pop() || s;
  const first = parts[0];
  if (first) {
    const candidate = `${first}/…/${filename}`;
    if (candidate.length <= max) return candidate;
    const prefix = `${first}/…/`;
    const budget = max - prefix.length;
    if (budget >= 1) return prefix + truncateFilename(filename, budget);
  }
  return truncateFilename(s, max);
}

async function realpathExistingPrefix(target) {
  let current = target;
  const missing = [];
  for (;;) {
    try {
      const real = await fs.realpath(current);
      return missing.reduceRight((acc, name) => path.join(acc, name), real);
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
      const parent = path.dirname(current);
      if (parent === current) throw err;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

function isInside(rootReal, resolved) {
  const rel = path.relative(rootReal, resolved);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

/** Resolve `rel` to a real path that must stay inside `root`. */
export async function resolveInWorkspace(root, rel) {
  if (typeof rel !== 'string' || rel.includes('\0') || String(root ?? '').includes('\0')) {
    throw sandbox('invalid path');
  }
  const rootReal = await fs.realpath(root);
  const candidate = path.resolve(rootReal, rel);
  let resolved;
  try {
    resolved = await realpathExistingPrefix(candidate);
  } catch {
    throw sandbox('invalid path');
  }
  if (!isInside(rootReal, resolved)) throw sandbox();
  return resolved;
}
