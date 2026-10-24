import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, tmpdir } from './helpers/server.mjs';
import { login } from './helpers/ui.mjs';
import { startFakeGitlab } from '../helpers/fake-gitlab.mjs';

const PAT = 'glpat-e2e-secret-9k3q';
const BAD = 'glpat-e2e-secret-bad1';

let gitlab;
let srv;

test.afterEach(async () => {
  await srv?.kill();
  srv = null;
  gitlab?.close();
  gitlab = null;
});

async function assertFits(page) {
  const report = await page.evaluate(() => {
    const vp = { w: window.innerWidth, h: window.innerHeight };
    const outside = [];
    for (const el of document.querySelectorAll('.sm, #ws-dialog, .git-row, .git-head')) {
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      if (r.left < -1 || r.top < -1 || r.right > vp.w + 1 || r.bottom > vp.h + 1) {
        outside.push({
          cls: el.className,
          left: Math.round(r.left),
          top: Math.round(r.top),
          right: Math.round(r.right),
          bottom: Math.round(r.bottom),
        });
      }
    }
    return {
      scroll: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      outside,
    };
  });
  expect(report.scroll).toBeLessThanOrEqual(1);
  expect(report.outside).toEqual([]);
}

async function openGitSettings(page) {
  await page.locator('[data-action=open-settings]').click();
  await page.locator('[data-testid=settings-tab-git]').click();
  await expect(page.getByTestId('git-page')).toBeVisible();
}

async function importProject(page, name) {
  await page.getByTestId('workspace-new').click();
  await page.locator('#ws-modal-tab-git').click();
  await expect(page.getByTestId('git-project').filter({ hasText: 'acme/widget' })).toBeVisible();
  await page.getByTestId('git-search').fill('zzz-none');
  await expect(page.locator('.git-projects')).toContainText('没有匹配的项目');
  await page.getByTestId('git-search').fill('widget');
  await expect(page.getByTestId('git-project').filter({ hasText: 'acme/widget' })).toBeVisible();
  await page.getByTestId('git-project').filter({ hasText: 'acme/widget' }).click();
  await expect(page.getByTestId('git-import-name')).toHaveValue('widget');
  await expect(page.getByTestId('git-branch')).toContainText('main');
  await expect(page.getByTestId('git-branch')).toContainText('默认');
  if (name) await page.getByTestId('git-import-name').fill(name);
  await page.getByTestId('git-branch').click();
  await expect(page.getByTestId('git-branch-pop')).toBeVisible();
}

test('settings Git connection imports a GitLab project', async ({ browser }) => {
  test.setTimeout(180_000);
  gitlab = await startFakeGitlab({
    token: PAT,
    username: 'zhangsan',
    withGit: true,
    projects: [{
      id: 7,
      path: 'acme/widget',
      description: 'Widget service',
      defaultBranch: 'main',
      branches: [{ name: 'main', default: true }, { name: 'develop', default: false }],
    }],
  });
  const dataDir = await tmpdir('piw-git-e2e-');
  const authFile = path.join(dataDir, 'empty-auth.json');
  fs.writeFileSync(authFile, '{}\n');
  srv = await startServer({
    dataDir,
    extraEnv: {
      WEFT_LLM: '',
      WEFT_FAUX_SCRIPT: '',
      LLM_API: '',
      WEFT_GROK_AUTH: authFile,
    },
  });

  const light = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const page = await light.newPage();
  await login(page, srv.url);
  await openGitSettings(page);
  await expect(page.getByTestId('git-empty')).toBeVisible();

  await page.getByTestId('git-add').click();
  await expect(page.getByTestId('git-drawer')).toBeVisible();
  await page.getByTestId('git-name').fill('内网 GitLab');
  await page.getByTestId('git-url').fill(gitlab.origin);
  await page.getByTestId('git-token').fill(PAT);
  await page.getByTestId('git-http').check();
  const link = page.locator('#git-token-link');
  await expect(link).toHaveText('去 GitLab 创建令牌');
  await expect(link).toHaveAttribute('href', `${gitlab.origin}/-/user_settings/personal_access_tokens`);
  const drawerText = await page.getByTestId('git-drawer').innerText();
  expect(drawerText).not.toContain('/-/user_settings/personal_access_tokens');

  await page.getByTestId('git-test').click();
  await expect(page.getByTestId('git-test-result')).toContainText('zhangsan');
  await expect(page.getByTestId('git-test-result')).toContainText('可以读取项目列表');
  await page.getByTestId('git-save').click();
  await expect(page.getByTestId('git-row')).toContainText('内网 GitLab');
  await page.getByTestId('git-row-test').click();
  await expect(page.getByTestId('git-row')).toContainText('已连接');
  await expect(page.getByTestId('git-row')).toContainText('zhangsan');
  await expect(page.getByTestId('git-row')).not.toContainText(PAT);
  await page.locator('.sm-git [data-action=close-settings]').click();

  await importProject(page, 'widget');
  await page.getByTestId('workspace-create-submit').click();
  await expect(page.getByTestId('workspace-item').filter({ hasText: 'widget' })).toBeVisible();
  await page.locator('#tab-btn-file').click();
  await expect(page.getByTestId('workspace-file').filter({ hasText: 'README.md' })).toBeVisible();

  await openGitSettings(page);
  await page.getByTestId('git-edit').click();
  await page.getByTestId('git-token').click();
  await page.getByTestId('git-token').fill(BAD);
  await page.getByTestId('git-save').click();
  await expect(page.getByTestId('git-drawer')).toBeHidden();
  await page.locator('.sm-git [data-action=close-settings]').click();

  await page.getByTestId('workspace-new').click();
  await page.locator('#ws-modal-tab-git').click();
  await expect(page.locator('.git-projects')).toContainText('认证失败');
  await expect(page.locator('#ws-dialog')).not.toContainText(BAD);
  await expect(page.locator('#ws-dialog')).not.toContainText(PAT);
  await page.locator('#ws-dialog button[data-action=close-modal]').click();

  await openGitSettings(page);
  await page.locator('[data-action=set-settings-tab][data-tab=general]').click();
  await page.locator('[data-action=switch-appearance][data-mode=dark]').click();
  await page.locator('[data-action=close-settings]').first().click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', /dark/);
  await light.close();

  const narrow = await browser.newContext({
    viewport: { width: 1000, height: 900 },
  });
  const slim = await narrow.newPage();
  await login(slim, srv.url);
  await openGitSettings(slim);
  await slim.getByTestId('git-edit').click();
  await slim.getByTestId('git-token').click();
  await slim.getByTestId('git-token').fill(PAT);
  await slim.getByTestId('git-save').click();
  await expect(slim.getByTestId('git-drawer')).toBeHidden();
  await slim.getByTestId('git-row-test').click();
  await expect(slim.getByTestId('git-row')).toContainText('已连接');
  await assertFits(slim);
  await slim.locator('.sm-git [data-action=close-settings]').click();
  await slim.getByTestId('workspace-new').click();
  await slim.locator('#ws-modal-tab-git').click();
  await expect(slim.getByTestId('git-project').filter({ hasText: 'acme/widget' })).toBeVisible();
  await assertFits(slim);
  await narrow.close();
});
