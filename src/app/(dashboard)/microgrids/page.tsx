import { createClient } from "@/lib/supabase/server";
import type { Microgrid } from "@/lib/types/domain";
import { MICROGRID_PUBLIC_COLUMNS } from "@/lib/types/microgrid-columns";
import { HierarchyNav } from "@/components/ui/hierarchy-nav";
import { getHierarchyLevels } from "@/lib/hierarchy";
import { AddEntityButton } from "@/components/forms/AddEntityButton";
import type { CommunityOption } from "@/components/forms/AddEntityButton";

type MicrogridWithHouseholdCount = Omit<
  Microgrid,
  "ems_aws_secret_access_key_encrypted"
> & {
  household_count: number;
};

type CommunityWithOrgRow = {
  id: string;
  name: string;
  org_id: string;
  organizations: { name: string };
};

export default async function MicrogridsPage({
  searchParams,
}: {
  searchParams: Promise<{ community?: string; org?: string }>;
}) {
  const { community: communityId, org: orgId } = await searchParams;
  const supabase = await createClient();

  // Fetch accessible communities for nav + add-button picker.
  // RLS scopes this naturally — only communities the user can access are returned.
  const communitiesResult = await supabase
    .from("communities")
    .select("id, name, org_id, organizations!inner(name)")
    .order("name")
    .returns<CommunityWithOrgRow[]>();

  const allAccessibleCommunities: CommunityOption[] = (
    communitiesResult.data ?? []
  ).map((c) => ({
    id: c.id,
    name: c.name,
    org_name: c.organizations.name,
  }));

  // Validate the ?org= param.
  const accessibleOrgIds = new Set(
    (communitiesResult.data ?? []).map((c) => c.org_id),
  );
  const orgValid = orgId != null && accessibleOrgIds.has(orgId);
  const orgInvalid = orgId != null && !orgValid;

  // When ?org=X valid, narrow the community picker to that org's communities.
  const accessibleCommunities: CommunityOption[] = orgValid
    ? allAccessibleCommunities.filter((c) => {
        const row = (communitiesResult.data ?? []).find((r) => r.id === c.id);
        return row?.org_id === orgId;
      })
    : allAccessibleCommunities;

  // Resolve breadcrumb levels in parallel with data fetch.
  const [levelsResult, communityResult, microgridsResult] = await Promise.all([
    getHierarchyLevels(supabase, {
      kind: "microgrids",
      communityId,
      orgId: communityId ? undefined : orgId,
    }),
    communityId
      ? supabase
          .from("communities")
          .select("name")
          .eq("id", communityId)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    (() => {
      // Three branches. The org-filtered branch uses an embed (`communities!inner`)
      // so its row shape differs from the other two branches; rather than fight
      // the union type, we narrow `data` to the public columns at the
      // destructure site below.
      if (communityId) {
        // Community filter is narrower — it wins.
        return supabase
          .from("microgrids")
          .select(MICROGRID_PUBLIC_COLUMNS)
          .eq("community_id", communityId);
      }
      if (orgValid) {
        // Org filter: join via communities to filter by org_id.
        // PostgREST syntax: select from the embedded communities resource.
        return supabase
          .from("microgrids")
          .select(`${MICROGRID_PUBLIC_COLUMNS}, communities!inner(org_id)`)
          .eq("communities.org_id", orgId!);
      }
      return supabase.from("microgrids").select(MICROGRID_PUBLIC_COLUMNS);
    })(),
  ]);

  const levels = levelsResult;
  const communityName = communityResult.data?.name ?? null;
  const communityNotFound = communityId != null && !communityResult.data;
  const { data: microgrids, error } = microgridsResult;

  // Banner: both filters present → community wins.
  const bothFiltersBanner =
    communityId && orgValid ? (
      <div className="mb-4 rounded-md bg-warning-muted p-3 text-sm text-warning-fg">
        Community filter applied — org filter ignored.
      </div>
    ) : null;

  // Banner: invalid ?org= param.
  const invalidOrgBanner = orgInvalid ? (
    <div className="mb-4 rounded-md bg-warning-muted p-3 text-sm text-warning-fg">
      Invalid or inaccessible organization filter — showing all.
    </div>
  ) : null;

  // Resolve which AddEntityButton variant to use:
  //   - In a single-community URL context (?community=...) → locked mode
  //   - ?org=X valid + exactly 1 community in that org → locked mode
  //   - ?org=X valid + multiple communities in that org → picker (narrower list)
  //   - Single accessible community → locked mode
  //   - Multiple accessible communities → picker mode
  //   - Zero accessible communities → no button
  const addButton = (() => {
    if (communityId) {
      return (
        <AddEntityButton entity="microgrid" parentCommunityId={communityId} />
      );
    }
    if (orgValid && accessibleCommunities.length === 1) {
      return (
        <AddEntityButton
          entity="microgrid"
          parentCommunityId={accessibleCommunities[0].id}
        />
      );
    }
    if (orgValid && accessibleCommunities.length > 1) {
      return (
        <AddEntityButton
          entity="microgrid"
          availableCommunities={accessibleCommunities}
        />
      );
    }
    if (accessibleCommunities.length === 1) {
      return (
        <AddEntityButton
          entity="microgrid"
          parentCommunityId={accessibleCommunities[0].id}
        />
      );
    }
    if (accessibleCommunities.length > 1) {
      return (
        <AddEntityButton
          entity="microgrid"
          availableCommunities={accessibleCommunities}
        />
      );
    }
    return null;
  })();

  // CTA button for empty state (same logic but with label override).
  const addButtonCta = (() => {
    if (communityId) {
      return (
        <AddEntityButton
          entity="microgrid"
          parentCommunityId={communityId}
          label="+ Add the first Microgrid"
        />
      );
    }
    if (orgValid && accessibleCommunities.length === 1) {
      return (
        <AddEntityButton
          entity="microgrid"
          parentCommunityId={accessibleCommunities[0].id}
          label="+ Add the first Microgrid"
        />
      );
    }
    if (orgValid && accessibleCommunities.length > 1) {
      return (
        <AddEntityButton
          entity="microgrid"
          availableCommunities={accessibleCommunities}
          label="+ Add the first Microgrid"
        />
      );
    }
    if (accessibleCommunities.length === 1) {
      return (
        <AddEntityButton
          entity="microgrid"
          parentCommunityId={accessibleCommunities[0].id}
          label="+ Add the first Microgrid"
        />
      );
    }
    if (accessibleCommunities.length > 1) {
      return (
        <AddEntityButton
          entity="microgrid"
          availableCommunities={accessibleCommunities}
          label="+ Add the first Microgrid"
        />
      );
    }
    return null;
  })();

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
        {bothFiltersBanner}
        {invalidOrgBanner}
        <div className="mb-6 flex items-center justify-between">
          <h1 className="text-2xl font-semibold text-foreground">{heading}</h1>
          {addButton}
        </div>
        <div className="rounded-md border border-border bg-card p-8 text-center">
          {addButtonCta ? (
            <>
              <p className="mb-4 text-muted-foreground">
                No microgrids{communityId ? " in this community" : ""} yet.
              </p>
              {addButtonCta}
            </>
          ) : (
            <p className="text-muted-foreground">
              No microgrids visible. Open a community to add one.
            </p>
          )}
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
      {bothFiltersBanner}
      {invalidOrgBanner}
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-foreground">{heading}</h1>
        {addButton}
      </div>
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
