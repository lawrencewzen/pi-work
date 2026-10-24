import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startServer, tmpdir, api } from './helpers/server.mjs';
import { createWorkspace, createConversation, send, statusText, login } from './helpers/ui.mjs';

const CHIP_ZERO_128 = /已用 0% · 剩 100% · 128k|Used 0% · Left 100% · 128k/;
const CHIP_ZERO_200 = /已用 0% · 剩 100% · 200k|Used 0% · Left 100% · 200k/;
const CHIP_USED_200 = /已用 8% · 剩 92% · 200k|Used 8% · Left 92% · 200k/;
const CHIP_USED_256 = /已用 6% · 剩 94% · 256k|Used 6% · Left 94% · 256k/;

let srv;

test.afterEach(async () => { await srv?.kill(); srv = null; });

async function boot({ script, models } = {}) {
  const root = await tmpdir('piw-wsroot-');
  const ws = path.join(root, 'repo');
  await fs.mkdir(ws);
  srv = await startServer({
    script: script || 'basic.json',
    extraEnv: {
      WEFT_WORKSPACE_ROOT: root,
      LLM_CONTEXT_WINDOW: '200000',
    },
  });
  const token = '';
  let sourceId = null;
  if (models) {
    const defaultModel = models.default?.model || models.default;
    const listed = Array.isArray(models.listed) ? models.listed : [];
    const names = [...new Set([defaultModel, ...listed].filter(Boolean))];
    const created = await api(srv.url, 'POST', '/sources', {
      vendor: 'openai',
      name: 'Chip',
      apiKey: 'sk-chip-test-key1',
      models: names,
    }, token);
    expect(created.status).toBe(201);
    sourceId = created.body.id;
    const saved = await api(srv.url, 'PUT', '/settings', {
      models: { default: { sourceId, model: defaultModel } },
    }, token);
    expect(saved.status).toBe(200);
  }
  return { ws, token, sourceId };
}

async function openApp(page, token) {
  await login(page, srv.url, token);
}

function chip(page) {
  return page.locator('#composer-agent-chip');
}

function menu(page) {
  return page.getByTestId('composer-agent-menu');
}

function contextLimit(page) {
  return page.getByTestId('composer-context-limit');
}

function cssTransparent(color) {
  const v = String(color || '').replace(/\s+/g, '');
  return v === 'transparent' || v === 'rgba(0,0,0,0)';
}

async function conversationId(page) {
  return page.getByTestId('conversation-item').first().getAttribute('data-id');
}

test('context chip shows reported usage over the configured window', async ({ page }) => {
  const { ws, token } = await boot({ script: 'usage.json' });
  await openApp(page, token);
  await expect(page.getByTestId('composer-context')).toHaveText(CHIP_ZERO_128);

  await createWorkspace(page, 'usage', ws);
  await createConversation(page);
  await expect(page.getByTestId('composer-context')).toHaveText(CHIP_ZERO_128);

  await send(page, 'count tokens');
  await expect(page.getByTestId('composer-context')).toHaveText(CHIP_USED_200, { timeout: 20000 });
  await expect(statusText(page)).toContainText(/done|完成/i, { timeout: 20000 });

  const cid = await conversationId(page);
  const before = await api(srv.url, 'GET', `/conversations/${cid}`, null, token);
  expect(before.status).toBe(200);
  expect(before.body.contextLabel).toBe('16.4k / 200k');
  expect(before.body.usage?.total).toBe(16400);
  expect(before.body.contextWindow).toBe(200000);

  await page.reload();
  await expect(page.getByTestId('composer-context')).toHaveText(CHIP_USED_200);
  await expect(chip(page)).toHaveText(/未配置模型|No model configured/);
});

test('context chip stays at 0% when the model reports no usage', async ({ page }) => {
  const { ws, token } = await boot({ script: 'no-usage.json' });
  await openApp(page, token);
  await expect(chip(page)).toHaveText(/未配置模型|No model configured/);

  await createWorkspace(page, 'plain', ws);
  await createConversation(page);
  await send(page, 'hello');
  await expect(statusText(page)).toContainText(/done|完成/i, { timeout: 20000 });
  await expect(page.getByTestId('composer-context')).toHaveText(CHIP_ZERO_200);
  await expect(chip(page)).toHaveText(/未配置模型|No model configured/);

  const cid = await conversationId(page);
  const conv = await api(srv.url, 'GET', `/conversations/${cid}`, null, token);
  expect(conv.body.usage).toBeNull();
  expect(conv.body.contextLabel).toBe('—');

  await page.reload();
  await expect(page.getByTestId('composer-context')).toHaveText(CHIP_ZERO_200);
  await expect(chip(page)).toHaveText(/未配置模型|No model configured/);
});

test('agent chip lists models by source and switches the conversation model', async ({ page }) => {
  const { ws, token, sourceId } = await boot({
    script: 'no-usage.json',
    models: { default: { model: 'grok-4.6' }, listed: ['grok-4.6', 'grok-4'] },
  });
  await openApp(page, token);
  await expect(chip(page)).toHaveText('grok-4.6');
  await expect(page.getByTestId('composer-agent')).toHaveAttribute('aria-expanded', 'false');

  await page.getByTestId('composer-agent').click();
  await expect(page.locator('.toast-msg')).toHaveText(/请先选择或创建一个工作区|Please select or create a workspace first/);
  await expect(menu(page)).toBeHidden();

  await createWorkspace(page, 'dispatch', ws);
  await createConversation(page);
  await expect(chip(page), 'chip shows the default model when the conversation has no override').toHaveText('grok-4.6');
  await expect(page.getByTestId('composer-context')).toHaveText(CHIP_ZERO_200);

  await page.getByTestId('composer-agent').click();
  await expect(menu(page)).toBeVisible();
  await expect(page.getByTestId('composer-agent')).toHaveAttribute('aria-expanded', 'true');
  await expect(menu(page)).toContainText(/默认（grok-4\.6）|Default \(grok-4\.6\)/);
  await expect(menu(page)).toContainText('Chip');
  await expect(menu(page)).toContainText('grok-4.6');
  await expect(menu(page)).toContainText('grok-4');
  await expect(menu(page).locator('[data-action=pick-dispatch]')).toHaveCount(0);
  await expect(menu(page).locator('[data-role-id]')).toHaveCount(0);

  await menu(page).locator('[data-action=pick-model][data-model="grok-4"]').click();
  await expect(menu(page)).toBeHidden();
  await expect(chip(page)).toHaveText('grok-4');
  await expect(page.getByTestId('composer-agent')).toHaveAttribute('title', /grok-4/);

  await send(page, 'hello');
  await expect(statusText(page)).toContainText(/done|完成/i, { timeout: 20000 });
  await expect(chip(page)).toHaveText('grok-4');

  const cid = await conversationId(page);
  const pinned = await api(srv.url, 'GET', `/conversations/${cid}`, null, token);
  expect(pinned.body.modelSourceId).toBe(sourceId);
  expect(pinned.body.modelId).toBe('grok-4');

  await page.getByTestId('composer-agent').click();
  await expect(menu(page).locator('[data-pipeline-id]')).toHaveCount(0);
  await menu(page).locator('[data-action=pick-model][data-follow-default="1"]').click();
  await expect(chip(page)).toHaveText('grok-4.6');
  const cleared = await api(srv.url, 'GET', `/conversations/${cid}`, null, token);
  expect(cleared.body.modelSourceId).toBeNull();
  expect(cleared.body.modelId).toBeNull();

  await page.reload();
  await expect(chip(page)).toHaveText('grok-4.6');
  await expect(page.getByTestId('composer-context')).toHaveText(CHIP_ZERO_200);
});

test('draft model choice is saved on the conversation and can return to default', async ({ page }) => {
  const { ws, token, sourceId } = await boot({
    script: 'no-usage.json',
    models: { default: { model: 'grok-4.6' }, listed: ['grok-4.6', 'grok-4'] },
  });
  await openApp(page, token);
  await createWorkspace(page, 'draft-model', ws);
  await createConversation(page);
  await expect(chip(page)).toHaveText('grok-4.6');

  await page.getByTestId('composer-agent').click();
  await menu(page).locator('[data-action=pick-model][data-model="grok-4"]').click();
  await expect(chip(page)).toHaveText('grok-4');

  await send(page, 'hello');
  await expect(statusText(page)).toContainText(/done|完成/i, { timeout: 20000 });
  await expect(chip(page)).toHaveText('grok-4');

  const cid = await conversationId(page);
  const created = await api(srv.url, 'GET', `/conversations/${cid}`, null, token);
  expect(created.body.modelSourceId).toBe(sourceId);
  expect(created.body.modelId).toBe('grok-4');

  await page.reload();
  await expect(chip(page)).toHaveText('grok-4');

  await page.getByTestId('composer-agent').click();
  await menu(page).locator('[data-action=pick-model][data-follow-default="1"]').click();
  await expect(chip(page)).toHaveText('grok-4.6');
  const cleared = await api(srv.url, 'GET', `/conversations/${cid}`, null, token);
  expect(cleared.body.modelSourceId).toBeNull();
  expect(cleared.body.modelId).toBeNull();

  await page.reload();
  await expect(chip(page)).toHaveText('grok-4.6');
});

test('agent chip stays usable while a run is busy', async ({ page }) => {
  const { ws, token } = await boot({
    script: 'slow.json',
    models: { default: { model: 'grok-4.6' }, listed: ['grok-4.6', 'grok-4'] },
  });
  await openApp(page, token);
  await createWorkspace(page, 'busy', ws);
  await createConversation(page);
  await send(page, 'run');
  await expect(statusText(page)).toContainText(/running|运行/i);

  await page.getByTestId('composer-agent').click();
  await expect(menu(page)).toBeVisible();
  await expect(page.locator('.toast-msg')).toHaveCount(0);
  await menu(page).locator('[data-action=pick-model][data-model="grok-4"]').click();
  await expect(chip(page)).toHaveText('grok-4');

  const cid = await conversationId(page);
  const conv = await api(srv.url, 'GET', `/conversations/${cid}`, null, token);
  expect(conv.body.modelId).toBe('grok-4');
});

test('context chip menu sets the model window and keeps it after refresh', async ({ page }) => {
  const { ws, token, sourceId } = await boot({
    script: 'usage.json',
    models: { default: { model: 'grok-4.6' } },
  });
  const puts = [];
  page.on('request', (req) => {
    if (req.method() === 'PUT' && /\/api\/sources\//.test(req.url())) {
      puts.push({ url: req.url(), body: JSON.parse(req.postData() || '{}') });
    }
  });
  await openApp(page, token);
  await createWorkspace(page, 'ctx-window', ws);
  await createConversation(page);
  await expect(page.getByTestId('composer-context')).toHaveText(CHIP_ZERO_200);
  await expect(contextLimit(page)).toBeEnabled();

  const ctxMenu = page.getByTestId('composer-context-menu');
  await test.step('usage ring and used-percent text are display-only', async () => {
    await page.locator('#composer-context .ctx-ring').click();
    await expect(ctxMenu, 'clicking the usage ring does not open the context menu').toBeHidden();
    await page.locator('#composer-context .ctx-used').click();
    await expect(ctxMenu, 'clicking the used-percent text does not open the context menu').toBeHidden();

    await page.locator('#composer-context .ctx-ring').hover();
    const ringHover = await page.locator('#composer-context .ctx-ring').evaluate((el) => ({
      cursor: getComputedStyle(el).cursor,
      background: getComputedStyle(el).backgroundColor,
    }));
    expect(ringHover.cursor, 'usage ring cursor is default').toBe('default');
    expect(cssTransparent(ringHover.background), 'usage ring hover background stays transparent').toBe(true);

    await page.locator('#composer-context .ctx-used').hover();
    const usageHover = await page.locator('#composer-context .ctx-used').evaluate((el) => {
      const host = el.closest('.chip-context');
      const display = document.getElementById('composer-context-display');
      return {
        cursor: getComputedStyle(el).cursor,
        background: getComputedStyle(el).backgroundColor,
        hostCursor: host ? getComputedStyle(host).cursor : '',
        hostBackground: host ? getComputedStyle(host).backgroundColor : '',
        displayBackground: display ? getComputedStyle(display).backgroundColor : '',
      };
    });
    expect(usageHover.cursor, 'usage text cursor is default').toBe('default');
    expect(usageHover.hostCursor, 'usage host cursor is default').toBe('default');
    expect(cssTransparent(usageHover.background), 'usage text hover background stays transparent').toBe(true);
    expect(cssTransparent(usageHover.hostBackground), 'usage host hover background stays transparent').toBe(true);
    expect(cssTransparent(usageHover.displayBackground), 'usage display hover background stays transparent').toBe(true);
  });

  await test.step('only the window limit chip looks and acts like a button', async () => {
    await page.getByTestId('composer-agent').hover();
    const agentHoverBg = await page.getByTestId('composer-agent').evaluate((el) => getComputedStyle(el).backgroundColor);
    await contextLimit(page).hover();
    const limitHoverBg = await contextLimit(page).evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(cssTransparent(limitHoverBg), 'limit chip hover has a background').toBe(false);
    expect(limitHoverBg, 'limit chip hover matches model selector hover').toBe(agentHoverBg);
  });

  await send(page, 'count tokens');
  await expect(page.getByTestId('composer-context')).toHaveText(CHIP_USED_200, { timeout: 20000 });
  await expect(statusText(page)).toContainText(/done|完成/i, { timeout: 20000 });

  await contextLimit(page).click();
  await expect(contextLimit(page)).toHaveAttribute('aria-expanded', 'true');
  await expect(ctxMenu).toBeVisible();
  const openLimitBg = await contextLimit(page).evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(cssTransparent(openLimitBg), 'limit chip keeps background while the menu is open').toBe(false);
  await expect(ctxMenu).toContainText(/grok-4\.6/);
  await expect(ctxMenu).toContainText(/设置上下文上限|Set context window/);
  await expect(ctxMenu).toContainText(/已用\s+16\.4k · 8%|Used\s+16\.4k · 8%/);
  await expect(ctxMenu).toContainText(/剩余\s+184k · 92%|Left\s+184k · 92%/);
  const putDone = page.waitForResponse((res) => res.request().method() === 'PUT' && /\/api\/sources\//.test(res.url()) && res.ok());
  await ctxMenu.locator('[data-action=pick-context-window][data-tokens="256000"]').click();
  await putDone;
  await expect(ctxMenu).toBeHidden();
  await expect(page.getByTestId('composer-context')).toHaveText(CHIP_USED_256);
  expect(puts).toHaveLength(1);
  expect(puts[0].url).toContain(`/api/sources/${sourceId}`);
  expect(puts[0].body).toEqual({ contextWindows: { 'grok-4.6': 256000 } });

  await page.locator('[data-action=open-settings]').click();
  await page.locator('[data-tab=models]').click();
  await expect(page.getByTestId('context-window-section')).toBeVisible();
  const row = page.getByTestId('context-window-row').filter({ hasText: 'grok-4.6' });
  await expect(row.getByTestId('context-window-pick')).toContainText('256k');
  await expect(row).toContainText(/已改，默认 200k|Custom, default 200k/);

  await page.locator('[data-action=close-settings]').click();
  await expect(page.locator('#settings-overlay')).toBeHidden();
  await page.reload();
  await expect(page.getByTestId('composer-context')).toHaveText(CHIP_USED_256);
  const settings = await api(srv.url, 'GET', '/settings', null, token);
  expect(settings.status).toBe(200);
  const saved = (settings.body.sources || []).find((item) => item.id === sourceId);
  expect(saved?.contextWindows?.['grok-4.6']).toBe(256000);
});
