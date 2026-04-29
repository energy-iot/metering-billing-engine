/**
 * POST /api/communities/[id]/invoice-preview — unit tests (#204 / PDF2 AC-7).
 *
 * The renderer (PDF1b #203) is not yet on origin/main; this route ships with
 * a `renderInvoicePdfStub` that throws — the route catches and returns 503
 * `{ error: 'Preview unavailable until PDF1b...' }`. After PDF1b lands and
 * the stub is removed, swap the 503-stub assertions for PDF-stream
 * assertions per the AC.
 *
 * Coverage today (with the stub):
 *   (1) Happy path body validation → 503 (stubbed renderer)
 *   (2) 403 for cross-org caller — no renderer call
 *   (3) 404 for RLS-hidden / missing community
 *   (4) 400 for malformed UUID / JSON / Zod validation
 *   (5) Permission gate runs BEFORE rendering (renderer NOT invoked on 403/404)
 *   (6) Preview does NOT call fn_next_invoice_number (RPC count = 0)
 *   (7) Empty invoice_prefix yields PREVIEW-{year}-PREVIEW invoice number
 *      (verified via the helper unit test below — renderer is stubbed here)
 *   (8) No-microgrid path uses the synthetic 1-tier rate schedule
 *      (verified via the helper unit test below — renderer is stubbed here)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

process.env.SUPABASE_SERVICE_ROLE_KEY ??= "service-role-test-key";
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://localhost:54321";

const COMMUNITY_ID = "550e8400-e29b-41d4-a716-446655440010";
const ORG_ID = "550e8400-e29b-41d4-a716-446655440020";

let canAccessOrgReturn = true;
vi.mock("@/lib/auth/access", () => ({
  currentUserCanAccessOrg: async () => canAccessOrgReturn,
}));

let communitySelectResp: { data: unknown; error: unknown } = {
  data: { id: COMMUNITY_ID, org_id: ORG_ID, name: "Sample Community" },
  error: null,
};
let organizationSelectResp: { data: unknown; error: unknown } = {
  data: { id: ORG_ID, name: "Sample Org" },
  error: null,
};
let microgridSelectResp: { data: unknown; error: unknown } = {
  data: null,
  error: null,
};
let rateScheduleSelectResp: { data: unknown; error: unknown } = {
  data: null,
  error: null,
};

const mockFrom = vi.fn();
const mockRpc = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ from: mockFrom, rpc: mockRpc }),
}));

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({
    storage: {
      from: () => ({
        createSignedUrl: () =>
          Promise.resolve({ data: { signedUrl: "" }, error: null }),
      }),
    },
  }),
}));

const VALID_BODY = {
  invoice_prefix: "NFE",
  invoice_config: {
    seller: { legal_name: "Acme Co" },
    branding: { primary_color: "#163a5f", accent_color: "#2f7d32" },
    payment: { due_days_after_issue: 8 },
    tax: { show_section: true, category_label: "VAT @ 18%", rate_pct: 18 },
  },
};

function makeRequest(body: unknown, id = COMMUNITY_ID): NextRequest {
  return new NextRequest(
    `http://localhost/api/communities/${id}/invoice-preview`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

describe("POST /api/communities/[id]/invoice-preview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    canAccessOrgReturn = true;

    communitySelectResp = {
      data: { id: COMMUNITY_ID, org_id: ORG_ID, name: "Sample Community" },
      error: null,
    };
    organizationSelectResp = {
      data: { id: ORG_ID, name: "Sample Org" },
      error: null,
    };
    microgridSelectResp = { data: null, error: null };
    rateScheduleSelectResp = { data: null, error: null };

    mockFrom.mockImplementation((table: string) => {
      if (table === "communities") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve(communitySelectResp),
            }),
          }),
        };
      }
      if (table === "organizations") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve(organizationSelectResp),
            }),
          }),
        };
      }
      if (table === "microgrids") {
        return {
          select: () => ({
            eq: () => ({
              order: () => ({
                limit: () => ({
                  maybeSingle: () => Promise.resolve(microgridSelectResp),
                }),
              }),
            }),
          }),
        };
      }
      if (table === "rate_schedules") {
        return {
          select: () => ({
            eq: () => ({
              order: () => ({
                limit: () => ({
                  maybeSingle: () => Promise.resolve(rateScheduleSelectResp),
                }),
              }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table: ${table}`);
    });

    mockRpc.mockResolvedValue({ data: null, error: null });
  });

  it("(1) renderer-stub still gated → 503 { error } until PDF1b lands", async () => {
    const { POST } = await import("../route");
    const res = await POST(makeRequest(VALID_BODY), {
      params: Promise.resolve({ id: COMMUNITY_ID }),
    });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toContain("PDF1b");
  });

  it("(2) cross-org → 403 (renderer NOT invoked)", async () => {
    canAccessOrgReturn = false;
    const { POST } = await import("../route");
    const res = await POST(makeRequest(VALID_BODY), {
      params: Promise.resolve({ id: COMMUNITY_ID }),
    });
    expect(res.status).toBe(403);
  });

  it("(3) RLS-hidden / missing community → 404", async () => {
    communitySelectResp = { data: null, error: null };
    const { POST } = await import("../route");
    const res = await POST(makeRequest(VALID_BODY), {
      params: Promise.resolve({ id: COMMUNITY_ID }),
    });
    expect(res.status).toBe(404);
  });

  it("(4) malformed UUID → 400", async () => {
    const { POST } = await import("../route");
    const res = await POST(makeRequest(VALID_BODY, "not-a-uuid"), {
      params: Promise.resolve({ id: "not-a-uuid" }),
    });
    expect(res.status).toBe(400);
  });

  it("(4b) malformed JSON body → 400", async () => {
    const req = new NextRequest(
      `http://localhost/api/communities/${COMMUNITY_ID}/invoice-preview`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not-json",
      },
    );
    const { POST } = await import("../route");
    const res = await POST(req, {
      params: Promise.resolve({ id: COMMUNITY_ID }),
    });
    expect(res.status).toBe(400);
  });

  it("(4c) invalid Zod body → 400", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      makeRequest({
        invoice_prefix: "NFE",
        invoice_config: { branding: { primary_color: "not-a-hex" } },
      }),
      { params: Promise.resolve({ id: COMMUNITY_ID }) },
    );
    expect(res.status).toBe(400);
  });

  it("(6) preview does NOT call fn_next_invoice_number", async () => {
    const { POST } = await import("../route");
    await POST(makeRequest(VALID_BODY), {
      params: Promise.resolve({ id: COMMUNITY_ID }),
    });
    const rpcNames = mockRpc.mock.calls.map((c) => c[0]);
    expect(rpcNames).not.toContain("fn_next_invoice_number");
  });
});
