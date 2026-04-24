import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { HierarchyNav } from "@/components/ui/hierarchy-nav";
import { getHierarchyLevels } from "@/lib/hierarchy";
import { AddEntityButton } from "@/components/forms/AddEntityButton";
import type { Community } from "@/lib/types/domain";

type CommunityRow = Community & {
  microgrids: { count: number }[];
};

type OrgRow = { id: string; name: string };

export default async function CommunitiesPage() {
  const supabase = await createClient();

  const [{ data: communities, error }, { data: accessibleOrgs }, levels] =
    await Promise.all([
      supabase
        .from("communities")
        .select("*, microgrids(count)")
        .order("name")
        .returns<CommunityRow[]>(),
      supabase
        .from("organizations")
        .select("id, name")
        .order("name")
        .returns<OrgRow[]>(),
      getHierarchyLevels(supabase, { kind: "communities" }),
    ]);

  // Resolve which AddEntityButton variant to use:
  //   - Single accessible org → locked mode (parentOrgId)
  //   - Multiple accessible orgs → picker mode (availableOrgs)
  //   - Zero accessible orgs → no button
  const orgs = accessibleOrgs ?? [];
  const addButton =
    orgs.length === 1 ? (
      <AddEntityButton entity="community" parentOrgId={orgs[0].id} />
    ) : orgs.length > 1 ? (
      <AddEntityButton entity="community" availableOrgs={orgs} />
    ) : null;

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
        <HierarchyNav levels={levels} className="mb-4" />
        <div className="mb-6 flex items-center justify-between">
          <h1 className="text-2xl font-semibold text-foreground">
            Communities
          </h1>
        </div>
        <div className="rounded-md border border-border bg-card p-8 text-center">
          {addButton ? (
            <>
              <p className="mb-4 text-muted-foreground">
                No communities yet.
              </p>
              {orgs.length === 1 ? (
                <AddEntityButton
                  entity="community"
                  parentOrgId={orgs[0].id}
                  label="+ Add the first Community"
                />
              ) : (
                <AddEntityButton
                  entity="community"
                  availableOrgs={orgs}
                  label="+ Add the first Community"
                />
              )}
            </>
          ) : (
            <p className="text-muted-foreground">
              No communities visible. Add one from the organization detail page.
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div>
      <HierarchyNav levels={levels} className="mb-4" />
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-foreground">Communities</h1>
        {addButton}
      </div>
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
              href={`/communities/${community.id}`}
              className="flex flex-col rounded-lg border border-border bg-card p-6 transition-colors hover:border-border"
            >
              <h2 className="font-medium text-foreground">
                {community.name}
              </h2>
              {locationLabel && (
                <p className="mt-1 text-sm text-muted-foreground">
                  {locationLabel}
                </p>
              )}
              <div className="mt-3 text-sm text-muted-foreground">
                {microgridCount} microgrid
                {microgridCount !== 1 ? "s" : ""}
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
