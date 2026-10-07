import { defineConfig } from "vitest/config";

// Unit tests: no network, no Docker. Vitest sets NODE_ENV=test.
export default defineConfig({
  test: {
    include: ["test/unit/**/*.test.ts"],
    environment: "node",
    setupFiles: ["test/support/no-network.ts"],
  },
});
