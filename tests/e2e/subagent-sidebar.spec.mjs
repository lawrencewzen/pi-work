import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startServer, prepareWorkspaces } from './helpers/server.mjs';
import { createWorkspace, newConversation, send, openApp } from './helpers/ui.mjs';

const TESTER = 'run:sub:tester';
const CODER = 'run:sub:coder';
const AUDITOR = 'run:sub:auditor';
const NOTE_TEXT = '你对 测试 说：只跑 auth 相关的';
const NUDGE_TEXT = '只跑 auth 相关的';

const AGENTS = [
  {
    id: TESTER,
    roleId: 'tester',
    name: '测试',
    status: 'running',
    step: 2,
    totalSteps: 5,
    lastText: '正在写登录测试，路径很长很长很长很长很长很长很长很长',
    mode: 'foreground',
  },
  {
    id: CODER,
    roleId: 'coder',
    name: '编码',
    status: 'done',
    lastText: '改完了 auth',
    mode: 'foreground',
  },
  {
    id: AUDITOR,
    roleId: 'auditor',
    name: '审计',
    status: 'waiting',
    lastText: 'auditor',
    mode: 'foreground',
  },
];

function agentMessages(aid, extras = {}) {
  const known = AGENTS.find((item) => item.id === aid) || { id: aid };
  return {
    ...known,
    ...extras,
    messages: extras.messages || [
      { id: `${aid}-u`, role: 'user', text: '请处理 auth' },
      { id: `${aid}-a`, role: 'assistant', text: '正在处理' },
    ],
  };
}

async function mockSubagentApi(page, bag) {
  await page.route(/\/api\/conversations\//, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const pathname = url.pathname;
    const method = req.method();

    const convGet = pathname.match(/\/api\/conversations\/([^/]+)$/);
    if (method === 'GET' && convGet) {
      const res = await route.fetch();
      const json = await res.json();
      json.agents = bag.agents;
      json.messages = [...(json.messages || []), ...(bag.extraMessages || [])];
      await route.fulfill({
        status: res.status(),
        contentType: 'application/json',
        body: JSON.stringify(json),
      });
      return;
    }

    const msg = pathname.match(/\/api\/conversations\/([^/]+)\/agents\/([^/]+)\/messages$/);
    if (msg) {
      const aid = decodeURIComponent(msg[2]);
      if (method === 'GET') {
        await route.fulfill({ json: agentMessages(aid, bag.agentExtras[aid]) });
        return;
      }
      if (method === 'POST') {
        bag.posts.push({ aid, body: req.postDataJSON(), url: req.url() });
        await route.fulfill({ json: { ok: true } });
        return;
      }
    }

    const stop = pathname.match(/\/api\/conversations\/([^/]+)\/agents\/([^/]+)\/stop$/);
    if (stop && method === 'POST') {
      bag.stops.push({ aid: decodeURIComponent(stop[2]), url: req.url() });
      await route.fulfill({ json: { status: 'stopped' } });
      return;
    }

    await route.continue();
  });
}

async function dispatchAgentEvent(page, data) {
  await page.evaluate((payload) => {
    const sources = window.__testEventSources || [];
    const es = sources[sources.length - 1];
    if (!es) throw new Error('no EventSource');
    es.dispatchEvent(new MessageEvent('agent', { data: JSON.stringify(payload) }));
  }, data);
}

async function boot(page) {
  const prepared = await prepareWorkspaces(['repo']);
  const scriptPath = path.join(prepared.root, 'sidebar.json');
  await fs.writeFile(scriptPath, JSON.stringify({ turns: [{ text: '主对话已收到。' }] }));
  const srv = await startServer({
    extraEnv: {
      PI_WORK_FAUX_SCRIPT: scriptPath,
      PI_WORK_WORKSPACE_ROOT: prepared.root,
    },
  });
  const bag = {
    agents: AGENTS.map((item) => ({ ...item })),
    extraMessages: [{ id: 'note-1', role: 'note', text: NOTE_TEXT }],
    posts: [],
    stops: [],
    agentExtras: {},
  };
  await page.addInitScript(() => {
    const Orig = window.EventSource;
    window.EventSource = class extends Orig {
      constructor(url, config) {
        super(url, config);
        window.__testEventSources = window.__testEventSources || [];
        window.__testEventSources.push(this);
      }
    };
  });
  await mockSubagentApi(page, bag);
  await openApp(page, srv);
  await createWorkspace(page, 'demo', prepared.dirs[0]);
  await newConversation(page);
  await send(page, '请派子代理');
  await expect(page.getByTestId('subagent-tree-row')).toHaveCount(3, { timeout: 20000 });
  return { srv, bag };
}

test.use({ viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 90_000 });

test('sidebar tree, pane interrupt/stop, note, and narrow overflow', async ({ page }) => {
  const { srv, bag } = await boot(page);
  try {
    const rows = page.getByTestId('subagent-tree-row');
    await expect(rows).toHaveCount(3);
    const testerRow = page.locator(`[data-testid=subagent-tree-row][data-agent-id="${TESTER}"]`);
    const coderRow = page.locator(`[data-testid=subagent-tree-row][data-agent-id="${CODER}"]`);
    const auditorRow = page.locator(`[data-testid=subagent-tree-row][data-agent-id="${AUDITOR}"]`);
    await expect(testerRow).toHaveAttribute('data-status', 'running');
    await expect(testerRow).toHaveAttribute('data-depth', '0');
    await expect(coderRow).toHaveAttribute('data-depth', '0');
    await expect(auditorRow).toHaveAttribute('data-depth', '0');
    await expect(testerRow).toContainText('2/5');
    await expect(coderRow).toContainText('完成');
    const pads = await page.evaluate(() => [...document.querySelectorAll('[data-testid=subagent-tree-row]')].map((el) => getComputedStyle(el).paddingLeft));
    expect(new Set(pads).size).toBe(1);

    const toggle = page.getByTestId('subagent-tree-toggle');
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-label', /折叠/);
    await toggle.click();
    await expect(rows).toHaveCount(0);
    await expect(toggle).toHaveAttribute('aria-label', /展开/);
    await toggle.click();
    await expect(rows).toHaveCount(3);

    await testerRow.click();
    await expect(page.getByTestId('subagent-pane')).toBeVisible();
    await expect(page.getByTestId('subagent-banner-text')).toContainText('测试');
    await expect(testerRow).toHaveClass(/is-active/);
    await expect(page.getByTestId('subagent-input')).toBeVisible();
    await expect(page.getByTestId('subagent-send')).toBeVisible();
    await expect(page.getByTestId('subagent-stop')).toBeVisible();

    await page.getByTestId('subagent-input').fill(NUDGE_TEXT);
    await page.getByTestId('subagent-input').press('Enter');
    await expect.poll(() => bag.posts.length).toBe(1);
    expect(bag.posts[0].aid).toBe(TESTER);
    expect(bag.posts[0].body).toEqual({ text: NUDGE_TEXT });
    const pending = page.getByTestId('subagent-nudge-pending');
    await expect(pending).toBeVisible();
    await expect(pending).toContainText(NUDGE_TEXT);
    await expect(pending).toContainText('插话 · 等当前这一步做完');
    await expect(page.getByTestId('subagent-input')).toHaveValue('');

    await page.getByTestId('subagent-stop').click();
    await expect.poll(() => bag.stops.length).toBe(1);
    expect(bag.stops[0].aid).toBe(TESTER);
    await dispatchAgentEvent(page, { id: TESTER, status: 'stopped' });
    await expect(page.getByTestId('subagent-input')).toHaveCount(0);
    await expect(page.getByTestId('subagent-stopped-note')).toBeVisible();
    await expect(page.getByTestId('subagent-stopped-note')).toContainText('已被你停止');
    await expect(testerRow).toHaveAttribute('data-status', 'stopped');

    await coderRow.click();
    await expect(page.getByTestId('subagent-banner-text')).toContainText('编码');
    await expect(page.getByTestId('subagent-input')).toHaveCount(0);
    await expect(page.getByTestId('subagent-send')).toHaveCount(0);
    await expect(page.getByTestId('subagent-stop')).toHaveCount(0);
    await expect(page.getByTestId('subagent-pane')).toContainText('已完成，结果已交回上级');

    const note = page.locator('#center-thread [data-testid=message][data-role=note]');
    await expect(note).toBeVisible();
    await expect(note).toHaveText(NOTE_TEXT);
    await expect(note).toHaveCSS('font-size', '12px');
    const noteColor = await note.evaluate((el) => getComputedStyle(el).color);
    const userBubble = page.locator('#center-thread [data-testid=message][data-role=user]').first();
    await expect(userBubble).not.toContainText(NOTE_TEXT);
    const userBg = await userBubble.locator('[data-testid=message-body]').evaluate((el) => getComputedStyle(el).backgroundColor);
    const noteBg = await note.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(noteBg).not.toBe(userBg);
    expect(noteColor).not.toBe('rgba(0, 0, 0, 0)');

    await page.setViewportSize({ width: 390, height: 844 });
    // Crossing 860px closes the left overlay in the resize handler. Wait for
    // that before opening it, otherwise the rows can still be in the DOM
    // (count 4) while the panel is already display:none.
    await expect(page.locator('#app-shell')).toHaveClass(/left-closed/);
    await page.locator('.col-center [data-action="toggle-left"]').click();
    await expect(page.locator('#app-shell')).not.toHaveClass(/left-closed/);
    await expect(page.getByTestId('subagent-tree-row')).toHaveCount(3);
    await expect(page.getByTestId('subagent-tree-row').first()).toBeVisible();
    const overflow = await page.evaluate(() => {
      const left = document.querySelector('.col-left');
      const leftBox = left.getBoundingClientRect();
      const rows = [...document.querySelectorAll('[data-testid=subagent-tree-row]')];
      return rows.map((row) => {
        const box = row.getBoundingClientRect();
        return {
          id: row.getAttribute('data-agent-id'),
          right: box.right,
          leftRight: leftBox.right,
          scroll: row.scrollWidth,
          client: row.clientWidth,
        };
      });
    });
    for (const row of overflow) {
      expect(row.right, row.id).toBeLessThanOrEqual(row.leftRight + 1);
      expect(row.scroll, row.id).toBeLessThanOrEqual(row.client + 1);
    }
  } finally {
    await srv?.kill();
  }
});
