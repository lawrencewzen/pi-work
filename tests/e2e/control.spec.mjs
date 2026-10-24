import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startServer, prepareWorkspaces } from './helpers/server.mjs';
import { createWorkspace, newConversation, send, statusText, openApp, visualText } from './helpers/ui.mjs';

let srv;
test.afterEach(async () => { await srv?.kill(); });
const exists = (p) => fs.access(p).then(() => true, () => false);

test('interrupt while running, then stop', async ({ page }) => {
  const { root, dirs: [ws] } = await prepareWorkspaces(['ctl']);
  srv = await startServer({ script: 'slow.json', extraEnv: { WEFT_WORKSPACE_ROOT: root } });
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
  const stop = page.locator('[data-testid=chat-send][data-state=stop]');
  await expect(stop).toBeVisible();
  await expect(stop).toHaveAttribute('aria-label', /终止|Stop/);
  await stop.click();
  await expect(statusText(page)).toContainText(/stopped|已停止/i);
  await page.waitForTimeout(4000);
  await expect(statusText(page)).toContainText(/stopped|已停止/i);
});

test('two agents run in parallel', async ({ page }) => {
  const { root, dirs: [ws1, ws2] } = await prepareWorkspaces(['p1', 'p2']);
  srv = await startServer({ script: 'slow.json', extraEnv: { WEFT_WORKSPACE_ROOT: root } });
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

test('running status lives in an assistant pending bubble', async ({ page }) => {
  const { root, dirs: [ws] } = await prepareWorkspaces(['pending']);
  srv = await startServer({ script: 'pending-run.json', extraEnv: { WEFT_WORKSPACE_ROOT: root } });
  await openApp(page, srv);
  await createWorkspace(page, 'pending', ws);
  await newConversation(page);
  await send(page, 'run');
  const pending = page.getByTestId('assistant-pending');
  await expect(pending).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId('assistant-pending-status')).toHaveText('思考中');
  await expect(page.getByTestId('assistant-pending-elapsed')).toHaveText(/^\d+:\d{2}$/);
  await expect(page.getByTestId('run-bar')).toHaveCount(0);
  await expect(page.getByTestId('btn-stop')).toHaveCount(0);
  await expect(page.locator('[data-testid=chat-send][data-state=stop]')).toBeVisible();

  await expect(page.getByTestId('tool-group-spinner')).toBeVisible({ timeout: 8000 });
  await expect(page.getByTestId('assistant-pending')).toHaveCount(0);
  await expect(page.getByTestId('tool-group-text')).toHaveText('正在运行 `sleep 2`…');
  await expect(page.getByTestId('tool-group-elapsed')).toHaveText(/^\d+:\d{2}$/);
  await expect(page.locator('.tool-group-spin, .run-spin, [data-testid=assistant-stream-spin]')).toHaveCount(1);

  await expect(page.getByTestId('tool-group-text')).toHaveText('运行 sleep 2 · 思考中', { timeout: 8000 });
  await expect(page.getByTestId('assistant-pending')).toHaveCount(0);
  await expect(page.getByTestId('tool-group-spinner')).toBeVisible();
  await expect(page.getByTestId('tool-group-elapsed')).toHaveText(/^\d+:\d{2}$/);
  await expect(page.locator('.tool-group-spin, .run-spin, [data-testid=assistant-stream-spin]')).toHaveCount(1);

  await expect(page.getByTestId('message').filter({ hasText: '跑完了。' })).toBeVisible({ timeout: 20000 });
  await expect(pending).toHaveCount(0);
  await expect(page.getByTestId('tool-group-spinner')).toHaveCount(0);
  await expect(page.getByTestId('tool-group-elapsed')).toHaveCount(0);
  await expect(statusText(page)).toContainText(/done|完成/i);
  await expect(page.locator('[data-testid=chat-send][data-state=stop]')).toHaveCount(0);
});

test('main thread omits default sender and does not show 主 Agent', async ({ page }) => {
  const { root, dirs: [ws] } = await prepareWorkspaces(['role']);
  srv = await startServer({ script: 'basic.json', extraEnv: { WEFT_WORKSPACE_ROOT: root } });
  await openApp(page, srv);
  await createWorkspace(page, 'role', ws);
  await newConversation(page);
  await send(page, 'default role');
  await expect(statusText(page)).toContainText(/done|完成/i, { timeout: 20000 });
  await expect(page.locator('#center-thread [data-testid=message][data-role=assistant] [data-testid=message-sender]')).toHaveCount(0);
  await expect(page.locator('#center-thread')).not.toContainText('主 Agent');
  const chip = page.locator('#center-thread [data-testid=message][data-role=assistant] [data-testid=message-chip]').first();
  await expect(chip).toBeVisible();
  const chipText = await visualText(chip);
  expect(chipText.startsWith('·')).toBe(false);
  expect(chipText).toBe('faux-1');
});

test('stream cut retries and finishes', async ({ page }) => {
  const { root, dirs: [ws] } = await prepareWorkspaces(['cut']);
  srv = await startServer({ script: 'crash.json', extraEnv: { WEFT_WORKSPACE_ROOT: root } });
  await openApp(page, srv);
  await createWorkspace(page, 'cut', ws);
  await newConversation(page);
  await send(page, 'go');
  await expect(statusText(page)).toContainText(/done|完成/i, { timeout: 30000 });
  await expect(page.getByTestId('autocontinue-count')).toHaveCount(0);
  expect(await fs.readFile(path.join(ws, 'final.txt'), 'utf8')).toBe('ok\n');
});
