/**
 * Tests for buildOrderParamsFromLineItem — the "one bill, one payment link"
 * invariant. The Supabase client is mocked as a chain-builder so we can assert
 * that the function queries by line-item id (not by period) and that the
 * resulting amount/tenant/date range come from the single targeted row.
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildOrderParamsFromLineItem } from "../build-params";
import { PesapalError } from "../errors";

/**
 * Minimal mock that mirrors the chain we actually use:
 *   supabase.from(T).select(...).eq(...).single()
 *
 * Each .from(tableName) call pops the next scripted response off the queue
 * for that table. Every chain method returns `this` until `single()`, which
 * resolves with { data, error }.
 */
type MockResponse = { data: unknown; error: unknown };

function makeSupabaseMock(scripts: Record<string, MockResponse[]>) {
  const calls: { table: string; filters: Record<string, unknown> }[] = [];

  function chain(table: string) {
    const filters: Record<string, unknown> = {};
    const api: Record<string, unknown> = {};
    api.select = () => api;
    api.eq = (col: string, val: unknown) => {
      filters[col] = val;
      return api;
    };
    api.order = () => api;
    api.limit = () => api;
    api.maybeSingle = () => {
      calls.push({ table, filters });
      const queue = scripts[table];
      if (!queue || queue.length === 0) {
        throw new Error(`No scripted response for table ${table}`);
      }
      return Promise.resolve(queue.shift()!);
    };
    api.single = api.maybeSingle;
    api.returns = () => api;
    return api;
  }

  const client = {
    from: (table: string) => chain(table),
  };

  return { client: client as unknown as SupabaseClient, calls };
}

describe("buildOrderParamsFromLineItem", () => {
  const BASE_PERIOD = {
    id: "period-1",
    microgrid_id: "mg-1",
    start_date: "2026-03-01",
    end_date: "2026-03-31",
  };

  const BASE_LINE_ITEM = {
    id: "li-A",
    tenant_id: "tenant-A",
    total_amount: 12500,
    billing_period_id: "period-1",
    // The join returns the period as an object (PostgREST single-row join
    // shape). build-params.ts also handles array-shape — tested below.
    billing_periods: BASE_PERIOD,
  };

  const TENANT_A = {
    id: "tenant-A",
    name: "Alice Mukasa",
    email: "alice@example.com",
    phone: "+256700000001",
  };

  let scripts: Record<string, MockResponse[]>;

  beforeEach(() => {
    scripts = {};
  });

  it("builds params from exactly one line item (amount = line item total, tenant = line item's tenant)", async () => {
    scripts.billing_line_items = [{ data: BASE_LINE_ITEM, error: null }];
    scripts.tenants = [{ data: TENANT_A, error: null }];

    const { client, calls } = makeSupabaseMock(scripts);
    const result = await buildOrderParamsFromLineItem(client, "li-A");

    // The query MUST filter by line-item id, not period id. This is the
    // anti-regression check for the "one bill, one link" refactor.
    expect(calls[0]).toEqual({
      table: "billing_line_items",
      filters: { id: "li-A" },
    });
    expect(calls[1]).toEqual({ table: "tenants", filters: { id: "tenant-A" } });

    expect(result.params.amount).toBe(12500);
    expect(result.params.description).toMatch(/Mar (1|01), 2026/);
    expect(result.params.billingAddress).toEqual({
      email_address: "alice@example.com",
      phone_number: "+256700000001",
      first_name: "Alice",
      last_name: "Mukasa",
    });
    expect(result.debug.lineItem).toEqual({ id: "li-A", total_amount: 12500 });
    expect(result.debug.tenant).toEqual(TENANT_A);
  });

  it("does NOT sum across siblings — a different line item with its own tenant is ignored", async () => {
    // Even though there's a second line item in the same period worth
    // 20,000, the function only sees the 12,500 one we asked for.
    scripts.billing_line_items = [{ data: BASE_LINE_ITEM, error: null }];
    scripts.tenants = [{ data: TENANT_A, error: null }];

    const { client } = makeSupabaseMock(scripts);
    const result = await buildOrderParamsFromLineItem(client, "li-A");

    expect(result.params.amount).toBe(12500);
    expect(result.params.amount).not.toBe(32500);
    expect(result.params.billingAddress.email_address).toBe(
      "alice@example.com",
    );
  });

  it("normalizes the PostgREST join when `billing_periods` arrives as a single-element array", async () => {
    scripts.billing_line_items = [
      {
        data: { ...BASE_LINE_ITEM, billing_periods: [BASE_PERIOD] },
        error: null,
      },
    ];
    scripts.tenants = [{ data: TENANT_A, error: null }];

    const { client } = makeSupabaseMock(scripts);
    const result = await buildOrderParamsFromLineItem(client, "li-A");

    expect(result.debug.period).toEqual(BASE_PERIOD);
  });

  it("throws PESAPAL_LINE_ITEM_NOT_FOUND when the line item query returns no row", async () => {
    scripts.billing_line_items = [
      { data: null, error: { message: "Row not found" } },
    ];

    const { client } = makeSupabaseMock(scripts);
    await expect(
      buildOrderParamsFromLineItem(client, "does-not-exist"),
    ).rejects.toMatchObject({
      name: "PesapalError",
      code: "PESAPAL_LINE_ITEM_NOT_FOUND",
      statusCode: 404,
    });
  });

  it("throws PESAPAL_TENANT_NOT_FOUND when the tenant lookup fails", async () => {
    scripts.billing_line_items = [{ data: BASE_LINE_ITEM, error: null }];
    scripts.tenants = [{ data: null, error: { message: "Not found" } }];

    const { client } = makeSupabaseMock(scripts);
    await expect(
      buildOrderParamsFromLineItem(client, "li-A"),
    ).rejects.toMatchObject({
      name: "PesapalError",
      code: "PESAPAL_TENANT_NOT_FOUND",
    });
  });

  it("throws PESAPAL_MISSING_CONTACT when the tenant has neither email nor phone", async () => {
    scripts.billing_line_items = [{ data: BASE_LINE_ITEM, error: null }];
    scripts.tenants = [
      {
        data: { ...TENANT_A, email: null, phone: null },
        error: null,
      },
    ];

    const { client } = makeSupabaseMock(scripts);
    await expect(
      buildOrderParamsFromLineItem(client, "li-A"),
    ).rejects.toMatchObject({
      code: "PESAPAL_MISSING_CONTACT",
      statusCode: 400,
    });
  });

  it("throws PESAPAL_ZERO_AMOUNT when the line item total is <= 0", async () => {
    scripts.billing_line_items = [
      { data: { ...BASE_LINE_ITEM, total_amount: 0 }, error: null },
    ];
    scripts.tenants = [{ data: TENANT_A, error: null }];

    const { client } = makeSupabaseMock(scripts);
    await expect(
      buildOrderParamsFromLineItem(client, "li-A"),
    ).rejects.toBeInstanceOf(PesapalError);
  });

  it("accepts a tenant with only a phone (no email)", async () => {
    scripts.billing_line_items = [{ data: BASE_LINE_ITEM, error: null }];
    scripts.tenants = [
      { data: { ...TENANT_A, email: null }, error: null },
    ];

    const { client } = makeSupabaseMock(scripts);
    const result = await buildOrderParamsFromLineItem(client, "li-A");

    expect(result.params.billingAddress).not.toHaveProperty("email_address");
    expect(result.params.billingAddress.phone_number).toBe("+256700000001");
  });

  it("splits a single-word tenant name into firstName only", async () => {
    scripts.billing_line_items = [{ data: BASE_LINE_ITEM, error: null }];
    scripts.tenants = [
      { data: { ...TENANT_A, name: "Madonna" }, error: null },
    ];

    const { client } = makeSupabaseMock(scripts);
    const result = await buildOrderParamsFromLineItem(client, "li-A");

    expect(result.params.billingAddress.first_name).toBe("Madonna");
    expect(result.params.billingAddress.last_name).toBe("");
  });
});
