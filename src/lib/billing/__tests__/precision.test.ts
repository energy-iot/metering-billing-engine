import { describe, it, expect } from "vitest";
import { roundKwh, roundAmount } from "../precision";

describe("roundKwh", () => {
  it("rounds 178.3500000000002 (the Peter Ntale fixture) to 178.35", () => {
    expect(roundKwh(178.3500000000002)).toBe(178.35);
  });

  // Numeric vacuity guard: 178.35 === 178.350 in JS, so the bare toBe
  // assertion above is not by itself sufficient to prove the dust is
  // gone. Multiplying by 1000 exposes the integer underneath.
  it("rounds 178.3500000000002 cleanly (× 1000 == 178350)", () => {
    expect(roundKwh(178.3500000000002) * 1000).toBe(178350);
  });

  it("passes through already-clean 3-decimal values unchanged", () => {
    expect(roundKwh(15.117)).toBe(15.117);
    expect(roundKwh(79.686)).toBe(79.686);
    expect(roundKwh(5.001)).toBe(5.001);
  });

  it("rounds zero to zero", () => {
    expect(roundKwh(0)).toBe(0);
  });

  // Round-half-away-from-zero for positive values. JS Math.round is
  // asymmetric at the exact negative half (Math.round(-0.5) === -0),
  // but route validators reject negative inputs upstream — these tests
  // pin the positive-only contract.
  it("rounds positive half-cases away from zero", () => {
    expect(roundKwh(1.2345)).toBe(1.235);
    expect(roundKwh(1.2344)).toBe(1.234);
  });

  // Theoretical negative passthrough — included for completeness even
  // though route validators reject < 0 upstream. No -x.xxx5 test —
  // negative half-cases are explicitly out of contract.
  it("rounds non-half-case negative values", () => {
    expect(roundKwh(-1.2346)).toBe(-1.235);
    expect(roundKwh(-1.2344)).toBe(-1.234);
  });

  // Non-finite passthrough (pin behavior to prevent regression to 0).
  it("returns NaN for NaN input", () => {
    expect(roundKwh(NaN)).toBeNaN();
  });

  it("returns Infinity for Infinity input", () => {
    expect(roundKwh(Infinity)).toBe(Infinity);
  });
});

describe("roundAmount", () => {
  it("rounds 88.4754 down to 88", () => {
    expect(roundAmount(88.4754)).toBe(88);
  });

  // JS Math.round is round-half-away-from-zero for positive values.
  it("rounds 88.5 up to 89 (positive half-away)", () => {
    expect(roundAmount(88.5)).toBe(89);
  });

  it("passes through integer values unchanged", () => {
    expect(roundAmount(13838)).toBe(13838);
    expect(roundAmount(0)).toBe(0);
  });

  it("returns NaN for NaN input", () => {
    expect(roundAmount(NaN)).toBeNaN();
  });

  it("returns Infinity for Infinity input", () => {
    expect(roundAmount(Infinity)).toBe(Infinity);
  });
});
