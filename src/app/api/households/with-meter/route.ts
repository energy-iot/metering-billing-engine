import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * POST /api/households/with-meter
 *
 * Creates a household. Originally written for the Add-Household wizard
 * (UX2 / #74) when meter assignment was mandatory; route name is preserved
 * for back-compat. Two paths post-#158:
 *
 *   - `device_id` present and non-empty → calls `fn_create_household_with_meter`
 *     (which now wraps `fn_create_household` with a non-null device id).
 *   - `device_id` null/missing/empty → calls `fn_create_household` directly
 *     with `p_device_id => null` (manual-billing household, no meter wiring).
 *
 * The RPC is SECURITY INVOKER — RLS on households and household_devices
 * decides whether the caller may write.
 *
 * Authorization:
 *   - RLS via user_can_access_microgrid(microgrid_id) on households INSERT
 *   - The RPC's safety guards reject cross-microgrid device_ids and
 *     non-consumption-meter device types BEFORE any write happens.
 *
 * Request body:
 * {
 *   microgrid_id:         string;
 *   display_name:         string;
 *   device_id?:           string | null;     // optional — manual billing if null
 *   primary_phone:        string;            // required (#155)
 *   primary_email?:       string | null;
 *   address_line1?:       string | null;
 *   address_line2?:       string | null;
 *   unit_label?:          string | null;
 *   address_city?:        string | null;
 *   address_region?:      string | null;
 *   address_country?:     string | null;
 *   address_postal_code?: string | null;
 *   geography_notes?:     string | null;
 *   // PDF3 (#205) — household PDF-invoice identity fields:
 *   account_number?:      string | null;     // ≤ 30 chars
 *   meter_serial?:        string | null;     // ≤ 50 chars
 *   meter_type?:          string;            // NOT NULL; ≤ 50 chars
 *   customer_type?:       string;            // 'residential' | 'commercial'
 *   contact_email?:       string | null;     // format-validated
 * }
 *
 * Response:
 *   201 { household_id: string }
 *   400 invalid JSON | household_phone_required (#155)
 *   403 RLS denial (42501) or "device does not belong" / "not a consumption_meter"
 *   409 partial unique index collision (meter already assigned)
 *   422 missing required field
 *   500 unexpected
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const microgrid_id =
    typeof body.microgrid_id === "string" ? body.microgrid_id.trim() : "";
  if (!microgrid_id) {
    return NextResponse.json(
      { error: "microgrid_id is required.", field: "microgrid_id" },
      { status: 422 }
    );
  }

  const display_name =
    typeof body.display_name === "string" ? body.display_name.trim() : "";
  if (!display_name) {
    return NextResponse.json(
      { error: "display_name is required.", field: "display_name" },
      { status: 422 }
    );
  }

  // #158: device_id is optional. `null`, missing, or empty string → manual
  // billing path (call fn_create_household with p_device_id => null). A
  // non-empty string → metered path (call fn_create_household_with_meter
  // wrapper). Anything that's not a string is rejected by the trim/optional
  // helpers below.
  let device_id: string | null = null;
  if (body.device_id !== undefined && body.device_id !== null) {
    if (typeof body.device_id !== "string") {
      return NextResponse.json(
        { error: "device_id must be a string, null, or omitted.", field: "device_id" },
        { status: 422 }
      );
    }
    const trimmed = body.device_id.trim();
    device_id = trimmed.length > 0 ? trimmed : null;
  }

  // #155: primary_phone is required. Defense-in-depth — the RPC also raises
  // 'household_phone_required', but rejecting at the route gives non-form
  // callers (bulk imports, scripts, future API consumers) a structured 400
  // before any DB round-trip.
  const primary_phone =
    typeof body.primary_phone === "string" ? body.primary_phone.trim() : "";
  if (!primary_phone) {
    return NextResponse.json(
      { error: "household_phone_required", field: "primary_phone" },
      { status: 400 }
    );
  }

  const optional = (v: unknown): string | null => {
    if (typeof v !== "string") return null;
    const t = v.trim();
    return t ? t : null;
  };

  // ── PDF3 (#205) — validation for the 5 new household identity fields ──
  // Length caps + enum mirror the column CHECKs in PDF1a (#202) migration
  // 00033 and the PATCH route's per-field validators in
  // src/app/api/households/[id]/route.ts.
  const ACCOUNT_NUMBER_MAX_LENGTH = 30;
  const METER_SERIAL_MAX_LENGTH = 50;
  const METER_TYPE_MAX_LENGTH = 50;
  const CUSTOMER_TYPES = new Set(["residential", "commercial"]);
  const CONTACT_EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

  // account_number — string OR null. Length cap.
  let account_number: string | null = null;
  if (body.account_number !== undefined && body.account_number !== null) {
    if (typeof body.account_number !== "string") {
      return NextResponse.json(
        {
          error: "account_number must be a string or null",
          reason: "invalid_account_number",
          field: "account_number",
        },
        { status: 400 }
      );
    }
    const trimmed = body.account_number.trim();
    if (trimmed.length === 0) {
      account_number = null;
    } else {
      if (trimmed.length > ACCOUNT_NUMBER_MAX_LENGTH) {
        return NextResponse.json(
          {
            error: `account_number must be ${ACCOUNT_NUMBER_MAX_LENGTH} characters or fewer`,
            reason: "account_number_too_long",
            field: "account_number",
          },
          { status: 400 }
        );
      }
      account_number = trimmed;
    }
  }

  // meter_serial — string OR null. Length cap.
  let meter_serial: string | null = null;
  if (body.meter_serial !== undefined && body.meter_serial !== null) {
    if (typeof body.meter_serial !== "string") {
      return NextResponse.json(
        {
          error: "meter_serial must be a string or null",
          reason: "invalid_meter_serial",
          field: "meter_serial",
        },
        { status: 400 }
      );
    }
    const trimmed = body.meter_serial.trim();
    if (trimmed.length === 0) {
      meter_serial = null;
    } else {
      if (trimmed.length > METER_SERIAL_MAX_LENGTH) {
        return NextResponse.json(
          {
            error: `meter_serial must be ${METER_SERIAL_MAX_LENGTH} characters or fewer`,
            reason: "meter_serial_too_long",
            field: "meter_serial",
          },
          { status: 400 }
        );
      }
      meter_serial = trimmed;
    }
  }

  // meter_type — NOT NULL on the column. When omitted/null/empty, we send
  // `undefined` to the RPC so its COALESCE applies the 'Smart Submeter'
  // default. When the operator typed a value, validate length.
  let meter_type: string | undefined;
  if (body.meter_type !== undefined && body.meter_type !== null) {
    if (typeof body.meter_type !== "string") {
      return NextResponse.json(
        {
          error: "meter_type must be a non-empty string",
          reason: "invalid_meter_type",
          field: "meter_type",
        },
        { status: 400 }
      );
    }
    const trimmed = body.meter_type.trim();
    if (trimmed.length > 0) {
      if (trimmed.length > METER_TYPE_MAX_LENGTH) {
        return NextResponse.json(
          {
            error: `meter_type must be ${METER_TYPE_MAX_LENGTH} characters or fewer`,
            reason: "meter_type_too_long",
            field: "meter_type",
          },
          { status: 400 }
        );
      }
      meter_type = trimmed;
    }
    // empty-string → leave meter_type undefined → RPC COALESCEs to default
  }

  // customer_type — NOT NULL on the column; enum 'residential'|'commercial'.
  // When omitted/null, send undefined so the RPC's COALESCE applies the
  // 'residential' default. When supplied, must match the enum strictly.
  let customer_type: string | undefined;
  if (body.customer_type !== undefined && body.customer_type !== null) {
    if (
      typeof body.customer_type !== "string" ||
      !CUSTOMER_TYPES.has(body.customer_type)
    ) {
      return NextResponse.json(
        {
          error: "customer_type must be 'residential' or 'commercial'",
          reason: "invalid_customer_type",
          field: "customer_type",
        },
        { status: 400 }
      );
    }
    customer_type = body.customer_type;
  }

  // contact_email — string OR null with format validation.
  let contact_email: string | null = null;
  if (body.contact_email !== undefined && body.contact_email !== null) {
    if (typeof body.contact_email !== "string") {
      return NextResponse.json(
        {
          error: "contact_email must be a string or null",
          reason: "invalid_contact_email",
          field: "contact_email",
        },
        { status: 400 }
      );
    }
    const trimmed = body.contact_email.trim();
    if (trimmed.length === 0) {
      contact_email = null;
    } else {
      if (!CONTACT_EMAIL_RE.test(trimmed)) {
        return NextResponse.json(
          {
            error: "contact_email must be a valid email address",
            reason: "invalid_contact_email",
            field: "contact_email",
          },
          { status: 400 }
        );
      }
      contact_email = trimmed;
    }
  }

  const supabase = await createClient();

  // #158: dispatch to the meter-required wrapper (back-compat) or the
  // no-meter path on fn_create_household. The wrapper itself just delegates
  // to fn_create_household; the split is preserved at the route level so
  // existing observability/logs keep their function-name signal.
  const rpcArgs = {
    p_microgrid_id: microgrid_id,
    p_display_name: display_name,
    p_primary_phone: primary_phone,
    p_primary_email: optional(body.primary_email) ?? undefined,
    p_address_line1: optional(body.address_line1) ?? undefined,
    p_address_line2: optional(body.address_line2) ?? undefined,
    p_unit_label: optional(body.unit_label) ?? undefined,
    p_address_city: optional(body.address_city) ?? undefined,
    p_address_region: optional(body.address_region) ?? undefined,
    p_address_country: optional(body.address_country) ?? undefined,
    p_address_postal_code: optional(body.address_postal_code) ?? undefined,
    p_geography_notes: optional(body.geography_notes) ?? undefined,
    // PDF3 (#205) — household PDF-invoice identity fields. NULL → omit so
    // the RPC's COALESCE applies the column DEFAULT (for meter_type /
    // customer_type) or persists NULL (for the 3 nullable columns).
    p_account_number: account_number ?? undefined,
    p_meter_serial: meter_serial ?? undefined,
    p_meter_type: meter_type ?? undefined,
    p_customer_type: customer_type ?? undefined,
    p_contact_email: contact_email ?? undefined,
  };

  const { data, error } = device_id
    ? await supabase.rpc("fn_create_household_with_meter", {
        ...rpcArgs,
        p_device_id: device_id,
      })
    : await supabase.rpc("fn_create_household", {
        ...rpcArgs,
        p_device_id: null,
      });

  if (error) {
    // Row-level security denial → 403.
    if (
      error.code === "42501" ||
      error.message.includes("row-level security")
    ) {
      return NextResponse.json(
        { error: "Not authorized to create a household on this microgrid." },
        { status: 403 }
      );
    }

    // RPC safety guards raise generic EXCEPTION (no SQLSTATE) → map known
    // substrings to 403. These are client-side failures, not server errors.
    const msg = error.message || "";
    if (msg.includes("household_phone_required")) {
      // Should be unreachable — the route's own guard rejects empty phones
      // first. Kept for defense-in-depth when the RPC is called directly.
      return NextResponse.json(
        { error: "household_phone_required", field: "primary_phone" },
        { status: 400 }
      );
    }
    if (msg.includes("does not belong to microgrid")) {
      return NextResponse.json(
        {
          error:
            "Selected meter does not belong to this microgrid. Pick another meter.",
        },
        { status: 403 }
      );
    }
    if (msg.includes("is not a consumption_meter")) {
      return NextResponse.json(
        { error: "Selected device is not a consumption meter." },
        { status: 422 }
      );
    }

    // Unique-constraint violation — the partial unique index prevents a
    // second primary_consumption_meter on the same household. In this
    // endpoint the only way we'd see 23505 is a race where the chosen
    // meter was just assigned to another household.
    if (error.code === "23505") {
      return NextResponse.json(
        {
          error:
            "This meter was just assigned to another household. Pick another meter.",
        },
        { status: 409 }
      );
    }

    return NextResponse.json(
      { error: `Could not create household: ${error.message}` },
      { status: 500 }
    );
  }

  return NextResponse.json({ household_id: data as string }, { status: 201 });
}
