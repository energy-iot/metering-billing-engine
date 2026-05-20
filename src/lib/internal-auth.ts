import "server-only";
import type { NextRequest } from "next/server";

/**
 * UUID recorded in billing_audit_log when an action is triggered by the
 * customerapp automation system rather than a human operator.
 */
export const CUSTOMERAPP_ACTOR_ID = "00000000-0000-4000-8000-000000000001";

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
