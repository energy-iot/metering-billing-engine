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
 *   - For cloud_aws, the plaintext secret is only released to super_admin or
 *     service_role (see `fn_get_ems_secret` body in migration 00018). An
 *     org_manager of the owning org CAN see the microgrid row but CANNOT
 *     decrypt the secret → we throw 403. This is the pilot's compromise
 *     until per-microgrid secret-access roles ship.
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
      "id, ems_type, ems_backend_url, ems_aws_region, ems_aws_access_key_id"
    )
    .eq("id", microgridId)
    .maybeSingle<{
      id: string;
      ems_type: "cloud_aws" | "direct_url" | null;
      ems_backend_url: string | null;
      ems_aws_region: string | null;
      ems_aws_access_key_id: string | null;
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
    return { type: "direct_url", url: mg.ems_backend_url };
  }

  // cloud_aws
  if (!mg.ems_aws_region || !mg.ems_aws_access_key_id) {
    throw new OpenEmsError(
      "Microgrid config is missing AWS region or access key id",
      "OPENEMS_INVALID_CONFIG",
      500
    );
  }

  const { data: secret, error: secretErr } = await supabase.rpc(
    "fn_get_ems_secret",
    { _microgrid_id: microgridId }
  );

  if (secretErr) {
    throw new OpenEmsError(
      `Failed to retrieve AWS secret: ${secretErr.message}`,
      "OPENEMS_INVALID_CONFIG",
      500,
      secretErr
    );
  }

  if (!secret) {
    // secret is NULL — either the caller is not super_admin/service_role OR
    // the row has no secret set (but CHECK constraint requires it for
    // cloud_aws, so we treat the first case as the cause).
    throw new OpenEmsError(
      "Only super_admin may test or read meters for a Cloud (AWS) microgrid configuration. Ask a super admin to run Discover.",
      "OPENEMS_FORBIDDEN",
      403
    );
  }

  return {
    type: "cloud_aws",
    url: mg.ems_backend_url,
    region: mg.ems_aws_region,
    accessKeyId: mg.ems_aws_access_key_id,
    secretAccessKey: secret as string,
  };
}
