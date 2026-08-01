/**
 * rls.helpers.ts
 *
 * Shared utilities for the RLS test harness.
 *
 * Design:
 *   - JWTs are minted locally with `jose` + SUPABASE_JWT_SECRET — fast, offline, no GoTrue dependency.
 *   - Service-role client is used for all fixture setup (bypasses RLS).
 *   - `clientAs(jwt)` returns an anon-key client with a custom Authorization header,
 *     which is how Supabase RLS evaluates auth.uid() in impersonation tests.
 *
 * Required env vars (set in .env.local):
 *   SUPABASE_JWT_SECRET              — local Supabase JWT signing secret
 *   NEXT_PUBLIC_SUPABASE_ANON_KEY    — local anon/publishable key (for non-service-role clients)
 *
 * The LOCAL_SUPABASE_URL is always http://localhost:54321 — RLS tests never run against cloud.
 * A local service-role JWT is derived at runtime from SUPABASE_JWT_SECRET.
 *
 * Role strings use inline literals (not imported from src/lib/roles.ts) because ticket C
 * (#51) may not have shipped yet. When C lands, replace literals with imports.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { SignJWT } from "jose";

// ── Constants ─────────────────────────────────────────────────────────────

// RLS tests always target local Supabase — never cloud.
export const LOCAL_SUPABASE_URL = "http://localhost:54321";

// ── Environment guard ────────────────────────────────────────────────────

export function shouldSkip(): boolean {
  return process.env.SKIP_RLS_TESTS === "1";
}

/**
 * Validates that the required environment variables are set and that the local
 * Supabase instance is reachable. Throws with an actionable message if not.
 *
 * Call once in beforeAll at the top of the test file.
 */
export async function assertEnvironmentReady(): Promise<void> {
  if (shouldSkip()) {
    return; // Explicit opt-out — skip cleanly without erroring.
  }

  const missing: string[] = [];
  if (!process.env.SUPABASE_JWT_SECRET) missing.push("SUPABASE_JWT_SECRET");
  if (!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) missing.push("NEXT_PUBLIC_SUPABASE_ANON_KEY");

  if (missing.length > 0) {
    throw new Error(
      `[RLS tests] Missing required environment variables: ${missing.join(", ")}.\n` +
        "These tests require a running local Supabase CLI instance.\n" +
        "Run ./setup.sh to set up your local environment.\n" +
        "Retrieve SUPABASE_JWT_SECRET with: supabase status | grep 'JWT secret'\n" +
        "Set SKIP_RLS_TESTS=1 to bypass this check (CI without local Supabase)."
    );
  }

  // Verify the local Supabase is actually reachable at the Kong port (54321).
  // Reject cloud URLs — RLS tests must not pollute shared dev DBs.
  try {
    const res = await fetch(`${LOCAL_SUPABASE_URL}/rest/v1/`, {
      headers: {
        apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
      },
      signal: AbortSignal.timeout(3000),
    });
    // PostgREST returns 200 or 401 for the root — either confirms reachability.
    if (res.status >= 500) {
      throw new Error(`Unexpected HTTP ${res.status}`);
    }
  } catch (err) {
    throw new Error(
      `[RLS tests] Cannot reach local Supabase at ${LOCAL_SUPABASE_URL}.\n` +
        "Start it with: supabase start\n" +
        "Or set SKIP_RLS_TESTS=1 to bypass.\n" +
        `Original error: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

// ── JWT minting ───────────────────────────────────────────────────────────

function jwtSecretBytes(): Uint8Array {
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (!secret) throw new Error("[RLS tests] SUPABASE_JWT_SECRET is not set");
  return new TextEncoder().encode(secret);
}

/**
 * Mints a JWT for an end-user (role='authenticated').
 * Used to impersonate a specific auth.users row in RLS evaluation.
 * Supabase derives auth.uid() from the 'sub' claim.
 */
export async function mintUserJwt(userId: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    sub: userId,
    aud: "authenticated",
    role: "authenticated",
    iss: `${LOCAL_SUPABASE_URL}/auth/v1`,
    iat: now,
    exp: now + 3600,
  })
    .setProtectedHeader({ alg: "HS256" })
    .sign(jwtSecretBytes());
}

/**
 * Mints a service-role JWT from the local JWT secret.
 * Used for fixture setup — bypasses all RLS policies.
 */
async function mintServiceRoleJwt(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    role: "service_role",
    iss: "supabase-demo",
    iat: now,
    exp: now + 3600,
  })
    .setProtectedHeader({ alg: "HS256" })
    .sign(jwtSecretBytes());
}

// ── Supabase client factories ─────────────────────────────────────────────

/**
 * Service-role client — bypasses RLS. Used in beforeAll/afterAll for fixture setup.
 * The service-role JWT is derived at runtime from SUPABASE_JWT_SECRET.
 */
export async function serviceClient(): Promise<SupabaseClient> {
  const serviceRoleJwt = await mintServiceRoleJwt();
  return createClient(LOCAL_SUPABASE_URL, serviceRoleJwt, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Returns a Supabase client that uses the given user JWT as the Authorization bearer.
 * The anon key is required by PostgREST as the apikey header; the JWT overrides
 * the role for RLS evaluation (auth.uid() = sub claim from JWT).
 */
export function clientAs(jwt: string): SupabaseClient {
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!anonKey) {
    throw new Error("[RLS tests] NEXT_PUBLIC_SUPABASE_ANON_KEY is not set");
  }
  return createClient(LOCAL_SUPABASE_URL, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      headers: {
        Authorization: `Bearer ${jwt}`,
      },
    },
  });
}

// ── Test user / fixture creation ──────────────────────────────────────────

export interface TestUser {
  userId: string;
  jwt: string;
  client: SupabaseClient;
}

/**
 * Seeds an auth.users row + optional user_roles row, then returns a TestUser
 * with a pre-minted JWT and a Supabase client bound to that JWT.
 *
 * Role strings are inline literals (not imported from src/lib/roles.ts) — see module doc.
 * The Supabase admin API assigns a random UUID; we store the actual ID so teardown
 * can reliably delete it.
 */
export async function createTestUser(opts: {
  email: string;
  role: "super_admin" | "org_manager" | null;
  scopeId?: string | null;
  /**
   * Defaults to 'org', which is the only scope type in use. `microgrid` is
   * inert enum residue from #316, removed from the permission model by #321 —
   * the role-aware CHECK on user_roles (migration 00052) pairs it only with
   * `ems_operator`, which nothing grants any more. Do not seed either.
   */
  scopeType?: "org";
  /**
   * Additional role rows to seed for the same user. The one-row-per-user
   * invariant went away with #316 and has not come back: `user_roles` is
   * UNIQUE (user_id, role, scope_type, scope_id), and every RLS helper reads
   * through EXISTS(...), which is multi-row-safe.
   */
  extraRoles?: {
    role: "super_admin" | "org_manager";
    scopeType: "org";
    scopeId: string | null;
  }[];
}): Promise<TestUser> {
  const svc = await serviceClient();

  // Create the auth user. The admin API generates a UUID automatically.
  const { data: created, error: userError } = await svc.auth.admin.createUser({
    email: opts.email,
    password: `test-pw-${Date.now()}`,
    email_confirm: true,
    user_metadata: {},
    app_metadata: {},
  });

  if (userError) {
    throw new Error(
      `[RLS tests] Failed to create auth user ${opts.email}: ${userError.message}`
    );
  }

  if (!created?.user) {
    throw new Error(`[RLS tests] No user returned for ${opts.email}`);
  }

  const userId = created.user.id;

  // Seed user_roles row if a role is provided.
  if (opts.role) {
    const { error: roleError } = await svc.from("user_roles").insert({
      user_id: userId,
      role: opts.role,
      scope_type: opts.scopeType ?? "org",
      scope_id: opts.role === "super_admin" ? null : (opts.scopeId ?? null),
    });
    if (roleError) {
      throw new Error(
        `[RLS tests] Failed to insert user_roles for ${opts.email}: ${roleError.message}`
      );
    }
  }

  for (const extra of opts.extraRoles ?? []) {
    const { error: extraErr } = await svc.from("user_roles").insert({
      user_id: userId,
      role: extra.role,
      scope_type: extra.scopeType,
      scope_id: extra.scopeId,
    });
    if (extraErr) {
      throw new Error(
        `[RLS tests] Failed to insert extra user_roles (${extra.role}@${extra.scopeType}) for ${opts.email}: ${extraErr.message}`
      );
    }
  }

  const jwt = await mintUserJwt(userId);
  return { userId, jwt, client: clientAs(jwt) };
}

/**
 * Removes all test data inserted during the test run.
 * Deletes auth users by email (cascades to user_roles + household_users).
 * Deletes orgs by ID (cascades to communities → microgrids → ... → billing_line_items).
 */
export async function cleanupTestData(opts: {
  orgIds: string[];
  userEmails: string[];
}): Promise<void> {
  const svc = await serviceClient();

  // Delete auth users by email (admin API lookup then delete).
  const { data: userList } = await svc.auth.admin.listUsers({ perPage: 1000 });
  for (const email of opts.userEmails) {
    const user = userList?.users.find((u) => u.email === email);
    if (user) {
      await svc.auth.admin.deleteUser(user.id);
    }
  }

  // Delete orgs — cascades to everything underneath.
  for (const orgId of opts.orgIds) {
    await svc.from("organizations").delete().eq("id", orgId);
  }
}
