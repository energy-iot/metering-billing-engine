import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { currentUserCanAccessMicrogrid } from "@/lib/auth/access";

/**
 * PATCH /api/households/[id]
 *
 * Added in #145 as part of the Household Edit dialog flow. Pattern follows
 * `src/app/api/edges/[id]/route.ts`. Body shape:
 *
 *   {
 *     display_name?: string;
 *     primary_email?: string | null;
 *     primary_phone?: string | null;
 *     address_line1?: string | null;
 *     address_line2?: string | null;
 *     unit_label?:    string | null;
 *     device_id?:     string | null;
 *   }
 *
 * `device_id === null` clears the household's primary_consumption_meter
 * assignment; a UUID links it (delete-then-insert into `household_devices`,
 * mirroring `HouseholdTable.handleDeviceChange` from before the refactor).
 *
 * The household UPDATE and device reassignment are NOT wrapped in a
 * transaction — sequential Supabase ops. A future RPC enhancement may
 * collapse them. The order is: UPDATE household first, then reconcile the
 * device link. If the device step fails after the UPDATE succeeds we
 * surface the error without rolling back the field updates (the operator
 * can retry the device assignment from the same dialog).
 *
 * At-least-one-contact is a form-level rule today; the route does NOT
 * reject when both contacts are blank — schema CHECK is a separate ticket.
 *
 * Permission: super_admin OR org_manager via `currentUserCanAccessMicrogrid`,
 * resolved via the household's microgrid_id. RLS is the authoritative gate;
 * the explicit check here produces actionable 403s before a Postgres 42501
 * surfaces.
 *
 * Errors: `{ error, reason? }`. Postgres 42501 → 403, 23505 → 409 (the
 * schema's partial unique index guards one household having two primaries;
 * cross-household steal is blocked by an explicit server-side SELECT guard
 * added in the #145 review — see "Cross-household steal protection" below),
 * default → 500.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ALLOWED_FIELDS = new Set([
  "display_name",
  "primary_email",
  "primary_phone",
  "address_line1",
  "address_line2",
  "unit_label",
  "device_id",
]);

type HouseholdUpdate = {
  display_name?: string;
  primary_email?: string | null;
  primary_phone?: string | null;
  address_line1?: string | null;
  address_line2?: string | null;
  unit_label?: string | null;
};

function nullableString(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

function nullableUuid(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  if (t.length === 0) return null;
  if (!UUID_RE.test(t)) return undefined;
  return t;
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params;

  if (!UUID_RE.test(id)) {
    return NextResponse.json(
      { error: "Invalid household ID — expected UUID" },
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

  // Reject any unsupported fields up front so callers get a clear pointer.
  const bodyRec = body as Record<string, unknown>;
  for (const key of Object.keys(bodyRec)) {
    if (!ALLOWED_FIELDS.has(key)) {
      return NextResponse.json(
        { error: `Unsupported field: ${key}`, reason: "unsupported_field" },
        { status: 400 }
      );
    }
  }

  // Validate display_name (when present must be a non-empty string)
  let displayName: string | undefined;
  if ("display_name" in bodyRec) {
    const dn = bodyRec.display_name;
    if (typeof dn !== "string" || dn.trim().length === 0) {
      return NextResponse.json(
        {
          error: "display_name must be a non-empty string",
          reason: "invalid_display_name",
        },
        { status: 400 }
      );
    }
    displayName = dn.trim();
  }

  // Validate device_id (UUID or null)
  let deviceIdProvided = false;
  let deviceIdValue: string | null = null;
  if ("device_id" in bodyRec) {
    const did = nullableUuid(bodyRec.device_id);
    if (did === undefined) {
      return NextResponse.json(
        {
          error: "device_id must be a valid UUID or null",
          reason: "invalid_device_id",
        },
        { status: 400 }
      );
    }
    deviceIdProvided = true;
    deviceIdValue = did;
  }

  // Build the household-fields update payload (excludes device_id).
  const update: HouseholdUpdate = {};
  if (displayName !== undefined) update.display_name = displayName;
  if ("primary_email" in bodyRec) {
    const v = nullableString(bodyRec.primary_email);
    if (v === undefined) {
      return NextResponse.json(
        {
          error: "primary_email must be a string or null",
          reason: "invalid_primary_email",
        },
        { status: 400 }
      );
    }
    update.primary_email = v;
  }
  if ("primary_phone" in bodyRec) {
    const v = nullableString(bodyRec.primary_phone);
    if (v === undefined) {
      return NextResponse.json(
        {
          error: "primary_phone must be a string or null",
          reason: "invalid_primary_phone",
        },
        { status: 400 }
      );
    }
    update.primary_phone = v;
  }
  if ("address_line1" in bodyRec) {
    const v = nullableString(bodyRec.address_line1);
    if (v === undefined) {
      return NextResponse.json(
        {
          error: "address_line1 must be a string or null",
          reason: "invalid_address_line1",
        },
        { status: 400 }
      );
    }
    update.address_line1 = v;
  }
  if ("address_line2" in bodyRec) {
    const v = nullableString(bodyRec.address_line2);
    if (v === undefined) {
      return NextResponse.json(
        {
          error: "address_line2 must be a string or null",
          reason: "invalid_address_line2",
        },
        { status: 400 }
      );
    }
    update.address_line2 = v;
  }
  if ("unit_label" in bodyRec) {
    const v = nullableString(bodyRec.unit_label);
    if (v === undefined) {
      return NextResponse.json(
        {
          error: "unit_label must be a string or null",
          reason: "invalid_unit_label",
        },
        { status: 400 }
      );
    }
    update.unit_label = v;
  }

  const hasFieldUpdate = Object.keys(update).length > 0;
  if (!hasFieldUpdate && !deviceIdProvided) {
    return NextResponse.json(
      { error: "No fields provided to update", reason: "empty_diff" },
      { status: 400 }
    );
  }

  const supabase = await createClient();

  // Fetch the row (RLS-filtered) to resolve microgrid_id for the perm check
  // and to produce a clean 404 when missing/hidden.
  const { data: existing, error: fetchError } = await supabase
    .from("households")
    .select("id, microgrid_id")
    .eq("id", id)
    .maybeSingle<{ id: string; microgrid_id: string }>();

  if (fetchError) {
    if (fetchError.code === "PGRST116") {
      return NextResponse.json({ error: "Household not found" }, { status: 404 });
    }
    return NextResponse.json(
      { error: fetchError.message ?? "Household not found" },
      { status: 404 }
    );
  }
  if (!existing) {
    return NextResponse.json({ error: "Household not found" }, { status: 404 });
  }

  const canAccess = await currentUserCanAccessMicrogrid(
    supabase,
    existing.microgrid_id
  );
  if (!canAccess) {
    return NextResponse.json(
      {
        error: "You do not have permission to update this household.",
        reason: "forbidden",
      },
      { status: 403 }
    );
  }

  const changedFieldNames = Object.keys(update);

  // Cross-household steal protection.
  // The schema's unique index prevents one household from having two primary
  // meters, not one device being claimed by two households. Guard server-side.
  // Checked BEFORE any mutation so a 409 short-circuits the whole request and
  // leaves both households untouched.
  if (deviceIdProvided && deviceIdValue) {
    const { data: existingLink } = await supabase
      .from("household_devices")
      .select("household_id")
      .eq("device_id", deviceIdValue)
      .eq("role", "primary_consumption_meter")
      .neq("household_id", id)
      .maybeSingle();

    if (existingLink) {
      return NextResponse.json(
        {
          error:
            "Device is already linked to another household. Unlink it from the source household first.",
          reason: "device_already_linked",
        },
        { status: 409 },
      );
    }
  }

  // STEP 1 — household-row update (when any field changed)
  let updatedHousehold: Record<string, unknown> | null = null;
  if (hasFieldUpdate) {
    const { data, error } = await supabase
      .from("households")
      .update(update)
      .eq("id", id)
      .select("*")
      .single();

    if (error) {
      if (error.code === "42501" || error.message.includes("row-level security")) {
        return NextResponse.json(
          {
            error: "Not authorized to update this household.",
            reason: "rls_denied",
          },
          { status: 403 }
        );
      }
      return NextResponse.json(
        { error: `Failed to update household: ${error.message}` },
        { status: 500 }
      );
    }
    updatedHousehold = data as Record<string, unknown>;
  }

  // STEP 2 — device-link reconciliation (when device_id was provided)
  if (deviceIdProvided) {
    const { error: deleteError } = await supabase
      .from("household_devices")
      .delete()
      .eq("household_id", id)
      .eq("role", "primary_consumption_meter");

    if (deleteError) {
      if (
        deleteError.code === "42501" ||
        deleteError.message.includes("row-level security")
      ) {
        return NextResponse.json(
          {
            error: "Not authorized to update the household device link.",
            reason: "rls_denied",
          },
          { status: 403 }
        );
      }
      return NextResponse.json(
        {
          error: `Failed to clear existing device link: ${deleteError.message}`,
        },
        { status: 500 }
      );
    }

    if (deviceIdValue) {
      const { error: insertError } = await supabase
        .from("household_devices")
        .insert({
          household_id: id,
          device_id: deviceIdValue,
          role: "primary_consumption_meter",
        });

      if (insertError) {
        if (
          insertError.code === "42501" ||
          insertError.message.includes("row-level security")
        ) {
          return NextResponse.json(
            {
              error: "Not authorized to assign this device.",
              reason: "rls_denied",
            },
            { status: 403 }
          );
        }
        if (insertError.code === "23505") {
          return NextResponse.json(
            {
              error: "Meter is already assigned to another household.",
              reason: "device_already_linked",
            },
            { status: 409 }
          );
        }
        return NextResponse.json(
          {
            error: `Failed to link device to household: ${insertError.message}`,
          },
          { status: 500 }
        );
      }
    }
  }

  // If only the device link changed (no household-field update), re-fetch the
  // current row so the response payload is consistent.
  if (!updatedHousehold) {
    const { data, error } = await supabase
      .from("households")
      .select("*")
      .eq("id", id)
      .single();
    if (error) {
      return NextResponse.json(
        { error: `Failed to read updated household: ${error.message}` },
        { status: 500 }
      );
    }
    updatedHousehold = data as Record<string, unknown>;
  }

  // Structured success log — counts only, no PII payload values.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  console.info(
    JSON.stringify({
      event: "household.update",
      household_id: id,
      microgrid_id: existing.microgrid_id,
      changed_fields: changedFieldNames,
      device_link_changed: deviceIdProvided,
      device_link_action: deviceIdProvided
        ? deviceIdValue
          ? "link"
          : "clear"
        : "none",
      actor_user_id: user?.id ?? null,
      at: new Date().toISOString(),
    })
  );

  return NextResponse.json({ household: updatedHousehold }, { status: 200 });
}
