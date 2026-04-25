// @vitest-environment jsdom
/**
 * HouseholdTable tests.
 *
 * EmptyState (#139 P5):
 *   (a) EmptyState renders with correct eyebrow + title + body when households empty
 *   (b) CTA visible when canManage=true + onAdd provided; hidden when canManage=false
 *   (c) Footnote visible in role-locked state (canManage=false)
 *   (d) Non-empty rendering is unchanged (CSS regression check)
 *   (e) border-0 override classes present (no cards-in-cards nesting)
 *
 * Edge disambiguation (#144):
 *   (f) Multi-edge: <optgroup> per edge + edge name in every option label
 *   (g) Single-edge: edge name STILL shown in option label (Variant B always)
 *   (h) Already-linked option: disabled + "(linked: HouseholdName)" suffix
 *   (i) Own assignment not disabled, no "(linked:)" suffix
 *   (j) Sort order: alphabetical by edge → available before linked within group
 *   (k) "Unassigned" is first option, outside any optgroup
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { Device, Household } from "@/lib/types/domain";
import type { BillingDeviceOption } from "../HouseholdTable";

// Mock next/navigation
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/",
}));

// Mock next/link
vi.mock("next/link", () => ({
  default: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => (
    <a href={href} className={className}>{children}</a>
  ),
}));

// Mock Supabase client
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: () => ({
      delete: () => ({
        eq: () => ({ eq: () => Promise.resolve({ error: null }) }),
      }),
      update: () => ({
        eq: () => Promise.resolve({ error: null }),
      }),
      insert: () => Promise.resolve({ error: null }),
    }),
  }),
}));

import { HouseholdTable } from "../HouseholdTable";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MICROGRID_ID = "mg-test-1";

const HOUSEHOLD: Household = {
  id: "hh-1",
  microgrid_id: MICROGRID_ID,
  display_name: "Household Alpha",
  primary_phone: null,
  primary_email: null,
  address_line1: null,
  address_line2: null,
  unit_label: null,
  created_at: "2026-01-01T00:00:00Z",
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

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("HouseholdTable — EmptyState (#139 P5)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("(a) renders EmptyState with correct title, body when households empty", () => {
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
    // title
    expect(screen.getByText("Add the first household")).toBeTruthy();
    // body
    expect(screen.getByText(/Households are the customers on this microgrid/)).toBeTruthy();
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
    // The EmptyState CTA is inside role="region"; find it there
    const region = container.querySelector("[role='region']");
    const cta = region?.querySelector("button");
    expect(cta).not.toBeNull();
    expect(cta?.textContent).toContain("Add household");
    fireEvent.click(cta!);
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it("(b) EmptyState has no button inside region when canManage=false", () => {
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

  it("(e) EmptyState rendered with border-0 override (no cards-in-cards)", () => {
    const { container } = render(
      <HouseholdTable
        microgridId={MICROGRID_ID}
        households={[]}
        devices={[]}
        primaryDeviceAssignments={{}}
        canManage={true}
        onAdd={() => {}}
      />
    );
    const region = container.querySelector("[role='region']");
    expect(region?.className).toContain("border-0");
    expect(region?.className).toContain("shadow-none");
    expect(region?.className).toContain("p-0");
  });
});

// ─── Edge disambiguation fixtures (#144) ─────────────────────────────────────

const HH_ALPHA: Household = {
  id: "hh-a",
  microgrid_id: MICROGRID_ID,
  display_name: "Household Alpha",
  primary_phone: null,
  primary_email: null,
  address_line1: null,
  address_line2: null,
  unit_label: null,
  created_at: "2026-01-01T00:00:00Z",
} as Household;

const HH_BETA: Household = {
  id: "hh-b",
  microgrid_id: MICROGRID_ID,
  display_name: "Household Beta",
  primary_phone: null,
  primary_email: null,
  address_line1: null,
  address_line2: null,
  unit_label: null,
  created_at: "2026-01-01T00:00:00Z",
} as Household;

/** Two edges, each with a "Consumption" device (same name, different edge). */
const BILLING_DEVICES_MULTI_EDGE: BillingDeviceOption[] = [
  {
    id: "dev-e1-c",
    name: "Consumption",
    device_type: "other",
    edge_id: "edge-1",
    edge_name: "Alpha Edge",
  },
  {
    id: "dev-e1-g",
    name: "Grid",
    device_type: "grid_meter",
    edge_id: "edge-1",
    edge_name: "Alpha Edge",
  },
  {
    id: "dev-e2-c",
    name: "Consumption",
    device_type: "other",
    edge_id: "edge-2",
    edge_name: "Beta Edge",
  },
  {
    id: "dev-e2-pv",
    name: "PV East",
    device_type: "pv_meter",
    edge_id: "edge-2",
    edge_name: "Beta Edge",
  },
];

/** Single edge variant — same billing-device list but all on one edge. */
const BILLING_DEVICES_SINGLE_EDGE: BillingDeviceOption[] = [
  {
    id: "dev-s1",
    name: "Consumption",
    device_type: "other",
    edge_id: "edge-1",
    edge_name: "Alpha Edge",
  },
  {
    id: "dev-s2",
    name: "Grid",
    device_type: "grid_meter",
    edge_id: "edge-1",
    edge_name: "Alpha Edge",
  },
];

/** Billing devices where dev-e1-c is already linked to Household Alpha. */
const BILLING_DEVICES_WITH_LINKED: BillingDeviceOption[] = [
  {
    id: "dev-e1-c",
    name: "Consumption",
    device_type: "other",
    edge_id: "edge-1",
    edge_name: "Alpha Edge",
    linkedToHouseholdName: "Household Alpha",
  },
  {
    id: "dev-e2-c",
    name: "Consumption",
    device_type: "other",
    edge_id: "edge-2",
    edge_name: "Beta Edge",
  },
];

/** Helpers: find the select inside a given household row. */
function getSelectForHousehold(container: HTMLElement, householdName: string): HTMLSelectElement {
  // Find the row cell with the household name, then walk up to the row
  const allRows = container.querySelectorAll("tbody tr");
  for (const row of Array.from(allRows)) {
    if (row.textContent?.includes(householdName)) {
      const sel = row.querySelector("select");
      if (sel) return sel as HTMLSelectElement;
    }
  }
  throw new Error(`No <select> found in row for "${householdName}"`);
}

// ─── Edge disambiguation tests (#144) ────────────────────────────────────────

describe("HouseholdTable — edge disambiguation (#144)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("(f) multi-edge: renders one <optgroup> per edge, each option label includes edge name", () => {
    const { container } = render(
      <HouseholdTable
        microgridId={MICROGRID_ID}
        households={[HH_ALPHA]}
        devices={[DEVICE]}
        billingDevices={BILLING_DEVICES_MULTI_EDGE}
        primaryDeviceAssignments={{}}
        canManage={true}
      />
    );
    const sel = getSelectForHousehold(container, "Household Alpha");
    const optgroups = sel.querySelectorAll("optgroup");
    // Two edges → two optgroups
    expect(optgroups).toHaveLength(2);
    expect(optgroups[0].label).toBe("Alpha Edge");
    expect(optgroups[1].label).toBe("Beta Edge");

    // Every option text includes the edge name
    const allOptions = Array.from(sel.querySelectorAll("option")).filter(
      (o) => o.value !== ""
    );
    for (const opt of allOptions) {
      // Label format: "[type] name · edge_name"
      expect(opt.textContent).toMatch(/·\s*(Alpha Edge|Beta Edge)/);
    }
  });

  it("(g) single-edge: edge name STILL shown in option label (Variant B always)", () => {
    const { container } = render(
      <HouseholdTable
        microgridId={MICROGRID_ID}
        households={[HH_ALPHA]}
        devices={[DEVICE]}
        billingDevices={BILLING_DEVICES_SINGLE_EDGE}
        primaryDeviceAssignments={{}}
        canManage={true}
      />
    );
    const sel = getSelectForHousehold(container, "Household Alpha");
    const optgroups = sel.querySelectorAll("optgroup");
    // One edge → one optgroup
    expect(optgroups).toHaveLength(1);
    expect(optgroups[0].label).toBe("Alpha Edge");

    // Options still include edge name
    const allOptions = Array.from(sel.querySelectorAll("option")).filter(
      (o) => o.value !== ""
    );
    for (const opt of allOptions) {
      expect(opt.textContent).toContain("Alpha Edge");
    }
  });

  it("(h) already-linked option in another row is disabled with linked-household suffix", () => {
    // HH_ALPHA has dev-e1-c; HH_BETA's dropdown should show it as disabled
    const { container } = render(
      <HouseholdTable
        microgridId={MICROGRID_ID}
        households={[HH_ALPHA, HH_BETA]}
        devices={[DEVICE]}
        billingDevices={BILLING_DEVICES_WITH_LINKED}
        // dev-e1-c is assigned to hh-a
        primaryDeviceAssignments={{ "hh-a": "dev-e1-c" }}
        canManage={true}
      />
    );
    // In HH_BETA's select, dev-e1-c should be disabled with the linked suffix
    const selBeta = getSelectForHousehold(container, "Household Beta");
    const linkedOpt = selBeta.querySelector("option[value='dev-e1-c']") as HTMLOptionElement | null;
    expect(linkedOpt).not.toBeNull();
    expect(linkedOpt!.disabled).toBe(true);
    expect(linkedOpt!.textContent).toContain("(linked: Household Alpha)");
  });

  it("(i) own-assignment option is NOT disabled and has no linked suffix", () => {
    const { container } = render(
      <HouseholdTable
        microgridId={MICROGRID_ID}
        households={[HH_ALPHA]}
        devices={[DEVICE]}
        billingDevices={BILLING_DEVICES_WITH_LINKED}
        // dev-e1-c is assigned to hh-a (this row)
        primaryDeviceAssignments={{ "hh-a": "dev-e1-c" }}
        canManage={true}
      />
    );
    const selAlpha = getSelectForHousehold(container, "Household Alpha");
    const ownOpt = selAlpha.querySelector("option[value='dev-e1-c']") as HTMLOptionElement | null;
    expect(ownOpt).not.toBeNull();
    expect(ownOpt!.disabled).toBe(false);
    expect(ownOpt!.textContent).not.toContain("linked:");
  });

  it("(j) sort order: alphabetical by edge group; available before linked within group", () => {
    const billingDevicesForSort: BillingDeviceOption[] = [
      // Zed Edge — linked device (should appear last within group)
      {
        id: "dev-z-linked",
        name: "Alpha Device",
        device_type: "other",
        edge_id: "edge-z",
        edge_name: "Zed Edge",
        linkedToHouseholdName: "Someone",
      },
      // Zed Edge — available (should appear first within group)
      {
        id: "dev-z-free",
        name: "Beta Device",
        device_type: "other",
        edge_id: "edge-z",
        edge_name: "Zed Edge",
      },
      // Alpha Edge — should be the first optgroup
      {
        id: "dev-a-free",
        name: "Meter",
        device_type: "other",
        edge_id: "edge-a",
        edge_name: "Alpha Edge",
      },
    ];

    const { container } = render(
      <HouseholdTable
        microgridId={MICROGRID_ID}
        households={[HH_ALPHA]}
        devices={[DEVICE]}
        billingDevices={billingDevicesForSort}
        primaryDeviceAssignments={{}}
        canManage={true}
      />
    );
    const sel = getSelectForHousehold(container, "Household Alpha");
    const optgroups = Array.from(sel.querySelectorAll("optgroup"));
    // Groups sorted alphabetically
    expect(optgroups[0].label).toBe("Alpha Edge");
    expect(optgroups[1].label).toBe("Zed Edge");

    // Within Zed Edge: free device before linked device
    const zedOptions = Array.from(optgroups[1].querySelectorAll("option"));
    expect(zedOptions[0].value).toBe("dev-z-free"); // available first
    expect(zedOptions[1].value).toBe("dev-z-linked"); // linked last
  });

  it("(k) Unassigned option is first and outside any optgroup", () => {
    const { container } = render(
      <HouseholdTable
        microgridId={MICROGRID_ID}
        households={[HH_ALPHA]}
        devices={[DEVICE]}
        billingDevices={BILLING_DEVICES_MULTI_EDGE}
        primaryDeviceAssignments={{}}
        canManage={true}
      />
    );
    const sel = getSelectForHousehold(container, "Household Alpha");
    // First child of the select should be the "Unassigned" option (not optgroup)
    const firstChild = sel.firstElementChild;
    expect(firstChild?.tagName.toLowerCase()).toBe("option");
    expect((firstChild as HTMLOptionElement).value).toBe("");
    expect(firstChild?.textContent).toBe("Unassigned");
  });
});
