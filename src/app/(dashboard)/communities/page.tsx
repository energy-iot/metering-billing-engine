import Link from "next/link";
import { createClient } from "@/lib/supabase/server";

type CommunityRow = {
  id: string;
  name: string;
  address_city: string | null;
  address_country: string | null;
  microgrids: { count: number }[];
};

export default async function CommunitiesPage() {
  const supabase = await createClient();

  const { data: communities, error } = await supabase
    .from("communities")
    .select("id, name, address_city, address_country, microgrids(count)")
    .order("name")
    .returns<CommunityRow[]>();

  if (error) {
    return (
      <div className="rounded-md bg-destructive-muted p-4 text-sm text-destructive-fg">
        Error loading communities: {error.message}
      </div>
    );
  }

  if (!communities || communities.length === 0) {
    return (
      <div>
        <h1 className="mb-6 text-2xl font-semibold text-foreground">
          Communities
        </h1>
        <div className="rounded-md border border-border bg-card p-8 text-center text-muted-foreground">
          No communities found. Communities are configured by your system
          administrator.
        </div>
      </div>
    );
  }

  return (
    <div>
      <h1 className="mb-6 text-2xl font-semibold text-foreground">
        Communities
      </h1>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {communities.map((community) => {
          const locationParts = [
            community.address_city,
            community.address_country,
          ].filter(Boolean);
          const locationLabel =
            locationParts.length > 0 ? locationParts.join(", ") : null;

          const microgridCount =
            community.microgrids.length > 0
              ? (community.microgrids[0].count ?? 0)
              : 0;

          return (
            <Link
              key={community.id}
              href={`/microgrids?community=${community.id}`}
              className="block rounded-lg border border-border bg-card p-6 transition-colors hover:border-border hover:bg-muted"
            >
              <h2 className="font-medium text-foreground">{community.name}</h2>
              {locationLabel && (
                <p className="mt-1 text-sm text-muted-foreground">
                  {locationLabel}
                </p>
              )}
              <div className="mt-3 text-sm text-muted-foreground">
                {microgridCount} microgrid{microgridCount !== 1 ? "s" : ""}
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
