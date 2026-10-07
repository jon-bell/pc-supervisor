import { createArgosReporterOptions } from "@argos-ci/playwright/reporter";
import { defineConfig, devices } from "@playwright/test";
import { E2E_PORT } from "./support/env.js";

// The app under test is `pcs serve` (Fastify + the built web app) on
// 127.0.0.1, over the golden scenario synced with PCS_NOW pinned. The
// webServer command does the seeding and syncing first (support/golden-server.ts).
export default defineConfig({
  testDir: "./specs",
  globalSetup: "./support/global-setup.ts",
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // One harness and one server: run specs in order, one at a time.
  workers: 1,
  fullyParallel: false,
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
    viewport: { width: 1280, height: 720 },
    baseURL: `http://127.0.0.1:${E2E_PORT}`,
    timezoneId: "UTC",
    locale: "en-US",
    trace: "retain-on-failure",
    // Argos injects its stabilization script inline, which the app's strict
    // CSP (script-src 'self') blocks. The CSP itself is asserted by the
    // server's unit tests and by specs/security.spec.ts on response headers.
    bypassCSP: true,
    // Argos-recommended flags for stable font rendering across runners.
    launchOptions: { args: ["--disable-lcd-text", "--font-render-hinting=none"] },
  },
  // The tagging spec is the only one that writes to HotCRP: it runs in its
  // own project after all the read-only specs, so their triage order and
  // Argos screenshots never see its tags (PLAN M8).
  projects: [
    // Unnamed, so Argos screenshot names carry no project prefix and keep
    // matching the baselines on main.
    { name: "", testIgnore: /tagging\.spec\.ts$/ },
    { name: "tagging", testMatch: /tagging\.spec\.ts$/, dependencies: [""] },
  ],
  webServer: {
    command: "npx tsx e2e/support/golden-server.ts",
    cwd: "..",
    url: `http://127.0.0.1:${E2E_PORT}/api/meta`,
    // Always a fresh seed + sync; never reuse a server holding other data.
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
