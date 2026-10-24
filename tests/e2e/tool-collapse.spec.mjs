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

async function seedLong(dir) {
  for (let i = 0; i < 9; i += 1) {
    await fs.writeFile(path.join(dir, `t${i}.txt`), `t${i}\n`);
  }
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
  const srv = await startServer({ script: 'tool-collapse.json', extraEnv: { WEFT_WORKSPACE_ROOT: root } });
  try {
    await openApp(page, srv);
    await createWorkspace(page, 'demo', ws);
    await newConversation(page);
    await send(page, '看看');
    const summary = page.getByTestId('tool-group-summary');
    await expect(summary).toBeVisible({ timeout: 20000 });
    await expect(page.getByTestId('tool-group-text')).toHaveText('读了 a.txt、b.txt 等 6 个文件 · 列出 1 个目录');
    await expect(page.getByTestId('message').filter({ hasText: '看完了，一共这些。' })).toBeVisible();
    const rows = page.locator('[data-testid=tool-row]');
    await expect(rows).toHaveCount(7);
    await expect(rows.first()).toBeHidden();

    await summary.click();
    await expect(rows).toHaveCount(7);
    for (let i = 0; i < 7; i += 1) await expect(rows.nth(i)).toBeVisible();
    await expect(page.locator('[data-testid=tool-row][data-tool=read]')).toHaveCount(6);
    await expect(page.locator('[data-testid=tool-row][data-tool=ls]')).toHaveCount(1);
    await expect(page.locator('[data-testid=tool-row][data-path="long.txt"]').getByTestId('tool-row-hint')).toHaveText('30 行');
    await expect(page.locator('[data-testid=tool-row][data-tool=ls]').getByTestId('tool-row-hint')).toHaveText('6 项');

    const row = page.locator('[data-testid=tool-row][data-path="long.txt"]');
    const detail = row.getByTestId('tool-row-detail');
    await expect(detail).toBeHidden();
    await row.click();
    await expect(detail).toBeVisible();
    await expect(detail).toContainText('L01');
    await expect(detail).toContainText('L20');
    await expect(detail).not.toContainText('L21');
    await detail.getByTestId('tool-output-more').click();
    await expect(detail).toBeVisible();
    await expect(detail).toContainText('L30');

    await switchLanguage(page, 'en');
    await expect(page.getByTestId('tool-group-text')).toHaveText('Read a.txt, b.txt and 6 files · listed 1 directory');
    await expect(detail).toBeVisible();
    await expect(detail).toContainText('L30');
  } finally {
    await srv.kill();
  }
});

test('a probing read stays gray, collapsed, and out of the red failure count', async ({ page }) => {
  const { root, dirs: [ws] } = await prepareWorkspaces(['ws']);
  await fs.writeFile(path.join(ws, 'a.txt'), 'ok\n');
  const srv = await startServer({ script: 'tool-probe.json', extraEnv: { WEFT_WORKSPACE_ROOT: root } });
  try {
    await openApp(page, srv);
    await createWorkspace(page, 'demo', ws);
    await newConversation(page);
    await send(page, '看看');
    await expect(page.getByTestId('tool-group-text')).toHaveText('读了 a.txt', { timeout: 20000 });
    await expect(page.getByTestId('tool-group-fail')).toHaveCount(0);
    await expect(page.getByTestId('tool-group-text')).not.toContainText('失败');
    await expect(page.locator('[data-testid=tool-group].is-failed')).toHaveCount(0);
    await expect(page.locator('[data-testid=tool-row][data-path="missing.txt"]')).toBeHidden();
    await page.getByTestId('tool-group-summary').click();
    const probe = page.locator('[data-testid=tool-row][data-path="missing.txt"]');
    await expect(probe).toBeVisible();
    await expect(probe).not.toHaveClass(/is-failed/);
    await expect(probe.getByTestId('tool-row-detail')).toBeHidden();
    await expect(probe.getByTestId('tool-row-hint')).toHaveText('不存在');
    await expect(page.locator('[data-testid=tool-row][data-path="a.txt"]')).toBeVisible();
  } finally {
    await srv.kill();
  }
});

test('a failed call keeps the summary collapsed and shows the failure count', async ({ page }) => {
  const { root, dirs: [ws] } = await prepareWorkspaces(['ws']);
  const srv = await startServer({ script: 'tool-fail.json', extraEnv: { WEFT_WORKSPACE_ROOT: root } });
  try {
    await openApp(page, srv);
    await createWorkspace(page, 'demo', ws);
    await newConversation(page);
    await send(page, '看看');
    await expect(page.getByTestId('tool-group-text')).toHaveText('读取 missing.txt 失败', { timeout: 20000 });
    await expect(page.getByTestId('tool-group-fail')).toHaveText('1 个失败');
    await expect(page.locator('[data-testid=tool-row][data-tool=read]')).toBeHidden();
    await page.getByTestId('tool-group-summary').click();
    const row = page.locator('[data-testid=tool-row][data-tool=read]');
    await expect(row).toBeVisible();
    await expect(row.getByTestId('tool-row-status')).toHaveText('失败');
    await expect(row.getByTestId('tool-row-hint')).toHaveText('不存在');
    await expect(row.getByTestId('tool-row-detail')).toBeVisible();
    await expect(row.getByTestId('tool-row-detail')).toContainText(/ENOENT|missing\.txt|no such file|不存在/i);
  } finally {
    await srv.kill();
  }
});

test('a running call shows a spinner and the current action without opening the group', async ({ page }) => {
  const { root, dirs: [ws] } = await prepareWorkspaces(['ws']);
  const srv = await startServer({ script: 'tool-run.json', extraEnv: { WEFT_WORKSPACE_ROOT: root } });
  try {
    await openApp(page, srv);
    await createWorkspace(page, 'demo', ws);
    await newConversation(page);
    await send(page, '跑');
    await expect(page.getByTestId('tool-group-spinner')).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId('tool-group-text')).toHaveText('正在运行 `sleep 3`…');
    await expect(page.getByTestId('assistant-pending')).toHaveCount(0);
    await expect(page.locator('[data-testid=tool-row][data-tool=bash]')).toBeHidden();
    await expect(page.getByTestId('tool-group-text')).toHaveText('运行 sleep 3', { timeout: 15000 });
    await expect(page.getByTestId('tool-group-spinner')).toHaveCount(0);
    await expect(page.getByTestId('assistant-pending')).toHaveCount(0);
    await expect(page.locator('[data-testid=tool-row][data-tool=bash]')).toBeHidden();
  } finally {
    await srv.kill();
  }
});

test('a long group hides earlier calls until clicked; failed rows start expanded', async ({ page }) => {
  const { root, dirs: [ws] } = await prepareWorkspaces(['ws']);
  await seedLong(ws);
  const srv = await startServer({ script: 'tool-long.json', extraEnv: { WEFT_WORKSPACE_ROOT: root } });
  try {
    await openApp(page, srv);
    await createWorkspace(page, 'demo', ws);
    await newConversation(page);
    await send(page, '看看');
    await expect(page.getByTestId('tool-group-text')).toHaveText('读取 prompts 失败 · 读了 t0.txt、t1.txt 等 9 个文件', { timeout: 20000 });
    await expect(page.getByTestId('tool-group-fail')).toHaveText('1 个失败');
    await page.getByTestId('tool-group-summary').click();
    const rows = page.locator('[data-testid=tool-row]');
    await expect(rows).toHaveCount(8);
    await expect(page.getByTestId('tool-group-older')).toHaveText('还有 2 个较早的调用');
    await expect(page.locator('[data-testid=tool-row][data-path="t0.txt"]')).toHaveCount(0);
    const failed = page.locator('[data-testid=tool-row][data-path="prompts"]');
    await expect(failed).toBeVisible();
    await expect(failed.getByTestId('tool-row-detail')).toBeVisible();
    await expect(failed.getByTestId('tool-row-hint')).toHaveText('不存在');

    const thread = page.locator('#center-thread');
    await thread.evaluate((el) => { el.scrollTop = 40; });
    const before = await thread.evaluate((el) => el.scrollTop);
    await page.getByTestId('tool-group-older').click();
    await expect(rows).toHaveCount(10);
    await expect(page.getByTestId('tool-group-older')).toHaveCount(0);
    await expect(page.locator('[data-testid=tool-row][data-path="t0.txt"]')).toBeVisible();
    const after = await thread.evaluate((el) => el.scrollTop);
    if (before > 0) expect(after).toBeGreaterThan(0);
  } finally {
    await srv.kill();
  }
});

test('a command row shows the last 5 lines until show-all', async ({ page }) => {
  const { root, dirs: [ws] } = await prepareWorkspaces(['ws']);
  const srv = await startServer({ script: 'tool-bash-lines.json', extraEnv: { WEFT_WORKSPACE_ROOT: root } });
  try {
    await openApp(page, srv);
    await createWorkspace(page, 'demo', ws);
    await newConversation(page);
    await send(page, '跑');
    await expect(page.getByTestId('message').filter({ hasText: '打完了。' })).toBeVisible({ timeout: 20000 });
    await page.getByTestId('tool-group-summary').click();
    const row = page.locator('[data-testid=tool-row][data-tool=bash]');
    await expect(row).toBeVisible();
    const detail = row.getByTestId('tool-row-detail');
    await expect(detail).toBeHidden();
    await row.click();
    await expect(detail).toBeVisible();
    await expect(detail).toContainText('L26');
    await expect(detail).toContainText('L30');
    await expect(detail).not.toContainText('L25');
    await expect(detail).not.toContainText('L01');
    await detail.getByTestId('tool-output-more').click();
    await expect(detail).toContainText('L01');
    await expect(detail).toContainText('L30');
  } finally {
    await srv.kill();
  }
});

test('an edit row opens the file diff in the right pane', async ({ page }) => {
  const { root, dirs: [ws] } = await prepareWorkspaces(['ws']);
  const srv = await startServer({ script: 'tool-edit.json', extraEnv: { WEFT_WORKSPACE_ROOT: root } });
  try {
    await openApp(page, srv);
    await createWorkspace(page, 'demo', ws);
    await newConversation(page);
    await send(page, '改');
    await expect(page.getByTestId('message').filter({ hasText: '改好了。' })).toBeVisible({ timeout: 20000 });
    const summaries = page.getByTestId('tool-group-summary');
    const n = await summaries.count();
    for (let i = 0; i < n; i += 1) await summaries.nth(i).click();
    const row = page.locator('[data-testid=tool-row][data-tool=edit]');
    await expect(row).toBeVisible();
    await expect(row.getByTestId('tool-row-detail')).toHaveCount(0);
    await row.click();
    const diff = page.locator('.change-file[data-path="note.txt"][data-testid=diff-view]');
    await expect(diff).toBeVisible();
    await expect(diff).toContainText('hello world');
  } finally {
    await srv.kill();
  }
});
