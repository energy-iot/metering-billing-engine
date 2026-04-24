/**
 * Build Pesapal submitOrder params from a single billing_line_items row.
 *
 * One bill → one payment link. The line item carries both the amount and the
 * household to charge; the joined period supplies the date range used in the
 * human-readable description.
 *
 * Adapted from PR #58 (`src/lib/pesapal/build-params.ts` by @rhussain21).
 * Major change: joins `households` instead of the dead `tenants` table, using
 * `display_name`, `primary_email`, `primary_phone`.
 *
 * Kept as a separate module so both the UI click flow and any future CLI
 * smoke-test paths log identical inputs/outputs and enforce the same trust
 * boundary — all fields are derived from Supabase records the caller can
 * access (i.e. RLS still applies when a non-service-role client is passed in).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { BillingAddress } from "./types";
import { PesapalError } from "./errors";

type PeriodRow = {
  id: string;
  microgrid_id: string;
  start_date: string;
  end_date: string;
};

type LineItemRow = {
  id: string;
  household_id: string;
  total_amount: number;
  billing_period_id: string;
  billing_periods: PeriodRow | PeriodRow[] | null;
};

type HouseholdRow = {
  id: string;
  display_name: string;
  primary_email: string | null;
  primary_phone: string | null;
};

export interface BuildParamsResult {
  amount: number;
  description: string;
  billingAddress: BillingAddress;
  debug: {
    lineItem: { id: string; total_amount: number };
    period: PeriodRow;
    household: HouseholdRow;
    dateRange: string;
  };
}

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

/**
 * Given a billing_line_items id, produce the fields needed for a Pesapal
 * submitOrder call — minus `id`, `token`, `notificationId`, `callbackUrl`,
 * and `currency`, which the caller controls. Throws `PesapalError` with a
 * helpful code on any lookup failure.
 *
 * RLS: the caller's `supabase` client dictates access. A service-role client
 * bypasses RLS; the SSR client in the route will only find line items the
 * logged-in user can see.
 */
export async function buildOrderParamsFromLineItem(
  supabase: SupabaseClient,
  lineItemId: string,
): Promise<BuildParamsResult> {
  // 1. Fetch the line item + its period in one query. The FK join gives us the
  //    period date range implicitly and verifies the period row exists.
  const { data: lineItem, error: lineItemErr } = await supabase
    .from("billing_line_items")
    .select(
      `
      id,
      household_id,
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

  // 2. Fetch the household named on this line item.
  const { data: household, error: householdErr } = await supabase
    .from("households")
    .select("id, display_name, primary_email, primary_phone")
    .eq("id", lineItem.household_id)
    .single<HouseholdRow>();
  if (householdErr || !household) {
    throw new PesapalError(
      `Household ${lineItem.household_id} not found`,
      "PESAPAL_HOUSEHOLD_NOT_FOUND",
      404,
      householdErr,
    );
  }

  // 3. Pesapal requires email OR phone on billing_address.
  if (!household.primary_email && !household.primary_phone) {
    throw new PesapalError(
      `Household "${household.display_name}" has neither primary_email nor primary_phone — Pesapal needs one of them`,
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

  // 5. Build the billing-address and description.
  const { firstName, lastName } = splitName(household.display_name);
  const dateRange = formatDateRange(period.start_date, period.end_date);

  const billingAddress: BillingAddress = {
    ...(household.primary_email
      ? { email_address: household.primary_email }
      : {}),
    ...(household.primary_phone
      ? { phone_number: household.primary_phone }
      : {}),
    first_name: firstName,
    last_name: lastName,
  };

  return {
    amount: totalAmount,
    description: `Utility bill for ${dateRange}`,
    billingAddress,
    debug: {
      lineItem: { id: lineItem.id, total_amount: totalAmount },
      period,
      household,
      dateRange,
    },
  };
}
