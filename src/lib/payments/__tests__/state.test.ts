/**
 * state.test.ts — Full 4×4 transition matrix for assertValidManualTransition.
 *
 * 16 cells × 1 test each. 3 allowed, 13 rejected.
 * Verifies correct reason codes per issue #124 section B.
 */

import { describe, it, expect } from "vitest";
import {
  assertValidManualTransition,
  PaymentTransitionError,
  type PaymentStatus,
} from "../state";

// All valid payment statuses.
const STATUSES: PaymentStatus[] = ["unpaid", "paid", "failed", "refunded"];

// The 3 allowed manual transitions (from × to pairs).
const ALLOWED = new Set([
  "unpaid→paid",
  "paid→unpaid",
  "failed→paid",
]);

function key(from: PaymentStatus, to: PaymentStatus): string {
  return `${from}→${to}`;
}

describe("assertValidManualTransition — full 4×4 matrix", () => {
  for (const from of STATUSES) {
    for (const to of STATUSES) {
      const k = key(from, to);
      const isSameState = from === to;
      const isAllowed = ALLOWED.has(k);
      const isNoOp = isSameState;
      const isInvalidTransition = !isAllowed && !isSameState;

      if (isAllowed) {
        it(`ALLOW: ${k}`, () => {
          expect(() => assertValidManualTransition(from, to)).not.toThrow();
        });
      } else if (isNoOp) {
        it(`REJECT(no_op): ${k}`, () => {
          expect(() => assertValidManualTransition(from, to)).toThrow(
            PaymentTransitionError,
          );
          try {
            assertValidManualTransition(from, to);
          } catch (err) {
            expect(err).toBeInstanceOf(PaymentTransitionError);
            const e = err as PaymentTransitionError;
            expect(e.reason).toBe("no_op");
            expect(e.httpStatus).toBe(400);
          }
        });
      } else if (isInvalidTransition) {
        it(`REJECT(invalid_transition): ${k}`, () => {
          expect(() => assertValidManualTransition(from, to)).toThrow(
            PaymentTransitionError,
          );
          try {
            assertValidManualTransition(from, to);
          } catch (err) {
            expect(err).toBeInstanceOf(PaymentTransitionError);
            const e = err as PaymentTransitionError;
            expect(e.reason).toBe("invalid_transition");
            expect(e.httpStatus).toBe(400);
          }
        });
      }
    }
  }
});

// Explicit spot-checks for clarity (belt-and-suspenders alongside the matrix).

describe("assertValidManualTransition — explicit spot-checks", () => {
  it("unpaid → paid: allowed (standard mark-paid)", () => {
    expect(() => assertValidManualTransition("unpaid", "paid")).not.toThrow();
  });

  it("paid → unpaid: allowed (operator correction)", () => {
    expect(() => assertValidManualTransition("paid", "unpaid")).not.toThrow();
  });

  it("failed → paid: allowed (operator override of failed IPN)", () => {
    expect(() => assertValidManualTransition("failed", "paid")).not.toThrow();
  });

  it("unpaid → unpaid: no_op", () => {
    try {
      assertValidManualTransition("unpaid", "unpaid");
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(PaymentTransitionError);
      expect((e as PaymentTransitionError).reason).toBe("no_op");
    }
  });

  it("paid → failed: invalid_transition (IPN domain)", () => {
    try {
      assertValidManualTransition("paid", "failed");
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(PaymentTransitionError);
      expect((e as PaymentTransitionError).reason).toBe("invalid_transition");
    }
  });

  it("refunded → paid: invalid_transition (terminal state)", () => {
    try {
      assertValidManualTransition("refunded", "paid");
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(PaymentTransitionError);
      expect((e as PaymentTransitionError).reason).toBe("invalid_transition");
    }
  });

  it("refunded → refunded: no_op", () => {
    try {
      assertValidManualTransition("refunded", "refunded");
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(PaymentTransitionError);
      expect((e as PaymentTransitionError).reason).toBe("no_op");
    }
  });

  it("unpaid → refunded: invalid_transition", () => {
    try {
      assertValidManualTransition("unpaid", "refunded");
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(PaymentTransitionError);
      expect((e as PaymentTransitionError).reason).toBe("invalid_transition");
    }
  });

  it("failed → unpaid: invalid_transition (IPN re-try domain)", () => {
    try {
      assertValidManualTransition("failed", "unpaid");
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(PaymentTransitionError);
      expect((e as PaymentTransitionError).reason).toBe("invalid_transition");
    }
  });
});
