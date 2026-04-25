import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  currentUserCanAccessOrg,
  currentUserIsSuperAdmin,
} from "@/lib/auth/access";
import { PesapalClient } from "@/lib/payments/pesapal/client";
import { PesapalError } from "@/lib/payments/pesapal/errors";
import { scrubSecretValues } from "@/lib/logging/scrub-secrets";

/**
 * PUT /api/communities/[id]/payment — Save & test payment-provider config (#119, #121).
 *
 * Body shape (super_admin only):
 *   {
 *     provider: 'pesapal',
 *     config: { consumer_key: string, sandbox: boolean },
 *     secret_access_key?: string,
 *   }
 *
 * Note: `base_url` is NOT accepted from the body. The server derives it
 * from the `sandbox` boolean so the JSONB stays canonical and typo'd URLs
 * can never reach the DB.
 *
 * Execution order (post-#121):
 *
 *   1. UUID check on [id] → 400 on malformed.
 *   2. JSON parse + manual shape validation → 400 on malformed body.
 *   3. Resolve the community's org_id (and existing payment_*_encrypted column)
 *      with a single row read. RLS hidden or missing → 404 (don't leak).
 *   4. Permission gate: currentUserCanAccessOrg(org_id) AND
 *      currentUserIsSuperAdmin. Either missing → 403. super_admin gate is the
 *      primary rule; org access is defense-in-depth.
 *   5. Secret-preserve gate: if the body's secret_access_key is blank/absent
 *      AND an existing payment_provider_secret_encrypted row is non-NULL,
 *      preserve it. Otherwise require a non-empty secret → 400.
 *   6. Decrypt the preserved secret via fn_get_community_payment_secret so we
 *      can run a live auth test against Pesapal with it.
 *   7. Save & test (auth): call PesapalClient.getAccessToken() with the
 *      effective credentials. On failure → 503 { reason: 'auth_failed' }
 *      with no DB write.
 *   8. Save & test (IPN registration, #121): derive the public callback URL
 *      from `NEXT_PUBLIC_PAYMENT_CALLBACK_URL` (required), append
 *      `/api/payments/ipn`, and call `PesapalClient.registerIpn`. Always
 *      re-register so a sandbox/prod toggle replaces the stale GUID
 *      automatically. On failure → 503 { reason: 'register_ipn_failed' or
 *      'callback_url_unknown' } with no DB write.
 *   9. On success: atomic UPDATE of all 4 columns
 *      (payment_provider, payment_provider_config JSONB with the freshly
 *      registered ipn_id, payment_provider_secret_encrypted BYTEA via
 *      fn_ems_encrypt_secret, payment_last_configured_at = now()).
 *  10. Log payment.save_test with scrubbed secret + token.
 *
 * Response:
 *   200 → { status: 'success', message: string }
 *   4xx/5xx → { error, reason? }
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PESAPAL_BASE_URL_PROD = "https://pay.pesapal.com/v3";
const PESAPAL_BASE_URL_SANDBOX = "https://cybqa.pesapal.com/pesapalv3";

type ParsedBody = {
  provider: "pesapal";
  consumer_key: string;
  sandbox: boolean;
  secret_access_key: string | undefined;
};

function parseBody(raw: unknown): ParsedBody | { error: string } {
  if (!raw || typeof raw !== "object") {
    return { error: "Request body must be an object" };
  }
  const body = raw as Record<string, unknown>;
  if (body.provider !== "pesapal") {
    return { error: "provider must be 'pesapal'" };
  }
  if (!body.config || typeof body.config !== "object") {
    return { error: "config is required and must be an object" };
  }
  const cfg = body.config as Record<string, unknown>;
  const consumer_key =
    typeof cfg.consumer_key === "string" ? cfg.consumer_key.trim() : "";
  if (!consumer_key) {
    return { error: "config.consumer_key must be a non-empty string" };
  }
  if (typeof cfg.sandbox !== "boolean") {
    return { error: "config.sandbox must be a boolean" };
  }
  let secret_access_key: string | undefined;
  if (body.secret_access_key !== undefined) {
    if (typeof body.secret_access_key !== "string") {
      return { error: "secret_access_key, when provided, must be a string" };
    }
    secret_access_key = body.secret_access_key;
  }
  return {
    provider: "pesapal",
    consumer_key,
    sandbox: cfg.sandbox,
    secret_access_key,
  };
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const startedAt = Date.now();
  const { id: communityId } = await params;

  if (!UUID_RE.test(communityId)) {
    return NextResponse.json(
      { error: "Invalid community id — expected UUID" },
      { status: 400 },
    );
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = parseBody(rawBody);
  if ("error" in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const supabase = await createClient();

  // Row read: we need org_id for the permission check + the existing
  // ciphertext for the secret-preserve gate.
  const { data: community, error: commErr } = await supabase
    .from("communities")
    .select("id, org_id, payment_provider_secret_encrypted")
    .eq("id", communityId)
    .maybeSingle<{
      id: string;
      org_id: string;
      payment_provider_secret_encrypted: string | null;
    }>();

  if (commErr) {
    return NextResponse.json(
      { error: `Failed to read community: ${commErr.message}` },
      { status: 500 },
    );
  }
  // RLS-hidden or missing row → 404 (don't leak existence via 403).
  if (!community) {
    return NextResponse.json({ error: "Community not found." }, { status: 404 });
  }

  // Permission — super_admin gate is the primary rule; org access
  // is defense-in-depth (super_admins always pass currentUserCanAccessOrg).
  if (!(await currentUserCanAccessOrg(supabase, community.org_id))) {
    return NextResponse.json(
      { error: "You do not have permission to configure this community." },
      { status: 403 },
    );
  }
  if (!(await currentUserIsSuperAdmin(supabase))) {
    return NextResponse.json(
      {
        error:
          "Only super admins can update Payment credentials.",
      },
      { status: 403 },
    );
  }

  // Secret-preserve gate. If blank/absent + existing ciphertext → preserve.
  const submittedSecret = parsed.secret_access_key ?? "";
  const preserveExistingSecret =
    submittedSecret.length === 0 &&
    community.payment_provider_secret_encrypted !== null &&
    community.payment_provider_secret_encrypted !== undefined;

  if (submittedSecret.length === 0 && !preserveExistingSecret) {
    return NextResponse.json(
      {
        error:
          "A consumer secret is required for the first Pesapal configuration.",
      },
      { status: 400 },
    );
  }

  // Resolve the effective plaintext secret for the Save & test step.
  let effectiveSecret = submittedSecret;
  if (preserveExistingSecret) {
    const { data: decrypted, error: decryptErr } = await supabase.rpc(
      "fn_get_community_payment_secret",
      { _community_id: communityId },
    );
    if (decryptErr || !decrypted) {
      return NextResponse.json(
        {
          error:
            "Could not retrieve the existing secret to test the connection. Re-enter the consumer secret to proceed.",
        },
        { status: 500 },
      );
    }
    effectiveSecret = decrypted as string;
  }

  // Server-derived base_url from sandbox toggle.
  const base_url = parsed.sandbox
    ? PESAPAL_BASE_URL_SANDBOX
    : PESAPAL_BASE_URL_PROD;

  // Save & test — call Pesapal auth BEFORE any persist.
  const client = new PesapalClient({
    consumerKey: parsed.consumer_key,
    consumerSecret: effectiveSecret,
    baseUrl: base_url,
  });
  let token: string;
  try {
    token = await client.getAccessToken();
  } catch (err) {
    let reason: "auth_failed" | "unreachable" | "unknown_error" =
      "unknown_error";
    let message = "Could not validate the Pesapal credentials.";
    if (err instanceof PesapalError) {
      if (err.code === "PESAPAL_AUTH_FAILED") {
        reason = "auth_failed";
        message =
          "Authentication failed. Verify the consumer key and consumer secret on your Pesapal dashboard.";
      } else if (err.code === "PESAPAL_UNREACHABLE") {
        reason = "unreachable";
        message =
          "Could not reach Pesapal. Check your network and try again.";
      } else {
        message =
          "Pesapal returned an unexpected error. Check server logs and try again.";
      }
    }

    logSaveTest({
      communityId,
      provider: parsed.provider,
      status: reason,
      durationMs: Date.now() - startedAt,
      sensitive: [effectiveSecret],
      supabase,
    });

    return NextResponse.json({ error: message, reason }, { status: 503 });
  }

  // #121 — Register the IPN URL with Pesapal so subsequent submitOrder calls
  // can pass `notification_id`. We always re-register: this handles the
  // sandbox/prod toggle automatically (the previous GUID belongs to the
  // OTHER environment's Pesapal account and is invalid).
  const callbackBase = (process.env.NEXT_PUBLIC_PAYMENT_CALLBACK_URL ?? "").trim();
  if (!callbackBase) {
    logSaveTest({
      communityId,
      provider: parsed.provider,
      status: "callback_url_unknown",
      durationMs: Date.now() - startedAt,
      sensitive: [effectiveSecret],
      supabase,
    });
    return NextResponse.json(
      {
        error:
          "Server configuration error: NEXT_PUBLIC_PAYMENT_CALLBACK_URL is not set, so the IPN URL cannot be registered with Pesapal. Ask an administrator to set this environment variable in all Vercel scopes (Production, Preview, Development).",
        reason: "callback_url_unknown",
      },
      { status: 503 },
    );
  }
  const ipnUrl = `${callbackBase.replace(/\/+$/, "")}/api/payments/ipn`;

  let registeredIpnId: string;
  try {
    const registered = await client.registerIpn(token, ipnUrl, "POST");
    registeredIpnId = registered.ipn_id;
  } catch (err) {
    let reason:
      | "register_ipn_failed"
      | "unreachable"
      | "unknown_error" = "unknown_error";
    let message =
      "Could not register the IPN URL with Pesapal. Check server logs and try again.";
    if (err instanceof PesapalError) {
      if (err.code === "PESAPAL_REGISTER_IPN_FAILED") {
        reason = "register_ipn_failed";
        message =
          "Pesapal accepted the credentials but rejected the IPN registration. Verify the callback URL is publicly reachable and try again.";
      } else if (err.code === "PESAPAL_UNREACHABLE") {
        reason = "unreachable";
        message =
          "Could not reach Pesapal while registering the IPN URL. Check your network and try again.";
      }
    }

    logSaveTest({
      communityId,
      provider: parsed.provider,
      status: reason,
      durationMs: Date.now() - startedAt,
      sensitive: [effectiveSecret],
      supabase,
    });

    return NextResponse.json({ error: message, reason }, { status: 503 });
  }

  // Pesapal validated the creds AND registered the IPN → persist.
  // 1. Encrypt the (possibly reused) plaintext secret.
  let encryptedSecret: string | null = null;
  if (!preserveExistingSecret) {
    const { data: enc, error: encErr } = await supabase.rpc(
      "fn_ems_encrypt_secret",
      { p_plaintext: effectiveSecret },
    );
    if (encErr || !enc) {
      return NextResponse.json(
        {
          error: `Failed to encrypt secret: ${encErr?.message ?? "no data"}`,
        },
        { status: 500 },
      );
    }
    encryptedSecret = enc as string;
  }

  // 2. Build the atomic UPDATE payload. Save & test ALWAYS overwrites
  //    `ipn_id` with the freshly registered GUID — no preservation of the
  //    prior value. This makes the sandbox↔prod toggle correct by
  //    construction (the new GUID belongs to the now-effective Pesapal
  //    environment).
  const newConfig: Record<string, unknown> = {
    consumer_key: parsed.consumer_key,
    base_url,
    sandbox: parsed.sandbox,
    ipn_id: registeredIpnId,
  };

  const updatePayload: Record<string, unknown> = {
    payment_provider: parsed.provider,
    payment_provider_config: newConfig,
    payment_last_configured_at: new Date().toISOString(),
  };
  if (!preserveExistingSecret) {
    updatePayload.payment_provider_secret_encrypted = encryptedSecret;
  }

  const { error: updErr } = await supabase
    .from("communities")
    .update(updatePayload)
    .eq("id", communityId);

  if (updErr) {
    if (
      updErr.code === "42501" ||
      updErr.message.includes("row-level security")
    ) {
      return NextResponse.json(
        { error: "You do not have permission to configure this community." },
        { status: 403 },
      );
    }
    return NextResponse.json(
      {
        error: scrubSecretValues(
          `Failed to persist config: ${updErr.message}`,
          { extra: [effectiveSecret] },
        ),
      },
      { status: 500 },
    );
  }

  logSaveTest({
    communityId,
    provider: parsed.provider,
    status: "success",
    durationMs: Date.now() - startedAt,
    sensitive: [effectiveSecret],
    supabase,
  });

  return NextResponse.json(
    {
      status: "success",
      message: "Connected. Pesapal authentication succeeded.",
    },
    { status: 200 },
  );
}

// ─── helpers ────────────────────────────────────────────────────────────────

async function logSaveTest(args: {
  communityId: string;
  provider: string;
  status: string;
  durationMs: number;
  sensitive: string[];
  supabase: Awaited<ReturnType<typeof createClient>>;
}): Promise<void> {
  let actorUserId: string | null = null;
  try {
    const {
      data: { user },
    } = await args.supabase.auth.getUser();
    actorUserId = user?.id ?? null;
  } catch {
    actorUserId = null;
  }
  const payload = {
    event: "payment.save_test",
    community_id: args.communityId,
    actor_user_id: actorUserId,
    provider: args.provider,
    status: args.status,
    duration_ms: args.durationMs,
    at: new Date().toISOString(),
  };
  const scrubbed = scrubSecretValues(payload, {
    extra: args.sensitive.filter(Boolean),
  });
  console.info(JSON.stringify(scrubbed));
}
