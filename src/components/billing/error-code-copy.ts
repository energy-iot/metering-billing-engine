// errorCodeCopy — friendly per-error-code copy for partial/full failures
// surfaced inside <RegenerateMultiDialog> and <PreflightPanel> result views.
//
// Codes mirror `GenerationErrorCode` in `src/lib/billing/generate.ts:80-86`.
// The route response includes `error.householdName`, so callers should pass
// that name straight through here — do NOT re-resolve from the `households`
// prop (it may have drifted from the server's view).
//
// Default fallback for unknown / future codes (or missing `code`):
//   `${name}: ${error}` — uses the route's verbatim `error` string.

import type { GenerationErrorCode } from "@/lib/billing/generate";

export interface PartialFailureError {
  householdId: string;
  householdName: string;
  error: string;
  code?: string;
}

export function errorCodeCopy(err: PartialFailureError): string {
  const name = err.householdName;
  switch (err.code as GenerationErrorCode | undefined) {
    case "currently_manual":
      return `${name} is set to manual entry — use per-row regenerate.`;
    case "unknown_household":
      return `${name} no longer belongs to this microgrid.`;
    case "no_meter_reading":
      return `${name} has no current meter reading.`;
    case "missing_openems_config":
      return `${name}'s edge has no OpenEMS connection configured.`;
    case "invalid_manual_reading":
      return `${name} has an invalid manual reading.`;
    case "unmetered_no_manual":
      return `${name} has no meter and no manual reading provided.`;
    default:
      return `${name}: ${err.error}`;
  }
}
