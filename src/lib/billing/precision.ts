/**
 * precision.ts — kWh / amount rounding helpers (#227).
 *
 * These helpers exist to cure IEEE-754 float-dust on computed values
 * (e.g. `261.92 - 83.570 === 178.35000000000002`) before those values
 * are written to storage OR surfaced in the UI. The bug they close is
 * documented in #227 — Peter Ntale's row displayed `178.3500000000000`
 * in the in-app billing table.
 *
 * Contract:
 *   - `roundKwh(x)`   → 3 decimals (mWh precision). Meter readings are
 *                       typically reported at this resolution.
 *   - `roundAmount(x)` → integer. UGX has no minor units; the displayed
 *                       grand total is integer; subtotals likewise.
 *
 * Semantics:
 *   - Round-half-away-from-zero for positive values (JS `Math.round`
 *     default). Negative half-cases are NOT in contract — route
 *     validators reject negative inputs upstream.
 *   - Non-finite passthrough (NaN, ±Infinity) is preserved — callers
 *     are responsible for validating finiteness before calling.
 *   - Idempotent: rounding an already-rounded value is a no-op.
 *
 * No side effects. No I/O. Pure functions.
 */

/** Round to 3 decimal places (mWh precision). */
export function roundKwh(x: number): number {
  if (!Number.isFinite(x)) return x;
  return Math.round(x * 1000) / 1000;
}

/** Round to nearest integer (UGX has no minor units). */
export function roundAmount(x: number): number {
  if (!Number.isFinite(x)) return x;
  return Math.round(x);
}
