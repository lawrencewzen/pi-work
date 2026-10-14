/**
 * Recovery worker. `crash` submits a foreground subagent and blocks inside it.
 * `resume` reopens the same SQLite file and lets that run finish.
 */
import { writeFile } from 'node:fs/promises';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { openKernel } from './lib/kernel.mjs';
import { textOf } from './lib/text.mjs';
import { loadRoles } from './lib/roles.mjs';

function route(request) {
  const messages = request.messages || [];
  const last = [...messages].reverse().find((message) => message && message.role !== 'system');
  const text = textOf(last);
  if (last?.role === 'user' && text.includes('RECOVER_DISPATCH')) {
    return fauxAssistantMessage([
      fauxToolCall('delegate', { task: 'RECOVER_HOLD', roleId: 'recover' }, { id: 'recover-delegate' }),
    ], { stopReason: 'toolUse' });
  }
  if (last?.role === 'user' && text.includes('RECOVER_HOLD')) {
    return fauxAssistantMessage([
      fauxToolCall('hold', { token: 'recover' }, { id: 'recover-hold' }),
    ], { stopReason: 'toolUse' });
  }
  if (last?.role === 'toolResult' && (text.includes('resumed-after-kill') || text.includes('held-without-kill'))) {
    return fauxAssistantMessage([fauxText('child-finished')]);
  }
  if (last?.role === 'toolResult' && text.includes('child-finished')) {
    return fauxAssistantMessage([fauxText('parent-finished')]);
  }
  return fauxAssistantMessage([fauxText(`unexpected:${text.slice(0, 160)}`)]);
}

function modelsFor() {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(Array.from({ length: 20 }, () => route));
  return models;
}

async function transcript(kernel, conversation) {
  const page = await conversation.entries({ order: 'ascending' }, 100, undefined, kernel.context);
  return page.items.map((entry) => ({
    kind: entry.kind,
    role: entry.model?.[0]?.role || '',
    text: textOf(entry.model?.[0]),
  }));
}

const mode = process.env.SPIKE_MODE;
const dataDir = process.env.SPIKE_DATA;
const workspacePath = process.env.SPIKE_WORK;
const controlDir = process.env.SPIKE_CONTROL;
const resultPath = process.env.SPIKE_RESULT;

const roles = await loadRoles();
const kernel = await openKernel({
  dataDir,
  workspacePath,
  controlDir,
  model: { provider: 'faux', modelId: 'faux-1' },
  models: modelsFor(),
  maxConcurrentSubagents: 4,
  getRole: (id) => roles.get(id),
  onLine: (line) => console.log(`[${mode}] ${line}`),
});

if (mode === 'crash') {
  console.log('[crash] submitting RECOVER_DISPATCH');
  const submission = await kernel.root.submit(
    { type: 'input', content: 'RECOVER_DISPATCH', requestId: 'recover-root' },
    kernel.context,
  );
  const settled = await submission.wait(kernel.context);
  console.log(`[crash] finished before kill status=${settled.status} reason=${settled.reason || ''}`);
  await kernel.close();
  process.exit(2);
}

if (mode === 'resume') {
  await kernel.root.waitForIdle(kernel.context);
  const conversations = await kernel.harness.commit(
    (tx) => tx.scanConversations({}, 20),
    kernel.context,
  );
  const dumps = [];
  for (const record of conversations.items) {
    const conversation = await kernel.harness.conversation(record.id, kernel.context);
    dumps.push({ id: record.id, root: record.id === kernel.root.id, entries: await transcript(kernel, conversation) });
  }
  const child = dumps.find((item) => !item.root);
  const parent = dumps.find((item) => item.root);
  const holdUsers = (child?.entries || []).filter((entry) => entry.kind === 'pi.user' && entry.text.includes('RECOVER_HOLD'));
  const rootRequest = await kernel.harness.commit(
    (tx) => tx.submissionByRequest(kernel.root.id, 'recover-root'),
    kernel.context,
  );
  const result = {
    conversations: dumps.length,
    holdUserEntries: holdUsers.length,
    rootRequestStatus: rootRequest?.status || 'missing',
    parentText: (parent?.entries || []).map((entry) => entry.text).join('\n'),
    childText: (child?.entries || []).map((entry) => entry.text).join('\n'),
  };
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`[resume] ${JSON.stringify(result)}`);
  await kernel.close();
  const ok = result.conversations === 2
    && result.holdUserEntries === 1
    && result.rootRequestStatus === 'done'
    && result.parentText.includes('parent-finished')
    && result.childText.includes('resumed-after-kill')
    && result.childText.includes('child-finished');
  process.exit(ok ? 0 : 1);
}

console.error(`unknown SPIKE_MODE ${mode}`);
process.exit(1);
