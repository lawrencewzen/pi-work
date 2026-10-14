/**
 * Recovery worker for the kernel unit test.
 * crash: admit one input and block inside the model call until killed.
 * resume: reopen the same sqlite, resume, and finish that submission.
 */
import { writeFile } from 'node:fs/promises';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { AssistantEntry, createRegistry } from '@earendil-works/pi-durable';
import { FAUX_MODEL, openKernel, registerFaux } from '../../src/kernel/index.mjs';

const mode = process.env.PI_WORK_KERNEL_MODE;
const dataDir = process.env.PI_WORK_KERNEL_DATA;
const readyPath = process.env.PI_WORK_KERNEL_READY;
const resultPath = process.env.PI_WORK_KERNEL_RESULT;

function textOf(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((block) => block?.text || '').join('');
}

function catalog() {
  const models = createModels();
  const faux = registerFaux(models);
  return { models, faux, registry: createRegistry() };
}

if (mode === 'crash') {
  try {
    const { models, faux, registry } = catalog();
    faux.setResponses([async () => {
      await writeFile(readyPath, 'seen');
      await new Promise(() => {});
      return fauxAssistantMessage('unreachable');
    }]);
    const kernel = await openKernel({ dataDir, models, registry });
    // A bare pending promise does not keep Node alive. This timer only holds the
    // process open until the parent kills it; the Harness still owns the run.
    const stayAlive = setInterval(() => {}, 1000);
    const result = await kernel.submit({ content: 'RECOVER', requestId: 'recover-1', model: FAUX_MODEL });
    clearInterval(stayAlive);
    console.error(`settled before kill status=${result.settled.status}`);
    process.exit(2);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}

if (mode === 'resume') {
  const { models, faux, registry } = catalog();
  faux.setResponses([
    () => fauxAssistantMessage('resumed-ok'),
    () => fauxAssistantMessage('resumed-ok'),
  ]);
  const kernel = await openKernel({ dataDir, models, registry });
  try {
    kernel.harness.resume();
    const page = await kernel.harness.commit((tx) => tx.scanConversations({}, 20), kernel.context);
    if (page.items.length !== 1) throw new Error(`expected 1 conversation, saw ${page.items.length}`);
    const conversation = await kernel.harness.conversation(page.items[0].id, kernel.context);
    const { submission, settled } = await kernel.submit({
      conversation,
      content: 'RECOVER',
      requestId: 'recover-1',
    });
    const record = await kernel.harness.commit(
      (tx) => tx.submissionByRequest(conversation.id, 'recover-1'),
      kernel.context,
    );
    const entry = settled.status === 'done'
      ? await conversation.commit((tx) => tx.entry(AssistantEntry, settled.answer), kernel.context)
      : undefined;
    const result = {
      conversations: page.items.length,
      submissionId: submission.id,
      sameSubmission: record?.id === submission.id,
      status: settled.status,
      requestId: record?.requestId || '',
      answer: textOf(entry?.model?.[0]),
    };
    await writeFile(resultPath, `${JSON.stringify(result)}\n`);
    console.log(JSON.stringify(result));
    if (result.conversations !== 1 || !result.sameSubmission || result.status !== 'done' || result.requestId !== 'recover-1' || !result.answer.includes('resumed-ok')) {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    await kernel.close();
  }
  process.exit(process.exitCode || 0);
}

console.error(`unknown PI_WORK_KERNEL_MODE ${mode}`);
process.exit(1);
