import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["web/src/**/*.test.ts"],
    testTimeout: 180000,
    hookTimeout: 180000,
  },
});
