/**
 * ems-guard-enumeration.test.ts — the automated form of a rule that has so far
 * only been a comment.
 *
 * `fn_microgrids_guard_ems_config` decides who may change a microgrid's OpenEMS
 * configuration. It names its columns LITERALLY, in two places:
 *
 *   - the `BEFORE UPDATE OF (…)` statement filter on the trigger
 *   - the `IS DISTINCT FROM` value checks in the function body
 *
 * The enumeration is literal on purpose: a prefix match on `ems_%` would absorb
 * the `ems_last_discover_*` health columns, which Discover must keep writing on
 * the operator's own client. The cost of that correctness is that every new
 * `ems_*` configuration column must be added by hand, to both lists, and
 * **forgetting produces no error** — the column is simply unguarded.
 *
 * This test is what turns that from a comment into a failure. It reads the
 * newest migration that defines the guard, extracts both enumerations, and
 * checks them against the columns the schema actually has (via the generated
 * types, which are themselves kept in sync by `npm run db:types:check`).
 *
 * It needs no database, so it runs in every CI job rather than only where a
 * Supabase is up.
 *
 * Deliberately NOT parameterised by a hand-written column list: such a list
 * would need the same manual update as the thing it is checking, and would go
 * stale the same way. Both sides here are derived.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");
const GEN_TYPES = join(process.cwd(), "src", "lib", "types", "database.gen.ts");

/**
 * Columns matching `ems_%` that are health/telemetry rather than configuration
 * and are therefore intentionally OUTSIDE the guard. Discover writes these on
 * the operator's own client after a successful connection test.
 *
 * Adding to this set is a deliberate act. That is the point: exempting a column
 * should require saying so here, in a file whose whole subject is the
 * enumeration, rather than by quietly not adding it to a migration.
 */
const INTENTIONALLY_UNGUARDED = new Set([
  "ems_last_discover_at",
  "ems_last_discover_status",
  "ems_last_discover_error",
  "ems_last_discover_count",
]);

/** The newest migration containing a CREATE TRIGGER for the guard. */
function newestGuardMigration(): { name: string; sql: string } {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (let i = files.length - 1; i >= 0; i--) {
    const sql = readFileSync(join(MIGRATIONS_DIR, files[i]), "utf8");
    if (sql.includes("CREATE TRIGGER trg_microgrids_guard_ems_config")) {
      return { name: files[i], sql };
    }
  }
  throw new Error(
    "No migration defines trg_microgrids_guard_ems_config — did the guard move or get renamed?"
  );
}

/** Columns named in `BEFORE UPDATE OF (…) ON public.microgrids`. */
function statementFilterColumns(sql: string): string[] {
  const m = sql.match(
    /CREATE TRIGGER trg_microgrids_guard_ems_config[\s\S]*?BEFORE UPDATE OF([\s\S]*?)ON public\.microgrids/
  );
  if (!m) throw new Error("Could not parse the BEFORE UPDATE OF column list");
  return [...m[1].matchAll(/\b(ems_[a-z_]+)\b/g)].map((x) => x[1]).sort();
}

/** Columns compared with IS DISTINCT FROM inside the function body. */
function valueCheckColumns(sql: string): string[] {
  const m = sql.match(
    /CREATE OR REPLACE FUNCTION public\.fn_microgrids_guard_ems_config[\s\S]*?\$\$([\s\S]*?)\$\$;/
  );
  if (!m) throw new Error("Could not parse the guard function body");
  return [
    ...new Set(
      [...m[1].matchAll(/NEW\.(ems_[a-z_]+)\s+IS DISTINCT FROM/g)].map(
        (x) => x[1]
      )
    ),
  ].sort();
}

/** Every `ems_*` column on `microgrids`, read from the generated types. */
function schemaEmsColumns(): string[] {
  const src = readFileSync(GEN_TYPES, "utf8");
  const block = src.match(/microgrids:\s*\{\s*Row:\s*\{([\s\S]*?)\n\s*\}/);
  if (!block) throw new Error("Could not locate microgrids.Row in database.gen.ts");
  return [
    ...new Set([...block[1].matchAll(/^\s*(ems_[a-z_]+)\??:/gm)].map((x) => x[1])),
  ].sort();
}

describe("fn_microgrids_guard_ems_config — column enumeration", () => {
  const { name, sql } = newestGuardMigration();
  const statementCols = statementFilterColumns(sql);
  const bodyCols = valueCheckColumns(sql);
  const schemaCols = schemaEmsColumns();

  it("parses a non-empty enumeration from both places", () => {
    // Guards the guard: a regex that silently matched nothing would make every
    // assertion below vacuously true, which is the failure mode this whole file
    // exists to prevent one level down.
    expect(statementCols.length).toBeGreaterThan(0);
    expect(bodyCols.length).toBeGreaterThan(0);
    expect(schemaCols.length).toBeGreaterThan(0);
  });

  it(`the two enumerations in ${name} name the same columns`, () => {
    // BEFORE UPDATE OF decides whether the trigger fires at all; the body
    // decides whether it objects. A column in one and not the other is either
    // unguarded (missing from the statement filter) or dead weight.
    expect(bodyCols).toEqual(statementCols);
  });

  it("every ems_* configuration column on microgrids is guarded", () => {
    const shouldBeGuarded = schemaCols.filter(
      (c) => !INTENTIONALLY_UNGUARDED.has(c)
    );
    const missing = shouldBeGuarded.filter((c) => !statementCols.includes(c));

    expect(
      missing,
      missing.length
        ? `These columns exist on microgrids but are NOT in the guard's enumeration, ` +
            `so anyone who can update the row can change them with no error: ` +
            `${missing.join(", ")}. Add them to BOTH the BEFORE UPDATE OF list and ` +
            `the IS DISTINCT FROM checks in a new migration, or add them to ` +
            `INTENTIONALLY_UNGUARDED here with a reason.`
        : ""
    ).toEqual([]);
  });

  it("the guard does not name columns the schema no longer has", () => {
    const stale = statementCols.filter((c) => !schemaCols.includes(c));
    expect(stale).toEqual([]);
  });

  it("the health columns are not swept into the guard", () => {
    // The inverse failure: a well-meaning switch to prefix matching would take
    // these in and break Discover with a permission error at runtime rather
    // than at migration time.
    const swept = [...INTENTIONALLY_UNGUARDED].filter((c) =>
      statementCols.includes(c)
    );
    expect(swept).toEqual([]);
  });
});
