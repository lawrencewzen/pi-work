import { test } from 'node:test';
import assert from 'node:assert/strict';
import { explorePathOf, exploreTarget, normalizeExplorePath, toolSignature } from '../../src/core/explore.mjs';

test('explore targets ignore extra args and path spelling', () => {
  assert.equal(
    exploreTarget('grep', { pattern: '口令', path: './src/', glob: '*.mjs' }),
    exploreTarget('grep', { pattern: 'password', path: 'src' }),
  );
  assert.equal(
    exploreTarget('read', { path: '.\\src\\app.js', offset: 1 }),
    exploreTarget('read', { path: 'src/app.js', limit: 40 }),
  );
  assert.equal(exploreTarget('ls', {}), exploreTarget('ls', { path: './' }));
  assert.equal(
    exploreTarget('bash', { command: 'ls -la .' }),
    exploreTarget('bash', { command: 'grep -n 口令 ./' }),
  );
  assert.equal(exploreTarget('bash', { command: 'cat "src/app.js"' }), 'bash\u0000src/app.js');
  assert.equal(exploreTarget('bash', { command: 'git status' }), null);
  assert.equal(exploreTarget('write', { path: 'a.txt', content: 'x' }), null);
  assert.equal(explorePathOf(exploreTarget('read', { path: 'src/app.js' })), 'src/app.js');
  assert.equal(normalizeExplorePath('.\\src\\app.js'), 'src/app.js');
  assert.equal(toolSignature('ls', { path: '.' }), toolSignature('ls', { path: '.' }));
});
