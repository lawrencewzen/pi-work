import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from './_root.mjs';

const { TOOLS } = await load('src/core/config.mjs');

test('TOOLS lists every builtin workspace tool', () => {
  assert.deepEqual(TOOLS, ['read', 'write', 'edit', 'ls', 'grep', 'bash']);
});
