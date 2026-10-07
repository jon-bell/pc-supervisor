import { createArgosReporterOptions } from "@argos-ci/playwright/reporter";
import { defineConfig, devices } from "@playwright/test";

// The app under test is the built web UI served on 127.0.0.1. PLAN M5 changes
// the webServer to the Fastify server (seed golden -> sync -> serve).
const PORT = 4173;

export default defineConfig({
  testDir: "./specs",
  globalSetup: "./support/global-setup.ts",
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  outputDir: "../test-results",
  // Upload to Argos only from CI: tokenless via the Argos GitHub App, or
  // ARGOS_TOKEN if one is set. Local runs just take screenshots. Screenshots
  // are only ever of synthetic harness data (AGENTS.md rule 4).
  reporter: [
    ["list"],
    ["html", { outputFolder: "../playwright-report", open: "never" }],
    ["@argos-ci/playwright/reporter", createArgosReporterOptions({ uploadToArgos: !!process.env.CI })],
  ],
  use: {
    ...devices["Desktop Chrome"],
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
    // Argos-recommended flags for stable font rendering across runners.
    launchOptions: { args: ["--disable-lcd-text", "--font-render-hinting=none"] },
  },
  webServer: {
    command: "npm run preview -w @pcs/web",
    cwd: "..",
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
