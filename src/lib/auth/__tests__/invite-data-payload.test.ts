/**
 * invite-data-payload.test.ts — shared payload-builder unit tests
 * (UX5b / #184).
 *
 * The helper produces the `data` object passed to
 * `auth.admin.inviteUserByEmail`. Critical contract:
 *   - null/empty `org_name` and `invited_by_name` are OMITTED from the
 *     returned object (NOT sent as null) so Go's text/template
 *     `{{ if .Data.field }}` branches resolve correctly.
 *   - `app_name` and `role_label` are always present.
 *   - For super_admin targets, `org_name` is omitted entirely.
 *   - Caller name resolution: `first_name + ' ' + last_name` trimmed,
 *     fallback to caller email when both are NULL/empty.
 */
import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { buildInviteDataPayload } from "../invite-data-payload";

// ── Helpers ──────────────────────────────────────────────────────────

function makeCaller(overrides: Partial<User> = {}): User {
  return {
    id: "11111111-1111-4000-8000-000000000001",
    email: "caller@example.com",
    aud: "authenticated",
    app_metadata: {},
    user_metadata: {},
    created_at: "2026-04-23T00:00:00Z",
    ...overrides,
  } as User;
}

/**
 * Build a minimal SupabaseClient mock that returns canned values for
 * the two queries the helper performs:
 *   - .from('user_profiles').select(...).eq(...).maybeSingle() → callerProfile
 *   - .from('organizations').select(...).eq(...).maybeSingle() → orgRow
 */
function makeSupabaseMock(opts: {
  callerProfile?: { first_name: string | null; last_name: string | null } | null;
  callerProfileError?: { message: string } | null;
  orgRow?: { name: string } | null;
  orgRowError?: { message: string } | null;
}): SupabaseClient {
  const fromImpl = vi.fn((table: string) => {
    if (table === "user_profiles") {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: vi.fn(async () => ({
              data: opts.callerProfile ?? null,
              error: opts.callerProfileError ?? null,
            })),
          }),
        }),
      };
    }
    if (table === "organizations") {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: vi.fn(async () => ({
              data: opts.orgRow ?? null,
              error: opts.orgRowError ?? null,
            })),
          }),
        }),
      };
    }
    throw new Error(`Unexpected table: ${table}`);
  });
  return { from: fromImpl } as unknown as SupabaseClient;
}

// ── Tests ────────────────────────────────────────────────────────────

describe("buildInviteDataPayload", () => {
  it("super_admin caller inviting org_manager: includes invited_by_name + org_name", async () => {
    const supabase = makeSupabaseMock({
      callerProfile: { first_name: "Alejandro", last_name: "Malbet" },
      orgRow: { name: "NorthFork Energy" },
    });

    const data = await buildInviteDataPayload({
      caller: makeCaller(),
      targetRole: "org_manager",
      targetOrgId: "aaaaaaaa-aaaa-4000-8000-000000000001",
      supabase,
    });

    expect(data).toEqual({
      invited_by_name: "Alejandro Malbet",
      org_name: "NorthFork Energy",
      role_label: "an organization manager",
      app_name: "Metering & Billing Engine",
    });
  });

  it("super_admin caller inviting super_admin: omits org_name entirely", async () => {
    const supabase = makeSupabaseMock({
      callerProfile: { first_name: "Alejandro", last_name: "Malbet" },
    });

    const data = await buildInviteDataPayload({
      caller: makeCaller(),
      targetRole: "super_admin",
      targetOrgId: null,
      supabase,
    });

    // org_name MUST NOT be a key on the object — Go template `{{ if .Data.org_name }}`
    // semantics rely on the field being absent, not present-with-null.
    expect("org_name" in data).toBe(false);
    expect(data).toEqual({
      invited_by_name: "Alejandro Malbet",
      role_label: "a super administrator",
      app_name: "Metering & Billing Engine",
    });
  });

  it("falls back to caller email when both first_name and last_name are NULL", async () => {
    const supabase = makeSupabaseMock({
      callerProfile: { first_name: null, last_name: null },
      orgRow: { name: "NorthFork Energy" },
    });

    const data = await buildInviteDataPayload({
      caller: makeCaller({ email: "fallback@example.com" }),
      targetRole: "org_manager",
      targetOrgId: "aaaaaaaa-aaaa-4000-8000-000000000001",
      supabase,
    });

    expect(data.invited_by_name).toBe("fallback@example.com");
  });

  it("falls back to caller email when names are empty strings (whitespace)", async () => {
    const supabase = makeSupabaseMock({
      callerProfile: { first_name: "  ", last_name: "" },
      orgRow: { name: "NorthFork Energy" },
    });

    const data = await buildInviteDataPayload({
      caller: makeCaller({ email: "fallback@example.com" }),
      targetRole: "org_manager",
      targetOrgId: "aaaaaaaa-aaaa-4000-8000-000000000001",
      supabase,
    });

    expect(data.invited_by_name).toBe("fallback@example.com");
  });

  it("trims composed name when only one of first/last is set", async () => {
    const supabase = makeSupabaseMock({
      callerProfile: { first_name: "Alejandro", last_name: null },
      orgRow: { name: "NorthFork Energy" },
    });

    const data = await buildInviteDataPayload({
      caller: makeCaller(),
      targetRole: "org_manager",
      targetOrgId: "aaaaaaaa-aaaa-4000-8000-000000000001",
      supabase,
    });

    expect(data.invited_by_name).toBe("Alejandro");
  });

  it("omits invited_by_name when caller has no profile AND no email", async () => {
    const supabase = makeSupabaseMock({
      callerProfile: null,
    });

    const data = await buildInviteDataPayload({
      caller: makeCaller({ email: undefined }),
      targetRole: "super_admin",
      targetOrgId: null,
      supabase,
    });

    expect("invited_by_name" in data).toBe(false);
    expect(data).toEqual({
      role_label: "a super administrator",
      app_name: "Metering & Billing Engine",
    });
  });

  it("omits org_name when org lookup returns null (RLS-hidden org)", async () => {
    const supabase = makeSupabaseMock({
      callerProfile: { first_name: "Alejandro", last_name: "Malbet" },
      orgRow: null,
    });

    const data = await buildInviteDataPayload({
      caller: makeCaller(),
      targetRole: "org_manager",
      targetOrgId: "aaaaaaaa-aaaa-4000-8000-000000000001",
      supabase,
    });

    expect("org_name" in data).toBe(false);
  });

  it("omits org_name when targetOrgId is null for an org_manager target", async () => {
    const supabase = makeSupabaseMock({
      callerProfile: { first_name: "Alejandro", last_name: "Malbet" },
      orgRow: { name: "Should not be looked up" },
    });

    const data = await buildInviteDataPayload({
      caller: makeCaller(),
      targetRole: "org_manager",
      targetOrgId: null,
      supabase,
    });

    expect("org_name" in data).toBe(false);
  });

  it("always returns role_label and app_name (required fields)", async () => {
    const supabase = makeSupabaseMock({
      callerProfile: null,
    });

    const data = await buildInviteDataPayload({
      caller: makeCaller({ email: undefined }),
      targetRole: "org_manager",
      targetOrgId: null,
      supabase,
    });

    expect(data.role_label).toBe("an organization manager");
    expect(data.app_name).toBe("Metering & Billing Engine");
  });
});
