import fs from 'node:fs/promises';
import path from 'node:path';

function parseFrontmatter(text) {
  const src = String(text || '');
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: src };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx < 1) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    meta[key] = val;
  }
  return { meta, body: m[2] };
}

async function readJson(fp) {
  try {
    return JSON.parse(await fs.readFile(fp, 'utf8'));
  } catch {
    return null;
  }
}

export function catalogError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.catalogCode = code;
  return err;
}

export async function scanPlugins(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    let manifest = null;
    let id = e.name.replace(/\.json$/i, '');
    if (e.isDirectory()) {
      const folder = path.join(dir, e.name);
      for (const name of ['plugin.json', 'manifest.json', 'package.json']) {
        manifest = await readJson(path.join(folder, name));
        if (manifest) break;
      }
    } else if (e.name.endsWith('.json')) {
      manifest = await readJson(path.join(dir, e.name));
    }
    if (!manifest || typeof manifest !== 'object') continue;
    id = manifest.id || manifest.name || id;
    out.push({
      id: String(id),
      name: String(manifest.name || id),
      description: String(manifest.description || ''),
      version: String(manifest.version || ''),
      source: String(manifest.source || 'local'),
      location: e.isDirectory() ? path.join(dir, e.name) : '',
      main: typeof manifest.main === 'string' ? manifest.main : '',
      toolSpecs: Array.isArray(manifest.tools) ? manifest.tools : [],
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export async function scanSkills(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    let skillPath = null;
    let id = e.name.replace(/\.md$/i, '');
    if (e.isDirectory()) {
      skillPath = path.join(dir, e.name, 'SKILL.md');
    } else if (e.name === 'SKILL.md' || e.name.toLowerCase().endsWith('.md')) {
      skillPath = path.join(dir, e.name);
    }
    if (!skillPath) continue;
    let text;
    try {
      text = await fs.readFile(skillPath, 'utf8');
    } catch {
      continue;
    }
    const { meta, body } = parseFrontmatter(text);
    id = meta.id || meta.name || id;
    const firstLine = body.trim().split('\n').find((l) => l.trim()) || '';
    out.push({
      id: String(id),
      name: String(meta.name || id),
      description: String(meta.description || firstLine.replace(/^#+\s*/, '').slice(0, 160)),
      version: String(meta.version || ''),
      source: String(meta.source || 'local'),
      body: body.trim(),
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
