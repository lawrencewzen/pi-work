import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { catalogError } from './catalog.mjs';
import { TOOLS as BUILTIN_TOOLS } from './config.mjs';

export const PLUGIN_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,31}$/;
const MAX_FILES = 40;
const MAX_BYTES = 1024 * 1024;
const SKIP_DIRS = new Set(['node_modules', '.git']);

const cache = new Map();

export function clearPluginCache() {
  cache.clear();
}

function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function publicPlugin(plugin) {
  return {
    id: plugin.id,
    name: plugin.name,
    description: plugin.description,
    version: plugin.version,
    source: plugin.source,
    enabled: plugin.enabled !== false,
    loaded: Boolean(plugin.loaded),
    error: plugin.error || null,
    errorCode: plugin.errorCode || null,
    tools: Array.isArray(plugin.tools) ? plugin.tools.map((tool) => ({
      name: tool.name,
      description: tool.description || '',
    })) : [],
  };
}

async function listPluginDirs(root) {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    const folder = path.join(root, entry.name);
    try {
      await fs.access(path.join(folder, 'plugin.json'));
    } catch {
      continue;
    }
    dirs.push(folder);
  }
  dirs.sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
  return dirs;
}

function validateManifest(manifest, dir) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw catalogError(400, 'err_plugin_manifest_missing', 'plugin.json is missing');
  }
  const id = String(manifest.id || '').trim();
  if (!PLUGIN_ID.test(id)) throw catalogError(400, 'err_plugin_invalid', 'invalid plugin id');
  const name = String(manifest.name || id).trim();
  if (!name || name.length > 80) throw catalogError(400, 'err_plugin_invalid', 'invalid plugin name');
  const main = String(manifest.main || '').trim();
  if (!main || path.isAbsolute(main) || path.extname(main) !== '.mjs') {
    throw catalogError(400, 'err_plugin_not_loadable', 'plugin main must be a relative .mjs file inside the plugin directory');
  }
  const mainAbs = path.resolve(dir, main);
  if (!isInside(dir, mainAbs)) {
    throw catalogError(400, 'err_plugin_not_loadable', 'plugin main must be a relative .mjs file inside the plugin directory');
  }
  if (!Array.isArray(manifest.tools) || manifest.tools.length === 0) {
    throw catalogError(400, 'err_plugin_invalid', 'plugin must declare at least one tool');
  }
  if (manifest.tools.length > 16) throw catalogError(400, 'err_plugin_invalid', 'plugin declares too many tools');
  const tools = [];
  const seen = new Set();
  for (const spec of manifest.tools) {
    if (!spec || typeof spec !== 'object') throw catalogError(400, 'err_plugin_invalid', 'invalid tool spec');
    const toolName = String(spec.name || '').trim();
    if (!TOOL_NAME.test(toolName)) throw catalogError(400, 'err_plugin_invalid', `invalid tool name: ${toolName || '(empty)'}`);
    if (seen.has(toolName)) throw catalogError(400, 'err_plugin_invalid', `duplicate tool name: ${toolName}`);
    if (BUILTIN_TOOLS.includes(toolName)) {
      throw catalogError(400, 'err_plugin_invalid', `tool ${toolName} is already registered`);
    }
    seen.add(toolName);
    let parameters = spec.parameters;
    if (parameters == null) parameters = { type: 'object', properties: {} };
    if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) {
      throw catalogError(400, 'err_plugin_invalid', `invalid parameters for ${toolName}`);
    }
    if (JSON.stringify(parameters).length > 8000) {
      throw catalogError(400, 'err_plugin_invalid', `parameters for ${toolName} are too large`);
    }
    tools.push({
      name: toolName,
      description: String(spec.description || '').slice(0, 500),
      parameters,
    });
  }
  return {
    id,
    name,
    description: String(manifest.description || '').slice(0, 400),
    version: String(manifest.version || '0.0.0').slice(0, 32),
    source: String(manifest.source || 'local').slice(0, 32),
    mainAbs,
    tools,
  };
}

function toolExport(mod, name) {
  if (mod && typeof mod[name] === 'function') return mod[name];
  if (mod?.tools && typeof mod.tools[name] === 'function') return mod.tools[name];
  if (mod?.default && typeof mod.default[name] === 'function') return mod.default[name];
  if (mod?.default?.tools && typeof mod.default.tools[name] === 'function') return mod.default.tools[name];
  return null;
}

function failedPlugin(folder, err) {
  const id = path.basename(folder);
  return {
    id: PLUGIN_ID.test(id) ? id : `invalid-${id}`.slice(0, 64),
    name: id,
    description: '',
    version: '',
    source: 'local',
    enabled: true,
    loaded: false,
    error: String(err?.message || 'plugin failed to load').slice(0, 240),
    errorCode: err?.catalogCode || 'err_plugin_not_loadable',
    tools: [],
    handlers: [],
    validId: PLUGIN_ID.test(id),
  };
}

export async function readPlugin(dir) {
  const real = await fs.realpath(dir);
  const manifestPath = path.join(real, 'plugin.json');
  let raw;
  try {
    raw = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  } catch (err) {
    if (err?.code === 'ENOENT') throw catalogError(400, 'err_plugin_manifest_missing', 'plugin.json is missing');
    throw catalogError(400, 'err_plugin_invalid', 'plugin.json is not valid JSON');
  }
  const manifest = validateManifest(raw, real);
  const mainStat = await fs.stat(manifest.mainAbs).catch(() => {
    throw catalogError(400, 'err_plugin_not_loadable', 'plugin main module was not found');
  });
  if (!mainStat.isFile()) throw catalogError(400, 'err_plugin_not_loadable', 'plugin main module was not found');
  const manifestStat = await fs.stat(manifestPath);
  const stamp = `${manifestStat.mtimeMs}:${mainStat.mtimeMs}:${mainStat.size}`;
  const cached = cache.get(real);
  if (cached?.stamp === stamp) return cached.value;
  let mod;
  try {
    mod = await import(`${pathToFileURL(manifest.mainAbs).href}?t=${stamp}`);
  } catch (err) {
    const message = String(err?.message || 'import failed').replace(/file:\/\/\S+/g, '[module]').slice(0, 240);
    throw catalogError(400, 'err_plugin_not_loadable', message);
  }
  const handlers = [];
  for (const spec of manifest.tools) {
    const handler = toolExport(mod, spec.name);
    if (typeof handler !== 'function') {
      throw catalogError(400, 'err_plugin_not_loadable', `tool ${spec.name} is not exported`);
    }
    handlers.push({ ...spec, handler });
  }
  const value = {
    id: manifest.id,
    name: manifest.name,
    description: manifest.description,
    version: manifest.version,
    source: manifest.source,
    loaded: true,
    error: null,
    errorCode: null,
    tools: handlers.map(({ name, description }) => ({ name, description })),
    handlers,
    validId: true,
    dir: real,
  };
  cache.set(real, { stamp, value });
  return value;
}

async function tryReadPlugin(dir) {
  try {
    return await readPlugin(dir);
  } catch (err) {
    return failedPlugin(dir, err);
  }
}

export async function loadPlugins(dirs, enabledMap = {}) {
  const byId = new Map();
  for (const root of dirs || []) {
    const folders = await listPluginDirs(root);
    for (const folder of folders) {
      const plugin = await tryReadPlugin(folder);
      if (!plugin.validId) continue;
      byId.set(plugin.id, plugin);
    }
  }
  const ordered = [...byId.values()];
  const used = new Set(BUILTIN_TOOLS);
  return ordered.map((plugin) => {
    const enabled = enabledMap[plugin.id] !== false;
    let error = plugin.error;
    let errorCode = plugin.errorCode;
    let handlers = [];
    if (plugin.loaded && enabled) {
      const conflict = plugin.handlers.find((tool) => used.has(tool.name));
      if (conflict) {
        error = `tool ${conflict.name} is already registered`;
        errorCode = 'err_plugin_invalid';
      } else {
        handlers = plugin.handlers;
        for (const tool of handlers) used.add(tool.name);
      }
    }
    return {
      ...publicPlugin({ ...plugin, enabled, error, errorCode }),
      handlers,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

export async function describePlugins(dirs, enabledMap = {}) {
  const plugins = await loadPlugins(dirs, enabledMap);
  return plugins.map(({ handlers, ...plugin }) => plugin);
}

export async function pluginHandlers(dirs, enabledMap = {}) {
  const plugins = await loadPlugins(dirs, enabledMap);
  return plugins.flatMap((plugin) => (plugin.enabled && plugin.loaded ? plugin.handlers : []));
}

function assertImportAllowed(real) {
  const home = os.homedir();
  const banned = [path.join(home, '.ssh'), path.join(home, '.gnupg'), path.join(home, '.grok')];
  if (real === path.parse(real).root || banned.some((dir) => isInside(dir, real))) {
    throw catalogError(400, 'err_plugin_invalid', 'plugin path is not allowed');
  }
}

async function assertNoSymlinks(root) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(root, entry.name);
    const stat = await fs.lstat(full);
    if (stat.isSymbolicLink()) {
      throw catalogError(400, 'err_plugin_symlink', 'plugin directory must not contain symlinks');
    }
    if (stat.isDirectory()) await assertNoSymlinks(full);
  }
}

async function copyPluginTree(src, dest) {
  await fs.mkdir(dest, { recursive: true });
  let files = 0;
  let bytes = 0;
  async function walk(from, to) {
    const entries = await fs.readdir(from, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      const srcPath = path.join(from, entry.name);
      const destPath = path.join(to, entry.name);
      const stat = await fs.lstat(srcPath);
      if (stat.isSymbolicLink()) {
        throw catalogError(400, 'err_plugin_symlink', 'plugin directory must not contain symlinks');
      }
      if (stat.isDirectory()) {
        await fs.mkdir(destPath, { recursive: true });
        await walk(srcPath, destPath);
      } else if (stat.isFile()) {
        files += 1;
        bytes += stat.size;
        if (files > MAX_FILES || bytes > MAX_BYTES) {
          throw catalogError(400, 'err_plugin_too_large', 'plugin directory is too large');
        }
        await fs.copyFile(srcPath, destPath);
      }
    }
  }
  await walk(src, dest);
}

async function resolvePluginSource(sourcePath) {
  const raw = String(sourcePath || '').trim();
  if (!raw) throw catalogError(400, 'err_plugin_path_required', 'path is required');
  let abs;
  try {
    abs = await fs.realpath(path.resolve(raw));
  } catch {
    throw catalogError(400, 'err_plugin_dir_missing', 'plugin directory not found');
  }
  const stat = await fs.stat(abs);
  if (stat.isFile() && path.basename(abs) === 'plugin.json') abs = path.dirname(abs);
  else if (!stat.isDirectory()) throw catalogError(400, 'err_plugin_dir_missing', 'plugin directory not found');
  assertImportAllowed(abs);
  return abs;
}

export async function installPlugin(sourcePath, destRoot, { existingIds = new Set(), existingToolNames = new Set() } = {}) {
  const src = await resolvePluginSource(sourcePath);
  await assertNoSymlinks(src);
  const loaded = await readPlugin(src);
  if (existingIds.has(loaded.id)) throw catalogError(409, 'err_plugin_exists', 'plugin already exists');
  for (const tool of loaded.handlers) {
    if (existingToolNames.has(tool.name) || BUILTIN_TOOLS.includes(tool.name)) {
      throw catalogError(400, 'err_plugin_invalid', `tool ${tool.name} is already registered`);
    }
  }
  const dest = path.join(destRoot, loaded.id);
  if (isInside(destRoot, src) || isInside(src, destRoot)) {
    throw catalogError(400, 'err_plugin_invalid', 'plugin path is not allowed');
  }
  await fs.mkdir(destRoot, { recursive: true });
  try {
    await copyPluginTree(src, dest);
    const manifestPath = path.join(dest, 'plugin.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    manifest.source = 'imported';
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    clearPluginCache();
    const installed = await readPlugin(dest);
    return publicPlugin({ ...installed, enabled: true, source: 'imported' });
  } catch (err) {
    await fs.rm(dest, { recursive: true, force: true });
    throw err;
  }
}
