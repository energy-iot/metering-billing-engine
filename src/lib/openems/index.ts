import { OpenEmsError } from "./errors";
import { OpenEmsClient } from "./client";

export function getOpenEmsClient(): OpenEmsClient {
  const url = process.env.OPENEMS_B2B_URL;
  const username = process.env.OPENEMS_B2B_USERNAME;
  const password = process.env.OPENEMS_B2B_PASSWORD;

  if (!url || !username || !password) {
    throw new OpenEmsError(
      "OpenEMS B2B REST credentials not configured",
      "OPENEMS_INVALID_CONFIG",
      503
    );
  }

  return new OpenEmsClient(url, username, password);
}

export { OpenEmsClient } from "./client";
export * from "./types";
export * from "./errors";
