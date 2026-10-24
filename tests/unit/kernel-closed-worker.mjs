/**
 * Worker for the harness.closed unit test.
 * fail: a failed Session should log and exit the process.
 * close: a normal close must not exit on its own.
 */
import { watchHarnessClosed } from '../../src/kernel/index.mjs';

const mode = process.env.WEFT_KERNEL_MODE;

if (mode === 'fail') {
  watchHarnessClosed({
    closed: Promise.resolve({ reason: 'failed', error: new Error('disk full') }),
  });
  setInterval(() => {}, 1000);
} else if (mode === 'close') {
  watchHarnessClosed({
    closed: Promise.resolve({ reason: 'closed' }),
  });
  setTimeout(() => process.exit(0), 100);
} else {
  console.error(`unknown WEFT_KERNEL_MODE ${mode}`);
  process.exit(1);
}
