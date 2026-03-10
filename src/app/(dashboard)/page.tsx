import { createClient } from "@/lib/supabase/server";
import type { Organization } from "@/lib/types/database";

type MicrogridWithTenantCount = {
  id: string;
  name: string;
  location: string | null;
  currency: string;
  tenant_count: number;
};

export default async function DashboardPage() {
  const supabase = await createClient();

  const { data: organizations, error: orgError } = await supabase
    .from("organizations")
    .select("*")
    .returns<Organization[]>();

  if (orgError) {
    return (
      <div className="rounded-md bg-red-50 p-4 text-sm text-red-700">
        Error loading organizations: {orgError.message}
      </div>
    );
  }

  if (!organizations || organizations.length === 0) {
    return (
      <div>
        <h1 className="mb-6 text-2xl font-semibold text-gray-900">
          Dashboard
        </h1>
        <div className="rounded-md border border-gray-200 bg-white p-8 text-center text-gray-500">
          No organizations found. You may need to run the database migrations
          and seed data, or your account may not have the required permissions.
        </div>
      </div>
    );
  }

  return (
    <div>
      <h1 className="mb-6 text-2xl font-semibold text-gray-900">Dashboard</h1>
      <div className="space-y-6">
        {organizations.map((org) => (
          <OrgCard key={org.id} org={org} />
        ))}
      </div>
    </div>
  );
}

async function OrgCard({ org }: { org: Organization }) {
  const supabase = await createClient();

  // Fetch microgrids for this org
  const { data: microgrids } = await supabase
    .from("microgrids")
    .select("id, name, location, currency")
    .eq("org_id", org.id);

  // For each microgrid, get tenant count
  const microgridsWithCounts: MicrogridWithTenantCount[] = [];
  if (microgrids) {
    for (const mg of microgrids) {
      const { count } = await supabase
        .from("tenants")
        .select("*", { count: "exact", head: true })
        .eq("microgrid_id", mg.id);

      microgridsWithCounts.push({
        ...mg,
        tenant_count: count ?? 0,
      });
    }
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-6">
      <h2 className="mb-4 text-lg font-semibold text-gray-900">{org.name}</h2>
      {microgridsWithCounts.length === 0 ? (
        <p className="text-sm text-gray-500">No microgrids configured.</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {microgridsWithCounts.map((mg) => (
            <div
              key={mg.id}
              className="rounded-md border border-gray-100 bg-gray-50 p-4"
            >
              <h3 className="font-medium text-gray-900">{mg.name}</h3>
              {mg.location && (
                <p className="mt-1 text-sm text-gray-500">{mg.location}</p>
              )}
              <div className="mt-3 flex items-center justify-between text-sm">
                <span className="text-gray-600">
                  {mg.tenant_count} tenant{mg.tenant_count !== 1 ? "s" : ""}
                </span>
                <span className="text-gray-400">{mg.currency}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
