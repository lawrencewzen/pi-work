import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from './_root.mjs';
const { createRetryPolicy, decideAutoContinue } = await load('src/core/retry.mjs');
const p = () => createRetryPolicy({ maxAttempts: 4, baseMs: 100, maxMs: 1000 });
const err = (o) => Object.assign(new Error('x'), o);

test('retryable errors', () => {
  for (const e of [err({ code: 'ETIMEDOUT' }), err({ code: 'ECONNRESET' }), err({ code: 'E_STREAM_CUT' }),
    err({ code: 'E_EMPTY_OUTPUT' }), err({ status: 429 }), err({ status: 503 })])
    assert.equal(p().shouldRetry(e, 1), true, JSON.stringify(e));
});
test('non-retryable errors', () => {
  for (const e of [err({ status: 400 }), err({ status: 401 }), err({ status: 403 }), err({ code: 'E_SANDBOX' }), err({ code: 'E_ABORTED' }), err({ code: 'E_NO_MODEL' })])
    assert.equal(p().shouldRetry(e, 1), false);
});
test('attempt limit', () => {
  assert.equal(p().shouldRetry(err({ code: 'ETIMEDOUT' }), 3), true);
  assert.equal(p().shouldRetry(err({ code: 'ETIMEDOUT' }), 4), false);
});
test('exponential backoff capped', () => {
  const q = p();
  assert.deepEqual([1, 2, 3, 4, 5].map((n) => q.delayMs(n)), [100, 200, 400, 800, 1000]);
});
test('auto-continue decision', () => {
  const b = { lastProgressAt: 0, stallMs: 1000, autoContinues: 0, maxAutoContinues: 3 };
  assert.equal(decideAutoContinue({ ...b, now: 500, status: 'running' }), 'wait');
  assert.equal(decideAutoContinue({ ...b, now: 1500, status: 'running' }), 'continue');
  assert.equal(decideAutoContinue({ ...b, now: 1500, status: 'paused' }), 'wait');
  assert.equal(decideAutoContinue({ ...b, now: 1500, status: 'stopped' }), 'wait');
  assert.equal(decideAutoContinue({ ...b, now: 1500, status: 'running', autoContinues: 3 }), 'give_up');
});
