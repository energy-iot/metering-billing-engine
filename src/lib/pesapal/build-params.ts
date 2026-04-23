/**
 * Build Pesapal createPaymentOrder params from a Supabase billing_period.
 *
 * Looks up the billing_period, its line items (for total + tenant), and the
 * tenant's contact info. Used by both:
 *   - /api/billing/[periodId]/url (UI click flow)
 *   - scripts/test-billing-url.ts (CLI smoke test)
 *
 * Kept separate so both paths log identical inputs/outputs.
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
  tenant_id: string;
  total_amount: number;
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
    period: PeriodRow;
    tenant: TenantRow;
    totalAmount: number;
    dateRange: string;
  };
}

/**
 * Given a billing_period id, produce CreatePaymentOrderParams.
 * Throws PesapalError with a helpful code on any lookup failure so callers
 * can surface a meaningful message.
 */
export async function buildOrderParamsFromPeriod(
  supabase: SupabaseClient,
  periodId: string,
): Promise<BuildParamsResult> {
  // 1. Fetch the billing period
  const { data: period, error: periodErr } = await supabase
    .from("billing_periods")
    .select("id, microgrid_id, start_date, end_date")
    .eq("id", periodId)
    .single<PeriodRow>();
  if (periodErr || !period) {
    throw new PesapalError(
      `Billing period ${periodId} not found`,
      "PESAPAL_PERIOD_NOT_FOUND",
      404,
      periodErr,
    );
  }

  // 2. Fetch line items for this period (sum = total amount, first = tenant)
  const { data: lineItems, error: lineItemsErr } = await supabase
    .from("billing_line_items")
    .select("tenant_id, total_amount")
    .eq("billing_period_id", periodId)
    .order("created_at", { ascending: true })
    .returns<LineItemRow[]>();
  if (lineItemsErr) {
    throw new PesapalError(
      `Failed to read line items: ${lineItemsErr.message}`,
      "PESAPAL_LINE_ITEMS_ERROR",
      500,
      lineItemsErr,
    );
  }

  const totalAmount = (lineItems ?? []).reduce(
    (sum, row) => sum + Number(row.total_amount),
    0,
  );

  // 3. Pick the tenant to bill:
  //    preferred: the first tenant with a line item in this period.
  //    fallback: the first (oldest) tenant in the microgrid.
  let tenantId: string | undefined = lineItems?.[0]?.tenant_id;
  if (!tenantId) {
    const { data: fallbackTenant } = await supabase
      .from("tenants")
      .select("id")
      .eq("microgrid_id", period.microgrid_id)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle<{ id: string }>();
    tenantId = fallbackTenant?.id;
  }
  if (!tenantId) {
    throw new PesapalError(
      "No tenant found for this microgrid — add a tenant before generating a billing URL",
      "PESAPAL_NO_TENANT",
      400,
    );
  }

  const { data: tenant, error: tenantErr } = await supabase
    .from("tenants")
    .select("id, name, email, phone")
    .eq("id", tenantId)
    .single<TenantRow>();
  if (tenantErr || !tenant) {
    throw new PesapalError(
      `Tenant ${tenantId} not found`,
      "PESAPAL_TENANT_NOT_FOUND",
      404,
      tenantErr,
    );
  }

  // 4. Pesapal requires email OR phone on billing_address.
  if (!tenant.email && !tenant.phone) {
    throw new PesapalError(
      `Tenant "${tenant.name}" has neither email nor phone — Pesapal needs one of them`,
      "PESAPAL_MISSING_CONTACT",
      400,
    );
  }

  // 5. Guard against $0 amounts (Pesapal rejects them) and give a clear reason.
  if (totalAmount <= 0) {
    throw new PesapalError(
      "Period total is 0 — generate line items before creating a billing URL",
      "PESAPAL_ZERO_AMOUNT",
      400,
    );
  }

  // 6. Build the params.
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
      callbackUrl: "https://webhook.site/2229cd55-f18b-4cb8-9baf-08785ab88718",
      billingAddress,
      // currency not set here — createPaymentOrder defaults to "UGX"
    },
    debug: {
      period,
      tenant,
      totalAmount,
      dateRange,
    },
  };
}
