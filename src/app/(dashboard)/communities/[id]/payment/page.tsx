import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  currentUserCanAccessCommunity,
  currentUserCanAccessOrg,
} from "@/lib/auth/access";
import { derivePaymentHealth } from "./health";
import { PaymentShell } from "./payment-shell";

/**
 * /communities/[id]/payment — Payment configuration (#119, #196).
 *
 * Server component fetches:
 *   1. Community row (name + payment_* columns).
 *   2. Permission flags (canAccessCommunity for visibility, canEdit for the
 *      Save / Reconfigure / Test-again surface). canEdit is true for
 *      super_admin OR org_manager scoped to this community's parent org.
 *   3. Decrypted secret last-4 — visible to anyone with edit permission. We
 *      call fn_get_community_payment_secret (per migration 00030 widens the
 *      decrypt gate to org_managers of the parent org), then compute
 *      `secret.slice(-4)` SERVER-SIDE. The plaintext secret NEVER crosses
 *      to the client.
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

  const { data: community, error: commErr } = await supabase
    .from("communities")
    .select(
      "id, org_id, name, payment_provider, payment_provider_config, payment_last_configured_at",
    )
    .eq("id", id)
    .maybeSingle<{
      id: string;
      org_id: string;
      name: string;
      payment_provider: "pesapal" | null;
      payment_provider_config: unknown;
      payment_last_configured_at: string | null;
    }>();

  if (commErr || !community) notFound();

  // canEdit needs community.org_id, so this derivation must follow the
  // community fetch. True for super_admin OR org_manager scoped to this
  // community's parent org (#196).
  const canEdit = await currentUserCanAccessOrg(supabase, community.org_id);

  // `fn_get_community_payment_secret` (migration 00030 truth table): returns
  // plaintext for super_admin OR org_manager-of-parent-org OR service_role,
  // NULL otherwise. We mirror the gate here so the secretLast4 prop is only
  // computed when the caller can edit (UI renders "—" when canEdit=false).
  let secretLast4: string | null = null;
  if (community.payment_provider === "pesapal" && canEdit) {
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

  // Phase B (#157): include the most-recent failed IPN timestamp so the
  // health chip can flip to `failing` after a webhook reports failure.
  const { data: latestFailed } = await supabase
    .from("payment_events")
    .select(
      `
      at,
      billing_line_items!inner (
        billing_periods!inner (
          microgrids!inner (
            community_id
          )
        )
      )
    `,
    )
    .eq("source", "ipn")
    .eq("to_status", "failed")
    .eq(
      "billing_line_items.billing_periods.microgrids.community_id",
      id,
    )
    .order("at", { ascending: false })
    .limit(1)
    .maybeSingle<{ at: string }>();

  const health = derivePaymentHealth({
    payment_provider: community.payment_provider,
    payment_last_configured_at: community.payment_last_configured_at,
    most_recent_failed_ipn_at: latestFailed?.at ?? null,
  });

  // Server-derived public callback URL surfaced in the configured-mode panel
  // (visible to anyone with edit permission) for operator visibility — matches
  // the URL Save & test registers with Pesapal. Always recomputed; never
  // persisted client-side.
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
        canEdit={canEdit}
      />
    </div>
  );
}
