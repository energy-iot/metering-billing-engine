import { createClient } from "@/lib/supabase/server";
import type { Microgrid } from "@/lib/types/domain";
import { HierarchyNav } from "@/components/ui/hierarchy-nav";
import { getHierarchyLevels } from "@/lib/hierarchy";

type MicrogridWithHouseholdCount = Microgrid & {
  household_count: number;
};

export default async function MicrogridsPage({
  searchParams,
}: {
  searchParams: Promise<{ community?: string }>;
}) {
  const { community: communityId } = await searchParams;
  const supabase = await createClient();

  // Resolve breadcrumb levels in parallel with data fetch.
  const [levelsResult, communityResult, microgridsResult] = await Promise.all([
    getHierarchyLevels(supabase, {
      kind: "microgrids",
      communityId,
    }),
    communityId
      ? supabase
          .from("communities")
          .select("name")
          .eq("id", communityId)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    (() => {
      let query = supabase.from("microgrids").select("*");
      if (communityId) query = query.eq("community_id", communityId);
      return query.returns<Microgrid[]>();
    })(),
  ]);

  const levels = levelsResult;
  const communityName = communityResult.data?.name ?? null;
  const communityNotFound = communityId != null && !communityResult.data;
  const { data: microgrids, error } = microgridsResult;

  const heading = communityName
    ? `${communityName} · Microgrids`
    : "Microgrids";

  if (error) {
    return (
      <div className="rounded-md bg-destructive-muted p-4 text-sm text-destructive-fg">
        Error loading microgrids: {error.message}
      </div>
    );
  }

  if (communityNotFound) {
    return (
      <div>
        <HierarchyNav levels={levels} className="mb-4" />
        <h1 className="mb-6 text-2xl font-semibold text-foreground">
          Microgrids
        </h1>
        <div className="rounded-md border border-border bg-card p-8 text-center text-muted-foreground">
          Community not found or not accessible.
        </div>
      </div>
    );
  }

  if (!microgrids || microgrids.length === 0) {
    return (
      <div>
        <HierarchyNav levels={levels} className="mb-4" />
        <h1 className="mb-6 text-2xl font-semibold text-foreground">
          {heading}
        </h1>
        <div className="rounded-md border border-border bg-card p-8 text-center text-muted-foreground">
          No microgrids found. Microgrids are configured by your system
          administrator.
        </div>
      </div>
    );
  }

  const microgridsWithCounts: MicrogridWithHouseholdCount[] = [];
  for (const mg of microgrids) {
    const { count } = await supabase
      .from("households")
      .select("*", { count: "exact", head: true })
      .eq("microgrid_id", mg.id);

    microgridsWithCounts.push({
      ...mg,
      household_count: count ?? 0,
    });
  }

  return (
    <div>
      <HierarchyNav levels={levels} className="mb-4" />
      <h1 className="mb-6 text-2xl font-semibold text-foreground">{heading}</h1>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {microgridsWithCounts.map((mg) => {
          const locationParts = [mg.address_city, mg.address_country].filter(Boolean);
          const locationLabel = locationParts.length > 0 ? locationParts.join(", ") : null;

          return (
            <a
              key={mg.id}
              href={`/microgrids/${mg.id}`}
              className="block rounded-lg border border-border bg-card p-6 transition-colors hover:border-border hover:bg-muted"
            >
              <h2 className="font-medium text-foreground">{mg.name}</h2>
              {locationLabel && (
                <p className="mt-1 text-sm text-muted-foreground">{locationLabel}</p>
              )}
              <div className="mt-3 flex items-center justify-between text-sm">
                <span className="text-muted-foreground">
                  {mg.household_count} household{mg.household_count !== 1 ? "s" : ""}
                </span>
                <span className="text-muted-foreground">{mg.currency}</span>
              </div>
            </a>
          );
        })}
      </div>
    </div>
  );
}
