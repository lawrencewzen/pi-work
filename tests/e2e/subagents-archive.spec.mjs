import { test, expect } from '@playwright/test';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startServer, prepareWorkspaces, api } from './helpers/server.mjs';
import { openApp, createWorkspace, newConversation, send } from './helpers/ui.mjs';

const CHILD_TEXT = '子代理回复：已看过。';
const FOREGROUND_TASK = '请确认前台子代理已收到任务。';
const BACKGROUND_NAME = '巡查';

function chatCompletionSse(text) {
  const chunk = (delta, finish) => JSON.stringify({
    id: 'chatcmpl-ui-sub',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  return [
    `data: ${chunk({ role: 'assistant', content: text }, null)}`,
    '',
    `data: ${chunk({}, 'stop')}`,
    '',
    'data: [DONE]',
    '',
    '',
  ].join('\n');
}

function startChildModel(text) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (!url.pathname.endsWith('/chat/completions')) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.end(chatCompletionSse(text));
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

async function assertNarrowWorkbench(page) {
  const measured = await page.evaluate(() => {
    const box = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return { width: 0, height: 0 };
      const rect = el.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    };
    const chip = document.querySelector('[data-testid=composer-context]');
    const remain = chip?.querySelector('.ctx-remain');
    return {
      center: box('.col-center').width,
      right: box('[data-testid=right-panel]').width,
      send: box('[data-testid=chat-send]').height,
      agent: box('[data-testid=composer-agent]').height,
      context: box('[data-testid=composer-context]').height,
      chipWrap: chip ? getComputedStyle(chip).whiteSpace : '',
      remainHidden: remain ? getComputedStyle(remain).display === 'none' : true,
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    };
  });
  console.log(`NARROW_1000 ${JSON.stringify(measured)}`);
  expect(measured.center).toBeGreaterThanOrEqual(420);
  // Below 1180px the right panel floats over the chat instead of squeezing it.
  const floating = await page.evaluate(() => getComputedStyle(document.querySelector('[data-testid=right-panel]')).position === 'absolute');
  if (!floating) expect(measured.right).toBeLessThanOrEqual(340);
  for (const key of ['send', 'agent', 'context']) {
    expect(measured[key], key).toBeLessThanOrEqual(32);
  }
  expect(measured.chipWrap).toBe('nowrap');
  expect(measured.remainHidden).toBe(true);
  expect(measured.overflowX).toBe(false);
}

async function switchLanguage(page, lang) {
  await page.locator('[data-action=open-settings]').click();
  await page.locator(`[data-action=switch-language][data-lang=${lang}]`).click();
  await page.locator('[data-action=close-settings]').click();
  await expect(page.locator('.sm')).toBeHidden();
}

async function switchAppearance(page, mode) {
  await page.locator('[data-action=open-settings]').click();
  await page.locator(`[data-action=switch-appearance][data-mode=${mode}]`).click();
  await page.locator('[data-action=close-settings]').click();
  await expect(page.locator('.sm')).toBeHidden();
}

test.use({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 8 / 3,
});
test.describe.configure({ timeout: 120_000 });

test('sidebar lists foreground and background sub-agents and opens the transcript', async ({ page }) => {
  const prepared = await prepareWorkspaces(['repo']);
  const scriptPath = path.join(prepared.root, 'subagents.json');
  await fs.writeFile(scriptPath, JSON.stringify({
    turns: [
      { tool: 'delegate', args: { agent: 'scout', task: FOREGROUND_TASK } },
      { tool: 'subagent', args: { action: 'spawn', name: BACKGROUND_NAME, agent: 'scout', message: '请在后台继续查看。' } },
      { text: '主对话已汇总。' },
    ],
  }));
  const child = await startChildModel(CHILD_TEXT);
  let srv;
  try {
    srv = await startServer({
      extraEnv: {
        PI_WORK_KERNEL: 'durable',
        PI_WORK_FAUX_SCRIPT: scriptPath,
        PI_WORK_WORKSPACE_ROOT: prepared.root,
      },
    });
    const token = '';
    const role = await api(srv.url, 'POST', '/roles', {
      id: 'scout',
      name: '侦察',
      description: '查看仓库',
      systemPrompt: '只回答已经看到的内容。',
      tools: ['read'],
      pluginTools: false,
    }, token);
    expect(role.status).toBe(201);
    const source = await api(srv.url, 'POST', '/sources', {
      vendor: 'custom',
      name: 'Scout',
      baseUrl: child.baseUrl,
      apiKey: 'sk-scout-test',
      models: ['model-scout'],
    }, token);
    expect(source.status).toBe(201);
    const settings = await api(srv.url, 'PUT', '/settings', {
      models: { scout: { sourceId: source.body.id, model: 'model-scout' } },
    }, token);
    expect(settings.status).toBe(200);

    await openApp(page, srv, token);
    await createWorkspace(page, 'demo', prepared.dirs[0]);
    await newConversation(page);
    await send(page, '请派子代理');

    const foreground = page.locator('[data-testid=subagent-row][data-mode=foreground]');
    const background = page.locator('[data-testid=subagent-row][data-mode=background]');
    await expect(foreground).toBeVisible({ timeout: 45000 });
    await expect(foreground).toContainText('侦察');
    await expect(foreground.getByTestId('subagent-background')).toHaveCount(0);
    await expect(background).toBeVisible({ timeout: 45000 });
    await expect(background).toContainText(BACKGROUND_NAME);
    await expect(background.getByTestId('subagent-background')).toHaveText('后台');
    await expect(foreground.locator('.status-dot')).toBeVisible();
    await expect(page.getByTestId('message').filter({ hasText: '主对话已汇总。' })).toBeVisible({ timeout: 20000 });
    await expect(page.locator('#center-thread [data-testid=message][data-role=assistant] [data-testid=message-sender]')).toHaveCount(0);
    await expect(page.locator('#center-thread')).not.toContainText('主 Agent');
    await expect(page.locator('body')).not.toContainText('sk-scout-test');

    // A sub-agent opens in a closable tab of the right panel; the main chat stays usable.
    await foreground.click();
    await expect(page.getByTestId('subagent-banner-text')).toHaveText('侦察');
    await expect(page.locator('.agent-pane-tag')).toHaveText('子 Agent');
    await expect(page.getByTestId('subagent-back')).toHaveAttribute('aria-label', '返回主对话');
    const transcript = page.getByTestId('subagent-pane');
    await expect(transcript.locator('[data-testid=message][data-role=user]')).toContainText(FOREGROUND_TASK);
    await expect(transcript.locator('[data-testid=message][data-role=assistant]')).toContainText(CHILD_TEXT);
    await expect(transcript.locator('[data-testid=message-sender]')).toHaveText('侦察');
    await expect(page.getByTestId('chat-input')).toBeEnabled();

    await switchLanguage(page, 'en');
    await expect(page.locator('.agent-pane-tag')).toHaveText('Sub-agent');
    await expect(page.getByTestId('subagent-back')).toHaveAttribute('aria-label', 'Back to main chat');
    await expect(page.locator('#center-thread')).not.toContainText('Main agent');
    await expect(transcript.locator('[data-testid=message-sender]')).toHaveText('侦察');
    await expect(background.getByTestId('subagent-background')).toHaveText('Background');
    await switchLanguage(page, 'zh');
    await expect(page.getByTestId('subagent-back')).toHaveAttribute('aria-label', '返回主对话');

    await page.getByTestId('subagent-back').click();
    await expect(page.getByTestId('subagent-banner')).toHaveCount(0);
    await expect(page.getByTestId('chat-input')).toBeEnabled();
    await expect(page.getByTestId('message').filter({ hasText: '主对话已汇总。' })).toBeVisible();

    await switchAppearance(page, 'dark');
    await expect.poll(() => page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toContain('dark');
    await switchAppearance(page, 'light');

    await page.setViewportSize({ width: 1000, height: 760 });
    await assertNarrowWorkbench(page);
    await expect(page.getByTestId('run-bar')).toHaveCount(0);
    await expect(page.getByTestId('btn-stop')).toHaveCount(0);
    await expect(page.getByTestId('chat-send')).toBeVisible();
    await foreground.click();
    await expect(page.getByTestId('subagent-banner')).toBeVisible();
    await expect(transcript.locator('[data-testid=message-sender]')).toHaveText('侦察');
    await assertNarrowWorkbench(page);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
    await page.getByTestId('subagent-back').click();
  } finally {
    await srv?.kill();
    await child.close();
  }
});
