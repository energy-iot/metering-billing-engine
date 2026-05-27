import { NextRequest, NextResponse } from "next/server";
import { checkInternalApiKey } from "@/lib/internal-auth";
import { createServiceClient } from "@/lib/supabase/service";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function POST(request: NextRequest) {
  if (!checkInternalApiKey(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const rec = raw as Record<string, unknown>;

  if (typeof rec.microgrid_id !== "string" || !UUID_RE.test(rec.microgrid_id)) {
    return NextResponse.json({ error: "microgrid_id must be a UUID" }, { status: 400 });
  }
  if (typeof rec.start_date !== "string" || !DATE_RE.test(rec.start_date)) {
    return NextResponse.json({ error: "start_date must be YYYY-MM-DD" }, { status: 400 });
  }
  if (typeof rec.end_date !== "string" || !DATE_RE.test(rec.end_date)) {
    return NextResponse.json({ error: "end_date must be YYYY-MM-DD" }, { status: 400 });
  }
  if (rec.start_date > rec.end_date) {
    return NextResponse.json({ error: "end_date must be on or after start_date" }, { status: 400 });
  }

  const supabase = createServiceClient();

  const { data, error } = await supabase
    .from("billing_periods")
    .insert({
      microgrid_id: rec.microgrid_id,
      start_date: rec.start_date,
      end_date: rec.end_date,
      status: "draft",
    })
    .select("id")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Audit: record that a billing period was created via the customerapp
  // internal route. Pre-existing gap (PR #246 inherited it); #250 closes
  // it with the new `billing_period_created` event type added in migration
  // 00041.
  //
  // PLACEHOLDER: actor_ref will become the per-org token name when #255
  // lands (Wave B). Stamping `'pre-token-system'` keeps the audit trail
  // attributable to "customerapp internal route, pre-token auth".
  //
  // Warn-but-still-return on audit failure: a missed audit row must not
  // mask a successfully created billing period from the caller.
  const { error: auditErr } = await supabase.from("billing_audit_log").insert({
    billing_period_id: data.id,
    event_type: "billing_period_created",
    actor_user_id: null,
    actor_kind: "customerapp",
    actor_ref: "pre-token-system",
    details: {
      billing_period_id: data.id,
      microgrid_id: rec.microgrid_id,
      start_date: rec.start_date,
      end_date: rec.end_date,
    },
  });

  if (auditErr) {
    console.warn(
      JSON.stringify({
        event: "internal.billing_periods.audit_write_failed",
        billing_period_id: data.id,
        microgrid_id: rec.microgrid_id,
        pg_code: auditErr.code,
        pg_message: auditErr.message,
        at: new Date().toISOString(),
      }),
    );
  }

  return NextResponse.json({ id: data.id }, { status: 201 });
}
