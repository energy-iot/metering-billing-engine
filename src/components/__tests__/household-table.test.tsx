// @vitest-environment jsdom
/**
 * HouseholdTable tests — post-#145 refactor.
 *
 * Coverage:
 *   EmptyState (#139 P5):
 *     (a) renders with eyebrow + title + body when households empty
 *     (b) CTA visible when canManage=true + onAdd provided; hidden otherwise
 *     (c) footnote in role-locked state
 *     (d) non-empty rendering still works
 *
 *   Refactor surfaces (#145):
 *     (e) NO inline create form
 *     (f) NO inline name/phone/email edit affordance
 *     (g) NO native <select> in any row (DeviceSelect is in the dialog only)
 *     (h) Click-to-edit chip: assigned → success tone, role=button, opens dialog
 *     (i) Click-to-edit chip: unassigned → warn tone, opens dialog
 *     (j) Kebab menu present per row when canManage
 *     (k) Kebab hidden when canManage=false (View link instead)
 *     (l) Address summary uses address_city · address_region · address_country (#146)
 */

import * as React from "react";
import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { Device, Household } from "@/lib/types/domain";
import type { BillingDeviceOption } from "../HouseholdTable";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/",
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: () => ({
      delete: () => ({
        eq: () => Promise.resolve({ error: null }),
      }),
    }),
  }),
}));

beforeAll(() => {
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  if (typeof Element.prototype.scrollIntoView !== "function") {
    Element.prototype.scrollIntoView = function () {};
  }
  if (typeof Element.prototype.hasPointerCapture !== "function") {
    Element.prototype.hasPointerCapture = (() => false) as Element["hasPointerCapture"];
  }
});

import { HouseholdTable } from "../HouseholdTable";

/**
 * Open a Radix DropdownMenu trigger in jsdom. Radix listens on
 * pointerdown + mousedown + click, so a plain fireEvent.click is not enough.
 * Pattern lifted from edge-row-actions.test.tsx.
 */
function openKebab(name: RegExp) {
  const trigger = screen.getByRole("button", { name });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  fireEvent.mouseDown(trigger);
  fireEvent.click(trigger);
}

// ─── Fixtures ────────────────────────────────────────────────────────────

const MICROGRID_ID = "mg-test-1";

const HOUSEHOLD: Household = {
  id: "hh-1",
  microgrid_id: MICROGRID_ID,
  display_name: "Household Alpha",
  primary_phone: "+256700000001",
  primary_email: null,
  address_line1: "Plot 14",
  address_line2: null,
  unit_label: "Unit 1",
  address_city: "Kampala",
  address_region: "Central",
  address_country: "Uganda",
  address_postal_code: null,
  geography_notes: null,
  created_at: "2026-01-01T00:00:00Z",
} as Household;

const HOUSEHOLD_BETA: Household = {
  id: "hh-2",
  microgrid_id: MICROGRID_ID,
  display_name: "Household Beta",
  primary_phone: "+256700000002",
  primary_email: "beta@example.com",
  address_line1: null,
  address_line2: null,
  unit_label: null,
  address_city: null,
  address_region: null,
  address_country: null,
  address_postal_code: null,
  geography_notes: null,
  created_at: "2026-01-02T00:00:00Z",
} as Household;

const DEVICE: Device = {
  id: "dev-1",
  edge_id: "edge-1",
  name: "Meter 1",
  device_type: "consumption_meter",
  openems_component_id: null,
  created_at: "2026-01-01T00:00:00Z",
  config: {},
} as Device;

const BILLING_DEVICES: BillingDeviceOption[] = [
  {
    id: "dev-1",
    name: "Meter 1",
    device_type: "consumption_meter",
    edge_id: "edge-1",
    edge_name: "Alpha Edge",
  },
  {
    id: "dev-2",
    name: "Meter 2",
    device_type: "consumption_meter",
    edge_id: "edge-1",
    edge_name: "Alpha Edge",
  },
];

// ─── EmptyState tests (#139 P5 — preserved) ──────────────────────────────

describe("HouseholdTable — EmptyState (#139 P5)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("(a) renders EmptyState with title and body when households empty", () => {
    render(
      <HouseholdTable
        microgridId={MICROGRID_ID}
        households={[]}
        devices={[]}
        primaryDeviceAssignments={{}}
        canManage={true}
        onAdd={() => {}}
      />
    );
    expect(screen.getByText("Add the first household")).toBeTruthy();
    expect(
      screen.getByText(/Households are the customers on this microgrid/)
    ).toBeTruthy();
  });

  it("(b) CTA '+ Add household' visible when canManage=true (EmptyState CTA)", () => {
    const onAdd = vi.fn();
    const { container } = render(
      <HouseholdTable
        microgridId={MICROGRID_ID}
        households={[]}
        devices={[]}
        primaryDeviceAssignments={{}}
        canManage={true}
        onAdd={onAdd}
      />
    );
    const region = container.querySelector("[role='region']");
    const cta = region?.querySelector("button");
    expect(cta).not.toBeNull();
    expect(cta?.textContent).toContain("Add household");
    fireEvent.click(cta!);
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it("(b) EmptyState has no button when canManage=false", () => {
    const { container } = render(
      <HouseholdTable
        microgridId={MICROGRID_ID}
        households={[]}
        devices={[]}
        primaryDeviceAssignments={{}}
        canManage={false}
      />
    );
    const region = container.querySelector("[role='region']");
    const ctaInRegion = region?.querySelector("button");
    expect(ctaInRegion).toBeNull();
  });

  it("(c) footnote visible in role-locked state (canManage=false)", () => {
    render(
      <HouseholdTable
        microgridId={MICROGRID_ID}
        households={[]}
        devices={[]}
        primaryDeviceAssignments={{}}
        canManage={false}
      />
    );
    expect(
      screen.getByText(/Ask a super admin to add households for this microgrid/)
    ).toBeTruthy();
  });

  it("(d) non-empty: renders household row without EmptyState", () => {
    render(
      <HouseholdTable
        microgridId={MICROGRID_ID}
        households={[HOUSEHOLD]}
        devices={[DEVICE]}
        primaryDeviceAssignments={{}}
        canManage={true}
        onAdd={() => {}}
      />
    );
    expect(screen.queryByText("Add the first household")).toBeNull();
    expect(screen.getByText("Household Alpha")).toBeTruthy();
  });
});

// ─── Refactor surfaces (#145) ─────────────────────────────────────────────

describe("HouseholdTable — refactor surfaces (#145)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("(e) renders NO inline create form (no Add Household button at the table top)", () => {
    render(
      <HouseholdTable
        microgridId={MICROGRID_ID}
        households={[HOUSEHOLD]}
        devices={[DEVICE]}
        billingDevices={BILLING_DEVICES}
        primaryDeviceAssignments={{}}
        canManage={true}
      />
    );
    // The header "Households" is present, but there should NOT be a button
    // titled "Add Household" rendered inside the table widget itself
    // (HouseholdsSection wraps it).
    expect(screen.queryByRole("button", { name: /Add Household/i })).toBeNull();
  });

  it("(f) renders NO inline edit affordance (no 'Save'/'Cancel' inline buttons)", () => {
    render(
      <HouseholdTable
        microgridId={MICROGRID_ID}
        households={[HOUSEHOLD]}
        devices={[DEVICE]}
        billingDevices={BILLING_DEVICES}
        primaryDeviceAssignments={{}}
        canManage={true}
      />
    );
    // The previous inline-edit had Save/Cancel buttons in the row.
    expect(screen.queryByRole("button", { name: /^Save$/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Cancel$/ })).toBeNull();
  });

  it("(g) renders NO native <select> in any row", () => {
    const { container } = render(
      <HouseholdTable
        microgridId={MICROGRID_ID}
        households={[HOUSEHOLD]}
        devices={[DEVICE]}
        billingDevices={BILLING_DEVICES}
        primaryDeviceAssignments={{}}
        canManage={true}
      />
    );
    const selects = container.querySelectorAll("tbody select");
    expect(selects.length).toBe(0);
  });

  it("(h) chip — assigned: success tone + button + opens dialog on click", async () => {
    const { container } = render(
      <HouseholdTable
        microgridId={MICROGRID_ID}
        households={[HOUSEHOLD]}
        devices={[DEVICE]}
        billingDevices={BILLING_DEVICES}
        primaryDeviceAssignments={{ "hh-1": "dev-1" }}
        canManage={true}
      />
    );
    // Find the chip-button by its aria-label
    const chipBtn = screen.getByRole("button", {
      name: /Change billing device for Household Alpha/i,
    });
    expect(chipBtn).toBeTruthy();
    // Inner Chip span carries success tokens
    const chipSpan = chipBtn.querySelector("span");
    expect(chipSpan?.className).toContain("bg-success-muted");
    expect(chipSpan?.className).toContain("text-success-fg");

    // Clicking opens the dialog
    fireEvent.click(chipBtn);
    await waitFor(() => {
      expect(screen.getByText(/Edit household/i)).toBeTruthy();
    });

    // Suppress unused-var lint
    void container;
  });

  it("(i) chip — unassigned: warn tone + button + opens dialog on click", async () => {
    render(
      <HouseholdTable
        microgridId={MICROGRID_ID}
        households={[HOUSEHOLD_BETA]}
        devices={[DEVICE]}
        billingDevices={BILLING_DEVICES}
        primaryDeviceAssignments={{}}
        canManage={true}
      />
    );
    const chipBtn = screen.getByRole("button", {
      name: /Link a billing device for Household Beta/i,
    });
    expect(chipBtn).toBeTruthy();
    const chipSpan = chipBtn.querySelector("span");
    expect(chipSpan?.className).toContain("bg-warning-muted");
    expect(chipSpan?.className).toContain("text-warning-fg");
    expect(chipSpan?.textContent).toContain("Unassigned");

    fireEvent.click(chipBtn);
    await waitFor(() => {
      expect(screen.getByText(/Edit household/i)).toBeTruthy();
    });
  });

  it("(j) kebab menu present per row when canManage", () => {
    render(
      <HouseholdTable
        microgridId={MICROGRID_ID}
        households={[HOUSEHOLD, HOUSEHOLD_BETA]}
        devices={[DEVICE]}
        billingDevices={BILLING_DEVICES}
        primaryDeviceAssignments={{}}
        canManage={true}
      />
    );
    expect(
      screen.getByRole("button", { name: /Actions for Household Alpha/i })
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Actions for Household Beta/i })
    ).toBeTruthy();
  });

  it("(j) kebab menu items: Edit, Change/Link device, View detail, Delete", async () => {
    render(
      <HouseholdTable
        microgridId={MICROGRID_ID}
        households={[HOUSEHOLD]}
        devices={[DEVICE]}
        billingDevices={BILLING_DEVICES}
        primaryDeviceAssignments={{ "hh-1": "dev-1" }}
        canManage={true}
      />
    );
    openKebab(/Actions for Household Alpha/i);

    await waitFor(() => {
      const menu = screen.getByRole("menu");
      expect(menu.textContent).toContain("Edit household");
    });
    const menu = screen.getByRole("menu");
    expect(menu.textContent).toContain("Change billing device");
    expect(menu.textContent).toContain("View detail");
    expect(menu.textContent).toContain("Delete household");
  });

  it("(j) kebab 'Link device' label when no device assigned", async () => {
    render(
      <HouseholdTable
        microgridId={MICROGRID_ID}
        households={[HOUSEHOLD_BETA]}
        devices={[DEVICE]}
        billingDevices={BILLING_DEVICES}
        primaryDeviceAssignments={{}}
        canManage={true}
      />
    );
    openKebab(/Actions for Household Beta/i);

    await waitFor(() => {
      const menu = screen.getByRole("menu");
      expect(menu.textContent).toContain("Link device");
    });
    const menu = screen.getByRole("menu");
    expect(menu.textContent).not.toContain("Change billing device");
  });

  it("(k) kebab hidden when canManage=false; View link rendered instead", () => {
    render(
      <HouseholdTable
        microgridId={MICROGRID_ID}
        households={[HOUSEHOLD]}
        devices={[DEVICE]}
        billingDevices={BILLING_DEVICES}
        primaryDeviceAssignments={{ "hh-1": "dev-1" }}
        canManage={false}
      />
    );
    expect(
      screen.queryByRole("button", { name: /Actions for Household Alpha/i })
    ).toBeNull();
    // Plain "View" link is rendered
    expect(screen.getByRole("link", { name: /^View$/i })).toBeTruthy();
  });

  it("(k) chip is non-interactive when canManage=false (no button)", () => {
    render(
      <HouseholdTable
        microgridId={MICROGRID_ID}
        households={[HOUSEHOLD]}
        devices={[DEVICE]}
        billingDevices={BILLING_DEVICES}
        primaryDeviceAssignments={{ "hh-1": "dev-1" }}
        canManage={false}
      />
    );
    expect(
      screen.queryByRole("button", {
        name: /Change billing device for Household Alpha/i,
      })
    ).toBeNull();
  });

  it("(l) address summary uses address_city · address_region · address_country (#146)", () => {
    render(
      <HouseholdTable
        microgridId={MICROGRID_ID}
        households={[HOUSEHOLD]}
        devices={[DEVICE]}
        billingDevices={BILLING_DEVICES}
        primaryDeviceAssignments={{}}
        canManage={true}
      />
    );
    // HOUSEHOLD has address_city="Kampala", address_region="Central", address_country="Uganda"
    expect(screen.getByText(/Kampala · Central · Uganda/)).toBeTruthy();
  });

  it("(l) address summary renders '—' when blank", () => {
    render(
      <HouseholdTable
        microgridId={MICROGRID_ID}
        households={[HOUSEHOLD_BETA]}
        devices={[DEVICE]}
        billingDevices={BILLING_DEVICES}
        primaryDeviceAssignments={{}}
        canManage={true}
      />
    );
    // HOUSEHOLD_BETA has no address — should show em-dash
    const dashCells = screen.getAllByText(/—/);
    expect(dashCells.length).toBeGreaterThan(0);
  });
});
