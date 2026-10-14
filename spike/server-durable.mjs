/**
 * Pi Durable kernel spike. This file does not replace server.mjs.
 * The smoke test is `node spike/smoke.mjs`.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openKernel } from './lib/kernel.mjs';

export { openKernel };

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  console.log('pi-work spike: Pi Durable kernel');
  console.log(`node ${process.version} ${process.platform}`);
  console.log('Run the acceptance smoke test with: node spike/smoke.mjs');
}
