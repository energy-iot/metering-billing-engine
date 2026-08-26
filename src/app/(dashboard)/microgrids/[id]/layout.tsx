import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { MicrogridPublic } from "@/lib/types/microgrid-columns";
import { MICROGRID_PUBLIC_COLUMNS } from "@/lib/types/microgrid-columns";
import { TabNav } from "./tab-nav";
import { LocaleProvider } from "@/components/format/locale-context";
import { EditEntityButton } from "@/components/forms/EditEntityButton";
import { TimezoneNudge } from "@/components/forms/TimezoneNudge";
import { Timezone } from "@/components/format/timezone";

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
    .select(MICROGRID_PUBLIC_COLUMNS)
    .eq("id", id)
    .single();

  if (error || !data) {
    notFound();
  }

  const microgrid = data as MicrogridPublic;

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
            <p className="mt-1 text-sm text-muted-foreground">
              {locationLabel && <>{locationLabel} · </>}
              {/* Current billing zone, always visible + settable via Edit
                  (#357: make the zone visible instead of silently UTC). */}
              <Timezone iana={microgrid.timezone} />
            </p>
          </div>
          <div className="flex items-center gap-2">
            <EditEntityButton entity="microgrid" initialValues={microgrid} />
          </div>
        </div>
        <TimezoneNudge microgrid={microgrid} />
        <TabNav microgridId={id} />
        <div className="mt-6">{children}</div>
      </div>
    </LocaleProvider>
  );
}
