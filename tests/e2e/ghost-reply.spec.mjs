import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startServer, prepareWorkspaces } from './helpers/server.mjs';
import { createWorkspace, newConversation, send, statusText, openApp } from './helpers/ui.mjs';

const SHOTS = process.env.PI_WORK_SHOTS || '/opt/cursor/artifacts/screenshots';
const TEXT_A = '这是一个 TypeScript/Node.js 项目，用于开发相关。';
const TEXT_B = '第二轮已经看完，结论里有顿号、和的字。';

test.use({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 8 / 3,
});
test.describe.configure({ timeout: 90_000 });

async function shot(page, name) {
  await fs.mkdir(SHOTS, { recursive: true });
  const file = path.join(SHOTS, `${name}.png`);
  await page.locator('#center-thread').evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await page.screenshot({ path: file });
  const buf = await fs.readFile(file);
  expect(buf.readUInt32BE(16), `${name} width`).toBe(3840);
  return file;
}

test('two turns each leave one agent reply, including after refresh', async ({ page }) => {
  const prepared = await prepareWorkspaces(['ghost']);
  const ws = prepared.dirs[0];
  await fs.mkdir(path.join(ws, 'src'));
  const scriptPath = path.join(prepared.root, 'ghost.json');
  await fs.writeFile(scriptPath, JSON.stringify({
    turns: [
      { tool: 'ls', args: { path: '.' } },
      { text: TEXT_A },
      { tool: 'ls', args: { path: 'src' } },
      { text: TEXT_B },
    ],
  }));
  const srv = await startServer({
    extraEnv: {
      PI_WORK_FAUX_SCRIPT: scriptPath,
      PI_WORK_FAUX_DRAIN: '0',
      PI_WORK_FAUX_TPS: '4',
      PI_WORK_WORKSPACE_ROOT: prepared.root,
    },
  });
  try {
    await openApp(page, srv);
    await createWorkspace(page, 'ghost', ws);
    await newConversation(page);
    const assistants = page.locator('[data-testid=message][data-role=assistant]');

    await send(page, '先看一下这个仓库');
    await expect(assistants.filter({ hasText: TEXT_A })).toHaveCount(1, { timeout: 30000 });
    await expect(statusText(page)).toContainText(/done|完成/i, { timeout: 20000 });
    await expect(assistants).toHaveCount(1);

    await send(page, '再看一眼 src');
    await expect(assistants.filter({ hasText: TEXT_B })).toHaveCount(1, { timeout: 30000 });
    await expect(statusText(page)).toContainText(/done|完成/i, { timeout: 20000 });
    await expect(assistants).toHaveCount(2);
    await expect(assistants.nth(0).getByTestId('message-body')).toContainText(TEXT_A);
    await expect(assistants.nth(1).getByTestId('message-body')).toContainText(TEXT_B);
    await shot(page, 't8-1-two-replies');

    await page.reload();
    await expect(assistants.filter({ hasText: TEXT_A })).toHaveCount(1, { timeout: 20000 });
    await expect(assistants.filter({ hasText: TEXT_B })).toHaveCount(1);
    await expect(assistants).toHaveCount(2);
    await page.waitForTimeout(1000);
    await expect(assistants).toHaveCount(2);
    await expect(assistants.nth(0).getByTestId('message-body')).toContainText(TEXT_A);
    await expect(assistants.nth(1).getByTestId('message-body')).toContainText(TEXT_B);
    await expect(statusText(page)).toContainText(/done|完成/i);
    await shot(page, 't8-1-after-refresh');
  } finally {
    await srv.kill();
  }
});
