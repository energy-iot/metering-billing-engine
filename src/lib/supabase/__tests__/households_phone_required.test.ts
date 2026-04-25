/**
 * households_phone_required.test.ts (#155)
 *
 * Verifies the migration `00024_households_primary_phone_required.sql`:
 *   1. `households.primary_phone` is NOT NULL post-migration
 *      (introspect via `information_schema.columns`).
 *   2. `fn_create_household_with_meter` raises `household_phone_required`
 *      when called with NULL or whitespace-only `p_primary_phone`.
 *
 * Prerequisites mirror the RLS suite — local Supabase running, SUPABASE_JWT_SECRET
 * set. Honors `SKIP_RLS_TESTS=1` for CI without Docker.
 */

import { describe, it, expect, beforeAll } from "vitest";
import {
  assertEnvironmentReady,
  shouldSkip,
  serviceClient,
} from "./rls.helpers";

const skip = shouldSkip();
const desc = skip ? describe.skip : describe;

desc("00024_households_primary_phone_required.sql (#155)", () => {
  beforeAll(async () => {
    if (skip) return;
    await assertEnvironmentReady();
  });

  it("households.primary_phone is NOT NULL", async () => {
    const svc = await serviceClient();
    // PostgREST exposes information_schema.columns; we filter via .from().
    // Use the supabase-js rpc fallback when information_schema isn't exposed
    // — a SELECT with .single() against the catalog view works in most
    // local setups since service-role bypasses RLS.
    const { data, error } = await svc
      .schema("information_schema" as never)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .from("columns" as any)
      .select("is_nullable")
      .eq("table_schema", "public")
      .eq("table_name", "households")
      .eq("column_name", "primary_phone")
      .single<{ is_nullable: string }>();

    expect(error).toBeNull();
    expect(data?.is_nullable).toBe("NO");
  });

  it("fn_create_household_with_meter raises household_phone_required when phone is NULL", async () => {
    const svc = await serviceClient();
    const { error } = await svc.rpc("fn_create_household_with_meter", {
      p_microgrid_id: "00000000-0000-4000-8000-000000000001",
      p_display_name: "Phone-required test",
      p_device_id: "00000000-0000-4000-8000-000000000002",
      // Intentionally omit p_primary_phone → defaults to NULL
    });
    expect(error).toBeTruthy();
    expect(error?.message).toContain("household_phone_required");
  });

  it("fn_create_household_with_meter raises household_phone_required when phone is whitespace", async () => {
    const svc = await serviceClient();
    const { error } = await svc.rpc("fn_create_household_with_meter", {
      p_microgrid_id: "00000000-0000-4000-8000-000000000001",
      p_display_name: "Phone-required test",
      p_device_id: "00000000-0000-4000-8000-000000000002",
      p_primary_phone: "   ",
    });
    expect(error).toBeTruthy();
    expect(error?.message).toContain("household_phone_required");
  });
});
