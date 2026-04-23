import { describe, it, expect } from "vitest";
import { createOpenEmsClient, NoAuth } from "../index";
import { OpenEmsClient } from "../client";
import { SigV4Auth } from "../auth";
import { OpenEmsError } from "../errors";

// Helper: cast the returned client to access the private `auth` field for
// assertions. We do NOT add test-only exports to production code.
function getAuth(client: OpenEmsClient): unknown {
  return (client as unknown as { auth: unknown }).auth;
}

describe("createOpenEmsClient(config)", () => {
  describe("type='cloud_aws'", () => {
    it("returns a SigV4Auth-backed client on valid cloud_aws config", () => {
      const client = createOpenEmsClient({
        type: "cloud_aws",
        url: "https://abc.lambda-url.us-east-1.on.aws/",
        region: "us-east-1",
        accessKeyId: "AKIAIOSFODNN7EXAMPLE",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      });

      expect(client).toBeInstanceOf(OpenEmsClient);
      expect(getAuth(client)).toBeInstanceOf(SigV4Auth);
    });

    it("throws OPENEMS_INVALID_CONFIG when region is missing", () => {
      expect(() =>
        createOpenEmsClient({
          type: "cloud_aws",
          url: "https://abc.lambda-url.us-east-1.on.aws/",
          region: "",
          accessKeyId: "AKIA",
          secretAccessKey: "secret",
        })
      ).toThrow(OpenEmsError);
    });

    it("throws OPENEMS_INVALID_CONFIG when accessKeyId is missing", () => {
      expect(() =>
        createOpenEmsClient({
          type: "cloud_aws",
          url: "https://abc.lambda-url.us-east-1.on.aws/",
          region: "us-east-1",
          accessKeyId: "",
          secretAccessKey: "secret",
        })
      ).toThrow(
        expect.objectContaining({ code: "OPENEMS_INVALID_CONFIG", statusCode: 503 })
      );
    });

    it("throws OPENEMS_INVALID_CONFIG when secretAccessKey is missing", () => {
      expect(() =>
        createOpenEmsClient({
          type: "cloud_aws",
          url: "https://abc.lambda-url.us-east-1.on.aws/",
          region: "us-east-1",
          accessKeyId: "AKIA",
          secretAccessKey: "",
        })
      ).toThrow(
        expect.objectContaining({ code: "OPENEMS_INVALID_CONFIG", statusCode: 503 })
      );
    });
  });

  describe("type='direct_url'", () => {
    it("returns a NoAuth-backed client for direct_url (pilot: no auth fields)", () => {
      const client = createOpenEmsClient({
        type: "direct_url",
        url: "http://localhost:8075",
      });

      expect(client).toBeInstanceOf(OpenEmsClient);
      expect(getAuth(client)).toBeInstanceOf(NoAuth);
    });

    it("throws OPENEMS_INVALID_CONFIG when URL is missing", () => {
      expect(() =>
        createOpenEmsClient({
          type: "direct_url",
          url: "",
        })
      ).toThrow(
        expect.objectContaining({ code: "OPENEMS_INVALID_CONFIG", statusCode: 503 })
      );
    });
  });
});
