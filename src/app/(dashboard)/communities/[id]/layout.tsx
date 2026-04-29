import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  currentUserCanAccessCommunity,
  currentUserCanAccessOrg,
} from "@/lib/auth/access";
import { CommunitySubNav, type PaymentChipData } from "./community-subnav";
import { derivePaymentHealth } from "./payment/health";
import { timeAgo } from "@/lib/time-ago";

/**
 * /communities/[id] — shared layout (#119).
 *
 * Wraps both the Overview page (`/communities/[id]`) and the Payment page
 * (`/communities/[id]/payment`) with a sub-nav that surfaces the payment
 * health chip. Overview page's existing content keeps rendering as children.
 *
 * The layout fetches just enough for the sub-nav (community id/name +
 * payment_* fields for the chip). Each child page does its own richer fetch
 * for its specific data — cheap duplicate reads, simpler reasoning.
 */
export default async function CommunityLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  // Permission gate — 404 if the user can't access (don't leak existence).
  const canAccess = await currentUserCanAccessCommunity(supabase, id);
  if (!canAccess) notFound();

  const { data: community } = await supabase
    .from("communities")
    .select(
      "id, org_id, name, payment_provider, payment_last_configured_at",
    )
    .eq("id", id)
    .maybeSingle<{
      id: string;
      org_id: string;
      name: string;
      payment_provider: "pesapal" | null;
      payment_last_configured_at: string | null;
    }>();

  if (!community) notFound();

  // Invoice-tab visibility is the *edit* gate (super_admin OR org_manager
  // scoped to this community's parent org), independent of `canAccess` (the
  // read gate). Hidden, not just disabled, when false. Mirrors the Payment
  // route's permission gate (#196). Two round-trips here are acceptable for
  // simplicity — the helper isn't cached today (see PDF2 R3 dev notes).
  const canEditInvoice = await currentUserCanAccessOrg(
    supabase,
    community.org_id,
  );

  // Phase B (#157): the `failing` health state is emitted when this
  // community has at least one payment_events row with `to_status='failed'`
  // AND `source='ipn'` within the last 24h. We resolve "this community" by
  // walking microgrid_id → microgrids.community_id, but for the chip we only
  // need the most-recent timestamp — fetch a single row, ordered DESC. RLS
  // on payment_events enforces access; we further filter by communityId to
  // avoid pulling the entire org's events.
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

  const relativeTime = community.payment_last_configured_at
    ? timeAgo(community.payment_last_configured_at)
    : null;

  const chipData: PaymentChipData = {
    status: health,
    lastConfiguredAt: community.payment_last_configured_at,
    relativeTime,
  };

  return (
    <div>
      <div className="mb-4">
        <CommunitySubNav
          communityId={community.id}
          paymentHealth={chipData}
          showInvoiceTab={canEditInvoice}
        />
      </div>
      {children}
    </div>
  );
}
