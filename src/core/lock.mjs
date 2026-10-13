import { existsSync, unlinkSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

function pidIsLive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    if (existsSync(path.join('/proc', String(pid)))) return true;
  } catch { /* no /proc */ }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

/**
 * Single-instance lock via O_EXCL (`wx`). Fails if the lock is held by a live pid.
 * Stale locks (dead pid) are removed and retried.
 */
export async function acquireDataDirLock(dataDir) {
  await fs.mkdir(dataDir, { recursive: true });
  const lockPath = path.join(dataDir, '.lock');
  for (let i = 0; i < 3; i++) {
    try {
      const fh = await fs.open(lockPath, 'wx', 0o600);
      await fh.writeFile(`${process.pid}\n`);
      try { await fh.chmod(0o600); } catch { /* ignore */ }
      const release = () => {
        try { unlinkSync(lockPath); } catch { /* ignore */ }
      };
      return {
        lockPath,
        fh,
        release,
      };
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      let pid = 0;
      try {
        pid = Number((await fs.readFile(lockPath, 'utf8')).trim().split(/\s+/)[0]);
      } catch { pid = 0; }
      if (pidIsLive(pid)) {
        const e = new Error(`data dir already in use by pid ${pid}`);
        e.code = 'E_LOCK';
        throw e;
      }
      try { await fs.unlink(lockPath); } catch { /* raced */ }
    }
  }
  const e = new Error('data dir already in use');
  e.code = 'E_LOCK';
  throw e;
}
