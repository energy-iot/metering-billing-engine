import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { currentUserCanAccessOrg } from "@/lib/auth/access";
import {
  parseInvoiceConfig,
  INVOICE_PREFIX_RE,
} from "@/lib/invoices/config-schema";

/**
 * PATCH /api/communities/[id]/invoice-config — Save invoice settings (#204 / PDF2).
 *
 * Why a separate sub-route (not extending PATCH /api/communities/[id]):
 *   - Different permission gate: invoice-config requires
 *     `currentUserCanAccessOrg` (org_manager-of-parent-org / super_admin)
 *     while the parent route uses `currentUserCanAccessCommunity`.
 *   - Different validation path (Zod via `parseInvoiceConfig` vs a hand-rolled
 *     allow-list).
 *   - Clean rollback boundary if the PDF workstream needs a partial revert.
 *
 * Why PATCH (not PUT like Payment):
 *   - Matches the org-update precedent at `src/app/api/organizations/[id]/route.ts`.
 *   - Signals partial-resource semantics on the parent `communities` row.
 *   - Payment's PUT is the codebase outlier; don't mirror it blindly.
 *
 * Body shape:
 *   {
 *     invoice_prefix: string | null,    // null → DB column NULL (allowed by 00033)
 *     invoice_config: InvoiceConfig,    // Zod-validated JSONB
 *   }
 *
 * Permission-check ordering (mirrors UX5b #184 + #196):
 *   1. UUID check on [id] → 400.
 *   2. JSON parse the body → 400.
 *   3. Row read via user-bound client → NULL → 404 (don't leak existence).
 *   4. `currentUserCanAccessOrg(community.org_id)` → false → 403.
 *   5. Two-step body validation:
 *      (a) `parseInvoiceConfig(body.invoice_config)` (Zod).
 *      (b) Manual prefix check: null OR INVOICE_PREFIX_RE — invoice_prefix
 *          column is nullable, but `parseInvoiceUpdate` from PDF1a forbids
 *          null on the prefix. We allow null here per AC #3.
 *   6. UPDATE both columns. On success: revalidatePath + 200 { status: "success" }.
 *
 * Errors return `{ error: string, fields?: { invoice_config?: ..., invoice_prefix?: string } }`
 * for client-side field-level error surfacing.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: communityId } = await params;

  // (1) UUID parse.
  if (!UUID_RE.test(communityId)) {
    return NextResponse.json(
      { error: "Invalid community id — expected UUID." },
      { status: 400 },
    );
  }

  // (2) JSON parse.
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const supabase = await createClient();

  // (3) Row read — RLS-hidden / missing → 404 (don't leak via 403).
  const { data: community, error: commErr } = await supabase
    .from("communities")
    .select("id, org_id, invoice_config, invoice_prefix")
    .eq("id", communityId)
    .maybeSingle<{
      id: string;
      org_id: string;
      invoice_config: unknown;
      invoice_prefix: string | null;
    }>();

  if (commErr) {
    return NextResponse.json(
      { error: `Failed to read community: ${commErr.message}` },
      { status: 500 },
    );
  }
  if (!community) {
    return NextResponse.json(
      { error: "Community not found." },
      { status: 404 },
    );
  }

  // (4) Permission — currentUserCanAccessOrg returns true for super_admin OR
  // org_manager scoped to this community's parent org (#196).
  if (!(await currentUserCanAccessOrg(supabase, community.org_id))) {
    return NextResponse.json(
      {
        error:
          "You do not have permission to update this community's invoice settings.",
      },
      { status: 403 },
    );
  }

  // (5) Body shape + validation.
  if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
    return NextResponse.json(
      { error: "Request body must be an object." },
      { status: 400 },
    );
  }
  const body = rawBody as Record<string, unknown>;

  // (5a) Invoice prefix — null OR a string matching INVOICE_PREFIX_RE.
  // Hand-rolled (not via Zod's parseInvoiceUpdate) because that schema forbids
  // null; the column allows null, the form allows clearing → null persists.
  let invoicePrefix: string | null;
  if (body.invoice_prefix === null) {
    invoicePrefix = null;
  } else if (typeof body.invoice_prefix === "string") {
    if (!INVOICE_PREFIX_RE.test(body.invoice_prefix)) {
      return NextResponse.json(
        {
          error:
            "Invoice prefix must be 2-8 uppercase letters or digits (e.g. NFE, ACME01).",
          fields: { invoice_prefix: "invalid-format" },
        },
        { status: 400 },
      );
    }
    invoicePrefix = body.invoice_prefix;
  } else {
    return NextResponse.json(
      {
        error: "invoice_prefix must be a string or null.",
        fields: { invoice_prefix: "wrong-type" },
      },
      { status: 400 },
    );
  }

  // (5b) Invoice config — Zod via parseInvoiceConfig.
  let invoiceConfig;
  try {
    invoiceConfig = parseInvoiceConfig(body.invoice_config);
  } catch (err) {
    if (err instanceof z.ZodError) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of err.issues) {
        const path = issue.path.join(".");
        if (path) fieldErrors[path] = issue.message;
      }
      return NextResponse.json(
        {
          error:
            "Invoice configuration is invalid. See the highlighted fields.",
          fields: { invoice_config: fieldErrors },
        },
        { status: 400 },
      );
    }
    return NextResponse.json(
      { error: "Invoice configuration is invalid." },
      { status: 400 },
    );
  }

  // (6) UPDATE.
  const { error: updateErr } = await supabase
    .from("communities")
    .update({
      invoice_prefix: invoicePrefix,
      invoice_config: invoiceConfig,
    })
    .eq("id", communityId);

  if (updateErr) {
    if (
      updateErr.code === "42501" ||
      updateErr.message?.includes("row-level security")
    ) {
      return NextResponse.json(
        {
          error:
            "You do not have permission to update this community's invoice settings.",
        },
        { status: 403 },
      );
    }
    return NextResponse.json(
      { error: `Failed to update invoice settings: ${updateErr.message}` },
      { status: 500 },
    );
  }

  // Bust the layout cache so the sub-nav + child pages re-fetch.
  revalidatePath(`/communities/${communityId}`, "layout");

  return NextResponse.json({ status: "success" }, { status: 200 });
}
