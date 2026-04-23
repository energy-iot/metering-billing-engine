// @vitest-environment jsdom
//
// EdgesCRUDShell — add-button gating tests (#103).
//
// AddEdgeDialog is mocked so we don't need to stub fetch. The shell renders
// the gating decision (button visible vs. null) based on emsType + isSuperAdmin.

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

// Sentinel: renders a marker span so we know when the dialog is open.
vi.mock("@/components/forms/AddEdgeDialog", () => ({
  AddEdgeDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="add-edge-dialog-open" /> : null,
}));

import { EdgesCRUDShell } from "../edges-crud-shell";

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("EdgesCRUDShell add-button gating", () => {
  it("(a) renders + Add edge when ems_type is set AND user is super_admin", () => {
    render(
      <EdgesCRUDShell
        mode="add-button"
        microgridId="mg-1"
        emsType="direct_url"
        isSuperAdmin={true}
      />,
    );
    expect(screen.getByRole("button", { name: /\+ Add edge/ })).toBeTruthy();
  });

  it("(b) renders nothing when ems_type IS NULL (even for super_admin)", () => {
    const { container } = render(
      <EdgesCRUDShell
        mode="add-button"
        microgridId="mg-1"
        emsType={null}
        isSuperAdmin={true}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("(c) renders nothing for non-super-admin (even when ems_type is set)", () => {
    const { container } = render(
      <EdgesCRUDShell
        mode="add-button"
        microgridId="mg-1"
        emsType="direct_url"
        isSuperAdmin={false}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("(d) clicking the button opens the AddEdgeDialog", () => {
    render(
      <EdgesCRUDShell
        mode="add-button"
        microgridId="mg-1"
        emsType="direct_url"
        isSuperAdmin={true}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /\+ Add edge/ }));
    expect(screen.getByTestId("add-edge-dialog-open")).toBeTruthy();
  });
});
