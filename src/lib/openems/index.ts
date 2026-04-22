import { OpenEmsError } from "./errors";
import { OpenEmsClient } from "./client";
import { BasicAuth, SigV4Auth } from "./auth";

export function getOpenEmsClient(): OpenEmsClient {
  const url = process.env.OPENEMS_B2B_URL;
  if (!url) {
    throw new OpenEmsError(
      "OPENEMS_B2B_URL not set",
      "OPENEMS_INVALID_CONFIG",
      503
    );
  }

  // SigV4-first: if AWS credentials are present, use Lambda Function URL auth
  const accessKeyId = process.env.OPENEMS_AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.OPENEMS_AWS_SECRET_ACCESS_KEY;
  if (accessKeyId && secretAccessKey) {
    return new OpenEmsClient(
      url,
      new SigV4Auth({
        accessKeyId,
        secretAccessKey,
        region: process.env.OPENEMS_AWS_REGION ?? "us-east-1",
      })
    );
  }

  // Basic fallback: local Docker / direct OpenEMS B2B endpoint
  const username = process.env.OPENEMS_B2B_USERNAME;
  const password = process.env.OPENEMS_B2B_PASSWORD;
  if (username && password) {
    return new OpenEmsClient(url, new BasicAuth(username, password));
  }

  throw new OpenEmsError(
    "OpenEMS auth not configured (need either AWS creds for SigV4 or B2B user/password for Basic)",
    "OPENEMS_INVALID_CONFIG",
    503
  );
}

export { OpenEmsClient } from "./client";
export { BasicAuth, SigV4Auth } from "./auth";
export type { OpenEmsAuth } from "./auth";
export * from "./types";
export * from "./errors";
