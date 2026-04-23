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
      <div className="rounded-md bg-destructive-muted p-4 text-sm text-destructive-fg">
        Error loading organizations: {orgError.message}
      </div>
    );
  }

  if (!organizations || organizations.length === 0) {
    return (
      <div>
        <h1 className="mb-6 text-2xl font-semibold text-foreground">
          Dashboard
        </h1>
        <div className="rounded-md border border-border bg-card p-8 text-center text-muted-foreground">
          No organizations found. You may need to run the database migrations
          and seed data, or your account may not have the required permissions.
        </div>
      </div>
    );
  }

  return (
    <div>
      <h1 className="mb-6 text-2xl font-semibold text-foreground">Dashboard</h1>
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
    <div className="rounded-lg border border-border bg-card p-6">
      <h2 className="mb-4 text-lg font-semibold text-foreground">{org.name}</h2>
      {microgridsWithCounts.length === 0 ? (
        <p className="text-sm text-muted-foreground">No microgrids configured.</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {microgridsWithCounts.map((mg) => (
            <div
              key={mg.id}
              className="rounded-md border border-border bg-muted p-4"
            >
              <h3 className="font-medium text-foreground">{mg.name}</h3>
              {mg.location && (
                <p className="mt-1 text-sm text-muted-foreground">{mg.location}</p>
              )}
              <div className="mt-3 flex items-center justify-between text-sm">
                <span className="text-muted-foreground">
                  {mg.tenant_count} tenant{mg.tenant_count !== 1 ? "s" : ""}
                </span>
                <span className="text-muted-foreground">{mg.currency}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
