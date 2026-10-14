import fs from 'node:fs/promises';
import path from 'node:path';
import { validateRole, validatePipeline } from './config.mjs';

export async function loadRoleTemplates(store, dir) {
  let files;
  try {
    files = await fs.readdir(dir);
  } catch {
    return [];
  }
  const loaded = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    let obj;
    try {
      obj = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8'));
    } catch {
      continue;
    }
    const v = validateRole(obj);
    if (!v.ok) continue;
    if (await store.hasCatalogTombstone('role', v.value.id)) continue;
    const existing = await store.getRole(v.value.id);
    if (!existing) await store.createRole(v.value);
    loaded.push(v.value.id);
  }
  return loaded;
}

export async function loadPipelineTemplates(store, dir) {
  let files;
  try {
    files = await fs.readdir(dir);
  } catch {
    return [];
  }
  const roles = await store.listRoles();
  const loaded = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    let obj;
    try {
      obj = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8'));
    } catch {
      continue;
    }
    const v = validatePipeline(obj, roles);
    if (!v.ok) continue;
    if (await store.hasCatalogTombstone('pipeline', v.value.id)) continue;
    const existing = await store.getPipeline(v.value.id);
    if (!existing) await store.createPipeline(v.value);
    loaded.push(v.value.id);
  }
  return loaded;
}
