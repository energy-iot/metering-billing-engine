import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { Microgrid } from "@/lib/types/database";
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
  const { data: orgs } = await supabase
    .from("organizations")
    .select("id, name");

  const { data: siblings } = await supabase
    .from("microgrids")
    .select("id, name")
    .eq("org_id", microgrid.org_id);

  const orgCount = orgs?.length ?? 1;
  const microgridCount = siblings?.length ?? 1;

  // Find the current org name
  const currentOrg = orgs?.find((o) =>
    siblings?.some((s) => s.id === id)
      ? o.id === microgrid.org_id
      : false
  ) ?? orgs?.[0];

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

  return (
    <LocaleProvider currency={microgrid.currency}>
      <div>
        <div className="mb-6">
          <HierarchyNav levels={levels} />
          <h1 className="mt-3 text-2xl font-semibold text-foreground">
            {microgrid.name}
          </h1>
          {microgrid.location && (
            <p className="mt-1 text-sm text-muted-foreground">{microgrid.location}</p>
          )}
        </div>
        <TabNav microgridId={id} />
        <div className="mt-6">{children}</div>
      </div>
    </LocaleProvider>
  );
}
