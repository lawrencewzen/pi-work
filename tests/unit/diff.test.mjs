import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from './_root.mjs';
const { diffStats, unifiedDiff } = await load('src/core/diff.mjs');

test('new file counts all lines added', () => {
  assert.deepEqual(diffStats(null, 'a\nb\nc\n'), { added: 3, removed: 0 });
  assert.deepEqual(diffStats('', 'a'), { added: 1, removed: 0 });
});
test('deleted content', () => {
  assert.deepEqual(diffStats('a\nb\n', ''), { added: 0, removed: 2 });
});
test('modification counts replaced lines on both sides', () => {
  assert.deepEqual(diffStats('a\nb\nc\n', 'a\nB\nc\nd\n'), { added: 2, removed: 1 });
});
test('identical and trailing-newline-only change is zero', () => {
  assert.deepEqual(diffStats('a\nb\n', 'a\nb\n'), { added: 0, removed: 0 });
  assert.deepEqual(diffStats('a\nb', 'a\nb\n'), { added: 0, removed: 0 });
});
test('CRLF treated same as LF', () => {
  assert.deepEqual(diffStats('a\r\nb\r\n', 'a\nb\n'), { added: 0, removed: 0 });
});
test('unifiedDiff has headers and hunks consistent with stats', () => {
  const u = unifiedDiff('src/x.md', 'a\nb\n', 'a\nc\n');
  assert.match(u, /^--- a\/src\/x\.md$/m);
  assert.match(u, /^\+\+\+ b\/src\/x\.md$/m);
  assert.match(u, /^@@ /m);
  assert.match(u, /^-b$/m);
  assert.match(u, /^\+c$/m);
});
