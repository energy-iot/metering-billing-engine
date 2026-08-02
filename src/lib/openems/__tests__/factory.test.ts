import { describe, it, expect } from "vitest";
import { createOpenEmsClient, NoAuth } from "../index";
import { OpenEmsClient } from "../client";
import { BasicAuth, SigV4Auth } from "../auth";
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

  // #327 — optional HTTP Basic credentials on direct_url.
  describe("type='direct_url' with credentials (#327)", () => {
    const base = { type: "direct_url" as const, url: "https://ems.example/rest" };

    it("returns a BasicAuth-backed client when BOTH are present", () => {
      const client = createOpenEmsClient({
        ...base,
        username: "openems",
        password: "s3cret",
      });
      expect(getAuth(client)).toBeInstanceOf(BasicAuth);
    });

    it("emits an Authorization header carrying those credentials", async () => {
      const client = createOpenEmsClient({
        ...base,
        username: "openems",
        password: "s3cret",
      });
      const auth = getAuth(client) as BasicAuth;
      const headers = await auth.apply({ url: base.url, method: "POST", body: "" });
      const expected = `Basic ${Buffer.from("openems:s3cret").toString("base64")}`;
      expect(headers.Authorization).toBe(expected);
    });

    it("falls back to NoAuth when neither is present — unchanged pre-#327 behaviour", () => {
      expect(getAuth(createOpenEmsClient(base))).toBeInstanceOf(NoAuth);
      expect(
        getAuth(createOpenEmsClient({ ...base, username: null, password: null }))
      ).toBeInstanceOf(NoAuth);
    });

    // A half-filled pair must NOT produce a header. `Basic dXNlcjo=` is
    // well-formed and carries an empty password, so the backend reports bad
    // credentials rather than missing ones and the operator goes looking for a
    // password they never set. The save route rejects the half-filled form;
    // this is the second line of defence for any other caller.
    it("falls back to NoAuth when only the username is present", () => {
      expect(
        getAuth(createOpenEmsClient({ ...base, username: "openems" }))
      ).toBeInstanceOf(NoAuth);
    });

    it("falls back to NoAuth when only the password is present", () => {
      expect(
        getAuth(createOpenEmsClient({ ...base, password: "s3cret" }))
      ).toBeInstanceOf(NoAuth);
    });
  });

});
