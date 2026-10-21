import fs from 'node:fs/promises';
import path from 'node:path';
import { validateRole } from './config.mjs';

export const BUILTIN_ROLE_IDS = ['default', 'planner', 'coder', 'tester', 'auditor'];

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
    '你是 pi-work 的审计角色。结论跟随用户的语言。\n\n职责\n- 审查这次改动是否正确、是否安全、是否做过头。\n- 重点看路径穿越、命令注入、密钥进了仓库、错误被吞掉、重复执行会不会把仓库弄坏。\n- 工具是 read、write、ls、grep。不要跑 bash，不要大段重写实现。\n- 只有明确且很小的问题才直接改；其余写成发现项。\n\n输入\n- 上一位的「## 交接」。\n- 你自己读到的改动和相关文件。\n\n输出\n- 先写是否可以接受。\n- 每条发现写清严重程度、路径、原因、建议。\n- 需要留档时，把同一份结论写入仓库里的 AUDIT.md，不要另写一套说法。\n\n交接\n回复的最后必须有这一段。你通常是流水线的最后一步，这一段是给用户的结论：\n\n## 交接\n- 角色：审计\n- 结论：可以接受，或有必须处理的问题\n- 交给下一位：发现列表；没有下一位时写「结束」\n- 依据：读过的文件；写了 AUDIT.md 时带上路径',
  ],
};

// Tool lists shipped before auditor became read-only. Upgrade only when the
// stored list still matches one of these; a user edit is left alone.
export const PREVIOUS_BUILTIN_TOOLS = {
  auditor: ['read', 'write', 'ls', 'grep'],
};

function sameTools(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((tool, i) => tool === b[i]);
}

export function shouldUpgradeBuiltinTools(existing, template) {
  if (!existing || !template) return false;
  if (!BUILTIN_ROLE_IDS.includes(existing.id) || existing.id !== template.id) return false;
  if (sameTools(existing.tools, template.tools)) return false;
  const previous = PREVIOUS_BUILTIN_TOOLS[existing.id];
  return Array.isArray(previous) && sameTools(existing.tools, previous);
}

export function shouldFillBuiltinDescription(existing, template) {
  if (!existing || !template) return false;
  if (!BUILTIN_ROLE_IDS.includes(existing.id) || existing.id !== template.id) return false;
  const current = typeof existing.description === 'string' ? existing.description.trim() : '';
  const next = typeof template.description === 'string' ? template.description : '';
  return current.length === 0 && next.length > 0;
}

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
    else {
      const patch = { ...existing, id: value.id };
      let changed = false;
      if (shouldUpgradeBuiltinPrompt(existing, value)) {
        patch.systemPrompt = value.systemPrompt;
        changed = true;
      }
      if (shouldUpgradeBuiltinTools(existing, value)) {
        patch.tools = value.tools.slice();
        changed = true;
      }
      if (shouldFillBuiltinDescription(existing, value)) {
        patch.description = value.description;
        changed = true;
      }
      if (changed) await store.updateRole(value.id, patch);
    }
    loaded.push(value.id);
  }
  return loaded;
}
