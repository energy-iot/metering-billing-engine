/**
 * hierarchy.ts — shared helper for HierarchyNav data fetching.
 *
 * All dashboard routes that render a breadcrumb call `getHierarchyLevels()`
 * instead of writing their own Supabase queries. This keeps level-assembly
 * logic in one place and prevents drift across routes.
 *
 * RLS scoping is automatic: the Supabase JS client inherits the authenticated
 * user's session, so `count: 'exact'` returns only rows the user can see.
 *
 * D4 sole-placer invariant: only layout/page files listed in the ticket's
 * route → levels map may import this helper. Do not add inline HierarchyNav
 * placements outside of the D4 layout pattern.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { HierarchyLevel } from "@/components/ui/hierarchy-nav";

export type HierarchyScope =
  | { kind: "communities"; orgId?: string }
  | { kind: "community"; communityId: string }
  | { kind: "microgrids"; communityId?: string; orgId?: string }
  | { kind: "microgrid"; microgridId: string }
  | { kind: "edge"; microgridId: string; edgeId: string }
  | { kind: "edges-listing"; microgridId: string }
  | { kind: "household"; microgridId: string; householdId: string }
  | { kind: "households-listing"; microgridId: string };

type SiblingRow = { id: string; name: string | null };

// ── Internal fetch helpers ─────────────────────────────────────────────────────

/** Fetch the single accessible org + sibling orgs for a switcher.
 *
 * @param currentOrgId  — org to highlight as "current" in the nav label.
 *                        Falls back to first-alphabetical if not found.
 * @param currentListingPath — when set, sibling href becomes
 *                        `${currentListingPath}?org=<id>` instead of `/?org=<id>`.
 *                        Pass this from listing pages so the switcher stays on
 *                        the current listing rather than navigating to the dashboard.
 */
async function fetchOrgLevel(
  supabase: SupabaseClient,
  currentOrgId?: string,
  currentListingPath?: string,
): Promise<HierarchyLevel> {
  const { data: orgs } = await supabase
    .from("organizations")
    .select("id, name")
    .order("name")
    .returns<SiblingRow[]>();

  const orgList = orgs ?? [];

  if (orgList.length === 0) {
    return {
      kind: "Organization",
      label: "No organizations",
      count: 0,
      href: "/",
      active: false,
    };
  }

  // Resolve the "current" org only when a valid ID was provided.
  const current = currentOrgId
    ? orgList.find((o) => o.id === currentOrgId)
    : undefined;

  const siblingHref = (id: string) =>
    currentListingPath ? `${currentListingPath}?org=${id}` : `/?org=${id}`;

  // Org-level href: when on a listing page, the current-org link should stay
  // on the listing (without a filter) so the user can navigate "up" to all orgs.
  const orgHref = currentListingPath ?? "/";

  // No currentOrgId (or invalid ID) with multiple accessible orgs:
  // show a neutral "All organizations" label so the nav doesn't falsely imply
  // a filter is in effect.
  if (!current && orgList.length > 1) {
    return {
      kind: "Organization",
      label: "All organizations",
      count: orgList.length,
      href: orgHref,
      active: false,
      siblings: orgList.map((o) => ({
        label: o.name ?? o.id,
        href: siblingHref(o.id),
      })),
    };
  }

  // Single-org (no filter needed) or a matched currentOrgId.
  const resolved = current ?? orgList[0];

  return {
    kind: "Organization",
    label: resolved?.name ?? "Organization",
    count: orgList.length,
    href: orgHref,
    active: false,
    siblings:
      orgList.length > 1
        ? orgList
            .filter((o) => o.id !== resolved?.id)
            .map((o) => ({ label: o.name ?? o.id, href: siblingHref(o.id) }))
        : undefined,
  };
}

/** Fetch the community level given a community id. */
async function fetchCommunityLevel(
  supabase: SupabaseClient,
  communityId: string,
  active: boolean,
): Promise<HierarchyLevel | null> {
  const { data: community } = await supabase
    .from("communities")
    .select("id, name, org_id")
    .eq("id", communityId)
    .single<{ id: string; name: string; org_id: string }>();

  if (!community) return null;

  // Count sibling communities in the same org.
  const { data: siblings } = await supabase
    .from("communities")
    .select("id, name")
    .eq("org_id", community.org_id)
    .order("name")
    .returns<SiblingRow[]>();

  const siblingList = siblings ?? [];
  const count = siblingList.length;

  return {
    kind: "Community",
    label: community.name,
    count,
    href: `/communities/${community.id}`,
    active,
    siblings:
      count > 1
        ? siblingList
            .filter((c) => c.id !== community.id)
            .map((c) => ({
              label: c.name ?? c.id,
              href: `/communities/${c.id}`,
            }))
        : undefined,
  };
}

/** Fetch the microgrid level given a microgrid id. */
async function fetchMicrogridLevel(
  supabase: SupabaseClient,
  microgridId: string,
  active: boolean,
): Promise<{ level: HierarchyLevel | null; communityId: string | null; orgId: string | null }> {
  const { data: microgrid } = await supabase
    .from("microgrids")
    .select("id, name, community_id")
    .eq("id", microgridId)
    .single<{ id: string; name: string; community_id: string }>();

  if (!microgrid) return { level: null, communityId: null, orgId: null };

  // Sibling microgrids in the same community.
  const { data: siblings } = await supabase
    .from("microgrids")
    .select("id, name")
    .eq("community_id", microgrid.community_id)
    .order("name")
    .returns<SiblingRow[]>();

  const siblingList = siblings ?? [];
  const count = siblingList.length;

  const level: HierarchyLevel = {
    kind: "Microgrid",
    label: microgrid.name,
    count,
    href: `/microgrids/${microgridId}`,
    active,
    siblings:
      count > 1
        ? siblingList
            .filter((s) => s.id !== microgridId)
            .map((s) => ({ label: s.name ?? s.id, href: `/microgrids/${s.id}` }))
        : undefined,
  };

  // Resolve community → org chain for ancestor levels.
  const { data: community } = await supabase
    .from("communities")
    .select("id, org_id")
    .eq("id", microgrid.community_id)
    .single<{ id: string; org_id: string }>();

  return {
    level,
    communityId: microgrid.community_id,
    orgId: community?.org_id ?? null,
  };
}

/** Fetch the edge level given an edge id. */
async function fetchEdgeLevel(
  supabase: SupabaseClient,
  edgeId: string,
  microgridId: string,
  active: boolean,
): Promise<HierarchyLevel | null> {
  const { data: edge } = await supabase
    .from("edges")
    .select("id, name")
    .eq("id", edgeId)
    .eq("microgrid_id", microgridId)
    .single<{ id: string; name: string }>();

  if (!edge) return null;

  // Count sibling edges for this microgrid.
  const { data: siblings } = await supabase
    .from("edges")
    .select("id, name")
    .eq("microgrid_id", microgridId)
    .order("name")
    .returns<SiblingRow[]>();

  const siblingList = siblings ?? [];
  const count = siblingList.length;

  return {
    kind: "Edge",
    label: edge.name,
    count,
    href: `/microgrids/${microgridId}/setup/edges/${edgeId}`,
    active,
    siblings:
      count > 1
        ? siblingList
            .filter((s) => s.id !== edgeId)
            .map((s) => ({
              label: s.name ?? s.id,
              href: `/microgrids/${microgridId}/setup/edges/${s.id}`,
            }))
        : undefined,
  };
}

/** Fetch the household level given a household id. */
async function fetchHouseholdLevel(
  supabase: SupabaseClient,
  householdId: string,
  microgridId: string,
  active: boolean,
): Promise<HierarchyLevel | null> {
  const { data: household } = await supabase
    .from("households")
    .select("id, display_name")
    .eq("id", householdId)
    .eq("microgrid_id", microgridId)
    .single<{ id: string; display_name: string }>();

  if (!household) return null;

  // Count sibling households for this microgrid.
  const { data: siblings } = await supabase
    .from("households")
    .select("id, display_name")
    .eq("microgrid_id", microgridId)
    .order("display_name")
    .returns<{ id: string; display_name: string }[]>();

  const siblingList = siblings ?? [];
  const count = siblingList.length;

  return {
    kind: "Household",
    label: household.display_name,
    count,
    href: `/microgrids/${microgridId}/setup/households/${householdId}`,
    active,
    siblings:
      count > 1
        ? siblingList
            .filter((s) => s.id !== householdId)
            .map((s) => ({
              label: s.display_name,
              href: `/microgrids/${microgridId}/setup/households/${s.id}`,
            }))
        : undefined,
  };
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * getHierarchyLevels — return a `HierarchyLevel[]` array for HierarchyNav.
 *
 * Scope determines how deep the breadcrumb reaches:
 *   - 'communities'       → [Organization] active
 *   - 'community'         → [Organization, Community(active=true)]
 *   - 'microgrids'        → [Organization, Community (if communityId)] active
 *   - 'microgrid'         → [Organization, Community, Microgrid] active
 *   - 'edge'              → [Organization, Community, Microgrid, Edge] active
 *   - 'edges-listing'     → [Organization, Community, Microgrid, Edges(synthetic)] active
 *   - 'household'         → [Organization, Community, Microgrid, Household] active
 *   - 'households-listing'→ [Organization, Community, Microgrid, Households(synthetic)] active
 *
 * Counts are RLS-scoped (Supabase honors the user's session automatically).
 * Siblings are populated only when `count > 1`.
 * Empty states: 0-org / 0-community / 0-microgrid cases return truncated arrays.
 */
export async function getHierarchyLevels(
  supabase: SupabaseClient,
  scope: HierarchyScope,
): Promise<HierarchyLevel[]> {
  switch (scope.kind) {
    case "communities": {
      const orgLevel = await fetchOrgLevel(supabase, scope.orgId, "/communities");
      return [orgLevel];
    }

    case "community": {
      // 2-level: Org → Community(active=true).
      const communityLevel = await fetchCommunityLevel(supabase, scope.communityId, true);
      if (!communityLevel) {
        const orgLevel = await fetchOrgLevel(supabase);
        return [orgLevel];
      }

      // Resolve org_id from the community row to anchor the org level.
      const { data: communityRow } = await supabase
        .from("communities")
        .select("org_id")
        .eq("id", scope.communityId)
        .single<{ org_id: string }>();

      const orgLevel = await fetchOrgLevel(supabase, communityRow?.org_id);
      if (orgLevel.count === 0) return [orgLevel];
      return [orgLevel, communityLevel];
    }

    case "microgrids": {
      let resolvedOrgId: string | undefined = scope.orgId;
      let communityLevel: HierarchyLevel | undefined;

      if (scope.communityId) {
        // Resolve community → org chain (community-scoped view takes precedence).
        const { data: community } = await supabase
          .from("communities")
          .select("id, name, org_id")
          .eq("id", scope.communityId)
          .single<{ id: string; name: string; org_id: string }>();

        resolvedOrgId = community?.org_id;

        const cl = await fetchCommunityLevel(supabase, scope.communityId, false);
        if (cl) communityLevel = cl;
      }

      const orgLevel = await fetchOrgLevel(supabase, resolvedOrgId, "/microgrids");

      // Empty-state: 0 orgs — return just org placeholder.
      if (orgLevel.count === 0) return [orgLevel];

      if (communityLevel) {
        return [orgLevel, communityLevel];
      }

      return [orgLevel];
    }

    case "microgrid": {
      const { level: microgridLevel, communityId, orgId } =
        await fetchMicrogridLevel(supabase, scope.microgridId, true);

      if (!microgridLevel || !communityId) {
        // Microgrid not found — return org only.
        const orgLevel = await fetchOrgLevel(supabase);
        return [orgLevel];
      }

      const [orgLevel, communityLevel] = await Promise.all([
        fetchOrgLevel(supabase, orgId ?? undefined),
        fetchCommunityLevel(supabase, communityId, false),
      ]);

      const levels: HierarchyLevel[] = [orgLevel];

      // Empty-state: 0 orgs.
      if (orgLevel.count === 0) return levels;

      if (communityLevel) levels.push(communityLevel);
      levels.push(microgridLevel);

      return levels;
    }

    case "edge": {
      const { level: microgridLevel, communityId, orgId } =
        await fetchMicrogridLevel(supabase, scope.microgridId, false);

      if (!microgridLevel || !communityId) {
        const orgLevel = await fetchOrgLevel(supabase);
        return [orgLevel];
      }

      const [orgLevel, communityLevel, edgeLevel] = await Promise.all([
        fetchOrgLevel(supabase, orgId ?? undefined),
        fetchCommunityLevel(supabase, communityId, false),
        fetchEdgeLevel(supabase, scope.edgeId, scope.microgridId, true),
      ]);

      const levels: HierarchyLevel[] = [orgLevel];
      if (orgLevel.count === 0) return levels;
      if (communityLevel) levels.push(communityLevel);
      levels.push(microgridLevel);
      if (edgeLevel) levels.push(edgeLevel);

      return levels;
    }

    case "edges-listing": {
      // 4-level: Org → Community → Microgrid → Edges (synthetic aggregate segment).
      const { level: microgridLevel, communityId, orgId } =
        await fetchMicrogridLevel(supabase, scope.microgridId, false);

      if (!microgridLevel || !communityId) {
        const orgLevel = await fetchOrgLevel(supabase);
        return [orgLevel];
      }

      const [orgLevel, communityLevel] = await Promise.all([
        fetchOrgLevel(supabase, orgId ?? undefined),
        fetchCommunityLevel(supabase, communityId, false),
      ]);

      // Count edges for the synthetic "Edges" segment.
      const { data: edgeRows } = await supabase
        .from("edges")
        .select("id")
        .eq("microgrid_id", scope.microgridId)
        .returns<{ id: string }[]>();
      const edgeCount = (edgeRows ?? []).length;

      const edgesListingLevel: HierarchyLevel = {
        kind: "Edge",
        label: "Edges",
        count: edgeCount,
        href: `/microgrids/${scope.microgridId}/setup/edges`,
        active: true,
      };

      const levels: HierarchyLevel[] = [orgLevel];
      if (orgLevel.count === 0) return levels;
      if (communityLevel) levels.push(communityLevel);
      levels.push(microgridLevel);
      levels.push(edgesListingLevel);

      return levels;
    }

    case "households-listing": {
      // 4-level: Org → Community → Microgrid → Households (synthetic aggregate segment).
      const { level: microgridLevel, communityId, orgId } =
        await fetchMicrogridLevel(supabase, scope.microgridId, false);

      if (!microgridLevel || !communityId) {
        const orgLevel = await fetchOrgLevel(supabase);
        return [orgLevel];
      }

      const [orgLevel, communityLevel] = await Promise.all([
        fetchOrgLevel(supabase, orgId ?? undefined),
        fetchCommunityLevel(supabase, communityId, false),
      ]);

      // Count households for the synthetic "Households" segment.
      const { data: hhRows } = await supabase
        .from("households")
        .select("id")
        .eq("microgrid_id", scope.microgridId)
        .returns<{ id: string }[]>();
      const hhCount = (hhRows ?? []).length;

      const householdsListingLevel: HierarchyLevel = {
        kind: "Household",
        label: "Households",
        count: hhCount,
        href: `/microgrids/${scope.microgridId}/setup/households`,
        active: true,
      };

      const levels: HierarchyLevel[] = [orgLevel];
      if (orgLevel.count === 0) return levels;
      if (communityLevel) levels.push(communityLevel);
      levels.push(microgridLevel);
      levels.push(householdsListingLevel);

      return levels;
    }

    case "household": {
      const { level: microgridLevel, communityId, orgId } =
        await fetchMicrogridLevel(supabase, scope.microgridId, false);

      if (!microgridLevel || !communityId) {
        const orgLevel = await fetchOrgLevel(supabase);
        return [orgLevel];
      }

      const [orgLevel, communityLevel, householdLevel] = await Promise.all([
        fetchOrgLevel(supabase, orgId ?? undefined),
        fetchCommunityLevel(supabase, communityId, false),
        fetchHouseholdLevel(supabase, scope.householdId, scope.microgridId, true),
      ]);

      const levels: HierarchyLevel[] = [orgLevel];
      if (orgLevel.count === 0) return levels;
      if (communityLevel) levels.push(communityLevel);
      levels.push(microgridLevel);
      if (householdLevel) levels.push(householdLevel);

      return levels;
    }
  }
}
