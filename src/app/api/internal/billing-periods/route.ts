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
  if (rec.start_date >= rec.end_date) {
    return NextResponse.json({ error: "end_date must be after start_date" }, { status: 400 });
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

  return NextResponse.json({ id: data.id }, { status: 201 });
}
