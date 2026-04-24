import { notFound } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { HierarchyNav } from "@/components/ui/hierarchy-nav";
import { getHierarchyLevels } from "@/lib/hierarchy";
import { EditEntityButton } from "@/components/forms/EditEntityButton";
import { DeleteEntityButton } from "@/components/forms/DeleteEntityButton";
import { DeletedSuccessBanner } from "@/components/entity-deletion/DeletedSuccessBanner";
import { currentUserCanAccessCommunity } from "@/lib/auth/access";
import { EmptyState } from "@/components/ui/empty-state";
import { AddEntityButton } from "@/components/forms/AddEntityButton";
import type { Community } from "@/lib/types/domain";

/**
 * /communities/[id] — community detail page (#87).
 *
 * Shows community address/geography info, aggregated stats (microgrid count,
 * household count, device count) and a list of its microgrids. The Edit button
 * in the header is shown only when `currentUserCanAccessCommunity` resolves
 * truthy — explicit check, not RLS-implicit.
 */

type MicrogridRow = {
  id: string;
  name: string;
  address_city: string | null;
  households: { count: number }[];
  devices: { count: number }[];
};

type CommunityWithMicrogrids = Community & {
  microgrids: MicrogridRow[];
};

function emDash(value: string | null | undefined): string {
  return value && value.trim() !== "" ? value : "—";
}

export default async function CommunityDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const sp = searchParams ? await searchParams : undefined;
  const supabase = await createClient();

  const [{ data: community }, canEdit, levels] = await Promise.all([
    supabase
      .from("communities")
      .select(
        `*, microgrids(id, name, address_city, households(count), devices:edges(devices(count)))`
      )
      .eq("id", id)
      .single<CommunityWithMicrogrids>(),
    currentUserCanAccessCommunity(supabase, id),
    getHierarchyLevels(supabase, { kind: "community", communityId: id }),
  ]);

  if (!community) {
    notFound();
  }

  const microgrids = community.microgrids ?? [];
  const microgridCount = microgrids.length;

  const householdCount = microgrids.reduce((sum, mg) => {
    const c = mg.households?.[0]?.count ?? 0;
    return sum + c;
  }, 0);

  const deviceCount = microgrids.reduce((sum, mg) => {
    const c = mg.devices?.[0]?.count ?? 0;
    return sum + c;
  }, 0);

  return (
    <div>
      <DeletedSuccessBanner searchParams={sp} />
      <HierarchyNav levels={levels} className="mb-4 mt-4" />

      {/* Page header */}
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">
            {community.name}
          </h1>
          {(community.address_city || community.address_country) && (
            <p className="mt-1 text-sm text-muted-foreground">
              {[community.address_city, community.address_country]
                .filter(Boolean)
                .join(", ")}
            </p>
          )}
        </div>
        {canEdit && (
          <div className="flex items-center gap-2">
            <EditEntityButton entity="community" initialValues={community} />
            <DeleteEntityButton
              entity="community"
              id={community.id}
              name={community.name}
            />
          </div>
        )}
      </div>

      {/* Stats strip */}
      <div className="mb-6 grid grid-cols-3 gap-4 rounded-lg border border-border bg-card p-4">
        <div className="text-center">
          <div className="text-2xl font-semibold text-foreground">
            {microgridCount}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            Microgrid{microgridCount !== 1 ? "s" : ""}
          </div>
        </div>
        <div className="text-center">
          <div className="text-2xl font-semibold text-foreground">
            {householdCount}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            Household{householdCount !== 1 ? "s" : ""}
          </div>
        </div>
        <div className="text-center">
          <div className="text-2xl font-semibold text-foreground">
            {deviceCount}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            Device{deviceCount !== 1 ? "s" : ""}
          </div>
        </div>
      </div>

      {/* Community details */}
      <section className="mb-6 rounded-lg border border-border bg-card p-6">
        <h2 className="mb-3 text-lg font-semibold text-foreground">Details</h2>
        <dl className="space-y-2 text-sm">
          {community.address_line1 !== undefined && (
            <div className="flex gap-4">
              <dt className="w-32 text-muted-foreground">Address</dt>
              <dd className="text-foreground">
                {emDash(community.address_line1)}
              </dd>
            </div>
          )}
          {community.address_line2 !== undefined && (
            <div className="flex gap-4">
              <dt className="w-32 text-muted-foreground">Address line 2</dt>
              <dd className="text-foreground">
                {emDash(community.address_line2)}
              </dd>
            </div>
          )}
          <div className="flex gap-4">
            <dt className="w-32 text-muted-foreground">City</dt>
            <dd className="text-foreground">{emDash(community.address_city)}</dd>
          </div>
          <div className="flex gap-4">
            <dt className="w-32 text-muted-foreground">Region</dt>
            <dd className="text-foreground">
              {emDash(community.address_region)}
            </dd>
          </div>
          <div className="flex gap-4">
            <dt className="w-32 text-muted-foreground">Country</dt>
            <dd className="text-foreground">
              {emDash(community.address_country)}
            </dd>
          </div>
          {community.geography_notes !== undefined && (
            <div className="flex gap-4">
              <dt className="w-32 text-muted-foreground">Geography notes</dt>
              <dd className="text-foreground">
                {emDash(community.geography_notes)}
              </dd>
            </div>
          )}
        </dl>
      </section>

      {/* Microgrids listing */}
      <section className="rounded-lg border border-border bg-card p-6">
        <h2 className="mb-3 text-lg font-semibold text-foreground">
          Microgrids in this community
        </h2>
        {microgrids.length === 0 ? (
          <EmptyState
            eyebrow="Microgrids"
            title="Add the first microgrid"
            body={
              <>
                A microgrid is the physical installation that meters and bills
                electricity in this community. Most start with one.
              </>
            }
            cta={
              canEdit ? (
                <AddEntityButton
                  entity="microgrid"
                  parentCommunityId={community.id}
                />
              ) : undefined
            }
            footnote={
              !canEdit
                ? "Ask a super admin to add the first microgrid."
                : undefined
            }
          />
        ) : (
          <ul className="space-y-1">
            {microgrids.map((mg) => (
              <li key={mg.id}>
                <Link
                  href={`/microgrids/${mg.id}`}
                  className="text-sm text-foreground hover:underline"
                >
                  {mg.name}
                </Link>
                {mg.address_city && (
                  <span className="ml-2 text-xs text-muted-foreground">
                    {mg.address_city}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        <div className="mt-4 border-t border-border pt-4">
          <Link
            href={`/microgrids?community=${community.id}`}
            className="text-sm text-foreground hover:underline"
          >
            View microgrids &rarr;
          </Link>
        </div>
      </section>
    </div>
  );
}
