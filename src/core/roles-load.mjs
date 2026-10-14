import fs from 'node:fs/promises';
import path from 'node:path';
import { validateRole, validatePipeline } from './config.mjs';

export const BUILTIN_ROLE_IDS = ['planner', 'coder', 'tester', 'auditor'];

async function readJsonTemplates(dir, validate) {
  const values = [];
  let files;
  try {
    files = await fs.readdir(dir);
  } catch {
    return values;
  }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    let obj;
    try {
      obj = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8'));
    } catch {
      continue;
    }
    const v = validate(obj);
    if (!v.ok) continue;
    values.push(v.value);
  }
  return values;
}

export async function readRoleTemplateMap(dir) {
  const map = new Map();
  for (const value of await readJsonTemplates(dir, validateRole)) map.set(value.id, value);
  return map;
}

export function attachBuiltinPrompts(roles, templates) {
  const allow = new Set(BUILTIN_ROLE_IDS);
  return (roles || []).map((role) => {
    const tpl = templates.get(role.id);
    if (!tpl || !allow.has(role.id)) return role;
    return { ...role, builtin: true, defaultPrompt: tpl.systemPrompt, defaultTools: tpl.tools.slice() };
  });
}

export async function loadRoleTemplates(store, dir) {
  const templates = await readRoleTemplateMap(dir);
  const loaded = [];
  for (const value of templates.values()) {
    if (await store.hasCatalogTombstone('role', value.id)) continue;
    const existing = await store.getRole(value.id);
    if (!existing) await store.createRole(value);
    loaded.push(value.id);
  }
  return loaded;
}

export async function loadPipelineTemplates(store, dir) {
  const roles = await store.listRoles();
  const loaded = [];
  for (const value of await readJsonTemplates(dir, (obj) => validatePipeline(obj, roles))) {
    if (await store.hasCatalogTombstone('pipeline', value.id)) continue;
    const existing = await store.getPipeline(value.id);
    if (!existing) await store.createPipeline(value);
    loaded.push(value.id);
  }
  return loaded;
}
