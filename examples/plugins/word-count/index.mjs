import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_BYTES = 1024 * 1024;

function inside(rootReal, resolved) {
  const rel = path.relative(rootReal, resolved);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

function fail(message, rel) {
  const result = { output: message, status: 'error' };
  if (rel) result.path = rel;
  return result;
}

async function resolveExistingPrefix(target) {
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

export async function word_count(args, ctx) {
  const rel = args && typeof args.path === 'string' ? args.path : '';
  if (!rel.trim() || rel.includes('\0')) return fail('word_count: path is required');
  const root = ctx?.workspacePath;
  if (!root || typeof root !== 'string' || root.includes('\0')) return fail('word_count: workspace is not available', rel);
  let rootReal;
  try {
    rootReal = await fs.realpath(root);
  } catch {
    return fail('word_count: workspace is not available', rel);
  }
  const candidate = path.resolve(rootReal, rel);
  let lexical;
  try {
    lexical = await resolveExistingPrefix(candidate);
  } catch {
    return fail('word_count: invalid path', rel);
  }
  if (!inside(rootReal, lexical)) return fail('word_count: path is outside the workspace', rel);
  let resolved;
  try {
    resolved = await fs.realpath(candidate);
  } catch (err) {
    if (err?.code === 'ENOENT') return fail('word_count: file not found', rel);
    return fail('word_count: invalid path', rel);
  }
  if (!inside(rootReal, resolved)) return fail('word_count: path is outside the workspace', rel);
  let stat;
  try {
    stat = await fs.stat(resolved);
  } catch (err) {
    if (err?.code === 'ENOENT') return fail('word_count: file not found', rel);
    return fail('word_count: cannot read file', rel);
  }
  if (!stat.isFile()) return fail('word_count: not a file', rel);
  if (stat.size > MAX_BYTES) return fail('word_count: file is too large', rel);
  let text;
  try {
    text = await fs.readFile(resolved, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return fail('word_count: file not found', rel);
    return fail('word_count: cannot read file', rel);
  }
  const words = text.replace(/^\uFEFF/, '').split(/\s+/).filter(Boolean);
  return { output: String(words.length), status: 'completed', path: rel };
}
