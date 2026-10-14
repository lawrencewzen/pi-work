import { randomBytes } from 'node:crypto';

const ROLE_ID = /^[a-z][a-z0-9-]{0,31}$/;
const SKILL_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const TOOLS = ['read', 'write', 'edit', 'ls', 'grep', 'bash'];
export const DEFAULT_TOOLS = ['read', 'ls', 'grep'];
const INPUTS = new Set(['previous', 'user']);

export function roleIdFromName(name, { random = () => randomBytes(3).toString('hex') } = {}) {
  const slug = String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  if (ROLE_ID.test(slug)) return slug;
  const token = String(random()).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 6).padEnd(6, '0');
  return `agent-${token}`;
}

export async function allocateRoleId(store, name, options) {
  const base = roleIdFromName(name, options);
  const taken = async (id) => Boolean(await store.getRole(id)) || await store.hasCatalogTombstone('role', id);
  if (!(await taken(base))) return base;
  for (let n = 2; n < 1000; n += 1) {
    const suffix = `-${n}`;
    const stem = base.slice(0, Math.max(1, 32 - suffix.length)).replace(/-+$/g, '');
    const id = `${stem}${suffix}`;
    if (!ROLE_ID.test(id)) continue;
    if (!(await taken(id))) return id;
  }
  throw new Error('could not allocate role id');
}

export function validateRole(obj) {
  const errors = [];
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, errors: ['role must be an object'] };
  }
  if (typeof obj.id !== 'string' || !ROLE_ID.test(obj.id)) errors.push('invalid id');
  if (typeof obj.name !== 'string' || obj.name.length === 0) errors.push('invalid name');
  if (typeof obj.systemPrompt !== 'string' || obj.systemPrompt.length === 0) errors.push('systemPrompt must be a non-empty string');
  let tools = obj.tools;
  if (tools === undefined) tools = DEFAULT_TOOLS.slice();
  else if (!Array.isArray(tools)) errors.push('tools must be an array');
  else {
    for (const t of tools) {
      if (!TOOLS.includes(t)) {
        errors.push(`unknown tool: ${t}`);
        break;
      }
    }
  }
  let description = '';
  if (obj.description == null || obj.description === '') description = '';
  else if (typeof obj.description !== 'string') errors.push('description must be a string');
  else if (obj.description.length > 500) errors.push('description must be at most 500 characters');
  else description = obj.description;
  let skills;
  if (obj.skills != null) {
    if (!Array.isArray(obj.skills)) errors.push('skills must be an array');
    else {
      skills = [];
      for (const id of obj.skills) {
        if (typeof id !== 'string' || !SKILL_ID.test(id)) {
          errors.push('invalid skill id');
          break;
        }
        if (!skills.includes(id)) skills.push(id);
      }
    }
  }
  let pluginTools;
  if (obj.pluginTools != null) {
    if (typeof obj.pluginTools !== 'boolean') errors.push('pluginTools must be a boolean');
    else pluginTools = obj.pluginTools;
  }
  if (errors.length) return { ok: false, errors };
  const value = { id: obj.id, name: obj.name, systemPrompt: obj.systemPrompt, tools, description };
  if (Array.isArray(skills)) value.skills = skills;
  if (pluginTools !== undefined) value.pluginTools = pluginTools;
  return { ok: true, value };
}

export function validatePipeline(obj, roles = []) {
  const errors = [];
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, errors: ['pipeline must be an object'] };
  }
  if (typeof obj.id !== 'string' || !ROLE_ID.test(obj.id)) errors.push('invalid id');
  if (typeof obj.name !== 'string' || obj.name.length === 0) errors.push('invalid name');
  const steps = [];
  if (!Array.isArray(obj.steps) || obj.steps.length === 0) errors.push('steps must be a non-empty array');
  else if (obj.steps.length > 20) errors.push('steps must have at most 20 items');
  else {
    const roleIds = new Set((roles ?? []).map((r) => r?.id).filter(Boolean));
    for (const [i, step] of obj.steps.entries()) {
      if (!step || typeof step !== 'object') {
        errors.push(`step ${i} is invalid`);
        continue;
      }
      if (!roleIds.has(step.role)) errors.push(`unknown role: ${step.role}`);
      if (step.input != null && !INPUTS.has(step.input)) errors.push(`invalid input: ${step.input}`);
      if (!errors.length) {
        const next = { role: step.role };
        if (step.input) next.input = step.input;
        steps.push(next);
      }
    }
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { id: obj.id, name: obj.name, steps } };
}
