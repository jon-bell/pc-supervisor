import { defineConfig, devices } from "@playwright/test";
import { createArgosReporterOptions } from "@argos-ci/playwright/reporter";

// Upload only from CI: tokenless auth via the Argos GitHub App, or ARGOS_TOKEN
// if one is set. Local runs just take screenshots.
export default defineConfig({
  testDir: ".",
  reporter: [
    ["list"],
    ["@argos-ci/playwright/reporter", createArgosReporterOptions({ uploadToArgos: !!process.env.CI })],
  ],
  use: {
    ...devices["Desktop Chrome"],
    baseURL: process.env.PCS_HOTCRP_URL ?? "http://127.0.0.1:8080",
    // Argos-recommended flags for stable font rendering across runners.
    launchOptions: { args: ["--disable-lcd-text", "--font-render-hinting=none"] },
  },
});
