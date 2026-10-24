import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startServer, prepareWorkspaces } from './helpers/server.mjs';
import { openApp, createWorkspace, newConversation, send } from './helpers/ui.mjs';

const CHILD_TEXT = '子代理回复：已看过。';
const FOREGROUND_TASK = '请确认前台子代理已收到任务。';
const BACKGROUND_NAME = '巡查';
const BACKGROUND_MESSAGE = '请在后台继续查看。';

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
      { tool: 'delegate', args: { task: FOREGROUND_TASK } },
      { tool: 'subagent', args: { action: 'spawn', name: BACKGROUND_NAME, message: BACKGROUND_MESSAGE } },
      { text: '主对话已汇总。' },
      { when: FOREGROUND_TASK, text: CHILD_TEXT },
      { when: BACKGROUND_MESSAGE, text: CHILD_TEXT },
    ],
  }));
  let srv;
  try {
    srv = await startServer({
      extraEnv: {
        WEFT_KERNEL: 'durable',
        WEFT_FAUX_SCRIPT: scriptPath,
        WEFT_WORKSPACE_ROOT: prepared.root,
      },
    });

    await openApp(page, srv);
    await createWorkspace(page, 'demo', prepared.dirs[0]);
    await newConversation(page);
    await send(page, '请派子代理');

    const foreground = page.locator('[data-testid=subagent-row][data-mode=foreground]');
    const background = page.locator('[data-testid=subagent-row][data-mode=background]');
    await expect(foreground).toBeVisible({ timeout: 45000 });
    await expect(foreground).toContainText(FOREGROUND_TASK);
    await expect(foreground.getByTestId('subagent-background')).toHaveCount(0);
    await expect(background).toBeVisible({ timeout: 45000 });
    await expect(background).toContainText(BACKGROUND_NAME);
    await expect(background.getByTestId('subagent-background')).toHaveText('后台');
    await expect(foreground.locator('.status-dot')).toBeVisible();
    await expect(page.getByTestId('message').filter({ hasText: '主对话已汇总。' })).toBeVisible({ timeout: 20000 });
    await expect(page.locator('#center-thread [data-testid=message][data-role=assistant] [data-testid=message-sender]')).toHaveCount(0);
    await expect(page.locator('#center-thread')).not.toContainText('主 Agent');
    // A sub-agent opens in the right-panel detail; the main chat stays usable.
    await foreground.click();
    await expect(page.getByTestId('subagent-banner-text')).toHaveText(FOREGROUND_TASK);
    await expect(page.locator('.agent-pane-tag')).toHaveText('子 Agent');
    const transcript = page.getByTestId('subagent-pane');
    await expect(page.getByTestId('subagent-brief')).toContainText(FOREGROUND_TASK);
    await expect(transcript.locator('[data-testid=subagent-thread] [data-testid=message][data-role=user]')).toHaveCount(0);
    await expect(transcript.locator('[data-testid=message][data-role=assistant]')).toContainText(CHILD_TEXT);
    await expect(transcript.locator('[data-testid=message-sender]')).toHaveText(FOREGROUND_TASK);
    await expect(page.getByTestId('chat-input')).toBeEnabled();

    await switchLanguage(page, 'en');
    await expect(page.locator('.agent-pane-tag')).toHaveText('Sub-agent');
    await expect(page.locator('#center-thread')).not.toContainText('Main agent');
    await expect(transcript.locator('[data-testid=message-sender]')).toHaveText(FOREGROUND_TASK);
    await expect(background.getByTestId('subagent-background')).toHaveText('Background');
    await switchLanguage(page, 'zh');
    await expect(page.locator('.agent-pane-tag')).toHaveText('子 Agent');

    await page.locator('.conv-tree-node.conv-active .conv-node-title').click();
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
    await expect(transcript.locator('[data-testid=message-sender]')).toHaveText(FOREGROUND_TASK);
    await assertNarrowWorkbench(page);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
    await page.locator('.conv-tree-node.conv-active .conv-node-title').click();
    await expect(page.getByTestId('subagent-banner')).toHaveCount(0);
  } finally {
    await srv?.kill();
  }
});
