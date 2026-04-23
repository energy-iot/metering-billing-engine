import { OpenEmsError } from "./errors";
import { OpenEmsClient } from "./client";
import { SigV4Auth } from "./auth";

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
 * `direct_url`: Plain (unauthenticated) HTTP POST to an OpenEMS B2B REST
 * endpoint. Per the product decision recorded in #101 amendments, direct_url
 * mode ships with NO auth fields — used for localhost development or
 * unauthenticated self-hosted OpenEMS only. For authenticated self-hosted
 * OpenEMS, use cloud_aws via an authenticated Lambda proxy.
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

  // direct_url — no auth, pass an empty BasicAuth-equivalent (null auth).
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
