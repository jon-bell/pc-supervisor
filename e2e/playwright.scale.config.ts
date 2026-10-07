import { defineConfig, devices } from "@playwright/test";
import { SCALE_PORT } from "./scale/budgets.js";

// Perf checks for `npm run test:scale` (PLAN M7). scale/run.ts seeds, syncs
// and starts `pcs serve` on SCALE_PORT before running this config, so there is
// no webServer here. No Argos reporter: these specs take no screenshots.
export default defineConfig({
  testDir: "./scale",
  testMatch: /.*\.spec\.ts$/,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  fullyParallel: false,
  timeout: 120_000,
  outputDir: "../test-results/scale",
  reporter: [["list"], ["html", { outputFolder: "../playwright-report/scale", open: "never" }]],
  use: {
    ...devices["Desktop Chrome"],
    viewport: { width: 1280, height: 720 },
    baseURL: `http://127.0.0.1:${SCALE_PORT}`,
    timezoneId: "UTC",
    locale: "en-US",
    // A trace (no screenshots, which would perturb frame timing) is kept
    // when a budget fails, for the trace viewer.
    trace: { mode: "retain-on-failure", screenshots: false, snapshots: false },
    // addInitScript's observers must run under the app's strict CSP.
    bypassCSP: true,
  },
});
