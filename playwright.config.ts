import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test/e2e',
  timeout: 60000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5349',
    channel: 'chrome',
    headless: true,
    actionTimeout: 15000
  },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 5349 --strictPort',
    url: 'http://127.0.0.1:5349/api/health',
    timeout: 60000,
    reuseExistingServer: true
  }
});
