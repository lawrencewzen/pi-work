const ROLE_ID = /^[a-z][a-z0-9-]{0,31}$/;
export const TOOLS = ['read', 'write', 'edit', 'ls', 'grep', 'bash'];
export const DEFAULT_TOOLS = ['read', 'ls', 'grep'];
const INPUTS = new Set(['previous', 'user']);

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
  if (obj.model != null && typeof obj.model !== 'string') errors.push('model must be a string');
  if (errors.length) return { ok: false, errors };
  const value = { id: obj.id, name: obj.name, systemPrompt: obj.systemPrompt, tools };
  if (obj.model != null) value.model = obj.model;
  return { ok: true, value };
}

export function validatePipeline(obj, roles = []) {
  const errors = [];
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, errors: ['pipeline must be an object'] };
  }
  if (typeof obj.id !== 'string' || obj.id.length === 0) errors.push('invalid id');
  if (typeof obj.name !== 'string' || obj.name.length === 0) errors.push('invalid name');
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
    }
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { id: obj.id, name: obj.name, steps: obj.steps } };
}
