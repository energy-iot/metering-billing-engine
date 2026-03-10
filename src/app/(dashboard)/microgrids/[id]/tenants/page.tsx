import { createClient } from "@/lib/supabase/server";
import type { Meter, Tenant } from "@/lib/types/database";
import { MeterManager } from "@/components/MeterManager";
import { TenantTable } from "@/components/TenantTable";

export default async function TenantsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const [{ data: tenants, error: tenantsError }, { data: meters, error: metersError }] =
    await Promise.all([
      supabase
        .from("tenants")
        .select("*")
        .eq("microgrid_id", id)
        .order("name")
        .returns<Tenant[]>(),
      supabase
        .from("meters")
        .select("*")
        .eq("microgrid_id", id)
        .order("name")
        .returns<Meter[]>(),
    ]);

  if (tenantsError || metersError) {
    return (
      <div className="rounded-md bg-red-50 p-4 text-sm text-red-700">
        Error loading data: {tenantsError?.message ?? metersError?.message}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <MeterManager
        microgridId={id}
        meters={meters ?? []}
        tenants={tenants ?? []}
      />
      <TenantTable
        microgridId={id}
        tenants={tenants ?? []}
        meters={meters ?? []}
      />
    </div>
  );
}
