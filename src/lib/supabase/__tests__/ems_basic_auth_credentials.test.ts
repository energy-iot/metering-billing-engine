/**
 * ems_basic_auth_credentials.test.ts — #327, migration 00054.
 *
 * Two things, and the second matters more than the first.
 *
 * 1. The credential columns behave like the AWS secret: encrypted at rest,
 *    readable only through a service_role function, and covered by the
 *    configuration guard.
 *
 * 2. **The guard's column enumeration is complete.** `fn_microgrids_guard_ems_config`
 *    names its columns literally, in two places, because prefix matching would
 *    absorb the `ems_last_discover_*` health columns that Discover must keep
 *    writing. The cost of that correctness is that every future `ems_*` config
 *    column has to be added by hand, in both places, and forgetting leaves the
 *    column silently unguarded — no error, no warning, and nothing that fails.
 *
 *    That completeness check is NOT here. PostgREST exposes no SQL-execution
 *    surface, and inventing one for a test would be a worse idea than reading
 *    the migration text — so it lives in
 *    `src/lib/__tests__/ems-guard-enumeration.test.ts`, needs no database, and
 *    runs in every CI job rather than only where a Supabase is up.
 *
 *    This file covers the behaviour that enumeration produces.
 *
 * Opt-out: SKIP_RLS_TESTS=1, for running without a local Supabase. Since #324
 * the merge gate does NOT set that flag — these assertions run in CI against a
 * Supabase started on the runner.
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

const skip = shouldSkip();

const FIXTURE = {
  org: "ccbb0000-aaaa-4000-8000-000000000001",
  orgOther: "ccbb0000-bbbb-4000-8000-000000000001",
  community: "ccbb1111-aaaa-4000-8000-000000000001",
  communityOther: "ccbb1111-bbbb-4000-8000-000000000001",
  microgrid: "ccbb2222-aaaa-4000-8000-000000000001",
} as const;

const EMAILS = ["ems-cred-mgr@test.local", "ems-cred-outside@test.local"];

describe.skipIf(skip)("#327 — OpenEMS Basic credentials (migration 00054)", () => {
  let MGR: TestUser;
  let OUTSIDE: TestUser;

  beforeAll(async () => {
    await assertEnvironmentReady();
    await cleanupTestData({ orgIds: [FIXTURE.org, FIXTURE.orgOther], userEmails: EMAILS });
    const svc = await serviceClient();

    await svc.from("organizations").upsert([
      { id: FIXTURE.org, name: "CredTest Org" },
      { id: FIXTURE.orgOther, name: "CredTest Other Org" },
    ]);
    await svc.from("communities").upsert([
      { id: FIXTURE.community, org_id: FIXTURE.org, name: "CredTest Community" },
      {
        id: FIXTURE.communityOther,
        org_id: FIXTURE.orgOther,
        name: "CredTest Other Community",
      },
    ]);
    await svc.from("microgrids").upsert([
      {
        id: FIXTURE.microgrid,
        community_id: FIXTURE.community,
        name: "CredTest Microgrid",
        currency: "UGX",
        ems_type: "direct_url",
        ems_backend_url: "https://example.invalid/rest",
      },
    ]);

    MGR = await createTestUser({
      email: EMAILS[0],
      role: "org_manager",
      scopeId: FIXTURE.org,
    });
    OUTSIDE = await createTestUser({
      email: EMAILS[1],
      role: "org_manager",
      scopeId: FIXTURE.orgOther,
    });
  }, 60_000);

  afterAll(async () => {
    await cleanupTestData({
      orgIds: [FIXTURE.org, FIXTURE.orgOther],
      userEmails: EMAILS,
    });
  });

  // The completeness of the guard's column enumeration is asserted statically,
  // without a database, in `src/lib/__tests__/ems-guard-enumeration.test.ts` —
  // there is no SQL-execution surface exposed through PostgREST, and inventing
  // one for a test would be a worse idea than reading the migration text.

  // ── Behaviour: the credential columns are inside the guard ──────────────

  it("an org manager can write the credential columns on their own microgrid", async () => {
    const { error } = await MGR.client
      .from("microgrids")
      .update({ ems_basic_auth_username: "openems" })
      .eq("id", FIXTURE.microgrid);

    expect(error).toBeNull();

    const svc = await serviceClient();
    const { data } = await svc
      .from("microgrids")
      .select("ems_basic_auth_username")
      .eq("id", FIXTURE.microgrid)
      .single<{ ems_basic_auth_username: string | null }>();

    expect(data?.ems_basic_auth_username).toBe("openems");
  });

  it("an org manager from another org cannot write the credential columns", async () => {
    const before = "openems";
    const { error } = await OUTSIDE.client
      .from("microgrids")
      .update({ ems_basic_auth_username: "attacker" })
      .eq("id", FIXTURE.microgrid);

    // Which layer refuses is not the assertion — RLS filters the row before the
    // trigger is reached, exactly as ems_config_access.test.ts documents. The
    // assertion is that the value did not change.
    void error;

    const svc = await serviceClient();
    const { data } = await svc
      .from("microgrids")
      .select("ems_basic_auth_username")
      .eq("id", FIXTURE.microgrid)
      .single<{ ems_basic_auth_username: string | null }>();

    expect(data?.ems_basic_auth_username).toBe(before);
  });

  // ── The password is encrypted at rest and unreadable to a user session ──

  it("the stored password is ciphertext, not the plaintext", async () => {
    const svc = await serviceClient();
    const { data: ct } = await svc.rpc("fn_ems_encrypt_secret", {
      p_plaintext: "hunter2-not-a-real-password",
    });

    expect(typeof ct).toBe("string");

    await svc
      .from("microgrids")
      .update({ ems_basic_auth_password_encrypted: ct as string })
      .eq("id", FIXTURE.microgrid);

    const { data } = await svc
      .from("microgrids")
      .select("ems_basic_auth_password_encrypted")
      .eq("id", FIXTURE.microgrid)
      .single<{ ems_basic_auth_password_encrypted: string | null }>();

    expect(data?.ems_basic_auth_password_encrypted).toBeTruthy();
    expect(data?.ems_basic_auth_password_encrypted).not.toContain("hunter2");
  });

  it("fn_get_ems_basic_auth_password is not callable by an authenticated user", async () => {
    const { error } = await MGR.client.rpc(
      "fn_get_ems_basic_auth_password" as never,
      { _microgrid_id: FIXTURE.microgrid } as never
    );

    // Two shapes are acceptable and mean the same thing — see CLAUDE.md's
    // "PostgREST surface varies by REVOKE pattern" table. A NEW function that
    // ships with REVOKE+GRANT in the same DDL typically gives 42501; a fully
    // revoked one can be filtered out of the schema cache entirely (PGRST202).
    expect(error).not.toBeNull();
    const code = error?.code ?? "";
    const message = (error?.message ?? "").toLowerCase();
    expect(
      code === "42501" ||
        code === "PGRST202" ||
        message.includes("permission denied") ||
        message.includes("could not find the function")
    ).toBe(true);
  });

  it("service_role can read the password back through the function", async () => {
    const svc = await serviceClient();
    const { data, error } = await svc.rpc("fn_get_ems_basic_auth_password", {
      _microgrid_id: FIXTURE.microgrid,
    });

    expect(error).toBeNull();
    expect(data).toBe("hunter2-not-a-real-password");
  });

});
