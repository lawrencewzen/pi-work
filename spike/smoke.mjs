/**
 * Acceptance smoke test for the Pi Durable kernel spike (T5-0, items 1a–1h).
 * Prints a redacted log. SQLite files stay in a temp directory.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { AssistantEntry } from '@earendil-works/pi-durable';
import { startFakeModel } from './lib/fake-http.mjs';
import { openKernel } from './lib/kernel.mjs';
import { createGrokProxyProvider, createOpenAICompatProvider } from './lib/providers.mjs';
import { loadRoles, repoRoot } from './lib/roles.mjs';
import { Roster } from './lib/subagents.mjs';
import { redact, sleep, textOf, withTimeout } from './lib/text.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const lines = [];
const roles = await loadRoles();

function log(line) {
  const safe = redact(line);
  lines.push(safe);
  console.log(safe);
}

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function tool(name, args, id) {
  return fauxAssistantMessage([fauxToolCall(name, args, { id })], { stopReason: 'toolUse' });
}

function sayText(text) {
  return fauxAssistantMessage([fauxText(text)]);
}

function script(steps) {
  const faux = fauxProvider();
  let index = 0;
  const next = () => steps[Math.min(index++, steps.length - 1)];
  faux.setResponses(Array.from({ length: steps.length + 8 }, () => next));
  const models = createModels();
  models.setProvider(faux.provider);
  return { faux, models, model: { provider: 'faux', modelId: 'faux-1' } };
}

function routed(route) {
  const faux = fauxProvider();
  faux.setResponses(Array.from({ length: 40 }, () => route));
  const models = createModels();
  models.setProvider(faux.provider);
  return { models, model: { provider: 'faux', modelId: 'faux-1' } };
}

function lastTurn(request) {
  const messages = request.messages || [];
  const message = [...messages].reverse().find((item) => item && item.role !== 'system');
  return { message, text: textOf(message) };
}

async function answerOf(kernel, conversation, settled) {
  if (settled.status !== 'done' || settled.type !== 'input') {
    const detail = settled.detail === undefined ? '' : JSON.stringify(settled.detail);
    throw new Error(`submission ${settled.status} ${settled.reason || ''} ${detail}`);
  }
  const entry = await conversation.commit((tx) => tx.entry(AssistantEntry, settled.answer), kernel.context);
  return textOf(entry?.model?.[0]);
}

async function say(kernel, conversation, text) {
  const submission = await conversation.submit({ type: 'input', content: text }, kernel.context);
  const settled = await withTimeout(submission.wait(kernel.context), 20_000, text);
  return answerOf(kernel, conversation, settled);
}

async function joined(kernel, conversation) {
  const page = await conversation.entries({ order: 'ascending' }, 200, undefined, kernel.context);
  return page.items.map((entry) => textOf(entry.model?.[0])).join('\n');
}

async function settleBackground(kernel) {
  const snap = await kernel.harness.snapshot(Roster, kernel.root.id, kernel.context);
  for (const id of Object.values(snap?.reporters || {})) {
    await withTimeout(kernel.harness.waitForTask(id, kernel.context), 20_000, `reporter ${id}`);
  }
  await withTimeout(kernel.root.waitForIdle(kernel.context), 20_000, 'idle');
  await sleep(50);
}

function tickCount(file) {
  return readFile(file, 'utf8').then((text) => text.split('\n').filter(Boolean).length, () => 0);
}

async function waitForFile(file, ms) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    try {
      await access(file);
      return;
    } catch {
      await sleep(30);
    }
  }
  throw new Error(`timeout waiting for ${file}`);
}

async function withTemp(prefix, fn) {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  const kernel = { current: null };
  try {
    return await fn(dir, (opened) => { kernel.current = opened; });
  } finally {
    if (kernel.current) await kernel.current.close().catch(() => {});
  }
}

async function sectionStorage() {
  log('=== 1a storage ===');
  await withTemp('pi-spike-1a-', async (dir, track) => {
    const { models, model } = script([sayText('unused')]);
    const workspace = path.join(dir, 'ws');
    await mkdir(workspace);
    const first = await openKernel({
      dataDir: path.join(dir, 'data'),
      workspacePath: workspace,
      model,
      models,
      getRole: (id) => roles.get(id),
      onLine: (line) => log(`1a ${line}`),
    });
    track(first);
    const id = first.root.id;
    log(`1a root ${id}`);
    await first.close();
    track(null);
    const second = await openKernel({
      dataDir: path.join(dir, 'data'),
      workspacePath: workspace,
      model,
      models,
      getRole: (id) => roles.get(id),
      onLine: (line) => log(`1a-reopen ${line}`),
    });
    track(second);
    const inspection = await second.harness.inspect(second.context);
    log(`1a reopen root ${second.root.id} scheduling=${inspection.scheduling} tasks=${inspection.tasks.length}`);
    check(second.root.id === id, 'reopen created a different root conversation');
    check(inspection.scheduling === 'running', 'resume did not start the scheduler');
  });
}

async function sectionProviders() {
  log('=== 1b providers ===');
  const openai = await startFakeModel({
    mode: 'openai',
    expectKey: 'spike-openai-key',
    text: 'pong-openai',
  });
  const grok = await startFakeModel({
    mode: 'grok',
    text: 'pong-grok',
    access1: 'spike-access-1',
    access2: 'spike-access-2',
  });
  try {
    await withTemp('pi-spike-openai-', async (dir, track) => {
      const provider = createOpenAICompatProvider({
        baseUrl: openai.baseUrl,
        apiKey: 'spike-openai-key',
      });
      const models = createModels();
      models.setProvider(provider);
      const workspace = path.join(dir, 'ws');
      await mkdir(workspace);
      const kernel = await openKernel({
        dataDir: path.join(dir, 'data'),
        workspacePath: workspace,
        model: { provider: 'openai-compat', modelId: 'spike-compat' },
        models,
        getRole: (id) => roles.get(id),
        onLine: (line) => log(`openai ${line}`),
      });
      track(kernel);
      const answer = await say(kernel, kernel.root, 'ping openai');
      log(`1b openai answer ${answer}`);
      check(answer.includes('pong-openai'), `openai answer was ${answer}`);
      const hit = openai.seen.find((item) => item.path.endsWith('/chat/completions'));
      log(`1b openai request ${JSON.stringify(hit)}`);
      check(hit?.keyMatched === true, 'openai request did not present the configured key');
    });

    await withTemp('pi-spike-grok-', async (dir, track) => {
      const grokProvider = createGrokProxyProvider({
        baseUrl: grok.baseUrl,
        tokenUrl: grok.tokenUrl,
        accessToken: 'spike-access-1',
        refreshToken: 'spike-refresh-1',
      });
      const models = createModels();
      models.setProvider(grokProvider.provider);
      const workspace = path.join(dir, 'ws');
      await mkdir(workspace);
      const kernel = await openKernel({
        dataDir: path.join(dir, 'data'),
        workspacePath: workspace,
        model: { provider: 'grok-proxy', modelId: grokProvider.modelId },
        models,
        getRole: (id) => roles.get(id),
        onLine: (line) => log(`grok ${line}`),
      });
      track(kernel);
      const answer = await say(kernel, kernel.root, 'ping grok');
      log(`1b grok answer ${answer}`);
      log(`1b grok refreshes=${grokProvider.state.refreshes} serverRefresh=${grok.refreshCount()}`);
      log(`1b grok requests ${JSON.stringify(grok.seen)}`);
      check(answer.includes('pong-grok'), `grok answer was ${answer}`);
      check(grokProvider.state.refreshes === 1, 'token was not refreshed exactly once');
      check(grok.seen.some((item) => item.path.endsWith('/responses') && item.tokenGen === 'access-1'), 'missing rejected access-1 call');
      check(grok.seen.some((item) => item.path.endsWith('/responses') && item.tokenGen === 'access-2'), 'missing retried access-2 call');
      const accepted = grok.seen.find((item) => item.tokenGen === 'access-2' && item.path.endsWith('/responses'));
      check(accepted?.grokIdentifier === 'grok-shell', 'missing x-grok-client-identifier');
      check(accepted?.tokenAuth === 'xai-grok-cli', 'missing x-xai-token-auth');
      check(Boolean(accepted?.grokVersion), 'missing x-grok-client-version');
      check(accepted?.grokModel === 'grok-build', 'missing x-grok-model-override');
    });
  } finally {
    await openai.close();
    await grok.close();
  }
}

async function sectionTools() {
  log('=== 1c tools and per-conversation cwd ===');
  await withTemp('pi-spike-tools-', async (dir, track) => {
    const workspaceA = path.join(dir, 'a');
    const workspaceB = path.join(dir, 'b');
    await mkdir(workspaceA);
    await mkdir(workspaceB);
    await writeFile(path.join(dir, 'outside.txt'), 'secret');
    const scripted = script([
      tool('write', { path: 'hello.txt', content: 'hello' }, 'w1'),
      tool('read', { path: 'hello.txt' }, 'r1'),
      tool('edit', { path: 'hello.txt', old: 'hello', new: 'hello!' }, 'e1'),
      tool('ls', { path: '.' }, 'l1'),
      tool('grep', { pattern: 'hello!', path: '.' }, 'g1'),
      tool('bash', { command: 'echo bash-ok' }, 'b1'),
      tool('read', { path: '../outside.txt' }, 's1'),
      tool('write', { path: '../outside.txt', content: 'pwned' }, 's2'),
      sayText('tools-done'),
    ]);
    const kernel = await openKernel({
      dataDir: path.join(dir, 'data'),
      workspacePath: workspaceA,
      model: scripted.model,
      models: scripted.models,
      getRole: (id) => roles.get(id),
      onLine: (line) => log(`tools ${line}`),
    });
    track(kernel);
    const answer = await say(kernel, kernel.root, 'TOOL_DEMO');
    const body = await joined(kernel, kernel.root);
    const hello = await readFile(path.join(workspaceA, 'hello.txt'), 'utf8');
    const outside = await readFile(path.join(dir, 'outside.txt'), 'utf8');
    log(`1c answer ${answer}`);
    log(`1c hello.txt ${JSON.stringify(hello)} outside ${JSON.stringify(outside)}`);
    check(answer.includes('tools-done'), `tools run ended with ${answer}`);
    check(hello === 'hello!', `workspace file is ${JSON.stringify(hello)}`);
    check(body.includes('bash-ok'), 'bash output missing');
    check(body.includes('hello!'), 'grep/read output missing');
    check(body.includes('E_SANDBOX'), 'sandbox escape was not rejected');
    check(outside === 'secret', 'sandbox allowed a write outside the workspace');

    scripted.faux.setResponses([
      () => tool('write', { path: 'hello.txt', content: 'from-b' }, 'wb'),
      () => sayText('wrote-b'),
      () => sayText('wrote-b'),
    ]);
    const other = await kernel.harness.createConversation({
      ownership: { kind: 'ownerless' },
      agent: { model: scripted.model, cwd: workspaceB },
    }, kernel.context);
    await kernel.attach(other.id);
    const otherAnswer = await say(kernel, other, 'WRITE_B');
    const fileB = await readFile(path.join(workspaceB, 'hello.txt'), 'utf8');
    const fileA = await readFile(path.join(workspaceA, 'hello.txt'), 'utf8');
    log(`1c cwd-b answer ${otherAnswer} fileB ${JSON.stringify(fileB)}`);
    check(otherAnswer.includes('wrote-b'), `cwd B ended with ${otherAnswer}`);
    check(fileB === 'from-b', 'conversation B did not write its own cwd');
    check(fileA === 'hello!', 'conversation B wrote into conversation A');
    await sleep(30);
    check(kernel.trace.some((item) => item.sse === 'tool.start'), 'missing tool.start SSE mapping');
    check(kernel.trace.some((item) => item.sse === 'message.done'), 'missing message.done SSE mapping');
  });
}

async function sectionForeground() {
  log('=== 1d foreground subagent from a role ===');
  await withTemp('pi-spike-fg-', async (dir, track) => {
    const coder = roles.get('coder');
    const routedModels = routed((request) => {
      const { message, text } = lastTurn(request);
      if (message?.role === 'user' && text.includes('FG_CODER')) {
        return tool('delegate', { task: 'Reply with the single word CHILD_OK', roleId: 'coder' }, 'fg1');
      }
      if (message?.role === 'user' && text.includes('CHILD_OK')) return sayText('CHILD_OK');
      if (message?.role === 'toolResult' && text.includes('CHILD_OK')) return sayText('parent saw CHILD_OK');
      return sayText(`unexpected:${text.slice(0, 80)}`);
    });
    const workspace = path.join(dir, 'ws');
    await mkdir(workspace);
    const kernel = await openKernel({
      dataDir: path.join(dir, 'data'),
      workspacePath: workspace,
      model: routedModels.model,
      models: routedModels.models,
      getRole: (id) => roles.get(id),
      onLine: (line) => log(`fg ${line}`),
    });
    track(kernel);
    const answer = await say(kernel, kernel.root, 'FG_CODER');
    await sleep(50);
    log(`1d answer ${answer}`);
    check(answer.includes('parent saw CHILD_OK'), `foreground answer was ${answer}`);
    const childEvent = kernel.trace.find((item) => item.conversationId !== kernel.root.id);
    check(childEvent, 'child conversation events were not attached');
    const conversations = await kernel.harness.commit((tx) => tx.scanConversations({}, 10), kernel.context);
    const child = conversations.items.find((item) => item.id !== kernel.root.id);
    check(child, 'foreground child conversation is missing');
    const handle = await kernel.harness.conversation(child.id, kernel.context);
    const agent = await handle.agent(kernel.context);
    log(`1d child tools ${agent.tools.map((item) => item.name).join(',')} cwd ${agent.cwd}`);
    check(agent.instructions === coder.systemPrompt, 'child instructions were not the coder role prompt');
    check(agent.tools.map((item) => item.name).join(',') === coder.tools.join(','), 'child tools were not the coder role tools');
    check(agent.cwd === workspace, 'child cwd was not the conversation workspace');
  });
}

async function sectionBackground() {
  log('=== 1d background subagent, wait/list/stop, concurrency ===');
  await withTemp('pi-spike-bg-', async (dir, track) => {
    const routedModels = routed((request) => {
      const { message, text } = lastTurn(request);
      if (message?.role === 'user' && text.includes('BG_LIMIT')) {
        return fauxAssistantMessage([
          fauxToolCall('subagent', { action: 'spawn', name: 'a', message: 'PING_A', roleId: 'echo' }, { id: 's1' }),
          fauxToolCall('subagent', { action: 'spawn', name: 'b', message: 'PING_B', roleId: 'echo' }, { id: 's2' }),
        ], { stopReason: 'toolUse' });
      }
      if (message?.role === 'user' && text.includes('PING_A_AGAIN')) return sayText('echo PING_A_AGAIN');
      if (message?.role === 'user' && text.includes('PING_A')) return sayText('echo PING_A');
      if (message?.role === 'user' && text.includes('[subagent')) return sayText('noted');
      if (message?.role === 'toolResult') return sayText('ok-background');
      if (message?.role === 'user' && text.includes('BG_LIST')) {
        return tool('subagent', { action: 'list' }, 'list1');
      }
      if (message?.role === 'user' && text.includes('BG_WAIT')) {
        return tool('subagent', { action: 'wait', name: 'a' }, 'wait1');
      }
      if (message?.role === 'user' && text.includes('BG_SEND')) {
        return tool('subagent', { action: 'send', name: 'a', message: 'PING_A_AGAIN' }, 'send1');
      }
      if (message?.role === 'user' && text.includes('PING_A_AGAIN')) return sayText('echo PING_A_AGAIN');
      if (message?.role === 'user' && text.includes('BG_HOLD_SPAWN')) {
        return tool('subagent', { action: 'spawn', name: 'sleeper', message: 'HOLD_PLEASE', roleId: 'recover' }, 'holdspawn');
      }
      if (message?.role === 'user' && text.includes('HOLD_PLEASE')) {
        return tool('hold', { token: 'abort-bg' }, 'holdbg');
      }
      if (message?.role === 'user' && text.includes('BG_STOP')) {
        return tool('subagent', { action: 'stop', name: 'sleeper' }, 'stop1');
      }
      return sayText(`unexpected:${text.slice(0, 80)}`);
    });
    const workspace = path.join(dir, 'ws');
    const control = path.join(dir, 'control');
    await mkdir(workspace);
    const kernel = await openKernel({
      dataDir: path.join(dir, 'data'),
      workspacePath: workspace,
      controlDir: control,
      model: routedModels.model,
      models: routedModels.models,
      maxConcurrentSubagents: 1,
      getRole: (id) => roles.get(id),
      onLine: (line) => log(`bg ${line}`),
    });
    track(kernel);
    const limited = await say(kernel, kernel.root, 'BG_LIMIT');
    await settleBackground(kernel);
    const limitBody = await joined(kernel, kernel.root);
    log(`1d limit answer ${limited}`);
    check(limitBody.includes('Started a.'), 'first background spawn did not start');
    check(limitBody.includes('limit 1'), 'second spawn was not refused at the concurrency limit');
    check(!limitBody.includes('Started b.'), 'second spawn created a subagent over the limit');

    const listed = await say(kernel, kernel.root, 'BG_LIST');
    const listBody = await joined(kernel, kernel.root);
    log(`1d list answer ${listed}`);
    check(listBody.includes('a:'), 'list did not show the background subagent');

    const waited = await say(kernel, kernel.root, 'BG_WAIT');
    log(`1d wait answer ${waited}`);
    check(waited.includes('echo PING_A') || (await joined(kernel, kernel.root)).includes('echo PING_A'), 'wait did not return the child answer');

    const sent = await say(kernel, kernel.root, 'BG_SEND');
    await settleBackground(kernel);
    const sendBody = await joined(kernel, kernel.root);
    log(`1d send answer ${sent}`);
    check(sendBody.includes('Sent to a.'), 'send did not accept the message');
    check(sendBody.includes('echo PING_A_AGAIN'), 'send did not report the new answer');
  });
}

async function sectionAbortBackground() {
  log('=== 1g abort background ===');
  await withTemp('pi-spike-abort-bg-', async (dir, track) => {
    const routedModels = routed((request) => {
      const { message, text } = lastTurn(request);
      if (message?.role === 'user' && text.includes('BG_HOLD_SPAWN')) {
        return tool('subagent', { action: 'spawn', name: 'sleeper', message: 'HOLD_PLEASE', roleId: 'recover' }, 'holdspawn');
      }
      if (message?.role === 'user' && text.includes('HOLD_PLEASE')) {
        return tool('hold', { token: 'abort-bg' }, 'holdbg');
      }
      if (message?.role === 'toolResult') return sayText('spawned-sleeper');
      return sayText(`unexpected:${text.slice(0, 80)}`);
    });
    const workspace = path.join(dir, 'ws');
    const control = path.join(dir, 'control');
    await mkdir(workspace);
    const kernel = await openKernel({
      dataDir: path.join(dir, 'data'),
      workspacePath: workspace,
      controlDir: control,
      model: routedModels.model,
      models: routedModels.models,
      getRole: (id) => roles.get(id),
      onLine: (line) => log(`abort-bg ${line}`),
    });
    track(kernel);
    await say(kernel, kernel.root, 'BG_HOLD_SPAWN');
    await waitForFile(path.join(control, 'abort-bg.ticks'), 10_000);
    const before = await tickCount(path.join(control, 'abort-bg.ticks'));
    await kernel.root.abort(kernel.context);
    await sleep(350);
    const during = await tickCount(path.join(control, 'abort-bg.ticks'));
    log(`1g background ticks before=${before} during ordinary abort=${during}`);
    check(during > before, 'ordinary abort stopped the background subagent');
    await kernel.root.abort(kernel.context, { background: true });
    await sleep(350);
    const after = await tickCount(path.join(control, 'abort-bg.ticks'));
    await sleep(350);
    const settledTicks = await tickCount(path.join(control, 'abort-bg.ticks'));
    log(`1g background ticks after explicit abort ${after} -> ${settledTicks}`);
    check(settledTicks === after, 'background abort did not stop the background subagent');
  });
}

async function sectionAbortForeground() {
  log('=== 1g abort foreground ===');
  await withTemp('pi-spike-abort-', async (dir, track) => {
    const routedModels = routed((request) => {
      const { message, text } = lastTurn(request);
      if (message?.role === 'user' && text.includes('ABORT_FG')) {
        return tool('delegate', { task: 'ABORT_HOLD', roleId: 'recover' }, 'abort-delegate');
      }
      if (message?.role === 'user' && text.includes('ABORT_HOLD')) {
        return tool('hold', { token: 'abort-fg' }, 'abort-hold');
      }
      return sayText('should-not-finish');
    });
    const workspace = path.join(dir, 'ws');
    const control = path.join(dir, 'control');
    await mkdir(workspace);
    const kernel = await openKernel({
      dataDir: path.join(dir, 'data'),
      workspacePath: workspace,
      controlDir: control,
      model: routedModels.model,
      models: routedModels.models,
      getRole: (id) => roles.get(id),
      onLine: (line) => log(`abort ${line}`),
    });
    track(kernel);
    const submission = await kernel.root.submit({ type: 'input', content: 'ABORT_FG' }, kernel.context);
    const pending = submission.wait(kernel.context);
    await waitForFile(path.join(control, 'abort-fg.ticks'), 10_000);
    await kernel.root.abort(kernel.context);
    const settled = await withTimeout(pending, 15_000, 'abort wait');
    log(`1g foreground status=${settled.status} reason=${settled.reason || ''}`);
    check(settled.status === 'unanswered', `foreground abort settled as ${settled.status}`);
    check(settled.reason === 'aborted', `foreground abort reason was ${settled.reason}`);
    await kernel.root.waitForIdle(kernel.context);
    const body = await joined(kernel, kernel.root);
    check(!body.includes('should-not-finish'), 'foreground child kept running after abort');
  });
}

function killChild(child) {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  child.kill('SIGKILL');
}

function runWorker(mode, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(here, 'smoke-worker.mjs')], {
      env: { ...process.env, ...env, SPIKE_MODE: mode },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const take = (chunk) => {
      out += chunk;
      for (const line of String(chunk).split('\n')) {
        if (line.trim()) log(`worker-${mode} ${line}`);
      }
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', reject);
    child.on('exit', (code, signal) => resolve({ code, signal, out, child }));
    child.proc = child;
  });
}

async function sectionRecovery() {
  log('=== 1f kill and resume ===');
  const dir = await mkdtemp(path.join(tmpdir(), 'pi-spike-recover-'));
  const workspace = path.join(dir, 'ws');
  const control = path.join(dir, 'control');
  const data = path.join(dir, 'data');
  await mkdir(workspace);
  const env = {
    SPIKE_DATA: data,
    SPIKE_WORK: workspace,
    SPIKE_CONTROL: control,
    SPIKE_RESULT: path.join(dir, 'result.json'),
  };
  const crash = spawn(process.execPath, [path.join(here, 'smoke-worker.mjs')], {
    env: { ...process.env, ...env, SPIKE_MODE: 'crash' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  crash.stdout.on('data', (chunk) => {
    for (const line of String(chunk).split('\n')) if (line.trim()) log(`worker-crash ${line}`);
  });
  crash.stderr.on('data', (chunk) => {
    for (const line of String(chunk).split('\n')) if (line.trim()) log(`worker-crash ${line}`);
  });
  const early = new Promise((resolve) => crash.once('exit', (code, signal) => resolve({ code, signal })));
  const marker = path.join(control, 'recover.seen');
  const ready = await Promise.race([
    waitForFile(marker, 15_000).then(() => 'ready'),
    early.then((exit) => exit),
  ]);
  if (ready !== 'ready') {
    throw new Error(`recovery worker exited before the child was holding (${JSON.stringify(ready)})`);
  }
  await sleep(500);
  log(`1f killing pid ${crash.pid}`);
  killChild(crash);
  const killed = await early;
  log(`1f killed code=${killed.code} signal=${killed.signal}`);
  check(killed.signal === 'SIGKILL' || killed.code !== 0 || process.platform === 'win32', 'crash worker was not killed');
  const resumed = await runWorker('resume', env);
  log(`1f resume code=${resumed.code} signal=${resumed.signal || ''}`);
  const result = JSON.parse(await readFile(env.SPIKE_RESULT, 'utf8'));
  log(`1f result ${JSON.stringify(result)}`);
  check(resumed.code === 0, 'resume worker failed');
  check(result.conversations === 2, `expected 2 conversations, saw ${result.conversations}`);
  check(result.holdUserEntries === 1, `child was submitted ${result.holdUserEntries} times`);
  check(result.rootRequestStatus === 'done', 'root request was not the original submission');
  check(result.childText.includes('resumed-after-kill'), 'hold tool did not resume from the interrupted call');
  check(result.parentText.includes('parent-finished'), 'parent did not finish after resume');
}

async function main() {
  log(`spike smoke node=${process.version} platform=${process.platform}`);
  await sectionStorage();
  await sectionProviders();
  await sectionTools();
  await sectionForeground();
  await sectionBackground();
  await sectionAbortForeground();
  await sectionAbortBackground();
  await sectionRecovery();
  log('=== smoke passed ===');
}

const logPath = path.join(repoRoot(), 'spike', 'logs', 'smoke.log');
try {
  await main();
} catch (error) {
  log(`SMOKE FAILED ${error?.stack || error}`);
  await mkdir(path.dirname(logPath), { recursive: true });
  await writeFile(logPath, `${lines.join('\n')}\n`);
  process.exit(1);
}
await mkdir(path.dirname(logPath), { recursive: true });
await writeFile(logPath, `${lines.join('\n')}\n`);
