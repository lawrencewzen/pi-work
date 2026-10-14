import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startServer, tmpdir, api, authToken } from './helpers/server.mjs';
import { createWorkspace, createConversation, send, statusText, login } from './helpers/ui.mjs';

const EM = '—';

let srv;

test.afterEach(async () => { await srv?.kill(); srv = null; });

async function boot({ script, models } = {}) {
  const root = await tmpdir('piw-wsroot-');
  const ws = path.join(root, 'repo');
  await fs.mkdir(ws);
  srv = await startServer({
    script: script || 'basic.json',
    extraEnv: {
      PI_WORK_WORKSPACE_ROOT: root,
      LLM_CONTEXT_WINDOW: '200000',
    },
  });
  const token = await authToken(srv.dataDir);
  let sourceId = null;
  if (models) {
    const names = [];
    const bindings = {};
    for (const [roleId, value] of Object.entries(models)) {
      const model = value?.model;
      if (!model) continue;
      if (!names.includes(model)) names.push(model);
      bindings[roleId] = { model };
    }
    const created = await api(srv.url, 'POST', '/sources', {
      vendor: 'openai',
      name: 'Chip',
      apiKey: 'sk-chip-test-key1',
      models: names,
    }, token);
    expect(created.status).toBe(201);
    sourceId = created.body.id;
    for (const binding of Object.values(bindings)) binding.sourceId = sourceId;
    const saved = await api(srv.url, 'PUT', '/settings', { models: bindings }, token);
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

async function conversationId(page) {
  return page.getByTestId('conversation-item').first().getAttribute('data-id');
}

test('context chip shows reported usage over the configured window', async ({ page }) => {
  const { ws, token } = await boot({ script: 'usage.json' });
  await openApp(page, token);
  await expect(page.getByTestId('composer-context')).toHaveText(EM);

  await createWorkspace(page, 'usage', ws);
  await createConversation(page);
  await expect(page.getByTestId('composer-context')).toHaveText(EM);

  await send(page, 'count tokens');
  await expect(page.getByTestId('composer-context')).toHaveText('16.4k / 200k', { timeout: 20000 });
  await expect(statusText(page)).toContainText(/done|完成/i, { timeout: 20000 });

  const cid = await conversationId(page);
  const before = await api(srv.url, 'GET', `/conversations/${cid}`, null, token);
  expect(before.status).toBe(200);
  expect(before.body.contextLabel).toBe('16.4k / 200k');
  expect(before.body.usage?.total).toBe(16400);
  expect(before.body.contextWindow).toBe(200000);

  await page.reload();
  await expect(page.getByTestId('composer-context')).toHaveText('16.4k / 200k');
  await expect(chip(page)).toHaveText('Agent');
});

test('context chip stays an em dash when the model reports no usage', async ({ page }) => {
  const { ws, token } = await boot({ script: 'no-usage.json' });
  await openApp(page, token);
  await expect(chip(page)).toHaveText('Agent');

  await createWorkspace(page, 'plain', ws);
  await createConversation(page);
  await send(page, 'hello');
  await expect(statusText(page)).toContainText(/done|完成/i, { timeout: 20000 });
  await expect(page.getByTestId('composer-context')).toHaveText(EM);
  await expect(chip(page)).toHaveText('Agent');

  const cid = await conversationId(page);
  const conv = await api(srv.url, 'GET', `/conversations/${cid}`, null, token);
  expect(conv.body.usage).toBeNull();
  expect(conv.body.contextLabel).toBe(EM);

  await page.reload();
  await expect(page.getByTestId('composer-context')).toHaveText(EM);
  await expect(chip(page)).toHaveText('Agent');
});

test('agent chip lists configured roles and switches the conversation target', async ({ page }) => {
  const { ws, token } = await boot({
    script: 'no-usage.json',
    models: { default: { model: 'grok-4.6' }, coder: { model: 'grok-4' } },
  });
  await openApp(page, token);
  await expect(chip(page)).toHaveText('Agent · grok-4.6');
  await expect(page.getByTestId('composer-agent')).toHaveAttribute('aria-expanded', 'false');

  await page.getByTestId('composer-agent').click();
  await expect(page.locator('.toast-msg')).toHaveText(/请先选择对话|Select a conversation first/);
  await expect(menu(page)).toBeHidden();

  await createWorkspace(page, 'dispatch', ws);
  await createConversation(page);
  await expect(chip(page)).toHaveText('Agent · grok-4.6');
  await expect(page.getByTestId('composer-context')).toHaveText(EM);

  await page.getByTestId('composer-agent').click();
  await expect(menu(page)).toBeVisible();
  await expect(page.getByTestId('composer-agent')).toHaveAttribute('aria-expanded', 'true');
  await expect(menu(page)).toContainText('grok-4.6');
  await expect(menu(page)).toContainText('grok-4');
  await expect(menu(page)).toContainText(/选择角色|Choose role/);

  await menu(page).locator('[data-role-id="coder"]:not([data-pipeline-id])').click();
  await expect(menu(page)).toBeHidden();
  await expect(chip(page)).toHaveText('编码 · grok-4');
  await expect(page.getByTestId('composer-agent')).toHaveAttribute('title', /grok-4/);

  const cid = await conversationId(page);
  const coder = await api(srv.url, 'GET', `/conversations/${cid}`, null, token);
  expect(coder.body.roleId).toBe('coder');
  expect(coder.body.pipelineId).toBeNull();

  await page.getByTestId('composer-agent').click();
  await menu(page).locator('[data-pipeline-id="demo"]').click();
  await expect(chip(page)).toHaveText('编码 · grok-4');
  const piped = await api(srv.url, 'GET', `/conversations/${cid}`, null, token);
  expect(piped.body.pipelineId).toBe('demo');
  expect(piped.body.roleId).toBe('coder');
  expect(piped.body.pipelineStep).toBe(0);

  await page.getByTestId('composer-agent').click();
  await menu(page).locator('[data-action="pick-dispatch"][data-role-id=""]').click();
  await expect(chip(page)).toHaveText('Agent · grok-4.6');
  const cleared = await api(srv.url, 'GET', `/conversations/${cid}`, null, token);
  expect(cleared.body.roleId).toBeNull();
  expect(cleared.body.pipelineId).toBeNull();

  await page.reload();
  await expect(chip(page)).toHaveText('Agent · grok-4.6');
  await expect(page.getByTestId('composer-context')).toHaveText(EM);
});

test('agent chip does not open while a run is busy', async ({ page }) => {
  const { ws, token } = await boot({
    script: 'slow.json',
    models: { default: { model: 'grok-4.6' }, coder: { model: 'grok-4' } },
  });
  await openApp(page, token);
  await createWorkspace(page, 'busy', ws);
  await createConversation(page);
  await send(page, 'run');
  await expect(statusText(page)).toContainText(/running|运行/i);

  await page.getByTestId('composer-agent').click();
  await expect(page.locator('.toast-msg')).toHaveText(/运行中无法切换角色|Cannot switch role while running/);
  await expect(menu(page)).toBeHidden();
  await expect(chip(page)).toHaveText('Agent · grok-4.6');

  const cid = await conversationId(page);
  const conv = await api(srv.url, 'GET', `/conversations/${cid}`, null, token);
  expect(conv.body.roleId).toBeNull();
});
