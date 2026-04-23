// @vitest-environment jsdom
/**
 * InviteUserDialog component tests (UX5 / #79).
 *
 * Covers:
 *   - Super admin render: role select appears AND org select appears
 *     when org_manager is selected.
 *   - Org manager render: no role select, no org select (both locked).
 *   - POST payload shape for each caller role.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { InviteUserDialog } from "../InviteUserDialog";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

const ORG_A = "aaaaaaaa-aaaa-4000-8000-000000000001";
const ORG_B = "bbbbbbbb-bbbb-4000-8000-000000000001";

function orgList() {
  return [
    { id: ORG_A, name: "Org A" },
    { id: ORG_B, name: "Org B" },
  ];
}

describe("InviteUserDialog — super_admin", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders a role select (super_admin | org_manager)", () => {
    render(
      <InviteUserDialog
        open
        onOpenChange={() => {}}
        callerRole="super_admin"
        orgs={orgList()}
        callerOrgIds={[]}
      />
    );

    // The Role label is only rendered for super_admin.
    expect(screen.getByText("Role")).toBeDefined();
    // Radix Select renders a trigger with its current value as text.
    // The default role is org_manager, so the org select should ALSO appear.
    expect(screen.getByLabelText(/organization/i)).toBeDefined();
  });

  it("submits { role: 'org_manager', scope_id } when org_manager selected", async () => {
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ user_id: "u1" }), { status: 201 })
      );

    const onSuccess = vi.fn();
    render(
      <InviteUserDialog
        open
        onOpenChange={() => {}}
        callerRole="super_admin"
        orgs={orgList()}
        callerOrgIds={[]}
        onSuccess={onSuccess}
      />
    );

    fireEvent.change(screen.getByLabelText(/email/i), {
      target: { value: "new@example.com" },
    });

    fireEvent.submit(screen.getByRole("button", { name: /send invitation/i }));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("/api/users/invite");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.email).toBe("new@example.com");
    expect(body.role).toBe("org_manager");
    expect(body.scope_id).toBe(ORG_A); // first org
  });
});

describe("InviteUserDialog — org_manager", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("does NOT render the role select", () => {
    render(
      <InviteUserDialog
        open
        onOpenChange={() => {}}
        callerRole="org_manager"
        orgs={orgList()}
        callerOrgIds={[ORG_A]}
      />
    );
    // No "Role" label appears.
    expect(screen.queryByText("Role")).toBeNull();
    // No organization select either.
    expect(screen.queryByLabelText(/organization/i)).toBeNull();
  });

  it("submits { role: 'org_manager', scope_id: callerOrgIds[0] }", async () => {
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ user_id: "u2" }), { status: 201 })
      );

    render(
      <InviteUserDialog
        open
        onOpenChange={() => {}}
        callerRole="org_manager"
        orgs={orgList()}
        callerOrgIds={[ORG_A]}
      />
    );

    fireEvent.change(screen.getByLabelText(/email/i), {
      target: { value: "alice@nfe.local" },
    });

    fireEvent.submit(screen.getByRole("button", { name: /send invitation/i }));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    const [, init] = fetchSpy.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.role).toBe("org_manager");
    expect(body.scope_id).toBe(ORG_A);
  });
});

describe("InviteUserDialog — validation", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("blocks submit on invalid email (client-side)", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
      new Response("", { status: 201 })
    );

    render(
      <InviteUserDialog
        open
        onOpenChange={() => {}}
        callerRole="super_admin"
        orgs={orgList()}
        callerOrgIds={[]}
      />
    );

    fireEvent.change(screen.getByLabelText(/email/i), {
      target: { value: "not-an-email" },
    });

    fireEvent.submit(screen.getByRole("button", { name: /send invitation/i }));

    // No fetch call because client-side validation blocked the submit.
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
