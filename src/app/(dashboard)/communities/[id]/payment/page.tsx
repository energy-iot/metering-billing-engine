import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  currentUserCanAccessCommunity,
  currentUserIsSuperAdmin,
} from "@/lib/auth/access";
import { derivePaymentHealth } from "./health";
import { PaymentShell } from "./payment-shell";

/**
 * /communities/[id]/payment — Payment configuration (#119).
 *
 * Server component fetches:
 *   1. Community row (name + payment_* columns).
 *   2. Permission flags (canAccessCommunity, isSuperAdmin).
 *   3. Decrypted secret last-4 — super_admin only. We call
 *      fn_get_community_payment_secret which returns NULL for org_manager
 *      (even on their own community), then compute `secret.slice(-4)`
 *      SERVER-SIDE. The plaintext secret NEVER crosses to the client.
 *
 * The server component passes everything as props to `<PaymentShell>` which
 * owns mode state (empty / configured / editing), form state, and the
 * Save & test promise.
 */
export default async function PaymentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  // Permission gate — 404 if hidden (don't leak existence).
  const canAccess = await currentUserCanAccessCommunity(supabase, id);
  if (!canAccess) notFound();

  const isSuperAdmin = await currentUserIsSuperAdmin(supabase);

  const { data: community, error: commErr } = await supabase
    .from("communities")
    .select(
      "id, name, payment_provider, payment_provider_config, payment_last_configured_at",
    )
    .eq("id", id)
    .maybeSingle<{
      id: string;
      name: string;
      payment_provider: "pesapal" | null;
      payment_provider_config: unknown;
      payment_last_configured_at: string | null;
    }>();

  if (commErr || !community) notFound();

  // Mirrors openems-backend/page.tsx:81-89. `fn_get_community_payment_secret`
  // returns NULL for non-super_admin per migration 00020 truth table, so the
  // secretLast4 prop is NULL for org_manager (UI renders "—").
  let secretLast4: string | null = null;
  if (community.payment_provider === "pesapal" && isSuperAdmin) {
    const { data: secret } = await supabase.rpc(
      "fn_get_community_payment_secret",
      { _community_id: id },
    );
    if (typeof secret === "string" && secret.length >= 4) {
      secretLast4 = secret.slice(-4);
    }
  }

  // Normalize the stored config into the shape the shell expects.
  const cfgObj =
    community.payment_provider_config &&
    typeof community.payment_provider_config === "object"
      ? (community.payment_provider_config as Record<string, unknown>)
      : {};
  const normalizedConfig = {
    consumer_key:
      typeof cfgObj.consumer_key === "string" ? cfgObj.consumer_key : "",
    base_url: typeof cfgObj.base_url === "string" ? cfgObj.base_url : "",
    sandbox: typeof cfgObj.sandbox === "boolean" ? cfgObj.sandbox : false,
    ipn_id: typeof cfgObj.ipn_id === "string" ? cfgObj.ipn_id : "",
  };

  const health = derivePaymentHealth({
    payment_provider: community.payment_provider,
    payment_last_configured_at: community.payment_last_configured_at,
  });

  // Server-derived public callback URL surfaced in the configured-mode panel
  // (super_admin only) for operator visibility — matches the URL Save & test
  // registers with Pesapal. Always recomputed; never persisted client-side.
  const callbackBase = (
    process.env.NEXT_PUBLIC_PAYMENT_CALLBACK_URL ?? ""
  )
    .trim()
    .replace(/\/+$/, "");
  const callbackUrl = callbackBase ? `${callbackBase}/api/payments/ipn` : "";

  return (
    <div className="space-y-4">
      <PaymentShell
        community={{
          id: community.id,
          name: community.name,
          payment_provider: community.payment_provider,
          payment_last_configured_at: community.payment_last_configured_at,
          config: normalizedConfig,
          callback_url: callbackUrl,
        }}
        health={health}
        secretLast4={secretLast4}
        isSuperAdmin={isSuperAdmin}
      />
    </div>
  );
}
