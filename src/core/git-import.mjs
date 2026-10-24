import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { buildConnectionCloneEnv, redactSecrets, sanitizeConnectionCloneUrl } from './git-connection-clone.mjs';

const execFileP = promisify(execFile);

const CLONE_TIMEOUT_MS = 120_000;
const SET_URL_TIMEOUT_MS = 30_000;

const DROPPED_ENV = new Set([
  'git_config_nosystem',
  'git_askpass',
  'git_askpass_require',
  'ssh_askpass',
  'ssh_askpass_require',
]);

function noDashComponents(s) {
  return String(s || '').split('/').filter(Boolean).every((p) => !p.startsWith('-'));
}

function hostOk(host) {
  const h = String(host || '');
  return h.length > 0 && !h.startsWith('-');
}

export function parseHttpHostAllowlist(value) {
  return String(value ?? '')
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

function httpHostsFrom(opts) {
  if (Array.isArray(opts.httpHosts)) return opts.httpHosts.map((h) => String(h).trim().toLowerCase()).filter(Boolean);
  const env = Object.prototype.hasOwnProperty.call(opts, 'env') ? opts.env : process.env;
  return parseHttpHostAllowlist(env?.WEFT_GIT_HTTP_HOSTS);
}

/**
 * Allowed clone URLs: https:, ssh:, git@host:path, and http: for hosts in
 * WEFT_GIT_HTTP_HOSTS. Reject file:, ext:, ftp:, git:, and hosts or path
 * components that start with `-`.
 */
export function validateGitUrl(url, opts = {}) {
  const s = String(url || '').trim();
  if (!s || s.length > 2048) return false;
  if (/[\0\n\r\s;|&$`<>]/.test(s)) return false;

  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      if (u.protocol === 'http:') {
        const allowed = httpHostsFrom(opts);
        if (!allowed.includes(u.hostname.toLowerCase())) return false;
      } else if (u.protocol !== 'https:') {
        return false;
      }
      if (!hostOk(u.hostname)) return false;
      if (!noDashComponents(u.pathname)) return false;
      return true;
    } catch {
      return false;
    }
  }

  if (/^ssh:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      if (u.protocol !== 'ssh:') return false;
      if (!hostOk(u.hostname)) return false;
      if (!noDashComponents(u.pathname)) return false;
      return true;
    } catch {
      return false;
    }
  }

  const m = s.match(/^git@([^:]+):(.+)$/);
  if (m) {
    if (!hostOk(m[1])) return false;
    if (!noDashComponents(m[2])) return false;
    return true;
  }
  return false;
}

export function validateBranch(branch) {
  if (branch == null || branch === '') return true;
  const s = String(branch);
  if (s.startsWith('-')) return false;
  return /^[A-Za-z0-9._/\-]+$/.test(s) && s.length <= 200;
}

/** Strip `user:pass@` from https/ssh/http URLs so credentials are not stored or returned. */
export function stripGitUrlCredentials(url) {
  return String(url || '').replace(/^([a-z][a-z0-9+.-]*:\/\/)([^/@]+):([^/@]+)@/i, '$1');
}

export function resolveGitBin(env = process.env) {
  const bin = String(env?.WEFT_GIT_BIN || '').trim();
  return bin || 'git';
}

export function resolveGitCaFile(env = process.env) {
  const file = String(env?.WEFT_GIT_CA_FILE || '').trim();
  return file || null;
}

/**
 * Child environment for git. Copied from the server process so Windows can
 * find git.exe, Git Credential Manager, and the user's SSH keys.
 * GIT_ASKPASS is not set: `echo` is not an executable on Windows.
 * GIT_SSH_COMMAND is not set: it would override the user's core.sshCommand.
 * Prompts are turned off with GIT_TERMINAL_PROMPT and GCM_INTERACTIVE.
 * LANG/LC_ALL/LANGUAGE are pinned so error text stays English (gettext
 * prefers LANGUAGE) without dropping UTF-8 paths.
 */
export function buildGitChildEnv(base = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(base || {})) {
    if (value == null) continue;
    if (DROPPED_ENV.has(key.toLowerCase())) continue;
    env[key] = String(value);
  }
  env.GIT_TERMINAL_PROMPT = '0';
  env.GCM_INTERACTIVE = 'never';
  env.LANG = 'C.UTF-8';
  env.LC_ALL = 'C.UTF-8';
  env.LANGUAGE = 'C';
  return env;
}

export function buildCloneArgs({ url, branch, dest, caFile } = {}) {
  const args = [
    '-c', 'protocol.file.allow=never',
    '-c', 'protocol.ext.allow=never',
  ];
  const ca = String(caFile || '').trim();
  if (ca) args.push('-c', `http.sslCAInfo=${ca}`);
  // An empty credential.helper resets the helper list for this command only.
  // A user:token in the URL would otherwise be stored by osxkeychain or Git
  // Credential Manager. URLs without embedded credentials keep the local helper.
  if (credentialMarkers(url).length) args.push('-c', 'credential.helper=');
  args.push('clone', '--depth', '1');
  if (branch) args.push('--branch', String(branch));
  args.push('--', String(url ?? '').trim(), dest);
  return args;
}

export function prepareGitClone({ url, branch, dest, env = process.env } = {}) {
  return {
    bin: resolveGitBin(env),
    args: buildCloneArgs({
      url,
      branch,
      dest,
      caFile: resolveGitCaFile(env),
    }),
    env: buildGitChildEnv(env),
  };
}

export function redactGitOutput(text) {
  let s = String(text || '');
  s = s.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+:[^/\s@]+@/gi, '$1');
  s = s.replace(/([?&](?:access_token|token|password|passwd|secret)=)[^&\s]+/gi, '$1***');
  s = s.replace(/(Authorization:\s*(?:Basic|Bearer)\s+)\S+/gi, '$1***');
  s = s.replace(/\b(glpat-|gldt-|ghp_|gho_|ghu_|ghs_|github_pat_|glptt-)[A-Za-z0-9_-]+/g, '$1***');
  return s;
}

function stderrTail(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim());
  return lines.slice(-8).join('\n').slice(-800);
}

export function classifyCloneFailure(err) {
  if (err?.code === 'ENOENT') return { code: 'git_not_found' };
  const message = String(err?.message || '');
  if (/spawn\b.*\bENOENT\b/.test(message) || /\bENOENT\b/.test(message)) {
    return { code: 'git_not_found' };
  }
  if (err?.killed || err?.code === 'ETIMEDOUT') return { code: 'timeout' };

  const text = redactGitOutput(`${err?.stderr || ''}\n${err?.stdout || ''}`);
  const low = text.toLowerCase();

  if (/ssl certificate|certificate problem|self[- ]signed certificate|unable to get local issuer|sec_e_untrusted_root|schannel|certificate verify failed|server certificate verification failed|证书/.test(low)) {
    return { code: 'cert_failed' };
  }
  if (/authentication failed|terminal prompts disabled|could not read username|could not read password|permission denied \(publickey\)|http basic: access denied|authentication required|invalid username or password|support for password authentication was removed|the requested url returned error: 401\b|the requested url returned error: 403\b|认证失败|终端提示已禁用|无法读取.+用户名|无法读取.+密码/.test(low)) {
    return { code: 'auth_failed' };
  }
  if (/remote branch .+ not found|could not find remote branch|couldn't find remote ref|远程分支/.test(low)) {
    return { code: 'branch_not_found' };
  }
  if (/repository ['"][^'"]+['"] not found|does not appear to be a git repository|not a git repository|the requested url returned error: 404\b|仓库.+未找到/.test(low)) {
    return { code: 'repo_not_found' };
  }
  if (/could not resolve host|could not resolve hostname|failed to connect|couldn't connect|connection refused|connection timed out|network is unreachable|temporary failure in name resolution|no route to host|operation timed out|the requested url returned error: 50[234]\b|无法解析主机|连接被拒绝/.test(low)) {
    return { code: 'network' };
  }
  if (/could not read from remote repository/.test(low) && /correct access rights/.test(low)) {
    return { code: 'auth_failed' };
  }

  const detail = stderrTail(text);
  return detail ? { code: 'unknown', detail } : { code: 'unknown' };
}

function credentialMarkers(url) {
  const m = String(url || '').trim().match(/^[a-z][a-z0-9+.-]*:\/\/([^/\s@]+):([^/\s@]+)@/i);
  if (!m) return [];
  const user = m[1];
  const pass = m[2];
  let decoded = pass;
  try { decoded = decodeURIComponent(pass); } catch { /* keep raw */ }
  const markers = [`${user}:${pass}@`];
  if (decoded !== pass) markers.push(`${user}:${decoded}@`);
  if (pass.length >= 6) markers.push(pass);
  if (decoded.length >= 6 && decoded !== pass) markers.push(decoded);
  return markers;
}

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function cloneError(gitCode, detail) {
  const err = new Error('git clone failed');
  err.status = 400;
  err.gitCode = gitCode;
  if (detail) err.detail = detail;
  return err;
}

function toCloneError(err) {
  const classified = classifyCloneFailure(err);
  return cloneError(classified.code, classified.code === 'unknown' ? classified.detail : undefined);
}

async function runGit(bin, args, env, timeout) {
  return execFileP(bin, args, {
    timeout,
    windowsHide: true,
    maxBuffer: 2_000_000,
    env,
  });
}

async function removeDest(dest) {
  if (!dest) return;
  await rm(dest, { recursive: true, force: true }).catch(() => {});
}

async function assertConfigClean(dest, url) {
  const markers = credentialMarkers(url);
  if (!markers.length) return;
  let cfg = '';
  try {
    cfg = await readFile(path.join(dest, '.git', 'config'), 'utf8');
  } catch {
    await removeDest(dest);
    throw cloneError('unknown', 'could not read origin url after clone');
  }
  if (markers.some((marker) => cfg.includes(marker))) {
    await removeDest(dest);
    throw cloneError('unknown', 'origin url still contained credentials');
  }
}

function scrubCloneError(err, token) {
  if (!token) return err;
  const scrub = (value) => redactSecrets(typeof value === 'string' ? value : String(value || ''), [token]);
  err.stderr = scrub(err?.stderr);
  err.stdout = scrub(err?.stdout);
  err.message = scrub(err?.message);
  return err;
}

async function assertTokenNotInConfig(dest, token) {
  if (!token) return;
  let cfg = '';
  try {
    cfg = await readFile(path.join(dest, '.git', 'config'), 'utf8');
  } catch {
    await removeDest(dest);
    throw cloneError('unknown');
  }
  if (cfg.includes(token) || /authorization:\s*bearer/i.test(cfg)) {
    await removeDest(dest);
    throw cloneError('unknown');
  }
}

/**
 * Clone with `git clone --depth 1` via execFile (no shell).
 * Destination parent is created as needed.
 * When the URL embeds user:pass, credential helpers are disabled for this clone
 * and origin is rewritten to the stripped URL.
 * A connection token is passed only as GIT_CONFIG_VALUE_* (`http.extraHeader`
 * `Authorization: Bearer`), with `credential.helper` cleared for that command.
 */
export async function cloneGitRepo({ url, branch, dest, env = process.env, connection } = {}) {
  let trimmed = String(url || '').trim();
  if (connection) trimmed = sanitizeConnectionCloneUrl(trimmed, connection);
  const validateEnv = connection && /^http:\/\//i.test(trimmed)
    ? { ...env, WEFT_GIT_HTTP_HOSTS: new URL(trimmed).hostname }
    : env;
  if (!validateGitUrl(trimmed, { env: validateEnv })) throw badRequest('invalid gitUrl');
  if (!validateBranch(branch)) throw badRequest('invalid branch');

  const token = String(connection?.token || '');
  const connectionCa = String(connection?.caFile || '').trim();
  await mkdir(path.dirname(dest), { recursive: true });
  const plan = prepareGitClone({
    url: trimmed,
    branch,
    dest,
    env: connectionCa ? { ...env, WEFT_GIT_CA_FILE: connectionCa } : env,
  });
  const childEnv = token || connectionCa
    ? buildConnectionCloneEnv(plan.env, { token, caFile: connectionCa, origin: new URL(trimmed).origin })
    : plan.env;
  if (token && plan.args.some((arg) => String(arg).includes(token))) throw cloneError('unknown');
  try {
    await runGit(plan.bin, plan.args, childEnv, CLONE_TIMEOUT_MS);
  } catch (err) {
    if (token || credentialMarkers(trimmed).length) await removeDest(dest);
    throw toCloneError(scrubCloneError(err, token));
  }

  const clean = stripGitUrlCredentials(trimmed);
  if (clean !== trimmed) {
    const args = [
      '-c', 'protocol.file.allow=never',
      '-c', 'protocol.ext.allow=never',
      '-C', dest,
      'remote', 'set-url', 'origin', clean,
    ];
    try {
      await runGit(plan.bin, args, childEnv, SET_URL_TIMEOUT_MS);
    } catch (err) {
      await removeDest(dest);
      throw toCloneError(scrubCloneError(err, token));
    }
    await assertConfigClean(dest, trimmed);
  }
  await assertTokenNotInConfig(dest, token);
  return dest;
}
