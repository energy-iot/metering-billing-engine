import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { Microgrid } from "@/lib/types/domain";
import { TabNav } from "./tab-nav";
import { HierarchyNav, type HierarchyLevel } from "@/components/ui/hierarchy-nav";
import { LocaleProvider } from "@/components/format/locale-context";

export default async function MicrogridLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("microgrids")
    .select("*")
    .eq("id", id)
    .single();

  if (error || !data) {
    notFound();
  }

  const microgrid = data as Microgrid;

  // Query org count and microgrid count for HierarchyNav
  // Microgrid → community → org chain
  const { data: communityRow } = await supabase
    .from("communities")
    .select("id, name, org_id, organizations!inner(id, name)")
    .eq("id", microgrid.community_id)
    .single();

  const { data: orgs } = await supabase
    .from("organizations")
    .select("id, name");

  const { data: siblings } = await supabase
    .from("microgrids")
    .select("id, name")
    .eq("community_id", microgrid.community_id);

  const orgCount = orgs?.length ?? 1;
  const microgridCount = siblings?.length ?? 1;

  type OrgRow = { id: string; name: string };
  const currentOrg = communityRow
    ? (communityRow as unknown as { organizations: OrgRow }).organizations
    : orgs?.[0];

  const levels: HierarchyLevel[] = [
    {
      kind: "Organization",
      label: currentOrg?.name ?? "Organization",
      count: orgCount,
      href: "/",
      active: false,
      siblings: orgCount > 1
        ? orgs?.map((o) => ({ label: o.name, href: "/" }))
        : undefined,
    },
    {
      kind: "Microgrid",
      label: microgrid.name,
      count: microgridCount,
      href: `/microgrids/${id}/tenants`,
      active: true,
      siblings: microgridCount > 1
        ? siblings
            ?.filter((s) => s.id !== id)
            .map((s) => ({ label: s.name, href: `/microgrids/${s.id}/tenants` }))
        : undefined,
    },
  ];

  // Build location label from structured columns (location TEXT was dropped in AB)
  const locationParts = [microgrid.address_city, microgrid.address_country].filter(Boolean);
  const locationLabel = locationParts.length > 0 ? locationParts.join(", ") : null;

  return (
    <LocaleProvider currency={microgrid.currency}>
      <div>
        <div className="mb-6">
          <HierarchyNav levels={levels} />
          <h1 className="mt-3 text-2xl font-semibold text-foreground">
            {microgrid.name}
          </h1>
          {locationLabel && (
            <p className="mt-1 text-sm text-muted-foreground">{locationLabel}</p>
          )}
        </div>
        <TabNav microgridId={id} />
        <div className="mt-6">{children}</div>
      </div>
    </LocaleProvider>
  );
}
