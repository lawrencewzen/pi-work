// Optional local extra. Acceptance is tests/e2e/workflow.md, run by a person.
// This file is not part of CI and does not install a browser.
import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startServer, tmpdir } from './helpers/server.mjs';
import { createWorkspace, createConversation, send, statusText, login } from './helpers/ui.mjs';

const TOKEN = 'e2e-workflow-token';

let srv;
let ws;

test.beforeEach(async ({ page }) => {
  ws = await tmpdir('piw-wf-');
  srv = await startServer({
    script: 'feature-pipeline.json',
    extraEnv: {
      PI_WORK_TOKEN: TOKEN,
      PI_WORK_WORKSPACE_ROOT: path.dirname(ws),
    },
  });
  await login(page, srv.url, TOKEN);
});

test.afterEach(async () => {
  await srv?.kill();
});

async function openWorkflow(page, section = 'roles') {
  await page.locator('[data-action=open-settings]').click();
  await page.getByTestId('settings-tab-workflow').click();
  const tab = section === 'pipelines' ? 'workflow-section-pipelines' : 'workflow-section-roles';
  await page.getByTestId(tab).click();
}

async function acceptConfirm(page, message) {
  const dialog = page.getByTestId('confirm-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('data-danger', 'true');
  if (message) await expect(dialog.getByTestId('confirm-message')).toHaveText(message);
  await dialog.getByTestId('confirm-ok').click();
  await expect(dialog).toBeHidden();
}

test('settings can create, edit, and delete roles and pipelines', async ({ page }) => {
  page.on('dialog', async (dialog) => {
    const message = dialog.message();
    await dialog.dismiss();
    throw new Error(`native dialog should not open: ${message}`);
  });

  await openWorkflow(page, 'roles');
  const roleCard = (id) => page.locator(`[data-testid=workflow-role-card][data-id=${id}]`);
  await expect(roleCard('default')).toContainText('默认角色保留');
  await expect(roleCard('default').getByRole('button', { name: '删除' })).toHaveCount(0);
  await expect(roleCard('planner')).toBeVisible();
  await expect(roleCard('coder')).toBeVisible();

  await roleCard('planner').getByRole('button', { name: '删除' }).click();
  await acceptConfirm(page, '删除角色「规划」？');
  await expect(page.locator('.toast-msg')).toContainText('功能交付');
  await expect(roleCard('planner')).toBeVisible();

  await page.getByTestId('workflow-section-pipelines').click();
  await expect(page.locator('[data-testid=workflow-pipeline-card][data-id=feature]')).toContainText('功能交付');
  await expect(page.locator('[data-testid=workflow-pipeline-card][data-id=feature]')).toContainText('规划 → 编码 → 测试 → 审计');
  await expect(page.locator('[data-testid=workflow-pipeline-card][data-id=demo]')).toContainText('演示');

  await page.getByTestId('workflow-new').click();
  await page.getByRole('button', { name: '新建角色' }).click();
  await page.getByTestId('workflow-role-id').fill('reviewer');
  await page.getByTestId('workflow-role-name').fill('复核');
  await page.getByTestId('workflow-role-prompt').fill('Review the diff and list concrete issues.');
  await page.getByTestId('workflow-save').click();

  await expect(page.getByTestId('workflow-pipeline-id')).toBeVisible();
  await page.getByTestId('workflow-pipeline-id').fill('review');
  await page.getByTestId('workflow-pipeline-name').fill('Review pass');
  await page.locator('.wf-step').first().locator('.wf-step-role').selectOption('coder');
  await page.locator('.wf-step').first().locator('.wf-step-input').selectOption('user');
  await page.getByTestId('workflow-add-step').click();
  await page.locator('.wf-step').nth(1).locator('.wf-step-role').selectOption('reviewer');
  await page.locator('.wf-step').nth(1).locator('.wf-step-input').selectOption('previous');
  await page.getByTestId('workflow-save').click();

  const review = page.locator('[data-testid=workflow-pipeline-card][data-id=review]');
  await expect(review).toContainText('Review pass');
  await expect(review).toContainText('编码 → 复核');

  await page.getByTestId('workflow-section-roles').click();
  await page.getByTestId('workflow-search').fill('复核');
  await expect(page.locator('[data-testid=workflow-role-card][data-id=reviewer]')).toBeVisible();
  await expect(page.locator('[data-testid=workflow-role-card][data-id=coder]')).toHaveCount(0);
  await page.getByTestId('workflow-search').fill('');
  await expect(page.locator('[data-testid=workflow-role-card][data-id=coder]')).toBeVisible();

  const reviewer = page.locator('[data-testid=workflow-role-card][data-id=reviewer]');
  await reviewer.getByRole('button', { name: '编辑' }).click();
  await expect(page.getByTestId('workflow-role-id')).toBeDisabled();
  await page.getByTestId('workflow-role-prompt').fill('Review the diff carefully.');
  await page.getByTestId('workflow-save').click();
  await expect(reviewer).toContainText('Review the diff carefully.');
  await reviewer.getByRole('button', { name: '编辑' }).click();
  await expect(page.getByTestId('workflow-role-prompt')).toHaveValue('Review the diff carefully.');
  await page.getByRole('button', { name: '返回' }).click();

  await page.getByTestId('workflow-section-pipelines').click();
  await review.getByRole('button', { name: '编辑' }).click();
  await page.getByTestId('workflow-pipeline-name').fill('复核流程');
  await page.getByTestId('workflow-save').click();
  await expect(review).toContainText('复核流程');

  await page.getByTestId('workflow-section-roles').click();
  await reviewer.getByRole('button', { name: '删除' }).click();
  await page.getByTestId('confirm-cancel').click();
  await expect(page.getByTestId('confirm-dialog')).toBeHidden();
  await expect(reviewer).toBeVisible();
  await reviewer.getByRole('button', { name: '删除' }).click();
  await acceptConfirm(page, '删除角色「复核」？');
  await expect(page.locator('.toast-msg')).toContainText('复核流程');
  await expect(reviewer).toBeVisible();

  await page.getByTestId('workflow-section-pipelines').click();
  await review.getByRole('button', { name: '删除' }).click();
  await acceptConfirm(page, '删除流水线「复核流程」？');
  await expect(review).toHaveCount(0);
  await expect(page.locator('[data-testid=workflow-pipeline-card][data-id=feature]')).toBeVisible();

  await page.getByTestId('workflow-section-roles').click();
  await reviewer.getByRole('button', { name: '删除' }).click();
  await acceptConfirm(page, '删除角色「复核」？');
  await expect(reviewer).toHaveCount(0);
  await expect(page.locator('[data-testid=workflow-role-card][data-id=coder]')).toBeVisible();

  await page.locator('[data-action=set-settings-tab][data-tab=general]').click();
  await page.locator('[data-action=switch-language][data-lang=en]').click();
  await page.getByTestId('settings-tab-workflow').click();
  await page.getByTestId('workflow-section-pipelines').click();
  await expect(page.locator('[data-testid=workflow-pipeline-card][data-id=feature]')).toContainText('Feature delivery');
  await expect(page.locator('[data-testid=workflow-pipeline-card][data-id=demo]')).toContainText('Demo');
  await expect(page.locator('[data-testid=workflow-pipeline-card][data-id=feature]')).toContainText('Planner → Coder → Tester → Auditor');
});

test('new conversation can run the feature pipeline', async ({ page }) => {
  await createWorkspace(page, 'feature-ws', ws);
  await createConversation(page);
  await page.getByTestId('composer-agent').click();
  const menu = page.getByTestId('composer-agent-menu');
  await expect(menu).toBeVisible();
  // WF-9: pipelines are listed on the composer Agent chip, not a create-dialog <select>.
  await expect(menu.locator('[data-pipeline-id="feature"]')).toContainText('功能交付 (规划 → 编码 → 测试 → 审计)');
  await expect(menu.locator('[data-pipeline-id="demo"]')).toContainText('演示 (编码 → 测试 → 审计)');
  await menu.locator('[data-pipeline-id="feature"]').click();
  await expect(menu).toBeHidden();

  const prompt = 'Add an add helper and cover it.';
  await send(page, prompt);
  // The create dialog's title field is gone. The first message becomes the conversation title.
  await expect(page.getByTestId('conversation-item').filter({ hasText: prompt })).toBeVisible();
  await expect(statusText(page)).toContainText(/done|完成/i, { timeout: 20000 });

  await expect.poll(() => fs.readFile(path.join(ws, 'src/add.js'), 'utf8').catch(() => '')).toContain('export function add');
  await expect.poll(() => fs.readFile(path.join(ws, 'src/add.test.js'), 'utf8').catch(() => '')).toContain('add(1, 2)');
  await expect.poll(() => fs.readFile(path.join(ws, 'AUDIT.md'), 'utf8').catch(() => '')).toBe('');

  const names = page.locator('.conv-active .sub-agent-name');
  await expect(names).toHaveText(['规划', '编码', '测试', '审计']);
  await expect(page.locator('.conv-active .main-agent-name')).toHaveCount(0);
  await expect(page.locator('.conv-active')).not.toContainText('主');

  await expect(page.getByTestId('message').filter({ hasText: 'Planner:' })).toBeVisible();
  await expect(page.getByTestId('message').filter({ hasText: 'Coder:' })).toBeVisible();
  await expect(page.getByTestId('message').filter({ hasText: 'Tester:' })).toBeVisible();
  await expect(page.getByTestId('message').filter({ hasText: 'Auditor:' })).toBeVisible();
});
