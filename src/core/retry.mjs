const RETRYABLE_CODES = new Set(['ETIMEDOUT', 'ECONNRESET', 'E_STREAM_CUT', 'E_EMPTY_OUTPUT']);
const NON_RETRYABLE_CODES = new Set(['E_SANDBOX', 'E_ABORTED']);
const NON_RETRYABLE_STATUS = new Set([400, 401, 403]);

function isRetryableError(err) {
  if (!err) return false;
  if (NON_RETRYABLE_CODES.has(err.code)) return false;
  if (NON_RETRYABLE_STATUS.has(err.status)) return false;
  if (RETRYABLE_CODES.has(err.code)) return true;
  const status = err.status;
  if (status === 429) return true;
  if (typeof status === 'number' && status >= 500 && status <= 599) return true;
  return false;
}

export function createRetryPolicy({ maxAttempts, baseMs, maxMs, factor = 2 } = {}) {
  const attempts = maxAttempts ?? 5;
  const base = baseMs ?? 100;
  const cap = maxMs ?? 30_000;
  const f = factor ?? 2;
  return {
    shouldRetry(err, attempt) {
      if (attempt >= attempts) return false;
      return isRetryableError(err);
    },
    delayMs(attempt) {
      const n = Math.max(1, attempt);
      return Math.min(cap, base * f ** (n - 1));
    },
  };
}

export function decideAutoContinue({ lastProgressAt, now, stallMs, status, autoContinues, maxAutoContinues }) {
  if (status !== 'running') return 'wait';
  if ((now - lastProgressAt) < stallMs) return 'wait';
  if ((autoContinues ?? 0) >= (maxAutoContinues ?? 0)) return 'give_up';
  return 'continue';
}
