/**
 * seed-detection.ts — which households need a starting meter reading (#339).
 *
 * Extracted from the billing-period page so it can be tested directly. It was
 * inline, and the first-ever-period case — the one both PM and Designer
 * reasoned about and neither observed — was unreachable by any test as a
 * result.
 *
 * ── This MUST agree with `runGenerationFor` ──────────────────────────────
 *
 * `generate.ts` refuses to bill a device that has neither a prior MBE
 * `end_kwh` nor a seed. This decides who the panel asks. If the two disagree
 * in one direction the operator is asked for readings generation does not
 * want; in the other, generation refuses in front of an operator who was
 * never given the chance to supply one. Change them together.
 */

export type SeedDetectionInput = {
  /** Household id → its primary consumption meter's device id. */
  deviceIdByHouseholdId: Record<string, string>;
  /** Household id → whether an OpenEMS-backed reading is possible. */
  edgeAvailableByHouseholdId: Record<string, boolean>;
  /** Device ids that already have a prior MBE-recorded `end_kwh`. */
  devicesWithPriorEnd: ReadonlySet<string>;
};

/**
 * Returns household id → needs a starting reading.
 *
 * A household needs one when its meter can be read by OpenEMS but MBE has no
 * previous reading of that meter to continue from.
 *
 * ── First-ever period ────────────────────────────────────────────────────
 *
 * On a microgrid's first period `devicesWithPriorEnd` is empty, so EVERY
 * edge-available household is flagged. That is correct and deliberate: MBE
 * cannot distinguish a new meter sitting at zero from an existing meter
 * sitting at 4,182, and guessing is precisely what produced #339. The cost is
 * one reading per meter, once, at setup, entered by someone standing where
 * the meters are.
 *
 * The COPY shown for this case must not claim the meters "were billed before
 * they were connected to OpenEMS" — on a genuinely new microgrid that is
 * false, and asserting an unestablished cause is #335's defect.
 */
export function computeSeedNeeded(
  input: SeedDetectionInput
): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [householdId, deviceId] of Object.entries(
    input.deviceIdByHouseholdId
  )) {
    out[householdId] =
      input.edgeAvailableByHouseholdId[householdId] === true &&
      !input.devicesWithPriorEnd.has(deviceId);
  }
  return out;
}
