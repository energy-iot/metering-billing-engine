/**
 * access.ts — unit tests for the server-only auth helpers (#76).
 *
 * All Supabase I/O is mocked. These cover the branch logic in
 *   - getCurrentUserRoles        (unauth → [] / auth → user_roles rows)
 *   - currentUserIsSuperAdmin    (super_admin detection)
 *   - currentUserCanAccessOrg    (super_admin short-circuit + scoped match)
 *   - currentUserCanAccessCommunity  (delegates via communities.org_id)
 *   - currentUserCanAccessMicrogrid  (delegates via microgrids → community → org)
 *
 * RLS enforcement is tested separately in `src/lib/supabase/__tests__/rls.test.ts`.
 */

import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getCurrentUserRoles,
  currentUserIsSuperAdmin,
  currentUserCanAccessOrg,
  currentUserCanAccessCommunity,
  currentUserCanAccessMicrogrid,
} from "../access";

type RoleRow = {
  user_id: string;
  role: string;
  scope_type: string;
  scope_id: string | null;
};

/**
 * Builds a minimal mock SupabaseClient for these helpers. `roles` controls
 * what user_roles returns; `community` and `microgrid` control the parent
 * resolution queries.
 */
function makeMockClient(opts: {
  user: { id: string } | null;
  roles: RoleRow[];
  community?: { id: string; org_id: string } | null;
  microgrid?: { id: string; community_id: string } | null;
}): SupabaseClient {
  const client = {
    auth: {
      getUser: async () => ({
        data: { user: opts.user },
        error: null,
      }),
    },
    from: (table: string) => {
      if (table === "user_roles") {
        return {
          select: () => ({
            eq: () => ({
              returns: () =>
                Promise.resolve({ data: opts.roles, error: null }),
            }),
          }),
        };
      }
      if (table === "communities") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({
                  data: opts.community ?? null,
                  error: null,
                }),
            }),
          }),
        };
      }
      if (table === "microgrids") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({
                  data: opts.microgrid ?? null,
                  error: null,
                }),
            }),
          }),
        };
      }
      throw new Error(`Unexpected table in mock: ${table}`);
    },
  };
  return client as unknown as SupabaseClient;
}

describe("getCurrentUserRoles", () => {
  it("returns [] when there is no authenticated user", async () => {
    const client = makeMockClient({ user: null, roles: [] });
    const roles = await getCurrentUserRoles(client);
    expect(roles).toEqual([]);
  });

  it("returns the user's role rows when authenticated", async () => {
    const rows = [
      {
        user_id: "u1",
        role: "org_manager",
        scope_type: "org",
        scope_id: "org-a",
      },
    ];
    const client = makeMockClient({ user: { id: "u1" }, roles: rows });
    const roles = await getCurrentUserRoles(client);
    expect(roles).toHaveLength(1);
    expect(roles[0].role).toBe("org_manager");
  });
});

describe("currentUserIsSuperAdmin", () => {
  it("returns true for a super_admin", async () => {
    const client = makeMockClient({
      user: { id: "u1" },
      roles: [
        {
          user_id: "u1",
          role: "super_admin",
          scope_type: "org",
          scope_id: null,
        },
      ],
    });
    expect(await currentUserIsSuperAdmin(client)).toBe(true);
  });

  it("returns false for an org_manager", async () => {
    const client = makeMockClient({
      user: { id: "u1" },
      roles: [
        {
          user_id: "u1",
          role: "org_manager",
          scope_type: "org",
          scope_id: "org-a",
        },
      ],
    });
    expect(await currentUserIsSuperAdmin(client)).toBe(false);
  });

  it("returns false for an unauthenticated user", async () => {
    const client = makeMockClient({ user: null, roles: [] });
    expect(await currentUserIsSuperAdmin(client)).toBe(false);
  });
});

describe("currentUserCanAccessOrg", () => {
  it("returns true for super_admin on any org", async () => {
    const client = makeMockClient({
      user: { id: "u1" },
      roles: [
        {
          user_id: "u1",
          role: "super_admin",
          scope_type: "org",
          scope_id: null,
        },
      ],
    });
    expect(await currentUserCanAccessOrg(client, "org-x")).toBe(true);
  });

  it("returns true for org_manager scoped to the same org", async () => {
    const client = makeMockClient({
      user: { id: "u1" },
      roles: [
        {
          user_id: "u1",
          role: "org_manager",
          scope_type: "org",
          scope_id: "org-a",
        },
      ],
    });
    expect(await currentUserCanAccessOrg(client, "org-a")).toBe(true);
  });

  it("returns false for org_manager on a different org", async () => {
    const client = makeMockClient({
      user: { id: "u1" },
      roles: [
        {
          user_id: "u1",
          role: "org_manager",
          scope_type: "org",
          scope_id: "org-a",
        },
      ],
    });
    expect(await currentUserCanAccessOrg(client, "org-b")).toBe(false);
  });

  it("returns false for users with no roles", async () => {
    const client = makeMockClient({ user: { id: "u1" }, roles: [] });
    expect(await currentUserCanAccessOrg(client, "org-a")).toBe(false);
  });
});

describe("currentUserCanAccessCommunity", () => {
  it("delegates via communities.org_id → org access check", async () => {
    const client = makeMockClient({
      user: { id: "u1" },
      roles: [
        {
          user_id: "u1",
          role: "org_manager",
          scope_type: "org",
          scope_id: "org-a",
        },
      ],
      community: { id: "c1", org_id: "org-a" },
    });
    expect(await currentUserCanAccessCommunity(client, "c1")).toBe(true);
  });

  it("returns false when the community's org is not accessible", async () => {
    const client = makeMockClient({
      user: { id: "u1" },
      roles: [
        {
          user_id: "u1",
          role: "org_manager",
          scope_type: "org",
          scope_id: "org-a",
        },
      ],
      community: { id: "c2", org_id: "org-b" },
    });
    expect(await currentUserCanAccessCommunity(client, "c2")).toBe(false);
  });

  it("returns false when the community is not found", async () => {
    const client = makeMockClient({
      user: { id: "u1" },
      roles: [
        {
          user_id: "u1",
          role: "org_manager",
          scope_type: "org",
          scope_id: "org-a",
        },
      ],
      community: null,
    });
    expect(await currentUserCanAccessCommunity(client, "c-missing")).toBe(
      false
    );
  });

  it("super_admin short-circuits without needing the community row", async () => {
    const client = makeMockClient({
      user: { id: "u1" },
      roles: [
        {
          user_id: "u1",
          role: "super_admin",
          scope_type: "org",
          scope_id: null,
        },
      ],
      community: null,
    });
    expect(await currentUserCanAccessCommunity(client, "anything")).toBe(true);
  });
});

describe("currentUserCanAccessMicrogrid", () => {
  it("delegates via microgrids → communities → org", async () => {
    const client = makeMockClient({
      user: { id: "u1" },
      roles: [
        {
          user_id: "u1",
          role: "org_manager",
          scope_type: "org",
          scope_id: "org-a",
        },
      ],
      microgrid: { id: "m1", community_id: "c1" },
      community: { id: "c1", org_id: "org-a" },
    });
    expect(await currentUserCanAccessMicrogrid(client, "m1")).toBe(true);
  });

  it("returns false when the microgrid parent chain lands on a different org", async () => {
    const client = makeMockClient({
      user: { id: "u1" },
      roles: [
        {
          user_id: "u1",
          role: "org_manager",
          scope_type: "org",
          scope_id: "org-a",
        },
      ],
      microgrid: { id: "m2", community_id: "c2" },
      community: { id: "c2", org_id: "org-b" },
    });
    expect(await currentUserCanAccessMicrogrid(client, "m2")).toBe(false);
  });

  it("returns false when the microgrid is not found", async () => {
    const client = makeMockClient({
      user: { id: "u1" },
      roles: [
        {
          user_id: "u1",
          role: "org_manager",
          scope_type: "org",
          scope_id: "org-a",
        },
      ],
      microgrid: null,
    });
    expect(await currentUserCanAccessMicrogrid(client, "missing")).toBe(false);
  });

  it("super_admin short-circuits without any parent lookup", async () => {
    const client = makeMockClient({
      user: { id: "u1" },
      roles: [
        {
          user_id: "u1",
          role: "super_admin",
          scope_type: "org",
          scope_id: null,
        },
      ],
      microgrid: null,
    });
    expect(await currentUserCanAccessMicrogrid(client, "anything")).toBe(true);
  });
});
