import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const execFileP = promisify(execFile);

function noDashComponents(s) {
  return String(s || '').split('/').filter(Boolean).every((p) => !p.startsWith('-'));
}

function hostOk(host) {
  const h = String(host || '');
  return h.length > 0 && !h.startsWith('-');
}

/**
 * Allowed clone URLs: https:, ssh:, git@host:path.
 * Reject file:, ext:, ftp:, http:, git:, and hosts/path components starting with `-`.
 */
export function validateGitUrl(url) {
  const s = String(url || '').trim();
  if (!s || s.length > 2048) return false;
  if (/[\0\n\r\s;|&$`<>]/.test(s)) return false;

  if (/^https:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      if (u.protocol !== 'https:') return false;
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

/** Strip `user:pass@` from https/ssh URLs so credentials are not stored or returned. */
export function stripGitUrlCredentials(url) {
  return String(url || '').replace(/^([a-z][a-z0-9+.-]*:\/\/)([^/@]+):([^/@]+)@/i, '$1');
}

/**
 * Clone with `git clone --depth 1` via execFile (no shell).
 * Destination is created as needed.
 */
export async function cloneGitRepo({ url, branch, dest }) {
  if (!validateGitUrl(url)) {
    const err = new Error('invalid gitUrl');
    err.status = 400;
    throw err;
  }
  if (!validateBranch(branch)) {
    const err = new Error('invalid branch');
    err.status = 400;
    throw err;
  }
  await mkdir(path.dirname(dest), { recursive: true });
  const args = [
    '-c', 'protocol.file.allow=never',
    '-c', 'protocol.ext.allow=never',
    'clone', '--depth', '1',
  ];
  if (branch) args.push('--branch', String(branch));
  args.push('--', String(url).trim(), dest);
  try {
    await execFileP('git', args, {
      timeout: 120_000,
      windowsHide: true,
      maxBuffer: 2_000_000,
      env: {
        PATH: '/usr/bin:/bin:/usr/local/bin',
        HOME: process.env.HOME || '',
        LANG: process.env.LANG || 'C.UTF-8',
        USER: process.env.USER || '',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: 'echo',
      },
    });
  } catch {
    const err = new Error('git clone failed');
    err.status = 400;
    throw err;
  }
  return dest;
}
