import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // Per-file environment overrides (vitest 4.x equivalent of environmentMatchGlobs):
    // component tests run in jsdom, lib tests run in node.
    // Use @vitest-environment directive in test files or projects array in workspace config.
    projects: [
      {
        extends: true,
        test: {
          name: "components",
          include: ["src/components/**/*.test.{ts,tsx}"],
          environment: "jsdom",
        },
      },
      {
        extends: true,
        test: {
          name: "lib",
          include: ["src/lib/**/*.test.{ts,tsx}"],
          environment: "node",
        },
      },
    ],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
