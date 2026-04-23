import { describe, it, expect } from "vitest";
import { scrubSecretValues } from "../scrub-secrets";

describe("scrubSecretValues", () => {
  const AWS_SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

  it("redacts a secret in a top-level string", () => {
    const out = scrubSecretValues(
      `Auth failed: secret was ${AWS_SECRET}`,
      { secretAccessKey: AWS_SECRET }
    );
    expect(out).toBe("Auth failed: secret was [REDACTED]");
  });

  it("redacts a secret inside nested object fields", () => {
    const input = {
      event: "openems.discover",
      error: {
        message: `SQL error near '${AWS_SECRET}'`,
        details: { raw: AWS_SECRET },
      },
    };
    const out = scrubSecretValues(input, { secretAccessKey: AWS_SECRET });
    expect(out).toEqual({
      event: "openems.discover",
      error: {
        message: "SQL error near '[REDACTED]'",
        details: { raw: "[REDACTED]" },
      },
    });
  });

  it("redacts all occurrences, not only the first", () => {
    const out = scrubSecretValues(
      `${AWS_SECRET} - ${AWS_SECRET}`,
      { secretAccessKey: AWS_SECRET }
    );
    expect(out).toBe("[REDACTED] - [REDACTED]");
  });

  it("handles arrays", () => {
    const out = scrubSecretValues(
      ["plain", AWS_SECRET, { nested: AWS_SECRET }],
      { secretAccessKey: AWS_SECRET }
    );
    expect(out).toEqual(["plain", "[REDACTED]", { nested: "[REDACTED]" }]);
  });

  it("does not mutate the input", () => {
    const input = { body: AWS_SECRET };
    scrubSecretValues(input, { secretAccessKey: AWS_SECRET });
    expect(input.body).toBe(AWS_SECRET);
  });

  it("is a no-op when no secrets are provided", () => {
    const input = { body: AWS_SECRET };
    const out = scrubSecretValues(input, {});
    expect(out).toEqual(input);
  });

  it("ignores short secret values (< 6 chars) to avoid false positives", () => {
    const out = scrubSecretValues("the short admin user", { password: "adm" });
    expect(out).toBe("the short admin user"); // 'adm' was too short to scrub
  });

  it("redacts a password as well", () => {
    const out = scrubSecretValues(
      { url: "postgres://user:PasswordSecret@host/db" },
      { password: "PasswordSecret" }
    );
    expect(out).toEqual({ url: "postgres://user:[REDACTED]@host/db" });
  });

  it("redacts values supplied via `extra`", () => {
    const EXTRA = "EXTRA-TOKEN-abc123xyz";
    const out = scrubSecretValues(`got ${EXTRA} back`, { extra: [EXTRA] });
    expect(out).toBe("got [REDACTED] back");
  });

  it("handles regex metacharacters in the secret literally", () => {
    const weird = "a.b+c*d$e";
    const out = scrubSecretValues(`before ${weird} after`, {
      secretAccessKey: weird,
    });
    expect(out).toBe("before [REDACTED] after");
  });
});
