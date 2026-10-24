import { test, expect } from '@playwright/test';
import http from 'node:http';
import { startServer, api } from './helpers/server.mjs';
import { login } from './helpers/ui.mjs';

let srv;
const closers = [];

test.afterEach(async () => {
  await srv?.kill();
  srv = null;
  while (closers.length) {
    const close = closers.pop();
    await new Promise((resolve) => close(resolve));
  }
});

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      closers.push((done) => server.close(done));
      resolve(`http://127.0.0.1:${server.address().port}/v1`);
    });
  });
}

async function addSource(token, { name, baseUrl, models }) {
  const created = await api(srv.url, 'POST', '/sources', {
    vendor: 'custom',
    name,
    baseUrl,
    apiKey: 'sk-probe-ui-key1',
    models,
  }, token);
  expect(created.status).toBe(201);
  return created.body.id;
}

async function openModels(page, token) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, srv.url, token);
  await page.locator('[data-action=open-settings]').click();
  await page.locator('[data-tab=models]').click();
  await expect(page.getByTestId('models-page')).toBeVisible();
}

test('row test shows a busy state, then an inline pass, and no toast', async ({ page }) => {
  const slow = await listen(async (req, res) => {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'deepseek-chat' }] }));
  });
  const idle = await listen((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'other-model' }] }));
  });
  srv = await startServer({ script: 'basic.json' });
  const token = '';
  const slowId = await addSource(token, { name: '甲', baseUrl: slow, models: [] });
  const idleId = await addSource(token, { name: '乙', baseUrl: idle, models: ['other-model'] });
  await openModels(page, token);
  const slowRow = page.locator(`[data-testid=model-source][data-source-id="${slowId}"]`);
  const idleBtn = page.locator(`[data-testid=model-source][data-source-id="${idleId}"]`).getByTestId('model-row-test');
  const slowBtn = slowRow.getByTestId('model-row-test');
  await slowBtn.click();
  await expect(slowBtn).toBeDisabled();
  await expect(slowBtn).toContainText('测试中');
  await expect(slowBtn.locator('.ms-spin')).toBeVisible();
  await expect(idleBtn).toBeEnabled();
  await expect(page.locator('.toast-msg')).toHaveCount(0);
  await expect(slowRow.getByTestId('model-row-result')).toContainText('测试通过', { timeout: 5000 });
  await expect(slowRow.locator('.ms-tag', { hasText: 'deepseek-chat' })).toBeVisible();
  await expect(slowBtn).toBeEnabled();
  await expect(page.locator('.toast-msg')).toHaveCount(0);
});

test('a 401 probe shows the localized failure on the row and no toast', async ({ page }) => {
  const denied = await listen((req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
  });
  srv = await startServer({ script: 'basic.json' });
  const token = '';
  const id = await addSource(token, { name: '拒', baseUrl: denied, models: ['hidden'] });
  await openModels(page, token);
  const row = page.locator(`[data-testid=model-source][data-source-id="${id}"]`);
  await row.getByTestId('model-row-test').click();
  await expect(row.getByTestId('model-row-result')).toContainText('鉴权失败');
  await expect(row.locator('.ms-dot').first()).toHaveClass(/bad/);
  await expect(page.locator('.toast-msg')).toHaveCount(0);
});

test('an empty model list becomes selectable after a row test and stays saved', async ({ page }) => {
  const upstream = await listen((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'deepseek-chat' }] }));
  });
  srv = await startServer({ script: 'basic.json' });
  const token = '';
  const id = await addSource(token, { name: 'DeepSeek', baseUrl: upstream, models: [] });
  await openModels(page, token);
  const row = page.locator(`[data-testid=model-source][data-source-id="${id}"]`);
  await expect(row.getByTestId('model-none-enabled')).toHaveText('未启用模型');
  const pick = page.locator('[data-testid=model-role] [data-testid=model-pick]');
  await pick.click();
  await expect(page.getByTestId('model-pop-empty')).toContainText('还没有启用的模型');
  await expect(page.getByTestId('model-choose-models')).toHaveText('去选择模型');
  await pick.click();
  await expect(page.getByTestId('model-pop')).toBeHidden();
  await row.getByTestId('model-row-test').click();
  await expect(row.getByTestId('model-row-result')).toContainText('测试通过');
  await expect(row.locator('.ms-tag', { hasText: 'deepseek-chat' })).toBeVisible();
  await pick.click();
  await page.locator('[data-action=ms-choose-model][data-model="deepseek-chat"]').click();
  await page.getByTestId('model-save').click();
  await expect(page.locator('.toast-msg')).toContainText('设置已保存');
  const saved = await api(srv.url, 'GET', '/settings', null, token);
  expect(saved.body.models.default).toEqual({ sourceId: id, model: 'deepseek-chat' });
  await page.reload();
  await expect(page.getByTestId('composer-agent')).toBeVisible();
  await page.locator('[data-action=open-settings]').click();
  await page.locator('[data-tab=models]').click();
  const savedPick = page.locator('[data-testid=model-role] [data-testid=model-pick]');
  await expect(savedPick).toContainText('deepseek-chat');
  await expect(savedPick).not.toContainText('自动');
});
