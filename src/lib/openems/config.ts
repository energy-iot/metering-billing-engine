import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { OpenEmsClientConfig } from "./index";
import { OpenEmsError } from "./errors";

/**
 * Server-only helper that resolves a microgrid's saved OpenEMS backend
 * config into an `OpenEmsClientConfig` suitable for `createOpenEmsClient`.
 *
 * Return values:
 *   - `null` — the microgrid has no ems_type set (unconfigured). Callers
 *     should surface a 409 + "Configure OpenEMS Backend first" message.
 *   - `OpenEmsClientConfig` — ready to pass to `createOpenEmsClient`.
 *
 * Throws `OpenEmsError('OPENEMS_FORBIDDEN', 403)` if the caller is an
 * org_manager (not super_admin, not service_role) trying to decrypt a
 * cloud_aws secret — `fn_get_ems_secret` returned NULL for them.
 *
 * Authorization model (documented here so future callers don't rediscover it):
 *   - RLS on `microgrids` filters the row via `user_can_access_microgrid(id)`.
 *     Cross-org access surfaces as `row = null` → we return `null` and the
 *     caller translates to 404.
 *   - For cloud_aws, the decrypt runs on the service-role client via
 *     `getEmsSecretForMicrogrid` below, which re-establishes the RLS row read
 *     as the authorization step before any decrypt is reachable.
 *   - For direct_url, no secret retrieval is needed; org_managers are allowed
 *     to run Discover because nothing is redacted.
 */
export async function getMicrogridEmsConfig(
  supabase: SupabaseClient,
  microgridId: string
): Promise<OpenEmsClientConfig | null> {
  const { data: mg, error } = await supabase
    .from("microgrids")
    .select(
      "id, ems_type, ems_backend_url, ems_aws_region, ems_aws_access_key_id, ems_basic_auth_username"
    )
    .eq("id", microgridId)
    .maybeSingle<{
      id: string;
      ems_type: "cloud_aws" | "direct_url" | null;
      ems_backend_url: string | null;
      ems_aws_region: string | null;
      ems_aws_access_key_id: string | null;
      ems_basic_auth_username: string | null;
    }>();

  if (error) {
    throw new OpenEmsError(
      `Failed to read microgrid config: ${error.message}`,
      "OPENEMS_INVALID_CONFIG",
      500,
      error
    );
  }

  if (!mg) return null; // RLS hid the row OR the microgrid does not exist.
  if (!mg.ems_type) return null; // Unconfigured.
  if (!mg.ems_backend_url) {
    // Defensive: CHECK constraint prevents this at the DB level, but a
    // partial write (someone bypassing the constraint) would surface here
    // as an invalid-config error rather than a runtime TypeScript crash.
    throw new OpenEmsError(
      "Microgrid config is missing ems_backend_url",
      "OPENEMS_INVALID_CONFIG",
      500
    );
  }

  if (mg.ems_type === "direct_url") {
    // #327. No username stored → unauthenticated backend, exactly as before,
    // and no decrypt is attempted. The username is the cheap plaintext signal
    // that credentials exist; reaching for the password when there is no user
    // would spend a service-role round-trip on every unauthenticated config.
    if (!mg.ems_basic_auth_username) {
      return { type: "direct_url", url: mg.ems_backend_url };
    }

    const password = await getEmsBasicAuthPasswordForMicrogrid(
      supabase,
      microgridId
    );

    return {
      type: "direct_url",
      url: mg.ems_backend_url,
      username: mg.ems_basic_auth_username,
      password,
    };
  }

  // cloud_aws
  if (!mg.ems_aws_region || !mg.ems_aws_access_key_id) {
    throw new OpenEmsError(
      "Microgrid config is missing AWS region or access key id",
      "OPENEMS_INVALID_CONFIG",
      500
    );
  }

  const secret = await getEmsSecretForMicrogrid(supabase, microgridId);

  if (!secret) {
    // The RLS row read above already succeeded, so the caller is authorized.
    // A null here means the authorization step inside
    // `getEmsSecretForMicrogrid` did not resolve the row (a concurrent
    // delete / permission change) or no ciphertext is stored for the row.
    // Both are non-retrievable states for this caller — surface as 403 so
    // callers keep their existing "forbidden" mapping.
    throw new OpenEmsError(
      "The stored secret access key for this Cloud (AWS) microgrid could not be retrieved. Re-enter the secret access key in Setup → OpenEMS Backend.",
      "OPENEMS_FORBIDDEN",
      403
    );
  }

  return {
    type: "cloud_aws",
    url: mg.ems_backend_url,
    region: mg.ems_aws_region,
    accessKeyId: mg.ems_aws_access_key_id,
    secretAccessKey: secret,
  };
}

/**
 * Decrypt a microgrid's stored EMS secret.
 *
 * ── The ordering here is load-bearing. Do not reorder. ───────────────────
 *
 * The decrypt runs on the **service-role** client. `fn_get_ems_secret`
 * short-circuits its own permission gate for `service_role`, so the function
 * contributes NO authorization on this path. The RLS row read in step 1 is
 * therefore the ONLY authorization, not a second layer:
 *
 *   1. Read the `microgrids` row on the caller's own (cookie-scoped, RLS-
 *      evaluated) client. This is the authorization step.
 *   2. Treat "no row" as TERMINAL — return before any decrypt is reachable.
 *      A cross-org caller is filtered by `user_can_access_microgrid` in RLS
 *      and exits here; the service-role client is never constructed.
 *   3. Only then decrypt on the service-role client.
 *
 * Written in the other order this becomes an ungated internal decrypt. Every
 * caller that needs the plaintext MUST go through this helper rather than
 * calling `fn_get_ems_secret` directly, so the invariant lives in one place.
 *
 * `authorizedClient` MUST be an RLS-evaluated client (`@/lib/supabase/server`).
 * Passing a service-role client makes step 1 a no-op — that is only correct
 * for machine callers that have already performed their own org check (e.g.
 * the token-authenticated generation route, which verifies `org_id` first).
 *
 * Returns the plaintext, or `null` when the caller is not authorized for the
 * row or no ciphertext is stored. Throws `OpenEmsError` on infrastructure
 * failure (read error / decrypt RPC error).
 */
export async function getEmsSecretForMicrogrid(
  authorizedClient: SupabaseClient,
  microgridId: string
): Promise<string | null> {
  return authorizeThenDecrypt(
    authorizedClient,
    microgridId,
    "fn_get_ems_secret",
    "AWS secret"
  );
}

/**
 * Decrypt a microgrid's stored HTTP Basic password (#327).
 *
 * Same contract, same ordering, same reasons as `getEmsSecretForMicrogrid`
 * above — they share one implementation precisely so the ordering cannot
 * drift between them. Read that docstring; it governs this function too.
 *
 * `fn_get_ems_basic_auth_password` is `service_role`-only (00054, following
 * 00049's treatment of `fn_get_ems_secret`), so there is no path that reaches
 * the plaintext on a user-session client.
 */
export async function getEmsBasicAuthPasswordForMicrogrid(
  authorizedClient: SupabaseClient,
  microgridId: string
): Promise<string | null> {
  return authorizeThenDecrypt(
    authorizedClient,
    microgridId,
    "fn_get_ems_basic_auth_password",
    "OpenEMS password"
  );
}

/**
 * The shared body of the two exported getters. Private on purpose.
 *
 * ── The ordering here is load-bearing. Do not reorder. ───────────────────
 *
 * Both decrypt RPCs run on the service-role client and short-circuit their
 * own permission gates for `service_role`, so neither contributes any
 * authorization on this path. The RLS row read in step 1 is the ONLY
 * authorization. Written in the other order this becomes an ungated internal
 * decrypt — which is why there is one implementation rather than one per
 * secret: a second copy is how the two stop agreeing.
 */
async function authorizeThenDecrypt(
  authorizedClient: SupabaseClient,
  microgridId: string,
  rpc: "fn_get_ems_secret" | "fn_get_ems_basic_auth_password",
  label: string
): Promise<string | null> {
  // ── Step 1: authorization. RLS on `microgrids` decides visibility. ──────
  const { data: authorizedRow, error: authErr } = await authorizedClient
    .from("microgrids")
    .select("id")
    .eq("id", microgridId)
    .maybeSingle<{ id: string }>();

  if (authErr) {
    throw new OpenEmsError(
      `Failed to authorize secret access: ${authErr.message}`,
      "OPENEMS_INVALID_CONFIG",
      500,
      authErr
    );
  }

  // ── Step 2: TERMINAL. No row → no decrypt path is reachable. ───────────
  if (!authorizedRow) return null;

  // ── Step 3: decrypt only. ──────────────────────────────────────────────
  //
  // Imported lazily so that SUPABASE_SERVICE_ROLE_KEY is only a hard
  // requirement for surfaces that actually decrypt. `@/lib/supabase/service`
  // throws at module load when the key is unset; an eager import would make
  // every page that merely *reads* EMS config fail to boot without it.
  const { createServiceClient } = await import("@/lib/supabase/service");
  const { data: secret, error: secretErr } = await createServiceClient().rpc(
    rpc,
    { _microgrid_id: microgridId }
  );

  if (secretErr) {
    throw new OpenEmsError(
      `Failed to retrieve ${label}: ${secretErr.message}`,
      "OPENEMS_INVALID_CONFIG",
      500,
      secretErr
    );
  }

  return typeof secret === "string" && secret.length > 0 ? secret : null;
}
