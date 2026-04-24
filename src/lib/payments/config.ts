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

/**
 * Validate the JSONB shape for Pesapal.
 *
 * Required fields: `consumer_key`, `base_url`.
 *
 * `ipn_id` is **optional** (#119 contract amendment — IPN registration UX
 * ships with #121). A configured community without ipn_id is "ready for auth
 * validation" but not yet "ready to generate links" — the strict check lives
 * further downstream in `PesapalProvider` / `submitOrder`, which throws
 * `PESAPAL_NO_IPN` when a link is actually requested.
 *
 * Throws `PAYMENT_INVALID_CONFIG` only when the shape itself is wrong or the
 * truly-required fields are missing.
 */
export function parsePesapalConfig(raw: unknown): PesapalConfig {
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
  if (!consumer_key || !base_url) {
    throw new PaymentError(
      "payment_provider_config is missing required fields (consumer_key, base_url)",
      "PAYMENT_INVALID_CONFIG",
      500,
    );
  }
  const ipn_id_raw = typeof obj.ipn_id === "string" ? obj.ipn_id : "";
  const sandbox = typeof obj.sandbox === "boolean" ? obj.sandbox : undefined;
  const parsed: PesapalConfig = { consumer_key, base_url };
  if (ipn_id_raw) parsed.ipn_id = ipn_id_raw;
  if (sandbox !== undefined) parsed.sandbox = sandbox;
  return parsed;
}
