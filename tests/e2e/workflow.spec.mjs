// Optional local extra. Acceptance is tests/e2e/workflow.md, run by a person.
// This file is not part of CI and does not install a browser.
import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startServer, tmpdir } from './helpers/server.mjs';
import { createWorkspace, send, statusText } from './helpers/ui.mjs';

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
  await page.goto(`${srv.url}/login?token=${encodeURIComponent(TOKEN)}`);
  await expect(page.locator('[data-action=open-settings]')).toBeVisible();
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

test('settings can create, edit, and delete roles and pipelines', async ({ page }) => {
  page.on('dialog', (dialog) => dialog.accept());

  await openWorkflow(page, 'roles');
  const roleCard = (id) => page.locator(`[data-testid=workflow-role-card][data-id=${id}]`);
  await expect(roleCard('default')).toContainText('默认角色保留');
  await expect(roleCard('default').getByRole('button', { name: '删除' })).toHaveCount(0);
  await expect(roleCard('planner')).toBeVisible();
  await expect(roleCard('coder')).toBeVisible();

  await roleCard('planner').getByRole('button', { name: '删除' }).click();
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
  await expect(page.locator('.toast-msg')).toContainText('复核流程');
  await expect(reviewer).toBeVisible();

  await page.getByTestId('workflow-section-pipelines').click();
  await review.getByRole('button', { name: '删除' }).click();
  await expect(review).toHaveCount(0);
  await expect(page.locator('[data-testid=workflow-pipeline-card][data-id=feature]')).toBeVisible();

  await page.getByTestId('workflow-section-roles').click();
  await reviewer.getByRole('button', { name: '删除' }).click();
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
  await page.getByTestId('conversation-new').click();
  const picker = page.getByTestId('conversation-role-pipeline');
  await expect(picker.locator('option[value="pipeline:feature"]')).toHaveText(/功能交付/);
  await expect(picker.locator('option[value="pipeline:demo"]')).toHaveText(/演示/);
  await picker.selectOption('pipeline:feature');
  await page.getByTestId('conversation-title-input').fill('feature run');
  await page.getByTestId('conversation-create-submit').click();
  await expect(page.getByTestId('conversation-item').filter({ hasText: 'feature run' })).toBeVisible();

  await send(page, 'Add an add helper and cover it.');
  await expect(statusText(page)).toContainText(/done|完成/i, { timeout: 20000 });

  await expect.poll(() => fs.readFile(path.join(ws, 'src/add.js'), 'utf8').catch(() => '')).toContain('export function add');
  await expect.poll(() => fs.readFile(path.join(ws, 'src/add.test.js'), 'utf8').catch(() => '')).toContain('add(1, 2)');
  await expect.poll(() => fs.readFile(path.join(ws, 'AUDIT.md'), 'utf8').catch(() => '')).toContain('No blocking issues');

  const names = page.locator('.conv-active .sub-agent-name');
  await expect(names).toHaveText(['规划', '编码', '测试', '审计']);
  await expect(page.locator('.conv-active .main-agent-name')).toHaveCount(0);
  await expect(page.locator('.conv-active')).not.toContainText('主');

  await expect(page.getByTestId('message').filter({ hasText: 'Planner:' })).toBeVisible();
  await expect(page.getByTestId('message').filter({ hasText: 'Coder:' })).toBeVisible();
  await expect(page.getByTestId('message').filter({ hasText: 'Tester:' })).toBeVisible();
  await expect(page.getByTestId('message').filter({ hasText: 'Auditor:' })).toBeVisible();
});
