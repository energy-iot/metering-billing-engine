/**
 * timezone.test.ts — IANA timezone validation (#357).
 *
 * The ticket's canonical garbage inputs: "Kampala" (city, not a zone),
 * "" (empty), "UTC+3" (offset, not a zone). All must be rejected; real
 * IANA ids and the literal "UTC" must pass.
 */

import { describe, it, expect } from "vitest";
import {
  validateTimezone,
  isSupportedTimezone,
  canonicalTimezone,
} from "../timezone";

describe("validateTimezone (#357)", () => {
  it("accepts valid IANA zone ids", () => {
    expect(validateTimezone("Africa/Kampala")).toBeNull();
    expect(validateTimezone("Europe/Madrid")).toBeNull();
    expect(validateTimezone("Asia/Kolkata")).toBeNull();
    expect(validateTimezone("America/New_York")).toBeNull();
  });

  it("accepts the literal 'UTC' (schema default, migration 00055)", () => {
    expect(validateTimezone("UTC")).toBeNull();
    expect(isSupportedTimezone("UTC")).toBe(true);
  });

  it("rejects a bare city name ('Kampala')", () => {
    expect(validateTimezone("Kampala")).toMatch(/Invalid timezone/);
  });

  it("rejects the empty string", () => {
    expect(validateTimezone("")).toBe("Timezone is required.");
  });

  it("rejects a raw offset ('UTC+3') — offsets are not zones", () => {
    expect(validateTimezone("UTC+3")).toMatch(/Invalid timezone/);
    expect(validateTimezone("GMT+3")).toMatch(/Invalid timezone/);
  });

  it("rejects made-up zones", () => {
    expect(validateTimezone("Mars/OlympusMons")).toMatch(/Invalid timezone/);
  });

  it("rejects bare abbreviations (no Area/Location shape)", () => {
    // Intl would resolve 'EST', but an abbreviation loses DST identity —
    // the '/' requirement rejects it before Intl gets a say.
    expect(validateTimezone("EST")).toMatch(/Invalid timezone/);
  });

  it("canonicalizes case and aliases for storage", () => {
    expect(canonicalTimezone("africa/kampala")).toBe("Africa/Kampala");
    expect(canonicalTimezone("UTC")).toBe("UTC");
    expect(canonicalTimezone("Kampala")).toBeNull();
    expect(canonicalTimezone("UTC+3")).toBeNull();
    expect(canonicalTimezone("")).toBeNull();
    // Alias resolution is runtime-CLDR-dependent (Asia/Kolkata ↔
    // Asia/Calcutta); assert only that a valid alias resolves to SOME
    // non-null canonical id.
    expect(canonicalTimezone("Asia/Kolkata")).not.toBeNull();
  });
});
