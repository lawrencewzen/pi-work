import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executablePath = process.env.WEFT_CHROME || undefined;
const ci = !!process.env.CI;
const args = ['--no-sandbox', '--disable-dev-shm-usage'];

export default defineConfig({
  testDir: './e2e',
  outputDir: path.join(root, 'test-results'),
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: ci,
  reporter: [['list'], ['html', { open: 'never', outputFolder: path.join(root, 'playwright-report') }]],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 1440, height: 900 },
    launchOptions: executablePath
      ? { executablePath, args }
      : ci
        ? { args }
        : undefined,
  },
});
