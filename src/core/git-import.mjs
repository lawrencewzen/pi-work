import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const execFileP = promisify(execFile);

/**
 * Allowed clone URLs: https, ssh, git@host:path, file.
 * Reject anything that looks like a shell metacharacter payload.
 */
export function validateGitUrl(url) {
  const s = String(url || '').trim();
  if (!s || s.length > 2048) return false;
  if (/[\0\n\r\s;|&$`<>]/.test(s)) return false;
  if (/^https:\/\//i.test(s)) return true;
  if (/^ssh:\/\//i.test(s)) return true;
  if (/^file:\/\//i.test(s)) return true;
  if (/^git@[\w.-]+:/.test(s)) return true;
  return false;
}

export function validateBranch(branch) {
  if (branch == null || branch === '') return true;
  return /^[A-Za-z0-9._/\-]+$/.test(String(branch)) && String(branch).length <= 200;
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
  const args = ['clone', '--depth', '1'];
  if (branch) args.push('--branch', String(branch));
  args.push(String(url).trim(), dest);
  try {
    await execFileP('git', args, {
      timeout: 120_000,
      windowsHide: true,
      maxBuffer: 2_000_000,
    });
  } catch (e) {
    const detail = String(e?.stderr || e?.message || 'git clone failed').trim().slice(0, 500);
    const err = new Error(detail || 'git clone failed');
    err.status = 400;
    throw err;
  }
  return dest;
}
