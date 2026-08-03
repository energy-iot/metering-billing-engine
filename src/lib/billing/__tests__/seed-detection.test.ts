/**
 * seed-detection.test.ts — #339.
 *
 * The first-ever-period case is the one PM and Designer both reasoned about
 * and neither observed, because the logic was inline in a server component
 * and no test could reach it. That is why it is a module now.
 */

import { describe, it, expect } from "vitest";
import { computeSeedNeeded } from "../seed-detection";

const HH_A = "hh-a";
const HH_B = "hh-b";
const DEV_A = "dev-a";
const DEV_B = "dev-b";

describe("computeSeedNeeded (#339)", () => {
  it("flags a meter with no prior reading", () => {
    expect(
      computeSeedNeeded({
        deviceIdByHouseholdId: { [HH_A]: DEV_A },
        edgeAvailableByHouseholdId: { [HH_A]: true },
        devicesWithPriorEnd: new Set(),
      })
    ).toEqual({ [HH_A]: true });
  });

  it("does not flag a meter that already has a prior reading", () => {
    expect(
      computeSeedNeeded({
        deviceIdByHouseholdId: { [HH_A]: DEV_A },
        edgeAvailableByHouseholdId: { [HH_A]: true },
        devicesWithPriorEnd: new Set([DEV_A]),
      })
    ).toEqual({ [HH_A]: false });
  });

  // A household with no usable edge goes down the manual path; asking it for a
  // meter reading would be asking for a number nobody can read.
  it("does not flag a household whose edge is unavailable", () => {
    expect(
      computeSeedNeeded({
        deviceIdByHouseholdId: { [HH_A]: DEV_A },
        edgeAvailableByHouseholdId: { [HH_A]: false },
        devicesWithPriorEnd: new Set(),
      })
    ).toEqual({ [HH_A]: false });
  });

  // THE case that had no coverage. On a microgrid's first period there are no
  // prior line items at all, so every edge-available household is flagged.
  // PM ruled this correct: MBE cannot tell a new meter at zero from an
  // existing meter at 4,182, and guessing is what produced #339.
  it("flags EVERY edge-available household on a first-ever period", () => {
    expect(
      computeSeedNeeded({
        deviceIdByHouseholdId: { [HH_A]: DEV_A, [HH_B]: DEV_B },
        edgeAvailableByHouseholdId: { [HH_A]: true, [HH_B]: true },
        devicesWithPriorEnd: new Set(), // no prior periods → empty
      })
    ).toEqual({ [HH_A]: true, [HH_B]: true });
  });

  it("is keyed by device, so two households on different meters differ", () => {
    expect(
      computeSeedNeeded({
        deviceIdByHouseholdId: { [HH_A]: DEV_A, [HH_B]: DEV_B },
        edgeAvailableByHouseholdId: { [HH_A]: true, [HH_B]: true },
        devicesWithPriorEnd: new Set([DEV_A]),
      })
    ).toEqual({ [HH_A]: false, [HH_B]: true });
  });

  it("returns nothing for households with no linked meter", () => {
    expect(
      computeSeedNeeded({
        deviceIdByHouseholdId: {},
        edgeAvailableByHouseholdId: { [HH_A]: true },
        devicesWithPriorEnd: new Set(),
      })
    ).toEqual({});
  });
});
