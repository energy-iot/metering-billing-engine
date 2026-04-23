import { SetupSubNav } from "./setup-subnav";
import { createClient } from "@/lib/supabase/server";
import { deriveOpenemsBackendHealth } from "./openems-backend/health";
import { timeAgo } from "@/lib/time-ago";

// Setup sub-layout (D2 / #53).
// Wraps the four Setup sub-routes with a shared tablist sub-nav.
// OpenEMS Backend tab (added #102) carries a health chip derived from the
// microgrid's ems_* discovery fields. We resolve it once at the layout so
// the chip renders even on sibling tabs (e.g. while the user is on Edges).
export default async function SetupLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: mg } = await supabase
    .from("microgrids")
    .select(
      "ems_type, ems_last_discover_at, ems_last_discover_status, ems_last_discover_error"
    )
    .eq("id", id)
    .maybeSingle<{
      ems_type: "cloud_aws" | "direct_url" | null;
      ems_last_discover_at: string | null;
      ems_last_discover_status: string | null;
      ems_last_discover_error: string | null;
    }>();

  const health = deriveOpenemsBackendHealth(mg ?? null);
  const relative = mg?.ems_last_discover_at
    ? timeAgo(mg.ems_last_discover_at)
    : null;

  return (
    <div className="space-y-4">
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Setup
        </p>
        <h2 className="text-xl font-semibold text-foreground">Configure this microgrid</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Configure-once area. Return during onboarding or when hardware changes.
        </p>
      </div>

      <SetupSubNav
        microgridId={id}
        openemsBackendHealth={{
          status: health,
          lastDiscoverAt: mg?.ems_last_discover_at ?? null,
          lastDiscoverError: mg?.ems_last_discover_error ?? null,
          relativeTime: relative,
        }}
      />

      <div>{children}</div>
    </div>
  );
}
