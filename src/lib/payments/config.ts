import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { PaymentError } from "./errors";
import type { PaymentProviderConfig } from "./types";
import type { PesapalConfig } from "./pesapal/types";

/**
 * Server-only helper that resolves a community's saved payment-provider
 * config into a `PaymentProviderConfig` suitable for `getPaymentProviderClient`.
 *
 * Return values:
 *   - `null` — the community has no payment_provider set (unconfigured), OR
 *     the row is hidden by RLS. Callers should surface a 409 (not_configured)
 *     or 404 (not_found) as appropriate.
 *   - `PaymentProviderConfig` — ready to pass to `getPaymentProviderClient`.
 *
 * Throws:
 *   - `PaymentError('PAYMENT_INVALID_CONFIG', 500)` — stored config is
 *     malformed / partial (shape doesn't match provider contract).
 *   - `PaymentError('PAYMENT_FORBIDDEN', 403)` — caller is an org_manager
 *     (not super_admin, not service_role) trying to decrypt a payment secret;
 *     `fn_get_community_payment_secret` returned NULL.
 *
 * Mirrors `src/lib/openems/config.ts`. Authorization semantics are identical:
 * RLS on `communities` filters cross-org rows; the SECURITY-DEFINER helper
 * redacts the secret for non-super_admin / non-service_role callers.
 */
export async function getCommunityPaymentConfig(
  supabase: SupabaseClient,
  communityId: string,
): Promise<PaymentProviderConfig | null> {
  const { data: community, error } = await supabase
    .from("communities")
    .select("id, payment_provider, payment_provider_config")
    .eq("id", communityId)
    .maybeSingle<{
      id: string;
      payment_provider: "pesapal" | null;
      payment_provider_config: unknown;
    }>();

  if (error) {
    throw new PaymentError(
      `Failed to read community payment config: ${error.message}`,
      "PAYMENT_INVALID_CONFIG",
      500,
      error,
    );
  }

  if (!community) return null; // RLS hid the row OR the community does not exist.
  if (!community.payment_provider) return null; // Unconfigured.

  if (community.payment_provider === "pesapal") {
    const parsed = parsePesapalConfig(community.payment_provider_config);

    const { data: secret, error: secretErr } = await supabase.rpc(
      "fn_get_community_payment_secret",
      { _community_id: communityId },
    );

    if (secretErr) {
      throw new PaymentError(
        `Failed to retrieve payment secret: ${secretErr.message}`,
        "PAYMENT_INVALID_CONFIG",
        500,
        secretErr,
      );
    }

    if (!secret) {
      throw new PaymentError(
        "Only super admins can generate payment links for this community, because they are the only role that can decrypt the provider secret. Ask a super admin.",
        "PAYMENT_FORBIDDEN",
        403,
      );
    }

    return {
      provider: "pesapal",
      config: parsed,
      secret: secret as string,
    };
  }

  // Exhaustiveness guard — if a new enum value is added without a branch here,
  // this RETURN surfaces the misconfiguration at runtime. TypeScript narrowing
  // to `never` isn't possible from a Supabase nullable enum, so we defend at
  // runtime.
  throw new PaymentError(
    `Unsupported payment_provider: ${String(community.payment_provider)}`,
    "PAYMENT_INVALID_CONFIG",
    500,
  );
}

/** Validate the JSONB shape for Pesapal. Throws `PAYMENT_INVALID_CONFIG` on any issue. */
function parsePesapalConfig(raw: unknown): PesapalConfig {
  if (!raw || typeof raw !== "object") {
    throw new PaymentError(
      "payment_provider_config is missing or not an object",
      "PAYMENT_INVALID_CONFIG",
      500,
    );
  }
  const obj = raw as Record<string, unknown>;
  const consumer_key = typeof obj.consumer_key === "string" ? obj.consumer_key : "";
  const base_url = typeof obj.base_url === "string" ? obj.base_url : "";
  const ipn_id = typeof obj.ipn_id === "string" ? obj.ipn_id : "";
  if (!consumer_key || !base_url || !ipn_id) {
    throw new PaymentError(
      "payment_provider_config is missing required fields (consumer_key, base_url, ipn_id)",
      "PAYMENT_INVALID_CONFIG",
      500,
    );
  }
  return { consumer_key, base_url, ipn_id };
}
