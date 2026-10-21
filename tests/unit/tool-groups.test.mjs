import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clipOutputText,
  summarizeToolGroup,
  toolDiffCounts,
  toolGroupKey,
} from '../../public/tool-groups.js';

const zh = {
  tool_sum_join: '，',
  tool_sum_read: '读取了 {n} 个文件',
  tool_sum_read_one: '读取了 {n} 个文件',
  tool_sum_write: '写入了 {n} 个文件',
  tool_sum_write_one: '写入了 {n} 个文件',
  tool_sum_edit: '编辑了 {n} 个文件',
  tool_sum_edit_one: '编辑了 {n} 个文件',
  tool_sum_ls: '列出 {n} 个目录',
  tool_sum_ls_one: '列出 {n} 个目录',
  tool_sum_grep: '搜索了 {n} 处',
  tool_sum_grep_one: '搜索了 {n} 处',
  tool_sum_bash: '执行了 {n} 条命令',
  tool_sum_bash_one: '执行了 {n} 条命令',
  tool_sum_other: '调用了 {n} 次 {name}',
  tool_sum_other_one: '调用了 {n} 次 {name}',
  tool_one_read: '读取了 {target}',
  tool_one_write: '写入了 {target}',
  tool_one_edit: '编辑了 {target}',
  tool_one_ls: '列出 {target}',
  tool_one_grep: '搜索了 {target}',
  tool_one_bash: '执行了 {target}',
  tool_one_other: '调用了 {name}',
  tool_one_other_target: '调用了 {name} {target}',
  tool_run_read: '正在读取 {target}',
  tool_run_read_bare: '正在读取',
  tool_run_write: '正在写入 {target}',
  tool_run_write_bare: '正在写入',
  tool_run_edit: '正在编辑 {target}',
  tool_run_edit_bare: '正在编辑',
  tool_run_ls: '正在列出 {target}',
  tool_run_ls_bare: '正在列出',
  tool_run_grep: '正在搜索 {target}',
  tool_run_grep_bare: '正在搜索',
  tool_run_bash: '正在执行 {target}',
  tool_run_bash_bare: '正在执行',
  tool_run_other: '正在调用 {name}',
  tool_run_other_target: '正在调用 {name} {target}',
};

const en = {
  tool_sum_join: ', ',
  tool_sum_read: 'read {n} files',
  tool_sum_read_one: 'read {n} file',
  tool_sum_write: 'wrote {n} files',
  tool_sum_write_one: 'wrote {n} file',
  tool_sum_edit: 'edited {n} files',
  tool_sum_edit_one: 'edited {n} file',
  tool_sum_ls: 'listed {n} directories',
  tool_sum_ls_one: 'listed {n} directory',
  tool_sum_grep: 'searched {n} places',
  tool_sum_grep_one: 'searched {n} place',
  tool_sum_bash: 'ran {n} commands',
  tool_sum_bash_one: 'ran {n} command',
  tool_sum_other: 'called {name} {n} times',
  tool_sum_other_one: 'called {name} once',
  tool_one_read: 'read {target}',
  tool_one_bash: 'ran {target}',
  tool_run_read: 'reading {target}',
  tool_run_bash: 'running {target}',
  tool_run_bash_bare: 'running a command',
};

function translate(dict) {
  return (key, vars = {}) => {
    let text = dict[key] || key;
    for (const [name, value] of Object.entries(vars)) {
      text = text.replaceAll(`{${name}}`, String(value));
    }
    return text;
  };
}

const t = translate(zh);

function tool(name, extra = {}) {
  return { id: extra.id || name, name, status: extra.status || 'completed', ...extra };
}

test('six reads and one listing collapse to one Chinese sentence', () => {
  const tools = [
    ...['a.js', 'b.js', 'c.js', 'd.js', 'e.js', 'f.js'].map((path, i) => tool('read', { id: `r${i}`, path })),
    tool('ls', { id: 'ls1', path: 'src' }),
  ];
  const summary = summarizeToolGroup(tools, t);
  assert.equal(summary.text, '读取了 6 个文件，列出 1 个目录');
  assert.equal(summary.failed, 0);
  assert.equal(summary.running, false);
});

test('commands and an edit keep first-seen order', () => {
  const summary = summarizeToolGroup([
    tool('bash', { id: 'b1', input: { command: 'npm test' } }),
    tool('bash', { id: 'b2', input: { command: 'npm run check' } }),
    tool('edit', { id: 'e1', path: 'src/app.js' }),
  ], t);
  assert.equal(summary.text, '执行了 2 条命令，编辑了 1 个文件');
});

test('a single call names the file or command', () => {
  assert.equal(summarizeToolGroup([tool('read', { path: 'package.json' })], t).text, '读取了 package.json');
  assert.equal(
    summarizeToolGroup([tool('bash', { input: { command: 'npm test' } })], t).text,
    '执行了 npm test',
  );
  assert.equal(summarizeToolGroup([tool('ls', { path: '.' })], t).text, '列出 1 个目录');
});

test('a running call replaces the count and a failure is counted separately', () => {
  const tools = [
    tool('read', { id: 'r1', path: 'a.js', status: 'completed' }),
    tool('read', { id: 'r2', path: 'missing.js', status: 'error' }),
    tool('read', { id: 'r3', path: 'src/cli/index.ts', status: 'running' }),
  ];
  const summary = summarizeToolGroup(tools, t);
  assert.equal(summary.text, '正在读取 src/cli/index.ts');
  assert.equal(summary.running, true);
  assert.equal(summary.failed, 1);
});

test('english summary capitalizes the first clause', () => {
  const summary = summarizeToolGroup([
    tool('read', { id: 'r1', path: 'a.js' }),
    tool('read', { id: 'r2', path: 'b.js' }),
    tool('ls', { id: 'ls1', path: 'src' }),
  ], translate(en));
  assert.equal(summary.text, 'Read 2 files, listed 1 directory');
});

test('assistant text splits tool runs; the group key stays on the first call', () => {
  const first = [{ id: 'a', name: 'read' }, { id: 'b', name: 'read' }];
  const grown = [...first, { id: 'z', name: 'ls' }];
  assert.equal(toolGroupKey(first), toolGroupKey(grown));
  assert.equal(toolGroupKey(first), 'g:a');
});

test('output clips to 20 lines until show-all', () => {
  const lines = Array.from({ length: 25 }, (_, i) => `L${String(i + 1).padStart(2, '0')}`);
  const clipped = clipOutputText(lines.join('\n'), false);
  assert.equal(clipped.clipped, true);
  assert.equal(clipped.text.split('\n').length, 20);
  assert.equal(clipped.text.includes('L21'), false);
  const full = clipOutputText(lines.join('\n'), true);
  assert.equal(full.clipped, false);
  assert.equal(full.text.includes('L25'), true);
  assert.equal(clipOutputText('one\ntwo', false).clipped, false);
});

test('diff counts fall back to the write output line', () => {
  assert.deepEqual(toolDiffCounts({ added: 3, removed: 0 }), { added: 3, removed: 0 });
  assert.deepEqual(
    toolDiffCounts({ output: 'wrote docs/README.md (+3 −0)' }),
    { added: 3, removed: 0 },
  );
  assert.deepEqual(toolDiffCounts({ output: 'hello' }), { added: null, removed: null });
});
