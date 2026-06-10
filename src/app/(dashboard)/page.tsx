import { createClient } from "@/lib/supabase/server";
import type { Organization, Microgrid } from "@/lib/types/domain";

type MicrogridWithHouseholdCount = {
  id: string;
  name: string;
  address_city: string | null;
  address_country: string | null;
  currency: string;
  household_count: number;
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

export async function OrgCard({ org }: { org: Organization }) {
  const supabase = await createClient();

  // Fetch microgrids for this org (via communities join)
  const { data: microgrids } = await supabase
    .from("microgrids")
    .select("id, name, address_city, address_country, currency, community_id, communities!inner(org_id)")
    .eq("communities.org_id", org.id);

  // For each microgrid, get household count
  const microgridsWithCounts: MicrogridWithHouseholdCount[] = [];
  if (microgrids) {
    for (const mg of microgrids as unknown as Microgrid[]) {
      const { count } = await supabase
        .from("households")
        .select("*", { count: "exact", head: true })
        .eq("microgrid_id", mg.id);

      microgridsWithCounts.push({
        id: mg.id,
        name: mg.name,
        address_city: mg.address_city,
        address_country: mg.address_country,
        currency: mg.currency,
        household_count: count ?? 0,
      });
    }
  }

  const locationLabel = (mg: MicrogridWithHouseholdCount) => {
    const parts = [mg.address_city, mg.address_country].filter(Boolean);
    return parts.length > 0 ? parts.join(", ") : null;
  };

  return (
    <div className="rounded-lg border border-border bg-card p-6">
      <h2 className="mb-4 text-lg font-semibold text-foreground">{org.name}</h2>
      {microgridsWithCounts.length === 0 ? (
        <p className="text-sm text-muted-foreground">No microgrids configured.</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {microgridsWithCounts.map((mg) => (
            <a
              key={mg.id}
              href={`/microgrids/${mg.id}`}
              className="block rounded-md border border-border bg-muted p-4 transition-colors hover:bg-card hover:border-border focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              <h3 className="font-medium text-foreground">{mg.name}</h3>
              {locationLabel(mg) && (
                <p className="mt-1 text-sm text-muted-foreground">
                  {locationLabel(mg)}
                </p>
              )}
              <div className="mt-3 flex items-center justify-between text-sm">
                <span className="text-muted-foreground">
                  {mg.household_count} household{mg.household_count !== 1 ? "s" : ""}
                </span>
                <span className="text-muted-foreground">{mg.currency}</span>
              </div>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
