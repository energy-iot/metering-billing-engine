import { OpenEmsError } from "./errors";
import { OpenEmsClient } from "./client";
import { BasicAuth, SigV4Auth } from "./auth";

/**
 * Configuration for constructing an OpenEMS client.
 *
 * Post-#101: the adapter no longer reads `process.env.OPENEMS_*`. Callers
 * (route handlers, server components) must resolve the microgrid-level
 * config via `getMicrogridEmsConfig` in `./config.ts` and pass the result
 * here. The Save-&-test-connection route is the sole exception — it builds
 * a candidate config from the request body before persisting it.
 *
 * `cloud_aws`: AWS SigV4-signed request to a Lambda Function URL that fronts
 * an OpenEMS B2B endpoint. Requires IAM access key + region.
 *
 * `direct_url`: HTTP POST to an OpenEMS B2B REST endpoint, with optional HTTP
 * Basic credentials. #101 shipped this mode with no auth fields and directed
 * authenticated self-hosted backends at `cloud_aws` behind a Lambda proxy;
 * #327 widened it, because an operator running OpenEMS Backend with the
 * REST/JSON-RPC API enabled gets an authenticated endpoint by default and
 * asking them to stand up a Lambda to reach it is infrastructure work for a
 * feature that already ships.
 *
 * Credentials are OPTIONAL and deliberately not a third `ems_type` value:
 * `ALTER TYPE … ADD VALUE` cannot be undone, and #316/#321 left a permanent
 * unused `user_role` value doing exactly that. Absent credentials, this mode
 * behaves as it always did.
 */
export type OpenEmsClientConfig =
  | {
      type: "cloud_aws";
      url: string;
      region: string;
      accessKeyId: string;
      secretAccessKey: string;
    }
  | {
      type: "direct_url";
      url: string;
      /** HTTP Basic username. Optional — omit for an unauthenticated backend. */
      username?: string | null;
      /** HTTP Basic password, plaintext at this boundary. Optional. */
      password?: string | null;
    };

/**
 * Construct an OpenEMS client from an explicit configuration object.
 *
 * There is no global / env-based fallback: every call site must supply a
 * config resolved from the microgrid row. See `OpenEmsClientConfig`.
 */
export function createOpenEmsClient(config: OpenEmsClientConfig): OpenEmsClient {
  if (!config.url || !config.url.trim()) {
    throw new OpenEmsError(
      "OpenEMS config is missing a backend URL",
      "OPENEMS_INVALID_CONFIG",
      503
    );
  }

  if (config.type === "cloud_aws") {
    if (!config.accessKeyId || !config.secretAccessKey || !config.region) {
      throw new OpenEmsError(
        "Cloud (AWS) config requires region + accessKeyId + secretAccessKey",
        "OPENEMS_INVALID_CONFIG",
        503
      );
    }
    return new OpenEmsClient(
      config.url,
      new SigV4Auth({
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
        region: config.region,
      })
    );
  }

  // direct_url. Credentials are optional (#327): with both present the client
  // sends HTTP Basic, with neither it behaves exactly as it did before.
  //
  // Requiring BOTH rather than either is deliberate. A username with no
  // password would send `Basic dXNlcjo=` — a well-formed header carrying an
  // empty password — and the backend would reject it as bad credentials
  // rather than as missing ones, sending the operator to check the password
  // they never set. A half-filled form is a configuration error and belongs
  // in the save route's validation, not in a header.
  if (config.username && config.password) {
    return new OpenEmsClient(
      config.url,
      new BasicAuth(config.username, config.password)
    );
  }

  // The OpenEmsAuth contract requires `apply`, so we use an auth-less helper.
  return new OpenEmsClient(config.url, new NoAuth());
}

/**
 * NoAuth — OpenEmsAuth implementation for direct_url mode. Emits only a
 * Content-Type header; no Authorization header. Exported for tests that
 * need to assert on auth type.
 */
export class NoAuth {
  resolveUrl(baseUrl: string): string {
    return `${baseUrl}/jsonrpc`;
  }
  async apply(): Promise<Record<string, string>> {
    return { "Content-Type": "application/json" };
  }
}

export { OpenEmsClient } from "./client";
export { BasicAuth, SigV4Auth } from "./auth";
export type { OpenEmsAuth } from "./auth";
export * from "./types";
export * from "./errors";
