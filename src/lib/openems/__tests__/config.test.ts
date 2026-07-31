/**
 * config.test.ts — ordering invariant for the EMS secret decrypt.
 *
 * The decrypt runs on the service-role client, which short-circuits
 * `fn_get_ems_secret`'s own permission gate. That makes the RLS row read on
 * the caller's client the ONLY authorization rather than a second layer, so
 * the assertion that matters is not "a cross-org caller gets an error" — it
 * is "a cross-org caller never reaches the decrypt at all."
 *
 * These tests therefore assert on whether the service-role client was
 * CONSTRUCTED and whether the decrypt RPC was CALLED, not on return values.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const decryptRpc = vi.fn();
const createServiceClient = vi.fn(() => ({ rpc: decryptRpc }));

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: (...args: unknown[]) =>
    (createServiceClient as unknown as (...a: unknown[]) => unknown)(...args),
}));

import { getMicrogridEmsConfig, getEmsSecretForMicrogrid } from "../config";
import { OpenEmsError } from "../errors";

const MICROGRID_ID = "00000000-0000-4000-8000-000000000010";

/**
 * Minimal user-client stub. `row` is what the RLS-evaluated read returns:
 * `null` models a row RLS hid from the caller (cross-org), which is exactly
 * how PostgREST surfaces it — not as an error.
 */
function buildUserClient(row: Record<string, unknown> | null): {
  client: SupabaseClient;
  reads: string[];
  rpc: ReturnType<typeof vi.fn>;
} {
  const reads: string[] = [];
  const rpc = vi.fn();
  const client = {
    from(table: string) {
      reads.push(table);
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => ({ data: row, error: null }),
      };
      return chain;
    },
    rpc,
  } as unknown as SupabaseClient;
  return { client, reads, rpc };
}

beforeEach(() => {
  decryptRpc.mockReset();
  createServiceClient.mockClear();
  decryptRpc.mockResolvedValue({ data: "PLAINTEXT-SECRET", error: null });
});

describe("getEmsSecretForMicrogrid — ordering invariant", () => {
  it("cross-org caller cannot reach the decrypt (RLS hides the row)", async () => {
    const { client } = buildUserClient(null);

    const result = await getEmsSecretForMicrogrid(client, MICROGRID_ID);

    expect(result).toBeNull();
    // The load-bearing assertions: the service-role client was never even
    // constructed, so no decrypt could have run under it.
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(decryptRpc).not.toHaveBeenCalled();
  });

  it("authorized caller reads the row BEFORE the decrypt is constructed", async () => {
    const order: string[] = [];
    const rpc = vi.fn();
    const client = {
      from() {
        const chain = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: async () => {
            order.push("rls-read");
            return { data: { id: MICROGRID_ID }, error: null };
          },
        };
        return chain;
      },
      rpc,
    } as unknown as SupabaseClient;

    createServiceClient.mockImplementation(() => {
      order.push("service-client");
      return { rpc: decryptRpc };
    });
    decryptRpc.mockImplementation(async () => {
      order.push("decrypt");
      return { data: "PLAINTEXT-SECRET", error: null };
    });

    const result = await getEmsSecretForMicrogrid(client, MICROGRID_ID);

    expect(result).toBe("PLAINTEXT-SECRET");
    expect(order).toEqual(["rls-read", "service-client", "decrypt"]);
  });

  it("never issues the decrypt RPC on the caller's own client", async () => {
    const { client, rpc } = buildUserClient({ id: MICROGRID_ID });

    await getEmsSecretForMicrogrid(client, MICROGRID_ID);

    // The user client must not be the one decrypting — that is the grant we
    // withdrew in migration 00049.
    expect(rpc).not.toHaveBeenCalled();
    expect(decryptRpc).toHaveBeenCalledWith("fn_get_ems_secret", {
      _microgrid_id: MICROGRID_ID,
    });
  });

  it("returns null when no ciphertext is stored", async () => {
    const { client } = buildUserClient({ id: MICROGRID_ID });
    decryptRpc.mockResolvedValue({ data: null, error: null });

    expect(await getEmsSecretForMicrogrid(client, MICROGRID_ID)).toBeNull();
  });

  it("throws OpenEmsError when the decrypt RPC fails", async () => {
    const { client } = buildUserClient({ id: MICROGRID_ID });
    decryptRpc.mockResolvedValue({
      data: null,
      error: { message: "boom" },
    });

    await expect(
      getEmsSecretForMicrogrid(client, MICROGRID_ID)
    ).rejects.toBeInstanceOf(OpenEmsError);
  });
});

describe("getMicrogridEmsConfig — cross-org callers stop before the decrypt", () => {
  it("returns null and never decrypts when RLS hides the microgrid", async () => {
    const { client } = buildUserClient(null);

    expect(await getMicrogridEmsConfig(client, MICROGRID_ID)).toBeNull();
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(decryptRpc).not.toHaveBeenCalled();
  });

  it("does not decrypt for a direct_url microgrid", async () => {
    const { client } = buildUserClient({
      id: MICROGRID_ID,
      ems_type: "direct_url",
      ems_backend_url: "https://example.invalid",
      ems_aws_region: null,
      ems_aws_access_key_id: null,
    });

    const cfg = await getMicrogridEmsConfig(client, MICROGRID_ID);

    expect(cfg).toEqual({
      type: "direct_url",
      url: "https://example.invalid",
    });
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(decryptRpc).not.toHaveBeenCalled();
  });

  it("resolves a cloud_aws config via the service-role decrypt", async () => {
    const { client } = buildUserClient({
      id: MICROGRID_ID,
      ems_type: "cloud_aws",
      ems_backend_url: "https://example.invalid",
      ems_aws_region: "eu-west-1",
      ems_aws_access_key_id: "AKIAEXAMPLE",
    });

    const cfg = await getMicrogridEmsConfig(client, MICROGRID_ID);

    expect(cfg).toEqual({
      type: "cloud_aws",
      url: "https://example.invalid",
      region: "eu-west-1",
      accessKeyId: "AKIAEXAMPLE",
      secretAccessKey: "PLAINTEXT-SECRET",
    });
    expect(createServiceClient).toHaveBeenCalledTimes(1);
  });

  it("throws OPENEMS_FORBIDDEN for cloud_aws with no retrievable secret", async () => {
    const { client } = buildUserClient({
      id: MICROGRID_ID,
      ems_type: "cloud_aws",
      ems_backend_url: "https://example.invalid",
      ems_aws_region: "eu-west-1",
      ems_aws_access_key_id: "AKIAEXAMPLE",
    });
    decryptRpc.mockResolvedValue({ data: null, error: null });

    await expect(
      getMicrogridEmsConfig(client, MICROGRID_ID)
    ).rejects.toMatchObject({ code: "OPENEMS_FORBIDDEN", statusCode: 403 });
  });
});
