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
          // Exclude RLS tests from the general lib project — they run in their own project.
          include: ["src/lib/**/*.test.{ts,tsx}"],
          exclude: [
            "src/lib/supabase/__tests__/rls.test.ts",
            "src/lib/supabase/__tests__/user_directory_view.test.ts",
            "src/lib/supabase/__tests__/user_profiles_rls.test.ts",
            "src/lib/supabase/__tests__/dek-bootstrap.test.ts",
            "src/lib/__tests__/invite-user-rpc.test.ts",
          ],
          environment: "node",
        },
      },
      {
        extends: true,
        test: {
          name: "rls",
          // RLS tests hit a live local Supabase — must be single-threaded to avoid
          // fixture-state collisions across test files sharing the same DB.
          // fileParallelism: false ensures tests within this project run sequentially.
          include: [
            "src/lib/supabase/__tests__/rls.test.ts",
            "src/lib/supabase/__tests__/user_directory_view.test.ts",
            "src/lib/supabase/__tests__/user_profiles_rls.test.ts",
            "src/lib/supabase/__tests__/dek-bootstrap.test.ts",
            "src/lib/__tests__/invite-user-rpc.test.ts",
          ],
          environment: "node",
          fileParallelism: false,
        },
      },
      {
        extends: true,
        test: {
          name: "app",
          // Server-component tests (node environment) co-located with page files.
          include: ["src/app/**/*.test.{ts,tsx}"],
          environment: "node",
        },
      },
    ],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // Next.js provides `server-only` as a compiler-level virtual module.
      // In vitest (no Next compiler) we alias to an empty stub so modules
      // guarded by `import 'server-only'` can be exercised in tests.
      "server-only": path.resolve(__dirname, "./src/test/server-only-stub.ts"),
    },
  },
});
