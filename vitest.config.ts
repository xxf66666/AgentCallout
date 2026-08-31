import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/cli/**", "src/mcp/**"]
    },
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.mjs"],
    testTimeout: 30_000
  }
});
