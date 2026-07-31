/**
 * validateBackendUrl — operator-supplied OpenEMS backend URL (mbe-docs#8).
 *
 * Covers: https accepted; http rejected except localhost; loopback, private
 * and link-local literals rejected (v4 + v6); embedded credentials rejected.
 */

import { describe, it, expect } from "vitest";
import { validateBackendUrl } from "../backend-url";

function expectOk(input: string) {
  const result = validateBackendUrl(input);
  expect(result, `expected ${input} to be accepted`).toMatchObject({ ok: true });
  return result;
}

function expectRejected(input: string) {
  const result = validateBackendUrl(input);
  expect(result.ok, `expected ${input} to be rejected`).toBe(false);
  if (result.ok) throw new Error("unreachable");
  // Every rejection must name the field and say something the operator can act on.
  expect(result.error).toContain("backendUrl");
  expect(result.error.length).toBeGreaterThan(30);
  return result.error;
}

describe("validateBackendUrl", () => {
  describe("scheme", () => {
    it("accepts https URLs", () => {
      expectOk("https://openems.example.com");
      expectOk("https://openems.example.com/");
      expectOk("https://openems.example.com:8443/b2b");
      expectOk("https://abc123.lambda-url.us-east-1.on.aws/");
    });

    it("trims surrounding whitespace and returns the trimmed value", () => {
      const result = validateBackendUrl("  https://openems.example.com/  ");
      expect(result).toEqual({ ok: true, url: "https://openems.example.com/" });
    });

    it("rejects http for a non-localhost host", () => {
      const error = expectRejected("http://openems.example.com");
      expect(error).toContain("https://");
    });

    it("allows http for localhost (documented development case)", () => {
      expectOk("http://localhost:8075");
      expectOk("http://localhost");
      expectOk("https://localhost:8075");
      expectOk("http://openems.localhost:8075");
    });

    it("rejects non-http(s) schemes", () => {
      for (const url of [
        "file:///etc/passwd",
        "ftp://openems.example.com",
        "gopher://openems.example.com",
      ]) {
        expectRejected(url);
      }
    });

    it("rejects values that are not absolute URLs", () => {
      for (const url of [
        "openems.example.com",
        "/jsonrpc",
        "not a url",
        "",
        "   ",
      ]) {
        expectRejected(url);
      }
    });
  });

  describe("embedded credentials", () => {
    it("rejects user:pass@host", () => {
      const error = expectRejected("https://user:pass@openems.example.com");
      expect(error).toContain("credentials");
    });

    it("rejects a username with no password", () => {
      expectRejected("https://user@openems.example.com");
    });
  });

  describe("private, loopback and link-local destinations", () => {
    it("rejects 127.0.0.0/8", () => {
      expectRejected("https://127.0.0.1");
      expectRejected("https://127.1.2.3:8443");
      expectRejected("http://127.0.0.1:8075");
    });

    it("rejects 10.0.0.0/8", () => {
      expectRejected("https://10.0.0.1");
      expectRejected("https://10.255.255.254:8443");
    });

    it("rejects 172.16.0.0/12 without over-blocking neighbouring /16s", () => {
      expectRejected("https://172.16.0.1");
      expectRejected("https://172.31.255.254");
      expectOk("https://172.15.0.1");
      expectOk("https://172.32.0.1");
    });

    it("rejects 192.168.0.0/16", () => {
      expectRejected("https://192.168.0.1");
      expectRejected("https://192.168.1.1:8443");
      expectOk("https://192.167.0.1");
    });

    it("rejects 169.254.0.0/16 (cloud metadata)", () => {
      expectRejected("https://169.254.169.254");
      expectRejected("https://169.254.170.2/latest/meta-data/");
    });

    it("rejects 0.0.0.0/8", () => {
      expectRejected("https://0.0.0.0");
    });

    it("rejects alternative spellings of loopback that the URL parser normalises", () => {
      // WHATWG normalises hex / 32-bit-decimal IPv4 into dotted-decimal.
      expectRejected("https://0x7f.0.0.1");
      expectRejected("https://2130706433");
    });

    it("rejects ::1 and the unspecified IPv6 address", () => {
      expectRejected("https://[::1]");
      expectRejected("https://[::1]:8443");
      expectRejected("https://[::]");
    });

    it("rejects unique-local IPv6 (fc00::/7)", () => {
      expectRejected("https://[fd00::1]");
      expectRejected("https://[fc00::1234:5678]");
    });

    it("rejects link-local IPv6 (fe80::/10)", () => {
      expectRejected("https://[fe80::1]");
    });

    it("rejects IPv4-mapped IPv6 wrapping a blocked address", () => {
      expectRejected("https://[::ffff:169.254.169.254]");
      expectRejected("https://[::ffff:127.0.0.1]");
    });

    it("accepts routable IPv6", () => {
      expectOk("https://[2606:4700:4700::1111]");
    });

    it("accepts routable IPv4 literals", () => {
      expectOk("https://203.0.113.10:8443");
    });

    it("does not block hostnames that merely look private", () => {
      expectOk("https://10-0-0-1.openems.example.com");
      expectOk("https://internal.openems.example.com");
    });
  });

  describe("path handling", () => {
    it("keeps a base path (the client appends /jsonrpc)", () => {
      expectOk("https://openems.example.com/openems");
    });

    it("rejects a query string or fragment", () => {
      expectRejected("https://openems.example.com/?a=b");
      expectRejected("https://openems.example.com/#frag");
    });
  });
});
