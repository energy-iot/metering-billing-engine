import { describe, it, expect } from "vitest";
import { buildOrderId, uuidToCrockfordBase32 } from "../order-id";

const CROCKFORD_REGEX = /^[0-9A-HJKMNPQ-TV-Z]{26}$/;
const ORDER_ID_REGEX = /^INV-[0-9A-HJKMNPQ-TV-Z]{26}-\d+$/;

describe("uuidToCrockfordBase32", () => {
  it("encodes a UUID to exactly 26 crockford-base32 chars", () => {
    const out = uuidToCrockfordBase32("00000000-0000-0000-0000-000000000000");
    expect(out).toHaveLength(26);
    expect(out).toMatch(CROCKFORD_REGEX);
  });

  it("is deterministic — same UUID input produces same output", () => {
    const uuid = "5b1d9e2a-7c4f-4d5b-8e6f-1a2b3c4d5e6f";
    expect(uuidToCrockfordBase32(uuid)).toBe(uuidToCrockfordBase32(uuid));
  });

  it("uses only crockford alphabet chars (no I/L/O/U) for 10 random UUIDs", () => {
    for (let i = 0; i < 10; i++) {
      const uuid = crypto.randomUUID();
      const out = uuidToCrockfordBase32(uuid);
      expect(out).toHaveLength(26);
      expect(out).toMatch(CROCKFORD_REGEX);
    }
  });

  it("produces distinct outputs for distinct UUIDs (no-collision sanity)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      seen.add(uuidToCrockfordBase32(crypto.randomUUID()));
    }
    expect(seen.size).toBe(50);
  });

  it("accepts UUIDs without dashes", () => {
    const dashed = "5b1d9e2a-7c4f-4d5b-8e6f-1a2b3c4d5e6f";
    const undashed = dashed.replace(/-/g, "");
    expect(uuidToCrockfordBase32(undashed)).toBe(uuidToCrockfordBase32(dashed));
  });

  it("throws on invalid UUID input", () => {
    expect(() => uuidToCrockfordBase32("not-a-uuid")).toThrow();
    expect(() => uuidToCrockfordBase32("")).toThrow();
  });

  it("encodes the all-ones UUID to the expected high-bit value", () => {
    // 16 bytes of 0xFF = 128 bits set. Crockford encoding of all-ones bits
    // ends with the alphabet's last char in the high-bit nibble; the final
    // char is the 3-bit-payload + 2-bit-zero-pad, so it should be 'W'
    // (binary 11100, decimal 28 — index of 'W' in
    // 0123456789ABCDEFGHJKMNPQRSTVWXYZ).
    const out = uuidToCrockfordBase32("ffffffff-ffff-ffff-ffff-ffffffffffff");
    expect(out).toHaveLength(26);
    expect(out.slice(0, 25)).toBe("Z".repeat(25));
    expect(out[25]).toBe("W");
  });
});

describe("buildOrderId", () => {
  it("matches the INV-{26}-{ms} pattern", () => {
    const id = buildOrderId(crypto.randomUUID());
    expect(id).toMatch(ORDER_ID_REGEX);
  });

  it("stays at or below Pesapal's 50-char limit for 10 random UUIDs", () => {
    for (let i = 0; i < 10; i++) {
      const id = buildOrderId(crypto.randomUUID());
      expect(id.length).toBeLessThanOrEqual(50);
      // Sanity: 4 ('INV-') + 26 (base32) + 1 ('-') + ≥13 (ms) = ≥44.
      expect(id.length).toBeGreaterThanOrEqual(44);
    }
  });

  it("uses the encoded base32 form, not the raw UUID", () => {
    const uuid = "5b1d9e2a-7c4f-4d5b-8e6f-1a2b3c4d5e6f";
    const id = buildOrderId(uuid);
    expect(id).not.toContain(uuid);
    expect(id).toContain(uuidToCrockfordBase32(uuid));
  });
});
