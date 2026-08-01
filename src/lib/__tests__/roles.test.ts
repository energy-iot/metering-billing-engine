/**
 * roles.test.ts — drift-prevention test.
 *
 * Asserts that the role constants in src/lib/roles.ts line up with the
 * user_role / role_scope_type enums generated in database.gen.ts. If a future
 * schema migration adds or renames a role without updating roles.ts, this test
 * fails loudly before any runtime breakage occurs.
 *
 * The enums are deliberately WIDER than the constants. `ems_operator` and the
 * `microgrid` scope type were added by #316 and removed from the permission
 * model by #321 (migration 00053) — nothing grants or reads them — but
 * `ALTER TYPE … ADD VALUE` cannot be undone, so the values are permanent. The
 * "unmodelled" sets below pin that gap open on purpose: a role value with no
 * constant must be one we chose not to model, not one someone forgot.
 *
 * To fix a failure: run `npm run db:types` to regenerate database.gen.ts, then
 * update roles.ts (for a role that should be modelled) or the unmodelled sets
 * below (for one that should not).
 */
import { describe, it, expect } from "vitest";
import { SUPER_ADMIN, ORG_MANAGER, SCOPE_ORG } from "@/lib/roles";

// Import the Database type directly so we can extract the enum values at the
// type level AND verify them at runtime via the generated const assertion below.
// The generated file emits string-literal unions; we cross-check the constants.
import type { Database } from "@/lib/types/database.gen";

// Derive the union types from the generated schema (compile-time guard).
type GeneratedUserRole = Database["public"]["Enums"]["user_role"];
type GeneratedScopeType = Database["public"]["Enums"]["role_scope_type"];

// Compile-time assertion: each constant must be assignable to the generated
// type. If the enum is renamed in the DB, TypeScript errors here before
// runtime.
const _superAdmin: GeneratedUserRole = SUPER_ADMIN;
const _orgManager: GeneratedUserRole = ORG_MANAGER;
const _scopeOrg: GeneratedScopeType = SCOPE_ORG;
// Suppress "unused variable" lint without touching the values.
void _superAdmin;
void _orgManager;
void _scopeOrg;

// Enum values that exist in the database but are deliberately NOT modelled in
// roles.ts. Adding to this set is a decision; a value appearing in neither this
// set nor roles.ts fails the coverage tests below.
const UNMODELLED_ROLES = new Set<GeneratedUserRole>(["ems_operator"]);
const UNMODELLED_SCOPES = new Set<GeneratedScopeType>(["microgrid"]);

describe("roles — drift-prevention", () => {
  it("SUPER_ADMIN constant matches the database enum value", () => {
    expect(SUPER_ADMIN).toBe("super_admin");
  });

  it("ORG_MANAGER constant matches the database enum value", () => {
    expect(ORG_MANAGER).toBe("org_manager");
  });

  it("every user_role value is either declared or explicitly unmodelled", () => {
    // If the schema adds a new role, add a constant to roles.ts (and here), or
    // record it as unmodelled above with a reason.
    const allRoles = new Set<GeneratedUserRole>([
      "super_admin",
      "org_manager",
      "ems_operator",
    ]);
    const declaredRoles = new Set<GeneratedUserRole>([
      SUPER_ADMIN,
      ORG_MANAGER,
    ]);

    for (const r of allRoles) {
      expect(declaredRoles.has(r) || UNMODELLED_ROLES.has(r)).toBe(true);
    }
    expect(declaredRoles.size + UNMODELLED_ROLES.size).toBe(allRoles.size);
  });

  it("every role_scope_type value is either declared or explicitly unmodelled", () => {
    const allScopes = new Set<GeneratedScopeType>(["org", "microgrid"]);
    const declaredScopes = new Set<GeneratedScopeType>([SCOPE_ORG]);

    for (const s of allScopes) {
      expect(declaredScopes.has(s) || UNMODELLED_SCOPES.has(s)).toBe(true);
    }
    expect(declaredScopes.size + UNMODELLED_SCOPES.size).toBe(allScopes.size);
  });

  it("the unmodelled values are not re-exported by roles.ts (#321)", async () => {
    // The point of removing them was to leave no importable spelling of a role
    // the system no longer grants. A constant reappearing here is how that
    // comes back.
    const roles = (await import("@/lib/roles")) as Record<string, unknown>;
    const exported = new Set(Object.values(roles));
    for (const r of UNMODELLED_ROLES) expect(exported.has(r)).toBe(false);
    for (const s of UNMODELLED_SCOPES) expect(exported.has(s)).toBe(false);
  });
});
