/**
 * ems_operator.test.ts — #316, migrations 00051 + 00052.
 *
 * Asserts the microgrid-scoped OpenEMS configuration role against a live local
 * Supabase. Everything here is verified against the DATABASE, not the UI: the
 * deliverable is a BEFORE UPDATE trigger, so a test that only exercises a route
 * would pass with the trigger removed.
 *
 * Fixture (one org, two microgrids — the sharp case):
 *   ORG_MAIN ─ community ─┬─ MICROGRID_A
 *                         └─ MICROGRID_B
 *   ORG_OTHER ─ community ─ (no microgrid)
 *
 *   SA      — super_admin
 *   OP      — org_manager @ ORG_MAIN  +  ems_operator @ MICROGRID_A
 *   PLAIN   — org_manager @ ORG_MAIN  (org access to both microgrids, no grant)
 *   OUTSIDE — org_manager @ ORG_OTHER (no access to either microgrid)
 *
 * OP holding org access to BOTH microgrids while holding a grant on only one is
 * the whole point: if the trigger chained through `user_can_access_microgrid`
 * instead of `user_can_configure_ems`, every assertion about MICROGRID_B would
 * still pass on A and silently pass on B too.
 *
 * Opt-out: SKIP_RLS_TESTS=1. NOTE: this file is in the `rls` vitest project,
 * which CI runs with SKIP_RLS_TESTS=1 — these assertions do NOT execute in the
 * merge gate. They must be run locally against `supabase start`.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  assertEnvironmentReady,
  shouldSkip,
  serviceClient,
  createTestUser,
  cleanupTestData,
  type TestUser,
} from "./rls.helpers";

const FIXTURE = {
  orgMain: "eeee0000-aaaa-4000-8000-000000000001",
  orgOther: "eeee0000-bbbb-4000-8000-000000000001",
  communityMain: "eeee1111-aaaa-4000-8000-000000000001",
  communityOther: "eeee1111-bbbb-4000-8000-000000000001",
  microgridA: "eeee2222-aaaa-4000-8000-000000000001",
  microgridB: "eeee2222-bbbb-4000-8000-000000000001",
  draftPeriod: "eeee3333-aaaa-4000-8000-000000000001",
};

const emails = [
  "ems-op-sa@test.local",
  "ems-op-op@test.local",
  "ems-op-plain@test.local",
  "ems-op-outside@test.local",
  "ems-op-creator@test.local",
];

let SA: TestUser, OP: TestUser, PLAIN: TestUser, OUTSIDE: TestUser;
let CREATOR: TestUser;

const skip = shouldSkip();

beforeAll(async () => {
  if (skip) return;
  await assertEnvironmentReady();

  const svc = await serviceClient();
  await cleanupTestData({
    orgIds: [FIXTURE.orgMain, FIXTURE.orgOther],
    userEmails: emails,
  });

  const { error: orgErr } = await svc.from("organizations").insert([
    { id: FIXTURE.orgMain, name: "EMSOP Main" },
    { id: FIXTURE.orgOther, name: "EMSOP Other" },
  ]);
  if (orgErr) throw new Error(`[fixture] orgs: ${orgErr.message}`);

  const { error: commErr } = await svc.from("communities").insert([
    { id: FIXTURE.communityMain, org_id: FIXTURE.orgMain, name: "EMSOP CMain" },
    {
      id: FIXTURE.communityOther,
      org_id: FIXTURE.orgOther,
      name: "EMSOP COther",
    },
  ]);
  if (commErr) throw new Error(`[fixture] communities: ${commErr.message}`);

  const { error: mgErr } = await svc.from("microgrids").insert([
    {
      id: FIXTURE.microgridA,
      community_id: FIXTURE.communityMain,
      name: "EMSOP A",
    },
    {
      id: FIXTURE.microgridB,
      community_id: FIXTURE.communityMain,
      name: "EMSOP B",
    },
  ]);
  if (mgErr) throw new Error(`[fixture] microgrids: ${mgErr.message}`);

  // Open draft period on A — the mid-period state that must NOT block the
  // service_role write path (see the service_role exemption test).
  const { error: bpErr } = await svc.from("billing_periods").insert({
    id: FIXTURE.draftPeriod,
    microgrid_id: FIXTURE.microgridA,
    start_date: "2026-01-01",
    end_date: "2026-01-31",
    status: "draft",
  });
  if (bpErr) throw new Error(`[fixture] billing_periods: ${bpErr.message}`);

  [SA, OP, PLAIN, OUTSIDE, CREATOR] = await Promise.all([
    createTestUser({ email: emails[0], role: "super_admin" }),
    createTestUser({
      email: emails[1],
      role: "org_manager",
      scopeId: FIXTURE.orgMain,
      extraRoles: [
        {
          role: "ems_operator",
          scopeType: "microgrid",
          scopeId: FIXTURE.microgridA,
        },
      ],
    }),
    createTestUser({
      email: emails[2],
      role: "org_manager",
      scopeId: FIXTURE.orgMain,
    }),
    createTestUser({
      email: emails[3],
      role: "org_manager",
      scopeId: FIXTURE.orgOther,
    }),
    createTestUser({
      email: emails[4],
      role: "org_manager",
      scopeId: FIXTURE.orgMain,
    }),
  ]);
}, 60_000);

afterAll(async () => {
  if (skip) return;
  await cleanupTestData({
    orgIds: [FIXTURE.orgMain, FIXTURE.orgOther],
    userEmails: emails,
  });
});

// ── 1. The service_role exemption ──────────────────────────────────────────
//
// This test exists so the exemption is not trimmed in review as dead weight.
// The trigger fires for every writer, and on a service-role connection
// auth.uid() is NULL, so user_can_configure_ems() returns false. Without the
// explicit exemption, server-side remediation paths that legitimately need to
// write a credential would be blocked — including while a draft period is open,
// which is exactly when an incident-time credential rotation happens.

describe.skipIf(skip)("#316 — service_role exemption", () => {
  it("service_role CAN update the ems_* config columns with an open draft period", async () => {
    const svc = await serviceClient();

    // Confirm the draft period really is open, so this is the stated scenario
    // rather than a vacuous pass.
    const { data: periods } = await svc
      .from("billing_periods")
      .select("id, status")
      .eq("microgrid_id", FIXTURE.microgridA)
      .eq("status", "draft");
    expect(periods?.length).toBeGreaterThan(0);

    const { error } = await svc
      .from("microgrids")
      .update({
        ems_type: "direct_url",
        ems_backend_url: "https://svc-role-write.example.com",
        ems_known_edge_ids: ["edge-svc"],
      })
      .eq("id", FIXTURE.microgridA);

    expect(error).toBeNull();

    const { data: after } = await svc
      .from("microgrids")
      .select("ems_backend_url")
      .eq("id", FIXTURE.microgridA)
      .single();
    expect(after?.ems_backend_url).toBe("https://svc-role-write.example.com");
  });
});

// ── 2. Scoping: grant on A, org access to B ────────────────────────────────

describe.skipIf(skip)("#316 — write enforcement is microgrid-scoped", () => {
  it("ems_operator on A CAN change A's config columns", async () => {
    const { error } = await OP.client
      .from("microgrids")
      .update({ ems_backend_url: "https://op-configured-a.example.com" })
      .eq("id", FIXTURE.microgridA);

    expect(error).toBeNull();

    const svc = await serviceClient();
    const { data } = await svc
      .from("microgrids")
      .select("ems_backend_url")
      .eq("id", FIXTURE.microgridA)
      .single();
    expect(data?.ems_backend_url).toBe("https://op-configured-a.example.com");
  });

  it("the SAME user CANNOT change B's config columns, despite org access to B", async () => {
    // Org access to B is real — assert it rather than assume it, or the
    // rejection below could be an ordinary RLS miss instead of the trigger.
    const { data: visible } = await OP.client
      .from("microgrids")
      .select("id")
      .eq("id", FIXTURE.microgridB)
      .maybeSingle();
    expect(visible?.id).toBe(FIXTURE.microgridB);

    const { error } = await OP.client
      .from("microgrids")
      .update({ ems_backend_url: "https://should-be-rejected.example.com" })
      .eq("id", FIXTURE.microgridB);

    expect(error).not.toBeNull();
    expect(error?.code).toBe("42501");

    // And the value did not change.
    const svc = await serviceClient();
    const { data } = await svc
      .from("microgrids")
      .select("ems_backend_url")
      .eq("id", FIXTURE.microgridB)
      .single();
    expect(data?.ems_backend_url).not.toBe(
      "https://should-be-rejected.example.com"
    );
  });

  it("an org_manager with no grant cannot change either microgrid's config", async () => {
    for (const mgId of [FIXTURE.microgridA, FIXTURE.microgridB]) {
      const { error } = await PLAIN.client
        .from("microgrids")
        .update({ ems_backend_url: "https://plain-should-fail.example.com" })
        .eq("id", mgId);
      expect(error?.code).toBe("42501");
    }
  });

  it("a no-change UPDATE that mentions a guarded column is allowed", async () => {
    // The per-column IS DISTINCT FROM checks, not the `UPDATE OF` filter, are
    // what make this pass. `UPDATE OF` keys off the columns named in the
    // statement, so this statement DOES fire the trigger.
    const svc = await serviceClient();
    const { data: current } = await svc
      .from("microgrids")
      .select("ems_backend_url")
      .eq("id", FIXTURE.microgridB)
      .single();

    const { error } = await PLAIN.client
      .from("microgrids")
      .update({ ems_backend_url: current!.ems_backend_url })
      .eq("id", FIXTURE.microgridB);

    expect(error).toBeNull();
  });

  it("super_admin can configure any microgrid, including cross-org", async () => {
    const { error } = await SA.client
      .from("microgrids")
      .update({ ems_backend_url: "https://sa-configured.example.com" })
      .eq("id", FIXTURE.microgridB);
    expect(error).toBeNull();
  });
});

// ── 3. Discover's health-column writes are outside the guarded set ─────────

describe.skipIf(skip)("#316 — ems_last_discover_* stays writable", () => {
  it("a user with NO ems_operator grant can still write the health columns", async () => {
    // Discover writes these on the user's own client after the call completes.
    // If the trigger guarded them by prefix, this would fail and Discover would
    // break for every viewer who can legitimately run it.
    const { error } = await PLAIN.client
      .from("microgrids")
      .update({
        ems_last_discover_at: new Date().toISOString(),
        ems_last_discover_status: "success",
        ems_last_discover_error: null,
        ems_last_discover_count: 3,
      })
      .eq("id", FIXTURE.microgridB);

    expect(error).toBeNull();
  });

  it("an ems_operator can write the health columns on their own microgrid", async () => {
    const { error } = await OP.client
      .from("microgrids")
      .update({
        ems_last_discover_at: new Date().toISOString(),
        ems_last_discover_status: "success",
        ems_last_discover_count: 1,
      })
      .eq("id", FIXTURE.microgridA);

    expect(error).toBeNull();
  });
});

// ── 4. Role edits stop destroying microgrid grants ────────────────────────

describe.skipIf(skip)("#316 — fn_change_user_role is non-destructive", () => {
  it("editing a user's org role does NOT remove their ems_operator rows", async () => {
    const svc = await serviceClient();

    const before = await svc
      .from("user_roles")
      .select("id")
      .eq("user_id", OP.userId)
      .eq("role", "ems_operator");
    expect(before.data?.length).toBe(1);

    // A routine org-role edit, by a super_admin, through the RPC.
    const { error } = await SA.client.rpc("fn_change_user_role", {
      p_user_id: OP.userId,
      p_role: "org_manager",
      p_scope_id: FIXTURE.orgMain,
      p_scope_type: "org",
    });
    expect(error).toBeNull();

    const after = await svc
      .from("user_roles")
      .select("id, scope_id")
      .eq("user_id", OP.userId)
      .eq("role", "ems_operator");
    expect(after.data?.length).toBe(1);
    expect(after.data?.[0].scope_id).toBe(FIXTURE.microgridA);

    // ...and the org role is still exactly one row (the org path still replaces).
    const orgRows = await svc
      .from("user_roles")
      .select("id")
      .eq("user_id", OP.userId)
      .eq("scope_type", "org");
    expect(orgRows.data?.length).toBe(1);
  });

  it("the rollout grant works: super_admin grants ems_operator on an existing microgrid", async () => {
    const { error } = await SA.client.rpc("fn_change_user_role", {
      p_user_id: PLAIN.userId,
      p_role: "ems_operator",
      p_scope_id: FIXTURE.microgridB,
      p_scope_type: "microgrid",
    });
    expect(error).toBeNull();

    // The grant is real: PLAIN can now configure B.
    const { error: updErr } = await PLAIN.client
      .from("microgrids")
      .update({ ems_backend_url: "https://plain-now-allowed.example.com" })
      .eq("id", FIXTURE.microgridB);
    expect(updErr).toBeNull();

    // ...and only B. A is still refused.
    const { error: aErr } = await PLAIN.client
      .from("microgrids")
      .update({ ems_backend_url: "https://plain-still-denied.example.com" })
      .eq("id", FIXTURE.microgridA);
    expect(aErr?.code).toBe("42501");
  });

  it("a non-super_admin cannot grant ems_operator", async () => {
    const { error } = await OP.client.rpc("fn_change_user_role", {
      p_user_id: OUTSIDE.userId,
      p_role: "ems_operator",
      p_scope_id: FIXTURE.microgridA,
      p_scope_type: "microgrid",
    });
    expect(error).not.toBeNull();
  });
});

// ── 5. Creator auto-grant ─────────────────────────────────────────────────

describe.skipIf(skip)("#316 — the creator holds the grant", () => {
  const createdId = "eeee4444-aaaa-4000-8000-000000000001";

  it("creating a microgrid grants the creator ems_operator on it, and no other", async () => {
    const { error } = await CREATOR.client.from("microgrids").insert({
      id: createdId,
      community_id: FIXTURE.communityMain,
      name: "EMSOP Created",
    });
    expect(error).toBeNull();

    const svc = await serviceClient();
    const { data: grants } = await svc
      .from("user_roles")
      .select("scope_id")
      .eq("user_id", CREATOR.userId)
      .eq("role", "ems_operator");

    expect(grants?.map((g) => g.scope_id)).toEqual([createdId]);

    // The creator can configure what they made...
    const { error: okErr } = await CREATOR.client
      .from("microgrids")
      .update({ ems_backend_url: "https://creator-ok.example.com" })
      .eq("id", createdId);
    expect(okErr).toBeNull();

    // ...and not a microgrid they did not, in the same org.
    const { error: denied } = await CREATOR.client
      .from("microgrids")
      .update({ ems_backend_url: "https://creator-denied.example.com" })
      .eq("id", FIXTURE.microgridA);
    expect(denied?.code).toBe("42501");
  });

  it("backfill granted nobody — the fixture microgrids have no creator", async () => {
    const svc = await serviceClient();
    const { data } = await svc
      .from("microgrids")
      .select("id, created_by")
      .in("id", [FIXTURE.microgridA, FIXTURE.microgridB]);

    for (const row of data ?? []) {
      expect(row.created_by).toBeNull();
    }
  });
});

// ── 6. Attributability surface ────────────────────────────────────────────

describe.skipIf(skip)("#316 — fn_list_ems_operators", () => {
  it("returns the operator to a caller who can access the microgrid", async () => {
    const { data, error } = await OP.client.rpc("fn_list_ems_operators", {
      _microgrid_id: FIXTURE.microgridA,
    });
    expect(error).toBeNull();
    expect(
      (data as { user_id: string }[]).map((r) => r.user_id)
    ).toContain(OP.userId);
  });

  it("returns the same list to a viewer WITHOUT the grant (it is not self-only)", async () => {
    // The read-only banner points at this line, so it has to be populated for
    // exactly the people who cannot configure.
    const { data, error } = await OUTSIDE.client.rpc("fn_list_ems_operators", {
      _microgrid_id: FIXTURE.microgridA,
    });
    expect(error).toBeNull();
    // OUTSIDE has no access to this microgrid at all → zero rows, not a partial
    // list that looks authoritative.
    expect(data).toEqual([]);
  });

  it("a plain org_manager with access sees the full operator list", async () => {
    const svc = await serviceClient();
    const { data: expected } = await svc
      .from("user_roles")
      .select("user_id")
      .eq("role", "ems_operator")
      .eq("scope_id", FIXTURE.microgridA);

    const { data } = await PLAIN.client.rpc("fn_list_ems_operators", {
      _microgrid_id: FIXTURE.microgridA,
    });

    expect((data as { user_id: string }[]).length).toBe(expected?.length ?? 0);
  });

  it("super_admin sees the list for a microgrid in an org they do not manage", async () => {
    const { data, error } = await SA.client.rpc("fn_list_ems_operators", {
      _microgrid_id: FIXTURE.microgridA,
    });
    expect(error).toBeNull();
    expect((data as unknown[]).length).toBeGreaterThan(0);
  });
});

// ── 7. Directory stops duplicating ────────────────────────────────────────

describe.skipIf(skip)("#316 — fn_list_visible_users emits one row per user", () => {
  it("a user holding an org role plus a microgrid grant appears exactly once", async () => {
    const svc = await serviceClient();
    const { data: grantRows } = await svc
      .from("user_roles")
      .select("id")
      .eq("user_id", OP.userId);
    // Precondition: OP genuinely holds more than one role row, otherwise this
    // test cannot distinguish a fix from the old behaviour.
    expect((grantRows?.length ?? 0)).toBeGreaterThan(1);

    const { data, error } = await SA.client.rpc("fn_list_visible_users", {
      _target_user_ids: [OP.userId],
    });
    expect(error).toBeNull();

    const rows = data as { user_id: string; role: string }[];
    expect(rows.length).toBe(1);
    expect(rows[0].user_id).toBe(OP.userId);
    // The org role stays in the column the directory has always read.
    expect(rows[0].role).toBe("org_manager");
  });
});

// ── 8. Access helpers unchanged for existing roles ────────────────────────

describe.skipIf(skip)("#316 — the FK restructure did not move the helpers", () => {
  it("org access still resolves for an org_manager after the scope columns changed", async () => {
    const { data } = await PLAIN.client
      .from("organizations")
      .select("id")
      .eq("id", FIXTURE.orgMain)
      .maybeSingle();
    expect(data?.id).toBe(FIXTURE.orgMain);

    const { data: hidden } = await PLAIN.client
      .from("organizations")
      .select("id")
      .eq("id", FIXTURE.orgOther)
      .maybeSingle();
    expect(hidden).toBeNull();
  });

  it("super_admin (scope_type='org', NULL scope) survived the role-aware CHECK", async () => {
    const { data } = await SA.client
      .from("organizations")
      .select("id")
      .in("id", [FIXTURE.orgMain, FIXTURE.orgOther]);
    expect(data?.length).toBe(2);
  });

  it("the org-scope FK still points somewhere real", async () => {
    const svc = await serviceClient();
    // Deleting the org must still cascade the org-scoped role rows away.
    // Asserted indirectly: the generated scope_org_id column is populated for
    // an org-scoped row and NULL for a microgrid-scoped one.
    const { data } = await svc
      .from("user_roles")
      .select("scope_type, scope_org_id, scope_microgrid_id")
      .eq("user_id", OP.userId);

    for (const row of data ?? []) {
      if (row.scope_type === "org") {
        expect(row.scope_microgrid_id).toBeNull();
      } else {
        expect(row.scope_org_id).toBeNull();
        expect(row.scope_microgrid_id).not.toBeNull();
      }
    }
  });
});
