import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startServer, prepareWorkspaces, api } from './helpers/server.mjs';
import { createWorkspace, newConversation, send, statusText, openApp, visualText } from './helpers/ui.mjs';

let srv, ws;
test.beforeEach(async () => {
  const prepared = await prepareWorkspaces(['ws']);
  ws = prepared.dirs[0];
  srv = await startServer({ script: 'basic.json', extraEnv: { PI_WORK_WORKSPACE_ROOT: prepared.root } });
});
test.afterEach(async () => { await srv?.kill(); });

// 43 characters. truncatePath inserts … only past 40, so the collapsed row shows an ellipsis.
const FILE = 'docs/deep/nested/folder/structure/README.md';

test('create workspace & conversation, markdown rendered', async ({ page }) => {
  await openApp(page, srv);
  await createWorkspace(page, 'demo', ws);
  await newConversation(page);
  await send(page, '写个 README');
  await expect(page.getByTestId('message').filter({ hasText: '写个 README' })).toHaveAttribute('data-role', 'user');
  const body = page.locator('[data-testid=message][data-role=assistant] [data-testid=message-body]').first();
  await expect(body.locator('h2')).toHaveText('计划');
  await expect(body.locator('strong')).toHaveText('README');
  await expect(body.locator('pre code')).toContainText('console.log(1)');
  await expect(body.locator('table')).toContainText('a');
  await expect(body.locator('hr')).toHaveCount(1);
  await expect(body.locator('blockquote')).toContainText('引用块');
  await expect(body.locator('.code-block-bar')).toContainText('js');
  await expect(body.locator('script')).toHaveCount(0);
  await expect(body.locator('[onerror]')).toHaveCount(0);
  await expect(body.locator('a[href^="javascript"]')).toHaveCount(0);
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  await expect(statusText(page)).toContainText(/done|完成/i, { timeout: 20000 });
  await expect(page.getByTestId('status-dot').first()).toHaveAttribute('data-status', 'done');
  const chip = page.locator('#center-thread [data-testid=message][data-role=assistant] [data-testid=message-chip]').first();
  await expect(chip).toBeVisible();
  const chipText = await visualText(chip);
  expect(chipText.startsWith('·')).toBe(false);
  expect(chipText).toBe('faux-1');
});

test('tool row collapsed with truncated path and +N -M, expands', async ({ page }) => {
  await openApp(page, srv);
  await createWorkspace(page, 'demo', ws);
  await newConversation(page);
  await send(page, 'go');
  const summary = page.getByTestId('tool-group-summary').first();
  await expect(summary).toContainText(/改了/, { timeout: 20000 });
  await expect(page.getByTestId('tool-group-text').first()).toHaveText('改了 README.md');
  await summary.click();
  const row = page.locator('[data-testid=tool-row][data-tool=write]').first();
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute('data-path', FILE);
  await expect(row.getByTestId('tool-row-path')).toContainText('…');
  await expect(row.getByTestId('tool-row-added')).toHaveText(/\+3/);
  await expect(row.getByTestId('tool-row-removed')).toHaveText(/−0|-0/);
  await expect(row.getByTestId('tool-row-detail')).toBeHidden();
  await row.click();
  await expect(row.getByTestId('tool-row-detail')).toBeVisible();
  await expect(row.getByTestId('tool-row-detail')).toContainText(FILE);
});

test('click changed file -> diff panel; md editor save persists', async ({ page }) => {
  await openApp(page, srv);
  await createWorkspace(page, 'demo', ws);
  await newConversation(page);
  await send(page, 'go');
  await expect(statusText(page)).toContainText(/done|完成/i, { timeout: 20000 });
  // Changed files are listed with their diffs unfolded; clicking the selected file folds it, a second click unfolds it.
  const fileRow = page.locator(`[data-testid=changed-file][data-path="${FILE}"]`);
  const diff = page.locator(`.change-file[data-path="${FILE}"][data-testid=diff-view]`);
  await expect(diff).toBeVisible();
  await expect(diff).toContainText('line two');
  await fileRow.click();
  await expect(diff).toHaveCount(0);
  await fileRow.click();
  await expect(diff).toContainText('line two');
  await page.getByTestId('file-open-editor').click(); // .md -> markdown editor
  const editor = page.getByTestId('md-editor');
  await expect(editor).toBeVisible({ timeout: 10000 });
  const ce = editor.locator('[contenteditable=true]').first();
  await ce.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('\nEDITED-BY-E2E');
  await page.getByTestId('md-editor-save').click();
  await expect.poll(() => fs.readFile(path.join(ws, FILE), 'utf8')).toContain('EDITED-BY-E2E');
  await page.reload();
  await expect(page.getByTestId('md-editor')).toContainText('EDITED-BY-E2E');
});

test('refresh keeps workspace, conversation, messages and status', async ({ page }) => {
  await openApp(page, srv);
  await createWorkspace(page, 'keep', ws);
  await newConversation(page);
  await send(page, 'persist me');
  await expect(statusText(page)).toContainText(/done|完成/i, { timeout: 20000 });
  await page.reload();
  await expect(page.getByTestId('workspace-item').filter({ hasText: 'keep' })).toBeVisible();
  await expect(page.getByTestId('message').filter({ hasText: 'persist me' })).toBeVisible();
  await expect(page.locator('[data-testid=tool-row]')).not.toHaveCount(0);
  await expect(page.getByTestId('status-dot').first()).toHaveAttribute('data-status', 'done');
});

test('sandbox: file API rejects escape', async () => {
  const w = await api(srv.url, 'POST', '/workspaces', { name: 'sb', path: ws });
  expect(w.status).toBe(201);
  const r = await api(srv.url, 'GET', `/workspaces/${w.body.id}/files?path=${encodeURIComponent('../../etc/passwd')}`);
  expect(r.status).toBe(403);
  expect(r.body.error).toBe('E_SANDBOX');
});

test('new workspace: browse to a folder fills path and name', async ({ page }) => {
  await openApp(page, srv);
  await page.getByTestId('workspace-new').click();
  await page.getByTestId('workspace-browse').click();
  const browser = page.getByTestId('dir-browser');
  await expect(browser).toBeVisible();
  await browser.getByTestId('dir-row').filter({ hasText: path.basename(ws) }).click();
  await browser.getByTestId('dir-choose-here').click();
  await expect(browser).toBeHidden();
  await expect(page.getByTestId('workspace-path-input')).toHaveValue(ws);
  await expect(page.getByTestId('workspace-name-input')).toHaveValue(path.basename(ws));
  await page.getByTestId('workspace-create-submit').click();
  await expect(page.getByTestId('workspace-item').filter({ hasText: path.basename(ws) })).toBeVisible();
});

test('remove workspace from the project menu keeps the folder on disk', async ({ page }) => {
  await openApp(page, srv);
  await createWorkspace(page, 'gone', ws);
  const item = page.getByTestId('workspace-item').filter({ hasText: 'gone' });
  await item.hover();
  await item.locator('[data-action=project-menu]').click();
  await page.locator('#ctx-menu .ctx-menu-item.is-danger').click();
  await expect(page.getByTestId('confirm-dialog')).toBeVisible();
  await expect(page.getByTestId('confirm-message')).toContainText(ws);
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByTestId('workspace-item')).toHaveCount(0);
  await expect.poll(() => fs.stat(ws).then((st) => st.isDirectory())).toBe(true);
});
