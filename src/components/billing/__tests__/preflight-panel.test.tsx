// PreflightPanel — component tests (jsdom environment) — BC3 #175 AC5

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { LocaleProvider } from "@/components/format/locale-context";
import { PreflightPanel } from "../preflight-panel";
import type { Household } from "@/lib/types/domain";

const refreshMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: refreshMock }),
}));

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

function makeHousehold(id: string, name: string): Household {
  return {
    id,
    microgrid_id: "mg-1",
    display_name: name,
    primary_phone: null,
    primary_email: null,
    address_line1: null,
    address_line2: null,
    unit_label: null,
    address_city: null,
    address_region: null,
    address_country: null,
    address_postal_code: null,
    geography_notes: null,
    created_at: "2026-01-01T00:00:00Z",
  } as unknown as Household;
}

function Wrap({ children }: { children: React.ReactNode }) {
  return (
    <LocaleProvider locale="en-UG" currency="UGX">
      {children}
    </LocaleProvider>
  );
}

describe("PreflightPanel — block-until-filled (Q1=A)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    refreshMock.mockClear();
  });

  it("Generate button disabled when needs-manual rows are empty; enables when filled", async () => {
    const households = [makeHousehold("h-1", "Alice")];
    const edgeMap = { "h-1": false }; // needs manual

    render(
      <Wrap>
        <PreflightPanel
          open
          onClose={vi.fn()}
          billingPeriodId="p-1"
          households={households}
          edgeAvailableByHouseholdId={edgeMap}
        />
      </Wrap>,
    );

    const btn = document.querySelector(
      '[data-testid="preflight-generate-button"]',
    ) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);

    const startInput = screen.getByLabelText(/Start kWh for Alice/i) as HTMLInputElement;
    const endInput = screen.getByLabelText(/End kWh for Alice/i) as HTMLInputElement;
    fireEvent.change(startInput, { target: { value: "100" } });
    fireEvent.change(endInput, { target: { value: "150" } });
    expect(btn.disabled).toBe(false);

    // Now flip end < start — button should disable again.
    fireEvent.change(endInput, { target: { value: "50" } });
    expect(btn.disabled).toBe(true);
  });
});

describe("PreflightPanel — submit body shape", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    refreshMock.mockClear();
  });

  it("POSTs manualReadings (needs-manual + override-toggled), no householdIds", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ lineItems: 2, errors: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const households = [
      makeHousehold("h-1", "Alice"), // needs manual
      makeHousehold("h-2", "Bob"), // edge, will be override-toggled
    ];
    const edgeMap = { "h-1": false, "h-2": true };

    const onClose = vi.fn();
    render(
      <Wrap>
        <PreflightPanel
          open
          onClose={onClose}
          billingPeriodId="p-1"
          households={households}
          edgeAvailableByHouseholdId={edgeMap}
        />
      </Wrap>,
    );

    // Fill Alice's manual fields.
    fireEvent.change(screen.getByLabelText(/Start kWh for Alice/i), {
      target: { value: "100" },
    });
    fireEvent.change(screen.getByLabelText(/End kWh for Alice/i), {
      target: { value: "150" },
    });

    // Expand the override section.
    const overrideToggle = document.querySelector(
      '[data-testid="preflight-override-section"] button',
    ) as HTMLButtonElement;
    fireEvent.click(overrideToggle);

    // Toggle Bob's override checkbox.
    const overrideCheckbox = screen.getByLabelText(
      /Use manual entry instead for Bob/i,
    );
    fireEvent.click(overrideCheckbox);

    // Now Bob's start/end inputs become required. There are now two End-kWh
    // inputs visible (Alice + Bob); pick by aria-label.
    fireEvent.change(screen.getByLabelText(/Start kWh for Bob/i), {
      target: { value: "200" },
    });
    fireEvent.change(screen.getByLabelText(/End kWh for Bob/i), {
      target: { value: "275" },
    });

    const submitBtn = document.querySelector(
      '[data-testid="preflight-generate-button"]',
    ) as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(false);

    await act(async () => {
      fireEvent.click(submitBtn);
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const call = fetchMock.mock.calls[0];
    expect(call[0]).toBe("/api/billing/generate");
    const body = JSON.parse(call[1].body as string);
    expect(body.billingPeriodId).toBe("p-1");
    expect(body.householdIds).toBeUndefined();
    expect(body.manualReadings).toEqual([
      { householdId: "h-1", startKwh: 100, endKwh: 150 },
      { householdId: "h-2", startKwh: 200, endKwh: 275 },
    ]);

    // Panel closes + refresh fires on 200.
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(refreshMock).toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});

describe("PreflightPanel — Generate button label", () => {
  it("reads 'Generate (N households)' regardless of trigger source", () => {
    const households = [makeHousehold("h-1", "Alice"), makeHousehold("h-2", "Bob")];
    const edgeMap = { "h-1": true, "h-2": true };
    render(
      <Wrap>
        <PreflightPanel
          open
          onClose={vi.fn()}
          billingPeriodId="p-1"
          households={households}
          edgeAvailableByHouseholdId={edgeMap}
        />
      </Wrap>,
    );
    const btn = document.querySelector(
      '[data-testid="preflight-generate-button"]',
    );
    expect(btn?.textContent).toContain("Generate (2 households)");
  });
});
