// @vitest-environment jsdom
/**
 * EdgeRowActions component tests (#100).
 *
 * Strategy:
 *   - Mock next/navigation (useRouter) and next/link per sidebar-nav-links pattern.
 *   - Mock DeleteEntityButton to a sentinel div — avoids firing the real
 *     delete-preview network request.
 *   - Mock EdgeFormModal so tests don't pull in the full form tree.
 *   - Open the DropdownMenu using the correct Radix pointer-event sequence
 *     (pointerdown + click) then assert menu item presence.
 *
 * Cases:
 *   (a) canManage=true → both "Configure…" and "Delete edge" items present after open.
 *   (b) canManage=false → "Configure…" present, "Delete edge" absent.
 *   (c) Clicking "Configure…" makes EdgeFormModal open (configureOpen → true).
 *   (d) Clicking "Delete edge" calls the DeleteEntityButton stub click.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";

// ─── Module-level mocks ───────────────────────────────────────────────────────

const mockPush = vi.fn();
const mockRefresh = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, refresh: mockRefresh }),
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    [key: string]: unknown;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

// Sentinel: renders a visible button so we can assert presence and simulate clicks.
const mockDeleteEntityButtonClick = vi.fn();
vi.mock("@/components/forms/DeleteEntityButton", () => ({
  DeleteEntityButton: ({
    entity,
    id,
    name,
  }: {
    entity: string;
    id: string;
    name: string;
  }) => (
    <button
      data-testid="delete-entity-button"
      data-entity={entity}
      data-id={id}
      data-name={name}
      onClick={mockDeleteEntityButtonClick}
    >
      Delete Edge stub
    </button>
  ),
}));

vi.mock("@/components/forms/EdgeForm", () => ({
  EdgeFormModal: ({ open }: { open: boolean }) =>
    open ? <div data-testid="edge-form-modal">EdgeFormModal stub</div> : null,
}));

// ─── Import after mocks ───────────────────────────────────────────────────────

import { EdgeRowActions } from "../edge-row-actions";

// ─── Fixture ──────────────────────────────────────────────────────────────────

const testEdge = {
  id: "edge-abc",
  name: "Metering Pi",
  data_source_type: "openems" as const,
  openems_edge_id: "edge0",
  openems_backend_url: "http://openems",
  role: "metering",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Open the DropdownMenu by dispatching the pointer-event sequence Radix
 * requires in jsdom (pointerdown → mousedown → click on the trigger).
 */
function openMenu() {
  const trigger = screen.getByRole("button", { name: /edge actions/i });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  fireEvent.mouseDown(trigger);
  fireEvent.click(trigger);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

describe("EdgeRowActions", () => {
  // (a) canManage=true → both items present after opening menu
  it("(a) canManage=true: Configure… and Delete edge items are present", () => {
    render(
      <EdgeRowActions
        edge={testEdge}
        microgridId="mg-1"
        canManage={true}
      />
    );
    openMenu();

    const menu = screen.getByRole("menu");
    expect(within(menu).getByText(/configure/i)).toBeDefined();
    expect(within(menu).getByText(/delete edge/i)).toBeDefined();
  });

  // (b) canManage=false → only Configure… present, no Delete edge
  it("(b) canManage=false: Configure… present, Delete edge absent", () => {
    render(
      <EdgeRowActions
        edge={testEdge}
        microgridId="mg-1"
        canManage={false}
      />
    );
    openMenu();

    const menu = screen.getByRole("menu");
    expect(within(menu).getByText(/configure/i)).toBeDefined();
    expect(within(menu).queryByText(/delete edge/i)).toBeNull();
  });

  // (c) Clicking Configure… makes EdgeFormModal appear
  it("(c) Clicking Configure… opens the EdgeFormModal", () => {
    render(
      <EdgeRowActions
        edge={testEdge}
        microgridId="mg-1"
        canManage={true}
      />
    );
    openMenu();

    const menu = screen.getByRole("menu");
    const configureItem = within(menu).getByText(/configure/i);
    fireEvent.click(configureItem);

    expect(screen.getByTestId("edge-form-modal")).toBeDefined();
  });

  // (e) DeleteEntityButton wrapper is hidden (not keyboard-reachable via tab)
  it("(e) canManage=true: delete wrapper carries hidden attribute (no ghost tab stop)", () => {
    render(
      <EdgeRowActions edge={testEdge} microgridId="mg-1" canManage={true} />
    );
    const wrapper = screen.getByTestId("delete-entity-wrapper");
    expect(wrapper.hasAttribute("hidden")).toBe(true);
  });

  // (d) Clicking Delete edge triggers the DeleteEntityButton stub
  it("(d) Clicking Delete edge activates the DeleteEntityButton stub", () => {
    render(
      <EdgeRowActions
        edge={testEdge}
        microgridId="mg-1"
        canManage={true}
      />
    );
    openMenu();

    const menu = screen.getByRole("menu");
    const deleteItem = within(menu).getByText(/delete edge/i);
    fireEvent.click(deleteItem);

    // triggerDelete() queries the hidden wrapper's button and clicks it.
    // Verify the stub button received the correct props and was activated.
    const stub = screen.getByTestId("delete-entity-button");
    expect(stub.getAttribute("data-entity")).toBe("edge");
    expect(stub.getAttribute("data-id")).toBe("edge-abc");
    expect(stub.getAttribute("data-name")).toBe("Metering Pi");
    expect(mockDeleteEntityButtonClick).toHaveBeenCalledTimes(1);
  });
});
