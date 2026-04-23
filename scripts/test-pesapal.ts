/**
 * Quick smoke test for src/lib/pesapal. Mirrors pesapal_api_functions.py's __main__.
 *
 * Run:
 *   npx tsx --env-file=.env.local scripts/test-pesapal.ts
 *
 * Env vars required (put in .env.local):
 *   PESAPAL_CONSUMER_KEY
 *   PESAPAL_CONSUMER_SECRET
 */

import { createPaymentOrder } from "@/lib/pesapal";

async function main() {
  const orderId = `INV-${Math.floor(Date.now() / 1000)}`; // unique per run — never reuse

  console.log("\n--- Create Payment Order (composite) ---");
  const response = await createPaymentOrder({
    id: orderId,
    amount: 5001.0,
    description: "Payment",
    callbackUrl: "https://webhook.site/2229cd55-f18b-4cb8-9baf-08785ab88718", // TEMP
    billingAddress: {
      email_address: "2229cd55-f18b-4cb8-9baf-08785ab88718@emailhook.site",
      phone_number: "",
    },
    // currency omitted → defaults to "UGX"
  });

  console.log(`\n[order] redirect_url: ${response.redirect_url}`);
  console.log(`[order] status:       ${response.status}`);
  if (response.error && JSON.stringify(response.error) !== "{}") {
    console.log(`[order] error:        ${JSON.stringify(response.error)}`);
  }
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
