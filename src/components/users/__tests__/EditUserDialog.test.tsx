// @vitest-environment jsdom
/**
 * EditUserDialog component tests (UX5 / #79; UX5b / #184).
 *
 * Covers:
 *   - Profile section always renders; email is read-only.
 *   - Role section is hidden when canChangeRole = false.
 *   - Revoke button is hidden when canRevoke = false.
 *   - Clicking Revoke opens the ConfirmDialog.
 *   - Resend invitation (UX5b):
 *       * Hidden when target.email_confirmed_at is non-null (Active).
 *       * Visible when target.email_confirmed_at is null (Invited).
 *       * Click POSTs to /api/users/[id]/resend-invite.
 *       * Success surfaces the success Banner.
 *       * 429 surfaces the rate-limit Banner.
 *       * Banner resets when the dialog re-opens.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { EditUserDialog } from "../EditUserDialog";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

const ORG_A = "aaaaaaaa-aaaa-4000-8000-000000000001";

function baseTarget(overrides: Partial<ReturnType<typeof rawTarget>> = {}) {
  return { ...rawTarget(), ...overrides };
}

function rawTarget() {
  return {
    user_id: "11111111-1111-4000-8000-000000000001",
    email: "alice@nfe.local",
    first_name: "Alice",
    last_name: "Smith",
    phone: "",
    role: "org_manager" as const,
    scope_id: ORG_A,
    email_confirmed_at: null as string | null,
  };
}

function orgList() {
  return [{ id: ORG_A, name: "Org A" }];
}

describe("EditUserDialog — render", () => {
  it("always renders the Profile section with a read-only email", () => {
    render(
      <EditUserDialog
        open
        onOpenChange={() => {}}
        target={baseTarget()}
        callerRole="super_admin"
        canChangeRole
        canRevoke
        orgs={orgList()}
      />
    );

    expect(screen.getByText("Profile")).toBeDefined();
    const emailInput = screen.getByLabelText(/^Email$/i) as HTMLInputElement;
    expect(emailInput.readOnly).toBe(true);
  });

  it("hides the Role section when canChangeRole is false", () => {
    render(
      <EditUserDialog
        open
        onOpenChange={() => {}}
        target={baseTarget()}
        callerRole="org_manager"
        canChangeRole={false}
        canRevoke
        orgs={orgList()}
      />
    );

    // The Role heading is hidden.
    expect(screen.queryByText(/^Role$/)).toBeNull();
  });

  it("shows the Role heading when canChangeRole is true", () => {
    render(
      <EditUserDialog
        open
        onOpenChange={() => {}}
        target={baseTarget()}
        callerRole="super_admin"
        canChangeRole
        canRevoke
        orgs={orgList()}
      />
    );

    // Two elements will contain "Role" (the section heading <h3> and the
    // <label>); we assert the section heading specifically.
    expect(screen.getByRole("heading", { name: /^Role$/ })).toBeDefined();
  });

  it("hides Revoke when canRevoke is false", () => {
    render(
      <EditUserDialog
        open
        onOpenChange={() => {}}
        target={baseTarget()}
        callerRole="super_admin"
        canChangeRole
        canRevoke={false}
        orgs={orgList()}
      />
    );

    expect(screen.queryByRole("button", { name: /revoke access/i })).toBeNull();
  });

  it("opens the confirm dialog when Revoke is clicked", () => {
    render(
      <EditUserDialog
        open
        onOpenChange={() => {}}
        target={baseTarget()}
        callerRole="super_admin"
        canChangeRole
        canRevoke
        orgs={orgList()}
      />
    );

    // Exactly one button is "Revoke access" — the trigger.
    const revokeBtn = screen.getByRole("button", { name: /^revoke access$/i });
    fireEvent.click(revokeBtn);

    // After clicking, the ConfirmDialog shows its destructive confirm button
    // with label "Revoke access" — two buttons with that accessible name now
    // exist. The confirm-dialog title "Revoke access?" is distinct.
    expect(screen.getByText(/revoke access\?/i)).toBeDefined();
  });
});

describe("EditUserDialog — resend invitation (UX5b / #184)", () => {
  it("hides Resend when the target is Active (email_confirmed_at non-null)", () => {
    render(
      <EditUserDialog
        open
        onOpenChange={() => {}}
        target={baseTarget({ email_confirmed_at: "2026-04-23T00:00:00Z" })}
        callerRole="super_admin"
        canChangeRole
        canRevoke
        orgs={orgList()}
      />
    );

    expect(
      screen.queryByRole("button", { name: /resend invitation/i })
    ).toBeNull();
  });

  it("shows Resend when the target is Invited (email_confirmed_at null)", () => {
    render(
      <EditUserDialog
        open
        onOpenChange={() => {}}
        target={baseTarget()}
        callerRole="super_admin"
        canChangeRole
        canRevoke
        orgs={orgList()}
      />
    );

    expect(
      screen.getByRole("button", { name: /resend invitation/i })
    ).toBeDefined();
  });

  it("POSTs to /api/users/[id]/resend-invite and surfaces success banner", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ resent: true }), { status: 200 })
    );

    render(
      <EditUserDialog
        open
        onOpenChange={() => {}}
        target={baseTarget()}
        callerRole="super_admin"
        canChangeRole
        canRevoke
        orgs={orgList()}
      />
    );

    const resendBtn = screen.getByRole("button", { name: /resend invitation/i });
    fireEvent.click(resendBtn);

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe(
      "/api/users/11111111-1111-4000-8000-000000000001/resend-invite"
    );
    expect((init as RequestInit).method).toBe("POST");

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: /invitation resent/i })
      ).toBeDefined();
    });
    expect(screen.getByText(/alice@nfe.local/)).toBeDefined();

    fetchSpy.mockRestore();
  });

  it("surfaces a rate-limit banner on 429", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ error: "rate", code: "rate_limited" }),
        { status: 429 }
      )
    );

    render(
      <EditUserDialog
        open
        onOpenChange={() => {}}
        target={baseTarget()}
        callerRole="super_admin"
        canChangeRole
        canRevoke
        orgs={orgList()}
      />
    );

    fireEvent.click(
      screen.getByRole("button", { name: /resend invitation/i })
    );

    await waitFor(() => {
      expect(screen.getByText(/rate limited/i)).toBeDefined();
    });
    expect(screen.getByText(/try again in a few minutes/i)).toBeDefined();

    fetchSpy.mockRestore();
  });

  it("surfaces a destructive banner on other errors (422)", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "Resend failed: boom" }), {
        status: 422,
      })
    );

    render(
      <EditUserDialog
        open
        onOpenChange={() => {}}
        target={baseTarget()}
        callerRole="super_admin"
        canChangeRole
        canRevoke
        orgs={orgList()}
      />
    );

    fireEvent.click(
      screen.getByRole("button", { name: /resend invitation/i })
    );

    await waitFor(() => {
      expect(screen.getByText(/could not resend invitation/i)).toBeDefined();
    });
    expect(screen.getByText(/resend failed: boom/i)).toBeDefined();

    fetchSpy.mockRestore();
  });

  it("clears any previous resend banner when the dialog re-opens", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ resent: true }), { status: 200 })
    );

    const { rerender } = render(
      <EditUserDialog
        open
        onOpenChange={() => {}}
        target={baseTarget()}
        callerRole="super_admin"
        canChangeRole
        canRevoke
        orgs={orgList()}
      />
    );

    fireEvent.click(
      screen.getByRole("button", { name: /resend invitation/i })
    );

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /invitation resent/i })
      ).toBeDefined()
    );

    // Close dialog.
    rerender(
      <EditUserDialog
        open={false}
        onOpenChange={() => {}}
        target={baseTarget()}
        callerRole="super_admin"
        canChangeRole
        canRevoke
        orgs={orgList()}
      />
    );

    // Re-open — banner should be gone.
    rerender(
      <EditUserDialog
        open
        onOpenChange={() => {}}
        target={baseTarget()}
        callerRole="super_admin"
        canChangeRole
        canRevoke
        orgs={orgList()}
      />
    );

    await waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: /invitation resent/i })
      ).toBeNull();
    });

    fetchSpy.mockRestore();
  });
});
