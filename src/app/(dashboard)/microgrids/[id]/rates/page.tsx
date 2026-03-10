import { createClient } from "@/lib/supabase/server";
import type { RateSchedule } from "@/lib/types/database";
import { TierEditor } from "@/components/TierEditor";

export default async function RatesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const [{ data: schedule, error: scheduleError }, { data: microgrid, error: microgridError }] =
    await Promise.all([
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
        .single(),
    ]);

  if (microgridError) {
    return (
      <div className="rounded-md bg-red-50 p-4 text-sm text-red-700">
        Error loading microgrid: {microgridError.message}
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
    <TierEditor
      microgridId={id}
      currency={microgrid.currency}
      initialSchedule={schedule}
    />
  );
}
