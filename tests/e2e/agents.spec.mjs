import { test, expect } from '@playwright/test';
import { startServer, api } from './helpers/server.mjs';
import { login } from './helpers/ui.mjs';

let srv;
let token;

test.beforeEach(async () => {
  srv = await startServer({ script: 'basic.json' });
  token = '';
});

test.afterEach(async () => {
  await srv?.kill();
  srv = null;
});

function rolePosts(page) {
  const bodies = [];
  page.on('request', (req) => {
    if (req.method() !== 'POST') return;
    let path = '';
    try { path = new URL(req.url()).pathname; } catch { return; }
    if (path !== '/api/roles') return;
    bodies.push(req.postDataJSON());
  });
  return bodies;
}

async function openSettings(page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, srv.url, token);
  await page.locator('[data-action=open-settings]').click();
  await expect(page.locator('.sm')).toBeVisible();
}

async function openAgents(page) {
  const ready = page.waitForResponse((res) => {
    try { return new URL(res.url()).pathname === '/api/roles' && res.request().method() === 'GET' && res.ok(); }
    catch { return false; }
  });
  await page.getByTestId('settings-tab-agents').click();
  await ready;
  await expect(page.getByTestId('agents-page')).toBeVisible();
  await expect(page.locator('[data-testid=agent-item][data-role-id=coder]')).toBeVisible();
}

async function selectAgent(page, id) {
  const item = page.locator(`[data-testid=agent-item][data-role-id="${id}"]`);
  await item.click();
  await expect(item).toHaveClass(/on/);
}

async function roles() {
  const res = await api(srv.url, 'GET', '/roles', null, token);
  expect(res.status).toBe(200);
  return res.body;
}

async function roleByName(name) {
  return (await roles()).find((role) => role.name === name);
}

test('creates a Chinese-named sub-agent without an id, then edits and copies it', async ({ page }) => {
  const posts = rolePosts(page);
  await openSettings(page);
  await openAgents(page);
  await page.getByTestId('agent-new').click();
  await expect(page.getByTestId('agent-starter-blank')).toHaveClass(/on/);
  await expect(page.getByTestId('agent-description')).toBeVisible();
  await expect(page.getByTestId('agent-tool-read')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('agent-tool-write')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('agent-tool-bash')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('agent-plugin-tools')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#ag-edit input, #ag-edit textarea')).not.toHaveCount(0);
  await expect(page.locator('#ag-name')).toBeVisible();
  await expect(page.getByTestId('agent-delete')).toHaveCount(0);

  await page.getByTestId('agent-name').fill('文档助手');
  await page.getByTestId('agent-description').fill('整理仓库里的说明文档');
  await page.getByTestId('agent-prompt').fill('只整理文档，不改代码。');
  await page.getByTestId('agent-save').click();
  await expect(page.locator('.toast-msg')).toContainText('已保存');

  expect(posts).toHaveLength(1);
  expect(posts[0].id).toBeUndefined();
  expect(posts[0].name).toBe('文档助手');
  expect(posts[0].tools).toEqual(['read', 'ls', 'grep']);
  expect(posts[0].pluginTools).toBe(false);
  expect(posts[0].skills).toEqual([]);

  const created = await roleByName('文档助手');
  expect(created?.id).toMatch(/^agent-[a-f0-9]+$/);
  expect(created.description).toBe('整理仓库里的说明文档');
  await expect(page.getByTestId('agents-page')).not.toContainText(created.id);
  await expect(page.locator(`[data-testid=agent-item][data-role-id="${created.id}"]`)).toContainText('文档助手');

  await page.getByTestId('agent-prompt').fill('只整理文档，不改代码。回复先写结论。');
  await page.getByTestId('agent-save').click();
  await expect(page.locator('.toast-msg')).toContainText('已保存');

  await page.reload();
  await expect(page.getByTestId('composer-agent')).toBeVisible();
  await page.locator('[data-action=open-settings]').click();
  await openAgents(page);
  await selectAgent(page, created.id);
  await expect(page.getByTestId('agent-prompt')).toHaveValue('只整理文档，不改代码。回复先写结论。');
  await expect(page.getByTestId('agent-name')).toHaveValue('文档助手');

  await page.getByTestId('agent-copy').click();
  await expect(page.getByTestId('agent-name')).toHaveValue('文档助手');
  await expect(page.getByTestId('agent-prompt')).toHaveValue('只整理文档，不改代码。回复先写结论。');
  await page.getByTestId('agent-name').fill('文档副本');
  await page.getByTestId('agent-save').click();
  await expect(page.locator('.toast-msg')).toContainText('已保存');
  expect(posts.at(-1).id).toBeUndefined();
  expect(posts.at(-1).name).toBe('文档副本');
  const copy = await roleByName('文档副本');
  expect(copy?.id).toMatch(/^agent-[a-f0-9]+$/);
  expect(copy.id).not.toBe(created.id);
  expect(copy.systemPrompt).toBe('只整理文档，不改代码。回复先写结论。');
  await expect(page.locator(`[data-testid=agent-item][data-role-id="${copy.id}"]`)).toBeVisible();
  await expect(page.locator(`[data-testid=agent-item][data-role-id="${created.id}"]`)).toBeVisible();
});

test('restores a preset, keeps its model, and hides delete on built-ins', async ({ page }) => {
  const source = await api(srv.url, 'POST', '/sources', {
    vendor: 'deepseek',
    name: 'DeepSeek',
    apiKey: 'sk-test-deepseek-0000',
    models: ['deepseek-chat'],
  }, token);
  expect(source.status).toBe(201);
  await openSettings(page);
  await openAgents(page);

  await selectAgent(page, 'default');
  await expect(page.locator('[data-testid=agent-item][data-role-id=default] b')).toHaveText('主 Agent');
  await expect(page.getByTestId('agent-heading')).toHaveText('主 Agent');
  await expect(page.getByTestId('agent-description')).toHaveCount(0);
  await expect(page.getByTestId('agent-delete')).toHaveCount(0);
  await expect(page.getByTestId('agent-preset-tag')).toHaveCount(0);
  await expect(page.getByTestId('agent-reset')).toBeVisible();
  await expect(page.getByTestId('agent-name')).toHaveValue('默认');

  await selectAgent(page, 'coder');
  const intro = page.locator('.ag-head p');
  await expect(intro).toHaveText('主 Agent 理解需求、拆任务、汇总结果；子 Agent 是它派活用的角色模板，按这里的模型、工具和提示词生成。');
  const introLines = await intro.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    return range.getClientRects().length;
  });
  expect(introLines).toBe(1);
  await page.setViewportSize({ width: 1000, height: 760 });
  const note = page.locator('.ag-enote');
  await expect(note).toHaveAttribute('title', '预设的不能删除；改坏了可以恢复默认');
  const noteLines = await note.evaluate((el) => el.scrollHeight <= el.clientHeight + 1);
  expect(noteLines).toBe(true);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByTestId('agent-preset-tag')).toHaveText('预设子 Agent');
  await expect(page.getByTestId('agent-delete')).toHaveCount(0);
  await expect(page.getByTestId('agent-reset')).toBeVisible();
  await expect(page.getByTestId('agent-description')).toBeVisible();
  const original = await page.getByTestId('agent-prompt').inputValue();
  expect(original).toContain('## 交接');
  expect(original).toContain('角色：编码');

  await page.getByTestId('agent-model-pick').click();
  const pop = page.getByTestId('model-pop');
  await expect(pop).toBeVisible();
  await expect(pop.getByRole('button', { name: /跟随默认/ })).toBeVisible();
  await expect(pop.getByRole('button', { name: '去「模型」页添加…' })).toBeVisible();
  await pop.locator('[data-action=ms-choose-model][data-model="deepseek-chat"]').click();
  await expect(page.getByTestId('agent-model-pick')).toContainText('deepseek-chat');
  await page.getByTestId('agent-prompt').fill(`${original}\n临时改动 WF`);
  await expect(page.locator('#ag-prompt-meta')).toContainText('已改动，和预设版本不同');
  await page.getByTestId('agent-save').click();
  await expect(page.locator('.toast-msg')).toContainText('已保存');

  const saved = await api(srv.url, 'GET', '/settings', null, token);
  expect(saved.body.models.coder).toEqual({ sourceId: source.body.id, model: 'deepseek-chat' });
  const edited = (await roles()).find((role) => role.id === 'coder');
  expect(edited.systemPrompt).toContain('临时改动 WF');
  expect(edited.skills).toBeUndefined();
  expect(edited.name).toBe('Coder');

  await page.getByTestId('agent-reset').click();
  const dialog = page.getByTestId('confirm-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('confirm-message')).toContainText('编码');
  await expect(dialog.getByTestId('confirm-message')).toContainText('模型选择保持不变');
  await dialog.getByTestId('confirm-ok').click();
  await expect(page.locator('.toast-msg')).toContainText('已恢复默认');
  await expect(page.getByTestId('agent-prompt')).toHaveValue(original);
  await expect(page.locator('#ag-prompt-meta')).not.toContainText('已改动');
  await expect(page.getByTestId('agent-model-pick')).toContainText('deepseek-chat');
  const after = await api(srv.url, 'GET', '/settings', null, token);
  expect(after.body.models.coder).toEqual({ sourceId: source.body.id, model: 'deepseek-chat' });
  const restored = (await roles()).find((role) => role.id === 'coder');
  expect(restored.systemPrompt).toBe(original);
  expect(restored.systemPrompt).not.toContain('临时改动 WF');
});

test('refuses to delete a custom agent that a conversation uses', async ({ page }) => {
  page.on('dialog', async (dialog) => {
    throw new Error(`native dialog should not open: ${dialog.message()}`);
  });
  const created = await api(srv.url, 'POST', '/roles', {
    name: '复核',
    systemPrompt: '只做复核，不改代码。',
    description: '看diff',
    tools: ['read', 'ls', 'grep'],
    pluginTools: false,
    skills: [],
  }, token);
  expect(created.status).toBe(201);
  expect(created.body.id).toMatch(/^agent-/);
  const ws = await api(srv.url, 'POST', '/workspaces', { name: '复核区' }, token);
  expect(ws.status).toBe(201);
  const conv = await api(srv.url, 'POST', `/workspaces/${ws.body.id}/conversations`, {
    title: '用复核',
    roleId: created.body.id,
  }, token);
  expect(conv.status).toBe(201);

  await openSettings(page);
  await openAgents(page);
  await selectAgent(page, created.body.id);
  await expect(page.getByTestId('agent-preset-tag')).toHaveCount(0);
  await expect(page.getByTestId('agent-delete')).toBeVisible();
  await page.getByTestId('agent-delete').click();
  const dialog = page.getByTestId('confirm-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('data-danger', 'true');
  await expect(dialog.getByTestId('confirm-message')).toHaveText('删除这个 Agent「复核」？');
  await dialog.getByTestId('confirm-ok').click();
  await expect(page.locator('.toast-msg')).toContainText('已有对话在使用这个 Agent');
  await expect(page.locator(`[data-testid=agent-item][data-role-id="${created.body.id}"]`)).toBeVisible();

  const cleared = await api(srv.url, 'PATCH', `/conversations/${conv.body.id}`, { roleId: '' }, token);
  expect(cleared.status).toBe(200);
  await page.getByTestId('agent-delete').click();
  await page.getByTestId('confirm-ok').click();
  await expect(page.locator('.toast-msg')).toContainText('已删除');
  await expect(page.locator(`[data-testid=agent-item][data-role-id="${created.body.id}"]`)).toHaveCount(0);

  await page.reload();
  await expect(page.getByTestId('composer-agent')).toBeVisible();
  await page.locator('[data-action=open-settings]').click();
  await openAgents(page);
  await expect(page.locator(`[data-testid=agent-item][data-role-id="${created.body.id}"]`)).toHaveCount(0);
  await expect(page.locator('[data-testid=agent-item][data-role-id=coder]')).toBeVisible();
});

test('saves a searched skill subset and can turn plugin tools off', async ({ page }) => {
  const skill = await api(srv.url, 'POST', '/skills', {
    name: '检索笔记',
    description: '用于搜索勾选的说明',
    body: '整理检索笔记。',
  }, token);
  expect(skill.status).toBe(201);
  const plannerBefore = (await roles()).find((role) => role.id === 'planner');
  expect(plannerBefore.skills).toBeUndefined();
  expect(plannerBefore.pluginTools).not.toBe(false);

  await openSettings(page);
  await openAgents(page);
  await selectAgent(page, 'coder');
  await expect(page.locator('.ag-follow')).toHaveText('跟随全局');
  await page.getByTestId('agent-skills-open').click();
  const pop = page.getByTestId('agent-skills-pop');
  await expect(pop).toBeVisible();
  await expect(pop.locator('[data-testid=agent-skill-check]')).toHaveCount(await enabledSkillCount());
  await page.getByTestId('agent-skills-search').fill('检索笔记');
  await expect(pop.locator('[data-testid=agent-skill-check]')).toHaveCount(1);
  await expect(pop.locator(`[data-testid=agent-skill-check][data-skill-id="${skill.body.id}"]`)).toBeChecked();
  await pop.getByRole('button', { name: '清空' }).click();
  await expect(pop.locator(`[data-testid=agent-skill-check][data-skill-id="${skill.body.id}"]`)).not.toBeChecked();
  await pop.locator(`[data-testid=agent-skill-check][data-skill-id="${skill.body.id}"]`).check();
  await pop.getByRole('button', { name: '完成' }).click();
  await expect(pop).toBeHidden();
  await expect(page.locator('.ag-follow')).toHaveCount(0);
  await expect(page.locator('.ag-sksum')).toContainText('检索笔记');
  await page.getByTestId('agent-save').click();
  await expect(page.locator('.toast-msg')).toContainText('已保存');

  const coder = (await roles()).find((role) => role.id === 'coder');
  expect(coder.skills).toEqual([skill.body.id]);
  expect(coder.description).toBe('按计划或用户请求修改仓库里的代码。');
  expect(coder.pluginTools).not.toBe(false);

  await selectAgent(page, 'planner');
  await page.getByTestId('agent-plugin-tools').click();
  await expect(page.getByTestId('agent-plugin-tools')).toHaveAttribute('aria-pressed', 'false');
  await page.getByTestId('agent-save').click();
  await expect(page.locator('.toast-msg')).toContainText('已保存');
  const planner = (await roles()).find((role) => role.id === 'planner');
  expect(planner.pluginTools).toBe(false);
  expect(planner.skills).toBeUndefined();
  expect(planner.description).toBe(plannerBefore.description);
  expect(planner.systemPrompt).toBe(plannerBefore.systemPrompt);
});

test('model page keeps only the default row', async ({ page }) => {
  await openSettings(page);
  await page.locator('[data-tab=models]').click();
  await expect(page.getByTestId('models-page')).toBeVisible();
  await expect(page.locator('[data-testid=model-role]')).toHaveCount(1);
  await expect(page.locator('[data-testid=model-role]')).toHaveAttribute('data-role-id', 'default');
  await expect(page.getByText('默认模型', { exact: true })).toBeVisible();
  await expect(page.getByTestId('model-agents-link')).toHaveText('Agent 页');
  await page.getByTestId('model-agents-link').click();
  await expect(page.getByTestId('agents-page')).toBeVisible();
  await expect(page.locator('.sm-nav div.on')).toHaveAttribute('data-tab', 'agents');
  await expect(page.getByTestId('settings-tab-workflow')).toHaveCount(0);
});

test('skills pop stays inside the settings modal at 1440x900', async ({ page }) => {
  await openSettings(page);
  await openAgents(page);
  await selectAgent(page, 'coder');
  await page.locator('#ag-skills-open').evaluate((btn) => {
    const edit = document.getElementById('ag-edit');
    const modal = document.querySelector('.sm').getBoundingClientRect();
    const rect = btn.getBoundingClientRect();
    edit.scrollTop += rect.bottom - (modal.bottom - 36);
  });
  const button = await page.getByTestId('agent-skills-open').boundingBox();
  const modal = await page.locator('.sm').boundingBox();
  expect(button.y + button.height).toBeGreaterThan(modal.y + modal.height - 80);
  await page.getByTestId('agent-skills-open').click();
  const pop = page.getByTestId('agent-skills-pop');
  await expect(pop).toBeVisible();
  const popBox = await pop.boundingBox();
  expect(popBox).toBeTruthy();
  expect(popBox.x).toBeGreaterThanOrEqual(modal.x - 1);
  expect(popBox.y).toBeGreaterThanOrEqual(modal.y - 1);
  expect(popBox.x + popBox.width).toBeLessThanOrEqual(modal.x + modal.width + 1);
  expect(popBox.y + popBox.height).toBeLessThanOrEqual(modal.y + modal.height + 1);
  const roomBelow = modal.y + modal.height - (button.y + button.height);
  if (roomBelow < popBox.height) {
    expect(popBox.y + popBox.height).toBeLessThanOrEqual(button.y + 2);
  }
});

async function enabledSkillCount() {
  const listed = await api(srv.url, 'GET', '/skills', null, token);
  return listed.body.filter((skill) => skill.enabled === true).length;
}
