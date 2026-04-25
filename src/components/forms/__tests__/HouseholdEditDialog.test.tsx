// @vitest-environment jsdom
/**
 * HouseholdEditDialog tests (#145 + #146).
 *
 * Coverage:
 *   (1) renders with current device assignment
 *   (2) renders Unassigned state when currentDeviceId is null
 *   (3) PATCH-diff sends only changed fields
 *   (4) clean-form save closes without PATCH (no-op exit)
 *   (5) cancel-when-dirty opens ConfirmDialog
 *   (6) at-least-one-contact validation blocks save and surfaces helper
 *   (7) display_name required (blank disables Save)
 *   (8) device_id change is included in PATCH diff
 *   (9)  #146 — 5 new address fields render in Address section
 *   (10) #146 — address fields included in PATCH diff
 *   (11) #146 — geography_notes renders as textarea
 */

import * as React from "react";
import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  beforeEach,
  afterEach,
} from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { Household } from "@/lib/types/domain";
import type { DeviceOption } from "@/components/ui/device-select";
import { HouseholdEditDialog } from "../HouseholdEditDialog";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
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
});

const HOUSEHOLD: Household = {
  id: "660e8400-e29b-41d4-a716-446655440111",
  microgrid_id: "660e8400-e29b-41d4-a716-446655440000",
  display_name: "Block A, Unit 1",
  primary_phone: "+256700000000",
  primary_email: null,
  address_line1: "Plot 14",
  address_line2: null,
  unit_label: null,
  address_city: null,
  address_region: null,
  address_country: null,
  address_postal_code: null,
  geography_notes: null,
  created_at: "2026-01-01T00:00:00Z",
} as Household;

const DEVICES: DeviceOption[] = [
  {
    id: "dev-1",
    name: "Meter A",
    device_type: "consumption_meter",
    edge_id: "edge-1",
    edge_name: "Alpha Edge",
  },
  {
    id: "dev-2",
    name: "Meter B",
    device_type: "consumption_meter",
    edge_id: "edge-1",
    edge_name: "Alpha Edge",
  },
];

function renderDialog(
  props: Partial<React.ComponentProps<typeof HouseholdEditDialog>> = {}
) {
  const onOpenChange = vi.fn();
  const defaults: React.ComponentProps<typeof HouseholdEditDialog> = {
    open: true,
    onOpenChange,
    household: HOUSEHOLD,
    availableDevices: DEVICES,
    currentDeviceId: null,
    edgesSetupHref: "/microgrids/mg-1/setup/edges",
  };
  return {
    onOpenChange,
    ...render(<HouseholdEditDialog {...defaults} {...props} />),
  };
}

describe("HouseholdEditDialog (#145)", () => {
  let fetchMock: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchMock = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("(1) renders with current device assignment", () => {
    renderDialog({ currentDeviceId: "dev-1" });
    // Trigger displays the current selection: chip + name + edge
    const triggers = screen.getAllByRole("combobox");
    expect(triggers[0].textContent).toContain("Meter A");
    expect(triggers[0].textContent).toContain("Alpha Edge");
  });

  it("(2) renders Unassigned state when currentDeviceId is null", () => {
    renderDialog({ currentDeviceId: null });
    const triggers = screen.getAllByRole("combobox");
    expect(triggers[0].textContent).toContain("Unassigned");
  });

  it("(3) PATCH-diff sends only changed fields", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ household: { id: HOUSEHOLD.id } }),
    } as Response);

    renderDialog({ currentDeviceId: "dev-1" });

    // Change ONLY display_name
    const dn = screen.getByLabelText(/Display name/i) as HTMLInputElement;
    fireEvent.change(dn, { target: { value: "Updated Name" } });

    fireEvent.click(screen.getByRole("button", { name: /Save changes/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`/api/households/${HOUSEHOLD.id}`);
    expect(init?.method).toBe("PATCH");

    const body = JSON.parse(init?.body as string);
    // Only display_name changed → only display_name in diff
    expect(body).toEqual({ display_name: "Updated Name" });
  });

  it("(4) save without changes is disabled (no PATCH)", () => {
    renderDialog({ currentDeviceId: "dev-1" });
    const saveBtn = screen.getByRole("button", { name: /Save changes/i });
    expect(saveBtn).toHaveProperty("disabled", true);
  });

  it("(5) cancel-when-dirty opens ConfirmDialog", async () => {
    renderDialog({ currentDeviceId: "dev-1" });

    const dn = screen.getByLabelText(/Display name/i) as HTMLInputElement;
    fireEvent.change(dn, { target: { value: "Edited" } });

    // Click the dialog's Cancel (footer)
    const cancelBtns = screen.getAllByRole("button", { name: /^Cancel$/ });
    fireEvent.click(cancelBtns[0]);

    await waitFor(() => {
      expect(screen.getByText(/Discard unsaved changes/i)).toBeTruthy();
    });
  });

  it("(6) at-least-one-contact rule disables save AND surfaces helper", () => {
    // Start with email=null (already), then clear phone
    renderDialog({ currentDeviceId: "dev-1" });

    const phone = screen.getByLabelText(/Primary phone/i) as HTMLInputElement;
    fireEvent.change(phone, { target: { value: "" } });

    // Helper text appears (color: destructive)
    expect(
      screen.getByText(/At least one contact method is required/i)
    ).toBeTruthy();

    const saveBtn = screen.getByRole("button", { name: /Save changes/i });
    expect(saveBtn).toHaveProperty("disabled", true);
  });

  it("(7) display_name required — blank disables save", () => {
    renderDialog({ currentDeviceId: "dev-1" });
    const dn = screen.getByLabelText(/Display name/i) as HTMLInputElement;
    fireEvent.change(dn, { target: { value: "   " } });

    const saveBtn = screen.getByRole("button", { name: /Save changes/i });
    expect(saveBtn).toHaveProperty("disabled", true);
  });

  it("(8) device_id change is included in PATCH diff", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ household: { id: HOUSEHOLD.id } }),
    } as Response);

    renderDialog({ currentDeviceId: "dev-1" });

    // Open the device picker and select Meter B
    const triggers = screen.getAllByRole("combobox");
    fireEvent.click(triggers[0]);

    const meterBOption = await waitFor(() =>
      screen
        .getAllByRole("option")
        .find((o) => o.textContent?.includes("Meter B"))
    );
    expect(meterBOption).toBeDefined();
    fireEvent.click(meterBOption!);

    fireEvent.click(screen.getByRole("button", { name: /Save changes/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init?.body as string);
    expect(body).toEqual({ device_id: "dev-2" });
  });

  // ── #146 new field tests ───────────────────────────────────────────────

  it("(9) #146 — 5 new address fields render in the Address section", () => {
    renderDialog();
    // All 5 new labels should appear in the address fieldset
    expect(screen.getByLabelText(/^City$/i)).toBeDefined();
    expect(screen.getByLabelText(/Region \/ state/i)).toBeDefined();
    expect(screen.getByLabelText(/^Country$/i)).toBeDefined();
    expect(screen.getByLabelText(/Postal code/i)).toBeDefined();
    expect(screen.getByLabelText(/Geography notes/i)).toBeDefined();
  });

  it("(10) #146 — address_city change is included in PATCH diff", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ household: { id: HOUSEHOLD.id } }),
    } as Response);

    renderDialog({ currentDeviceId: "dev-1" });

    const cityInput = screen.getByLabelText(/^City$/i) as HTMLInputElement;
    fireEvent.change(cityInput, { target: { value: "Kampala" } });

    fireEvent.click(screen.getByRole("button", { name: /Save changes/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init?.body as string);
    expect(body).toEqual({ address_city: "Kampala" });
  });

  it("(11) #146 — geography_notes renders as a textarea", () => {
    renderDialog();
    const textarea = screen.getByLabelText(/Geography notes/i);
    expect(textarea.tagName.toLowerCase()).toBe("textarea");
  });
});
