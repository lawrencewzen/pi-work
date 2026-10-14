import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startServer, prepareWorkspaces, api, authToken } from './helpers/server.mjs';
import { createWorkspace, newConversation, send, statusText, openApp } from './helpers/ui.mjs';

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
  await expect(statusText(page)).toContainText(/done|完成/i, { timeout: 20000 });
  await expect(page.getByTestId('status-dot').first()).toHaveAttribute('data-status', 'done');
});

test('tool row collapsed with truncated path and +N -M, expands', async ({ page }) => {
  await openApp(page, srv);
  await createWorkspace(page, 'demo', ws);
  await newConversation(page);
  await send(page, 'go');
  const row = page.locator('[data-testid=tool-row][data-tool=write]').first();
  await expect(row).toBeVisible({ timeout: 20000 });
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
  await page.locator(`[data-testid=changed-file][data-path="${FILE}"]`).click();
  const diff = page.getByTestId('diff-view');
  await expect(diff).toBeVisible();
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
  const token = await authToken(srv.dataDir);
  const w = await api(srv.url, 'POST', '/workspaces', { name: 'sb', path: ws }, token);
  expect(w.status).toBe(201);
  const r = await api(srv.url, 'GET', `/workspaces/${w.body.id}/files?path=${encodeURIComponent('../../etc/passwd')}`, null, token);
  expect(r.status).toBe(403);
  expect(r.body.error).toBe('E_SANDBOX');
});
