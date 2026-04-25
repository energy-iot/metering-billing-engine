/**
 * Regression guard for issue #106 — defense-in-depth against `.select('*')` on
 * the `microgrids` table.
 *
 * Migration 00018 added `microgrids.ems_aws_secret_access_key_encrypted`
 * (bytea ciphertext, envelope-encrypted via Vault). Any `.select("*")` on
 * `microgrids` lands that ciphertext in JSON API responses and (for SSR pages)
 * the `__NEXT_DATA__` payload sent to every browser. Use the shared
 * `MICROGRID_PUBLIC_COLUMNS` constant instead — see
 * `src/lib/types/microgrid-columns.ts`.
 *
 * This test scans every `.ts`/`.tsx` file under `src/app/`, `src/components/`,
 * and `src/lib/` (excluding `__tests__/` directories AND co-located
 * `*.test.{ts,tsx}` files) and fails if any file matches the pattern
 * `.from("microgrids").select("*` (covers double, single, AND backtick
 * quotes; matches both `select("*")` and the embed form
 * `select("*, communities!inner(...)")`).
 *
 * Cheaper than a custom eslint rule; integrates with the existing Vitest setup.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const ROOTS = ["src/app", "src/components", "src/lib"].map((p) =>
  path.join(REPO_ROOT, p),
);

// Character class on both sides covers single, double, AND backtick quotes.
// Trailing `\*` (without a closing quote) catches both `select("*")` and the
// embed form `select("*, communities!inner(...)")`.
const FORBIDDEN = /\.from\(["'`]microgrids["'`]\)[\s\S]{0,200}?\.select\(["'`]\*/;

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

describe("no .select('*') on microgrids (issue #106)", () => {
  it("source files do not call .from('microgrids').select('*')", () => {
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
      `\nFound .from("microgrids").select("*") in:\n  ${offenders.join("\n  ")}\n` +
        `Use MICROGRID_PUBLIC_COLUMNS from src/lib/types/microgrid-columns.ts instead.\n` +
        `See issue #106.`,
    ).toEqual([]);
  });
});
