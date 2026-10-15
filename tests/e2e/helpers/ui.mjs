import { expect } from '@playwright/test';

/** Open the workbench. Pass token only when the server was started with PI_WORK_TOKEN. */
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
