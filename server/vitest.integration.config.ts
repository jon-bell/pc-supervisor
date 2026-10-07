import { defineConfig } from "vitest/config";

// Contract + integration tests against the local harness only. The global
// setup refuses to run unless PCS_HOTCRP_URL is 127.0.0.1/localhost.
// Load the harness env first: set -a; . ./.env.test; set +a
export default defineConfig({
  test: {
    include: ["test/contract/**/*.test.ts", "test/integration/**/*.test.ts"],
    environment: "node",
    globalSetup: ["test/support/harness-global-setup.ts"],
    testTimeout: 30_000,
    // One harness; keep requests polite.
    fileParallelism: false,
    // File order is not fixed, and no file may depend on another's data: each
    // seeds what it needs in beforeAll (MiniSeed, or seedScenario after a
    // reset). Check with --sequence.shuffle.files. Tests within a file do run
    // in order (sync.test.ts's steps share one DB), so don't shuffle tests.
  },
});
