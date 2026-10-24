import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { ROOT } from './_root.mjs';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://127.0.0.1/' });
globalThis.window = dom.window;

const { renderMarkdown } = await import('../../public/markdown.js');

function parse(md) {
  const html = renderMarkdown(md);
  return { html, body: new JSDOM(`<!doctype html><body>${html}</body>`).window.document.body };
}

test('empty input is empty html', () => {
  assert.equal(renderMarkdown(''), '');
  assert.equal(renderMarkdown(), '');
});

test('renders a GFM table', () => {
  const { body } = parse('| 列 | 值 |\n| --- | --- |\n| a | b |');
  const cells = [...body.querySelectorAll('table th, table td')].map((el) => el.textContent);
  assert.deepEqual(cells, ['列', '值', 'a', 'b']);
  assert.equal(body.querySelectorAll('p').length, 0);
});

test('renders a thematic break', () => {
  const { body } = parse('hello\n\n---\n\nworld');
  assert.equal(body.querySelectorAll('hr').length, 1);
  assert.match(body.textContent, /hello/);
  assert.match(body.textContent, /world/);
});

test('renders a blockquote', () => {
  const { body } = parse('> 引用 **说明**');
  const quote = body.querySelector('blockquote');
  assert.ok(quote);
  assert.equal(quote.querySelector('strong')?.textContent, '说明');
  assert.match(quote.textContent, /引用/);
});

test('renders nested lists', () => {
  const { body } = parse('- a\n  - b\n    - c');
  const top = body.querySelector('ul');
  assert.equal(top?.children[0]?.childNodes[0]?.textContent.trim(), 'a');
  assert.equal(body.querySelectorAll('ul').length, 3);
  assert.equal(body.querySelector('ul ul ul li')?.textContent.trim(), 'c');
});

test('renders a fenced code block with the language bar', () => {
  const { body } = parse('```js\nconsole.log(1)\n```');
  const card = body.querySelector('.code-block-card');
  assert.ok(card);
  assert.equal(card.querySelector('.code-block-bar span')?.textContent, 'js');
  assert.equal(card.querySelector('pre.code-block-pre code')?.textContent, 'console.log(1)');
});

test('renders a link with target and rel', () => {
  const { body } = parse('see [docs](https://example.com/path)');
  const a = body.querySelector('a');
  assert.equal(a?.getAttribute('href'), 'https://example.com/path');
  assert.equal(a?.getAttribute('target'), '_blank');
  assert.equal(a?.getAttribute('rel'), 'noopener noreferrer');
  assert.equal(a?.textContent, 'docs');
});

test('renders task lists', () => {
  const { body } = parse('- [ ] todo\n- [x] done');
  const items = body.querySelectorAll('ul.contains-task-list > li.task-list-item');
  assert.equal(items.length, 2);
  assert.equal(items[0].querySelector('input[type="checkbox"]')?.hasAttribute('checked'), false);
  assert.equal(items[1].querySelector('input[type="checkbox"]')?.hasAttribute('checked'), true);
  assert.ok(items[0].querySelector('input')?.disabled);
});

test('strips script tags', () => {
  const { html, body } = parse('hello <script>alert(1)</script> world');
  assert.equal(body.querySelectorAll('script').length, 0);
  assert.doesNotMatch(html, /<script/i);
  assert.match(body.textContent, /hello/);
  assert.match(body.textContent, /world/);
});

test('strips onerror handlers', () => {
  const { html, body } = parse('<img src=x onerror="alert(1)">');
  const img = body.querySelector('img');
  assert.equal(img?.hasAttribute('onerror'), false);
  assert.doesNotMatch(html, /onerror/i);
});

test('strips javascript: links', () => {
  const { html, body } = parse('[click](javascript:alert(1))');
  const a = body.querySelector('a');
  const href = a?.getAttribute('href') || '';
  assert.doesNotMatch(href, /javascript:/i);
  assert.doesNotMatch(html, /javascript:/i);
});

const STRIP = [
  'WEFT_LLM',
  'WEFT_FAUX_SCRIPT',
  'WEFT_FAUX_TEXT',
  'LLM_API',
  'LLM_API_KEY',
  'LLM_BASE_URL',
  'LLM_MODEL',
  'WEFT_GROK_AUTH',
  'GROK_HOME',
  'WEFT_TOKEN',
];

function childEnv(dataDir) {
  const env = { ...process.env };
  for (const key of STRIP) delete env[key];
  return {
    ...env,
    PORT: '0',
    WEFT_DATA_DIR: dataDir,
    WEFT_GROK_AUTH: path.join(dataDir, 'grok-auth.json'),
    WEFT_RETRY_BASE_MS: '20',
    WEFT_RETRY_MAX: '5',
  };
}

function stopProcess(proc) {
  return new Promise((resolve) => {
    if (proc.exitCode != null) return resolve();
    const timer = setTimeout(() => proc.kill('SIGKILL'), 2000);
    proc.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    proc.kill('SIGTERM');
  });
}

test('vendor ESM files are served locally and node_modules is not exposed', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-md-'));
  await writeFile(path.join(dataDir, 'grok-auth.json'), '{}\n', { mode: 0o600 });
  const proc = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    env: childEnv(dataDir),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  let base;
  try {
    base = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`server not ready:\n${log}`)), 20000);
      const onData = (buf) => {
        log += buf;
        const match = log.match(/WEFT_READY (http:\/\/\S+)/);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      };
      proc.stdout.on('data', onData);
      proc.stderr.on('data', onData);
      proc.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`server exited ${code}:\n${log}`));
      });
    });
    proc.removeAllListeners('exit');

    const markedRes = await fetch(`${base}/vendor/marked.esm.js`);
    assert.equal(markedRes.status, 200);
    assert.match(markedRes.headers.get('content-type') || '', /javascript/);
    const markedText = await markedRes.text();
    assert.match(markedText, /marked v18/);
    assert.doesNotMatch(markedText, /cdn\.jsdelivr|unpkg\.com|cdnjs/i);

    const purifyRes = await fetch(`${base}/vendor/purify.es.mjs`);
    assert.equal(purifyRes.status, 200);
    assert.match(purifyRes.headers.get('content-type') || '', /javascript/);
    const purifyText = await purifyRes.text();
    assert.match(purifyText, /DOMPurify 3\.4\.17/);
    assert.doesNotMatch(purifyText, /cdn\.jsdelivr|unpkg\.com|cdnjs/i);

    const missing = await fetch(`${base}/vendor/not-allowed.js`);
    const missingText = await missing.text();
    assert.doesNotMatch(missingText, /marked v18|DOMPurify/);

    const leaked = await fetch(`${base}/node_modules/marked/lib/marked.esm.js`);
    const leakedText = await leaked.text();
    assert.doesNotMatch(leakedText, /a markdown parser built for speed/i);
    assert.match(leakedText, /<html/i);
  } finally {
    await stopProcess(proc);
    await rm(dataDir, { recursive: true, force: true });
  }
});
