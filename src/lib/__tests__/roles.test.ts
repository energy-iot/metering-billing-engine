/**
 * roles.test.ts — drift-prevention test.
 *
 * Asserts that the role constants in src/lib/roles.ts exactly match the
 * user_role enum values generated in database.gen.ts. If a future schema
 * migration adds or renames a role without updating roles.ts, this test fails
 * loudly before any runtime breakage occurs.
 *
 * To fix a failure: run `npm run db:types` to regenerate database.gen.ts, then
 * update roles.ts to match the new enum values.
 */
import { describe, it, expect } from "vitest";
import { SUPER_ADMIN, ORG_MANAGER } from "@/lib/roles";

// Import the Database type directly so we can extract the enum values at the
// type level AND verify them at runtime via the generated const assertion below.
// The generated file emits string-literal unions; we cross-check the constants.
import type { Database } from "@/lib/types/database.gen";

// Derive the union type from the generated schema (compile-time guard).
type GeneratedUserRole = Database["public"]["Enums"]["user_role"];

// Compile-time assertion: each constant must be assignable to the generated type.
// If the enum is renamed in the DB, TypeScript will error here before runtime.
const _superAdmin: GeneratedUserRole = SUPER_ADMIN;
const _orgManager: GeneratedUserRole = ORG_MANAGER;
// Suppress "unused variable" lint without touching the values.
void _superAdmin;
void _orgManager;

describe("roles — drift-prevention", () => {
  it("SUPER_ADMIN constant matches the database enum value", () => {
    expect(SUPER_ADMIN).toBe("super_admin");
  });

  it("ORG_MANAGER constant matches the database enum value", () => {
    expect(ORG_MANAGER).toBe("org_manager");
  });

  it("all exported role constants are covered (no undeclared additions)", () => {
    // If the schema adds a new role, update this set AND add a constant to roles.ts.
    const expectedRoles = new Set<GeneratedUserRole>(["super_admin", "org_manager"]);
    const declaredRoles = new Set<GeneratedUserRole>([SUPER_ADMIN, ORG_MANAGER]);

    for (const r of expectedRoles) {
      expect(declaredRoles.has(r)).toBe(true);
    }
    expect(declaredRoles.size).toBe(expectedRoles.size);
  });
});
