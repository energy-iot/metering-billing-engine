import "server-only";
import type { NextRequest } from "next/server";

// NOTE (#250): the pre-#250 `CUSTOMERAPP_ACTOR_ID` constant was REMOVED.
// It was a synthetic UUID written into `billing_audit_log.actor_user_id`
// that did NOT exist in `auth.users`, which would trip the FK on the first
// real `POST /api/internal/billing/generate` call. The new pattern
// (migration 00041) writes `actor_user_id=NULL, actor_kind='customerapp',
// actor_ref=<token name>` instead — see `/api/internal/**` routes and
// `src/lib/billing/generate.ts` for call sites.

/**
 * Returns true if the request carries a valid x-api-key header matching
 * INTERNAL_API_KEY. Callers must return 401 immediately when this returns false.
 *
 * Guards against misconfiguration: if INTERNAL_API_KEY is not set in the
 * environment, every request is rejected so the route is never silently open.
 */
export function checkInternalApiKey(request: NextRequest): boolean {
  const envKey = process.env.INTERNAL_API_KEY;
  if (!envKey || envKey.length < 32) {
    return false;
  }
  const provided = request.headers.get("x-api-key");
  return !!provided && provided === envKey;
}
