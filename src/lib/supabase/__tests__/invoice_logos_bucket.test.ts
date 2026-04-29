/**
 * invoice_logos_bucket.test.ts (#202, migration 00033_pdf_invoices_schema.sql)
 *
 * Verifies the `invoice-logos` storage bucket's per-verb RLS policies. The
 * path schema is `{community_uuid}/{filename}.{ext}`; the policies require
 * `storage.foldername(name)[1]` to match a community the caller can access.
 *
 *   - org_manager A CAN insert a file under own community's path.
 *   - org_manager A CAN SELECT a file under own community's path.
 *   - org_manager A CANNOT insert under Org B's community path.
 *   - org_manager A CANNOT SELECT a file under Org B's community path.
 *   - bare-filename uploads (no folder) are silently denied.
 *   - super_admin can do everything across orgs.
 *
 * Honors `SKIP_RLS_TESTS=1` for CI without local Supabase.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  assertEnvironmentReady,
  shouldSkip,
  serviceClient,
  cleanupTestData,
  createTestUser,
} from "./rls.helpers";

const skip = shouldSkip();
const desc = skip ? describe.skip : describe;

if (skip) {
  console.log("[invoice_logos_bucket] SKIP_RLS_TESTS=1 — skipping suite.");
}

const FIXTURE = {
  orgA: "ffffffff-ffff-4000-8000-00000000000a",
  commA: "ffffffff-ffff-4000-8001-00000000000a",
  orgB: "ffffffff-ffff-4000-8000-00000000000b",
  commB: "ffffffff-ffff-4000-8001-00000000000b",
};

let alejandroSuper: { userId: string; jwt: string; client: import("@supabase/supabase-js").SupabaseClient };
let aaronOrgA: { userId: string; jwt: string; client: import("@supabase/supabase-js").SupabaseClient };

const EMAIL_SUPER = `pdf1a-bucket-super-${Date.now()}@test.local`;
const EMAIL_ORGA = `pdf1a-bucket-orga-${Date.now()}@test.local`;

function pngBytes(): Blob {
  // Minimal 1x1 PNG (transparent). Bytes are well-formed enough that
  // Supabase storage doesn't reject the upload by content-sniffing.
  const data = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
    0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
    0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ]);
  return new Blob([data], { type: "image/png" });
}

desc("00033_pdf_invoices_schema.sql — invoice-logos bucket RLS (#202)", () => {
  beforeAll(async () => {
    if (skip) return;
    await assertEnvironmentReady();
    const svc = await serviceClient();

    await cleanupTestData({
      orgIds: [FIXTURE.orgA, FIXTURE.orgB],
      userEmails: [EMAIL_SUPER, EMAIL_ORGA],
    });

    await svc.from("organizations").insert({ id: FIXTURE.orgA, name: "PDF1a Bucket Org A" });
    await svc.from("communities").insert({
      id: FIXTURE.commA,
      org_id: FIXTURE.orgA,
      name: "PDF1a Bucket Comm A",
    });
    await svc.from("organizations").insert({ id: FIXTURE.orgB, name: "PDF1a Bucket Org B" });
    await svc.from("communities").insert({
      id: FIXTURE.commB,
      org_id: FIXTURE.orgB,
      name: "PDF1a Bucket Comm B",
    });

    alejandroSuper = await createTestUser({
      email: EMAIL_SUPER,
      role: "super_admin",
      scopeId: null,
    });
    aaronOrgA = await createTestUser({
      email: EMAIL_ORGA,
      role: "org_manager",
      scopeId: FIXTURE.orgA,
    });
  });

  afterAll(async () => {
    if (skip) return;
    // Clean up any uploaded objects under our test paths via service role.
    const svc = await serviceClient();
    for (const id of [FIXTURE.commA, FIXTURE.commB]) {
      // List + delete is bounded to our test prefix.
      const { data: objs } = await svc.storage
        .from("invoice-logos")
        .list(id, { limit: 100 });
      if (objs && objs.length > 0) {
        await svc.storage
          .from("invoice-logos")
          .remove(objs.map((o) => `${id}/${o.name}`));
      }
    }
    await cleanupTestData({
      orgIds: [FIXTURE.orgA, FIXTURE.orgB],
      userEmails: [EMAIL_SUPER, EMAIL_ORGA],
    });
  });

  it("org_manager A CAN upload to own community's path", async () => {
    const path = `${FIXTURE.commA}/${Date.now()}-aupload.png`;
    const r = await aaronOrgA.client.storage
      .from("invoice-logos")
      .upload(path, pngBytes(), { contentType: "image/png", upsert: true });
    expect(r.error).toBeNull();
    expect(r.data?.path).toBe(path);
  });

  it("org_manager A CANNOT upload to Org B's community path", async () => {
    const path = `${FIXTURE.commB}/${Date.now()}-bupload.png`;
    const r = await aaronOrgA.client.storage
      .from("invoice-logos")
      .upload(path, pngBytes(), { contentType: "image/png", upsert: true });
    expect(r.error).not.toBeNull();
  });

  it("org_manager A CAN list/select files under own community's path", async () => {
    // Service-role seeds a known file.
    const svc = await serviceClient();
    const seedPath = `${FIXTURE.commA}/seed-${Date.now()}.png`;
    await svc.storage
      .from("invoice-logos")
      .upload(seedPath, pngBytes(), { contentType: "image/png", upsert: true });

    const r = await aaronOrgA.client.storage
      .from("invoice-logos")
      .list(FIXTURE.commA, { limit: 100 });
    expect(r.error).toBeNull();
    expect((r.data ?? []).length).toBeGreaterThan(0);
  });

  it("org_manager A CANNOT list files under Org B's community path", async () => {
    // Service-role seeds a known file in Org B.
    const svc = await serviceClient();
    const seedPath = `${FIXTURE.commB}/seedB-${Date.now()}.png`;
    await svc.storage
      .from("invoice-logos")
      .upload(seedPath, pngBytes(), { contentType: "image/png", upsert: true });

    const r = await aaronOrgA.client.storage
      .from("invoice-logos")
      .list(FIXTURE.commB, { limit: 100 });
    // Storage RLS: list returns empty (filter), not 403.
    expect(r.error).toBeNull();
    expect(r.data ?? []).toEqual([]);
  });

  it("bare-filename uploads (no folder) are denied", async () => {
    const path = `bare-${Date.now()}.png`;
    const r = await aaronOrgA.client.storage
      .from("invoice-logos")
      .upload(path, pngBytes(), { contentType: "image/png", upsert: true });
    expect(r.error).not.toBeNull();
  });

  it("super_admin can upload across orgs", async () => {
    const path = `${FIXTURE.commB}/${Date.now()}-superadmin.png`;
    const r = await alejandroSuper.client.storage
      .from("invoice-logos")
      .upload(path, pngBytes(), { contentType: "image/png", upsert: true });
    expect(r.error).toBeNull();
  });
});
