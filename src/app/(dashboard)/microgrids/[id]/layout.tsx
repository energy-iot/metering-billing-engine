import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { Microgrid } from "@/lib/types/domain";
import { TabNav } from "./tab-nav";
import { LocaleProvider } from "@/components/format/locale-context";
import { EditEntityButton } from "@/components/forms/EditEntityButton";

// HierarchyNav is NOT placed here — leaf pages own their breadcrumb.
// Each leaf page calls getHierarchyLevels() with the correct scope depth
// so that exactly ONE breadcrumb appears per route.

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

  // Build location label from structured columns (location TEXT was dropped in AB)
  const locationParts = [microgrid.address_city, microgrid.address_country].filter(Boolean);
  const locationLabel = locationParts.length > 0 ? locationParts.join(", ") : null;

  return (
    <LocaleProvider currency={microgrid.currency}>
      <div>
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-foreground">
              {microgrid.name}
            </h1>
            {locationLabel && (
              <p className="mt-1 text-sm text-muted-foreground">
                {locationLabel}
              </p>
            )}
          </div>
          <EditEntityButton entity="microgrid" initialValues={microgrid} />
        </div>
        <TabNav microgridId={id} />
        <div className="mt-6">{children}</div>
      </div>
    </LocaleProvider>
  );
}
