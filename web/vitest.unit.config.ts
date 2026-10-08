import { defineConfig } from "vitest/config";

// Unit tests for the web app's pure modules (no DOM, no network).
export default defineConfig({
  test: {
    include: ["test/unit/**/*.test.ts"],
    environment: "node",
  },
});
