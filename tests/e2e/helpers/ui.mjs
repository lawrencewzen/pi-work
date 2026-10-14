import { expect } from '@playwright/test';
import { authToken } from './server.mjs';

export async function login(page, url, token) {
  await page.goto(`${url}/login?token=${encodeURIComponent(token)}`);
  await expect(page.getByTestId('composer-agent')).toBeVisible();
}

/** Log in with the server's auth.token (or an explicit token) and wait for the app shell. */
export async function openApp(page, srv, token) {
  const resolved = token || await authToken(srv.dataDir);
  await login(page, srv.url, resolved);
  return resolved;
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
