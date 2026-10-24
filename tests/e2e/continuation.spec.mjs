import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startServer, prepareWorkspaces } from './helpers/server.mjs';
import { createWorkspace, newConversation, send, statusText, openApp } from './helpers/ui.mjs';

test.use({
  viewport: { width: 1440, height: 900 },
});
test.describe.configure({ timeout: 90_000 });

test('auto-continue is a gray note, not a user bubble, including after refresh', async ({ page }) => {
  const prepared = await prepareWorkspaces(['cont']);
  const ws = prepared.dirs[0];
  const scriptPath = path.join(prepared.root, 'continue.json');
  await fs.writeFile(scriptPath, JSON.stringify({
    turns: [
      { text: 'part-one of a long answer', stopReason: 'length' },
      { text: 'part-two finishes the thought.' },
    ],
  }));
  const srv = await startServer({
    extraEnv: {
      WEFT_FAUX_SCRIPT: scriptPath,
      WEFT_WORKSPACE_ROOT: prepared.root,
    },
  });
  try {
    await openApp(page, srv);
    await createWorkspace(page, 'cont', ws);
    await newConversation(page);
    await send(page, '写一段长回答');
    await expect(statusText(page)).toContainText(/done|完成/i, { timeout: 20000 });
    const users = page.locator('[data-testid=message][data-role=user]');
    await expect(users).toHaveCount(1);
    await expect(users).toContainText('写一段长回答');
    await expect(page.getByTestId('auto-continue-note')).toHaveCount(1);
    await expect(page.getByTestId('auto-continue-note')).toContainText('输出达到长度上限，已自动续写');
    const assistants = page.locator('[data-testid=message][data-role=assistant]');
    await expect(assistants).toHaveCount(2);
    await expect(assistants.nth(0).getByTestId('message-body')).toContainText('part-one');
    await expect(assistants.nth(1).getByTestId('message-body')).toContainText('part-two');
    await expect(page.getByTestId('output-truncated')).toHaveCount(0);

    await page.reload();
    await expect(users).toHaveCount(1, { timeout: 20000 });
    await expect(page.getByTestId('auto-continue-note')).toHaveCount(1);
    await expect(assistants).toHaveCount(2);
    await expect(assistants.nth(0).getByTestId('message-body')).toContainText('part-one');
    await expect(assistants.nth(1).getByTestId('message-body')).toContainText('part-two');
    await expect(page.getByTestId('output-truncated')).toHaveCount(0);
  } finally {
    await srv.kill();
  }
});

test('hitting the auto-continue cap shows a continue button', async ({ page }) => {
  const prepared = await prepareWorkspaces(['cap']);
  const ws = prepared.dirs[0];
  const scriptPath = path.join(prepared.root, 'cap.json');
  await fs.writeFile(scriptPath, JSON.stringify({
    turns: Array.from({ length: 9 }, (_, i) => ({
      text: `chunk-${i + 1}`,
      stopReason: 'length',
    })),
  }));
  const srv = await startServer({
    extraEnv: {
      WEFT_FAUX_SCRIPT: scriptPath,
      WEFT_WORKSPACE_ROOT: prepared.root,
    },
  });
  try {
    await openApp(page, srv);
    await createWorkspace(page, 'cap', ws);
    await newConversation(page);
    await send(page, 'keep going');
    await expect(statusText(page)).toContainText(/done|完成/i, { timeout: 20000 });
    await expect(page.getByTestId('auto-continue-note')).toHaveCount(8);
    await expect(page.locator('[data-testid=message][data-role=assistant]')).toHaveCount(9);
    const truncated = page.getByTestId('output-truncated');
    await expect(truncated).toHaveCount(1);
    await expect(truncated).toContainText('输出达到长度上限被截断');
    await expect(page.getByTestId('continue-truncated')).toBeVisible();
    await page.getByTestId('continue-truncated').click();
    await expect(page.locator('[data-testid=message][data-role=user]').filter({ hasText: '继续' })).toHaveCount(1);
  } finally {
    await srv.kill();
  }
});
