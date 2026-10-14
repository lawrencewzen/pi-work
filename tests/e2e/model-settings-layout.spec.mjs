import { test, expect } from '@playwright/test';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startServer, tmpdir, api, authToken } from './helpers/server.mjs';
import { login } from './helpers/ui.mjs';

let srv;

test.afterEach(async () => { await srv?.kill(); srv = null; });

function addGrokSource(dataDir) {
  const db = new DatabaseSync(path.join(dataDir, 'pi-work.sqlite'));
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
    extraEnv: { PI_WORK_WORKSPACE_ROOT: root },
  });
  const token = await authToken(srv.dataDir);
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
    await expectCompactRows(page);
  });
}
