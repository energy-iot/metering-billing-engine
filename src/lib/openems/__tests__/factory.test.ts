import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getOpenEmsClient } from "../index";
import { OpenEmsClient } from "../client";
import { BasicAuth, SigV4Auth } from "../auth";
import { OpenEmsError } from "../errors";

// Helper: cast the returned client to access the private `auth` field for assertions.
// We do NOT add test-only exports to production code.
function getAuth(client: OpenEmsClient): unknown {
  return (client as unknown as { auth: unknown }).auth;
}

describe("getOpenEmsClient() factory dispatch", () => {
  beforeEach(() => {
    // Clear all relevant env vars before each test
    vi.stubEnv("OPENEMS_B2B_URL", undefined as unknown as string);
    vi.stubEnv("OPENEMS_B2B_USERNAME", undefined as unknown as string);
    vi.stubEnv("OPENEMS_B2B_PASSWORD", undefined as unknown as string);
    vi.stubEnv("OPENEMS_AWS_ACCESS_KEY_ID", undefined as unknown as string);
    vi.stubEnv("OPENEMS_AWS_SECRET_ACCESS_KEY", undefined as unknown as string);
    vi.stubEnv("OPENEMS_AWS_REGION", undefined as unknown as string);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("Branch A — SigV4 when AWS credentials are present", () => {
    it("returns a SigV4Auth-backed client when AWS creds are set", () => {
      vi.stubEnv("OPENEMS_B2B_URL", "https://abc.lambda-url.us-east-1.on.aws/");
      vi.stubEnv("OPENEMS_AWS_ACCESS_KEY_ID", "AKIAIOSFODNN7EXAMPLE");
      vi.stubEnv("OPENEMS_AWS_SECRET_ACCESS_KEY", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY");

      const client = getOpenEmsClient();

      expect(client).toBeInstanceOf(OpenEmsClient);
      expect(getAuth(client)).toBeInstanceOf(SigV4Auth);
    });

    it("uses us-east-1 as default region when OPENEMS_AWS_REGION is not set", () => {
      vi.stubEnv("OPENEMS_B2B_URL", "https://abc.lambda-url.us-east-1.on.aws/");
      vi.stubEnv("OPENEMS_AWS_ACCESS_KEY_ID", "AKIAIOSFODNN7EXAMPLE");
      vi.stubEnv("OPENEMS_AWS_SECRET_ACCESS_KEY", "secret");
      // OPENEMS_AWS_REGION intentionally NOT set

      const client = getOpenEmsClient();
      expect(getAuth(client)).toBeInstanceOf(SigV4Auth);
    });

    it("prefers SigV4 over Basic even when Basic env vars are also present", () => {
      vi.stubEnv("OPENEMS_B2B_URL", "https://abc.lambda-url.us-east-1.on.aws/");
      vi.stubEnv("OPENEMS_AWS_ACCESS_KEY_ID", "AKIAIOSFODNN7EXAMPLE");
      vi.stubEnv("OPENEMS_AWS_SECRET_ACCESS_KEY", "secret");
      vi.stubEnv("OPENEMS_B2B_USERNAME", "admin");
      vi.stubEnv("OPENEMS_B2B_PASSWORD", "password");

      const client = getOpenEmsClient();
      expect(getAuth(client)).toBeInstanceOf(SigV4Auth);
    });
  });

  describe("Branch B — Basic auth fallback when only Basic env vars are present", () => {
    it("returns a BasicAuth-backed client when only Basic env vars are set", () => {
      vi.stubEnv("OPENEMS_B2B_URL", "http://localhost:8075");
      vi.stubEnv("OPENEMS_B2B_USERNAME", "admin");
      vi.stubEnv("OPENEMS_B2B_PASSWORD", "Icui4cyou");

      const client = getOpenEmsClient();

      expect(client).toBeInstanceOf(OpenEmsClient);
      expect(getAuth(client)).toBeInstanceOf(BasicAuth);
    });

    it("does not use SigV4 when AWS creds are absent", () => {
      vi.stubEnv("OPENEMS_B2B_URL", "http://localhost:8075");
      vi.stubEnv("OPENEMS_B2B_USERNAME", "admin");
      vi.stubEnv("OPENEMS_B2B_PASSWORD", "password");
      // AWS keys intentionally NOT set

      const client = getOpenEmsClient();
      expect(getAuth(client)).toBeInstanceOf(BasicAuth);
      expect(getAuth(client)).not.toBeInstanceOf(SigV4Auth);
    });
  });

  describe("Branch C — throws OPENEMS_INVALID_CONFIG when neither auth set is available", () => {
    it("throws when OPENEMS_B2B_URL is missing entirely", () => {
      // No env vars set at all
      expect(() => getOpenEmsClient()).toThrow(OpenEmsError);
      expect(() => getOpenEmsClient()).toThrow(
        expect.objectContaining({
          code: "OPENEMS_INVALID_CONFIG",
          statusCode: 503,
        })
      );
    });

    it("throws when URL is set but neither auth strategy has credentials", () => {
      vi.stubEnv("OPENEMS_B2B_URL", "http://localhost:8075");
      // No username/password, no AWS creds

      expect(() => getOpenEmsClient()).toThrow(OpenEmsError);
      expect(() => getOpenEmsClient()).toThrow(
        expect.objectContaining({
          code: "OPENEMS_INVALID_CONFIG",
          statusCode: 503,
        })
      );
    });

    it("throws when only access key is set (missing secret key)", () => {
      vi.stubEnv("OPENEMS_B2B_URL", "http://localhost:8075");
      vi.stubEnv("OPENEMS_AWS_ACCESS_KEY_ID", "AKIAIOSFODNN7EXAMPLE");
      // No secret key, no Basic creds

      expect(() => getOpenEmsClient()).toThrow(OpenEmsError);
      expect(() => getOpenEmsClient()).toThrow(
        expect.objectContaining({
          code: "OPENEMS_INVALID_CONFIG",
          statusCode: 503,
        })
      );
    });

    it("throws when only username is set (missing password)", () => {
      vi.stubEnv("OPENEMS_B2B_URL", "http://localhost:8075");
      vi.stubEnv("OPENEMS_B2B_USERNAME", "admin");
      // No password, no AWS creds

      expect(() => getOpenEmsClient()).toThrow(OpenEmsError);
      expect(() => getOpenEmsClient()).toThrow(
        expect.objectContaining({
          code: "OPENEMS_INVALID_CONFIG",
          statusCode: 503,
        })
      );
    });
  });
});
