/**
 * End-to-end smoke test for the "Get Billing URL" flow.
 *
 * Given a billing_period id, this:
 *   1. Loads the period + its tenant + total from Supabase (service role)
 *   2. Runs the full Pesapal three-step flow (auth → IPN list → SubmitOrderRequest)
 *   3. Logs everything verbosely so failures are easy to diagnose
 *
 * Run:
 *   npx tsx --env-file=.env.local scripts/test-billing-url.ts <billing_period_id>
 *
 * Env vars required (put in .env.local):
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   PESAPAL_CONSUMER_KEY
 *   PESAPAL_CONSUMER_SECRET
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { createClient } from "@supabase/supabase-js";
import { createPaymentOrder, PesapalError } from "@/lib/pesapal";
import { buildOrderParamsFromPeriod } from "@/lib/pesapal/build-params";

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return val;
}

async function main() {
  const periodId = process.argv[2];
  if (!periodId) {
    console.error(
      "Usage: npx tsx --env-file=.env.local scripts/test-billing-url.ts <billing_period_id>",
    );
    process.exit(1);
  }

  const supabaseUrl = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
  const serviceRoleKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

  // Service-role client bypasses RLS — this script is for local smoke testing
  // only; never expose this key to the browser.
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  console.log("\n--- Resolving Supabase data for period ---");
  console.log(`[period] id: ${periodId}`);

  let built;
  try {
    built = await buildOrderParamsFromPeriod(supabase as any, periodId);
  } catch (err) {
    if (err instanceof PesapalError) {
      console.error(`FAILED (${err.code}): ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  const { params, debug } = built;
  console.log(
    `[period] range:      ${debug.dateRange}  (${debug.period.start_date} → ${debug.period.end_date})`,
  );
  console.log(`[period] microgrid:  ${debug.period.microgrid_id}`);
  console.log(
    `[tenant] ${debug.tenant.id} — ${debug.tenant.name}  ` +
      `email=${debug.tenant.email ?? "-"}  phone=${debug.tenant.phone ?? "-"}`,
  );
  console.log(`[total]  ${debug.totalAmount}`);
  console.log(`[params] amount:         ${params.amount}`);
  console.log(`[params] description:    ${params.description}`);
  console.log(`[params] callbackUrl:    ${params.callbackUrl}`);
  console.log(
    `[params] billingAddress: ${JSON.stringify(params.billingAddress)}`,
  );

  // Unique per run — Pesapal caches by id.
  const orderId = `INV-${periodId}-${Date.now()}`;
  console.log(`\n--- Submitting to Pesapal ---`);
  console.log(`[order] id: ${orderId}`);

  const response = await createPaymentOrder({
    id: orderId,
    ...params,
  });

  console.log(`\n[order] redirect_url:      ${response.redirect_url}`);
  console.log(`[order] order_tracking_id: ${response.order_tracking_id}`);
  console.log(`[order] merchant_reference:${response.merchant_reference}`);
  console.log(`[order] status:            ${response.status}`);
  if (response.error && JSON.stringify(response.error) !== "{}") {
    console.log(`[order] error:             ${JSON.stringify(response.error)}`);
  }
}

main().catch((err) => {
  if (err instanceof PesapalError) {
    console.error(`FAILED (${err.code}): ${err.message}`);
    if (err.details) console.error("details:", err.details);
  } else {
    console.error("FAILED:", err);
  }
  process.exit(1);
});
