import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.', testMatch: '**/smoke.spec.mjs', workers: 1, retries: 0, timeout: 90000,
  outputDir: '../../output/playwright/results',
  reporter: [['list'], ['html', { outputFolder: '../../output/playwright/report', open: 'never' }]],
});
