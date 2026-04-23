import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { Microgrid } from "@/lib/types/domain";
import { TabNav } from "./tab-nav";
import { HierarchyNav } from "@/components/ui/hierarchy-nav";
import { LocaleProvider } from "@/components/format/locale-context";
import { getHierarchyLevels } from "@/lib/hierarchy";

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

  const levels = await getHierarchyLevels(supabase, {
    kind: "microgrid",
    microgridId: id,
  });

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
