/**
 * Regression guard for issue #257 — defense-in-depth against `.select('*')`
 * on the `households` table within the customerapp API boundary.
 *
 * The `households` table carries PII fields (`primary_phone`, `primary_email`,
 * address columns, `account_number`, `meter_serial`) that the operator-side
 * dashboard is welcome to read but the customerapp boundary must not.
 * `GET /api/v1/microgrids/:id/households` MUST use
 * `HOUSEHOLD_PUBLIC_COLUMNS_FOR_CUSTOMERAPP` (the narrow
 * "id, display_name, microgrid_id" projection) rather than `select("*")`.
 *
 * Mirrors `no-microgrid-star-select.test.ts` (the regression guard from
 * #106) but with TWO important differences:
 *   1. Scoped to `src/app/api/v1/` ONLY — the customerapp boundary. Operator-
 *      side queries on `households` may use `select("*")` if convenient;
 *      that is a different trust boundary and this test does NOT scan it.
 *   2. The constant being enforced (`HOUSEHOLD_PUBLIC_COLUMNS_FOR_CUSTOMERAPP`)
 *      lives in `src/lib/types/household-columns.ts` and is intentionally
 *      narrower than any operator-side household column list.
 *
 * Cheaper than a custom eslint rule; integrates with the existing Vitest setup.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../../..");

// Scope ONLY to the customerapp API boundary. The operator-side household
// reads in src/app/(dashboard) / src/components / src/lib are not restricted.
const ROOTS = [path.join(REPO_ROOT, "src/app/api/v1")];

// Character class on both sides covers single, double, AND backtick quotes.
// Trailing `\*` (without a closing quote) catches both `select("*")` and the
// embed form `select("*, household_devices(...)")`.
const FORBIDDEN = /\.from\(["'`]households["'`]\)[\s\S]{0,200}?\.select\(["'`]\*/;

const ALLOWED_FILES = new Set<string>(); // empty allowlist by design

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "__tests__" || entry === "node_modules") continue;
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walk(full, out);
    } else if (
      stat.isFile() &&
      (full.endsWith(".ts") || full.endsWith(".tsx")) &&
      // Skip co-located test files — they may reference the forbidden pattern
      // in mocks, comments, or fixtures.
      !full.endsWith(".test.ts") &&
      !full.endsWith(".test.tsx")
    ) {
      out.push(full);
    }
  }
  return out;
}

describe("no .select('*') on households within /api/v1/ (issue #257)", () => {
  it("customerapp route files do not call .from('households').select('*')", () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of walk(root)) {
        const rel = path.relative(REPO_ROOT, file);
        if (ALLOWED_FILES.has(rel)) continue;
        const text = readFileSync(file, "utf8");
        if (FORBIDDEN.test(text)) {
          offenders.push(rel);
        }
      }
    }
    expect(
      offenders,
      `\nFound .from("households").select("*") under src/app/api/v1/:\n  ${offenders.join("\n  ")}\n` +
        `Use HOUSEHOLD_PUBLIC_COLUMNS_FOR_CUSTOMERAPP from src/lib/types/household-columns.ts instead.\n` +
        `See issue #257.`,
    ).toEqual([]);
  });
});
