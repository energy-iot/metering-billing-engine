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

export default async function CommunitiesPage({
  searchParams,
}: {
  searchParams?: Promise<{ org?: string }>;
}) {
  const { org: orgId } = (await searchParams) ?? {};
  const supabase = await createClient();

  const [{ data: accessibleOrgs }, levels] = await Promise.all([
    supabase
      .from("organizations")
      .select("id, name")
      .order("name")
      .returns<OrgRow[]>(),
    getHierarchyLevels(supabase, { kind: "communities", orgId }),
  ]);

  const orgs = accessibleOrgs ?? [];

  // Validate the ?org= param: must be a UUID the user can actually access.
  const orgValid =
    orgId != null && orgs.some((o) => o.id === orgId);
  const orgInvalid = orgId != null && !orgValid;

  // Build the communities query — apply org filter when valid.
  const communitiesQuery = (() => {
    let q = supabase
      .from("communities")
      .select("*, microgrids(count)")
      .order("name");
    if (orgValid) {
      q = q.eq("org_id", orgId!);
    }
    return q.returns<CommunityRow[]>();
  })();

  const { data: communities, error } = await communitiesQuery;

  // Resolve AddEntityButton variant:
  //   - ?org=X valid → locked mode with that org (even in multi-org context)
  //   - single accessible org (no filter) → locked mode
  //   - multiple accessible orgs (no filter) → picker mode
  //   - zero accessible orgs → no button
  const addButton = (() => {
    if (orgValid) {
      return <AddEntityButton entity="community" parentOrgId={orgId!} />;
    }
    if (orgs.length === 1) {
      return <AddEntityButton entity="community" parentOrgId={orgs[0].id} />;
    }
    if (orgs.length > 1) {
      return <AddEntityButton entity="community" availableOrgs={orgs} />;
    }
    return null;
  })();

  const invalidBanner = orgInvalid ? (
    <div className="mb-4 rounded-md bg-warning-muted p-3 text-sm text-warning-fg">
      Invalid or inaccessible organization filter — showing all.
    </div>
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
        {invalidBanner}
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
              {orgValid ? (
                <AddEntityButton
                  entity="community"
                  parentOrgId={orgId!}
                  label="+ Add the first Community"
                />
              ) : orgs.length === 1 ? (
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
      {invalidBanner}
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
