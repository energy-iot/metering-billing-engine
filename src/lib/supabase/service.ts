import "server-only";

/**
 * service.ts — Supabase service-role client factory (canonical pattern).
 *
 * Introduced in UX5 (#79). Privileged routes that need to perform
 * `auth.admin.*` operations (invite, delete auth users, list users) use
 * this factory. Application code NEVER uses the service-role client for
 * tenant data reads/writes — that goes through the user-bound client
 * from `@/lib/supabase/server` so RLS evaluates against the caller.
 *
 * Guardrails:
 *   - `import "server-only"` (first line) causes Next.js to fail the
 *     build if any file with `"use client"` imports this module.
 *   - Uses `@supabase/supabase-js` `createClient()` — NOT `@supabase/ssr`.
 *     No cookies to propagate; this is a pure HTTP client with a
 *     static service-role JWT.
 *   - URL: prefers SUPABASE_INTERNAL_URL (Docker mode) over
 *     NEXT_PUBLIC_SUPABASE_URL — mirrors `server.ts:10`.
 *   - Throws at MODULE LOAD if SUPABASE_SERVICE_ROLE_KEY is unset. Fail
 *     fast at boot beats silent 401s in production.
 *
 * Two-client pattern — see ../../app/api/users/invite/route.ts for the
 * canonical caller shape. Reserved for: admin auth operations, future
 * tenant-API privileged writes.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Module-load-time guard. Importing this module in an environment
// without the service-role key is a configuration error.
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SERVICE_ROLE_KEY) {
  throw new Error(
    "SUPABASE_SERVICE_ROLE_KEY is not set. This key is required for " +
      "privileged auth operations (invite, admin deletions). Set it in " +
      ".env.local for local dev and in the Vercel project env vars for " +
      "Production / Preview / Development."
  );
}

const SUPABASE_URL =
  process.env.SUPABASE_INTERNAL_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
if (!SUPABASE_URL) {
  throw new Error(
    "Supabase URL is not set. Expected NEXT_PUBLIC_SUPABASE_URL or " +
      "SUPABASE_INTERNAL_URL (Docker mode)."
  );
}

export function createServiceClient(): SupabaseClient {
  // SERVICE_ROLE_KEY is guaranteed non-null by the module-load check
  // above, but TypeScript needs help seeing that narrowing.
  return createClient(SUPABASE_URL!, SERVICE_ROLE_KEY!, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}
