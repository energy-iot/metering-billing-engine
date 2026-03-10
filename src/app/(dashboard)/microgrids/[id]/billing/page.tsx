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

  return <BillingPeriodList microgridId={id} periods={periods ?? []} />;
}
