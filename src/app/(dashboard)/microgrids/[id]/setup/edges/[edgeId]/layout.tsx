// Setup > Edges > [edgeId] layout — adds Edge level to HierarchyNav.
// The parent microgrid layout already renders Org → Community → Microgrid.
// This layout overlays a new HierarchyNav with the full chain including Edge.
// D4 sole-placer: all <HierarchyNav> placements use getHierarchyLevels().
import { HierarchyNav } from "@/components/ui/hierarchy-nav";
import { getHierarchyLevels } from "@/lib/hierarchy";
import { createClient } from "@/lib/supabase/server";

export default async function EdgeDetailLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string; edgeId: string }>;
}) {
  const { id, edgeId } = await params;
  const supabase = await createClient();

  const levels = await getHierarchyLevels(supabase, {
    kind: "edge",
    microgridId: id,
    edgeId,
  });

  return (
    <div>
      <HierarchyNav levels={levels} className="mb-4" />
      {children}
    </div>
  );
}
