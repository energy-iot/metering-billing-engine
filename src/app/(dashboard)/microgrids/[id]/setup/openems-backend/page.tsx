import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  currentUserCanAccessMicrogrid,
  currentUserCanConfigureEms,
} from "@/lib/auth/access";
import { HierarchyNav } from "@/components/ui/hierarchy-nav";
import { getHierarchyLevels } from "@/lib/hierarchy";
import { getEmsSecretForMicrogrid } from "@/lib/openems/config";
import { deriveOpenemsBackendHealth } from "./health";
import { OpenemsBackendShell } from "./openems-backend-shell";

// Setup > OpenEMS Backend (#102).
//
// Server component fetches:
//   1. Microgrid row (name + ems_* columns)
//   2. Draft billing-period count (mid-period guard)
//   3. Closed billing-period count (for the type-to-confirm bypass PM copy)
//   4. Decrypted AWS secret last-4 (configurers only; everyone else "—")
//   5. Permission flags: canConfigure, canAccessMicrogrid
//   6. The microgrid's ems_operator list (attributability line, #316)
//
// The server component passes everything as props to a single client shell
// that owns mode state (empty / configured / editing), form state, Save
// promise, and the typed-confirm dialog.
export default async function OpenemsBackendPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  // Permission gate — 404 if the user can't access (don't leak existence).
  const canAccess = await currentUserCanAccessMicrogrid(supabase, id);
  if (!canAccess) notFound();

  // #316: configuration is microgrid-scoped (ems_operator on this microgrid,
  // or super_admin) — not org access, and no longer super_admin-only.
  const canConfigure = await currentUserCanConfigureEms(supabase, id);

  const { data: mg, error: mgErr } = await supabase
    .from("microgrids")
    .select(
      "id, name, ems_type, ems_backend_url, ems_aws_region, ems_aws_access_key_id, ems_known_edge_ids, ems_last_discover_at, ems_last_discover_status, ems_last_discover_error, ems_last_discover_count"
    )
    .eq("id", id)
    .maybeSingle<{
      id: string;
      name: string;
      ems_type: "cloud_aws" | "direct_url" | null;
      ems_backend_url: string | null;
      ems_aws_region: string | null;
      ems_aws_access_key_id: string | null;
      ems_known_edge_ids: string[];
      ems_last_discover_at: string | null;
      ems_last_discover_status: string | null;
      ems_last_discover_error: string | null;
      ems_last_discover_count: number | null;
    }>();

  if (mgErr || !mg) {
    notFound();
  }

  // Count billing periods (draft + closed). `head: true` + `count: 'exact'`
  // gives us a cheap count-only query per table — two round-trips total,
  // both indexed on (microgrid_id, status).
  const [{ count: draftCount }, { count: closedCount }] = await Promise.all([
    supabase
      .from("billing_periods")
      .select("id", { count: "exact", head: true })
      .eq("microgrid_id", id)
      .eq("status", "draft"),
    supabase
      .from("billing_periods")
      .select("id", { count: "exact", head: true })
      .eq("microgrid_id", id)
      .eq("status", "closed"),
  ]);

  // Last-4 mask of the decrypted AWS secret. Configurers only.
  //
  // `canConfigure` is checked BEFORE the call, so a viewer without the grant
  // never reaches the decrypt — the ordering is the gate, not the null result.
  // `getEmsSecretForMicrogrid` additionally re-reads the microgrid row on this
  // same RLS-evaluated client and returns null before decrypting if the row is
  // not visible; see the ordering note on that helper. Neither check replaces
  // the other.
  let secretLast4: string | null = null;
  if (mg.ems_type === "cloud_aws" && canConfigure) {
    try {
      const secret = await getEmsSecretForMicrogrid(supabase, id);
      if (secret && secret.length >= 4) {
        secretLast4 = secret.slice(-4);
      }
    } catch {
      // Decrypt unavailable — render "—" rather than failing the page.
      secretLast4 = null;
    }
  }

  // Attributability line (#316). `fn_list_ems_operators` carries its own
  // access gate and returns zero rows for a microgrid the caller cannot
  // access, so no check is needed here.
  //
  // The function resolves the display name itself (name, falling back to email
  // when a profile is incomplete) and returns only that — so this is a rename,
  // not a projection. If a future surface needs the parts separately, widen the
  // function rather than reassembling them here.
  const { data: emsOperatorRows } = await supabase.rpc(
    "fn_list_ems_operators",
    { _microgrid_id: id }
  );

  type EmsOperatorRow = { user_id: string; display_name: string };

  const emsOperators = ((emsOperatorRows ?? []) as EmsOperatorRow[]).map(
    (r) => ({
      userId: r.user_id,
      name: r.display_name,
    })
  );

  const health = deriveOpenemsBackendHealth(mg);

  const levels = await getHierarchyLevels(supabase, {
    kind: "edges-listing",
    microgridId: id,
  });

  return (
    <div className="space-y-4">
      <HierarchyNav levels={levels} className="mb-2" />
      <OpenemsBackendShell
        microgrid={{
          id: mg.id,
          name: mg.name,
          ems_type: mg.ems_type,
          ems_backend_url: mg.ems_backend_url,
          ems_aws_region: mg.ems_aws_region,
          ems_aws_access_key_id: mg.ems_aws_access_key_id,
          ems_known_edge_ids: mg.ems_known_edge_ids ?? [],
          ems_last_discover_at: mg.ems_last_discover_at,
          ems_last_discover_status: mg.ems_last_discover_status,
          ems_last_discover_error: mg.ems_last_discover_error,
          ems_last_discover_count: mg.ems_last_discover_count,
        }}
        health={health}
        draftPeriodsCount={draftCount ?? 0}
        closedPeriodsCount={closedCount ?? 0}
        secretLast4={secretLast4}
        canConfigure={canConfigure}
        emsOperators={emsOperators}
      />
    </div>
  );
}
