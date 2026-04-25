import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { currentUserCanAccessMicrogrid } from "@/lib/auth/access";
import type { DeviceType } from "@/lib/types/domain";

/**
 * PATCH /api/devices/[id] — reclassify a discovered device (#151).
 *
 * Reclassifies a previously-saved device's `device_type` and/or renames it.
 * Targets the recovery path for misclassifications detected after the
 * Discover-and-save flow finished — operators previously had to either re-run
 * Discover (operationally awkward for an already-added device) or drop into
 * SQL.
 *
 * Body shape (allow-list — anything else returns 400 `unsupported_field`):
 *
 *   {
 *     device_type?: DeviceType;
 *     name?:        string;   // trimmed; non-empty
 *   }
 *
 * Identity fields (`openems_component_id`, `edge_id`) are NEVER editable here
 * — changing identity is a delete + re-add. Reject loudly so callers get a
 * clear pointer.
 *
 * Permission gate: super_admin OR org_manager via
 * `currentUserCanAccessMicrogrid` (resolved through devices → edges →
 * microgrid_id). Mirrors the closest sibling — `POST /api/devices` — which
 * also has no super-admin-only gate. This is a data PATCH, not OpenEMS-config.
 *
 * AC-CASCADE — role/device_type conflict guard:
 *   When changing `device_type` AWAY from `consumption_meter` and the device
 *   is currently linked as a household's `primary_consumption_meter`, the
 *   route returns 409 `device_type_role_conflict` (with the linked
 *   household's id + display_name in the body). The UI surfaces this as a
 *   destructive ConfirmDialog offering "Unlink household and reclassify",
 *   which performs the unlink then re-issues the PATCH (two sequential
 *   server calls — no transactional combiner).
 *
 * Race protection (compare-and-set):
 *   After the conflict-check passes, the actual UPDATE includes
 *   `.eq("device_type", observedDeviceType)` so a concurrent state change
 *   between the SELECT and the UPDATE produces a zero-row result — the
 *   route then returns 409 `device_type_changed_concurrently`. This closes
 *   the unlink-then-relink race window where a parallel
 *   PATCH /api/households/[id] could reclaim the just-unlinked device.
 *
 * Pattern mirrors `src/app/api/households/[id]/route.ts` for ALLOWED_FIELDS
 * + UUID_RE + .maybeSingle() null-as-404, with the AC-6 compare-and-set
 * UPDATE as the one place this route diverges (households doesn't need it
 * because there's no equivalent role↔device_type cross-table invariant).
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ALLOWED_FIELDS = new Set(["device_type", "name"]);

const VALID_DEVICE_TYPES: ReadonlySet<DeviceType> = new Set<DeviceType>([
  "consumption_meter",
  "grid_meter",
  "pv_meter",
  "battery",
  "inverter",
  "ev_charger",
  "other",
]);

type DeviceUpdate = {
  device_type?: DeviceType;
  name?: string;
};

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params;

  if (!UUID_RE.test(id)) {
    return NextResponse.json(
      { error: "Invalid device ID — expected UUID" },
      { status: 400 }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json(
      { error: "Request body must be an object" },
      { status: 400 }
    );
  }

  // Reject any unsupported field up front so callers get a clear pointer.
  const bodyRec = body as Record<string, unknown>;
  for (const key of Object.keys(bodyRec)) {
    if (!ALLOWED_FIELDS.has(key)) {
      return NextResponse.json(
        { error: `Unsupported field: ${key}`, reason: "unsupported_field" },
        { status: 400 }
      );
    }
  }

  // Validate device_type when present.
  const update: DeviceUpdate = {};
  if ("device_type" in bodyRec) {
    const dt = bodyRec.device_type;
    if (typeof dt !== "string" || !VALID_DEVICE_TYPES.has(dt as DeviceType)) {
      return NextResponse.json(
        {
          error:
            "device_type must be one of consumption_meter, grid_meter, pv_meter, battery, inverter, ev_charger, other.",
          reason: "invalid_device_type",
        },
        { status: 400 }
      );
    }
    update.device_type = dt as DeviceType;
  }

  // Validate name when present (must be non-empty after trim).
  if ("name" in bodyRec) {
    const n = bodyRec.name;
    if (typeof n !== "string" || n.trim().length === 0) {
      return NextResponse.json(
        {
          error: "name must be a non-empty string",
          reason: "name_required",
        },
        { status: 400 }
      );
    }
    update.name = n.trim();
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json(
      { error: "No fields provided to update", reason: "no_changes" },
      { status: 400 }
    );
  }

  const supabase = await createClient();

  // Fetch the device (RLS-filtered) — `.maybeSingle()` + null-check produces
  // a clean 404 for missing OR RLS-hidden rows. We need the edge_id to
  // resolve microgrid_id (perm check + revalidatePath) and the current
  // device_type as the compare-and-set guard value.
  const { data: existing, error: fetchError } = await supabase
    .from("devices")
    .select("id, edge_id, device_type, name")
    .eq("id", id)
    .maybeSingle<{
      id: string;
      edge_id: string;
      device_type: DeviceType;
      name: string;
    }>();

  if (fetchError) {
    if (fetchError.code === "PGRST116") {
      return NextResponse.json({ error: "Device not found" }, { status: 404 });
    }
    return NextResponse.json(
      { error: fetchError.message ?? "Device not found" },
      { status: 404 }
    );
  }
  if (!existing) {
    return NextResponse.json({ error: "Device not found" }, { status: 404 });
  }

  // Resolve microgrid_id via the edge.
  const { data: edgeRow, error: edgeError } = await supabase
    .from("edges")
    .select("id, microgrid_id")
    .eq("id", existing.edge_id)
    .maybeSingle<{ id: string; microgrid_id: string }>();

  if (edgeError || !edgeRow) {
    // RLS-hidden edge — surface as 404 like the device case above.
    return NextResponse.json({ error: "Device not found" }, { status: 404 });
  }

  const microgridId = edgeRow.microgrid_id;

  const canAccess = await currentUserCanAccessMicrogrid(supabase, microgridId);
  if (!canAccess) {
    return NextResponse.json(
      {
        error: "You do not have permission to update this device.",
        reason: "forbidden",
      },
      { status: 403 }
    );
  }

  const observedDeviceType = existing.device_type;
  const newDeviceType = update.device_type ?? observedDeviceType;
  const typeIsChanging = newDeviceType !== observedDeviceType;

  // AC-CASCADE — role/device_type conflict guard.
  // When the type would change AWAY from consumption_meter and the device
  // is currently linked as a household's primary_consumption_meter, abort
  // with 409 (with the household details so the UI can offer the
  // unlink-and-reclassify confirm flow).
  if (
    typeIsChanging &&
    observedDeviceType === "consumption_meter" &&
    newDeviceType !== "consumption_meter"
  ) {
    const { data: link } = await supabase
      .from("household_devices")
      .select("household_id")
      .eq("device_id", id)
      .eq("role", "primary_consumption_meter")
      .maybeSingle<{ household_id: string }>();

    if (link?.household_id) {
      const { data: hh } = await supabase
        .from("households")
        .select("id, display_name")
        .eq("id", link.household_id)
        .maybeSingle<{ id: string; display_name: string }>();

      return NextResponse.json(
        {
          error:
            "This device is the primary consumption meter for a household. Unlink the household first, then reclassify.",
          reason: "device_type_role_conflict",
          household: {
            id: hh?.id ?? link.household_id,
            display_name: hh?.display_name ?? null,
          },
        },
        { status: 409 }
      );
    }
  }

  // Compare-and-set UPDATE (AC-6 race protection). Including
  // `.eq("device_type", observedDeviceType)` ensures a concurrent writer
  // that mutated device_type between our SELECT and UPDATE produces a
  // zero-row result — surfaced as 409 device_type_changed_concurrently.
  const { data: updated, error: updateError } = await supabase
    .from("devices")
    .update(update)
    .eq("id", id)
    .eq("device_type", observedDeviceType)
    .select("id, edge_id, device_type, name, openems_component_id")
    .maybeSingle();

  if (updateError) {
    if (
      updateError.code === "42501" ||
      updateError.message.includes("row-level security")
    ) {
      return NextResponse.json(
        {
          error: "Not authorized to update this device.",
          reason: "rls_denied",
        },
        { status: 403 }
      );
    }
    return NextResponse.json(
      { error: `Failed to update device: ${updateError.message}` },
      { status: 500 }
    );
  }

  if (!updated) {
    // CAS guard fired — device_type changed under us between SELECT and UPDATE.
    return NextResponse.json(
      {
        error:
          "Device state changed during update. Refresh and retry the reclassification.",
        reason: "device_type_changed_concurrently",
      },
      { status: 409 }
    );
  }

  // revalidatePath calls (AC-7) — refresh every server-rendered surface
  // that reads device_type.
  revalidatePath(
    `/microgrids/${microgridId}/setup/edges/${existing.edge_id}`,
    "page"
  );
  revalidatePath(`/microgrids/${microgridId}/setup/edges/shared`, "page");
  revalidatePath(`/microgrids/${microgridId}/setup/households`, "page");

  // Loop the household-detail revalidation across every household linked
  // through household_devices — the household-detail page filters on
  // device_type to surface the billing meter, so any linked household must
  // be invalidated regardless of role.
  const { data: linkedHouseholds } = await supabase
    .from("household_devices")
    .select("household_id")
    .eq("device_id", id)
    .returns<{ household_id: string }[]>();

  const linkedIds = new Set<string>(
    (linkedHouseholds ?? []).map((r) => r.household_id)
  );
  for (const householdId of linkedIds) {
    revalidatePath(
      `/microgrids/${microgridId}/setup/households/${householdId}`,
      "page"
    );
  }

  // Structured success log — counts only, no PII.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  console.info(
    JSON.stringify({
      event: "device.update",
      device_id: id,
      microgrid_id: microgridId,
      edge_id: existing.edge_id,
      changed_fields: Object.keys(update),
      type_changed: typeIsChanging,
      from_device_type: typeIsChanging ? observedDeviceType : null,
      to_device_type: typeIsChanging ? newDeviceType : null,
      actor_user_id: user?.id ?? null,
      at: new Date().toISOString(),
    })
  );

  return NextResponse.json({ device: updated }, { status: 200 });
}
