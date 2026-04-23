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

export const SUPER_ADMIN: UserRole = "super_admin";
export const ORG_MANAGER: UserRole = "org_manager";

export const SCOPE_ORG: RoleScopeType = "org";
