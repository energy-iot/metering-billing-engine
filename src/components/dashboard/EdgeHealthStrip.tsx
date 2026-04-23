// EdgeHealthStrip — per-edge status chip row for the Microgrid Dashboard.
//
// Added in #72 (UX1a Dashboard edge health strip + offline alert).
//
// Renders a horizontal flex-wrap row of one chip per edge. Each chip shows
// the edge name with a status-coloured dot and is a link to the edge's Setup
// detail page.
//
// OpenEMS-typed edges get `online` / `offline` status from the resolved
// edgeStatusMap. `unknown` is used when:
//   - the edge is non-OpenEMS (data_source_type !== 'openems')
//   - OpenEMS was unreachable (edgeStatusMap is null)
//
// Non-OpenEMS edges render with a title="No status source" tooltip and
// do NOT contribute to the offline alert banner.

import Link from "next/link";
import { Chip } from "@/components/ui/chip";
import type { ChipProps } from "@/components/ui/chip";

export type EdgeHealthEntry = {
  id: string;
  name: string;
  data_source_type: string;
  openems_edge_id: string | null;
};

/** edgeStatusMap: openems_edge_id → online. null means OpenEMS was unreachable. */
export type EdgeStatusMap = Record<string, boolean> | null;

/** Resolved per-edge status after combining DB rows + OpenEMS response. */
export type EdgeHealthStatus = "online" | "offline" | "unknown";

export function resolveEdgeStatus(
  edge: EdgeHealthEntry,
  edgeStatusMap: EdgeStatusMap,
): EdgeHealthStatus {
  if (edge.data_source_type !== "openems") return "unknown";
  if (edgeStatusMap === null) return "unknown";
  if (!edge.openems_edge_id) return "unknown";
  const online = edgeStatusMap[edge.openems_edge_id];
  if (online === true) return "online";
  if (online === false) return "offline";
  return "unknown";
}

const STATUS_TONE: Record<EdgeHealthStatus, ChipProps["tone"]> = {
  online:  "success",
  offline: "alert",
  unknown: "neutral",
};

interface EdgeHealthStripProps {
  microgridId: string;
  edges: EdgeHealthEntry[];
  /** null → OpenEMS unreachable (all OpenEMS edges resolve to unknown) */
  edgeStatusMap: EdgeStatusMap;
}

export function EdgeHealthStrip({
  microgridId,
  edges,
  edgeStatusMap,
}: EdgeHealthStripProps) {
  return (
    <div className="flex flex-wrap gap-2">
      {edges.map((edge) => {
        const href = `/microgrids/${microgridId}/setup/edges/${edge.id}/`;
        const isOpenEms = edge.data_source_type === "openems";
        const status = resolveEdgeStatus(edge, edgeStatusMap);
        const tooltip = !isOpenEms ? "No status source" : undefined;
        const tone = STATUS_TONE[status];

        return (
          <Link key={edge.id} href={href} title={tooltip}>
            <Chip
              tone={tone}
              dot
              aria-label={`${edge.name}: ${status}`}
            >
              {edge.name}
            </Chip>
          </Link>
        );
      })}
    </div>
  );
}
