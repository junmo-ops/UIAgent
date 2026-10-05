import { resolve } from 'node:path';
import { defineConfig } from '@playwright/test';
process.env.UIAGENT_REAL_MODEL = '1';
// Playwright loads this config again inside workers; reuse the parent run ID.
const runId = process.env.REAL_RUN_ID || new Date().toISOString().replace(/[:.]/g, '-');
process.env.REAL_RUN_ID = runId;
const outputRoot = process.env.REAL_OUTPUT_ROOT || resolve(import.meta.dirname, '../../output/real-model/runs');
export default defineConfig({
 testDir: '.', testMatch: '**/real.spec.mjs', workers: 1, retries: 0, timeout: 360000,
 outputDir: `${outputRoot}/${runId}/results`,
 reporter: [['list'], ['html', { outputFolder: `${outputRoot}/${runId}/report`, open: 'never' }]],
});
