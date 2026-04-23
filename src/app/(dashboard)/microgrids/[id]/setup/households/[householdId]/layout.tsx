// Setup > Households > [householdId] layout — adds Household level to HierarchyNav.
// The parent microgrid layout already renders Org → Community → Microgrid.
// This layout renders the full chain including Household with Household active.
// D4 sole-placer: all <HierarchyNav> placements use getHierarchyLevels().
import { HierarchyNav } from "@/components/ui/hierarchy-nav";
import { getHierarchyLevels } from "@/lib/hierarchy";
import { createClient } from "@/lib/supabase/server";

export default async function HouseholdDetailLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string; householdId: string }>;
}) {
  const { id, householdId } = await params;
  const supabase = await createClient();

  const levels = await getHierarchyLevels(supabase, {
    kind: "household",
    microgridId: id,
    householdId,
  });

  return (
    <div>
      <HierarchyNav levels={levels} className="mb-4" />
      {children}
    </div>
  );
}
