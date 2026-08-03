/**
 * error-code-copy.test.ts
 *
 * `errorCodeCopy` has a `default:` arm that renders the raw error string. That
 * arm is a legitimate safety net — an older client can send a code this build
 * has never heard of — but it also means **a missing case cannot fail the
 * build**. The switch type-checks either way.
 *
 * That is not hypothetical: the #339 copy entry was written, verified present,
 * and then absent from the commit, and nothing caught it. The generation half
 * would have shipped rendering a raw internal sentence in place of the message
 * that tells the operator what to do.
 *
 * So the exhaustiveness is asserted here instead. The list below is derived
 * from the union at its definition, not re-typed: adding a code to
 * `GenerationErrorCode` without copy fails this file.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { errorCodeCopy } from "../error-code-copy";

/** Every member of `GenerationErrorCode`, read from the source of truth. */
function declaredCodes(): string[] {
  const src = readFileSync(
    join(process.cwd(), "src", "lib", "billing", "generate.ts"),
    "utf8"
  );
  const block = src.match(
    /export type GenerationErrorCode =([\s\S]*?);\n/
  );
  if (!block) throw new Error("Could not locate GenerationErrorCode");
  return [...new Set([...block[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]))];
}

describe("errorCodeCopy", () => {
  const codes = declaredCodes();

  it("parses a non-empty code list from the union", () => {
    // Guards the guard: a regex that matched nothing would make the assertion
    // below vacuously true, which is the failure mode this file exists to stop
    // one level down.
    expect(codes.length).toBeGreaterThan(5);
  });

  it.each(codes)("has dedicated copy for %s", (code) => {
    const copy = errorCodeCopy({
      householdId: "00000000-0000-4000-8000-000000000001",
      householdName: "Nakato",
      error: "RAW_INTERNAL_STRING",
      code,
    });

    // The default arm renders `${name}: ${err.error}`. Hitting it means the
    // operator reads an internal message rather than an instruction.
    expect(copy).not.toContain("RAW_INTERNAL_STRING");
    expect(copy).toContain("Nakato");
  });
});
