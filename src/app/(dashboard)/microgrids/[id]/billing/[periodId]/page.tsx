import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type {
  BillingLineItem,
  BillingPeriod,
  Microgrid,
  RateSchedule,
  Tenant,
} from "@/lib/types/database";
import { BillingTable } from "@/components/BillingTable";

export default async function BillingPeriodDetailPage({
  params,
}: {
  params: Promise<{ id: string; periodId: string }>;
}) {
  const { id, periodId } = await params;
  const supabase = await createClient();

  const [
    { data: period, error: periodError },
    { data: lineItems, error: lineItemsError },
    { data: tenants, error: tenantsError },
    { data: schedule, error: scheduleError },
    { data: microgrid, error: microgridError },
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
      .from("tenants")
      .select("*")
      .eq("microgrid_id", id)
      .order("name")
      .returns<Tenant[]>(),
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
      .select("id, name, currency")
      .eq("id", id)
      .single()
      .then((res) => ({ ...res, data: res.data as Microgrid | null })),
  ]);

  if (periodError || !period) {
    notFound();
  }

  if (microgridError || !microgrid) {
    return (
      <div className="rounded-md bg-red-50 p-4 text-sm text-red-700">
        Error loading microgrid: {microgridError?.message ?? "Not found"}
      </div>
    );
  }

  if (tenantsError) {
    return (
      <div className="rounded-md bg-red-50 p-4 text-sm text-red-700">
        Error loading tenants: {tenantsError.message}
      </div>
    );
  }

  if (lineItemsError) {
    return (
      <div className="rounded-md bg-red-50 p-4 text-sm text-red-700">
        Error loading line items: {lineItemsError.message}
      </div>
    );
  }

  if (scheduleError) {
    return (
      <div className="rounded-md bg-red-50 p-4 text-sm text-red-700">
        Error loading rate schedule: {scheduleError.message}
      </div>
    );
  }

  return (
    <BillingTable
      microgridId={id}
      period={period}
      lineItems={lineItems ?? []}
      tenants={tenants ?? []}
      tiers={schedule?.tiers ?? []}
      currency={microgrid.currency}
    />
  );
}
