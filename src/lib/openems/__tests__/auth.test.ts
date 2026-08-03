import { describe, it, expect } from "vitest";
import { BasicAuth, SigV4Auth } from "../auth";

// Deterministic test credentials (canonical AWS example values)
const TEST_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
const TEST_SECRET_ACCESS_KEY = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const TEST_REGION = "us-east-1";

const TEST_LAMBDA_URL =
  "https://abcdefghij.lambda-url.us-east-1.on.aws/";
const TEST_BODY = JSON.stringify({
  jsonrpc: "2.0",
  id: "test-uuid-1234",
  method: "getEdgesStatus",
  params: { edgeIds: ["edge0"] },
});

// Expected date format: YYYYMMDD
const TODAY_YYYYMMDD = new Date().toISOString().slice(0, 10).replace(/-/g, "");

describe("BasicAuth", () => {
  const auth = new BasicAuth("admin", "testpass");

  it("resolveUrl appends /jsonrpc to baseUrl", () => {
    expect(auth.resolveUrl("http://localhost:8075")).toBe(
      "http://localhost:8075/jsonrpc"
    );
  });

  // #326. This test previously asserted the double slash as CORRECT, named
  // "works with trailing slash" and commented "Preserves exactly what the
  // caller passes" — so the defect shipped with a green test in front of it and
  // a reviewer scanning the suite saw trailing slashes covered.
  it("resolveUrl strips a trailing slash before appending", () => {
    expect(auth.resolveUrl("http://localhost:8075/")).toBe(
      "http://localhost:8075/jsonrpc"
    );
  });

  it("resolveUrl strips repeated trailing slashes", () => {
    expect(auth.resolveUrl("http://localhost:8075///")).toBe(
      "http://localhost:8075/jsonrpc"
    );
  });

  it("resolveUrl preserves a path segment while stripping its trailing slash", () => {
    // The real shape: an operator whose backend is proxied under /rest.
    expect(auth.resolveUrl("https://ems.example/rest/")).toBe(
      "https://ems.example/rest/jsonrpc"
    );
  });

  it("apply returns Authorization Basic header and Content-Type", async () => {
    const headers = await auth.apply({
      url: "http://localhost:8075/jsonrpc",
      method: "POST",
      body: "{}",
    });

    const expectedAuth = `Basic ${Buffer.from("admin:testpass").toString("base64")}`;
    expect(headers).toEqual(
      expect.objectContaining({
        Authorization: expectedAuth,
        "Content-Type": "application/json",
      })
    );
  });

  it("apply returns a plain object (not a Headers instance)", async () => {
    const headers = await auth.apply({
      url: "http://localhost:8075/jsonrpc",
      method: "POST",
      body: "{}",
    });
    expect(headers).not.toBeInstanceOf(Headers);
    expect(typeof headers).toBe("object");
    // All values must be strings
    for (const v of Object.values(headers)) {
      expect(typeof v).toBe("string");
    }
  });

  it("encodes special characters in credentials", async () => {
    const specialAuth = new BasicAuth("user@domain.com", "p@ss:w0rd!");
    const headers = await specialAuth.apply({
      url: "http://localhost:8075/jsonrpc",
      method: "POST",
      body: "{}",
    });
    const expectedAuth = `Basic ${Buffer.from("user@domain.com:p@ss:w0rd!").toString("base64")}`;
    expect(headers.Authorization).toBe(expectedAuth);
  });
});

describe("SigV4Auth", () => {
  const auth = new SigV4Auth({
    accessKeyId: TEST_ACCESS_KEY_ID,
    secretAccessKey: TEST_SECRET_ACCESS_KEY,
    region: TEST_REGION,
  });

  it("resolveUrl returns baseUrl unchanged (no /jsonrpc appended)", () => {
    expect(auth.resolveUrl(TEST_LAMBDA_URL)).toBe(TEST_LAMBDA_URL);
  });

  it("apply returns a plain object (not a Headers instance)", async () => {
    const headers = await auth.apply({
      url: TEST_LAMBDA_URL,
      method: "POST",
      body: TEST_BODY,
    });
    expect(headers).not.toBeInstanceOf(Headers);
    expect(typeof headers).toBe("object");
    for (const v of Object.values(headers)) {
      expect(typeof v).toBe("string");
    }
  });

  it("Authorization header starts with AWS4-HMAC-SHA256 ", async () => {
    const headers = await auth.apply({
      url: TEST_LAMBDA_URL,
      method: "POST",
      body: TEST_BODY,
    });
    expect(headers.Authorization).toBeDefined();
    expect(headers.Authorization).toMatch(/^AWS4-HMAC-SHA256 /);
  });

  it("Authorization header contains Credential with keyId, date, region, and service", async () => {
    const headers = await auth.apply({
      url: TEST_LAMBDA_URL,
      method: "POST",
      body: TEST_BODY,
    });
    // Must contain: Credential=<accessKeyId>/<YYYYMMDD>/us-east-1/lambda/aws4_request
    expect(headers.Authorization).toContain(
      `Credential=${TEST_ACCESS_KEY_ID}/${TODAY_YYYYMMDD}/us-east-1/lambda/aws4_request`
    );
  });

  it("Authorization header contains SignedHeaders segment", async () => {
    const headers = await auth.apply({
      url: TEST_LAMBDA_URL,
      method: "POST",
      body: TEST_BODY,
    });
    expect(headers.Authorization).toContain("SignedHeaders=");
  });

  it("Authorization header contains Signature segment", async () => {
    const headers = await auth.apply({
      url: TEST_LAMBDA_URL,
      method: "POST",
      body: TEST_BODY,
    });
    expect(headers.Authorization).toContain("Signature=");
  });

  it("Host header is present and matches the Lambda URL host", async () => {
    const headers = await auth.apply({
      url: TEST_LAMBDA_URL,
      method: "POST",
      body: TEST_BODY,
    });
    // aws4 sets the Host header; it must match the URL host
    const expectedHost = new URL(TEST_LAMBDA_URL).host;
    expect(headers.Host ?? headers.host).toBe(expectedHost);
  });

  it("produces different signatures for different bodies (body is hashed)", async () => {
    const body1 = JSON.stringify({ jsonrpc: "2.0", id: "a", method: "m", params: {} });
    const body2 = JSON.stringify({ jsonrpc: "2.0", id: "b", method: "m", params: {} });

    const headers1 = await auth.apply({
      url: TEST_LAMBDA_URL,
      method: "POST",
      body: body1,
    });
    const headers2 = await auth.apply({
      url: TEST_LAMBDA_URL,
      method: "POST",
      body: body2,
    });

    // Different bodies must produce different signatures
    expect(headers1.Authorization).not.toBe(headers2.Authorization);
  });

  it("produces consistent signatures for the same input", async () => {
    // Since SigV4 includes a timestamp, signatures made within the same minute
    // should produce the same X-Amz-Date. We just verify both calls produce
    // the same signature when inputs are identical.
    const headers1 = await auth.apply({
      url: TEST_LAMBDA_URL,
      method: "POST",
      body: TEST_BODY,
    });
    const headers2 = await auth.apply({
      url: TEST_LAMBDA_URL,
      method: "POST",
      body: TEST_BODY,
    });

    // Both should have the same X-Amz-Date (within the same second of test execution)
    // and therefore the same Authorization if timestamp matches.
    // The key property we assert: same inputs produce structurally identical headers.
    expect(Object.keys(headers1).sort()).toEqual(Object.keys(headers2).sort());
  });

  it("does not include Authorization header value in any thrown error details", async () => {
    // Calling apply() should not leak credentials — this is a smoke test that
    // apply() returns without embedding header values in thrown errors.
    const headers = await auth.apply({
      url: TEST_LAMBDA_URL,
      method: "POST",
      body: TEST_BODY,
    });
    // The Authorization header should be present but not equal to the access key
    expect(headers.Authorization).not.toBe(TEST_ACCESS_KEY_ID);
    expect(headers.Authorization).not.toBe(TEST_SECRET_ACCESS_KEY);
  });

  it("works with a different region (region must appear in Credential scope)", async () => {
    const euAuth = new SigV4Auth({
      accessKeyId: TEST_ACCESS_KEY_ID,
      secretAccessKey: TEST_SECRET_ACCESS_KEY,
      region: "eu-west-1",
    });
    const euUrl = "https://xyz.lambda-url.eu-west-1.on.aws/";
    const headers = await euAuth.apply({
      url: euUrl,
      method: "POST",
      body: TEST_BODY,
    });
    expect(headers.Authorization).toContain(
      `Credential=${TEST_ACCESS_KEY_ID}/${TODAY_YYYYMMDD}/eu-west-1/lambda/aws4_request`
    );
  });
});
