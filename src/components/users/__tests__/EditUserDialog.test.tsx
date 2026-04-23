// @vitest-environment jsdom
/**
 * EditUserDialog component tests (UX5 / #79).
 *
 * Covers:
 *   - Profile section always renders; email is read-only.
 *   - Role section is hidden when canChangeRole = false.
 *   - Revoke button is hidden when canRevoke = false.
 *   - Clicking Revoke opens the ConfirmDialog.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { EditUserDialog } from "../EditUserDialog";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

const ORG_A = "aaaaaaaa-aaaa-4000-8000-000000000001";

function baseTarget() {
  return {
    user_id: "11111111-1111-4000-8000-000000000001",
    email: "alice@nfe.local",
    first_name: "Alice",
    last_name: "Smith",
    phone: "",
    role: "org_manager" as const,
    scope_id: ORG_A,
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
