/**
 * PATCH /api/communities/[id]/invoice-config — unit tests (#204 / PDF2 AC-7).
 *
 * Supabase + auth helpers are mocked. Covers:
 *   (1) Happy path → 200, persists invoice_prefix + invoice_config
 *   (2) Empty invoice_prefix (null) is accepted — column allows NULL
 *   (3) Invalid hex color (Zod) → 400
 *   (4) Invalid invoice_prefix regex → 400
 *   (5) Cross-org caller → 403
 *   (6) RLS-hidden / missing community → 404 (also covers no-session)
 *   (7) Malformed JSON body → 400
 *   (8) Malformed UUID → 400
 *   (9) revalidatePath called on success
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const COMMUNITY_ID = "550e8400-e29b-41d4-a716-446655440010";
const ORG_ID = "550e8400-e29b-41d4-a716-446655440020";

const mockRevalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: mockRevalidatePath }));

let canAccessOrgReturn = true;
vi.mock("@/lib/auth/access", () => ({
  currentUserCanAccessOrg: async () => canAccessOrgReturn,
}));

let communitySelectResp: { data: unknown; error: unknown } = {
  data: {
    id: COMMUNITY_ID,
    org_id: ORG_ID,
    invoice_config: {},
    invoice_prefix: null,
  },
  error: null,
};
let updateError: unknown = null;
let updatePayloadCapture: Record<string, unknown> | null = null;

const mockFrom = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ from: mockFrom }),
}));

function makePatchRequest(body: unknown, id = COMMUNITY_ID): NextRequest {
  return new NextRequest(
    `http://localhost/api/communities/${id}/invoice-config`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

const VALID_BODY = {
  invoice_prefix: "NFE",
  invoice_config: {
    seller: { legal_name: "Acme Co" },
    branding: {
      primary_color: "#163a5f",
      accent_color: "#2f7d32",
      document_title: "Invoice",
    },
    payment: { due_days_after_issue: 8 },
    tax: { show_section: true, category_label: "VAT @ 18%", rate_pct: 18 },
    notices: {
      vat_text: null,
      payment_instructions_text: null,
      signature_disclaimer: null,
    },
  },
};

describe("PATCH /api/communities/[id]/invoice-config", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    canAccessOrgReturn = true;
    communitySelectResp = {
      data: {
        id: COMMUNITY_ID,
        org_id: ORG_ID,
        invoice_config: {},
        invoice_prefix: null,
      },
      error: null,
    };
    updateError = null;
    updatePayloadCapture = null;

    mockFrom.mockImplementation(() => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve(communitySelectResp),
        }),
      }),
      update: (payload: Record<string, unknown>) => {
        updatePayloadCapture = payload;
        return {
          eq: () => Promise.resolve({ error: updateError }),
        };
      },
    }));
  });

  it("(1) happy path → 200, persists prefix + config", async () => {
    const { PATCH } = await import("../route");
    const res = await PATCH(makePatchRequest(VALID_BODY), {
      params: Promise.resolve({ id: COMMUNITY_ID }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("success");
    expect(updatePayloadCapture).toBeTruthy();
    expect(updatePayloadCapture!.invoice_prefix).toBe("NFE");
    expect(
      (updatePayloadCapture!.invoice_config as Record<string, unknown>).branding,
    ).toMatchObject({ primary_color: "#163a5f" });
  });

  it("(2) null invoice_prefix is accepted (column allows NULL)", async () => {
    const { PATCH } = await import("../route");
    const res = await PATCH(
      makePatchRequest({ ...VALID_BODY, invoice_prefix: null }),
      { params: Promise.resolve({ id: COMMUNITY_ID }) },
    );
    expect(res.status).toBe(200);
    expect(updatePayloadCapture!.invoice_prefix).toBeNull();
  });

  it("(3) invalid hex color → 400 (Zod field error)", async () => {
    const { PATCH } = await import("../route");
    const badBody = {
      ...VALID_BODY,
      invoice_config: {
        ...VALID_BODY.invoice_config,
        branding: { primary_color: "not-a-hex" },
      },
    };
    const res = await PATCH(makePatchRequest(badBody), {
      params: Promise.resolve({ id: COMMUNITY_ID }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.fields).toBeDefined();
    expect(updatePayloadCapture).toBeNull();
  });

  it("(4) invalid invoice_prefix regex → 400", async () => {
    const { PATCH } = await import("../route");
    const res = await PATCH(
      makePatchRequest({ ...VALID_BODY, invoice_prefix: "lowercase" }),
      { params: Promise.resolve({ id: COMMUNITY_ID }) },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.fields).toMatchObject({ invoice_prefix: "invalid-format" });
    expect(updatePayloadCapture).toBeNull();
  });

  it("(5) cross-org caller → 403", async () => {
    canAccessOrgReturn = false;
    const { PATCH } = await import("../route");
    const res = await PATCH(makePatchRequest(VALID_BODY), {
      params: Promise.resolve({ id: COMMUNITY_ID }),
    });
    expect(res.status).toBe(403);
    expect(updatePayloadCapture).toBeNull();
  });

  it("(6) RLS-hidden / missing community → 404", async () => {
    communitySelectResp = { data: null, error: null };
    const { PATCH } = await import("../route");
    const res = await PATCH(makePatchRequest(VALID_BODY), {
      params: Promise.resolve({ id: COMMUNITY_ID }),
    });
    expect(res.status).toBe(404);
  });

  it("(7) malformed JSON body → 400", async () => {
    const { PATCH } = await import("../route");
    const req = new NextRequest(
      `http://localhost/api/communities/${COMMUNITY_ID}/invoice-config`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: "not-json",
      },
    );
    const res = await PATCH(req, {
      params: Promise.resolve({ id: COMMUNITY_ID }),
    });
    expect(res.status).toBe(400);
  });

  it("(8) malformed UUID → 400", async () => {
    const { PATCH } = await import("../route");
    const res = await PATCH(makePatchRequest(VALID_BODY, "not-a-uuid"), {
      params: Promise.resolve({ id: "not-a-uuid" }),
    });
    expect(res.status).toBe(400);
  });

  it("(9) revalidatePath('/communities/[id]', 'layout') called on success", async () => {
    const { PATCH } = await import("../route");
    await PATCH(makePatchRequest(VALID_BODY), {
      params: Promise.resolve({ id: COMMUNITY_ID }),
    });
    expect(mockRevalidatePath).toHaveBeenCalledWith(
      `/communities/${COMMUNITY_ID}`,
      "layout",
    );
  });
});
