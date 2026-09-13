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
    // Windows timeout/recovery tests terminate real child-process trees. Running test files in
    // parallel can make those lifecycle tests interfere with another Vitest worker.
    maxWorkers: process.platform === "win32" ? 1 : 2,
    testTimeout: 30_000
  }
});
