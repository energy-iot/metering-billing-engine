/**
 * GET /api/billing-line-items/[lineItemId]/pdf
 *
 * PDF1b (#203) — operator-facing one-click bill download. Renders a single
 * line item as a one-page consumer PDF (Aaron's NFE template), embedding
 * the stable `/pay` redirect URL.
 *
 * Per AC4 (refined 2026-04-29):
 *   - Auth gate first (401 on no session) — pattern matches BC1 / usage route.
 *   - Session-bound Supabase client (`@/lib/supabase/server`) — RLS via
 *     `user_can_access_microgrid()` is the access gate. Service-role is used
 *     only for the storage logo download.
 *   - Permission gate (`currentUserCanAccessMicrogrid`) — defense-in-depth
 *     after the row load. Production: RLS hides the row → 404 fires first;
 *     unit tests: row visible, helper toggled to assert 403.
 *   - Proactively `ensurePaymentLinkForLineItem()` when community has a
 *     payment provider AND the line item has no cached redirect URL. Pesapal
 *     failure → 422 with the upstream reason in the body. No-provider →
 *     proceed with `paymentRedirectUrl = null` (renderer omits the card).
 *   - Generate `invoice_number` on first render via `fn_next_invoice_number`
 *     + `formatInvoiceNumber`; persist to `billing_line_items.invoice_number`.
 *     Concurrent first-render race: catch 23505 (UNIQUE violation) → reload
 *     and use the persisted value.
 *   - Logo bytes via service-role `storage.from('invoice-logos').download(path)`
 *     (direct download, NOT signed URLs — service-role bypasses RLS).
 *   - Response: `application/pdf`, `Content-Disposition: attachment;
 *     filename="<invoiceNumber>.pdf"`, `Cache-Control: no-store`.
 *
 * Idempotency contract (AC4): two consecutive calls for the same lineItemId
 * return the same `invoice_number`, the same `pesapal_redirect_url`, and do
 * NOT increment the per-community-per-year counter or mint a new Pesapal
 * session. PDF3's row action depends on this.
 */

import { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";

import { currentUserCanAccessMicrogrid } from "@/lib/auth/access";
import { resolveOrigin } from "@/lib/auth/resolve-origin";
import { PaymentError } from "@/lib/payments";
import { ensurePaymentLinkForLineItem } from "@/lib/payments/ensure-payment-link";
import { mintUniqueShortSlug } from "@/lib/payments/short-slug";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { scrubSecretValues } from "@/lib/logging/scrub-secrets";

import { formatInvoiceNumber } from "@/lib/invoices/invoice-number";
import { renderInvoicePdf } from "@/lib/invoices/render";
import type {
  BillingLineItem,
  Community,
  Device,
  Household,
  Organization,
  RateSchedule,
} from "@/lib/types/domain";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Postgres "unique_violation" — fires when two concurrent first-renders
// both pass the IS NULL guard on `invoice_number`.
const PG_UNIQUE_VIOLATION = "23505";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ lineItemId: string }> },
): Promise<NextResponse> {
  const { lineItemId } = await params;

  if (!UUID_RE.test(lineItemId)) {
    return NextResponse.json(
      { error: "Invalid line item id — expected UUID.", reason: "bad_request" },
      { status: 400 },
    );
  }

  const supabase = await createClient();

  // 1. Auth gate (BC1 AC6 pattern).
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json(
      { error: "Unauthorized.", reason: "unauthorized" },
      { status: 401 },
    );
  }

  // 2. Resolve line item + scope joins. RLS hides cross-org rows → 404.
  //    The shape of this select is the union of all fields the renderer
  //    needs PLUS the IDs needed for downstream queries (org_id, microgrid_id,
  //    rate-schedule lookup, household-device join).
  const { data: scopedRaw, error: scopedErr } = await supabase
    .from("billing_line_items")
    .select(
      `
      id,
      created_at,
      device_id,
      end_kwh,
      entered_at,
      entered_by_user_id,
      household_id,
      invoice_number,
      manual_reason,
      paid_at,
      paid_by_user_id,
      payment_failed_at,
      payment_notes,
      payment_refunded_at,
      payment_status,
      pesapal_order_id,
      pesapal_redirect_url,
      reading_source,
      short_slug,
      start_kwh,
      tier_breakdown,
      total_amount,
      usage_kwh,
      billing_period_id,
      billing_periods!inner (
        id,
        microgrid_id,
        start_date,
        end_date,
        microgrids!inner (
          id,
          community_id,
          currency,
          communities!inner (
            id,
            invoice_config,
            invoice_prefix,
            name,
            org_id,
            payment_provider,
            payment_provider_config,
            payment_provider_secret_encrypted,
            payment_last_configured_at,
            organizations!inner (
              id,
              name,
              created_at
            )
          )
        )
      ),
      households!inner (
        id,
        account_number,
        address_city,
        address_country,
        address_line1,
        address_line2,
        address_postal_code,
        address_region,
        created_at,
        customer_type,
        display_name,
        geography_notes,
        meter_serial,
        meter_type,
        microgrid_id,
        primary_email,
        primary_phone,
        unit_label
      )
    `,
    )
    .eq("id", lineItemId)
    .maybeSingle();

  if (scopedErr) {
    return NextResponse.json(
      {
        error: `Failed to look up line item: ${scopedErr.message}`,
        reason: "unknown_error",
      },
      { status: 500 },
    );
  }
  if (!scopedRaw) {
    return NextResponse.json(
      { error: "Line item not found.", reason: "not_found" },
      { status: 404 },
    );
  }

  // PostgREST may return joined !inner singletons either as objects or as
  // single-element arrays depending on the rest version. Normalize.
  const scoped = scopedRaw as unknown as Record<string, unknown>;
  const period = unwrap(scoped.billing_periods);
  const microgrid = period ? unwrap(period.microgrids) : null;
  const community = microgrid ? unwrap(microgrid.communities) : null;
  const organization = community ? unwrap(community.organizations) : null;
  const household = unwrap(scoped.households);

  if (!period || !microgrid || !community || !organization || !household) {
    return NextResponse.json(
      { error: "Line item not found.", reason: "not_found" },
      { status: 404 },
    );
  }

  const microgridId = period.microgrid_id as string;
  const communityId = microgrid.community_id as string;

  // 3. Defense-in-depth permission check. Tests exercise this branch with
  //    a mocked-visible row; production would have already 404'd via RLS.
  if (!(await currentUserCanAccessMicrogrid(supabase, microgridId))) {
    return NextResponse.json(
      {
        error: "You do not have permission to download this bill.",
        reason: "forbidden",
      },
      { status: 403 },
    );
  }

  // 4. Ensure payment link if community has a provider configured AND the
  //    line item has no cached URL yet (D6 — proactive ensure).
  let paymentRedirectUrl: string | null = null;
  const hasPaymentProvider =
    community.payment_provider != null &&
    community.payment_provider_config != null;
  let lineItemPesapalUrl = (scoped.pesapal_redirect_url as string | null) ?? null;
  let shortSlug = (scoped.short_slug as string | null) ?? null;

  if (hasPaymentProvider) {
    if (!lineItemPesapalUrl) {
      try {
        await ensurePaymentLinkForLineItem(supabase, lineItemId, {
          actorUserId: user.id,
        });
        lineItemPesapalUrl = "ensured"; // marker — actual URL not used
      } catch (err) {
        const reason = err instanceof PaymentError ? err.code : "unknown_error";
        const message =
          err instanceof PaymentError
            ? err.message
            : "Pesapal upstream returned an unexpected error.";
        console.warn(
          JSON.stringify({
            event: "pdf.ensure_payment_link_failed",
            line_item_id: lineItemId,
            community_id: communityId,
            err_code: reason,
            err_message: message,
            at: new Date().toISOString(),
          }),
        );
        return NextResponse.json(
          {
            error:
              "Cannot generate bill — payment link could not be created.",
            reason,
            details: message,
          },
          { status: 422 },
        );
      }
    }
    // Mint the short slug (#223) AFTER ensurePaymentLink succeeds — order
    // matters: if the ensure-payment-link 422'd above OR the community had
    // no provider, we would NOT want to burn a slug on a row whose PDF
    // never embeds the link. Lazy-mint keeps the column clean for
    // already-shipped bills that never re-render.
    //
    // Stability invariant (#223): once minted, the slug never rotates.
    // mintUniqueShortSlug() uses an UPDATE-NULL guard + loser-path re-SELECT;
    // its return value is the row's PERSISTED slug (the local candidate when
    // we win, the concurrent winner's slug when we lose). On retry-exhaustion
    // it throws PaymentError — surface as 422 (same shape as ensure-link
    // failure) so the operator gets a clear error rather than a 500.
    if (!shortSlug) {
      try {
        shortSlug = await mintUniqueShortSlug(supabase, lineItemId);
      } catch (err) {
        const reason = err instanceof PaymentError ? err.code : "unknown_error";
        const message =
          err instanceof PaymentError
            ? err.message
            : "Failed to mint short payment slug.";
        console.warn(
          JSON.stringify({
            event: "pdf.mint_short_slug_failed",
            line_item_id: lineItemId,
            community_id: communityId,
            err_code: reason,
            err_message: message,
            at: new Date().toISOString(),
          }),
        );
        return NextResponse.json(
          {
            error: "Cannot generate bill — short payment slug could not be created.",
            reason,
            details: message,
          },
          { status: 422 },
        );
      }
    }
    // The renderer embeds the SHORT `/p/<slug>` URL (#223). It 302s through
    // to `/api/billing-line-items/<id>/pay` which reads `pesapal_redirect_url`
    // and forwards to Pesapal — so the operator's PDF stays valid even if
    // the Pesapal session URL ever rotates. The legacy long URL keeps
    // working forever (#223 AC7) for bills already shipped to customers.
    const origin = resolveOrigin(request);
    paymentRedirectUrl = `${origin}/p/${shortSlug}`;
  }

  // 5. Resolve / generate invoice number.
  let invoiceNumber = (scoped.invoice_number as string | null) ?? null;
  if (!invoiceNumber) {
    const prefix = community.invoice_prefix as string | null;
    if (!prefix) {
      return NextResponse.json(
        {
          error:
            "Cannot generate bill — community has no invoice prefix configured.",
          reason: "missing_invoice_prefix",
        },
        { status: 422 },
      );
    }
    const year = new Date().getUTCFullYear();
    const { data: counter, error: counterErr } = await supabase.rpc(
      "fn_next_invoice_number",
      { p_community_id: communityId, p_year: year },
    );
    if (counterErr || counter == null) {
      return NextResponse.json(
        {
          error:
            "Failed to allocate invoice number. Please try again or contact support.",
          reason: "invoice_number_allocation_failed",
          details: counterErr?.message ?? null,
        },
        { status: 500 },
      );
    }
    invoiceNumber = formatInvoiceNumber(prefix, year, counter as number);

    const { error: updateErr } = await supabase
      .from("billing_line_items")
      .update({ invoice_number: invoiceNumber })
      .eq("id", lineItemId)
      .is("invoice_number", null);

    if (updateErr) {
      // 23505 indicates a concurrent first-render race won by the other
      // caller — re-read the persisted value and use it. The orphaned
      // counter increment is acceptable per AC4's race note.
      if (updateErr.code === PG_UNIQUE_VIOLATION) {
        const { data: refreshed } = await supabase
          .from("billing_line_items")
          .select("invoice_number")
          .eq("id", lineItemId)
          .maybeSingle();
        if (refreshed && refreshed.invoice_number) {
          invoiceNumber = refreshed.invoice_number;
        } else {
          return NextResponse.json(
            {
              error:
                "Failed to persist invoice number after concurrent race.",
              reason: "invoice_number_race_unresolved",
            },
            { status: 500 },
          );
        }
      } else {
        return NextResponse.json(
          {
            error: `Failed to persist invoice number: ${updateErr.message}`,
            reason: "invoice_number_persist_failed",
          },
          { status: 500 },
        );
      }
    }
  }

  // 6. Resolve meter device (first consumption_meter by created_at, ASC).
  const { data: meterRows } = await supabase
    .from("household_devices")
    .select(
      `
      device_id,
      devices!inner (
        id,
        config,
        created_at,
        device_type,
        edge_id,
        name,
        openems_component_id
      )
    `,
    )
    .eq("household_id", household.id as string)
    .eq("devices.device_type", "consumption_meter")
    .order("created_at", { ascending: true })
    .limit(1);

  let meterDevice: Device | null = null;
  if (meterRows && meterRows.length > 0) {
    const dev = unwrap((meterRows[0] as Record<string, unknown>).devices);
    if (dev) meterDevice = dev as unknown as Device;
  }

  // 7. Resolve rate schedule (most-recent for the microgrid).
  const { data: rateScheduleRow } = await supabase
    .from("rate_schedules")
    .select(
      "id, created_at, microgrid_id, service_charge, service_charge_description, tax_rate, tiers",
    )
    .eq("microgrid_id", microgridId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!rateScheduleRow) {
    return NextResponse.json(
      {
        error:
          "Cannot generate bill — no rate schedule configured for this microgrid.",
        reason: "missing_rate_schedule",
      },
      { status: 422 },
    );
  }

  // 8. Resolve "entered by" display name (BC1 — manual readings).
  //
  // #269: the prior `user_directory` view was replaced by the
  // `fn_list_visible_users` RPC. The old select asked for a
  // `display_name` column that never existed on the view (returned
  // null silently); we drop it from the projection here. The RPC's
  // visibility predicate is identical to the view's WHERE clause, so
  // an RLS-hidden actor still surfaces as an empty row set → null name.
  let enteredByUserName: string | null = null;
  const enteredById = scoped.entered_by_user_id as string | null;
  if (enteredById && scoped.reading_source === "manual") {
    const { data: dirRows } = await supabase.rpc("fn_list_visible_users", {
      _target_user_ids: [enteredById],
    });
    const dirRow = dirRows?.[0];
    if (dirRow) {
      const composed = [dirRow.first_name, dirRow.last_name]
        .filter((s): s is string => Boolean(s && s.trim()))
        .join(" ")
        .trim();
      enteredByUserName =
        (composed.length > 0 ? composed : null) ??
        (dirRow.email as string | null) ??
        null;
    }
  }

  // 9. Logo download via SERVICE ROLE (RLS bypass; renderer takes a Buffer).
  let logoBytes: Buffer | null = null;
  try {
    const invoiceConfigRaw = community.invoice_config as Record<string, unknown> | null;
    const branding = (invoiceConfigRaw?.branding ?? {}) as Record<string, unknown>;
    const logoPath = branding.logo_storage_path as string | null;
    if (logoPath && logoPath.trim().length > 0) {
      const svc = createServiceClient();
      const { data: blob, error: dlErr } = await svc.storage
        .from("invoice-logos")
        .download(logoPath);
      if (dlErr) {
        // Continue without a logo — an unbranded bill is better than no bill.
        console.warn(
          JSON.stringify(
            scrubSecretValues(
              {
                event: "pdf.logo_download_failed",
                line_item_id: lineItemId,
                community_id: communityId,
                err_message: dlErr.message,
                at: new Date().toISOString(),
              },
              {},
            ),
          ),
        );
      } else if (blob) {
        const arrayBuf = await blob.arrayBuffer();
        logoBytes = Buffer.from(arrayBuf);
      }
    }
  } catch (err) {
    console.warn(
      JSON.stringify(
        scrubSecretValues(
          {
            event: "pdf.logo_download_threw",
            line_item_id: lineItemId,
            community_id: communityId,
            err_message: err instanceof Error ? err.message : String(err),
            at: new Date().toISOString(),
          },
          {},
        ),
      ),
    );
  }

  // 10. Build the renderer input bag and call the pure renderer.
  const lineItem: BillingLineItem = {
    id: scoped.id as string,
    billing_period_id: scoped.billing_period_id as string,
    created_at: scoped.created_at as string,
    device_id: scoped.device_id as string | null,
    end_kwh: scoped.end_kwh as number | null,
    entered_at: scoped.entered_at as string | null,
    entered_by_user_id: scoped.entered_by_user_id as string | null,
    household_id: scoped.household_id as string,
    invoice_number: invoiceNumber,
    manual_reason: scoped.manual_reason as string | null,
    paid_at: scoped.paid_at as string | null,
    paid_by_user_id: scoped.paid_by_user_id as string | null,
    payment_failed_at: scoped.payment_failed_at as string | null,
    payment_notes: scoped.payment_notes as string | null,
    payment_refunded_at: scoped.payment_refunded_at as string | null,
    payment_status: scoped.payment_status as BillingLineItem["payment_status"],
    pesapal_order_id: scoped.pesapal_order_id as string | null,
    pesapal_redirect_url: lineItemPesapalUrl,
    reading_source: scoped.reading_source as BillingLineItem["reading_source"],
    short_slug: shortSlug,
    start_kwh: scoped.start_kwh as number | null,
    tier_breakdown: (scoped.tier_breakdown as unknown as BillingLineItem["tier_breakdown"]) ?? [],
    total_amount: scoped.total_amount as number,
    usage_kwh: scoped.usage_kwh as number | null,
  };

  // By this point invoiceNumber is guaranteed non-null (we either read a
  // pre-existing one OR generated + persisted a new one above). The TS
  // narrowing is lost across the various refinement branches, so we
  // re-assert here for the renderer's input bag.
  if (!invoiceNumber) {
    return NextResponse.json(
      {
        error:
          "Internal error: invoice number unresolved at render time.",
        reason: "invoice_number_unresolved",
      },
      { status: 500 },
    );
  }
  const finalInvoiceNumber: string = invoiceNumber;

  let pdfBuf: Buffer;
  try {
    pdfBuf = await renderInvoicePdf({
      lineItem,
      household: household as unknown as Household,
      community: community as unknown as Community,
      organization: organization as unknown as Organization,
      ratesSchedule: rateScheduleRow as unknown as RateSchedule,
      paymentRedirectUrl,
      invoiceNumber: finalInvoiceNumber,
      logoBytes,
      meterDevice,
      enteredByUserName,
      currency: (microgrid.currency as string | null) ?? null,
      billingPeriodStart: period.start_date as string | null,
      billingPeriodEnd: period.end_date as string | null,
    });
  } catch (err) {
    if (err instanceof ZodError) {
      return NextResponse.json(
        {
          error: "Invalid invoice configuration.",
          reason: "invalid_invoice_config",
          issues: err.issues,
        },
        { status: 422 },
      );
    }
    console.error(
      JSON.stringify(
        scrubSecretValues(
          {
            event: "pdf.render_failed",
            line_item_id: lineItemId,
            community_id: communityId,
            err_message: err instanceof Error ? err.message : String(err),
            at: new Date().toISOString(),
          },
          {},
        ),
      ),
    );
    return NextResponse.json(
      {
        error: "Failed to render PDF.",
        reason: "render_failed",
      },
      { status: 500 },
    );
  }

  return new NextResponse(new Uint8Array(pdfBuf), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${finalInvoiceNumber}.pdf"`,
      "Cache-Control": "no-store",
    },
  });
}

/**
 * PostgREST may return a joined `!inner` relation as either `T` or `T[]`
 * depending on the version + relation cardinality. Normalize to `T | null`.
 */
function unwrap<T = Record<string, unknown>>(
  candidate: unknown,
): (T & Record<string, unknown>) | null {
  if (candidate == null) return null;
  if (Array.isArray(candidate)) {
    return (candidate[0] ?? null) as (T & Record<string, unknown>) | null;
  }
  return candidate as T & Record<string, unknown>;
}
