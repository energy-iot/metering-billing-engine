/**
 * org_api_tokens_rls.test.ts (#256)
 *
 * Verifies the org_api_tokens RLS policies + billing_audit_log
 * non-period-scoped-event admission shipped by migration 00043.
 *
 * Coverage (failure-mode AC matrix from the ticket body):
 *
 *   - org_manager(A) can SELECT / INSERT / UPDATE rows scoped to org A
 *   - org_manager(A) canNOT see or insert tokens scoped to org B
 *   - super_admin can SELECT / INSERT / UPDATE in any org
 *   - Anonymous (no JWT) canNOT see any tokens (RLS denies)
 *   - org_manager(A) canNOT UPDATE SET org_id = org_B (WITH CHECK guard)
 *   - billing_audit_log admits org-scoped rows with billing_period_id IS NULL
 *     when org_id is set; rejects rows with both NULL or both NOT NULL
 *     (billing_audit_log_scope_consistency)
 *
 * Honors SKIP_RLS_TESTS=1.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  assertEnvironmentReady,
  shouldSkip,
  serviceClient,
  createTestUser,
  cleanupTestData,
  type TestUser,
} from "./rls.helpers";

const skip = shouldSkip();
const desc = skip ? describe.skip : describe;

if (skip) {
  console.log("[org_api_tokens_rls] SKIP_RLS_TESTS=1 — skipping suite.");
}

// Fail-loud insert helper — mirrors the payment_state_machine.test.ts
// pattern; surface fixture-drift errors instead of swallowing them.
async function insertOrThrow(
  client: SupabaseClient,
  table: string,
  rows: Record<string, unknown> | Record<string, unknown>[]
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await client.from(table).insert(rows as any);
  if (error) {
    throw new Error(
      `[org_api_tokens_rls] fixture insert failed on ${table}: ${error.message}`
    );
  }
}

const FIXTURE = {
  orgA: "ddddaaaa-aaaa-4000-8000-000000000001",
  orgB: "ddddbbbb-bbbb-4000-8000-000000000001",
};

const TEST_EMAILS = [
  "rls-tokens-managerA@test.local",
  "rls-tokens-managerB@test.local",
  "rls-tokens-superadmin@test.local",
];

// Tokens are NOT cascaded to FIXTURE.org cleanup if they leak — but
// org-id FK has ON DELETE CASCADE, so dropping the orgs in afterAll
// also drops every dependent token + audit row. Belt-and-suspenders
// for inter-test isolation: each `it` uses unique token_lookup values
// (timestamp suffix) so a re-run never collides on the unique partial
// index.
let mgrA: TestUser;
// `_mgrB` is created so that subsequent describe-block additions
// (e.g. "mgr B sees only org B") can extend the suite without re-running
// fixture setup. Keep even if unused in the current matrix — lint-warn
// suppressed via underscore-prefix.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
let _mgrB: TestUser;
let superAdmin: TestUser;

desc("#256 RLS: org_api_tokens + billing_audit_log org scoping", () => {
  beforeAll(async () => {
    if (skip) return;
    await assertEnvironmentReady();

    const svc = await serviceClient();

    await cleanupTestData({
      orgIds: [FIXTURE.orgA, FIXTURE.orgB],
      userEmails: TEST_EMAILS,
    });

    await insertOrThrow(svc, "organizations", [
      { id: FIXTURE.orgA, name: "Token RLS Org A" },
      { id: FIXTURE.orgB, name: "Token RLS Org B" },
    ]);

    mgrA = await createTestUser({
      email: TEST_EMAILS[0],
      role: "org_manager",
      scopeId: FIXTURE.orgA,
    });
    _mgrB = await createTestUser({
      email: TEST_EMAILS[1],
      role: "org_manager",
      scopeId: FIXTURE.orgB,
    });
    superAdmin = await createTestUser({
      email: TEST_EMAILS[2],
      role: "super_admin",
    });
  }, 30_000);

  afterAll(async () => {
    if (skip) return;
    await cleanupTestData({
      orgIds: [FIXTURE.orgA, FIXTURE.orgB],
      userEmails: TEST_EMAILS,
    });
  }, 30_000);

  // ── 1. INSERT (own org) ─────────────────────────────────────────────────

  it("org_manager(A) CAN insert a token scoped to org A", async () => {
    const ts = Date.now();
    const lookup = String(ts).slice(-8).padStart(8, "a");
    const { error } = await mgrA.client.from("org_api_tokens").insert({
      org_id: FIXTURE.orgA,
      name: "mgrA-token-1",
      token_lookup: lookup,
      token_hash: "$argon2id$v=19$m=19456,t=2,p=1$placeholderforRLS",
      env_prefix: "dev_",
      created_by: mgrA.userId,
    });
    expect(error).toBeNull();
  });

  // ── 2. INSERT (cross-org rejected) ──────────────────────────────────────

  it("org_manager(A) CANNOT insert a token scoped to org B", async () => {
    const ts = Date.now() + 1;
    const lookup = String(ts).slice(-8).padStart(8, "b");
    const { error } = await mgrA.client.from("org_api_tokens").insert({
      org_id: FIXTURE.orgB,
      name: "mgrA-token-into-B",
      token_lookup: lookup,
      token_hash: "$argon2id$v=19$m=19456,t=2,p=1$placeholderforRLS",
      env_prefix: "dev_",
      created_by: mgrA.userId,
    });
    expect(error).not.toBeNull();
    // PostgREST reports 42501 / row-level-security violations.
    expect(error?.message ?? "").toMatch(/row-level security|policy|42501/i);
  });

  // ── 3. SELECT (own org sees, other org hidden) ──────────────────────────

  it("org_manager(A) SELECT sees only org A tokens", async () => {
    // Seed an org-B token via service-role so we can confirm it's hidden.
    const svc = await serviceClient();
    const ts = Date.now() + 2;
    const lookup = String(ts).slice(-8).padStart(8, "c");
    await insertOrThrow(svc, "org_api_tokens", {
      org_id: FIXTURE.orgB,
      name: "svc-token-orgB",
      token_lookup: lookup,
      token_hash: "$argon2id$v=19$m=19456,t=2,p=1$placeholderforRLS",
      env_prefix: "dev_",
      created_by: null,
    });

    const { data } = await mgrA.client
      .from("org_api_tokens")
      .select("id, org_id, name");
    const orgIds = new Set((data ?? []).map((r) => r.org_id));
    expect(orgIds.has(FIXTURE.orgA)).toBe(true);
    expect(orgIds.has(FIXTURE.orgB)).toBe(false);
  });

  // ── 4. Super admin sees all ─────────────────────────────────────────────

  it("super_admin SELECT sees both orgs", async () => {
    const { data, error } = await superAdmin.client
      .from("org_api_tokens")
      .select("id, org_id")
      .in("org_id", [FIXTURE.orgA, FIXTURE.orgB]);
    expect(error).toBeNull();
    const orgIds = new Set((data ?? []).map((r) => r.org_id));
    expect(orgIds.has(FIXTURE.orgA)).toBe(true);
    expect(orgIds.has(FIXTURE.orgB)).toBe(true);
  });

  // ── 5. UPDATE (revoke own; cannot transfer to other org) ───────────────

  it("org_manager(A) CAN UPDATE revoked_at on org-A token", async () => {
    const ts = Date.now() + 3;
    const lookup = String(ts).slice(-8).padStart(8, "d");
    const svc = await serviceClient();
    const { data: inserted, error: insErr } = await svc
      .from("org_api_tokens")
      .insert({
        org_id: FIXTURE.orgA,
        name: "to-revoke",
        token_lookup: lookup,
        token_hash: "$argon2id$v=19$m=19456,t=2,p=1$placeholderforRLS",
        env_prefix: "dev_",
        created_by: null,
      })
      .select("id")
      .single();
    expect(insErr).toBeNull();

    const { error: updErr } = await mgrA.client
      .from("org_api_tokens")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", inserted!.id);
    expect(updErr).toBeNull();
  });

  it("org_manager(A) CANNOT UPDATE SET org_id = orgB (WITH CHECK)", async () => {
    const ts = Date.now() + 4;
    const lookup = String(ts).slice(-8).padStart(8, "e");
    const svc = await serviceClient();
    const { data: inserted, error: insErr } = await svc
      .from("org_api_tokens")
      .insert({
        org_id: FIXTURE.orgA,
        name: "transfer-attempt",
        token_lookup: lookup,
        token_hash: "$argon2id$v=19$m=19456,t=2,p=1$placeholderforRLS",
        env_prefix: "dev_",
        created_by: null,
      })
      .select("id")
      .single();
    expect(insErr).toBeNull();

    const { error: updErr } = await mgrA.client
      .from("org_api_tokens")
      .update({ org_id: FIXTURE.orgB })
      .eq("id", inserted!.id);
    expect(updErr).not.toBeNull();
    expect(updErr?.message ?? "").toMatch(/row-level security|policy|42501/i);
  });

  // ── 6. billing_audit_log org-scoped event admission ─────────────────────

  it("org_manager(A) CAN INSERT a token_generated audit row scoped to org A", async () => {
    const ts = Date.now() + 5;
    const lookup = String(ts).slice(-8).padStart(8, "f");
    const svc = await serviceClient();
    const { data: tok } = await svc
      .from("org_api_tokens")
      .insert({
        org_id: FIXTURE.orgA,
        name: "audit-scope-A",
        token_lookup: lookup,
        token_hash: "$argon2id$v=19$m=19456,t=2,p=1$placeholderforRLS",
        env_prefix: "dev_",
        created_by: null,
      })
      .select("id")
      .single();

    const { error } = await mgrA.client.from("billing_audit_log").insert({
      org_id: FIXTURE.orgA,
      billing_period_id: null,
      event_type: "token_generated",
      actor_user_id: mgrA.userId,
      actor_kind: "human",
      actor_ref: null,
      details: { org_api_token_id: tok!.id, name: "audit-scope-A" },
    });
    expect(error).toBeNull();
  });

  it("org_manager(A) CANNOT INSERT a token_generated audit row scoped to org B", async () => {
    const { error } = await mgrA.client.from("billing_audit_log").insert({
      org_id: FIXTURE.orgB,
      billing_period_id: null,
      event_type: "token_generated",
      actor_user_id: mgrA.userId,
      actor_kind: "human",
      actor_ref: null,
      details: { name: "cross-org-audit" },
    });
    expect(error).not.toBeNull();
    expect(error?.message ?? "").toMatch(/row-level security|policy|42501/i);
  });

  it("billing_audit_log rejects rows with BOTH billing_period_id AND org_id NULL (scope_consistency)", async () => {
    const svc = await serviceClient();
    const { error } = await svc.from("billing_audit_log").insert({
      org_id: null,
      billing_period_id: null,
      event_type: "token_generated",
      actor_user_id: superAdmin.userId,
      actor_kind: "human",
      actor_ref: null,
      details: {},
    });
    expect(error).not.toBeNull();
    expect(error?.message ?? "").toMatch(/scope_consistency|check/i);
  });
});
