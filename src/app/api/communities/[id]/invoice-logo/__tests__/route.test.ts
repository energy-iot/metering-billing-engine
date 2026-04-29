/**
 * POST /api/communities/[id]/invoice-logo — unit tests (#204 / PDF2 AC-7).
 *
 * Mocks Supabase + service-role storage + auth. Covers:
 *   (1) Happy path → 200, returns logo_storage_path + signed_thumbnail_url
 *   (2) Oversized file (>1 MB server cap) → 400
 *   (3) Wrong MIME → 400
 *   (4) Missing `file` field → 400
 *   (5) Cross-org → 403, NO upload attempted
 *   (6) RLS-hidden / missing community → 404
 *   (7) Malformed UUID → 400
 *   (8) Storage path uses {community.id}/{timestamp}-{uuid}.{ext} shape
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Set the env var BEFORE importing the route module — `service.ts` enforces
// this at module-load.
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "service-role-test-key";
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://localhost:54321";

const COMMUNITY_ID = "550e8400-e29b-41d4-a716-446655440010";
const ORG_ID = "550e8400-e29b-41d4-a716-446655440020";

let canAccessOrgReturn = true;
vi.mock("@/lib/auth/access", () => ({
  currentUserCanAccessOrg: async () => canAccessOrgReturn,
}));

let communitySelectResp: { data: unknown; error: unknown } = {
  data: { id: COMMUNITY_ID, org_id: ORG_ID },
  error: null,
};

const mockFrom = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ from: mockFrom }),
}));

const uploadMock = vi.fn();
const createSignedUrlMock = vi.fn();
const storageFromMock = vi.fn(() => ({
  upload: uploadMock,
  createSignedUrl: createSignedUrlMock,
}));

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({
    storage: { from: storageFromMock },
  }),
}));

function makePostRequest(formData: FormData, id = COMMUNITY_ID): NextRequest {
  return new NextRequest(
    `http://localhost/api/communities/${id}/invoice-logo`,
    {
      method: "POST",
      body: formData,
    },
  );
}

function pngBlob(byteSize = 1024): Blob {
  const bytes = new Uint8Array(byteSize);
  // PNG magic header — not strictly required (server only checks file.type)
  // but useful for reader-friendliness.
  bytes[0] = 0x89;
  bytes[1] = 0x50;
  bytes[2] = 0x4e;
  bytes[3] = 0x47;
  return new Blob([bytes], { type: "image/png" });
}

describe("POST /api/communities/[id]/invoice-logo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    canAccessOrgReturn = true;
    communitySelectResp = {
      data: { id: COMMUNITY_ID, org_id: ORG_ID },
      error: null,
    };

    mockFrom.mockImplementation(() => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve(communitySelectResp),
        }),
      }),
    }));

    uploadMock.mockResolvedValue({
      data: { path: `${COMMUNITY_ID}/file.png` },
      error: null,
    });
    createSignedUrlMock.mockResolvedValue({
      data: {
        signedUrl: "https://storage.example.com/signed-thumb-url",
      },
      error: null,
    });
  });

  it("(1) happy path → 200 with logo_storage_path + signed_thumbnail_url", async () => {
    const fd = new FormData();
    fd.append("file", new File([pngBlob()], "logo.png", { type: "image/png" }));

    const { POST } = await import("../route");
    const res = await POST(makePostRequest(fd), {
      params: Promise.resolve({ id: COMMUNITY_ID }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.logo_storage_path).toBeTypeOf("string");
    expect(body.logo_storage_path).toMatch(
      new RegExp(`^${COMMUNITY_ID}/\\d+-[0-9a-f-]+\\.png$`),
    );
    expect(body.signed_thumbnail_url).toBe(
      "https://storage.example.com/signed-thumb-url",
    );
    expect(uploadMock).toHaveBeenCalledTimes(1);
  });

  it("(2) oversized file (>1 MB) → 400", async () => {
    const fd = new FormData();
    const oversized = new Blob([new Uint8Array(2 * 1024 * 1024)], {
      type: "image/png",
    });
    fd.append("file", new File([oversized], "big.png", { type: "image/png" }));

    const { POST } = await import("../route");
    const res = await POST(makePostRequest(fd), {
      params: Promise.resolve({ id: COMMUNITY_ID }),
    });
    expect(res.status).toBe(400);
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it("(3) wrong MIME → 400", async () => {
    const fd = new FormData();
    fd.append(
      "file",
      new File([new Blob(["abc"])], "doc.txt", { type: "text/plain" }),
    );

    const { POST } = await import("../route");
    const res = await POST(makePostRequest(fd), {
      params: Promise.resolve({ id: COMMUNITY_ID }),
    });
    expect(res.status).toBe(400);
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it("(4) missing file field → 400", async () => {
    const fd = new FormData();
    const { POST } = await import("../route");
    const res = await POST(makePostRequest(fd), {
      params: Promise.resolve({ id: COMMUNITY_ID }),
    });
    expect(res.status).toBe(400);
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it("(5) cross-org → 403 and NO upload attempted (permission-FIRST)", async () => {
    canAccessOrgReturn = false;
    const fd = new FormData();
    fd.append("file", new File([pngBlob()], "logo.png", { type: "image/png" }));

    const { POST } = await import("../route");
    const res = await POST(makePostRequest(fd), {
      params: Promise.resolve({ id: COMMUNITY_ID }),
    });
    expect(res.status).toBe(403);
    // The route must reject BEFORE touching storage.
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it("(6) RLS-hidden / missing community → 404", async () => {
    communitySelectResp = { data: null, error: null };
    const fd = new FormData();
    fd.append("file", new File([pngBlob()], "logo.png", { type: "image/png" }));

    const { POST } = await import("../route");
    const res = await POST(makePostRequest(fd), {
      params: Promise.resolve({ id: COMMUNITY_ID }),
    });
    expect(res.status).toBe(404);
  });

  it("(7) malformed UUID → 400", async () => {
    const fd = new FormData();
    fd.append("file", new File([pngBlob()], "logo.png", { type: "image/png" }));

    const { POST } = await import("../route");
    const res = await POST(makePostRequest(fd, "not-a-uuid"), {
      params: Promise.resolve({ id: "not-a-uuid" }),
    });
    expect(res.status).toBe(400);
  });

  it("(8) storage path follows {community}/{timestamp}-{uuid}.{ext} shape", async () => {
    const fd = new FormData();
    fd.append("file", new File([pngBlob()], "logo.png", { type: "image/png" }));

    const { POST } = await import("../route");
    const res = await POST(makePostRequest(fd), {
      params: Promise.resolve({ id: COMMUNITY_ID }),
    });
    expect(res.status).toBe(200);
    const uploadCall = uploadMock.mock.calls[0];
    const storagePath = uploadCall[0] as string;
    expect(storagePath.startsWith(`${COMMUNITY_ID}/`)).toBe(true);
    expect(storagePath).toMatch(
      new RegExp(`^${COMMUNITY_ID}/\\d+-[0-9a-f-]+\\.png$`),
    );
  });
});
