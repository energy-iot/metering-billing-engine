// @vitest-environment jsdom
/**
 * UsersPageClient component tests (UX5b / #184).
 *
 * No prior tests existed for this component. Coverage:
 *   - Per-row "Resend" visibility:
 *       * Visible only on Invited rows (email_confirmed_at == null).
 *       * Permission-gated:
 *         - super_admin: always visible on Invited rows.
 *         - org_manager: only on org_manager rows in their orgs;
 *                        hidden on super_admin / cross-org / orphan rows.
 *   - Per-row "Sending…" state isolates correctly when two rows are
 *     clicked in sequence (the first row's in-flight state does not
 *     bleed into the second's button label).
 *   - Banner discriminated union renders the right tone for each kind
 *     (invite-success, resend-success, rate-limit, error).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { UsersPageClient } from "../users-page-client";
import type { UserDirectoryRow } from "@/lib/types/domain";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

const ORG_A = "aaaaaaaa-aaaa-4000-8000-000000000001";
const ORG_B = "bbbbbbbb-bbbb-4000-8000-000000000002";
const CALLER = "11111111-1111-4000-8000-000000000001";

function makeRow(overrides: Partial<UserDirectoryRow>): UserDirectoryRow {
  return {
    user_id: "22222222-2222-4000-8000-000000000002",
    email: "row@example.com",
    email_confirmed_at: null,
    last_sign_in_at: null,
    first_name: "Row",
    last_name: "User",
    phone: null,
    role: "org_manager",
    scope_type: "org",
    scope_id: ORG_A,
    ...overrides,
  } as UserDirectoryRow;
}

function rowOf(row: UserDirectoryRow) {
  // Locate the <tr> that contains this row's email — robust against
  // table-cell ordering changes.
  const cell = screen.getByText(row.email!);
  const tr = cell.closest("tr");
  if (!tr) throw new Error("row not found");
  return within(tr);
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Visibility ───────────────────────────────────────────────────────

describe("UsersPageClient — Resend visibility (super_admin)", () => {
  it("shows Resend on Invited rows and hides it on Active rows", () => {
    const rows = [
      makeRow({
        user_id: "aaaaaaaa-1111-4000-8000-000000000001",
        email: "invited@example.com",
        email_confirmed_at: null,
      }),
      makeRow({
        user_id: "bbbbbbbb-1111-4000-8000-000000000002",
        email: "active@example.com",
        email_confirmed_at: "2026-04-23T00:00:00Z",
      }),
    ];

    render(
      <UsersPageClient
        rows={rows}
        orgs={[{ id: ORG_A, name: "Org A" }]}
        callerRole="super_admin"
        callerOrgIds={[]}
        currentUserId={CALLER}
      />
    );

    expect(rowOf(rows[0]!).getByRole("button", { name: /^resend$/i })).toBeDefined();
    expect(
      rowOf(rows[1]!).queryByRole("button", { name: /^resend$/i })
    ).toBeNull();
  });
});

describe("UsersPageClient — Resend visibility (org_manager)", () => {
  it("shows Resend on org_manager rows in their org; hides on cross-org, super_admin, and orphan rows", () => {
    const rows = [
      // Org_manager in caller's org → SHOWN.
      makeRow({
        user_id: "aaaaaaaa-2222-4000-8000-000000000001",
        email: "ours@example.com",
        role: "org_manager",
        scope_type: "org",
        scope_id: ORG_A,
        email_confirmed_at: null,
      }),
      // Org_manager in a different org → HIDDEN.
      makeRow({
        user_id: "bbbbbbbb-2222-4000-8000-000000000002",
        email: "theirs@example.com",
        role: "org_manager",
        scope_type: "org",
        scope_id: ORG_B,
        email_confirmed_at: null,
      }),
      // Super_admin row → HIDDEN.
      makeRow({
        user_id: "cccccccc-2222-4000-8000-000000000003",
        email: "admin@example.com",
        role: "super_admin",
        scope_type: null,
        scope_id: null,
        email_confirmed_at: null,
      }),
      // Orphan (null role) → HIDDEN.
      makeRow({
        user_id: "dddddddd-2222-4000-8000-000000000004",
        email: "orphan@example.com",
        role: null,
        scope_type: null,
        scope_id: null,
        email_confirmed_at: null,
      }),
    ];

    render(
      <UsersPageClient
        rows={rows}
        orgs={[
          { id: ORG_A, name: "Org A" },
          { id: ORG_B, name: "Org B" },
        ]}
        callerRole="org_manager"
        callerOrgIds={[ORG_A]}
        currentUserId={CALLER}
      />
    );

    expect(rowOf(rows[0]!).getByRole("button", { name: /^resend$/i })).toBeDefined();
    expect(
      rowOf(rows[1]!).queryByRole("button", { name: /^resend$/i })
    ).toBeNull();
    expect(
      rowOf(rows[2]!).queryByRole("button", { name: /^resend$/i })
    ).toBeNull();
    expect(
      rowOf(rows[3]!).queryByRole("button", { name: /^resend$/i })
    ).toBeNull();
  });
});

// ── Per-row in-flight state isolation ────────────────────────────────

describe("UsersPageClient — per-row in-flight state isolation", () => {
  it("Sending… state on row A does not bleed into row B (sequential clicks)", async () => {
    // First fetch resolves on demand so we can observe row A in-flight.
    let resolveFirst: (v: Response) => void = () => {};
    const firstPromise = new Promise<Response>((r) => {
      resolveFirst = r;
    });
    let resolveSecond: (v: Response) => void = () => {};
    const secondPromise = new Promise<Response>((r) => {
      resolveSecond = r;
    });

    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockImplementationOnce(() => firstPromise)
      .mockImplementationOnce(() => secondPromise);

    const rows = [
      makeRow({
        user_id: "aaaaaaaa-3333-4000-8000-000000000001",
        email: "a@example.com",
      }),
      makeRow({
        user_id: "bbbbbbbb-3333-4000-8000-000000000002",
        email: "b@example.com",
      }),
    ];

    render(
      <UsersPageClient
        rows={rows}
        orgs={[{ id: ORG_A, name: "Org A" }]}
        callerRole="super_admin"
        callerOrgIds={[]}
        currentUserId={CALLER}
      />
    );

    // Click row A → A shows "Sending…", B remains "Resend".
    fireEvent.click(rowOf(rows[0]!).getByRole("button", { name: /^resend$/i }));

    await waitFor(() => {
      expect(rowOf(rows[0]!).getByText(/sending/i)).toBeDefined();
    });
    expect(rowOf(rows[1]!).getByRole("button", { name: /^resend$/i })).toBeDefined();

    // Resolve A first so its in-flight clears, then click B.
    resolveFirst(
      new Response(JSON.stringify({ resent: true }), { status: 200 })
    );

    await waitFor(() => {
      expect(rowOf(rows[0]!).getByRole("button", { name: /^resend$/i })).toBeDefined();
    });

    fireEvent.click(rowOf(rows[1]!).getByRole("button", { name: /^resend$/i }));

    await waitFor(() => {
      expect(rowOf(rows[1]!).getByText(/sending/i)).toBeDefined();
    });
    // A should be back to "Resend" (not stuck on "Sending…").
    expect(rowOf(rows[0]!).getByRole("button", { name: /^resend$/i })).toBeDefined();

    resolveSecond(
      new Response(JSON.stringify({ resent: true }), { status: 200 })
    );

    await waitFor(() => {
      expect(rowOf(rows[1]!).getByRole("button", { name: /^resend$/i })).toBeDefined();
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

// ── Banner discriminated union — tone per kind ───────────────────────

describe("UsersPageClient — banner tone per feedback kind", () => {
  it("renders 'Invitation resent' (success tone) on 200 from row click", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ resent: true }), { status: 200 })
    );

    const rows = [
      makeRow({
        user_id: "aaaaaaaa-4444-4000-8000-000000000001",
        email: "row@example.com",
      }),
    ];

    render(
      <UsersPageClient
        rows={rows}
        orgs={[{ id: ORG_A, name: "Org A" }]}
        callerRole="super_admin"
        callerOrgIds={[]}
        currentUserId={CALLER}
      />
    );

    fireEvent.click(rowOf(rows[0]!).getByRole("button", { name: /^resend$/i }));

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: /invitation resent/i })
      ).toBeDefined();
    });
    // The email appears once in the row cell and once in the banner body.
    expect(screen.getAllByText(/row@example.com/).length).toBeGreaterThanOrEqual(2);
  });

  it("renders the rate-limit banner on 429", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ error: "rate", code: "rate_limited" }),
        { status: 429 }
      )
    );

    const rows = [
      makeRow({
        user_id: "aaaaaaaa-5555-4000-8000-000000000001",
        email: "rl@example.com",
      }),
    ];

    render(
      <UsersPageClient
        rows={rows}
        orgs={[{ id: ORG_A, name: "Org A" }]}
        callerRole="super_admin"
        callerOrgIds={[]}
        currentUserId={CALLER}
      />
    );

    fireEvent.click(rowOf(rows[0]!).getByRole("button", { name: /^resend$/i }));

    await waitFor(() => {
      expect(screen.getByText(/rate limited/i)).toBeDefined();
    });
    expect(screen.getByText(/try again in a few minutes/i)).toBeDefined();
  });

  it("renders the destructive error banner on a 422 with custom message", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "Resend failed: boom" }), {
        status: 422,
      })
    );

    const rows = [
      makeRow({
        user_id: "aaaaaaaa-6666-4000-8000-000000000001",
        email: "err@example.com",
      }),
    ];

    render(
      <UsersPageClient
        rows={rows}
        orgs={[{ id: ORG_A, name: "Org A" }]}
        callerRole="super_admin"
        callerOrgIds={[]}
        currentUserId={CALLER}
      />
    );

    fireEvent.click(rowOf(rows[0]!).getByRole("button", { name: /^resend$/i }));

    await waitFor(() => {
      expect(screen.getByText(/could not resend invitation/i)).toBeDefined();
    });
    expect(screen.getByText(/resend failed: boom/i)).toBeDefined();
  });
});
