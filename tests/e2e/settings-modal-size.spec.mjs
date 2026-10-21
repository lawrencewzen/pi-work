import { test, expect } from '@playwright/test';
import { startServer } from './helpers/server.mjs';
import { login, waitForStableLayout } from './helpers/ui.mjs';

const TABS = ['general', 'models', 'git', 'agents', 'plugins', 'skills', 'about'];

let srv;

test.afterEach(async () => { await srv?.kill(); srv = null; });

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 1000, height: 760 },
]) {
  test(`settings modal keeps one size across tabs at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    srv = await startServer({ script: 'basic.json' });
    await page.setViewportSize(viewport);
    await login(page, srv.url);
    await page.locator('[data-action=open-settings]').click();
    const modal = page.locator('.sm');
    await expect(modal).toBeVisible();
    let first = null;
    for (const tab of TABS) {
      await page.locator(`.sm-nav [data-action=set-settings-tab][data-tab=${tab}]`).click();
      await expect(page.locator('.sm-nav div.on')).toHaveAttribute('data-tab', tab);
      await waitForStableLayout(page, modal);
      const box = await modal.boundingBox();
      expect(box).toBeTruthy();
      const size = {
        x: Math.round(box.x),
        y: Math.round(box.y),
        width: Math.round(box.width),
        height: Math.round(box.height),
      };
      console.log(`settings-modal ${viewport.width}x${viewport.height} ${tab} x=${size.x} y=${size.y} ${size.width}x${size.height}`);
      if (!first) first = size;
      else {
        expect(size.width).toBe(first.width);
        expect(size.height).toBe(first.height);
        expect(size.x).toBe(first.x);
        expect(size.y).toBe(first.y);
      }
    }
  });
}
