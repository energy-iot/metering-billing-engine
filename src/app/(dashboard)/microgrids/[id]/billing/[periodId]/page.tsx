import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type {
  BillingLineItem,
  BillingPeriod,
  Household,
  Microgrid,
  RateSchedule,
} from "@/lib/types/domain";
import { BillingTable } from "@/components/BillingTable";
import { HierarchyNav } from "@/components/ui/hierarchy-nav";
import { getHierarchyLevels } from "@/lib/hierarchy";
import { currentUserIsSuperAdmin } from "@/lib/auth/access";

export default async function BillingPeriodDetailPage({
  params,
}: {
  params: Promise<{ id: string; periodId: string }>;
}) {
  const { id, periodId } = await params;
  const supabase = await createClient();

  const levels = await getHierarchyLevels(supabase, {
    kind: "microgrid",
    microgridId: id,
  });

  type MicrogridWithCommunity = Microgrid & {
    communities: { id: string; payment_provider: string | null } | null;
  };

  const [
    { data: period, error: periodError },
    { data: lineItems, error: lineItemsError },
    { data: households, error: householdsError },
    { data: schedule, error: scheduleError },
    { data: microgrid, error: microgridError },
    isSuperAdmin,
  ] = await Promise.all([
    supabase
      .from("billing_periods")
      .select("*")
      .eq("id", periodId)
      .eq("microgrid_id", id)
      .single()
      .then((res) => ({ ...res, data: res.data as BillingPeriod | null })),
    supabase
      .from("billing_line_items")
      .select("*")
      .eq("billing_period_id", periodId)
      .returns<BillingLineItem[]>(),
    supabase
      .from("households")
      .select("*")
      .eq("microgrid_id", id)
      .order("display_name")
      .returns<Household[]>(),
    supabase
      .from("rate_schedules")
      .select("*")
      .eq("microgrid_id", id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()
      .then((res) => ({ ...res, data: res.data as RateSchedule | null })),
    supabase
      .from("microgrids")
      .select("id, name, currency, communities!inner(id, payment_provider)")
      .eq("id", id)
      .single()
      .then((res) => ({ ...res, data: res.data as MicrogridWithCommunity | null })),
    currentUserIsSuperAdmin(supabase),
  ]);

  if (periodError || !period) {
    notFound();
  }

  if (microgridError || !microgrid) {
    return (
      <div className="rounded-md bg-destructive-muted p-4 text-sm text-destructive-fg">
        Error loading microgrid: {microgridError?.message ?? "Not found"}
      </div>
    );
  }

  if (householdsError) {
    return (
      <div className="rounded-md bg-destructive-muted p-4 text-sm text-destructive-fg">
        Error loading households: {householdsError.message}
      </div>
    );
  }

  if (lineItemsError) {
    return (
      <div className="rounded-md bg-destructive-muted p-4 text-sm text-destructive-fg">
        Error loading line items: {lineItemsError.message}
      </div>
    );
  }

  if (scheduleError) {
    return (
      <div className="rounded-md bg-destructive-muted p-4 text-sm text-destructive-fg">
        Error loading rate schedule: {scheduleError.message}
      </div>
    );
  }

  // Normalize PostgREST join (may be array or single object)
  const community = microgrid.communities
    ? Array.isArray(microgrid.communities)
      ? (microgrid.communities as { id: string; payment_provider: string | null }[])[0]
      : (microgrid.communities as { id: string; payment_provider: string | null })
    : null;

  const isPaymentConfigured = community?.payment_provider != null;
  const communityId = community?.id;

  return (
    <>
      <HierarchyNav levels={levels} className="mb-4" />
      <BillingTable
        microgridId={id}
        period={period}
        lineItems={lineItems ?? []}
        households={households ?? []}
        tiers={(schedule?.tiers ?? []) as { label: string; min_kwh: number; max_kwh: number | null; rate_per_kwh: number }[]}
        currency={microgrid.currency}
        isPaymentConfigured={isPaymentConfigured}
        isSuperAdmin={isSuperAdmin}
        communityId={communityId}
      />
    </>
  );
}
