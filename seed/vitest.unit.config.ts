import { defineConfig } from "vitest/config";

// Seeder unit tests: pure scenario logic. No network, no Docker.
export default defineConfig({
  test: {
    include: ["test/unit/**/*.test.ts"],
    environment: "node",
    setupFiles: ["../server/test/support/no-network.ts"],
  },
});
