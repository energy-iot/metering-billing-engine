/**
 * Build Pesapal createPaymentOrder params from a single billing_line_items row.
 *
 * One bill → one payment link. The line item carries both the amount and the
 * tenant to charge; the joined period supplies the date range used in the
 * human-readable description.
 *
 * Used by both:
 *   - /api/billing-line-items/[lineItemId]/url (UI click flow)
 *   - scripts/test-billing-url.ts (CLI smoke test)
 *
 * Kept separate so both paths log identical inputs/outputs and enforce the
 * same trust boundary — all fields are derived from Supabase records the
 * caller can access (i.e. RLS still applies when a non-service-role client is
 * passed in).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { BillingAddress, CreatePaymentOrderParams } from "./types";
import { PesapalError } from "./errors";

type PeriodRow = {
  id: string;
  microgrid_id: string;
  start_date: string;
  end_date: string;
};

type LineItemRow = {
  id: string;
  tenant_id: string;
  total_amount: number;
  billing_period_id: string;
  billing_periods: PeriodRow | PeriodRow[] | null;
};

type TenantRow = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
};

/** Split "First Last Etc" → { first: "First", last: "Last Etc" }. */
function splitName(full: string): { firstName: string; lastName: string } {
  const trimmed = full.trim();
  if (!trimmed) return { firstName: "", lastName: "" };
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

/** Match the UI's date formatting ("Apr 22, 2026"). */
function formatDate(dateStr: string): string {
  return new Date(`${dateStr}T00:00:00`).toLocaleDateString("en", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatDateRange(start: string, end: string): string {
  if (start === end) return formatDate(start);
  return `${formatDate(start)} – ${formatDate(end)}`;
}

export interface BuildParamsResult {
  /** Params ready to pass into createPaymentOrder (minus `id`, which callers generate). */
  params: Omit<CreatePaymentOrderParams, "id">;
  /** Raw rows used to build the params — handy for verbose CLI logging. */
  debug: {
    lineItem: { id: string; total_amount: number };
    period: PeriodRow;
    tenant: TenantRow;
    dateRange: string;
  };
}

/**
 * Given a billing_line_items id, produce CreatePaymentOrderParams for exactly
 * that one bill. Throws PesapalError with a helpful code on any lookup failure
 * so callers can surface a meaningful message.
 *
 * RLS: the caller's `supabase` client dictates access. A service-role client
 * bypasses RLS; the SSR client in the route will only find line items the
 * logged-in user can see.
 */
export async function buildOrderParamsFromLineItem(
  supabase: SupabaseClient,
  lineItemId: string,
): Promise<BuildParamsResult> {
  // 1. Fetch the line item + its period in one query. We go through the FK
  //    join so we get the date range + microgrid lineage "for free" and
  //    implicitly verify the line item's billing_period exists.
  const { data: lineItem, error: lineItemErr } = await supabase
    .from("billing_line_items")
    .select(
      `
      id,
      tenant_id,
      total_amount,
      billing_period_id,
      billing_periods!inner (
        id,
        microgrid_id,
        start_date,
        end_date
      )
    `,
    )
    .eq("id", lineItemId)
    .single<LineItemRow>();
  if (lineItemErr || !lineItem) {
    throw new PesapalError(
      `Billing line item ${lineItemId} not found`,
      "PESAPAL_LINE_ITEM_NOT_FOUND",
      404,
      lineItemErr,
    );
  }

  // PostgREST returns joined single rows as either an object or a single-
  // element array depending on the FK cardinality it detects. Normalize.
  const period: PeriodRow | null = Array.isArray(lineItem.billing_periods)
    ? (lineItem.billing_periods[0] ?? null)
    : lineItem.billing_periods;
  if (!period) {
    throw new PesapalError(
      `Billing period for line item ${lineItemId} not found`,
      "PESAPAL_PERIOD_NOT_FOUND",
      404,
    );
  }

  // 2. Fetch the tenant named on this line item.
  const { data: tenant, error: tenantErr } = await supabase
    .from("tenants")
    .select("id, name, email, phone")
    .eq("id", lineItem.tenant_id)
    .single<TenantRow>();
  if (tenantErr || !tenant) {
    throw new PesapalError(
      `Tenant ${lineItem.tenant_id} not found`,
      "PESAPAL_TENANT_NOT_FOUND",
      404,
      tenantErr,
    );
  }

  // 3. Pesapal requires email OR phone on billing_address.
  if (!tenant.email && !tenant.phone) {
    throw new PesapalError(
      `Tenant "${tenant.name}" has neither email nor phone — Pesapal needs one of them`,
      "PESAPAL_MISSING_CONTACT",
      400,
    );
  }

  // 4. Guard against $0 / negative amounts (Pesapal rejects them).
  const totalAmount = Number(lineItem.total_amount);
  if (!Number.isFinite(totalAmount) || totalAmount <= 0) {
    throw new PesapalError(
      "Line item total is 0 — nothing to bill",
      "PESAPAL_ZERO_AMOUNT",
      400,
    );
  }

  // 5. Build the params.
  const { firstName, lastName } = splitName(tenant.name);
  const dateRange = formatDateRange(period.start_date, period.end_date);

  const billingAddress: BillingAddress = {
    ...(tenant.email ? { email_address: tenant.email } : {}),
    ...(tenant.phone ? { phone_number: tenant.phone } : {}),
    first_name: firstName,
    last_name: lastName,
  };

  return {
    params: {
      amount: totalAmount,
      description: `Utility bill for ${dateRange}`,
      // TODO: replace with a real callback route once the post-payment flow exists.
      callbackUrl: "https://nearlyfreeenergy.com",
      billingAddress,
      // currency not set here — createPaymentOrder defaults to "UGX"
    },
    debug: {
      lineItem: { id: lineItem.id, total_amount: totalAmount },
      period,
      tenant,
      dateRange,
    },
  };
}
