// Pure explore-target rules. The kernel's tool hooks call these; they do not run tools.

function stableStringify(value) {
  if (value == null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

export function toolSignature(name, args) {
  return `${String(name || '')}\u0000${stableStringify(args || {})}`;
}

const BASH_LIST = new Set(['ls', 'find', 'tree', 'dir']);
const BASH_SEARCH = new Set(['grep', 'rg', 'ag', 'ack']);
const BASH_READ = new Set(['cat', 'head', 'tail', 'less', 'more', 'bat', 'nl']);

function shellWords(command) {
  const words = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  const s = String(command || '');
  let match;
  while ((match = re.exec(s))) words.push(match[1] ?? match[2] ?? match[3]);
  return words;
}

export function normalizeExplorePath(value) {
  let p = String(value ?? '').trim().replaceAll('\\', '/');
  if (!p || p === '.') return '.';
  while (p.startsWith('./')) p = p.slice(2);
  p = p.replace(/\/+/g, '/');
  if (p.length > 1) p = p.replace(/\/+$/, '');
  return p || '.';
}

function bashExplorePath(command) {
  const raw = String(command || '').trim();
  if (!raw) return null;
  const first = raw.split(/\s*(?:&&|\|\||[|;\n])\s*/)[0];
  const tokens = shellWords(first);
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i += 1;
  const bin = String(tokens[i] || '').split(/[/\\]/).pop();
  if (!bin) return null;
  const rest = tokens.slice(i + 1).filter((token) => token && !token.startsWith('-'));
  if (BASH_LIST.has(bin)) return normalizeExplorePath(rest[0]);
  if (BASH_SEARCH.has(bin)) {
    if (rest.length >= 2) return normalizeExplorePath(rest[rest.length - 1]);
    return '.';
  }
  if (BASH_READ.has(bin)) {
    if (!rest.length) return null;
    return normalizeExplorePath(rest[rest.length - 1]);
  }
  return null;
}

/** Same file or directory, ignoring extra args such as grep pattern or ls flags. */
export function exploreTarget(name, args) {
  const tool = String(name || '');
  const obj = args && typeof args === 'object' ? args : {};
  if (tool === 'read' || tool === 'ls' || tool === 'grep') {
    return `${tool}\u0000${normalizeExplorePath(obj.path)}`;
  }
  if (tool === 'bash') {
    const pathKey = bashExplorePath(obj.command);
    return pathKey ? `bash\u0000${pathKey}` : null;
  }
  return null;
}

export function explorePathOf(target) {
  const raw = String(target || '');
  const i = raw.indexOf('\u0000');
  return i === -1 ? raw : raw.slice(i + 1);
}
