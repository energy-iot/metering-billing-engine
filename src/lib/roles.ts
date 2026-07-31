/**
 * roles.ts — centralised role constants.
 *
 * Import these constants instead of spelling out the string literals inline.
 * The drift-prevention test (src/lib/__tests__/roles.test.ts) asserts that
 * these values exactly match the `user_role` enum in database.gen.ts.
 *
 * DO NOT add client-side canAccessX() helpers here — RLS owns access checks
 * server-side. Client-side checks invite drift and false confidence.
 */
import type { UserRole, RoleScopeType } from "@/lib/types/domain";

// `satisfies` rather than a `: UserRole` annotation: it still fails the build
// if the value stops being a valid role, but keeps each constant's narrow
// literal type. Callers that annotate a narrower union (e.g. the settings
// pages' `"super_admin" | "org_manager"` caller-role prop) would otherwise
// break every time a role is added, which is noise rather than signal.
export const SUPER_ADMIN = "super_admin" satisfies UserRole;
export const ORG_MANAGER = "org_manager" satisfies UserRole;
// Microgrid-scoped OpenEMS configuration (#316). Always paired with
// SCOPE_MICROGRID; see `user_can_configure_ems` for the authoritative rule.
export const EMS_OPERATOR = "ems_operator" satisfies UserRole;

export const SCOPE_ORG = "org" satisfies RoleScopeType;
export const SCOPE_MICROGRID = "microgrid" satisfies RoleScopeType;
