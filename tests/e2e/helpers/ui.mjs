import { expect } from '@playwright/test';
export async function createWorkspace(page, name, wsPath) {
  await page.getByTestId('workspace-new').click();
  await page.getByTestId('workspace-name-input').fill(name);
  await page.getByTestId('workspace-path-input').fill(wsPath);
  await page.getByTestId('workspace-create-submit').click();
  await expect(page.getByTestId('workspace-item').filter({ hasText: name })).toBeVisible();
}
export async function newConversation(page) {
  const before = await page.getByTestId('conversation-item').count();
  await page.getByTestId('conversation-new').click();
  await expect(page.getByTestId('conversation-item')).toHaveCount(before + 1);
}
export async function send(page, text) {
  await page.getByTestId('chat-input').fill(text);
  await page.getByTestId('chat-send').click();
}
export const statusText = (page) => page.getByTestId('status-text');
