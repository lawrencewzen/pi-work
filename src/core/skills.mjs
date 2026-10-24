import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { catalogError, scanSkills } from './catalog.mjs';

export const SKILL_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const SKILL_LIST_INTRO = 'Skills you can load with the skill tool when a request matches:';
const NAME_MAX = 80;
const DESC_MAX = 240;
const BODY_MAX = 8000;
const DESC_LINE_MAX = 160;

function quoteMeta(value) {
  const text = String(value ?? '').replace(/[\r\n]+/g, ' ').replace(/"/g, "'").trim();
  return `"${text}"`;
}

export function skillIdFromName(name, explicit) {
  const given = String(explicit || '').trim().toLowerCase();
  if (given) return given;
  const slug = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  if (SKILL_ID.test(slug)) return slug;
  return `skill-${randomBytes(3).toString('hex')}`;
}

export async function writeSkillFile(root, skill) {
  const dir = path.join(root, skill.id);
  await fs.mkdir(dir, { recursive: true });
  const text = [
    '---',
    `id: ${quoteMeta(skill.id)}`,
    `name: ${quoteMeta(skill.name)}`,
    `description: ${quoteMeta(skill.description || '')}`,
    `version: ${quoteMeta(skill.version || '1.0.0')}`,
    `source: ${quoteMeta(skill.source || 'local')}`,
    '---',
    '',
    String(skill.body || '').replace(/^\uFEFF/, '').trim(),
    '',
  ].join('\n');
  await fs.writeFile(path.join(dir, 'SKILL.md'), text, 'utf8');
}

export async function listSkillRecords(dirs) {
  const map = new Map();
  for (const dir of dirs || []) {
    const rows = await scanSkills(dir);
    const root = path.resolve(dir);
    for (const row of rows) {
      if (!SKILL_ID.test(row.id)) continue;
      map.set(row.id, { ...row, dir: root });
    }
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function skillDeletable(skill, userDir) {
  if (!skill || skill.source === 'bundled' || skill.source === 'builtin') return false;
  if (!userDir) return false;
  return path.resolve(skill.dir || '') === path.resolve(userDir);
}

export async function listSkills(dirs, enabledMap = {}, userDir) {
  const records = await listSkillRecords(dirs);
  return records.map((skill) => ({
    id: skill.id,
    name: skill.name,
    description: skill.description,
    version: skill.version,
    source: skill.source,
    enabled: enabledMap[skill.id] !== false,
    deletable: skillDeletable(skill, userDir),
  }));
}

export function oneLineSkillDescription(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, DESC_LINE_MAX);
}

export function enabledSkills(records, enabledMap = {}) {
  return (records || []).filter((skill) => skill && enabledMap[skill.id] !== false);
}

/** One-line catalog for the main agent system prompt. Empty when nothing is enabled. */
export function renderSkillList(skills) {
  const rows = [];
  for (const skill of skills || []) {
    const id = String(skill?.id || '').trim();
    if (!id) continue;
    rows.push(`- ${id}: ${oneLineSkillDescription(skill.description)}`);
  }
  if (!rows.length) return '';
  return [SKILL_LIST_INTRO, ...rows].join('\n');
}

export async function listEnabledSkillRecords(dirs, enabledMap = {}) {
  return enabledSkills(await listSkillRecords(dirs), enabledMap);
}

export async function buildSkillPrompt(dirs, enabledMap = {}) {
  return renderSkillList(await listEnabledSkillRecords(dirs, enabledMap));
}

export function findEnabledSkill(skills, name) {
  const needle = String(name ?? '').trim();
  if (!needle) return null;
  return (skills || []).find((skill) => skill.id === needle)
    || (skills || []).find((skill) => skill.name === needle)
    || null;
}

export function unknownSkillError(name, skills) {
  const available = (skills || []).map((skill) => skill.id).join(', ');
  return `unknown skill ${String(name ?? '').trim()}，可用：${available}`;
}

export async function loadSkillBody(dirs, enabledMap, name) {
  const enabled = await listEnabledSkillRecords(dirs, enabledMap);
  const found = findEnabledSkill(enabled, name);
  if (!found) return { error: unknownSkillError(name, enabled) };
  return { body: String(found.body || '').trim() };
}

function cleanSkillFields({ name, description, body }) {
  const nextName = String(name || '').trim();
  const nextBody = String(body || '').trim();
  let nextDescription = String(description || '').trim();
  if (!nextName) throw catalogError(400, 'err_skill_name_required', 'skill name is required');
  if (!nextBody) throw catalogError(400, 'err_skill_body_required', 'skill body is required');
  if (nextName.length > NAME_MAX || nextDescription.length > DESC_MAX || nextBody.length > BODY_MAX) {
    throw catalogError(400, 'err_skill_invalid', 'skill field is too long');
  }
  if (!nextDescription) nextDescription = nextBody.split('\n').find((line) => line.trim())?.replace(/^#+\s*/, '').slice(0, 160) || nextName;
  return { name: nextName, description: nextDescription.slice(0, DESC_MAX), body: nextBody };
}

export async function createSkill(userDir, input, existingIds = new Set()) {
  const id = skillIdFromName(input?.name, input?.id);
  if (!SKILL_ID.test(id)) throw catalogError(400, 'err_skill_invalid', 'invalid skill id');
  if (existingIds.has(id)) throw catalogError(409, 'err_skill_exists', 'skill already exists');
  const fields = cleanSkillFields({
    name: input?.name,
    description: input?.description,
    body: input?.body,
  });
  const skill = { id, ...fields, version: '1.0.0', source: 'local' };
  await writeSkillFile(userDir, skill);
  return skill;
}

export async function updateSkill(dirs, userDir, id, patch = {}) {
  if (!SKILL_ID.test(id)) throw catalogError(400, 'err_skill_invalid', 'invalid skill id');
  const current = (await listSkillRecords(dirs)).find((skill) => skill.id === id);
  if (!current) throw catalogError(404, 'err_skill_not_found', 'skill not found');
  const fields = cleanSkillFields({
    name: patch.name != null ? patch.name : current.name,
    description: patch.description != null ? patch.description : current.description,
    body: patch.body != null ? patch.body : current.body,
  });
  const next = {
    id,
    ...fields,
    version: current.version || '1.0.0',
    source: current.source || 'local',
  };
  await writeSkillFile(userDir, next);
  return next;
}

export async function deleteSkill(dirs, userDir, id) {
  if (!SKILL_ID.test(id)) throw catalogError(400, 'err_skill_invalid', 'invalid skill id');
  const current = (await listSkillRecords(dirs)).find((skill) => skill.id === id);
  if (!current) throw catalogError(404, 'err_skill_not_found', 'skill not found');
  if (!skillDeletable(current, userDir)) {
    throw catalogError(403, 'err_skill_builtin', 'built-in skill cannot be deleted');
  }
  const root = path.resolve(userDir);
  const dir = path.resolve(root, id);
  if (dir !== root && !dir.startsWith(`${root}${path.sep}`)) {
    throw catalogError(400, 'err_skill_invalid', 'invalid skill id');
  }
  await fs.rm(dir, { recursive: true, force: true });
  return { id };
}
