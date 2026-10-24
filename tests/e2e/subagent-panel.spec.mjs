import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startServer, prepareWorkspaces } from './helpers/server.mjs';
import { createWorkspace, newConversation, send, openApp } from './helpers/ui.mjs';

const TESTER = 'run:sub:tester';
const CODER = 'run:sub:coder';
const AUDITOR = 'run:sub:auditor';
const BARE = 'run:sub:bare';
const NUDGE_TEXT = '只跑 auth 相关的';
const NOW = Date.now();

const AGENTS = [
  {
    id: TESTER,
    name: '测试',
    status: 'running',
    step: 2,
    totalSteps: 5,
    lastText: '正在写登录测试',
    mode: 'foreground',
    brief: '给登录页写测试\n第二行不应出现在卡片摘要',
    startedAt: NOW - 125000,
    lastActivityAt: NOW - 4000,
    currentAction: '正在写 login.spec.ts',
  },
  {
    id: CODER,
    name: '编码',
    status: 'done',
    lastText: '改完了 auth',
    mode: 'foreground',
  },
  {
    id: AUDITOR,
    name: '审计',
    status: 'running',
    mode: 'foreground',
    lastActivityAt: NOW - 90000,
  },
  {
    id: BARE,
    status: 'stopped',
    mode: 'foreground',
  },
];

function mockedConversation(cid, bag) {
  return {
    id: cid,
    title: '请派子代理',
    status: 'idle',
    modelSourceId: null,
    modelId: null,
    messages: [
      { id: 'user-send', role: 'user', text: '请派子代理' },
      { id: 'asst-reply', role: 'assistant', text: '主对话已收到。' },
      ...(bag.extraMessages || []),
    ],
    agents: bag.agents,
  };
}

function agentMessages(aid, extras = {}) {
  const known = AGENTS.find((item) => item.id === aid) || { id: aid };
  const prompt = known.brief || '请处理 auth';
  return {
    ...known,
    ...extras,
    messages: extras.messages || [
      { id: `${aid}-u`, role: 'user', text: prompt },
      { id: `${aid}-a`, role: 'assistant', text: '正在处理' },
    ],
  };
}

function countText(hay, needle) {
  let n = 0;
  let from = 0;
  while (needle && from <= hay.length) {
    const i = hay.indexOf(needle, from);
    if (i < 0) return n;
    n += 1;
    from = i + needle.length;
  }
  return n;
}

async function mockSubagentApi(page, bag) {
  await page.route(/\/api\/conversations\//, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const pathname = url.pathname;
    const method = req.method();

    const convGet = pathname.match(/\/api\/conversations\/([^/]+)$/);
    if (method === 'GET' && convGet) {
      await route.fulfill({ json: mockedConversation(decodeURIComponent(convGet[1]), bag) });
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

async function boot(page) {
  const prepared = await prepareWorkspaces(['repo']);
  const scriptPath = path.join(prepared.root, 'panel.json');
  await fs.writeFile(scriptPath, JSON.stringify({ turns: [{ text: '主对话已收到。' }] }));
  const srv = await startServer({
    extraEnv: {
      WEFT_FAUX_SCRIPT: scriptPath,
      WEFT_WORKSPACE_ROOT: prepared.root,
    },
  });
  const bag = {
    agents: AGENTS.map((item) => ({ ...item })),
    extraMessages: [],
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
  await expect(page.getByTestId('subagent-tree-row')).toHaveCount(4, { timeout: 20000 });
  return { srv, bag };
}

function tabLabels(page) {
  return page.locator('#right-panel .tabs-nav .tab-btn').evaluateAll((btns) => btns.map((btn) => btn.innerText.replace(/\s+/g, ' ').trim()));
}

test.use({ viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 90_000 });

test('right panel tabs, overview, breadcrumb, interrupt box, and narrow overflow', async ({ page }) => {
  const { srv } = await boot(page);
  try {
    const agentTab = page.getByTestId('agent-tab');
    await expect(agentTab).toBeVisible();
    await expect(agentTab.locator('.tab-count')).toHaveText('4');
    await expect.poll(() => tabLabels(page)).toEqual(['变更', '文件', '子 Agent 4']);

    await agentTab.click();
    await expect(page.getByTestId('subagent-overview')).toBeVisible();
    await expect(page.getByTestId('subagent-pane')).toHaveCount(0);
    await expect(page.getByTestId('subagent-input')).toHaveCount(0);
    const cards = page.getByTestId('subagent-card');
    await expect(cards).toHaveCount(4);

    const testerCard = page.locator(`[data-testid=subagent-card][data-agent-id="${TESTER}"]`);
    const coderCard = page.locator(`[data-testid=subagent-card][data-agent-id="${CODER}"]`);
    const auditorCard = page.locator(`[data-testid=subagent-card][data-agent-id="${AUDITOR}"]`);
    const bareCard = page.locator(`[data-testid=subagent-card][data-agent-id="${BARE}"]`);
    await expect(testerCard).toContainText('给登录页写测试');
    await expect(testerCard).not.toContainText('第二行不应出现在卡片摘要');
    await expect(testerCard).toContainText('此刻：正在写 login.spec.ts');
    await expect(coderCard).toContainText('编码');
    await expect(coderCard).toContainText('改完了 auth');
    await expect(coderCard).toContainText('完成');
    await expect(auditorCard).toContainText('无动作');
    await expect(bareCard).toContainText('已停止');

    const viewportText = await page.locator('#right-viewport').innerText();
    expect(viewportText).not.toMatch(/NaN|undefined/);

    const tabsBefore = await page.locator('#right-panel .tabs-nav').innerHTML();
    await testerCard.click();
    await expect(page.getByTestId('subagent-pane')).toBeVisible();
    await expect(page.getByTestId('subagent-overview')).toHaveCount(0);
    await expect(page.getByTestId('subagent-banner-text')).toContainText('给登录页写测试');
    await expect(page.getByTestId('subagent-brief')).toContainText('主 Agent 分派的任务');
    await expect(page.getByTestId('subagent-brief')).toContainText('第二行不应出现在卡片摘要');
    const testerPane = await page.getByTestId('subagent-pane').innerText();
    expect(countText(testerPane, '第二行不应出现在卡片摘要')).toBe(1);
    await expect(page.getByTestId('subagent-thread').locator('[data-testid=message][data-role=user]')).toHaveCount(0);
    expect(await page.locator('#right-panel .tabs-nav').innerHTML()).toBe(tabsBefore);
    await expect.poll(() => tabLabels(page)).toEqual(['变更', '文件', '子 Agent 4']);

    const composer = page.locator('.subagent-composer');
    await expect(composer).toBeVisible();
    const radius = await composer.evaluate((el) => parseFloat(getComputedStyle(el).borderRadius));
    expect(radius).toBeGreaterThanOrEqual(12);
    await expect(page.getByTestId('subagent-input')).toHaveAttribute('placeholder', /插话，比如/);
    const send = page.getByTestId('subagent-send');
    await expect(send).not.toHaveClass(/is-ready/);
    const idleSend = await send.evaluate((el) => getComputedStyle(el).backgroundColor);
    await page.getByTestId('subagent-input').fill(NUDGE_TEXT);
    await expect(send).toHaveClass(/is-ready/);
    await expect.poll(async () => send.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(idleSend);
    await page.getByTestId('subagent-input').fill('');
    await expect(send).not.toHaveClass(/is-ready/);

    const hintBox = await page.locator('.subagent-composer-hint').boundingBox();
    const stopBox = await page.getByTestId('subagent-stop').boundingBox();
    const sendBox = await send.boundingBox();
    expect(hintBox && stopBox && sendBox).toBeTruthy();
    const mid = (box) => box.y + box.height / 2;
    expect(Math.abs(mid(hintBox) - mid(stopBox))).toBeLessThan(6);
    expect(Math.abs(mid(stopBox) - mid(sendBox))).toBeLessThan(6);
    expect(stopBox.x).toBeGreaterThan(hintBox.x + hintBox.width - 1);
    expect(sendBox.x).toBeGreaterThan(stopBox.x);

    await page.getByTestId('subagent-picker-toggle').click();
    await expect(page.getByTestId('subagent-picker')).toBeAttached();
    await expect(page.getByTestId('subagent-picker-item')).toHaveCount(4);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('subagent-picker')).toHaveCount(0);

    await page.getByTestId('subagent-picker-toggle').click();
    await page.getByTestId('subagent-picker-item').filter({ hasText: '编码' }).click();
    await expect(page.getByTestId('subagent-banner-text')).toContainText('编码');
    await expect(page.getByTestId('subagent-handed-back')).toContainText('交回给主 Agent');
    await expect(page.getByTestId('subagent-handed-back')).toContainText('正在处理');
    await expect(page.getByTestId('subagent-input')).toHaveCount(0);
    await expect.poll(() => tabLabels(page)).toEqual(['变更', '文件', '子 Agent 4']);

    await page.locator('.agent-pane-tag').click();
    await expect(page.getByTestId('subagent-overview')).toBeVisible();
    await expect(page.getByTestId('subagent-pane')).toHaveCount(0);

    await auditorCard.click();
    await expect(page.getByTestId('subagent-pane')).toBeVisible();
    await expect(page.getByTestId('subagent-brief')).toContainText('请处理 auth');
    const auditorPane = await page.getByTestId('subagent-pane').innerText();
    expect(countText(auditorPane, '请处理 auth')).toBe(1);
    await expect(page.getByTestId('subagent-thread').locator('[data-testid=message][data-role=user]')).toHaveCount(0);
    await expect(page.getByTestId('subagent-input')).toBeVisible();
    const detailText = await page.locator('#right-viewport').innerText();
    expect(detailText).not.toMatch(/NaN|undefined/);

    await page.locator('.conv-tree-node.conv-active .conv-node-title').click();
    await expect(page.locator('#tab-btn-diff')).toHaveClass(/active/);
    await expect(page.getByTestId('subagent-pane')).toHaveCount(0);
    await expect(page.getByTestId('subagent-overview')).toHaveCount(0);
    await expect(page.getByTestId('subagent-input')).toHaveCount(0);
    await expect(page.getByTestId('agent-tab')).toBeVisible();

    await page.locator(`[data-testid=subagent-tree-row][data-agent-id="${TESTER}"]`).click();
    await expect(page.getByTestId('subagent-pane')).toBeVisible();
    await expect(page.getByTestId('agent-tab')).toHaveClass(/active/);
    await expect(page.getByTestId('subagent-input')).toBeVisible();

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('#app-shell')).toHaveClass(/right-closed/);
    await page.locator('.col-center [data-action="toggle-right"]').click();
    await expect(page.locator('#app-shell')).not.toHaveClass(/right-closed/);
    await expect(page.getByTestId('subagent-pane')).toBeVisible();
    const overflow = await page.evaluate(() => {
      const panel = document.querySelector('[data-testid=right-panel]');
      const nav = panel.querySelector('.tabs-nav');
      const composerBox = document.querySelector('.subagent-composer');
      const panelBox = panel.getBoundingClientRect();
      const over = (el) => {
        const box = el.getBoundingClientRect();
        return {
          id: el.getAttribute('data-testid') || el.className,
          right: box.right,
          panelRight: panelBox.right,
          scroll: el.scrollWidth,
          client: el.clientWidth,
        };
      };
      return {
        doc: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        navScroll: nav.scrollWidth > nav.clientWidth + 1,
        panelScroll: panel.scrollWidth > panel.clientWidth + 1,
        composer: composerBox ? over(composerBox) : null,
        pane: over(document.querySelector('[data-testid=subagent-pane]')),
      };
    });
    expect(overflow.doc).toBe(false);
    expect(overflow.navScroll).toBe(false);
    expect(overflow.panelScroll).toBe(false);
    expect(overflow.composer.right).toBeLessThanOrEqual(overflow.composer.panelRight + 1);
    expect(overflow.pane.right).toBeLessThanOrEqual(overflow.pane.panelRight + 1);

    await page.getByTestId('agent-tab').click();
    await expect(page.getByTestId('subagent-overview')).toBeVisible();
    const cardOverflow = await page.evaluate(() => {
      const panel = document.querySelector('[data-testid=right-panel]').getBoundingClientRect();
      return [...document.querySelectorAll('[data-testid=subagent-card]')].map((el) => {
        const box = el.getBoundingClientRect();
        return { id: el.getAttribute('data-agent-id'), right: box.right, panelRight: panel.right, scroll: el.scrollWidth, client: el.clientWidth };
      });
    });
    for (const row of cardOverflow) {
      expect(row.right, row.id).toBeLessThanOrEqual(row.panelRight + 1);
      expect(row.scroll, row.id).toBeLessThanOrEqual(row.client + 1);
    }
  } finally {
    await srv?.kill();
  }
});
