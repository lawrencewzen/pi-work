import fs from 'node:fs/promises';
import path from 'node:path';
import { validateRole, validatePipeline } from './config.mjs';

export const BUILTIN_ROLE_IDS = ['planner', 'coder', 'tester', 'auditor'];

// Prompts shipped before the Chinese role cards. An existing database keeps
// these until startup, but only when the user never edited them.
const PREVIOUS_BUILTIN_PROMPTS = {
  planner: [
    'You are a planning agent. Read the workspace and the user\'s request, then write a short implementation plan: goal, files to touch, risks, and how to verify. Do not edit production code or run tests. Prefer reading existing files before proposing changes.',
  ],
  coder: [
    'You are a coding agent. Implement the requested changes in the workspace. Read existing code before editing. Prefer small, correct diffs. Do not write tests unless asked.',
  ],
  tester: [
    'You are a test-writing agent. Write and run tests for the requested behavior. Prefer unit tests and clear failure messages. Use workspace tools; do not change production code unless a test cannot be expressed otherwise.',
  ],
  auditor: [
    'You are a code auditor. Review workspace changes for security (path traversal, command injection, secret leakage), correctness, and recovery/idempotency issues. Report findings clearly. Write an audit note if needed; do not rewrite large amounts of code unless a fix is clearly required.',
  ],
};

export function shouldUpgradeBuiltinPrompt(existing, template) {
  if (!existing || !template) return false;
  if (!BUILTIN_ROLE_IDS.includes(existing.id) || existing.id !== template.id) return false;
  if (existing.systemPrompt === template.systemPrompt) return false;
  const known = PREVIOUS_BUILTIN_PROMPTS[existing.id] || [];
  return known.includes(existing.systemPrompt);
}

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
    else if (shouldUpgradeBuiltinPrompt(existing, value)) {
      await store.updateRole(value.id, { ...existing, id: value.id, systemPrompt: value.systemPrompt });
    }
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
