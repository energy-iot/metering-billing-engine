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
          // Multi-step wizard tests walk through 3-4 steps via
          // fireEvent + waitFor; the default 5s testTimeout occasionally
          // races under CI/local contention. 15s headroom — a legitimately
          // deadlocked test still fails fast.
          testTimeout: 15_000,
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
            "src/lib/supabase/__tests__/fn_list_visible_users.test.ts",
            "src/lib/supabase/__tests__/user_profiles_rls.test.ts",
            "src/lib/supabase/__tests__/dek-bootstrap.test.ts",
            "src/lib/supabase/__tests__/payment_state_machine.test.ts",
            "src/lib/supabase/__tests__/apply_payment_event_authz.test.ts",
            "src/lib/supabase/__tests__/billing_audit_log.test.ts",
            "src/lib/supabase/__tests__/audit_actor_kind.test.ts",
            "src/lib/supabase/__tests__/invoice_counters.test.ts",
            "src/lib/supabase/__tests__/invoice_logos_bucket.test.ts",
            "src/lib/supabase/__tests__/org_api_tokens_rls.test.ts",
            "src/lib/supabase/__tests__/ems_operator.test.ts",
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
            "src/lib/supabase/__tests__/fn_list_visible_users.test.ts",
            "src/lib/supabase/__tests__/user_profiles_rls.test.ts",
            "src/lib/supabase/__tests__/dek-bootstrap.test.ts",
            "src/lib/supabase/__tests__/payment_state_machine.test.ts",
            "src/lib/supabase/__tests__/apply_payment_event_authz.test.ts",
            "src/lib/supabase/__tests__/billing_audit_log.test.ts",
            "src/lib/supabase/__tests__/audit_actor_kind.test.ts",
            "src/lib/supabase/__tests__/invoice_counters.test.ts",
            "src/lib/supabase/__tests__/invoice_logos_bucket.test.ts",
            "src/lib/supabase/__tests__/org_api_tokens_rls.test.ts",
            "src/lib/supabase/__tests__/ems_operator.test.ts",
            "src/lib/__tests__/invite-user-rpc.test.ts",
            "src/app/api/users/[id]/resend-invite/__tests__/rls-route.test.ts",
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
          // Exclude RLS-mode integration tests that live under src/app — they
          // run in the `rls` project (live local Supabase, sequential).
          exclude: [
            "src/app/api/users/[id]/resend-invite/__tests__/rls-route.test.ts",
          ],
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
