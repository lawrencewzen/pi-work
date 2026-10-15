import { test, expect } from '@playwright/test';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startServer, prepareWorkspaces, api } from './helpers/server.mjs';
import { openApp, createWorkspace, newConversation, send } from './helpers/ui.mjs';

const SHOTS = '/opt/cursor/artifacts/screenshots';
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

async function shot(page, name) {
  await fs.mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

async function assertNarrowWorkbench(page) {
  const measured = await page.evaluate(() => {
    const box = (sel) => {
      const el = document.querySelector(sel);
      const rect = el.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    };
    return {
      center: box('.col-center').width,
      right: box('[data-testid=right-panel]').width,
      pause: box('[data-testid=btn-pause]').height,
      resume: box('[data-testid=btn-resume]').height,
      stop: box('[data-testid=btn-stop]').height,
      agent: box('[data-testid=composer-agent]').height,
      context: box('.chip-runtime-meta').height,
    };
  });
  console.log(`NARROW_1000 ${JSON.stringify(measured)}`);
  expect(measured.center).toBeGreaterThanOrEqual(420);
  expect(measured.right).toBeLessThanOrEqual(340);
  for (const key of ['pause', 'resume', 'stop', 'agent', 'context']) {
    expect(measured[key], key).toBeLessThanOrEqual(32);
  }
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
    await expect(page.locator('.conv-active .sub-agent-row:not(.is-real) .sub-agent-name').first()).toHaveText('主 Agent');
    await expect(page.locator('body')).not.toContainText('sk-scout-test');
    await shot(page, 'sidebar-subagents-light-1440');

    await foreground.click();
    await expect(page.getByTestId('subagent-banner-text')).toContainText('子 Agent · 侦察');
    await expect(page.getByTestId('subagent-back')).toHaveText('返回主对话');
    const transcript = page.getByTestId('subagent-thread');
    await expect(transcript.locator('[data-testid=message][data-role=user]')).toContainText(FOREGROUND_TASK);
    await expect(transcript.locator('[data-testid=message][data-role=assistant]')).toContainText(CHILD_TEXT);
    await expect(transcript.locator('[data-testid=message-sender]')).toHaveText('侦察');
    await expect(page.getByTestId('chat-input')).toBeDisabled();
    await shot(page, 'subagent-messages-light-1440');

    await switchLanguage(page, 'en');
    await expect(page.getByTestId('subagent-banner-text')).toContainText('Sub-agent ·');
    await expect(page.getByTestId('subagent-back')).toHaveText('Back to main chat');
    await expect(page.locator('.conv-active .sub-agent-row:not(.is-real) .sub-agent-name').first()).toHaveText('Main agent');
    await expect(transcript.locator('[data-testid=message-sender]')).toHaveText('侦察');
    await expect(background.getByTestId('subagent-background')).toHaveText('Background');
    await switchLanguage(page, 'zh');
    await expect(page.getByTestId('subagent-back')).toHaveText('返回主对话');

    await page.getByTestId('subagent-back').click();
    await expect(page.getByTestId('subagent-banner')).toHaveCount(0);
    await expect(page.getByTestId('chat-input')).toBeEnabled();
    await expect(page.getByTestId('message').filter({ hasText: '主对话已汇总。' })).toBeVisible();

    await switchAppearance(page, 'dark');
    await expect.poll(() => page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toContain('dark');
    await shot(page, 'sidebar-subagents-dark-1440');
    await switchAppearance(page, 'light');

    await page.setViewportSize({ width: 1000, height: 760 });
    await assertNarrowWorkbench(page);
    await expect(page.getByTestId('btn-pause')).toHaveAttribute('aria-label', '暂停');
    await expect(page.getByTestId('btn-pause')).toHaveAttribute('title', '暂停执行');
    await expect(page.getByTestId('btn-resume')).toHaveAttribute('aria-label', '继续');
    await expect(page.getByTestId('btn-resume')).toHaveAttribute('title', '继续执行');
    await expect(page.getByTestId('btn-stop')).toHaveAttribute('aria-label', '终止');
    await expect(page.getByTestId('btn-stop')).toHaveAttribute('title', '终止并保存检查点');
    await expect(page.locator('[data-testid=btn-pause] .btn-ctrl-label')).toBeHidden();
    await expect(page.locator('[data-testid=btn-resume] .btn-ctrl-label')).toBeHidden();
    await expect(page.locator('[data-testid=btn-stop] .btn-ctrl-label')).toBeHidden();
    await shot(page, 'sidebar-subagents-light-1000');
    await foreground.click();
    await expect(page.getByTestId('subagent-banner')).toBeVisible();
    await expect(transcript.locator('[data-testid=message-sender]')).toHaveText('侦察');
    await assertNarrowWorkbench(page);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
    await shot(page, 'subagent-1000');
    await page.getByTestId('subagent-back').click();
  } finally {
    await srv?.kill();
    await child.close();
  }
});

function seedArchived(dataDir, row) {
  const db = new DatabaseSync(path.join(dataDir, 'pi-work.sqlite'));
  const now = Date.now();
  db.prepare(`INSERT INTO conversations (
    id, workspace_id, title, status, auto_continues, retries, last_checkpoint_at,
    current_step, pipeline_step, updated_at, created_at, role_id, pipeline_id,
    workspace_path, last_progress_at, original_text, usage_json, harness_id, host_mark
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    row.id,
    row.workspaceId,
    row.title,
    'done',
    0,
    0,
    null,
    0,
    0,
    now,
    now,
    null,
    null,
    row.workspacePath,
    now,
    row.originalText || '',
    null,
    null,
    null,
  );
  const ins = db.prepare('INSERT INTO messages (id, conversation_id, role, text, tool_json, seq, meta_json) VALUES (?,?,?,?,?,?,?)');
  row.messages.forEach((msg, index) => {
    ins.run(msg.id, row.id, msg.role, msg.text, null, index + 1, null);
  });
  db.close();
}

test('an old conversation is archived and can open a new chat from its history', async ({ page }) => {
  const prepared = await prepareWorkspaces(['repo']);
  const setup = await startServer({
    extraEnv: { PI_WORK_WORKSPACE_ROOT: prepared.root },
  });
  const token = '';
  const ws = await api(setup.url, 'POST', '/workspaces', { name: 'old-ws', path: prepared.dirs[0] }, token);
  expect(ws.status).toBe(201);
  await setup.kill();
  // Pre-kernel rows have no harness id. The old run loop is gone, so the row is seeded.
  seedArchived(setup.dataDir, {
    id: 'old-archive-e2e',
    workspaceId: ws.body.id,
    workspacePath: ws.body.path || prepared.dirs[0],
    title: '旧对话',
    originalText: '请保留这句话',
    messages: [{ id: 'm-user', role: 'user', text: '请保留这句话' }],
  });

  const kernel = await startServer({
    dataDir: setup.dataDir,
    extraEnv: {
      PI_WORK_FAUX_TEXT: 'continued',
      PI_WORK_WORKSPACE_ROOT: prepared.root,
    },
  });
  try {
    await openApp(page, kernel, token);
    const item = page.locator('[data-testid=conversation-item][data-archived=true]');
    await expect(item).toBeVisible();
    await expect(item.getByTestId('archived-badge')).toHaveText('已归档');
    await expect(page.getByTestId('archived-banner-text')).toHaveText('切换内核前的对话，只能查看');
    await expect(page.getByTestId('archived-fork')).toHaveText('用这段历史开新对话');
    await expect(page.getByTestId('chat-input')).toBeDisabled();
    await expect(page.getByTestId('btn-pause')).toBeDisabled();
    await expect(page.getByTestId('btn-resume')).toBeDisabled();
    await expect(page.getByTestId('composer-agent')).toBeDisabled();
    await expect(page.getByTestId('message').filter({ hasText: '请保留这句话' })).toBeVisible();
    await expect(page.locator('body')).not.toContainText('sk-');
    await shot(page, 'archived-light-1440');

    await switchLanguage(page, 'en');
    await expect(item.getByTestId('archived-badge')).toHaveText('Archived');
    await expect(page.getByTestId('archived-banner-text')).toContainText('can only be viewed');
    await expect(page.getByTestId('archived-fork')).toHaveText('Start a new chat from this history');
    await switchLanguage(page, 'zh');
    await expect(page.getByTestId('archived-fork')).toHaveText('用这段历史开新对话');

    await page.setViewportSize({ width: 1000, height: 760 });
    await expect(page.getByTestId('archived-banner')).toBeVisible();
    await expect(page.getByTestId('chat-input')).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
    await shot(page, 'archived-1000');
    await page.setViewportSize({ width: 1440, height: 900 });

    const previousId = await item.getAttribute('data-id');
    await page.getByTestId('archived-fork').click();
    await expect(page.getByTestId('chat-input')).toBeEnabled({ timeout: 15000 });
    await expect(page.getByTestId('archived-banner')).toHaveCount(0);
    const active = page.locator('[data-testid=conversation-item].conv-active');
    await expect(active).not.toHaveAttribute('data-archived');
    await expect(active).not.toHaveAttribute('data-id', previousId);
    await expect(page.locator(`[data-testid=conversation-item][data-id="${previousId}"]`)).toHaveAttribute('data-archived', 'true');
    await expect(page.getByTestId('composer-agent')).toBeEnabled();
  } finally {
    await kernel.kill();
  }
});
