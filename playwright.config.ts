import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5349',
    trace: 'retain-on-failure'
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], channel: undefined }
    }
  ],
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 5349 --strictPort',
    url: 'http://127.0.0.1:5349/api/health',
    timeout: 60_000,
    reuseExistingServer: !process.env.CI
  }
});
