import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function repoRoot() {
  return root;
}

export async function readRole(file) {
  const role = JSON.parse(await readFile(file, 'utf8'));
  if (typeof role.id !== 'string' || typeof role.systemPrompt !== 'string' || !Array.isArray(role.tools)) {
    throw new Error(`invalid role ${file}`);
  }
  return role;
}

export async function loadRoles() {
  const coder = await readRole(path.join(root, 'roles', 'coder.json'));
  const echo = await readRole(path.join(root, 'spike', 'roles', 'echo.json'));
  const recover = await readRole(path.join(root, 'spike', 'roles', 'recover.json'));
  return new Map([coder, echo, recover].map((role) => [role.id, role]));
}
