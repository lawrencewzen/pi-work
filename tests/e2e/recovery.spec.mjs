import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startServer, prepareWorkspaces, api } from './helpers/server.mjs';
import { createWorkspace, newConversation, send, statusText, openApp } from './helpers/ui.mjs';

test('kill -9 server mid-task, restart -> resumes to done without duplicate writes', async ({ page }) => {
  const { root, dirs: [ws] } = await prepareWorkspaces(['crash']);
  const holdReady = path.join(root, 'hold-ready');
  let srv = await startServer({
    script: 'crash.json',
    extraEnv: {
      WEFT_WORKSPACE_ROOT: root,
      WEFT_FAUX_HOLD_READY: holdReady,
    },
  });
  const { dataDir, port } = srv;
  const token = await openApp(page, srv);
  await createWorkspace(page, 'crash', ws);
  await newConversation(page);
  await send(page, 'go');
  // crash.json's first assistant turn fires write(log.txt) and bash(side_effect) together.
  // Those tools run in parallel; bash can finish first. write is replay:unsafe, so SIGKILL
  // before log.txt is on disk is not replayed after resume — ENOENT looks like a recovery
  // miss. Wait until both files exist and the next scripted delay (the cut turn) has started.
  await expect.poll(() => fs.readFile(path.join(ws, 'log.txt'), 'utf8').catch(() => ''), { timeout: 15000 }).toBe('1\n');
  await expect.poll(() => fs.readFile(path.join(ws, 'side_effect.txt'), 'utf8').catch(() => ''), { timeout: 15000 }).toBe('once\n');
  await expect.poll(() => fs.readFile(holdReady, 'utf8').catch(() => ''), { timeout: 15000 }).toBe('seen');
  await srv.kill('SIGKILL');

  srv = await startServer({ script: 'crash.json', dataDir, port, extraEnv: { WEFT_WORKSPACE_ROOT: root } });
  try {
    await openApp(page, srv, token);
    await page.getByTestId('workspace-item').filter({ hasText: 'crash' }).click();
    await page.getByTestId('conversation-item').first().click();
    await expect(statusText(page)).toContainText(/running|运行|done|完成/i, { timeout: 10000 });
    await expect(statusText(page)).toContainText(/done|完成/i, { timeout: 30000 });
    expect(await fs.readFile(path.join(ws, 'final.txt'), 'utf8')).toBe('ok\n');
    expect(await fs.readFile(path.join(ws, 'side_effect.txt'), 'utf8')).toBe('once\n'); // bash not replayed
    expect(await fs.readFile(path.join(ws, 'log.txt'), 'utf8')).toBe('1\n');
    // no duplicate tool rows for completed calls
    await expect(page.locator('[data-testid=tool-row][data-tool=bash]')).toHaveCount(1);
    await expect(page.locator('[data-testid=tool-row][data-tool=write]')).toHaveCount(2);
    const ws0 = (await api(srv.url, 'GET', '/workspaces', null, token)).body.find((w) => w.name === 'crash');
    const convs = (await api(srv.url, 'GET', `/workspaces/${ws0.id}/conversations`, null, token)).body;
    expect(convs[0].status).toBe('done');
  } finally { await srv.kill(); }
});
