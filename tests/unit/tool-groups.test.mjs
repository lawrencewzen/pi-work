import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clipOutputText,
  isProbeFailure,
  outputLineCount,
  relativizePath,
  relativizeText,
  summarizeToolGroup,
  toolDiffCounts,
  toolFileLabel,
  toolGroupKey,
  toolGroupPreview,
  toolResultHint,
  toolRowHeading,
  unwrapHarnessDiagnostics,
} from '../../public/tool-groups.js';

const zh = {
  tool_sum_join: ' · ',
  tool_sum_names_join: '、',
  tool_sum_read: '读了 {n} 个文件',
  tool_sum_read_one: '读了 {n} 个文件',
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
  tool_sum_changed: '改了 {names}',
  tool_sum_changed_more: '改了 {names} 等 {n} 个',
  tool_sum_ran: '运行 {names}',
  tool_sum_read_named: '读了 {names}',
  tool_sum_read_named_more: '读了 {names} 等 {n} 个文件',
  tool_sum_ls_named: '列出 {names}',
  tool_sum_ls_named_more: '列出 {names} 等 {n} 个目录',
  tool_sum_grep_named: '搜索 {query}',
  tool_err_enoent: '不存在',
  tool_err_eacces: '没有权限',
  tool_err_sandbox: '超出工作区',
  tool_err_eisdir: '是目录',
  tool_err_enotdir: '不是目录',
  tool_one_read: '读取了 {target}',
  tool_one_write: '写入了 {target}',
  tool_one_edit: '编辑了 {target}',
  tool_one_ls: '列出 {target}',
  tool_one_grep: '搜索了 {target}',
  tool_one_bash: '执行了 {target}',
  tool_one_other: '调用了 {name}',
  tool_one_other_target: '调用了 {name} {target}',
  tool_run_read: '正在读取 `{target}`…',
  tool_run_read_bare: '正在读取…',
  tool_run_write: '正在写入 `{target}`…',
  tool_run_write_bare: '正在写入…',
  tool_run_edit: '正在编辑 `{target}`…',
  tool_run_edit_bare: '正在编辑…',
  tool_run_ls: '正在列出 `{target}`…',
  tool_run_ls_bare: '正在列出…',
  tool_run_grep: '正在搜索 `{target}`…',
  tool_run_grep_bare: '正在搜索…',
  tool_run_bash: '正在运行 `{target}`…',
  tool_run_bash_bare: '正在运行…',
  tool_run_other: '正在调用 {name}',
  tool_run_other_target: '正在调用 {name} `{target}`…',
  tool_act_read: '读取',
  tool_act_write: '写入',
  tool_act_edit: '编辑',
  tool_act_ls: '列出',
  tool_act_grep: '搜索',
  tool_act_bash: '执行',
  tool_fail_named: '{action} {target} 失败',
  tool_fail_bare: '{action}失败',
  tool_hint_lines: '{n} 行',
  tool_hint_items: '{n} 项',
  tool_hint_matches: '{n} 处匹配',
  tool_hint_exit: '退出码 {code}',
};

const en = {
  tool_sum_join: ' · ',
  tool_sum_names_join: ', ',
  tool_sum_read: 'read {n} files',
  tool_sum_read_one: 'read {n} file',
  tool_sum_ls: 'listed {n} directories',
  tool_sum_ls_one: 'listed {n} directory',
  tool_sum_grep: 'searched {n} places',
  tool_sum_grep_one: 'searched {n} place',
  tool_sum_changed: 'changed {names}',
  tool_sum_changed_more: 'changed {names} and {n} more',
  tool_sum_ran: 'ran {names}',
  tool_sum_read_named: 'read {names}',
  tool_sum_read_named_more: 'read {names} and {n} files',
  tool_sum_ls_named: 'listed {names}',
  tool_sum_ls_named_more: 'listed {names} and {n} directories',
  tool_sum_grep_named: 'searched {query}',
  tool_err_enoent: 'does not exist',
  tool_err_eacces: 'permission denied',
  tool_err_sandbox: 'outside workspace',
  tool_err_eisdir: 'is a directory',
  tool_err_enotdir: 'is not a directory',
  tool_one_read: 'read {target}',
  tool_one_bash: 'ran {target}',
  tool_run_read: 'Reading `{target}`…',
  tool_run_bash: 'Running `{target}`…',
  tool_run_bash_bare: 'Running…',
  tool_act_read: 'Read',
  tool_act_bash: 'Run',
  tool_fail_named: '{action} {target} failed',
  tool_hint_lines: '{n} lines',
  tool_hint_items: '{n} items',
  tool_hint_matches: '{n} matches',
  tool_hint_exit: 'exit {code}',
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

test('six reads and one listing name the first files instead of counting only', () => {
  const tools = [
    ...['a.js', 'b.js', 'c.js', 'd.js', 'e.js', 'f.js'].map((path, i) => tool('read', { id: `r${i}`, path })),
    tool('ls', { id: 'ls1', path: 'src' }),
  ];
  const summary = summarizeToolGroup(tools, t);
  assert.equal(summary.text, '读了 a.js、b.js 等 6 个文件 · 列出 src');
  assert.equal(summary.failed, 0);
  assert.equal(summary.running, false);
});

test('changed files outrank failures, commands, and counts', () => {
  const summary = summarizeToolGroup([
    tool('read', { id: 'r1', path: 'a.js' }),
    tool('read', { id: 'r2', path: 'b.js' }),
    tool('bash', { id: 'b1', input: { command: 'npm test' } }),
    tool('bash', { id: 'b2', input: { command: 'npm run check --silent --extra-long-flag-name' } }),
    tool('edit', { id: 'e1', path: 'src/api/auth.ts' }),
    tool('write', { id: 'w1', path: 'src/store/redis.ts' }),
    tool('read', { id: 'r3', path: 'prompts', status: 'error' }),
  ], t);
  assert.equal(
    summary.text,
    '改了 auth.ts、redis.ts · 读取 prompts 失败 · 运行 npm test、npm run check --silent --extra-long-fla… · 读了 a.js、b.js',
  );
  assert.equal(summary.failed, 1);
});

test('more than three changed files add an etc count', () => {
  const summary = summarizeToolGroup([
    tool('write', { id: 'w1', path: 'a.ts' }),
    tool('edit', { id: 'e1', path: 'b.ts' }),
    tool('write', { id: 'w2', path: 'c.ts' }),
    tool('edit', { id: 'e2', path: 'd.ts' }),
    tool('write', { id: 'w3', path: 'e.ts' }),
  ], t);
  assert.equal(summary.text, '改了 a.ts、b.ts、c.ts 等 2 个');
});

test('commands are truncated to two, reads only count', () => {
  const summary = summarizeToolGroup([
    tool('bash', { id: 'b1', input: { command: 'npm test' } }),
    tool('bash', { id: 'b2', input: { command: 'npm run check' } }),
    tool('bash', { id: 'b3', input: { command: 'npm start' } }),
    tool('grep', { id: 'g1', input: { pattern: 'foo' } }),
    tool('ls', { id: 'ls1', path: 'src' }),
  ], t);
  assert.equal(summary.text, '运行 npm test、npm run check · 搜索 foo · 列出 src');
});

test('a single call names the file or command', () => {
  assert.equal(summarizeToolGroup([tool('read', { path: 'package.json' })], t).text, '读取了 package.json');
  assert.equal(
    summarizeToolGroup([tool('bash', { input: { command: 'npm test' } })], t).text,
    '运行 npm test',
  );
  assert.equal(summarizeToolGroup([tool('write', { path: 'src/api/auth.ts' })], t).text, '改了 auth.ts');
  assert.equal(summarizeToolGroup([tool('ls', { path: '.' })], t).text, '列出 1 个目录');
});

test('a description is the single-call summary, running action, and row title', () => {
  const bash = tool('bash', { input: { command: 'npm test', description: '跑单元测试' } });
  assert.equal(summarizeToolGroup([bash], t).text, '跑单元测试');
  assert.equal(
    summarizeToolGroup([tool('bash', { id: 'b1', input: bash.input, status: 'running' })], t).text,
    '跑单元测试',
  );
  assert.deepEqual(toolRowHeading(bash), { title: '跑单元测试', detail: 'npm test', intent: true });
  assert.equal(
    summarizeToolGroup([tool('read', { path: 'src/login.js', input: { path: 'src/login.js', description: '看登录逻辑' } })], t).text,
    '看登录逻辑',
  );
  assert.deepEqual(
    toolRowHeading(tool('read', { path: 'src/login.js', input: { path: 'src/login.js', description: '看登录逻辑' } })),
    { title: '看登录逻辑', detail: 'src/login.js', intent: true },
  );
  const runningGroup = summarizeToolGroup([
    tool('read', { id: 'r1', path: 'a.js' }),
    tool('bash', { id: 'b1', input: { command: 'npm test', description: '跑单元测试' }, status: 'running' }),
  ], t);
  assert.equal(runningGroup.text, '跑单元测试');
  assert.equal(runningGroup.running, true);
});

test('without a description, summaries and row titles stay on the command or path', () => {
  const bash = tool('bash', { input: { command: 'npm test' } });
  assert.equal(summarizeToolGroup([bash], t).text, '运行 npm test');
  assert.equal(
    summarizeToolGroup([tool('bash', { input: { command: 'npm test' }, status: 'running' })], t).text,
    '正在运行 `npm test`…',
  );
  assert.deepEqual(toolRowHeading(bash), { title: 'npm test', detail: '', intent: false });
  assert.deepEqual(
    toolRowHeading(tool('read', { path: 'app.js' })),
    { title: 'app.js', detail: '', intent: false },
  );
  assert.equal(
    summarizeToolGroup([tool('bash', { input: { command: 'npm test', description: '  ' } })], t).text,
    '运行 npm test',
  );
});

test('a group of several calls does not concatenate descriptions', () => {
  const summary = summarizeToolGroup([
    tool('bash', { id: 'b1', input: { command: 'npm test', description: '跑单元测试' } }),
    tool('bash', { id: 'b2', input: { command: 'npm run check', description: '做语法检查' } }),
  ], t);
  assert.equal(summary.text, '运行 npm test、npm run check');
});

test('a running call names the current step with ticks; failures stay counted', () => {
  const tools = [
    tool('read', { id: 'r1', path: 'a.js', status: 'completed' }),
    tool('read', { id: 'r2', path: 'missing.js', status: 'error' }),
    tool('read', { id: 'r3', path: 'src/cli/index.ts', status: 'running' }),
  ];
  const summary = summarizeToolGroup(tools, t);
  assert.equal(summary.text, '正在读取 `src/cli/index.ts`…');
  assert.equal(summary.running, true);
  assert.equal(summary.failed, 1);
  assert.equal(
    summarizeToolGroup([tool('bash', { input: { command: 'npm test' }, status: 'running' })], t).text,
    '正在运行 `npm test`…',
  );
});

test('a lone failure names the call', () => {
  const summary = summarizeToolGroup([
    tool('read', { path: 'prompts/system.md', status: 'error' }),
  ], t);
  assert.equal(summary.text, '读取 system.md 失败');
  assert.equal(summary.failed, 1);
});

test('a failed read or ls is a probe when a later call succeeded', () => {
  const probe = tool('ls', { id: 'ls1', path: 'src/commands', status: 'error' });
  const ok = tool('ls', { id: 'ls2', path: 'src/cli/commands' });
  const tools = [probe, ok];
  assert.equal(isProbeFailure(probe, tools), true);
  assert.equal(isProbeFailure(ok, tools), false);
  const summary = summarizeToolGroup(tools, t);
  assert.equal(summary.failed, 0);
  assert.equal(summary.text, '列出 commands');
  assert.equal(isProbeFailure(tool('read', { id: 'r1', path: 'missing.js', status: 'error' }), [
    tool('read', { id: 'r1', path: 'missing.js', status: 'error' }),
    tool('read', { id: 'r2', path: 'index.ts' }),
  ]), true);
});

test('the last failed call in a group is a real failure', () => {
  const first = tool('read', { id: 'r1', path: 'a.ts' });
  const last = tool('read', { id: 'r2', path: 'missing.ts', status: 'error' });
  const tools = [first, last];
  assert.equal(isProbeFailure(last, tools), false);
  const summary = summarizeToolGroup(tools, t);
  assert.equal(summary.failed, 1);
  assert.equal(summary.text, '读取 missing.ts 失败 · 读了 a.ts');
});

test('a failed write is a real failure even when a later call succeeded', () => {
  const write = tool('write', { id: 'w1', path: 'out.ts', status: 'error' });
  const read = tool('read', { id: 'r1', path: 'out.ts' });
  const tools = [write, read];
  assert.equal(isProbeFailure(write, tools), false);
  const summary = summarizeToolGroup(tools, t);
  assert.equal(summary.failed, 1);
  assert.match(summary.text, /写入 out\.ts 失败/);
});

test('a bash non-zero exit is a real failure', () => {
  const bash = tool('bash', {
    id: 'b1',
    input: { command: 'npm test' },
    output: '{"stdout":"","stderr":"failed","code":1}',
  });
  const read = tool('read', { id: 'r1', path: 'a.ts' });
  const tools = [bash, read];
  assert.equal(isProbeFailure(bash, tools), false);
  const summary = summarizeToolGroup(tools, t);
  assert.equal(summary.failed, 1);
  assert.match(summary.text, /执行 npm test 失败|执行失败/);
  const lastOnly = [tool('read', { id: 'r1', path: 'a.ts' }), bash];
  lastOnly[1] = tool('bash', {
    id: 'b1',
    input: { command: 'npm test' },
    status: 'error',
    output: '{"stdout":"","stderr":"failed","code":1}',
  });
  assert.equal(isProbeFailure(lastOnly[1], lastOnly), false);
  assert.equal(summarizeToolGroup(lastOnly, t).failed, 1);
});

test('two extra reads add an etc count; grep uses the first search term', () => {
  const summary = summarizeToolGroup([
    tool('read', { id: 'r1', path: 'src/index.ts' }),
    tool('read', { id: 'r2', path: 'src/probe.ts' }),
    tool('read', { id: 'r3', path: 'src/cli.ts' }),
    tool('grep', { id: 'g1', input: { pattern: 'CommandRegistry' } }),
    tool('grep', { id: 'g2', input: { pattern: 'unused' } }),
  ], t);
  assert.equal(summary.text, '读了 index.ts、probe.ts 等 3 个文件 · 搜索 CommandRegistry');
});

test('short file-error hints and workspace-relative paths', () => {
  const root = '/Users/me/proj';
  assert.equal(relativizePath('/Users/me/proj/src/commands', root), 'src/commands');
  assert.equal(relativizePath('src/commands', root), 'src/commands');
  assert.equal(relativizePath('/tmp/outside', root), '/tmp/outside');
  assert.equal(
    relativizeText("ENOENT: no such file or directory, open '/Users/me/proj/src/commands'", root),
    "ENOENT: no such file or directory, open 'src/commands'",
  );
  const opts = { workspacePath: root };
  assert.equal(toolResultHint(tool('read', {
    status: 'error',
    path: `${root}/src/commands`,
    output: `ENOENT: no such file or directory, open '${root}/src/commands'`,
  }), t, opts).text, '不存在');
  assert.equal(toolResultHint(tool('read', {
    status: 'error',
    output: 'EACCES: permission denied, open \'secret\'',
  }), t).text, '没有权限');
  assert.equal(toolResultHint(tool('read', {
    status: 'error',
    output: 'EPERM: operation not permitted',
  }), t).text, '没有权限');
  assert.equal(toolResultHint(tool('read', {
    status: 'error',
    output: 'E_SANDBOX: path outside workspace',
  }), t).text, '超出工作区');
  assert.equal(toolResultHint(tool('read', {
    status: 'error',
    output: 'EISDIR: illegal operation on a directory, read',
  }), t).text, '是目录');
  assert.equal(toolResultHint(tool('read', {
    status: 'error',
    output: 'ENOTDIR: not a directory, scandir \'file.ts\'',
  }), t).text, '不是目录');
  assert.equal(toolResultHint(tool('read', {
    status: 'error',
    output: 'EIO: i/o error, read',
  }), t).text, 'EIO: i/o error, read');
});

test('english summary capitalizes the first clause', () => {
  const te = translate(en);
  const summary = summarizeToolGroup([
    tool('read', { id: 'r1', path: 'a.js' }),
    tool('read', { id: 'r2', path: 'b.js' }),
    tool('ls', { id: 'ls1', path: 'src' }),
  ], te);
  assert.equal(summary.text, 'Read a.js, b.js · listed src');
  assert.equal(
    summarizeToolGroup([
      tool('edit', { id: 'e1', path: 'auth.ts' }),
      tool('write', { id: 'w1', path: 'redis.ts' }),
      tool('bash', { id: 'b1', input: { command: 'npm test' } }),
      tool('read', { id: 'r1', path: 'prompts', status: 'error' }),
    ], te).text,
    'Changed auth.ts, redis.ts · Read prompts failed · ran npm test',
  );
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
  const err = clipOutputText(lines.join('\n'), false, 8);
  assert.equal(err.text.split('\n').length, 8);
});

test('diff counts fall back to the write output line', () => {
  assert.deepEqual(toolDiffCounts({ added: 3, removed: 0 }), { added: 3, removed: 0 });
  assert.deepEqual(
    toolDiffCounts({ output: 'wrote docs/README.md (+3 −0)' }),
    { added: 3, removed: 0 },
  );
  assert.deepEqual(toolDiffCounts({ output: 'hello' }), { added: null, removed: null });
});

test('row hints report lines, items, matches, exit code, first output line, and failed first line', () => {
  assert.equal(toolResultHint(tool('read', { output: 'a\nb\nc\n' }), t).text, '3 行');
  assert.equal(toolResultHint(tool('ls', { output: 'd src\nf a.js\nf b.js' }), t).text, '3 项');
  assert.equal(toolResultHint(tool('grep', { output: 'a.js:1:foo\nb.js:2:foo' }), t).text, '2 处匹配');
  assert.equal(
    toolResultHint(tool('bash', { output: '{"stdout":"ok\\n","stderr":"","code":0}' }), t).text,
    '退出码 0',
  );
  assert.equal(
    toolResultHint(tool('bash', { output: '{"stdout":"first line of a long build log that should be trimmed a lot","stderr":"","code":null}' }), t).text.length <= 48,
    true,
  );
  const failed = toolResultHint(tool('read', {
    status: 'error',
    output: 'ENOENT: no such file or directory, open \'prompts\'\nmore',
  }), t);
  assert.equal(failed.failed, true);
  assert.equal(failed.text, '不存在');
  assert.equal(outputLineCount('a\nb\nc\n'), 3);
  assert.equal(toolFileLabel('src/api/auth.ts'), 'auth.ts');
});

test('harness diagnostic wrapping is stripped from failed hints; plain output is unchanged', () => {
  const wrapped = '<harness>\n[error] ENOENT: no such file or directory, open \'missing.txt\'\n</harness>';
  const failed = toolResultHint(tool('read', { status: 'error', output: wrapped }), t);
  assert.equal(failed.failed, true);
  assert.equal(failed.text, '不存在');
  assert.equal(
    unwrapHarnessDiagnostics(wrapped),
    'ENOENT: no such file or directory, open \'missing.txt\'',
  );
  assert.equal(
    unwrapHarnessDiagnostics('<harness>\n[warning] timed out\n[info] spilled to /tmp/out\n</harness>'),
    'timed out\nspilled to /tmp/out',
  );
  const plain = 'ENOENT: no such file or directory, open \'prompts\'\nmore';
  assert.equal(unwrapHarnessDiagnostics(plain), plain);
  assert.equal(
    unwrapHarnessDiagnostics('keep [error] in the body\n[error] this stays'),
    'keep [error] in the body\n[error] this stays',
  );
  const unwrappedFail = toolResultHint(tool('read', { status: 'error', output: plain }), t);
  assert.equal(unwrappedFail.text, '不存在');
});

test('long groups keep the last eight rows and hide the rest', () => {
  const tools = Array.from({ length: 11 }, (_, i) => tool('read', { id: `r${i}`, path: `f${i}.js` }));
  const preview = toolGroupPreview(tools, false);
  assert.equal(preview.hidden, 3);
  assert.deepEqual(preview.tools.map((item) => item.id), ['r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'r10']);
  assert.equal(toolGroupPreview(tools, true).hidden, 0);
  assert.equal(toolGroupPreview(tools.slice(0, 8), false).hidden, 0);
});

test('zh and en i18n dictionaries have the same keys', async () => {
  globalThis.localStorage = globalThis.localStorage || { getItem() { return null; }, setItem() {} };
  globalThis.document = globalThis.document || { documentElement: { lang: 'zh-CN' } };
  const { translations } = await import('../../public/i18n.js');
  const zhKeys = Object.keys(translations.zh).sort();
  const enKeys = Object.keys(translations.en).sort();
  assert.deepEqual(enKeys, zhKeys);
});
