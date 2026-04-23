import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import type { Edge } from "@/lib/types/domain";
import { StatusChip } from "@/components/ui/status-chip";
import { Chip } from "@/components/ui/chip";
import { createOpenEmsClient, OpenEmsError } from "@/lib/openems";
import { getMicrogridEmsConfig } from "@/lib/openems/config";
import type { OpenEmsClientConfig } from "@/lib/openems";
import { HierarchyNav } from "@/components/ui/hierarchy-nav";
import { getHierarchyLevels } from "@/lib/hierarchy";
import { EdgesCRUDShell } from "./edges-crud-shell";
import { DeletedSuccessBanner } from "@/components/entity-deletion/DeletedSuccessBanner";
import { currentUserCanAccessMicrogrid } from "@/lib/auth/access";
import { EdgeRowActions } from "./edge-row-actions";

// Setup > Edges (D2 / #53, #77).
// Lists every edge attached to this microgrid. Rows link to edge detail.
// "+ Add edge" and "Configure…" buttons are in the client shell component.
//
// Post-#101: data_source_type / openems_backend_url dropped from the row.
// OpenEMS is the only source; backend config lives on the microgrid.

type EdgeRow = Pick<Edge, "id" | "name" | "openems_edge_id" | "role">;

async function fetchEdgeOnlineMap(
  emsConfig: OpenEmsClientConfig | null,
  openemsEdgeIds: string[],
): Promise<{ map: Record<string, boolean>; error: string | null }> {
  if (openemsEdgeIds.length === 0) return { map: {}, error: null };
  if (!emsConfig) {
    return {
      map: {},
      error: "OpenEMS Backend not configured for this microgrid.",
    };
  }
  try {
    const client = createOpenEmsClient(emsConfig);
    const statuses = await client.getEdgesStatus(openemsEdgeIds);
    const map: Record<string, boolean> = {};
    for (const s of statuses) map[s.edgeId] = s.online;
    return { map, error: null };
  } catch (err) {
    return {
      map: {},
      error:
        err instanceof OpenEmsError
          ? err.message
          : "Could not reach OpenEMS backend",
    };
  }
}

export default async function SetupEdgesPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const sp = searchParams ? await searchParams : undefined;
  const supabase = await createClient();

  const canManage = await currentUserCanAccessMicrogrid(supabase, id);

  const levels = await getHierarchyLevels(supabase, {
    kind: "edges-listing",
    microgridId: id,
  });

  const { data: edges, error } = await supabase
    .from("edges")
    .select("id, name, openems_edge_id, role")
    .eq("microgrid_id", id)
    .order("name")
    .returns<EdgeRow[]>();

  if (error) {
    return (
      <div className="rounded-md bg-destructive-muted p-4 text-sm text-destructive-fg">
        Error loading edges: {error.message}
      </div>
    );
  }

  const openemsEdgeIds = (edges ?? [])
    .filter((e) => !!e.openems_edge_id)
    .map((e) => e.openems_edge_id as string);

  let emsConfig: OpenEmsClientConfig | null = null;
  try {
    emsConfig = await getMicrogridEmsConfig(supabase, id);
  } catch {
    emsConfig = null;
  }

  const { map: onlineMap, error: onlineError } =
    await fetchEdgeOnlineMap(emsConfig, openemsEdgeIds);

  return (
    <div className="space-y-4">
      <DeletedSuccessBanner searchParams={sp} />
      <HierarchyNav levels={levels} className="mb-2" />
      <div className="flex items-end justify-between gap-4">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Edges &amp; devices
          </p>
          <h3 className="text-lg font-semibold text-foreground">
            {edges?.length ?? 0} edge{(edges?.length ?? 0) === 1 ? "" : "s"}
          </h3>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href={`/microgrids/${id}/setup/edges/shared`}
            className="text-sm font-medium text-primary hover:underline"
          >
            View shared devices →
          </Link>
          {/* Client shell handles the + Add Edge modal trigger */}
          <EdgesCRUDShell microgridId={id} mode="add-button" />
        </div>
      </div>

      {onlineError && (
        <div
          role="status"
          className="rounded-md bg-warning-muted p-3 text-xs text-warning-fg"
        >
          Live edge status unavailable: {onlineError}
        </div>
      )}

      {!edges || edges.length === 0 ? (
        <p className="rounded-md border border-border bg-card p-6 text-sm text-muted-foreground">
          No edges configured yet. Add an edge to link this microgrid to a
          metering source.
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <table className="w-full text-left text-sm">
            <thead className="bg-muted">
              <tr>
                <th className="px-4 py-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Name
                </th>
                <th className="px-4 py-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Source
                </th>
                <th className="px-4 py-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  OpenEMS edge id
                </th>
                <th className="px-4 py-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Status
                </th>
                <th className="px-4 py-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {edges.map((edge) => {
                const onlineEntry = edge.openems_edge_id
                  ? onlineMap[edge.openems_edge_id]
                  : undefined;
                const hasStatus = !onlineError && onlineEntry !== undefined;
                return (
                  <tr
                    key={edge.id}
                    className="border-t border-border hover:bg-muted"
                  >
                    <td className="px-4 py-3">
                      <Link
                        href={`/microgrids/${id}/setup/edges/${edge.id}`}
                        className="font-medium text-foreground hover:underline"
                      >
                        {edge.name}
                      </Link>
                      {edge.role && (
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {edge.role}
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <StatusChip
                        kind="edgeSource"
                        status="openems"
                      />
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                      {edge.openems_edge_id ?? "—"}
                    </td>
                    <td className="px-4 py-3">
                      {hasStatus ? (
                        <StatusChip
                          kind="edge"
                          status={onlineEntry ? "online" : "offline"}
                        />
                      ) : (
                        <Chip tone="neutral" dot aria-label="Edge status unknown">
                          Unknown
                        </Chip>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {/* Kebab menu: Configure + Delete (gated on canManage) */}
                      <EdgeRowActions
                        edge={edge}
                        microgridId={id}
                        canManage={canManage}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
