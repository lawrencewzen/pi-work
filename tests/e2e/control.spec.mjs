import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startServer, prepareWorkspaces } from './helpers/server.mjs';
import { createWorkspace, newConversation, send, statusText, openApp } from './helpers/ui.mjs';

let srv;
test.afterEach(async () => { await srv?.kill(); });
const exists = (p) => fs.access(p).then(() => true, () => false);

test('interrupt while running, then stop', async ({ page }) => {
  const { root, dirs: [ws] } = await prepareWorkspaces(['ctl']);
  srv = await startServer({ script: 'slow.json', extraEnv: { PI_WORK_WORKSPACE_ROOT: root } });
  await openApp(page, srv);
  await createWorkspace(page, 'ctl', ws);
  await newConversation(page);
  await send(page, 'run');
  await expect(statusText(page)).toContainText(/running|运行/i);
  const input = page.getByTestId('chat-input');
  await expect(input).toBeEnabled();
  await expect(input).toHaveAttribute('placeholder', /补充说明/);
  await input.fill('插一句');
  await page.getByTestId('chat-send').click();
  await expect(page.getByTestId('message').filter({ hasText: '插一句' })).toBeVisible();
  await expect(statusText(page)).toContainText(/done|完成/i, { timeout: 20000 });
  expect(await exists(path.join(ws, 'b.txt'))).toBe(true);

  await newConversation(page);
  await send(page, 'run again');
  await expect(statusText(page)).toContainText(/running|运行/i);
  await page.getByTestId('btn-stop').click();
  await expect(statusText(page)).toContainText(/stopped|已停止/i);
  await page.waitForTimeout(4000);
  await expect(statusText(page)).toContainText(/stopped|已停止/i);
});

test('two agents run in parallel', async ({ page }) => {
  const { root, dirs: [ws1, ws2] } = await prepareWorkspaces(['p1', 'p2']);
  srv = await startServer({ script: 'slow.json', extraEnv: { PI_WORK_WORKSPACE_ROOT: root } });
  await openApp(page, srv);
  await createWorkspace(page, 'p1', ws1);
  await newConversation(page);
  await send(page, 'job one');
  await createWorkspace(page, 'p2', ws2);
  await newConversation(page);
  await send(page, 'job two');
  // both conversations show running at the same time
  // the sidebar keeps both projects open and marks both conversations as running
  await expect(page.locator('[data-testid=conversation-item][data-status=running]')).toHaveCount(2, { timeout: 5000 });
  const t0 = Date.now();
  await expect.poll(async () => (await exists(path.join(ws1, 'b.txt'))) && (await exists(path.join(ws2, 'b.txt'))), { timeout: 20000 }).toBe(true);
  expect(Date.now() - t0).toBeLessThan(9000); // serial would be ~2x slow.json duration
});

test('stream cut retries and finishes', async ({ page }) => {
  const { root, dirs: [ws] } = await prepareWorkspaces(['cut']);
  srv = await startServer({ script: 'crash.json', extraEnv: { PI_WORK_WORKSPACE_ROOT: root } });
  await openApp(page, srv);
  await createWorkspace(page, 'cut', ws);
  await newConversation(page);
  await send(page, 'go');
  await expect(statusText(page)).toContainText(/done|完成/i, { timeout: 30000 });
  await expect(page.getByTestId('autocontinue-count')).toHaveCount(0);
  expect(await fs.readFile(path.join(ws, 'final.txt'), 'utf8')).toBe('ok\n');
});
