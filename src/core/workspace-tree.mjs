import fs from 'node:fs/promises';
import { resolveInWorkspace } from './paths.mjs';

const SKIP_DIRS = new Set(['.git', 'node_modules']);
const MAX_ENTRIES = 500;
const MAX_DEPTH = 8;

/**
 * List files and directories under a workspace root.
 * Symlinks that resolve outside the root are skipped. Directory symlinks are
 * listed but not followed, so a link cannot walk the tree out of the workspace.
 */
export async function listWorkspaceTree(root) {
  const rootReal = await fs.realpath(root);
  const entries = [];
  const seen = new Set([rootReal]);

  async function walk(dirReal, rel, depth) {
    if (depth > MAX_DEPTH || entries.length >= MAX_ENTRIES) return;
    let dirents;
    try {
      dirents = await fs.readdir(dirReal, { withFileTypes: true });
    } catch {
      return;
    }
    dirents.sort((a, b) => a.name.localeCompare(b.name));
    const dirs = [];
    const files = [];
    for (const ent of dirents) {
      if (SKIP_DIRS.has(ent.name)) continue;
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      let real;
      try {
        real = await resolveInWorkspace(rootReal, childRel);
      } catch {
        continue;
      }
      let st;
      try {
        st = await fs.lstat(real);
      } catch {
        continue;
      }
      if (st.isDirectory()) dirs.push({ ent, childRel, real });
      else if (st.isFile()) files.push({ childRel });
    }
    for (const d of dirs) {
      if (entries.length >= MAX_ENTRIES) return;
      entries.push({ path: d.childRel, type: 'dir' });
      if (d.ent.isSymbolicLink() || seen.has(d.real)) continue;
      seen.add(d.real);
      await walk(d.real, d.childRel, depth + 1);
    }
    for (const f of files) {
      if (entries.length >= MAX_ENTRIES) return;
      entries.push({ path: f.childRel, type: 'file' });
    }
  }

  await walk(rootReal, '', 0);
  return entries;
}
