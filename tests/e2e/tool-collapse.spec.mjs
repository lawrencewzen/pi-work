import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startServer, prepareWorkspaces } from './helpers/server.mjs';
import { createWorkspace, newConversation, send, openApp } from './helpers/ui.mjs';

async function seedReads(dir) {
  for (const name of ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt']) {
    await fs.writeFile(path.join(dir, name), `${name}\n`);
  }
  const lines = Array.from({ length: 30 }, (_, i) => `L${String(i + 1).padStart(2, '0')}`);
  await fs.writeFile(path.join(dir, 'long.txt'), `${lines.join('\n')}\n`);
}

async function switchLanguage(page, lang) {
  await page.locator('[data-action=open-settings]').click();
  await page.locator(`[data-action=switch-language][data-lang=${lang}]`).click();
  await page.locator('[data-action=close-settings]').click();
  await expect(page.locator('.sm')).toBeHidden();
}

test('seven tool calls collapse to one summary, then a row, then the output', async ({ page }) => {
  const { root, dirs: [ws] } = await prepareWorkspaces(['ws']);
  await seedReads(ws);
  const srv = await startServer({ script: 'tool-collapse.json', extraEnv: { PI_WORK_WORKSPACE_ROOT: root } });
  try {
    await openApp(page, srv);
    await createWorkspace(page, 'demo', ws);
    await newConversation(page);
    await send(page, '看看');
    const summary = page.getByTestId('tool-group-summary');
    await expect(summary).toBeVisible({ timeout: 20000 });
    await expect(page.getByTestId('tool-group-text')).toHaveText('读取了 6 个文件，列出 1 个目录');
    await expect(page.getByTestId('message').filter({ hasText: '看完了，一共这些。' })).toBeVisible();
    const rows = page.locator('[data-testid=tool-row]');
    await expect(rows).toHaveCount(7);
    await expect(rows.first()).toBeHidden();

    await summary.click();
    await expect(rows).toHaveCount(7);
    for (let i = 0; i < 7; i += 1) await expect(rows.nth(i)).toBeVisible();
    await expect(page.locator('[data-testid=tool-row][data-tool=read]')).toHaveCount(6);
    await expect(page.locator('[data-testid=tool-row][data-tool=ls]')).toHaveCount(1);

    const row = page.locator('[data-testid=tool-row][data-path="long.txt"]');
    const detail = row.getByTestId('tool-row-detail');
    await expect(detail).toBeHidden();
    await row.click();
    await expect(detail).toBeVisible();
    await expect(detail).toContainText('long.txt');
    await expect(detail).toContainText('L01');
    await expect(detail).toContainText('L20');
    await expect(detail).not.toContainText('L21');
    await detail.getByTestId('tool-output-more').click();
    await expect(detail).toBeVisible();
    await expect(detail).toContainText('L30');

    await switchLanguage(page, 'en');
    await expect(page.getByTestId('tool-group-text')).toHaveText('Read 6 files, listed 1 directory');
    await expect(detail).toBeVisible();
    await expect(detail).toContainText('L30');
  } finally {
    await srv.kill();
  }
});

test('a failed call keeps the summary collapsed and shows the failure count', async ({ page }) => {
  const { root, dirs: [ws] } = await prepareWorkspaces(['ws']);
  const srv = await startServer({ script: 'tool-fail.json', extraEnv: { PI_WORK_WORKSPACE_ROOT: root } });
  try {
    await openApp(page, srv);
    await createWorkspace(page, 'demo', ws);
    await newConversation(page);
    await send(page, '看看');
    await expect(page.getByTestId('tool-group-text')).toHaveText('读取了 missing.txt', { timeout: 20000 });
    await expect(page.getByTestId('tool-group-fail')).toHaveText('1 个失败');
    await expect(page.locator('[data-testid=tool-row][data-tool=read]')).toBeHidden();
    await page.getByTestId('tool-group-summary').click();
    const row = page.locator('[data-testid=tool-row][data-tool=read]');
    await expect(row).toBeVisible();
    await expect(row.getByTestId('tool-row-status')).toHaveText('失败');
  } finally {
    await srv.kill();
  }
});

test('a running call shows a spinner and the current action without opening the group', async ({ page }) => {
  const { root, dirs: [ws] } = await prepareWorkspaces(['ws']);
  const srv = await startServer({ script: 'tool-run.json', extraEnv: { PI_WORK_WORKSPACE_ROOT: root } });
  try {
    await openApp(page, srv);
    await createWorkspace(page, 'demo', ws);
    await newConversation(page);
    await send(page, '跑');
    await expect(page.getByTestId('tool-group-spinner')).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId('tool-group-text')).toHaveText('正在执行 sleep 3');
    await expect(page.locator('[data-testid=tool-row][data-tool=bash]')).toBeHidden();
    await expect(page.getByTestId('tool-group-text')).toHaveText('执行了 sleep 3', { timeout: 15000 });
    await expect(page.getByTestId('tool-group-spinner')).toHaveCount(0);
    await expect(page.locator('[data-testid=tool-row][data-tool=bash]')).toBeHidden();
  } finally {
    await srv.kill();
  }
});
