import { createClient } from "@/lib/supabase/server";
import type { BillingPeriod } from "@/lib/types/database";
import { BillingPeriodList } from "@/components/BillingPeriodList";

export default async function BillingPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  // Step 1: Fetch periods
  const { data: periods, error } = await supabase
    .from("billing_periods")
    .select("*")
    .eq("microgrid_id", id)
    .order("start_date", { ascending: false })
    .returns<BillingPeriod[]>();

  if (error) {
    return (
      <div className="rounded-md bg-red-50 p-4 text-sm text-red-700">
        Error loading billing periods: {error.message}
      </div>
    );
  }

  // Step 2: Fetch line item summaries + microgrid in parallel
  const periodIds = (periods ?? []).map((p) => p.id);

  const [lineItemsResult, microgridResult] = await Promise.all([
    periodIds.length > 0
      ? supabase
          .from("billing_line_items")
          .select("billing_period_id, usage_kwh, total_amount")
          .in("billing_period_id", periodIds)
      : Promise.resolve({
          data: [] as {
            billing_period_id: string;
            usage_kwh: number;
            total_amount: number;
          }[],
          error: null,
        }),
    supabase.from("microgrids").select("currency").eq("id", id).single(),
  ]);

  // Step 3: Aggregate client-side
  const summaries: Record<string, { totalKwh: number; totalAmount: number }> =
    {};
  for (const item of lineItemsResult.data ?? []) {
    const existing = summaries[item.billing_period_id] ?? {
      totalKwh: 0,
      totalAmount: 0,
    };
    existing.totalKwh += Number(item.usage_kwh);
    existing.totalAmount += Number(item.total_amount);
    summaries[item.billing_period_id] = existing;
  }

  return (
    <BillingPeriodList
      microgridId={id}
      periods={periods ?? []}
      summaries={summaries}
      currency={microgridResult.data?.currency ?? "UGX"}
    />
  );
}
