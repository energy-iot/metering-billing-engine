// @vitest-environment jsdom
/**
 * HouseholdTable EmptyState tests (#139 P5).
 *
 * Covers:
 *   (a) EmptyState renders with correct eyebrow + title + body when households empty
 *   (b) CTA visible when canManage=true + onAdd provided; hidden when canManage=false
 *   (c) Footnote visible in role-locked state (canManage=false)
 *   (d) Non-empty rendering is unchanged (CSS regression check)
 *   (e) border-0 override classes present (no cards-in-cards nesting)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { Device, Household } from "@/lib/types/domain";

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
