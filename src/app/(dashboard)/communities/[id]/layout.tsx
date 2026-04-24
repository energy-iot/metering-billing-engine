import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { currentUserCanAccessCommunity } from "@/lib/auth/access";
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
      "id, name, payment_provider, payment_last_configured_at",
    )
    .eq("id", id)
    .maybeSingle<{
      id: string;
      name: string;
      payment_provider: "pesapal" | null;
      payment_last_configured_at: string | null;
    }>();

  if (!community) notFound();

  const health = derivePaymentHealth({
    payment_provider: community.payment_provider,
    payment_last_configured_at: community.payment_last_configured_at,
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
        <CommunitySubNav communityId={community.id} paymentHealth={chipData} />
      </div>
      {children}
    </div>
  );
}
