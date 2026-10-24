import { test, expect } from '@playwright/test';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startServer, tmpdir, api } from './helpers/server.mjs';
import { login, waitForStableLayout } from './helpers/ui.mjs';

let srv;

test.afterEach(async () => { await srv?.kill(); srv = null; });

function addGrokSource(dataDir) {
  const db = new DatabaseSync(path.join(dataDir, 'weft.sqlite'));
  const row = db.prepare('SELECT json FROM settings WHERE id = ?').get('app');
  const settings = JSON.parse(row.json);
  settings.sources = Array.isArray(settings.sources) ? settings.sources : [];
  if (!settings.sources.some((source) => source.id === 'grok' || source.kind === 'grok')) {
    settings.sources.unshift({
      id: 'grok',
      kind: 'grok',
      vendor: 'grok',
      name: 'Grok 订阅',
      baseUrl: '',
      apiKey: '',
      models: ['grok-build'],
    });
    db.prepare('UPDATE settings SET json = ? WHERE id = ?').run(JSON.stringify(settings), 'app');
  }
  db.close();
}

async function boot() {
  const root = await tmpdir('piw-wsroot-');
  srv = await startServer({
    script: 'basic.json',
    extraEnv: { WEFT_WORKSPACE_ROOT: root },
  });
  const token = '';
  const created = await api(srv.url, 'POST', '/sources', {
    vendor: 'openai',
    name: 'OpenAI',
    apiKey: 'sk-layout-test-key1',
    models: ['gpt-4o'],
  }, token);
  expect(created.status).toBe(201);
  addGrokSource(srv.dataDir);
  return token;
}

async function expectCompactRows(page) {
  const rows = page.getByTestId('model-source');
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: 'Grok 订阅' })).toBeVisible();
  await expect(rows.filter({ hasText: 'OpenAI' })).toBeVisible();
  await waitForStableLayout(page, rows.first().locator('.ms-src-main'));
  const count = await rows.count();
  for (let i = 0; i < count; i += 1) {
    const row = rows.nth(i);
    const name = await row.locator('.ms-src-main').boundingBox();
    expect(name?.width ?? 0).toBeGreaterThan(200);
    const buttons = row.locator('.ms-src-acts button');
    const buttonCount = await buttons.count();
    expect(buttonCount).toBeGreaterThan(0);
    for (let j = 0; j < buttonCount; j += 1) {
      const button = await buttons.nth(j).boundingBox();
      expect(button?.width ?? 0).toBeLessThan(160);
    }
  }
}

for (const viewport of [
  { width: 1000, height: 760 },
  { width: 1440, height: 900 },
]) {
  test(`source rows stay compact at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    const token = await boot();
    await page.setViewportSize(viewport);
    await login(page, srv.url, token);
    await page.locator('[data-action=open-settings]').click();
    await page.locator('[data-tab=models]').click();
    await expect(page.getByTestId('models-page')).toBeVisible();
    await waitForStableLayout(page, page.locator('.sm'));
    await expectCompactRows(page);
  });
}

test('settings has no Agent tab; default model can be chosen, saved, and kept after refresh', async ({ page }) => {
  const token = await boot();
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, srv.url, token);
  await page.locator('[data-action=open-settings]').click();
  await expect(page.locator('.sm')).toBeVisible();
  await expect(page.getByTestId('settings-tab-agents')).toHaveCount(0);
  await expect(page.locator('[data-action=set-settings-tab][data-tab=agents]')).toHaveCount(0);
  const missingRoles = await api(srv.url, 'GET', '/roles', null, token);
  expect(missingRoles.status).toBe(404);
  await page.locator('[data-tab=models]').click();
  await expect(page.getByTestId('models-page')).toBeVisible();
  await expect(page.locator('[data-testid=model-role]')).toHaveCount(1);
  await expect(page.getByText('默认模型', { exact: true }).first()).toBeVisible();
  const pick = page.getByTestId('model-pick');
  await pick.click();
  await page.locator('[data-action=ms-choose-model][data-model="gpt-4o"]').click();
  await page.getByTestId('model-save').click();
  await expect(page.locator('.toast-msg')).toContainText('设置已保存');
  const saved = await api(srv.url, 'GET', '/settings', null, token);
  expect(saved.status).toBe(200);
  expect(saved.body.models.default.model).toBe('gpt-4o');
  await page.reload();
  await expect(page.getByTestId('composer-agent')).toBeVisible();
  await page.locator('[data-action=open-settings]').click();
  await page.locator('[data-tab=models]').click();
  await expect(page.getByTestId('model-pick')).toContainText('gpt-4o');
  expect(pageErrors, 'console has no unhandled errors when /api/roles is 404').toEqual([]);
});
