/**
 * ems_config_access.test.ts — #321, migration 00053.
 *
 * Asserts the OpenEMS configuration rule against a live local Supabase:
 *
 *   an org manager can configure OpenEMS on any microgrid in their own org,
 *   and on nothing else.
 *
 * Everything here is verified against the DATABASE, not the UI or a mock: the
 * deliverable is a BEFORE UPDATE trigger plus three functions, so a test that
 * only exercised a route would pass with all of them removed.
 *
 * Fixture (two orgs, two microgrids in the first — the sharp case):
 *   ORG_MAIN ─ community ─┬─ MICROGRID_A
 *                         └─ MICROGRID_B
 *   ORG_OTHER ─ community ─ MICROGRID_C
 *
 *   SA      — super_admin
 *   MGR     — org_manager @ ORG_MAIN   (must configure BOTH A and B)
 *   MGR2    — org_manager @ ORG_MAIN   (second manager: the listing surface
 *                                       must name them without any grant)
 *   OUTSIDE — org_manager @ ORG_OTHER  (must configure C and neither A nor B)
 *
 * MGR holding no per-microgrid grant at all is the whole point: under #316
 * they could configure nothing until a super admin granted them each microgrid
 * by hand, and every assertion below would fail.
 *
 * ── What this file can and cannot prove about the trigger ────────────────
 *
 * After #321 the guard trigger's predicate (`user_can_access_microgrid`) and
 * the `microgrids` RLS policy's predicate (`user_can_access_community`) resolve
 * to the same org check, so a writer who fails the trigger also fails RLS and
 * is refused there first — the trigger's own 42501 is not reachable over
 * PostgREST by any non-exempt caller. The cross-org tests below therefore
 * assert the OUTCOME (the write does not land) and say which layer refused,
 * rather than asserting an error code the schema can no longer produce. The
 * trigger still earns its place: it keeps column-level enforcement in the
 * database if the table policy is ever widened (e.g. a read-only viewer role),
 * which is exactly when the app-layer check would be the only thing left.
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
  microgridC: "eeee2222-cccc-4000-8000-000000000001",
  draftPeriod: "eeee3333-aaaa-4000-8000-000000000001",
};

const emails = [
  "ems-cfg-sa@test.local",
  "ems-cfg-mgr@test.local",
  "ems-cfg-mgr2@test.local",
  "ems-cfg-outside@test.local",
  "ems-cfg-creator@test.local",
];

let SA: TestUser, MGR: TestUser, MGR2: TestUser, OUTSIDE: TestUser;
let CREATOR: TestUser;

const skip = shouldSkip();

/** Reads a config column with the service client, bypassing RLS. */
async function readBackendUrl(microgridId: string): Promise<string | null> {
  const svc = await serviceClient();
  const { data } = await svc
    .from("microgrids")
    .select("ems_backend_url")
    .eq("id", microgridId)
    .single();
  return data?.ems_backend_url ?? null;
}

beforeAll(async () => {
  if (skip) return;
  await assertEnvironmentReady();

  const svc = await serviceClient();
  await cleanupTestData({
    orgIds: [FIXTURE.orgMain, FIXTURE.orgOther],
    userEmails: emails,
  });

  const { error: orgErr } = await svc.from("organizations").insert([
    { id: FIXTURE.orgMain, name: "EMSCFG Main" },
    { id: FIXTURE.orgOther, name: "EMSCFG Other" },
  ]);
  if (orgErr) throw new Error(`[fixture] orgs: ${orgErr.message}`);

  const { error: commErr } = await svc.from("communities").insert([
    { id: FIXTURE.communityMain, org_id: FIXTURE.orgMain, name: "EMSCFG CMain" },
    {
      id: FIXTURE.communityOther,
      org_id: FIXTURE.orgOther,
      name: "EMSCFG COther",
    },
  ]);
  if (commErr) throw new Error(`[fixture] communities: ${commErr.message}`);

  const { error: mgErr } = await svc.from("microgrids").insert([
    {
      id: FIXTURE.microgridA,
      community_id: FIXTURE.communityMain,
      name: "EMSCFG A",
      ems_backend_url: "https://initial-a.example.com",
    },
    {
      id: FIXTURE.microgridB,
      community_id: FIXTURE.communityMain,
      name: "EMSCFG B",
      ems_backend_url: "https://initial-b.example.com",
    },
    {
      id: FIXTURE.microgridC,
      community_id: FIXTURE.communityOther,
      name: "EMSCFG C",
      ems_backend_url: "https://initial-c.example.com",
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

  [SA, MGR, MGR2, OUTSIDE, CREATOR] = await Promise.all([
    createTestUser({ email: emails[0], role: "super_admin" }),
    createTestUser({
      email: emails[1],
      role: "org_manager",
      scopeId: FIXTURE.orgMain,
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

// ── 1. The rule ────────────────────────────────────────────────────────────

describe.skipIf(skip)("#321 — an org manager configures their own org", () => {
  it("configures EVERY microgrid in their org, with no per-microgrid grant", async () => {
    // The regression #321 exists to remove: under the previous model this user
    // held no grant and could configure neither of these.
    const svc = await serviceClient();
    const { data: grants } = await svc
      .from("user_roles")
      .select("id")
      .eq("user_id", MGR.userId);
    expect(grants?.length).toBe(1); // exactly the org_manager row

    for (const mgId of [FIXTURE.microgridA, FIXTURE.microgridB]) {
      const url = `https://mgr-configured-${mgId.slice(0, 8)}.example.com`;
      const { error } = await MGR.client
        .from("microgrids")
        .update({ ems_backend_url: url })
        .eq("id", mgId);
      expect(error).toBeNull();
      expect(await readBackendUrl(mgId)).toBe(url);
    }
  });

  it("configures the whole guarded column set, not just the URL", async () => {
    // All six columns the trigger enumerates, in one statement — a partial
    // repoint of the trigger would show up here rather than in the URL-only
    // case above. The ciphertext goes through the same encrypt RPC the route
    // uses, because `microgrids_ems_aws_fields_required` rejects a cloud_aws
    // row with a NULL secret.
    const { data: ciphertext, error: encErr } = await MGR.client.rpc(
      "fn_ems_encrypt_secret",
      { p_plaintext: "test-secret-value" }
    );
    expect(encErr).toBeNull();

    const { error } = await MGR.client
      .from("microgrids")
      .update({
        ems_type: "cloud_aws",
        ems_backend_url: "https://mgr-full-config.example.com",
        ems_aws_region: "eu-central-1",
        ems_aws_access_key_id: "AKIAEXAMPLEEXAMPLE00",
        ems_aws_secret_access_key_encrypted: ciphertext,
        ems_known_edge_ids: ["edge-1", "edge-2"],
      })
      .eq("id", FIXTURE.microgridA);
    expect(error).toBeNull();

    // Reset so later tests (and the direct_url fixtures) are not left in a
    // half-configured cloud_aws state.
    const svc = await serviceClient();
    await svc
      .from("microgrids")
      .update({
        ems_type: "direct_url",
        ems_aws_region: null,
        ems_aws_access_key_id: null,
        ems_aws_secret_access_key_encrypted: null,
      })
      .eq("id", FIXTURE.microgridA);
  });

  it("a second manager in the same org configures the same microgrid", async () => {
    // "An org manager", not "the org manager who created it" — the creator
    // auto-grant is gone and nothing distinguishes these two users.
    const { error } = await MGR2.client
      .from("microgrids")
      .update({ ems_backend_url: "https://mgr2-configured.example.com" })
      .eq("id", FIXTURE.microgridA);
    expect(error).toBeNull();
    expect(await readBackendUrl(FIXTURE.microgridA)).toBe(
      "https://mgr2-configured.example.com"
    );
  });

  it("super_admin still configures any microgrid, including cross-org", async () => {
    const { error } = await SA.client
      .from("microgrids")
      .update({ ems_backend_url: "https://sa-configured.example.com" })
      .eq("id", FIXTURE.microgridC);
    expect(error).toBeNull();
    expect(await readBackendUrl(FIXTURE.microgridC)).toBe(
      "https://sa-configured.example.com"
    );
  });
});

// ── 2. "and on nothing else" ───────────────────────────────────────────────

describe.skipIf(skip)("#321 — and on nothing else", () => {
  it("an org manager cannot configure a microgrid in another org", async () => {
    // Both layers refuse: the row is not visible to this caller under the
    // `microgrids` policy, so the UPDATE matches nothing, and the guard trigger
    // would reject it as well. Assert the outcome — the stored value — rather
    // than an error code, because the policy refuses before the trigger runs
    // and PostgREST reports an UPDATE that matched no rows as a success.
    const before = await readBackendUrl(FIXTURE.microgridA);

    const { data: visible } = await OUTSIDE.client
      .from("microgrids")
      .select("id")
      .eq("id", FIXTURE.microgridA)
      .maybeSingle();
    expect(visible).toBeNull();

    await OUTSIDE.client
      .from("microgrids")
      .update({ ems_backend_url: "https://outside-should-not-land.example.com" })
      .eq("id", FIXTURE.microgridA);

    expect(await readBackendUrl(FIXTURE.microgridA)).toBe(before);
  });

  it("the predicate itself answers false across the org boundary", async () => {
    // The direct answer, with no write involved: the same helper the trigger
    // consults, called as the user over PostgREST.
    const { data: own, error: ownErr } = await OUTSIDE.client.rpc(
      "user_can_access_microgrid",
      { _microgrid_id: FIXTURE.microgridC }
    );
    expect(ownErr).toBeNull();
    expect(own).toBe(true);

    const { data: other } = await OUTSIDE.client.rpc(
      "user_can_access_microgrid",
      { _microgrid_id: FIXTURE.microgridA }
    );
    expect(other).toBe(false);
  });
});

// ── 3. The deprecated alias, which deployed code still calls ──────────────

describe.skipIf(skip)("#321 — user_can_configure_ems alias", () => {
  it("is still callable by an authenticated user and answers the org rule", async () => {
    // This is the acceptance criterion that cannot be checked by reading the
    // migration: a lost grant or a changed signature surfaces to the caller as
    // an error, and the caller turns every error into `false` — the config
    // surface would go read-only for everyone with nothing logged.
    const { data: inOrg, error } = await MGR.client.rpc(
      "user_can_configure_ems",
      { _microgrid_id: FIXTURE.microgridB }
    );
    expect(error).toBeNull();
    expect(inOrg).toBe(true);

    const { data: crossOrg } = await MGR.client.rpc("user_can_configure_ems", {
      _microgrid_id: FIXTURE.microgridC,
    });
    expect(crossOrg).toBe(false);
  });

  it("agrees with user_can_access_microgrid on every fixture microgrid", async () => {
    // It is an alias, not a second rule. If these ever disagree, the alias has
    // grown a body of its own.
    for (const mgId of [
      FIXTURE.microgridA,
      FIXTURE.microgridB,
      FIXTURE.microgridC,
    ]) {
      const { data: viaAlias } = await MGR.client.rpc("user_can_configure_ems", {
        _microgrid_id: mgId,
      });
      const { data: viaHelper } = await MGR.client.rpc(
        "user_can_access_microgrid",
        { _microgrid_id: mgId }
      );
      expect(viaAlias).toBe(viaHelper);
    }
  });
});

// ── 4. The listing surface ────────────────────────────────────────────────

describe.skipIf(skip)("#321 — fn_list_ems_operators lists org managers", () => {
  it("names every org manager of the microgrid's org, and only those", async () => {
    const { data, error } = await MGR.client.rpc("fn_list_ems_operators", {
      _microgrid_id: FIXTURE.microgridA,
    });
    expect(error).toBeNull();

    const ids = (data as { user_id: string }[]).map((r) => r.user_id);
    // Both managers of ORG_MAIN, neither having any per-microgrid grant.
    expect(ids).toContain(MGR.userId);
    expect(ids).toContain(MGR2.userId);
    expect(ids).toContain(CREATOR.userId);
    // Not the other org's manager, and not the super admin (who is listed by
    // the surface copy, not by this function).
    expect(ids).not.toContain(OUTSIDE.userId);
    expect(ids).not.toContain(SA.userId);
  });

  it("lists the OTHER org's managers for the other org's microgrid", async () => {
    const { data } = await SA.client.rpc("fn_list_ems_operators", {
      _microgrid_id: FIXTURE.microgridC,
    });
    const ids = (data as { user_id: string }[]).map((r) => r.user_id);
    expect(ids).toEqual([OUTSIDE.userId]);
  });

  it("returns zero rows to a caller who cannot access the microgrid", async () => {
    // The internal gate is the only gate — this is a directly-callable
    // PostgREST endpoint. Zero rows, not a partial list that looks
    // authoritative.
    const { data, error } = await OUTSIDE.client.rpc("fn_list_ems_operators", {
      _microgrid_id: FIXTURE.microgridA,
    });
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("projects exactly user_id + display_name, with the address fallback", async () => {
    const svc = await serviceClient();
    await svc
      .from("user_profiles")
      .update({ first_name: null, last_name: null })
      .eq("user_id", MGR.userId);

    const { data } = await MGR.client.rpc("fn_list_ems_operators", {
      _microgrid_id: FIXTURE.microgridA,
    });
    const rows = data as Record<string, unknown>[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(["display_name", "user_id"]);
    }
    // Both name columns are nullable; a blank entry in a list whose purpose is
    // naming who can configure is the failure this fallback prevents.
    expect(
      rows.find((r) => r.user_id === MGR.userId)?.display_name
    ).toBe(emails[1]);

    await svc
      .from("user_profiles")
      .update({ first_name: "Grace", last_name: "Hopper" })
      .eq("user_id", MGR.userId);

    const { data: named } = await MGR.client.rpc("fn_list_ems_operators", {
      _microgrid_id: FIXTURE.microgridA,
    });
    expect(
      (named as Record<string, unknown>[]).find(
        (r) => r.user_id === MGR.userId
      )?.display_name
    ).toBe("Grace Hopper");
  });
});

// ── 5. What #316 left behind is gone ──────────────────────────────────────

describe.skipIf(skip)("#321 — the ems_operator grant model is retired", () => {
  it("no ems_operator rows remain anywhere", async () => {
    const svc = await serviceClient();
    const { data } = await svc
      .from("user_roles")
      .select("id")
      .eq("role", "ems_operator");
    expect(data).toEqual([]);
  });

  it("creating a microgrid records created_by and grants nothing", async () => {
    const createdId = "eeee4444-aaaa-4000-8000-000000000001";
    const { error } = await CREATOR.client.from("microgrids").insert({
      id: createdId,
      community_id: FIXTURE.communityMain,
      name: "EMSCFG Created",
    });
    expect(error).toBeNull();

    const svc = await serviceClient();
    // The column survives the ticket — it is the only record of who stood a
    // microgrid up.
    const { data: row } = await svc
      .from("microgrids")
      .select("created_by")
      .eq("id", createdId)
      .single();
    expect(row?.created_by).toBe(CREATOR.userId);

    // ...and the auto-grant trigger does not.
    const { data: grants } = await svc
      .from("user_roles")
      .select("id")
      .eq("user_id", CREATOR.userId)
      .eq("role", "ems_operator");
    expect(grants).toEqual([]);

    // Another manager in the org configures it just the same.
    const { error: otherErr } = await MGR.client
      .from("microgrids")
      .update({ ems_backend_url: "https://not-the-creator.example.com" })
      .eq("id", createdId);
    expect(otherErr).toBeNull();
  });
});

// ── 6. Unchanged from #316, and must stay that way ────────────────────────

describe.skipIf(skip)("#321 — the trigger's other behaviours are untouched", () => {
  it("service_role can write the config columns with an open draft period", async () => {
    // The exemption is not dead weight: on a service-role connection auth.uid()
    // is NULL, so the predicate returns false. Without it, incident-time
    // credential rotation would be blocked — including mid-period, which is
    // exactly when it happens.
    const svc = await serviceClient();
    const { data: periods } = await svc
      .from("billing_periods")
      .select("id")
      .eq("microgrid_id", FIXTURE.microgridA)
      .eq("status", "draft");
    expect(periods?.length).toBeGreaterThan(0);

    const { error } = await svc
      .from("microgrids")
      .update({ ems_backend_url: "https://svc-role-write.example.com" })
      .eq("id", FIXTURE.microgridA);
    expect(error).toBeNull();
    expect(await readBackendUrl(FIXTURE.microgridA)).toBe(
      "https://svc-role-write.example.com"
    );
  });

  it("a no-change UPDATE that mentions a guarded column is allowed", async () => {
    // The per-column IS DISTINCT FROM checks, not the `UPDATE OF` filter, are
    // what make this pass — `UPDATE OF` keys off the columns named in the
    // statement, so this statement DOES fire the trigger.
    const current = await readBackendUrl(FIXTURE.microgridA);
    const { error } = await MGR.client
      .from("microgrids")
      .update({ ems_backend_url: current })
      .eq("id", FIXTURE.microgridA);
    expect(error).toBeNull();
  });

  it("the ems_last_discover_* health columns stay outside the guarded set", async () => {
    // Discover writes these on the user client after the call completes. If the
    // trigger guarded them by prefix, Discover would break for every viewer who
    // can legitimately run it.
    const { error } = await MGR.client
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

  it("fn_change_user_role still edits an org role without collateral damage", async () => {
    // The multi-row safety #316 added is unaffected by this ticket and closed a
    // real data-loss path: the previous body deleted every role row a user held.
    const { error } = await SA.client.rpc("fn_change_user_role", {
      p_user_id: MGR2.userId,
      p_role: "org_manager",
      p_scope_id: FIXTURE.orgMain,
      p_scope_type: "org",
    });
    expect(error).toBeNull();

    const svc = await serviceClient();
    const { data: rows } = await svc
      .from("user_roles")
      .select("id")
      .eq("user_id", MGR2.userId)
      .eq("scope_type", "org");
    expect(rows?.length).toBe(1);
  });
});
