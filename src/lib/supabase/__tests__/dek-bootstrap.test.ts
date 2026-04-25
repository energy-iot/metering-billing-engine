/**
 * dek-bootstrap.test.ts
 *
 * Integration test for the hardened DEK bootstrap (#107, migration 00025).
 *
 * What this verifies:
 *   1. A `supabase db reset --yes` against a local DB WITHOUT
 *      `app.allow_dev_dek` set raises `DEK bootstrap required`.
 *   2. Setting `app.allow_dev_dek = '1'` via `ALTER DATABASE` lets the same
 *      reset succeed and creates a `vault.secrets.mbe_ems_dek` row.
 *
 * This is a true integration test — it shells out to `supabase db reset`,
 * so it requires:
 *   1. Local Supabase CLI running: `supabase start`
 *   2. `psql` available on PATH (Postgres client tools)
 *   3. NEXT_PUBLIC_SUPABASE_ANON_KEY + SUPABASE_JWT_SECRET in .env.local
 *      (used by the `serviceClient()` from rls.helpers.ts to inspect Vault)
 *
 * Opt-out:
 *   SKIP_DEK_BOOTSTRAP_TEST=1 — skips the suite cleanly (matches the
 *   SKIP_RLS_TESTS=1 pattern in rls.helpers.ts:34 / rls.test.ts:277).
 *
 * Why this is destructive:
 *   `supabase db reset --yes` wipes and re-applies all migrations + seed.
 *   It is the same command `setup.sh` runs in local mode, so the only
 *   side effect is that any in-memory test fixtures from prior suites are
 *   gone. Run this file in isolation when iterating locally.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { serviceClient } from "./rls.helpers";

// ── Skip guard (matches rls.helpers.ts:34) ────────────────────────────────

function shouldSkip(): boolean {
  return process.env.SKIP_DEK_BOOTSTRAP_TEST === "1";
}

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Resolves the local DB URL via `supabase status -o env`. Returns null if
 * Supabase isn't running.
 */
function getLocalDbUrl(): string | null {
  try {
    const out = execFileSync("supabase", ["status", "-o", "env"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const match = out.match(/^DB_URL="?([^"\n]+)"?$/m);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * Runs `psql -c <sql>` against the local DB. Throws on non-zero exit.
 */
function psqlExec(dbUrl: string, sql: string): void {
  execFileSync("psql", [dbUrl, "-v", "ON_ERROR_STOP=1", "-c", sql], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * Runs `supabase db reset --yes`. Returns { ok, stderr } so callers can
 * inspect failure messages without throwing on expected failures.
 */
function dbReset(): { ok: boolean; stderr: string } {
  try {
    execFileSync("supabase", ["db", "reset", "--yes"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, stderr: "" };
  } catch (err: unknown) {
    const e = err as { stderr?: Buffer | string; message?: string };
    const stderr =
      typeof e.stderr === "string"
        ? e.stderr
        : e.stderr?.toString("utf8") ?? e.message ?? String(err);
    return { ok: false, stderr };
  }
}

// ── Suite ─────────────────────────────────────────────────────────────────

describe("DEK bootstrap hardening (#107, migration 00025)", () => {
  let dbUrl: string | null = null;
  let skipped = false;

  beforeAll(() => {
    if (shouldSkip()) {
      console.log(
        "[dek-bootstrap] SKIP_DEK_BOOTSTRAP_TEST=1 — skipping suite."
      );
      skipped = true;
      return;
    }

    dbUrl = getLocalDbUrl();
    if (!dbUrl) {
      throw new Error(
        "[dek-bootstrap] Cannot resolve local DB_URL via `supabase status`.\n" +
          "Start it with: supabase start\n" +
          "Or set SKIP_DEK_BOOTSTRAP_TEST=1 to bypass this suite."
      );
    }
  }, 30_000);

  it("refuses to bootstrap when neither GUC is set (branch c — RAISE EXCEPTION)", async () => {
    if (skipped || !dbUrl) return;

    // Reset the DB-level GUC to the unset state, then run db reset.
    // RESET removes the database default; subsequent connections see
    // current_setting('app.allow_dev_dek', true) → NULL.
    psqlExec(dbUrl, "ALTER DATABASE postgres RESET app.allow_dev_dek;");

    const result = dbReset();
    expect(result.ok).toBe(false);
    expect(result.stderr).toMatch(/DEK bootstrap required/);
  }, 120_000);

  it("succeeds when app.allow_dev_dek=1 is set (branch b — random DEK + WARNING)", async () => {
    if (skipped || !dbUrl) return;

    psqlExec(dbUrl, "ALTER DATABASE postgres SET app.allow_dev_dek = '1';");

    const result = dbReset();
    expect(result.ok).toBe(true);

    // Confirm the Vault row was created.
    const svc = await serviceClient();
    const { data, error } = await svc
      .schema("vault" as never)
      .from("secrets")
      .select("name")
      .eq("name", "mbe_ems_dek")
      .limit(1);

    expect(error).toBeNull();
    expect(data?.length ?? 0).toBeGreaterThan(0);
  }, 180_000);
});
