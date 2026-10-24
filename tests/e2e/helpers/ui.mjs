import { expect } from '@playwright/test';

/** Open the workbench. Pass token only when the server was started with WEFT_TOKEN. */
export async function login(page, url, token) {
  const target = token ? `${url}/login?token=${encodeURIComponent(token)}` : `${url}/`;
  await page.goto(target);
  await expect(page.getByTestId('composer-agent')).toBeVisible();
}

/** Open the homepage directly. Does not read auth.token. */
export async function openApp(page, srv, token) {
  await login(page, srv.url, token);
}

/** Start a draft on the active workspace. The conversation row is created on the first send. */
export async function createConversation(page) {
  await page.locator('.ws-active').getByTestId('conversation-new').click();
  await expect(page.getByTestId('chat-input')).toBeVisible();
  await expect(page.getByTestId('conversation-create-submit')).toHaveCount(0);
}

export async function createWorkspace(page, name, wsPath) {
  await page.getByTestId('workspace-new').click();
  await page.getByTestId('workspace-name-input').fill(name);
  await page.getByTestId('workspace-path-input').fill(wsPath);
  await page.getByTestId('workspace-create-submit').click();
  await expect(page.getByTestId('workspace-item').filter({ hasText: name })).toBeVisible();
}
/** Same draft entry as createConversation. The row appears when the first message is sent. */
export async function newConversation(page) {
  await createConversation(page);
}
export async function send(page, text) {
  await page.getByTestId('chat-input').fill(text);
  await page.getByTestId('chat-send').click();
}
export const statusText = (page) => page.getByTestId('status-text');

/** Element text including CSS `::before` (the · between sender and model). */
export async function visualText(locator) {
  return locator.evaluate((el) => {
    const before = getComputedStyle(el, '::before').content;
    let prefix = '';
    if (before && before !== 'none') {
      const unquoted = before.replace(/^['"]|['"]$/g, '');
      if (unquoted) prefix = unquoted;
    }
    return prefix + (el.textContent || '');
  });
}

/**
 * Settings rebuilds `.sm` with innerHTML on every open/tab change. boundingBox()
 * can see a 0-size or uncentered frame, and CJK fallback fonts can still be
 * loading. Wait for fonts and two matching layout reads before measuring.
 */
export async function waitForStableLayout(page, locator) {
  await expect(locator).toBeVisible();
  await page.evaluate(async () => {
    if (document.fonts?.ready) await document.fonts.ready;
  });
  await expect.poll(async () => {
    const read = async () => {
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)));
      const box = await locator.boundingBox();
      if (!box || box.width < 2 || box.height < 2) return '';
      return [Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)].join(',');
    };
    const first = await read();
    const second = await read();
    return first && first === second ? first : '';
  }).not.toBe('');
}
