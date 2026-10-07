import { defineConfig } from "vitest/config";

// Seed -> verify against the local harness only (the global setup refuses
// anything but 127.0.0.1/localhost). These tests RESET the harness first.
// Load the harness env and phase dates: set -a; . ./.env.test; set +a, plus
// PCS_TZ / PCS_PHASE_* (CI sets the ci.yml values job-wide).
export default defineConfig({
  test: {
    include: ["test/integration/**/*.test.ts"],
    environment: "node",
    globalSetup: ["../server/test/support/harness-global-setup.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
