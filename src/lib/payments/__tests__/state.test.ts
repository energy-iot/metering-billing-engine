/**
 * state.test.ts — Full 5×5 transition matrix for assertValidManualTransition
 * AND IPN sibling assertValidIpnTransition (#157, Phase B widening of #124).
 *
 * Manual matrix (5×5 = 25 cells):
 *   - 7 ALLOW   — see ALLOWED_MANUAL_TRANSITIONS
 *   - 5 no_op   — same-state on each enum value
 *   - 13 invalid_transition
 *
 * IPN matrix (5×5 = 25 cells):
 *   - 5 ALLOW   — see ALLOWED_IPN_TRANSITIONS
 *   - 5 no_op   — same-state
 *   - 15 invalid_transition
 */

import { describe, it, expect } from "vitest";
import {
  ALLOWED_IPN_TRANSITIONS,
  ALLOWED_MANUAL_TRANSITIONS,
  assertValidIpnTransition,
  assertValidManualTransition,
  PaymentTransitionError,
  type PaymentStatus,
} from "../state";

// All valid payment statuses (post-#157).
const STATUSES: PaymentStatus[] = [
  "unpaid",
  "paid",
  "failed",
  "refunded",
  "link_generated",
];

function key(from: PaymentStatus, to: PaymentStatus): string {
  return `${from}→${to}`;
}

const MANUAL_ALLOWED = new Set(
  ALLOWED_MANUAL_TRANSITIONS.map((t) => key(t.from, t.to)),
);
const IPN_ALLOWED = new Set(
  ALLOWED_IPN_TRANSITIONS.map((t) => key(t.from, t.to)),
);

describe("assertValidManualTransition — full 5×5 matrix", () => {
  for (const from of STATUSES) {
    for (const to of STATUSES) {
      const k = key(from, to);
      const isSameState = from === to;
      const isAllowed = MANUAL_ALLOWED.has(k);

      if (isAllowed) {
        it(`ALLOW: ${k}`, () => {
          expect(() => assertValidManualTransition(from, to)).not.toThrow();
        });
      } else if (isSameState) {
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
      } else {
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

  it("paid → refunded: allowed (manual refund record)", () => {
    expect(() => assertValidManualTransition("paid", "refunded")).not.toThrow();
  });

  it("link_generated → unpaid: allowed (cancel pending link)", () => {
    expect(() =>
      assertValidManualTransition("link_generated", "unpaid"),
    ).not.toThrow();
  });

  it("link_generated → paid: allowed (out-of-band payment)", () => {
    expect(() =>
      assertValidManualTransition("link_generated", "paid"),
    ).not.toThrow();
  });

  it("link_generated → failed: allowed (record failed attempt)", () => {
    expect(() =>
      assertValidManualTransition("link_generated", "failed"),
    ).not.toThrow();
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

  it("unpaid → refunded: invalid_transition (must go through paid first)", () => {
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

describe("assertValidIpnTransition — full 5×5 matrix", () => {
  for (const from of STATUSES) {
    for (const to of STATUSES) {
      const k = key(from, to);
      const isSameState = from === to;
      const isAllowed = IPN_ALLOWED.has(k);

      if (isAllowed) {
        it(`ALLOW: ${k}`, () => {
          expect(() => assertValidIpnTransition(from, to)).not.toThrow();
        });
      } else if (isSameState) {
        it(`REJECT(no_op): ${k}`, () => {
          try {
            assertValidIpnTransition(from, to);
            expect.fail("should have thrown");
          } catch (err) {
            expect(err).toBeInstanceOf(PaymentTransitionError);
            expect((err as PaymentTransitionError).reason).toBe("no_op");
          }
        });
      } else {
        it(`REJECT(invalid_transition): ${k}`, () => {
          try {
            assertValidIpnTransition(from, to);
            expect.fail("should have thrown");
          } catch (err) {
            expect(err).toBeInstanceOf(PaymentTransitionError);
            expect((err as PaymentTransitionError).reason).toBe(
              "invalid_transition",
            );
          }
        });
      }
    }
  }
});

describe("assertValidIpnTransition — spot-checks", () => {
  it("link_generated → paid: allowed (Pesapal COMPLETED)", () => {
    expect(() =>
      assertValidIpnTransition("link_generated", "paid"),
    ).not.toThrow();
  });

  it("link_generated → failed: allowed (Pesapal FAILED)", () => {
    expect(() =>
      assertValidIpnTransition("link_generated", "failed"),
    ).not.toThrow();
  });

  it("paid → refunded: allowed (Pesapal REVERSED)", () => {
    expect(() => assertValidIpnTransition("paid", "refunded")).not.toThrow();
  });

  it("unpaid → paid: allowed (defensive — race vs. link route)", () => {
    expect(() => assertValidIpnTransition("unpaid", "paid")).not.toThrow();
  });

  it("refunded → anything: invalid_transition (terminal in IPN matrix)", () => {
    expect(() =>
      assertValidIpnTransition("refunded", "paid"),
    ).toThrow(PaymentTransitionError);
  });

  it("failed → paid: invalid_transition (IPN cannot resurrect failed)", () => {
    expect(() => assertValidIpnTransition("failed", "paid")).toThrow(
      PaymentTransitionError,
    );
  });
});
