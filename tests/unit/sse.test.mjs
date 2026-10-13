import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from './_root.mjs';
const { formatSSE, parseSSE } = await load('src/core/sse.mjs');

test('format object event', () => {
  assert.equal(formatSSE({ id: 7, event: 'status', data: { status: 'running' } }),
    'id: 7\nevent: status\ndata: {"status":"running"}\n\n');
});
test('omit id when absent', () => {
  assert.equal(formatSSE({ event: 'x', data: { a: 1 } }), 'event: x\ndata: {"a":1}\n\n');
});
test('object with newlines stays single data line', () => {
  const s = formatSSE({ id: 1, event: 'message.delta', data: { text: 'a\nb\n\nc' } });
  assert.equal(s.split('\n').filter((l) => l.startsWith('data:')).length, 1);
  assert.ok(s.endsWith('\n\n') && !s.slice(0, -2).includes('\n\n'));
});
test('multiline string data split', () => {
  assert.equal(formatSSE({ event: 'e', data: 'l1\nl2' }), 'event: e\ndata: l1\ndata: l2\n\n');
});
test('roundtrip incl. unicode', () => {
  const evs = [
    { id: 1, event: 'tool.end', data: { tool: { name: 'write', path: 'src/中文.md', added: 3, removed: 1 } } },
    { id: 2, event: 'checkpoint', data: { at: 123, step: 4 } },
  ];
  assert.deepEqual(parseSSE(evs.map(formatSSE).join('')), evs);
});
