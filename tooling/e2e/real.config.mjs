import { defineConfig } from '@playwright/test';
process.env.UIAGENT_REAL_MODEL = '1';
// Playwright loads this config again inside workers; reuse the parent run ID.
const runId = process.env.REAL_RUN_ID || new Date().toISOString().replace(/[:.]/g, '-');
process.env.REAL_RUN_ID = runId;
export default defineConfig({
 testDir: '.', testMatch: '**/real.spec.mjs', workers: 1, retries: 0, timeout: 360000,
 outputDir: `../../output/real-model/runs/${runId}/results`,
 reporter: [['list'], ['html', { outputFolder: `../../output/real-model/runs/${runId}/report`, open: 'never' }]],
});
