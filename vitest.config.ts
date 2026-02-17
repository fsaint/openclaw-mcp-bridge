import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: ".",
    include: ["test/**/*.test.ts"],
    globals: true,
    testTimeout: 15000,
    hookTimeout: 10000,
  },
});
