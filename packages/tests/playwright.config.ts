import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.PORT) || 8787;

export default defineConfig({
  testDir: './tests',
  timeout: 10 * 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  projects: [
    { name: 'node', testMatch: /node-.*\.spec\.ts/ },
    {
      name: 'browser',
      testMatch: /(browser-.*|ide-.*)\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'node server.js',
    port: PORT,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
});
